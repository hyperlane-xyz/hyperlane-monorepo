//! Concrete Starknet block source. Counters are pinned by canonical block hash;
//! event identity is checked against block transaction lists and receipts.
const std = @import("std");
const src = @import("source.zig");
const settings = @import("../../settings/types.zig");
const chain_provider = @import("../../starknet/provider.zig");
const codec = @import("../../starknet/codec.zig");
const chain_events = @import("../../starknet/events.zig");
const rpc = @import("../../net/json_rpc.zig");
const endpoint = @import("../../net/endpoint.zig");
const http = @import("../../cloud/http.zig");
pub const Starknet = struct {
    provider: *chain_provider.Provider,
    contracts: src.Contracts,
    domain: u32,
    reorg: chain_provider.ReorgPeriod,
    max_events: usize = 100000,
    max_message_bytes: usize = 1024 * 1024,
    max_batch_bytes: usize = 64 * 1024 * 1024,
    pub fn init(provider: *chain_provider.Provider, contracts: src.Contracts, domain: u32, reorg: chain_provider.ReorgPeriod) !Starknet {
        if (!std.mem.allEqual(u8, &contracts.paymaster, 0)) return error.UnsupportedStarknetIgp;
        if ((try codec.Felt.fromBytes(contracts.mailbox)).value == 0 or (try codec.Felt.fromBytes(contracts.hook)).value == 0) return error.InvalidStarknetContract;
        switch (reorg) {
            .tag => return error.UnsupportedStarknetReorgTag,
            else => {},
        }
        return .{ .provider = provider, .contracts = contracts, .domain = domain, .reorg = reorg };
    }
    pub fn fromChain(provider: *chain_provider.Provider, chain: *const settings.Chain) !Starknet {
        if (chain.protocol != .starknet) return error.WrongScraperProtocol;
        if (chain.index.mode != .block) return error.UnsupportedStarknetSequenceIndex;
        const reorg: chain_provider.ReorgPeriod = switch (chain.reorg) {
            .blocks => |depth| .{ .blocks = depth },
            .tag => return error.UnsupportedStarknetReorgTag,
        };
        return init(provider, .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster }, chain.domain, reorg);
    }
    pub fn interface(self: *Starknet) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .counts_fn = counts, .tip_fn = tip, .historical_counts = true };
    }
    fn cast(context: *anyopaque) *Starknet {
        return @ptrCast(@alignCast(context));
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const block: chain_provider.BlockId = switch (selector) {
            .height => |height| .{ .number = height },
            .latest => .latest,
            .safe, .finalized => return error.UnsupportedStarknetReorgTag,
        };
        const actual = try self.provider.header(block);
        return .{ .height = actual.number, .hash = actual.hash.toBytes(), .parent = actual.parent.toBytes(), .timestamp = actual.timestamp };
    }
    fn count(self: *Starknet, address: src.Hash, name: []const u8, hash: src.Hash) !u32 {
        const contract = try codec.Felt.fromBytes(address);
        const block = try codec.Felt.fromBytes(hash);
        var response = try self.provider.client.callEnvelope("starknet_call", .{ .request = .{ .contract_address = contract, .entry_point_selector = codec.selector(name), .calldata = [_]codec.Felt{} }, .block_id = chain_provider.BlockId{ .hash = block } });
        defer response.deinit();
        if (response.remoteError()) |err| {
            if (err.code == 20 and !try self.provider.isContract(contract, .{ .hash = block })) return 0;
            return error.StarknetRpcError;
        }
        const result = response.value();
        if (result != .array or result.array.items.len != 1) return error.InvalidStarknetSequenceCount;
        return (try chain_provider.felt(result.array.items[0])).integer(u32);
    }
    fn counts(context: *anyopaque, hash: src.Hash) !?[2]u32 {
        const self = cast(context);
        return .{ try self.count(self.contracts.mailbox, "nonce", hash), try self.count(self.contracts.hook, "count", hash) };
    }
    fn tip(context: *anyopaque) !?u64 {
        const self = cast(context);
        return try self.provider.height(self.reorg);
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        if (from > through) return error.InvalidScraperRange;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var result: std.ArrayList(src.Event) = .empty;
        var total: usize = 0;
        const addresses = [_]src.Hash{ self.contracts.mailbox, self.contracts.mailbox, self.contracts.hook };
        const topics = [_][]const u8{ "Dispatch", "ProcessId", "InsertedIntoTree" };
        for (addresses, topics, 0..) |address, name, index| {
            var logs = try chain_events.fetch(self.provider, try codec.Felt.fromBytes(address), codec.selector(name), from, through, self.reorg);
            defer logs.deinit();
            if (logs.items.len > self.max_events - result.items.len) return error.ScraperEventLimit;
            for (logs.items) |event| {
                const decoded = try chain_events.decode(a, event, self.max_message_bytes);
                const data: src.EventData = switch (index) {
                    0 => blk: {
                        if (decoded != .dispatch or decoded.dispatch.origin != self.domain) return error.WrongMessageOrigin;
                        break :blk .{ .dispatch = decoded.dispatch };
                    },
                    1 => blk: {
                        if (decoded != .process_id) return error.WrongScraperEvent;
                        break :blk .{ .delivery = decoded.process_id };
                    },
                    2 => blk: {
                        if (decoded != .insertion) return error.WrongScraperEvent;
                        break :blk .{ .insertion = .{ .message_id = decoded.insertion.id, .index = decoded.insertion.index } };
                    },
                    else => unreachable,
                };
                const bytes = try std.math.add(usize, @sizeOf(src.Event), if (data == .dispatch) data.dispatch.body.len else 0);
                if (bytes > self.max_batch_bytes -| total) return error.ScraperEventByteLimit;
                total += bytes;
                var hash: [64]u8 = .{0} ** 64;
                hash[32..].* = event.transaction_hash.toBytes();
                try result.append(a, .{ .block_number = event.block_number, .block_hash = event.block_hash.toBytes(), .address = address, .tx_hash = if (std.mem.allEqual(u8, &hash, 0)) null else hash, .tx_index = event.transaction_index, .log_index = event.log_index, .sequence = switch (data) {
                    .dispatch => |message| message.nonce,
                    .insertion => |insertion| insertion.index,
                    else => null,
                }, .data = data });
            }
        }
        std.mem.sort(src.Event, result.items, {}, less);
        for (result.items, 0..) |event, index| if (index > 0 and event.block_number == result.items[index - 1].block_number and event.tx_index == result.items[index - 1].tx_index and event.log_index == result.items[index - 1].log_index) return error.ScraperDuplicateEventPosition;
        const owned = try result.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned, .through = through };
    }
};
fn less(_: void, left: src.Event, right: src.Event) bool {
    return if (left.block_number != right.block_number) left.block_number < right.block_number else if (left.tx_index != right.tx_index) left.tx_index < right.tx_index else left.log_index < right.log_index;
}

