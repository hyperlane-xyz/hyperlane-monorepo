import { Logger } from 'pino';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  StrategyRoute,
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
  ): StrategyRoute[] {
    const allRoutes: StrategyRoute[] = [];

    // Track routes from earlier strategies in this cycle as proposedRebalances
    // These are NOT yet executed, so strategies need to simulate both origin and destination
    let accumulatedProposedRebalances: StrategyRoute[] = [];

    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];

      // Build context with:
      // - pendingRebalances: actual in-flight intents (origin tx confirmed, passed through from caller)
      // - proposedRebalances: routes from earlier strategies in THIS cycle (not yet executed)
      const contextForStrategy: InflightContext = {
        pendingTransfers: inflightContext?.pendingTransfers ?? [],
        pendingRebalances: inflightContext?.pendingRebalances ?? [],
        proposedRebalances: accumulatedProposedRebalances,
      };

      this.logger.debug(
        {
          strategyIndex: i,
          strategyName: strategy.name,
          pendingRebalancesCount: contextForStrategy.pendingRebalances.length,
          proposedRebalancesCount: accumulatedProposedRebalances.length,
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

      // Add routes to proposedRebalances for next strategy
      accumulatedProposedRebalances = [
        ...accumulatedProposedRebalances,
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
