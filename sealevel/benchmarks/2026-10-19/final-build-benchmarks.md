# Final build benchmarks: Hyperlane Sealevel programs, Rust vs goSVM (Go)

Go = goSVM `fogo-v0` profile unless noted. Improvement = Rust / Go (all rows are lower-is-better). Times are wall clock. Mailbox: median of 3 (range); other programs: 1 rep. Methodology: `methodology-final.md`. Raw records: `final-build-benchmarks.json` (`raw`).

## mailbox (`hyperlane_sealevel_mailbox.so`)

| Metric                                   |                      Go |                       Rust | Improvement |
| ---------------------------------------- | ----------------------: | -------------------------: | ----------: |
| Cold build                               | 0.71 s (0.70-0.71, n=3) | 22.92 s (22.75-22.92, n=3) |       32.2x |
| Handler edit build                       | 0.78 s (0.77-0.80, n=3) |    1.61 s (1.60-1.63, n=3) |       2.06x |
| Shared-lib edit build                    | 0.80 s (0.78-0.82, n=3) |    4.79 s (4.74-4.79, n=3) |       6.01x |
| Cold-build peak RSS, single process      |               205.7 MiB |                  483.1 MiB |       2.35x |
| Cold-build peak RSS, process tree        |               263.8 MiB |                 2082.2 MiB |       7.89x |
| Retained build artifacts                 |                0.18 MiB |                  354.9 MiB |       1933x |
| ELF size                                 |                63,984 B |                  176,640 B |       2.76x |
| ELF deployment rent @ 6960 lamports/byte |              0.4477 SOL |                 1.2318 SOL |       2.75x |
| ELF deployment rent @ 5080 lamports/byte |              0.3268 SOL |                 0.8990 SOL |       2.75x |

Go `solana-v3` profile, mailbox (same method):

| Metric                                   |            Go solana-v3 |                       Rust | Improvement |
| ---------------------------------------- | ----------------------: | -------------------------: | ----------: |
| Cold build                               | 0.73 s (0.71-0.75, n=3) | 22.92 s (22.75-22.92, n=3) |       31.5x |
| Handler edit build                       | 0.80 s (0.80-0.82, n=3) |    1.61 s (1.60-1.63, n=3) |       2.01x |
| Shared-lib edit build                    | 0.80 s (0.78-0.81, n=3) |    4.79 s (4.74-4.79, n=3) |       5.99x |
| Cold-build peak RSS, single process      |               205.5 MiB |                  483.1 MiB |       2.35x |
| Cold-build peak RSS, process tree        |               264.0 MiB |                 2082.2 MiB |       7.89x |
| Retained build artifacts                 |                0.18 MiB |                  354.9 MiB |       1975x |
| ELF size                                 |                60,320 B |                  176,640 B |       2.93x |
| ELF deployment rent @ 6960 lamports/byte |              0.4222 SOL |                 1.2318 SOL |       2.92x |
| ELF deployment rent @ 5080 lamports/byte |              0.3081 SOL |                 0.8990 SOL |       2.92x |

No-op rebuild: Go 0.34 s, Rust 0.95 s. Rust crates recompiled: handler edit [1, 1, 1], shared-lib edit [4, 4, 4]; cold build compiles 259 crates. goSVM compiles the whole program every time (no incremental mode).

## ism/multisig-ism-message-id (`hyperlane_sealevel_multisig_ism_message_id.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     0.78 s |    23.22 s |       29.9x |
| Cold-build peak RSS, single process      |  202.8 MiB |  468.1 MiB |       2.31x |
| Cold-build peak RSS, process tree        |  260.7 MiB | 2073.6 MiB |       7.95x |
| Retained build artifacts                 |   0.20 MiB |  355.2 MiB |       1783x |
| ELF size                                 |   54,136 B |  165,976 B |       3.07x |
| ELF deployment rent @ 6960 lamports/byte | 0.3791 SOL | 1.1575 SOL |       3.05x |
| ELF deployment rent @ 5080 lamports/byte | 0.2767 SOL | 0.8449 SOL |       3.05x |

