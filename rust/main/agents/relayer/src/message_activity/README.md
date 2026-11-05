# Message activity

## Stored activities

Each event includes the message ID, relayer EVM address, origin/destination domains,
observation/receipt timestamps and structured activity data. Storage is best effort.

| Area | Activities |
| --- | --- |
| Admission | Explicit blacklist/denylist exclusions and queue evictions |
| Retries | Status, reason, count, next attempt, retry limit and drops |
| ISMs | Metadata build results, module types, routed children, aggregation members/threshold and verified count |
| Validators | Validator sets/thresholds, storage failures and reorg reports |
| Signatures | One summary per completed collection: indices attempted, latest advertised indices and discovery failures, best matching signature count/root at the last attempted index, and exact-checkpoint unavailable validators |
| Merkle data | Missing tree/leaf, leaf/highest-known index, proof failures and root mismatches |
| CCIP / CCTP | First pending response, final outcome/attempt count per endpoint, HTTP status, timeouts and response failures |
| Delivery | ISM verification outcomes, simulation/payload failures, typed chain errors, transaction outcomes/hashes, confirmation failures and delivery completion |

RPC/storage URLs, credentials, raw errors, message bodies, metadata and signature
bytes are excluded. Offchain success means metadata was received, not verified.

One prepare-start event clears stale attempt state in the reader. Nested metadata
starts and routine validator storage, proof and simulation starts/successes are omitted. Configuration
(module types, routes, validators) is retained per attempt so each attempt remains
interpretable. Real retries retain their reason/count/deadline; restart does not
replay stored status or backoff. CCIP pending retries emit the first pending state
and the endpoint's final outcome, not each intermediate request.

Checkpoint summaries retain only the latest attempted index and at most the validated
validator set (50 entries), regardless of how far the checkpoint search walks.
Counts never combine different roots or indices. Collection summaries are emitted
on completion, including failure, but not for canceled aggregation children.
The reader accepts both compact summaries and the previous per-observation format;
deploy the updated reader before the writer to display compact quorum progress.

## Deployment wiring

Mainnet, release-candidate and fast-path relayers reference the existing GCP
secret `hyperlane-mainnet-relayer-postgres-writer-url` in project
`abacus-labs-dev` through Helm's optional
`hyperlane.relayer.messageActivityDatabaseUrlSecret` value. External Secrets
injects it as `HYP_MESSAGEACTIVITYDATABASEURL` into the relayer pod. Neither the
URL nor its credentials belong in Helm values or ConfigMaps. Other environments
remain opt-in. Run the migrations before deploying a diagnostics-enabled agent
image.

## Storage health and coverage

`hyperlane_message_activity_events_total{outcome="written|dropped|failed"}` counts
successful rows, queue-full/closed drops, and rows lost to failed/timed-out batches.
The three outcomes are separate, not overlapping. Alert on increases in `dropped`
or `failed`. Delivery tasks only increment counters on a full queue; background
write warnings are limited to one per 30 seconds and retries use 5–10 second jitter.
Diagnostics remain best effort: queued events are not flushed during shutdown.

Committed inserts publish the affected message ID (64 lowercase hex characters)
on PostgreSQL channel `message_activity_insert`. PostgreSQL coalesces identical
notifications within a transaction. Notifications are wakeups, not durable history;
readers refresh watched messages after reconnecting.

Transaction hashes/outcomes currently cover the classic submitter only. Lander
submission does not yet provide its dispatcher transaction outcome to this reporter;
its history still includes retries, payload errors and observed delivery completion.
The startup log records the chosen identity domain/address. Identity uses the
lowest initialized destination signer, so it may change if that destination fails
startup; this is not a stable deployment identifier.

## Retention

Current expected traffic is approximately **100k messages per month**, not per day.
Rows per message vary with retries and ISM composition; monitor actual database size.
Keep diagnostics for 90 days. The initial migration creates a small BRIN index on
`received_at` for cleanup.

Before enabling shared storage, configure one daily maintenance job (e.g. 03:00 UTC)
to run the following with maintenance credentials supplied through `DATABASE_URL`:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rust/main/agents/relayer/src/message_activity/prune.sql
```

The job needs `DELETE` on `public.message_activity`; do not grant this to relayers.
This repository provides the cleanup SQL; the scheduler must be installed separately.
Deleting old history also removes diagnostics for long-stuck messages older than the
retention window. PostgreSQL autovacuum reclaims space for subsequent inserts.

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
