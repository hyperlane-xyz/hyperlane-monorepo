# Execution status

The requested complete agent replacement is **in progress**. All three native
executables run against local Solidity/chain fixtures. Implementation findings and
focused reviews are closed; final combined acceptance and matched whole-agent
benchmarks remain open. No draft PR or production cutover has occurred.

## Current acceptance snapshot — 2026-11-06 11:15 UTC

Runtime source is frozen after the scraper catalog guard, executor wakeup and
Aleo worker lifecycle corrections. The fresh canonical default suites passed
745/745 in both ReleaseSafe and ReleaseFast. Native DB, PostgreSQL, emitted-role
and remaining network checks are still running against that same snapshot.

The scraper guard passed14/14 focused checks and437/437 PostgreSQL tests with zero
skips. Metadata fixture corrections passed ten substantive tests in both modes on
macOS and Linux. Aleo worker exec/RSS checks passed3/3 in Debug/Safe/Fast, including
failed-exec cleanup and the inherited-RSS reproducer. Independent reviews are
closed. See [schema guard](scraper-schema-guard.md),
[metadata fixtures](metadata-fixture-recovery.md),
[executor wakeup](metadata-executor-wakeup.md) and
[worker lifecycle](aleo-worker-linux-lifecycle.md).

The final immutable full-SDK Linux arm64 image passed actual baked-worker Aleo
75/75, Starknet44/44, regex9/9, HTTP/2/trailer and sandbox checks, plus three roles'
shutdown/reopen smoke. Its matching final core image is still building. Packaging
pins the verified Debian curl8.14 backport: stock Bookworm curl7.88 reproduced an
upstream HTTP/2 reuse defect without Zig. These are local arm64 correctness checks;
amd64 CI and comparative runtime measurements are separate gates.

The prior broad snapshot passed all eleven inner checks but was rejected by its
source-stability guard because an unused packaging checker changed during the run.
A subsequent default run caught a macOS-only assertion in a new Linux socket
control; that test-only OS guard is corrected. Both attempts remain preserved.
No final build or whole-agent speedup is established yet.

## Previous snapshot — 2026-11-06 09:52 UTC

Eleven ReleaseSafe gate types passed across compatible selected source maps:
default738/738, native DB1,021passed/1optional skip, PostgreSQL424/424, emitted
roles and three help checks, RPC404/404, operator56/56, WS22/22 and socket4/4.
These overlap; do not sum them as unique tests. Fixture-provisioning failures and
the source-map limits remain in the [validation record](../global-functional-validation.md).
They do not establish acceptance of the later changes below.

ReleaseFast default passed738/738. Its native suite passed1,020with1optional skip
and1failure caused by an uninitialized test context hash. The fixture constructor
is corrected; a bounded variant search also corrected an uninitialized EVM mock.
Fresh mode-specific suites remain pending. Linux native acceptance exposed missing
RSA fixture inputs, three macOS-only fixture paths, nondeterministic allocator
fault-injection counts and an intermittent metadata retirement failure.

The [credential allocation correction](credential-allocation-portability.md) is
test-only and passes12/12 on Linux Debug and Linux/macOS ReleaseSafe/ReleaseFast.
The full constructor/lease fault sweep remains; no successful OS-remap coverage
is claimed. Independent review is archived. Linux packaging now provisions the
existing RSA/H2 fixtures; the native OpenSSL probe also established the correct
version-string prefix for the packaging checker. Images have not yet passed.

Two implementation gates are open: scraper startup must enforce Rust's exact
read-only frontier/index-cutover validation before lanes can run; an executor
suspension may require a worker wakeup to retire detached continuations. The
startup guard is under actual PostgreSQL testing; the wakeup hypothesis requires
a deterministic regression before a source fix. Source is not frozen for final
builds or timing.

## Previous snapshot — 2026-11-06 08:54 UTC

Source writers are frozen after the shared nonce, sender, RPC timeout and signer
reviews. Counts below identify focused functional snapshots; they are not
full-source acceptance or comparative performance results. A fresh broad
ReleaseSafe run is underway; ReleaseFast checks and final emitted-artifact
acceptance remain open.

