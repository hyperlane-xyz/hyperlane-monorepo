const std = @import("std");
const rpc = @import("rpc.zig");
const tx = @import("transaction.zig");
const wire = @import("../altvm/tron.zig");
const abi = @import("../evm/codecs.zig");
const evm = @import("../evm/provider.zig");
const A = std.mem.Allocator;
pub const Hash = [32]u8;
pub const Address = [20]u8;
pub const Block = struct {
    number: u64,
    id: Hash,
    timestamp_ms: u64,
    pub fn parse(value: rpc.Value) !Block {
        const raw = try rpc.field(try rpc.field(value, "block_header"), "raw_data");
        return .{ .number = try rpc.nonnegative(try rpc.field(raw, "number")), .id = try unprefixedFixed(32, try rpc.string(try rpc.field(value, "blockID"))), .timestamp_ms = try rpc.nonnegative(try rpc.field(raw, "timestamp")) };
    }
};
pub const Receipt = struct {
    id: Hash,
    block_number: ?u64,
    block_hash: ?Hash,
    success: ?bool,
    energy_used: ?u256,
    energy_price: ?u256 = null,
    pub fn parse(value: rpc.Value, expected_id: Hash) !Receipt {
        const id = try abi.fixedHex(32, try rpc.string(try rpc.field(value, "transactionHash")));
        if (!std.mem.eql(u8, &id, &expected_id)) return error.WrongTronReceipt;
        const number = try rpc.field(value, "blockNumber");
        const hash = try rpc.field(value, "blockHash");
        if ((number == .null) != (hash == .null)) return error.InvalidTronReceipt;
        const status = if (value.object.get("status")) |v| if (v == .null) null else try quantity256(try rpc.string(v)) else null;
        if (status != null and status.? > 1) return error.InvalidTronReceipt;
        const gas = if (value.object.get("gasUsed")) |v| if (v == .null) null else try quantity256(try rpc.string(v)) else null;
        const price = if (value.object.get("effectiveGasPrice")) |v| if (v == .null) null else try quantity256(try rpc.string(v)) else null;
        return .{ .id = id, .block_number = if (number == .null) null else try abi.quantity(try rpc.string(number)), .block_hash = if (hash == .null) null else try abi.fixedHex(32, try rpc.string(hash)), .success = if (status) |s| s == 1 else null, .energy_used = gas, .energy_price = price };
    }
};
pub const Status = enum { pending, expired, included, finalized };
pub const Broadcast = struct { accepted: bool, classification: tx.SubmissionError };
pub const Logs = struct {
    allocator: A,
    items: []evm.Log,
    pub fn deinit(self: *Logs) void {
        for (self.items) |*log| log.deinit();
        self.allocator.free(self.items);
        self.* = undefined;
    }
};

pub const Config = struct {
    rpc_urls: []const rpc.Endpoint,
    wallet_urls: []const rpc.Endpoint,
    wallet_solidity_urls: []const rpc.Endpoint,
    signer_address: ?Address = null,
    max_response_bytes: usize = 8 * 1024 * 1024,
    max_log_range: u64 = 2000,
};

