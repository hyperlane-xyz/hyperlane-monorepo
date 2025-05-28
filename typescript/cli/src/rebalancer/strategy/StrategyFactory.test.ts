import { expect } from 'chai';
import { ethers } from 'ethers';

import { type ChainMap, Token, TokenStandard } from '@hyperlane-xyz/sdk';

import { MinAmountType } from '../config/Config.js';
import { StrategyOptions } from '../interfaces/IStrategy.js';

import {
  MinAmountStrategy,
  type MinAmountStrategyConfig,
} from './MinAmountStrategy.js';
import { StrategyFactory } from './StrategyFactory.js';
import {
  WeightedStrategy,
  type WeightedStrategyConfig,
} from './WeightedStrategy.js';

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

      const strategy = StrategyFactory.createStrategy(
        StrategyOptions.Weighted,
        config,
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
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: 8,
            target: 10,
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      const strategy = StrategyFactory.createStrategy(
        StrategyOptions.MinAmount,
        config,
        tokensByChainName,
        totalCollateral,
      );
      expect(strategy).to.be.instanceOf(MinAmountStrategy);
    });
  });
});
