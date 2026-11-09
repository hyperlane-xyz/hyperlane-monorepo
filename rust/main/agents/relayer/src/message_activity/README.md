# Message activity

## Stored activities

Each event includes the message ID, relayer EVM address, origin/destination domains,
observation/receipt timestamps and structured activity data. Storage is best effort.

| Area | Activities |
| --- | --- |
| Lifecycle | Relayer first-seen time, phase start, retries, submitter acceptance, pending inclusion, mempool, inclusion/finality and delivery observation |
| Admission | Runtime denylist drops of in-flight messages and queue evictions |
| Retries | Status, reason, count, next attempt, retry limit and drops |
| ISMs | Metadata build results, module types, routed children, aggregation members/threshold and verified count |
| Validators | Validator sets/thresholds, storage failures and reorg reports |
| Signatures | One summary per completed collection: indices attempted, latest advertised indices and discovery failures, best matching signature count/root at the last attempted index, and exact-checkpoint unavailable validators |
| Merkle data | Missing tree/leaf, leaf/highest-known index, proof failures and root mismatches |
| CCIP / CCTP | First pending response, final outcome/attempt count per endpoint, HTTP status, timeouts and response failures |
| Delivery | ISM verification outcomes, simulation/payload failures, typed chain errors, transaction outcomes/hashes, confirmation failures and delivery completion |

RPC/storage URLs, credentials, raw errors, message bodies, metadata and signature
bytes are excluded. Offchain success means metadata was received, not verified.

Legacy event readers clear attempt state on prepare start. Snapshot writers retain
the latest known observations when preparation reuses cached metadata; changed
validator sets, checkpoint identities and metadata failures invalidate the affected
proof state. A reprepare invalidates the frozen submission path, while confirmation
polling retains it. Nested metadata starts and routine proof and simulation
starts/successes are omitted. Configuration
(module types, routes, validators) is retained per attempt so each attempt remains
interpretable. Real retries retain their reason/count/deadline; restart does not
replay stored status or backoff. CCIP pending retries emit the first pending state
and the endpoint's final outcome, not each intermediate request.

Admission scans do not write diagnostics for messages already excluded by a
blacklist/denylist or already at their persisted retry limit. Startup, migration
and rescans may revisit large historical backlogs; these decisions remain in
loader logs/metrics. Live denylist drops and fail-fast retry-limit transitions
still produce activity events.

Checkpoint summaries retain only the latest attempted index and at most the validated
validator set (50 entries), regardless of how far the checkpoint search walks.
Counts never combine different roots or indices. Collection summaries are emitted
on completion, including failure, but not for canceled aggregation children.
The reader accepts both compact summaries and the previous per-observation format;
deploy the updated reader before the writer to display compact quorum progress.

The first public state, every `ready_to_submit` transition, and terminal delivery
or drop are complete `snapshot` anchors. Between anchors, `snapshot_update` rows
contain complete message-level state, complete replacements for changed ISM nodes,
and `removed_modules` node IDs. Consumers upsert modules by stable `node_id` and
apply removals. Each update is cumulative relative to the latest anchor, so the
reader needs only that anchor and the newest update. Updates never use ambiguous
field-level JSON patches. A writer restart or failed database write publishes
another complete anchor before updates resume.

Failed local recovery writes remain pending in memory and are retried on the next
observation, including failed submission invalidations. Recovery is best effort:
process loss or cache eviction before any successful invalidation write can lose
that transition. An unwritable local store does not provide crash durability.

`relayer_first_seen_at_millis` is captured when the relayer creates the pending
operation, not when its first prepare attempt runs. `phase_started_at_millis`
marks the current phase transition. Submission updates carry their own observation
time; `included`/`finalized` describe the destination transaction, while
`delivered_observed_at_millis` is when the relayer confirmed mailbox delivery.
Repeated lander status polls are suppressed before enqueue and again by the state
projector. A row is emitted only for a changed public stage or other state.

## Deployment wiring

Hyperlane, release-candidate and fast-path relayers reference GCP secrets in project
`abacus-labs-dev`: `hyperlane-mainnet-relayer-postgres-writer-url` on mainnet and
`hyperlane-testnet4-relayer-postgres-writer-url` on testnet, through Helm's optional
`hyperlane.relayer.messageActivityDatabaseUrlSecret` value. External Secrets
injects it as `HYP_MESSAGEACTIVITYDATABASEURL` into the relayer pod. Neither the
URL nor its credentials belong in Helm values or ConfigMaps. Other environments
remain opt-in. Run the migrations before deploying a diagnostics-enabled agent
image.

Both environments share this database. Their scraper proxies use
`hyperlane-mainnet-relayer-postgres-reader-url` and
`hyperlane-testnet4-relayer-postgres-reader-url`, respectively, for diagnostics reads.
The testnet secrets copy the mainnet values under a prefix allowed by testnet's
External Secrets IAM policy; rotate both copies together. Rows carry
origin/destination domain IDs; resolve these against registry chain metadata
(`isTestnet`) to distinguish networks. There is no environment or context column,
and diagnostics queries are scoped by message ID, not environment. The relayer
address identifies the reporter, not an explicit Hyperlane/RC/fast-path context.

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
reports submitter acceptance, pending inclusion, mempool, included and finalized
stages, but does not expose its dispatcher transaction hash through this interface.
The startup log records the chosen identity domain/address. Identity uses the
lowest initialized destination signer, so it may change if that destination fails
startup; this is not a stable deployment identifier.

Rows are retained indefinitely. This repository does not provide or configure an
activity cleanup job.

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
