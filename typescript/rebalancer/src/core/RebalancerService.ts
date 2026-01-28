import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type MultiProtocolProvider,
  type MultiProvider,
  Token,
} from '@hyperlane-xyz/sdk';
import { assert, toWei } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { getStrategyChainNames } from '../config/types.js';
import { RebalancerContextFactory } from '../factories/RebalancerContextFactory.js';
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
} from '../interfaces/IRebalancer.js';
import type {
  IStrategy,
  InflightContext,
  RebalancingRoute,
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

  constructor(
    private readonly multiProvider: MultiProvider,
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

    try {
      await this.rebalancer.rebalance([
        {
          origin,
          destination,
          amount: BigInt(toWei(amount, originToken.decimals)),
        },
      ]);
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

    const rebalancingRoutes = this.strategy!.getRebalancingRoutes(
      rawBalances,
      inflightContext,
    );

    if (rebalancingRoutes.length > 0) {
      this.logger.info(
        {
          routes: rebalancingRoutes.map((r) => ({
            from: r.origin,
            to: r.destination,
            amount: r.amount.toString(),
          })),
        },
        'Routes proposed',
      );
      if (this.rebalancer) {
        await this.executeWithTracking(rebalancingRoutes);
      }
    } else {
      this.logger.info('No rebalancing needed');
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
   */
  private async executeWithTracking(routes: RebalancingRoute[]): Promise<void> {
    if (!this.rebalancer || !this.actionTracker) {
      this.logger.warn('Rebalancer or ActionTracker not available, skipping');
      return;
    }

    // 1. Create intents paired with their routes BEFORE execution
    // This coupling ensures we can match results back to intents by route fields
    const intentRoutes = await Promise.all(
      routes.map(async (route) => ({
        intent: await this.actionTracker!.createRebalanceIntent({
          origin: this.multiProvider.getDomainId(route.origin),
          destination: this.multiProvider.getDomainId(route.destination),
          amount: route.amount,
          bridge: route.bridge,
        }),
        route,
      })),
    );

    this.logger.debug(
      { intentCount: intentRoutes.length },
      'Created rebalance intents',
    );

    // 2. Execute rebalance
    let results: RebalanceExecutionResult[];
    try {
      results = await this.rebalancer.rebalance(routes);
      this.metrics?.recordRebalancerSuccess();
      this.logger.info('Rebalancer completed a cycle successfully');
    } catch (error: any) {
      this.metrics?.recordRebalancerFailure();
      this.logger.error({ error }, 'Error while rebalancing');

      // Mark all intents as failed
      await Promise.all(
        intentRoutes.map((ir) =>
          this.actionTracker!.failRebalanceIntent(ir.intent.id),
        ),
      );
      return;
    }

    // 3. Process results - create action for successful txs, mark intent appropriately
    await this.processExecutionResults(results, intentRoutes);
  }

  /**
   * Process execution results and update tracking state.
   * Creates actions for successful transactions and updates intent statuses.
   *
   * Results are matched to intents by route (origin + destination) since
   * Rebalancer may return results in different order than input routes.
   */
  private async processExecutionResults(
    results: RebalanceExecutionResult[],
    intentRoutes: Array<{ intent: { id: string }; route: RebalancingRoute }>,
  ): Promise<void> {
    for (const result of results) {
      // Match result to intent by route fields
      const match = intentRoutes.find(
        (ir) =>
          ir.route.origin === result.route.origin &&
          ir.route.destination === result.route.destination,
      );

      if (!match) {
        this.logger.error(
          { route: result.route },
          'No matching intent found for result',
        );
        continue;
      }

      const intent = match.intent;

      if (result.success && result.messageId) {
        // Create action for successful transaction with messageId
        // Note: createRebalanceAction() automatically transitions intent to 'in_progress'.
        // The intent will be marked 'complete' when the action is delivered (in syncRebalanceActions).
        await this.actionTracker!.createRebalanceAction({
          intentId: intent.id,
          origin: this.multiProvider.getDomainId(result.route.origin),
          destination: this.multiProvider.getDomainId(result.route.destination),
          amount: result.route.amount,
          messageId: result.messageId,
          txHash: result.txHash,
        });

        this.logger.info(
          {
            intentId: intent.id,
            messageId: result.messageId,
            txHash: result.txHash,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance action created successfully',
        );
      } else if (result.success && !result.messageId) {
        // TODO: Handle successful execution without messageId (e.g., non-Hyperlane bridges)
        // For now, mark as failed since we can't track delivery without messageId
        await this.actionTracker!.failRebalanceIntent(intent.id);

        this.logger.warn(
          {
            intentId: intent.id,
            success: result.success,
            txHash: result.txHash,
            origin: result.route.origin,
            destination: result.route.destination,
          },
          'Rebalance succeeded but no messageId - cannot track delivery',
        );
      } else {
        // Mark intent as failed for failed transactions
        await this.actionTracker!.failRebalanceIntent(intent.id);

        this.logger.warn(
          {
            intentId: intent.id,
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
