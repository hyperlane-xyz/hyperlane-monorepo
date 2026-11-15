# Execution status

The requested complete agent replacement is **in progress**. All three native
executables run against local Solidity/chain fixtures. Full process proofs exposed canonical admission and batch JSON lifetime bugs.
Both production fixes are committed and passed fresh builds and broad checks.
Final process and runtime performance acceptance remain open. No draft PR or production cutover has occurred.

## Current execution — 2026-11-07 20:34 UTC

The branch is pushed at `e4318cacd8`. Both SDK producer modes in the [general CI run](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42397667564) passed 1,153 tests with three explicit skips. The same run's helper, tools and two storage writers passed independent artifact, source, CPU and cleanup readback. The later validation changes leave their compiled-input trees unchanged.

All six standalone proof groups are accepted: recovery, WSS and public relay in ReleaseSafe and ReleaseFast. Safe public relay retains its completed V20 proof; the other five are fresh V21 runs. Exact counters, per-message 600-second retention, 30-second finality grace, original restart readiness, storage identity and clean parent waits passed. Public relay covers both indexed messages and private receipt-sidecar delivery without rebroadcast on restart. The eight role/worker products remain the accepted `3c545589de` bytes; the five test-only source differences remain separate from the other 602 unchanged build inputs.

The [first Linux Cosmos-native retry](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42404150984) exited successfully, but its final semantic proof was not exported. Review also found that the native restart check returned after readiness without enforcing a timed 30-second window. That run retains its execution result but receives no independently retained per-ID or timed-restart acceptance. The new code retains a public proof projection and requires fresh, matched successful requests from each restarted role and chain throughout the actual window. Four review findings were fixed; 280 local controls passed, two Linux-only controls were skipped, and workflow lint passed. The [fresh Cosmos-native Safe run](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42409469987) failed at 20:23 UTC after all six earlier composition phases succeeded. The harness returned 101; cleanup completed without forced process termination or owned leftovers. Its inner verifier reason was not exported, so the failure remains unclassified. Safe structured failure diagnostics are being added before another retry. The response-age bound has also been tightened and independently reviewed; no current full native proof is accepted.

The [replacement SVM prerequisite run](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42403077042) passed. Independent readback checked the complete 85-file Agave closure, all 15 products and all 31 successful command waits. Its 27 stack-offset warnings remain recorded. This is component evidence; actual SVM VM execution remains pending. Starknet fixture admission is committed. SVM, Tron, Radix and Aleo Linux case integration remains in progress; Radix release payloads and all five image metadata chains have been checked without starting those fixtures.

All three Linux cold trials remain qualified at `dfc74532d4`. Metadata for the original ten paired runtime workloads and five alternating pairs is prepared, with both mode provenance files bound to the six accepted proofs. No current paired timing main has run. Native validation, final source and quiet-host checks still gate timing acceptance. Five Rust runtime libraries and seven native archives remain explicit dependencies. No draft PR or production cutover has occurred.

## Earlier execution — 2026-11-07 18:31 UTC

The feature branch is pushed at `803b64ea53`. The [current general CI run at `31ab16a906`](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42397667564) passed all four unit jobs, native HTTP/Linux, EVM integration, helper compilation/Clippy, Safe SDK and both VM-image checks. Fast SDK remains pending; producer acceptance requires both modes from the same run. The intervening pushes isolate SVM prerequisites and preserve those running jobs.

The native HTTP suite and its corrected diagnostic passed separately. The earlier 120-second aggregation failure remains historical and unclassified. The CCS allocation failure was identified as `NondeterministicMemoryUsage`; its test now uses the existing deterministic backing-allocator pattern while retaining the full constructor/lease sweep. The fresh Linux suite passed. The earlier hosted Mac Fast worker fixture failure did not recur; failure-only diagnostics preserve its original limits and assertions.

SVM reached a successful first program compilation. Its SDK now has the exact Criterion dependency/version markers before offline compilation. Actual output uses SBF machine 263, which the checksum-pinned Agave loader accepts alongside 247. The artifact check now distinguishes that SBF family from native CLI machine 62. [The isolated replacement run](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42400044013) passed. Independent readback checked all 15 products: nine built SBF programs, four publisher programs and two native CLIs. All 31 commands waited successfully with source, lock, offline-build and cleanup checks. Compiler stack-offset warnings remain recorded; no native VM or full SVM case is accepted. The helper still needs an explicit Linux bundle branch alongside its existing Darwin policy.

The new standalone plan carries only the completed Safe public-relay proof and starts five fresh proofs. Safe recovery passed three-ISM, batch-four and durable WAL replay checks with the original 600-second confirmation and 30-second grace. Independent readback verified exact counters, restart nonce stability, all parent stops and owned-process absence. The fresh Safe WSS proof is running; both Fast process proofs and Fast public relay remain pending. All 1,132 common inputs, 108 matrix products and per-entry inputs were independently rehashed. All eight runtime products remain the accepted `3c545589de` bytes; five later test-only source changes are qualified separately from the other 602 unchanged build inputs. No new runtime build or current 22-check acceptance is inferred.

EVM/Cosmos-native artifact hydration, setup and owned execution code is committed, with focused host/Linux controls and independent review. No current full native-chain case has started. The official Linux Cosmos-Wasm CLIs are static. The corrected prerequisite code passed independent review and 80 focused controls, then was committed with normal hooks. It stages the exact closed Wasm bundle without unused loader/library dependencies. Actual CLI compatibility and full-case execution remain pending. Further family admission remains in progress.

All three Linux cold-build trials completed at `dfc74532d4` and passed independent accounting and artifact checks. Final timing acceptance, all matched runtime measurements and the draft PR remain pending. Five Rust runtime libraries and seven native archives remain explicit dependencies. No production cutover has occurred.

## Earlier execution — 2026-11-07 17:09 UTC

The feature branch is pushed at `e7b8230d9c`. This push isolates SVM prerequisite checks. Its exact custom SPL source declares two dependencies missing from the upstream lock; a pinned overlay adds only those packages and two CLI dependency edges. The original lock and source tree remain recorded separately. Locked fetch and frozen/offline compilation remain required. The overlay has not yet passed CI compilation or native-case admission.

The preceding [CI run at `062eeda56a`](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42389993601) passed all four unit jobs, EVM integration and the native HTTP/Linux jobs. The previously failing HTTP pool test passed on this run; its targeted diagnostic still requires readback. Helper, SDK and container jobs failed and are being diagnosed. No complete producer cohort is accepted.

All three [Linux cold-build trials](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42375234506) completed and passed independent phase, source/product, process and cleanup checks. Their source remains `dfc74532d4`. Final timing acceptance and comparison tables remain pending current correctness qualification and matched runtime measurements.

The fresh ReleaseSafe public-relay proof passed both indexed and sidecar cases, strict per-message 600-second confirmation, 30-second finality grace and restart checks. All actual parent waits returned zero; no observed owned process or group remained. One of six fresh standalone proofs is accepted. The other five need a new plan because subsequent SDK-wrapper files changed; earlier process/WSS passes retain their original source scope. All eight runtime products remain the accepted `3c545589de` bytes. No production source was changed by the recent CI fixes.

Linux native-case setup and artifact hydration are still being integrated. Setup review and small Linux supervision controls passed; full native-chain execution and dual-mode storage interoperability remain pending. Five Rust runtime libraries and seven native archives remain explicit dependencies. No draft PR or production cutover has occurred.

## Earlier execution — 2026-11-07 15:17 UTC

The feature branch is pushed at `1ef6154a36`. The [replacement CI workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42385575577) is running SDK, helper, native HTTP/Linux and SVM prerequisite checks. The preceding `b55d756f2e` run failed setup and helper compilation; its failures remain preserved. The fixes stage the offline Cargo metadata dependencies and correct Bridge contracts, give the whole HTTP suite an explicit budget, repair the helper compile errors, and omit only two exact unusable debugger links from the checksum-pinned SVM publisher archive. Default archive checks and individual RPC deadlines remain strict. No replacement CI or native payload acceptance is claimed yet.

The separate [cold-build workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42375234506) remains at `dfc74532d4`. Two trials passed independent phase accounting, source/product and cleanup readback; the third is running. Final build comparison remains pending the third trial and the remaining correctness gates.

