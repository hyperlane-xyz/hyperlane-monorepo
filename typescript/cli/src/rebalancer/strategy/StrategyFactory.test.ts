import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  type ChainMap,
  MinAmountStrategyConfig,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  StrategyConfig,
  Token,
  TokenStandard,
  WeightedStrategyConfig,
} from '@hyperlane-xyz/sdk';

import { MinAmountStrategy } from './MinAmountStrategy.js';
import { StrategyFactory } from './StrategyFactory.js';
import { WeightedStrategy } from './WeightedStrategy.js';

describe('StrategyFactory', () => {
  const chain1 = 'chain1';
  const chain2 = 'chain2';
  const totalCollateral = BigInt(20e18);

  const tokensByChainName: ChainMap<Token> = {};
  const tokenArgs = {
    name: 'token',
    decimals: 18,
    symbol: 'TOKEN',
    standard: TokenStandard.ERC20,
    addressOrDenom: '',
  };
  tokensByChainName[chain1] = new Token({ ...tokenArgs, chainName: chain1 });
  tokensByChainName[chain2] = new Token({ ...tokenArgs, chainName: chain2 });

  describe('createStrategy', () => {
    it('creates a WeightedStrategy when given weighted configuration', () => {
      const config: WeightedStrategyConfig = {
        [chain1]: {
          weighted: {
            weight: 100n,
            tolerance: 0n,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          weighted: {
            weight: 100n,
            tolerance: 0n,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      const strategyConfig: StrategyConfig = {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: config,
      };

      const strategy = StrategyFactory.createStrategy(
        strategyConfig,
        tokensByChainName,
        totalCollateral,
      );
      expect(strategy).to.be.instanceOf(WeightedStrategy);
    });

    it('creates a MinAmountStrategy when given minAmount configuration', () => {
      const config: MinAmountStrategyConfig = {
        [chain1]: {
          minAmount: {
            min: 8,
            target: 10,
            type: RebalancerMinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: 8,
            target: 10,
            type: RebalancerMinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      const strategyConfig: StrategyConfig = {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains: config,
      };

      const strategy = StrategyFactory.createStrategy(
        strategyConfig,
        tokensByChainName,
        totalCollateral,
      );
      expect(strategy).to.be.instanceOf(MinAmountStrategy);
    });
  });
});
