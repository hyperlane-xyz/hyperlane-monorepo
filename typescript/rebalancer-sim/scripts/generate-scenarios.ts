#!/usr/bin/env tsx
/**
 * Generate and save scenarios to the scenarios/ directory.
 * Run with: pnpm generate-scenarios
 */
import * as fs from 'fs';
import * as path from 'path';

import { toWei } from '@hyperlane-xyz/utils';

import { ScenarioGenerator } from '../src/scenario/ScenarioGenerator.js';

const SCENARIOS_DIR = path.join(import.meta.dirname, '..', 'scenarios');

// Ensure scenarios directory exists
if (!fs.existsSync(SCENARIOS_DIR)) {
  fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
}

function saveScenario(name: string, scenario: any) {
  const serialized = ScenarioGenerator.serialize(scenario);
  const filePath = path.join(SCENARIOS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2));
  console.log(`Saved: ${filePath}`);
  console.log(`  Transfers: ${scenario.transfers.length}`);
  console.log(`  Duration: ${scenario.duration}ms`);
}

console.log('Generating scenarios...\n');

// ============================================================================
// EXTREME IMBALANCE SCENARIOS - These WILL trigger rebalancing
// ============================================================================

// Scenario 1: Extreme drain of chain1's collateral (95% inbound to chain1)
// When transfers arrive AT chain1, collateral is RELEASED to recipients, draining the pool
// Starting at 100 tokens, this will push chain1 well below the 85 token minimum
saveScenario(
  'extreme-drain-chain1',
  ScenarioGenerator.imbalanceScenario(
    ['chain1', 'chain2', 'chain3'],
    'chain1',
    20, // 20 transfers
    10000, // 10 seconds
    [BigInt(toWei(5)), BigInt(toWei(10))], // 5-10 tokens per transfer
    0.95, // 95% go TO chain1, draining its collateral
  ),
);

// Scenario 2: Extreme accumulation at chain1 (95% outbound from chain1)
// When transfers originate FROM chain1, collateral is LOCKED into the pool
// This will push chain1 well above the 115 token maximum
saveScenario(
  'extreme-accumulate-chain1',
  ScenarioGenerator.imbalanceScenario(
    ['chain1', 'chain2', 'chain3'],
    'chain1',
    20,
    10000,
    [BigInt(toWei(5)), BigInt(toWei(10))],
    0.05, // Only 5% go TO chain1, 95% go FROM chain1 (accumulates collateral)
  ),
);

// Scenario 3: Large single transfers that immediately unbalance
// Just 5 large transfers, each 20 tokens, all to chain1
const largeTransfers = ScenarioGenerator.unidirectionalFlow({
  origin: 'chain2',
  destination: 'chain1',
  transferCount: 5,
  duration: 5000,
  amount: BigInt(toWei(20)), // 20 tokens each = 100 tokens total
});
saveScenario('large-unidirectional-to-chain1', largeTransfers);

// Scenario 4: Sustained one-way flow
// 30 transfers over 30 seconds, all from chain3 to chain1
saveScenario(
  'sustained-drain-chain3',
  ScenarioGenerator.unidirectionalFlow({
    origin: 'chain3',
    destination: 'chain1',
    transferCount: 30,
    duration: 30000,
    amount: [BigInt(toWei(2)), BigInt(toWei(5))],
  }),
);

// ============================================================================
// MODERATE IMBALANCE SCENARIOS - May or may not trigger rebalancing
// ============================================================================

// Scenario 5: Moderate imbalance (70% to one chain)
saveScenario(
  'moderate-imbalance-chain1',
  ScenarioGenerator.imbalanceScenario(
    ['chain1', 'chain2', 'chain3'],
    'chain1',
    15,
    8000,
    [BigInt(toWei(2)), BigInt(toWei(6))],
    0.7,
  ),
);

// ============================================================================
// BALANCED SCENARIOS - Should NOT trigger rebalancing
// ============================================================================

// Scenario 6: Perfectly balanced bidirectional
saveScenario(
  'balanced-bidirectional',
  ScenarioGenerator.randomTraffic({
    chains: ['chain1', 'chain2', 'chain3'],
    transferCount: 20,
    duration: 10000,
    amountRange: [BigInt(toWei(1)), BigInt(toWei(3))],
    distribution: 'uniform',
  }),
);

// ============================================================================
// SURGE SCENARIOS - Test rebalancer response to traffic spikes
// ============================================================================

// Scenario 7: Surge to chain1
saveScenario(
  'surge-to-chain1',
  ScenarioGenerator.surgeScenario({
    chains: ['chain1', 'chain2', 'chain3'],
    baselineRate: 1, // 1 tx/sec baseline
    surgeMultiplier: 5, // 5x during surge
    surgeStart: 5000,
    surgeDuration: 5000,
    totalDuration: 15000,
    amountRange: [BigInt(toWei(3)), BigInt(toWei(8))],
  }),
);

// ============================================================================
// STRESS TEST SCENARIOS
// ============================================================================

// Scenario 8: High volume stress test
saveScenario(
  'stress-high-volume',
  ScenarioGenerator.randomTraffic({
    chains: ['chain1', 'chain2', 'chain3'],
    transferCount: 50,
    duration: 20000,
    amountRange: [BigInt(toWei(1)), BigInt(toWei(5))],
    distribution: 'poisson',
    poissonMeanInterval: 400, // ~2.5 tx/sec average
  }),
);

// Scenario 9: Whale transfers - few but massive
const whaleScenario = ScenarioGenerator.unidirectionalFlow({
  origin: 'chain2',
  destination: 'chain1',
  transferCount: 3,
  duration: 6000,
  amount: BigInt(toWei(30)), // 30 tokens each = 90 tokens total
});
saveScenario('whale-transfers', whaleScenario);

console.log('\nDone! Generated scenarios in:', SCENARIOS_DIR);
console.log('\nRun simulations with: RUN_ANVIL_TESTS=1 pnpm test');
