# ReleaseSafe functional validation

## Current fixture acceptance — 6 November 2026, 17:55 UTC

Fresh fixture gates passed at `f7bdda8cf6`, against the unchanged production
runtime and measured products at `8872c5e470`. All five actual execution manifests
share the same 660 selected physical-input maps before/after and at readback.
The Safe eleven-check rollup combines three independent executions; it is not an
additional run or a benchmark observation. Full source, worker, library and
component provenance: [current fixture validation](zig-agent-rewrite/final-fixture-functional-validation.md).

| Gate                  |                                     Safe |                                   Fast |
| --------------------- | ---------------------------------------: | -------------------------------------: |
| Default               |                   745 passed, zero skips |                 745 passed, zero skips |
| Native DB aggregate   |   1,055 passed, one existing opt-in skip | 1,055 passed, one existing opt-in skip |
| PostgreSQL            |       21 migrations; 11 functional cases |                                      — |
| RPC producers         |                               410 passed |                                      — |
| Operator regex        |                                56 passed |                                      — |
| WS/WSS                |                                22 passed |                                      — |
| Socket ownership      |                                 4 passed |                                      — |
| Role builds and helps | All three built and help commands passed |                                      — |

Both default suites execute the exact matching-mode measured Aleo workers.
Correctness-build help binaries are separately emitted generic-CPU products;
they do not replace the timed native-CPU binaries. All raw logs and manifests
remain unchanged in the [new archive](../zig/bench/results/global-fixture-acceptance-20261106/manifest.json).
Six exact-binary, production-duration process proofs and final paired timings
remain separate open gates. Counts across roots/modes overlap and must not be
summed as unique coverage. All earlier accepted and failed observations remain
below with their original provenance.

## Earlier original post-matrix functional acceptance — 6 November 2026

All eleven Safe gates passed after the final build matrix. Fast default and native DB gates also passed. All three runs kept the same **650 selected source mappings** unchanged before/after; every mapped file matched current bytes when sealed. Each run used the **four freshly built matrix SDK bridges, its matching Safe/Fast Aleo worker, and all seven matrix native archives**, with exact paths and hashes checked against the [build-matrix readback](../zig/bench/results/build-matrix-final/artifact-readback.json.gz).

| Gate                 | Mode | Passed | Skipped | Failed | Evidence                                                                                        |
| -------------------- | ---- | -----: | ------: | -----: | ----------------------------------------------------------------------------------------------- |
| Default              | Safe |    745 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/default.log.gz)          |
| Native DB aggregate  | Safe |  1,027 |       1 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/native-db.log.gz)        |
| PostgreSQL aggregate | Safe |    440 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/postgres.log.gz)         |
| Three role builds    | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/roles-build.log.gz)      |
| Validator help       | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/validator-help.log.gz)   |
| Relayer help         | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/relayer-help.log.gz)     |
| Scraper help         | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/scraper-help.log.gz)     |
| RPC producers        | Safe |    410 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/rpc-producers.log.gz)    |
| Operator regex       | Safe |     56 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/operator-regex.log.gz)   |
| WS/WSS               | Safe |     22 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/ws-wss.log.gz)           |
| Socket ownership     | Safe |      4 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-safe/socket-owner.log.gz)     |
| Default              | Fast |    745 |       0 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-fast-default/default.log.gz)  |
| Native DB aggregate  | Fast |  1,027 |       1 |      0 | [Log](../zig/bench/results/global-matrix-acceptance-20261106/1255-fast-native/native-db.log.gz) |

The sole native skip in each mode remains `evm_prepare_delegated_tests.test.opt-in loopback prepares actual repo Solidity without delivery or nonce mutation`. Its coverage is not inferred. PostgreSQL 16.15 applied all 21 production migrations, passed 11 persistence functional cases and five SQL smoke probes, and passed the 440-test aggregate. Modes and roots share imports; these counts must not be summed as unique tests.

The [sealed manifest](../zig/bench/results/global-matrix-acceptance-20261106/manifest.json) and [verification](../zig/bench/results/global-matrix-acceptance-20261106/verification.json) bind all 22 original manifests/logs, five exact ignored JSON mirrors, runtime SDKs/workers, oracle/libcrypto, native archives and three re-emitted Safe help-role binaries. Every recorded artifact matched its actual size/hash when sealed. Binaries and libraries stayed local and preserved; none were copied into the archive or deleted. The re-emitted help-role binaries are separate artifacts from the timed matrix role binaries.

