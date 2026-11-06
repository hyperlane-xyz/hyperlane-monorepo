//! Real EVM origin owner, actual RPC envelope parsing/cursors and RocksDB.
const std = @import("std");
const origin = @import("../evm_origin.zig");
const rpc = @import("../../evm/provider.zig");
const db = @import("../../db/root.zig");
const A = std.mem.Allocator;
const Wire = struct {
    fail: bool = true,
    fetches: usize = 0,
    tip_errors: [2]?anyerror = @splat(null),
    tip_calls: [2]usize = @splat(0),
    fn read(context: *anyopaque, a: A, bytes: []const u8, _: rpc.Options) !rpc.WireResponse {
        const self: *@This() = @ptrCast(@alignCast(context));
        var parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        defer parsed.deinit();
        const value = parsed.value;
        const method = value.object.get("method").?.string;
        const result: std.json.Value = if (std.mem.eql(u8, method, "eth_getLogs")) result: {
            self.fetches += 1;
            if (self.fail) return error.RpcHttpStatus;
            break :result .{ .array = std.json.Array.init(a) };
        } else if (std.mem.eql(u8, method, "eth_call")) result: {
            const address = value.object.get("params").?.array.items[0].object.get("to").?.string;
            const selected: usize = if (std.mem.endsWith(u8, address, "01")) 0 else 1;
            self.tip_calls[selected] += 1;
            if (self.tip_errors[selected]) |err| return err;
            const count: u8 = if (selected == 0) 1 else 0;
            var word: [32]u8 = @splat(0);
            word[31] = count;
            break :result .{ .string = try @import("../../evm/codecs.zig").hexAlloc(a, &word) };
        } else if (std.mem.eql(u8, method, "eth_getBlockByNumber")) result: {
            var header = std.json.ObjectMap.init(a);
            try header.put("number", .{ .string = "0x5" });
            try header.put("hash", .{ .string = "0x" ++ "11" ** 32 });
            try header.put("parentHash", .{ .string = "0x" ++ "22" ** 32 });
            try header.put("timestamp", .{ .string = "0x3e8" });
            break :result .{ .object = header };
        } else return error.UnexpectedOriginMetricRpc;
        defer if (result == .object) {
            var object = result.object;
            object.deinit();
        };
        defer if (result == .string) a.free(result.string);
        const response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = value.object.get("id").?, .result = result }, .{});
        return .{ .bytes = response, .len = response.len };
    }
};
test "EVM origin metrics follow actual empty cycles and Source scheduled fetch recovery" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "evm-progress" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var chain: @import("../../settings/types.zig").Chain = undefined;
    chain.name = "evm-progress";
    chain.index = .{ .from = 0, .chunk = 5, .interval = 1 };
    var wire: Wire = .{};
    var client = try rpc.RpcClient.init(a, "https://fixture", .{ .exchange = .{ .context = &wire, .fetch_fn = Wire.read } });
    defer client.deinit();
    const service = try a.create(origin.Service);
    service.* = .{
        .allocator = a,
        .chain = &chain,
        .store = @import("../store.zig").Store.init(a, &database, chain.name),
        .history = undefined,
        .indexer = try @import("../../evm/indexer.zig").Indexer.init(a, &client, .{ .chain_id = 1, .domain = 10, .mailbox = .{0} ** 19 ++ .{1}, .hook = .{0} ** 19 ++ .{2}, .paymaster = .{0} ** 19 ++ .{3}, .reorg_period = .none }),
        .progress = undefined,
        .gas_enabled = false,
    };
    defer service.deinit();
    service.indexer.chain_checked = true;
    service.history = @import("../origin.zig").Origin.init(a, &service.store, 10, @splat(2), null);
    service.progress = .{ .{ .store = &service.store, .stream = .dispatch }, .{ .store = &service.store, .stream = .insertion } };
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: @import("../../ops/indexing_metrics.zig").Adapter = .{ .registry = registry, .chain = chain.name, .unix_seconds = 1000 };
    service.observer = adapter.interface();
    _ = try service.tick(0, null); // Failed real eth_getLogs =>5s.
    _ = try service.tick(0, null); // Healthy zero-count insertion completes.
    try std.testing.expectEqual(@as(usize, 1), wire.fetches);
    service.next_stream = 0;
    _ = try service.tick(4999, null);
    try std.testing.expectEqual(@as(usize, 1), wire.fetches);
    service.next_stream = 0;
    _ = try service.tick(5000, null); // Second failure =>10s.
    try std.testing.expectEqual(@as(usize, 2), wire.fetches);
    wire.fail = false;
    service.next_stream = 0;
    adapter.unix_seconds = 1015;
    _ = try service.tick(15000, null); // Authentic empty range, no stored event.
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expectEqual(@as(?i64, 2), try sample(text, "hyperlane_contract_sync_fetch_retries", "dispatched_messages"));
    try std.testing.expectEqual(@as(?i64, 0), try sample(text, "hyperlane_contract_sync_fetch_backoff_seconds", "dispatched_messages"));
    try std.testing.expectEqual(@as(?i64, 1015), try sample(text, "hyperlane_contract_sync_liveness", "dispatched_messages"));
    try std.testing.expectEqual(@as(?i64, 1000), try sample(text, "hyperlane_contract_sync_liveness", "merkle_tree_hook"));
    try std.testing.expect((try sample(text, "hyperlane_contract_sync_stored_events", "dispatched_messages")) == null);
}
fn sample(text: []const u8, name: []const u8, kind: []const u8) !?i64 {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{' or std.mem.indexOf(u8, line, kind) == null) continue;
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        return try std.fmt.parseInt(i64, line[space + 1 ..], 10);
    }
    return null;
}

