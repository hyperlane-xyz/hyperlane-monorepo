import { expect } from 'chai';
import { pino } from 'pino';

import type { ChainName } from '@hyperlane-xyz/sdk';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  RebalancingRoute,
} from '../interfaces/IStrategy.js';

import { CompositeStrategy } from './CompositeStrategy.js';

const testLogger = pino({ level: 'silent' });

/**
 * Mock strategy that returns predefined routes and captures the context it receives.
 */
class MockStrategy implements IStrategy {
  readonly name = 'mock';
  public lastInflightContext?: InflightContext;

  constructor(private readonly routesToReturn: RebalancingRoute[]) {}

  getRebalancingRoutes(
    _rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): RebalancingRoute[] {
    this.lastInflightContext = inflightContext;
    return this.routesToReturn;
  }
}

describe('CompositeStrategy', () => {
  let chain1: ChainName;
  let chain2: ChainName;
  let chain3: ChainName;

  beforeEach(() => {
    chain1 = 'chain1';
    chain2 = 'chain2';
    chain3 = 'chain3';
  });

  describe('constructor', () => {
    it('should throw an error when less than 2 strategies are provided', () => {
      const mockStrategy = new MockStrategy([]);

      expect(() => new CompositeStrategy([mockStrategy], testLogger)).to.throw(
        'CompositeStrategy requires at least 2 sub-strategies',
      );
    });

    it('should throw an error when no strategies are provided', () => {
      expect(() => new CompositeStrategy([], testLogger)).to.throw(
        'CompositeStrategy requires at least 2 sub-strategies',
      );
    });

    it('should create a strategy with 2+ sub-strategies', () => {
      const strategy1 = new MockStrategy([]);
      const strategy2 = new MockStrategy([]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );
      expect(composite).to.be.instanceOf(CompositeStrategy);
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should concatenate routes from all sub-strategies', () => {
      const route1: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
      };
      const route2: RebalancingRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
      };

      const strategy1 = new MockStrategy([route1]);
      const strategy2 = new MockStrategy([route2]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
        [chain3]: 3000n,
      };

      const routes = composite.getRebalancingRoutes(rawBalances);

      expect(routes).to.have.lengthOf(2);
      expect(routes[0]).to.deep.equal(route1);
      expect(routes[1]).to.deep.equal(route2);
    });

    it('should pass routes from earlier strategies as pendingRebalances to later strategies', () => {
      const route1: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
      };

      const strategy1 = new MockStrategy([route1]);
      const strategy2 = new MockStrategy([]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
      };

      composite.getRebalancingRoutes(rawBalances);

      // Strategy 1 should receive empty pendingRebalances (none provided initially)
      expect(strategy1.lastInflightContext?.pendingRebalances).to.deep.equal(
        [],
      );

      // Strategy 2 should receive route1 as pendingRebalances
      expect(strategy2.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        1,
      );
      expect(strategy2.lastInflightContext?.pendingRebalances[0]).to.deep.equal(
        route1,
      );
    });

    it('should accumulate routes across multiple strategies', () => {
      const route1: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
      };
      const route2: RebalancingRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
      };
      const route3: RebalancingRoute = {
        origin: chain3,
        destination: chain1,
        amount: 3000n,
      };

      const strategy1 = new MockStrategy([route1]);
      const strategy2 = new MockStrategy([route2]);
      const strategy3 = new MockStrategy([route3]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2, strategy3],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
        [chain3]: 3000n,
      };

      composite.getRebalancingRoutes(rawBalances);

      // Strategy 1: empty pendingRebalances
      expect(strategy1.lastInflightContext?.pendingRebalances).to.deep.equal(
        [],
      );

      // Strategy 2: receives route1
      expect(strategy2.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        1,
      );

      // Strategy 3: receives route1 + route2
      expect(strategy3.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        2,
      );
      expect(strategy3.lastInflightContext?.pendingRebalances[0]).to.deep.equal(
        route1,
      );
      expect(strategy3.lastInflightContext?.pendingRebalances[1]).to.deep.equal(
        route2,
      );
    });

    it('should preserve original pendingRebalances in the context', () => {
      const originalPendingRebalance: RebalancingRoute = {
        origin: chain3,
        destination: chain1,
        amount: 500n,
      };

      const route1: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
      };

      const strategy1 = new MockStrategy([route1]);
      const strategy2 = new MockStrategy([]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
        [chain3]: 3000n,
      };

      const inflightContext: InflightContext = {
        pendingTransfers: [],
        pendingRebalances: [originalPendingRebalance],
      };

      composite.getRebalancingRoutes(rawBalances, inflightContext);

      // Strategy 1 should receive the original pendingRebalance
      expect(strategy1.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        1,
      );
      expect(strategy1.lastInflightContext?.pendingRebalances[0]).to.deep.equal(
        originalPendingRebalance,
      );

      // Strategy 2 should receive original + route1
      expect(strategy2.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        2,
      );
      expect(strategy2.lastInflightContext?.pendingRebalances[0]).to.deep.equal(
        originalPendingRebalance,
      );
      expect(strategy2.lastInflightContext?.pendingRebalances[1]).to.deep.equal(
        route1,
      );
    });

    it('should preserve pendingTransfers for all strategies', () => {
      const pendingTransfer: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 500n,
      };

      const strategy1 = new MockStrategy([]);
      const strategy2 = new MockStrategy([]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
      };

      const inflightContext: InflightContext = {
        pendingTransfers: [pendingTransfer],
        pendingRebalances: [],
      };

      composite.getRebalancingRoutes(rawBalances, inflightContext);

      // Both strategies should receive the same pendingTransfers
      expect(strategy1.lastInflightContext?.pendingTransfers).to.deep.equal([
        pendingTransfer,
      ]);
      expect(strategy2.lastInflightContext?.pendingTransfers).to.deep.equal([
        pendingTransfer,
      ]);
    });

    it('should maintain route order (first strategy routes come first)', () => {
      const route1a: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
      };
      const route1b: RebalancingRoute = {
        origin: chain1,
        destination: chain3,
        amount: 1500n,
      };
      const route2a: RebalancingRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
      };

      const strategy1 = new MockStrategy([route1a, route1b]);
      const strategy2 = new MockStrategy([route2a]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
        [chain3]: 3000n,
      };

      const routes = composite.getRebalancingRoutes(rawBalances);

      expect(routes).to.have.lengthOf(3);
      expect(routes[0]).to.deep.equal(route1a);
      expect(routes[1]).to.deep.equal(route1b);
      expect(routes[2]).to.deep.equal(route2a);
    });

    it('should handle strategies that return no routes', () => {
      const route2: RebalancingRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
      };

      const strategy1 = new MockStrategy([]);
      const strategy2 = new MockStrategy([route2]);
      const strategy3 = new MockStrategy([]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2, strategy3],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
        [chain3]: 3000n,
      };

      const routes = composite.getRebalancingRoutes(rawBalances);

      expect(routes).to.have.lengthOf(1);
      expect(routes[0]).to.deep.equal(route2);
    });

    it('should handle undefined inflightContext', () => {
      const route1: RebalancingRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
      };

      const strategy1 = new MockStrategy([route1]);
      const strategy2 = new MockStrategy([]);

      const composite = new CompositeStrategy(
        [strategy1, strategy2],
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5000n,
        [chain2]: 10000n,
      };

      const routes = composite.getRebalancingRoutes(rawBalances, undefined);

      expect(routes).to.have.lengthOf(1);
      expect(strategy1.lastInflightContext?.pendingTransfers).to.deep.equal([]);
      expect(strategy1.lastInflightContext?.pendingRebalances).to.deep.equal(
        [],
      );
    });
  });
});
