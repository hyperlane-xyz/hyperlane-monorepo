# Near-head scraper ingestion

The scraper indexes dispatch, delivery, gas-payment and Merkle-insertion events
at the current head by default on all selected EVM chains. Each event is stored
once in its existing table, initially with `confirmed=false`. Permanent headers
for event blocks remain in `block`; the current confirmation boundary and sparse
unconfirmed range checkpoints live in `scraper_checkpoint`. `scraper_head`
contains only per-chain progress and health, not event payloads.

The scraper flips `confirmed` after the chain's existing `reorgPeriod`. Legacy
websocket notifications and gas-payment cursors are created on that transition.
The proxy and Explorer query confirmed views, preserving their configured delay.
There is no new endpoint or subscriber-selected delay in this change.

The migration also installs a future proxy notification contract without changing
the current proxy's behavior. `scraper_event_provisional` announces provisional
event inserts using the same `eventType`, `id`, and unsigned `domain` fields as
`scraper_event`. `scraper_head` announces initialized, progress, status, and
rollback boundaries, including the indexed hash and previous indexed height.
Both channels are transactional PostgreSQL notifications. A rollback emits one
head boundary rather than one notification for every deleted event. Notifications
are wake-up hints; reconnect and catch-up must read the persisted rows and head.

Select chains with `chainsToScrape` as before. No `nearHead` setting or per-chain
`fromBlock` values are needed. Non-EVM chains retain their existing indexers.
The old `HYP_NEARHEAD` and `HYP_NEARHEAD_<DOMAIN>_FROMBLOCK` variables are no longer
used and can be removed.

An empty domain starts automatically at `index.from` (block 1 when `index.from`
is 0). A domain with existing block or event rows and no `scraper_head` state
fails closed. Neither the greatest stored height nor the shared legacy cursor
proves that all four legacy streams completed that height: choosing either can
skip a slower gas-payment or delivery backlog.

Existing domains require the verified cutover below. Startup rechecks that an
automatically initialized domain is still empty after RPC preflight. Restarts
load the saved boundary and resume indexed progress; they do not select a new
boundary from stored maxima. Contract changes are rejected.

## Behavior

- One combined RPC log query covers all four event types over a block range,
  using the existing `index.chunk` limit. Headers are fetched only for blocks
  containing events and range boundaries, not every empty block. Events and the
  end checkpoint commit atomically, including when the range has no events.
- Each returned log must match its block header. The previous indexed boundary
  and the range end are checked again before commit; changed forks are retried.
  Dispatch nonces and Merkle leaf indexes must exactly cover the counts read
  from their contracts at both boundary hashes. Missing first, middle, tail, or
  entire sequences reject the range without advancing progress, including after
  restart. Independent count calls run concurrently with log fetching. The last
  successfully committed end counts are reused only for the same boundary hash;
  restart or changed ancestry causes a fresh read. Delivery and gas events have no sequence counters, so their completeness
  still depends on the RPC returning all matching logs.
- Polling uses `index.interval`, with the legacy range cursor's 30-second default.
  An unchanged head costs one RPC call and no log query. Catch-up ranges run
  without an idle delay. Confirmation wakes on progress and drains eligible
  batches without waiting for another poll. Publication targets 1,000 events per
  transaction rather than 100 blocks, allowing empty spans to advance together.
  A block containing more than 1,000 events publishes as one indivisible batch;
  the event budget is therefore soft. `safe`/`finalized` tag checks use the
  same timer rather than a new one-second RPC polling loop.
- Inserts use batches of at most 1,000 rows per table in the same atomic
  transaction. A failed batch rolls back both events and progress.
- A lagging RPC head pauses ingestion and publication without deleting the
  retained suffix. A reorg rolls back to the newest retained checkpoint on the canonical chain,
  then replays the range. Confirmation stores its exact boundary header even
  when that height was an empty block inside a range.
- Confirmation requires a healthy head observation within its lease (twice the
  polling interval, at least 60 seconds) and cannot pass indexed progress or the
  observed head. A finality tag read after the observation may be newer than it;
  confirmation then stops at the observed head. The lease only proves a recent
  healthy observation: confirmation still rechecks ancestry against the RPC, and
  an older head only lowers the boundary. Advancing the observed head can confirm
  existing events even if the next log fetch fails. Long in-flight RPC calls or
  database waits can expire the lease; confirmation then waits for a fresh
  observation. Observation, confirmation, and ingestion execute sequentially
  for each chain, so they do not compete for that chain's progress-row lock.
- Startup probes the configured finality tag and hash-pinned contract-count calls
  before persisting a first-time cutover. On restart it probes the provider's
  latest canonical block. Observation waits for providers behind saved progress
  and reconciles retained ancestry before publication. Ingestion and confirmation failures
  independently contribute to the chain critical-error metric; successful head
  reads cannot clear a confirmation failure. Ingestion pauses on confirmation
  errors. A stalled boundary limits the provisional suffix to 10,000 blocks plus
  the configured numeric reorg depth; reaching the limit raises a critical error.
  `scraper_head.healthy` describes the head-observation lease, not overall worker
  health. Compare the `indexed_height` metric's `near_head` series with the
  confirmed event series to observe confirmation lag.
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
  page, and at most eight missing receipts per stream (16 per domain) are fetched
  concurrently. The two streams can briefly fetch the same uncached transaction;
  uniqueness constraints and the linker handle concurrent inserts.
  Fetching and linking each have a separate 30-second timeout. Completed receipts
  are linked even when a neighboring receipt times out. Existing nullable
  transaction relations remain nullable until enrichment succeeds. The
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

