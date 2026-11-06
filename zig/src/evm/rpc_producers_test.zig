//! Actual native Pool/Registry integration for Source-active provider producers.
const std = @import("std");
const pool = @import("pool.zig");
const fixture = @import("pool_testing.zig");
const metrics = @import("../ops/metrics.zig");
const rpc_metrics = @import("../ops/rpc_metrics.zig");
const cache_module = @import("../net/dynamic_tip_cache.zig");
const A = std.mem.Allocator;
fn echo(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = "0x25" }, .{});
}
fn delayedEcho(a: A, body: []const u8) ![]u8 {
    std.Thread.sleep(20 * std.time.ns_per_ms);
    return echo(a, body);
}
fn sum(wire: []const u8, family: []const u8, filters: []const []const u8) !f64 {
    var lines = std.mem.splitScalar(u8, wire, '\n');
    var total: f64 = 0;
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, family) or line.len <= family.len or line[family.len] != '{') continue;
        var matches = true;
        for (filters) |filter| if (std.mem.indexOf(u8, line, filter) == null) {
            matches = false;
        };
        if (matches) total += try std.fmt.parseFloat(f64, line[std.mem.lastIndexOfScalar(u8, line, ' ').? + 1 ..]);
    }
    return total;
}
const Clock = struct {
    value: std.atomic.Value(u64) = .init(0),
    fn now(ctx: *anyopaque) u64 {
        const self: *Clock = @ptrCast(@alignCast(ctx));
        return self.value.load(.acquire);
    }
};

test "RPC producers native shared endpoint tip cache coalesces eight IDs across two Pools, expires at250ms and fresh reads bypass" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = delayedEcho }};
    var server = try fixture.Fixture.init(12, &behavior);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "chain", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{url});
    var clock: Clock = .{};
    const cache = try cache_module.Cache.init(a, .{ .clock = .{ .context = &clock, .now_fn = Clock.now } });
    defer cache.deinit();
    const first = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .max_sessions = 16, .max_response_bytes = 4096 });
    var first_alive = true;
    defer if (first_alive) first.deinit();
    const second = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .max_sessions = 16, .max_response_bytes = 4096 });
    var second_alive = true;
    defer if (second_alive) second.deinit();
    var handles: [8]pool.Handle = undefined;
    var done = [_]bool{false} ** 8;
    for (&handles, 0..) |*handle, index| {
        const body = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"method\":\"eth_blockNumber\",\"params\":[]}}", .{index + 1});
        defer a.free(body);
        handle.* = try (if (index % 2 == 0) first else second).submitObservedCached(body, 2000, 1000, 4096, null, true);
    }
    var timer = try std.time.Timer.start();
    var count: usize = 0;
    while (count < 8) {
        for (handles, 0..) |handle, index| {
            if (done[index]) continue;
            if (try (if (index % 2 == 0) first else second).poll(handle, a)) |response| {
                defer a.free(response.bytes);
                try @import("../net/read_replay.zig").validateResponse(a, response.bytes, @intCast(index + 1));
                done[index] = true;
                count += 1;
            }
        }
        if (timer.read() > 3 * std.time.ns_per_s) return error.CacheFixtureTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    var response = try first.fetchObservedCached(a, "{\"jsonrpc\":\"2.0\",\"id\":20,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    clock.value.store(250 * std.time.ns_per_ms, .release);
    response = try second.fetchObservedCached(a, "{\"jsonrpc\":\"2.0\",\"id\":21,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    response = try first.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":22,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 3), server.acceptedCount());
    first.deinit();
    first_alive = false;
    second.deinit();
    second_alive = false;
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 10), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"logical_read\""}));
    try std.testing.expectEqual(@as(f64, 8), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_read\""}));
    try std.testing.expectEqual(@as(f64, 3), try sum(wire, "hyperlane_request_count", &.{}));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_provider_create_count", &.{}));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_provider_drop_count", &.{}));
    try std.testing.expectEqual(@as(u64, 0), recorder.failures.load(.acquire));
    try server.check();
}

test "RPC producers native canceled tip leader releases all followers independently, no cancellation fake upstream error" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{ .{ .body = "", .stall = true }, .{ .body = "" } }, .response_fn = echo }};
    var server = try fixture.Fixture.init(10, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "cancel" });
    defer recorder.deinit();
    try recorder.configurePool(&.{url});
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .max_sessions = 8, .max_response_bytes = 4096 });
    defer owner.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}";
    const leader = try owner.submitObservedCached(body, 2000, 1000, 4096, null, true);
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() == 0) {
        if (timer.read() > std.time.ns_per_s) return error.LeaderStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    var followers: [4]pool.Handle = undefined;
    for (&followers) |*handle| handle.* = try owner.submitObservedCached(body, 2000, 1000, 4096, null, true);
    while (true) {
        const wire = try registry.render(a);
        defer a.free(wire);
        if (try sum(wire, "hyperlane_request_cache_count", &.{"result=\"logical_read\""}) == 5) break;
        if (timer.read() > std.time.ns_per_s) return error.FollowerStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    owner.cancel(leader);
    var done = [_]bool{false} ** 4;
    var completed: usize = 0;
    while (completed < 4) {
        for (followers, 0..) |handle, index| {
            if (done[index]) continue;
            if (try owner.poll(handle, a)) |response| {
                a.free(response.bytes);
                done[index] = true;
                completed += 1;
            }
        }
        if (timer.read() > 3 * std.time.ns_per_s) return error.FollowerReleaseTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 5), server.acceptedCount());
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try std.testing.expectEqual(@as(f64, 5), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_read\""}));
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
    try server.check();
}

