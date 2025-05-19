import { BigNumber } from 'bignumber.js';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { MinAmountChainConfig } from '../config/Config.js';
import type { RawBalances } from '../interfaces/IStrategy.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

export type MinAmountStrategyConfig = Pick<
  MinAmountChainConfig,
  'minAmount' | 'target'
>;

type InferredConfig =
  | {
      minAmount: number;
      target: number;
      isRelative: true;
    }
  | {
      minAmount: bigint;
      target: bigint;
      isRelative: false;
    };

/**
 * Strategy implementation that rebalance based on minimum amounts
 * It ensures each chain has at least the specified minimum amount
 */
export class MinAmountStrategy extends BaseStrategy {
  private readonly config: ChainMap<InferredConfig> = {};

  constructor(config: ChainMap<MinAmountStrategyConfig>) {
    const chains = Object.keys(config);
    super(chains);

    for (const chain of chains) {
      const minAmount = BigNumber(config[chain].minAmount);
      const target = BigNumber(config[chain].target);

      // check range constraints
      if (target.lt(minAmount)) {
        throw new Error(
          `Target must be greater than or equal to minAmount for chain ${chain}`,
        );
      }

      if (minAmount.lt(0)) {
        throw new Error(`Minimum amount cannot be negative for chain ${chain}`);
      }

      const isRelative =
        minAmount.gte(0) && minAmount.lte(1) && target.gte(0) && target.lte(1);

      this.config[chain] = {
        minAmount: isRelative
          ? minAmount.toNumber()
          : BigInt(minAmount.toString()),
        target: isRelative ? target.toNumber() : BigInt(target.toString()),
        isRelative,
      } as InferredConfig;
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

        if (!config.isRelative) {
          minAmount = config.minAmount;
          targetAmount = config.target;
        } else {
          minAmount = BigInt(
            BigNumber(total)
              .times(config.minAmount)
              .toFixed(0, BigNumber.ROUND_FLOOR),
          );
          targetAmount = BigInt(
            BigNumber(total)
              .times(config.target)
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
