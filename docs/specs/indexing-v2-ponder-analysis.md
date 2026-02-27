# Ponder Reliability & Sharding Analysis

**Status:** Draft
**Date:** 2026-02-05
**Related:** [Indexing V2 Product Spec](./indexing-v2-product-spec.md)

---

## Executive Summary

This document analyzes Ponder as the indexing framework for Hyperlane's Indexing V2 initiative. It covers reliability characteristics, failure modes, and sharding strategies for multi-chain deployments.

**Key findings:**

- Ponder provides solid foundations but requires additional configuration for production reliability
- Single RPC per chain (current implementation) is a reliability risk
- Sharding via schema isolation is supported and recommended for mainnet/testnet separation
- Unified querying across shards achievable via PostgreSQL views

---

## 1. Ponder Architecture Overview

### 1.1 Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      Ponder Instance                             │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │ Sync Engine │───►│ Indexing    │───►│ Database            │  │
│  │ (eth_getLogs│    │ Functions   │    │ (Postgres/SQLite)   │  │
│  │  + caching) │    │ (user code) │    │                     │  │
│  └─────────────┘    └─────────────┘    └─────────────────────┘  │
│         │                                        │               │
│         ▼                                        ▼               │
│  ┌─────────────┐                        ┌─────────────────────┐  │
│  │ ponder_sync │                        │ User Schema         │  │
│  │ (RPC cache) │                        │ (indexed tables)    │  │
│  └─────────────┘                        └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Two-Phase Indexing

| Phase                   | Description                           | Characteristics                               |
| ----------------------- | ------------------------------------- | --------------------------------------------- |
| **Historical Backfill** | Indexes from `start_block` to current | Parallel RPC fetches, cached, high throughput |
| **Realtime**            | Indexes new blocks as produced        | Polling (~1s), lower latency                  |

The `/ready` endpoint returns HTTP 200 only after historical sync completes.

### 1.3 Data Flow

```
eth_getLogs(filter) ──► Event Logs ──► Indexing Function ──► Database
eth_getBlockByNumber ──► Block Data ──► context.block
eth_call ──► Contract State ──► context.client (cached)
```

**Ponder relies exclusively on `eth_getLogs`** for event indexing. No trace support.

---

## 2. Reliability Analysis

### 2.1 Built-in Reliability Features

| Feature                        | Description                                      | Effectiveness                    |
| ------------------------------ | ------------------------------------------------ | -------------------------------- |
| **RPC Caching**                | Stores logs, blocks, txs in `ponder_sync` schema | ✅ Excellent - survives restarts |
| **Reorg Reconciliation**       | Re-processes events on chain reorg               | ✅ Native support                |
| **Block Range Auto-detection** | Adapts to `eth_getLogs` limits per RPC           | ✅ Handles provider limits       |
| **Exit Code 75**               | Signals retryable error to orchestrator          | ✅ Enables automated restart     |
| **Viem Transport Retries**     | Exponential backoff on transient failures        | ✅ Configurable                  |

### 2.2 Reliability Gaps

| Gap                                     | Impact                                  | Severity  |
| --------------------------------------- | --------------------------------------- | --------- |
| **Single RPC failure crashes instance** | All chains stop if one RPC fails        | 🔴 High   |
| **No built-in RPC fallback**            | Must configure via Viem `fallback()`    | 🟡 Medium |
| **No event delivery guarantee**         | Crash during processing may lose events | 🟡 Medium |
| **Sequential event processing**         | Slow chain blocks all chains            | 🟡 Medium |

