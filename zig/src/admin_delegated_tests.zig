const std = @import("std");
const builtin = @import("builtin");
const http = @import("ops/http.zig");
const api = @import("ops/admin/api.zig");
const query = @import("ops/admin/query.zig");
const testing = @import("ops/admin/testing.zig");
const relay_policy = @import("agents/relay_policy.zig");
const denylist = @import("ops/runtime_denylist.zig");
const relay_api = @import("ops/admin/relay_api.zig");
const metrics = @import("ops/metrics.zig");
const native_tests = if (builtin.link_libcpp) @import("ops/admin/native_test.zig") else struct {};

test {
    if (builtin.link_libcpp) {
        _ = native_tests;
    } else {
        _ = @import("ops/admin/root.zig");
        _ = @import("ops/admin/testing.zig");
    }
}

const Fixture = struct {
    context: *testing.FixtureContext,
    policy: relay_policy.Policy,
    list: denylist.RuntimeDenylist,
    state: api.Admin,
};

const ClockFixture = struct {
    mono_ns: std.atomic.Value(u64) = .init(1),
    unix: std.atomic.Value(i64) = .init(1),
};

fn monotonic(context: *anyopaque) u64 {
    const clock: *ClockFixture = @ptrCast(@alignCast(context));
    return clock.mono_ns.load(.acquire);
}

fn unixSeconds(context: *anyopaque) i64 {
    const clock: *ClockFixture = @ptrCast(@alignCast(context));
    return clock.unix.load(.acquire);
}

fn submitSuccess(_: *anyopaque, a: std.mem.Allocator, _: []const u8, _: []const u8, _: *const std.atomic.Value(bool)) anyerror!relay_api.RelayResult {
    const messages = try a.alloc(relay_api.RelayMessage, 1);
    messages[0] = .{ .message_id = @splat(0xab), .origin = 1, .destination = 2, .nonce = 3 };
    return .{ .messages = messages, .processor_admission_seconds = 0.001 };
}

fn setup(a: std.mem.Allocator) !*Fixture {
    const context = try a.create(testing.FixtureContext);
    errdefer a.destroy(context);
    const fixture = try a.create(Fixture);
    errdefer a.destroy(fixture);
    fixture.* = .{ .context = context, .policy = undefined, .list = undefined, .state = undefined };
    fixture.list = try denylist.RuntimeDenylist.init(a, null);
    errdefer fixture.list.deinit();
    fixture.policy = try relay_policy.Policy.init(a, .{}, null, &fixture.list);
    fixture.state = testing.admin(context, &fixture.policy, &fixture.list, .{ .context = context, .now_unix = now });
    return fixture;
}

fn teardown(fixture: *Fixture) void {
    fixture.policy.deinit();
    fixture.list.deinit();
    std.testing.allocator.destroy(fixture.context);
}

fn now(context: *anyopaque) i64 {
    _ = context;
    return 7;
}

fn call(state: *api.Admin, a: std.mem.Allocator, method: []const u8, target: []const u8, body: []const u8) !http.Response {
    var request = try testing.TestRequest.init(a, method, target, body);
    defer request.deinit();
    try std.testing.expectEqualStrings(method, request.value.method);
    try std.testing.expectEqualStrings(target, request.value.target);
    const query_start = std.mem.indexOfScalar(u8, target, '?');
    try std.testing.expectEqualStrings(if (query_start) |index| target[0..index] else target, request.value.path);
    if (query_start) |index| try std.testing.expectEqualStrings(target[index + 1 ..], request.value.query.?);
    var cancelled = std.atomic.Value(bool).init(false);
    const handler = state.handler();
    return handler.handle_fn(handler.context, a, request.value, &cancelled);
}

