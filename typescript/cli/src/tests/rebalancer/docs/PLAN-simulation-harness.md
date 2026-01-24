# Rebalancer Simulation & Backtesting Harness - Implementation Plan

## Overview

A **behavioral/integration test harness** that treats the rebalancer as a black box and measures outcomes. Enables:

- Chaos testing with random traffic
- Backtesting against real historical warp route traffic
- Strategy comparison and optimization
- AI-friendly metrics for automated tuning

## Status: Not Started

## Problem Statement

The unit test harness tests strategy logic but is **too coupled to implementation details**. When strategies change, tests break even if behavior is correct. We need tests that verify:

> "If the rebalancer runs, all transfers should eventually be completable"

And measure:

- Transfer latency (how long until collateral is available)
- Rebalancing cost (bridge fees, gas)
- Efficiency (useful rebalancing vs unnecessary churn)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Traffic Source (Interface)                      │
├─────────────────────────────────────────────────────────────────────┤
│  ChaosTrafficGenerator  │  HistoricalTrafficReplay (Explorer API)   │
└────────────┬────────────┴────────────────┬──────────────────────────┘
             │                              │
             ▼                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Simulation Engine                             │
│  - Discrete event simulation (time-stepped)                         │
│  - Tracks collateral balances per domain                            │
│  - Tracks pending transfers & rebalances                            │
│  - Applies bridge latencies & costs                                 │
└────────────────────────────────────────────────────────────────────┬┘
             │                                                        │
             ▼                                                        ▼
┌───────────────────────────┐                    ┌────────────────────┐
│   Rebalancer Under Test   │                    │   Metrics Collector │
│   (Black Box Interface)   │                    │   - Transfer latency│
│   - getRebalancingRoutes()│                    │   - Stuck transfers │
│   - Any strategy          │                    │   - Bridge costs    │
└───────────────────────────┘                    │   - Efficiency score│
                                                 └────────────────────┘
```

## Core Components

### 1. Bridge Configuration (Realistic Mocks)

```typescript
interface BridgeConfig {
  // Cost model
  fixedCostUsd: number; // e.g., $0.50 per tx
  variableCostBps: number; // e.g., 5 bps (0.05%)
  gasEstimate: bigint; // for ETH cost calculation

  // Latency model
  minLatencyMs: number; // e.g., 30_000 (30s for fast bridge)
  maxLatencyMs: number; // e.g., 120_000 (2min variance)
  latencyDistribution: 'uniform' | 'normal' | 'exponential';

  // Reliability
  failureRate: number; // e.g., 0.01 (1% chance of failure)

  // Capacity
  maxThroughputPerHour?: bigint; // optional rate limiting
}

// Example configurations
const BRIDGE_PRESETS = {
  // Fast bridge (e.g., Across)
  fast: {
    fixedCostUsd: 0.3,
    variableCostBps: 4,
    gasEstimate: 150_000n,
    minLatencyMs: 15_000,
    maxLatencyMs: 90_000,
    latencyDistribution: 'normal',
    failureRate: 0.005,
  },

  // Slow/cheap bridge (e.g., canonical)
  slow: {
    fixedCostUsd: 0.1,
    variableCostBps: 1,
    gasEstimate: 100_000n,
    minLatencyMs: 600_000, // 10 min
    maxLatencyMs: 1_800_000, // 30 min
    latencyDistribution: 'uniform',
    failureRate: 0.001,
  },

  // Warp route as bridge
  warp: {
    fixedCostUsd: 0.05,
    variableCostBps: 0,
    gasEstimate: 200_000n,
    minLatencyMs: 60_000, // 1 min (finality + relay)
    maxLatencyMs: 300_000, // 5 min
    latencyDistribution: 'normal',
    failureRate: 0.001,
  },
};
```

### 2. Traffic Source Interface

```typescript
interface Transfer {
  id: string;
  timestamp: number; // when transfer was initiated
  origin: string; // chain name
  destination: string; // chain name
  amount: bigint;
  sender: Address;
  recipient: Address;
}

interface TrafficSource {
  getTransfers(startTime: number, endTime: number): AsyncIterable<Transfer>;
  getTotalTransferCount(): number;
  getTimeRange(): { start: number; end: number };
}
```

#### ChaosTrafficGenerator

```typescript
interface ChaosConfig {
  chains: string[];
  collateralChains: string[]; // subset that hold collateral

  // Volume
  transfersPerMinute: number;
  burstProbability?: number; // chance of 10x burst

  // Amounts
  amountDistribution: {
    min: bigint;
    max: bigint;
    distribution: 'uniform' | 'pareto' | 'bimodal';
    // pareto = realistic (many small, few large)
    // bimodal = mix of retail ($100-1k) and whale ($50k+)
  };

