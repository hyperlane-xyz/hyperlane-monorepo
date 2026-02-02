import { Logger } from 'pino';

import { type MultiProvider } from '@hyperlane-xyz/sdk';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import {
  ExecutionType,
  getChainExecutionType,
  getStrategyChainNames,
} from '../config/types.js';
import type { IExternalBridge } from '../interfaces/IExternalBridge.js';
import type { IInventoryMonitor } from '../interfaces/IInventoryMonitor.js';
import type { IInventoryRebalancer } from '../interfaces/IInventoryRebalancer.js';
import {
  type ConfirmedBlockTags,
  type MonitorEvent,
} from '../interfaces/IMonitor.js';
import type {
  IRebalancer,
  RebalanceExecutionResult,
  RebalanceRoute,
} from '../interfaces/IRebalancer.js';
import type {
  IStrategy,
  Route,
  StrategyRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import {
  type IActionTracker,
  InflightContextAdapter,
} from '../tracking/index.js';
import { getRawBalances } from '../utils/balanceUtils.js';

/**
 * Result of a rebalancing cycle.
 * executedCount/failedCount: Counts from movable_collateral execution ONLY
 */
export interface CycleResult {
  balances: Record<string, bigint>;
  proposedRoutes: StrategyRoute[];
  executedCount: number;
  failedCount: number;
}

/**
 * Dependency injection interface - ALL deps required for BOTH execution types
 */
export interface RebalancerOrchestratorDeps {
  // Core deps (required)
  strategy: IStrategy;
  actionTracker: IActionTracker;
  inflightContextAdapter: InflightContextAdapter;
  multiProvider: MultiProvider;
  rebalancerConfig: RebalancerConfig;
  logger: Logger;

  // Movable collateral deps (optional - undefined in monitorOnly mode)
  rebalancer?: IRebalancer;

  // Inventory deps (optional - undefined if no inventory chains configured)
  inventoryRebalancer?: IInventoryRebalancer;
  inventoryMonitor?: IInventoryMonitor;
  bridge?: IExternalBridge;

  // Metrics (optional)
  metrics?: Metrics;
}

/**
 * RebalancerOrchestrator handles the execution of rebalancing cycles.
 * It coordinates strategy evaluation and execution for both movable_collateral
 * and inventory execution types.
 */
export class RebalancerOrchestrator {
  private readonly strategy: IStrategy;
  private readonly actionTracker: IActionTracker;
  private readonly inflightContextAdapter: InflightContextAdapter;
  private readonly multiProvider: MultiProvider;
  private readonly rebalancerConfig: RebalancerConfig;
  private readonly logger: Logger;
  private readonly rebalancer?: IRebalancer;
  private readonly inventoryRebalancer?: IInventoryRebalancer;
  private readonly inventoryMonitor?: IInventoryMonitor;
  private readonly bridge?: IExternalBridge;
  private readonly metrics?: Metrics;

  constructor(deps: RebalancerOrchestratorDeps) {
    this.strategy = deps.strategy;
    this.actionTracker = deps.actionTracker;
    this.inflightContextAdapter = deps.inflightContextAdapter;
    this.multiProvider = deps.multiProvider;
    this.rebalancerConfig = deps.rebalancerConfig;
    this.logger = deps.logger;
    this.rebalancer = deps.rebalancer;
    this.inventoryRebalancer = deps.inventoryRebalancer;
    this.inventoryMonitor = deps.inventoryMonitor;
    this.bridge = deps.bridge;
    this.metrics = deps.metrics;
  }

  /**
   * Execute a single rebalancing cycle.
   * Processes monitor event, evaluates strategy, and executes routes.
   */
  async executeCycle(event: MonitorEvent): Promise<CycleResult> {
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

    const strategyRoutes = this.strategy.getRebalancingRoutes(
      rawBalances,
      inflightContext,
    );

    let executedCount = 0;
    let failedCount = 0;

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

      const results = await this.executeWithTracking(strategyRoutes);
      executedCount = results.executedCount;
      failedCount = results.failedCount;
    } else {
      this.logger.info('No rebalancing needed');
    }

    // CRITICAL: Always check for existing inventory intents to continue,
    // even when no new routes proposed. This handles the case where the
    // bridge completed but the transferRemote hasn't been sent yet.
    if (this.inventoryRebalancer && strategyRoutes.length === 0) {
      await this.executeInventoryRoutes([]);
    }

    this.logger.info('Polling cycle completed');

    return {
      balances: rawBalances,
      proposedRoutes: strategyRoutes,
      executedCount,
      failedCount,
    };
  }

  /**
   * Sync action tracker with current chain state.
   */
  private async syncActionTracker(
    confirmedBlockTags?: ConfirmedBlockTags,
  ): Promise<void> {
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
  private async getInflightContext() {
    return this.inflightContextAdapter.getInflightContext();
  }

  /**
   * Execute rebalancing with intent tracking.
   * Creates intents before execution, processes results after.
   *
   * Routes are classified by execution type:
   * - movableCollateral: Uses existing Rebalancer (on-chain rebalance)
   * - inventory: Uses InventoryRebalancer (external bridge + transferRemote)
   *
   * Returns counts for movable_collateral routes only.
   */
  private async executeWithTracking(
    routes: StrategyRoute[],
  ): Promise<{ executedCount: number; failedCount: number }> {
    // Classify routes by execution method
    const { movableCollateral, inventory } = this.classifyRoutes(routes);

    let executedCount = 0;
    let failedCount = 0;

    // Execute movable collateral routes (existing flow)
    if (movableCollateral.length > 0 && this.rebalancer) {
      const results =
        await this.executeMovableCollateralRoutes(movableCollateral);
      executedCount = results.filter((r) => r.success).length;
      failedCount = results.filter((r) => !r.success).length;
    }

    // Execute inventory routes (new inventory flow)
    if (inventory.length > 0 && this.inventoryRebalancer) {
      await this.executeInventoryRoutes(inventory);
    }

    return { executedCount, failedCount };
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
   * Returns the execution results.
   */
  private async executeMovableCollateralRoutes(
    routes: StrategyRoute[],
  ): Promise<RebalanceExecutionResult[]> {
    if (!this.rebalancer) return [];

    // 1. Create intents for each route BEFORE execution
    const intents = await Promise.all(
      routes.map((route) =>
        this.actionTracker.createRebalanceIntent({
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
          this.actionTracker.failRebalanceIntent(intent.id),
        ),
      );
      return [];
    }

    // 4. Process results - results have IDs that match intents directly
    await this.processExecutionResults(results);
    return results;
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

    const inventoryRoutes: Route[] = routes.map((r) => ({
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
              route: `${r.route.origin} -> ${r.route.destination}`,
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
        await this.actionTracker.createRebalanceAction({
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
        await this.actionTracker.failRebalanceIntent(intentId);

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
}
