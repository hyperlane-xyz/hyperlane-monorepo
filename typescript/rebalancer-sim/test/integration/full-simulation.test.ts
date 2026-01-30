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
 *
 * KNOWN LIMITATION:
 * When running the full test suite with REBALANCERS=simple,production, some tests
 * may timeout due to cumulative state from the ProductionRebalancerRunner. To run
 * comparisons reliably, run specific scenarios:
 *   REBALANCERS=simple,production pnpm test --grep "scenario-name"
 *
 * The default (REBALANCERS=simple) runs reliably for all scenarios.
 */
import { expect } from 'chai';

import { listScenarios } from '../../src/index.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';
import {
  cleanupRebalancers,
  ensureResultsDir,
  getEnabledRebalancers,
  runScenarioWithRebalancers,
} from '../utils/simulation-helpers.js';

describe('Rebalancer Simulation', function () {
  const anvilPort = 8545;
  const anvil = setupAnvilTestSuite(this, anvilPort);

  before(async function () {
    ensureResultsDir();

    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      console.log('No scenarios found. Run: pnpm generate-scenarios');
      this.skip();
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
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
      }
      if (file.expectations.shouldTriggerRebalancing) {
        expect(result.kpis.totalRebalances).to.be.greaterThan(
          0,
          `${result.rebalancerName} should trigger rebalancing`,
        );
      }
    }
  });

  it('extreme-accumulate-chain1: should trigger rebalancing', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'extreme-accumulate-chain1',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
      }
      if (file.expectations.minRebalances) {
        expect(result.kpis.totalRebalances).to.be.greaterThanOrEqual(
          file.expectations.minRebalances,
          `${result.rebalancerName} should trigger min rebalances`,
        );
      }
    }
  });

  it('large-unidirectional-to-chain1: large transfers', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'large-unidirectional-to-chain1',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
      }
    }
  });

  it('whale-transfers: massive single transfers', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'whale-transfers',
      { anvilRpc: anvil.rpc },
    );

    for (const result of results) {
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
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

    for (const result of results) {
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
      }
    }

    // When comparing, completion rates should be similar
    if (results.length > 1) {
      const completionDiff = Math.abs(
        results[0].kpis.completionRate - results[1].kpis.completionRate,
      );
      expect(completionDiff).to.be.lessThan(
        0.1,
        'Completion rates should be within 10% of each other',
      );
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
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
      }
      // Key: p50 latency should be low with enough headroom
      // Only assert for SimpleRunner - the CLI rebalancer may have different
      // behavior due to more aggressive rebalancing strategies
      if (result.rebalancerName === 'SimpleRebalancer') {
        expect(result.kpis.p50Latency).to.be.lessThan(
          500,
          `${result.rebalancerName} should have low p50 latency`,
        );
      }
    }
  });
});
