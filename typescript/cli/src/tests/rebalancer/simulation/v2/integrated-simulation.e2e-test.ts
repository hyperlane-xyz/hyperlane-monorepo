/**
 * Integrated Simulation E2E Tests
 *
 * Tests the IntegratedSimulation with the real RebalancerService.
 * This is the most comprehensive test - the rebalancer doesn't know
 * it's being simulated and executes real bridge transfers.
 *
 * NOTE: This test automatically starts anvil if not running.
 */
import { expect } from 'chai';
import { pino } from 'pino';

import { sleep, toWei } from '@hyperlane-xyz/utils';

import {
  type AnvilInstance,
  DOMAIN_1,
  DOMAIN_2,
  DOMAIN_3,
  DOMAIN_4,
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
import { generateTraffic } from './TrafficPatterns.js';
import { visualizeSimulation } from './SimulationVisualizer.js';
import type { SimulationRun, ScheduledTransfer, TransferMetric } from './types.js';

// Logger for tests
const logger = pino({ level: 'info' });

describe('Integrated Simulation (Real RebalancerService)', function () {
  this.timeout(600_000); // 10 minute timeout

  let anvil: AnvilInstance;
  let setup: RebalancerTestSetup;
  let baseSnapshot: SnapshotInfo;

  const COLLATERAL_DOMAINS = [DOMAIN_1, DOMAIN_2];
  const SYNTHETIC_DOMAINS = [DOMAIN_3];
  const INITIAL_COLLATERAL = toWei('5000'); // 5000 tokens per domain

  before(async function () {
    // Start anvil (or reuse if already running)
    console.log('\nStarting anvil...');
    anvil = await startAnvil(8545, logger);
    console.log(`Anvil running at ${anvil.rpcUrl}\n`);

    console.log('Setting up integrated simulation environment...');
    console.log('This deploys contracts and configures rebalancer permissions.\n');

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
    // Stop anvil if we started it
    if (anvil) {
      await anvil.stop();
    }
  });

  afterEach(async function () {
    await setup.restoreSnapshot(baseSnapshot);
    baseSnapshot = await setup.createSnapshot();
  });

  /**
   * Create and initialize an IntegratedSimulation.
   * @param tolerance - Tolerance percentage (default 2% to trigger rebalancing more easily)
   */
  async function createSimulation(tolerance: number = 2): Promise<IntegratedSimulation> {
    // Create weighted strategy config from setup
    // Using low tolerance to ensure rebalancing triggers on small imbalances
    const strategyConfig = createWeightedStrategyConfig(setup, {
      [DOMAIN_1.name]: { weight: 50, tolerance },
      [DOMAIN_2.name]: { weight: 50, tolerance },
    });

    const simulation = new IntegratedSimulation({
      setup,
      warpRouteId: 'test-warp-route',
      messageDeliveryDelayMs: 2000, // 2 second message delivery
      deliveryCheckIntervalMs: 500, // Check every 500ms
      recordingIntervalMs: 1000, // Record every second
      rebalancerCheckFrequencyMs: 5000, // Rebalancer polls every 5 seconds
      bridgeTransferDelayMs: 3000, // Bridge completes in 3 seconds
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

  // ========== SMOKE TEST ==========

  describe('Smoke Test', function () {
    it('should handle basic transfers with real rebalancer service', async function () {
      const simulation = await createSimulation();

      const schedule: SimulationRun = {
        name: 'integrated-smoke-test',
        durationMs: 60_000,
        transfers: [
          {
            time: 0,
            origin: DOMAIN_1.name,
            destination: DOMAIN_2.name,
            amount: BigInt(toWei('10')),
          },
          {
            time: 10_000,
            origin: DOMAIN_1.name,
            destination: DOMAIN_2.name,
            amount: BigInt(toWei('15')),
          },
          {
            time: 20_000,
            origin: DOMAIN_1.name,
            destination: DOMAIN_2.name,
            amount: BigInt(toWei('20')),
          },
        ],
      };

      console.log(`\nRunning integrated smoke test with ${schedule.transfers.length} transfers...`);
      console.log('All transfers go domain1 → domain2 to create imbalance\n');

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      expect(results.transfers.total).to.equal(3);
      expect(results.transfers.completed).to.equal(3);
      expect(results.transfers.stuck).to.equal(0);
    });
  });

  // ========== IMBALANCED TRAFFIC TEST ==========

  describe('Imbalanced Traffic', function () {
    it('should trigger rebalancing with heavily imbalanced traffic', async function () {
      // Use 2% tolerance so rebalancing triggers more easily
      const simulation = await createSimulation(2);

      // Create 10 large transfers all going from domain1 to domain2
      // Each transfer is 200 tokens, totaling 2000 tokens imbalance
      // With 5000 token targets and 2% tolerance (100 token threshold),
      // this should definitely trigger rebalancing
      const transfers: ScheduledTransfer[] = [];
      for (let i = 0; i < 10; i++) {
        transfers.push({
          time: i * 6_000, // Every 6 seconds simulated (slower to allow rebalancer to observe)
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('200')), // 200 tokens each
        });
      }

      const schedule: SimulationRun = {
        name: 'imbalanced-10-transfers',
        durationMs: 2 * 60_000, // 2 minutes simulated
        transfers,
      };

      console.log(`\nRunning imbalanced traffic test with ${schedule.transfers.length} transfers...`);
      console.log('Each transfer: 200 tokens domain1 → domain2');
      console.log('Strategy tolerance: 2% (100 token threshold on 5000 target)\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      console.log(`\nWall clock time: ${(wallTime / 1000).toFixed(1)}s`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Total volume rebalanced: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);

      expect(results.transfers.total).to.equal(10);
      expect(results.transfers.completed).to.equal(10);
      
      // The rebalancer should have executed at least one rebalance
      console.log(`\nRebalancer activity: ${results.rebalancing.count > 0 ? 'YES' : 'NO'}`);
      
      // With 2% tolerance and 2000 token imbalance on 5000 target,
      // rebalancer should definitely trigger
      expect(results.rebalancing.count).to.be.greaterThan(0, 
        'Rebalancer should have triggered with 2000 token imbalance (40% deviation) and 2% tolerance');
    });
  });

  // ========== MODERATE SCALE TEST ==========

  describe('Moderate Scale', function () {
    it('should handle 30 transfers with real rebalancer', async function () {
      const simulation = await createSimulation();

      // Generate 30 imbalanced transfers
      const transfers = generateTraffic('imbalanced', {
        durationMs: 10 * 60_000,
        chains: [DOMAIN_1.name, DOMAIN_2.name],
        collateralChains: [DOMAIN_1.name, DOMAIN_2.name],
        syntheticChains: [],
        baseAmount: BigInt(toWei('30')),
        seed: 12345,
      }).slice(0, 30);

      const schedule: SimulationRun = {
        name: 'integrated-30-transfers',
        durationMs: 10 * 60_000,
        transfers,
      };

      console.log(`\nRunning moderate scale test with ${schedule.transfers.length} transfers...`);

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));
      
      console.log('\n=== INTEGRATED SIMULATION SUMMARY ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Rebalances: ${results.rebalancing.count}`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);
      console.log(`Throughput: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)} transfers/second`);

      expect(results.transfers.total).to.equal(30);
      expect(results.transfers.completed).to.equal(30);
    });
  });

  // ========== COMPARISON TEST ==========

  describe('Comparison Test (With vs Without Rebalancer)', function () {
    /**
     * Transfer execution result with latency and success tracking.
     */
    interface TransferResult {
      messageId: string;
      origin: string;
      destination: string;
      amount: bigint;
      initiatedAt: number;
      completedAt: number;
      latencyMs: number;
      success: boolean;
      failureReason?: string;
      retryCount: number;
    }

    /**
     * Run traffic without the rebalancer - just transfers + message delivery.
     * Tracks transfer success and latency.
     */
    async function runWithoutRebalancer(
      transfers: ScheduledTransfer[],
      maxRetries: number = 10,
      retryDelayMs: number = 500,
    ): Promise<{
      results: TransferResult[];
      successCount: number;
      failureCount: number;
      avgLatencyMs: number;
      p95LatencyMs: number;
      maxLatencyMs: number;
    }> {
      const trafficGenerator = new OptimizedTrafficGenerator(
        setup,
        2000, // message delay
      );
      await trafficGenerator.initialize();

      const results: TransferResult[] = [];

      // Execute all transfers and try to deliver them
      for (const transfer of transfers) {
        const startTime = Date.now();
        const pending = await trafficGenerator.executeTransfer(transfer, startTime);
        
        // Try to deliver with retries
        let success = false;
        let failureReason: string | undefined;
        let retryCount = 0;
        let completedAt = 0;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            // Wait minimum message delay before first attempt
            if (attempt === 0) {
              await sleep(100);
            }
            
            await trafficGenerator.deliverTransfer(pending);
            success = true;
            completedAt = Date.now();
            break;
          } catch (error: any) {
            retryCount = attempt;
            failureReason = error.message || String(error);
            
            // Check if it's a collateral issue (ERC20 transfer failed)
            if (failureReason.includes('ERC20') || 
                failureReason.includes('transfer amount exceeds balance') ||
                failureReason.includes('insufficient')) {
              // Wait and retry - maybe rebalancer will add collateral (but it won't in this test)
              await sleep(retryDelayMs);
            } else {
              // Other error - don't retry
              break;
            }
          }
        }

        if (!success) {
          completedAt = Date.now(); // Mark failure time
        }

        results.push({
          messageId: pending.messageId,
          origin: transfer.origin,
          destination: transfer.destination,
          amount: transfer.amount,
          initiatedAt: startTime,
          completedAt,
          latencyMs: completedAt - startTime,
          success,
          failureReason: success ? undefined : failureReason,
          retryCount,
        });
      }

      // Calculate stats
      const successResults = results.filter(r => r.success);
      const successCount = successResults.length;
      const failureCount = results.length - successCount;
      
      const latencies = successResults.map(r => r.latencyMs).sort((a, b) => a - b);
      const avgLatencyMs = latencies.length > 0 
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
        : 0;
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95LatencyMs = latencies[p95Index] || 0;
      const maxLatencyMs = latencies[latencies.length - 1] || 0;

      return { results, successCount, failureCount, avgLatencyMs, p95LatencyMs, maxLatencyMs };
    }

    /**
     * Run traffic WITH the rebalancer active.
     * Uses the full IntegratedSimulation which tracks transfer metrics.
     */
    async function runWithRebalancer(
      transfers: ScheduledTransfer[],
      durationMs: number,
    ): Promise<{
      results: TransferMetric[];
      successCount: number;
      failureCount: number;
      avgLatencyMs: number;
      p95LatencyMs: number;
      maxLatencyMs: number;
      rebalanceCount: number;
      rebalanceVolume: bigint;
    }> {
      const simulation = await createSimulation(2); // 2% tolerance

      const schedule: SimulationRun = {
        name: 'comparison-with-rebalancer',
        durationMs,
        transfers,
      };

      const results = await simulation.run(schedule);

      // Extract transfer metrics
      const transferResults = results.transferMetrics;
      const successResults = transferResults.filter(t => t.completedAt >= 0);
      const successCount = successResults.length;
      const failureCount = transferResults.length - successCount;
      
      const latencies = successResults.map(t => t.latencyMs).sort((a, b) => a - b);
      const avgLatencyMs = latencies.length > 0 
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
        : 0;
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95LatencyMs = latencies[p95Index] || 0;
      const maxLatencyMs = latencies[latencies.length - 1] || 0;

      return {
        results: transferResults,
        successCount,
        failureCount,
        avgLatencyMs,
        p95LatencyMs,
        maxLatencyMs,
        rebalanceCount: results.rebalancing.count,
        rebalanceVolume: results.rebalancing.totalVolume,
      };
    }

    it('should demonstrate rebalancer improves transfer success rate and latency', async function () {
      // Understanding HypERC20Collateral flow:
      // - transferRemote() on ORIGIN: locks collateral from sender INTO the warp route
      // - Message delivery on DESTINATION: releases collateral FROM warp route to recipient
      //
      // So to DRAIN domain2's collateral, we need transfers TO domain2 (which release its collateral)
      // Then subsequent transfers TO domain2 will fail (no collateral to release)
      //
      // Pattern: 
      // Phase 1: Transfers FROM domain1 TO domain2 (releases domain2's collateral)
      // Phase 2: More transfers FROM domain1 TO domain2 (should fail without rebalancer)
      const transfers: ScheduledTransfer[] = [];
      
      // Phase 1: 20 transfers FROM domain1 TO domain2 (drains domain2's collateral)
      // When delivered on domain2, each releases 200 tokens from domain2's collateral
      // 20 × 200 = 4000 tokens released, leaving domain2 with 1000 tokens
      for (let i = 0; i < 20; i++) {
        transfers.push({
          time: i * 1_000,
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('200')),
        });
      }
      
      // Phase 2: 10 more transfers FROM domain1 TO domain2
      // Each needs domain2 to release 300 tokens, but domain2 only has 1000 left
      // First 3 will succeed (900 tokens), rest will fail without rebalancer
      for (let i = 0; i < 10; i++) {
        transfers.push({
          time: 25_000 + i * 2_000, // Start after phase 1 completes
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: BigInt(toWei('300')), // 300 tokens each = 3000 total needed
        });
      }

      const durationMs = 120_000; // 2 minutes

      console.log('\n' + '='.repeat(70));
      console.log('COMPARISON TEST: Transfer Success & Latency');
      console.log('='.repeat(70));
      console.log('Understanding the flow:');
      console.log('  - Transfers TO domain2 RELEASE collateral from domain2');
      console.log('  - If domain2 runs out of collateral, transfers TO it fail');
      console.log('');
      console.log('Traffic Pattern:');
      console.log('  Phase 1: 20 × 200 tokens domain1 → domain2 (drains domain2)');
      console.log('  Phase 2: 10 × 300 tokens domain1 → domain2 (needs domain2 collateral)');
      console.log('');
      console.log('Initial: 5,000 tokens on each domain');
      console.log('After Phase 1: domain2 has 1,000 tokens left');
      console.log('Phase 2 needs: 3,000 tokens from domain2');
      console.log('');
      console.log('Without rebalancer: ~7 Phase 2 transfers should FAIL');
      console.log('With rebalancer: should succeed (collateral moved from domain1→domain2)');
      console.log('='.repeat(70) + '\n');

      // ===== RUN 1: Without Rebalancer =====
      console.log('📊 Running WITHOUT rebalancer...');
      const withoutResult = await runWithoutRebalancer([...transfers], 5, 200);
      
      console.log('\nResults WITHOUT Rebalancer:');
      console.log(`  Total transfers: ${withoutResult.results.length}`);
      console.log(`  Successful: ${withoutResult.successCount}`);
      console.log(`  Failed: ${withoutResult.failureCount}`);
      console.log(`  Success rate: ${((withoutResult.successCount / withoutResult.results.length) * 100).toFixed(1)}%`);
      if (withoutResult.successCount > 0) {
        console.log(`  Avg latency: ${withoutResult.avgLatencyMs.toFixed(0)}ms`);
        console.log(`  P95 latency: ${withoutResult.p95LatencyMs.toFixed(0)}ms`);
        console.log(`  Max latency: ${withoutResult.maxLatencyMs.toFixed(0)}ms`);
      }
      
      // Show failure breakdown
      const phase2Failures = withoutResult.results
        .filter(r => r.origin === DOMAIN_1.name && !r.success);
      if (phase2Failures.length > 0) {
        console.log(`\n  Phase 2 failures (domain1→domain2): ${phase2Failures.length}/10`);
      }

      // Restore snapshot for clean state
      await setup.restoreSnapshot(baseSnapshot);
      baseSnapshot = await setup.createSnapshot();

      // ===== RUN 2: With Rebalancer =====
      console.log('\n📊 Running WITH rebalancer (2% tolerance)...');
      const withResult = await runWithRebalancer([...transfers], durationMs);

      console.log('\nResults WITH Rebalancer:');
      console.log(`  Total transfers: ${withResult.results.length}`);
      console.log(`  Successful: ${withResult.successCount}`);
      console.log(`  Failed: ${withResult.failureCount}`);
      console.log(`  Success rate: ${((withResult.successCount / withResult.results.length) * 100).toFixed(1)}%`);
      if (withResult.successCount > 0) {
        console.log(`  Avg latency: ${withResult.avgLatencyMs.toFixed(0)}ms`);
        console.log(`  P95 latency: ${withResult.p95LatencyMs.toFixed(0)}ms`);
        console.log(`  Max latency: ${withResult.maxLatencyMs.toFixed(0)}ms`);
      }
      console.log(`  Rebalance operations: ${withResult.rebalanceCount}`);
      console.log(`  Total volume rebalanced: ${(Number(withResult.rebalanceVolume) / 1e18).toFixed(2)} tokens`);

      // ===== COMPARISON =====
      console.log('\n' + '='.repeat(70));
      console.log('COMPARISON SUMMARY');
      console.log('='.repeat(70));
      console.log('                        Without Rebalancer    With Rebalancer');
      console.log(`Success Rate:           ${((withoutResult.successCount / withoutResult.results.length) * 100).toFixed(1).padStart(10)}%         ${((withResult.successCount / withResult.results.length) * 100).toFixed(1).padStart(10)}%`);
      console.log(`Failed Transfers:       ${String(withoutResult.failureCount).padStart(10)}          ${String(withResult.failureCount).padStart(10)}`);
      if (withoutResult.successCount > 0 && withResult.successCount > 0) {
        console.log(`Avg Latency:            ${withoutResult.avgLatencyMs.toFixed(0).padStart(8)}ms         ${withResult.avgLatencyMs.toFixed(0).padStart(8)}ms`);
        console.log(`P95 Latency:            ${withoutResult.p95LatencyMs.toFixed(0).padStart(8)}ms         ${withResult.p95LatencyMs.toFixed(0).padStart(8)}ms`);
      }
      console.log('='.repeat(70) + '\n');

      // Assertions - focus on what matters: transfer success
      expect(withResult.successCount).to.be.greaterThan(
        withoutResult.successCount,
        'Rebalancer should enable more transfers to succeed'
      );

      // Without rebalancer, Phase 2 transfers should mostly fail
      expect(withoutResult.failureCount).to.be.greaterThan(
        0,
        'Without rebalancer, some Phase 2 transfers should fail due to insufficient collateral'
      );

      // With rebalancer, success rate should be much higher
      const withSuccessRate = withResult.successCount / withResult.results.length;
      const withoutSuccessRate = withoutResult.successCount / withoutResult.results.length;
      expect(withSuccessRate).to.be.greaterThan(
        withoutSuccessRate,
        'Rebalancer should improve success rate'
      );

      // The rebalancer should have executed at least one operation
      expect(withResult.rebalanceCount).to.be.greaterThan(
        0,
        'Rebalancer should have executed at least one rebalance'
      );
    });

    it('should handle bidirectional imbalanced traffic', async function () {
      // This test uses bidirectional traffic (70/30 split) which is more realistic
      // Both domains will occasionally run low on collateral
      const transfers: ScheduledTransfer[] = [];
      
      // Generate 40 transfers with 70/30 split (28 domain1→domain2, 12 domain2→domain1)
      // This creates a gradual imbalance that the rebalancer should correct
      const totalTransfers = 40;
      const majorityRatio = 0.7;
      const transferAmount = BigInt(toWei('150'));
      
      for (let i = 0; i < totalTransfers; i++) {
        const isMajorityDirection = (i % 10) < 7; // 70% one direction
        transfers.push({
          time: i * 1_500, // 1.5 second intervals
          origin: isMajorityDirection ? DOMAIN_1.name : DOMAIN_2.name,
          destination: isMajorityDirection ? DOMAIN_2.name : DOMAIN_1.name,
          amount: transferAmount,
        });
      }

      const durationMs = 120_000; // 2 minutes

      console.log('\n' + '='.repeat(70));
      console.log('BIDIRECTIONAL TRAFFIC TEST');
      console.log('='.repeat(70));
      console.log('Traffic Pattern: 70/30 split (bidirectional, imbalanced)');
      console.log(`  - ${Math.round(totalTransfers * majorityRatio)} transfers domain1 → domain2`);
      console.log(`  - ${Math.round(totalTransfers * (1 - majorityRatio))} transfers domain2 → domain1`);
      console.log(`  - Each transfer: 150 tokens`);
      console.log('');
      console.log('Expected behavior:');
      console.log('  - Without rebalancer: some transfers fail as collateral drains');
      console.log('  - With rebalancer: collateral moves to maintain balance');
      console.log('='.repeat(70) + '\n');

      // ===== RUN 1: Without Rebalancer =====
      console.log('📊 Running WITHOUT rebalancer...');
      const withoutResult = await runWithoutRebalancer([...transfers], 3, 200);
      
      console.log('\nResults WITHOUT Rebalancer:');
      console.log(`  Total transfers: ${withoutResult.results.length}`);
      console.log(`  Successful: ${withoutResult.successCount}`);
      console.log(`  Failed: ${withoutResult.failureCount}`);
      console.log(`  Success rate: ${((withoutResult.successCount / withoutResult.results.length) * 100).toFixed(1)}%`);

      // Restore snapshot for clean state
      await setup.restoreSnapshot(baseSnapshot);
      baseSnapshot = await setup.createSnapshot();

      // ===== RUN 2: With Rebalancer =====
      console.log('\n📊 Running WITH rebalancer (2% tolerance)...');
      const withResult = await runWithRebalancer([...transfers], durationMs);

      console.log('\nResults WITH Rebalancer:');
      console.log(`  Total transfers: ${withResult.results.length}`);
      console.log(`  Successful: ${withResult.successCount}`);
      console.log(`  Failed: ${withResult.failureCount}`);
      console.log(`  Success rate: ${((withResult.successCount / withResult.results.length) * 100).toFixed(1)}%`);
      console.log(`  Rebalance operations: ${withResult.rebalanceCount}`);
      console.log(`  Total volume rebalanced: ${(Number(withResult.rebalanceVolume) / 1e18).toFixed(2)} tokens`);

      // ===== COMPARISON =====
      console.log('\n' + '='.repeat(70));
      console.log('BIDIRECTIONAL TRAFFIC SUMMARY');
      console.log('='.repeat(70));
      console.log('                        Without Rebalancer    With Rebalancer');
      console.log(`Success Rate:           ${((withoutResult.successCount / withoutResult.results.length) * 100).toFixed(1).padStart(10)}%         ${((withResult.successCount / withResult.results.length) * 100).toFixed(1).padStart(10)}%`);
      console.log(`Failed Transfers:       ${String(withoutResult.failureCount).padStart(10)}          ${String(withResult.failureCount).padStart(10)}`);
      console.log('='.repeat(70) + '\n');

      // With rebalancer should have better or equal success rate
      expect(withResult.successCount).to.be.greaterThanOrEqual(
        withoutResult.successCount,
        'Rebalancer should enable at least as many transfers to succeed'
      );
    });
  });

  // ========== STRESS TEST ==========

  describe('Stress Test (50+ Transfers)', function () {
    it('should handle 50 transfers with phase changes and rebalancer maintaining stability', async function () {
      // Use 5% tolerance for stress test to avoid too many rebalance operations
      const simulation = await createSimulation(5);

      // Generate 50 transfers with varying patterns (more manageable than 100)
      const transfers: ScheduledTransfer[] = [];
      const baseAmount = BigInt(toWei('100')); // 100 tokens per transfer
      
      // Mix of unidirectional bursts and bidirectional traffic
      for (let i = 0; i < 50; i++) {
        // Phase 1 (0-15): Mostly domain1 → domain2 (drain domain2)
        // Phase 2 (15-30): Mostly domain2 → domain1 (drain domain1)
        // Phase 3 (30-50): Mixed bidirectional
        let origin: string;
        let destination: string;
        
        if (i < 15) {
          // 80% domain1 → domain2
          const toDomain2 = (i % 5) < 4;
          origin = toDomain2 ? DOMAIN_1.name : DOMAIN_2.name;
          destination = toDomain2 ? DOMAIN_2.name : DOMAIN_1.name;
        } else if (i < 30) {
          // 80% domain2 → domain1
          const toDomain1 = (i % 5) < 4;
          origin = toDomain1 ? DOMAIN_2.name : DOMAIN_1.name;
          destination = toDomain1 ? DOMAIN_1.name : DOMAIN_2.name;
        } else {
          // 50/50 mixed
          const flip = i % 2 === 0;
          origin = flip ? DOMAIN_1.name : DOMAIN_2.name;
          destination = flip ? DOMAIN_2.name : DOMAIN_1.name;
        }
        
        transfers.push({
          time: i * 1500, // 1.5s intervals (75 seconds total simulated)
          origin,
          destination,
          amount: baseAmount,
        });
      }

      const schedule: SimulationRun = {
        name: 'stress-test-50-transfers',
        durationMs: 2 * 60_000, // 2 minutes simulated
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('STRESS TEST: 50 Transfers with Phase Changes');
      console.log('='.repeat(70));
      console.log('Traffic Pattern:');
      console.log('  Phase 1 (0-15):  80% domain1 → domain2 (drains domain2)');
      console.log('  Phase 2 (15-30): 80% domain2 → domain1 (drains domain1)');
      console.log('  Phase 3 (30-50): 50/50 mixed');
      console.log('');
      console.log('Each transfer: 100 tokens');
      console.log('Tolerance: 5% (250 token threshold on 5000 target)');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));

      console.log('\n=== STRESS TEST SUMMARY ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Success rate: ${((results.transfers.completed / results.transfers.total) * 100).toFixed(1)}%`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Total volume rebalanced: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);
      console.log(`Throughput: ${(results.transfers.total / (wallTime / 1000)).toFixed(2)} transfers/second`);

      // Assertions
      expect(results.transfers.total).to.equal(50);
      
      // With rebalancer, success rate should be very high (>95%)
      const successRate = results.transfers.completed / results.transfers.total;
      expect(successRate).to.be.greaterThan(0.95, 'Stress test should maintain >95% success rate with rebalancer');
      
      // Rebalancer should have executed multiple operations given the phase changes
      expect(results.rebalancing.count).to.be.greaterThan(0, 'Rebalancer should have triggered during stress test');
    });

    it('should handle burst traffic without failures', async function () {
      const simulation = await createSimulation(3); // 3% tolerance

      // Generate a burst of 25 transfers in rapid succession (reduced from 50)
      const transfers: ScheduledTransfer[] = [];
      const burstAmount = BigInt(toWei('150')); // Larger amounts to create pressure
      
      // All transfers in the same direction, spaced 500ms apart
      // This creates intense pressure on domain2's collateral
      for (let i = 0; i < 25; i++) {
        transfers.push({
          time: i * 500, // 500ms intervals
          origin: DOMAIN_1.name,
          destination: DOMAIN_2.name,
          amount: burstAmount,
        });
      }

      const schedule: SimulationRun = {
        name: 'burst-traffic-25-transfers',
        durationMs: 60_000, // 1 minute simulated
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('BURST TRAFFIC TEST: 25 Rapid Transfers');
      console.log('='.repeat(70));
      console.log('Pattern: 25 × 150 tokens domain1 → domain2 (3750 total)');
      console.log('Timing: 500ms intervals (burst pattern)');
      console.log('This tests rebalancer responsiveness under pressure');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));

      console.log('\n=== BURST TEST SUMMARY ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Success rate: ${((results.transfers.completed / results.transfers.total) * 100).toFixed(1)}%`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      // Assertions
      expect(results.transfers.total).to.equal(25);
      expect(results.transfers.completed).to.equal(25);
      expect(results.transfers.stuck).to.equal(0);
    });
  });

  // ========== MULTI-CHAIN TEST ==========

  describe('Multi-Chain Scenario (3 Collateral Domains)', function () {
    // This test uses a separate setup with 3 collateral domains
    let multiChainSetup: RebalancerTestSetup;
    let multiChainSnapshot: SnapshotInfo;
    const MULTI_CHAIN_DOMAINS = [DOMAIN_1, DOMAIN_2, DOMAIN_4]; // 3 collateral domains
    const MULTI_CHAIN_INITIAL = toWei('3000'); // 3000 tokens per domain (9000 total)

    before(async function () {
      // Create a separate setup for multi-chain testing
      multiChainSetup = await createRebalancerTestSetup({
        collateralDomains: MULTI_CHAIN_DOMAINS,
        syntheticDomains: [],
        initialCollateral: BigInt(MULTI_CHAIN_INITIAL),
        logger,
        simulatedBridge: {
          fixedFee: 0n,
          variableFeeBps: 10,
        },
      });
      multiChainSnapshot = await multiChainSetup.createSnapshot();
    });

    afterEach(async function () {
      await multiChainSetup.restoreSnapshot(multiChainSnapshot);
      multiChainSnapshot = await multiChainSetup.createSnapshot();
    });

    async function createMultiChainSimulation(tolerance: number = 5): Promise<IntegratedSimulation> {
      // Create weighted strategy config for 3 domains
      // Using equal weights (33.33% each)
      const strategyConfig = createWeightedStrategyConfig(multiChainSetup, {
        [DOMAIN_1.name]: { weight: 33, tolerance },
        [DOMAIN_2.name]: { weight: 33, tolerance },
        [DOMAIN_4.name]: { weight: 34, tolerance }, // 34 to make 100
      });

      const simulation = new IntegratedSimulation({
        setup: multiChainSetup,
        warpRouteId: 'test-warp-route-multichain',
        messageDeliveryDelayMs: 2000,
        deliveryCheckIntervalMs: 500,
        recordingIntervalMs: 1000,
        rebalancerCheckFrequencyMs: 5000,
        bridgeTransferDelayMs: 3000,
        bridgeConfigs: {
          // All pairwise combinations for 3 domains
          [`${DOMAIN_1.name}-${DOMAIN_2.name}`]: { fixedFee: 0n, variableFeeBps: 10, transferTimeMs: 3000 },
          [`${DOMAIN_2.name}-${DOMAIN_1.name}`]: { fixedFee: 0n, variableFeeBps: 10, transferTimeMs: 3000 },
          [`${DOMAIN_1.name}-${DOMAIN_4.name}`]: { fixedFee: 0n, variableFeeBps: 10, transferTimeMs: 3000 },
          [`${DOMAIN_4.name}-${DOMAIN_1.name}`]: { fixedFee: 0n, variableFeeBps: 10, transferTimeMs: 3000 },
          [`${DOMAIN_2.name}-${DOMAIN_4.name}`]: { fixedFee: 0n, variableFeeBps: 10, transferTimeMs: 3000 },
          [`${DOMAIN_4.name}-${DOMAIN_2.name}`]: { fixedFee: 0n, variableFeeBps: 10, transferTimeMs: 3000 },
        },
        strategyConfig,
        logger,
      });

      await simulation.initialize();
      return simulation;
    }

    it('should handle 3-domain traffic with rebalancing across multiple routes', async function () {
      const simulation = await createMultiChainSimulation(5);

      // Create traffic pattern that creates imbalance from one domain
      // Using sequential phases to avoid nonce conflicts (Anvil limitation)
      const transfers: ScheduledTransfer[] = [];
      const transferAmount = BigInt(toWei('150'));
      
      // All transfers TO domain1 (drains domain1's collateral)
      // This creates pressure on domain1 which the rebalancer should address
      // by moving collateral FROM domain2/domain4 TO domain1
      for (let i = 0; i < 15; i++) {
        // Alternate between domain2→domain1 and domain4→domain1
        const origin = i % 2 === 0 ? DOMAIN_2.name : DOMAIN_4.name;
        transfers.push({
          time: i * 2000, // 2 second intervals
          origin,
          destination: DOMAIN_1.name,
          amount: transferAmount,
        });
      }

      const schedule: SimulationRun = {
        name: 'multi-chain-15-transfers',
        durationMs: 60_000,
        transfers,
      };

      console.log('\n' + '='.repeat(70));
      console.log('MULTI-CHAIN TEST: 3 Collateral Domains');
      console.log('='.repeat(70));
      console.log('Setup: 3 domains × 3000 tokens = 9000 total collateral');
      console.log('Traffic Pattern:');
      console.log('  15 transfers alternating domain2/domain4 → domain1');
      console.log('  Each transfer: 150 tokens (2250 total draining domain1)');
      console.log('');
      console.log('Rebalancer should move collateral to domain1 from surplus domains');
      console.log('='.repeat(70) + '\n');

      const startTime = Date.now();
      const results = await simulation.run(schedule);
      const wallTime = Date.now() - startTime;

      console.log(visualizeSimulation(results));

      console.log('\n=== MULTI-CHAIN TEST SUMMARY ===');
      console.log(`Total transfers: ${results.transfers.total}`);
      console.log(`Completed: ${results.transfers.completed}`);
      console.log(`Stuck: ${results.transfers.stuck}`);
      console.log(`Success rate: ${((results.transfers.completed / results.transfers.total) * 100).toFixed(1)}%`);
      console.log(`Rebalances executed: ${results.rebalancing.count}`);
      console.log(`Total volume rebalanced: ${(Number(results.rebalancing.totalVolume) / 1e18).toFixed(2)} tokens`);
      console.log(`Wall clock time: ${(wallTime / 1000).toFixed(1)}s`);

      // Assertions
      expect(results.transfers.total).to.equal(15);
      expect(results.transfers.completed).to.equal(15); // All should succeed with rebalancer
      
      // Rebalancer should have triggered to replenish domain1
      expect(results.rebalancing.count).to.be.greaterThan(0, 'Rebalancer should have triggered during multi-chain test');
    });
  });

  // ========== BALANCE VERIFICATION TEST ==========

  describe('Balance Verification', function () {
    it('should maintain token conservation after rebalancing', async function () {
      const simulation = await createSimulation();

      // Record initial total collateral
      let initialTotal = 0n;
      for (const [domainName, token] of Object.entries(setup.tokens)) {
        const warpRouteAddress = setup.getWarpRouteAddress(domainName);
        const balance = await token.balanceOf(warpRouteAddress);
        initialTotal += BigInt(balance.toString());
      }

      const schedule: SimulationRun = {
        name: 'balance-verification',
        durationMs: 60_000,
        transfers: [
          {
            time: 0,
            origin: DOMAIN_1.name,
            destination: DOMAIN_2.name,
            amount: BigInt(toWei('100')),
          },
          {
            time: 5_000,
            origin: DOMAIN_1.name,
            destination: DOMAIN_2.name,
            amount: BigInt(toWei('150')),
          },
        ],
      };

      console.log('\nRunning balance verification test...');
      console.log(`Initial total collateral: ${(Number(initialTotal) / 1e18).toFixed(2)} tokens`);

      const results = await simulation.run(schedule);
      console.log(visualizeSimulation(results));

      // Check final total collateral
      let finalTotal = 0n;
      for (const [domainName, token] of Object.entries(setup.tokens)) {
        const warpRouteAddress = setup.getWarpRouteAddress(domainName);
        const balance = await token.balanceOf(warpRouteAddress);
        finalTotal += BigInt(balance.toString());
        console.log(`${domainName} balance: ${(Number(balance.toString()) / 1e18).toFixed(2)} tokens`);
      }

      console.log(`Final total collateral: ${(Number(finalTotal) / 1e18).toFixed(2)} tokens`);

      // Account for any bridge fees that were deducted
      const totalFees = results.rebalancing.totalFees;
      const expectedTotal = initialTotal - totalFees;

      // Total should be conserved (minus bridge fees)
      expect(finalTotal).to.equal(expectedTotal);
    });
  });
});
