//! Marks a section where the calling thread may block (DB socket wait, pool
//! wait, join). HTTP poller threads install a hook so another poller takes
//! over meanwhile; on any other thread this is a no-op.
pub const Hook = struct {
    ctx: *anyopaque,
    begin: *const fn (ctx: *anyopaque) void,
    end: *const fn (ctx: *anyopaque) void,
};

pub threadlocal var hook: ?Hook = null;

pub inline fn begin() void {
    if (hook) |h| h.begin(h.ctx);
}

pub inline fn end() void {
    if (hook) |h| h.end(h.ctx);
}

/// Grace before a wait counts as blocking (set once by http at startup,
/// before any request; 0 = hand off at once). A short wait that finishes
/// within it keeps the poller and costs no hand-off; the price is that the
/// poller serves nothing else for up to this long.
pub var grace_ns: u64 = 0;

/// Waits up to `grace_ns` for `events` on `fd` without marking the thread
/// blocked. True when the fd is ready (or failed/hung up: the caller's next
/// I/O call reports it); false when the grace ran out or is 0, and the
/// caller should `begin()`, wait, `end()`. Interrupted waits count as not
/// ready.
pub fn graceWait(fd: std.posix.fd_t, events: i16) bool {
    const ns = grace_ns;
    if (ns == 0 or hook == null) return false;
    var fds = [_]std.posix.pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
    const n = if (builtin.os.tag == .linux) blk: {
        const ts: std.posix.timespec = .{ .sec = @intCast(ns / std.time.ns_per_s), .nsec = @intCast(ns % std.time.ns_per_s) };
        break :blk std.posix.ppoll(&fds, &ts, null) catch return false;
    } else blk: {
        // No ppoll (macOS dev builds): millisecond granularity, rounded up.
        const ms: i32 = @intCast(@min((ns + std.time.ns_per_ms - 1) / std.time.ns_per_ms, std.math.maxInt(i32)));
        break :blk std.posix.poll(&fds, ms) catch return false;
    };
    return n > 0;
}

const std = @import("std");
const builtin = @import("builtin");

test "graceWait: zero grace or no hook means not ready" {
    const fds = try std.posix.pipe();
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    try std.testing.expect(!graceWait(fds[0], std.posix.POLL.IN));
    grace_ns = 1_000_000;
    defer grace_ns = 0;
    try std.testing.expect(!graceWait(fds[0], std.posix.POLL.IN)); // no hook installed
}

test "graceWait: ready within the grace, timeout without data" {
    const fds = try std.posix.pipe();
    defer std.posix.close(fds[0]);
    defer std.posix.close(fds[1]);
    const Noop = struct {
        fn f(_: *anyopaque) void {}
    };
    var dummy: u8 = 0;
    hook = .{ .ctx = &dummy, .begin = Noop.f, .end = Noop.f };
    defer hook = null;
    grace_ns = 2_000_000;
    defer grace_ns = 0;
    try std.testing.expect(!graceWait(fds[0], std.posix.POLL.IN));
    _ = try std.posix.write(fds[1], "x");
    try std.testing.expect(graceWait(fds[0], std.posix.POLL.IN));
}