/// Pool endpoint/header storage and transports are borrowed. Calls are serial.
/// Runtime scheduling, persistence of signing intents and retries are external.
pub const Provider = struct {
    allocator: A,
    wallet: rpc.Pool,
    solidity: rpc.Pool,
    jsonrpc: rpc.Pool,
    signer_address: ?Address = null,
    max_log_range: u64 = 2000,

    pub fn init(allocator: A, transport: @import("../cloud/http.zig").Transport, config: Config) !Provider {
        if (config.max_response_bytes < 2 or config.max_log_range == 0) return error.InvalidTronLimit;
        for ([_][]const rpc.Endpoint{ config.rpc_urls, config.wallet_urls, config.wallet_solidity_urls }) |endpoints| {
            if (endpoints.len == 0) return error.EmptyTronPool;
            for (endpoints) |endpoint| {
                const url = try rpc.appendPath(allocator, endpoint.url, "");
                allocator.free(url);
            }
        }
        return .{ .allocator = allocator, .wallet = .{ .allocator = allocator, .transport = transport, .endpoints = config.wallet_urls, .max_response_bytes = config.max_response_bytes }, .solidity = .{ .allocator = allocator, .transport = transport, .endpoints = config.wallet_solidity_urls, .max_response_bytes = config.max_response_bytes }, .jsonrpc = .{ .allocator = allocator, .transport = transport, .endpoints = config.rpc_urls, .max_response_bytes = config.max_response_bytes }, .signer_address = config.signer_address, .max_log_range = config.max_log_range };
    }

    pub fn finalizedBlock(self: *Provider) !Block {
        var response = try self.solidity.walletValidated("/getnowblock", struct {}{}, validateBlock);
        defer response.deinit();
        return Block.parse(response.value());
    }
    pub fn finalizedBlockNumber(self: *Provider) !u32 {
        const number = (try self.finalizedBlock()).number;
        return std.math.cast(u32, number) orelse error.TronBlockOverflow;
    }
    pub fn solidBlock(self: *Provider, number: u64) !Block {
        if (number > std.math.maxInt(i64)) return error.TronBlockOverflow;
        var response = try self.solidity.walletValidated("/getblockbynum", .{ .num = number }, validateBlock);
        defer response.deinit();
        const block = try Block.parse(response.value());
        if (block.number != number) return error.WrongTronBlock;
        return block;
    }
    pub fn trigger(self: Provider, owner: ?Address, contract: Address, data: []const u8, value: u256) !tx.Trigger {
        if (value > std.math.maxInt(i64)) return error.TronIntegerOverflow;
        var sender = owner orelse .{0} ** 20;
        if (std.mem.allEqual(u8, &sender, 0)) if (self.signer_address) |signer| {
            sender = signer;
        };
        return .{ .owner = wire.fromEthereumAddress(sender), .contract = wire.fromEthereumAddress(contract), .data = data, .call_value = @intCast(value) };
    }
    fn request(self: Provider, trigger_call: tx.Trigger) !TriggerRequest {
        if (trigger_call.owner[0] != 0x41 or trigger_call.contract[0] != 0x41 or trigger_call.call_value > std.math.maxInt(i64)) return error.InvalidTronTrigger;
        const owner = try unprefixedAlloc(self.allocator, &trigger_call.owner);
        errdefer self.allocator.free(owner);
        const contract = try unprefixedAlloc(self.allocator, &trigger_call.contract);
        errdefer self.allocator.free(contract);
        return .{ .owner_address = owner, .contract_address = contract, .data = try unprefixedAlloc(self.allocator, trigger_call.data), .call_value = trigger_call.call_value, .visible = false };
    }
    /// Latest solidified state only. Returned bytes may be revert payloads:
    /// Tron prioritizes constant_result even when result.code indicates failure.
    pub fn call(self: *Provider, trigger_call: tx.Trigger) ![]u8 {
        const req = try self.request(trigger_call);
        defer req.deinit(self.allocator);
        var response = try self.solidity.walletValidated("/triggerconstantcontract", req, validateConstant);
        defer response.deinit();
        if (response.value().object.get("constant_result")) |results| {
            if (results != .array) return error.InvalidTronResponse;
            if (results.array.items.len > 0) return decodeUnprefixed(self.allocator, try rpc.string(results.array.items[0]));
        }
        if (try apiCode(response.value())) |_| return error.TronContractCallFailed;
        return error.TronNoConstantResult;
    }
    /// Compatibility with shared EVM metadata primitives. Historical state is
    /// explicitly unsupported instead of attaching a fabricated block height.
    pub fn ethCall(self: *Provider, contract: Address, data: []const u8, block: evm.BlockRef) ![]u8 {
        switch (block) {
            .latest, .finalized => {},
            else => return error.TronHistoricalCallUnsupported,
        }
        return self.call(try self.trigger(null, contract, data, 0));
    }
    pub fn estimateEnergy(self: *Provider, trigger_call: tx.Trigger) !u64 {
        const req = try self.request(trigger_call);
        defer req.deinit(self.allocator);
        var response = try self.wallet.walletValidated("/estimateenergy", req, validateEnergy);
        defer response.deinit();
        if (try apiCode(response.value())) |_| return error.TronEnergyEstimationFailed;
        const energy = if (response.value().object.get("energy_required")) |value| try rpc.nonnegative(value) else 0;
        if (energy == 0) return error.TronEnergyEstimationFailed;
        return energy;
    }
    pub fn energyPrice(self: *Provider) !u256 {
        var response = try self.jsonrpc.call("eth_gasPrice", .{});
        defer response.deinit();
        return quantity256(try rpc.string(rpc.result(response)));
    }
    pub fn balance(self: *Provider, address: Address) !u256 {
        const text = try abi.hexAlloc(self.allocator, &address);
        defer self.allocator.free(text);
        var response = try self.jsonrpc.call("eth_getBalance", .{ text, "latest" });
        defer response.deinit();
        return quantity256(try rpc.string(rpc.result(response)));
    }
    pub fn isContract(self: *Provider, address: Address) !bool {
        const text = try abi.hexAlloc(self.allocator, &address);
        defer self.allocator.free(text);
        var response = try self.jsonrpc.call("eth_getCode", .{ text, "latest" });
        defer response.deinit();
        const result = try rpc.string(rpc.result(response));
        if (!std.mem.startsWith(u8, result, "0x")) return error.InvalidTronHex;
        const bytes = try decodeUnprefixed(self.allocator, result[2..]);
        defer self.allocator.free(bytes);
        return bytes.len > 0;
    }
    /// Performs reads only. Caller persists the resulting signing intent before
    /// invoking transaction.sign and persists signed bytes before broadcast.
    pub fn prepare(self: *Provider, trigger_call: tx.Trigger, energy_floor: u256, now_ms: u64, policy: tx.FeePolicy) !tx.Unsigned {
        return self.prepareEstimated(trigger_call, @max(energy_floor, try self.estimateEnergy(trigger_call)), now_ms, policy);
    }
    /// Reuse an energy estimate already obtained in the same owned preparation job.
    pub fn prepareEstimated(self: *Provider, trigger_call: tx.Trigger, energy: u256, now_ms: u64, policy: tx.FeePolicy) !tx.Unsigned {
        const fee = try policy.fee(energy, try self.energyPrice());
        const block = try self.finalizedBlock();
        return tx.build(self.allocator, trigger_call, try tx.reference(block.number, block.id, now_ms, fee));
    }
    /// No implicit transaction rebuild/re-sign: a timeout leaves an uncertain
    /// broadcast of these exact bytes and the caller reconciles this txid.
    pub fn broadcast(self: *Provider, signed: tx.Signed, now_ms: u64) !Broadcast {
        if (signed.expired(now_ms)) return error.TronTransactionExpired;
        try tx.validateSigned(signed);
        const hex = try unprefixedAlloc(self.allocator, signed.bytes);
        defer self.allocator.free(hex);
        var response = try self.wallet.walletValidated("/broadcasthex", .{ .transaction = hex }, validateBroadcast);
        defer response.deinit();
        const accepted = response.value().object.get("result") orelse .null;
        if (accepted != .null and accepted != .bool) return error.InvalidTronResponse;
        if (accepted == .bool and accepted.bool) return .{ .accepted = true, .classification = .unknown };
        const code = response.value().object.get("code") orelse return .{ .accepted = false, .classification = .unknown };
        return .{ .accepted = false, .classification = tx.classify(try rpc.string(code)) };
    }
    pub fn receipt(self: *Provider, id: Hash) !?Receipt {
        const hex = try abi.hexAlloc(self.allocator, &id);
        defer self.allocator.free(hex);
        var response = try self.jsonrpc.call("eth_getTransactionReceipt", .{hex});
        defer response.deinit();
        if (rpc.result(response) == .null) return null;
        return try Receipt.parse(rpc.result(response), id);
    }
    pub fn status(self: *Provider, signed: tx.Signed, now_ms: u64) !Status {
        const found = try self.receipt(signed.id) orelse return if (signed.expired(now_ms)) .expired else .pending;
        const number = found.block_number orelse return .pending;
        if ((try self.finalizedBlock()).number < number) return .included;
        // Height alone is insufficient when receipt/index nodes disagree.
        const canonical = try self.solidBlock(number);
        if (!std.mem.eql(u8, &canonical.id, &found.block_hash.?)) return error.NoncanonicalTronReceipt;
        return .finalized;
    }
    /// JSON-RPC logs are checked against walletsolidity's finalized height and
    /// canonical block IDs. Duplicates survive for the durable indexer to dedup.
    pub fn logs(self: *Provider, contract: Address, from: u64, to: u64, topic: Hash) !Logs {
        if (from > to or self.max_log_range == 0 or to - from >= self.max_log_range) return error.InvalidTronLogRange;
        if (to > (try self.finalizedBlock()).number) return error.TronRangeNotFinalized;
        const address = try abi.hexAlloc(self.allocator, &contract);
        defer self.allocator.free(address);
        const topic_hex = try abi.hexAlloc(self.allocator, &topic);
        defer self.allocator.free(topic_hex);
        const from_hex = try abi.quantityAlloc(self.allocator, from);
        defer self.allocator.free(from_hex);
        const to_hex = try abi.quantityAlloc(self.allocator, to);
        defer self.allocator.free(to_hex);
        var response = try self.jsonrpc.call("eth_getLogs", .{.{ .address = address, .fromBlock = from_hex, .toBlock = to_hex, .topics = .{topic_hex} }});
        defer response.deinit();
        const values = rpc.result(response);
        if (values != .array) return error.InvalidTronResponse;
        const items = try self.allocator.alloc(evm.Log, values.array.items.len);
        var initialized: usize = 0;
        errdefer {
            for (items[0..initialized]) |*log| log.deinit();
            self.allocator.free(items);
        }
        for (values.array.items, items) |value, *log| {
            log.* = try evm.Log.parse(self.allocator, value);
            initialized += 1;
            if (log.block_number < from or log.block_number > to or !std.mem.eql(u8, &log.address, &contract) or log.topic_count == 0 or !std.mem.eql(u8, &log.topics[0], &topic)) return error.TronLogOutsideFilter;
            _ = try log.event();
        }
        // Sort once so each canonical header is fetched once. Dispatch order is
        // subsequently sorted by nonce, matching the source mailbox indexer.
        std.mem.sort(evm.Log, items, {}, logLess);
        var current: ?Block = null;
        for (items) |log| {
            if (current == null or current.?.number != log.block_number) current = try self.solidBlock(log.block_number);
            if (!std.mem.eql(u8, &current.?.id, &log.block_hash)) return error.NoncanonicalTronLog;
        }
        if (std.mem.eql(u8, &topic, &abi.dispatch_topic)) std.mem.sort(evm.Log, items, {}, dispatchLess);
        return .{ .allocator = self.allocator, .items = items };
    }
};