The failed Safe public-relay proof exposed a fixture assumption: the admin queue can contain identical public/indexed references to one message. A bounded diagnostic reproduced three rows for two delivered IDs. Rust also permits independent queue references. The public observer now permits at most two identical complete rows for the one admitted ID, retaining every raw response. Generic observers still reject duplicates; exact counters, per-ID 600-second confirmation, transaction identity and restart checks remain unchanged. Independent review closed and all 40 focused controls passed.

Because the shared HTTP observer bytes changed, all six standalone proofs are fresh under the new plan. Safe public relay is running first; none of the six fresh proofs has completed. The earlier Safe process and WSS passes remain historical evidence. All eight runtime products remain the accepted `3c545589de` bytes; the current 607-file map has three test-only differences from that build and 604 unchanged other leaves. Historical build/22-check evidence is not relabelled as a new run.

The earlier Cosmos-Wasm Safe native pass retains its original helper and source scope. Current CI-backed native cases, matched runtime measurements and the draft PR remain pending. The Linux native case launcher and artifact hydration are still being validated; an unapproved case request starts no node or payload download. Five Rust runtime libraries and seven native archives remain explicit dependencies. No production cutover has occurred.

## Earlier execution — 2026-11-07 14:43 UTC

The feature branch is pushed at `b55d756f2e`. The [current CI workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42381958336) is running full SDK, native HTTP, helper and SVM prerequisite checks. SVM prerequisites were selected explicitly by the feature-push marker. Workflow dispatch requires the workflow on the default branch, where this workflow is not yet present. The [separate cold-build workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42375234506) remains active at its original `dfc74532d4` source. Its first trial passed independent phase accounting and artifact readback; two further trials remain pending. One trial does not establish a final build comparison.

Two of six standalone proofs passed: ReleaseSafe relayer recovery and ReleaseSafe WebSocket replay/restart. Actual parent waits returned zero; strict acceptance retained the three ISMs, four-message batch, WAL crash/recovery, 600-second confirmation and 30-second finality grace. The WebSocket proof also retained heartbeat/pong liveness and the no-event-RPC requirement. No observed owned process or group remained. The ReleaseSafe public-relay proof failed early on a duplicate admin operation ID. Its actual parent wait returned one; no observed owned process or group remained. A separate bounded diagnostic reproduced three rows for two delivered IDs, with the duplicate rows exactly equal. Rust also permits overlapping public/indexed queue references. A scoped fixture correction is being prepared; the failed proof receives no acceptance. The sequence stopped; the three ReleaseFast proofs remain pending.

The Cosmos-Wasm ReleaseSafe native case passed four deliveries, production-duration retirement and same-database restart. All eight agent waits and three fixture waits returned zero; no owned descendant, listener or container remained. Its compiled helper has its original source snapshot. Subsequent helper changes are awaiting current CI compilation and do not receive that case's acceptance.

All eight runtime role/worker products remain byte-identical to the accepted `3c545589de` builds. The current conservative 607-file source map differs at three test-only leaves; the other 604 leaves are unchanged. Historical eight-build/22-check evidence retains its original source. The two accepted standalone proofs are carried through exact executed-input checks and explicitly bounded test/CI changes; this grants no fresh build, current SDK or broad correctness credit. Four remaining standalone proofs use a new frozen plan.

Current CI, the remaining native matrix, four standalone proofs and matched runtime measurements remain open. Linux case preparation will bind the actual SDK/helper artifact producer commits separately from later harness-only changes, checking that their compiled inputs are unchanged. Five Rust runtime libraries and seven native archives remain explicit dependencies. No draft PR or production cutover has occurred.

## Earlier execution — 2026-11-07 12:36 UTC

The feature branch is pushed at `43e6466ca0`. The [first accepted CI workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42370463543) is running its first full-feature cold trial; two further trials remain queued. No new cold-build measurement is accepted yet. EVM integration passed. The other completed jobs exposed three clean-checkout issues: a raw JSON fixture absent from Git, an optional-transport skip asserted as an injected error, and the SDK selected by `macos-latest`. Their fixes are pushed; the [replacement workflow](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/42371878623) waits behind the original trials. The first push also exposed an invalid workflow expression; that rejected run started no jobs.

The corrected restart-scenario fixture reached subscription readiness and completed the two tracked messages' 600-second retirement checks, then failed its strict no-RPC-polling assertion. The fixture omitted the publisher's 30-second ping/application heartbeat, so the unchanged 75-second production read timeout correctly triggered fallback. The fixture now reproduces that heartbeat and pong liveness. All 21 focused controls passed; the seven new controls fail against the old fixture. A fresh Safe WSS proof is running. No complete standalone proof has been accepted for the current runtime.

The eight existing runtime products remain byte-identical to the accepted `3c545589de` builds. The conservative 607-file build snapshot now differs at exactly one test leaf: four inserted lines preflight the optional native library before testing the injected failure. That test passes with native Curl and skips correctly without it. The old eight-build/22-check records retain their original snapshots; this bounded test-only reuse is not a new build or global correctness run. The current 754-file fixture snapshot records five proof-related changes and two excluded native Aleo test changes separately.

Native SVM/composite, Tron, Starknet and Radix fixture lifecycle changes are being integrated for CI compilation and controls. The Cosmos-Wasm read-only preflight passed; no new native case has started. All six fresh standalone proofs, current native cases, matched runtime measurements and final draft PR remain open. Five Rust runtime libraries and seven native archives remain explicit dependencies.

## Earlier acceptance snapshot — 2026-11-07 10:35 UTC

The corrected WSS fixture cleared legacy replay and the six fault fallbacks,
then exposed a production gas-stream bootstrap defect. Fresh Zig subscriptions
omitted `afterStreamCursor`; the real proxy interprets omission as tailing existing
history. Its nonzero caught-up marker then correctly failed the skipped-history
guard. Rust explicitly requests cursor zero. A short owned diagnostic confirmed
the omitted requests, zero gas event frames, nonzero marker and revoked authority.
Its actual parent wait and cleanup completed. The fix was committed normally at
`3c545589de`. The new regression failed against the old implementation with
`expected 0, found null`, then passed with the fix in both ReleaseSafe and
ReleaseFast. The wire/allocation checks passed in both modes. Root independently
rechecked all four changed inputs and 22,313 other protected paths; all 62 observed
owned process identities were absent. Filtered controller runs contained two
substantive new tests and 45 anonymous import tests, not 47 distinct regressions.
The strict guard and confirmation windows remain unchanged.

Fresh builds produced all eight role/worker artifacts in both modes. Actual
compiler waits returned zero; independent readback verified the eight products,
607 committed inputs, 752 physical inputs, 112 preserved products, five Rust
libraries and seven native archives. Observed owned identities/groups were absent.
The first attempt passed Safe, then stopped before Fast on a shared-host compiler
conflict guard. Its raw failure remains preserved. The corrected correctness
owner records foreign jobs as covariates and retains resource/source checks;
these builds receive no quiet-host or timing credit.

All 22 broad correctness phases passed in both modes, including the actual
native bridge fixture missing from the preceding 20-command matrix. Independent
readback checked source, artifacts, logs, PostgreSQL mounts and cleanup. All 206
observed process identities and both owned PostgreSQL containers were absent.
Native/database roots reported 1,155 passes and one documented opt-in skip per
mode; counts across roots overlap.

The fresh ReleaseSafe WSS proof passed the previously failing v3 live-delivery
stage, the healthy-neighbor check and restart message delivery. It then timed out
waiting for restart subscriptions. Its actual parent wait returned one; cleanup
left no observed owned process or group. A fresh bounded diagnostic captured the
fixture race: a transport closed before subscribing and consumed logical restart
slot 9. The next transport subscribed, replayed and reported active, authoritative,
fresh WebSocket state for all three chains, while the check kept waiting on slot 9.
The original timeout remained a failure; diagnostic cleanup and input checks passed.
A scoped fixture correction is being prepared. The fixture also contains a stale
assertion that expects an omitted fresh gas
cursor; that assertion was not reached. No confirmation-window requirement has
been relaxed.

No complete native case, standalone proof or paired benchmark has been accepted
for `3c545589de`. Existing `57710ae024` results below retain their original source.

## Prior candidate evidence — `57710ae024`