test "RPC producers Ethereum HTTP500 valid result is a physical success and cacheable like Source" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{ .{ .status = 500, .body = "" }, .{ .body = "" } }, .response_fn = echo }};
    var server = try fixture.Fixture.init(6, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "errors" });
    defer recorder.deinit();
    try recorder.configurePool(&.{url});
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .max_response_bytes = 4096 });
    defer owner.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}";
    var response = try owner.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    response = try owner.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_count", &.{"status=\"failure\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"status=\"success\""}));
    try server.check();
}

fn statusPoolExchange(context: *anyopaque, a: A, body: []const u8, options: @import("provider.zig").Options) anyerror!@import("provider.zig").WireResponse {
    const owner: *pool.Pool = @ptrCast(@alignCast(context));
    const response = try owner.fetch(a, body, options.timeout_ms, options.connect_timeout_ms, options.cancel, options.max_response_bytes);
    return .{ .bytes = response.bytes, .len = response.len };
}
const StatusTransport = enum { pool, native, standard };
test "RPC producers Ethereum HTTP500 OffchainLookup data survives Pool direct native and standard transport" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const encoded = try std.json.parseFromSlice(struct { chunks: []const []const u8 }, a, @embedFile("../relayer/testing/ccip-lookup.json"), .{ .ignore_unknown_fields = true });
    defer encoded.deinit();
    const data = try std.mem.concat(a, u8, encoded.value.chunks);
    defer a.free(data);
    const body = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = @as(u8, 1), .@"error" = .{ .code = @as(u8, 3), .message = "execution reverted", .data = data } }, .{});
    defer a.free(body);
    for ([_]StatusTransport{ .pool, .native, .standard }) |mode| {
        const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .status = 500, .body = body }} }};
        var server = try fixture.Fixture.init(1, &behavior);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
        defer registry.deinit();
        const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "offchain500", .protocol = .ethereum_json_rpc });
        defer recorder.deinit();
        try recorder.configurePool(&.{url});
        var native = try @import("../net/curl.zig").Client.init(a, library);
        defer native.deinit();
        native.observer = recorder.nativeObserver();
        const owner = if (mode == .pool) try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver() }) else null;
        defer if (owner) |o| o.deinit();
        var client = try @import("provider.zig").RpcClient.init(a, url, .{ .native_transport = if (mode == .native) &native else null, .exchange = if (owner) |o| .{ .context = o, .fetch_fn = statusPoolExchange } else null });
        defer client.deinit();
        var response = try client.callEnvelope("eth_call", .{});
        defer response.deinit();
        try std.testing.expect(response.isError());
        try std.testing.expectEqual(@as(?i64, 3), client.last_rpc_error_code);
        try std.testing.expectEqualStrings(data, response.errorData().?.string);
        const bytes = try a.alloc(u8, (data.len - 2) / 2);
        defer a.free(bytes);
        _ = try @import("codecs.zig").decodeHex(bytes, data);
        var lookup = try @import("../relayer/ccip.zig").decode(a, bytes);
        defer lookup.deinit();
        try std.testing.expectEqualSlices(u8, &@as([20]u8, @splat(3)), &lookup.sender);
        try std.testing.expectEqualStrings("https://ccs.example/lookup", lookup.urls[1]);
        try std.testing.expectEqualSlices(u8, &.{ 0xaa, 0xbb }, lookup.extra_data);
        try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
        if (mode != .standard) {
            const wire = try registry.render(a);
            defer a.free(wire);
            try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"status=\"failure\""}));
            try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_count", &.{"status=\"success\""}));
        }
        try server.check();
    }
}
test "RPC producers malformed HTTP500 and positive HTTP429 stay uncached for Pool and direct native" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const valid1 = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x25\"}";
    const valid2 = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x25\"}";
    const rejected = [_]fixture.Reply{ .{ .status = 500, .body = "<html>upstream unavailable</html>" }, .{ .status = 500, .body = "{\"jsonrpc\":\"2.0\",\"id\":1}" }, .{ .status = 500, .body = "{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":\"0x25\"}" }, .{ .status = 500, .body = "{\"jsonrpc\":\"2.0\",\"result\":\"0x25\"}" }, .{ .status = 429, .body = valid1 } };
    for ([_]StatusTransport{ .pool, .native }) |mode| for (rejected) |first| {
        const behavior = [_]fixture.Behavior{.{ .replies = &.{ first, .{ .body = if (mode == .pool) valid1 else valid2 } } }};
        var server = try fixture.Fixture.init(2, &behavior);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
        defer registry.deinit();
        const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "status", .protocol = .ethereum_json_rpc });
        defer recorder.deinit();
        try recorder.configurePool(&.{url});
        const cache = try cache_module.Cache.init(a, .{});
        defer cache.deinit();
        var native = try @import("../net/curl.zig").Client.init(a, library);
        defer native.deinit();
        native.observer = recorder.nativeObserver();
        var clock: Clock = .{};
        const owner = if (mode == .pool) try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .clock = .{ .context = &clock, .now_ms_fn = Clock.now } }) else null;
        defer if (owner) |o| o.deinit();
        var client = try @import("provider.zig").RpcClient.init(a, url, .{ .native_transport = &native, .indexer_tip_cache = true, .dynamic_tip_cache = cache, .native_cache_observer = recorder.nativeCacheObserver(), .exchange = if (owner) |o| .{ .context = o, .fetch_fn = statusPoolExchange } else null });
        defer client.deinit();
        // Pool exchange helper must preserve per-request cache opt-in too.
        if (owner) |o| {
            try std.testing.expectError(error.RpcPoolRetriesExhausted, o.fetchObservedCached(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096, null, true));
            clock.value.store(30000, .release);
            for (0..2) |_| {
                const response = try o.fetchObservedCached(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096, null, true);
                a.free(response.bytes);
            }
        } else {
            if (client.blockNumber()) |_| return error.AcceptedRejectedHttpResponse else |_| {}
            try std.testing.expectEqual(@as(u64, 37), try client.blockNumber());
            try std.testing.expectEqual(@as(u64, 37), try client.blockNumber());
        }
        try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
        const wire = try registry.render(a);
        defer a.free(wire);
        try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
        try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
        try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"status=\"failure\""}));
        try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"status=\"success\""}));
        try server.check();
    };
}
test "RPC producers direct native HTTP500 result is a physical semantic success and shared cache hit" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .status = 500, .body = "" }}, .response_fn = echo }};
    var server = try fixture.Fixture.init(1, &behavior);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "direct500", .protocol = .ethereum_json_rpc });
    defer recorder.deinit();
    try recorder.addEndpoints(&.{url});
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    var native = try @import("../net/curl.zig").Client.init(a, library);
    defer native.deinit();
    native.observer = recorder.nativeObserver();
    var client = try @import("provider.zig").RpcClient.init(a, url, .{ .native_transport = &native, .indexer_tip_cache = true, .dynamic_tip_cache = cache, .native_cache_observer = recorder.nativeCacheObserver() });
    defer client.deinit();
    for (0..2) |_| try std.testing.expectEqual(@as(u64, 37), try client.blockNumber());
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"status=\"success\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try server.check();
}

