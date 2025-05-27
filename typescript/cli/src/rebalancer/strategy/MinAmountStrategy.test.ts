import { AddressZero } from '@ethersproject/constants';
import { expect } from 'chai';

import {
  type ChainMap,
  type ChainName,
  Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';

import { MinAmountType } from '../config/Config.js';
import type { RawBalances } from '../interfaces/IStrategy.js';

import { MinAmountStrategy } from './MinAmountStrategy.js';

describe('MinAmountStrategy', () => {
  let chain1: ChainName;
  let chain2: ChainName;
  let chain3: ChainName;
  const tokensByChainName: ChainMap<Token> = {};
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
    chain3 = 'chain3';
    tokensByChainName[chain1] = new Token({ ...tokenArgs, chainName: chain1 });
    tokensByChainName[chain2] = new Token({ ...tokenArgs, chainName: chain2 });
    tokensByChainName[chain3] = new Token({ ...tokenArgs, chainName: chain3 });
  });

  describe('constructor', () => {
    it('should throw an error when less than two chains are configured', () => {
      expect(
        () =>
          new MinAmountStrategy(
            {
              [chain1]: {
                minAmount: {
                  min: '100',
                  target: '120',
                  type: MinAmountType.Absolute,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
            },
            tokensByChainName,
          ),
      ).to.throw('At least two chains must be configured');
    });

    it('should create a strategy with minAmount and target using absolute values', () => {
      new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );
    });

    it('should create a strategy with minAmount and target using relative values', () => {
      new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: 0.3,
              target: 0.4,
              type: MinAmountType.Relative,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: 0.4,
              target: 0.5,
              type: MinAmountType.Relative,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );
    });

    it('should throw an error when minAmount is negative', () => {
      expect(
        () =>
          new MinAmountStrategy(
            {
              [chain1]: {
                minAmount: {
                  min: 100,
                  target: '120',
                  type: MinAmountType.Absolute,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                minAmount: {
                  min: '-10',
                  target: '120',
                  type: MinAmountType.Absolute,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
            },
            tokensByChainName,
          ),
      ).to.throw('Minimum amount (-10) cannot be negative for chain chain2');
    });

    it('should throw an error when target is less than min', () => {
      expect(
        () =>
          new MinAmountStrategy(
            {
              [chain1]: {
                minAmount: {
                  min: '100',
                  target: '80',
                  type: MinAmountType.Absolute,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                minAmount: {
                  min: '100',
                  target: '120',
                  type: MinAmountType.Absolute,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
            },
            tokensByChainName,
          ),
      ).to.throw(
        'Target (80) must be greater than or equal to min (100) for chain chain1',
      );
    });

    it('should throw an error when relative target is less than relative min', () => {
      expect(
        () =>
          new MinAmountStrategy(
            {
              [chain1]: {
                minAmount: {
                  min: 0.5,
                  target: 0.4,
                  type: MinAmountType.Relative,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
              [chain2]: {
                minAmount: {
                  min: 0.3,
                  target: 0.5,
                  type: MinAmountType.Relative,
                },
                bridge: AddressZero,
                bridgeLockTime: 1,
              },
            },
            tokensByChainName,
          ),
      ).to.throw(
        'Target (0.4) must be greater than or equal to min (0.5) for chain chain1',
      );
    });

    it('should throw an error when raw balances chains length does not match configured chains length', () => {
      expect(() =>
        new MinAmountStrategy(
          {
            [chain1]: {
              minAmount: {
                min: '100',
                target: '120',
                type: MinAmountType.Absolute,
              },
              bridge: AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              minAmount: {
                min: '100',
                target: '120',
                type: MinAmountType.Absolute,
              },
              bridge: AddressZero,
              bridgeLockTime: 1,
            },
          },
          tokensByChainName,
        ).getRebalancingRoutes({
          [chain1]: 100n,
          [chain2]: 200n,
          [chain3]: 300n,
        }),
      ).to.throw('Config chains do not match raw balances chains length');
    });

    it('should throw an error when a raw balance is missing', () => {
      expect(() =>
        new MinAmountStrategy(
          {
            [chain1]: {
              minAmount: {
                min: '100',
                target: '120',
                type: MinAmountType.Absolute,
              },
              bridge: AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              minAmount: {
                min: '100',
                target: '120',
                type: MinAmountType.Absolute,
              },
              bridge: AddressZero,
              bridgeLockTime: 1,
            },
          },
          tokensByChainName,
        ).getRebalancingRoutes({
          [chain1]: 100n,
          [chain3]: 300n,
        } as RawBalances),
      ).to.throw('Raw balance for chain chain2 not found');
    });

    it('should throw an error when a raw balance is negative', () => {
      expect(() =>
        new MinAmountStrategy(
          {
            [chain1]: {
              minAmount: {
                min: '100',
                target: '120',
                type: MinAmountType.Absolute,
              },
              bridge: AddressZero,
              bridgeLockTime: 1,
            },
            [chain2]: {
              minAmount: {
                min: '100',
                target: '120',
                type: MinAmountType.Absolute,
              },
              bridge: AddressZero,
              bridgeLockTime: 1,
            },
          },
          tokensByChainName,
        ).getRebalancingRoutes({
          [chain1]: 100n,
          [chain2]: -2n,
        }),
      ).to.throw('Raw balance for chain chain2 is negative');
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should return an empty array when all chains have at least the minimum amount', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances: RawBalances = {
        [chain1]: 100n,
        [chain2]: 100n,
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should return a single route when a chain is below minimum amount', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances = {
        [chain1]: BigInt(50e18),
        [chain2]: BigInt(200e18),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: BigInt(70e18),
        },
      ]);
    });

    it('should return multiple routes for multiple chains below minimum amount', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain3]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances = {
        [chain1]: BigInt(50e18),
        [chain2]: BigInt(75e18),
        [chain3]: BigInt(300e18),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain3,
          destination: chain1,
          amount: BigInt(70e18),
        },
        {
          origin: chain3,
          destination: chain2,
          amount: BigInt(45e18),
        },
      ]);
    });

    it('should handle case where there is not enough surplus to meet all minimum requirements by scaling down deficits', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '100',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '100',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain3]: {
            minAmount: {
              min: '100',
              target: '100',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances = {
        [chain1]: BigInt(50e18),
        [chain2]: BigInt(50e18),
        [chain3]: BigInt(150e18), // Only 50n of surplus, not enough to bring both chains up to minimum
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      // It scales down the deficits to prevent sending all surplus to a single chain
      expect(routes.length).to.equal(2);
      expect(routes[0].origin).to.equal(chain3);
      expect(routes[0].destination).to.equal(chain1);
      expect(routes[0].amount).to.equal(BigInt(25e18));
      expect(routes[1].origin).to.equal(chain3);
      expect(routes[1].destination).to.equal(chain2);
      expect(routes[1].amount).to.equal(BigInt(25e18));
    });

    it('should have no surplus or deficit when all at min', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '110',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '110',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances = {
        [chain1]: 100n,
        [chain2]: 100n,
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.be.empty;
    });

    it('should consider the target amount with relative configuration', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: 0.25,
              target: 0.3,
              type: MinAmountType.Relative,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: 0.25,
              target: 0.3,
              type: MinAmountType.Relative,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances: RawBalances = {
        [chain1]: 200n,
        [chain2]: 800n,
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: 100n,
        },
      ]);
    });

    it('should consider the min amount when calculating deficit', () => {
      const strategy = new MinAmountStrategy(
        {
          [chain1]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
          [chain2]: {
            minAmount: {
              min: '100',
              target: '120',
              type: MinAmountType.Absolute,
            },
            bridge: AddressZero,
            bridgeLockTime: 1,
          },
        },
        tokensByChainName,
      );

      const rawBalances = {
        [chain1]: BigInt(80e18),
        [chain2]: BigInt(130e18),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([
        {
          origin: chain2,
          destination: chain1,
          amount: BigInt(30e18),
        },
      ]);
    });
  });
});