Ordinary dispatch transaction-ID recovery is implemented. The common controller
passed29/29 native checks and42/42 origin compatibility checks; the generic
adapters passed19/19 pure,8/8 Cosmos consumer and25/25 Aleo SDK/consumer checks.
These counts include import roots. Independent review closed queue starvation,
Aleo index namespaces and physical emitter authority, including actual SDK events
through RocksDB and ordinary range indexing. See
[transaction-ID evidence](transaction-id-indexing.md) and
[resolved review](transaction-id-review.md).

Native preparation backpressure passed49/49 focused checks. Native regressions
have moved to their proper link aggregates. Ethereum wire response/rate-limit
recovery is implemented and passes the preserved and expanded actual validator
Role cases; see [response recovery](rpc-response-recovery.md). Typed header validation now runs before provider success, voting and caching.
Seven focused suites passed, including actual native/standard validator recovery.
Rust shares the earlier raw-value fallback gap; this is an availability
improvement. See [typed-header evidence](rpc-typed-header-recovery.md).

Source-supported Starknet batching is implemented. The final focused coordinator
suite passed95/95 with independent review, including full-width nonce retirement,
atomic WAL cuts/reopen, all-delivered nonce reservations, canonical receipt
changes and fair recovery beside stalled journals. Shared cold sender checks and
the actual Tron path are permanently registered in native DB tests. See
[group runtime](starknet-group-runtime.md) and [nonce proof](starknet-nonce-proof.md).

Direct RPC fallback now distinguishes completed physical timeouts from true
owner deadlines. The shared Manager/KMS/auth path passed31/31 after review caught
and fixed a public-key error-unwind restoration bug. The fallback producer suite
passed15/15: sequential requests retain20-second physical caps, configured
immutable hedges retain their30-second cap, and blocking requests carry explicit
owner clocks while cooperative reads keep their retained logical deadline.
Independent review matched all14 selected source hashes. See
[HTTP timeout recovery](rpc-physical-timeout-recovery.md) and
[Cosmos evidence](cosmos-rpc-timeout-recovery.md). These overlap with other roots;
test totals must not be summed as unique coverage.

The first broad source snapshot exposed four stale health-header fixtures and
failed-test teardown leaks (698/702 passed). The test-only corrections passed44/44
with all available SDKs, zero skips/leaks; production health code was unchanged.
The failed broad snapshot remains retained. The new broad run must pass before
full-source acceptance is claimed.

All four retained Rust bridges pass exact-source Clippy with warnings denied.
Only Aleo crypto test-module ordering changed; exported code is unchanged. The
final cold build must rebuild the SDK artifacts, and native correctness checks
must use those exact final libraries before timing acceptance.

Metadata source is frozen after independent lifetime review. The final EVM root
passed402 tests with12 explicit skips; production SVM tests passed22/22. All three
roles compiled, and cancellation, post-fetch clocks, replay deduplication, late
callbacks and full validator observations have focused proof. See
[metadata evidence](metadata-observability.md). These component results do not
replace the pending full-source process gates.

- Rust's600-second successful confirmation delay is preserved from actual
  inclusion, persisted across restart and released only after fresh canonical
  proof. The Universal Router reveal hook still runs before that hold. Final
  whole-process relayer/public/WS acceptance with this policy remains open.
- Immutable Rust Lander can mark messages processed without gas expenditure rows.
  Its source remains unchanged. The benchmark distinguishes this accounting gap
  from actual receipt costs; Zig must prove each ID's exact original-estimate
  allocation and rounding dust. Post-mine re-estimation is not valid evidence.
- The recovered Rust DB oracle passed3actual DB fixtures, Clippy for its binary
  and tests, and12-row Rust→Zig mutation→Rust typed readback. Lander golden helpers
  recovered their locked source graph, passed actual builds, and reproduced all
  accepted vectors. See helper-lock and disk-preparation artifacts.
- Common health wiring passed42/42 focused native tests, including actual libcurl,
  Aleo public crypto, all native public address formats, per-chain constructor
  failure isolation, safely published wallets and cancellation/drain. A separate
  permanent integration slice passed52/52. Validator/scraper/relayer service
  compilation passed after the joint metadata/SVM/cancellation/clock changes.
  Native root-context tests passed16/16; actual SVM composite observations and
  lifetime tests passed22/22, with a separate7/7 allocation/reference sweep.
