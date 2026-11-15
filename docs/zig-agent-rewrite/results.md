# Benchmark results and historical snapshots

Current feature head: `e4318cacd8`. Three independently checked Linux cold trials completed at `dfc74532d4`; final timing acceptance remains held. Both SDK modes and the matching helper/tools/writers passed producer qualification. All six standalone proof groups passed within their stated source/product scope. The first Linux Cosmos-native retry exited successfully, but lacked a retained final proof and a timed restart window; the fresh run failed after six successful prerequisite phases, with its inner cause still unclassified. Metadata for ten paired runtime workloads and five pairs is prepared; no current paired timing main has run. Remaining native cases, final source checks and a quiet host still gate measurement. See [execution status](status.md). Numeric tables below retain their historical scope; no final comparison is claimed.

## Earlier execution snapshot — 2026-11-07 12:36 UTC

The current feature branch is pushed at `43e6466ca0`. Three fresh, full-feature Linux cold trials are scheduled; the first is running and no new timing is accepted yet. Matched runtime measurements remain held behind functional acceptance. The latest WSS attempt completed its 600-second retirement checks but failed the no-RPC-polling assertion because the fixture omitted the real publisher heartbeat. The corrected fixture passed 21 controls; a fresh proof is running. See [execution status](status.md) for the exact runtime/test-only source qualification and CI state. All numeric tables below retain their historical source and sample scope.

Latest committed production source is `3c545589de`. Fresh gas subscriptions now
explicitly request cursor zero. The new controller regression failed against the
old code, then passed in ReleaseSafe and ReleaseFast; wire/allocation checks also
passed in both modes. Both fresh compiler phases and independent eight-artifact
readback passed. All 22 broad correctness phases and independent readback passed,
including the actual native bridge fixture in both modes. The fresh WSS proof
passed v3 live delivery and restart message delivery, then failed waiting for
restart subscriptions. A fresh diagnostic captured a fixture scenario-slot race:
an unsubscribed transport consumed the restart slot before a healthy connection
subscribed and replayed. That original timeout remains preserved. Native/process and
paired-runtime acceptance remain pending. These correctness checks receive no
performance credit.

Preceding production source `57710ae024` fixed shared announcement
replay progression after the standalone batch-preparation failure. Focused
regressions passed in both modes. Both fresh compiler phases exited zero; a
separate postflight accepted the eight artifacts after the supervisor's final
idle check failed. The first default ReleaseSafe command passed 757/757 tests;
its supervisor stopped at another global idle check. That failure is retained.
The corrected supervisor subsequently passed all 20 commands in both modes,
with independent source, product, dependency and process readback. The refreshed
fixture helper also passed its six commands, including Clippy. These correctness
builds receive no performance credit. Native/process and paired-runtime acceptance must use the
replacement products. Earlier results below retain their original source scope.

The replacement Cosmos-native ReleaseSafe case passed all eight deliveries,
production-duration confirmation, native signature/SQL/Rust readback and
same-database restart checks. The first complete standalone ReleaseSafe recovery
proof also passed, including four-message batch replay and injected WAL-crash
recovery without duplicate submission. After correcting fixture startup scenario
sequencing, the WSS rerun exposed a production gas-stream bootstrap defect:
fresh Zig subscriptions omitted cursor zero and tailed existing gas history.
A bounded diagnostic confirmed the actual request/marker/authority behavior;
the fix and focused regressions are committed as described above. These are correctness results;
current paired-runtime measurements remain pending.

Prior production source `d51ca8d668` passed fresh
role/worker builds and all 20 correctness checks. The fourth Cosmos-native run
passed the initial 600-second and stopped-storage checks, then exposed a Rust
helper log-reader deadlock during restart. Its owned processes were stopped and
the helper correction passed its focused tests, build and Clippy. The fifth run
committed eight native relayer transactions but failed the observer's strict
sampling bound and was stopped cleanly. Native-node acceptance, full-duration
process proofs and matched runtime measurements remain pending. Failed attempts are
retained as diagnostic evidence. See the [current correctness report](combined-production-correctness-d51.md).

The sixth Cosmos-native ReleaseSafe case passed delivery, production-duration
confirmation, stopped-storage and same-database restart checks. Eight agent and
three fixture parent waits returned zero; cleanup left no owned resources.
The corresponding standalone proof passed its initial stages, then failed batch
preparation and prompted the `57710ae024` fix. These remain correctness results
for the original products. Final paired measurements remain pending.

The tables below describe **historical candidates**. They do not establish
current performance or complete parity. URL normalization now retains a fifth
Rust native library; the final dependency-inclusive build trial must include its
cost. Keep all historical improvements, regressions and scope qualifications.
See [current acceptance status](status.md) for the active candidate.

## Latest lifetime-fixed build observations

Build and worker-sensitive functional gates passed for the reviewed runtime.
The V5 full proof failed a fixture batch-membership assumption after its initial
and batch settlement substages passed; [the failed attempt](final-relayer-batch-membership-diagnostic.md)
remains preserved. The deterministic test/fixture correction is committed at
`f7bdda8cf6`, with fresh broad gates. Production binaries and timings remain the
actual measured `8872c5e470` artifacts. No full process or paired-runtime acceptance
is implied by these rows. Full provenance and preserved historical snapshots:
[build matrix](final-lifetime-build-matrix.md),
[functional validation](final-lifetime-functional-validation.md).

All phases: n=1, shared Apple Silicon host, jobs=2, native CPU. New Zig build source: `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b`. Rust/native prerequisites are reused measurements at `516bdf42909cd258f6f9cf423878c7ea8bea1683`; mixed totals are arithmetic, not a new dependency-inclusive trial.

| Scope                                            | Reused Rust release | New Zig ReleaseSafe | New Zig ReleaseFast |
| ------------------------------------------------ | ------------------: | ------------------: | ------------------: |
| Compiler-cold measured wall (s; scopes differ)   |            2090.970 |             118.230 |             115.070 |
| Separately measured native/FFI prerequisites (s) |   Included by Cargo |             728.987 |             728.987 |
| Mixed-run dependency-inclusive wall (s)          |            2090.970 |             847.218 |             844.057 |
| Rust / mixed-run Zig wall                        |               1.00× |               2.47× |               2.48× |
| Mixed-run user + system CPU (s)                  |            3944.320 |            1443.814 |            1464.506 |
| No-change wall (s)                               |               2.386 |               0.519 |               0.492 |

Compiler-cold Rust includes its Cargo dependency work; new Zig phases reuse the seven static archives and four bridge DSOs. Fresh Zig phases also build the Aleo VM worker. Downloads, SDK/toolchain installation, Aleo parameter downloads and runtime proving are excluded.

| Phase / provenance                   | Wall (s) | User / system CPU (s) | Max child RSS (MiB) | Sampled tree peak (MiB) | Samples |
| ------------------------------------ | -------: | --------------------: | ------------------: | ----------------------: | ------: |
| native-sdk-cold (reused 516)         |  246.051 |      359.771 / 28.591 |               631.3 |                  1211.1 |     995 |
| regex-cold (reused 516)              |    9.971 |        11.982 / 0.315 |               350.5 |                   580.5 |      42 |
| starknet-cold (reused 516)           |   30.151 |        45.214 / 2.729 |               671.8 |                   708.3 |     127 |
| aleo-crypto-cold (reused 516)        |   61.621 |       105.052 / 7.478 |               417.9 |                   734.0 |     259 |
| aleo-vm-cold (reused 516)            |  381.194 |      651.051 / 23.659 |              3231.0 |                  3344.5 |    1583 |
| Rust cold (reused 516)               | 2090.970 |    3797.981 / 146.339 |              4276.7 |                  7218.2 |    8621 |
| Rust no-change (reused 516)          |    2.386 |         0.486 / 0.607 |               343.5 |                   341.8 |      10 |
| Zig ReleaseSafe-cold (new 8872)      |  118.230 |      195.597 / 12.375 |              2832.2 |                  3735.6 |     488 |
| Zig ReleaseSafe-no-change (new 8872) |    0.519 |         0.124 / 0.262 |                30.5 |                    54.4 |       2 |
| Zig ReleaseFast-cold (new 8872)      |  115.070 |      215.776 / 12.888 |              2883.5 |                  4579.0 |     467 |
| Zig ReleaseFast-no-change (new 8872) |    0.492 |         0.133 / 0.273 |                30.5 |                    49.9 |       2 |

Max-child RSS is wait4/rusage, not the sum of processes. Tree RSS is sampled every 200 ms and can miss a peak; no-change phases have only two samples. Phase CPU totals can be added; phase memory peaks cannot.

| Phase / provenance                   | Load1 before → after | Free disk before → after (GiB) |
| ------------------------------------ | -------------------: | -----------------------------: |
| native-sdk-cold (reused 516)         |         6.37 → 46.37 |                40.830 → 40.595 |
| regex-cold (reused 516)              |        46.37 → 39.78 |                40.776 → 40.745 |
| starknet-cold (reused 516)           |        39.78 → 25.77 |                40.776 → 40.632 |
| aleo-crypto-cold (reused 516)        |        25.77 → 13.58 |                40.798 → 40.467 |
| aleo-vm-cold (reused 516)            |         13.13 → 4.59 |                40.777 → 39.977 |
| Rust cold (reused 516)               |          4.59 → 6.05 |                40.571 → 35.806 |
| Rust no-change (reused 516)          |          6.05 → 5.64 |                35.806 → 35.805 |
| Zig ReleaseSafe-cold (new 8872)      |         15.14 → 5.54 |                32.351 → 32.116 |
| Zig ReleaseSafe-no-change (new 8872) |          5.54 → 5.42 |                32.116 → 32.116 |
| Zig ReleaseFast-cold (new 8872)      |          5.42 → 8.09 |                32.325 → 32.049 |
| Zig ReleaseFast-no-change (new 8872) |          8.09 → 8.09 |                32.049 → 32.049 |

All three load averages are retained in raw results. Load is observed shared-host context, not a controlled workload or a correction factor. The later Zig-only run launched with 32.351GiB free under its reviewed 16 GiB floor; the original native/Rust trial retains its 40 GiB floor. All four 2 GiB runtime guards remained clear.

