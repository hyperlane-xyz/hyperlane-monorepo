# rindexer Analysis

**Status:** Draft
**Date:** 2026-02-05
**Related:** [Indexing V2 Product Spec](./indexing-v2-product-spec.md), [Tool Comparison](./indexing-v2-tool-comparison.md)

---

## Executive Summary

This document analyzes rindexer as an indexing framework for Hyperlane's Indexing V2 initiative.

**Key findings:**

- Reorg handling is **basic** - only `reorg_safe_distance` (delay from tip), no rollback mechanism
- Multi-instance support is **not documented**
- Historical and live indexing are **two distinct phases** (similar to Ponder)
- RPC reliability is **limited** - no native fallback, relies on external proxy (eRPC)
- Uses `eth_getLogs` for event retrieval
- **Early stage development** - explicitly warns "bugs will exist"

**Recommendation:** Not suitable for production use. Critical features are missing or undocumented.

---

## 1. Architecture Overview

### 1.1 Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        rindexer                                  │
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐ │
│  │ Indexer Core    │───►│ Event Handlers  │───►│ Storage      │ │
│  │ (Rust)          │    │ (Rust/YAML)     │    │ PostgreSQL   │ │
│  │                 │    │                 │    │ ClickHouse   │ │
│  │                 │    │                 │    │ CSV          │ │
│  └─────────────────┘    └─────────────────┘    └──────────────┘ │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────┐                        ┌──────────────────┐│
│  │ RPC Provider    │                        │ GraphQL API      ││
│  │ (eth_getLogs)   │                        │ (PostGraphile)   ││
│  └─────────────────┘                        └──────────────────┘│
└─────────────────────────────────────────────────────────────────┘

Data source: eth_getLogs (standard RPC)
External deps: None (eRPC optional for load balancing)
```

### 1.2 Technology Stack

| Component     | Technology                            |
| ------------- | ------------------------------------- |
| Core engine   | Rust                                  |
| Configuration | YAML (no-code) or Rust (framework)    |
| Database      | PostgreSQL (primary), ClickHouse, CSV |
| GraphQL       | PostGraphile (embedded binary)        |

### 1.3 Maturity Status

> ⚠️ **"rindexer is brand new and actively under development, things will change and bugs will exist."**

| Indicator            | Value                              |
| -------------------- | ---------------------------------- |
| GitHub commits       | ~810                               |
| Releases             | 69+                                |
| Open issues          | 76                                 |
| Recommended use      | Hackathons, MVPs, proof-of-concept |
| Production readiness | ❌ Not recommended                 |

---

## 2. Reorg Handling

### 2.1 Mechanism: `reorg_safe_distance`

rindexer uses a **delay-based approach** rather than active reorg detection:

```yaml
# rindexer.yaml
contracts:
  - name: Mailbox
    details:
      network: ethereum
      address: '0x...'
      reorg_safe_distance: 64 # Stay 64 blocks behind tip
    abi: ./abis/Mailbox.json
```

### 2.2 How It Works

```
Chain tip:     Block 1000
                  │
                  │ reorg_safe_distance: 64
                  │
                  ▼
Indexer reads: Block 936 (1000 - 64)

If reorg happens at block 990:
  - Indexer hasn't seen it yet
  - No rollback needed
  - Will index canonical chain when it catches up
