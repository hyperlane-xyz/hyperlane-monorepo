# Envio HyperIndex Analysis (RPC-only Mode)

**Status:** Draft
**Date:** 2026-02-05
**Related:** [Indexing V2 Product Spec](./indexing-v2-product-spec.md), [Tool Comparison](./indexing-v2-tool-comparison.md)

---

## Executive Summary

This document analyzes Envio HyperIndex as an indexing framework for Hyperlane's Indexing V2 initiative. **Analysis focuses on RPC-only mode** since HyperSync cannot be self-hosted.

**Key findings:**

- Reorg handling is well-implemented with configurable depth
- Multi-instance support is poorly documented; may require separate databases
- Historical and realtime sync run as unified pipeline, not concurrent phases
- RPC reliability features exist but are less mature than Ponder's
- Uses `eth_getLogs` in RPC-only mode, same as Ponder

---

## 1. Architecture Overview

### 1.1 Core Components (RPC-only Mode)

```
┌─────────────────────────────────────────────────────────────────┐
│                   Envio HyperIndex (RPC-only)                    │
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │ Sync Engine     │───►│ Event Handlers  │───►│ PostgreSQL   │ │
│  │ (eth_getLogs)   │    │ (TypeScript/    │    │              │ │
│  │                 │    │  ReScript)      │    │              │ │
│  └─────────────────┘    └─────────────────┘    └──────────────┘ │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────┐                                            │
│  │ Block Range     │                                            │
│  │ Manager         │                                            │
│  │ (adaptive)      │                                            │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘

Data source: eth_getLogs (standard RPC)
External deps: None in RPC-only mode
```

### 1.2 Technology Stack

| Component      | Technology                                      |
| -------------- | ----------------------------------------------- |
| Core engine    | ReScript (56.8%), Rust (29.0%)                  |
| Event handlers | TypeScript, ReScript, JavaScript                |
| Database       | PostgreSQL (primary), ClickHouse (experimental) |
| GraphQL        | Auto-generated from schema                      |

### 1.3 Data Flow

```
eth_getLogs ──► Event Parsing ──► Handler Execution ──► Database Write
                                        │
                                        ▼
                                  Entity Updates
                                  (with rollback tracking)
```

---

## 2. Reorg Handling

### 2.1 Mechanism

Envio implements **automatic reorg detection and rollback**:

```yaml
# config.yaml
rollback_on_reorg: true # default: true
max_reorg_depth: 200 # blocks to monitor (renamed from confirmed_block_threshold in V3)
```

### 2.2 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     Reorg Detection Flow                         │
│                                                                  │
│  1. Monitor blocks within max_reorg_depth of chain tip          │
│                         │                                        │
│                         ▼                                        │
│  2. Detect block hash mismatch (reorg occurred)                 │
│                         │                                        │
│                         ▼                                        │
│  3. Identify affected entities from orphaned blocks             │
│                         │                                        │
│                         ▼                                        │
│  4. Roll back entity states to pre-reorg values                 │
│                         │                                        │
│                         ▼                                        │
│  5. Re-process events from canonical chain                      │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Stateless vs Stateful Data

| Data Type                    | Reorg Handling              | Complexity |
| ---------------------------- | --------------------------- | ---------- |
| **Stateless** (create only)  | Delete orphaned + re-insert | Simple     |
| **Stateful** (update/delete) | Track history + rollback    | Complex    |

For stateful data, Envio tracks change history to enable accurate rollback:

> "You need to revert previous operations or changes and ensure that the entity state is rolled back correctly, which requires tracking the history of changes to each entity."

### 2.4 Comparison with Ponder

| Aspect               | Envio                                                | Ponder                    |
| -------------------- | ---------------------------------------------------- | ------------------------- |
| Detection            | Block hash comparison                                | Block hash comparison     |
| Recovery             | Delete + re-index (stateless) or rollback (stateful) | Re-run indexing functions |
| Configuration        | `max_reorg_depth` configurable                       | Automatic                 |
| History preservation | ❌ Not preserved                                     | ✅ Possible (custom)      |

### 2.5 Limitations

- No built-in reorg history preservation for auditing
- `max_reorg_depth` must be tuned per chain
- Stateful rollback adds complexity and storage overhead

---

## 3. Multi-Instance Support

### 3.1 Current State: Poorly Documented

Envio's documentation **does not explicitly address** running multiple instances. Key gaps:

