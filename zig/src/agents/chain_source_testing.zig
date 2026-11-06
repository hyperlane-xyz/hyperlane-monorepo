const std = @import("std");
const source = @import("chain_source.zig");
const types = @import("../settings/types.zig");
const fixture = @import("../evm/pool_testing.zig");
const A = std.mem.Allocator;
fn echoId(a: A, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = "0x1" }, .{});
}
test "source resource read forks own IDs journals and sanitized environment while borrowing transport" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = echoId }};
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chain = chainFor(&.{url});
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("DISPOSABLE_SIGNING_KEY", "never-copy-to-read-fork");
    var budget: source.ReadReplay.ByteBudget = .{ .maximum = 1024 * 1024 };
    const parent = try source.Resources.open(a, &chain, &env, .{ .curl_library = library, .read_budget = &budget, .rpc_parallelism = 128, .rpc_max_response_bytes = 65536 });
    defer parent.deinit();
    const first = try parent.forkRead(a);
    defer first.deinit();
    const second = try parent.forkRead(a);
    defer second.deinit();
    try std.testing.expect(parent.rpc_pool == first.rpc_pool and first.rpc_pool == second.rpc_pool);
    try std.testing.expect(parent.rpc_pool_owned and !first.rpc_pool_owned and !second.rpc_pool_owned);
    try std.testing.expect(first.read_replay.? != second.read_replay.?);
    try std.testing.expect(first.clients.ethereum != second.clients.ethereum);
    try std.testing.expect(first.chain.signer == null and first.chain.identity == null and first.chain.ccs_signer == null);
    try std.testing.expect(first.environment.get("DISPOSABLE_SIGNING_KEY") == null);
    try std.testing.expectEqual(source.RpcMetrics.Operation.relayer_metadata, first.options.operation);
    try std.testing.expectEqual(@as(usize, 32768), first.rpc_client.?.options.max_response_bytes);
    first.rpc_client.?.next_id = 41;
    second.rpc_client.?.next_id = 90;
    var timer = try std.time.Timer.start();
    var done = [_]bool{ false, false };
    const forks = [_]*source.Resources{ first, second };
    while (!done[0] or !done[1]) {
        for (forks, 0..) |fork, i| {
            if (done[i]) continue;
            try fork.beginReadPass(null);
            var response = fork.clients.ethereum.call("eth_chainId", .{}) catch |err| {
                fork.endReadPass(err);
                if (err != error.PendingReadIo) return err;
                continue;
            };
            defer response.deinit();
            try std.testing.expectEqualStrings("0x1", response.value().string);
            try fork.commitReadSection();
            fork.endReadPass(null);
            done[i] = true;
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureReadForkTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    var response = try parent.clients.ethereum.call("eth_chainId", .{});
    defer response.deinit();
    try std.testing.expectEqualStrings("0x1", response.value().string);
    try std.testing.expectEqual(@as(usize, 3), server.acceptedCount());
    try server.check();
}
pub fn chainFor(urls: []const []const u8) types.Chain {
    const chain: types.Chain = .{
        .name = "rpc-parallel-fixture",
        .domain = 1,
        .protocol = .ethereum,
        .chain_id = "1",
        .rpc_urls = urls,
        .grpc_urls = &.{},
        .index = .{},
        .contracts = .{ .mailbox = .{0} ** 32, .merkle_tree_hook = .{0} ** 32, .interchain_gas_paymaster = .{0} ** 32, .validator_announce = .{0} ** 32 },
        .signer = null,
        .identity = null,
        .ccs_signer = null,
        .reorg = .{ .blocks = 0 },
        .confirmations = 1,
        .estimated_block_time = 1,
        .native_token = .{ .decimals = 18, .symbol = "ETH", .denom = "wei" },
        .connection = .{ .ethereum = .{ .consensus = .single, .consider_null_transaction_receipt = false, .fallback_hedge_delay_ms = null, .fallback_hedge_timeout_ms = null, .transaction_overrides = std.mem.zeroes(types.TransactionOverrides), .mev_submission = null } },
        .submitter = .classic,
        .max_batch_size = 1,
        .batch_contract_address = null,
        .bypass_batch_simulation = false,
        .max_submit_queue_length = null,
        .ignore_reorg_reports = false,
    };
    return chain;
}
test "source resource configured metadata parallelism admits healthy ninth call behind eight stalled calls on one endpoint" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var replies: [9]fixture.Reply = undefined;
    for (replies[0..8]) |*reply| reply.* = .{ .body = "", .stall = true };
    replies[8] = .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}" };
    const behaviors = [_]fixture.Behavior{.{ .replies = &replies }};
    var server = try fixture.Fixture.init(256, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chain = chainFor(&.{url});
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const resources = try source.Resources.open(a, &chain, &env, .{ .curl_library = library, .rpc_parallelism = 128, .rpc_max_response_bytes = 32768, .rpc_max_reserved_bytes = 4 * 1024 * 1024 });
    defer resources.deinit();
    const runtime = resources.rpc_pool.?;
    try std.testing.expectEqual(@as(u16, 128), runtime.config.max_sessions);
    try std.testing.expectEqual(@as(u16, 128), runtime.config.max_concurrent);
    try std.testing.expectEqual(@as(usize, 1), runtime.endpointCount());
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}";
    var handles: [8]@import("../evm/pool.zig").Handle = undefined;
    var initialized: usize = 0;
    defer for (handles[0..initialized]) |handle| runtime.cancel(handle);
    for (&handles) |*handle| {
        handle.* = try runtime.submit(body, 20000, 5000, 32768);
        initialized += 1;
    }
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() < 8) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const result = try runtime.fetch(a, body, 20000, 5000, null, 32768);
    defer a.free(result.bytes);
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try std.testing.expectEqual(@as(usize, 9), server.acceptedCount());
    try server.check();
}
test "source resource rejects impossible session parallelism and fanout without truncating peer sets" {
    const a = std.testing.allocator;
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const missing: types.Chain = undefined;
    try std.testing.expectError(error.InvalidRpcParallelism, source.Resources.open(a, &missing, &env, .{ .curl_library = "missing", .rpc_parallelism = 129 }));
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const urls = try arena.allocator().alloc([]const u8, 33);
    for (urls, 0..) |*url, i| url.* = try std.fmt.allocPrint(arena.allocator(), "http://127.0.0.1:1/{d}", .{i});
    var chain = chainFor(urls);
    chain.connection.ethereum.consensus = .quorum;
    try std.testing.expectError(error.RpcParallelFanoutLimit, source.Resources.open(a, &chain, &env, .{ .curl_library = library, .rpc_parallelism = 128 }));
}

