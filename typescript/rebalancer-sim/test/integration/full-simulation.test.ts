/**
 * REBALANCER SIMULATION TEST SUITE
 * ================================
 *
 * Single entry point for all rebalancer simulation testing.
 * Supports both single rebalancer tests and multi-rebalancer comparisons.
 *
 * Configuration:
 * - Set REBALANCERS env var to specify which rebalancers to test
 *   e.g., REBALANCERS=hyperlane,real pnpm test
 * - Default: runs HyperlaneRunner only
 *
 * Each scenario JSON includes:
 * - description: What the scenario tests
 * - expectedBehavior: Why it should behave a certain way
 * - transfers: The traffic pattern
 * - defaultTiming, defaultBridgeConfig, defaultStrategyConfig: Default configs
 * - expectations: Assertions (minCompletionRate, shouldTriggerRebalancing, etc.)
 *
 * KNOWN LIMITATION:
 * When running the full test suite with REBALANCERS=hyperlane,real, some tests
 * may timeout due to cumulative state from the RealRebalancerService. To run
 * comparisons reliably, run specific scenarios:
 *   REBALANCERS=hyperlane,real pnpm test --grep "scenario-name"
 *
 * The default (REBALANCERS=hyperlane) runs reliably for all scenarios.
 */
import { expect } from 'chai';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  deployMultiDomainSimulation,
  getWarpTokenBalance,
} from '../../src/deployment/SimulationDeployment.js';
import { ANVIL_DEPLOYER_KEY } from '../../src/deployment/types.js';
import { SimulationEngine } from '../../src/engine/SimulationEngine.js';
import type { SimulationResult } from '../../src/kpi/types.js';
import {
  HyperlaneRunner,
  cleanupHyperlaneRunner,
} from '../../src/rebalancer/HyperlaneRunner.js';
import {
  RealRebalancerRunner,
  cleanupRealRebalancer,
} from '../../src/rebalancer/RealRebalancerRunner.js';
import type { IRebalancerRunner } from '../../src/rebalancer/types.js';
import {
  listScenarios,
  loadScenario,
  loadScenarioFile,
} from '../../src/scenario/ScenarioLoader.js';
import type { ScenarioFile } from '../../src/scenario/types.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');

// Configure which rebalancers to test via environment variable
// e.g., REBALANCERS=hyperlane,real for comparison
// Default: run HyperlaneRunner only (stable), opt-in to RealRebalancerService
type RebalancerType = 'hyperlane' | 'real';
const REBALANCER_ENV = process.env.REBALANCERS || 'hyperlane,real';
const ENABLED_REBALANCERS: RebalancerType[] = REBALANCER_ENV.split(',')
  .map((r) => r.trim().toLowerCase())
  .filter((r): r is RebalancerType => r === 'hyperlane' || r === 'real');

function createRebalancer(type: RebalancerType): IRebalancerRunner {
  switch (type) {
    case 'hyperlane':
      return new HyperlaneRunner();
    case 'real':
      return new RealRebalancerRunner();
  }
}

