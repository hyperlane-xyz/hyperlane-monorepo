import { rootLogger } from '@hyperlane-xyz/utils';

import { RebalancerSimulationHarness } from './RebalancerSimulationHarness.js';
import { ProductionRebalancerRunner } from './runners/ProductionRebalancerRunner.js';
import type {
  FlowReactiveComparisonReport,
  RebalancerStrategyConfig,
  ScenarioFile,
  SimulationKPIs,
  SimulationResult,
  StrategyRunResult,
  StrategyScorecard,
  TransferScenario,
} from './types.js';

export class FlowReactiveComparisonRunner {
  private readonly logger;

  constructor(private readonly harness: RebalancerSimulationHarness) {
    this.logger = rootLogger.child({
      module: 'FlowReactiveComparisonRunner',
    });
  }

  async runComparison(
    scenario: ScenarioFile,
    strategyConfigs: RebalancerStrategyConfig[],
  ): Promise<FlowReactiveComparisonReport> {
    if (strategyConfigs.length === 0) {
      throw new Error(
        'At least one strategy config is required for comparison',
      );
    }

    if (!this.harness.getDeployment()) {
      await this.harness.initialize();
    }

    const transferScenario: TransferScenario = {
      name: scenario.name,
      duration: scenario.duration,
      chains: scenario.chains,
      transfers: scenario.transfers.map((transfer) => ({
        id: transfer.id,
        timestamp: transfer.timestamp,
        origin: transfer.origin,
        destination: transfer.destination,
        amount: BigInt(transfer.amount),
        user: transfer.user,
      })),
    };

    const results: StrategyRunResult[] = [];
    const nameCounts: Record<string, number> = {};

    for (const strategyConfig of strategyConfigs) {
      const baseName = strategyConfig.type;
      const count = (nameCounts[baseName] ?? 0) + 1;
      nameCounts[baseName] = count;
      const strategyName = count > 1 ? `${baseName}-${count}` : baseName;

      this.logger.info(
        {
          strategyName,
          strategyType: strategyConfig.type,
          scenario: scenario.name,
        },
        'Running flow-reactive strategy comparison simulation',
      );

      const scenarioWithStrategy: ScenarioFile = {
        ...scenario,
        defaultStrategyConfig:
          strategyConfig as unknown as ScenarioFile['defaultStrategyConfig'],
      };

      const simulationResult: SimulationResult =
        await this.harness.runSimulation(
          transferScenario,
          new ProductionRebalancerRunner(),
          {
            bridgeConfig: scenarioWithStrategy.defaultBridgeConfig,
            timing: scenarioWithStrategy.defaultTiming,
            strategyConfig,
          },
        );
      const kpis: SimulationKPIs = simulationResult.kpis;

      results.push({
        strategyName,
        strategyType: strategyConfig.type,
        kpis,
        transferRecords: simulationResult.transferRecords,
        rebalanceRecords: simulationResult.rebalanceRecords,
        duration: simulationResult.duration,
      });
    }

    const scorecard = this.buildScorecard(results);
    const winner = scorecard[0]?.strategyName ?? '';
    const winnerScore = scorecard[0];
    const summary = winnerScore
      ? `Winner: ${winner} with ${winnerScore.completionRate.toFixed(2)}% completion and ${winnerScore.totalRebalances} rebalances`
      : 'No winner available';

    return {
      scenarioName: scenario.name,
      scenarioDescription: scenario.description,
      results,
      scorecard,
      winner,
      summary,
    };
  }

  private buildScorecard(results: StrategyRunResult[]): StrategyScorecard[] {
    const entries = results.map((result) => {
      const completionRate = result.kpis.completionRate * 100;
      const rebalanceVolume = result.kpis.rebalanceVolume;
      const totalTransferVolume = this.computeTotalTransferVolume(result);
      const efficiency =
        totalTransferVolume === BigInt(0)
          ? 0
          : Number(rebalanceVolume) / Number(totalTransferVolume);

      return {
        strategyName: result.strategyName,
        strategyType: result.strategyType,
        rank: 0,
        completionRate,
        totalRebalances: result.kpis.totalRebalances,
        rebalanceVolume,
        averageLatency: result.kpis.averageLatency,
        efficiency,
      };
    });

    entries.sort((a, b) => {
      if (b.completionRate !== a.completionRate) {
        return b.completionRate - a.completionRate;
      }

      if (a.rebalanceVolume < b.rebalanceVolume) {
        return -1;
      }

      if (a.rebalanceVolume > b.rebalanceVolume) {
        return 1;
      }

      return 0;
    });

    return entries.map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
  }

  private computeTotalTransferVolume(result: StrategyRunResult): bigint {
    return result.transferRecords.reduce(
      (sum, record) => sum + record.amount,
      BigInt(0),
    );
  }
}
