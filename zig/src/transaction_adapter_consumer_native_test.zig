const std = @import("std");
const cosmos = @import("transaction_adapter_cosmos_test.zig");
const src = @import("agents/scraper/source.zig");
const queue = @import("agents/indexing/tx_id_queue.zig");
const Companion = @import("agents/indexing/tx_id_companion.zig").Companion;
const Store = @import("agents/store.zig").Store;
const rocks = @import("db/rocks.zig");
const A = std.mem.Allocator;
const Replay = struct {
    batch: ?src.Batch,
    transaction: [64]u8,
    calls: usize = 0,
    fn interface(self: *Replay) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .transaction_fn = fetch };
    }
    fn header(_: *anyopaque, _: src.Selector, _: bool) !src.Header {
        return error.UnexpectedConsumerHeaderRead;
    }
    fn events(_: *anyopaque, _: A, _: u64, _: u64, _: [4]u32) !src.Batch {
        return error.UnexpectedConsumerRangeRead;
    }
    fn fetch(context: *anyopaque, _: A, transaction: [64]u8) !src.Batch {
        const self: *Replay = @ptrCast(@alignCast(context));
        try std.testing.expectEqualSlices(u8, &self.transaction, &transaction);
        self.calls += 1;
        const batch = self.batch orelse return error.UnexpectedConsumerReceiptRead;
        self.batch = null;
        return batch;
    }
};
test "common transaction consumer persists omitted Cosmos gas and tree rows once without moving gas watermark" {
    const a = std.testing.allocator;
    const batch = try cosmos.cosmosBatch(a, .success);
    const transaction = batch.events[0].tx_hash.?;
    var replay: Replay = .{ .batch = batch, .transaction = transaction };
    defer if (replay.batch) |*owned| owned.deinit();
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = Store.init(a, &database, "transaction-consumer-fixture");
    var pending = try queue.Queue.init(a, 4, .{ .tree = true, .gas = true });
    defer pending.deinit();
    const contracts: src.Contracts = .{ .mailbox = @splat(0x11), .hook = @splat(0x22), .paymaster = @splat(0x33) };
    var companion: Companion = .{ .allocator = a, .store = &store, .queue = &pending, .contracts = contracts, .domain = 1000, .source = replay.interface() };
    defer companion.deinit();
    try pending.admit(.{ .transaction = transaction, .block_number = 5 });
    var cancel: std.atomic.Value(bool) = .init(false);
    const first = try companion.tick(0, &cancel);
    try std.testing.expectEqual(@as(usize, 3), first.work);
    try std.testing.expectEqual(@as(usize, 1), replay.calls);
    try std.testing.expectEqual(@as(usize, 0), pending.count());
    const payment = (try store.payment(.{ .message_id = @splat(0x22), .destination = 2000 })).?;
    try std.testing.expectEqual(@as(u256, 2500), payment.payment);
    try std.testing.expectEqual(@as(u256, 1000), payment.gas_amount);
    const insertion = (try store.insertionByIndex(9)).?;
    try std.testing.expectEqualSlices(u8, &([_]u8{0x11} ** 32), &insertion.message_id);
    try std.testing.expectEqual(@as(?u32, null), try store.gasWatermark());
    try pending.admit(.{ .transaction = transaction, .block_number = 5 });
    const second = try companion.tick(1, &cancel);
    try std.testing.expectEqual(@as(usize, 0), second.work);
    try std.testing.expectEqual(@as(usize, 1), replay.calls);
    try std.testing.expectEqual(@as(usize, 0), pending.count());
    try std.testing.expectEqual(@as(u256, 2500), (try store.payment(.{ .message_id = @splat(0x22), .destination = 2000 })).?.payment);
    try std.testing.expectEqual(@as(?u32, null), try store.gasWatermark());
}
