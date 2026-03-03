import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type MultiProtocolProvider,
  type MultiProvider,
  Token,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, toWei } from '@hyperlane-xyz/utils';

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
import type {
  IStrategy,
  MovableCollateralRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { type InventoryMonitorConfig, Monitor } from '../monitor/Monitor.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';

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
  private logger: Logger;
  private contextFactory?: RebalancerContextFactory;
  private monitor?: Monitor;
  private strategy?: IStrategy;
  private rebalancer?: IRebalancer;
  private metrics?: Metrics;
  private mode: 'manual' | 'daemon';
  private actionTracker?: IActionTracker;
  private inflightContextAdapter?: InflightContextAdapter;
  private orchestrator?: RebalancerOrchestrator;
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly inventoryMultiProvider: MultiProvider | undefined,
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
  private async initialize(): Promise<void> {
    if (this.contextFactory) {
      // Already initialized
      return;
    }

    this.logger.info('Initializing RebalancerService...');

    // Create context factory
    this.contextFactory = await RebalancerContextFactory.create(
      this.rebalancerConfig,
      this.multiProvider,
      this.inventoryMultiProvider,
      this.multiProtocolProvider,
      this.registry,
      this.logger,
      undefined,
      this.inventorySignerKeysByProtocol,
    );

    // Create metrics if enabled
    if (this.config.withMetrics) {
      this.metrics = await this.contextFactory.createMetrics(
        this.config.coingeckoApiKey,
      );
      this.logger.info('Metrics collection enabled');
    }

    // Create strategy
    this.strategy = await this.contextFactory.createStrategy(this.metrics);

    // Create or use provided ActionTracker for tracking inflight actions
    // Must be created BEFORE rebalancer since rebalancer needs it
    if (this.config.actionTracker) {
      // Use externally provided ActionTracker (e.g., for simulation/testing)
      this.actionTracker = this.config.actionTracker;
      this.inflightContextAdapter = new InflightContextAdapter(
        this.actionTracker,
        this.multiProvider,
      );
      await this.actionTracker.initialize();
      this.logger.info('Using externally provided ActionTracker');
    } else {
      const { tracker, adapter } =
        await this.contextFactory.createActionTracker();
      this.actionTracker = tracker;
      this.inflightContextAdapter = adapter;
      await this.actionTracker.initialize();
      this.logger.info('ActionTracker initialized');
    }

    // Create rebalancers (both movableCollateral and inventory if configured)
    let rebalancers: IRebalancer[] = [];
    let externalBridgeRegistry: Partial<ExternalBridgeRegistry> = {};
    let inventoryConfig: InventoryMonitorConfig | undefined;

    if (!this.config.monitorOnly) {
      const result = await this.contextFactory.createRebalancers(
        this.actionTracker,
        this.metrics,
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
    if (rebalancers.length > 0) {
      this.rebalancer = rebalancers[0];
    }

    if (this.mode === 'daemon') {
      const checkFrequency = this.config.checkFrequency ?? 60_000;
      this.monitor = this.contextFactory.createMonitor(
        checkFrequency,
        inventoryConfig,
      );
    }

    this.orchestrator = this.contextFactory.createOrchestrator({
      strategy: this.strategy,
      actionTracker: this.actionTracker,
      inflightContextAdapter: this.inflightContextAdapter,
      rebalancers,
      externalBridgeRegistry: externalBridgeRegistry,
      metrics: this.metrics,
    });

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
  }

  /**
   * Execute a manual one-off rebalance
   */
  async executeManual(request: ManualRebalanceRequest): Promise<void> {
    await this.initialize();

    assert(
      this.rebalancer,
      'Rebalancer not available. MonitorOnly mode cannot execute manual rebalances.',
    );

    const { origin, destination, amount } = request;

    this.logger.info(
      `Manual rebalance strategy selected. Origin: ${origin}, Destination: ${destination}, Amount: ${amount}`,
    );

    const warpCore = this.contextFactory!.getWarpCore();
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
        amount: BigInt(toWei(amount, originToken.decimals)),
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
  async start(): Promise<void> {
    if (this.mode !== 'daemon') {
      throw new Error('start() can only be called in daemon mode');
    }

    await this.initialize();

    assert(this.monitor, 'Monitor must be initialized for daemon mode');

    // Setup monitor event listeners
    this.monitor
      .on(MonitorEventType.TokenInfo, this.onTokenInfo.bind(this))
      .on(MonitorEventType.Error, this.onMonitorError.bind(this))
      .on(MonitorEventType.Start, this.onMonitorStart.bind(this));

    // Set up signal handlers for graceful shutdown
    process.on('SIGINT', () => this.gracefulShutdown());
    process.on('SIGTERM', () => this.gracefulShutdown());

    try {
      await this.monitor.start();
    } catch (error) {
      this.logger.error({ error }, 'Rebalancer startup error');
      throw error;
    }
  }

  /**
   * Stop the rebalancer daemon
   */
  async stop(): Promise<void> {
    if (this.monitor) {
      await this.monitor.stop();
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

    // Unregister listeners to prevent them from being called again during shutdown
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

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
