# libpq deadlines and outcome handling

`Connection.connectWithOptions(allocator, conninfo, diagnostic, IoOptions)` uses
nonblocking `PQconnectStart[Params]`/`PQconnectPoll`. Queries use
`PQsendQueryParams`, `PQflush`, `PQconsumeInput`, `PQisBusy` and `PQgetResult`.
Every socket wait checks an absolute monotonic deadline and cancellation at
most 25 ms apart. Server `statement_timeout` remains useful but is not the
client's deadline mechanism.

`IoOptions{timeout_ms=30000, deadline_ns:?u64, cancel:?*atomicBool, resolver:?*curl.Client,
allow_blocking_dns=false}` also lives in `connection.io`. Set its deadline and
cancel token for each entire worker job, before the first statement; reset them
before returning a connection to a pool. `postgres.nowNs()` supplies the
monotonic clock. Per-statement timeout and whole-job deadline both apply.
Connections and tokens are exclusively owned by one job; their lifetimes extend
through native completion or connection teardown.

A timeout, cancellation or transport failure after submission closes/poisons
the connection. Its server outcome may be unknown. Never recycle that connection
or replay a write based only on the transport error. A lost COMMIT response
returns `CommitOutcomeUnknown` and closes the transaction handle without
attempting a misleading rollback. Reconnect and reconcile durable operation
identity before a retry. Ordinary completed SQL errors are fully drained and
leave a reusable connection (or an aborted transaction needing rollback).
Unsupported COPY mode is closed and poisoned rather than left partially drained.

## DNS and TLS identity

libpq explicitly documents that hostname lookup can block even in its
nonblocking connector. Strict default therefore requires a numeric host,
explicit numeric `hostaddr`, Unix socket, or an explicit native resolver.
The resolver uses libcurl's vetted asynchronous DNS and CONNECT_ONLY plain TCP
mode, with proxies disabled, no redirects, a fresh connection and immediate
close. It sends no HTTP or PostgreSQL application bytes and places no password
in its URL. It obtains only a numeric target IP.

`PQconnectStartParams` expands the original conninfo unchanged and overrides
only `hostaddr`. Original `host`, credentials and `sslmode` remain available to
libpq, preserving `verify-full` certificate identity and authentication rules.
One absolute budget covers DNS preconnect, actual TCP/TLS/authentication and any
subsequent statements using the same deadline.

An unresolved hostname introduces one extra successful TCP connection per
connect attempt, plus any failed address attempts chosen by libcurl. These are
TCP connection attempts, not HTTP/RPC requests or SQL statements; include them
in connection-load benchmarks. Numeric hosts/hostaddrs and Unix sockets incur
no preconnect. Explicit multi-host numeric/hostaddr configurations retain
libpq's fallback; unresolved multi-host DNS is rejected explicitly instead of
collapsing several candidates to one IP. Service-file/implicit-host discovery
cannot receive the strict guarantee. `allow_blocking_dns=true` is an explicit
legacy opt-in and must not be described as a bounded resolver.

Primary contracts: [libpq asynchronous commands](https://www.postgresql.org/docs/current/libpq-async.html),
[nonblocking connect and hostaddr](https://www.postgresql.org/docs/current/libpq-connect.html).

## Native fixtures

`zig/integration/postgres.py` creates a guarded disposable PostgreSQL 16,
applies all 21 production migrations and removes the container afterward.
Tests disable server statement timeout and bound a five-second `pg_sleep` with
an 80-ms client deadline; validate precancellation and SQL-error draining; stall
authentication; and transparently proxy COMMIT, discard its successful response,
then verify the row committed exactly once despite `CommitOutcomeUnknown`.
Resolver tests use localhost with a native libcurl pointer; a separate native
TCP fixture verifies that the preconnect sends zero application bytes.

## Exclusive worker pool

`db/pool.zig` owns copied conninfo and up to 64 lazy native sessions (default 5).
`Pool.init(allocator,conninfo,Config)!*Pool`; `acquire(IoOptions)!Lease` bounds
pool wait, DNS/connect, and subsequent statements by the same absolute deadline.
`lease.connection()` and `lease.diagnostic()` belong exclusively to that job;
`lease.deinit()` releases the slot. Never copy live leases or retain pointers
past release. Join all jobs before pool destruction; use a thread-safe allocator.

`Config.session_timeout_ms` optionally installs immutable statement/lock timeout
defaults once on each new or recovered connection, before publishing its exclusive
lease. Failure closes that partially configured session. The scraper TaskSet sets
this to its configured database timeout; `Pooled` rejects conflicting defaults.
This removes per-lease timeout-setting SQL without changing the client job deadline
or cancellation checks. Pools leaving this option unset keep explicit per-use
configuration. Callers must not mutate these session defaults between leases.

Only healthy, fully drained, idle sessions return to the pool. Poisoned sessions,
active/aborted transactions, and explicitly invalidated leases close immediately;
the next job reconnects. Job cancellation pointers and absolute deadlines clear
before idle reuse. SQL errors that drained cleanly can reuse an idle session.
There is no query replay, including COMMIT. Callers reconcile by durable event,
transaction and cursor identities after `CommitOutcomeUnknown`.

`scraper.service.Pooled` holds scraper state across jobs while acquiring and
binding one fresh exclusive lease for each `headCycle(IoOptions)`. Its
`auxiliary(IoOptions)` leases a separate connection for delivery/gas/reconciliation
jobs. Source clients remain one serial owner per chain; auxiliary RPC jobs use
separate clients. A failed head job clears count caches, and the next scheduled
cycle observes durable database frontiers before progressing. Native fixtures
verify saturated wait/cancel, backend reuse, deadline poisoning, reconnect, and
rollback by discarding accidentally unreleased active transactions.
