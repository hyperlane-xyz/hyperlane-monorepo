//! One libpq connection driven through the nonblocking API with poll()
//! deadlines, so connect and query timeouts are enforced in milliseconds.
//! A `Conn` has a single owner at a time (pool checkout or listener thread).
const std = @import("std");
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
};

pub const QueryOptions = struct {
    plan: Plan = .unnamed,
    /// Pool-wide switch that turns named statements off (set by `Pool`).
    guard: ?*ReuseGuard = null,
};

/// The session's `plan_cache_mode` as far as this connection knows: set to
/// `force_custom_plan` at startup, switched (pipelined with the execute)
/// only when a statement needs the other mode.
const PlanMode = enum { custom, auto, unknown };

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

/// A reply read ahead of its use (`Conn.pollRaw`/`finishRaw`): libpq's
/// results, converted only by `take` in the consumer's arena.
pub const RawReply = struct {
    tuples: ?*PGresult = null,
    err: ?*PGresult = null,
    complete: bool = false,

    pub fn deinit(self: *RawReply) void {
        if (self.tuples) |r| PQclear(r);
        if (self.err) |r| PQclear(r);
        self.* = .{};
    }

    /// The rows (node-pg conversion) or the server error, as `query` would
    /// return them; frees the results.
    pub fn take(self: *RawReply, arena: std.mem.Allocator, failure: ?*Failure) Error!root.Result {
        defer self.deinit();
        if (self.err) |res| {
            const message = if (PQresultErrorField(res, PG_DIAG_MESSAGE_PRIMARY)) |m| std.mem.span(m) else "";
            const code = if (PQresultErrorField(res, PG_DIAG_SQLSTATE)) |c| std.mem.span(c) else null;
            setFailure(failure, arena, message, code);
            return error.QueryFailed;
        }
        const res = self.tuples orelse return .{ .rows = &.{}, .row_count = 0 };
        return .{ .rows = try convertRows(arena, res), .row_count = rowCount(res) };
    }

    /// SQLSTATE of the server error, if any (borrowed until `take`/`deinit`).
    pub fn errorCode(self: *const RawReply) ?[]const u8 {
        const res = self.err orelse return null;
        return if (PQresultErrorField(res, PG_DIAG_SQLSTATE)) |c| std.mem.span(c) else null;
    }
};

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

