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
extern "pq" fn PQflush(conn: *PGconn) c_int;
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

pub const QueryOptions = struct {
    /// Run as a per-connection named prepared statement so PostgreSQL can
    /// switch to a generic plan after its usual five custom plans
    /// (`plan_cache_mode=auto`), skipping planning on later executions.
    /// Only for shapes whose generic plan is known to match the custom one
    /// (unique-key lookups, fixed SQL); everything else stays an unnamed
    /// statement, custom-planned on every execution like node-pg.
    reuse_plan: bool = false,
    /// Pool-wide switch that turns `reuse_plan` off (set by `Pool`).
    guard: ?*ReuseGuard = null,
};

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
    /// Named statements (`QueryOptions.reuse_plan`), allocated on first use.
    statements: ?*Statements = null,

    /// Connects within `connect_timeout_ms`. Failure messages follow node-pg:
    /// timeout -> "Connection terminated due to connection timeout", other
    /// failures -> libpq's message (trimmed).
    pub fn connect(opts: ConnOptions, arena: std.mem.Allocator, failure: ?*Failure) Error!Conn {
        var scratch = std.heap.ArenaAllocator.init(std.heap.c_allocator);
        defer scratch.deinit();
        const a = scratch.allocator();
        const conninfo = try a.dupeZ(u8, opts.conninfo);
        var options: std.ArrayList(u8) = .empty;
        if (existingOption(conninfo, "options")) |existing| {
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
        const reuse = opts.reuse_plan and params.len > 0 and (if (opts.guard) |g| g.active() else true);
        const result = if (reuse)
            self.runNamed(arena, sql, params, opts.guard, deadline, failure)
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
        const sql_z = try arena.dupeZ(u8, sql);
        const sent = if (params.len == 0) PQsendQuery(self.pg, sql_z) else blk: {
            const values = try textParams(arena, params);
            break :blk PQsendQueryParams(self.pg, sql_z, @intCast(params.len), null, values.ptr, null, null, 0);
        };
        try self.flushSent(sent, arena, deadline, failure);
        return self.collect(arena, deadline, failure);
    }

    /// Executes `sql` as this connection's named statement, preparing it
    /// first (one extra round trip) when it is not cached yet. Parse and
    /// bind errors carry the same server messages as the unnamed path.
    fn runNamed(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, guard: ?*ReuseGuard, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        const statements = self.statements orelse blk: {
            const s = try std.heap.c_allocator.create(Statements);
            s.* = .{};
            self.statements = s;
            break :blk s;
        };
        var evict: ?*Statements.Entry = null;
        switch (statements.decide(sql)) {
            .unnamed => return self.runUnnamed(arena, sql, params, deadline, failure),
            .prepare => |old| evict = old,
            .hit => |entry| {
                var local: Failure = .{};
                if (self.executeNamed(arena, entry, try textParams(arena, params), deadline, &local)) |result| {
                    return result;
                } else |e| {
                    const code = serverCode(e, local);
                    if (std.mem.eql(u8, code, RESULT_TYPE_CHANGED)) {
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
                // Housekeeping must not fail the caller's query.
                return self.retryUnnamed(arena, sql, params, guard, serverCode(e, local), deadline, failure);
            };
            statements.remove(old);
        }
        const entry = try statements.add(sql);
        var local: Failure = .{};
        self.prepare(arena, entry, sql, params.len, deadline, &local) catch |e| {
            statements.remove(entry);
            const code = serverCode(e, local);
            if (isPoolerCode(code)) return self.retryUnnamed(arena, sql, params, guard, code, deadline, failure);
            // Parse errors carry the same server message as the unnamed path.
            return pass(failure, local, e);
        };
        local = .{};
        return self.executeNamed(arena, entry, try textParams(arena, params), deadline, &local) catch |e| {
            const code = serverCode(e, local);
            if (isPoolerCode(code)) {
                statements.remove(entry);
                return self.retryUnnamed(arena, sql, params, guard, code, deadline, failure);
            }
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

    fn prepare(self: *Conn, arena: std.mem.Allocator, entry: *const Statements.Entry, sql: []const u8, n_params: usize, deadline: ?i64, failure: ?*Failure) Error!void {
        const sql_z = try arena.dupeZ(u8, sql);
        try self.flushSent(PQsendPrepare(self.pg, entry.nameZ(), sql_z, @intCast(n_params), null), arena, deadline, failure);
        _ = try self.collect(arena, deadline, failure);
    }

    fn executeNamed(self: *Conn, arena: std.mem.Allocator, entry: *const Statements.Entry, values: []const ?[*:0]const u8, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        try self.flushSent(PQsendQueryPrepared(self.pg, entry.nameZ(), @intCast(values.len), values.ptr, null, null, 0), arena, deadline, failure);
        return self.collect(arena, deadline, failure);
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
            if (PQconsumeInput(self.pg) == 0) return self.transportFailure(arena, failure);
        }
    }

    fn collect(self: *Conn, arena: std.mem.Allocator, deadline: ?i64, failure: ?*Failure) Error!root.Result {
        var result: root.Result = .{ .rows = &.{}, .row_count = 0 };
        var server_error: bool = false;
        while (true) {
            while (PQisBusy(self.pg) != 0) {
                if (!waitSocket(self.socket(), std.posix.POLL.IN, deadline)) {
                    self.broken = true;
                    setFailure(failure, arena, "Query read timeout", null);
                    return error.QueryTimeout;
                }
                if (PQconsumeInput(self.pg) == 0) return self.transportFailure(arena, failure);
            }
            const res = PQgetResult(self.pg) orelse break;
            defer PQclear(res);
            switch (PQresultStatus(res)) {
                PGRES_TUPLES_OK, PGRES_COMMAND_OK, PGRES_EMPTY_QUERY => if (!server_error) {
                    result = .{ .rows = try convertRows(arena, res), .row_count = rowCount(res) };
                },
                PGRES_FATAL_ERROR => if (!server_error) {
                    server_error = true;
                    const message = if (PQresultErrorField(res, PG_DIAG_MESSAGE_PRIMARY)) |m| std.mem.span(m) else trimMessage(std.mem.span(PQerrorMessage(self.pg)));
                    const code = if (PQresultErrorField(res, PG_DIAG_SQLSTATE)) |c| std.mem.span(c) else null;
                    setFailure(failure, arena, message, code);
                },
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

    fn transportFailure(self: *Conn, arena: std.mem.Allocator, failure: ?*Failure) Error {
        self.broken = true;
        setFailure(failure, arena, "Connection terminated unexpectedly", null);
        return error.ConnectionFailed;
    }

    /// Reads pending input and returns the next queued notification (caller
    /// frees with `freeNotify`). Returns error.ConnectionFailed on EOF.
    pub fn consume(self: *Conn) Error!void {
        if (PQconsumeInput(self.pg) == 0 or PQstatus(self.pg) != CONNECTION_OK) {
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
    while (true) {
        var timeout: i32 = -1;
        if (deadline) |d| {
            const remaining = d - nowMs();
            if (remaining <= 0) return false;
            timeout = @intCast(@min(remaining, std.math.maxInt(i32)));
        }
        var fds = [_]std.posix.pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
        // Let an HTTP poller thread hand off its work while this one sleeps.
        core.blocking.begin();
        defer core.blocking.end();
        const n = std.posix.poll(&fds, timeout) catch return false;
        if (n > 0) return true;
    }
}

test "trimMessage strips libpq severity prefixes" {
    try std.testing.expectEqualStrings("password authentication failed for user \"x\"", trimMessage("FATAL:  password authentication failed for user \"x\"\n"));
    try std.testing.expectEqualStrings("could not connect", trimMessage("could not connect\nsecond line\n"));
    try std.testing.expectEqualStrings("database \"x\" does not exist", trimMessage("connection to server at \"127.0.0.1\", port 5 failed: FATAL:  database \"x\" does not exist\n"));
}