| Aspect            | Documentation Status                                                |
| ----------------- | ------------------------------------------------------------------- |
| Schema isolation  | `ENVIO_PG_PUBLIC_SCHEMA` exists but undocumented for multi-instance |
| Lock mechanism    | Not documented                                                      |
| Shared cache      | Not documented                                                      |
| Concurrent writes | Warning against for ClickHouse sink                                 |

### 3.2 Available Configuration

```bash
# Environment variables for PostgreSQL
ENVIO_PG_HOST=localhost
ENVIO_PG_PORT=5432
ENVIO_PG_USER=postgres
ENVIO_PG_PASSWORD=secret
ENVIO_PG_DATABASE=indexer
ENVIO_PG_PUBLIC_SCHEMA=public  # Schema override - undocumented behavior
```

### 3.3 Evidence of Limitations

From documentation regarding ClickHouse sink:

> "Do not run multiple Sinks to the same database at the same time"

This suggests concurrent write protection is a known concern.

### 3.4 Possible Approaches (Unverified)

| Approach                                      | Feasibility         | Risk                             |
| --------------------------------------------- | ------------------- | -------------------------------- |
| Separate databases                            | ✅ Should work      | High operational overhead        |
| Separate schemas via `ENVIO_PG_PUBLIC_SCHEMA` | ❓ Unknown          | Undocumented, may have conflicts |
| Same schema, different tables                 | ❌ Likely conflicts | High                             |

### 3.5 Recommendation

**Use separate PostgreSQL databases** for mainnet and testnet instances until multi-instance support is documented:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Separate Databases                           │
│                                                                  │
│  ┌─────────────────────────┐  ┌─────────────────────────┐       │
│  │ Instance: mainnet       │  │ Instance: testnet       │       │
│  │ DB: indexer_mainnet     │  │ DB: indexer_testnet     │       │
│  │ Schema: public          │  │ Schema: public          │       │
│  └─────────────────────────┘  └─────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

**Drawback:** No shared cache, higher resource usage, complex unified querying.

---

## 4. Historical Backfill and Realtime Indexing

### 4.1 Unified Pipeline (Not Concurrent Phases)

Unlike Ponder's explicit two-phase architecture, Envio uses a **unified sync pipeline**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Envio Sync Pipeline                           │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Sync from start_block ─────────────────────────► chain tip  ││
│  │                                                              ││
│  │ • Adaptive block range (initial_block_interval)             ││
│  │ • Scales up on success (acceleration_additive)              ││
│  │ • Scales down on failure (backoff_multiplicative)           ││
│  │ • Transitions to live polling at tip                        ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Live Indexing Detection

Handlers can detect when indexing at chain tip:

```typescript
// In event handler
if (context.chain.isLive) {
  // Currently indexing at chain tip
}
```

### 4.3 RPC Configuration for Live Mode

V3 introduced separate RPC configuration for live indexing:

```yaml
networks:
  - id: 1
    rpc_config:
      url: https://eth-mainnet.provider.com
    rpc:
      - url: https://eth-mainnet.low-latency.com
        for: live # Used only for live indexing, not historical
```

### 4.4 Comparison with Ponder

| Aspect                         | Envio                  | Ponder                       |
| ------------------------------ | ---------------------- | ---------------------------- |
| Architecture                   | Unified pipeline       | Two distinct phases          |
| Historical/realtime separation | Implicit (adaptive)    | Explicit (`/ready` endpoint) |
| Live detection                 | `context.chain.isLive` | After `/ready` returns 200   |
| Separate RPC for live          | ✅ `for: live` config  | ❌ Same RPC                  |

### 4.5 Implications

- No explicit "historical sync complete" signal like Ponder's `/ready`
- Adaptive block range means variable sync speed
- Live RPC separation can improve latency at tip

---

## 5. RPC Reliability and Event Consistency

### 5.1 Does Envio Use eth_getLogs?

**Yes, in RPC-only mode.** Envio uses standard `eth_getLogs` for event retrieval when HyperSync is not configured.

```yaml
# RPC-only configuration (no HyperSync)
networks:
  - id: 1
    rpc_config:
      url: https://eth-mainnet.provider.com
      initial_block_interval: 2000
      backoff_multiplicative: 0.8
      acceleration_additive: 100
      interval_ceiling: 10000
      backoff_millis: 5000
      query_timeout_millis: 20000
```

### 5.2 RPC Reliability Features

