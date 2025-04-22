import { ChainName } from '@hyperlane-xyz/sdk';

import {
  IStrategy,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

export class Strategy implements IStrategy {
  /**
   * Get the optimized routes that will rebalance all chains to the same balance
   */
  getRebalancingRoutes(rawBalances: RawBalances): RebalancingRoute[] {
    const entries = Object.entries(rawBalances);
    // Get the total balance from all chains
    const total = entries.reduce((sum, [, balance]) => sum + balance, 0n);
    // Get the average balance
    const target = total / BigInt(entries.length);
    const surpluss: { chain: ChainName; amount: bigint }[] = [];
    const deficits: { chain: ChainName; amount: bigint }[] = [];

    // Group balances by balances with surplus or deficit
    for (const [chain, balance] of entries) {
      if (balance < target) {
        deficits.push({ chain, amount: target - balance });
      } else if (balance > target) {
        surpluss.push({ chain, amount: balance - target });
      } else {
        // Do nothing as the balance is already on target
      }
    }

    const routes: RebalancingRoute[] = [];

    // Keep iterating until all routes have been found
    while (surpluss.length > 0 && deficits.length > 0) {
      const surplus = surpluss[0];
      const deficit = deficits[0];
      const fromChain = surplus.chain;
      const toChain = deficit.chain;

      if (surplus.amount > deficit.amount) {
        routes.push({
          fromChain,
          toChain,
          amount: deficit.amount,
        });

        deficits.shift();
        surplus.amount -= deficit.amount;
      } else if (surplus.amount < deficit.amount) {
        routes.push({
          fromChain,
          toChain,
          amount: surplus.amount,
        });

        surpluss.shift();
        deficit.amount -= surplus.amount;
      } else {
        routes.push({
          fromChain,
          toChain,
          amount: surplus.amount,
        });

        deficits.shift();
        surpluss.shift();
      }
    }

    return routes;
  }
}
