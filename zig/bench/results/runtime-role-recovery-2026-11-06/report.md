# Runtime role wiring recovery

Owned implementation and correctness checks are complete. Global Source gate remains closed pending the metadata owner's final report and parent integration review. This directory contains correctness evidence, not benchmark results or a complete-rewrite acceptance claim.

## Changes

- All three service roles retain one heap-stable common-health set until Supervisor joins. Providers construct lazily per chain, share bounded role HTTP resources, and isolate constructor failures through the same per-chain critical tracker. Validator monitors only its origin and never creates a wallet resolver.
- Configured scraper signers now resolve only their public wallet identity during supervised begin, before the first wallet snapshot/balance request. Local identity performs no auth setup; AWS/GCP public-key initialization owns one bounded, temporary auth-only transport. PIO retains the attempt; cancellation retires it. Relayer uses its actual existing lane signer publisher. No constructor key/network I/O, proving, full destination factory, or production-key reads were added.
- Root owns both metered contract-cache partitions, separate always-on unmetered default-ISM caches, and an indexer-only shared tip cache. Health and metadata do not receive the tip-cache opt-in. Native metadata strictly classifies explicit app first, otherwise actual default lookup, before cached/uncached root builders. Ordinary RPC/control errors propagate. Post-fetch default TTL insertion samples the same monotonic clock domain used by lookup; optional clock failure preserves successful RPC results.
- Root validator-observation bounds derive from configured routes/app contexts and existing Registry budgets. A real 300-route regression passes beyond the old 256-context ceiling. Exact constructor metrics cover actual shared mailbox setup, configured Lander dispatcher, Ethereum/Tron signers, and first successful policy construction. No separate application-operation-verifier constructor sample was fabricated.
- Optional operational telemetry cannot block canonical work. Production Lane callbacks count failures and log the first error name; Registry series/storage/OOM, tracker budget, and optional observation clock/timer errors remain telemetry failures. Pure adapters and generic MetadataObserver interfaces remain fallible. Core allocation, DB, policy/security, control, driver and I/O failures keep their propagation.
- Durable completed actors retire through one releaseCompleted path. It releases loader ownership, pending/wait references, retained bytes, message storage and actor exactly once despite Registry failures. Optional app-label budget/allocation failure disables only that actor's telemetry; it cannot reject core admission. Core allocation failures still roll back loader and byte ownership.

## Verification

Counts include import-root tests. Every accepted run below had zero skips. Exact commands and logs are adjacent; compile commands use `-fno-emit-bin` and do not emit role pins.

| Check | Result | Evidence |
| --- | --- | --- |
| Root native integration: constructor/cache/capacity, retained reservations, telemetry failure liveness | 52/52 passed | integration-tests.log |
| Common health/provider/cadence/PIO/native HTTP and shutdown integration | 42/42 passed | health-tests.log |
| Strict default classifier/post-fetch TTL plus actual cached native metadata/fork isolation | 16/16 passed | app-context-tests.log |
| Pure metrics adapters, rollback, ownership and Registry allocator sweep | 21/21 passed | pure-adapter-tests.log |
| Configured scraper first actual local-wallet balance | 8/8 passed | scraper-local-identity-tests.log |
| Configured scraper remote public-key lease/HTTP PIO and cancellation | 8/8 passed | scraper-remote-identity-tests.log |
| Actual relayer service_main, ReleaseSafe | compiled | relayer-compile.log |
| Actual validator service_main, ReleaseSafe | compiled | validator-compile.log |
| Actual scraper service_main, ReleaseSafe, libpq | compiled | scraper-compile.log |
| zig fmt --check on owned files and permanent roots | passed | command listed below |

The Root admission test sweeps all 96 allocation offsets: core OOM restores actor/loader/byte budgets; post-append telemetry OOM preserves admitted work. Registry pressure tests exercise actual MetricSeriesLimit, MetricStorageLimit and allocator failure against native Rocks-backed durable completion, drain all pending/wait refs, release all retained bytes, and rescan without re-admitting the completed actor. No transaction driver is installed in that fixture, so any unintended retry/broadcast would fail. The exact production metadata observer preserves success and drains wait ownership under series/storage/OOM and MetricTrackerLimit pressure.

The shared-runtime shutdown case stops a Supervisor with an actual fourth HTTP request stalled and retained, joins callbacks, then tears down providers and verifies read-budget usage is zero. Source address fixtures cover all eight protocols with actual Aleo native Crypto.addressText available. Public fixture key 11 and mock cloud public-key responses only; no production credentials were used.

One native cached-Tron isolation fixture hit MetadataFixtureRetirementTimeout during parallel compilation/test load. The failed log is preserved as app-context-concurrent-timeout.log. An immediate sequential run of the exact focused command passed16/16; the earlier native-only focused command also passed14/14. The fixture has timing sensitivity under CPU contention; it was not weakened or edited here.

Protocol owner's independent public-identity/auth transport suite is reported separately (18/18 native including actual Aleo SDK and own-curl signed AWS loopback). Its aggregate GCP executable-credential budget regression uses an injected runner and is not a production subprocess. Those counts are not added to this agent's independent runs.

## Reproduction and limits

Use command JSON arrays with Python subprocess, from the repository root. Tests use HYPERLANE_CURL_LIBRARY=/usr/lib/libcurl.4.dylib and HYPERLANE_ALEO_CRYPTO_LIBRARY pointing at the existing native dylib; exact paths are in manifest.json. Seven existing DB archives and the macOS15.4 SDK are needed. Compile commands refer to the adjacent options files using the archived original /tmp names; copy them there or replace only the -Mservice_options path.

Formatting check: zig fmt --check zig/src/service_main.zig zig/src/agents/health_set.zig zig/src/agents/health_set_test.zig zig/src/agents/relayer_task.zig zig/src/relayer_reservation_native_test.zig zig/src/agents/relayer/evm_driver.zig zig/src/agents/relayer/control.zig zig/src/agents/destination/factory.zig zig/src/relayer/contract_cache.zig zig/src/relayer/app_context.zig zig/src/app_context_tests.zig zig/src/root.zig zig/src/db_tests.zig.

Source and artifact SHA256 values are in manifest.json. These hashes identify owned/shared stable files, not a final whole-tree pin: external metadata implementation was concurrently owned and is still separately gated. No Cargo baseline, benchmark timing, emitted service executable, container, production action, commit, push or PR was performed in this slice. Parent still owns full integration acceptance, frozen binaries, before/after benchmarking, container/runtime evidence and the draft PR.
