# Rust baseline: Sealevel functional suites on SBF ELFs

What was tested: the canonical CI Rust ELFs (/tmp/svm-bench/rust-elf-ci, agave 3.0.14 cargo-build-sbf, tools v1.51, SBPFv0), run through solana-program-test 3.0.7.
Harness: `rust/sealevel/programs/conformance.sh` on branch gosvm/conformance-harness (worktree /tmp/hm1-conformance, harness commit 8b71bb1760).
Raw data: run 1 in conformance-rust.json, run 2 in conformance-rust-run2.json, run-1 vs run-2 diff in conformance-rust-noise.json.

## Headline

- 584 tests across 24 suites (9 program suites and 15 composite-ism test files). 582 passed in run 1 and 581 in run 2.
- Every test ran on the ELF, not the native processor. Each test logs `"<name>" SBF program from <staging>/<name>.so` and the bpf loader's `Program X consumed N of M compute units` lines. Only two test mocks run native, mock_mailbox and malicious_igp, which are on the allowlist.
- 4581 BPF invocations were recorded, CPIs included.
- Every failure comes from the default 200k CU per-transaction limit. Native mode doesn't meter CU, so these never show up in plain `cargo test`.
  - mailbox::functional::test_outbox_get_latest_checkpoint fails in both runs. Mailbox hits 200000 of 200000 in an OutboxGetLatestCheckpoint simulation.
  - token-cross-collateral::test_cc_remote_transfer_igp_new_flow_with_fee fails in both runs: exceeded CU meter.
  - token-cross-collateral::test_cc_local_transfer_with_fee is flaky. It passed in run 1 and failed in run 2. It sits close to 200k, and random keypairs change the PDA bump search cost.
  - The fix would be a test change, not a harness change: add a compute-budget ix or `set_compute_max_units`. It isn't applied, so the Go ports run the same suites.

## Run-to-run noise (same ELFs, run 1 vs run 2)

Tests use `Keypair::new()`, so `find_program_address` bump searches differ between runs. Each extra bump iteration costs 1500 CU.
Of 4581 paired invocations, 3874 (84.6%) are identical. Of the 707 that differ, 340 differ by an exact multiple of 1500.
Overall ratio: median 1.000, p90 1.000, max 5.16, min 0.37. Per-program p90 is at most 1.009, except spl_associated_token_account at 1.282 and the second cross-collateral instance at 1.054.
When comparing Go against Rust, trust per-program medians and sums. Treat any single-transaction outlier as noise unless it repeats across reruns.

```
metric=cu  ratio=B/A  A=ci-1.json  B=ci-2.json
program                               pairs  median     p90     max     min         sumA         sumB    B/A cnt!=  unpr
composite_ism [8qbH..VfeR]               49   1.000   1.000   1.000   1.000       387210       387210  1.000     0     0
composite_ism [Bprm..Qgau]              641   1.000   1.000   1.000   1.000     10042944     10042944  1.000     0     0
fee [Fee1..1111]                        675   1.000   1.007   5.156   0.557      9575993      9571465  1.000     0     0
igp [BSff..M2BN]                        895   1.000   1.005   1.965   0.371      9702684      9672227  0.997     0     0
mailbox [692K..9iu1]                    311   1.000   1.009   1.233   0.741      9750474      9766611  1.002     0     0
multisig_ism_message_id [2Yjt..Z2fw]     14   1.000   1.000   1.000   0.997       158541       158523  1.000     0     0
multisig_ism_message_id [CktR..Ezy8]     19   1.000   1.000   1.000   1.000       181526       181526  1.000     0     0
spl_associated_token_account [ATok..     88   1.000   1.282   1.753   0.780      1524952      1566952  1.028     0     0
spl_token [Toke..Q5DA]                    8   1.000   1.000   1.000   1.000        26565        26565  1.000     0     0
spl_token_2022 [Toke..xuEb]             754   1.000   1.000   1.000   1.000       901184       901184  1.000     0     0
test_ism [CWVY..4tnb]                   239   1.000   1.000   1.000   1.000       935778       935778  1.000     0     0
test_send_receiver [FZ8h..vsEm]         109   1.000   1.000   1.056   0.997       435743       438705  1.007     0     0
token [3MzU..pVQH]                      242   1.000   1.003   1.732   0.646      6117095      6078300  0.994     0     0
token_collateral [G8t1..F18z]           148   1.000   1.003   1.180   0.582      3943165      3933654  0.998     0     0
token_cross_collateral [CCo1..1111]     217   1.000   1.006   1.412   0.924      8106286      8170230  1.008     0     0
token_cross_collateral [CCo1..2222]      11   1.000   1.054   1.113   1.000       443317       456817  1.030     0     0
token_native [CGn8..3aga]               153   1.000   1.003   1.040   0.953      3876262      3876558  1.000     0     0
validator_announce [DH43..fEnn]           8   1.000   1.000   1.000   1.000       192512       192512  1.000     0     0
ALL                                    4581   1.000   1.000   5.156   0.371

worst 5 (ratio suite::test program[#i] A->B):
  5.156 fee::standing::close_transient_quote::test_extraneous_account_rejected fee [Fee1..1111][#3] 3248->16748
  5.072 fee::transient::test_cc_default_router_transient_rejected_when_specific_configured fee [Fee1..1111][#6] 3315->16815
  2.335 fee::remove_cc_route::test_remove_existing_cc_route fee [Fee1..1111][#2] 5617->13117
  2.257 fee::remove_cc_route::test_remove_nonexistent_cc_route_fails fee [Fee1..1111][#1] 4773->10773
  2.105 fee::transient::test_cc_specific_router_transient_submit_rejected_when_only_default_configured fee [Fee1..1111][#3] 4071->8571

status changes (1):
  token-cross-collateral::test_cc_local_transfer_with_fee: passed -> failed
```

