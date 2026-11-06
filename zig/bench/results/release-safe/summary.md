# Protocol kernels: Zig ReleaseSafe

Production Rust core versus partial Zig protocol implementation; no whole-agent speedup claim.

9 measured samples per language/case; median inner-loop ns/op; native Apple M3 Pro.

| Kernel | Body bytes | Rust ns/op | Zig ns/op | Rust/Zig |
| --- | ---: | ---: | ---: | ---: |
| `message_id` | 0 | 194.4 | 228.6 | 0.851 |
| `message_id` | 64 | 393.1 | 418.8 | 0.939 |
| `message_id` | 1,024 | 1,637.6 | 1,793.3 | 0.913 |
| `message_id` | 65,536 | 80,043.8 | 98,195.8 | 0.815 |
| `message_roundtrip_owned` | 0 | 194.5 | 219.3 | 0.887 |
| `message_roundtrip_owned` | 64 | 370.0 | 398.0 | 0.930 |
| `message_roundtrip_owned` | 1,024 | 1,454.8 | 1,685.6 | 0.863 |
| `message_roundtrip_owned` | 65,536 | 76,826.8 | 103,042.2 | 0.746 |
| `merkle_ingest` | 0 | 163.6 | 186.9 | 0.875 |
| `merkle_ingest_root` | 0 | 5,378.9 | 6,069.4 | 0.886 |

Rust/Zig >1 means Zig was faster in that case; <1 is a regression. All cases retained.

These CPU kernels exclude RPC, persistence, metadata fetching, queues, signing, confirmation, and scraper databases.
Allocator implementations and language safety configurations differ; see the benchmark methodology.

| Harness build | Seconds | Cache state |
| --- | ---: | --- |
| rust | 26.244 | fresh compiler target/global cache; dependency downloads cached |
| zig | 7.655 | fresh compiler target/global cache; dependency downloads cached |

Harness build feature sets differ; these are not whole-agent build improvements.