const TriggerRequest = struct {
    owner_address: []u8,
    contract_address: []u8,
    data: []u8,
    call_value: u64,
    visible: bool,
    fn deinit(self: TriggerRequest, a: A) void {
        a.free(self.owner_address);
        a.free(self.contract_address);
        a.free(self.data);
    }
};
fn validateBlock(value: rpc.Value) !void {
    _ = try Block.parse(value);
}
fn validateError(value: rpc.Value) !void {
    const result = value.object.get("result") orelse return;
    if (result == .null) return;
    if (result != .object) return error.InvalidTronResponse;
    for ([_][]const u8{ "code", "message" }) |name| if (result.object.get(name)) |field| if (field != .null and field != .string) return error.InvalidTronResponse;
}
fn validateConstant(value: rpc.Value) !void {
    try validateError(value);
    const result = value.object.get("constant_result") orelse return;
    if (result != .array) return error.InvalidTronResponse;
    for (result.array.items) |field| if (field != .string) return error.InvalidTronResponse;
}
fn validateEnergy(value: rpc.Value) !void {
    try validateError(value);
    if (value.object.get("energy_required")) |field| if (field != .integer) return error.InvalidTronResponse;
}
fn validateBroadcast(value: rpc.Value) !void {
    if (value.object.get("result")) |field| if (field != .null and field != .bool) return error.InvalidTronResponse;
    for ([_][]const u8{ "code", "message" }) |name| if (value.object.get(name)) |field| if (field != .null and field != .string) return error.InvalidTronResponse;
}
fn apiCode(value: rpc.Value) !?[]const u8 {
    const result = value.object.get("result") orelse return null;
    if (result == .null) return null;
    if (result != .object) return error.InvalidTronResponse;
    const code = result.object.get("code") orelse return null;
    if (code == .null) return null;
    return try rpc.string(code);
}
pub fn quantity256(text: []const u8) !u256 {
    if (text.len < 3 or text.len > 66 or !std.mem.startsWith(u8, text, "0x") or (text.len > 3 and text[2] == '0')) return error.InvalidQuantity;
    for (text[2..]) |c| if (!std.ascii.isHex(c)) return error.InvalidQuantity;
    return std.fmt.parseInt(u256, text[2..], 16) catch error.InvalidQuantity;
}
pub fn unprefixedFixed(comptime N: usize, text: []const u8) ![N]u8 {
    if (text.len != N * 2) return error.InvalidTronHex;
    var out: [N]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, text) catch return error.InvalidTronHex;
    return out;
}
pub fn decodeUnprefixed(a: A, text: []const u8) ![]u8 {
    if (text.len % 2 != 0) return error.InvalidTronHex;
    const out = try a.alloc(u8, text.len / 2);
    errdefer a.free(out);
    _ = std.fmt.hexToBytes(out, text) catch return error.InvalidTronHex;
    return out;
}
pub fn unprefixedAlloc(a: A, data: []const u8) ![]u8 {
    const out = try a.alloc(u8, try std.math.mul(usize, data.len, 2));
    const digits = "0123456789abcdef";
    for (data, 0..) |byte, i| {
        out[i * 2] = digits[byte >> 4];
        out[i * 2 + 1] = digits[byte & 15];
    }
    return out;
}
fn logLess(_: void, x: evm.Log, y: evm.Log) bool {
    return if (x.block_number != y.block_number) x.block_number < y.block_number else if (x.transaction_index != y.transaction_index) x.transaction_index < y.transaction_index else x.log_index < y.log_index;
}
fn dispatchLess(_: void, x: evm.Log, y: evm.Log) bool {
    const left = (x.event() catch unreachable).dispatch.message;
    const right = (y.event() catch unreachable).dispatch.message;
    return std.mem.readInt(u32, left[1..5], .big) < std.mem.readInt(u32, right[1..5], .big);
}

