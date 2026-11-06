const std = @import("std");
const Pool = @import("evm/pool.zig");
const fixture = @import("evm/pool_testing.zig");
const replay = @import("net/read_replay.zig");
const rpc = @import("evm/provider.zig");
const A = std.mem.Allocator;
const resources = @import("agents/chain_source.zig");
const chain_fixture = @import("agents/chain_source_testing.zig");
const settings = @import("settings/types.zig");
const HttpRuntime = @import("net/http_runtime.zig");
const http = @import("cloud/http.zig");

const body = "{\"jsonrpc\":\"2.0\",\"id\":9007199254740993,\"method\":\"block\",\"params\":{\"height\":\"42\"}}";
const result = "{\"jsonrpc\":\"2.0\",\"id\":9007199254740993,\"result\":{\"height\":\"42\",\"exact\":9007199254740993}}";
const stalled = [_]fixture.Reply{.{ .body = "", .stall = true }};
const good = [_]fixture.Reply{.{ .body = result }};
const stalled_then_good = [_]fixture.Behavior{ .{ .replies = &stalled }, .{ .replies = &good } };

const Harness = struct {
    allocator: A,
    server: fixture.Fixture,
    urls: [2][]const u8 = undefined,
    pool: *Pool.Pool,

    fn init(a: A, library: []const u8, behaviors: []const fixture.Behavior, physical_ms: ?u32) !*Harness {
        const self = try a.create(Harness);
        errdefer a.destroy(self);
        self.allocator = a;
        self.server = try fixture.Fixture.init(32, behaviors);
        errdefer self.server.deinit();
        var initialized: usize = 0;
        errdefer for (self.urls[0..initialized]) |url| a.free(url);
        for (&self.urls, 0..) |*url, i| {
            url.* = try self.server.url(a, i);
            initialized += 1;
        }
        try self.server.start();
        var config = fixture.config(library, &self.urls, .{ .fallback = .{ .attempt_timeout_ms = physical_ms, .retry_delay_ms = 1 } });
        config.height_protocol = .tendermint;
        self.pool = try Pool.Pool.start(a, config);
        return self;
    }
    fn deinit(self: *Harness) void {
        self.pool.deinit();
        self.server.deinit();
        for (self.urls) |url| self.allocator.free(url);
        self.allocator.destroy(self);
    }
    fn drained(self: *Harness) !void {
        var timer = try std.time.Timer.start();
        while (true) {
            self.pool.mutex.lock();
            const empty = for (self.pool.sessions) |entry| {
                if (entry != null) break false;
            } else true;
            self.pool.mutex.unlock();
            if (empty) break;
            if (timer.read() > 5 * std.time.ns_per_s) return error.CosmosPoolDidNotRetire;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try self.server.check();
    }
    fn accepted(self: *Harness) !void {
        var timer = try std.time.Timer.start();
        while (self.server.pathHits(0) == 0) {
            if (timer.read() > 5 * std.time.ns_per_s) return error.CosmosFirstPeerNotAccepted;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try std.testing.expectEqual(@as(usize, 0), self.server.pathHits(1));
    }
};

fn cosmosChain(urls: []const []const u8, native: bool) settings.Chain {
    var chain = chain_fixture.chainFor(urls);
    chain.protocol = if (native) .cosmosnative else .cosmos;
    chain.chain_id = "fixture-1";
    chain.grpc_urls = urls[0..1];
    const configuration: settings.Cosmos = .{ .chain_id = "fixture-1", .bech32_prefix = "cosmos", .gas_price = .{ .amount = "0.01", .denom = "uatom" }, .contract_address_bytes = 32, .gas_multiplier = 1.3, .compat_mode = "0.38", .canonical_asset = "uatom" };
    chain.connection = if (native) .{ .cosmosnative = configuration } else .{ .cosmos = configuration };
    return chain;
}

const ResourceHarness = struct {
    allocator: A,
    server: fixture.Fixture,
    urls: [2][]const u8 = undefined,
    chain: settings.Chain,
    env: std.process.EnvMap,
    runtime: ?*HttpRuntime.Runtime = null,
    network: *resources.Resources,
    budget: replay.ByteBudget = .{ .maximum = 1024 * 1024 },

    fn init(a: A, library: []const u8, cooperative: bool, owner_ms: u32) !*ResourceHarness {
        const self = try a.create(ResourceHarness);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .server = try fixture.Fixture.init(32, &stalled_then_good), .chain = undefined, .env = std.process.EnvMap.init(a), .network = undefined };
        errdefer self.server.deinit();
        errdefer self.env.deinit();
        var initialized: usize = 0;
        errdefer for (self.urls[0..initialized]) |url| a.free(url);
        for (&self.urls, 0..) |*url, i| {
            url.* = try self.server.url(a, i);
            initialized += 1;
        }
        self.chain = cosmosChain(&self.urls, cooperative);
        try self.server.start();
        if (cooperative) self.runtime = try HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 4, .max_pending = 16, .max_response_bytes = 1024 * 1024, .max_request_bytes = 64 * 1024, .max_reserved_bytes = 16 * 1024 * 1024 }, .max_sessions = 16 });
        errdefer if (self.runtime) |runtime| runtime.deinit();
        self.network = try resources.Resources.open(a, &self.chain, &self.env, .{ .curl_library = library, .cooperative_reads = cooperative, .http_runtime = self.runtime, .read_budget = &self.budget, .allow_insecure_loopback = true, .request_timeout_ms = 20000, .read_attempt_timeout_ms = owner_ms, .rpc_max_response_bytes = 1024 * 1024 });
        errdefer self.network.deinit();
        self.network.rpc_client.?.next_id = 9007199254740993;
        try std.testing.expectEqual(@as(?u32, 20000), self.network.rpc_pool.?.config.strategy.fallback.attempt_timeout_ms);
        try std.testing.expect(self.network.rpc_pool.?.config.strategy.fallback.hedge == null);
        if (cooperative) {
            try std.testing.expect(self.network.read_replay.?.config.use_owner_timeout);
        } else try std.testing.expect(self.network.read_replay == null);
        return self;
    }
    fn deinit(self: *ResourceHarness) void {
        self.network.deinit();
        self.env.deinit();
        if (self.runtime) |runtime| runtime.deinit();
        self.server.deinit();
        for (self.urls) |url| self.allocator.free(url);
        self.allocator.destroy(self);
    }
    fn read(self: *ResourceHarness, cancel: ?*const std.atomic.Value(bool)) !rpc.RpcResponse {
        try self.network.beginReadPass(cancel);
        var failure: ?anyerror = null;
        defer self.network.endReadPass(failure);
        return self.network.clients.cosmos.tendermint.rpc_client.call("block", .{ .height = "42" }) catch |err| {
            failure = err;
            return err;
        };
    }
    fn finish(self: *ResourceHarness, cancel: ?*const std.atomic.Value(bool)) !rpc.RpcResponse {
        var timer = try std.time.Timer.start();
        while (true) return self.read(cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 40 * std.time.ns_per_s) return error.CosmosResourceFixtureDeadline;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
    }
    fn drained(self: *ResourceHarness) !void {
        var timer = try std.time.Timer.start();
        while (true) {
            const pool = self.network.rpc_pool.?;
            pool.mutex.lock();
            const empty = for (pool.sessions) |entry| {
                if (entry != null) break false;
            } else true;
            pool.mutex.unlock();
            if (empty) break;
            if (timer.read() > 5 * std.time.ns_per_s) return error.CosmosResourcePoolDidNotRetire;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try self.server.check();
        try std.testing.expectEqual(@as(usize, 0), self.budget.used);
    }
};

