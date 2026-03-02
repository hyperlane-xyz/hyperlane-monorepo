# Indexing V2: Tool Comparison

**Status:** Draft
**Date:** 2026-02-05
**Related:** [Indexing V2 Product Spec](./indexing-v2-product-spec.md), [Ponder Analysis](./indexing-v2-ponder-analysis.md), [Envio Analysis](./indexing-v2-envio-analysis.md), [rindexer Analysis](./indexing-v2-rindexer-analysis.md), [Shovel Analysis](./indexing-v2-shovel-analysis.md)

---

## Executive Summary

This document compares blockchain indexing frameworks for Hyperlane's Indexing V2 initiative. Four tools were evaluated: **Ponder**, **Envio HyperIndex**, **rindexer**, and **Shovel**.

**Constraint:** Only self-hosted solutions without external dependencies are considered. Envio is evaluated in **RPC-only mode** (without HyperSync).

**Recommendation:** **Ponder** or **Shovel** are the top candidates. Both are production-ready with excellent reorg handling and multi-instance support. Choose based on:

- Need auto-generated GraphQL? → **Ponder**
- Need concurrent live + backfill indexing? → **Shovel**
- Prefer TypeScript handlers? → **Ponder**
- Prefer simpler multi-instance (advisory locks)? → **Shovel**

---

## 1. Tools Overview

| Tool                 | Language            | Maintainer   | License     | Maturity     | Production Ready      |
| -------------------- | ------------------- | ------------ | ----------- | ------------ | --------------------- |
| **Ponder**           | TypeScript          | ponder-sh    | MIT         | 2023+        | ✅ Yes                |
| **Shovel**           | Go                  | Index Supply | MIT         | 2024+ (v1.0) | ✅ Yes                |
| **Envio HyperIndex** | TypeScript/ReScript | Envio        | Proprietary | 2023+        | ⚠️ Partial (RPC-only) |
| **rindexer**         | Rust (YAML config)  | Community    | MIT         | Early stage  | ❌ No                 |

---

## 2. Feature Comparison

### 2.1 Core Features

| Feature           | Ponder            | Shovel          | Envio (RPC-only) | rindexer      |
| ----------------- | ----------------- | --------------- | ---------------- | ------------- |
| Event indexing    | ✅                | ✅              | ✅               | ✅            |
| GraphQL API       | ✅ Auto-generated | ❌ Build own    | ✅ Built-in      | ✅ Built-in   |
| Custom handlers   | ✅ TypeScript     | ❌ Binary-only  | ✅ TypeScript    | ✅ Rust/YAML  |
| Multi-chain       | ✅ All EVM        | ✅ All EVM      | ✅ 70+ EVM       | ✅ All EVM    |
| Factory contracts | ✅                | ✅ Filter-based | ✅ (1M+ dynamic) | ✅            |
| Reorg handling    | ✅ Active         | ✅ Active       | ✅ Active        | ❌ Delay only |
| Hot reload (dev)  | ✅                | ❌              | ✅               | ❌            |
| Type safety       | ✅ End-to-end     | ⚠️ Go types     | ✅               | ⚠️ Limited    |
| WebSocket support | ❌ Polling        | ✅ Optional     | ❓ Unknown       | ❌            |

### 2.2 Database Support

| Database   | Ponder | Shovel  | Envio           | rindexer |
| ---------- | ------ | ------- | --------------- | -------- |
| PostgreSQL | ✅     | ✅ Only | ✅ Primary      | ✅       |
| SQLite     | ✅     | ❌      | ❌              | ❌       |
| ClickHouse | ❌     | ❌      | ✅ Experimental | ✅       |
| CSV        | ❌     | ❌      | ❌              | ✅       |

### 2.3 Deployment Options

| Option                | Ponder | Shovel       | Envio (RPC-only)    | rindexer             |
| --------------------- | ------ | ------------ | ------------------- | -------------------- |
| Self-hosted           | ✅     | ✅           | ✅                  | ✅                   |
| Managed hosting       | ❌     | ❌           | ✅ (not considered) | ❌                   |
| External dependencies | None   | None         | None                | None (eRPC optional) |
| Built-in dashboard    | ❌     | ✅ Port 8546 | ❌                  | ❌                   |

