import {
  ChainMap,
  RebalancerChainConfig,
  RebalancerStrategyOptions,
  Token,
} from '@hyperlane-xyz/sdk';

import { type IStrategy } from '../interfaces/IStrategy.js';

import {
  MinAmountStrategy,
  type MinAmountStrategyConfig,
} from './MinAmountStrategy.js';
import {
  WeightedStrategy,
  type WeightedStrategyConfig,
} from './WeightedStrategy.js';

export class StrategyFactory {
  /**
   * @param rebalanceStrategy The global strategy type
   * @param config Chain map of strategy configuration
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @returns A concrete strategy implementation
   */
  static createStrategy(
    rebalanceStrategy: RebalancerStrategyOptions,
    config: ChainMap<RebalancerChainConfig>,
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
  ): IStrategy {
    if (rebalanceStrategy === RebalancerStrategyOptions.Weighted) {
      return new WeightedStrategy(config as WeightedStrategyConfig);
    } else if (rebalanceStrategy === RebalancerStrategyOptions.MinAmount) {
      return new MinAmountStrategy(
        config as MinAmountStrategyConfig,
        tokensByChainName,
        initialTotalCollateral,
      );
    } else {
      throw new Error(`Unsupported strategy type: ${rebalanceStrategy}`);
    }
  }
}
