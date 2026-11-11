//! PostgreSQL access equivalent to `src/db/db.service.ts` on node-pg.
//!
//! * `Pool`: blocking libpq connections (pg-pool semantics: max/min, FIFO
//!   waiters, idle timeout, optional connect timeout, query + statement
//!   timeouts). Used directly by diagnostics (`openDiagnostics`).
//! * `DbService`: the TS `DbService` (main/replica + live pools, metrics,
//!   slow/failed query logging, stats timer, startup schema checks, `listen`).
//! * `Listener`: dedicated LISTEN connection on its own thread.
//!
//! Rows are `core.json.Value` objects converted exactly like node-pg with the
//! TS type-parser overrides (see `convert.zig`). Parameters are JS-like
//! values (`core.json.Value`) serialized like node-pg `prepareValue`.
const std = @import("std");
const core = @import("core");

pub const convert = @import("convert.zig");
pub const pq = @import("pq.zig");
pub const pool = @import("pool.zig");
pub const service = @import("service.zig");
pub const listener = @import("listener.zig");

pub const Value = core.json.Value;

/// Query parameters: node-pg `prepareValue` over JS values — null -> NULL,
/// number -> `String(n)`, bool -> 'true'/'false', string -> itself, array ->
/// postgres array literal (elements quoted/escaped like node-pg), object ->
/// `JSON.stringify`. `.raw` is sent as its text.
pub const Param = Value;

/// Error details for a failed query/connect (node-pg `error.message` etc.).
/// Strings are allocated in the caller's arena.
pub const Failure = struct {
    /// `error.message` as node-pg reports it, e.g. `relation "x" does not
    /// exist`, `Query read timeout`, `Connection terminated due to connection timeout`.
    message: []const u8 = "",
    /// SQLSTATE for server errors (`error.code`), e.g. "57014".
    code: ?[]const u8 = null,
};

pub const Error = error{
    /// Server reported an error (see `Failure.message`/`code`).
    QueryFailed,
    /// Client-side `query_timeout` elapsed (node-pg "Query read timeout").
    QueryTimeout,
    /// Could not connect, connect timeout, or the connection broke mid-query.
    ConnectionFailed,
    /// The pool/service has been closed.
    PoolClosed,
    OutOfMemory,
};

pub const Result = struct {
    /// One `.object` per row; keys are column names in column order
    /// (duplicate names: last value wins at the first position, like node-pg).
    rows: []Value,
    /// node-pg `rowCount` (command tag count; null tag -> 0).
    row_count: usize,
};

pub const Pool = pool.Pool;
pub const PoolOptions = pool.Options;
pub const ConnOptions = pq.ConnOptions;
pub const DbService = service.DbService;
pub const Listener = listener.Listener;
pub const NotificationHandler = listener.Handler;

test {
    std.testing.refAllDecls(@This());
    std.testing.refAllDeclsRecursive(convert);
    std.testing.refAllDeclsRecursive(pq);
    std.testing.refAllDeclsRecursive(pool);
    std.testing.refAllDeclsRecursive(service);
    std.testing.refAllDeclsRecursive(listener);
    _ = @import("tests.zig");
}