---

## 3. Reliability Comparison

### 3.1 Event Reliability (Can Miss Events?)

> **Critical Question:** Can the tool miss events from `eth_getLogs` due to RPC instability?

| Tool         | Can Miss Events?                     | Mitigation                                                               | Risk Level                   |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------ | ---------------------------- |
| **Ponder**   | ⚠️ **Yes, if RPC fails during sync** | Retry with backoff; `fallback()` RPCs; cached responses in `ponder_sync` | **LOW** - Strong retry logic |
| **Shovel**   | ⚠️ **Yes, if all RPCs fail**         | Infinite retry (1s sleep); round-robin across RPCs; batch verification   | **LOW** - Resilient design   |
| **Envio**    | ⚠️ **Yes, if RPC fails**             | Native retry backoff; multiple RPC support                               | **MEDIUM** - Less documented |
| **rindexer** | ❌ **Yes, likely**                   | Basic retry only; no native multi-RPC                                    | **HIGH** - Weak resilience   |

**Key insight:** All tools rely on `eth_getLogs` and can theoretically miss events if:

1. RPC returns incomplete data (rare but possible)
2. All configured RPCs fail simultaneously
3. Indexer crashes during sync without checkpointing

**Ponder** and **Shovel** have the strongest protections:

- **Ponder**: Caches RPC responses in `ponder_sync`, so restarts don't re-fetch; viem's robust retry logic
- **Shovel**: Verifies batches against expected block counts; infinite retry prevents permanent gaps

**rindexer** is highest risk: no fallback RPC support (requires external proxy like eRPC), basic retry logic only.

---

### 3.2 Reorg Handling

| Aspect               | Ponder          | Shovel            | Envio (RPC-only)  | rindexer              |
| -------------------- | --------------- | ----------------- | ----------------- | --------------------- |
| Detection method     | Block hash      | Block hash        | Block hash        | ❌ None (delay only)  |
| Recovery             | Re-run handlers | Delete + re-index | Delete + re-index | ❌ None               |
| Automatic            | ✅ Yes          | ✅ Yes            | ✅ Yes            | N/A                   |
| Configuration        | Automatic       | Automatic         | `max_reorg_depth` | `reorg_safe_distance` |
| History preservation | ✅ Possible     | ❌ Deletes        | ❌ Deletes        | N/A                   |
| Deep reorg handling  | ✅ Yes          | ✅ Yes            | ✅ Yes            | ❌ Data corruption    |

### 3.3 RPC Failure Handling

| Aspect                  | Ponder            | Shovel                | Envio (RPC-only)  | rindexer         |
| ----------------------- | ----------------- | --------------------- | ----------------- | ---------------- |
| Retry mechanism         | ✅ Viem backoff   | ✅ 1s sleep, infinite | ✅ Native backoff | ⚠️ Basic         |
| Multiple RPCs           | ✅ `fallback()`   | ✅ Round-robin        | ✅ Native config  | ❌ External only |
| Load balancing          | ❌ Primary-backup | ✅ Round-robin        | ❓ Unknown        | ❌               |
| Rate limiting           | ✅ `rateLimit()`  | ⚠️ Manual batch_size  | ✅ Native         | ❌               |
| Unsync'd node detection | ❌                | ✅ Batch verify       | ❓ Unknown        | ❌               |

### 3.4 Multi-Instance Support

| Aspect             | Ponder               | Shovel               | Envio (RPC-only) | rindexer        |
| ------------------ | -------------------- | -------------------- | ---------------- | --------------- |
| Multiple instances | ✅ Schema isolation  | ✅ Advisory locks    | ⚠️ Undocumented  | ❌ Undocumented |
| Same database      | ✅ Different schemas | ✅ Same schema       | ❓ Unknown       | ❌              |
| Work distribution  | ❌ Manual sharding   | ✅ Automatic         | ❓ Unknown       | ❌              |
| Shared cache       | ✅ `ponder_sync`     | ✅ `shovel.*` tables | ❓ Unknown       | ❌              |
| Lock mechanism     | Schema lock          | Advisory lock        | ❓ Unknown       | ❌              |