fn options(cancel: ?*const std.atomic.Value(bool)) rpc.Options {
    return .{ .timeout_ms = 20000, .connect_timeout_ms = 5000, .max_response_bytes = 1024 * 1024, .cancel = cancel };
}

fn read(owner: *replay.Replay, cancel: ?*const std.atomic.Value(bool)) !rpc.WireResponse {
    try owner.beginPass(cancel);
    var failure: ?anyerror = null;
    defer owner.endPass(failure);
    return owner.fetch(std.testing.allocator, body, options(cancel)) catch |err| {
        failure = err;
        return err;
    };
}
fn finish(owner: *replay.Replay, cancel: ?*const std.atomic.Value(bool)) !rpc.WireResponse {
    var timer = try std.time.Timer.start();
    while (true) {
        return read(owner, cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 40 * std.time.ns_per_s) return error.CosmosReadFixtureDeadline;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
    }
}

test "Cosmos RPC cooperative Resources full20s timeout reaches healthy second peer within retained120s owner" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try ResourceHarness.init(a, library, true, 120000);
    defer h.deinit();
    var timer = try std.time.Timer.start();
    try std.testing.expectError(error.PendingReadIo, h.read(null));
    var response = try h.finish(null);
    defer response.deinit();
    try std.testing.expect(timer.read() >= 19500 * std.time.ns_per_ms);
    try std.testing.expectEqualStrings("42", response.value().object.get("height").?.string);
    try std.testing.expectEqual(@as(i64, 9007199254740993), response.value().object.get("exact").?.integer);
    try std.testing.expectEqual(@as(usize, 1), h.server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 1), h.server.pathHits(1));
    for (h.server.records[0..2]) |*record| try std.testing.expectEqualStrings(body, record.bodyText());
    try std.testing.expectEqual(@as(usize, 0), h.network.read_replay.?.entries.items.len);
    try h.drained();
}

