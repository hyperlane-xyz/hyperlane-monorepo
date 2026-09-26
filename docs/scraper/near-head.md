# Near-head scraper ingestion

The scraper indexes dispatch, delivery, gas-payment and Merkle-insertion events
at the current head by default on every selected supported chain except Fuel.
Each event is stored once in its existing table. Permanent headers for event
blocks remain in `block`; the current confirmation boundary and sparse unconfirmed
range checkpoints live in `scraper_checkpoint`. `scraper_head` contains only
per-chain progress and health, not event payloads.

The scraper advances `scraper_head.confirmed_height` after the chain's existing
`reorgPeriod`. The proxy publishes that newly visible height range, and gas-payment
cursors are allocated atomically with the frontier advance. The proxy and Explorer
query confirmed views, preserving their configured delay.
There is no new endpoint or subscriber-selected delay in this change.

`scraper_head` announces initialized, progress, status, and
rollback boundaries, including the indexed hash and previous indexed height.
These are transactional PostgreSQL notifications. A rollback emits one
head boundary rather than one notification for every deleted event. Notifications
are wake-up hints; reconnect and catch-up must read the persisted rows and head.

Select chains with `chainsToScrape` as before. No `nearHead` setting or per-chain
`fromBlock` values are needed. Fuel retains its existing path because its delivery,
gas-payment, and Merkle indexers are not implemented.
The old `HYP_NEARHEAD` and `HYP_NEARHEAD_<DOMAIN>_FROMBLOCK` variables are no longer
used and can be removed.

An empty EVM domain starts automatically at `index.from`. Non-EVM domains require
an explicit verified `scraper_head` cutover even when their event tables are empty,
because their indexers cannot provide historical counts pinned immediately before
`index.from`; this also avoids treating a sequence-mode starting index as a block
height. A domain with existing block or event rows and no `scraper_head` state
fails closed. Neither the greatest stored height nor the shared legacy cursor proves
that all four legacy streams completed that height: choosing either can skip a
slower gas-payment or delivery backlog.

Existing domains require the verified cutover below. Startup rechecks that an
automatically initialized domain is still empty after RPC preflight. Restarts
load the saved boundary and resume indexed progress; they do not select a new
boundary from stored maxima. Contract changes are rejected.

## Behavior

- EVM uses one combined RPC log query for all four event types. Other protocols
  use their existing four range indexers concurrently. Both use the existing
  `index.chunk` limit. Headers are fetched only for blocks
  containing events and range boundaries, not every empty block. Events and the
  end checkpoint commit atomically, including when the range has no events.
- Each returned log must match its block header. The previous indexed boundary
  and the range end are checked again before commit; changed forks are retried.
  On EVM, dispatch nonces and Merkle leaf indexes must exactly cover counts read
  from their contracts at both boundary hashes. Other protocols anchor continuity
  to the database cutover and compare ingested counts with each indexer’s reported
  sequence count once its reported tip is covered. Sequence-mode protocols page
  from the durable count until they pass the current block boundary and prove each
  requested page complete before filtering by block. Missing first, middle, tail,
  or entire sequences reject the range without advancing progress. The last
  successfully committed counts are reused only for the same boundary hash;
  restart or changed ancestry reloads them from durable rows. Delivery and gas
  streams receive the same check when their indexers expose sequence counts;
  otherwise completeness depends on the RPC returning all matching logs.
  Non-EVM publication is capped at the minimum current event-stream tip.
  Sequence-mode streams additionally require contiguous pages through each
  indexed boundary; a lagging sequence tip rejects the range before commit.
  Generic adapters preserve provider transaction and log positions. The
  provisional database key includes both positions and the event identity so
  protocols without a globally unique log index remain collision-safe.
- Polling uses `index.interval`, with the legacy range cursor's 30-second default.
  An unchanged EVM head costs one RPC call and no log query. Generic adapters
  read chain metrics and then the latest block header, so an unchanged non-EVM
  head normally costs two provider calls. Catch-up ranges run
  without an idle delay. Each cycle ingests before publishing, so newly indexed
  events do not wait for another poll. Page-limited publication repeats without
  an idle delay. Publication targets 1,000 events per
  transaction rather than 100 blocks, allowing empty spans to advance together.
  A block containing more than 1,000 events publishes as one indivisible batch;
  the event budget is therefore soft. `safe`/`finalized` tag checks use the
  same timer rather than a new one-second RPC polling loop.
