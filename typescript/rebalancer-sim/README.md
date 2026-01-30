# Rebalancer Simulation Harness

A fast, real-time simulation framework for testing Hyperlane warp route rebalancers against synthetic transfer scenarios.

## Purpose

This simulator helps answer questions like:

- Does the rebalancer respond correctly to liquidity imbalances?
- How quickly does the rebalancer restore balance after a traffic surge?
- What happens when bridge delays cause the rebalancer to over-correct?
- How do different rebalancer strategies compare on the same traffic pattern?

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SimulationEngine                             │
│  Orchestrates scenario execution, rebalancer polling, KPI collection│
└─────────────────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌────────────────┐   ┌─────────────────┐
│   Scenario    │   │  Rebalancer    │   │ BridgeMock      │
│   Generator   │   │  Runners       │   │ Controller      │
│               │   │                │   │                 │
│ Creates       │   │ SimpleRunner   │   │ Simulates slow  │
│ transfer      │   │ (simplified)   │   │ bridge delivery │
│ patterns      │   │ Production     │   │ with config-    │
│               │   │ Rebalancer     │   │ urable delays   │
└───────────────┘   └────────────────┘   └─────────────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
              ┌─────────────────────────────┐
              │   Multi-Domain Deployment   │
              │                             │
              │  Single Anvil instance      │
              │  simulating N "chains"      │
              │  via different domain IDs   │
              │                             │
              │  Each domain has:           │
              │  - Mailbox (instant)        │
              │  - WarpToken + Collateral   │
              │  - Bridge (delayed)         │
              └─────────────────────────────┘
```

## Key Concepts

### Warp Token Mechanics

Understanding collateral flow is critical:

```
User sends FROM chain A TO chain B:
  - Chain A: User deposits collateral → WarpToken GAINS collateral
  - Chain B: Recipient withdraws     → WarpToken LOSES collateral

This is counterintuitive! Transfers TO a chain DRAIN its liquidity.
```

### Two Message Paths

The simulator uses two different delivery mechanisms:

| Path                 | Mechanism               | Delay                      | Use Case                            |
| -------------------- | ----------------------- | -------------------------- | ----------------------------------- |
| User transfers       | MockMailbox             | Configurable (default 0ms) | Simulates Hyperlane message passing |
| Rebalancer transfers | MockValueTransferBridge | Configurable (e.g., 500ms) | Simulates CCTP/bridge delays        |

This separation is important because rebalancer transfers go through external bridges (CCTP, etc.) which have significant delays, while user transfers use Hyperlane's fast messaging.

### Message Tracking

| Component        | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `MessageTracker` | Off-chain tracking of pending Hyperlane messages with delays |
| `KPICollector`   | Collects transfer/rebalance metrics and generates final KPIs |

### Rebalancer Runners

Two rebalancer implementations are available:

| Runner                       | Description                                            | Use Case                        |
| ---------------------------- | ------------------------------------------------------ | ------------------------------- |
| `SimpleRunner`               | Simplified rebalancer with weighted/minAmount strategy | Fast tests, baseline comparison |
| `ProductionRebalancerRunner` | Wraps actual `@hyperlane-xyz/rebalancer` CLI service   | Production behavior validation  |

## Directory Structure

```
typescript/rebalancer-sim/
├── src/
│   ├── BridgeMockController.ts      # Bridge delay simulation
│   ├── KPICollector.ts              # Metrics collection
│   ├── MessageTracker.ts            # Message tracking
│   ├── RebalancerSimulationHarness.ts  # Main entry point
│   ├── ScenarioGenerator.ts         # Create synthetic scenarios
│   ├── ScenarioLoader.ts            # Load from JSON files
│   ├── SimulationDeployment.ts      # Anvil + contract deployment
│   ├── SimulationEngine.ts          # Simulation orchestration
│   ├── types.ts                     # Consolidated types
│   ├── index.ts                     # Explicit exports
│   ├── runners/                     # Rebalancer implementations
│   │   ├── SimpleRunner.ts          # Simplified for testing
│   │   ├── ProductionRebalancerRunner.ts  # Wraps production service
│   │   └── SimulationRegistry.ts    # IRegistry impl
│   └── visualizer/                  # HTML timeline generation
│       └── HtmlTimelineGenerator.ts
├── scenarios/               # Pre-generated scenario JSON files
├── results/                 # Test results (gitignored)
├── scripts/
│   └── generate-scenarios.ts
└── test/
    ├── scenarios/           # Unit tests for scenario generation
    ├── utils/               # Test utilities (Anvil management)
    └── integration/         # Full simulation tests
