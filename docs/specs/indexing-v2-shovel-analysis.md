# Shovel Analysis

**Status:** Draft
**Date:** 2026-02-05
**Related:** [Indexing V2 Product Spec](./indexing-v2-product-spec.md), [Tool Comparison](./indexing-v2-tool-comparison.md)

---

## Executive Summary

This document analyzes [Shovel](https://github.com/indexsupply/shovel) by Index Supply as an indexing framework for Hyperlane's Indexing V2 initiative.

**Key findings:**

- Reorg handling is **well-implemented** - active detection via block hash comparison, automatic rollback
- Multi-instance support is **native** - advisory locks allow multiple instances on same database
- Historical and live indexing run **concurrently** - live starts immediately, backfill in background
- RPC reliability is **good** - round-robin load balancing, automatic retry, batch verification
- Uses `eth_getLogs` as primary method, with fallback to receipts/traces
- **Production ready** - stable since v1.0 (March 2024), MIT licensed, written in Go

**Recommendation:** Strong candidate. Worth evaluating alongside Ponder.

---

## 1. Architecture Overview

### 1.1 Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                          Shovel                                  │
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │ Converge Loop   │───►│ Integrations    │───►│ PostgreSQL   │ │
│  │ (Go)            │    │ (declarative)   │    │              │ │
│  │                 │    │                 │    │ • shovel.*   │ │
│  │                 │    │                 │    │ • public.*   │ │
│  └─────────────────┘    └─────────────────┘    └──────────────┘ │
│         │                                              │         │
│         ▼                                              ▼         │
│  ┌─────────────────┐                        ┌──────────────────┐│
│  │ Ethereum Source │                        │ Dashboard        ││
│  │ (JSON-RPC)      │                        │ (port 8546)      ││
│  └─────────────────┘                        └──────────────────┘│
└─────────────────────────────────────────────────────────────────┘

Data source: eth_getLogs, eth_getBlockByNumber, eth_getBlockReceipts, trace_block
External deps: None
```

### 1.2 Technology Stack

| Component     | Technology                       |
| ------------- | -------------------------------- |
| Core engine   | Go (84.2%)                       |
| Configuration | JSON (declarative) or TypeScript |
| Database      | PostgreSQL only                  |
| API           | Built-in dashboard (port 8546)   |

### 1.3 Design Philosophy

> "Crash Only Software" - prioritizes consistent state recovery over preventing crashes

Key principles:

- Declarative JSON configuration (no custom code for basic use cases)
- Atomic transactions (all updates in single Postgres transaction)
- Simple codebase ("core functionality is a few hundred LOC")

### 1.4 Maturity Status

| Indicator            | Value             |
| -------------------- | ----------------- |
| Version              | 1.6               |
| First stable release | March 2024 (v1.0) |
| GitHub stars         | 244               |
| Commits              | 540+              |
| License              | MIT               |
| Production readiness | ✅ Yes            |

---

## 2. Reorg Handling

### 2.1 Mechanism: Active Detection + Rollback

Shovel implements **active reorg detection** via block hash comparison:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Reorg Detection Flow                          │
│                                                                  │
│  1. Track block hash for each indexed block                     │
│     └─► Stored in shovel.task_updates table                     │
│                         │                                        │
│                         ▼                                        │
│  2. On new block, verify parent hash matches                    │
│     └─► Compare with stored hash for previous block             │
│                         │                                        │
│                         ▼                                        │
│  3. If mismatch detected (REORG):                               │
│     a) Delete from shovel.task_updates                          │
│     b) Delete from integration tables using required columns    │
│     c) Re-index canonical chain                                 │
│                         │                                        │
│                         ▼                                        │
│  4. All operations in single transaction                        │
│     └─► Rollback on any failure, retry                          │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Required Columns for Reorg Cleanup

Shovel automatically adds these columns to integration tables:

| Column      | Type    | Purpose                   |
| ----------- | ------- | ------------------------- |
| `ig_name`   | text    | Integration identifier    |
| `src_name`  | text    | Source (chain) identifier |
| `block_num` | numeric | Block number              |
| `tx_idx`    | integer | Transaction index         |
| `log_idx`   | integer | Log index (optional)      |

These enable precise deletion of orphaned data during reorg.

### 2.3 Task Updates Table

```sql
-- shovel.task_updates schema
CREATE TABLE shovel.task_updates (
    ig_name TEXT,
    src_name TEXT,
    block_num NUMERIC,
    block_hash BYTEA,  -- For reorg detection
    -- ...
);
```

> "Each time that a task indexes a batch of blocks, the latest block number is saved in the table which is used for unwinding blocks during a reorg. Only the last couple hundred of blocks are required."

### 2.4 Comparison with Other Tools

| Aspect               | Shovel               | Ponder             | Envio                | rindexer              |
| -------------------- | -------------------- | ------------------ | -------------------- | --------------------- |
| Detection            | ✅ Block hash        | ✅ Block hash      | ✅ Block hash        | ❌ None               |
| Rollback             | ✅ Delete + re-index | ✅ Re-run handlers | ✅ Delete + re-index | ❌ None               |
| History preservation | ❌ Deletes           | ✅ Possible        | ❌ Deletes           | N/A                   |
| Automatic            | ✅ Yes               | ✅ Yes             | ✅ Yes               | N/A                   |
| Configuration        | Automatic            | Automatic          | `max_reorg_depth`    | `reorg_safe_distance` |

### 2.5 Reliability

> "If anything goes wrong during Converge we simply roll back the transaction and try again."

Atomic transactions ensure data consistency even during crashes.

---

## 3. Multi-Instance Support

### 3.1 Native Support with Advisory Locks

Shovel **natively supports** multiple instances on the same database:

> "You can have multiple Shovel instances running the same Config, connected to the same Postgres database, and you should observe that work is randomly distributed across the Shovel instances."

### 3.2 Locking Mechanism

```sql
-- Shovel uses PostgreSQL advisory locks
SELECT pg_advisory_xact_lock(hash_value);
```

> "Shovel uses a `pg_advisory_xact_lock` to ensure only a single shovel can index a particular block(s) at a time."

### 3.3 Architecture with Multiple Instances

```
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL Database                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  shovel.task_updates (shared state)                     │    │
│  │  Advisory locks prevent conflicts                        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                         ▲                                        │
│          ┌──────────────┼──────────────┐                        │
│          │              │              │                        │
│  ┌───────┴───────┐ ┌────┴────┐ ┌───────┴───────┐                │
│  │ Shovel Inst 1 │ │ Inst 2  │ │ Shovel Inst 3 │                │
│  │ (mainnet)     │ │ (mainnet│ │ (testnet)     │                │
│  └───────────────┘ └─────────┘ └───────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 Configuration for Multiple Environments

Same config can index multiple chains:

```json
{
  "pg_url": "$DATABASE_URL",
  "eth_sources": [
    {"name": "mainnet", "chain_id": 1, "url": "$ETH_MAINNET_RPC"},
    {"name": "sepolia", "chain_id": 11155111, "url": "$ETH_SEPOLIA_RPC"}
  ],
  "integrations": [
    {
      "name": "mailbox_mainnet",
      "enabled": true,
      "sources": [{"name": "mainnet", "start": 17000000}],
      "table": {"name": "messages", "columns": [...]}
    },
    {
      "name": "mailbox_sepolia",
      "enabled": true,
      "sources": [{"name": "sepolia", "start": 1000000}],
      "table": {"name": "messages", "columns": [...]}
    }
  ]
}
```

### 3.5 Comparison

| Aspect            | Shovel                     | Ponder               | Envio           |
| ----------------- | -------------------------- | -------------------- | --------------- |
| Multi-instance    | ✅ Native (advisory locks) | ✅ Schema isolation  | ⚠️ Undocumented |
| Same database     | ✅ Yes                     | ✅ Different schemas | ❓ Unknown      |
| Work distribution | ✅ Automatic               | ❌ Manual sharding   | ❓ Unknown      |
| Shared state      | ✅ `shovel.*` tables       | ✅ `ponder_sync`     | ❓ Unknown      |

---

## 4. Historical Backfill and Live Indexing

### 4.1 Concurrent Processing

Shovel runs historical and live indexing **concurrently**:

> "Shovel processes multiple chains and multiple integrations concurrently. It starts indexing the latest block right away and optionally indexes historical data in the background."

```
┌─────────────────────────────────────────────────────────────────┐
│                    Concurrent Indexing                           │
│                                                                  │
│  Live Task (immediate start)                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ current block ──────────────────────────────► tip           ││
│  │ poll_duration: 1s (or WebSocket)                            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Backfill Task (background)                                     │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ start_block ────────────────────────► current block         ││
│  │ batch_size: 2000, concurrency: N                            ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Configuration

```json
{
  "eth_sources": [
    {
      "name": "mainnet",
      "chain_id": 1,
      "url": "https://eth-mainnet.provider.com",
      "batch_size": 2000, // Blocks per RPC request
      "concurrency": 4, // Parallel workers for backfill
      "poll_duration": "1s", // Live polling interval
      "ws_url": "wss://..." // Optional: WebSocket for lower latency
    }
  ],
  "integrations": [
    {
      "sources": [{ "name": "mainnet", "start": 17000000 }]
    }
  ]
}
```

### 4.3 Start Block Logic

> "If `start` is undefined, indexing begins at block 1. If specified, it uses `max(db_latest, integrations[].sources[].start)`."

This ensures:

- Fresh start: begins from configured `start` block
- Restart: resumes from last indexed block

### 4.4 Comparison

| Aspect            | Shovel                       | Ponder                         | Envio            |
| ----------------- | ---------------------------- | ------------------------------ | ---------------- |
| Architecture      | Concurrent (live + backfill) | Sequential (historical → live) | Unified pipeline |
| Live starts       | ✅ Immediately               | ❌ After backfill              | ⚠️ Adaptive      |
| Backfill          | ✅ Background                | ✅ First phase                 | ✅ Integrated    |
| WebSocket support | ✅ Optional                  | ❌ Polling only                | ❓ Unknown       |

---

## 5. RPC Reliability and Event Consistency

### 5.1 RPC Methods Used

| Method                 | Use Case                        | Batch Size         |
| ---------------------- | ------------------------------- | ------------------ |
| `eth_getLogs`          | Event logs (primary)            | Up to 2,000 blocks |
| `eth_getBlockByNumber` | Block metadata, reorg detection | 100 blocks         |
| `eth_getBlockReceipts` | Transaction receipts            | 100 blocks         |
| `trace_block`          | Internal traces                 | Per block          |

> "For logs-only integrations, you can safely request 2,000 blocks worth of logs in a single request."

### 5.2 Round-Robin Load Balancing

```json
{
  "eth_sources": [
    {
      "name": "mainnet",
      "url": [
        "https://primary-rpc.com",
        "https://backup-rpc.com",
        "https://tertiary-rpc.com"
      ]
    }
  ]
}
```

> "Setting multiple urls instructs Shovel to round-robin requests so that a single url doesn't halt progress."

Unlike fallback-only approaches:

> "The reasoning behind round-robin instead of primary-backup is that you should be provisioning enough capacity across both URLs and round-robin load-balances across the capacity. This is different from a primary-backup situation where the backup may be under-provisioned."

### 5.3 Retry Mechanism

> "Shovel is effectively one big retry loop."

| Error Type       | Behavior        |
| ---------------- | --------------- |
| RPC timeout      | Sleep 1s, retry |
| Rate limit (429) | Sleep 1s, retry |
| Connection error | Sleep 1s, retry |
| Invalid response | Sleep 1s, retry |

> "If an error is encountered, Shovel will sleep for 1s before retrying. This is not yet configurable."

### 5.4 Unsynchronized Node Mitigation

> "3rd party Ethereum API providers may load balance RPC requests across a set of unsynchronized nodes."

Shovel addresses this by batching verification:

```
Batch request:
  1. eth_getLogs(fromBlock, toBlock)
  2. eth_getBlockByNumber(toBlock)  // Verify node has processed block

If block not found → node is behind → retry with different node
```

### 5.5 Event Consistency Analysis

#### What Shovel handles:

| Mechanism           | Protection                     |
| ------------------- | ------------------------------ |
| Round-robin RPC     | No single point of failure     |
| Automatic retry     | Recovers from transient errors |
| Batch verification  | Detects unsynchronized nodes   |
| Atomic transactions | Database consistency           |
| Reorg detection     | Corrects orphaned data         |

#### What Shovel does NOT handle:

| Gap                               | Impact               |
| --------------------------------- | -------------------- |
| Incomplete `eth_getLogs` response | ❌ Accepts as truth  |
| RPC returns wrong data            | ❌ Not verified      |
| All RPCs fail                     | Retries indefinitely |

### 5.6 Event Consistency Proof

**Cannot definitively prove events are never missed**, but Shovel has strong mitigations:

1. **Batch verification** detects unsynchronized nodes
2. **Round-robin** distributes load, reduces single-node dependency
3. **Infinite retry** ensures eventual delivery
4. **Atomic transactions** prevent partial state

This is comparable to or better than Ponder/Envio.

---

## 6. Configuration Reference

### 6.1 Minimal Configuration

```json
{
  "pg_url": "$DATABASE_URL",
  "eth_sources": [
    {
      "name": "mainnet",
      "chain_id": 1,
      "url": "$ETH_RPC_URL"
    }
  ],
  "integrations": [
    {
      "name": "mailbox_dispatch",
      "enabled": true,
      "sources": [{ "name": "mainnet", "start": 17000000 }],
      "table": {
        "name": "dispatch_events",
        "columns": [
          { "name": "sender", "type": "bytea" },
          { "name": "destination", "type": "numeric" },
          { "name": "recipient", "type": "bytea" },
          { "name": "message", "type": "bytea" }
        ]
      },
      "block": [
        {
          "name": "block_time",
          "column": "block_time",
          "filter_op": "contains"
        }
      ],
      "event": {
        "name": "Dispatch",
        "type": "event",
        "anonymous": false,
        "inputs": [
          { "indexed": true, "name": "sender", "type": "address" },
          { "indexed": true, "name": "destination", "type": "uint32" },
          { "indexed": true, "name": "recipient", "type": "bytes32" },
          { "indexed": false, "name": "message", "type": "bytes" }
        ]
      }
    }
  ]
}
```

### 6.2 Production Configuration

```json
{
  "pg_url": "$DATABASE_URL",
  "eth_sources": [
    {
      "name": "mainnet",
      "chain_id": 1,
      "url": ["$ETH_RPC_1", "$ETH_RPC_2", "$ETH_RPC_3"],
      "batch_size": 2000,
      "concurrency": 4,
      "poll_duration": "1s",
      "ws_url": "$ETH_WS_URL"
    },
    {
      "name": "arbitrum",
      "chain_id": 42161,
      "url": ["$ARB_RPC_1", "$ARB_RPC_2"],
      "batch_size": 2000,
      "concurrency": 4
    }
  ],
  "integrations": [
    {
      "name": "mailbox_mainnet",
      "enabled": true,
      "sources": [{"name": "mainnet", "start": 17000000}],
      "table": {
        "name": "messages",
        "columns": [...]
      },
      "event": {...}
    },
    {
      "name": "mailbox_arbitrum",
      "enabled": true,
      "sources": [{"name": "arbitrum", "start": 100000000}],
      "table": {
        "name": "messages",
        "columns": [...]
      },
      "event": {...}
    }
  ]
}
```

### 6.3 TypeScript Configuration

```typescript
import { Config, Integration, Source } from '@indexsupply/shovel-config';

const config: Config = {
  pg_url: '$DATABASE_URL',
  eth_sources: [
    {
      name: 'mainnet',
      chain_id: 1,
      url: ['$ETH_RPC_1', '$ETH_RPC_2'],
      batch_size: 2000,
      concurrency: 4,
    },
  ],
  integrations: [
    // ... programmatically generated
  ],
};
```

### 6.4 Environment Variables

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/shovel
ETH_RPC_1=https://your-rpc-provider.com/v2/YOUR_API_KEY
ETH_RPC_2=https://your-backup-rpc.com/v2/YOUR_API_KEY
ETH_WS_URL=wss://your-ws-provider.com/v2/YOUR_API_KEY
```

---

## 7. Reliability Assessment

### 7.1 Strengths

| Feature             | Assessment                     |
| ------------------- | ------------------------------ |
| Reorg handling      | ✅ Active detection + rollback |
| Multi-instance      | ✅ Native advisory locks       |
| Concurrent indexing | ✅ Live + backfill parallel    |
| RPC resilience      | ✅ Round-robin + retry         |
| Atomic transactions | ✅ Database consistency        |
| Maturity            | ✅ Production-ready since v1.0 |
| Simplicity          | ✅ Declarative JSON config     |
| Performance         | ✅ Go-based, efficient         |

### 7.2 Weaknesses

| Gap                    | Severity  | Impact              |
| ---------------------- | --------- | ------------------- |
| PostgreSQL only        | 🟡 Medium | No SQLite for dev   |
| No GraphQL API         | 🟡 Medium | Must build own API  |
| Retry not configurable | 🟢 Low    | Fixed 1s sleep      |
| No TypeScript handlers | 🟡 Medium | Go for custom logic |

### 7.3 Risk Matrix

| Failure Mode     | Detection       | Recovery             | Data Impact |
| ---------------- | --------------- | -------------------- | ----------- |
| RPC timeout      | ✅ Error        | ✅ Retry             | None        |
| RPC rate limit   | ✅ 429          | ✅ Retry             | None        |
| Unsync'd node    | ✅ Batch verify | ✅ Retry             | None        |
| Chain reorg      | ✅ Hash compare | ✅ Delete + re-index | Corrected   |
| Database failure | ✅ Tx error     | ✅ Rollback + retry  | None        |
| Crash            | ✅ Process exit | ✅ Resume from DB    | None        |

---

## 8. Comparison Summary

### 8.1 Shovel vs Ponder vs Envio vs rindexer

| Requirement         | Shovel                 | Ponder              | Envio                | rindexer          |
| ------------------- | ---------------------- | ------------------- | -------------------- | ----------------- |
| Reorg handling      | ✅ Active              | ✅ Active           | ✅ Active            | ❌ Delay only     |
| Multi-instance      | ✅ Native              | ✅ Schema isolation | ⚠️ Undocumented      | ❌ Undocumented   |
| Concurrent indexing | ✅ Live + backfill     | ❌ Sequential       | ⚠️ Unified           | ❌ Sequential     |
| RPC resilience      | ✅ Round-robin + retry | ✅ Viem transport   | ✅ Native fallback   | ❌ External only  |
| GraphQL API         | ❌ None                | ✅ Auto-generated   | ✅ Auto-generated    | ✅ Auto-generated |
| Handler language    | Go                     | TypeScript          | TypeScript           | Rust/YAML         |
| Production ready    | ✅ Yes                 | ✅ Yes              | ⚠️ Partial           | ❌ No             |
| Documentation       | ✅ Good                | ✅ Excellent        | ⚠️ HyperSync-focused | ⚠️ Incomplete     |

### 8.2 Unique Advantages

1. **Concurrent live + backfill** - Live indexing starts immediately
2. **Native multi-instance** - Advisory locks, no schema complexity
3. **Round-robin RPC** - Better than primary-backup for resilience
4. **Batch verification** - Detects unsynchronized nodes
5. **Go performance** - Efficient resource usage

### 8.3 Recommendation

**Shovel is a strong candidate** for Hyperlane Indexing V2:

**Pros:**

- Production-ready (v1.0+ since March 2024)
- Excellent reorg handling
- Native multi-instance support
- Concurrent live + backfill
- Good RPC resilience

**Cons:**

- No auto-generated GraphQL (must build API layer)
- PostgreSQL only (no SQLite for local dev)
- Custom logic requires Go (not TypeScript)

**Consider Shovel if:**

- GraphQL API can be built separately (or not needed)
- Team comfortable with Go for customization
- Concurrent live + backfill is valuable

**Stick with Ponder if:**

- Auto-generated GraphQL is critical
- Team prefers TypeScript ecosystem
- Schema isolation is preferred over advisory locks

---

## 9. Open Questions

1. **GraphQL layer:** Would we build a separate GraphQL API or use Hasura/PostGraphile?

2. **Custom handlers:** Any need for Go-based custom logic, or is declarative config sufficient?

3. **Concurrent indexing value:** Is immediate live indexing during backfill critical for our use case?

4. **Advisory locks vs schemas:** Which multi-instance approach fits our operational model better?

---

## 10. References

- [Shovel GitHub Repository](https://github.com/indexsupply/shovel)
- [Shovel Documentation](https://indexsupply.com/shovel/docs/)
- [Shovel 1.0 Announcement](https://indexsupply.com/shovel/1.0)
- [Index Supply Website](https://indexsupply.com/)
- [E2PG Discussion (Shovel origins)](https://github.com/orgs/indexsupply/discussions/122)
- [@indexsupply/shovel-config npm package](https://www.npmjs.com/package/@indexsupply/shovel-config)
- [Web3 Galaxy Brain Podcast - Ryan Smith (IndexSupply)](https://web3galaxybrain.com/episode/Ryan-Smith-Founder-of-IndexSupply)