For a caught-up unchanged head: one header request per poll. For a normal new
range containing events in `B` distinct blocks: at most `B + 6` header requests
and one combined log request plus two new contract-count reads on consecutive
committed ranges, independent of the number of empty blocks in the range. The
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

1. Before stopping the legacy scraper, verify every selected EVM provider supports
   its configured finality tag, when used, and block-hash-pinned `eth_call`
   for the mailbox nonce and Merkle hook count. Empty predeployment results also
   require block-hash-pinned `eth_getCode`. Check the actual configured endpoints
   and historical boundary state. Fleet capability has not been established by
   the local tests. There is no legacy opt-out after this hard cutover.
2. Stop scraper writers and the proxy. Apply the migration before deploying the
   matching binaries. Measure index creation on a database clone and allow a
   maintenance window. Run `cargo run --release -p migration --bin init-db` with
   `DATABASE_URL` set to apply migrations and verify concurrent indexes.
3. For each existing EVM domain, complete the verified cutover below. Empty
   domains need no seed. Start the scraper and matching proxy only afterwards.
4. Check `scraper_head` for advancing `indexed_height` and `confirmed_height`,
   verify the chain critical-error metric is clear, and check consumer streams.

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

Record the verification evidence, canonical hash and timestamp of `H`, and the
configured mailbox, Merkle hook and gas-paymaster addresses. `H` must be at least
`index.from - 1` and at or above every stored block/event for the domain. All
writers must remain stopped. The following `psql` transaction records this
operator-verified boundary; its overlap checks do **not** prove completeness.
Supply `domain` as the stored `domain.id` integer (unsigned IDs above `2^31-1`
are stored minus `2^32`), `height`, `timestamp` as Unix seconds, and `block_hash`,
`mailbox`, `hook`, `paymaster` as hex without `0x`, using `psql -v name=value`.

```sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE verified_cutover (
  domain integer NOT NULL,
  height bigint NOT NULL CHECK (height BETWEEN 0 AND 4294967294),
  timestamp bigint NOT NULL CHECK (timestamp >= 0),
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  mailbox bytea NOT NULL CHECK (octet_length(mailbox) = 20),
  hook bytea NOT NULL CHECK (octet_length(hook) = 20),
  paymaster bytea NOT NULL CHECK (octet_length(paymaster) = 20)
) ON COMMIT DROP;
INSERT INTO verified_cutover VALUES (
  :'domain'::integer, :'height'::bigint, :'timestamp'::bigint,
  decode(:'block_hash','hex'), decode(:'mailbox','hex'),
  decode(:'hook','hex'), decode(:'paymaster','hex')
);
SELECT pg_advisory_xact_lock(domain::bigint & 4294967295)
FROM verified_cutover;
LOCK TABLE block, raw_message_dispatch, delivered_message, gas_payment,
  merkle_tree_insertion, scraper_head, scraper_checkpoint
  IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE c verified_cutover%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM verified_cutover;
  IF EXISTS (SELECT 1 FROM scraper_head WHERE domain=c.domain) THEN
    RAISE EXCEPTION 'Saved near-head state already exists; do not reseed it';
  END IF;
  IF EXISTS (SELECT 1 FROM block WHERE domain=c.domain AND height>c.height)
    OR EXISTS (SELECT 1 FROM raw_message_dispatch
               WHERE origin_domain=c.domain AND (origin_block_height>c.height OR NOT confirmed))
    OR EXISTS (SELECT 1 FROM merkle_tree_insertion
               WHERE domain=c.domain AND (block_number>c.height OR NOT confirmed))
    OR EXISTS (SELECT 1 FROM delivered_message
               WHERE domain=c.domain AND (block_number>c.height OR NOT confirmed))
    OR EXISTS (SELECT 1 FROM gas_payment
               WHERE domain=c.domain AND (block_number>c.height OR NOT confirmed))
  THEN
    RAISE EXCEPTION 'History overlaps the cutover or contains provisional rows';
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

SELECT grants on existing event tables are copied to the confirmed views. External
SQL consumers wanting the old visibility must use `confirmed_raw_message_dispatch`,
`confirmed_delivered_message`, `confirmed_gas_payment`, or
`confirmed_merkle_tree_insertion`. `message_view` and `total_gas_payment` retain
both their names and output columns. Raw event tables now include provisional rows.
Roles with `SELECT` on any event table also receive `SELECT` on `scraper_head`.

To roll back to a legacy scraper, stop writers and drain all provisional
history first (or explicitly repair/discard it). Clear that domain's `scraper_head`
row only after reconciling its progress with the legacy indexers. The down migration
refuses to remove confirmation filtering while provisional or halted history
exists. Restore the matching proxy version when rolling back the migration.