| Feature                | Support | Configuration                                     |
| ---------------------- | ------- | ------------------------------------------------- |
| Multiple RPC endpoints | ✅      | `rpc: [{url, for: fallback}]`                     |
| Automatic failover     | ✅      | 20-second timeout triggers switch                 |
| Adaptive block range   | ✅      | `backoff_multiplicative`, `acceleration_additive` |
| Request timeout        | ✅      | `query_timeout_millis`                            |
| Retry backoff          | ✅      | `backoff_millis`                                  |

### 5.3 Fallback Configuration

```yaml
networks:
  - id: 1
    rpc_config:
      url: https://primary-rpc.com
    rpc:
      - url: https://fallback-1.com
        for: fallback
      - url: https://fallback-2.com
        for: fallback
```

### 5.4 Event Consistency Analysis

#### What Envio DOES handle:

| Mechanism            | Protection                           |
| -------------------- | ------------------------------------ |
| Adaptive block range | Handles rate limits, large responses |
| Fallback RPCs        | Continues on primary failure         |
| Reorg rollback       | Corrects orphaned data               |
| Ordered processing   | Events processed in block order      |
| Timeout handling     | Prevents indefinite hangs            |

#### What Envio does NOT guarantee:

| Gap                               | Impact                                       |
| --------------------------------- | -------------------------------------------- |
| Incomplete `eth_getLogs` response | **Accepts as truth** - no cross-verification |
| RPC returns wrong data            | **Not detected**                             |
| Crash during processing           | May lose in-flight events                    |
| All RPCs fail simultaneously      | Indexer stops                                |

### 5.5 Comparison with Ponder

| Aspect               | Envio               | Ponder                        |
| -------------------- | ------------------- | ----------------------------- |
| Fallback RPCs        | ✅ Native config    | ✅ Via Viem `fallback()`      |
| Adaptive block range | ✅ Built-in         | ✅ Auto-detected              |
| RPC caching          | ❓ Not documented   | ✅ `ponder_sync` schema       |
| Per-chain isolation  | ❓ Unknown          | ❌ Single failure crashes all |
| Rate limiting        | ✅ Adaptive backoff | ✅ `rateLimit()` transport    |

### 5.6 Event Consistency Proof

**Cannot prove events are never missed.** Both Envio and Ponder:

1. Trust RPC responses as authoritative
2. Have no cross-verification mechanism
3. Cannot detect incomplete `eth_getLogs` responses

**Mitigation strategies:**

- Use reputable RPC providers
- Configure multiple fallback RPCs
- Monitor for gaps in block numbers
- Enable `raw_events: true` for debugging

---

## 6. Configuration Reference

### 6.1 Minimal RPC-only Configuration

```yaml
# config.yaml
name: HyperlaneIndexer
networks:
  - id: 1
    rpc_config:
      url: https://eth-mainnet.provider.com
    start_block: 17000000

contracts:
  - name: Mailbox
    address: '0x...'
    handler: src/EventHandlers.ts
    events:
      - event: Dispatch
      - event: Process

rollback_on_reorg: true
max_reorg_depth: 200
```

### 6.2 Production Configuration with Fallbacks

```yaml
# config.yaml
name: HyperlaneIndexer
networks:
  - id: 1
    rpc_config:
      url: https://eth-mainnet.primary.com
      initial_block_interval: 2000
      backoff_multiplicative: 0.8
      acceleration_additive: 100
      interval_ceiling: 10000
      backoff_millis: 5000
      query_timeout_millis: 20000
    rpc:
      - url: https://eth-mainnet.backup1.com
        for: fallback
      - url: https://eth-mainnet.backup2.com
        for: fallback
      - url: https://eth-mainnet.low-latency.com
        for: live
    start_block: 17000000

contracts:
  - name: Mailbox
    address: '0x...'
    handler: src/EventHandlers.ts
    events:
      - event: Dispatch
      - event: Process

rollback_on_reorg: true
max_reorg_depth: 200
unordered_multichain_mode: true
raw_events: false # Enable for debugging
```

### 6.3 Environment Variables

| Variable                 | Description                               | Required |
| ------------------------ | ----------------------------------------- | -------- |
| `ENVIO_PG_HOST`          | PostgreSQL host                           | Yes      |
| `ENVIO_PG_PORT`          | PostgreSQL port                           | Yes      |
| `ENVIO_PG_USER`          | PostgreSQL username                       | Yes      |
| `ENVIO_PG_PASSWORD`      | PostgreSQL password                       | Yes      |
| `ENVIO_PG_DATABASE`      | Database name                             | Yes      |
| `ENVIO_PG_PUBLIC_SCHEMA` | Schema override                           | No       |
| `ENVIO_API_TOKEN`        | HyperSync token (not needed for RPC-only) | No       |

