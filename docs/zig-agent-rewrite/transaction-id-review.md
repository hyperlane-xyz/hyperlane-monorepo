# Independent transaction-ID companion review

All three transaction-ID findings below are resolved in the scoped component
checks. Final combined agent and benchmark gates remain separate.

2026-11-06. Read-only review of ordinary canonical dispatch fanout, receipt
adapters, queue/replay/controller integration and related emitter consumers.
No production source edits, production requests, SDK builds, role binaries or
benchmarks. Applied repository code-review guidance and a narrow emitter/index
variant audit. Owners were actively extending tests and implementing the fixes
below; discovery references describe the reviewed code, not a final frozen tree.

## Findings resolved before acceptance

### P1: Unavailable receipt prefix can permanently block ordinary range indexing

Trigger: queue capacity N; the first N canonical dispatch IDs have permanently
unavailable/pruned receipts; the next transaction has a valid healthy receipt.
For a minimal regression use capacity1, unavailable A, healthy B.

`tx_id_companion.zig:108–118` sends every ordinary receipt failure to
`Queue.retry`, retaining the entry indefinitely. `tx_id_queue.zig:97–102`
changes only inflight/due time, so no RAM admission slot is released.
`Queue.admit:71` rejects B with `TxIdQueueFull`. Store notification occurs after
the canonical B row is committed, and the producer correctly retains its row
position (`evm_origin.zig:130`, `indexing/source.zig:191`). That means neither B's
receipt nor the ordinary range cursor can progress, however healthy their RPCs
are. Draining before producer retry cannot fix this when every slot belongs to
an unavailable receipt. Startup scanning also stops on the same full queue
(`tx_id_companion.zig:57–59`).

Rust `hyperlane-base/src/contract_sync/mod.rs:330–335` drops a failed receipt
notification and continues, relying on the normal cursor for repair. Native
retained retries improve transient recovery but must not turn a repair path into
an origin-wide availability dependency. Bound retry-slot occupancy or rotate
through already durable canonical dispatch state without marking failed receipts
complete. Test healthy progress beyond queue AND completed-cache capacity while
an unavailable prefix remains recoverable, including startup disk replay.

Resolved: failed receipts release admission slots into bounded cooldown hints.
Failure-driven bounded disk replay retains recovery without blocking healthy
producers; the native regression covers capacity1, later recovery and processed
hint expiry without a busy loop.

### P2: Aleo's independent event counters collide in a transaction-wide position map

`tx_id_companion.zig:69,82–85` originally keyed conflict detection only by u64
`event.log_index`. `scraper/aleo.zig` returns all relevant kinds and assigns each
kind's immutable mapping counter to both `log_index` and `sequence` (original
line240). An accepted transaction may legitimately contain dispatch0,
insertion0 and gas0. Their different payload fingerprints collide, producing
`ConflictingTransactionReceiptLog` before any write and permanent retries.

Rust Aleo `indexer/traits.rs:260–267` uses precisely this per-stream index as
LogMeta.log_index. Changing event metadata to invent a global EVM-style ordinal
would break Source semantics. Use a concrete trusted position namespace for Aleo
(emitter + stream + index), keeping ordinary EVM global log-index conflict
checks strict. Required regression: actual Aleo multi-kind receipt with equal
indices persists tree/gas; an inconsistent duplicate within one kind/emitter
still rejects before mutation.

Resolved: concrete Source.TransactionAuthority selects
`positions=per_emitter_stream` for Aleo; EVM retains global_log_index. The actual
SDK-to-consumer fixture verifies both valid equal indices and conflicting
same-stream rejection before writes.

### P2: Aleo program emitters are compared to logical hook/IGP mapping addresses

Original `tx_id_companion.zig:75–80` compares insertion emitters to
`contracts.hook` and gas emitters to `contracts.paymaster`; origin_tasks.zig150
passes raw chain settings. Aleo hook/IGP settings identify mapping keys. Actual
Source event emitters are program addresses: mailbox program for messages,
hook-manager program for gas/tree. New Aleo callback derives the correct program
address (original scraper/aleo.zig165,200,240).

