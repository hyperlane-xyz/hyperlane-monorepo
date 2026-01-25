# Rebalancer Simulation Harness v2 - Implementation Plan

## Overview

An end-to-end simulation environment that tests the **real RebalancerService** against simulated warp route traffic. The rebalancer doesn't know it's in a simulation - it interacts with real contracts on a local anvil instance and executes real bridge transfers via the SimulatedTokenBridge.

## Key Design Decisions

1. **Real Time, Small Scale** - Instead of mocking time with Sinon, we use real wall-clock time with compressed/scaled transfer schedules. This keeps the simulation simple and tests the actual async behavior of the service.

2. **Real RebalancerService** - The actual `RebalancerService` runs in daemon mode, polling balances and executing bridge transfers. It has no knowledge that it's in a simulation.

3. **SimulatedTokenBridge** - A real Solidity contract that implements the bridge interface. The rebalancer calls `transferRemote()` on it, and the simulation controller calls `completeTransfer()` after a configurable delay to simulate bridge finality.

4. **Mock Registry** - A minimal `IRegistry` implementation that returns our test warp route config and chain addresses.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Simulation Controller                                │
│  - Generates traffic (real txs on warp routes)                              │
│  - Delivers Hyperlane messages after delay                                  │
│  - Completes bridge transfers after simulated delay                         │
│  - Collects metrics (latency, volume, fees)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
         │                           │                           │
         ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌─────────────────────┐
│  Anvil        │         │  Mock Registry  │         │  RebalancerService  │
│  (local)      │◄────────│                 │◄────────│  (real code)        │
│               │         │  - Chain meta   │         │                     │
│  - Mailboxes  │         │  - Addresses    │         │  - Monitor (polls)  │
│  - Warp routes│         │  - Warp config  │         │  - Strategy         │
│  - Simulated  │         │                 │         │  - Rebalancer       │
│    bridges    │         │                 │         │    (executes txs)   │
└───────────────┘         └─────────────────┘         └─────────────────────┘
```

## Components

### 1. Test Harness (Existing)

Deploys all contracts on a single anvil instance:
- Mailbox + TestISM for each domain
- ERC20 tokens on collateral domains
- HypERC20Collateral / HypERC20 warp routes
- SimulatedTokenBridge for each collateral pair

Location: `typescript/cli/src/tests/rebalancer/harness/setup.ts`

### 2. Mock Registry

Implements `IRegistry` interface to provide:
- Chain metadata (name, domainId, rpcUrl)
- Chain addresses (mailbox, ISM)
- Warp route config

```typescript
class MockRegistry implements IRegistry {
  constructor(
    private chainMetadata: Record<string, ChainMetadata>,
    private chainAddresses: Record<string, { mailbox: string }>,
    private warpRouteConfig: WarpCoreConfig,
    private warpRouteId: string,
  ) {}

  async getChainMetadata() { return this.chainMetadata; }
  async getAddresses() { return this.chainAddresses; }
  async getWarpRoute(id: string) {
    return id === this.warpRouteId ? this.warpRouteConfig : undefined;
  }
  // ... other methods return empty/undefined
}
```

### 3. Traffic Generator (Existing)

Executes warp route transfers by calling `transferRemote()` on HypERC20Collateral.

Location: `typescript/cli/src/tests/rebalancer/simulation/v2/OptimizedTrafficGenerator.ts`

### 4. Simulation Controller

Orchestrates the simulation:
1. Starts the RebalancerService in daemon mode
2. Runs traffic generation loop
3. Delivers Hyperlane messages after delay
4. Completes bridge transfers after delay
5. Collects metrics

```typescript
class IntegratedSimulation {
  private rebalancerService: RebalancerService;
  private trafficGenerator: OptimizedTrafficGenerator;
  
  async run(schedule: SimulationRun): Promise<SimulationResults> {
    // Start rebalancer service (runs in background)
    await this.rebalancerService.start();
    
    // Run traffic and message delivery loop
    while (!done) {
      // Execute scheduled transfers
      // Deliver pending messages
      // Complete pending bridge transfers
      // Record metrics
      await sleep(loopInterval);
    }
    
    // Stop rebalancer
    this.rebalancerService.stop();
    
    return this.buildResults();
  }
}
```

### 5. SimulatedTokenBridge Contract (Existing)

Solidity contract that:
- Implements bridge interface (`quoteTransferRemote`, `transferRemote`)
- Locks tokens on transfer initiation
- Has `completeTransfer()` for simulation to finalize transfers
- Configurable fees (fixed + variable bps)

Location: `solidity/contracts/mock/SimulatedTokenBridge.sol`

## Data Flow

### Warp Transfer Flow
```
1. TrafficGenerator.executeTransfer()
   └─> HypERC20Collateral.transferRemote()
       └─> Mailbox.dispatch() → emits Dispatch event
       
