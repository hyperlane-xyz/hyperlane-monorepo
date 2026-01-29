import { randomUUID } from 'crypto';
import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type MultiProtocolProvider,
  type MultiProvider,
  Token,
} from '@hyperlane-xyz/sdk';
import { assert, toWei } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  ExecutionType,
  getChainExecutionType,
  getStrategyChainConfig,
  getStrategyChainNames,
  hasInventoryChains,
} from '../config/types.js';
import { RebalancerContextFactory } from '../factories/RebalancerContextFactory.js';
import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type {
  IInventoryRebalancer,
  InventoryRoute,
} from '../interfaces/IInventoryRebalancer.js';
import {
  type ConfirmedBlockTags,
  MonitorEvent,
  MonitorEventType,
  MonitorPollingError,
  MonitorStartError,
} from '../interfaces/IMonitor.js';
import type {
  IRebalancer,
  RebalanceExecutionResult,
  RebalanceRoute,
} from '../interfaces/IRebalancer.js';
import type {
  IStrategy,
  InflightContext,
  StrategyRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { Monitor } from '../monitor/Monitor.js';
import {
  type IActionTracker,
  InflightContextAdapter,
} from '../tracking/index.js';
import { getRawBalances } from '../utils/balanceUtils.js';

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
  private inventoryRebalancer?: IInventoryRebalancer;
  private inventoryMonitor?: IInventoryMonitor;
  private bridge?: IExternalBridge;

  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly inventoryMultiProvider: MultiProvider | undefined,
    private readonly multiProtocolProvider: MultiProtocolProvider | undefined,
    private readonly registry: IRegistry,
    private readonly rebalancerConfig: RebalancerConfig,
    private readonly config: RebalancerServiceConfig,
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
    );

    // Create monitor (always needed for daemon mode)
    if (this.mode === 'daemon') {
      const checkFrequency = this.config.checkFrequency ?? 60_000;
      this.monitor = this.contextFactory.createMonitor(checkFrequency);
    }

    // Create metrics if enabled
    if (this.config.withMetrics) {
      this.metrics = await this.contextFactory.createMetrics(
        this.config.coingeckoApiKey,
      );
      this.logger.info('Metrics collection enabled');
    }

    // Create strategy
    this.strategy = await this.contextFactory.createStrategy(this.metrics);

    // Create rebalancer (unless in monitor-only mode)
    if (!this.config.monitorOnly) {
      this.rebalancer = this.contextFactory.createRebalancer(this.metrics);
    } else {
      this.logger.warn(
        'Running in monitorOnly mode: no transactions will be executed.',
      );
    }

    // Create ActionTracker for tracking inflight actions
    const { tracker, adapter } =
      await this.contextFactory.createActionTracker();
    this.actionTracker = tracker;
    this.inflightContextAdapter = adapter;
    await this.actionTracker.initialize();
    this.logger.info('ActionTracker initialized');

    // Create inventory components if any chains use inventory execution type
    if (
      hasInventoryChains(this.rebalancerConfig.strategyConfig) &&
      !this.config.monitorOnly
    ) {
      const inventoryComponents =
        await this.contextFactory.createInventoryComponents(this.actionTracker);
      if (inventoryComponents) {
        this.inventoryMonitor = inventoryComponents.inventoryMonitor;
        this.inventoryRebalancer = inventoryComponents.inventoryRebalancer;
        // TODO: we want to eventually support multiple bridges
        // TODO: rename this to inventoryBridge
        this.bridge = inventoryComponents.bridge;
        this.logger.info('Inventory rebalancing enabled');
      }
    }

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
      const route: RebalanceRoute = {
        intentId: randomUUID(),
        origin,
        destination,
        amount: BigInt(toWei(amount, originToken.decimals)),
        bridge,
      };
      await this.rebalancer.rebalance([route]);
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

  private async onTokenInfo(event: MonitorEvent): Promise<void> {
    this.logger.info('Polling cycle started');

    if (this.metrics) {
      await Promise.all(
        event.tokensInfo.map((tokenInfo) =>
          this.metrics!.processToken(tokenInfo),
        ),
      );
    }

    await this.syncActionTracker(event.confirmedBlockTags);

    // Refresh and log inventory balances for visibility
    if (this.inventoryMonitor) {
      await this.inventoryMonitor.refresh();
    }

    const rawBalances = getRawBalances(
      getStrategyChainNames(this.rebalancerConfig.strategyConfig),
      event,
      this.logger,
    );

    this.logger.info(
      {
        balances: Object.entries(rawBalances).map(([chain, balance]) => ({
          chain,
          balance: balance.toString(),
        })),
      },
      'Router balances',
    );

    // Get inflight context for strategy decision-making
    const inflightContext = await this.getInflightContext();

    const strategyRoutes = this.strategy!.getRebalancingRoutes(
      rawBalances,
      inflightContext,
    );

    if (strategyRoutes.length > 0) {
      this.logger.info(
        {
          routes: strategyRoutes.map((r) => ({
            from: r.origin,
            to: r.destination,
            amount: r.amount.toString(),
          })),
        },
        'Routes proposed',
      );
      if (this.rebalancer) {
        await this.executeWithTracking(strategyRoutes);
      }
    } else {
      this.logger.info('No rebalancing needed');
    }

    // TODO: we should refactor this
    // Always check for existing inventory intents to continue, even when no new routes proposed.
    // This handles the case where the bridge completed but the transferRemote hasn't been sent yet.
    if (this.inventoryRebalancer && strategyRoutes.length === 0) {
      await this.executeInventoryRoutes([]);
    }

    this.logger.info('Polling cycle completed');
  }

  private async syncActionTracker(
    confirmedBlockTags?: ConfirmedBlockTags,
  ): Promise<void> {
    if (!this.actionTracker) return;

    try {
      await Promise.all([
        this.actionTracker.syncTransfers(confirmedBlockTags),
        this.actionTracker.syncRebalanceIntents(),
        this.actionTracker.syncRebalanceActions(confirmedBlockTags),
      ]);

      // Sync inventory movement actions via external bridge API
      if (this.bridge) {
        await this.actionTracker.syncInventoryMovementActions(this.bridge);
      }

      await this.actionTracker.logStoreContents();
    } catch (error) {
      this.logger.warn(
        { error },
        'ActionTracker sync failed, using stale data',
      );
    }
  }

  /**
   * Get inflight context for strategy decision-making
   */
  private async getInflightContext(): Promise<InflightContext> {
    if (!this.inflightContextAdapter) {
      return { pendingRebalances: [], pendingTransfers: [] };
    }

    return this.inflightContextAdapter.getInflightContext();
  }

  /**
   * Execute rebalancing with intent tracking.
   * Creates intents before execution, processes results after.
   *
   * Routes are classified by execution type:
   * - movableCollateral: Uses existing Rebalancer (on-chain rebalance)
   * - inventory: Uses InventoryRebalancer (external bridge + transferRemote)
   */
  private async executeWithTracking(routes: StrategyRoute[]): Promise<void> {
    if (!this.actionTracker) {
      this.logger.warn('ActionTracker not available, skipping');
      return;
    }

    // Classify routes by execution method
    const { movableCollateral, inventory } = this.classifyRoutes(routes);

    // Execute movable collateral routes (existing flow)
    if (movableCollateral.length > 0 && this.rebalancer) {
      await this.executeMovableCollateralRoutes(movableCollateral);
    }

    // Execute inventory routes (new inventory flow)
    if (inventory.length > 0 && this.inventoryRebalancer) {
      await this.executeInventoryRoutes(inventory);
    }
  }

  /**
   * Classify routes by execution method based on chain config.
   * If either origin or destination is an inventory chain, use inventory execution.
   */
  private classifyRoutes(routes: StrategyRoute[]): {
    movableCollateral: StrategyRoute[];
    inventory: StrategyRoute[];
  } {
    const movableCollateral: StrategyRoute[] = [];
    const inventory: StrategyRoute[] = [];

    for (const route of routes) {
      const originType = getChainExecutionType(
        this.rebalancerConfig.strategyConfig,
        route.origin,
      );
      const destType = getChainExecutionType(
        this.rebalancerConfig.strategyConfig,
        route.destination,
      );

      if (
        originType === ExecutionType.Inventory ||
        destType === ExecutionType.Inventory
      ) {
        inventory.push(route);
      } else {
        movableCollateral.push(route);
      }
    }

    if (movableCollateral.length > 0 || inventory.length > 0) {
      this.logger.debug(
        {
          movableCollateral: movableCollateral.length,
          inventory: inventory.length,
        },
        'Routes classified by execution type',
      );
    }

    return { movableCollateral, inventory };
  }

  /**
   * Execute movable collateral routes using the existing Rebalancer.
   */
  private async executeMovableCollateralRoutes(
    routes: StrategyRoute[],
  ): Promise<void> {
    if (!this.rebalancer || !this.actionTracker) return;

    // 1. Create intents for each route BEFORE execution
    const intents = await Promise.all(
      routes.map((route) =>
        this.actionTracker!.createRebalanceIntent({
          origin: this.multiProvider.getDomainId(route.origin),
          destination: this.multiProvider.getDomainId(route.destination),
          amount: route.amount,
          bridge: route.bridge,
          executionMethod: 'movable_collateral',
        }),
      ),
    );

    this.logger.debug(
      { intentCount: intents.length },
      'Created movable collateral rebalance intents',
    );

    // 2. Build RebalanceRoutes with intentIds
    const rebalanceRoutes: RebalanceRoute[] = routes.map((route, idx) => ({
      ...route,
      intentId: intents[idx].id,
    }));

    // 3. Execute rebalance
    let results: RebalanceExecutionResult[];
    try {
      results = await this.rebalancer.rebalance(rebalanceRoutes);
      const failedResults = results.filter((r) => !r.success);
      if (failedResults.length > 0) {
        this.metrics?.recordRebalancerFailure();
        this.logger.warn(
          { failureCount: failedResults.length, total: results.length },
          'Movable collateral rebalancer completed with failures',
        );
      } else {
        this.metrics?.recordRebalancerSuccess();
        this.logger.info(
          'Movable collateral rebalancer completed successfully',
        );
      }
    } catch (error: any) {
      this.metrics?.recordRebalancerFailure();
      this.logger.error(
        { error },
        'Error while rebalancing (movable collateral)',
      );

      // Mark all intents as failed
      await Promise.all(
        intents.map((intent) =>
          this.actionTracker!.failRebalanceIntent(intent.id),
        ),
      );
      return;
    }

    // 3. Process results - results have IDs that match intents directly
    await this.processExecutionResults(results);
  }

  /**
   * Execute inventory routes using the InventoryRebalancer.
   *
   * InventoryRebalancer handles single-intent logic internally:
   * - If an in_progress intent exists, continues it (ignores new routes)
   * - Otherwise, takes only the first route and creates a new intent
   */
  private async executeInventoryRoutes(routes: StrategyRoute[]): Promise<void> {
    if (!this.inventoryRebalancer) return;

    // Refresh inventory balances before execution
    if (this.inventoryMonitor) {
      await this.inventoryMonitor.refresh();
    }

    // Convert routes and let InventoryRebalancer decide what to execute
    const inventoryRoutes: InventoryRoute[] = routes.map((r) => ({
      origin: r.origin,
      destination: r.destination,
      amount: r.amount,
    }));

    try {
      const results = await this.inventoryRebalancer.execute(inventoryRoutes);

      // Log results
      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      if (successful.length > 0) {
        this.logger.info(
          { count: successful.length },
          'Inventory rebalancer completed successfully',
        );
      }

      if (failed.length > 0) {
        this.logger.warn(
          {
            count: failed.length,
            errors: failed.map((r) => ({
              route: `${r.route.origin} → ${r.route.destination}`,
              error: r.error,
            })),
          },
          'Some inventory routes failed',
        );
      }
    } catch (error: any) {
      this.logger.error({ error }, 'Error while executing inventory routes');
    }
  }

  /**
   * Process execution results and update tracking state.
   * Results are matched to intents by the route ID (which equals the intent ID).
   */
  private async processExecutionResults(
    results: RebalanceExecutionResult[],
  ): Promise<void> {
    for (const result of results) {
      const intentId = result.route.intentId;

      if (result.success && result.messageId) {
        await this.actionTracker!.createRebalanceAction({
          intentId,
          origin: this.multiProvider.getDomainId(result.route.origin),
          destination: this.multiProvider.getDomainId(result.route.destination),
          amount: result.route.amount,
          type: 'rebalance_message',
          messageId: result.messageId,
          txHash: result.txHash,
        });

        this.logger.info(
          {
            intentId,
            messageId: result.messageId,
            txHash: result.txHash,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance action created successfully',
        );
      } else {
        await this.actionTracker!.failRebalanceIntent(intentId);

        this.logger.warn(
          {
            intentId,
            success: result.success,
            error: result.error,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance intent marked as failed',
        );
      }
    }
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