- Actual relayer origin indexing, cursor, liveness and fetch-backoff producers
  are installed. Contract caches passed21/21 tests, with both native partitions
  aggregated and default ISM excluded from metered cache series. Shared250ms
  indexer-only tip caching, provider lifetime and hedge producers have focused
  native coverage. Final producer tests passed23/23, Pool85/86 with one optional
  skip, native HTTP11/11, standard HTTP4/4 and replay3/3. Ethereum preserves
  Source's valid JSON-RPC results/revert data on HTTP500; HTTP429 aborts after
  complete headers before reading its body. Other protocol/auth policies remain
  separate. Final whole-role checks remain open.
- Validator retry/init/cache/critical and actual indexing metrics passed22/22
  focused tests. Initial cursor construction uses the Source10completed failures
  and2-second retry policy; physical RPC timeout is distinguished from cooperative
  yield/cancellation. Fresh actual Anvil/Solidity acceptance passed: healthy quorum
  beside a20-second stalled first endpoint returned476ms; fallback42ms;3Rust-checked
  checkpoints, restart without resigning/republishing, history repair and durable
  fork guards passed. These are correctness observations under shared load.
  The durable suite passed191tests with18optional skips.
- Native WS lifecycle fixtures passed ReleaseSafe and Debug after closing the
  remaining replay/parity phases and degraded-gas malformed-row containment.
  Real production Registry assertions distinguish received caught-up progress,
  pending parity and authority. The earlier complete native module snapshot was
  685passed/54optional skips; a new full-source run remains open.
- Origin construction/indexing/prover metrics passed focused18/25/18-test roots.
  Shared critical state passed8tests; scraper startup/CCR recovery roots passed5
  each. Independent failures remain latched until that owner recovers; common
  health RPC failure cannot clear an unrelated role failure.
- Actual origin startup retries now have independent stream budgets, ten ordinary
  failures and two seconds after each completed failure, including the tenth.
  Pre-canceled tasks construct nothing. Final startup tests passed20/20; earlier
  compatibility41/41, state6/6 and replay86/87 with one optional cloud skip.
- Scraper PostgreSQL16.15 previously passed361tests/10optional skips and all21
  migrations. Actual9-chain process proof covered4receipt jobs, a healthy ninth
  chain beside8stalled heads, shutdown signals, restart and fork preservation.
  Final process proof and matched ReleaseSafe/ReleaseFast comparisons remain open.
- Linux durability passed38/38; the zero-FD credential/process suite passed27/27.
  Default Root passed493tests/58optional skips on Linux after fixture-path fixes.
  Final core/optional-SDK containers and exact-source CI checks remain open.
- Read-only Ethereum shadow captured1,571contiguous finalized blocks and147
  dispatch/insertion pairs over19,024.7active seconds, with Rust parity in successful
  windows. JSON-RPC retries were not completely counted. This is not whole-relayer
  mainnet operation or zero-failure service evidence.
- Both relayer harnesses completed independent proof review. Prepared fixes
  bind receipts to canonical height and original estimates, reject proven early
  retirement immediately, and require fresh restart liveness. The benchmark's
  canonical trace and the separate public-sidecar fixtures retain distinct DB
  authority rules. No final relayer paired result exists. Historical failures,
  improvements and regressions remain retained.
- Fair paired measurement uses the same metrics-only cumulative600-second guard
  for both implementations. Native per-ID operator polling remains in separate
  functional/smoke acceptance; adding it only to timed Zig runs would bias CPU.
  Final relayer timings require passing3-ISM, exact-four-member batch, crash, WSS
  and public-sidecar artifacts matching the exact native binary SHA. The current
  permanent harness suite passes28/28; these prerequisites are not yet met.
- Native Linux WS/WSS tests passed22/22 and socket-owner tests4/4 after replacing
  the hardcoded OpenSSL path and expiring certificates with owned ephemeral TLS
  fixtures. macOS passed22/22; both Python peers passed actual trusted-host,
  wrong-host and cleanup checks. Old static test keys/certificates were removed.

