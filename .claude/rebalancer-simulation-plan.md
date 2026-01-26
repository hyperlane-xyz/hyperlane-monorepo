# Rebalancer Simulation Test Harness Plan

## Overview

Build fast real-time simulation framework testing rebalancers against synthetic/historic transfer scenarios on single-anvil multi-domain deployments with controllable bridge mocking, KPI tracking, rebalancer-agnostic observation.

## Architecture

```
TestHarness → ScenarioEngine
           ↓
SimulationEngine → executes transfers at scheduled times, runs in fast real-time
           ↓
MultiDomainDeployment (anvil) + BridgeMockController + RebalancerRunner
           ↓
KPICollector → tracks completion rates, latencies, costs
```

**Key decisions:**

- Single anvil, multiple domains (like test1/2/3 pattern)
- **Fast real-time execution** (500ms bridge delays instead of 30s)
- Configurable delays for bridges, rebalancer polling (all sub-second)
- Rebalancer observes only via JSON-RPC (no direct state access)
- Mock bridges with controllable delays/failures
- Event-based KPI tracking

## Critical Files

**Explore:**

- `typescript/rebalancer/src/core/RebalancerService.ts` - Rebalancer interfaces
- `typescript/cli/src/tests/ethereum/warp/warp-rebalancer.e2e-test.ts` - E2E patterns
- `solidity/contracts/mock/MockValueTransferBridge.sol` - Bridge mock base
- `typescript/cli/src/tests/ethereum/commands/helpers.ts` - Deployment helpers

**Create (new package):**

```
typescript/rebalancer-sim/
├── deployment/
│   ├── SimulationDeployment.ts       # Multi-domain anvil setup
│   └── MultiDomainDeployer.ts        # Core/warp deployment per domain
├── scenario/
│   ├── ScenarioGenerator.ts          # Unidirectional/random patterns
│   ├── HistoricFetcher.ts           # Explorer API → TransferEvents (CLI tool)
│   ├── predefined-scenarios/        # Saved scenario JSON files
│   └── types.ts                      # TransferScenario, TransferEvent
├── bridges/
│   ├── BridgeMockController.ts       # Pending transfer registry + async delivery
│   └── types.ts                      # BridgeMockConfig, PendingTransfer
├── rebalancer/
│   ├── RebalancerRunner.ts          # Interface (initialize, poll, shutdown)
│   └── HyperlaneRunner.ts           # Wraps RebalancerService
├── kpi/
│   ├── KPICollector.ts              # Tracks transfers, latencies, costs
│   └── ReportGenerator.ts           # SimulationResult, ComparisonReport
├── engine/
│   └── SimulationEngine.ts          # Event loop: executes transfers, runs rebalancer daemon, waits for completion
└── harness/
    └── RebalancerSimulationHarness.ts  # Main API: runSimulation, compareRebalancers

test/
├── scenarios/
│   ├── unidirectional.test.ts
│   ├── random.test.ts
│   └── historic.test.ts
└── integration/
    └── full-simulation.test.ts
```

**Enhance:**

```
solidity/contracts/mock/
└── ControlledMockValueTransferBridge.sol  # Add delivery control hook
```

## Implementation Phases

### Phase 1: Foundation (Priority 1)

Deploy multi-domain on single anvil + basic transfer execution

**Files:**

- `SimulationDeployment.ts` - Anvil process + domain configs
- `MultiDomainDeployer.ts` - Reuse CLI e2e deploy patterns
- Basic POC test

**Key work:**

1. Start anvil with snapshot
2. Deploy 3 domains (1000, 2000, 3000 domain IDs)
3. Deploy Mailbox per domain (MockMailbox pattern)
4. Deploy HypERC20Collateral per domain, link via remotes
5. Execute transfers, verify instant delivery (MockMailbox)
6. Manual rebalancer trigger test

### Phase 2: Bridge Mocking (Priority 2)

Controllable bridge delays + failures + fee simulation (fast real-time)

**Files:**

- `BridgeMockController.ts` - Registry of pending transfers, async delivery
- `ControlledMockValueTransferBridge.sol` - Emit event, defer delivery
- `types.ts` - BridgeMockConfig, PendingTransfer

**Key work:**

1. Extend MockValueTransferBridge: `transferRemote` emits event only
2. Controller intercepts, schedules async delivery via `setTimeout()`
3. **Fast delays**: 500ms-2s instead of real 30s-30min CCTP times
4. Configurable per bridge: `{ deliveryDelay: 500, failureRate: 0.01 }`
5. Execute delivery: call destination warp token mint/unlock
6. Failure injection via config
7. **Fee simulation**: Bridge quotes return fees (native + token), deduct from transfer amounts

