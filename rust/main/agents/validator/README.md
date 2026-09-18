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
different message indices. The validator reconstructs the local tree through each
returned index and verifies every root, hook address, and domain before signing
anything in the batch. It signs only through the lowest verified index. For
example, matching roots at indices 100, 102, and 103 authorize signing through 100:
the higher roots commit to that same prefix of insertion history.

Checkpoint responses are held while missing websocket insertions arrive. Every 30
seconds, all endpoints are sampled again so a transiently incorrect ahead checkpoint
cannot block recovery forever, even while websocket insertions keep arriving.
Advancing responses keep the previous target for slow replay; responses at the same
or an earlier index replace that endpoint's sample. Only the
common signed frontier advances. A provider behind that frontier pauses advancement
until it catches up. Pending insertions and roots beyond the common frontier remain
cached across retries. No signatures are produced from partially verified batches.

No idle count/root polling or websocket RPC freshness probes run once caught up.
Pending insertions are retried at the configured interval until every endpoint's
confirmed checkpoint advances. Websocket notifications cannot bypass this RPC
interval, including on errors. Each endpoint receives one checkpoint-method read
per attempt, shared by a batch of insertions. Wire call counts depend on the adapter:
Ethereum with numeric confirmations uses one block-number read plus one contract
read **per endpoint**; a finality-tag read uses one contract read per endpoint.
Single-endpoint fallback providers skip redundant background block-height probes.
Announcements and metrics retain their own RPC calls.

Websocket failures trigger reconnection without indexing fallback. RPC errors and
timeouts block signing and are retried without dropping endpoints. A reconstructed
root or checkpoint identity mismatch reports reorg status and terminates the
validator with a failing exit before signing the batch. A difference in provider
indices alone is not a mismatch. Normal mode retains RPC indexing fallback and
batch recovery using its configured `rpcConsensusType`. Normal checkpoint polling
uses one latest-checkpoint method read, without a preceding count read. During
recovery only, checkpoints without a block height use the indexer's finalized
height as the log scan boundary; recovered leaves must still match the captured root.

The separate additional RPC pool remains removed. Both modes reject obsolete
`additionalQuorumRpcUrls` / `customAdditionalQuorumRpcUrls` settings, including empty
values, instead of silently ignoring them. Move their endpoints into `rpcUrls` or
`customRpcUrls` and remove the obsolete settings. Custom URL overrides replace the
registry list, so include every intended endpoint. Normal mode uses its configured
`rpcConsensusType`; lightweight mode checks every endpoint independently.
