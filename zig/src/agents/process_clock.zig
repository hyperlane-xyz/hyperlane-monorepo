//! Thread-safe process-relative time shared by the scheduler and observations.
//! The owner keeps this immutable start alive until every borrowed callback joins.
const std = @import("std");
const operation = @import("operation.zig");

pub const Clock = struct {
    start: std.time.Instant,

    pub fn init() !Clock {
        return .{ .start = try std.time.Instant.now() };
    }

    pub fn observation(self: *Clock) operation.ObservationClock {
        return .{ .context = self, .now_fn = read };
    }

    fn read(context: *anyopaque) !operation.Times {
        const self: *const Clock = @ptrCast(@alignCast(context));
        const instant = try std.time.Instant.now();
        const unix_ms = std.time.milliTimestamp();
        if (unix_ms < 0) return error.InvalidClock;
        return .{ .unix_ms = @intCast(unix_ms), .monotonic_ms = instant.since(self.start) / std.time.ns_per_ms };
    }
};

test "concurrent observation callbacks share the scheduler epoch" {
    const Reader = struct {
        clock: operation.ObservationClock,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            var previous: u64 = 0;
            for (0..100) |_| {
                const now = self.clock.now() catch |err| {
                    self.failure = err;
                    return;
                };
                if (now.monotonic_ms < previous or now.unix_ms == 0) {
                    self.failure = error.InvalidObservationTime;
                    return;
                }
                previous = now.monotonic_ms;
            }
        }
    };
    var clock = try Clock.init();
    const before = try clock.observation().now();
    var readers: [4]Reader = @splat(.{ .clock = clock.observation() });
    var threads: [4]std.Thread = undefined;
    var started: usize = 0;
    errdefer for (threads[0..started]) |thread| thread.join();
    for (&readers, &threads) |*reader, *thread| {
        thread.* = try std.Thread.spawn(.{}, Reader.run, .{reader});
        started += 1;
    }
    for (threads) |thread| thread.join();
    started = 0;
    for (readers) |reader| try std.testing.expect(reader.failure == null);
    const after = try clock.observation().now();
    try std.testing.expect(after.monotonic_ms >= before.monotonic_ms);
}
