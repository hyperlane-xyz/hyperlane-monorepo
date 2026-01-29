import { Logger } from 'pino';

import { type MultiProvider } from '@hyperlane-xyz/sdk';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { getStrategyChainNames } from '../config/types.js';
import { type MonitorEvent } from '../interfaces/IMonitor.js';
import type { IRebalancer } from '../interfaces/IRebalancer.js';
import type { IStrategy, StrategyRoute } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import {
  type IActionTracker,
  InflightContextAdapter,
} from '../tracking/index.js';
import { getRawBalances } from '../utils/balanceUtils.js';

export interface CycleResult {
  balances: Record<string, bigint>;
  proposedRoutes: StrategyRoute[];
  executedCount: number;
  failedCount: number;
}

export interface RebalancerOrchestratorDeps {
  strategy: IStrategy;
  rebalancer: IRebalancer | undefined;
  actionTracker: IActionTracker;
  inflightContextAdapter: InflightContextAdapter;
  multiProvider: MultiProvider;
  rebalancerConfig: RebalancerConfig;
  logger: Logger;
  metrics?: Metrics;
}

export class RebalancerOrchestrator {
  private readonly strategy: IStrategy;
  private readonly rebalancer: IRebalancer | undefined;
  private readonly actionTracker: IActionTracker;
  private readonly inflightContextAdapter: InflightContextAdapter;
  private readonly multiProvider: MultiProvider;
  private readonly rebalancerConfig: RebalancerConfig;
  private readonly logger: Logger;
  private readonly metrics?: Metrics;

  constructor(deps: RebalancerOrchestratorDeps) {
    this.strategy = deps.strategy;
    this.rebalancer = deps.rebalancer;
    this.actionTracker = deps.actionTracker;
    this.inflightContextAdapter = deps.inflightContextAdapter;
    this.multiProvider = deps.multiProvider;
    this.rebalancerConfig = deps.rebalancerConfig;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
  }

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

      if (this.rebalancer) {
        const results = await this.executeWithTracking(strategyRoutes);
        executedCount = results.filter((r) => r.success).length;
        failedCount = results.filter((r) => !r.success).length;
      }
    } else {
      this.logger.info('No rebalancing needed');
    }

    this.logger.info('Polling cycle completed');

    return {
      balances: rawBalances,
      proposedRoutes: strategyRoutes,
      executedCount,
      failedCount,
    };
  }

  private async syncActionTracker(
    confirmedBlockTags: MonitorEvent['confirmedBlockTags'],
  ): Promise<void> {
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

  private async getInflightContext() {
    return this.inflightContextAdapter.getInflightContext();
  }

  private async executeWithTracking(strategyRoutes: StrategyRoute[]) {
    if (!this.rebalancer) {
      this.logger.warn('Rebalancer not available, skipping execution');
      return [];
    }

    const rebalanceRoutes: Array<StrategyRoute & { intentId: string }> = [];
    const intentIds: string[] = [];

    for (const route of strategyRoutes) {
      const intent = await this.actionTracker.createRebalanceIntent({
        origin: this.multiProvider.getDomainId(route.origin),
        destination: this.multiProvider.getDomainId(route.destination),
        amount: route.amount,
        bridge: route.bridge,
      });
      intentIds.push(intent.id);
      rebalanceRoutes.push({
        ...route,
        intentId: intent.id,
      });
    }

    this.logger.debug(
      { intentCount: rebalanceRoutes.length },
      'Created rebalance intents',
    );

    let results;
    try {
      results = await this.rebalancer.rebalance(rebalanceRoutes);
      const failedResults = results.filter((r) => !r.success);
      if (failedResults.length > 0) {
        this.metrics?.recordRebalancerFailure();
        this.logger.warn(
          { failureCount: failedResults.length, total: results.length },
          'Rebalancer cycle completed with failures',
        );
      } else {
        this.metrics?.recordRebalancerSuccess();
        this.logger.info('Rebalancer completed a cycle successfully');
      }
    } catch (error) {
      this.metrics?.recordRebalancerFailure();
      this.logger.error({ error }, 'Error while rebalancing');
      await Promise.all(
        intentIds.map((id) => this.actionTracker.failRebalanceIntent(id)),
      );
      return [];
    }

    await this.processExecutionResults(results);
    return results;
  }

  private async processExecutionResults(
    results: Awaited<ReturnType<IRebalancer['rebalance']>>,
  ): Promise<void> {
    for (const result of results) {
      const intentId = (result.route as StrategyRoute & { intentId: string })
        .intentId;
      if (result.success && result.messageId) {
        await this.actionTracker.createRebalanceAction({
          intentId,
          origin: this.multiProvider.getDomainId(result.route.origin),
          destination: this.multiProvider.getDomainId(result.route.destination),
          amount: result.route.amount,
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
