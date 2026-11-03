# Lander: actual-code before/after benchmark

Baseline: `7e80c603f0278c9b1f0555fe0106279e2df5f070`. Proposed: `d555ffbfd7d82438851e6f848ea7dfc28b2e336d`.

These are controlled-provider measurements of actual production code, not live-chain throughput estimates. The same executable contains both revisions. Shared dependencies/types come from the proposed checkout; relevant provider/transaction primitives are unchanged between the revisions.

The SVM 32-operation cases are **adapter stress tests**. Current `InclusionStage::process_txs_step` awaits each transaction's mutation path in order; this harness deliberately calls the adapter concurrently and bypasses that loop. Its operations/s numbers do not measure current end-to-end or per-chain pipeline throughput. The width-1/8 fresh controls use the same binary and show behavior below the estimate cap.

The [complete before/after tables](COMPARISON.md) include the costs as well as the wins. Uniform stale submits improved from 140.746 to 9.203 ms per 32-operation batch; gas estimates from 9.733 to 5.170 ms; payload checks from 141.199 to 9.588 ms. Request counts stayed unchanged. Gas-read peak concurrency increased from 32 to 64 in this pre-admitted 32-operation workload.

Normal fresh prepare/submit is the counterexample: the estimate cap reduced peak concurrency from 32 to 16 and increased its uniform batch median from 4.869 to 9.602 ms. Its straggler operation p95 increased from 5.266 to 13.406 ms. This is a measured backpressure tradeoff, not an across-the-board latency improvement. On the no-I/O fresh path, the median decreased from 142.167 to 107.750 µs while retained consumed entries fell from 33,600 to zero. No-I/O stale submits were about 1% slower, payload checks about 4% slower, and gas estimates roughly flat; small differences should be interpreted with the two individual process passes, not as precise production CPU claims.

`run.py` obtains both complete Sealevel adapter modules and EVM gas-estimator files with `git show`. It removes their unit-test module declarations and adds access to the existing Sealevel test constructor and a read-only freshness-entry count. For EVM payload checks it copies the exact `reverted_payloads` method into an async-trait wrapper with the same provider/signer fields and the original concurrency constant. Source and generated-file SHA-256 values are recorded in the manifest. Neither implementation is recreated as a benchmark model.

The build temporarily appends a test-module declaration to `rust/main/lander/src/adapter/chains/sealevel.rs`, builds, then restores the original bytes in `finally`. The copied executable runs after restoration. No permanent feature flag, source hook, worktree, or baseline source copy is required in the repository.

## Workloads and metrics

Each workload has 32 operations admitted together:

| Case                 | Actual code exercised                                                                                                 | Operation / completion latency                                                              | Counted requests per batch                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `svm_submit`         | Stale `SealevelAdapter::submit`, including estimation, transaction creation, submission, and local transaction update | Each submit's completion since batch admission                                              | 96 provider-boundary calls: 32 estimates, 32 builds, 32 sends |
| `svm_prepare_submit` | Normal `estimate_tx` then fresh `submit`, using the actual shared freshness state                                     | Each prepare/submit operation's completion since batch admission                            | 96 provider-boundary calls: 32 estimates, 32 builds, 32 sends |
| `evm_gas`            | `estimate_gas_limit`, including actual Ethers provider dispatch, gas buffers/floors/caps                              | Each estimate's completion since batch admission                                            | 64 JSON-RPC requests: 32 gas estimates and 32 block reads     |
| `evm_payload`        | One actual `reverted_payloads` call containing 32 success criteria                                                    | Each criterion's RPC completion since batch admission, including time waiting for admission | 32 JSON-RPC calls                                             |

Sealevel build/send stubs complete immediately; only its estimation provider carries injected delay. These provider-boundary counts do **not** claim to count nested RPCs inside a real Sealevel provider. EVM requests go through the real `EthereumProvider` and Ethers JSON-RPC client boundary. The criterion returns false, and the harness verifies all returned payloads retain input order. Gas estimates must produce the unchanged 96,000-unit buffered limit. Every batch asserts request counts and zero unfinished provider work.

Scenarios:

