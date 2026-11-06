//! Radix state-version indexing via actual Core preview counts and bounded
//! Gateway transaction pagination. State-version block identities match Rust.
const std = @import("std");
const src = @import("source.zig");
const provider = @import("../../radix/provider.zig");
const address = @import("../../radix/address.zig");
const parser = @import("../../radix/events.zig");
const sbor = @import("../../radix/sbor.zig");
const json = @import("../../cosmos/types.zig");
const generic = @import("generic.zig");
const clock = @import("time.zig");
pub const Adapter = struct {
    client: provider.Client,
    contracts: src.Contracts,
    domain: u32,
    max_pages: usize = 1024,
    max_events: usize = 100000,
    tips: ?[4]src.Tip = null,
    pub fn fromChain(client: provider.Client, chain: *const @import("../../settings/types.zig").Chain) !Adapter {
        if (chain.protocol != .radix) return error.WrongScraperProtocol;
        if (chain.index.mode != .block) return error.UnsupportedScraperSequenceIndex;
        const configured: src.Contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster };
        if (chain.connection != .radix or !std.mem.eql(u8, chain.connection.radix.network_name, client.network.logical_name)) return error.WrongRadixNetwork;
        return .{ .client = client, .contracts = configured, .domain = chain.domain };
    }
    pub fn interface(self: *Adapter) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .transaction_fn = transactionEvents, .begin_fn = begin, .tip_counts_fn = tipCounts, .tip_fn = indexingTip, .stream_tip_fn = singleTip, .empty_anchor_fn = emptyAnchor };
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn begin(context: *anyopaque) !void {
        cast(context).tips = null;
    }
    fn heightHash(height: u64) src.Hash {
        var hash: src.Hash = .{0} ** 32;
        std.mem.writeInt(u64, hash[24..32], height, .big);
        return hash;
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const height = switch (selector) {
            .height => |height| height,
            .latest => try self.client.coreState(),
            .safe, .finalized => try self.client.finalizedState(),
        };
        var response = try self.client.call(self.client.gateway, "/stream/transactions", .{ .at_ledger_state = .{ .state_version = height }, .limit_per_page = 1 });
        defer response.deinit();
        const ledger = try json.field(response.value(), "ledger_state");
        if (!std.mem.eql(u8, try json.string(try json.field(ledger, "network")), self.client.network.logical_name)) return error.WrongRadixNetwork;
        if (try json.uint(try json.field(ledger, "state_version")) != height) return error.WrongRadixStateVersion;
        const items = try json.field(response.value(), "items");
        if (items != .array or items.array.items.len == 0) return error.MissingRadixStateTransaction;
        return .{ .height = height, .hash = heightHash(height), .timestamp = try clock.rfc3339(try json.string(try json.field(ledger, "proposer_round_timestamp"))) };
    }
    fn tipCounts(context: *anyopaque) !?[4]src.Tip {
        const self = cast(context);
        if (self.tips) |tips| return tips;
        const emitters = [_]src.Hash{ self.contracts.mailbox, self.contracts.mailbox, self.contracts.paymaster, self.contracts.hook };
        const methods = [_][]const u8{ "nonce", "processed", "sequence", "count" };
        var tips: [4]src.Tip = undefined;
        for (emitters, methods, &tips) |emitter, method, *tip| {
            var result = try self.client.callMethod(try address.node(emitter), method, &.{}, null);
            defer result.deinit();
            tip.* = .{ .count = try sbor.uint(try result.value(), u32), .tip = result.state_version };
        }
        self.tips = tips;
        return tips;
    }
    fn singleTip(context: *anyopaque, index: usize) !src.Tip {
        if (index >= 4) return error.InvalidScraperStream;
        const self = cast(context);
        const emitter = switch (index) {
            0, 1 => self.contracts.mailbox,
            2 => self.contracts.paymaster,
            3 => self.contracts.hook,
            else => unreachable,
        };
        const method = ([_][]const u8{ "nonce", "processed", "sequence", "count" })[index];
        var response = try self.client.callMethod(try address.node(emitter), method, &.{}, null);
        defer response.deinit();
        return .{ .count = try sbor.uint(try response.value(), u32), .tip = response.state_version };
    }
    fn indexingTip(context: *anyopaque) !?u64 {
        const tips = (try tipCounts(context)).?;
        var height: u64 = std.math.maxInt(u64);
        for (tips) |tip| height = @min(height, tip.tip);
        return height;
    }
    fn emptyAnchor(context: *anyopaque) !?src.Header {
        const tips = (try tipCounts(context)).?;
        for (tips) |tip| if (tip.count != 0) return null;
        return try header(context, .{ .height = (try indexingTip(context)).? }, false);
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        if (from > through) return error.InvalidRadixRange;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var output: std.ArrayList(src.Event) = .empty;
        var seen = std.AutoHashMap(src.Hash, void).init(a);
        const emitters = [_]src.Hash{ self.contracts.mailbox, self.contracts.hook, self.contracts.paymaster };
        for (emitters, 0..) |emitter, emitter_index| {
            if (for (emitters[0..emitter_index]) |previous| {
                if (std.mem.eql(u8, &previous, &emitter)) break true;
            } else false) continue;
            const component = try address.node(emitter);
            var text: [160]u8 = undefined;
            const encoded = try address.encode(self.client.network, "component", &component, &text);
            var cursors = std.StringHashMap(void).init(a);
            var cursor: ?[]const u8 = null;
            var pages: usize = 0;
            var last: ?u64 = null;
            while (true) {
                if (pages >= self.max_pages) return error.RadixPaginationLimit;
                pages += 1;
                var response = try self.client.streamPage(from, through, encoded, cursor);
                defer response.deinit();
                const items = try json.field(response.value(), "items");
                var beyond = false;
                for (items.array.items) |item| {
                    const height = try json.uint(try json.field(item, "state_version"));
                    if (last) |previous| if (height <= previous) return error.UnorderedRadixStream;
                    last = height;
                    if (height > through) {
                        beyond = true;
                        break;
                    }
                    try self.decodeTransaction(a, &output, &seen, item, emitter);
                }
                if (beyond) break;
                const next = response.value().object.get("next_cursor") orelse break;
                if (next == .null) break;
                const owned = try a.dupe(u8, try json.string(next));
                const entry = try cursors.getOrPut(owned);
                if (entry.found_existing) return error.RadixPaginationNoProgress;
                cursor = owned;
            }
        }
        std.mem.sort(src.Event, output.items, {}, struct {
            fn less(_: void, x: src.Event, y: src.Event) bool {
                if (x.block_number != y.block_number) return x.block_number < y.block_number;
                return x.log_index < y.log_index;
            }
        }.less);
        const owned = try output.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = through };
    }
    fn transactionEvents(context: *anyopaque, allocator: std.mem.Allocator, transaction: [64]u8) !src.Batch {
        const self = cast(context);
        if (!std.mem.allEqual(u8, transaction[0..32], 0) or std.mem.allEqual(u8, &transaction, 0)) return error.UnsupportedRadixTransactionId;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var response = try self.client.committed(transaction[32..64].*);
        defer response.deinit();
        const ledger = try json.field(response.value(), "ledger_state");
        const value = try json.field(response.value(), "transaction");
        const height = try json.uint(try json.field(value, "state_version"));
        if (try json.uint(try json.field(ledger, "state_version")) < height) return error.RadixGatewayBehind;
        const receipt = try json.field(value, "receipt");
        if (receipt != .object) return error.MissingRadixReceipt;
        const status = receipt.object.get("status") orelse return error.MissingRadixReceiptStatus;
        if (status == .null or !std.mem.eql(u8, try json.string(status), "CommittedSuccess")) return error.RadixTransactionFailed;
        _ = try json.field(receipt, "events");
        const canonical = try header(context, .{ .height = height }, false);
        if (!std.mem.eql(u8, &canonical.hash, &heightHash(height))) return error.NoncanonicalRadixTransaction;
        var output: std.ArrayList(src.Event) = .empty;
        var seen = std.AutoHashMap(src.Hash, void).init(a);
        const emitters = [_]src.Hash{ self.contracts.mailbox, self.contracts.hook, self.contracts.paymaster };
        for (emitters, 0..) |emitter, emitter_index| {
            if (for (emitters[0..emitter_index]) |previous| {
                if (std.mem.eql(u8, &previous, &emitter)) break true;
            } else false) continue;
            try self.decodeTransaction(a, &output, &seen, value, emitter);
        }
        for (output.items) |*event| {
            if (event.tx_hash == null or !std.mem.eql(u8, &event.tx_hash.?, &transaction)) return error.WrongRadixIntentHash;
        }
        const after = try header(context, .{ .height = height }, false);
        if (!std.mem.eql(u8, &after.hash, &canonical.hash)) return error.NoncanonicalRadixTransaction;
        std.mem.sort(src.Event, output.items, {}, struct {
            fn less(_: void, left: src.Event, right: src.Event) bool {
                return left.log_index < right.log_index;
            }
        }.less);
        const owned = try output.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = height };
    }
    pub fn decodeTransaction(self: *Adapter, a: std.mem.Allocator, output: *std.ArrayList(src.Event), seen: *std.AutoHashMap(src.Hash, void), value: std.json.Value, emitter: src.Hash) !void {
        const height = try json.uint(try json.field(value, "state_version"));
        const receipt = try json.field(value, "receipt");
        if (receipt != .object) return error.MissingRadixReceipt;
        const status = receipt.object.get("status") orelse return;
        if (status == .null or !std.mem.eql(u8, try json.string(status), "CommittedSuccess")) return;
        var hash: [32]u8 = undefined;
        const decoded = try address.decode(self.client.network, "txid", try json.string(try json.field(value, "intent_hash")), &hash);
        if (decoded.len != 32) return error.InvalidRadixIntentHash;
        var transaction: [64]u8 = .{0} ** 64;
        @memcpy(transaction[32..], &hash);
        const logs = try json.field(receipt, "events");
        if (logs != .array) return error.InvalidRadixEvents;
        for (logs.array.items, 0..) |raw, index| {
            var parsed = (try parser.parse(a, self.client.network, try address.node(emitter), raw)) orelse continue;
            defer parsed.deinit();
            var sequence: ?u32 = null;
            const data: src.EventData = switch (parsed.event) {
                .dispatch => |message| blk: {
                    if (message.origin != self.domain or !std.mem.eql(u8, &emitter, &self.contracts.mailbox)) return error.WrongMessageOrigin;
                    var owned = message;
                    owned.body = try a.dupe(u8, message.body);
                    sequence = message.nonce;
                    break :blk .{ .dispatch = owned };
                },
                .delivery => |delivery| blk: {
                    if (!std.mem.eql(u8, &emitter, &self.contracts.mailbox)) return error.WrongScraperEmitter;
                    sequence = delivery.sequence;
                    break :blk .{ .delivery = delivery.id };
                },
                .insertion => |insert| blk: {
                    if (!std.mem.eql(u8, &emitter, &self.contracts.hook)) return error.WrongScraperEmitter;
                    sequence = insert.index;
                    break :blk .{ .insertion = .{ .message_id = insert.id, .index = insert.index } };
                },
                .gas_payment => |gas| blk: {
                    if (!std.mem.eql(u8, &emitter, &self.contracts.paymaster)) return error.WrongScraperEmitter;
                    sequence = gas.sequence;
                    break :blk .{ .gas = .{ .message_id = gas.id, .destination = gas.destination, .gas = gas.gas_amount, .payment = gas.payment } };
                },
            };
            const event: src.Event = .{ .block_number = height, .block_hash = heightHash(height), .address = emitter, .tx_hash = if (std.mem.allEqual(u8, &transaction, 0)) null else transaction, .tx_index = height, .log_index = index, .sequence = sequence, .data = data };
            const entry = try seen.getOrPut(generic.fingerprint(event));
            if (entry.found_existing) continue;
            if (output.items.len >= self.max_events) return error.ScraperEventLimit;
            try output.append(a, event);
        }
    }
};
test "scraper Radix concrete source binds actual Core and Gateway callbacks" {
    var adapter: Adapter = .{ .client = undefined, .contracts = undefined, .domain = 1 };
    _ = adapter.interface();
}