  // Direction bias
  directionWeights?: Record<string, Record<string, number>>;
  // e.g., { ethereum: { arbitrum: 0.6, optimism: 0.4 } }

  // Time patterns
  timePattern?: 'constant' | 'daily_cycle' | 'weekly_cycle';
}
```

#### HistoricalTrafficReplay (Explorer API)

```typescript
interface HistoricalReplayConfig {
  explorerApiUrl: string;
  warpRouteId: string;
  // OR
  warpRouteAddresses: Record<string, Address>;

  startTime: Date;
  endTime: Date;

  // Replay speed
  speedMultiplier?: number; // e.g., 60 = 1 hour replays in 1 minute
}

class ExplorerClient {
  async getWarpTransfers(params: {
    warpRouteAddresses: Address[];
    startTime: Date;
    endTime: Date;
  }): Promise<Transfer[]> {
    // GraphQL query:
    // - Fetch messages where recipient is warp route address
    // - Parse transfer amount from message body
    // - Include origin/destination chain info
  }

  async getHistoricalBalances(params: {
    warpRouteAddresses: Record<string, Address>;
    timestamp: Date;
  }): Promise<Record<string, bigint>> {
    // Options:
    // 1. Query archive node with eth_call at block
    // 2. Use indexer if available
    // 3. Reconstruct from transfer history
  }
}
```

### 3. Simulation Engine

```typescript
interface SimulationState {
  currentTime: number;

  // Balances
  collateralBalances: Record<string, bigint>;

  // In-flight transfers (user warp transfers)
  pendingTransfers: Array<{
    transfer: Transfer;
    arrivalTime: number; // when it needs collateral
    status: 'in_flight' | 'waiting_collateral' | 'completed' | 'stuck';
    collateralAvailableAt?: number;
    completedAt?: number;
  }>;

  // In-flight rebalances (bridge transfers)
  pendingRebalances: Array<{
    route: RebalancingRoute;
    initiatedAt: number;
    expectedArrivalAt: number;
    status: 'in_flight' | 'completed' | 'failed';
    cost: { gas: bigint; usd: number };
  }>;
}

interface SimulationConfig {
  initialBalances: Record<string, bigint>;
  bridges: Record<string, BridgeConfig>; // "origin-dest" -> config
  warpTransferLatencyMs: number; // HypERC20 transfer time
  gasPrices: Record<string, bigint>; // for cost calculation
  ethPriceUsd: number;
}

class SimulationEngine {
  constructor(config: SimulationConfig);

  async run(options: {
    trafficSource: TrafficSource;
    rebalancer: IStrategy; // black box

    // Timing
    durationMs: number;
    tickIntervalMs: number; // simulation resolution
    rebalancerIntervalMs: number; // how often rebalancer evaluates
  }): Promise<SimulationResults>;

  // Internal: called each tick
  private tick(deltaMs: number): void {
    // 1. Advance simulation time
    // 2. Inject new transfers from traffic source
    // 3. Process transfer arrivals:
    //    - If collateral available: complete transfer
    //    - Else: mark as waiting_collateral
    // 4. Process rebalance completions:
    //    - Add collateral to destination
    //    - Check if waiting transfers can now complete
    // 5. If rebalancer interval elapsed:
    //    - Build inflight context
    //    - Call rebalancer.getRebalancingRoutes()
    //    - Initiate proposed rebalances (with bridge latency)
    // 6. Record metrics for this tick
  }
}
```

### 4. Metrics & Scoring

```typescript
interface SimulationResults {
  // Summary
  duration: {
    simulatedMs: number;
    wallClockMs: number;
  };

  // Transfer metrics
  transfers: {
    total: number;
    completed: number;
    stuck: number; // never got collateral within timeout

    // Latency = time from transfer initiation to completion
    latency: {
      min: number;
      max: number;
      mean: number;
      p50: number;
      p95: number;
      p99: number;
    };

    // Collateral wait = extra time waiting for rebalancer
    // (latency - warpTransferLatency)
    collateralWaitTime: {
      mean: number;
      p95: number;
      p99: number;
      // Transfers that had to wait
      affectedCount: number;
      affectedPercent: number;
    };
  };

  // Rebalancing metrics
  rebalancing: {
    initiated: number;
    completed: number;
    failed: number;

    volume: {
      total: bigint; // total wei moved
      perTransfer: bigint; // amortized per user transfer
    };

    cost: {
      totalGas: bigint;
      totalUsd: number;
      perTransferUsd: number;
    };

    // Efficiency: how much rebalancing was "useful"
    // (prevented a stuck transfer vs preemptive/unnecessary)
    efficiency: {
      usefulVolume: bigint;
      unnecessaryVolume: bigint;
      ratio: number;
    };
  };

