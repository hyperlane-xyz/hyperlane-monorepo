# TypeScript source comparison: measured results

Baseline: 7e80c603f0278c9b1f0555fe0106279e2df5f070. Proposed: d555ffbfd7d82438851e6f848ea7dfc28b2e336d.

Node v26.12.1; Apple M3 Pro; 5 warmups and 41 measured rounds/version/workload. Controlled synthetic delays, not production traffic. B/P = baseline/proposed.

| Workload                             | B p50 ms | P p50 ms | B p95 ms | P p95 ms | p50 speedup | Workloads/s B/P | CPU ms/workload B/P | Provider calls/workload B/P | Peak active B/P |
| ------------------------------------ | -------: | -------: | -------: | -------: | ----------: | --------------: | ------------------: | --------------------------: | --------------: |
| map_uniform                          |   20.610 |   20.363 |   20.825 |   20.765 |       1.01x |           49/50 |         0.562/0.504 |                         0/0 |             8/8 |
| map_stragglers                       |   97.336 |   39.359 |   99.363 |   40.792 |       2.47x |           10/25 |         1.166/0.787 |                         0/0 |             8/8 |
| map_no_io                            |    0.082 |    0.034 |    0.087 |    0.037 |       2.45x |     12129/28665 |         0.083/0.034 |                         0/0 |         n/a/n/a |
| ethers_delay                         |   19.475 |    9.771 |   20.115 |   10.237 |       1.99x |          51/103 |         0.329/0.215 |                         2/2 |             1/2 |
| ethers_no_io                         |    0.004 |    0.004 |    0.007 |    0.007 |       0.95x |   242296/238754 |         0.004/0.005 |                         2/2 |             1/2 |
| viem_delay                           |   19.428 |    9.507 |   20.076 |   10.078 |       2.04x |          52/105 |         0.195/0.120 |                         2/2 |             1/2 |
| ethers_failed_simulation (quiescent) |    2.585 |    9.094 |    2.649 |    9.633 |       0.28x |         394/110 |         0.085/0.179 |                         1/2 |             1/2 |
| monitor_8_chains                     |   43.487 |    5.587 |   44.460 |    5.894 |       7.78x |          23/185 |         1.413/0.690 |                       24/24 |            8/16 |
| monitor_32_chains                    |  164.233 |   21.510 |  166.693 |   22.132 |       7.64x |            6/47 |         3.766/1.664 |                       96/96 |           32/16 |
| monitor_no_io                        |    0.142 |    0.150 |    0.216 |    0.225 |       0.94x |       6523/6004 |         0.150/0.167 |                       96/96 |           32/16 |

Map throughput counts complete maps, fee throughput counts estimates, Monitor throughput counts cycles. Multi-iteration samples report per-workload averages. CPU includes harness counters and validation. Map peak counts mapper tasks; other peaks count controlled provider-boundary reads. Provider calls are stub invocations; real getFeeData may issue multiple wire RPCs.

Failed-simulation API p50: baseline 2.583 ms, proposed 2.600 ms. Its table row measures time until all initiated reads settle, exposing the proposed implementation's additional fee-data read after simulation failure.

Shared-process peak RSS: 573.5 MiB. Both source versions are imported in one process; RSS is not an independent per-version memory comparison. This peak includes snapshot preparation/imports. Raw samples retain RSS observations, CPU deltas, counters and source digests.
