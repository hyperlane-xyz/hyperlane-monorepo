# Hot-path measurements

Times are measured milliseconds, before → after. Baseline `7e80c603f0`; revised production code `64c9c07b5d`. Ratios divide before p50 by after p50.

| Actual implementation / workload                   | p50 before → after | p95 before → after | p50 speedup | Requests / peak in-flight before → after     |
| -------------------------------------------------- | -----------------: | -----------------: | ----------: | -------------------------------------------- |
| Ethers fee estimate, **public Ethereum RPC**       |    86.498 → 46.322 |  154.019 → 237.926 |       1.87x | 45 → 45 measured RPCs; peak 2 → 3            |
| `concurrentMap`, 64 items with stragglers          |    97.336 → 39.359 |    99.363 → 40.792 |       2.47x | 64 mapper calls; peak 8 → 8                  |
| Rebalancer Monitor, 32 chains                      |   164.233 → 21.510 |   166.693 → 22.132 |       7.64x | 96 → 96 provider calls; peak 32 → 16         |
| Scraper, 32 missing blocks                         |   234.246 → 30.297 |   237.847 → 31.599 |       7.73x | 32 → 32; peak 1 → 8                          |
| Scraper, 32 missing transactions                   |   235.855 → 30.920 |   239.583 → 31.968 |       7.63x | 32 → 32; peak 1 → 8                          |
| Multisig quorum, straggler                         |    61.390 → 23.820 |    65.091 → 30.423 |       2.58x | 7 → 7; peak 4 → 4                            |
| SVM stale submit, 32-operation adapter stress      |    140.746 → 9.203 |   144.266 → 10.226 |      15.29x | 96 → 96 provider calls; peak 1 → 16          |
| EVM gas, 32-operation adapter stress               |      9.733 → 5.170 |     10.693 → 6.055 |       1.88x | 64 → 64; peak 32 → 64                        |
| EVM payload checks, 32 criteria                    |    141.199 → 9.588 |   144.937 → 10.599 |      14.73x | 32 → 32; peak 1 → 16                         |
| Indexing, 20k actual notifications / 3 subscribers |      6.094 → 5.820 |      6.484 → 5.980 |       1.05x | 60k deliveries each, 2-worker runtime        |
| Ready indexing subscriber behind full subscriber   |     31.111 → 0.027 |     35.630 → 0.061 |      1,139x | 2 deliveries; slow subscriber held for 25 ms |

Only the first row uses a real network endpoint. Others execute actual source with controlled providers or local channels. SVM rows bypass the currently serialized `InclusionStage` mutation loop: these are adapter stress results, **not deployed per-chain throughput**. Calls count boundaries described in each suite; controlled `getFeeData` and SVM providers can contain multiple wire calls in production.

## Costs and controls

| Control / tradeoff                                   |                                    Before → after | Interpretation                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------- |
| Public RPC p95, 15 successful samples/version        |                              154.019 → 237.926 ms | Tail worsened; p95 is the maximum at N=15. Median paired speedup was 1.68x; 1.87x above is the ratio of medians. |
| Fresh SVM, 32 concurrent prepare/submits             |                              4.869 → 9.602 ms p50 | Peak estimates 32 → 16; backpressure costs latency above the cap. Straggler operation p95: 5.266 → 13.406 ms.    |
| Fresh SVM, width 1 / width 8                         |              4.565 → 4.561 / 4.654 → 4.648 ms p50 | Essentially unchanged below the cap.                                                                             |
| Fresh SVM, no I/O                                    |                          142.167 → 107.750 µs p50 | After 33,600 operations, consumed freshness entries retained: 33,600 → 0. No per-entry byte claim.               |
| Scraper transactions, no I/O                         |                              0.349 → 0.396 ms p50 | Scheduling overhead; ~13.5% slower without waits to overlap.                                                     |
| Monitor, no I/O                                      |                              0.142 → 0.150 ms p50 | ~6% overhead without waits to overlap.                                                                           |
| Ethers failed simulation                             | API 2.583 → 2.600 ms; quiescence 2.585 → 9.094 ms | Calls 1 → 2; paired fee read continues after rejection.                                                          |
| Indexing, 20k u64 messages / 1 subscriber, 2 workers |                              1.764 → 1.812 ms p50 | ~2.7% median overhead.                                                                                           |
| Full broadcast completion with slow subscriber       |                            31.148 → 31.232 ms p50 | Lossless subscriber backpressure retained.                                                                       |

The initial actor at `d555ffbfd7` regressed the one-subscriber benchmark from 1.748 to 150.081 ms (~86x). That result is preserved in [broadcast/initial-actor.json](broadcast/initial-actor.json). It prompted the revision: an actor owns subscriber registration, publishes immutable snapshots, and ready sends avoid actor round trips. The revised paired run is in [broadcast/results.json](broadcast/results.json). These runs have separate baseline controls.

## Evidence and reproduction

| Suite              | Protocol                                                                                                                                                       | Results / commands                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Public RPC         | One public Ethereum endpoint; 2 warmups + 15 alternating pairs; 15/15 successes each; 105 total read calls including preflight/warmup; no signing or broadcast | [Table](ts/public-rpc-results.md), [raw JSON](ts/public-rpc-results.json), [reproduce](ts/PUBLIC_RPC.md)        |
| TypeScript         | Node 26.12.1; 5 warmups + 41 measured rounds/version/workload; alternating AB/BA                                                                               | [Table](ts/results.md), [820 measured samples](ts/results.json), [reproduce](ts/README.md)                      |
| Scraper / multisig | Rust 1.88; 5 warmup + 30 measured pairs/scenario; alternating AB/BA                                                                                            | [Table](rust/results/table.md), [raw samples and manifest](rust/results/), [reproduce](rust/README.md)          |
| Lander             | ABBA process order; 50 measured I/O or 1,000 no-I/O batches/process; width-1/8 controls; 56 process captures                                                   | [Tables](lander/COMPARISON.md), [raw archive](lander/results/raw-samples.tar.gz), [reproduce](lander/README.md) |
| Indexing broadcast | Full release build; current-thread and 2-worker runtimes; ABBA process order; 5 warmups + 30 measured batches/process                                          | [Tables and commands](broadcast/README.md), [raw JSON](broadcast/results.json)                                  |

Host: Apple M3 Pro, 11 logical CPUs, 36 GiB. Builds finished before timing; suites ran serially. No outliers were removed. Results are workload-specific; no production capacity or billing claim follows from them. Lander/scraper/multisig leaf crates used opt-level 3 with cached test/debug dependencies, debug assertions and overflow checks: **not full release builds**. Broadcast dependencies also used release optimization. Each suite states whether CPU/RSS includes startup/warmup and whether both versions shared a process; shared-process RSS is not attributed to one implementation.

Non-broadcast measurements used `d555ffbfd7`; their source files are byte-identical at `64c9c07b5d`, verified in [source-equivalence.json](source-equivalence.json). Broadcast was remeasured at the revised commit. No permanent benchmark hooks or generated baseline source copies were left in production modules. zkSync/Tron paired reads have functional regression coverage but no timing benchmark here.
