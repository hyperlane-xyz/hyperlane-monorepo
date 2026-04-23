/**
 * REBALANCER SIMULATION TEST SUITE
 * ================================
 *
 * Single entry point for all rebalancer simulation testing.
 * Supports both single rebalancer tests and multi-rebalancer comparisons.
 *
 * Configuration:
 * - Set REBALANCERS env var to specify which rebalancers to test
 *   e.g., REBALANCERS=simple pnpm test (for single rebalancer)
 * - Default: runs both SimpleRunner and ProductionRebalancerRunner
 *
 * Each scenario JSON includes:
 * - description: What the scenario tests
 * - expectedBehavior: Why it should behave a certain way
 * - transfers: The traffic pattern
 * - defaultTiming, defaultBridgeConfig, defaultStrategyConfig: Default configs
 * - expectations: Assertions (minCompletionRate, shouldTriggerRebalancing, etc.)
 */
import { expect } from 'vitest';

import { listScenarios } from '../../src/index.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';
import {
  cleanupRebalancers,
  ensureResultsDir,
  getEnabledRebalancers,
  runScenarioWithRebalancers,
} from '../utils/simulation-helpers.js';

describe('Rebalancer Simulation', function () {
  const anvil = setupAnvilTestSuite();

  beforeAll(async () => {
    ensureResultsDir();

    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      console.log('No scenarios found. Run: pnpm generate-scenarios');
      return;
    }
    console.log(`Found ${scenarios.length} scenarios: ${scenarios.join(', ')}`);
    console.log(
      `Testing rebalancers: ${getEnabledRebalancers().join(', ')} (set REBALANCERS env to change)`,
    );
  });

  // Cleanup rebalancers between tests (anvil restarts automatically via setupAnvilTestSuite)
  afterEach(async function () {
    await cleanupRebalancers();
  });

  // ============================================================================
  // EXTREME IMBALANCE SCENARIOS
  // ============================================================================

  it('extreme-drain-chain1: should trigger rebalancing', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'extreme-drain-chain1',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      // Skip assertions for NoOpRebalancer (baseline only)
      if (result.rebalancerName === 'NoOpRebalancer') continue;

      if (file.expectations.minCompletionRate) {
        expect(
          result.kpis.completionRate,
          `${result.rebalancerName} should have min completion rate`,
        ).toBeGreaterThanOrEqual(file.expectations.minCompletionRate);
      }
      if (file.expectations.shouldTriggerRebalancing) {
        expect(
          result.kpis.totalRebalances,
          `${result.rebalancerName} should trigger rebalancing`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('extreme-accumulate-chain1: should trigger rebalancing', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'extreme-accumulate-chain1',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      // Skip assertions for NoOpRebalancer (baseline only)
      if (result.rebalancerName === 'NoOpRebalancer') continue;

      if (file.expectations.minCompletionRate) {
        expect(
          result.kpis.completionRate,
          `${result.rebalancerName} should have min completion rate`,
        ).toBeGreaterThanOrEqual(file.expectations.minCompletionRate);
      }
      if (file.expectations.minRebalances) {
        expect(
          result.kpis.totalRebalances,
          `${result.rebalancerName} should trigger min rebalances`,
        ).toBeGreaterThanOrEqual(file.expectations.minRebalances);
      }
    }
  });

  it('large-unidirectional-to-chain1: large transfers', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'large-unidirectional-to-chain1',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      // Skip assertions for NoOpRebalancer (baseline only)
      if (result.rebalancerName === 'NoOpRebalancer') continue;

      if (file.expectations.minCompletionRate) {
        expect(
          result.kpis.completionRate,
          `${result.rebalancerName} should have min completion rate`,
        ).toBeGreaterThanOrEqual(file.expectations.minCompletionRate);
      }
    }
  });

  it('whale-transfers: massive single transfers', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'whale-transfers',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      // Skip assertions for NoOpRebalancer (baseline only)
      if (result.rebalancerName === 'NoOpRebalancer') continue;

      if (file.expectations.minCompletionRate) {
        expect(
          result.kpis.completionRate,
          `${result.rebalancerName} should have min completion rate`,
        ).toBeGreaterThanOrEqual(file.expectations.minCompletionRate);
      }
    }
  });

  // ============================================================================
  // BALANCED SCENARIOS
  // ============================================================================

  it('balanced-bidirectional: minimal rebalancing needed', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'balanced-bidirectional',
      { anvilRpc: anvil.rpc },
    );

    // Filter out NoOpRebalancer for assertions
    const activeResults = results.filter(
      (r) => r.rebalancerName !== 'NoOpRebalancer',
    );

    for (const result of activeResults) {
      if (file.expectations.minCompletionRate) {
        expect(
          result.kpis.completionRate,
          `${result.rebalancerName} should have min completion rate`,
        ).toBeGreaterThanOrEqual(file.expectations.minCompletionRate);
      }
    }

    // When comparing, completion rates should be similar
    if (activeResults.length > 1) {
      const completionDiff = Math.abs(
        activeResults[0].kpis.completionRate -
          activeResults[1].kpis.completionRate,
      );
      expect(
        completionDiff,
        'Completion rates should be within 10% of each other',
      ).toBeLessThan(0.1);
    }
  });

  // ============================================================================
  // RANDOM WITH HEADROOM
  // ============================================================================

  it('random-with-headroom: low latency with random traffic', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'random-with-headroom',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      // Skip assertions for NoOpRebalancer (baseline only)
      if (result.rebalancerName === 'NoOpRebalancer') continue;

      if (file.expectations.minCompletionRate) {
        expect(
          result.kpis.completionRate,
          `${result.rebalancerName} should have min completion rate`,
        ).toBeGreaterThanOrEqual(file.expectations.minCompletionRate);
      }
      // Key: p50 latency should be low with enough headroom
      // Only assert for SimpleRunner - the CLI rebalancer may have different
      // behavior due to more aggressive rebalancing strategies
      if (result.rebalancerName === 'SimpleRebalancer') {
        expect(
          result.kpis.p50Latency,
          `${result.rebalancerName} should have low p50 latency`,
        ).toBeLessThan(500);
      }
    }
  });

  // ============================================================================
  // INFLIGHT GUARD
  // ============================================================================

  /**
   * Inflight Guard Test
   *
   * This test demonstrates the inflight tracking problem: with slow bridges (3s)
   * and polling at 1000ms, a rebalancer without inflight awareness will
   * over-rebalance because it doesn't account for pending transfers.
   *
   * SimpleRebalancer: No inflight tracking, over-rebalances significantly
   * ProductionRebalancer: Tracks pending rebalances via MockActionTracker,
   * significantly reduces redundant rebalances (typically 60-80% fewer)
   */
  it('inflight-guard: ProductionRebalancer uses fewer rebalances with inflight tracking', async () => {
    const { results } = await runScenarioWithRebalancers('inflight-guard', {
      anvilRpc: anvil.rpc,
    });

    // Report results
    console.log('\n  INFLIGHT GUARD REPORT:');
    for (const result of results) {
      console.log(
        `    ${result.rebalancerName}: ${result.kpis.totalRebalances} rebalances`,
      );
    }

    // Find results by rebalancer type
    const productionResult = results.find(
      (r) => r.rebalancerName === 'ProductionRebalancerService',
    );
    const simpleResult = results.find(
      (r) => r.rebalancerName === 'SimpleRebalancer',
    );

    // Both should complete all transfers
    if (productionResult) {
      expect(
        productionResult.kpis.completionRate,
        'ProductionRebalancer should complete all transfers',
      ).toBe(1);
    }
    if (simpleResult) {
      expect(
        simpleResult.kpis.completionRate,
        'SimpleRebalancer should complete all transfers',
      ).toBe(1);
    }

    // ProductionRebalancer with inflight tracking should use significantly fewer rebalances
    if (productionResult && simpleResult) {
      expect(
        productionResult.kpis.totalRebalances,
        'ProductionRebalancer should use fewer rebalances than SimpleRebalancer',
      ).toBeLessThan(simpleResult.kpis.totalRebalances);

      // ProductionRebalancer should use at most 50% of SimpleRebalancer's rebalances
      // (typically achieves 60-80% reduction)
      expect(
        simpleResult.kpis.totalRebalances,
        'SimpleRebalancer should have rebalanced at least once for ratio comparison',
      ).toBeGreaterThan(0);
      const reductionRatio =
        productionResult.kpis.totalRebalances /
        simpleResult.kpis.totalRebalances;
      expect(
        reductionRatio,
        `ProductionRebalancer should achieve >50% reduction in rebalances (got ${((1 - reductionRatio) * 100).toFixed(0)}% reduction)`,
      ).toBeLessThan(0.5);
    }
  });

  // BLOCKED USER TRANSFER
  // ============================================================================

  /**
   * Blocked User Transfer Test
   *
   * Tests that the ProductionRebalancer proactively adds collateral when
   * user transfers are pending but blocked due to insufficient collateral.
   *
   * Scenario: 130 total tokens split 90/40 between chain1/chain2.
   * User initiates 50 token transfer from chain1 → chain2.
   * chain2 only has 40 tokens but needs 50 to pay out.
   *
   * SimpleRebalancer: Only sees on-chain balances, doesn't know about pending
   * transfer, weights appear within tolerance → no action → transfer stuck
   *
   * ProductionRebalancer: MockActionTracker tracks pending transfer, strategy
   * reserves collateral for it, detects deficit → rebalances → transfer succeeds
   */
  it('blocked-user-transfer: ProductionRebalancer proactively adds collateral for pending transfers', async () => {
    const { results } = await runScenarioWithRebalancers(
      'blocked-user-transfer',
      {
        anvilRpc: anvil.rpc,
      },
    );

    console.log('\n  BLOCKED USER TRANSFER REPORT:');
    for (const result of results) {
      console.log(
        `    ${result.rebalancerName}: completion=${(result.kpis.completionRate * 100).toFixed(0)}%, rebalances=${result.kpis.totalRebalances}`,
      );
    }

    // Find results by rebalancer type
    const productionResult = results.find(
      (r) => r.rebalancerName === 'ProductionRebalancerService',
    );
    const simpleResult = results.find(
      (r) => r.rebalancerName === 'SimpleRebalancer',
    );

    // SimpleRebalancer without inflight tracking should fail to complete
    if (simpleResult) {
      expect(
        simpleResult.kpis.completionRate,
        'SimpleRebalancer should have 0% completion (blocked transfer)',
      ).toBe(0);
      expect(
        simpleResult.kpis.totalRebalances,
        'SimpleRebalancer should not rebalance (weights within tolerance)',
      ).toBe(0);
    }

    // ProductionRebalancer with inflight tracking should complete
    if (productionResult) {
      expect(
        productionResult.kpis.completionRate,
        'ProductionRebalancer should have 100% completion (proactive collateral)',
      ).toBe(1.0);
      expect(
        productionResult.kpis.totalRebalances,
        'ProductionRebalancer should rebalance (sees pending transfer deficit)',
      ).toBeGreaterThan(0);
    }
  });
});