Production `57710ae024` passed all 20 fresh correctness commands in both modes.
Independent readback verified 607 committed build inputs, 752 physical inputs,
all products and dependencies, actual PostgreSQL tmpfs mounts and absence of all
195 observed process identities. Native/database tests reported 1,153 passes and
one documented opt-in skip per mode. Counts across roots overlap.

Those 20 commands retain their original 752-file snapshot. Five subsequent
fixture changes corrected WSS scenario sequencing and the Cosmos-Wasm expected
dead-peer observer. Eight fresh Python commands passed, including seven new
peer-policy controls; 13 fixture pins and 16,673 preserved products were checked
independently. All 607 production inputs and 1,429 Rust-helper inputs remain
unchanged. The new fixture checks grant no native or confirmation acceptance.

The EVM/Cosmos-Wasm fixture helper passed compilation, 64 ownership controls,
four program tests, three Cosmos configuration tests, normal build and Clippy.
Its first attempt failed Clippy because a helper followed a test module. Moving
that unchanged function before the tests fixed the lint; the failed record is
retained. Both helper binaries have been published locally and independently
rechecked.

The preceding Cosmos-native attempt stopped when a short-lived process disappeared
between supervisor process reads. Cleanup completed; accepted inputs stayed
unchanged. A scoped observer correction passed 12 controls. The fresh case passed:
eight messages, canonical delivery transactions, native signatures, SQL rows,
full confirmation windows and same-database restart. All eight agent waits and
three fixture waits returned zero; no owned descendant, listener or container
remained. Independent Root readback rechecked all 607 production and 1,429 helper
source inputs. This is correctness evidence, not a performance measurement.

The first complete standalone ReleaseSafe recovery proof passed: three ISMs,
600-second confirmation, stopped-storage/receipt checks, four-message prepared
batch replay, an injected pre-enqueue WAL crash, and recovery/restart without
duplicate submission. Root rechecked the existing strict process acceptance
branch, exact binary and captured inputs; all 14 observed owned process identities
were absent. The WSS proof subsequently timed out waiting for legacy stream
replay. A bounded diagnostic confirmed that physical session zero had closed
before subscription, while later fault scenarios advanced. Its processes stopped
cleanly. The fixture correction passed its focused mocked-handler controls. The
full rerun subsequently exposed the separate production bootstrap defect above;
it grants no complete WSS proof credit.

The first Cosmos-Wasm attempt delivered four native transactions but became
ineligible when the observer latched connection refusals from the Rust fixture's
deliberately nonexistent first gRPC peer. Both healthy peers and admin sampling
were responding. Root stopped the owned case; child joins, source checks and
resource cleanup completed. The endpoint-specific correction and fresh-response
requirement after restart passed focused controls. A fresh Cosmos-Wasm rerun is
being prepared. This failed attempt grants no native confirmation or restart
credit. The bounded Tron CLI prerequisite stopped before its package-manager
child started; a narrower store policy is prepared but has not executed.
No runtime benchmark has started.

Acceptance for `57710ae024`: full native cases 1 (Cosmos-native/ReleaseSafe);
complete standalone production-duration proofs 1 of 6; final paired workloads 0.
The draft PR remains pending completion of the replacement candidate.

## Previous acceptance snapshot — 2026-11-07 06:16 UTC

Production commit `57710ae024` fixed shared announcement replay ownership.
Parallel metadata discovery and origin maintenance could advance or reset the
same retained RPC journal. A registry progression guard now spans final cleanup;
cancelled or expired results cannot install. Five new producer-path regressions
and three existing cache/reorg/allocation controls passed in both modes.
Independent review closed, and normal commit hooks passed.

Both fresh compiler phases exited zero. Their supervisor failed its final global
idle check after briefly observing five additional Zig processes. The original
failure is retained; independent postflight checks verified all eight binaries,
607 committed inputs and 99 preserved products. A separate qualified artifact
acceptance records those facts without granting quiet-host or performance credit.
The first correctness command passed all 757 default ReleaseSafe tests. The
supervisor then stopped at the same global idle check after observing another
Zig process; its raw failure is retained. Source/product checks passed and no
owned child remained. The replacement correctness supervisor will record
unowned processes without treating global quiet as a correctness requirement.
All owned-process, resource, source and product checks remain mandatory.
The corrected suite is running; its first ReleaseSafe default check passed.
The complete 20 checks and replacement native/process proofs remain pending.
The preceding standalone attempt
passed its initial confirmation, stopped-storage and receipt stages, then exposed
the batch-preparation race. Its full proof failed. The Cosmos-native pass below
remains evidence for its original `d51ca8d668` products.

Current `57710ae024` acceptance: full native cases 0; complete standalone
production-duration proofs 0; final paired workloads 0. The draft PR remains
pending completion.

## Previous acceptance snapshot — 2026-11-07 05:17 UTC

The sixth Cosmos-native ReleaseSafe case passed. Eight messages and their eight
canonical delivery transactions passed live confirmation, stopped-storage and
same-database restart checks. Observed retirement ages were 600.52–600.85 seconds,
with per-domain request/response intervals retained. Eight agent parent waits and
three fixture parent waits returned zero. The supervisor joined with exit zero;
no owned descendant, listener or container remained. This is native correctness
acceptance, not a throughput measurement.

The first standalone ReleaseSafe recovery proof is running. Its previous attempt
stopped before launching an agent because the private launcher compared the URL
library's original path with an identical fixture-cache copy. The corrected
launcher verifies the selected library's bytes, records its path and rechecks it
at close. Eleven focused controls passed. Production inputs and products remain
unchanged. EVM and Cosmos-Wasm fixture work is next.

Full native cases: 1 (Cosmos-native/ReleaseSafe); complete standalone
production-duration proofs: 0; final paired workloads: 0. The draft PR remains
pending completion.

## Previous acceptance snapshot — 2026-11-07 05:03 UTC

The replacement observer is frozen. Shared Python passed 88 controls; the Aleo
driver passed 50 plus type, lint and format checks; standalone retirement passed
22 controls with warnings treated as errors. Independent review and readback
verified the exact six fixture changes and unchanged 605 production build inputs.
Each tracked message retains its own first observed retirement and deadline;
metrics timeouts cannot discard decoded admin evidence or hide reappearance.

The local Cosmos-Wasm/Starknet artifact hooks passed compilation, 59 ownership
controls, four program tests, one compatibility test, normal build and Clippy.
The compiled helper also validated both published contract bundles and rejected
eight modified-bundle cases. This grants fixture validation, not native-chain
acceptance. The fresh sixth Cosmos-native case is running with the corrected
fixtures. Production products and historical correctness gates are reused
with the fixture changes identified explicitly.

Full native cases: 0; complete production-duration proofs: 0; final paired
workloads: 0. The draft PR remains pending completion.

## Previous acceptance snapshot — 2026-11-07 03:50 UTC

The fifth Cosmos-native attempt committed eight relayer transactions and reached
checkpoint 3 on both validators. Its observer then timed out fetching admin
operations. The next successful fetch exceeded the strict two-second sampling
bound, permanently invalidating that attempt's hold proof. Root stopped the run;
all direct children joined, accepted inputs stayed unchanged, and no owned
descendant, listener or container remained. This attempt grants no 600-second or
restart acceptance. The timeout's cause remains under investigation.

The scoped EOF helper correction passed compilation, 49 ownership controls,
four program tests, normal build and Clippy. Independent Source review found
that the observer's two-second assumption conflicts with the admin API's
five-second HTTP and ten-second command deadlines. The replacement observer
will use an explicit ten-second coverage cap, parallel reads and per-domain
request/receive timestamps. It must retain the 600–630-second observed retirement
checks and report polling uncertainty; polling cannot prove the exact deletion
instant. The fifth failed run will not receive retrospective credit.
The fourth run's initial stage remains historical evidence under the old
sampler. Its recorded ages used round completion times without retained
per-domain intervals; it is not accepted under the replacement policy.
Independent design review also cleared the
local Cosmos-Wasm/Starknet fixture artifact hooks and Wasm-only compatibility
setting. Those fixture changes require implementation and focused validation.

Production `d51ca8d668`, its eight products and all 20 correctness checks remain
unchanged. The affected native observer and Rust fixture paths are outside its
605 build inputs; future fixture validation will retain the old source snapshot
and identify the new fixture changes explicitly.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 03:38 UTC

