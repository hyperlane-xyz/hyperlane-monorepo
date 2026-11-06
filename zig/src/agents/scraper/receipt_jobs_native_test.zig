//! Scripted Ethereum wire through real Resources forks/Pool and receipt decode.
const std = @import("std");
const source = @import("../chain_source.zig");
const jobs = @import("receipt_jobs.zig");
const enrich = @import("enrichment.zig");
const pg = @import("../../db/postgres.zig");
const fixture = @import("../../evm/pool_testing.zig");
const A = std.mem.Allocator;
fn respond(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    const object = parsed.value.object;
    const method = object.get("method").?.string;
    const result = if (std.mem.eql(u8, method, "eth_chainId")) try a.dupe(u8, "\"0x1\"") else blk: {
        const hash = object.get("params").?.array.items[0].string;
        const block_hash = "0x" ++ "02" ** 32;
        if (std.mem.eql(u8, method, "eth_getTransactionByHash")) break :blk try std.fmt.allocPrint(a, "{{\"hash\":\"{s}\",\"blockHash\":\"{s}\",\"blockNumber\":\"0x5\",\"gas\":\"0x5208\",\"nonce\":\"0x0\",\"from\":\"0x1111111111111111111111111111111111111111\",\"to\":null,\"gasPrice\":\"0x2\",\"input\":\"0x1234\"}}", .{ hash, block_hash });
        if (std.mem.eql(u8, method, "eth_getTransactionReceipt")) break :blk try std.fmt.allocPrint(a, "{{\"transactionHash\":\"{s}\",\"blockHash\":\"{s}\",\"blockNumber\":\"0x5\",\"gasUsed\":\"0x5208\",\"cumulativeGasUsed\":\"0x5208\",\"effectiveGasPrice\":\"0x2\"}}", .{ hash, block_hash });
        return error.UnexpectedNativeReceiptMethod;
    };
    defer a.free(result);
    return std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ object.get("id").?.integer, result });
}
const Persist = struct {
    seen: [16]u8 = @splat(0),
    pub fn store(self: *Persist, request: enrich.Request, value: enrich.Txn, _: ?@import("source.zig").Header, _: pg.IoOptions) !void {
        try std.testing.expectEqualSlices(u8, &request.meta.tx_hash, &value.hash);
        try std.testing.expectEqualSlices(u8, &request.meta.block_hash, &value.block_hash);
        try std.testing.expectEqual(@as(u256, 21000), value.gas_used);
        try std.testing.expectEqual(@as(?u256, 2), value.effective_gas_price);
        try std.testing.expectEqualSlices(u8, &.{ 0x12, 0x34 }, value.raw_input.?);
        self.seen[value.hash[63]] += 1;
    }
};
test "native receipt fanout eight stalled jobs leave eight healthy jobs progressing through shared transports" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const slow = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const fast = [_]fixture.Reply{.{ .body = "" }};
    const behaviors = [_]fixture.Behavior{ .{ .replies = &slow }, .{ .replies = &slow }, .{ .replies = &fast, .response_fn = respond }, .{ .replies = &fast, .response_fn = respond } };
    var server = try fixture.Fixture.init(128, &behaviors);
    try server.start();
    defer server.deinit();
    var limiter = try jobs.Limiter.init(a, &.{ 1, 2, 3, 4 });
    defer limiter.deinit();
    var budget: source.ReadReplay.ByteBudget = .{ .maximum = 4 * 1024 * 1024 };
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var parents: [4]*source.Resources = undefined;
    var batches: [4]jobs.Batch(source.Resources) = undefined;
    var initialized: usize = 0;
    defer for (0..initialized) |i| {
        batches[i].deinit();
        parents[i].deinit();
    };
    var requests: [16]enrich.Request = undefined;
    for (&requests, 0..) |*request, i| {
        var tx: [64]u8 = @splat(0);
        tx[63] = @intCast(i);
        request.* = .{ .meta = .{ .tx_hash = tx, .block_hash = @splat(2), .block_number = 5 }, .block_id = 1 };
    }
    const deadline = (try pg.nowNs()) + 20 * std.time.ns_per_s;
    for (0..4) |i| {
        const urls = try arena.allocator().alloc([]const u8, 1);
        urls[0] = try server.url(arena.allocator(), i);
        var chain = @import("../chain_source_testing.zig").chainFor(urls);
        chain.domain = @intCast(i + 1);
        parents[i] = try source.Resources.open(a, &chain, &env, .{ .curl_library = library, .rpc_parallelism = 8, .rpc_max_response_bytes = 8192, .read_budget = &budget });
        batches[i] = try jobs.Batch(source.Resources).init(a, parents[i], &limiter, chain.domain, requests[i * 4 ..][0..4], deadline);
        initialized += 1;
    }
    var persist: Persist = .{};
    var timer = try std.time.Timer.start();
    while (batches[2].completed != 4 or batches[3].completed != 4) {
        for (&batches) |*batch| _ = try batch.step(.{}, &persist);
        if (timer.read() > 2 * std.time.ns_per_s) return error.HealthyReceiptDomainStarved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 16), limiter.peak);
    try std.testing.expectEqual(@as(usize, 8), limiter.active);
    for (persist.seen[0..8]) |count| try std.testing.expectEqual(@as(u8, 0), count);
    for (persist.seen[8..]) |count| try std.testing.expectEqual(@as(u8, 1), count);
    for (2..4) |i| try std.testing.expectEqual(@as(usize, 12), server.pathHits(i));
    for (0..initialized) |i| {
        batches[i].deinit();
        parents[i].deinit();
    }
    initialized = 0;
    try std.testing.expectEqual(@as(usize, 0), limiter.active);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try server.check();
}
