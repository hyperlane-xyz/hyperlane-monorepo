# Independent validator parallel publication review

## High — Reorg halt is not guaranteed durable before restart

**Evidence**

- `zig/src/agents/validator.zig:273-282` (`halt`) and `793-798` (`haltFromBackend`) set the in-memory halt and call `commitSync()` exactly once.
- `zig/src/agents/validator.zig:372-377` (`publishReorg`) only reads/publishes an existing guard. It neither retries the failed guard commit nor reconstructs the pending event.
- `zig/src/agents/validator.zig:80` treats a missing durable `halted` record as not halted on reopen.
- `zig/src/db/rocks.zig:229-230` explicitly says commit errors have uncertain outcomes that callers must resolve before higher-level retry.
- The local object backend has the same operational gap: `zig/src/storage/local.zig:264-275` makes one atomic guard-write attempt; the service does not retry it after an I/O failure.

**Reproduction path**

1. A canonical conflict or backend reorg triggers `halt`/`haltFromBackend`.
2. The guard's fsync/commit fails with an uncertain outcome. Memory remains halted, but the guard may be absent on disk.
3. `publishReorg` either returns an old record or returns without persisting anything when no record exists. It does not retry `halt` or `persistReorg`.
4. The task can exit with the guard unconfirmed. On restart, `Service.open` sees no durable `halted` marker and resumes normal signing/publication.

This can produce a second signature for a conflicting finalized checkpoint, precisely what the durable reorg guard is intended to prevent. It is not merely an availability issue.

**Suggested fix**

Centralize guard persistence in a retry/readback loop, used by both Rocks and object backends. Retain the full pending `ReorgEvent` in memory until `halted` and `reorg` are confirmed durable, and do not allow the worker to exit successfully with an unconfirmed guard. Resolve uncertain commit outcomes by reading back the actual records rather than assuming success or failure. Add a fault-injection test where the first guard commit fails, a later attempt succeeds, and restart proves no second signature. A restart before successful persistence cannot be made safe by `open` alone because absence of a guard is indistinguishable from never having halted; the running process must keep retrying.

## No other ranked findings

The following were checked and appear coherent with the intended architecture:

- Per-index reservations are persisted before batch spawn (`validator.zig:575-602`) and checked on every concurrent signing retry (`628-647`) and serial retry (`612-626`).
- The returned checkpoint is verified against the reservation/history before durable signing state is stored (`698-712`), and signed-prefix conflicts halt rather than overwrite.
- Higher checkpoints can publish while a lower one is blocked. Latest-index ownership belongs to the highest job (`726-753`), while snapshots wait for all markers and all worker callbacks (`549-572`, `764-775`).
- The six attempts retain one signer identity, matching the pinned-singleton model rather than introducing a second credential chain.
- Concurrent calls reject overlap via `publication_running`, and the API explicitly requires joining before lease refresh or adapter/DB release (`521-524`, `535-539`).
- Pool creation/resizing is bounded by the publication limit and 256 KiB stacks (`507-519`, `525-526`). The default path reuses an already adequate pool.
- Local and cloud stores intentionally serialize write/read-modify-write sequences with `writeMutex`; this is not an accidental race. Local objects use file+rename+parent fsync (`storage/local.zig:141-152`).
- `Resources` refreshes pinned signer configuration only between jobs (`validator/config.zig:83-100`), and native parallel capability is restricted to the actual Curl transport (`112-116`). Arbitrary injected transports do not opt in.
- Per-job cancellation pointers are replaced and cleared on task tick exit (`validator_task.zig:98-103`, `114-119`, `128-137`). Signer/HTTP/credential lifetimes are bounded by the joined publication call.
- `Store.writeMutex` serialization, six same-identity attempts, and latest-first publication are deliberate correctness tradeoffs, not claims of maximal speedup.

## Evidence limits

- The current focused suite passed **157 tests with 16 skips**, including the latest-first concurrent/restart test. Those tests do not inject a reorg-guard WAL/fsync failure, so they cannot cover the finding above.
- I found no focused proof for transient KMS failures exhausting all six attempts with the same identity, pool resize/thread-spawn OOM, or reorg injection in the middle of a parallel batch. Source inspection supports those paths, but tests are not proof of their behavior.
- The reported actual AWS SigV4/KMS fixture exercises four concurrent calls; it is not a credential-expiry, cancellation, teardown, or production-failure stress test.
- No cross-process writer race or production network test was performed. Existing tests establish single-process/idempotent behavior only.

## Verification performed

Read-only review of validator service, driver, config/factory, credentials, local/cloud stores, Curl transport, validator task, and Rust `submit.rs`, followed by:

```bash
/tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig test \
  zig/src/validator_concurrent_tests.zig -O ReleaseSafe -lc -lc++ \
  --sysroot /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk -L/usr/lib \
  zig/native/rocks/out-final/libziggy_rocks_abi.a \
  zig/native/rocks/out-final/librocksdb.a \
  zig/native/rocks/out-final/libsnappy.a \
  zig/native/rocks/out-final/liblz4.a \
  zig/native/rocks/out-final/libzstd.a \
  zig/native/rocks/out-final/libz.a \
  zig/native/rocks/out-final/libbz2.a
```

Result: **157 passed, 16 skipped, 0 failed**. No Source files were edited and no production endpoints or keys were used.
