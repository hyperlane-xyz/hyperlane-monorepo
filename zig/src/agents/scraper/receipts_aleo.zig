//! Actual Aleo TxnInfo: fee microcredits as gas, fee payer as sender, first
//! transition program as recipient, replay randomness represented by nonce0.
const std = @import("std");
const enrich = @import("enrichment.zig");
const common = @import("receipts_common.zig");
const src = @import("source.zig");
const native = @import("../../aleo/events.zig");
const provider = @import("../../aleo/provider.zig");
const rpc = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
pub const Aleo = struct {
    provider: *provider.Provider,
    decoder: native.NativeDecoder,
    http_owner: *http.HttpTransport,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Aleo) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = header };
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *Aleo = @ptrCast(@alignCast(context));
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.provider.client.transport;
        try transport.verify(saved);
        self.provider.client.transport = transport.interface();
        defer self.provider.client.transport = saved;
        const id = try self.provider.native.idText(a, .transaction, meta.tx_hash[32..64].*);
        defer a.free(id);
        var response = try self.provider.client.get(&.{ "transaction", id }, &.{});
        defer response.deinit();
        const wire = try std.json.Stringify.valueAlloc(a, response.value(), .{});
        defer a.free(wire);
        var decoder = self.decoder;
        decoder.limits.timeout_ms = @min(decoder.limits.timeout_ms, try common.milliseconds(deadline));
        var info = try decoder.transactionInfo(a, wire);
        defer info.deinit();
        if (!std.mem.eql(u8, &try self.provider.native.id(.transaction, try rpc.string(try rpc.field(info.value, "id"))), meta.tx_hash[32..64])) return error.ScraperReceiptIdentityMismatch;
        var location = try self.provider.client.get(&.{ "find", "blockHash", id }, &.{});
        defer location.deinit();
        if (!std.mem.eql(u8, &try self.provider.native.id(.block, try rpc.string(location.value())), &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        const block = try self.provider.header(std.math.cast(u32, meta.block_number) orelse return error.AleoHeightOverflow);
        if (!std.mem.eql(u8, &block.hash, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        _ = try common.milliseconds(deadline);
        return decode(a, meta, info.value);
    }
    fn header(context: *anyopaque, meta: enrich.Meta, deadline: u64) !src.Header {
        const self: *Aleo = @ptrCast(@alignCast(context));
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.provider.client.transport;
        try transport.verify(saved);
        self.provider.client.transport = transport.interface();
        defer self.provider.client.transport = saved;
        const block = try self.provider.header(std.math.cast(u32, meta.block_number) orelse return error.AleoHeightOverflow);
        if (!std.mem.eql(u8, &block.hash, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        return .{ .height = block.height, .hash = block.hash, .parent = block.parent, .timestamp = block.timestamp };
    }
};
fn bytes(value: rpc.Value) ![32]u8 {
    if (value != .array or value.array.items.len != 32) return error.InvalidAleoTransactionMetadata;
    var result: [32]u8 = undefined;
    for (value.array.items, &result) |item, *out| out.* = try rpc.integer(u8, item);
    return result;
}
fn decode(a: std.mem.Allocator, meta: enrich.Meta, value: rpc.Value) !enrich.OwnedTxn {
    const fee = try rpc.integer(u64, try rpc.field(value, "fee"));
    const sender = try bytes(try rpc.field(value, "sender"));
    const recipient = try rpc.field(value, "recipient");
    const to: ?src.Hash = if (recipient == .null) null else try bytes(recipient);
    return .{ .arena = std.heap.ArenaAllocator.init(a), .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = fee, .gas_price = 1, .max_fee = 1, .effective_gas_price = 1, .nonce = 0, .sender = sender, .recipient = to, .gas_used = fee, .cumulative_gas_used = fee } };
}
test "Aleo receipt projection retains source fee-as-gas and zero-sender semantics" {
    const a = std.testing.allocator;
    var sender: [32]u8 = .{0} ** 32;
    sender[0] = 1;
    const wire = try std.json.Stringify.valueAlloc(a, .{ .fee = @as(u64, 123), .sender = [_]u16{0} ** 32, .recipient = ([_]u16{1} ++ [_]u16{0} ** 31) }, .{});
    defer a.free(wire);
    var parsed = try std.json.parseFromSlice(rpc.Value, a, wire, .{});
    defer parsed.deinit();
    const meta: enrich.Meta = .{ .block_number = 1, .block_hash = .{2} ** 32, .tx_hash = .{3} ** 64 };
    var result = try decode(a, meta, parsed.value);
    defer result.deinit();
    try std.testing.expectEqual(@as(u256, 123), result.value.gas_limit);
    try std.testing.expectEqual(@as(u256, 1), result.value.gas_price.?);
    try std.testing.expect(std.mem.allEqual(u8, &result.value.sender, 0));
    try std.testing.expectEqual(sender, result.value.recipient.?);
}
test "Aleo receipt fetcher binds concrete native and deadline transport callbacks" {
    var fetcher: Aleo = .{ .provider = undefined, .decoder = undefined, .http_owner = undefined };
    _ = fetcher.interface();
}