## ism/composite-ism (`hyperlane_sealevel_composite_ism.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.19 s |    23.50 s |       19.8x |
| Cold-build peak RSS, single process      |  213.2 MiB |  467.4 MiB |       2.19x |
| Cold-build peak RSS, process tree        |  285.1 MiB | 2056.7 MiB |       7.21x |
| Retained build artifacts                 |   0.28 MiB |  356.5 MiB |       1285x |
| ELF size                                 |  132,272 B |  263,904 B |       2.00x |
| ELF deployment rent @ 6960 lamports/byte | 0.9230 SOL | 1.8391 SOL |       1.99x |
| ELF deployment rent @ 5080 lamports/byte | 0.6737 SOL | 1.3423 SOL |       1.99x |

## ism/test-ism (`hyperlane_sealevel_test_ism.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     0.58 s |    23.00 s |       39.8x |
| Cold-build peak RSS, single process      |  198.0 MiB |  479.7 MiB |       2.42x |
| Cold-build peak RSS, process tree        |  250.4 MiB | 2134.8 MiB |       8.53x |
| Retained build artifacts                 |   0.14 MiB |  354.5 MiB |       2593x |
| ELF size                                 |   22,480 B |   94,600 B |       4.21x |
| ELF deployment rent @ 6960 lamports/byte | 0.1588 SOL | 0.6608 SOL |       4.16x |
| ELF deployment rent @ 5080 lamports/byte | 0.1159 SOL | 0.4823 SOL |       4.16x |

## validator-announce (`hyperlane_sealevel_validator_announce.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     0.59 s |    23.29 s |       39.5x |
| Cold-build peak RSS, single process      |  197.6 MiB |  491.5 MiB |       2.49x |
| Cold-build peak RSS, process tree        |  251.2 MiB | 2040.4 MiB |       8.12x |
| Retained build artifacts                 |   0.14 MiB |  355.8 MiB |       2530x |
| ELF size                                 |   32,928 B |  130,008 B |       3.95x |
| ELF deployment rent @ 6960 lamports/byte | 0.2315 SOL | 0.9072 SOL |       3.92x |
| ELF deployment rent @ 5080 lamports/byte | 0.1690 SOL | 0.6622 SOL |       3.92x |

## hyperlane-sealevel-igp (`hyperlane_sealevel_igp.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.13 s |    22.28 s |       19.8x |
| Cold-build peak RSS, single process      |  216.2 MiB |  477.6 MiB |       2.21x |
| Cold-build peak RSS, process tree        |  285.5 MiB | 2232.0 MiB |       7.82x |
| Retained build artifacts                 |   0.29 MiB |  340.7 MiB |       1163x |
| ELF size                                 |  163,336 B |  359,120 B |       2.20x |
| ELF deployment rent @ 6960 lamports/byte | 1.1392 SOL | 2.5018 SOL |       2.20x |
| ELF deployment rent @ 5080 lamports/byte | 0.8315 SOL | 1.8260 SOL |       2.20x |

## hyperlane-sealevel-token (`hyperlane_sealevel_token.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.09 s |    24.87 s |       22.8x |
| Cold-build peak RSS, single process      |  217.8 MiB |  517.1 MiB |       2.37x |
| Cold-build peak RSS, process tree        |  286.5 MiB | 1747.9 MiB |       6.10x |
| Retained build artifacts                 |   0.28 MiB |  379.2 MiB |       1367x |
| ELF size                                 |  132,672 B |  402,856 B |       3.04x |
| ELF deployment rent @ 6960 lamports/byte | 0.9257 SOL | 2.8062 SOL |       3.03x |
| ELF deployment rent @ 5080 lamports/byte | 0.6757 SOL | 2.0482 SOL |       3.03x |

## hyperlane-sealevel-token-collateral (`hyperlane_sealevel_token_collateral.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.08 s |    26.33 s |       24.3x |
| Cold-build peak RSS, single process      |  217.4 MiB |  519.6 MiB |       2.39x |
| Cold-build peak RSS, process tree        |  286.4 MiB | 2193.9 MiB |       7.66x |
| Retained build artifacts                 |   0.29 MiB |  379.2 MiB |       1330x |
| ELF size                                 |  134,000 B |  405,000 B |       3.02x |
| ELF deployment rent @ 6960 lamports/byte | 0.9350 SOL | 2.8211 SOL |       3.02x |
| ELF deployment rent @ 5080 lamports/byte | 0.6824 SOL | 2.0591 SOL |       3.02x |

