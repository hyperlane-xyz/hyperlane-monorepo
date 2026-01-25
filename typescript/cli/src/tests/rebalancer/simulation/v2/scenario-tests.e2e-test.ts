/**
 * Scenario Tests
 *
 * These tests demonstrate various simulation scenarios using:
 * - Different traffic patterns (steady, burst, imbalanced, etc.)
 * - Variable message delivery times (per-route configuration)
 * - Different rebalancer configurations
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
import {
  IntegratedSimulation,
  createWeightedStrategyConfig,
} from './IntegratedSimulation.js';
import { generateTraffic, trafficPatterns } from './TrafficPatterns.js';
import { visualizeSimulation } from './SimulationVisualizer.js';
import type {
  SimulationRun,
  ScheduledTransfer,
  RouteDeliveryConfigs,
} from './types.js';
import { ROUTE_DELIVERY_PRESETS } from './types.js';

// Logger for tests
const logger = pino({ level: 'info' });

describe('Scenario Tests', function () {
  this.timeout(600_000); // 10 minute timeout

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('5000');

  before(async function () {
    console.log('\nStarting anvil for scenario tests...');
    anvil = await startAnvil(8545, logger);

    setup = await createRebalancerTestSetup({
      collateralDomains: COLLATERAL_DOMAINS,
      syntheticDomains: SYNTHETIC_DOMAINS,
      initialCollateral: BigInt(INITIAL_COLLATERAL),
      logger,
      simulatedBridge: {
        fixedFee: 0n,
        variableFeeBps: 10,
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
   * Create a simulation with custom delivery and rebalancer configs.
   */
  async function createSimulation(options: {
    tolerance?: number;
    rebalancerCheckFrequencyMs?: number;
    messageDeliveryDelayMs?: number;
    routeDeliveryConfigs?: RouteDeliveryConfigs;
    bridgeTransferDelayMs?: number;
  }): Promise<IntegratedSimulation> {
    const {
      tolerance = 5,
      rebalancerCheckFrequencyMs = 5000,
      messageDeliveryDelayMs = 2000,
      routeDeliveryConfigs,
      bridgeTransferDelayMs = 3000,
    } = options;

    const strategyConfig = createWeightedStrategyConfig(setup, {
      [DOMAIN_1.name]: { weight: 50, tolerance },
      [DOMAIN_2.name]: { weight: 50, tolerance },
    });

    const simulation = new IntegratedSimulation({
      setup,
      warpRouteId: 'test-warp-route',
      messageDeliveryDelayMs,
      routeDeliveryConfigs,
      deliveryCheckIntervalMs: 500,
      recordingIntervalMs: 1000,
      rebalancerCheckFrequencyMs,
      bridgeTransferDelayMs,
      bridgeConfigs: {
        [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
          fixedFee: 0n,
          variableFeeBps: 10,
          transferTimeMs: bridgeTransferDelayMs,
        },
        [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
          fixedFee: 0n,
          variableFeeBps: 10,
          transferTimeMs: bridgeTransferDelayMs,
        },
      },
      strategyConfig,
      logger,
    });

    await simulation.initialize();
    return simulation;
  }

  // ==========================================================================
  // TRAFFIC PATTERN TESTS
  // ==========================================================================

  describe('Traffic Patterns', function () {
    it('should handle steady traffic pattern', async function () {
      const simulation = await createSimulation({ tolerance: 5 });

      // Generate steady traffic
      const transfers = generateTraffic('steady', {
        durationMs: 5 * 60 * 1000, // 5 minutes simulated
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('100')),
        seed: 12345,
      }).slice(0, 15); // Take 15 transfers

      const schedule: SimulationRun = {
        name: 'steady-traffic-pattern',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('TRAFFIC PATTERN: Steady');
      console.log('='.repeat(70));
      console.log(`Transfers: ${transfers.length}`);
      console.log('Characteristics: Uniform distribution, 70/30 directional split');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(transfers.length);
    });

    it('should handle burst traffic pattern', async function () {
      const simulation = await createSimulation({ tolerance: 5 });

      // Generate burst traffic
      const transfers = generateTraffic('burst', {
        durationMs: 10 * 60 * 1000, // 10 minutes simulated
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('150')),
        seed: 67890,
      }).slice(0, 20); // Take 20 transfers

      const schedule: SimulationRun = {
        name: 'burst-traffic-pattern',
        durationMs: 10 * 60 * 1000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('TRAFFIC PATTERN: Burst');
      console.log('='.repeat(70));
      console.log(`Transfers: ${transfers.length}`);
      console.log('Characteristics: Clustered bursts, 90/10 directional during bursts');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(transfers.length);
    });

    it('should handle imbalanced traffic pattern', async function () {
      const simulation = await createSimulation({ tolerance: 3 }); // Tighter tolerance

      // Generate imbalanced traffic
      const transfers = generateTraffic('imbalanced', {
        durationMs: 5 * 60 * 1000,
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('100')),
        seed: 11111,
      }).slice(0, 20);

      const schedule: SimulationRun = {
        name: 'imbalanced-traffic-pattern',
        durationMs: 5 * 60 * 1000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('TRAFFIC PATTERN: Imbalanced');
      console.log('='.repeat(70));
      console.log(`Transfers: ${transfers.length}`);
      console.log('Characteristics: 80% from one chain, creates steady imbalance');
      console.log('Tolerance: 3% (triggers rebalancing more often)');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(transfers.length);
      // With imbalanced traffic, rebalancer should have triggered
      expect(results.rebalancing.count).to.be.greaterThan(0);
    });

    it('should handle heavy one-way traffic', async function () {
      const simulation = await createSimulation({ tolerance: 2 }); // Very tight

      // Generate heavy one-way traffic
      const transfers = generateTraffic('heavy-one-way', {
        durationMs: 3 * 60 * 1000,
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('80')),
        seed: 22222,
      }).slice(0, 15);

      const schedule: SimulationRun = {
        name: 'heavy-one-way-pattern',
        durationMs: 3 * 60 * 1000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('TRAFFIC PATTERN: Heavy One-Way');
      console.log('='.repeat(70));
      console.log(`Transfers: ${transfers.length}`);
      console.log('Characteristics: All traffic from one chain, maximum imbalance');
      console.log('Tolerance: 2% (very sensitive rebalancer)');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(transfers.length);
      // Heavy one-way traffic should definitely trigger rebalancing
      expect(results.rebalancing.count).to.be.greaterThan(0);
    });
  });

  // ==========================================================================
  // VARIABLE DELIVERY TIME TESTS
  // ==========================================================================

  describe('Variable Delivery Times', function () {
    it('should handle fast uniform delivery', async function () {
      const chains = [DOMAIN_1.name, DOMAIN_2.name];
      const routeDeliveryConfigs = ROUTE_DELIVERY_PRESETS.fastUniform(chains);

      const simulation = await createSimulation({
        tolerance: 5,
        routeDeliveryConfigs,
      });

      // Simple transfers to test delivery timing
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 10; i++) {
        transfers.push({
          time: i * 2000,
          origin: i % 2 === 0 ? DOMAIN_1.name : DOMAIN_2.name,
          destination: i % 2 === 0 ? DOMAIN_2.name : DOMAIN_1.name,
          amount: BigInt(toWei('100')),
        });
      }

      const schedule: SimulationRun = {
        name: 'fast-uniform-delivery',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('DELIVERY CONFIG: Fast Uniform');
      console.log('='.repeat(70));
      console.log('All routes: 2000ms ± 500ms');
      console.log(`Transfers: ${transfers.length}`);
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(10);
      // Fast delivery should result in lower latencies
      expect(results.transfers.latency.mean).to.be.lessThan(10000);
    });

    it('should handle slow uniform delivery', async function () {
      const chains = [DOMAIN_1.name, DOMAIN_2.name];
      const routeDeliveryConfigs = ROUTE_DELIVERY_PRESETS.slowUniform(chains);

      const simulation = await createSimulation({
        tolerance: 5,
        routeDeliveryConfigs,
        rebalancerCheckFrequencyMs: 8000, // Slower polling to match slower delivery
      });

      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 8; i++) {
        transfers.push({
          time: i * 3000,
          origin: i % 2 === 0 ? DOMAIN_1.name : DOMAIN_2.name,
          destination: i % 2 === 0 ? DOMAIN_2.name : DOMAIN_1.name,
          amount: BigInt(toWei('100')),
        });
      }

      const schedule: SimulationRun = {
        name: 'slow-uniform-delivery',
        durationMs: 120_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('DELIVERY CONFIG: Slow Uniform');
      console.log('='.repeat(70));
      console.log('All routes: 10000ms ± 2000ms');
      console.log(`Transfers: ${transfers.length}`);
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(8);
      // Slow delivery should result in higher latencies
      expect(results.transfers.latency.mean).to.be.greaterThan(8000);
    });

    it('should handle asymmetric route delivery times', async function () {
      const chains = [DOMAIN_1.name, DOMAIN_2.name];
      const routeDeliveryConfigs = ROUTE_DELIVERY_PRESETS.asymmetric(chains);

      console.log('\n' + '='.repeat(70));
      console.log('DELIVERY CONFIG: Asymmetric');
      console.log('='.repeat(70));
      console.log('Route delivery times:');
      for (const [route, config] of Object.entries(routeDeliveryConfigs)) {
        console.log(`  ${route}: ${config.delayMs}ms ± ${config.varianceMs}ms`);
      }
      console.log('='.repeat(70) + '\n');

      const simulation = await createSimulation({
        tolerance: 5,
        routeDeliveryConfigs,
      });

      // Create transfers in both directions
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 10; i++) {
        // 5 in fast direction, 5 in slow direction
        const isFastDirection = i < 5;
        transfers.push({
          time: i * 2000,
          origin: isFastDirection ? DOMAIN_1.name : DOMAIN_2.name,
          destination: isFastDirection ? DOMAIN_2.name : DOMAIN_1.name,
          amount: BigInt(toWei('100')),
        });
      }

      const schedule: SimulationRun = {
        name: 'asymmetric-delivery',
        durationMs: 120_000,
        transfers,
      };

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(10);

      // Analyze latency distribution - should see bimodal pattern
      const transferMetrics = results.transferMetrics;
      const fastDirectionLatencies = transferMetrics
        .filter(t => t.origin === DOMAIN_1.name && t.destination === DOMAIN_2.name)
        .map(t => t.latencyMs);
      const slowDirectionLatencies = transferMetrics
        .filter(t => t.origin === DOMAIN_2.name && t.destination === DOMAIN_1.name)
        .map(t => t.latencyMs);

      console.log('\nLatency Analysis:');
      console.log(`  Fast direction (${DOMAIN_1.name}→${DOMAIN_2.name}): avg ${
        (fastDirectionLatencies.reduce((a, b) => a + b, 0) / fastDirectionLatencies.length).toFixed(0)
      }ms`);
      console.log(`  Slow direction (${DOMAIN_2.name}→${DOMAIN_1.name}): avg ${
        (slowDirectionLatencies.reduce((a, b) => a + b, 0) / slowDirectionLatencies.length).toFixed(0)
      }ms`);
    });

    it('should handle high variance delivery times', async function () {
      const chains = [DOMAIN_1.name, DOMAIN_2.name];
      const routeDeliveryConfigs = ROUTE_DELIVERY_PRESETS.highVariance(chains);

      const simulation = await createSimulation({
        tolerance: 5,
        routeDeliveryConfigs,
      });

      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 12; i++) {
        transfers.push({
          time: i * 2000,
          origin: i % 2 === 0 ? DOMAIN_1.name : DOMAIN_2.name,
          destination: i % 2 === 0 ? DOMAIN_2.name : DOMAIN_1.name,
          amount: BigInt(toWei('100')),
        });
      }

      const schedule: SimulationRun = {
        name: 'high-variance-delivery',
        durationMs: 120_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('DELIVERY CONFIG: High Variance');
      console.log('='.repeat(70));
      console.log('All routes: 8000ms ± 7000ms (range: 1-15 seconds)');
      console.log(`Transfers: ${transfers.length}`);
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(12);

      // High variance should result in wide latency spread
      const latencyRange = results.transfers.latency.max - results.transfers.latency.min;
      console.log(`\nLatency range: ${latencyRange}ms (min: ${results.transfers.latency.min}, max: ${results.transfers.latency.max})`);
    });
  });

  // ==========================================================================
  // COMBINED SCENARIOS
  // ==========================================================================

  describe('Combined Scenarios', function () {
    it('should handle burst traffic with slow delivery', async function () {
      const chains = [DOMAIN_1.name, DOMAIN_2.name];

      const simulation = await createSimulation({
        tolerance: 3,
        routeDeliveryConfigs: ROUTE_DELIVERY_PRESETS.slowUniform(chains),
        rebalancerCheckFrequencyMs: 5000,
      });

      // Generate burst traffic
      const transfers = generateTraffic('burst', {
        durationMs: 10 * 60 * 1000,
        chains,
        collateralChains: chains,
        syntheticChains: [],
        baseAmount: BigInt(toWei('120')),
        seed: 33333,
      }).slice(0, 15);

      const schedule: SimulationRun = {
        name: 'burst-with-slow-delivery',
        durationMs: 10 * 60 * 1000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('COMBINED SCENARIO: Burst Traffic + Slow Delivery');
      console.log('='.repeat(70));
      console.log('Traffic: Burst pattern (clustered transfers)');
      console.log('Delivery: Slow uniform (10s ± 2s)');
      console.log('Challenge: Many transfers pending simultaneously');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(transfers.length);
    });

    it('should handle heavy one-way traffic with asymmetric delivery', async function () {
      const chains = [DOMAIN_1.name, DOMAIN_2.name];

      const simulation = await createSimulation({
        tolerance: 2,
        routeDeliveryConfigs: ROUTE_DELIVERY_PRESETS.asymmetric(chains),
      });

      // Heavy one-way traffic from domain1 to domain2
      // But delivery from domain1→domain2 is fast!
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 20; i++) {
        transfers.push({
          time: i * 1500,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('150')),
        });
      }

      const schedule: SimulationRun = {
        name: 'one-way-asymmetric',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('COMBINED SCENARIO: One-Way Traffic + Asymmetric Delivery');
      console.log('='.repeat(70));
      console.log('Traffic: All domain1 → domain2 (20 × 150 = 3000 tokens)');
      console.log('Delivery: domain1→domain2 is FAST (2s), domain2→domain1 is SLOW (20s)');
      console.log('Challenge: Rebalancer needs to move tokens back, but reverse is slow');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.completed).to.equal(20);
      // Heavy one-way should trigger rebalancing
      expect(results.rebalancing.count).to.be.greaterThan(0);
    });
  });
});