2. After messageDeliveryDelayMs:
   └─> Simulation calls Mailbox.process() on destination
       └─> HypERC20.handle() → mints/releases tokens
```

### Rebalance Flow
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
       └─> Tokens released to destination warp route
```

## Configuration

### RebalancerConfig
```typescript
{
  warpRouteId: 'test-warp-route',
  strategy: [{
    rebalanceStrategy: 'weighted',
    chains: {
      domain1: {
        weighted: { weight: 50n, tolerance: 10n },
        bridge: '0x...',  // SimulatedTokenBridge address
      },
      domain2: {
        weighted: { weight: 50n, tolerance: 10n },
        bridge: '0x...',
      },
    },
  }],
}
```

### SimulationConfig
```typescript
{
  // Timing (real wall-clock milliseconds)
  messageDeliveryDelayMs: 2000,    // Time to "relay" Hyperlane messages
  bridgeTransferDelayMs: 5000,     // Time for bridge transfers to complete
  rebalancerCheckFrequency: 3000,  // How often rebalancer polls
  
  // Traffic
  transferSchedule: [...],         // Scheduled warp transfers
  
  // Initial state
  initialCollateral: 5000n * 10n**18n,
}
```

## File Structure

```
typescript/cli/src/tests/rebalancer/
├── harness/
│   ├── setup.ts                    # Contract deployment
│   └── index.ts                    # Exports
├── simulation/
│   ├── PLAN-v2.md                  # This file
│   └── v2/
│       ├── IntegratedSimulation.ts # Main simulation with real RebalancerService
│       ├── MockRegistry.ts         # IRegistry implementation
│       ├── FastSimulation.ts       # Simpler version (strategy only, no service)
│       ├── OptimizedTrafficGenerator.ts
│       ├── TrafficPatterns.ts
│       ├── SimulationVisualizer.ts
│       ├── types.ts
│       └── integrated-simulation.e2e-test.ts
```

## Implementation Status

### ✅ Completed
- [x] Test harness (contract deployment)
- [x] SimulatedTokenBridge contract
- [x] TrafficGenerator (optimized version)
- [x] Message delivery (extracts actual bytes from Dispatch event)
- [x] Traffic patterns (steady, imbalanced, burst)
- [x] Metrics collection and visualization
- [x] FastSimulation (uses WeightedStrategy directly)
- [x] Configure warp routes to allow rebalancer address (`addRebalancer`, `addBridge`)
- [x] MockRegistry implementation (implements IRegistry interface)
- [x] IntegratedSimulation with real RebalancerService
- [x] Bridge transfer completion loop (`completeTransfer()` on SimulatedTokenBridge)
- [x] E2E tests for IntegratedSimulation (`integrated-simulation.e2e-test.ts`)
- [x] **VERIFIED**: Rebalancer executes real bridge transfers in simulation!
  - Detected 6000/4200 imbalance
  - Proposed 900 token rebalance route
  - Sent transaction `0xf9c3c81e...`
  - SimulatedTokenBridge transfer completed
- [x] Multi-signer architecture to avoid nonce conflicts
  - `deployer` - contract deployment and ownership
  - `traffic` - user transfer execution
  - `rebalancer` - rebalancer service transactions
  - `bridge` - bridge completion transactions
  - `relayer` - Hyperlane message delivery
- [x] SimulatedTokenBridge mints destination tokens on completion (cross-chain simulation)
- [x] **Comparison tests (with/without rebalancer)** - PASSING!
  - Without rebalancer: 76.7% success rate (7 failures)
  - With rebalancer: 100% success rate (0 failures)
  - Rebalancer moved 5,648 tokens across 2 operations
- [x] Bidirectional imbalanced traffic test (70/30 split)
- [x] Anvil auto-start in tests (`startAnvil()` utility)
- [x] **Stress test (50 transfers with phase changes)** - PASSING!
  - 50 transfers with 3 traffic phases (drain domain2, drain domain1, mixed)
  - 100% success rate with rebalancer maintaining stability
  - 2 rebalance operations, ~1250 tokens moved
  - ~2 transfers/second throughput
- [x] **Multi-chain test (3 collateral domains)** - PASSING!
  - 3 domains (domain1, domain2, domain4) each starting with 3000 tokens
  - 15 transfers draining domain1
  - Rebalancer moved collateral from surplus domains (domain2, domain4) to deficit domain (domain1)
  - Multiple rebalance operations executed in parallel
- [x] **Per-domain signer pool** - Implemented to avoid nonce conflicts
  - Each domain gets its own rebalancer signer (accounts 5-8 on Anvil)
  - MultiProvider configured with `usePerChainSigners: true` for parallel execution
  - All per-domain signers registered as authorized rebalancers on warp routes