## hyperlane-sealevel-token-cross-collateral (`hyperlane_sealevel_token_cross_collateral.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.32 s |    28.02 s |       21.2x |
| Cold-build peak RSS, single process      |  216.6 MiB |  516.8 MiB |       2.39x |
| Cold-build peak RSS, process tree        |  289.9 MiB | 2119.7 MiB |       7.31x |
| Retained build artifacts                 |   0.32 MiB |  380.5 MiB |       1188x |
| ELF size                                 |  168,024 B |  525,384 B |       3.13x |
| ELF deployment rent @ 6960 lamports/byte | 1.1718 SOL | 3.6590 SOL |       3.12x |
| ELF deployment rent @ 5080 lamports/byte | 0.8553 SOL | 2.6707 SOL |       3.12x |

## hyperlane-sealevel-token-native (`hyperlane_sealevel_token_native.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.13 s |    26.68 s |       23.7x |
| Cold-build peak RSS, single process      |  216.3 MiB |  519.6 MiB |       2.40x |
| Cold-build peak RSS, process tree        |  284.2 MiB | 2057.4 MiB |       7.24x |
| Retained build artifacts                 |   0.27 MiB |  379.3 MiB |       1428x |
| ELF size                                 |  121,928 B |  378,040 B |       3.10x |
| ELF deployment rent @ 6960 lamports/byte | 0.8510 SOL | 2.6335 SOL |       3.09x |
| ELF deployment rent @ 5080 lamports/byte | 0.6211 SOL | 1.9222 SOL |       3.09x |

## hyperlane-sealevel-fee (`hyperlane_sealevel_fee.so`)

| Metric                                   |         Go |       Rust | Improvement |
| ---------------------------------------- | ---------: | ---------: | ----------: |
| Cold build                               |     1.18 s |    22.93 s |       19.5x |
| Cold-build peak RSS, single process      |  215.5 MiB |  473.2 MiB |       2.20x |
| Cold-build peak RSS, process tree        |  286.6 MiB | 2178.2 MiB |       7.60x |
| Retained build artifacts                 |   0.30 MiB |  340.8 MiB |       1118x |
| ELF size                                 |  174,720 B |  349,344 B |       2.00x |
| ELF deployment rent @ 6960 lamports/byte | 1.2184 SOL | 2.4338 SOL |       2.00x |
| ELF deployment rent @ 5080 lamports/byte | 0.8893 SOL | 1.7764 SOL |       2.00x |

## All programs

Cold-build time = median for mailbox, single rep otherwise. Rent in SOL.

