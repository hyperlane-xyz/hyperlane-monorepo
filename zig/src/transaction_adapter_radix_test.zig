const std = @import("std");
const Adapter = @import("agents/scraper/radix.zig").Adapter;
const src = @import("agents/scraper/source.zig");
const provider = @import("radix/provider.zig");
const address = @import("radix/address.zig");
const mock = @import("cloud/testing.zig");
const A = std.mem.Allocator;
const Mode = enum { success, missing, failed, wrong_hash, wrong_height, reorg, bad_metadata, bad_resource_kind, empty };
fn radixBatch(a: A, mode: Mode) !src.Batch {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const memory = arena.allocator();
    const hash = [_]u8{0x44} ** 32;
    const other = [_]u8{0x55} ** 32;
    var hash_buffer: [160]u8 = undefined;
    var other_buffer: [160]u8 = undefined;
    const intent = try address.encode(.mainnet, "txid", &hash, &hash_buffer);
    const other_intent = try address.encode(.mainnet, "txid", &other, &other_buffer);
    var hook_buffer: [160]u8 = undefined;
    var paymaster_buffer: [160]u8 = undefined;
    const hook_node = [_]u8{0x22} ** 30;
    const paymaster_node = [_]u8{0x33} ** 30;
    const hook = try address.encode(.mainnet, "component", &hook_node, &hook_buffer);
    const paymaster = try address.encode(.mainnet, "component", &paymaster_node, &paymaster_buffer);
    const events = if (mode == .bad_metadata)
        try memory.dupe(u8, "[{\"name\":\"InsertedIntoTreeEvent\",\"emitter\":{\"type\":\"Method\",\"entity\":{\"entity_address\":\"bad\"}},\"data\":{\"kind\":\"Tuple\",\"fields\":[]}}]")
    else if (mode == .empty)
        try memory.dupe(u8, "[]")
    else
        try std.fmt.allocPrint(memory, "[{{\"name\":\"Other\"}},{{\"name\":\"GasPayment\",\"emitter\":{{\"type\":\"Method\",\"entity\":{{\"entity_address\":\"{s}\"}}}},\"data\":{{\"kind\":\"Tuple\",\"fields\":[{{\"kind\":\"Bytes\",\"hex\":\"{s}\"}},{{\"kind\":\"U32\",\"value\":2000}},{{\"kind\":\"Decimal\",\"value\":\"1000\"}},{{\"kind\":\"Decimal\",\"value\":\"2500\"}},{{\"kind\":\"{s}\",\"value\":\"resource\"}},{{\"kind\":\"U32\",\"value\":9}}]}}}},{{\"name\":\"InsertedIntoTreeEvent\",\"emitter\":{{\"type\":\"Method\",\"entity\":{{\"entity_address\":\"{s}\"}}}},\"data\":{{\"kind\":\"Tuple\",\"fields\":[{{\"kind\":\"Bytes\",\"hex\":\"{s}\"}},{{\"kind\":\"U32\",\"value\":9}}]}}}}]", .{ paymaster, "22" ** 32, if (mode == .bad_resource_kind) "String" else "Reference", hook, "11" ** 32 });
    const transaction = if (mode == .missing)
        try memory.dupe(u8, "")
    else
        try std.fmt.allocPrint(memory, ",\"transaction\":{{\"state_version\":5,\"intent_hash\":\"{s}\",\"receipt\":{{\"status\":\"{s}\",\"events\":{s}}}}}", .{ if (mode == .wrong_hash) other_intent else intent, if (mode == .failed) "CommittedFailure" else "CommittedSuccess", events });
    const committed = try std.fmt.allocPrint(memory, "{{\"ledger_state\":{{\"network\":\"mainnet\",\"state_version\":6,\"epoch\":1}}{s}}}", .{transaction});
    const stream = try memory.dupe(u8, "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":5,\"epoch\":1,\"proposer_round_timestamp\":\"2026-01-01T00:00:00Z\"},\"items\":[{\"state_version\":5}]}");
    const wrong_stream = try memory.dupe(u8, "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":4,\"epoch\":1,\"proposer_round_timestamp\":\"2026-01-01T00:00:00Z\"},\"items\":[{\"state_version\":4}]}");
    const steps = [_]mock.Step{
        .{ .method = .POST, .suffix = "/transaction/committed-details", .response = committed },
        .{ .method = .POST, .suffix = "/stream/transactions", .response = if (mode == .wrong_height) wrong_stream else stream },
        .{ .method = .POST, .suffix = "/stream/transactions", .response = if (mode == .reorg) wrong_stream else stream },
    };
    var script: mock.Mock = .{ .steps = if (mode == .missing or mode == .failed or mode == .wrong_hash) steps[0..1] else if (mode == .wrong_height) steps[0..2] else &steps };
    const client: provider.Client = .{ .allocator = a, .transport = script.transport(), .core = .{ .url = "https://fixture" }, .gateway = .{ .url = "https://fixture" }, .network = .mainnet, .confirmations = 0 };
    var adapter: Adapter = .{ .client = client, .contracts = .{ .mailbox = address.h256(.{0x11} ** 30), .hook = address.h256(hook_node), .paymaster = address.h256(paymaster_node) }, .domain = 1000 };
    var batch = try adapter.interface().transactionEvents(a, .{0} ** 32 ++ hash);
    if (mode == .success) {
        errdefer batch.deinit();
        try script.expectDone();
    }
    return batch;
}
test "Radix transaction companion recovers exact SBOR gas and tree events at real receipt indices" {
    var batch = try radixBatch(std.testing.allocator, .success);
    defer batch.deinit();
    try std.testing.expectEqual(@as(u64, 5), batch.through);
    try std.testing.expectEqual(@as(usize, 2), batch.events.len);
    for (batch.events) |event| {
        try std.testing.expectEqualSlices(u8, &(.{0} ** 32 ++ .{0x44} ** 32), &event.tx_hash.?);
        try std.testing.expectEqual(@as(u64, 5), event.tx_index);
        try std.testing.expectEqual(@as(u64, 5), event.block_number);
        var expected_hash: src.Hash = .{0} ** 32;
        std.mem.writeInt(u64, expected_hash[24..32], 5, .big);
        try std.testing.expectEqual(expected_hash, event.block_hash);
    }
    try std.testing.expectEqual(@as(u64, 1), batch.events[0].log_index);
    try std.testing.expectEqual(@as(?u32, 9), batch.events[0].sequence);
    try std.testing.expectEqual(@as(u256, 2500000000000000000000), batch.events[0].data.gas.payment);
    try std.testing.expectEqual(@as(u64, 2), batch.events[1].log_index);
    try std.testing.expectEqual(@as(?u32, 9), batch.events[1].sequence);
    try std.testing.expectEqual(@as(u32, 9), batch.events[1].data.insertion.index);
}
test "Radix transaction companion accepts a valid empty receipt and propagates cancellation" {
    const a = std.testing.allocator;
    var batch = try radixBatch(a, .empty);
    defer batch.deinit();
    try std.testing.expectEqual(@as(u64, 5), batch.through);
    try std.testing.expectEqual(@as(usize, 0), batch.events.len);
    const Cancel = struct {
        fn send(_: *anyopaque, _: A, _: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
            return error.RequestCancelled;
        }
    };
    const client: provider.Client = .{ .allocator = a, .transport = .{ .context = undefined, .send_fn = Cancel.send }, .core = .{ .url = "https://fixture" }, .gateway = .{ .url = "https://fixture" }, .network = .mainnet, .confirmations = 0 };
    var adapter: Adapter = .{ .client = client, .contracts = undefined, .domain = 1000 };
    try std.testing.expectError(error.RequestCancelled, adapter.interface().transactionEvents(a, .{0} ** 32 ++ .{0x44} ** 32));
}
test "Radix transaction companion rejects missing failed wrong identity height and malformed SBOR" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.MissingCosmosField, radixBatch(a, .missing));
    try std.testing.expectError(error.RadixTransactionFailed, radixBatch(a, .failed));
    try std.testing.expectError(error.WrongRadixIntentHash, radixBatch(a, .wrong_hash));
    try std.testing.expectError(error.WrongRadixStateVersion, radixBatch(a, .wrong_height));
    try std.testing.expectError(error.WrongRadixStateVersion, radixBatch(a, .reorg));
    try std.testing.expectError(error.InvalidBech32Length, radixBatch(a, .bad_metadata));
    try std.testing.expectError(error.WrongRadixEventFieldKind, radixBatch(a, .bad_resource_kind));
    var script: mock.Mock = .{ .steps = &.{} };
    const client: provider.Client = .{ .allocator = a, .transport = script.transport(), .core = undefined, .gateway = undefined, .network = .mainnet, .confirmations = 0 };
    var adapter: Adapter = .{ .client = client, .contracts = undefined, .domain = 1000 };
    try std.testing.expectError(error.UnsupportedRadixTransactionId, adapter.interface().transactionEvents(a, .{1} ** 64));
    try std.testing.expectError(error.UnsupportedRadixTransactionId, adapter.interface().transactionEvents(a, .{0} ** 64));
}
test "Radix transaction companion propagates cooperative pending I/O" {
    const Pending = struct {
        fn send(_: *anyopaque, _: A, _: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
            return error.PendingReadIo;
        }
    };
    const client: provider.Client = .{ .allocator = std.testing.allocator, .transport = .{ .context = undefined, .send_fn = Pending.send }, .core = .{ .url = "https://fixture" }, .gateway = .{ .url = "https://fixture" }, .network = .mainnet, .confirmations = 0 };
    var adapter: Adapter = .{ .client = client, .contracts = undefined, .domain = 1000 };
    try std.testing.expectError(error.PendingReadIo, adapter.interface().transactionEvents(std.testing.allocator, .{0} ** 32 ++ .{0x44} ** 32));
}
fn allocationFailures(a: A) !void {
    var batch = try radixBatch(a, .success);
    defer batch.deinit();
    try std.testing.expectEqual(@as(usize, 2), batch.events.len);
}
test "Radix transaction companion owns decoded SBOR and output on every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailures, .{});
}
test {
    _ = @import("agents/scraper/radix.zig");
}