describe('Rebalancer Simulation', function () {
  const anvilPort = 8545;
  const anvil = setupAnvilTestSuite(this, anvilPort);

  before(async function () {
    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      console.log('No scenarios found. Run: pnpm generate-scenarios');
      this.skip();
    }
    console.log(`Found ${scenarios.length} scenarios: ${scenarios.join(', ')}`);
    console.log(
      `Testing rebalancers: ${ENABLED_REBALANCERS.join(', ')} (set REBALANCERS env to change)`,
    );
  });

  // Cleanup rebalancers between tests (anvil restarts automatically via setupAnvilTestSuite)
  afterEach(async function () {
    await cleanupHyperlaneRunner();
    await cleanupRealRebalancer();
  });

  /**
   * Run a scenario with specified rebalancers.
   * If multiple rebalancers, runs each and compares results.
   */
  async function runScenarioWithRebalancers(
    scenarioName: string,
    rebalancerTypes: RebalancerType[] = ENABLED_REBALANCERS,
  ): Promise<{
    results: SimulationResult[];
    file: ScenarioFile;
    comparison?: {
      bestCompletionRate: string;
      bestLatency: string;
    };
  }> {
    const file = loadScenarioFile(scenarioName);
    const scenario = loadScenario(scenarioName);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SCENARIO: ${file.name}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  ${file.description}`);
    console.log(`  Transfers: ${scenario.transfers.length}`);
    console.log(`  Chains: ${scenario.chains.join(', ')}`);
    console.log(`  Rebalancers: ${rebalancerTypes.join(', ')}`);

    const chainConfigs = file.chains.map((chainName, index) => ({
      chainName,
      domainId: 1000 + index * 1000,
    }));

    const results: SimulationResult[] = [];

    for (const rebalancerType of rebalancerTypes) {
      const rebalancer = createRebalancer(rebalancerType);

      if (rebalancerTypes.length > 1) {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`Running with: ${rebalancer.name}`);
        console.log(`${'─'.repeat(50)}`);
      }

      // Deploy fresh contracts for each rebalancer run
      // Each deployment uses fresh provider/wallet to avoid nonce caching issues
      const deployment = await deployMultiDomainSimulation({
        anvilRpc: anvil.rpc,
        deployerKey: ANVIL_DEPLOYER_KEY,
        chains: chainConfigs,
        initialCollateralBalance: BigInt(file.defaultInitialCollateral),
      });

      const strategyConfig = {
        type: file.defaultStrategyConfig.type,
        chains: {} as Record<string, any>,
      };
      for (const [chainName, chainConfig] of Object.entries(
        file.defaultStrategyConfig.chains,
      )) {
        strategyConfig.chains[chainName] = {
          ...chainConfig,
          bridge: deployment.domains[chainName].bridge,
        };
      }

      const engine = new SimulationEngine(deployment);
      const result = await engine.runSimulation(
        scenario,
        rebalancer,
        file.defaultBridgeConfig,
        file.defaultTiming,
        strategyConfig,
      );

      results.push(result);

      // Collect final balances
      const balanceProvider = new ethers.providers.JsonRpcProvider(anvil.rpc);
      const finalBalances: Record<string, string> = {};
      for (const [name, domain] of Object.entries(deployment.domains)) {
        const balance = await getWarpTokenBalance(
          balanceProvider,
          domain.warpToken,
          domain.collateralToken,
        );
        finalBalances[name] = ethers.utils.formatEther(balance.toString());
      }
      // Clean up provider
      balanceProvider.removeAllListeners();
      balanceProvider.polling = false;

      printResults(result, finalBalances, file);
    }

    // Generate comparison if multiple rebalancers
    let comparison:
      | { bestCompletionRate: string; bestLatency: string }
      | undefined;
    if (results.length > 1) {
      comparison = printComparison(results);
    }

    // Save results
    saveResults(scenarioName, file, results, comparison);

    return { results, file, comparison };
  }

  function printResults(
    result: SimulationResult,
    finalBalances: Record<string, string>,
    file: ScenarioFile,
  ) {
    console.log(`\n  Results for ${result.rebalancerName}:`);
    console.log(
      `    Completion: ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} (${(result.kpis.completionRate * 100).toFixed(1)}%)`,
    );
    console.log(
      `    Latency: avg=${result.kpis.averageLatency.toFixed(0)}ms, p50=${result.kpis.p50Latency}ms, p95=${result.kpis.p95Latency}ms`,
    );
    console.log(
      `    Rebalances: ${result.kpis.totalRebalances} (${ethers.utils.formatEther(result.kpis.rebalanceVolume.toString())} tokens)`,
    );

    console.log(`    Final Balances:`);
    const initialCollateral = ethers.utils.formatEther(
      file.defaultInitialCollateral,
    );
    for (const [name, balance] of Object.entries(finalBalances)) {
      const change = parseFloat(balance) - parseFloat(initialCollateral);
      const changeStr =
        change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
      console.log(`      ${name}: ${balance} (${changeStr})`);
    }
  }

  function printComparison(results: SimulationResult[]): {
    bestCompletionRate: string;
    bestLatency: string;
  } {
    console.log(`\n${'='.repeat(60)}`);
    console.log('COMPARISON RESULTS');
    console.log(`${'='.repeat(60)}`);

    // Print table header
    const headers = ['Metric', ...results.map((r) => r.rebalancerName)];
    const colWidths = headers.map((h) => Math.max(h.length, 15));

    console.log(
      '\n| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |',
    );
    console.log('|' + colWidths.map((w) => '-'.repeat(w + 2)).join('|') + '|');

    // Print rows
    const rows = [
      [
        'Completion %',
        ...results.map((r) => `${(r.kpis.completionRate * 100).toFixed(1)}%`),
      ],
      [
        'Avg Latency',
        ...results.map((r) => `${r.kpis.averageLatency.toFixed(0)}ms`),
      ],
      ['P50 Latency', ...results.map((r) => `${r.kpis.p50Latency}ms`)],
      ['P95 Latency', ...results.map((r) => `${r.kpis.p95Latency}ms`)],
      ['Rebalances', ...results.map((r) => String(r.kpis.totalRebalances))],
      [
        'Rebal Volume',
        ...results.map((r) =>
          ethers.utils.formatEther(r.kpis.rebalanceVolume.toString()),
        ),
      ],
    ];

    for (const row of rows) {
      console.log(
        '| ' +
          row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ') +
          ' |',
      );
    }

    // Determine winners
    const bestCompletion = results.reduce((best, r) =>
      r.kpis.completionRate > best.kpis.completionRate ? r : best,
    );
    const bestLatency = results.reduce((best, r) =>
      r.kpis.averageLatency < best.kpis.averageLatency ? r : best,
    );

    console.log('\nWinners:');
    console.log(`  Best Completion: ${bestCompletion.rebalancerName}`);
    console.log(`  Best Latency: ${bestLatency.rebalancerName}`);

    return {
      bestCompletionRate: bestCompletion.rebalancerName,
      bestLatency: bestLatency.rebalancerName,
    };
  }

  function saveResults(
    scenarioName: string,
    file: ScenarioFile,
    results: SimulationResult[],
    comparison?: { bestCompletionRate: string; bestLatency: string },
  ) {
    const output: any = {
      scenario: scenarioName,
      timestamp: new Date().toISOString(),
      description: file.description,
      expectedBehavior: file.expectedBehavior,
      expectations: file.expectations,
      results: results.map((r) => ({
        rebalancerName: r.rebalancerName,
        kpis: {
          totalTransfers: r.kpis.totalTransfers,
          completedTransfers: r.kpis.completedTransfers,
          completionRate: r.kpis.completionRate,
          averageLatency: r.kpis.averageLatency,
          p50Latency: r.kpis.p50Latency,
          p95Latency: r.kpis.p95Latency,
          p99Latency: r.kpis.p99Latency,
          totalRebalances: r.kpis.totalRebalances,
          rebalanceVolume: r.kpis.rebalanceVolume.toString(),
        },
      })),
      config: {
        timing: file.defaultTiming,
        initialCollateral: file.defaultInitialCollateral,
      },
    };

    if (comparison) {
      output.comparison = comparison;
    }

    const filePath = path.join(RESULTS_DIR, `${scenarioName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  }

  // ============================================================================
  // EXTREME IMBALANCE SCENARIOS
  // ============================================================================

  it('extreme-drain-chain1: should trigger rebalancing', async function () {
    const { results, file } = await runScenarioWithRebalancers(
      'extreme-drain-chain1',
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
    const { results, file } =
      await runScenarioWithRebalancers('whale-transfers');

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
    );

    for (const result of results) {
      if (file.expectations.minCompletionRate) {
        expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
          file.expectations.minCompletionRate,
          `${result.rebalancerName} should have min completion rate`,
        );
      }
      // Key: p50 latency should be low with enough headroom
      // Only assert for HyperlaneRunner - the real rebalancer may have different
      // behavior due to more aggressive rebalancing strategies
      if (result.rebalancerName === 'HyperlaneRebalancer') {
        expect(result.kpis.p50Latency).to.be.lessThan(
          500,
          `${result.rebalancerName} should have low p50 latency`,
        );
      }
    }
  });
});
