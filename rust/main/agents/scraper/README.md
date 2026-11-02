# Scraper

Indexes Hyperlane dispatches, deliveries, gas payments, and Merkle insertions across
all configured chains. **Near-head is live and is the only indexing pipeline
for these events on every supported protocol.** One process shares a PostgreSQL pool across chains.

```text
src/
├── main.rs                 Entrypoint and shared agent initialization
├── settings.rs             Database, chainsToScrape, and optional ccrRouters
├── agent.rs                Chain setup, supervision, and metrics
├── ccr.rs                  Optional same-chain CCR worker
├── reconciliation.rs       Dispatch enrichment worker
├── reconciliation/
│   ├── schedule.rs         Discovery, full-sweep paging, and failure cooldowns
│   ├── dispatches.rs       Page enrichment and bounded transaction retries
│   └── metrics.rs          Operation metrics, panic isolation, and heartbeat
├── near_head/
│   ├── mod.rs              Source selection, startup checks, and worker launch
│   ├── pipeline.rs         Observe canonical history → ingest → confirm
│   ├── runtime.rs          Writer lease, proof checks, polling, and retries
│   ├── source.rs           Common source interface and event types
│   ├── source/{evm,generic}.rs  Chain-specific fetching and normalization
│   ├── store.rs            Atomic events, checkpoints, and confirmation frontier
│   └── enrichment.rs       Delivery/gas receipts and backlog monitoring
├── store/                  Block/transaction enrichment and CCR persistence
└── db/                     Database queries and generated SeaORM models
    └── event_receipts.rs   Pending delivery/gas receipts, linking, backlog age
migration/
├── src/                    Schema history, views, notifications, managed indexes
├── bin/                    Initialization, rollback, and entity-generation tools
└── tests/                  Database initialization integration test
```

Start reading at `main.rs` → `agent.rs` → `near_head::spawn`. The worker's
`runtime::cycle` coordinates the three phases in `pipeline.rs`.

Events are first stored near head, then published through confirmed views after
`reorgPeriod` and completeness checks. Reorgs can rewind the provisional suffix;
conflicts with confirmed history halt the chain. Receipt enrichment runs independently.
Dispatch reconciliation discovers confirmed rows every 5 seconds and periodically
sweeps older rows to recover from commit-order races and delayed message bodies.

## Local development

Run Cargo commands from `rust/main`:

```sh
docker run --name scraper -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16-alpine
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
export HYP_DB="$DATABASE_URL"
cargo run -p migration --bin init-db
cargo run -p scraper

# Tests start their own disposable PostgreSQL containers; Docker must be running.
cargo test -p scraper -p migration -- --test-threads=4
cargo clippy -p scraper -p migration -- -D warnings
cargo fmt --all --check
```

Configure the agent's chain settings and `chainsToScrape` through the shared agent
configuration loader. `dbMaxConnections` defaults to 10 and
`dbAcquireTimeoutMillis` to 15,000.

## Database operations

`init-db` applies migrations, then builds and verifies managed indexes concurrently.
Rerun it after repairing a failed index build. Scraper startup verifies required
indexes but does **not** migrate the database.

Empty domains initialize automatically. Existing history requires a verified
cutover with writers stopped; follow the [near-head runbook](../../../../docs/scraper/near-head.md).
See [migration operations](migration/README.md) for index repair and rollback rules.

For a disposable database, `fresh` drops the schema and `recreate-db` rolls migrations
down and up. Run `init-db` afterward to install separately managed indexes.
`generate-entities` replaces `src/db/generated/` using a temporary PostgreSQL container
on port 5432; review generated numeric types before using the output.

## Same-chain CCR swaps

Optional EVM `ccrRouters` configuration maps domain → router → collateral token.
Infra generates it from registry CCR routes. The CCR worker only indexes through
the confirmed frontier and stores swaps as synthetic message/delivery pairs.

Synthetic IDs are `0x00000000 || keccak256("SameChainCCR" || txHash32 || logIndex8)[0..28]`.
Clients can reproduce them with `syntheticCcrSwapMessageId` from
`@hyperlane-xyz/utils`. Nonces increment per source router; message bodies encode
the recipient and received amount. Missing transaction data keeps the batch
retryable so later swaps cannot consume earlier nonces.