| Installed artifact                       | Reused Rust bytes | New Safe bytes | New Fast bytes |
| ---------------------------------------- | ----------------: | -------------: | -------------: |
| relayer                                  |       184,851,248 |     15,004,648 |     14,935,992 |
| validator                                |       158,046,144 |     13,623,240 |     13,591,416 |
| scraper                                  |        74,778,368 |      3,247,352 |      3,212,824 |
| Three roles total                        |       417,675,760 |     31,875,240 |     31,740,232 |
| Aleo VM worker                           |          In agent |        403,672 |        188,232 |
| Listed roles + worker + four bridge DSOs |       417,675,760 |     84,874,496 |     84,524,048 |

Byte sizes are installed file sizes, without stripping or normalization. The last row is not a complete deployment bundle: system libraries, configuration, parameters and other runtime assets are excluded.

| Reused standalone prerequisite |      Bytes |
| ------------------------------ | ---------: |
| libbz2.a                       |     70,328 |
| liblz4.a                       |    171,664 |
| librocksdb.a                   | 23,612,472 |
| libsnappy.a                    |     46,848 |
| libz.a                         |     85,440 |
| libziggy_rocks_abi.a           |      2,248 |
| libzstd.a                      |    913,048 |
| libziggy_aleo_crypto.dylib     |    884,096 |
| libziggy_aleo_vm.dylib         | 49,766,864 |
| libziggy_regex.dylib           |  1,328,224 |
| libziggy_starknet_crypto.dylib |    616,400 |

| Untimed reclamation                         | Free bytes recovered | Elapsed (s) | Preserved roles/worker |
| ------------------------------------------- | -------------------: | ----------: | ---------------------: |
| After zig-ReleaseSafe-three-agent-no-change |          224,059,392 |       0.197 |     4 hashes unchanged |
| After zig-ReleaseFast-three-agent-no-change |          237,166,592 |       0.192 |     4 hashes unchanged |

Only the marked follow-up local/global compiler caches were reclaimed after each no-change phase. Both installed paths and hardlink pins remain. User-global cache was untouched. These reclamation intervals are excluded from build timings.

Both matching-mode rebuilt workers passed745default tests with zero skips. Earlier516/e0timings and raw artifacts remain below and in their original archives. Shared-host load differs between observations; no timing change is attributed solely to a code fix.

## Admission-fix build observations (historical failed V4 snapshot)

The canonical admission fix, broad acceptance and supplemental exact-worker gates
passed before the new process proofs began. These build rows are complete;
process-proof and paired-runtime acceptance remain open. The complete source and
artifact readback is in [the build report](final-admission-build-matrix.md).

All phases: n=1, shared Apple Silicon host, jobs=2, native CPU. New Zig build source: `e0b95ebf0189e3cc75c3ae1e48a2d9581006e8d0`. Rust/native prerequisites are reused measurements at `516bdf42909cd258f6f9cf423878c7ea8bea1683`; mixed totals are arithmetic, not a new dependency-inclusive trial.

| Scope                                            | Reused Rust release | New Zig ReleaseSafe | New Zig ReleaseFast |
| ------------------------------------------------ | ------------------: | ------------------: | ------------------: |
| Compiler-cold measured wall (s; scopes differ)   |            2090.970 |             131.128 |             121.737 |
| Separately measured native/FFI prerequisites (s) |   Included by Cargo |             728.987 |             728.987 |
| Mixed-run dependency-inclusive wall (s)          |            2090.970 |             860.116 |             850.724 |
| Rust / mixed-run Zig wall                        |               1.00× |               2.43× |               2.46× |
| Mixed-run user + system CPU (s)                  |            3944.320 |            1466.857 |            1475.971 |
| No-change wall (s)                               |               2.386 |               0.491 |               0.492 |

Compiler-cold Rust includes its Cargo dependency work; new Zig phases reuse the seven static archives and four bridge DSOs. Fresh Zig phases also build the Aleo VM worker. Downloads, SDK/toolchain installation, Aleo parameter downloads and runtime proving are excluded.

| Phase / provenance                 | Wall (s) | User / system CPU (s) | Max child RSS (MiB) | Sampled tree peak (MiB) | Samples |
| ---------------------------------- | -------: | --------------------: | ------------------: | ----------------------: | ------: |
| native-sdk-cold (reused516)        |  246.051 |      359.771 / 28.591 |               631.3 |                  1211.1 |     995 |
| regex-cold (reused516)             |    9.971 |        11.982 / 0.315 |               350.5 |                   580.5 |      42 |
| starknet-cold (reused516)          |   30.151 |        45.214 / 2.729 |               671.8 |                   708.3 |     127 |
| aleo-crypto-cold (reused516)       |   61.621 |       105.052 / 7.478 |               417.9 |                   734.0 |     259 |
| aleo-vm-cold (reused516)           |  381.194 |      651.051 / 23.659 |              3231.0 |                  3344.5 |    1583 |
| Rust cold (reused516)              | 2090.970 |    3797.981 / 146.339 |              4276.7 |                  7218.2 |    8621 |
| Rust no-change (reused516)         |    2.386 |         0.486 / 0.607 |               343.5 |                   341.8 |      10 |
| Zig ReleaseSafe-cold (new e0)      |  131.128 |      216.509 / 14.506 |              2801.3 |                  3809.2 |     523 |
| Zig ReleaseSafe-no-change (new e0) |    0.491 |         0.126 / 0.260 |                30.6 |                    54.8 |       2 |
| Zig ReleaseFast-cold (new e0)      |  121.737 |      226.437 / 13.692 |              2911.3 |                  4600.1 |     495 |
| Zig ReleaseFast-no-change (new e0) |    0.492 |         0.130 / 0.269 |                30.5 |                    49.4 |       2 |

Max-child RSS is wait4/rusage, not the sum of processes. Tree RSS is sampled every200ms and can miss a peak; no-change phases have only two samples. Phase CPU totals can be added; phase memory peaks cannot.

| Phase / provenance                 | Load1 before → after | Free disk before → after (GiB) |
| ---------------------------------- | -------------------: | -----------------------------: |
| native-sdk-cold (reused516)        |         6.37 → 46.37 |                40.830 → 40.595 |
| regex-cold (reused516)             |        46.37 → 39.78 |                40.776 → 40.745 |
| starknet-cold (reused516)          |        39.78 → 25.77 |                40.776 → 40.632 |
| aleo-crypto-cold (reused516)       |        25.77 → 13.58 |                40.798 → 40.467 |
| aleo-vm-cold (reused516)           |         13.13 → 4.59 |                40.777 → 39.977 |
| Rust cold (reused516)              |          4.59 → 6.05 |                40.571 → 35.806 |
| Rust no-change (reused516)         |          6.05 → 5.64 |                35.806 → 35.805 |
| Zig ReleaseSafe-cold (new e0)      |         5.29 → 11.98 |                34.151 → 33.900 |
| Zig ReleaseSafe-no-change (new e0) |        11.98 → 11.98 |                33.900 → 33.900 |
| Zig ReleaseFast-cold (new e0)      |        11.98 → 15.97 |                34.109 → 33.838 |
| Zig ReleaseFast-no-change (new e0) |        15.97 → 15.17 |                33.838 → 33.838 |

All three load averages are retained in raw results. Load is observed shared-host context, not a controlled workload or a correction factor. The later Zig-only run launched with 34.152GiB free under its reviewed16GiB floor; the original native/Rust trial retains its40GiB floor. All four2GiB runtime guards remained clear.

| Installed artifact                       | Reused Rust bytes | New Safe bytes | New Fast bytes |
| ---------------------------------------- | ----------------: | -------------: | -------------: |
| relayer                                  |       184,851,248 |     15,004,440 |     14,935,784 |
| validator                                |       158,046,144 |     13,623,032 |     13,591,208 |
| scraper                                  |        74,778,368 |      3,247,336 |      3,212,808 |
| Three roles total                        |       417,675,760 |     31,874,808 |     31,739,800 |
| Aleo VM worker                           |          In agent |        403,656 |        188,232 |
| Listed roles + worker + four bridge DSOs |       417,675,760 |     84,874,048 |     84,523,616 |

Byte sizes are installed file sizes, without stripping or normalization. The last row is not a complete deployment bundle: system libraries, configuration, parameters and other runtime assets are excluded.

| Reused standalone prerequisite |      Bytes |
| ------------------------------ | ---------: |
| libbz2.a                       |     70,328 |
| liblz4.a                       |    171,664 |
| librocksdb.a                   | 23,612,472 |
| libsnappy.a                    |     46,848 |
| libz.a                         |     85,440 |
| libziggy_rocks_abi.a           |      2,248 |
| libzstd.a                      |    913,048 |
| libziggy_aleo_crypto.dylib     |    884,096 |
| libziggy_aleo_vm.dylib         | 49,766,864 |
| libziggy_regex.dylib           |  1,328,224 |
| libziggy_starknet_crypto.dylib |    616,400 |

| Untimed reclamation                         | Free bytes recovered | Elapsed (s) | Preserved roles/worker |
| ------------------------------------------- | -------------------: | ----------: | ---------------------: |
| After zig-ReleaseSafe-three-agent-no-change |          224,141,312 |       0.184 |     4 hashes unchanged |
| After zig-ReleaseFast-three-agent-no-change |          237,502,464 |       0.323 |     4 hashes unchanged |

Only the marked follow-up local/global compiler caches were reclaimed after each no-change phase. Both installed paths and hardlink pins remain. User-global cache was untouched. These reclamation intervals are excluded from build timings.

The earlier Zig build observations appear in the original matrix below. Both rebuilt workers passed their actual authorization/proving/sandbox suites through all745default tests per mode, with zero skips. Neither this build table nor those unit suites replace the six exact-binary600-second process proofs.

## Original cold and no-change build matrix (historical)

[Reproduction, artifact hashes and qualifications](final-build-matrix.md). All 11 phases passed with unchanged selected source hashes. Rust explicitly enabled Aleo for all three roles. Both builds used native CPU targeting and two jobs. Zig Safe and Fast differ from Rust release in safety checks. Cached downloads and toolchains are excluded; compiler caches were fresh. The five prerequisites were built once and reused across modes. No-change means the same command without source edits; it does not measure rebuilding an edited source file.

