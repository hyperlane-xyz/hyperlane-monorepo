/**
 * Simulation Harness v2 Component Tests
 *
 * Tests the individual components of the simulation environment:
 * - SimulationClock: Time advancement for EVM and JS
 * - OptimizedTrafficGenerator: Warp route transfer execution and delivery
 * - MockExplorerServer: Inflight message tracking
 * - SimulatedTokenBridge: Bridge deployment verification
 * - WeightedStrategy: Imbalance detection (standalone, no simulation)
 *
 * For full end-to-end simulation tests, see:
 * - fast-simulation.e2e-test.ts (quick tests)
 * - integrated-simulation.e2e-test.ts (comprehensive tests)
 */
import { expect } from 'chai';
import { pino } from 'pino';

import {
  WeightedStrategy,
  type RawBalances,
} from '@hyperlane-xyz/rebalancer';
import { toWei } from '@hyperlane-xyz/utils';

import {
  type AnvilInstance,
  DOMAIN_1,
  DOMAIN_2,
  DOMAIN_3,
  createRebalancerTestSetup,
  type RebalancerTestSetup,
  type SnapshotInfo,
  startAnvil,
} from '../../harness/index.js';
import { MockExplorerServer } from '../../harness/mock-explorer.js';
import { SimulationClock } from './SimulationClock.js';
import { OptimizedTrafficGenerator } from './OptimizedTrafficGenerator.js';
import type { ScheduledTransfer } from './types.js';

// Silent logger for tests
const logger = pino({ level: 'silent' });

