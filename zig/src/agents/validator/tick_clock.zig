//! One owner-thread tick's injected base plus actual elapsed I/O time. The
//! scheduler receives remaining time to an absolute due point at return.
const std = @import("std");
pub const Clock = struct {
    base_ms: u64 = 0,
    elapsed: ?std.time.Timer = null,
    pub fn begin(self: *Clock, now_ms: u64) !void {
        self.* = .{ .base_ms = now_ms, .elapsed = try std.time.Timer.start() };
    }
    pub fn end(self: *Clock) void {
        self.elapsed = null;
    }
    pub fn now(self: *Clock, fallback_ms: u64) u64 {
        return if (self.elapsed) |*timer| self.base_ms +| timer.read() / std.time.ns_per_ms else fallback_ms;
    }
};
