//! Actual configured Resources -> native ManagedPool -> Tendermint boundary.
const std = @import("std");
const source = @import("chain_source.zig");
const fixture = @import("../evm/pool_testing.zig");
const settings = @import("../settings/types.zig");
const A = std.mem.Allocator;
const hash_text = "47DF5E622ED8DC08381B905BC1876FE59" ++ "DA2230390123DC0B1688E445736EBD5";
fn hash() [32]u8 {
    var out: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, hash_text) catch unreachable;
    return out;
}
fn absence(a: A, body: []const u8) ![]u8 {
    var request = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer request.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = request.value.object.get("id").?, .@"error" = .{ .code = -32603, .message = "Internal error", .data = "tx (" ++ hash_text ++ ") not found" } }, .{});
}
fn chain(native: bool, urls: []const []const u8) settings.Chain {
    var result = @import("chain_source_testing.zig").chainFor(urls);
    result.protocol = if (native) .cosmosnative else .cosmos;
    result.chain_id = "hyperlane-local";
    result.grpc_urls = urls;
    const conf: settings.Cosmos = .{ .chain_id = "hyperlane-local", .bech32_prefix = "hyp", .gas_price = .{ .amount = "0.2", .denom = "uhyp" }, .contract_address_bytes = 20, .gas_multiplier = 1.35, .compat_mode = null, .canonical_asset = "uhyp" };
    result.connection = if (native) .{ .cosmosnative = conf } else .{ .cosmos = conf };
    return result;
}
test "configured Cosmos transaction absence reaches typed client through real Resources Pool" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = absence }};
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var conf = chain(true, &.{url});
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const resources = try source.Resources.open(a, &conf, &env, .{ .curl_library = library });
    defer resources.deinit();
    try std.testing.expect(resources.rpc_pool != null and resources.rpc_pool.?.config.height_protocol == .tendermint);
    resources.rpc_client.?.next_id = 12;
    try std.testing.expect(try resources.clients.cosmos.tendermint.txIfPresent(hash(), false) == null);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}

