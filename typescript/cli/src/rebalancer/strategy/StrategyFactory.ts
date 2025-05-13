import type { ChainMap } from '@hyperlane-xyz/sdk';

import type { ChainConfig } from '../config/Config.js';
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
   * @param strategyType The global strategy type
   * @param config Chain map of strategy configuration
   * @returns A concrete strategy implementation
   */
  static createStrategy(
    strategyType: string,
    config: ChainMap<ChainConfig>,
  ): IStrategy {
    if (strategyType === 'weighted') {
      return new WeightedStrategy(config as ChainMap<WeightedStrategyConfig>);
    } else if (strategyType === 'minAmount') {
      return new MinAmountStrategy(config as ChainMap<MinAmountStrategyConfig>);
    } else {
      throw new Error(`Unsupported strategy type: ${strategyType}`);
    }
  }
}
