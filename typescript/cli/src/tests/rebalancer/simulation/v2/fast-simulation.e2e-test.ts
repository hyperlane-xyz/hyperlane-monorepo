/**
 * Simulation E2E Tests
 *
 * Tests the IntegratedSimulation with the real RebalancerService.
 * Uses minimal delays (100ms) for fast test execution while still
 * running the actual rebalancer daemon.
 */
import { expect } from 'chai';
import { pino } from 'pino';

import { toWei } from '@hyperlane-xyz/utils';

import {
  type AnvilInstance,
  DOMAIN_1,
  DOMAIN_2,
  createRebalancerTestSetup,
  type RebalancerTestSetup,
  type SnapshotInfo,
  startAnvil,
} from '../../harness/index.js';
import {
  IntegratedSimulation,
  createWeightedStrategyConfig,
} from './IntegratedSimulation.js';
import { visualizeSimulation } from './SimulationVisualizer.js';
import type { SimulationRun, ScheduledTransfer } from './types.js';

// Logger for tests - use 'warn' to suppress verbose rebalancer logs
const logger = pino({ level: 'warn' });

describe('Simulation (with Real RebalancerService)', function () {
  this.timeout(300_000);

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  // Use only 2 collateral domains for simpler rebalancing scenarios
  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  // Large pool sizes to allow many large transfers
  const INITIAL_COLLATERAL = toWei('10000'); // 10,000 tokens per domain

  before(async function () {
    console.log('\nStarting anvil for simulation tests...');
    anvil = await startAnvil(8545, logger);

    console.log('Setting up simulation environment...');

    setup = await createRebalancerTestSetup({
      collateralDomains: COLLATERAL_DOMAINS,
      syntheticDomains: [], // No synthetic domains - just collateral-to-collateral
      initialCollateral: BigInt(INITIAL_COLLATERAL),
      logger,
      simulatedBridge: {
        fixedFee: 0n,
        variableFeeBps: 10, // 0.1% fee
      },
    });

    baseSnapshot = await setup.createSnapshot();
    console.log('Environment ready\n');
    console.log('Pool size: 10,000 tokens per domain');
    console.log('Rebalancer tolerance: 5% (triggers at >500 token imbalance)\n');
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

  /**
   * Create and initialize an IntegratedSimulation with minimal delays.
   * Uses the real RebalancerService in daemon mode.
   */
  async function createSimulation(withRebalancer: boolean): Promise<IntegratedSimulation> {
    // Create strategy config only if rebalancer is enabled
    const strategyConfig = withRebalancer
      ? createWeightedStrategyConfig(setup, {
          [DOMAIN_1.name]: { weight: 50, tolerance: 5 },
          [DOMAIN_2.name]: { weight: 50, tolerance: 5 },
        })
      : createWeightedStrategyConfig(setup, {
          // Even without rebalancing, we need valid config for the service
          // Use very high tolerance so it never triggers
          [DOMAIN_1.name]: { weight: 50, tolerance: 100 },
          [DOMAIN_2.name]: { weight: 50, tolerance: 100 },
        });

    const simulation = new IntegratedSimulation({
      setup,
      warpRouteId: 'test-warp-route',
      // Minimal delays for fast execution
      messageDeliveryDelayMs: 100, // 100ms delivery (near-instant)
      deliveryCheckIntervalMs: 50, // Check every 50ms
      recordingIntervalMs: 200, // Record every 200ms
      rebalancerCheckFrequencyMs: 500, // Rebalancer polls every 500ms
      bridgeTransferDelayMs: 200, // 200ms bridge completion time
      bridgeConfigs: {
        [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
          fixedFee: BigInt(toWei('0.1')),
          variableFeeBps: 10,
          transferTimeMs: 200,
        },
        [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
          fixedFee: BigInt(toWei('0.1')),
          variableFeeBps: 10,
          transferTimeMs: 200,
        },
      },
      strategyConfig,
      logger,
    });

    await simulation.initialize();
    return simulation;
  }

  // ========== SMOKE TEST ==========

  describe('Smoke Test', function () {
    it('should complete transfers quickly', async function () {
      const simulation = await createSimulation(false);

      // 10 transfers, each 50 tokens (0.5% of pool)
      const schedule: SimulationRun = {
        name: 'smoke-test',
        durationMs: 5_000, // 5 seconds simulated
        transfers: [
          { time: 0, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('50')) },
          { time: 200, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('50')) },
          { time: 400, origin: DOMAIN_2.name, destination: DOMAIN_1.name, amount: BigInt(toWei('30')) },
          { time: 600, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('50')) },
          { time: 800, origin: DOMAIN_2.name, destination: DOMAIN_1.name, amount: BigInt(toWei('30')) },
          { time: 1000, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('50')) },
          { time: 1200, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('50')) },
          { time: 1400, origin: DOMAIN_2.name, destination: DOMAIN_1.name, amount: BigInt(toWei('30')) },
          { time: 1600, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('50')) },
          { time: 1800, origin: DOMAIN_2.name, destination: DOMAIN_1.name, amount: BigInt(toWei('30')) },
        ],
      };

      console.log(`\nRunning smoke test with ${schedule.transfers.length} transfers...`);
      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.total).to.equal(10);
      expect(results.transfers.completed).to.equal(10);
      expect(results.transfers.stuck).to.equal(0);
      expect(results.duration.wallClockMs).to.be.lessThan(30_000);
    });
  });

  // ========== HEAVY IMBALANCED TRAFFIC ==========

  describe('Heavy Imbalanced Traffic', function () {
    it('should trigger rebalancing with one-way traffic', async function () {
      const simulation = await createSimulation(true);

      // All transfers go domain1 -> domain2, creating heavy imbalance
      // 15 transfers of 100 tokens each = 1500 tokens one way
      // This will create massive imbalance requiring rebalancing
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 15; i++) {
        transfers.push({
          time: i * 200, // Every 200ms (slower to reduce Anvil load)
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('100')), // 100 tokens each (1% of pool)
        });
      }

      const schedule: SimulationRun = {
        name: 'heavy-imbalanced',
        durationMs: 10_000, // 10 seconds
        transfers,
      };

      console.log(`\nRunning heavy imbalanced simulation with ${schedule.transfers.length} transfers...`);
      console.log('All transfers: domain1 → domain2 (100 tokens each = 1500 total)\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      console.log(`\n=== RESULTS ===`);
      console.log(`Transfers: ${results.transfers.completed}/${results.transfers.total}`);
      console.log(`Rebalances triggered: ${results.rebalancing.count}`);
      console.log(`Total rebalanced: ${Number(results.rebalancing.totalVolume) / 1e18} tokens`);
      console.log(`Wall clock time: ${results.duration.wallClockMs}ms`);

      expect(results.transfers.total).to.equal(15);
      // Should trigger rebalancing due to heavy imbalance
      expect(results.rebalancing.count).to.be.greaterThan(0);
    });
  });
});