### 3.5 Historical + Live Indexing

| Aspect           | Ponder               | Shovel         | Envio (RPC-only) | rindexer       |
| ---------------- | -------------------- | -------------- | ---------------- | -------------- |
| Architecture     | Sequential           | Concurrent     | Unified pipeline | Sequential     |
| Live starts      | After backfill       | ✅ Immediately | Adaptive         | After backfill |
| Backfill         | First phase          | Background     | Integrated       | First phase    |
| Readiness signal | ✅ `/ready` endpoint | ⚠️ Logs only   | ❌ None          | ⚠️ Logs only   |

---

## 4. Architecture Comparison

### 4.1 Ponder

```
┌─────────────────────────────────────────────────────────────────┐
│                      Ponder Instance                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Sync Engine │───►│ Indexing    │───►│ PostgreSQL          │  │
│  │ eth_getLogs │    │ Functions   │    │ (user schema)       │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  ponder_sync (shared RPC cache across instances)        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
Handler language: TypeScript
Data source: eth_getLogs
Multi-instance: Schema isolation + lock
```

### 4.2 Shovel

```
┌─────────────────────────────────────────────────────────────────┐
│                        Shovel Instance                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Converge    │───►│ Integrations│───►│ PostgreSQL          │  │
│  │ Loop (Go)   │    │ (JSON decl) │    │ (public schema)     │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│         │                                       │                │
│         ▼                                       ▼                │
│  ┌─────────────────┐                ┌──────────────────────┐    │
│  │ Round-robin RPC │                │ shovel.task_updates  │    │
│  │ (load balanced) │                │ (reorg tracking)     │    │
│  └─────────────────┘                └──────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
Handler language: Go (or declarative JSON)
Data source: eth_getLogs, eth_getBlockReceipts, trace_block
Multi-instance: Advisory locks (same schema)
```

### 4.3 Envio (RPC-only)

```
┌─────────────────────────────────────────────────────────────────┐
│                 Envio HyperIndex (RPC-only)                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Sync Engine │───►│ Handlers    │───►│ PostgreSQL          │  │
│  │ eth_getLogs │    │ (TS/ReScript│    │                     │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
Handler language: TypeScript, ReScript
Data source: eth_getLogs
Multi-instance: Undocumented (ENVIO_PG_PUBLIC_SCHEMA exists)
```

### 4.4 rindexer

```
┌─────────────────────────────────────────────────────────────────┐
│                        rindexer                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Indexer     │───►│ Handlers    │───►│ PostgreSQL          │  │
│  │ (Rust)      │    │ (YAML/Rust) │    │                     │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
Handler language: Rust or YAML (no-code)
Data source: eth_getLogs
Multi-instance: Not documented
⚠️ No active reorg handling - delay from tip only
```

---

## 5. Performance Comparison

### 5.1 Benchmark Context

All tools use `eth_getLogs` in self-hosted mode, so performance is primarily bottlenecked by RPC throughput.

| Tool     | Batch Size (logs) | Concurrency  | Caching          |
| -------- | ----------------- | ------------ | ---------------- |
| Ponder   | Auto-detected     | Per chain    | ✅ `ponder_sync` |
| Shovel   | Up to 2,000       | Configurable | ❌ None          |
| Envio    | Configurable      | Configurable | ❌ None          |
| rindexer | Configurable      | Unknown      | ❌ None          |

### 5.2 Unique Performance Features

| Tool       | Feature                    | Benefit                            |
| ---------- | -------------------------- | ---------------------------------- |
| **Ponder** | RPC response caching       | Faster restarts, reduced RPC costs |
| **Shovel** | Concurrent live + backfill | Live data available immediately    |
| **Shovel** | Round-robin RPC            | Better load distribution           |
| **Shovel** | WebSocket support          | Lower latency for live blocks      |
| **Envio**  | Adaptive block range       | Handles rate limits automatically  |