test "RPC producers Ethereum stalled HTTP429 body returns promptly through Pool direct native and standard paths" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]StatusTransport{ .pool, .native, .standard }) |mode| {
        const behavior = [_]fixture.Behavior{
            .{ .replies = &.{.{ .status = 429, .body = "", .stall_after_head = true, .informational_head = true, .advertised_bytes = 1024 * 1024 * 1024, .extra_response_headers = "Retry-After: 7\r\n" }} },
            .{ .replies = &.{.{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x25\"}" }} },
        };
        var server = try fixture.Fixture.init(if (mode == .pool) 2 else 1, &behavior);
        try server.start();
        defer server.deinit();
        const url0 = try server.url(a, 0);
        defer a.free(url0);
        const url1 = try server.url(a, 1);
        defer a.free(url1);
        const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
        defer registry.deinit();
        const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "stalled429", .protocol = .ethereum_json_rpc });
        defer recorder.deinit();
        try recorder.configurePool(&.{ url0, url1 });
        var audit: ProbeAudit = .{ .child = recorder.poolObserver() };
        const owner = if (mode == .pool) try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ url0, url1 }, .strategy = .{ .fallback = .{ .failed_request_threshold = 1 } }, .observer = .{ .context = &audit, .event_fn = ProbeAudit.record }, .max_response_bytes = 4096 }) else null;
        defer if (owner) |o| o.deinit();
        var native = try @import("../net/curl.zig").Client.init(a, library);
        defer native.deinit();
        native.observer = recorder.nativeObserver();
        var client = try @import("provider.zig").RpcClient.init(a, url0, .{ .native_transport = if (mode == .native) &native else null, .exchange = if (owner) |o| .{ .context = o, .fetch_fn = statusPoolExchange } else null, .timeout_ms = 5000, .max_response_bytes = 4096 });
        defer client.deinit();
        var timer = try std.time.Timer.start();
        if (mode == .pool) {
            try std.testing.expectEqual(@as(u64, 37), try client.chainId());
            try std.testing.expectEqual(@as(usize, 1), audit.demotions.load(.acquire));
            try std.testing.expectEqual(@as(usize, 1), server.pathHits(1));
        } else try std.testing.expectError(error.RpcRateLimited, client.chainId());
        try std.testing.expect(timer.read() < 1500 * std.time.ns_per_ms);
        if (mode != .standard) {
            const wire = try registry.render(a);
            defer a.free(wire);
            try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"status=\"failure\""}));
            try std.testing.expectEqual(if (mode == .pool) @as(f64, 1) else @as(f64, 0), try sum(wire, "hyperlane_request_count", &.{"status=\"success\""}));
        }
        try server.check();
    }
}
test "RPC producers native and Multi complete429 head preserve RetryAfter with zero body and release byte reservations" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]bool{ false, true }) |use_multi| {
        const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .status = 429, .body = "", .stall_after_head = true, .informational_head = true, .advertised_bytes = 1024 * 1024 * 1024, .extra_response_headers = "Retry-After: 7\r\n" }} }};
        var server = try fixture.Fixture.init(1, &behavior);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        const curl = @import("../net/curl.zig");
        const request: curl.Request = .{ .url = url, .method = .post, .body = "{}", .timeout_ms = 5000, .max_response_bytes = 16, .stop_after_http429_head = true };
        var native = try curl.Client.init(a, library);
        defer native.deinit();
        const multi = if (use_multi) try @import("../net/curl_multi.zig").Multi.init(a, .{ .library_path = library, .max_concurrent = 1, .max_pending = 1, .max_response_bytes = 16 }) else null;
        defer if (multi) |m| m.deinit();
        var timer = try std.time.Timer.start();
        var response = if (multi) |m| blk: {
            _ = try m.submit(request, 0);
            while (true) {
                if (try m.poll(timer.read() / std.time.ns_per_ms)) |completion| switch (completion.result) {
                    .response => |value| break :blk value,
                    .failure => |err| return err,
                };
                if (timer.read() > 1500 * std.time.ns_per_ms) return error.StalledRateLimitBody;
                std.Thread.sleep(std.time.ns_per_ms);
            }
        } else try native.send(a, request);
        defer response.deinit();
        try std.testing.expect(timer.read() < 1500 * std.time.ns_per_ms);
        try std.testing.expectEqual(@as(u16, 429), response.status);
        try std.testing.expectEqual(@as(usize, 0), response.body.len);
        var retry_after = false;
        for (response.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "retry-after")) {
            try std.testing.expectEqualStrings("7", header.value);
            retry_after = true;
        };
        try std.testing.expect(retry_after);
        if (multi) |m| try std.testing.expectEqual(@as(usize, 0), m.reserved_bytes);
        try server.check();
    }
}

