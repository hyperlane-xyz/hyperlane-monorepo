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

### Architecture Overview

The solution introduces three new components that work together to provide inflight-aware rebalancing:

1. **MessageTracker**: Queries and verifies inflight messages (both user transfers and rebalances), caching delivery status
2. **CollateralDeficitStrategy**: An `IStrategy` that detects collateral deficits caused by inflight transfers and proposes corrective rebalances
3. **StrategyPipeline**: An `IStrategy` that orchestrates multiple strategies in sequence, where each strategy sees the projected state after previous strategies' proposals
4. **RouteOptimizer**: Post-pipeline optimization that consolidates and simplifies the combined routes from all strategies

### Component Details

#### MessageTracker

**Responsibilities:**
- Query Explorer API for inflight messages (both user transfers and rebalances)
- Verify delivery status on-chain using SDK (`HyperlaneCore.isDelivered()`)
- Maintain cache of verified delivery status across cycles
- Provide inflight message context to Runner for balance computation

**Key Methods:**
```typescript
interface MessageTracker {
  getInflightMessages(): Promise<InflightMessage[]>;
  // Returns messages that are:
  // 1. Reported as undelivered by Explorer API
  // 2. Verified as undelivered on-chain (not just trusting Explorer)
}
```

**Cache Behavior:**
- Messages verified as delivered are cached with 24h TTL
- Cache persists across rebalancing cycles
- Prevents redundant on-chain verification calls
- Messages still in Explorer but in cache as delivered are skipped

**Non-EVM Limitation:**
- Currently only supports on-chain verification for EVM chains
- Non-EVM chains (e.g., Solana) fall back to Explorer API only
- Design allows for future addition of non-EVM verification

#### RebalancerRunner Integration

**Current Flow:**
```
Monitor polls → Runner.onTokenInfo(event)
  → Extract RawBalances
  → strategy.getRebalancingRoutes(rawBalances)
  → rebalancer.rebalance(routes)
```

**New Flow:**
```
Monitor polls → Runner.onTokenInfo(event)
  → Extract RawBalances
  → messageTracker.getInflightMessages()
  → Compute Inflight-Adjusted Balances
  → strategyPipeline.getRebalancingRoutes(inflightAdjustedBalances)
  → routeOptimizer.optimize(routes)
  → rebalancer.rebalance(optimizedRoutes)
```

**Inflight-Adjusted Balance Computation:**

Given inflight messages, the Runner computes projected balances that reflect collateral state after pending messages deliver:

```
inflightAdjustedBalance[chain] = rawBalance[chain] 
  + Σ(inflight transfers TO chain)
  - Σ(inflight transfers FROM chain)
```