## Suites

| suite                                 | tests | passed | failed | ignored | SBF invocations | SBF programs loaded                                                                                                                                                                    | native builtins |
| ------------------------------------- | ----: | -----: | -----: | ------: | --------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| composite-ism/aggregation             |     7 |      7 |      0 |       0 |              16 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/amount_routing          |     7 |      7 |      0 |       0 |              16 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/big_isms                |     7 |      7 |      0 |       0 |             225 | hyperlane_sealevel_composite_ism                                                                                                                                                       | -               |
| composite-ism/composite               |    12 |     12 |      0 |       0 |              19 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/fallback_routing_compat |    13 |     13 |      0 |       0 |             121 | hyperlane_sealevel_composite_ism, hyperlane_sealevel_mailbox, hyperlane_sealevel_multisig_ism_message_id, hyperlane_sealevel_test_ism, hyperlane_sealevel_test_send_receiver, spl_noop | mock_mailbox    |
| composite-ism/fallback_routing        |    16 |     16 |      0 |       0 |             107 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/multisig                |     5 |      5 |      0 |       0 |              12 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/nested                  |    16 |     16 |      0 |       0 |              83 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/pausable                |     6 |      6 |      0 |       0 |              17 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/rate_limited            |    16 |     16 |      0 |       0 |              60 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/routing                 |     9 |      9 |      0 |       0 |              37 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/test_ism                |     4 |      4 |      0 |       0 |               9 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/trusted_relayer         |     5 |      5 |      0 |       0 |               9 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| composite-ism/versioning              |     1 |      1 |      0 |       0 |               1 | hyperlane_sealevel_composite_ism                                                                                                                                                       | mock_mailbox    |
| fee                                   |   175 |    175 |      0 |       0 |             608 | hyperlane_sealevel_fee                                                                                                                                                                 | -               |
| igp                                   |    81 |     81 |      0 |       0 |             435 | hyperlane_sealevel_igp                                                                                                                                                                 | -               |
| mailbox                               |    26 |     25 |      1 |       0 |             214 | hyperlane_sealevel_mailbox, hyperlane_sealevel_test_ism, hyperlane_sealevel_test_send_receiver, spl_noop                                                                               | -               |
| multisig-ism-message-id               |     6 |      6 |      0 |       0 |              14 | hyperlane_sealevel_ism_multisig_ism                                                                                                                                                    | -               |
| token-collateral                      |    34 |     34 |      0 |       0 |             560 | hyperlane_sealevel_fee, hyperlane_sealevel_igp, hyperlane_sealevel_mailbox, hyperlane_sealevel_test_ism, hyperlane_sealevel_token_collateral, spl_noop                                 | -               |
| token-cross-collateral                |    62 |     61 |      1 |       0 |             954 | hyperlane_sealevel_fee, hyperlane_sealevel_igp, hyperlane_sealevel_mailbox, hyperlane_sealevel_test_ism, hyperlane_sealevel_token_cross_collateral, spl_noop                           | -               |
| token-native                          |    36 |     36 |      0 |       0 |             368 | hyperlane_sealevel_fee, hyperlane_sealevel_igp, hyperlane_sealevel_mailbox, hyperlane_sealevel_test_ism, hyperlane_sealevel_token_native, spl_noop                                     | malicious_igp   |
| token                                 |    36 |     36 |      0 |       0 |             688 | hyperlane_sealevel_fee, hyperlane_sealevel_igp, hyperlane_sealevel_mailbox, hyperlane_sealevel_test_ism, hyperlane_sealevel_token, spl_noop                                            | -               |
| validator-announce                    |     4 |      4 |      0 |       0 |               8 | hyperlane_sealevel_validator_announce                                                                                                                                                  | -               |
| **total**                             |   584 |    582 |      2 |       0 |            4581 |                                                                                                                                                                                        |                 |

## Failed tests

- mailbox::functional::test_outbox_get_latest_checkpoint
- token-cross-collateral::test_cc_remote_transfer_igp_new_flow_with_fee

