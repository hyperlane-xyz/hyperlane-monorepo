# Sealevel system conformance: all-Go vs Rust

- Go: every Hyperlane program built from gosvm/all 5a9323e5af with gosvm-int2 (goSVM hyperlane-integration-2 fe6d6b406c, fogo-v0; cross-collateral with -max-accounts 64), ELF dir /tmp/hm1-all-elf/go6: mailbox, IGP, fee, validator-announce, multisig-ism-message-id, composite-ism, test-ism, token, token-collateral, token-native, token-cross-collateral, spl-noop. Only test_send_receiver (test-only, no Go port) is the Rust CI ELF.
- Rust: canonical CI ELFs /tmp/svm-bench/rust-elf-ci (agave 3.0.14 cargo-build-sbf, platform-tools v1.51); spl_noop = noop_aligned.so; multisig alias hyperlane_sealevel_ism_multisig_ism.so -> multisig_ism_message_id.
- Harness: rust/sealevel/programs/conformance.sh, all 23 suites, -j 4; runs /tmp/hm1-all-conf/rust1.json and go6.json (logs alongside).
- Rust failures are the known 200k-CU baseline failures (mailbox test_outbox_get_latest_checkpoint, cc test_cc_remote_transfer_igp_new_flow_with_fee); test_cc_local_transfer_with_fee (flaky) passed in this run. Go passes both.
- Log parity: per-test Program log lines (keys/hashes masked) match Rust in 583/584 tests; the one difference is the extra success line in test_cc_remote_transfer_igp_new_flow_with_fee, which Rust fails at 200k CU (/tmp/hm1-all-tools/logdiff.py).
- Before integration-2 (gosvm-int, no logs, claims unsupported; go1.json): Go 580/584, CU median 1.317 / p90 1.899 vs Rust. int1 -> int2 per program: see the last table.
- Logging cost on the same compiler (no-log -> log build): fee +6.1% total CU, IGP +7.7%, composite +1.1%. Mailbox/token logging cost not isolated (mixed with the compiler change in go1 -> go6). -max-accounts 64 on cross-collateral: +4 CU per invocation.
- ELF bytes Go/Rust (fogo-v0 vs CI): hyperlane_sealevel_composite_ism 132272/263904; hyperlane_sealevel_fee 174720/349344; hyperlane_sealevel_igp 163336/359120; hyperlane_sealevel_mailbox 63984/176640; hyperlane_sealevel_multisig_ism_message_id 54136/165976; hyperlane_sealevel_test_ism 22480/94600; hyperlane_sealevel_token_collateral 134000/405000; hyperlane_sealevel_token_cross_collateral 168024/525384; hyperlane_sealevel_token_native 121928/378040; hyperlane_sealevel_token 132672/402856; hyperlane_sealevel_validator_announce 32928/130008; spl_noop 2408/2024;
- CPI caps raised to goSVM 64 metas (5a9323e5af): QuoteFee (17 metas) and quoted overhead-IGP PayForGas (22) no longer fail with 2006; covered by native tests only (no Rust functional test reaches them). CU delta vs the 16-cap build (go5 -> go6): 0 CU on 89% of invocations, per-program median 1.000; other deltas are whole PDA bump searches from random keys or under 20 CU.

## Suites (pass/total)