**Key Insight:** For `HypERC20Collateral` contracts:
- **Outgoing transfers**: Collateral already deposited on origin (balance already reflects this)
- **Incoming transfers**: Collateral will be released on destination (balance doesn't reflect this yet)

Example:
```
Initial Raw Balances:
  eth: 5000, arb: 6500, poly: 2000

Inflight Messages:
  - User transfer: arb → poly, 3500 (arb already has collateral, poly will release)
  - Rebalance: eth → arb, 1000

Inflight-Adjusted Balances:
  eth: 5000 - 1000 = 4000    (outgoing rebalance, already deposited)
  arb: 6500 + 1000 = 7500    (incoming rebalance, will release)
  poly: 2000 + 3500 = 5500   (incoming transfer, will release)
```

This ensures strategies see the **projected** collateral distribution after inflight messages deliver, preventing proposals that would overdraw actual collateral.

#### CollateralDeficitStrategy

**Purpose:** Detect inflight user transfers that cannot deliver due to insufficient destination collateral and propose minimal corrective rebalances.

**How It Works:**

1. Receives inflight-adjusted balances from pipeline
2. Identifies chains with negative projected balances (deficit = inflight incoming > available collateral)
3. For each deficit, proposes the minimal rebalance needed to cover it
4. Does NOT propose rebalances to achieve optimal distribution - that's the weighted strategy's job

**Route Proposals:**

```typescript
// If poly has deficit of 1500:
// inflightAdjustedBalance.poly = -1500

// Strategy proposes minimal fix:
return [{ from: bestSource, to: poly, amount: 1500 }];

// Where bestSource = chain with highest surplus
```

**Safety Guarantee:**

The strategy can only propose routes that are valid given the inflight-adjusted balances it receives. If there's insufficient collateral across the entire system to fix a deficit, it returns `[]` and logs a warning.

#### StrategyPipeline

**Purpose:** Orchestrate multiple strategies in sequence, where each strategy operates on balances that reflect all prior strategies' proposals.

**Pipeline Execution:**

```typescript
class StrategyPipeline implements IStrategy {
  constructor(private strategies: IStrategy[]) {}
  
  getRebalancingRoutes(balances: InflightAdjustedBalances): RebalancingRoute[] {
    let currentBalances = balances;
    let allRoutes: RebalancingRoute[] = [];
    
    for (const strategy of this.strategies) {
      const routes = strategy.getRebalancingRoutes(currentBalances);
      
      // Validate each route doesn't overdraw
      for (const route of routes) {
        if (currentBalances[route.from] < route.amount) {
          throw new Error(`Strategy proposed invalid route: insufficient balance on ${route.from}`);
        }
      }
      
      // Apply routes to compute next stage balances
      currentBalances = this.applyRoutes(currentBalances, routes);
      allRoutes.push(...routes);
    }
    
    return allRoutes;
  }
}
```

**Key Properties:**

1. **Sequential Composition**: Later strategies see the impact of earlier strategies
2. **Route Validation**: Each proposed route is validated against current projected balances
3. **Synchronous Interface**: Maintains existing `IStrategy` interface (no breaking changes)
4. **Fail-Fast**: Throws if any strategy proposes an invalid route

#### RouteOptimizer

**Purpose:** Optimize the combined routes from the strategy pipeline by consolidating redundant transfers and minimizing the number of cross-chain operations.

**Position in Architecture:**

The RouteOptimizer runs **after** the StrategyPipeline and **before** execution:

```
StrategyPipeline outputs routes
  ↓
RouteOptimizer.optimize(routes)
  ↓
Rebalancer.rebalance(optimizedRoutes)
```

**Primary Optimization: Same-Route Consolidation**

When the pipeline composes multiple strategies, it commonly produces multiple routes between the same origin and destination chains:

**Example 1: CollateralDeficit → Weighted**

```
Initial Balances: { eth: 5000, arb: 6500, poly: -1500 }

Stage 1 - CollateralDeficit:
  Proposes: { arb → poly, 1500 }
  After: { eth: 5000, arb: 5000, poly: 0 }

Stage 2 - Weighted (targets: eth 50%, arb 30%, poly 20%):
  Targets: { eth: 5000, arb: 3000, poly: 2000 }
  Proposes: { arb → poly, 2000 }
  After: { eth: 5000, arb: 3000, poly: 2000 }

Pipeline Output:
  [
    { from: arb, to: poly, amount: 1500 },
    { from: arb, to: poly, amount: 2000 }
  ]

After Optimization:
  [
    { from: arb, to: poly, amount: 3500 }  // Consolidated
  ]
```

**Example 2: CollateralDeficit → Weighted → MinAmount**

```
Initial Balances: { eth: 2500, arb: 6500, poly: -1500 }

Stage 1 - CollateralDeficit:
  Proposes: { eth → poly, 1500 }
  After: { eth: 1000, arb: 6500, poly: 0 }

Stage 2 - Weighted (targets: eth 50%, arb 30%, poly 20%):
  Targets: { eth: 4000, arb: 2400, poly: 1600 }
  Proposes: { arb → eth, 3000 }, { arb → poly, 1600 }
  After: { eth: 4000, arb: 3500, poly: 1600 }

Stage 3 - MinAmount (minimums: eth 2000, arb 1000, poly 800):
  All above minimum
  Proposes: []

Pipeline Output:
  [
    { from: eth, to: poly, amount: 1500 },
    { from: arb, to: eth, amount: 3000 },
    { from: arb, to: poly, amount: 1600 }
  ]

After Optimization:
  [
    { from: eth, to: poly, amount: 1500 },  // Different destinations, can't consolidate
    { from: arb, to: eth, amount: 3000 },
    { from: arb, to: poly, amount: 1600 }
  ]
  // No consolidation opportunity here - routes have different destinations
```

**Example 3: CollateralDeficit → MinAmount**

```
Initial Balances: { eth: 2500, arb: 6500, poly: -1500 }

Stage 1 - CollateralDeficit:
  Proposes: { eth → poly, 1500 }
  After: { eth: 1000, arb: 6500, poly: 0 }

Stage 2 - MinAmount (minimums: eth 2000, arb 1000, poly 800):
  Detects: eth (1000) < 2000, needs 1000
  Proposes: { arb → eth, 1000 }
  After: { eth: 2000, arb: 5500, poly: 0 }

Pipeline Output:
  [
    { from: eth, to: poly, amount: 1500 },
    { from: arb, to: eth, amount: 1000 }
  ]

After Optimization:
  [
    { from: eth, to: poly, amount: 1500 },  // Different routes, no consolidation
    { from: arb, to: eth, amount: 1000 }
  ]
```

**Optimization Algorithm:**

```typescript
class RouteOptimizer {
  optimize(routes: RebalancingRoute[]): RebalancingRoute[] {
    // Group routes by (from, to) pair
    const routeMap = new Map<string, RebalancingRoute[]>();
    
    for (const route of routes) {
      const key = `${route.from}-${route.to}`;
      if (!routeMap.has(key)) {
        routeMap.set(key, []);
      }
      routeMap.get(key).push(route);
    }
    
    // Consolidate routes with same (from, to)
    const optimized: RebalancingRoute[] = [];
    for (const [key, groupedRoutes] of routeMap) {
      if (groupedRoutes.length === 1) {
        optimized.push(groupedRoutes[0]);
      } else {
        // Sum amounts for same route
        const totalAmount = groupedRoutes.reduce((sum, r) => sum + r.amount, 0n);
        optimized.push({
          from: groupedRoutes[0].from,
          to: groupedRoutes[0].to,
          amount: totalAmount
        });
      }
    }
    
    return optimized;
  }
}
```

**When Consolidation Happens:**

From our composition analysis, same-route consolidation is most common when:

1. **CollateralDeficit → Weighted**: Both strategies target the same deficit chain
   - Deficit fixes the immediate problem (bring balance to 0)
   - Weighted optimizes distribution (bring balance to target %)
   - Both send to the same destination, often from same source

2. **CollateralDeficit → Weighted → MinAmount**: Weighted and Deficit both target deficit chain
   - MinAmount typically adds different routes (to satisfy minimums elsewhere)
   
3. **Weighted → MinAmount**: Less common, since Weighted usually respects minimums
   - Consolidation happens if Weighted proposes multiple routes to same chain

**Benefits:**

- **Reduces gas costs**: One cross-chain message instead of multiple
- **Simpler execution**: Fewer transactions to monitor and confirm
- **Faster settlement**: Achieves target state with fewer sequential operations

**Safety Guarantees:**

- **Preserves final state**: Consolidation is mathematically equivalent to executing routes separately
- **No new overdrafts**: Only combines routes that were already validated by pipeline
- **Idempotent**: Running optimizer multiple times produces same result

**Complexity Considerations:**

The current optimizer implements only **same-route consolidation** because:

1. **Simple and safe**: No risk of introducing new failures
2. **High value**: Common pattern from strategy composition
3. **Low complexity**: O(n) algorithm, easy to understand and maintain

**Multi-Hop Optimization (Future Work):**

A more sophisticated optimizer could detect patterns like:
```
Routes:
  { from: eth, to: arb, amount: 1000 }
  { from: arb, to: poly, amount: 1000 }

Optimized:
  { from: eth, to: poly, amount: 1000 }  // Direct route, skip intermediate
```

However, this adds complexity:
- **Safety verification**: Must ensure intermediate chain doesn't actually need the liquidity
- **Gas optimization**: Sometimes two hops are cheaper than one (depending on chains)
- **Debugging difficulty**: Harder to trace why a particular route was chosen
- **Correctness risk**: More complex logic = more potential bugs

**Decision**: Start with same-route consolidation only. Add multi-hop optimization if production data shows significant benefit.

**Configuration:**

```yaml
rebalancer:
  strategy:
    pipeline:
      - type: CollateralDeficitStrategy
      - type: WeightedStrategy
        config:
          chains:
            ethereum: { weight: 0.5 }
            arbitrum: { weight: 0.3 }
            polygon: { weight: 0.2 }
      - type: MinAmountStrategy
        config:
          minimums:
            ethereum: 2000
            arbitrum: 1000
            polygon: 800
  
  optimizer:
    enabled: true
    consolidateSameRoutes: true  # Default: true
    multiHopOptimization: false  # Future feature, default: false
```

