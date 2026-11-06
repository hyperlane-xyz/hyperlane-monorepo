//! Independent loss-of-liveness reasons aggregate into the Source per-chain
//! boolean. Clearing one recovered task never erases a sibling's failure.
const std = @import("std");
const metrics = @import("metrics.zig");
pub const Reason = enum(u4) {
    origin,
    destination,
    destination_metrics,
    message_sync,
    gas_payment_sync,
    merkle_tree_hook_sync,
    message_db_loader,
    merkle_tree_db_loader,
    message_context,
};
pub const Tracker = struct {
    registry: ?*metrics.Registry = null,
    chain: []const u8 = "",
    reasons: u16 = 0,
    published: bool = false,
    failures: std.atomic.Value(u64) = .init(0),
    mutex: std.Thread.Mutex = .{},
    fn bit(reason: Reason) u16 {
        return @as(u16, 1) << @intFromEnum(reason);
    }
    fn publish(self: *Tracker) void {
        const registry = self.registry orelse return;
        registry.update("hyperlane_critical_error", &.{self.chain}, .{ .set_int = @intFromBool(self.reasons != 0) }) catch |err| {
            self.published = false;
            if (self.failures.fetchAdd(1, .monotonic) == 0) std.log.warn("critical metric update failed: {s}", .{@errorName(err)});
            return;
        };
        self.published = true;
    }
    /// Call at the actual role/chain startup boundary, never from a health RPC.
    /// Does not clear an independently recorded failure.
    pub fn started(self: *Tracker) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.published) self.publish();
    }
    pub fn record(self: *Tracker, reason: Reason) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const next = self.reasons | bit(reason);
        if (self.published and next == self.reasons) return;
        self.reasons = next;
        self.publish();
    }
    pub fn clear(self: *Tracker, reason: Reason) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.reasons & bit(reason) == 0) return;
        self.reasons &= ~bit(reason);
        self.publish();
    }
    /// Source WS handoff clears sequenced RPC sync failures only. Gas, loader,
    /// construction and metrics failures retain their independent reasons.
    pub fn clearDirectRpc(self: *Tracker) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const next = self.reasons & ~(bit(.message_sync) | bit(.merkle_tree_hook_sync));
        if (next == self.reasons) return;
        self.reasons = next;
        self.publish();
    }
};
fn value(registry: *metrics.Registry) !?u8 {
    const a = std.testing.allocator;
    const wire = try registry.render(a);
    defer a.free(wire);
    var lines = std.mem.splitScalar(u8, wire, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "hyperlane_critical_error{")) continue;
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidSample;
        return try std.fmt.parseInt(u8, line[space + 1 ..], 10);
    }
    return null;
}
test "critical tracker has no constructor sample and startup cannot clear recorded failure" {
    const registry = try metrics.Registry.init(std.testing.allocator, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var tracker: Tracker = .{ .registry = registry, .chain = "origin" };
    try std.testing.expect((try value(registry)) == null);
    tracker.record(.origin);
    tracker.started();
    try std.testing.expectEqual(@as(?u8, 1), try value(registry));
    tracker.clear(.origin);
    try std.testing.expectEqual(@as(?u8, 0), try value(registry));
}
test "critical independent reasons and Source WS recovery preserve unrelated failures" {
    const registry = try metrics.Registry.init(std.testing.allocator, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var tracker: Tracker = .{ .registry = registry, .chain = "origin" };
    tracker.started();
    try std.testing.expectEqual(@as(?u8, 0), try value(registry));
    tracker.record(.message_sync);
    tracker.record(.merkle_tree_hook_sync);
    tracker.record(.gas_payment_sync);
    tracker.record(.destination_metrics);
    tracker.clearDirectRpc();
    tracker.clear(.gas_payment_sync);
    try std.testing.expectEqual(@as(?u8, 1), try value(registry));
    tracker.clear(.destination_metrics);
    try std.testing.expectEqual(@as(?u8, 0), try value(registry));
    tracker.clear(.message_context);
    try std.testing.expectEqual(@as(?u8, 0), try value(registry));
}
test "critical telemetry pressure cannot fail or reset operational state" {
    const registry = try metrics.Registry.init(std.testing.allocator, .relayer, .{ .base_version = "fixture", .max_series = 1 });
    defer registry.deinit();
    var first: Tracker = .{ .registry = registry, .chain = "first" };
    first.started();
    var other: Tracker = .{ .registry = registry, .chain = "other" };
    other.record(.origin);
    try std.testing.expect(other.reasons != 0);
    try std.testing.expectEqual(@as(u64, 1), other.failures.load(.monotonic));
    other.clear(.origin);
    try std.testing.expectEqual(@as(u16, 0), other.reasons);
}
