#!/usr/bin/env npx tsx
/**
 * Standalone Simulation Runner
 *
 * Run rebalancer simulations from the command line without using the CLI.
 *
 * Usage:
 *   npx tsx run-simulation.ts [options]
 *
 * Examples:
 *   # Run chaos simulation with NoOp strategy
 *   npx tsx run-simulation.ts --mode chaos --duration 1h
 *
 *   # Run with a config file
 *   npx tsx run-simulation.ts --config ./my-simulation.json
 *
 *   # Backtest against historical data (requires Explorer API access)
 *   npx tsx run-simulation.ts --mode backtest --start 2024-01-01 --end 2024-01-31
 */
import { toWei } from '@hyperlane-xyz/utils';
import type { Address } from '@hyperlane-xyz/utils';

import {
  BRIDGE_PRESETS,
  ChaosTrafficGenerator,
  HistoricalTrafficReplay,
  NoOpStrategy,
  SimpleThresholdStrategy,
  SimulationEngine,
  type SimulationResults,
  type TrafficSource,
  createStrategy,
} from './index.js';

// ============================================================================
// Configuration Types
// ============================================================================

interface SimulationRunnerConfig {
  mode: 'chaos' | 'backtest';

  // Chaos mode config
  chaos?: {
    chains: string[];
    transfersPerMinute: number;
    minAmount: string; // e.g., "1000" for $1000
    maxAmount: string;
    distribution: 'uniform' | 'pareto' | 'bimodal';
    burstProbability?: number;
  };

  // Backtest mode config
  backtest?: {
    explorerApiUrl?: string;
    routersByChain: Record<string, string>;
    domainsByChain: Record<string, number>;
    startTime: string; // ISO date
    endTime: string;
    speedMultiplier?: number;
  };

  // Common config
  simulation: {
    durationMs: number;
    tickIntervalMs: number;
    rebalancerIntervalMs: number;
  };

  // Initial balances
  initialBalances: Record<string, string>; // chain -> amount in tokens

  // Bridge configs (optional, defaults to fast bridges)
  bridges?: Record<string, typeof BRIDGE_PRESETS.fast>;

  // Strategy config
  strategy:
    | { type: 'noop' }
    | {
        type: 'threshold';
        minBalance: string;
        targetBalance: string;
      }
    | { type: 'custom' /* custom strategies loaded separately */ };

