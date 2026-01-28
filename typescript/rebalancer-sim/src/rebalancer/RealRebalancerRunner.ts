import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { pino } from 'pino';

import {
  RebalancerConfig,
  RebalancerService,
  RebalancerStrategyOptions,
} from '@hyperlane-xyz/rebalancer';
import type { StrategyConfig } from '@hyperlane-xyz/rebalancer';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { SimulationRegistry } from './SimulationRegistry.js';
import type { IRebalancerRunner, RebalancerSimConfig } from './types.js';

// Track the currently running service and provider to ensure cleanup
let currentRunningService: RebalancerService | null = null;
let currentProvider: ethers.providers.JsonRpcProvider | null = null;
let currentMultiProvider: MultiProvider | null = null;

// Track signal handlers registered by RebalancerService for cleanup
let registeredSigintHandler: (() => void) | null = null;
let registeredSigtermHandler: (() => void) | null = null;

/**
 * Force stop any running service with a timeout
 */
async function forceStopCurrentService(): Promise<void> {
  if (currentRunningService) {
    const service = currentRunningService;
    currentRunningService = null;

    try {
      // Stop the service with a timeout
      await Promise.race([
        service.stop().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Ignore errors
    }
  }

  // Remove signal handlers that RebalancerService may have registered
  // These handlers are registered in RebalancerService.start() but not removed by stop()
  if (registeredSigintHandler) {
    process.removeListener('SIGINT', registeredSigintHandler);
    registeredSigintHandler = null;
  }
  if (registeredSigtermHandler) {
    process.removeListener('SIGTERM', registeredSigtermHandler);
    registeredSigtermHandler = null;
  }

  // Clean up provider connections
  if (currentProvider) {
    currentProvider.removeAllListeners();
    currentProvider = null;
  }

  if (currentMultiProvider) {
    // Remove any listeners that might be on the MultiProvider's internal providers
    try {
      for (const chain of currentMultiProvider.getKnownChainNames()) {
        const provider = currentMultiProvider.tryGetProvider(chain);
        if (provider) {
          provider.removeAllListeners();
        }
      }
    } catch {
      // Ignore cleanup errors
    }
    currentMultiProvider = null;
  }

  // Force garbage collection if available (Node.js with --expose-gc)
  if (global.gc) {
    global.gc();
  }
}

/**
 * Global cleanup function - call between test runs to ensure clean state
 */
export async function cleanupRealRebalancer(): Promise<void> {
  await forceStopCurrentService();
  // Small delay to allow any async cleanup to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * RealRebalancerRunner wraps the actual @hyperlane-xyz/rebalancer RebalancerService
 * to run in the simulation environment.
 */
export class RealRebalancerRunner
  extends EventEmitter
  implements IRebalancerRunner
{
  readonly name = 'RealRebalancerService';

  private service?: RebalancerService;
  private registry?: SimulationRegistry;
  private multiProvider?: MultiProvider;
  private running = false;
  // Suppress all logs from rebalancer service during simulation
  private logger = pino({ level: 'silent' });

  async initialize(config: RebalancerSimConfig): Promise<void> {
    // Force stop any previously running service
    await forceStopCurrentService();

    // Create simulation registry with chain metadata and warp config
    this.registry = new SimulationRegistry(config.deployment);

    // Build chain metadata for MultiProvider
    // NOTE: chainId must be 31337 (anvil's actual chainId), not the domainId
    // The domainId is used for Hyperlane routing, but chainId is for EIP-155 transaction signing
    const chainMetadata: Record<string, any> = {};
    for (const [chainName, domain] of Object.entries(
      config.deployment.domains,
    )) {
      chainMetadata[chainName] = {
        name: chainName,
        chainId: 31337, // Anvil's actual chainId
        domainId: domain.domainId,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: config.deployment.anvilRpc }],
        nativeToken: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        blocks: {
          confirmations: 1,
          estimateBlockTime: 1,
        },
      };
    }

    // Create MultiProvider with signer and silent logger
    this.multiProvider = new MultiProvider(chainMetadata, {
      logger: this.logger, // Use same silent logger
    });
    // Track for cleanup
    currentMultiProvider = this.multiProvider;

    // Use rebalancer key for all chains
    // IMPORTANT: Create a fresh wallet each time to avoid nonce caching issues
    // when anvil snapshots are restored between tests
    const provider = new ethers.providers.JsonRpcProvider(
      config.deployment.anvilRpc,
    );
    // Track for cleanup
    currentProvider = provider;
    const wallet = new ethers.Wallet(config.deployment.rebalancerKey, provider);
    this.multiProvider.setSharedSigner(wallet);

    // Convert simulation strategy config to RebalancerService format
    const strategyConfig = this.buildStrategyConfig(config);

    // Create RebalancerConfig
    const rebalancerConfig = new RebalancerConfig(
      this.registry.getWarpRouteId(),
      strategyConfig,
    );

    // Create RebalancerService in daemon mode
    this.service = new RebalancerService(
      this.multiProvider,
      undefined, // Let it create MultiProtocolProvider from MultiProvider
      this.registry,
      rebalancerConfig,
      {
        mode: 'daemon',
        checkFrequency: config.pollingFrequency,
        monitorOnly: false,
        withMetrics: false,
        logger: this.logger,
      },
    );
  }

  private buildStrategyConfig(config: RebalancerSimConfig): StrategyConfig {
    const { strategyConfig } = config;

    if (strategyConfig.type === 'weighted') {
      const chains: Record<string, any> = {};

      for (const [chainName, chainConfig] of Object.entries(
        strategyConfig.chains,
      )) {
        // Convert string weights/tolerances to bigint (percentage * 100)
        // The real rebalancer expects whole numbers representing percentages
        const weight = chainConfig.weighted?.weight
          ? Math.round(parseFloat(chainConfig.weighted.weight) * 100)
          : 33;
        const tolerance = chainConfig.weighted?.tolerance
          ? Math.round(parseFloat(chainConfig.weighted.tolerance) * 100)
          : 10;

        chains[chainName] = {
          bridge: chainConfig.bridge,
          bridgeLockTime: Math.ceil(chainConfig.bridgeLockTime / 1000), // Convert ms to seconds
          weighted: {
            weight: BigInt(weight),
            tolerance: BigInt(tolerance),
          },
        };
      }

      return {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains,
      } as StrategyConfig;
    } else {
      // minAmount strategy
      const chains: Record<string, any> = {};

      for (const [chainName, chainConfig] of Object.entries(
        strategyConfig.chains,
      )) {
        chains[chainName] = {
          bridge: chainConfig.bridge,
          bridgeLockTime: Math.ceil(chainConfig.bridgeLockTime / 1000),
          minAmount: {
            min: chainConfig.minAmount?.min?.toString() ?? '0',
            target: chainConfig.minAmount?.target?.toString() ?? '0',
            type: chainConfig.minAmount?.type ?? 'absolute',
          },
        };
      }

      return {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains,
      } as StrategyConfig;
    }
  }

  async start(): Promise<void> {
    if (!this.service) {
      throw new Error('RealRebalancerRunner not initialized');
    }

    if (this.running) {
      return;
    }

    // Force stop any previously running service
    await forceStopCurrentService();

    this.running = true;
    currentRunningService = this.service;

    // Track signal listener counts before start() to identify handlers added by RebalancerService
    const sigintCountBefore = process.listenerCount('SIGINT');
    const sigtermCountBefore = process.listenerCount('SIGTERM');

    // Start the service (this runs the polling loop internally)
    // We need to catch the SIGINT/SIGTERM handlers that RebalancerService sets up
    // and prevent them from exiting the process during simulation
    const originalExit = process.exit;
    process.exit = (() => {
      // Ignore exit calls from RebalancerService during simulation
    }) as never;

    try {
      // Start in background - don't await since it runs forever
      this.service.start().catch(() => {
        // Ignore errors - daemon stopped
      });

      // Small delay to allow RebalancerService to register its handlers
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Track the handlers RebalancerService added for cleanup
      const sigintListeners = process.listeners('SIGINT');
      const sigtermListeners = process.listeners('SIGTERM');

      if (sigintListeners.length > sigintCountBefore) {
        registeredSigintHandler = sigintListeners[
          sigintListeners.length - 1
        ] as () => void;
      }
      if (sigtermListeners.length > sigtermCountBefore) {
        registeredSigtermHandler = sigtermListeners[
          sigtermListeners.length - 1
        ] as () => void;
      }
    } finally {
      process.exit = originalExit;
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.service) {
      return;
    }

    this.running = false;
    const service = this.service;
    this.service = undefined;

    // Clear global reference
    if (currentRunningService === service) {
      currentRunningService = null;
    }

    // Stop with timeout
    try {
      await Promise.race([
        service.stop().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Ignore errors
    }
  }

  isActive(): boolean {
    return this.running;
  }

  async waitForIdle(timeoutMs: number = 10000): Promise<void> {
    // For RealRebalancerService, we can't easily track active operations
    // Just wait for a reasonable settle time and return
    const settleTime = Math.min(timeoutMs, 2000);
    await new Promise((resolve) => setTimeout(resolve, settleTime));
  }
}
