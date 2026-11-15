//! Focused cooperative JSON-RPC continuation tests; no native database link.
const std = @import("std");
const replay = @import("net/read_replay.zig");
test {
    std.testing.refAllDecls(replay);
}

const Pool = @import("evm/pool.zig");
const rpc = @import("evm/provider.zig");
const fixture = @import("evm/pool_testing.zig");
const supervisor = @import("runtime/supervisor.zig");
const Evm = @import("agents/scraper/evm.zig").Evm;
const A = std.mem.Allocator;
const Group = struct {
    replay: replay.Replay,
    client: rpc.RpcClient,
    evm: Evm = undefined,
    indexed: std.atomic.Value(u64) = .init(0),
    fn run(context: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Group = @ptrCast(@alignCast(context));
        try self.replay.beginPass(cancel);
        var failure: ?anyerror = null;
        defer self.replay.endPass(failure);
        return self.fetch(cancel) catch |err| {
            failure = err;
            return err;
        };
    }
    fn fetch(self: *Group, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        self.client.options.cancel = cancel;
        defer self.client.options.cancel = null;
        const source = self.evm.interface();
        const before = try source.header(.{ .height = 16 });
        var batch = try source.events(std.testing.allocator, 16, 16, .{0} ** 4);
        defer batch.deinit();
        const after = try source.freshHeader(.{ .height = 16 });
        if (!std.mem.eql(u8, &before.hash, &after.hash) or batch.through != after.height) return error.ScraperFetchedReorg;
        self.indexed.store(batch.through, .release);
        return .{ .work = 1, .halt = true };
    }
};
fn respond(a: A, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    const id = parsed.value.object.get("id").?.integer;
    const method = parsed.value.object.get("method").?.string;
    const result = if (std.mem.eql(u8, method, "eth_getBlockByNumber"))
        "{\"number\":\"0x10\",\"timestamp\":\"0x123\",\"hash\":\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\",\"parentHash\":\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\"}"
    else if (std.mem.eql(u8, method, "eth_getLogs")) "[]" else return error.UnexpectedRpcMethod;
    return std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, result });
}

test "cooperative EVM source indexes eight healthy chains past eight stalled chains with eight supervisor workers" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const stalled = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const ok = [_]fixture.Reply{.{ .body = "" }};
    var behaviors: [16]fixture.Behavior = undefined;
    for (&behaviors, 0..) |*behavior, i| behavior.* = if (i < 8) .{ .replies = &stalled } else .{ .replies = &ok, .response_fn = respond };
    var server = try fixture.Fixture.init(128, &behaviors);
    try server.start();
    defer server.deinit();
    var quota: replay.ByteBudget = .{ .maximum = 1024 * 1024 };
    var runtimes: [16]*Pool.Pool = undefined;
    var groups: [16]Group = undefined;
    var initialized: usize = 0;
    defer for (0..initialized) |i| {
        groups[i].client.deinit();
        groups[i].replay.deinit();
        runtimes[i].deinit();
    };
    for (&runtimes, &groups, 0..) |*runtime, *group, i| {
        const url = try server.url(a, i);
        defer a.free(url);
        runtime.* = try Pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 2 * 1024 * 1024, .max_sessions = 2, .max_concurrent = 2, .max_pending = 4 });
        errdefer runtime.*.deinit();
        group.indexed = .init(0);
        group.replay = try replay.Replay.init(a, runtime.*, .{ .max_attempt_ms = 5000, .shared_budget = &quota });
        group.client = try rpc.RpcClient.init(a, url, .{ .exchange = group.replay.interface(), .timeout_ms = 4000, .max_response_bytes = 8192 });
        group.evm = .{ .rpc_client = &group.client, .contracts = .{ .mailbox = .{0} ** 32, .hook = .{0} ** 32, .paymaster = .{0} ** 32 }, .domain = @intCast(i + 1) };
        initialized += 1;
    }
    var tasks: [16]supervisor.Task = undefined;
    for (&tasks, &groups) |*task, *group| task.* = .{ .context = group, .run = Group.run, .interval_ms = 1, .timeout_ms = 5000 };
    const scheduler = try supervisor.Supervisor.start(a, &tasks);
    defer scheduler.deinit();
    var timer = try std.time.Timer.start();
    while (true) {
        const now = timer.read() / std.time.ns_per_ms;
        _ = try scheduler.tick(.{ .unix_ms = now, .monotonic_ms = now });
        var ready: usize = 0;
        for (groups[8..], 8..) |*group, i| if (group.indexed.load(.acquire) == 16 and (try scheduler.health(i)).completed == 1) {
            ready += 1;
        };
        if (ready == 8) break;
        if (now > 2000) return error.HealthyChainStarvedBehindStalledPeers;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    for (groups[0..8], 0..) |*group, i| {
        try std.testing.expectEqual(@as(u64, 0), group.indexed.load(.acquire));
        try std.testing.expectEqual(@as(u64, 0), (try scheduler.health(i)).failures);
        // Stalled reads hold no worker: each fiber parks on its session.
        const health = try scheduler.health(i);
        try std.testing.expect(health.started >= 1 and health.completed == 0);
    }
    for (8..16) |i| {
        // BEFORE and AFTER identical block-hash requests MUST be independent
        // physical transfers, not one cache hit disguised as a canonical fence.
        try std.testing.expectEqual(@as(usize, 3), server.pathHits(i));
    }
    scheduler.stop();
    try std.testing.expectEqual(@as(usize, 0), quota.used);
    try server.check();
}

