//! One libpq connection driven through the nonblocking API with poll()
//! deadlines, so connect and query timeouts are enforced in milliseconds.
//! A `Conn` has a single owner at a time (pool checkout or listener thread).
const std = @import("std");
const builtin = @import("builtin");
const core = @import("core");
const root = @import("root.zig");
const convert = @import("convert.zig");

const Value = core.json.Value;
const Failure = root.Failure;
const Error = root.Error;

pub const PGconn = opaque {};
pub const PGresult = opaque {};
pub const PGnotify = extern struct {
    relname: [*:0]u8,
    be_pid: c_int,
    extra: [*:0]u8,
    next: ?*PGnotify,
};
const ConninfoOption = extern struct {
    keyword: ?[*:0]const u8,
    envvar: ?[*:0]const u8,
    compiled: ?[*:0]const u8,
    val: ?[*:0]const u8,
    label: ?[*:0]const u8,
    dispchar: ?[*:0]const u8,
    dispsize: c_int,
};
const NoticeReceiver = *const fn (?*anyopaque, *const PGresult) callconv(.c) void;

extern "pq" fn PQconnectStartParams(keywords: [*]const ?[*:0]const u8, values: [*]const ?[*:0]const u8, expand_dbname: c_int) ?*PGconn;
extern "pq" fn PQconnectPoll(conn: *PGconn) c_int;
extern "pq" fn PQconninfoParse(conninfo: [*:0]const u8, errmsg: *?[*:0]u8) ?[*]ConninfoOption;
extern "pq" fn PQconninfoFree(options: [*]ConninfoOption) void;
extern "pq" fn PQfreemem(ptr: *anyopaque) void;
extern "pq" fn PQstatus(conn: *const PGconn) c_int;
extern "pq" fn PQerrorMessage(conn: *const PGconn) [*:0]const u8;
extern "pq" fn PQsetnonblocking(conn: *PGconn, arg: c_int) c_int;
extern "pq" fn PQsocket(conn: *const PGconn) c_int;
extern "pq" fn PQfinish(conn: *PGconn) void;
extern "pq" fn PQsendQuery(conn: *PGconn, command: [*:0]const u8) c_int;
extern "pq" fn PQsendQueryParams(conn: *PGconn, command: [*:0]const u8, n: c_int, types: ?[*]const c_uint, values: ?[*]const ?[*:0]const u8, lengths: ?[*]const c_int, formats: ?[*]const c_int, result_format: c_int) c_int;
extern "pq" fn PQsendPrepare(conn: *PGconn, name: [*:0]const u8, query: [*:0]const u8, n: c_int, types: ?[*]const c_uint) c_int;
extern "pq" fn PQsendQueryPrepared(conn: *PGconn, name: [*:0]const u8, n: c_int, values: ?[*]const ?[*:0]const u8, lengths: ?[*]const c_int, formats: ?[*]const c_int, result_format: c_int) c_int;
extern "pq" fn PQenterPipelineMode(conn: *PGconn) c_int;
extern "pq" fn PQexitPipelineMode(conn: *PGconn) c_int;
extern "pq" fn PQpipelineSync(conn: *PGconn) c_int;
extern "pq" fn PQflush(conn: *PGconn) c_int;
extern "pq" fn PQsslInUse(conn: *PGconn) c_int;
extern "pq" fn PQsslStruct(conn: *PGconn, name: [*:0]const u8) ?*anyopaque;
extern "pq" fn PQconsumeInput(conn: *PGconn) c_int;
extern "pq" fn PQisBusy(conn: *PGconn) c_int;
extern "pq" fn PQgetResult(conn: *PGconn) ?*PGresult;
extern "pq" fn PQresultStatus(res: *const PGresult) c_int;
extern "pq" fn PQresultErrorField(res: *const PGresult, field: c_int) ?[*:0]const u8;
extern "pq" fn PQntuples(res: *const PGresult) c_int;
extern "pq" fn PQnfields(res: *const PGresult) c_int;
extern "pq" fn PQfname(res: *const PGresult, col: c_int) [*:0]const u8;
extern "pq" fn PQftype(res: *const PGresult, col: c_int) c_uint;
extern "pq" fn PQgetisnull(res: *const PGresult, row: c_int, col: c_int) c_int;
extern "pq" fn PQgetlength(res: *const PGresult, row: c_int, col: c_int) c_int;
extern "pq" fn PQgetvalue(res: *const PGresult, row: c_int, col: c_int) [*]const u8;
extern "pq" fn PQcmdTuples(res: *PGresult) [*:0]const u8;
extern "pq" fn PQclear(res: *PGresult) void;
extern "pq" fn PQnotifies(conn: *PGconn) ?*PGnotify;
extern "pq" fn PQsetNoticeReceiver(conn: *PGconn, proc: NoticeReceiver, arg: ?*anyopaque) ?NoticeReceiver;

const CONNECTION_OK = 0;
const PGRES_POLLING_FAILED = 0;
const PGRES_POLLING_READING = 1;
const PGRES_POLLING_WRITING = 2;
const PGRES_POLLING_OK = 3;
const PGRES_EMPTY_QUERY = 0;
const PGRES_COMMAND_OK = 1;
const PGRES_TUPLES_OK = 2;
const PGRES_FATAL_ERROR = 7;
const PGRES_PIPELINE_SYNC = 10;
const PG_DIAG_SQLSTATE: c_int = 'C';
const PG_DIAG_MESSAGE_PRIMARY: c_int = 'M';

pub const ConnOptions = struct {
    /// libpq connection string (URI or key=value). Note: libpq URI semantics
    /// (sslmode etc.) apply instead of pg-connection-string's.
    conninfo: []const u8,
    /// node-pg `connectionTimeoutMillis` (null/0 = wait forever).
    connect_timeout_ms: ?u64 = null,
    /// node-pg `query_timeout` (client side).
    query_timeout_ms: ?u64 = null,
    /// node-pg `statement_timeout` (sent as a startup option).
    statement_timeout_ms: ?u64 = null,
    /// Extra startup `options` (e.g. `-c default_transaction_read_only=on`),
    /// appended to any `options` in `conninfo`.
    options: ?[]const u8 = null,
};

/// How a parameterised statement is sent and planned.
pub const Plan = enum {
    /// node-pg's unnamed statement: parsed and planned on every execution.
    unnamed,
    /// Per-connection named statement, still planned for its actual values on
    /// every execution (`plan_cache_mode=force_custom_plan`), so the plan is
    /// node-pg's; saves parse/analyze/rewrite and resending the SQL text.
    custom,
    /// Named statement PostgreSQL may switch to a generic plan after its five
    /// custom plans (`plan_cache_mode=auto`), skipping planning. Only for
    /// shapes whose generic plan cannot be worse (unique-key lookups, fixed
    /// SQL); generic plans for list shapes are up to 47x slower.
    reusable,
    /// node-pg's unnamed statement, planned with the join order fixed
    /// (`set_config('join_collapse_limit', '1', true)`, i.e. SET LOCAL,
    /// pipelined before the execute:
    /// one implicit transaction up to the Sync, so the setting never
    /// outlives the statement and no other statement, session or pooled
    /// backend sees it). Only for selects whose rows no plan can change and
    /// whose fixed-order plan is never slower (scraperdb `Sql.fixed_join`).
    fixed_join,
    /// node-pg's unnamed statement, planned without parallel workers
    /// (`max_parallel_workers_per_gather` 0, set like `fixed_join`).
    /// Only for statements whose parallel plan only adds worker start-up
    /// and whose result order no plan can change beyond what the parallel
    /// plan already leaves unspecified (scraperdb's confirmation
    /// projection).
    serial,
};

pub const QueryOptions = struct {
    plan: Plan = .unnamed,
    /// Pool-wide switch that turns named statements off (set by `Pool`).
    guard: ?*ReuseGuard = null,
    /// Keep the result as libpq's PGresult (`Result.lazy`, see `LazyRows`)
    /// instead of converting rows.
    lazy: bool = false,
};