const pool = @import("../evm/pool.zig");
const rpc = @import("../evm/provider.zig");
const Factory = @import("destination/factory.zig").Factory;
const EventCounts = struct {
    upstream_errors: std.atomic.Value(usize) = .init(0),
    provider_failures: std.atomic.Value(usize) = .init(0),
    deprioritized: std.atomic.Value(usize) = .init(0),
    fn event(raw: *anyopaque, value: pool.Event) void {
        const self: *EventCounts = @ptrCast(@alignCast(raw));
        switch (value.kind) {
            .upstream_completed => if (!value.success) {
                _ = self.upstream_errors.fetchAdd(1, .monotonic);
            },
            .provider_failed => {
                _ = self.provider_failures.fetchAdd(1, .monotonic);
            },
            .provider_deprioritized => {
                _ = self.deprioritized.fetchAdd(1, .monotonic);
            },
            else => {},
        }
    }
    fn observer(self: *EventCounts) pool.Observer {
        return .{ .context = self, .event_fn = event };
    }
};
fn absentOrStatus(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    if (std.mem.eql(u8, parsed.value.object.get("method").?.string, "status")) return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = .{ .node_info = .{ .network = "hyperlane-local" }, .sync_info = .{ .latest_block_height = "20", .latest_block_hash = "11" ** 32, .catching_up = false } } }, .{});
    return absence(a, body);
}
// Only the constructor's native mailbox identity query is a typed fixture;
// all Tendermint requests under test use real configured native HTTP/Pool.
const Mailbox = struct {
    calls: usize = 0,
    fn call(raw: *anyopaque, a: A, request: @import("../cosmos/grpc.zig").Request) !@import("../cosmos/grpc.zig").Response {
        const self: *Mailbox = @ptrCast(@alignCast(raw));
        try std.testing.expectEqualStrings(@import("../cosmos/proto.zig").paths.mailbox, request.method);
        self.calls += 1;
        var inner: [128]u8 = undefined;
        var enc: @import("../altvm/protobuf.zig").Encoder = .{ .out = &inner };
        try enc.bytes(1, "00" ** 32);
        try enc.uint(8, 1);
        var outer: [144]u8 = undefined;
        var wrap: @import("../altvm/protobuf.zig").Encoder = .{ .out = &outer };
        try wrap.bytes(1, inner[0..enc.pos]);
        return .{ .allocator = a, .protobuf = try a.dupe(u8, outer[0..wrap.pos]) };
    }
};
test "configured Cosmos transaction absence repeated business errors preserve strict reads and provider circuit" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]bool{ false, true }) |native| {
        const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = absentOrStatus }};
        var server = try fixture.Fixture.init(64, &behaviors);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        var conf = chain(native, &.{url});
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        const resources = try source.Resources.open(a, &conf, &env, .{ .curl_library = library });
        defer resources.deinit();
        var counts: EventCounts = .{};
        resources.rpc_client.?.options.pool_observer = counts.observer();
        for (0..12) |_| try std.testing.expect(try resources.clients.cosmos.tendermint.txIfPresent(hash(), false) == null);
        try std.testing.expectError(error.RpcError, resources.clients.cosmos.tendermint.tx(hash(), false));
        // Actual destination constructor and reconcile use these same Resources.
        const factory = try Factory.open(a, resources, .{ .cosmos_key = .{ .key = @splat(17), .prefix = "hyp", .account_address_type = "bitcoin" } }, .{ .transport = resources.http.interface(), .amz_date = "20261107T020000Z" }, .{});
        defer factory.deinit();
        var mailbox: Mailbox = .{};
        factory.backend.cosmos.queries.transport = .{ .context = &mailbox, .call_fn = Mailbox.call };
        var cancel = std.atomic.Value(bool).init(false);
        const clock: @import("destination/factory.zig").Clock = .{ .unix_ms = 1, .deadline_ns = try @import("../cloud/http.zig").rpcNowNs() + 5 * std.time.ns_per_s, .cancel = &cancel };
        try std.testing.expect(try factory.reconcile(.{ .hash256 = hash() }, clock) == null);
        try std.testing.expectEqual(@as(usize, if (native) 1 else 0), mailbox.calls);
        try std.testing.expectEqual(@as(usize, 15), server.acceptedCount());
        try std.testing.expectEqual(@as(usize, 14), counts.upstream_errors.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), counts.provider_failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), counts.deprioritized.load(.acquire));
        cancel.store(true, .release);
        resources.rpc_client.?.options.cancel = &cancel;
        try std.testing.expectError(error.RequestCancelled, resources.clients.cosmos.tendermint.txIfPresent(hash(), false));
        resources.rpc_client.?.options.cancel = null;
        resources.rpc_client.?.options.owner_deadline_ns = 1;
        try std.testing.expectError(error.RequestDeadlineExceeded, resources.clients.cosmos.tendermint.txIfPresent(hash(), false));
        try std.testing.expectEqual(@as(usize, 15), server.acceptedCount());
        try server.check();
    }
}
const Bridge = struct {
    fn fetch(raw: *anyopaque, a: A, body: []const u8, options: rpc.Options) !rpc.WireResponse {
        const owner: *pool.Pool = @ptrCast(@alignCast(raw));
        const response = try owner.fetchObserved(a, body, options.timeout_ms, options.connect_timeout_ms, options.cancel, options.max_response_bytes, options.pool_observer);
        return .{ .bytes = response.bytes, .len = response.len };
    }
};
test "configured Cosmos transaction absence single pool preserves typed error and quorum semantics" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = absence }};
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .tendermint, .strategy = .{ .single = .{ .max_attempts = 1 } } });
    defer owner.deinit();
    var client = try rpc.RpcClient.init(a, url, .{ .protocol = .tendermint, .exchange = .{ .context = owner, .fetch_fn = Bridge.fetch } });
    defer client.deinit();
    var tm: @import("../cosmos/tendermint.zig").Client = .{ .rpc_client = &client, .chain_id = "hyperlane-local", .compat = .v038 };
    try std.testing.expect(try tm.txIfPresent(hash(), false) == null);
    try std.testing.expectError(error.RpcError, tm.tx(hash(), false));
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    const quorum = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .tendermint, .strategy = .{ .quorum = .{ .max_attempts = 1 } } });
    defer quorum.deinit();
    client.options.exchange = .{ .context = quorum, .fetch_fn = Bridge.fetch };
    try std.testing.expectError(error.NoQuorumReached, tm.txIfPresent(hash(), false));
    try server.check();
}
const Negative = enum { wrong_hash, wrong_code, wrong_message, malformed, wrong_id, rate_limit };
fn negative(comptime mode: Negative) *const fn (A, []const u8) anyerror![]u8 {
    return struct {
        fn respond(a: A, body: []const u8) ![]u8 {
            var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
            defer parsed.deinit();
            if (mode == .malformed) return a.dupe(u8, "{\"jsonrpc\":\"2.0\",\"error\":null}");
            return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = if (mode == .wrong_id) std.json.Value{ .integer = 900 } else parsed.value.object.get("id").?, .@"error" = .{ .code = if (mode == .rate_limit) @as(i64, 429) else if (mode == .wrong_code) @as(i64, -32000) else @as(i64, -32603), .message = if (mode == .wrong_message) "Other error" else "Internal error", .data = if (mode == .wrong_hash) "tx (" ++ "00" ** 32 ++ ") not found" else "tx (" ++ hash_text ++ ") not found" } }, .{});
        }
    }.respond;
}
test "configured Cosmos transaction absence rejects wrong hash error schema rate limits and foreign protocol" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const responders = [_]*const fn (A, []const u8) anyerror![]u8{ negative(.wrong_hash), negative(.wrong_code), negative(.wrong_message), negative(.malformed), negative(.wrong_id), negative(.rate_limit) };
    for (responders) |respond| {
        const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = respond }};
        var server = try fixture.Fixture.init(16, &behaviors);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .tendermint, .strategy = .{ .single = .{ .max_attempts = 1 } } });
        defer owner.deinit();
        var client = try rpc.RpcClient.init(a, url, .{ .protocol = .tendermint, .exchange = .{ .context = owner, .fetch_fn = Bridge.fetch } });
        defer client.deinit();
        var tm: @import("../cosmos/tendermint.zig").Client = .{ .rpc_client = &client, .chain_id = "hyperlane-local", .compat = .v038 };
        try std.testing.expectError(error.RpcPoolRetriesExhausted, tm.txIfPresent(hash(), false));
        try server.check();
    }
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = absence }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .ethereum, .strategy = .{ .single = .{ .max_attempts = 1 } } });
    defer owner.deinit();
    var client = try rpc.RpcClient.init(a, url, .{ .exchange = .{ .context = owner, .fetch_fn = Bridge.fetch } });
    defer client.deinit();
    var tm: @import("../cosmos/tendermint.zig").Client = .{ .rpc_client = &client, .chain_id = "hyperlane-local", .compat = .v038 };
    try std.testing.expectError(error.RpcPoolRetriesExhausted, tm.txIfPresent(hash(), false));
    try server.check();
}

