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
│ Creates       │   │ HyperlaneRunner│   │ Simulates slow  │
│ transfer      │   │ (simplified)   │   │ bridge delivery │
│ patterns      │   │ RealRebalancer │   │ with config-    │
│               │   │ (production)   │   │ urable delays   │
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
| User transfers       | MockMailbox             | Instant                    | Simulates Hyperlane message passing |
| Rebalancer transfers | MockValueTransferBridge | Configurable (e.g., 500ms) | Simulates CCTP/bridge delays        |

This separation is important because rebalancer transfers go through external bridges (CCTP, etc.) which have significant delays, while user transfers use Hyperlane's fast messaging.

### Rebalancer Runners

Two rebalancer implementations are available:

| Runner                 | Description                                            | Use Case                        |
| ---------------------- | ------------------------------------------------------ | ------------------------------- |
| `HyperlaneRunner`      | Simplified rebalancer with weighted/minAmount strategy | Fast tests, baseline comparison |
| `RealRebalancerRunner` | Wraps actual `@hyperlane-xyz/rebalancer` service       | Production behavior validation  |

## Directory Structure

```
typescript/rebalancer-sim/
├── src/
│   ├── deployment/          # Anvil + contract deployment
│   │   ├── SimulationDeployment.ts
│   │   └── types.ts
│   ├── scenario/            # Scenario generation & loading
│   │   ├── ScenarioGenerator.ts  # Create synthetic scenarios
│   │   ├── ScenarioLoader.ts     # Load from JSON files
│   │   └── types.ts              # ScenarioFile, TransferScenario, etc.
│   ├── bridges/             # Bridge delay simulation
│   │   ├── BridgeMockController.ts
│   │   └── types.ts
│   ├── rebalancer/          # Rebalancer wrappers
│   │   ├── HyperlaneRunner.ts      # Simplified rebalancer for testing
│   │   ├── RealRebalancerRunner.ts # Wraps @hyperlane-xyz/rebalancer
│   │   ├── SimulationRegistry.ts   # IRegistry impl for simulation
│   │   └── types.ts
│   ├── engine/              # Simulation orchestration
│   │   └── SimulationEngine.ts
│   ├── harness/             # Main entry point
│   │   └── RebalancerSimulationHarness.ts
│   ├── kpi/                 # Metrics collection
│   │   ├── KPICollector.ts
│   │   └── types.ts
│   ├── mailbox/             # Message tracking
│   │   └── MessageTracker.ts
│   └── visualizer/          # HTML timeline generation
│       ├── HtmlTimelineGenerator.ts
│       └── types.ts
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
REBALANCERS=hyperlane pnpm test

# Run with production rebalancer only
REBALANCERS=real pnpm test

# Run with both (default) - compare behavior
REBALANCERS=hyperlane,real pnpm test

# Compare on specific scenario (recommended for debugging)
REBALANCERS=hyperlane,real pnpm test --grep "extreme-drain"
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
| `deployment.test.ts`      | Verifies multi-domain deployment works               |
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

5. **Nonce Caching**: When running both rebalancers (`REBALANCERS=hyperlane,real`), ethers v5 nonce caching can cause timeouts on the full test suite. Run specific scenarios for comparison.

## Future Work

### Mock Explorer API for Inflight Guard

- Mock Explorer API for inflight transfer tracking
- Test scenarios that specifically require inflight awareness
- Validate that real rebalancer avoids over-correction with inflight guard enabled
