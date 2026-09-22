# Scraper event watermark migration

Delivery and gas-payment indexing previously shared the cursor key `(domain, "")`.
Its maximum height records the fastest worker; neither that height nor the latest
stored event proves that the other worker covered earlier ranges. Copying either
maximum into a new checkpoint would preserve historical gaps.

Block-indexed delivery and gas-payment stores now use `(domain, "delivery")` and
`(domain, "interchain_gas_payment")`. A missing key starts at the configured
`index.from`. Once written, each key resumes independently, including after a
restart during backfill. The existing cursor table and uniqueness constraint are
sufficient; there is no SQL schema migration. Existing legacy, CCR, and backward
cursor rows are retained.

The first checkpoint beyond the restored start is written immediately on every
startup; later writes retain the ten-second throttle. A failed write propagates
to the sync cursor and retries the same range, including when the in-memory
height already advanced. The cursor's conservative range overlap still applies.

Sequence-aware Sealevel, Radix, and Aleo paths keep their existing sequence and
backward cursor behavior. In particular, relative sequence starts remain intact.
Relative starts on block-indexed chains still mean an offset from the current
tip; they cannot establish complete historical repair. Use an explicit absolute
`index.from` at or before the oldest history that must be repaired. Raising this
floor intentionally excludes older gaps. Lowering it after a new checkpoint has
advanced does not rewind that checkpoint.

## Measured replay scope

The following snapshot combines the running mainnet scraper's configuration and
runtime index overrides with read-only replica queries of legacy cursor rows on
2026-09-22 (row timestamps around 14:05 UTC). These six chains are a sample, not
the complete set of affected domains. No production state was changed.

| Chain    | Configured start | Legacy cursor | Blocks through cursor, inclusive | Chunk setting | Range fetches per stream | Both streams |
| -------- | ---------------: | ------------: | -------------------------------: | ------------: | -----------------------: | -----------: |
| Ethereum |       18,422,581 |    26,031,497 |                        7,608,917 |         1,999 |                    3,805 |        7,610 |
| Arbitrum |      143,649,797 |   507,803,042 |                      364,153,246 |         1,999 |                  182,077 |      364,154 |
| Base     |        5,695,475 |    51,647,251 |                       45,951,777 |         1,000 |                   45,906 |       91,812 |
| BSC      |       32,893,043 |   123,383,977 |                       90,490,935 |         1,999 |                   45,246 |       90,492 |
| Polygon  |       49,108,065 |    94,251,854 |                       45,143,790 |         1,999 |                   22,572 |       45,144 |
| Starknet |          804,854 |    15,270,924 |                       14,466,071 |           999 |                   14,467 |       28,934 |

The cursor queries inclusive ranges `from..=from + chunk`. Therefore the estimate
is `ceil((legacy_height - configured_start + 1) / (chunk + 1))` per stream, doubled
for delivery and gas payment. The parser default is 1,999; Base has an explicit
runtime override of 1,000.

These counts are range fetches, **not total RPC requests, provider billing, or a
completion-time estimate**. Tip reads, pagination, retries, chain progress during
replay, transaction enrichment, and SQL reads/writes add work. Existing event
writes skip unchanged delivery/payment conflict updates, preserving creation
timestamps and suppressing redundant Explorer notifications. Real content or
transaction changes still update. Replays still consume RPC, SQL read, conflict
check, and transaction capacity.

## Rollout gate and staged backfill

A first startup with absent event keys replays configured history. Do not roll
this change out to every mainnet domain at once without a capacity plan. The
large Arbitrum and Base ranges make that a material rollout decision.

1. Include the required-enrichment retry fix from PR #9673 before backfilling.
   Otherwise a transient enrichment failure can still omit events during replay.
2. Confirm archive RPC access back to each absolute start, provider quota,
   database capacity, and the acceptable period of delivery/payment index lag.
   Record the legacy height as the minimum historical catch-up target. This PR
   does not throttle historical requests: `index.interval` applies near the tip
   and is not a backfill rate limit.
3. Stage domains using the existing `chainsToScrape` configuration, initially
   one domain at a time. Remove a staged domain from the old scraper before
   assigning it to the new one. Two scraper instances must not concurrently
   index CCR swaps for one domain because synthetic nonce allocation assumes
   one writer. Other domains can remain on their existing scraper during this
   stage; their shared-watermark risk remains until they migrate.
4. Each replay uses bounded configured chunks and persists its own progress.
   Check both new cursor keys, RPC error/retry rates, SQL latency, and scraper
   liveness. Pause a staged scraper if provider/database limits are reached;
   restarting resumes its independent checkpoints. Forward delivery/payment
   freshness for that domain is delayed until replay catches up.
5. Verify both new keys pass the recorded historical target and reach the
   current chain tip within the normal conservative replay margin. Check
   representative historical delivery/payment rows, including any known gaps,
   before adding more domains. Passing a height alone does not prove that an
   RPC endpoint returned every historical event.

Store/enrichment failures retry every five seconds and can leave process liveness
healthy. The RPC fetch retry metric does not count these failures. During backfill,
watch each event cursor for staleness and the warning
`Skipping cursor update because logs failed to store` alongside RPC metrics.

Restarting an old binary uses the retained legacy cursor and reintroduces the
shared-watermark behavior. Preserve the new rows for a subsequent forward
rollout; do not copy the legacy maximum into them. No cursor rows are deleted or
rewound automatically, and no historical backfill has been run as part of this PR.
