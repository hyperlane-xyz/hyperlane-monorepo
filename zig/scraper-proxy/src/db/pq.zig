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
        const deadline: ?i64 = if (self.query_timeout_ms) |ms| (if (ms > 0) nowMs() + @as(i64, @intCast(ms)) else null) else null;
        try self.send(arena, sql, params, deadline, failure);
        return self.collect(arena, deadline, failure) catch |e| {
            // A server error leaves the connection idle and reusable; any
            // other early return (timeout, transport, OOM mid-result) may
            // leave unread results behind, so never reuse it.
            if (e != error.QueryFailed) self.broken = true;
            return e;
        };
    }

    /// node-pg's query_timeout covers sending too: a server that stops
    /// reading cannot block us past the deadline.
    fn send(self: *Conn, arena: std.mem.Allocator, sql: []const u8, params: []const Value, deadline: ?i64, failure: ?*Failure) Error!void {
        const sql_z = try arena.dupeZ(u8, sql);
        const sent = if (params.len == 0) PQsendQuery(self.pg, sql_z) else blk: {
            const values = try arena.alloc(?[*:0]const u8, params.len);
            for (params, values) |p, *v| v.* = if (try convert.prepareValue(arena, p)) |text| text.ptr else null;
            break :blk PQsendQueryParams(self.pg, sql_z, @intCast(params.len), null, values.ptr, null, null, 0);
        };
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
        const n = std.posix.poll(&fds, timeout) catch return false;
        if (n > 0) return true;
    }
}

test "trimMessage strips libpq severity prefixes" {
    try std.testing.expectEqualStrings("password authentication failed for user \"x\"", trimMessage("FATAL:  password authentication failed for user \"x\"\n"));
    try std.testing.expectEqualStrings("could not connect", trimMessage("could not connect\nsecond line\n"));
    try std.testing.expectEqualStrings("database \"x\" does not exist", trimMessage("connection to server at \"127.0.0.1\", port 5 failed: FATAL:  database \"x\" does not exist\n"));
}
