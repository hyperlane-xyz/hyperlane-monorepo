import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import { CollateralDeficitStrategy } from './CollateralDeficitStrategy.js';

const testLogger = pino({ level: 'silent' });

const chain1 = 'chain1';
const chain2 = 'chain2';
const chain3 = 'chain3';
const bridge1 = '0x1111111111111111111111111111111111111111';
const bridge2 = '0x2222222222222222222222222222222222222222';
const bridge3 = '0x3333333333333333333333333333333333333333';

describe('CollateralDeficitStrategy', () => {
  describe('constructor', () => {
    it('should throw an error when less than two chains are configured', () => {
      expect(
        () =>
          new CollateralDeficitStrategy(
            {
              [chain1]: {
                bridge: bridge1,
                buffer: 0n,
              },
            },
            testLogger,
          ),
      ).to.throw('At least two chains must be configured');
    });

    it('should create a strategy with valid configuration', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: {
            bridge: bridge1,
            buffer: ethers.utils.parseEther('100').toBigInt(),
          },
          [chain2]: {
            bridge: bridge2,
            buffer: ethers.utils.parseEther('50').toBigInt(),
          },
        },
        testLogger,
      );

      expect(strategy).to.be.instanceOf(CollateralDeficitStrategy);
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should return empty array when no chains have negative balances', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);
      expect(routes).to.deep.equal([]);
    });

    it('should return empty array when all balances are zero', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: 0n,
        [chain2]: 0n,
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);
      expect(routes).to.deep.equal([]);
    });

    it('should return route when a chain has negative balance', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      // chain1 has negative balance (deficit), chain2 has surplus
      const rawBalances = {
        [chain1]: ethers.utils.parseEther('-50').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.have.lengthOf(1);
      expect(routes[0]).to.deep.equal({
        origin: chain2,
        destination: chain1,
        amount: ethers.utils.parseEther('50').toBigInt(),
        bridge: bridge1, // Uses destination chain's bridge
      });
    });

    it('should apply buffer to deficit calculation', () => {
      const buffer = ethers.utils.parseEther('10').toBigInt();
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      // chain1 has -50 balance, with buffer of 10, deficit should be 60
      const rawBalances = {
        [chain1]: ethers.utils.parseEther('-50').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.have.lengthOf(1);
      expect(routes[0].amount).to.equal(
        ethers.utils.parseEther('60').toBigInt(),
      );
    });

    it('should handle multiple chains with deficits', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
          [chain3]: { bridge: bridge3, buffer: 0n },
        },
        testLogger,
      );

      // chain1 and chain2 have deficits, chain3 has surplus
      const rawBalances = {
        [chain1]: ethers.utils.parseEther('-30').toBigInt(),
        [chain2]: ethers.utils.parseEther('-20').toBigInt(),
        [chain3]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = strategy.getRebalancingRoutes(rawBalances);

      expect(routes).to.have.lengthOf(2);
      // Routes should cover both deficits
      const totalTransferred = routes.reduce((sum, r) => sum + r.amount, 0n);
      expect(totalTransferred).to.equal(
        ethers.utils.parseEther('50').toBigInt(),
      );
    });

    it('should skip routes that already have pending rebalances to same destination', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('-50').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      // Simulate pending rebalance to chain1 using same bridge
      const inflightContext = {
        pendingTransfers: [],
        pendingRebalances: [
          {
            origin: chain2,
            destination: chain1,
            amount: ethers.utils.parseEther('50').toBigInt(),
            bridge: bridge1, // Same bridge as chain1
          },
        ],
      };

      const routes = strategy.getRebalancingRoutes(
        rawBalances,
        inflightContext,
      );

      // Should not duplicate the route since there's already a pending rebalance
      expect(routes).to.deep.equal([]);
    });

    it('should include route when pending rebalance uses different bridge', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('-50').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      // Pending rebalance uses different bridge
      const inflightContext = {
        pendingTransfers: [],
        pendingRebalances: [
          {
            origin: chain2,
            destination: chain1,
            amount: ethers.utils.parseEther('50').toBigInt(),
            bridge: '0x9999999999999999999999999999999999999999', // Different bridge
          },
        ],
      };

      const routes = strategy.getRebalancingRoutes(
        rawBalances,
        inflightContext,
      );

      // Should include route since pending rebalance uses different bridge
      expect(routes).to.have.lengthOf(1);
    });

    it('should reserve collateral for pending transfers on destination chain', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: bridge1, buffer: 0n },
          [chain2]: { bridge: bridge2, buffer: 0n },
        },
        testLogger,
      );

      // chain1 has -50 deficit, chain2 has 100 surplus
      // Pending transfer TO chain1 means chain1 needs to reserve collateral for payout
      const rawBalances = {
        [chain1]: ethers.utils.parseEther('-50').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const inflightContext = {
        pendingTransfers: [
          {
            origin: chain2,
            destination: chain1,
            amount: ethers.utils.parseEther('80').toBigInt(),
          },
        ],
        pendingRebalances: [],
      };

      const routes = strategy.getRebalancingRoutes(
        rawBalances,
        inflightContext,
      );

      // After reserving 80 on destination (chain1): chain1 = -50 - 80 = -130 (worse deficit)
      // chain2 still has 100 surplus (origin balance already reduced on-chain when transfer initiated)
      // Deficit = 130, surplus = 100, so scaled route = 100
      expect(routes).to.have.lengthOf(1);
      expect(routes[0].amount).to.equal(
        ethers.utils.parseEther('100').toBigInt(),
      );
    });
  });
});
