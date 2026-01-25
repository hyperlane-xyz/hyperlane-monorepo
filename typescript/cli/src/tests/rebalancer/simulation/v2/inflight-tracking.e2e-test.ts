/**
 * Inflight Tracking E2E Tests
 *
 * These tests specifically target scenarios where the lack of inflight tracking
 * in the simulation could cause the rebalancer to make suboptimal decisions.
 *
 * Background:
 * - The RebalancerService uses ActionTracker with ExplorerClient to track:
 *   1. pendingTransfers: User transfers that are in-flight (need collateral on destination)
 *   2. pendingRebalances: Rebalance operations where origin tx is confirmed
 *
 * - In our local simulation, ExplorerClient queries the production Explorer URL
 *   which doesn't see local Anvil transactions. This means:
 *   - inflightContext will always be empty
 *   - Strategy won't reserve collateral for pending user transfers
 *   - Strategy won't account for in-progress rebalances
 *
 * Potential Issues:
 * 1. Collateral Reservation: Without knowing about pending transfers TO a domain,
 *    the rebalancer might drain that domain's collateral, causing the pending
 *    transfers to fail when they try to deliver.
 *
 * 2. Double Rebalancing: Without tracking pending rebalances, the rebalancer might
 *    propose redundant rebalance operations before the first one completes.
 *
 * 3. Delayed Reaction: The rebalancer only sees on-chain balances, so it reacts
 *    AFTER transfers complete rather than proactively.
 */
import { expect } from 'chai';
import { pino } from 'pino';

import { sleep, toWei } from '@hyperlane-xyz/utils';

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
import { OptimizedTrafficGenerator } from './OptimizedTrafficGenerator.js';
import { visualizeSimulation } from './SimulationVisualizer.js';
import type { SimulationRun, ScheduledTransfer } from './types.js';

// Logger for tests
const logger = pino({ level: 'info' });

