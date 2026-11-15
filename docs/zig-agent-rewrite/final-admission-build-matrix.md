# Admission-fixed build matrix

All four fresh Zig build phases passed at `e0b95ebf0189e3cc75c3ae1e48a2d9581006e8d0`: ReleaseSafe compiler-cold **131.13s**, ReleaseFast compiler-cold **121.74s**, and no-change builds **0.49s** each. The commands build all three roles plus the Aleo VM worker.

This is a Zig-only follow-up after the [canonical admission fix](canonical-admission-order.md). Native dependencies and Rust were not rebuilt or retimed. Their earlier accepted measurements remain the comparator. The combined totals below add that earlier prerequisite duration to the new Zig duration; they are qualified mixed-run totals.

## Build results

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

## CPU and memory

| Phase / provenance                 | Wall (s) | User / system CPU (s) | Max child RSS (MiB) | Sampled tree peak (MiB) | Samples |
| ---------------------------------- | -------: | --------------------: | ------------------: | ----------------------: | ------: |
| native-sdk-cold (reused 516)       |  246.051 |      359.771 / 28.591 |               631.3 |                  1211.1 |     995 |
| regex-cold (reused 516)            |    9.971 |        11.982 / 0.315 |               350.5 |                   580.5 |      42 |
| starknet-cold (reused 516)         |   30.151 |        45.214 / 2.729 |               671.8 |                   708.3 |     127 |
| aleo-crypto-cold (reused 516)      |   61.621 |       105.052 / 7.478 |               417.9 |                   734.0 |     259 |
| aleo-vm-cold (reused 516)          |  381.194 |      651.051 / 23.659 |              3231.0 |                  3344.5 |    1583 |
| Rust cold (reused 516)             | 2090.970 |    3797.981 / 146.339 |              4276.7 |                  7218.2 |    8621 |
| Rust no-change (reused 516)        |    2.386 |         0.486 / 0.607 |               343.5 |                   341.8 |      10 |
| Zig ReleaseSafe-cold (new e0)      |  131.128 |      216.509 / 14.506 |              2801.3 |                  3809.2 |     523 |
| Zig ReleaseSafe-no-change (new e0) |    0.491 |         0.126 / 0.260 |                30.6 |                    54.8 |       2 |
| Zig ReleaseFast-cold (new e0)      |  121.737 |      226.437 / 13.692 |              2911.3 |                  4600.1 |     495 |
| Zig ReleaseFast-no-change (new e0) |    0.492 |         0.130 / 0.269 |                30.5 |                    49.4 |       2 |

Max-child RSS is wait4/rusage, not the sum of processes. Tree RSS is sampled every 200 ms and can miss a peak; no-change phases have only two samples. Phase CPU totals can be added; phase memory peaks cannot.

## Host load and capacity

| Phase / provenance                 | Load1 before → after | Free disk before → after (GiB) |
| ---------------------------------- | -------------------: | -----------------------------: |
| native-sdk-cold (reused 516)       |         6.37 → 46.37 |                40.830 → 40.595 |
| regex-cold (reused 516)            |        46.37 → 39.78 |                40.776 → 40.745 |
| starknet-cold (reused 516)         |        39.78 → 25.77 |                40.776 → 40.632 |
| aleo-crypto-cold (reused 516)      |        25.77 → 13.58 |                40.798 → 40.467 |
| aleo-vm-cold (reused 516)          |         13.13 → 4.59 |                40.777 → 39.977 |
| Rust cold (reused 516)             |          4.59 → 6.05 |                40.571 → 35.806 |
| Rust no-change (reused 516)        |          6.05 → 5.64 |                35.806 → 35.805 |
| Zig ReleaseSafe-cold (new e0)      |         5.29 → 11.98 |                34.151 → 33.900 |
| Zig ReleaseSafe-no-change (new e0) |        11.98 → 11.98 |                33.900 → 33.900 |
| Zig ReleaseFast-cold (new e0)      |        11.98 → 15.97 |                34.109 → 33.838 |
| Zig ReleaseFast-no-change (new e0) |        15.97 → 15.17 |                33.838 → 33.838 |

All three load averages are retained in raw results. Load is observed shared-host context, not a controlled workload or a correction factor. The later Zig-only run launched with 34.152 GiB free under its reviewed 16 GiB floor; the original native/Rust trial retains its 40 GiB floor. All four 2 GiB runtime guards remained clear.