```

## Scenario File Format

Each scenario JSON is self-contained with metadata, transfers, and default configurations:

```json
{
  "name": "extreme-drain-chain1",
  "description": "Tests rebalancer response when one chain is rapidly drained.",
  "expectedBehavior": "95% of transfers go TO chain1, draining collateral...",
  "duration": 10000,
  "chains": ["chain1", "chain2", "chain3"],
  "transfers": [...],
  "defaultInitialCollateral": "100000000000000000000",
  "defaultTiming": {
    "bridgeDeliveryDelay": 500,
    "rebalancerPollingFrequency": 1000,
    "userTransferInterval": 100
  },
  "defaultBridgeConfig": {...},
  "defaultStrategyConfig": {...},
  "expectations": {
    "minCompletionRate": 0.9,
    "shouldTriggerRebalancing": true
  }
}
```

Tests can use the defaults from JSON or override them for specific test needs.

## Running Simulations

### 1. Generate Scenarios (one-time)

```bash
pnpm generate-scenarios
```

Creates JSON files in `scenarios/` with various traffic patterns.

### 2. Run All Tests

```bash
pnpm test
```

Tests automatically detect if Anvil is available. If not installed, integration tests are skipped.

### 3. Select Rebalancers

By default, tests run with both rebalancers. Use the `REBALANCERS` env var to select:

```bash
# Run with simplified rebalancer only (faster)
REBALANCERS=simple pnpm test

# Run with production rebalancer only
REBALANCERS=production pnpm test

# Run with both (default) - compare behavior
REBALANCERS=simple,production pnpm test

# Compare on specific scenario (recommended for debugging)
REBALANCERS=simple,production pnpm test --grep "extreme-drain"
```

### 4. View Results

Test results are saved to `results/` directory (gitignored):

```bash
# JSON results with KPIs
cat results/extreme-drain-chain1.json

# HTML timeline visualization
open results/extreme-drain-chain1-HyperlaneRebalancer.html
```

**Note:** If Anvil is not installed, integration tests will be skipped. Install Foundry with:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

## Visualization

The simulator generates interactive HTML timelines for each test run:

```
Time →
═══════════════════════════════════════════════════════════════════
chain1 │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ (balance curve)
       │ ──▶ T1 ──▶ T3     ←── R1 (rebalance from chain2)
───────┼───────────────────────────────────────────────────────────
chain2 │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
       │     ──▶ T2          R1 ──▶
═══════════════════════════════════════════════════════════════════
```

Features:

- **Transfer bars**: Horizontal bars showing transfer start → delivery (length = latency)
- **Rebalance markers**: Arrows showing rebalancer actions with direction
- **Balance curves**: Per-chain collateral over time
- **Hover tooltips**: Details on transfers, amounts, timing
- **KPI summary**: Completion rate, latencies, rebalance count

## Scenario Types

### Predefined Scenarios (in `scenarios/`)

| Scenario                         | Description                         | Expected Behavior         |
| -------------------------------- | ----------------------------------- | ------------------------- |
| `extreme-drain-chain1`           | 95% of transfers TO chain1          | Heavy rebalancing needed  |
| `extreme-accumulate-chain1`      | 95% of transfers FROM chain1        | Heavy rebalancing needed  |
| `large-unidirectional-to-chain1` | 5 large (20 token) transfers        | Immediate imbalance       |
| `whale-transfers`                | 3 massive (30 token) transfers      | Stress test response time |
| `balanced-bidirectional`         | Uniform random traffic              | Minimal rebalancing       |
| `surge-to-chain1`                | Traffic spike mid-scenario          | Tests burst handling      |
| `stress-high-volume`             | 50 transfers, Poisson distribution  | Load testing              |
| `moderate-imbalance-chain1`      | 70% of transfers to chain1          | Moderate rebalancing      |
| `sustained-drain-chain3`         | 30 transfers over 30s               | Endurance test            |
| `random-with-headroom`           | Random traffic with extra liquidity | Tests steady-state        |

## Test Organization

### Unit Tests (`test/scenarios/`)

Test the scenario generation logic without running simulations:

- Does `unidirectionalFlow()` create correct transfer patterns?
- Does `randomTraffic()` distribute across all chains?
- Does serialization preserve BigInt amounts?

### Integration Tests (`test/integration/`)

Run full simulations on Anvil:

| Test File                 | Purpose                                              |
| ------------------------- | ---------------------------------------------------- |
| `harness-setup.test.ts`   | Verifies multi-domain deployment and harness setup   |
| `full-simulation.test.ts` | Runs predefined scenarios, saves results             |
| `inflight-guard.test.ts`  | Demonstrates over-rebalancing without inflight guard |

### Why `inflight-guard.test.ts` is Separate

This test demonstrates a specific bug/limitation rather than testing a scenario type:

**What it proves:** Without tracking pending (inflight) transfers, the rebalancer sends redundant transfers because each poll sees "stale" on-chain balances.

**How it differs:**

- Uses custom inline scenario with extreme timing (3s bridge delay vs 200ms polling)
- Asserts on specific failure behavior (expects over-rebalancing)
- Documents a bug that needs fixing, not a passing scenario

## KPIs Collected

```typescript
interface SimulationKPIs {
  totalTransfers: number;
  completedTransfers: number;
  completionRate: number; // 0-1, should be >0.9 with working rebalancer