All values: n=1 per phase, shared host; no uncertainty interval. Dependency-inclusive Zig = five standalone prerequisites + mode agent phase.

| Build scope                                      |      Rust release | Zig ReleaseSafe | Zig ReleaseFast |
| ------------------------------------------------ | ----------------: | --------------: | --------------: |
| Agent phase wall (s; Rust includes dependencies) |           2090.97 |          107.45 |          112.87 |
| Separately measured native/FFI prerequisites (s) | Included by Cargo |          728.99 |          728.99 |
| Dependency-inclusive cold wall (s)               |           2090.97 |          836.44 |          841.86 |
| Rust / dependency-inclusive Zig wall             |             1.00× |           2.50× |           2.48× |
| Dependency-inclusive user + system CPU (s)       |           3944.32 |         1449.49 |         1462.44 |
| No-change wall (s)                               |             2.386 |           0.510 |           0.501 |

| Phase                                 | Wall (s) | User / system CPU (s) | Max child RSS (MiB) | Sampled tree peak (MiB) |
| ------------------------------------- | -------: | --------------------: | ------------------: | ----------------------: |
| native-sdk-cold                       |   246.05 |        359.77 / 28.59 |               631.3 |                  1211.1 |
| optional-regex-cold                   |     9.97 |          11.98 / 0.32 |               350.5 |                   580.5 |
| optional-starknet-cold                |    30.15 |          45.21 / 2.73 |               671.8 |                   708.3 |
| optional-aleo-crypto-cold             |    61.62 |         105.05 / 7.48 |               417.9 |                   734.0 |
| optional-aleo-vm-cold                 |   381.19 |        651.05 / 23.66 |              3231.0 |                  3344.5 |
| rust-three-agent-cold                 |  2090.97 |      3797.98 / 146.34 |              4276.7 |                  7218.2 |
| rust-three-agent-no-change            |     2.39 |           0.49 / 0.61 |               343.5 |                   341.8 |
| zig-ReleaseSafe-three-agent-cold      |   107.45 |        200.37 / 13.28 |              2824.4 |                  4529.5 |
| zig-ReleaseSafe-three-agent-no-change |     0.51 |           0.13 / 0.27 |                30.5 |                    54.2 |
| zig-ReleaseFast-three-agent-cold      |   112.87 |        213.80 / 12.80 |              2904.7 |                  4612.1 |
| zig-ReleaseFast-three-agent-no-change |     0.50 |           0.13 / 0.25 |                30.5 |                    73.8 |

| Installed executable                    | Rust release bytes | Zig Safe bytes | Zig Fast bytes |
| --------------------------------------- | -----------------: | -------------: | -------------: |
| relayer                                 |        184,851,248 |     14,986,280 |     14,917,784 |
| validator                               |        158,046,144 |     13,622,696 |     13,590,872 |
| scraper                                 |         74,778,368 |      3,247,320 |      3,212,792 |
| Three roles total                       |        417,675,760 |     31,856,296 |     31,721,448 |
| Aleo VM worker                          |           In agent |        403,640 |        188,216 |
| Three roles + worker + four bridge DSOs |        417,675,760 |     84,855,520 |     84,505,248 |

| Standalone Zig prerequisite artifact |      Bytes |
| ------------------------------------ | ---------: |
| libbz2.a                             |     70,328 |
| liblz4.a                             |    171,664 |
| librocksdb.a                         | 23,612,472 |
| libsnappy.a                          |     46,848 |
| libz.a                               |     85,440 |
| libziggy_rocks_abi.a                 |      2,248 |
| libzstd.a                            |    913,048 |
| libziggy_aleo_crypto.dylib           |    884,096 |
| libziggy_aleo_vm.dylib               | 49,766,864 |
| libziggy_regex.dylib                 |  1,328,224 |
| libziggy_starknet_crypto.dylib       |    616,400 |

| Phase                                 | 1-minute load before / after | Free disk before / after (GiB) | RSS samples |
| ------------------------------------- | ---------------------------: | -----------------------------: | ----------: |
| native-sdk-cold                       |                 6.37 / 46.37 |                  40.83 / 40.59 |         995 |
| optional-regex-cold                   |                46.37 / 39.78 |                  40.78 / 40.75 |          42 |
| optional-starknet-cold                |                39.78 / 25.77 |                  40.78 / 40.63 |         127 |
| optional-aleo-crypto-cold             |                25.77 / 13.58 |                  40.80 / 40.47 |         259 |
| optional-aleo-vm-cold                 |                 13.13 / 4.59 |                  40.78 / 39.98 |        1583 |
| rust-three-agent-cold                 |                  4.59 / 6.05 |                  40.57 / 35.81 |        8621 |
| rust-three-agent-no-change            |                  6.05 / 5.64 |                  35.81 / 35.80 |          10 |
| zig-ReleaseSafe-three-agent-cold      |                  5.64 / 4.55 |                  39.96 / 39.72 |         440 |
| zig-ReleaseSafe-three-agent-no-change |                  4.55 / 4.55 |                  39.72 / 39.72 |           2 |
| zig-ReleaseFast-three-agent-cold      |                  4.55 / 4.24 |                  39.92 / 39.67 |         463 |
| zig-ReleaseFast-three-agent-no-change |                  4.24 / 4.24 |                  39.67 / 39.67 |           2 |

The shared-host load varied; a recorded snapshot included unrelated `system_profiler`, Warp and WindowServer activity. Its effect is unmeasured. Max-child and sampled tree RSS are separate observations; tree RSS can double-count shared pages and miss short peaks. Serial phase peaks must not be summed. Bundle bytes exclude system libraries, proving parameters, credentials and database contents. The seven static native archives are build inputs, not additional installed runtime bytes. Native/FFI dependencies remain; no zero-dependency claim applies.

## Protocol kernels

These CPU protocol kernels do not establish whole-agent parity or speedups.

Apple M3 Pro; Rust 1.98.0 native CPU release/thin-LTO/one codegen unit; Zig 0.15.2 native CPU. Nine samples per row, alternating language order. Samples run without concurrent compiler jobs; ordinary OS workloads remain uncontrolled. Raw samples, dispersion, source/binary identities, RSS and commands are in the adjacent JSON artifacts. The original source inventory also hashed 1,856 generated build files before timing; those extra provenance entries are retained and annotated. Hashing is outside measured loops. The runner now prunes generated directories before walking source files.

| Kernel                    | Body bytes | Rust ns/op (Safe run) | Zig ReleaseSafe ns/op | Rust/Zig | Rust ns/op (Fast run) | Zig ReleaseFast ns/op | Rust/Zig |
| ------------------------- | ---------: | --------------------: | --------------------: | -------: | --------------------: | --------------------: | -------: |
| `message_id`              |          0 |                 194.4 |                 228.6 |    0.851 |                 168.1 |                 160.1 |    1.050 |
| `message_id`              |         64 |                 393.1 |                 418.8 |    0.939 |                 325.4 |                 313.9 |    1.037 |
| `message_id`              |      1,024 |               1,637.6 |               1,793.3 |    0.913 |               1,427.6 |               1,406.4 |    1.015 |
| `message_id`              |     65,536 |              80,043.8 |              98,195.8 |    0.815 |              73,305.2 |              71,173.8 |    1.030 |
| `message_roundtrip_owned` |          0 |                 194.5 |                 219.3 |    0.887 |                 189.3 |                 177.5 |    1.067 |
| `message_roundtrip_owned` |         64 |                 370.0 |                 398.0 |    0.930 |                 367.6 |                 339.8 |    1.082 |
| `message_roundtrip_owned` |      1,024 |               1,454.8 |               1,685.6 |    0.863 |               1,514.8 |               1,444.1 |    1.049 |
| `message_roundtrip_owned` |     65,536 |              76,826.8 |             103,042.2 |    0.746 |              78,688.5 |              85,721.3 |    0.918 |
| `merkle_ingest`           |          0 |                 163.6 |                 186.9 |    0.875 |                 165.2 |                 163.4 |    1.011 |
| `merkle_ingest_root`      |          0 |               5,378.9 |               6,069.4 |    0.886 |               5,068.0 |               5,061.8 |    1.001 |

Rust/Zig >1 means Zig was faster. Rust is measured independently in each run because host frequency/load varies. All results, including regressions, are retained. ReleaseSafe is the acceptance comparison. ReleaseFast removes Zig runtime safety checks; Rust release disables overflow checks by default and has a different memory-safety model. Allocators differ (Rust system allocator, Zig smp_allocator).

ReleaseSafe was slower in all ten cases: Rust/Zig0.746–0.939. ReleaseFast mostly achieved small 1–8% improvements, with near-parity Merkle ingest+root and a 64 KiB owned-roundtrip regression (Rust/Zig0.918). These measurements do not support a large runtime speedup claim.

| Cold protocol harness build | Rust seconds | Zig seconds |
| --------------------------- | -----------: | ----------: |
| ReleaseSafe                 |       26.244 |       7.655 |
| ReleaseFast                 |       26.289 |       4.510 |

Both harness builds used fresh compiler-target/cache directories with downloaded dependencies cached. The Rust path dependency compiles the complete core crate; Zig lazily compiles the referenced benchmark declarations. Feature sets differ. These timings cannot establish a whole-agent build-time improvement.

Correctness gates passed 716 message inputs (639 valid / 77 truncated) including canonical encoding, IDs, Merkle roots/counts, checkpoint signing hashes and EIP-191 digests; 73 key/digest cases covered 146 cross-implementation signature recoveries and six malformed-signature rejections per implementation.

Separate actual-ethers fixtures cover 51 legacy/EIP-1559 transaction encodings/hashes and 21 signature-recovery acceptance cases. Those fixtures validate protocol behavior, not RPC or delivery operation. See [methodology](benchmarks.md) for reproduction and remaining whole-agent acceptance work.

### Protocol harness resources

Nine samples per implementation/case, same historical shared-host runs and CPU-kernel limits as the timing table above. Values are median per-process peak RSS in bytes; ratio = Zig/Rust. They describe harness processes, not daemon memory.

