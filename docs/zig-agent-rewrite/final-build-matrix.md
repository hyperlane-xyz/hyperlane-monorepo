# Final build matrix

All 11 build phases passed on frozen Source commit `516bdf42909cd258f6f9cf423878c7ea8bea1683`. The dependency-inclusive cold build took **2,090.97s for Rust, 836.44s for Zig ReleaseSafe and 841.86s for Zig ReleaseFast**. These are single observations on a shared macOS host, not isolated-host estimates or runtime performance results.

[Exact plan](../../zig/bench/results/build-matrix-final/plan.json.gz), [raw results](../../zig/bench/results/build-matrix-final/results.json.gz), [lossless archive manifest](../../zig/bench/results/build-matrix-final/archive-manifest.json), and [current artifact readback](../../zig/bench/results/build-matrix-final/artifact-readback.json.gz).

Each phase has one sample. Fresh Cargo target and Zig local/global caches exclude already-downloaded registry sources, toolchains and parameters. All three Rust agents explicitly enable Aleo. Both implementations cover the eight supported chain families; the Zig bundle includes native RocksDB/compression, regex, Starknet/Aleo crypto, Aleo VM and its bounded worker. Rust uses `--cfg tokio_unstable -Ctarget-cpu=native`; Zig uses `-Dcpu=native`; jobs=2. Rust release and Zig Safe/Fast have different safety checks. Native C/C++ flags remain in the dependency manifest rather than being assumed equivalent.

The five standalone Zig prerequisite phases total **728.99s**. Each mode's dependency-inclusive value adds that total to its agent compile/link phase. The prerequisites were physically built once and reused across both modes; the per-mode totals describe the corresponding fresh bundle and are not two independently repeated cold trials. Rust Cargo's agent phase includes its own dependencies. The smaller compiler-only Zig times require the separately built prerequisites. No zero-dependency claim applies.

| Build scope                                      |      Rust release | Zig ReleaseSafe | Zig ReleaseFast |
| ------------------------------------------------ | ----------------: | --------------: | --------------: |
| Agent compile/link wall (s)                      |           2090.97 |          107.45 |          112.87 |
| Separately measured native/FFI prerequisites (s) | Included by Cargo |          728.99 |          728.99 |
| Dependency-inclusive cold wall (s)               |           2090.97 |          836.44 |          841.86 |
| Rust / dependency-inclusive Zig wall             |             1.00× |           2.50× |           2.48× |
| Dependency-inclusive user + system CPU (s)       |           3944.32 |         1449.49 |         1462.44 |
| No-change wall (s)                               |             2.386 |           0.510 |           0.501 |

No-change means the exact same command and unchanged Source with its immediately preceding cache retained. It measures cached build checks, not rebuilding after a source edit.

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

Wall and CPU values cover each phase's child process tree. Max-child RSS is `wait4`'s largest individual child; sampled tree RSS sums descendants every 200ms, can double-count shared pages and miss short peaks. RSS peaks must not be summed across serial phases. Setup/restoration and eight cache-reclamation passes run outside these timers.

| Installed executable                    | Rust release bytes | Zig Safe bytes | Zig Fast bytes |
| --------------------------------------- | -----------------: | -------------: | -------------: |
| relayer                                 |        184,851,248 |     14,986,280 |     14,917,784 |
| validator                               |        158,046,144 |     13,622,696 |     13,590,872 |
| scraper                                 |         74,778,368 |      3,247,320 |      3,212,792 |
| Three roles total                       |        417,675,760 |     31,856,296 |     31,721,448 |
| Aleo VM worker                          |           In agent |        403,640 |        188,216 |
| Three roles + worker + four bridge DSOs |        417,675,760 |     84,855,520 |     84,505,248 |

Sizes are the actual installed files recorded by the matrix. The bundle row includes the worker and four required bridge DSOs for Zig; system libraries, proving parameters, credentials, database contents and container layers are excluded. The seven static native archives below are compile inputs, not additional runtime bundle bytes. [Exact hashes and paths](../../zig/bench/results/build-matrix-final/artifact-readback.json.gz) bind all 22 products.

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

The host was shared. A [12:25 load snapshot](../../zig/bench/results/build-matrix-final/shared-load-snapshot.json.gz), during Rust's cold phase, observed `system_profiler` at 94.8% CPU, Warp at 36.3%, WindowServer at 31.7%, and compiler processes. The magnitude of their effect on these timings is unmeasured. The phase load/disk observations remain part of the result:

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

Every phase recorded the same before/after selected Source digest; an independent current readback reproduced it. This digest covers the build harness's selected Zig/Rust Source and data, not every worktree file. All eight reclamation records report unchanged preserved hashes outside the measurement intervals. Readback rechecked every retained closure artifact/pin plus all role, worker, bridge and native-archive products. Compiler caches were reclaimed after each cache group's final phase; downloads, runtime assets and loader closure stayed intact.

The later integration assertion fix in `baf14145ae` changed three Python fixtures and added one pure guard test. Those helpers are outside the compiled production inputs. All 22 matrix products remain byte-identical; the aggregate source digest above describes the original build snapshot, and the corrected process proofs record their own harness hashes.

Original JSON/log bytes remain local with exact-path ignores. Deterministic gzip copies round-trip to their recorded SHA/length; no measured file was reformatted. SDK-dependent functional tests against these newly built DSOs/workers are a separate gate. Agent process benchmarks and the final PR table remain separate results.