This closes the rebuilt-library functional gate for the final matrix. It does not substitute for the exact matrix role binaries' 600-second relayer functional proofs, agent process benchmarks or container acceptance. Durations/RSS in these functional logs are diagnostic only. The earlier accepted and failed snapshots remain below with their original scopes.

## Earlier pre-matrix canonical acceptance — 6 November 2026

The completed 11:10 Safe run passed all eleven checks. The 11:10 Fast default and 11:15 Fast native runs also passed. All three kept the same **650 selected source mappings** unchanged before/after; every mapped file matched current bytes when sealed. This is selected-source functional acceptance, not an inferred exhaustive repository or comparative performance result.

| Gate                 | Mode | Passed | Skipped | Failed | Evidence                                                                                                     |
| -------------------- | ---- | -----: | ------: | -----: | ------------------------------------------------------------------------------------------------------------ |
| Default              | Safe |    745 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/default.log.gz)                       |
| Native DB aggregate  | Safe |  1,027 |       1 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/native-db.log.gz)                     |
| PostgreSQL aggregate | Safe |    440 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/postgres/postgres-integration.log.gz) |
| Three role builds    | Safe | exit 0 |       — |      — | [Manifest](../zig/bench/results/global-source-acceptance-20261106/1110-safe/all-manifest.json.gz)            |
| Validator help       | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/validator-help.log.gz)                |
| Relayer help         | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/relayer-help.log.gz)                  |
| Scraper help         | Safe | exit 0 |       — |      — | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/scraper-help.log.gz)                  |
| RPC producers        | Safe |    410 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/rpc-producers.log.gz)                 |
| Operator regex       | Safe |     56 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/operator-regex.log.gz)                |
| WS/WSS               | Safe |     22 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/ws-wss.log.gz)                        |
| Socket ownership     | Safe |      4 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-safe/socket-owner.log.gz)                  |
| Default              | Fast |    745 |       0 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1110-fast-default/default.log.gz)               |
| Native DB aggregate  | Fast |  1,027 |       1 |      0 | [Log](../zig/bench/results/global-source-acceptance-20261106/1115-fast-native/native-db.log.gz)              |

The sole native skip in both modes is `evm_prepare_delegated_tests.test.opt-in loopback prepares actual repo Solidity without delivery or nonce mutation`. Its coverage is not inferred. PostgreSQL additionally applied all 21 migrations and passed 11 persistence functional cases on PostgreSQL 16.15. Roots and modes share imports; counts must not be summed as unique tests.

| Final mapped source          | SHA-256 prefix |
| ---------------------------- | -------------- |
| `zig/src/aleo/worker.zig`    | `99f24187ca09` |
| `zig/src/aleo_vm_worker.zig` | `75d6954e466f` |
| `zig/src/root.zig`           | `96871be1b010` |

The [sealed manifest](../zig/bench/results/global-source-acceptance-20261106/manifest.json) records complete chunked identities for the four SDK bridges (Starknet crypto, Aleo crypto, Aleo VM and regex), Aleo worker, Rust DB oracle, libcrypto, seven native archives and three emitted Safe role binaries. The eight runtime environment records include two aliases to the same regex library. Every recorded artifact matched its actual size/hash at sealing. Role binaries remain local, ignored and preserved; no executable or library was copied or deleted.

All 22 original manifest/log payloads are retained losslessly, with five exact ignored JSON mirrors and [verification](../zig/bench/results/global-source-acceptance-20261106/verification.json). Commands, explicit environment overrides and all 650 mappings remain in the original manifests. Existing libraries were used; this does not substitute for final rebuilt SDK, image, whole-process or benchmark artifacts. Log durations and RSS are functional diagnostics. Earlier failed snapshots remain below.

## Earlier functional snapshots

All eleven functional gate types have a passing result across the completed 09:13, 09:24 and 09:33 UTC runs on 6 November 2026. Each run kept its recorded source map unchanged. The earlier failed PostgreSQL and RPC attempts remain archived as diagnostics; no single attempt completed every gate.

This covers local macOS ReleaseSafe checks using the recorded native libraries. The completed ReleaseFast default root is recorded separately below. Full ReleaseFast, final rebuilt SDK/artifact acceptance, Linux/container checks and performance measurements require their own evidence.

