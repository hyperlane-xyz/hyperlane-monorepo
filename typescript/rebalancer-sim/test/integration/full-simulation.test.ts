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
import { HyperlaneRunner } from '../../src/rebalancer/HyperlaneRunner.js';
import {
  listScenarios,
  loadScenario,
  loadScenarioFile,
} from '../../src/scenario/ScenarioLoader.js';
import type { ScenarioFile } from '../../src/scenario/types.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');

/**
 * REBALANCER SIMULATION TEST SUITE
 * ================================
 *
 * These tests verify that the rebalancer correctly responds to various
 * traffic patterns that create liquidity imbalances across chains.
 *
 * Each scenario JSON includes:
 * - description: What the scenario tests
 * - expectedBehavior: Why it should behave a certain way
 * - transfers: The traffic pattern
 * - defaultTiming, defaultBridgeConfig, defaultStrategyConfig: Default configs
 * - expectations: Assertions (minCompletionRate, shouldTriggerRebalancing, etc.)
 *
 * Tests can use defaults from JSON or override for specific test needs.
 * Results are saved to results/ directory for post-hoc analysis.
 */
describe('Rebalancer Simulation', function () {
  const anvilPort = 8545;
  const anvil = setupAnvilTestSuite(this, anvilPort);

  before(async function () {
    // Ensure results directory exists
    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    // Check if scenarios exist
    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      console.log('No scenarios found. Run: pnpm generate-scenarios');
      this.skip();
    }
    console.log(`Found ${scenarios.length} scenarios: ${scenarios.join(', ')}`);
  });

  /**
   * Run a scenario using its default configuration from JSON
   */
  async function runScenarioWithDefaults(scenarioName: string) {
    const file = loadScenarioFile(scenarioName);
    const scenario = loadScenario(scenarioName);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SCENARIO: ${file.name}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  ${file.description}`);
    console.log(`  Transfers: ${scenario.transfers.length}`);
    console.log(`  Duration: ${scenario.duration}ms`);
    console.log(`  Chains: ${scenario.chains.join(', ')}`);

    // Build chain configs from scenario's chains
    const chainConfigs = file.chains.map((chainName, index) => ({
      chainName,
      domainId: 1000 + index * 1000,
    }));

    // Deploy using scenario's chains and defaults
    const deployment = await deployMultiDomainSimulation({
      anvilRpc: anvil.rpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains: chainConfigs,
      initialCollateralBalance: BigInt(file.defaultInitialCollateral),
    });

    // Build strategy config with deployed bridge addresses
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

    const rebalancer = new HyperlaneRunner();

    // Run simulation with defaults from scenario
    const engine = new SimulationEngine(deployment);
    const result = await engine.runSimulation(
      scenario,
      rebalancer,
      file.defaultBridgeConfig,
      file.defaultTiming,
      strategyConfig,
    );

    // Collect final balances
    const provider = new ethers.providers.JsonRpcProvider(anvil.rpc);
    const finalBalances: Record<string, string> = {};
    for (const [name, domain] of Object.entries(deployment.domains)) {
      const balance = await getWarpTokenBalance(
        provider,
        domain.warpToken,
        domain.collateralToken,
      );
      finalBalances[name] = ethers.utils.formatEther(balance.toString());
    }

    // Print results
    printResults(result, finalBalances, file);

    // Save results to file
    saveResults(scenarioName, file, result, finalBalances);

    return { result, file };
  }

  function printResults(
    result: any,
    finalBalances: Record<string, string>,
    file: ScenarioFile,
  ) {
    console.log(`\nRESULTS:`);
    console.log(
      `  Completion: ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} (${(result.kpis.completionRate * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Latency: avg=${result.kpis.averageLatency.toFixed(0)}ms, p50=${result.kpis.p50Latency}ms, p95=${result.kpis.p95Latency}ms`,
    );
    console.log(
      `  Rebalances: ${result.kpis.totalRebalances} (${ethers.utils.formatEther(result.kpis.rebalanceVolume.toString())} tokens)`,
    );

    console.log(`\nFinal Balances:`);
    const initialCollateral = ethers.utils.formatEther(
      file.defaultInitialCollateral,
    );
    for (const [name, balance] of Object.entries(finalBalances)) {
      const change = parseFloat(balance) - parseFloat(initialCollateral);
      const changeStr =
        change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
      console.log(`  ${name}: ${balance} (${changeStr})`);
    }
  }

  function saveResults(
    scenarioName: string,
    file: ScenarioFile,
    result: any,
    finalBalances: Record<string, string>,
  ) {
    // Convert BigInts in perChainMetrics
    const perChainMetrics: Record<string, any> = {};
    for (const [chain, metrics] of Object.entries(
      result.kpis.perChainMetrics,
    )) {
      const m = metrics as any;
      perChainMetrics[chain] = {
        initialBalance: m.initialBalance?.toString(),
        finalBalance: m.finalBalance?.toString(),
        transfersIn: m.transfersIn,
        transfersOut: m.transfersOut,
      };
    }

    const output = {
      scenario: scenarioName,
      timestamp: new Date().toISOString(),
      description: file.description,
      expectedBehavior: file.expectedBehavior,
      expectations: file.expectations,
      kpis: {
        totalTransfers: result.kpis.totalTransfers,
        completedTransfers: result.kpis.completedTransfers,
        completionRate: result.kpis.completionRate,
        averageLatency: result.kpis.averageLatency,
        p50Latency: result.kpis.p50Latency,
        p95Latency: result.kpis.p95Latency,
        p99Latency: result.kpis.p99Latency,
        totalRebalances: result.kpis.totalRebalances,
        rebalanceVolume: result.kpis.rebalanceVolume.toString(),
        perChainMetrics,
      },
      finalBalances,
      config: {
        timing: file.defaultTiming,
        initialCollateral: file.defaultInitialCollateral,
      },
    };

    const filePath = path.join(RESULTS_DIR, `${scenarioName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  }

  // ============================================================================
  // EXTREME IMBALANCE SCENARIOS
  // ============================================================================

  it('extreme-drain-chain1: should trigger rebalancing', async function () {
    const { result, file } = await runScenarioWithDefaults(
      'extreme-drain-chain1',
    );

    // Assert expectations from scenario file
    if (file.expectations.minCompletionRate) {
      expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
        file.expectations.minCompletionRate,
      );
    }
    if (file.expectations.shouldTriggerRebalancing) {
      expect(result.kpis.totalRebalances).to.be.greaterThan(0);
    }
  });

  it('extreme-accumulate-chain1: should trigger rebalancing', async function () {
    const { result, file } = await runScenarioWithDefaults(
      'extreme-accumulate-chain1',
    );

    if (file.expectations.minCompletionRate) {
      expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
        file.expectations.minCompletionRate,
      );
    }
    if (file.expectations.minRebalances) {
      expect(result.kpis.totalRebalances).to.be.greaterThanOrEqual(
        file.expectations.minRebalances,
      );
    }
  });

  it('large-unidirectional-to-chain1: large transfers', async function () {
    const { result, file } = await runScenarioWithDefaults(
      'large-unidirectional-to-chain1',
    );

    if (file.expectations.minCompletionRate) {
      expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
        file.expectations.minCompletionRate,
      );
    }
  });

  it('whale-transfers: massive single transfers', async function () {
    const { result, file } = await runScenarioWithDefaults('whale-transfers');

    if (file.expectations.minCompletionRate) {
      expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
        file.expectations.minCompletionRate,
      );
    }
  });

  // ============================================================================
  // BALANCED SCENARIOS
  // ============================================================================

  it('balanced-bidirectional: minimal rebalancing needed', async function () {
    const { result, file } = await runScenarioWithDefaults(
      'balanced-bidirectional',
    );

    if (file.expectations.minCompletionRate) {
      expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
        file.expectations.minCompletionRate,
      );
    }
  });

  // ============================================================================
  // RANDOM WITH HEADROOM - Rebalancer active but transfers not blocked
  // ============================================================================

  it('random-with-headroom: low latency with random traffic', async function () {
    const { result, file } = await runScenarioWithDefaults(
      'random-with-headroom',
    );

    // All transfers should complete with high collateral buffer
    if (file.expectations.minCompletionRate) {
      expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
        file.expectations.minCompletionRate,
      );
    }

    // Key assertion: p50 latency should be low (~200ms) since there's enough headroom
    // that transfers don't get blocked waiting for rebalancing
    expect(result.kpis.p50Latency).to.be.lessThan(500);
  });
});
