//! Real sockets and the production header boundary, without chain credentials.
const std = @import("std");
const dto = @import("header.zig");
const pool = @import("pool.zig");
const fixture = @import("pool_testing.zig");
const provider = @import("provider.zig");
const curl = @import("../net/curl.zig");
const cache_module = @import("../net/dynamic_tip_cache.zig");
const a = std.testing.allocator;
const hash = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000001";
const parent = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000000";
const valid = "{\"number\":\"0x25\",\"hash\":\"" ++ hash ++ "\",\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\"}";
const bad_hash = "{\"number\":\"0x25\",\"hash\":\"0xzz\",\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\"}";
const bad_parent = "{\"number\":\"0x25\",\"hash\":\"" ++ hash ++ "\",\"parentHash\":\"0xzz\",\"timestamp\":\"0x1\"}";
const bad_time = "{\"number\":\"0x25\",\"hash\":\"" ++ hash ++ "\",\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x01\"}";
const bad_gas = "{\"number\":\"0x25\",\"hash\":\"" ++ hash ++ "\",\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\",\"gasLimit\":\"0xzz\"}";
const bad_fee = "{\"number\":\"0x25\",\"hash\":\"" ++ hash ++ "\",\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\",\"baseFeePerGas\":\"0x01\"}";
fn envelope(comptime result: []const u8) []const u8 {
    return "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" ++ result ++ "}";
}
const request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}";
const numeric_request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"0x25\",false]}";
const hash_request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByHash\",\"params\":[\"" ++ hash ++ "\",false]}";
const Clock = struct {
    ns: std.atomic.Value(u64) = .init(0),
    fn now(ctx: *anyopaque) u64 {
        const self: *Clock = @ptrCast(@alignCast(ctx));
        return self.ns.load(.acquire);
    }
};

test "typed header DTO validates four fields preserves pending null and ignores extra raw fields" {
    for ([_][]const u8{ "latest", "safe", "finalized", "earliest", "0x25" }) |tag| {
        const params_wire = try std.fmt.allocPrint(a, "[\"{s}\",false]", .{tag});
        defer a.free(params_wire);
        var params = try std.json.parseFromSlice(std.json.Value, a, params_wire, .{});
        defer params.deinit();
        inline for (.{ valid, bad_hash, bad_parent, bad_time, bad_gas, bad_fee, "{}", "[]", "{\"number\":\"0x25\"}" }) |raw| {
            var value = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
            defer value.deinit();
            if (std.mem.eql(u8, raw, valid)) {
                try dto.validateResult("eth_getBlockByNumber", params.value, value.value);
                try std.testing.expectEqual(@as(u64, 37), (try dto.Header.parse(value.value)).number);
            } else try std.testing.expectError(error.RpcResponseDecode, dto.validateResult("eth_getBlockByNumber", params.value, value.value));
        }
        try dto.validateResult("eth_getBlockByNumber", params.value, .null);
        try std.testing.expectError(error.MissingBlock, dto.Header.parse(.null));
    }
    var params = try std.json.parseFromSlice(std.json.Value, a, "[\"pending\",true]", .{});
    defer params.deinit();
    var pending = try std.json.parseFromSlice(std.json.Value, a, "{\"number\":null,\"hash\":null,\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\",\"transactions\":[{\"unparsed\":9007199254740993}]}", .{});
    defer pending.deinit();
    try dto.validateResult("eth_getBlockByNumber", params.value, pending.value);
    try std.testing.expectError(error.RpcResponseDecode, dto.validateResult("eth_getBlockByHash", params.value, pending.value));
    try dto.validateResult("eth_call", params.value, pending.value); // Other RPCs unchanged.
    var malformed = try std.json.parseFromSlice(std.json.Value, a, bad_hash, .{});
    defer malformed.deinit();
    try std.testing.expectError(error.InvalidHex, dto.Header.parse(malformed.value)); // No global ABI reclassification.
    var legacy_fee = try std.json.parseFromSlice(std.json.Value, a, "{\"number\":\"0x25\",\"hash\":\"" ++ hash ++ "\",\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\",\"gasLimit\":\"0x1\",\"baseFeePerGas\":null}", .{});
    defer legacy_fee.deinit();
    _ = try dto.Header.parse(legacy_fee.value);
}

