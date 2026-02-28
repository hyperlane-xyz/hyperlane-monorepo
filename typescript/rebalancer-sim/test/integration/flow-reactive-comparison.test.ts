import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

import {
  FlowReactiveComparisonRunner,
  RebalancerSimulationHarness,
  loadScenarioFile,
} from '../../src/index.js';
import type {
  ChainStrategyConfig,
  FlowReactiveComparisonReport,
  RebalancerStrategyConfig,
  SerializedStrategyConfig,
  SimulatedChainConfig,
} from '../../src/index.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';
import {
  RESULTS_DIR,
  cleanupRebalancers,
  ensureResultsDir,
} from '../utils/simulation-helpers.js';

function createFlowStrategyConfigs(
  chains: string[],
  bridgesByChain: Record<string, string>,
): RebalancerStrategyConfig[] {
  const buildConfig = (
    type: SerializedStrategyConfig['type'],
    strategyFields: (
      chain: string,
    ) => Omit<ChainStrategyConfig, 'bridge' | 'bridgeLockTime'>,
  ): RebalancerStrategyConfig => {
    const chainConfigs: RebalancerStrategyConfig['chains'] = {};

    for (const chain of chains) {
      chainConfigs[chain] = {
        ...strategyFields(chain),
        bridge: bridgesByChain[chain],
        bridgeLockTime: 500,
      };
    }

    return { type, chains: chainConfigs };
  };

  return [
    buildConfig('emaFlow', () => ({
      emaFlow: {
        alpha: '0.3',
        windowSizeMs: 5000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
      },
    })),
    buildConfig('velocityFlow', () => ({
      velocityFlow: {
        velocityMultiplier: '1.0',
        baseResponse: '0.5',
        windowSizeMs: 5000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
      },
    })),
    buildConfig('thresholdFlow', () => ({
      thresholdFlow: {
        noiseThreshold: '0.05',
        proportionalGain: '1.0',
        windowSizeMs: 5000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
      },
    })),
    buildConfig('accelerationFlow', () => ({
      accelerationFlow: {
        accelerationWeight: '0.5',
        damping: '0.1',
        windowSizeMs: 5000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
      },
    })),
  ];
}

function toSimulatedChains(chains: string[]): SimulatedChainConfig[] {
  return chains.map((chainName, index) => ({
    chainName,
    domainId: 1000 + index * 1000,
  }));
}

describe('Flow-Reactive Strategy Comparison', function () {
  this.timeout(180_000);

  const anvil = setupAnvilTestSuite(this);

  before(function () {
    ensureResultsDir();
  });

  afterEach(async function () {
    await cleanupRebalancers();
  });

  const FLOW_SCENARIOS = [
    'flow-sustained-drain',
    'flow-burst-spike',
    'flow-gradual-ramp',
    'flow-oscillating',
    'flow-whale-noise',
    'flow-idle-then-spike',
  ];

  for (const scenarioName of FLOW_SCENARIOS) {
    it(`${scenarioName}: compare 4 flow-reactive strategies`, async function () {
      const file = loadScenarioFile(scenarioName);

      const harness = new RebalancerSimulationHarness({
        anvilRpc: anvil.rpc,
        initialCollateralBalance: BigInt(file.defaultInitialCollateral),
        chains: toSimulatedChains(file.chains),
      });
      await harness.initialize();

      const deployment = harness.getDeployment();
      expect(
        deployment,
        `Deployment should exist for scenario ${scenarioName}`,
      ).to.not.equal(undefined);
      if (!deployment)
        throw new Error('Harness deployment missing after initialize');

      const bridgesByChain: Record<string, string> = {};
      for (const chainName of file.chains) {
        const domain = deployment.domains[chainName];
        expect(
          domain,
          `Deployment should include domain for chain ${chainName}`,
        ).to.not.equal(undefined);
        if (!domain)
          throw new Error(`Missing domain deployment for chain ${chainName}`);
        bridgesByChain[chainName] = domain.bridge;
      }

      const strategyConfigs = createFlowStrategyConfigs(
        file.chains,
        bridgesByChain,
      );
      const runner = new FlowReactiveComparisonRunner(harness);
      const report: FlowReactiveComparisonReport = await runner.runComparison(
        file,
        strategyConfigs,
      );

      console.log(`\n${'='.repeat(60)}`);
      console.log(`SCENARIO: ${scenarioName}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Winner: ${report.winner}`);
      console.log(`Summary: ${report.summary}`);
      for (const card of report.scorecard) {
        console.log(
          `  #${card.rank} ${card.strategyName}: ${card.completionRate.toFixed(1)}% completion, ${card.totalRebalances} rebalances`,
        );
      }

      expect(report.results).to.have.lengthOf(4);
      expect(report.scorecard).to.have.lengthOf(4);

      for (const result of report.results) {
        if (file.expectations.minCompletionRate !== undefined) {
          expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
            file.expectations.minCompletionRate,
            `${result.strategyName} should meet min completion rate for ${scenarioName}`,
          );
        }

        expect(result.duration).to.be.lessThan(
          file.duration * 5,
          `${result.strategyName} simulation should not hang`,
        );
      }

      if (file.expectations.shouldTriggerRebalancing) {
        const anyRebalanced = report.results.some(
          (result) => result.kpis.totalRebalances > 0,
        );
        expect(anyRebalanced).to.equal(
          true,
          `At least one strategy should trigger rebalancing for ${scenarioName}`,
        );
      }

      const resultPath = path.join(
        RESULTS_DIR,
        `${scenarioName}-comparison.json`,
      );
      const jsonSafeReport = {
        ...report,
        results: report.results.map((result) => ({
          ...result,
          kpis: {
            ...result.kpis,
            rebalanceVolume: result.kpis.rebalanceVolume.toString(),
            totalGasCost: result.kpis.totalGasCost.toString(),
          },
          transferRecords: result.transferRecords.length,
          rebalanceRecords: result.rebalanceRecords.length,
        })),
        scorecard: report.scorecard.map((score) => ({
          ...score,
          rebalanceVolume: score.rebalanceVolume.toString(),
        })),
      };
      fs.writeFileSync(resultPath, JSON.stringify(jsonSafeReport, null, 2));
    });
  }
});
