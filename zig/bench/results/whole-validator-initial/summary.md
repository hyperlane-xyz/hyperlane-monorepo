# Provisional actual EVM validator comparison

5 balanced pairs, 32 backlog + 8 fixed 1s dispatch arrivals. Actual production Rust/Zig binaries; normal majority/local key/LocalStorage only. Shared host compiler load4.1→42.9. Telemetry/durability differ; not all-feature-equivalent speedup.

| Metric | Rust median | Zig median | Zig/Rust |
| --- | ---: | ---: | ---: |
| Startup/catchup ms | 3,468.784 | 2,865.645 | 0.826 |
| Steady freshness ms | 1,974.376 | 526.780 | 0.267 |
| CPU seconds | 0.261 | 1.011 | 3.865 |
| Peak RSS bytes | 36,519,936.000 | 38,862,848.000 | 1.064 |
| JSON-RPC requests | 96.000 | 461.000 | 4.802 |

Higher CPU/RSS/RPC costs are retained. All 400 checkpoint signatures independently verified. Detailed raw samples and binary identities: `validator.json`.