test "RPC producers non-Ethereum Pool and direct protocols retain HTTP status rejection" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]pool.HeightProtocol{ .sealevel, .tendermint }) |protocol| for ([_]StatusTransport{ .pool, .native, .standard }) |mode| {
        const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .status = 500, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x25\"}" }} }};
        var server = try fixture.Fixture.init(1, &behavior);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        var native = try @import("../net/curl.zig").Client.init(a, library);
        defer native.deinit();
        const owner = if (mode == .pool) try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = protocol, .strategy = .{ .single = .{ .max_attempts = 1 } } }) else null;
        defer if (owner) |o| o.deinit();
        var client = try @import("provider.zig").RpcClient.init(a, url, .{ .protocol = protocol, .native_transport = if (mode == .native) &native else null, .exchange = if (owner) |o| .{ .context = o, .fetch_fn = statusPoolExchange } else null });
        defer client.deinit();
        if (mode == .pool) try std.testing.expectError(error.RpcPoolRetriesExhausted, client.chainId()) else try std.testing.expectError(error.RpcHttpStatus, client.chainId());
        try server.check();
    };
    var svm = try @import("../sealevel/provider.zig").Client.init(a, "http://127.0.0.1:1", .{});
    defer svm.deinit();
    try std.testing.expectEqual(pool.HeightProtocol.sealevel, svm.rpc_client.options.protocol);
}

test "RPC producers Ethereum wire decode provenance retries HTTP200 and503 malformed responses then caches only real recovery" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const malformed = [_][]const u8{ "fixture unavailable", "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":", "{\"jsonrpc\":\"2.0\",\"id\":1}" };
    for ([_]u16{ 200, 503 }) |status| for (malformed) |bad| for ([_]StatusTransport{ .native, .standard }) |mode| {
        const second_bad = if (std.mem.eql(u8, bad, "{\"jsonrpc\":\"2.0\",\"id\":1}")) "{\"jsonrpc\":\"2.0\",\"id\":2}" else bad;
        const behavior = [_]fixture.Behavior{.{ .replies = &.{ .{ .status = status, .body = bad }, .{ .status = status, .body = second_bad }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":\"0x25\"}" } } }};
        var server = try fixture.Fixture.init(3, &behavior);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        const registry = try metrics.Registry.init(a, .validator, .{ .base_version = "3.0.0" });
        defer registry.deinit();
        const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "decode", .protocol = .ethereum_json_rpc });
        defer recorder.deinit();
        try recorder.addEndpoints(&.{url});
        const cache = try cache_module.Cache.init(a, .{});
        defer cache.deinit();
        var native = try @import("../net/curl.zig").Client.init(a, library);
        defer native.deinit();
        native.observer = recorder.nativeObserver();
        var client = try @import("provider.zig").RpcClient.init(a, url, .{ .native_transport = if (mode == .native) &native else null, .indexer_tip_cache = true, .dynamic_tip_cache = cache, .native_cache_observer = recorder.nativeCacheObserver() });
        defer client.deinit();
        for (0..2) |_| {
            try std.testing.expectError(error.RpcResponseDecode, client.blockNumber());
            try std.testing.expect(client.last_rpc_error_code == null);
        }
        try std.testing.expect(@import("../runtime/indexing_observer.zig").retryable(error.RpcResponseDecode));
        try std.testing.expect(!@import("../runtime/indexing_observer.zig").retryable(error.SyntaxError));
        try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
        try std.testing.expectEqual(@as(u64, 37), try client.blockNumber());
        if (mode == .native) {
            try std.testing.expectEqual(@as(u64, 37), try client.blockNumber());
            const wire = try registry.render(a);
            defer a.free(wire);
            try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
            try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
        }
        try std.testing.expectEqual(@as(usize, 3), server.acceptedCount());
        try server.check();
    };
}
test "RPC producers Pool HTTP200 and503 malformed response falls back and cannot poison shared cache before recovery" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]u16{ 200, 503 }) |status| {
        const good = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x25\"}";
        const behavior = [_]fixture.Behavior{
            .{ .replies = &.{ .{ .status = status, .body = "fixture unavailable" }, .{ .status = status, .body = "{\"jsonrpc\":" }, .{ .body = good } } },
            .{ .replies = &.{.{ .body = good }} },
        };
        var server = try fixture.Fixture.init(4, &behavior);
        try server.start();
        defer server.deinit();
        const url0 = try server.url(a, 0);
        defer a.free(url0);
        const url1 = try server.url(a, 1);
        defer a.free(url1);
        const registry = try metrics.Registry.init(a, .validator, .{ .base_version = "3.0.0" });
        defer registry.deinit();
        const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "decode-pool", .protocol = .ethereum_json_rpc });
        defer recorder.deinit();
        try recorder.configurePool(&.{ url0, url1 });
        const cache = try cache_module.Cache.init(a, .{});
        defer cache.deinit();
        const fallback = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ url0, url1 }, .strategy = .{ .fallback = .{ .failed_request_threshold = 1 } }, .dynamic_tip_cache = cache, .observer = recorder.poolObserver() });
        defer fallback.deinit();
        const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}";
        const response = try fallback.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
        a.free(response.bytes);
        try std.testing.expectEqual(@as(usize, 1), server.pathHits(1));
        const isolated = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url0}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .dynamic_tip_cache = cache, .observer = recorder.poolObserver() });
        defer isolated.deinit();
        try std.testing.expectError(error.RpcPoolRetriesExhausted, isolated.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true));
        for (0..2) |_| {
            const recovered = try isolated.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
            defer a.free(recovered.bytes);
            try std.testing.expectEqualStrings(good, recovered.bytes);
        }
        try std.testing.expectEqual(@as(usize, 3), server.pathHits(0));
        const wire = try registry.render(a);
        defer a.free(wire);
        try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_count", &.{"status=\"failure\""}));
        try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_count", &.{"status=\"success\""}));
        try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
        try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
        try server.check();
    }
}

