# Mailbox conformance: Go (goSVM) vs CI-built Rust

2026-10-19, agent K. Worktree /tmp/hm1-gosvm, branch gosvm/integration. JSON: mailbox-conformance.json.

## TL;DR

- Rust suite `mailbox-test` (26 tests), solana-program-test 3.0.7, every program loaded as SBF:
  - (a) CI Rust ELFs: **25/26**. Fails `test_outbox_get_latest_checkpoint` (Rust runs out of CU, known baseline).
  - (b) same set, mailbox swapped for the Go fogo-v0 ELF: **24/26** (23/26 before this round's fixes). Fails `test_protocol_fee` and `test_claim_protocol_fees_after_rent_reduction`, both on the ClaimProtocolFees lamport debit (blocked on goSVM MoveLamports). Passes `test_outbox_get_latest_checkpoint` (18,002 CU vs Rust's 200,000+).
- Commits: 86d89456bd (inbox borrow guard, fixes `test_process_errors_if_reentrant`), a28bbc5d35 (ClaimProtocolFees checks).
- CU, paired median Go/Rust over the 23 tests that pass on both: **1.67** per test, **1.11** with Init excluded. Init is 1.90x and starts every test.
- msg! confound: compiling out Rust's msg! cuts dispatch 31%, process 20%, TransferOwnership 18%, others ~0%. Fixture dispatch Go/Rust goes from 0.46 to 0.68, process from 0.76 to 0.95. Init does not change (2.00).
- CI Rust mailbox ELF (3c859ace...) gives the same CU as the 1.18.18 build (baf14c51...) on all 64 fixture steps. The earlier pilot numbers still hold.

## Inputs

| ELF                                                                             | sha256                                                           |   Bytes |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------: |
| Rust CI mailbox (agave 3.0.14, tools v1.51, SBPFv0)                             | 3c859aced1eb093398afb1d95a718c95957f8969a0d4b86b413b0a4ebd9c736b | 176,640 |
| Rust CI mailbox, msg! compiled out (temp patch, reverted)                       | 4ff655db16c3778c1ef382813c8c980a605b2d5f629e2fa2612fafeb042317d4 | 162,872 |
| Go mailbox fogo-v0 @ a28bbc5d35 (rebuilt after the doc-comment amend: same sha) | 041fe78f587d4105d4d97e1b76581afefc2e39d931d6a637e890037e99f0e9dd |  62,128 |
| Go mailbox solana-v3 @ a28bbc5d35                                               | 92f9d95bc10e02466d62f3ac5c2b0a55231522837b7ec6486e0d75a9e6f16bbc |         |
| Go mailbox fogo-v0 @ 665a68de7c (before fixes)                                  | e29f58d07f14ddbf548e45bbecc4d14def0123f3b8f02e8c5e088493abb4802e |  60,504 |

Every other program (test_ism, test_send_receiver, spl_noop = noop_aligned.so) is the same file in all three runs: /tmp/svm-bench/rust-elf-ci (MANIFEST.md there). Go built with gosvm-int (hyperlane-integration 843b1e0), platform-tools v1.57.

Harness: F's conformance.sh, copied to /tmp/svm-bench/k/harness with PROGRAMS_DIR pointed at this worktree. Its EXIT trap prints `stage: unbound variable` (`local stage` is out of scope when the trap runs), so the staging dir leaks. Harmless, F should fix it.

## Proof of BPF execution

From the kept logs (/tmp/svm-bench/k/conf-{a,b,c}.logs/mailbox.log):

| Run             | `"hyperlane_sealevel_mailbox" SBF program from` | builtin programs | `Program 692KZ... consumed` | `Program log: Dispatched message` |
| --------------- | ----------------------------------------------: | ---------------: | --------------------------: | --------------------------------: |
| (a) Rust CI     |                                              51 |                0 |                          71 |                                 6 |
| (b) Go          |                                              51 |                0 |                          65 |                                 0 |
| (c) Rust no-msg |                                              51 |                0 |                          71 |                                 0 |

The report JSON records the staged mailbox sha per run (3c859ace / 041fe78f / 4ff655db). The Rust log lines are missing in (b), which confirms the Go ELF ran.

## Failures

| Run                   | Test                                          | Reason                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a), (c)              | test_outbox_get_latest_checkpoint             | Rust OutboxGetLatestCheckpoint uses all 200,000 CU (software keccak over the tree). Baseline, not a port issue                                                                                                                                                                                                                          |
| (b)                   | test_protocol_fee                             | ClaimProtocolFees with a positive amount returns InvalidInstructionData. The debit needs `solana.MoveLamports` (goSVM-runtime branch gap1-move-lamports, 949bb71). It is not in gosvm-int 843b1e0 or the pinned SDK. It also reuses code 2018, which the integration branch already gives Secp256k1Recover, so merging needs a renumber |
| (b)                   | test_claim_protocol_fees_after_rent_reduction | Same blocker. The wrong-beneficiary checks (InvalidArgument) now pass; the test fails at the first positive claim (functional.rs:520)                                                                                                                                                                                                   |
| (b) before 86d89456bd | test_process_errors_if_reentrant              | Go returned MissingAccount; Rust expects AccountBorrowFailed. Fixed                                                                                                                                                                                                                                                                     |

