#!/usr/bin/env tsx
/**
 * Generate and save scenarios to the scenarios/ directory.
 * Run with: pnpm generate-scenarios
 */
import * as fs from 'fs';
import * as path from 'path';

import { toWei } from '@hyperlane-xyz/utils';

import { ScenarioGenerator } from '../src/scenario/ScenarioGenerator.js';
import type {
  ScenarioExpectations,
  ScenarioFile,
  SerializedBridgeConfig,
  SerializedStrategyConfig,
  SimulationTiming,
  TransferScenario,
} from '../src/scenario/types.js';

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

function createDefaultStrategyConfig(
  chains: string[],
): SerializedStrategyConfig {
  const weight = (1 / chains.length).toFixed(3);
  const chainConfigs: SerializedStrategyConfig['chains'] = {};

  for (const chain of chains) {
    chainConfigs[chain] = {
      weighted: {
        weight,
        tolerance: '0.15', // 15% tolerance
      },
      bridgeLockTime: 500,
    };
  }

  return {
    type: 'weighted',
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
      createDefaultStrategyConfig(chains),
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

console.log('Generating scenarios...\n');

// ============================================================================
// EXTREME IMBALANCE SCENARIOS - These WILL trigger rebalancing
// ============================================================================

saveScenario({
  name: 'extreme-drain-chain1',
  description:
    'Tests rebalancer response when one chain is rapidly drained by incoming transfers.',
  expectedBehavior: `95% of transfers go TO chain1, draining its collateral as recipients withdraw.
Chain1 drops from 100 to potentially negative without rebalancer.
Rebalancer should detect chain1 < 85 threshold and send tokens FROM chain2/chain3.
Completion rate should stay >90% due to rebalancing replenishing liquidity.`,
  scenario: ScenarioGenerator.imbalanceScenario(
    DEFAULT_CHAINS,
    'chain1',
    20,
    10000,
    [BigInt(toWei(5)), BigInt(toWei(10))],
    0.95,
  ),
  expectations: {
    minCompletionRate: 0.9,
    shouldTriggerRebalancing: true,
  },
});

saveScenario({
  name: 'extreme-accumulate-chain1',
  description:
    'Tests rebalancer response when one chain accumulates excess liquidity from outgoing transfers.',
  expectedBehavior: `95% of transfers originate FROM chain1, causing users to deposit collateral there.
Chain1 rises to ~250 tokens (well above 115 threshold).
Chain2/chain3 get drained as recipients withdraw there.
Lower completion expected (~60%) because destination chains may run dry before rebalancer can help.
Rebalancer should still respond by moving excess from chain1.`,
  scenario: ScenarioGenerator.imbalanceScenario(
    DEFAULT_CHAINS,
    'chain1',
    20,
    10000,
    [BigInt(toWei(5)), BigInt(toWei(10))],
    0.05,
  ),
  expectations: {
    minCompletionRate: 0.6,
    minRebalances: 1,
    shouldTriggerRebalancing: true,
  },
});

saveScenario({
  name: 'large-unidirectional-to-chain1',
  description:
    'Tests rebalancer response to large individual transfers creating immediate imbalance.',
  expectedBehavior: `5 transfers of 20 tokens each, all chain2 → chain1.
Each transfer is 20% of initial balance - immediate liquidity crisis.
First 1-2 transfers succeed, then chain1 drops to ~60 tokens (below 85 threshold).
Rebalancer must respond quickly to refill chain1 for remaining transfers.
High completion rate expected if rebalancer is fast enough.`,
  scenario: ScenarioGenerator.unidirectionalFlow({
    origin: 'chain2',
    destination: 'chain1',
    transferCount: 5,
    duration: 5000,
    amount: BigInt(toWei(20)),
  }),
  expectations: {
    minCompletionRate: 0.9,
    shouldTriggerRebalancing: true,
  },
});

saveScenario({
  name: 'whale-transfers',
  description:
    'Stress tests rebalancer response time with massive single transfers that exhaust liquidity.',
  expectedBehavior: `3 transfers of 60 tokens each arriving in quick burst (first 500ms).
Total outflow: 180 tokens, but chain1 only has 100.
Transfer 1: 100 → 40 remaining (succeeds immediately)
Transfer 2: 40 - 60 = -20 → BLOCKED waiting for rebalancing
Transfer 3: Also blocked until liquidity restored.
Rebalancer must replenish chain1 before transfers 2 & 3 can complete.
High latency expected for transfers 2 & 3 as they wait for rebalancing.`,
  scenario: {
    name: 'whale-transfers',
    duration: 10000, // Long duration to allow rebalancing
    chains: ['chain2', 'chain1'],
    // Burst of 3 transfers in first 500ms
    transfers: [
      {
        id: 'whale-1',
        timestamp: 0,
        origin: 'chain2',
        destination: 'chain1',
        amount: BigInt(toWei(60)),
        user: '0x1111111111111111111111111111111111111111',
      },
      {
        id: 'whale-2',
        timestamp: 200,
        origin: 'chain2',
        destination: 'chain1',
        amount: BigInt(toWei(60)),
        user: '0x2222222222222222222222222222222222222222',
      },
      {
        id: 'whale-3',
        timestamp: 400,
        origin: 'chain2',
        destination: 'chain1',
        amount: BigInt(toWei(60)),
        user: '0x3333333333333333333333333333333333333333',
      },
    ],
  },
  expectations: {
    minCompletionRate: 0.9,
    shouldTriggerRebalancing: true,
  },
});

// ============================================================================
// BALANCED SCENARIOS - Should NOT trigger excessive rebalancing
// ============================================================================

saveScenario({
  name: 'balanced-bidirectional',
  description:
    'Verifies that balanced traffic does NOT trigger unnecessary rebalancing.',
  expectedBehavior: `10 balanced pairs (20 transfers total) where each A→B has a matching B→A.
Net flow per chain is zero - no liquidity imbalance should occur.
All chains should stay at exactly 100 tokens (within rounding).
Rebalancer should NOT trigger at all since flows are perfectly balanced.
This is the "happy path" - balanced traffic needs no intervention.
All transfers should complete quickly with low latency (~100ms delivery delay).`,
  scenario: ScenarioGenerator.balancedTraffic({
    chains: DEFAULT_CHAINS,
    pairCount: 10, // 10 pairs = 20 transfers
    duration: 10000,
    amountRange: [BigInt(toWei(1)), BigInt(toWei(3))],
  }),
  expectations: {
    minCompletionRate: 0.95,
    shouldTriggerRebalancing: false,
  },
});

// ============================================================================
// RANDOM TRAFFIC WITH HEADROOM - Rebalancer active but transfers not blocked
// ============================================================================

saveScenario({
  name: 'random-with-headroom',
  description:
    'Random traffic with enough collateral that rebalancer can keep up without blocking transfers.',
  expectedBehavior: `20 truly random transfers (not balanced pairs).
High collateral (500 tokens) provides large buffer for fluctuations.
Transfers (2-8 tokens = 0.4-1.6% of balance) create small relative imbalances.
5% tolerance triggers rebalancing on ~25 token imbalances.
With 500 tokens, even 50 token imbalance leaves 450+ liquidity.
Expected: ~200ms latency, some rebalances, 100% completion.
Key insight: enough headroom + moderate tolerance = rebalancer active but no blocking.`,
  scenario: ScenarioGenerator.randomTraffic({
    chains: DEFAULT_CHAINS,
    transferCount: 20,
    duration: 10000,
    amountRange: [BigInt(toWei(2)), BigInt(toWei(8))],
    distribution: 'uniform',
  }),
  initialCollateralPerChain: toWei(500), // 5x normal - large buffer
  strategyConfig: {
    type: 'weighted',
    chains: {
      chain1: {
        weighted: { weight: '0.333', tolerance: '0.05' },
        bridgeLockTime: 500,
      },
      chain2: {
        weighted: { weight: '0.333', tolerance: '0.05' },
        bridgeLockTime: 500,
      },
      chain3: {
        weighted: { weight: '0.333', tolerance: '0.05' },
        bridgeLockTime: 500,
      },
    },
  },
  expectations: {
    minCompletionRate: 0.95,
    // With high collateral + 5% tolerance, rebalancer may or may not trigger
    // depending on random traffic pattern - that's fine, key is low latency
  },
});

// ============================================================================
// SURGE SCENARIOS - Test rebalancer response to traffic spikes
// ============================================================================

saveScenario({
  name: 'surge-to-chain1',
  description: 'Tests rebalancer handling of sudden traffic spikes.',
  expectedBehavior: `Baseline: 1 tx/sec random traffic.
Surge: 5x traffic (5 tx/sec) from 5-10 seconds.
Surge period creates rapid imbalance that baseline wouldn't.
Rebalancer must detect and respond to burst, then stabilize.
Tests adaptive response to changing traffic patterns.`,
  scenario: ScenarioGenerator.surgeScenario({
    chains: DEFAULT_CHAINS,
    baselineRate: 1,
    surgeMultiplier: 5,
    surgeStart: 5000,
    surgeDuration: 5000,
    totalDuration: 15000,
    amountRange: [BigInt(toWei(3)), BigInt(toWei(8))],
  }),
  expectations: {
    minCompletionRate: 0.8,
    shouldTriggerRebalancing: true,
  },
});

// ============================================================================
// STRESS TEST SCENARIOS
// ============================================================================

saveScenario({
  name: 'stress-high-volume',
  description: 'Load tests the simulation with high transfer volume.',
  expectedBehavior: `50 transfers over 20 seconds with Poisson distribution (~2.5 tx/sec average).
Random origin/destination creates unpredictable imbalances.
Tests rebalancer stability under sustained load.
Poisson distribution creates realistic bursty traffic patterns.`,
  scenario: ScenarioGenerator.randomTraffic({
    chains: DEFAULT_CHAINS,
    transferCount: 50,
    duration: 20000,
    amountRange: [BigInt(toWei(1)), BigInt(toWei(5))],
    distribution: 'poisson',
    poissonMeanInterval: 400,
  }),
  expectations: {
    minCompletionRate: 0.85,
  },
});

// ============================================================================
// MODERATE SCENARIOS
// ============================================================================

saveScenario({
  name: 'moderate-imbalance-chain1',
  description: 'Tests rebalancer with moderate (not extreme) imbalance.',
  expectedBehavior: `70% of transfers go TO chain1 (moderate drain).
Should trigger rebalancing but less aggressively than extreme scenarios.
Tests that rebalancer responds proportionally to imbalance severity.`,
  scenario: ScenarioGenerator.imbalanceScenario(
    DEFAULT_CHAINS,
    'chain1',
    15,
    8000,
    [BigInt(toWei(2)), BigInt(toWei(6))],
    0.7,
  ),
  expectations: {
    minCompletionRate: 0.85,
    shouldTriggerRebalancing: true,
  },
});

saveScenario({
  name: 'sustained-drain-chain3',
  description:
    'Tests rebalancer under sustained one-way flow over longer duration.',
  expectedBehavior: `30 transfers over 30 seconds, all chain3 → chain1.
Sustained pressure rather than burst - tests rebalancer endurance.
Chain1 continuously drained, chain3 continuously accumulates.
Rebalancer must keep up with ongoing imbalance, not just react once.`,
  scenario: ScenarioGenerator.unidirectionalFlow({
    origin: 'chain3',
    destination: 'chain1',
    transferCount: 30,
    duration: 30000,
    amount: [BigInt(toWei(2)), BigInt(toWei(5))],
  }),
  expectations: {
    minCompletionRate: 0.85,
    shouldTriggerRebalancing: true,
  },
});

console.log('\nDone! Generated scenarios in:', SCENARIOS_DIR);
console.log('\nRun simulations with: pnpm test');
