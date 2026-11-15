# Cooperative reads

`read_replay.Replay` (JSON-RPC over the EVM endpoint Pool) and
`http_replay.Replay` (REST/gRPC over the shared HTTP Runtime) give a retained
read callback one absolute attempt deadline and borrowed cancellation. Every
fetch submits one physical request and waits for it: on a fiber (Supervisor
workers, metadata executor workers) the fiber parks and its worker runs other
fibers; on a thread (lane owners, assisting callers) the thread drives the
session inline. The callback is never replayed, so nothing is journaled,
hashed or cloned, and no read is ever re-issued by the read layer.

```zig
var reads = try Replay.init(allocator, pool, .{ .max_attempt_ms = 120000 });
client.options.exchange = reads.interface();
try reads.beginPass(cancel);
var failure: ?anyerror = null;
defer reads.endPass(failure);
const result = readOnlyWork() catch |err| {
    failure = err;
    return err;
};
```

`endPass(error.PendingReadIo)` (a suspension raised by some other source)
keeps the absolute attempt start; every other result closes the attempt.
Repeated passes never extend the budget. The cancellation pointer is borrowed
only during the pass and is observed by a waiting read. `hasPending()` is
always false; `commitReadSection()` releases the section's quota. Destroy the
Replay before its Pool/Runtime.

`chain_source.Resources` offers the same API through `beginReadPass(cancel)`,
`endReadPass(failure)` and `commitReadSection()`, enabled only by explicit
`Options.cooperative_reads=true`.

Explicit read-only method and route allowlists reject signing and transaction
submission before any request is submitted; JSON-RPC response IDs are
authenticated against the request. Equal before/after header calls are
separate physical transfers. Session pressure waits for a slot within the same
attempt deadline and cancellation.

Each attempt (or committed section) is bounded: `max_entries` physical requests
(counted at submission, failed ones included; the next one fails closed with
`ReadReplayRequestLimit` before it is sent) and `max_cached_bytes` response
bytes (`ReadReplayByteBudgetExceeded`). Response bytes are also reserved from
the optional `shared_budget`, shared across concurrently executing forks
(`ReadReplayGlobalByteBudgetExceeded`). A suspension keeps the counts;
`commitReadSection()` and every other terminal result release them exactly.
Native Pool/Runtime reservations keep their own limits.

Evidence: `src/read_replay_tests.zig` runs sixteen EVM Source lanes on eight
Supervisor fiber workers (eight stall; the eight healthy lanes finish with
exactly three physical RPCs each), plus deadline, cancellation, policy and
Pool-drain cases.
