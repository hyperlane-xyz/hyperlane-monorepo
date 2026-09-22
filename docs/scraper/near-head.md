# Near-head scraper ingestion

`nearHead` opts individual EVM chains into indexing dispatch, delivery, gas-payment
and Merkle-insertion events at the current head. Each event is stored once in its
existing table, initially with `confirmed=false`. Block headers remain in `block`;
`scraper_head` contains only per-chain progress and health, not event payloads.

The scraper flips `confirmed` after the chain's existing `reorgPeriod`. Legacy
websocket notifications and gas-payment cursors are created on that transition.
The proxy and Explorer query confirmed views, preserving their configured delay.
There is no new endpoint or subscriber-selected delay in this change.

```json
{
  "nearHead": {
    "42161": { "fromBlock": 123456 }
  }
}
```

`fromBlock` is an explicit cutover: every legacy event indexer must already be
complete through its predecessor, and no legacy data may extend beyond it. The
example height is illustrative. The setting must name an EVM domain included in
`chainsToScrape`. Other domains retain their existing indexers. An initialized
chain cannot silently change its cutover or contracts.

## Behavior

- One combined RPC log query covers all four event types over a block range,
  using the existing `index.chunk` limit. Headers are fetched only for blocks
  containing events and range boundaries, not every empty block. Events and the
  end checkpoint commit atomically, including when the range has no events.
- Each returned log must match its block header. The previous indexed boundary
  and the range end are checked again before commit; changed forks are retried.
  Like the legacy range indexers, this relies on the RPC serving complete,
  coherent range results. These checks cannot prove the absence of omitted logs
  from an inconsistent provider.
- Polling uses `index.interval`, with the legacy range cursor's 30-second default.
  An unchanged head costs one RPC call and no log query. Catch-up ranges run
  without an idle delay. Confirmation wakes on progress and drains eligible
  batches without waiting for another poll. `safe`/`finalized` tag checks use the
  same timer rather than a new one-second RPC polling loop.
- A reorg rolls back to the newest retained checkpoint on the canonical chain,
  then replays the range. Confirmation stores its exact boundary header even
  when that height was an empty block inside a range.
- Confirmation requires a healthy head observation less than 30 seconds old and
  cannot pass indexed progress. Advancing the observed head can confirm existing
  events even if the next log fetch fails. Long in-flight RPC calls can expire the
  observation lease; confirmation then waits for a fresh observation.
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
  metadata is filled in by the existing dispatch reconciler, one bounded page
  per event type per cycle. Failed/timed-out pages advance their scan cursor so
  later pages are attempted; missing receipts are retried on the next sweep.
  Each gas/delivery page has a 30-second timeout. Existing
  nullable transaction relations remain nullable until enrichment succeeds.
- The confirmation worker scans at most 1,000 old block headers per cycle and
  deletes unreferenced candidates in a separate transaction. An in-memory cursor
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
and one combined log request, independent of the number of empty blocks in the
range. Numeric confirmation needs up to two header reads when it advances;
finality tags also require a tag read. Receipt enrichment and retries are extra.
The legacy path used up to four event range queries plus its separate tip and
receipt/header lookups. Costs are comparable in structure, not guaranteed equal:
chain activity, polling configuration, confirmation batches, and RPC retries
still determine the actual total. This has not been benchmarked in production.

## Rollout

1. Stop scraper writers and the proxy. Apply the migration before deploying the
   matching binaries. The migration adds columns and indexes to existing tables;
   measure index creation on a database clone and allow a maintenance window.
2. Verify a common completed cutover for the four legacy streams. Configure
   `nearHead`, then start the scraper and matching proxy.
3. Check `scraper_head` for healthy, advancing `indexed_height` and
   `confirmed_height`, and check the existing consumer streams.

SELECT grants on existing event tables are copied to the confirmed views. External
SQL consumers wanting the old visibility must use `confirmed_raw_message_dispatch`,
`confirmed_delivered_message`, `confirmed_gas_payment`, or
`confirmed_merkle_tree_insertion`. `message_view` and `total_gas_payment` retain
both their names and output columns. Raw event tables now include provisional rows.

To disable near-head indexing or roll back, stop writers and drain all provisional
history first (or explicitly repair/discard it). Clear that domain's `scraper_head`
row only after reconciling its progress with the legacy indexers. The down migration
refuses to remove confirmation filtering while provisional or halted history
exists. Restore the matching proxy version when rolling back the migration.
