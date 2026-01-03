import type { Logger } from 'pino';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

/**
 * CompositeStrategy executes a sequence of strategies and combines their routes.
 *
 * This allows composing multiple strategies together, for example:
 * - CollateralDeficitStrategy (fast bridge) → WeightedStrategy (standard bridge)
 *
 * Each strategy sees the pending rebalances from previous strategies in the chain,
 * allowing later strategies to avoid proposing redundant routes.
 *
 * Key behaviors:
 * - Strategies are executed in order
 * - Routes from earlier strategies are added to pendingRebalances for later strategies
 * - All routes are combined and returned as the final result
 */
export class CompositeStrategy implements IStrategy {
  private readonly strategies: IStrategy[];
  private readonly logger: Logger;

  constructor(strategies: IStrategy[], logger: Logger) {
    if (strategies.length === 0) {
      throw new Error('CompositeStrategy requires at least one sub-strategy');
    }

    this.strategies = strategies;
    this.logger = logger.child({ class: CompositeStrategy.name });
    this.logger.info(
      { strategyCount: strategies.length },
      'CompositeStrategy created',
    );
  }

  /**
   * Get rebalancing routes by executing all strategies in sequence.
   *
   * Routes from earlier strategies are passed as pendingRebalances to
   * later strategies, allowing them to make informed decisions.
   */
  getRebalancingRoutes(
    rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[] {
    const allRoutes: RebalancingRoute[] = [];

    // Start with the provided inflight context or empty
    let currentContext: InflightContext = {
      pendingTransfers: inflightContext?.pendingTransfers ?? [],
      pendingRebalances: inflightContext?.pendingRebalances ?? [],
    };

    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];
      const strategyName = strategy.constructor.name;

      this.logger.debug(
        {
          strategyIndex: i,
          strategyName,
          pendingRebalancesCount: currentContext.pendingRebalances.length,
        },
        'Executing strategy in composition',
      );

      // Execute the strategy with current context
      const routes = strategy.getRebalancingRoutes(rawBalances, currentContext);

      this.logger.debug(
        {
          strategyIndex: i,
          strategyName,
          routesCount: routes.length,
        },
        'Strategy produced routes',
      );

      // Add routes to the result
      allRoutes.push(...routes);

      // Add these routes to pendingRebalances for the next strategy
      currentContext = {
        pendingTransfers: currentContext.pendingTransfers,
        pendingRebalances: [...currentContext.pendingRebalances, ...routes],
      };
    }

    this.logger.info(
      {
        totalRoutes: allRoutes.length,
        strategiesExecuted: this.strategies.length,
      },
      'CompositeStrategy completed',
    );

    return allRoutes;
  }
}
