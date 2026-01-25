/**
 * Fast Simulation E2E Tests
 *
 * Tests the optimized FastSimulation with dozens of transfers.
 * Uses pre-approved tokens and batched execution for speed.
 */
import { expect } from 'chai';
import { pino } from 'pino';

import { toWei } from '@hyperlane-xyz/utils';

import {
  DOMAIN_1,
  DOMAIN_2,
  DOMAIN_3,
  createRebalancerTestSetup,
  type RebalancerTestSetup,
  type SnapshotInfo,
} from '../../harness/index.js';
import { FastSimulation } from './FastSimulation.js';
import { generateTraffic } from './TrafficPatterns.js';
import { visualizeSimulation, compareSimulations } from './SimulationVisualizer.js';
import type { SimulationRun, ScheduledTransfer } from './types.js';

// Logger for tests
const logger = pino({ level: 'warn' });

describe('Fast Simulation (Optimized)', function () {
  this.timeout(300_000); // 5 minute timeout for comprehensive tests

  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('1000'); // 1000 tokens per domain (more for many transfers)

  before(async function () {
    console.log('\nSetting up fast simulation environment...');
    console.log('This setup deploys contracts and pre-approves tokens.\n');

    setup = await createRebalancerTestSetup({
      collateralDomains: COLLATERAL_DOMAINS,
      syntheticDomains: SYNTHETIC_DOMAINS,
      initialCollateral: BigInt(INITIAL_COLLATERAL),
      logger,
      simulatedBridge: {
        fixedFee: 0n,
        variableFeeBps: 10, // 0.1% fee
      },
    });

    baseSnapshot = await setup.createSnapshot();
    console.log('Environment ready\n');
  });

  afterEach(async function () {
    await setup.restoreSnapshot(baseSnapshot);
    baseSnapshot = await setup.createSnapshot();
  });

  /**
   * Create and initialize a FastSimulation.
   */
  async function createSimulation(withRebalancer: boolean): Promise<FastSimulation> {
    const strategyConfig = withRebalancer ? {
      chains: {
        [DOMAIN_1.name]: {
          weight: 50,
          tolerance: 10,
          bridge: setup.getBridge(DOMAIN_1.name, DOMAIN_2.name),
        },
        [DOMAIN_2.name]: {
          weight: 50,
          tolerance: 10,
          bridge: setup.getBridge(DOMAIN_2.name, DOMAIN_1.name),
        },
      },
    } : null;

    const simulation = new FastSimulation({
      setup,
      messageDeliveryDelayMs: 2000, // 2 second delivery
      deliveryCheckIntervalMs: 500, // Check every 500ms
      recordingIntervalMs: 1000, // Record every second
      rebalancerIntervalMs: 5000, // Check rebalancer every 5 seconds
      bridgeConfigs: {
        [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
          fixedFee: BigInt(toWei('0.1')),
          variableFeeBps: 10,
          transferTimeMs: 3000, // 3 second bridge time
        },
        [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
          fixedFee: BigInt(toWei('0.1')),
          variableFeeBps: 10,
          transferTimeMs: 3000,
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
    it('should handle a few transfers quickly', async function () {
      const simulation = await createSimulation(true);

      const schedule: SimulationRun = {
        name: 'smoke-test',
        durationMs: 60_000, // 1 minute simulated
        transfers: [
          { time: 0, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('5')) },
          { time: 10_000, origin: DOMAIN_2.name, destination: DOMAIN_1.name, amount: BigInt(toWei('3')) },
          { time: 20_000, origin: DOMAIN_1.name, destination: DOMAIN_2.name, amount: BigInt(toWei('7')) },
        ],
      };

      console.log(`\nRunning smoke test with ${schedule.transfers.length} transfers...`);
      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.total).to.equal(3);
      expect(results.transfers.completed).to.equal(3);
      expect(results.transfers.stuck).to.equal(0);
      expect(results.duration.wallClockMs).to.be.lessThan(30_000); // Should complete in < 30s
    });
  });

  // ========== DOZEN TRANSFERS ==========

  describe('Dozen Transfers', function () {
    it('should handle 12 transfers efficiently', async function () {
      const simulation = await createSimulation(true);

      // Create 12 transfers over 2 minutes simulated time
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 12; i++) {
        const origin = i % 2 === 0 ? DOMAIN_1.name : DOMAIN_2.name;
        const destination = i % 2 === 0 ? DOMAIN_2.name : DOMAIN_1.name;
        transfers.push({
          time: i * 10_000, // Every 10 seconds simulated
          origin,
          destination,
          amount: BigInt(toWei(String(3 + (i % 5)))), // 3-7 tokens
        });
      }

      const schedule: SimulationRun = {
        name: 'dozen-transfers',
        durationMs: 2 * 60_000, // 2 minutes simulated
        transfers,
      };

      console.log(`\nRunning simulation with ${schedule.transfers.length} transfers...`);
      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;
      
      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${wallTime}ms (${(wallTime / 1000).toFixed(1)}s)`);
      console.log(`Transfers per second: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)}`);

      expect(results.transfers.total).to.equal(12);
      expect(results.transfers.completed).to.equal(12);
      expect(results.transfers.stuck).to.equal(0);
    });
  });

  // ========== 25 TRANSFERS ==========

  describe('25 Transfers', function () {
    it('should handle 25 transfers with good throughput', async function () {
      const simulation = await createSimulation(true);

      // Create 25 transfers
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 25; i++) {
        const origins = [DOMAIN_1.name, DOMAIN_2.name];
        const origin = origins[i % 2];
        const destination = origins[(i + 1) % 2];
        transfers.push({
          time: i * 5_000, // Every 5 seconds simulated
          origin,
          destination,
          amount: BigInt(toWei(String(2 + (i % 8)))), // 2-9 tokens
        });
      }

      const schedule: SimulationRun = {
        name: '25-transfers',
        durationMs: 3 * 60_000, // 3 minutes simulated
        transfers,
      };

      console.log(`\nRunning simulation with ${schedule.transfers.length} transfers...`);
      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${wallTime}ms (${(wallTime / 1000).toFixed(1)}s)`);
      console.log(`Transfers per second: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)}`);

      expect(results.transfers.total).to.equal(25);
      expect(results.transfers.completed).to.equal(25);
      expect(results.duration.wallClockMs).to.be.lessThan(120_000); // < 2 minutes wall time
    });
  });

  // ========== 50 TRANSFERS ==========

  describe('50 Transfers', function () {
    it('should handle 50 transfers', async function () {
      const simulation = await createSimulation(true);

      // Create 50 transfers using imbalanced pattern
      const transfers = generateTraffic('imbalanced', {
        durationMs: 10 * 60_000, // 10 minutes simulated
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('5')),
        seed: 12345,
      }).slice(0, 50); // Take first 50

      const schedule: SimulationRun = {
        name: '50-transfers-imbalanced',
        durationMs: 10 * 60_000,
        transfers,
      };

      console.log(`\nRunning simulation with ${schedule.transfers.length} transfers...`);
      console.log('Traffic pattern: imbalanced (80% from domain1)');
      
      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${wallTime}ms (${(wallTime / 1000).toFixed(1)}s)`);
      console.log(`Transfers per second: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)}`);
      console.log(`Rebalances triggered: ${results.rebalancing.count}`);

      expect(results.transfers.total).to.equal(50);
      expect(results.transfers.completed).to.equal(50);
    });
  });

  // ========== COMPARISON TEST ==========

  describe('Comparison: With vs Without Rebalancer', function () {
    it('should show impact of rebalancer on 30 imbalanced transfers', async function () {
      // Generate 30 heavily imbalanced transfers (all from domain1 to domain2)
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 30; i++) {
        transfers.push({
          time: i * 3_000, // Every 3 seconds simulated
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei(String(5 + (i % 10)))), // 5-14 tokens
        });
      }

      const schedule: SimulationRun = {
        name: 'comparison-30-transfers',
        durationMs: 5 * 60_000, // 5 minutes simulated
        transfers,
      };

      console.log(`\nRunning comparison with ${schedule.transfers.length} heavily imbalanced transfers...`);
      console.log('All transfers go from domain1 → domain2\n');

      // Run WITHOUT rebalancer
      console.log('--- Running WITHOUT rebalancer ---');
      let simulation = await createSimulation(false);
      const withoutResults = await simulation.run({ ...schedule, name: 'WITHOUT Rebalancer' });
      console.log(visualizeSimulation(withoutResults));

      // Restore state
      await setup.restoreSnapshot(baseSnapshot);
      baseSnapshot = await setup.createSnapshot();

      // Run WITH rebalancer
      console.log('\n--- Running WITH rebalancer ---');
      simulation = await createSimulation(true);
      const withResults = await simulation.run({ ...schedule, name: 'WITH Rebalancer' });
      console.log(visualizeSimulation(withResults));

      // Show comparison
      console.log(compareSimulations(withoutResults, withResults));

      // Assertions
      expect(withResults.transfers.total).to.equal(withoutResults.transfers.total);
      // With rebalancer should have executed some rebalances
      expect(withResults.rebalancing.count).to.be.greaterThan(0);
    });
  });

  // ========== STRESS TEST ==========

  describe('Stress Test', function () {
    it('should handle 100 transfers', async function () {
      this.timeout(600_000); // 10 minute timeout

      const simulation = await createSimulation(true);

      // Generate 100 transfers with mixed patterns
      const steady = generateTraffic('steady', {
        durationMs: 15 * 60_000,
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('3')),
        seed: 1,
      });

      const imbalanced = generateTraffic('imbalanced', {
        durationMs: 15 * 60_000,
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('5')),
        seed: 2,
      });

      // Combine and take 100
      const transfers = [...steady, ...imbalanced]
        .sort((a, b) => a.time - b.time)
        .slice(0, 100);

      const schedule: SimulationRun = {
        name: 'stress-test-100',
        durationMs: 15 * 60_000,
        transfers,
      };

      console.log(`\nRunning STRESS TEST with ${schedule.transfers.length} transfers...`);
      console.log('This may take a few minutes.\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      
      console.log('\n=== STRESS TEST SUMMARY ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Rebalances: ${results.rebalancing.count}`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);
      console.log(`Throughput: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)} transfers/second`);
      console.log(`Avg latency: ${(results.transfers.latency.mean / 1000).toFixed(2)}s`);

      expect(results.transfers.total).to.equal(100);
      expect(results.transfers.completed).to.be.greaterThan(90); // Allow some stuck due to timing
    });
  });

  // ========== BURST TRAFFIC ==========

  describe('Burst Traffic Pattern', function () {
    it('should handle burst traffic with 40 transfers', async function () {
      const simulation = await createSimulation(true);

      // Generate burst traffic (clusters of transfers)
      const transfers = generateTraffic('burst', {
        durationMs: 10 * 60_000,
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('8')),
        seed: 42,
      }).slice(0, 40);

      const schedule: SimulationRun = {
        name: 'burst-traffic-40',
        durationMs: 10 * 60_000,
        transfers,
      };

      console.log(`\nRunning burst traffic simulation with ${schedule.transfers.length} transfers...`);
      console.log('Transfers are clustered in burst periods.\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${(wallTime / 1000).toFixed(1)}s`);
      console.log(`Throughput: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)} transfers/second`);

      expect(results.transfers.total).to.equal(40);
      expect(results.transfers.completed).to.equal(40);
    });
  });
});
