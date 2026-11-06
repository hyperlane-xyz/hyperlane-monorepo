const std = @import("std");
const native = @import("store.zig");
const origin = @import("origin.zig");
const db = @import("../db/root.zig");
const protocol = @import("../protocol/root.zig");

test "native origin proofs rebuild after canonical replacement and resume across bounded gap recovery" {
    const allocator = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const base = try directory.dir.realpathAlloc(allocator, ".");
    defer allocator.free(base);
    const path = try std.fs.path.join(allocator, &.{ base, "origin" });
    defer allocator.free(path);
    var database = try db.rocks.Database.open(allocator, path, .{});
    defer database.deinit();
    var store = native.Store.init(allocator, &database, "origin");
    var service = origin.Origin.init(allocator, &store, 1, @splat(7), null);
    defer service.deinit();
    const registry = try @import("../ops/metrics.zig").Registry.init(allocator, .relayer, .{ .base_version = @import("../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: @import("../ops/indexing_metrics.zig").Adapter = .{ .registry = registry, .chain = "origin" };
    service.observer = adapter.interface();
    try std.testing.expect((try treeMetric(registry, allocator)) == null);
    var leaves = [_][32]u8{ @splat(1), @splat(2), @splat(3) };
    _ = try store.storeInsertion(.{ .leaf_index = 0, .message_id = leaves[0] }, 10);
    _ = try store.storeInsertion(.{ .leaf_index = 2, .message_id = leaves[2] }, 12);
    try std.testing.expectEqual(@as(usize, 1), try service.sync(64));
    try std.testing.expectEqual(@as(?i64, 0), try treeMetric(registry, allocator));
    try std.testing.expectEqual(@as(?u32, 0), try service.highestKnownLeafIndex());
    try std.testing.expect((try service.leafIndex(leaves[2])) == null);
    _ = try store.storeInsertion(.{ .leaf_index = 1, .message_id = leaves[1] }, 11);
    try std.testing.expectEqual(@as(usize, 1), try service.sync(1));
    try std.testing.expectEqual(@as(?i64, 1), try treeMetric(registry, allocator));
    try std.testing.expectEqual(@as(usize, 1), try service.sync(1));
    try std.testing.expectEqual(@as(?i64, 2), try treeMetric(registry, allocator));
    try std.testing.expectEqual(@as(usize, 0), try service.sync(64));
    try std.testing.expectEqual(@as(?i64, 2), try treeMetric(registry, allocator));
    var tree = protocol.IncrementalMerkle.init();
    for (leaves) |leaf| try tree.ingest(leaf);
    var checkpoint: protocol.Checkpoint = .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(7), .index = 2, .root = tree.root(), .message_id = leaves[2] };
    try std.testing.expect((try service.proof(1, checkpoint)).verify(checkpoint.root));
    const previous = leaves[1];
    leaves[1] = @splat(9);
    _ = try store.storeInsertion(.{ .leaf_index = 1, .message_id = leaves[1] }, 11);
    try std.testing.expect((try service.highestKnownLeafIndex()) == null);
    try std.testing.expectError(error.UnknownMerkleLeaf, service.proof(1, checkpoint));
    try std.testing.expectEqual(@as(usize, 3), try service.sync(64));
    try std.testing.expectError(error.MerkleRootMismatch, service.proof(1, checkpoint));
    tree = protocol.IncrementalMerkle.init();
    for (leaves) |leaf| try tree.ingest(leaf);
    checkpoint.root = tree.root();
    try std.testing.expect((try service.proof(1, checkpoint)).verify(checkpoint.root));
    try std.testing.expect((try service.leafIndex(previous)) == null);
    try std.testing.expectEqual(@as(?u32, 1), try service.leafIndex(leaves[1]));
}

fn treeMetric(registry: *@import("../ops/metrics.zig").Registry, a: std.mem.Allocator) !?i64 {
    const text = try registry.render(a);
    defer a.free(text);
    const name = "hyperlane_latest_tree_insertion_index{";
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name)) continue;
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        return try std.fmt.parseInt(i64, line[space + 1 ..], 10);
    }
    return null;
}
