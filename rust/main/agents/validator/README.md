# Lightweight validators

Enable `--lightweight` (alias: `--leightweigt`) with `--websocketUrl wss://...`.
Explicit boolean values and configuration-file fields are also supported.

Lightweight mode supports Ethereum, Sealevel, Cosmos Wasm, Cosmos Native,
Starknet, Radix, Aleo (with the `aleo` build feature), and Tron. Configure at least
one public or private state-read endpoint using the chain's existing fields:

| Protocol | Independently checked endpoints |
| --- | --- |
| Ethereum, Sealevel, Starknet, Aleo | `rpcUrls` |
| Cosmos Wasm / Native | `grpcUrls` |
| Radix | `rpcUrls` (Core API) |
| Tron | `walletSolidityUrls` |

The corresponding `custom...Urls` overrides retain their replacement semantics.
Every distinct state-read endpoint participates, regardless of `rpcConsensusType`.
Lightweight mode requires a fixed `ceil(2N/3)` matching endpoints out of the
configured pool (2 of 3, 3 of 4, 4 of 5). Failed endpoints never reduce this threshold.
Other protocol endpoints remain available for announcements and metrics; they do
not cast additional root-check votes. Public RPCs are allowed automatically.

The validator trusts the websocket for ordered insertion history and uses replay
and live events exclusively for indexing. No RPC indexer or log recovery is built.
Startup restores a structurally validated snapshot authenticated by the validator's
own signed checkpoint before starting the websocket, then replays the remaining
local/websocket insertions. This also skips historical replay on a fresh local DB. Without
a valid snapshot, reconstruction starts at insertion zero, including when switching
back to normal mode with a previously skipped prefix. Replay and backfill use the
same authenticated startup snapshot in both modes. Historical checkpoint uploads
from every lightweight batch run in one background worker, coalescing newer targets
while uploads retry; snapshots advance only after all covered checkpoints are
published. Startup does not seed the tree from an RPC frontier or
call `tree()` / `tree_at_block()`. Some protocols derive checkpoint reads from account
data that also contains the tree frontier; that data does not initialize our tree.

Each verification batch requests the latest checkpoint from every endpoint using
that protocol's existing confirmation/finality policy. Endpoints may return
different message indices. The validator compares each checkpoint's root, hook
address, and domain against its local insertion history at that index.

A matching later root authenticates the entire earlier prefix. The validator signs
through the highest index supported by at least two thirds of the configured
endpoints: the required-th highest matching index. For example, matching checkpoints
at indices 100, 102, 103, and 104 authorize signing through 102 (three of four votes).
Missing a polling window does not lose historical checkpoints: replay reconstructs
the intermediate roots, which can be signed after a later root authenticates them.
Historical block-height queries are not required.

Unavailable, conflicting, or behind-frontier endpoints do not count as matching
votes. A minority cannot veto a sufficient matching majority. Without enough
matching votes, signing pauses and retries; a 2–2 split with four endpoints cannot
authorize signing. Missing websocket insertions are awaited when they could supply
enough matching votes.

The first verified batch logs `Initial lightweight backfill verified: local roots
match a two-thirds RPC majority`, including the verified index, root, configured
endpoint count, and elapsed time. Historical signing and uploads complete separately
and log `Initial lightweight historical checkpoint publication complete` with the
index through which all checkpoints have been published. Both messages appear
once per run after their respective first batch completes.

`hyperlane_validator_merkle_tree_leaf_count{chain="base",phase="verification"}`
reports the number of leaves reconstructed for RPC root verification, during both
initial sync and ongoing operation. This count can advance before roots are verified.
`phase="historical_reconstruction"` tracks the historical worker's separate replay
of cached database insertions to rebuild older checkpoints before signing. It
updates after each insertion, exposing the work between the first root-verification
success log and historical uploads. It does not download the insertions again.
`phase="historical_publication"` counts checkpoints confirmed published by the
historical worker. It starts with the restored snapshot's published prefix, then
increments after each successful checkpoint write or confirmation that a matching
checkpoint already exists. It also counts each target already published by the
live worker. Reconstructing older checkpoints and failed upload attempts do not
advance publication progress.

On a fresh start all three counts begin at zero; a restored snapshot initializes
them to its leaf count. Once publication catches up to a
verified target, its count equals that target's index plus one. Checkpoints upload
newest first, so intermediate publication counts are not a contiguous index.
None of these counts represents block height or the tree's fixed depth. Use
`hyperlane_latest_checkpoint` and `hyperlane_backfill_complete` for publication
milestones.

```sh
curl -s localhost:9090/metrics | grep '^hyperlane_validator_merkle_tree_leaf_count{'
```

Checkpoint responses are held while missing websocket insertions arrive. Every 30
seconds, endpoints are sampled again so an ahead checkpoint cannot block recovery
forever. Advancing responses keep a previous valid or not-yet-replayed target for
slow replay, but replace known conflicts. Responses at the same or an earlier index
also replace that endpoint's sample. Failed endpoints lose
their sample on a successful batch refresh. Endpoint slots remain stable across
refreshes, so samples cannot be reassigned to another endpoint. Pending insertions
and roots beyond the signed frontier remain cached across retries.

No idle count/root polling or websocket RPC freshness probes run once caught up.
Pending insertions are retried at the configured interval. Websocket notifications
cannot bypass this RPC interval, including on errors. Each endpoint receives one
checkpoint-method read per attempt, shared by a batch of insertions, with a 20-second
timeout per endpoint. The batch waits for all reads to finish or time out, then
checks whether enough responses succeeded. A stalled minority can therefore delay
a batch by up to 20 seconds but cannot prevent an otherwise sufficient majority.
Wire call counts depend on the protocol adapter. Announcements and metrics retain
their own RPC calls.

Websocket failures trigger reconnection without indexing fallback. Insufficient
responses or matching roots block signing until a later successful verification.
Normal mode retains its existing configured `rpcConsensusType`, root-mismatch
handling, RPC indexing fallback, and batch recovery. Normal checkpoint polling uses
one latest-checkpoint method read, without a preceding count read. During recovery
only, checkpoints without a block height use the indexer's finalized height as the
log scan boundary; recovered leaves must still match the captured root.

The separate additional RPC pool remains removed. Both modes reject obsolete
`additionalQuorumRpcUrls` / `customAdditionalQuorumRpcUrls` settings, including empty
values, instead of silently ignoring them. Move their endpoints into `rpcUrls` or
`customRpcUrls` and remove the obsolete settings. Custom URL overrides replace the
registry list, so include every intended endpoint. Normal mode uses its configured
`rpcConsensusType`; lightweight mode uses the fixed two-thirds checkpoint vote described above.
