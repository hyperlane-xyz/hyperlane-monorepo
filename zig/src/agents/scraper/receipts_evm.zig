//! Concrete EVM transaction + receipt enrichment. Each job owns a serial RPC
//! client and absolute monotonic deadline; every RPC consumes the same budget.
const std = @import("std");
const enrich = @import("enrichment.zig");
const src = @import("source.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
pub fn nowNs() !u64 {
    const instant = try std.time.Instant.now();
    return try std.math.add(u64, try std.math.mul(u64, std.math.cast(u64, instant.timestamp.sec) orelse return error.UnsupportedClock, 1000000000), @intCast(instant.timestamp.nsec));
}
fn field(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidReceiptJson;
    return value.object.get(name) orelse error.MissingReceiptField;
}
fn quantity(value: std.json.Value) !u256 {
    const text = try rpc.string(value);
    if (text.len < 3 or text.len > 66 or !std.mem.startsWith(u8, text, "0x") or (text.len > 3 and text[2] == '0')) return error.InvalidReceiptQuantity;
    for (text[2..]) |char| if (!std.ascii.isHex(char)) return error.InvalidReceiptQuantity;
    return std.fmt.parseInt(u256, text[2..], 16);
}
fn optionalQuantity(value: std.json.Value, name: []const u8) !?u256 {
    const actual = value.object.get(name) orelse return null;
    return if (actual == .null) null else try quantity(actual);
}
fn address(value: std.json.Value) !src.Hash {
    const raw = try abi.fixedHex(20, try rpc.string(value));
    var out: src.Hash = .{0} ** 32;
    @memcpy(out[12..], &raw);
    return out;
}
fn validate(value: std.json.Value, meta: enrich.Meta, tx_field: []const u8) !void {
    const block = try abi.fixedHex(32, try rpc.string(try field(value, "blockHash")));
    const transaction = try abi.fixedHex(32, try rpc.string(try field(value, tx_field)));
    const height = try abi.quantity(try rpc.string(try field(value, "blockNumber")));
    if (!std.mem.eql(u8, &block, &meta.block_hash) or !std.mem.eql(u8, &transaction, meta.tx_hash[32..64]) or height != meta.block_number) return error.ScraperReceiptIdentityMismatch;
}
pub const Evm = struct {
    rpc_client: *rpc.RpcClient,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Evm) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = fetchHeader };
    }
    fn budget(self: *Evm, deadline: u64) !void {
        const now = try nowNs();
        if (now >= deadline) return error.ScraperReceiptDeadline;
        const ms = (deadline - now) / 1000000 + @intFromBool((deadline - now) % 1000000 != 0);
        self.rpc_client.options.owner_deadline_ns = @min(self.rpc_client.options.owner_deadline_ns orelse deadline, deadline);
        self.rpc_client.options.timeout_ms = @intCast(@min(@min(ms, std.math.maxInt(u32)), self.rpc_client.options.timeout_ms));
        self.rpc_client.options.connect_timeout_ms = @min(self.rpc_client.options.connect_timeout_ms, self.rpc_client.options.timeout_ms);
    }
    fn fetchHeader(context: *anyopaque, meta: enrich.Meta, deadline_ns: u64) !src.Header {
        const self: *Evm = @ptrCast(@alignCast(context));
        if (self.rpc_client.options.native_transport == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        const saved = self.rpc_client.options;
        defer self.rpc_client.options = saved;
        try self.budget(deadline_ns);
        const header = try self.rpc_client.blockHeader(.{ .number = meta.block_number });
        if (!std.mem.eql(u8, &header.hash, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        return .{ .height = header.number, .hash = header.hash, .parent = header.parent_hash, .timestamp = header.timestamp };
    }
    fn fetch(context: *anyopaque, allocator: std.mem.Allocator, meta: enrich.Meta, deadline_ns: u64) !enrich.OwnedTxn {
        const self: *Evm = @ptrCast(@alignCast(context));
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
        if (self.rpc_client.options.native_transport == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        const saved = self.rpc_client.options;
        defer self.rpc_client.options = saved;
        const hash = try abi.hexAlloc(allocator, meta.tx_hash[32..]);
        defer allocator.free(hash);
        try self.budget(deadline_ns);
        var transaction = try self.rpc_client.call("eth_getTransactionByHash", .{hash});
        defer transaction.deinit();
        if (transaction.value() == .null) return error.ScraperTransactionUnavailable;
        try validate(transaction.value(), meta, "hash");
        try self.budget(deadline_ns);
        var receipt = try self.rpc_client.call("eth_getTransactionReceipt", .{hash});
        defer receipt.deinit();
        if (receipt.value() == .null) return error.ScraperReceiptUnavailable;
        try validate(receipt.value(), meta, "transactionHash");
        if (try nowNs() >= deadline_ns) return error.ScraperReceiptDeadline;
        return decodePair(allocator, meta, transaction.value(), receipt.value());
    }
};

/// Shared exact Ethereum JSON-RPC receipt shape, also supplied by Tron.
pub fn decodePair(allocator: std.mem.Allocator, meta: enrich.Meta, t: std.json.Value, r: std.json.Value) !enrich.OwnedTxn {
    if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
    try validate(t, meta, "hash");
    try validate(r, meta, "transactionHash");
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const recipient = try field(t, "to");
    const input = try rpc.string(try field(t, "input"));
    if (input.len < 2 or input.len % 2 != 0) return error.InvalidReceiptInput;
    const raw = try a.alloc(u8, (input.len - 2) / 2);
    _ = try abi.decodeHex(raw, input);
    return .{ .arena = arena, .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = try quantity(try field(t, "gas")), .max_priority_fee = try optionalQuantity(t, "maxPriorityFeePerGas"), .max_fee = try optionalQuantity(t, "maxFeePerGas"), .gas_price = try optionalQuantity(t, "gasPrice"), .effective_gas_price = try optionalQuantity(r, "effectiveGasPrice"), .nonce = try abi.quantity(try rpc.string(try field(t, "nonce"))), .sender = try address(try field(t, "from")), .recipient = if (recipient == .null) null else try address(recipient), .gas_used = try quantity(try field(r, "gasUsed")), .cumulative_gas_used = try quantity(try field(r, "cumulativeGasUsed")), .raw_input = raw } };
}
