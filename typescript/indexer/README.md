# @hyperlane-xyz/indexer

Ponder-based indexer for Hyperlane protocol events. Writes to separate `ponder_*` tables for comparison with existing Rust scraper before migration.

## Features

- Indexes Mailbox events: Dispatch, DispatchId, Process, ProcessId
- Indexes IGP events: GasPayment
- Indexes MerkleTreeHook events: InsertedIntoTree
- Full transaction log indexing for Dispatch transactions (FR-9)
- Reorg detection and history tracking (FR-5)
- Multi-chain support via registry

## Setup

```bash
# Install dependencies
pnpm install

# Set environment variables
export DATABASE_URL=postgres://user:pass@host:5432/dbname
export REGISTRY_URI=/path/to/hyperlane-registry
export DEPLOY_ENV=testnet4  # or mainnet3
export INDEXED_CHAINS=ethereum,arbitrum,optimism  # optional: specific chains to index

# Run migrations
pnpm db:migrate

# Start development server
pnpm dev

# Or start production server
pnpm start
```

## Environment Variables

| Variable          | Description                                        | Required |
| ----------------- | -------------------------------------------------- | -------- |
| `DATABASE_URL`    | PostgreSQL connection string                       | Yes      |
| `REGISTRY_URI`    | Path to Hyperlane registry                         | Yes      |
| `DEPLOY_ENV`      | Environment: `testnet4` or `mainnet3`              | Yes      |
| `INDEXED_CHAINS`  | Comma-separated chains to index (default: all EVM) | No       |
| `CHAIN_RPC_URLS`  | JSON object of chain RPC overrides                 | No       |
| `HYP_RPC_<CHAIN>` | RPC URL override for specific chain                | No       |

## Database Schema

The indexer writes to `ponder_*` prefixed tables that mirror the existing scraper schema:

| Ponder Table                  | Scraper Table          | Description          |
| ----------------------------- | ---------------------- | -------------------- |
| `ponder_block`                | `block`                | Block data           |
| `ponder_transaction`          | `transaction`          | Transaction data     |
| `ponder_message`              | `message`              | Dispatched messages  |
| `ponder_delivered_message`    | `delivered_message`    | Message deliveries   |
| `ponder_gas_payment`          | `gas_payment`          | IGP payments         |
| `ponder_raw_message_dispatch` | `raw_message_dispatch` | Raw dispatch records |
| `ponder_reorg_event`          | (new)                  | Reorg history        |
| `ponder_transaction_log`      | (new)                  | Full tx logs         |

## Comparison with Scraper

Run the comparison script to validate data consistency:

```bash
pnpm db:compare
```

This compares:

- Row counts between `ponder_*` and scraper tables
- Message ID presence
- Delivery status
- Gas payment totals

## Development

```bash
# Build TypeScript
pnpm build

# Lint
pnpm lint

# Format
pnpm prettier
```

## Shovel Local (Database-Native Pipeline)

This repo now supports local Shovel ingestion into `hl_*` raw tables with SQL trigger/procedure projection into scraper-shaped `shovel_*` tables.

### 1. Set database connection

```bash
export DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>
```

### 2. Apply shovel pipeline schema

```bash
pnpm shovel:db:migrate
```

This creates:

- raw integration tables: `hl_mailbox_dispatch`, `hl_mailbox_dispatch_id`, `hl_mailbox_process_id`, `hl_igp_gas_payment`, `hl_merkle_insert`
- scraper-parity tables: `shovel_block`, `shovel_transaction`, `shovel_message`, `shovel_delivered_message`, `shovel_gas_payment`, `shovel_raw_message_dispatch`
- history table for reorg deletes: `shovel_orphaned_event`

### 3. Generate Shovel config

```bash
export DEPLOY_ENV=testnet4
export INDEXED_CHAINS=sepolia
pnpm shovel:config --out local/shovel/shovel.local.json
```

Optional:

- RPC URLs come from registry by default.
- `HYP_RPCS_<CHAIN>` comma-separated RPC list (e.g. `HYP_RPCS_SEPOLIA=url1,url2`)
- `HYP_RPC_<CHAIN>` single RPC override (e.g. `HYP_RPC_SEPOLIA=https://your-rpc`)
- `CHAIN_RPC_URLS` JSON map override (e.g. `{"sepolia":"https://your-rpc"}`)
- `HYP_WS_<CHAIN>` websocket URL

### 4. Download and run Shovel

```bash
pnpm shovel:download
pnpm shovel:run
```

### 5. Compare shovel vs scraper

```bash
pnpm shovel:compare
```

## Deployment

See Helm chart at `typescript/infra/helm/indexer/`.

```bash
helm install indexer ./typescript/infra/helm/indexer \
  --set hyperlane.runEnv=testnet4 \
  --set hyperlane.registryUri=/registry \
  --set hyperlane.chains=ethereum,arbitrum,optimism \
  --set externalSecrets.clusterSecretStore=my-store \
  --set externalSecrets.databaseUrlSecretKey=indexer-db-url
```