| suite                                 |        Rust |          Go |
| ------------------------------------- | ----------: | ----------: |
| mailbox                               |       25/26 |       26/26 |
| igp                                   |       81/81 |       81/81 |
| validator-announce                    |         4/4 |         4/4 |
| multisig-ism-message-id               |         6/6 |         6/6 |
| token                                 |       36/36 |       36/36 |
| token-collateral                      |       34/34 |       34/34 |
| token-native                          |       36/36 |       36/36 |
| token-cross-collateral                |       61/62 |       62/62 |
| fee                                   |     175/175 |     175/175 |
| composite-ism/aggregation             |         7/7 |         7/7 |
| composite-ism/amount_routing          |         7/7 |         7/7 |
| composite-ism/big_isms                |         7/7 |         7/7 |
| composite-ism/composite               |       12/12 |       12/12 |
| composite-ism/fallback_routing_compat |       13/13 |       13/13 |
| composite-ism/fallback_routing        |       16/16 |       16/16 |
| composite-ism/multisig                |         5/5 |         5/5 |
| composite-ism/nested                  |       16/16 |       16/16 |
| composite-ism/pausable                |         6/6 |         6/6 |
| composite-ism/rate_limited            |       16/16 |       16/16 |
| composite-ism/routing                 |         9/9 |         9/9 |
| composite-ism/test_ism                |         4/4 |         4/4 |
| composite-ism/trusted_relayer         |         5/5 |         5/5 |
| composite-ism/versioning              |         1/1 |         1/1 |
| **total**                             | **582/584** | **584/584** |

Failures:

- Rust mailbox::functional::test_outbox_get_latest_checkpoint
- Rust token-cross-collateral::test_cc_remote_transfer_igp_new_flow_with_fee

Status changes (Rust -> Go):

- mailbox::functional::test_outbox_get_latest_checkpoint: failed -> passed
- token-cross-collateral::test_cc_remote_transfer_igp_new_flow_with_fee: failed -> passed

## Per-program CU (Go/Rust, paired per invocation)

`cu` includes CPI children; `self` excludes BPF children. Ratios > 1 mean Go costs more.

| program                                   | pairs | cu median | cu p90 | cu total | self median | self p90 | self total | Rust cu median | Go cu median | Rust total CU | Go total CU |
| ----------------------------------------- | ----: | --------: | -----: | -------: | ----------: | -------: | ---------: | -------------: | -----------: | ------------: | ----------: |
| composite_ism [8qbH..VfeR]                |    49 |     1.319 |  1.411 |    1.095 |       1.319 |    1.411 |      1.095 |           6823 |         9166 |       387,210 |     423,954 |
| composite_ism [Bprm..Qgau]                |   641 |     1.202 |  1.368 |    1.052 |       1.202 |    1.368 |      1.057 |          12259 |        13898 |    10,042,944 |  10,565,547 |
| fee [Fee1..1111]                          |   675 |     1.271 |  1.371 |    1.187 |       1.271 |    1.371 |      1.187 |           8113 |        10598 |     9,536,691 |  11,319,483 |
| igp [BSff..M2BN]                          |   895 |     1.205 |  1.361 |    1.152 |       1.205 |    1.361 |      1.152 |           7804 |         7151 |     9,716,707 |  11,195,152 |
| mailbox [692K..9iu1]                      |   311 |     1.061 |  1.089 |    0.670 |       1.061 |    1.145 |      0.685 |          14110 |        14974 |     9,704,922 |   6,497,596 |
| multisig_ism_message_id [2Yjt..Z2fw]      |    14 |     1.144 |  1.364 |    0.783 |       1.144 |    1.364 |      0.783 |           5402 |         5906 |       158,541 |     124,205 |
| multisig_ism_message_id [CktR..Ezy8]      |    19 |     1.108 |  1.205 |    0.816 |       1.108 |    1.205 |      0.816 |           3088 |         4698 |       181,526 |     148,167 |
| test_ism [CWVY..4tnb]                     |   239 |     1.066 |  1.241 |    1.063 |       1.066 |    1.241 |      1.063 |           5180 |         5520 |       935,778 |     995,088 |
| token [3MzU..pVQH]                        |   242 |     1.043 |  1.163 |    0.795 |       1.043 |    1.163 |      0.776 |           8197 |         8822 |     6,078,418 |   4,831,390 |
| token_collateral [G8t1..F18z]             |   148 |     1.095 |  1.181 |    0.842 |       1.095 |    1.181 |      0.857 |          16040 |        10611 |     3,918,097 |   3,299,364 |
| token_cross_collateral [CCo1..1111]       |   217 |     1.094 |  1.249 |    0.881 |       1.098 |    1.249 |      0.891 |          17489 |        14980 |     8,145,685 |   7,176,791 |
| token_cross_collateral [CCo1..2222]       |    11 |     1.095 |  1.103 |    0.906 |       1.099 |    1.103 |      0.877 |          52173 |        53843 |       438,817 |     397,662 |
| token_native [CGn8..3aga]                 |   153 |     1.094 |  1.139 |    0.825 |       1.094 |    1.139 |      0.839 |          16145 |        10250 |     3,867,726 |   3,190,673 |
| validator_announce [DH43..fEnn]           |     8 |     0.995 |  1.150 |    0.708 |       0.995 |    1.150 |      0.708 |           6900 |         7702 |       192,512 |     136,378 |
| spl_associated_token_account [ATok..8knL] |    88 |     1.000 |  1.282 |    1.022 |       1.000 |    1.346 |      1.027 |          16914 |        17446 |     1,551,952 |   1,586,452 |
| spl_token [Toke..Q5DA]                    |     8 |     1.000 |  1.000 |    1.000 |       1.000 |    1.000 |      1.000 |           3496 |         3496 |        26,565 |      26,565 |
| spl_token_2022 [Toke..xuEb]               |   754 |     1.000 |  1.000 |    1.000 |       1.000 |    1.000 |      1.000 |           1279 |         1279 |       901,184 |     901,184 |
| test_send_receiver [FZ8h..vsEm]           |   109 |     1.000 |  1.000 |    0.965 |       1.000 |    1.000 |      1.000 |           3578 |         3578 |       435,975 |     420,568 |
| **ALL**                                   |  4581 |     1.094 |  1.306 |        - |       1.096 |    1.306 |          - |                |              |               |             |

