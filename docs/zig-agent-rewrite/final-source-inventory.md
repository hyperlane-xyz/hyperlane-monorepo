# Final source and dependency inventory

The final on-disk inventory contains **2,421 files** at harness commit `baf14145ae2a3fe670951b77b6e52c66f59d5120`; production implementation remains bound to `516bdf42909cd258f6f9cf423878c7ea8bea1683`. The [raw inventory](../../zig/bench/results/final-source-inventory-20261106/source-inventory.json.gz), [normalized lock/generated-source supplement](../../zig/bench/results/final-source-inventory-20261106/supplement.json.gz) and [lossless archive manifest](../../zig/bench/results/final-source-inventory-20261106/manifest.json) retain exact file hashes. All 2,421 file hashes matched current bytes when sealed.

These are physical source lines, including comments and blank lines. Nonblank counts still include comments. Explicit Zig `test` blocks and Rust `cfg(test)` / `test` / `tokio::test` blocks are separated lexically. Helpers outside recognized blocks remain in the remainder; that remainder is not production-only LOC. Dedicated test/reference/tool rows remain separate. The inventory categories are path/name heuristics: for example, `zig/build.zig` falls in implementation-labelled source, while some test-only helpers named `*_testing.zig` do too. The native-helper row also includes its probe and dedicated dependency test. None of these counts measure executed test coverage.

| Tree / inventory category                           | Source files | Physical lines | Nonblank lines | Inline test-block lines | Outside those blocks |
| --------------------------------------------------- | -----------: | -------------: | -------------: | ----------------------: | -------------------: |
| rust/main: implementation_source                    |          809 |        226,421 |        206,904 |                  70,868 |              155,553 |
| rust/main: test_benchmark_or_integration_source     |           59 |         18,392 |         16,189 |                       0 |               18,392 |
| **rust/main total**                                 |          868 |        244,813 |        223,093 |                  70,868 |              173,945 |
| rust/sealevel: implementation_source                |          125 |         43,184 |         38,362 |                  11,451 |               31,733 |
| rust/sealevel: test_benchmark_or_integration_source |           26 |         40,296 |         36,558 |                       0 |               40,296 |
| **rust/sealevel total**                             |          151 |         83,480 |         74,920 |                  11,451 |               72,029 |
| zig: build_or_operational_tool_source               |            9 |          1,546 |          1,396 |                       0 |                1,546 |
| zig: implementation_source                          |          373 |         98,368 |         95,117 |                  16,652 |               81,716 |
| zig: independent_reference_harness                  |           31 |          4,607 |          4,490 |                       0 |                4,607 |
| zig: native_helper_source                           |           10 |          1,625 |          1,587 |                     185 |                1,440 |
| zig: native_vendored_source                         |            1 |            153 |            136 |                      18 |                  135 |
| zig: test_benchmark_or_integration_source           |          217 |         40,588 |         38,827 |                       0 |               40,588 |
| **zig total**                                       |          641 |        146,887 |        141,553 |                  16,855 |              130,032 |

The Rust-main tree includes shared crates, migrations, utilities, test harnesses and generated bindings. Rust Sealevel separately includes on-chain programs/interfaces and tests used as local agent dependencies. Zig uses upstream native/SDK dependencies whose source is outside this tree. The tables provide scoped counts; they do not establish an equivalent-runtime reduction or a 10× LOC result.

| Rust-main Rust source view            | Files | Physical lines |
| ------------------------------------- | ----: | -------------: |
| Tracked `*.rs`                        |   832 |        223,043 |
| Build-generated, untracked ABI `*.rs` |    36 |         21,770 |
| Raw on-disk `*.rs` total              |   868 |        244,813 |

The 36 extra Rust ABI files are emitted by the retained Ethereum, Tron, Starknet and ethers-prometheus `build.rs` generators into source directories. They are excluded from the tracked-source view, while their exact hashes remain in the raw inventory. Compiler/target/cache directories are pruned. Generation is established from the producer paths and Git tracking, not the inventory's header-keyword heuristic, which can also match ordinary source text.

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

The three Rust agent directories share the lander, base/core and chain crates. Comparing their subtotal alone to all Zig source would omit shared Rust work; comparing the whole Rust workspace to Zig runtime alone would include unrelated Rust utilities. No cross-language LOC ratio is reported.

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

The four authored Rust bridge libraries total 1,425 physical lines, with 185 recognized inline test-block lines. Their remainder is 1,240 lines. This excludes their upstream Rust SDKs and separately lists the 153-line vendored Aleo storage adapter. Small FFI wrappers do not remove the SDK/proving dependency cost.

The five native-helper lock scopes (RocksDB prerequisite plus four bridge crates) contain **446 unique locked `(name, version, source)` identities, 440 external and six local**. Each lock includes packages selected across targets, optional features, tests and build tools; the deduplicated union is not a target-specific runtime graph. Reference/helper graphs are listed separately and must not be added as runtime dependencies. All 21 decoded lock SHA values and their stored compressed/chunked artifact SHAs are in the supplement; all 79 inventoried Cargo manifests and the exact lock representations are archived. No Cargo resolution, network download or dependency rebuild ran for this inventory.

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

There is no zero-dependency claim. Runtime boundaries include native libcurl/TLS/DNS, libpq, RocksDB 10.4.2 with compression/ABI archives, Rust regex, Starknet crypto, Aleo crypto and the Aleo VM/proving worker plus public parameters. Dynamic FFI libraries opened at runtime do not necessarily appear in `otool` output.

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

Data bytes describe inventoried files, not decoded parameter/fixture size or compiler-cache disk usage. The current public Aleo parameter subset is recorded separately:

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

These are the nine existing public test parameter files present under `/tmp/ziggy-aleo-parameters`, not a complete production proving-parameter set. Only their names, sizes and hashes were inventoried; no parameter blob was copied or downloaded. They are excluded from the executable/bundle totals.

Use the [final build matrix](final-build-matrix.md) and its [22 exact product descriptors](../../zig/bench/results/build-matrix-final/artifact-readback.json.gz) for current binary/library/archive sizes. The inventory script also reports default-path binaries already on disk; those legacy descriptors are historical observations and are not substituted for the matrix products. No generated-tree size scan, compiler, test, daemon or benchmark was run here.
