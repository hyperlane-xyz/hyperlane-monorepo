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

# Run migrations
pnpm db:migrate

# Start development server
pnpm dev

# Or start production server
pnpm start
```

## Environment Variables

| Variable          | Description                           | Required |
| ----------------- | ------------------------------------- | -------- |
| `DATABASE_URL`    | PostgreSQL connection string          | Yes      |
| `REGISTRY_URI`    | Path to Hyperlane registry            | Yes      |
| `DEPLOY_ENV`      | Environment: `testnet4` or `mainnet3` | Yes      |
| `CHAIN_RPC_URLS`  | JSON object of chain RPC overrides    | No       |
| `HYP_RPC_<CHAIN>` | RPC URL override for specific chain   | No       |

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

## Deployment

See Helm chart at `typescript/infra/helm/indexer/`.

```bash
helm install indexer ./typescript/infra/helm/indexer \
  --set hyperlane.runEnv=testnet4 \
  --set hyperlane.registryUri=/registry \
  --set externalSecrets.clusterSecretStore=my-store \
  --set externalSecrets.databaseUrlSecretKey=indexer-db-url
```