---

## 7. Reliability Assessment

### 7.1 Strengths

| Feature             | Assessment                           |
| ------------------- | ------------------------------------ |
| Reorg handling      | ✅ Well-implemented, configurable    |
| RPC fallback        | ✅ Native support, easy config       |
| Adaptive sync       | ✅ Handles rate limits automatically |
| Live RPC separation | ✅ Useful for latency optimization   |

### 7.2 Weaknesses

| Gap                          | Severity  | Impact                                |
| ---------------------------- | --------- | ------------------------------------- |
| Multi-instance undocumented  | 🔴 High   | Cannot shard mainnet/testnet reliably |
| No RPC caching               | 🟡 Medium | Slower re-syncs after restart         |
| No explicit sync phases      | 🟡 Medium | Harder to implement readiness checks  |
| Stateful rollback complexity | 🟡 Medium | More complex handler code             |

### 7.3 Risk Matrix

| Failure Mode           | Detection           | Recovery             | Data Impact        |
| ---------------------- | ------------------- | -------------------- | ------------------ |
| RPC timeout            | ✅ Timeout config   | ✅ Fallback + retry  | None               |
| RPC rate limit         | ✅ Adaptive backoff | ✅ Reduce batch size | None               |
| RPC returns incomplete | ❌ Not detected     | ❌ None              | **Missing events** |
| Chain reorg            | ✅ Block hash       | ✅ Rollback          | Corrected          |
| Database failure       | ✅ Connection error | ⚠️ Restart required  | Depends on timing  |
| Handler crash          | ✅ Exception        | ⚠️ Restart required  | May lose event     |

---

## 8. Comparison Summary

### 8.1 Envio vs Ponder for Hyperlane Requirements

| Requirement                      | Envio (RPC-only)    | Ponder                   | Winner     |
| -------------------------------- | ------------------- | ------------------------ | ---------- |
| Reorg handling                   | ✅ Configurable     | ✅ Automatic             | Tie        |
| Multi-instance (mainnet/testnet) | ❌ Undocumented     | ✅ Schema isolation      | **Ponder** |
| Historical + realtime sync       | ⚠️ Unified pipeline | ✅ Two phases            | **Ponder** |
| RPC reliability                  | ✅ Native fallback  | ✅ Viem transport        | Tie        |
| Event consistency                | ⚠️ No cache         | ✅ Cached in ponder_sync | **Ponder** |
| Documentation                    | ⚠️ RPC-only gaps    | ✅ Comprehensive         | **Ponder** |
| Community                        | Active              | More active              | **Ponder** |

### 8.2 Recommendation

**Envio in RPC-only mode is not recommended** for Hyperlane Indexing V2 due to:

1. **Undocumented multi-instance support** - Critical for mainnet/testnet separation
2. **No RPC response caching** - Slower restarts, more RPC costs
3. **Less mature RPC-only documentation** - HyperSync-focused docs
4. **Smaller community** - Fewer resources for troubleshooting

**Ponder remains the better choice** for self-hosted deployments.

---

## 9. Open Questions

1. **Schema isolation behavior:** Does `ENVIO_PG_PUBLIC_SCHEMA` enable true multi-instance support?

2. **RPC caching:** Is there any internal caching for RPC responses?

3. **Sync completion signal:** How to detect when historical sync is complete (equivalent to Ponder's `/ready`)?

4. **Event delivery guarantee:** What happens to in-flight events during crash?

---

## 10. References

- [Envio HyperIndex Overview](https://docs.envio.dev/docs/HyperIndex/overview)
- [Envio Configuration File](https://docs.envio.dev/docs/HyperIndex/configuration-file)
- [Envio HyperSync as Data Source](https://docs.envio.dev/docs/HyperIndex/hypersync)
- [Envio RPC Sync Configuration](https://docs.envio.dev/docs/HyperIndex/rpc-sync)
- [Envio Environment Variables](https://docs.envio.dev/docs/HyperIndex/environment-variables)
- [Envio Complete Documentation](https://docs.envio.dev/docs/HyperIndex-LLM/hyperindex-complete)
- [Envio GitHub Repository](https://github.com/enviodev/hyperindex)
- [Envio V3 Migration Guide](https://docs.envio.dev/docs/HyperIndex/migrate-to-v3)
- [Indexing & Reorgs - Envio Blog](https://medium.com/@envio_indexer/indexing-reorgs-326f7b6b13ba)
