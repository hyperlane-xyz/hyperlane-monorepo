import { BigNumber } from 'bignumber.js';

import type { ChainMap, Token } from '@hyperlane-xyz/sdk';
import { fromWei, toWei } from '@hyperlane-xyz/utils';

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

  constructor(
    config: MinAmountStrategyConfig,
    private readonly tokensByChainName: ChainMap<Token>,
  ) {
    const chains = Object.keys(config);
    super(chains);

    this.validateTypes(config);

    for (const chain of chains) {
      const { min, target } = config[chain].minAmount;

      // check range constraints
      if (BigNumber(target).lt(min)) {
        throw new Error(
          `Target (${target}) must be greater than or equal to min (${min}) for chain ${chain}`,
        );
      }

      if (BigNumber(min).lt(0)) {
        throw new Error(
          `Minimum amount (${min}) cannot be negative for chain ${chain}`,
        );
      }

      if (BigNumber(target).lt(0)) {
        throw new Error(
          `Target amount (${target}) cannot be negative for chain ${chain}`,
        );
      }
    }

    this.config = config;
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
    const totalCollateral = this.chains.reduce(
      (sum, chain) => sum + rawBalances[chain],
      0n,
    );

    this.validateAmounts(totalCollateral);

    return this.chains.reduce(
      (acc, chain) => {
        const config = this.config[chain];
        const balance = rawBalances[chain];
        let minAmount: bigint;
        let targetAmount: bigint;

        if (config.minAmount.type === MinAmountType.Absolute) {
          const token = this.getTokenByChainName(chain);

          minAmount = BigInt(toWei(config.minAmount.min, token.decimals));
          targetAmount = BigInt(toWei(config.minAmount.target, token.decimals));
        } else {
          minAmount = BigInt(
            BigNumber(totalCollateral.toString())
              .times(config.minAmount.min)
              .toFixed(0, BigNumber.ROUND_FLOOR),
          );
          targetAmount = BigInt(
            BigNumber(totalCollateral.toString())
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

  protected getTokenByChainName(chainName: string): Token {
    const token = this.tokensByChainName[chainName];

    if (token === undefined) {
      throw new Error(`Token not found for chain ${chainName}`);
    }

    return token;
  }

  private validateTypes(config: MinAmountStrategyConfig): void {
    const minAmountTypes = [];

    for (const chainName of this.chains) {
      minAmountTypes.push(config[chainName].minAmount.type);
    }

    if (new Set(minAmountTypes).size !== 1) {
      throw new Error(`All types for the minAmount strategy must be the same`);
    }
  }

  private validateAmounts(totalCollateral: bigint): void {
    const minAmountType = this.config[this.chains[0]].minAmount.type;

    if (minAmountType === MinAmountType.Absolute) {
      let totalMinAmount = 0n;
      let decimals: number = 0;

      for (const chainName of this.chains) {
        const config = this.config[chainName];
        const token = this.getTokenByChainName(chainName);
        // all the tokens have the same amount of decimals
        decimals = token.decimals;

        totalMinAmount += BigInt(toWei(config.minAmount.min, token.decimals));
      }

      if (totalMinAmount > totalCollateral) {
        throw new Error(
          `Sum of total minAmounts (${fromWei(
            totalMinAmount.toString(),
            decimals,
          )}) shouldn't be greater than the sum of collaterals (${fromWei(totalCollateral.toString(), decimals)})`,
        );
      }
    }
  }
}