  averageLatency: number; // ms
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;

  totalRebalances: number;
  rebalanceVolume: bigint; // Total tokens moved by rebalancer

  perChainMetrics: Record<
    string,
    {
      initialBalance: bigint;
      finalBalance: bigint;
      transfersIn: number;
      transfersOut: number;
    }
  >;
}
```

## Current Limitations

1. **No Inflight Guard**: Neither rebalancer implementation tracks pending transfers, causing over-rebalancing when bridge delays are long relative to polling frequency. The `inflight-guard.test.ts` demonstrates this.

2. **Single Anvil**: All "chains" run on one Anvil instance. Real cross-chain timing differences aren't simulated.

3. **Instant User Transfers**: User transfers via MockMailbox are instant. Real Hyperlane has ~15-30 second finality.

4. **No Gas Costs**: Gas costs aren't simulated. KPIs include rebalance count but not actual cost.

5. **Nonce Caching**: When running both rebalancers (`REBALANCERS=simple,production`), ethers v5 nonce caching can cause timeouts on the full test suite. Run specific scenarios for comparison.

## Design Decisions

### Single Anvil, Multiple Domains

All simulated "chains" run on a single Anvil instance with different domain IDs:

```typescript
// All chains share one RPC but have unique domain IDs
const chainMetadata = {
  chain1: { domainId: 1000, rpcUrls: [{ http: anvilRpc }] },
  chain2: { domainId: 2000, rpcUrls: [{ http: anvilRpc }] },
  chain3: { domainId: 3000, rpcUrls: [{ http: anvilRpc }] },
};

// Each domain has its own:
// - MockMailbox (for instant user transfers)
// - HypERC20Collateral (warp token with liquidity)
// - MockValueTransferBridge (for delayed rebalancer transfers)
```

This approach enables fast, deterministic testing without multi-process coordination.

### Fast Real-Time Execution

Simulations run in "compressed" real-time:

| Real World    | Simulation Default |
| ------------- | ------------------ |
| 30s bridge    | 500ms              |
| 60s polling   | 1000ms             |
| 5min scenario | ~10s               |

Configure via `SimulationTiming`:

```typescript
interface SimulationTiming {
  bridgeDeliveryDelay: number; // ms - bridge transfer time
  rebalancerPollingFrequency: number; // ms - how often rebalancer checks
  userTransferInterval: number; // ms - spacing between user transfers
}
```

### Observation Isolation

Rebalancers can ONLY observe state via:

- JSON-RPC balance queries (`eth_call` to ERC20.balanceOf)
- Event logs (`eth_getLogs`)
- View functions (ISM queries, router configs)

NOT allowed:

- Direct contract object access
- Simulation internal state
- Bridge controller pending queue

This ensures the simulation tests realistic rebalancer behavior.

## Programmatic Usage

### Basic Simulation

```typescript
import {
  RebalancerSimulationHarness,
  ScenarioLoader,
  SimpleRunner,
} from '@hyperlane-xyz/rebalancer-sim';

// Load scenario from JSON
const scenario = ScenarioLoader.loadScenario('balanced-bidirectional');

// Create and initialize harness (deploys contracts on anvil)
const harness = new RebalancerSimulationHarness({
  anvilRpc: 'http://localhost:8545',
  initialCollateralBalance: BigInt(scenario.defaultInitialCollateral),
});
await harness.initialize();

// Run simulation
const result = await harness.runSimulation(scenario, new SimpleRunner(), {
  bridgeConfig: scenario.defaultBridgeConfig,
  timing: scenario.defaultTiming,
  strategyConfig: scenario.defaultStrategyConfig,
});

console.log(`Completion: ${result.kpis.completionRate * 100}%`);
console.log(`Avg Latency: ${result.kpis.averageLatency}ms`);
console.log(`Rebalances: ${result.kpis.totalRebalances}`);
```

### Compare Rebalancers

```typescript
import {
  ProductionRebalancerRunner,
  SimpleRunner,
} from '@hyperlane-xyz/rebalancer-sim';

const rebalancers = [
  new SimpleRunner(), // Simplified baseline
  new ProductionRebalancerRunner(), // Production rebalancer service
];

// compareRebalancers() handles state reset internally
const report = await harness.compareRebalancers(scenario, rebalancers, {
  strategyConfig: scenario.defaultStrategyConfig,
});

for (const result of report.results) {
  console.log(`${result.rebalancerName}: ${result.kpis.completionRate * 100}%`);
}
console.log(`Best latency: ${report.comparison.bestLatency}`);
```

### Generate Custom Scenarios

```typescript
import { parseEther } from 'ethers/lib/utils';