fn malformedResponse(a: A) !void {
    const rpc = @import("provider.zig");
    const Wire = struct {
        fn fetch(_: *anyopaque, allocator: A, _: []const u8, _: rpc.Options) anyerror!rpc.WireResponse {
            const body = try allocator.dupe(u8, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[");
            return .{ .bytes = body, .len = body.len };
        }
    };
    var context: u8 = 0;
    var client = try rpc.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &context, .fetch_fn = Wire.fetch } });
    defer client.deinit();
    var response = client.callEnvelope("eth_call", .{}) catch |err| {
        if (err == error.RpcResponseDecode) return;
        return err;
    };
    response.deinit();
    return error.AcceptedMalformedUpstream;
}
test "RPC producers malformed response classification never swallows allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, malformedResponse, .{});
}

const immutable_balance = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"0x1111111111111111111111111111111111111111\",{\"blockHash\":\"0x" ++ "11111111111111111111111111111111" ++ "11111111111111111111111111111111" ++ "\"}]}";
test "RPC producers native hedge wins cancel outstanding primary and export one nanosecond duration, source scoped labels" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "", .stall = true }} }, .{ .replies = &.{.{ .body = "" }}, .response_fn = echo } };
    var server = try fixture.Fixture.init(5, &behaviors);
    try server.start();
    defer server.deinit();
    const url0 = try server.url(a, 0);
    defer a.free(url0);
    const url1 = try server.url(a, 1);
    defer a.free(url1);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "hedge", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{ url0, url1 });
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ url0, url1 }, .strategy = .{ .fallback = .{ .hedge = .{ .delay_ms = 10, .attempt_timeout_ms = 500 } } }, .observer = recorder.poolObserver(), .max_response_bytes = 4096 });
    var alive = true;
    defer if (alive) owner.deinit();
    const response = try owner.fetch(a, immutable_balance, 2000, 1000, null, 4096);
    a.free(response.bytes);
    owner.deinit();
    alive = false;
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"start\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"cancellation\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"hedge_winner\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_duration_seconds_count", &.{"winner=\"hedge\""}));
    try std.testing.expect((try sum(wire, "hyperlane_fallback_hedge_duration_seconds_sum", &.{"winner=\"hedge\""})) > 0);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{}));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_provider_drop_count", &.{}));
    try server.check();
}

test "RPC producers direct native indexer clients share cache, bounded synchronous follower, and scoped fresh vote stays uncached" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = delayedEcho }};
    var server = try fixture.Fixture.init(6, &behavior);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "native-index", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.addEndpoints(&.{url});
    var native = try @import("../net/curl.zig").Client.init(a, library);
    defer native.deinit();
    native.observer = recorder.nativeObserver();
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const rpc = @import("provider.zig");
    const options: rpc.Options = .{ .native_transport = &native, .timeout_ms = 2000, .indexer_tip_cache = true, .dynamic_tip_cache = cache, .native_cache_observer = recorder.nativeCacheObserver() };
    var first = try rpc.RpcClient.init(a, url, options);
    defer first.deinit();
    var second = try rpc.RpcClient.init(a, url, options);
    defer second.deinit();
    const Worker = struct {
        client: *rpc.RpcClient,
        value: ?u64 = null,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            self.value = self.client.blockNumber() catch |err| {
                self.failure = err;
                return;
            };
        }
    };
    var workers = [_]Worker{ .{ .client = &first }, .{ .client = &second } };
    var threads: [2]std.Thread = undefined;
    for (&threads, &workers) |*thread, *worker| thread.* = try std.Thread.spawn(.{}, Worker.run, .{worker});
    for (threads) |thread| thread.join();
    for (workers) |worker| {
        if (worker.failure) |err| return err;
        try std.testing.expectEqual(@as(?u64, 37), worker.value);
    }
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    first.options.indexer_tip_cache = false;
    _ = try first.blockNumber();
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    first.options.indexer_tip_cache = true;
    _ = try first.blockNumber();
    try first.checkChain(37);
    try std.testing.expectEqual(@as(usize, 3), server.acceptedCount());
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 3), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"logical_read\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_read\""}));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try std.testing.expectEqual(@as(f64, 3), try sum(wire, "hyperlane_request_count", &.{}));
    try server.check();
}

