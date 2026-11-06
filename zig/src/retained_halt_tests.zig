const std = @import("std");
const supervisor = @import("runtime/supervisor.zig");
const lane = @import("runtime/lane_owner.zig");
const Fixture = struct {
    owner: lane.Owner = undefined,
    entered: std.atomic.Value(bool) = .init(false),
    release: std.atomic.Value(bool) = .init(false),
    fatal: std.atomic.Value(bool) = .init(false),
    effects: std.atomic.Value(u32) = .init(0),
    finished: std.atomic.Value(bool) = .init(false),
    fn work(ctx: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        self.entered.store(true, .release);
        while (!self.release.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
        if (!cancel.load(.acquire)) _ = self.effects.fetchAdd(1, .acq_rel);
        self.finished.store(true, .release);
        return .{};
    }
    fn poll(ctx: *anyopaque, t: supervisor.Times, c: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        return try self.owner.poll(t, c) orelse error.PendingReadIo;
    }
    fn fail(ctx: *anyopaque, _: supervisor.Times, _: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        if (self.fatal.load(.acquire)) return error.ValidatorReorg;
        return error.PendingReadIo;
    }
    fn stop(ctx: *anyopaque) void {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        self.owner.requestStop();
    }
    fn classify(err: anyerror) supervisor.FailureAction {
        return if (err == error.PendingReadIo) .retry else .halt_all;
    }
};
test "global halt cancels retained effects after polling callback yielded" {
    var f: Fixture = .{};
    f.owner = try lane.Owner.init(&f, Fixture.work, .{ .timeout_ms = 10000 });
    const root = try supervisor.Supervisor.start(std.testing.allocator, &.{ .{ .context = &f, .run = Fixture.poll, .stop_fn = Fixture.stop, .interval_ms = 1, .timeout_ms = 10000 }, .{ .context = &f, .run = Fixture.fail, .failure = Fixture.classify, .interval_ms = 1, .timeout_ms = 10000 } });
    defer {
        f.release.store(true, .release);
        f.owner.deinit();
        root.deinit();
    }
    var timer = try std.time.Timer.start();
    while (!f.entered.load(.acquire)) {
        const ms = timer.read() / std.time.ns_per_ms;
        if (ms > 3000) return error.ReproTimeout;
        _ = try root.tick(.{ .unix_ms = ms, .monotonic_ms = ms });
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // Let PIO completion clear the supervisor's active slot before fatal result.
    for (0..5) |_| {
        const ms = timer.read() / std.time.ns_per_ms;
        _ = try root.tick(.{ .unix_ms = ms, .monotonic_ms = ms });
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(!f.owner.cancel.load(.acquire));
    f.fatal.store(true, .release);
    while (root.failureReason() == null) {
        const ms = timer.read() / std.time.ns_per_ms;
        if (ms > 3000) return error.ReproTimeout;
        _ = try root.tick(.{ .unix_ms = ms, .monotonic_ms = ms });
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(error.ValidatorReorg, root.failureReason().?);
    try std.testing.expect(f.owner.cancel.load(.acquire));
    f.release.store(true, .release);
    while (!f.finished.load(.acquire)) {
        if (timer.read() > 4 * std.time.ns_per_s) return error.ReproTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(u32, 0), f.effects.load(.acquire));
}
