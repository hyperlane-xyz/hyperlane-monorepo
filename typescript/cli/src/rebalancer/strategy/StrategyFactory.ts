import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { ChainConfig } from '../config/Config.js';
import { IStrategy, StrategyOptions } from '../interfaces/IStrategy.js';

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
   * @returns A concrete strategy implementation
   */
  static createStrategy(
    rebalanceStrategy: StrategyOptions,
    config: ChainMap<ChainConfig>,
  ): IStrategy {
    if (rebalanceStrategy === StrategyOptions.Weighted) {
      return new WeightedStrategy(config as WeightedStrategyConfig);
    } else if (rebalanceStrategy === StrategyOptions.MinAmount) {
      return new MinAmountStrategy(config as MinAmountStrategyConfig);
    } else {
      throw new Error(`Unsupported strategy type: ${rebalanceStrategy}`);
    }
  }
}
