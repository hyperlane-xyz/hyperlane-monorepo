const std = @import("std");

pub fn requiredIntervalMs(block_time_ms: u64, age_ms: u64) u64 {
    if (age_ms < 1_000) return 0;
    if (age_ms < 30_000) return @max(block_time_ms / 4, 25);
    if (age_ms < 300_000) return @max(block_time_ms / 2, 50);
    const base = @max(block_time_ms, 100);
    const steps = @min((age_ms - 300_000) / 300_000, 16);
    const multiplier = @as(u64, 1) << @intCast(steps);
    return @min(std.math.mul(u64, base, multiplier) catch std.math.maxInt(u64), 300_000);
}

pub fn ready(block_time_ms: u64, now_ms: u64, creation_ms: u64, last_check_ms: ?u64) bool {
    const last = last_check_ms orelse return true;
    const age = now_ms -| creation_ms;
    return now_ms -| last >= requiredIntervalMs(block_time_ms, age);
}

test "source age backoff boundaries and saturation" {
    try std.testing.expectEqual(@as(u64, 0), requiredIntervalMs(12_000, 999));
    try std.testing.expectEqual(@as(u64, 3_000), requiredIntervalMs(12_000, 1_000));
    try std.testing.expectEqual(@as(u64, 6_000), requiredIntervalMs(12_000, 30_000));
    try std.testing.expectEqual(@as(u64, 12_000), requiredIntervalMs(12_000, 300_000));
    try std.testing.expectEqual(@as(u64, 24_000), requiredIntervalMs(12_000, 600_000));
    try std.testing.expectEqual(@as(u64, 300_000), requiredIntervalMs(std.math.maxInt(u64), std.math.maxInt(u64)));
    try std.testing.expect(ready(12_000, 1_000, 0, null));
    try std.testing.expect(!ready(12_000, 30_000, 0, 29_999));
    try std.testing.expect(ready(12_000, 30_000, 0, 24_000));
}