| Program                                   |     Go cold |   Rust cold |      Go ELF B |    Rust ELF B | Go rent @6960 | Rust rent @6960 | Go rent @5080 | Rust rent @5080 |
| ----------------------------------------- | ----------: | ----------: | ------------: | ------------: | ------------: | --------------: | ------------: | --------------: |
| mailbox                                   |      0.71 s |      22.9 s |        63,984 |       176,640 |        0.4477 |          1.2318 |        0.3268 |          0.8990 |
| ism/multisig-ism-message-id               |      0.78 s |      23.2 s |        54,136 |       165,976 |        0.3791 |          1.1575 |        0.2767 |          0.8449 |
| ism/composite-ism                         |      1.19 s |      23.5 s |       132,272 |       263,904 |        0.9230 |          1.8391 |        0.6737 |          1.3423 |
| ism/test-ism                              |      0.58 s |      23.0 s |        22,480 |        94,600 |        0.1588 |          0.6608 |        0.1159 |          0.4823 |
| validator-announce                        |      0.59 s |      23.3 s |        32,928 |       130,008 |        0.2315 |          0.9072 |        0.1690 |          0.6622 |
| hyperlane-sealevel-igp                    |      1.13 s |      22.3 s |       163,336 |       359,120 |        1.1392 |          2.5018 |        0.8315 |          1.8260 |
| hyperlane-sealevel-token                  |      1.09 s |      24.9 s |       132,672 |       402,856 |        0.9257 |          2.8062 |        0.6757 |          2.0482 |
| hyperlane-sealevel-token-collateral       |      1.08 s |      26.3 s |       134,000 |       405,000 |        0.9350 |          2.8211 |        0.6824 |          2.0591 |
| hyperlane-sealevel-token-cross-collateral |      1.32 s |      28.0 s |       168,024 |       525,384 |        1.1718 |          3.6590 |        0.8553 |          2.6707 |
| hyperlane-sealevel-token-native           |      1.13 s |      26.7 s |       121,928 |       378,040 |        0.8510 |          2.6335 |        0.6211 |          1.9222 |
| hyperlane-sealevel-fee                    |      1.18 s |      22.9 s |       174,720 |       349,344 |        1.2184 |          2.4338 |        0.8893 |          1.7764 |
| **Total**                                 | **10.76 s** | **267.0 s** | **1,200,480** | **3,250,872** |    **8.3811** |     **22.6519** |    **6.1173** |     **16.5333** |
| **Rust / Go**                             |             |     **25x** |               |     **2.71x** |               |       **2.70x** |               |       **2.70x** |
| **Rent saved (Rust - Go)**                |             |             |               |   2,050,392 B |               |         14.2707 |               |         10.4160 |

## Machine and tools

- machine: Apple M3 Pro, 11 cores (5 performance + 6 efficiency), 36 GiB RAM
- os: macOS 27.0.1 (26A434), arm64
- rust_source: hyperlane-xyz/hyperlane-monorepo c37d20599a (main, clean), rust/sealevel/programs
- cargo_build_sbf: solana-cargo-build-sbf 3.0.14; platform-tools v1.51; rustc 1.84.1 (/tmp/agave-dl/solana-release/bin/cargo-build-sbf, agave 3.0.14 = CI pin in rust/sealevel/programs/toolchain.env and .github/workflows/rust.yml), run with --tools-version v1.51
- rust_platform_tools: v1.51 (~/.cache/solana/v1.51/platform-tools): rustc 1.84.1-dev, cargo 1.84.0 (12fe57a9d 2025-04-07), clang version 19.1.7-rust-dev (https://github.com/anza-xyz/llvm-project.git 0c30adaa95a6c007f6210d41735371f25c4c91ed); anza-xyz/rust@565a65a1, anza-xyz/cargo@12fe57a9
- go_source: /tmp/hm1-all branch gosvm/all @ def448aa6e (copied to /tmp/svm-bench/final/gosrc/sealevel without target/ dirs; def448aa6e only changes PORTING.md/README.md vs 5a9323e5af; all 11 fogo-v0 ELFs are byte-identical to the conformance set /tmp/hm1-all-elf/go6)
- gosvm_cli: /tmp/gosvm-pilot/bin/gosvm-int2, built from goSVM hyperlane-integration-2 fe6d6b406ca1f5cf4cac17b97d583efc71b18788 (paulbalaji fork); binary sha256 6154617db413953fa97f6c8121ebe4185c550e8bb001cbab98715b82504d8454; reports: gosvm dev experimental darwin-arm64 (fogo = fogo-v0, solana = solana-v3; legacy-v1.51-v3 retained)
- go: go version go1.23.2 darwin/arm64
- go_platform_tools: gosvm managed v1.57 (~/Library/Caches/gosvm/toolchains/v1.57/darwin-arm64, archive sha256 48c32c2ec3ac3729b5caf1fdd6c4145496125edf043b2662b0586bfbc932b34a): clang version 22.1.2-rust-dev (https://github.com/anza-xyz/llvm-project.git a4135d044fb7a19f2b7e7d04d0373cd2ba190e6e); gosvm uses only clang + ld.lld from it
- python: Python 3.14.7

## Raw runs

- Rust: `/tmp/svm-bench/timing-20261019-034026/timing.jsonl` (22 records; logs + kept target dirs in the same run dir)
- Go: `/tmp/svm-bench/go-timing-20261019-033934/go-timing.jsonl` (36 records; logs + out dirs in the same run dir)
