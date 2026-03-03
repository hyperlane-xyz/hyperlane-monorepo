import * as fs from 'fs';
import * as path from 'path';

import { ethers } from 'ethers';

import type { ScenarioFile, SimulationResult } from './types.js';
import { generateTimelineHtml } from './visualizer/HtmlTimelineGenerator.js';

export type SimulationComparison = {
  bestCompletionRate: string;
  bestLatency: string;
};

export type SaveSimulationResultsOptions = {
  outputDir: string;
  scenarioName: string;
  scenarioFile: ScenarioFile;
  results: SimulationResult[];
  comparison?: SimulationComparison;
};

export type SaveSimulationResultsOutput = {
  jsonPath: string;
  htmlPath: string;
};

export function saveSimulationResults(
  options: SaveSimulationResultsOptions,
): SaveSimulationResultsOutput {
  const { outputDir, scenarioName, scenarioFile, results, comparison } = options;

  fs.mkdirSync(outputDir, { recursive: true });

  const output: any = {
    scenario: scenarioName,
    timestamp: new Date().toISOString(),
    description: scenarioFile.description,
    expectedBehavior: scenarioFile.expectedBehavior,
    expectations: scenarioFile.expectations,
    results: results.map((result) => ({
      rebalancerName: result.rebalancerName,
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
      },
    })),
    config: {
      timing: scenarioFile.defaultTiming,
      initialCollateral: scenarioFile.defaultInitialCollateral,
      initialImbalance: scenarioFile.initialImbalance,
    },
  };

  if (comparison) {
    output.comparison = comparison;
  }

  const jsonPath = path.join(outputDir, `${scenarioName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  const firstOrigin = Object.keys(scenarioFile.defaultBridgeConfig)[0];
  const firstDest = firstOrigin
    ? Object.keys(scenarioFile.defaultBridgeConfig[firstOrigin])[0]
    : undefined;
  const bridgeDelay =
    firstOrigin && firstDest
      ? scenarioFile.defaultBridgeConfig[firstOrigin][firstDest].deliveryDelay
      : 0;

  const vizConfig: Record<string, any> = {
    scenarioName: scenarioFile.name,
    description: scenarioFile.description,
    expectedBehavior: scenarioFile.expectedBehavior,
    transferCount: scenarioFile.transfers.length,
    duration: scenarioFile.duration,
    bridgeDeliveryDelay: bridgeDelay,
    rebalancerPollingFrequency:
      scenarioFile.defaultTiming.rebalancerPollingFrequency,
    userTransferDelay: scenarioFile.defaultTiming.userTransferDeliveryDelay,
  };

  if (scenarioFile.defaultStrategyConfig.type === 'weighted') {
    vizConfig.targetWeights = {};
    vizConfig.tolerances = {};
    for (const [chain, chainConfig] of Object.entries(
      scenarioFile.defaultStrategyConfig.chains,
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
  for (const chain of scenarioFile.chains) {
    const base = parseFloat(
      ethers.utils.formatEther(scenarioFile.defaultInitialCollateral),
    );
    const extra = scenarioFile.initialImbalance?.[chain]
      ? parseFloat(ethers.utils.formatEther(scenarioFile.initialImbalance[chain]))
      : 0;
    vizConfig.initialCollateral[chain] = (base + extra).toString();
  }

  const html = generateTimelineHtml(
    results,
    { title: `${scenarioFile.name}: ${scenarioFile.description}` },
    vizConfig,
  );
  const htmlPath = path.join(outputDir, `${scenarioName}.html`);
  fs.writeFileSync(htmlPath, html);

  return {
    jsonPath,
    htmlPath,
  };
}
