# Near-head scraper ingestion

The scraper indexes dispatch, delivery, gas-payment and Merkle-insertion events
at the current head by default on all selected EVM chains. Each event is stored
once in its existing table, initially with `confirmed=false`. Block headers remain
in `block`; `scraper_head` contains only per-chain progress and health, not event
payloads.

The scraper flips `confirmed` after the chain's existing `reorgPeriod`. Legacy
websocket notifications and gas-payment cursors are created on that transition.
The proxy and Explorer query confirmed views, preserving their configured delay.
There is no new endpoint or subscriber-selected delay in this change.

Select chains with `chainsToScrape` as before. No `nearHead` setting or per-chain
`fromBlock` values are needed. Non-EVM chains retain their existing indexers.
The old `HYP_NEARHEAD` and `HYP_NEARHEAD_<DOMAIN>_FROMBLOCK` variables are no longer
used and can be removed.

On first start the scraper **trusts existing database history**. For each domain,
it starts after the greatest stored height in `block`, `raw_message_dispatch`,
and `merkle_tree_insertion`, never earlier than the chain's configured
`index.from`. This preserves any pre-existing gaps; it does not verify or backfill
legacy history. The shared legacy cursor is deliberately ignored because it
can lag stored rows or lead a slower event stream. An empty DB starts at
`index.from` (block 1 when `index.from` is 0).

Stop other scraper writers before the first handoff. Startup selects the boundary
using indexed lookups, probes the RPC, rechecks that no later legacy rows exist,
and persists the boundary in `scraper_head`. If a legacy writer advances past the
selected boundary meanwhile, startup fails; stop the writer and retry. Run
`init-db` before startup to install the full Merkle height index as well as the
schema and other concurrent indexes.

Restarts load the saved boundary and resume indexed progress. They do not
reselect it or repeat the historical overlap check. Contract changes are rejected.

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
- Confirmation requires a healthy head observation less than 30 seconds old and
  cannot pass indexed progress. Advancing the observed head can confirm existing
  events even if the next log fetch fails. Long in-flight RPC calls can expire the
  observation lease; confirmation then waits for a fresh observation.
- Startup probes the configured finality tag and hash-pinned contract-count calls
  before persisting a first-time cutover. On restart it probes the canonical block
  at the retained indexed height, allowing the observation loop to repair an
  orphaned stored tip without requiring old cutover state. Ingestion and confirmation failures
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
- An independent maintenance loop scans at most 1,000 old block headers per poll
  and deletes unreferenced candidates in a separate transaction. Confirmation
  does not await cleanup, including during catch-up. An in-memory cursor
  advances past retained headers and wraps for another sweep. It retains the cutover anchor, confirmed
  boundary, retained unconfirmed checkpoints, transaction references, raw-dispatch headers,
  and headers needed by pending gas/delivery enrichment. Event records are not
  deleted by cleanup. Halted chains are not pruned. Historical headers from before
  the cutover are left intact; retained event/transaction history still grows.
- Block/log/transaction positions are recorded for future custom-period consumers.
  Adding those consumers still requires a reorg-aware cursor/reset protocol; the
  current legacy protocol must not be pointed directly at provisional data.

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

1. Stop scraper writers and the proxy. Apply the migration before deploying the
   matching binaries. The migration adds columns and indexes to existing tables;
   measure index creation on a database clone and allow a maintenance window.
2. Run `cargo run --release -p migration --bin init-db` with `DATABASE_URL` set.
   It applies schema migrations, then builds and verifies concurrent indexes.
3. Start the scraper and matching proxy. Automatic cutover selection trusts the
   cloned history; historical gaps must be repaired separately if needed.
4. Check `scraper_head` for advancing `indexed_height` and `confirmed_height`,
   verify the chain critical-error metric is clear, and check consumer streams.

SELECT grants on existing event tables are copied to the confirmed views. External
SQL consumers wanting the old visibility must use `confirmed_raw_message_dispatch`,
`confirmed_delivered_message`, `confirmed_gas_payment`, or
`confirmed_merkle_tree_insertion`. `message_view` and `total_gas_payment` retain
both their names and output columns. Raw event tables now include provisional rows.

To roll back to a legacy scraper, stop writers and drain all provisional
history first (or explicitly repair/discard it). Clear that domain's `scraper_head`
row only after reconciling its progress with the legacy indexers. The down migration
refuses to remove confirmation filtering while provisional or halted history
exists. Restore the matching proxy version when rolling back the migration.
