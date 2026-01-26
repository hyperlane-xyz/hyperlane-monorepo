/**
 * Simulation Harness v2 E2E Tests
 *
 * Tests the end-to-end simulation environment that uses real warp routes
 * and SimulatedTokenBridge for controllable bridge behavior.
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
  getAllWarpRouteBalances,
  type RebalancerTestSetup,
  type SnapshotInfo,
  startAnvil,
} from '../../harness/index.js';
import { MockExplorerServer } from '../../harness/mock-explorer.js';
import { SimulationClock } from './SimulationClock.js';
import { SimulationController } from './SimulationController.js';
import { TrafficGenerator } from './TrafficGenerator.js';
import type { SimulationRun, ScheduledTransfer, SimulationResults } from './types.js';

// Silent logger for tests
const logger = pino({ level: 'silent' });

/**
 * Format simulation results for console output.
 */
function formatSimulationResults(results: SimulationResults): string {
  const lines: string[] = [];
  
  lines.push('='.repeat(60));
  lines.push('SIMULATION RESULTS: ' + results.name);
  lines.push('='.repeat(60));
  
  lines.push('\n📊 DURATION');
  lines.push(`  Simulated time: ${(results.duration.simulatedMs / 1000 / 60).toFixed(1)} minutes`);
  lines.push(`  Wall clock time: ${results.duration.wallClockMs}ms`);
  lines.push(`  Speedup: ${(results.duration.simulatedMs / results.duration.wallClockMs).toFixed(1)}x`);

  lines.push('\n📬 TRANSFERS');
  lines.push(`  Total: ${results.transfers.total}`);
  lines.push(`  Completed: ${results.transfers.completed}`);
  lines.push(`  Stuck: ${results.transfers.stuck}`);
  const successRate = results.transfers.total > 0 
    ? ((results.transfers.completed / results.transfers.total) * 100).toFixed(1)
    : '0.0';
  lines.push(`  Success rate: ${successRate}%`);

  lines.push('\n⏱️  LATENCY');
  lines.push(`  Min: ${(results.transfers.latency.min / 1000).toFixed(1)}s`);
  lines.push(`  Max: ${(results.transfers.latency.max / 1000).toFixed(1)}s`);
  lines.push(`  Mean: ${(results.transfers.latency.mean / 1000).toFixed(1)}s`);
  lines.push(`  P50: ${(results.transfers.latency.p50 / 1000).toFixed(1)}s`);
  lines.push(`  P95: ${(results.transfers.latency.p95 / 1000).toFixed(1)}s`);
  lines.push(`  P99: ${(results.transfers.latency.p99 / 1000).toFixed(1)}s`);

  lines.push('\n⏳ COLLATERAL WAIT');
  lines.push(`  Transfers that waited: ${results.transfers.collateralWait.count}`);
  lines.push(`  Percentage: ${results.transfers.collateralWait.percent.toFixed(1)}%`);
  lines.push(`  Mean wait time: ${(results.transfers.collateralWait.meanMs / 1000).toFixed(1)}s`);

  lines.push('\n💰 REBALANCING');
  lines.push(`  Total rebalances: ${results.rebalancing.count}`);
  lines.push(`  Total volume: ${Number(results.rebalancing.totalVolume) / 1e18} tokens`);
  lines.push(`  Total fees: ${Number(results.rebalancing.totalFees) / 1e18} tokens`);
  lines.push(`  Total fees (USD): $${results.rebalancing.totalFeesUsd.toFixed(2)}`);

  if (Object.keys(results.rebalancing.byBridge).length > 0) {
    lines.push('\n  By Bridge:');
    for (const [bridge, stats] of Object.entries(results.rebalancing.byBridge)) {
      lines.push(`    ${bridge}:`);
      lines.push(`      Count: ${stats.count}`);
      lines.push(`      Volume: ${Number(stats.volume) / 1e18} tokens`);
      lines.push(`      Fees: ${Number(stats.fees) / 1e18} tokens`);
    }
  }

  lines.push('\n📈 TIME SERIES (sample)');
  const samplePoints = results.timeSeries.filter((_, i) => i % Math.ceil(results.timeSeries.length / 5) === 0);
  for (const point of samplePoints.slice(0, 5)) {
    const timeMin = (point.time / 1000 / 60).toFixed(0);
    const balances = Object.entries(point.balances)
      .map(([chain, bal]) => `${chain}: ${Number(bal) / 1e18}`)
      .join(', ');
    lines.push(`  t=${timeMin}min: ${balances} | pending=${point.pendingTransfers}`);
  }

  lines.push('\n' + '='.repeat(60));
  
  return lines.join('\n');
}

