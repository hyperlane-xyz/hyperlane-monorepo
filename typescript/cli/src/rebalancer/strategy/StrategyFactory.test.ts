import { expect } from 'chai';
import { ethers } from 'ethers';

import { Token, TokenStandard } from '@hyperlane-xyz/sdk';

import { MinAmountType } from '../config/Config.js';
import { StrategyOptions } from '../interfaces/IStrategy.js';

import {
  MinAmountStrategy,
  MinAmountStrategyConfig,
} from './MinAmountStrategy.js';
import { StrategyFactory } from './StrategyFactory.js';
import {
  WeightedStrategy,
  WeightedStrategyConfig,
} from './WeightedStrategy.js';

describe('StrategyFactory', () => {
  let chain1: string;
  let chain2: string;
  const tokensByChainName = new Map();
  const tokenArgs = {
    name: 'token',
    decimals: 18,
    symbol: 'TOKEN',
    standard: TokenStandard.ERC20,
    addressOrDenom: '',
  };

  beforeEach(() => {
    chain1 = 'chain1';
    chain2 = 'chain2';
    tokensByChainName
      .set(chain1, new Token({ ...tokenArgs, chainName: chain1 }))
      .set(chain2, new Token({ ...tokenArgs, chainName: chain2 }));
  });

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
      );
      expect(strategy).to.be.instanceOf(WeightedStrategy);
    });

    it('creates a MinAmountStrategy when given minAmount configuration', () => {
      const config: MinAmountStrategyConfig = {
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
            type: MinAmountType.Absolute,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
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
      );
      expect(strategy).to.be.instanceOf(MinAmountStrategy);
    });
  });
});