/// A query result kept as libpq's PGresult instead of converted rows, so a
/// caller can write simple columns straight from libpq's text
/// (`writeCell`) or convert exactly as `query` would (`materialize`). The
/// owner must call `deinit` (PQclear) once done; nothing else frees it.
pub const LazyRows = struct {
    res: *PGresult,
    columns: []const Column,
    rows: usize,
    row_count: usize,

    pub const Column = struct {
        name: []const u8,
        oid: u32,
        kind: Kind,
    };

    /// Columns whose cells are written straight from libpq's text with the
    /// bytes `json.stringify(convertCell(...))` produces. `none`: convert.
    pub const Kind = enum { number, string, boolean, none };

    /// int2/int4 (a JS number), int8/numeric (strings in node-pg), bool,
    /// text/varchar/bpchar. Floats, json/jsonb, bytea, date/time types,
    /// arrays and everything else keep `convertCell`.
    pub fn kindOf(oid: u32) Kind {
        return switch (oid) {
            21, 23 => .number,
            20, 1700, 25, 1043, 1042 => .string,
            16 => .boolean,
            else => .none,
        };
    }

    fn init(arena: std.mem.Allocator, res: *PGresult) Error!LazyRows {
        const n_cols: usize = @intCast(PQnfields(res));
        const columns = try arena.alloc(Column, n_cols);
        for (columns, 0..) |*c, i| {
            const oid = PQftype(res, @intCast(i));
            c.* = .{ .name = try arena.dupe(u8, std.mem.span(PQfname(res, @intCast(i)))), .oid = oid, .kind = kindOf(oid) };
        }
        return .{ .res = res, .columns = columns, .rows = @intCast(PQntuples(res)), .row_count = rowCount(res) };
    }

    /// The column whose value a row object holds under `name`: the last one
    /// of that name (node-pg: duplicates keep the first position, last value).
    pub fn column(self: *const LazyRows, name: []const u8) ?usize {
        var i = self.columns.len;
        while (i > 0) {
            i -= 1;
            if (std.mem.eql(u8, self.columns[i].name, name)) return i;
        }
        return null;
    }

    /// Cell text as libpq holds it (valid until `deinit`); null for NULL.
    pub fn cell(self: *const LazyRows, row: usize, col: usize) ?[]const u8 {
        const r: c_int = @intCast(row);
        const c: c_int = @intCast(col);
        const len = PQgetlength(self.res, r, c);
        if (len == 0 and PQgetisnull(self.res, r, c) != 0) return null;
        return PQgetvalue(self.res, r, c)[0..@intCast(len)];
    }

    /// Writes cell (`row`, `col`) as JSON, byte-identical to
    /// `json.stringify(convertCell(oid, text))` (NULL: `null`). Columns of
    /// kind `none` go through `convertCell` (allocating in `arena`).
    pub fn writeCell(self: *const LazyRows, w: *std.Io.Writer, arena: std.mem.Allocator, row: usize, col: usize) (std.Io.Writer.Error || std.mem.Allocator.Error)!void {
        const text = self.cell(row, col) orelse return w.writeAll("null");
        return writeText(w, arena, self.columns[col].oid, text);
    }

    /// `writeCell` for a non-NULL cell's text of column type `oid`.
    pub fn writeText(w: *std.Io.Writer, arena: std.mem.Allocator, oid: u32, text: []const u8) (std.Io.Writer.Error || std.mem.Allocator.Error)!void {
        const kind = kindOf(oid);
        if (kind != .none) return writeFast(w, kind, text);
        // Stringified at once: the value may alias `text` (no copy).
        try core.json.stringify(w, try convert.convertCell(arena, oid, text, .borrow));
    }

    /// A non-NULL cell of a fast `kind` (not `.none`), without allocating:
    /// the bytes `json.stringify(convertCell(oid, text))` gives for that kind.
    pub fn writeFast(w: *std.Io.Writer, kind: Kind, text: []const u8) std.Io.Writer.Error!void {
        switch (kind) {
            // PostgreSQL's own output is canonical and JS prints it back
            // unchanged; anything else (never seen) is formatted like convertCell.
            .number => if (canonicalInt(text)) try core.json.writeShort(w, text) else try core.json.writeNumber(w, convert.fastInt(text)),
            .string => try core.json.writeString(w, text),
            .boolean => try core.json.writeShort(w, if (convert.fastBool(text)) "true" else "false"),
            .none => unreachable,
        }
    }

    /// Exactly the rows `query` returns for this result (`convertRows`).
    pub fn materialize(self: *const LazyRows, arena: std.mem.Allocator) std.mem.Allocator.Error![]Value {
        return convertRows(arena, self.res);
    }

    pub fn deinit(self: *LazyRows) void {
        PQclear(self.res);
        self.* = undefined;
    }
};

/// PostgreSQL's int2/int4 output, which JS prints back unchanged: an
/// optional '-', then "0" or a digit run without a leading zero ("-0" never
/// occurs; anything else takes the converting path).
fn canonicalInt(text: []const u8) bool {
    const digits = if (text.len > 0 and text[0] == '-') text[1..] else text;
    if (digits.len == 0 or digits.len > 10) return false;
    if (digits[0] == '0') return digits.len == 1 and text.len == 1;
    for (digits) |d| if (d < '0' or d > '9') return false;
    return true;
}

/// The session's `plan_cache_mode` as far as this connection knows: set to
/// `force_custom_plan` at startup, switched (pipelined with the execute)
/// only when a statement needs the other mode.
const PlanMode = enum { custom, auto, unknown };

/// The transaction-scoped planner setting a statement class pipelines
/// before its execute (`Plan.fixed_join`, `Plan.serial`). `set_config(…,
/// true)` is SET LOCAL without its "only in transaction blocks" WARNING:
/// a pipeline's implicit transaction (up to its Sync) is not a block, yet
/// it is the transaction the setting lasts for.
fn tuneSql(plan: Plan) ?[*:0]const u8 {
    return switch (plan) {
        .fixed_join => "SELECT set_config('join_collapse_limit', '1', true)",
        .serial => "SELECT set_config('max_parallel_workers_per_gather', '0', true)",
        .unnamed, .custom, .reusable => null,
    };
}

/// Turns named statements off for a whole pool once the server behaves like
/// a transaction pooler sits in front of it (statements vanish or collide
/// between executions). Each such failure is retried unnamed; reuse is
/// disabled permanently at a name collision (42P05) or at a second missing
/// statement (26000) within `window_ms`, with one warning.
pub const ReuseGuard = struct {
    pub const window_ms = 60_000;
    disabled: std.atomic.Value(bool) = .init(false),
    last_missing_ms: std.atomic.Value(i64) = .init(0),

    pub fn active(self: *const ReuseGuard) bool {
        return !self.disabled.load(.monotonic);
    }

    fn report(self: *ReuseGuard, code: []const u8) void {
        const disable = if (std.mem.eql(u8, code, STATEMENT_MISSING)) blk: {
            const now = nowMs();
            const previous = self.last_missing_ms.swap(now, .monotonic);
            break :blk previous != 0 and now - previous <= window_ms;
        } else true;
        if (disable and !self.disabled.swap(true, .monotonic)) {
            core.log.child("DbService").warn("prepared statements disabled for this pool after SQLSTATE {s} (transaction pooler?); queries run as unnamed statements", .{code});
        }
    }
};

/// Named statements of one connection, bounded because each holds its query
/// tree and generic plan in the backend (measured: 0.17 MB for the
/// confirmation snapshot, 0.57 MB for a message_view lookup, 1.9 MB for a
/// confirmation projection), so at most ~15 MB per connection.
///
/// A statement costs one extra round trip (Parse) and pays off only after
/// PostgreSQL's five custom plans, so churn must never make the connection
/// slower than node-pg's unnamed statements: a text is prepared on its second
/// sighting (one-off shapes run unnamed), and a full cache evicts only an
/// entry idle for `stale_after` reusable queries (otherwise the newcomer runs
/// unnamed instead of thrashing DEALLOCATE/Parse).
const Statements = struct {
    const capacity = 8;
    const stale_after = 64;
    const seen_capacity = 32;
    entries: [capacity]Entry = undefined,
    len: usize = 0,
    /// Counts reusable queries on this connection (recency clock).
    tick: u64 = 0,
    next_id: u64 = 0,
    /// Hashes of texts seen once and not prepared (ring).
    seen: [seen_capacity]u64 = @splat(0),
    seen_next: usize = 0,

    const Entry = struct {
        hash: u64,
        sql: []u8,
        name: [24]u8,
        name_len: usize,
        last_use: u64,

        fn nameZ(self: *const Entry) [*:0]const u8 {
            return @ptrCast(self.name[0..self.name_len :0].ptr);
        }
    };

    const Decision = union(enum) {
        hit: *Entry,
        unnamed,
        /// Prepare a new entry, first deallocating `evict` if set.
        prepare: ?*Entry,
    };

    fn decide(self: *Statements, sql: []const u8) Decision {
        self.tick += 1;
        const hash = hashOf(sql);
        for (self.entries[0..self.len]) |*e| {
            if (e.hash == hash and std.mem.eql(u8, e.sql, sql)) {
                e.last_use = self.tick;
                return .{ .hit = e };
            }
        }
        const seen_before = std.mem.indexOfScalar(u64, &self.seen, hash) != null;
        if (!seen_before) {
            self.seen[self.seen_next] = hash;
            self.seen_next = (self.seen_next + 1) % seen_capacity;
            return .unnamed;
        }
        if (self.len < capacity) return .{ .prepare = null };
        var oldest = &self.entries[0];
        for (self.entries[1..self.len]) |*e| if (e.last_use < oldest.last_use) {
            oldest = e;
        };
        if (self.tick - oldest.last_use < stale_after) return .unnamed;
        return .{ .prepare = oldest };
    }

    fn hashOf(sql: []const u8) u64 {
        // 0 marks an empty `seen` slot.
        return std.hash.Wyhash.hash(0, sql) | 1;
    }

    fn remove(self: *Statements, entry: *Entry) void {
        std.heap.c_allocator.free(entry.sql);
        const last = &self.entries[self.len - 1];
        if (entry != last) entry.* = last.*;
        self.len -= 1;
    }

    fn add(self: *Statements, sql: []const u8) error{OutOfMemory}!*Entry {
        std.debug.assert(self.len < capacity);
        const copy = try std.heap.c_allocator.dupe(u8, sql);
        self.next_id += 1;
        const e = &self.entries[self.len];
        e.* = .{ .hash = hashOf(sql), .sql = copy, .name = undefined, .name_len = 0, .last_use = self.tick };
        e.name_len = (std.fmt.bufPrintZ(&e.name, "sp_{d}", .{self.next_id}) catch unreachable).len;
        self.len += 1;
        return e;
    }

    fn deinit(self: *Statements) void {
        for (self.entries[0..self.len]) |e| std.heap.c_allocator.free(e.sql);
        std.heap.c_allocator.destroy(self);
    }
};

