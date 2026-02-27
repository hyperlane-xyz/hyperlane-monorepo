# Indexing V2: Real-time Indexing with Reorg Handling

**Status:** Draft
**Date:** 2026-01-29

---

## Executive Summary

Hyperlane agents currently index blockchain data with a fixed delay (`reorgPeriod`) to avoid processing data that might disappear due to chain reorganizations. This causes unnecessary latency for users while still failing to handle reorgs when they occur. We need indexing that is both faster (index at chain tip) and safer (automatic reorg recovery).

---

## Problem Statement

### Problem 1: Unnecessary Latency

Agents wait `reorgPeriod` blocks before considering data "safe" to process. This delay exists even when no reorgs occur (99.9%+ of the time), penalizing all users for rare edge cases.

**Impact:**

- Explorer users see message status minutes behind actual chain state
- Message relaying delayed by reorgPeriod on origin chain before relay can begin
- Validators sign checkpoints later than necessary

### Problem 2: Limited Reorg Handling

Agents have limited or no reorg recovery:

- **Validator:** Detects reorgs via merkle root mismatch (local vs on-chain), but crashes on detection requiring manual intervention. This is fail-safe but not self-healing.
- **Relayer:** No reorg detection. May attempt to deliver messages that no longer exist.
- **Scraper:** No reorg detection. Database contains events from orphaned blocks with no correction.

**Impact:**

- Manual operator intervention required (especially for validator)
- Potential for stuck or failed message processing
- Data integrity issues in Explorer and analytics

### Problem 3: Duplicated Indexing Work

Relayer, validator, and scraper each independently index the same blockchain events. For a single chain, the same `Dispatch` event may be fetched and processed three times.

**Impact:**

- 3x RPC calls for the same data
- Higher infrastructure costs
- Increased load on RPC providers

### Problem 4: Missing Reorg Data

When reorgs occur, we lose valuable information about what changed. Data pipeline has no visibility into chain reliability or message "resurrection" (messages that reorged away then reappeared).

**Impact:**

- Cannot measure chain reliability
- Cannot debug issues caused by reorgs
- Incomplete picture for analytics and monitoring

---

## Users and Requirements

### User 1: Explorer User

**Description:** End user checking message status on Hyperlane Explorer.

**User Stories:**

| ID   | Story                                                                                                                                                          | Priority |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| EU-1 | As an Explorer user, I want to see my message status within seconds of the on-chain event, so I don't have to wait minutes wondering if my transaction worked. | P0       |
| EU-2 | As an Explorer user, I want to see block depth/age for events, so I can understand the confidence level of what I'm seeing.                                    | P1       |
| EU-3 | As an Explorer user, I want to be notified if a message I was tracking gets affected by a reorg, so I understand why the status changed.                       | P2       |

---

### User 2: Relayer Operator

**Description:** Operator running relayer infrastructure to deliver messages.

**User Stories:**

| ID     | Story                                                                                                                                                                 | Priority |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| RO-1   | As a relayer operator, I want the relayer to automatically recover from reorgs without manual intervention, so I don't get paged for chain issues outside my control. | P0       |
| RO-2\* | As a relayer operator, I want to configure how "confirmed" a message must be before relaying, so I can balance speed vs safety per chain.                             | P1       |
| RO-3   | As a relayer operator, I want visibility into messages that are pending confirmation vs ready to relay, so I can monitor pipeline health.                             | P1       |
| RO-4   | As a relayer operator, I want reduced RPC usage when running multiple agents for the same chain, so I can lower infrastructure costs.                                 | P2       |

_\*RO-2: Should relayer rely on validators for confirmation decisions? If validators have already signed a checkpoint, the message is implicitly confirmed from the protocol's perspective._

---

### User 3: Validator Operator

**Description:** Operator running validator infrastructure to sign checkpoints.

**User Stories:**

| ID   | Story                                                                                                                                                                    | Priority |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| VO-1 | As a validator operator, I want the validator to only sign checkpoints for sufficiently confirmed data, so I don't sign checkpoints that could be invalidated by reorgs. | P0       |
| VO-2 | As a validator operator, I want to know if a checkpoint I signed is affected by a reorg, so I can assess any security implications.                                      | P0       |
| VO-3 | As a validator operator, I want to see how far behind the chain tip my validator is indexing, so I can monitor operational health.                                       | P1       |

---

### User 4: Data/Analytics Team

**Description:** Internal team building dashboards, analytics, and monitoring.