fn onePass(cache: *replay.Replay, body: []const u8) !rpc.WireResponse {
    try cache.beginPass(null);
    var failure: ?anyerror = null;
    defer cache.endPass(failure);
    return cache.fetch(std.testing.allocator, body, .{ .timeout_ms = 1000, .max_response_bytes = 8192 }) catch |err| {
        failure = err;
        return err;
    };
}
test "cooperative absolute deadline and cancellation end a parked or driven read promptly" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const stalled = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const behaviors = [_]fixture.Behavior{.{ .replies = &stalled }};
    var server = try fixture.Fixture.init(10, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const runtime = try Pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 2 * 1024 * 1024, .max_sessions = 4, .max_concurrent = 4, .max_pending = 4 });
    defer runtime.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}";
    const handle = try runtime.submit(body, 1000, 1000, 8192);
    try std.testing.expect(try runtime.poll(handle, a) == null);
    runtime.cancel(handle);
    runtime.cancel(handle);
    try std.testing.expectError(error.InvalidRpcHandle, runtime.poll(handle, a));
    // The 30 ms absolute attempt clamps a 1 s request: one call, no replay.
    var cache = try replay.Replay.init(a, runtime, .{ .max_attempt_ms = 30 });
    defer cache.deinit();
    var timer = try std.time.Timer.start();
    if (onePass(&cache, body)) |unexpected| {
        a.free(unexpected.bytes);
        return error.UnexpectedReply;
    } else |err| try std.testing.expectEqual(error.RequestDeadlineExceeded, err);
    if (timer.read() > 900 * std.time.ns_per_ms) return error.ReadReplayDeadlineIgnored;
    try std.testing.expect(cache.started == null);
    // A borrowed cancellation flipped while the read waits ends it promptly
    // and closes the attempt.
    cache.config.max_attempt_ms = 5000;
    var cancel = std.atomic.Value(bool).init(false);
    const Canceller = struct {
        fn run(flag: *std.atomic.Value(bool)) void {
            std.Thread.sleep(30 * std.time.ns_per_ms);
            flag.store(true, .release);
        }
    };
    const thread = try std.Thread.spawn(.{}, Canceller.run, .{&cancel});
    timer.reset();
    try cache.beginPass(&cancel);
    const cancelled = cache.fetch(a, body, .{ .timeout_ms = 4000, .max_response_bytes = 8192 });
    thread.join();
    if (cancelled) |unexpected| {
        a.free(unexpected.bytes);
        cache.endPass(null);
        return error.UnexpectedReply;
    } else |err| {
        cache.endPass(err);
        try std.testing.expectEqual(error.RequestCancelled, err);
    }
    if (timer.read() > 2 * std.time.ns_per_s) return error.ReadReplayCancelIgnored;
    try std.testing.expect(cache.started == null and cache.cancel == null);
    try server.check();
}
fn respondFork(a: A, body: []const u8) ![]u8 {
    const normal = try respond(a, body);
    errdefer a.free(normal);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    if (parsed.value.object.get("id").?.integer > 1 and std.mem.eql(u8, parsed.value.object.get("method").?.string, "eth_getBlockByNumber")) {
        if (std.mem.indexOf(u8, normal, "11111111111111111111111111111111" ++ "11111111111111111111111111111111")) |at| @memset(normal[at..][0..64], '3');
    }
    return normal;
}
test "cooperative EVM source cannot replay the before-header as an after-header across a fork" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const ok = [_]fixture.Reply{.{ .body = "" }};
    const behaviors = [_]fixture.Behavior{.{ .replies = &ok, .response_fn = respondFork }};
    var server = try fixture.Fixture.init(4, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const runtime = try Pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 2 * 1024 * 1024, .max_sessions = 4, .max_concurrent = 4, .max_pending = 4 });
    defer runtime.deinit();
    var group: Group = .{ .replay = try replay.Replay.init(a, runtime, .{}), .client = undefined };
    defer group.replay.deinit();
    group.client = try rpc.RpcClient.init(a, url, .{ .exchange = group.replay.interface(), .max_response_bytes = 8192 });
    defer group.client.deinit();
    group.evm = .{ .rpc_client = &group.client, .contracts = .{ .mailbox = .{0} ** 32, .hook = .{0} ** 32, .paymaster = .{0} ** 32 }, .domain = 1 };
    var cancel = std.atomic.Value(bool).init(false);
    // One pass: before and after headers are separate physical reads.
    if (Group.run(&group, .{ .unix_ms = 0, .monotonic_ms = 0 }, &cancel)) |_| return error.UnauthenticatedFork else |err| try std.testing.expectEqual(error.ScraperFetchedReorg, err);
    try std.testing.expectEqual(@as(usize, 3), server.pathHits(0));
    try std.testing.expectEqual(@as(u64, 0), group.indexed.load(.acquire));
    try std.testing.expect(group.replay.started == null);
    try server.check();
}

