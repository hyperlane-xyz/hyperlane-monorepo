# Indexing V2 Phase 1: Shovel Architecture

**Status:** Draft  
**Date:** 2026-02-24  
**Related:** [Indexing V2 Product Spec](./indexing-v2-product-spec.md), [Shovel Analysis](./indexing-v2-shovel-analysis.md), [Tool Comparison](./indexing-v2-tool-comparison.md)

---

## Executive Summary

Phase 1 will use **Shovel** as the ingestion engine and add a **Hyperlane post-processor** service for business logic and compatibility projections.

Rationale:

- Shovel gives strong operational primitives out of the box: active reorg handling, advisory-lock multi-instance support, concurrent live+backfill, and resilient RPC behavior.
- Shovel does not support custom handlers, so Hyperlane-specific logic (reorg history preservation, message status projection, Explorer/Rebalancer-compatible views) must be implemented outside Shovel.

This design preserves the Phase 1 goals from product spec:

- tip indexing (0 delay),
- automatic reorg recovery,
- reorg history preservation,
- block metadata availability,
- Dispatch transaction full-log capture,
- Explorer/Rebalancer compatibility.

---

## Scope

### In Scope (Phase 1)

- EVM chains only.
- Scraper replacement using Shovel + post-processor.
- Explorer/Rebalancer data compatibility through SQL views.
- Reorg history capture and replay-safe projections.

### Out of Scope (Phase 1)

- Relayer/validator migration (Phase 2+).
- Non-EVM chains.
- Shared indexing service for all agents (Phase 3).

---

## Target Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                             PostgreSQL                               │
│                                                                      │
│  shovel.*             hyperlane_raw.*           hyperlane.*          │
│  (shovel state)       (append-ish ingest)       (consumer views)     │
│                                                                      │
└──────────────▲──────────────────────▲──────────────────────▲─────────┘
               │                      │                      │
               │                      │                      │
        ┌──────┴──────┐        ┌──────┴──────────────┐  ┌───┴─────────┐
        │ Shovel      │        │ Post-Processor      │  │ Hasura/API  │
        │ (N replicas)│        │ (Hyperlane logic)   │  │ GraphQL      │
        └──────▲──────┘        └──────────▲──────────┘  └────▲────────┘
               │                           │                  │
               │ JSON-RPC / WS             │ SQL + NOTIFY     │
               │                           │                  │
        ┌──────┴───────────────────────────┴──────────────────┴───────┐
        │                        Explorer / Rebalancer                  │
        └───────────────────────────────────────────────────────────────┘
