# Final lifetime-fix Source and dependency inventory

At production commit `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b`, the inventory contains **2,430 files**. All file hashes matched when sealed. The [raw inventory](../../zig/bench/results/final-source-inventory-lifetime-20261106/source-inventory.json.gz), [supplement](../../zig/bench/results/final-source-inventory-lifetime-20261106/supplement.json.gz), [comparison with e0](../../zig/bench/results/final-source-inventory-lifetime-20261106/prior-comparison.json.gz) and [archive manifest](../../zig/bench/results/final-source-inventory-lifetime-20261106/manifest.json) retain exact hashes and lossless inputs. The [e0 inventory](final-admission-source-inventory.md) and [original inventory](final-source-inventory.md) remain unchanged, including their 129 and 126 gzip payloads.

Two test files were added and three existing files changed after e0: the Lander lifetime implementation/regressions plus the genuine-batch benchmark fixture and its pure test. The [Source closure](../../zig/bench/results/final-source-inventory-lifetime-20261106/source-closure.json.gz) verifies all 659 broad-gate physical selections and five final pins (three runtime/test, two benchmark/test). These sets overlap; the two benchmark inputs lie outside the broad selected map. Their bytes match the final normal-hooked commit. All Rust-main/Sealevel inventory rows match both prior snapshots, and tracked Rust remains unchanged from `c5202242cc6569da4a858ed7ddbb34170ab696aa`. All 29 retained native FFI Source/lock pins match. Two ignored vendored Aleo dependency files in the 659-input map remain pinned by physical bytes; no committed Git blobs are invented for them.

| Zig Source view                            | e0 files | Lifetime-fix files | e0 physical lines | Current physical lines | Change |
| ------------------------------------------ | -------: | -----------------: | ----------------: | ---------------------: | -----: |
| Implementation-labelled                    |      373 |                373 |            98,608 |                 98,832 |   +224 |
| Dedicated tests / benchmarks / integration |      224 |                226 |            42,106 |                 42,407 |   +301 |
| All Source categories                      |      648 |                650 |           148,645 |                149,170 |   +525 |

The implementation-labelled increase is 224 physical lines, including 192 lexical test-block lines. The remaining increase is 32 lines and includes test helpers; it is not a production-only LOC claim. `zig/src/lander/tests.zig` falls in this heuristic category, while the new wrapper and Python batch test are dedicated test/integration Source.

Physical lines include comments and blanks; nonblank lines retain comments. Inline tests are a lexical split of explicit Zig `test` and Rust test/module blocks. Helpers outside recognized blocks remain in the remainder. Path/name categories also place `zig/build.zig` and some `*_testing.zig` helpers under implementation. The remainder is not production-only LOC, and line counts do not measure test coverage.

| Tree / inventory category                           | Source files | Physical lines | Nonblank lines | Inline test-block lines | Outside those blocks |
| --------------------------------------------------- | -----------: | -------------: | -------------: | ----------------------: | -------------------: |
| rust/main: implementation_source                    |          809 |        226,421 |        206,904 |                  70,868 |              155,553 |
| rust/main: test_benchmark_or_integration_source     |           59 |         18,392 |         16,189 |                       0 |               18,392 |
| **rust/main total**                                 |          868 |        244,813 |        223,093 |                  70,868 |              173,945 |
| rust/sealevel: implementation_source                |          125 |         43,184 |         38,362 |                  11,451 |               31,733 |
| rust/sealevel: test_benchmark_or_integration_source |           26 |         40,296 |         36,558 |                       0 |               40,296 |
| **rust/sealevel total**                             |          151 |         83,480 |         74,920 |                  11,451 |               72,029 |
| zig: build_or_operational_tool_source               |            9 |          1,546 |          1,396 |                       0 |                1,546 |
| zig: implementation_source                          |          373 |         98,832 |         95,576 |                  16,844 |               81,988 |
| zig: independent_reference_harness                  |           31 |          4,607 |          4,490 |                       0 |                4,607 |
| zig: native_helper_source                           |           10 |          1,625 |          1,587 |                     185 |                1,440 |
| zig: native_vendored_source                         |            1 |            153 |            136 |                      18 |                  135 |
| zig: test_benchmark_or_integration_source           |          226 |         42,407 |         40,551 |                       0 |               42,407 |
| **zig total**                                       |          650 |        149,170 |        143,736 |                  17,047 |              132,123 |

Rust-main includes shared crates, lander, migrations, utilities, tests and generated bindings. Rust Sealevel separately includes on-chain programs/interfaces and local dependencies. Zig's upstream native/SDK source lies outside this tree. These scopes do not support an equivalent-runtime LOC ratio or a 10× reduction claim.

| Rust-main Rust source view            | Files | Physical lines |
| ------------------------------------- | ----: | -------------: |
| Tracked `*.rs`                        |   832 |        223,043 |
| Build-generated, untracked ABI `*.rs` |    36 |         21,770 |
| Raw on-disk `*.rs` total              |   868 |        244,813 |

