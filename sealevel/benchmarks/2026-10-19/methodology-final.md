# Methodology: final build benchmarks (Rust vs goSVM)

Machine, tool versions: `final-env.json` (also at the end of `final-build-benchmarks.md`).
All builds ran serially, one at a time, with no other heavy jobs on the machine. Before every timed build
the scripts waited (no cap) until the 1-minute load average was below 4. Each record keeps `uptime` before and after.

## Scripts

| Language | Driver                                                             | Per-build runner            | Run dir                                    |
| -------- | ------------------------------------------------------------------ | --------------------------- | ------------------------------------------ |
| Rust     | `scripts/run_timing_final.sh` (copy of `run_timing.sh`)            | `scripts/bench_build.py`    | `/tmp/svm-bench/timing-<ts>/`              |
| Go       | `scripts/run_go_timing_final.sh` (adapted from `run_go_timing.sh`) | `scripts/go_bench_final.py` | `/tmp/svm-bench/go-timing-<ts>/`           |
| Both     | `scripts/make_final_report.py <rust jsonl> <go jsonl>`             |                             | `results/final-build-benchmarks.{json,md}` |

Changes from the earlier scripts: Rust uses the agave 3.0.14 driver, waits for the load gate instead of refusing or
warning, and edits the dispatch handler (the earlier script edited the inbox-process log). Go covers all 11 programs,
uses the gosvm/all tree and `gosvm-int2`, edits the dispatch log rather than a panic string, and samples RSS every 10 ms.

## Commands

- Rust, per program dir `rust/sealevel/programs/<rel>`:
  `CARGO_TARGET_DIR=<fresh dir> /usr/bin/time -l /tmp/agave-dl/solana-release/bin/cargo-build-sbf --tools-version v1.51 -- --locked --offline`
- Go, from the scratch copy root `/tmp/svm-bench/final/gosrc/sealevel`, same form as `sealevel/build-programs.sh`:
  `GOCACHE=<out>/gocache /usr/bin/time -l gosvm-int2 -target fogo-v0 [-max-accounts 64] [-no-cache] -o <out>/<rust elf name>.so ./programs/<rel>`
  `-max-accounts 64` is passed only for `hyperlane-sealevel-token-cross-collateral`, as in build-programs.sh. No `-llvm`:
  with `-target`, gosvm picks its managed v1.57 backend.

## Cold build

- Fresh output dir per build: Rust `CARGO_TARGET_DIR`, Go out dir.
- Dependencies are on disk and builds run offline:
  - Rust: one untimed online warm-up build per program (shared throwaway target dir, then deleted) fills the platform-tools
    cargo registry. Timed builds pass `--offline`.
  - Go: the module has no external deps (`replace gosvm => ./.gosvm/sdk`). gosvm runs `go list` with `GOPROXY=off`.
- Go has no build cache. `-no-cache` skips gosvm's output receipt check (`<elf>.gosvm-cache`; `-no-cache` builds write
  none). `GOCACHE` is a new empty dir inside the out dir, so `go list` starts cold. gosvm stores nothing else:
  `~/Library/Caches/gosvm` holds only the toolchain/runners and did not grow. Clang/ld temp files go to
  `os.MkdirTemp` and are deleted.
- Reps: mailbox 3 (median, range); every other program 1. Go: `fogo-v0` for all programs (main tables), plus `solana-v3`
  for mailbox (separate table).

## Mailbox incremental (3 reps each)

Run on the warm rep-1 dir of the cold build. Before each rep the files are reverted, then one edit is applied:

| Edit                            | Rust                                                                                                                                               | Go                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Handler: dispatch log literal   | `programs/mailbox/src/processor.rs` `outbox_dispatch`: `"Dispatched message to {}, ID {:?}"` -> `"Dispatched message r<rep> to ..."`               | `programs/mailbox/program.go` `dispatch`: `svm.NewMsg("Dispatched message to ")` -> `"Dispatched message r<rep> to "` |
| Shared lib: merkle insert bound | `rust/main/hyperlane-core/src/accumulator/incremental.rs` `IncrementalMerkle::ingest`: `assert!(self.count < u32::MAX as usize)` -> `... - <rep>)` | `libraries/hyperlane-core/merkle/merkle.go` `Ingest`: `if count >= 0xffffffff {` -> `0xffffffff-<rep>`                |

The shared-lib edit is a small real code change: it changes a constant in the emitted code, unlike a no-op statement.
Untimed or extra builds: a no-op rebuild, plus a settle build after each edit series to restore the pristine output.
For Go there is also a settle build before the no-op, which writes the receipt so the no-op is a cache hit.
gosvm compiles the whole program every time, so any source change is a full rebuild, about the same as a cold build.
Rust edits are reverted with `git checkout --` (trap on exit). Go edits are reverted from saved copies in the scratch tree.

## Metrics

- Build time: wall clock (Python monotonic clock around the process). `/usr/bin/time` real/user/sys are in the raw records.
- Peak RSS, single process: `/usr/bin/time -l` "maximum resident set size". On macOS this is the child rusage
  `ru_maxrss`, the max over all waited-for descendants, so it is the largest single process in the build, not the sum.
- Peak RSS, process tree: sampled sum of RSS over the build's descendant tree (`ps -A -o pid=,ppid=,rss=`).
  Rust samples every 100 ms (builds take tens of seconds). Go samples every 10 ms (about 20 samples per ~0.7 s build;
  `ps` takes ~25 ms). Both are lower bounds on the true peak.
- Retained build artifacts: `du -sk` of the output dir right after the cold build. Rust: the whole `CARGO_TARGET_DIR`.
  Go: the out dir, which holds the ELF and the build's fresh `GOCACHE` (gosvm has no other cache entries and `-no-cache`
  writes no receipt). Breakdown in JSON `go_retained_breakdown_kib`.
- ELF: bytes of the produced `.so` (Rust `<target>/deploy/`). sha256 per build is in the raw records.
- Deploy rent: `((ELF + 45 + 128) + (36 + 128)) * rate`, i.e. programdata account (ELF + 45-byte header + 128-byte
  account overhead) plus program account (36 + 128). Rates: 6960 lamports/byte (old) and 5080 lamports/byte (current
  mainnet rent sysvar). Buffer-account rent during deploy is not counted.
- Improvement = Rust / Go. All rows are lower-is-better.

## Caveats

- The two languages use different backends: Rust platform-tools v1.51 (LLVM 19), goSVM v1.57 (LLVM 22).
  This matches what each project ships with.
- Rust cold builds compile the full dependency graph (259 crates for mailbox; per-program counts in JSON). The goSVM build is one C translation unit
  per program, so the two compile-time models are very different.
- The Go ELFs are byte-identical to the set used for the conformance runs (`/tmp/hm1-all-elf/go6`).
- Rust ELFs are deterministic across reps (one sha256 per program) and match the CI-driver ELF sizes in
  `/tmp/svm-bench/rust-elf-ci`. Mailbox sha256 f77c29de... is the same as the earlier agave 3.0.14 side build.
- Load gate: the Rust builds waited 30-110 s each for the load average to fall below 4 again. Every timed build started at a 1-min load of 3.6-3.98.
  The Go builds never had to wait (starting load 2.9-3.3).
- `run_timing_final.sh` also wrote `results/rust-timing.json` and patched the timing fields of
  `results/rust-baseline.{json,md}` through `summarize_timing.py` (this is by design).
