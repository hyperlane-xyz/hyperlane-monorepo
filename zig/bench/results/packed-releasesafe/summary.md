# Packed prover ReleaseSafe

Team compiler-idle, shared user host. Rust/Zig>1 favors Zig; every row retained. CPU kernels, no whole-agent claim.

| Kernel | Leaves | Rust ns/op | Zig ns/op | Rust/Zig |
| --- | ---: | ---: | ---: | ---: |
| packed_ingest | 8,192 | 5,776.7 | 5,466.3 | 1.057 |
| packed_ingest | 131,072 | 7,181.4 | 6,059.8 | 1.185 |
| packed_proof_latest | 4,096 | 121.4 | 140.7 | 0.863 |
| packed_proof_latest | 65,536 | 148.6 | 191.1 | 0.777 |
| packed_proof_historical | 4,096 | 1,572.3 | 1,540.8 | 1.020 |
| packed_proof_historical | 65,536 | 2,409.2 | 2,342.7 | 1.028 |