test "Cosmos RPC owner-clamped deadline expires on first peer without contacting second" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try Harness.init(a, library, &stalled_then_good, 20000);
    defer h.deinit();
    var owner = try replay.Replay.init(a, h.pool, .{ .max_attempt_ms = 100, .use_owner_timeout = true });
    defer owner.deinit();
    try std.testing.expectError(error.PendingReadIo, read(&owner, null));
    try h.accepted();
    try std.testing.expectError(error.RequestDeadlineExceeded, finish(&owner, null));
    try h.drained();
    try std.testing.expectEqual(@as(usize, 0), h.server.pathHits(1));
    try std.testing.expectEqual(@as(usize, 0), owner.entries.items.len);
}

test "Cosmos RPC direct Resources full20s timeout preserves ordered120s actual owner deadline" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try ResourceHarness.init(a, library, false, 120000);
    defer h.deinit();
    h.network.rpc_deadline_ns = (try http.rpcNowNs()) + 120 * std.time.ns_per_s;
    h.network.http.rpc_read_owner = .{ .deadline_ns = h.network.rpc_deadline_ns.? };
    var timer = try std.time.Timer.start();
    var response = try h.finish(null);
    defer response.deinit();
    try std.testing.expect(timer.read() >= 19500 * std.time.ns_per_ms);
    try std.testing.expectEqualStrings(result, response.bytes);
    try std.testing.expectEqual(@as(usize, 1), h.server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 1), h.server.pathHits(1));
    for (h.server.records[0..2]) |*record| try std.testing.expectEqualStrings(body, record.bodyText());
    try h.drained();
}

test "Cosmos RPC legacy aggregate deadline stays unchanged without a physical cap" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try Harness.init(a, library, &stalled_then_good, null);
    defer h.deinit();
    try std.testing.expectError(error.RequestDeadlineExceeded, h.pool.fetch(a, body, 75, 75, null, 1024 * 1024));
    try h.drained();
    try std.testing.expectEqual(@as(usize, 1), h.server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 0), h.server.pathHits(1));
}