test "admin routes preserve source status bodies and method behavior" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixture = try setup(std.testing.allocator);
    defer {
        teardown(fixture);
        std.testing.allocator.destroy(fixture);
    }
    var direct = try query.parse(a, "domain_id=1&nonce_start=9&nonce_end=10");
    defer direct.deinit();

    var listed = try call(&fixture.state, a, "GET", "/messages?domain_id=1&nonce_start=9&nonce_end=10", "");
    defer listed.deinit();
    try std.testing.expectEqual(@as(u16, 200), listed.status);
    try std.testing.expect(std.mem.startsWith(u8, listed.body, "{\"messages\":[{\"message_id\":\""));

    var bad_range = try call(&fixture.state, a, "GET", "/messages?domain_id=1&nonce_start=10&nonce_end=9", "");
    defer bad_range.deinit();
    try std.testing.expectEqual(@as(u16, 400), bad_range.status);

    var missing_db = try call(&fixture.state, a, "GET", "/messages?domain_id=9&nonce_start=1&nonce_end=2", "");
    defer missing_db.deinit();
    try std.testing.expectEqual(@as(u16, 404), missing_db.status);
    try std.testing.expectEqualStrings("{\"message\":\"No db found for chain\"}", missing_db.body);

    var method = try call(&fixture.state, a, "PUT", "/messages", "");
    defer method.deinit();
    try std.testing.expectEqual(@as(u16, 405), method.status);

    var unknown = try call(&fixture.state, a, "GET", "/not-a-route", "");
    defer unknown.deinit();
    try std.testing.expectEqual(@as(u16, 404), unknown.status);

    var malformed = try call(&fixture.state, a, "POST", "/messages", "{\"messages\":");
    defer malformed.deinit();
    try std.testing.expectEqual(@as(u16, 400), malformed.status);

    var wrong_type = try call(&fixture.state, a, "POST", "/messages", "{\"messages\":{}}");
    defer wrong_type.deinit();
    try std.testing.expectEqual(@as(u16, 422), wrong_type.status);

    var no_type_request = try testing.TestRequest.init(a, "POST", "/messages", "{\"messages\":[]}");
    defer no_type_request.deinit();
    no_type_request.headers[1].name = "X-Ignored";
    var cancelled = std.atomic.Value(bool).init(false);
    const no_type_handler = fixture.state.handler();
    var no_type = try no_type_handler.handle_fn(no_type_handler.context, a, no_type_request.value, &cancelled);
    defer no_type.deinit();
    try std.testing.expectEqual(@as(u16, 415), no_type.status);

    var summary = try call(&fixture.state, a, "GET", "/runtime_denylist", "");
    defer summary.deinit();
    try std.testing.expectEqual(@as(u16, 200), summary.status);
    try std.testing.expectEqualStrings("{\"version\":0,\"messageRules\":0,\"addressRules\":0}", summary.body);

    var refresh = try call(&fixture.state, a, "POST", "/runtime_denylist/refresh", "");
    defer refresh.deinit();
    try std.testing.expectEqual(@as(u16, 502), refresh.status);
    try std.testing.expectEqualStrings("Runtime denylist refresh failed; see relayer logs", refresh.body);

    var operations = try call(&fixture.state, a, "GET", "/list_operations?destination_domain=1", "");
    defer operations.deinit();
    try std.testing.expectEqual(@as(u16, 200), operations.status);
    try std.testing.expect(std.mem.indexOf(u8, operations.body, "\"retry_count\":0") != null);

    var retry = try call(&fixture.state, a, "POST", "/message_retry", "[{\"originDomain\":1}]");
    defer retry.deinit();
    try std.testing.expectEqual(@as(u16, 200), retry.status);
    try std.testing.expect(std.mem.indexOf(u8, retry.body, "\"evaluated\":3,\"matched\":2}") != null);

    const message_id = testing.fixture_message.id();
    var id_text: [66]u8 = undefined;
    _ = try std.fmt.bufPrint(&id_text, "0x{x}", .{&message_id});
    const reprocess_body = try std.fmt.allocPrint(a, "{{\"origin_id\":1,\"message_id\":\"{s}\"}}", .{id_text});
    var reprocess = try call(&fixture.state, a, "POST", "/reprocess_message", reprocess_body);
    defer reprocess.deinit();
    try std.testing.expectEqual(@as(u16, 200), reprocess.status);
    try std.testing.expectEqualStrings("{\"pending_message\":\"PendingMessage { fixture }\"}", reprocess.body);

    var add_rule = try call(&fixture.state, a, "POST", "/igp_rules", "{\"policy\":\"None\",\"matching_list\":[]}");
    defer add_rule.deinit();
    try std.testing.expectEqual(@as(u16, 200), add_rule.status);
    var rules = try call(&fixture.state, a, "GET", "/igp_rules", "");
    defer rules.deinit();
    try std.testing.expectEqual(@as(u16, 200), rules.status);
    try std.testing.expectEqualStrings("{\"policies\":{\"ethereum\":[{\"policy\":\"None\",\"matching_list\":[]}]}}", rules.body);
    var remove_rule = try call(&fixture.state, a, "DELETE", "/igp_rules/0", "");
    defer remove_rule.deinit();
    try std.testing.expectEqual(@as(u16, 200), remove_rule.status);

    var insertions = try call(&fixture.state, a, "GET", "/merkle_tree_insertions?domain_id=1&leaf_index_start=0&leaf_index_end=1", "");
    defer insertions.deinit();
    try std.testing.expectEqual(@as(u16, 200), insertions.status);

    var nonce = try call(&fixture.state, a, "POST", "/evm/overwrite_upper_nonce", "{\"domain_id\":1,\"new_upper_nonce\":42}");
    defer nonce.deinit();
    try std.testing.expectEqual(@as(u16, 200), nonce.status);
    try std.testing.expectEqualStrings("null", nonce.body);

    var environment = try call(&fixture.state, a, "GET", "/environment_variable", "{\"name\":\"FIXTURE\"}");
    defer environment.deinit();
    try std.testing.expectEqual(@as(u16, 200), environment.status);
    try std.testing.expectEqualStrings("{\"name\":\"FIXTURE\",\"value\":\"fixture\",\"message\":\"got\"}", environment.body);
}