import { ScenarioGenerator } from '@hyperlane-xyz/rebalancer-sim';

// Unidirectional flow (tests drain)
const drainScenario = ScenarioGenerator.unidirectionalFlow({
  origin: 'chain1',
  destination: 'chain2',
  transferCount: 100,
  duration: 10000,
  amount: parseEther('1'),
});

// Random traffic across all chains
const randomScenario = ScenarioGenerator.randomTraffic({
  chains: ['chain1', 'chain2', 'chain3'],
  transferCount: 50,
  duration: 5000,
  amountRange: [parseEther('1'), parseEther('10')],
});

// Surge pattern (spike mid-scenario)
const surgeScenario = ScenarioGenerator.surgeScenario({
  chains: ['chain1', 'chain2', 'chain3'],
  baselineRate: 1, // 1 tx/s baseline
  surgeMultiplier: 5, // 5x during surge
  surgeStart: 3000,
  surgeDuration: 2000,
  totalDuration: 10000,
  amountRange: [parseEther('1'), parseEther('5')],
});

// Balanced bidirectional traffic (equal in/out per chain)
const balancedScenario = ScenarioGenerator.balancedTraffic({
  chains: ['chain1', 'chain2', 'chain3'],
  pairCount: 10, // Creates 20 transfers (10 pairs of A→B, B→A)
  duration: 5000,
  amountRange: [parseEther('1'), parseEther('5')],
});
```

## Future Work

### Phase 9: Backtesting with Real Warp Route History

**Goal:** Replay historical warp route traffic to backtest rebalancer strategies.

**Planned implementation:**

```typescript
// Load historical transfers from explorer or indexer
const historicalTransfers = await fetchWarpRouteHistory({
  warpRouteId: 'ETH/USDC-ethereum-arbitrum-optimism',
  startDate: '2024-01-01',
  endDate: '2024-03-01',
});

// Convert to scenario format
const scenario = ScenarioGenerator.fromHistoricalData(historicalTransfers);

// Run simulation with historical traffic
const result = await harness.runSimulation(scenario, rebalancer, config);
```

**Benefits:**

- Validate strategies against real-world traffic patterns
- Identify edge cases that synthetic scenarios miss
- Compare how different strategies would have performed historically

### Phase 10: Mock Explorer API for Inflight Guard

**Goal:** Enable testing of inflight guard functionality without real Explorer infrastructure.

The real rebalancer uses `WithInflightGuard` wrapper that queries Hyperlane Explorer API to track pending (inflight) transfers. This prevents over-rebalancing by accounting for transfers in the bridge pipeline.

**Planned implementation:**

```typescript
// src/mocks/MockExplorerApi.ts
export class MockExplorerApi {
  // Called by BridgeMockController when transfer initiated
  registerPendingTransfer(transfer: {
    messageId;
    origin;
    destination;
    amount;
  }): void;

  // Called by BridgeMockController when transfer delivered
  markDelivered(messageId: string): void;

  // Called by rebalancer's inflight guard
  async getInflightTransfers(origin, destination): Promise<InflightTransfer[]>;
}
```

**Integration points:**

- BridgeMockController calls `registerPendingTransfer()` on bridge initiation
- BridgeMockController calls `markDelivered()` on bridge delivery
- RealRebalancerRunner injects mock API for inflight queries

**Expected outcome:** `inflight-guard.test.ts` should PASS (1-2 rebalances instead of 30+) once mock explorer is integrated.

### Phase 11: Advanced Scenarios

**Bridge Failures and Latency Variance**

- Configure `failureRate > 0` in bridge config
- Test rebalancer recovery after partial failures
- Verify no stuck state after transient failures
- Asymmetric delays: `chain1→chain2: 500ms`, `chain2→chain1: 2000ms`
- Variable latency per route for heterogeneous bridge environments

**Rebalancer Restart**

- Stop rebalancer mid-scenario, restart
- Verify recovery and correct state resumption
- Test idempotency of rebalance operations

**Scoring Based on Rebalancing Cost**

- Mock gas prices per chain
- Track total gas cost in KPIs (already partially implemented)
- Add rebalancing cost as scoring metric:
  ```typescript
  const score =
    completionRate * 0.5 +
    (1 - normalizedLatency) * 0.3 +
    (1 - normalizedCost) * 0.2;
  ```
- Compare strategies by cost-efficiency ratio

### Phase 12: Enhanced Visualization

**Real-time dashboard** (stretch goal):

- WebSocket updates during simulation
- Live balance curves
- Transfer animation

**Comparison views:**

- Side-by-side rebalancer comparison in single HTML
- Diff highlighting for KPI differences
- Strategy effectiveness scoring
