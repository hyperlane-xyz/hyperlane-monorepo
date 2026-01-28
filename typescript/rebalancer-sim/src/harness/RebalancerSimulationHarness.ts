import { ethers } from 'ethers';

import type { BridgeMockConfig } from '../bridges/types.js';
import { createSymmetricBridgeConfig } from '../bridges/types.js';
import {
  deployMultiDomainSimulation,
  restoreSnapshot,
} from '../deployment/SimulationDeployment.js';
import type {
  MultiDomainDeploymentOptions,
  MultiDomainDeploymentResult,
  SimulatedChainConfig,
} from '../deployment/types.js';
import {
  ANVIL_DEPLOYER_KEY,
  DEFAULT_SIMULATED_CHAINS,
} from '../deployment/types.js';
import {
  DEFAULT_TIMING,
  SimulationEngine,
} from '../engine/SimulationEngine.js';
import type { ComparisonReport, SimulationResult } from '../kpi/types.js';
import { cleanupRealRebalancer } from '../rebalancer/RealRebalancerRunner.js';
import type {
  IRebalancerRunner,
  RebalancerSimConfig,
} from '../rebalancer/types.js';
import type { SimulationTiming, TransferScenario } from '../scenario/types.js';

/**
 * Configuration for the simulation harness
 */
export interface HarnessConfig {
  /** Chain configurations */
  chains?: SimulatedChainConfig[];
  /** Anvil RPC URL */
  anvilRpc?: string;
  /** Deployer private key */
  deployerKey?: string;
  /** Initial collateral balance per chain (in wei) */
  initialCollateralBalance?: bigint;
  /** Token decimals */
  tokenDecimals?: number;
}

/**
 * Default harness configuration
 */
export const DEFAULT_HARNESS_CONFIG: Required<HarnessConfig> = {
  chains: DEFAULT_SIMULATED_CHAINS,
  anvilRpc: 'http://localhost:8545',
  deployerKey: ANVIL_DEPLOYER_KEY,
  initialCollateralBalance: BigInt('100000000000000000000'), // 100 tokens
  tokenDecimals: 18,
};

/**
 * RebalancerSimulationHarness is the main entry point for running
 * rebalancer simulations. It manages deployment, scenario execution,
 * and result collection.
 */
export class RebalancerSimulationHarness {
  private deployment?: MultiDomainDeploymentResult;
  private engine?: SimulationEngine;
  private config: Required<HarnessConfig>;

  constructor(config: HarnessConfig = {}) {
    this.config = {
      ...DEFAULT_HARNESS_CONFIG,
      ...config,
    };
  }

  /**
   * Initialize the harness by deploying the simulation environment
   */
  async initialize(): Promise<void> {
    const deployOptions: MultiDomainDeploymentOptions = {
      anvilRpc: this.config.anvilRpc,
      deployerKey: this.config.deployerKey,
      chains: this.config.chains,
      initialCollateralBalance: this.config.initialCollateralBalance,
      tokenDecimals: this.config.tokenDecimals,
    };

    console.log('Deploying multi-domain simulation environment...');
    this.deployment = await deployMultiDomainSimulation(deployOptions);
    console.log('Deployment complete.');

    // Log deployed addresses
    for (const [chainName, domain] of Object.entries(this.deployment.domains)) {
      console.log(`  ${chainName} (domain ${domain.domainId}):`);
      console.log(`    Mailbox: ${domain.mailbox}`);
      console.log(`    WarpToken: ${domain.warpToken}`);
      console.log(`    CollateralToken: ${domain.collateralToken}`);
      console.log(`    Bridge: ${domain.bridge}`);
    }

    this.engine = new SimulationEngine(this.deployment);
  }

  /**
   * Run a simulation with the given scenario and rebalancer
   */
  async runSimulation(
    scenario: TransferScenario,
    rebalancer: IRebalancerRunner,
    options: {
      bridgeConfig?: BridgeMockConfig;
      timing?: SimulationTiming;
      strategyConfig: RebalancerSimConfig['strategyConfig'];
    },
  ): Promise<SimulationResult> {
    if (!this.deployment || !this.engine) {
      throw new Error('Harness not initialized. Call initialize() first.');
    }

    const bridgeConfig =
      options.bridgeConfig ??
      createSymmetricBridgeConfig(this.config.chains.map((c) => c.chainName));

    const timing = options.timing ?? DEFAULT_TIMING;

    console.log(`Running simulation: ${scenario.name}`);
    console.log(`  Rebalancer: ${rebalancer.name}`);
    console.log(`  Transfers: ${scenario.transfers.length}`);
    console.log(`  Duration: ${scenario.duration}ms`);

    const result = await this.engine.runSimulation(
      scenario,
      rebalancer,
      bridgeConfig,
      timing,
      options.strategyConfig,
    );

    console.log(`Simulation complete.`);
    console.log(
      `  Completion rate: ${(result.kpis.completionRate * 100).toFixed(1)}%`,
    );
    console.log(
      `  Average latency: ${result.kpis.averageLatency.toFixed(0)}ms`,
    );
    console.log(`  Total rebalances: ${result.kpis.totalRebalances}`);

    return result;
  }

