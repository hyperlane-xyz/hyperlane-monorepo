//! Source fetch-range retry state from hyperlane-base/contract_sync/mod.rs:37-115.
//! One inclusive overlapping union per fetcher/stream, no allocation or clock
//! reads. Error classification and cursor-token retirement belong to the caller.
const std = @import("std");
pub const Range = @import("../../runtime/sequence_cursor.zig").Range;
pub const initial_delay_ms: u64 = 5000;
pub const maximum_delay_ms: u64 = 300000;

pub const State = struct {
    failed_range: ?Range = null,
    consecutive_failures: u32 = 0,
    retry_at_ms: ?u64 = null,

    fn overlaps(left: Range, right: Range) bool {
        return left.from <= right.to and right.from <= left.to;
    }
    pub fn reset(self: *State) void {
        self.* = .{};
    }
    pub fn remainingDelay(self: *const State, range: Range, now_ms: u64) ?u64 {
        const failed = self.failed_range orelse return null;
        if (!overlaps(failed, range)) return null;
        const deadline = self.retry_at_ms orelse return null;
        return if (deadline > now_ms) deadline - now_ms else null;
    }
    /// Expiry permits an overlapping retry but does not reset failures. Disjoint
    /// work bypasses this state without clearing the pending retry's metric.
    pub fn retryEligible(self: *const State, range: Range, now_ms: u64) bool {
        const failed = self.failed_range orelse return false;
        return overlaps(failed, range) and self.remainingDelay(range, now_ms) == null;
    }
    /// Source resets the entire failed union on any overlapping successful
    /// fetch, including an empty response; unrelated success leaves it intact.
    pub fn recordSuccess(self: *State, range: Range) bool {
        const failed = self.failed_range orelse return false;
        if (!overlaps(failed, range)) return false;
        self.reset();
        return true;
    }
    pub fn recordFailure(self: *State, range: Range, now_ms: u64) u64 {
        if (self.failed_range) |failed| {
            if (overlaps(failed, range)) {
                self.failed_range = .{ .from = @min(failed.from, range.from), .to = @max(failed.to, range.to) };
            } else {
                self.reset();
                self.failed_range = range;
            }
        } else {
            self.reset();
            self.failed_range = range;
        }
        self.consecutive_failures +|= 1;
        const exponent: u6 = @intCast(@min(self.consecutive_failures - 1, 6));
        const delay = @min(initial_delay_ms * (@as(u64, 1) << exponent), maximum_delay_ms);
        // Mirrors Source Instant::checked_add: an unrepresentable deadline is
        // absent, rather than wrapping into the past or inventing an endless wait.
        self.retry_at_ms = if (std.math.add(u64, now_ms, delay)) |deadline| deadline else |_| null;
        return delay;
    }
};

test "fetch backoff matches Source exact delays and deadline eligibility without clearing state" {
    var state: State = .{};
    const range: Range = .{ .from = 7, .to = 9 };
    try std.testing.expect(state.remainingDelay(range, 100) == null);
    try std.testing.expect(!state.retryEligible(range, 100));
    var now: u64 = 100;
    for ([_]u64{ 5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000 }, 1..) |delay, failures| {
        try std.testing.expectEqual(delay, state.recordFailure(range, now));
        try std.testing.expectEqual(@as(u32, @intCast(failures)), state.consecutive_failures);
        try std.testing.expectEqual(delay, state.remainingDelay(range, now).?);
        try std.testing.expect(!state.retryEligible(range, now));
        now += delay;
        try std.testing.expectEqual(@as(u64, 1), state.remainingDelay(range, now - 1).?);
        try std.testing.expect(state.remainingDelay(range, now) == null);
        try std.testing.expect(state.retryEligible(range, now));
        try std.testing.expect(state.retryEligible(range, now + 1));
        try std.testing.expectEqual(range, state.failed_range.?);
    }
}

test "fetch backoff moving ranges union inclusively and partial overlapping success resets all" {
    var state: State = .{};
    try std.testing.expectEqual(@as(u64, 5000), state.recordFailure(.{ .from = 7, .to = 9 }, 0));
    try std.testing.expectEqual(@as(u64, 10000), state.recordFailure(.{ .from = 9, .to = 12 }, 5000));
    try std.testing.expectEqual(Range{ .from = 7, .to = 12 }, state.failed_range.?);
    try std.testing.expectEqual(@as(u64, 20000), state.recordFailure(.{ .from = 8, .to = 15 }, 15000));
    try std.testing.expectEqual(Range{ .from = 7, .to = 15 }, state.failed_range.?);
    try std.testing.expect(state.recordSuccess(.{ .from = 10, .to = 20 }));
    try std.testing.expectEqualDeep(State{}, state);
    try std.testing.expect(!state.recordSuccess(.{ .from = 7, .to = 9 }));
    try std.testing.expectEqual(@as(u64, 5000), state.recordFailure(.{ .from = 8, .to = 15 }, 35000));
}

