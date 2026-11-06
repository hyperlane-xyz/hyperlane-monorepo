const std = @import("std");
const provider = @import("../evm/provider.zig");
const abi = @import("../evm/codecs.zig");
const settings = @import("../settings/types.zig");
const types = @import("types.zig");
const chain = @import("chain.zig");

pub const Evm = struct {
    rpc: *provider.RpcClient,
    reorg: settings.Reorg,
    allow_std_fixture: bool = false,

    pub fn interface(self: *Evm) chain.Chain {
        return .{
            .context = self,
            .latest_block_fn = latestBlock,
            .fee_history_fn = feeHistory,
            .estimate_gas_fn = estimateGas,
            .account_nonce_finalized_fn = accountNonceFinalized,
            .finalized_height_fn = finalizedHeight,
            .receipt_fn = receipt,
            .block_header_fn = blockHeader,
            .send_raw_fn = sendRaw,
            .call_fn = call,
            .get_code_fn = getCode,
            .zks_estimate_fee_fn = zksEstimateFee,
        };
    }

    fn transport(self: *Evm) !void {
        if (self.rpc.options.native_transport == null and !self.allow_std_fixture) return error.NativeLanderTransportRequired;
    }

    fn finalizedTag(self: *Evm, allocator: std.mem.Allocator, height: u64) ![]u8 {
        return switch (self.reorg) {
            .blocks => abi.quantityAlloc(allocator, height),
            .tag => |tag| {
                if (!std.mem.eql(u8, tag, "finalized")) return error.UnsupportedFinalityTag;
                return allocator.dupe(u8, "finalized");
            },
        };
    }

    fn finalizedHeight(context: *anyopaque) !u64 {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        return switch (self.reorg) {
            .blocks => |blocks| (try self.rpc.blockNumber()) -| blocks,
            .tag => |tag| {
                if (!std.mem.eql(u8, tag, "finalized")) return error.UnsupportedFinalityTag;
                var response = try self.rpc.call("eth_getBlockByNumber", .{ "finalized", false });
                defer response.deinit();
                return abi.quantity(try provider.string(try types.field(response.value(), "number")));
            },
        };
    }

    fn accountNonceFinalized(context: *anyopaque, signer: types.Address) !u256 {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const height = try finalizedHeight(context);
        const address = try abi.hexAlloc(self.rpc.allocator, &signer);
        defer self.rpc.allocator.free(address);
        const tag = try self.finalizedTag(self.rpc.allocator, height);
        defer self.rpc.allocator.free(tag);
        var response = try self.rpc.call("eth_getTransactionCount", .{ address, tag });
        defer response.deinit();
        return abi.quantityAs(u256, try provider.string(response.value()));
    }

    fn latestBlock(context: *anyopaque) !chain.LatestBlock {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        var response = try self.rpc.getBlock(.latest);
        defer response.deinit();
        const value = response.value();
        const base = types.optionalField(value, "baseFeePerGas");
        return .{
            .number = try abi.quantity(try provider.string(try types.field(value, "number"))),
            .base_fee = if (base == null or base.? == .null) null else try abi.quantityAs(u256, try provider.string(base.?)),
            .gas_limit = try abi.quantityAs(u256, try provider.string(try types.field(value, "gasLimit"))),
        };
    }

    fn feeHistory(context: *anyopaque, allocator: std.mem.Allocator, percentile: u64) !chain.FeeHistory {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const percent: f64 = @floatFromInt(percentile);
        var response = try self.rpc.call("eth_feeHistory", .{ "0xa", "latest", .{percent} });
        defer response.deinit();
        const reward = try types.field(response.value(), "reward");
        if (reward != .array) return error.InvalidRpcResult;
        const rewards = try allocator.alloc(u256, reward.array.items.len);
        errdefer allocator.free(rewards);
        for (reward.array.items, 0..) |row, i| {
            if (row != .array or row.array.items.len != 1) return error.InvalidRpcResult;
            rewards[i] = try abi.quantityAs(u256, try provider.string(row.array.items[0]));
        }
        return .{ .allocator = allocator, .rewards = rewards };
    }

    fn estimateGas(context: *anyopaque, request: types.Request, signer: types.Address) !u256 {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        var arena = std.heap.ArenaAllocator.init(self.rpc.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var object = std.json.ObjectMap.init(allocator);
        try object.put("from", .{ .string = try abi.hexAlloc(allocator, &signer) });
        switch (request) {
            .legacy => |tx| {
                try object.put("gasPrice", .{ .string = try types.quantity(allocator, tx.gas_price) });
                try putCommon(&object, allocator, tx.to, tx.value, tx.data);
            },
            .eip2930 => |tx| {
                try object.put("gasPrice", .{ .string = try types.quantity(allocator, tx.gas_price) });
                try putCommon(&object, allocator, tx.to, tx.value, tx.data);
                try putAccessList(&object, allocator, tx.access_list);
            },
            .eip1559 => |tx| {
                try object.put("maxFeePerGas", .{ .string = try types.quantity(allocator, tx.max_fee_per_gas) });
                try object.put("maxPriorityFeePerGas", .{ .string = try types.quantity(allocator, tx.max_priority_fee_per_gas) });
                try putCommon(&object, allocator, tx.to, tx.value, tx.data);
                try putAccessList(&object, allocator, tx.access_list);
            },
        }
        var response = try self.rpc.call("eth_estimateGas", .{std.json.Value{ .object = object }});
        defer response.deinit();
        return abi.quantityAs(u256, try provider.string(response.value()));
    }

    fn putCommon(object: *std.json.ObjectMap, allocator: std.mem.Allocator, to: ?types.Address, value: u256, data: []const u8) !void {
        if (to) |address| try object.put("to", .{ .string = try abi.hexAlloc(allocator, &address) });
        try object.put("value", .{ .string = try types.quantity(allocator, value) });
        try object.put("data", .{ .string = try abi.hexAlloc(allocator, data) });
    }

    fn putAccessList(object: *std.json.ObjectMap, allocator: std.mem.Allocator, access_list: []const @import("../evm/transaction.zig").AccessTuple) !void {
        const entries = try allocator.alloc(std.json.Value, access_list.len);
        for (access_list, 0..) |entry, i| {
            const keys = try allocator.alloc(std.json.Value, entry.storage_keys.len);
            for (entry.storage_keys, 0..) |key, j| keys[j] = .{ .string = try abi.hexAlloc(allocator, &key) };
            var tuple = std.json.ObjectMap.init(allocator);
            try tuple.put("address", .{ .string = try abi.hexAlloc(allocator, &entry.address) });
            try tuple.put("storageKeys", .{ .array = .{ .items = keys, .capacity = keys.len, .allocator = allocator } });
            entries[i] = .{ .object = tuple };
        }
        try object.put("accessList", .{ .array = .{ .items = entries, .capacity = entries.len, .allocator = allocator } });
    }

    fn receipt(context: *anyopaque, hash: types.Hash) !?chain.Receipt {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const text = try abi.hexAlloc(self.rpc.allocator, &hash);
        defer self.rpc.allocator.free(text);
        var response = try self.rpc.call("eth_getTransactionReceipt", .{text});
        defer response.deinit();
        if (response.value() == .null) return null;
        const number = types.optionalField(response.value(), "blockNumber");
        const block_hash = types.optionalField(response.value(), "blockHash");
        const actual_hash = try abi.fixedHex(32, try provider.string(try types.field(response.value(), "transactionHash")));
        if (!std.mem.eql(u8, &actual_hash, &hash)) return error.ReceiptIdentityMismatch;
        return .{
            .block_number = if (number == null or number.? == .null) null else try abi.quantity(try provider.string(number.?)),
            .block_hash = if (block_hash == null or block_hash.? == .null) null else try abi.fixedHex(32, try provider.string(block_hash.?)),
            .gas_used = try types.optionalUint(response.value(), "gasUsed"),
            .effective_gas_price = try types.optionalUint(response.value(), "effectiveGasPrice"),
            .executed = if (try types.optionalUint(response.value(), "status")) |status| status == 1 else true,
        };
    }

    fn blockHeader(context: *anyopaque, number: u64) !chain.Header {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const header = try self.rpc.blockHeader(.{ .number = number });
        if (header.number != number) return error.WrongBlock;
        return .{ .number = header.number, .hash = header.hash };
    }

    fn sendRaw(context: *anyopaque, signed_bytes: []const u8) !types.Hash {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const raw = try abi.hexAlloc(self.rpc.allocator, signed_bytes);
        defer self.rpc.allocator.free(raw);
        var response = try self.rpc.call("eth_sendRawTransaction", .{raw});
        defer response.deinit();
        return abi.fixedHex(32, try provider.string(response.value()));
    }

    fn call(context: *anyopaque, allocator: std.mem.Allocator, request: chain.Call, block: u64) ![]u8 {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const from = try abi.hexAlloc(allocator, &request.from);
        defer allocator.free(from);
        const to = try abi.hexAlloc(allocator, &request.to);
        defer allocator.free(to);
        const data = try abi.hexAlloc(allocator, request.calldata);
        defer allocator.free(data);
        const value = try types.quantity(allocator, request.value);
        defer allocator.free(value);
        const tag = try abi.quantityAlloc(allocator, block);
        defer allocator.free(tag);
        var response = try self.rpc.call("eth_call", .{ .{ .from = from, .to = to, .data = data, .value = value }, tag });
        defer response.deinit();
        const hex = try provider.string(response.value());
        if (hex.len < 2 or hex.len % 2 != 0) return error.InvalidRpcResult;
        const bytes = try allocator.alloc(u8, (hex.len - 2) / 2);
        errdefer allocator.free(bytes);
        _ = try abi.decodeHex(bytes, hex);
        return bytes;
    }

    fn getCode(context: *anyopaque, allocator: std.mem.Allocator, address: types.Address) ![]u8 {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        const text = try abi.hexAlloc(allocator, &address);
        defer allocator.free(text);
        var response = try self.rpc.call("eth_getCode", .{ text, "latest" });
        defer response.deinit();
        const hex = try provider.string(response.value());
        if (hex.len < 2 or hex.len % 2 != 0) return error.InvalidRpcResult;
        const bytes = try allocator.alloc(u8, (hex.len - 2) / 2);
        errdefer allocator.free(bytes);
        _ = try abi.decodeHex(bytes, hex);
        return bytes;
    }

    fn zksEstimateFee(context: *anyopaque, request: types.Request, signer: types.Address) !chain.ZksFee {
        const self: *Evm = @ptrCast(@alignCast(context));
        try self.transport();
        var arena = std.heap.ArenaAllocator.init(self.rpc.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        var object = std.json.ObjectMap.init(allocator);
        try object.put("from", .{ .string = try abi.hexAlloc(allocator, &signer) });
        switch (request) {
            .legacy => |tx| {
                try object.put("gas", .{ .string = try types.quantity(allocator, tx.gas_limit) });
                try object.put("gasPrice", .{ .string = try types.quantity(allocator, tx.gas_price) });
                try putCommon(&object, allocator, tx.to, tx.value, tx.data);
            },
            .eip2930 => |tx| {
                try object.put("gas", .{ .string = try types.quantity(allocator, tx.gas_limit) });
                try object.put("gasPrice", .{ .string = try types.quantity(allocator, tx.gas_price) });
                try putCommon(&object, allocator, tx.to, tx.value, tx.data);
                try putAccessList(&object, allocator, tx.access_list);
            },
            .eip1559 => |tx| {
                try object.put("gas", .{ .string = try types.quantity(allocator, tx.gas_limit) });
                try object.put("maxFeePerGas", .{ .string = try types.quantity(allocator, tx.max_fee_per_gas) });
                try object.put("maxPriorityFeePerGas", .{ .string = try types.quantity(allocator, tx.max_priority_fee_per_gas) });
                try putCommon(&object, allocator, tx.to, tx.value, tx.data);
                try putAccessList(&object, allocator, tx.access_list);
            },
        }
        var response = try self.rpc.call("zks_estimateFee", .{std.json.Value{ .object = object }});
        defer response.deinit();
        return .{
            .gas_limit = try types.uintField(response.value(), "gas_limit"),
            .max_fee_per_gas = try types.uintField(response.value(), "max_fee_per_gas"),
            .max_priority_fee_per_gas = try types.uintField(response.value(), "max_priority_fee_per_gas"),
            .gas_per_pubdata_limit = try types.uintField(response.value(), "gas_per_pubdata_limit"),
        };
    }
};
