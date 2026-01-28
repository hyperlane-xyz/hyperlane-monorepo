import { type Logger } from 'pino';

import { type ChainMap, type Token } from '@hyperlane-xyz/sdk';

import {
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';
import { type IStrategy } from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';

import { CollateralDeficitStrategy } from './CollateralDeficitStrategy.js';
import { MinAmountStrategy } from './MinAmountStrategy.js';
import { WeightedStrategy } from './WeightedStrategy.js';

export class StrategyFactory {
  /**
   * @param strategyConfig A discriminated union of strategy-specific configurations.
   * @param tokensByChainName - A map of chain->token to ease the lookup of token by chain
   * @param initialTotalCollateral - The initial total collateral of the rebalancer
   * @param logger - The logger to use for the strategy
   * @param metrics - The metrics to use for the strategy
   * @returns A concrete strategy implementation
   */
  static createStrategy(
    strategyConfig: StrategyConfig,
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    logger: Logger,
    metrics?: Metrics,
  ): IStrategy {
    switch (strategyConfig.rebalanceStrategy) {
      case RebalancerStrategyOptions.Weighted:
        return new WeightedStrategy(strategyConfig.chains, logger, metrics);
      case RebalancerStrategyOptions.MinAmount:
        return new MinAmountStrategy(
          strategyConfig.chains,
          tokensByChainName,
          initialTotalCollateral,
          logger,
          metrics,
        );
      case RebalancerStrategyOptions.CollateralDeficit: {
        // Extract bridges from config into ChainMap<Address[]> format
        const bridges: ChainMap<string[]> = {};
        for (const [chain, config] of Object.entries(strategyConfig.chains)) {
          bridges[chain] = [config.bridge];
        }
        return new CollateralDeficitStrategy(
          strategyConfig.chains,
          tokensByChainName,
          logger,
          metrics,
          bridges,
        );
      }
      default: {
        throw new Error('Unsupported strategy type');
      }
    }
  }
}