### 📋 TODO
- [ ] Test with more complex multi-domain scenarios (4+ domains)
- [ ] Add bridge failure simulation (test rebalancer behavior when bridges fail)
- [ ] Enhanced metrics and reporting dashboards

### ✅ Recently Completed (January 2026)
- [x] **MockExplorerServer integration for inflight tracking**
  - `MockExplorerServer` handles real GraphQL queries from `ExplorerClient`
  - Tracks Dispatch events and provides inflight context to ActionTracker
  - `enableMockExplorer: true` in `IntegratedSimulationConfig` to enable
  - Messages marked as delivered when `Mailbox.process()` completes
  - Strategy now reserves collateral for pending transfers

## Test Scenarios

### 1. Basic Rebalancing
- Start with balanced collateral (50/50)
- Run imbalanced traffic (80% one direction)
- Verify rebalancer detects and corrects imbalance

### 2. High Volume
- 100+ transfers over simulated period
- Verify no stuck transfers
- Measure rebalancer response time

### 3. Comparison
- Run same traffic pattern with and without rebalancer
- Compare final balance distribution
- Compare transfer completion rates

## Open Questions

1. ~~**Warp route permissions** - Does the rebalancer need special permissions on the warp routes to call rebalance functions?~~
   - **RESOLVED**: Yes, we call `addRebalancer(ANVIL_DEPLOYER_ADDRESS)` and `addBridge(destDomain, bridgeAddress)` during setup.

2. ~~**Bridge registration** - How does the warp route know which bridges are allowed?~~
   - **RESOLVED**: We register bridges via `addBridge()` on each collateral warp route during setup.

3. ~~**Explorer dependency** - The real RebalancerService uses ExplorerClient for inflight message tracking.~~
   - **RESOLVED**: Implemented `MockExplorerServer` that tracks local Dispatch events and provides inflight context to ActionTracker. Enable via `enableMockExplorer: true` in simulation config.

4. ~~**Nonce conflicts** - Multiple simulation components sending transactions concurrently caused nonce issues.~~
   - **RESOLVED**: Implemented multi-signer architecture with separate wallets for each role (deployer, traffic, rebalancer, bridge, relayer).

5. ~~**Cross-domain token minting** - Bridge completions failed because different domains have different ERC20 tokens.~~
   - **RESOLVED**: Updated `SimulatedTokenBridge` to accept both origin and destination token addresses. On `completeTransfer()`, it mints destination tokens to the recipient (simulating cross-chain delivery).

## Recent Fixes (January 2026)

### MockExplorerServer Integration
The simulation now supports inflight message tracking via a local mock explorer:

```typescript
const simulation = new IntegratedSimulation({
  // ... other config
  enableMockExplorer: true, // Enable mock explorer integration
});
```

When enabled:
- `MockExplorerServer` starts on a random port
- Tracks Dispatch events when transfers are executed
- Responds to GraphQL queries from `ExplorerClient`
- ActionTracker sees pending transfers and reserves collateral
- Messages marked delivered when `Mailbox.process()` completes

Architecture:
```
┌─────────────────────────────────────────────────────────────────────────┐
│                      IntegratedSimulation                                │
│  - Creates MockExplorerServer (if enableMockExplorer=true)              │
│  - Tracks Dispatch events → adds to MockExplorer                        │
│  - Marks messages delivered after mailbox.process()                     │
└─────────────────────────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
┌────────────────────┐    ┌──────────────────────────────────────────────┐
│  MockExplorerServer │    │  RebalancerService                           │
│  (GraphQL server)   │◄───│  - ActionTracker queries MockExplorer        │
│                     │    │  - Sees pending transfers                    │
│  - Filters messages │    │  - Strategy reserves collateral              │
└────────────────────┘    └──────────────────────────────────────────────┘
```

### Multi-Signer Architecture
The simulation now uses separate Anvil accounts for different roles to avoid nonce conflicts:
```typescript
ANVIL_KEYS = {
  deployer: '0xac09...',   // Account 0 - contract deployment
  traffic: '0x5996...',    // Account 1 - user transfers
  rebalancer: '0x5de4...', // Account 2 - rebalancer service
  bridge: '0x7c85...',     // Account 3 - bridge completions
  relayer: '0x47e1...',    // Account 4 - message delivery
};
```

### SimulatedTokenBridge Cross-Chain Simulation
The bridge now properly simulates cross-chain token movement:
- Constructor accepts both `originToken` and `destinationToken`
- `transferRemote()` locks origin tokens
- `completeTransfer()` mints destination tokens to recipient
- This allows each domain to have its own ERC20 while still testing rebalancing

### Anvil Auto-Start
Tests now automatically start anvil if not running:
```typescript
const anvil = await startAnvil(8545, logger);
// ... run tests ...
await anvil.stop();
```