test "relay api admission dedup rate limit cors and metrics preserve source behavior" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "test" });
    defer registry.deinit();
    var clock = ClockFixture{};
    var rate = try relay_api.RateLimiter.init(a, 100, 60);
    defer rate.deinit();
    var cache = try relay_api.TxHashCache.init(a, 10, 300 * std.time.ns_per_s, .{ .context = &clock, .monotonic_ns = monotonic, .unix_seconds = unixSeconds });
    defer cache.deinit();
    const context: u8 = 0;
    var state = relay_api.RelayApi{
        .owner = .{ .context = @constCast(&context), .submit_fn = submitSuccess },
        .registry = registry,
        .rate_limiter = &rate,
        .tx_cache = &cache,
        .clock = .{ .context = &clock, .monotonic_ns = monotonic, .unix_seconds = unixSeconds },
        .cors_origins = &.{"https://nexus.hyperlane.xyz"},
    };
    const handler = state.handler();
    var cancelled = std.atomic.Value(bool).init(false);

    var health_request = try testing.TestRequest.init(a, "GET", "/relay", "");
    defer health_request.deinit();
    var health = try handler.handle_fn(handler.context, a, health_request.value, &cancelled);
    defer health.deinit();
    try std.testing.expectEqual(@as(u16, 200), health.status);
    try std.testing.expectEqualStrings("up", health.body);
    try std.testing.expectEqualStrings("content-type", health.headers[0].name);
    try std.testing.expectEqualStrings("text/plain; charset=utf-8", health.headers[0].value);
    try std.testing.expectEqualStrings("vary", health.headers[1].name);
    try std.testing.expectEqualStrings("access-control-allow-origin", health.headers[2].name);
    try std.testing.expectEqualStrings("https://nexus.hyperlane.xyz", health.headers[2].value);

    var preflight_request = try testing.TestRequest.init(a, "OPTIONS", "/relay", "");
    defer preflight_request.deinit();
    var preflight = try handler.handle_fn(handler.context, a, preflight_request.value, &cancelled);
    defer preflight.deinit();
    try std.testing.expectEqual(@as(u16, 204), preflight.status);
    var found_origin = false;
    for (preflight.headers) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "access-control-allow-origin") and std.mem.eql(u8, header.value, "https://nexus.hyperlane.xyz")) found_origin = true;
    }
    try std.testing.expect(found_origin);

    const body = "{\"origin_chain\":\"ethereum\",\"tx_hash\":\"0x" ++ "00000000000000000000000000000000" ++ "000000000000000000000000000000AB" ++ "\"}";
    var first_request = try testing.TestRequest.init(a, "POST", "/relay", body);
    defer first_request.deinit();
    var first = try handler.handle_fn(handler.context, a, first_request.value, &cancelled);
    defer first.deinit();
    try std.testing.expectEqual(@as(u16, 200), first.status);
    try std.testing.expect(std.mem.indexOf(u8, first.body, "\"origin\":1") != null);
    try std.testing.expectEqualStrings("content-type", first.headers[0].name);
    try std.testing.expectEqualStrings("application/json", first.headers[0].value);

    var duplicate_request = try testing.TestRequest.init(a, "POST", "/relay", body);
    defer duplicate_request.deinit();
    var duplicate = try handler.handle_fn(handler.context, a, duplicate_request.value, &cancelled);
    defer duplicate.deinit();
    try std.testing.expectEqual(@as(u16, 429), duplicate.status);
    try std.testing.expectEqualStrings("Transaction already submitted recently", duplicate.body);

    clock.mono_ns.store(301 * std.time.ns_per_s, .release);
    var retry_request = try testing.TestRequest.init(a, "POST", "/relay", body);
    defer retry_request.deinit();
    var retry = try handler.handle_fn(handler.context, a, retry_request.value, &cancelled);
    defer retry.deinit();
    try std.testing.expectEqual(@as(u16, 200), retry.status);

    var invalid_request = try testing.TestRequest.init(a, "POST", "/relay", "{\"origin_chain\":\"\",\"tx_hash\":\"0x1\"}");
    defer invalid_request.deinit();
    var invalid = try handler.handle_fn(handler.context, a, invalid_request.value, &cancelled);
    defer invalid.deinit();
    try std.testing.expectEqual(@as(u16, 400), invalid.status);
    try std.testing.expectEqualStrings("origin_chain cannot be empty", invalid.body);

    const rendered = try registry.render(a);
    defer a.free(rendered);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_relay_api_requests_total{status=\"success\",error_type=\"\"} 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_relay_api_requests_total{status=\"failure\",error_type=\"duplicate_tx\"} 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_relay_api_processor_admission_duration_seconds_bucket") != null);

    const server = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("127.0.0.1", 0), .request_timeout_ms = 15_000 }, state.handler());
    defer server.deinit();
    var stream = try std.net.tcpConnectToAddress(server.address());
    defer stream.close();
    try stream.writeAll("GET /relay HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
    var socket_output = std.array_list.Managed(u8).init(a);
    defer socket_output.deinit();
    var socket_buffer: [1024]u8 = undefined;
    while (true) {
        const count = try stream.read(&socket_buffer);
        if (count == 0) break;
        try socket_output.appendSlice(socket_buffer[0..count]);
    }
    try std.testing.expect(std.mem.indexOf(u8, socket_output.items, "200 OK") != null);
    try std.testing.expect(std.mem.indexOf(u8, socket_output.items, "\r\n\r\nup") != null);
}