test "cooperative global replay quota fails closed, bounds requests per section and releases on every terminal path" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const ok = [_]fixture.Reply{.{ .body = "" }};
    const behaviors = [_]fixture.Behavior{.{ .replies = &ok, .response_fn = respond }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const runtime = try Pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 2 * 1024 * 1024, .max_sessions = 4, .max_concurrent = 4, .max_pending = 4 });
    defer runtime.deinit();
    var quota: replay.ByteBudget = .{ .maximum = 1 };
    var cache = try replay.Replay.init(a, runtime, .{ .shared_budget = &quota, .max_entries = 2 });
    defer cache.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}";
    const options: rpc.Options = .{ .timeout_ms = 1000, .max_response_bytes = 8192 };
    // The shared byte quota fails closed once the response arrives; the
    // closed attempt keeps no reservation.
    try std.testing.expectError(error.ReadReplayGlobalByteBudgetExceeded, onePass(&cache, body));
    try std.testing.expectEqual(@as(usize, 0), quota.used);
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    quota.maximum = 8192;
    // Two physical requests per section; the third is refused before any
    // submission. A pending suspension keeps the count.
    try cache.beginPass(null);
    a.free((try cache.fetch(a, body, options)).bytes);
    try std.testing.expect(quota.used > 0);
    cache.endPass(error.PendingReadIo);
    try std.testing.expect(quota.used > 0);
    try cache.beginPass(null);
    a.free((try cache.fetch(a, body, options)).bytes);
    try std.testing.expectError(error.ReadReplayRequestLimit, cache.fetch(a, body, options));
    try std.testing.expectEqual(@as(usize, 3), server.pathHits(0));
    // A committed section releases its requests and bytes, not the deadline.
    const started = cache.started;
    try cache.commitReadSection();
    try std.testing.expectEqual(@as(usize, 0), quota.used);
    try std.testing.expectEqual(started, cache.started);
    a.free((try cache.fetch(a, body, options)).bytes);
    try std.testing.expectEqual(@as(usize, 4), server.pathHits(0));
    cache.endPass(null);
    try std.testing.expectEqual(@as(usize, 0), quota.used);
    var timer = try std.time.Timer.start();
    while (runtime.native.reserved_bytes != 0 or runtime.retained_bytes != 0) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.PoolBytesNotDrained;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try server.check();
}

