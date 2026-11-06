const std = @import("std");
const Adapter = @import("agents/scraper/tron.zig").Adapter;
const src = @import("agents/scraper/source.zig");
const native = @import("tron/provider.zig");
const abi = @import("evm/codecs.zig");
const mock = @import("cloud/testing.zig");
const A = std.mem.Allocator;
const Mode = enum { success, missing, failed, wrong_hash, wrong_block, reorg, bad_metadata, empty };
fn contract(byte: u8) src.Hash {
    return .{0} ** 12 ++ .{byte} ** 20;
}
fn tronBatch(a: A, mode: Mode) !src.Batch {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const memory = arena.allocator();
    const transaction = [_]u8{0x44} ** 32;
    const other = [_]u8{0x55} ** 32;
    const tx_hex = try abi.hexAlloc(memory, &transaction);
    const other_hex = try abi.hexAlloc(memory, &other);
    const block_hex = try abi.hexAlloc(memory, &transaction);
    const block_raw = try memory.dupe(u8, &std.fmt.bytesToHex(transaction, .lower));
    const other_raw = try memory.dupe(u8, &std.fmt.bytesToHex(other, .lower));
    var gas_data: [64]u8 = .{0} ** 64;
    std.mem.writeInt(u256, gas_data[0..32], 1000, .big);
    std.mem.writeInt(u256, gas_data[32..64], 2500, .big);
    var insert_data: [64]u8 = .{0} ** 64;
    @memcpy(insert_data[0..32], &([_]u8{0x11} ** 32));
    std.mem.writeInt(u32, insert_data[60..64], 9, .big);
    const paymaster = try abi.hexAlloc(memory, &([_]u8{0x33} ** 20));
    const hook = try abi.hexAlloc(memory, &([_]u8{0x22} ** 20));
    const message = try abi.hexAlloc(memory, &([_]u8{0x22} ** 32));
    const destination = try abi.hexAlloc(memory, &std.mem.toBytes(std.mem.nativeToBig(u256, 2000)));
    const gas_topic = try abi.hexAlloc(memory, &abi.gas_payment_topic);
    const insert_topic = try abi.hexAlloc(memory, &abi.insertion_topic);
    const gas_hex = try abi.hexAlloc(memory, &gas_data);
    const insert_hex = try abi.hexAlloc(memory, &insert_data);
    const log_index: []const u8 = if (mode == .bad_metadata) "0x6" else "0x7";
    const receipt_result = if (mode == .missing)
        try memory.dupe(u8, "null")
    else if (mode == .empty)
        try std.fmt.allocPrint(memory, "{{\"transactionHash\":\"{s}\",\"blockNumber\":\"0x5\",\"blockHash\":\"{s}\",\"status\":\"0x1\",\"transactionIndex\":\"0x7\",\"logs\":[]}}", .{ tx_hex, block_hex })
    else
        try std.fmt.allocPrint(memory, "{{\"transactionHash\":\"{s}\",\"blockNumber\":\"0x5\",\"blockHash\":\"{s}\",\"status\":\"0x{d}\",\"transactionIndex\":\"0x7\",\"logs\":[{{\"address\":\"{s}\",\"topics\":[\"{s}\",\"{s}\",\"{s}\"],\"data\":\"{s}\",\"blockNumber\":\"0x5\",\"blockHash\":\"{s}\",\"transactionHash\":\"{s}\",\"transactionIndex\":\"{s}\",\"logIndex\":\"0x1\"}},{{\"address\":\"{s}\",\"topics\":[\"{s}\"],\"data\":\"{s}\",\"blockNumber\":\"0x5\",\"blockHash\":\"{s}\",\"transactionHash\":\"{s}\",\"transactionIndex\":\"0x7\",\"logIndex\":\"0x2\"}}]}}", .{ if (mode == .wrong_hash) other_hex else tx_hex, block_hex, @intFromBool(mode != .failed), paymaster, gas_topic, message, destination, gas_hex, block_hex, tx_hex, log_index, hook, insert_topic, insert_hex, block_hex, tx_hex });
    const receipt = try std.fmt.allocPrint(memory, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{s}}}", .{receipt_result});
    const first_hash = if (mode == .wrong_block) other_raw else block_raw;
    const second_hash = if (mode == .reorg) other_raw else block_raw;
    const first_block = try std.fmt.allocPrint(memory, "{{\"blockID\":\"{s}\",\"block_header\":{{\"raw_data\":{{\"number\":5,\"timestamp\":1750000000000}}}}}}", .{first_hash});
    const second_block = try std.fmt.allocPrint(memory, "{{\"blockID\":\"{s}\",\"block_header\":{{\"raw_data\":{{\"number\":5,\"timestamp\":1750000000000}}}}}}", .{second_hash});
    const steps = [_]mock.Step{
        .{ .method = .POST, .suffix = "/jsonrpc", .response = receipt },
        .{ .method = .POST, .suffix = "/walletsolidity/getblockbynum", .response = first_block },
        .{ .method = .POST, .suffix = "/walletsolidity/getblockbynum", .response = second_block },
    };
    var script: mock.Mock = .{ .steps = if (mode == .missing or mode == .failed or mode == .wrong_hash) steps[0..1] else if (mode == .wrong_block) steps[0..2] else &steps };
    var provider = native.testingProvider(script.transport());
    var adapter: Adapter = .{ .provider = &provider, .contracts = .{ .mailbox = contract(0x11), .hook = contract(0x22), .paymaster = contract(0x33) }, .domain = 1000 };
    var batch = try adapter.interface().transactionEvents(a, .{0} ** 32 ++ transaction);
    if (mode == .success) {
        errdefer batch.deinit();
        try script.expectDone();
    }
    return batch;
}
test "Tron transaction companion recovers exact ABI gas and tree rows from one hash-addressed receipt" {
    var batch = try tronBatch(std.testing.allocator, .success);
    defer batch.deinit();
    try std.testing.expectEqual(@as(u64, 5), batch.through);
    try std.testing.expectEqual(@as(usize, 2), batch.events.len);
    for (batch.events) |event| {
        try std.testing.expectEqualSlices(u8, &(.{0} ** 32 ++ .{0x44} ** 32), &event.tx_hash.?);
        try std.testing.expectEqual(@as(u64, 7), event.tx_index);
        try std.testing.expectEqual(@as(u64, 5), event.block_number);
    }
    try std.testing.expectEqual(@as(u64, 1), batch.events[0].log_index);
    try std.testing.expectEqual(@as(u256, 2500), batch.events[0].data.gas.payment);
    try std.testing.expectEqual(@as(u64, 2), batch.events[1].log_index);
    try std.testing.expectEqual(@as(u32, 9), batch.events[1].data.insertion.index);
}
test "Tron transaction companion accepts a valid empty receipt and propagates cancellation" {
    const a = std.testing.allocator;
    var batch = try tronBatch(a, .empty);
    defer batch.deinit();
    try std.testing.expectEqual(@as(u64, 5), batch.through);
    try std.testing.expectEqual(@as(usize, 0), batch.events.len);
    const Cancel = struct {
        fn send(_: *anyopaque, _: A, _: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
            return error.RequestCancelled;
        }
    };
    var provider = native.testingProvider(.{ .context = undefined, .send_fn = Cancel.send });
    var adapter: Adapter = .{ .provider = &provider, .contracts = undefined, .domain = 1000 };
    try std.testing.expectError(error.RequestCancelled, adapter.interface().transactionEvents(a, .{0} ** 32 ++ .{0x44} ** 32));
}
test "Tron transaction companion rejects missing failed identity hash and log metadata failures" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.MissingTronReceipt, tronBatch(a, .missing));
    try std.testing.expectError(error.TronTransactionFailed, tronBatch(a, .failed));
    try std.testing.expectError(error.WrongTronReceipt, tronBatch(a, .wrong_hash));
    try std.testing.expectError(error.NoncanonicalTronReceipt, tronBatch(a, .wrong_block));
    try std.testing.expectError(error.NoncanonicalTronReceipt, tronBatch(a, .reorg));
    try std.testing.expectError(error.InconsistentTronReceiptLog, tronBatch(a, .bad_metadata));
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var script: mock.Mock = .{ .steps = &.{} };
    var provider = native.testingProvider(script.transport());
    var adapter: Adapter = .{ .provider = &provider, .contracts = undefined, .domain = 1000 };
    try std.testing.expectError(error.UnsupportedTronTransactionId, adapter.interface().transactionEvents(a, .{1} ** 64));
    try std.testing.expectError(error.UnsupportedTronTransactionId, adapter.interface().transactionEvents(a, .{0} ** 64));
}
test "Tron transaction companion propagates cooperative pending I/O" {
    const Pending = struct {
        fn send(_: *anyopaque, _: A, _: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
            return error.PendingReadIo;
        }
    };
    var provider = native.testingProvider(.{ .context = undefined, .send_fn = Pending.send });
    var adapter: Adapter = .{ .provider = &provider, .contracts = undefined, .domain = 1000 };
    try std.testing.expectError(error.PendingReadIo, adapter.interface().transactionEvents(std.testing.allocator, .{0} ** 32 ++ .{0x44} ** 32));
}
fn allocationFailures(a: A) !void {
    var batch = try tronBatch(a, .success);
    defer batch.deinit();
    try std.testing.expectEqual(@as(usize, 2), batch.events.len);
}
test "Tron transaction companion releases receipt logs and output on every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailures, .{});
}
test {
    _ = @import("agents/scraper/tron.zig");
}