- Inserts use batches of at most 1,000 rows per table in the same atomic
  transaction. A failed batch rolls back both events and progress.
- A lagging RPC head pauses ingestion and publication without deleting the
  retained suffix. A reorg rolls back to the newest retained checkpoint on the canonical chain,
  then replays the range. Confirmation stores its exact boundary header even
  when that height was an empty block inside a range. Protocols with sparse block
  numbering choose the newest available boundary at or below the requested height.
- Confirmation requires a healthy head observation within its lease (twice the
  polling interval, at least 60 seconds) and cannot pass indexed progress or the
  observed head. A finality tag read after the observation may be newer than it;
  confirmation then stops at the observed head. The lease only proves a recent
  healthy observation: confirmation still rechecks ancestry against the RPC, and
  an older head only lowers the boundary. Each cycle observes, ingests, then
  confirms, so newly ingested events can publish immediately. Committing ingestion
  refreshes the observation lease after long RPC calls. An ingestion failure is
  logged before existing eligible history publishes; page-limited publication
  drains before the error pauses the loop. The three phases execute sequentially
  for each chain, so they do not compete for that chain's progress-row lock.
- Startup probes the configured finality selector and, on EVM, hash-pinned
  contract-count calls before persisting a first-time cutover. On restart it probes the provider's
  latest canonical block. Observation waits for providers behind saved progress
  and reconciles retained ancestry before publication. It fails immediately with
  a checkpoint-sync error if the saved confirmed or indexed checkpoint is absent
  or the indexed hash differs. Ingestion errors do not prevent already indexed
  history from publishing. A confirmation error marks the chain critical and
  pauses the combined cycle. A stalled boundary limits the provisional suffix to
  10,000 blocks plus the configured numeric reorg depth; at the limit the worker
  continues confirmation without extending the provisional suffix and raises
  the chain critical-error metric until confirmation opens room again.
  `scraper_head.healthy` describes the head-observation lease, not overall worker
  health. Compare the `indexed_height` metric's `near_head` series with the
  confirmed event series to observe confirmation lag. Alert rules for the
  chain critical-error metric should use a `for` window longer than the expected
  finality-tag update interval so slow but advancing tags do not flap alerts.
- Unpublished forks are deleted and reindexed. Existing block, transaction,
  message and leaf uniqueness constraints are unchanged. Fork occurrences are not
  archived. A reorg crossing confirmed history persists a halt and raises the
  chain critical-error metric; recovery requires operator repair. This version
  cannot retract anything already consumed by a legacy client.
- The CCR indexer is capped at the near-head confirmed frontier and stops on a
  persistent halt, preventing auxiliary writes into the provisional suffix.
- Near-head dispatch reconciliation starts immediately and discovers newly
  confirmed dispatches every 30 seconds, rather than the legacy five-minute
  fallback cadence. Legacy chains retain their existing reconciliation schedule.
- Confirmation does not wait for receipt enrichment. Gas/delivery transaction
  metadata is filled in by independent gas and delivery loops. Each page contains
  at most 100 event rows; healthy full pages drain immediately with a scheduler
  yield, while short, exhausted or failed pages wait for the polling interval.
  Failed/timed-out pages advance their scan cursor so later pages are attempted;
  missing receipts are retried on the next sweep. Cache lookups are batched per
  page, and at most 16 missing receipts are fetched concurrently across all domains.
  Database work uses a separate five-permit limit, and no database permit is held
  while an RPC is pending. The two streams can briefly fetch the same uncached transaction;
  uniqueness constraints and the linker handle concurrent inserts.
  Fetching and linking each have a separate 30-second timeout. Completed receipts
  are linked even when a neighboring receipt times out. Existing nullable
  transaction relations remain nullable until enrichment succeeds. Generic
  adapters store unavailable transaction hashes as NULL, excluding those rows
  from receipt retries and backlog age. The
  `hyperlane_scraper_receipt_oldest_pending_seconds{chain,event_type}` gauge tracks
  age since creation of the oldest pending row by ID, including time it spent
  provisional. It is sampled independently once per poll and returns zero when
  the stream has no pending rows.
