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
              minAmount: ethers.utils.parseEther('100').toBigInt(),
              buffer: 0n,
            },
          }),
      ).to.throw('At least two chains must be configured');
    });

    it('should create a strategy with minAmount and buffer', () => {
      new MinAmountStrategy({
        [chain1]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain2]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
      });
    });

    it('should throw an error when minAmount is negative', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: ethers.utils.parseEther('100').toBigInt(),
              buffer: 0n,
            },
            [chain2]: {
              minAmount: ethers.utils.parseEther('-10').toBigInt(),
              buffer: 0n,
            },
          }),
      ).to.throw('Minimum amount cannot be negative');
    });

    it('should throw an error when buffer is negative', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: ethers.utils.parseEther('100').toBigInt(),
              buffer: -1n,
            },
            [chain2]: {
              minAmount: ethers.utils.parseEther('100').toBigInt(),
              buffer: 0n,
            },
          }),
      ).to.throw('Buffer must be between 0 and 10,000 basis points');
    });

    it('should throw an error when buffer is greater than 10,000', () => {
      expect(
        () =>
          new MinAmountStrategy({
            [chain1]: {
              minAmount: ethers.utils.parseEther('100').toBigInt(),
              buffer: 10_001n,
            },
            [chain2]: {
              minAmount: ethers.utils.parseEther('100').toBigInt(),
              buffer: 0n,
            },
          }),
      ).to.throw('Buffer must be between 0 and 10,000 basis points');
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should throw an error when raw balances chains length does not match configured chains length', () => {
      expect(() =>
        new MinAmountStrategy({
          [chain1]: {
            minAmount: ethers.utils.parseEther('100').toBigInt(),
            buffer: 0n,
          },
          [chain2]: {
            minAmount: ethers.utils.parseEther('100').toBigInt(),
            buffer: 0n,
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
            minAmount: ethers.utils.parseEther('100').toBigInt(),
            buffer: 0n,
          },
          [chain2]: {
            minAmount: ethers.utils.parseEther('100').toBigInt(),
            buffer: 0n,
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
            minAmount: ethers.utils.parseEther('100').toBigInt(),
            buffer: 0n,
          },
          [chain2]: {
            minAmount: ethers.utils.parseEther('100').toBigInt(),
            buffer: 0n,
          },
        }).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain2]: ethers.utils.parseEther('-200').toBigInt(),
        }),
      ).to.throw('Raw balance for chain chain2 is negative');
    });

    it('should return an empty array when all chains have at least the minimum amount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain2]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should return a single route when a chain is below minimum amount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain2]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('50').toBigInt(),
        [chain2]: ethers.utils.parseEther('150').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          fromChain: chain2,
          toChain: chain1,
          amount: ethers.utils.parseEther('50').toBigInt(),
        },
      ]);
    });

    it('should return multiple routes for multiple chains below minimum amount', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain2]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain3]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
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
          fromChain: chain3,
          toChain: chain1,
          amount: ethers.utils.parseEther('50').toBigInt(),
        },
        {
          fromChain: chain3,
          toChain: chain2,
          amount: ethers.utils.parseEther('25').toBigInt(),
        },
      ]);
    });

    it('should handle case where there is not enough surplus to meet all minimum requirements', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain2]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
        [chain3]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
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
      expect(routes[0].fromChain).to.equal(chain3);
      expect(routes[0].amount).to.equal(
        ethers.utils.parseEther('50').toBigInt(),
      );
    });

    it('should account for buffer > 0 when calculating deficits and surpluses', () => {
      const strategy = new MinAmountStrategy({
        [chain1]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 1_000n, // 10%
        },
        [chain2]: {
          minAmount: ethers.utils.parseEther('100').toBigInt(),
          buffer: 0n,
        },
      });

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('95').toBigInt(),
        [chain2]: ethers.utils.parseEther('120').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      // chain1 needs 15 more to reach 110, chain2 has 20 surplus
      expect(routes).to.deep.equal([
        {
          fromChain: chain2,
          toChain: chain1,
          amount: ethers.utils.parseEther('15').toBigInt(),
        },
      ]);
    });

    it('should consider surplus when chains are between minAmount and effectiveMin', () => {
      const minAmount = 100n;
      const buffer = 1_000n; // 10%
      const effectiveMin = (minAmount * (10_000n + buffer)) / 10_000n;
      const strategy = new MinAmountStrategy({
        [chain1]: { minAmount, buffer },
        [chain2]: { minAmount, buffer },
        [chain3]: { minAmount, buffer },
      });
      const rawBalances = {
        [chain1]: minAmount + 1n, // just above minAmount, below effectiveMin
        [chain2]: effectiveMin - 1n, // just below effectiveMin
        [chain3]: minAmount - 1n,
      };
      const routes = strategy.getRebalancingRoutes(rawBalances);
      expect(routes).to.deep.equal([
        {
          fromChain: chain2,
          toChain: chain3,
          amount: 9n,
        },
        {
          fromChain: chain1,
          toChain: chain3,
          amount: 1n,
        },
      ]);
    });

    it('should only consider deficit when below minAmount', () => {
      const minAmount = 100n;
      const buffer = 1_000n;
      const strategy = new MinAmountStrategy({
        [chain1]: { minAmount, buffer },
        [chain2]: { minAmount, buffer },
      });
      const rawBalances = {
        [chain1]: minAmount - 1n,
        [chain2]: minAmount + 100n,
      };
      const routes = strategy.getRebalancingRoutes(rawBalances);
      expect(routes).to.deep.equal([
        {
          fromChain: chain2,
          toChain: chain1,
          amount: 11n,
        },
      ]);
    });

    it('should have no surplus or deficit when all at minAmount', () => {
      const minAmount = 100n;
      const buffer = 1_000n;
      const strategy = new MinAmountStrategy({
        [chain1]: { minAmount, buffer },
        [chain2]: { minAmount, buffer },
      });
      const rawBalances = {
        [chain1]: minAmount,
        [chain2]: minAmount,
      };
      const routes = strategy.getRebalancingRoutes(rawBalances);
      expect(routes).to.be.empty;
    });

    it('should handle edge case: surplus and deficit at boundaries', () => {
      const minAmount = 100n;
      const buffer = 1_000n;
      const effectiveMin = (minAmount * (10_000n + buffer)) / 10_000n;
      const strategy = new MinAmountStrategy({
        [chain1]: { minAmount, buffer },
        [chain2]: { minAmount, buffer },
        [chain3]: { minAmount, buffer },
      });
      const rawBalances = {
        [chain1]: minAmount - 1n,
        [chain2]: effectiveMin,
        [chain3]: effectiveMin + 1n,
      };
      const routes = strategy.getRebalancingRoutes(rawBalances);
      expect(routes).to.deep.equal([
        {
          fromChain: chain3,
          toChain: chain1,
          amount: 11n,
        },
      ]);
    });
  });
});
