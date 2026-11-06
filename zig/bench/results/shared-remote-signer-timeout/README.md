# Shared remote signer timeout evidence

**31/31 passed**, zero skips/failures/leaks;15 named functional cases plus16 import roots. Ten recorded source/test hashes unchanged during the accepted run and independent final readback. ReleaseSafe, Zig0.15.2, macOS ARM, actual native curl and RocksDB; full explicit development SDK environment recorded. No SDK rebuild, live credential/KMS call, benchmark, or global acceptance claim.

## Actual ownership regression

The relayer constructs its credential Manager with `&network.http`. Without a transport override, its lease returns that same owner and interface; the native Tron Factory binds it as `signer_http`. Factory signing scopes the same owner for RPC, while its real digest callback performs remote KMS I/O. Treating every physical timeout under that scope as a retryable RPC error would incorrectly reclassify signing failures.

The new test uses actual `Manager.init`/`lease`, synthetic AWS environment values, native SigV4 GetPublicKey against a bounded root-only loopback KMS server, `Factory.open`, a validated canonical Tron intent, and `Factory.sign`'s real remote digest callback. The KMS server checks actual AWS authorization and DIGEST request body. The fixture key is disposable/public17 (0x11 repeated); its public point forms the public-key response. No private KMS material is read.

| Check | Result |
|---|---|
| Real shared Manager lease and Factory signer owner/interface | Same concrete HTTP owner |
| Physical KMS signing timeout50ms inside true2s Clock | RequestDeadlineExceeded; no signed persistence |
| Operation cancel, halt, and elapsed true Clock after intent persistence | Correct control error; no extra KMS request |
| Same owner RPC physical timeout after signing guard/Factory Scope unwind | UpstreamReadTimeout |
| Inherited owner deadline/cancel/capability after every exit | Exact restoration |
| Actual remote public-key constructor timeout under inherited RPC capability | RequestDeadlineExceeded; exact restoration |
| Real Manager web-identity STS lease before Factory construction | Physical timeout remains RequestDeadlineExceeded |
| STS cancel/halt/elapsed owner | Correct control error; no extra physical request |
| Existing actual UR reveal runner | Passed unchanged |
| Existing11 CCS lifecycle/control/OOM cases | Passed unchanged |
| Existing reveal/CCS authentication allocation sweep | Passed unchanged |

Physical50ms is an explicit fixture setting to distinguish physical timeout from live owner budget. Production20s/120s fallback evidence belongs to `../rpc-physical-timeout-recovery/`; no production timeout was shortened by these tests. STS auth runs in actual role ordering before Factory construction, not through an artificial nested lease callback.

## Independent finding and closure

The first real public-key error-unwind regression found `NonRpcScope` leaving inherited `retry_physical_timeout=false` after an actual constructor timeout. The HTTP owner deadline remained intact, but later chain RPC retries were disabled. The production owner corrected the snapshot with explicit field copies before in-place capability mutation and added a direct permanent helper regression. This test retained its original true-capability restoration assertion; final31/31 accepts the correction. Historical negative Debug output and command are preserved losslessly in `historical-public-key-restoration-failure/`.

Readback confirms capability defaults false; deadline, cancel and halt remain enforced regardless of capability. Factory public-key initialization, real digest signing and reveal CCS paths temporarily disable normalization; exact prior guards restore on return/error. Separate signer owners receive the true owner Clock. Nested non-RPC DeadlineTransport retains the earlier clock and cannot be upgraded by a nested RPC wrapper. No unresolved blocker found in this scoped review.

## Artifacts and registration

`manifest.json.gz` contains full source hashes, artifact digests and all test names. `command.json.gz`, `result.json.gz`, and `tests.log.gz` preserve accepted bytes. `result.json` is a short scan-friendly result. Use `gzip -dc` for exact contents.

New files only: `zig/src/agents/destination/shared_remote_signer_timeout_test.zig` and `zig/src/shared_remote_signer_timeout_tests.zig`. The wrapper additionally imports unchanged reveal_runner_test and ccs_signer_test, with existing DB bzip2 glue. No existing production source or aggregate registration was edited by this independent test owner. The parent owns permanent aggregate registration and final global acceptance.
