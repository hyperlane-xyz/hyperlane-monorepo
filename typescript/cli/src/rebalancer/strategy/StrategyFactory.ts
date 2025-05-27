import type { ChainMap, Token } from '@hyperlane-xyz/sdk';

import type { ChainConfig } from '../config/Config.js';
import { type IStrategy, StrategyOptions } from '../interfaces/IStrategy.js';

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
    rebalanceStrategy: StrategyOptions,
    config: ChainMap<ChainConfig>,
    tokensByChainName: ChainMap<Token>,
    totalCollateral: bigint,
  ): IStrategy {
    if (rebalanceStrategy === StrategyOptions.Weighted) {
      return new WeightedStrategy(config as WeightedStrategyConfig);
    } else if (rebalanceStrategy === StrategyOptions.MinAmount) {
      return new MinAmountStrategy(
        config as MinAmountStrategyConfig,
        tokensByChainName,
        totalCollateral,
      );
    } else {
      throw new Error(`Unsupported strategy type: ${rebalanceStrategy}`);
    }
  }
}