**User Stories:**

| ID     | Story                                                                                                                                                                                | Priority                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| DA-1   | As a data analyst, I want access to reorg event data (what changed, when, which blocks), so I can measure chain reliability.                                                         | P1                          |
| DA-2   | As a data analyst, I want to see both "before reorg" and "after reorg" states for affected messages, so I can understand the full history.                                           | P1                          |
| DA-3   | As a data analyst, I want to query events by block depth/age, so I can build dashboards with appropriate confidence levels for different use cases.                                  | P2                          |
| DA-4\* | As a data analyst, I want all events from Hyperlane protocol transactions indexed (not just Mailbox events), so I can analyze application-level behavior and build richer analytics. | P0 (Dispatch), P1+ (others) |

_\*DA-4: Dispatch transaction indexing is P0. Do we need full transaction events for Process, GasPayment, and MerkleTreeInsertion transactions?_

---

### User 5: Rebalancer Operator

**Description:** Operator running rebalancer infrastructure to maintain warp route collateral across chains.

**Context:** Rebalancer queries Explorer GraphQL API (`message_view`) to track inflight user transfers and its own rebalance actions. It reserves collateral for incoming transfers and simulates balances based on pending operations. Currently relies on Explorer data being at reorgPeriod depth for safety.

**User Stories:**

| ID   | Story                                                                                                                                                                                      | Priority |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| RB-1 | As a rebalancer operator, I want to query only confirmed transfers when making collateral decisions, so I don't reserve collateral for transfers that may reorg away.                      | P0       |
| RB-2 | As a rebalancer operator, I want to distinguish between confirmed and unconfirmed inflight messages in Explorer queries, so I can choose the appropriate confidence level for my use case. | P0       |
| RB-3 | As a rebalancer operator, I want the system to automatically update my view of inflight transfers if a reorg invalidates them, so I don't have stale reservations blocking collateral.     | P1       |
| RB-4 | As a rebalancer operator, I want to see unconfirmed transfers for monitoring purposes (without acting on them), so I can anticipate upcoming collateral needs.                             | P2       |

---

## Assumptions

1. **Confirmation is consumer-defined.** The indexer provides raw event data with block metadata (number, hash, timestamp). Each consumer determines what "confirmed" means for their use case (e.g., block depth, time elapsed, validator signatures). The indexer does not track or enforce confirmation status.

2. **Reorg detection is indexer responsibility.** The indexer detects reorgs and marks affected data. Consumers decide how to react (alert, re-query, ignore).

---

## Requirements

### Functional Requirements

| ID    | Requirement                                                                                                                                          | User Stories             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| FR-1  | System shall index blockchain events at chain tip (0 block delay)                                                                                    | EU-1                     |
| FR-2  | System shall provide block metadata (number, hash, timestamp) with each event, enabling consumers to determine confirmation status                   | EU-2, RO-2\*, VO-1, DA-3 |
| FR-3  | System shall detect chain reorganizations automatically                                                                                              | RO-1, VO-2               |
| FR-4  | System shall re-index affected data after reorg detection                                                                                            | RO-1                     |
| FR-5  | System shall preserve reorg event history (before/after states)                                                                                      | DA-1, DA-2, EU-3         |
| FR-6  | System shall provide current block height per chain, enabling consumers to calculate confirmation depth                                              | RO-2\*, VO-1             |
| FR-7  | System shall allow multiple consumers to share indexed data                                                                                          | RO-4                     |
| FR-8  | System shall expose reorg information to consumers (consumers decide on alerting)                                                                    | VO-2                     |
| FR-9  | System shall index all events from Dispatch transactions; other transaction types TBD                                                                | DA-4                     |
| FR-10 | (Deferred) System shall support filtering by block depth in query APIs, enabling consumers to query only events meeting their confirmation threshold | RB-1, RB-2, RB-4         |
| FR-11 | System shall invalidate/update cached query results when reorgs affect previously returned data                                                      | RB-3                     |

### Non-Functional Requirements

| ID    | Requirement                                                                         | Rationale                                 |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| NFR-1 | Indexed data available within 5 seconds of on-chain event                           | User expectation for "real-time"          |
| NFR-2 | Reorg detection and recovery within 60 seconds                                      | Minimize window of inconsistent state     |
| NFR-3 | Support all EVM chains initially; non-EVM (Cosmos, Sealevel, etc.) in future phases | Focused delivery, validate approach first |
| NFR-4 | No data loss during reorg recovery                                                  | Data integrity                            |
| NFR-5 | Graceful degradation if reorg detection fails                                       | Operational resilience                    |

