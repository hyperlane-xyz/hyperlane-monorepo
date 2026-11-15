# Announcement replay ownership

Commit `57710ae0244a1bbbdb9b18bbb9d31700f84a7882` fixes concurrent announcement discovery sharing one mutable replay journal. The failed d51-v12 relayer aborted in `Replay.exchange` during batch preparation. Its initial 600-second stage and stopped readback had passed; the full process proof failed.

`Registry.ensureValidators` and `maintain` could advance the same provider concurrently. A competing `beginPass` failure still called `endPass`, resetting the first callback's journal. Frame references kept the frame alive but did not serialize its provider. Cancellation could also detach a frame whose final release reset that provider after a replacement frame began.

The Registry now grants one nonblocking progression owner through final frame release and provider cleanup. Contenders yield `PendingReadIo`; cancellation signals the stable frame token. Result fences recheck the borrowed caller flag and original absolute discovery deadline before installing locations. The change preserves the read-only boundary, freshness, byte limits and original timeout budget.

| Evidence                             | ReleaseSafe                                    | ReleaseFast | Scope                                          |
| ------------------------------------ | ---------------------------------------------- | ----------- | ---------------------------------------------- |
| Old production regression            | 3 failed; 10 import roots passed               | Not run     | Actual Registry → Factory → Resources → Replay |
| Final ownership and result fences    | 5 substantive controls passed; 10 import roots | Same        | 15/15 each, zero skipped                       |
| Existing Registry regressions        | 3 substantive controls passed; 42 import roots | Same        | 45/45 each, zero skipped                       |
| Independent review and variant audit | No scoped blocker                              | Same source | Read-only review; no reviewer test execution   |

The five new controls exercise concurrent ensure, maintenance overlap, cancelled-frame cleanup and replacement, caller cancellation after a real provider result, and expiry after a real provider result. They require clean retry, fresh zero-TTL reads and budget release. The existing controls retain cache/reorg behavior, cooperative cancellation and allocation ownership. Imported roots overlap; raw totals are not unique coverage counts.

The deterministic old-code failures reproduce the violated ownership invariant, not the identical daemon `SIGABRT`. Its optimized stack does not identify the internal inlined assertion. One intermediate candidate recorded a retry timeout. Pre-header EOF was a source-based explanation, not an observed `server.failure` value. The final test waits for a complete native HTTP request before cancellation while retaining the provider/reset handoff race. A separate filter attempt ran only one anonymous root and receives no substantive credit. All diagnostics remain preserved.

The [manifest](../../zig/bench/results/announcement-replay-ownership/manifest.json) and [verification](../../zig/bench/results/announcement-replay-ownership/archive-verification.json) seal the failed stack, exact before/final source, commands, owner wait results, reviews and 31 variant-audit snapshots. All four committed blobs match the focused-test snapshot. Root reported normal hooks and session 81406 joining successfully; the archive does not invent a separate hook or OS-wait observation.

Every gzip payload was decompressed and rehashed against its original. Private configurations, keys, databases, WALs, signed transaction traces, executables and caches are excluded. These component results grant no new role-build, full-suite, native-family, daemon lifecycle or performance acceptance; those gates follow separately.
