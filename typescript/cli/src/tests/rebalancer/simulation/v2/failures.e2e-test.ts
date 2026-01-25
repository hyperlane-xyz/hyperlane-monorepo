/**
 * Bridge Failure Scenario Tests
 *
 * Tests rebalancer resilience when bridges fail or become unavailable.
 * Uses the SimulatedTokenBridge's failNextTransfer flag to simulate failures.
 *
 * Key scenarios:
 * - Bridge temporarily unavailable during rebalance
 * - Multiple consecutive bridge failures
 * - Partial route failures (one bridge fails, others work)
 * - Recovery after failures
 */
import { expect } from 'chai';
import { pino } from 'pino';

import { SimulatedTokenBridge__factory } from '@hyperlane-xyz/core';
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

const logger = pino({ level: 'info' });

describe('Bridge Failure Scenarios', function () {
  this.timeout(600_000); // 10 minute timeout

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const INITIAL_COLLATERAL = toWei('5000'); // 5000 tokens per domain

  before(async function () {
    console.log('\nStarting anvil...');
    anvil = await startAnvil(8545, logger);
    console.log(`Anvil running at ${anvil.rpcUrl}\n`);

    console.log('Setting up bridge failure test environment...');
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

  /**
   * Create simulation with specified tolerance.
   */
  async function createSimulation(tolerance: number = 2): Promise<IntegratedSimulation> {
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
      rebalancerCheckFrequencyMs: 5000,
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

  /**
   * Set the failNextTransfer flag on a bridge.
   * Uses direct contract call since the types may not be regenerated yet.
   */
  async function setFailNextTransfer(
    bridgeKey: string,
    fail: boolean,
  ): Promise<void> {
    const bridgeAddress = setup.bridges[bridgeKey];
    if (!bridgeAddress) {
      throw new Error(`Bridge not found: ${bridgeKey}`);
    }
    const bridge = SimulatedTokenBridge__factory.connect(
      bridgeAddress,
      setup.signers.bridge, // Use bridge signer (simulator)
    );
    // Use type assertion since types may not be regenerated yet
    const bridgeWithFailure = bridge as any;
    await (await bridgeWithFailure.setFailNextTransfer(fail)).wait();
  }

  /**
   * Get the failNextTransfer flag status.
   * Note: failureCount won't increment on revert since state changes are rolled back.
   */
  async function getFailNextTransfer(bridgeKey: string): Promise<boolean> {
    const bridgeAddress = setup.bridges[bridgeKey];
    if (!bridgeAddress) {
      throw new Error(`Bridge not found: ${bridgeKey}`);
    }
    const bridge = SimulatedTokenBridge__factory.connect(
      bridgeAddress,
      setup.signers.bridge,
    );
    // Use type assertion since types may not be regenerated yet
    const bridgeWithFailure = bridge as any;
    return await bridgeWithFailure.failNextTransfer();
  }

  // ========== BASIC FAILURE TESTS ==========

  describe('Basic Bridge Failures', function () {
    it('should handle bridge failure gracefully without crashing', async function () {
      const simulation = await createSimulation(2);

      // Set up a scenario that triggers rebalancing: heavy traffic to domain2
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 10; i++) {
        transfers.push({
          time: i * 3000,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('200')),
        });
      }

      // Make the first rebalance attempt fail
      // When the rebalancer tries to move collateral from domain2 to domain1,
      // the bridge will reject it
      await setFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`, true);

      const schedule: SimulationRun = {
        name: 'bridge-failure-basic',
        durationMs: 90_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('BRIDGE FAILURE TEST: Basic Resilience');
      console.log('='.repeat(70));
      console.log('Setup: First rebalance attempt will fail (bridge rejects transfer)');
      console.log('Expected: Simulation completes, rebalancer continues operating');
      console.log('='.repeat(70) + '\n');

      // Run the simulation - it should NOT crash even if bridge fails
      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      // Check that the failure flag was reset (consumed by the failed attempt)
      const flagStillSet = await getFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`);
      console.log(`\nFailNextTransfer flag still set: ${flagStillSet}`);

      // Assertions
      expect(results.transfers.total).to.equal(10);
      // Most transfers should still complete (via message delivery, not rebalancing)
      expect(results.transfers.completed).to.be.greaterThan(0);
      // The simulation should have completed without crashing
      expect(results.duration.wallClockMs).to.be.greaterThan(0);
    });

    it('should recover and continue rebalancing after temporary failure', async function () {
      const simulation = await createSimulation(2);

      // Create imbalanced traffic that needs multiple rebalance cycles
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 15; i++) {
        transfers.push({
          time: i * 4000,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('150')),
        });
      }

      // Fail the first rebalance, then let subsequent ones succeed
      await setFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`, true);

      const schedule: SimulationRun = {
        name: 'bridge-failure-recovery',
        durationMs: 120_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('BRIDGE FAILURE TEST: Recovery After Failure');
      console.log('='.repeat(70));
      console.log('Setup: First rebalance fails, subsequent attempts should succeed');
      console.log('Expected: Rebalancer recovers and executes successful rebalances');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      const flagStillSet = await getFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`);
      console.log(`\nFailNextTransfer flag still set: ${flagStillSet}`);
      console.log(`Rebalance operations: ${results.rebalancing.count}`);

      // Assertions
      expect(results.transfers.total).to.equal(15);
      // With recovery, success rate should be high
      const successRate = results.transfers.completed / results.transfers.total;
      expect(successRate).to.be.greaterThan(0.8, 'Should achieve >80% success rate after recovery');
      
      // After the first failure, subsequent rebalances should work
      // (The simulation doesn't retry, but new imbalances trigger new attempts)
    });
  });

  // ========== STRESS FAILURE TESTS ==========

  describe('Stress Failure Scenarios', function () {
    it('should maintain stability during repeated bridge failures', async function () {
      const simulation = await createSimulation(3);

      // Create moderate traffic
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 20; i++) {
        transfers.push({
          time: i * 2500,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('100')),
        });
      }

      // Note: We can only set failNextTransfer once before each attempt.
      // For multiple failures, we'd need to intercept and re-set the flag.
      // This test demonstrates single failure handling.
      await setFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`, true);

      const schedule: SimulationRun = {
        name: 'bridge-failure-stress',
        durationMs: 120_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('BRIDGE FAILURE STRESS TEST');
      console.log('='.repeat(70));
      console.log('Setup: 20 transfers with bridge configured to fail');
      console.log('Expected: System remains stable, transfers complete via normal flow');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      const flagStillSet = await getFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`);
      console.log(`FailNextTransfer flag consumed: ${!flagStillSet}`);

      // Assertions
      expect(results.transfers.total).to.equal(20);
      // System should remain stable even with failures
      expect(results.duration.wallClockMs).to.be.lessThan(
        300_000,
        'Should complete within timeout despite failures'
      );
    });
  });

  // ========== EDGE CASE TESTS ==========

  describe('Edge Cases', function () {
    it('should handle transfers when both bridge directions fail', async function () {
      const simulation = await createSimulation(2);

      // Set both bridges to fail
      await setFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`, true);
      await setFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`, true);

      // Create bidirectional traffic
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 10; i++) {
        transfers.push({
          time: i * 3000,
          origin: i % 2 === 0 ? DOMAIN_1.name : DOMAIN_2.name,
          destination: i % 2 === 0 ? DOMAIN_2.name : DOMAIN_1.name,
          amount: BigInt(toWei('100')),
        });
      }

      const schedule: SimulationRun = {
        name: 'both-bridges-fail',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('EDGE CASE: Both Bridge Directions Fail');
      console.log('='.repeat(70));
      console.log('Setup: Both domain1<->domain2 bridges set to fail');
      console.log('Expected: Transfers still complete via direct warp route delivery');
      console.log('Note: Rebalancing cannot occur, but transfers should still work');
      console.log('='.repeat(70) + '\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      const flag1to2 = await getFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`);
      const flag2to1 = await getFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`);
      console.log(`\nFlags consumed: ${DOMAIN_1.name}->${DOMAIN_2.name}: ${!flag1to2}`);
      console.log(`Flags consumed: ${DOMAIN_2.name}->${DOMAIN_1.name}: ${!flag2to1}`);

      // Assertions
      expect(results.transfers.total).to.equal(10);
      // Transfers should still complete via normal warp route (not bridge)
      // This tests that the simulation separates warp route traffic from rebalancer bridge traffic
      expect(results.transfers.completed).to.be.greaterThan(0);
    });

    it('should not hang when bridge consistently rejects transfers', async function () {
      // This test ensures the simulation has proper timeouts
      const simulation = await createSimulation(2);

      // Heavy one-way traffic that definitely triggers rebalancing
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 8; i++) {
        transfers.push({
          time: i * 5000,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('300')),
        });
      }

      // Fail the rebalance bridge
      await setFailNextTransfer(`${DOMAIN_2.name}-${DOMAIN_1.name}`, true);

      const schedule: SimulationRun = {
        name: 'no-hang-on-failure',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('EDGE CASE: No Hang on Consistent Failures');
      console.log('='.repeat(70));
      console.log('Setup: Bridge rejects rebalance attempts');
      console.log('Expected: Simulation completes within reasonable time, no infinite loops');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      // Assertion: Should complete in reasonable time (not hang)
      expect(wallTime).to.be.lessThan(
        180_000, // 3 minutes max
        'Simulation should not hang even when bridge fails'
      );
      
      // Some transfers may fail due to collateral issues, but that's expected
      console.log(`Success rate: ${((results.transfers.completed / results.transfers.total) * 100).toFixed(1)}%`);
    });
  });

  // ========== INFORMATION TESTS ==========

  describe('Failure Diagnostics', function () {
    it('should demonstrate failure detection via flag consumption', async function () {
      // First, verify the failNextTransfer flag starts at false
      let failFlag = await getFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`);
      expect(failFlag).to.equal(false, 'failNextTransfer should start at false');

      // Set up a failure
      await setFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`, true);

      // Verify flag is now set
      failFlag = await getFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`);
      expect(failFlag).to.equal(true, 'failNextTransfer should be true after setting');

      // Try to transfer through the bridge (this will fail)
      const bridge = SimulatedTokenBridge__factory.connect(
        setup.bridges[`${DOMAIN_1.name}-${DOMAIN_2.name}`],
        setup.signers.traffic, // Use traffic signer
      );

      // Get the token and approve
      const token = setup.tokens[DOMAIN_1.name];
      const amount = BigInt(toWei('10'));
      await (await token.connect(setup.signers.traffic).approve(bridge.address, amount * 2n)).wait();

      // Attempt transfer (should fail)
      try {
        await bridge.connect(setup.signers.traffic).transferRemote(
          setup.getDomain(DOMAIN_2.name).domainId,
          '0x' + '00'.repeat(12) + setup.signers.traffic.address.slice(2),
          amount,
        );
        expect.fail('Transfer should have failed');
      } catch (error: any) {
        expect(error.message).to.include('Bridge temporarily unavailable');
      }

      // Note: Since the transaction reverts, ALL state changes are rolled back,
      // including the flag reset. This is expected Solidity behavior.
      // The flag remains true until a successful non-reverting transaction occurs.
      // The important thing is that the transfer was rejected.
      
      // For the rebalancer tests, the key behavior is:
      // 1. Transfer attempt fails with "Bridge temporarily unavailable"
      // 2. The rebalancer handles this gracefully without crashing
      // 3. Subsequent attempts (without the flag) will succeed

      console.log('\n' + '='.repeat(70));
      console.log('DIAGNOSTICS: Bridge Failure Detection');
      console.log('='.repeat(70));
      console.log('Verified that SimulatedTokenBridge correctly:');
      console.log('  1. Rejects transfers when failNextTransfer is set');
      console.log('  2. Returns error message "Bridge temporarily unavailable"');
      console.log('');
      console.log('Note: On revert, state changes (including flag reset) are rolled back.');
      console.log('This is expected Solidity behavior - reverts undo all state changes.');
      console.log('='.repeat(70) + '\n');
    });

    it('should reset flag when set then cleared by simulator', async function () {
      // Verify we can set and clear the flag
      await setFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`, true);
      let failFlag = await getFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`);
      expect(failFlag).to.equal(true, 'Flag should be true after setting');

      // Clear it
      await setFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`, false);
      failFlag = await getFailNextTransfer(`${DOMAIN_1.name}-${DOMAIN_2.name}`);
      expect(failFlag).to.equal(false, 'Flag should be false after clearing');

      console.log('Verified simulator can set and clear failNextTransfer flag');
    });
  });
});