/// Owns normalized endpoint strings/headers. Transport is borrowed. Create in its
/// final location before interface(); do not move while a Source/job borrows it.
pub const Factory = struct {
    arena: std.heap.ArenaAllocator,
    endpoints: []endpoint.OwnedEndpoint,
    provider: chain_provider.Provider,
    configuration: struct { contracts: src.Contracts, domain: u32, reorg: chain_provider.ReorgPeriod },
    source: ?Starknet = null,
    pub fn init(allocator: std.mem.Allocator, transport: http.Transport, chain: *const settings.Chain) !Factory {
        if (chain.protocol != .starknet) return error.WrongScraperProtocol;
        if (chain.index.chunk == 0) return error.InvalidScraperChunk;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const owned = try a.alloc(endpoint.OwnedEndpoint, chain.rpc_urls.len);
        var initialized: usize = 0;
        errdefer for (owned[0..initialized]) |*item| item.deinit();
        const endpoints = try a.alloc(rpc.Endpoint, owned.len);
        for (chain.rpc_urls, owned, endpoints) |url, *owner, *item| {
            owner.* = try endpoint.OwnedEndpoint.parse(allocator, url);
            initialized += 1;
            item.* = owner.endpoint;
        }
        var provider: chain_provider.Provider = .{ .allocator = allocator, .client = try rpc.Client.init(allocator, transport, endpoints, .{}), .max_event_range = chain.index.chunk };
        const source = try Starknet.fromChain(&provider, chain);
        return .{ .arena = arena, .endpoints = owned, .provider = provider, .configuration = .{ .contracts = source.contracts, .domain = source.domain, .reorg = source.reorg } };
    }
    pub fn interface(self: *Factory) !src.Source {
        if (self.source == null) self.source = try Starknet.init(&self.provider, self.configuration.contracts, self.configuration.domain, self.configuration.reorg);
        return self.source.?.interface();
    }
    pub fn deinit(self: *Factory) void {
        for (self.endpoints) |*item| item.deinit();
        self.arena.deinit();
        self.* = undefined;
    }
};

test {
    _ = @import("starknet_testing.zig");
}
