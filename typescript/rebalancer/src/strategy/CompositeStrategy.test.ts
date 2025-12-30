import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import type {
  IStrategy,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

import { CompositeStrategy } from './CompositeStrategy.js';

const testLogger = pino({ level: 'silent' });

const chain1 = 'chain1';
const chain2 = 'chain2';
const chain3 = 'chain3';

// Mock strategy for testing
class MockStrategy implements IStrategy {
  private routes: RebalancingRoute[];
  public callCount = 0;
  public lastInflightContext: any;

  constructor(routes: RebalancingRoute[]) {
    this.routes = routes;
  }

  getRebalancingRoutes(
    _rawBalances: RawBalances,
    inflightContext?: {
      pendingTransfers: RebalancingRoute[];
      pendingRebalances: RebalancingRoute[];
    },
  ): RebalancingRoute[] {
    this.callCount++;
    this.lastInflightContext = inflightContext;
    return this.routes;
  }
}

describe('CompositeStrategy', () => {
  describe('constructor', () => {
    it('should throw an error when no strategies are provided', () => {
      expect(() => new CompositeStrategy([], testLogger)).to.throw(
        'CompositeStrategy requires at least one sub-strategy',
      );
    });

    it('should create a strategy with valid configuration', () => {
      const mockStrategy = new MockStrategy([]);
      const composite = new CompositeStrategy([mockStrategy], testLogger);
      expect(composite).to.be.instanceOf(CompositeStrategy);
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should execute single strategy and return its routes', () => {
      const expectedRoutes: RebalancingRoute[] = [
        {
          origin: chain1,
          destination: chain2,
          amount: ethers.utils.parseEther('50').toBigInt(),
        },
      ];
      const mockStrategy = new MockStrategy(expectedRoutes);
      const composite = new CompositeStrategy([mockStrategy], testLogger);

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = composite.getRebalancingRoutes(rawBalances);

      expect(mockStrategy.callCount).to.equal(1);
      expect(routes).to.deep.equal(expectedRoutes);
    });

    it('should execute multiple strategies in sequence', () => {
      const routes1: RebalancingRoute[] = [
        {
          origin: chain1,
          destination: chain2,
          amount: ethers.utils.parseEther('30').toBigInt(),
          bridge: '0x1111111111111111111111111111111111111111',
        },
      ];
      const routes2: RebalancingRoute[] = [
        {
          origin: chain1,
          destination: chain3,
          amount: ethers.utils.parseEther('20').toBigInt(),
        },
      ];

      const strategy1 = new MockStrategy(routes1);
      const strategy2 = new MockStrategy(routes2);
      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('50').toBigInt(),
        [chain3]: ethers.utils.parseEther('50').toBigInt(),
      };

      const routes = composite.getRebalancingRoutes(rawBalances);

      expect(strategy1.callCount).to.equal(1);
      expect(strategy2.callCount).to.equal(1);
      expect(routes).to.deep.equal([...routes1, ...routes2]);
    });

    it('should pass routes from first strategy as pendingRebalances to second strategy', () => {
      const routes1: RebalancingRoute[] = [
        {
          origin: chain1,
          destination: chain2,
          amount: ethers.utils.parseEther('30').toBigInt(),
          bridge: '0x1111111111111111111111111111111111111111',
        },
      ];
      const routes2: RebalancingRoute[] = [];

      const strategy1 = new MockStrategy(routes1);
      const strategy2 = new MockStrategy(routes2);
      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('50').toBigInt(),
      };

      composite.getRebalancingRoutes(rawBalances);

      // First strategy should receive no pending rebalances
      expect(
        strategy1.lastInflightContext?.pendingRebalances || [],
      ).to.deep.equal([]);

      // Second strategy should receive routes from first strategy as pending rebalances
      expect(strategy2.lastInflightContext?.pendingRebalances).to.deep.equal(
        routes1,
      );
    });

    it('should pass through inflight context to first strategy', () => {
      const routes1: RebalancingRoute[] = [];
      const strategy1 = new MockStrategy(routes1);
      const composite = new CompositeStrategy([strategy1], testLogger);

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('50').toBigInt(),
      };

      const inflightContext = {
        pendingTransfers: [
          {
            origin: chain1,
            destination: chain2,
            amount: ethers.utils.parseEther('10').toBigInt(),
          },
        ],
        pendingRebalances: [
          {
            origin: chain2,
            destination: chain1,
            amount: ethers.utils.parseEther('5').toBigInt(),
          },
        ],
      };

      composite.getRebalancingRoutes(rawBalances, inflightContext);

      expect(strategy1.lastInflightContext).to.deep.equal(inflightContext);
    });

    it('should accumulate pending rebalances through multiple strategies', () => {
      const routes1: RebalancingRoute[] = [
        {
          origin: chain1,
          destination: chain2,
          amount: ethers.utils.parseEther('30').toBigInt(),
        },
      ];
      const routes2: RebalancingRoute[] = [
        {
          origin: chain2,
          destination: chain3,
          amount: ethers.utils.parseEther('20').toBigInt(),
        },
      ];
      const routes3: RebalancingRoute[] = [];

      const strategy1 = new MockStrategy(routes1);
      const strategy2 = new MockStrategy(routes2);
      const strategy3 = new MockStrategy(routes3);
      const composite = new CompositeStrategy(
        [strategy1, strategy2, strategy3],
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('50').toBigInt(),
        [chain3]: ethers.utils.parseEther('50').toBigInt(),
      };

      composite.getRebalancingRoutes(rawBalances);

      // Strategy 3 should see routes from both strategy 1 and 2
      expect(strategy3.lastInflightContext?.pendingRebalances).to.deep.equal([
        ...routes1,
        ...routes2,
      ]);
    });

    it('should return empty array when all strategies return empty', () => {
      const strategy1 = new MockStrategy([]);
      const strategy2 = new MockStrategy([]);
      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances = {
        [chain1]: ethers.utils.parseEther('100').toBigInt(),
        [chain2]: ethers.utils.parseEther('100').toBigInt(),
      };

      const routes = composite.getRebalancingRoutes(rawBalances);

      expect(routes).to.deep.equal([]);
    });
  });
});
