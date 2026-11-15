//! Indexer canonical-membership reads over real sockets: which header reads
//! the leading fence, its parent hash and the quorum root bound make redundant.
const std = @import("std");
const http = @import("../../ops/http.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const indexing = @import("../../evm/indexer.zig");
const a = std.testing.allocator;

fn hashFor(number: u64) [32]u8 {
    var out: [32]u8 = @splat(0);
    std.mem.writeInt(u64, out[24..32], number +% 0x1000, .big);
    return out;
}
const Fixture = struct {
    /// Log at this block claims a hash that is not the canonical header hash.
    orphan_block: ?u64 = null,
    header_reads: [16]std.atomic.Value(usize) = @splat(.init(0)),
    fn handle(context: *anyopaque, alloc: std.mem.Allocator, request: http.Request, _: *const std.atomic.Value(bool)) !http.Response {
        const self: *Fixture = @ptrCast(@alignCast(context));
        const parsed = try std.json.parseFromSlice(std.json.Value, alloc, request.body, .{});
        defer parsed.deinit();
        const raw = parsed.value.object;
        const method = raw.get("method").?.string;
        const id = raw.get("id").?;
        var arena = std.heap.ArenaAllocator.init(alloc);
        defer arena.deinit();
        const t = arena.allocator();
        var bytes: []u8 = undefined;
        if (std.mem.eql(u8, method, "eth_getBlockByNumber")) {
            const number = try abi.quantity(raw.get("params").?.array.items[0].string);
            _ = self.header_reads[number].fetchAdd(1, .monotonic);
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = .{ .number = try abi.quantityAlloc(t, number), .hash = try abi.hexAlloc(t, &hashFor(number)), .parentHash = try abi.hexAlloc(t, &hashFor(number - 1)), .timestamp = "0x1" } }, .{});
        } else if (std.mem.eql(u8, method, "eth_getLogs")) {
            const Log = struct { address: []const u8, topics: []const []const u8, data: []const u8, blockNumber: []const u8, blockHash: []const u8, transactionHash: []const u8, transactionIndex: []const u8, logIndex: []const u8, removed: bool };
            var logs: [3]Log = undefined;
            for (&logs, [_]u64{ 3, 6, 9 }, 0..) |*log, block, index| {
                var data: [64]u8 = @splat(0);
                data[0] = @intCast(index + 1);
                data[63] = @intCast(index);
                var claimed = hashFor(block);
                if (self.orphan_block == block) claimed[0] = 0xee;
                log.* = .{ .address = try abi.hexAlloc(t, &@as([20]u8, @splat(2))), .topics = &.{try abi.hexAlloc(t, &abi.insertion_topic)}, .data = try abi.hexAlloc(t, &data), .blockNumber = try abi.quantityAlloc(t, block), .blockHash = try abi.hexAlloc(t, &claimed), .transactionHash = try abi.hexAlloc(t, &@as([32]u8, @splat(@intCast(index + 1)))), .transactionIndex = "0x0", .logIndex = "0x0", .removed = false };
            }
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = &logs }, .{});
        } else return error.UnexpectedFixtureMethod;
        defer alloc.free(bytes);
        return http.Response.init(alloc, 200, &.{.{ .name = "Content-Type", .value = "application/json" }}, bytes);
    }
    fn reads(self: *Fixture, number: usize) usize {
        return self.header_reads[number].load(.acquire);
    }
    fn reset(self: *Fixture) void {
        for (&self.header_reads) |*value| value.store(0, .release);
    }
};

fn library() ![]u8 {
    return std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => a.dupe(u8, if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4"),
        else => err,
    };
}

test "membership reads: fence parent proves the previous block and quorum root bound skips only covered headers" {
    var fixture: Fixture = .{};
    const server = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("127.0.0.1", 0) }, .{ .context = &fixture, .handle_fn = Fixture.handle });
    defer server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{server.address().getPort()});
    defer a.free(url);
    const path = try library();
    defer a.free(path);
    var transport = try @import("../../net/curl.zig").Client.init(a, path);
    defer transport.deinit();
    var client = try rpc.RpcClient.init(a, url, .{ .native_transport = &transport, .timeout_ms = 3000, .connect_timeout_ms = 1000 });
    defer client.deinit();
    var indexer = try indexing.Indexer.init(a, &client, .{ .chain_id = 1, .domain = 1, .mailbox = @splat(1), .hook = @splat(2), .paymaster = @splat(3), .reorg_period = .none });
    indexer.chain_checked = true;
    const range: @import("../../runtime/sequence_cursor.zig").Range = .{ .from = 0, .to = 10 };

    // Full membership: leading + trailing fence at 10; 9 via the fence's parent.
    var full = try indexer.fetch(.insertion, range, 10);
    defer full.deinit();
    try std.testing.expectEqual(@as(usize, 2), fixture.reads(10));
    try std.testing.expectEqual(@as(usize, 1), fixture.reads(3));
    try std.testing.expectEqual(@as(usize, 1), fixture.reads(6));
    try std.testing.expectEqual(@as(usize, 0), fixture.reads(9));
    for (full.logs) |log| try std.testing.expectEqualSlices(u8, &hashFor(log.block_number), &log.block_hash);

    // A known leading head saves its read; bound 5 skips only block 3.
    fixture.reset();
    const head: rpc.BlockHeader = .{ .number = 10, .hash = hashFor(10), .parent_hash = hashFor(9), .timestamp = 1 };
    var bounded = try indexer.fetchFenced(.insertion, range, 10, .{ .leading = head, .root_checked_through = 5 });
    defer bounded.deinit();
    try std.testing.expectEqual(@as(usize, 1), fixture.reads(10));
    try std.testing.expectEqual(@as(usize, 0), fixture.reads(3));
    try std.testing.expectEqual(@as(usize, 1), fixture.reads(6));
    // Unverified identity is never recorded as provenance.
    try std.testing.expect(std.mem.allEqual(u8, &bounded.logs[0].block_hash, 0));
    try std.testing.expectEqualSlices(u8, &hashFor(6), &bounded.logs[1].block_hash);

    // Above the bound a non-canonical log still fails closed.
    fixture.reset();
    fixture.orphan_block = 6;
    try std.testing.expectError(error.NoncanonicalLog, indexer.fetchFenced(.insertion, range, 10, .{ .leading = head, .root_checked_through = 5 }));
    // At/below the bound it is admitted with unknown provenance; the Service
    // root check (validator/test.zig) then refuses to sign the resulting leaf.
    var admitted = try indexer.fetchFenced(.insertion, range, 10, .{ .leading = head, .root_checked_through = 6 });
    defer admitted.deinit();
    try std.testing.expect(std.mem.allEqual(u8, &admitted.logs[1].block_hash, 0));
    // The fence parent hash still binds the block below the fence.
    fixture.orphan_block = 9;
    try std.testing.expectError(error.NoncanonicalLog, indexer.fetchFenced(.insertion, range, 10, .{ .leading = head, .root_checked_through = 10 }));
    // Other streams never take the relaxation.
    try std.testing.expectError(error.UnsupportedRootCheckedStream, indexer.fetchFenced(.dispatch, range, 10, .{ .root_checked_through = 10 }));
}