test "RPC producers indexed fallback block-aging probe shares Source tip cache without fake physical completion" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "" }}, .response_fn = echo }, .{ .replies = &.{.{ .body = "" }}, .response_fn = echo } };
    var server = try fixture.Fixture.init(6, &behaviors);
    try server.start();
    defer server.deinit();
    const url0 = try server.url(a, 0);
    defer a.free(url0);
    const url1 = try server.url(a, 1);
    defer a.free(url1);
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "probe", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{ url0, url1 });
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    var clock: Clock = .{};
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ url0, url1 }, .strategy = .{ .fallback = .{ .max_block_time_ms = 1 } }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .clock = .{ .context = &clock, .now_ms_fn = Clock.now }, .max_response_bytes = 4096 });
    defer owner.deinit();
    clock.value.store(100, .release);
    const response = try owner.fetchObservedCached(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"logical_read\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{}));
    try server.check();
}

const ProbeAudit = struct {
    child: pool.Observer,
    previous: std.atomic.Value(u64) = .init(0),
    height: std.atomic.Value(u64) = .init(0),
    demotions: std.atomic.Value(usize) = .init(0),
    failures: std.atomic.Value(usize) = .init(0),
    fn record(context: *anyopaque, event: pool.Event) void {
        const self: *ProbeAudit = @ptrCast(@alignCast(context));
        if (event.endpoint_index == 0) {
            if (event.kind == .probe_succeeded) {
                self.previous.store(event.previous_block_height, .release);
                self.height.store(event.block_height, .release);
            }
            if (event.kind == .provider_deprioritized) _ = self.demotions.fetchAdd(1, .acq_rel);
            if (event.kind == .upstream_completed and event.operation == .block_number_probe and !event.success) _ = self.failures.fetchAdd(1, .acq_rel);
        }
        self.child.event_fn(self.child.context, event);
    }
};
test "RPC producers rate-limited aging probe retains old height resets Source clock and demotes without caching positive body" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const main = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x25\"}";
    const height100 = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x64\"}";
    const behavior = [_]fixture.Behavior{
        .{ .replies = &.{.{ .body = main }}, .probe_replies = &.{ .{ .status = 500, .body = height100 }, .{ .status = 429, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x65\"}", .stall_after_head = true, .advertised_bytes = 1024 * 1024 * 1024 }, .{ .body = height100 } } },
        .{ .replies = &.{.{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}" }}, .probe_replies = &.{.{ .body = height100 }} },
    };
    var server = try fixture.Fixture.init(8, &behavior);
    try server.start();
    defer server.deinit();
    const url0 = try server.url(a, 0);
    defer a.free(url0);
    const url1 = try server.url(a, 1);
    defer a.free(url1);
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "probe429", .operation = .contract_sync });
    defer recorder.deinit();
    try recorder.configurePool(&.{ url0, url1 });
    var audit: ProbeAudit = .{ .child = recorder.poolObserver() };
    var clock: Clock = .{};
    var cache_clock: Clock = .{};
    const cache = try cache_module.Cache.init(a, .{ .clock = .{ .context = &cache_clock, .now_fn = Clock.now } });
    defer cache.deinit();
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ url0, url1 }, .strategy = .{ .fallback = .{ .max_block_time_ms = 50 } }, .observer = .{ .context = &audit, .event_fn = ProbeAudit.record }, .dynamic_tip_cache = cache, .clock = .{ .context = &clock, .now_ms_fn = Clock.now }, .max_response_bytes = 4096 });
    defer owner.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}";
    for ([_]u64{ 100, 200 }) |now| {
        clock.value.store(now, .release);
        if (now == 200) cache_clock.value.store(250 * std.time.ns_per_ms, .release);
        const response = try owner.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
        defer a.free(response.bytes);
        try std.testing.expectEqualStrings(main, response.bytes);
    }
    try std.testing.expectEqual(@as(u64, 100), audit.previous.load(.acquire));
    try std.testing.expectEqual(@as(u64, 100), audit.height.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), audit.demotions.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), audit.failures.load(.acquire));
    // Endpoint1 is now preferred. Its main failure falls back to endpoint0;
    // Source's rejected-probe clock reset prevents another endpoint0 probe.
    clock.value.store(201, .release);
    const response = try owner.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(1));
    try std.testing.expectEqual(@as(usize, 3), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 2), server.probeHits(0));
    // An isolated caller for endpoint0 must go upstream: the rejected 0x65
    // cannot have populated the role's shared endpoint cache.
    const verify = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url0}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .dynamic_tip_cache = cache, .max_response_bytes = 4096 });
    defer verify.deinit();
    const fresh = try verify.fetchObservedCached(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}", 2000, 1000, null, 4096, null, true);
    defer a.free(fresh.bytes);
    try std.testing.expectEqualStrings(height100, fresh.bytes);
    try std.testing.expectEqual(@as(usize, 3), server.probeHits(0));
    try std.testing.expectEqual(@as(usize, 8), server.acceptedCount());
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{ "method=\"eth_blockNumber\"", "status=\"failure\"" }));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_count", &.{ "method=\"eth_blockNumber\"", "status=\"success\"" }));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try server.check();
}

