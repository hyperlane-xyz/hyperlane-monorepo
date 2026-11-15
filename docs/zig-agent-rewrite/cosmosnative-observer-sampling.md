# Cosmos-native observer sampling failure

The fifth Cosmos-native Safe case failed before its first 600-second hold.
The observer recorded an admin-request timeout, then repeatedly rejected a
sampling gap above its strict two-second bound. Root stopped the case and
recorded actual session 42297 joining with exit 1. No initial 600-second,
restart, full-case or performance acceptance follows from this attempt.

| Observation               | Actual evidence                                                                 | Scope                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Native commit diagnostics | 8 unique successful relayer commits; 8 matching independent transaction queries | Public chain observations; full family proof did not finish           |
| Lifecycle sampling        | 47 successful samples before failure                                            | Approximately 12.254 seconds between first and last successful sample |
| First observer error      | `TimeoutError: timed out`                                                       | Native admin HTTP client had a one-second request timeout             |
| Next observer error       | `per-ID observer sampling gap exceeds2s`                                        | Recorded 2.307604 seconds after the last successful sample            |
| Observer error log        | 587 entries                                                                     | First timeout followed by persistent strict sampling-gap errors       |
| Full case                 | Failed after controlled stop                                                    | No accepted initial hold or same-database restart                     |
| Cleanup                   | Direct children joined; no owned descendants, listeners or container remained   | Inputs unchanged; no forced cleanup                                   |

The runtime products came from production commit
`d51ca8d668b26a3fdd248b4dfa99609bdcd6e493`. The separate EOF v14 Rust helper
had passed its five correctness commands, including 49 external-helper and four
program controls. That repaired helper was the one launched here; the previous
attempt's EOF failure is separate historical evidence.

The archived observer source uses a one-second HTTP timeout for each admin
operation query. Its sampler queries the configured chains, then calls the
lifecycle checker, which permits at most two seconds between successful samples.
The recorded first timeout left the last successful sampling timestamp intact;
subsequent samples failed the gap check. The archive establishes that sequence.
The cause of the admin timeout and any observer repair require separate review.
No timeout or confirmation guard was relaxed for this failed attempt.

The [archive manifest](../../zig/bench/results/cosmosnative-d51-v5-observer-failure/manifest.json)
binds the stopped supervisor result, Root launch/stop/join receipts, public watch
summaries, observer errors and immutable source copies. The full native RPC and
gRPC traces, raw role environments/configurations, keyrings, databases, WALs and
executables remain private. Active operation rows are projected to identity,
status and timing fields. The supervisor copy redacts its container environment
and ownership token; its original size and digest remain recorded.

[Archive verification](../../zig/bench/results/cosmosnative-d51-v5-observer-failure/archive-verification.json)
checks all 34 deterministic gzip payloads against their originals or explicitly
listed projections. All originals remain unchanged. Cleanup signals sent to
nonchildren grant no parent-wait credit and do not turn the failed case into an
accepted proof.
