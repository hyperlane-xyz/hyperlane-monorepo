const std = @import("std");
const links = @import("payload_links.zig");
const native = @import("store.zig");
const db = @import("../db/root.zig");
const protocol = @import("../protocol/root.zig");
const lander = @import("../lander/root.zig");

test "native payload link survives pre-enqueue crash preserves Rust relation and rejects stale authority" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "payload-link" });
    defer a.free(path);
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .nonce = 7, .sender = @splat(1), .recipient = @splat(2), .body = "actual canonical message" };
    const context: [32]u8 = @splat(8);
    const id = message.id();
    const data = "[{\"type\":\"0x02\",\"to\":\"0x3535353535353535353535353535353535353535\",\"data\":\"0x1234\",\"value\":\"0x0\",\"chainId\":\"0x1\",\"maxFeePerGas\":\"0x2\",\"maxPriorityFeePerGas\":\"0x1\"},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]";
    const value: links.Record = .{ .context = context, .message_id = id, .generation = 1, .payload = .{ .uuid = links.uuid(context, id, 1), .metadata = "message", .data_json = data, .gas_limit = 21000, .to = @splat(5) }, .delivery = .{ .mailbox_message = id } };
    {
        var database = try db.rocks.Database.open(a, path, .{ .sync = true });
        defer database.deinit();
        var store = native.Store.init(a, &database, "origin");
        _ = try store.storeMessage(message, 10, null);
        try links.seal(a, &store, value);
        try links.seal(a, &store, value);
        var conflict = value;
        conflict.payload.gas_limit = 22000;
        try std.testing.expectError(error.PayloadLinkConflict, links.seal(a, &store, conflict));
        conflict = value;
        conflict.delivery = .none;
        try std.testing.expectError(error.PayloadDeliveryIdentityMismatch, links.seal(a, &store, conflict));
        // Process exits before destination.enqueue. Only the origin link and
        // Rust-compatible UUID relation have committed at this point.
    }
    var database = try db.rocks.Database.open(a, path, .{ .sync = true });
    defer database.deinit();
    var store = native.Store.init(a, &database, "origin");
    var recovered = (try links.load(a, &store, id, context)).?;
    defer recovered.deinit();
    try std.testing.expectEqualStrings(data, recovered.record().payload.data_json);
    try std.testing.expectEqual(@as(u256, 21000), recovered.record().payload.gas_limit);
    try std.testing.expectError(error.PayloadLinkContextChanged, links.load(a, &store, id, @splat(9)));
    const Mock = struct {
        called: bool = false,
        expected: [16]u8,
        message_id: [32]u8,
        pub fn enqueue(self: *@This(), input: lander.EnqueueInput) !void {
            try std.testing.expectEqual(self.expected, input.payload.uuid);
            try std.testing.expectEqualStrings(data, input.payload.data_json);
            try std.testing.expectEqual(self.message_id, input.delivery.mailbox_message);
            self.called = true;
        }
    };
    var destination: Mock = .{ .expected = value.payload.uuid, .message_id = id };
    try recovered.replay(&destination);
    try std.testing.expect(destination.called);
    const inherited = try links.inheritedUuids(a, &store, id);
    defer a.free(inherited);
    try std.testing.expectEqual(@as(usize, 1), inherited.len);
    try std.testing.expectEqual(value.payload.uuid, inherited[0]);
    try std.testing.expectError(error.PayloadRelationChanged, links.clearTerminal(a, &store, id, &.{@splat(9)}));
    try links.clearTerminal(a, &store, id, inherited);
    try std.testing.expect((try links.load(a, &store, id, context)) == null);
    const gone = try links.inheritedUuids(a, &store, id);
    defer a.free(gone);
    try std.testing.expectEqual(@as(usize, 0), gone.len);
    const foreign = try db.codec.encodeUuids(a, &.{@splat(9)});
    defer a.free(foreign);
    try store.typed.put(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &id, foreign);
    try std.testing.expectError(error.InheritedPayloadNeedsReconciliation, links.seal(a, &store, value));
    try links.clearTerminal(a, &store, id, &.{@splat(9)});
    try std.testing.expectError(error.StalePayloadGeneration, links.seal(a, &store, value));
    var next = value;
    next.generation = 2;
    next.payload.uuid = links.uuid(context, id, 2);
    try links.seal(a, &store, next);
    var current_link = (try links.load(a, &store, id, context)).?;
    defer current_link.deinit();
    try std.testing.expectError(error.PayloadRelationChanged, recovered.replay(&destination));
    var replacement = message;
    replacement.body = "reorged canonical replacement";
    try store.upsertMessage(replacement, 11, null);
    try std.testing.expectError(error.StaleCanonicalMessage, links.seal(a, &store, next));
    try std.testing.expectError(error.StaleCanonicalMessage, links.load(a, &store, id, context));
    try std.testing.expectError(error.StaleCanonicalMessage, current_link.replay(&destination));
}
