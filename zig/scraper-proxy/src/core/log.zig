//! Leveled logger mirroring `@hyperlane-xyz/utils` `rootLogger` (pino):
//! JSON lines `{"level":30,"time":<ms>,"pid":<pid>,"module":"DbService",
//! ...fields,"msg":"..."}` on stdout (the utils bindings formatter keeps only
//! `pid`), `LOG_LEVEL`
//! (trace|debug|info|warn|error|fatal|silent|off|none, default info) and
//! `LOG_FORMAT=pretty` (plain `console.log` of the arguments). Exact bytes are
//! not part of the equivalence bar; events and levels are.
const std = @import("std");
const builtin = @import("builtin");
const json = @import("json.zig");

pub const Level = enum(u8) {
    trace = 10,
    debug = 20,
    info = 30,
    warn = 40,
    @"error" = 50,
    fatal = 60,
    silent = 255,

    pub fn parse(text: []const u8) ?Level {
        if (std.mem.eql(u8, text, "off") or std.mem.eql(u8, text, "none")) return .silent;
        return std.meta.stringToEnum(Level, text);
    }
};

pub const Format = enum { json, pretty };

/// Test hook: receives every enabled log line instead of stdout.
pub const Sink = *const fn (ctx: ?*anyopaque, level: Level, module: []const u8, msg: []const u8) void;

var min_level: std.atomic.Value(u8) = .init(@intFromEnum(Level.info));
var format: Format = .json;
var output_mutex: std.Thread.Mutex = .{};
var sink: ?Sink = null;
var sink_ctx: ?*anyopaque = null;

/// Reads `LOG_LEVEL` / `LOG_FORMAT` like `@hyperlane-xyz/utils` (invalid values ignored).
pub fn configure(env: *const std.process.EnvMap) void {
    if (env.get("LOG_LEVEL")) |raw| if (Level.parse(raw)) |parsed| setLevel(parsed);
    if (env.get("LOG_FORMAT")) |raw| {
        if (std.mem.eql(u8, raw, "pretty")) format = .pretty;
        if (std.mem.eql(u8, raw, "json")) format = .json;
    }
}

pub fn setLevel(new_level: Level) void {
    min_level.store(@intFromEnum(new_level), .release);
}

pub fn level() Level {
    return @enumFromInt(min_level.load(.acquire));
}

/// Install (or clear with null) a capture sink. Not thread-safe against
/// concurrent logging; tests install it before starting work.
pub fn setSink(new_sink: ?Sink, ctx: ?*anyopaque) void {
    output_mutex.lock();
    defer output_mutex.unlock();
    sink = new_sink;
    sink_ctx = ctx;
}

pub const root: Logger = .{ .module = null };

pub fn child(module: []const u8) Logger {
    return .{ .module = module };
}

pub const Logger = struct {
    /// pino child binding `{ module }`; null for the root logger.
    module: ?[]const u8,

    pub fn child(_: Logger, module: []const u8) Logger {
        return .{ .module = module };
    }

    pub fn enabled(_: Logger, lvl: Level) bool {
        return @intFromEnum(lvl) >= min_level.load(.acquire) and lvl != .silent;
    }

    pub fn trace(self: Logger, comptime fmt: []const u8, args: anytype) void {
        self.log(.trace, null, fmt, args);
    }
    pub fn debug(self: Logger, comptime fmt: []const u8, args: anytype) void {
        self.log(.debug, null, fmt, args);
    }
    pub fn info(self: Logger, comptime fmt: []const u8, args: anytype) void {
        self.log(.info, null, fmt, args);
    }
    pub fn warn(self: Logger, comptime fmt: []const u8, args: anytype) void {
        self.log(.warn, null, fmt, args);
    }
    pub fn err(self: Logger, comptime fmt: []const u8, args: anytype) void {
        self.log(.@"error", null, fmt, args);
    }
    pub fn fatal(self: Logger, comptime fmt: []const u8, args: anytype) void {
        self.log(.fatal, null, fmt, args);
    }

    /// pino `logger.warn({ ...fields }, msg)`: `fields` (a JSON object) is
    /// merged into the line before `msg`.
    pub fn withFields(self: Logger, lvl: Level, fields: json.Value, comptime fmt: []const u8, args: anytype) void {
        self.log(lvl, fields, fmt, args);
    }

    pub fn log(self: Logger, lvl: Level, fields: ?json.Value, comptime fmt: []const u8, args: anytype) void {
        if (!self.enabled(lvl)) return;
        const stack_len = 4096;
        var fallback = std.heap.stackFallback(stack_len, std.heap.c_allocator);
        const a = fallback.get();
        const msg = std.fmt.allocPrint(a, fmt, args) catch return;
        defer a.free(msg);
        emit(a, self.module, lvl, fields, msg);
    }
};

