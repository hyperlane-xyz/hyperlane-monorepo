import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { pino } from 'pino';

import {
  RebalancerConfig,
  RebalancerService,
  RebalancerStrategyOptions,
} from '@hyperlane-xyz/rebalancer';
import type { StrategyConfig } from '@hyperlane-xyz/rebalancer';
import { MultiProtocolProvider, MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { SimulationRegistry } from './SimulationRegistry.js';
import type { IRebalancerRunner, RebalancerSimConfig } from './types.js';

// Silent logger for the rebalancer
const logger = pino({ level: 'silent' });

// Track the current instance for cleanup
let currentInstance: ProductionRebalancerRunner | null = null;

function setCurrentInstance(instance: ProductionRebalancerRunner | null): void {
  currentInstance = instance;
}

/**
 * Global cleanup function - call between test runs to ensure clean state
 */
export async function cleanupProductionRebalancer(): Promise<void> {
  if (currentInstance) {
    const instance = currentInstance;
    currentInstance = null;
    try {
      await instance.stop();
    } catch (error) {
      console.debug('cleanupProductionRebalancer: stop failed', error);
    }
  }
  // Small delay to allow any async cleanup to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function buildStrategyConfig(config: RebalancerSimConfig): StrategyConfig {
  const { strategyConfig } = config;

  if (strategyConfig.type === 'weighted') {
    const chains: Record<string, any> = {};

    for (const [chainName, chainConfig] of Object.entries(
      strategyConfig.chains,
    )) {
      const weight = chainConfig.weighted?.weight
        ? Math.round(parseFloat(chainConfig.weighted.weight) * 100)
        : 33;
      const tolerance = chainConfig.weighted?.tolerance
        ? Math.round(parseFloat(chainConfig.weighted.tolerance) * 100)
        : 10;

      chains[chainName] = {
        bridge: chainConfig.bridge,
        bridgeLockTime: Math.ceil(chainConfig.bridgeLockTime / 1000),
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
    const chains: Record<string, any> = {};

    for (const [chainName, chainConfig] of Object.entries(
      strategyConfig.chains,
    )) {
      chains[chainName] = {
        bridge: chainConfig.bridge,
        bridgeLockTime: Math.ceil(chainConfig.bridgeLockTime / 1000),
        minAmount: {
          min: chainConfig.minAmount?.min ?? '0',
          target: chainConfig.minAmount?.target ?? '0',
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

/**
 * ProductionRebalancerRunner runs the actual RebalancerService in-process.
 * This wraps the real CLI rebalancer for simulation testing.
 */
export class ProductionRebalancerRunner
  extends EventEmitter
  implements IRebalancerRunner
{
  readonly name = 'ProductionRebalancerService';

  private config?: RebalancerSimConfig;
  private service?: RebalancerService;
  private running = false;

  async initialize(config: RebalancerSimConfig): Promise<void> {
    // Cleanup any previously running instance
    await cleanupProductionRebalancer();

    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config) {
      throw new Error('ProductionRebalancerRunner not initialized');
    }

    if (this.running) {
      return;
    }

    // Cleanup any previously running instance
    await cleanupProductionRebalancer();

    // Create registry
    const registry = new SimulationRegistry(this.config.deployment);

    // Build chain metadata
    const chainMetadata: Record<string, any> = {};
    for (const [chainName, domain] of Object.entries(
      this.config.deployment.domains,
    )) {
      chainMetadata[chainName] = {
        name: chainName,
        chainId: 31337,
        domainId: domain.domainId,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: this.config.deployment.anvilRpc }],
        nativeToken: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        blocks: {
          confirmations: 0,
          estimateBlockTime: 1,
          reorgPeriod: 0, // Disable historical block queries in simulation
        },
      };
    }

    // Create MultiProvider
    const multiProvider = new MultiProvider(chainMetadata, { logger });

    // Create provider and wallet
    const provider = new ethers.providers.JsonRpcProvider(
      this.config.deployment.anvilRpc,
    );
    // Set fast polling interval for tx.wait() - ethers defaults to 4000ms
    provider.pollingInterval = 100;
    provider.polling = false;

    const wallet = new ethers.Wallet(
      this.config.deployment.rebalancerKey,
      provider,
    );
    multiProvider.setSharedSigner(wallet);

    // Set fast polling interval and disable automatic polling on all internal providers
    for (const chainName of multiProvider.getKnownChainNames()) {
      const chainProvider = multiProvider.tryGetProvider(chainName);
      if (chainProvider && 'polling' in chainProvider) {
        const jsonRpcProvider =
          chainProvider as ethers.providers.JsonRpcProvider;
        jsonRpcProvider.pollingInterval = 100;
        jsonRpcProvider.polling = false;
      }
    }

    // Create MultiProtocolProvider
    const multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);

    for (const chainName of multiProtocolProvider.getKnownChainNames()) {
      try {
        const mppProvider = multiProtocolProvider.getProvider(chainName);
        if (mppProvider && 'polling' in mppProvider) {
          (mppProvider as unknown as ethers.providers.JsonRpcProvider).polling =
            false;
        }
      } catch (error) {
        console.debug(
          'ProductionRebalancerRunner: failed to disable polling for',
          chainName,
          error,
        );
      }
    }

    // Build strategy config
    const strategyConfig = buildStrategyConfig(this.config);

    // Create RebalancerConfig
    // Need explicit cast due to discriminated union type narrowing
    const rebalancerConfig = new RebalancerConfig(registry.getWarpRouteId(), [
      strategyConfig,
    ] as StrategyConfig[]);

    // Create service
    this.service = new RebalancerService(
      multiProvider,
      multiProtocolProvider,
      registry,
      rebalancerConfig,
      {
        mode: 'daemon',
        checkFrequency: this.config.pollingFrequency,
        monitorOnly: false,
        withMetrics: false,
        logger,
      },
    );

    // Mark as running after service creation to avoid inconsistent state
    this.running = true;
    setCurrentInstance(this);

    // Start service in the background (don't await - it runs forever in daemon mode)
    this.service.start().catch((error) => {
      console.error('RebalancerService error:', error);
    });

    // Wait a bit for the service to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Clear global reference
    if (currentInstance === this) {
      currentInstance = null;
    }

    if (this.service) {
      try {
        await this.service.stop();
      } catch (error) {
        console.debug(
          'ProductionRebalancerRunner.stop: service.stop() failed',
          error,
        );
      }
      this.service = undefined;
    }

    this.config = undefined;
    this.removeAllListeners();
  }

  isActive(): boolean {
    return this.running;
  }

  async waitForIdle(timeoutMs: number = 10000): Promise<void> {
    // Wait for a reasonable settle time
    const settleTime = Math.min(timeoutMs, 2000);
    await new Promise((resolve) => setTimeout(resolve, settleTime));
  }
}
