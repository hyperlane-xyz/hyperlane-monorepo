# Near-head scraper

[Architecture and local development](../../rust/main/agents/scraper/README.md).

## Runtime

- Index events and block headers, then enrich dispatch/delivery/gas transactions.
- Confirm only complete, canonical history after `reorgPeriod`.
- The proxy enforces default or requested confirmation depths; metadata availability
  never establishes confirmation.
- Reorgs atomically delete provisional events, transaction links, transactions, and
  blocks. Stale in-flight writes fail foreign-key checks. Reorgs past confirmed
  history halt the chain.

`scraper_head` stores observed/indexed/confirmed heights; `scraper_checkpoint`
stores rollback anchors. Restarts resume these saved boundaries.

## Configuration

Use `chainsToScrape` and each chain's `index.from`, `index.chunk`, and
`index.interval` (default 5 seconds). Empty domains initialize automatically;
existing history without head state requires the cutover below.

RPCs must support event ranges, block lookup, latest height, and the configured
finality selector. EVM also needs hash-pinned `eth_call` and predeployment
`eth_getCode`. Incomplete ranges remain provisional and retry.

## Optional EVM WebSocket wake-ups

`websocketUrls` maps configured EVM chain names to WebSocket URLs. Logs wake HTTP
indexing; headers advance eligible confirmations. Polling remains the fallback.
For deployments, `websocketConfigSecret` loads the map through `CONFIG_FILES`.

## Operations

Run [init-db](../../rust/main/agents/scraper/migration/README.md) before startup.
See [cutover and checkpoint repair](operations.md) for existing databases.

`hyperlane_scraper_receipt_oldest_pending_seconds{chain,event_type}` samples once
per poll. `dispatch` covers only unenriched provisional rows and resets at
confirmation; canonical reconciliation owns older dispatches. `delivery` and
`gas_payment` cover all indexed, unlinked rows. Unknown transaction hashes are excluded.
