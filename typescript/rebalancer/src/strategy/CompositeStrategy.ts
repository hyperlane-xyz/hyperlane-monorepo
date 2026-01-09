import { Logger } from 'pino';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

/**
 * Composite strategy that runs multiple sub-strategies sequentially.
 *
 * Key behavior: Routes from earlier strategies are passed as pendingRebalances
 * to later strategies, allowing coordination between strategies.
 *
 * Requires at least 2 sub-strategies.
 */
export class CompositeStrategy implements IStrategy {
  readonly name = 'composite';
  protected readonly logger: Logger;

  constructor(
    private readonly strategies: IStrategy[],
    logger: Logger,
  ) {
    if (strategies.length < 2) {
      throw new Error('CompositeStrategy requires at least 2 sub-strategies');
    }
    this.logger = logger.child({ class: CompositeStrategy.name });
    this.logger.info(
      {
        strategyCount: strategies.length,
        strategies: strategies.map((s) => s.name),
      },
      'CompositeStrategy created',
    );
  }

  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[] {
    const allRoutes: RebalancingRoute[] = [];

    // Start with original pending rebalances
    let accumulatedPendingRebalances = [
      ...(inflightContext?.pendingRebalances ?? []),
    ];

    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];

      // Build context with accumulated routes from previous strategies
      const contextForStrategy: InflightContext = {
        pendingTransfers: inflightContext?.pendingTransfers ?? [],
        pendingRebalances: accumulatedPendingRebalances,
      };

      this.logger.debug(
        {
          strategyIndex: i,
          strategyName: strategy.name,
          pendingRebalancesCount: accumulatedPendingRebalances.length,
        },
        'Running sub-strategy',
      );

      const routes = strategy.getRebalancingRoutes(
        rawBalances,
        contextForStrategy,
      );

      this.logger.debug(
        {
          strategyIndex: i,
          strategyName: strategy.name,
          routeCount: routes.length,
        },
        'Sub-strategy returned routes',
      );

      // Add routes to accumulated for next strategy
      accumulatedPendingRebalances = [
        ...accumulatedPendingRebalances,
        ...routes,
      ];

      // Add to final result
      allRoutes.push(...routes);
    }

    this.logger.info(
      { totalRoutes: allRoutes.length },
      'CompositeStrategy merged routes from all sub-strategies',
    );

    return allRoutes;
  }
}
