import { expect } from 'chai';
import { ethers } from 'ethers';

import type { ChainName } from '@hyperlane-xyz/sdk';

import type { RawBalances } from '../interfaces/IStrategy.js';

import { MinAmountStrategy } from './MinAmountStrategy.js';

describe('MinAmountStrategy', () => {
  let chain1: ChainName;
  let chain2: ChainName;
  let chain3: ChainName;

  beforeEach(() => {
    chain1 = 'chain1';
    chain2 = 'chain2';
    chain3 = 'chain3';
  });

  describe('constructor', () => {
    it('should throw an error when less than two chains are configured', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: {
                min: ethers.utils.parseEther('100').toString(),
                target: ethers.utils.parseEther('120').toString(),
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          }),
      ).to.throw('At least two chains must be configured');
    });

    it('should create a strategy with minAmount and target using absolute values', () => {
      new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });
    });

    it('should create a strategy with minAmount and target using relative values', () => {
      new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: 0.3,
            target: 0.4,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: 0.4,
            target: 0.5,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });
    });

    it('should throw an error when minAmount is negative', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: {
                min: ethers.utils.parseEther('100').toString(),
                target: ethers.utils.parseEther('120').toString(),
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              minAmount: {
                min: ethers.utils.parseEther('-10').toString(),
                target: ethers.utils.parseEther('120').toString(),
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          }),
      ).to.throw('Minimum amount cannot be negative');
    });

    it('should throw an error when target is less than minAmount', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: {
                min: ethers.utils.parseEther('100').toString(),
                target: ethers.utils.parseEther('80').toString(),
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              minAmount: {
                min: ethers.utils.parseEther('100').toString(),
                target: ethers.utils.parseEther('120').toString(),
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          }),
      ).to.throw('Target must be greater than or equal to minAmount');
    });

    it('should throw an error when relative target is less than relative minAmount', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: {
                min: 0.5,
                target: 0.4,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              minAmount: {
                min: 0.3,
                target: 0.5,
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          }),
      ).to.throw('Target must be greater than or equal to minAmount');
    });

    it('should throw an error when raw balances chains length does not match configured chains length', () => {
      expect(() =>
        new MinAmountStrategy({
          [chain1]: {
            minAmount: {
              min: ethers.utils.parseEther('100').toString(),
              target: ethers.utils.parseEther('120').toString(),
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: ethers.utils.parseEther('100').toString(),
              target: ethers.utils.parseEther('120').toString(),
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        }).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain2]: ethers.utils.parseEther('200').toBigInt(),
          [chain3]: ethers.utils.parseEther('300').toBigInt(),
        }),
      ).to.throw('Config chains do not match raw balances chains length');
    });

    it('should throw an error when a raw balance is missing', () => {
      expect(() =>
        new MinAmountStrategy({
          [chain1]: {
            minAmount: {
              min: ethers.utils.parseEther('100').toString(),
              target: ethers.utils.parseEther('120').toString(),
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: ethers.utils.parseEther('100').toString(),
              target: ethers.utils.parseEther('120').toString(),
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        }).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain3]: ethers.utils.parseEther('300').toBigInt(),
        } as RawBalances),
      ).to.throw('Raw balance for chain chain2 not found');
    });

    it('should throw an error when a raw balance is negative', () => {
      expect(() =>
        new MinAmountStrategy({
          [chain1]: {
            minAmount: {
              min: ethers.utils.parseEther('100').toString(),
              target: ethers.utils.parseEther('120').toString(),
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: ethers.utils.parseEther('100').toString(),
              target: ethers.utils.parseEther('120').toString(),
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        }).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain2]: ethers.utils.parseEther('-200').toBigInt(),
        }),
      ).to.throw('Raw balance for chain chain2 is negative');
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should return an empty array when all chains have at least the minimum amount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances: RawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should return a single route when a chain is below minimum amount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('50').toBigInt(),
        [chain2]: ethers.utils.parseEther('200').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: ethers.utils.parseEther('70').toBigInt(),
        },
      ]);
    });

    it('should return multiple routes for multiple chains below minimum amount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain3]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('50').toBigInt(),
        [chain2]: ethers.utils.parseEther('75').toBigInt(),
        [chain3]: ethers.utils.parseEther('300').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain3,
          destination: chain1,
          amount: ethers.utils.parseEther('70').toBigInt(),
        },
        {
          origin: chain3,
          destination: chain2,
          amount: ethers.utils.parseEther('45').toBigInt(),
        },
      ]);
    });

    it('should handle case where there is not enough surplus to meet all minimum requirements', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('100').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('100').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain3]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('100').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('50').toBigInt(),
        [chain2]: ethers.utils.parseEther('50').toBigInt(),
        [chain3]: ethers.utils.parseEther('150').toBigInt(), // Only 50n of surplus, not enough to bring both chains up to minimum
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      // Should use all surplus but only partially address the deficits
      expect(routes.length).to.equal(1);
      expect(routes[0].origin).to.equal(chain3);
      expect(routes[0].amount).to.equal(
        ethers.utils.parseEther('50').toBigInt(),
      );
    });

    it('should have no surplus or deficit when all at minAmount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('110').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('110').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should consider the target amount with relative configuration', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: 0.25,
            target: 0.3,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: 0.25,
            target: 0.3,
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances: RawBalances = {
        [chain1]: ethers.utils.parseEther('200').toBigInt(),
        [chain2]: ethers.utils.parseEther('800').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: ethers.utils.parseEther('100').toBigInt(),
        },
      ]);
    });

    it('should consider the minAmount amount when calculating deficit', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
        [chain2]: {
          minAmount: {
            min: ethers.utils.parseEther('100').toString(),
            target: ethers.utils.parseEther('120').toString(),
          },
          bridge: ethers.constants.AddressZero,
          bridgeLockTime: 1,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('80').toBigInt(),
        [chain2]: ethers.utils.parseEther('130').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: ethers.utils.parseEther('30').toBigInt(),
        },
      ]);
    });
  });
});
