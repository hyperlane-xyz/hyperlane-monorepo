import { expect } from 'chai';
import { ethers } from 'ethers';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import type {
  MinAmountChainConfig,
  WeightedChainConfig,
} from '../config/Config.js';

import { MinAmountStrategy } from './MinAmountStrategy.js';
import { StrategyFactory } from './StrategyFactory.js';
import { WeightedStrategy } from './WeightedStrategy.js';

describe('StrategyFactory', () => {
  describe('createStrategy', () => {
    it('creates a WeightedStrategy when given weighted configuration', () => {
      const config: ChainMap<WeightedChainConfig> = {
        chain1: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        chain2: {
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      const strategy = StrategyFactory.createStrategy('weighted', config);
      expect(strategy).to.be.instanceOf(WeightedStrategy);
    });

    it('creates a MinAmountStrategy when given minAmount configuration', () => {
      const config: ChainMap<MinAmountChainConfig> = {
        chain1: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        chain2: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      };

      const strategy = StrategyFactory.createStrategy('minAmount', config);
      expect(strategy).to.be.instanceOf(MinAmountStrategy);
    });
  });
});
