import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type MultiProtocolProvider,
  type MultiProvider,
  Token,
} from '@hyperlane-xyz/sdk';
import { LazyAsync, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  getStrategyChainConfig,
  getStrategyChainNames,
} from '../config/types.js';
import { RebalancerContextFactory } from '../factories/RebalancerContextFactory.js';
import type { ExternalBridgeRegistry } from '../interfaces/IExternalBridge.js';
import {
  MonitorEvent,
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from '../interfaces/IMonitor.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { MovableCollateralRoute } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { type InventoryMonitorConfig, Monitor } from '../monitor/Monitor.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';
import { normalizeConfiguredAmount } from '../utils/balanceUtils.js';

import type { RebalancerOrchestrator } from './RebalancerOrchestrator.js';

export interface RebalancerServiceConfig {
  /** Execution mode: 'manual' for one-off execution, 'daemon' for continuous monitoring */
  mode: 'manual' | 'daemon';

  /** Frequency to check balances in milliseconds (daemon mode only) */
  checkFrequency?: number;

  /** Enable monitor-only mode (no transactions executed) */
  monitorOnly?: boolean;

  /** Enable Prometheus metrics collection */
  withMetrics?: boolean;

  /** CoinGecko API key for token price fetching (required for metrics) */
  coingeckoApiKey?: string;

  /** Logger instance */
  logger: Logger;

  /** Service version for logging */
  version?: string;

  /**
   * Optional pre-configured ActionTracker.
   * If provided, skips ActionTracker creation and uses this directly.
   * Useful for simulation/testing where tracking is mocked externally.
   */
  actionTracker?: IActionTracker;
}

export interface ManualRebalanceRequest {
  origin: string;
  destination: string;
  amount: string;
}

/**
 * RebalancerService is the main orchestrator for the Hyperlane Warp Route Rebalancer.
 * It supports both manual one-off rebalances and continuous daemon mode.
 *
 * @example Manual execution
 * ```typescript
 * const service = new RebalancerService(
 *   multiProvider,
 *   multiProtocolProvider,
 *   registry,
 *   rebalancerConfig,
 *   {
 *     mode: 'manual',
 *     logger: console,
 *   }
 * );
 * await service.executeManual({
 *   origin: 'ethereum',
 *   destination: 'arbitrum',
 *   amount: '1000',
 * });
 * ```
 *
 * @example Daemon mode
 * ```typescript
 * const service = new RebalancerService(
 *   multiProvider,
 *   multiProtocolProvider,
 *   registry,
 *   rebalancerConfig,
 *   {
 *     mode: 'daemon',
 *     checkFrequency: 60_000,
 *     withMetrics: true,
 *     coingeckoApiKey: process.env.COINGECKO_API_KEY,
 *     logger: console,
 *   }
 * );
 * await service.start();
 * ```
 */
export class RebalancerService {
  private isExiting = false;
  private stopping = false;
  private initializationPromise?: Promise<void>;
  private readonly initialization = new LazyAsync(() =>
    this.initializeComponents(),
  );
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private readonly manualOperations = new Set<Promise<void>>();
  private readonly shutdownHandler = () => {
    void this.gracefulShutdown();
  };
  private logger: Logger;
  private contextFactory?: RebalancerContextFactory;
  private monitor?: Monitor;
  private rebalancer?: IRebalancer;
  private metrics?: Metrics;
  private mode: 'manual' | 'daemon';
  private orchestrator?: RebalancerOrchestrator;
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly multiProtocolProvider: MultiProtocolProvider | undefined,
    private readonly registry: IRegistry,
    private readonly rebalancerConfig: RebalancerConfig,
    private readonly config: RebalancerServiceConfig,
    private readonly inventorySignerKeysByProtocol?: Partial<
      Record<ProtocolType, string>
    >,
  ) {
    this.logger = config.logger;
    this.mode = config.mode;
  }

  /**
   * Initialize the service components
   */
  private initialize(): Promise<void> {
    this.initializationPromise ??= this.initialization.get().finally(() => {
      this.initializationPromise = undefined;
    });
    return this.initializationPromise;
  }

  private async initializeComponents(): Promise<void> {
    let metrics: Metrics | undefined;
    try {
      this.logger.info('Initializing RebalancerService...');

      // Create context factory
      const contextFactory = await RebalancerContextFactory.create(
        this.rebalancerConfig,
        this.multiProvider,
        this.multiProtocolProvider,
        this.registry,
        this.logger,
        this.inventorySignerKeysByProtocol,
      );

      // Create metrics if enabled
      if (this.config.withMetrics) {
        metrics = await contextFactory.createMetrics(
          this.config.coingeckoApiKey,
        );
        this.logger.info('Metrics collection enabled');
      }

      // Create strategy
      const strategy = await contextFactory.createStrategy(metrics);

      // Create or use provided ActionTracker for tracking inflight actions
      // Must be created BEFORE rebalancer since rebalancer needs it
      let actionTracker: IActionTracker;
      let inflightContextAdapter: InflightContextAdapter;
      if (this.config.actionTracker) {
        // Use externally provided ActionTracker (e.g., for simulation/testing)
        actionTracker = this.config.actionTracker;
        inflightContextAdapter = new InflightContextAdapter(
          actionTracker,
          this.multiProvider,
        );
        await actionTracker.initialize();
        this.logger.info('Using externally provided ActionTracker');
      } else {
        const { tracker, adapter } = await contextFactory.createActionTracker();
        actionTracker = tracker;
        inflightContextAdapter = adapter;
        await actionTracker.initialize();
        this.logger.info('ActionTracker initialized');
      }

      // Create rebalancers (both movableCollateral and inventory if configured)
      let rebalancers: IRebalancer[] = [];
      let externalBridgeRegistry: Partial<ExternalBridgeRegistry> = {};
      let inventoryConfig: InventoryMonitorConfig | undefined;

      if (!this.config.monitorOnly) {
        const result = await contextFactory.createRebalancers(
          actionTracker,
          metrics,
        );
        rebalancers = result.rebalancers;
        externalBridgeRegistry = result.externalBridgeRegistry;
        inventoryConfig = result.inventoryConfig;

        if (rebalancers.length > 0) {
          this.logger.info(`${rebalancers.length} rebalancer(s) created`);
        }
      } else {
        this.logger.warn(
          'Running in monitorOnly mode: no transactions will be executed.',
        );
      }

      // Set instance variable for backward compatibility with executeManual
      // (Task 5 will remove this when refactoring executeManual)
      const rebalancer = rebalancers[0];
      let monitor: Monitor | undefined;
      if (this.mode === 'daemon') {
        const checkFrequency = this.config.checkFrequency ?? 60_000;
        monitor = contextFactory.createMonitor(checkFrequency, inventoryConfig);
      }

      const orchestrator = contextFactory.createOrchestrator({
        strategy: strategy,
        actionTracker: actionTracker,
        inflightContextAdapter: inflightContextAdapter,
        rebalancers,
        externalBridgeRegistry: externalBridgeRegistry,
        metrics: metrics,
      });

      // Publish readiness only after every component has been constructed.
      this.contextFactory = contextFactory;
      this.metrics = metrics;
      this.rebalancer = rebalancer;
      this.monitor = monitor;
      this.orchestrator = orchestrator;
      this.logger.info(
        {
          warpRouteId: this.rebalancerConfig.warpRouteId,
          strategyTypes: this.rebalancerConfig.strategyConfig.map(
            (s) => s.rebalanceStrategy,
          ),
          chains: getStrategyChainNames(this.rebalancerConfig.strategyConfig),
        },
        'RebalancerService initialized',
      );
    } catch (error) {
      if (metrics) await metrics.stop();
      throw error;
    }
  }

  /**
   * Execute a manual one-off rebalance
   */
  executeManual(request: ManualRebalanceRequest): Promise<void> {
    if (this.stopping || this.isExiting)
      return Promise.reject(new Error('RebalancerService is stopping'));
    const operation = this.executeManualRebalance(request).finally(() => {
      this.manualOperations.delete(operation);
    });
    this.manualOperations.add(operation);
    return operation;
  }

  private async executeManualRebalance(
    request: ManualRebalanceRequest,
  ): Promise<void> {
    await this.initialize();

    assert(
      this.rebalancer,
      'Rebalancer not available. MonitorOnly mode cannot execute manual rebalances.',
    );

    const { origin, destination, amount } = request;

    this.logger.info(
      `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
    );

    assert(this.contextFactory, 'Rebalancer context must be initialized');
    const warpCore = this.contextFactory.getWarpCore();
    const originToken = warpCore.tokens.find(
      (t: Token) => t.chainName === origin,
    );

    if (!originToken) {
      const error = `Origin token not found for chain ${origin}`;
      this.logger.error(error);
      throw new Error(error);
    }

    // Validate amount
    const amountNum = Number(amount);
    assert(!isNaN(amountNum), 'Amount must be a valid number');
    assert(amountNum > 0, 'Amount must be greater than 0');

    const originConfig = getStrategyChainConfig(
      this.rebalancerConfig.strategyConfig,
      origin,
    );
    assert(
      originConfig?.bridge,
      `No bridge configured for origin chain ${origin}`,
    );

    // Use destination-specific bridge override if configured, otherwise use default
    const bridge =
      originConfig.override?.[destination]?.bridge ?? originConfig.bridge;

    try {
      const manualRoute: MovableCollateralRoute & { intentId: string } = {
        origin,
        destination,
        amount: normalizeConfiguredAmount(amount, originToken),
        executionType: 'movableCollateral',
        bridge,
        intentId: `manual-${Date.now()}`,
      };
      await this.rebalancer.rebalance([manualRoute]);
      this.logger.info(
        `✅ Manual rebalance from ${origin} to ${destination} for amount ${amount} submitted successfully.`,
      );
    } catch (error) {
      this.logger.error(
        { error },
        `❌ Manual rebalance from ${origin} to ${destination} failed`,
      );
      throw error;
    }
  }

  /**
   * Start the rebalancer in daemon mode (continuous monitoring)
   */
  start(): Promise<void> {
    if (this.mode !== 'daemon') {
      return Promise.reject(
        new Error('start() can only be called in daemon mode'),
      );
    }
    if (this.stopping || this.isExiting)
      return Promise.reject(new Error('RebalancerService is stopping'));
    this.startPromise ??= this.startDaemon().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startDaemon(): Promise<void> {
    await this.initialize();
    if (this.stopping) return;
    assert(this.monitor, 'Monitor must be initialized for daemon mode');
    this.monitor
      .on(MonitorEventType.TokenInfo, this.onTokenInfo.bind(this))
      .on(MonitorEventType.Error, this.onMonitorError.bind(this))
      .on(MonitorEventType.Start, this.onMonitorStart.bind(this));
    process.once('SIGINT', this.shutdownHandler);
    process.once('SIGTERM', this.shutdownHandler);
    try {
      await this.monitor.start();
    } catch (error) {
      this.logger.error({ error }, 'Rebalancer startup error');
      throw error;
    } finally {
      process.off('SIGINT', this.shutdownHandler);
      process.off('SIGTERM', this.shutdownHandler);
    }
  }

  /** Stop admission, drain initialization and mutations, then release resources. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.stopComponents().finally(() => {
      this.stopping = false;
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private async stopComponents(): Promise<void> {
    // Stop the monitor before waiting on manual work, so it admits no new cycles.
    const monitor = this.monitor;
    const stoppingMonitor = monitor?.stop();
    await Promise.allSettled([
      ...(stoppingMonitor ? [stoppingMonitor] : []),
      ...(this.initializationPromise ? [this.initializationPromise] : []),
      ...this.manualOperations,
    ]);
    try {
      if (this.monitor !== monitor) await this.monitor?.stop();
      else await stoppingMonitor;
      if (this.startPromise) await this.startPromise;
    } finally {
      await this.metrics?.stop();
      this.contextFactory = undefined;
      this.metrics = undefined;
      this.rebalancer = undefined;
      this.monitor = undefined;
      this.orchestrator = undefined;
      this.initialization.reset();
      process.off('SIGINT', this.shutdownHandler);
      process.off('SIGTERM', this.shutdownHandler);
    }
  }

  /**
   * Gracefully shutdown the service
   */
  async gracefulShutdown(): Promise<void> {
    if (this.isExiting) {
      return;
    }
    this.isExiting = true;

    this.logger.info('Gracefully shutting down rebalancer...');
    await this.stop();

    this.logger.info('Rebalancer shutdown complete');
    process.exit(0);
  }

  /**
   * Handle token info events from monitor by delegating to orchestrator
   */
  private async onTokenInfo(event: MonitorEvent): Promise<void> {
    if (!this.orchestrator) {
      this.logger.error('Orchestrator not initialized');
      return;
    }

    await this.orchestrator.executeCycle(event);
  }

  /**
   * Event handler for monitor errors
   */
  private onMonitorError(error: Error): void {
    if (error instanceof MonitorPollingError) {
      this.logger.error(error.message);
      this.metrics?.recordPollingError();
    } else if (error instanceof MonitorStartError) {
      this.logger.error(error.message);
      throw error;
    } else {
      this.logger.error(
        { error },
        'An unexpected error occurred in the monitor',
      );
    }
  }

  /**
   * Event handler for monitor start
   */
  private onMonitorStart(): void {
    this.logger.info('Rebalancer started successfully 🚀');
  }
}