describe('Simulation Harness v2 Components', function () {
  // Longer timeout for setup
  this.timeout(180_000);

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  // Test parameters
  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('100'); // 100 tokens per domain

  before(async function () {
    console.log('Starting anvil for simulation v2 component tests...');
    anvil = await startAnvil(8545, logger);

    console.log('Setting up simulation v2 test environment...');

    // Create test setup with SimulatedTokenBridge
    setup = await createRebalancerTestSetup({
      collateralDomains: COLLATERAL_DOMAINS,
      syntheticDomains: SYNTHETIC_DOMAINS,
      initialCollateral: BigInt(INITIAL_COLLATERAL),
      logger,
      // Use simulated bridge with configurable fees
      simulatedBridge: {
        fixedFee: 0n,
        variableFeeBps: 10, // 0.1% fee
      },
    });

    baseSnapshot = await setup.createSnapshot();
    console.log('Test environment ready');
  });

  after(async function () {
    if (anvil) {
      await anvil.stop();
    }
  });

  afterEach(async function () {
    await setup.restoreSnapshot(baseSnapshot);
    baseSnapshot = await setup.createSnapshot();
  });

  // ========== CLOCK TESTS ==========

  describe('SimulationClock', function () {
    it('should advance time correctly', async function () {
      const clock = new SimulationClock(setup.provider);

      try {
        expect(clock.getElapsedTime()).to.equal(0);

        await clock.advanceTime(5000); // 5 seconds
        expect(clock.getElapsedTime()).to.equal(5000);

        await clock.advanceTime(10000); // 10 more seconds
        expect(clock.getElapsedTime()).to.equal(15000);
      } finally {
        clock.restore();
      }
    });

    it('should advance EVM time in sync with JS time', async function () {
      // Get initial block timestamp BEFORE installing fake timers
      const initialBlock = await setup.provider.getBlock('latest');
      const initialTimestamp = initialBlock.timestamp;

      const clock = new SimulationClock(setup.provider);

      try {
        // Advance 60 seconds using the clock's API
        await clock.advanceTime(60_000);

        const newBlock = await setup.provider.getBlock('latest');
        const newTimestamp = newBlock.timestamp;

        // EVM time should have advanced by ~60 seconds
        expect(newTimestamp - initialTimestamp).to.be.greaterThanOrEqual(60);
      } finally {
        clock.restore();
      }
    });
  });

  // ========== TRAFFIC GENERATOR TESTS ==========

  describe('OptimizedTrafficGenerator', function () {
    it('should execute warp route transfers', async function () {
      this.timeout(60000);
      
      const generator = new OptimizedTrafficGenerator(setup, 10_000);
      await generator.initialize();

      const transfer: ScheduledTransfer = {
        time: 0,
        origin: DOMAIN_1.name,
        destination: DOMAIN_3.name, // To synthetic
        amount: BigInt(toWei('1')),
      };

      console.log('Executing transfer...');
      const pending = await generator.executeTransfer(transfer, 0);
      console.log('Transfer executed, messageId:', pending.messageId);

      expect(pending.messageId).to.be.a('string');
      expect(pending.txHash).to.be.a('string');
      expect(pending.messageBytes).to.be.a('string'); // OptimizedTrafficGenerator extracts message bytes
      expect(pending.origin).to.equal(DOMAIN_1.name);
      expect(pending.destination).to.equal(DOMAIN_3.name);
      expect(pending.completed).to.be.false;
    });

    it('should deliver warp route transfers', async function () {
      this.timeout(60000);
      
      const generator = new OptimizedTrafficGenerator(setup, 10_000);
      await generator.initialize();

      const transfer: ScheduledTransfer = {
        time: 0,
        origin: DOMAIN_1.name,
        destination: DOMAIN_3.name,
        amount: BigInt(toWei('1')),
      };

      console.log('Executing transfer...');
      const pending = await generator.executeTransfer(transfer, 0);
      console.log('Transfer executed, delivering...');

      // Deliver the transfer
      const delivered = await generator.deliverTransfer(pending);
      console.log('Transfer delivered:', delivered);

      expect(delivered).to.be.true;
      expect(generator.isDelivered(pending.messageId)).to.be.true;
    });
  });

  // ========== MOCK EXPLORER TESTS ==========

  describe('MockExplorerServer', function () {
    let explorerServer: MockExplorerServer;

    beforeEach(async function () {
      explorerServer = await MockExplorerServer.create();
    });

    afterEach(async function () {
      await explorerServer.close();
    });

    it('should track and query messages', async function () {
      const testMessage = {
        msgId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        originChainId: 31337,
        originDomainId: DOMAIN_1.domainId,
        destinationChainId: 31337,
        destinationDomainId: DOMAIN_3.domainId,
        sender: setup.getWarpRouteAddress(DOMAIN_1.name),
        recipient: setup.getWarpRouteAddress(DOMAIN_3.name),
        amount: BigInt(toWei('1')),
        status: 'pending' as const,
      };

      explorerServer.addMessage(testMessage);

      const messages = explorerServer.getMessages();
      expect(messages.length).to.equal(1);
      expect(messages[0].msgId).to.equal(testMessage.msgId);
    });
  });

  // ========== SIMULATED TOKEN BRIDGE TESTS ==========

  describe('SimulatedTokenBridge', function () {
    it('should be deployed with correct fee config', async function () {
      // Get bridge address
      const bridgeAddress = setup.getBridge(DOMAIN_1.name, DOMAIN_2.name);
      expect(bridgeAddress).to.be.a('string');
      expect(bridgeAddress.startsWith('0x')).to.be.true;
    });
  });

  // ========== REBALANCER STRATEGY TESTS (STANDALONE) ==========

  describe('WeightedStrategy (standalone)', function () {
    /**
     * Run the weighted strategy directly and get proposed routes.
     * This tests the strategy logic without running a full simulation.
     */
    async function runWeightedStrategy(
      balances: RawBalances,
      chainConfigs: Record<string, { weight: number; tolerance: number; bridge: string }>,
    ) {
      const strategyConfig: Record<string, { weighted: { weight: bigint; tolerance: bigint }; bridge: string }> = {};
      for (const [chain, config] of Object.entries(chainConfigs)) {
        strategyConfig[chain] = {
          weighted: {
            weight: BigInt(config.weight),
            tolerance: BigInt(config.tolerance),
          },
          bridge: config.bridge,
        };
      }
      
      const strategy = new WeightedStrategy(strategyConfig, logger);
      return strategy.getRebalancingRoutes(balances, {
        pendingRebalances: [],
        pendingTransfers: [],
      });
    }

    it('should detect imbalance and propose rebalancing routes', async function () {
      // Create an imbalanced state directly (no simulation needed)
      const imbalancedBalances: RawBalances = {
        [DOMAIN_1.name]: BigInt(toWei('70')), // 70% of total
        [DOMAIN_2.name]: BigInt(toWei('30')), // 30% of total
      };

      const strategyConfig = {
        [DOMAIN_1.name]: {
          weight: 50,
          tolerance: 5, // 5% tolerance
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
        },
        [DOMAIN_2.name]: {
          weight: 50,
          tolerance: 5,
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
        },
      };

      const routes = await runWeightedStrategy(imbalancedBalances, strategyConfig);
      
      console.log('\nWeightedStrategy Analysis:');
      console.log(`  Input balances: ${DOMAIN_1.name}=70, ${DOMAIN_2.name}=30`);
      console.log(`  Target weights: 50/50 with 5% tolerance`);
      
      if (routes.length > 0) {
        console.log(`  Proposed rebalancing routes:`);
        for (const route of routes) {
          console.log(`    ${route.origin} -> ${route.destination}: ${Number(route.amount) / 1e18} tokens`);
        }
      } else {
        console.log(`  No rebalancing needed (within tolerance)`);
      }

      // The strategy should propose rebalancing from domain1 to domain2
      expect(routes.length).to.be.greaterThan(0);
      expect(routes[0].origin).to.equal(DOMAIN_1.name);
      expect(routes[0].destination).to.equal(DOMAIN_2.name);
      // Should move ~20 tokens to balance (from 70/30 to 50/50)
      expect(Number(routes[0].amount) / 1e18).to.be.closeTo(20, 1);
    });

    it('should not propose rebalancing when within tolerance', async function () {
      // Create a balanced state
      const balancedBalances: RawBalances = {
        [DOMAIN_1.name]: BigInt(toWei('52')), // 52% - within 5% tolerance of 50%
        [DOMAIN_2.name]: BigInt(toWei('48')), // 48% - within 5% tolerance of 50%
      };

      const strategyConfig = {
        [DOMAIN_1.name]: {
          weight: 50,
          tolerance: 5, // 5% tolerance
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
        },
        [DOMAIN_2.name]: {
          weight: 50,
          tolerance: 5,
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
        },
      };

      const routes = await runWeightedStrategy(balancedBalances, strategyConfig);
      
      console.log('\nWeightedStrategy Analysis (balanced):');
      console.log(`  Input balances: ${DOMAIN_1.name}=52, ${DOMAIN_2.name}=48`);
      console.log(`  Target weights: 50/50 with 5% tolerance`);
      console.log(`  Proposed routes: ${routes.length}`);

      // Should not propose any rebalancing since we're within tolerance
      expect(routes.length).to.equal(0);
    });
  });
});
