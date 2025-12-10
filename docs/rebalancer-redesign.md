# Rebalancer Enhancement: Inflight Message Handling & Stuck Transfer Detection

**Document Version:** 1.0  
**Date:** 2025-11-20  
**Status:** Design Proposal  
**Authors:** Hyperlane Team

---

## Executive Summary

The Hyperlane rebalancer currently faces two related operational challenges:

1. **False Positive Blocking**: The Explorer API incorrectly reports delivered messages as undelivered, causing unnecessary blocking of legitimate rebalancing operations
2. **Stuck Transfer Blindness**: The system cannot detect warp transfers that fail due to insufficient destination collateral, requiring manual intervention and causing high-urgency alerts

This document proposes a unified solution that addresses both issues through enhanced message tracking, on-chain verification, and automated corrective rebalancing.

**Expected Outcomes:**
- Reduced false positive rate for inflight detection
- Autonomous handling of collateral insufficiency issues
- Decreased on-call burden and manual interventions
- Improved system resilience and operational visibility

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current System Overview](#2-current-system-overview)
3. [Requirements](#3-requirements)
4. [Design Decisions](#4-design-decisions)
5. [Proposed Architecture](#5-proposed-architecture)
6. [Risk Assessment](#6-risk-assessment)
7. [Implementation Plan](#7-implementation-plan)
8. [Open Questions](#8-open-questions)
9. [Success Metrics](#9-success-metrics)

---

## 1. Problem Statement

### 1.1 Problem A: Inflight Guard False Positives

**Current Behavior:**
- `WithInflightGuard` queries Explorer API to check for undelivered rebalance messages
- If found, blocks all rebalancing for that cycle
- Explorer API has permanent indexing gaps - messages may be delivered but still reported as undelivered

**Impact:**
- Legitimate rebalancing operations unnecessarily blocked
- System becomes overly conservative
- Strategy targets not maintained
- Potential cascading effects on warp route balance distribution

**Root Cause:**
- Explorer indexing service does not reliably index message delivery events
- Current guard relies solely on Explorer data without on-chain verification
- Issue is not resolved and messages will always appear undelivered in the indexing service

### 1.2 Problem B: Undetectable Stuck Transfers

**Current Behavior:**
- Warp transfers can fail to deliver due to insufficient collateral on destination chain
- Rebalancer has no visibility into these stuck transfers
- System continues normal operations unaware of the issue

**Impact:**
- User transfers stuck indefinitely
- High-urgency alerts triggered
- Requires manual on-call intervention to identify and fix
- Poor user experience
- Operational toil

**Root Cause:**
- No monitoring of inflight warp transfers (only rebalance messages)
- No pre-flight collateral sufficiency checks
- No automated corrective action mechanism

### 1.3 Relationship Between Problems

Both problems involve:
- Querying Explorer API for inflight messages
- Verifying actual delivery status
- Making intelligent rebalancing decisions based on inflight state

A unified solution can address both through shared abstractions and infrastructure.

---

## 2. Current System Overview

### 2.1 Components

**Rebalancer:**
- Runs on configurable cycle interval (see helm chart: `typescript/infra/helm/rebalancer/values.yaml`)
- Queries strategy for rebalancing routes
- Executes approved transfers
- Wrapped by `WithInflightGuard`

**WithInflightGuard:**
- Queries Explorer for undelivered rebalance messages (bridge ↔ bridge)
- If any found: blocks entire rebalancing cycle
- If none found: proceeds with strategy routes
- Binary decision: all-or-nothing

**Strategy (e.g., Weighted):**
- Computes ideal token distribution across chains
- Proposes rebalancing routes to achieve targets
- No awareness of inflight messages

**Explorer API:**
- GraphQL interface to indexed blockchain data
- Tracks message dispatch and delivery
- Known limitation: delivery indexing has permanent gaps

### 2.2 Message Types

**Rebalance Messages:**
- Sender: Bridge contract (warp route collateral)
- Recipient: Bridge contract
- Purpose: Redistribute liquidity across chains
- Not structurally different from regular messages

**Warp Transfer Messages:**
- Sender: Router contract
- Recipient: Router contract
- Purpose: User-initiated cross-chain transfers
- Transfer amount provided by Explorer API

Both message types flow through the same Hyperlane Mailbox/ISM infrastructure.

### 2.3 Current Limitations

1. **No on-chain verification**: Relies solely on Explorer API
2. **No transfer monitoring**: Only tracks rebalance messages
3. **Binary blocking**: All or nothing, no surgical veto
4. **No corrective action**: Cannot automatically fix detected issues
5. **EVM-focused**: Non-EVM chains (especially Solana) need consideration

---

## 3. Requirements

### 3.1 Functional Requirements

**FR1: On-Chain Delivery Verification**
- System MUST verify message delivery status directly on-chain using SDK
- Implementation approach: Reuse pattern from CLI `status` command (`core.isDelivered()`)
- Initial implementation: EVM chains
- Design MUST accommodate non-EVM chains (especially Solana)
- Non-EVM chains: log warnings, handle gracefully

**FR2: Comprehensive Message Tracking**
- System MUST track both rebalance messages and warp transfers
- System MUST maintain state across cycles via shared MessageTracker component
- MessageTracker: New service component providing unified message tracking and verification
- Cache MUST handle Explorer API gaps gracefully
- Cache: in-memory, persists across rebalancer cycles

**FR3: Stuck Transfer Detection**
- System MUST detect warp transfers that cannot deliver due to insufficient collateral
- Detection MUST be pre-flight (compare transfer amount vs destination balance)
- Transfer amounts obtained from Explorer API
- System MUST compute collateral shortfall amount

**FR4: Automated Corrective Rebalancing**
- System MUST automatically initiate rebalancing to fix stuck transfers
- Corrective rebalances MUST take precedence over strategy rebalances
- System MUST operate autonomously (no manual approval gates)

**FR5: Strategy Protection**
- System MUST prevent strategies from undoing corrective rebalances
- System MUST avoid infinite rebalancing loops
- System SHOULD allow non-conflicting strategy rebalances to proceed
- If inflight rebalance detected AND stuck transfer cannot be addressed due to that inflight rebalance: trigger alert

### 3.2 Non-Functional Requirements

**NFR1: Performance**
- On-chain verification latency acceptable for now (no strict SLA)
- System MUST complete cycle within configured interval

**NFR2: Reliability**
- Cache MUST persist across cycles (in-memory acceptable, survives process lifecycle)
- System MUST handle Explorer API failures gracefully
- System MUST avoid thundering herd on-chain query patterns

**NFR3: Observability**
- System MUST log all corrective actions
- System MUST emit metrics for stuck transfer detection
- System MUST provide visibility into veto decisions

**NFR4: Safety**
- System MUST prevent duplicate corrective rebalances via cache
- System MUST validate source chain has sufficient balance before corrective rebalance
- System MUST not create new stuck transfers while fixing existing ones (acceptable risk with monitoring)

### 3.3 Scope & Constraints

**In Scope:**
- EVM chain delivery verification (using `HyperlaneCore.isDelivered()`)
- Design for non-EVM chains (especially Solana)
- Collateral insufficiency as root cause for stuck transfers
- Minimal corrective rebalancing (just enough to unstick)
- In-memory cache with 24-hour TTL
- Detection runs on every rebalancer loop cycle

**Out of Scope (for initial release):**
- Full non-EVM delivery verification implementation
- Other root causes for stuck transfers (ISM failures, gas issues, etc.)
- Persistent cache storage (disk/database)
- Strategy interface enhancement for full inflight awareness
- Multi-hop corrective rebalancing optimization

**Known Limitations:**
- SDK currently does not support checking delivery status for non-EVM chains
- Explorer API query limited to messages from last 3 days (or all with local cache for confirmed delivered)
- High-volume warp routes may have constantly inflight transfers
- Corrective transfers could lead to more stuck transfers (acceptable risk with monitoring)

---

## 4. Design Decisions

### 4.1 Decision: Composable Architecture

**Options Considered:**

**Option A: Monolithic Unified Guard**
- Single component handling all logic
- Pros: Simpler integration
- Cons: Difficult to test, violates single responsibility

**Option B: Separate Independent Services**
- Corrective logic and validation as standalone services
- Pros: Clear separation
- Cons: Complex orchestration, harder to maintain shared state

**Option C: Composable IRebalancer Chain** ✅ **SELECTED**
- Multiple decorators implementing IRebalancer interface
- Each decorator wraps the next in chain
- Shared MessageTracker service provides inflight context to all components
- Pros: Single responsibility, testable, extensible, enables incremental rollout
- Cons: More classes to maintain

**Rationale:** Composability aligns with existing `WithInflightGuard` pattern, enables incremental rollout, and provides clear separation of concerns.

**Composition Order:**
```
WithCorrectiveRebalancing (uses MessageTracker)
  → WithRebalanceValidator (uses MessageTracker)
    → ActualRebalancer
```

### 4.2 Decision: Smart Route Merging

**Options Considered:**

**Option A: Dumb Concatenation**
- Simply combine corrective + strategy routes
- Pros: Simple
- Cons: Duplicates, conflicts, may undo corrective actions

**Option B: Strategy Always Wins**
- Strategy routes override corrective
- Pros: Preserves strategy autonomy
- Cons: Defeats purpose of corrective actions

**Option C: Corrective Wins with Conflict Resolution** ✅ **SELECTED**
- Corrective routes always included
- Strategy routes vetoed if they conflict with corrective needs
- Strategy logic should be smart enough to check inflight context and avoid unnecessary rebalances
- Non-conflicting strategy routes allowed through
- Pros: Fixes stuck transfers while allowing safe rebalancing
- Cons: More complex logic

**Rationale:** Stuck transfers are higher priority than strategy optimization. Smart merging prevents corrective actions from being immediately undone while still allowing the strategy to operate where safe.

**Strategy Undo Prevention:**
Issue: Weighted strategy may rebalance away collateral before the stuck message gets retried by the relayer.

Solution: Strategy-Aware Inflight Context (to be explored during implementation)
- Pass inflight transfer details and required collateral to strategies
- Strategies avoid rebalances that would drain needed collateral
- Both corrective logic and strategies use shared inflight context from MessageTracker
- If both are smart enough to check inflight state, may reduce need for WithInflightGuard

### 4.3 Decision: Cache Strategy

**Options Considered:**

**Option A: No Cache (Query On-Chain Every Cycle)**
- Pros: Always fresh data
- Cons: Expensive, slow, rate limit risk

**Option B: TTL-Based Cache with Explorer Reconciliation** ✅ **SELECTED**
- 24-hour TTL for delivered messages
- Explorer query triggers cache updates
- Messages absent from Explorer marked as delivered (handles indexing gaps)
- Unified cache for all message types (rebalances + transfers)
- Pros: Balances freshness and efficiency, handles Explorer gaps gracefully
- Cons: Requires careful cache invalidation logic

**Option C: Persistent External Cache (Redis/DB)**
- Pros: Survives restarts
- Cons: Infrastructure overhead, overkill for this use case

**Rationale:** In-memory cache with smart reconciliation handles Explorer gaps while minimizing on-chain queries. 24-hour TTL sufficient for operational patterns.

**Cache Behavior:**
- **Key:** Message ID
- **Values:** Message details, delivery status, timestamps
- **Update Triggers:** Explorer query, on-chain verification
- **Eviction:** TTL expiration (24h after message no longer in Explorer results)
- **Scope:** Unified cache for both rebalance and transfer messages

**Cache Flow Each Cycle:**
1. Query Explorer → get messages [M1, M2, M3]
2. For messages in Explorer results:
   - If in cache AND status=DELIVERED AND not expired: Skip verification, reset TTL
   - If in cache AND status=UNDELIVERED: Verify on-chain (may now be delivered)
   - If not in cache: Verify on-chain, add to cache
3. For cached messages NOT in Explorer query:
   - If status=UNDELIVERED: Mark as DELIVERED (Explorer stopped indexing it), set TTL
   - If status=DELIVERED AND TTL expired: Evict from cache
4. Cache persists in memory across cycles

### 4.4 Decision: Corrective Rebalancing Strategy

**Options Considered:**

**Option A: Minimal Rebalancing** ✅ **SELECTED**
- Compute minimum transfers needed to unstick message
- Find cheapest/fastest route to destination
- Strategy handles broader optimization later
- Pros: Fast, targeted, clear purpose
- Cons: May cause temporary imbalance, strategy may undo it

**Option B: Strategy Delegation**
- Tell strategy "destination needs X minimum"
- Strategy computes holistic rebalancing plan
- Requires strategy interface changes
- Pros: Maintains strategy authority
- Cons: More complex, requires modifying strategy interface

**Option C: Hybrid Optimization**
- Rebalance to unstick + satisfy strategy targets if not too complex
- Pros: Minimizes total rebalances
- Cons: Significantly more complex, may not always be possible

**Rationale:** Minimal rebalancing provides fastest path to unsticking transfers. Separation of concerns: corrective logic fixes immediate problems, strategy maintains long-term balance. Strategy should be concerned with correcting things later. Can revisit if we see thrashing between corrective and strategy rebalances.

**Preventing Strategy Undo:**
- Corrective logic and strategies both use inflight context from MessageTracker
- Strategy can check if rebalance would conflict with required collateral
- Corrective routes take precedence in smart merge
- May need to pass inflight context to strategies for full awareness (complexity to be evaluated)

### 4.5 Decision: WithInflightGuard Evolution

**Options Considered:**

**Option A: Remove Entirely**
- Trust corrective and strategy logic
- Pros: Simpler
- Cons: No safety net

**Option B: Keep as Binary Guard with On-Chain Verification**
- Enhanced but same all-or-nothing behavior
- Pros: Minimal changes
- Cons: Still overly restrictive

**Option C: Evolve to Surgical Validator** ✅ **SELECTED**
- Validates individual routes, not whole cycle
- Can veto specific conflicting routes
- Uses on-chain verification via MessageTracker
- Last line of defense
- Pros: More flexible, maintains safety, fixes false positives
- Cons: More complex logic

**Rationale:** Surgical validation prevents systemic issues while allowing maximum legitimate rebalancing. Serves as safety net if corrective/strategy logic has bugs. On-chain verification eliminates false positives from Explorer API gaps.

### 4.6 Decision: Duplicate Corrective Action Prevention

**Options Considered:**

**Option A: No Deduplication**
- Accept redundant corrective rebalances
- Pros: Simple, fail-safe
- Cons: Inefficient, may compound issues

**Option B: Leverage Existing Inflight Guard**
- Corrective rebalance becomes inflight, blocks next cycle
- Pros: Reuses existing mechanism
- Cons: Blocks all rebalancing, including new stuck transfers

**Option C: Local Cache with Smart Logic** ✅ **SELECTED**
- MessageTracker cache tracks all inflight messages (rebalances + transfers)
- Corrective logic checks cache to see if problem already being addressed
- Only initiates new rebalance if needed
- Scenario: Cycle 1 detects stuck transfer, initiates rebalance (20min to land)
- Cycle 2 runs, checks MessageTracker: sees inflight corrective rebalance, skips duplicate
- Pros: Surgical, efficient, reuses required cache infrastructure
- Cons: Requires state management (already needed for cache)

**Rationale:** Cache already required for other features. Smart logic leveraging shared MessageTracker cache provides best balance of efficiency and safety without overly blocking operations. If strategies and corrective logic are smart enough to check inflight context, WithInflightGuard may become redundant (but kept as safety net).

---

## 5. Proposed Architecture

### 5.1 System Diagram

```
┌─────────────────────────────────────────────────────┐
│              Rebalancer Main Loop (CLI)             │
│  - Queries strategy for routes                      │
│  - Invokes rebalancer composition chain             │
└──────────────────────┬──────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────┐
│             MessageTracker (NEW - Shared)           │
│  Purpose: Unified message tracking & verification   │
│                                                     │
│  Responsibilities:                                  │
│  • Query Explorer for inflight messages             │
│    - Rebalances (bridge ↔ bridge)                   │
│    - Transfers (router ↔ router)                    │
│  • Verify delivery on-chain via SDK                 │
│    - Uses core.isDelivered(message) pattern         │
│    - EVM: full implementation                       │
│    - Non-EVM (Solana): designed for, impl future    │
│  • Maintain unified in-memory cache (24h TTL)       │
│  • Handle Explorer API indexing gaps                │
│                                                     │
│  Provides: InflightContext {                        │
│    inflightRebalances: Message[]                    │
│    inflightTransfers: Message[]                     │
│    requiredCollateral: Map<chain, amount>           │
│  }                                                  │
└──────────────────────┬──────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────┐
│       WithCorrectiveRebalancing (NEW, IRebalancer)  │
│  Purpose: Detect & fix stuck transfers              │
│                                                     │
│  Responsibilities:                                  │
│  • Get inflight context from MessageTracker         │
│  • Detect stuck transfers (collateral < amount)     │
│    - Transfer amounts from Explorer API             │
│    - Compare to destination collateral balances     │
│  • Compute minimal corrective routes                │
│  • Smart merge corrective + strategy routes         │
│    - Corrective routes take precedence              │
│    - Veto strategy routes conflicting with needed   │
│      collateral                                     │
│  • Delegate merged routes downstream                │
│                                                     │
│  Input: Strategy routes                             │
│  Output: Merged routes (corrective + safe strategy) │
└──────────────────────┬──────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────┐
│    WithRebalanceValidator (EVOLVED from Guard)      │
│  Purpose: Final validation & surgical veto          │
│                                                     │
│  Responsibilities:                                  │
│  • Get inflight context from MessageTracker         │
│    - Uses cached data from earlier in cycle         │
│    - On-chain verification eliminates false +       │
│  • Validate each route individually                 │
│  • Veto duplicates or conflicting routes            │
│    - Surgical: per-route, not whole cycle           │
│  • Delegate validated routes downstream             │
│  • Act as safety net for corrective/strategy bugs   │
│                                                     │
│  Input: Merged routes                               │
│  Output: Validated routes (vetoed removed)          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────┐
│            Actual Rebalancer (EXISTING)             │
│  Purpose: Execute approved rebalancing routes       │
│                                                     │
│  Responsibilities:                                  │
│  • Execute cross-chain transfers                    │
│  • Handle transaction submission                    │
│  • Error handling & retries                         │
└─────────────────────────────────────────────────────┘
```

### 5.2 Component Interfaces

#### MessageTracker (New Shared Service)

```typescript
enum DeliveryStatus {
  DELIVERED = 'delivered',
  UNDELIVERED = 'undelivered',
  UNKNOWN = 'unknown', // non-EVM or verification failed
}

interface HyperlaneMessage {
  msgId: string;
  originDomain: number;
  destinationDomain: number;
  originChain: string;
  destinationChain: string;
  sender: string;
  recipient: string;
  originTxHash: string;
  originTxSender: string;
  amount?: bigint; // for transfers, from Explorer API
}

interface CachedMessage extends HyperlaneMessage {
  deliveryStatus: DeliveryStatus;
  lastVerified: number; // timestamp
  firstSeen: number; // timestamp
}

interface InflightContext {
  inflightRebalances: HyperlaneMessage[];
  inflightTransfers: HyperlaneMessage[];
  // Computed: Map of destination chain -> total amount needed for stuck transfers
  requiredCollateral: Map<string, bigint>;
}

class MessageTracker {
  private cache: Map<string, CachedMessage>; // key: msgId
  private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly explorer: ExplorerClient,
    private readonly core: HyperlaneCore, // for on-chain verification
    private readonly config: RebalancerConfig,
    private readonly chainManager: ChainMetadataManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Main entry point called each cycle
   * 1. Query Explorer for inflight messages (rebalances + transfers)
   * 2. Verify delivery status using cache + on-chain checks
   * 3. Update cache, handle Explorer indexing gaps
   * 4. Return inflight context
   */
  async getInflightContext(): Promise<InflightContext>;

  /**
   * Query Explorer for undelivered rebalance messages (bridge->bridge)
   */
  private async queryInflightRebalances(): Promise<HyperlaneMessage[]>;

  /**
   * Query Explorer for undelivered transfer messages (router->router)
   * Explorer API provides transfer amounts
   */
  private async queryInflightTransfers(): Promise<HyperlaneMessage[]>;

  /**
   * Verify delivery status for a message
   * - Check cache first
   * - If not cached or stale, verify on-chain (EVM only for now)
   * - Update cache
   */
  private async verifyDelivery(msg: HyperlaneMessage): Promise<DeliveryStatus>;

  /**
   * On-chain delivery check using SDK
   * Pattern from CLI status command: core.isDelivered(message)
   * Returns DELIVERED | UNDELIVERED | UNKNOWN
   * 
   * EVM: Full implementation using core.isDelivered()
   * Non-EVM (Solana): Designed for future implementation
   */
  private async checkDeliveryOnChain(msg: HyperlaneMessage): Promise<DeliveryStatus>;

  /**
   * Cache maintenance:
   * - Mark messages not in Explorer query as delivered (handles indexing gaps)
   * - Evict expired entries (TTL reached)
   */
  private maintainCache(queriedMessageIds: Set<string>): void;

  /**
   * Compute required collateral per chain based on stuck transfers
   */
  private computeRequiredCollateral(
    stuckTransfers: HyperlaneMessage[],
  ): Map<string, bigint>;
}
```

**Key Integration Points:**
- Reuses `ExplorerClient` for message queries (needs enhancement for transfer queries)
- Uses `HyperlaneCore.isDelivered()` pattern from CLI `status` command
- Shared by both `WithCorrectiveRebalancing` and `WithRebalanceValidator`
- In-memory cache persists across rebalancer cycles

#### WithCorrectiveRebalancing (New IRebalancer)

```typescript
class WithCorrectiveRebalancing implements IRebalancer {
  constructor(
    private readonly config: RebalancerConfig,
    private readonly rebalancer: IRebalancer, // wrapped
    private readonly messageTracker: MessageTracker,
    private readonly multiProvider: MultiProvider,
    private readonly logger: Logger,
  ) {}

  async rebalance(strategyRoutes: RebalancingRoute[]): Promise<void> {
    // 1. Get current inflight context from MessageTracker
    const context = await this.messageTracker.getInflightContext();

    // 2. Detect stuck transfers (insufficient collateral)
    const stuckTransfers = await this.detectStuckTransfers(context);

    if (stuckTransfers.length === 0) {
      // No stuck transfers, proceed with strategy routes
      return this.rebalancer.rebalance(strategyRoutes);
    }

    // 3. Compute minimal corrective routes
    const correctiveRoutes = await this.computeCorrectiveRoutes(
      stuckTransfers,
      context,
    );

    // 4. Smart merge: corrective routes take precedence
    const mergedRoutes = this.smartMerge(correctiveRoutes, strategyRoutes, context);

    // 5. Delegate to wrapped rebalancer
    return this.rebalancer.rebalance(mergedRoutes);
  }

  /**
   * Detect transfers that cannot be delivered due to insufficient collateral
   * Pre-flight check: compare transfer amount (from Explorer) vs destination balance
   */
  private async detectStuckTransfers(
    context: InflightContext,
  ): Promise<Array<{ message: HyperlaneMessage; shortfall: bigint }>>;

  /**
   * Compute minimal rebalancing routes to unstick transfers
   * Strategy: For each stuck transfer, find cheapest route to deliver needed collateral
   */
  private async computeCorrectiveRoutes(
    stuckTransfers: Array<{ message: HyperlaneMessage; shortfall: bigint }>,
    context: InflightContext,
  ): Promise<RebalancingRoute[]>;

  /**
   * Smart merge with conflict resolution:
   * - Corrective routes always included (highest priority)
   * - Strategy routes that conflict with corrective needs are vetoed
   * - Strategy routes that don't conflict are included
   * - Deduplication
   * 
   * Conflict: Route would drain collateral needed for inflight transfers
   */
  private smartMerge(
    correctiveRoutes: RebalancingRoute[],
    strategyRoutes: RebalancingRoute[],
    context: InflightContext,
  ): RebalancingRoute[];

  /**
   * Check if a route would conflict with required collateral
   * Returns true if route would drain collateral needed for inflight transfers
   */
  private wouldConflict(
    route: RebalancingRoute,
    requiredCollateral: Map<string, bigint>,
  ): boolean;
}
```

**Key Behaviors:**
- Detects stuck transfers by comparing amounts with destination balances
- Computes minimal rebalancing (separate from strategy optimization)
- Smart merge ensures corrective actions not undone by strategy
- Logs all corrective actions for operational visibility
- May alert if inflight rebalance blocks corrective action

#### WithRebalanceValidator (Evolved from WithInflightGuard)

```typescript
class WithRebalanceValidator implements IRebalancer {
  constructor(
    private readonly config: RebalancerConfig,
    private readonly rebalancer: IRebalancer, // wrapped
    private readonly messageTracker: MessageTracker,
    private readonly logger: Logger,
  ) {}

  async rebalance(routes: RebalancingRoute[]): Promise<void> {
    // Empty routes always pass through (optimization)
    if (routes.length === 0) {
      return this.rebalancer.rebalance(routes);
    }

    // Get current inflight context (uses cached data from earlier in cycle)
    // On-chain verification eliminates Explorer API false positives
    const context = await this.messageTracker.getInflightContext();

    // Validate each route individually (surgical, not binary)
    const { validRoutes, vetoedRoutes } = this.validateRoutes(routes, context);

    if (vetoedRoutes.length > 0) {
      this.logger.warn(
        { vetoedCount: vetoedRoutes.length, vetoed: vetoedRoutes },
        'Some routes vetoed due to conflicts with inflight context',
      );
    }

    if (validRoutes.length === 0) {
      this.logger.info('All routes vetoed; skipping this cycle');
      return;
    }

    // Delegate validated routes
    return this.rebalancer.rebalance(validRoutes);
  }

  /**
   * Validate routes against inflight context
   * Surgical veto: evaluate each route independently
   * Veto routes that would:
   * 1. Create duplicate inflight rebalances
   * 2. Drain collateral needed for inflight transfers
   */
  private validateRoutes(
    routes: RebalancingRoute[],
    context: InflightContext,
  ): { validRoutes: RebalancingRoute[]; vetoedRoutes: RebalancingRoute[] };

  /**
   * Check if route duplicates an existing inflight rebalance
   */
  private isDuplicateRebalance(
    route: RebalancingRoute,
    inflightRebalances: HyperlaneMessage[],
  ): boolean;
}
```

**Evolution from WithInflightGuard:**
- **Old:** Binary all-or-nothing blocking based on Explorer API
- **New:** Surgical per-route validation with on-chain verification
- **Benefits:** Fixes false positives, allows partial execution, acts as safety net

### 5.3 Data Flow

#### Cycle Execution Flow

```
1. Strategy computes ideal routes
     ↓
2. WithCorrectiveRebalancing.rebalance(strategyRoutes)
   
   a. MessageTracker.getInflightContext()
      • Query Explorer for inflight rebalances (bridge↔bridge)
      • Query Explorer for inflight transfers (router↔router)
      • For each message in results:
        - Check cache
        - If not cached or stale: verify on-chain via core.isDelivered()
        - Update cache
      • For cached messages not in Explorer results:
        - Mark as delivered (handles indexing gaps)
      • Evict expired cache entries (24h TTL)
      • Compute required collateral from stuck transfers
      • Return: {inflightRebalances, inflightTransfers, requiredCollateral}
   
   b. detectStuckTransfers(context)
      • For each inflight transfer:
        - Get transfer amount (from Explorer API)
        - Query destination collateral balance
        - If balance < amount: compute shortfall
      • Return stuck transfers with shortfalls
   
   c. computeCorrectiveRoutes(stuckTransfers, context)
      • For each stuck transfer:
        - Find cheapest/fastest route to deliver needed collateral
        - Validate source chain has sufficient balance
      • Return minimal corrective routes
   
   d. smartMerge(correctiveRoutes, strategyRoutes, context)
      • Include ALL corrective routes (highest priority)
      • For each strategy route:
        * Check if conflicts with required collateral → VETO
        * Check if duplicates corrective route → SKIP
        * Else → INCLUDE
      • Deduplicate
      • Return merged routes
     ↓
3. WithRebalanceValidator.rebalance(mergedRoutes)
   
   a. MessageTracker.getInflightContext()
      • Uses cached data from step 2a (efficient)
   
   b. validateRoutes(mergedRoutes, context)
      • For each route:
        * Check if duplicates inflight rebalance → VETO
        * Check if conflicts with required collateral → VETO
        * Else → MARK VALID
      • Separate into validRoutes and vetoedRoutes
      • Log vetoes
     ↓
4. ActualRebalancer.rebalance(validRoutes)
   • Execute validated routes
   • Submit transactions
```

#### Cache Update Flow (in MessageTracker)

```
Explorer Query Returns: [M1, M2, M3]
Cache Contains: [M1 (delivered), M2 (undelivered), M4 (undelivered)]

For M1 (in Explorer results):
  - In cache, status=delivered, TTL not expired
  - Action: Skip verification, reset TTL
  
For M2 (in Explorer results):
  - In cache, status=undelivered
  - Action: Verify on-chain via core.isDelivered(M2)
    * If now delivered: Update status=delivered, set TTL
    * If still undelivered: Update lastVerified timestamp
    
For M3 (in Explorer results):
  - Not in cache
  - Action: Verify on-chain via core.isDelivered(M3), add to cache
  
For M4 (NOT in Explorer results):
  - In cache, status=undelivered
  - Explorer stopped tracking it (indexing gap)
  - Action: Set status=delivered, set TTL (24h from now)
  
After 24h TTL expires:
  - M1, M4 no longer in Explorer results and TTL reached
  - Action: Evict from cache (no longer relevant)
```

**Handling Explorer Indexing Gaps:**
- If message was in cache as undelivered but disappears from Explorer query
- Likely means it was delivered but Explorer didn't index the delivery event
- Mark as delivered and set TTL for eventual eviction
- This prevents permanent false positives from permanent indexing gaps

### 5.4 Configuration

New configuration fields in `RebalancerConfig`:

```typescript
interface RebalancerConfig {
  // ... existing fields ...
  
  inflightTracking: {
    cacheTtlMs: number;                     // Default: 86400000 (24h)
    explorerQueryLimit: number;             // Default: 100 messages
    explorerQueryDaysBack: number;          // Default: 3 days
    enableOnChainVerification: boolean;     // Default: true
    enableCorrectiveRebalancing: boolean;   // Default: true
    enableValidator: boolean;               // Default: true (safety net)
  };
}
```

### 5.5 On-Chain Verification Implementation

**Approach:** Reuse pattern from CLI `status` command

**Reference Code:** `typescript/cli/src/status/message.ts`

**Key SDK Methods:**
```typescript
// Initialize HyperlaneCore from registry addresses
const core = HyperlaneCore.fromAddressesMap(
  coreAddresses,
  multiProvider,
);

// Check if message was delivered (line 74 in status/message.ts)
const delivered: boolean = await core.isDelivered(message);

// Optional: Get delivery transaction receipt
if (delivered) {
  const processedReceipt = await core.getProcessedReceipt(message);
  const txHash = processedReceipt.transactionHash;
}
```

**MessageTracker Integration:**
```typescript
private async checkDeliveryOnChain(
  msg: HyperlaneMessage
): Promise<DeliveryStatus> {
  try {
    // For EVM chains
    if (this.chainManager.isEvmChain(msg.destinationChain)) {
      const delivered = await this.core.isDelivered(msg);
      return delivered ? DeliveryStatus.DELIVERED : DeliveryStatus.UNDELIVERED;
    }
    
    // For non-EVM chains (Solana, etc.) - designed for future implementation
    // Currently return UNKNOWN and log warning
    this.logger.warn(
      { chain: msg.destinationChain, msgId: msg.msgId },
      'Delivery verification not yet supported for non-EVM chain'
    );
    return DeliveryStatus.UNKNOWN;
    
  } catch (error) {
    this.logger.error(
      { msgId: msg.msgId, error },
      'Failed to verify delivery on-chain'
    );
    return DeliveryStatus.UNKNOWN;
  }
}
```

**Non-EVM Design Considerations:**
- Architecture designed to support non-EVM chains (especially Solana)
- Interface supports UNKNOWN delivery status
- SDK needs to add non-EVM verification methods in future
- MessageTracker can be enhanced without architectural changes
- For now: treat UNKNOWN conservatively (same as UNDELIVERED)

---

## 6. Risk Assessment

### 6.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|---------|------------|
| **Infinite rebalancing loop** (corrective creates new stuck transfer) | Medium | High | Validate source balance before corrective action; Monitor consecutive corrective cycles; Alert if > N cycles; Track corrective actions in logs |
| **Cache inconsistency** (Explorer data flapping) | Low | Medium | Once marked delivered, never revert to undelivered; On-chain verification is source of truth; Cache handles indexing gaps |
| **Strategy starvation** (all routes repeatedly vetoed) | Low | Medium | Metrics on veto rate; Alert on sustained high veto rate; Indicates misconfigured strategy or persistent issue |
| **Explorer API unavailable** | Medium | Medium | Graceful degradation: proceed with cached data; Alert on API failures; Cache provides recent state |
| **On-chain query rate limits** | Low | Low | Cache reduces query volume (only verify uncached or stale); Consider batch queries if needed |
| **Non-EVM message handling** | High | Medium | Accept limitation for initial release; Treat as UNKNOWN; Log warnings; Design supports future implementation |
| **Strategy undoes corrective rebalance** | Medium | High | Smart merge vetos conflicting strategy routes; Pass inflight context to strategies; Monitor time-to-delivery after corrective action |
| **Corrective rebalance stuck itself** | Medium | High | MessageTracker will detect it as inflight; Won't duplicate corrective action; May need manual intervention; Alert if corrective stuck > threshold |

### 6.2 Operational Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|---------|------------|
| **Increased complexity** delays debugging | Medium | Medium | Comprehensive logging at each component; Clear component boundaries; Good test coverage; Updated runbook |
| **False sense of security** from automation | Low | High | Maintain operational visibility; Alert on all corrective actions; Regular review of stuck transfer patterns; Metrics dashboards |
| **Corrective rebalance conflicts with manual ops** | Low | Low | Document corrective logic clearly; Consider "maintenance mode" flag to disable; Log all corrective decisions |
| **Unexpected behavior with high-volume routes** | Medium | Medium | Test with realistic message volumes; Monitor performance metrics; May need message age threshold or sampling |
| **Alert fatigue** from new alerting | Low | Medium | Tune alert thresholds carefully; Only alert on actionable items; Distinguish info vs critical alerts |

### 6.3 Risk Mitigation Summary

**High Priority:**
- Implement loop detection and consecutive cycle limit alerting
- Comprehensive logging for all decision points (corrective, merge, veto)
- Metrics dashboard for stuck transfer detection and corrective actions
- Runbook updates for manual intervention scenarios
- Monitor time between corrective action and message delivery

**Medium Priority:**
- Performance testing with high message volumes
- Explorer API failure handling and fallback strategies
- Strategy veto rate monitoring and alerting
- Cache hit rate monitoring

**Low Priority:**
- Non-EVM chain support (future enhancement, architecture ready)
- Optimization of corrective route selection (multi-hop, gas efficiency)
- Persistent cache for crash recovery (in-memory sufficient initially)

---

## 7. Implementation Plan

### 7.1 Phases

#### Phase 1: Foundation (MessageTracker & ExplorerClient Enhancement)
**Goal:** Unified message tracking with on-chain verification

**Tasks:**
1. Enhance `ExplorerClient` to support transfer queries (router↔router)
   - Add method to query undelivered transfers (similar to rebalances)
   - Parse transfer amounts from Explorer API response
2. Implement `MessageTracker` class
   - Unified cache (Map<msgId, CachedMessage>)
   - Query both rebalances and transfers from Explorer
   - On-chain verification using `core.isDelivered()` pattern
   - Cache maintenance (TTL, reconciliation, eviction)
   - Compute required collateral from stuck transfers
3. Unit tests for MessageTracker
   - Cache hit/miss scenarios
   - TTL expiration
   - Explorer gap handling (message disappears from query)
   - On-chain verification mocking
   - Cache persistence across invocations

**Completion Criteria:**
- [ ] ExplorerClient can query both rebalances and transfers
- [ ] MessageTracker returns accurate InflightContext
- [ ] Cache handles Explorer indexing gaps correctly
- [ ] Tests cover all cache scenarios (hit, miss, TTL, reconciliation)
- [ ] On-chain verification working for EVM chains

**Estimated Effort:** 3-5 days

**Dependencies:** None

#### Phase 2: Validator Evolution (WithInflightGuard → WithRebalanceValidator)
**Goal:** Transform binary guard into surgical validator with on-chain verification

**Tasks:**
1. Create `WithRebalanceValidator` class (copy & refactor from `WithInflightGuard`)
2. Integrate with `MessageTracker` (replace direct Explorer calls)
3. Implement per-route validation logic (instead of binary block)
   - Check each route for duplicate inflight rebalance
   - Check each route for collateral conflict
   - Separate valid vs vetoed routes
4. Update tests (based on `WithInflightGuard.test.ts` pattern)
   - Test empty routes passthrough
   - Test surgical veto (some routes valid, some vetoed)
   - Test all vetoed scenario
   - Test Explorer error handling
   - Mock MessageTracker for unit tests
5. Integration test with real MessageTracker
6. Documentation and logging enhancements

**Completion Criteria:**
- [ ] Validator can veto individual routes (not whole cycle)
- [ ] On-chain verification eliminates false positives
- [ ] All existing WithInflightGuard test scenarios pass
- [ ] New tests for surgical veto scenarios
- [ ] Logging shows which routes vetoed and why

**Estimated Effort:** 2-3 days

**Dependencies:** Phase 1 (MessageTracker)

#### Phase 3: Corrective Rebalancing
**Goal:** Autonomous stuck transfer detection and fixing

**Tasks:**
1. Implement `WithCorrectiveRebalancing` class skeleton
   - IRebalancer interface
   - Integration with MessageTracker
   - Wrapper pattern (delegates to next rebalancer)
2. Implement `detectStuckTransfers` logic
   - Get transfer amounts from Explorer API (via MessageTracker)
   - Query destination collateral balances
   - Compute shortfalls
3. Implement `computeCorrectiveRoutes` logic
   - For each stuck transfer, find cheapest route
   - Validate source chain has sufficient balance
   - Minimal rebalancing strategy
4. Implement `smartMerge` algorithm
   - Include all corrective routes
   - For each strategy route: check conflicts, deduplicate
   - Veto strategy routes that would drain needed collateral
5. Unit tests for each component
   - Stuck transfer detection (various scenarios)
   - Corrective route computation
   - Smart merge (corrective + strategy, conflicts, dedup)
6. Integration tests with mocked MessageTracker and strategy
7. Add logging, metrics, alerting hooks
8. Consider: Strategy-aware inflight context (complexity evaluation)

**Completion Criteria:**
- [ ] Detects stuck transfers correctly (compare amount vs balance)
- [ ] Computes valid minimal corrective routes
- [ ] Smart merge prioritizes corrective routes properly
- [ ] Tests cover conflict resolution cases
- [ ] Tests cover scenarios: no stuck transfers, multiple stuck, insufficient source balance
- [ ] Logging shows corrective decisions clearly
- [ ] Strategy veto scenarios tested

**Estimated Effort:** 5-7 days

**Dependencies:** Phase 1 (MessageTracker)

#### Phase 4: Integration & Testing
**Goal:** End-to-end validation and composition wiring

**Tasks:**
1. Wire up composition chain in CLI rebalancer instantiation
   ```typescript
   const messageTracker = new MessageTracker(...);
   const actualRebalancer = new Rebalancer(...);
   const validator = new WithRebalanceValidator(config, actualRebalancer, messageTracker, logger);
   const corrective = new WithCorrectiveRebalancing(config, validator, messageTracker, multiProvider, logger);
   // Use corrective as main rebalancer
   ```
2. Add configuration options to RebalancerConfig
   - inflightTracking section with defaults
   - Feature flags for corrective and validator
3. End-to-end tests with mock Explorer and on-chain
   - Full cycle execution
   - False positive correction flow
   - Stuck transfer detection and fix
   - Cache persistence across cycles
   - Multiple concurrent stuck transfers
4. Test scenarios:
   - Strategy proposes conflicting route: vetoed
   - Corrective and strategy propose same route: dedup
   - Corrective rebalance becomes inflight: no duplicate on next cycle
   - Explorer API failure: graceful degradation with cache
5. Performance testing
   - High-volume message scenarios
   - Cache performance under load
   - On-chain query patterns
6. Documentation updates
   - Code comments
   - Runbook updates
   - Architecture diagrams
   - Configuration guide

**Completion Criteria:**
- [ ] Full cycle executes correctly end-to-end
- [ ] All test scenarios pass
- [ ] Performance acceptable (cycle completes within interval)
- [ ] Configuration properly integrated
- [ ] Documentation complete and reviewed
- [ ] No regressions in existing rebalancer functionality

**Estimated Effort:** 3-4 days

**Dependencies:** Phases 1, 2, 3

#### Phase 5: Deployment & Validation
**Goal:** Safe production rollout with monitoring

**Tasks:**
1. Deploy to test environment (testnet warp routes)
2. Shadow mode operation (recommended first step)
   - Deploy with `enableCorrectiveRebalancing: false`
   - MessageTracker and Validator active
   - Log what corrective actions *would* be taken
   - Monitor for false positives/negatives
   - Tune parameters if needed
3. Limited rollout
   - Enable for single low-volume warp route
   - Full functionality active
   - Close monitoring for 48+ hours
   - Validate corrective actions work correctly
4. Create metrics dashboard
   - Stuck transfer detection count
   - Corrective rebalance count
   - Veto rate (strategy routes)
   - Cache hit rate
   - On-chain verification errors
   - Explorer API errors
5. Set up alerting
   - Corrective action triggered (info level)
   - Multiple consecutive corrective cycles (warning)
   - All routes vetoed (warning)
   - Explorer API unavailable (error)
   - Corrective rebalance stuck (error)
6. Document operational characteristics
   - Typical cache hit rates
   - Expected veto rates
   - Common corrective action patterns
   - Troubleshooting guide
7. Train on-call team
   - New alerting
   - How to interpret logs
   - When to intervene manually
   - Maintenance mode flag usage
8. Full production rollout
   - Enable for all warp routes
   - Gradual rollout if possible
   - Ongoing monitoring for 1+ week
   - Iterate based on learnings

**Completion Criteria:**
- [ ] Stable operation in test environment for 48+ hours
- [ ] At least one stuck transfer successfully detected and fixed
- [ ] No infinite rebalancing loops observed
- [ ] Metrics show expected behavior
- [ ] Alerting properly configured and tested
- [ ] Runbook updated with new procedures
- [ ] On-call team trained and comfortable
- [ ] False positive rate reduced by >50% from baseline

**Estimated Effort:** 2-3 days active work + monitoring periods

**Dependencies:** Phase 4

**Total Estimated Effort:** 15-22 days active development + monitoring periods

### 7.2 Testing Strategy

#### Unit Tests

**MessageTracker:**
- Cache operations (get, set, update)
- TTL expiration logic
- Explorer result reconciliation
- Message disappearance from Explorer (indexing gap handling)
- On-chain verification success/failure
- Required collateral computation
- Error handling (Explorer API failures, SDK errors)

**WithCorrectiveRebalancing:**
- Stuck transfer detection (various balance/amount scenarios)
- Corrective route computation (single, multiple stuck transfers)
- Smart merge algorithm (conflicts, duplicates, dedup)
- Edge cases: insufficient source balance, no stuck transfers
- Strategy route veto logic

**WithRebalanceValidator:**
- Per-route validation (valid, vetoed)
- Duplicate detection
- Collateral conflict detection
- Empty routes passthrough
- All routes vetoed scenario
- Error propagation

**Test Tooling:**
- Mock `ExplorerClient` for controlled message data
- Mock `HyperlaneCore` for delivery verification
- Mock strategies for route generation
- Test fixtures for various message/route scenarios
- Pattern: Follow `WithInflightGuard.test.ts` structure (Sinon stubs, Chai assertions)

#### Integration Tests

**Multi-Component Scenarios:**
- Full cycle: Strategy → Corrective → Validator → Actual
- MessageTracker used by both Corrective and Validator
- Cache persistence across multiple cycles
- False positive correction: Explorer says undelivered, chain says delivered
- Stuck transfer end-to-end: detection → corrective route → execution
- Multiple concurrent stuck transfers
- Corrective rebalance becomes inflight in next cycle

**Explorer API Scenarios:**
- Explorer unavailable: graceful degradation with cache
- Explorer returns empty results
- Explorer returns large result set
- Message appears and disappears from Explorer results

**Performance Tests:**
- High-volume warp routes (many inflight messages)
- Cache performance (large cache size)
- On-chain verification under load
- Cycle completion time

#### E2E Tests

**Test Environment:**
- Deploy to testnet with real contracts
- Real Explorer API (testnet instance)
- Real on-chain verification

**Scenarios:**
- Simulate stuck transfer (drain destination collateral)
- Verify detection within 1 cycle
- Verify corrective rebalance initiated
- Verify message eventually delivers
- Verify strategy continues normal operation
- Verify no infinite loops

**Validation:**
- Monitor logs for expected behavior
- Check metrics dashboard
- Verify alerts triggered appropriately
- Confirm manual intervention not needed

### 7.3 Rollout Strategy

#### Stage 1: Shadow Mode (Recommended - 1 week)
**Configuration:**
```typescript
{
  enableOnChainVerification: true,
  enableCorrectiveRebalancing: false,  // Shadow mode
  enableValidator: true,
}
```

**Activities:**
- MessageTracker active, building cache
- Validator active with on-chain verification (fixes false positives)
- Corrective logic runs but only logs (doesn't execute)
- Monitor logs for:
  - Would-be corrective actions
  - False positive corrections
  - Cache behavior
  - Any unexpected patterns

**Exit Criteria:**
- False positive rate significantly reduced
- Corrective logic detects expected stuck transfers
- No unexpected behaviors
- Cache performing well

#### Stage 2: Limited Rollout (1 week)
**Target:** Single low-volume warp route

**Configuration:**
```typescript
{
  enableOnChainVerification: true,
  enableCorrectiveRebalancing: true,   // Enabled
  enableValidator: true,
}
```

**Activities:**
- Full functionality active
- Close monitoring 24/7 for first 48 hours
- Validate corrective actions work correctly
- Check for infinite loops
- Monitor time-to-delivery after corrective action
- Gather operational data

**Exit Criteria:**
- At least one stuck transfer successfully fixed
- No infinite loops
- No operational issues
- Metrics within expected ranges

#### Stage 3: Full Rollout (2+ weeks)
**Target:** All warp routes

**Activities:**
- Enable for all routes (gradually if possible)
- Continue close monitoring
- Iterate on parameters (TTL, thresholds, etc.)
- Refine alerting based on actual patterns
- Document common scenarios and resolutions

**Success Indicators:**
- Reduced on-call interventions (target: 80% reduction)
- High autonomous resolution rate (target: >90%)
- Low false positive rate (target: <5%)
- Stable operation with no manual intervention needed

---

## 8. Open Questions

### 8.1 Technical Questions - RESOLVED

**Q1: Transfer Amount Extraction** ✅ **RESOLVED**
- **Answer:** Explorer API provides transfer amounts directly in query results
- **Action:** Parse amount from Explorer API response in MessageTracker

**Q2: On-Chain Verification SDK Integration** ✅ **RESOLVED**
- **Answer:** Reuse pattern from CLI `status` command
- **Reference:** `typescript/cli/src/status/message.ts` line 74
- **Method:** `core.isDelivered(message)` from HyperlaneCore
- **Action:** Implement in `MessageTracker.checkDeliveryOnChain()`

**Q3: Composition Wiring** ✅ **CLARIFIED**
- **Answer:** MessageTracker is new shared service component
- **Purpose:** Provides unified message tracking and verification to both WithCorrectiveRebalancing and WithRebalanceValidator
- **Instantiation:** Created once, injected into both decorators in composition chain
- **Action:** Wire up in CLI rebalancer initialization (Phase 4)

**Q4: Non-EVM Support** ✅ **RESOLVED**
- **Answer:** Design for non-EVM support from the start
- **Priority Chain:** Solana (highest need)
- **Approach:** 
  - Architecture supports UNKNOWN delivery status
  - EVM implementation in Phase 1
  - Non-EVM implementation future enhancement
  - SDK needs to add verification methods for Solana, etc.
- **Action:** Design interfaces to accommodate, implement EVM first, document extension points

### 8.2 Product/Operational Questions - OPEN

**Q5: Corrective Action Visibility**
- What level of alerting when corrective rebalancing triggers?
  - Info: Every corrective action?
  - Warning: Only after N consecutive corrective cycles?
  - Error: Only if corrective rebalance itself stuck?
- Should corrective actions go through approval workflow initially (shadow mode)?
- What metrics should we track in dashboard?
  - Stuck transfer count
  - Corrective rebalance count
  - Time from detection to delivery
  - Veto rate
  - Cache hit rate

**Q6: Parameter Tuning**
- How to determine optimal cache TTL in practice? (24h default reasonable?)
- What veto rate indicates a problem? (>10%?)
- Should cycle interval change with new features?
- What's acceptable delay for stuck transfer detection? (1 cycle ok?)

**Q7: Failure Modes**
- What should happen if corrective rebalance itself fails to execute?
  - Retry on next cycle?
  - Alert immediately?
  - Max retry count?
- Should we have max retries for same stuck transfer?
- When should we escalate to manual intervention?
  - After N failed corrective attempts?
  - If source chains lack sufficient collateral?

**Q8: High-Volume Routes**
- For warp routes with constant high volume, there will always be inflight transfers
- Should we have message age threshold (only care about stuck > N minutes)?
  - Allows normal in-transit messages to complete
  - Focuses on truly stuck transfers
- Should we sample instead of checking all inflight transfers?
  - Performance optimization
  - Risk: miss some stuck transfers
- Suggested approach?

**Q9: Strategy Interface Enhancement**
- Should we pursue full strategy-aware inflight context?
- Or is smart merge + validator sufficient for v1?
- How much strategy starvation (vetoed routes) is acceptable before we enhance strategies?

**Q10: Maintenance Mode**
- Should we add a "maintenance mode" flag to disable autonomous actions?
  - For manual operational procedures
  - During incident response
  - For testing
- What should maintenance mode disable?
  - Just corrective rebalancing?
  - Everything (including validator)?

---

## 9. Success Metrics

### 9.1 Quantitative Metrics

#### Primary Metrics (Success Criteria)

**False Positive Rate:**
- **Definition:** % of rebalancing cycles incorrectly blocked due to Explorer indexing gaps
- **Current Baseline:** Estimated 20-30% (based on operational experience)
- **Target:** <5%
- **Measurement:** 
  - Count cycles blocked by validator
  - Check if on-chain verification would have allowed them
  - Calculate: (false positive blocks / total blocks) * 100

**Stuck Transfer Detection Rate:**
- **Definition:** % of stuck transfers detected within 1 cycle of becoming stuck
- **Target:** >95%
- **Measurement:**
  - From logs: time message became stuck (collateral < amount)
  - From logs: time message detected by corrective logic
  - Calculate: detected within 1 cycle / total stuck

**Autonomous Resolution Rate:**
- **Definition:** % of stuck transfers resolved without manual intervention
- **Target:** >90%
- **Measurement:**
  - Count stuck transfers detected
  - Count stuck transfers that delivered after corrective action
  - Count manual interventions
  - Calculate: (auto-resolved / total stuck) * 100

**On-Call Intervention Reduction:**
- **Definition:** Reduction in incidents requiring manual rebalancing
- **Current Baseline:** ~10-20 incidents/month (estimate)
- **Target:** 80% reduction (2-4 incidents/month)
- **Measurement:** Track on-call incidents related to stuck transfers

#### Secondary Metrics (Operational Health)

**Cache Hit Rate:**
- **Target:** >70%
- **Measurement:** (cache hits / total message lookups) * 100
- **Indicates:** Cache effectiveness, reduces on-chain query load

**Strategy Veto Rate:**
- **Target:** <10% of strategy routes vetoed
- **Measurement:** (vetoed strategy routes / total strategy routes) * 100
- **Indicates:** How often corrective needs conflict with strategy
- **Alert if:** >20% sustained for multiple cycles (indicates problem)

**Corrective Rebalance Success Rate:**
- **Target:** >95% of corrective rebalances execute successfully
- **Measurement:** (successful corrective executions / attempted) * 100
- **Indicates:** Quality of corrective route computation

**Average Time to Detect:**
- **Target:** <1 cycle interval (typically 15-30 minutes)
- **Measurement:** Time from message becoming stuck to detection
- **Indicates:** Detection latency

**Average Time to Resolve:**
- **Target:** <30 minutes from detection to delivery
- **Measurement:** Time from detection to message delivery
- **Indicates:** Effectiveness of corrective action + relayer pickup

**On-Chain Verification Error Rate:**
- **Target:** <5%
- **Measurement:** (verification errors / total verifications) * 100
- **Indicates:** SDK reliability, RPC health

**Explorer API Availability:**
- **Target:** >99% (given we have cache fallback)
- **Measurement:** (successful queries / total queries) * 100
- **Indicates:** Dependency health

### 9.2 Qualitative Success Criteria

**Operational Excellence:**
- [ ] Reduced operational toil (measured via on-call surveys)
- [ ] Improved user experience (fewer support tickets for stuck transfers)
- [ ] Increased system confidence (team comfortable relying on automation)
- [ ] Clear operational visibility (dashboards show system health at a glance)

**Code Quality:**
- [ ] Maintainable codebase (clear component boundaries, good test coverage)
- [ ] Easy to debug (comprehensive logging, clear error messages)
- [ ] Easy to extend (non-EVM support, new corrective strategies)
- [ ] Well-documented (code comments, runbook, architecture docs)

**Team Readiness:**
- [ ] On-call team trained and comfortable with new system
- [ ] Runbook updated with new procedures
- [ ] Incident response procedures documented
- [ ] Escalation paths clear

### 9.3 Acceptance Criteria

#### Must Have (MVP Launch Blockers)

- [ ] **False positive rate reduced by >50%** (from ~25% to <12.5%)
- [ ] **At least one stuck transfer automatically resolved** in test environment
- [ ] **No infinite rebalancing loops** observed in 1 week of test environment operation
- [ ] **All unit tests pass** (>95% code coverage for new components)
- [ ] **All integration tests pass**
- [ ] **Documentation complete:**
  - [ ] Architecture documented
  - [ ] Code comments on complex logic
  - [ ] Configuration guide
  - [ ] Runbook updated
- [ ] **Deployment successful** to test environment
- [ ] **No regressions** in existing rebalancer functionality

#### Should Have (Highly Desired)

- [ ] **Metrics dashboard operational** with all primary metrics
- [ ] **Alerting configured** for:
  - [ ] Corrective actions (info level)
  - [ ] Multiple consecutive corrective cycles (warning)
  - [ ] Explorer API failures (error)
  - [ ] All routes vetoed (warning)
- [ ] **On-call team trained** on new system
- [ ] **Shadow mode validation** complete (1 week of observation)
- [ ] **Performance validated** (cycle completes within interval even with high message volume)

#### Nice to Have (Future Enhancements)

- [ ] **Non-EVM support roadmap** defined (especially Solana)
- [ ] **Strategy-aware inflight context** evaluated and documented
- [ ] **Performance optimizations** for high-volume routes
- [ ] **Persistent cache** design documented for future
- [ ] **Multi-hop corrective rebalancing** optimization explored

### 9.4 Go/No-Go Criteria for Production

Before full production rollout (Stage 3), must demonstrate:

1. ✅ **Test Environment Stability:** 48+ hours stable operation, no crashes or errors
2. ✅ **False Positive Elimination:** On-chain verification working, no false blocks
3. ✅ **Corrective Action Success:** At least one stuck transfer fixed autonomously
4. ✅ **No Loop Behavior:** No infinite rebalancing loops detected
5. ✅ **Performance Acceptable:** Cycle completes within configured interval
6. ✅ **Monitoring Ready:** Dashboard shows all key metrics, alerts configured
7. ✅ **Team Ready:** On-call trained, runbook updated, comfortable with system
8. ⚠️ **Limited Rollout Success:** Single warp route operated successfully for 1 week

**Go Decision Requires:** All ✅ criteria met, ⚠️ criterion met or waived with mitigation plan

---

## Appendices

### A. Glossary

- **Rebalance Message:** Cross-chain transfer between bridge contracts to redistribute liquidity across a warp route
- **Warp Transfer:** User-initiated cross-chain token transfer via warp route (router↔router)
- **Inflight Message:** Message dispatched on origin chain but not yet delivered on destination chain
- **Stuck Transfer:** Inflight transfer that cannot deliver due to insufficient destination collateral
- **Corrective Rebalancing:** Automated rebalancing initiated by the system to fix stuck transfers
- **False Positive:** Message incorrectly reported as undelivered when actually delivered (Explorer indexing gap)
- **Explorer API:** GraphQL interface to indexed Hyperlane message data (dispatch and delivery events)
- **MessageTracker:** New shared service component providing unified message tracking and verification
- **On-Chain Verification:** Direct query to blockchain to check message delivery status via SDK
- **Smart Merge:** Algorithm that combines corrective and strategy routes with conflict resolution
- **Surgical Veto:** Per-route validation (not binary all-or-nothing blocking)
- **Required Collateral:** Amount of collateral needed on a destination chain to deliver inflight transfers
- **Cache Reconciliation:** Process of updating cache based on Explorer results and handling indexing gaps
- **Strategy Undo:** Problem where strategy rebalances away collateral needed for stuck transfer

### B. References

**Documentation:**
- Hyperlane Docs: https://docs.hyperlane.xyz
- Operations Runbook: [Notion link - AI Agent Runbook]
- Operational Debugging Guide: `docs/ai-agents/operational-debugging.md`

**Code References:**
- Current Inflight Guard: `typescript/cli/src/rebalancer/core/WithInflightGuard.ts`
- Explorer Client: `typescript/cli/src/rebalancer/utils/ExplorerClient.ts`
- CLI Status Command: `typescript/cli/src/status/message.ts` (on-chain verification pattern)
- Guard Tests: `typescript/cli/src/rebalancer/core/WithInflightGuard.test.ts`
- Rebalancer Config: `typescript/infra/helm/rebalancer/values.yaml`

**Monitoring:**
- Grafana Dashboards: [links to be added]
- Metrics: [prometheus endpoints to be documented]

### C. Design Discussion History

**Key Discussion Points:**
1. **Composability vs Monolithic:** Decided on composable IRebalancer chain for testability and incremental rollout
2. **Cache Strategy:** Chose in-memory with TTL and reconciliation over persistent or no-cache approaches
3. **Corrective Strategy:** Minimal rebalancing (separate from strategy) vs delegation to strategy - chose minimal for clarity
4. **Guard Evolution:** Transform to surgical validator vs remove entirely - chose evolution for safety net
5. **Strategy Awareness:** Defer full strategy enhancement, start with smart merge and validator, evaluate based on veto rate

**Rationale Documentation:**
- Each design decision includes options considered and rationale
- Tradeoffs documented for future reference
- Open questions tracked for resolution before implementation

### D. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-11-20 | Hyperlane Team | Initial design document |

---

## Next Steps

### Immediate Actions (Before Implementation)

1. **Review & Feedback Round 1:**
   - Share with engineering team for technical review
   - Share with ops team for operational feasibility review
   - Gather feedback on design decisions
   - Timeline: 2-3 days

2. **Resolve Open Questions (Section 8.2):**
   - Q5: Alerting levels and metrics (consult with ops team)
   - Q6: Parameter defaults (based on operational data)
   - Q7: Failure mode handling (define escalation criteria)
   - Q8: High-volume route handling (performance testing needed?)
   - Q9: Strategy enhancement priority (defer or include?)
   - Q10: Maintenance mode requirements
   - Timeline: 1-2 days

3. **Technical Deep Dive:**
   - Review SDK methods for on-chain verification
   - Confirm Explorer API capabilities for transfer queries
   - Validate MessageTracker architecture with SDK team
   - Identify potential performance bottlenecks
   - Timeline: 1 day

4. **Approval:**
   - Get sign-off from tech lead
   - Get sign-off from product owner (operational impact)
   - Confirm resource allocation for 15-22 day implementation
   - Timeline: 1-2 days

### Implementation Kickoff

5. **Phase 1 Start (Week 1):**
   - Set up development branch
   - Begin MessageTracker implementation
   - Daily standups for progress/blockers
   - Timeline: See Phase 1 in Implementation Plan (3-5 days)

6. **Iterative Review:**
   - Demo after each phase completion
   - Adjust design based on implementation learnings
   - Update this document with any architectural changes

### Success Tracking

7. **Metrics Collection:**
   - Establish baseline metrics before deployment
   - Track metrics during each rollout stage
   - Compare against targets in Section 9

8. **Post-Deployment Review:**
   - 1 week after full rollout: operational review
   - 1 month after: success metrics evaluation
   - Document lessons learned and future enhancements

---

**Document Status:** Ready for Review  
**Next Action:** Engineering team review and feedback  
**Target Implementation Start:** [To be determined after approval]

**Questions or feedback?** Contact: [Your team contact]