test "Cosmos RPC expired owner and precancel have zero physical admissions" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try Harness.init(a, library, &stalled_then_good, 20000);
    defer h.deinit();
    var owner = try replay.Replay.init(a, h.pool, .{ .max_attempt_ms = 1, .use_owner_timeout = true });
    defer owner.deinit();
    try owner.beginPass(null);
    std.Thread.sleep(2 * std.time.ns_per_ms);
    try std.testing.expectError(error.RequestDeadlineExceeded, owner.fetch(a, body, options(null)));
    owner.endPass(error.RequestDeadlineExceeded);
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, owner.beginPass(&cancel));
    try h.drained();
    try std.testing.expectEqual(@as(usize, 0), h.server.acceptedCount());
}

test "Cosmos RPC cancellation after accepted first peer drains session and never admits second" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try Harness.init(a, library, &stalled_then_good, 20000);
    defer h.deinit();
    var owner = try replay.Replay.init(a, h.pool, .{ .max_attempt_ms = 120000, .use_owner_timeout = true });
    defer owner.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.PendingReadIo, read(&owner, &cancel));
    try h.accepted();
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, read(&owner, &cancel));
    try h.drained();
    try std.testing.expectEqual(@as(usize, 0), h.server.pathHits(1));
    try std.testing.expectEqual(@as(usize, 0), owner.entries.items.len);
}

test "Cosmos RPC section commit preserves owner deadline and byte quota release" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try Harness.init(a, library, &.{ .{ .replies = &good }, .{ .replies = &good } }, 20000);
    defer h.deinit();
    var budget: replay.ByteBudget = .{ .maximum = 1024 * 1024 };
    var owner = try replay.Replay.init(a, h.pool, .{ .max_attempt_ms = 100, .use_owner_timeout = true, .shared_budget = &budget });
    defer owner.deinit();
    var saved_start: ?std.time.Instant = null;
    while (true) {
        try owner.beginPass(null);
        const response = owner.fetch(a, body, options(null)) catch |err| {
            owner.endPass(err);
            if (err != error.PendingReadIo) return err;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        defer a.free(response.bytes);
        saved_start = owner.started;
        try std.testing.expect(budget.used > 0);
        try owner.commitReadSection();
        try std.testing.expectEqual(@as(usize, 0), budget.used);
        try std.testing.expectEqual(saved_start, owner.started);
        std.Thread.sleep(110 * std.time.ns_per_ms);
        try std.testing.expectError(error.RequestDeadlineExceeded, owner.fetch(a, body, options(null)));
        owner.endPass(error.RequestDeadlineExceeded);
        break;
    }
    try h.drained();
    try std.testing.expectEqual(@as(usize, 1), h.server.acceptedCount());
}

test "Cosmos RPC method errors retain existing ordered fallback and exact IDs" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const remote = [_]fixture.Reply{.{ .body = "{\"jsonrpc\":\"2.0\",\"id\":9007199254740993,\"error\":{\"code\":-32601,\"message\":\"method not found\"}}" }};
    const h = try Harness.init(a, library, &.{ .{ .replies = &remote }, .{ .replies = &good } }, 20000);
    defer h.deinit();
    var owner = try replay.Replay.init(a, h.pool, .{ .max_attempt_ms = 120000, .use_owner_timeout = true });
    defer owner.deinit();
    const response = try finish(&owner, null);
    defer a.free(response.bytes);
    try std.testing.expectEqualStrings(result, response.bytes);
    for (h.server.records[0..2]) |*record| try std.testing.expectEqualStrings(body, record.bodyText());
    try h.drained();
}