## Highlighted operations

transfer_remote = token program at depth 1 that CPIs the mailbox; dispatch = mailbox CPI from another program;
process = mailbox at depth 1 that CPIs an ISM; handle = successful token program CPI from the mailbox after the ISM verify.

| operation           | program                | pairs | cu median | cu p90 | cu total | self median | self total | Rust cu median | Go cu median | Rust self median | Go self median |
| ------------------- | ---------------------- | ----: | --------: | -----: | -------: | ----------: | ---------: | -------------: | -----------: | ---------------: | -------------: |
| **dispatch**        | mailbox                |    52 |     0.486 |  0.534 |    0.489 |       0.486 |      0.489 |          51612 |        25084 |            51612 |          25084 |
| **handle**          | token                  |    16 |     0.532 |  0.572 |    0.526 |       0.386 |      0.383 |          77379 |        41137 |            59041 |          22799 |
| **handle**          | token_collateral       |     2 |     0.552 |  0.558 |    0.551 |       0.375 |      0.374 |          80884 |        44580 |            58034 |          21730 |
| **handle**          | token_cross_collateral |     2 |     0.519 |  0.539 |    0.517 |       0.388 |      0.387 |          82260 |        42496 |            62392 |          24128 |
| **handle**          | token_native           |     1 |     0.303 |  0.303 |    0.303 |       0.303 |      0.303 |          48960 |        14821 |            48960 |          14821 |
| **process**         | mailbox                |    36 |     0.570 |  0.763 |    0.574 |       0.547 |      0.565 |         142638 |        77339 |            60010 |          31910 |
| **transfer_remote** | token                  |    12 |     0.649 |  0.706 |    0.653 |       0.415 |      0.438 |         157368 |       102064 |            69825 |          28228 |
| **transfer_remote** | token_collateral       |    11 |     0.620 |  0.682 |    0.637 |       0.418 |      0.460 |         150951 |        94307 |            67146 |          28061 |
| **transfer_remote** | token_cross_collateral |    15 |     0.657 |  0.734 |    0.657 |       0.452 |      0.457 |         173699 |       115511 |            79803 |          37766 |
| **transfer_remote** | token_native           |    13 |     0.618 |  0.709 |    0.619 |       0.393 |      0.402 |         155040 |        96036 |            65647 |          26239 |

