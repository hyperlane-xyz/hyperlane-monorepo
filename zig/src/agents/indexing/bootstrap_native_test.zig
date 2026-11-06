//! Cursor startup regressions through the real generic service and native DB.
const std = @import("std");
const cfg = @import("../../settings/types.zig");
const src = @import("../scraper/source.zig");
const service = @import("service.zig");
const fixture = @import("testing.zig");
const critical = @import("../../ops/critical_metrics.zig");
const A = std.mem.Allocator;
const Wire = struct {
    chain: fixture.Chain,
    errors: [4]?anyerror = @splat(null),
    calls: [4]usize = @splat(0),
    delay_ms: u64 = 0,
    fn interface(self: *@This(), cooperative: bool) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .stream_tip_fn = tip, .read_section = if (cooperative) .{ .context = self, .commit_fn = commit } else null };
    }
    fn cast(context: *anyopaque) *@This() {
        return @ptrCast(@alignCast(context));
    }
    fn commit(_: *anyopaque) !void {}
    fn header(context: *anyopaque, selector: src.Selector, fresh: bool) !src.Header {
        const inner = cast(context).chain.interface();
        return inner.header_fn(inner.context, selector, fresh);
    }
    fn events(context: *anyopaque, a: A, from: u64, through: u64, sequences: [4]u32) !src.Batch {
        return cast(context).chain.interface().events(a, from, through, sequences);
    }
    fn tip(context: *anyopaque, stream: usize) !src.Tip {
        const self = cast(context);
        self.calls[stream] += 1;
        if (self.errors[stream]) |err| {
            if (self.delay_ms != 0) std.Thread.sleep(self.delay_ms * std.time.ns_per_ms);
            return err;
        }
        return self.chain.interface().streamTip(stream);
    }
};
fn reason(value: critical.Reason) u16 {
    return @as(u16, 1) << @intFromEnum(value);
}
fn exercise(cooperative: bool) !void {
    const a = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(a, path, .{});
    defer database.deinit();
    var chain: cfg.Chain = undefined;
    chain.name = "bootstrap";
    chain.domain = 10;
    chain.protocol = .cosmos;
    chain.index = .{ .from = 1, .chunk = 5, .interval = 1 };
    chain.contracts = .{ .mailbox = fixture.contracts.mailbox, .merkle_tree_hook = fixture.contracts.hook, .interchain_gas_paymaster = fixture.contracts.paymaster, .validator_announce = @splat(4) };
    const logs = fixture.events();
    var wire: Wire = .{ .chain = .{ .logs = &logs }, .errors = .{ error.RpcHttpStatus, null, error.RpcHttpStatus, null } };
    var tracker: critical.Tracker = .{};
    tracker.record(.destination_metrics);
    const driver = try service.Service.open(a, &chain, wire.interface(cooperative), &database, null, true);
    defer driver.deinit();
    driver.indexer.critical = &tracker;
    for (0..10) |i| {
        for (0..3) |_| _ = try driver.tick(i * 3000, null);
        try std.testing.expectEqual(reason(.destination_metrics), tracker.reasons);
        try std.testing.expectEqual(@as(usize, i + 1), wire.calls[0]);
        try std.testing.expectEqual(@as(usize, i + 1), wire.calls[2]);
    }
    try std.testing.expect(driver.indexer.cursors[0] == null);
    try std.testing.expect(driver.indexer.bootstrap[1].initialized);
    try std.testing.expect((try driver.store.insertionByIndex(1)) != null);
    // Final Source sleep has not elapsed yet; no eleventh attempt.
    const first_due = @min(driver.indexer.bootstrap[0].retry_at_ms, driver.indexer.bootstrap[2].retry_at_ms);
    const terminal_due = @max(driver.indexer.bootstrap[0].retry_at_ms, driver.indexer.bootstrap[2].retry_at_ms);
    _ = try driver.tick(first_due - 1, null);
    try std.testing.expectEqual(@as(usize, 10), wire.calls[0]);
    try std.testing.expectEqual(reason(.destination_metrics), tracker.reasons);
    _ = try driver.tick(terminal_due, null);
    try std.testing.expectEqual(reason(.destination_metrics) | reason(.message_sync) | reason(.gas_payment_sync), tracker.reasons);
    wire.errors[0] = null;
    driver.indexer.next_stream = 0;
    for (0..3) |_| _ = try driver.tick(terminal_due + 3000, null);
    try std.testing.expect(driver.indexer.bootstrap[0].initialized);
    // The stored message copy owns its body.
    var stored = (try driver.store.messageByNonce(0)).?;
    stored.deinit();
    try std.testing.expectEqual(reason(.destination_metrics) | reason(.gas_payment_sync), tracker.reasons);
    tracker.record(.message_sync);
    tracker.record(.merkle_tree_hook_sync);
    tracker.record(.merkle_tree_db_loader);
    const before = wire.calls;
    _ = driver.indexer.setStreamMask(.{ false, false, true });
    try std.testing.expectEqual(reason(.destination_metrics) | reason(.gas_payment_sync) | reason(.merkle_tree_db_loader), tracker.reasons);
    for (0..5) |_| _ = try driver.tick(terminal_due + 4000, null);
    try std.testing.expectEqual(before[0], wire.calls[0]);
    try std.testing.expectEqual(before[3], wire.calls[3]);
}
test "origin bootstrap independent Source budget real recovery and WS mask legacy" {
    try exercise(false);
}
test "origin bootstrap independent Source budget real recovery and WS mask cooperative" {
    try exercise(true);
}

test "origin bootstrap controls uncounted and retry delay starts after completed read" {
    const a = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try @import("../../db/rocks.zig").Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "controls");
    var wire: Wire = .{ .chain = .{ .logs = &.{} } };
    var core: @import("source.zig").Core(@TypeOf(store)) = .{ .allocator = a, .source = wire.interface(true), .store = &store, .options = .{ .cursor_bootstrap = true, .domain = 10, .contracts = fixture.contracts, .chunk = 5, .lowest = 1, .gas_enabled = false } };
    defer core.deinit();
    for ([_]anyerror{ error.PendingReadIo, error.PendingIo, error.RequestCancelled, error.OutOfMemory, error.RequestDeadlineExceeded, error.ReadReplayDeadline, error.PoolQueueFull, error.InputOutput }) |err| {
        wire.errors[0] = err;
        core.next_stream = 0;
        core.due[0] = 0;
        try std.testing.expectError(err, core.tick(0, null));
        try std.testing.expectEqual(@as(u8, 0), core.bootstrap[0].failures);
    }
    for ([_]anyerror{ error.ConnectionTimedOut, error.UpstreamReadTimeout }, 0..) |err, i| {
        wire.errors[0] = err;
        wire.delay_ms = 25;
        core.next_stream = 0;
        core.due[0] = 0;
        const now_ms = 1000 + i * 3000;
        _ = try core.tick(now_ms, null);
        try std.testing.expectEqual(@as(u8, @intCast(i + 1)), core.bootstrap[0].failures);
        try std.testing.expect(core.bootstrap[0].retry_at_ms >= now_ms + 2025);
    }
}
