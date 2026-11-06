# Validator Source retry follow-up

Implemented, verified, owned source slice frozen. No Cargo builds or comparative performance timers.

## Owned writes

- `zig/src/agents/validator/{generic,evm}.zig`: real insertion-indexer fallback/backoff, Source cursor initialization and scoped dynamic-tip cache.
- `zig/src/agents/validator/{index_source,tick_clock,cursor_init,fetch_backoff_test}.zig`: stable borrowed Source fallback; actual completion clock; bounded Source startup; real native DB/HTTP regressions.
- `zig/src/validator_fetch_backoff_tests.zig`: focused native root and operational API/Task instantiation.
- `zig/src/agents/validator_task.zig`: actual remaining Source wake, shared critical tracker, one bounded Task-owned tip cache, terminal initialization exhaustion.
- `zig/src/ops/init_metrics.zig`: disjoint actual-construction-only helper requested by Root; Root/runtime_review own real constructor wiring.

Shared indexing Core/fetch_backoff, Source Rust, quorum/vote denominator, WS protocol/socket/controller, durable signing/reorg guard, Origin and other owners' metrics were not edited.

## Source trace

`rust/main/agents/validator/src/validator.rs`555/565/579 constructs SequencedDataContractSync; lines841–854 calls ContractSync.cursor and ContractSync.sync. The normal WS fallback calls the same sync machinery (`merkle_tree_hook_sync.rs`). `hyperlane-base/src/contract_sync/mod.rs`37–115 owns one inclusive failed-range union per logical fetcher: initial5s exponential cap300s; disjoint work bypasses; overlapping success (including empty) resets. Native validators previously left Core.source_fetch_backoff=false or propagated EVM fetch failures to the coarse Supervisor interval.

Native generic Core explicitly enables Source fetch backoff for its insertion-only lane. Its stable Source wrapper retries ordinary low-level failures on existing independent indexer resources before a logical Core range failure. Replacing an event reader retains Core/cursor/failed-union state. beginCycle, custom range boundaries, cancellation, header, event and raw-sequence callbacks are forwarded; fresh checkpoint voters are separate.

Native EVM range admission uses the unchanged pure Source backoff state. It retires the pending cursor token before a postponed/failing query. Only after every eligible identity-checked reader fails with an ordinary transport/RPC error is one logical failure recorded. Eligible readers must have an authenticated ready vote/head covering the range when a vote round exists. Canonical/refusal/control/OOM errors propagate immediately; they are not ordinary fetch failures. Existing fixed-denominator Root authorization and signed-prefix audits are unchanged. The event reader remains one canonical-fenced concrete endpoint with fallback; this does not introduce quorum-aggregated eth_getLogs. Rust chain-provider quorum versus this existing one-reader boundary must remain qualified, rather than called newly equivalent by these tests.

Range failures use actual I/O-completion time, not the cycle's frozen injected start. Returned remaining delay is recomputed on Role return and again after Task bookkeeping; source wakes remain bounded by the configured checkpoint interval, so indexing backoff never postpones checkpoint/finality freshness checks.

## Independent cursor initialization and critical error

Source validator.rs800–831 retries cursor construction ten times; successful construction publishes critical_error=false. Each failure sleeps **2 seconds**, including the tenth; exhaustion publishes true. The2s constant is `hyperlane-core/src/rpc_clients/retry.rs13`; it is distinct from FetchRetryBackoff's5s.

`ForwardBackwardSequenceAwareSyncCursor::new` (`contract_sync/cursors/sequence_aware/mod.rs96–137`) reads latest sequence count/tip, requires count, reads persisted backward progress, then constructs cursor state. Native EVM maps this to identity-checked fallback Indexer.countTip + required count + actual native first backward target validation + Cursor.init. Generic maps Source.streamTip(3) + count + native progress read + Cursor.init into Core.cursors[1]. Pure Core.prepare is not a successful startup. Native progress remains lazily loaded per gap, while Rust loads its vector up front; this is an explicit implementation difference.

The existing WS Bridge reconstruction (authenticated floor, actual DB cursor scan and socket-owner setup) is its own Source startup success boundary. Lightweight/live-authoritative WS does not start an RPC insertion cursor or add eth_getLogs. Later normal RPC fallback initializes its real RPC cursor separately. Cancellation/cooperative PendingReadIo/owner absolute deadline/refusal/OOM are not completed startup attempts. Actual native libcurl code28 returns RequestDeadlineExceeded too. Direct-native indexer boundaries normalize that completed per-request timeout to ConnectionTimedOut only when there is no owner cancellation/cooperative journal/override; injected/control deadlines retain their original errors and consume no attempt. The actual local-socket timeout case is verified. An exhausted startup is terminal; no healthy-cycle metric clear occurs.