test "typed header native Pool retries malformed preferred before vote and numeric dynamic selection" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    inline for (.{ bad_hash, bad_parent, bad_time, bad_gas, bad_fee }) |bad| {
        for ([_][]const u8{ request, numeric_request, hash_request }) |body| {
            const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = envelope(bad) }} }, .{ .replies = &.{.{ .body = envelope(valid), .status = 500 }} } };
            var server = try fixture.Fixture.init(2, &behaviors);
            try server.start();
            defer server.deinit();
            const first = try server.url(a, 0);
            defer a.free(first);
            const second = try server.url(a, 1);
            defer a.free(second);
            const owner = try pool.Pool.start(a, fixture.config(library, &.{ first, second }, .{ .fallback = .{ .retry_delay_ms = 1 } }));
            defer owner.deinit();
            const response = try owner.fetch(a, body, 2000, 1000, null, 4096);
            defer a.free(response.bytes);
            try std.testing.expectEqualStrings(envelope(valid), response.bytes);
            try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
            try std.testing.expectEqual(@as(usize, 1), server.pathHits(1));
            try server.check();
        }
    }
    // Malformed peers cannot create a majority, even when identical.
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = envelope(bad_hash) }} }, .{ .replies = &.{.{ .body = envelope(bad_hash) }} }, .{ .replies = &.{.{ .body = envelope(valid) }} } };
    var server = try fixture.Fixture.init(3, &behaviors);
    try server.start();
    defer server.deinit();
    var urls: [3][]const u8 = undefined;
    for (&urls, 0..) |*url, i| url.* = try server.url(a, i);
    defer for (urls) |url| a.free(url);
    const owner = try pool.Pool.start(a, fixture.config(library, &urls, .{ .quorum = .{ .threshold = 2, .max_attempts = 1 } }));
    defer owner.deinit();
    try std.testing.expectError(error.NoQuorumReached, owner.fetch(a, numeric_request, 2000, 1000, null, 4096));
}

test "typed header direct native cache rejects poison recovers immediately expires and honors cancel" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const replies = [_]fixture.Reply{ .{ .body = envelope(bad_hash) }, .{ .body = envelope(valid), .status = 500 }, .{ .body = envelope(bad_parent) }, .{ .body = envelope(valid) } };
    var server = try fixture.Fixture.init(4, &.{.{ .replies = &replies }});
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var native = try curl.Client.init(a, library);
    defer native.deinit();
    var clock: Clock = .{};
    const cache = try cache_module.Cache.init(a, .{ .clock = .{ .context = &clock, .now_fn = Clock.now } });
    defer cache.deinit();
    var cancel: std.atomic.Value(bool) = .init(false);
    var client = try provider.RpcClient.init(a, url, .{ .native_transport = &native, .indexer_tip_cache = true, .dynamic_tip_cache = cache, .cancel = &cancel });
    defer client.deinit();
    try std.testing.expectError(error.RpcResponseDecode, client.blockHeader(.latest));
    client.next_id = 1;
    try std.testing.expectEqual(@as(u64, 37), (try client.blockHeader(.latest)).number);
    client.next_id = 1;
    _ = try client.blockHeader(.latest);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    clock.ns.store(250 * std.time.ns_per_ms, .release);
    client.next_id = 1;
    try std.testing.expectError(error.RpcResponseDecode, client.blockHeader(.latest));
    client.next_id = 1;
    _ = try client.blockHeader(.latest);
    try std.testing.expectEqual(@as(usize, 4), server.acceptedCount());
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, client.blockHeader(.latest));
    try std.testing.expectEqual(@as(usize, 4), server.acceptedCount());
    try server.check();
}

