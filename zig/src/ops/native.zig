//! Native runtime-denylist boundary. Its configured URL is operator-trusted;
//! libcurl owns TLS/DNS and enforces the source's ten-second fetch deadline.
const std = @import("std");
const curl = @import("../net/curl.zig");
const denylist = @import("runtime_denylist.zig");

pub const DenylistTransport = struct {
    client: *curl.Client,
    cancel: ?*const std.atomic.Value(bool) = null,

    pub fn interface(self: *DenylistTransport) denylist.Transport {
        return .{ .context = self, .fetch = fetch };
    }

    fn fetch(context: *anyopaque, a: std.mem.Allocator, url: []const u8, limit: usize) !denylist.Fetched {
        const self: *DenylistTransport = @ptrCast(@alignCast(context));
        var response = try self.client.send(a, .{ .url = url, .method = .get, .timeout_ms = denylist.fetch_timeout_ms, .connect_timeout_ms = denylist.fetch_timeout_ms, .max_response_bytes = limit, .cancel = self.cancel });
        defer response.deinit();
        return .{ .allocator = a, .status = response.status, .bytes = try a.dupe(u8, response.body) };
    }
};

/// Clock callbacks capture no wall time; each invocation observes current UTC.
pub const Clock = struct {
    pub fn interface(self: *Clock) denylist.Clock {
        return .{ .context = self, .now_unix = seconds, .now_ns = nanos };
    }
    fn seconds(_: *anyopaque) i64 {
        return std.time.timestamp();
    }
    fn nanos(_: *anyopaque) i128 {
        return std.time.nanoTimestamp();
    }
};

/// Startup retries can be interrupted by signal/job cancellation. The caller
/// checks cancellation again before dispatching another fetch.
pub const Sleeper = struct {
    cancel: *const std.atomic.Value(bool),
    pub fn interface(self: *Sleeper) denylist.Sleeper {
        return .{ .context = self, .sleep_ms = sleep };
    }
    fn sleep(context: *anyopaque, milliseconds: u64) void {
        const self: *Sleeper = @ptrCast(@alignCast(context));
        var timer = std.time.Timer.start() catch return;
        const duration = milliseconds *| std.time.ns_per_ms;
        while (!self.cancel.load(.acquire)) {
            const elapsed = timer.read();
            if (elapsed >= duration) return;
            std.Thread.sleep(@min(duration - elapsed, 20 * std.time.ns_per_ms));
        }
    }
};
