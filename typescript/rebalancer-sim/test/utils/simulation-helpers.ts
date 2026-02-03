import { expect } from 'chai';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  NoOpRebalancer,
  ProductionRebalancerRunner,
  SimpleRunner,
  SimulationEngine,
  cleanupProductionRebalancer,
  cleanupSimpleRunner,
  deployMultiDomainSimulation,
  generateTimelineHtml,
  getWarpTokenBalance,
  loadScenario,
  loadScenarioFile,
} from '../../src/index.js';
import type {
  ChainStrategyConfig,
  IRebalancerRunner,
  ScenarioFile,
  SimulationResult,
} from '../../src/index.js';
import { ANVIL_DEPLOYER_KEY } from '../../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');

export type RebalancerType = 'simple' | 'production' | 'noop';

export function getEnabledRebalancers(): RebalancerType[] {
  const REBALANCER_ENV = process.env.REBALANCERS || 'simple,production';
  const enabled = REBALANCER_ENV.split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(
      (r): r is RebalancerType =>
        r === 'simple' || r === 'production' || r === 'noop',
    );

  if (enabled.length === 0) {
    throw new Error(
      `No valid rebalancers in REBALANCERS="${REBALANCER_ENV}". Use "simple", "production", "noop", or combinations.`,
    );
  }
  return enabled;
}

export function createRebalancer(type: RebalancerType): IRebalancerRunner {
  switch (type) {
    case 'simple':
      return new SimpleRunner();
    case 'production':
      return new ProductionRebalancerRunner();
    case 'noop':
      return new NoOpRebalancer();
  }
}

export async function cleanupRebalancers(): Promise<void> {
  await cleanupSimpleRunner();
  await cleanupProductionRebalancer();
}

export function ensureResultsDir(): void {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

export interface ScenarioRunOptions {
  anvilRpc: string;
  rebalancerTypes?: RebalancerType[];
}

export interface ScenarioRunResult {
  results: SimulationResult[];
  file: ScenarioFile;
  comparison?: {
    bestCompletionRate: string;
    bestLatency: string;
  };
}

/**
 * Run a scenario with specified rebalancers.
 * If multiple rebalancers, runs each and compares results.
 */
export async function runScenarioWithRebalancers(
  scenarioName: string,
  options: ScenarioRunOptions,
): Promise<ScenarioRunResult> {
  const rebalancerTypes = options.rebalancerTypes ?? getEnabledRebalancers();
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
    const deployment = await deployMultiDomainSimulation({
      anvilRpc: options.anvilRpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains: chainConfigs,
      initialCollateralBalance: BigInt(file.defaultInitialCollateral),
    });

    // Apply initial imbalance if specified
    if (file.initialImbalance) {
      const { ERC20Test__factory } = await import('@hyperlane-xyz/core');
      const provider = new ethers.providers.JsonRpcProvider(options.anvilRpc);
      const deployer = new ethers.Wallet(ANVIL_DEPLOYER_KEY, provider);

      for (const [chainName, extraAmount] of Object.entries(
        file.initialImbalance,
      )) {
        const domain = deployment.domains[chainName];
        if (domain) {
          const token = ERC20Test__factory.connect(
            domain.collateralToken,
            deployer,
          );
          await token.mintTo(domain.warpToken, extraAmount);
          console.log(
            `  Applied imbalance: +${ethers.utils.formatEther(extraAmount)} tokens to ${chainName}`,
          );
        }
      }
      // Cleanup provider after applying imbalance
      provider.removeAllListeners();
      provider.polling = false;
    }

    const strategyConfig: {
      type: 'weighted' | 'minAmount';
      chains: Record<string, ChainStrategyConfig>;
    } = {
      type: file.defaultStrategyConfig.type,
      chains: {},
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
    const balanceProvider = new ethers.providers.JsonRpcProvider(
      options.anvilRpc,
    );
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

export function printResults(
  result: SimulationResult,
  finalBalances: Record<string, string>,
  file: ScenarioFile,
): void {
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
    const extraFromImbalance = file.initialImbalance?.[name]
      ? parseFloat(ethers.utils.formatEther(file.initialImbalance[name]))
      : 0;
    const initialForChain = parseFloat(initialCollateral) + extraFromImbalance;
    const change = parseFloat(balance) - initialForChain;
    const changeStr = change >= 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
    console.log(`      ${name}: ${balance} (${changeStr})`);
  }
}

export function printComparison(results: SimulationResult[]): {
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
      '| ' + row.map((cell, i) => cell.padEnd(colWidths[i])).join(' | ') + ' |',
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

export function saveResults(
  scenarioName: string,
  file: ScenarioFile,
  results: SimulationResult[],
  comparison?: { bestCompletionRate: string; bestLatency: string },
): void {
  ensureResultsDir();

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
      initialImbalance: file.initialImbalance,
    },
  };

  if (comparison) {
    output.comparison = comparison;
  }

  // Save JSON results
  const jsonPath = path.join(RESULTS_DIR, `${scenarioName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  // Generate HTML timeline visualization
  const firstOrigin = Object.keys(file.defaultBridgeConfig)[0];
  const firstDest = firstOrigin
    ? Object.keys(file.defaultBridgeConfig[firstOrigin])[0]
    : undefined;
  const bridgeDelay =
    firstOrigin && firstDest
      ? file.defaultBridgeConfig[firstOrigin][firstDest].deliveryDelay
      : 0;

  const vizConfig: Record<string, any> = {
    scenarioName: file.name,
    description: file.description,
    expectedBehavior: file.expectedBehavior,
    transferCount: file.transfers.length,
    duration: file.duration,
    bridgeDeliveryDelay: bridgeDelay,
    rebalancerPollingFrequency: file.defaultTiming.rebalancerPollingFrequency,
    userTransferDelay: file.defaultTiming.userTransferDeliveryDelay,
  };

  if (file.defaultStrategyConfig.type === 'weighted') {
    vizConfig.targetWeights = {};
    vizConfig.tolerances = {};
    for (const [chain, chainConfig] of Object.entries(
      file.defaultStrategyConfig.chains,
    )) {
      if (chainConfig.weighted) {
        vizConfig.targetWeights[chain] = Math.round(
          parseFloat(chainConfig.weighted.weight) * 100,
        );
        vizConfig.tolerances[chain] = Math.round(
          parseFloat(chainConfig.weighted.tolerance) * 100,
        );
      }
    }
  }

  vizConfig.initialCollateral = {};
  for (const chain of file.chains) {
    const base = parseFloat(
      ethers.utils.formatEther(file.defaultInitialCollateral),
    );
    const extra = file.initialImbalance?.[chain]
      ? parseFloat(ethers.utils.formatEther(file.initialImbalance[chain]))
      : 0;
    vizConfig.initialCollateral[chain] = (base + extra).toString();
  }

  const html = generateTimelineHtml(
    results,
    { title: `${file.name}: ${file.description}` },
    vizConfig,
  );
  const htmlPath = path.join(RESULTS_DIR, `${scenarioName}.html`);
  fs.writeFileSync(htmlPath, html);
  console.log(`  Timeline saved to: ${htmlPath}`);
}