The 36 untracked ABI files are emitted by retained Ethereum, Tron, Starknet and ethers-prometheus `build.rs` producers into Source directories. Their exact hashes and producer bytes are archived; tracked-source counts exclude them. Cache/target/output trees are pruned. Header text alone is not used to classify generated bindings.

| Tracked Rust-main area (`*.rs`) | Files | Physical | Nonblank | Inline test-block lines |
| ------------------------------- | ----: | -------: | -------: | ----------------------: |
| agents/relayer                  |   100 |   49,059 |   44,733 |                  24,501 |
| agents/validator                |    16 |   13,960 |   13,110 |                   5,300 |
| agents/scraper                  |    98 |   18,643 |   17,401 |                   6,094 |
| lander                          |   177 |   39,562 |   34,817 |                  10,472 |
| hyperlane-base                  |    78 |   27,191 |   24,567 |                   9,074 |
| hyperlane-core                  |    60 |   10,562 |    9,392 |                   2,416 |
| chains                          |   230 |   49,333 |   44,326 |                  11,858 |
| applications                    |     8 |      162 |      133 |                       0 |
| ethers-prometheus               |     5 |    1,363 |    1,233 |                     446 |
| hyperlane-metric                |     4 |      603 |      542 |                     148 |
| hyperlane-test                  |     4 |      248 |      201 |                       0 |
| utils                           |    52 |   12,357 |   10,885 |                     559 |

The three Rust agents share base/core, lander and chain crates. Their directory subtotal omits shared work; the whole workspace includes utilities beyond agent runtime. Neither is an equivalent denominator for Zig implementation-labelled lines.

| Authored native bridge / helper source                          | Physical | Nonblank | Inline test-block lines | Outside those blocks |
| --------------------------------------------------------------- | -------: | -------: | ----------------------: | -------------------: |
| zig/native/rocks/abi.cc                                         |       18 |       18 |                       0 |                   18 |
| zig/native/rocks/abi.h                                          |       13 |       13 |                       0 |                   13 |
| zig/native/rocks/abi.zig                                        |       11 |       11 |                       0 |                   11 |
| zig/native/rocks/probe.cc                                       |       59 |       59 |                       0 |                   59 |
| zig/native/rocks/test_native_deps.py                            |       97 |       87 |                       0 |                   97 |
| zig/native/rocks/src/lib.rs                                     |        2 |        2 |                       0 |                    2 |
| zig/src/aleo/native-crypto/src/lib.rs                           |      270 |      266 |                      42 |                  228 |
| zig/src/aleo/native-vm/src/lib.rs                               |      797 |      787 |                      44 |                  753 |
| zig/src/aleo/native-vm/vendor/aleo-std-storage-1.0.3/src/lib.rs |      153 |      136 |                      18 |                  135 |
| zig/src/ops/regex-native/src/lib.rs                             |      165 |      155 |                      52 |                  113 |
| zig/src/starknet/native-crypto/src/lib.rs                       |      193 |      189 |                      47 |                  146 |

The four authored Rust bridge libraries remain **1,425 physical lines**, including **185** recognized inline-test lines and **1,240** outside them. The separate vendored Aleo storage adapter is 153 lines. The RocksDB helper row includes its probe and dependency test. Upstream Rust SDK/proving code is not included in these wrapper counts.

Five native-helper lock scopes (RocksDB plus four Rust bridges) retain **446 unique `(name, version, source)` entries: 440 external and six local**. All 21 decoded lock graphs and 79 Cargo manifests are archived. The supplement records both stored-artifact and decoded-lock SHAs. Counts span targets, features, tests and build tools; they are not a target-specific runtime dependency graph. Reference/helper graphs below are separate.

| Lock scope                                        | Package entries | Registry | Git | Local |
| ------------------------------------------------- | --------------: | -------: | --: | ----: |
| zig/reference/Cargo.lock                          |             183 |      180 |   0 |     3 |
| zig/reference/db-codecs/Cargo.lock                |             132 |      129 |   0 |     3 |
| zig/reference/evm/Cargo.lock                      |             125 |      117 |   7 |     1 |
| zig/reference/reveal/Cargo.lock                   |             263 |      260 |   0 |     3 |
| zig/reference/rocks/Cargo.lock                    |           1,214 |    1,142 |  38 |    34 |
| zig/reference/settings/Cargo.lock                 |           1,216 |    1,143 |  38 |    35 |
| zig/reference/tron/Cargo.lock                     |             127 |      126 |   0 |     1 |
| zig/reference/validator-http/Cargo.lock           |           1,214 |    1,143 |  38 |    33 |
| zig/src/altvm/reference/Cargo.lock                |             460 |      444 |   0 |    16 |
| zig/src/lander/testing/reference/Cargo.lock       |             328 |      314 |  11 |     3 |
| zig/src/net/testing/endpoint-reference/Cargo.lock |              40 |       39 |   0 |     1 |
| zig/src/radix/reference/Cargo.lock                |             266 |      250 |  15 |     1 |
| rust/main/Cargo.lock                              |           1,430 |    1,292 |  96 |    42 |
| rust/sealevel/Cargo.lock                          |           1,047 |    1,005 |  10 |    32 |
| zig/native/rocks/Cargo.lock                       |              47 |       46 |   0 |     1 |
| zig/src/aleo/native-crypto/Cargo.lock             |             229 |      208 |  20 |     1 |
| zig/src/aleo/native-vm/Cargo.lock                 |             398 |      338 |  58 |     2 |
| zig/src/ops/regex-native/Cargo.lock               |               6 |        5 |   0 |     1 |
| zig/src/ops/testing/reference/Cargo.lock          |             147 |      144 |   0 |     3 |
| zig/src/starknet/native-crypto/Cargo.lock         |              94 |       93 |   0 |     1 |
| zig/src/starknet/testing/reference/Cargo.lock     |             289 |      288 |   0 |     1 |

