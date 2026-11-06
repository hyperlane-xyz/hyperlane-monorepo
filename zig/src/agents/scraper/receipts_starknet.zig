//! Actual Rust Starknet TxnInfo semantics, with strict hash/block/nonce bounds.
const std = @import("std");
const enrich = @import("enrichment.zig");
const common = @import("receipts_common.zig");
const src = @import("source.zig");
const provider = @import("../../starknet/provider.zig");
const rpc = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
pub const Starknet = struct {
    provider: *provider.Provider,
    http_owner: *http.HttpTransport,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Starknet) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = header };
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *Starknet = @ptrCast(@alignCast(context));
        const hash = try identity(meta);
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.provider.client.transport;
        try transport.verify(saved);
        self.provider.client.transport = transport.interface();
        defer self.provider.client.transport = saved;
        var transaction = try self.provider.client.call("starknet_getTransactionByHash", .{ .transaction_hash = hash });
        defer transaction.deinit();
        const receipt = try self.provider.canonicalReceipt(hash) orelse return error.ScraperReceiptUnavailable;
        _ = try common.milliseconds(deadline);
        return decode(a, meta, transaction.value(), receipt);
    }
    fn header(context: *anyopaque, meta: enrich.Meta, deadline: u64) !src.Header {
        const self: *Starknet = @ptrCast(@alignCast(context));
        _ = try identity(meta);
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.provider.client.transport;
        try transport.verify(saved);
        self.provider.client.transport = transport.interface();
        defer self.provider.client.transport = saved;
        const block = try self.provider.header(.{ .number = meta.block_number });
        if (!std.mem.eql(u8, &block.hash.toBytes(), &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        return .{ .height = block.number, .hash = block.hash.toBytes(), .parent = block.parent.toBytes(), .timestamp = block.timestamp };
    }
};
fn identity(meta: enrich.Meta) !provider.Felt {
    if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
    return provider.Felt.fromBytes(meta.tx_hash[32..64].*);
}
pub fn decode(a: std.mem.Allocator, meta: enrich.Meta, tx: rpc.Value, receipt: provider.Receipt) !enrich.OwnedTxn {
    const hash = try identity(meta);
    if (receipt.hash.value != hash.value or receipt.block_number != meta.block_number or !std.mem.eql(u8, &receipt.block_hash.toBytes(), &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
    if (!receipt.success) return error.FailedStarknetReceipt;
    if (!std.mem.eql(u8, try rpc.string(try rpc.field(tx, "type")), "INVOKE")) return error.UnsupportedStarknetTransaction;
    const version = (try provider.felt(try rpc.field(tx, "version"))).value;
    if (version != 1 and version != 3) return error.UnsupportedStarknetTransaction;
    if ((try provider.felt(try rpc.field(tx, "transaction_hash"))).value != hash.value) return error.ScraperReceiptIdentityMismatch;
    const nonce = try (try provider.felt(try rpc.field(tx, "nonce"))).integer(u64);
    const sender = try provider.felt(try rpc.field(tx, "sender_address"));
    const calldata = try rpc.field(tx, "calldata");
    if (calldata != .array or calldata.array.items.len > 32768) return error.StarknetCallTooLarge;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    const raw = try alloc.alloc(u8, try std.math.mul(usize, calldata.array.items.len, 32));
    var recipient: ?src.Hash = null;
    for (calldata.array.items, 0..) |word, index| {
        const value = try provider.felt(word);
        raw[index * 32 ..][0..32].* = value.toBytes();
        if (index == 1) recipient = value.toBytes();
    }
    return .{ .arena = arena, .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = 1, .gas_price = receipt.actual_fee, .effective_gas_price = receipt.actual_fee, .nonce = nonce, .sender = sender.toBytes(), .recipient = recipient, .gas_used = 1, .cumulative_gas_used = 1, .raw_input = raw } };
}

fn fixture(kind: []const u8) !std.json.Parsed(rpc.Value) {
    const a = std.testing.allocator;
    const fixture_bytes = try @import("../../testing/fixture.zig").bytes(a, @embedFile("../../starknet/fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var record = try std.json.parseFromSlice(rpc.Value, a, line, .{});
        defer record.deinit();
        if (!std.mem.eql(u8, kind, try rpc.string(try rpc.field(record.value, "kind")))) continue;
        var wire: std.ArrayList(u8) = .empty;
        defer wire.deinit(a);
        for ((try rpc.field(record.value, "wire_utf8_chunks")).array.items) |chunk| try wire.appendSlice(a, try rpc.string(chunk));
        return std.json.parseFromSlice(rpc.Value, a, wire.items, .{ .allocate = .alloc_always });
    }
    return error.MissingStarknetFixture;
}
test "Starknet actual SDK receipt and transaction fixture preserve paid-fee TxnInfo semantics" {
    const a = std.testing.allocator;
    var block = try fixture("rpc_block_transactions");
    defer block.deinit();
    var wire = try fixture("rpc_receipt");
    defer wire.deinit();
    const receipt = try provider.Receipt.parse(wire.value, try provider.Felt.init(0x55));
    const tx = (try rpc.field(block.value, "transactions")).array.items[0];
    var hash: [64]u8 = .{0} ** 64;
    hash[63] = 0x55;
    const meta: enrich.Meta = .{ .block_number = 10, .block_hash = (try provider.Felt.init(0xaa)).toBytes(), .tx_hash = hash };
    var result = try decode(a, meta, tx, receipt);
    defer result.deinit();
    try std.testing.expectEqual(@as(u256, 0x123), result.value.gas_price.?);
    try std.testing.expectEqual(@as(u256, 1), result.value.gas_limit);
    try std.testing.expectEqual(@as(u64, 0), result.value.nonce);
    try std.testing.expect(result.value.recipient == null);
    try std.testing.expectEqual(@as(usize, 0), result.value.raw_input.?.len);
    var wrong = meta;
    wrong.block_number = 9;
    try std.testing.expectError(error.ScraperReceiptIdentityMismatch, decode(a, wrong, tx, receipt));
    var reverted = receipt;
    reverted.success = false;
    try std.testing.expectError(error.FailedStarknetReceipt, decode(a, meta, tx, reverted));
}
test "Starknet receipt fetcher binds concrete deadline transport callbacks" {
    var fetcher: Starknet = .{ .provider = undefined, .http_owner = undefined };
    _ = fetcher.interface();
}