  // Balance metrics
  balances: {
    utilizationByChain: Record<
      string,
      {
        min: bigint;
        max: bigint;
        mean: bigint;
        timeBelowThreshold: number; // ms spent < 10% of initial
      }
    >;
  };

  // Time series for visualization
  timeSeries: Array<{
    timestamp: number;
    balances: Record<string, bigint>;
    pendingTransfers: number;
    waitingTransfers: number;
    pendingRebalances: number;
  }>;

  // Composite scores (0-100, higher is better)
  scores: {
    availability: number; // % transfers completed without waiting
    latency: number; // inverse of p95 latency, normalized
    costEfficiency: number; // transfers per dollar spent
    balanceEfficiency: number; // low variance in utilization
    overall: number; // weighted composite
  };
}
```

### 5. CLI Interface

```bash
# Chaos test
hyperlane rebalancer simulate \
  --mode chaos \
  --config ./rebalancer-config.yaml \
  --duration 1h \
  --transfers-per-minute 10 \
  --output results.json

# Backtest
hyperlane rebalancer backtest \
  --config ./rebalancer-config.yaml \
  --warp-route USDC/ethereum-arbitrum-optimism \
  --start 2024-01-01 \
  --end 2024-01-31 \
  --output results.json

# Compare strategies
hyperlane rebalancer compare \
  --configs ./weighted.yaml ./minamount.yaml ./deficit.yaml \
  --mode chaos \
  --duration 1h \
  --output comparison.json
```

## Implementation Phases

### Phase 1: Core Simulation Engine

**Estimated: 2-3 days**

Files to create:

```
typescript/cli/src/tests/rebalancer/simulation/
├── types.ts              # All interfaces
├── BridgeSimulator.ts    # Bridge cost/latency models
├── SimulationEngine.ts   # Core discrete event loop
├── ChaosTrafficGenerator.ts
├── MetricsCollector.ts
└── index.ts
```

Deliverable: Can run chaos simulation against any strategy, outputs metrics.

### Phase 2: Rebalancer Integration

**Estimated: 1-2 days**

- Adapter to run real rebalancer strategies in simulation
- Proper inflight context building
- Handle strategy errors gracefully

Deliverable: Can test actual `WeightedStrategy`, `MinAmountStrategy`, etc.

### Phase 3: Historical Backtesting

**Estimated: 2-3 days**

Files to create:

```
typescript/cli/src/tests/rebalancer/simulation/
├── ExplorerClient.ts           # Fetch historical data
├── HistoricalTrafficReplay.ts  # Traffic source from history
└── backtest.ts                 # Backtest runner
```

Challenges:

- Explorer API rate limits
- Parsing transfer amounts from message bodies
- Getting historical balances (may need archive node)

Deliverable: Can backtest against real January 2024 USDC warp route traffic.

### Phase 4: CLI & Reporting

**Estimated: 1-2 days**

- CLI commands for simulate/backtest/compare
- JSON output for CI integration
- Optional: HTML report generation

### Phase 5: Visualization (Optional)

**Estimated: 1-2 days**

- Time series charts (balances, pending transfers)
- Latency distribution histograms
- Strategy comparison tables

## Open Questions

1. **Historical balance data**: How do we get collateral balances at a specific historical timestamp?

   - Archive node query?
   - Reconstruct from transfer history?
   - Store in indexer?

2. **Transfer amount parsing**: How do we extract transfer amounts from Hyperlane message bodies?

   - Need to decode TokenMessage format
   - May vary by warp route version

3. **Bridge config accuracy**: Where do we get realistic bridge latency/cost data?

   - Hardcode based on known bridges?
   - Fetch from bridge APIs?
   - User-provided config?

4. **Scoring weights**: How do we weight availability vs cost vs latency?
   - User-configurable?
   - Use case dependent (high-value vs retail)?

## Success Criteria

1. **Chaos test** completes in <5 minutes for 1 hour simulated time
2. **Backtest** can process 1 month of real traffic in <10 minutes
3. **Metrics** clearly show when one strategy outperforms another
4. **AI-friendly**: Output format is machine-parseable for optimization loops
5. **Strategy-agnostic**: No test changes needed when strategy internals change

## Dependencies

- Explorer API access (for backtesting)
- Archive node access (for historical balances, optional)
- Bridge configuration data

## Risks

1. **Explorer API limitations**: May not have all data needed, rate limits
2. **Historical accuracy**: Simulation may not perfectly reflect real conditions
3. **Complexity**: Discrete event simulation is complex to get right
4. **Performance**: Large backtests may be slow

## References

- [Explorer API](https://explorer.hyperlane.xyz/)
- [Existing unit test harness](./PLAN-unit-test-harness.md)
- Rebalancer strategies: `typescript/rebalancer/src/strategy/`
