# Inflight Message Aware Rebalancing - Design Document

## Problem

The Hyperlane rebalancer currently lacks visibility into inflight messages (both user transfers and rebalances), which creates two critical operational issues:

### 1. Undetectable Stuck Transfers Due to Insufficient Collateral

**Current Behavior:**

User-initiated warp transfers can become stuck when the destination chain lacks sufficient collateral to complete delivery. This occurs when:

1. A user initiates a transfer from Chain A → Chain B for amount X
2. The origin transaction executes successfully (collateral deposited into Chain A's bridge)
3. The Hyperlane message is dispatched and picked up by relayers
4. Chain B's bridge has insufficient collateral (< X)
5. The message cannot be delivered and remains stuck until collateral is manually added

**Impact:**

- User funds are effectively locked until manual intervention
- High-urgency alerts require on-call engineers to manually rebalance
- Poor user experience with no visibility into why transfers are delayed
- Operational toil scales with transfer volume
- No systematic way to prevent or resolve these situations automatically

### 2. Strategies Operate Without Inflight Context

**Current Behavior:**

The rebalancing strategies (e.g., Weighted, MinAmount) make decisions based solely on current on-chain balances. They have no awareness of:

- Inflight user transfers that may need collateral at destinations
- Inflight rebalances that will change the collateral distribution
- Pending messages that cannot be delivered due to insufficient collateral

This blind decision-making can lead to strategies proposing rebalances that:

1. **Drain collateral needed for pending deliveries**: A strategy may rebalance away from a destination just as an inflight transfer needs that collateral to deliver
2. **Miss opportunities for correction**: A strategy cannot proactively address collateral deficits because it doesn't know they exist
3. **Create inefficient rebalancing patterns**: Strategies may propose routes that conflict with inflight operations, requiring additional correction cycles

---

## Context

The Hyperlane rebalancer is a service that aims to automatically maintain optimal collateral distribution across chains in a warp route. A **single rebalancer instance runs per warp route**, continuously monitoring balances and executing rebalancing operations to achieve target distributions.

### Architecture Components

#### 1. Monitor

The Monitor component runs on a configurable polling interval (default: every few minutes) and observes the warp route state:

- **Polls token balances** across all chains in the warp route
- For each chain, queries the collateral balance (for collateralized tokens) or synthetic supply
- **Emits balance events** that trigger the rebalancing cycle
- Runs continuously as a daemon process

#### 2. Rebalancing Strategies

Strategies are the decision-making layer that determines **what rebalances should happen**. They implement the `IStrategy` interface:

```typescript
interface IStrategy {
  getRebalancingRoutes(balances: RawBalances): RebalancingRoute[];
}
```

**Input:** Current on-chain balances across all chains  
**Output:** Array of rebalancing routes (origin, destination, amount)

**Available Strategies:**

**Weighted Strategy:**
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

**MinAmount Strategy:**
- Ensures each chain maintains a minimum collateral threshold
- Only proposes rebalances when a chain falls below its minimum
- Configuration specifies minimum amounts per chain
- More conservative than weighted - only acts when thresholds breached

#### 3. Rebalancing Cycle

The complete cycle operates as follows:

```
1. Monitor polls, gets current balances and emits TokenInfo event
     ↓
2. Runner receives event and extracts RawBalances
     ↓
3. Strategy.getRebalancingRoutes(balances) called
     ↓
4. Strategy returns RebalancingRoute[]
     ↓
5. Rebalancer.rebalance(routes) executes
     ↓
6. For each route:
   - Validate route (permissions, bridge config)
   - Get gas quotes
   - Populate transaction
   - Estimate gas
   - Submit transaction on origin chain
     ↓
7. Cycle completes, waits for next Monitor poll
```

#### 4. IRebalancer Interface and Composition Pattern

The rebalancer architecture uses a **decorator pattern** to enable composable behavior through the `IRebalancer` interface:

```typescript
interface IRebalancer {
  rebalance(routes: RebalancingRoute[]): Promise<void>;
}
```

**Important:** The interface itself does not enforce composition or the decorator pattern. It only defines the method signature. Classes implementing `IRebalancer` can:

1. **Leaf implementations**: Execute rebalancing logic directly without wrapping another rebalancer
   - Example: `Rebalancer` (the core execution class)
   
2. **Decorator implementations**: Wrap another `IRebalancer` and delegate to it
   - Example: `WithSemaphore`, `WithInflightGuard`
   - By convention, these store a wrapped `IRebalancer` and call `this.rebalancer.rebalance(routes)`

The decorator pattern is a **design convention**, not a type-system guarantee. The composition chain must be manually constructed:

```typescript
// Manually construct the decorator chain
const coreRebalancer = new Rebalancer(...);  // Leaf implementation
const semaphoreRebalancer = new WithSemaphore(config, coreRebalancer, logger);  // Decorator
const guardedRebalancer = new WithInflightGuard(config, semaphoreRebalancer, ...);  // Decorator
```

There is no compile-time or runtime enforcement that:
- A decorator actually calls the wrapped rebalancer
- The chain terminates in a leaf implementation
- Decorators don't introduce cycles

This flexibility allows for:
- Simple leaf implementations that don't need wrapping
- Decorators that conditionally delegate (or skip delegation entirely)
- Dynamic composition based on configuration

**Execution Flow:**

When `rebalancer.rebalance(routes)` is called, it flows through the decorator chain (assuming decorators follow the convention):

```
guardedRebalancer.rebalance(routes)
  ↓ (applies guard logic)
semaphoreRebalancer.rebalance(routes)
  ↓ (applies timing logic)
coreRebalancer.rebalance(routes)
  ↓ (executes transactions)
```

Each decorator can:
- **Pass through** unchanged (delegate to wrapped rebalancer)
- **Block execution** (return early without calling wrapped rebalancer)
- **Modify routes** (filter, transform before delegating)
- **Add side effects** (logging, metrics, state updates)

#### 5. WithSemaphore (Current Production IRebalancer Implementation)

`WithSemaphore` is the **currently deployed** rebalancing guard that implements time-based coordination.

**Purpose:**

Prevent repeated rebalancing operations per cycle by enforcing a waiting period after each rebalance execution, giving time for cross-chain messages to be delivered and settled.

**How It Works:**

1. **After rebalancing executes**, sets a timer based on `bridgeLockTime` configuration
2. **During waiting period**, all subsequent rebalancing attempts are blocked
3. **Timer resets** when strategy returns empty routes (system balanced)
4. **Per-chain configuration**: Each chain specifies its `bridgeLockTime` based on expected finality + delivery time

**Limitations:**

- **Purely time-based**: Doesn't actually verify if messages delivered, may wait too long or not enough time
- **Blocks all rebalancing**: Cannot distinguish between:
    - Routes that conflict with inflight operations
    - Routes that are safe to execute during waiting period
- **No awareness of stuck transfers**: Cannot detect or respond to user transfers stuck due to insufficient collateral

#### 6. WithInflightGuard (Alternative IRebalancer Implementation)

`WithInflightGuard` was developed as an alternative to time-based coordination. It queries the Explorer API to detect actually inflight rebalance messages rather than relying on fixed waiting periods.

⚠️ **Not in production use.** `WithSemaphore` remains the active implementation due to reliability concerns with this approach.

**Explorer API Integration:**

The guard queries the Hyperlane Explorer's GraphQL API, which indexes message dispatch and delivery events.

**Critical Limitations:**

- The Explorer API depends on the **Hyperlane Scraper** service, which indexes blockchain events and maintains the message database. The scraper has known reliability issues:
    - The scraper occasionally fails to index delivery events
    - When this happens, messages remain marked as `is_delivered: false` indefinitely
    - This is a **permanent gap** - the event is never retroactively indexed
    - This leads to false positives for inflight messages, blocking further rebalances indefinitely
- **Blocks all rebalancing**: Cannot distinguish between routes that conflict with inflight operations vs routes that are safe to execute
- **Only checks rebalances, not user transfers**: Cannot help detect or respond to stuck user transfers

---

## Proposed Solution

