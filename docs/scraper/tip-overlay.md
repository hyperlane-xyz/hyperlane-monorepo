# Disposable near-head overlay (alternative to #9676)

`tip: { "42161": { "windowBlocks": 256 } }` enables an EVM observation cache
beside the existing canonical scraper. The canonical four indexers, sequence-gap
recovery, receipt enrichment, CCR indexing, tables, views, grants, notifications
and consumer cursors remain unchanged. No shared legacy cutover is required.

This is an alternative foundation for near-head reads, not an Explorer UI change
or a configurable-delay subscription protocol. Like #9676, existing HTTP and
WebSocket consumers retain their existing delayed visibility. SQL readers can
explicitly use `scraper_tip_visible`; it contains provisional occurrences for all
four event types, keyed by domain/block/log position, with message IDs and decoded
payloads. Deployment requires explicitly granting readers SELECT on the new view.

## Observation validity and boundedness

The worker fetches one combined event range, validates event-block hashes and
rechecks range anchors, and atomically writes the range plus progress. It reads
headers only for event blocks and range boundaries. An unchanged head costs one
header RPC and one small database renewal transaction, with no log query.

The view exposes only a complete retained window, with a freshness lease of
three configured polling intervals (minimum 30 seconds). RPC failures hide the
cache; process/database failure expires the lease. The entire observation attempt
has a 120-second timeout. A reorg resets and rebuilds the retained window,
incrementing `epoch`; stale revisions cannot commit over a newer writer. The
cache has no finality claims, canonical promotion, durable stream cursors or
notifications. RPC completeness and coherent block-number reads are still trusted.

Storage retains at most `windowBlocks` heights, regardless of canonical lag.
Catch-up skips expired heights. This bounds historical growth, not the number or
size of logs within one block. A canonical stall longer than retention can cause
a message to disappear from provisional lookup until canonical catch-up; this
is an explicit availability tradeoff, never evidence of failed delivery.
Run one live overlay configuration per domain: revision checks fence in-flight writes, but do not elect an owner or prevent differently configured workers from alternating fresh revisions. Startup failures retry every 30 seconds with a 120-second per-attempt timeout, independently of canonical startup.

Restart/config change clears the disposable cache and rebuilds only this window.
Reorg rebuild hides observations until all retained chunks are caught up. Deep
reorgs are handled within the cache by rebuilding; canonical deep-reorg behavior
is unchanged from main and is not solved by this change.

## Canonical-preferred lookup contract

Limit initial adoption to message-ID detail lookups, preserving the earlier
Explorer design's narrow fallback surface. Query canonical `message_view` first.
Only if absent, query an explicitly provisional dispatch observation:

```sql
SELECT e.domain,e.block_number,e.block_hash,e.transaction_hash,e.event,
       e.epoch,e.from_height,e.indexed_height,true AS is_provisional
FROM scraper_tip_visible e
WHERE e.message_id = $1 AND e.event->'data' ? 'Dispatch'
ORDER BY e.block_number DESC,e.log_index DESC
LIMIT 1;
```

Canonical preference must be resolved in one database snapshot (a single SQL
statement or repeatable-read transaction) if combining results. Deduplicate by
message ID, prefer the canonical record, and label the fallback provisional.
Never treat absence as nonexistence, use it for monetary accounting, or attach
legacy cursors/subscribers directly to the overlay. A future paginated endpoint
must reset on epoch changes and detect `from_height` advancing past its cursor.
Metadata unavailable from logs remains unknown: do not synthesize receipt gas, transaction sender, or block timestamp from the dispatch sender or observation time. No such endpoint or frontend integration is included here.

## Comparison

| Choice              | Earlier #8193 / Explorer #281      | #9676                                      | This alternative                                 |
| ------------------- | ---------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Canonical writer    | Existing delayed indexers          | Combined new head worker plus confirmation | Existing delayed indexers                        |
| Provisional storage | Shared raw dispatch table          | Existing four event tables                 | Separate disposable occurrence table             |
| Events              | Dispatch                           | All four                                   | All four                                         |
| Orphan lifetime     | Raw orphan can remain indefinitely | Rollback deletes unpublished events        | Reset/rebuild plus bounded retention             |
| Consumer boundary   | Canonical-first raw fallback UI    | Confirmed views and rewritten triggers     | Existing consumers unchanged; opt-in SQL surface |
| Deployment          | Separate persisted tip cursor type | Coordinated cutover/migration              | Additive migration, opt-in worker                |
| RPC                 | Additional tip dispatch stream     | One combined stream replaces four          | Additional combined tip stream                   |

The old raw-table approach should not be transplanted directly onto current main:
`reconcile_raw_message_dispatches` now autonomously enriches raw rows into the
canonical message table. An isolated table prevents provisional dispatches from
entering that reconciler. It also avoids tip cursors being mistaken for finalized
progress by old binaries during rollback.

Compared with #9676, this trades duplicate RPC and bounded payload storage for a
smaller canonical blast radius and a reversible rollout. It does **not** claim RPC
savings: existing canonical queries still run, plus a combined tip query per new
range and event-block/anchor headers. It avoids #9676's per-event SQL round trips
by inserting each range in one set-based statement. Costs need benchmarking on
real event density, reorg windows and providers; no production measurement exists.

Apply the additive migration, then enable selected domains. Disable the option to
stop ingestion; visibility expires by lease. Remove cache rows or down-migrate
only after stopping overlay workers. Canonical writers and old binaries require
no cursor repair or event-table draining. No deployment has been performed.