test "fetch backoff disjoint forward success bypasses without pruning and disjoint failure restarts" {
    var state: State = .{};
    const failed: Range = .{ .from = 7, .to = 9 };
    const forward: Range = .{ .from = 10, .to = 12 };
    _ = state.recordFailure(failed, 100);
    const saved = state;
    for ([_]u64{ 100, 5099, 5100, 999999 }) |now| {
        try std.testing.expect(state.remainingDelay(forward, now) == null);
        try std.testing.expect(!state.retryEligible(forward, now));
        try std.testing.expect(!state.recordSuccess(forward));
        try std.testing.expectEqualDeep(saved, state);
    }
    try std.testing.expectEqual(@as(u64, 10000), state.recordFailure(failed, 5100));
    try std.testing.expectEqual(@as(u64, 5000), state.recordFailure(forward, 6000));
    try std.testing.expectEqual(@as(u32, 1), state.consecutive_failures);
    try std.testing.expectEqual(forward, state.failed_range.?);
    try std.testing.expect(state.remainingDelay(failed, 6000) == null);
    try std.testing.expectEqual(@as(u64, 5000), state.remainingDelay(forward, 6000).?);
}

test "fetch backoff endpoint boundaries do not overflow or mistake adjacency for overlap" {
    var state: State = .{};
    const last = std.math.maxInt(u32);
    _ = state.recordFailure(.{ .from = 0, .to = 0 }, 0);
    try std.testing.expect(state.remainingDelay(.{ .from = 1, .to = last }, 1) == null);
    try std.testing.expectEqual(@as(u64, 5000), state.recordFailure(.{ .from = last, .to = last }, 1));
    try std.testing.expect(state.remainingDelay(.{ .from = 0, .to = last - 1 }, 1) == null);
    try std.testing.expectEqual(@as(u64, 10000), state.recordFailure(.{ .from = 0, .to = last }, 5001));
    try std.testing.expectEqual(Range{ .from = 0, .to = last }, state.failed_range.?);
    try std.testing.expect(state.recordSuccess(.{ .from = last, .to = last }));
    try std.testing.expectEqualDeep(State{}, state);
}

test "fetch backoff saturates failure count and preserves checked clock overflow semantics" {
    var state: State = .{};
    const range: Range = .{ .from = 7, .to = 9 };
    _ = state.recordFailure(range, 0);
    state.consecutive_failures = std.math.maxInt(u32);
    try std.testing.expectEqual(maximum_delay_ms, state.recordFailure(range, 100));
    try std.testing.expectEqual(std.math.maxInt(u32), state.consecutive_failures);
    try std.testing.expectEqual(maximum_delay_ms, state.recordFailure(range, std.math.maxInt(u64)));
    try std.testing.expect(state.retry_at_ms == null);
    try std.testing.expect(state.retryEligible(range, std.math.maxInt(u64)));
    state.reset();
    try std.testing.expectEqualDeep(State{}, state);
}

test "fetch backoff has independent bounded state for the three origin streams" {
    var states: [3]State = @splat(.{});
    _ = states[0].recordFailure(.{ .from = 0, .to = 100 }, 1000);
    _ = states[1].recordFailure(.{ .from = 0, .to = 100 }, 1000);
    _ = states[1].recordFailure(.{ .from = 100, .to = 200 }, 1000);
    try std.testing.expectEqual(@as(u64, 5000), states[0].remainingDelay(.{ .from = 50, .to = 50 }, 1000).?);
    try std.testing.expectEqual(@as(u64, 10000), states[1].remainingDelay(.{ .from = 50, .to = 50 }, 1000).?);
    try std.testing.expect(states[2].remainingDelay(.{ .from = 0, .to = 100 }, 1000) == null);
    try std.testing.expect(@sizeOf(State) <= 48);
}

test "fetch backoff all small inclusive intervals agree with actual point intersection" {
    for (0..9) |first_from| for (first_from..9) |first_to| {
        var state: State = .{};
        _ = state.recordFailure(.{ .from = @intCast(first_from), .to = @intCast(first_to) }, 100);
        for (0..9) |second_from| for (second_from..9) |second_to| {
            var intersection = false;
            for (0..9) |point| if (first_from <= point and point <= first_to and second_from <= point and point <= second_to) {
                intersection = true;
            };
            const query: Range = .{ .from = @intCast(second_from), .to = @intCast(second_to) };
            try std.testing.expectEqual(intersection, state.remainingDelay(query, 101) != null);
            try std.testing.expectEqual(intersection, state.retryEligible(query, 5100));
        };
    };
}
