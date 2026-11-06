# Protocol kernels: Zig ReleaseFast

Production Rust core versus partial Zig protocol implementation; no whole-agent speedup claim.

9 measured samples per language/case; median inner-loop ns/op; native Apple M3 Pro.

| Kernel | Body bytes | Rust ns/op | Zig ns/op | Rust/Zig |
| --- | ---: | ---: | ---: | ---: |
| `message_id` | 0 | 168.1 | 160.1 | 1.050 |
| `message_id` | 64 | 325.4 | 313.9 | 1.037 |
| `message_id` | 1,024 | 1,427.6 | 1,406.4 | 1.015 |
| `message_id` | 65,536 | 73,305.2 | 71,173.8 | 1.030 |
| `message_roundtrip_owned` | 0 | 189.3 | 177.5 | 1.067 |
| `message_roundtrip_owned` | 64 | 367.6 | 339.8 | 1.082 |
| `message_roundtrip_owned` | 1,024 | 1,514.8 | 1,444.1 | 1.049 |
| `message_roundtrip_owned` | 65,536 | 78,688.5 | 85,721.3 | 0.918 |
| `merkle_ingest` | 0 | 165.2 | 163.4 | 1.011 |
| `merkle_ingest_root` | 0 | 5,068.0 | 5,061.8 | 1.001 |

Rust/Zig >1 means Zig was faster in that case; <1 is a regression. All cases retained.

These CPU kernels exclude RPC, persistence, metadata fetching, queues, signing, confirmation, and scraper databases.
Allocator implementations and language safety configurations differ; see the benchmark methodology.

| Harness build | Seconds | Cache state |
| --- | ---: | --- |
| rust | 26.289 | fresh compiler target/global cache; dependency downloads cached |
| zig | 4.510 | fresh compiler target/global cache; dependency downloads cached |

Harness build feature sets differ; these are not whole-agent build improvements.
