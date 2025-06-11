import type { WeightedStrategyConfig } from '@hyperlane-xyz/sdk';

import type { RawBalances } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';

import { BaseStrategy, type Delta } from './BaseStrategy.js';

/**
 * Strategy implementation that rebalance based on weights
 * It distributes funds across chains based on their weights
 */
export class WeightedStrategy extends BaseStrategy {
  private readonly config: WeightedStrategyConfig;
  private readonly totalWeight: bigint;

  constructor(config: WeightedStrategyConfig, metrics?: Metrics) {
    const chains = Object.keys(config);
    super(chains, metrics);

    let totalWeight = 0n;

    for (const chain of chains) {
      const { weight, tolerance } = config[chain].weighted;

      if (weight <= 0n) {
        throw new Error(
          `Weight (${weight}) must be greater than 0 for ${chain}`,
        );
      }

      if (tolerance < 0n || tolerance > 100n) {
        throw new Error(
          `Tolerance (${tolerance}) must be between 0 and 100 for ${chain}`,
        );
      }

      totalWeight += weight;
    }

    this.config = config;
    this.totalWeight = totalWeight;
  }

  /**
   * Gets balances categorized by surplus and deficit based on weights
   */
  protected getCategorizedBalances(rawBalances: RawBalances): {
    surpluses: Delta[];
    deficits: Delta[];
  } {
    // Get the total balance from all chains
    const total = this.chains.reduce(
      (sum, chain) => sum + rawBalances[chain],
      0n,
    );

    return this.chains.reduce(
      (acc, chain) => {
        const { weight, tolerance } = this.config[chain].weighted;
        const target = (total * weight) / this.totalWeight;
        const toleranceAmount = (target * tolerance) / 100n;
        const balance = rawBalances[chain];

        // Apply the tolerance to deficits to prevent small imbalances
        if (balance < target - toleranceAmount) {
          acc.deficits.push({ chain, amount: target - balance });
        } else if (balance > target) {
          acc.surpluses.push({ chain, amount: balance - target });
        } else {
          // Do nothing as the balance is already on target
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