test "cooperative RPC completed native request timeout is ordinary with a live owner budget" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const stalled = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const behaviors = [_]fixture.Behavior{.{ .replies = &stalled }};
    var server = try fixture.Fixture.init(4, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const runtime = try Pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 2 * 1024 * 1024, .max_sessions = 4, .max_concurrent = 4, .max_pending = 4 });
    defer runtime.deinit();
    var cache = try replay.Replay.init(a, runtime, .{ .max_attempt_ms = 2000 });
    defer cache.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}";
    try cache.beginPass(null);
    const result = cache.fetch(a, body, .{ .timeout_ms = 25, .connect_timeout_ms = 25, .max_response_bytes = 8192 });
    if (result) |unexpected| {
        a.free(unexpected.bytes);
        cache.endPass(null);
        return error.UnexpectedReply;
    } else |err| {
        cache.endPass(err);
        try std.testing.expectEqual(error.UpstreamReadTimeout, err);
    }
    try std.testing.expect(cache.started == null);
    try server.check();
}

const DirectRun = struct {
    group: *Group,
    cancel: std.atomic.Value(bool) = .init(false),
    result: ?anyerror = null,
    batch_ok: bool = false,
    fn run(self: *DirectRun) void {
        // One pass, no PendingReadIo: every read waits inline on this thread.
        const report = Group.run(self.group, .{ .unix_ms = 0, .monotonic_ms = 0 }, &self.cancel) catch |err| {
            self.result = err;
            return;
        };
        if (report.work != 1) self.result = error.UnexpectedReport;
        self.group.replay.beginPass(&self.cancel) catch |err| {
            self.result = err;
            return;
        };
        defer self.group.replay.endPass(null);
        const bodies = [_][]const u8{
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"eth_getLogs\",\"params\":[]}",
            "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"eth_getLogs\",\"params\":[]}",
        };
        var out: [2]rpc.WireResponse = undefined;
        self.group.replay.fetchMany(std.testing.allocator, &bodies, .{ .max_response_bytes = 8192 }, &out) catch |err| {
            self.result = err;
            return;
        };
        defer for (out) |wire| std.testing.allocator.free(wire.bytes);
        self.batch_ok = std.mem.indexOf(u8, out[0].bytes[0..out[0].len], "\"id\":7") != null and std.mem.indexOf(u8, out[1].bytes[0..out[1].len], "\"id\":8") != null;
    }
};
test "thread reads wait inline without replay, clone or identity hashing" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const ok = [_]fixture.Reply{.{ .body = "" }};
    const behaviors = [_]fixture.Behavior{.{ .replies = &ok, .response_fn = respond }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const runtime = try Pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .strategy = .{ .single = .{ .max_attempts = 1 } }, .max_response_bytes = 8192, .max_request_bytes = 16384 });
    defer runtime.deinit();
    var group: Group = .{ .replay = try replay.Replay.init(a, runtime, .{ .max_attempt_ms = 5000 }), .client = undefined };
    defer group.replay.deinit();
    group.client = try rpc.RpcClient.init(a, url, .{ .exchange = group.replay.interface(), .timeout_ms = 4000, .max_response_bytes = 8192 });
    defer group.client.deinit();
    group.evm = .{ .rpc_client = &group.client, .contracts = .{ .mailbox = .{0} ** 32, .hook = .{0} ** 32, .paymaster = .{0} ** 32 }, .domain = 1 };
    var direct: DirectRun = .{ .group = &group };
    const thread = try std.Thread.spawn(.{}, DirectRun.run, .{&direct});
    thread.join();
    if (direct.result) |err| return err;
    try std.testing.expect(direct.batch_ok);
    try std.testing.expectEqual(@as(u64, 16), group.indexed.load(.acquire));
    // Header, logs, fresh header and the two batched reads: one request each.
    try std.testing.expectEqual(@as(usize, 5), server.acceptedCount());
    // Every owner pass ran on the reading thread (no owner-thread handoff).
    try std.testing.expectEqual(runtime.owner_iterations.load(.acquire), runtime.caller_passes.load(.acquire));
}
