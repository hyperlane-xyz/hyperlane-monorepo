//! Tron production receipt enrichment uses its Ethereum-compatible JSON-RPC
//! pool. Wallet solidified headers remain the indexing authority.
const std = @import("std");
const enrich = @import("enrichment.zig");
const src = @import("source.zig");
const evm = @import("receipts_evm.zig");
const common = @import("receipts_common.zig");
const abi = @import("../../evm/codecs.zig");
const rpc = @import("../../tron/rpc.zig");
pub const Tron = struct {
    provider: *@import("../../tron/provider.zig").Provider,
    http_owner: *@import("../../cloud/http.zig").HttpTransport,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Tron) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = header };
    }
    fn fetch(context: *anyopaque, allocator: std.mem.Allocator, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *Tron = @ptrCast(@alignCast(context));
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.provider.jsonrpc.transport;
        try transport.verify(saved);
        self.provider.jsonrpc.transport = transport.interface();
        defer self.provider.jsonrpc.transport = saved;
        const hash = try abi.hexAlloc(allocator, meta.tx_hash[32..]);
        defer allocator.free(hash);
        var transaction = try self.provider.jsonrpc.call("eth_getTransactionByHash", .{hash});
        defer transaction.deinit();
        if (rpc.result(transaction) == .null) return error.ScraperTransactionUnavailable;
        var receipt = try self.provider.jsonrpc.call("eth_getTransactionReceipt", .{hash});
        defer receipt.deinit();
        if (rpc.result(receipt) == .null) return error.ScraperReceiptUnavailable;
        _ = try common.milliseconds(deadline);
        return evm.decodePair(allocator, meta, rpc.result(transaction), rpc.result(receipt));
    }
    fn header(context: *anyopaque, meta: enrich.Meta, deadline: u64) !src.Header {
        const self: *Tron = @ptrCast(@alignCast(context));
        var transport: common.DeadlineTransport = .{ .rpc_read = true, .owner = self.http_owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_std_fixture };
        const saved = self.provider.solidity.transport;
        try transport.verify(saved);
        self.provider.solidity.transport = transport.interface();
        defer self.provider.solidity.transport = saved;
        const value = try self.provider.solidBlock(meta.block_number);
        if (!std.mem.eql(u8, &value.id, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        // Tron wallet's block ID commits to height; indexing retrieves the same
        // solidified header and uses the preceding canonical ID as its parent.
        const previous = if (meta.block_number > 0) (try self.provider.solidBlock(meta.block_number - 1)).id else [_]u8{0} ** 32;
        return .{ .height = value.number, .hash = value.id, .parent = previous, .timestamp = value.timestamp_ms / 1000 };
    }
};