/// SQLSTATE raised (as "cached plan must not change result type") when a
/// relation behind a named statement changed its result columns; node-pg's
/// unnamed statements never see it.
const RESULT_TYPE_CHANGED = "0A000";
/// SQLSTATE `invalid_sql_statement_name`: the named statement no longer
/// exists server-side; prepared again transparently.
const STATEMENT_MISSING = "26000";
/// SQLSTATE `duplicate_prepared_statement`.
const STATEMENT_EXISTS = "42P05";

fn isPoolerCode(code: []const u8) bool {
    return std.mem.eql(u8, code, STATEMENT_MISSING) or std.mem.eql(u8, code, STATEMENT_EXISTS);
}

/// SQLSTATE of a server error (`error.QueryFailed`), else "".
fn serverCode(err: Error, failure: Failure) []const u8 {
    return if (err == error.QueryFailed) failure.code orelse "" else "";
}

/// Hands a named-statement failure to the caller.
fn pass(failure: ?*Failure, local: Failure, err: Error) Error {
    if (failure) |f| f.* = local;
    return err;
}

/// TLS input that `poll()` on the socket cannot see: OpenSSL may hold bytes
/// it already decrypted but libpq has not read, and those have left the
/// socket, so a wait could stall input that has fully arrived. libpq's own
/// waits check `SSL_pending` (pgtls_read_pending), which it does not export,
/// and nothing in libpq's API reports how much `PQconsumeInput` read. So the
/// exact check calls OpenSSL's `SSL_pending` on `PQsslStruct(conn,
/// "OpenSSL")`, looking the symbol up at run time in the libssl libpq loaded
/// (no link-time dependency, no second copy of libssl); with a libpq whose
/// TLS library does not export it, reads fall back to a bounded drain plus
/// socket waits capped at 50 ms.
const tls = struct {
    const SslPending = *const fn (ssl: *anyopaque) callconv(.c) c_int;
    const fallback_wait_ms = 50;
    var pending: ?SslPending = null;
    var once = std.once(resolve);
    /// Test-only: behave as if `SSL_pending` were not available.
    var force_fallback: bool = false;
    var logged = std.atomic.Value(bool).init(false);

    fn resolve() void {
        const handle = std.c.dlopen(null, .{ .NOW = true }) orelse return;
        const sym = std.c.dlsym(handle, "SSL_pending") orelse return;
        pending = @ptrCast(@alignCast(sym));
    }

    fn pendingFn() ?SslPending {
        once.call();
        if (force_fallback) return null;
        return pending;
    }

    /// Once, at the first TLS connection: which input check is active.
    fn logMode() void {
        if (logged.swap(true, .monotonic)) return;
        if (pendingFn() != null)
            core.log.child("DbService").debug("TLS input check: OpenSSL SSL_pending (exact)", .{})
        else
            core.log.child("DbService").debug("TLS input check: bounded drain + {d} ms waits (SSL_pending not found)", .{fallback_wait_ms});
    }
};

/// Test-only switch for the TLS fallback path (`tls`).
pub fn forceTlsFallback(on: bool) void {
    tls.force_fallback = on;
}

/// Whether TLS reads use the exact OpenSSL check (`tls`).
pub fn tlsExact() bool {
    return tls.pendingFn() != null;
}

/// The reply to one query, accumulated by `collect`.
pub const Reply = struct {
    result: root.Result = .{ .rows = &.{}, .row_count = 0 },
    server_error: bool = false,
    /// libpq returned the final null result: nothing more to read.
    complete: bool = false,
};

pub fn nowMs() i64 {
    return std.time.milliTimestamp();
}

/// Test builds: notices the server sent (e.g. a SET LOCAL warning).
pub var test_notices: std.atomic.Value(u32) = .init(0);

fn ignoreNotice(_: ?*anyopaque, _: *const PGresult) callconv(.c) void {
    if (builtin.is_test) _ = test_notices.fetchAdd(1, .monotonic);
}

fn setFailure(failure: ?*Failure, arena: std.mem.Allocator, message: []const u8, code: ?[]const u8) void {
    const f = failure orelse return;
    f.message = arena.dupe(u8, message) catch "";
    f.code = if (code) |c| arena.dupe(u8, c) catch null else null;
}

