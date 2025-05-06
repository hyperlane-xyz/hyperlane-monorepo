import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import {
  IStrategy,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

type ChainConfig = {
  weight: bigint;
  tolerance: bigint;
};

type Delta = { chain: ChainName; amount: bigint };

export class Strategy implements IStrategy {
  private readonly chains: ChainName[];
  private readonly config: ChainMap<ChainConfig>;
  private readonly totalWeight: bigint;

  constructor(config: ChainMap<ChainConfig>) {
    const chains = Object.keys(config);

    // Rebalancing makes sense only with more than one chain.
    if (chains.length < 2) {
      throw new Error('At least two chains must be configured');
    }

    let totalWeight = 0n;

    for (const chain of chains) {
      const { weight, tolerance } = config[chain];

      if (weight <= 0n) {
        throw new Error('Weight must be greater than 0');
      }

      if (tolerance < 0n || tolerance > 100n) {
        throw new Error('Tolerance must be between 0 and 100');
      }

      totalWeight += weight;
    }

    this.chains = chains;
    this.config = config;
    this.totalWeight = totalWeight;
  }

  /**
   * Get the optimized routes to rebalance the defined chains.
   */
  getRebalancingRoutes(rawBalances: RawBalances): RebalancingRoute[] {
    this.validateRawBalances(rawBalances);

    // Get the total balance from all chains
    const total = this.chains.reduce(
      (sum, chain) => sum + rawBalances[chain],
      0n,
    );

    // Group balances by balances with surplus or deficit
    const { surpluss, deficits } = this.chains.reduce(
      (acc, chain) => {
        const { weight, tolerance } = this.config[chain];
        const target = (total * weight) / this.totalWeight;
        const toleranceAmount = (target * tolerance) / 100n;
        const balance = rawBalances[chain];

        // Apply the tolerance to deficits to prevent small imbalances
        if (balance < target - toleranceAmount) {
          acc.deficits.push({ chain, amount: target - balance });
        } else if (balance > target) {
          acc.surpluss.push({ chain, amount: balance - target });
        } else {
          // Do nothing as the balance is already on target
        }

        return acc;
      },
      {
        surpluss: [] as Delta[],
        deficits: [] as Delta[],
      },
    );

    // Sort from largest to smallest amounts as to always transfer largest amounts
    // first and decrease the amount of routes required
    surpluss.sort((a, b) => (a.amount > b.amount ? -1 : 1));
    deficits.sort((a, b) => (a.amount > b.amount ? -1 : 1));

    const routes: RebalancingRoute[] = [];

    // Transfer from surplus to deficit until all deficits are balanced.
    // It is not possible in this implementation for surpluses to run out before deficits
    while (deficits.length > 0) {
      const surplus = surpluss[0];
      const deficit = deficits[0];

      // Transfers the whole surplus or just the amount to balance the deficit
      const transferAmount =
        surplus.amount > deficit.amount ? deficit.amount : surplus.amount;

      // Creates the balancing route
      routes.push({
        fromChain: surplus.chain,
        toChain: deficit.chain,
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
        surpluss.shift();
      }
    }

    return routes;
  }

  private validateRawBalances(rawBalances: RawBalances): void {
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
