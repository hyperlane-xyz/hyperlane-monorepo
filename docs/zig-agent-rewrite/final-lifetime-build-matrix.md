# Lifetime-fixed build matrix

All four fresh Zig phases passed at `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b`: ReleaseSafe compiler-cold **118.23s**, ReleaseFast compiler-cold **115.07s**, and no-change builds **0.52s / 0.49s**. Each command builds all three roles plus the Aleo VM worker.

This follows the [batch JSON lifetime fix](lander-batch-lifetime-fix.md) and a benchmark-only commit that requires a real multi-message batch witness. Native prerequisites and Rust were reused from the accepted original matrix. Their durations are not new measurements; adding them to the fresh Zig phases produces qualified mixed-run totals.

## Build results

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

## CPU and memory

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

## Load and capacity

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

## Installed sizes

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

## Untimed reclamation

| Untimed reclamation                         | Free bytes recovered | Elapsed (s) | Preserved roles/worker |
| ------------------------------------------- | -------------------: | ----------: | ---------------------: |
| After zig-ReleaseSafe-three-agent-no-change |          224,059,392 |       0.197 |     4 hashes unchanged |
| After zig-ReleaseFast-three-agent-no-change |          237,166,592 |       0.192 |     4 hashes unchanged |

Only the marked follow-up local/global compiler caches were reclaimed after each no-change phase. Both installed paths and hardlink pins remain. User-global cache was untouched. These reclamation intervals are excluded from build timings.

## Historical measurements

Original Zig `516` and failed V4 `e0` rows remain historical; they do not validate the lifetime-fixed products:

| Historical source / phase                 | Wall (s) | User / system CPU (s) | Max child / sampled tree RSS (MiB) | Load1 before → after | Free disk before → after (GiB) |
| ----------------------------------------- | -------: | --------------------: | ---------------------------------: | -------------------: | -----------------------------: |
| 516 zig-ReleaseSafe-three-agent-cold      |  107.454 |      200.367 / 13.278 |                    2824.4 / 4529.5 |          5.64 → 4.55 |                39.962 → 39.716 |
| 516 zig-ReleaseSafe-three-agent-no-change |    0.510 |         0.128 / 0.269 |                        30.5 / 54.2 |          4.55 → 4.55 |                39.716 → 39.716 |
| 516 zig-ReleaseFast-three-agent-cold      |  112.872 |      213.798 / 12.802 |                    2904.7 / 4612.1 |          4.55 → 4.24 |                39.924 → 39.671 |
| 516 zig-ReleaseFast-three-agent-no-change |    0.501 |         0.126 / 0.250 |                        30.5 / 73.8 |          4.24 → 4.24 |                39.671 → 39.671 |
| e0 zig-ReleaseSafe-three-agent-cold       |  131.128 |      216.509 / 14.506 |                    2801.3 / 3809.2 |         5.29 → 11.98 |                34.151 → 33.900 |
| e0 zig-ReleaseSafe-three-agent-no-change  |    0.491 |         0.126 / 0.260 |                        30.6 / 54.8 |        11.98 → 11.98 |                33.900 → 33.900 |
| e0 zig-ReleaseFast-three-agent-cold       |  121.737 |      226.437 / 13.692 |                    2911.3 / 4600.1 |        11.98 → 15.97 |                34.109 → 33.838 |
| e0 zig-ReleaseFast-three-agent-no-change  |    0.492 |         0.130 / 0.269 |                        30.5 / 49.4 |        15.97 → 15.17 |                33.838 → 33.838 |

Earlier raw results and hashes remain intact. No timing difference between the earlier and later Zig runs is attributed solely to the lifetime or admission fix: the runs occurred at different times/load. New worker hashes differ in both modes; subsequent default suites passed745 tests in each mode, tracked in the separate functional validation archive. No final exact-binary 600-second proof is claimed here.

## Provenance and acceptance scope

The [archive manifest](../../zig/bench/results/build-matrix-batch-lifetime-final/archive-manifest.json) binds the reviewed runner beginning `591a3ae6`, prepared plan beginning `6b09b961`, final source fingerprint beginning `06b4c65b`, exact commands, launch attestations, all four results and both reclamation records. It retains the normal hooks for production commit `0aa1dc7c` and benchmark-only child `8872c5e4`, plus the benchmark owner's and independent pure-test reviews. Those benchmark controls passed 18 new and 28 existing pure tests; they do not prove actual batching or performance.

All 30 prior products, eight newly installed products and their eight pins were read back against recorded bytes/hashes. The 29 reused native/FFI source pins and 659 selected physical source/test pins matched. Earlier `516` and `e0` results remain intact. Binaries, archives and cache trees remain at their pinned paths; this archive contains only small provenance files. [Verification](../../zig/bench/results/build-matrix-batch-lifetime-final/archive-verification.json) checks the compressed and decoded payload hashes/lengths.

The broad source correctness gates passed before these timed phases. Both emitted worker hashes changed, so later default suites used the actual new matching-mode workers; each passed 745 tests without skips. The separate [functional validation](final-lifetime-functional-validation.md) records those checks and their exact environments. Generic correctness-build role executables remain distinct from the timed native-CPU products.

The failed V4 run and its `e0` products remain [diagnostic evidence](../../zig/bench/results/final-relayer-batch-lifetime-diagnostic/manifest.json), with no complete process proof accepted. This matrix establishes build measurements and immutable products at the corrected source. It does not establish completed V5 process proofs, image acceptance or paired runtime performance.
