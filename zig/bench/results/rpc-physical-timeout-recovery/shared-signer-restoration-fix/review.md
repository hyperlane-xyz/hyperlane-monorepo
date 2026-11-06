# Shared signer isolation final review

No unresolved blocker in the corrected timeout-capability slice. Actual shared Manager/Factory remote signing, public-key error unwinding, pre-Factory auth and unchanged CCS/reveal coverage pass31/31 with no skips. Ten independent selected Source/test hashes match before/after. The producer matrix passes18/12/19/366 (optional skips qualified below), all four commands exit0, and17 recorded Source/test hashes match before/after. Parent/baseline's general fallback deadline integration and combined whole-role acceptance remain separate.

## Two concrete findings closed

1. Actual relayer credentials.Manager and Tron Factory can share Resources.http. The earlier separate-owner test did not cover this alias, so KMS signing inherited RPC timeout normalization. RpcReadOwner.retry_physical_timeout now defaultsfalse. Known RPC scopes opttrue, while non-RPC signing/proving retains the true monotonic Clock/cancel/halt with capabilityfalse. Nested scopes cannot upgrade inheritedfalse.
2. Independent actual Factory.open public-key timeout proved that the first NonRpcScope helper failed to preserve the original capability before in-place mutation. An explicit field-by-field snapshot now materializes deadline/halt/capability before mutation. A direct nested-error regression reproduces the earlier failure and passes after correction. Actual public-key error unwinding now restores the inherited owner exactly. The negative proof is retained losslessly, with no weakened fixture or production KMS validation.

Factory scopes bracket remote public-key initialization, actual digestSign callbacks and tickReveal's shared CCS signer/HTTP transport. Distinct signer owners receive the real absolute Clock with retryfalse and exact restoration. Aleo Prover's explicit nonRPC DeadlineTransport now keeps min(inherited,wrapper) deadline and halt rather than clearing the real owner. Current role Manager lease/refresh occurs before Factory scopes; its actual STS web-identity path is separately tested, without inventing a nested renewal path. No signer/auth/KMS retries or policies changed.

## Accepted evidence

- Producer focused18/18: real20s native physical timeouts with true120s owners, three RPC families advancingB and a fourth false-capability control refusingB; genuine equal/clamped/expired/unbound deadlines, midflightcancel, injected/OOM/size controls, nested owner/nonRPC restoration and allocation sweep.
- Existing Factory separate-owner scope12/12.
- Existing origin nativeHTTP19passed/1optionalHTTP2 skip; receipt aggregate366passed/10existing environment-dependent native SDK/HTTP2/OpenSSL/JWT/cloud fixture skips. Counts overlap imported roots.
- Independent31/31: actual Manager staticAWS lease retaining Resources.http, canonical prepared Tron Factory.sign/real native KMS timeout, persistence/control barriers, later RPC retry restoration, public-key initialization error restoration, real STS auth before Factory,11CCS tests, actual UR/reveal and allocation coverage. Known public fixture keys/credentials only; no production requests or credentials.

Current lossless evidence: zig/bench/results/rpc-physical-timeout-recovery/shared-signer-restoration-fix. Exact commands, before/after hashes and independent owner result/logs are included. Original producer snapshots before shared-signer and public-key-restoration corrections remain unchanged and explicitly historical. No SDK/role/image build, new production worker/Pool, timeout reduction or benchmark belongs to this slice.
