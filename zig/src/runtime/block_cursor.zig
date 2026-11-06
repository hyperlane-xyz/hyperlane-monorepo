//! Rust RateLimitedContractSyncCursor's unsequenced forward cursor. The event
//! owner persists watermark BEFORE advancing, after idempotent event storage.
const std = @import("std");
const sequence = @import("sequence_cursor.zig");
pub const Options = struct { chunk: u32, lowest: i64, idle_ms: u64 = 5000, configured_interval_ms: ?u64 = null };
pub const Action = union(enum) { query: sequence.Range, sleep_until_ms: u64 };
pub const Cursor = struct {
    options: Options,
    start: u32,
    next: u32,
    tip: u32,
    refreshed_ms: u64,
    pending: ?sequence.Range = null,
    remaining_to: ?u32 = null,
    pub fn init(tip: u32, saved_watermark: ?u32, now_ms: u64, options: Options) !Cursor {
        if (options.idle_ms == 0 or options.chunk > 65535 or options.configured_interval_ms == 0) return error.InvalidBlockCursorOptions;
        const lowest: u32 = if (options.lowest < 0) @intCast(@max(0, @as(i64, tip) +| options.lowest)) else std.math.cast(u32, options.lowest) orelse return error.IndexHeightOutOfRange;
        const start = @max(lowest, saved_watermark orelse lowest);
        return .{ .options = options, .start = start, .next = start, .tip = tip, .refreshed_ms = now_ms };
    }
    /// Call rateLimit before refreshing finalized head: source preserves the
    /// 30s default unless the operator explicitly configured an interval.
    pub fn rateLimit(self: Cursor, now_ms: u64) ?u64 {
        if (self.remaining_to) |target| if (self.next <= target) return null;
        if (self.next +| self.options.chunk < self.tip) return null;
        const ready = self.refreshed_ms +| (self.options.configured_interval_ms orelse 30000);
        return if (now_ms < ready) ready else null;
    }
    pub fn plan(self: *Cursor, finalized: u32, now_ms: u64) !Action {
        if (self.pending != null) return error.CursorQueryInFlight;
        if (self.rateLimit(now_ms)) |ready| return .{ .sleep_until_ms = ready };
        if (self.next > finalized) return .{ .sleep_until_ms = now_ms +| self.options.idle_ms };
        const range: sequence.Range = .{ .from = self.next, .to = @min(finalized, self.remaining_to orelse self.next +| self.options.chunk) };
        self.pending = range;
        return .{ .query = range };
    }
    /// Slice one already-admitted query without reducing its conservative
    /// replay watermark or adding near-head idle sleeps between its pieces.
    pub fn limitQuery(self: *Cursor, max_steps: u32) !sequence.Range {
        if (max_steps == 0) return error.InvalidBlockQueryLimit;
        const range = if (self.pending) |*value| value else return error.NoCursorQuery;
        const end = @min(range.to, range.from +| (max_steps - 1));
        if (end < range.to and self.remaining_to == null) self.remaining_to = range.to;
        range.to = end;
        return range.*;
    }
    pub fn watermark(self: Cursor) u32 {
        return @max(self.start, self.next -| self.options.chunk);
    }
    pub fn failed(self: *Cursor) void {
        self.pending = null;
    }
    pub fn update(self: *Cursor, new_tip: u32, now_ms: u64) !void {
        const range = self.pending orelse return error.NoCursorQuery;
        self.next = range.to +| 1;
        self.tip = new_tip;
        self.refreshed_ms = now_ms;
        self.pending = null;
        if (self.remaining_to) |target| if (range.to >= target) {
            self.remaining_to = null;
        };
    }
};
test "block cursor preserves configured polling conservative replay and relative start" {
    var cursor = try Cursor.init(100, 20, 0, .{ .chunk = 9, .lowest = -200 });
    try std.testing.expectEqual(@as(u32, 20), cursor.start);
    try std.testing.expectEqual(Action{ .query = .{ .from = 20, .to = 29 } }, try cursor.plan(100, 0));
    try std.testing.expectEqual(@as(u32, 20), cursor.watermark());
    try cursor.update(100, 0);
    while (cursor.next +| 9 < 100) {
        _ = try cursor.plan(100, 0);
        try cursor.update(100, 0);
    }
    try std.testing.expectEqual(@as(?u64, 30000), cursor.rateLimit(1));
    cursor.options.configured_interval_ms = 1000;
    try std.testing.expectEqual(@as(?u64, null), cursor.rateLimit(1000));
    const action = try cursor.plan(100, 1000);
    try std.testing.expect(action == .query);
    cursor.failed();
    try std.testing.expectEqual(action, try cursor.plan(100, 1000));
}

test "cooperative block slices finish original range before rate limit and preserve configured watermark" {
    var cursor = try Cursor.init(9, null, 0, .{ .chunk = 9, .lowest = 0, .idle_ms = 1000 });
    try std.testing.expectEqual(Action{ .sleep_until_ms = 30000 }, try cursor.plan(9, 0));
    const admitted = try cursor.plan(9, 30000);
    try std.testing.expectEqual(sequence.Range{ .from = 0, .to = 9 }, admitted.query);
    try std.testing.expectEqual(sequence.Range{ .from = 0, .to = 2 }, try cursor.limitQuery(3));
    try std.testing.expectEqual(@as(?u32, 9), cursor.remaining_to);
    try cursor.update(9, 30000);
    try std.testing.expect(cursor.rateLimit(30001) == null);
    try std.testing.expectEqual(@as(u32, 0), cursor.watermark());
    _ = try cursor.plan(9, 30001);
    try std.testing.expectEqual(sequence.Range{ .from = 3, .to = 5 }, try cursor.limitQuery(3));
    try cursor.update(9, 30001);
    _ = try cursor.plan(9, 30002);
    try std.testing.expectEqual(sequence.Range{ .from = 6, .to = 8 }, try cursor.limitQuery(3));
    try cursor.update(9, 30002);
    _ = try cursor.plan(9, 30003);
    try std.testing.expectEqual(sequence.Range{ .from = 9, .to = 9 }, try cursor.limitQuery(3));
    try cursor.update(9, 30003);
    try std.testing.expect(cursor.remaining_to == null);
    try std.testing.expectEqual(@as(u32, 10), cursor.next);
    try std.testing.expectEqual(@as(?u64, 60003), cursor.rateLimit(30004));
    try std.testing.expectEqual(@as(u32, 9), cursor.options.chunk);
    try std.testing.expectEqual(@as(u32, 1), cursor.watermark());
}
test "cooperative block failed slice retries same unread positions and waits for regressed finality" {
    var cursor = try Cursor.init(9, null, 0, .{ .chunk = 9, .lowest = 0 });
    _ = try cursor.plan(9, 30000);
    _ = try cursor.limitQuery(3);
    cursor.failed();
    try std.testing.expectEqual(@as(u32, 0), cursor.next);
    _ = try cursor.plan(9, 30001);
    try std.testing.expectEqual(sequence.Range{ .from = 0, .to = 2 }, try cursor.limitQuery(3));
    try cursor.update(9, 30001);
    try std.testing.expectEqual(Action{ .sleep_until_ms = 35002 }, try cursor.plan(2, 30002));
    try std.testing.expectEqual(@as(?u32, 9), cursor.remaining_to);
    _ = try cursor.plan(9, 30003);
    try std.testing.expectEqual(sequence.Range{ .from = 3, .to = 5 }, try cursor.limitQuery(3));
    try std.testing.expectError(error.InvalidBlockQueryLimit, cursor.limitQuery(0));
}
