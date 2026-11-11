# Zero-confirmation preparation

Depends on the scraper-proxy API in [#10026](https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/10026).
Deploy the proxy before this relayer. The subscription requests
`includeZeroConfirmations: true` for dispatches, with the usual confirmation
policy and an optional block subscription on the same WebSocket. The accepted
option must be echoed; an older proxy leaves RPC indexing active.

A dispatch with `confirmations: 0` only warms the existing recipient, ISM,
validator-set and announcement caches. It never writes origin messages or leaves,
advances a replay cursor, fetches signatures or authorizes delivery. Normal events
must match the requested confirmation depth; canonical events omit that field.
Normal ingestion wakes the message loader and hands control to checked preparation.
A zero-depth rollback cancels read-ahead for that origin. Disconnects and stream
failures cancel read-ahead for every origin on the connection. Existing cache
policies and expiry still apply to completed, reusable RPC reads.

The work is bounded to eight concurrent tasks, 256 tracked messages and a
20-second task timeout. `hyperlane_relayer_early_preparation_dropped{origin,reason}`
counts rejected hints at those limits. Runtime message/address denylist rules and
cached origin-signer rules are checked before discovery. Gas-payment enforcement
remains on normal preparation: a legitimate fresh dispatch may arrive before its
payment is indexed, so missing early payment data is not proof of an unpaid message.

Canonical replay uses the existing lossless broadcaster. A full receipt-indexing
subscriber applies up to 30 seconds of backpressure before retry; transaction IDs are not discarded. Pending
notification intent survives cancellation before handoff, and the WebSocket cursor
advances only after handoff. Live-only streams retain RPC history and gas indexing.
Reconnects use exponential backoff capped at two minutes plus jitter, with the
existing additional delay for rejected subscriptions. Live block hashes are
verified at startup and after subscription. Transient startup verification errors
retain the origin and retry in the background with backoff and jitter. Its RPC
syncs wait for verification; loaders, proofs and submissions stay gated meanwhile.
Other origins and this chain's destination role remain available.

## Recovery

`hyperlane_relayer_origin_recovery_required{chain}` is one when conflicting
indexed data requires coordinated recovery. It is restored from the DB at startup.
The gate stops that origin's loaders and proof generation. Classic submissions,
classic batches, and queued/retrying lander transactions check all participating
origins at each submission attempt. Conflict marking is serialized with each poll
of the send future; a new conflict wakes and cancels pending work. Locks are
released whenever the future yields. A matching replay cannot clear the gate.
Actual RPC-verified live-block reorgs retain the existing full-relayer halt.
Fastpath WebSocket enablement is excluded until a compatible image and recovery
policy are deployed separately.

To recover, stop all relayer/lander processes using the affected state and reconcile
already accepted transactions first. Archive the DB. Restore a known canonical
snapshot with matching pending state, or rebuild into an empty DB with RPC indexing
from the contract deployment heights so the complete Merkle history and outstanding
messages are available. Restart with WebSockets disabled, verify indexing, queues
and proofs, then re-enable the stream. An empty replacement DB has no recovery
markers; do not copy back stale pending metadata or clear marker keys alone.

Requests already sent to a node cannot be revoked. Reconcile those transactions
before recovery. New lander payloads persist their origin, including in batches;
legacy payloads without it conservatively check every configured origin. Origin
construction failures retain the existing bounded startup retry/skip policy;
background recovery here applies to live-block verification of built origins.