test "Cosmos RPC owner timeout opt-in requires physical cap and legacy defaults remain unchanged" {
    var runtime: Pool.Pool = undefined;
    runtime.config = .{ .library_path = "unused", .urls = &.{}, .strategy = .{ .fallback = .{} } };
    try std.testing.expectError(error.MissingReadReplayPhysicalTimeout, replay.Replay.init(std.testing.allocator, &runtime, .{ .use_owner_timeout = true }));
    runtime.config.strategy = .{ .single = .{} };
    try std.testing.expectError(error.MissingReadReplayPhysicalTimeout, replay.Replay.init(std.testing.allocator, &runtime, .{ .use_owner_timeout = true }));
    var legacy = try replay.Replay.init(std.testing.allocator, &runtime, .{});
    defer legacy.deinit();
    try std.testing.expect(!legacy.config.use_owner_timeout);
    try std.testing.expect((Pool.FallbackConfig{}).attempt_timeout_ms == null);
    for ([_]u32{ 0, 300001 }) |invalid| {
        try std.testing.expectError(error.InvalidRpcPoolConfig, Pool.Pool.start(std.testing.allocator, .{ .library_path = "unused", .urls = &.{"http://127.0.0.1:1"}, .strategy = .{ .fallback = .{ .attempt_timeout_ms = invalid } } }));
    }
}

test "Cosmos RPC production Resources clamps direct Clock and cooperative owner before second peer" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]bool{ false, true }) |cooperative| {
        const h = try ResourceHarness.init(a, library, cooperative, if (cooperative) 100 else 120000);
        defer h.deinit();
        if (!cooperative) {
            h.network.rpc_deadline_ns = (try http.rpcNowNs()) + 100 * std.time.ns_per_ms;
            h.network.http.rpc_read_owner = .{ .deadline_ns = h.network.rpc_deadline_ns.? };
        }
        try std.testing.expectError(error.RequestDeadlineExceeded, h.finish(null));
        try h.drained();
        try std.testing.expectEqual(@as(usize, 1), h.server.pathHits(0));
        try std.testing.expectEqual(@as(usize, 0), h.server.pathHits(1));
    }
}

test "Cosmos RPC production Resources rejects expired Clock and cooperative cancellation without admission" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]bool{ false, true }) |cooperative| {
        const h = try ResourceHarness.init(a, library, cooperative, 120000);
        defer h.deinit();
        if (!cooperative) {
            h.network.rpc_deadline_ns = (try http.rpcNowNs()) - 1;
            try std.testing.expectError(error.RequestDeadlineExceeded, h.read(null));
        }
        var cancel = std.atomic.Value(bool).init(true);
        try std.testing.expectError(error.RequestCancelled, h.read(&cancel));
        try h.drained();
        try std.testing.expectEqual(@as(usize, 0), h.server.acceptedCount());
    }
}

test "Cosmos RPC production Resources refuses capless or different-cap borrowed pools" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    for ([_]?u32{ null, 19999 }) |physical| {
        const h = try Harness.init(a, library, &stalled_then_good, physical);
        defer h.deinit();
        var chain = cosmosChain(&h.urls, false);
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        try std.testing.expectError(error.BorrowedRpcTimeoutMismatch, resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .borrowed_rpc_pool = h.pool, .request_timeout_ms = 20000 }));
        try std.testing.expectEqual(@as(usize, 0), h.server.acceptedCount());
    }
}

test "Cosmos RPC production read fork borrows capped pool and retains distinct absolute replay owner" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const h = try ResourceHarness.init(a, library, true, 120000);
    defer h.deinit();
    const child = try h.network.forkRead(a);
    defer child.deinit();
    try std.testing.expect(child.rpc_pool == h.network.rpc_pool);
    try std.testing.expect(h.network.rpc_pool_owned and !child.rpc_pool_owned);
    try std.testing.expect(child.read_replay.? != h.network.read_replay.?);
    try std.testing.expect(child.read_replay.?.config.use_owner_timeout);
    try std.testing.expectEqual(@as(?u32, 20000), child.rpc_pool.?.config.strategy.fallback.attempt_timeout_ms);
    try std.testing.expectEqual(@as(usize, 0), h.server.acceptedCount());
}
