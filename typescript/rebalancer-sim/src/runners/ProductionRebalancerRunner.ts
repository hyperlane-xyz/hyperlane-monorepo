import { EventEmitter } from 'events';
import { pino } from 'pino';

import {
  DEFAULT_INTENT_TTL_MS,
  RebalancerConfig,
  RebalancerService,
  RebalancerStrategyOptions,
} from '@hyperlane-xyz/rebalancer';
import type { StrategyConfig } from '@hyperlane-xyz/rebalancer';
import {
  LocalAccountViemSigner,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, ensure0x, rootLogger } from '@hyperlane-xyz/utils';

import type { IRebalancerRunner, RebalancerSimConfig } from '../types.js';

import { MockActionTracker } from './MockActionTracker.js';
import { SimulationRegistry } from './SimulationRegistry.js';

// Silent logger for the rebalancer service (internal)
const silentLogger = pino({ level: 'silent' });

// Logger for simulation harness output
const logger = rootLogger.child({ module: 'ProductionRebalancerRunner' });

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
      logger.debug({ error }, 'cleanupProductionRebalancer: stop failed');
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
  private mockTracker = new MockActionTracker();

  async initialize(config: RebalancerSimConfig): Promise<void> {
    // Cleanup any previously running instance
    await cleanupProductionRebalancer();

    this.config = config;

    // Reset tracker state for fresh simulation
    this.mockTracker.clear();
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

    // Create MultiProvider (with silent logger to suppress internal logs)
    const multiProvider = new MultiProvider(chainMetadata, {
      logger: silentLogger,
    });

    const wallet = new LocalAccountViemSigner(
      ensure0x(this.config.deployment.rebalancerKey) as `0x${string}`,
    );
    multiProvider.setSharedSigner(wallet);

    // Disable automatic polling on all internal providers
    for (const chainName of multiProvider.getKnownChainNames()) {
      const chainProvider = multiProvider.tryGetProvider(chainName);
      if (chainProvider && 'polling' in chainProvider) {
        (
          chainProvider as { polling?: boolean; pollingInterval?: number }
        ).polling = false;
      }
      if (chainProvider && 'pollingInterval' in chainProvider) {
        (chainProvider as { pollingInterval?: number }).pollingInterval = 100;
      }
    }

    // Create MultiProtocolProvider
    const multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);

    for (const chainName of multiProtocolProvider.getKnownChainNames()) {
      try {
        const mppProvider = multiProtocolProvider.getProvider(chainName);
        if (mppProvider && 'polling' in mppProvider) {
          (mppProvider as { polling?: boolean }).polling = false;
        }
      } catch (error) {
        logger.debug(
          { chainName, error },
          'Failed to disable polling for chain',
        );
      }
    }

    // Build strategy config
    const strategyConfig = buildStrategyConfig(this.config);

    // Create RebalancerConfig
    // Need explicit cast due to discriminated union type narrowing
    const rebalancerConfig = new RebalancerConfig(
      registry.getWarpRouteId(),
      [strategyConfig] as StrategyConfig[],
      DEFAULT_INTENT_TTL_MS,
    );

    // Create service with mock action tracker
    this.service = new RebalancerService(
      multiProvider,
      undefined,
      multiProtocolProvider,
      registry,
      rebalancerConfig,
      {
        mode: 'daemon',
        checkFrequency: this.config.pollingFrequency,
        monitorOnly: false,
        withMetrics: false,
        logger: silentLogger,
        actionTracker: this.mockTracker,
      },
    );

    // Mark as running after service creation to avoid inconsistent state
    this.running = true;
    setCurrentInstance(this);

    // Start service in the background (don't await - it runs forever in daemon mode)
    let startupError: Error | undefined;
    this.service.start().catch((error) => {
      startupError = error;
      logger.error({ error }, 'RebalancerService error');
    });

    // Wait a bit for the service to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Surface any startup errors
    if (startupError) {
      throw startupError;
    }
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
        logger.debug({ error }, 'service.stop() failed');
      }
      this.service = undefined;
    }

    this.config = undefined;
    this.mockTracker.clear();
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

  /**
   * Get the mock action tracker for direct inflight tracking updates.
   */
  getActionTracker(): MockActionTracker {
    return this.mockTracker;
  }
}
