const std = @import("std");
const rpc = @import("../net/json_rpc.zig");
const codec = @import("codec.zig");
const tx = @import("transaction.zig");
const native = @import("crypto.zig");
pub const Felt = codec.Felt;
pub const Value = std.json.Value;
pub const BlockId = union(enum) {
    latest,
    number: u64,
    hash: Felt,
    pub fn jsonStringify(self: BlockId, writer: anytype) std.json.Stringify.Error!void {
        switch (self) {
            .latest => try writer.write("latest"),
            .number => |n| try writer.write(.{ .block_number = n }),
            .hash => |h| try writer.write(.{ .block_hash = h }),
        }
    }
};
pub const ReorgPeriod = union(enum) { none, blocks: u64, tag: []const u8 };
pub const Header = struct {
    number: u64,
    hash: Felt,
    parent: Felt,
    timestamp: u64,
    accepted_on_l1: bool,
    pub fn parse(value: Value) !Header {
        const status = try rpc.string(try rpc.field(value, "status"));
        const l1 = std.mem.eql(u8, status, "ACCEPTED_ON_L1");
        if (!l1 and !std.mem.eql(u8, status, "ACCEPTED_ON_L2")) return error.UnconfirmedStarknetBlock;
        return .{ .number = try rpc.integer(u64, try rpc.field(value, "block_number")), .hash = try felt(try rpc.field(value, "block_hash")), .parent = try felt(try rpc.field(value, "parent_hash")), .timestamp = try rpc.integer(u64, try rpc.field(value, "timestamp")), .accepted_on_l1 = l1 };
    }
};
pub const Receipt = struct {
    hash: Felt,
    block_number: u64,
    block_hash: Felt,
    accepted_on_l1: bool,
    success: bool,
    actual_fee: u256,
    pub fn parse(value: Value, expected: Felt) !Receipt {
        if (!std.mem.eql(u8, try rpc.string(try rpc.field(value, "type")), "INVOKE")) return error.UnsupportedStarknetReceipt;
        const hash = try felt(try rpc.field(value, "transaction_hash"));
        if (hash.value != expected.value) return error.WrongStarknetReceipt;
        const finality = try rpc.string(try rpc.field(value, "finality_status"));
        const l1 = std.mem.eql(u8, finality, "ACCEPTED_ON_L1");
        if (!l1 and !std.mem.eql(u8, finality, "ACCEPTED_ON_L2")) return error.UnconfirmedStarknetReceipt;
        const status = try rpc.string(try rpc.field(value, "execution_status"));
        const success = std.mem.eql(u8, status, "SUCCEEDED");
        if (!success and !std.mem.eql(u8, status, "REVERTED")) return error.InvalidStarknetReceipt;
        const fee = try rpc.field(value, "actual_fee");
        const unit = try rpc.string(try rpc.field(fee, "unit"));
        if (!std.mem.eql(u8, unit, "FRI") and !std.mem.eql(u8, unit, "WEI")) return error.InvalidStarknetReceipt;
        return .{ .hash = hash, .block_number = try rpc.integer(u64, try rpc.field(value, "block_number")), .block_hash = try felt(try rpc.field(value, "block_hash")), .accepted_on_l1 = l1, .success = success, .actual_fee = (try felt(try rpc.field(fee, "amount"))).value };
    }
};
pub const Provider = struct {
    allocator: std.mem.Allocator,
    client: rpc.Client,
    max_call_felts: usize = 32 * 1024,
    max_event_pages: usize = 128,
    max_events: usize = 8192,
    max_event_range: u64 = 2000,
    max_event_bytes: usize = 64 * 1024 * 1024,
    pub fn chainId(self: *Provider) !Felt {
        var response = try self.client.call("starknet_chainId", .{});
        defer response.deinit();
        return felt(response.value());
    }
    pub fn checkChain(self: *Provider, expected: Felt) !void {
        if ((try self.chainId()).value != expected.value) return error.WrongStarknetChain;
    }
    pub fn blockNumber(self: *Provider) !u64 {
        var response = try self.client.call("starknet_blockNumber", .{});
        defer response.deinit();
        return rpc.integer(u64, response.value());
    }
    pub fn height(self: *Provider, period: ReorgPeriod) !u64 {
        return switch (period) {
            .none => self.blockNumber(),
            .blocks => |lag| (try self.blockNumber()) -| lag,
            .tag => error.InvalidStarknetReorgPeriod,
        };
    }
    pub fn header(self: *Provider, block: BlockId) !Header {
        var response = try self.client.call("starknet_getBlockWithTxHashes", .{ .block_id = block });
        defer response.deinit();
        const parsed = try Header.parse(response.value());
        switch (block) {
            .number => |n| if (parsed.number != n) return error.WrongStarknetBlock,
            .hash => |h| if (parsed.hash.value != h.value) return error.WrongStarknetBlock,
            .latest => {},
        }
        return parsed;
    }
    pub fn nonce(self: *Provider, address: Felt, block: BlockId) !Felt {
        var response = try self.client.call("starknet_getNonce", .{ .block_id = block, .contract_address = address });
        defer response.deinit();
        return felt(response.value());
    }
    pub fn call(self: *Provider, address: Felt, entrypoint: Felt, calldata: []const Felt, block: BlockId) ![]Felt {
        if (calldata.len > self.max_call_felts) return error.StarknetCallTooLarge;
        var response = try self.client.call("starknet_call", .{ .request = .{ .contract_address = address, .entry_point_selector = entrypoint, .calldata = calldata }, .block_id = block });
        defer response.deinit();
        return feltArray(self.allocator, response.value(), self.max_call_felts);
    }
    pub fn balance(self: *Provider, token: Felt, owner: Felt) !u256 {
        const values = try self.call(token, codec.selector("balanceOf"), &.{owner}, .latest);
        defer self.allocator.free(values);
        var decoder: codec.Decoder = .{ .input = values };
        const value = try decoder.uint256();
        try decoder.finish();
        return value;
    }
    pub fn isContract(self: *Provider, address: Felt, block: BlockId) !bool {
        var response = try self.client.callEnvelope("starknet_getClassHashAt", .{ .block_id = block, .contract_address = address });
        defer response.deinit();
        if (response.remoteError()) |err| {
            if (err.code == 20) return false;
            return error.StarknetRpcError;
        }
        return (try felt(response.value())).value != 0;
    }
    pub fn receiptEnvelope(self: *Provider, hash: Felt) !?rpc.Envelope {
        var response = try self.client.callEnvelope("starknet_getTransactionReceipt", .{ .transaction_hash = hash });
        errdefer response.deinit();
        if (response.remoteError()) |err| {
            if (err.code == 29) {
                response.deinit();
                return null;
            }
            return error.StarknetRpcError;
        }
        return response;
    }
    pub fn receipt(self: *Provider, hash: Felt) !?Receipt {
        var response = try self.receiptEnvelope(hash) orelse return null;
        defer response.deinit();
        return try Receipt.parse(response.value(), hash);
    }
    pub fn canonicalReceipt(self: *Provider, hash: Felt) !?Receipt {
        const found = try self.receipt(hash) orelse return null;
        if ((try self.header(.{ .number = found.block_number })).hash.value != found.block_hash.value) return error.NoncanonicalStarknetReceipt;
        return found;
    }
    /// Signed query invokes preserve SDK validation. Empty signatures require
    /// explicit skip_validate, matching the SDK's interactive-signer path.
    pub fn estimateFee(self: *Provider, transaction: tx.Transaction, signature: []const Felt, skip_validate: bool) !tx.FeeEstimate {
        if (signature.len == 0 and !skip_validate) return error.StarknetQuerySignatureRequired;
        const flags: []const []const u8 = if (skip_validate) &.{"SKIP_VALIDATE"} else &.{};
        var response = try self.client.call("starknet_estimateFee", .{ .request = .{transaction.request(signature, true)}, .simulation_flags = flags, .block_id = BlockId.latest });
        defer response.deinit();
        const value = response.value();
        if (value != .array or value.array.items.len != 1) return error.InvalidStarknetFeeEstimate;
        return feeEstimate(value.array.items[0]);
    }
    pub fn simulate(self: *Provider, transaction: tx.Transaction, signature: []const Felt, skip_validate: bool, skip_fee_charge: bool) !rpc.Envelope {
        if (signature.len == 0 and !skip_validate) return error.StarknetQuerySignatureRequired;
        var flags: [2][]const u8 = undefined;
        var count: usize = 0;
        if (skip_validate) {
            flags[count] = "SKIP_VALIDATE";
            count += 1;
        }
        if (skip_fee_charge) {
            flags[count] = "SKIP_FEE_CHARGE";
            count += 1;
        }
        return self.client.call("starknet_simulateTransactions", .{ .block_id = BlockId.latest, .transactions = .{transaction.request(signature, true)}, .simulation_flags = flags[0..count] });
    }
    pub fn medianTip(self: *Provider) !u64 {
        var response = try self.client.call("starknet_getBlockWithTxs", .{ .block_id = BlockId.latest });
        defer response.deinit();
        _ = try Header.parse(response.value());
        const values = try rpc.field(response.value(), "transactions");
        if (values != .array) return error.InvalidStarknetBlock;
        var tips: std.ArrayList(u64) = .empty;
        defer tips.deinit(self.allocator);
        for (values.array.items) |value| {
            const kind = try rpc.string(try rpc.field(value, "type"));
            if (std.mem.eql(u8, kind, "DEPLOY") or std.mem.eql(u8, kind, "L1_HANDLER")) continue;
            const invoke = std.mem.eql(u8, kind, "INVOKE");
            const declare = std.mem.eql(u8, kind, "DECLARE");
            const deploy = std.mem.eql(u8, kind, "DEPLOY_ACCOUNT");
            if (!invoke and !declare and !deploy) return error.UnsupportedStarknetTransaction;
            const version = (try felt(try rpc.field(value, "version"))).value;
            if (version > 3 or (invoke and version == 2) or (deploy and version != 1 and version != 3)) return error.UnsupportedStarknetTransactionVersion;
            if (version != 3) continue;
            try tips.append(self.allocator, try (try felt(try rpc.field(value, "tip"))).integer(u64));
        }
        if (tips.items.len == 0) return 0;
        std.mem.sort(u64, tips.items, {}, std.sort.asc(u64));
        const n = tips.items.len;
        return if (n % 2 == 1) tips.items[n / 2] else @intCast((@as(u128, tips.items[n / 2 - 1]) + tips.items[n / 2]) / 2);
    }
    /// Reads/signs only the non-executable query version. Returned production
    /// intent must be durably reserved before its separate signing call.
    pub const PreparedQuote = struct { transaction: tx.Transaction, estimate: tx.FeeEstimate };
    pub fn prepare(self: *Provider, cryptography: *native.Crypto, signer: tx.Signer, expected_chain: Felt, sender: Felt, calls: []const tx.Call, encoding: tx.Encoding, maximum_resource_fee: u256) !tx.Transaction {
        return (try self.prepareQuoted(cryptography, signer, expected_chain, sender, calls, encoding, maximum_resource_fee)).transaction;
    }
    pub fn prepareQuoted(self: *Provider, cryptography: *native.Crypto, signer: tx.Signer, expected_chain: Felt, sender: Felt, calls: []const tx.Call, encoding: tx.Encoding, maximum_resource_fee: u256) !PreparedQuote {
        try self.checkChain(expected_chain);
        const next_nonce = try self.nonce(sender, .latest);
        var transaction = try tx.Transaction.init(self.allocator, expected_chain, sender, next_nonce, .{}, calls, encoding);
        errdefer transaction.deinit();
        const query = try transaction.sign(cryptography, signer, true);
        const estimate = try self.estimateFee(transaction, &query.signature, false);
        transaction.bounds = try estimate.bounds();
        if (try tx.resourceBudget(transaction.bounds) > maximum_resource_fee) return error.StarknetFeeCapExceeded;
        transaction.tip = try self.medianTip();
        return .{ .transaction = transaction, .estimate = estimate };
    }
    /// Caller persists the signed intent before this explicit irreversible API.
    /// There is no implicit nonce refresh, retry-signing or submission loop.
    pub fn broadcast(self: *Provider, cryptography: *native.Crypto, transaction: tx.Transaction, signed: tx.Signed) !Felt {
        if (signed.query_only) return error.CannotBroadcastStarknetQuery;
        try transaction.validateSigned(cryptography, signed);
        var response = try self.client.call("starknet_addInvokeTransaction", .{ .invoke_transaction = transaction.request(&signed.signature, false) });
        defer response.deinit();
        const hash = try felt(try rpc.field(response.value(), "transaction_hash"));
        if (hash.value != signed.hash.value) return error.WrongStarknetTransactionHash;
        return hash;
    }
};
pub fn felt(value: Value) !Felt {
    return Felt.fromHex(try rpc.string(value));
}
pub fn feltArray(allocator: std.mem.Allocator, value: Value, maximum: usize) ![]Felt {
    if (value != .array or value.array.items.len > maximum) return error.InvalidStarknetFeltArray;
    const result = try allocator.alloc(Felt, value.array.items.len);
    errdefer allocator.free(result);
    for (value.array.items, result) |item, *out| out.* = try felt(item);
    return result;
}
pub fn feeEstimate(value: Value) !tx.FeeEstimate {
    if (value != .object) return error.InvalidStarknetFeeEstimate;
    if (value.object.get("unit")) |unit| if (unit != .null and !std.mem.eql(u8, try rpc.string(unit), "FRI")) return error.InvalidStarknetFeeEstimate;
    return .{ .l1_gas_consumed = try (try felt(try rpc.field(value, "l1_gas_consumed"))).integer(u64), .l1_gas_price = try (try felt(try rpc.field(value, "l1_gas_price"))).integer(u128), .l2_gas_consumed = try (try felt(try rpc.field(value, "l2_gas_consumed"))).integer(u64), .l2_gas_price = try (try felt(try rpc.field(value, "l2_gas_price"))).integer(u128), .l1_data_gas_consumed = try (try felt(try rpc.field(value, "l1_data_gas_consumed"))).integer(u64), .l1_data_gas_price = try (try felt(try rpc.field(value, "l1_data_gas_price"))).integer(u128), .overall_fee = try (try felt(try rpc.field(value, "overall_fee"))).integer(u128) };
}

test "Starknet provider latest confirmed calls reorg periods safe remote codes and typed receipt" {
    const a = std.testing.allocator;
    const mock = @import("../cloud/testing.zig");
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":100}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":[\"0x1\",\"0x2\"]}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":20,\"message\":\"not found\"}}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":4,\"error\":{\"code\":29,\"message\":\"not found\"}}" },
    } };
    var provider: Provider = .{ .allocator = a, .client = try rpc.Client.init(a, script.transport(), &.{.{ .url = "https://fixture/rpc" }}, .{}) };
    try std.testing.expectEqual(@as(u64, 95), try provider.height(.{ .blocks = 5 }));
    try std.testing.expectEqual((@as(u256, 2) << 128) + 1, try provider.balance(try Felt.init(1), try Felt.init(2)));
    try std.testing.expect(!try provider.isContract(try Felt.init(3), .latest));
    try std.testing.expect(try provider.receipt(try Felt.init(4)) == null);
    try std.testing.expectError(error.InvalidStarknetReorgPeriod, provider.height(.{ .tag = "finalized" }));
    try script.expectDone();
}
