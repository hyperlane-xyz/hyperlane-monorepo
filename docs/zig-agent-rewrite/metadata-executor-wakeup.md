# Metadata continuation wake-up

A caller could assist the last queued metadata callback while every worker
returned to an empty queue and parked. If that callback suspended, its continuation
was appended without notifying the condition variable. Cancellation remained
queued until another submit or executor shutdown woke a worker. The real Tron
metadata test reproduced this as a retirement timeout after returning valid
threshold metadata.

The suspended branch now signals the existing condition under the same queue
mutex. It adds no worker, poll loop or deadline extension. A deterministic test
uses an initial worker gate, actual caller assistance and a parked-worker barrier,
then checks that the canceled continuation retires before any new submission or
shutdown. Its parked-worker counter is test-only and has no production storage or
instructions. The old implementation fails that test.

Linux verification passes in ReleaseSafe and ReleaseFast: executor 4/4, metadata
369 passed with four optional SDK skips, SVM 394 passed with four optional SDK
skips, and actual validator native/standard recovery 39/39. Counts overlap imported
roots. Both metadata suites include cancellation, retained-fork lifetime and
allocation-failure sweeps. The actual Tron case also passes 100 consecutive Debug
seeds, 9000–9099, with its original two-second retirement assertion intact.

The validator fixture's macOS-only curl path was separately replaced by the
explicit library environment value or platform default. No assertions or native
coverage were removed. HTTP/2/RSA fixtures run afresh for each test binary.

A bounded variant audit checked I/O pool, lane owner, remote checkpoint and socket
command queues; their relevant enqueue transitions already notify their owners.
No additional missing notification was identified.

Exact [commands and results](../../zig/bench/results/metadata-executor-wakeup/manifest.json.gz)
and lossless logs include the failing implementation and the corrected snapshot.
The parent subsequently strengthened a separate metadata-session physical-count
fixture; final combined acceptance belongs to that later source snapshot. These
are correctness results, not benchmarks.
