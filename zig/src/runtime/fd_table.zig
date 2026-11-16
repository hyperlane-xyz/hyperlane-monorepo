//! Startup sizing of the process file-descriptor table (Linux).
//!
//! Linux grows a process's fd table on demand. Once the table is shared by
//! more than one thread, each growth waits an RCU grace period
//! (expand_files -> synchronize_rcu, measured 20-40 ms on the bench hosts)
//! while every thread that allocates an fd (socket, pipe, accept, openat)
//! blocks in D state. The agents cross the default 64-entry table during
//! their startup burst, stalling e.g. the /metrics server's accept. Growing
//! the table once at entry, while the process is still single-threaded,
//! costs no grace period.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;

/// Table size reserved at startup (bounded by RLIMIT_NOFILE); a few pages.
pub const reserved_fds: usize = 4096;

/// Call first in main, before any thread exists. Returns the table size
/// reserved (0 when not applicable or not possible).
pub fn reserve(target: usize) usize {
    if (comptime builtin.os.tag != .linux) return 0;
    const limit = posix.getrlimit(.NOFILE) catch |err| return failed(err);
    const size: usize = @intCast(@min(@as(u64, target), limit.cur));
    if (size <= 64) return 0;
    const base = posix.openZ("/dev/null", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0) catch |err| return failed(err);
    defer posix.close(base);
    // The lowest free descriptor at or above size - 1: the kernel sizes the
    // table to hold it, then the descriptor is closed again.
    const high = posix.fcntl(base, posix.F.DUPFD, size - 1) catch |err| return failed(err);
    posix.close(@intCast(high));
    return size;
}

fn failed(err: anyerror) usize {
    std.log.warn("fd table reservation skipped: {s}", .{@errorName(err)});
    return 0;
}

test "startup reservation sizes the fd table without leaking descriptors" {
    if (comptime builtin.os.tag != .linux) {
        try std.testing.expectEqual(@as(usize, 0), reserve(reserved_fds));
        return;
    }
    const before = try posix.openZ("/dev/null", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
    posix.close(before);
    const size = reserve(256);
    const after = try posix.openZ("/dev/null", .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
    defer posix.close(after);
    // Descriptor numbering is unchanged: the probe fds were closed.
    try std.testing.expectEqual(before, after);
    if (size == 0) return;
    var buffer: [4096]u8 = undefined;
    const file = try std.fs.openFileAbsolute("/proc/self/status", .{});
    defer file.close();
    const status = buffer[0..try file.readAll(&buffer)];
    const at = std.mem.indexOf(u8, status, "FDSize:") orelse return error.MissingFdSize;
    var fields = std.mem.tokenizeAny(u8, status[at + "FDSize:".len ..], " \t\n");
    try std.testing.expect(try std.fmt.parseInt(usize, fields.next() orelse return error.MissingFdSize, 10) >= size);
}
