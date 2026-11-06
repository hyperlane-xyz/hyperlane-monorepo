Two raw heap test constructors omitted declared field defaults. Explicitly initialize CCIP context_hash before lookup and EVM Runtime.chain before publishing its interface. Production code unchanged by this slice.

| Full delegated root | ReleaseSafe | ReleaseFast |
| --- | ---: | ---: |
| CCIP sessions | 417/417 | 417/417 |
| EVM driver | 443/443 | 443/443 |

Zero skips/failures. Complete available development SDK environment; fresh local gRPC server per binary and temporary generated RSA fixture. Seven source/test hashes stayed unchanged across all four runs. These are functional checks, not benchmarks.

`manifest.json` binds 32 losslessly compressed artifacts: exact commands/environment, final results/logs, accepted source snapshot, causal before/negative/after checks, bounded variant review, and untouched original broad ReleaseFast failure. SHA256 chunks concatenate in order. No RSA private material archived.

The original CCIP constructor yielded allocator poison in Safe and zero pages in Fast. Zero collided with the intentionally wrong context and returned 500 instead of null. A strict initial-nine assertion fails in both modes before explicit initialization. The EVM variant could read an uninitialized optional receipt before setReceipt. Existing minimum-delay, expiry, context-isolation, receipt, fee and status assertions remain.

The first diagnostic full-root harness reused one gRPC server across binaries; an existing absolute four-probe assertion accumulated 8/12/16 and failed. Its preserved logs are explicitly historical. The final accepted harness isolates every server.

Bounded variant scope: eleven raw Fixture constructors plus related Runtime/LifetimeFixture constructors. No broader repository-wide initialization claim. Parent owns final global/Linux-container acceptance.
