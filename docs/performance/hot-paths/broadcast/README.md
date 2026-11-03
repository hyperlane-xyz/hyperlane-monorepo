# Indexing broadcast measurements

Actual production source is loaded with `git show`; only the unit-test suffix is omitted. The production `IndexingNotification` type and its real `H512` dependency are used unchanged. Baseline `7e80c603f0`; revision `64c9c07b5d`.

| Runtime | Workload / metric                 |   Before p50 / p95 ms |    After p50 / p95 ms |
| ------- | --------------------------------- | --------------------: | --------------------: |
| 1       | uniform_1 / elapsed_ms            |   1.132146 / 2.535375 |   0.849958 / 1.047834 |
| 1       | uniform_3 / elapsed_ms            |   2.272208 / 2.346583 |   1.649292 / 1.711583 |
| 1       | notifications_3 / elapsed_ms      |   3.941959 / 4.025916 |   3.347667 / 3.526042 |
| 1       | slow_consumer / elapsed_ms        | 30.677438 / 36.420792 | 31.405667 / 36.629083 |
| 1       | slow_consumer / ready_delivery_ms | 30.666063 / 36.407250 |   0.012375 / 0.019209 |
| 1       | slow_consumer / registration_ms   | 26.460188 / 32.072042 |   0.013083 / 0.020291 |
| 2       | uniform_1 / elapsed_ms            |   1.764458 / 3.212583 |   1.812375 / 1.873458 |
| 2       | uniform_3 / elapsed_ms            |   3.889396 / 3.936584 |   2.915562 / 2.979541 |
| 2       | notifications_3 / elapsed_ms      |   6.093667 / 6.483542 |   5.820042 / 5.979791 |
| 2       | slow_consumer / elapsed_ms        | 31.148187 / 35.663708 | 31.231833 / 36.620875 |
| 2       | slow_consumer / ready_delivery_ms | 31.111125 / 35.630458 |   0.027312 / 0.061250 |
| 2       | slow_consumer / registration_ms   | 27.040979 / 31.091458 |   0.034875 / 0.065250 |

`uniform_1`/`uniform_3`: 20,000 u64 messages, 1/3 subscribers, channel capacity 128. `notifications_3`: 20,000 notifications, three subscribers, each notification contains H512 plus a one-element sequence vector. Payload creation and receiver verification are common timed work. `slow_consumer`: capacity 1, prefilled first subscriber held for 25 ms; registration starts 2 ms after the second broadcast is spawned. Wall-clock timers include OS scheduling; measured waits need not equal configured delay.

Five warmups and 30 measured batches in each of two passes per version/case/runtime (60 samples/version). AB then BA process order; one timed process at a time. Runtime 1 is current-thread; runtime 2 has two Tokio workers. p50 is the sample median; p95 uses nearest rank. Throughput is total deliveries divided by summed elapsed time. Per-process CPU/RSS includes startup, fixtures, warmups and output; not isolated function cost. Raw samples and process envelopes: [results.json](results.json).

The first actor had a scheduler round trip per send: the 2-worker single-subscriber p50 regressed ~86x. [initial-actor.json](initial-actor.json) preserves that separate run; it predates the production-payload case. The revision uses immutable actor-published snapshots with caller-owned delivery and ordered admission. Ready delivery/registration improve under a full subscriber; full-send backpressure remains. The 2-worker single-subscriber control remains ~2.7% slower at p50.

## Reproduce

macOS, Rust 1.88, dependencies cached; full opt-level-3 release build including dependencies. Standalone dependency lockfile: [Cargo.lock.gz](Cargo.lock.gz). Source/lockfile/executable Base64 SHA-256 digests are in metadata. Build directory is task-owned scratch, not a git worktree.

```sh
python3 docs/performance/hot-paths/broadcast/run.py --build-dir /tmp/hotpath-broadcast --build-only
# Wait for all builds and other benchmark processes to finish.
python3 docs/performance/hot-paths/broadcast/run.py --build-dir /tmp/hotpath-broadcast --measure-only --output /tmp/hotpath-broadcast-results.json
```

The runner does not edit production source. Both git snapshots compile in one executable using shared unchanged core/dependency types. `--baseline`/`--proposed` select revisions. To exercise the initial actor with this harness, use `--proposed d555ffbfd7d82438851e6f848ea7dfc28b2e336d`. The original initial run predates the notification case; its recorded harness/source hashes remain separate.
