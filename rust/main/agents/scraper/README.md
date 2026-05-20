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
| `nonce` | `keccak256(tx_id \|\| log_index)[0..4] % 2^31` — deterministic, fits PostgreSQL signed integer |
| `msg_id` | `keccak256(version \|\| nonce \|\| origin \|\| sender \|\| destination \|\| recipient \|\| body)` |

A matching `delivered_message` row pointing to the same transaction is inserted immediately, so the swap appears as an instantly-delivered transfer in the explorer.

The explorer decodes the message body to show the origin token (from `sender` = source router) and destination token (from `recipient` = dest router) via the warp route registry. The received amount is computed from the sent amount using the destination token's scale factor, consistent with how cross-chain CCR swaps are displayed.

### Recalculating the msg_id

Any client can deterministically reconstruct the `msg_id` for a same-chain CCR swap given the transaction hash, log index, and swap parameters:

```typescript
import { ethers } from 'ethers';

function computeCcrMsgId(
  txHash: string,          // 32-byte tx hash (0x-prefixed)
  logIndex: bigint,        // log index of the ReceivedTransferRemote event
  domain: number,          // chain domain ID (same for origin and destination)
  sourceRouter: string,    // source CCR router address (0x-prefixed, 20 bytes)
  destRouter: string,      // destination CCR router address (0x-prefixed, 20 bytes)
  recipient: string,       // final token recipient (0x-prefixed, 20 bytes)
  amountReceived: bigint,  // amount from ReceivedTransferRemote (post-fee, destination token decimals)
): string {
  // 1. Derive nonce: keccak256(tx_id_64_bytes || log_index_8_bytes) % 2^31
  const txId = ethers.zeroPadValue(txHash, 64);
  const logIndexBytes = ethers.toBeHex(logIndex, 8);
  const nonceHash = ethers.keccak256(ethers.concat([txId, logIndexBytes]));
  const nonce = Number(BigInt(nonceHash.slice(0, 10)) % 2_147_483_648n);

  // 2. Build TokenMessage body: recipient_bytes32 || amount_uint256
  const recipientBytes32 = ethers.zeroPadValue(recipient, 32);
  const amountBytes32 = ethers.toBeHex(amountReceived, 32);
  const body = ethers.concat([recipientBytes32, amountBytes32]);

  // 3. Encode and hash the Hyperlane message (version=3, origin==destination)
  const sourceBytes32 = ethers.zeroPadValue(sourceRouter, 32);
  const destBytes32 = ethers.zeroPadValue(destRouter, 32);
  const encoded = ethers.concat([
    ethers.toBeHex(3, 1),        // version
    ethers.toBeHex(nonce, 4),    // nonce
    ethers.toBeHex(domain, 4),   // origin
    sourceBytes32,               // sender
    ethers.toBeHex(domain, 4),   // destination (same chain)
    destBytes32,                 // recipient (dest router)
    body,
  ]);

  return ethers.keccak256(encoded);
}
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
