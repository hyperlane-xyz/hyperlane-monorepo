import { ChainMap } from '@hyperlane-xyz/sdk';

import { RawBalances } from '../interfaces/IStrategy.js';

import { BaseStrategy, Delta } from './BaseStrategy.js';

/**
 * Configuration for minimum amount strategy
 */
export type MinAmountStrategyConfig = {
  minAmount: bigint;
};

/**
 * Strategy implementation that rebalance based on minimum amounts
 * It ensures each chain has at least the specified minimum amount
 */
export class MinAmountStrategy extends BaseStrategy {
  private readonly config: ChainMap<MinAmountStrategyConfig>;

  constructor(config: ChainMap<MinAmountStrategyConfig>) {
    const chains = Object.keys(config);
    super(chains);

    for (const chain of chains) {
      const { minAmount } = config[chain];

      if (minAmount < 0n) {
        throw new Error('Minimum amount cannot be negative');
      }
    }

    this.config = config;
  }

  /**
   * Gets balances categorized by surplus and deficit based on minimum amounts
   */
  protected getCategorizedBalances(rawBalances: RawBalances): {
    surpluss: Delta[];
    deficits: Delta[];
  } {
    return this.chains.reduce(
      (acc, chain) => {
        const minAmount = this.config[chain].minAmount;
        const balance = rawBalances[chain];

        // If balance is less than minAmount, it has a deficit
        if (balance < minAmount) {
          acc.deficits.push({ chain, amount: minAmount - balance });
        } else {
          // Any chain with more than minAmount potentially has surplus
          // But only mark as surplus if there's extra beyond minAmount
          const surplus = balance - minAmount;
          if (surplus > 0n) {
            acc.surpluss.push({ chain, amount: surplus });
          }
        }

        return acc;
      },
      {
        surpluss: [] as Delta[],
        deficits: [] as Delta[],
      },
    );
  }
}
