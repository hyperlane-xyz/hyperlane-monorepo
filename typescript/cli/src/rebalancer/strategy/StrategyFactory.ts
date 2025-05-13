import type { ChainMap } from '@hyperlane-xyz/sdk';

import type {
  ChainConfig,
  MinAmountChainConfig,
  WeightedChainConfig,
} from '../config/Config.js';
import type { IStrategy } from '../interfaces/IStrategy.js';

import { MinAmountStrategy } from './MinAmountStrategy.js';
import { WeightedStrategy } from './WeightedStrategy.js';

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
      return new WeightedStrategy(config as ChainMap<WeightedChainConfig>);
    } else if (strategyType === 'minAmount') {
      return new MinAmountStrategy(config as ChainMap<MinAmountChainConfig>);
    } else {
      throw new Error(`Unsupported strategy type: ${strategyType}`);
    }
  }
}
