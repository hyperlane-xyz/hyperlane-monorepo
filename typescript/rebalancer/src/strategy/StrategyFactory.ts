import { Logger } from 'pino';

import { ChainMap, Token } from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';

import {
  type CollateralDeficitStrategy as CollateralDeficitParsedConfig,
  type CompositeStrategy as CompositeParsedConfig,
  RebalancerStrategyOptions,
  type SingleStrategyConfig,
  StrategyConfig,
} from '../config/types.js';
import { type IStrategy } from '../interfaces/IStrategy.js';
import { Metrics } from '../metrics/Metrics.js';

import {
  CollateralDeficitStrategy,
  type CollateralDeficitStrategyConfig,
} from './CollateralDeficitStrategy.js';
<<<<<<< HEAD
import { CompositeStrategy } from './CompositeStrategy.js';
=======
>>>>>>> de54798b6 (feat(sdk): add CollateralDeficit strategy types and factory integration)
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
<<<<<<< HEAD
          strategyConfig as CollateralDeficitParsedConfig,
=======
          strategyConfig as SDKCollateralDeficitStrategy,
>>>>>>> de54798b6 (feat(sdk): add CollateralDeficit strategy types and factory integration)
          tokensByChainName,
          logger,
          metrics,
        );
<<<<<<< HEAD
      case RebalancerStrategyOptions.Composite:
        return StrategyFactory.createCompositeStrategy(
          strategyConfig as CompositeParsedConfig,
          tokensByChainName,
          initialTotalCollateral,
          logger,
          metrics,
        );
=======
>>>>>>> de54798b6 (feat(sdk): add CollateralDeficit strategy types and factory integration)
      default: {
        throw new Error('Unsupported strategy type');
      }
    }
  }

  /**
<<<<<<< HEAD
   * Create a CollateralDeficitStrategy from config.
   * Converts buffer from token units to wei.
   */
  private static createCollateralDeficitStrategy(
    config: CollateralDeficitParsedConfig,
=======
   * Create a CollateralDeficitStrategy from SDK config.
   * Converts buffer from token units to wei.
   */
  private static createCollateralDeficitStrategy(
    config: SDKCollateralDeficitStrategy,
>>>>>>> de54798b6 (feat(sdk): add CollateralDeficit strategy types and factory integration)
    tokensByChainName: ChainMap<Token>,
    logger: Logger,
    metrics?: Metrics,
  ): CollateralDeficitStrategy {
    const chainConfig: CollateralDeficitStrategyConfig = {};

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
<<<<<<< HEAD

  /**
   * Create a CompositeStrategy from config.
   * Recursively creates sub-strategies.
   */
  private static createCompositeStrategy(
    config: CompositeParsedConfig,
    tokensByChainName: ChainMap<Token>,
    initialTotalCollateral: bigint,
    logger: Logger,
    metrics?: Metrics,
  ): CompositeStrategy {
    const subStrategies = config.strategies.map(
      (subConfig: SingleStrategyConfig) =>
        StrategyFactory.createStrategy(
          subConfig,
          tokensByChainName,
          initialTotalCollateral,
          logger,
          metrics,
        ),
    );

    return new CompositeStrategy(subStrategies, logger);
  }
=======
>>>>>>> de54798b6 (feat(sdk): add CollateralDeficit strategy types and factory integration)
}