---

## 6. Developer Experience

### 6.1 Setup & Configuration

| Aspect        | Ponder               | Shovel              | Envio          | rindexer       |
| ------------- | -------------------- | ------------------- | -------------- | -------------- |
| Initial setup | `pnpm create ponder` | Docker or binary    | CLI wizard     | Rust toolchain |
| Config format | TypeScript           | JSON (or TS)        | YAML + TS      | YAML           |
| ABI handling  | Auto-generated types | Manual JSON         | Auto-generated | Manual         |
| Local dev     | ✅ Hot reload        | ⚠️ Restart required | ✅ Docker      | ⚠️ Limited     |

### 6.2 Documentation Quality

| Aspect              | Ponder       | Shovel   | Envio       | rindexer      |
| ------------------- | ------------ | -------- | ----------- | ------------- |
| Getting started     | ✅ Excellent | ✅ Good  | ✅ Good     | ⚠️ Basic      |
| API reference       | ✅ Complete  | ✅ Good  | ✅ Complete | ⚠️ Incomplete |
| Examples            | ✅ Many      | ⚠️ Few   | ✅ Many     | ⚠️ Few        |
| Multi-instance docs | ✅ Detailed  | ✅ Clear | ❌ Missing  | ❌ Missing    |
| Reorg handling docs | ✅ Good      | ✅ Good  | ✅ Good     | ❌ Missing    |

### 6.3 Community & Support

| Aspect             | Ponder        | Shovel     | Envio  | rindexer |
| ------------------ | ------------- | ---------- | ------ | -------- |
| GitHub stars       | ~2,000        | ~250       | ~500   | ~300     |
| Commits            | High activity | Moderate   | High   | Moderate |
| Discord/Support    | Active        | Email/paid | Active | Low      |
| Commercial support | ❌            | ✅ Premium | ✅     | ❌       |

---

## 7. Decision Matrix

### 7.1 Weighted Scoring

| Criteria               | Weight | Ponder  | Shovel  | Envio (RPC-only) | rindexer |
| ---------------------- | ------ | ------- | ------- | ---------------- | -------- |
| Reorg handling         | 20%    | 9       | 9       | 9                | 2        |
| Multi-instance support | 20%    | 9       | 10      | 4                | 2        |
| RPC reliability        | 15%    | 8       | 9       | 7                | 3        |
| Documentation          | 15%    | 9       | 8       | 6                | 4        |
| GraphQL API            | 10%    | 10      | 0       | 10               | 8        |
| Maturity               | 10%    | 9       | 8       | 7                | 3        |
| License                | 5%     | 10      | 10      | 5                | 10       |
| Live + backfill        | 5%     | 5       | 10      | 6                | 5        |
| **Weighted Score**     | 100%   | **8.6** | **8.3** | **6.5**          | **3.4**  |

### 7.2 Feature Trade-offs

| If you need...                 | Choose                  | Reason                               |
| ------------------------------ | ----------------------- | ------------------------------------ |
| Auto-generated GraphQL         | **Ponder**              | Built-in, type-safe                  |
| Concurrent live + backfill     | **Shovel**              | Live indexing starts immediately     |
| TypeScript handlers            | **Ponder** or **Envio** | Native TypeScript support            |
| Simpler multi-instance         | **Shovel**              | Advisory locks, no schema management |
| RPC response caching           | **Ponder**              | `ponder_sync` schema                 |
| Round-robin RPC load balancing | **Shovel**              | Native support                       |
| Hot reload development         | **Ponder**              | Best DX for iteration                |
| WebSocket for low latency      | **Shovel**              | Optional `ws_url` config             |

---

## 8. Recommendation

### 8.1 Top Choices: Ponder or Shovel

Both **Ponder** and **Shovel** are production-ready and suitable for Hyperlane Indexing V2.

#### Choose Ponder if:

- Auto-generated GraphQL API is required
- Team prefers TypeScript for handlers
- Hot reload development experience is valuable
- RPC caching for faster restarts is important
- Existing implementation uses Ponder (`typescript/indexer/`)

#### Choose Shovel if:

- Concurrent live + backfill indexing is critical
- Simpler multi-instance setup preferred (advisory locks vs schemas)
- Round-robin RPC load balancing is valuable
- WebSocket support for low-latency live updates needed
- Custom API layer is acceptable (no built-in GraphQL)

### 8.2 Not Recommended

#### Envio (RPC-only mode)

- No compelling advantage over Ponder without HyperSync
- Multi-instance support poorly documented
- Documentation focused on HyperSync, not RPC-only

#### rindexer

- Early stage development ("bugs will exist")
- No active reorg handling (delay from tip only)
- Critical features missing or undocumented
- Not production-ready

### 8.3 Migration Consideration

Current implementation uses Ponder (`typescript/indexer/`). Switching to Shovel would require:

1. Rewriting config from TypeScript to JSON
2. Building GraphQL API layer (or using Hasura/PostGraphile)
3. Adapting to Go for any custom handler logic

**Recommendation:** Continue with Ponder unless concurrent live + backfill is a critical requirement.

---

## 9. Summary Table

| Aspect               | Ponder              | Shovel                  | Envio (RPC-only) | rindexer           |
| -------------------- | ------------------- | ----------------------- | ---------------- | ------------------ |
| **Production ready** | ✅ Yes              | ✅ Yes                  | ⚠️ Partial       | ❌ No              |
| **Can miss events?** | ⚠️ Low risk         | ⚠️ Low risk             | ⚠️ Medium risk   | ❌ **High risk**   |
| **Reorg handling**   | ✅ Active           | ✅ Active               | ✅ Active        | ❌ Delay only      |
| **Multi-instance**   | ✅ Schema isolation | ✅ Advisory locks       | ⚠️ Undocumented  | ❌ Undocumented    |
| **Live + backfill**  | Sequential          | ✅ Concurrent           | Unified          | Sequential         |
| **GraphQL**          | ✅ Auto             | ❌ Build own            | ✅ Auto          | ✅ Auto            |
| **RPC resilience**   | ✅ Fallback + cache | ✅ Round-robin + verify | ✅ Fallback      | ❌ External only   |
| **Handler language** | TypeScript          | Go/JSON                 | TypeScript       | Rust/YAML          |
| **License**          | MIT                 | MIT                     | Proprietary      | MIT                |
| **Recommendation**   | ✅ **Recommended**  | ✅ **Recommended**      | ⚠️ Alternative   | ❌ Not recommended |

---

## 10. References

### Ponder

- [Ponder Documentation](https://ponder.sh/)
- [Ponder GitHub](https://github.com/ponder-sh/ponder)
- [Ponder Performance Blog](https://ponder.sh/blog/performance)
- [Ponder Database Reference](https://ponder.sh/docs/api-reference/ponder/database)

### Shovel

- [Shovel Documentation](https://indexsupply.com/shovel/docs/)
- [Shovel GitHub](https://github.com/indexsupply/shovel)
- [Shovel 1.0 Announcement](https://indexsupply.com/shovel/1.0)
- [@indexsupply/shovel-config](https://www.npmjs.com/package/@indexsupply/shovel-config)

### Envio

- [Envio HyperIndex Overview](https://docs.envio.dev/docs/HyperIndex/overview)
- [Envio Configuration](https://docs.envio.dev/docs/HyperIndex/configuration-file)
- [Envio Licensing](https://docs.envio.dev/docs/HyperIndex/licensing)

### rindexer

- [rindexer Documentation](https://rindexer.xyz/docs/introduction/what-is-rindexer)
- [rindexer GitHub](https://github.com/joshstevens19/rindexer)

### General

- [Best Blockchain Indexers 2026](https://blog.ormilabs.com/best-blockchain-indexers-in-2025-real-time-web3-data-and-subgraph-platforms-compared/)