**Reference:** [GitHub Issue #861](https://github.com/ponder-sh/ponder/issues/861) - open issue about RPC failure isolation.

### 2.3 Current Implementation Risk

```typescript
// typescript/indexer/src/config/chains.ts:191-200
export function buildPonderChains(chains: IndexerChainConfig[]) {
  return Object.fromEntries(
    chains.map((chain) => [
      chain.name,
      {
        id: chain.chainId,
        rpc: http(chain.rpcUrl), // ⚠️ Single RPC, no fallback
      },
    ]),
  );
}
```

**Risk:** Single RPC per chain with no fallback. Any RPC outage stops the entire indexer.

### 2.4 Recommended Configuration

```typescript
import { loadBalance, rateLimit } from '@ponder/utils';
import { fallback, http } from 'viem';

export function buildPonderChains(chains: IndexerChainConfig[]) {
  return Object.fromEntries(
    chains.map((chain) => [
      chain.name,
      {
        id: chain.chainId,
        rpc: fallback([
          rateLimit(http(chain.primaryRpcUrl), { requestsPerSecond: 25 }),
          http(chain.backupRpcUrl),
        ]),
      },
    ]),
  );
}
```

### 2.5 Failure Modes & Recovery

| Failure Mode                | Detection            | Recovery                           | Data Impact               |
| --------------------------- | -------------------- | ---------------------------------- | ------------------------- |
| RPC timeout                 | Viem retry exhausted | Exit code 75, orchestrator restart | None if cached            |
| RPC returns incomplete logs | **Not detected**     | None                               | **Missing events**        |
| Database connection lost    | Exit code 75         | Orchestrator restart               | None (transactional)      |
| Chain reorg                 | Block hash mismatch  | Automatic re-indexing              | Corrected automatically   |
| Indexing function crash     | Uncaught exception   | Exit code 1                        | May lose in-flight event  |
| OOM                         | Process killed       | Orchestrator restart               | May lose in-flight events |

### 2.6 RPC Reliability Matrix

| RPC Issue                | Ponder Behavior                  | Mitigation                               |
| ------------------------ | -------------------------------- | ---------------------------------------- |
| Timeout                  | Retry with backoff               | Configure `fallback()` transport         |
| Rate limit (429)         | Retry with backoff               | Use `rateLimit()` transport              |
| Invalid response         | Retry                            | Use multiple RPCs                        |
| Incomplete `eth_getLogs` | **Accepts as truth**             | Use reputable RPCs only                  |
| Network partition        | Retry until exhausted, then exit | Multiple geographically distributed RPCs |

---

## 3. Sharding Strategies

### 3.1 Why Shard?

| Benefit                    | Description                               |
| -------------------------- | ----------------------------------------- |
| **Fault isolation**        | Testnet issues don't affect mainnet       |
| **Independent scaling**    | Scale mainnet indexer separately          |
| **Deployment flexibility** | Deploy/restart environments independently |
| **Resource isolation**     | Separate CPU/memory per environment       |

### 3.2 Ponder Schema Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  ponder_sync (SHARED across all instances)              │    │
│  │  • RPC response cache                                   │    │
│  │  • Lock-free, safe for concurrent access                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────────┐    ┌────────────────────┐               │
│  │ Schema: mainnet3   │    │ Schema: testnet4   │               │
│  │ (EXCLUSIVE lock)   │    │ (EXCLUSIVE lock)   │               │
│  │                    │    │                    │               │
│  │ • ponder_message   │    │ • ponder_message   │               │
│  │ • ponder_block     │    │ • ponder_block     │               │
│  │ • ponder_*         │    │ • ponder_*         │               │
│  │ • _ponder_meta     │    │ • _ponder_meta     │               │
│  │ • _ponder_checkpoint│   │ • _ponder_checkpoint│              │
│  └────────────────────┘    └────────────────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

**Key constraint:** No two Ponder instances can share the same indexed tables schema.

### 3.3 Sharding Option 1: Environment-Based (Recommended)

Shard by deployment environment (mainnet vs testnet).

```
┌─────────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                           │
│                                                                  │
│  ┌─────────────────────────┐  ┌─────────────────────────┐       │
│  │ Pod: indexer-mainnet    │  │ Pod: indexer-testnet    │       │
│  │                         │  │                         │       │
│  │ DEPLOY_ENV=mainnet3     │  │ DEPLOY_ENV=testnet4     │       │
│  │ DATABASE_SCHEMA=mainnet3│  │ DATABASE_SCHEMA=testnet4│       │
│  │                         │  │                         │       │
│  │ Chains:                 │  │ Chains:                 │       │
│  │ • ethereum              │  │ • sepolia               │       │
│  │ • arbitrum              │  │ • arbitrumsepolia       │       │
│  │ • optimism              │  │ • basesepolia           │       │
│  │ • polygon               │  │ • ...                   │       │
│  │ • ...                   │  │                         │       │
│  └───────────┬─────────────┘  └───────────┬─────────────┘       │
│              │                            │                      │
│              └──────────┬─────────────────┘                      │
│                         ▼                                        │
│              ┌─────────────────────┐                            │
│              │ PostgreSQL          │                            │
│              │ • ponder_sync       │                            │
│              │ • mainnet3.*        │                            │
│              │ • testnet4.*        │                            │
│              └─────────────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

**Pros:**

- Clear separation of concerns
- Shared RPC cache reduces costs
- Independent deployment/scaling

**Cons:**

- Consumers must query two schemas or use views

### 3.4 Sharding Option 2: Chain-Based

Shard by individual chain or chain group.

```
┌─────────────────────────────────────────────────────────────────┐
│  Pod: indexer-ethereum     │  Pod: indexer-l2s                  │
│  SCHEMA=ethereum           │  SCHEMA=l2_chains                  │
│  Chains: ethereum          │  Chains: arbitrum, optimism, base  │
└─────────────────────────────────────────────────────────────────┘
```

**Pros:**

- Maximum fault isolation
- Can scale high-volume chains independently

**Cons:**

- Many schemas to manage
- Complex view maintenance
- Overhead for low-volume chains

### 3.5 Sharding Option 3: Hybrid

Combine environment and volume-based sharding.

```
Mainnet:
  • indexer-mainnet-high-volume (ethereum, arbitrum, optimism)
  • indexer-mainnet-other (polygon, bsc, avalanche, ...)

Testnet:
  • indexer-testnet (all testnet chains - lower volume)
```

### 3.6 Unified Query Layer

To provide a single query interface across shards, use PostgreSQL views:

```sql
-- Create unified schema for consumers
CREATE SCHEMA IF NOT EXISTS hyperlane;

-- Unified message view
CREATE OR REPLACE VIEW hyperlane.message AS
  SELECT
    m.*,
    'mainnet3'::text as deploy_env
  FROM mainnet3.ponder_message m
  UNION ALL
  SELECT
    m.*,
    'testnet4'::text as deploy_env
  FROM testnet4.ponder_message m;

-- Unified block view
CREATE OR REPLACE VIEW hyperlane.block AS
  SELECT b.*, 'mainnet3'::text as deploy_env FROM mainnet3.ponder_block b
  UNION ALL
  SELECT b.*, 'testnet4'::text as deploy_env FROM testnet4.ponder_block b;

-- Unified gas payment view
CREATE OR REPLACE VIEW hyperlane.gas_payment AS
  SELECT g.*, 'mainnet3'::text as deploy_env FROM mainnet3.ponder_gas_payment g
  UNION ALL
  SELECT g.*, 'testnet4'::text as deploy_env FROM testnet4.ponder_gas_payment g;

-- Unified delivered message view
CREATE OR REPLACE VIEW hyperlane.delivered_message AS
  SELECT d.*, 'mainnet3'::text as deploy_env FROM mainnet3.ponder_delivered_message d
  UNION ALL
  SELECT d.*, 'testnet4'::text as deploy_env FROM testnet4.ponder_delivered_message d;

-- Index underlying tables for query performance
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mainnet3_msg_id
  ON mainnet3.ponder_message(msg_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_testnet4_msg_id
  ON testnet4.ponder_message(msg_id);
```

### 3.7 Migration Script

```sql
-- migrations/002_create_unified_views.sql

-- Idempotent view creation for sharded Ponder deployment
-- Run after both mainnet3 and testnet4 schemas are populated

DO $$
BEGIN
  -- Create unified schema if not exists
  CREATE SCHEMA IF NOT EXISTS hyperlane;

  -- Message view
  DROP VIEW IF EXISTS hyperlane.message;
  CREATE VIEW hyperlane.message AS
    SELECT *, 'mainnet3'::text as deploy_env FROM mainnet3.ponder_message
    UNION ALL
    SELECT *, 'testnet4'::text as deploy_env FROM testnet4.ponder_message;

  -- Block view
  DROP VIEW IF EXISTS hyperlane.block;
  CREATE VIEW hyperlane.block AS
    SELECT *, 'mainnet3'::text as deploy_env FROM mainnet3.ponder_block
    UNION ALL
    SELECT *, 'testnet4'::text as deploy_env FROM testnet4.ponder_block;

  -- Add more views as needed...

  RAISE NOTICE 'Unified views created in hyperlane schema';
END $$;
```

---

## 4. Configuration Reference

### 4.1 Environment Variables

| Variable          | Description                  | Example                             |
| ----------------- | ---------------------------- | ----------------------------------- |
| `DATABASE_URL`    | PostgreSQL connection string | `postgres://user:pass@host:5432/db` |
| `DATABASE_SCHEMA` | Schema for indexed tables    | `mainnet3`                          |
| `DEPLOY_ENV`      | Environment identifier       | `mainnet3` or `testnet4`            |
| `INDEXED_CHAINS`  | Comma-separated chain filter | `ethereum,arbitrum,optimism`        |

### 4.2 Ponder Config for Sharding

```typescript
// ponder.config.ts
import { rateLimit } from '@ponder/utils';
import { createConfig } from 'ponder';
import { fallback, http } from 'viem';

const deployEnv = process.env.DEPLOY_ENV || 'testnet4';
const schema = process.env.DATABASE_SCHEMA || deployEnv;

export default createConfig({
  database: {
    kind: 'postgres',
    connectionString: process.env.DATABASE_URL,
    schema, // Each instance gets its own schema
    poolConfig: {
      max: 30,
    },
  },

  chains: {
    ethereum: {
      id: 1,
      rpc: fallback([
        rateLimit(http(process.env.ETH_RPC_PRIMARY), { requestsPerSecond: 25 }),
        http(process.env.ETH_RPC_BACKUP),
      ]),
    },
    // ... more chains
  },

  contracts: {
    // ... contract configs
  },
});
```

### 4.3 Helm Values for Sharded Deployment

```yaml
# helm/indexer/values-mainnet.yaml
hyperlane:
  runEnv: mainnet3
  databaseSchema: mainnet3
  chains: "ethereum,arbitrum,optimism,polygon,bsc,avalanche"

resources:
  requests:
    memory: "4Gi"
    cpu: "2"
  limits:
    memory: "8Gi"
    cpu: "4"

# helm/indexer/values-testnet.yaml
hyperlane:
  runEnv: testnet4
  databaseSchema: testnet4
  chains: "sepolia,arbitrumsepolia,basesepolia,optimismsepolia"

resources:
  requests:
    memory: "1Gi"
    cpu: "500m"
  limits:
    memory: "2Gi"
    cpu: "1"
```

---

## 5. Monitoring & Alerting

### 5.1 Key Metrics

| Metric                            | Description             | Alert Threshold            |
| --------------------------------- | ----------------------- | -------------------------- |
| `ponder_historical_sync_progress` | Backfill completion %   | < 100% after expected time |
| `ponder_realtime_block_lag`       | Blocks behind chain tip | > 10 blocks                |
| `ponder_rpc_request_errors`       | RPC failure count       | > 10/min                   |
| `ponder_indexing_function_errors` | User code errors        | > 0                        |
| `ponder_db_write_latency`         | Database write time     | > 100ms p99                |

### 5.2 Health Checks

```yaml
# Kubernetes health probes
livenessProbe:
  httpGet:
    path: /health
    port: 42069
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready # Returns 200 only after historical sync
    port: 42069
  initialDelaySeconds: 60
  periodSeconds: 10
```

### 5.3 Grafana Dashboard Queries

```promql
# Historical sync progress
ponder_sync_block{instance=~"indexer-.*"}
  / ponder_sync_target_block{instance=~"indexer-.*"} * 100

# RPC error rate by chain
rate(ponder_rpc_errors_total{instance=~"indexer-.*"}[5m])

# Events indexed per second
rate(ponder_events_indexed_total{instance=~"indexer-.*"}[1m])
```

---

## 6. Comparison with Alternatives

See [Indexing V2 Tool Comparison](./indexing-v2-tool-comparison.md) for detailed analysis of Ponder vs Envio vs rindexer.

**Summary:** Ponder is recommended due to no external dependencies, documented multi-instance support, and MIT license.

---

## 7. Open Questions

1. **RPC fallback configuration:** Should we add backup RPCs to registry, or configure via environment?

2. **Chain isolation:** Should we shard per-chain for maximum fault isolation, or is environment-based sufficient?

3. **Unified views maintenance:** Who owns the view creation/migration? Indexer or separate infra?

4. **Ponder Issue #861:** Should we contribute a fix upstream for per-chain RPC failure isolation?

---

## 8. References

- [Ponder Documentation](https://ponder.sh/)
- [Ponder GitHub](https://github.com/ponder-sh/ponder)
- [Ponder Performance Blog](https://ponder.sh/blog/performance)
- [Ponder Migration Guide](https://ponder.sh/docs/migration-guide)
- [Ponder Database Reference](https://ponder.sh/docs/api-reference/ponder/database)
- [Ponder Transport Utilities](https://ponder.sh/docs/utilities/transports)
- [GitHub Issue #861 - RPC Failures](https://github.com/ponder-sh/ponder/issues/861)
- [Indexing V2 Product Spec](./indexing-v2-product-spec.md)
- [Indexing V2 Tool Comparison](./indexing-v2-tool-comparison.md)
