//! Scripted CometBFT0.38 wire with the production Cosmos Adapter/Core, native
//! libcurl pool and RocksDB. This is not a live Cosmos SDK node fixture.
const std = @import("std");
const Service = @import("service.zig").Service;
const source = @import("../scraper/source.zig");
const Adapter = @import("../scraper/cosmos.zig").Adapter;
const rpc = @import("../../evm/provider.zig");
const Pool = @import("../../evm/pool.zig").Pool;
const Read = @import("../../net/read_replay.zig");
const settings = @import("../../settings/types.zig");
const tm = @import("../../cosmos/tendermint.zig");
const types = @import("../../cosmos/types.zig");
const fixture = @import("../../evm/pool_testing.zig");
const rocks = @import("../../db/rocks.zig");
const A = std.mem.Allocator;
var result_counts: [34]std.atomic.Value(usize) = [_]std.atomic.Value(usize){.init(0)} ** 34;
fn hash(height: u64) [32]u8 {
    var out: [32]u8 = @splat(0);
    std.mem.writeInt(u64, out[24..], height, .big);
    return out;
}
fn respond(a: A, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    const object = parsed.value.object;
    const method = object.get("method").?.string;
    const result = if (std.mem.eql(u8, method, "status")) try a.dupe(u8, "{\"node_info\":{\"network\":\"quantum-1\"},\"sync_info\":{\"latest_block_height\":\"33\",\"latest_block_hash\":\"" ++ ("00" ** 31) ++ "21\",\"catching_up\":false}}") else blk: {
        const height = try std.fmt.parseInt(u64, object.get("params").?.object.get("height").?.string, 10);
        if (height == 0 or height > 33) return error.UnexpectedFixtureHeight;
        const has_event = height == 1 or height == 33;
        if (std.mem.eql(u8, method, "block")) {
            const current = std.fmt.bytesToHex(hash(height), .upper);
            const parent = std.fmt.bytesToHex(hash(height - 1), .upper);
            const txs: ?[]const []const u8 = if (height == 1) &.{"AQ=="} else if (height == 33) &.{"IQ=="} else null;
            var height_buf: [20]u8 = undefined;
            break :blk try std.json.Stringify.valueAlloc(a, .{ .block_id = .{ .hash = current[0..] }, .block = .{ .header = .{ .chain_id = "quantum-1", .height = try std.fmt.bufPrint(&height_buf, "{d}", .{height}), .time = "2026-01-01T00:00:00Z", .last_block_id = .{ .hash = parent[0..] } }, .data = .{ .txs = txs } } }, .{});
        }
        if (!std.mem.eql(u8, method, "block_results")) return error.UnexpectedFixtureMethod;
        _ = result_counts[@intCast(height)].fetchAdd(1, .monotonic);
        // Exact native module event keys and JSON-string attribute dialect from
        // hyperlane-cosmos EventGasPayment; transaction identity differs by block.
        const events = "[{\"code\":0,\"events\":[{\"type\":\"hyperlane.core.post_dispatch.v1.EventGasPayment\",\"attributes\":[{\"key\":\"igp_id\",\"value\":\"\\\"0x" ++ ("33" ** 32) ++ "\\\"\"},{\"key\":\"message_id\",\"value\":\"\\\"0x" ++ ("22" ** 32) ++ "\\\"\"},{\"key\":\"gas_amount\",\"value\":\"1000\"},{\"key\":\"payment\",\"value\":\"\\\"2500uatom\\\"\"},{\"key\":\"destination\",\"value\":\"2000\"}]}]}]";
        break :blk try std.fmt.allocPrint(a, "{{\"height\":\"{d}\",\"txs_results\":{s}}}", .{ height, if (has_event) events else "null" });
    };
    defer a.free(result);
    return std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ object.get("id").?.integer, result });
}
const Commit = struct {
    journal: *Read.Replay,
    budget: *Read.ByteBudget,
    fn commit(ctx: *anyopaque) !void {
        const self: *Commit = @ptrCast(@alignCast(ctx));
        try self.journal.commitReadSection();
    }
    fn reserve(ctx: *anyopaque, n: usize) !void {
        const self: *Commit = @ptrCast(@alignCast(ctx));
        try self.budget.reserve(n);
    }
    fn release(ctx: *anyopaque, n: usize) void {
        const self: *Commit = @ptrCast(@alignCast(ctx));
        self.budget.release(n);
    }
};
test "native Cosmos cooperative quantum32 finishes admitted range before cadence with no skipped or repeated block fetch" {
    const a = std.testing.allocator;
    for (&result_counts) |*count| count.store(0, .monotonic);
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = respond }};
    var server = try fixture.Fixture.init(256, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const pool = try Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{} }, .max_sessions = 2, .max_concurrent = 2, .max_pending = 8, .max_response_bytes = 8192, .max_reserved_bytes = 1024 * 1024 });
    defer pool.deinit();
    var budget: Read.ByteBudget = .{ .maximum = 1024 * 1024 };
    var journal = try Read.Replay.init(a, pool, .{ .shared_budget = &budget });
    defer journal.deinit();
    var client = try rpc.RpcClient.init(a, url, .{ .exchange = journal.interface(), .max_response_bytes = 8192 });
    defer client.deinit();
    const tendermint: tm.Client = .{ .rpc_client = &client, .chain_id = "quantum-1", .compat = .v038 };
    var adapter: Adapter = .{ .tendermint = tendermint, .native = true, .contracts = .{ .mailbox = @splat(1), .hook = @splat(2), .paymaster = @splat(0x33) }, .queries = .{ .allocator = a, .transport = undefined, .domain = 1000, .config = .{ .chain_id = "quantum-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = .{ .numerator = 1, .denominator = 1 }, .gas_multiplier = 2, .confirmations = 0 } } };
    var callback: Commit = .{ .journal = &journal, .budget = &budget };
    var src = adapter.interface();
    src.read_section = .{ .context = &callback, .commit_fn = Commit.commit, .reservation = .{ .context = &callback, .reserve_fn = Commit.reserve, .release_fn = Commit.release } };
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try rocks.Database.open(a, path, .{});
    var database_closed = false;
    defer if (!database_closed) database.deinit();
    var chain: settings.Chain = undefined;
    chain.protocol = .cosmosnative;
    chain.name = "cosmos-native-quantum";
    chain.domain = 1000;
    chain.index = .{ .from = 1, .chunk = 1999, .mode = .block, .interval = 1 };
    chain.contracts = .{ .mailbox = adapter.contracts.mailbox, .merkle_tree_hook = adapter.contracts.hook, .interchain_gas_paymaster = adapter.contracts.paymaster, .validator_announce = @splat(0) };
    const driver = try Service.open(a, &chain, src, &database, null, true);
    var driver_closed = false;
    defer if (!driver_closed) driver.deinit();
    driver.indexer.options.enabled_streams = .{ false, false, true };
    var completed: usize = 0;
    var suspended: usize = 0;
    var primed = false;
    var timer = try std.time.Timer.start();
    while (completed < 2) {
        try journal.beginPass(null);
        const report = driver.tick(if (primed) 30000 + timer.read() / std.time.ns_per_ms else 0, null) catch |err| {
            journal.endPass(err);
            if (err != error.PendingReadIo) return err;
            suspended += 1;
            if (timer.read() > 8 * std.time.ns_per_s) return error.CosmosQuantumTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        journal.endPass(null);
        primed = true;
        if (report.ranges != 0) {
            completed += 1;
            try std.testing.expectEqual(@as(usize, 1), report.payments);
            try std.testing.expectEqual(@as(u32, if (completed == 1) 33 else 34), driver.indexer.gas_block.?.next);
        }
        if (timer.read() > 8 * std.time.ns_per_s) return error.CosmosQuantumCadenceRegression;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(suspended >= 33);
    for (result_counts[1..]) |*count| try std.testing.expectEqual(@as(usize, 1), count.load(.monotonic));
    try std.testing.expectEqual(@as(u32, 1999), driver.indexer.gas_block.?.options.chunk);
    try std.testing.expectEqual(@as(?u32, 1), try driver.store.gasWatermark());
    const key: @import("../../db/codec.zig").GasPaymentKey = .{ .message_id = [_]u8{0x22} ** 32, .destination = @as(u32, 2000) };
    try std.testing.expectEqual(@as(u256, 5000), (try driver.store.payment(key)).?.payment);
    driver.deinit();
    driver_closed = true;
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    database.deinit();
    database_closed = true;
    var reopened = try rocks.Database.open(a, path, .{});
    defer reopened.deinit();
    var store = @import("../store.zig").Store.init(a, &reopened, chain.name);
    try std.testing.expectEqual(@as(u256, 5000), (try store.payment(key)).?.payment);
    try server.check();
}
