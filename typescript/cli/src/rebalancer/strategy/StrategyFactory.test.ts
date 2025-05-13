import { expect } from 'chai';
import { ethers } from 'ethers';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import type {
  ChainConfig,
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
          strategyType: 'weighted',
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
        },
        chain2: {
          strategyType: 'weighted',
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
        },
      };

      const strategy = StrategyFactory.createStrategy(config);
      expect(strategy).to.be.instanceOf(WeightedStrategy);
    });

    it('creates a MinAmountStrategy when given minAmount configuration', () => {
      const config: ChainMap<MinAmountChainConfig> = {
        chain1: {
          strategyType: 'minAmount',
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          bridge: ethers.constants.AddressZero,
        },
        chain2: {
          strategyType: 'minAmount',
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          bridge: ethers.constants.AddressZero,
        },
      };

      const strategy = StrategyFactory.createStrategy(config);
      expect(strategy).to.be.instanceOf(MinAmountStrategy);
    });

    it('throws an error when chains have different strategy types', () => {
      const config: ChainMap<ChainConfig> = {
        chain1: {
          strategyType: 'weighted',
          weight: 100n,
          tolerance: 0n,
          bridge: ethers.constants.AddressZero,
        },
        chain2: {
          strategyType: 'minAmount',
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          bridge: ethers.constants.AddressZero,
        },
      };

      expect(() => StrategyFactory.createStrategy(config)).to.throw(
        'All chains must use the same strategy type',
      );
    });

    it('throws an error when no chains are provided', () => {
      const config: ChainMap<ChainConfig> = {};

      expect(() => StrategyFactory.createStrategy(config)).to.throw(
        'Configuration must include at least one chain',
      );
    });
  });
});