test "configured Cosmos transaction absence exact predicate rejects unbound request encodings" {
    const a = std.testing.allocator;
    const helper = @import("../cosmos/tx_absence.zig");
    const envelope = try absence(a, "{\"id\":12}");
    defer a.free(envelope);
    var parsed = try std.json.parseFromSlice(std.json.Value, a, envelope, .{ .parse_numbers = false });
    defer parsed.deinit();
    const remote = parsed.value.object.get("error").?;
    try std.testing.expect(helper.matches(hash(), remote));
    for ([_][]const u8{
        "{}",                                                                                    "[]",                                                          "null",                                                        "{\"hash\":0}",
        "{\"hash\":\"47DF5E622ED8DC08381B905BC1876FE59" ++ "DA2230390123DC0B1688E445736EBD5\"}", "{\"hash\":\"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\"}", "{\"hash\":\"R99eYi7Y3Ag4G5BbwYdv5Z2iIwOQEj3AsWiORFc269V=\"}",
    }) |text| {
        var request = try std.json.parseFromSlice(std.json.Value, a, text, .{});
        defer request.deinit();
        try std.testing.expect(!helper.matchesRequest(request.value, remote));
    }
}

test "configured Cosmos transaction absence native timeout and HTTP status remain errors" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const replies = [_]fixture.Reply{ .{ .body = "", .stall = true }, .{ .body = "{}", .status = 429 } };
    for (replies) |reply| {
        const behaviors = [_]fixture.Behavior{.{ .replies = &.{reply} }};
        var server = try fixture.Fixture.init(8, &behaviors);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .tendermint, .strategy = .{ .single = .{ .max_attempts = 1 } } });
        defer owner.deinit();
        var client = try rpc.RpcClient.init(a, url, .{ .protocol = .tendermint, .timeout_ms = 50, .exchange = .{ .context = owner, .fetch_fn = Bridge.fetch } });
        defer client.deinit();
        var tm: @import("../cosmos/tendermint.zig").Client = .{ .rpc_client = &client, .chain_id = "hyperlane-local", .compat = .v038 };
        if (tm.txIfPresent(hash(), false)) |value| {
            if (value) |owned| {
                var cleanup = owned;
                cleanup.deinit();
            }
            return error.AcceptedTransportFailureAsAbsence;
        } else |err| try std.testing.expect(err == error.RequestDeadlineExceeded or err == error.RpcPoolRetriesExhausted);
        try std.testing.expect(server.acceptedCount() >= 1);
        try server.check();
    }
}

