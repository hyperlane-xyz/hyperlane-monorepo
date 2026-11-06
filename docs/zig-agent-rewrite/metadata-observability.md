# Metadata observation and cancellation

The shared metadata builder now emits completed multisig/CCIP leaf counts and complete validator latest-index sets. Missing validator results become `-1`; recently observed membership remains for 180 seconds. Merkle mismatch reporting latches only an actual proof-root mismatch. Bounded telemetry failures do not grant or deny delivery.

Root app context is resolved before metadata construction: explicit rules take precedence, otherwise an independent 600-second default-ISM cache determines `default_ism` or `Unknown`. Lookup failures propagate even when observation is disabled. Children inherit the root context. EVM forks copy the role clock; native forks use the same raw monotonic epoch as cache lookup. Cache insertion uses successful fetch completion time.

Shared recursion-path state prevents duplicate latest jobs or completed-leaf events during checkpoint, candidate verification, and nested parent replay. Accepted observation jobs own their Source, validators, and context. Rejected jobs release each resource once. Optional latest-only queue, allocation, fork, or storage errors leave exact-quorum validation available.

SVM composite known-validator leaves run through the production native Source and retained builder. Owned cancellation ancestry lets assisted nested jobs observe the original caller's cancellation. Stopping an ancestor detaches its borrowed caller flag; retained children keep ancestor storage alive. Detached latest jobs drop that ancestry and use only the executor's lifetime stop token. Detached latest results and terminal leaf events returned after cancellation are discarded. A completed construction followed by verification rejection still counts as construction success.

Rust MessageId metadata awaits both latest and quorum through `tokio::join!`. Zig latest observation is detached and can finish after metadata returns. This changes critical-path timing. Whole-agent measurements must include its actual CPU/RPC work and shutdown drain; component tests do not establish runtime equivalence. Nested verification replay can still rebuild business metadata; the observation memo does not cache entire metadata computations.

| Validation                                                         |  Passed | Skipped | Failed |
| ------------------------------------------------------------------ | ------: | ------: | -----: |
| Final native EVM preparation root, including metadata replay cases |     402 |      12 |      0 |
| Native metadata root before test listener cleanup                  |     358 |      10 |      0 |
| Actual retained EVM clock and late CCIP callback regressions       |       6 |       0 |      0 |
| Independent central lifetime review tests                          |      16 |       0 |      0 |
| Independent production SVM tests                                   |      22 |       0 |      0 |
| Independent caller-flag poisoning/error-unwind tests               |       7 |       0 |      0 |
| Actual relayer, validator, scraper no-emit compilation             | 3 roles |       0 |      0 |

Counts include imported declaration checks and overlap across roots. The live Anvil preparation opt-in was skipped; its absent flag previously returned an empty passing test and now reports a skip. Optional native SDK, HTTP/2, cloud and regex cases are listed individually in the manifest.

One retained failed EVM run exposed a test listener treating a canceled client's partial HTTP request as fatal. The fixture now closes abandoned streams and continues after EOF/reset; healthy-request counts and zero uncanceled upstream failures remain enforced. The subsequent full run passed.

Evidence: [commands, source pins and lossless logs](../../zig/bench/results/metadata-observability-20261106/manifest.json), [SVM production adapter evidence](../../zig/bench/results/sealevel-metadata-observation/manifest.json), [independent lifetime review](../../zig/bench/results/metadata-lifetime-review-2026-11-06/report.md). These are component gates. Final whole-agent process integration and benchmarking remain separate gates.
