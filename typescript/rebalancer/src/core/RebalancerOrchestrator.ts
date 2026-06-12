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

type ActionTrackerSyncStep = {
  name: string;
  run: () => Promise<unknown>;
};

const METRICS_PROCESS_TOKEN_TIMEOUT_MS = 30_000;

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

    this.processMetricsBestEffort(event);

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

      const results = await this.executeWithTracking(strategyRoutes, event);
      executedCount = results.executedCount;
      failedCount = results.failedCount;
    } else {
      this.logger.info('No rebalancing needed');
    }

    const inventoryRebalancer = this.rebalancersByType.get('inventory');
    if (inventoryRebalancer && strategyRoutes.length === 0) {
      await this.executeRoutes([], inventoryRebalancer, event);
    }

    this.logger.info('Polling cycle completed');

    return {
      balances: rawBalances,
      proposedRoutes: strategyRoutes,
      executedCount,
      failedCount,
    };
  }

  private processMetricsBestEffort(event: MonitorEvent): void {
    const { metrics } = this;
    if (!metrics) return;

    void Promise.allSettled(
      event.tokensInfo.map((tokenInfo) =>
        this.processTokenMetricsWithTimeout(() =>
          metrics.processToken(tokenInfo),
        ),
      ),
    ).then((results) => {
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length === 0) return;

      this.logger.warn(
        {
          count: failed.length,
          errors: failed.map((result) => errorMessage(result.reason)),
        },
        'Metrics token processing failed',
      );
    });
  }

  private async processTokenMetricsWithTimeout(
    processToken: () => Promise<void>,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        processToken(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Metrics token processing timed out after ${METRICS_PROCESS_TOKEN_TIMEOUT_MS}ms`,
                ),
              ),
            METRICS_PROCESS_TOKEN_TIMEOUT_MS,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * Sync action tracker with current chain state.
   */
  private async syncActionTracker(
    confirmedBlockTags?: ConfirmedBlockTags,
  ): Promise<void> {
    const syncSteps: ActionTrackerSyncStep[] = [
      {
        name: 'transfers',
        run: () => this.actionTracker.syncTransfers(confirmedBlockTags),
      },
      {
        name: 'rebalanceIntents',
        run: () => this.actionTracker.syncRebalanceIntents(),
      },
      {
        name: 'rebalanceActions',
        run: () => this.actionTracker.syncRebalanceActions(confirmedBlockTags),
      },
    ];

    const externalBridgeRegistry = this.externalBridgeRegistry;
    if (externalBridgeRegistry) {
      syncSteps.push({
        name: 'inventoryMovementActions',
        run: () =>
          this.actionTracker.syncInventoryMovementActions(
            externalBridgeRegistry,
          ),
      });
    }

    const results = await Promise.allSettled(
      syncSteps.map((step) => Promise.resolve().then(() => step.run())),
    );

    const freshSources: string[] = [];
    const staleSources: string[] = [];

    results.forEach((result, index) => {
      const { name } = syncSteps[index];
      if (result.status === 'fulfilled') {
        freshSources.push(name);
        return;
      }

      staleSources.push(name);
      this.logger.warn(
        { source: name, error: errorMessage(result.reason) },
        'ActionTracker sync source failed, using stale data',
      );
    });

    this.logger.info(
      { freshSources, staleSources },
      'ActionTracker sync freshness',
    );

    try {
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

  private async executeWithTracking(
    routes: StrategyRoute[],
    event: MonitorEvent,
  ): Promise<{ executedCount: number; failedCount: number }> {
    const movableCollateral = routes.filter(isMovableCollateralRoute);
    const inventory = routes.filter(isInventoryRoute);

    let executedCount = 0;
    let failedCount = 0;

    const movableCollateralRebalancer =
      this.rebalancersByType.get('movableCollateral');
    if (movableCollateral.length > 0 && movableCollateralRebalancer) {
      const results = await this.executeRoutes(
        movableCollateral,
        movableCollateralRebalancer,
        event,
      );
      executedCount = results.filter((r) => r.success).length;
      failedCount = results.filter((r) => !r.success).length;
    }

    const inventoryRebalancer = this.rebalancersByType.get('inventory');
    if (inventory.length > 0 && inventoryRebalancer) {
      await this.executeRoutes(inventory, inventoryRebalancer, event);
    }

    return { executedCount, failedCount };
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
      const errorMessageString = errorMessage(error);
      this.logger.error(
        { error, type: rebalancer.rebalancerType },
        'Error while executing routes',
      );
      return routes.map((route) => ({
        route,
        success: false,
        error: errorMessageString,
        reason: 'executor_error',
      }));
    }
  }
}