No test asserts log output, so dropping msg! loses no coverage.

## Fixes (Go mailbox only)

- 86d89456bd fix(sealevel): match Rust's inbox borrow guard in the Go mailbox. Rust holds a RefMut of the inbox data across InboxProcess's three CPIs, so its checked `invoke` fails with AccountBorrowFailed if any of those CPIs is passed the inbox. Go now checks each CPI's account range for the inbox key before invoking. Cost: +32 CU Init path (layout), +16 dispatch, +81 process (fixtures).
- a28bbc5d35 feat(sealevel): port ClaimProtocolFees checks to the Go mailbox. Outbox PDA check, beneficiary check (InvalidArgument), Rent, then verify_rent_exempt, in Rust's order. A zero claim now matches Rust exactly (Success or AccountNotRentExempt). A positive claim stays a TODO until MoveLamports is in the pin.

Known remaining divergences, not covered by any test: Go CPIs cap at 16 account metas (goSVM limit; Rust allows more). InboxProcess locates the recipient program before the first CPI, so with the recipient missing Go returns InvalidArgument where Rust's CPI fails first.

## CU: functional suite, per test

Mailbox `self` CU, i.e. the mailbox's consumed CU minus its BPF CPI children (test_ism, test_send_receiver; both are Rust in every run), summed over all mailbox invocations in the test. A test pairs only if it passed in both runs with the same invocation sequence. "excl Init" drops the first call (Init) of each test.

| test                                                                      | Rust   | Go     | mailbox ix (R/G) | Rust self CU | Go self CU | Go/Rust self | Rust excl Init | Go excl Init | Go/Rust excl Init | Rust incl CU | Go incl CU |
| ------------------------------------------------------------------------- | ------ | ------ | ---------------: | -----------: | ---------: | -----------: | -------------: | -----------: | ----------------: | -----------: | ---------: |
| test_claim_protocol_fees_after_rent_reduction                             | passed | failed |              9/3 |       47,918 |     36,166 |            - |         33,808 |        9,327 |                 - |       47,918 |     36,166 |
| test_dispatch_from_eoa                                                    | passed | passed |              3/3 |      104,340 |     65,029 |       0.6232 |         90,230 |       38,222 |            0.4236 |      104,340 |     65,029 |
| test_dispatch_from_program                                                | passed | passed |              2/2 |       57,548 |     54,334 |       0.9442 |         43,438 |       27,527 |            0.6337 |       57,548 |     54,334 |
| test_dispatch_returns_message_id                                          | passed | passed |              2/2 |       52,742 |     46,568 |       0.8829 |         38,632 |       19,761 |            0.5115 |       52,742 |     46,568 |
| test_get_program_version                                                  | passed | passed |              1/1 |          291 |        301 |       1.0344 |              - |            - |                 - |          291 |        301 |
| test_get_recipient_ism_errors_with_malformatted_recipient_ism_return_data | passed | passed |              2/2 |       19,523 |     33,690 |       1.7257 |          5,413 |        6,883 |            1.2716 |       20,192 |     34,359 |
| test_get_recipient_ism_when_no_return_data                                | passed | passed |              2/2 |       19,048 |     33,456 |       1.7564 |          4,938 |        6,649 |            1.3465 |       19,609 |     34,017 |
| test_get_recipient_ism_when_option_none_returned                          | passed | passed |              2/2 |       19,157 |     33,881 |       1.7686 |          5,047 |        7,074 |            1.4016 |       19,845 |     34,569 |
| test_get_recipient_ism_when_specified                                     | passed | passed |              2/2 |       19,180 |     34,147 |       1.7803 |          5,070 |        7,340 |            1.4477 |       19,917 |     34,884 |
| test_inbox_set_default_ism                                                | passed | passed |              2/2 |       19,784 |     35,636 |       1.8013 |          5,674 |        8,829 |             1.556 |       19,784 |     35,636 |
| test_inbox_set_default_ism_errors_if_owner_not_signer                     | passed | passed |              3/3 |       25,887 |     43,167 |       1.6675 |         11,777 |       16,360 |            1.3891 |       25,887 |     43,167 |
| test_initialize                                                           | passed | passed |              1/1 |       14,110 |     26,807 |       1.8999 |              0 |            0 |                 - |       14,110 |     26,807 |
| test_initialize_errors_if_called_twice                                    | passed | passed |              2/2 |       18,876 |     33,279 |        1.763 |          4,766 |        6,472 |             1.358 |       18,876 |     33,279 |
| test_outbox_get_latest_checkpoint                                         | failed | passed |              3/3 |      251,350 |     66,197 |            - |        237,240 |       39,390 |                 - |      251,350 |     66,197 |
| test_process_errors_if_incorrect_destination_domain                       | passed | passed |              3/3 |       36,248 |     40,731 |       1.1237 |         22,138 |       13,924 |             0.629 |       36,985 |     41,468 |
| test_process_errors_if_ism_verify_fails                                   | passed | passed |              3/3 |       50,824 |     68,888 |       1.3554 |         36,714 |       42,081 |            1.1462 |       52,971 |     71,035 |
| test_process_errors_if_message_already_processed                          | passed | passed |              5/5 |       93,359 |     94,836 |       1.0158 |         79,249 |       68,029 |            0.8584 |      113,004 |    114,427 |
| test_process_errors_if_recipient_handle_fails                             | passed | passed |              3/3 |       56,167 |     71,487 |       1.2728 |         42,057 |       44,680 |            1.0624 |       63,910 |     79,230 |
| test_process_errors_if_recipient_not_a_program                            | passed | passed |              1/1 |       14,110 |     26,807 |       1.8999 |              0 |            0 |                 - |       14,110 |     26,807 |
| test_process_errors_if_reentrant                                          | passed | passed |              3/3 |       60,120 |     77,407 |       1.2875 |         46,010 |       50,600 |            1.0998 |       62,259 |     79,546 |
| test_process_errors_if_wrong_message_version                              | passed | passed |              3/3 |       34,479 |     36,524 |       1.0593 |         20,369 |        9,717 |             0.477 |       35,216 |     37,261 |
| test_process_successful_verify_and_handle                                 | passed | passed |              5/5 |      118,998 |    112,922 |       0.9489 |        104,888 |       86,115 |             0.821 |      156,106 |    149,814 |
| test_protocol_fee                                                         | passed | failed |              3/3 |       55,366 |     51,578 |            - |         41,256 |       24,771 |                 - |       55,366 |     51,578 |
| test_setting_invalid_protocol_fee_config_fails                            | passed | passed |              2/2 |       18,233 |     31,627 |       1.7346 |          4,123 |        4,820 |            1.1691 |       18,233 |     31,627 |
| test_setting_protocol_fee_config_from_unauthorized_account_fails          | passed | passed |              2/2 |       18,083 |     31,266 |        1.729 |          3,973 |        4,459 |            1.1223 |       18,083 |     31,266 |
| test_setting_valid_protocol_fee_config_works                              | passed | passed |              2/2 |       18,812 |     31,997 |       1.7009 |          4,702 |        5,190 |            1.1038 |       18,812 |     31,997 |