No final build, dependency, LOC or whole-agent speedup claim is made. Source writers
are frozen; final measurements still require completed functional gates, verified
immutable binaries and a quiet host. No PR or cutover has occurred.

## Destination scheduling tradeoff

Each configured destination has one lazy retained blocking owner, with a 1 MiB
stack and the existing 1,024-chain configuration bound. Supervisor callbacks
submit/poll only. Each owner retains its own cancellation token and absolute job
deadline; timeout never permits another job before the native callback retires.
Teardown joins destination owners, then metadata jobs, then clients/keys/databases.

This replaces the initial plan of running all destination calls inside eight
shared workers. Those workers remain for cooperative indexing and task polls.
Replaying a whole Lander tick would repeat mutations across signing, nonce and
broadcast boundaries; an asynchronous transaction stage redesign is separate
work. Final whole-agent comparisons must report actual thread count, configured
stack reservation, RSS and CPU. This implementation does not claim Tokio-equivalent
scheduling or a zero-dependency binary.

## Coordinates

- Checkout: `/Users/pbio/work/ziggy`; branch `feat/zig-agent-rewrite`.
- Rust baseline: `c5202242cc6569da4a858ed7ddbb34170ab696aa`.
- Plan commit: `43c65fc631`.
- Zig 0.15.2: `/tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig` on this host.
- SDK workaround: `HYPERLANE_ZIG_SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk`.
- User requested a draft PR with all benchmark results when work is done. No PR
  has been created. Use the write-like-paul skill for its final text.

## Evidence

See [results](results.md) and `zig/bench/results/` for raw samples and constraints.
The configured Rust default-feature agent build succeeded. Repeated protocol CPU
measurements show ReleaseSafe regressions and mostly small ReleaseFast wins;
there is no demonstrated large runtime or whole-agent speedup.

Intermediate native HTTP/component tests passed 206/206. Expanded native
RocksDB/validator/cursor tests passed 57/57, including latest-first publication,
authenticated local snapshots, publication recovery without another signature,
fixed quorum denominators, durable reorg halt and per-gap backfill recovery.
These source snapshots are not final-head acceptance gates. CCIP-read tests cover
ABI, authentication hash, request policy, pending retries and concurrent KMS
cache success/failure. The chunked prover checks 513 historical prefixes and
allocation-failure cleanup. Full operational scheduling is still being connected.

Real local Solidity integration delivered messages through message-ID multisig,
Merkle-root multisig, and routing/aggregation ISMs. Crash after transaction
reservation resumed with identical signed bytes; replay consumed no extra nonce.
Real production Rust RocksDB wrote a database, Zig read and changed it, and Rust
reopened/verified the typed values. PostgreSQL tests used the production migrations
in a disposable container. A bounded finalized Ethereum capture matched Rust
message encodings/IDs and insertion correlation.

Additional evidence (intermediate snapshots): native PostgreSQL deadline tests
passed 73 checks with one unrelated HTTP skip against PostgreSQL 16.15 and all 21
production migrations. A response-dropping COMMIT proxy proved the row committed
once while the client reported `CommitOutcomeUnknown`. Native validator integration
kept the configured 20-second deadline for a stalled first RPC and accepted a
healthy 2-of-3 quorum in 462 ms; the stalled slot remained in the denominator.
The supervisor never reuses a timed-out mutable client until its worker retires.

Remote checkpoint I/O uses native curl multi and immutable announcement-location
snapshots, including ordered fallback and mixed local/cloud quorums. Every selected
reorg guard completes before checkpoint data can satisfy quorum. Native origin
indexing, bounded legacy-index repair and high/low destination loading are being
connected to the relayer.

The EVM validator now has an actual native `validator` executable: matching
local-chain announcement submission, checkpoint signatures, SIGTERM drain and
restart readback passed. The native scraper process also indexed and enriched real Solidity events into PostgreSQL, remained live under stalled receipt RPCs, and resumed without duplicate events after restart. Other validator protocols and the complete relayer remain in progress; telemetry-enabled same-port restart is under final verification. Shared credential leases preserve
independent KMS and storage identities; local-key jobs perform no cloud discovery.
Aleo uses an isolated native proof/decoder process with explicit vetted SnarkVM
parameters and network denial; this is a counted protocol-library dependency.

