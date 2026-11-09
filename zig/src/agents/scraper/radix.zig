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
            .latest => (try self.client.gatewayState()).state_version,
            .safe, .finalized => @min(try self.client.finalizedState(), (try self.client.gatewayState()).state_version),
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
        // Core counters retain their actual snapshot; Gateway owns availability
        // of the transaction history needed to prove this indexing boundary.
        return @min(height, (try cast(context).client.gatewayState()).state_version);
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

const LagFixture = struct {
    core: u64 = 20535,
    gateway: u64 = 20464,
    count: u32 = 0,
    last_selector: ?u64 = null,
    counter_reads: usize = 0,
    stream_reads: usize = 0,
    fn transport(self: *LagFixture) @import("../../cloud/http.zig").Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(context: *anyopaque, allocator: std.mem.Allocator, request: @import("../../cloud/http.zig").Request) !@import("../../cloud/http.zig").Response {
        const self: *LagFixture = @ptrCast(@alignCast(context));
        var status: u16 = 200;
        const wire = if (std.mem.endsWith(u8, request.url, "/status/network-status"))
            try std.fmt.allocPrint(allocator, "{{\"current_state_identifier\":{{\"state_version\":{d}}}}}", .{self.core})
        else if (std.mem.endsWith(u8, request.url, "/status/gateway-status"))
            try std.fmt.allocPrint(allocator, "{{\"ledger_state\":{{\"network\":\"mainnet\",\"state_version\":{d},\"epoch\":1}}}}", .{self.gateway})
        else if (std.mem.endsWith(u8, request.url, "/transaction/call-preview")) blk: {
            self.counter_reads += 1;
            var body = try std.json.parseFromSlice(std.json.Value, allocator, request.body.?, .{});
            defer body.deinit();
            // Existing Core count reads stay at their truthful current snapshot.
            try std.testing.expect(body.value.object.get("at_ledger_state") == null);
            var encoded: [6]u8 = .{ 0x5c, 9, 0, 0, 0, 0 };
            std.mem.writeInt(u32, encoded[2..6], self.count, .little);
            var hex: [12]u8 = undefined;
            hex = std.fmt.bytesToHex(encoded, .lower);
            break :blk try std.fmt.allocPrint(allocator, "{{\"status\":\"Succeeded\",\"at_ledger_state\":{{\"state_version\":{d}}},\"output\":{{\"hex\":\"{s}\"}}}}", .{ self.core, hex });
        } else if (std.mem.endsWith(u8, request.url, "/stream/transactions")) blk: {
            self.stream_reads += 1;
            var body = try std.json.parseFromSlice(std.json.Value, allocator, request.body.?, .{});
            defer body.deinit();
            const height = try json.uint(try json.field(try json.field(body.value, "at_ledger_state"), "state_version"));
            self.last_selector = height;
            try std.testing.expectEqual(@as(u64, 1), try json.uint(try json.field(body.value, "limit_per_page")));
            if (height > self.gateway) {
                status = 400;
                break :blk try allocator.dupe(u8, "{\"type\":\"InvalidRequestError\"}");
            }
            break :blk try std.fmt.allocPrint(allocator, "{{\"ledger_state\":{{\"network\":\"mainnet\",\"state_version\":{d},\"epoch\":1,\"proposer_round_timestamp\":\"2026-11-09T00:00:00Z\"}},\"items\":[{{\"state_version\":{d}}}]}}", .{ height, height });
        } else return error.UnexpectedRadixLagFixtureRoute;
        return .{ .allocator = allocator, .bytes = wire, .status = status };
    }
    fn adapter(self: *LagFixture, confirmations: u32) Adapter {
        return .{ .client = .{ .allocator = std.testing.allocator, .transport = self.transport(), .core = .{ .url = "http://core.invalid" }, .gateway = .{ .url = "http://gateway.invalid" }, .network = .mainnet, .confirmations = confirmations }, .contracts = .{ .mailbox = .{0} ** 32, .hook = .{0} ** 32, .paymaster = .{0} ** 32 }, .domain = 1 };
    }
};
test "scraper Radix Gateway watermark bounds latest and finalized headers while explicit heights remain exact" {
    var fixture: LagFixture = .{};
    var adapter = fixture.adapter(10);
    const source = adapter.interface();
    try std.testing.expectEqual(fixture.gateway, (try source.header(.latest)).height);
    try std.testing.expectEqual(fixture.gateway, (try source.header(.safe)).height);
    try std.testing.expectEqual(fixture.gateway, (try source.header(.finalized)).height);
    fixture.gateway = 20534;
    try std.testing.expectEqual(@as(u64, 20525), (try source.header(.safe)).height);
    try std.testing.expectEqual(@as(u64, 20400), (try source.header(.{ .height = 20400 })).height);
    try std.testing.expectError(error.RadixHttpStatus, source.header(.{ .height = 20535 }));
    try std.testing.expectEqual(@as(?u64, 20535), fixture.last_selector);
}
test "scraper Radix lagging Gateway bounds zero cutover and indexing without relabeling Core counter snapshots" {
    var fixture: LagFixture = .{};
    var adapter = fixture.adapter(0);
    const source = adapter.interface();
    const tips = (try source.tipCounts()).?;
    for (tips) |tip| {
        try std.testing.expectEqual(@as(?u32, 0), tip.count);
        try std.testing.expectEqual(fixture.core, tip.tip);
    }
    try std.testing.expectEqual(@as(usize, 4), fixture.counter_reads);
    try std.testing.expectEqual(@as(?u64, fixture.gateway), try source.indexingTip());
    try std.testing.expectEqual(fixture.gateway, (try source.emptyAnchor()).?.height);
    try std.testing.expectEqual(@as(?u64, fixture.gateway), fixture.last_selector);
    fixture.gateway = fixture.core + 10;
    try std.testing.expectEqual(@as(?u64, fixture.core), try source.indexingTip());
    fixture.count = 1;
    try source.beginCycle();
    try std.testing.expect((try source.emptyAnchor()) == null);
    // Single-stream consumers retain the actual Core count and its real version.
    const single = try source.streamTip(3);
    try std.testing.expectEqual(@as(?u32, 1), single.count);
    try std.testing.expectEqual(fixture.core, single.tip);
}
