# Scraper

Indexes dispatches, deliveries, gas payments, and Merkle insertions into PostgreSQL.

```text
RPC -> indexer -> events + blocks
                     |
                     +-> transaction worker -> metadata + links
                     |
                     +-> finality checks -> confirmed_height

Events + metadata + confirmation state
                     |
                     v
              Scraper Proxy -> GraphQL / WebSocket
```

One worker per chain enriches transactions on startup and ingestion, with a
5-second fallback. Confirmation controls visibility, not enrichment. Reorgs delete the provisional fork; a reorg past
confirmed history halts the chain.

Code: [indexing](src/near_head/pipeline.rs), [enrichment](src/near_head/enrichment.rs),
[storage/rollback](src/near_head/store.rs). Optional `ccrRouters` indexes confirmed
same-chain swaps.

## Local development

From `rust/main`, with PostgreSQL running and chain settings/`chainsToScrape` configured:

```sh
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
export HYP_DB="$DATABASE_URL"
cargo run -p migration --bin init-db
cargo run -p scraper

cargo test -p scraper -p migration -- --test-threads=4
cargo clippy -p scraper -p migration -- -D warnings
cargo fmt --all --check
```

Tests need Docker. Startup verifies indexes but never runs migrations.
`dbMaxConnections` defaults to 10; `dbAcquireTimeoutMillis` to 15,000.

[Configuration and legacy cutover](../../../../docs/scraper/near-head.md) ·
[Migration commands](migration/README.md)
