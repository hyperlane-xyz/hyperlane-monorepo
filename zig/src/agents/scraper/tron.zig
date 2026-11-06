//! Actual Tron solidified block/log indexing. Counts are latest-only; read each
//! count before its reported solidified tip, never claim historical call support.
const std = @import("std");
const src = @import("source.zig");
const native = @import("../../tron/provider.zig");
const contracts = @import("../../tron/contracts.zig");
const abi = @import("../../evm/codecs.zig");
const decoder = @import("evm.zig");
const generic = @import("generic.zig");
pub const Adapter = struct {
    provider: *native.Provider,
    contracts: src.Contracts,
    domain: u32,
    max_events: usize = 100000,
    tips: ?[4]src.Tip = null,
    pub fn fromChain(client: *native.Provider, chain: *const @import("../../settings/types.zig").Chain) !Adapter {
        if (chain.protocol != .tron) return error.WrongScraperProtocol;
        if (chain.index.mode != .block) return error.UnsupportedScraperSequenceIndex;
        const configured: src.Contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster };
        return .{ .provider = client, .contracts = configured, .domain = chain.domain };
    }
    pub fn interface(self: *Adapter) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .transaction_fn = transactionEvents, .begin_fn = begin, .tip_counts_fn = tipCounts, .tip_fn = indexingTip, .stream_tip_fn = singleTip };
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn address(value: src.Hash) ![20]u8 {
        if (!std.mem.allEqual(u8, value[0..12], 0)) return error.InvalidTronContractAddress;
        return value[12..].*;
    }
    fn begin(context: *anyopaque) !void {
        cast(context).tips = null;
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const value = switch (selector) {
            .height => |height| try self.provider.solidBlock(height),
            else => try self.provider.finalizedBlock(),
        };
        return .{ .height = value.number, .hash = value.id, .timestamp = value.timestamp_ms / 1000 };
    }
    fn tipCounts(context: *anyopaque) !?[4]src.Tip {
        const self = cast(context);
        if (self.tips) |tips| return tips;
        const contract: contracts.Contracts = .{ .provider = self.provider, .mailbox = try address(self.contracts.mailbox), .hook = try address(self.contracts.hook), .domain = self.domain };
        const dispatch = try contract.countAndTip(false);
        const insertion = try contract.countAndTip(true);
        const latest = try self.provider.finalizedBlockNumber();
        const tips: [4]src.Tip = .{ .{ .count = dispatch.count, .tip = dispatch.tip }, .{ .count = null, .tip = latest }, .{ .count = null, .tip = latest }, .{ .count = insertion.count, .tip = insertion.tip } };
        self.tips = tips;
        return tips;
    }
    fn singleTip(context: *anyopaque, index: usize) !src.Tip {
        const self = cast(context);
        if (index == 1 or index == 2) return .{ .count = null, .tip = try self.provider.finalizedBlockNumber() };
        if (index != 0 and index != 3) return error.InvalidScraperStream;
        const contract: contracts.Contracts = .{ .provider = self.provider, .mailbox = try address(self.contracts.mailbox), .hook = try address(self.contracts.hook), .domain = self.domain };
        const value = try contract.countAndTip(index == 3);
        return .{ .count = value.count, .tip = value.tip };
    }
    fn indexingTip(context: *anyopaque) !?u64 {
        const tips = (try tipCounts(context)).?;
        var tip: u64 = std.math.maxInt(u64);
        for (tips) |value| tip = @min(tip, value.tip);
        return tip;
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var values: std.ArrayList(src.Event) = .empty;
        const emitters = [_]src.Hash{ self.contracts.mailbox, self.contracts.mailbox, self.contracts.paymaster, self.contracts.hook };
        const topics = [_]src.Hash{ abi.dispatch_topic, abi.process_id_topic, abi.gas_payment_topic, abi.insertion_topic };
        var seen = std.AutoHashMap(src.Hash, void).init(a);
        for (emitters, topics) |emitter, topic| {
            var logs = try self.provider.logs(try address(emitter), from, through, topic);
            defer logs.deinit();
            for (logs.items) |log| if (try decoder.decodeLog(self.contracts, self.domain, log, a)) |decoded| {
                var event = decoded;
                if (event.tx_hash) |hash| if (std.mem.allEqual(u8, &hash, 0)) {
                    event.tx_hash = null;
                };
                const entry = try seen.getOrPut(generic.fingerprint(event));
                if (entry.found_existing) continue;
                if (values.items.len >= self.max_events) return error.ScraperEventLimit;
                try values.append(a, event);
            };
        }
        std.mem.sort(src.Event, values.items, {}, struct {
            fn less(_: void, x: src.Event, y: src.Event) bool {
                if (x.block_number != y.block_number) return x.block_number < y.block_number;
                if (x.tx_index != y.tx_index) return x.tx_index < y.tx_index;
                return x.log_index < y.log_index;
            }
        }.less);
        const owned = try values.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = through };
    }
    fn transactionEvents(context: *anyopaque, allocator: std.mem.Allocator, transaction: [64]u8) !src.Batch {
        const self = cast(context);
        if (!std.mem.allEqual(u8, transaction[0..32], 0) or std.mem.allEqual(u8, &transaction, 0)) return error.UnsupportedTronTransactionId;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const hash = transaction[32..64].*;
        const hex = try abi.hexAlloc(a, &hash);
        var response = try self.provider.jsonrpc.call("eth_getTransactionReceipt", .{hex});
        defer response.deinit();
        const value = @import("../../tron/rpc.zig").result(response);
        if (value == .null) return error.MissingTronReceipt;
        const receipt = try native.Receipt.parse(value, hash);
        if (receipt.success == null or !receipt.success.?) return error.TronTransactionFailed;
        const height = receipt.block_number orelse return error.MissingTronReceiptBlock;
        const block_hash = receipt.block_hash orelse return error.MissingTronReceiptBlock;
        const tx_index = try abi.quantity(try @import("../../tron/rpc.zig").string(try @import("../../tron/rpc.zig").field(value, "transactionIndex")));
        const logs = try @import("../../tron/rpc.zig").field(value, "logs");
        if (logs != .array) return error.InvalidTronReceiptLogs;
        const canonical = try self.provider.solidBlock(height);
        if (!std.mem.eql(u8, &canonical.id, &block_hash)) return error.NoncanonicalTronReceipt;
        var output: std.ArrayList(src.Event) = .empty;
        var positions = std.AutoHashMap(u64, void).init(a);
        for (logs.array.items) |raw| {
            var log = try decoder.parseLog(a, raw);
            defer log.deinit();
            if (!std.mem.eql(u8, &log.transaction_hash, &hash) or log.block_number != height or !std.mem.eql(u8, &log.block_hash, &block_hash) or log.transaction_index != tx_index) return error.InconsistentTronReceiptLog;
            const position = try positions.getOrPut(log.log_index);
            if (position.found_existing) return error.DuplicateTronReceiptLogIndex;
            if (try decoder.decodeLog(self.contracts, self.domain, log, a)) |decoded| {
                var event = decoded;
                event.tx_hash = transaction;
                if (output.items.len >= self.max_events) return error.ScraperEventLimit;
                try output.append(a, event);
            }
        }
        const after = try self.provider.solidBlock(height);
        if (!std.mem.eql(u8, &after.id, &canonical.id)) return error.NoncanonicalTronReceipt;
        std.mem.sort(src.Event, output.items, {}, struct {
            fn less(_: void, left: src.Event, right: src.Event) bool {
                return left.log_index < right.log_index;
            }
        }.less);
        const owned = try output.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = height };
    }
};
test "scraper Tron concrete source binds real provider callbacks" {
    var adapter: Adapter = .{ .provider = undefined, .contracts = undefined, .domain = 1 };
    _ = adapter.interface();
}