- Confirmation deletes superseded rows directly from the small
  `scraper_checkpoint` table by `(domain,height)`. There is no background header
  scanner. `block` receives only headers for blocks containing actual events;
  those headers remain available for transaction enrichment. Historical headers
  left by older scraper versions are not removed automatically.
- Block/log/transaction positions are recorded for future custom-period consumers.
  No further database schema is required for block-count confirmation periods.
  Adding those consumers still requires a reorg-aware cursor/reset protocol that
  carries the event block hash; the current legacy protocol must not be pointed
  directly at provisional data. Subscriber cursors belong to the proxy/client,
  not this shared database.

## RPC cost

For a caught-up unchanged EVM head: one header request per poll. For a normal EVM new
range containing events in `B` distinct blocks: at most `B + 6` header requests
and one combined log request plus two new contract-count reads on consecutive
committed ranges. Non-EVM ranges make one sequence-watermark request per stream
and one or more bounded, paged event requests per stream; sparse numbering can require
additional boundary lookups. The
first range after startup or a changed boundary hash requires four count reads;
startup capability probes are additional. Numeric confirmation needs up to two header reads when it advances;
finality tags also require a tag read while provisional progress exists. Count
reads require hash-pinned `eth_call` support; an empty pre-deployment result also
requires `eth_getCode` to distinguish an absent contract from a malformed reply. Receipt enrichment and retries are extra.
The legacy path used up to four event range queries plus its separate tip and
receipt/header lookups. Costs are comparable in structure, not guaranteed equal:
chain activity, polling configuration, confirmation batches, and RPC retries
still determine the actual total. This has not been benchmarked in production.

## Validation fixture

The `incomplete_sequences_retry_after_restart_and_dense_ranges_batch_atomically`
test covers 2,004 events across multiple insert batches, incomplete sequence
retries, and atomic rollback on a duplicate in a later batch. This fixture uses
seven insert statements instead of 2,006 individual event/header inserts.
One local PostgreSQL 16 Docker run with an unoptimized Rust test build measured
54 ms ingestion and 36 ms maximum concurrent confirmation-row lock acquisition,
including the database round trip. These are fixture observations, not production
throughput estimates or a before/after latency benchmark.

The follow-up `confirmation_budget_preserves_blocks_and_measures_gas_dense_publication`
fixture covers 3,002 gas payments and mixed event types, verifies cursor ordering
across publication commits, and reports publication time, progress-lock acquisition
and cluster WAL delta. Those timings include the existing per-payment cursor and
notification triggers; they are local observations, not production estimates.
Worker regressions exercise failing/stationary finality tags and recovery through
the actual loops. Receipt tests drain multiple pages while the other event stream
hangs, and verify uncached successful receipts survive a neighboring timeout.

## Rollout

1. Before stopping the legacy scraper, verify every selected provider supports
   event-range queries, block lookup, latest height, and its configured
   finality selector. EVM additionally requires block-hash-pinned `eth_call` for
   the mailbox nonce and Merkle hook count; empty predeployment results require
   block-hash-pinned `eth_getCode`. Check the actual configured endpoints and
   historical boundary state. Fleet capability has not been established by
   the local tests. There is no legacy opt-out after this hard cutover.
2. Build this scraper and migration, and prepare the scraper image-tag update for
   every environment sharing the database. Deploy the matching proxy first so it
   listens for frontier notifications, then stop **all** scraper deployments.
   For `explorer4`, this means both mainnet3 and testnet4. Apply the migration
   before deploying the matching binaries. Land the image-tag update before or
   with the migration so a routine deployment cannot restart an old writer.
   Measure index creation on a database clone and allow a
   maintenance window. Run `cargo run --release -p migration --bin init-db` with
   `DATABASE_URL` set for the `postgres` role, which owns the existing tables and
   migration history, to apply migrations, verify every concurrent index, and run
   `ANALYZE` on the event tables. Do not start a scraper unless `init-db` reaches
   both index verification and `ANALYZE`; rerun it after any interrupted build. Use the
   migration binary built from this PR for both upgrades and rollbacks; older
   binaries do not know checkpoint migration 15. After stopping writers, wait at
   least 90 seconds before migrating so the migration's activity gate can pass.
