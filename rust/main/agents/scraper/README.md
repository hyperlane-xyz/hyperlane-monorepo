For local testing, setup a postgres database with

```bash
docker run --name scraper -e POSTGRES_PASSWORD=47221c18c610 -p 5432:5432 -d postgres

# optionally to connect
docker exec -it scraper /usr/bin/psql -U postgres

# and to shutdown
docker stop scraper
docker rm -v scraper
```

To init the database, run from `rust` dir

```bash
cargo run --package migration --bin init-db
```

## Database migrations

Deploy scraper database migrations before deploying a scraper binary that
references newly-added columns. The raw message dispatch reconciler depends on
`raw_message_dispatch.msg_body`; deploying that binary before migration makes
raw dispatch inserts fail closed and stalls the message cursor until the column
exists.

For rollback, stop or roll back scraper binaries that reference a new column
before dropping that column.

To re-create the database, run from `rust` dir

```bash
cargo run --package migration --bin recreate-db
```

To re-generate the sea-orm entity code, when no database is running in docker and from the `rust` dir, run

```bash
cargo run --package migration --bin generate-entities
```

_Note:_ This will install sea-orm-cli, start a docker container for postgresql, and then replace the existing entities.
It will not work if docker is not setup or if anything is already bound on port 5432.

## Same-chain CCR swap indexing

The scraper indexes same-chain CrossCollateralRouter (CCR) swaps — transactions where a user swaps one collateral token for another on the same chain by calling a CCR router's `handle()` directly (i.e. `origin == localDomain`), bypassing cross-chain messaging.

These swaps are detected by watching `ReceivedTransferRemote(origin, recipient, amount)` events on known CCR router contracts where `origin == localDomain`. The source token and amount are recovered by scanning the same transaction's ERC-20 `Transfer` logs for a transfer whose `to` is a different known CCR router.

### Synthetic message representation

Rather than a separate table, same-chain CCR swaps are stored as synthetic Hyperlane messages in the existing `message` + `delivered_message` tables. This lets the Hyperlane Explorer display them without any changes to Hasura or the explorer frontend.

Each swap is represented as:

| Field | Value |
|-------|-------|
| `origin` | local domain ID |
| `destination` | local domain ID (same — self-referential) |
| `sender` | source CCR router address (origin mailbox) |
| `recipient` | destination CCR router address (destination mailbox) |
| `body` | TokenMessage: `recipient_bytes32 \|\| amount_received_uint256` (from `ReceivedTransferRemote`, post-fee, matches how cross-chain CCR Hyperlane messages encode the transfer amount) |
| `nonce` | sequential counter per `(domain, source_router)` pair, starting at 0 — collision-free by construction; not stable across re-index runs (idempotency is guarded by `msg_id` pre-check, not ON CONFLICT) |
| `msg_id` | `0x00000000 \|\| keccak256("SameChainCCR" \|\| txHash32 \|\| logIndex8)[0..28]` — 4-byte zero prefix makes synthetic IDs immediately distinguishable from real message IDs |

A matching `delivered_message` row pointing to the same transaction is inserted immediately, so the swap appears as an instantly-delivered transfer in the explorer.

The explorer decodes the message body to show the origin token (from `sender` = source router) and destination token (from `recipient` = dest router) via the warp route registry. The received amount is computed from the sent amount using the destination token's scale factor, consistent with how cross-chain CCR swaps are displayed.

### Recognizing synthetic messages

One property uniquely identifies a synthetic same-chain CCR swap message:

1. **`msg_id` starts with 8 zero hex chars** — `msg_id LIKE '0x00000000%'`

Real Hyperlane message IDs are `keccak256` outputs (uniform distribution — the probability of any 4-byte / 8 hex char prefix being all zeros is ~1 in 2^32 (~4.3×10^9)). The nonce is not a reliable identifier: it is a sequential counter scoped to each `(domain, source_router)` pair and can coincide with real sequential nonces from other mailboxes.

### Recalculating the msg_id

Any client can deterministically reconstruct the `msg_id` given the transaction hash and log index of the `ReceivedTransferRemote` event using the canonical helper:

```typescript
import { syntheticCcrSwapMessageId } from '@hyperlane-xyz/utils';

const msgId = syntheticCcrSwapMessageId(txHash, logIndex);
```

### CCR router configuration

CCR routers are auto-populated at scraper startup from the registry via `ScraperConfigHelper.buildConfig()` in `typescript/infra/src/config/agent/scraper.ts`. The generated config contains a `ccrRouters` map:

```json
{
  "ccrRouters": {
    "<domainId>": {
      "<routerAddress>": "<collateralTokenAddress>"
    }
  }
}
```

Only chains present in `chainsToScrape` are included. Solana CCR routers (`SealevelHypCrossCollateral`) are excluded — only `EvmHypCrossCollateralRouter` tokens are indexed.