| Mode        | Kernel                    | Body bytes | Rust RSS bytes | Zig RSS bytes | Zig/Rust |
| ----------- | ------------------------- | ---------: | -------------: | ------------: | -------: |
| ReleaseSafe | `message_id`              |          0 |      2,129,920 |     1,949,696 |    0.915 |
| ReleaseSafe | `message_id`              |         64 |      2,129,920 |     1,998,848 |    0.938 |
| ReleaseSafe | `message_id`              |      1,024 |      2,129,920 |     1,998,848 |    0.938 |
| ReleaseSafe | `message_id`              |     65,536 |      2,211,840 |     2,015,232 |    0.911 |
| ReleaseSafe | `message_roundtrip_owned` |          0 |      2,162,688 |     1,949,696 |    0.902 |
| ReleaseSafe | `message_roundtrip_owned` |         64 |      2,211,840 |     2,031,616 |    0.919 |
| ReleaseSafe | `message_roundtrip_owned` |      1,024 |      2,179,072 |     2,031,616 |    0.932 |
| ReleaseSafe | `message_roundtrip_owned` |     65,536 |      2,375,680 |     2,162,688 |    0.910 |
| ReleaseSafe | `merkle_ingest`           |          0 |      2,129,920 |     1,949,696 |    0.915 |
| ReleaseSafe | `merkle_ingest_root`      |          0 |      2,129,920 |     1,949,696 |    0.915 |
| ReleaseFast | `message_id`              |          0 |      2,129,920 |     1,867,776 |    0.877 |
| ReleaseFast | `message_id`              |         64 |      2,129,920 |     1,916,928 |    0.900 |
| ReleaseFast | `message_id`              |      1,024 |      2,129,920 |     1,916,928 |    0.900 |
| ReleaseFast | `message_id`              |     65,536 |      2,211,840 |     1,933,312 |    0.874 |
| ReleaseFast | `message_roundtrip_owned` |          0 |      2,162,688 |     1,867,776 |    0.864 |
| ReleaseFast | `message_roundtrip_owned` |         64 |      2,211,840 |     1,949,696 |    0.881 |
| ReleaseFast | `message_roundtrip_owned` |      1,024 |      2,179,072 |     1,949,696 |    0.895 |
| ReleaseFast | `message_roundtrip_owned` |     65,536 |      2,375,680 |     2,080,768 |    0.876 |
| ReleaseFast | `merkle_ingest`           |          0 |      2,129,920 |     1,867,776 |    0.877 |
| ReleaseFast | `merkle_ingest_root`      |          0 |      2,129,920 |     1,867,776 |    0.877 |

[ReleaseSafe raw samples](../../zig/bench/results/release-safe/protocol-kernels.json); [ReleaseFast raw samples](../../zig/bench/results/release-fast/protocol-kernels.json).

## Production packed prover kernels

Rust directly includes the production `agents/relayer/src/prover/packed.rs`; Zig uses the executable relayer prover. All 82 boundary and historical-proof queries matched, including every sibling and an independent production IncrementalMerkle prefix root. Nine alternating samples per language/case; tree construction is outside proof timing. Ingestion includes maintaining the current root.

These later measurements ran with team compiler jobs paused; unrelated user workloads continued. Load averages were high and changed during the run (Safe1-minute9.77→26.79;Fast26.79→17.50). Treat small differences cautiously; no exclusive-host or statistical significance claim.

| Kernel                    |  Leaves | Rust Safe-run ns/op | Zig ReleaseSafe ns/op | Rust/Zig | Rust Fast-run ns/op | Zig ReleaseFast ns/op | Rust/Zig |
| ------------------------- | ------: | ------------------: | --------------------: | -------: | ------------------: | --------------------: | -------: |
| `packed_ingest`           |   8,192 |             5,776.7 |               5,466.3 |    1.057 |             5,669.4 |               4,991.8 |    1.136 |
| `packed_ingest`           | 131,072 |             7,181.4 |               6,059.8 |    1.185 |             5,616.0 |               4,941.8 |    1.136 |
| `packed_proof_latest`     |   4,096 |               121.4 |                 140.7 |    0.863 |                87.3 |                  87.1 |    1.002 |
| `packed_proof_latest`     |  65,536 |               148.6 |                 191.1 |    0.777 |               123.9 |                 120.9 |    1.025 |
| `packed_proof_historical` |   4,096 |             1,572.3 |               1,540.8 |    1.020 |             1,551.3 |               1,375.3 |    1.128 |
| `packed_proof_historical` |  65,536 |             2,409.2 |               2,342.7 |    1.028 |             2,331.6 |               2,100.2 |    1.110 |

ReleaseSafe ingestion improved in these samples, while latest-root proof generation regressed (Rust/Zig0.777–0.863). Historical Safe proofs were close. Fast ingestion/historical proofs improved; latest proofs were close. Full raw samples, RSS, dispersion, source/binary hashes and load are retained in `packed-releasesafe` and `packed-releasefast`. None establishes whole-agent throughput.

### Packed-prover process resources

Median per-process peak RSS across the same nine samples per language/case, in bytes; ratio = Zig/Rust. Ingestion leaves are the final iteration counts. Shared-host and CPU-kernel qualifications above apply.

| Mode        | Kernel                    |  Leaves | Rust RSS bytes | Zig RSS bytes | Zig/Rust |
| ----------- | ------------------------- | ------: | -------------: | ------------: | -------: |
| ReleaseSafe | `packed_ingest`           |   8,192 |      2,572,288 |     2,637,824 |    1.025 |
| ReleaseSafe | `packed_ingest`           | 131,072 |     10,469,376 |    10,649,600 |    1.017 |
| ReleaseSafe | `packed_proof_latest`     |   4,096 |      2,326,528 |     2,359,296 |    1.014 |
| ReleaseSafe | `packed_proof_latest`     |  65,536 |      6,258,688 |     6,422,528 |    1.026 |
| ReleaseSafe | `packed_proof_historical` |   4,096 |      2,310,144 |     2,359,296 |    1.021 |
| ReleaseSafe | `packed_proof_historical` |  65,536 |      6,258,688 |     6,422,528 |    1.026 |
| ReleaseFast | `packed_ingest`           |   8,192 |      2,572,288 |     2,588,672 |    1.006 |
| ReleaseFast | `packed_ingest`           | 131,072 |     10,469,376 |    10,600,448 |    1.013 |
| ReleaseFast | `packed_proof_latest`     |   4,096 |      2,310,144 |     2,310,144 |    1.000 |
| ReleaseFast | `packed_proof_latest`     |  65,536 |      6,258,688 |     6,373,376 |    1.018 |
| ReleaseFast | `packed_proof_historical` |   4,096 |      2,310,144 |     2,310,144 |    1.000 |
| ReleaseFast | `packed_proof_historical` |  65,536 |      6,258,688 |     6,373,376 |    1.018 |

[ReleaseSafe raw samples](../../zig/bench/results/packed-releasesafe/packed-prover.json); [ReleaseFast raw samples](../../zig/bench/results/packed-releasefast/packed-prover.json).

## Full Rust build baseline

The configured default-feature relayer, validator, and scraper release build
succeeded in **1,017.13 seconds** (16m57s), Rust 1.98.0, four jobs, invoked from
`rust/main` so its `--cfg tokio_unstable` configuration applied. This reused the
existing target after a prior invocation missed that configuration; it is not
a pristine cold build. Raw log and binary SHA-256 identities are in
`zig/bench/results/rust-full-build-configured.{log,json}`.

| Historical build attempt          |  Seconds | Outcome         | Qualification                                                      |
| --------------------------------- | -------: | --------------- | ------------------------------------------------------------------ |
| Repository-root Cargo invocation  | 1,099.97 | Failed, exit101 | Wrong working directory omitted `tokio_unstable`; invocation error |
| Configured `rust/main` invocation | 1,017.13 | Succeeded       | Reused prior target; default features; not cold                    |

| Actual Rust binary |       Bytes |
| ------------------ | ----------: |
| relayer            | 110,418,192 |
| validator          |  86,492,544 |
| scraper            |  62,846,864 |

The Zig snapshot at that time had a smaller feature set. These sizes and timings do not support
an equivalent-feature whole-agent comparison.

### Historical binary, build and dependency inventory

Each build row is one attempt. Protocol sizes are harness binaries from the kernel snapshots. Package count is the recorded Cargo-tree normal-dependency union, with no target filter; it is not an external-library or LOC count. There is no matched Zig agent resource/build comparison here.

| Measurement                                   | Rust / result | Zig / result | Artifact and limit                                                                                                              |
| --------------------------------------------- | ------------: | -----------: | ------------------------------------------------------------------------------------------------------------------------------- |
| Protocol ReleaseSafe harness binary bytes     |       836,528 |      372,792 | [Raw harness inventory](../../zig/bench/results/release-safe/protocol-kernels.json)                                             |
| Protocol ReleaseFast harness binary bytes     |       836,528 |      161,304 | [Raw harness inventory](../../zig/bench/results/release-fast/protocol-kernels.json)                                             |
| Configured three-agent build peak RSS (bytes) | 2,886,713,344 |            — | [Succeeded; reused target; default features; not cold](../../zig/bench/results/rust-full-build-configured.json)                 |
| Wrong-CWD build peak RSS (bytes)              | 2,543,108,096 |            — | [Failed exit101; invocation error, no successful baseline](../../zig/bench/results/rust-root-cwd-attempt.json)                  |
| Normal-dependency union package count         |         1,120 |            — | [Default-feature relayer/validator/scraper union, including roots/local crates](../../zig/bench/results/rust-dependencies.json) |

## Latest source inventory

The [8872inventory](final-lifetime-source-inventory.md) covers2,430files and all38
preserved/current product hashes. Classifications remain physical/lexical, with
no equivalent-feature LOC ratio. Prior snapshots remain separately archived.

| Scoped category                                                | e0 snapshot | 8872 snapshot |
| -------------------------------------------------------------- | ----------: | ------------: |
| All Zig-tree source files                                      |         648 |           650 |
| All physical lines                                             |     148,645 |       149,170 |
| Implementation-labelled physical lines, including inline tests |      98,608 |        98,832 |
| Dedicated test/benchmark/integration physical lines            |      42,106 |        42,407 |
| Native lock union entries, not a runtime dependency graph      |         446 |           446 |
| External entries in that union                                 |         440 |           440 |
| Public proving parameter bytes, separate assets                |  79,506,114 |    79,506,114 |

