import { expect } from 'chai';
import { pino } from 'pino';

import {
  CollateralDeficitStrategy,
  MinAmountStrategy,
  RebalancerConfig,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
  WeightedStrategy,
} from '@hyperlane-xyz/rebalancer';
import { Token, TokenStandard } from '@hyperlane-xyz/sdk';
import type { ChainMap } from '@hyperlane-xyz/sdk';
import { toWei } from '@hyperlane-xyz/utils';
import type { Address } from '@hyperlane-xyz/utils';

import {
  DEFAULT_REBALANCER_CONFIG_PATH,
  DOMAIN_1,
  DOMAIN_2,
  DOMAIN_3,
  Phase,
  type RebalancerTestSetup,
  type SnapshotInfo,
  createEqualWeightedConfig,
  createMinAmountConfig,
  createPhaseRunner,
  createRebalancerTestSetup,
  getAllWarpRouteBalances,
  transferAndRelay,
  writeMinAmountConfig,
  writeWeightedConfig,
} from './harness/index.js';

// Silent logger for tests
const logger = pino({ level: 'silent' });

/**
 * Helper to create Token objects for strategy constructors.
 */
function createTokensByChainName(domainNames: string[]): ChainMap<Token> {
  const tokensByChainName: ChainMap<Token> = {};
  for (const name of domainNames) {
    tokensByChainName[name] = new Token({
      chainName: name,
      name: 'Test Token',
      symbol: 'TST',
      decimals: 18,
      standard: TokenStandard.ERC20,
      addressOrDenom: '',
    });
  }
  return tokensByChainName;
}

/**
 * Helper to create bridges map from test setup.
 */
function createBridgesMap(
  setup: RebalancerTestSetup,
  domainNames: string[],
): ChainMap<Address[]> {
  const bridges: ChainMap<Address[]> = {};
  for (const origin of domainNames) {
    bridges[origin] = [];
    for (const dest of domainNames) {
      if (origin !== dest) {
        try {
          bridges[origin].push(setup.getBridge(origin, dest));
        } catch {
          // Bridge might not exist for all pairs
        }
      }
    }
  }
  return bridges;
}