  /**
   * Compare multiple rebalancers on the same scenario
   */
  async compareRebalancers(
    scenario: TransferScenario,
    rebalancers: IRebalancerRunner[],
    options: {
      bridgeConfig?: BridgeMockConfig;
      timing?: SimulationTiming;
      strategyConfig: RebalancerSimConfig['strategyConfig'];
    },
  ): Promise<ComparisonReport> {
    if (!this.deployment || !this.engine) {
      throw new Error('Harness not initialized. Call initialize() first.');
    }

    const results: SimulationResult[] = [];
    const provider = new ethers.providers.JsonRpcProvider(this.config.anvilRpc);
    // Disable automatic polling to reduce RPC contention
    provider.polling = false;

    for (const rebalancer of rebalancers) {
      // Reset state before each run
      await restoreSnapshot(provider, this.deployment.snapshotId);

      // Create fresh snapshot for this run
      const newSnapshotId = await provider.send('evm_snapshot', []);
      this.deployment.snapshotId = newSnapshotId;

      // Small delay after snapshot restore to let anvil stabilize
      // This helps prevent race conditions with cached nonce/block data
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Run simulation
      const result = await this.runSimulation(scenario, rebalancer, options);
      results.push(result);

      // Cleanup between runs to ensure fresh state
      await cleanupRealRebalancer();
    }

    // Generate comparison
    const comparison = this.generateComparison(results);

    return {
      scenarioName: scenario.name,
      results,
      comparison,
    };
  }

  /**
   * Generate comparison metrics from results
   */
  private generateComparison(
    results: SimulationResult[],
  ): ComparisonReport['comparison'] {
    let bestCompletionRate = '';
    let bestLatency = '';
    let lowestGasCost = '';

    let maxCompletionRate = -1;
    let minLatency = Infinity;
    let minGasCost = BigInt('0xffffffffffffffffffffffffffffffff');

    for (const result of results) {
      if (result.kpis.completionRate > maxCompletionRate) {
        maxCompletionRate = result.kpis.completionRate;
        bestCompletionRate = result.rebalancerName;
      }

      if (result.kpis.averageLatency < minLatency) {
        minLatency = result.kpis.averageLatency;
        bestLatency = result.rebalancerName;
      }

      if (result.kpis.totalGasCost < minGasCost) {
        minGasCost = result.kpis.totalGasCost;
        lowestGasCost = result.rebalancerName;
      }
    }

    return {
      bestCompletionRate,
      bestLatency,
      lowestGasCost,
    };
  }

  /**
   * Get the deployment info
   */
  getDeployment(): MultiDomainDeploymentResult | undefined {
    return this.deployment;
  }

  /**
   * Reset the simulation state
   */
  async reset(): Promise<void> {
    if (this.deployment) {
      const provider = new ethers.providers.JsonRpcProvider(
        this.config.anvilRpc,
      );
      // Disable automatic polling
      provider.polling = false;
      await restoreSnapshot(provider, this.deployment.snapshotId);
    }
  }

  /**
   * Generate a markdown report from simulation results
   */
  static generateMarkdownReport(result: SimulationResult): string {
    const lines: string[] = [
      `# Simulation Report: ${result.scenarioName}`,
      '',
      `**Rebalancer:** ${result.rebalancerName}`,
      `**Duration:** ${result.duration}ms`,
      '',
      '## KPIs',
      '',
      '| Metric | Value |',
      '|--------|-------|',
      `| Total Transfers | ${result.kpis.totalTransfers} |`,
      `| Completed Transfers | ${result.kpis.completedTransfers} |`,
      `| Failed Transfers | ${result.kpis.failedTransfers} |`,
      `| Completion Rate | ${(result.kpis.completionRate * 100).toFixed(1)}% |`,
      `| Average Latency | ${result.kpis.averageLatency.toFixed(0)}ms |`,
      `| P50 Latency | ${result.kpis.p50Latency}ms |`,
      `| P95 Latency | ${result.kpis.p95Latency}ms |`,
      `| P99 Latency | ${result.kpis.p99Latency}ms |`,
      `| Total Rebalances | ${result.kpis.totalRebalances} |`,
      `| Rebalance Volume | ${result.kpis.rebalanceVolume.toString()} |`,
      `| Total Gas Cost | ${result.kpis.totalGasCost.toString()} |`,
      '',
      '## Per-Chain Metrics',
      '',
      '| Chain | Initial | Final | Transfers In | Transfers Out | Rebalances In | Rebalances Out |',
      '|-------|---------|-------|--------------|---------------|---------------|----------------|',
    ];

    for (const metrics of Object.values(result.kpis.perChainMetrics)) {
      lines.push(
        `| ${metrics.chainName} | ${metrics.initialBalance.toString()} | ${metrics.finalBalance.toString()} | ${metrics.transfersIn} | ${metrics.transfersOut} | ${metrics.rebalancesIn} | ${metrics.rebalancesOut} |`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Generate a markdown comparison report
   */
  static generateComparisonReport(report: ComparisonReport): string {
    const lines: string[] = [
      `# Comparison Report: ${report.scenarioName}`,
      '',
      '## Summary',
      '',
      `- **Best Completion Rate:** ${report.comparison.bestCompletionRate}`,
      `- **Best Latency:** ${report.comparison.bestLatency}`,
      `- **Lowest Gas Cost:** ${report.comparison.lowestGasCost}`,
      '',
      '## Results by Rebalancer',
      '',
    ];

    for (const result of report.results) {
      lines.push(`### ${result.rebalancerName}`);
      lines.push('');
      lines.push(
        `- Completion Rate: ${(result.kpis.completionRate * 100).toFixed(1)}%`,
      );
      lines.push(
        `- Average Latency: ${result.kpis.averageLatency.toFixed(0)}ms`,
      );
      lines.push(`- Total Rebalances: ${result.kpis.totalRebalances}`);
      lines.push(`- Gas Cost: ${result.kpis.totalGasCost.toString()}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