## Accepted gates

| Gate                            | Run UTC | Passed | Skipped | Failed | Evidence                                                                                                     |
| ------------------------------- | ------- | -----: | ------: | -----: | ------------------------------------------------------------------------------------------------------------ |
| Default                         | 09:13   |    738 |       0 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0913/default.log.gz)                       |
| Native DB aggregate             | 09:13   |  1,021 |       1 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0913/native-db.log.gz)                     |
| PostgreSQL aggregate            | 09:24   |    424 |       0 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0924/postgres/postgres-integration.log.gz) |
| Validator/relayer/scraper build | 09:24   | exit 0 |       — |      — | [Manifest](../zig/bench/results/global-functional-diagnostics-20261106/0924/all-manifest.json.gz)            |
| Validator help                  | 09:24   | exit 0 |       — |      — | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0924/validator-help.log.gz)                |
| Relayer help                    | 09:24   | exit 0 |       — |      — | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0924/relayer-help.log.gz)                  |
| Scraper help                    | 09:24   | exit 0 |       — |      — | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0924/scraper-help.log.gz)                  |
| RPC producers                   | 09:33   |    404 |       0 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0933/rpc-producers.log.gz)                 |
| Operator regex                  | 09:33   |     56 |       0 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0933/operator-regex.log.gz)                |
| WS/WSS                          | 09:33   |     22 |       0 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0933/ws-wss.log.gz)                        |
| Socket ownership                | 09:33   |      4 |       0 |      0 | [Log](../zig/bench/results/global-functional-diagnostics-20261106/0933/socket-owner.log.gz)                  |

These roots share imports; their counts must not be summed as unique tests. The native DB skip remains explicit. PostgreSQL additionally applied all 21 production migrations and passed 11 functional persistence cases on PostgreSQL 16.15 through native libpq; this is not a whole-agent replay. Its [integration result](../zig/bench/results/global-functional-diagnostics-20261106/0924/postgres/postgres-integration.json.gz) records the cases, image identity and isolation.

## Retained failures

| Attempt | Gate                 | Passed | Skipped | Failed | Recorded failure                                                                                                                                                                                |
| ------- | -------------------- | -----: | ------: | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09:13   | PostgreSQL aggregate |    419 |       2 |      3 | [EnvironmentVariableNotFound](../zig/bench/results/global-functional-diagnostics-20261106/0913/postgres/postgres-integration.log.gz) in RS256, ADC JWT and Google service-account fixture tests |
| 09:24   | RPC producers        |    399 |       2 |      3 | [EnvironmentVariableNotFound](../zig/bench/results/global-functional-diagnostics-20261106/0924/rpc-producers.log.gz) in the same three fixture tests                                            |

The failing commands invoked the PostgreSQL helper and RPC test root directly. The succeeding commands use [native_http_tests.py](../zig/tools/native_http_tests.py), which creates temporary Node-generated RSA fixtures and supplies `HYPERLANE_TEST_RSA_FIXTURE_DIR` plus the HTTP/2 fixture. Exact command/environment records survive in the [09:13](../zig/bench/results/global-functional-diagnostics-20261106/0913/all-manifest.json.gz), [09:24](../zig/bench/results/global-functional-diagnostics-20261106/0924/all-manifest.json.gz) and [09:33](../zig/bench/results/global-functional-diagnostics-20261106/0933/all-manifest.json.gz) manifests. The archive contains no generated private key fixtures.

## Source and artifact provenance

| Recorded map                   | Entries | 09:13 → 09:24 | 09:24 → 09:33 |
| ------------------------------ | ------: | ------------- | ------------- |
| Runtime source under `zig/src` |     612 | Identical     | Identical     |
| Tools                          |       8 | Identical     | Identical     |
| Integration                    |      21 | Identical     | Identical     |
| Build                          |       1 | Identical     | Identical     |
| Dockerfile                     |       1 | Identical     | Identical     |
| CI workflow                    |       1 | Changed       | Identical     |
| Recorded runtime artifacts     |       8 | Identical     | Identical     |
| Native archives                |       7 | Identical     | Identical     |
| Explicit environment           |       — | Identical     | Identical     |