const Events = struct {
    mutex: std.Thread.Mutex = .{},
    success: usize = 0,
    failure: usize = 0,
    hit: usize = 0,
    fn observe(ctx: *anyopaque, event: pool.Event) void {
        const self: *Events = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (event.kind == .upstream_completed) {
            if (event.success) self.success += 1 else self.failure += 1;
        }
        if (event.kind == .cache_hit) self.hit += 1;
    }
};
test "typed header Pool cache excludes malformed DTO physical success and recovers after TTL" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const replies = [_]fixture.Reply{ .{ .body = envelope(bad_hash) }, .{ .body = envelope(valid), .status = 500 }, .{ .body = envelope(bad_time) }, .{ .body = envelope(valid) } };
    var server = try fixture.Fixture.init(4, &.{.{ .replies = &replies }});
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var clock: Clock = .{};
    const cache = try cache_module.Cache.init(a, .{ .clock = .{ .context = &clock, .now_fn = Clock.now } });
    defer cache.deinit();
    var events: Events = .{};
    var config = fixture.config(library, &.{url}, .{ .single = .{ .max_attempts = 1 } });
    config.dynamic_tip_cache = cache;
    config.observer = .{ .context = &events, .event_fn = Events.observe };
    const owner = try pool.Pool.start(a, config);
    defer owner.deinit();
    try std.testing.expectError(error.RpcPoolRetriesExhausted, owner.fetchObservedCached(a, request, 2000, 1000, null, 4096, null, true));
    var response = try owner.fetchObservedCached(a, request, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    response = try owner.fetchObservedCached(a, request, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    clock.ns.store(250 * std.time.ns_per_ms, .release);
    try std.testing.expectError(error.RpcPoolRetriesExhausted, owner.fetchObservedCached(a, request, 2000, 1000, null, 4096, null, true));
    response = try owner.fetchObservedCached(a, request, 2000, 1000, null, 4096, null, true);
    a.free(response.bytes);
    events.mutex.lock();
    defer events.mutex.unlock();
    try std.testing.expectEqual(@as(usize, 2), events.success);
    try std.testing.expectEqual(@as(usize, 2), events.failure);
    try std.testing.expectEqual(@as(usize, 1), events.hit);
    try std.testing.expectEqual(@as(usize, 4), server.acceptedCount());
}

test "typed header standard HTTP rejects each malformed DTO and accepts valid HTTP500 header" {
    const replies = [_]fixture.Reply{ .{ .body = envelope(bad_hash) }, .{ .body = envelope(bad_parent) }, .{ .body = envelope(bad_time) }, .{ .body = envelope(bad_gas) }, .{ .body = envelope(bad_fee) }, .{ .body = envelope(valid), .status = 500 } };
    var server = try fixture.Fixture.init(6, &.{.{ .replies = &replies }});
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var client = try provider.RpcClient.init(a, url, .{});
    defer client.deinit();
    for (0..5) |_| {
        client.next_id = 1;
        try std.testing.expectError(error.RpcResponseDecode, client.blockHeader(.{ .number = 37 }));
    }
    client.next_id = 1;
    try std.testing.expectEqual(@as(u64, 37), (try client.blockHeader(.{ .number = 37 })).number);
    try server.check();
}

test "typed header Pool pending nullable identity and unknown null remain valid uncached reads" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const pending = "{\"number\":null,\"hash\":null,\"parentHash\":\"" ++ parent ++ "\",\"timestamp\":\"0x1\"}";
    const replies = [_]fixture.Reply{ .{ .body = envelope(pending) }, .{ .body = envelope("null") } };
    var server = try fixture.Fixture.init(2, &.{.{ .replies = &replies }});
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try pool.Pool.start(a, fixture.config(library, &.{url}, .{ .single = .{ .max_attempts = 1 } }));
    defer owner.deinit();
    const response = try owner.fetch(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"pending\",true]}", 2000, 1000, null, 4096);
    defer a.free(response.bytes);
    try std.testing.expectEqualStrings(envelope(pending), response.bytes);
    const absent = try owner.fetch(a, request, 2000, 1000, null, 4096);
    defer a.free(absent.bytes);
    try std.testing.expectEqualStrings(envelope("null"), absent.bytes);
}

const Exchange = struct {
    fn fetch(_: *anyopaque, allocator: std.mem.Allocator, _: []const u8, _: provider.Options) !provider.WireResponse {
        const bytes = try allocator.dupe(u8, envelope(valid));
        return .{ .bytes = bytes, .len = bytes.len };
    }
};
fn allocate(allocator: std.mem.Allocator) !void {
    var context: u8 = 0;
    var client = try provider.RpcClient.init(allocator, "http://fixture.invalid", .{ .exchange = .{ .context = &context, .fetch_fn = Exchange.fetch } });
    defer client.deinit();
    try std.testing.expectEqual(@as(u64, 37), (try client.blockHeader(.{ .number = 37 })).number);
}
test "typed header boundary allocation failures preserve OOM and release parsed request response" {
    try std.testing.checkAllAllocationFailures(a, allocate, .{});
}