---

## Success Metrics

| Metric                                          | Current State                      | Target                  |
| ----------------------------------------------- | ---------------------------------- | ----------------------- |
| Time from on-chain event to visible in Explorer | reorgPeriod × block time (minutes) | < 10 seconds            |
| Reorg recovery                                  | Manual intervention                | Automatic, < 60 seconds |
| Operator pages due to reorg-related issues      | Multiple per year                  | Zero                    |
| RPC calls for same event (multi-agent)          | 3x                                 | 1x                      |
| Reorg events captured for analytics             | 0%                                 | 100%                    |

---

## Requirements Analysis

### Conflicting Requirements

#### Conflict 1: GraphQL API Default Behavior (Resolved)

| User                 | Want                          | Reason                                             |
| -------------------- | ----------------------------- | -------------------------------------------------- |
| Explorer User (EU-1) | Tip data by default           | See status within seconds                          |
| Rebalancer (RB-1)    | ~~Confirmed data by default~~ | ~~Don't reserve collateral for phantom transfers~~ |

_Resolved: Rebalancer will use tip data in Phase 1, same as Explorer. Block depth filtering deferred._

---

#### Conflict 2: Reorg Event Visibility

| User                   | Want                                       | Reason                               |
| ---------------------- | ------------------------------------------ | ------------------------------------ |
| Explorer User (EU-3)   | Notified of reorgs affecting their message | Understand status changes            |
| Rebalancer (RB-3)      | Silently update/invalidate stale data      | Don't want noise, just correct state |
| Data Team (DA-1, DA-2) | Full reorg history preserved               | Analytics and debugging              |

---

#### Conflict 3: Confirmation Speed vs Safety

| User                 | Want                                | Reason                               |
| -------------------- | ----------------------------------- | ------------------------------------ |
| Explorer User (EU-1) | Fastest possible visibility         | UX responsiveness                    |
| Validator (VO-1)     | Maximum confirmation before signing | Security - can't unsign checkpoint   |
| Relayer (RO-2\*)     | Configurable per chain              | Balance speed vs risk per deployment |

---

### Synergistic Requirements (Implement Together)

#### Synergy 1: Block Metadata for Consumer-Defined Confirmation

**Enables:** EU-2, RO-2\*, RO-3, VO-1, VO-3, DA-3, RB-1, RB-2, RB-4

All users need block metadata (number, hash, timestamp) + current chain height to determine confirmation. Once indexer provides this:

- Explorer shows block depth/age
- Relayer filters by depth threshold
- Validator enforces minimum depth before signing
- Rebalancer queries with depth filter
- Data team queries at any depth

**Single data model, each consumer defines their confirmation policy.**

---

#### Synergy 2: Reorg Detection & Recovery

**Enables:** RO-1, VO-2, DA-1, DA-2, EU-3, RB-3

Core reorg detection mechanism serves all users:

- Relayer recovers automatically
- Validator gets alerts
- Data team gets reorg records
- Explorer shows affected messages
- Rebalancer invalidates stale reservations

**Single implementation, different presentation per consumer.**

---

#### Synergy 3: Shared Indexing Infrastructure

**Enables:** RO-4, FR-7

Once indexing is centralized:

- Relayer, validator, scraper consume same data
- Rebalancer queries same source
- Single RPC cost regardless of consumer count

**Reduces cost linearly with number of consumers.**

---

#### Synergy 4: Full Transaction Indexing

**Enables:** DA-4, future analytics

Index all events from Hyperlane transactions:

- Data team can parse application logs later
- No re-indexing needed when new analytics requirements emerge
- Enables future features without schema changes

**One-time cost, ongoing flexibility.**

---

### Implementation Phasing

#### Phase 1: New Indexing + Scraper (EVM only)

Build new indexing implementation with reorg handling and deploy it in the scraper. **EVM chains only** - validate approach before expanding to other VMs.

**Delivers:**

- Tip indexing with block metadata (FR-1, FR-2)
- Reorg detection and recovery (FR-3, FR-4)
- Reorg history preservation (FR-5)
- Full transaction indexing for Dispatch (FR-9)

**Rollout order (least disruptive first):**