Initial whole-validator samples are now in the benchmark artifacts. They are
not an idle-host final result. Native ReleaseSafe publishes sooner but increases
CPU/RSS/RPC counts; cached ReleaseFast improves RSS while CPU/RPC regressions
remain. The initial and optimized snapshots must both appear in the draft PR.

## Latest integration evidence

- Broad ReleaseSafe snapshot: 339 passed / 37 opt-in native skips. Separate operator/regex suite: 52 passed. These precede later edits and are not final-head checks.
- Actual scheduled origin worker: three local Solidity messages, native RocksDB, three historical proofs, two completed worker cycles.
- Native checkpoint fanout: 27 HTTP peers, nine stalled and 18 healthy; fixed 18-of-27 frontier within the unchanged 20-second deadline. Starknet original-ID rejection and separate before/after header-fence transfers also passed.
- Native transaction actor: full 512-bit identity recovery, CAS/Manual retry races, durable pre-broadcast signing, finalized-failure generation archival and canonical delivered markers tested against real RocksDB.
- Reorg/cancellation refusals now propagate through optional aggregation branches and serial checkpoint readers. Unpriced verification preserves source module order rather than inventing gas prices.
- A sustained read-only Ethereum/Rust comparison has started. No one-hour claim is valid until actual observation time accumulates.

## Current owners

| Owner                | Current write set                                                   | Work                                                                   |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Parent               | Integration, functional runners, final benchmarks and documentation | Full-source checks after all writers release; no timing acceptance yet |
| `runtime_recovery`   | Group coordinator, atomic operation transitions, recovery tests     | Safe grouped nonce retirement and all-delivered reservation cleanup    |
| `protocol_recovery`  | Starknet nonce proof, signed authority and announcement recovery    | Configured-finality proof and exact SDK-backed negative tests          |
| `baseline_recovery`  | Recovery evidence; independent proof review                         | Released cold-sender tests; review nonce and announcement boundaries   |
| External Kimi owners | Released harness, adapter, packaging and artifact slices            | Final images and exact-binary process acceptance await source freeze   |

Write sets are disjoint except explicitly coordinated narrow forwards. Earlier
Claude architecture material is an archived snapshot. Current Claude execution
could not start because its account reported insufficient credit. No current
Claude review is claimed. Older GLM/Kimi reports remain evidence for their tested
source snapshots, rather than final-source approvals.

## Remaining acceptance work

1. Complete broad default/native/PG/actual-role checks on the frozen source in
   ReleaseSafe, plus ReleaseFast default/native checks. Preserve focused recovery
   evidence and all failed diagnostic snapshots.
2. Run full default/native/PG/service checks on one stable source snapshot. Close
   current process harness proof findings; run actual final relayer3ISM/batch/crash,
   WS and public-sidecar fixtures with the600-second retirement policy.
3. Run final Linux core/SDK image runtime and exact-source CI checks. Retain both
   the validated portable commands and diagnostic failures.
4. Freeze all writers, secure measured cache/disk budgets and a quiet host. Run the
   prepared11-phase cold/no-change build matrix and final balanced whole-validator,
   scraper and relayer ReleaseSafe/ReleaseFast pairs. Retain regressions and actual
   physical RPC/CPU/RSS/cost/phase scope; no shortcuts around production finality.
5. Commit the frozen implementation with normal hooks before timed builds.
   Complete final source/dependency/LOC inventory, independent security/code
   review and artifact provenance; commit benchmark/documentation results,
   verify hashes after hooks, push and open the requested draft PR with tables
   covering every benchmark, failed attempts and limits.

## Source-supported ISM boundary

The current Rust metadata dispatcher supports standard message-ID/Merkle-root multisig, routing, aggregation, null, CCIP-read and Sealevel composite. Legacy3, Arb8, weighted9/10, OP11 and Polymer12 return `UnsupportedModuleType` in `rust/main/agents/relayer/src/msg/metadata/message_builder.rs:231`. Zig preserves that refusal. Independent legacy/weighted/Arb codec tests exercise repository SDK/Solidity layouts, but do not establish production builders or bridge finality support for those types. These source-unsupported variants are not missing parity gates.
