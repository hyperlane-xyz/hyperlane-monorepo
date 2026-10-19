# Sealevel compute-unit benchmark, 2026-10-19

Rust programs on `pbio/sealevel-cu-optimizations` (merge of cu-keccak, cu-pda, cu-logs, cu-build) against
the unchanged main-branch Rust programs and the goSVM ports.

## Setup

- Harness: `rust/sealevel/programs/conformance.sh -j 4`, all 23 suites (584 tests), solana-program-test 3.0.x,
  every program loaded as an SBF ELF.
- Toolchain: agave 3.0.14 `cargo-build-sbf`, platform-tools v1.51 (`programs/toolchain.env`).
- After: the 11 embedded programs from `typescript/svm-sdk/scripts/build-program-bytes.sh` (byte-identical to
  `program-bytes.ts`), plus `test_send_receiver`. Two runs.
- Before: main-branch ELFs from the same toolchain. Two runs.
- Go: goSVM ports (hyperlane-xyz/hyperlane-monorepo#9852), one run.
- Hot paths are classified the same way in every run and paired by (suite, test, operation, ordinal); per pair
  the runs of a side are averaged, the table shows the median over pairs. `n` is the number of pairs.
- Noise: PDA bump searches with random keys add multiples of ~1,500 CU to some init calls. Run-to-run totals
  move by at most 1% per program; the median is unaffected.

## Status

- Rust before, run 1: 582/584; failed mailbox::functional::test_outbox_get_latest_checkpoint, token-cross-collateral::test_cc_remote_transfer_igp_new_flow_with_fee
- Rust before, run 2: 581/584; failed mailbox::functional::test_outbox_get_latest_checkpoint, token-cross-collateral::test_cc_local_transfer_with_fee, token-cross-collateral::test_cc_remote_transfer_igp_new_flow_with_fee
- Rust after, run 1: 584/584
- Rust after, run 2: 584/584
- Go, run 1: 584/584

Both "before" failures in every run were the 200k CU cap; both pass after.

## Hot paths

Median CU per call, including CPI children. Go column: Go CU relative to Rust before / after
(negative means Go uses less).

| operation | program | n | Rust before | Rust after | change | Go | Go vs before | Go vs after |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| dispatch | mailbox | 51 | 53,058 | 18,745 | -65% | 24,309 | -54% | +30% |
| process | mailbox | 36 | 142,784 | 73,027 | -49% | 77,339 | -46% | +6% |
| transfer_remote | token | 12 | 158,187 | 78,395 | -50% | 102,064 | -35% | +30% |
| transfer_remote | token_collateral | 11 | 153,190 | 74,627 | -51% | 94,307 | -38% | +26% |
| transfer_remote | token_cross_collateral | 14 | 172,531 | 86,216 | -50% | 114,198 | -34% | +32% |
| transfer_remote | token_native | 13 | 154,741 | 73,850 | -52% | 96,036 | -38% | +30% |
| handle | token | 16 | 79,629 | 41,149 | -48% | 41,137 | -48% | 0% |
| handle | token_collateral | 2 | 79,758 | 41,788 | -48% | 44,580 | -44% | +7% |
| handle | token_cross_collateral | 2 | 78,884 | 43,172 | -45% | 42,496 | -46% | -2% |
| handle | token_native | 1 | 48,960 | 10,983 | -78% | 14,821 | -70% | +35% |
| pay_for_gas (CPI from transfer_remote) | igp | 48 | 30,478 | 24,287 | -20% | 40,222 | +32% | +66% |
| pay_for_gas (direct) | igp | 4 | 23,056 | 15,048 | -35% | 25,183 | +9% | +67% |
| multisig verify (direct) | multisig_ism_message_id | 1 | 101,609 | 54,566 | -46% | 55,734 | -45% | +2% |
| validator announce | validator_announce | 2 | 79,032 | 43,522 | -45% | 48,428 | -39% | +11% |
| root query (outbox get_latest_checkpoint) | mailbox | 1 | 200,000 (cap, failed) | 8,780 | n/a | 9,251 | n/a | +5% |

Self CU (excluding BPF children), same pairs:

| operation | program | Rust before | Rust after | change | Go |
|---|---|---:|---:|---:|---:|
| dispatch | mailbox | 53,058 | 18,745 | -65% | 24,309 |
| process | mailbox | 61,277 | 30,599 | -50% | 31,910 |
| transfer_remote | token | 68,298 | 30,847 | -55% | 28,228 |
| transfer_remote | token_collateral | 69,342 | 29,641 | -57% | 28,061 |
| transfer_remote | token_cross_collateral | 79,542 | 33,886 | -57% | 37,088 |
| transfer_remote | token_native | 65,659 | 27,407 | -58% | 26,239 |
| handle | token | 60,541 | 21,686 | -64% | 22,799 |
| handle | token_collateral | 57,284 | 19,313 | -66% | 21,730 |
| handle | token_cross_collateral | 60,142 | 23,679 | -61% | 24,128 |
| handle | token_native | 48,960 | 10,983 | -78% | 14,821 |
| pay_for_gas (CPI from transfer_remote) | igp | 30,478 | 24,287 | -20% | 40,222 |
| pay_for_gas (direct) | igp | 23,056 | 15,048 | -35% | 25,183 |
| multisig verify (direct) | multisig_ism_message_id | 101,609 | 54,566 | -46% | 55,734 |
| validator announce | validator_announce | 79,032 | 43,522 | -45% | 48,428 |
| root query (outbox get_latest_checkpoint) | mailbox | 200,000 | 8,780 | n/a | 9,251 |

## Per-program self CU totals

Sum of self CU over (suite, test, program) cells that pass in every run with matching invocation counts.

| program | cells | Rust before | Rust after | change | Go | Go vs before | Go vs after |
|---|---:|---:|---:|---:|---:|---:|---:|
| composite_ism | 124 | 10,038,032 | 8,428,962 | -16% | 10,629,233 | +6% | +26% |
| fee | 206 | 9,496,656 | 8,503,456 | -10% | 11,224,961 | +18% | +32% |
| igp | 155 | 9,562,318 | 8,648,932 | -10% | 11,052,354 | +16% | +28% |
| mailbox | 148 | 7,366,256 | 4,552,893 | -38% | 5,132,299 | -30% | +13% |
| multisig_ism_message_id | 10 | 340,058 | 245,963 | -28% | 272,372 | -20% | +11% |
| test_ism | 150 | 920,238 | 920,238 | 0% | 978,528 | +6% | +6% |
| token | 36 | 4,706,320 | 3,342,490 | -29% | 3,650,992 | -22% | +9% |
| token_collateral | 34 | 2,858,558 | 2,184,528 | -24% | 2,437,825 | -15% | +12% |
| token_cross_collateral | 60 | 6,275,777 | 4,975,306 | -21% | 5,643,914 | -10% | +13% |
| token_native | 36 | 2,826,341 | 2,144,229 | -24% | 2,372,864 | -16% | +11% |
| validator_announce | 4 | 192,512 | 121,494 | -37% | 136,378 | -29% | +12% |

## ELF size

Embedded program bytes, main vs this branch.

| program | before | after | change |
|---|---:|---:|---:|
| mailbox | 176,640 | 170,448 | -3.5% |
| igp | 359,120 | 363,600 | +1.2% |
| multisigIsm | 165,976 | 147,704 | -11.0% |
| testIsm | 94,600 | 94,600 | +0.0% |
| compositeIsm | 263,904 | 247,176 | -6.3% |
| validatorAnnounce | 130,008 | 113,184 | -12.9% |
| tokenSynthetic | 402,856 | 408,408 | +1.4% |
| tokenNative | 378,040 | 383,880 | +1.5% |
| tokenCollateral | 405,000 | 410,552 | +1.4% |
| tokenCrossCollateral | 525,384 | 529,568 | +0.8% |
| tokenFee | 349,344 | 349,344 | +0.0% |
| total | 3,250,872 | 3,218,464 | -1.0% |

## Reproduce

```bash
bash typescript/svm-sdk/scripts/build-program-bytes.sh   # needs agave 3.0.14 on PATH, macOS arm64
# add test_send_receiver.so (cargo build-sbf --tools-version v1.51 in programs/test-send-receiver) and spl_noop.so
rust/sealevel/programs/conformance.sh -j 4 -o after.json <elf-dir>
rust/sealevel/programs/conformance/cu-diff.py before.json after.json --metric self_cu
```