The fourth Cosmos-native run passed its initial live and stopped-storage proofs.
Each of the eight messages was observed through an actual 600.51–600.76-second
retirement window. Both validators reached checkpoint 3, all eight relayer
transactions committed successfully, and all four initial roles stopped with
clean parent waits before the same-DB readback.

The full case failed at restart because of a Rust harness deadlock. After starting
the first replacement validator, the helper joined the old stdout reader. That
reader kept polling EOF while the global log flag stayed true; the flag only
clears during final teardown. The remaining three roles were never restarted.
This is outside the production Zig runtime.

Root stopped the owned supervisor after preserving the evidence. The actual
supervisor session joined with exit 1; all its direct children joined, all owned
descendants, listeners and the container were absent, and accepted inputs stayed
unchanged. Cleanup was not forced. Nonchild signalling received no parent-wait
credit. The initial 600-second proof is retained as partial evidence; the full
native case and restart proof remain unaccepted.

A scoped helper fix passed all five cached Cargo checks: 49 existing controls,
four program tests, normal executable build and package Clippy. Independent
readback verified 1,429 source inputs, preserved artifacts, all five logs and both
copied executables against Cargo's actual outputs. Production commit `d51ca8d668`,
its eight built products and its accepted 20 checks remain unchanged. The next
native attempt will use the corrected helper and fresh state.

The exact Osmosis source, 318-module graph and offline macOS build passed their
respective checks. Its CLI reported the expected version and commit, loaded the
pinned VM library, and all 20 acquired WASM contracts matched the bundled release
checksums. Node initialization, deployment and the other VM cases remain open.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 03:12 UTC

Commit `d51ca8d668` passed fresh validator, relayer, scraper and matching worker
builds in both modes, followed by all 20 correctness checks. Independent readback
verified 605 selected build inputs, 748 physical inputs, 89 preserved artifacts
and eight new products. Each mode passed default 757, native 1,146 plus the one
named exclusion, PostgreSQL 446 with 21 migrations and 11 persistence cases,
the actual scraper, RPC 416, regex 56, WS/TLS 22, socket four and all role helps.
Counts overlap across roots.

The fourth real Cosmos-native case is running with fresh state. Both validators
processed checkpoint 3. Eight distinct relayer transactions committed with
successful CheckTx and execution results, and all eight appear in successful
transaction queries and positive witnesses. Four operations per chain are in
self-submitted confirmation. Fourteen initial sequence-mismatch rejections
recovered; retries and failed-phase metrics stayed flat afterward. These are
correctness observations, not matched performance results.

The prior first-broadcast blocker is cleared. Canonical receipts, fees, the
required 600-second confirmation period, storage and same-DB restart proof remain
pending. No native case or production-duration proof is accepted yet.

The pinned Osmosis source and all 318 module versions are acquired and verified;
its offline macOS build is the only newly authorized SDK compiler stage. The
remaining native families and all final performance comparisons remain open.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 02:29 UTC

The configured RPC corrections are committed in `d51ca8d668`. Normal commit
hooks passed. The main native aggregate now includes both regression roots.

On the same frozen pool source, Cosmos passed 18/18 and Sealevel passed 16/16
in both modes, with zero skips or leaks. These roots contain seven and twelve
substantive controls respectively; their import tests overlap. Independent
readback verified all eight component source copies, four logs and 91 preserved
products and dependencies. Independent source review found no blocking issue.

Sealevel retains one quota-charged original unavailable-block response until
retry exhaustion. Every configured provider must have been attempted, a later
healthy response wins, and mixed rate, transport or health failures remain
errors. Cancellation, deadlines, quorum and allocation failures retain their
existing failure behavior. The induced allocation-failure test confirms the
saved response is freed after the pool joins.

Fresh role/worker builds and the full 20 correctness gates for this commit are
pending. The fourth Cosmos-native case requires those new products and gates;
it has not started. Earlier attempts and benchmark tables remain historical.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 02:05 UTC

All 20 corrected `ac86e352a4` checks passed in both modes, with raw logs,
source/product hashes and actual process joins independently verified. Each
mode passed default 757, native 1,125 plus one named opt-in exclusion, and
PostgreSQL 446 tests with 21 migrations, 11 persistence cases and the actual
scraper process. Counts overlap across roots.

The third real Cosmos-native run exposed a transport integration gap. Both
validators announced successfully and advanced their checkpoint metrics to 3;
the scraper remained healthy. Eight relayer operations reached `ReadyToSubmit`
but never broadcast. The configured RPC pool retried and discarded the exact
hash-bound transaction-not-found response before the Cosmos client's new
absence handler could inspect it. Direct-client tests had not covered this
configured transport path.

The run was deliberately stopped after retaining wire, metrics and read-only
queue evidence. All direct supervisor children joined, no owned processes,
listeners or container remained, and all accepted inputs stayed unchanged. No
native case or 600-second hold was accepted.

A configured-pool regression reproduces `AllRpcProvidersFailed` before the
Cosmos fix. The correction passed 18 tests in each mode, including actual
destination reconciliation, strict transaction reads, provider circuit behavior
and shared metadata read replay. These are component results; the production
products have not been rebuilt for this correction.

A separate review found the same envelope-loss issue in Sealevel's skipped or
pruned block handling. Its configured scraper regression also fails before the
fix. The correction retains a known error only after retries exhaust and every
provider has been attempted; a later healthy provider still wins, and mixed
transport or health failures remain errors. Its focused tests are running.
Production acceptance is reopened.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 01:31 UTC

The corrected `ac86e352a4` products passed all ten ReleaseSafe checks: default
757 tests; native 1,125 passed plus one explicitly opt-in exclusion; PostgreSQL
migrations and the actual scraper process; role help and RPC/regex/WS/socket
checks. Counts overlap across roots. ReleaseFast is still running; the complete
20-gate acceptance remains pending.

The external Rust harness passed compilation, all 49 focused controls, the
normal helper build and package Clippy. Actual Node child/descendant shutdown
and retained checkpoint controls passed. All 1,429 Rust inputs and 16,082
preserved product/artifact paths remained unchanged. This is harness correctness
evidence, with no completed native-chain or 600-second credit.

An earlier correctness attempt was deliberately stopped after one successful
Safe default suite: its reused PostgreSQL wrapper accepted only the old run
path. A negative control reproduced that rejection before any Docker action.
The corrected private wrapper now runs the real bounded PostgreSQL fixture.
That interrupted attempt remains preserved and contributes no checks to the
fresh 20-gate run.

The fresh Cosmos-native case is prepared for the corrected products and helper.
Execution awaits the complete current checks and fresh capacity readback. Aleo
launch preparation and the other native families remain open.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 00:59 UTC

Both Cosmos corrections are committed in `ac86e352a4`: omitted compatibility
now selects 0.38, and reconciliation accepts only the node's exact not-found
response for the expected transaction hash. Other RPC errors still propagate.
The frozen component tests passed in both modes: compatibility 7/7 and
transaction reconciliation 14/14, with no skipped tests.

Fresh ReleaseSafe and ReleaseFast builds passed for validator, relayer, scraper
and the matching Aleo worker. Independent readback verified 600 selected source
inputs, 81 preserved products and all eight new products. These reused existing
dependencies; their elapsed time is operational telemetry, not a cold-build
benchmark. The corrected products still require the fresh 20-gate correctness
run and new native cases.

The EVM helper ownership/checkpoint changes are under review before focused
Cargo checks. Aleo's static launch recipe is being refreshed to the corrected
products; actual proving remains pending. The two earlier Cosmos-native
attempts remain failed evidence and grant no completed hold or case acceptance.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 00:34 UTC

Production acceptance is reopened after the second real Cosmos-native attempt.
The indexed endpoint correction passed 98 Python and 38 Rust controls, including
Rust's actual settings loader. All four roles then started. Native wire evidence
exposed two runtime blockers: omitted Cosmos compatibility selected 0.37 instead
of Rust's default 0.38, and reconciliation propagated the node's exact signed
transaction-not-found response before the first broadcast.

