//! Source validator.rs cursor initialization: ten completed ordinary failures,
//! two seconds after each (including the tenth), then terminal exhaustion.
//! Cooperative yields/cancellation/refusal/allocation failures are not attempts.
const std = @import("std");
const errors = @import("../../runtime/indexing_observer.zig");
const critical = @import("../../ops/critical_metrics.zig");
pub const State = struct {
    initialized: bool = false,
    failures: u8 = 0,
    retry_at_ms: ?u64 = null,
    exhausted: bool = false,
    pub fn ready(self: *State, now_ms: u64, tracker: ?*critical.Tracker) !bool {
        if (self.initialized) return true;
        if (self.retry_at_ms) |due| if (now_ms < due) return false;
        if (self.failures == 10) {
            self.exhausted = true;
            if (tracker) |sink| sink.record(.merkle_tree_hook_sync);
            return error.ValidatorCursorInitializationExhausted;
        }
        return true;
    }
    pub fn failed(self: *State, err: anyerror, now_ms: u64) !void {
        if (!errors.retryable(err) and err != error.MissingOriginSequenceCount and err != error.MissingEvmCount) return err;
        if (self.initialized or self.failures >= 10) return error.InvalidCursorInitializationState;
        self.failures += 1;
        self.retry_at_ms = now_ms +| 2000;
        std.log.warn("validator cursor initialization attempt {d}/10 failed: {s}", .{ self.failures, @errorName(err) });
    }
    pub fn succeeded(self: *State, tracker: ?*critical.Tracker) void {
        if (self.initialized or self.exhausted) return;
        self.initialized = true;
        self.retry_at_ms = null;
        if (tracker) |sink| sink.started();
    }
};
test "cursor initialization Source ten attempts delays tenth notice and only actual success publishes false" {
    const metrics = @import("../../ops/metrics.zig");
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    var tracker: critical.Tracker = .{ .registry = registry, .chain = "origin" };
    var state: State = .{};
    for (0..10) |i| {
        const now = i * 2000;
        try std.testing.expect(try state.ready(now, &tracker));
        try state.failed(error.RpcHttpStatus, now);
        try std.testing.expect(!try state.ready(now + 1999, &tracker));
    }
    try std.testing.expect(!tracker.published);
    try std.testing.expectError(error.ValidatorCursorInitializationExhausted, state.ready(20000, &tracker));
    try std.testing.expect(tracker.published and tracker.reasons != 0);
    state.succeeded(&tracker);
    try std.testing.expect(!state.initialized);
    // A distinct healthy startup emits false once; arbitrary later healthy
    // observations never call this boundary or clear another failure reason.
    var healthy_tracker: critical.Tracker = .{ .registry = registry, .chain = "healthy" };
    var healthy: State = .{};
    healthy.succeeded(&healthy_tracker);
    try std.testing.expect(healthy.initialized and healthy_tracker.published);
    healthy_tracker.record(.destination_metrics);
    healthy.succeeded(&healthy_tracker);
    try std.testing.expect(healthy_tracker.reasons != 0);
}
test "cursor initialization control failures do not consume a Source attempt" {
    var state: State = .{};
    for ([_]anyerror{ error.PendingReadIo, error.RequestCancelled, error.RequestDeadlineExceeded, error.SourceReadDeadline, error.MessageMetadataRefused, error.ValidatorReorg, error.OutOfMemory }) |err| try std.testing.expectError(err, state.failed(err, 0));
    try std.testing.expectEqual(@as(u8, 0), state.failures);
    // The direct native indexer boundary normalizes completed physical curl
    // timeout to ConnectionTimedOut, distinct from owner control deadlines.
    try state.failed(error.ConnectionTimedOut, 50);
    try std.testing.expectEqual(@as(?u64, 2050), state.retry_at_ms);
}