Task owns one stable critical tracker. `criticalForChain(domain)` lets Root's metrics-provider constructor record/clear only destination_metrics on that same tracker. Cursor exhaustion uses only merkle_tree_hook_sync; a sibling reason cannot be cleared by cursor success.

## Cache and lifecycle integration

Task lazily owns one bounded dynamic-tip cache through joined Role/client teardown. Generic indexer resources opt in; checkpoint reader resources explicitly opt out. EVM scopes save/restore provider Options around countTip/range Indexer calls; fresh vote, proof and safety calls remain off. Explicit numbered canonical fences are cache-ineligible. Direct Role-only fixture callers without a Task-provided cache remain uncached; actual service Task provides the shared cache.

Standalone EVM slot client ownership emits providerCreated once after successful final ownership, providerDropped after client destruction, through primary Recorder only. No quorum-recorder double counting. These are native endpoint-client lifetimes, not Rust Arc-clone object counts.

## Functional acceptance

Archived evidence: `zig/bench/results/validator-source-retries/manifest.json`. Every result is correctness under shared load, not comparative throughput or final cold-build evidence. Owned source hashes before/after the final focused suite are identical; other agents' global dependency files were not frozen by this slice.

- Native Source retry/init/cache/critical/metric/Task/API suite: **22 passed,0 skipped,0 failed**. Actual RocksDB and native HTTP/libcurl; healthy peer immediate; one logical5/10s failure after peer exhaustion; no fetch before deadline; disjoint sequence progress; overlap reset; real completion-time scheduling; original controls; real physical request timeout counted; ten HTTP initialization failures followed by the final2s delay; actual critical publication; no fresh-read cache leakage; Task constructor allocation-failure cleanup and fatal exhaustion classifier.
- Actual event metrics: native generic store emits exactly2 stored events. Logical retries increment1 then2; scheduled backoff5→10 seconds; disjoint forward success leaves10; overlapping recovery clears0. Data type/task labels are actual Source `merkle_tree_hook`, `merkle_tree_insertion`, `cursor_task`. Shared indexing Adapter retains atomic max-sequence raise. Duplicated Task cursor/block/liveness writers were removed.
- Existing durable validator tests: **191 passed,18 optional skipped,0 failed**, including reservation/sign/publication replay, authenticated snapshots, fixed denominator and durable fork guards.
- Fresh EVM Role against production Solidity/Anvil: three checkpoints match actual Rust roots and IDs; restart performs no duplicate signing/publication; authenticated snapshot repairs history; lying event reader recovers; growing signed-prefix fork halts durably.20s stalled first slot does not block healthy quorum:476ms functional gate; classic fallback42ms. These are single correctness observations, not speedup measurements.
- Fresh generic Tron HTTP bridge against production Solidity/Anvil: three checkpoints/Rust parity, native indexing/Rocks/sign/publication, restart/history repair, lying-indexer audit/rotation and signed-prefix fork all pass. This bridge is not Tron consensus/execution or all-VM process evidence.
- Actual current native validator CLI: ReleaseSafe functional build succeeds; pinned in the artifact manifest. WSS loopback validates first503 recovery, schema-reject reconnect, lightweight **zero eth_getLogs**, restart no duplicates, foreground fresh checkpoint while old history is blocked, authenticated history repair, normal RPC→WS cutover with zero logs afterward, and60s authenticated idle fork detection with signed objects unchanged. One socket owner/1MiB stack handles the two live/history connections.
- Actual pending guard process: task-path-only fixture interposer performs real WAL fsync then reports EIO. SIGTERM exits1 (23ms), no new checkpoint objects; restart exits1 after making backend guard durable. Signed objects and nonce remain unchanged after pending guard observation. Already-sealed announcement reconciliation is separately qualified in the raw artifact.
- Init latency helper: **2/2 passed**. No sample before actual completion; exact millisecond labels; measured submillisecond0 is valid; telemetry pressure cannot fail construction. Root/runtime_review own real constructor callsites; no composite duration copied into fictitious components.

The archived external live-edit compile failure is retained and superseded by the successful final focused and actual process checks. No external files were edited to conceal it. Global benchmark gate remains controlled by Root.
