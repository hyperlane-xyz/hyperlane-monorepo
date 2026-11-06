//! Same-chain CCR: match each ReceivedTransferRemote to its last preceding
//! collateral transfer, enrich every selected transaction, then persist pairs
//! and advance a separate cursor bounded by both finality and scraper frontier.
const std = @import("std");
const src = @import("source.zig");
const enrich = @import("enrichment.zig");
const evm = @import("evm.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
pub const Router = struct { address: [20]u8, token: [20]u8 };
pub const Candidate = struct { meta: enrich.Meta, log_index: u64, tx_index: u64, destination_router: src.Hash, recipient: src.Hash, amount: u256 };
pub const Swap = struct { meta: enrich.Meta, log_index: u64, domain: u32, source_router: src.Hash, destination_router: src.Hash, recipient: src.Hash, amount: u256 };
pub const Plan = struct {
    arena: std.heap.ArenaAllocator,
    candidates: []const Candidate,
    requests: []const enrich.Meta,
    pub fn deinit(self: *Plan) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Receipt = struct {
    arena: std.heap.ArenaAllocator,
    meta: enrich.Meta,
    logs: []const rpc.Log,
    pub fn deinit(self: *Receipt) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const received_topic = abi.topic("ReceivedTransferRemote(uint32,bytes32,uint256)");
pub const transfer_topic = abi.topic("Transfer(address,address,uint256)");
fn padded(value: [20]u8) src.Hash {
    var out: src.Hash = .{0} ** 32;
    @memcpy(out[12..], &value);
    return out;
}
pub fn syntheticId(tx: [64]u8, log_index: u64) !src.Hash {
    if (!std.mem.allEqual(u8, tx[0..32], 0)) return error.UnsupportedCcrTransactionHash;
    var payload: [52]u8 = undefined;
    @memcpy(payload[0..12], "SameChainCCR");
    @memcpy(payload[12..44], tx[32..64]);
    std.mem.writeInt(u64, payload[44..52], log_index, .big);
    var digest: src.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(&payload, &digest, .{});
    var out: src.Hash = .{0} ** 32;
    @memcpy(out[4..], digest[0..28]);
    return out;
}
pub fn findSource(routers: []const Router, destination: src.Hash, log_index: u64, logs: []const rpc.Log) ?src.Hash {
    var best: ?struct { router: src.Hash, index: u64 } = null;
    for (logs) |log| {
        if (log.log_index >= log_index or log.topic_count < 3 or !std.mem.eql(u8, &log.topics[0], &transfer_topic) or std.mem.eql(u8, &log.topics[2], &destination)) continue;
        for (routers) |router| {
            const target = padded(router.address);
            if (std.mem.eql(u8, &target, &log.topics[2]) and std.mem.eql(u8, &router.token, &log.address)) {
                if (best == null or log.log_index > best.?.index) best = .{ .router = target, .index = log.log_index };
                break;
            }
        }
    }
    return if (best) |found| found.router else null;
}
pub fn assemble(domain: u32, routers: []const Router, candidate: Candidate, receipt: Receipt) !?Swap {
    if (!std.mem.eql(u8, &candidate.meta.tx_hash, &receipt.meta.tx_hash) or !std.mem.eql(u8, &candidate.meta.block_hash, &receipt.meta.block_hash) or candidate.meta.block_number != receipt.meta.block_number) return error.CcrReceiptIdentityMismatch;
    const source = findSource(routers, candidate.destination_router, candidate.log_index, receipt.logs) orelse return null;
    return .{ .meta = candidate.meta, .log_index = candidate.log_index, .domain = domain, .source_router = source, .destination_router = candidate.destination_router, .recipient = candidate.recipient, .amount = candidate.amount };
}
pub const Evm = struct {
    rpc_client: *rpc.RpcClient,
    domain: u32,
    routers: []const Router,
    max_candidates: usize = 100000,
    fn validate(self: Evm) !void {
        if (self.routers.len == 0 or self.routers.len > 256) return error.InvalidCcrRouters;
        for (self.routers, 0..) |router, index| for (self.routers[0..index]) |previous| if (std.mem.eql(u8, &router.address, &previous.address)) return error.DuplicateCcrRouter;
    }
    pub fn plan(self: *Evm, allocator: std.mem.Allocator, from: u64, through: u64) !Plan {
        try self.validate();
        if (from > through or through - from >= self.rpc_client.options.max_log_range) return error.InvalidCcrRange;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const addresses = try a.alloc([]const u8, self.routers.len);
        for (self.routers, addresses) |router, *out| out.* = try abi.hexAlloc(a, &router.address);
        const topic = try abi.hexAlloc(a, &received_topic);
        var response = try self.rpc_client.call("eth_getLogs", .{.{ .address = addresses, .topics = .{topic}, .fromBlock = try abi.quantityAlloc(a, from), .toBlock = try abi.quantityAlloc(a, through) }});
        defer response.deinit();
        if (response.value() != .array or response.value().array.items.len > self.max_candidates) return error.CcrEventLimit;
        var candidates: std.ArrayList(Candidate) = .empty;
        var requests: std.ArrayList(enrich.Meta) = .empty;
        var unique = std.AutoHashMap([64]u8, src.Hash).init(a);
        for (response.value().array.items) |raw| {
            var log = try evm.parseLog(a, raw);
            defer log.deinit();
            if (log.block_number < from or log.block_number > through) return error.CcrEventOutsideRange;
            const matched = for (self.routers) |router| {
                if (std.mem.eql(u8, &router.address, &log.address)) break true;
            } else false;
            if (!matched or log.topic_count < 3 or !std.mem.eql(u8, &log.topics[0], &received_topic)) return error.CcrEventOutsideFilter;
            if (log.data.len < 32) return error.InvalidCcrEvent;
            if (try abi.uintWord(u32, &log.topics[1]) != self.domain) continue;
            var tx: [64]u8 = .{0} ** 64;
            @memcpy(tx[32..], &log.transaction_hash);
            const meta: enrich.Meta = .{ .block_number = log.block_number, .block_hash = log.block_hash, .tx_hash = tx };
            const entry = try unique.getOrPut(tx);
            if (entry.found_existing) {
                if (!std.mem.eql(u8, entry.value_ptr, &meta.block_hash)) return error.CcrReceiptIdentityMismatch;
            } else {
                entry.value_ptr.* = meta.block_hash;
                try requests.append(a, meta);
            }
            try candidates.append(a, .{ .meta = meta, .log_index = log.log_index, .tx_index = log.transaction_index, .destination_router = padded(log.address), .recipient = log.topics[2], .amount = try abi.uintWord(u256, log.data[0..32]) });
        }
        std.mem.sort(Candidate, candidates.items, {}, struct {
            fn less(_: void, x: Candidate, y: Candidate) bool {
                if (x.meta.block_number != y.meta.block_number) return x.meta.block_number < y.meta.block_number;
                if (x.tx_index != y.tx_index) return x.tx_index < y.tx_index;
                return x.log_index < y.log_index;
            }
        }.less);
        for (candidates.items, 0..) |candidate, index| if (index > 0 and candidate.meta.block_number == candidates.items[index - 1].meta.block_number and candidate.tx_index == candidates.items[index - 1].tx_index and candidate.log_index == candidates.items[index - 1].log_index) return error.DuplicateCcrEvent;
        const owned_candidates = try candidates.toOwnedSlice(a);
        const owned_requests = try requests.toOwnedSlice(a);
        return .{ .arena = arena, .candidates = owned_candidates, .requests = owned_requests };
    }
    /// One independent receipt job; owner may run up to the source's 20 jobs
    /// concurrently with distinct serial RpcClients and native deadlines.
    pub fn receipt(self: *Evm, allocator: std.mem.Allocator, meta: enrich.Meta) !Receipt {
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedCcrTransactionHash;
        const text = try abi.hexAlloc(allocator, meta.tx_hash[32..64]);
        defer allocator.free(text);
        var response = try self.rpc_client.call("eth_getTransactionReceipt", .{text});
        defer response.deinit();
        if (response.value() == .null) return error.CcrReceiptUnavailable;
        const value = response.value();
        if (value != .object) return error.InvalidCcrReceipt;
        const returned = try abi.fixedHex(32, try rpc.string(value.object.get("transactionHash") orelse return error.InvalidCcrReceipt));
        const block = try abi.fixedHex(32, try rpc.string(value.object.get("blockHash") orelse return error.InvalidCcrReceipt));
        const height = try abi.quantity(try rpc.string(value.object.get("blockNumber") orelse return error.InvalidCcrReceipt));
        if (!std.mem.eql(u8, &returned, meta.tx_hash[32..64]) or !std.mem.eql(u8, &block, &meta.block_hash) or height != meta.block_number) return error.CcrReceiptIdentityMismatch;
        const raw_logs = value.object.get("logs") orelse return error.InvalidCcrReceipt;
        if (raw_logs != .array or raw_logs.array.items.len > self.max_candidates) return error.CcrEventLimit;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const logs = try a.alloc(rpc.Log, raw_logs.array.items.len);
        for (raw_logs.array.items, logs) |raw, *out| {
            out.* = try evm.parseLog(a, raw);
            if (!std.mem.eql(u8, &out.transaction_hash, &returned) or !std.mem.eql(u8, &out.block_hash, &block) or out.block_number != height) return error.CcrReceiptIdentityMismatch;
        }
        return .{ .arena = arena, .meta = meta, .logs = logs };
    }
};
pub const Range = struct { from: u64, through: u64 };
pub const Lane = struct {
    from: u64,
    chunk: u64,
    pub fn next(self: Lane, confirmed: u64, finalized: u64) !?Range {
        if (self.chunk == 0) return error.InvalidCcrChunk;
        const tip = @min(confirmed, finalized);
        return if (self.from > tip) null else .{ .from = self.from, .through = @min(tip, self.from +| self.chunk -| 1) };
    }
    pub fn commit(self: *Lane, store: anytype, range: Range, swaps: []const Swap) !u64 {
        if (range.from != self.from or range.through < range.from) return error.StaleCcrRange;
        for (swaps) |swap| if (swap.meta.block_number < range.from or swap.meta.block_number > range.through) return error.CcrEventOutsideRange;
        const count = try store.storeCcr(swaps);
        try store.saveCcrCursor(range.through);
        self.from = try std.math.add(u64, range.through, 1);
        return count;
    }
};

test "scraper CCR synthetic ID matches shared TypeScript production fixture" {
    var tx: [64]u8 = .{0} ** 64;
    _ = try std.fmt.hexToBytes(tx[32..64], "abcdef1234567890abcdef1234567890" ++ "abcdef1234567890abcdef1234567890");
    var expected: src.Hash = undefined;
    _ = try std.fmt.hexToBytes(&expected, "000000001620870f00662d2235b9ddf0" ++ "2edd63c54ae359b191e04ffacff719e6");
    try std.testing.expectEqual(expected, try syntheticId(tx, 7));
}
