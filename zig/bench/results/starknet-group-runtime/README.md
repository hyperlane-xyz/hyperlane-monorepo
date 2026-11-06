# Native group runtime evidence

Final focused aggregate: **95/95 passed**, zero failures/skips; **73 named functional cases plus22 import roots**. All16 recorded source/test hashes were unchanged across the accepted run. Zig0.15.2 ReleaseSafe, ARM macOS, actual native Starknet crypto and fsynced RocksDB.

| Check | Result |
|---|---:|
| Final combined native aggregate |95/95 |
| Named functional scenarios |73 |
| Import roots |22 |
| Skips / failures |0 /0 |
| Recorded source/test files unchanged |16/16 |
| Seeded actual SDK/DB crash schedules |24 |

This is functional evidence. The parent rewrite owns final whole-role/default/native/PG/cold Linux SDK/container acceptance and all benchmarking. Starknet network fixtures are deterministic in-process JSON RPC; existing public-relay cases use real loopback HTTP. DB recovery closes/reopens actual Rocks and recreates the Factory/Lane; it does not claim an OS process restart.

- `manifest.json.gz`: exact command/environment, all names, source SHA256 strings, host and native-library qualification.
- `source-sha256.json.gz`: exact unabridged before/after source map.
- `command.json.gz`, `result.json.gz`, `combined-tests.log.gz`: lossless accepted run artifacts.
- `result.json`: short scan-friendly result.
- `historical-pre-alternating-priority/`: byte-for-byte historical94/94 candidate and prior failed/hung fixture evidence; explicitly not final acceptance.

Use `gzip -dc manifest.json.gz` and `gzip -dc combined-tests.log.gz`. Gzip preserves full hash strings and raw output without fragmenting or relaxing repository checks.

Implementation and Source boundaries: [runtime report](../../../../docs/zig-agent-rewrite/starknet-group-runtime.md), [backend batching](../../../../docs/zig-agent-rewrite/starknet-batch-backend.md), [finalized nonce proof](../../../../docs/zig-agent-rewrite/starknet-nonce-proof.md).
