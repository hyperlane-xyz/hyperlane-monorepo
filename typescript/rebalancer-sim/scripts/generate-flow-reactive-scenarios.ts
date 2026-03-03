#!/usr/bin/env tsx
/**
 * Generate flow-reactive scenarios to the scenarios/ directory.
 * These scenarios test flow-reactive strategies (EMA, velocity, threshold, acceleration).
 * Run with: pnpm exec tsx scripts/generate-flow-reactive-scenarios.ts
 */
import * as fs from 'fs';
import * as path from 'path';

import { toWei } from '@hyperlane-xyz/utils';

import { ScenarioGenerator } from '../src/index.js';
import type {
  ScenarioExpectations,
  ScenarioFile,
  SerializedBridgeConfig,
  SerializedStrategyConfig,
  SimulationTiming,
  TransferScenario,
} from '../src/index.js';

const SCENARIOS_DIR = path.join(import.meta.dirname, '..', 'scenarios');

// Ensure scenarios directory exists
if (!fs.existsSync(SCENARIOS_DIR)) {
  fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
}

// ============================================================================
// DEFAULT CONFIGURATIONS
// ============================================================================

const DEFAULT_CHAINS = ['chain1', 'chain2', 'chain3'];
const DEFAULT_INITIAL_COLLATERAL = toWei(100); // 100 tokens per chain

const DEFAULT_TIMING: SimulationTiming = {
  userTransferDeliveryDelay: 100, // Small delay to simulate message passing
  rebalancerPollingFrequency: 1000,
  userTransferInterval: 100,
};

function createDefaultBridgeConfig(chains: string[]): SerializedBridgeConfig {
  const config: SerializedBridgeConfig = {};
  for (const origin of chains) {
    config[origin] = {};
    for (const dest of chains) {
      if (origin !== dest) {
        config[origin][dest] = {
          deliveryDelay: 500,
          failureRate: 0,
          deliveryJitter: 100,
        };
      }
    }
  }
  return config;
}

function createDefaultFlowStrategyConfig(
  chains: string[],
): SerializedStrategyConfig {
  const chainConfigs: SerializedStrategyConfig['chains'] = {};
  for (const chain of chains) {
    chainConfigs[chain] = {
      emaFlow: {
        alpha: '0.3',
        windowSizeMs: 5000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
      },
      bridgeLockTime: 500,
    };
  }
  return {
    type: 'emaFlow',
    chains: chainConfigs,
  };
}

// ============================================================================
// SCENARIO BUILDER
// ============================================================================

interface ScenarioConfig {
  name: string;
  description: string;
  expectedBehavior: string;
  scenario: TransferScenario;
  initialCollateralPerChain?: string;
  timing?: Partial<SimulationTiming>;
  bridgeConfig?: Partial<SerializedBridgeConfig>;
  strategyConfig?: Partial<SerializedStrategyConfig>;
  expectations: ScenarioExpectations;
}

