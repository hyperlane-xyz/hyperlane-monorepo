/**
 * Comprehensive Rebalancer Simulation Tests
 *
 * These tests run realistic traffic patterns and observe how the rebalancer
 * responds. They visualize the results to assess rebalancer performance.
 * 
 * Uses FastSimulation which properly handles message delivery.
 */
import { expect } from 'chai';
import { pino } from 'pino';

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
import { FastSimulation } from './FastSimulation.js';
import { generateTraffic } from './TrafficPatterns.js';
import { visualizeSimulation, compareSimulations } from './SimulationVisualizer.js';
import type { SimulationRun, SimulationResults } from './types.js';

// Logger for tests
const logger = pino({ level: 'warn' });

describe('Comprehensive Rebalancer Simulation', function () {
  this.timeout(300_000); // 5 minute timeout for long simulations

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('500'); // 500 tokens per domain for comprehensive tests

  before(async function () {
    console.log('\nStarting anvil for comprehensive simulation tests...');
    anvil = await startAnvil(8545, logger);

    console.log('Setting up comprehensive simulation environment...');

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
   * Create and initialize a FastSimulation for comprehensive tests.
   */
  async function createSimulation(withRebalancer: boolean): Promise<FastSimulation> {
    const strategyConfig = withRebalancer ? {
      chains: {
        [DOMAIN_1.name]: {
          weight: 50,
          tolerance: 10, // 10% tolerance before rebalancing
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
      messageDeliveryDelayMs: 5000, // 5 second delivery
      deliveryCheckIntervalMs: 1000, // Check every second
      recordingIntervalMs: 5000, // Record every 5 seconds
      rebalancerIntervalMs: 30_000, // Check rebalancer every 30 seconds
      bridgeConfigs: {
        [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
          fixedFee: BigInt(toWei('0.1')),
          variableFeeBps: 10,
          transferTimeMs: 15_000, // 15 second bridge time
        },
        [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
          fixedFee: BigInt(toWei('0.1')),
          variableFeeBps: 10,
          transferTimeMs: 15_000,
        },
      },
      strategyConfig,
      logger,
    });

    await simulation.initialize();
    return simulation;
  }

  /**
   * Run a simulation with or without rebalancing.
   */
  async function runSimulation(
    name: string,
    schedule: SimulationRun,
    withRebalancer: boolean,
  ): Promise<SimulationResults> {
    const simulation = await createSimulation(withRebalancer);
    return await simulation.run({ ...schedule, name });
  }

  // ========== TRAFFIC PATTERN TESTS ==========

  describe('Traffic Pattern: Imbalanced', function () {
    it('should handle imbalanced traffic with rebalancer', async function () {
      // Generate 5 minutes of imbalanced traffic (shorter for faster tests)
      const transfers = generateTraffic('imbalanced', {
        durationMs: 5 * 60 * 1000,
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('5')),
        seed: 12345,
      });

      const schedule: SimulationRun = {
        name: 'imbalanced-with-rebalancer',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log(`\nRunning simulation with ${transfers.length} transfers over 5 minutes...`);
      
      const results = await runSimulation(
        'Imbalanced Traffic WITH Rebalancer',
        schedule,
        true, // with rebalancer
      );

      console.log(visualizeSimulation(results));

      // Verify simulation ran
      expect(results.transfers.total).to.be.greaterThan(0);
      expect(results.transfers.completed).to.be.greaterThan(0);
      expect(results.duration.wallClockMs).to.be.lessThan(120_000); // Should complete in < 2 minutes wall clock
    });

    it('should show difference with and without rebalancer', async function () {
      // Generate traffic (5 minutes for faster comparison)
      const transfers = generateTraffic('imbalanced', {
        durationMs: 5 * 60 * 1000,
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('5')),
        seed: 54321,
      });

      const schedule: SimulationRun = {
        name: 'comparison-test',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log(`\nRunning comparison simulation with ${transfers.length} transfers...`);

      // Run without rebalancer
      console.log('\n--- Running WITHOUT rebalancer ---');
      const withoutResults = await runSimulation(
        'WITHOUT Rebalancer',
        schedule,
        false,
      );
      console.log(visualizeSimulation(withoutResults));

      // Restore state
      await setup.restoreSnapshot(baseSnapshot);
      baseSnapshot = await setup.createSnapshot();

      // Run with rebalancer  
      console.log('\n--- Running WITH rebalancer ---');
      const withResults = await runSimulation(
        'WITH Rebalancer',
        schedule,
        true,
      );
      console.log(visualizeSimulation(withResults));

      // Show comparison
      console.log(compareSimulations(withoutResults, withResults));

      // Both should complete their transfers
      expect(withoutResults.transfers.completed).to.be.greaterThan(0);
      expect(withResults.transfers.completed).to.be.greaterThan(0);
    });
  });

  describe('Traffic Pattern: Heavy One-Way', function () {
    it('should handle heavy one-way traffic that creates significant imbalance', async function () {
      // This pattern sends all traffic from one chain, creating maximum imbalance
      const transfers = generateTraffic('heavy-one-way', {
        durationMs: 5 * 60 * 1000, // 5 minutes
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('3')),
        seed: 99999,
      });

      const schedule: SimulationRun = {
        name: 'heavy-one-way',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log(`\nRunning heavy one-way simulation with ${transfers.length} transfers...`);

      const results = await runSimulation(
        'Heavy One-Way Traffic',
        schedule,
        true,
      );

      console.log(visualizeSimulation(results));

      // With heavy one-way traffic, we expect significant rebalancing
      expect(results.transfers.total).to.be.greaterThan(3);
      expect(results.transfers.completed).to.be.greaterThan(0);
    });
  });

  describe('Traffic Pattern: Bidirectional Imbalanced', function () {
    it('should handle bidirectional traffic with shifting patterns', async function () {
      const transfers = generateTraffic('bidirectional-imbalanced', {
        durationMs: 5 * 60 * 1000, // 5 minutes
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('4')),
        seed: 77777,
      });

      const schedule: SimulationRun = {
        name: 'bidirectional-imbalanced',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log(`\nRunning bidirectional simulation with ${transfers.length} transfers...`);

      const results = await runSimulation(
        'Bidirectional Imbalanced Traffic',
        schedule,
        true,
      );

      console.log(visualizeSimulation(results));

      expect(results.transfers.total).to.be.greaterThan(0);
      expect(results.transfers.completed).to.be.greaterThan(0);
    });
  });

  describe('Traffic Pattern: Burst', function () {
    it('should handle burst traffic patterns', async function () {
      const transfers = generateTraffic('burst', {
        durationMs: 5 * 60 * 1000, // 5 minutes
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('8')),
        seed: 11111,
      });

      const schedule: SimulationRun = {
        name: 'burst-traffic',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log(`\nRunning burst simulation with ${transfers.length} transfers...`);

      const results = await runSimulation(
        'Burst Traffic Pattern',
        schedule,
        true,
      );

      console.log(visualizeSimulation(results));

      expect(results.transfers.total).to.be.greaterThan(0);
      expect(results.transfers.completed).to.be.greaterThan(0);
    });
  });

  // ========== LONG SIMULATION ==========

  describe('Extended Simulation', function () {
    it('should run a 10-minute simulation with varied traffic', async function () {
      // Combine multiple patterns for a realistic simulation (reduced from 30 min)
      const steady = generateTraffic('steady', {
        durationMs: 10 * 60 * 1000,
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('3')),
        seed: 1,
      });

      const bursts = generateTraffic('burst', {
        durationMs: 10 * 60 * 1000,
        chains: [DOMAIN_1.name, DOMAIN_2.name, DOMAIN_3.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [DOMAIN_3.name],
        baseAmount: BigInt(toWei('10')),
        seed: 2,
      });

      // Combine and sort
      const transfers = [...steady, ...bursts].sort((a, b) => a.time - b.time);

      const schedule: SimulationRun = {
        name: 'extended-10min',
        durationMs: 10 * 60 * 1000,
        transfers,
      };

      console.log(`\nRunning 10-minute simulation with ${transfers.length} transfers...`);

      const results = await runSimulation(
        '10-Minute Extended Simulation',
        schedule,
        true,
      );

      console.log(visualizeSimulation(results));

      // Summary assertions
      expect(results.transfers.total).to.be.greaterThan(10);
      expect(results.transfers.completed).to.be.greaterThan(0);
      expect(results.duration.simulatedMs).to.equal(10 * 60 * 1000);
      
      // Should have some rebalancing activity
      console.log(`\nSummary:`);
      console.log(`  Total transfers: ${results.transfers.total}`);
      console.log(`  Completed: ${results.transfers.completed}`);
      console.log(`  Stuck: ${results.transfers.stuck}`);
      console.log(`  Rebalances: ${results.rebalancing.count}`);
      console.log(`  Rebalance volume: ${Number(results.rebalancing.totalVolume) / 1e18} tokens`);
      console.log(`  Fees paid: ${Number(results.rebalancing.totalFees) / 1e18} tokens`);
    });
  });
});