1. Deploy new scraper with tip data as default
2. Update Explorer to show real-time data with block depth indicators
3. Update Rebalancer to use tip data (removes conflict with Explorer)
4. Deprecate old scraper

**Outcome:** Explorer users get immediate benefit (real-time data). Rebalancer adapts to new API. Data pipeline gets reorg history. Validates approach in production.

---

#### Phase 2: Indexing Module in Agents

Integrate new indexing as a module within relayer and validator (replacing current per-agent indexing).

**Delivers:**

- Chain-specific confirmation policies (FR-6)
- Checkpoint reorg alerting (FR-8)
- Reorg recovery in agents (enables RO-1, VO-2)

**Outcome:** Relayer and validator benefit from reorg handling. Each agent still indexes independently but uses shared implementation.

---

#### Phase 3: Shared Indexing Service

Extract indexing into standalone service with API consumed by scraper, relayer, and validator.

**Delivers:**

- Shared indexed data across consumers (FR-7)
- Single RPC cost per chain regardless of consumer count
- Invalidation/update of cached results on reorg (FR-11)

**Outcome:** Full deduplication - index once, consume everywhere. Maximum RPC efficiency.

---

#### Phase Summary

| Phase  | Focus              | Chains                 | RPC Efficiency       | Reorg Handling |
| ------ | ------------------ | ---------------------- | -------------------- | -------------- |
| 1      | Scraper + Explorer | EVM only               | No change            | Scraper only   |
| 2      | Agent migration    | EVM only               | No change (still 3x) | All agents     |
| 3      | Shared service     | EVM only               | 1x (deduplicated)    | Centralized    |
| Future | Multi-VM expansion | Cosmos, Sealevel, etc. | —                    | —              |

---

## Scope

### In Scope

- Relayer indexing
- Validator indexing
- Scraper / Explorer data pipeline
- **EVM chains first** (Cosmos, Sealevel, etc. in future phases)

### Out of Scope

- Non-EVM chain support (future work after EVM proven)
- Real-time push notifications to external systems
- Predictive finality (ML-based confirmation estimation)
- Cross-chain reorg correlation analysis

---

## Decisions

| #   | Question                                                                   | Decision                                                                                                                                        |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Confirmation policy per chain:** Who owns defining "confirmed enough"?   | Consumer of indexed data decides. Indexer provides confirmation status; each consumer (relayer, validator, rebalancer) chooses their threshold. |
| 2   | **Reorg alerting:** Escalation path for signed checkpoint reorgs?          | Indexer exposes reorg information to consumers. Consumers decide whether to alert. No special checkpoint handling in indexer.                   |
| 3   | **Data retention:** How long keep reorg history?                           | Configurable retention policy. Must have prune process to remove old data.                                                                      |
| 4   | **Migration:** Backfill existing data?                                     | No backfill. Start fresh with new system.                                                                                                       |
| 5   | **Finality sources:** Chain-specific finality signals?                     | Use block depth heuristics for EVM chains. No need for chain-specific finality signals initially.                                               |
| 6   | **Full transaction indexing scope:** Which events trigger full tx capture? | Separate by event type with priority: Dispatch (P0), Process, GasPayment, MerkleTreeInsertion. See updated DA user stories.                     |
| 7   | **GraphQL API default:** Confirmed or unconfirmed?                         | Tip data by default for all consumers.                                                                                                          |
| 8   | **Rebalancer confirmation requirements:**                                  | Rebalancer will use tip data in Phase 1, same as Explorer. Removes conflict.                                                                    |

## Open Questions

1. **Relayer confirmation source (RO-2\*):** Should relayer have its own confirmation policy, or rely on validators? If validators signed a checkpoint covering a message, it's implicitly confirmed from the protocol's perspective.

2. **Full transaction indexing scope (DA-4):** Dispatch transactions are P0. Do we need all events from Process, GasPayment, and MerkleTreeInsertion transactions, or just Hyperlane-specific events?

---

## Stakeholders

| Role             | Name | Interest                                         |
| ---------------- | ---- | ------------------------------------------------ |
| Product Owner    | TBD  | Requirements approval                            |
| Engineering Lead | TBD  | Technical feasibility                            |
| Ops/Infra        | TBD  | Operational requirements                         |
| Data Team        | TBD  | Analytics requirements                           |
| Rebalancer Team  | TBD  | Query API compatibility, confirmation guarantees |

---

## Next Steps

1. Review with stakeholders
2. Answer open questions
3. Prioritize user stories for v1
4. Technical design phase