## Installed sizes

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

## Cache reclamation

| Untimed reclamation                         | Free bytes recovered | Elapsed (s) | Preserved roles/worker |
| ------------------------------------------- | -------------------: | ----------: | ---------------------: |
| After zig-ReleaseSafe-three-agent-no-change |          224,141,312 |       0.184 |     4 hashes unchanged |
| After zig-ReleaseFast-three-agent-no-change |          237,502,464 |       0.323 |     4 hashes unchanged |

Only the marked follow-up local/global compiler caches were reclaimed after each no-change phase. Both installed paths and hardlink pins remain. User-global cache was untouched. These reclamation intervals are excluded from build timings.

## Historical Zig measurements

Original Zig measurements at `516` remain historical; they do not validate the new source:

| Historical 516 phase                  | Wall (s) | User / system CPU (s) | Max child / sampled tree RSS (MiB) | Load1 before → after | Free disk before → after (GiB) |
| ------------------------------------- | -------: | --------------------: | ---------------------------------: | -------------------: | -----------------------------: |
| zig-ReleaseSafe-three-agent-cold      |  107.454 |      200.367 / 13.278 |                    2824.4 / 4529.5 |          5.64 → 4.55 |                39.962 → 39.716 |
| zig-ReleaseSafe-three-agent-no-change |    0.510 |         0.128 / 0.269 |                        30.5 / 54.2 |          4.55 → 4.55 |                39.716 → 39.716 |
| zig-ReleaseFast-three-agent-cold      |  112.872 |      213.798 / 12.802 |                    2904.7 / 4612.1 |          4.55 → 4.24 |                39.924 → 39.671 |
| zig-ReleaseFast-three-agent-no-change |    0.501 |         0.126 / 0.250 |                        30.5 / 73.8 |          4.24 → 4.24 |                39.671 → 39.671 |

Earlier raw results and hashes remain intact. No timing difference between the earlier and later Zig run is attributed solely to the admission fix: the runs occurred at different times/load. New worker hashes differ in both modes; postbuild worker-sensitive functional gates are pending and tracked separately. No final exact-binary 600-second proof is claimed here.

## Provenance and functional scope

The [archive manifest](../../zig/bench/results/build-matrix-admission-final/archive-manifest.json) preserves the original launch, plan, four phase results/logs, completion, reviewed runner, measurement tools, both reclamation records, prior comparison rows and artifact descriptors. The bound runner hash starts `ab750be9`; the final prepared plan starts `85413b2a`. The guard review predates final commit binding; the actual launch binds that plan to `e0b95ebf` and records the readiness attestations, paused shadow marker, idle host/compiler checks and capacity policy.

[Archive verification](../../zig/bench/results/build-matrix-admission-final/archive-verification.json) checks every compressed and decoded payload hash/length. Original raw files remain in place. The 22 earlier products, eight new installed products and their eight hardlink pins were read back unchanged. The 29 reused native/FFI source pins and all 658 selected source/test pins matched. Binaries, static archives and cache trees are preserved at their pinned local paths, not copied into this small provenance archive.

The original [11-phase matrix](../../zig/bench/results/build-matrix-final/archive-manifest.json) remains intact. Its Rust and prerequisite rows retain their exact original commands, CPU, RSS, load, disk and hashes. This follow-up reuses the same measurement functions: wall time, wait4 CPU/max-child RSS, 200 ms process-tree RSS sampling and source fingerprints. It does not turn one trial into a statistical distribution or attribute changes between runs solely to the admission fix.

Before the timed follow-up, all 11 Safe functional checks and the two Fast default/native checks passed on the same 658-input source snapshot. Defaults passed 745 tests in each mode; native DB passed 1,052 with one named optional skip in each mode. PostgreSQL completed 21 migrations and 11 functional cases. Their manifests are retained here; Root tracks their detailed logs separately. These were correctness checks, not benchmark intervals.

Both new worker hashes differ from the prior matrix workers. Worker-sensitive checks were pending in the original build archive snapshot; the subsequent Safe and Fast default suites each passed 745 tests with the new workers. The separate [functional validation](final-admission-functional-validation.md) records those exact inputs. Builds and unit/integration suites do not establish image acceptance or the subsequent exact-binary process proofs.