The announcement transactions committed successfully; parsing their `tx_result`
response failed under the wrong dialect. The relayer repeatedly queried newly
signed transaction hashes without broadcasting them. Both corrections are in
progress, with the compatibility default and transaction-absence handling owned
separately. Strict transaction hash, receipt and unrelated RPC error validation
will remain required.

Root interrupted the attempt after retaining the evidence. The supervisor joined
its children and verified no owned process, listener or container remained; all
accepted inputs stayed unchanged. The attempt grants no completed 600-second
hold or native-case acceptance. The 20 successful combined checks remain
historical evidence for `f665e447ee`; corrected products need fresh validation.

The isolated EVM contract and dependency builds completed across three preserved
attempts. No EVM node or deployment ran. Aleo's 42 closed-cache, resource and
cleanup controls passed, and its static launch inputs are prepared. Real Aleo
proving and agent execution remain pending; its old runtime pins require refresh
after the production corrections.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 00:20 UTC

The first full Cosmos-native attempt started two real local nodes, deployed
contracts and started the four Zig role processes. Node/listener ownership and
PostgreSQL 14's actual bounded tmpfs passed. All four roles then rejected
whole-array RPC environment overrides with `InvalidConfigArray`; no confirmation
hold or full-case acceptance completed. Rust's loader rejects the same encoding,
so this is a harness defect. The correction will use supported indexed endpoint
overrides while preserving each endpoint's public metadata.

The attempt is retained unchanged. Actual role exit receipts and the outer
supervisor show all owned processes, listeners and the container stopped. No
forced cleanup or unrelated resource action occurred. The preceding helper epoch
passed 35 controls, including a real owned TCP/listener lookup, plus build and
package Clippy. Production Zig commit `f665e447ee` remains unchanged.

Isolated EVM prerequisites now include 22 workspace packages and all ten pinned
Solidity dependencies. Core compilation succeeded; the remaining SDK build
closure is still in progress. Aleo's closed-cache and cleanup controls remain
component evidence; real proving and the full Aleo case have not run.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-07 00:02 UTC

Production commit `f665e447ee` and its 20 combined correctness gates remain
unchanged. The pinned Cosmos-native node binary passed 14 actual version,
help, public fixture identity and sandbox-denial checks. Its internal version
is `nightly`; the embedded commit matches the official `v1.0.0` release tag.
These checks started no node or transaction.

The external Rust coordinator now validates the local PostgreSQL 14 tag and
runs its approved immutable image ID without pulling. Its external-only path
binds loopback, resource limits and a fresh ownership token; the default Rust
path remains unchanged. Helper compilation, all 28 focused controls, normal
helper build and package Clippy passed. Native listener ownership before
readiness and the final bounded supervisor remain launch prerequisites.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-06 23:27 UTC

All 20 combined correctness gates passed on production commit `f665e447ee`.
Each mode passed default 752, native 1116 plus one explicitly opt-in exclusion,
and PostgreSQL 441 tests with 21 production migrations, 11 persistence cases and
the actual new scraper process. Both modes passed role help and RPC/regex/WS/
socket checks; all 41 required regression cases ran successfully. These counts
include overlapping imports and must not be summed as unique tests.

The rollup retains four attempts: successful suites survived a temporary-file
monitor race, a Docker tmpfs inspect-representation assumption, and a global-idle
pause caused by unrelated Tollkeeper work. That work was untouched and its
concurrency is recorded for correctness only. All 739 physical inputs, 597 selected build
inputs and 72 products remained unchanged. No timed benchmark inherits that
concurrency qualification. See [combined correctness evidence](combined-production-correctness.md).

The testnet parameter prerequisite is complete: nine files, 79,506,114 bytes,
including the correct fee key; the original mainnet bundle remains unchanged.
An actual metadata-only SDK probe confirmed its fee key matches. This does not
establish a complete circuit/proving cache. A Cosmos-native case manifest is
staged; its exact node binary is acquired and statically verified. Sandbox tool
checks, manifest admission and real native execution remain next.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous acceptance snapshot — 2026-11-06 22:51 UTC

Fresh combined `f665e447ee` builds passed in ReleaseSafe and ReleaseFast:
three agents and one matching Aleo worker per mode. All 597 pinned production,
wrapper and embedded-input files and 64 preserved products stayed unchanged.
Root independently rehashed both logs and all eight new products. These are
correctness builds with reused compiler inputs, not cold-build benchmarks.
Full functional gates remain pending.

The required PostgreSQL 14 arm64 image is now available at its immutable
manifest. Acquisition started no database or agent. Existing PostgreSQL 16
remains the separate generic persistence-test image. The Aleo prerequisite
helper now selects universal powers from mainnet and fee parameters from the
requested network; 9 offline controls passed. Its exact testnet fee asset is
being provisioned into a new owned directory, preserving the original mainnet
bundle. This does not establish a complete proof-parameter set.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 22:38 UTC

All five later production fixes are frozen in commit `f665e447ee`. Normal
secret checks, formatter and both Rust formatting hooks passed. Fresh combined
Safe/Fast role/worker builds and complete functional gates are next; this commit
alone does not grant runtime or performance acceptance.

The pinned Aleo image passed its Leo version check and a standalone devnode
startup check in an isolated, capped container. The actual startup marker was
observed while it was running; the exact owned container was stopped and removed.
This did not deploy SDK programs, prove transactions or run agents. See
[Aleo startup prerequisites](aleo-native-prerequisites.md).

The shared verifier's previous SQL/payer/finality corrections are independently
reviewed. Its new Radix-only cost contract passed68pure controls; authenticated
Radix receipt binding remains under adapter review. The final Starknet verifier
passed22pure controls, and the current u64 SQL-index helper passed2SQL and16Cosmos
controls. Aleo's preflight correction passed38pure/dummy controls and checked the
actual reader descriptor plus24922SDK files before import. These scoped packets
remain separate from real native cases.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 22:15 UTC

A fifth production gap is now component-fixed: Sealevel scraper advanced
dispatch/delivery metadata retained log_index0 instead of the authenticated
stream sequence. The actual old-code regression failed; both modes now pass5
focused checks (3 substantive,2 imports), with independent review. Basic
fallback and gas-payment positions are unchanged. See
[writer evidence](svm-scraper-log-index.md).

The updated Rust coordinator passed23 focused controls, construction/helper
compilation and package Clippy. Its task-owned Starknet names preserve default
Rust behavior. Current shared verifier corrections passed63 controls,4 SQL
predicate controls and11 Sealevel controls; independent followup is in progress.
They cover native SQL coordinates, independent EVM payer authority, configured
EVM finality, explorer metadata, zero-leaf validator publications and restart
process epochs. These remain verifier/component results, not native cases.

The Radix reference passed5 actual SDK-backed tests, compilation, Clippy and19
CLI/original-mode controls. Independent adapter review found two integration
gaps in restart capture handling and SQL coordinates; those corrections remain
open. The compiler/tool evidence is retained separately from Python changes.

The pinned Aleo node image was acquired and its Leo version ran in a capped,
network-isolated container. The container was removed; no devnode, proving or
agent process started. Actual per-case dependencies remain incomplete, including
the required SVM toolchain/program builds and Tron TypeScript CLI.

Full native cases:0; complete production-duration proofs:0; final paired
workloads:0. Fresh combined runtime builds, images, native cases and matched
measurements remain required. No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 21:35 UTC

All four later production gaps have reviewed component fixes. The final
Starknet omitted-chain-ID discovery and announcement startup guards passed40
focused checks in each mode, plus23 metadata checks in each mode. The preserved
[component packet](starknet-chain-id-discovery.md) includes failed attempts and
independent source/archive readback. These are component checks; the complete
combined runtime still needs fresh builds and native-node acceptance.

The updated stopped-row Rust reader passed13 checks, release compilation and
package Clippy. It now exposes exact public Starknet original batch weights and
allows Aleo's concrete process row with null target and resolved Prepared
target. Fresh five-message actual-Zig storage interoperability passed both modes;
the accepted older two-message component remains immutable and historical.
Stored weights alone do not prove native quotes or actual fee allocation. Its
[new component packet](native-row-reader-public-quotes.md) preserves both older
V1 and the new independent readback without overwriting accepted artifacts.

Cosmos verification passed17 pure controls after independent review closed its
earliest-gRPC-witness and canonical SQL-event-position gaps. The shared passive
HTTP2 observer and transparent transports have focused/dummy controls; final
review corrections remain open. [Dependency setup](native-node-verification.md)
uses isolated pinned HPACK code only in the correctness harness.