fn indexAndHealthReply(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    const method = parsed.value.object.get("method").?.string;
    if (std.mem.eql(u8, method, "eth_getBlockByNumber")) return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = .{ .number = "0x25", .hash = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000001", .parentHash = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000000", .timestamp = "0x1" } }, .{});
    return echo(a, body);
}
test "RPC producers cooperative indexer PIO counts logical section once while health fork forces uncached startup reads" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = indexAndHealthReply }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const resources = @import("../agents/chain_source.zig");
    var chain = @import("../agents/chain_source_testing.zig").chainFor(&.{url});
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var budget: resources.ReadReplay.ByteBudget = .{ .maximum = 1024 * 1024 };
    const options: resources.Options = .{ .curl_library = library, .metrics = registry, .operation = .contract_sync, .indexer_tip_cache = true, .dynamic_tip_cache = cache, .cooperative_reads = true, .read_budget = &budget, .rpc_max_response_bytes = 4096 };
    const owner = try resources.Resources.open(a, &chain, &env, options);
    defer owner.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var timer = try std.time.Timer.start();
    var resumes: usize = 0;
    for (0..2) |_| while (true) {
        try owner.beginReadPass(&cancel);
        const height = owner.clients.ethereum.blockNumber() catch |err| {
            owner.endReadPass(err);
            if (err != error.PendingReadIo) return err;
            resumes += 1;
            if (timer.read() > 3 * std.time.ns_per_s) return error.IndexerPioTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        try std.testing.expectEqual(@as(u64, 37), height);
        try owner.commitReadSection();
        owner.endReadPass(null);
        break;
    };
    try std.testing.expect(resumes >= 2);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    var health_options = options;
    health_options.borrowed_rpc_pool = owner.rpc_pool;
    const health = try @import("../agents/health_provider.zig").Adapter.openFromSettings(a, &chain, &env, health_options);
    defer health.deinit();
    try std.testing.expect(!health.owner.options.indexer_tip_cache);
    const common = @import("../agents/health_metrics.zig");
    const task = try common.CommonMonitorTask.open(a, registry, health.interface(), .{ .chain = chain.name, .agent_name = "relayer", .native_decimals = 18 });
    defer task.deinit();
    var completed: usize = 0;
    while (completed < 2) {
        const report = task.step(0, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthPioTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        completed += @intCast(report.work);
    }
    try std.testing.expectEqual(@as(usize, 3), server.acceptedCount());
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"logical_read\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_count", &.{"operation=\"contract_sync\""}));
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, "hyperlane_request_count", &.{"operation=\"agent_metrics\""}));
    try server.check();
}

test "RPC producers hedge primary timeout records timeout and primary winner; caller cancellation has no completed hedge metric" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "", .stall = true }} }, .{ .replies = &.{.{ .body = "" }}, .response_fn = echo } };
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url0 = try server.url(a, 0);
    defer a.free(url0);
    const url1 = try server.url(a, 1);
    defer a.free(url1);
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "timeout" });
    defer recorder.deinit();
    try recorder.configurePool(&.{ url0, url1 });
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ url0, url1 }, .strategy = .{ .fallback = .{ .hedge = .{ .delay_ms = 100, .attempt_timeout_ms = 20 } } }, .observer = recorder.poolObserver(), .max_response_bytes = 4096 });
    var alive = true;
    defer if (alive) owner.deinit();
    const response = try owner.fetch(a, immutable_balance, 2000, 1000, null, 4096);
    a.free(response.bytes);
    var wire = try registry.render(a);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"timeout\""}));
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"primary_winner\""}));
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"start\""}));
    a.free(wire);
    // A separate single-endpoint owner stays stalled and is canceled by caller.
    const cancelled = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url0}, .strategy = .{ .fallback = .{ .hedge = .{ .delay_ms = 100, .attempt_timeout_ms = 1000 } } }, .observer = recorder.poolObserver(), .max_response_bytes = 4096 });
    var cancel_alive = true;
    defer if (cancel_alive) cancelled.deinit();
    const handle = try cancelled.submit(immutable_balance, 2000, 1000, 4096);
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() < 3) {
        if (timer.read() > std.time.ns_per_s) return error.CancelStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    cancelled.cancel(handle);
    cancelled.deinit();
    cancel_alive = false;
    owner.deinit();
    alive = false;
    wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_fallback_hedge_duration_seconds_count", &.{}));
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_fallback_hedge_events_total", &.{"event=\"cancellation\""}));
    try std.testing.expectEqual(@as(f64, 3), try sum(wire, "hyperlane_provider_drop_count", &.{}));
    try server.check();
}

