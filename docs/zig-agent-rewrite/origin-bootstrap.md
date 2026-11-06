# Origin cursor startup

Origin handles were published after resource construction, before an actual
stream tip/count or cursor plan succeeded. Repeated initial dispatch/tree reads
could therefore fail indefinitely while the critical gauge stayed healthy.
Already-canceled tasks could also count a constructor error as startup failure.

Each relayer stream now tracks its own completed startup failures. An ordinary
RPC or missing-count failure schedules the next attempt two seconds after the
read completes. After the tenth failure and its final sleep, the matching
message, tree or gas sync reason becomes critical. Healthy streams keep rotating.
The first successful tip/count, cursor construction and progress plan clears
only that stream's reason. Range fetches retain their separate five-second
initial backoff; storage, corruption, refusal, cancellation, OOM and cooperative
control errors keep their existing error paths.

Native indexing keeps retrying after startup exhaustion and can recover in the
same owner. Rust drops the exhausted cursor task. Resource/Service construction
retains the existing separate native task retry policy. These are explicit
architecture differences. The shared indexing Core enables this policy only for
relayer services; validator insertion initialization remains independently owned.

WS handoff clears only the two direct RPC sync reasons after both sequenced
streams are masked. Gas, loader, destination and health reasons remain intact.
Masked streams issue no indexing RPCs or fabricated liveness observations.
Cancellation is checked before constructing any origin resources or database.

Pooled reads now identify a completed request timeout as `UpstreamReadTimeout`
when the absolute owner budget remains live. Owner-clamped requests, equal
limits, sub-millisecond owner-boundary rounding, cancellation and injected clocks
retain control status. Direct native curl timeouts receive equivalent startup
classification. The global range-fetch retry classifier is unchanged.

| Functional check                                                                                                                         | Result                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Native origin compatibility: persisted streams, reopen/proofs, replay, gaps, frames, existing fetch backoff, new startup regressions     | 41 passed                                        |
| Final scoped startup run on final business sources, including direct native timeout                                                      | 20 passed                                        |
| Exact tenth-failure sleep, reason isolation, control/persistence exclusions                                                              | 6 passed including root imports                  |
| Read replay: real physical timeout, absolute owner budget, cancellation, owner-clamped boundary, injected clock and existing regressions | 86 passed; 1 unrelated opt-in cloud test skipped |

The startup regressions exercise both generic execution paths with RocksDB,
healthy insertion persistence beside failing dispatch/gas startup, 24 completed
EVM count failures, recovery, retained sibling reasons, disabled-stream call
counts and five pre-canceled descriptor invocations. Deadline fixtures verify
functional classification; their configured durations are not performance results.

Raw logs, reproducible argument arrays, environment and source hashes are in
[`origin-bootstrap-failures/manifest.json`](../../zig/bench/results/origin-bootstrap-failures/manifest.json).
The two `before-*.log` files reproduce the old defects. Evidence was collected
while other owners worked on unrelated files. Whole-role integration, containers
and performance benchmarks remain separate acceptance gates.
