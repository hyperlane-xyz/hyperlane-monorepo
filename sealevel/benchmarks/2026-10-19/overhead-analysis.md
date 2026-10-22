# Why the Go Sealevel ports cost more per call than Rust, and what fixed it

October 19, 2026. Go ports on `gosvm/all` (hyperlane-xyz/hyperlane-monorepo#9852),
Rust baselines: CI ELFs from `main` (run `rust1`) and the optimised Rust
programs from #9858 (runs `merged-run1`, and `merged-run2` for noise). All runs are `rust/sealevel/programs/conformance.sh` over the
23 Rust functional suites, per-invocation CU, fogo-v0 Go ELFs.

Data and tools: [`overhead-data/`](overhead-data/) (attribution table, the go9
and go11 reports, the microbenchmark source, the classification tools and the scratch
probe patch). The per-invocation class tables, probe logs and conformance JSONs
(runs go6 to go11, go7b1/b2, go7i3) are local runs, several MB each, and not
committed; `conformance.sh` regenerates them.

## Short version

- The "median 9% more CU" was an artefact of what the suites call most: the
  fixture setup and admin instructions (Init*, Set*, account-metas
  simulations) that every test runs before its real transaction. Those are
  85% of the invocations that cost more than Rust; the hot paths were
  already 21% cheaper in total.
- Inside those calls the Go overhead was not instruction decoding or account
  loading (the entrypoint costs ~120 CU plus ~76 CU per account; decode median
  130 CU). It was byte-at-a-time codegen in a handful of helpers: 32-byte key
  compares (~390 CU each), the `CreateAddress` staging copy (288 CU per PDA
  attempt), Borsh integer writes (~45 CU per u64), and the SDK's software f64
  rent multiply (~1,000 CU per call).
- After four Go library fixes, the stored-bump PDA port from #9858 and five
  goSVM PRs (CrocSwap/goSVM#27 to #31): per-call median went from 9% more than
  Rust main to 8% less, and from 14% more than optimised Rust (#9858) to
  parity. Total CU went from 5% less than Rust main to 23% less, and from 22%
  more than optimised Rust to parity. 584/584 tests pass; logs match Rust in 583/584 tests (the one
  difference is the test Rust fails at 200k CU).

## 1. Breakdown: what makes up the >1.0 side

Data: go6 vs rust1, self CU (CPI children
excluded), 4,581 paired invocations. Instruction classes come from a scratch
probe build that logged each Go invocation's instruction bytes at entry
(`solana.Log64`), joined to both runs by (suite, test, program, ordinal); no
count mismatches. Tools: `overhead-data/tools/{probes,classify,labels,breakdown_md}.py`.

Per-call median: 10% more self CU (9% more inclusive CU, the figure in #9852).
3,101 of 4,581 pairs cost more than Rust.

| category                                                                                  | invocations | above Rust | share of the above-Rust pairs | median Go vs Rust | total Go vs Rust |
| ----------------------------------------------------------------------------------------- | ----------: | ---------: | ----------------------------: | ----------------: | ---------------: |
| init (fixture setup)                                                                      |       1,269 |      1,246 |                           40% |              +15% |             +15% |
| admin (Set*, ownership, routes)                                                           |       1,205 |        967 |                           31% |              +10% |              +4% |
| query / simulation (account metas, Type, metadata spec)                                   |         489 |        449 |                           14% |              +24% |             +15% |
| hot path (dispatch, process, transfer_remote, handle, verify, pay_for_gas, quote, submit) |         659 |        403 |                           13% |               +7% |             -21% |
| SPL / test programs (same ELF both sides)                                                 |         959 |         36 |                            1% |                0% |              +1% |

Top classes on the >1.0 side:

| program                | instruction         |   n | above Rust | share | Rust median | Go median | median delta | median Go vs Rust | category   |
| ---------------------- | ------------------- | --: | ---------: | ----: | ----------: | --------: | -----------: | ----------------: | ---------- |
| composite_ism          | SetDomainIsm        | 233 |        230 |  7.4% |      12,689 |    13,915 |       +1,296 |              +10% | admin      |
| fee                    | InitFee             | 215 |        213 |  6.9% |       7,949 |    10,444 |       +2,485 |              +31% | init       |
| composite_ism          | VerifyAccountMetas  | 197 |        197 |  6.4% |      10,354 |    13,768 |       +3,135 |              +31% | simulation |
| test_ism               | Init                | 156 |        156 |  5.0% |       5,180 |     5,520 |         +340 |               +7% | init       |
| igp                    | Init                | 157 |        156 |  5.0% |       5,436 |     6,252 |         +816 |              +15% | init       |
| mailbox                | Init                | 154 |        154 |  5.0% |      14,110 |    14,974 |         +864 |               +6% | init       |
| igp                    | InitIgp             | 159 |        150 |  4.8% |      10,804 |    13,209 |       +2,405 |              +22% | init       |
| composite_ism          | Initialize          | 138 |        134 |  4.3% |       9,111 |    10,914 |       +1,764 |              +20% | init       |
| igp                    | SetGasOracleConfigs | 107 |        107 |  3.5% |       5,048 |     6,397 |       +1,349 |              +27% | admin      |
| fee                    | SetQuoteSigner      | 108 |        105 |  3.4% |       5,950 |     6,494 |         +544 |               +9% | admin      |
| fee                    | SubmitQuote         | 109 |        101 |  3.3% |      37,488 |    41,129 |       +2,150 |               +5% | hot path   |
| igp                    | InitOverheadIgp     | 102 |         97 |  3.1% |      12,298 |    14,822 |       +2,524 |              +21% | init       |
| igp                    | SetIgpQuoteConfig   |  90 |         90 |  2.9% |       4,943 |     6,059 |       +1,116 |              +23% | admin      |
| fee                    | SetRemoteFeeRoute   |  92 |         87 |  2.8% |      14,802 |    18,765 |       +3,963 |              +26% | admin      |
| fee                    | QuoteFee            |  83 |         82 |  2.6% |      18,167 |    24,470 |       +4,683 |              +24% | hot path   |
| composite_ism          | Verify              |  86 |         77 |  2.5% |      11,300 |    13,589 |       +2,476 |              +27% | hot path   |
| token_cross_collateral | Init                |  66 |         65 |  2.1% |      51,468 |    56,509 |       +5,041 |              +10% | init       |
| igp                    | SubmitIgpQuote      |  64 |         63 |  2.0% |      35,792 |    39,993 |       +4,293 |              +12% | hot path   |
| igp                    | PayForGas           |  57 |         53 |  1.7% |      29,450 |    36,949 |       +8,280 |              +26% | hot path   |

What they have in common: small, fixed-cost instructions (5k to 15k CU)
dominated by account checks, PDA derivation, one store and often one log line.
The absolute deltas (+0.3k to +4k) are near-constant overhead, so they show up
as large ratios on small calls and vanish on the big hot-path calls. No single
class moves the median: removing any one changes it by at most 0.3 points.

Noise: the suites use `Keypair::new()`, so PDA bump searches differ between
runs by whole 1,500 CU steps. Rust vs Rust reruns are identical on 85% of
invocations (`conformance-rust.md`); per-class medians absorb this, single
outliers (e.g. IGP CloseIgpStandingQuote at 2.8x) do not.

## 2. Attribution

Method: a scratch goSVM CLI (`scratch-cu-probe`, never published) adds a
context-free `solana.ProbeCU(id)` that calls `sol_log_compute_units_` then
`sol_log_64_`. The scratch Go tree wrapped decode, account fetch (Borsh
decode), store (Borsh encode), PDA find/create, CPI, rent, clock and log
helpers in enter/exit probes; exclusive CU per bracket, minus the calibrated
probe cost (207 CU). A no-log A/B build (all `svm.Msg` methods stubbed)
isolated logging. Microbenchmarks ran inside the scratch test ISM (25 samples
each, identical). The unprobed scratch CLI reproduces the go6 ELFs byte for
byte, so the probes are the only change.

### Fixed cost per instruction

- Entrypoint and account table: ~120 CU plus ~76 CU per account (regression
  over 3,307 top-level invocations; the C loader reads two u64 fields per
  account). Rust's entrypoint was not probed, but at this size it can't
  explain a +0.3k to +4k gap.
- Instruction decode: median 130 CU across all instructions.

### Helper costs (goSVM `hyperlane-integration-2`, microbenchmarks, net of probe cost)

| operation                               | Go CU | Rust reference                                          | cause                                              |
| --------------------------------------- | ----: | ------------------------------------------------------- | -------------------------------------------------- |
| `svm.KeyIs` (32-byte match)             |   395 | ~20 (estimate: clang's 4-word compare, 24 instructions) | byte loop, ~12 SBF instructions per byte           |
| `[32]byte == [32]byte` (equal)          |  ~350 | ~20                                                     | `arrayN_equal` byte loop                           |
| `solana.CreateAddress`                  | 1,944 | 1,500 + ~30                                             | 1,500 syscall + 288 staging byte copy + seed parse |
| `svm.NewSeeds` (5 seeds)                |   274 | ~50                                                     | allocation + one memmove per seed                  |
| `svm.FindProgramAddress`, bump 255      | 2,702 | 1,500 + ~50                                             | the two above, per bump tried                      |
| `svm.MinimumBalance`                    | 1,176 | ~300 (soft-float multiply, estimated)                   | SDK exact-rounding f64 emulation, ~1,000 CU        |
| Borsh `Writer.U64`                      |   ~47 | ~5                                                      | `put()` per byte with overflow checks              |
| `svm.Msg` with one base58 pubkey + emit | 1,912 | not probed                                              | base58 limbs + per-byte append + `sol_log_`        |

Rust reference costs are estimates (syscall prices, and clang's codegen for
the equivalent C compare), not measured in the Rust ELFs.

### Exclusive CU by component, top classes (go6 build + probes)

Medians per column (columns are not additive). `pda_find` and `cpi` include
the syscall price Rust pays too (1,500 per bump; 1,000 base per CPI plus the
150 CU System program).

| class                        |   Rust |     Go | entry | decode | fetch | store | pda_find | pda_create |   cpi | rent |   log |  body |
| ---------------------------- | -----: | -----: | ----: | -----: | ----: | ----: | -------: | ---------: | ----: | ---: | ----: | ----: |
| composite VerifyAccountMetas | 10,354 | 13,768 |   462 |    111 |   311 |     0 |    7,562 |          0 |     0 |    0 |     0 | 4,164 |
| fee InitFee                  |  7,949 | 10,444 |   537 |    356 |     0 |   893 |    2,274 |          0 | 1,443 |  684 | 2,950 | 1,660 |
| fee QuoteFee                 | 18,167 | 24,470 |   695 |    190 |   822 |     0 |   13,378 |          0 |     0 |    0 |   448 | 5,637 |
| igp PayForGas                | 29,450 | 36,949 | 1,077 |    139 | 1,571 | 1,261 |   10,030 |      6,677 | 2,826 |  684 | 3,691 | 9,875 |
| igp InitIgp                  | 10,804 | 13,209 |   537 |    251 |     0 |   416 |    5,528 |          0 | 1,443 |  668 | 2,950 | 1,710 |
| composite SetDomainIsm       | 12,689 | 13,915 |   615 |     43 | 1,587 | 1,154 |    3,673 |          0 | 1,398 |  684 |   435 | 6,159 |
| composite Initialize         |  9,111 | 10,914 |   615 |     43 |   297 |   315 |    5,933 |          0 | 1,449 |  680 |     0 | 1,945 |
| igp SetGasOracleConfigs      |  5,048 |  6,397 |   537 |    377 |   478 | 1,172 |        0 |          0 | 1,299 |  680 |     0 | 2,128 |

Per PDA derivation Go paid 650 to 900 CU above the 1,500 syscall
(seed encoding, staging copy, a Go bump loop that re-parses the seeds every
try); composite VerifyAccountMetas makes four or five derivations, which is
most of its +3.1k. The "body" column holds the KeyIs/OwnerIs compares (four
to eight per instruction at ~390 each) and `==` on keys.

### Logging

No-log A/B: logging is 5.8% of Go CU; ~2,950 CU per line with a base58
pubkey (InitFee, InitIgp), 6.1k for SetFeeConfig, 7.1k for dispatch. Rust's
`msg!` lines cost more where measured (31% of Rust mailbox dispatch,
`mailbox-conformance.md`), so on Rust main logging was not why Go cost more.
Against #9858, whose log-utils made Rust's lines allocation-free, Go's logging
is now part of the remaining dispatch gap.

### Codegen review (emit-c and disassembly)

- `Equal32`, `arrayN_equal`, Borsh `put()`: per-byte loops with an address
  recomputation and a bounds check per byte; clang does not combine them.
- `sol_CreateAddress`: syscall writes into a local, then a 32-iteration byte
  copy to the caller's output.
- `sol_read64` in the entrypoint is combined into one load for the account
  count but not for `data_len` (the 4-byte original-length store loop next to
  it blocks it); the post-CPI refresh calls it per account.
- `new(Instruction)` on the IGP/fee union structs and struct copies go
  through `sol_memset_`/`sol_memmove_` on integration-2 and are cheap (10 to 20 CU).
- No interface dispatch on the hot helpers; generic `Fetch`/`Store` are
  monomorphised.

## 3. Fixes

### Hyperlane Go library (commits on `gosvm/all`)

| commit       | change                                                                                                                                       | measured                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `bfb4de75a4` | `svm.Equal32` ORs the XOR of 32 byte pairs, key by pointer                                                                                   | match 395 -> 63 CU (micro)           |
| `3555cdb2a9` | Borsh `U16/U32/U64` write in one bounds-checked step; reads without loops; same WriteZero prefix on overflow                                 | 8x U64 373 -> 44 CU                  |
| `1d4694c13f` | `svm.MinimumBalance` exact fast path at thresholds 2.0 and 1.0 (n < 2^53), SDK path otherwise; test checks both agree                        | 1,176 -> 188 CU                      |
| `021f3e61d4` | stored-bump PDA verification, port of #9858 (`verify_pda_with_stored_bump`): IGP 5 sites, fee 9, composite 3 + VAM key reuse, token-native 1 | composite total 8% less, fee 6% less |
| `f607e53cd5` | re-pin goSVM to `hyperlane-integration-4` (SDK `6e97ac4b…`)                                                                                  | the goSVM PRs below                  |
| `979357c8f9` | `svm.FindProgramAddress(Seeds)` and `StaticPDA.Find` on `solana.FindAddress`                                                                 | 1% to 2% less total per program      |

Run-by-run, Go vs Rust main (`rust1`) and vs optimised Rust (#9858 run1),
inclusive CU (cu-diff `ALL` row for the per-call median; totals over the
Hyperlane programs):

| Go run | contents                                     | per-call median vs main | vs #9858 | total vs main | total vs #9858 |
| ------ | -------------------------------------------- | ----------------------: | -------: | ------------: | -------------: |
| go6    | before                                       |                 9% more | 14% more |       5% less |       22% more |
| go7    | + Equal32, Borsh, rent                       |                  parity |  2% more |      12% less |       14% more |
| go8    | + stored-bump PDAs                           |                  parity |  2% more |      14% less |       11% more |
| go9    | + goSVM #27 to #29, FindAddress              |                 2% less |   parity |      20% less |        3% more |
| go11   | + goSVM #30, #31 (`hyperlane-integration-4`) |                 8% less |   parity |      23% less |         parity |

(#9858 run2 gives the same medians to within a point: 14% more for go6, 1% to 2% more for go7/go8, parity for go9 and go11; go11 total 1% less.)
Restricted to Hyperlane programs (SPL and test programs excluded) the go11
per-call median is 13% less than Rust main and 6% less than #9858 (go9: 10%
less and 1% more).

Per-program total CU, go11:

| program                                                    |    vs Rust main |      vs #9858 |
| ---------------------------------------------------------- | --------------: | ------------: |
| composite ISM                                              |        15% less |       2% more |
| fee                                                        |         4% less |       7% more |
| IGP                                                        |         4% less |       7% more |
| mailbox                                                    |        44% less |       7% less |
| multisig ISM                                               |        30% less |       3% less |
| token (synthetic / collateral / native / cross-collateral) | 31% to 35% less | 6% to 8% less |
| validator announce                                         |        37% less |        parity |

Hot paths, median inclusive CU (Rust #9858 / Go go6 / go9 / go11):

| path                                  |   n |  #9858 |    go6 |    go9 |   go11 | go11 vs #9858 |
| ------------------------------------- | --: | -----: | -----: | -----: | -----: | ------------: |
| dispatch                              |  58 | 17,995 | 24,309 | 21,504 | 22,634 |      26% more |
| process                               |  39 | 68,746 | 76,201 | 71,479 | 65,255 |       5% less |
| transfer_remote (synthetic)           |  15 | 75,086 | 99,585 | 82,506 | 82,190 |       9% more |
| transfer_remote (collateral)          |  14 | 73,688 | 93,354 | 80,684 | 76,761 |       4% more |
| transfer_remote (native)              |  16 | 71,267 | 91,818 | 79,744 | 76,352 |       7% more |
| transfer_remote_to (cross-collateral) |  29 | 63,028 | 81,764 | 70,837 | 67,594 |       7% more |
| handle (synthetic)                    |  19 | 37,774 | 41,137 | 39,056 | 35,061 |       7% less |
| IGP pay_for_gas                       |  57 | 22,535 | 36,949 | 29,626 | 29,409 |      31% more |
| fee quote                             |  83 | 12,315 | 24,470 | 16,113 | 15,975 |      30% more |
| composite verify                      |  86 | 12,168 | 14,432 | 13,167 | 13,164 |       8% more |

Paths that derive a PDA from a fresh random key (dispatch, process,
transfer_remote) move by one bump search, 1,500 CU, between runs of the same
ELFs: go10, built from the same source as go11 with byte-identical ELFs, has
dispatch at 21,134 (17% more than #9858) and process at 61,956 (10% less).

Against Rust main, dispatch, process, transfer_remote, handle and multisig
verify are 46% to 56% cheaper in go11; fee quote is 12% cheaper, IGP
pay_for_gas is at parity and composite verify is 8% more. The tables are in
[`overhead-data/report-go11.md`](overhead-data/report-go11.md) (go9:
[`report-go9.md`](overhead-data/report-go9.md)).

Conformance: go7 to go11 all 584/584 (Rust main 582/584). Log parity
(log diff with keys and hashes masked): go9 and go11 583/584, the
only difference being the extra success line in
`test_cc_remote_transfer_igp_new_flow_with_fee`, which Rust fails at 200k CU.
go7 and go8 showed two fee tests with one fewer invocation
(`add_quote_signer::test_add_duplicate_is_idempotent`,
`set_min_issued_at::test_equal_value_accepted`): both send the same
transaction twice and the bank deduplicated the second under the same
blockhash. The probe run p2 showed the same, and go9 ran all three, so it is
timing, not a program change.

### goSVM PRs

The earlier compiler and SDK work (CrocSwap/goSVM#9 to #24) merged upstream in
CrocSwap/goSVM#25 (`main` `939b215`). The CU fixes are five draft PRs on
`939b215`, one per row of CrocSwap/goSVM#26, all merged into
`hyperlane-integration-4`, the pin:

| PR                | change                                                                                       | Hyperlane effect                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CrocSwap/goSVM#27 | runtime reads/writes/compares whole words on SBF; `CreateAddress` writes the output directly | per-call median 6% less; totals 4% to 10% less per program (vs the same source on integration-2)                   |
| CrocSwap/goSVM#28 | `solana.FindAddress` on `sol_try_find_program_address`                                       | 0.7% to 2.2% less total per program                                                                                |
| CrocSwap/goSVM#29 | `==` on `[N]byte`/`[N]int8` (N >= 8) compares words on SBF                                   | up to 1.6% less total (keys already use `Equal32`)                                                                 |
| CrocSwap/goSVM#30 | `MinimumBalanceFor` skips the f64 rounding emulation at thresholds 2.0 and 1.0               | with #31, go9 to go11 (same Go source): token programs 7% to 10% less total, mailbox 4% less, the rest within 0.6% |
| CrocSwap/goSVM#31 | word compare in front of hand-written byte compare loops                                     | see #30                                                                                                            |

Each PR has SBF tests on fogo-v0 and solana-v3, a corpus check proving its C
change is the only one, docs and `results/`.

## 4. What remains

Against Rust main the ports are cheaper on every program in total. Against
#9858 the remaining gaps:

- **IGP pay_for_gas and fee quote (30% to 31% more).** #9858 also parses a
  single gas oracle entry per IGP payment and adds u128 fast paths for U256
  math; the Go ports still decode the whole IGP account and use the generic
  U256 path. These are algorithmic ports, like the stored-bump one.
- **dispatch (17% to 26% more, depending on the bump search).** Mostly
  logging: Go's two dispatch lines cost ~7k; #9858's log-utils made Rust's
  allocation-free. A Go equivalent (fixed buffers, base58 into a stack
  array, no per-byte append) is the next library fix.
- **goSVM.** Review of CrocSwap/goSVM#27 to #31. Once they merge, the pin
  moves to upstream `main`.
