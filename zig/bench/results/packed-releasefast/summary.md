# Packed prover ReleaseFast

Team compiler-idle, shared user host. Rust/Zig>1 favors Zig; every row retained. CPU kernels, no whole-agent claim.

| Kernel | Leaves | Rust ns/op | Zig ns/op | Rust/Zig |
| --- | ---: | ---: | ---: | ---: |
| packed_ingest | 8,192 | 5,669.4 | 4,991.8 | 1.136 |
| packed_ingest | 131,072 | 5,616.0 | 4,941.8 | 1.136 |
| packed_proof_latest | 4,096 | 87.3 | 87.1 | 1.002 |
| packed_proof_latest | 65,536 | 123.9 | 120.9 | 1.025 |
| packed_proof_historical | 4,096 | 1,551.3 | 1,375.3 | 1.128 |
| packed_proof_historical | 65,536 | 2,331.6 | 2,100.2 | 1.110 |
