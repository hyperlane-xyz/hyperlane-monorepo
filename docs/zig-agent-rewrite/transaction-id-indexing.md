# Transaction-ID indexing

Ordinary canonical dispatch indexing now notifies bounded transaction companions
for gas payments and tree insertions. This closes a Source parity gap: a healthy
range response could omit a payment, advance its range watermark, and leave the
message blocked by gas policy for the rest of the run. The companion fetches the
actual transaction events without advancing any range cursor or watermark.

Rust enables this fanout by default in `relayer.rs` and
`hyperlane-base/src/contract_sync/mod.rs`. Native honors the existing
`txIdIndexingEnabled` setting. Source supplies real transaction lookup for EVM,
Cosmos Wasm/Native, Tron, Radix and Aleo; Sealevel and Starknet inherit Source's
empty implementation and do not acquire a new receipt requirement.

## Ownership and recovery

The existing origin owner drains receipt work before retrying a producer blocked
on queue capacity. Its child Resources borrows the existing RPC Pool and HTTP
runtime while owning separate clients and replay journals. It adds no thread or
Pool. Shutdown releases the companion, its child Resources and the metadata queue
before releasing parent Resources.

Canonical dispatch persistence precedes notification. Duplicate canonical replay
notifies again, including the WS stored-identity path, so queue saturation after
commit does not lose the notification. Producers retain the exact persisted-row
offset and cursor token across queue pressure; they do not re-fetch or restart a
completed prefix. Queue capacity, completion cache and cooldown hints are each
bounded. Production capacity is 1024.

An ordinary failed receipt releases its admission slot without being marked
complete. Existing canonical unprocessed dispatch records provide restart and
retry recovery. The scanner visits at most 64 nonce positions per call, retains
the exact unadmitted row on saturation, and requests another pass only after an
actual receipt failure. Startup scans once; successful idle operation does not
repeatedly walk message history. Due replay consumes expired cooldown hints even
when their messages became processed. A failed prefix therefore cannot occupy
all admission slots forever or trigger an immediate retry loop.

Source Rust drops failed tx-ID notifications and relies on ordinary cursor
repair; Native additionally replays pending canonical dispatch records after a
bounded cooldown. This stronger recovery does not create a new durable queue
format. Completed-cache eviction may permit an idempotent duplicate receipt read
during a later failure-driven scan. PendingReadIo retains its lease and partial
persistence offset. Cancellation, allocation failure and admission/deadline
controls propagate through their existing owner contracts.

## Event authority

The whole returned batch is validated before the first native write. Transaction
identity retains all 64 bytes; dispatch block height, block hash, emitter and
protocol position must agree. Only gas/tree data is persisted, using existing
idempotent Store methods and original LogMeta. Receipt-only public admission is
unchanged.

Concrete Source authority separates physical program emitters from logical
contract settings. Aleo uses actual mailbox/hook-manager program addresses and
per-emitter, per-event-kind mapping counters. EVM retains global log-index
conflict detection. Ordinary range validation uses the same concrete emitter
authority; checkpoint hooks and mapping keys remain logical configuration.
Validator fallback forwarding resolves the current endpoint for each authority
call, preserving context lifetime through endpoint replacement and the caller's
fallback contracts when no override exists.

## Functional evidence

These are functional checks, not performance measurements. The owner acceptance
manifest records source hashes, exact commands and compressed raw logs:
[`transaction-id-companion/manifest.json`](../../zig/bench/results/transaction-id-companion/manifest.json).

| Check                              | Result               | Scope                                                                                                                                                            |
| ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native tx-ID focused root          | 29 passed, 0 skipped | Actual EVM wire decoder, RocksDB, queue pressure, PIO, cancellation, allocation failures, restart, masks, disabled flag, protocol namespace and wrapper lifetime |
| Origin compatibility               | 42 passed, 0 skipped | Existing origin bootstrap/indexing and physical timeout checks; native curl enabled                                                                              |
| Independent wrapper/queue subset   | 4 passed, 0 skipped  | Separate reviewer command on the preceding source snapshot                                                                                                       |
| Immutable Rust stopped-DB readback | Executed             | Existing production HyperlaneRocksDB/FullPayload decoder read repaired gas=1000/payment=500 and canonical insertion; processed remained absent                   |
| Generic Cosmos/Tron/Radix adapters | 19 passed, 0 skipped | Actual receipt wire paths, canonical identity, successful empty results, cancellation, pending reads and allocation failures                                     |
| Cosmos common consumer             | 8 passed, 0 skipped  | Omitted gas/tree receipt data reaches RocksDB once without advancing the gas watermark                                                                           |
| Aleo SDK and common consumer       | 25 passed, 0 skipped | Actual same-index gas/tree events with program emitters reach RocksDB; replay is idempotent; conflicts reject before writes; range authority passes              |

Generic adapter evidence is archived separately in
[`transaction-id-adapters/manifest.json`](../../zig/bench/results/transaction-id-adapters/manifest.json).
Counts include import-root and transitive dependency tests: the 19-case pure
suite includes five import roots, and the eight-case Cosmos consumer includes
seven. The Aleo suite includes three new adapter-to-consumer/range regressions.
These focused checks do not replace the final combined CI gates, role binaries
and paired benchmarks required before claiming the complete rewrite finished.
