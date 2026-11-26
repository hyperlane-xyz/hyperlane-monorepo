# Validator checkpoint consensus

For validators, `chains.<origin>.rpcConsensusType` selects the signing policy:

| Mode | Required matching state-read endpoints | Verification |
| --- | --- | --- |
| `single` / `fallback` | Existing provider behavior | Classic checkpoint verification |
| `quorum` | `ceil(N/2)` | Match each endpoint's root against local history at its own leaf index |
| `majority` (default) | `ceil(2N/3)` | Same history verification, higher threshold |

`majority` is a validator setting, not a raw-response consensus option for relayers
or scrapers. `quorum` and `majority` use the protocol-independent checkpoint verifier. Quorum retains its previous threshold:
with four endpoints a 2–2 split can authorize the locally matching history; majority
requires three matching endpoints. With two endpoints, quorum needs one and
majority needs both. Exact duplicate URLs are counted once.

For normal quorum/majority, indexing and auxiliary RPC calls use fallback transport;
only the explicit history vote authorizes signatures. Startup reconstructs the tree
from indexed leaves, its own signed snapshot, or an Explorer frontier authenticated
against the configured RPC threshold. RPC indexing fallback and WebSocket
freshness checks remain enabled. Healthy, caught-up validators wait for insertions, with a
60-second root audit to detect same-count reorgs. If a local batch disagrees,
RPC recovery may fetch replacement insertions, but it repairs storage and permits
signing only through the prefix authenticated by the configured checkpoint vote.
Recovery ignores endpoint-supplied block metadata, uses the configured indexing
start and the indexer's finalized boundary, and resamples after a recovery attempt
exceeds 120 seconds while retaining completed ranges and recovered leaves. A shorter
contiguous recovery prefix can be accepted if the endpoint vote authenticates it.
A threshold-confirmed conflict at the committed index writes the reorg flag and
halts, rather than repairing already-signed history. No historical root query or
common block height is required.

Mainnet/testnet configs explicitly select `majority` and pin validator images
containing its parser. The binary and local development validators also default
to `majority`.

## Explorer indexing

Known mainnet and testnet domains default to `https://explorer-api.hyperlane.xyz/graphql`
and `wss://explorer-api.hyperlane.xyz/validators`. Local and unknown domains require explicit endpoints to enable
Explorer. Set `explorerApiUrl` to use a custom GraphQL service. Its WebSocket defaults
to the same host at `/validators`, or set `websocketUrl` explicitly. Configuring
only a custom WebSocket preserves RPC backfill.

The validator subscribes to live insertions while it restores its startup frontier.
On first startup it requests the confirmed frontier for its domain and
hook. It replays the last leaf and authenticates the reconstructed root against
its configured RPCs at their own finality settings. When RPCs report different
indices it can replay additional confirmed leaves to check those votes. A matching
historical read is accepted only within the endpoint's finalized height. A fresh
validator can then publish the verified tip while it reconstructs and publishes
older checkpoints in the background. Restarts prefer the validator's own signed
snapshot. An existing checkpoint publisher without a usable snapshot replays its
history. Only complete historical publication advances its persisted snapshot.

For a local smoke test, `skipAnnounce: true` skips the on-chain announcement.
With an RPC-verified Explorer snapshot, the validator
publishes the snapshot tip and each subsequent insertion, including gaps up to the
WebSocket handoff. It skips earlier signatures and leaves the full-history snapshot
unwritten. If the snapshot is missing or fails authentication, normal sync resumes
from an authenticated publication frontier or leaf zero. On a repeat run, the configured RPC threshold must also authenticate the signer's
previously published tip before the validator can skip ahead again. `allowRpcFallback` still controls
RPC insertion indexing.

The validator buffers up to 4,096 live insertions, checks the socket's fixed
live-start block against independent RPC, and fills the gap with contiguous
GraphQL pages of up to 1,000 leaves. After covering the boundary it drains the
buffer and switches to live events. This also works on quiet chains. Numeric
reorg periods request the configured confirmation depth. Block tags use the
scraper's canonical stream.