3. For each existing supported domain, complete the verified cutover below.
   Empty EVM domains need no seed; non-EVM domains still require an explicit
   verified cutover. Start the scraper and matching proxy only afterwards.
4. Check `scraper_head` for advancing `indexed_height` and `confirmed_height`,
   verify the chain critical-error metric is clear, and check consumer streams.

Before migration, every existing head must have both boundary rows in `block`:

```sql
SELECT h.domain,h.confirmed_height,h.indexed_height
FROM scraper_head h
WHERE NOT EXISTS (
  SELECT 1 FROM block b
  WHERE b.domain=h.domain AND b.height=h.confirmed_height
) OR NOT EXISTS (
  SELECT 1 FROM block b
  WHERE b.domain=h.domain AND b.height=h.indexed_height
    AND b.hash=h.indexed_hash
);
```

This must return no rows. After migration, connect as `postgres` or a scraper
writer role with access to `scraper_checkpoint` and run:

```sql
SELECT h.domain,h.confirmed_height,h.indexed_height
FROM scraper_head h
WHERE NOT EXISTS (
  SELECT 1 FROM scraper_checkpoint c
  WHERE c.domain=h.domain AND c.height=h.confirmed_height
) OR NOT EXISTS (
  SELECT 1 FROM scraper_checkpoint c
  WHERE c.domain=h.domain AND c.height=h.indexed_height
    AND c.hash=h.indexed_hash
) OR EXISTS (
  SELECT 1 FROM scraper_checkpoint c
  WHERE c.domain=h.domain AND c.height>h.indexed_height
);
```

This must return no rows. Do not start any old scraper image after migration.

The scraper database can be shared across environments: testnet4 and mainnet3
both use `explorer4` on `pgsql-message-explorer-0`. Stopping one environment's
writers does not stop the other's. Table locks, long scans and catch-up load
taken for one environment also stall the other.

If startup reports that checkpoints are out of sync, stop every writer and repair
only after checking the saved head against the canonical chain. Save the following
script and run it as `postgres` with `psql "$DATABASE_URL" -v domain=N -f repair.sql`.
It replaces one domain's retained range from the old writer's `block` checkpoints:

```sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE scraper_head IN EXCLUSIVE MODE;
DELETE FROM scraper_checkpoint c
USING scraper_head h
WHERE c.domain=h.domain AND c.domain=:'domain'::integer;
INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
SELECT b.domain,b.height,b.hash,b.timestamp
FROM scraper_head h CROSS JOIN LATERAL (
  SELECT domain,height,hash,timestamp FROM block b
  WHERE b.domain=h.domain AND b.height>=h.confirmed_height
    AND b.height<=h.indexed_height
  OFFSET 0
) b
WHERE h.domain=:'domain'::integer;
COMMIT;
```

Run the post-migration boundary check above before restarting. If `block` lacks the
full retained range or its indexed hash differs, restore or reseed from a separately
verified canonical boundary instead of using this repair.

### Verified legacy cutover

There is no automatic completeness proof in the legacy database. Before seeding
state, verify dispatch, delivery, gas-payment and Merkle-insertion indexing have
all completed through the same finalized height `H`, with no pending range/retry
at or below it. A shared cursor, the latest stored event, or an idle stream is not
that proof. If necessary, drain legacy indexing against a source whose configured
confirmation frontier is fixed at `H`; after stopping it, compare the four
configured contracts' RPC logs through `H` with stored occurrences and repair
missing events. Dispatch nonce and
Merkle count checks supplement that comparison; they cannot establish delivery
or gas-payment completeness. If completeness cannot be verified, do not seed the
row. Resume the legacy deployment and finish the audit/backfill first.

#### Stop writers

Scale every scraper sharing the database to zero (rollout step 2) and confirm no
writer remains, both in the cluster and in the database:

```bash
kubectl --context <cluster> -n <env> scale statefulset omniscient-scraper-hyperlane-agent-scraper3 --replicas=0
kubectl --context <cluster> -n <env> get pods | grep scraper3   # expect none
```

```sql
SELECT pid, application_name, state, query_start FROM pg_stat_activity
WHERE usename IN ('<scraper role>', ...);   -- expect no rows
```

Always pass an explicit kube context. On a shared database, repeat for every
environment and check every scraper role.