## Admission-fix source and dependency inventory (historical snapshot)

Snapshot at `e0b95ebf01`; physical lines and lexical test blocks. These categories
are not equivalent feature scopes, so no Rust/Zig LOC reduction ratio is claimed.
The [full inventory](final-admission-source-inventory.md) retains all file hashes,
classification rules, per-crate counts and prior snapshots.

| Scope                                                                 | Files / entries |          Physical lines / bytes |
| --------------------------------------------------------------------- | --------------: | ------------------------------: |
| Tracked Rust-main Rust source                                         |       832 files |                   223,043 lines |
| Generated untracked Rust-main ABI source, separately identified       |        36 files |                    21,770 lines |
| Zig implementation-labelled source                                    |       373 files |                    98,608 lines |
| Inline test blocks within that implementation category                |  Included above |                    16,652 lines |
| Implementation category outside inline test blocks, including helpers |  Included above |                    81,956 lines |
| Zig dedicated tests, benchmarks and integration                       |       224 files |                    42,106 lines |
| Zig build and operational tools                                       |         9 files |                     1,546 lines |
| Independent reference harness                                         |        31 files |                     4,607 lines |
| Native helper source                                                  |        10 files |                     1,625 lines |
| Native vendored source                                                |          1 file |                       153 lines |
| All Zig source categories                                             |       648 files |                   148,645 lines |
| Native lockfile union, not a target-runtime dependency graph          |    21 lockfiles | 446 unique entries;440 external |
| Public Aleo proving parameters, separate external assets              |         9 files |                79,506,114 bytes |

The runtime rewrite retains native database/compression libraries and four Rust
SDK/regex bridge DSOs. The new roles and workers use the corrected source; the
unchanged SDK products retain their original build provenance. This is not a
zero-dependency implementation. The complete658-file selected input maps include
ignored vendored dependency inputs; tracked inputs bind to the commit, and other
inputs bind to their exact recorded hashes and setup/lock evidence.

## Validation evidence

| Gate                               | Observed result                                                                                                                                                                                                              | Limit                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol differential              | 716 inputs; encoding, ID, roots/counts, checkpoint/EIP-191 hashes match production Rust                                                                                                                                      | CPU primitives only                                                                                                                                                |
| Independent crypto                 | 146 cross-recoveries; 6 malformed-signature checks per implementation                                                                                                                                                        | No cryptographic/side-channel audit                                                                                                                                |
| Actual ethers transaction/recovery | 51 transaction + 21 signature acceptance fixtures                                                                                                                                                                            | No provider, nonce, fee-policy parity                                                                                                                              |
| Local Solidity contracts           | Delivered MessageIdMultisig, MerkleRootMultisig, Routing→Aggregation; each replay idempotent; durable crash recovery case passed                                                                                             | Local EVM correctness, not cross-VM or whole-agent performance                                                                                                     |
| Ethereum capture                   | Finalized blocks 26,348,808–26,348,815; 1 dispatch + 1 insertion; encoding/ID match Rust                                                                                                                                     | Bounded read-only protocol parity, not sustained mainnet tracking                                                                                                  |
| Rust DB codec corpus               | 93 production Encode/Decode and serde fixtures match Zig; fixed-record truncations rejected                                                                                                                                  | Codecs only                                                                                                                                                        |
| Durable validator                  | Native service/RocksDB restart, publication replay, 137-index history, authenticated snapshot bootstrap/history repair, cloud digest adapters; 114 passed/11 optional native skips in current standalone imported suite      | Focused imported tests include dependency tests; no sustained mainnet or live cloud proof                                                                          |
| Concrete EVM validator             | Disposable Anvil: real announcement, 3 Rust-matching checkpoints, restart/bootstrap, hanging first RPC with fixed denominator, lying event reader suffix repair, growing-count signed-prefix fork + durable halt             | Native daemon additionally announces via lander, writes 3 checkpoint objects, drains on SIGTERM, restarts with unchanged objects/nonce; no sustained mainnet proof |
| Native RocksDB                     | 28 tests pass including typed seeks and agent operation indices; 93 codec fixtures; production Rust created 12 rows, Zig read/mutated them, Rust typed reads verified                                                        | No complete migration or process-kill crash campaign                                                                                                               |
| Postgres                           | Actual Rust init-db applied 21 migrations to disposable Postgres16; native async transport/scraper suite 73 passed/1 unrelated optional skip through libpq16.3; deadline/cancel/stalled-auth/lost-COMMIT + bounded DNS tests | Lost write/COMMIT acknowledgement requires durable reconciliation; hostname resolver adds one TCP preconnect; no production DB touched                             |
| Complete agent replacement         | **Incomplete**                                                                                                                                                                                                               | All configured chains, live signer/storage/provider adapters, operational parity and matched full-agent benchmarks remain required                                 |

Artifacts: `evm-integration.json`, `ethereum-shadow-parity.json`,
`native-db-tests.log`, and mode-specific kernel JSON under `zig/bench/results`.

## Provisional actual EVM validator comparison

Five alternating process pairs, 32-message backlog followed by eight independent
one-second dispatch arrivals. Every one of 400 checkpoint objects matches actual
Rust roots/message IDs and its signature recovers the public signer through
production ethers. Both daemons perform real onchain self-announcement. These
initial samples include compiler contention (load 4.1→42.9), incomplete telemetry
parity and different durability policies; they are not an all-feature-equivalent
whole-agent speedup result. A coordinated team-idle rerun remains required.

| Metric                    |     Rust |      Zig | Zig/Rust |
| ------------------------- | -------: | -------: | -------: |
| Startup/catchup (ms)      |  3,468.8 |  2,865.6 |    0.826 |
| Signing freshness (ms)    |  1,974.4 |    526.8 |    0.267 |
| Maximum freshness (ms)    |  3,006.1 |  1,026.9 |    0.342 |
| Daemon CPU (s)            | 0.261497 | 1.010726 |    3.865 |
| Peak RSS (MB)             |    36.52 |    38.86 |    1.064 |
| Application RPC requests  |       96 |      461 |    4.802 |
| Process wall time (s)     |  12.6633 |  11.7199 |    0.925 |
| Fresh phase duration (ms) |  9,065.3 |  8,828.5 |    0.974 |
| Shutdown (ms)             |    15.06 |    13.34 |    0.886 |

Values are medians except maximum freshness, which is the maximum across the recorded samples.

The lower startup/freshness times accompany higher CPU, memory and RPC costs.
CPU/RSS cover the entire measured process; catchup/freshness stop on complete
checkpoint/history/latest/snapshot publication. Counts include ancillary RPCs
and retries. Actual raw samples, process exit status and binary identities:
`zig/bench/results/whole-validator-initial/validator.json`. Methodology and known
feature differences are in `benchmarks.md`; the feedback-paced smoke is separate
nonacceptance evidence.

### Initial validator RPC and CPU breakdown

The same five shared-host initial process pairs, with the incomplete telemetry and durability differences above. Method medians need not sum to the median total. These counts are not CPU-percentage attribution.

| Metric                               | Rust median | Zig median |
| ------------------------------------ | ----------: | ---------: |
| `eth_blockNumber` requests           |          26 |         21 |
| `eth_call` requests                  |          37 |         95 |
| `eth_chainId` requests               |           1 |          2 |
| `eth_estimateGas` requests           |           2 |          1 |
| `eth_feeHistory` requests            |           8 |          5 |
| `eth_getBalance` requests            |           1 |          0 |
| `eth_getBlockByNumber` requests      |           7 |        267 |
| `eth_getLogs` requests               |           8 |         49 |
| `eth_getTransactionByHash` requests  |           1 |          0 |
| `eth_getTransactionCount` requests   |           1 |         19 |
| `eth_getTransactionReceipt` requests |           2 |          1 |
| `eth_sendRawTransaction` requests    |           2 |          1 |
| Startup RPC requests                 |          38 |        208 |
| User CPU (s)                         |    0.191774 |   0.486966 |
| System CPU (s)                       |    0.069723 |   0.523760 |

[Raw per-method analysis](../../zig/bench/results/whole-validator-initial/rpc-analysis.json); [Original process samples](../../zig/bench/results/whole-validator-initial/validator.json).

Additional cache snapshots preserve the original row. Five alternating pairs each:

| Mode after batch reuse | Metric                    |     Rust |      Zig | Zig/Rust |
| ---------------------- | ------------------------- | -------: | -------: | -------: |
| ReleaseSafe            | Startup/catchup (ms)      |  4,299.9 |  2,379.1 |    0.553 |
| ReleaseSafe            | Signing freshness (ms)    |  2,003.6 |    428.4 |    0.214 |
| ReleaseSafe            | Maximum freshness (ms)    |  3,016.4 |    881.1 |    0.292 |
| ReleaseSafe            | Daemon CPU (s)            | 0.213003 | 0.541885 |    2.544 |
| ReleaseSafe            | Peak RSS (MB)             |    36.14 |    38.55 |    1.067 |
| ReleaseSafe            | Application RPC requests  |       98 |      303 |    3.092 |
| ReleaseSafe            | Process wall time (s)     |  13.3653 |  11.1615 |    0.835 |
| ReleaseSafe            | Fresh phase duration (ms) |  9,054.4 |  8,747.5 |    0.966 |
| ReleaseSafe            | Shutdown (ms)             |    12.01 |    27.66 |    2.303 |
| ReleaseFast            | Startup/catchup (ms)      |  4,020.5 |  2,330.8 |    0.580 |
| ReleaseFast            | Signing freshness (ms)    |  2,003.4 |    346.5 |    0.173 |
| ReleaseFast            | Maximum freshness (ms)    |  3,067.2 |    773.7 |    0.252 |
| ReleaseFast            | Daemon CPU (s)            | 0.248565 | 0.323587 |    1.302 |
| ReleaseFast            | Peak RSS (MB)             |    36.72 |    21.43 |    0.584 |
| ReleaseFast            | Application RPC requests  |       94 |      301 |    3.202 |
| ReleaseFast            | Process wall time (s)     |  13.4703 |  11.0467 |    0.820 |
| ReleaseFast            | Fresh phase duration (ms) |  9,108.6 |  8,654.2 |    0.950 |
| ReleaseFast            | Shutdown (ms)             |    14.09 |    13.77 |    0.977 |

