import type { ChainName } from '@hyperlane-xyz/sdk';

import { logDebug, logGray, warnYellow } from '../../logger.js';
import type {
  IStrategy,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

export type Delta = { chain: ChainName; amount: bigint };

/**
 * Base abstract class for rebalancing strategies
 */
export abstract class BaseStrategy implements IStrategy {
  protected readonly chains: ChainName[];

  constructor(chains: ChainName[]) {
    // Rebalancing makes sense only with more than one chain.
    if (chains.length < 2) {
      throw new Error('At least two chains must be configured');
    }
    this.chains = chains;
  }

  /**
   * Main method to get rebalancing routes
   */
  getRebalancingRoutes(rawBalances: RawBalances): RebalancingRoute[] {
    logDebug(`[${this.constructor.name}] Input rawBalances:`, rawBalances);
    logGray(`Calculating rebalancing routes using ${this.constructor.name}...`);
    this.validateRawBalances(rawBalances);

    // Get balances categorized by surplus and deficit
    const { surpluses, deficits } = this.getCategorizedBalances(rawBalances);

    logDebug(`[${this.constructor.name}] Surpluses:`, surpluses);
    logDebug(`[${this.constructor.name}] Deficits:`, deficits);

    // Calculate sums of surpluses and deficits
    const totalSurplus = surpluses.reduce(
      (sum, surplus) => sum + surplus.amount,
      0n,
    );
    const totalDeficit = deficits.reduce(
      (sum, deficit) => sum + deficit.amount,
      0n,
    );

    logDebug(`[${this.constructor.name}] Total surplus: ${totalSurplus}`);
    logDebug(`[${this.constructor.name}] Total deficit: ${totalDeficit}`);

    // If total surplus is less than total deficit, scale down deficits proportionally
    // TODO: consider how to handle sum of targets > sum of collateral balances i.e throw or raise an alert
    if (totalSurplus < totalDeficit) {
      warnYellow(
        `[${this.constructor.name}] Deficits are greater than surpluses. Scaling deficits...`,
      );

      for (const deficit of deficits) {
        const newAmount = (deficit.amount * totalSurplus) / totalDeficit;

        deficit.amount = newAmount;
      }

      logDebug(`[${this.constructor.name}] Scaled deficits:`, deficits);
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

    logDebug(`[${this.constructor.name}] Generated routes:`, routes);
    logGray(
      `Found ${routes.length} rebalancing route(s) using ${this.constructor.name}.`,
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
