const std = @import("std");
const Adapter = @import("agents/scraper/cosmos.zig").Adapter;
const src = @import("agents/scraper/source.zig");
const rpc = @import("evm/provider.zig");
const json = @import("cosmos/types.zig");
const A = std.mem.Allocator;

pub const Mode = enum { success, failed, wrong_hash, reorg, missing, missing_index, out_of_range, mismatched_member, empty, pending };
const native_events = "[{\"type\":\"message\",\"attributes\":[]},{\"type\":\"hyperlane.core.post_dispatch.v1.EventGasPayment\",\"attributes\":[{\"key\":\"igp_id\",\"value\":\"\\\"0x33333333333333333333333333333333" ++ "33333333333333333333333333333333\\\"\"},{\"key\":\"message_id\",\"value\":\"\\\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\\\"\"},{\"key\":\"gas_amount\",\"value\":\"1000\"},{\"key\":\"payment\",\"value\":\"\\\"2500uatom\\\"\"},{\"key\":\"destination\",\"value\":\"2000\"}]},{\"type\":\"hyperlane.core.post_dispatch.v1.EventInsertedIntoTree\",\"attributes\":[{\"key\":\"merkle_tree_hook_id\",\"value\":\"\\\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\\\"\"},{\"key\":\"message_id\",\"value\":\"\\\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\\\"\"},{\"key\":\"index\",\"value\":\"9\"}]}]";
const Mock = struct {
    mode: Mode,
    raw: []const u8,
    tx_hash: []const u8,
    block_hash: []const u8,
    other_hash: []const u8,
    blocks: usize = 0,
    fn interface(self: *Mock) rpc.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }
    fn fetch(context: *anyopaque, a: A, request: []const u8, options: rpc.Options) !rpc.WireResponse {
        const self: *Mock = @ptrCast(@alignCast(context));
        if (options.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.mode == .pending) return error.PendingReadIo;
        var parsed = try std.json.parseFromSlice(std.json.Value, a, request, .{});
        defer parsed.deinit();
        const id = parsed.value.object.get("id").?.integer;
        const method = parsed.value.object.get("method").?.string;
        const events = if (self.mode == .empty) "[]" else native_events;
        const result = if (std.mem.eql(u8, method, "tx")) blk: {
            if (self.mode == .missing) break :blk try a.dupe(u8, "null");
            const hash = if (self.mode == .wrong_hash) self.other_hash else self.tx_hash;
            const code: u32 = if (self.mode == .failed) 17 else 0;
            if (self.mode == .missing_index) break :blk try std.fmt.allocPrint(a, "{{\"hash\":\"{s}\",\"height\":\"5\",\"tx\":\"{s}\",\"tx_result\":{{\"code\":{d},\"events\":{s}}}}}", .{ hash, self.raw, code, events });
            break :blk try std.fmt.allocPrint(a, "{{\"hash\":\"{s}\",\"height\":\"5\",\"index\":{d},\"tx\":\"{s}\",\"tx_result\":{{\"code\":{d},\"events\":{s}}}}}", .{ hash, @as(u8, if (self.mode == .out_of_range) 8 else 7), self.raw, code, events });
        } else if (std.mem.eql(u8, method, "block")) blk: {
            self.blocks += 1;
            const hash = if (self.mode == .reorg and self.blocks > 1) self.other_hash else self.block_hash;
            const member = if (self.mode == .mismatched_member) "CA==" else self.raw;
            break :blk try std.fmt.allocPrint(a, "{{\"block_id\":{{\"hash\":\"{s}\"}},\"block\":{{\"header\":{{\"chain_id\":\"fixture-1\",\"height\":\"5\",\"time\":\"2026-01-01T00:00:00Z\",\"last_block_id\":{{\"hash\":\"{s}\"}}}},\"data\":{{\"txs\":[\"AA==\",\"AQ==\",\"Ag==\",\"Aw==\",\"BA==\",\"BQ==\",\"Bg==\",\"{s}\"]}}}}}}", .{ hash, self.block_hash, member });
        } else if (std.mem.eql(u8, method, "block_results"))
            try a.dupe(u8, "{\"height\":\"5\",\"txs_results\":[{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]},{\"code\":0,\"events\":[]}]}")
        else
            return error.UnexpectedCosmosFixtureMethod;
        defer a.free(result);
        const body = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, result });
        return .{ .bytes = body, .len = body.len };
    }
};
const Fixture = struct {
    arena: std.heap.ArenaAllocator,
    client: *rpc.RpcClient,
    adapter: Adapter,
    transaction: [64]u8,
    fn init(a: A, mode: Mode) !Fixture {
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const memory = arena.allocator();
        var sdk = try @import("testing/fixture.zig").parse(std.json.Value, a, @embedFile("altvm/fixtures/sdk.json.gz"), .{});
        defer sdk.deinit();
        const text = try json.string(try json.field(try json.field(sdk.value, "cosmos"), "raw"));
        const raw = try memory.alloc(u8, text.len / 2);
        _ = try std.fmt.hexToBytes(raw, text);
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(raw, &digest, .{});
        const encoded = try memory.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
        _ = std.base64.standard.Encoder.encode(encoded, raw);
        const tx_hex = try memory.dupe(u8, &std.fmt.bytesToHex(digest, .upper));
        const block = [_]u8{0x44} ** 32;
        const other = [_]u8{0x55} ** 32;
        const mock = try memory.create(Mock);
        mock.* = .{ .mode = mode, .raw = encoded, .tx_hash = tx_hex, .block_hash = try memory.dupe(u8, &std.fmt.bytesToHex(block, .upper)), .other_hash = try memory.dupe(u8, &std.fmt.bytesToHex(other, .upper)) };
        const client = try memory.create(rpc.RpcClient);
        client.* = try rpc.RpcClient.init(a, "https://fixture", .{ .exchange = mock.interface(), .max_response_bytes = 1024 * 1024 });
        errdefer client.deinit();
        const adapter: Adapter = .{ .tendermint = .{ .rpc_client = client, .chain_id = "fixture-1", .compat = .v038 }, .native = true, .contracts = .{ .mailbox = @splat(0x11), .hook = @splat(0x22), .paymaster = @splat(0x33) }, .queries = .{ .allocator = a, .transport = undefined, .domain = 1000, .config = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = .{ .numerator = 1, .denominator = 1 }, .gas_multiplier = 2, .confirmations = 0 } } };
        return .{ .arena = arena, .client = client, .adapter = adapter, .transaction = .{0} ** 32 ++ digest };
    }
    fn deinit(self: *Fixture) void {
        self.client.deinit();
        self.arena.deinit();
    }
};
pub fn cosmosBatch(a: A, mode: Mode) !src.Batch {
    var fixture = try Fixture.init(a, mode);
    defer fixture.deinit();
    return fixture.adapter.interface().transactionEvents(a, fixture.transaction);
}
test "Cosmos transaction companion recovers omitted native gas and tree events at canonical nonzero transaction index" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .success);
    defer fixture.deinit();
    const source = fixture.adapter.interface();
    var range = try source.events(a, 5, 5, .{0} ** 4);
    defer range.deinit();
    try std.testing.expectEqual(@as(usize, 0), range.events.len);
    var batch = try source.transactionEvents(a, fixture.transaction);
    defer batch.deinit();
    try std.testing.expectEqual(@as(u64, 5), batch.through);
    try std.testing.expectEqual(@as(usize, 2), batch.events.len);
    for (batch.events) |event| {
        try std.testing.expectEqualSlices(u8, &fixture.transaction, &event.tx_hash.?);
        try std.testing.expectEqual(@as(u64, 5), event.block_number);
        try std.testing.expectEqual(@as(u64, 7), event.tx_index);
        try std.testing.expectEqualSlices(u8, &([_]u8{0x44} ** 32), &event.block_hash);
    }
    try std.testing.expectEqual(@as(u64, 1), batch.events[0].log_index);
    try std.testing.expectEqual(@as(u256, 2500), batch.events[0].data.gas.payment);
    try std.testing.expectEqual(@as(u64, 2), batch.events[1].log_index);
    try std.testing.expectEqual(@as(?u32, 9), batch.events[1].sequence);
    try std.testing.expectEqual(@as(u32, 9), batch.events[1].data.insertion.index);
}
test "Cosmos transaction companion accepts a valid empty receipt and propagates cancellation" {
    const a = std.testing.allocator;
    var empty = try cosmosBatch(a, .empty);
    defer empty.deinit();
    try std.testing.expectEqual(@as(u64, 5), empty.through);
    try std.testing.expectEqual(@as(usize, 0), empty.events.len);
    var fixture = try Fixture.init(a, .success);
    defer fixture.deinit();
    var cancel: std.atomic.Value(bool) = .init(true);
    const source = fixture.adapter.interface();
    source.bindCancellation(&cancel);
    try std.testing.expectError(error.RequestCancelled, source.transactionEvents(a, fixture.transaction));
}
test "Cosmos transaction companion rejects missing failed wrong-ID reorg and malformed metadata" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.CosmosTransactionFailed, cosmosBatch(a, .failed));
    try std.testing.expectError(error.WrongCosmosTxHash, cosmosBatch(a, .wrong_hash));
    try std.testing.expectError(error.NoncanonicalCosmosTransaction, cosmosBatch(a, .reorg));
    try std.testing.expectError(error.InvalidCosmosJson, cosmosBatch(a, .missing));
    try std.testing.expectError(error.MissingCosmosField, cosmosBatch(a, .missing_index));
    try std.testing.expectError(error.CosmosTransactionIndexOutOfRange, cosmosBatch(a, .out_of_range));
    try std.testing.expectError(error.CosmosTransactionIndexMismatch, cosmosBatch(a, .mismatched_member));
    try std.testing.expectError(error.PendingReadIo, cosmosBatch(a, .pending));
    var fixture = try Fixture.init(a, .success);
    defer fixture.deinit();
    var unsupported = fixture.transaction;
    unsupported[0] = 1;
    try std.testing.expectError(error.UnsupportedCosmosTransactionId, fixture.adapter.interface().transactionEvents(a, unsupported));
    try std.testing.expectError(error.UnsupportedCosmosTransactionId, fixture.adapter.interface().transactionEvents(a, .{0} ** 64));
}
fn allocationFailures(a: A) !void {
    var batch = try cosmosBatch(a, .success);
    defer batch.deinit();
    try std.testing.expectEqual(@as(usize, 2), batch.events.len);
}
test "Cosmos transaction companion owns response-independent events on every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailures, .{});
}
test {
    _ = @import("agents/scraper/cosmos.zig");
}
