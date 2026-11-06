//! Concrete Cosmos/CosmosNative block+ABCI indexing. Each block's transaction
//! hashes/results are paired exactly; failed txs are omitted, block-level events
//! retain the source's zero transaction identity. No REST gateway dependency.
const std = @import("std");
const src = @import("source.zig");
const tm = @import("../../cosmos/tendermint.zig");
const contracts = @import("../../cosmos/contracts.zig");
const parser = @import("../../cosmos/events.zig");
const json = @import("../../cosmos/types.zig");
const clock = @import("time.zig");
pub const Adapter = struct {
    tendermint: tm.Client,
    queries: contracts.Client,
    contracts: src.Contracts,
    native: bool,
    max_events: usize = 100000,
    max_range: u64 = 2000,
    tips: ?[4]src.Tip = null,
    pub fn fromChain(tendermint: tm.Client, queries: contracts.Client, chain: *const @import("../../settings/types.zig").Chain) !Adapter {
        if (chain.protocol != .cosmos and chain.protocol != .cosmosnative) return error.WrongScraperProtocol;
        if (chain.index.mode != .block) return error.UnsupportedScraperSequenceIndex;
        if (queries.domain != chain.domain or !std.mem.eql(u8, tendermint.chain_id, queries.config.chain_id) or !std.mem.eql(u8, chain.chain_id, queries.config.chain_id)) return error.WrongCosmosChainId;
        return .{ .tendermint = tendermint, .queries = queries, .contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster }, .native = chain.protocol == .cosmosnative, .max_range = @as(u64, chain.index.chunk) + 1 };
    }
    pub fn interface(self: *Adapter) src.Source {
        return .{ .context = self, .cancel_fn = bindCancellation, .header_fn = header, .events_fn = events, .transaction_fn = transactionEvents, .begin_fn = begin, .tip_counts_fn = tipCounts, .tip_fn = indexingTip, .stream_tip_fn = singleTip };
    }
    fn bindCancellation(context: *anyopaque, cancel: ?*const std.atomic.Value(bool)) void {
        const self = cast(context);
        self.tendermint.rpc_client.options.cancel = cancel;
        self.queries.cancel = cancel;
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn begin(context: *anyopaque) !void {
        cast(context).tips = null;
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const height = switch (selector) {
            .height => |height| height,
            .latest => (try self.tendermint.status()).height,
            .safe, .finalized => (try self.tendermint.status()).height -| self.queries.config.confirmations,
        };
        var response = try self.tendermint.block(height);
        defer response.deinit();
        return decodeHeader(response.value());
    }
    pub fn decodeHeader(value: std.json.Value) !src.Header {
        const h = try json.field(try json.field(value, "block"), "header");
        const parent = try json.string(try json.field(try json.field(h, "last_block_id"), "hash"));
        return .{ .height = try json.uint(try json.field(h, "height")), .hash = try json.hash(try json.string(try json.field(try json.field(value, "block_id"), "hash"))), .parent = if (parent.len == 0) .{0} ** 32 else try json.hash(parent), .timestamp = try clock.rfc3339(try json.string(try json.field(h, "time"))) };
    }
    fn tipCounts(context: *anyopaque) !?[4]src.Tip {
        const self = cast(context);
        if (self.tips) |tips| return tips;
        const height = (try self.tendermint.status()).height;
        var dispatch: u32 = undefined;
        var insertion: u32 = undefined;
        if (self.native) {
            var mailbox = try self.queries.nativeMailbox(self.contracts.mailbox, height);
            defer mailbox.deinit();
            dispatch = mailbox.value.message_sent;
            insertion = std.math.cast(u32, (try self.queries.nativeTree(self.contracts.hook, self.contracts.mailbox, height)).count) orelse return error.CosmosCountOverflow;
        } else {
            dispatch = try self.queries.wasmNonce(self.contracts.mailbox, height);
            var response = try self.queries.smartQuery(self.contracts.hook, .{ .merkle_hook = .{ .count = struct {}{} } }, height);
            defer response.deinit();
            insertion = std.math.cast(u32, try json.uint(try json.field(response.parsed.value, "count"))) orelse return error.CosmosCountOverflow;
        }
        const tips: [4]src.Tip = .{ .{ .count = dispatch, .tip = height }, .{ .count = null, .tip = height }, .{ .count = null, .tip = height }, .{ .count = insertion, .tip = height } };
        self.tips = tips;
        return tips;
    }
    fn singleTip(context: *anyopaque, index: usize) !src.Tip {
        const self = cast(context);
        const height = (try self.tendermint.status()).height;
        const count: ?u32 = switch (index) {
            0 => blk: {
                if (self.native) {
                    var response = try self.queries.nativeMailbox(self.contracts.mailbox, height);
                    defer response.deinit();
                    break :blk response.value.message_sent;
                }
                break :blk try self.queries.wasmNonce(self.contracts.mailbox, height);
            },
            3 => blk: {
                if (self.native) break :blk (try self.queries.nativeTree(self.contracts.hook, self.contracts.mailbox, height)).count;
                var response = try self.queries.smartQuery(self.contracts.hook, .{ .merkle_hook = .{ .count = struct {}{} } }, height);
                defer response.deinit();
                break :blk std.math.cast(u32, try json.uint(try json.field(response.parsed.value, "count"))) orelse return error.CosmosCountOverflow;
            },
            1, 2 => null,
            else => return error.InvalidScraperStream,
        };
        return .{ .tip = height, .count = count };
    }
    fn indexingTip(context: *anyopaque) !?u64 {
        return ((try tipCounts(context)).?)[0].tip;
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        if (from == 0 or from > through or through - from >= self.max_range) return error.InvalidCosmosScraperRange;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var output: std.ArrayList(src.Event) = .empty;
        var height = from;
        while (true) {
            var block = try self.tendermint.block(height);
            defer block.deinit();
            var results = try self.tendermint.blockResults(height);
            defer results.deinit();
            try self.decodeBlock(a, &output, block.value(), results.value());
            if (height == through) break;
            height += 1;
        }
        const owned = try output.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = through };
    }
    fn transactionEvents(context: *anyopaque, allocator: std.mem.Allocator, transaction: [64]u8) !src.Batch {
        const self = cast(context);
        if (!std.mem.allEqual(u8, transaction[0..32], 0) or std.mem.allEqual(u8, &transaction, 0)) return error.UnsupportedCosmosTransactionId;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var response = try self.tendermint.tx(transaction[32..64].*, false);
        defer response.deinit();
        const height = try json.uint(try json.field(response.value(), "height"));
        const receipt = try json.field(response.value(), "tx_result");
        if (try json.uint(try json.field(receipt, "code")) != 0) return error.CosmosTransactionFailed;
        const tx_index = std.math.cast(usize, try json.uint(try json.field(response.value(), "index"))) orelse return error.CosmosTransactionIndexOverflow;
        var block = try self.tendermint.block(height);
        defer block.deinit();
        const canonical = try decodeHeader(block.value());
        if (canonical.height != height) return error.WrongCosmosBlockHeight;
        const transactions = try arrayOrNull(try json.field(try json.field(try json.field(block.value(), "block"), "data"), "txs"));
        if (tx_index >= transactions.len) return error.CosmosTransactionIndexOutOfRange;
        const encoded = try json.string(transactions[tx_index]);
        const raw = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(encoded));
        try std.base64.standard.Decoder.decode(raw, encoded);
        var member: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(raw, &member, .{});
        if (!std.mem.eql(u8, &member, transaction[32..64])) return error.CosmosTransactionIndexMismatch;
        var output: std.ArrayList(src.Event) = .empty;
        var log_index: u64 = 0;
        try self.appendEvents(a, &output, canonical, transaction, tx_index, try arrayOrNull(try json.field(receipt, "events")), &log_index);
        for (output.items) |*event| event.sequence = switch (event.data) {
            .dispatch => |message| message.nonce,
            .insertion => |insert| insert.index,
            else => null,
        };
        var after = try self.tendermint.block(height);
        defer after.deinit();
        if (!std.mem.eql(u8, &(try decodeHeader(after.value())).hash, &canonical.hash)) return error.NoncanonicalCosmosTransaction;
        const owned = try output.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = height };
    }
    /// Public for source-backed malformed-block and full loopback fixtures.
    pub fn decodeBlock(self: *Adapter, a: std.mem.Allocator, output: *std.ArrayList(src.Event), block: std.json.Value, results: std.json.Value) !void {
        const h = try decodeHeader(block);
        if (h.height != try json.uint(try json.field(results, "height"))) return error.WrongCosmosBlockHeight;
        const data = try json.field(try json.field(block, "block"), "data");
        const txs = try arrayOrNull(try json.field(data, "txs"));
        const receipts = try arrayOrNull(try json.field(results, "txs_results"));
        if (txs.len != receipts.len) return error.CosmosTransactionResultCountMismatch;
        for (txs, receipts, 0..) |tx, receipt, index| {
            if (try json.uint(try json.field(receipt, "code")) != 0) continue;
            const text = try json.string(tx);
            const raw = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(text));
            try std.base64.standard.Decoder.decode(raw, text);
            var hash: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(raw, &hash, .{});
            var txhash: [64]u8 = .{0} ** 64;
            @memcpy(txhash[32..], &hash);
            var log_index: u64 = 0;
            try self.appendEvents(a, output, h, txhash, index, try arrayOrNull(try json.field(receipt, "events")), &log_index);
        }
        var log_index: u64 = 0;
        for ([_][]const u8{ "finalize_block_events", "begin_block_events", "end_block_events" }) |name| {
            if (results.object.get(name)) |list| try self.appendEvents(a, output, h, .{0} ** 64, 0, try arrayOrNull(list), &log_index);
        }
    }
    fn appendEvents(self: *Adapter, a: std.mem.Allocator, output: *std.ArrayList(src.Event), h: src.Header, tx: [64]u8, tx_index: usize, values: []const std.json.Value, log_index: *u64) !void {
        for (values) |value| {
            const index = log_index.*;
            log_index.* = try std.math.add(u64, index, 1);
            const kind = try json.string(try json.field(value, "type"));
            const is_native = std.mem.startsWith(u8, kind, "hyperlane.");
            if (is_native != self.native) continue;
            const expected = if (std.mem.eql(u8, kind, "wasm-mailbox_dispatch") or std.mem.eql(u8, kind, "wasm-mailbox_process_id") or std.mem.eql(u8, kind, "hyperlane.core.v1.EventDispatch") or std.mem.eql(u8, kind, "hyperlane.core.v1.EventProcess")) self.contracts.mailbox else if (std.mem.eql(u8, kind, "wasm-hpl_hook_merkle::post_dispatch") or std.mem.eql(u8, kind, "hyperlane.core.post_dispatch.v1.EventInsertedIntoTree")) self.contracts.hook else if (std.mem.eql(u8, kind, "wasm-igp-core-pay-for-gas") or std.mem.eql(u8, kind, "hyperlane.core.post_dispatch.v1.EventGasPayment")) self.contracts.paymaster else continue;
            var parsed = (try parser.parse(a, value, .{ .compat = self.tendermint.compat, .bech32_prefix = self.queries.config.bech32_prefix, .native_denom = self.queries.config.canonical_asset, .expected_contract = expected, .origin_domain = self.queries.domain })) orelse continue;
            defer parsed.deinit();
            const data_: src.EventData = switch (parsed.event) {
                .dispatch => |message| blk: {
                    var owned = message;
                    owned.body = try a.dupe(u8, message.body);
                    break :blk .{ .dispatch = owned };
                },
                .delivery => |id| .{ .delivery = id },
                .insertion => |insert| .{ .insertion = .{ .message_id = insert.message_id, .index = insert.index } },
                .gas_payment => |gas| .{ .gas = .{ .message_id = gas.message_id, .destination = gas.destination, .gas = gas.gas_amount, .payment = gas.payment } },
            };
            if (output.items.len >= self.max_events) return error.ScraperEventLimit;
            try output.append(a, .{ .block_number = h.height, .block_hash = h.hash, .address = parsed.contract, .tx_hash = if (std.mem.allEqual(u8, &tx, 0)) null else tx, .tx_index = tx_index, .log_index = index, .data = data_ });
        }
    }
};
fn arrayOrNull(value: std.json.Value) ![]const std.json.Value {
    return switch (value) {
        .array => value.array.items,
        .null => &.{},
        else => error.InvalidCosmosJson,
    };
}
test "scraper Cosmos concrete source binds real Tendermint and gRPC callbacks" {
    var adapter: Adapter = .{ .tendermint = undefined, .queries = undefined, .contracts = undefined, .native = false };
    _ = adapter.interface();
}

