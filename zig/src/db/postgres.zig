//! Bounded native libpq adapter. Nonblocking connect/query polling shares an
//! absolute monotonic deadline and atomic cancellation token. Ambiguous writes
//! poison/close the connection; COMMIT reports unknown outcome explicitly.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Curl = @import("../net/curl.zig");
const PGconn = opaque {};
const PGresult = opaque {};
extern fn PQconnectStart([*:0]const u8) ?*PGconn;
extern fn PQconnectStartParams([*]const ?[*:0]const u8, [*]const ?[*:0]const u8, c_int) ?*PGconn;
extern fn PQconnectPoll(*PGconn) c_int;
extern fn PQsetnonblocking(*PGconn, c_int) c_int;
extern fn PQsocket(*const PGconn) c_int;
extern fn PQsendQueryParams(*PGconn, [*:0]const u8, c_int, ?[*]const u32, ?[*]const ?[*]const u8, ?[*]const c_int, ?[*]const c_int, c_int) c_int;
extern fn PQflush(*PGconn) c_int;
extern fn PQconsumeInput(*PGconn) c_int;
extern fn PQisBusy(*PGconn) c_int;
extern fn PQgetResult(*PGconn) ?*PGresult;
const ConnInfoOption = extern struct { keyword: ?[*:0]const u8, envvar: ?[*:0]const u8, compiled: ?[*:0]const u8, val: ?[*:0]const u8, label: ?[*:0]const u8, dispchar: ?[*:0]const u8, dispsize: c_int };
extern fn PQconninfoParse([*:0]const u8, *?[*:0]u8) ?[*]ConnInfoOption;
extern fn PQconninfoFree([*]ConnInfoOption) void;
extern fn PQstatus(*const PGconn) c_int;
extern fn PQerrorMessage(*const PGconn) [*:0]const u8;
extern fn PQfinish(*PGconn) void;
extern fn PQtransactionStatus(*const PGconn) c_int;
extern fn PQresultStatus(*const PGresult) c_int;
extern fn PQresultErrorMessage(*const PGresult) [*:0]const u8;
extern fn PQresultErrorField(*const PGresult, c_int) ?[*:0]const u8;
extern fn PQclear(*PGresult) void;
extern fn PQntuples(*const PGresult) c_int;
extern fn PQnfields(*const PGresult) c_int;
extern fn PQgetisnull(*const PGresult, c_int, c_int) c_int;
extern fn PQgetvalue(*const PGresult, c_int, c_int) [*]const u8;
extern fn PQgetlength(*const PGresult, c_int, c_int) c_int;
extern fn PQcmdTuples(*PGresult) [*:0]const u8;
extern fn PQfnumber(*const PGresult, [*:0]const u8) c_int;
extern fn PQunescapeBytea([*:0]const u8, *usize) ?[*]u8;
extern fn PQfreemem(?*anyopaque) void;

pub const Oid = struct {
    pub const boolean: u32 = 16;
    pub const bytea: u32 = 17;
    pub const int8: u32 = 20;
    pub const int4: u32 = 23;
    pub const text: u32 = 25;
    pub const float8: u32 = 701;
    pub const numeric: u32 = 1700;
};

pub const Param = struct {
    value: ?[]const u8,
    oid: u32 = 0,
    binary: bool = false,

    pub fn text(value: []const u8) Param {
        return .{ .value = value, .oid = Oid.text };
    }
    pub fn bytes(value: []const u8) Param {
        return .{ .value = value, .oid = Oid.bytea, .binary = true };
    }
    pub fn boolean(value: bool) Param {
        return .{ .value = if (value) "true" else "false", .oid = Oid.boolean };
    }
};

pub const Diagnostic = struct {
    bytes: [2048]u8 = undefined,
    len: usize = 0,
    truncated: bool = false,
    sqlstate: ?[5]u8 = null,

    pub fn message(self: *const Diagnostic) []const u8 {
        return self.bytes[0..self.len];
    }
    fn capture(self: *Diagnostic, message_bytes: []const u8, state: ?[*:0]const u8) void {
        self.len = @min(message_bytes.len, self.bytes.len);
        self.truncated = message_bytes.len > self.bytes.len;
        @memcpy(self.bytes[0..self.len], message_bytes[0..self.len]);
        self.sqlstate = null;
        if (state) |value| {
            const text = std.mem.span(value);
            if (text.len == 5) self.sqlstate = text[0..5].*;
        }
    }
};