All 644 source entries matched before/after each run. The only difference between the first two source maps is `.github/workflows/zig-agents.yml`, where the PostgreSQL fixture wrapper changed. The complete 09:24 and 09:33 maps match. This comparison covers the manifests' selected file extensions and paths, not an inferred complete repository tree.

The three emitted role binaries remain in the original 09:24 `roles/bin` directory. Their exact sizes and hashes are recorded in that run's manifest; an exact `/roles/` ignore keeps these generated binaries local. No binaries or caches were removed.

The [archive manifest](../zig/bench/results/global-functional-diagnostics-20261106/manifest.json) records raw and gzip hashes in chunks. All 31 gzip payloads match their original bytes, and the seven JSON convenience mirrors are exact and individually ignored inside the new archive directory. Original logs/manifests were not rewritten. [Archive verification](../zig/bench/results/global-functional-diagnostics-20261106/verification.json) records these checks. Process durations in the original manifests are diagnostic; they are not benchmark results.

## ReleaseFast default and subsequent fixture formatting

The completed 09:30 UTC ReleaseFast default root passed **738/738, zero skips**. Its [manifest](../zig/bench/results/global-functional-diagnostics-20261106/0930-fast/default-manifest.json.gz) records a stable source map matching 09:33 Safe; its [log](../zig/bench/results/global-functional-diagnostics-20261106/0930-fast/default.log.gz) remains exact. This establishes the default root only, not full Fast acceptance.

The global source-map extension filter excludes `.mjs`. After the Safe checks, normal formatting changed `cloud/testing/generate-rsa.mjs` and `cosmos/testing/grpc-server.mjs`; their post-format bytes and hashes are captured in the archive manifest. Those captures do not prove equivalence to pre-format bytes. The Fast default run preceded these formatting changes. Later native fixture checks require separate evidence; the live 09:36 Fast-native output was not read or archived here.

## Later frozen-source diagnostics: before final Aleo worker correction

The completed 10:25 Safe, 10:25 Fast default and 10:30 Fast native snapshots below **predate the final Aleo worker exec/RSS correction and its default-root test import**. They do not establish current all-source acceptance. Their 650-entry source-before maps match, as do the eight recorded runtime-artifact entries and seven native archives.

All eleven 10:25 Safe checks exited zero. Its outer runner rejected the source-stability invariant because `zig/tools/container_check.py` changed during the run; none of these check commands invokes that tool. The 10:30 Fast native check also exited zero but its outer runner rejected the same drift. The 10:25 Fast default run kept its selected map unchanged. The original `source_unchanged=false` flags are retained, not reclassified as a passing full run.

| Gate                 | Mode / start UTC | Passed | Skipped | Check exit | Evidence                                                                                                      |
| -------------------- | ---------------- | -----: | ------: | ---------: | ------------------------------------------------------------------------------------------------------------- |
| Default              | Safe 10:25       |    741 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/default.log.gz)                       |
| Native DB aggregate  | Safe 10:25       |  1,024 |       1 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/native-db.log.gz)                     |
| PostgreSQL aggregate | Safe 10:25       |    437 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/postgres/postgres-integration.log.gz) |
| Three role builds    | Safe 10:25       |      — |       — |          0 | [Manifest](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/all-manifest.json.gz)            |
| Validator help       | Safe 10:25       |      — |       — |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/validator-help.log.gz)                |
| Relayer help         | Safe 10:25       |      — |       — |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/relayer-help.log.gz)                  |
| Scraper help         | Safe 10:25       |      — |       — |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/scraper-help.log.gz)                  |
| RPC producers        | Safe 10:25       |    407 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/rpc-producers.log.gz)                 |
| Operator regex       | Safe 10:25       |     56 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/operator-regex.log.gz)                |
| WS/WSS               | Safe 10:25       |     22 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/ws-wss.log.gz)                        |
| Socket ownership     | Safe 10:25       |      4 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/socket-owner.log.gz)                  |
| Default              | Fast 10:25       |    741 |       0 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1025-fast-default/default.log.gz)               |
| Native DB aggregate  | Fast 10:30       |  1,024 |       1 |          0 | [Log](../zig/bench/results/global-frozen-diagnostics-20261106/1030-fast-native/native-db.log.gz)              |

