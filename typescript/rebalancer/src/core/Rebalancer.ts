import { type Logger } from 'pino';

import {
  type ChainMap,
  type ChainMetadata,
  type MultiProvider,
  type Token,
  type WarpCore,
} from '@hyperlane-xyz/sdk';

import type {
  IMovableCollateralRebalancer,
  MovableCollateralExecutionResult,
  RebalancerType,
} from '../interfaces/IRebalancer.js';
import { MovableCollateralRoute } from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../tracking/types.js';
import { denormalizeToLocal } from '../utils/balanceUtils.js';
import { MovableChainTransactionExecutor } from './movable/ChainTransactionExecutor.js';
import { MovableResultRecorder } from './movable/ResultRecorder.js';
import { MovableRouteValidator } from './movable/RouteValidator.js';
import { MovableTransactionPreparer } from './movable/TransactionPreparer.js';
import type {
  MovableInternalExecutionResult,
  MovableInternalRoute,
} from './movable/types.js';

export class Rebalancer implements IMovableCollateralRebalancer {
  public readonly rebalancerType: RebalancerType = 'movableCollateral';
  private readonly logger: Logger;
  private readonly transactionPreparer: MovableTransactionPreparer;
  private readonly transactionExecutor: MovableChainTransactionExecutor;
  private readonly resultRecorder: MovableResultRecorder;

  constructor(
    private readonly warpCore: WarpCore,
    private readonly chainMetadata: ChainMap<ChainMetadata>,
    private readonly tokensByChainName: ChainMap<Token>,
    private readonly multiProvider: MultiProvider,
    private readonly actionTracker: IActionTracker,
    logger: Logger,
    private readonly metrics?: Metrics,
  ) {
    this.logger = logger.child({ class: Rebalancer.name });

    const routeValidator = new MovableRouteValidator(
      this.warpCore,
      this.chainMetadata,
      this.tokensByChainName,
      this.multiProvider,
      this.logger,
    );
    this.transactionPreparer = new MovableTransactionPreparer(
      this.warpCore,
      this.chainMetadata,
      this.tokensByChainName,
      routeValidator,
      this.logger,
    );
    this.resultRecorder = new MovableResultRecorder(
      this.multiProvider,
      this.actionTracker,
      this.logger,
    );
    this.transactionExecutor = new MovableChainTransactionExecutor(
      this.multiProvider,
      this.resultRecorder,
      this.logger,
      this.metrics,
    );
  }

  async rebalance(
    routes: MovableCollateralRoute[],
  ): Promise<MovableCollateralExecutionResult[]> {
    if (routes.length === 0) {
      this.logger.info('No routes to execute, exiting');
      return [];
    }

    this.logger.info({ numberOfRoutes: routes.length }, 'Rebalance initiated');

    const invalidRoutes = routes.filter((r) => !r.bridge);
    if (invalidRoutes.length > 0) {
      this.logger.error(
        { count: invalidRoutes.length },
        'Routes missing required bridge address',
      );
      return routes.map((r) => ({
        route: r,
        success: false,
        error: r.bridge ? undefined : 'Missing required bridge address',
        messageId: '',
      }));
    }

    const intents = await this.createIntents(routes);

    const internalRoutes: MovableInternalRoute[] = routes.map((route, idx) => ({
      ...route,
      intentId: intents[idx].id,
    }));

    const { preparedTransactions, preparationFailureResults } =
      await this.transactionPreparer.prepareTransactions(internalRoutes);

    let executionResults: MovableInternalExecutionResult[] = [];

    if (preparedTransactions.length > 0) {
      executionResults =
        await this.transactionExecutor.executeTransactions(
          preparedTransactions,
        );
    }

    const allInternalResults = [
      ...preparationFailureResults,
      ...executionResults,
    ];

    await this.resultRecorder.recordResults(allInternalResults);
    this.recordMetrics(allInternalResults);
    this.logSummary(allInternalResults, routes.length);

    return this.resultRecorder.toPublicResults(allInternalResults);
  }

  private async createIntents(
    routes: MovableCollateralRoute[],
  ): Promise<RebalanceIntent[]> {
    return Promise.all(
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
  }

  private recordMetrics(results: MovableInternalExecutionResult[]): void {
    const successfulResults = results.filter((r) => r.success);
    if (!this.metrics || successfulResults.length === 0) {
      return;
    }

    for (const result of successfulResults) {
      const token = this.tokensByChainName[result.route.origin];
      if (token) {
        this.metrics.recordRebalanceAmount(
          result.route,
          token.amount(
            result.localAmount ??
              denormalizeToLocal(result.route.amount, token),
          ),
        );
      }
    }
  }

  private logSummary(
    results: MovableInternalExecutionResult[],
    totalRoutes: number,
  ): void {
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      this.logger.error(
        { failureCount: failures.length, totalRoutes },
        'Some rebalance operations failed.',
      );
    } else {
      this.logger.info('Rebalance successful');
    }
  }
}