fn adminAllocationSweep(a: std.mem.Allocator) !void {
    var context = testing.FixtureContext{};
    var state = testing.admin(&context, undefined, undefined, undefined);
    state.policy = null;
    state.denylist = null;
    state.denylist_clock = null;
    var response = try call(&state, a, "GET", "/messages?domain_id=1&nonce_start=9&nonce_end=10", "");
    defer response.deinit();
    try std.testing.expectEqual(@as(u16, 200), response.status);
}

test "admin route allocation failures release requests responses and shared state" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, adminAllocationSweep, .{});
}

const RefreshFeed = struct {
    selector: std.atomic.Value(u8) = .init(0),
    fn fetch(context: *anyopaque, a: std.mem.Allocator, _: []const u8, _: usize) anyerror!denylist.Fetched {
        const self: *RefreshFeed = @ptrCast(@alignCast(context));
        const body = if (self.selector.load(.acquire) == 0) "{\"rules\":[]}" else "{\"rules\":[{\"messageid\":\"0x" ++ "11111111111111111111111111111111" ++ "11111111111111111111111111111111" ++ "\",\"reason\":\"fixture\",\"addedBy\":\"test\"}]}";
        return .{ .allocator = a, .status = 200, .bytes = try a.dupe(u8, body) };
    }
    fn now(_: *anyopaque) i64 {
        return 1;
    }
};

