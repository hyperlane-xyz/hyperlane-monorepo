import type { ChainName } from '@hyperlane-xyz/sdk';

import type {
  IStrategy,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';
import { strategyLogger } from '../utils/index.js';

export type Delta = { chain: ChainName; amount: bigint };

/**
 * Base abstract class for rebalancing strategies
 */
export abstract class BaseStrategy implements IStrategy {
  protected readonly chains: ChainName[];
  protected readonly metrics?: Metrics;

  constructor(chains: ChainName[], metrics?: Metrics) {
    // Rebalancing makes sense only with more than one chain.
    if (chains.length < 2) {
      throw new Error('At least two chains must be configured');
    }
    this.chains = chains;
    this.metrics = metrics;
  }

  /**
   * Main method to get rebalancing routes
   */
  getRebalancingRoutes(rawBalances: RawBalances): RebalancingRoute[] {
    strategyLogger.info(
      {
        context: this.constructor.name,
        rawBalances,
      },
      'Input rawBalances',
    );
    strategyLogger.info(
      {
        context: this.constructor.name,
      },
      'Calculating rebalancing routes',
    );
    this.validateRawBalances(rawBalances);

    // Get balances categorized by surplus and deficit
    const { surpluses, deficits } = this.getCategorizedBalances(rawBalances);

    strategyLogger.debug(
      {
        context: this.constructor.name,
        surpluses,
      },
      'Surpluses calculated',
    );
    strategyLogger.debug(
      {
        context: this.constructor.name,
        deficits,
      },
      'Deficits calculated',
    );

    // Calculate sums of surpluses and deficits
    const totalSurplus = surpluses.reduce(
      (sum, surplus) => sum + surplus.amount,
      0n,
    );
    const totalDeficit = deficits.reduce(
      (sum, deficit) => sum + deficit.amount,
      0n,
    );

    strategyLogger.debug(
      {
        context: this.constructor.name,
        totalSurplus: totalSurplus.toString(),
      },
      'Total surplus calculated',
    );
    strategyLogger.debug(
      {
        context: this.constructor.name,
        totalDeficit: totalDeficit.toString(),
      },
      'Total deficit calculated',
    );

    // If total surplus is less than total deficit, scale down deficits proportionally
    if (totalSurplus < totalDeficit) {
      strategyLogger.warn(
        {
          context: this.constructor.name,
          totalSurplus: totalSurplus.toString(),
          totalDeficit: totalDeficit.toString(),
        },
        'Deficits are greater than surpluses. Scaling deficits',
      );

      // we consider this a failure because we cannot rebalance the route completely
      // however we can still transfer some amount of the deficit to reduce the imbalances
      this.metrics?.recordRebalancerFailure();

      for (const deficit of deficits) {
        const newAmount = (deficit.amount * totalSurplus) / totalDeficit;

        deficit.amount = newAmount;
      }

      strategyLogger.debug(
        {
          context: this.constructor.name,
          deficits,
        },
        'Scaled deficits',
      );
    }

    // Sort from largest to smallest amounts as to always transfer largest amounts
    // first and decrease the amount of routes required
    surpluses.sort((a, b) => (a.amount > b.amount ? -1 : 1));
    deficits.sort((a, b) => (a.amount > b.amount ? -1 : 1));

    const routes: RebalancingRoute[] = [];

    // Transfer from surplus to deficit until all deficits are balanced.
    while (deficits.length > 0 && surpluses.length > 0) {
      const surplus = surpluses[0];
      const deficit = deficits[0];

      // Transfers the whole surplus or just the amount to balance the deficit
      const transferAmount =
        surplus.amount > deficit.amount ? deficit.amount : surplus.amount;

      // Creates the balancing route
      routes.push({
        origin: surplus.chain,
        destination: deficit.chain,
        amount: transferAmount,
      });

      // Decreases the amounts for the following iterations
      deficit.amount -= transferAmount;
      surplus.amount -= transferAmount;

      // Removes the deficit if it is fully balanced
      if (!deficit.amount) {
        deficits.shift();
      }

      // Removes the surplus if it has been drained
      if (!surplus.amount) {
        surpluses.shift();
      }
    }

    strategyLogger.debug(
      {
        context: this.constructor.name,
        routes,
      },
      'Generated routes',
    );
    strategyLogger.info(
      {
        context: this.constructor.name,
        numberOfRoutes: routes.length,
      },
      'Found rebalancing routes',
    );
    return routes;
  }

  /**
   * Abstract method to get balances categorized by surplus and deficit
   * Each specific strategy should implement its own logic
   */
  protected abstract getCategorizedBalances(rawBalances: RawBalances): {
    surpluses: Delta[];
    deficits: Delta[];
  };

  /**
   * Validates the raw balances against the chains configuration
   */
  protected validateRawBalances(rawBalances: RawBalances): void {
    const rawBalancesChains = Object.keys(rawBalances);

    if (this.chains.length !== rawBalancesChains.length) {
      throw new Error('Config chains do not match raw balances chains length');
    }

    for (const chain of this.chains) {
      const balance: bigint | undefined = rawBalances[chain];

      if (balance === undefined) {
        throw new Error(`Raw balance for chain ${chain} not found`);
      }

      if (balance < 0n) {
        throw new Error(`Raw balance for chain ${chain} is negative`);
      }
    }
  }
}
