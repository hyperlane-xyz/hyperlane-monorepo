# Prepared paired benchmark environment

The sealed launcher and eight-command plan are **prepared, not executed**. All six required real functional gzip proofs were still missing at archival, so **timing was ineligible**. The earlier P2 global-proof gate finding is closed on the replacement; this is a preparation/review result, not functional or performance acceptance.

[Manifest](../../zig/bench/results/final-paired-environment-preflight/manifest.json), [current launcher](../../zig/bench/results/final-paired-environment-preflight/prepared/launcher.py.gz), [current plan](../../zig/bench/results/final-paired-environment-preflight/prepared/plan.json.gz), [all exact arguments/product pins](../../zig/bench/results/final-paired-environment-preflight/command-and-product-pins.json.gz), and [independent closure](../../zig/bench/results/final-paired-environment-preflight/review/independent-v3.md.gz).

The replacement is launcher `85c6abd706ba…` with plan `1794207fda86…`; complete chunked SHA identities and original paths are in the manifest. The archived [old launcher](../../zig/bench/results/final-paired-environment-preflight/historical/launcher.py.gz), [old plan](../../zig/bench/results/final-paired-environment-preflight/historical/plan.json.gz) and [first P2 review](../../zig/bench/results/final-paired-environment-preflight/historical/independent-P2.md.gz) preserve why it changed. The original gate used truthiness and lacked strict six-proof kind/binary checks before the earlier validator/scraper timings.

Before importing any benchmark module or calling any benchmark `main`, the replacement applies the existing strict pure relayer acceptance helper to three proof kinds in each of two modes. It requires exactly six distinct expected paths, `passed is True`, no errors, each mode's exact matrix relayer SHA, required three-ISM/batch/crash/WSS/public cases and actual per-ID 600-second evidence. The helper is AST-selected from its hash-pinned source rather than imported as a benchmark module. Missing, stale, malformed, short-policy or early-retirement proofs fail closed. The original relayer benchmark repeats its own strict gate later.

The [owner's 11 pure probes](../../zig/bench/results/final-paired-environment-preflight/pure/owner.log.gz) and [independent 11-probe run](../../zig/bench/results/final-paired-environment-preflight/pure/independent.log.gz) passed. They use synthetic files and AST-loaded helper functions; no agent, SDK, RPC or benchmark runs. Covered: valid modes/schemas, truthy success, errors, wrong native binary/mode, wrong kind, short policy, 599-second completion, missing file/mode, duplicate paths and corrupt gzip. They were not rerun for archival.

| Index | Role      | Mode        | Scenario | Pairs | Original workload                        |
| ----: | --------- | ----------- | -------- | ----: | ---------------------------------------- |
|     0 | validator | ReleaseSafe | majority |     5 | 32 catchup + 8 steady, 1000ms            |
|     1 | validator | ReleaseSafe | fallback |     5 | 32 catchup + 8 steady, 1000ms            |
|     2 | validator | ReleaseFast | majority |     5 | 32 catchup + 8 steady, 1000ms            |
|     3 | validator | ReleaseFast | fallback |     5 | 32 catchup + 8 steady, 1000ms            |
|     4 | scraper   | ReleaseSafe | single   |     5 | 100 backlog + 10 fresh, 250ms            |
|     5 | scraper   | ReleaseFast | single   |     5 | 100 backlog + 10 fresh, 250ms            |
|     6 | relayer   | ReleaseSafe | paired   |     5 | 32 catchup + 8 steady, 500ms; maxBatch 1 |
|     7 | relayer   | ReleaseFast | paired   |     5 | 32 catchup + 8 steady, 500ms; maxBatch 1 |

These remain the original command arguments and measurement code, apart from the intended V3 functional proof/provenance paths. Five pairs alternate Rust/Zig ordering, giving a 3/2 first-position split. The wrapper does not change configuration, fixed arrival schedules, metrics-only 600-second relayer settlement polling, wait4/RSS, samplers or polling loops. Fresh agent processes/databases are not a claim of cold filesystem or DSO page caches.

| Child                                     | Preserved baseline / added environment                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust relayer and auxiliary Rust validator | Original `CONFIG_FILES`-only dictionary                                                                                                          |
| Rust validator benchmark                  | Original defaults/curl dictionary                                                                                                                |
| Rust scraper                              | Original `PATH`, defaults and curl dictionary                                                                                                    |
| Zig only                                  | Exact matrix Starknet/Aleo crypto/Aleo VM/regex DSOs, both regex aliases, mode-correct Aleo worker and pinned libcrypto; conflicting values fail |

Original pinning keeps its existing pre-trial hash/copy checks. The constructor uses registered lexical paths and small dictionary/in-memory audit setup before the original constructor clock, with no new `.resolve`, executable hash, file open or audit serialization. The scraper's outer restart interval may include that small binding setup. Global `Popen` and `os.environ` are untouched; the migration helper's `PATH`/`DATABASE_URL` subprocess is unchanged. The audit is serialized and hashed after the original benchmark main exits, preserving measured raw metadata and supplying an explicit environment addendum.

The plan pins all 22 [final matrix products](final-build-matrix.md), the current harness source and original command files. The archive stores their descriptors and exact small input-source/JSON bytes, not executable/DSO/archive copies. Runtime product descriptors were compared with the sealed matrix identities; future execution must still perform real-file preflight hashing. The shared nonblocking functional/timing lock prevents overlap with the functional wrapper. Root must additionally finish all real functional proofs/provenance and establish global team quiet while preserving unrelated user workloads before serial invocation.

This archive ran no wrapper, benchmark, role, SDK, RPC, compiler or test. All launcher/plan/source/log originals remain unchanged. No Source implementation, central results/status ledger or global ignore was edited. Any later readiness or timing result requires its own completed evidence.
