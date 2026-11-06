//! Concrete scraper EVM source: one combined log query, exact emitter/topics,
//! strict canonical metadata, and historical nonce/count calls pinned by hash.
const std = @import("std");
const src = @import("source.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const protocol = @import("../../protocol/root.zig");
const json = @import("../../cosmos/types.zig");
pub const Evm = struct {
    rpc_client: *rpc.RpcClient,
    contracts: src.Contracts,
    domain: u32,
    max_events: usize = 100000,
    pub fn interface(self: *Evm) src.Source {
        return .{ .context = self, .transaction_fn = transactionEvents, .cancel_fn = bindCancellation, .header_fn = header, .events_fn = events, .counts_fn = counts, .historical_counts = true };
    }
    fn bindCancellation(context: *anyopaque, cancel: ?*const std.atomic.Value(bool)) void {
        cast(context).rpc_client.options.cancel = cancel;
    }
    fn cast(context: *anyopaque) *Evm {
        return @ptrCast(@alignCast(context));
    }
    fn address(hash: src.Hash) ![20]u8 {
        if (!std.mem.allEqual(u8, hash[0..12], 0)) return error.InvalidEvmAddress;
        return hash[12..32].*;
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const block: rpc.BlockRef = switch (selector) {
            .height => |height| .{ .number = height },
            .latest => .latest,
            .safe => .safe,
            .finalized => .finalized,
        };
        const value = try self.rpc_client.blockHeader(block);
        return .{ .height = value.number, .timestamp = value.timestamp, .hash = value.hash, .parent = value.parent_hash };
    }
    fn count(self: *Evm, contract: src.Hash, signature: []const u8, hash: src.Hash) !u32 {
        const allocator = self.rpc_client.allocator;
        const to = try abi.hexAlloc(allocator, &try address(contract));
        defer allocator.free(to);
        const calldata = try abi.hexAlloc(allocator, &abi.selector(signature));
        defer allocator.free(calldata);
        const tag_text = try abi.hexAlloc(allocator, &hash);
        defer allocator.free(tag_text);
        const tag = .{ .blockHash = tag_text };
        // Production ethers BlockId::Hash serializes as an EIP-1898 object.
        // Empty code before deployment proves the zero count.
        var response = try self.rpc_client.call("eth_call", .{ .{ .to = to, .data = calldata }, tag });
        defer response.deinit();
        const encoded = try rpc.string(response.value());
        if (std.mem.eql(u8, encoded, "0x")) {
            var code = try self.rpc_client.call("eth_getCode", .{ to, tag });
            defer code.deinit();
            if (std.mem.eql(u8, try rpc.string(code.value()), "0x")) return 0;
            return error.InvalidContractSequenceCount;
        }
        return abi.uintWord(u32, &try abi.fixedHex(32, encoded));
    }
    fn counts(context: *anyopaque, hash: src.Hash) !?[2]u32 {
        const self = cast(context);
        return .{ try self.count(self.contracts.mailbox, "nonce()", hash), try self.count(self.contracts.hook, "count()", hash) };
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        if (from > through or through - from >= self.rpc_client.options.max_log_range) return error.InvalidLogRange;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const contracts = [_]src.Hash{ self.contracts.mailbox, self.contracts.hook, self.contracts.paymaster };
        var addresses: [3][]const u8 = undefined;
        for (contracts, &addresses) |contract, *out| out.* = try abi.hexAlloc(a, &try address(contract));
        const hashes = [_]src.Hash{ abi.dispatch_topic, abi.process_id_topic, abi.insertion_topic, abi.gas_payment_topic };
        var topics: [4][]const u8 = undefined;
        for (hashes, &topics) |topic, *out| out.* = try abi.hexAlloc(a, &topic);
        var response = try self.rpc_client.call("eth_getLogs", .{.{ .fromBlock = try abi.quantityAlloc(a, from), .toBlock = try abi.quantityAlloc(a, through), .address = addresses, .topics = .{topics} }});
        defer response.deinit();
        if (response.value() != .array or response.value().array.items.len > self.max_events) return error.ScraperEventLimit;
        var result: std.ArrayList(src.Event) = .empty;
        for (response.value().array.items) |value| {
            var log = try parseLog(a, value);
            defer log.deinit();
            if (log.block_number < from or log.block_number > through or log.log_index > std.math.maxInt(i64)) return error.ScraperEventOutsideRange;
            if (try self.decode(log, a)) |event| try result.append(a, event);
        }
        std.mem.sort(src.Event, result.items, {}, less);
        var positions = std.AutoHashMap(struct { hash: src.Hash, tx: [64]u8 }, u64).init(a);
        for (result.items, 0..) |event, index| {
            if (index > 0 and samePosition(result.items[index - 1], event)) return error.ScraperDuplicateEventPosition;
            const entry = try positions.getOrPut(.{ .hash = event.block_hash, .tx = event.tx_hash.? });
            if (entry.found_existing and entry.value_ptr.* != event.tx_index) return error.ScraperInconsistentTransactionPosition;
            entry.value_ptr.* = event.tx_index;
        }
        const owned_events = try result.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned_events, .through = through };
    }
    fn transactionEvents(context: *anyopaque, allocator: std.mem.Allocator, transaction: [64]u8) !src.Batch {
        const self = cast(context);
        if (!std.mem.allEqual(u8, transaction[0..32], 0)) return error.InvalidEvmTransactionId;
        if (self.rpc_client.options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const hash = transaction[32..64].*;
        var response = try self.rpc_client.call("eth_getTransactionReceipt", .{try abi.hexAlloc(a, &hash)});
        defer response.deinit();
        const receipt = response.value();
        if (receipt == .null) return error.TransactionReceiptUnavailable;
        if (receipt != .object) return error.InvalidTransactionReceipt;
        if (try abi.quantity(try rpc.string(try json.field(receipt, "status"))) != 1) return error.FailedTransactionReceipt;
        const actual = try abi.fixedHex(32, try rpc.string(try json.field(receipt, "transactionHash")));
        if (!std.mem.eql(u8, &actual, &hash)) return error.TransactionReceiptIdentityMismatch;
        const height = try abi.quantity(try rpc.string(try json.field(receipt, "blockNumber")));
        const block_hash = try abi.fixedHex(32, try rpc.string(try json.field(receipt, "blockHash")));
        const tx_index = try abi.quantity(try rpc.string(try json.field(receipt, "transactionIndex")));
        const before = try self.rpc_client.blockHeader(.{ .number = height });
        if (!std.mem.eql(u8, &before.hash, &block_hash)) return error.NoncanonicalTransactionReceipt;
        const logs = try json.field(receipt, "logs");
        if (logs != .array or logs.array.items.len > self.max_events) return error.ScraperEventLimit;
        var result: std.ArrayList(src.Event) = .empty;
        var seen = std.AutoHashMap(u64, src.Hash).init(a);
        for (logs.array.items) |raw| {
            if (self.rpc_client.options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            var log = try parseLog(a, raw);
            defer log.deinit();
            if (!log.matchesHeader(before) or !std.mem.eql(u8, &log.transaction_hash, &hash) or log.transaction_index != tx_index) return error.TransactionReceiptLogIdentityMismatch;
            if (try self.decode(log, a)) |event| {
                const entry = try seen.getOrPut(event.log_index);
                const fingerprint = @import("generic.zig").fingerprint(event);
                if (entry.found_existing) {
                    if (!std.mem.eql(u8, entry.value_ptr, &fingerprint)) return error.ConflictingTransactionReceiptLog;
                    continue;
                }
                entry.value_ptr.* = fingerprint;
                try result.append(a, event);
            }
        }
        const after = try self.rpc_client.blockHeader(.{ .number = height });
        if (!std.mem.eql(u8, &before.hash, &after.hash)) return error.NoncanonicalTransactionReceipt;
        std.mem.sort(src.Event, result.items, {}, less);
        return .{ .arena = arena, .events = try result.toOwnedSlice(a), .through = height };
    }
    pub fn decode(self: *Evm, log: rpc.Log, allocator: std.mem.Allocator) !?src.Event {
        return decodeLog(self.contracts, self.domain, log, allocator);
    }
};
pub fn decodeLog(configured: src.Contracts, domain: u32, log: rpc.Log, allocator: std.mem.Allocator) !?src.Event {
    if (log.topic_count == 0) return null;
    const topic = log.topics[0];
    const mailbox = try Evm.address(configured.mailbox);
    const hook = try Evm.address(configured.hook);
    const paymaster = try Evm.address(configured.paymaster);
    const is_dispatch = std.mem.eql(u8, &log.address, &mailbox) and std.mem.eql(u8, &topic, &abi.dispatch_topic);
    const is_delivery = std.mem.eql(u8, &log.address, &mailbox) and std.mem.eql(u8, &topic, &abi.process_id_topic);
    const is_insert = std.mem.eql(u8, &log.address, &hook) and std.mem.eql(u8, &topic, &abi.insertion_topic);
    const is_gas = std.mem.eql(u8, &log.address, &paymaster) and std.mem.eql(u8, &topic, &abi.gas_payment_topic);
    if (!is_dispatch and !is_delivery and !is_insert and !is_gas) return null;
    const decoded = try log.event();
    const data: src.EventData = switch (decoded) {
        .dispatch => |dispatch| blk: {
            const message = try protocol.Message.decode(try allocator.dupe(u8, dispatch.message));
            if (message.origin != domain) return error.WrongMessageOrigin;
            break :blk .{ .dispatch = message };
        },
        .process_id => |id| .{ .delivery = id },
        .insertion => |insert| .{ .insertion = .{ .message_id = insert.message_id, .index = insert.index } },
        .gas_payment => |gas| .{ .gas = .{ .message_id = gas.message_id, .destination = gas.destination, .gas = gas.gas_amount, .payment = gas.payment } },
        else => return error.WrongScraperEvent,
    };
    var padded_address: src.Hash = .{0} ** 32;
    @memcpy(padded_address[12..], &log.address);
    var tx: [64]u8 = .{0} ** 64;
    @memcpy(tx[32..], &log.transaction_hash);
    return .{ .block_number = log.block_number, .block_hash = log.block_hash, .address = padded_address, .tx_hash = tx, .tx_index = log.transaction_index, .log_index = log.log_index, .data = data };
}

fn less(_: void, a: src.Event, b: src.Event) bool {
    if (a.block_number != b.block_number) return a.block_number < b.block_number;
    if (a.tx_index != b.tx_index) return a.tx_index < b.tx_index;
    return a.log_index < b.log_index;
}
fn samePosition(a: src.Event, b: src.Event) bool {
    return a.block_number == b.block_number and a.tx_index == b.tx_index and a.log_index == b.log_index;
}

/// Rust treats an absent removed flag as false, while still rejecting true.
/// Normalize only that protocol-defined optional field before strict decoding.
pub fn parseLog(allocator: std.mem.Allocator, value: std.json.Value) !rpc.Log {
    if (value != .object) return error.InvalidRpcResult;
    if (value.object.get("removed")) |removed| if (removed != .null) return rpc.Log.parse(allocator, value);
    var object = std.json.ObjectMap.init(allocator);
    defer object.deinit();
    var it = value.object.iterator();
    while (it.next()) |entry| try object.put(entry.key_ptr.*, entry.value_ptr.*);
    try object.put("removed", .{ .bool = false });
    return rpc.Log.parse(allocator, .{ .object = object });
}