`allowRpcFallback` defaults to `true`. Gaps, disconnects, and rollbacks can start
RPC insertion indexing. The historical backfill retries Explorer after each RPC
range. On reconnect, Explorer can take over as soon as it supplies the next
missing leaf at the verified handoff. Set the flag to `false` to source all insertions and frontier
data from Explorer or previously verified local state. Supply `explorerApiUrl`
when using a custom WebSocket in this mode. If the snapshot is missing, the
validator replays from its own published frontier or leaf zero. Unavailable
history is retried, and affected checkpoints wait until the gap is filled.
Independent RPC root verification, live-start block checks, and audits run in
both modes.

Each verification batch requests the latest checkpoint from every endpoint using
that protocol's existing confirmation/finality policy. Endpoints may return
different message indices. The validator compares each checkpoint's root, hook
address, and domain against its local insertion history at that index.

A matching later root authenticates the entire earlier prefix. The validator signs
through the highest index supported by its configured checkpoint threshold:
`ceil(2N/3)` for majority, or `ceil(N/2)` for quorum. It uses the required-th
highest matching index. For example, matching checkpoints
at indices 100, 102, 103, and 104 authorize signing through 102 (three of four votes).
Every mode publishes a signed checkpoint for each insertion, including multiple
insertions in one block. The verified batch tip can become available first.
After an Explorer bootstrap, publication of intermediate live checkpoints proceeds
even while pre-start leaves are unavailable. One verified batch root authenticates
all intermediate roots without additional per-insertion RPC reads.

Unavailable, conflicting, or behind-frontier endpoints do not count as matching
votes. A minority cannot veto a sufficient matching majority. Without enough
matching votes, signing pauses and retries; a 2–2 split with four endpoints cannot
authorize signing. Missing websocket insertions are awaited when they could supply
enough matching votes.

The first verified batch logs `Initial consensus backfill verified: local roots
match the configured RPC threshold`, including the verified index, root, configured
endpoint count, and elapsed time. Historical signing and uploads complete separately
and log `Initial historical checkpoint publication complete` with the
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
refreshes, so samples cannot be reassigned to another endpoint. Replay retains tree
frontiers only at sampled indices, bounded by endpoint count. If a later sample
requests an uncached intermediate index, replay resumes from the committed tree
using stored insertions. Roots are calculated only at sampled indices.

Validators run the 60-second root audit once the local tree is non-empty.
The next unsigned insertion in the local DB drives independent RPC verification.
Both WebSocket and fallback RPC indexing notify the same verifier after persisting
new insertions. It does not track which indexer is active, and no separate insertion
counter or polling deadline gates new work. Once caught up, the verifier waits for a
notification or the 60-second safety audit. A valid RPC quorum that has not advanced
retries pending insertions after 500 ms, without needing another notification.
Consecutive stale rounds double that delay up to the configured interval; checkpoint
progress resets it. The first retry is also capped at the configured interval.
Failed consensus reads or root verification retain the configured retry interval;
notifications cannot bypass that delay. RPC indexing fallback keeps its configured
polling interval. Without a WebSocket configured, the verifier checks the local DB
at that interval. Single/fallback RPC failures retain the provider retry policy.
On idle chains, including RPC-only validators and unhealthy WebSocket connections,
`validator_observed` checkpoint metrics and same-count reorg detection update on the
60-second audit rather than every configured interval.
Each endpoint receives one checkpoint-method read per attempt, shared by a batch
of insertions, with a 20-second timeout per endpoint, including deferred WebSocket connection setup. Responses
are verified progressively: signing advances as soon as enough roots match local
history, without waiting for a stalled minority. Unavailable WebSocket endpoints
retain their voting slots and retry initialization on subsequent reads. Without
a matching threshold, reads remain bounded by the deadline.
Wire call counts depend on the protocol adapter. Announcements and metrics retain
their own RPC calls.
`hyperlane_validator_checkpoint_reads_total{chain="..."}` counts checkpoint verification
read attempts, including each consensus endpoint and failed or timed-out reads.
It counts adapter method calls, not underlying wire requests or RPC indexing calls.

With RPC fallback enabled, WebSocket failures restore RPC indexing before reconnection. Insufficient
checkpoint responses or matching roots block signing until verification succeeds.
In Explorer-only mode, `single` and `fallback` use the configured state provider
as one checkpoint vote. Quorum and majority retain their configured thresholds.

The obsolete `additionalQuorumRpcUrls` / `customAdditionalQuorumRpcUrls` settings
remain rejected. Move those endpoints into the chain's existing state-read fields;
custom URL overrides replace the registry list.