The actual Aleo SDK dependency install reused465 cached packages with zero
downloads; its three prerequisite SDK compilations and strict driver typecheck
passed. The driver passed35 controls, including owned dummy child/transport checks
and the final cleanup-ownership correction. [Actual SDK import and provider/signer
construction](aleo-sdk-controls.md) passed in an isolated network-denied process.
Real proof capability, node/VM capacity and actual Aleo daemon acceptance remain
unexecuted. The Radix adapter and independent SDK oracle extension are in
development.

The eight native-node scenarios and separate Aleo run remain unexecuted.
The execution registry stays empty and fail-closed. Accepted complete proofs:0;
final paired workloads:0. Historical timing tables retain their original source
and scope. Source is uncommitted; no draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 20:15 UTC

Three later production gaps have reviewed component fixes: optional Sealevel
CCS availability, validator startup metadata and configured native-RPC HTTP.
The HTTP fix grants a distinct configured-RPC transport capability while cloud
credentials, signer leases and CCS remain strict. Four native chain defaults,
Helius, receipts and real role-task producers passed30/30 checks per mode.
Boundary checks passed19/19 per mode, including actual Manager credentials and
same-owner signer-factory capability rejection. Related CCS, metadata, origin,
receipt and deadline checks passed all16selected roots against that combined
source (524passing checks per mode, with overlapping/imported cases).
Earlier focused results retain their original source maps.

The schema3 all-native Rust harness passed22 focused lifecycle/restart controls,
helper compilation and package Clippy with warnings denied. All1,429 selected
inputs and preserved comparator artifacts stayed unchanged. Every configured
role is stopped and parent-waited before retained-DB snapshots, then restarted
through its original Program specification. Default Rust behavior is preserved.
Python adapters remain in development; the execution registry is fail-closed.

The independent native-row reader passed8 substantive Rust checks plus its
subprocess helper, release compilation and Clippy. Actual Zig production Store/
Operation interoperability passed in ReleaseSafe and ReleaseFast: live-writer
lock refusal, parent wait, sequential old/new readers, full32/64-byte identities,
large-u256 accounting and read-only Zig recovery. Root independently rehashed
both result/executable packets and all10 retained DB files per mode. This grants
structural stopped-fixture evidence only; native SDK, chain, finality and elapsed
600-second acceptance remain separate requirements.

Validator process and benchmark wrappers now explicitly pin the required fifth
Rust URL library. Reviewed wiring preserves the original measured timer/pacing
boundary. The URL library and startup metadata evidence remain linked below.
Its new dependency-inclusive build cost is still unmeasured.

A fourth production gap was found during native adapter review: Rust Starknet
configuration can omit chainId and discover it from RPC; Zig currently rejects
the empty value. Its production discovery/authority/recovery fix is in progress.
The [HTTP component packet](configured-rpc-http.md) preserves its earlier accepted
source snapshot; future complete acceptance must include this additional fix.

Actual eight native-node scenarios and the separate Aleo daemon run remain open.
Aleo orchestration is being completed with explicit node/SDK/native consensus
and proof-capability checks. All previous six-proof and paired plans remain
historical and ineligible for the combined source. Accepted complete proofs:0;
final paired workloads:0. Source is uncommitted. Fresh role/image builds, real-
node acceptance, full production-duration proofs, inventories and matched
measurements remain required. No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 19:15 UTC

Both newly found production gaps now have reviewed fixes. Optional CCS passed
44/44 focused checks per mode. Validator startup metadata passed 6 serializer
and 23 native checks per mode, with no skips, failures or leaks. Independent
review closed startup ordering, backend guards, privacy and lifetime handling.
The [metadata packet](validator-startup-metadata.md) retains actual immutable-Rust
goldens, the old Zig publication gap and the failed fixture diagnostic.

The required URL library passed 6 Rust ABI checks, 4 native Zig checks per mode
and 6 helper controls. Its 35 external packages match the reference lock; all
36 package license texts are bundled. The final library is byte-identical to
the tested artifact after the license-only packaging change. Its input bound
matches the existing 16 MiB configuration-file bound. See
[component evidence](../../zig/bench/results/native-url-host/README.md).

The all-native Rust test harness compiled and passed 11 construction controls;
the actual helper binary also built. All preserved comparator products and
1,429 selected Rust inputs stayed unchanged, including 36 ignored generated ABI
files checked against the earlier sealed inventory. The Clippy attempt stopped
at an unchanged core-crate lint; package-scoped linting remains open. A parent
wait/reap receipt is being added before final stopped-database checks, and
existing validator benchmark/process wrappers need explicit URL-library pins.

Actual native-node daemon scenarios remain open. The EVM/TRE evidence drivers
and separate Aleo driver are under development. Aleo's existing SDK node helper
and native library use different test consensus schedules; effective runtime
compatibility has not been executed or rejected. No node acceptance is inferred
from that source comparison.

Source remains uncommitted and acceptance is still open. Previous process and
paired plans are ineligible for the changed source. Accepted complete proofs:0;
final paired workloads:0. Fresh role/image checks, real-node runs, inventories
and measured builds follow the coordinated freeze. No draft PR or production
cutover occurred.

## Previous snapshot — 2026-11-06 18:55 UTC

Two production parity gaps reopened acceptance. The optional Sealevel CCS fix
passed44/44focused tests in both ReleaseSafe and ReleaseFast, with two independent
reviews. Missing or unavailable optional CCS now preserves ordinary delivery;
mandatory payer failures and true owner deadlines remain hard failures. The
[preserved fix evidence](../../zig/bench/results/optional-svm-ccs-availability/README.md)
includes the old-code failure and both final test logs. Source is uncommitted.

Validator startup metadata is also missing from the previous runtime. Its
producer, local/S3/GCS startup barrier, compiled Git identity and actual Rust JSON
goldens are being implemented and tested. Exact Rust URL host normalization needs
a fifth retained Rust native library using the reference URL dependency graph.
That dependency and its build cost must appear in the final inventory and tables.
Earlier four-library build observations retain their original scope.

The opt-in real-node harness scaffold passed19pure Python controls and independent
review; eight authored Rust construction tests still need compilation. Actual
EVM/TRE evidence adapters are under development. The other native node scenarios
and separate Aleo daemon scenario remain open. Scaffold tests, SDK fixtures and
the earlier EVM-backed Tron bridge do not count as actual-node daemon acceptance.

All previous six-proof and paired plans are historical and ineligible for the
changed source. Accepted complete proofs:0; final paired workloads:0. The earlier
Linux SDK/image checks finished on their recorded source and all owned jobs were
joined. New roles, images, inventories and measured builds follow the coordinated
source freeze. No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 18:00 UTC

An independent capability audit found a production Sealevel parity gap. Rust
continues ordinary mailbox processing when optional UR-reveal CCS signing is
unconfigured or fails initialization; Zig currently fails destination creation.
The exact runtime paths were inspected in both implementations. A coordinated
fix and role-equivalent regression tests are required before new acceptance.

The first V6 process proof was deliberately interrupted with SIGINT. Cleanup
completed, all 764 inputs stayed unchanged, and the raw result records
`KeyboardInterrupt` with `passed:false`. No 600-second substage or full proof is
credited. Its plan, stopped fixture, logs and prepared paired plan remain intact
as historical candidate evidence. This was an audit-driven stop, not a newly
observed relayer runtime failure. No final paired timing ran.

The full SDK image built and its basic runtime smoke passed on the f7 snapshot;
SDK-specific runtime checks are finishing before source changes. The audit is
also mapping the existing eight real-node Rust E2E scenarios and separate Aleo
setup to explicit Zig binary selection. Current native/wire fixtures and an
EVM-backed Tron bridge do not substitute for real-node daemon acceptance across
the protocol matrix. Source remains frozen while the remaining audit and current
jobs drain. No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 17:55 UTC

The deterministic fixtures are committed as `f7bdda8cf6`, with normal hooks and
independent review. Its three changed paths contain only tests and integration
fixtures. Production, build, Rust SDK and benchmark code remain at `8872c5e470`.
Measured binaries and compiler timings retain that original provenance; no new
compiler timings are attributed to the fixture commit.