All nine reported summary metrics are retained for each mode; maximum freshness is a maximum, all other rows are medians.

CPU and RPC costs still exceed Rust in both modes. Source fences and signing
checks remain enabled. These snapshots are provisional under shared host load;
see `whole-validator-summary.md` for the full before/after table and raw manifests.
The bounded native Postgres suite's newer 73-pass/1-skip evidence is preserved
separately under `zig/bench/results/postgres-bounded`, retaining the initial DB
artifacts.

## Historical validator diagnostics and failed smoke

These local EVM/signing/storage snapshots used a shared host, incomplete telemetry parity and different durability policies. Ratios are Zig/Rust; RSS uses decimal MB. They are historical diagnostics, not final matched whole-agent acceptance. Maximum freshness is a maximum; other rows are medians.

### Feedback-paced smoke2

One process pair: 4 backlog messages + 2 feedback-paced arrivals. All 6 checkpoints/signatures verified per implementation. Corrected signature oracle; arrival pacing depends on completion, so this is nonacceptance evidence.

| Metric                    |     Rust |      Zig | Zig/Rust |
| ------------------------- | -------: | -------: | -------: |
| Startup/catchup (ms)      |  3,307.9 |  2,230.1 |    0.674 |
| Signing freshness (ms)    |  1,994.4 |     49.3 |    0.025 |
| Maximum freshness (ms)    |  1,998.5 |     60.8 |    0.030 |
| Daemon CPU (s)            | 0.183390 | 0.140675 |    0.767 |
| Peak RSS (MB)             |    35.78 |    38.03 |    1.063 |
| Application RPC requests  |       58 |      125 |    2.155 |
| Process wall time (s)     |   7.3465 |   2.3866 |    0.325 |
| Fresh phase duration (ms) |  4,023.5 |    130.8 |    0.033 |
| Shutdown (ms)             |    15.08 |    25.66 |    1.702 |

[Raw samples, scope and binary identities](../../zig/bench/results/whole-validator-smoke2/validator.json).

### Profile-initial

One process pair: 128 backlog messages + 4 independent one-second arrivals. All 132 checkpoints/signatures verified per implementation. A separate five-second macOS sampler observed the original Zig binary; sleeping threads and profiler overhead are included, so stack counts are not CPU percentages.

| Metric                    |     Rust |      Zig | Zig/Rust |
| ------------------------- | -------: | -------: | -------: |
| Startup/catchup (ms)      |  5,379.3 |  6,172.3 |    1.147 |
| Signing freshness (ms)    |  1,789.4 |    192.7 |    0.108 |
| Maximum freshness (ms)    |  2,776.8 |  1,067.9 |    0.385 |
| Daemon CPU (s)            | 0.230521 | 1.185754 |    5.144 |
| Peak RSS (MB)             |    36.73 |    38.90 |    1.059 |
| Application RPC requests  |       76 |      835 |   10.987 |
| Process wall time (s)     |  11.2263 |  10.4596 |    0.932 |
| Fresh phase duration (ms) |  5,831.9 |  4,272.2 |    0.733 |
| Shutdown (ms)             |    15.09 |    15.08 |    0.999 |

[Raw samples, scope and binary identities](../../zig/bench/results/whole-validator-profile-initial/validator.json).

### Failed validator oracle attempt

| Artifact                                                                              | Completed samples | Recorded result                                                                                               |
| ------------------------------------------------------------------------------------- | ----------------: | ------------------------------------------------------------------------------------------------------------- |
| [whole-validator-smoke](../../zig/bench/results/whole-validator-smoke/validator.json) |                 0 | Rust sample0 oracle failed `odd byte encoding`; harness signature-hex validation failure, no benchmark result |

## Native generic validator correctness

`validator-generic-integration.json` covers the actual generic Role with native
Tron HTTP/ABI, local repository Solidity state, insertion-only indexing, RocksDB,
signer and local checkpoint publisher. Three roots/IDs match production Rust;
restart signs nothing twice; authenticated snapshot repairs old history. A lying
insertion endpoint triggers independently authenticated replay and unsigned
suffix recovery through a different indexer. Both a4-leaf same-block fork and a
mixed3/4-count quorum fork halt before any new checkpoint signature. Native
`chain-votes-integration.json` separately proves27 actual HTTP slots start before
waiting when the first9 hang. This is local correctness evidence, not an actual
Tron consensus node, all-VM daemon acceptance or a performance result.

## Public signature recovery optimization

The whole-validator CPU profile identified public secp256k1 recovery work. An
equivalent standard-library double-base multiplication reduces that public group
work while retaining scalar/recovery-ID/high-s checks. Nine alternating fresh-process
pairs ×200 operations per variant, shared host:

| Kernel                         | Mode        |    Before |   After | Before/after |
| ------------------------------ | ----------- | --------: | ------: | -----------: |
| recover                        | ReleaseSafe |   581.7µs | 170.3µs |        3.416 |
| recover                        | ReleaseFast |   590.7µs | 173.4µs |        3.405 |
| sign helper including recovery | ReleaseSafe | 1,198.5µs | 518.0µs |        2.314 |
| sign helper including recovery | ReleaseFast | 1,137.4µs | 511.1µs |        2.226 |

Raw process samples, identical checksums, source/binary hashes and load metadata:
`zig/bench/results/signature-optimization/results.json`; reproducible runner:
`python3 zig/bench/signature.py --help`. These compare two Zig primitive versions,
not Rust or complete agent throughput. Final matched validator process timing
must be rerun after the operational telemetry attachment and this optimization.

Median [minimum, maximum] per-operation times below are µs across the same nine fresh-process samples per variant (200 operations/process). Ratio = before/after; these are Zig-only primitive measurements on a shared host. The artifact records no signature-harness build times.

| Kernel                         | Mode        |             Before µs [min, max] |        After µs [min, max] | Before/after |
| ------------------------------ | ----------- | -------------------------------: | -------------------------: | -----------: |
| recover                        | ReleaseSafe |       581.704 [578.359, 615.682] | 170.267 [170.031, 174.411] |        3.416 |
| sign helper including recovery | ReleaseSafe | 1,198.515 [1,015.137, 1,252.714] | 518.017 [483.109, 550.002] |        2.314 |
| recover                        | ReleaseFast |       590.668 [588.909, 593.075] | 173.446 [172.807, 177.173] |        3.405 |
| sign helper including recovery | ReleaseFast |   1,137.446 [978.700, 1,255.391] | 511.096 [465.689, 549.476] |        2.226 |

[Raw signature dispersion and provenance](../../zig/bench/results/signature-optimization/results.json).

The read-only Ethereum observer has a frozen first-hour manifest:3,661 active
seconds,294 contiguous finalized blocks26,350,112–26,350,405,24 dispatches and24
insertions;0 endpoint failures. Message codec/ID, contract count deltas, insertion
indices, parent/header hash fences and cross-window continuity were checked.
Raw windows and digests: `ethereum-shadow-sustained/first-hour-manifest.json`.
This verifies sustained read-only protocol capture, not validator signing,
relayer delivery or complete agent parity. The first failed HTTP403 attempt is
retained separately and is not acceptance evidence.

The later capture retains the separate first-hour snapshot above. This is correctness observation, not signing, publication, delivery, throughput, CPU, RSS or full-agent parity evidence.

| Evidence                                                                                                          | Active seconds | Finalized blocks                        | Dispatches / insertions | Error limit                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | -------------: | --------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Five-hour read-only Ethereum capture](../../zig/bench/results/ethereum-shadow-sustained/five-hour-manifest.json) |       19,024.7 | 1,571 contiguous; 26,350,112–26,351,682 | 147 / 147               | Successful windows contiguous; no parity fatal; HTTP forwarding failures 0; last retryable loop error `EndpointError`, total loop retries unmeasured |

Final local scraper process evidence is archived separately in
`scraper-telemetry-process` and `scraper-telemetry-fatal`. Source metrics GET/HEAD
and same-port restart pass; each of5 DB streams grows2→3 while receipts stall.
A subsequent actual canonical fork below the published frontier exits1 with
`ScraperPublishedReorg` in244ms, drains jobs, preserves3 published rows and sets
the DB halt flag. These are correctness fixtures on migrated disposable PG16,
not scraper performance comparisons or production rollout evidence.

Validator source-interface and concurrency acceptance is separate from the
historical process timings. `validator-http-parallel-process.json` records the
current pinned RPC-mode executable: readiness/EigenNode/Merkle GET/HEAD and error
semantics, physical RPC metrics,3 Rust-matching objects during a20s receipt stall,
clean SIGTERM and restart without new signatures/nonce. Production Axum fixtures
cover29 route cases. `validator-parallel-http-integration.json` proves4 overlapping
physical KMS requests,8 unique Rust-matching checkpoints and0 restart signatures.
Native local publication/restart tests report157 passes/16 optional skips. Current
parallel publication uses a persistent bounded native thread pool with256KiB
stack/worker rather than Rust async tasks. Final Safe/Fast process measurements
are still required; these correctness fixtures do not imply a speedup.

`scraper-receipt-fanout/` retains the newer independent receipt-enrichment
snapshot: actual PG16.15/21 migrations,258 native passes/36 optional skips,
11 SQL cases;4 receipt jobs/domain let healthy neighboring receipts store/link
while one hash stalls. All5 streams grow2→3 across same-port restart; SIGTERM19ms
and SIGINT28ms drain; a published canonical fork exits1 in214ms, preserving3
rows. This remains correctness evidence under shared load. The pinned revision
uses synchronous HEAD work and does not establish independent head-worker or
performance acceptance. Older snapshots remain separate.