fn ignoreNotice(_: ?*anyopaque, _: *const PGresult) callconv(.c) void {}

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
    /// A `sendQuery` left part of its message in libpq's output buffer
    /// (the kernel would not take it all): `pollRaw`/`finishRaw` flush it.
    unflushed: bool = false,
    /// Named statements (`Plan.custom`/`.reusable`), allocated on first use.
    statements: ?*Statements = null,
    plan_mode: PlanMode = .custom,

    /// Connects within `connect_timeout_ms`. Failure messages follow node-pg:
    /// timeout -> "Connection terminated due to connection timeout", other
    /// failures -> libpq's message (trimmed).
    pub fn connect(opts: ConnOptions, arena: std.mem.Allocator, failure: ?*Failure) Error!Conn {
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
        errdefer PQfinish(pg);
        const deadline: ?i64 = if (opts.connect_timeout_ms) |ms| (if (ms > 0) nowMs() + @as(i64, @intCast(ms)) else null) else null;
        if (PQstatus(pg) == 1) { // CONNECTION_BAD
            setFailure(failure, arena, trimMessage(std.mem.span(PQerrorMessage(pg))), null);
            return error.ConnectionFailed;
        }
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
                    if (!waitSocket(PQsocket(pg), events, deadline)) {
                        setFailure(failure, arena, "Connection terminated due to connection timeout", null);
                        return error.ConnectionFailed;
                    }
                },
            }
            state = PQconnectPoll(pg);
        }
        _ = PQsetNoticeReceiver(pg, ignoreNotice, null);
        if (PQsslInUse(pg) != 0) tls.logMode();
        if (PQsetnonblocking(pg, 1) != 0) {
            setFailure(failure, arena, trimMessage(std.mem.span(PQerrorMessage(pg))), null);
            return error.ConnectionFailed;
        }
        return .{ .pg = pg, .query_timeout_ms = opts.query_timeout_ms };
    }

    pub fn deinit(self: *Conn) void {
        if (self.statements) |s| s.deinit();
        self.statements = null;
        PQfinish(self.pg);
    }

    pub fn socket(self: *const Conn) std.posix.fd_t {
        return PQsocket(self.pg);
    }

    pub fn ok(self: *const Conn) bool {
        return !self.broken and PQstatus(self.pg) == CONNECTION_OK;
    }

    /// For an idle connection: consume anything the server sent (e.g. an
    /// admin-shutdown error or EOF) and report whether it is still usable.
    pub fn checkIdle(self: *Conn, arena: std.mem.Allocator, failure: ?*Failure) bool {
        if (!self.ok()) return false;
        var rounds: usize = 0;
        while (rounds < 4) : (rounds += 1) {
            var fds = [_]std.posix.pollfd{.{ .fd = self.socket(), .events = std.posix.POLL.IN, .revents = 0 }};
            const ready = std.posix.poll(&fds, 0) catch return false;
            if (ready == 0) return self.ok();
            if (PQconsumeInput(self.pg) == 0 or PQstatus(self.pg) != CONNECTION_OK) {
                if (failure) |f| if (f.message.len == 0) setFailure(failure, arena, idleMessage(self.pg), null);
                self.broken = true;
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
        const named = opts.plan != .unnamed and params.len > 0 and (if (opts.guard) |g| g.active() else true);
        const result = if (named)
            self.runNamed(arena, sql, params, opts.plan, opts.guard, deadline, failure)
        else
            self.runUnnamed(arena, sql, params, deadline, failure);
        return result catch |e| {
            // A server error leaves the connection idle and reusable; any
            // other early return (timeout, transport, OOM mid-result) may
            // leave unread results behind, so never reuse it.
            if (e != error.QueryFailed) self.broken = true;
            return e;
        };
    }

    fn runUnnamed(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, deadline: ?i64, failure: ?*Failure) Error!root.Result {
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

    fn deadlineFromNow(self: *const Conn) ?i64 {
        return if (self.query_timeout_ms) |ms| (if (ms > 0) nowMs() + @as(i64, @intCast(ms)) else null) else null;
    }

    /// First half of an unnamed `query`: sends it and returns without reading.
    /// Then `pollQuery` (never waits) until it reports completion, and/or
    /// `finishQuery` (waits); or `discardQuery`.
    /// Never waits: what the kernel does not take at once stays buffered
    /// (`unflushed`; the caller polls for writability, see `wantsWrite`).
    pub fn sendQuery(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error!void {
        errdefer self.broken = true;
        const sql_z = try arena.dupeZ(u8, sql);
        const sent = if (params.len == 0) PQsendQuery(self.pg, sql_z) else blk: {
            const values = try textParams(arena, params);
            break :blk PQsendQueryParams(self.pg, sql_z, @intCast(params.len), null, values.ptr, null, null, 0);
        };
        if (sent == 0) return self.transportFailure(arena, failure);
        switch (PQflush(self.pg)) {
            0 => {},
            1 => self.unflushed = true,
            else => return self.transportFailure(arena, failure),
        }
    }

    /// The rest of a `sendQuery` is still to be written.
    pub fn wantsWrite(self: *const Conn) bool {
        return self.unflushed;
    }

    /// Writes what the kernel takes now; true once nothing is left.
    fn flushSome(self: *Conn) Error!bool {
        if (!self.unflushed) return true;
        switch (PQflush(self.pg)) {
            0 => {
                self.unflushed = false;
                return true;
            },
            1 => return false,
            else => {
                self.broken = true;
                return error.ConnectionFailed;
            },
        }
    }

    /// Reads whatever has arrived for a `sendQuery` without waiting (keeping
    /// the server from blocking on a full socket); libpq's results are kept
    /// in `reply` unconverted, so any thread may call this. True once the
    /// reply is complete. Errors: ConnectionFailed (connection broken).
    pub fn pollRaw(self: *Conn, reply: *RawReply) Error!bool {
        if (reply.complete) return true;
        if (!try self.flushSome()) {
            // Still writing; take any input so the server is not blocked.
            if (!self.consumeAll(.reply)) {
                self.broken = true;
                return error.ConnectionFailed;
            }
            return false;
        }
        // libpq reads at most its buffer's free space (~16 KB) per call: keep
        // reading while the socket has data, bounded so one poll stays short
        // (64 reads, about 1 MB).
        var reads: usize = 0;
        while (reads < 64) : (reads += 1) {
            if (!self.consumeAll(.reply)) {
                self.broken = true;
                return error.ConnectionFailed;
            }
            if (try self.stepRaw(reply)) return true;
            var fds = [_]std.posix.pollfd{.{ .fd = self.socket(), .events = std.posix.POLL.IN, .revents = 0 }};
            if ((std.posix.poll(&fds, 0) catch 0) == 0) break;
        }
        return false;
    }

    /// Completes a `sendQuery`, waiting for the rest of the reply. The client
    /// query timeout counts from here, when node-pg would have issued it.
    /// Errors: QueryTimeout, ConnectionFailed (the connection is broken).
    pub fn finishRaw(self: *Conn, reply: *RawReply) Error!void {
        const deadline = self.deadlineFromNow();
        while (!try self.flushSome()) {
            if (!waitSocket(self.socket(), std.posix.POLL.OUT | std.posix.POLL.IN, deadline)) {
                self.broken = true;
                return error.QueryTimeout;
            }
            if (!self.consumeAll(.reply)) {
                self.broken = true;
                return error.ConnectionFailed;
            }
        }
        while (!try self.stepRaw(reply)) {
            if (!self.waitInput(deadline)) {
                self.broken = true;
                return error.QueryTimeout;
            }
            if (!self.consumeAll(.reply)) {
                self.broken = true;
                return error.ConnectionFailed;
            }
        }
    }

    /// Takes the results libpq has parsed, without waiting.
    fn stepRaw(self: *Conn, reply: *RawReply) Error!bool {
        if (reply.complete) return true;
        while (PQisBusy(self.pg) == 0) {
            const res = PQgetResult(self.pg) orelse {
                reply.complete = true;
                if (PQstatus(self.pg) != CONNECTION_OK) {
                    self.broken = true;
                    return error.ConnectionFailed;
                }
                return true;
            };
            switch (PQresultStatus(res)) {
                PGRES_TUPLES_OK, PGRES_COMMAND_OK, PGRES_EMPTY_QUERY => if (reply.err == null) {
                    if (reply.tuples) |old| PQclear(old);
                    reply.tuples = res;
                    continue;
                },
                PGRES_FATAL_ERROR => if (reply.err == null) {
                    reply.err = res;
                    continue;
                },
                else => {},
            }
            PQclear(res);
        }
        return false;
    }

    /// TLS without the exact OpenSSL check (`tls`): socket readiness may not
    /// reveal input OpenSSL still holds, so readers must re-poll on a timer.
    pub fn tlsBlind(self: *const Conn) bool {
        return PQsslInUse(self.pg) != 0 and tls.pendingFn() == null;
    }

    /// Abandons a sent query without waiting: a complete reply is drained and
    /// the connection stays usable; otherwise it is marked broken.
    pub fn discardQuery(self: *Conn) void {
        if (PQconsumeInput(self.pg) == 0) {
            self.broken = true;
            return;
        }
        while (PQisBusy(self.pg) == 0) {
            const res = PQgetResult(self.pg) orelse return;
            PQclear(res);
        }
        self.broken = true;
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
                if (self.pipeline(arena, entry, null, values, need, deadline, &local, &failed)) |result| {
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
        return self.pipeline(arena, entry, sql, values, need, deadline, &local, &failed) catch |e| {
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

    /// Executes `entry`, preceded in one round trip (libpq pipeline mode) by
    /// a `plan_cache_mode` switch if this session needs one and by its Parse
    /// when `prepare_sql` is set. `failed` names the step of a server error.
    fn pipeline(self: *Conn, arena: std.mem.Allocator, entry: *const Statements.Entry, prepare_sql: ?[]const u8, values: []const ?[*:0]const u8, need: PlanMode, deadline: ?i64, failure: ?*Failure, failed: *Step) Error!root.Result {
        const switch_mode = self.plan_mode != need;
        failed.* = .execute;
        if (!switch_mode and prepare_sql == null) {
            try self.flushSent(PQsendQueryPrepared(self.pg, entry.nameZ(), @intCast(values.len), values.ptr, null, null, 0), arena, deadline, failure);
            return self.collect(arena, deadline, failure);
        }
        if (PQenterPipelineMode(self.pg) != 1) return self.transportFailure(arena, failure);
        var steps: [3]Step = undefined;
        var n: usize = 0;
        var sent = true;
        if (switch_mode) {
            const set: [*:0]const u8 = if (need == .auto) "SET plan_cache_mode = auto" else "SET plan_cache_mode = force_custom_plan";
            sent = sent and PQsendQueryParams(self.pg, set, 0, null, null, null, null, 0) == 1;
            steps[n] = .set;
            n += 1;
        }
        if (prepare_sql) |sql| {
            const sql_z = try arena.dupeZ(u8, sql);
            sent = sent and PQsendPrepare(self.pg, entry.nameZ(), sql_z, @intCast(values.len), null) == 1;
            steps[n] = .prepare;
            n += 1;
        }
        sent = sent and PQsendQueryPrepared(self.pg, entry.nameZ(), @intCast(values.len), values.ptr, null, null, 0) == 1;
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

    /// `collect` for a pipeline: results of each step (each ended by a null
    /// result) up to the sync point. Rows come from the `execute` step.
    fn collectPipeline(self: *Conn, arena: std.mem.Allocator, steps: []const Step, deadline: ?i64, failure: ?*Failure, failed: *Step) Error!root.Result {
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
            defer PQclear(res);
            const step: Step = if (index < steps.len) steps[index] else .execute;
            switch (PQresultStatus(res)) {
                PGRES_PIPELINE_SYNC => break,
                PGRES_TUPLES_OK, PGRES_COMMAND_OK, PGRES_EMPTY_QUERY => if (!server_error and step == .execute) {
                    result = .{ .rows = try convertRows(arena, res), .row_count = rowCount(res) };
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
        while (true) {
            const flushed = PQflush(self.pg);
            if (flushed == 0) return;
            if (flushed < 0) return self.transportFailure(arena, failure);
            if (!waitSocket(self.socket(), std.posix.POLL.OUT | std.posix.POLL.IN, deadline)) {
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
    fn collectStep(self: *Conn, arena: std.mem.Allocator, reply: *Reply, failure: ?*Failure) Error!bool {
        if (reply.complete) return true;
        while (PQisBusy(self.pg) == 0) {
            const res = PQgetResult(self.pg) orelse {
                reply.complete = true;
                return true;
            };
            defer PQclear(res);
            switch (PQresultStatus(res)) {
                PGRES_TUPLES_OK, PGRES_COMMAND_OK, PGRES_EMPTY_QUERY => if (!reply.server_error) {
                    reply.result = .{ .rows = try convertRows(arena, res), .row_count = rowCount(res) };
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

    /// Waits for more reply input; false only once `deadline` has passed.
    fn waitInput(self: *Conn, deadline: ?i64) bool {
        if (waitSocket(self.socket(), std.posix.POLL.IN, self.inputDeadline(deadline))) return true;
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

fn convertRows(arena: std.mem.Allocator, res: *PGresult) Error![]Value {
    const n_rows: usize = @intCast(PQntuples(res));
    const n_cols: usize = @intCast(PQnfields(res));
    const rows = try arena.alloc(Value, n_rows);
    if (n_rows == 0) return rows;
    const names = try arena.alloc([]const u8, n_cols);
    const oids = try arena.alloc(u32, n_cols);
    // Column slot for each field: duplicates share the first position.
    const slots = try arena.alloc(usize, n_cols);
    var width: usize = 0;
    for (0..n_cols) |c| {
        names[c] = try arena.dupe(u8, std.mem.span(PQfname(res, @intCast(c))));
        oids[c] = PQftype(res, @intCast(c));
        slots[c] = width;
        for (0..c) |prev| {
            if (std.mem.eql(u8, names[prev], names[c])) {
                slots[c] = slots[prev];
                break;
            }
        }
        if (slots[c] == width) width += 1;
    }
    // Copy cell text into large arena chunks (not one allocation per
    // string), then convert in place: string results alias the chunk.
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
                if (chunk.len < n) chunk = try arena.alloc(u8, @max(n, 16 * 1024));
                const cell = chunk[0..n];
                chunk = chunk[n..];
                @memcpy(cell, PQgetvalue(res, ri, ci)[0..n]);
                break :blk try convert.convertCell(arena, oids[c], cell, .borrow);
            };
            row[slots[c]] = .{ .key = names[c], .value = value };
        }
        rows[r] = .{ .object = row };
    }
    return rows;
}

/// Returns the value of `keyword` parsed from a connection string, if set.
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
    if (deadline) |d| if (d - nowMs() <= 0) return false;
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
