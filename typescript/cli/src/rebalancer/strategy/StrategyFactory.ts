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
   * @param config Chain map of strategy configuration
   * @returns A concrete strategy implementation
   */
  static createStrategy(config: ChainMap<ChainConfig>): IStrategy {
    // Ensure we have at least one chain configuration
    const chains = Object.keys(config);

    if (chains.length === 0) {
      throw new Error('Configuration must include at least one chain');
    }

    const { strategyType } = config[chains[0]];

    // Ensure all chains use the same strategy type
    for (const chain of chains) {
      const chainStrategyType = config[chain].strategyType;

      if (chainStrategyType !== strategyType) {
        throw new Error('All chains must use the same strategy type');
      }
    }

    if (strategyType === 'weighted') {
      return new WeightedStrategy(config as ChainMap<WeightedChainConfig>);
    } else if (strategyType === 'minAmount') {
      return new MinAmountStrategy(config as ChainMap<MinAmountChainConfig>);
    } else {
      throw new Error(`Unsupported strategy type: ${strategyType}`);
    }
  }
}
