import { type Logger } from 'pino';

import { type ChainMap, type Token } from '@hyperlane-xyz/sdk';

import {
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';
import { type IStrategy } from '../interfaces/IStrategy.js';
import { type Metrics } from '../metrics/Metrics.js';
import type { BridgeConfigWithOverride } from '../utils/bridgeUtils.js';

import { CollateralDeficitStrategy } from './CollateralDeficitStrategy.js';
import { CompositeStrategy } from './CompositeStrategy.js';
import { MinAmountStrategy } from './MinAmountStrategy.js';
import { WeightedStrategy } from './WeightedStrategy.js';

export class StrategyFactory {
  /**
   * Creates a strategy from an array of strategy configs.
   * - Single strategy (array with 1 element): Creates that strategy directly
   * - Multiple strategies (array with 2+ elements): Creates CompositeStrategy
   *
   * @param strategyConfigs Array of strategy configurations (always array format)
   * @param tokensByChainName A map of chain->token to ease the lookup of token by chain
   * @param initialTotalCollateral The initial total collateral of the rebalancer
   * @param logger The logger to use for the strategy
   * @param metrics The metrics to use for the strategy
   * @param minAmountsByChain Optional minimum amounts per chain for filtering routes
   * @returns A concrete strategy implementation
   */
  static createStrategy(
    strategyConfigs: StrategyConfig[],
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    logger: Logger,
    metrics?: Metrics,
    minAmountsByChain?: ChainMap<bigint>,
  ): IStrategy {
    if (strategyConfigs.length === 0) {
      throw new Error('At least one strategy must be configured');
    }

    // Single strategy - create directly without CompositeStrategy wrapper
    if (strategyConfigs.length === 1) {
      return this.createSingleStrategy(
        strategyConfigs[0],
        tokensByChainName,
        initialTotalCollateral,
        logger,
        metrics,
        minAmountsByChain,
      );
    }

    // Multiple strategies - create CompositeStrategy
    const subStrategies = strategyConfigs.map((config) =>
      this.createSingleStrategy(
        config,
        tokensByChainName,
        initialTotalCollateral,
        logger,
        metrics,
        minAmountsByChain,
      ),
    );
    return new CompositeStrategy(subStrategies, logger);
  }

  /**
   * Create a single strategy from config.
   */
  private static createSingleStrategy(
    strategyConfig: StrategyConfig,
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    logger: Logger,
    metrics?: Metrics,
    minAmountsByChain?: ChainMap<bigint>,
  ): IStrategy {
    const bridgeConfigs = this.extractBridgeConfigs(strategyConfig);

    switch (strategyConfig.rebalanceStrategy) {
      case RebalancerStrategyOptions.Weighted: {
        return new WeightedStrategy(
          strategyConfig.chains,
          logger,
          bridgeConfigs,
          metrics,
          tokensByChainName,
        );
      }
      case RebalancerStrategyOptions.MinAmount: {
        return new MinAmountStrategy(
          strategyConfig.chains,
          tokensByChainName,
          initialTotalCollateral,
          logger,
          bridgeConfigs,
          metrics,
        );
      }
      case RebalancerStrategyOptions.CollateralDeficit: {
        return new CollateralDeficitStrategy(
          strategyConfig.chains,
          tokensByChainName,
          logger,
          bridgeConfigs,
          metrics,
        );
      }
      default: {
        throw new Error('Unsupported strategy type');
      }
    }
  }

  private static extractBridgeConfigs(
    strategyConfig: StrategyConfig,
  ): ChainMap<BridgeConfigWithOverride> {
    const bridgeConfigs: ChainMap<BridgeConfigWithOverride> = {};

    for (const [chain, config] of Object.entries(strategyConfig.chains)) {
      bridgeConfigs[chain] = {
        bridge: config.bridge,
        bridgeMinAcceptedAmount: config.bridgeMinAcceptedAmount ?? 0,
        override: config.override as ChainMap<
          Partial<{ bridge: string; bridgeMinAcceptedAmount: string | number }>
        >,
      };
    }

    return bridgeConfigs;
  }
}