pub const Result = struct {
    handle: *PGresult,

    pub fn deinit(self: *Result) void {
        PQclear(self.handle);
        self.* = undefined;
    }
    pub fn rows(self: Result) usize {
        return @intCast(PQntuples(self.handle));
    }
    pub fn columns(self: Result) usize {
        return @intCast(PQnfields(self.handle));
    }
    pub fn column(self: Result, name: [:0]const u8) !usize {
        const index = PQfnumber(self.handle, name);
        if (index < 0) return error.MissingColumn;
        return @intCast(index);
    }
    pub fn value(self: Result, row: usize, field: usize) !?[]const u8 {
        if (row >= self.rows() or field >= self.columns()) return error.ResultBounds;
        const r: c_int = @intCast(row);
        const f: c_int = @intCast(field);
        if (PQgetisnull(self.handle, r, f) != 0) return null;
        const length = PQgetlength(self.handle, r, f);
        if (length < 0) return error.InvalidResultLength;
        return PQgetvalue(self.handle, r, f)[0..@intCast(length)];
    }
    pub fn required(self: Result, row: usize, name: [:0]const u8) ![]const u8 {
        return (try self.value(row, try self.column(name))) orelse error.UnexpectedNull;
    }
    pub fn integer(self: Result, row: usize, name: [:0]const u8) !i64 {
        return std.fmt.parseInt(i64, try self.required(row, name), 10);
    }
    pub fn boolean(self: Result, row: usize, name: [:0]const u8) !bool {
        const text = try self.required(row, name);
        if (std.mem.eql(u8, text, "t")) return true;
        if (std.mem.eql(u8, text, "f")) return false;
        return error.InvalidBooleanResult;
    }
    pub fn bytea(self: Result, allocator: Allocator, row: usize, name: [:0]const u8) ![]u8 {
        const text = try self.required(row, name);
        // PQgetvalue is NUL-terminated for text-format results. Duplicate with
        // a sentinel so this method's ownership/bounds remain explicit.
        const terminated = try allocator.dupeZ(u8, text);
        defer allocator.free(terminated);
        var length: usize = 0;
        const native = PQunescapeBytea(terminated, &length) orelse return error.NativeAllocation;
        defer PQfreemem(native);
        return allocator.dupe(u8, native[0..length]);
    }
    pub fn affected(self: Result) !u64 {
        const text = std.mem.span(PQcmdTuples(self.handle));
        return std.fmt.parseInt(u64, text, 10);
    }
};

