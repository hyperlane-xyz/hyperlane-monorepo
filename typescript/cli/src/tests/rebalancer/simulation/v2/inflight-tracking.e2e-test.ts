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
});