test "scraper Cosmos block events retain absent transaction metadata while transaction events keep SHA256 identity" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const memory = arena.allocator();
    var sdk = try @import("../../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../../cosmos/fixtures/sdk.json.gz"), .{});
    defer sdk.deinit();
    const Attr = struct { key: []const u8, value: []const u8 };
    const delivery = .{ .type = "wasm-mailbox_process_id", .attributes = [_]Attr{ .{ .key = "_contract_address", .value = sdk.value.object.get("address").?.string }, .{ .key = "message_id", .value = "22" ** 32 } } };
    const block_text = try std.json.Stringify.valueAlloc(memory, .{ .block_id = .{ .hash = "01" ** 32 }, .block = .{ .header = .{ .height = "5", .last_block_id = .{ .hash = "02" ** 32 }, .time = "2026-01-01T00:00:00Z" }, .data = .{ .txs = [_][]const u8{"AQ=="} } } }, .{});
    const result_text = try std.json.Stringify.valueAlloc(memory, .{ .height = "5", .txs_results = .{.{ .code = @as(u32, 0), .events = .{delivery} }}, .finalize_block_events = .{delivery} }, .{});
    var block = try std.json.parseFromSlice(std.json.Value, memory, block_text, .{});
    defer block.deinit();
    var results = try std.json.parseFromSlice(std.json.Value, memory, result_text, .{});
    defer results.deinit();
    var adapter: Adapter = .{ .tendermint = .{ .rpc_client = undefined, .chain_id = "fixture-1", .compat = .v038 }, .native = false, .contracts = .{ .mailbox = @splat(0x11), .hook = @splat(0x22), .paymaster = @splat(0x33) }, .queries = .{ .allocator = a, .transport = undefined, .domain = 1000, .config = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = .{ .numerator = 1, .denominator = 1 }, .gas_multiplier = 2, .confirmations = 0 } } };
    var output: std.ArrayList(src.Event) = .empty;
    try adapter.decodeBlock(memory, &output, block.value, results.value);
    try std.testing.expectEqual(@as(usize, 2), output.items.len);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(&.{1}, &digest, .{});
    try std.testing.expectEqualSlices(u8, &digest, output.items[0].tx_hash.?[32..]);
    try std.testing.expect(output.items[1].tx_hash == null);
}
