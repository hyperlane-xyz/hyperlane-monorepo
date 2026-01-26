/**
 * Inflight Tracking E2E Tests
 *
 * These tests demonstrate the STUCK TRANSFER problem that inflight tracking solves.
 *
 * THE PROBLEM:
 * ============
 * The rebalancer uses weight/tolerance-based strategy to decide when to rebalance.
 * It only looks at ON-CHAIN balances. If balances look "balanced enough", it does nothing.
 *
 * But a pending transfer might need MORE collateral than exists at the destination!
 * Without seeing the pending transfer, the rebalancer doesn't know to move collateral.
 * The transfer gets STUCK FOREVER.
 *
 * EXAMPLE - THE STUCK SCENARIO:
 * =============================
 * Initial state:
 *   - domain1: 1000 tokens
 *   - domain2: 5000 tokens
 *   - Total: 6000, Target 50/50 = 3000 each
 *
 * User initiates transfer of 5100 tokens from domain1 → domain2:
 *   - domain1 locks 5100: now has 1000 + 5100 = 6100 tokens
 *   - domain2 unchanged: still has 5000 tokens
 *   - Total: 11100, Target 50/50 = 5550 each
 *
 * Rebalancer sees (WITHOUT inflight tracking):
 *   - domain1: 6100 (550 over target)
 *   - domain2: 5000 (550 under target)
 *   - Deviation: ~10% - might be within tolerance
 *   - Rebalancer does NOTHING or moves only a small amount
 *
 * Reality:
 *   - Message needs to RELEASE 5100 tokens from domain2
 *   - domain2 only has 5000 tokens
 *   - TRANSFER IS STUCK FOREVER - can never deliver!
 *
 * WITH inflight tracking:
 *   - Rebalancer sees pending 5100 token delivery to domain2
 *   - Knows domain2 needs at least 5100, only has 5000
 *   - Moves 100+ tokens to domain2 proactively
 *   - Transfer succeeds!
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
import { OptimizedTrafficGenerator } from './OptimizedTrafficGenerator.js';
import { visualizeSimulation } from './SimulationVisualizer.js';
import type { SimulationRun, ScheduledTransfer } from './types.js';

// Logger for tests
const logger = pino({ level: 'info' });

describe('Inflight Tracking - Success Rate Impact', function () {
  this.timeout(600_000); // 10 minute timeout

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const INITIAL_COLLATERAL = toWei('5000'); // 5000 tokens per domain

  before(async function () {
    console.log('\nStarting anvil for inflight tracking tests...');
    anvil = await startAnvil(8545, logger);

    setup = await createRebalancerTestSetup({
      collateralDomains: COLLATERAL_DOMAINS,
      syntheticDomains: [],
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

  describe('Scenario: Pending Transfers Cause Collateral Exhaustion', function () {
    /**
     * This test DEMONSTRATES THE PROBLEM that inflight tracking solves.
     * 
     * NO REBALANCER - just showing that pending transfers can exhaust collateral.
     * 
     * Setup: 5000 tokens on domain2
     * 
     * We initiate transfers that will release MORE than 5000 from domain2:
     * - 10 transfers of 600 tokens each = 6000 total
     * - But domain2 only has 5000!
     * 
     * Result: Later transfers FAIL when domain2 runs out of collateral.
     */
    it('should demonstrate how pending transfers exhaust collateral (no rebalancer)', async function () {
      const trafficGenerator = new OptimizedTrafficGenerator(
        setup,
        30000, // 30 second delivery delay - doesn't matter, we control delivery
      );
      await trafficGenerator.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('DEMONSTRATION: Pending Transfers Exhaust Collateral');
      console.log('='.repeat(70));
      console.log('');
      console.log('This test shows the PROBLEM that inflight tracking solves.');
      console.log('NO REBALANCER is running - we just show raw behavior.');
      console.log('');
      console.log('Setup:');
      console.log('  - domain1: 5000 tokens');
      console.log('  - domain2: 5000 tokens');
      console.log('');
      console.log('Action: Initiate 10 transfers of 600 tokens (domain1 → domain2)');
      console.log('  - Total to release from domain2: 6000 tokens');
      console.log('  - domain2 only has: 5000 tokens');
      console.log('');
      console.log('Expected: First ~8 transfers succeed, last ~2 FAIL');
      console.log('='.repeat(70) + '\n');

      // Initiate 10 transfers (don't deliver yet)
      const pendingTransfers = [];
      const transferAmount = BigInt(toWei('600'));

      console.log('Initiating 10 transfers of 600 tokens each...');
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
      }
      console.log('All 10 transfers initiated (pending delivery)\n');

      // Check balances
      const domain1Token = setup.tokens[DOMAIN_1.name];
      const domain2Token = setup.tokens[DOMAIN_2.name];
      const domain1Balance = await domain1Token.balanceOf(setup.getWarpRouteAddress(DOMAIN_1.name));
      const domain2Balance = await domain2Token.balanceOf(setup.getWarpRouteAddress(DOMAIN_2.name));
      
      console.log('Balances after initiating transfers:');
      console.log(`  domain1: ${(Number(domain1Balance.toString()) / 1e18).toFixed(0)} tokens (received locks)`);
      console.log(`  domain2: ${(Number(domain2Balance.toString()) / 1e18).toFixed(0)} tokens (unchanged - deliveries pending)`);
      console.log('');

      // Now deliver all transfers and count successes/failures
      console.log('Delivering all transfers...\n');
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < pendingTransfers.length; i++) {
        const balanceBefore = await domain2Token.balanceOf(setup.getWarpRouteAddress(DOMAIN_2.name));
        
        try {
          await trafficGenerator.deliverTransfer(pendingTransfers[i]);
          successCount++;
          const balanceAfter = await domain2Token.balanceOf(setup.getWarpRouteAddress(DOMAIN_2.name));
          console.log(`  Transfer ${i + 1}: ✅ SUCCESS - domain2: ${(Number(balanceBefore.toString()) / 1e18).toFixed(0)} → ${(Number(balanceAfter.toString()) / 1e18).toFixed(0)}`);
        } catch (error: any) {
          failCount++;
          console.log(`  Transfer ${i + 1}: ❌ FAILED  - domain2: ${(Number(balanceBefore.toString()) / 1e18).toFixed(0)} (insufficient collateral)`);
        }
      }

      // Final results
      console.log('\n' + '='.repeat(70));
      console.log('RESULTS');
      console.log('='.repeat(70));
      console.log(`Successful: ${successCount}/10`);
      console.log(`Failed: ${failCount}/10`);
      console.log('');
      console.log('This demonstrates the problem:');
      console.log('  - Transfers were initiated when collateral looked sufficient');
      console.log('  - But the PENDING deliveries exhausted collateral');
      console.log('  - Later transfers failed');
      console.log('');
      console.log('With inflight tracking, a rebalancer would:');
      console.log('  - See 6000 tokens worth of pending deliveries to domain2');
      console.log('  - Know domain2 only has 5000 tokens');
      console.log('  - Proactively move 1000+ tokens FROM domain1 TO domain2');
      console.log('  - All transfers would succeed');
      console.log('='.repeat(70) + '\n');

      // Assert that some transfers failed
      expect(failCount).to.be.greaterThan(0, 'Some transfers should fail due to collateral exhaustion');
      expect(successCount).to.be.lessThan(10, 'Not all transfers should succeed');
    });
  });

  /**
   * TRUE STUCK SCENARIO WITH HIGH TOLERANCE
   * 
   * This is the definitive test that shows when inflight tracking is ESSENTIAL.
   * 
   * We set up:
   *   - domain1: 5000 tokens
   *   - domain2: 5000 tokens
   *   - Rebalancer tolerance: 50% (very high!)
   * 
   * Then initiate a transfer of 5100 tokens from domain2 → domain1:
   *   - domain2 LOCKS 5100: now has 5000 + 5100 = 10100 tokens
   *   - domain1 unchanged: still has 5000 tokens (pending delivery)
   *   - Total = 15100, target = 7550 each
   *   - domain1 deviation: 5000 - 7550 = -2550 (33.8% under target)
   *   - domain2 deviation: 10100 - 7550 = +2550 (33.8% over target)
   *   
   * With 50% tolerance: 33.8% < 50% → REBALANCER DOES NOT TRIGGER!
   * But message needs to release 5100 from domain1's 5000 → STUCK FOREVER
   * 
   * With inflight tracking, rebalancer sees the pending 5100 delivery to domain1
   * and proactively moves collateral.
   */
  describe('Scenario: TRUE STUCK - Asymmetric Collateral', function () {
    // Need separate setup for asymmetric collateral
    let asymmetricSetup: RebalancerTestSetup;
    let asymmetricSnapshot: SnapshotInfo;

    before(async function () {
      // Create a new setup with SLIGHTLY asymmetric collateral
      // Key: Initial state must be within 20% tolerance so rebalancer doesn't trigger at startup
      // 
      // Initial: domain1=4500, domain2=5500, total=10000
      // Target: 5000 each (50/50 weight)
      // domain1 deviation: 4500 - 5000 = -500 (10% under target) → within 20% tolerance
      // domain2 deviation: 5500 - 5000 = +500 (10% over target) → within 20% tolerance
      //
      // Transfer: 4600 tokens from domain2 → domain1
      // After lock: domain1=4500, domain2=5500+4600=10100, total=14600
      // Target: 7300 each
      // domain1 deviation: 4500 - 7300 = -2800 (38.4% under) → EXCEEDS tolerance
      //
      // Hmm, that exceeds tolerance. We need a transfer where:
      // 1. Transfer amount > domain1's collateral (so it would be stuck)
      // 2. But the deviation after lock is still within tolerance
      //
      // NEW APPROACH: Use symmetric initial state, but high tolerance (50%)
      // Initial: domain1=5000, domain2=5000
      // Transfer: 5100 from domain2 → domain1
      // After lock: domain1=5000, domain2=10100, total=15100
      // Target: 7550 each
      // domain1 deviation: 5000 - 7550 = -2550 (33.8% under) → within 50% tolerance!
      // domain2 deviation: 10100 - 7550 = +2550 (33.8% over) → within 50% tolerance!
      //
      // But domain1 only has 5000, needs to release 5100 → STUCK!
      
      asymmetricSetup = await createRebalancerTestSetup({
        collateralDomains: [DOMAIN_1, DOMAIN_2],
        syntheticDomains: [],
        initialCollateral: BigInt(toWei('5000')),  // 5000/5000 symmetric
        logger,
        simulatedBridge: {
          fixedFee: 0n,
          variableFeeBps: 10,
        },
      });

      asymmetricSnapshot = await asymmetricSetup.createSnapshot();
      console.log('Setup ready (5000/5000 tokens, 50% tolerance)\n');
    });

    afterEach(async function () {
      await asymmetricSetup.restoreSnapshot(asymmetricSnapshot);
      asymmetricSnapshot = await asymmetricSetup.createSnapshot();
    });

    function createAsymmetricSimulationConfig(enableMockExplorer: boolean) {
      const strategyConfig = createWeightedStrategyConfig(asymmetricSetup, {
        // VERY HIGH tolerance (50%) - rebalancer only triggers on huge imbalances
        // This allows a 5100 token transfer to NOT trigger rebalancing
        // even though the destination only has 5000 tokens
        [DOMAIN_1.name]: { weight: 50, tolerance: 50 },
        [DOMAIN_2.name]: { weight: 50, tolerance: 50 },
      });

      return {
        setup: asymmetricSetup,
        warpRouteId: 'test-warp-route',
        messageDeliveryDelayMs: 10000, // 10 second delivery delay - gives rebalancer time
        deliveryCheckIntervalMs: 300,
        recordingIntervalMs: 500,
        rebalancerCheckFrequencyMs: 1500, // Poll every 1.5 seconds
        bridgeTransferDelayMs: 3000, // 3 second bridge transfer
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
        enableMockExplorer,
      };
    }

    it('WITHOUT inflight tracking - transfer STUCK forever (deviation within tolerance)', async function () {
      const simulation = new IntegratedSimulation(createAsymmetricSimulationConfig(false));
      await simulation.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('TEST: TRUE STUCK SCENARIO - High Tolerance Hides Problem');
      console.log('='.repeat(70));
      console.log('');
      console.log('Initial State:');
      console.log('  domain1: 5,000 tokens ← destination');
      console.log('  domain2: 5,000 tokens ← origin');
      console.log('  Rebalancer tolerance: 50% (very high!)');
      console.log('');
      console.log('Transfer: 5,100 tokens from domain2 → domain1');
      console.log('');
      console.log('After transfer LOCK on domain2:');
      console.log('  domain1: 5,000 tokens (unchanged - delivery pending)');
      console.log('  domain2: 5,000 + 5,100 = 10,100 tokens');
      console.log('  Total: 15,100 | Target: 7,550 each');
      console.log('');
      console.log('Deviation analysis:');
      console.log('  domain1: 5,000 - 7,550 = -2,550 (33.8% UNDER target)');
      console.log('  domain2: 10,100 - 7,550 = +2,550 (33.8% OVER target)');
      console.log('  Max deviation: 33.8% < 50% tolerance');
      console.log('  → REBALANCER DOES NOT TRIGGER!');
      console.log('');
      console.log('But when message delivers:');
      console.log('  domain1 must RELEASE 5,100 tokens');
      console.log('  domain1 only HAS 5,000 tokens');
      console.log('  → TRANSFER STUCK FOREVER');
      console.log('='.repeat(70) + '\n');

      // Transfer 5100 from domain2 to domain1
      // domain1 only has 5000, so it can't release 5100
      const transfers: ScheduledTransfer[] = [
        {
          time: 0,
          origin: DOMAIN_2.name,  // FROM domain2 (has 5000)
          destination: DOMAIN_1.name,  // TO domain1 (only has 5000)
          amount: BigInt(toWei('5100')), // 5100 tokens - more than domain1 has!
        },
      ];

      const schedule: SimulationRun = {
        name: 'stuck-high-tolerance',
        durationMs: 20_000, // 20 seconds
        transfers,
      };

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      console.log('\n=== RESULTS (Asymmetric, No Inflight Tracking) ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`STUCK: ${results.transfers.stuck}`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      
      if (results.transfers.stuck > 0) {
        console.log('\n✓ CONFIRMED: Transfer is STUCK!');
        console.log('  The rebalancer did not trigger because deviation (9.9%)');
        console.log('  was within tolerance (20%).');
        console.log('  The transfer cannot deliver because domain2 has');
        console.log('  insufficient collateral (5,000 < 5,100 needed).');
      }
      console.log('='.repeat(70) + '\n');

      // Without inflight tracking, the transfer should be STUCK
      expect(results.transfers.stuck).to.equal(
        1,
        'Transfer should be STUCK without inflight tracking'
      );
      expect(results.transfers.completed).to.equal(
        0,
        'Transfer should NOT complete without inflight tracking'
      );
    });

    it('WITH inflight tracking - rebalancer sees pending delivery and acts', async function () {
      const simulation = new IntegratedSimulation(createAsymmetricSimulationConfig(true));
      await simulation.initialize();

      console.log('\n' + '='.repeat(70));
      console.log('TEST: INFLIGHT TRACKING SAVES THE DAY');
      console.log('='.repeat(70));
      console.log('');
      console.log('Same scenario: 5,100 token transfer to domain1 (only has 5,000)');
      console.log('');
      console.log('WITH inflight tracking:');
      console.log('  - Rebalancer sees pending 5,100 token delivery to domain1');
      console.log('  - Calculates: domain1 has 5,000, needs 5,100 → shortfall of 100');
      console.log('  - IGNORES tolerance because there is a real shortfall');
      console.log('  - Moves 100+ tokens from domain2 to domain1 via bridge');
      console.log('  - When message delivers, domain1 has enough collateral');
      console.log('  - Transfer succeeds!');
      console.log('='.repeat(70) + '\n');

      const transfers: ScheduledTransfer[] = [
        {
          time: 0,
          origin: DOMAIN_2.name,  // FROM domain2 (has 5000)
          destination: DOMAIN_1.name,  // TO domain1 (only has 5000)
          amount: BigInt(toWei('5100')),
        },
      ];

      const schedule: SimulationRun = {
        name: 'with-inflight-tracking-asymmetric',
        durationMs: 60_000, // 60 seconds - needs time for bridge transfer
        transfers,
      };

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      console.log('\n=== RESULTS (Asymmetric, WITH Inflight Tracking) ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`STUCK: ${results.transfers.stuck}`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      
      if (results.transfers.completed > 0) {
        console.log('\n✓ SUCCESS: Transfer completed!');
        console.log('  The rebalancer SAW the pending delivery via inflight tracking');
        console.log('  and proactively moved collateral to domain2.');
      }
      console.log('='.repeat(70) + '\n');

      // With inflight tracking, we expect the transfer to succeed
      expect(results.transfers.completed).to.equal(
        1,
        'Transfer should complete WITH inflight tracking'
      );
      expect(results.transfers.stuck).to.equal(
        0,
        'Transfer should NOT be stuck WITH inflight tracking'
      );
    });
  });
});