Fresh ReleaseSafe/ReleaseFast default and native suites passed against identical
660-file source maps: 745 default passes per mode, and 1,055 native passes plus
one existing named opt-in skip per mode. The remaining nine Safe checks passed,
including PostgreSQL, role builds/helps and network fixtures. The eleven-check
Safe rollup explicitly combines three independent executions with unchanged raw
logs and matching source, native dependencies and worker inputs.

A short real batch diagnostic passed the new preparation barrier: all four
messages became sealed pending operations while broadcasts and the account
nonce remained unchanged. Releasing the queue cap on the same database produced
one four-member transaction, preserving message IDs, UUIDs and weights. This is
diagnostic evidence, not the full 600-second settlement/crash acceptance proof.
The metadata correction passed 100 focused repetitions and the full metadata
module in each Linux mode; existing quorum-cancellation tests remain unchanged.

The new six-proof plan sealed 764 inputs, 38 products and separate runtime-build
and fixture commits. The first Safe process proof started at 17:51 UTC. All three
initial messages are self-submitted and active during their required hold. Zero
full proofs and zero final paired workloads are accepted. The Linux SDK retry
passed 1,035 native cases with 21 optional skips and no failures, including the
corrected metadata fixture; final Aleo/image work remains open. No draft PR or
production cutover occurred.

## Previous snapshot — 2026-11-06 17:16 UTC

The V5 full process proof failed an exact-four batch-membership assertion after
both initial and batch600-second settlement and stopped Rust readbacks passed.
Offline decoding found valid transaction groups `[2,1,1]`: two messages prepared
before the first batch, with the other two preparing5and15seconds later. The
fixture had assumed maximum batch size4implied a four-member first transaction.
A deterministic prepare-before-submit fixture gate is being added; exact-four,
600-second and fee-allocation assertions remain unchanged. The lifetime crash did
not recur. No full process proof or paired runtime result is accepted.

The Linux core image passed. Full SDK building stopped on a test-only metadata
budget assertion: a two-of-four quorum may cancel one child before entry, so
exactly five visits was scheduler-dependent. The final-test label initially
pointed at preseal admission; the actual log and focused rerun ruled that out.
The fixture now requires all four children and retains the exact five-visit cap,
with explicit replay/selection assertions. Focused Linux checks are running.
No production runtime change has been identified for either current failure.

The reviewed production and benchmark code remains `8872c5e470`; its emitted
binaries, build measurements and prior input snapshots are preserved. Test and
harness corrections will receive their own commit and provenance. Full SDK/image
acceptance, six complete process proofs and ten paired workloads remain open.
No draft PR or production cutover occurred.

## Previous snapshot — 2026-11-06 16:53 UTC

The lifetime fix and genuine-batch benchmark fixture are committed and reviewed
at `8872c5e470`. All13broad checks passed with659matching physical-input maps:
745default tests and1,055native passes plus the existing named opt-in skip per
mode, PostgreSQL21migrations/11functional cases, three role builds and network
checks. Full Lander tests passed82per mode; new/existing benchmark tests passed
18/28with independent review. Normal hooks passed; frozen hashes stayed unchanged.

Fresh Safe cold/no-change builds measured118.230s/0.519s; Fast115.070s/0.492s.
All30prior products and native dependency pins remained unchanged. Both new
workers passed actual supplemental745-test suites with zero skips. Reused
Rust/native dependency build observations retain their original scope; these
mixed totals are not new dependency-inclusive trials.

V5 preparation sealed760inputs and38preserved/current products. The first Safe
process proof started16:46UTC; live readback showed exactly three self-submitted
confirmations during the required600-second hold. No complete V5 proof or paired
runtime result is accepted yet. Corrected Linux core/full-SDK builds are running
separately with both disk guards active. The prior V4 batch lifetime crash remains
an explicit failed full proof with preserved evidence.

The final inventory now records2,430files with prior snapshots preserved. Final
paired plans cover the original eight workloads plus genuine batch-cap4 Safe/Fast
cases; actual execution waits on all six full proofs and task quiet. No draft PR
or production cutover occurred.

## Previous snapshot — 2026-11-06 16:24 UTC

The V4 full process proof failed after its initial three-ISM600-second settlement,
stopped readback and receipt checks passed. The four-message batch relayer then
aborted. The panic stack and stopped fixture are preserved in
[the failure report](final-relayer-batch-lifetime-diagnostic.md); zero full V4
proofs are accepted.

Independent review identified a production lifetime bug: batch simulation copied
JSON objects from a temporary arena into a longer-lived transaction record.
Subsequent request growth used a freed allocator context. The fix clones the
rebuilt fields into the record's owning arena before replacing either slot. A
deterministic old-code regression failed as expected; all82Lander tests now pass
in both modes, including allocation failures, scratch destruction, growth,
signing and RocksDB reopen. The fix is frozen and independently reviewed; broad
validation is running before another normal commit and fresh builds.

All earlier `e0b95ebf01` unit/build/inventory observations remain valid snapshots,
with the failed process proof explicit. Linux core acceptance finished for that
snapshot; full-SDK work stopped safely and remains unaccepted. New binaries,
images, six complete production-duration proofs and paired measurements remain
pending. No draft PR or production cutover occurred.

A separate benchmark fixture review found that setting maxBatchSize4 alone did
not install a Multicall3 contract. Genuine four-message paired coverage is being
added with explicit deployment and receipt membership checks; original singleton
workloads and timing boundaries remain unchanged.

## Previous snapshot — 2026-11-06 16:04 UTC

The admission fix is committed as `e0b95ebf01`, with normal hooks and all18frozen
source/test hashes unchanged. All13broad checks passed against the same658selected
input maps:745default tests per mode;1,052native passes plus one existing named
opt-in skip per mode; PostgreSQL440passes,21migrations and11functional cases;
three role builds/helps; RPC/operator/WebSocket/socket checks. The focused matrix
passed120group/admission and43EVMdriver tests in each mode.

Four new compiler-cold/no-change Zig build observations passed with unchanged
source: Safe131.128s/0.491s and Fast121.737s/0.492s. Earlier Rust/native dependency
measurements remain reused comparators. Both rebuilt worker hashes changed;
actual supplemental745-test suites passed with each new worker, with zero skips.

A new six-proof plan pins750inputs, including all30old/new products and658selected
physical source/dependency inputs. The first ReleaseSafe process proof began at
15:58UTC; live initial readback shows three self-submitted confirmations during
the full600-second hold. No full V4 proof or final paired runtime measurement is
accepted yet. Corrected Linux core/full-SDK packaging builds are running
separately as functional checks. No production cutover or draft PR has occurred.

The final source inventory preserves all old snapshots and records2,428files.
Tracked source binds to the commit; ignored dependency inputs bind to exact
recorded hashes. Detailed LOC categories and Rust SDK/native dependencies remain
explicit, without an equivalent-feature LOC reduction claim.

## Previous snapshot — 2026-11-06 15:34 UTC

Production and test sources are frozen for acceptance. Independent code/security
review found no unresolved blocker across the18-file hash map. Both EVM
estimate-to-seal race cases passed in ReleaseSafe and ReleaseFast; the31-test
focused admission run passed queue-pressure, suspended-I/O, actual manual
retry/reprocess and final batch-rule cases. The final four-run candidate matrix
and broad Safe/Fast suites are running; no corrected-source build or complete
process proof is accepted yet.

The final changes preserve Rust's native queue-pop and EVM pre-handoff deny-rule
boundaries. A further local all-member sweep immediately before creating/signing
an unsigned native batch deliberately strengthens Rust's classic queue check,
matching the existing single-message signing gate. Existing sealed, signed and
confirmation ownership remains recoverable. No stored record schema changed.

## Previous snapshot — 2026-11-06 15:12 UTC

The admission fix passes focused tests covering static/runtime/cached-signer
filters, sealed and signed ownership, canonical acknowledgment, database reopen,
allocation failures and completed-group cleanup. Recovery-only delivery cannot
create a new reveal. Independent review is checking a further queue boundary:
a fresh actor held by submission pressure must honor a deny rule arriving before
its first preparation. Existing owned confirmations and child work must drain.
Production code is not frozen; final broad gates and all six process proofs remain
open.