Both native logs identify the sole skipped case as `evm_prepare_delegated_tests.test.opt-in loopback prepares actual repo Solidity without delivery or nonce mutation`. Coverage of that skipped case is not inferred. PostgreSQL also passed all 21 migrations and 11 persistence functional cases; its [integration result](../zig/bench/results/global-frozen-diagnostics-20261106/1025-safe/postgres/postgres-integration.json.gz) preserves the details. Counts overlap across roots and modes.

The [diagnostic archive](../zig/bench/results/global-frozen-diagnostics-20261106/manifest.json) preserves all 22 raw manifest/log payloads losslessly, with five exact, individually ignored JSON convenience mirrors. Original 10:25 Safe role binaries remain local under an exact `/roles/` ignore; all three match their recorded sizes and hashes. No executable was copied or deleted. The archive also records the old worker/root hashes and the later corrected hashes, explicitly distinguishing these stages. Functional log durations and RSS are diagnostic, not benchmark measurements.

Only the three completed directories were read. Live 10:55 outputs were not accessed or archived; later current-source acceptance remains separately owned.

## Stable-source negative snapshots: macOS worker network fixture

Both completed 10:55 runs stopped at the default root with **744/745 passed, one failure and zero skips**. Their 650-entry selected source maps remained unchanged and matched across modes. These are failed snapshots despite the original directories being named `global-source-accepted`.

| Run                |  Passed | Failed | Check exit | Evidence                                                                                                                                                                                                                                        |
| ------------------ | ------: | -----: | ---------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:55 Safe default | 744/745 |      1 |          1 | [Log](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/1055-safe/default.log.gz), [manifest](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/1055-safe/all-manifest.json.gz)                     |
| 10:55 Fast default | 744/745 |      1 |          1 | [Log](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/1055-fast-default/default.log.gz), [manifest](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/1055-fast-default/default-manifest.json.gz) |

The named failure is `aleo_vm_worker.test.Aleo worker network probe allowed loopback control and invalid inputs remain distinct`: expected `error.ConnectionRefused`, received `error.ConnectionTimedOut` on macOS. The later `rpc_budget` execution context in the log is not the named failing test. The Safe runner therefore reached none of its later native/PG/role gates; neither run emitted role binaries.

The [exact pre-correction worker source](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/source-before/aleo_vm_worker.zig.gz) matches both recorded source hashes. The [test-only diff](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/test-only-correction.diff.gz) makes the bound-but-unlistened socket refusal assertion Linux-only. Invalid-input and allowed-loopback checks remain; all bytes before that named test are identical, with no production policy change.

The [negative archive](../zig/bench/results/global-worker-network-fixture-diagnostics-20261106/manifest.json) retains seven exact gzip payloads and two individually ignored JSON mirrors. Corrected validation is separate. Live 11:10/11:15 outputs were not accessed, and this archive establishes no current all-source acceptance.

## Normal commit requirements

Read-only inspection of [pre-commit](../.husky/pre-commit), [lint-staged](../.lintstagedrc) and [formatter configuration](../.oxfmtrc.json):

- Keep hooks enabled. Local commits run staged gitleaks scanning and the additional private-key-pattern check before lint-staged. Do not use hook or key-check bypass flags.
- Lint-staged runs sequentially: JS/TS lint and formatting; infrastructure YAML sorting; Markdown/JSON/YAML formatting; Solidity formatting. The existing formatter configuration excludes generated `zig/bench/results/**`, preserving archived bytes while hooks still execute.
- If any Rust file is staged, the hook checks formatting for both `rust/main/Cargo.toml` and `rust/sealevel/Cargo.toml` using `cargo fmt --all --check`.
- The hook prints a changeset reminder. Repository instructions require changesets for changes to published TypeScript packages and prohibit `Co-Authored-By` trailers.

`gitleaks` and `pnpm` were found on PATH. No hook, staging, commit, compiler or test command was run for this archive task. Actual commit-hook acceptance remains a separate gate.

## Later integration guard correction

After the post-matrix gates, `baf14145ae` corrected three standalone Python process fixtures and added one pure guard test. The ten new and28existing pure controls passed in independent runs. The completed650-file maps above describe their original snapshots. Production build inputs and all22matrix products remain unchanged; new process proofs bind the corrected harness separately. Rust prebinds the processed counter and nonce gauge while Zig creates them on first update; both keep the confirmed-operation counter lazy. Absence remains explicit in the corrected guard and does not satisfy retirement.