fn replayTx(client: *@import("../cosmos/tendermint.zig").Client, strict: bool) !?rpc.RpcResponse {
    if (strict) return try client.tx(hash(), false);
    return client.txIfPresent(hash(), false);
}
test "configured Cosmos transaction absence shared cooperative read fork resumes typed envelopes" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]bool{ false, true }) |native| {
        const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = absence }};
        var server = try fixture.Fixture.init(8, &behaviors);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        var conf = chain(native, &.{url});
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        const runtime = try source.HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = library } });
        defer runtime.deinit();
        var budget: source.ReadReplay.ByteBudget = .{ .maximum = 1024 * 1024 };
        const parent = try source.Resources.open(a, &conf, &env, .{ .curl_library = library, .http_runtime = runtime, .read_budget = &budget });
        defer parent.deinit();
        const child = try parent.forkRead(a);
        defer child.deinit();
        try std.testing.expect(child.options.cooperative_reads and child.read_replay != null and child.rpc_pool == parent.rpc_pool and !child.rpc_pool_owned);
        var counts: EventCounts = .{};
        child.rpc_client.?.options.pool_observer = counts.observer();
        var timer = try std.time.Timer.start();
        var pending: usize = 0;
        for ([_]bool{ false, true }) |strict| {
            while (true) {
                if (timer.read() > 5 * std.time.ns_per_s) return error.CooperativeAbsenceTimeout;
                try child.beginReadPass(null);
                const value = replayTx(&child.clients.cosmos.tendermint, strict) catch |err| {
                    child.endReadPass(err);
                    if (err == error.PendingReadIo) {
                        pending += 1;
                        std.Thread.sleep(std.time.ns_per_ms);
                        continue;
                    }
                    if (strict and err == error.RpcError) break;
                    return err;
                };
                if (strict) {
                    var cleanup = value.?;
                    cleanup.deinit();
                    child.endReadPass(null);
                    return error.StrictTransactionAcceptedAbsence;
                }
                try std.testing.expect(value == null);
                try child.commitReadSection();
                child.endReadPass(null);
                break;
            }
        }
        try std.testing.expect(pending >= 2);
        try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
        try std.testing.expectEqual(@as(usize, 2), counts.upstream_errors.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), counts.provider_failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), budget.used);
        var cancel = std.atomic.Value(bool).init(true);
        try std.testing.expectError(error.RequestCancelled, child.beginReadPass(&cancel));
        try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
        try server.check();
    }
}
