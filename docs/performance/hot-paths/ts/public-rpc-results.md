# Actual public HTTP RPC fee-estimator results

Endpoint: https://ethereum-rpc.publicnode.com. Node v26.12.1, Apple M3 Pro.

Baseline 7e80c603f0278c9b1f0555fe0106279e2df5f070; proposed d555ffbfd7d82438851e6f848ea7dfc28b2e336d. The three compared TypeScript file blobs equal workspace head 64c9c07b5d77c83f1f2b5230eb13ab5939f9af6c.

2 warmups and 15 alternating AB/BA pairs. 15/15 pairs succeeded. Median paired speedup: 1.68x.

| Metric                            | Baseline | Proposed |
| --------------------------------- | -------: | -------: |
| Successful estimates              |    15/15 |    15/15 |
| API p50, ms                       |   86.498 |   46.322 |
| API p95, ms                       |  154.019 |  237.926 |
| Estimates/s, measured active time |    11.43 |    16.56 |
| p50 CPU, ms/estimate              |    7.528 |    6.564 |
| Measured JSON-RPC invocations     |       45 |       45 |
| Measured JSON-RPC failures        |        0 |        0 |
| Peak active JSON-RPC reads        |        2 |        3 |

Total JSON-RPC invocations including warmup and preflight: 105/120 budget. Measured method counts, baseline/proposed: eth_estimateGas: 15/15; eth_gasPrice: 15/15; eth_getBlockByNumber: 15/15.

The median improved, while the observed tail worsened. With 15 proposed samples, nearest-rank p95 uses ordered sample 15 (the maximum): 237.926 ms. No outliers were removed. Throughput excludes deliberate 250 ms inter-estimate pauses and is not a sustained public-endpoint load test.

Shared-process peak RSS: 231.5 MiB, including snapshot preparation/imports. It is not an independent per-version memory measurement.

This is one public endpoint under changing network/server conditions and latest-block state; it does not establish production-wide or tail-latency gains. No signing/broadcasting occurred. Raw JSON records every request duration, observed block number, CPU/RSS sample, gas/fee result and source digest.