test "Tron wallet solidity split preserves CCIP revert bytes, rejects failed energy and historical calls" {
    const mock = @import("../cloud/testing.zig");
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = "{\"constant_result\":[\"deadbeef\"],\"result\":{\"code\":\"CONTRACT_EXE_ERROR\"}}" },
        .{ .method = .POST, .suffix = "/wallet/estimateenergy", .response = "{\"energy_required\":123,\"result\":{\"code\":\"CONTRACT_EXE_ERROR\"}}" },
        .{ .method = .POST, .suffix = "/wallet/estimateenergy", .response = "{\"energy_required\":0}" },
        .{ .method = .POST, .suffix = "/wallet/estimateenergy", .response = "{\"energy_required\":456}" },
    } };
    var p = testingProvider(script.transport());
    const call = try p.trigger(null, .{0x22} ** 20, "fixture", 0);
    const data = try p.call(call);
    defer p.allocator.free(data);
    try std.testing.expectEqualSlices(u8, &.{ 0xde, 0xad, 0xbe, 0xef }, data);
    try std.testing.expectError(error.TronEnergyEstimationFailed, p.estimateEnergy(call));
    try std.testing.expectError(error.TronEnergyEstimationFailed, p.estimateEnergy(call));
    try std.testing.expectEqual(@as(u64, 456), try p.estimateEnergy(call));
    try std.testing.expectError(error.TronHistoricalCallUnsupported, p.ethCall(.{0} ** 20, "", .{ .number = 1 }));
    try script.expectDone();
}
pub fn testingProvider(transport: @import("../cloud/http.zig").Transport) Provider {
    return .{ .allocator = std.testing.allocator, .wallet = .{ .allocator = std.testing.allocator, .transport = transport, .endpoints = &.{.{ .url = "https://fixture/wallet" }} }, .solidity = .{ .allocator = std.testing.allocator, .transport = transport, .endpoints = &.{.{ .url = "https://fixture/walletsolidity" }} }, .jsonrpc = .{ .allocator = std.testing.allocator, .transport = transport, .endpoints = &.{.{ .url = "https://fixture/jsonrpc" }} } };
}