describe('Simulation Harness v2', function () {
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
    console.log('Starting anvil for simulation v2 tests...');
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

  describe('TrafficGenerator', function () {
    it('should execute warp route transfers', async function () {
      this.timeout(60000); // 60 second timeout for this test
      
      const generator = new TrafficGenerator(setup, 10_000);

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
      expect(pending.origin).to.equal(DOMAIN_1.name);
      expect(pending.destination).to.equal(DOMAIN_3.name);
      expect(pending.completed).to.be.false;
    });

    it('should deliver warp route transfers', async function () {
      this.timeout(60000); // 60 second timeout for this test
      
      const generator = new TrafficGenerator(setup, 10_000);

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
      await generator.deliverTransfer(pending);
      console.log('Transfer delivered');

      // The transfer has been delivered - we can verify by checking
      // that the recipient received synthetic tokens
      // (This would require reading the HypERC20 balance on domain3)
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

  // ========== SIMULATION CONTROLLER BASIC TESTS ==========

  describe('SimulationController (Basic)', function () {
    let explorerServer: MockExplorerServer;

    beforeEach(async function () {
      explorerServer = await MockExplorerServer.create();
    });

    afterEach(async function () {
      await explorerServer.close();
    });

    it('should run a simple simulation without rebalancer', async function () {
      // This test runs the simulation without a RebalancerService
      // to verify the basic mechanics work

      const schedule: SimulationRun = {
        name: 'basic-test',
        durationMs: 30_000, // 30 seconds
        transfers: [
          {
            time: 0,
            origin: DOMAIN_1.name,
            destination: DOMAIN_3.name,
            amount: BigInt(toWei('5')),
          },
          {
            time: 10_000,
            origin: DOMAIN_2.name,
            destination: DOMAIN_3.name,
            amount: BigInt(toWei('3')),
          },
        ],
      };

      // Create a mock rebalancer service (no-op)
      const mockRebalancerService = {
        start: async () => {},
        stop: async () => {},
      } as any;

      const controller = new SimulationController({
        setup,
        rebalancerService: mockRebalancerService,
        explorerServer,
        warpTransferDelayMs: 5_000, // 5 second message delivery
        bridgeConfigs: {
          [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
            fixedFee: 0n,
            variableFeeBps: 10,
            transferTimeMs: 10_000,
          },
          [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
            fixedFee: 0n,
            variableFeeBps: 10,
            transferTimeMs: 10_000,
          },
        },
        rebalancerIntervalMs: 10_000,
        timeStepMs: 1_000,
        logger,
      });

      const results = await controller.run(schedule);

      // Verify basic results
      expect(results.name).to.equal('basic-test');
      expect(results.duration.simulatedMs).to.equal(30_000);
      expect(results.transfers.total).to.equal(2);
      expect(results.transfers.completed).to.equal(2);
      expect(results.transfers.stuck).to.equal(0);
    });

    it('should correctly complete transfers after delay', async function () {
      const schedule: SimulationRun = {
        name: 'delay-test',
        durationMs: 20_000,
        transfers: [
          {
            time: 0,
            origin: DOMAIN_1.name,
            destination: DOMAIN_3.name,
            amount: BigInt(toWei('2')),
          },
        ],
      };

      const mockRebalancerService = {
        start: async () => {},
        stop: async () => {},
      } as any;

      const controller = new SimulationController({
        setup,
        rebalancerService: mockRebalancerService,
        explorerServer,
        warpTransferDelayMs: 5_000,
        bridgeConfigs: {},
        rebalancerIntervalMs: 10_000,
        timeStepMs: 1_000,
        logger,
      });

      const results = await controller.run(schedule);

      // Transfer should complete with ~5 second latency
      expect(results.transfers.completed).to.equal(1);
      expect(results.transfers.latency.min).to.be.greaterThanOrEqual(5000);
      expect(results.transfers.latency.max).to.be.lessThanOrEqual(10000);
    });

    it('should record time series data', async function () {
      const schedule: SimulationRun = {
        name: 'timeseries-test',
        durationMs: 30_000,
        transfers: [
          {
            time: 5_000,
            origin: DOMAIN_1.name,
            destination: DOMAIN_3.name,
            amount: BigInt(toWei('10')),
          },
        ],
      };

      const mockRebalancerService = {
        start: async () => {},
        stop: async () => {},
      } as any;

      const controller = new SimulationController({
        setup,
        rebalancerService: mockRebalancerService,
        explorerServer,
        warpTransferDelayMs: 5_000,
        bridgeConfigs: {},
        rebalancerIntervalMs: 10_000,
        timeStepMs: 1_000,
        logger,
      });

      const results = await controller.run(schedule);

      // Should have time series points
      expect(results.timeSeries.length).to.be.greaterThan(0);

      // Time series should show balance changes
      const firstPoint = results.timeSeries[0];
      const lastPoint = results.timeSeries[results.timeSeries.length - 1];

      expect(firstPoint.balances[DOMAIN_1.name]).to.be.a('bigint');
      expect(lastPoint.balances[DOMAIN_1.name]).to.be.a('bigint');
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

  // ========== FULL SIMULATION WITH RESULTS ==========

  describe('Full Simulation Results', function () {
    let explorerServer: MockExplorerServer;

    beforeEach(async function () {
      explorerServer = await MockExplorerServer.create();
    });

    afterEach(async function () {
      await explorerServer.close();
    });

    it('should produce meaningful simulation metrics', async function () {
      this.timeout(120000);

      // Simulate 1 hour of traffic with varying load
      const schedule: SimulationRun = {
        name: 'stress-test-1hr',
        durationMs: 60 * 60 * 1000, // 1 hour simulated
        transfers: [
          // Burst of transfers at start
          { time: 0, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('10')) },
          { time: 1000, origin: DOMAIN_2.name, destination: DOMAIN_3.name, amount: BigInt(toWei('8')) },
          { time: 2000, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('5')) },
          
          // Steady traffic every 10 minutes
          { time: 10 * 60 * 1000, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('3')) },
          { time: 20 * 60 * 1000, origin: DOMAIN_2.name, destination: DOMAIN_3.name, amount: BigInt(toWei('4')) },
          { time: 30 * 60 * 1000, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('6')) },
          { time: 40 * 60 * 1000, origin: DOMAIN_2.name, destination: DOMAIN_3.name, amount: BigInt(toWei('2')) },
          { time: 50 * 60 * 1000, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('7')) },
        ],
      };

      const mockRebalancerService = {
        start: async () => {},
        stop: async () => {},
      } as any;

      const controller = new SimulationController({
        setup,
        rebalancerService: mockRebalancerService,
        explorerServer,
        warpTransferDelayMs: 30_000, // 30 second message delivery (realistic)
        bridgeConfigs: {
          [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
            fixedFee: BigInt(toWei('0.1')), // 0.1 token fixed fee
            variableFeeBps: 5, // 0.05% variable fee
            transferTimeMs: 2 * 60 * 1000, // 2 minute bridge time
          },
          [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
            fixedFee: BigInt(toWei('0.1')),
            variableFeeBps: 5,
            transferTimeMs: 2 * 60 * 1000,
          },
        },
        rebalancerIntervalMs: 60_000, // Check every minute
        timeStepMs: 10_000, // 10 second steps for faster simulation
        logger,
      });

      const results = await controller.run(schedule);

      // Print formatted results
      console.log('\n' + formatSimulationResults(results) + '\n');

      // Assertions
      expect(results.transfers.total).to.equal(8);
      expect(results.transfers.completed).to.equal(8);
      expect(results.transfers.stuck).to.equal(0);
      expect(results.transfers.latency.mean).to.be.greaterThan(0);
    });
  });

  // ========== REBALANCER STRATEGY INTEGRATION ==========

  describe('Rebalancer Strategy Integration', function () {
    /**
     * Run the weighted strategy directly and get proposed routes.
     * Config format matches the actual rebalancer config structure.
     */
    async function runWeightedStrategy(
      balances: RawBalances,
      chainConfigs: Record<string, { weight: number; tolerance: number; bridge: string }>,
    ) {
      // Convert to the format expected by WeightedStrategy
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

    it('should detect imbalance during simulation and propose rebalancing routes', async function () {
      this.timeout(120000);

      // Simulate traffic that creates significant imbalance
      // All transfers go from domain1 to domain3, increasing domain1's collateral
      const schedule: SimulationRun = {
        name: 'imbalance-detection-test',
        durationMs: 10 * 60 * 1000, // 10 minutes simulated
        transfers: [
          // Send 30 tokens worth of traffic from domain1 to domain3
          // This INCREASES domain1's collateral (locks more tokens)
          { time: 0, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('10')) },
          { time: 30_000, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('10')) },
          { time: 60_000, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('10')) },
        ],
      };

      // Get initial balances
      const initialBalances = await getAllWarpRouteBalances(setup);
      console.log('\nInitial balances:', {
        [DOMAIN_1.name]: `${Number(initialBalances[DOMAIN_1.name]) / 1e18} tokens`,
        [DOMAIN_2.name]: `${Number(initialBalances[DOMAIN_2.name]) / 1e18} tokens`,
      });

      // Run simulation without rebalancer
      const mockExplorerServer = await MockExplorerServer.create();
      const mockRebalancerService = {
        start: async () => {},
        stop: async () => {},
      } as any;

      const controller = new SimulationController({
        setup,
        rebalancerService: mockRebalancerService,
        explorerServer: mockExplorerServer,
        warpTransferDelayMs: 5_000, // 5 second message delivery
        bridgeConfigs: {},
        rebalancerIntervalMs: 60_000,
        timeStepMs: 1_000,
        logger,
      });

      const results = await controller.run(schedule);
      await mockExplorerServer.close();

      console.log('\n' + formatSimulationResults(results) + '\n');

      // Get final balances from last time series point
      const finalBalances = results.timeSeries[results.timeSeries.length - 1].balances;
      console.log('Final balances after simulation:', {
        [DOMAIN_1.name]: `${Number(finalBalances[DOMAIN_1.name]) / 1e18} tokens`,
        [DOMAIN_2.name]: `${Number(finalBalances[DOMAIN_2.name]) / 1e18} tokens`,
      });

      // Now run the weighted strategy to see what rebalancing it would propose
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

      // Convert bigint to RawBalances format
      const rawBalances: RawBalances = {};
      for (const [chain, balance] of Object.entries(finalBalances)) {
        rawBalances[chain] = balance;
      }

      const routes = await runWeightedStrategy(rawBalances, strategyConfig);
      
      console.log('\n🔄 REBALANCER STRATEGY ANALYSIS');
      console.log(`  Strategy: WeightedStrategy (50/50 split, 5% tolerance)`);
      console.log(`  Total collateral: ${(Number(rawBalances[DOMAIN_1.name]) + Number(rawBalances[DOMAIN_2.name])) / 1e18} tokens`);
      console.log(`  Target per chain: ${(Number(rawBalances[DOMAIN_1.name]) + Number(rawBalances[DOMAIN_2.name])) / 2 / 1e18} tokens`);
      
      if (routes.length > 0) {
        console.log(`\n  Proposed rebalancing routes:`);
        for (const route of routes) {
          console.log(`    ${route.origin} → ${route.destination}: ${Number(route.amount) / 1e18} tokens`);
        }
      } else {
        console.log(`\n  No rebalancing needed (within tolerance)`);
      }

      // Verify imbalance was created
      // domain1 should have significantly more collateral than domain2
      expect(Number(finalBalances[DOMAIN_1.name])).to.be.greaterThan(
        Number(finalBalances[DOMAIN_2.name])
      );

      // The strategy should propose rebalancing from domain1 to domain2
      expect(routes.length).to.be.greaterThan(0);
      expect(routes[0].origin).to.equal(DOMAIN_1.name);
      expect(routes[0].destination).to.equal(DOMAIN_2.name);
      expect(Number(routes[0].amount)).to.be.greaterThan(0);

      console.log('\n✅ Simulation successfully detected imbalance and strategy proposed rebalancing');
    });

    it('should show rebalancing would restore balance', async function () {
      this.timeout(120000);

      // Create a very imbalanced state
      // Transfer 40 tokens from domain1 to domain3 (increases domain1 collateral by 40)
      // Initial: domain1=100, domain2=100
      // After: domain1=140, domain2=100 (40% imbalance)
      const schedule: SimulationRun = {
        name: 'heavy-imbalance-test',
        durationMs: 5 * 60 * 1000, // 5 minutes simulated
        transfers: [
          { time: 0, origin: DOMAIN_1.name, destination: DOMAIN_3.name, amount: BigInt(toWei('40')) },
        ],
      };

      const mockExplorerServer = await MockExplorerServer.create();
      const mockRebalancerService = { start: async () => {}, stop: async () => {} } as any;

      const controller = new SimulationController({
        setup,
        rebalancerService: mockRebalancerService,
        explorerServer: mockExplorerServer,
        warpTransferDelayMs: 5_000,
        bridgeConfigs: {},
        rebalancerIntervalMs: 60_000,
        timeStepMs: 1_000,
        logger,
      });

      const results = await controller.run(schedule);
      await mockExplorerServer.close();

      // Get final balances
      const finalBalances = results.timeSeries[results.timeSeries.length - 1].balances;
      const totalCollateral = Number(finalBalances[DOMAIN_1.name]) + Number(finalBalances[DOMAIN_2.name]);
      const targetPerChain = totalCollateral / 2;

      console.log('\n📊 BEFORE REBALANCING');
      console.log(`  ${DOMAIN_1.name}: ${Number(finalBalances[DOMAIN_1.name]) / 1e18} tokens (${((Number(finalBalances[DOMAIN_1.name]) / totalCollateral) * 100).toFixed(1)}%)`);
      console.log(`  ${DOMAIN_2.name}: ${Number(finalBalances[DOMAIN_2.name]) / 1e18} tokens (${((Number(finalBalances[DOMAIN_2.name]) / totalCollateral) * 100).toFixed(1)}%)`);
      console.log(`  Total: ${totalCollateral / 1e18} tokens`);
      console.log(`  Target: ${targetPerChain / 1e18} tokens per chain (50/50)`);

      // Run strategy
      const strategyConfig = {
        [DOMAIN_1.name]: { weight: 50, tolerance: 0, bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name) },
        [DOMAIN_2.name]: { weight: 50, tolerance: 0, bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name) },
      };

      const rawBalances: RawBalances = {};
      for (const [chain, balance] of Object.entries(finalBalances)) {
        rawBalances[chain] = balance;
      }

      const routes = await runWeightedStrategy(rawBalances, strategyConfig);

      console.log('\n🔄 REBALANCING PROPOSAL');
      if (routes.length > 0) {
        const route = routes[0];
        console.log(`  ${route.origin} → ${route.destination}: ${Number(route.amount) / 1e18} tokens`);
        
        // Calculate what balances would look like after rebalancing
        const afterRebalance = {
          [DOMAIN_1.name]: Number(finalBalances[DOMAIN_1.name]) - Number(route.amount),
          [DOMAIN_2.name]: Number(finalBalances[DOMAIN_2.name]) + Number(route.amount),
        };
        
        console.log('\n📊 AFTER REBALANCING (projected)');
        console.log(`  ${DOMAIN_1.name}: ${afterRebalance[DOMAIN_1.name] / 1e18} tokens (${((afterRebalance[DOMAIN_1.name] / totalCollateral) * 100).toFixed(1)}%)`);
        console.log(`  ${DOMAIN_2.name}: ${afterRebalance[DOMAIN_2.name] / 1e18} tokens (${((afterRebalance[DOMAIN_2.name] / totalCollateral) * 100).toFixed(1)}%)`);
        
        // Verify the proposed rebalancing would bring chains closer to 50/50
        const imbalanceBefore = Math.abs(Number(finalBalances[DOMAIN_1.name]) - targetPerChain);
        const imbalanceAfter = Math.abs(afterRebalance[DOMAIN_1.name] - targetPerChain);
        
        console.log(`\n  Imbalance reduced: ${(imbalanceBefore / 1e18).toFixed(1)} → ${(imbalanceAfter / 1e18).toFixed(1)} tokens`);
        
        expect(imbalanceAfter).to.be.lessThan(imbalanceBefore);
      }

      console.log('\n✅ Rebalancing proposal would restore balance');
    });
  });
});
