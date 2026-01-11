import { BigNumber } from 'bignumber.js';
import { type Logger } from 'pino';

import { type ChainMap, type Token } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';
import { fromWei, toWei } from '@hyperlane-xyz/utils';

import {
  type MinAmountStrategyConfig,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '../config/types.js';
import type { RawBalances, RebalancingRoute } from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

/**
 * Strategy implementation that rebalance based on minimum amounts
 * It ensures each chain has at least the specified minimum amount
 */
export class MinAmountStrategy extends BaseStrategy {
  readonly name = RebalancerStrategyOptions.MinAmount;
  private readonly config: MinAmountStrategyConfig = {};
  protected readonly logger: Logger;

  constructor(
    config: MinAmountStrategyConfig,
    private readonly tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    logger: Logger,
    metrics?: Metrics,
    bridges?: ChainMap<Address[]>,
  ) {
    const chains = Object.keys(config);
    const log = logger.child({ class: MinAmountStrategy.name });
    super(chains, log, metrics, bridges);
    this.logger = log;

    const minAmountType = config[chains[0]].minAmount.type;
    this.validateAmounts(initialTotalCollateral, minAmountType, config);

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
    this.logger.info('MinAmountStrategy created');
  }

  /**
   * Gets balances categorized by surplus and deficit based on minimum amounts and targets
   * - For absolute values: Uses exact token amounts
   * - For relative values: Uses percentages of total balance across all chains
   *
   * Simulates both types of rebalances before calculating surpluses/deficits:
   * - pendingRebalances: in-flight intents (origin tx confirmed, add to destination only)
   * - proposedRebalances: routes from earlier strategies (subtract from origin AND add to destination)
   *
   * This prevents over-rebalancing when multiple strategies run in sequence.
   */
  protected getCategorizedBalances(
    rawBalances: RawBalances,
    pendingRebalances?: RebalancingRoute[],
    proposedRebalances?: RebalancingRoute[],
  ): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    // Step 1: Simulate pending rebalances (in-flight, origin already deducted on-chain)
    let simulatedBalances = this.simulatePendingRebalances(
      rawBalances,
      pendingRebalances ?? [],
    );

    // Step 2: Simulate proposed rebalances (from earlier strategies, not yet executed)
    simulatedBalances = this.simulateProposedRebalances(
      simulatedBalances,
      proposedRebalances ?? [],
    );
    const totalCollateral = this.chains.reduce(
      (sum, chain) => sum + rawBalances[chain],
      0n,
    );

    return this.chains.reduce(
      (acc, chain) => {
        const config = this.config[chain];
        const balance = rawBalances[chain];
        let minAmount: bigint;
        let targetAmount: bigint;

        if (config.minAmount.type === RebalancerMinAmountType.Absolute) {
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

  private validateAmounts(
    totalCollateral: bigint,
    minAmountType: RebalancerMinAmountType,
    config?: MinAmountStrategyConfig,
  ): void {
    config ??= this.config;

    if (minAmountType === RebalancerMinAmountType.Absolute) {
      let totalTargets = 0n;
      let decimals: number = 0;

      for (const chainName of this.chains) {
        const token = this.getTokenByChainName(chainName);
        // all the tokens have the same amount of decimals
        decimals = token.decimals;

        totalTargets += BigInt(
          toWei(config[chainName].minAmount.target, token.decimals),
        );
      }

      if (totalTargets > totalCollateral) {
        throw new Error(
          `Consider reducing the targets as the sum (${fromWei(
            totalTargets.toString(),
            decimals,
          )}) is greater than sum of collaterals (${fromWei(
            totalCollateral.toString(),
            decimals,
          )})`,
        );
      }
    }
  }
}
