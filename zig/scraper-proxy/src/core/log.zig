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
const blocking = @import("blocking.zig");

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
/// `sink != null`, readable without the lock on the hot path.
var sink_set: std.atomic.Value(bool) = .init(false);

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
    sink_set.store(new_sink != null, .release);
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
    if (sink_set.load(.acquire)) {
        output_mutex.lock();
        defer output_mutex.unlock();
        if (sink) |s| return s(sink_ctx, lvl, module orelse "", msg);
    }
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    const w = &out.writer;
    (switch (format) {
        .json => writeJsonLine(w, module, lvl, fields, msg),
        .pretty => writePretty(w, fields, msg),
    }) catch return;
    // stdout like pino; under `zig build test` stdout is the test-runner
    // protocol channel, so tests log to stderr.
    const file = if (builtin.is_test) std.fs.File.stderr() else std.fs.File.stdout();
    output.write(file, out.written(), @intFromEnum(lvl) >= @intFromEnum(Level.@"error"));
}

/// Combining writer: a thread that finds no write in progress writes the
/// pending lines itself (one syscall per line when uncontended, like pino's
/// synchronous stdout); lines logged while another thread is writing are
/// appended and written by that thread in one batch. Per-thread order is
/// kept. Error/fatal callers return only after their line is written (an
/// exit right after them must not lose it). The pending batch is bounded;
/// a full batch blocks callers until written (backpressure, like a sync write).
const Output = struct {
    mutex: std.Thread.Mutex = .{},
    written_cond: std.Thread.Condition = .{},
    pending: std.ArrayList(u8) = .empty,
    spare: std.ArrayList(u8) = .empty,
    writing: bool = false,
    appended: u64 = 0,
    written: u64 = 0,

    const max_pending = 1 << 20;
    const allocator = std.heap.c_allocator;

    fn write(self: *Output, file: std.fs.File, line: []const u8, wait: bool) void {
        self.mutex.lock();
        while (self.writing and self.pending.items.len > 0 and self.pending.items.len + line.len > max_pending) {
            blockingWait(&self.written_cond, &self.mutex);
        }
        if (!self.writing) {
            // Fast path: nothing queued (the writer drains before clearing
            // `writing`), so write this line directly.
            self.writing = true;
            self.appended += 1;
            const seq = self.appended;
            self.mutex.unlock();
            file.writeAll(line) catch {};
            self.mutex.lock();
            self.written = seq;
            self.drainLocked(file);
            self.mutex.unlock();
            return;
        }
        self.pending.appendSlice(allocator, line) catch {
            // Out of memory: wait for the writer, then write directly.
            while (self.writing) blockingWait(&self.written_cond, &self.mutex);
            self.mutex.unlock();
            file.writeAll(line) catch {};
            return;
        };
        self.appended += 1;
        const seq = self.appended;
        if (wait) while (self.written < seq) blockingWait(&self.written_cond, &self.mutex);
        self.mutex.unlock();
    }

    /// Writes queued batches until none is left, then releases the writer role.
    fn drainLocked(self: *Output, file: std.fs.File) void {
        while (self.pending.items.len > 0) {
            std.mem.swap(std.ArrayList(u8), &self.pending, &self.spare);
            const upto = self.appended;
            self.mutex.unlock();
            file.writeAll(self.spare.items) catch {};
            self.spare.clearRetainingCapacity();
            self.mutex.lock();
            self.written = upto;
            self.written_cond.broadcast();
        }
        self.writing = false;
        self.written_cond.broadcast();
    }
};

var output: Output = .{};

/// Waiting for another thread's stdout write (a full pipe can stall it).
fn blockingWait(cond: *std.Thread.Condition, mutex: *std.Thread.Mutex) void {
    blocking.begin();
    defer blocking.end();
    cond.wait(mutex);
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

test "log write throughput to a pipe (opt-in LOG_BENCH=1)" {
    if (std.posix.getenv("LOG_BENCH") == null) return error.SkipZigTest;
    const fds = try std.posix.pipe();
    const reader = try std.Thread.spawn(.{}, struct {
        fn run(fd: std.posix.fd_t) void {
            var buf: [1 << 16]u8 = undefined;
            while (true) {
                const n = std.posix.read(fd, &buf) catch return;
                if (n == 0) return;
            }
        }
    }.run, .{fds[0]});
    const file: std.fs.File = .{ .handle = fds[1] };
    const line = "{\"level\":40,\"time\":1762870000000,\"pid\":1234,\"module\":\"GraphQL\",\"graphqlError\":{\"message\":\"Cannot query field \\\"idx\\\" on type \\\"domain\\\".\"},\"msg\":\"GraphQL request error\"}\n";
    for ([_]usize{ 1, 2, 4, 8, 16 }) |threads| {
        const per: usize = 200_000 / threads;
        const ru0 = std.posix.getrusage(std.posix.rusage.SELF);
        var timer = try std.time.Timer.start();
        var list: [16]std.Thread = undefined;
        for (list[0..threads]) |*t| t.* = try std.Thread.spawn(.{}, struct {
            fn run(f: std.fs.File, n: usize) void {
                for (0..n) |_| output.write(f, line, false);
            }
        }.run, .{ file, per });
        for (list[0..threads]) |t| t.join();
        const wall = timer.read();
        const ru1 = std.posix.getrusage(std.posix.rusage.SELF);
        const cpu_us = (ru1.utime.sec - ru0.utime.sec + ru1.stime.sec - ru0.stime.sec) * 1_000_000 + (ru1.utime.usec - ru0.utime.usec) + (ru1.stime.usec - ru0.stime.usec);
        std.debug.print("log x{d}: {d:.2} us cpu/line (incl. reader), {d:.0} lines/s\n", .{ threads, @as(f64, @floatFromInt(cpu_us)) / @as(f64, @floatFromInt(per * threads)), @as(f64, @floatFromInt(per * threads)) / (@as(f64, @floatFromInt(wall)) / 1e9) });
    }
    std.posix.close(fds[1]);
    reader.join();
    std.posix.close(fds[0]);
}