```

### 2.3 Limitations

| Aspect                 | Status           | Impact                                   |
| ---------------------- | ---------------- | ---------------------------------------- |
| Active reorg detection | ❌ None          | Must wait for safe distance              |
| Rollback mechanism     | ❌ None          | Cannot correct already-indexed data      |
| Reorg history          | ❌ Not preserved | No audit trail                           |
| Deep reorg handling    | ⚠️ Limited       | If reorg > safe_distance, data corrupted |

From release notes (v0.28.0):

> "only log error when the current block number is lower than the last seen when range is outside chain reorg safe"

This indicates reorg handling is **passive** (delay-based) not **active** (detection + rollback).

### 2.4 Comparison

| Aspect        | rindexer              | Ponder             | Envio                |
| ------------- | --------------------- | ------------------ | -------------------- |
| Approach      | Delay from tip        | Active detection   | Active detection     |
| Rollback      | ❌ None               | ✅ Re-run handlers | ✅ Delete + re-index |
| Configuration | `reorg_safe_distance` | Automatic          | `max_reorg_depth`    |
| Deep reorg    | ❌ Data corruption    | ✅ Handled         | ✅ Handled           |

### 2.5 Risk Assessment

**HIGH RISK for production use:**

- If reorg exceeds `reorg_safe_distance`, indexed data becomes inconsistent
- No mechanism to detect or correct corrupted data
- Manual intervention required to re-index from scratch

---

## 3. Multi-Instance Support

### 3.1 Current State: Not Documented

rindexer documentation **does not address** multi-instance deployments:

| Aspect            | Documentation Status |
| ----------------- | -------------------- |
| Schema isolation  | Not mentioned        |
| Lock mechanism    | Not mentioned        |
| Concurrent writes | Not mentioned        |
| Shared state      | Not mentioned        |

### 3.2 Internal State Management

rindexer uses an internal schema for state tracking:

> "rindexer_internal schema (automatically maintained, not for manual editing)"

This stores:

- Block tracking information
- YAML configuration cache
- Sync state

**Unknown:** Whether this supports multiple instances or causes conflicts.

### 3.3 Possible Approaches (Unverified)

| Approach                        | Feasibility      | Risk                                |
| ------------------------------- | ---------------- | ----------------------------------- |
| Separate databases              | ❓ Likely works  | No shared state                     |
| Same database, different tables | ❓ Unknown       | May conflict on `rindexer_internal` |
| Schema isolation                | ❌ Not supported | No configuration option             |

### 3.4 Recommendation

**Use separate PostgreSQL databases** for mainnet and testnet if attempting multi-instance deployment:

```
┌─────────────────────────────────────────────────────────────────┐
│  Instance: mainnet             │  Instance: testnet             │
│  DATABASE_URL=...mainnet_db    │  DATABASE_URL=...testnet_db    │
│                                │                                │
│  ┌──────────────────────────┐  │  ┌──────────────────────────┐  │
│  │ rindexer_internal        │  │  │ rindexer_internal        │  │
│  │ (independent state)      │  │  │ (independent state)      │  │
│  └──────────────────────────┘  │  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Warning:** This is speculative; not tested or documented.

---

## 4. Historical Backfill and Live Indexing

### 4.1 Two-Phase Architecture

rindexer operates in **two distinct phases**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    rindexer Sync Phases                          │
│                                                                  │
│  Phase 1: HISTORICAL SYNC                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ start_block ─────────────────────────────► current block    ││
│  │                                                              ││
│  │ • Processes blocks in batches                               ││
│  │ • Foreign keys temporarily dropped for performance          ││
│  │ • Logs show "HISTORICAL SYNC" status                        ││
│  └─────────────────────────────────────────────────────────────┘│
│                         │                                        │
│                         ▼                                        │
│  Phase 2: LIVE                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ current block ──────────────────────────────────► tip       ││
│  │                                                              ││
│  │ • Polls for new blocks (configurable frequency)             ││
│  │ • Foreign keys re-applied                                   ││
│  │ • Logs show "LIVE" status                                   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Configuration

```yaml
# rindexer.yaml
contracts:
  - name: Mailbox
    details:
      network: ethereum
      address: '0x...'
      start_block: 17000000 # Begin historical sync here
      # end_block: omitted = continue to live indexing
```

| Configuration               | Behavior                        |
| --------------------------- | ------------------------------- |
| `start_block` only          | Historical sync → Live indexing |
| `start_block` + `end_block` | Historical sync only (bounded)  |
| Neither                     | Live indexing only (no history) |

### 4.3 Block Polling Configuration

```yaml
# rindexer.yaml
networks:
  - name: ethereum
    chain_id: 1
    rpc: https://eth-mainnet.provider.com
    block_poll_frequency: optimized # or "rapid", custom ms, division factor
```

| Option      | Behavior                  |
| ----------- | ------------------------- |
| `rapid`     | ~50ms polling             |
| `optimized` | Default balanced setting  |
| `1000`      | Custom 1000ms interval    |
| `/2`        | Half the default interval |

### 4.4 Comparison with Ponder

| Aspect           | rindexer                  | Ponder                  |
| ---------------- | ------------------------- | ----------------------- |
| Two phases       | ✅ Historical → Live      | ✅ Historical → Live    |
| Readiness signal | ⚠️ Log output only        | ✅ `/ready` endpoint    |
| FK handling      | ✅ Drop during historical | ❌ N/A                  |
| Caching          | ❌ None                   | ✅ `ponder_sync` schema |

