# Depot paired Rust/Zig bench

Runs the 10 paired workloads on Depot CI from local working-tree state, so results don't depend on a loaded shared Mac.

```sh
zig/bench/depot/run.sh                         # all workloads, 5 pairs
zig/bench/depot/run.sh scraper-safe -n 2       # one workload
zig/bench/depot/run.sh validator-fast relayer  # selectors: all, role, mode, or token combos
zig/bench/depot/run.sh --fetch <run-id>        # re-download an existing run
```

`run.sh` writes `selection.json`, then runs `depot ci run --workflow .depot/workflows/zig-bench.yml` with a temporary git index. That index marks the untracked bench files intent-to-add, because Depot's patch only includes tracked changes; the real index is not modified. The script waits for the run and downloads the per-workload and summary artifacts into `zig/bench/results/depot/<utc>-<run>/`, then prints `summary/summary.md`.

Workloads (`workloads.py`): `validator-{majority,fallback}-{safe,fast}`, `scraper-{safe,fast}`, `relayer-{single,batch4}-{safe,fast}`. Their parameters match `zig/bench/paired_linux_methods.json`.

## Pipeline (`.depot/workflows/zig-bench.yml`)

- **plan**: resolves the selection (dispatch inputs override `selection.json`).
- **build** (`depot-ubuntu-24.04-16`, `build.sh`):
  - Rust `relayer`/`validator`/`scraper` with aleo features, plus `init-db`. Uses Rust 1.98.0, as the paired harness did, rather than the 1.88.0 in `rust-toolchain`. `RUSTFLAGS` is `--cfg tokio_unstable -Ctarget-cpu=x86-64-v3 -Ctarget-feature=+pclmulqdq`, and C/C++ deps get `CFLAGS` `-march=x86-64-v3 -mtune=generic -mpclmul`.
  - Zig ReleaseSafe and ReleaseFast with `-Dcpu=x86_64_v3+pclmul`.
  - The native URL helper and RocksDB archives.
  - Validator correctness helpers (`ziggy-rust-reference`, `ziggy-evm-oracle`).
  - Finished products are cached separately, keyed on their own sources (`cache_keys.sh`). A Zig-only change rebuilds only Zig, using a restored Zig cache.
  - Changing `build.sh` logic does not invalidate caches. Bump the `-v1` key suffix when it should.
- **bench** (matrix, one `depot-ubuntu-24.04-16` per workload, `bench.py`):
  - Both arms run on the same machine, alternating `rust,zig` / `zig,rust` per pair.
  - CPU placement: agents run on CPUs 8-15 through a `taskset` exec wrapper, which preserves the pid and rusage. The harness, Anvil, RPC proxies, the relayer's checkpoint validator and Postgres (`docker --cpuset-cpus`) run on CPUs 0-7.
  - Host CPU model, kernel and load before/after are recorded; load is never gated on.
- **summary**: `summarize.py` writes `summary.json` and `summary.md`. For each metric it reports the median and min–max per implementation, Zig/Rust as the ratio of medians, and the median of per-pair ratios.

## Harnesses

- validator: `zig/bench/validator.py` run through `validator_run.py`. Checks checkpoint roots and ids against the Rust reference and recovers every signature.
  - The wrapper drops the harness's `merkle_snapshot.json` wait from the "checkpoint published" predicate. With `fallback` consensus, Rust writes that snapshot only once, at backfill end, so every Rust fallback run timed out even though all checkpoints were signed.
  - On failure it adds probe diagnostics.
- scraper: `zig/bench/scraper.py` unchanged. Checks all four event streams, receipt links and restart replay.
  - A `docker` shim (`docker_shim.py`) preloads `pg_stat_statements` and runs harness SQL and `init-db` as role `harness`. `db_*` metrics are therefore the agent's own statements for the whole trial (first run plus restart).
- relayer: `relayer_bench.py`, a lean variant built from `zig/bench/relayer.py` helpers.
  - Uses the same fixture and the same 3 s destination receipt stall.
  - Checks on-chain delivery of every message, unambiguous ProcessId coverage, mined broadcasts against signer nonces, and batch membership for batch4.
  - Drops the 600 s confirmation hold, restart replay, the Rocks oracle and the provenance/proof gates.

Rust ignores the harnesses' `tracing` config key: it reads `log.{level,format}` / `HYP_LOG_*`. Without an override it logs INFO in pretty format, about 2.5 MB per relayer run, while Zig logs only warnings and errors. The Rust exec wrapper therefore sets `HYP_LOG_LEVEL=error HYP_LOG_FORMAT=json`; override the level with `BENCH_RUST_LOG_LEVEL`.

Approval selectors, hash pins, quiet-host and prerequisite-proof gates are intentionally absent.

## Sandbox (warm interactive box)

A Depot sandbox is the compute behind a CI job, and there is no standalone create command. `sandbox.py start` therefore runs the workflow's `sandbox` job, selected with `"mode": "sandbox"` in the patched `selection.json`. The job has 16 vCPU, Rust 1.98.0, Zig 0.15.2, Foundry, pnpm and Postgres, with the Cargo target and Zig caches restored. It idles for up to `--hours`.

```sh
zig/bench/depot/sandbox.py start --hours 4      # ~2-3 min to ready
zig/bench/depot/sandbox.py push <rev> <name>    # git bundle -> worktree ~/zb/<name>, ~5 s, no push to origin
zig/bench/depot/sandbox.py exec -C ~/zb/<name> -- 'python3 zig/bench/run.py --zig "$ZIG" ...'
zig/bench/depot/sandbox.py pull ~/zb/out zig/bench/results/depot/x
zig/bench/depot/sandbox.py stop
```

Gotchas:

- `depot sandbox exec` waits for every child process. For long jobs, write the script and keep the exec in a local background task.
- `exec-pipe` drops stdin that arrives before the remote command starts. Pass small payloads base64-encoded in the command; streamed payloads such as `push`/`git bundle` work.
- The box dies when the job ends or hits its timeout. Caches persist only through the CI cache.
