# Rust vs goSVM benchmarks, 2026-10-19

Go: `sealevel/` at `def448aa6e` (identical ELFs to `5a9323e5af`), built with goSVM
`hyperlane-integration-2` `fe6d6b4` (platform-tools v1.57), fogo-v0 unless noted.
Rust: `rust/sealevel` at `c37d20599a`, agave 3.0.14 `cargo build-sbf --tools-version v1.51`.
Machine: Apple M3 Pro, 11 cores, 36 GiB. Every timed build started at 1-minute load < 4.

| file                                     | contents                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `final-build-benchmarks.md` / `.json`    | cold and edit builds, peak RSS, retained artifacts, ELF size, deploy rent; per program                          |
| `methodology-final.md`, `final-env.json` | exact commands, cache handling and tool versions                                                                |
| `system-conformance.md` / `.json`        | all 23 Rust functional suites with every program as its Go ELF vs the Rust CI ELFs; per-program and hot-path CU |
| `conformance-rust.md`                    | Rust baseline over two runs, including run-to-run CU noise                                                      |
| `mailbox-conformance.md`                 | mailbox suite, plus Rust with `msg!` compiled out to size the logging cost                                      |
| `sbpf-compat.md`                         | which SBPF versions each SVM chain we deploy to accepts                                                         |
| `overhead-analysis.md`, `overhead-data/` | why Go cost more CU per call than Rust, the fixes, and CU after the goSVM `hyperlane-integration-4` re-pin      |

Paths under `/tmp` are where the runs happened. Regenerate with
`rust/sealevel/programs/conformance.sh` and the methodology in `methodology-final.md`.
