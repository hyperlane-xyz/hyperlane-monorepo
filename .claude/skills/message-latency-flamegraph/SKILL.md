---
name: message-latency-flamegraph
description: Build a stage-by-stage latency breakdown (flamegraph/timeline artifact) for a successfully delivered Hyperlane message - origin mining, relayer pickup, metadata/ISM fetch, queue waits, destination submission, and inclusion. Use when the user pastes a message ID and wants to know "how long did this take" / "where did the time go", not when a message is stuck (use debug-message for that).
---

# Message Latency Flamegraph

## When to Use

- User pastes a message ID and asks for timing/latency/flamegraph/waterfall breakdown
- "Why did this message take Xs" / "where did the time go" for an already-delivered message
- Works for messages of any age — recent or months old — since Step 0 anchors
  the time range from the scraper, not from "now"
- NOT for stuck/failing messages — use `debug-message` skill instead. If the message
  turns out to be undelivered or erroring, switch to that skill.

## Input Parameters

| Parameter     | Required | Example       | Notes                                                       |
| ------------- | -------- | ------------- | ----------------------------------------------------------- |
| `message_id`  | Yes      | `0x503ce8...` | 66-char hex                                                 |
| `environment` | No       | `mainnet3`    | Default `mainnet3`; use `testnet4` if the user says testnet |

Origin/destination chain, tx hashes, and timestamps are all derived in Step 0 —
don't ask the user for them unless that step fails.

## Step 0: Anchor the time range via the scraper GraphQL (works for any message age)

Don't guess a `--freshness` window blind, and don't assume the message was
"just sent." Get an authoritative anchor first from the scraper's GraphQL API
at `https://api.hyperlane.xyz/v1/graphql` — this is the real backing store
behind the explorer, and it retains full history (no 30-day cutoff, unlike the
relayer's GCP logs — see Step 2). Query `message_view` by `msg_id` (as
`bytea`, so `0x` → `\x`):

```bash
curl -s -X POST "https://api.hyperlane.xyz/v1/graphql" -H "Content-Type: application/json" -d '{
  "query": "query ($search: bytea) { message_view(where: {msg_id: {_eq: $search}}, limit: 1) { id msg_id nonce sender recipient origin_chain_id destination_chain_id origin_tx_hash origin_tx_sender send_occurred_at is_delivered destination_tx_hash destination_tx_sender delivery_occurred_at origin_mailbox destination_mailbox total_gas_amount } }",
  "variables": { "search": "\\x[MESSAGE_ID_WITHOUT_0x]" }
}'
```

This one query gives you, in a single round trip, regardless of how old the
message is:

- `origin_chain_id` / `destination_chain_id` — domain IDs; map to chain names
  via the registry (e.g. `grep -B2 "42161" <registry>/chains/*/metadata.yaml`
  or match against `@hyperlane-xyz/registry`'s chain metadata)
- `origin_tx_hash` / `destination_tx_hash` — no need to derive these from RPC
  log scans or from relayer logs at all
- `send_occurred_at` / `delivery_occurred_at` — origin dispatch and
  destination delivery timestamps, second precision, straight from indexed
  block data (these matched RPC-derived block timestamps exactly in testing)
- `is_delivered` — if `false`, this message isn't done; switch to `debug-message`

Values come back as Postgres bytea literals (`\xad33...`) — strip the `\x` and
prepend `0x` for normal hex.

**Use `send_occurred_at` / `delivery_occurred_at` as the anchor for the
relayer log query's time range** in Step 2:
`timestamp>="[send_occurred_at]" AND timestamp<="[delivery_occurred_at + 15m]"`.
Pad the end by ~15 minutes past delivery to catch the confirm-queue's
backoff-delayed `Operation confirmed` bookkeeping log (see the caveat in Step
3 — don't mistake that gap for real latency). Prefer explicit
`timestamp>=...AND timestamp<=...` bounds over `--freshness` — `--freshness`
is relative to _now_, which is awkward and error-prone once the message is
more than a few minutes old; explicit bounds work identically whether the
message is 1 minute or 3 months old.

If `message_view` returns no rows, the message wasn't indexed by the scraper
(very unlikely for mainnet3/testnet4 traffic) — fall back to asking the user
for an approximate send time, or point them at the Hyperlane Explorer UI.

## Step 1: Identify which relayer instance actually delivered it

Hyperlane runs several relayer deployments in parallel per environment — the
primary relayer plus racing/specialized ones (`rc`, `fastpath`, etc). Only one
of them wins the race and submits the destination tx. Querying the wrong
pod's logs looks deceptively plausible: the message shows up as indexed, then
immediately shows `Message has already been delivered, marking as submitted`
with no metadata-fetch or lander-stage events — because that pod lost the
race and never did the work. Skip straight to the winner instead of guessing.

Match `destination_tx_sender` (from Step 0) against
`typescript/infra/config/relayer.json` (case-insensitive address compare) to
find which relayer key actually signed the destination tx:

```json
{
  "mainnet3": {
    "hyperlane": "0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5",
    "neutron": "0x03787bc64a4f352b4ad172947473342028513ef3",
    "rc": "0x09b96417602ed6ac76651f7a8c4860e60e3aa6d0",
    "fastpath": "0x1e100476e9360b11a592eafe1c90328368e547b6"
  }
}
```

If `destination_tx_sender` matches `hyperlane` (or nothing in the file), the
primary relayer delivered it — use `omniscient-relayer` as the instance in
Step 2, no further work needed. Otherwise, confirm the matching k8s
`app_kubernetes_io/instance` label against the live cluster rather than
guessing a naming convention:

```bash
gcloud logging read 'resource.type="k8s_container" AND resource.labels.project_id="abacus-labs-dev" AND resource.labels.location="us-east1-c" AND resource.labels.cluster_name="hyperlane-mainnet" AND resource.labels.namespace_name="[ENV]" AND labels.k8s-pod/app_kubernetes_io/component="relayer" AND "[MESSAGE_ID]"' \
  --project=abacus-labs-dev --limit=50 --format="value(labels.\"k8s-pod/app_kubernetes_io/instance\")" | sort -u
```

This lists every relayer instance whose logs mention the message at all
(every relayer indexes every message; only the winner has
submission/inclusion events) — pick the one whose key matches the
`relayer.json` lookup. Known mainnet3 instances so far: `omniscient-relayer`
(hyperlane/primary), `omniscient-relayer-rc` (rc), `omniscient-relayer-fastpath`
(fastpath) — but re-derive from the query above rather than assuming this list
is exhaustive or stable. Use the resolved instance name in place of
`"omniscient-relayer"` in every query in Step 2.

## Step 2: Query relayer logs (fast — avoid `--order=asc`; mind the 30-day retention)

**Critical gotcha**: `gcloud logging read` with `--order=asc` is drastically
slower (can hang for 10+ minutes) because Cloud Logging's backend is optimized
for newest-first reads; forcing ascending order makes it do an expensive sort.
**Never pass `--order=asc`.** Always use the default (descending/newest-first)
and sort the returned JSON locally with Python — it's a handful of KB, trivial
to sort client-side.

**Retention gotcha**: the relayer's full debug logs live in the `_Default` GCP
logging bucket, which has a **30-day retention**. If `send_occurred_at` from
Step 0 is older than ~30 days, `gcloud logging read` will come back empty no
matter how the query is shaped — that's expected, not a bug. In that case:

- Fall back to whatever's in the long-retention BigQuery sinks (`bq ls
--project_id=abacus-labs-dev`; e.g. `relayer_message_events_v1`,
  `relayer_retrying_provider_errors`) for a coarser reconstruction (message
  stored, processed, retry counts) — these are exported indefinitely.
- Otherwise, report only what Step 0 already gave you (origin dispatch time,
  destination delivery time, total wall-clock duration) and tell the user the
  fine-grained per-stage breakdown (queue waits, metadata fetch duration)
  isn't reconstructable because the source logs have expired.

Run two queries against the window from Step 0, both without `--order=asc`:

### 1a. Broad text match (for the raw "how many times did this sit in a queue" signal)

```bash
gcloud logging read 'resource.type="k8s_container" AND resource.labels.project_id="abacus-labs-dev" AND resource.labels.location="us-east1-c" AND resource.labels.cluster_name="hyperlane-mainnet" AND resource.labels.namespace_name="[ENV]" AND labels.k8s-pod/app_kubernetes_io/component="relayer" AND labels.k8s-pod/app_kubernetes_io/instance="[RELAYER_INSTANCE]" AND labels.k8s-pod/app_kubernetes_io/name="hyperlane-agent" AND "[MESSAGE_ID]" AND timestamp>="[send_occurred_at]" AND timestamp<="[delivery_occurred_at_plus_15m]"' \
  --project=abacus-labs-dev --limit=1000 --format=json \
  > /tmp/relayer_raw_[SHORT_ID].json
```

`[RELAYER_INSTANCE]` is the instance resolved in Step 1 (`omniscient-relayer`
unless the destination tx sender matched `rc`/`fastpath`/etc).

### 1b. Structured, noise-filtered match (the one that actually builds the timeline)

Exclude the `relayer::msg::op_queue` target — that's the `Popped OpQueue
operations` heartbeat, which fires every ~500ms per queue and will dominate
the result set with near-duplicate noise without adding new information:

```bash
gcloud logging read 'resource.type="k8s_container" AND resource.labels.project_id="abacus-labs-dev" AND resource.labels.location="us-east1-c" AND resource.labels.cluster_name="hyperlane-mainnet" AND resource.labels.namespace_name="[ENV]" AND labels.k8s-pod/app_kubernetes_io/component="relayer" AND labels.k8s-pod/app_kubernetes_io/instance="[RELAYER_INSTANCE]" AND labels.k8s-pod/app_kubernetes_io/name="hyperlane-agent" AND "[MESSAGE_ID]" AND NOT jsonPayload.target="relayer::msg::op_queue" AND timestamp>="[send_occurred_at]" AND timestamp<="[delivery_occurred_at_plus_15m]"' \
  --project=abacus-labs-dev --limit=500 --format=json \
  > /tmp/relayer_events_[SHORT_ID].json
```

**Caching**: write output straight to a file (scratchpad, not `/tmp` if a
scratchpad dir is available) and parse that file for the rest of the analysis.
If asked to re-analyze the same message shortly after, reuse the cached JSON
instead of re-querying — nothing changes in relayer logs for a message that's
already reached a terminal state.

If query 1b returns zero or very few events but the message is within the
30-day window: double check the instance resolved in Step 1 is actually right
(a wrong-instance query typically still returns a couple of indexing/db
entries, so "near zero" is the tell), then consider the time bounds from Step
0 may be too tight (clock skew between the scraper and relayer is usually
sub-second, but pad a minute or two either side if needed) — otherwise hand
off to `debug-message` if it looks genuinely stuck.

## Step 3: Extract the timeline milestones

Sort entries from 1b ascending by `timestamp` (in Python) and look for these
`jsonPayload.target` / `fields.message` combinations, which mark stage
boundaries (fields not listed are noise from RPC calls, AWS KMS signer chatter,
etc — ignore them):

| Target                                          | Message                                                        | Marks                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `hyperlane_base::contract_sync`                 | `Found log(s) in index range`                                  | Indexer poll that first captured the origin block — only needed for the optional reorg/poll-cadence split in Step 4 |
| `hyperlane_base::db::rocks::hyperlane_db`       | `Storing new message in db`                                    | Relayer indexed the message (pickup)                                                                                |
| `relayer::msg::db_loader`                       | `Sending message to submitter`                                 | Dequeued into prepare pipeline                                                                                      |
| `relayer::msg::metadata::*`                     | first `List of validators...` / `Fast path is not available`   | Metadata (ISM) fetch starts                                                                                         |
| `hyperlane_base::types::multisig`               | `Found checkpoint with quorum` / `Fetched multisig checkpoint` | Metadata fetch ends                                                                                                 |
| `relayer::msg::pending_message`                 | `Dry-run simulation succeeded`                                 | Simulation passed                                                                                                   |
| `relayer::msg::message_processor`               | `Operation prepared`                                           | Prepare stage complete                                                                                              |
| `lander::dispatcher::stages::building_stage::*` | `Transaction built successfully`                               | Tx built                                                                                                            |
| `lander::dispatcher::stages::inclusion_stage`   | `Processing inclusion stage transaction` (first)               | Entered inclusion queue                                                                                             |
| `lander::adapter::chains::ethereum::adapter`    | `submitted transaction`                                        | Tx submitted to destination node                                                                                    |
| `lander::dispatcher::stages::inclusion_stage`   | `Transaction included in block`                                | **Destination tx mined** (real delivery, the terminal event for this flamegraph)                                    |
| `relayer::msg::message_processor`               | `Operation confirmed`                                          | Relayer's own bookkeeping — see caveat below                                                                        |

Cross-check the destination tx hash/block pulled from `tx receipt` / `submitted
transaction` log entries against `destination_tx_hash` from Step 0 — they
should match.

### Important caveat: `Operation confirmed` is NOT the real delivery time

The confirm-queue re-checks submitted messages on an **exponential backoff**
(`since_last_attempt_s` / `next_attempt_after_s` fields visible in the noisy
`Popped OpQueue operations` entries from query 1a, queue_label
`confirm_queue`). This means the `Operation confirmed` log line can fire
minutes after the message was actually delivered, simply because that's when
the backoff scheduled the next poll — not because anything was slow. **Always
use `Transaction included in block` (or `delivery_occurred_at` from Step 0) as
the real delivery timestamp**, and call out the `Operation confirmed` gap
separately as a bookkeeping artifact if it's large. Do not report it as
user-facing latency.

## Step 4: Split "origin dispatch → relayer indexed" into reorg-wait vs poll-cadence

The single `Storing new message in db` timestamp bundles two very different
things: the chain's mandatory reorg-safety wait (deterministic, can't be
avoided) and however long it took the indexer's next poll cycle to actually
run. Always split it — this is part of the default flamegraph, not an add-on.

### How the indexer actually works (read from `rust/main/hyperlane-base` source — don't guess)

The message-dispatch cursor for EVM chains is `ForwardSequenceAwareSyncCursor`
(`hyperlane-base/src/contract_sync/cursors/sequence_aware/forward.rs`). Two
facts from the source settle how this stage must be modeled:

1. **Reorg-safety is resolved in a single RPC call — there is no separately
   observable "raw discovery" moment.** `get_next_range` calls
   `latest_sequence_count_and_tip()`, which for EVM
   (`hyperlane-ethereum/src/contracts/mailbox.rs`) calls
   `get_finalized_block_number()`
   (`hyperlane-ethereum/src/contracts/utils.rs`):
   - `reorgPeriod: N` (blocks) → one `eth_blockNumber` call, then
     `.saturating_sub(N)` done locally in the same expression. The
     pre-subtraction "raw tip" is never bound to a variable, logged, or
     metered.
   - `reorgPeriod: "finalized"` (or `"latest"`/`"safe"`/`"earliest"`/
     `"pending"`) → one `eth_getBlockByNumber(tag)` call; the node returns the
     safe number directly, the raw tip is never fetched at all.
     Neither this function nor its callers carry a tracing span, so this can't
     be recovered from logs even at higher verbosity — it doesn't exist to
     recover. **Don't model "discover, then wait for reorg" as two sequential
     phases — they resolve in the same round-trip. Reorg-safety wait always
     precedes (or is simultaneous with) the poll that discovers the message,
     never the reverse.**
2. **The idle poll cadence is a hardcoded 5-second sleep, not a tunable
   interval.** `SLEEP_DURATION: Duration = Duration::from_secs(5)`
   (`hyperlane-base/src/contract_sync/mod.rs`), duplicated in the cursor's own
   idle branch (`cursors/sequence_aware/forward.rs`), each site carrying a
   `// TODO: Define the sleep time from interval flag` comment confirming
   it's not wired to any config today. This sleep only applies once the
   cursor is caught up (`current_sequence == onchain_sequence_count`); while
   behind, the loop has **no sleep** and re-polls immediately each iteration,
   bounded only by RPC round-trip latency (typically 0.1–0.5s per iteration
   in observed data). So an observed poll gap should be read as **`N` discrete
   ~5s idle cycles, plus a final sub-second "catching up" iteration** — not
   an arbitrary "varies 5–15s" black box. Round the gap to the nearest
   multiple of 5s to get `N`; the leftover (usually well under 1s) is that
   final iteration's real RPC work.

Also: if a chain's metadata omits `blocks.reorgPeriod` entirely, the relayer
defaults to `1` block (`hyperlane-base/src/settings/parser/mod.rs`), not `0`
— don't assume "no reorg protection" just because the field is absent.

### Doing the split

1. Get the origin tx's exact block number + timestamp via RPC:
   `eth_getTransactionReceipt` on `origin_tx_hash` (from Step 0) against the
   origin chain's RPC URL (`chains/<chain>/metadata.yaml` → `rpcUrls` in the
   `@hyperlane-xyz/registry` package, e.g. under
   `node_modules/.pnpm/@hyperlane-xyz+registry@*/node_modules/@hyperlane-xyz/registry/dist/chains/<chain>/metadata.yaml`).
   The block's `timestamp` field should match `send_occurred_at` from Step 0
   to the second — treat a mismatch as a sign you fetched the wrong tx. Note
   EVM block timestamps are integer seconds — there's no sub-second precision
   to be had here regardless of RPC.
2. Get the chain's reorg config from that same `metadata.yaml`:
   `blocks.reorgPeriod`, `blocks.confirmations`, and `blocks.estimateBlockTime`
   (seconds/block). If `reorgPeriod` is a tag string (`"finalized"` etc, e.g.
   BSC, Polygon) rather than a block count, use `blocks.confirmations` in its
   place for this calculation — a documented, chain-specific stand-in rather
   than modeling the chain's actual finality mechanism, which a standard RPC
   can't answer retroactively anyway. If `reorgPeriod` is absent, use `1`
   (the relayer's own default).

   **Don't just multiply — verify against real blocks.** `estimateBlockTime`
   is a static registry value and can be stale: BSC's registry entry says `3`
   but real BSC block spacing observed via RPC was ~0.5s in one sample (two
   blocks landed in the same wall-clock second). Multiplying a stale average
   can overstate the floor by multiple seconds. Prefer fetching the actual
   confirming block directly — `eth_getBlockByNumber(origin_block_number +
reorgPeriod)` (or `+ confirmations` for a tag `reorgPeriod`) — and use
   _its_ real `timestamp` as the reorg-safety-satisfied time. This is exact
   (to the same integer-second precision as any EVM block timestamp) instead
   of an estimate, and costs one extra RPC call you're already set up to
   make. Fall back to `origin_block_time + reorgPeriod × estimateBlockTime`
   only if you can't cheaply fetch that block (e.g. RPC unavailable).

3. Query `hyperlane_base::contract_sync` for the resolved relayer instance
   (Step 1) over a window starting a few minutes before `send_occurred_at` —
   this task is per-domain but the pod interleaves logs from every chain it
   serves, so filter on the origin chain's block-number range, not on
   `domain` text alone (it isn't always present as a plain field on every
   line). Find:
   - the poll whose `range` contains the origin block — its timestamp equals
     the `Storing new message in db` timestamp from Step 3
   - the nearest earlier poll for that same domain that looks like an
     "idle" cycle (a range that had already gone stale, or simply the last
     one before a multi-second gap) — this anchors `N` below
4. Split the total origin→indexed gap into three pieces (render as two bar
   segments — see Step 7 — but compute and narrate all three):
   - **Reorg-safety wait** = the confirming block's real timestamp minus
     origin block time (step 2's RPC-verified method), or the
     `reorgPeriod × estimateBlockTime` estimate as a fallback. Call it a
     floor, not "deterministic," if you fell back to the estimate — it's
     only as good as the registry's `estimateBlockTime`.
   - **Idle-cycle wait** = `N × 5s`, where `N = round((discovery_poll_ts -
prior_idle_poll_ts) / 5s)` — whole hardcoded sleep cycles the cursor
     spent parked before the message became visible. State it as "`N` idle
     cycles (5s each, hardcoded `SLEEP_DURATION`)", not a vague range.
   - **Final iteration** = whatever's left after subtracting the reorg floor
     and `N × 5s` from the total gap — the real RPC round-trip time of the
     poll that actually found the message (get safe tip + nonce +
     `eth_getLogs` + store). Usually sub-second; fold this into the
     idle-cycle segment's tooltip rather than giving it a third bar segment
     unless it's unusually large.
     If multiple pending messages land in the same catching-up burst (visible
     as several `Found log(s) in index range` / `Storing new message in db`
     pairs firing sub-second apart, each for a different sequence), say so —
     the "final iteration" time reflects racing through a small backlog, not
     pure single-message latency.

## Step 5 (optional): Sub-second on-chain precision

Step 0 already gives second-precision origin/destination timestamps and both
tx hashes — that's usually enough. If you need sub-second precision to line up
exactly with relayer log timestamps (e.g. to compute "relayer pickup latency"
to the millisecond), look up the origin/destination chain's RPC URL from the
local registry checkout and `eth_getBlockByNumber` on the block containing
each tx hash. Not necessary for Ethereum-protocol chains where second
precision is enough for the story; skip entirely for non-EVM chains. (Step 4,
if performed, already gives you this for the origin side.)

## Step 6: Report time to inclusion

**Time to inclusion** (origin mined → destination tx included in a block) is
the headline number — this is when the message was actually executed on the
destination chain. Don't also track or report a separate finality number
(origin mined → relayer marks it finalized via `finality_stage`) by
default — the extra confirmation-depth wait past inclusion isn't part of this
flamegraph's story unless the user specifically asks about it. If they do,
pull `lander::dispatcher::stages::finality_stage` → `Transaction is finalized`
from the same log window and report it as an explicit add-on stage, not folded
into the default breakdown.

## Step 7: Build the flamegraph artifact

This is a chart — invoke the `dataviz` skill before writing any HTML/chart
code. Render as a single horizontal stacked bar (one segment per stage, widths
proportional to duration) plus a stage-breakdown table (doubles as the
legend/relief-rule table for narrow segments) and a callout box for the
`Operation confirmed` backoff caveat if it's a large gap. Use the dataviz
skill's default categorical palette in its fixed slot order; validate it with
`scripts/validate_palette.js` before shipping if you changed anything. If Step
1 resolved a non-primary relayer instance, call that out in its own callout
box (which instance, and how it was identified) — it's the kind of surprising
fact that explains why the story starts with the primary relayer's pod
logging "already delivered."

Split the "origin dispatch → relayer indexed" segment into its two sub-parts
(reorg-safety wait, idle-cycle + final-iteration wait) using **two shades of
the same hue** rather than a new categorical slot — they're sub-divisions of
one stage, not a new independent series. The sequential ramp's steps 250/300
(`references/palette.md`) work well as a lighter tint of whichever
categorical slot that stage already uses. Label the second segment with its
`N × 5s` idle-cycle count plus final-iteration remainder in the tooltip or
legend detail column, per Step 4 — that's a source-verified quantization, not
a vague range, so say "N idle cycles of 5s" rather than "varies." For
`"finalized"`-reorg
origin chains, note in the tooltip/legend detail that the reorg-safety figure
uses `blocks.confirmations` as a stand-in for `reorgPeriod` (the chain's
actual finality mechanism isn't a fixed block depth), so the split is an
approximation there.

Suggested stat tiles at the top: time-to-inclusion, relayer pickup latency
(origin mined → indexed), metadata fetch duration.

## Example stage list (from a real Arbitrum→BSC message)

```
Origin block -> relayer indexed          5.92s
Relayer queue -> prepare start           0.83s
Metadata fetch (ISM validator checkpoints) 2.17s
Dry-run + gas re-check -> prepared       0.08s
Build tx -> inclusion queue              0.57s
Nonce/gas assign -> tx submitted         0.23s
Destination block inclusion wait         0.79s   <- time-to-inclusion ends here (10.58s)
```