test "EVM stored event metrics count actual native commits once across exact batch replay" {
    const a = std.testing.allocator;
    const abi = @import("../../evm/codecs.zig");
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "evm-batch-metrics" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "origin");
    const message: @import("../../protocol/root.zig").Message = .{ .origin = 10, .destination = 20, .nonce = 0, .sender = .{0} ** 12 ++ .{1} ** 20, .recipient = @splat(2), .body = "committed metrics" };
    const encoded_message = try message.encodeAlloc(a);
    defer a.free(encoded_message);
    const data = try a.alloc(u8, 64 + ((encoded_message.len + 31) / 32) * 32);
    @memset(data, 0);
    std.mem.writeInt(u256, data[0..32], 32, .big);
    std.mem.writeInt(u256, data[32..64], encoded_message.len, .big);
    @memcpy(data[64..][0..encoded_message.len], encoded_message);
    var topics: [4][32]u8 = .{ abi.dispatch_topic, message.sender, @splat(0), message.recipient };
    std.mem.writeInt(u256, &topics[2], message.destination, .big);
    const logs = try a.alloc(rpc.Log, 1);
    logs[0] = .{ .allocator = a, .address = @splat(1), .topics = topics, .topic_count = 4, .data = data, .block_number = 5, .block_hash = @splat(5), .transaction_hash = @splat(3), .transaction_index = 0, .log_index = 0 };
    var batch: @import("../../evm/indexer.zig").Batch = .{ .allocator = a, .stream = .dispatch, .logs = logs, .through = .{ .number = 5, .hash = @splat(5), .parent_hash = @splat(4), .timestamp = 1000 }, .domain = 10 };
    defer batch.deinit();
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: @import("../../ops/indexing_metrics.zig").Adapter = .{ .registry = registry, .chain = "origin" };
    for (0..2) |_| {
        const points = try batch.storeObserved(&store, adapter.interface());
        defer a.free(points);
        try std.testing.expectEqual(@as(usize, 1), points.len);
    }
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expectEqual(@as(?i64, 1), try sample(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
    try std.testing.expect((try sample(text, "hyperlane_contract_sync_liveness", "dispatched_messages")) == null);
    var stored = (try store.messageByNonce(0)).?;
    defer stored.deinit();
    try std.testing.expectEqual(message.id(), stored.value.id());
}

fn evmBootstrap(native_timeout: bool) !void {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var chain: @import("../../settings/types.zig").Chain = undefined;
    chain.name = "evm-bootstrap";
    chain.index = .{ .from = 0, .chunk = 5, .interval = 1 };
    var wire: Wire = .{ .fail = false, .tip_errors = .{ error.RpcHttpStatus, error.RpcHttpStatus } };
    var client = try rpc.RpcClient.init(a, "https://fixture", .{ .exchange = .{ .context = &wire, .fetch_fn = Wire.read } });
    defer client.deinit();
    var tracker: @import("../../ops/critical_metrics.zig").Tracker = .{};
    tracker.record(.gas_payment_sync);
    tracker.record(.merkle_tree_db_loader);
    const preserved = tracker.reasons;
    const driver = try a.create(origin.Service);
    driver.* = .{
        .allocator = a,
        .chain = &chain,
        .store = @import("../store.zig").Store.init(a, &database, chain.name),
        .history = undefined,
        .indexer = try @import("../../evm/indexer.zig").Indexer.init(a, &client, .{ .chain_id = 1, .domain = 10, .mailbox = .{0} ** 19 ++ .{1}, .hook = .{0} ** 19 ++ .{2}, .paymaster = .{0} ** 19 ++ .{3}, .reorg_period = .none }),
        .progress = undefined,
        .gas_enabled = false,
        .critical = &tracker,
    };
    defer driver.deinit();
    driver.indexer.chain_checked = true;
    driver.history = @import("../origin.zig").Origin.init(a, &driver.store, 10, @splat(2), null);
    driver.progress = .{ .{ .store = &driver.store, .stream = .dispatch }, .{ .store = &driver.store, .stream = .insertion } };
    for ([_]anyerror{ error.PendingReadIo, error.PendingIo, error.RequestCancelled, error.OutOfMemory, error.RequestDeadlineExceeded, error.ReadReplayDeadline, error.PoolQueueFull }) |err| {
        wire.tip_errors[0] = err;
        driver.next_stream = 0;
        driver.due[0] = 0;
        try std.testing.expectError(err, driver.tick(0, null));
        try std.testing.expectEqual(@as(u8, 0), driver.bootstrap[0].failures);
    }
    wire.tip_errors[0] = error.RpcHttpStatus;
    wire.tip_calls = @splat(0);
    driver.next_stream = 0;
    driver.due[0] = 0;
    for (0..10) |i| {
        _ = try driver.tick(i * 3000, null);
        _ = try driver.tick(i * 3000, null);
        try std.testing.expectEqual(preserved, tracker.reasons);
    }
    const first_due = @min(driver.bootstrap[0].retry_at_ms, driver.bootstrap[1].retry_at_ms);
    _ = try driver.tick(first_due - 1, null);
    try std.testing.expectEqual([2]usize{ 10, 10 }, wire.tip_calls);
    // Four further completed failures after the terminal sleep still retain the
    // precise two cursor reasons; native continues recovery instead of dropping.
    for (10..12) |i| {
        _ = try driver.tick(i * 3000, null);
        _ = try driver.tick(i * 3000, null);
    }
    try std.testing.expectEqual([2]usize{ 12, 12 }, wire.tip_calls);
    const message_bit = @as(u16, 1) << @intFromEnum(@import("../../ops/critical_metrics.zig").Reason.message_sync);
    const merkle_bit = @as(u16, 1) << @intFromEnum(@import("../../ops/critical_metrics.zig").Reason.merkle_tree_hook_sync);
    try std.testing.expectEqual(preserved | message_bit | merkle_bit, tracker.reasons);
    wire.tip_errors[1] = null;
    driver.next_stream = 1;
    _ = try driver.tick(36000, null);
    try std.testing.expect(driver.bootstrap[1].initialized);
    try std.testing.expectEqual(preserved | message_bit, tracker.reasons);
    const before = wire.tip_calls;
    _ = driver.setStreamMask(.{ false, false, false });
    try std.testing.expectEqual(preserved, tracker.reasons);
    _ = try driver.tick(39000, null);
    try std.testing.expectEqual(before, wire.tip_calls);
    if (!native_timeout) return;
    // Direct curl code28 is a completed physical request, while the injected
    // RequestDeadlineExceeded controls above must never spend this budget.
    const fixture = @import("../../evm/pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var transport = try @import("../../net/curl.zig").Client.init(a, library);
    defer transport.deinit();
    const replies = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const behaviors = [_]fixture.Behavior{.{ .replies = &replies }};
    var server = try fixture.Fixture.init(1, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var direct = try rpc.RpcClient.init(a, url, .{ .native_transport = &transport, .timeout_ms = 25, .connect_timeout_ms = 25 });
    defer direct.deinit();
    driver.indexer.client = &direct;
    defer driver.indexer.client = &client;
    _ = driver.setStreamMask(.{ true, false, false });
    _ = try driver.tick(40000, null);
    try std.testing.expectEqual(@as(u8, 1), driver.bootstrap[0].failures);
    try std.testing.expect(driver.bootstrap[0].retry_at_ms > 42000);
}

test "origin bootstrap EVM actual count failures independent retries recovery and WS reasons" {
    try evmBootstrap(false);
}
test "origin bootstrap EVM direct native physical request timeout consumes one completed attempt" {
    try evmBootstrap(true);
}
