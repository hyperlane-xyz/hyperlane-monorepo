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
        return .{ .context = self, .transaction_fn = transactionEvents, .cancel_fn = bindCancellation, .header_fn = header, .headers_fn = headers, .events_fn = events, .counts_fn = counts, .historical_counts = true };
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
    /// Independent historical headers overlapped on the endpoint pool.
    fn headers(context: *anyopaque, heights: []const u64, out: []src.Header) !void {
        const self = cast(context);
        if (heights.len != out.len or heights.len > 16) return error.InvalidScraperHeaderBatch;
        var params: [16][48]u8 = undefined;
        var calls: [16]rpc.RawCall = undefined;
        for (heights, 0..) |height, i| calls[i] = .{ .method = "eth_getBlockByNumber", .params_json = try std.fmt.bufPrint(&params[i], "[\"0x{x}\",false]", .{height}) };
        var responses: [16]rpc.RpcResponse = undefined;
        try self.rpc_client.callMany(calls[0..heights.len], responses[0..heights.len]);
        defer for (responses[0..heights.len]) |*response| response.deinit();
        for (heights, responses[0..heights.len], out) |height, response, *header_| {
            const value = try rpc.BlockHeader.parse(response.value());
            if (value.number != height) return error.WrongBlock;
            header_.* = .{ .height = value.number, .timestamp = value.timestamp, .hash = value.hash, .parent = value.parent_hash };
        }
    }
    /// Mailbox nonce() and hook count() pinned to one block hash, the two
    /// eth_calls overlapped. Production ethers BlockId::Hash serializes as an
    /// EIP-1898 object. Empty code before deployment proves the zero count.
    fn counts(context: *anyopaque, hash: src.Hash) !?[2]u32 {
        const self = cast(context);
        var arena = std.heap.ArenaAllocator.init(self.rpc_client.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const tag = .{ .blockHash = try abi.hexAlloc(a, &hash) };
        const targets = [2]struct { contract: src.Hash, signature: []const u8 }{ .{ .contract = self.contracts.mailbox, .signature = "nonce()" }, .{ .contract = self.contracts.hook, .signature = "count()" } };
        var to: [2][]const u8 = undefined;
        var calls: [2]rpc.RawCall = undefined;
        for (targets, &to, &calls) |target, *address_, *call_| {
            address_.* = try abi.hexAlloc(a, &try address(target.contract));
            call_.* = .{ .method = "eth_call", .params_json = try std.json.Stringify.valueAlloc(a, .{ .{ .to = address_.*, .data = try abi.hexAlloc(a, &abi.selector(target.signature)) }, tag }, .{}) };
        }
        var responses: [2]rpc.RpcResponse = undefined;
        try self.rpc_client.callMany(&calls, &responses);
        defer for (&responses) |*response| response.deinit();
        var result: [2]u32 = undefined;
        for (responses, to, &result) |response, address_, *value| {
            const encoded = try rpc.string(response.value());
            if (std.mem.eql(u8, encoded, "0x")) {
                var code = try self.rpc_client.call("eth_getCode", .{ address_, tag });
                defer code.deinit();
                if (!std.mem.eql(u8, try rpc.string(code.value()), "0x")) return error.InvalidContractSequenceCount;
                value.* = 0;
            } else value.* = try abi.uintWord(u32, &try abi.fixedHex(32, encoded));
        }
        return result;
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
        // Equal positions are rejected below, so stability is irrelevant;
        // pdq keeps the frame small (block sort caches 512 Events on stack).
        std.mem.sortUnstable(src.Event, result.items, {}, less);
        try checkPositions(a, result.items);
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
        // One canonical read after the receipt binds its block; the logs are
        // then checked locally against it (a second read of the same height
        // with no network step in between proved nothing more). Rust reads
        // only the receipt.
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
        // One transaction's logs with distinct log indices: keys are unique.
        std.mem.sortUnstable(src.Event, result.items, {}, less);
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
/// Sorted events: no two share a position, and every event of one
/// (block hash, transaction hash) carries the same transaction index. Orders
/// 4-byte event indices by transaction and compares neighbours instead of a
/// 104-byte-per-entry hash map.
fn checkPositions(a: std.mem.Allocator, events: []const src.Event) !void {
    if (events.len < 2) return;
    for (events[1..], events[0 .. events.len - 1]) |event, previous| {
        if (samePosition(previous, event)) return error.ScraperDuplicateEventPosition;
    }
    const order = try a.alloc(u32, events.len);
    defer a.free(order);
    for (order, 0..) |*slot, index| slot.* = std.math.cast(u32, index) orelse return error.ScraperEventLimit;
    std.mem.sortUnstable(u32, order, events, transactionLess);
    for (order[1..], order[0 .. order.len - 1]) |index, previous| {
        const x = events[previous];
        const y = events[index];
        if (std.mem.eql(u8, &x.block_hash, &y.block_hash) and std.mem.eql(u8, &x.tx_hash.?, &y.tx_hash.?) and x.tx_index != y.tx_index) return error.ScraperInconsistentTransactionPosition;
    }
}
fn transactionLess(events: []const src.Event, x: u32, y: u32) bool {
    const a = events[x];
    const b = events[y];
    return switch (std.mem.order(u8, &a.block_hash, &b.block_hash)) {
        .lt => true,
        .gt => false,
        .eq => std.mem.order(u8, &a.tx_hash.?, &b.tx_hash.?) == .lt,
    };
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

const OverlapFixture = struct {
    overlapped: usize = 0,
    serial: usize = 0,
    wrong_height: bool = false,
    fn reply(self: *OverlapFixture, a: std.mem.Allocator, body: []const u8) !rpc.WireResponse {
        const request = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer request.deinit();
        const id = request.value.object.get("id").?.integer;
        try std.testing.expectEqualStrings("eth_getBlockByNumber", request.value.object.get("method").?.string);
        var height = try abi.quantity(request.value.object.get("params").?.array.items[0].string);
        if (self.wrong_height) height += 1;
        const bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{{\"number\":\"0x{x}\",\"hash\":\"0x{x:0>64}\",\"parentHash\":\"0x{x:0>64}\",\"timestamp\":\"0x{x}\"}}}}", .{ id, height, height + 0x100, height + 0xff, height + 7 });
        return .{ .bytes = bytes, .len = bytes.len };
    }
    fn one(context: *anyopaque, a: std.mem.Allocator, body: []const u8, _: rpc.Options) !rpc.WireResponse {
        const self: *OverlapFixture = @ptrCast(@alignCast(context));
        self.serial += 1;
        return self.reply(a, body);
    }
    fn many(context: *anyopaque, a: std.mem.Allocator, bodies: []const []const u8, _: rpc.Options, out: []rpc.WireResponse) !void {
        const self: *OverlapFixture = @ptrCast(@alignCast(context));
        self.overlapped += 1;
        var filled: usize = 0;
        errdefer for (out[0..filled]) |wire| a.free(wire.bytes);
        for (bodies, out) |body, *wire| {
            wire.* = try self.reply(a, body);
            filled += 1;
        }
    }
};
test "scraper EVM event-block headers overlap through one exchange batch and keep height checks" {
    var fixture: OverlapFixture = .{};
    var client = try rpc.RpcClient.init(std.testing.allocator, "http://127.0.0.1:1/", .{ .exchange = .{ .context = &fixture, .fetch_fn = OverlapFixture.one, .fetch_many_fn = OverlapFixture.many } });
    defer client.deinit();
    var source: Evm = .{ .rpc_client = &client, .domain = 1, .contracts = .{ .mailbox = .{0} ** 12 ++ .{0x11} ** 20, .hook = .{0} ** 12 ++ .{0x22} ** 20, .paymaster = .{0} ** 12 ++ .{0x33} ** 20 } };
    const interface = source.interface();
    const heights = [_]u64{ 5, 9, 12, 40 };
    var headers_out: [4]src.Header = undefined;
    try interface.headers(&heights, &headers_out);
    try std.testing.expectEqual(@as(usize, 1), fixture.overlapped);
    try std.testing.expectEqual(@as(usize, 0), fixture.serial);
    for (heights, headers_out) |height, header_| {
        try std.testing.expectEqual(height, header_.height);
        try std.testing.expectEqual(height + 7, header_.timestamp);
        try std.testing.expectEqual(@as(u8, @truncate(height + 0x100)), header_.hash[31]);
    }
    // A single height still uses the ordinary read.
    try interface.headers(heights[0..1], headers_out[0..1]);
    try std.testing.expectEqual(@as(usize, 1), fixture.serial);
    fixture.wrong_height = true;
    try std.testing.expectError(error.WrongBlock, interface.headers(&heights, &headers_out));
}

test "EVM event positions reject duplicates and one transaction at two indices" {
    const a = std.testing.allocator;
    const event = struct {
        fn make(block: u8, tx: u8, tx_index: u64, log_index: u64) src.Event {
            var tx_hash: [64]u8 = @splat(0);
            tx_hash[63] = tx;
            return .{ .block_number = block, .block_hash = @splat(block), .address = @splat(0), .tx_hash = tx_hash, .tx_index = tx_index, .log_index = log_index, .data = .{ .delivery = @splat(0) } };
        }
    }.make;
    try checkPositions(a, &.{});
    try checkPositions(a, &.{ event(1, 1, 0, 0), event(1, 1, 0, 1), event(1, 2, 1, 2), event(2, 1, 0, 0) });
    try std.testing.expectError(error.ScraperDuplicateEventPosition, checkPositions(a, &.{ event(1, 1, 0, 0), event(1, 1, 0, 0) }));
    try std.testing.expectError(error.ScraperInconsistentTransactionPosition, checkPositions(a, &.{ event(1, 1, 0, 0), event(1, 2, 1, 1), event(1, 1, 2, 2) }));
}
