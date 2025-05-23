import { BigNumber } from 'bignumber.js';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import { type ChainConfig, MinAmountType } from '../config/Config.js';
import type { RawBalances } from '../interfaces/IStrategy.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

export type MinAmountStrategyConfig = ChainMap<
  ChainConfig & Required<Pick<ChainConfig, 'minAmount'>>
>;

/**
 * Strategy implementation that rebalance based on minimum amounts
 * It ensures each chain has at least the specified minimum amount
 */
export class MinAmountStrategy extends BaseStrategy {
  private readonly config: MinAmountStrategyConfig = {};

  constructor(config: MinAmountStrategyConfig) {
    const chains = Object.keys(config);
    super(chains);

    for (const chain of chains) {
      const { min, target } = config[chain].minAmount;

      // check range constraints
      if (BigNumber(target).lt(min)) {
        throw new Error(
          `Target must be greater than or equal to min for chain ${chain}`,
        );
      }

      if (BigNumber(min).lt(0)) {
        throw new Error(`Minimum amount cannot be negative for chain ${chain}`);
      }

      this.config = config;
    }
  }

  /**
   * Gets balances categorized by surplus and deficit based on minimum amounts and targets
   * - For absolute values: Uses exact token amounts
   * - For relative values: Uses percentages of total balance across all chains
   */
  protected getCategorizedBalances(rawBalances: RawBalances): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    // Get the total balance from all chains (needed for relative calculations)
    const total = this.chains
      .reduce((sum, chain) => sum + rawBalances[chain], 0n)
      .toString();

    return this.chains.reduce(
      (acc, chain) => {
        const config = this.config[chain];
        const balance = rawBalances[chain];
        let minAmount: bigint;
        let targetAmount: bigint;

        if (config.minAmount.type === MinAmountType.Absolute) {
          // TODO: convert from token units to wei
          minAmount = BigInt(
            BigNumber(config.minAmount.min).toFixed(0, BigNumber.ROUND_FLOOR),
          );
          targetAmount = BigInt(
            BigNumber(config.minAmount.target).toFixed(
              0,
              BigNumber.ROUND_FLOOR,
            ),
          );
        } else {
          minAmount = BigInt(
            BigNumber(total)
              .times(config.minAmount.min)
              .toFixed(0, BigNumber.ROUND_FLOOR),
          );
          targetAmount = BigInt(
            BigNumber(total)
              .times(config.minAmount.target)
              .toFixed(0, BigNumber.ROUND_FLOOR),
          );
        }

        // If balance is less than minAmount, it has a deficit
        if (balance < minAmount) {
          acc.deficits.push({ chain, amount: targetAmount - balance });
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
