# RPC physical timeout recovery

No unresolved blocker found in the implemented producer/binding slice. All four final commands exit0, and all20 selected Source/test hashes match before/after. This is functional loopback verification, not benchmarking, a production request, an SDK rebuild or final whole-role acceptance.

## Trigger and Source comparison

An actual native curl request at endpointA reaches its20-second physical limit while its real120-second operational Clock remains live. Curl28 previously surfaced as RequestDeadlineExceeded; the generic JSON-RPC/Tron/Aleo clients classify that name as control and return before healthyB. Their next attempt restarts atA. Thus a persistent stalled primary can prevent progress indefinitely.

Rust Tron HttpChannel explicitly configures30-second requests and core FallbackProvider continues to another provider after timeout. Aleo AllErrors/coreFallback supports the same continuation. Starknet's custom fallback visits the next HttpTransport on a transport error; its wrapper does not explicitly establish a20/30-second SDK timeout, so this report does not claim that an indefinitely stalled Rust Starknet body necessarily expires at that interval. Source evidence is retained in source-audit.md. Cosmos Pool's distinct per-request versus whole-session budget correction belongs to the parent/baseline slice; this implementation only binds its actual caller deadline field.

## Implemented boundary

cloud.HttpTransport has an optional value-owned RpcReadOwner containing a true monotonic absolute deadline and optional halt flag. It checks cancel/halt/remaining budget, clamps each native send, and records whether the physical timeout was strictly below owner remaining at send. Only an actual non-overridden native RequestDeadlineExceeded can become UpstreamReadTimeout; the owner must still be live and uncanceled/unhalted after completion. Owner-clamped/equal/expired budgets, injected errors, cancel, halt, OOM, size errors and other errors retain their original category. No generic isControl or business parser classifier changes.

Factory.Scope binds/restores both Resources.rpc_deadline_ns and HTTP owner from the actual Clock. Its separate credential signer owner receives no RPC guard. Scraper Lane.cycle binds its retained actual attempt deadline; receipt jobs bind their actual batch deadline. DeadlineTransport defaults rpc_read=false; all known RPC constructors opt in explicitly. Nested RPC wrappers take the earlier existing deadline and preserve inherited halt. Aleo Prover explicitly opts out and clears/restores an inherited RPC owner. No new production Pool, thread, per-request worker or SDK is introduced; production20-second physical limits are unchanged.

Coverage audit: ordinary origin indexing and health already force cooperative HTTP replay, which owns its own actual budget normalization. Generic validator chain-vote slots inject their existing one-slot replay deadline (injected control stays control); generic event indexing already has its outer native-timeout endpoint rotation. Those paths must not infer a120-second direct owner from the replay-only read_attempt_timeout_ms config. Receipt and signer wrappers use their supplied actual deadlines. Cloud credential/KMS/storage/public-identity transports remain unbound.

## Accepted results

- Focused RPC physical timeout root17/17, no skips: actual20-second nativeA→B for Starknet/Tron/Aleo with true120-second owner; equal/clamped/expired/unbound limits; midflight and precancel; injected deadline/OOM/size/cancel preservation; halt; nested100ms owner/500ms wrapper; non-RPC optout/restoration; allocation sweep; actual Factory scope/separate credentials test.
- Existing Factory separate-owner scope12/12.
- Existing origin native HTTP checks19pass/1optional gRPC HTTP2 fixture skip.
- Existing receipt aggregate366pass/10existing optional environment-dependent skips, including actual16-job fanout and generic allocation/admission tests. The generic receipt fixture now requires each fetch to see the actual batch deadline in both raw Resources and HTTP owner scope.

All commands/logs/source hashes are archived losslessly under zig/bench/results/rpc-physical-timeout-recovery. Parent owns permanent root.zig registration and full global nativeSDK/HTTP2 acceptance; these isolated skips do not establish optional fixture coverage. Prior preliminary fixture failures were corrected in test-only routing: EVM's POST-only exact numeric path fixture could not handle real Tron/Aleo REST URLs, so the focused root now owns a bounded GET/POST fixture routing by first numeric path component. No production behavior was changed to fit the fixture.
