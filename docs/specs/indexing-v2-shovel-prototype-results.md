# Indexing V2: Shovel Prototype Results

**Status:** Final
**Date:** 2026-02-27
**Related:** [Product Spec](./indexing-v2-product-spec.md), [Shovel Analysis](./indexing-v2-shovel-analysis.md), [Phase 1 Design](./indexing-v2-shovel-phase1-design.md), [Tool Comparison](./indexing-v2-tool-comparison.md)

---

## Executive Summary

Hyperlane agents currently index blockchain data with a fixed delay (`reorgPeriod`) to avoid chain reorganizations. This causes unnecessary latency while still failing to handle reorgs when they occur. Indexing V2 aims to index at chain tip with automatic reorg recovery.

We prototyped [Shovel](https://github.com/indexsupply/shovel) as the ingestion engine on basesepolia (testnet4). All Hyperlane business logic was implemented as PostgreSQL triggers (~1400 lines SQL). All 64 messages matched existing Scraper data after solving a cross-integration race condition via a pure PL/pgSQL keccak256 implementation.

**Key finding:** Shovel works well for raw event capture but pushes too much complexity into SQL. FR-5 (reorg history preservation) is only partially satisfiable, and FR-9 (full transaction log capture) is not supported — Shovel can only index events matching configured ABIs.

---

## Background

### What Is Shovel

[Shovel](https://github.com/indexsupply/shovel) is an open-source, self-hosted EVM indexer by Index Supply. It is distributed as a single Go binary that reads EVM logs/blocks via JSON-RPC and writes them to PostgreSQL.

Key characteristics:

- **Config-driven**: JSON config defines "integrations" — each maps one Solidity event to one database table. Shovel decodes ABI fields and writes columns 1:1.
- **Reorg handling**: Detects reorgs via block hash comparison, automatically deletes orphaned rows and re-indexes the canonical chain.
- **Multi-instance**: Uses PostgreSQL advisory locks so multiple replicas can run against the same database safely.
- **No custom handlers**: Binary-only, no SDK/plugin system. All post-processing must happen outside Shovel (triggers, separate service, etc.).
- **No derived fields**: Cannot compute values (hashes, parsed subfields, address conversions) — only stores raw ABI-decoded event data.

### Why Shovel Was Evaluated

From the [tool comparison](./indexing-v2-tool-comparison.md), Shovel scored highest on operational primitives: reorg handling, multi-instance support, concurrent live+backfill, and RPC resilience. The main risk was the lack of custom handlers — all Hyperlane-specific logic must be implemented externally.

### What Hyperlane Needs from an Indexer

Hyperlane's Mailbox contract emits several events that together describe the lifecycle of an interchain message:

- **`Dispatch(sender, destination, recipient, message)`** — message sent on origin chain. The `message` field is an opaque bytes blob encoding nonce, domains, sender, recipient, and body.
- **`DispatchId(messageId)`** — emitted in the same transaction as Dispatch, provides the pre-computed `keccak256(message)` hash since PostgreSQL has no native keccak256.
- **`ProcessId(messageId)`** — message delivered on destination chain.
- **`GasPayment(messageId, destination, gasAmount, payment)`** — gas payment for relaying.
- **`InsertedIntoTree(messageId, leafIndex)`** — merkle tree insertion for validator checkpoints.

The indexer must capture these events, join them into a unified message view (with block/transaction metadata), and handle reorgs — including preserving history of reorged data for debugging.

### Phase 1 Requirements

From the [product spec](./indexing-v2-product-spec.md):

| Req  | Description                         |
| ---- | ----------------------------------- |
| FR-1 | Tip indexing (0 delay)              |
| FR-2 | Block metadata (hash, height, time) |
| FR-3 | Reorg detection                     |
| FR-4 | Reorg recovery (automatic)          |
| FR-5 | Reorg history preservation          |
| FR-6 | Scraper data compatibility          |
| FR-7 | Multi-chain support                 |
| FR-8 | Gas payment tracking                |
| FR-9 | Full transaction log capture        |

---

## Implementation Approaches

Since Shovel has no custom handler support, Hyperlane business logic must be implemented outside Shovel. Several approaches are possible:

### Default: Shovel + Post-Processor Service

Shovel writes raw integration tables. A separate stateless TypeScript/Rust service polls raw tables, normalizes data, builds projections, captures reorg history, and emits metrics. API layer reads projection views.

- **Pros:** Business logic in testable app code. Structured reorg history. Full control over projection logic.
- **Cons:** Additional service to deploy and operate. Polling lag between Shovel writes and projections.

### A1: Database-Native Pipeline (Triggers + SQL) — Evaluated in This Prototype

Shovel writes raw tables. PostgreSQL AFTER INSERT/DELETE triggers transform raw rows into projections inline. DELETE triggers capture orphaned rows for reorg history. SQL views provide the query interface.

- **Pros:** No additional service. Reorg capture transactionally coupled to Shovel deletes. Lowest operational footprint.
- **Cons:** All logic in PL/pgSQL. Harder to test/version. Cross-integration race conditions. Limited flexibility for complex business logic.
- **Verdict:** Functional but not sustainable at production scale. See [Shortcomings](#shortcomings-discovered) and [Recommendation](#recommendation).

### A2: CDC Pipeline (WAL → Stream → Consumers)

Capture Shovel table mutations via PostgreSQL logical decoding. Stream to Kafka/NATS. Consumers build projections and history.

- **Pros:** Durable change stream. Good scaling/decoupling.
- **Cons:** Highest operational complexity. Additional infrastructure (message bus, consumer groups).

### A3: Shovel Fork / Upstream Extension

Extend Shovel source code to emit reorg hooks/tombstones/history directly.

- **Pros:** Tightest integration with reorg lifecycle.
- **Cons:** Fork maintenance risk. Slower delivery.

### A4: Canonical-Only (No Reorg History)

Use Shovel rollback/reindex as-is. No before-state retention.

- **Pros:** Simplest implementation.
- **Cons:** Does not satisfy FR-5 (reorg history preservation).

---

## Prototype Scope

### What Was Built

- **Shovel config generator** (`typescript/indexer/scripts/generate-shovel-config.ts`) — generates Shovel JSON config from Hyperlane registry. One integration per event per chain (Dispatch, DispatchId, ProcessId, GasPayment, InsertedIntoTree). Dual source (backfill+tip) for concurrent historical and live indexing.
- **Database-native pipeline** (`typescript/indexer/migrations/0002_shovel_pipeline.sql`) — raw tables written by Shovel, scraper-compatible projection tables, 10 AFTER INSERT/DELETE triggers, helper functions, keccak256 implementation, `shovel_message_view` compatibility view.
- **Comparison script** (`typescript/indexer/scripts/compare-shovel.ts`) — validates Shovel data against existing Scraper (count + content comparison for messages, deliveries, gas payments, blocks).
- **Helm chart** (`typescript/infra/helm/shovel-indexer/`) — K8s deployment with init containers for binary download, DB migration, and config generation.
- **Supporting scripts** — `run-shovel-local.sh`, `migrate-shovel.ts`, `download-shovel.sh`.

### Test Environment

basesepolia (testnet4). 64 dispatched messages, 185 deliveries, 35 gas payments, 248 blocks. Shovel deployed alongside existing Rust Scraper on shared PostgreSQL database.

---

## Shortcomings Discovered

### S1: No Derived Field Computation (High)

**Problem:** Shovel maps ABI event fields 1:1 to columns. Cannot compute derived values (keccak256 hash, message subfield parsing, address format conversion).

**Impact:** All field transformations must happen in SQL triggers. The Hyperlane message format requires parsing nonce, domains, sender, recipient, and body from a single `message` bytes field — this parsing logic lives in PL/pgSQL instead of application code.

### S2: Cross-Integration Race Condition (High)

**Problem:** Each event type is a separate Shovel "integration" with an independent PostgreSQL transaction. When `Dispatch` and `DispatchId` integrations process the same block simultaneously, neither trigger can see the other's uncommitted row due to MVCC snapshot isolation.

**Impact:** ~4% of messages (2/53 in one test run) failed to project because the Dispatch trigger couldn't find the corresponding DispatchId row (needed for message_id). Required implementing keccak256 in PL/pgSQL to compute message_id directly and eliminate the cross-integration dependency entirely.

### S3: Missing Transaction-Level Fields (Medium)

**Problem:** Shovel provides `tx_gas_used` but not `tx_gas` (the original gas limit). `gas_limit` is a transaction-level field not present in any event ABI.

**Impact:** Permanent gap vs Scraper data. No workaround within Shovel — the field is simply unavailable. Results in 20 field-level mismatches in comparison testing.

### S4: All Business Logic in PL/pgSQL (High)

**Problem:** Shovel is binary-only with no plugin/handler system. All Hyperlane logic (message parsing, domain resolution, projection upserts, reorg history capture) must be implemented as PostgreSQL triggers and functions.

**Impact:** ~1400 lines of PL/pgSQL including a 150-line keccak256 implementation. Harder to test, version, code-review, and maintain than equivalent TypeScript/Rust application code.

### S5: Reorg via DELETE + Re-INSERT (Medium)

**Problem:** Shovel's reorg recovery deletes orphaned rows then re-inserts canonical data. DELETE triggers fire during reorg but have no context about whether the deletion is a reorg rollback or manual cleanup.

**Impact:** Can capture orphaned rows via DELETE triggers (flat `shovel_orphaned_event` table), but cannot build structured reorg tracking (`reorg_event`, `reorg_affected_message`) from trigger context alone. FR-5 (reorg history preservation) is only partially satisfiable.

### S6: No Native Address Format Conversion (Low)

**Problem:** Shovel stores raw ABI-decoded values. Ethereum addresses arrive as H256 (32 bytes, zero-padded) but Scraper stores 20-byte addresses.

**Impact:** Requires `address_to_bytes()` helper to strip 12-byte zero prefix. Solvable, but adds to PL/pgSQL complexity.

### S7: Sequential Block Processing per Integration (Low)

**Problem:** Within a single integration, Shovel processes blocks sequentially. Concurrent live + backfill indexing requires explicit configuration of multiple sources.

**Impact:** Solvable via dual-source config generation (backfill source: startBlock→latestBlock, tip source: latestBlock→∞). Not automatic but straightforward.

---

## Solutions Applied

### 1. PL/pgSQL Keccak-256 (Fixes S2)

Implemented full Ethereum Keccak-256 (padding byte `0x01`, not SHA-3's `0x06`) in pure PL/pgSQL using `bit(64)` type for 64-bit lane operations. ~150 lines.

Computes `message_id = keccak256(message)` directly in the Dispatch insert trigger, eliminating the DispatchId integration dependency and the cross-integration race condition. Verified against standard test vectors and all 64 real messages (64/64 match).

### 2. `address_to_bytes()` Helper (Fixes S6)

Strips leading 12 zero bytes from H256 to extract 20-byte EVM address, matching Rust scraper's `address_to_bytes()` behavior.

### 3. Dual-Source Config Generation (Fixes S7)

Config generator creates two sources per chain when `startBlock > 0`: a backfill source (`[startBlock, latestBlock]`) and a tip source (`[latestBlock, ∞)`). Enables concurrent historical catch-up and live indexing.

### 4. Orphaned Event Capture (Partial Fix for S5)

DELETE triggers snapshot deleted rows to `shovel_orphaned_event` table as JSONB, preserving before-state for reorg history. Flat capture only — no structured reorg event tracking.

---

## Phase 1 Requirements Coverage

| Req  | Description                | Status      | Notes                                                     |
| ---- | -------------------------- | ----------- | --------------------------------------------------------- |
| FR-1 | Tip indexing (0 delay)     | Covered     | Configurable `poll_duration`                              |
| FR-2 | Block metadata             | Covered     | Hash, height, timestamp in raw + projection tables        |
| FR-3 | Reorg detection            | Covered     | Shovel block hash comparison                              |
| FR-4 | Reorg recovery             | Covered     | Automatic rollback + re-index                             |
| FR-5 | Reorg history preservation | Partial     | Flat orphan capture; no structured `reorg_event` tracking |
| FR-6 | Scraper compatibility      | Covered     | `shovel_message_view` matches Scraper query contract      |
| FR-7 | Multi-chain support        | Covered     | Config generator supports all registry chains             |
| FR-8 | Gas payment tracking       | Covered     | GasPayment events indexed and projected                   |
| FR-9 | Full tx log capture        | Not covered | Shovel only indexes events matching configured ABIs       |

---

## Validation Results

Comparison script output (basesepolia, full block range):

| Table        | Shovel | Scraper | Status |
| ------------ | ------ | ------- | ------ |
| Messages     | 64     | 64      | OK     |
| Delivered    | 185    | 185     | OK     |
| Gas Payments | 35     | 35      | OK     |
| Blocks       | 248    | 248     | OK     |

**Known delta:** 20 `gas_limit` field mismatches (S3 — field unavailable through Shovel).

---

## Recommendation

The prototype confirms Shovel is a viable raw ingestion engine. However, the A1 database-native approach (all logic in PL/pgSQL) is not sustainable at production scale — ~1400 lines of SQL, including a 150-line keccak256, is harder to test and maintain than application code.

**The default architecture (Shovel + dedicated post-processor service) is the correct path.** The post-processor should handle: keccak256 computation, message field parsing, address conversion, projection upserts, and structured reorg history — moving ~1000 lines of PL/pgSQL into testable TypeScript.

**Open:** Whether to keep DispatchId integration as a cross-check or drop it entirely (keccak256 in post-processor makes it redundant).

---

## References

- [Product Spec](./indexing-v2-product-spec.md) — Phase 1 requirements (FR-1 through FR-9)
- [Shovel Analysis](./indexing-v2-shovel-analysis.md) — Technical analysis of Shovel
- [Phase 1 Design](./indexing-v2-shovel-phase1-design.md) — Target architecture and alternatives
- [Tool Comparison](./indexing-v2-tool-comparison.md) — Ponder, Envio, rindexer, Shovel comparison

Implementation artifacts:

- `typescript/indexer/migrations/0002_shovel_pipeline.sql` — Database-native pipeline (1394 lines)
- `typescript/indexer/scripts/generate-shovel-config.ts` — Shovel config generator
- `typescript/indexer/scripts/compare-shovel.ts` — Data comparison script
- `typescript/infra/helm/shovel-indexer/` — Kubernetes Helm chart