Runtime dependencies include native libcurl/TLS/DNS, libpq, RocksDB 10.4.2 and seven compression/ABI archives, Rust regex, Starknet crypto, Aleo crypto and the Aleo VM/proving worker. Dynamic FFI libraries may not appear in `otool` output. There is no zero-dependency claim, and no Cargo resolution, network download or SDK rebuild ran for this inventory.

| Tree / data category                 | Files without source line counts |     Bytes |
| ------------------------------------ | -------------------------------: | --------: |
| rust/main: configuration_or_data     |                              125 | 5,022,787 |
| rust/main: fixture_data              |                                4 |    94,865 |
| rust/sealevel: configuration_or_data |                              214 |   567,071 |
| zig: configuration_or_data           |                              337 | 3,028,949 |
| zig: fixture_data                    |                               34 |   233,408 |
| zig: independent_reference_harness   |                               30 |   392,965 |
| zig: native_helper_source            |                               15 |   131,601 |
| zig: native_vendored_source          |                                2 |     1,042 |

Data bytes describe stored inventoried files, not decoded fixture/parameter size or compiler caches. The existing public Aleo parameter subset is separate:

| Existing public parameter file                         |          Bytes |
| ------------------------------------------------------ | -------------: |
| .aleo/resources/fee_public.prover.d967fc6              |     29,174,402 |
| .aleo/resources/powers-of-beta-15.usrs.eb7040c         |      3,145,736 |
| .aleo/resources/powers-of-beta-16.usrs.84631bc         |      3,145,736 |
| .aleo/resources/powers-of-beta-17.usrs.7c27308         |      6,291,464 |
| .aleo/resources/powers-of-beta-18.usrs.7a12bcb         |     12,582,920 |
| .aleo/resources/shifted-powers-of-beta-15.usrs.7c732bf |      3,145,736 |
| .aleo/resources/shifted-powers-of-beta-16.usrs.d99bcb3 |      3,145,736 |
| .aleo/resources/shifted-powers-of-beta-17.usrs.2025178 |      6,291,464 |
| .aleo/resources/shifted-powers-of-beta-18.usrs.9a1859e |     12,582,920 |
| **Present subset total (9 files)**                     | **79,506,114** |

These nine files total **79,506,114 bytes** (about 79.5 MB) and match the prior metadata. They are an existing public test subset under `/tmp/ziggy-aleo-parameters`, not a complete production proving-parameter set. Only names, sizes and hashes were recorded; no parameter blobs were copied or downloaded.

The [38 product descriptors](../../zig/bench/results/final-source-inventory-lifetime-20261106/runtime-products.json.gz) preserve 22 original paths, eight failed-e0 runtime paths and eight new role/worker paths from the [lifetime-fix build matrix](../../zig/bench/results/build-matrix-batch-lifetime-final/). Four SDK DSOs and seven archives remain exact original `516bdf4` dependency products. e0 runtime products are a historical failed V4 snapshot, not final runtime acceptance.

| Recorded product group              | Products |       Bytes | Provenance              |
| ----------------------------------- | -------: | ----------: | ----------------------- |
| Retained Rust agents                |        3 | 417,675,760 | Original comparator     |
| Retained original Zig roles/workers |        8 |  64,169,600 | 516 runtime; historical |
| Retained e0 Zig roles/workers       |        8 |  64,206,496 | Failed V4 snapshot      |
| Reused SDK DSOs                     |        4 |  52,595,584 | 516 dependencies        |
| Reused native archives              |        7 |  24,902,048 | 516 dependencies        |
| ReleaseSafe new roles/worker        |        4 |  32,278,912 | 8872 lifetime fix       |
| ReleaseFast new roles/worker        |        4 |  31,928,464 | 8872 lifetime fix       |

These groups are alternative runtime modes, dependencies and retained comparators, not one deployment bundle. Raw inventory default-path executable descriptors are legacy observations, not substitutes for the new products. This inventory adds no performance sample or fresh dependency-inclusive trial. At capture, the 13 broad Source gates had passed and two supplemental exact-new-worker suites were pending. No completed process proof, image or paired runtime acceptance is claimed. No compiler, test, daemon, generated-cache size scan or benchmark ran for this inventory.
