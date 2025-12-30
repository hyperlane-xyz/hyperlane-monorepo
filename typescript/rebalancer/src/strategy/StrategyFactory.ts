import { Logger } from 'pino';

import {
  ChainMap,
  RebalancerStrategyOptions,
  type CollateralDeficitStrategy as SDKCollateralDeficitStrategy,
  type CompositeStrategy as SDKCompositeStrategy,
  type SingleStrategyConfig,
  StrategyConfig,
  Token,
} from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import { type IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';

import {
  type CollateralDeficitStrategyConfig as CollateralDeficitChainConfig,
  CollateralDeficitStrategy,
} from './CollateralDeficitStrategy.js';
import { CompositeStrategy } from './CompositeStrategy.js';
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

      case RebalancerStrategyOptions.CollateralDeficit:
        return StrategyFactory.createCollateralDeficitStrategy(
          strategyConfig as SDKCollateralDeficitStrategy,
          tokensByChainName,
          logger,
          metrics,
        );

      case RebalancerStrategyOptions.Composite:
        return StrategyFactory.createCompositeStrategy(
          strategyConfig as SDKCompositeStrategy,
          tokensByChainName,
          initialTotalCollateral,
          logger,
          metrics,
        );

      default: {
        throw new Error('Unsupported strategy type');
      }
    }
  }

  /**
   * Create a CollateralDeficitStrategy from config
   */
  private static createCollateralDeficitStrategy(
    config: SDKCollateralDeficitStrategy,
    tokensByChainName: ChainMap<Token>,
    logger: Logger,
    metrics?: Metrics,
  ): CollateralDeficitStrategy {
    // Convert config to CollateralDeficitStrategyConfig format
    const chainConfig: CollateralDeficitChainConfig = {};

    for (const [chainName, chainCfg] of Object.entries(config.chains)) {
      const token = tokensByChainName[chainName];
      const decimals = token?.decimals ?? 18;

      chainConfig[chainName] = {
        bridge: chainCfg.collateralDeficit.bridge,
        // Convert buffer from token units to wei
        buffer: BigInt(
          toWei(chainCfg.collateralDeficit.buffer.toString(), decimals),
        ),
      };
    }

    return new CollateralDeficitStrategy(chainConfig, logger, metrics);
  }

  /**
   * Create a CompositeStrategy from config
   */
  private static createCompositeStrategy(
    config: SDKCompositeStrategy,
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    logger: Logger,
    metrics?: Metrics,
  ): CompositeStrategy {
    const strategies = config.strategies.map((strategyConfig) =>
      StrategyFactory.createSingleStrategy(
        strategyConfig,
        tokensByChainName,
        initialTotalCollateral,
        logger,
        metrics,
      ),
    );

    return new CompositeStrategy(strategies, logger);
  }

  /**
   * Create a single (non-composite) strategy
   */
  private static createSingleStrategy(
    strategyConfig: SingleStrategyConfig,
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

      case RebalancerStrategyOptions.CollateralDeficit:
        return StrategyFactory.createCollateralDeficitStrategy(
          strategyConfig as SDKCollateralDeficitStrategy,
          tokensByChainName,
          logger,
          metrics,
        );

      default: {
        throw new Error('Unsupported strategy type');
      }
    }
  }
}