### Phase 3: Rebalancer Integration (Priority 3)

Wrap RebalancerService, enforce observation isolation, fast polling

**Files:**

- `RebalancerRunner.ts` - Interface
- `HyperlaneRunner.ts` - Wraps RebalancerService daemon mode
- Test with simple rebalance trigger

**Key work:**

1. Initialize RebalancerService with simulation multiProvider
2. Run in **daemon mode** with fast polling (e.g., 1s instead of 60s)
3. Monitor observes balances via JSON-RPC → strategy calculates → rebalancer executes
4. Verify isolation (no direct contract access)
5. **Skip WithInflightGuard wrapper initially** (Phase 8 if needed)
6. Configurable polling frequency for different test scenarios

### Phase 4: Scenario Generation (Priority 4)

Explicit + random patterns + historic fetcher tool

**Files:**

- `ScenarioGenerator.ts` - Unidirectional, random patterns
- `HistoricFetcher.ts` - Explorer API integration (CLI tool)
- `predefined-scenarios/` - Saved scenario JSON files
- `types.ts` - TransferScenario, TransferEvent

**Key work:**

1. `unidirectionalFlow()` - Linear transfers origin→dest
2. `randomTraffic()` - Poisson arrivals, random chain pairs
3. **Decouple historic**: CLI tool fetches from explorer, saves JSON scenarios
4. Tests load predefined scenarios (committed in repo)
5. Validation (sorted timestamps, valid chains)

### Phase 5: Simulation Engine (Priority 5)

Real-time event orchestration

**Files:**

- `SimulationEngine.ts` - Async event orchestration
- Integration tests

**Key work:**

1. Execute transfers from scenario at scheduled times (real-time delays)
2. Start rebalancer daemon (runs continuously with fast polling)
3. Bridge controller delivers transfers asynchronously (setTimeout)
4. Wait for completion: all transfers delivered + rebalancer idle
5. Collect KPIs throughout
6. **Duration**: Scenarios run in seconds/minutes instead of hours

### Phase 6: KPI Collection (Priority 6)

Metrics + reporting

**Files:**

- `KPICollector.ts` - Track transfers, calculate metrics
- `ReportGenerator.ts` - Structured output, comparisons

**Key work:**

1. Record transfer start/completion times
2. Calculate latencies (p50/p95/p99)
3. Track rebalance volume, gas costs
4. Per-chain balance snapshots
5. Generate comparison reports (markdown + JSON)

### Phase 7: Harness API (Priority 7)

Top-level API + examples

**Files:**

- `RebalancerSimulationHarness.ts` - Main entry point
- Example tests in test/

**Key work:**

1. `runSimulation()` - Deploy + initialize + run + collect
2. `compareRebalancers()` - Run multiple, reset anvil between
3. Snapshot management
4. Documentation

### Phase 8: Advanced Features (Future)

- **Failure testing**: Bridge failures, rebalancer restarts mid-simulation
- Explorer API mock (if WithInflightGuard needed)
- Visualization dashboard (post-hoc analysis)
- Multi-asset warp routes support
- State export for debugging
- CI integration

## Key Types

```typescript
interface TransferScenario {
  name: string;
  duration: number;
  transfers: TransferEvent[];
}

interface TransferEvent {
  id: string;
  timestamp: number;
  origin: ChainName;
  destination: ChainName;
  amount: bigint;
  user: Address;
}

interface BridgeMockConfig {
  [origin: string]: {
    [dest: string]: {
      deliveryDelay: number; // milliseconds (e.g., 500ms instead of 30s)
      failureRate: number; // 0-1
      deliveryJitter: number; // ± variance in ms
    };
  };
}

interface SimulationTiming {
  bridgeDeliveryDelay: number; // ms - bridge transfer time
  rebalancerPollingFrequency: number; // ms - how often rebalancer checks
  userTransferInterval: number; // ms - spacing between user transfers
}

interface RebalancerRunner {
  name: string;
  initialize(warpConfig, rebalancerConfig): Promise<void>;
  poll(currentTime: number): Promise<void>;
  shutdown(): Promise<void>;
}

interface SimulationKPIs {
  totalTransfers: number;
  completedTransfers: number;
  completionRate: number;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  totalRebalances: number;
  rebalanceVolume: bigint;
  totalGasCost: bigint;
  perChainMetrics: Record<string, ChainMetrics>;
}

interface SimulationResult {
  scenarioName: string;
  rebalancerName: string;
  duration: number;
  kpis: SimulationKPIs;
  timeline: StateSnapshot[];
}
```