```

This is the **default architecture** for Phase 1.  
Alternative Shovel architectures are documented in [Alternative Architectures](#alternative-architectures).

---

## Component Design

## 1. Shovel Ingestion Layer

Responsibilities:

- Read EVM logs/blocks from configured chains.
- Handle reorgs by rollback/reindex using `shovel.task_updates`.
- Populate raw integration tables with deterministic keys.

Deployment:

- 2+ replicas per environment (`mainnet3`, `testnet4`) against the same database.
- Use advisory locks for safe work distribution.
- Use multiple RPC URLs per chain (round-robin).

Config principles:

- One `eth_source` per chain.
- One integration per event stream:
  - `Mailbox.Dispatch`
  - `Mailbox.ProcessId` (or `Process`, depending on canonical event surface)
  - `InterchainGasPaymaster.GasPayment`
  - `MerkleTreeHook.InsertedIntoTree`
  - Optional raw transaction logs for Dispatch txs (FR-9).

## 2. Post-Processor Layer

Responsibilities:

- Normalize shovel rows into Hyperlane canonical raw tables.
- Build/maintain consumer projections and compatibility views.
- Preserve reorg history (before/after snapshots) that Shovel alone would delete.
- Emit cache invalidation events and indexer health metrics.

Runtime model:

- Stateless worker(s), horizontally scalable.
- Progress cursor per `(environment, chain, integration)`.
- Idempotent processing with deterministic upserts.

## 3. Query/API Layer

Responsibilities:

- Expose current `message_view` contract for Explorer/Rebalancer.
- Expose current chain head metadata for confirmation depth.
- Keep default behavior as tip data (consumer-defined confirmation).

---

## Alternative Architectures

Shovel can be deployed without a dedicated post-processor service. The options below are alternatives to the default architecture.

## A1. Database-Native Pipeline (Triggers + SQL)

Design:

- Shovel writes raw integration tables.
- PostgreSQL triggers capture reorg-deleted rows into orphan/history tables.
- SQL views/materialized views and stored procedures build consumer projections.
- Hasura reads projection views directly.

Pros:

- No additional app service runtime.
- Reorg "before state" capture can be transactionally coupled to Shovel deletes.

Cons:

- Complex SQL/PLpgSQL logic.
- Harder testing/versioning compared to app code.
- Limited flexibility for richer business logic.

Best when:

- Team prefers heavy DB-centric architecture and can support advanced Postgres operations.

## A2. CDC Pipeline (WAL -> Stream -> Consumers)

Design:

- Capture Shovel table mutations via logical decoding/CDC.
- Stream changes to message bus (e.g., Kafka/NATS).
- Consumers build projections, history, and cache invalidations.

Pros:

- Durable change stream.
- Good scaling and decoupling.

Cons:

- Highest operational complexity.
- Additional moving parts and lag management.

Best when:

- Organization already operates a CDC/streaming platform.

## A3. Shovel Fork / Upstream Extension

Design:

- Extend Shovel to emit reorg hooks/tombstones/history directly.
- Keep most logic in engine-level ingestion path.

Pros:

- Tightest integration with reorg lifecycle.
- Fewer external components once complete.

Cons:

- Fork maintenance risk or upstream delivery uncertainty.
- Slower initial delivery.

Best when:

- Long-term commitment to Shovel internals is acceptable.

## A4. Canonical-Only (No Reorg History)

Design:

- Use Shovel rollback/reindex behavior as-is.
- No before-state retention.

Pros:

- Simplest implementation.

Cons:

- Does not satisfy FR-5 (reorg history preservation).

Best when:

- Reorg history is explicitly deprioritized (not applicable to current product spec).

## Alternative Recommendation

If we do not use the default dedicated post-processor service, **A1 (Database-Native Pipeline)** is the preferred alternative because it preserves transactional correctness with the smallest additional operational footprint.

---

## Database Design

Use three schema tiers:

- `shovel.*`: internal Shovel state.
- `hyperlane_raw.*`: ingestion-normalized protocol tables.
- `hyperlane.*`: stable consumer projection tables/views.

## 1. Raw Tables (`hyperlane_raw`)

Minimum set:

- `block`
- `transaction`
- `dispatch`
- `delivery`
- `gas_payment`
- `merkle_insertion`
- `dispatch_tx_log` (full tx logs for Dispatch transactions)

Required keys:

- Keep `(chain_id, block_number, tx_hash, log_index)` lineage fields for every event row.
- Preserve Shovel context fields (`ig_name`, `src_name`, `block_num`, `tx_idx`, `log_idx`) for replay/reconciliation.

## 2. Reorg/History Tables (`hyperlane_raw`)

- `reorg_event`
  - `id`, `chain_id`, `detected_at`, `unwind_from_block`, `canonical_resume_block`, `reason`.
- `reorg_affected_message`
  - message IDs impacted per reorg event.
- `orphaned_snapshot_*` (or unified `orphaned_event`)
  - stores before-state rows deleted/invalidated due to reorg.

Purpose:

- satisfy FR-5 reorg history preservation,
- support analytics and incident debugging,
- support Explorer message-history timelines.

## 3. Projection Tables (`hyperlane`)

- `message_current`
  - one row per message ID with latest canonical state.
- `message_status_history`
  - optional state transitions over time.
- `chain_head`
  - latest observed height/hash/timestamp per chain + processing watermark.

`chain_head` shape (example):

```sql
CREATE TABLE IF NOT EXISTS hyperlane.chain_head (
  chain_id INTEGER PRIMARY KEY,
  chain_name TEXT NOT NULL,
  rpc_tip_height BIGINT NOT NULL,
  indexed_tip_height BIGINT NOT NULL,
  indexed_tip_hash BYTEA NOT NULL,
  indexed_tip_timestamp TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

## 4. Compatibility Views

Maintain `message_view` contract used by Rebalancer and Explorer.

Required columns (minimum):

- `msg_id`
- `origin_domain_id`
- `destination_domain_id`
- `sender`
- `recipient`
- `origin_tx_hash`
- `origin_tx_sender`
- `origin_tx_recipient`
- `is_delivered`
- `message_body`
- block metadata fields for depth/age calculations.

---

## Shovel Config Shape

Use TypeScript-generated config to avoid hand-editing large JSON.

Example skeleton:

```json
{
  "pg_url": "$DATABASE_URL",
  "eth_sources": [
    {
      "name": "ethereum",
      "chain_id": 1,
      "url": ["$ETH_RPC_1", "$ETH_RPC_2", "$ETH_RPC_3"],
      "ws_url": "$ETH_WS_URL",
      "batch_size": 2000,
      "concurrency": 4,
      "poll_duration": "1s"
    }
  ],
  "integrations": [
    {
      "name": "mailbox_dispatch_ethereum",
      "enabled": true,
      "sources": [{ "name": "ethereum", "start": 0 }],
      "table": { "name": "hl_dispatch_raw", "columns": [] },
      "event": { "name": "Dispatch", "type": "event", "inputs": [] }
    },
    {
      "name": "mailbox_process_ethereum",
      "enabled": true,
      "sources": [{ "name": "ethereum", "start": 0 }],
      "table": { "name": "hl_delivery_raw", "columns": [] },
      "event": { "name": "ProcessId", "type": "event", "inputs": [] }
    },
    {
      "name": "igp_payment_ethereum",
      "enabled": true,
      "sources": [{ "name": "ethereum", "start": 0 }],
      "table": { "name": "hl_gas_payment_raw", "columns": [] },
      "event": { "name": "GasPayment", "type": "event", "inputs": [] }
    },
    {
      "name": "merkle_insert_ethereum",
      "enabled": true,
      "sources": [{ "name": "ethereum", "start": 0 }],
      "table": { "name": "hl_merkle_insert_raw", "columns": [] },
      "event": { "name": "InsertedIntoTree", "type": "event", "inputs": [] }
    }
  ]
}
```

Operational defaults:

- `batch_size=2000`, `concurrency=4` for most chains.
- higher concurrency for high-volume chains only after soak tests.
- always configure at least 2 RPC URLs; prefer 3.

---

## Reorg Handling Strategy

Shovel handles canonical rollback/reindex for raw integration tables.  
Post-processor adds Hyperlane requirements:

1. Detect unwind window:
   - from Shovel state deltas / changed canonical ranges.
2. Snapshot impacted canonical projections:
   - copy rows to `orphaned_snapshot_*` with `reorg_event_id`.
3. Rebuild affected projections from canonical raw rows.
4. Write `reorg_event` + `reorg_affected_message`.
5. Notify API layer for cache invalidation.

SLO targets:

- Reorg detection + projection recovery: < 60s.
- No projection data loss during rollback.

---

## Post-Processor Responsibilities

## 1. Normalization

- Convert chain-specific raw fields to canonical byte formats and IDs.
- Ensure domain/chain metadata joins are consistent with existing `domain` table.

## 2. Projection Upserts

- Maintain `message_current` and related tables idempotently.
- Compute delivery and payment aggregations.

## 3. Reorg History

- Persist before/after state transitions for affected messages.
- Retention policy configurable (e.g., 30/90/180 days).

## 4. Chain Head Tracking

- Update `hyperlane.chain_head` every processing cycle.
- Expose both `rpc_tip_height` and `indexed_tip_height`.

## 5. Notification + Observability

- `NOTIFY hyperlane_reorg` and `NOTIFY hyperlane_projection_updated`.
- Emit metrics:
  - `indexer_tip_lag_blocks`
  - `indexer_projection_lag_seconds`
  - `indexer_reorg_events_total`
  - `indexer_reorg_recovery_seconds`

---

## Rollout Plan (Chain-by-Chain)

Use environment-first, then volume-tier rollout.

## Wave 0: Pre-Prod Validation

- Local + staging with synthetic reorg tests.
- Validate compatibility queries against `message_view`.

Exit criteria:

- Reorg replay tests pass.
- Explorer/Rebalancer query parity pass for target chains.

## Wave 1: Testnet4 Canary

Start with representative EVM testnets:

1. `sepolia`
2. `arbitrumsepolia`
3. `optimismsepolia`
4. `basesepolia`
5. `polygonamoy`

Then add remaining EVM testnets in `testnet4`.

Exit criteria:

- 7 days stable ingestion.
- Zero manual intervention for reorg recovery.
- Tip freshness p95 < 10s.

## Wave 2: Mainnet3 Canary (Moderate Volume)

1. `base`
2. `optimism`
3. `polygon`

Exit criteria:

- 14 days stable.
- query parity and latency SLO met.

## Wave 3: Mainnet3 High Volume

1. `ethereum`
2. `arbitrum`
3. `bsc`
4. `avalanche`

Exit criteria:

- 14 days stable.
- reorg recovery SLO met on all high-volume chains.

## Wave 4: Mainnet3 Long Tail EVM

- Roll out remaining EVM chains in batches.
- Keep non-EVM out of scope for Phase 1.

---

## Cutover Strategy

1. Dual run:
   - existing scraper + Shovel pipeline in parallel.
2. Compare:
   - row counts, message IDs, delivery state, payment totals.
3. Shadow read:
   - Explorer/Rebalancer read from Shovel-backed views in staging.
4. Controlled switch:
   - enable per-chain read cutover flags.
5. Decommission:
   - remove old scraper only after soak period.

---

## Risks and Mitigations

1. Missing custom handlers in Shovel

- Mitigation: dedicated post-processor service with strict idempotency.

2. Reorg history loss (Shovel deletes orphaned rows)

- Mitigation: snapshot affected projection rows before rebuild.

3. RPC inconsistency under load

- Mitigation: multi-RPC round-robin, tuned concurrency, per-chain throttling.

4. API compatibility regressions

- Mitigation: preserve `message_view` contract and run parity tests before cutover.

---

## Deliverables

1. `shovel-config` generator and environment-specific configs.
2. Primary path: post-processor service (normalization, projection, reorg history).
3. Alternative path (if selected): database-native trigger/procedure package for projection and reorg-history capture.
4. SQL migrations:
   - `hyperlane_raw.*` tables
   - `hyperlane.*` projection tables/views
   - `message_view` compatibility layer
5. Observability dashboards + alert rules.
6. Chain-by-chain rollout runbook.

---

## Open Decisions

1. API layer choice:

- Hasura-only vs Hasura + thin service for advanced endpoints.

2. Reorg history retention:

- 30/90/180-day retention and pruning cadence.

3. Projection refresh mode:

- pure incremental upserts vs periodic reconciliation jobs.
