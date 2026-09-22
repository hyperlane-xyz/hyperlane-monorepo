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

- One RPC log query per block covers the four contracts/events, pinned to the
  block hash. Empty blocks also advance the durable indexed height. Headers and
  events commit atomically in contiguous batches of at most 32 blocks.
- The head is polled every five seconds when caught up or after an ingestion
  error. Catch-up batches run without an idle delay. Confirmation runs separately,
  wakes on progress, and retries every second. `safe`/`finalized` tag errors pause
  confirmation without stopping log ingestion.
- Confirmation requires a healthy head observation less than 30 seconds old and
  cannot pass indexed progress. Advancing the observed head can confirm existing
  events even if the next log fetch fails. Long in-flight RPC calls can expire the
  observation lease; confirmation then waits for a fresh observation.
- Unpublished forks are deleted and reindexed. Existing block, transaction,
  message and leaf uniqueness constraints are unchanged. Fork occurrences are not
  archived. A reorg crossing confirmed history persists a halt and raises the
  chain critical-error metric; recovery requires operator repair. This version
  cannot retract anything already consumed by a legacy client.
- Confirmation does not wait for receipt enrichment. Gas/delivery transaction
  metadata is filled in by the existing dispatch reconciler, one bounded page
  per event type per cycle. Failed/timed-out pages advance their scan cursor so
  later pages are attempted; missing receipts are retried on the next sweep.
  Each gas/delivery page has a 30-second timeout. Existing
  nullable transaction relations remain nullable until enrichment succeeds.
- The confirmation worker prunes up to 1,000 old, unreferenced block headers per
  cycle, in a separate transaction. It retains the cutover anchor, confirmed
  boundary, all unconfirmed headers, transaction references, raw-dispatch headers,
  and headers needed by pending gas/delivery enrichment. Event records are not
  deleted by cleanup. Halted chains are not pruned. Historical headers from before
  the cutover are left intact; retained event/transaction history still grows.
- Block/log/transaction positions are recorded for future custom-period consumers.
  Adding those consumers still requires a reorg-aware cursor/reset protocol; the
  current legacy protocol must not be pointed directly at provisional data.

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