test "concurrent denylist refresh and summary safely share active snapshots" {
    const a = std.testing.allocator;
    var feed = RefreshFeed{};
    var list = try denylist.RuntimeDenylist.init(a, null);
    defer list.deinit();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(base);
    list.config = .{
        .url = "https://fixture.invalid/denylist",
        .cache_path = try std.fs.path.join(a, &.{ base, "cache.json" }),
        .poll_interval_ms = 1,
    };
    defer a.free(list.config.?.cache_path);
    list.transport = .{ .context = &feed, .fetch = RefreshFeed.fetch };
    const clock = denylist.Clock{ .context = &feed, .now_unix = RefreshFeed.now };

    var workers: [4]std.Thread = undefined;
    for (&workers, 0..) |*worker, index| {
        worker.* = try std.Thread.spawn(.{}, refreshWorker, .{ &list, clock, @as(u8, @intCast(index & 1)) });
    }
    for (&workers) |*worker| worker.join();
    const summary = list.summary();
    try std.testing.expect(summary.message_rules <= 1);
    try std.testing.expectEqual(@as(usize, 0), summary.address_rules);
}

fn refreshWorker(list: *denylist.RuntimeDenylist, clock: denylist.Clock, selector: u8) void {
    var feed: *RefreshFeed = @ptrCast(@alignCast(clock.context));
    feed.selector.store(selector, .release);
    _ = list.refresh(clock) catch {};
}

fn txCacheAllocationSweep(a: std.mem.Allocator) !void {
    var clock = ClockFixture{};
    var cache = try relay_api.TxHashCache.init(a, 2, 300 * std.time.ns_per_s, .{ .context = &clock, .monotonic_ns = monotonic, .unix_seconds = unixSeconds });
    defer cache.deinit();
    var reservation = try cache.checkAndInsert("ethereum", "0xAB");
    reservation.release();
}

test "relay transaction cache allocation failures release reservations and keys" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, txCacheAllocationSweep, .{});
}

test "relay transaction cache preserves capacity reservation and exact token cleanup" {
    const a = std.testing.allocator;
    var clock = ClockFixture{};
    var cache = try relay_api.TxHashCache.init(a, 1, 300 * std.time.ns_per_s, .{ .context = &clock, .monotonic_ns = monotonic, .unix_seconds = unixSeconds });
    var first = try cache.checkAndInsert("ethereum", "0xAB");
    try std.testing.expectError(error.CacheFull, cache.checkAndInsert("optimism", "0xCD"));
    var stale = first;
    stale.token += 1;
    try std.testing.expectEqual(@as(u64, 0), first.token);
    try std.testing.expectEqual(@as(u64, 1), stale.token);
    stale.release();
    try std.testing.expectEqual(@as(usize, 1), cache.entries.count());
    first.release();
    try std.testing.expectEqual(@as(usize, 0), cache.entries.count());
    cache.deinit();
}
