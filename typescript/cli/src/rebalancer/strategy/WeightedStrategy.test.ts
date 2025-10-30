import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import type { ChainName } from '@hyperlane-xyz/sdk';

import type { RawBalances } from '../interfaces/IStrategy.js';

import { WeightedStrategy } from './WeightedStrategy.js';

const testLogger = pino({ level: 'silent' });

describe('WeightedStrategy', () => {
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
          new WeightedStrategy(
            {
              [chain1]: {
                weighted: { weight: 100n, tolerance: 0n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
            testLogger,
          ),
      ).to.throw('At least two chains must be configured');
    });

    it('should throw an error when weight is negative', () => {
      expect(
        () =>
          new WeightedStrategy(
            {
              [chain1]: {
                weighted: { weight: 100n, tolerance: 0n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                weighted: { weight: -1n, tolerance: 0n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
            testLogger,
          ),
      ).to.throw('Weight (-1) must not be negative for chain2');
    });

    it('should throw an error when the total weight is 0', () => {
      expect(
        () =>
          new WeightedStrategy(
            {
              [chain1]: {
                weighted: { weight: 0n, tolerance: 0n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                weighted: { weight: 0n, tolerance: 0n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
            testLogger,
          ),
      ).to.throw('The total weight for all chains must be greater than 0');
    });

    it('should throw an error when tolerance is less than 0 or greater than 100', () => {
      expect(
        () =>
          new WeightedStrategy(
            {
              [chain1]: {
                weighted: { weight: 100n, tolerance: 0n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                weighted: { weight: 100n, tolerance: -1n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
            testLogger,
          ),
      ).to.throw('Tolerance (-1) must be between 0 and 100 for chain2');

      expect(
        () =>
          new WeightedStrategy(
            {
              [chain1]: {
                weighted: { weight: 100n, tolerance: 100n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                weighted: { weight: 100n, tolerance: 101n },
                bridge: ethers.constants.AddressZero,
                bridgeLockTime: 1,
              },
            },
            testLogger,
          ),
      ).to.throw('Tolerance (101) must be between 0 and 100 for chain2');
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should throw an error when raw balances chains length does not match configured chains length', () => {
      expect(() =>
        new WeightedStrategy(
          {
            [chain1]: {
              weighted: { weight: 100n, tolerance: 0n },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              weighted: { weight: 100n, tolerance: 0n },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          },
          testLogger,
        ).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain2]: ethers.utils.parseEther('200').toBigInt(),
          [chain3]: ethers.utils.parseEther('300').toBigInt(),
        }),
      ).to.throw('Config chains do not match raw balances chains length');
    });

    it('should throw an error when a raw balance is missing', () => {
      expect(() =>
        new WeightedStrategy(
          {
            [chain1]: {
              weighted: { weight: 100n, tolerance: 0n },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              weighted: { weight: 100n, tolerance: 0n },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          },
          testLogger,
        ).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain3]: ethers.utils.parseEther('300').toBigInt(),
        } as RawBalances),
      ).to.throw('Raw balance for chain chain2 not found');
    });

    it('should throw an error when a raw balance is negative', () => {
      expect(() =>
        new WeightedStrategy(
          {
            [chain1]: {
              weighted: { weight: 100n, tolerance: 0n },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              weighted: { weight: 100n, tolerance: 0n },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
          },
          testLogger,
        ).getRebalancingRoutes({
          [chain1]: ethers.utils.parseEther('100').toBigInt(),
          [chain2]: ethers.utils.parseEther('-200').toBigInt(),
        }),
      ).to.throw('Raw balance for chain chain2 is negative');
    });

    it('should return an empty array when all chains are balanced', () => {
      const strategy = new WeightedStrategy(
        {
          [chain1]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should return a single route when a chain is unbalanced', () => {
      const strategy = new WeightedStrategy(
        {
          [chain1]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('200').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: ethers.utils.parseEther('50').toBigInt(),
        },
      ]);
    });

    it('should return an empty array when a chain is unbalanced but has tolerance', () => {
      const strategy = new WeightedStrategy(
        {
          [chain1]: {
            weighted: { weight: 100n, tolerance: 1n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            weighted: { weight: 100n, tolerance: 1n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('101').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should return a single route when two chains are unbalanced and can be solved with a single transfer', () => {
      const strategy = new WeightedStrategy(
        {
          [chain1]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain3]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('200').toBigInt(),
        [chain3]: ethers.utils.parseEther('300').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain3,
          destination: chain1,
          amount: ethers.utils.parseEther('100').toBigInt(),
        },
      ]);
    });
    it('should return two routes when two chains are unbalanced and cannot be solved with a single transfer', () => {
      const strategy = new WeightedStrategy(
        {
          [chain1]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain3]: {
            weighted: { weight: 100n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
        [chain3]: ethers.utils.parseEther('500').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain3,
          destination: chain1,
          amount: 133333333333333333333n,
        },
        {
          origin: chain3,
          destination: chain2,
          amount: 133333333333333333333n,
        },
      ]);
    });

    it('should return routes to balance different weighted chains', () => {
      const strategy = new WeightedStrategy(
        {
          [chain1]: {
            weighted: { weight: 50n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            weighted: { weight: 25n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [chain3]: {
            weighted: { weight: 25n, tolerance: 0n },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
        [chain3]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: ethers.utils.parseEther('25').toBigInt(),
        },
        {
          origin: chain3,
          destination: chain1,
          amount: ethers.utils.parseEther('25').toBigInt(),
        },
      ]);
    });
  });
});