describe('Inflight Tracking Edge Cases', function () {
  this.timeout(600_000); // 10 minute timeout

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('5000'); // 5000 tokens per domain

  before(async function () {
    console.log('\nStarting anvil for inflight tracking tests...');
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

  async function createSimulation(
    tolerance: number = 2,
    rebalancerCheckFrequencyMs: number = 5000,
  ): Promise<IntegratedSimulation> {
    const strategyConfig = createWeightedStrategyConfig(setup, {
      [DOMAIN_1.name]: { weight: 50, tolerance },
      [DOMAIN_2.name]: { weight: 50, tolerance },
    });

    const simulation = new IntegratedSimulation({
      setup,
      warpRouteId: 'test-warp-route',
      messageDeliveryDelayMs: 2000,
      deliveryCheckIntervalMs: 500,
      recordingIntervalMs: 1000,
      rebalancerCheckFrequencyMs,
      bridgeTransferDelayMs: 3000,
      bridgeConfigs: {
        [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
          fixedFee: 0n,
          variableFeeBps: 10,
          transferTimeMs: 3000,
        },
        [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
          fixedFee: 0n,
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

  describe('Scenario 1: Rapid-Fire Transfers Before Rebalancer Observes', function () {
    /**
     * This test demonstrates what happens when many transfers are initiated
     * faster than the rebalancer's polling cycle.
     *
     * Expected behavior WITH proper inflight tracking:
     * - Rebalancer sees pending transfers and reserves collateral
     * - Proactively moves collateral before transfers deliver
     *
     * Actual behavior WITHOUT inflight tracking:
     * - Rebalancer only sees on-chain balances
     * - Doesn't know about pending transfers until they deliver
     * - Reacts AFTER the fact, potentially too late
     */
    it('should highlight delayed reaction when transfers arrive faster than polling', async function () {
      // Use a slow polling interval to exaggerate the issue
      const simulation = await createSimulation(2, 10_000); // Poll every 10 seconds

      // Fire 20 transfers in rapid succession (200ms apart = 4 seconds total)
      // Each transfer releases 200 tokens from domain2 when delivered
      // Total: 4000 tokens released from domain2 (leaving only 1000)
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 20; i++) {
        transfers.push({
          time: i * 200, // 200ms apart
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('200')),
        });
      }

      const schedule: SimulationRun = {
        name: 'rapid-fire-transfers',
        durationMs: 30_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO 1: Rapid-Fire Transfers');
      console.log('='.repeat(70));
      console.log('Configuration:');
      console.log('  - Rebalancer polling: every 10 seconds');
      console.log('  - Transfer spacing: 200ms (all 20 transfers in 4 seconds)');
      console.log('  - Each transfer: 200 tokens domain1 → domain2');
      console.log('  - Total impact: 4000 tokens released from domain2');
      console.log('');
      console.log('Without inflight tracking:');
      console.log('  - At t=0: Rebalancer sees 5000/5000 (balanced)');
      console.log('  - At t=4s: All transfers initiated, but rebalancer hasn\'t polled');
      console.log('  - At t=6s: Transfers start delivering, domain2 draining');
      console.log('  - At t=10s: Rebalancer finally polls, sees 5000/1000');
      console.log('');
      console.log('With proper inflight tracking (not implemented):');
      console.log('  - Rebalancer would see pending transfers at any poll');
      console.log('  - Would proactively move collateral before deliveries');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));

      console.log('\n=== RAPID-FIRE TEST RESULTS ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Success rate: ${((results.transfers.completed / results.transfers.total) * 100).toFixed(1)}%`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      // In this scenario, the rebalancer should still succeed because:
      // 1. The initial 5000 tokens on domain2 is enough for all 20 transfers (4000 total)
      // 2. The rebalancer eventually rebalances after seeing the imbalance
      //
      // The test passes, but the rebalancer is reactive, not proactive.
      // With proper inflight tracking, it could have started rebalancing earlier.

      expect(results.transfers.total).to.equal(20);
      expect(results.transfers.completed).to.equal(20);

      // Note: This test doesn't FAIL, but it demonstrates the rebalancer is reactive.
      // A follow-up test with more aggressive traffic could expose actual failures.
      console.log('\nNote: Test passes but rebalancer is REACTIVE, not PROACTIVE.');
      console.log('With inflight tracking, rebalancing could start earlier.\n');
    });
  });

  describe('Scenario 2: Collateral Exhaustion Race', function () {
    /**
     * This test creates a race condition where:
     * 1. Many transfers are pending delivery (but not yet delivered)
     * 2. The rebalancer polls and sees "balanced" balances
     * 3. More transfers come in, and the pending ones start delivering
     * 4. Domain runs out of collateral mid-delivery
     *
     * This requires:
     * - Fast transfer initiation
     * - Slow message delivery (to accumulate pending transfers)
     * - Slow rebalancer polling (to miss the buildup)
     */
    it('should show collateral exhaustion when pending transfers are not tracked', async function () {
      // Create a custom simulation with VERY slow message delivery
      // This accumulates many pending transfers before delivery
      const strategyConfig = createWeightedStrategyConfig(setup, {
        [DOMAIN_1.name]: { weight: 50, tolerance: 2 },
        [DOMAIN_2.name]: { weight: 50, tolerance: 2 },
      });

      const simulation = new IntegratedSimulation({
        setup,
        warpRouteId: 'test-warp-route',
        messageDeliveryDelayMs: 8000, // 8 second delivery delay
        deliveryCheckIntervalMs: 500,
        recordingIntervalMs: 1000,
        rebalancerCheckFrequencyMs: 15_000, // Poll every 15 seconds (slow)
        bridgeTransferDelayMs: 3000,
        bridgeConfigs: {
          [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
            fixedFee: 0n,
            variableFeeBps: 10,
            transferTimeMs: 3000,
          },
          [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
            fixedFee: 0n,
            variableFeeBps: 10,
            transferTimeMs: 3000,
          },
        },
        strategyConfig,
        logger,
      });

      await simulation.initialize();

      // Phase 1: Fire 25 transfers rapidly (drain ~5000 from domain2)
      // These will be PENDING for 8 seconds before delivery starts
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 25; i++) {
        transfers.push({
          time: i * 100, // 100ms apart (2.5 seconds total)
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('200')), // 200 tokens each = 5000 total
        });
      }

      const schedule: SimulationRun = {
        name: 'collateral-exhaustion-race',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO 2: Collateral Exhaustion Race');
      console.log('='.repeat(70));
      console.log('Configuration:');
      console.log('  - Message delivery delay: 8 seconds');
      console.log('  - Rebalancer polling: every 15 seconds');
      console.log('  - 25 transfers × 200 tokens = 5000 total (equals domain2 balance)');
      console.log('');
      console.log('Timeline without inflight tracking:');
      console.log('  t=0-2.5s: All 25 transfers initiated (origin locks complete)');
      console.log('  t=2.5s: Domain2 still shows 5000 tokens (deliveries pending)');
      console.log('  t=8-10.5s: Deliveries start, domain2 drains to 0');
      console.log('  t=15s: Rebalancer first poll, sees imbalance too late');
      console.log('');
      console.log('With inflight tracking (not implemented):');
      console.log('  - At any poll, rebalancer sees 25 pending transfers');
      console.log('  - Reserves 5000 tokens on domain2 for pending deliveries');
      console.log('  - Would proactively rebalance before exhaustion');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));

      console.log('\n=== COLLATERAL EXHAUSTION RACE RESULTS ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Success rate: ${((results.transfers.completed / results.transfers.total) * 100).toFixed(1)}%`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      // The test might pass because:
      // 1. domain2 has exactly 5000 tokens to handle 25 × 200 = 5000
      // 2. Rebalancer kicks in after seeing imbalance
      //
      // To actually see failures, we'd need MORE than 5000 tokens of transfers
      // OR we'd need to verify the rebalancer's decision timing.

      expect(results.transfers.total).to.equal(25);
      
      // Log whether all succeeded or some failed
      if (results.transfers.stuck > 0) {
        console.log('\n!!! SOME TRANSFERS FAILED - INFLIGHT TRACKING WOULD HELP !!!');
        console.log(`Failed transfers: ${results.transfers.stuck}`);
      } else {
        console.log('\nAll transfers succeeded, but this was close to the limit.');
        console.log('Adding more transfers would likely cause failures without inflight tracking.\n');
      }
    });
  });

  describe('Scenario 3: Double Rebalance Prevention', function () {
    /**
     * Without tracking pending rebalances, the rebalancer might:
     * 1. Detect imbalance and initiate rebalance A
     * 2. Poll again before A completes
     * 3. Still see imbalance (A hasn't delivered yet)
     * 4. Initiate redundant rebalance B
     *
     * With proper tracking, the strategy would see pendingRebalances
     * and account for them when calculating deficits.
     */
    it('should potentially show redundant rebalances without pending tracking', async function () {
      // Fast polling to increase chance of catching inflight rebalances
      const simulation = await createSimulation(2, 3000); // Poll every 3 seconds

      // Create imbalanced traffic that triggers rebalancing
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 15; i++) {
        transfers.push({
          time: i * 1000, // 1 second apart
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('200')),
        });
      }

      const schedule: SimulationRun = {
        name: 'double-rebalance-test',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO 3: Double Rebalance Prevention');
      console.log('='.repeat(70));
      console.log('Configuration:');
      console.log('  - Rebalancer polling: every 3 seconds (fast)');
      console.log('  - Bridge transfer delay: 3 seconds');
      console.log('  - 15 transfers creating significant imbalance');
      console.log('');
      console.log('Question: Will the rebalancer propose redundant rebalances?');
      console.log('');
      console.log('Without inflight tracking:');
      console.log('  - Rebalancer sees imbalance, initiates rebalance A');
      console.log('  - 3 seconds later, polls again');
      console.log('  - Still sees imbalance (A not delivered yet)');
      console.log('  - Might initiate redundant rebalance B');
      console.log('');
      console.log('With inflight tracking:');
      console.log('  - pendingRebalances includes A');
      console.log('  - Strategy simulates A\'s effect');
      console.log('  - Correctly determines no additional rebalance needed');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));

      console.log('\n=== DOUBLE REBALANCE TEST RESULTS ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Total volume rebalanced: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      // Calculate expected rebalance volume
      // 15 transfers × 200 = 3000 tokens imbalance
      // One rebalance of ~1500 should fix it
      const expectedMinVolume = BigInt(toWei('1000'));
      const expectedMaxVolume = BigInt(toWei('3000'));

      if (results.rebalancing.totalVolume > expectedMaxVolume) {
        console.log('\n!!! POTENTIAL OVER-REBALANCING DETECTED !!!');
        console.log(`Expected: ${(Number(expectedMaxVolume) / 1e18).toFixed(0)} tokens max`);
        console.log(`Actual: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(0)} tokens`);
        console.log('This could indicate redundant rebalances due to lack of inflight tracking.');
      } else {
        console.log('\nRebalance volume is within expected range.');
        console.log('Note: The rebalancer may still be making slightly suboptimal decisions');
        console.log('due to not accounting for pending rebalances in its calculations.\n');
      }

      expect(results.transfers.completed).to.equal(15);
    });
  });

  describe('Scenario 4: Understanding Current Behavior', function () {
    /**
     * This test logs detailed information about what the rebalancer sees
     * at each polling cycle, helping us understand the actual behavior.
     */
    it('should demonstrate what the rebalancer sees without inflight tracking', async function () {
      // Note: To get detailed logs, we'd need to add logging to the simulation
      // For now, this test just runs a scenario and lets us observe the output

      const simulation = await createSimulation(5, 5000);

      // Simple scenario: 10 transfers creating mild imbalance
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 10; i++) {
        transfers.push({
          time: i * 2000,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('150')),
        });
      }

      const schedule: SimulationRun = {
        name: 'behavior-observation',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO 4: Observing Rebalancer Behavior');
      console.log('='.repeat(70));
      console.log('This test runs a simple scenario to observe:');
      console.log('  - When the rebalancer detects imbalance');
      console.log('  - How it responds to on-chain balance changes');
      console.log('  - The timing of rebalance operations');
      console.log('');
      console.log('Watch the logs for:');
      console.log('  - "Strategy evaluating" with pendingRebalances: 0, pendingTransfers: 0');
      console.log('  - This confirms inflight context is empty');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      console.log('\n=== BEHAVIOR OBSERVATION SUMMARY ===');
      console.log(`Transfers: ${results.transfers.completed}/${results.transfers.total}`);
      console.log(`Rebalances: ${results.rebalancing.count}`);
      console.log(`Volume: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);

      expect(results.transfers.completed).to.equal(10);
    });
  });
});
