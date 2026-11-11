# Zero-confirmation discovery

EVM origin dispatches, Merkle insertions and gas payments enter the normal relayer
pipeline immediately, through scraper-proxy WebSockets or RPC at depth zero.
There is no separate cache-warming pipeline. Validator and destination finality
settings are unchanged; non-EVM indexers keep their existing confirmation behavior.

All configured origin VMs can use scraper-proxy WebSockets. EVM origins subscribe at
`confirmations: 0`. Other origins subscribe at their configured numeric reorg depth,
or use the scraper's default confirmed stream when there is no numeric depth.
Their RPC indexers retain the existing confirmation/finality behavior. The scraper
may itself wait for chain-native finality before making non-EVM events available.

Origins with the same effective confirmation policy share one connection. Each
connection carries dispatch, Merkle and gas-payment streams for its domains; origins
with gas indexing disabled are omitted from the gas stream. Each origin independently
keeps RPC active until it has covered history through an overlapping subscription
checkpoint, including gas payments. Only then does its supervisor pause RPC indexing.
An origin's event or progress-probe errors restore RPC for that origin. A socket failure
restores RPC for the whole group. EVM recovery reconnects the group to discard queued
frames from the old fork. Reconnects repeat each origin's overlap check. Progress probes and reorg audits still use RPC while event indexing
uses WebSockets. `websocketAuthorityEnabled: false` keeps RPC as the discovery source
and validates WebSocket frames in shadow mode without writing them or pausing RPC.
Proxy connection capacity includes one socket per distinct confirmation policy per
relayer instance, in addition to validator connections and deployment headroom.

Destination delivery is still checked by the existing delivery/receipt confirmation
pipeline; a zero-confirmation delivery notification is not a finalized receipt.

For EVM, every newly indexed event is journaled atomically with its database effects, including
late RPC backfill. The relayer verifies block identities before pruning records through
the configured origin confirmation boundary. The audit runs without WebSockets too.
Non-EVM streams use the same ingestion, RPC overlap/fallback and downstream processing,
without enabling the EVM provisional journal or block-based recovery. Confirmed-stream
rollback notifications halt for manual recovery.

An EVM rollback notification or conflicting indexed event closes submission admission for
the affected origin. The supervisor stops its RPC writers, rolls back the journal and
rewinds the prover. It invalidates prepared work, rebuilds cursors and resumes discovery.
Only the provisional suffix above the persisted configured-confirmation boundary is
recovered automatically. A changed block at or below that boundary preserves the
existing halt and manual-recovery behavior; confirmed data is never rewritten by
recovery. A configured period of zero has no automatic recovery window.
Recovery state and generation survive crashes. Transient RPC failures retry.
Other origins remain available during provisional recovery.

Destination transactions, payload references and gas expenditure survive recovery.
Already-submitted transactions remain tracked; they cannot be revoked. Old prepared
transactions cannot be submitted or rebroadcast after recovery. Processed markers are
bound to message IDs so a replacement at the same nonce is not skipped.

Signature polling starts immediately. The bounded fast polling window starts after
origin maturity, so an Ethereum confirmation wait does not exhaust it. A brief bounded
retry also handles gas or Merkle data arriving just after a fresh dispatch.

Submission still requires the destination ISM's verification and gas policy. Multisig
ISMs wait for validator signatures; CCTP follows its attestation policy. Null/trusted
ISMs do not inherently impose origin finality: zero-confirmation discovery can permit
early irreversible delivery on those routes. Reorg recovery cannot undo delivery.

Normal overhead is a journal write per new event, bounded progress probes and block
identity verification. Journal size follows ingestion since the last successful audit
and the unconfirmed tail. RPC outages can extend retention. Recovery may scan Merkle
history to restore reverse lookups. There is no automatic full-history rebuild.
