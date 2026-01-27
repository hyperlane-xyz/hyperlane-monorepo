import { expect } from 'chai';
import { pino } from 'pino';

import type { ChainName } from '@hyperlane-xyz/sdk';

import type {
  IStrategy,
  InflightContext,
  RawBalances,
  Route,
  StrategyRoute,
} from '../interfaces/IStrategy.js';

import { CompositeStrategy } from './CompositeStrategy.js';

const testLogger = pino({ level: 'silent' });
const TEST_BRIDGE = '0x1234567890123456789012345678901234567890';

class MockStrategy implements IStrategy {
  readonly name = 'mock';
  public lastInflightContext?: InflightContext;

  constructor(private readonly routesToReturn: StrategyRoute[]) {}

  getRebalancingRoutes(
    _rawBalances: RawBalances,
    inflightContext?: InflightContext,
  ): StrategyRoute[] {
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
      const route1: StrategyRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
        bridge: TEST_BRIDGE,
      };
      const route2: StrategyRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
        bridge: TEST_BRIDGE,
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

    it('should pass routes from earlier strategies as proposedRebalances to later strategies', () => {
      const route1: StrategyRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
        bridge: TEST_BRIDGE,
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

      // Strategy 1 should receive empty proposedRebalances (none from earlier strategies)
      expect(strategy1.lastInflightContext?.proposedRebalances).to.deep.equal(
        [],
      );

      // Strategy 2 should receive route1 as proposedRebalances (from earlier strategy)
      expect(
        strategy2.lastInflightContext?.proposedRebalances,
      ).to.have.lengthOf(1);
      expect(
        strategy2.lastInflightContext?.proposedRebalances?.[0],
      ).to.deep.equal(route1);
    });

    it('should accumulate routes across multiple strategies as proposedRebalances', () => {
      const route1: StrategyRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
        bridge: TEST_BRIDGE,
      };
      const route2: StrategyRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
        bridge: TEST_BRIDGE,
      };
      const route3: StrategyRoute = {
        origin: chain3,
        destination: chain1,
        amount: 3000n,
        bridge: TEST_BRIDGE,
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

      // Strategy 1: empty proposedRebalances (no earlier strategies)
      expect(strategy1.lastInflightContext?.proposedRebalances).to.deep.equal(
        [],
      );

      // Strategy 2: receives route1 as proposedRebalances
      expect(
        strategy2.lastInflightContext?.proposedRebalances,
      ).to.have.lengthOf(1);

      // Strategy 3: receives route1 + route2 as proposedRebalances
      expect(
        strategy3.lastInflightContext?.proposedRebalances,
      ).to.have.lengthOf(2);
      expect(
        strategy3.lastInflightContext?.proposedRebalances?.[0],
      ).to.deep.equal(route1);
      expect(
        strategy3.lastInflightContext?.proposedRebalances?.[1],
      ).to.deep.equal(route2);
    });

    it('should preserve original pendingRebalances and use proposedRebalances for new routes', () => {
      const originalPendingRebalance: StrategyRoute = {
        origin: chain3,
        destination: chain1,
        amount: 500n,
        bridge: TEST_BRIDGE,
      };

      const route1: StrategyRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
        bridge: TEST_BRIDGE,
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

      // Both strategies should receive the SAME original pendingRebalances (inflight intents)
      expect(strategy1.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        1,
      );
      expect(strategy1.lastInflightContext?.pendingRebalances[0]).to.deep.equal(
        originalPendingRebalance,
      );
      expect(strategy2.lastInflightContext?.pendingRebalances).to.have.lengthOf(
        1,
      );
      expect(strategy2.lastInflightContext?.pendingRebalances[0]).to.deep.equal(
        originalPendingRebalance,
      );

      // Strategy 1: empty proposedRebalances (no earlier strategies)
      expect(strategy1.lastInflightContext?.proposedRebalances).to.deep.equal(
        [],
      );

      // Strategy 2: receives route1 as proposedRebalances (from earlier strategy)
      expect(
        strategy2.lastInflightContext?.proposedRebalances,
      ).to.have.lengthOf(1);
      expect(
        strategy2.lastInflightContext?.proposedRebalances?.[0],
      ).to.deep.equal(route1);
    });

    it('should preserve pendingTransfers for all strategies', () => {
      const pendingTransfer: Route = {
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
      const route1a: StrategyRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
        bridge: TEST_BRIDGE,
      };
      const route1b: StrategyRoute = {
        origin: chain1,
        destination: chain3,
        amount: 1500n,
        bridge: TEST_BRIDGE,
      };
      const route2a: StrategyRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
        bridge: TEST_BRIDGE,
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
      const route2: StrategyRoute = {
        origin: chain2,
        destination: chain3,
        amount: 2000n,
        bridge: TEST_BRIDGE,
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
      const route1: StrategyRoute = {
        origin: chain1,
        destination: chain2,
        amount: 1000n,
        bridge: TEST_BRIDGE,
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