- `uniform`: every cost/account read waits for a requested 2 ms timer.
- `straggler`: operation 0's estimate/criterion waits for 20 ms; other reads wait for 2 ms. Block reads stay at 2 ms.
- `no_io`: provider reads return immediately, with no synthetic yield. This exposes allocation, locking, joining, dispatch, and instrumentation overhead.

Tokio timers have scheduling/rounding overhead: requested delays are not assertions of exact service duration. Both revisions use the same current-thread runtime, provider implementation, instrumentation, operation-index inputs, and workload width. Fixture constructors generate transaction UUIDs and a payer key outside the measured interval; these metadata values differ across processes but have the same shape.

The fresh prepare/submit control matters: baseline estimates already run concurrently on this path, while the proposal caps estimates at 16. It can therefore expose the latency cost of that backpressure under 32 pre-admitted operations. Distinct transaction UUIDs also exercise freshness-map retention across batches; the baseline retains consumed `Stale` entries while the proposal removes consumed tokens.

Each case/scenario runs **AB then BA** in four separate processes. Each process has 3 warm-up batches and 50 measured I/O batches, or 50 warm-ups and 1,000 measured no-I/O batches. Reported percentiles pool the two processes for each version and use nearest rank. Throughput is total measured operations divided by summed measured batch durations. Full-workload latency includes execution and completion checks, but fixture creation/parsing occurs before the internal batch timer.

`/usr/bin/time -l` supplies process user/system CPU and peak RSS. CPU includes startup, warm-ups, fixture creation, and result output; it is not isolated function CPU. Summary CPU is the mean total CPU of the two process passes; RSS is the maximum observed peak. Compare CPU within the same case/scenario: I/O passes execute 1,696 operations including warm-ups, while no-I/O passes execute 33,600. Raw per-process CPU/RSS remains available. Freshness-entry counts are exact container lengths read outside the timed interval, and do not claim a per-entry byte size. The harness and Lander leaf use opt-level 3, with cached test/debug dependencies, debug assertions and overflow checks enabled; this is **not a full release build**. No-I/O numbers therefore describe this controlled mixed-profile executable, not production CPU capacity.

## Reproduce

Use a quiet machine. Serialize the build with other Cargo work/source edits, and serialize measurement with other benchmarks and builds:

```sh
python3 docs/performance/hot-paths/lander/run.py build --out /tmp/hm1-lander-hotpath-benchmark
python3 docs/performance/hot-paths/lander/run.py measure --out /tmp/hm1-lander-hotpath-benchmark
python3 docs/performance/hot-paths/lander/run.py controls --out /tmp/hm1-lander-hotpath-benchmark
```

The build uses Rust 1.88.0, `CARGO_INCREMENTAL=0`, the existing `/Users/pbio/work/hm1/rust/main/target` cache (override with `CARGO_TARGET_DIR`), four build jobs, and `--locked --offline`. The runner records source/binary hashes and verifies the parent source was restored. No dependency installation or network access is part of the timed run. After measurement, `run.py curate --out /tmp/hm1-lander-hotpath-benchmark` copies only readable summaries, Base64-encoded SHA-256 provenance, and one deterministic raw-sample archive to `results/`, and generates `COMPARISON.md`.

Curated results include readable `summary.json`, `process-metrics.json`, `build-manifest.json`, and `controls/` summaries. All **56 raw JSON sample files** are in [results/raw-samples.tar.gz](results/raw-samples.tar.gz): 48 under `main/`, eight under `controls/`. The [archive manifest](results/raw-samples-manifest.json) records relative entry paths, sizes, and Base64 SHA-256 digests. Entries are sorted, ownership/timestamps normalized, and the gzip filename/timestamp omitted, so repeated exports of the same samples produce identical bytes. Binaries, Cargo artifacts, and compiler logs stay outside the repository.

Inspect without extracting files:

```sh
tar -tzf docs/performance/hot-paths/lander/results/raw-samples.tar.gz
tar -xOzf docs/performance/hot-paths/lander/results/raw-samples.tar.gz main/svm_submit-uniform-baseline-pass0.json
```
