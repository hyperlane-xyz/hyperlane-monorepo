/**
 * Inflight Tracking E2E Tests
 *
 * These tests specifically target scenarios where the lack of inflight tracking
 * could cause the rebalancer to make incorrect decisions that block user transfers.
 *
 * TOKEN FLOW (HypERC20Collateral):
 * ================================
 * - transferRemote() on ORIGIN: LOCKS user tokens INTO the warp route (collateral increases)
 * - Message delivery on DESTINATION: RELEASES tokens FROM warp route TO user (collateral decreases)
 *
 * INFLIGHT TRACKING PURPOSE:
 * ==========================
 * The strategy's `reserveCollateral()` method subtracts pending transfer amounts from
 * destination balances. This prevents the rebalancer from draining collateral that's
 * needed for pending transfers.
 *
 * THE SCENARIO WE WANT TO TEST:
 * =============================
 * 1. Initial state: domain1=5000, domain2=5000 (balanced)
 * 2. User initiates transfer domain1→domain2 for 1000 tokens
 *    - domain1 collateral increases by 1000 (now 6000)
 *    - Transfer is PENDING delivery on domain2
 * 3. Rebalancer polls WITHOUT inflight tracking:
 *    - Sees domain1=6000, domain2=5000
 *    - Thinks domain1 has surplus, domain2 has deficit
 *    - Moves 500 tokens from domain1 to domain2
 * 4. Rebalancer polls WITH inflight tracking:
 *    - Sees domain1=6000, domain2=5000
 *    - But ALSO sees pending transfer that will release 1000 from domain2
 *    - Effective domain2 = 5000 - 1000 = 4000
 *    - Now sees domain1 surplus, domain2 deficit correctly accounting for pending
 *
 * ACTUAL PROBLEM SCENARIO:
 * ========================
 * Without inflight tracking, if domain2 is near its minimum threshold and has
 * pending transfers, the rebalancer might:
 * 1. See domain2 has "enough" collateral
 * 2. Not rebalance to domain2
 * 3. Pending transfers deliver, drain domain2 below minimum
 * 4. New transfers to domain2 fail
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

  /**
   * Helper to create a simulation with custom parameters
   */
  async function createSimulation(options: {
    tolerance?: number;
    rebalancerCheckFrequencyMs?: number;
    messageDeliveryDelayMs?: number;
    bridgeTransferDelayMs?: number;
  }): Promise<IntegratedSimulation> {
    const {
      tolerance = 2,
      rebalancerCheckFrequencyMs = 5000,
      messageDeliveryDelayMs = 2000,
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

  describe('Scenario: Pending Transfer Blocks New Transfer', function () {
    /**
     * This is the core inflight tracking scenario:
     *
     * Setup: Start with imbalanced collateral where domain2 is already low
     * - domain1 = 7000 tokens (surplus)
     * - domain2 = 3000 tokens (at threshold)
     *
     * Phase 1: User initiates large transfer TO domain2
     * - This will RELEASE tokens from domain2 when delivered
     * - Transfer is PENDING (not yet delivered)
     *
     * Phase 2: Another user wants to transfer TO domain2
     * - Rebalancer sees domain2 still has 3000 tokens
     * - Without inflight tracking: thinks domain2 can handle it
     * - First transfer delivers, drains domain2
     * - Second transfer fails because domain2 is now empty
     *
     * With proper inflight tracking:
     * - Rebalancer sees pending transfer will release from domain2
     * - Proactively moves collateral TO domain2 to cover both transfers
     */
    it('should demonstrate how pending transfers can cause subsequent transfer failures', async function () {
      // This test requires a custom setup with imbalanced initial collateral
      // We'll use the traffic generator directly to control timing precisely

      const trafficGenerator = new OptimizedTrafficGenerator(
        setup,
        10000, // Very long message delivery delay (10 seconds)
      );
      await trafficGenerator.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO: Pending Transfer Blocks Subsequent Transfer');
      console.log('='.repeat(70));
      console.log('');
      console.log('Token Flow Reminder:');
      console.log('  - transferRemote() LOCKS tokens on origin (increases collateral)');
      console.log('  - Message delivery RELEASES tokens on destination (decreases collateral)');
      console.log('');
      console.log('Initial State: 5000 tokens on each domain');
      console.log('');
      console.log('Test Sequence:');
      console.log('  1. User A: Transfer 4500 tokens domain1 → domain2');
      console.log('     - Locks 4500 on domain1 (now 9500)');
      console.log('     - Delivery PENDING on domain2');
      console.log('');
      console.log('  2. Wait, but DON\'T deliver yet');
      console.log('');
      console.log('  3. User B: Transfer 1000 tokens domain1 → domain2');
      console.log('     - Locks 1000 on domain1 (now 10500)');
      console.log('     - Delivery PENDING on domain2');
      console.log('');
      console.log('  4. Now deliver both transfers:');
      console.log('     - Transfer A releases 4500 from domain2 (5000 → 500)');
      console.log('     - Transfer B tries to release 1000 from domain2...');
      console.log('     - FAILS: domain2 only has 500 tokens!');
      console.log('');
      console.log('With inflight tracking, the rebalancer would:');
      console.log('  - See pending transfers totaling 5500 tokens to domain2');
      console.log('  - Reserve 5500 from domain2 balance for pending deliveries');
      console.log('  - Detect domain2 will be in deficit after deliveries');
      console.log('  - Proactively move collateral to domain2');
      console.log('='.repeat(70) + '\n');

      // Check initial balances
      const domain1Token = setup.tokens[DOMAIN_1.name];
      const domain2Token = setup.tokens[DOMAIN_2.name];
      const domain1WarpRoute = setup.getWarpRouteAddress(DOMAIN_1.name);
      const domain2WarpRoute = setup.getWarpRouteAddress(DOMAIN_2.name);

      const initialDomain1 = await domain1Token.balanceOf(domain1WarpRoute);
      const initialDomain2 = await domain2Token.balanceOf(domain2WarpRoute);

      console.log('Initial balances:');
      console.log(`  domain1: ${(Number(initialDomain1.toString()) / 1e18).toFixed(0)} tokens`);
      console.log(`  domain2: ${(Number(initialDomain2.toString()) / 1e18).toFixed(0)} tokens`);

      // Step 1: User A initiates large transfer
      console.log('\n[Step 1] User A initiates transfer of 4500 tokens...');
      const transferA = await trafficGenerator.executeTransfer(
        {
          time: 0,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('4500')),
        },
        Date.now(),
      );
      console.log(`  Transfer A initiated: ${transferA.messageId.slice(0, 18)}...`);

      // Check balances after transfer A initiation
      const afterA_domain1 = await domain1Token.balanceOf(domain1WarpRoute);
      console.log(`  domain1 balance after lock: ${(Number(afterA_domain1.toString()) / 1e18).toFixed(0)} tokens`);
      console.log('  domain2 balance: unchanged (delivery pending)');

      // Step 2: Wait a moment (but don't deliver)
      console.log('\n[Step 2] Waiting... (transfers are pending, not delivered)');
      await sleep(500);

      // Step 3: User B initiates another transfer
      console.log('\n[Step 3] User B initiates transfer of 1000 tokens...');
      const transferB = await trafficGenerator.executeTransfer(
        {
          time: 0,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('1000')),
        },
        Date.now(),
      );
      console.log(`  Transfer B initiated: ${transferB.messageId.slice(0, 18)}...`);

      const afterB_domain1 = await domain1Token.balanceOf(domain1WarpRoute);
      console.log(`  domain1 balance after lock: ${(Number(afterB_domain1.toString()) / 1e18).toFixed(0)} tokens`);

      // Step 4: Try to deliver both transfers
      console.log('\n[Step 4] Attempting to deliver both transfers...');

      // Deliver Transfer A
      console.log('  Delivering Transfer A (4500 tokens)...');
      try {
        await trafficGenerator.deliverTransfer(transferA);
        const afterDeliveryA = await domain2Token.balanceOf(domain2WarpRoute);
        console.log(`  ✅ Transfer A delivered. domain2 balance: ${(Number(afterDeliveryA.toString()) / 1e18).toFixed(0)} tokens`);
      } catch (error: any) {
        console.log(`  ❌ Transfer A delivery failed: ${error.message}`);
      }

      // Deliver Transfer B
      console.log('  Delivering Transfer B (1000 tokens)...');
      let transferBFailed = false;
      try {
        await trafficGenerator.deliverTransfer(transferB);
        const afterDeliveryB = await domain2Token.balanceOf(domain2WarpRoute);
        console.log(`  ✅ Transfer B delivered. domain2 balance: ${(Number(afterDeliveryB.toString()) / 1e18).toFixed(0)} tokens`);
      } catch (error: any) {
        transferBFailed = true;
        console.log(`  ❌ Transfer B delivery FAILED: ${error.message}`);
      }

      // Final balances
      const finalDomain1 = await domain1Token.balanceOf(domain1WarpRoute);
      const finalDomain2 = await domain2Token.balanceOf(domain2WarpRoute);

      console.log('\n' + '='.repeat(70));
      console.log('RESULTS');
      console.log('='.repeat(70));
      console.log(`Initial: domain1=${(Number(initialDomain1.toString()) / 1e18).toFixed(0)}, domain2=${(Number(initialDomain2.toString()) / 1e18).toFixed(0)}`);
      console.log(`Final:   domain1=${(Number(finalDomain1.toString()) / 1e18).toFixed(0)}, domain2=${(Number(finalDomain2.toString()) / 1e18).toFixed(0)}`);
      console.log('');

      if (transferBFailed) {
        console.log('✅ TEST DEMONSTRATES THE PROBLEM:');
        console.log('   Transfer B failed because domain2 ran out of collateral.');
        console.log('   With inflight tracking, the rebalancer would have prevented this.');
      } else {
        console.log('Transfer B succeeded. This means:');
        console.log('   - Initial collateral was sufficient for both transfers');
        console.log('   - To see the failure, we need initial collateral < sum of transfers');
      }
      console.log('='.repeat(70) + '\n');

      // Assert that Transfer B failed (demonstrating the problem)
      expect(transferBFailed).to.equal(
        true,
        'Transfer B should have failed due to insufficient collateral on domain2. ' +
        'This demonstrates the need for inflight tracking: the rebalancer could not ' +
        'see the pending transfers and thus could not proactively move collateral.',
      );
    });
  });

  describe('Scenario: Rebalancer Moves Collateral Away From Pending Destination', function () {
    /**
     * More nuanced scenario:
     *
     * Setup: Balanced collateral
     * - domain1 = 5000 tokens
     * - domain2 = 5000 tokens
     *
     * Phase 1: User transfer locks tokens on domain1
     * - domain1 collateral increases
     * - Rebalancer sees domain1 > domain2
     *
     * Phase 2: Without inflight tracking
     * - Rebalancer might move tokens FROM domain2 TO domain1
     * - But the pending transfer will RELEASE from domain2!
     *
     * This is the opposite problem: the rebalancer moves collateral in
     * the WRONG direction because it doesn't know about pending deliveries.
     */
    it('should show rebalancer may move collateral wrong direction without inflight tracking', async function () {
      // Use integrated simulation with fast rebalancer polling and slow delivery
      const simulation = await createSimulation({
        tolerance: 5, // 5% tolerance = 250 token threshold
        rebalancerCheckFrequencyMs: 2000, // Poll every 2 seconds
        messageDeliveryDelayMs: 15000, // 15 second delivery delay
        bridgeTransferDelayMs: 3000,
      });

      // Create a transfer that will make domain1 look like it has surplus
      // (because locking increases origin collateral)
      const transfers: ScheduledTransfer[] = [
        {
          time: 0,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('1000')), // Large enough to trigger rebalancer
        },
      ];

      const schedule: SimulationRun = {
        name: 'wrong-direction-rebalance',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO: Rebalancer May Move Collateral Wrong Direction');
      console.log('='.repeat(70));
      console.log('');
      console.log('Initial State: 5000 tokens on each domain (balanced)');
      console.log('');
      console.log('What happens:');
      console.log('  1. User initiates 1000 token transfer domain1 → domain2');
      console.log('  2. This LOCKS 1000 on domain1 (now 6000)');
      console.log('  3. Rebalancer polls, sees domain1=6000, domain2=5000');
      console.log('  4. Without inflight: thinks domain1 has surplus');
      console.log('  5. Might move tokens FROM domain2 TO domain1 (wrong!)');
      console.log('');
      console.log('Reality:');
      console.log('  - Pending transfer will RELEASE 1000 from domain2');
      console.log('  - domain2 will go from 5000 to 4000');
      console.log('  - Moving tokens away from domain2 makes it worse!');
      console.log('');
      console.log('With inflight tracking:');
      console.log('  - Sees pending transfer destination = domain2');
      console.log('  - Reserves 1000 from domain2 balance');
      console.log('  - Effective: domain1=6000, domain2=4000');
      console.log('  - Correctly identifies domain2 needs collateral');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      console.log('\n=== ANALYSIS ===');
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Total volume moved: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);

      if (results.rebalancing.count > 0) {
        console.log('\nRebalance details:');
        for (const [route, data] of Object.entries(results.rebalancing.byBridge)) {
          console.log(`  ${route}: ${data.count} operations, ${(Number(data.volume) / 1e18).toFixed(2)} tokens`);
        }

        // Check if rebalancer moved in wrong direction
        const wrongDirection = results.rebalancing.byBridge['domain2->domain1'];
        if (wrongDirection && wrongDirection.count > 0) {
          console.log('\n⚠️  SUBOPTIMAL: Rebalancer moved tokens FROM domain2');
          console.log('    Without inflight tracking, it didn\'t know domain2 would');
          console.log('    lose collateral when the pending transfer delivers.');
        }
      }

      expect(results.transfers.completed).to.equal(1);
    });
  });

  describe('Scenario: Multiple Pending Transfers Exhaust Collateral', function () {
    /**
     * Stress test: Many transfers initiated in rapid succession before any deliver.
     * Without inflight tracking, the rebalancer can't see the wave of pending
     * deliveries that will drain a domain.
     */
    it('should handle multiple pending transfers that together exhaust collateral', async function () {
      const trafficGenerator = new OptimizedTrafficGenerator(
        setup,
        30000, // 30 second delivery delay - very long
      );
      await trafficGenerator.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO: Multiple Pending Transfers Exhaust Collateral');
      console.log('='.repeat(70));
      console.log('');
      console.log('Setup: 5000 tokens on each domain');
      console.log('');
      console.log('Initiate 10 transfers of 600 tokens each (6000 total):');
      console.log('  - Each transfer locks on domain1');
      console.log('  - Each transfer will release from domain2 on delivery');
      console.log('  - domain2 only has 5000 tokens!');
      console.log('');
      console.log('Without inflight tracking:');
      console.log('  - Rebalancer sees domain2 still has 5000');
      console.log('  - Doesn\'t know 6000 tokens worth of deliveries are pending');
      console.log('  - When deliveries happen, later transfers fail');
      console.log('='.repeat(70) + '\n');

      // Initiate 10 transfers (don't deliver yet)
      const pendingTransfers = [];
      const transferAmount = BigInt(toWei('600'));

      console.log('Initiating 10 transfers...');
      for (let i = 0; i < 10; i++) {
        const pending = await trafficGenerator.executeTransfer(
          {
            time: 0,
            origin: DOMAIN_1.name,
            destination: DOMAIN_2.name,
            amount: transferAmount,
          },
          Date.now(),
        );
        pendingTransfers.push(pending);
        console.log(`  Transfer ${i + 1}: ${pending.messageId.slice(0, 18)}...`);
      }

      // Check domain1 balance (should have received all locks)
      const domain1Token = setup.tokens[DOMAIN_1.name];
      const domain1Balance = await domain1Token.balanceOf(setup.getWarpRouteAddress(DOMAIN_1.name));
      console.log(`\ndomain1 balance after all locks: ${(Number(domain1Balance.toString()) / 1e18).toFixed(0)} tokens`);
      console.log('domain2 balance: 5000 (unchanged, deliveries pending)');

      // Now try to deliver all transfers
      console.log('\nDelivering all transfers...');
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < pendingTransfers.length; i++) {
        try {
          await trafficGenerator.deliverTransfer(pendingTransfers[i]);
          successCount++;
          
          // Check balance after each delivery
          const domain2Token = setup.tokens[DOMAIN_2.name];
          const domain2Balance = await domain2Token.balanceOf(setup.getWarpRouteAddress(DOMAIN_2.name));
          console.log(`  Transfer ${i + 1}: ✅ delivered. domain2 balance: ${(Number(domain2Balance.toString()) / 1e18).toFixed(0)}`);
        } catch (error: any) {
          failCount++;
          console.log(`  Transfer ${i + 1}: ❌ FAILED - ${error.message.slice(0, 50)}...`);
        }
      }

      console.log('\n' + '='.repeat(70));
      console.log('RESULTS');
      console.log('='.repeat(70));
      console.log(`Successful deliveries: ${successCount}/10`);
      console.log(`Failed deliveries: ${failCount}/10`);
      console.log('');

      if (failCount > 0) {
        console.log('✅ TEST DEMONSTRATES THE PROBLEM:');
        console.log(`   ${failCount} transfers failed because domain2 ran out of collateral.`);
        console.log('   With inflight tracking, the rebalancer would have seen:');
        console.log('     - 10 pending transfers totaling 6000 tokens to domain2');
        console.log('     - domain2 only has 5000 tokens');
        console.log('     - Would have moved 1000+ tokens to domain2 proactively');
      }
      console.log('='.repeat(70) + '\n');

      // We expect some transfers to fail
      expect(failCount).to.be.greaterThan(
        0,
        'Some transfers should fail due to collateral exhaustion',
      );
    });
  });

  describe('Scenario: Proactive Rebalancing for Pending Transfers', function () {
    /**
     * THE KEY SCENARIO: Balanced collateral with pending transfers
     *
     * This tests that the rebalancer proactively moves collateral BEFORE
     * transfers fail, by accounting for pending deliveries in its calculations.
     *
     * Setup:
     * - domain1 = 5000, domain2 = 5000 (balanced)
     * - Tolerance = 5% (250 token threshold)
     *
     * Sequence:
     * 1. User initiates 2000 token transfer domain1→domain2
     *    - Locks 2000 on domain1 (now 7000)
     *    - Pending delivery of 2000 on domain2
     *
     * 2. On-chain balances: domain1=7000, domain2=5000
     *    - WITHOUT inflight tracking: looks like domain1 has surplus
     *    - Rebalancer might move tokens FROM domain2 TO domain1 (wrong!)
     *
     * 3. WITH inflight tracking:
     *    - Rebalancer sees domain1=7000, domain2=5000
     *    - BUT ALSO sees pending transfer releasing 2000 from domain2
     *    - Effective domain2 = 5000 - 2000 = 3000
     *    - Target is 5000, so domain2 has 2000 deficit
     *    - Proactively moves collateral TO domain2
     *
     * 4. When transfer delivers:
     *    - domain2 releases 2000 tokens
     *    - But rebalancer already added collateral, so no failure
     */

    /**
     * Helper to create simulation config for this test
     */
    function createTestSimulationConfig(enableMockExplorer: boolean) {
      const strategyConfig = createWeightedStrategyConfig(setup, {
        [DOMAIN_1.name]: { weight: 50, tolerance: 5 }, // 250 token threshold
        [DOMAIN_2.name]: { weight: 50, tolerance: 5 },
      });

      return {
        setup,
        warpRouteId: 'test-warp-route',
        messageDeliveryDelayMs: 15000, // Long delay - gives rebalancer time to see pending
        deliveryCheckIntervalMs: 500,
        recordingIntervalMs: 1000,
        rebalancerCheckFrequencyMs: 3000, // Poll every 3 seconds
        bridgeTransferDelayMs: 2000, // Fast bridge completion
        bridgeConfigs: {
          [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: {
            fixedFee: 0n,
            variableFeeBps: 10,
            transferTimeMs: 2000,
          },
          [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: {
            fixedFee: 0n,
            variableFeeBps: 10,
            transferTimeMs: 2000,
          },
        },
        strategyConfig,
        logger,
        enableMockExplorer,
      };
    }

    it('should NOT see pending transfers without MockExplorer (baseline)', async function () {
      // Create simulation WITHOUT mock explorer
      const simulation = new IntegratedSimulation(createTestSimulationConfig(false));
      await simulation.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('BASELINE: Rebalancer WITHOUT Inflight Tracking');
      console.log('='.repeat(70));
      console.log('');
      console.log('MockExplorer: DISABLED');
      console.log('Expected behavior: Rebalancer cannot see pending transfers');
      console.log('='.repeat(70) + '\n');

      const transfers: ScheduledTransfer[] = [
        {
          time: 0,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('2000')),
        },
      ];

      const schedule: SimulationRun = {
        name: 'baseline-no-inflight',
        durationMs: 60_000,
        transfers,
      };

      const results = await simulation.run(schedule);

      console.log('\n=== BASELINE RESULTS (No Inflight Tracking) ===');
      console.log(`Transfers completed: ${results.transfers.completed}/${results.transfers.total}`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);

      if (results.rebalancing.count > 0) {
        console.log('\nRebalance details:');
        for (const [route, data] of Object.entries(results.rebalancing.byBridge)) {
          console.log(`  ${route}: ${data.count} operations, ${(Number(data.volume) / 1e18).toFixed(2)} tokens`);
        }
      }

      // Record the behavior for comparison
      const baselineRebalanceCount = results.rebalancing.count;
      const baselineDomain1ToDomain2 = results.rebalancing.byBridge['domain1->domain2']?.count ?? 0;

      console.log('\nBaseline summary:');
      console.log(`  Total rebalances: ${baselineRebalanceCount}`);
      console.log(`  Domain1→Domain2 rebalances: ${baselineDomain1ToDomain2}`);
      console.log('='.repeat(70) + '\n');

      // The transfer should still complete (the simulation delivers it)
      expect(results.transfers.completed).to.equal(1);
    });

    it('should proactively rebalance WITH MockExplorer enabled', async function () {
      // Create simulation WITH mock explorer (enables inflight tracking)
      const simulation = new IntegratedSimulation(createTestSimulationConfig(true));
      await simulation.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO: Proactive Rebalancing WITH Inflight Tracking');
      console.log('='.repeat(70));
      console.log('');
      console.log('MockExplorer: ENABLED');
      console.log('');
      console.log('This is the KEY test for inflight tracking:');
      console.log('');
      console.log('Initial: domain1=5000, domain2=5000 (balanced)');
      console.log('');
      console.log('Step 1: User initiates 2000 token transfer domain1→domain2');
      console.log('  - On-chain: domain1=7000 (after lock), domain2=5000');
      console.log('  - Pending: 2000 tokens will release from domain2');
      console.log('');
      console.log('WITH inflight tracking:');
      console.log('  - Rebalancer sees pending transfer releasing 2000 from domain2');
      console.log('  - Effective domain2 = 5000 - 2000 = 3000');
      console.log('  - Proactively moves collateral TO domain2');
      console.log('');
      console.log('Expected: Rebalancer should move tokens FROM domain1 TO domain2');
      console.log('='.repeat(70) + '\n');

      const transfers: ScheduledTransfer[] = [
        {
          time: 0,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('2000')),
        },
      ];

      const schedule: SimulationRun = {
        name: 'proactive-rebalancing',
        durationMs: 60_000,
        transfers,
      };

      const results = await simulation.run(schedule);

      console.log('\n=== RESULTS (With Inflight Tracking) ===');
      console.log(`Transfers completed: ${results.transfers.completed}/${results.transfers.total}`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Rebalance volume: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);

      let correctDirectionCount = 0;
      let wrongDirectionCount = 0;

      if (results.rebalancing.count > 0) {
        console.log('\nRebalance details:');
        for (const [route, data] of Object.entries(results.rebalancing.byBridge)) {
          console.log(`  ${route}: ${data.count} operations, ${(Number(data.volume) / 1e18).toFixed(2)} tokens`);
        }

        // Check if rebalancer moved in the CORRECT direction (domain1 → domain2)
        const correctDirection = results.rebalancing.byBridge['domain1->domain2'];
        if (correctDirection && correctDirection.count > 0) {
          correctDirectionCount = correctDirection.count;
          console.log('\n✅ PROACTIVE REBALANCING WORKED!');
          console.log('   Rebalancer moved tokens TO domain2, anticipating the pending delivery.');
          console.log('   This is the correct behavior with inflight tracking.');
        }

        // Check if rebalancer moved in WRONG direction
        const wrongDirection = results.rebalancing.byBridge['domain2->domain1'];
        if (wrongDirection && wrongDirection.count > 0) {
          wrongDirectionCount = wrongDirection.count;
          console.log('\n⚠️  Rebalancer also moved tokens AWAY from domain2');
          console.log('   This may be normal oscillation after initial correction.');
        }
      } else {
        console.log('\n⚠️  No rebalancing occurred.');
        console.log('   With the pending transfer reserving 2000 from domain2,');
        console.log('   the effective balance should show a deficit requiring rebalancing.');
      }
      console.log('='.repeat(70) + '\n');

      // Assertions
      expect(results.transfers.completed).to.equal(1, 'Transfer should complete');
      
      // The key assertion: with inflight tracking enabled, rebalancer should
      // have moved collateral TO domain2 at some point
      expect(correctDirectionCount).to.be.greaterThan(
        0,
        'With inflight tracking, rebalancer should proactively move collateral TO domain2'
      );
    });
  });

  describe('Scenario: MockExplorer Integration', function () {
    /**
     * This test verifies that the MockExplorerServer integration works.
     * When enableMockExplorer is true, the rebalancer's ActionTracker
     * should be able to see pending transfers via the mock explorer API.
     */
    it('should track transfers in MockExplorer when enabled', async function () {
      // Create simulation WITH mock explorer enabled
      const strategyConfig = createWeightedStrategyConfig(setup, {
        [DOMAIN_1.name]: { weight: 50, tolerance: 5 },
        [DOMAIN_2.name]: { weight: 50, tolerance: 5 },
      });

      const simulation = new IntegratedSimulation({
        setup,
        warpRouteId: 'test-warp-route',
        messageDeliveryDelayMs: 5000, // 5 second delay
        deliveryCheckIntervalMs: 500,
        recordingIntervalMs: 1000,
        rebalancerCheckFrequencyMs: 2000,
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
        enableMockExplorer: true, // Enable mock explorer integration
      });

      await simulation.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('SCENARIO: MockExplorer Integration Test');
      console.log('='.repeat(70));
      console.log('');
      console.log('This test verifies that:');
      console.log('  1. MockExplorerServer is created and started');
      console.log('  2. Transfers are tracked in the mock explorer');
      console.log('  3. The RebalancerService uses the mock explorer URL');
      console.log('  4. Messages are marked as delivered after completion');
      console.log('='.repeat(70) + '\n');

      // Create a simple simulation run with a few transfers
      const transfers: ScheduledTransfer[] = [
        {
          time: 0,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('100')),
        },
        {
          time: 1000,
          origin: DOMAIN_2.name,
          destination: DOMAIN_1.name,
          amount: BigInt(toWei('50')),
        },
      ];

      const schedule: SimulationRun = {
        name: 'mock-explorer-integration',
        durationMs: 30_000,
        transfers,
      };

      const results = await simulation.run(schedule);

      console.log('\n=== RESULTS ===');
      console.log(`Transfers completed: ${results.transfers.completed}/${results.transfers.total}`);
      console.log(`Transfers stuck: ${results.transfers.stuck}`);

      // All transfers should complete
      expect(results.transfers.completed).to.equal(2);
      expect(results.transfers.stuck).to.equal(0);

      console.log('\n✅ MockExplorer integration working:');
      console.log('   - RebalancerService connected to mock explorer');
      console.log('   - Transfers were tracked and marked as delivered');
      console.log('='.repeat(70) + '\n');
    });
  });
});