/// Deadline uses nowNs()'s monotonic clock and applies to the whole job when
/// reused across statements. timeout_ms is an additional per-operation ceiling.
pub const IoOptions = struct {
    timeout_ms: u32 = 30000,
    deadline_ns: ?u64 = null,
    cancel: ?*const std.atomic.Value(bool) = null,
    /// libpq documents hostname DNS as blocking even in PQconnectPoll. Strict
    /// mode requires explicit numeric host/hostaddr or an explicit Unix socket.
    allow_blocking_dns: bool = false,
    /// Optional vetted async-DNS TCP preconnect. Borrows Client during connect;
    /// no password enters its URL and no HTTP/Postgres application bytes send.
    resolver: ?*Curl.Client = null,
    pub fn validate(self: IoOptions) !void {
        if (self.timeout_ms == 0 or self.timeout_ms > 300000) return error.InvalidPostgresDeadline;
    }
    fn deadline(self: IoOptions) !u64 {
        try self.validate();
        const relative = (try nowNs()) +| @as(u64, self.timeout_ms) * std.time.ns_per_ms;
        return if (self.deadline_ns) |absolute| @min(absolute, relative) else relative;
    }
    fn check(self: IoOptions, deadline_ns: u64) !void {
        if (self.cancel) |cancel| if (cancel.load(.acquire)) return error.PostgresCancelled;
        if (try nowNs() >= deadline_ns) return error.PostgresDeadlineExceeded;
    }
};
pub fn nowNs() !u64 {
    const instant = try std.time.Instant.now();
    return try std.math.add(u64, try std.math.mul(u64, std.math.cast(u64, instant.timestamp.sec) orelse return error.UnsupportedClock, std.time.ns_per_s), @intCast(instant.timestamp.nsec));
}
fn waitSocket(handle: *PGconn, events: i16, options: IoOptions, deadline_ns: u64) !void {
    while (true) {
        try options.check(deadline_ns);
        const socket = PQsocket(handle);
        if (socket < 0) return error.PostgresConnection;
        const remaining = deadline_ns -| try nowNs();
        const millis = @max(1, @min(25, std.math.divCeil(u64, remaining, std.time.ns_per_ms) catch 1));
        var descriptors = [_]std.posix.pollfd{.{ .fd = socket, .events = events, .revents = 0 }};
        if (try std.posix.poll(&descriptors, @intCast(millis)) == 0) continue;
        try options.check(deadline_ns);
        if (descriptors[0].revents & std.posix.POLL.NVAL != 0) return error.PostgresConnection;
        return; // consumeInput/connectPoll resolves HUP/ERR with libpq's state
    }
}
fn resolveConnectionAddress(allocator: Allocator, info: [*:0]const u8, options: IoOptions, deadline_ns: u64) !?[]u8 {
    if (options.allow_blocking_dns and options.resolver == null) return null;
    var message: ?[*:0]u8 = null;
    const parsed = PQconninfoParse(info, &message) orelse {
        if (message) |text| PQfreemem(text);
        return error.InvalidConnectionInfo;
    };
    defer PQconninfoFree(parsed);
    var host: ?[]const u8 = null;
    var addresses: ?[]const u8 = null;
    var port_text: ?[]const u8 = null;
    var index: usize = 0;
    while (parsed[index].keyword) |name| : (index += 1) {
        const value = if (parsed[index].val) |text| std.mem.span(text) else continue;
        if (std.mem.eql(u8, std.mem.span(name), "service") and value.len != 0) return error.UnboundedPostgresDns;
        if (std.mem.eql(u8, std.mem.span(name), "host")) host = value;
        if (std.mem.eql(u8, std.mem.span(name), "hostaddr")) addresses = value;
        if (std.mem.eql(u8, std.mem.span(name), "port")) port_text = value;
    }
    if (addresses) |list| {
        if (list.len != 0) {
            var parts = std.mem.splitScalar(u8, list, ',');
            while (parts.next()) |part| {
                _ = std.net.Address.parseIp(part, 0) catch return error.PostgresMultiHostResolutionUnsupported;
            }
            return null;
        }
    }
    const list = host orelse return error.UnboundedPostgresDns;
    var parts = std.mem.splitScalar(u8, list, ',');
    var needs_dns = false;
    while (parts.next()) |part| {
        if (part.len == 0) return error.UnboundedPostgresDns;
        if (part[0] == '/' or part[0] == '@') continue;
        if ((std.net.Address.parseIp(part, 0) catch null) == null) needs_dns = true;
    }
    if (!needs_dns) return null;
    const resolver = options.resolver orelse return error.UnboundedPostgresDns;
    // libpq's multi-host fallback remains available with explicit hostaddrs or
    // numeric/Unix hosts. Do not collapse a hostname list to one resolved IP.
    if (std.mem.indexOfScalar(u8, list, ',') != null) return error.PostgresMultiHostResolutionUnsupported;
    const environment_port = if (port_text == null) std.process.getEnvVarOwned(allocator, "PGPORT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    } else null;
    defer if (environment_port) |text| allocator.free(text);
    const port = try std.fmt.parseInt(u16, port_text orelse environment_port orelse "5432", 10);
    if (port == 0) return error.InvalidPostgresPort;
    try options.check(deadline_ns);
    const remaining = deadline_ns -| try nowNs();
    const millis: u32 = @intCast(@max(1, @min(options.timeout_ms, try std.math.divCeil(u64, remaining, std.time.ns_per_ms))));
    return resolver.resolveHost(allocator, list, port, millis, options.cancel) catch |err| switch (err) {
        error.RequestCancelled => error.PostgresCancelled,
        error.RequestDeadlineExceeded => error.PostgresDeadlineExceeded,
        else => err,
    };
}

pub const Connection = struct {
    handle: ?*PGconn,
    allocator: Allocator,
    diagnostic: ?*Diagnostic,
    poisoned: bool = false,
    io: IoOptions = .{},

    pub fn connect(allocator: Allocator, conninfo: []const u8, diagnostic: ?*Diagnostic) !Connection {
        return connectWithOptions(allocator, conninfo, diagnostic, .{});
    }
    pub fn connectWithOptions(allocator: Allocator, conninfo: []const u8, diagnostic: ?*Diagnostic, options: IoOptions) !Connection {
        const deadline_ns = try options.deadline();
        try options.check(deadline_ns);
        if (conninfo.len == 0) return error.MissingConnectionInfo;
        if (std.mem.indexOfScalar(u8, conninfo, 0) != null) return error.InvalidConnectionInfo;
        const terminated = try allocator.dupeZ(u8, conninfo);
        defer allocator.free(terminated);
        const resolved = try resolveConnectionAddress(allocator, terminated, options, deadline_ns);
        defer if (resolved) |text| allocator.free(text);
        const hostaddr = if (resolved) |text| try allocator.dupeZ(u8, text) else null;
        defer if (hostaddr) |text| allocator.free(text);
        try options.check(deadline_ns);
        // Expand the exact original conninfo, then override only the network
        // address. Original host remains authoritative for verify-full TLS.
        const keywords = [_]?[*:0]const u8{ "dbname", "hostaddr", null };
        const values = [_]?[*:0]const u8{ terminated, if (hostaddr) |text| text.ptr else null, null };
        const handle = (if (hostaddr != null) PQconnectStartParams(&keywords, &values, 1) else PQconnectStart(terminated)) orelse return error.NativeAllocation;
        errdefer PQfinish(handle);
        if (PQstatus(handle) == 1) {
            if (diagnostic) |out| out.capture(std.mem.span(PQerrorMessage(handle)), null);
            return error.PostgresConnection;
        }
        var status: c_int = 2; // PGRES_POLLING_WRITING before the first poll
        while (true) {
            try options.check(deadline_ns);
            if (status == 1 or status == 2) try waitSocket(handle, if (status == 1) std.posix.POLL.IN else std.posix.POLL.OUT, options, deadline_ns);
            status = PQconnectPoll(handle);
            if (status == 3) break;
            if (status == 0) {
                if (diagnostic) |out| out.capture(std.mem.span(PQerrorMessage(handle)), null);
                return error.PostgresConnection;
            }
            if (status != 1 and status != 2 and status != 4) return error.InvalidPostgresPollingState;
        }
        if (PQsetnonblocking(handle, 1) != 0) return error.PostgresNonblockingFailed;
        return .{ .handle = handle, .allocator = allocator, .diagnostic = diagnostic, .io = options };
    }
    pub fn deinit(self: *Connection) void {
        if (self.handle) |handle| PQfinish(handle);
        self.* = undefined;
    }
    /// Pool reuse requires a healthy protocol stream and no open/aborted transaction.
    pub fn reusable(self: *const Connection) bool {
        if (self.poisoned) return false;
        const handle = self.handle orelse return false;
        return PQstatus(handle) == 0 and PQtransactionStatus(handle) == 0;
    }
    fn poison(self: *Connection) void {
        self.poisoned = true;
        if (self.handle) |handle| PQfinish(handle);
        self.handle = null;
    }
    fn live(self: *Connection) !*PGconn {
        if (self.poisoned) return error.PoisonedConnection;
        return self.handle orelse error.PoisonedConnection;
    }
    /// Results always use text format; bytea() explicitly decodes returned
    /// PostgreSQL bytea rather than treating SQL NULL as an empty value.
    pub fn query(self: *Connection, sql: []const u8, params: []const Param) !Result {
        const handle = try self.live();
        const deadline_ns = try self.io.deadline();
        try self.io.check(deadline_ns);
        if (params.len > 65535) return error.TooManyParameters;
        if (std.mem.indexOfScalar(u8, sql, 0) != null) return error.InvalidSql;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const scratch = arena.allocator();
        const command = try scratch.dupeZ(u8, sql);
        const values = try scratch.alloc(?[*]const u8, params.len);
        const lengths = try scratch.alloc(c_int, params.len);
        const formats = try scratch.alloc(c_int, params.len);
        const types = try scratch.alloc(u32, params.len);
        for (params, 0..) |param, i| {
            types[i] = param.oid;
            formats[i] = @intFromBool(param.binary);
            lengths[i] = 0;
            if (param.value) |value_bytes| {
                if (value_bytes.len > std.math.maxInt(c_int)) return error.ParameterTooLarge;
                lengths[i] = @intCast(value_bytes.len);
                if (param.binary) {
                    values[i] = value_bytes.ptr;
                } else {
                    if (std.mem.indexOfScalar(u8, value_bytes, 0) != null) return error.InvalidTextParameter;
                    values[i] = (try scratch.dupeZ(u8, value_bytes)).ptr;
                }
            } else values[i] = null;
        }
        try self.io.check(deadline_ns); // no statement sent on expired admission
        if (PQsendQueryParams(handle, command, @intCast(params.len), if (params.len == 0) null else types.ptr, if (params.len == 0) null else values.ptr, if (params.len == 0) null else lengths.ptr, if (params.len == 0) null else formats.ptr, 0) == 0) {
            if (self.diagnostic) |out| out.capture(std.mem.span(PQerrorMessage(handle)), null);
            self.poison();
            return error.PostgresQuery;
        }
        // Once submission starts, any transport/deadline/cancel error has an
        // uncertain server outcome. Close rather than recycling or replaying it.
        var completed = false;
        errdefer if (!completed) self.poison();
        while (true) {
            try self.io.check(deadline_ns);
            const flush = PQflush(handle);
            if (flush == 0) break;
            if (flush < 0) return error.PostgresConnection;
            try waitSocket(handle, std.posix.POLL.IN | std.posix.POLL.OUT, self.io, deadline_ns);
            if (PQconsumeInput(handle) == 0) return error.PostgresConnection;
        }
        var result: ?*PGresult = null;
        errdefer if (result) |value| PQclear(value);
        var query_error = false;
        while (true) {
            try self.io.check(deadline_ns);
            if (PQconsumeInput(handle) == 0) return error.PostgresConnection;
            while (PQisBusy(handle) != 0) {
                try waitSocket(handle, std.posix.POLL.IN, self.io, deadline_ns);
                if (PQconsumeInput(handle) == 0) return error.PostgresConnection;
            }
            const value = PQgetResult(handle) orelse break;
            const status = PQresultStatus(value);
            if (status == 3 or status == 4 or status == 8) {
                PQclear(value);
                return error.UnsupportedPostgresCopy;
            }
            if (result) |previous| PQclear(previous);
            result = value;
            if (status != 1 and status != 2) {
                query_error = true;
                if (self.diagnostic) |out| out.capture(std.mem.span(PQresultErrorMessage(value)), PQresultErrorField(value, 'C'));
            }
        }
        completed = true;
        if (query_error or result == null) return error.PostgresQuery;
        return .{ .handle = result.? };
    }

    pub fn execute(self: *Connection, sql: []const u8, params: []const Param) !void {
        var result = try self.query(sql, params);
        defer result.deinit();
    }
    /// Session defaults, initialized while a fresh pooled connection is held
    /// exclusively. Per-job io.deadline_ns/cancel remain authoritative.
    pub fn configureSessionTimeouts(self: *Connection, timeout_ms: u32) !void {
        if (timeout_ms == 0) return error.InvalidScraperDbDeadline;
        var buffer: [32]u8 = undefined;
        const text = try std.fmt.bufPrint(&buffer, "{d}ms", .{timeout_ms});
        try self.execute("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)", &.{Param.text(text)});
    }

    pub fn begin(self: *Connection) !Transaction {
        if (PQtransactionStatus(try self.live()) != 0) return error.AlreadyInTransaction;
        try self.execute("BEGIN", &.{});
        return .{ .connection = self };
    }
};

pub const Transaction = struct {
    connection: *Connection,
    active: bool = true,

    pub fn deinit(self: *Transaction) void {
        if (self.active and self.connection.poisoned) {
            self.active = false;
            return;
        }
        if (self.active) self.rollback() catch |err| {
            self.connection.poisoned = true;
            std.log.err("Postgres transaction rollback failed: {s}", .{@errorName(err)});
        };
    }
    pub fn commit(self: *Transaction) !void {
        if (!self.active) return error.ClosedTransaction;
        const handle = try self.connection.live();
        if (PQtransactionStatus(handle) == 3) return error.TransactionAborted;
        if (PQtransactionStatus(handle) != 2) return error.TransactionState;
        self.connection.execute("COMMIT", &.{}) catch |err| {
            if (self.connection.poisoned) {
                self.active = false;
                return error.CommitOutcomeUnknown;
            }
            return err;
        };
        self.active = false;
    }
    pub fn rollback(self: *Transaction) !void {
        if (!self.active) return error.ClosedTransaction;
        try self.connection.execute("ROLLBACK", &.{});
        self.active = false;
    }
};