  // Cost config
  gasPrices?: Record<string, string>; // chain -> gas price in gwei
  ethPriceUsd?: number;
  tokenPriceUsd?: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CHAINS = ['ethereum', 'arbitrum', 'optimism'];

const DEFAULT_BRIDGE_ADDRESSES: Record<string, Address> = {
  'ethereum-arbitrum': '0x1111111111111111111111111111111111111111',
  'ethereum-optimism': '0x2222222222222222222222222222222222222222',
  'arbitrum-ethereum': '0x3333333333333333333333333333333333333333',
  'arbitrum-optimism': '0x4444444444444444444444444444444444444444',
  'optimism-ethereum': '0x5555555555555555555555555555555555555555',
  'optimism-arbitrum': '0x6666666666666666666666666666666666666666',
};

function createDefaultBridgeConfigs(chains: string[]) {
  const configs: Record<string, typeof BRIDGE_PRESETS.fast> = {};
  for (const origin of chains) {
    for (const dest of chains) {
      if (origin !== dest) {
        configs[`${origin}-${dest}`] = BRIDGE_PRESETS.fast;
      }
    }
  }
  return configs;
}

// ============================================================================
// Result Formatting
// ============================================================================

function formatResults(name: string, results: SimulationResults): string {
  return `
============================================================
${name}
============================================================
Transfers: ${results.transfers.completed}/${results.transfers.total} completed, ${results.transfers.stuck} stuck
Latency: p50=${Math.round(results.transfers.latency.p50 / 1000)}s, p95=${Math.round(results.transfers.latency.p95 / 1000)}s
Wait time: ${results.transfers.collateralWaitTime.affectedPercent.toFixed(1)}% affected, avg=${Math.round(results.transfers.collateralWaitTime.mean / 1000)}s
Rebalances: ${results.rebalancing.completed} completed, cost=$${results.rebalancing.cost.totalUsd.toFixed(2)}

Scores:
  - Availability: ${results.scores.availability.toFixed(1)}
  - Latency: ${results.scores.latency.toFixed(1)}
  - Cost Efficiency: ${results.scores.costEfficiency.toFixed(1)}
  - Overall: ${results.scores.overall.toFixed(1)}
`;
}

// ============================================================================
// Main Runner
// ============================================================================

async function runSimulation(
  config: SimulationRunnerConfig,
): Promise<SimulationResults> {
  const chains = config.chaos?.chains || DEFAULT_CHAINS;

  // Create traffic source
  let trafficSource: TrafficSource;

  if (config.mode === 'chaos') {
    const chaosConfig = config.chaos || {
      chains,
      transfersPerMinute: 10,
      minAmount: '1000',
      maxAmount: '50000',
      distribution: 'pareto' as const,
    };

    trafficSource = new ChaosTrafficGenerator(
      {
        chains: chaosConfig.chains,
        collateralChains: chaosConfig.chains,
        transfersPerMinute: chaosConfig.transfersPerMinute,
        burstProbability: chaosConfig.burstProbability,
        amountDistribution: {
          min: BigInt(toWei(chaosConfig.minAmount)),
          max: BigInt(toWei(chaosConfig.maxAmount)),
          distribution: chaosConfig.distribution,
        },
        seed: Date.now(),
      },
      config.simulation.durationMs,
    );
  } else if (config.mode === 'backtest') {
    if (!config.backtest) {
      throw new Error('Backtest mode requires backtest config');
    }

    const replay = new HistoricalTrafficReplay({
      explorerApiUrl: config.backtest.explorerApiUrl,
      routersByChain: config.backtest.routersByChain as Record<string, Address>,
      domainsByChain: config.backtest.domainsByChain,
      startTime: new Date(config.backtest.startTime),
      endTime: new Date(config.backtest.endTime),
      speedMultiplier: config.backtest.speedMultiplier,
    });

    await replay.load();
    trafficSource = replay;

    console.log(
      `Loaded ${replay.getTotalTransferCount()} historical transfers`,
    );
  } else {
    throw new Error(`Unknown mode: ${config.mode}`);
  }

  // Create strategy
  let strategy;
  if (config.strategy.type === 'noop') {
    strategy = new NoOpStrategy();
  } else if (config.strategy.type === 'threshold') {
    strategy = new SimpleThresholdStrategy(
      chains,
      BigInt(toWei(config.strategy.minBalance)),
      BigInt(toWei(config.strategy.targetBalance)),
      DEFAULT_BRIDGE_ADDRESSES,
    );
  } else {
    throw new Error('Custom strategies must be loaded separately');
  }

  // Parse initial balances
  const initialBalances: Record<string, bigint> = {};
  for (const [chain, amount] of Object.entries(config.initialBalances)) {
    initialBalances[chain] = BigInt(toWei(amount));
  }

  // Parse gas prices
  const gasPrices: Record<string, bigint> = {};
  if (config.gasPrices) {
    for (const [chain, gwei] of Object.entries(config.gasPrices)) {
      gasPrices[chain] = BigInt(parseFloat(gwei) * 1e9);
    }
  } else {
    // Defaults
    gasPrices.ethereum = 30_000_000_000n; // 30 gwei
    gasPrices.arbitrum = 100_000_000n; // 0.1 gwei
    gasPrices.optimism = 100_000_000n; // 0.1 gwei
  }

  // Create simulation engine
  const engine = new SimulationEngine(
    {
      initialBalances,
      bridges: config.bridges || createDefaultBridgeConfigs(chains),
      warpTransferLatencyMs: 60_000, // 1 min
      gasPrices,
      ethPriceUsd: config.ethPriceUsd || 2000,
      tokenPriceUsd: config.tokenPriceUsd || 1, // Stablecoin
      transferTimeoutMs: 10 * 60 * 1000, // 10 min
    },
    Date.now(),
  );

  // Run simulation
  const results = await engine.run({
    trafficSource,
    rebalancer: strategy,
    durationMs: config.simulation.durationMs,
    tickIntervalMs: config.simulation.tickIntervalMs,
    rebalancerIntervalMs: config.simulation.rebalancerIntervalMs,
  });

  return results;
}

// ============================================================================
// CLI Parsing (simple, no external deps)
// ============================================================================

function parseArgs(): SimulationRunnerConfig {
  const args = process.argv.slice(2);
  const getArg = (name: string, defaultValue?: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    if (index !== -1 && args[index + 1]) {
      return args[index + 1];
    }
    return defaultValue;
  };

  const mode = (getArg('mode', 'chaos') as 'chaos' | 'backtest') || 'chaos';
  const durationStr = getArg('duration', '10m') || '10m';

  // Parse duration string (e.g., "1h", "30m", "1h30m")
  let durationMs = 10 * 60 * 1000; // default 10 min
  const hourMatch = durationStr.match(/(\d+)h/);
  const minMatch = durationStr.match(/(\d+)m/);
  if (hourMatch) durationMs = parseInt(hourMatch[1]) * 60 * 60 * 1000;
  if (minMatch) durationMs += parseInt(minMatch[1]) * 60 * 1000;

  return {
    mode,
    chaos: {
      chains: DEFAULT_CHAINS,
      transfersPerMinute: parseInt(getArg('tpm', '10') || '10'),
      minAmount: getArg('min-amount', '1000') || '1000',
      maxAmount: getArg('max-amount', '50000') || '50000',
      distribution:
        (getArg('distribution', 'pareto') as
          | 'uniform'
          | 'pareto'
          | 'bimodal') || 'pareto',
    },
    simulation: {
      durationMs,
      tickIntervalMs: 1000,
      rebalancerIntervalMs: 10_000,
    },
    initialBalances: {
      ethereum: getArg('balance-ethereum', '1000000') || '1000000',
      arbitrum: getArg('balance-arbitrum', '500000') || '500000',
      optimism: getArg('balance-optimism', '500000') || '500000',
    },
    strategy: {
      type: (getArg('strategy', 'noop') as 'noop' | 'threshold') || 'noop',
      minBalance: getArg('min-balance', '100000') || '100000',
      targetBalance: getArg('target-balance', '300000') || '300000',
    },
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  console.log('Rebalancer Simulation Runner\n');

  const config = parseArgs();

  console.log('Configuration:');
  console.log(`  Mode: ${config.mode}`);
  console.log(
    `  Duration: ${config.simulation.durationMs / 1000 / 60} minutes`,
  );
  console.log(`  Strategy: ${config.strategy.type}`);
  console.log('');

  try {
    const results = await runSimulation(config);
    console.log(formatResults('Simulation Results', results));

    // Output JSON for machine parsing
    if (process.argv.includes('--json')) {
      console.log('\nJSON Output:');
      console.log(
        JSON.stringify(
          results,
          (_, v) => (typeof v === 'bigint' ? v.toString() : v),
          2,
        ),
      );
    }
  } catch (error) {
    console.error('Simulation failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
main().catch(console.error);

// Export for programmatic use
export { runSimulation, formatResults, type SimulationRunnerConfig };