---

## 5. RPC Reliability and Event Consistency

### 5.1 Does rindexer Use eth_getLogs?

**Yes.** rindexer uses standard `eth_getLogs` for event retrieval.

### 5.2 RPC Configuration

```yaml
# rindexer.yaml
networks:
  - name: ethereum
    chain_id: 1
    rpc: ${ETH_RPC_URL} # Environment variable support
    max_block_range: 2000 # Optional: limit blocks per request
```

### 5.3 RPC Reliability Features

| Feature                | Support   | Notes                    |
| ---------------------- | --------- | ------------------------ |
| Multiple RPC endpoints | ❌ Native | Requires external proxy  |
| Automatic failover     | ❌ None   | Must use eRPC            |
| Retry logic            | ⚠️ Basic  | Logs show retry attempts |
| Rate limiting          | ❌ None   | Handled by provider      |
| Block range adaptation | ⚠️ Manual | `max_block_range` config |

### 5.4 eRPC Integration (External)

rindexer recommends [eRPC](https://github.com/erpc/erpc) for reliability:

```yaml
# rindexer.yaml (using eRPC proxy)
networks:
  - name: ethereum
    chain_id: 1
    rpc: http://erpc:4000/main/evm/1 # eRPC proxy endpoint
```

eRPC provides:

- Load balancing across multiple RPCs
- Failover on errors
- Reorg-aware caching
- Rate limiting
- Auto-batching

**Implication:** Native rindexer has no RPC reliability; requires external infrastructure.

### 5.5 Event Consistency Analysis

#### What rindexer handles:

| Mechanism             | Protection                         |
| --------------------- | ---------------------------------- |
| `reorg_safe_distance` | Avoids indexing unconfirmed blocks |
| Retry on RPC error    | Basic error recovery               |
| Block range limits    | Handles provider restrictions      |

#### What rindexer does NOT handle:

| Gap                      | Impact                            |
| ------------------------ | --------------------------------- |
| RPC failover             | ❌ Single point of failure        |
| Incomplete `eth_getLogs` | ❌ Accepts as truth               |
| Active reorg detection   | ❌ Data corruption if deep reorg  |
| RPC response validation  | ❌ Not verified                   |
| Crash recovery           | ⚠️ Resumes from last synced block |

### 5.6 Event Delivery Proof

**Cannot prove events are not missed.**

From GitHub issues:

> "Event processing failed (attempt 283)" - [Issue #156](https://github.com/joshstevens19/rindexer/issues/156)

This indicates:

1. Retry mechanism exists but can exhaust
2. No guarantee of eventual delivery
3. External failures (API rate limits) cause processing failures

---

## 6. Configuration Reference

### 6.1 Minimal Configuration

```yaml
# rindexer.yaml
name: HyperlaneIndexer
description: Hyperlane protocol indexer
repository: https://github.com/hyperlane-xyz/hyperlane-monorepo

networks:
  - name: ethereum
    chain_id: 1
    rpc: ${ETH_RPC_URL}

storage:
  postgres:
    enabled: true

contracts:
  - name: Mailbox
    details:
      network: ethereum
      address: '0x...'
      start_block: 17000000
      reorg_safe_distance: 64
    abi: ./abis/Mailbox.json
    include_events:
      - Dispatch
      - Process
```

### 6.2 Production Configuration (with eRPC)

```yaml
# rindexer.yaml
name: HyperlaneIndexer
description: Hyperlane protocol indexer

networks:
  - name: ethereum
    chain_id: 1
    rpc: http://erpc:4000/main/evm/1 # eRPC proxy for reliability
    max_block_range: 2000
    block_poll_frequency: 1000

storage:
  postgres:
    enabled: true
    # drop_each_run: false  # Don't reset on restart

contracts:
  - name: Mailbox
    details:
      network: ethereum
      address: '0x...'
      start_block: 17000000
      reorg_safe_distance: 128 # Conservative for mainnet
    abi: ./abis/Mailbox.json
    include_events:
      - Dispatch
      - Process
```

### 6.3 Environment Variables

```bash
# .env
DATABASE_URL=postgresql://user:pass@localhost:5432/rindexer
ETH_RPC_URL=https://eth-mainnet.provider.com
```

---

## 7. Reliability Assessment

### 7.1 Strengths

| Feature                   | Assessment                     |
| ------------------------- | ------------------------------ |
| Rust performance          | ✅ Fast indexing               |
| No-code YAML config       | ✅ Easy setup                  |
| Multiple storage backends | ✅ PostgreSQL, ClickHouse, CSV |
| Streaming support         | ✅ Kafka, RabbitMQ, webhooks   |

### 7.2 Critical Weaknesses

| Gap                      | Severity    | Impact                               |
| ------------------------ | ----------- | ------------------------------------ |
| No active reorg handling | 🔴 Critical | Data corruption on deep reorg        |
| No RPC failover          | 🔴 Critical | Single point of failure              |
| No multi-instance docs   | 🔴 Critical | Cannot shard mainnet/testnet         |
| Early stage development  | 🔴 Critical | "Bugs will exist"                    |
| No RPC caching           | 🟡 High     | Slow restarts                        |
| No readiness endpoint    | 🟡 Medium   | Hard to integrate with orchestrators |

### 7.3 Risk Matrix

| Failure Mode                    | Detection       | Recovery           | Data Impact         |
| ------------------------------- | --------------- | ------------------ | ------------------- |
| RPC timeout                     | ✅ Logged       | ⚠️ Retry (limited) | May lose events     |
| RPC rate limit                  | ✅ Logged       | ❌ No backoff      | Fails after retries |
| Shallow reorg (< safe_distance) | ✅ Avoided      | N/A                | None                |
| Deep reorg (> safe_distance)    | ❌ Not detected | ❌ None            | **Data corruption** |
| Database failure                | ✅ Error        | ⚠️ Manual restart  | Depends on timing   |
| Handler crash                   | ✅ Error        | ⚠️ Retry           | May lose event      |

---

## 8. Comparison Summary

### 8.1 rindexer vs Ponder vs Envio

| Requirement            | rindexer          | Ponder              | Envio                |
| ---------------------- | ----------------- | ------------------- | -------------------- |
| Reorg handling         | ❌ Delay only     | ✅ Active rollback  | ✅ Active rollback   |
| Multi-instance         | ❌ Not documented | ✅ Schema isolation | ⚠️ Undocumented      |
| Historical + live sync | ✅ Two phases     | ✅ Two phases       | ⚠️ Unified pipeline  |
| RPC reliability        | ❌ External only  | ✅ Viem transport   | ✅ Native fallback   |
| Event consistency      | ❌ Basic          | ⚠️ Moderate         | ⚠️ Moderate          |
| Production ready       | ❌ No             | ✅ Yes              | ⚠️ Partial           |
| Documentation          | ⚠️ Incomplete     | ✅ Comprehensive    | ⚠️ HyperSync-focused |

### 8.2 Recommendation

**rindexer is NOT recommended** for Hyperlane Indexing V2 due to:

1. **No active reorg handling** - Critical for data integrity
2. **No native RPC failover** - Requires external infrastructure
3. **Multi-instance not documented** - Cannot shard mainnet/testnet
4. **Early stage development** - Explicit warning about bugs
5. **Limited documentation** - Many features undocumented

**Use cases where rindexer might be appropriate:**

- Hackathons and prototypes
- Non-critical analytics
- Learning/experimentation
- Chains with no reorgs (private/L2)

---

## 9. Open Questions

1. **Multi-instance behavior:** Does `rindexer_internal` schema conflict when multiple instances use same database?

2. **Deep reorg recovery:** Is there any mechanism to detect and recover from deep reorgs?

3. **Production deployments:** Are there any production deployments using rindexer at scale?

4. **Roadmap:** Is active reorg handling planned?

---

## 10. References

- [rindexer Official Website](https://rindexer.xyz/)
- [rindexer GitHub Repository](https://github.com/joshstevens19/rindexer)
- [rindexer Documentation - What is rindexer?](https://rindexer.xyz/docs/introduction/what-is-rindexer)
- [rindexer Networks Configuration](https://rindexer.xyz/docs/start-building/yaml-config/networks)
- [rindexer Storage Configuration](https://rindexer.xyz/docs/start-building/yaml-config/storage)
- [rindexer Contracts Configuration](https://rindexer.xyz/docs/start-building/yaml-config/contracts)
- [rindexer Streams](https://rindexer.xyz/docs/start-building/streams)
- [rindexer Releases](https://github.com/joshstevens19/rindexer/releases)
- [eRPC - Extractable RPC](https://github.com/erpc/erpc) (recommended for RPC reliability)
