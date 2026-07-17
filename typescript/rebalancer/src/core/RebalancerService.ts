import { Logger } from 'pino';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  type MultiProtocolProvider,
  type MultiProvider,
  Token,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, sleep } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  DEFAULT_MOVEMENT_STALENESS_MS,
  ExecutionType,
  ExternalBridgeType,
  getStrategyChainConfig,
  getStrategyChainNames,
} from '../config/types.js';
import {
  type ManualInventoryOptions,
  RebalancerContextFactory,
} from '../factories/RebalancerContextFactory.js';
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
  InventoryRoute,
  MovableCollateralRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import {
  type InventoryMonitorConfig,
  Monitor,
  fetchInventoryBalances,
} from '../monitor/Monitor.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';
import { normalizeConfiguredAmount } from '../utils/balanceUtils.js';

import { InventoryRebalancer } from './InventoryRebalancer.js';
import type { RebalancerOrchestrator } from './RebalancerOrchestrator.js';

export const DEFAULT_MANUAL_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_MANUAL_TIMEOUT_MS = 45 * 60 * 1_000;

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

  /** API keys for configured external bridge providers */
  externalBridgeApiKeys?: Partial<Record<ExternalBridgeType, string>>;

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
  executionType?: ExecutionType;
  externalBridge?: ExternalBridgeType;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function isInventoryRebalancer(
  rebalancer: IRebalancer,
): rebalancer is InventoryRebalancer {
  return rebalancer.rebalancerType === 'inventory';
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
  private inventoryRebalancer?: InventoryRebalancer;
  private inventoryMonitorConfig?: InventoryMonitorConfig;
  private externalBridgeRegistry: Partial<ExternalBridgeRegistry> = {};
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
  private async initialize(options?: {
    manualInventory?: ManualInventoryOptions;
    movementStalenessMs?: number;
  }): Promise<void> {
    if (this.contextFactory) {
      assert(
        !options,
        'RebalancerService is already initialized; initialization options cannot be applied',
      );
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
      this.inventorySignerKeysByProtocol,
      this.config.externalBridgeApiKeys,
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
      const { tracker, adapter } = options?.movementStalenessMs
        ? await this.contextFactory.createActionTracker(undefined, {
            movementStalenessMs: options.movementStalenessMs,
          })
        : await this.contextFactory.createActionTracker();
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
        undefined,
        options?.manualInventory,
      );
      rebalancers = result.rebalancers;
      externalBridgeRegistry = result.externalBridgeRegistry;
      inventoryConfig = result.inventoryConfig;
      this.inventoryRebalancer = rebalancers.find(isInventoryRebalancer);
      this.inventoryMonitorConfig = inventoryConfig;
      this.externalBridgeRegistry = externalBridgeRegistry;

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
    if (
      (request.executionType ?? ExecutionType.MovableCollateral) ===
      ExecutionType.Inventory
    ) {
      return this.executeManualInventory(request);
    }

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

  private resolveManualExternalBridge(
    origin: string,
    destination: string,
    cliOverride?: ExternalBridgeType,
  ): ExternalBridgeType {
    const originConfig = getStrategyChainConfig(
      this.rebalancerConfig.strategyConfig,
      origin,
    );
    const externalBridge =
      cliOverride ??
      originConfig?.override?.[destination]?.externalBridge ??
      originConfig?.externalBridge;
    assert(
      externalBridge,
      `No external bridge configured for ${origin} → ${destination}. Pass an external bridge or configure one in the strategy.`,
    );
    return externalBridge;
  }

  private async checkManualInventoryTerminal(
    intentId: string,
  ): Promise<boolean> {
    assert(this.actionTracker, 'ActionTracker must be initialized');
    const intent = await this.actionTracker.getRebalanceIntent(intentId);
    if (!intent) return false;

    if (intent.status === 'failed' || intent.status === 'cancelled') {
      throw new Error(
        `Manual inventory rebalance intent ${intentId} reached terminal status ${intent.status}`,
      );
    }
    if (intent.status !== 'complete') return false;

    const actions = await this.actionTracker.getActionsForIntent(intentId);
    const completedAmount = actions
      .filter(
        (action) =>
          action.type === 'inventory_deposit' && action.status === 'complete',
      )
      .reduce((sum, action) => sum + action.amount, 0n);
    if (completedAmount === 0n) {
      throw new Error(
        `Manual inventory rebalance intent ${intentId} completed without moving funds — amount below the gas-based minimum viable transfer`,
      );
    }
    if (completedAmount < intent.amount) {
      this.logger.warn(
        {
          intentId,
          completedAmount: completedAmount.toString(),
          requestedAmount: intent.amount.toString(),
          writtenOffAmount: (intent.amount - completedAmount).toString(),
        },
        'Manual inventory rebalance completed with a written-off remainder',
      );
    }
    this.logger.info(
      {
        intentId,
        completedAmount: completedAmount.toString(),
        requestedAmount: intent.amount.toString(),
      },
      '✅ Manual inventory rebalance completed successfully',
    );
    return true;
  }

  private async executeManualInventory(
    request: ManualRebalanceRequest,
  ): Promise<void> {
    const { origin, destination, amount } = request;
    const pollIntervalMs =
      request.pollIntervalMs ?? DEFAULT_MANUAL_POLL_INTERVAL_MS;
    const timeoutMs = request.timeoutMs ?? DEFAULT_MANUAL_TIMEOUT_MS;
    const externalBridge = this.resolveManualExternalBridge(
      origin,
      destination,
      request.externalBridge,
    );

    await this.initialize({
      manualInventory: {
        additionalInventoryChains: [origin, destination],
        requiredExternalBridges: [externalBridge],
      },
      movementStalenessMs: Math.max(DEFAULT_MOVEMENT_STALENESS_MS, timeoutMs),
    });

    assert(
      this.inventoryRebalancer,
      'Inventory rebalancer not available. MonitorOnly mode cannot execute manual rebalances.',
    );
    assert(this.contextFactory, 'Rebalancer context must be initialized');
    assert(this.actionTracker, 'ActionTracker must be initialized');
    assert(
      this.inventoryMonitorConfig,
      'Inventory monitor config must be initialized',
    );

    const warpCore = this.contextFactory.getWarpCore();
    const originToken = warpCore.tokens.find(
      (token: Token) => token.chainName === origin,
    );
    if (!originToken) {
      const error = `Origin token not found for chain ${origin}`;
      this.logger.error(error);
      throw new Error(error);
    }

    const amountNum = Number(amount);
    assert(!isNaN(amountNum), 'Amount must be a valid number');
    assert(amountNum > 0, 'Amount must be greater than 0');

    // getPartiallyFulfilledInventoryIntents omits intents blocked by a
    // non-stale in-flight movement, so also check in-progress intents directly
    const [partialIntents, inProgressIntents] = await Promise.all([
      this.actionTracker.getPartiallyFulfilledInventoryIntents(),
      this.actionTracker.getActiveRebalanceIntents(),
    ]);
    const blockingIntentId =
      partialIntents[0]?.intent.id ??
      inProgressIntents.find((intent) => intent.executionMethod === 'inventory')
        ?.id;
    assert(
      !blockingIntentId,
      `Cannot start manual inventory rebalance while intent ${blockingIntentId} is active`,
    );

    const route: InventoryRoute = {
      origin,
      destination,
      amount: normalizeConfiguredAmount(amount, originToken),
      executionType: 'inventory',
      externalBridge,
    };
    const deadline = Date.now() + timeoutMs;
    let cycle = 0;
    let firstCycle = true;
    let intentId: string | undefined;

    while (true) {
      cycle += 1;
      const inventoryBalances = await fetchInventoryBalances(
        warpCore,
        this.inventoryMonitorConfig,
        this.logger,
      );
      this.inventoryRebalancer.setInventoryBalances(inventoryBalances);

      await this.actionTracker.syncInventoryMovementActions(
        this.externalBridgeRegistry,
      );
      await this.actionTracker.syncRebalanceActions();
      await this.actionTracker.syncRebalanceIntents();

      const intent = intentId
        ? await this.actionTracker.getRebalanceIntent(intentId)
        : undefined;
      this.logger.info(
        {
          cycle,
          intentId,
          intentStatus: intent?.status ?? 'not_created',
          origin,
          originInventory: (inventoryBalances[origin] ?? 0n).toString(),
          destination,
          destinationInventory: (
            inventoryBalances[destination] ?? 0n
          ).toString(),
        },
        'Manual inventory rebalance polling cycle',
      );

      if (intentId && (await this.checkManualInventoryTerminal(intentId))) {
        return;
      }

      if (Date.now() >= deadline) {
        await this.actionTracker.logStoreContents();
        throw new Error(
          'Manual inventory rebalance timed out. In-flight external bridge transfers cannot be cancelled and will settle at the destination inventory address; in-flight transferRemote deposits are delivered by the relayer regardless. Check the destination inventory balance before re-running to avoid double-bridging.',
        );
      }

      const wasFirstCycle = firstCycle;
      const results = await this.inventoryRebalancer.rebalance(
        firstCycle ? [route] : [],
      );
      firstCycle = false;

      const result = results[0];
      if (result) {
        intentId ??= result.intentId;
        if (!result.success && wasFirstCycle) {
          if (intentId) {
            await this.actionTracker.cancelRebalanceIntent(intentId);
          }
          throw new Error(
            `Manual inventory rebalance dispatch failed: ${result.error ?? 'unknown error'}`,
          );
        }
        if (!result.success) {
          this.logger.warn(
            { cycle, intentId, error: result.error },
            'Manual inventory rebalance cycle failed; continuing to poll',
          );
        }
      }

      if (intentId && (await this.checkManualInventoryTerminal(intentId))) {
        return;
      }

      await sleep(pollIntervalMs);
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