pub const Conn = struct {
    pg: *PGconn,
    query_timeout_ms: ?u64,
    /// Set when the connection must not be reused (timeout, transport error).
    broken: bool = false,
    /// When the pool last handed it out (`Pool.hold_histogram`).
    checked_out_ns: i128 = 0,
    /// The next input wait is the first of an exchange whose send needed no
    /// wait: the reply can only arrive after the send and every earlier reply
    /// was read, so a fiber may park without a level check
    /// (`core.fiber.waitFdAfterSend`).
    fresh_reply: bool = false,
    /// The event loop whose poller holds the socket's registration: a fiber
    /// wait registers it on (or moves it to) the fiber's loop. The pool
    /// prefers handing it to that loop again (`Pool.takeIdle`).
    home: ?*anyopaque = null,
    /// The fiber loop's readiness word for the socket (`core.fiber.readiness`),
    /// looked up once after the first fiber wait: edges are recorded there
    /// while the connection is idle, so `checkIdle` needs no syscall when
    /// none arrived. Valid until `forgetFd` (`deinit`).
    readiness: ?*const std.atomic.Value(u32) = null,
    /// The socket libpq opened (-1 once handled after libpq dropped it).
    sock: std.posix.fd_t = -1,
    /// `QueryOptions.lazy` for the query in progress, and the tuples result
    /// it kept (owned here until `queryWith` hands it to the caller).
    lazy_mode: bool = false,
    lazy_res: ?*PGresult = null,
    /// This connection's identity for fiber-loop registrations
    /// (`core.fiber.newOwner`; never reused, unlike `pg` or `sock`).
    owner: u64 = 0,
    /// Named statements (`Plan.custom`/`.reusable`), allocated on first use.
    statements: ?*Statements = null,
    plan_mode: PlanMode = .custom,
    /// The setting the query in progress pipelines first (`queryWith`).
    tune: ?[*:0]const u8 = null,

    /// Connects within `connect_timeout_ms`. Failure messages follow node-pg:
    /// timeout -> "Connection terminated due to connection timeout", other
    /// failures -> libpq's message (trimmed).
    pub fn connect(opts: ConnOptions, arena: std.mem.Allocator, failure: ?*Failure) Error!Conn {
        return connectFinish(try connectStart(opts, arena, failure), arena, failure, null);
    }

    /// Runs one `PQconnectPoll` (`pollConnect`) elsewhere, e.g. on a worker
    /// thread: the step that does TLS handshake and SCRAM crypto.
    pub const Poller = struct {
        ctx: *anyopaque,
        poll: *const fn (ctx: *anyopaque, pg: *anyopaque) c_int,
    };

    /// A connection between `connectStart` and `connectFinish`.
    pub const Starting = struct {
        pg: *PGconn,
        owner: u64,
        query_timeout_ms: ?u64,
        connect_timeout_ms: ?u64,
    };

    /// First half of `connect`: `PQconnectStartParams`, which resolves host
    /// names with a blocking getaddrinfo (see `startMayBlock`); nothing is
    /// sent yet. Finish with `connectFinish` (any thread, one owner).
    pub fn connectStart(opts: ConnOptions, arena: std.mem.Allocator, failure: ?*Failure) Error!Starting {
        var scratch = std.heap.ArenaAllocator.init(std.heap.c_allocator);
        defer scratch.deinit();
        const a = scratch.allocator();
        const conninfo = try a.dupeZ(u8, opts.conninfo);
        var options: std.ArrayList(u8) = .empty;
        // JIT compilation costs more than it saves for every proxy query: the
        // confirmation snapshot/projection cross jit_above_cost and spend
        // 12/52-62 ms compiling for 0.2/15 ms of execution; nothing runs
        // slower without it (bench DB, every workload's SQL). First, so an
        // `options` in the URL can still override it.
        try options.appendSlice(a, "-c jit=off");
        if (existingOption(conninfo, "options")) |existing| {
            try options.append(a, ' ');
            try options.appendSlice(a, existing);
        }
        if (opts.statement_timeout_ms) |ms| {
            if (options.items.len > 0) try options.append(a, ' ');
            try options.print(a, "-c statement_timeout={d}", .{ms});
        }
        if (opts.options) |extra| {
            if (options.items.len > 0) try options.append(a, ' ');
            try options.appendSlice(a, extra);
        }
        // Last, so it wins: named statements rely on it (`PlanMode`).
        try options.appendSlice(a, " -c plan_cache_mode=force_custom_plan");
        const options_z = try a.dupeZ(u8, options.items);
        // node-pg never negotiates TLS unless asked (sslmode in the URL or
        // PGSSLMODE) and never uses GSSAPI encryption; libpq's "prefer"
        // defaults would add a negotiation round trip per connection.
        var kw_buf: [6]?[*:0]const u8 = @splat(null);
        var val_buf: [6]?[*:0]const u8 = @splat(null);
        var n_kw: usize = 0;
        const Kw = struct {
            fn add(kws: *[6]?[*:0]const u8, vals: *[6]?[*:0]const u8, n: *usize, k: [*:0]const u8, v: [*:0]const u8) void {
                kws[n.*] = k;
                vals[n.*] = v;
                n.* += 1;
            }
        };
        Kw.add(&kw_buf, &val_buf, &n_kw, "dbname", conninfo.ptr);
        Kw.add(&kw_buf, &val_buf, &n_kw, "client_encoding", "UTF8");
        if (options.items.len > 0) Kw.add(&kw_buf, &val_buf, &n_kw, "options", options_z.ptr);
        if (existingOption(conninfo, "sslmode") == null and std.posix.getenv("PGSSLMODE") == null)
            Kw.add(&kw_buf, &val_buf, &n_kw, "sslmode", "disable");
        if (existingOption(conninfo, "gssencmode") == null and std.posix.getenv("PGGSSENCMODE") == null)
            Kw.add(&kw_buf, &val_buf, &n_kw, "gssencmode", "disable");
        const pg = PQconnectStartParams(&kw_buf, &val_buf, 1) orelse return error.OutOfMemory;
        if (PQstatus(pg) == 1) { // CONNECTION_BAD
            setFailure(failure, arena, trimMessage(std.mem.span(PQerrorMessage(pg))), null);
            PQfinish(pg);
            return error.ConnectionFailed;
        }
        return .{ .pg = pg, .owner = core.fiber.newOwner(), .query_timeout_ms = opts.query_timeout_ms, .connect_timeout_ms = opts.connect_timeout_ms };
    }

    /// Second half of `connect`: drives `PQconnectPoll` to completion within
    /// `connect_timeout_ms` (from here, as `connect` always counted it),
    /// waiting on the socket (a fiber parks). Frees the connection on failure.
    /// `poller`: where each `PQconnectPoll` runs (null: here).
    pub fn connectFinish(st: Starting, arena: std.mem.Allocator, failure: ?*Failure, poller: ?Poller) Error!Conn {
        const pg = st.pg;
        const owner = st.owner;
        errdefer {
            const fd = PQsocket(pg);
            if (fd >= 0) core.fiber.forgetFd(fd);
            PQfinish(pg);
        }
        const deadline: ?i64 = if (st.connect_timeout_ms) |ms| (if (ms > 0) nowMs() + @as(i64, @intCast(ms)) else null) else null;
        var state: c_int = PGRES_POLLING_WRITING;
        while (true) {
            switch (state) {
                PGRES_POLLING_OK => break,
                PGRES_POLLING_FAILED => {
                    setFailure(failure, arena, trimMessage(std.mem.span(PQerrorMessage(pg))), null);
                    return error.ConnectionFailed;
                },
                else => {
                    const events: i16 = if (state == PGRES_POLLING_READING) std.posix.POLL.IN else std.posix.POLL.OUT;
                    if (!waitSocketMode(PQsocket(pg), events, deadline, false, owner)) {
                        setFailure(failure, arena, "Connection terminated due to connection timeout", null);
                        return error.ConnectionFailed;
                    }
                },
            }
            state = if (poller) |p| p.poll(p.ctx, pg) else PQconnectPoll(pg);
        }
        _ = PQsetNoticeReceiver(pg, ignoreNotice, null);
        if (PQsslInUse(pg) != 0) tls.logMode();
        if (PQsetnonblocking(pg, 1) != 0) {
            setFailure(failure, arena, trimMessage(std.mem.span(PQerrorMessage(pg))), null);
            return error.ConnectionFailed;
        }
        const sock = PQsocket(pg);
        // Start clean: drop any fiber-loop registration under this number
        // (left by a socket closed without telling the loop, or by our own
        // connect if it waited on a fiber); the socket is open and ours.
        core.fiber.forgetFd(sock);
        return .{ .pg = pg, .query_timeout_ms = st.query_timeout_ms, .sock = sock, .owner = owner };
    }

    pub fn deinit(self: *Conn) void {
        if (self.statements) |s| s.deinit();
        self.statements = null;
        // A fiber loop may hold a registration for this socket number.
        self.noteDropped();
        self.readiness = null;
        if (self.sock >= 0) core.fiber.forgetFd(self.sock);
        self.sock = -1;
        PQfinish(self.pg);
    }

    /// libpq closes the socket itself when it meets EOF or a transport
    /// error (pqDropConnection). A fiber loop watching that descriptor would
    /// keep a stale registration under a number the next socket may reuse
    /// (whose waits would then never wake): drop it at once, without
    /// touching the kernel (close already did, and the number may be taken).
    /// Call after any libpq call that can fail on the transport.
    fn noteDropped(self: *Conn) void {
        if (self.sock < 0 or PQsocket(self.pg) == self.sock) return;
        self.readiness = null;
        core.fiber.forgetClosedFd(self.sock);
        self.sock = -1;
    }

    pub fn socket(self: *const Conn) std.posix.fd_t {
        return PQsocket(self.pg);
    }

    pub fn ok(self: *const Conn) bool {
        return !self.broken and PQstatus(self.pg) == CONNECTION_OK;
    }

    /// Test-only: `checkIdle` calls that looked at the socket.
    pub var idle_socket_checks: std.atomic.Value(u64) = .init(0);

    /// For an idle connection: consume anything the server sent (e.g. an
    /// admin-shutdown error or EOF) and report whether it is still usable.
    /// pg-pool drops an idle client on its 'error' event and never hands out
    /// a dead one. With a fiber loop watching the socket, input or hangup
    /// since the last exchange shows in its readiness word, so the socket is
    /// only polled when something arrived (an edge the loop has not processed
    /// yet is missed, as TS only sees it at its next poll phase).
    pub fn checkIdle(self: *Conn, arena: std.mem.Allocator, failure: ?*Failure) bool {
        if (!self.ok()) return false;
        if (self.readiness) |bits| if (!core.fiber.inputSeen(bits)) return true;
        if (builtin.is_test) _ = idle_socket_checks.fetchAdd(1, .monotonic);
        var rounds: usize = 0;
        while (rounds < 4) : (rounds += 1) {
            var fds = [_]std.posix.pollfd{.{ .fd = self.socket(), .events = std.posix.POLL.IN, .revents = 0 }};
            const ready = std.posix.poll(&fds, 0) catch return false;
            if (ready == 0) return self.ok();
            if (PQconsumeInput(self.pg) == 0 or PQstatus(self.pg) != CONNECTION_OK) {
                if (failure) |f| if (f.message.len == 0) setFailure(failure, arena, idleMessage(self.pg), null);
                self.broken = true;
                self.noteDropped();
                return false;
            }
            // An idle connection only receives an error when the server is
            // about to drop it (e.g. "terminating connection due to
            // administrator command"): node-pg's idle client 'error'.
            while (PQisBusy(self.pg) == 0) {
                const res = PQgetResult(self.pg) orelse break;
                defer PQclear(res);
                if (PQresultStatus(res) == PGRES_FATAL_ERROR) {
                    const m = if (PQresultErrorField(res, PG_DIAG_MESSAGE_PRIMARY)) |x| std.mem.span(x) else idleMessage(self.pg);
                    setFailure(failure, arena, m, null);
                    self.broken = true;
                }
            }
            if (self.broken) return false;
        }
        return self.ok();
    }

    /// Runs one query (simple protocol without params, extended protocol with
    /// params — like node-pg) and converts rows. Timeouts and transport errors
    /// mark the connection broken.
    pub fn query(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error!root.Result {
        return self.queryWith(arena, sql, params, .{}, failure);
    }

    pub fn queryWith(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, opts: QueryOptions, failure: ?*Failure) Error!root.Result {
        const deadline: ?i64 = if (self.query_timeout_ms) |ms| (if (ms > 0) nowMs() + @as(i64, @intCast(ms)) else null) else null;
        const named = (opts.plan == .custom or opts.plan == .reusable) and params.len > 0 and (if (opts.guard) |g| g.active() else true);
        // The extended protocol (one implicit transaction per pipeline);
        // parameterless text may hold several statements, so it runs as is.
        self.tune = if (params.len > 0) tuneSql(opts.plan) else null;
        defer self.tune = null;
        self.lazy_mode = opts.lazy;
        defer self.lazy_mode = false;
        errdefer self.dropLazy();
        var result = if (named)
            self.runNamed(arena, sql, params, opts.plan, opts.guard, deadline, failure)
        else
            self.runUnnamed(arena, sql, params, deadline, failure);
        if (opts.lazy) {
            if (result) |*r| {
                if (self.lazy_res) |res| {
                    const lazy = try arena.create(LazyRows);
                    lazy.* = try LazyRows.init(arena, res);
                    self.lazy_res = null;
                    r.lazy = lazy;
                }
            } else |_| {}
        }
        return result catch |e| {
            // A server error leaves the connection idle and reusable; any
            // other early return (timeout, transport, OOM mid-result) may
            // leave unread results behind, so never reuse it.
            if (e != error.QueryFailed) self.broken = true;
            return e;
        };
    }

    fn runUnnamed(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        if (self.tune != null) {
            var local: Failure = .{};
            var failed: Step = .execute;
            const values = try textParams(arena, params);
            if (self.pipeline(arena, .{ .unnamed = sql }, values, self.plan_mode, deadline, &local, &failed)) |result| {
                return result;
            } else |e| {
                // Housekeeping must not fail the caller's query: run it as
                // it comes, untuned.
                if (e != error.QueryFailed or failed != .set) return pass(failure, local, e);
            }
        }
        try self.sendUnnamed(arena, sql, params, deadline, failure);
        return self.collect(arena, deadline, failure);
    }

    fn sendUnnamed(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, deadline: ?i64, failure: ?*Failure) Error!void {
        const sql_z = try arena.dupeZ(u8, sql);
        const sent = if (params.len == 0) PQsendQuery(self.pg, sql_z) else blk: {
            const values = try textParams(arena, params);
            break :blk PQsendQueryParams(self.pg, sql_z, @intCast(params.len), null, values.ptr, null, null, 0);
        };
        try self.flushSent(sent, arena, deadline, failure);
    }

    /// Executes `sql` as this connection's named statement. A new statement
    /// is prepared in the same pipeline as its first execution (no extra
    /// round trip), and so is a `plan_cache_mode` switch. Parse and bind
    /// errors carry the same server messages as the unnamed path.
    fn runNamed(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, plan: Plan, guard: ?*ReuseGuard, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        const statements = self.statements orelse blk: {
            const s = try std.heap.c_allocator.create(Statements);
            s.* = .{};
            self.statements = s;
            break :blk s;
        };
        const need: PlanMode = if (plan == .reusable) .auto else .custom;
        const values = try textParams(arena, params);
        var evict: ?*Statements.Entry = null;
        switch (statements.decide(sql)) {
            .unnamed => return self.runUnnamed(arena, sql, params, deadline, failure),
            .prepare => |old| evict = old,
            .hit => |entry| {
                var local: Failure = .{};
                var failed: Step = .execute;
                if (self.pipeline(arena, .{ .named = .{ .entry = entry } }, values, need, deadline, &local, &failed)) |result| {
                    return result;
                } else |e| {
                    const code = serverCode(e, local);
                    if (e == error.QueryFailed and failed == .set) {
                        // Housekeeping must not fail the caller's query.
                        return self.runUnnamed(arena, sql, params, deadline, failure);
                    } else if (std.mem.eql(u8, code, RESULT_TYPE_CHANGED)) {
                        // The relation's columns changed under the cached
                        // statement: drop it and prepare again, as an
                        // unnamed statement would.
                        evict = entry;
                    } else if (isPoolerCode(code)) {
                        statements.remove(entry);
                        return self.retryUnnamed(arena, sql, params, guard, code, deadline, failure);
                    } else return pass(failure, local, e);
                }
            },
        }
        if (evict) |old| {
            var local: Failure = .{};
            self.deallocate(arena, old, deadline, &local) catch |e| {
                statements.remove(old);
                if (e != error.QueryFailed) return pass(failure, local, e);
                return self.retryUnnamed(arena, sql, params, guard, serverCode(e, local), deadline, failure);
            };
            statements.remove(old);
        }
        const entry = try statements.add(sql);
        var local: Failure = .{};
        var failed: Step = .execute;
        return self.pipeline(arena, .{ .named = .{ .entry = entry, .prepare_sql = sql } }, values, need, deadline, &local, &failed) catch |e| {
            if (e != error.QueryFailed) return pass(failure, local, e);
            const code = serverCode(e, local);
            // Before `execute` ran, the statement was not created.
            if (failed != .execute) statements.remove(entry);
            if (failed == .set) return self.runUnnamed(arena, sql, params, deadline, failure);
            if (isPoolerCode(code)) {
                if (failed == .execute) statements.remove(entry);
                return self.retryUnnamed(arena, sql, params, guard, code, deadline, failure);
            }
            // Parse errors carry the same server message as the unnamed path.
            return pass(failure, local, e);
        };
    }

    /// A named-statement operation failed in a way node-pg's unnamed
    /// statements cannot (e.g. a transaction pooler moved us to another
    /// backend): run the query unnamed, so the caller never sees it.
    fn retryUnnamed(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, guard: ?*ReuseGuard, code: []const u8, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        if (guard) |g| if (isPoolerCode(code)) g.report(code);
        return self.runUnnamed(arena, sql, params, deadline, failure);
    }

    const Step = enum { set, prepare, execute };

    /// What `pipeline` executes: a named statement (prepared first when
    /// `prepare_sql` is set) or an unnamed one (`sql`).
    const Exec = union(enum) {
        named: struct { entry: *const Statements.Entry, prepare_sql: ?[]const u8 = null },
        unnamed: []const u8,
    };

    /// Executes `exec`, preceded in one round trip (libpq pipeline mode) by
    /// the `plan_cache_mode` switch this session needs (`need`), the
    /// statement's transaction-scoped setting (`tune`) and the Parse of a new named
    /// statement. Up to the Sync it is one implicit transaction: the setting
    /// ends with it. `failed` names the step of a server error.
    fn pipeline(self: *Conn, arena: std.mem.Allocator, exec: Exec, values: []const ?[*:0]const u8, need: PlanMode, deadline: ?i64, failure: ?*Failure, failed: *Step) Error!root.Result {
        const switch_mode = self.plan_mode != need;
        const prepare_sql = switch (exec) {
            .named => |named| named.prepare_sql,
            .unnamed => null,
        };
        failed.* = .execute;
        if (!switch_mode and self.tune == null and prepare_sql == null) {
            try self.flushSent(try self.sendExecute(arena, exec, values), arena, deadline, failure);
            return self.collect(arena, deadline, failure);
        }
        if (PQenterPipelineMode(self.pg) != 1) return self.transportFailure(arena, failure);
        var steps: [4]Step = undefined;
        var n: usize = 0;
        var sent = true;
        if (switch_mode) {
            const set: [*:0]const u8 = if (need == .auto) "SET plan_cache_mode = auto" else "SET plan_cache_mode = force_custom_plan";
            sent = sent and PQsendQueryParams(self.pg, set, 0, null, null, null, null, 0) == 1;
            steps[n] = .set;
            n += 1;
        }
        if (self.tune) |set| {
            sent = sent and PQsendQueryParams(self.pg, set, 0, null, null, null, null, 0) == 1;
            steps[n] = .set;
            n += 1;
        }
        if (prepare_sql) |sql| {
            const sql_z = try arena.dupeZ(u8, sql);
            sent = sent and PQsendPrepare(self.pg, exec.named.entry.nameZ(), sql_z, @intCast(values.len), null) == 1;
            steps[n] = .prepare;
            n += 1;
        }
        sent = sent and try self.sendExecute(arena, exec, values) == 1;
        steps[n] = .execute;
        n += 1;
        sent = sent and PQpipelineSync(self.pg) == 1;
        try self.flushSent(@intFromBool(sent), arena, deadline, failure);
        const result = self.collectPipeline(arena, steps[0..n], deadline, failure, failed);
        if (result) |_| {} else |e| if (e != error.QueryFailed) return e;
        if (PQexitPipelineMode(self.pg) != 1) return self.transportFailure(arena, failure);
        // A failed pipeline rolls back its implicit transaction, SET included.
        if (switch_mode) self.plan_mode = if (result) |_| need else |_| .unknown;
        return result;
    }

    fn sendExecute(self: *Conn, arena: std.mem.Allocator, exec: Exec, values: []const ?[*:0]const u8) Error!c_int {
        return switch (exec) {
            .named => |named| PQsendQueryPrepared(self.pg, named.entry.nameZ(), @intCast(values.len), values.ptr, null, null, 0),
            .unnamed => |sql| PQsendQueryParams(self.pg, try arena.dupeZ(u8, sql), @intCast(values.len), null, values.ptr, null, null, 0),
        };
    }

    /// `collect` for a pipeline: results of each step (each ended by a null
    /// result) up to the sync point. Rows come from the `execute` step.
    fn collectPipeline(self: *Conn, arena: std.mem.Allocator, steps: []const Step, deadline: ?i64, failure: ?*Failure, failed: *Step) Error!root.Result {
        defer self.fresh_reply = false;
        var result: root.Result = .{ .rows = &.{}, .row_count = 0 };
        var server_error = false;
        var index: usize = 0;
        while (true) {
            while (PQisBusy(self.pg) != 0) {
                if (!self.waitInput(deadline)) {
                    self.broken = true;
                    setFailure(failure, arena, "Query read timeout", null);
                    return error.QueryTimeout;
                }
                if (!self.consumeAll(.reply)) return self.transportFailure(arena, failure);
            }
            const res = PQgetResult(self.pg) orelse {
                index += 1;
                // More step ends than steps, or a dead connection: give up.
                if (index > steps.len or PQstatus(self.pg) != CONNECTION_OK) return self.transportFailure(arena, failure);
                continue;
            };
            var kept = false;
            defer if (!kept) PQclear(res);
            const step: Step = if (index < steps.len) steps[index] else .execute;
            switch (PQresultStatus(res)) {
                PGRES_PIPELINE_SYNC => break,
                PGRES_TUPLES_OK, PGRES_COMMAND_OK, PGRES_EMPTY_QUERY => if (!server_error and step == .execute) {
                    result = try self.takeTuples(arena, res, &kept);
                },
                PGRES_FATAL_ERROR => if (!server_error) {
                    server_error = true;
                    failed.* = step;
                    const message = if (PQresultErrorField(res, PG_DIAG_MESSAGE_PRIMARY)) |m| std.mem.span(m) else trimMessage(std.mem.span(PQerrorMessage(self.pg)));
                    const code = if (PQresultErrorField(res, PG_DIAG_SQLSTATE)) |c| std.mem.span(c) else null;
                    setFailure(failure, arena, message, code);
                },
                // PGRES_PIPELINE_ABORTED: steps after the failed one.
                else => {},
            }
        }
        if (PQstatus(self.pg) != CONNECTION_OK) {
            self.broken = true;
            if (!server_error) setFailure(failure, arena, "Connection terminated unexpectedly", null);
            return error.ConnectionFailed;
        }
        if (server_error) return error.QueryFailed;
        return result;
    }

    fn deallocate(self: *Conn, arena: std.mem.Allocator, entry: *const Statements.Entry, deadline: ?i64, failure: ?*Failure) Error!void {
        const sql = try std.fmt.allocPrintSentinel(arena, "DEALLOCATE {s}", .{entry.name[0..entry.name_len]}, 0);
        try self.flushSent(PQsendQuery(self.pg, sql), arena, deadline, failure);
        _ = try self.collect(arena, deadline, failure);
    }

    /// node-pg's query_timeout covers sending too: a server that stops
    /// reading cannot block us past the deadline.
    fn flushSent(self: *Conn, sent: c_int, arena: std.mem.Allocator, deadline: ?i64, failure: ?*Failure) Error!void {
        if (sent == 0) return self.transportFailure(arena, failure);
        self.fresh_reply = true;
        while (true) {
            const flushed = PQflush(self.pg);
            if (flushed == 0) return;
            if (flushed < 0) return self.transportFailure(arena, failure);
            // Waiting here may consume a readiness edge of the reply.
            self.fresh_reply = false;
            if (!self.waitOwn(std.posix.POLL.OUT | std.posix.POLL.IN, deadline, false)) {
                self.broken = true;
                setFailure(failure, arena, "Query read timeout", null);
                return error.QueryTimeout;
            }
            // Input read while flushing must not stay inside OpenSSL either:
            // the reply wait that follows could not see it (`tls`).
            if (!self.consumeAll(.reply)) return self.transportFailure(arena, failure);
        }
    }

    fn collect(self: *Conn, arena: std.mem.Allocator, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        var reply: Reply = .{};
        return self.collectWith(arena, &reply, deadline, failure);
    }

    fn collectWith(self: *Conn, arena: std.mem.Allocator, reply: *Reply, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        // An exchange that needed no input wait must not leave the flag set.
        defer self.fresh_reply = false;
        while (!try self.collectStep(arena, reply, failure)) {
            if (!self.waitInput(deadline)) {
                self.broken = true;
                setFailure(failure, arena, "Query read timeout", null);
                return error.QueryTimeout;
            }
            if (!self.consumeAll(.reply)) return self.transportFailure(arena, failure);
        }
        if (PQstatus(self.pg) != CONNECTION_OK) {
            self.broken = true;
            if (!reply.server_error) setFailure(failure, arena, "Connection terminated unexpectedly", null);
            return error.ConnectionFailed;
        }
        if (reply.server_error) return error.QueryFailed;
        return reply.result;
    }

    /// Processes the results libpq has already parsed, without waiting.
    /// True when the reply is complete (libpq returned its final null).
    /// A tuples/command result: converted, or (lazy mode) kept in
    /// `lazy_res` for `queryWith` (`kept`: the caller must not clear it).
    fn takeTuples(self: *Conn, arena: std.mem.Allocator, res: *PGresult, kept: *bool) Error!root.Result {
        if (!self.lazy_mode) return .{ .rows = try convertRows(arena, res), .row_count = rowCount(res) };
        if (self.lazy_res) |old| PQclear(old);
        self.lazy_res = res;
        kept.* = true;
        return .{ .rows = &.{}, .row_count = rowCount(res) };
    }

    fn dropLazy(self: *Conn) void {
        if (self.lazy_res) |res| PQclear(res);
        self.lazy_res = null;
    }

    fn collectStep(self: *Conn, arena: std.mem.Allocator, reply: *Reply, failure: ?*Failure) Error!bool {
        if (reply.complete) return true;
        while (PQisBusy(self.pg) == 0) {
            const res = PQgetResult(self.pg) orelse {
                reply.complete = true;
                return true;
            };
            var kept = false;
            defer if (!kept) PQclear(res);
            switch (PQresultStatus(res)) {
                PGRES_TUPLES_OK, PGRES_COMMAND_OK, PGRES_EMPTY_QUERY => if (!reply.server_error) {
                    reply.result = try self.takeTuples(arena, res, &kept);
                },
                PGRES_FATAL_ERROR => if (!reply.server_error) {
                    reply.server_error = true;
                    const message = if (PQresultErrorField(res, PG_DIAG_MESSAGE_PRIMARY)) |m| std.mem.span(m) else trimMessage(std.mem.span(PQerrorMessage(self.pg)));
                    const code = if (PQresultErrorField(res, PG_DIAG_SQLSTATE)) |c| std.mem.span(c) else null;
                    setFailure(failure, arena, message, code);
                },
                else => {},
            }
        }
        return false;
    }

    /// `PQconsumeInput`, plus (TLS only) what OpenSSL already decrypted
    /// (see `tls`). False on a transport error.
    fn consumeAll(self: *Conn, mode: ConsumeMode) bool {
        const consumed = self.consumeAllInner(mode);
        if (!consumed) self.noteDropped();
        return consumed;
    }

    fn consumeAllInner(self: *Conn, mode: ConsumeMode) bool {
        if (PQconsumeInput(self.pg) == 0) return false;
        if (PQsslInUse(self.pg) == 0) return true;
        if (tls.pendingFn()) |pending| {
            // Exact: read until OpenSSL holds nothing more (each read takes at
            // least 8 KB of a record of at most 16 KB; bounded for safety).
            const ssl = PQsslStruct(self.pg, "OpenSSL") orelse return true;
            var reads: usize = 0;
            while (reads < 64 and pending(ssl) > 0) : (reads += 1) {
                if (PQconsumeInput(self.pg) == 0) return false;
            }
            return true;
        }
        // Fallback: two more reads take what one read leaves behind; waits are
        // also capped (`inputDeadline`) so a rarer leftover stalls ≤ 50 ms.
        var extra: usize = 0;
        while (extra < 2) : (extra += 1) {
            if (mode == .reply and PQisBusy(self.pg) == 0) break;
            if (PQconsumeInput(self.pg) == 0) return false;
        }
        return true;
    }

    const ConsumeMode = enum { reply, notifications };

    /// `waitSocketMode` on this socket, noting the loop a fiber wait
    /// registered it on (`home`; a hint: only after a wait that returned
    /// ready, and a failed registration polls inline without moving it).
    fn waitOwn(self: *Conn, events: i16, deadline: ?i64, after_send: bool) bool {
        const ready = waitSocketMode(self.socket(), events, deadline, after_send, self.owner);
        if (ready) if (core.fiber.current()) |f| {
            self.home = f.sched.ctx;
            // The wait registered the socket with a loop (one locked lookup).
            if (self.readiness == null) self.readiness = core.fiber.readiness(self.socket());
        };
        return ready;
    }

    /// Waits for more reply input; false only once `deadline` has passed.
    fn waitInput(self: *Conn, deadline: ?i64) bool {
        const after_send = self.fresh_reply;
        self.fresh_reply = false;
        if (self.waitOwn(std.posix.POLL.IN, self.inputDeadline(deadline), after_send)) return true;
        const d = deadline orelse return true;
        return nowMs() < d;
    }

    /// The deadline for one socket wait for input: `deadline`, capped at
    /// 50 ms when TLS is in use without the exact OpenSSL check (a leftover
    /// the bounded drain missed is then picked up by the next drain).
    pub fn inputDeadline(self: *Conn, deadline: ?i64) ?i64 {
        if (PQsslInUse(self.pg) == 0 or tls.pendingFn() != null) return deadline;
        const cap = nowMs() + tls.fallback_wait_ms;
        return if (deadline) |d| @min(d, cap) else cap;
    }

    fn transportFailure(self: *Conn, arena: std.mem.Allocator, failure: ?*Failure) Error {
        self.broken = true;
        self.noteDropped();
        setFailure(failure, arena, "Connection terminated unexpectedly", null);
        return error.ConnectionFailed;
    }

    /// Reads pending input and returns the next queued notification (caller
    /// frees with `freeNotify`). Returns error.ConnectionFailed on EOF.
    pub fn consume(self: *Conn) Error!void {
        if (!self.consumeAll(.notifications) or PQstatus(self.pg) != CONNECTION_OK) {
            self.broken = true;
            return error.ConnectionFailed;
        }
        while (PQisBusy(self.pg) == 0) {
            const res = PQgetResult(self.pg) orelse break;
            PQclear(res);
        }
    }

    pub fn nextNotify(self: *Conn) ?*PGnotify {
        return PQnotifies(self.pg);
    }
};

pub fn freeNotify(n: *PGnotify) void {
    PQfreemem(n);
}

fn idleMessage(pg: *PGconn) []const u8 {
    const m = trimMessage(std.mem.span(PQerrorMessage(pg)));
    return if (m.len == 0) "Connection terminated unexpectedly" else m;
}

/// libpq messages carry "FATAL:  " / "ERROR:  " severity prefixes and a
/// trailing newline; node-pg reports the bare text.
pub fn trimMessage(message: []const u8) []const u8 {
    var m = std.mem.trim(u8, message, " \n\r\t");
    if (std.mem.indexOfScalar(u8, m, '\n')) |nl| m = m[0..nl];
    // libpq: `connection to server at "h" (ip), port N failed: <reason>`.
    if (std.mem.startsWith(u8, m, "connection to server")) {
        if (std.mem.indexOf(u8, m, " failed: ")) |i| m = m[i + " failed: ".len ..];
    }
    for ([_][]const u8{ "FATAL:  ", "ERROR:  " }) |p| if (std.mem.startsWith(u8, m, p)) {
        m = m[p.len..];
    };
    return m;
}

/// node-pg `prepareValue` text for each parameter (null -> SQL NULL).
fn textParams(arena: std.mem.Allocator, params: []const Value) Error![]?[*:0]const u8 {
    const values = try arena.alloc(?[*:0]const u8, params.len);
    for (params, values) |p, *v| v.* = if (try convert.prepareValue(arena, p)) |text| text.ptr else null;
    return values;
}

fn rowCount(res: *PGresult) usize {
    const text = std.mem.span(PQcmdTuples(res));
    return std.fmt.parseInt(usize, text, 10) catch 0;
}

fn convertRows(arena: std.mem.Allocator, res: *PGresult) std.mem.Allocator.Error![]Value {
    const n_rows: usize = @intCast(PQntuples(res));
    const n_cols: usize = @intCast(PQnfields(res));
    const rows = try arena.alloc(Value, n_rows);
    if (n_rows == 0) return rows;
    const names = try arena.alloc([]const u8, n_cols);
    const oids = try arena.alloc(u32, n_cols);
    const kinds = try arena.alloc(convert.ColumnKind, n_cols);
    // Column slot for each field: duplicates share the first position.
    const slots = try arena.alloc(usize, n_cols);
    var width: usize = 0;
    for (0..n_cols) |c| {
        names[c] = try arena.dupe(u8, std.mem.span(PQfname(res, @intCast(c))));
        oids[c] = PQftype(res, @intCast(c));
        kinds[c] = convert.columnKind(oids[c]);
        slots[c] = width;
        for (0..c) |prev| {
            if (std.mem.eql(u8, names[prev], names[c])) {
                slots[c] = slots[prev];
                break;
            }
        }
        if (slots[c] == width) width += 1;
    }
    // Numbers and booleans are read straight from libpq's text. Other cells
    // are copied into large arena chunks (not one allocation per string),
    // then converted in place: string results alias the chunk.
    const members = try arena.alloc(core.json.Member, n_rows * width);
    var chunk: []u8 = &.{};
    for (0..n_rows) |r| {
        const row = members[r * width ..][0..width];
        const ri: c_int = @intCast(r);
        for (0..n_cols) |c| {
            const ci: c_int = @intCast(c);
            // NULL cells have length 0, so only empty cells need PQgetisnull.
            const len = PQgetlength(res, ri, ci);
            const value: Value = if (len == 0 and PQgetisnull(res, ri, ci) != 0) .null else blk: {
                const n: usize = @intCast(len);
                const text = PQgetvalue(res, ri, ci)[0..n];
                switch (kinds[c]) {
                    .bool => break :blk .{ .bool = convert.fastBool(text) },
                    .int => break :blk .{ .number = convert.fastInt(text) },
                    .text, .other => {},
                }
                if (chunk.len < n) chunk = try arena.alloc(u8, @max(n, 16 * 1024));
                const cell = chunk[0..n];
                chunk = chunk[n..];
                @memcpy(cell, text);
                break :blk if (kinds[c] == .text) .{ .string = cell } else try convert.convertCell(arena, oids[c], cell, .borrow);
            };
            row[slots[c]] = .{ .key = names[c], .value = value };
        }
        rows[r] = .{ .object = row };
    }
    return rows;
}

/// Returns the value of `keyword` parsed from a connection string, if set.
/// One `PQconnectPoll` step of a connection in `connectFinish` (`Poller`).
pub fn pollConnect(pg: *anyopaque) c_int {
    return PQconnectPoll(@ptrCast(pg));
}

/// Whether `PQconnectStartParams` may block on name resolution for this
/// connection string: false only when every target is an IP literal or a
/// Unix-socket directory (or `hostaddr` is given), so libpq's getaddrinfo
/// returns at once. Environment defaults (PGHOST, ...) count as "may block".
pub fn startMayBlock(conninfo: []const u8) bool {
    var buf: [2048]u8 = undefined;
    if (conninfo.len >= buf.len) return true;
    @memcpy(buf[0..conninfo.len], conninfo);
    buf[conninfo.len] = 0;
    const z = buf[0..conninfo.len :0];
    var errmsg: ?[*:0]u8 = null;
    const parsed = PQconninfoParse(z, &errmsg) orelse {
        if (errmsg) |m| PQfreemem(m);
        return true;
    };
    defer PQconninfoFree(parsed);
    var host: ?[]const u8 = null;
    var i: usize = 0;
    while (parsed[i].keyword) |k| : (i += 1) {
        const v = std.mem.span(parsed[i].val orelse continue);
        if (v.len == 0) continue;
        if (std.mem.eql(u8, std.mem.span(k), "hostaddr")) return false;
        if (std.mem.eql(u8, std.mem.span(k), "host")) host = v;
    }
    var it = std.mem.splitScalar(u8, host orelse return true, ',');
    while (it.next()) |h| {
        if (h.len > 0 and h[0] == '/') continue;
        _ = std.net.Address.parseIp(h, 0) catch return true;
    }
    return false;
}

fn existingOption(conninfo: [:0]const u8, keyword: []const u8) ?[]const u8 {
    var errmsg: ?[*:0]u8 = null;
    const parsed = PQconninfoParse(conninfo, &errmsg) orelse {
        if (errmsg) |m| PQfreemem(m);
        return null;
    };
    defer PQconninfoFree(parsed);
    var i: usize = 0;
    while (parsed[i].keyword) |k| : (i += 1) {
        if (std.mem.eql(u8, std.mem.span(k), keyword)) {
            const v = parsed[i].val orelse return null;
            const s = std.mem.span(v);
            if (s.len == 0) return null;
            // Copied into a static per-thread buffer: callers use it immediately.
            const buf = optionBuf();
            const n = @min(s.len, buf.len);
            @memcpy(buf[0..n], s[0..n]);
            return buf[0..n];
        }
    }
    return null;
}

threadlocal var option_buf: [1024]u8 = undefined;
fn optionBuf() []u8 {
    return &option_buf;
}

/// poll() until `fd` is ready for `events` or the deadline passes.
pub fn waitSocket(fd: std.posix.fd_t, events: i16, deadline: ?i64) bool {
    return waitSocketMode(fd, events, deadline, false, 0);
}

/// `waitSocket`; `after_send`: the input can only arrive after our send and
/// all earlier input was read, so a fiber parks without a level check.
/// `owner` (`Conn.owner`, never reused; 0 = none): a fiber loop
/// re-registers the descriptor when its number last belonged to another
/// owner (a socket closed without telling the loop).
fn waitSocketMode(fd: std.posix.fd_t, events: i16, deadline: ?i64, after_send: bool, owner: u64) bool {
    if (deadline) |d| if (d - nowMs() <= 0) return false;
    if (core.fiber.inFiber()) {
        // Park the request's fiber; its loop resumes it on readiness. waitFd
        // checks the fd's level before parking, so bytes libpq left in the
        // kernel buffer never park it; bytes left inside OpenSSL are drained
        // by the callers (`consumeAll`) before they wait.
        var ev: u32 = 0;
        if (events & std.posix.POLL.IN != 0) ev |= core.fiber.Events.read;
        if (events & std.posix.POLL.OUT != 0) ev |= core.fiber.Events.write;
        const mono: ?i64 = if (deadline) |d| core.fiber.monoMs() + (d - nowMs()) else null;
        if (owner != 0) {
            (if (after_send) core.fiber.waitFdAfterSendOwned(owner, fd, ev, mono) else core.fiber.waitFdOwned(owner, fd, ev, mono)) catch return false;
        } else {
            (if (after_send) core.fiber.waitFdAfterSend(fd, ev, mono) else core.fiber.waitFd(fd, ev, mono)) catch return false;
        }
        return true;
    }
    var fds = [_]std.posix.pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
    // Already ready (e.g. the rest of a multi-packet result): no sleep, so
    // no poller hand-off.
    if ((std.posix.poll(&fds, 0) catch return false) > 0) return true;
    // A reply within the poller's grace keeps the poller (no-op off-poller).
    if (core.blocking.graceWait(fd, events)) return true;
    // Let an HTTP poller thread hand off its work while this one sleeps.
    core.blocking.begin();
    defer core.blocking.end();
    while (true) {
        var timeout: i32 = -1;
        if (deadline) |d| {
            const remaining = d - nowMs();
            if (remaining <= 0) return false;
            timeout = @intCast(@min(remaining, std.math.maxInt(i32)));
        }
        fds[0].revents = 0;
        const n = std.posix.poll(&fds, timeout) catch return false;
        if (n > 0) return true;
    }
}

test "trimMessage strips libpq severity prefixes" {
    try std.testing.expectEqualStrings("password authentication failed for user \"x\"", trimMessage("FATAL:  password authentication failed for user \"x\"\n"));
    try std.testing.expectEqualStrings("could not connect", trimMessage("could not connect\nsecond line\n"));
    try std.testing.expectEqualStrings("database \"x\" does not exist", trimMessage("connection to server at \"127.0.0.1\", port 5 failed: FATAL:  database \"x\" does not exist\n"));
}

test "waitSocket skips the blocking hook when the socket is already ready" {
    const Counter = struct {
        var begins: usize = 0;
        fn begin(_: *anyopaque) void {
            begins += 1;
        }
        fn end(_: *anyopaque) void {}
    };
    var dummy: u8 = 0;
    core.blocking.hook = .{ .ctx = &dummy, .begin = Counter.begin, .end = Counter.end };
    defer core.blocking.hook = null;
    const fds = try std.posix.pipe();
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    // Nothing to read: sleeps (hook) until the deadline.
    try std.testing.expect(!waitSocket(fds[0], std.posix.POLL.IN, nowMs() + 20));
    try std.testing.expectEqual(@as(usize, 1), Counter.begins);
    // Data already there: returns without the hook.
    _ = try std.posix.write(fds[1], "x");
    try std.testing.expect(waitSocket(fds[0], std.posix.POLL.IN, null));
    try std.testing.expectEqual(@as(usize, 1), Counter.begins);
}

test "waitSocket: a reply within the poller's grace skips the hand-off" {
    const Counter = struct {
        var begins: usize = 0;
        fn begin(_: *anyopaque) void {
            begins += 1;
        }
        fn end(_: *anyopaque) void {}
    };
    var dummy: u8 = 0;
    core.blocking.hook = .{ .ctx = &dummy, .begin = Counter.begin, .end = Counter.end };
    defer core.blocking.hook = null;
    core.blocking.grace_ns = 200 * std.time.ns_per_ms;
    defer core.blocking.grace_ns = 0;
    const fds = try std.posix.pipe();
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    const Writer = struct {
        fn run(fd: std.posix.fd_t) void {
            std.Thread.sleep(5 * std.time.ns_per_ms);
            _ = std.posix.write(fd, "x") catch {};
        }
    };
    const t = try std.Thread.spawn(.{}, Writer.run, .{fds[1]});
    try std.testing.expect(waitSocket(fds[0], std.posix.POLL.IN, null));
    t.join();
    try std.testing.expectEqual(@as(usize, 0), Counter.begins);
}

fn expectFastEqualsConvert(a: std.mem.Allocator, oid: u32, text: []const u8) !void {
    var fast: std.Io.Writer.Allocating = .init(a);
    try LazyRows.writeText(&fast.writer, a, oid, text);
    const want = try core.json.stringifyAlloc(a, try convert.convertCell(a, oid, text, .copy));
    if (!std.mem.eql(u8, want, fast.written())) std.debug.print("oid {d} text {any}: fast {s} want {s}\n", .{ oid, text, fast.written(), want });
    try std.testing.expectEqualStrings(want, fast.written());
}

test "LazyRows.writeText is byte-identical to stringify(convertCell) on edge values" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const ints = [_][]const u8{ "0", "-0", "1", "-1", "32767", "-32768", "2147483647", "-2147483648", "00", "007", "-007", "9999999999", "99999999999", "12345678901", "4294967295", "", "-", "+1", " 1", "1 ", "1e3", "0x1f" };
    for (ints) |t| for ([_]u32{ 21, 23 }) |oid| try expectFastEqualsConvert(a, oid, t);
    const numerics = [_][]const u8{ "0", "9007199254740993", "-9223372036854775808", "9223372036854775807", "123.4500", "1.00000000000000000000", "1e-30", "0.000000000000000000000000000001", "NaN", "Infinity", "-Infinity", "-0.0", "18446744073709551616" };
    for (numerics) |t| for ([_]u32{ 20, 1700 }) |oid| try expectFastEqualsConvert(a, oid, t);
    const texts = [_][]const u8{ "", "plain", "pad   ", "\"quoted\" \\back\\slash/", "\x00\x01\x07\x08\x09\x0a\x0b\x0c\x0d\x1b\x1f\x7f", "\u{2028}\u{2029}", "\u{1F600} astral \u{10FFFF}", "é ü ß 中文", "</script>", "\\u0000" };
    for (texts) |t| for ([_]u32{ 25, 1043, 1042 }) |oid| try expectFastEqualsConvert(a, oid, t);
    const bools = [_][]const u8{ "t", "f", "true", "false", "1", "0", "y", "yes", "on", "TRUE", "", "x" };
    for (bools) |t| try expectFastEqualsConvert(a, 16, t);
    // Excluded types keep convertCell (trivially equal; asserts the routing).
    for ([_]u32{ 700, 701, 114, 3802, 17, 1082, 1184, 1007, 26, 19, 2950 }) |oid|
        try std.testing.expectEqual(LazyRows.Kind.none, LazyRows.kindOf(oid));
}

