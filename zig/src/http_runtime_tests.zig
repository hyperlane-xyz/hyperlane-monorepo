//! Shared generic native HTTP owner / read-only continuation tests.
const std = @import("std");
const runtime = @import("net/http_runtime.zig");
const replay = @import("net/http_replay.zig");
test {
    std.testing.refAllDecls(runtime.Runtime);
    std.testing.refAllDecls(replay.Replay);
}

const curl = @import("net/curl.zig");
const http = @import("cloud/http.zig");
const rpc = @import("net/json_rpc.zig");
const stark = @import("starknet/provider.zig");
const fixture = @import("evm/pool_testing.zig");
const scheduler = @import("runtime/supervisor.zig");
const A = std.mem.Allocator;
const Group = struct {
    journal: replay.Replay,
    native: curl.Client,
    http: http.HttpTransport,
    endpoint: [1]rpc.Endpoint,
    provider: stark.Provider = undefined,
    indexed: std.atomic.Value(u64) = .init(0),
    fn run(context: *anyopaque, _: scheduler.Times, cancel: *const std.atomic.Value(bool)) !scheduler.Report {
        const self: *Group = @ptrCast(@alignCast(context));
        try self.journal.beginPass(cancel, null);
        self.http.cancel = cancel;
        defer self.http.cancel = null;
        var failure: ?anyerror = null;
        defer self.journal.endPass(failure);
        return self.read() catch |err| {
            failure = err;
            return err;
        };
    }
    fn read(self: *Group) !scheduler.Report {
        const before = try self.provider.header(.{ .number = 16 });
        const head = try self.provider.blockNumber();
        const after = try self.provider.header(.{ .number = 16 });
        if (before.hash.value != after.hash.value or head != after.number) return error.StarknetFetchedReorg;
        self.indexed.store(head, .release);
        return .{ .work = 1, .halt = true };
    }
};
fn respond(a: A, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    const method = parsed.value.object.get("method").?.string;
    const result = if (std.mem.eql(u8, method, "starknet_blockNumber")) "16" else if (std.mem.eql(u8, method, "starknet_getBlockWithTxHashes")) "{\"status\":\"ACCEPTED_ON_L1\",\"block_number\":16,\"block_hash\":\"0x1\",\"parent_hash\":\"0x2\",\"timestamp\":123}" else return error.UnexpectedMethod;
    return std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ parsed.value.object.get("id").?.integer, result });
}
test "shared HTTP runtime sixteen actual Starknet providers progress past eight stalled chains with one IO owner" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const slow = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const fast = [_]fixture.Reply{.{ .body = "" }};
    var behaviors: [16]fixture.Behavior = undefined;
    for (&behaviors, 0..) |*behavior, i| behavior.* = if (i < 8) .{ .replies = &slow } else .{ .replies = &fast, .response_fn = respond };
    var server = try fixture.Fixture.init(128, &behaviors);
    try server.start();
    defer server.deinit();
    const owner = try runtime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 32, .max_pending = 32, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 4 * 1024 * 1024 }, .max_sessions = 32 });
    defer owner.deinit();
    var budget: @import("net/read_replay.zig").ByteBudget = .{ .maximum = 1024 * 1024 };
    var groups: [16]Group = undefined;
    var initialized: usize = 0;
    defer for (groups[0..initialized]) |*group| {
        group.journal.deinit();
        group.http.deinit();
        group.native.deinit();
        a.free(group.endpoint[0].url);
    };
    for (&groups, 0..) |*group, i| {
        const url = try server.url(a, i);
        errdefer a.free(url);
        group.* = .{ .journal = try replay.Replay.init(a, owner, .{ .max_attempt_ms = 5000, .shared_budget = &budget }), .native = try curl.Client.init(a, library), .http = http.HttpTransport.init(a), .endpoint = .{.{ .url = url }} };
        group.native.send_override = group.journal.override();
        group.http.native_curl = &group.native;
        group.http.timeout_ms = 4000;
        group.http.allow_insecure_loopback = true;
        group.provider = .{ .allocator = a, .client = try rpc.Client.init(a, group.http.interface(), &group.endpoint, .{ .max_response_bytes = 8192 }) };
        initialized += 1;
    }
    var tasks: [16]scheduler.Task = undefined;
    for (&tasks, &groups) |*task, *group| task.* = .{ .context = group, .run = Group.run, .interval_ms = 1, .timeout_ms = 5000 };
    const supervisor = try scheduler.Supervisor.start(a, &tasks);
    defer supervisor.deinit();
    var timer = try std.time.Timer.start();
    while (true) {
        const now = timer.read() / std.time.ns_per_ms;
        _ = try supervisor.tick(.{ .monotonic_ms = now, .unix_ms = now });
        var ready: usize = 0;
        for (groups[8..], 8..) |*group, i| if (group.indexed.load(.acquire) == 16 and (try supervisor.health(i)).completed == 1) {
            ready += 1;
        };
        if (ready == 8) break;
        if (now > 2000) return error.HealthyStarknetSourceStarved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    for (0..8) |i| {
        try std.testing.expectEqual(@as(u64, 0), (try supervisor.health(i)).failures);
        try std.testing.expect((try supervisor.health(i)).suspended > 0);
    }
    for (8..16) |i| try std.testing.expectEqual(@as(usize, 3), server.pathHits(i));
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    supervisor.stop();
    try server.check();
}

