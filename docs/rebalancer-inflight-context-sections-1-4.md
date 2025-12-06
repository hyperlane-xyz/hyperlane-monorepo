# Current System Context

## Overview

The Hyperlane rebalancer is a service that automatically maintains optimal collateral distribution across chains in a warp route. A **single rebalancer instance runs per warp route**, continuously monitoring balances and executing rebalancing operations to achieve target distributions.

## Architecture Components

### 1. Monitor

The Monitor component runs on a configurable polling interval (default: every few minutes) and observes the warp route state:

- **Polls token balances** across all chains in the warp route
- For each chain, queries the collateral balance (for collateralized tokens) or synthetic supply
- **Emits balance events** that trigger the rebalancing cycle
- Runs continuously as a daemon process

**Balance Representation:**
For a warp route with collateralized chains, the monitor reports `bridgedSupply` - the total amount of collateral locked in each bridge contract that backs synthetic tokens on other chains.

### 2. Rebalancing Strategies

Strategies are the decision-making layer that determines **what rebalances should happen**. They implement the `IStrategy` interface:

```typescript
interface IStrategy {
  getRebalancingRoutes(balances: RawBalances): RebalancingRoute[];
}
```

**Input:** Current on-chain balances across all chains  
**Output:** Array of rebalancing routes (origin, destination, amount)

**Available Strategies:**

**Weighted Strategy** (most common):
- Maintains a target percentage distribution of collateral across chains
- Configuration example:
  ```yaml
  chains:
    ethereum:
      weight: 0.5    # 50% of total collateral
    arbitrum:
      weight: 0.3    # 30%
    polygon:
      weight: 0.2    # 20%
  ```
- Calculates current distribution vs target distribution
- Proposes routes to move collateral from surplus chains to deficit chains
- **Will not propose new routes if the system is already balanced** (within tolerance)
- Uses a greedy algorithm to minimize the number of transfers needed

**MinAmount Strategy**:
- Ensures each chain maintains a minimum collateral threshold
- Only proposes rebalances when a chain falls below its minimum
- Configuration specifies minimum amounts per chain
- More conservative than weighted - only acts when thresholds breached

**Key Behavior:**
- Strategies are **synchronous** and **stateless** - they only see current balances
- Strategies operate on a snapshot and have **no awareness of**:
  - Inflight messages (user transfers or previous rebalances)
  - Pending operations that haven't completed
  - Time-series trends or historical patterns
- Strategies will **not propose redundant rebalances** - if the weighted strategy target is already met, it returns an empty array

### 3. Rebalancing Cycle

The complete cycle operates as follows:

```
1. Monitor polls and gets current balances
     ↓
2. Monitor emits TokenInfo event
     ↓
3. Runner receives event and extracts RawBalances
     ↓
4. Strategy.getRebalancingRoutes(balances) called
     ↓
5. Strategy returns RebalancingRoute[]
     ↓
6. Rebalancer.rebalance(routes) executes
     ↓
7. For each route:
   - Validate route (permissions, bridge config)
   - Get gas quotes
   - Populate transaction
   - Estimate gas
   - Submit transaction on origin chain
     ↓
8. Cycle completes, waits for next Monitor poll
```

**Important:** The rebalancer dispatches all routes in a single cycle, then the cycle is complete. It does not wait for messages to be delivered before completing the cycle.

### 4. Rebalancer (Execution Layer)

The `Rebalancer` class handles transaction execution:

- **Validates routes**: Checks signer permissions, bridge configurations, allowed destinations
- **Prepares transactions**: Uses `EvmMovableCollateralAdapter` to populate rebalancing transactions
- **Gas estimation**: Estimates gas for all transactions before submission
- **Execution**: Submits transactions to origin chains via `MultiProvider`
- **Error handling**: Logs failures but doesn't halt the cycle - attempts all routes

**Route filtering:** Routes are filtered by minimum amount thresholds to avoid dust transfers.

**Transaction details:**
- Rebalances call the `rebalance(destinationDomain, amount, bridge)` function on collateral routers
- This transfers collateral from the origin router to a bridge contract
- A Hyperlane message is dispatched to the destination
- On delivery, collateral is transferred from destination bridge to destination router