`scraper-head-owners/` records the subsequent9-chain process fixture:8 identity
RPCs physically stall while the healthy9th stores fresh insertion20 in309ms.
Observed process thread count66 and RSS23,104KiB include9 lazy HEAD owners with
1MiB stacks plus RPC pools. Receipt concurrency reaches4 and healthy neighboring
receipts link while one hash stalls. Five streams grow2→3 across same-port restart;
SIGTERM7ms/SIGINT4ms and nine-chain shutdown37ms drain; a published fork exits1
in283ms. This isolated run explicitly used `postgres.py --process-only`: native
tests were neither compiled nor executed, and only5 stated server-side SQL smoke
checks ran after21 production migrations. The prior full native test successes
and subsequent unrelated full-run metadata failure are separate evidence. These
correctness deadlines and observed memory/threads are not paired throughput
measurements.

## Historical whole-scraper comparisons

Five balanced Rust/Zig process pairs per snapshot, shared host, local EVM and migrated disposable PostgreSQL. These precede later SQL/idle-wait, concurrency and telemetry fixes. They are not final-source or all-feature performance acceptance. Medians below retain both database versions; CPU is measured directly, not summed from separate median components.

### PostgreSQL 18.6

| Metric                                     | Rust median | Zig median | Zig/Rust |
| ------------------------------------------ | ----------: | ---------: | -------: |
| Startup (ms)                               |     1,028.5 |      142.7 |    0.139 |
| Catchup (ms)                               |     5,268.3 |    5,257.8 |    0.998 |
| Fresh event to durable storage (ms)        |     3,309.0 |    6,837.9 |    2.066 |
| Restart catchup (ms)                       |     5,189.0 |    6,306.3 |    1.215 |
| First-process user CPU (s)                 |    0.123550 |   0.444788 |    3.600 |
| First-process system CPU (s)               |    0.051467 |   0.641195 |   12.458 |
| First-process total CPU (s)                |    0.174717 |   1.093020 |    6.256 |
| First-process peak RSS (bytes)             |  30,752,768 | 39,256,064 |    1.277 |
| SIGTERM drain (ms)                         |        14.5 |       15.1 |    1.038 |
| Restart user CPU (s)                       |    0.081964 |   0.073226 |    0.893 |
| Restart system CPU (s)                     |    0.021888 |   0.135810 |    6.205 |
| Restart peak RSS (bytes)                   |  29,605,888 | 37,093,376 |    1.253 |
| SIGINT drain (ms)                          |        14.4 |       25.8 |    1.795 |
| Total daemon RPC requests                  |         431 |        445 |    1.032 |
| Fixture RPC requests (excluded)            |         214 |        214 |    1.000 |
| Measured process wall time (s)             |   15.807550 |  23.512697 |    1.487 |
| Entire fresh phase (ms)                    |    10,294.2 |   18,024.6 |    1.751 |
| Head progress beside stalled receipts (ms) |       803.1 |    4,216.5 |    5.250 |

[Raw samples, dispersion, process exits, fixture changes and source identities](../../zig/bench/results/scraper-process-finalhead-pg18-nonquiet/scraper-process.json.gz).

### PostgreSQL 16.15

| Metric                                     | Rust median | Zig median | Zig/Rust |
| ------------------------------------------ | ----------: | ---------: | -------: |
| Startup (ms)                               |     1,009.5 |      206.2 |    0.204 |
| Catchup (ms)                               |     5,217.3 |    5,314.6 |    1.019 |
| Fresh event to durable storage (ms)        |     3,115.2 |    6,265.5 |    2.011 |
| Restart catchup (ms)                       |     5,218.4 |    6,325.1 |    1.212 |
| First-process user CPU (s)                 |    0.121650 |   0.457445 |    3.760 |
| First-process system CPU (s)               |    0.049965 |   0.663814 |   13.286 |
| First-process total CPU (s)                |    0.169105 |   1.121259 |    6.631 |
| First-process peak RSS (bytes)             |  30,654,464 | 39,403,520 |    1.285 |
| SIGTERM drain (ms)                         |        14.0 |       15.2 |    1.087 |
| Restart user CPU (s)                       |    0.081226 |   0.074054 |    0.912 |
| Restart system CPU (s)                     |    0.021209 |   0.134291 |    6.332 |
| Restart peak RSS (bytes)                   |  29,523,968 | 36,995,072 |    1.253 |
| SIGINT drain (ms)                          |        14.1 |       26.7 |    1.886 |
| Total daemon RPC requests                  |         422 |        445 |    1.055 |
| Fixture RPC requests (excluded)            |         214 |        215 |    1.005 |
| Measured process wall time (s)             |   15.688205 |  23.487880 |    1.497 |
| Entire fresh phase (ms)                    |    10,269.7 |   17,990.2 |    1.752 |
| Head progress beside stalled receipts (ms) |       820.4 |    4,136.2 |    5.042 |

[Raw samples, dispersion, process exits, fixture changes and source identities](../../zig/bench/results/scraper-process-finalhead-pg16-15-nonquiet/scraper-process.json.gz).

Zig freshness and CPU regressed in both snapshots. Later correctness evidence includes SQL work reduced from494 queries to8 and independent head/receipt owners; that attribution is not a paired performance measurement. Restart fixtures expire the stopped writer lease explicitly, so these rows do not measure natural lease expiry. Runtime/durability, instrumentation and shared-host differences remain qualified in the raw manifests.

### Earlier completed PG18.6 snapshots

All three snapshots passed their process fixtures: PG18.6 with 21 production migrations, three transactions per event group, one single-consensus RPC endpoint and three DB connections. Fresh latency includes all four confirmed streams and receipt enrichment. Historical shared-host results remain separate from finalhead and final-source acceptance; port changes are recorded without a causal attribution. Ratio = Zig/Rust; rows are medians, including directly measured total CPU. Each also dispatches one restart event group.

#### Initial2 PG18.6

Five alternating pairs, 24 backlog + 8 one-second fresh event groups; restart metrics port reallocated.

| Metric                                     |       Rust |        Zig | Zig/Rust |
| ------------------------------------------ | ---------: | ---------: | -------: |
| Startup (ms)                               |    1,328.7 |      349.4 |    0.263 |
| Catchup (ms)                               |    5,531.1 |    5,409.2 |    0.978 |
| Fresh event to durable storage (ms)        |    3,170.5 |    6,972.1 |    2.199 |
| Restart catchup (ms)                       |    5,221.0 |    6,348.9 |    1.216 |
| First-process user CPU (s)                 |   0.148468 |   0.727766 |    4.902 |
| First-process system CPU (s)               |   0.057704 |   1.003605 |   17.392 |
| First-process total CPU (s)                |   0.206136 |   1.731371 |    8.399 |
| First-process peak RSS (bytes)             | 30,769,152 | 43,057,152 |    1.399 |
| SIGTERM drain (ms)                         |       15.1 |       27.2 |    1.800 |
| Restart user CPU (s)                       |   0.099119 |   0.112170 |    1.132 |
| Restart system CPU (s)                     |   0.031837 |   0.179440 |    5.636 |
| Restart peak RSS (bytes)                   | 29,573,120 | 37,109,760 |    1.255 |
| SIGINT drain (ms)                          |       12.9 |       27.9 |    2.160 |
| Total daemon RPC requests                  |        422 |        443 |    1.050 |
| Fixture RPC requests (excluded)            |        214 |        214 |    1.000 |
| Measured process wall time (s)             |  16.467893 |  22.891590 |    1.390 |
| Entire fresh phase (ms)                    |   10,392.9 |   16,755.1 |    1.612 |
| Head progress beside stalled receipts (ms) |      685.6 |    4,087.0 |    5.962 |

[Raw samples, dispersion, exits and identities](../../zig/bench/results/scraper-process-initial2-pg18-restartport-nonquiet/scraper-process.json.gz).

#### Smoke3 PG18.6

One pair, 3 backlog + 2 fresh event groups at 300 ms; restart metrics port reallocated.

| Metric                                     |       Rust |        Zig | Zig/Rust |
| ------------------------------------------ | ---------: | ---------: | -------: |
| Startup (ms)                               |    1,629.8 |      150.5 |    0.092 |
| Catchup (ms)                               |    5,819.5 |    5,202.8 |    0.894 |
| Fresh event to durable storage (ms)        |    4,484.4 |    4,555.5 |    1.016 |
| Restart catchup (ms)                       |    5,165.1 |    6,308.6 |    1.221 |
| First-process user CPU (s)                 |   0.088323 |   0.143364 |    1.623 |
| First-process system CPU (s)               |   0.036238 |   0.205767 |    5.678 |
| First-process total CPU (s)                |   0.124561 |   0.349131 |    2.803 |
| First-process peak RSS (bytes)             | 29,802,496 | 37,715,968 |    1.266 |
| SIGTERM drain (ms)                         |       14.6 |       13.6 |    0.930 |
| Restart user CPU (s)                       |   0.077919 |   0.059732 |    0.767 |
| Restart system CPU (s)                     |   0.018623 |   0.102618 |    5.510 |
| Restart peak RSS (bytes)                   | 29,327,360 | 37,011,456 |    1.262 |
| SIGINT drain (ms)                          |       13.8 |       15.2 |    1.100 |
| Total daemon RPC requests                  |        108 |        114 |    1.056 |
| Fixture RPC requests (excluded)            |         55 |         52 |    0.945 |
| Measured process wall time (s)             |  11.039772 |  10.503815 |    0.951 |
| Entire fresh phase (ms)                    |    5,047.1 |    5,122.2 |    1.015 |
| Head progress beside stalled receipts (ms) |      775.0 |    4,233.4 |    5.463 |

[Raw samples, dispersion, exits and identities](../../zig/bench/results/scraper-process-smoke3-pg18-nonquiet/scraper-process.json.gz).

#### Smoke4 PG18.6

One pair, 3 backlog + 2 fresh event groups at 300 ms; same-port restart.