#### Choose `H`

`H` must be at or below the lowest completed height across all four streams and
at or above every stored block/event for the domain. The maximum stored height
alone is not that bound. Dispatch and Merkle insertions are sequence-aware and
store events in order, but delivery and gas payments use range watermarks. Both
write the same `cursor` row (`event_type=''`), which keeps the higher of the two.
That row is therefore an upper bound for the slower stream, not proof.

- If stored rows extend above the `''` cursor, for example dispatches from a
  faster sequence-aware indexer, the slower of delivery and gas payment may be
  missing events in `(cursor, H]`. Compare delivery and gas-payment RPC logs over
  that range with stored rows and repair them before seeding at `H`.
- If the cursor is above every stored row, any `H` in `[max stored height,
cursor]` avoids overlap. Near-head re-scans `(H, head]`. Picking `H` close to
  the cursor avoids re-scanning a long empty range; audit delivery and gas logs
  over `(max stored height, H]` first.

Quiet chains can look stale by their latest stored event while the legacy
cursor is current; somniatestnet had no stored event for 50 days but a cursor
from the same morning. Seed those near the cursor rather than at the last event.
For a domain that really is far behind, starting near the head instead of
backfilling leaves a permanent dispatch and Merkle sequence gap. Relayer and
validator streams detect the gap and stay on RPC for that chain, and the Explorer
lacks that history. Only accept this for chains without stream consumers. Otherwise
backfill off-peak, after checking database headroom, particularly on a shared
database.

Record the verification evidence, canonical hash and timestamp of `H`, and the
configured mailbox, Merkle hook and gas-paymaster addresses. `H` must be at least
`index.from - 1`. All writers must remain stopped.

#### Check overlap

Run these read-only checks before seeding, outside any transaction or lock. They
do **not** prove completeness. `saved_state` must be NULL and every `*_max` NULL
or at most `H`:

```sql
SELECT
  (SELECT 1 FROM scraper_head WHERE domain=:'domain'::integer) AS saved_state,
  (SELECT max(height) FROM block WHERE domain=:'domain'::integer) AS block_max,
  (SELECT max(origin_block_height) FROM raw_message_dispatch WHERE origin_domain=:'domain'::integer) AS dispatch_max,
  (SELECT max(block_number) FROM merkle_tree_insertion WHERE domain=:'domain'::integer) AS merkle_max,
  (SELECT max(block_number) FROM delivered_message WHERE domain=:'domain'::integer) AS delivery_max,
  (SELECT max(block_number) FROM gas_payment WHERE domain=:'domain'::integer) AS gas_max;
```

Legacy delivery and gas rows may have a NULL `block_number`, so their heights
are also bounded by `block_max`.

Use `max()` rather than `EXISTS (... > H)` for heights. With no matching rows,
PostgreSQL can plan the `EXISTS` form as a full sequential scan: on production
`merkle_tree_insertion` (about 12M rows) it exceeded 15s. The `max()` form reads
one entry of the `(domain, height)` index.

#### Seed

With writers provably stopped, seed under the per-domain advisory lock only. Do
not add `LOCK TABLE`. A table lock blocks every environment writing to a shared
database for the whole transaction. Only cheap indexed checks are repeated
here. Supply `domain` as the stored `domain.id` integer (unsigned IDs above
`2^31-1` are stored minus `2^32`), `height`, `timestamp` as Unix seconds, and
`block_hash`, `mailbox`, `hook`, `paymaster` as hex without `0x`, using
`psql -v name=value`.

```sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE verified_cutover (
  domain integer NOT NULL,
  height bigint NOT NULL CHECK (height BETWEEN 0 AND 4294967294),
  timestamp bigint NOT NULL CHECK (timestamp >= 0),
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  mailbox bytea NOT NULL CHECK (octet_length(mailbox) IN (20,32)),
  hook bytea NOT NULL CHECK (octet_length(hook) IN (20,32)),
  paymaster bytea NOT NULL CHECK (octet_length(paymaster) IN (20,32))
) ON COMMIT DROP;
INSERT INTO verified_cutover VALUES (
  :'domain'::integer, :'height'::bigint, :'timestamp'::bigint,
  decode(:'block_hash','hex'), decode(:'mailbox','hex'),
  decode(:'hook','hex'), decode(:'paymaster','hex')
);
SELECT pg_advisory_xact_lock(domain::bigint & 4294967295)
FROM verified_cutover;
DO $$
DECLARE c verified_cutover%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM verified_cutover;
  IF EXISTS (SELECT 1 FROM scraper_head WHERE domain=c.domain) THEN
    RAISE EXCEPTION 'Saved near-head state already exists; do not reseed it';
  END IF;
  IF EXISTS (SELECT 1 FROM scraper_checkpoint WHERE domain=c.domain)
    OR (SELECT max(height) FROM block WHERE domain=c.domain)>c.height
    OR (SELECT max(origin_block_height) FROM raw_message_dispatch
        WHERE origin_domain=c.domain)>c.height
  THEN
    RAISE EXCEPTION 'History overlaps the cutover; rerun the overlap checks';
  END IF;
  IF EXISTS (SELECT 1 FROM block WHERE domain=c.domain
             AND height=c.height AND hash<>c.hash)
    OR EXISTS (SELECT 1 FROM block WHERE hash=c.hash
               AND (domain<>c.domain OR height<>c.height))
  THEN
    RAISE EXCEPTION 'Cutover hash disagrees with stored block identity';
  END IF;
  INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,
                          head_height,confirmed_height,mailbox,merkle_tree_hook,
                          interchain_gas_paymaster)
    VALUES(c.domain,c.height,c.height,c.hash,c.height,c.height,
           c.mailbox,c.hook,c.paymaster);
  INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
    VALUES(c.domain,c.height,c.hash,to_timestamp(c.timestamp) AT TIME ZONE 'UTC');
  INSERT INTO block(domain,height,hash,timestamp)
    VALUES(c.domain,c.height,c.hash,to_timestamp(c.timestamp) AT TIME ZONE 'UTC')
    ON CONFLICT(hash) DO NOTHING;
END $$;
COMMIT;
SELECT domain,start_height,encode(indexed_hash,'hex') AS block_hash,
       encode(mailbox,'hex') AS mailbox,encode(merkle_tree_hook,'hex') AS hook,
       encode(interchain_gas_paymaster,'hex') AS paymaster,healthy
FROM scraper_head WHERE domain=:'domain'::integer;
```

Compare this readback with the recorded inputs and a fresh RPC lookup of block
`H`. Do not start the new scraper if its canonical hash changed; keep writers
stopped and repair/reverify the boundary first.

The seeded state starts unhealthy. Startup validates the configured contracts
and required RPC methods; the observation loop must establish a fresh canonical
head before publication. If a writer or audit changes history before handoff,
repeat verification rather than moving the saved boundary forwards.

On a shared database, check its headroom before starting the scraper. Every
seeded domain starts catching up from its `H` at once.

SELECT grants on existing event tables are copied to the confirmed views. External
SQL consumers wanting the old visibility must use `confirmed_raw_message_dispatch`,
`confirmed_delivered_message`, `confirmed_gas_payment`, or
`confirmed_merkle_tree_insertion`. `message_view` and `total_gas_payment` retain
both their names and output columns. Raw event tables now include provisional rows.
Roles with `SELECT` on any event table also receive `SELECT` on `scraper_head`.

To roll back to the previous near-head scraper image from this version, stop every
scraper deployment sharing the database and pause proxy reads during a maintenance
window, then run
`cargo run --release -p migration --bin down 1`. This restores the transitional
`confirmed` columns without rewriting historical confirmed rows. The transactional
down migration takes access-exclusive table locks while rebuilding the old partial
indexes, so production-scale tables block reads and replica replay: about 35-50s
cold on explorer4 (15-25s with parallel workers), during which Explorer queries on
the replica stall too. Then deploy the previous scraper image. Never start it
before the down migration.

To return to legacy indexers, stop every scraper writer, drain or explicitly
repair/discard provisional and halted history, then run
`cargo run --release -p migration --bin down 3`. The final down migration removes
confirmation filtering and drops `scraper_head`; it refuses to proceed while
provisional or halted history remains. The checkpoint migration restores and
drops `scraper_checkpoint`, so both near-head state tables are gone before legacy
indexing restarts. Use `down 2` only to return to the earlier near-head image that
still stored checkpoints in `block`.
