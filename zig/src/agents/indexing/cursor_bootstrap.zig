//! Relayer cursor startup, independent of range fetch retries and metrics.
//! Source sleeps after each of ten failed attempts before marking the task
//! critical. Native owners keep retrying so a genuine cursor plan can recover.
const std = @import("std");
const observation = @import("../../runtime/indexing_observer.zig");
const critical = @import("../../ops/critical_metrics.zig");
pub const reasons = [_]critical.Reason{ .message_sync, .merkle_tree_hook_sync, .gas_payment_sync };
pub const State = struct {
    initialized: bool = false,
    failures: u8 = 0,
    retry_at_ms: u64 = 0,
    pub fn poll(self: *State, now_ms: u64, tracker: ?*critical.Tracker, stream: usize) void {
        if (!self.initialized and self.failures == 10 and now_ms >= self.retry_at_ms) if (tracker) |sink| sink.record(reasons[stream]);
    }
    pub fn failed(self: *State, err: anyerror, now_ms: u64) bool {
        if (self.initialized or !retryable(err)) return false;
        self.failures = @min(10, self.failures + 1);
        self.retry_at_ms = now_ms +| 2000;
        return true;
    }
    pub fn succeeded(self: *State, tracker: ?*critical.Tracker, stream: usize) void {
        if (self.initialized) return;
        self.initialized = true;
        self.retry_at_ms = 0;
        if (tracker) |sink| sink.clear(reasons[stream]);
    }
    pub fn handoff(self: *State) void {
        if (!self.initialized) self.* = .{};
    }
};
pub fn retryable(err: anyerror) bool {
    return observation.retryable(err) or err == error.UpstreamReadTimeout or err == error.MissingOriginSequenceCount or err == error.MissingOriginGasSequenceCount or err == error.MissingEvmCount;
}
test "cursor bootstrap sleeps after tenth failure and clears only recovered stream" {
    var tracker: critical.Tracker = .{};
    tracker.record(.gas_payment_sync);
    tracker.record(.merkle_tree_db_loader);
    var state: State = .{};
    for (0..10) |i| {
        try std.testing.expect(state.failed(error.RpcHttpStatus, i * 2000));
        state.poll(i * 2000 + 1999, &tracker, 0);
        try std.testing.expectEqual(@as(u16, 0), tracker.reasons & (@as(u16, 1) << @intFromEnum(critical.Reason.message_sync)));
    }
    state.poll(20000, &tracker, 0);
    try std.testing.expect(tracker.reasons & (@as(u16, 1) << @intFromEnum(critical.Reason.message_sync)) != 0);
    state.succeeded(&tracker, 0);
    try std.testing.expectEqual((@as(u16, 1) << @intFromEnum(critical.Reason.gas_payment_sync)) | (@as(u16, 1) << @intFromEnum(critical.Reason.merkle_tree_db_loader)), tracker.reasons);
}
test "cursor bootstrap controls and persistence errors do not consume retry budget" {
    var state: State = .{};
    for ([_]anyerror{ error.PendingReadIo, error.PendingIo, error.RequestCancelled, error.OutOfMemory, error.RequestDeadlineExceeded, error.ReadReplayDeadline, error.PoolQueueFull, error.MerkleRootMismatch, error.InputOutput }) |err| try std.testing.expect(!state.failed(err, 0));
    try std.testing.expectEqual(@as(u8, 0), state.failures);
    try std.testing.expect(state.failed(error.ConnectionTimedOut, 123));
    try std.testing.expectEqual(@as(u64, 2123), state.retry_at_ms);
}