| Metric                                     |       Rust |        Zig | Zig/Rust |
| ------------------------------------------ | ---------: | ---------: | -------: |
| Startup (ms)                               |    1,640.6 |      298.7 |    0.182 |
| Catchup (ms)                               |    5,864.5 |    5,318.0 |    0.907 |
| Fresh event to durable storage (ms)        |    4,476.2 |    8,056.2 |    1.800 |
| Restart catchup (ms)                       |    5,193.3 |    6,337.5 |    1.220 |
| First-process user CPU (s)                 |   0.084915 |   0.171571 |    2.021 |
| First-process system CPU (s)               |   0.032801 |   0.286896 |    8.747 |
| First-process total CPU (s)                |   0.117716 |   0.458467 |    3.895 |
| First-process peak RSS (bytes)             | 29,884,416 | 37,765,120 |    1.264 |
| SIGTERM drain (ms)                         |       10.6 |       43.1 |    4.059 |
| Restart user CPU (s)                       |   0.079516 |   0.068861 |    0.866 |
| Restart system CPU (s)                     |   0.021016 |   0.125192 |    5.957 |
| Restart peak RSS (bytes)                   | 29,474,816 | 37,011,456 |    1.256 |
| SIGINT drain (ms)                          |       15.0 |       15.1 |    1.005 |
| Total daemon RPC requests                  |        108 |        118 |    1.093 |
| Fixture RPC requests (excluded)            |         52 |         52 |    1.000 |
| Measured process wall time (s)             |  11.140314 |  14.211723 |    1.276 |
| Entire fresh phase (ms)                    |    5,087.5 |    8,664.7 |    1.703 |
| Head progress beside stalled receipts (ms) |      839.6 |    4,178.7 |    4.977 |

[Raw samples, dispersion, exits and identities](../../zig/bench/results/scraper-process-smoke4-sameport-pg18-nonquiet/scraper-process.json.gz).

### Incomplete and failed scraper attempts

Historical local process attempts on the same shared host. Raw sample counts include failed trials; completed counts are per implementation. No paired ratios are inferred from incomplete runs.

| Artifact                                                                                                                                               | Recorded status | Raw samples / completed trials | Recorded failure or limit                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| [scraper-process-initial-pg18-restartport-nonquiet](../../zig/bench/results/scraper-process-initial-pg18-restartport-nonquiet/scraper-process.json.gz) | `running`       | 9 / no summary                 | Incomplete PG18.6 attempt; `failures=[]`; not passed                                                |
| [scraper-process-smoke-pg16-nonquiet](../../zig/bench/results/scraper-process-smoke-pg16-nonquiet/scraper-process.json.gz)                             | `failed`        | 1 / Rust0, Zig0                | Rust exited during first durable dispatch; missing `chains.scraperprocess.blocks.estimateBlockTime` |
| [scraper-process-smoke2-pg18-nonquiet](../../zig/bench/results/scraper-process-smoke2-pg18-nonquiet/scraper-process.json.gz)                           | `failed`        | 2 / Rust1, Zig0                | Zig restart catchup exited `AddressInUse`                                                           |
| [scraper-process-timeout-cleanup-pg16-15-nonquiet](../../zig/bench/results/scraper-process-timeout-cleanup-pg16-15-nonquiet/scraper-process.json.gz)   | `failed`        | 2 / Rust1, Zig0                | Zig interrupted by SIGTERM                                                                          |

### Paired scraper deltas

Δ = Zig − Rust within each recorded process pair. Positive latency/CPU deltas favor Rust; negative deltas favor Zig. These preserve within-pair differences rather than subtracting separate medians. Workloads and historical/shared-host qualifications are those of each linked snapshot.

| Snapshot                                                                                                              | Pair | Catchup Δms |  Fresh Δms | First CPU Δs |
| --------------------------------------------------------------------------------------------------------------------- | ---: | ----------: | ---------: | -----------: |
| [Initial2 PG18.6](../../zig/bench/results/scraper-process-initial2-pg18-restartport-nonquiet/scraper-process.json.gz) |    0 |    -331.235 | +2,980.414 |    +1.688922 |
| [Initial2 PG18.6](../../zig/bench/results/scraper-process-initial2-pg18-restartport-nonquiet/scraper-process.json.gz) |    1 |    +248.143 | +5,025.313 |    +1.837051 |
| [Initial2 PG18.6](../../zig/bench/results/scraper-process-initial2-pg18-restartport-nonquiet/scraper-process.json.gz) |    2 |    -146.883 | +4,049.169 |    +1.428591 |
| [Initial2 PG18.6](../../zig/bench/results/scraper-process-initial2-pg18-restartport-nonquiet/scraper-process.json.gz) |    3 |    +127.896 | +3,742.145 |    +1.358925 |
| [Initial2 PG18.6](../../zig/bench/results/scraper-process-initial2-pg18-restartport-nonquiet/scraper-process.json.gz) |    4 |     +79.441 | +2,522.171 |    +0.788047 |
| [Smoke3 PG18.6](../../zig/bench/results/scraper-process-smoke3-pg18-nonquiet/scraper-process.json.gz)                 |    0 |    -616.736 |    +71.032 |    +0.224570 |
| [Smoke4 PG18.6](../../zig/bench/results/scraper-process-smoke4-sameport-pg18-nonquiet/scraper-process.json.gz)        |    0 |    -546.466 | +3,579.987 |    +0.340751 |
| [Finalhead PG18.6](../../zig/bench/results/scraper-process-finalhead-pg18-nonquiet/scraper-process.json.gz)           |    0 |    -443.766 | +2,898.091 |    +0.882858 |
| [Finalhead PG18.6](../../zig/bench/results/scraper-process-finalhead-pg18-nonquiet/scraper-process.json.gz)           |    1 |     -24.858 | +2,837.980 |    +0.818376 |
| [Finalhead PG18.6](../../zig/bench/results/scraper-process-finalhead-pg18-nonquiet/scraper-process.json.gz)           |    2 |     +38.929 | +2,774.459 |    +0.918303 |
| [Finalhead PG18.6](../../zig/bench/results/scraper-process-finalhead-pg18-nonquiet/scraper-process.json.gz)           |    3 |     -11.402 | +2,627.558 |    +0.883521 |
| [Finalhead PG18.6](../../zig/bench/results/scraper-process-finalhead-pg18-nonquiet/scraper-process.json.gz)           |    4 |    +154.270 | +4,176.107 |    +1.284439 |
| [Finalhead PG16.15](../../zig/bench/results/scraper-process-finalhead-pg16-15-nonquiet/scraper-process.json.gz)       |    0 |    -425.961 | +3,261.970 |    +0.959165 |
| [Finalhead PG16.15](../../zig/bench/results/scraper-process-finalhead-pg16-15-nonquiet/scraper-process.json.gz)       |    1 |     +14.161 | +2,631.849 |    +0.750044 |
| [Finalhead PG16.15](../../zig/bench/results/scraper-process-finalhead-pg16-15-nonquiet/scraper-process.json.gz)       |    2 |    +144.213 | +2,708.912 |    +1.462555 |
| [Finalhead PG16.15](../../zig/bench/results/scraper-process-finalhead-pg16-15-nonquiet/scraper-process.json.gz)       |    3 |     +97.301 | +2,830.772 |    +1.089855 |
| [Finalhead PG16.15](../../zig/bench/results/scraper-process-finalhead-pg16-15-nonquiet/scraper-process.json.gz)       |    4 |     +36.587 | +2,807.135 |    +0.787781 |

## Relayer planning and unsuccessful smoke history

All 13 historical local attempts have `passed=false` and zero completed raw samples. The 11 daemon attempts retain `stage=executing`; the first two were planning/contract-compilation only. Shared-host smoke attempts are not matched performance acceptance, and there are no performance ratios. Failure descriptions use manifest fields only; an absent cause remains unrecorded.

| Artifact                                                                                                | Recorded stage       | Completed samples | Recorded result                                                                         |
| ------------------------------------------------------------------------------------------------------- | -------------------- | ----------------: | --------------------------------------------------------------------------------------- |
| [whole-relayer-smoke](../../zig/bench/results/whole-relayer-smoke/manifest.json)                        | Dry-run plan         |                 0 | No daemons launched                                                                     |
| [whole-relayer-contract-smoke](../../zig/bench/results/whole-relayer-contract-smoke/manifest.json)      | Contract compilation |                 0 | 10 contracts compiled; no daemons launched                                              |
| [whole-relayer-smoke-actual](../../zig/bench/results/whole-relayer-smoke-actual/manifest.json)          | Executing            |                 0 | Rust sample0 exited waiting for validator backlog; config directory missing             |
| [whole-relayer-smoke-actual-2](../../zig/bench/results/whole-relayer-smoke-actual-2/manifest.json)      | Executing            |                 0 | Rust sample0 `validator shutdown failed`                                                |
| [whole-relayer-smoke-actual-3](../../zig/bench/results/whole-relayer-smoke-actual-3/manifest.json)      | Executing            |                 0 | Rust sample0 connection refused, errno61                                                |
| [whole-relayer-smoke-actual-4](../../zig/bench/results/whole-relayer-smoke-actual-4/manifest.json)      | Executing            |                 0 | Failure cause not recorded                                                              |
| [whole-relayer-smoke-actual-5](../../zig/bench/results/whole-relayer-smoke-actual-5/manifest.json)      | Executing            |                 0 | Failure cause not recorded                                                              |
| [whole-relayer-smoke-actual-6](../../zig/bench/results/whole-relayer-smoke-actual-6/manifest.json.gz)   | Executing            |                 0 | Rust sample0 deadline waiting for backlog delivery                                      |
| [whole-relayer-smoke-actual-7](../../zig/bench/results/whole-relayer-smoke-actual-7/manifest.json)      | Executing            |                 0 | Failure cause not recorded                                                              |
| [whole-relayer-smoke-actual-8](../../zig/bench/results/whole-relayer-smoke-actual-8/manifest.json.gz)   | Executing            |                 0 | Rust sample0 `settlement deadline: None`                                                |
| [whole-relayer-smoke-actual-9](../../zig/bench/results/whole-relayer-smoke-actual-9/manifest.json.gz)   | Executing            |                 0 | Rust sample0 settlement deadline; submitter queue7, building/inclusion/finality queues0 |
| [whole-relayer-smoke-actual-10](../../zig/bench/results/whole-relayer-smoke-actual-10/manifest.json.gz) | Executing            |                 0 | Rust sample0 settlement deadline; submitter/building queue metrics missing              |
| [whole-relayer-smoke-actual-11](../../zig/bench/results/whole-relayer-smoke-actual-11/manifest.json)    | Executing            |                 0 | `failures=[]`; failure cause not recorded                                               |
