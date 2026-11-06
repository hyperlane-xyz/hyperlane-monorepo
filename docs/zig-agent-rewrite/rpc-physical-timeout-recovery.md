# RPC physical timeout recovery

A stalled primary could consume the native 20-second request limit while the
actual 120-second job budget remained live. The generic clients treated its
`RequestDeadlineExceeded` as control, stopped before a healthy second peer and
restarted at the same primary on every attempt.

`cloud.HttpTransport` now accepts an explicit absolute monotonic RPC owner. An
actual native timeout becomes `UpstreamReadTimeout` only when the physical limit
was strictly below the remaining owner budget and that owner is still live,
uncanceled and unhalted. Each send consumes the same absolute deadline.
Clamped/equal/expired limits, injected errors, cancellation, halt, OOM and bounds
keep their existing categories. Generic client control predicates remain unchanged.

Factory scopes bind and restore the actual operational Clock. Scraper cycles and
receipt jobs bind their actual attempt or batch deadlines. DeadlineTransport
defaults to non-RPC; known RPC wrappers opt in explicitly. Nested wrappers use
the earlier inherited deadline and preserve halt. The Aleo prover explicitly
opts out of retry while keeping the same deadline, halt and cancellation guard.
`RpcReadOwner.retry_physical_timeout` defaults to false; known RPC scopes opt in
and nested scopes cannot upgrade an inherited false capability. Factory also
disables retry around remote public-key initialization, shared-owner signing and
CCS signing/HTTP, restoring the owner afterward. Separate signer owners receive
the actual Clock with retry disabled. Production physical timeouts are unchanged;
this adds no Pool, worker, thread or SDK dependency.

Rust Tron and Aleo fallback support advancing to another peer after a physical
timeout. Starknet's custom fallback continues after a transport error, but its
wrapper does not specify a 20/30-second SDK timeout; these tests do not establish
such a Rust deadline. Cosmos Pool's separate physical/session budget correction
is documented by its own evidence. Existing cooperative origin/health replay and
validator slot/indexer timeout ownership remain intact.

| Functional verification                                |                        Result |
| ------------------------------------------------------ | ----------------------------: |
| Actual native physical timeout and owner controls      |                     18 passed |
| Existing Factory separate-owner scope                  |                     12 passed |
| Origin native HTTP checks                              |    19 passed, 1 optional skip |
| Receipt aggregate, including actual shared fanout      | 366 passed, 10 optional skips |
| Independent actual shared Manager/signer, auth and CCS |                     31 passed |

All four commands exited successfully and all 17 owned source/test hashes
matched before and after. Counts overlap imported roots. The optional skips are
existing HTTP/2, Aleo SDK/worker, native-cloud and OpenSSL/JWT fixture gates;
they do not establish coverage for those fixtures.

The focused cases use actual native sockets at the production 20-second physical
limit for Starknet, Tron and Aleo, with a true 120-second owner and healthy second
peer. A fourth concurrent owner uses the same 20/120-second budgets with retry
disabled and must return the original deadline control without contacting B.
Negatives cover equal/clamped/expired/unbound deadlines, cancellation
during a pending request, injected controls, OOM, halt, nested deadlines and
non-RPC restoration. Receipt fixtures also assert that every fetch sees its real
batch deadline. The new focused root requires permanent default-root registration
by the parent integration owner.

[Exact commands](../../zig/bench/results/rpc-physical-timeout-recovery/shared-signer-restoration-fix/commands.json.gz),
[source hashes/results](../../zig/bench/results/rpc-physical-timeout-recovery/shared-signer-restoration-fix/manifest.json.gz)
and lossless logs are archived with the
[review](../../zig/bench/results/rpc-physical-timeout-recovery/shared-signer-restoration-fix/review.md).
Packed artifacts can be read directly with gzip or restored with
`python3 zig/tools/fixture_pack.py unpack <artifact.gz>` after configuring the
raw mirror ignore rules. These are correctness results, not benchmarks,
production-network checks or final whole-role acceptance.

Independent review found that the actual relayer Manager and Factory can share
Resources.http. The original separate-owner test did not prove isolation for that
path. Original measurements remain unchanged as historical evidence; the current
matrix includes the capability correction. Independent actual Manager/shared
Factory KMS, initialization, auth and CCS validation passes 31/31 with no skips.
That review also caught an error-unwind bug in the initial retry-capability
snapshot. Explicit field snapshots before mutation now restore public-key
initialization errors correctly, with a permanent nested-error regression.
The independent run's ten source/test hashes match before and after.
