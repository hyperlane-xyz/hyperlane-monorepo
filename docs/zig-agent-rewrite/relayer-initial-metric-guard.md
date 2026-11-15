# Initial relayer metric guard

Commit `baf14145ae` corrected a test-harness assumption exposed immediately after
three actual ISM deliveries. It changed three integration fixtures and added one
pure test file. Normal commit hooks passed; production Zig and Rust code stayed
unchanged.

The original guard required completion samples before the first confirmation.
Zig creates the processed counter and last-processed nonce gauge on the first
`recordProcessed` call. Rust prebinds those two zero-valued children in
`MessageSubmissionMetrics::new`. That startup observability difference remains.
The confirmed-operation counter is lazy in both implementations, so requiring its
early presence was invalid even for Rust.

The revised guard retains missing observations as `None`, with explicit presence
flags. It verifies each expected active ID against the complete wire-derived
message, domains, nonce and submitted `Confirm(SubmittedBySelf)` state. A bounded
pre-confirm transition may wait without changing the original inclusion time.
Missing counters cannot excuse an ID disappearing before its own 600-second
bound, or complete retirement after it. Final telemetry still requires actual
positive samples, exact processed/confirmed counts and an empty confirmation
queue.

| Verification                                 | Result                                                    |
| -------------------------------------------- | --------------------------------------------------------- |
| New pure snapshot/HTTP-boundary cases        | 10/10, owner and independent runs                         |
| Existing stagger/restart/retirement controls | 28/28, owner and independent runs                         |
| Compiled-product hash readback               | 22 unchanged, including 7 native archive inputs           |
| Original 650-file source map                 | 3 existing Python fixtures changed; 1 new pure test added |
| Production compiled inputs                   | Unchanged from build commit `516bdf4290`                  |

The original 650-file map is therefore **not wholly unchanged**. The timed build
products remain the same bytes, while functional acceptance uses the new, pinned
Python harness. The artifact packet includes the four-file commit diff, committed
source snapshots and individual compiled-product hashes.

At **13:28:48 UTC on 2026-11-06**, the captured v2 index-0 run showed three unique
active operations, nonces 0–2, all submitted and in `Confirm(SubmittedBySelf)`.
Submission, submitted-phase and confirmation-queue samples were each 3. The
processed counter, processed-nonce gauge and confirmed-phase sample were absent;
they are recorded as `None`, not zero.

This captures the live early guard during the production 600-second hold. It is
**not final retirement acceptance**. No completed 600-second result, later batch
or crash-recovery result, or performance measurement is included in this packet.

The [correction manifest](../../zig/bench/results/relayer-initial-metric-guard/manifest.json)
contains the parity review, exact commands, independent and owner logs, normal
commit output, input-preservation proof, and the pinned live Prometheus/admin
snapshots. Payloads use deterministic gzip with raw and compressed SHA256 chunk
pairs. The separate
[initial diagnostic](../../zig/bench/results/final-relayer-initial-metric-diagnostic/manifest.json)
retains the failed pre-fix sources and stopped-fixture evidence.