test "LazyRows.writeText equals stringify(convertCell) on random values" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var prng = std.Random.DefaultPrng.init(0xc417);
    const rnd = prng.random();
    var buf: [64]u8 = undefined;
    for (0..20_000) |_| {
        const v = rnd.intRangeAtMost(i64, -2147483648, 2147483647);
        try expectFastEqualsConvert(a, 23, std.fmt.bufPrint(&buf, "{d}", .{v}) catch unreachable);
        const big = rnd.int(i64);
        try expectFastEqualsConvert(a, 20, std.fmt.bufPrint(&buf, "{d}", .{big}) catch unreachable);
    }
    // Random valid UTF-8 strings, biased to control, quote, backslash,
    // U+2028/9 and astral code points.
    const picks = [_]u21{ 0, 1, 8, 9, 10, 13, 0x1f, '"', '\\', '/', 0x7f, 0x80, 0x2028, 0x2029, 0xfeff, 0x1F600, 0x10FFFF, 'a', 'z', 0xe9 };
    var s: std.ArrayList(u8) = .empty;
    for (0..5_000) |_| {
        s.clearRetainingCapacity();
        const n = rnd.uintLessThan(usize, 24);
        for (0..n) |_| {
            const cp: u21 = if (rnd.boolean()) picks[rnd.uintLessThan(usize, picks.len)] else blk: {
                var c = rnd.uintLessThan(u21, 0x110000);
                if (c >= 0xD800 and c <= 0xDFFF) c = 'x';
                break :blk c;
            };
            var enc: [4]u8 = undefined;
            const len = std.unicode.utf8Encode(cp, &enc) catch unreachable;
            try s.appendSlice(a, enc[0..len]);
        }
        try expectFastEqualsConvert(a, 25, s.items);
    }
}