Suite Init is 14,110 (Rust) / 26,807 (Go), but 12,610 / 25,214 in the fixtures. Both sides add the same ~1.6k, so the difference comes from the program-test environment, not the port.

| Summary                          | Go vs Rust CI | Go vs Rust CI no-msg | Rust no-msg vs Rust CI |
| -------------------------------- | ------------: | -------------------: | ---------------------: |
| Paired tests                     |            23 |                   23 |                     25 |
| Median per-test ratio            |        1.6675 |               1.7014 |                 0.9756 |
| Median per-test ratio, excl Init |         1.113 |               1.1472 |                 0.9372 |
| Median per-invocation ratio      |        1.4477 |                 1.45 |                 0.9989 |

Selected calls from the suite:

| Instruction (test, mailbox call #)                                | Rust CI | Rust CI no-msg |     Go | Go/Rust | Go/Rust no-msg |
| ----------------------------------------------------------------- | ------: | -------------: | -----: | ------: | -------------: |
| Init (test_initialize #1)                                         |  14,110 |         14,102 | 26,807 |   1.900 |          1.901 |
| OutboxDispatch (1st) (test_dispatch_from_eoa #2)                  |  40,116 |         26,380 | 18,134 |   0.452 |          0.687 |
| OutboxDispatch (2nd) (test_dispatch_from_eoa #3)                  |  50,114 |         36,432 | 20,088 |   0.401 |          0.551 |
| OutboxDispatch (test_dispatch_returns_message_id #2)              |  38,632 |         24,880 | 19,761 |   0.512 |          0.794 |
| OutboxDispatch via CPI (depth 2) (test_dispatch_from_program #2)  |  43,438 |         31,026 | 27,527 |   0.634 |          0.887 |
| InboxProcess (1st) (test_process_successful_verify_and_handle #3) |  47,401 |         37,418 | 35,791 |   0.755 |          0.957 |
| InboxProcess (2nd) (test_process_successful_verify_and_handle #5) |  47,347 |         37,418 | 35,644 |   0.753 |          0.953 |
| InboxGetRecipientIsm (test_get_recipient_ism_when_specified #2)   |   5,070 |          5,062 |  7,340 |   1.448 |          1.450 |
| OutboxGetLatestCheckpoint (test_outbox_get_latest_checkpoint #3)  | 200,000 |        200,000 | 18,002 |   0.090 |          0.090 |

## CU: mailbox SVM fixtures (run-svm-fixtures.sh), CI Rust ELF

Same fixture file (18 scenarios, 64 transactions, exact state asserted), fogo-v0 runner (LiteSVM 0.8.2). All 64 pass on Rust CI, Rust CI no-msg, Go fogo-v0 and Go solana-v3. Medians over successful steps. Go/Rust columns are paired medians. "msg! share" = 1 - paired median(no-msg / msg). Rust CI equals the earlier 1.18.18 build on 64/64 steps.

| Instruction               |   n | Rust CI | Rust CI no-msg | msg! share | Go fogo-v0 | Go solana-v3 | Go/Rust | Go/Rust no-msg |
| ------------------------- | --: | ------: | -------------: | ---------: | ---------: | -----------: | ------: | -------------: |
| Init                      |   1 |  12,610 |         12,602 |       0.1% |     25,214 |       25,042 |     2.0 |          2.001 |
| OutboxDispatch            |  16 |  38,440 |         26,501 |      31.3% |     17,724 |       17,584 |   0.463 |          0.679 |
| InboxProcess              |   3 |  42,517 |         33,872 |      20.3% |     32,162 |       31,820 |   0.756 |           0.95 |
| OutboxGetCount            |   1 |   3,590 |          3,584 |       0.2% |      4,395 |        4,392 |   1.224 |          1.226 |
| OutboxGetLatestCheckpoint |   1 | 376,780 |        376,773 |       0.0% |     18,192 |       18,189 |   0.048 |          0.048 |
| OutboxGetRoot             |   1 | 376,743 |        376,743 |       0.0% |     17,925 |       17,922 |   0.048 |          0.048 |
| GetOwner                  |   3 |   3,451 |          3,451 |       0.0% |      4,726 |        4,723 |   1.354 |          1.354 |
| InboxSetDefaultIsm        |   1 |   5,675 |          5,674 |       0.0% |      8,830 |        8,854 |   1.556 |          1.556 |
| SetProtocolFeeConfig      |   1 |   4,703 |          4,705 |       0.0% |      5,191 |        5,188 |   1.104 |          1.103 |
| TransferOwnership         |   2 |   5,852 |          4,700 |      18.0% |      9,218 |        9,215 |   1.712 |          1.964 |
| GetProgramVersion         |   1 |     291 |            290 |       0.3% |        301 |          302 |   1.034 |          1.038 |
| ALL successful            |  31 |  36,940 |         25,001 |      20.0% |     17,622 |       17,482 |   0.479 |           0.71 |
| ALL steps                 |  64 |  12,610 |         12,602 |       5.7% |     17,724 |       17,584 |   1.074 |           1.14 |

## msg! confound

- Dispatch: msg! is 31% of Rust's CU (two lines, base58 pubkeys and a hex H256). Without it Rust is 26,501 CU and Go 17,724: Go still costs 0.68x Rust. The rest of the gap is mostly keccak: Rust hashes in software, Go uses sol_keccak256.
- Process: 20% of Rust's CU. Without it, Go/Rust is 0.95 in the fixtures and the suite.
- TransferOwnership: 18% (access-control's "Ownership transferred" line). Go/Rust goes from 1.71 to 1.96.
- Init, admin ops, queries: no msg! on success paths, so no change. Go stays 1.1-2.0x slower there (byte-wise copies, merkle.Init into unaligned account data).
- Error paths: Rust's `msg!("{}", err)` runs on every failure. That is part of why Rust failure steps cost more (e.g. wrong message version: 15,299 vs 2,377).
- Variant: `msg!` shadowed by an empty `macro_rules!` in mailbox processor.rs and access-control lib.rs, built with the same toolchain into /tmp/svm-bench/k/elf-nomsg, then reverted with `git checkout` (tree clean). Removing msg! also shifts inlining. One suite test got 3k CU dearer (test_process_errors_if_recipient_handle_fails, 1.07x), so read single-call deltas as ±a few %.

## Files

- /tmp/svm-bench/rust-elf-ci/MANIFEST.md: canonical Rust ELFs
- /tmp/svm-bench/k/conf-{a,b,b-head,c}.json (+ .md, .logs/): conformance reports and raw logs
- /tmp/svm-bench/k/fixtures/: fixture file and runner reports
- /tmp/svm-bench/k/cu_pair.py, fixture_table.py: table generators
- /tmp/svm-bench/k/elf-b, elf-c: ELF sets for runs (b), (c)