Rust `indexer/traits.rs:193–196,260–267` derives LogMeta.address from ProgramID.
A configured logical hook can differ from programAddress(hook_manager), as the
existing native cooperative Aleo fixture demonstrates. Consequently valid
gas/tree rows fail `TransactionReceiptEmitterMismatch` even after fixing index
namespaces.

The same root cause occurs in existing ordinary range
`agents/indexing/source.zig:580–585`: it compares logical hook/IGP settings against
Aleo Adapter.fetch metadata from the real events.Indexer. Fixing only companion
leaves `WrongOriginEventEmitter` in ordinary gas/tree ranges. The existing
cooperative fixture covers dispatch only.

Use trusted concrete Source emitter authority for validation. Preserve logical
hook/IGP settings for mappings, checkpoint history and configuration identity;
do not rewrite Source event addresses. Resolved in Core, Companion and the
validator fallback wrapper. Actual SDK gas/tree consumer and Core range tests
use distinct logical hook and physical program addresses.

## Emitter variant audit: no additional blocker found

- Actual Aleo scraper path is chain_source.Resources.source ->
  scraper.Factory's .aleo branch -> Aleo.Factory.interface -> Adapter.interface.
  scraper/task.zig169 passes that Source directly to Pooled/Native Worker.
- generic.Adapter address assignment at generic.zig118/230 is bypassed by this
  path. Production generic.Adapter construction is in Sealevel; the other
  instances found are test fixtures. Aleo/Tron/Radix references to generic are
  fingerprint helpers, not adapter wrapping.
- SQL pipeline ingests actual source events. pipeline.zig112–125 verifies and
  normalizes block_hash only; db/scraper_store.zig376 persists event.address.
  Gas, insertion, delivery and dispatch use separate tables; there is no common
  transaction-wide EVM log-position rejection there.
- Scraper setup stores logical contracts for restart configuration validation
  (setup.zig19; scraper_store.zig129–153). That configuration remains distinct
  from actual row emitters. No mutation into history/mapping configuration was
  found. New Aleo TransactionAuthority computes separate addresses.
- Public /relay rejects non-Ethereum in public_relay.zig73. Rust
  relay_api/handlers.rs591–599 explicitly permits only EVM CCTP V2; this is not an
  Aleo emitter regression. Its EVM log matching remains against configured
  mailbox/paymaster. Aleo receipt enrichment projects transaction information,
  not event emitters, so the same mismatch does not arise there.

## Other reviewed boundaries

No additional concrete blocker found in these inspected paths:

- Store.storeMessage commits before notify. Duplicate canonical dispatch rows
  notify again, allowing recovery after DB success followed by queue pressure.
  Both EVM and generic producers retain per-row persistence offsets and cursor
  ownership across queue-full yields. Already-notified prefixes are not replayed
  merely because the finite completed cache evicts older entries.
- Startup scan visits bounded64 nonce positions per tick, retains the exact
  not-admitted row on full queue, skips processed rows and missing/zero tx IDs,
  and reuses canonical durable dispatch metadata. Its full-failed-prefix liveness
  issue is finding1, not a claim that restart records are lost.
- Stream masks cancel/release retained companion work before authority ack and
  reset replay. Disabled tx-ID flag prevents companion/queue construction and
  leaves ordinary indexing. WS-only stream masks remove tree/gas demand without
  receipt requests. An already existing child Resources may bracket an empty
  pass, but does not issue a request.
- Resources.forkReadFor creates independently owned typed clients/replay journals
  while borrowing the existing Pool/runtime. There is no extra Pool/worker.
  Source.bindCancellation is undone by defer; Resources.endReadPass clears all
  caller cancel pointers. Pool/HTTP jobs own late cancellation state. Child
  resources are destroyed before parent resources, after owner joins.
- EVM callback checks receipt status, exact tx hash, height/hash/index, every log's
  metadata and before/after canonical header. Tron uses exact Receipt.parse and
  solidified before/after headers. Cosmos binds hash/raw tx/index membership to a
  canonical chain/height block (the parent's previously identified membership
  defect was already being fixed; not duplicated as a new finding). Radix
  Client.committed validates exact network and intent hash even for empty events;
  its state-version-derived hash is the existing Source gateway trust boundary,
  not independent consensus authentication. Aleo locates and decodes the block,
  matches exact requested accepted transaction and finalize keys, and rechecks
  its canonical header.
