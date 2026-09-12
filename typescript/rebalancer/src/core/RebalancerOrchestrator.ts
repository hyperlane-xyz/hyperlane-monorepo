import { Logger } from 'pino';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { getStrategyChainNames } from '../config/types.js';
import type { ExternalBridgeRegistry } from '../interfaces/IExternalBridge.js';
import {
  type ConfirmedBlockTags,
  type MonitorEvent,
} from '../interfaces/IMonitor.js';
import type {
  ExecutionResult,
  IRebalancer,
  RebalancerType,
} from '../interfaces/IRebalancer.js';
import type { IStrategy, StrategyRoute } from '../interfaces/IStrategy.js';
import {
  isInventoryRoute,
  isMovableCollateralRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import { InflightContextAdapter } from '../tracking/InflightContextAdapter.js';
import { getRawBalances } from '../utils/balanceUtils.js';

import { InventoryRebalancer } from './InventoryRebalancer.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type TrackerSyncSource =
  | 'transfers'
  | 'rebalanceIntents'
  | 'rebalanceActions'
  | 'inventoryMovementActions';

export interface TrackerSyncResult {
  freshSources: TrackerSyncSource[];
  staleSources: TrackerSyncSource[];
}

type TrackerSyncStep = {
  source: TrackerSyncSource;
  run: () => Promise<unknown>;
};

/**
 * Result of a rebalancing cycle.
 * Includes results from every configured execution type.
 */
export interface CycleResult {
  status: 'success' | 'partial' | 'failed';
  balances: Record<string, bigint>;
  proposedRoutes: StrategyRoute[];
  executionResults: ExecutionResult[];
  executedCount: number;
  failedCount: number;
  trackerSync: TrackerSyncResult;
  errors: string[];
}

export interface RebalancerOrchestratorDeps {
  strategy: IStrategy;
  actionTracker: IActionTracker;
  inflightContextAdapter: InflightContextAdapter;
  rebalancerConfig: RebalancerConfig;
  logger: Logger;

  rebalancers: IRebalancer[];

  externalBridgeRegistry?: Partial<ExternalBridgeRegistry>;
  metrics?: Metrics;
}

export class RebalancerOrchestrator {
  private readonly strategy: IStrategy;
  private readonly actionTracker: IActionTracker;
  private readonly inflightContextAdapter: InflightContextAdapter;
  private readonly rebalancerConfig: RebalancerConfig;
  private readonly logger: Logger;
  private readonly rebalancersByType: Map<RebalancerType, IRebalancer>;
  private readonly externalBridgeRegistry?: Partial<ExternalBridgeRegistry>;
  private readonly metrics?: Metrics;

  constructor(deps: RebalancerOrchestratorDeps) {
    this.strategy = deps.strategy;
    this.actionTracker = deps.actionTracker;
    this.inflightContextAdapter = deps.inflightContextAdapter;
    this.rebalancerConfig = deps.rebalancerConfig;
    this.logger = deps.logger;
    this.rebalancersByType = new Map(
      deps.rebalancers.map((r) => [r.rebalancerType, r]),
    );
    this.externalBridgeRegistry = deps.externalBridgeRegistry;
    this.metrics = deps.metrics;
  }

  /**
   * Execute a single rebalancing cycle.
   * Processes monitor event, evaluates strategy, and executes routes.
   */
  async executeCycle(event: MonitorEvent): Promise<CycleResult> {
    this.logger.info('Polling cycle started');

    const { metrics } = this;
    if (metrics) {
      await Promise.all(
        event.tokensInfo.map((tokenInfo) => metrics.processToken(tokenInfo)),
      );
    }

    const trackerSync = await this.syncActionTracker(event.confirmedBlockTags);

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

    const errors = trackerSync.staleSources.map(
      (source) => `ActionTracker ${source} sync failed`,
    );
    if (errors.length > 0) {
      this.logger.error(
        { staleSources: trackerSync.staleSources },
        'Skipping rebalancing because tracker state is stale',
      );
      return {
        status: 'failed',
        balances: rawBalances,
        proposedRoutes: [],
        executionResults: [],
        executedCount: 0,
        failedCount: 0,
        trackerSync,
        errors,
      };
    }

    // Get inflight context for strategy decision-making
    const inflightContext = await this.getInflightContext();

    const strategyRoutes = this.strategy.getRebalancingRoutes(
      rawBalances,
      inflightContext,
    );

    let executionResults: ExecutionResult[] = [];

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

      const results = await this.executeWithTracking(strategyRoutes, event);
      executionResults = results;
    } else {
      this.logger.info('No rebalancing needed');
    }

    const inventoryRebalancer = this.rebalancersByType.get('inventory');
    if (inventoryRebalancer && strategyRoutes.length === 0) {
      try {
        executionResults = await this.executeRoutes(
          [],
          inventoryRebalancer,
          event,
        );
      } catch (error) {
        errors.push(`Inventory continuation failed: ${errorMessage(error)}`);
      }
    }

    const executedCount = executionResults.filter(
      (result) => result.success,
    ).length;
    const failedCount = executionResults.length - executedCount;
    const status =
      errors.length > 0
        ? 'failed'
        : failedCount === 0
          ? 'success'
          : executedCount === 0
            ? 'failed'
            : 'partial';

    this.logger.info('Polling cycle completed');

    return {
      status,
      balances: rawBalances,
      proposedRoutes: strategyRoutes,
      executionResults,
      executedCount,
      failedCount,
      trackerSync,
      errors,
    };
  }

  /**
   * Sync action tracker with current chain state.
   */
  private async syncActionTracker(
    confirmedBlockTags?: ConfirmedBlockTags,
  ): Promise<TrackerSyncResult> {
    const syncSteps: TrackerSyncStep[] = [
      {
        source: 'transfers',
        run: () => this.actionTracker.syncTransfers(confirmedBlockTags),
      },
      {
        source: 'rebalanceIntents',
        run: () => this.actionTracker.syncRebalanceIntents(),
      },
      {
        source: 'rebalanceActions',
        run: () => this.actionTracker.syncRebalanceActions(confirmedBlockTags),
      },
    ];
    const externalBridgeRegistry = this.externalBridgeRegistry;
    if (externalBridgeRegistry) {
      syncSteps.push({
        source: 'inventoryMovementActions',
        run: () =>
          this.actionTracker.syncInventoryMovementActions(
            externalBridgeRegistry,
          ),
      });
    }

    const results = await Promise.allSettled(
      syncSteps.map(({ run }) => Promise.resolve().then(run)),
    );
    const trackerSync: TrackerSyncResult = {
      freshSources: [],
      staleSources: [],
    };

    results.forEach((result, index) => {
      const source = syncSteps[index].source;
      if (result.status === 'fulfilled') {
        trackerSync.freshSources.push(source);
      } else {
        trackerSync.staleSources.push(source);
        this.logger.warn(
          { source, error: errorMessage(result.reason) },
          'ActionTracker sync source failed, using stale data',
        );
      }
    });

    try {
      await this.actionTracker.logStoreContents();
    } catch (error) {
      this.logger.warn({ error }, 'Failed to log ActionTracker store contents');
    }

    this.logger.info(trackerSync, 'ActionTracker sync freshness');
    return trackerSync;
  }

  /**
   * Get inflight context for strategy decision-making
   */
  private async getInflightContext() {
    return this.inflightContextAdapter.getInflightContext();
  }

  private async executeWithTracking(
    routes: StrategyRoute[],
    event: MonitorEvent,
  ): Promise<ExecutionResult[]> {
    const movableCollateral = routes.filter(isMovableCollateralRoute);
    const inventory = routes.filter(isInventoryRoute);

    const executionResults: ExecutionResult[] = [];

    const movableCollateralRebalancer =
      this.rebalancersByType.get('movableCollateral');
    if (movableCollateral.length > 0 && movableCollateralRebalancer) {
      const results = await this.executeRoutes(
        movableCollateral,
        movableCollateralRebalancer,
        event,
      );
      executionResults.push(...results);
    } else if (movableCollateral.length > 0) {
      executionResults.push(
        ...this.missingRebalancerResults(
          movableCollateral,
          'movableCollateral',
        ),
      );
    }

    const inventoryRebalancer = this.rebalancersByType.get('inventory');
    if (inventory.length > 0 && inventoryRebalancer) {
      executionResults.push(
        ...(await this.executeRoutes(inventory, inventoryRebalancer, event)),
      );
    } else if (inventory.length > 0) {
      executionResults.push(
        ...this.missingRebalancerResults(inventory, 'inventory'),
      );
    }

    return executionResults;
  }

  private async executeRoutes(
    routes: StrategyRoute[],
    rebalancer: IRebalancer,
    event: MonitorEvent,
  ): Promise<ExecutionResult[]> {
    if (rebalancer.rebalancerType === 'inventory' && event.inventoryBalances) {
      (rebalancer as InventoryRebalancer).setInventoryBalances(
        event.inventoryBalances,
      );
    }

    try {
      const results = await rebalancer.rebalance(routes);

      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      if (successful.length > 0) {
        if (rebalancer.rebalancerType === 'movableCollateral') {
          this.metrics?.recordRebalancerSuccess();
        }
        this.logger.info(
          { count: successful.length, type: rebalancer.rebalancerType },
          'Rebalancer completed successfully',
        );
      }

      if (failed.length > 0) {
        if (rebalancer.rebalancerType === 'movableCollateral') {
          this.metrics?.recordRebalancerFailure();
        }
        this.logger.warn(
          {
            count: failed.length,
            type: rebalancer.rebalancerType,
            errors: failed.map((r) => ({
              route: `${r.route.origin} -> ${r.route.destination}`,
              error: r.error,
            })),
          },
          'Some routes failed',
        );
      }

      return results;
    } catch (error: unknown) {
      if (rebalancer.rebalancerType === 'movableCollateral') {
        this.metrics?.recordRebalancerFailure();
      }
      this.logger.error(
        { error, type: rebalancer.rebalancerType },
        'Error while executing routes',
      );
      if (routes.length === 0) throw error;
      const message = errorMessage(error);
      return routes.map((route) => ({
        route,
        success: false,
        error: message,
        reason: 'executor_error',
      }));
    }
  }

  private missingRebalancerResults(
    routes: StrategyRoute[],
    rebalancerType: RebalancerType,
  ): ExecutionResult[] {
    const error = `No ${rebalancerType} rebalancer configured`;
    this.logger.error({ rebalancerType, count: routes.length }, error);
    return routes.map((route) => ({
      route,
      success: false,
      error,
      reason: 'missing_rebalancer',
    }));
  }
}