## Go int1 -> int2 (same tests, per program)

A = go1 (gosvm-int, old pin, no logs, claims unsupported), B = go6 (gosvm-int2 fe6d6b406c, logs, MoveLamports claims, merkle copy(), CC -max-accounts 64, 64-meta CPI caps). Ratio B/A; < 1 means int2 is cheaper.

| program                                   | pairs | cu median | cu p90 | cu total | self median | self total | int1 total CU | int2 total CU |
| ----------------------------------------- | ----: | --------: | -----: | -------: | ----------: | ---------: | ------------: | ------------: |
| composite_ism [8qbH..VfeR]                |    49 |     0.761 |  0.810 |    0.773 |       0.761 |      0.773 |       548,634 |       423,954 |
| composite_ism [Bprm..Qgau]                |   641 |     0.802 |  0.839 |    0.819 |       0.802 |      0.820 |    12,899,007 |    10,565,547 |
| fee [Fee1..1111]                          |   675 |     0.873 |  0.992 |    0.860 |       0.873 |      0.860 |    13,167,904 |    11,319,483 |
| igp [BSff..M2BN]                          |   886 |     0.847 |  0.987 |    0.848 |       0.847 |      0.848 |    13,207,791 |    11,195,152 |
| mailbox [692K..9iu1]                      |   303 |     0.559 |  1.030 |    0.741 |       0.559 |      0.713 |     8,772,193 |     6,497,596 |
| multisig_ism_message_id [2Yjt..Z2fw]      |    14 |     0.785 |  0.977 |    0.758 |       0.785 |      0.758 |       163,881 |       124,205 |
| multisig_ism_message_id [CktR..Ezy8]      |    19 |     0.638 |  0.944 |    0.730 |       0.638 |      0.730 |       202,885 |       148,167 |
| spl_associated_token_account [ATok..8knL] |    88 |     1.000 |  1.188 |    1.028 |       1.000 |      1.035 |     1,542,952 |     1,586,452 |
| spl_token [Toke..Q5DA]                    |     8 |     1.000 |  1.000 |    1.000 |       1.000 |      1.000 |        26,565 |        26,565 |
| spl_token_2022 [Toke..xuEb]               |   754 |     1.000 |  1.000 |    1.000 |       1.000 |      1.000 |       901,184 |       901,184 |
| test_ism [CWVY..4tnb]                     |   239 |     0.859 |  0.955 |    0.853 |       0.859 |      0.853 |     1,166,375 |       995,088 |
| test_send_receiver [FZ8h..vsEm]           |   109 |     1.000 |  1.000 |    1.005 |       1.000 |      1.001 |       418,438 |       420,568 |
| token [3MzU..pVQH]                        |   242 |     0.772 |  0.969 |    0.849 |       0.772 |      0.821 |     5,692,864 |     4,831,390 |
| token_collateral [G8t1..F18z]             |   148 |     0.740 |  0.893 |    0.818 |       0.740 |      0.787 |     4,032,347 |     3,299,364 |
| token_cross_collateral [CCo1..1111]       |   217 |     0.870 |  0.966 |    0.882 |       0.865 |      0.862 |     8,134,286 |     7,176,791 |
| token_cross_collateral [CCo1..2222]       |    11 |     0.866 |  1.219 |    0.948 |       0.862 |      0.921 |       419,674 |       397,662 |
| token_native [CGn8..3aga]                 |   153 |     0.808 |  0.933 |    0.834 |       0.808 |      0.816 |     3,825,017 |     3,190,673 |
| validator_announce [DH43..fEnn]           |     8 |     0.827 |  0.925 |    0.858 |       0.827 |      0.858 |       159,022 |       136,378 |
| **ALL**                                   |  4564 |     0.859 |  1.000 |        - |       0.858 |          - |               |               |
