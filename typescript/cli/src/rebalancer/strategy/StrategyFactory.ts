import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { BaseConfig, ChainConfig } from '../config/Config.js';
import type { IStrategy } from '../interfaces/IStrategy.js';

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
    rebalanceStrategy: BaseConfig['rebalanceStrategy'],
    config: ChainMap<ChainConfig>,
  ): IStrategy {
    if (rebalanceStrategy === 'weighted') {
      return new WeightedStrategy(config as ChainMap<WeightedStrategyConfig>);
    } else if (rebalanceStrategy === 'minAmount') {
      return new MinAmountStrategy(config as ChainMap<MinAmountStrategyConfig>);
    } else {
      throw new Error(`Unsupported strategy type: ${rebalanceStrategy}`);
    }
  }
}
