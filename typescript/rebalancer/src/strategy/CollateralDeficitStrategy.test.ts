import { expect } from 'chai';
import { pino } from 'pino';

import {
  type ChainMap,
  type ChainName,
  Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type { RawBalances, StrategyRoute } from '../interfaces/IStrategy.js';

import { CollateralDeficitStrategy } from './CollateralDeficitStrategy.js';

const testLogger = pino({ level: 'silent' });

const BRIDGE1 = '0x1234567890123456789012345678901234567890' as Address;
const BRIDGE2 = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;
const OTHER_BRIDGE = '0x9876543210987654321098765432109876543210' as Address;

describe('CollateralDeficitStrategy', () => {
  let chain1: ChainName;
  let chain2: ChainName;
  let chain3: ChainName;
  const tokensByChainName: ChainMap<Token> = {};
  const tokenArgs = {
    name: 'USDC',
    decimals: 6, // USDC has 6 decimals
    symbol: 'USDC',
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
          new CollateralDeficitStrategy(
            {
              [chain1]: {
                bridge: BRIDGE1,
                buffer: '1000',
              },
            },
            tokensByChainName,
            testLogger,
          ),
      ).to.throw('At least two chains must be configured');
    });

    it('should create a strategy with valid config', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: {
            bridge: BRIDGE1,
            buffer: '1000',
          },
          [chain2]: {
            bridge: BRIDGE2,
            buffer: '500',
          },
        },
        tokensByChainName,
        testLogger,
      );
      expect(strategy).to.be.instanceOf(CollateralDeficitStrategy);
    });
  });

  describe('getCategorizedBalances', () => {
    it('should detect deficit when balance is negative and add buffer', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: -5_000_000n, // -5 USDC (6 decimals)
        [chain2]: 10_000_000n, // 10 USDC
      };

      const result = strategy['getCategorizedBalances'](rawBalances);

      // chain1: deficit = |-5 USDC| + 1000 USDC = 1005 USDC = 1005000000 (wei)
      expect(result.deficits).to.have.lengthOf(1);
      expect(result.deficits[0].chain).to.equal(chain1);
      expect(result.deficits[0].amount).to.equal(1_005_000_000n);

      // chain2: surplus = 10 USDC
      expect(result.surpluses).to.have.lengthOf(1);
      expect(result.surpluses[0].chain).to.equal(chain2);
      expect(result.surpluses[0].amount).to.equal(10_000_000n);
    });

    it('should treat zero balance as neither surplus nor deficit', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 0n,
        [chain2]: 10_000_000n,
      };

      const result = strategy['getCategorizedBalances'](rawBalances);

      expect(result.deficits).to.have.lengthOf(0);
      expect(result.surpluses).to.have.lengthOf(1);
      expect(result.surpluses[0].chain).to.equal(chain2);
    });

    it('should treat positive balance as surplus', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: 5_000_000n, // 5 USDC
        [chain2]: 10_000_000n, // 10 USDC
      };

      const result = strategy['getCategorizedBalances'](rawBalances);

      expect(result.deficits).to.have.lengthOf(0);
      expect(result.surpluses).to.have.lengthOf(2);
    });

    it('should filter pending rebalances by configured bridges and simulate', () => {
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      const rawBalances: RawBalances = {
        [chain1]: -10_000_000n, // -10 USDC before simulation
        [chain2]: 20_000_000n, // 20 USDC
      };

      const pendingRebalances: StrategyRoute[] = [
        {
          origin: chain2,
          destination: chain1,
          amount: 5_000_000n, // 5 USDC pending to chain1
          bridge: BRIDGE2, // Matches chain2's bridge (origin)
        },
      ];

      const result = strategy['getCategorizedBalances'](
        rawBalances,
        pendingRebalances,
      );

      // After simulation: chain1 = -10 + 5 = -5 USDC (destination increase)
      // Deficit = |-5| + 1000 = 1005 USDC
      expect(result.deficits).to.have.lengthOf(1);
      expect(result.deficits[0].chain).to.equal(chain1);
      expect(result.deficits[0].amount).to.equal(1_005_000_000n);

      // chain2 after simulation: 20 USDC (no change - origin already deducted on-chain)
      // Simulation only adds to destination, doesn't subtract from origin
      expect(result.surpluses).to.have.lengthOf(1);
      expect(result.surpluses[0].chain).to.equal(chain2);
      expect(result.surpluses[0].amount).to.equal(20_000_000n);
    });

    it('should filter out pending rebalances with different bridge', () => {
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      const rawBalances: RawBalances = {
        [chain1]: -10_000_000n,
        [chain2]: 20_000_000n,
      };

      const pendingRebalances: StrategyRoute[] = [
        {
          origin: chain2,
          destination: chain1,
          amount: 5_000_000n,
          bridge: OTHER_BRIDGE, // Does NOT match chain1's bridge
        },
      ];

      const result = strategy['getCategorizedBalances'](
        rawBalances,
        pendingRebalances,
      );

      // Pending rebalance should be filtered out, so no simulation
      // Deficit = |-10| + 1000 = 1010 USDC
      expect(result.deficits).to.have.lengthOf(1);
      expect(result.deficits[0].amount).to.equal(1_010_000_000n);

      // chain2: no subtraction, stays at 20 USDC
      expect(result.surpluses[0].amount).to.equal(20_000_000n);
    });

    it('should handle pending rebalance that fully covers deficit', () => {
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      const rawBalances: RawBalances = {
        [chain1]: -5_000_000n, // -5 USDC
        [chain2]: 20_000_000n,
      };

      const pendingRebalances: StrategyRoute[] = [
        {
          origin: chain2,
          destination: chain1,
          amount: 10_000_000n, // 10 USDC pending - more than enough
          bridge: BRIDGE2, // Matches chain2's bridge (origin)
        },
      ];

      const result = strategy['getCategorizedBalances'](
        rawBalances,
        pendingRebalances,
      );

      // After simulation: chain1 = -5 + 10 = 5 USDC (positive, no deficit)
      expect(result.deficits).to.have.lengthOf(0);
      expect(result.surpluses).to.have.lengthOf(2); // Both chains have surplus
    });

    it('should handle multiple chains with mixed balances', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
          [chain3]: { bridge: BRIDGE1, buffer: '2000' },
        },
        tokensByChainName,
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: -5_000_000n, // -5 USDC -> deficit
        [chain2]: 10_000_000n, // 10 USDC -> surplus
        [chain3]: -3_000_000n, // -3 USDC -> deficit
      };

      const result = strategy['getCategorizedBalances'](rawBalances);

      expect(result.deficits).to.have.lengthOf(2);
      expect(result.surpluses).to.have.lengthOf(1);

      // chain1: deficit = 5 + 1000 = 1005 USDC
      const chain1Deficit = result.deficits.find((d) => d.chain === chain1);
      expect(chain1Deficit?.amount).to.equal(1_005_000_000n);

      // chain3: deficit = 3 + 2000 = 2003 USDC
      const chain3Deficit = result.deficits.find((d) => d.chain === chain3);
      expect(chain3Deficit?.amount).to.equal(2_003_000_000n);
    });

    it('should handle empty pending rebalances array', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
      );

      const rawBalances: RawBalances = {
        [chain1]: -5_000_000n,
        [chain2]: 10_000_000n,
      };

      const result = strategy['getCategorizedBalances'](rawBalances, []);

      // No simulation should occur
      expect(result.deficits).to.have.lengthOf(1);
      expect(result.deficits[0].amount).to.equal(1_005_000_000n);
    });
  });

  describe('getRebalancingRoutes', () => {
    it('should set bridge field on output routes', () => {
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      // Start with positive balances
      const rawBalances: RawBalances = {
        [chain1]: 2_000_000n, // 2 USDC
        [chain2]: 20_000_000n, // 20 USDC
      };

      // Pending transfer will drain chain1 to create deficit
      const inflightContext = {
        pendingTransfers: [
          {
            origin: chain2,
            destination: chain1,
            amount: 7_000_000n, // 7 USDC pending to chain1
          },
        ] as StrategyRoute[],
        pendingRebalances: [] as StrategyRoute[],
      };

      // After reserveCollateral: chain1 = 2 - 7 = -5 USDC (deficit)
      const routes = strategy.getRebalancingRoutes(
        rawBalances,
        inflightContext,
      );

      expect(routes).to.have.lengthOf(1);
      expect(routes[0].origin).to.equal(chain2);
      expect(routes[0].destination).to.equal(chain1);
      expect(routes[0].bridge).to.equal(BRIDGE2); // Uses chain2's (origin) bridge
    });

    it('should generate routes from surplus to deficit chains', () => {
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
        [chain3]: [BRIDGE1],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
          [chain3]: { bridge: BRIDGE1, buffer: '100' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      // Start with positive balances
      const rawBalances: RawBalances = {
        [chain1]: 5_000_000n, // 5 USDC
        [chain2]: 20_000_000n, // 20 USDC
        [chain3]: 5_000_000n, // 5 USDC
      };

      // Pending transfer will create deficit on chain1
      const inflightContext = {
        pendingTransfers: [
          {
            origin: chain2,
            destination: chain1,
            amount: 15_000_000n, // 15 USDC pending to chain1
          },
        ] as StrategyRoute[],
        pendingRebalances: [] as StrategyRoute[],
      };

      // After reserveCollateral: chain1 = 5 - 15 = -10 USDC (deficit)
      const routes = strategy.getRebalancingRoutes(
        rawBalances,
        inflightContext,
      );

      // Should have route(s) from surplus chains (chain2, chain3) to deficit chain (chain1)
      expect(routes.length).to.be.greaterThan(0);
      routes.forEach((route) => {
        expect([chain2, chain3]).to.include(route.origin);
        expect(route.destination).to.equal(chain1);
      });
    });
  });

  describe('filterByConfiguredBridges', () => {
    it('should filter rebalances by origin chain configured bridges', () => {
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      const pendingRebalances: StrategyRoute[] = [
        {
          origin: chain2,
          destination: chain1,
          amount: 5_000_000n,
          bridge: BRIDGE2, // Matches chain2 (origin) → INCLUDED
        },
        {
          origin: chain1,
          destination: chain2,
          amount: 3_000_000n,
          bridge: OTHER_BRIDGE, // Does NOT match chain1 (origin) → EXCLUDED
        },
        {
          origin: chain2,
          destination: chain1,
          amount: 2_000_000n,
          bridge: undefined, // No bridge specified → INCLUDED
        },
      ];

      const filtered = strategy['filterByConfiguredBridges'](pendingRebalances);

      // Should include: BRIDGE2 matches origin (chain2) + undefined bridge (recovered intent)
      // Should exclude: OTHER_BRIDGE (doesn't match origin chain1's configured bridges)
      expect(filtered).to.have.lengthOf(2);
      expect(filtered[0].bridge).to.equal(BRIDGE2);
      expect(filtered[1].bridge).to.be.undefined;
    });

    it('should include rebalance when bridge matches origin, not destination', () => {
      // This test verifies the fix: we check ORIGIN bridges, not DESTINATION bridges
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      // Route from chain2 → chain1 with chain2's bridge (origin bridge)
      // This should be INCLUDED because bridge matches origin's configured bridges
      const pendingRebalances: StrategyRoute[] = [
        {
          origin: chain2,
          destination: chain1,
          amount: 5_000_000n,
          bridge: BRIDGE2, // chain2's bridge (origin)
        },
      ];

      const filtered = strategy['filterByConfiguredBridges'](pendingRebalances);
      expect(filtered).to.have.lengthOf(1);
      expect(filtered[0].bridge).to.equal(BRIDGE2);
    });

    it('should exclude rebalance when bridge matches destination but not origin', () => {
      // This test verifies we do NOT match by destination
      const bridges: ChainMap<Address[]> = {
        [chain1]: [BRIDGE1],
        [chain2]: [BRIDGE2],
      };

      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
        undefined,
        bridges,
      );

      // Route from chain2 → chain1 with chain1's bridge (destination bridge)
      // This should be EXCLUDED because bridge doesn't match origin's (chain2's) bridges
      const pendingRebalances: StrategyRoute[] = [
        {
          origin: chain2,
          destination: chain1,
          amount: 5_000_000n,
          bridge: BRIDGE1, // chain1's bridge (destination, NOT origin)
        },
      ];

      const filtered = strategy['filterByConfiguredBridges'](pendingRebalances);
      expect(filtered).to.have.lengthOf(0);
    });

    it('should return empty array for undefined pending rebalances', () => {
      const strategy = new CollateralDeficitStrategy(
        {
          [chain1]: { bridge: BRIDGE1, buffer: '1000' },
          [chain2]: { bridge: BRIDGE2, buffer: '500' },
        },
        tokensByChainName,
        testLogger,
      );

      const filtered = strategy['filterByConfiguredBridges'](undefined);
      expect(filtered).to.have.lengthOf(0);
    });
  });
});
