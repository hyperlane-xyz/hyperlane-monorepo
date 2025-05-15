import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { RawBalances } from '../interfaces/IStrategy.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

/**
 * Configuration for minimum amount strategy
 */
export type MinAmountStrategyConfig = {
  minAmount: bigint;
  buffer: bigint;
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
      const { buffer, minAmount } = config[chain];

      if (minAmount < 0n) {
        throw new Error('Minimum amount cannot be negative');
      }

      if (buffer < 0n || buffer > 10_000n) {
        throw new Error('Buffer must be between 0 and 10,000 basis points');
      }
    }

    this.config = config;
  }

  /**
   * Gets balances categorized by surplus and deficit based on minimum amounts and buffer
   * Buffer (in basis points) is a bigint between 1n (0.01%) and 10_000n (100.00%), default 0n
   */
  protected getCategorizedBalances(rawBalances: RawBalances): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    return this.chains.reduce(
      (acc, chain) => {
        const minAmount = this.config[chain].minAmount;
        const effectiveMin =
          (minAmount * (10_000n + this.config[chain].buffer)) / 10_000n;
        const balance = rawBalances[chain];

        // If balance is less than minAmount, it has a deficit
        if (balance < minAmount) {
          acc.deficits.push({ chain, amount: effectiveMin - balance });
        } else {
          // Any chain with more than minAmount potentially has surplus
          const surplus = balance - minAmount;
          if (surplus > 0n) {
            acc.surpluses.push({ chain, amount: surplus });
          }
        }

        return acc;
      },
      {
        surpluses: [] as Delta[],
        deficits: [] as Delta[],
      },
    );
  }
}