function saveScenario(config: ScenarioConfig) {
  const chains = config.scenario.chains;

  const scenarioFile: ScenarioFile = {
    name: config.name,
    description: config.description,
    expectedBehavior: config.expectedBehavior,
    duration: config.scenario.duration,
    chains,
    transfers: config.scenario.transfers.map((t) => ({
      id: t.id,
      timestamp: t.timestamp,
      origin: t.origin,
      destination: t.destination,
      amount: t.amount.toString(),
      user: t.user,
    })),
    defaultInitialCollateral:
      config.initialCollateralPerChain ?? DEFAULT_INITIAL_COLLATERAL,
    defaultTiming: { ...DEFAULT_TIMING, ...config.timing },
    defaultBridgeConfig:
      (config.bridgeConfig as SerializedBridgeConfig) ??
      createDefaultBridgeConfig(chains),
    defaultStrategyConfig:
      (config.strategyConfig as SerializedStrategyConfig) ??
      createDefaultFlowStrategyConfig(chains),
    expectations: config.expectations,
  };

  const filePath = path.join(SCENARIOS_DIR, `${config.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(scenarioFile, null, 2));
  console.log(`Saved: ${filePath}`);
  console.log(`  ${config.description}`);
  console.log(
    `  Transfers: ${config.scenario.transfers.length}, Duration: ${config.scenario.duration}ms`,
  );
}

console.log('Generating flow-reactive scenarios...\n');

// ============================================================================
// FLOW-REACTIVE SCENARIOS - Test flow-reactive strategy behaviors
// ============================================================================

saveScenario({
  name: 'flow-sustained-drain',
  description:
    'Steady continuous drain of chain1 over 15 seconds. Tests whether flow-reactive strategies detect and counteract a sustained directional flow.',
  expectedBehavior: `30 transfers all TO chain1 over 15s. Chain1 collateral drains steadily.
Flow-reactive strategies should detect the persistent negative flow signal and trigger rebalancing.
EMA should smooth the signal; Velocity should detect the constant rate; Threshold should fire once flow exceeds noise.`,
  scenario: ScenarioGenerator.sustainedDrain({
    targetChain: 'chain1',
    otherChains: ['chain2', 'chain3'],
    transferCount: 30,
    duration: 15000,
    amountRange: [BigInt(toWei(3)), BigInt(toWei(7))],
  }),
  expectations: {
    shouldTriggerRebalancing: true,
    minCompletionRate: 0.8,
  },
});

saveScenario({
  name: 'flow-burst-spike',
  description:
    'Idle period followed by sudden burst of transfers to chain2. Tests reaction speed to sudden flow changes.',
  expectedBehavior: `5s idle, then 20 transfers in 3s burst to chain2, then idle.
Velocity strategy should react fastest due to rate-of-change detection.
EMA may lag behind due to smoothing. Threshold should fire once burst exceeds noise floor.
Acceleration strategy should detect the sudden onset.`,
  scenario: ScenarioGenerator.burstSpike({
    chains: ['chain1', 'chain2', 'chain3'],
    burstStart: 5000,
    burstDuration: 3000,
    burstTransferCount: 20,
    totalDuration: 13000,
    burstTarget: 'chain2',
    amountRange: [BigInt(toWei(3)), BigInt(toWei(8))],
  }),
  expectations: {
    shouldTriggerRebalancing: true,
    minCompletionRate: 0.8,
  },
});

saveScenario({
  name: 'flow-gradual-ramp',
  description:
    'Transfer rate increases linearly from 1/s to 5/s over 15 seconds. Tests whether strategies scale response with increasing pressure.',
  expectedBehavior: `Transfers to chain3 start slow and accelerate.
Acceleration strategy should excel here - it detects the increasing rate.
EMA smoothing may underreact to the ramp. Velocity should track the increasing rate.
Threshold may fire late if initial flow is below noise floor.`,
  scenario: ScenarioGenerator.gradualRamp({
    chains: ['chain1', 'chain2', 'chain3'],
    targetChain: 'chain3',
    startRate: 1,
    endRate: 5,
    duration: 15000,
    amountRange: [BigInt(toWei(2)), BigInt(toWei(6))],
  }),
  expectations: {
    shouldTriggerRebalancing: true,
    minCompletionRate: 0.8,
  },
});

saveScenario({
  name: 'flow-oscillating',
  description:
    'Transfers alternate direction between chain1 and chain2 every 3 seconds. Tests whether strategies avoid whiplash on direction changes.',
  expectedBehavior: `Bidirectional flow oscillates every 3s for 18s total (6 oscillations).
Strategies that react too aggressively will over-rebalance and waste volume.
EMA smoothing should dampen oscillations well.
Threshold should filter out the noise if oscillation magnitude is below threshold.
Net flow over full period is roughly zero - minimal rebalancing is ideal.`,
  scenario: ScenarioGenerator.oscillatingBidirectional({
    chainA: 'chain1',
    chainB: 'chain2',
    oscillationPeriod: 3000,
    totalDuration: 18000,
    transfersPerOscillation: 6,
    amountRange: [BigInt(toWei(2)), BigInt(toWei(5))],
  }),
  expectations: {
    shouldTriggerRebalancing: false, // Net flow ~= 0, good strategies should NOT rebalance
    minCompletionRate: 0.8,
  },
});

saveScenario({
  name: 'flow-whale-noise',
  description:
    'Large whale transfers mixed with random small noise. Tests signal-to-noise filtering.',
  expectedBehavior: `3 whale transfers of 30 tokens mixed with 20 small noise transfers (0.1-1 token).
Threshold strategy should excel here - noise is below threshold, whales are above.
EMA will smooth whale signals, possibly underreacting.
Velocity should detect whale-induced rate changes.
Key test: does the strategy respond to whales while ignoring noise?`,
  scenario: ScenarioGenerator.whalePlusNoise({
    chains: ['chain1', 'chain2', 'chain3'],
    whaleAmount: BigInt(toWei(30)),
    whaleCount: 3,
    noiseCount: 20,
    duration: 15000,
    noiseAmountRange: [BigInt(toWei('0.1')), BigInt(toWei(1))],
  }),
  expectations: {
    shouldTriggerRebalancing: true,
    minCompletionRate: 0.8,
  },
});

saveScenario({
  name: 'flow-idle-then-spike',
  description:
    'Extended idle period followed by sudden burst. Tests cold-start behavior of flow-reactive strategies.',
  expectedBehavior: `10s of near-zero activity (2 tiny transfers), then sudden burst of 15 transfers in 3s.
Cold-start strategies must handle the transition from no data to sudden activity.
coldStartCycles parameter is tested here - strategies should not produce garbage signals during cold start.
After cold start, all strategies should react to the burst.`,
  scenario: ScenarioGenerator.burstSpike({
    chains: ['chain1', 'chain2', 'chain3'],
    burstStart: 10000,
    burstDuration: 3000,
    burstTransferCount: 15,
    totalDuration: 16000,
    burstTarget: 'chain1',
    amountRange: [BigInt(toWei(4)), BigInt(toWei(9))],
  }),
  expectations: {
    shouldTriggerRebalancing: true,
    minCompletionRate: 0.8,
  },
});

console.log('\nDone! Generated flow-reactive scenarios in:', SCENARIOS_DIR);
console.log('\nRun simulations with: pnpm test');