## Example Test

```typescript
describe('Rebalancer Simulation', () => {
  let harness: RebalancerSimulationHarness;

  beforeEach(async () => {
    harness = new RebalancerSimulationHarness({
      chains: ['chain1', 'chain2', 'chain3'],
      anvilRpc: 'http://localhost:8545',
      rebalancerConfig: defaultRebalancerConfig,
    });
  });

  it('unidirectional traffic', async () => {
    const scenario = ScenarioGenerator.unidirectionalFlow(
      'chain1',
      'chain2',
      100, // 100 transfers total
      60, // Simulated 60s duration (runs in ~10s real-time)
    );

    const rebalancer = new HyperlaneRebalancerRunner();

    const bridgeConfig: BridgeMockConfig = {
      chain1: {
        chain2: {
          deliveryDelay: 500, // 500ms (vs. real 30s)
          failureRate: 0.01, // 1%
          deliveryJitter: 100, // ±100ms
        },
      },
    };

    const timing: SimulationTiming = {
      bridgeDeliveryDelay: 500,
      rebalancerPollingFrequency: 1000, // 1s polls
      userTransferInterval: 100, // Transfer every 100ms
    };

    const result = await harness.runSimulation(
      scenario,
      rebalancer,
      bridgeConfig,
      timing,
    );

    expect(result.kpis.completionRate).toBeGreaterThan(0.95);
  });

  it('compare rebalancers', async () => {
    const scenario = ScenarioGenerator.randomTraffic(
      ['chain1', 'chain2', 'chain3'],
      1000, // 1000 transfers
      300, // Simulated 5 min duration (runs in ~1 min real-time)
      [toWei(1), toWei(100)],
    );

    const rebalancers = [
      new HyperlaneRebalancerRunner(),
      new AlternativeRebalancerRunner(),
    ];

    const report = await harness.compareRebalancers(
      scenario,
      rebalancers,
      defaultBridgeConfig,
      defaultTiming,
    );

    console.log(report.markdown());
    // Runs in ~2 min total (1 min per rebalancer)
  });
});
```

## Deployment Pattern

```typescript
// Single anvil, multiple domains
const domains = {
  chain1: { domainId: 1000, mailbox: '0x...', warpToken: '0x...' },
  chain2: { domainId: 2000, mailbox: '0x...', warpToken: '0x...' },
  chain3: { domainId: 3000, mailbox: '0x...', warpToken: '0x...' },
};

// All on same RPC endpoint
const anvilRpc = 'http://localhost:8545';

// Rebalancer sees single RPC but multiple domains
const multiProvider = new MultiProvider({
  chain1: { ...metadata, rpcUrls: [{ http: anvilRpc }], domainId: 1000 },
  chain2: { ...metadata, rpcUrls: [{ http: anvilRpc }], domainId: 2000 },
  chain3: { ...metadata, rpcUrls: [{ http: anvilRpc }], domainId: 2000 },
});
```

## Fast Real-Time Execution

```typescript
interface SimulationTiming {
  // All in milliseconds for fast simulation
  bridgeDeliveryDelay: number; // e.g., 500ms (vs. real 30s)
  rebalancerPollingFrequency: number; // e.g., 1000ms (vs. real 60s)
  userTransferInterval: number; // e.g., 100ms between transfers
}

// Example: Simulate 1 hour of activity in 2 minutes
const timing: SimulationTiming = {
  bridgeDeliveryDelay: 500, // 30x speedup
  rebalancerPollingFrequency: 1000, // 60x speedup
  userTransferInterval: 100, // Schedule transfers rapidly
};

// Execution
async function runSimulation(scenario, timing) {
  // Start rebalancer daemon with fast polling
  rebalancer.start({ checkFrequency: timing.rebalancerPollingFrequency });

  // Execute user transfers with delays
  for (const transfer of scenario.transfers) {
    await sleep(timing.userTransferInterval);
    await executeTransfer(transfer);
  }

  // Wait for all bridges + rebalancer to complete
  await waitForCompletion();
}
```

## Bridge Fee Simulation