A separate four-phase Zig-only cold/no-change build plan retains the original
seven native archives and four SDK libraries. Its16GiB capacity budget covers only
the Zig follow-up; the original11-phase40GiB budget and all old products remain
unchanged. No follow-up build has run. Earlier Rust/native build times will be
explicitly labeled reused comparators, rather than new measurements.

## Previous snapshot — 2026-11-06 14:42 UTC

The third process attempt passed the initial three-ISM600-second settlement,
positive final telemetry, stopped Rust readback and all three receipt/estimate
proofs. The max-batch stage then exposed a production parity bug: four excluded,
already-delivered canonical messages became pending operations before matching
policy ran. Three of those raised the confirmed count while no fresh target was
600-seconds eligible. Rust filters disqualified rows before constructing pending
operations. The unchanged zero-offset guard correctly failed the full proof.

The completed substage, failure detail, live operation snapshot, stopped batch
readback and exact pre-fix sources are preserved under
`zig/bench/results/canonical-admission-before-fix/`. The attempt remains a failed
full proof; no runtime timing result is accepted.

The shared admission fix is in progress for EVM and native destinations: static
lists, runtime message rules and cached signer rules precede new actor creation.
Denied fresh work retains canonical history and reconsideration. Existing sealed
or signed ownership is handled separately, retaining private receipt/finality,
accounting and nonce recovery without granting new work or canonical completion.
Both persistence boundaries receive an explicit acknowledgment capability, and
recovery-only native delivery hooks cannot enqueue a new reveal. Dedicated
read-only ownership and actual database-marker tests are being added; independent
review remains open.

The old-loader focused regression failed as expected: three excluded actors were
created instead of zero. New runtime code has not been frozen, measured or
accepted. Historical build products at `516bdf4290` remain preserved; final builds,
images and all process proofs must use the corrected production code before the
paired benchmarks and draft PR. The six-proof barrier remains closed.

## Previous snapshot — 2026-11-06 14:08 UTC

All final build and post-matrix correctness gates below passed. Matched whole-agent
runtime measurements remain pending; none has been accepted. Build/runtime
products remain pinned to `516bdf4290` and all22product hashes remain unchanged.

Two integration-only corrections are committed: `baf14145ae` keeps absent metric
children distinct from zero and checks exact active IDs; `853c150592` distinguishes
preparation estimates from Lander transaction sizing with full request structure
and pre-broadcast monotonic timing. Ten estimate/progress, ten guard,28existing
pure and21static controls passed, plus independent timing/order/error probes.
No production Zig or Rust input changed. Build source fingerprints describe the
original snapshot; corrected process fixtures record their own hashes.

The first process attempt failed its initial metric assertion. The second reached
actual600-second retirement and positive stopped Rust readbacks, then failed an
assertion that conflated preparation and Lander gas estimates. Both remain failed
full proofs with preserved artifacts. Separate pre-600diagnostics proved the two
request shapes and matched each preparation estimate to its sealed weight; they
are diagnostic evidence rather than acceptance. See
[metric guard](relayer-initial-metric-guard.md),
[estimate stage capture](relayer-estimate-stage-capture.md) and
[estimate proof correction](relayer-estimate-proof-correction.md).

A fresh third-attempt ReleaseSafe process proof is running with all38inputs pinned
and production600s+30sgrace unchanged. Its six planned full mode-specific proofs
remain unaccepted. All paired timing remains gated on six strict passed proofs,
exact native binary identity and per-ID600ssettlement evidence before any main.
Final validator/scraper/relayer timings, consolidated tables and the draft PR are
still pending. No production cutover occurred.

## Previous snapshot — 2026-11-06 13:13 UTC

All eleven cold/no-change build phases passed on source commit `516bdf4290` with
unchanged selected source hashes. Dependency-inclusive cold wall time was Rust
2090.97s, Zig Safe836.44s and Fast841.86s: single observations on a shared host.
Native/FFI prerequisites total728.99s and remain included in each Zig bundle total.
See [build matrix](final-build-matrix.md).

Post-matrix acceptance passed against the exact rebuilt four SDK libraries,
mode-specific workers and seven native archives: both default745/745, both native
1027passed/1documented opt-in EVM skip, PostgreSQL440/440 with21migrations and
11SQL functional cases, RPC410, operator56, WS22 and socket4. All three re-emitted
role help checks passed. The selected650source mappings matched before/after and
across these completed runs. See [functional validation](../global-functional-validation.md).

Both final Linux arm64 images passed packaging acceptance: core284657476bytes,
full SDK359489415bytes. Actual baked-worker Aleo75/75, Starknet44/44 and regex9/9,
HTTP/2, nonroot linkage and three-role shutdown/reopen checks passed. This does not
claim local amd64 CI execution.

The first exact-matrix relayer process proof delivered all three ISM messages,
then failed an initial metrics assertion before600-second retirement. Read-only
reviews found that the assertion required zero-valued series before their first
update; Rust's confirmed-operation series is also lazy. The scoped integration
assertion correction was committed as `baf14145ae`, retaining absent values
distinctly and requiring exact active operation IDs. Ten new and28existing pure
controls passed independent review. Runtime binaries/SDKs remain unchanged.
The failed proof and pre-fix harness bytes are archived under
`zig/bench/results/final-relayer-initial-metric-diagnostic/`. No process acceptance
or runtime performance result is claimed from it.

All six strict mode-specific process proofs and serial matched validator,
scraper and relayer timings remain pending. The draft PR with all benchmark tables
will follow those gates. No deployment or production cutover has occurred.

## Previous snapshot — 2026-11-06 11:15 UTC

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

| Owner               | Current write set                                                   | Work                                                                  |
| ------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Parent              | Integration, functional runners, final benchmarks and documentation | Native launch, independent readback and final measurements            |
| `runtime_recovery`  | Private Aleo launch preparation                                     | Refresh proving prerequisites against current production products     |
| `protocol_recovery` | Private Cosmos-Wasm/Starknet prerequisite preparation               | Exact node dialect, local contract inputs and CLI loader diagnosis    |
| `baseline_recovery` | Private fifth Cosmos-native case preparation                        | Bind corrected helper and fresh state; retain earlier failed evidence |

Write sets are disjoint except explicitly coordinated narrow forwards. Earlier
Claude architecture material is an archived snapshot. Current Claude execution
could not start because its account reported insufficient credit. No current
Claude review is claimed. Older GLM/Kimi reports remain evidence for their tested
source snapshots, rather than final-source approvals.

## Remaining acceptance work

1. Complete real native cases for EVM, Cosmos native, Cosmos Wasm, Sealevel,
   Aleo, Radix, Starknet and Tron. Current production builds and all 20 broad
   correctness checks passed; changed components require scoped fresh evidence.
2. Close the restart harness finding in a fresh full Cosmos-native case. Run
   all six final process proofs, including relayer three-ISM, batch and crash,
   WS and public-sidecar fixtures with the 600-second retirement policy.
3. Run final Linux core/SDK image runtime and exact-source CI checks. Retain both
   the validated portable commands and diagnostic failures.
4. Freeze all writers, secure measured cache/disk budgets and a quiet host. Run the
   dependency-inclusive cold/no-change build matrix, including the required URL
   library, and final balanced whole-validator,
   scraper and relayer ReleaseSafe/ReleaseFast pairs. Retain regressions and actual
   physical RPC/CPU/RSS/cost/phase scope; no shortcuts around production finality.
5. Commit the frozen implementation with normal hooks before timed builds.
   Complete final source/dependency/LOC inventory, independent security/code
   review and artifact provenance; commit benchmark/documentation results,
   verify hashes after hooks, push and open the requested draft PR with tables
   covering every benchmark, failed attempts and limits.

## Source-supported ISM boundary

The current Rust metadata dispatcher supports standard message-ID/Merkle-root multisig, routing, aggregation, null, CCIP-read and Sealevel composite. Legacy3, Arb8, weighted9/10, OP11 and Polymer12 return `UnsupportedModuleType` in `rust/main/agents/relayer/src/msg/metadata/message_builder.rs:231`. Zig preserves that refusal. Independent legacy/weighted/Arb codec tests exercise repository SDK/Solidity layouts, but do not establish production builders or bridge finality support for those types. These source-unsupported variants are not missing parity gates.