- Successful canonical receipts with no matching configured events may complete
  empty. Failed, missing, malformed and identity-mismatched receipts remain errors.
  The common consumer never admits receipt dispatches as public/canonical
  messages and does not advance range/gas watermarks. Existing provider trust is
  not cryptographic proof of every log against consensus; that is also Source's
  boundary and is not reported as a new vulnerability.
- Queue ready rotation handles a failed neighbor when healthy neighbors are
  already admitted. It does not solve the not-yet-admitted starvation in finding1.
  A retained PendingReadIo serially owns one receipt until its bounded deadline;
  Source also has one serial receipt task, so this alone is not a new defect.

## Aleo transition-count question: checked, no new finding

Read exact local pinned SDK git objects at
6c5b8762d8058287d1d2ca27c391aeb0eccdf9fa without checkout/build/network:

- ledger/block/src/lib.rs577: Block.into_transitions delegates to Transactions.
- transactions/mod.rs333: consuming iterator flat_maps every confirmed valid
  transaction via into_transaction().into_transitions(), no accepted-only filter.
- transactions/confirmed/mod.rs260: into_transaction returns its valid stored
  Transaction for accepted and rejected variants. Its Deref implementation354
  delegates transaction.transitions() to the same Transaction.
- Native block_info (aleo/native-vm/src/lib.rs630–645) serializes exactly those
  transaction.transitions(). Rejected execution payloads are not substituted for
  the valid fee transaction.

Therefore counting all decoder candidates' transitions matches Source's set.
Both implementations compute last_index saturating-sub i; duplicate floor0
candidates map to the same key/index0, and target finalized-key dedup does not
omit a different legitimate index. The explicit target accepted check rejects a
rejected requested transaction. No unsupported new transition-count parity claim.

## Verification and closure

| Evidence                                                         | Result                                                           | Attribution                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Current-endpoint authority, cancellation and bounded hint expiry | 4 passed, 0 skipped; two substantive tests plus import roots     | Independent reviewer execution                                |
| Common native controller and immutable Rust stopped-DB readback  | 29 passed, 0 skipped                                             | Baseline owner; parent archived source hashes and logs        |
| Existing origin compatibility                                    | 42 passed, 0 skipped                                             | Baseline owner, native curl enabled                           |
| Generic adapter receipt paths                                    | 19 passed, 0 skipped; five import roots                          | External adapter owner; parent verified archive/source hashes |
| Cosmos receipt data through common RocksDB consumer              | 8 passed, 0 skipped; seven import roots                          | External adapter owner; parent verified archive/source hashes |
| Aleo SDK/consumer/Core range                                     | 25 passed, 0 skipped, including three new acceptance regressions | External adapter owner; parent verified archive/source hashes |

The independent wrapper regression retires/poisons its first endpoint, rotates
through header fallback, observes the replacement's different physical authority,
checks cancellation and confirms absent capability uses real consumer contracts.
Every authority call resolves the current context and returns value-only data;
no initial endpoint pointer is retained. Role.advanceIndexReader binds current
cancellation before destroying old Resources.

Failed queue entries now release their slots into bounded cooldown hints without
recording success. `beginReplay` consumes a failure-driven replay request and
expires hints even when a failed message becomes processed or disappears. A
successful idle startup scan does not restart every2s.

The actual Aleo followup decodes SDK gas/tree index0 with physical program
emitters, persists both through Companion into RocksDB, retains full64-byte
transaction metadata and leaves the gas watermark unchanged. A fresh consumer
replays idempotently; changed same-kind payloads reject before any gas/tree/meta
write. Core.fetchInsertionRange independently accepts the concrete program emitter.
The four production adapters were unchanged during this test-only followup.

Exact commands, lossless logs and source hashes are archived under
[`transaction-id-companion/manifest.json`](../../zig/bench/results/transaction-id-companion/manifest.json)
and [`transaction-id-adapters/manifest.json`](../../zig/bench/results/transaction-id-adapters/manifest.json).
The final SDK evidence is explicitly attributed to its executing owner and
parent verification; the independent reviewer did not repeat that native run.
These findings are closed at component level. Whole-agent acceptance and
performance remain separate gates.
