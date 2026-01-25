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

```bash
cd /home/nam/repos/hyperlane-monorepo/typescript/cli

# Smoke test (~17s)
pnpm exec mocha --loader tsx --timeout 60000 --grep "Smoke" \
  src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts

# Comparison test (with vs without rebalancer)
pnpm exec mocha --loader tsx --timeout 300000 --grep "should demonstrate" \
  src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts

# Stress test (50 transfers)
pnpm exec mocha --loader tsx --timeout 300000 --grep "should handle 50 transfers" \
  src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts

# Multi-chain test (3 domains)
pnpm exec mocha --loader tsx --timeout 180000 --grep "should handle 3-domain traffic" \
  src/tests/rebalancer/simulation/v2/integrated-simulation.e2e-test.ts
```

## Test Scenarios

### 1. Smoke Test
- 3 transfers, basic flow validation
- ~17 seconds, 100% success rate

### 2. Comparison Test (With vs Without Rebalancer)
- Same traffic pattern run twice
- Without rebalancer: ~76.7% success rate
- With rebalancer: 100% success rate

### 3. Stress Test (50 Transfers)
- 50 transfers with 3 traffic phases
- Phase 1: Drain domain2 (transfers TO domain2)
- Phase 2: Drain domain1 (transfers TO domain1)
- Phase 3: Mixed traffic
- Validates rebalancer maintains stability across phase changes

### 4. Multi-Chain Test (3 Domains)
- 3 collateral domains (domain1, domain2, domain4)
- 15 transfers draining domain1
- Validates parallel rebalancing from multiple surplus domains

## Known Limitations

### Inflight Message Tracking

The rebalancer's `ActionTracker` uses `ExplorerClient` to track inflight messages (pending user transfers and rebalance actions). In the simulation:

1. **No Local Explorer** - The simulation runs on a local Anvil instance with no Explorer indexer. The ExplorerClient queries the production Explorer URL which doesn't see local transactions.

2. **Current Behavior** - The ActionTracker's sync operations return empty results:
   - `syncTransfers()` finds no inflight user transfers
   - `syncRebalanceActions()` finds no inflight rebalance actions
   - The strategy receives empty `inflightContext`

3. **Why This Matters** - The strategy's `reserveCollateral()` method reserves collateral on destination chains for pending transfers. Without this:
   - The rebalancer doesn't know about pending transfers that will RELEASE collateral on delivery
   - May not move collateral to a domain that will soon be drained
   - Subsequent transfers to that domain will fail

4. **Demonstrated Issue** - See `inflight-tracking.e2e-test.ts` for concrete examples:
   ```
   Scenario: 10 transfers of 600 tokens each (6000 total) to domain2
   - domain2 has 5000 tokens
   - Without inflight tracking: Rebalancer sees domain2 has "enough"
   - Transfers 1-8 deliver successfully, domain2 drops to 200 tokens
   - Transfers 9-10 FAIL: insufficient collateral
   
   With inflight tracking:
   - Rebalancer would see 6000 tokens of pending deliveries
   - Would move 1000+ tokens to domain2 proactively
   - All 10 transfers would succeed
   ```

### Future Improvements

A `MockExplorerClient` could be implemented to:
- Track Dispatch events from the local Anvil instance
- Provide accurate inflight context to the strategy
- Enable testing of the ActionTracker's proactive behavior

## File Structure

```
typescript/cli/src/tests/rebalancer/
├── harness/
│   ├── setup.ts                    # Contract deployment, multi-signer config
│   └── index.ts                    # Exports (DOMAIN_1-4, signers, etc.)
├── simulation/
│   ├── README.md                   # This file
│   ├── PLAN-v2.md                  # Implementation plan and status
│   └── v2/
│       ├── IntegratedSimulation.ts # Main simulation with real RebalancerService
│       ├── MockRegistry.ts         # IRegistry implementation
│       ├── OptimizedTrafficGenerator.ts
│       ├── TrafficPatterns.ts
│       ├── types.ts
│       ├── integrated-simulation.e2e-test.ts
│       └── ...

solidity/contracts/mock/
└── SimulatedTokenBridge.sol        # Mock bridge contract for simulation
```
