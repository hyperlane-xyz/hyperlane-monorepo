# Critical/init integration review

2026-11-06. Applied repository code-review/REVIEW guidance. Read current Source Rust boundaries and actual Zig owners. No benchmark, role daemon, production endpoint, credential read, commit or publication. Two open P2 findings remain; the shutdown and scraper escalation defects below are closed by current code and focused tests.

## Open findings

### P2 — published Origin handle bypasses actual sequenced cursor initialization failure reporting

`agents/origin_tasks.zig:160–162` sets `ready=true` after Service/discovery/loader construction. Actual stream tip, persisted progress and cursor construction happen later in EVM `Service.tickRound` and generic `Core.tick`. `Slot.run:176–181` increments its startup failure counter only while `!ready`, and after readiness records only the three `halt_all` history-corruption errors. Thus repeated ordinary errors during the first real cursor bootstrap never become a critical sync reason.

Concrete reproduction uses the exact copied Slot.run/ensure, the real native Store/Rocks database, a real generic Service/Core and a typed Source whose initial streamTip returns `RpcHttpStatus`. After24calls spanning23 injected monotonic seconds (12failures each for dispatch and insertion), `handle()` remains available, BOTH native cursors are null, `initialization_failures=0`, and the production Registry still exports `hyperlane_critical_error=0`.

The Source distinction is important: `rust/main/agents/relayer/src/relayer.rs:1021–1040` independently retries actual cursor construction (production10attempts, Source2-second interval); message-sync `:1233–1245` and insertion-sync `:1392–1406` record their own critical reasons on exhaustion and clear that same reason on real success. The native Service-construction counter is not that cursor bootstrap boundary. A full search currently finds no relayer production writers for `.message_sync`/`.merkle_tree_hook_sync` and no production `clearDirectRpc()` caller.

Correction: track actual per-stream bootstrap result, excluding cooperative/cancel/control/OOM decisions; after the agreed completed-failure bound record the matching sync reason, and clear only on real successful construction or Source-valid WS handoff. Healthy sibling work must continue; do not mark mere descriptor/ProgressAdapter creation healthy, or count range-fetch backoff as cursor construction. Continued native recovery and native initialization cadence may remain explicit architecture differences, but a permanently uninitialized stream must not look healthy.

Evidence: `/tmp/ziggy-critical-init-repro/origin_root.zig`, copied/appended `src/agents/origin_tasks.zig`, `origin-command.json`, `origin-cursor.log` (12/12passed, zero skips). Reproduction passing means the observed bad state is reproduced, not acceptance of that state.

### P2 — an already-canceled origin can perform construction and count a constructor error as startup failure

`Slot.ensure:93–102` attempts `Resources.open` before checking `cancel`. With the token already true, a constructor failure (e.g. unavailable native library) masks cancellation. `Slot.run` sees the constructor error rather than `RequestCancelled`, increments its startup counter, and can latch `.origin` after five canceled calls.

Reproduction executes five actual Slot.run calls with cancellation true from the start and an intentionally unavailable Curl library. Every result is the constructor error; no DB or network is opened, yet `initialization_failures=5` and the shared Tracker has `.origin=1`.

Correction: check cancellation at the start of `ensure` before resource construction. Retain normal completed constructor failures, and do not introduce a fallback or swallow them when the token is false.

Evidence: `/tmp/ziggy-critical-init-repro/origin-pre-canceled.log` (12/12passed, zero skips), same copied module. Repository Source unchanged by these review repros.

## Closed defects and delivered fixes

- **P1 detached latest observation shutdown:** Actual Builder/Executor repro originally waited the entire artificial300ms latest-only PendingReadIo deadline after successful metadata return, then still invoked its callback during shutdown. The same design could hold the real request deadline (up to120s). Added authorized stable `Executor.stopToken()` in `relayer/metadata_parallel.zig`; it is signaled before worker joins, including failed thread initialization. Metadata owner wired detached Source forks and beginPass/run to this executor-lifetime token. It never borrows a freed Operation/Builder token. Actual post-fix Builder/Executor repro canceled in0ms against a2-second source deadline, callback0, source closed exactly once, strict allocator clean (3/3). This is a functional cancellation observation, not a performance benchmark.
- **P2 scraper control/OOM fatal escalation:** Exact copied `Lane.failed` reproduced `RequestCancelled` or `OutOfMemory` at0/60000ms becoming `ScraperCriticalFailure`. Parent now returns PendingReadIo/PendingIo/RequestCancelled/OutOfMemory before feeding the fatal head streak; existing genuine failure history is left intact. Permanent regression passed5/5, including subsequent real failures with an intervening control event. Current source filter verified.
- **Fixture hang in parent cancellation acceptance:** `metadata_session_test` waited `effects==9` while every PIO replay incremented that counter, so an overshoot could time out; the error path then failed to cancel/join ParentBuild and blocked Root.deinit. Authorized fixture-only correction now waits a stable nine-distinct-child bitmask, retains every raw effect for the post-return assertion, and always cancels/joins on error before Root drain. The normal path still poisons the caller flag to verify children never reuse it. Added deliberate early-error cleanup regression. Focused5/5passed; complete producer-root rerun belongs to protocol owner.
- **Tracker telemetry failure caching:** Parent's existing `published=false` plus return on Registry.update error is present. Same-reason record may retry a failed publication; per-reason bits remain independent. No remaining same-reason suppression finding is claimed.
- **Parent memory-safety fixes in detached allocation:** Current startObservation initializes stable token/source ownership before enqueue and uses scoped error cleanup only on submit failure. No second explicit job.deinit triggers the outer cleanup again. Metadata owner's strict saturation/fork-token regression remains its handoff gate.

## Delivered production API and test scope

Only authorized production edit by this recovery reviewer: `zig/src/relayer/metadata_parallel.zig` stop signal/accessor and2inline tests. Authorized fixture edit: `zig/src/agents/metadata_session_test.zig` distinct-child start mask plus safe join/error regression. All other review repros are under `/tmp`.

- Executor API2/2: active cancellation-aware blocking job plus queued job; retained cooperative continuation; all jobs/output drain before token storage is freed. `/tmp/ziggy-metadata-executor-stop-tests.log`.
- Parent-cancellation fixture5/5: `/tmp/ziggy-metadata-parent-cancel-tests.log`, exact command JSON alongside it.
- Actual detached observation before/after3/3each: `/tmp/ziggy-critical-init-repro/observer-shutdown.log` and `observer-shutdown-fixed.log`.
- Pre-fix scraper escalation5/5: `/tmp/ziggy-critical-init-repro/scraper-control.log`; parent permanent repaired5/5: `/tmp/ziggy-scraper-control-critical-tests.log`.
- Both open Origin cases12/12each as above, real native DB and no external I/O.

No clean final-source or full-role acceptance is claimed while the two origin findings and other owners' integration remain open. Validator code/pins were left frozen; this recovery did not repeat its completed daemon validation or timings.