const GrpcClock = struct {
    value: u64,
    fn now(ctx: *anyopaque) u64 {
        const self: *GrpcClock = @ptrCast(@alignCast(ctx));
        return self.value;
    }
};
fn pendingGrpc(_: *anyopaque, _: A, _: usize, _: @import("../cosmos/grpc.zig").Request, _: ?*source.HttpReplay.Replay) !@import("../cosmos/grpc.zig").Response {
    return error.PendingReadIo;
}
test "source resource Cosmos forks retain gRPC fallback snapshots across native HTTP2 yields and share one height probe" {
    const a = std.testing.allocator;
    const configured = std.process.getEnvVarOwned(a, "HYPERLANE_COSMOS_GRPC_TEST_URL") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(configured);
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const end = std.mem.indexOfScalar(u8, configured, '?') orelse configured.len;
    const bad = try std.fmt.allocPrint(a, "{s}/fallback/bad", .{configured[0..end]});
    defer a.free(bad);
    const fast = try std.fmt.allocPrint(a, "{s}/fallback/fast", .{configured[0..end]});
    defer a.free(fast);
    const owner = try source.HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_response_bytes = 8 * 1024 * 1024 + 5, .max_reserved_bytes = 128 * 1024 * 1024 } });
    defer owner.deinit();
    var chain = chainFor(&.{"http://127.0.0.1:1/unused"});
    chain.protocol = .cosmos;
    chain.chain_id = "test-1";
    chain.grpc_urls = &.{ bad, fast };
    chain.connection = .{ .cosmos = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .gas_price = .{ .amount = "0.025", .denom = "uatom" }, .contract_address_bytes = 32, .gas_multiplier = 1.3, .compat_mode = "0.38", .canonical_asset = "uatom" } };
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var budget: source.ReadReplay.ByteBudget = .{ .maximum = 8 * 1024 * 1024 };
    const parent = try source.Resources.open(a, &chain, &env, .{ .curl_library = library, .http_runtime = owner, .read_budget = &budget });
    defer parent.deinit();
    const first = try parent.forkRead(a);
    defer first.deinit();
    const second = try parent.forkRead(a);
    defer second.deinit();
    try std.testing.expect(parent.grpc_health == first.grpc_health and first.grpc_health == second.grpc_health);
    var timer = try std.time.Timer.start();
    while (true) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.GrpcFallbackResourceTimeout;
        try first.beginReadPass(null);
        const before = first.clients.cosmos.queries.wasmNonce(@splat(0x11), 100) catch |err| {
            first.endReadPass(err);
            if (err != error.PendingReadIo) return err;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        const after = first.clients.cosmos.queries.wasmNonce(@splat(0x11), 100) catch |err| {
            first.endReadPass(err);
            if (err != error.PendingReadIo) return err;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        try std.testing.expectEqual(@as(u32, 5), before);
        try std.testing.expectEqual(@as(u32, 5), after);
        try first.commitReadSection();
        first.endReadPass(null);
        break;
    }
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try std.testing.expectEqual(@as(u32, 2), parent.grpc_health.?.priorities[0].failed);
    var clock: GrpcClock = .{ .value = 120001 * std.time.ns_per_ms };
    parent.grpc_health.?.clock = .{ .context = &clock, .now_fn = GrpcClock.now };
    for (parent.grpc_health.?.priorities) |*entry| entry.seen = 0;
    var done = [_]bool{ false, false };
    const forks = [_]*source.Resources{ first, second };
    while (!done[0] or !done[1]) {
        for (forks, 0..) |fork, i| {
            if (done[i]) continue;
            try fork.beginReadPass(null);
            const result = fork.clients.cosmos.queries.wasmNonce(@splat(0x11), 100) catch |err| {
                fork.endReadPass(err);
                if (err != error.PendingReadIo) return err;
                continue;
            };
            try std.testing.expectEqual(@as(u32, 5), result);
            fork.endReadPass(null);
            done[i] = true;
        }
        if (timer.read() > 3 * std.time.ns_per_s) return error.GrpcFallbackResourceTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(u64, 200), parent.grpc_health.?.priorities[1].height);
    const stats_url = try std.fmt.allocPrint(a, "{s}/fallback/stats", .{configured[0..end]});
    defer a.free(stats_url);
    var stats = try parent.native.send(a, .{ .url = stats_url, .method = .get, .require_http2 = true });
    defer stats.deinit();
    var parsed = try std.json.parseFromSlice(std.json.Value, a, stats.body, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, 4), parsed.value.object.get("bad:/cosmwasm.wasm.v1.Query/SmartContractState").?.integer);
    try std.testing.expectEqual(@as(i64, 4), parsed.value.object.get("fast:/cosmwasm.wasm.v1.Query/SmartContractState").?.integer);
    try std.testing.expectEqual(@as(i64, 1), parsed.value.object.get("fast:/cosmos.base.tendermint.v1beta1.Service/GetLatestValidatorSet").?.integer);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    // An expired outer RPC journal must retire a separately retained typed
    // gRPC operation before the next attempt, releasing its snapshot quota.
    first.grpc_fallback.?.backend = .{ .context = first, .call_fn = pendingGrpc };
    try first.beginReadPass(null);
    try std.testing.expectError(error.PendingReadIo, first.clients.cosmos.queries.wasmNonce(@splat(0x11), 100));
    first.endReadPass(error.PendingReadIo);
    try std.testing.expect(budget.used > 0 and first.grpc_fallback.?.hasPending());
    first.read_replay.?.config.max_attempt_ms = 1000;
    var stale = first.read_replay.?.started.?;
    stale.timestamp.sec -= 2;
    first.read_replay.?.started = stale;
    try std.testing.expectError(error.RequestDeadlineExceeded, first.beginReadPass(null));
    try std.testing.expect(!first.grpc_fallback.?.hasPending());
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}
