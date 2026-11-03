# TypeScript hot-path benchmark

Compares exact source at baseline `7e80c603f0278c9b1f0555fe0106279e2df5f070` and proposed `d555ffbfd7d82438851e6f848ea7dfc28b2e336d`.

These are local, synthetic, timer/stub-controlled workloads. They measure scheduling, backpressure and CPU overhead in the actual implementations. They do not measure production RPC latency or throughput.

## Reproduce

From the repository root, after a frozen dependency install and dependency builds:

```sh
source ~/.nvm/nvm.sh
nvm use
node docs/performance/hot-paths/ts/benchmark.mjs \
  --warmups 5 --repetitions 41 \
  --output docs/performance/hot-paths/ts/results.json
```

Run when other benchmark/build workloads are idle. `--scenario map_stragglers` selects one workload. `--prepare-only` imports both source snapshots without running measurements. `--baseline` and `--proposed` accept alternative git revisions.

The harness uses `git archive` into an owned temporary directory, compiles each version's actual utils/SDK source and the Monitor target with the repository TypeScript compiler, imports those versioned outputs, and removes the temporary files on exit. Archived workspace package imports resolve to that version's compiled SDK/utils outputs. External dependencies share the same frozen install and built artifacts. Source blob IDs, SHA-256 digests encoded as Base64, commit IDs, lockfile hash and machine/runtime details are recorded in the JSON. No worktree or primary checkout is changed.

The command writes raw `results.json` and a generated `results.md` metrics table.

## Measurement method

Both versions are imported before warmup. Every warmup and measured round runs versions sequentially, alternating baseline/proposed and proposed/baseline order. There are no concurrent benchmark workloads. Each sample records elapsed and CPU time, completed workload count, provider/task calls, maximum active requests and shared-process RSS.

Latency is elapsed time divided by workload iterations. p50/p95 summarize those per-sample averages; they are not individual production request percentiles. Throughput counts complete map calls, fee estimates or monitor cycles. Map workloads additionally record task counts. CPU includes the identical harness counters and output validation, plus any GC during measurement. No GC is forced.

RSS is sampled in the shared process, after importing both versions, and cannot be attributed to one version's allocations. The process high-water RSS, including snapshot preparation/imports, is retained as run metadata. Peak in-flight operations is the directly attributable resource-pressure measurement: mapper tasks for map workloads, provider-boundary reads for fee/monitor workloads.

The JSON `provider_calls` fields count controlled provider-boundary stub invocations, not wire-level RPC counts: `getFeeData` is modeled as one read. The actual fee-estimation functions execute unchanged. No production request-count reduction is claimed.

## Workloads

| Workload                   | Shape                                                                             | Purpose                                        |
| -------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `map_uniform`              | 64 items, concurrency 8, every mapper waits 2 ms                                  | Uniform-latency baseline                       |
| `map_stragglers`           | 64 items, concurrency 8; every 16th mapper waits 20 ms, others 2 ms               | Fixed-batch head-of-line stalls                |
| `map_no_io`                | 1,024 items, concurrency 8; immediately resolved mapper; 50 maps/sample           | Scheduling/allocation overhead without I/O     |
| `ethers_delay`             | Actual Ethers estimator, two independent 8 ms provider reads; 4 estimates/sample  | Independent-read overlap                       |
| `ethers_no_io`             | Same estimator, immediately resolved provider reads; 100 estimates/sample         | Fixed-pair scheduling overhead                 |
| `viem_delay`               | Actual Viem estimator, two independent 8 ms provider reads; 4 estimates/sample    | Independent-read overlap                       |
| `ethers_failed_simulation` | Gas simulation fails after 2 ms; fee-data read takes 8 ms; 4 failures/sample      | Additional read cost after a failed simulation |
| `monitor_8_chains`         | Actual Monitor, 8 synthetic-token chains, inventory enabled, each read waits 2 ms | Small monitoring cycle                         |
| `monitor_32_chains`        | Same, 32 chains                                                                   | Route-size scaling and request bounds          |
| `monitor_no_io`            | Same, 32 chains, immediately resolved reads; 10 cycles/sample                     | Monitoring CPU overhead without I/O            |

Monitor fixtures supply validated chain metadata and real SDK tokens/providers whose read methods are controlled stubs. Every emitted event is checked for token order, pinned block tags, supply and inventory values. The handler stops the monitor after one full cycle.

The failed-simulation workload separately records API latency and time until all initiated reads have settled. The latter includes draining the still-running fee-data read in the proposed `Promise.all` implementation; treating rejection as resource quiescence would hide its extra work.
