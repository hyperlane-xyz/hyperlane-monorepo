# Cooperative read continuations

`read_replay.Replay` wraps the actual EVM endpoint Pool strategy. Cache misses
submit a Pool session and return `error.PendingReadIo`; no Supervisor worker
waits for network I/O. Pool owns all request bytes and native cancellation tokens.
The existing blocking `Pool.fetch` uses the same submit/poll/cancel implementation.

```zig
var journal = try Replay.init(allocator, pool, .{ .max_attempt_ms = 120000 });
client.options.exchange = journal.interface();
// At the beginning of every invocation of the retained read callback:
try journal.beginPass(cancel);
var failure: ?anyerror = null;
defer journal.endPass(failure);
const result = readOnlyWork() catch |err| {
    failure = err;
    return err;
};
```

Only `PendingReadIo` preserves the journal. A real success, failure, cancellation
or timeout clears it. Repeated passes do not extend the absolute attempt budget.
The callback's cancellation pointer is borrowed only during that pass. Destroy
Replay before Pool; cancel/join all callback workers before either destruction.

`chain_source.Resources` offers the same API through `beginReadPass(cancel)`,
`endReadPass(failure)`, and `commitReadSection()`, enabled only by explicit
`Options.cooperative_reads=true`. It currently supports read-only EVM Resources.
The default is false. `Options.direct_native_transport` and injected exchanges
are incompatible with this option. `provider.Options.async_pool` exposes the
borrowed Pool for independently owned metadata read continuations.

Requests are keyed by decoded JSON structure with sorted object keys, exact
number text, all envelope fields except the correlation ID, and a per-key
occurrence. Correlation IDs are authenticated against the original physical
request before substitution on replay. Large integers are never passed through
floating point. Equal before/after header calls occupy separate occurrences and
cause separate network transfers. Explicit read-only method allowlists reject
signing and transaction submission. Entries and cached wire bytes have explicit
limits; session pressure yields within the same attempt deadline.

A whole mutating callback cannot be replayed safely without controller staging.
After durable progress changes its path, old same-key observations could refer
to a preceding read section. `commitReadSection()` clears verified observations
while preserving the absolute deadline, and refuses outstanding native work.
Call it only after advancing a controller stage such that the preceding section
will not execute on resume. An automatic commit after every Source vtable call
would livelock a callback that repeats `header()` before a pending `events()`.
Database, signing and publishing operations never belong in the journal.

Evidence:

```
HYPERLANE_CURL_LIBRARY=/usr/lib/libcurl.4.dylib \
  zig test src/read_replay_tests.zig -lc --test-filter cooperative
```

Native loopback tests run sixteen actual EVM Source/provider lanes through eight
Supervisor workers: the first eight stall, while all eight healthy lanes finish
header/events/fresh-header at height16, exactly three physical RPCs each. Other
cases cover changed canonical header rejection, original-ID validation, exact
large numbers, forbidden writes, stale/cancelled Pool handles and repeated-pass
absolute deadlines. This proves the read-level continuation mechanism. It does
not establish whole-role durable cursor integration or the later shared I/O
owner architecture; per-Resources Pool threads remain in this phase.

`Config.shared_budget:?*ByteBudget` optionally bounds retained wire payloads
across concurrently executing forks, with a mutex and explicit reservations.
Keep the caller-owned budget alive through every journal's destruction. Local
and global limits both apply; rejection fails closed with
`ReadReplayGlobalByteBudgetExceeded`, and success/failure/reset/deinit release
exact ownership. This quota excludes decoder temporary memory and native Pool
reservations, which require their own limits. `Options.pool_observer` follows
real submitted sessions, including scoped operation attribution and retained
observer lifetime after cancellation; replay hits emit no physical metrics.
