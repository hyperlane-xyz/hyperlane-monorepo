# Message activity

## Stored activities

Each event includes the message ID, relayer EVM address, origin/destination domains,
observation/receipt timestamps and structured activity data. Storage is best effort.

| Area | Activities |
| --- | --- |
| Admission | Whitelist/blacklist/denylist exclusions and queue evictions |
| Retries | Status, reason, count, next attempt, restored backoff, retry limit and drops |
| ISMs | Metadata build results, module types, routed children, aggregation members/threshold and verified count |
| Validators | Validator sets/thresholds, announcement/storage reads, failures and reorg reports |
| Signatures | Checkpoint indices, verified signature counts per collection/root, missing or invalid signatures and read failures |
| Merkle data | Missing tree/leaf, leaf/highest-known index, proof results and root mismatches |
| CCIP / CCTP | Request attempts, HTTP status, attestation pending, timeouts, response failures, success and exhausted retries |
| Delivery | ISM dry-runs, simulations, typed chain errors, payload creation, transaction outcomes/hashes, confirmation failures and delivery completion |

RPC/storage URLs, credentials, raw errors, message bodies, metadata and signature
bytes are excluded. Offchain success means metadata was received, not verified.

## Migrations

Set `DATABASE_URL` to the separate diagnostics database using owner credentials,
then run:

```sh
cd rust/main
cargo run --locked -p message-activity-migration --bin init-message-activity-db
```

Run one migration job at a time before updating relayers. SeaORM tracks applied
versions in `seaql_migrations`; reruns apply only pending migrations. Relayers do
not run migrations themselves.

For schema changes, add a versioned module under `agents/relayer/migration/src`
and append it to `Migrator::migrations()` in `src/lib.rs`. Keep applied migrations
unchanged. Rolling back the initial migration deletes the activity table.