fn emit(a: std.mem.Allocator, module: ?[]const u8, lvl: Level, fields: ?json.Value, msg: []const u8) void {
    output_mutex.lock();
    if (sink) |s| {
        defer output_mutex.unlock();
        return s(sink_ctx, lvl, module orelse "", msg);
    }
    output_mutex.unlock();
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    const w = &out.writer;
    (switch (format) {
        .json => writeJsonLine(w, module, lvl, fields, msg),
        .pretty => writePretty(w, fields, msg),
    }) catch return;
    output_mutex.lock();
    defer output_mutex.unlock();
    // stdout like pino; under `zig build test` stdout is the test-runner
    // protocol channel, so tests log to stderr.
    const file = if (builtin.is_test) std.fs.File.stderr() else std.fs.File.stdout();
    file.writeAll(out.written()) catch {};
}

fn writeJsonLine(w: *std.Io.Writer, module: ?[]const u8, lvl: Level, fields: ?json.Value, msg: []const u8) !void {
    try w.print("{{\"level\":{d},\"time\":{d},\"pid\":{d}", .{ @intFromEnum(lvl), std.time.milliTimestamp(), pid() });
    if (module) |m| {
        try w.writeAll(",\"module\":");
        try json.writeString(w, m);
    }
    if (fields) |f| if (f == .object) for (f.object) |member| {
        try w.writeByte(',');
        try json.writeString(w, member.key);
        try w.writeByte(':');
        try json.stringify(w, member.value);
    };
    try w.writeAll(",\"msg\":");
    try json.writeString(w, msg);
    try w.writeAll("}\n");
}

fn writePretty(w: *std.Io.Writer, fields: ?json.Value, msg: []const u8) !void {
    if (fields) |f| {
        try json.stringify(w, f);
        try w.writeByte(' ');
    }
    try w.writeAll(msg);
    try w.writeByte('\n');
}

fn pid() i64 {
    return @intCast(std.c.getpid());
}

/// `formatError` from `@hyperlane-xyz/utils/errors` for a Zig error with an
/// optional message: the message when present, otherwise the error name.
pub fn formatError(e: anyerror, message: ?[]const u8) []const u8 {
    return message orelse @errorName(e);
}

test "level filtering and sink capture" {
    const Capture = struct {
        var count: usize = 0;
        var last: [128]u8 = undefined;
        var last_len: usize = 0;
        fn capture(_: ?*anyopaque, lvl: Level, module: []const u8, msg: []const u8) void {
            _ = lvl;
            _ = module;
            count += 1;
            last_len = @min(msg.len, last.len);
            @memcpy(last[0..last_len], msg[0..last_len]);
        }
    };
    setSink(Capture.capture, null);
    defer setSink(null, null);
    const logger = child("Test");
    logger.debug("hidden {d}", .{1});
    logger.warn("shown {d}", .{2});
    try std.testing.expectEqual(@as(usize, 1), Capture.count);
    try std.testing.expectEqualStrings("shown 2", Capture.last[0..Capture.last_len]);
}

test "json line format" {
    var buf: [512]u8 = undefined;
    var w = std.Io.Writer.fixed(&buf);
    var members = [_]json.Member{.{ .key = "graphqlError", .value = .{ .string = "x" } }};
    try writeJsonLine(&w, "GraphQL", .warn, .{ .object = &members }, "GraphQL request error");
    const line = w.buffered();
    try std.testing.expect(std.mem.startsWith(u8, line, "{\"level\":40,\"time\":"));
    try std.testing.expect(std.mem.endsWith(u8, line, ",\"module\":\"GraphQL\",\"graphqlError\":\"x\",\"msg\":\"GraphQL request error\"}\n"));
}