describe('Rebalancer E2E Tests', function () {
  // Increase timeout for setup
  this.timeout(120_000);

  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  // Collateral domains for testing
  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('10'); // 10 tokens per domain

  before(async function () {
    console.log('Setting up rebalancer test environment...');

    // Create the test setup - this deploys on single anvil:
    // - Mailbox + TestISM for each domain
    // - ERC20 tokens on collateral domains
    // - Warp routes
    // - Mock bridges for all domain pairs
    setup = await createRebalancerTestSetup({
      collateralDomains: COLLATERAL_DOMAINS,
      syntheticDomains: SYNTHETIC_DOMAINS,
      initialCollateral: BigInt(INITIAL_COLLATERAL),
      logger,
    });

    // Create base snapshot after deployment
    baseSnapshot = await setup.createSnapshot();

    console.log('Test environment ready');
  });

  afterEach(async function () {
    // Restore to clean state after each test
    await setup.restoreSnapshot(baseSnapshot);
    // Create new snapshot (revert consumes the snapshot)
    baseSnapshot = await setup.createSnapshot();
  });

  /**
   * Helper to run the rebalancer strategy and get routes.
   * Uses the strategy directly without the full context factory.
   */
  async function runRebalancerStrategy(): Promise<{
    routes: Array<{ origin: string; destination: string; amount: bigint }>;
    balances: Record<string, bigint>;
  }> {
    // Load the config
    const rebalancerConfig = RebalancerConfig.load(
      DEFAULT_REBALANCER_CONFIG_PATH,
    );

    // Get raw balances
    const rawBalances = await getAllWarpRouteBalances(setup);

    // Create strategy directly based on config
    // For weighted strategy tests
    const strategyConfig = rebalancerConfig.strategyConfig[0];
    if (
      strategyConfig.rebalanceStrategy !== RebalancerStrategyOptions.Weighted
    ) {
      throw new Error('Only weighted strategy is supported in this helper');
    }

    // WeightedStrategy expects just the chains config, not the full strategy object
    const strategy = new WeightedStrategy(strategyConfig.chains, logger);

    // Get rebalancing routes from strategy
    const routes = strategy.getRebalancingRoutes(rawBalances, {
      pendingRebalances: [],
      pendingTransfers: [],
    });

    return {
      routes: routes.map((r) => ({
        origin: r.origin,
        destination: r.destination,
        amount: r.amount,
      })),
      balances: rawBalances,
    };
  }

  // ========== WEIGHTED STRATEGY TESTS ==========

  describe('Weighted Strategy', function () {
    it('should detect imbalance and propose rebalancing routes', async function () {
      // Create imbalance by adding MORE collateral to domain1
      // transferRemote from collateral to synthetic ADDS collateral (locks tokens)
      // So we transfer more from domain1 than domain2 to create imbalance
      //
      // Initial: domain1=10, domain2=10
      // After transfer from domain1->domain3: domain1=18, domain2=10 (8 more locked)
      // This creates imbalance where domain1 has MORE than domain2
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('8')),
      );

      // Verify balances after transfer
      const balancesAfterTransfer = await getAllWarpRouteBalances(setup);
      console.log('Balances after transfer:', balancesAfterTransfer);

      // domain1 should have ~18 tokens (10 initial + 8 locked), domain2 should have ~10 tokens
      expect(Number(balancesAfterTransfer[DOMAIN_1.name])).to.be.greaterThan(
        Number(toWei('15')),
      );
      expect(Number(balancesAfterTransfer[DOMAIN_2.name])).to.equal(
        Number(toWei('10')),
      );

      // Write weighted config with equal weights
      const configOptions = createEqualWeightedConfig(
        setup,
        [DOMAIN_1.name, DOMAIN_2.name],
        0, // 0 tolerance
      );
      writeWeightedConfig(configOptions);

      // Run strategy
      const result = await runRebalancerStrategy();
      console.log('Strategy result:', result);

      // Should propose a route from domain1 (surplus) to domain2 (deficit)
      expect(result.routes.length).to.be.greaterThan(0);

      const route = result.routes[0];
      expect(route.origin).to.equal(DOMAIN_1.name);
      expect(route.destination).to.equal(DOMAIN_2.name);
      expect(Number(route.amount)).to.be.greaterThan(0);
    });

    it('should not propose routes when already balanced', async function () {
      // No transfers - both domains have 10 tokens each

      // Write weighted config with equal weights
      const configOptions = createEqualWeightedConfig(
        setup,
        [DOMAIN_1.name, DOMAIN_2.name],
        0,
      );
      writeWeightedConfig(configOptions);

      // Run strategy
      const result = await runRebalancerStrategy();
      console.log('Strategy result (balanced):', result);

      // Should not propose any routes
      expect(result.routes.length).to.equal(0);
    });

    it('should respect tolerance setting', async function () {
      // Create small imbalance: send 1 token from domain1 to domain3
      // This adds 1 token to domain1's collateral (11 total vs 10 for domain2)
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('1')),
      );

      // Write weighted config with 20% tolerance
      // With 11 + 10 = 21 total, target is 10.5 each
      // 20% tolerance means acceptable range is 8.4 - 12.6
      // domain1 has 11, domain2 has 10 - both within tolerance
      const configOptions = createEqualWeightedConfig(
        setup,
        [DOMAIN_1.name, DOMAIN_2.name],
        20, // 20% tolerance
      );
      writeWeightedConfig(configOptions);

      // Run strategy
      const result = await runRebalancerStrategy();
      console.log('Strategy result (with tolerance):', result);

      // Should not propose routes because imbalance is within tolerance
      expect(result.routes.length).to.equal(0);
    });

    it('should handle unequal weights', async function () {
      // No transfers - both domains start with 10 tokens

      // Write weighted config with 75/25 split
      // domain1 should have 75% = 15 tokens, domain2 should have 25% = 5 tokens
      // Since domain1 only has 10 and domain2 has 10, domain2 should send to domain1
      writeWeightedConfig({
        setup,
        chains: {
          [DOMAIN_1.name]: {
            weight: 75,
            tolerance: 0,
            bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
          },
          [DOMAIN_2.name]: {
            weight: 25,
            tolerance: 0,
            bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
          },
        },
      });

      // Run strategy
      const result = await runRebalancerStrategy();
      console.log('Strategy result (unequal weights):', result);

      // Should propose route from domain2 to domain1
      expect(result.routes.length).to.be.greaterThan(0);

      const route = result.routes[0];
      expect(route.origin).to.equal(DOMAIN_2.name);
      expect(route.destination).to.equal(DOMAIN_1.name);
      // Should transfer 5 tokens (to go from 50/50 to 75/25)
      expect(route.amount.toString()).to.equal(toWei('5'));
    });
  });

  // ========== MIN AMOUNT STRATEGY TESTS ==========

  describe('MinAmount Strategy', function () {
    /**
     * Helper to run MinAmountStrategy directly.
     */
    async function runMinAmountStrategy(
      config: Record<
        string,
        {
          min: string;
          target: string;
          bridge: Address;
        }
      >,
    ): Promise<{
      routes: Array<{ origin: string; destination: string; amount: bigint }>;
      balances: Record<string, bigint>;
    }> {
      const rawBalances = await getAllWarpRouteBalances(setup);
      const domainNames = Object.keys(config);
      const tokensByChainName = createTokensByChainName(domainNames);
      const bridges = createBridgesMap(setup, domainNames);

      // Calculate total collateral
      const totalCollateral = domainNames.reduce(
        (sum, name) => sum + rawBalances[name],
        0n,
      );

      // Build strategy config
      const strategyConfig: Record<string, any> = {};
      for (const [chainName, chainConfig] of Object.entries(config)) {
        strategyConfig[chainName] = {
          minAmount: {
            min: chainConfig.min,
            target: chainConfig.target,
            type: RebalancerMinAmountType.Absolute,
          },
          bridge: chainConfig.bridge,
          bridgeLockTime: 1,
        };
      }

      const strategy = new MinAmountStrategy(
        strategyConfig,
        tokensByChainName,
        totalCollateral,
        logger,
        undefined,
        bridges,
      );

      const routes = strategy.getRebalancingRoutes(rawBalances, {
        pendingRebalances: [],
        pendingTransfers: [],
      });

      return {
        routes: routes.map((r) => ({
          origin: r.origin,
          destination: r.destination,
          amount: r.amount,
        })),
        balances: rawBalances,
      };
    }

    it('should detect when a chain is below minimum and propose route', async function () {
      // Create imbalance: domain1 gets more collateral, domain2 stays the same
      // Transfer from domain1 to domain3 ADDS collateral to domain1
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('8')),
      );

      // After transfer: domain1 = 18, domain2 = 10
      const balances = await getAllWarpRouteBalances(setup);
      console.log('Balances after transfer:', balances);

      // Set minimum of 12 for each chain
      // domain1 (18) is above min, domain2 (10) is below min (12)
      // domain2 needs 12-10=2 (or target-current if target > min)
      const result = await runMinAmountStrategy({
        [DOMAIN_1.name]: {
          min: '12',
          target: '14',
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
        },
        [DOMAIN_2.name]: {
          min: '12',
          target: '14',
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
        },
      });

      console.log('MinAmount strategy result:', result);

      // Should propose route from domain1 (surplus) to domain2 (deficit)
      expect(result.routes.length).to.be.greaterThan(0);

      const route = result.routes[0];
      expect(route.origin).to.equal(DOMAIN_1.name);
      expect(route.destination).to.equal(DOMAIN_2.name);
      // Amount should bring domain2 up to target (14)
      expect(route.amount.toString()).to.equal(toWei('4')); // 14 - 10 = 4
    });

    it('should not propose routes when all chains meet minimum', async function () {
      // No transfers - both domains have 10 tokens
      // Set minimum of 8 for each chain - both are above minimum

      const result = await runMinAmountStrategy({
        [DOMAIN_1.name]: {
          min: '8',
          target: '9',
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
        },
        [DOMAIN_2.name]: {
          min: '8',
          target: '9',
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
        },
      });

      console.log('MinAmount strategy result (all above min):', result);

      // Should not propose any routes
      expect(result.routes.length).to.equal(0);
    });

    it('should use config file approach', async function () {
      // Create imbalance
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('5')),
      );

      // Write min amount config
      const configOptions = createMinAmountConfig(setup, {
        [DOMAIN_1.name]: { min: '10', target: '12' },
        [DOMAIN_2.name]: { min: '10', target: '12' },
      });
      writeMinAmountConfig(configOptions);

      // Load and verify config
      const rebalancerConfig = RebalancerConfig.load(
        DEFAULT_REBALANCER_CONFIG_PATH,
      );
      expect(rebalancerConfig.strategyConfig[0].rebalanceStrategy).to.equal(
        RebalancerStrategyOptions.MinAmount,
      );
    });

    it('should handle relative min amounts', async function () {
      // Create imbalance: domain1 gets more collateral
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('8')),
      );

      // After transfer: domain1 = 18, domain2 = 10, total = 28
      const rawBalances = await getAllWarpRouteBalances(setup);
      const domainNames = [DOMAIN_1.name, DOMAIN_2.name];
      const tokensByChainName = createTokensByChainName(domainNames);
      const bridges = createBridgesMap(setup, domainNames);

      const totalCollateral = domainNames.reduce(
        (sum, name) => sum + rawBalances[name],
        0n,
      );

      // Set relative minimums: 30% for each chain
      // With total=28, 30% = 8.4 tokens
      // domain1 (18) is above min, domain2 (10) is above min too
      // But set min to 40% to trigger rebalancing
      // 40% of 28 = 11.2 tokens - domain2 (10) is below
      const strategyConfig = {
        [DOMAIN_1.name]: {
          minAmount: {
            min: 0.4, // 40%
            target: 0.45, // 45%
            type: RebalancerMinAmountType.Relative,
          },
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
          bridgeLockTime: 1,
        },
        [DOMAIN_2.name]: {
          minAmount: {
            min: 0.4, // 40%
            target: 0.45, // 45%
            type: RebalancerMinAmountType.Relative,
          },
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
          bridgeLockTime: 1,
        },
      };

      const strategy = new MinAmountStrategy(
        strategyConfig,
        tokensByChainName,
        totalCollateral,
        logger,
        undefined,
        bridges,
      );

      const routes = strategy.getRebalancingRoutes(rawBalances, {
        pendingRebalances: [],
        pendingTransfers: [],
      });

      console.log('MinAmount strategy (relative) result:', {
        totalCollateral: totalCollateral.toString(),
        routes: routes.map((r) => ({
          ...r,
          amount: r.amount.toString(),
        })),
      });

      // domain2 (10) is below 40% of 28 (11.2), so should get rebalanced
      // domain1 (18) has surplus above min (11.2)
      expect(routes.length).to.be.greaterThan(0);
      expect(routes[0].origin).to.equal(DOMAIN_1.name);
      expect(routes[0].destination).to.equal(DOMAIN_2.name);
    });
  });

  // ========== COLLATERAL DEFICIT STRATEGY TESTS ==========

  describe('CollateralDeficit Strategy', function () {
    /**
     * Helper to run CollateralDeficitStrategy directly.
     * This strategy is designed to handle negative (effective) balances
     * caused by pending user transfers.
     */
    async function runCollateralDeficitStrategy(
      config: Record<
        string,
        {
          buffer: string;
          bridge: Address;
        }
      >,
      inflightContext?: {
        pendingTransfers?: Array<{
          origin: string;
          destination: string;
          amount: bigint;
        }>;
        pendingRebalances?: Array<{
          origin: string;
          destination: string;
          amount: bigint;
          bridge?: Address;
        }>;
      },
    ): Promise<{
      routes: Array<{
        origin: string;
        destination: string;
        amount: bigint;
        bridge?: Address;
      }>;
      balances: Record<string, bigint>;
    }> {
      const rawBalances = await getAllWarpRouteBalances(setup);
      const domainNames = Object.keys(config);
      const tokensByChainName = createTokensByChainName(domainNames);
      const bridges = createBridgesMap(setup, domainNames);

      // Build strategy config
      const strategyConfig: Record<string, any> = {};
      for (const [chainName, chainConfig] of Object.entries(config)) {
        strategyConfig[chainName] = {
          buffer: chainConfig.buffer,
          bridge: chainConfig.bridge,
          bridgeLockTime: 1,
        };
      }

      const strategy = new CollateralDeficitStrategy(
        strategyConfig,
        tokensByChainName,
        logger,
        undefined,
        bridges,
      );

      const routes = strategy.getRebalancingRoutes(rawBalances, {
        pendingRebalances: inflightContext?.pendingRebalances ?? [],
        pendingTransfers: inflightContext?.pendingTransfers ?? [],
      });

      return {
        routes: routes.map((r) => ({
          origin: r.origin,
          destination: r.destination,
          amount: r.amount,
          bridge: r.bridge,
        })),
        balances: rawBalances,
      };
    }

    it('should detect deficit caused by pending transfer and propose JIT rebalance', async function () {
      // Initial state: domain1=10, domain2=10
      // Simulate a large pending user transfer that will create a deficit
      // When a user transfer is pending TO domain1, it will need collateral
      // that exceeds what domain1 has

      const result = await runCollateralDeficitStrategy(
        {
          [DOMAIN_1.name]: {
            buffer: '1', // 1 token buffer
            bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
          },
          [DOMAIN_2.name]: {
            buffer: '1',
            bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
          },
        },
        {
          // Simulate pending user transfer that needs 15 tokens from domain1
          // domain1 only has 10, so effective balance becomes -5
          pendingTransfers: [
            {
              origin: DOMAIN_3.name, // synthetic
              destination: DOMAIN_1.name, // collateral
              amount: BigInt(toWei('15')), // needs 15 tokens
            },
          ],
        },
      );

      console.log('CollateralDeficit strategy result:', result);

      // Strategy should detect deficit on domain1 and propose route from domain2
      expect(result.routes.length).to.be.greaterThan(0);

      const route = result.routes[0];
      expect(route.origin).to.equal(DOMAIN_2.name);
      expect(route.destination).to.equal(DOMAIN_1.name);
      // Amount should cover deficit (-5) plus buffer (1) = 6
      expect(Number(route.amount)).to.be.greaterThanOrEqual(Number(toWei('6')));
    });

    it('should not propose routes when no deficit exists', async function () {
      // No pending transfers - all balances positive
      const result = await runCollateralDeficitStrategy({
        [DOMAIN_1.name]: {
          buffer: '1',
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
        },
        [DOMAIN_2.name]: {
          buffer: '1',
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
        },
      });

      console.log('CollateralDeficit strategy result (no deficit):', result);

      // No routes should be proposed
      expect(result.routes.length).to.equal(0);
    });

    it('should account for pending rebalances when calculating deficit', async function () {
      // Test that pending rebalances are considered
      // If there's already a rebalance in flight, it should reduce the deficit

      const result = await runCollateralDeficitStrategy(
        {
          [DOMAIN_1.name]: {
            buffer: '1',
            bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
          },
          [DOMAIN_2.name]: {
            buffer: '1',
            bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
          },
        },
        {
          // Pending user transfer creates -5 deficit on domain1
          pendingTransfers: [
            {
              origin: DOMAIN_3.name,
              destination: DOMAIN_1.name,
              amount: BigInt(toWei('15')),
            },
          ],
          // But there's already a pending rebalance of 4 tokens to domain1
          pendingRebalances: [
            {
              origin: DOMAIN_2.name,
              destination: DOMAIN_1.name,
              amount: BigInt(toWei('4')),
              bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
            },
          ],
        },
      );

      console.log(
        'CollateralDeficit strategy result (with pending rebalance):',
        result,
      );

      // The pending rebalance should reduce the deficit
      // Without pending rebalance: deficit = 5 + 1 = 6
      // With pending rebalance of 4: effective deficit = 1 + 1 = 2
      if (result.routes.length > 0) {
        const route = result.routes[0];
        expect(route.origin).to.equal(DOMAIN_2.name);
        expect(route.destination).to.equal(DOMAIN_1.name);
        // Amount should be smaller due to pending rebalance
        expect(Number(route.amount)).to.be.lessThan(Number(toWei('6')));
      }
    });
  });

  // ========== BALANCE TRACKING TESTS ==========

  describe('Balance Tracking', function () {
    it('should correctly track balances after multiple transfers', async function () {
      const initialBalances = await getAllWarpRouteBalances(setup);
      console.log('Initial balances:', initialBalances);

      // Transfer 3 tokens from domain1 to domain3 (ADDS collateral to domain1)
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('3')),
      );

      const balancesAfterFirst = await getAllWarpRouteBalances(setup);
      console.log('After first transfer:', balancesAfterFirst);

      // Collateral INCREASES when we transfer to synthetic
      expect(balancesAfterFirst[DOMAIN_1.name].toString()).to.equal(
        (initialBalances[DOMAIN_1.name] + BigInt(toWei('3'))).toString(),
      );

      // Transfer 2 tokens from domain2 to domain3 (ADDS collateral to domain2)
      await transferAndRelay(
        setup,
        DOMAIN_2.name,
        DOMAIN_3.name,
        BigInt(toWei('2')),
      );

      const balancesAfterSecond = await getAllWarpRouteBalances(setup);
      console.log('After second transfer:', balancesAfterSecond);

      // Collateral INCREASES when we transfer to synthetic
      expect(balancesAfterSecond[DOMAIN_2.name].toString()).to.equal(
        (initialBalances[DOMAIN_2.name] + BigInt(toWei('2'))).toString(),
      );
    });
  });

  // ========== SNAPSHOT/RESTORE TESTS ==========

  describe('Test Isolation', function () {
    it('should restore state correctly between tests (1)', async function () {
      const initialBalances = await getAllWarpRouteBalances(setup);

      // Make a transfer (adds collateral)
      await transferAndRelay(
        setup,
        DOMAIN_1.name,
        DOMAIN_3.name,
        BigInt(toWei('5')),
      );

      const balancesAfter = await getAllWarpRouteBalances(setup);
      // Transfer to synthetic INCREASES collateral
      expect(Number(balancesAfter[DOMAIN_1.name])).to.be.greaterThan(
        Number(initialBalances[DOMAIN_1.name]),
      );
    });

    it('should restore state correctly between tests (2)', async function () {
      // This test should see the same initial balances as test 1
      // because afterEach restores the snapshot
      const balances = await getAllWarpRouteBalances(setup);

      // Both domains should have initial collateral
      expect(balances[DOMAIN_1.name].toString()).to.equal(INITIAL_COLLATERAL);
      expect(balances[DOMAIN_2.name].toString()).to.equal(INITIAL_COLLATERAL);
    });
  });

  // ========== PHASE-BASED TESTS ==========

  describe('Phase-Based Testing', function () {
    it('should capture state at different phases', async function () {
      const runner = createPhaseRunner(setup);

      const capturedStates: Record<string, Record<string, bigint>> = {};

      const result = await runner.runWithPhases({
        phases: [Phase.INITIAL, Phase.POST_IMBALANCE, Phase.ROUTES_COMPUTED],

        createImbalance: async () => {
          // Transfer adds collateral to domain1
          await transferAndRelay(
            setup,
            DOMAIN_1.name,
            DOMAIN_3.name,
            BigInt(toWei('5')),
          );
        },

        computeRoutes: async () => {
          const configOptions = createEqualWeightedConfig(
            setup,
            [DOMAIN_1.name, DOMAIN_2.name],
            0,
          );
          writeWeightedConfig(configOptions);

          const { routes } = await runRebalancerStrategy();
          return routes;
        },

        onPhase: async (context) => {
          capturedStates[context.phase] = { ...context.balances };
          console.log(`Phase ${context.phase}:`, context.balances);

          if (context.phase === Phase.ROUTES_COMPUTED) {
            console.log('Routes:', context.routes);
          }
        },
      });

      expect(result.completed).to.be.true;
      expect(result.lastPhase).to.equal(Phase.ROUTES_COMPUTED);

      // Verify state changes between phases
      expect(capturedStates[Phase.INITIAL][DOMAIN_1.name].toString()).to.equal(
        INITIAL_COLLATERAL,
      );
      // Transfer to synthetic INCREASES collateral
      expect(
        Number(capturedStates[Phase.POST_IMBALANCE][DOMAIN_1.name]),
      ).to.be.greaterThan(Number(INITIAL_COLLATERAL));
    });

    it('should allow simulating crash at specific phase', async function () {
      const runner = createPhaseRunner(setup);

      const result = await runner.runWithPhases({
        phases: [Phase.INITIAL, Phase.POST_IMBALANCE, Phase.ROUTES_COMPUTED],

        createImbalance: async () => {
          // Transfer adds collateral
          await transferAndRelay(
            setup,
            DOMAIN_1.name,
            DOMAIN_3.name,
            BigInt(toWei('5')),
          );
        },

        computeRoutes: async () => {
          // This should not be called because we stop at POST_IMBALANCE
          throw new Error('Should not reach here');
        },

        onPhase: async (context) => {
          if (context.phase === Phase.POST_IMBALANCE) {
            // Simulate crash by returning false
            return false;
          }
          return true;
        },
      });

      expect(result.completed).to.be.false;
      expect(result.stoppedAt).to.equal(Phase.POST_IMBALANCE);

      // Verify imbalance exists (collateral increased, not decreased)
      const balances = await getAllWarpRouteBalances(setup);
      expect(Number(balances[DOMAIN_1.name])).to.be.greaterThan(
        Number(INITIAL_COLLATERAL),
      );
    });
  });
});
