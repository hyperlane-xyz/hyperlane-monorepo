# Rebalancer Simulation Harness

An end-to-end simulation environment that tests the **real RebalancerService** against simulated warp route traffic on a local Anvil instance. The goal is to measure **transfer success rate** - proving the rebalancer prevents transfer failures by proactively moving collateral between domains.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Key Components](#key-components)
- [Token Flow](#token-flow)
- [Multi-Signer Architecture](#multi-signer-architecture)
- [Running Tests](#running-tests)
- [Test Scenarios](#test-scenarios)
- [Known Limitations](#known-limitations)

## Overview

The simulation harness deploys a complete Hyperlane warp route infrastructure on a single Anvil instance, simulating multiple "chains" via different domain IDs. The **real RebalancerService** runs in daemon mode, unaware it's in a simulation - it monitors balances, detects imbalances, and executes bridge transfers just as it would in production.

### Key Design Decisions

1. **Real Time, Small Scale** - Uses real wall-clock time with compressed transfer schedules instead of mocking time. This tests actual async behavior.

2. **Real RebalancerService** - The actual service runs in daemon mode, polling balances and executing transactions.

3. **SimulatedTokenBridge** - A Solidity contract that simulates bridge behavior. The rebalancer calls `transferRemote()`, and the simulation controller calls `completeTransfer()` after a configurable delay.

4. **MockRegistry** - A minimal `IRegistry` implementation that returns test warp route config and chain addresses.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      IntegratedSimulation                                    │
│  - Traffic generation (traffic signer)                                       │
│  - Message delivery (relayer signer)                                         │
│  - Bridge completion (bridge signer)                                         │
└─────────────────────────────────────────────────────────────────────────────┘
         │                           │                           │
         ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌─────────────────────┐
│  Anvil        │         │  MockRegistry   │         │  RebalancerService  │
│  (auto-start) │         │                 │         │  (per-domain signers)│
│               │         │  - Chain meta   │         │                     │
│  - Mailboxes  │         │  - Addresses    │         │  - Monitor (polls)  │
│  - Warp routes│         │  - Warp config  │         │  - Strategy         │
│  - Simulated  │         │                 │         │  - Rebalancer       │
│    bridges    │         │                 │         │    (parallel txs)   │
└───────────────┘         └─────────────────┘         └─────────────────────┘
```

### Data Flow

#### Warp Transfer Flow (User Transfers)
```
1. TrafficGenerator.executeTransfer()
   └─> HypERC20Collateral.transferRemote()
       └─> Mailbox.dispatch() → emits Dispatch event
       
2. After messageDeliveryDelayMs:
   └─> Simulation calls Mailbox.process() on destination
       └─> HypERC20.handle() → releases collateral to recipient
```

#### Rebalance Flow
```
1. RebalancerService.Monitor polls warp route balances
   └─> Detects imbalance

2. RebalancerService.Strategy.getRebalancingRoutes()
   └─> Returns routes to rebalance

3. RebalancerService.Rebalancer.rebalance(routes)
   └─> SimulatedTokenBridge.transferRemote()
       └─> Tokens locked, transfer ID returned

4. After bridgeTransferDelayMs:
   └─> Simulation calls SimulatedTokenBridge.completeTransfer()
       └─> Tokens minted on destination warp route
```

## Key Components

### Test Harness (`harness/setup.ts`)

Deploys all contracts on a single Anvil instance:
- Mailbox + TestISM for each domain
- ERC20 tokens on collateral domains
- HypERC20Collateral / HypERC20 warp routes
- SimulatedTokenBridge for each collateral pair
- Configures rebalancer permissions (`addRebalancer`, `addBridge`)

### MockRegistry (`v2/MockRegistry.ts`)

Implements `IRegistry` interface to provide:
- Chain metadata (name, domainId, rpcUrl)
- Chain addresses (mailbox, ISM)
- Warp route config

### TrafficGenerator (`v2/OptimizedTrafficGenerator.ts`)

Executes warp route transfers:
- Calls `transferRemote()` on HypERC20Collateral
- Extracts message bytes from Dispatch events
- Delivers messages by calling `Mailbox.process()`

### FastSimulation (`v2/FastSimulation.ts`)

High-throughput simulation optimized for many transfers with minimal delays:
- Uses batch transfer execution for efficiency
- Configurable delays (100ms message delivery, 500ms rebalancer interval)
- ASCII visualization of balance timeline and rebalancing events
- Tracks metrics: latency (min/mean/p95/max), throughput, rebalance count

### IntegratedSimulation (`v2/IntegratedSimulation.ts`)

Main orchestrator:
1. Starts RebalancerService in daemon mode
2. Executes scheduled transfers
3. Delivers Hyperlane messages after delay
4. Completes bridge transfers after delay
5. Collects metrics and builds results

### SimulatedTokenBridge (`solidity/contracts/mock/SimulatedTokenBridge.sol`)

Solidity contract that simulates bridge behavior:
- `transferRemote()` - Locks origin tokens, returns transfer ID
- `completeTransfer()` - Mints destination tokens to recipient
- Configurable fixed and variable fees

## Token Flow

Understanding token flow is critical for designing test scenarios:

### HypERC20Collateral Behavior

| Operation | Effect |
|-----------|--------|
| `transferRemote()` on ORIGIN | **LOCKS** collateral from sender INTO the warp route |
| Message delivery on DESTINATION | **RELEASES** collateral FROM warp route to recipient |

### To Drain a Domain's Collateral

Transfers **TO** a domain release its collateral. If it runs out, subsequent transfers TO that domain will fail with insufficient collateral.

### Rebalancer's Job

Detect when a domain is running low on collateral and move collateral from surplus domains to deficit domains via SimulatedTokenBridge.

## Multi-Signer Architecture

Since all "chains" run on one Anvil instance, we use **separate signers per role** to avoid nonce conflicts:

```typescript
// Role-based signers (accounts 0-4)
ANVIL_KEYS = {
  deployer: account 0,      // Contract deployment
  traffic: account 1,       // User transfers  
  rebalancer: account 2,    // Shared rebalancer (legacy)
  bridge: account 3,        // Bridge completions
  relayer: account 4,       // Message delivery
};

// Per-domain rebalancer signers (accounts 5-8)
// Enables parallel execution without nonce conflicts
ANVIL_KEYS = {
  rebalancer_domain1: account 5,
  rebalancer_domain2: account 6,
  rebalancer_domain3: account 7,
  rebalancer_domain4: account 8,
};
```

The `getMultiProvider('rebalancer', true)` function configures per-chain signers so the rebalancer can execute transactions on multiple domains in parallel.

## Running Tests

All tests are run from the CLI package directory:

```bash
cd /home/nam/repos/hyperlane-monorepo/typescript/cli
```

### Quick Start

```bash
# Build first (required after changes)
pnpm build

# Run the smoke test (~15-20s)
pnpm exec mocha --config .mocharc.json --timeout 60000 --grep "Smoke" \
  'src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts'
```

### Integrated Simulation Tests

```bash
# Smoke test (~15-20s)
pnpm exec mocha --config .mocharc.json --timeout 60000 --grep "Smoke" \
  'src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts'

# Comparison test - with vs without rebalancer (~2-3min)
pnpm exec mocha --config .mocharc.json --timeout 300000 --grep "should demonstrate" \
  'src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts'

# Stress test - 50 transfers with phase changes (~2min)
pnpm exec mocha --config .mocharc.json --timeout 300000 --grep "should handle 50 transfers" \
  'src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts'

# Multi-chain test - 3 domains (~1-2min)
pnpm exec mocha --config .mocharc.json --timeout 180000 --grep "should handle 3-domain traffic" \
  'src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts'
```

### Inflight Tracking Tests

These tests demonstrate inflight tracking scenarios:

```bash
# Pending transfer blocks subsequent transfer
pnpm exec mocha --config .mocharc.json --timeout 300000 --grep "Pending Transfer Blocks" \
  'src/tests/rebalancer/simulation/v2/inflight-tracking.e2e-test.ts'

# Multiple transfers exhaust collateral  
pnpm exec mocha --config .mocharc.json --timeout 300000 --grep "Multiple Pending Transfers" \
  'src/tests/rebalancer/simulation/v2/inflight-tracking.e2e-test.ts'

# MockExplorer integration test
pnpm exec mocha --config .mocharc.json --timeout 300000 --grep "MockExplorer Integration" \
  'src/tests/rebalancer/simulation/v2/inflight-tracking.e2e-test.ts'
```

### Scenario Tests (Traffic Patterns + Route Delivery)

```bash
# Asymmetric route delivery timing
pnpm exec mocha --config .mocharc.json --timeout 180000 --grep "asymmetric route delivery" \
  'src/tests/rebalancer/simulation/v2/scenario-tests.e2e-test.ts'

# High variance delivery timing
pnpm exec mocha --config .mocharc.json --timeout 180000 --grep "high variance delivery" \
  'src/tests/rebalancer/simulation/v2/scenario-tests.e2e-test.ts'
```

### Fast Simulation Tests (Optimized)

The `FastSimulation` class provides high-throughput testing with minimal delays:

```bash
# Kill any existing anvil first
pkill -9 -f anvil

# Run all fast simulation tests (~25s)
LOG_LEVEL=error pnpm exec mocha --config .mocharc.json --timeout 120000 \
  'src/tests/rebalancer/simulation/v2/fast-simulation.e2e-test.ts'
```

**Test scenarios:**
- **Smoke Test** (10 transfers, ~11s): Basic validation with balanced traffic
- **Heavy Imbalanced** (30 transfers, ~9s): One-way traffic triggering 10+ rebalances

**Key configuration:**
```typescript
// Pool: 10,000 tokens per domain
// Tolerance: 5% (triggers rebalancing at >500 token imbalance)
// Message delivery: 100ms
// Rebalancer check interval: 500ms
```

### Run All Tests

```bash
# All integrated simulation tests
pnpm exec mocha --config .mocharc.json --timeout 300000 \
  'src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts'

# All inflight tracking tests
pnpm exec mocha --config .mocharc.json --timeout 600000 \
  'src/tests/rebalancer/simulation/v2/inflight-tracking.e2e-test.ts'

# All fast simulation tests
LOG_LEVEL=error pnpm exec mocha --config .mocharc.json --timeout 120000 \
  'src/tests/rebalancer/simulation/v2/fast-simulation.e2e-test.ts'

# Run ALL simulation tests via npm script
pnpm test:rebalancer:simulation
```

### Troubleshooting

1. **Tests timeout**: Increase `--timeout` value
2. **Port 8545 in use**: Kill any existing anvil processes: `pkill -9 -f anvil`
3. **Build errors**: Run `pnpm build` in the cli directory first
4. **Nonce errors**: Usually means a previous test didn't clean up; restart anvil
5. **"could not detect network" errors**: Anvil becomes unresponsive under heavy load. Kill and restart:
   ```bash
   pkill -9 -f anvil
   sleep 1
   # Re-run your test
   ```
6. **Tests pass individually but fail together**: Some tests accumulate state that exhausts Anvil. Run heavy tests separately or add delays between test suites.

## Test Scenarios

### Fast Simulation Tests

#### Smoke Test (10 transfers)
- 10 transfers with mixed directions
- ~11 seconds wall clock time
- Validates basic transfer completion with 100ms latency
- No rebalancing triggered (imbalance stays under 5% tolerance)

#### Heavy Imbalanced Traffic (30 transfers)
- 30 one-way transfers (domain1 → domain2)
- 50 tokens per transfer (1,500 tokens total)
- **Triggers 10+ rebalance operations** totaling ~11,000 tokens
- Shows `⚡` rebalance events in timeline visualization
- ~9 seconds wall clock time

**Example output:**
```
═══════════════════════════════════════════════════════════════════════
                          SIMULATION: heavy-imbalanced
═══════════════════════════════════════════════════════════════════════

📊 SUMMARY
   Transfers: 30/30 completed (0 stuck)
   Rebalances: 11 totaling 10.8k tokens
   
📈 BALANCE TIMELINE
   Time  │ domain1              │ domain2              │ Events
   ──────┼──────────────────────┼──────────────────────┼──────────
   0m    │ ████████████  10.0k  │ ████████████  10.0k  │ 
   0m    │ █████████████ 10.6k  │ █████████    9.4k   │ ⚡1 
   0m    │ ██████████████ 11.5k │ ████████     8.5k   │ ↔1 ⚡1
```

### Integrated Simulation Tests

#### 1. Smoke Test
- 3 transfers, basic flow validation
- ~17 seconds, 100% success rate

#### 2. Comparison Test (With vs Without Rebalancer)
- Same traffic pattern run twice
- Without rebalancer: ~76.7% success rate
- With rebalancer: 100% success rate

#### 3. Stress Test (50 Transfers)
- 50 transfers with 3 traffic phases
- Phase 1: Drain domain2 (transfers TO domain2)
- Phase 2: Drain domain1 (transfers TO domain1)
- Phase 3: Mixed traffic
- Validates rebalancer maintains stability across phase changes

#### 4. Multi-Chain Test (3 Domains)
- 3 collateral domains (domain1, domain2, domain4)
- 15 transfers draining domain1
- Validates parallel rebalancing from multiple surplus domains

## Known Limitations

### Inflight Message Tracking (Now Supported!)

The rebalancer's `ActionTracker` uses `ExplorerClient` to track inflight messages. The simulation now supports this via `MockExplorerServer`:

```typescript
const simulation = new IntegratedSimulation({
  // ... other config
  enableMockExplorer: true, // Enable mock explorer integration
});
```

When enabled:
- `MockExplorerServer` starts and provides a local GraphQL endpoint
- Transfer Dispatch events are tracked automatically
- ActionTracker queries the mock explorer and sees pending transfers
- Strategy reserves collateral for pending deliveries

When disabled (default):
- ActionTracker queries production Explorer (finds nothing local)
- Strategy receives empty `inflightContext`
- Rebalancer operates only on on-chain balances (reactive mode)

### Demonstrated Issue (Without Inflight Tracking)

See `inflight-tracking.e2e-test.ts` for concrete examples:

```
Scenario: 10 transfers of 600 tokens each (6000 total) to domain2
- domain2 has 5000 tokens
- Without inflight tracking: Rebalancer sees domain2 has "enough"
- Transfers 1-8 deliver successfully, domain2 drops to 200 tokens
- Transfers 9-10 FAIL: insufficient collateral

With inflight tracking (enableMockExplorer: true):
- Rebalancer sees 6000 tokens of pending deliveries
- Reserves collateral for pending transfers
- Would move 1000+ tokens to domain2 proactively (if strategy threshold met)
```

### Other Limitations

1. **Single Anvil Instance** - All domains run on one Anvil, which means:
   - Block timestamps are shared (no true multi-chain time simulation)
   - Reorg simulation not possible

2. **Bridge Simulation** - `SimulatedTokenBridge` is synchronous (no actual cross-chain messaging)

3. **No Gas Price Variation** - All transactions use default gas pricing

## File Structure

```
typescript/cli/src/tests/rebalancer/
├── harness/
│   ├── setup.ts                    # Contract deployment, multi-signer config
│   ├── mock-explorer.ts            # MockExplorerServer for inflight tracking
│   └── index.ts                    # Exports (DOMAIN_1-4, signers, etc.)
├── simulation/
│   ├── README.md                   # This file
│   ├── PLAN-v2.md                  # Implementation plan and status
│   └── v2/
│       ├── FastSimulation.ts       # High-throughput simulation (optimized)
│       ├── IntegratedSimulation.ts # Full simulation with real RebalancerService
│       ├── MockRegistry.ts         # IRegistry implementation
│       ├── OptimizedTrafficGenerator.ts
│       ├── SimulationVisualizer.ts # ASCII visualization of results
│       ├── SimulationClock.ts      # Simulated time management
│       ├── TrafficPatterns.ts
│       ├── types.ts
│       ├── fast-simulation.e2e-test.ts      # Fast simulation tests
│       ├── integrated-simulation.e2e-test.ts
│       ├── inflight-tracking.e2e-test.ts
│       ├── scenario-tests.e2e-test.ts
│       └── ...

solidity/contracts/mock/
└── SimulatedTokenBridge.sol        # Mock bridge contract for simulation
```

## Extending the Harness

### Adding New Test Scenarios

1. **Create a new test file** in `simulation/v2/`:

```typescript
// my-scenario.e2e-test.ts
import { expect } from 'chai';
import { pino } from 'pino';
import { toWei } from '@hyperlane-xyz/utils';

import {
  DOMAIN_1, DOMAIN_2,
  createRebalancerTestSetup,
  startAnvil,
} from '../../harness/index.js';
import {
  IntegratedSimulation,
  createWeightedStrategyConfig,
} from './IntegratedSimulation.js';
import type { SimulationRun, ScheduledTransfer } from './types.js';

const logger = pino({ level: 'info' });

describe('My Scenario', function () {
  this.timeout(300_000);
  
  let anvil, setup, baseSnapshot;
  
  before(async function () {
    anvil = await startAnvil(8545, logger);
    setup = await createRebalancerTestSetup({
      collateralDomains: [DOMAIN_1, DOMAIN_2],
      syntheticDomains: [],
      initialCollateral: BigInt(toWei('5000')),
      logger,
      simulatedBridge: { fixedFee: 0n, variableFeeBps: 10 },
    });
    baseSnapshot = await setup.createSnapshot();
  });
  
  after(async () => anvil?.stop());
  afterEach(async () => {
    await setup.restoreSnapshot(baseSnapshot);
    baseSnapshot = await setup.createSnapshot();
  });
  
  it('should test my scenario', async function () {
    const strategyConfig = createWeightedStrategyConfig(setup, {
      [DOMAIN_1.name]: { weight: 50, tolerance: 5 },
      [DOMAIN_2.name]: { weight: 50, tolerance: 5 },
    });
    
    const simulation = new IntegratedSimulation({
      setup,
      warpRouteId: 'test-warp-route',
      messageDeliveryDelayMs: 2000,
      deliveryCheckIntervalMs: 500,
      recordingIntervalMs: 1000,
      rebalancerCheckFrequencyMs: 3000,
      bridgeTransferDelayMs: 3000,
      bridgeConfigs: { /* ... */ },
      strategyConfig,
      logger,
      enableMockExplorer: true, // Enable inflight tracking
    });
    
    await simulation.initialize();
    
    const schedule: SimulationRun = {
      name: 'my-scenario',
      durationMs: 60_000,
      transfers: [/* your transfers */],
    };
    
    const results = await simulation.run(schedule);
    expect(results.transfers.completed).to.equal(results.transfers.total);
  });
});
```

2. **Run your test**:
```bash
pnpm exec mocha --config .mocharc.json --timeout 300000 --grep "my scenario" \
  'src/tests/rebalancer/simulation/v2/my-scenario.e2e-test.ts'
```

### Adding New Traffic Patterns

Edit `TrafficPatterns.ts` to add new patterns:

```typescript
export const trafficPatterns = {
  // Existing patterns...
  
  myPattern: (config: TrafficPatternConfig): ScheduledTransfer[] => {
    const transfers: ScheduledTransfer[] = [];
    // Generate your transfer schedule
    return transfers;
  },
};
```

### Adding New Route Delivery Configurations

Edit `types.ts` to add new presets:

```typescript
export const ROUTE_DELIVERY_PRESETS = {
  // Existing presets...
  
  myPreset: (chains: string[]): RouteDeliveryConfigs => {
    const configs: RouteDeliveryConfigs = {};
    for (const origin of chains) {
      for (const dest of chains) {
        if (origin !== dest) {
          configs[`${origin}-${dest}`] = {
            delayMs: 5000,      // Base delay
            varianceMs: 2000,   // Random variance ±2s
          };
        }
      }
    }
    return configs;
  },
};
```

### Customizing the MockExplorerServer

If you need custom explorer behavior, you can access it via the simulation:

```typescript
// The MockExplorerServer is created internally when enableMockExplorer=true
// It tracks transfers automatically via trackTransferInMockExplorer()

// To manually add messages (for advanced scenarios):
import { MockExplorerServer, createMockMessageFromDispatch } from '../../harness/mock-explorer.js';

const explorer = await MockExplorerServer.create();
explorer.addMessage(createMockMessageFromDispatch({
  messageId: '0x...',
  originDomainId: 1,
  destinationDomainId: 2,
  sender: '0x...',
  recipient: '0x...',
  originTxHash: '0x...',
  originTxSender: '0x...',
  messageBody: '0x...',
}));
```

### Adding More Domains

The harness supports up to 4 domains by default (DOMAIN_1 through DOMAIN_4). To add more:

1. Add new domain configs in `harness/setup.ts`
2. Add corresponding per-domain rebalancer signers in `ANVIL_KEYS`
3. Update `getMultiProvider()` to support the new domains