```typescript
interface BridgeFeeConfig {
  nativeFee: bigint;      // e.g., 0.001 ETH
  tokenFee: bigint;       // e.g., 0.1% of amount
}

// MockValueTransferBridge.quoteTransferRemote()
function quoteTransferRemote(destination, amount) {
  return [
    { chainId: origin, token: ETH_NATIVE_TOKEN_ADDRESS, amount: nativeFee },
    { chainId: origin, token: USDC_ADDRESS, amount: amount * tokenFee / 10000 },
  ];
}

// Rebalancer pays fees
await warpToken.rebalance(destination, amount, bridge, { value: nativeFee });

// Bridge delivery deducts token fee
const netAmount = amount - tokenFee;
await destinationWarpToken.handle(..., netAmount);
```

## Bridge Delivery Flow

```solidity
// ControlledMockValueTransferBridge.sol
contract ControlledMockValueTransferBridge {
  address public controller;

  function transferRemote(...) external payable {
    emit TransferPending(msg.sender, destination, amount, recipient);
    // No immediate delivery
  }

  function deliverTransfer(uint32 destination, uint256 amount, address recipient) external {
    require(msg.sender == controller);
    // Mint/unlock on destination warp token
    ITokenRouter(destinationWarpToken).handle(
      origin,
      bytes32(uint256(uint160(address(this)))),
      abi.encode(recipient, amount)
    );
  }
}
```

```typescript
// BridgeMockController.ts
class BridgeMockController {
  private pendingCount = 0;

  // Listen to TransferPending events
  async onTransferPending(event: TransferPendingEvent) {
    this.pendingCount++;

    const config = this.getBridgeConfig(event.origin, event.destination);
    const delay =
      config.deliveryDelay + (Math.random() - 0.5) * config.deliveryJitter;

    // Schedule async delivery
    setTimeout(async () => {
      try {
        if (Math.random() < config.failureRate) {
          console.log(`Bridge transfer failed: ${event.id}`);
          return;
        }

        await this.bridge.deliverTransfer(
          event.destination,
          event.amount,
          event.recipient,
        );

        console.log(`Bridge delivered: ${event.id}`);
      } finally {
        this.pendingCount--;
      }
    }, delay);
  }

  hasPendingTransfers(): boolean {
    return this.pendingCount > 0;
  }
}
```

## Fast Real-Time Simulation Flow

```typescript
async function runSimulation(scenario, rebalancer, bridgeConfig, timing) {
  // 1. Start rebalancer daemon with fast polling
  await rebalancer.start({
    checkFrequency: timing.rebalancerPollingFrequency, // e.g., 1000ms
  });

  // 2. Execute user transfers according to scenario
  const startTime = Date.now();
  for (const transfer of scenario.transfers) {
    const targetTime = startTime + transfer.timestamp * timing.timeScale;
    await sleepUntil(targetTime);
    await executeTransfer(transfer);
  }

  // 3. Wait for all activities to complete
  while (bridgeController.hasPendingTransfers() || rebalancer.isActive()) {
    await sleep(100);
  }

  // 4. Stop rebalancer and collect KPIs
  await rebalancer.stop();
  return kpiCollector.getResults();
}
```

## Observation Isolation

Rebalancers ONLY observe via:

- JSON-RPC balance queries (`eth_call` to ERC20.balanceOf)
- Event logs (`eth_getLogs` for transfers)
- View functions (ISM queries, router configs)
- Mock explorer API (if needed for inflight checks - Phase 8)

NOT allowed:

- Direct contract object access
- Simulation internal state
- Bridge controller state

Enforced via MultiProvider with only JSON-RPC provider, no ethers Contract instances shared.

## Verification

Each phase verifies:

- Phase 1: Transfers execute + deliver across domains
- Phase 2: Bridge delays work, failures inject
- Phase 3: Rebalancer observes balances, executes rebalances
- Phase 4: Scenarios generate valid events
- Phase 5: Full simulation runs without errors
- Phase 6: KPIs calculate correctly
- Phase 7: API works, comparisons valid

## User-Confirmed Decisions

1. **Explorer API mock**: Phase 8 (add if needed). Initially skip WithInflightGuard wrapper.
2. **Bridge fees**: YES - Include for economic accuracy. Mock bridges calculate fees.
3. **Concurrent rebalancers**: NO - Single rebalancer per simulation. Use `compareRebalancers()` sequentially.
4. **Historic scenarios**: Decouple generation from testing. Ship predefined scenarios + tool to generate new from history.

## Scoping Decisions

**Phase 1-7 (MVP):**

- Single-asset warp routes only
- No state export (console logging sufficient initially)
- Post-hoc visualization only (from KPI JSON output)
- No failure testing (normal operation scenarios)

**Phase 8+ (Advanced):**

- Multi-asset routes
- State export for debugging
- Real-time visualization dashboard
- Failure scenarios (bridge failures, rebalancer restarts)