test "shared HTTP runtime real Cosmos gRPC fixture preserves framing trailers historical height and typed query decoding" {
    const a = std.testing.allocator;
    const url = std.process.getEnvVarOwned(a, "HYPERLANE_COSMOS_GRPC_TEST_URL") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(url);
    if (!std.mem.startsWith(u8, url, "http://127.0.0.1:")) return error.LoopbackFixtureRequired;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const owner = try runtime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_response_bytes = 8 * 1024 * 1024 + 5, .max_reserved_bytes = 64 * 1024 * 1024 } });
    defer owner.deinit();
    var journal = try replay.Replay.init(a, owner, .{});
    defer journal.deinit();
    var transport = try @import("cosmos/curl_grpc.zig").CurlTransport.init(a, url, library);
    defer transport.deinit();
    transport.client.send_override = journal.override();
    const contracts = @import("cosmos/contracts.zig");
    const client: contracts.Client = .{ .allocator = a, .transport = transport.interface(), .domain = 2000, .config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("cosmos/config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    var timer = try std.time.Timer.start();
    while (true) {
        try journal.beginPass(null, null);
        const result = client.wasmNonce(.{0x11} ** 32, 100);
        if (result) |count| {
            journal.endPass(null);
            try std.testing.expectEqual(@as(u32, 5), count);
            break;
        } else |err| {
            journal.endPass(err);
            if (err != error.PendingReadIo) return err;
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.GrpcReplayTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

const RetainedObservation = struct {
    refs: std.atomic.Value(usize) = .init(1),
    completed: std.atomic.Value(usize) = .init(0),
    fn retain(ctx: *anyopaque) void {
        const self: *RetainedObservation = @ptrCast(@alignCast(ctx));
        _ = self.refs.fetchAdd(1, .acq_rel);
    }
    fn release(ctx: *anyopaque) void {
        const self: *RetainedObservation = @ptrCast(@alignCast(ctx));
        _ = self.refs.fetchSub(1, .acq_rel);
    }
    fn complete(ctx: *anyopaque, _: *const @import("net/curl_multi.zig").Result, _: u64) void {
        const self: *RetainedObservation = @ptrCast(@alignCast(ctx));
        _ = self.completed.fetchAdd(1, .release);
    }
};
test "shared HTTP runtime capacity cancellation retained observer owned requests response caps and stale handles" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const replies = [_]fixture.Reply{ .{ .body = "", .stall = true }, .{ .body = "owned-result" }, .{ .body = "x" ** 256 } };
    const behaviors = [_]fixture.Behavior{.{ .replies = &replies }};
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try runtime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 1, .max_pending = 1, .max_request_bytes = 16384, .max_response_bytes = 128, .max_reserved_bytes = 256 * 1024 }, .max_sessions = 1 });
    var owner_closed = false;
    defer if (!owner_closed) owner.deinit();
    var observed: RetainedObservation = .{};
    const observer: runtime.Observer = .{ .context = &observed, .retain_fn = RetainedObservation.retain, .release_fn = RetainedObservation.release, .complete_fn = RetainedObservation.complete };
    const request: curl.Request = .{ .url = url, .method = .post, .body = "original-body", .max_response_bytes = 128, .timeout_ms = 2000 };
    const stalled = try owner.submit(request, observer);
    RetainedObservation.release(&observed);
    var timer = try std.time.Timer.start();
    while (server.acceptedCount() == 0) {
        if (timer.read() > std.time.ns_per_s) return error.FixtureStartTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectError(error.HttpRuntimeSessionsFull, owner.submit(request, null));
    owner.cancel(stalled);
    owner.cancel(stalled);
    try std.testing.expectError(error.InvalidHttpHandle, owner.poll(stalled));
    const owned_url = try a.dupe(u8, url);
    const body = try a.dupe(u8, "copied-request-body");
    var next: ?runtime.Handle = null;
    while (next == null) {
        next = owner.submit(.{ .url = owned_url, .method = .post, .body = body, .max_response_bytes = 128 }, null) catch |err| blk: {
            if (err != error.HttpRuntimeSessionsFull) return err;
            break :blk null;
        };
        if (timer.read() > std.time.ns_per_s) return error.CancelledHandleNotRetired;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    a.free(owned_url);
    a.free(body);
    var response: ?curl.Response = null;
    while (response == null) {
        response = try owner.poll(next.?);
        if (timer.read() > 2 * std.time.ns_per_s) return error.OwnedRequestTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    defer response.?.deinit();
    try std.testing.expectEqualStrings("owned-result", response.?.body);
    try std.testing.expectEqualStrings("copied-request-body", server.records[1].bodyText());
    try std.testing.expectError(error.InvalidHttpHandle, owner.poll(next.?));
    var oversized: ?runtime.Handle = null;
    while (oversized == null) {
        oversized = owner.submit(request, null) catch |err| blk: {
            if (err != error.HttpRuntimeSessionsFull) return err;
            break :blk null;
        };
        std.Thread.sleep(std.time.ns_per_ms);
    }
    while (true) {
        const result = owner.poll(oversized.?);
        if (result) |maybe| {
            if (maybe) |r| {
                var unexpected = r;
                unexpected.deinit();
                return error.ResponseCapNotEnforced;
            }
        } else |err| {
            try std.testing.expectEqual(error.ResponseTooLarge, err);
            break;
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.ResponseCapTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    owner.deinit();
    owner_closed = true;
    try std.testing.expectEqual(@as(usize, 0), observed.refs.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), observed.completed.load(.acquire));
    try server.check();
}
