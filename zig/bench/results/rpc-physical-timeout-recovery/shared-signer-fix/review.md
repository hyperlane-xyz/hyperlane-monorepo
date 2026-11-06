# Shared signer HTTP capability correction

Producer/control matrix passes with17 owned Source/test hashes unchanged. Independent actual Manager/shared Factory signer and CCS acceptance remains pending the test owner's final result. Parent owns combined integration/source freeze; this is not whole-role or performance acceptance.

## Finding corrected

The relayer creates credentials.Manager with &network.http, whose lease retains that same HttpTransport. Tron Factory retains the same signer_http pointer. Earlier Factory.begin bound an RPC retry owner on Resources.http but only treated distinct signer owners separately. Actual remote digest signing therefore inherited physical-timeout normalization. The earlier separate-owner fixture did not cover this production alias; the original17/12/19/366 evidence is historical and unchanged.

## Current contract

RpcReadOwner.retry_physical_timeout defaults false. A real owner always enforces its absolute monotonic deadline, cancellation and halt, independent of that capability. Actual native physical timeout normalization additionally requires capability=true, a strict smaller physical request budget, a still-live owner and no injected native send override. Known RPC binders explicitly enable it; nested scopes preserve inheritedfalse rather than upgrade it.

DeadlineTransport.rpc_read=false keeps the earlier inherited/wrapper deadline and halt, so Aleo Prover no longer clears the true owner or relies only on a one-time timeout clamp. Scope restoration remains exact on success/error/control/OOM. The configured production physical timeout is unchanged.

Factory's small NonRpcScope copies/restores the complete owner value and only disables retry. It brackets remote public-key initialization during open, the actual digestSign callback, and tickReveal's shared HTTP section for CCS signing/read. SVM chain RPC clients in that section use their native/Pool path. Distinct signer HTTP owners receive the same actual operational Clock with retryfalse during Factory.begin, then restore their previous deadline/cancel/timeouts/owner. Actual Manager lease/refresh runs outside Factory.begin in the current role path; no credential policy/retry behavior was changed.

## Evidence

- Focused17/17 zeroSkip includes four concurrent native20s physical requests under true120s owners: Starknet/Tron/Aleo RPCs each reachB; false-capability owner returns original RequestDeadlineExceeded and never contactsB.
- Existing Factory separate-owner scope12/12; nested RPCfalse/prover min/halt/expired controls; injected deadline/OOM/size/cancel; allocation sweep; midflight cancel.
- Existing origin nativeHTTP19passed/1optional HTTP2 fixture skip.
- Existing receipt aggregate366passed/10existing environment-dependent skips, including real fanout and ownership/allocation tests.
- All four commands exit0;17 owned hashes match before/after and fresh readback; formatting exit0.

Raw Pool defaults, generic isControl/business parsers, sign/KMS/auth retries and SDK dependencies are unchanged. No production credentials/requests, SDK/role/image builds or benchmarks. Current lossless evidence: zig/bench/results/rpc-physical-timeout-recovery/shared-signer-fix; original measurement/log bytes remain unchanged in the parent artifact directory, marked historical by README/acceptance-status.