## CU per program

`cu` is inclusive of CPI children (the per-transaction view when depth 1); `self` subtracts BPF children.

| program                                   | tests | invocations | top-level | cu median | cu p90 |  cu max | self median | self p90 | total cu |
| ----------------------------------------- | ----: | ----------: | --------: | --------: | -----: | ------: | ----------: | -------: | -------: |
| composite_ism [8qbH..VfeR]                |    15 |          49 |        17 |      6823 |   8680 |  102177 |        6823 |     8680 |   387210 |
| composite_ism [Bprm..Qgau]                |   124 |         641 |       623 |     12259 |  18247 | 1126285 |       11623 |    15881 | 10042944 |
| fee [Fee1..1111]                          |   209 |         675 |       658 |      8113 |  36732 |   44455 |        8113 |    36732 |  9575993 |
| igp [BSff..M2BN]                          |   156 |         895 |       846 |      7798 |  29746 |   44055 |        7798 |    29746 |  9702684 |
| mailbox [692K..9iu1]                      |   151 |         311 |       258 |     14110 |  62805 |  200000 |       14110 |    54720 |  9750474 |
| multisig_ism_message_id [2Yjt..Z2fw]      |     6 |          14 |        14 |      5402 |   8932 |  101609 |        5402 |     8932 |   158541 |
| multisig_ism_message_id [CktR..Ezy8]      |     4 |          19 |         8 |      3088 |   8932 |  101800 |        3088 |     8932 |   181526 |
| spl_associated_token_account [ATok..8knL] |    64 |          88 |        66 |     16906 |  20071 |   27406 |       13018 |    16018 |  1524952 |
| spl_token [Toke..Q5DA]                    |     1 |           8 |         2 |      3496 |   4969 |    6083 |        3496 |     4969 |    26565 |
| spl_token_2022 [Toke..xuEb]               |   128 |         754 |       221 |      1279 |   1746 |    2368 |        1279 |     1746 |   901184 |
| test_ism [CWVY..4tnb]                     |   153 |         239 |       195 |      5180 |   5180 |    5180 |        5180 |     5180 |   935778 |
| test_send_receiver [FZ8h..vsEm]           |    26 |         109 |        83 |      3578 |   6911 |   54025 |        3578 |     6911 |   435743 |
| token [3MzU..pVQH]                        |    36 |         242 |       188 |      8292 |  77379 |  190514 |        8292 |    59041 |  6117095 |
| token_collateral [G8t1..F18z]             |    34 |         148 |       136 |     16040 |  32712 |  185982 |       16040 |    30507 |  3943165 |
| token_cross_collateral [CCo1..1111]       |    62 |         217 |       205 |     17489 |  53839 |  200000 |       17489 |    51634 |  8106286 |
| token_cross_collateral [CCo1..2222]       |     4 |          11 |         7 |     52173 |  79606 |   84106 |       49968 |    61988 |   443317 |
| token_native [CGn8..3aga]                 |    36 |         153 |       144 |     16145 |  27311 |  166855 |       16145 |    27311 |  3876262 |
| validator_announce [DH43..fEnn]           |     4 |           8 |         8 |      6900 |  77276 |   83420 |        6900 |    77276 |   192512 |

## ELFs

| file                                          | sha256             | resolved path                                                                    |
| --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| hyperlane_sealevel_composite_ism.so           | `4535d3ee103a82b6` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_composite_ism.so           |
| hyperlane_sealevel_fee.so                     | `5d9928b44ea44d9d` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_fee.so                     |
| hyperlane_sealevel_igp.so                     | `c10b0831d3b9322f` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_igp.so                     |
| hyperlane_sealevel_mailbox.so                 | `3c859aced1eb0933` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_mailbox.so                 |
| hyperlane_sealevel_multisig_ism_message_id.so | `7a97a5cc73794d2b` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_multisig_ism_message_id.so |
| hyperlane_sealevel_test_ism.so                | `e7ae22ba6ffbdb5f` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_test_ism.so                |
| hyperlane_sealevel_test_send_receiver.so      | `0db0b73d16bbc115` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_test_send_receiver.so      |
| hyperlane_sealevel_token.so                   | `d6d6514872b04d8a` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_token.so                   |
| hyperlane_sealevel_token_collateral.so        | `f229f40583fc5353` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_token_collateral.so        |
| hyperlane_sealevel_token_cross_collateral.so  | `498fcd6724869a38` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_token_cross_collateral.so  |
| hyperlane_sealevel_token_native.so            | `2469fe821209202d` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_token_native.so            |
| hyperlane_sealevel_validator_announce.so      | `3d378a96d3ea97cc` | /private/tmp/svm-bench/rust-elf-ci/hyperlane_sealevel_validator_announce.so      |
| spl_noop.so                                   | `1d42da5223112c26` | /private/tmp/svm-bench/rust-elf-ci/spl_noop.so                                   |
