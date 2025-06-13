import {
  ChainMap,
  RebalancerStrategyOptions,
  StrategyConfig,
  Token,
} from '@hyperlane-xyz/sdk';

import { type IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';

import { MinAmountStrategy } from './MinAmountStrategy.js';
import { WeightedStrategy } from './WeightedStrategy.js';

export class StrategyFactory {
  /**
   * @param strategyConfig A discriminated union of strategy-specific configurations.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param initialTotalCollateral - The initial total collateral of the rebalancer
   * @param metrics - The metrics to use for the strategy
   * @returns A concrete strategy implementation
   */
  static createStrategy(
    strategyConfig: StrategyConfig,
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    metrics?: Metrics,
  ): IStrategy {
    switch (strategyConfig.rebalanceStrategy) {
      case RebalancerStrategyOptions.Weighted:
        return new WeightedStrategy(strategyConfig.chains, metrics);
      case RebalancerStrategyOptions.MinAmount:
        return new MinAmountStrategy(
          strategyConfig.chains,
          tokensByChainName,
          initialTotalCollateral,
          metrics,
        );
      default: {
        throw new Error('Unsupported strategy type');
      }
    }
  }
}