fn nullReply(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = @as(?u8, null) }, .{});
}
test "RPC producers invalid numeric node stays uncached, healthy fallback succeeds, and quorum denominator never shrinks" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "" }}, .response_fn = nullReply }, .{ .replies = &.{.{ .body = "" }}, .response_fn = echo }, .{ .replies = &.{.{ .body = "" }}, .response_fn = echo }, .{ .replies = &.{.{ .body = "" }}, .response_fn = nullReply }, .{ .replies = &.{.{ .body = "" }}, .response_fn = nullReply } };
    var server = try fixture.Fixture.init(24, &behaviors);
    try server.start();
    defer server.deinit();
    var urls: [5][]const u8 = undefined;
    var count: usize = 0;
    defer for (urls[0..count]) |url| a.free(url);
    for (&urls, 0..) |*url, index| {
        url.* = try server.url(a, index);
        count += 1;
    }
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "invalid" });
    defer recorder.deinit();
    try recorder.configurePool(urls[0..2]);
    const fallback = try pool.Pool.start(a, .{ .library_path = library, .urls = urls[0..2], .strategy = .{ .fallback = .{} }, .observer = recorder.poolObserver(), .dynamic_tip_cache = cache, .max_response_bytes = 4096 });
    defer fallback.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}";
    var response = try fallback.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    const first = try pool.Pool.start(a, .{ .library_path = library, .urls = urls[0..3], .strategy = .{ .quorum = .{ .max_attempts = 1, .retry_delay_ms = 1 } }, .dynamic_tip_cache = cache, .max_response_bytes = 4096 });
    defer first.deinit();
    try std.testing.expectEqual(@as(usize, 3), first.endpointCount());
    try std.testing.expectEqual(@as(usize, 2), first.threshold);
    response = try first.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    const second = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{ urls[3], urls[4], urls[1] }, .strategy = .{ .quorum = .{ .max_attempts = 1, .retry_delay_ms = 1 } }, .dynamic_tip_cache = cache, .max_response_bytes = 4096 });
    defer second.deinit();
    try std.testing.expectEqual(@as(usize, 3), second.endpointCount());
    try std.testing.expectEqual(@as(usize, 2), second.threshold);
    try std.testing.expectError(error.NoQuorumReached, second.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true));
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 1), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"upstream_error\""}));
    try std.testing.expectEqual(@as(f64, 0), try sum(wire, "hyperlane_request_cache_count", &.{"result=\"cache_hit\""}));
    try server.check();
}

test "RPC producers direct native tip follower has absolute timeout and pre-cancel check without issuing HTTP" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var native = try @import("../net/curl.zig").Client.init(a, library);
    defer native.deinit();
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const rpc = @import("provider.zig");
    var client = try rpc.RpcClient.init(a, "http://127.0.0.1:1", .{ .native_transport = &native, .timeout_ms = 20, .indexer_tip_cache = true, .dynamic_tip_cache = cache });
    defer client.deinit();
    const key = (try cache_module.key(a, client.endpoint.identity, "eth_blockNumber", .null)).?;
    const leader = (try cache.claim(a, key)).leader;
    defer cache.finish(leader, null);
    try std.testing.expectError(error.RequestDeadlineExceeded, client.blockNumber());
    var cancel = std.atomic.Value(bool).init(true);
    client.options.cancel = &cancel;
    try std.testing.expectError(error.RequestCancelled, client.blockNumber());
    try std.testing.expect((try cache.follow(a, leader)) == .pending);
}

fn tagReply(a: A, body: []const u8) ![]u8 {
    var request = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer request.deinit();
    const object = request.value.object;
    const tag = object.get("params").?.array.items[0].string;
    if (std.mem.eql(u8, tag, "safe")) return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = object.get("id").?, .result = @as(?u8, null) }, .{});
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = object.get("id").?, .result = .{ .number = "0x25", .hash = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000001", .parentHash = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000000", .timestamp = "0x1", .exact = std.json.Value{ .number_string = "9007199254740993" } } }, .{});
}
test "RPC producers nullable dynamic blocks retain exact numbers and IDs; full params and pinned selectors stay isolated" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = tagReply }};
    var server = try fixture.Fixture.init(12, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const cache = try cache_module.Cache.init(a, .{});
    defer cache.deinit();
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .dynamic_tip_cache = cache, .max_response_bytes = 4096 });
    defer owner.deinit();
    const tags = [_]struct { tag: []const u8, full: bool, physical: usize }{ .{ .tag = "safe", .full = false, .physical = 1 }, .{ .tag = "safe", .full = false, .physical = 1 }, .{ .tag = "latest", .full = false, .physical = 2 }, .{ .tag = "latest", .full = false, .physical = 2 }, .{ .tag = "finalized", .full = false, .physical = 3 }, .{ .tag = "0x25", .full = false, .physical = 4 }, .{ .tag = "0x25", .full = false, .physical = 5 }, .{ .tag = "latest", .full = true, .physical = 6 }, .{ .tag = "latest", .full = true, .physical = 6 } };
    for (tags, 1..) |entry, id| {
        const body = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .method = "eth_getBlockByNumber", .params = .{ entry.tag, entry.full } }, .{});
        defer a.free(body);
        const response = try owner.fetchObservedCached(a, body, 2000, 1000, null, 4096, null, true);
        defer a.free(response.bytes);
        try @import("../net/read_replay.zig").validateResponse(a, response.bytes, @intCast(id));
        if (!std.mem.eql(u8, entry.tag, "safe")) try std.testing.expect(std.mem.indexOf(u8, response.bytes, "9007199254740993") != null);
        try std.testing.expectEqual(entry.physical, server.acceptedCount());
    }
    try server.check();
}

test "RPC producers failed provider constructor emits no invented create or drop" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const recorder = try rpc_metrics.Recorder.init(a, registry, .{ .chain = "failed" });
    defer recorder.deinit();
    try std.testing.expectError(error.SingleRpcEndpointRequired, pool.Pool.start(a, .{ .library_path = "not-loaded", .urls = &.{ "https://one.invalid", "https://two.invalid" }, .strategy = .{ .single = .{} }, .observer = recorder.poolObserver() }));
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expect(std.mem.indexOf(u8, wire, "hyperlane_provider_create_count{") == null);
    try std.testing.expect(std.mem.indexOf(u8, wire, "hyperlane_provider_drop_count{") == null);
    try std.testing.expectEqual(@as(u64, 0), recorder.failures.load(.acquire));
}
