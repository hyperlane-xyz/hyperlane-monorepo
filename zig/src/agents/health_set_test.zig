const std = @import("std");
const health = @import("health_set.zig");
const common = @import("health_metrics.zig");
const settings = @import("../settings/root.zig");
const types = @import("../settings/types.zig");
const metrics = @import("../ops/metrics.zig");
const supervisor = @import("../runtime/supervisor.zig");
const fixtures = @import("../evm/pool_testing.zig");
const a = std.testing.allocator;
const Wallets = struct {
    value: health.PublicWallet = .{},
    resolutions: usize = 0,
    fn get(context: *anyopaque, _: u32) !?common.WalletSource {
        const self: *Wallets = @ptrCast(@alignCast(context));
        self.resolutions += 1;
        return self.value.interface();
    }
    fn interface(self: *Wallets) health.Wallets {
        return .{ .context = self, .get_fn = get };
    }
};

test "configured scraper public identity is ready for the first actual balance read" {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixtures.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chains = [_]types.Chain{@import("chain_source_testing.zig").chainFor(&.{url})};
    // Public, disposable fixture key used by the repository's Anvil tests.
    chains[0].signer = .{ .hex_key = @splat(0x11) };
    var configured = roleSettings(&chains, .scraper);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "fixture" });
    defer registry.deinit();
    const set = try health.Set.open(a, &configured, &environment, registry, &.{}, .{ .source = .{ .curl_library = library, .allow_insecure_loopback = true } });
    defer set.deinit();
    try std.testing.expect(!set.nodes[0].identity_ready);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    var cancel = std.atomic.Value(bool).init(false);
    var timer = try std.time.Timer.start();
    while (true) {
        const report = set.descriptors()[0].run(set.descriptors()[0].context, .{ .unix_ms = 1_700_000_000_000, .monotonic_ms = 0 }, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthRoleFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        try std.testing.expectEqual(@as(u64, 1), report.work);
        break;
    }
    try std.testing.expect(set.nodes[0].identity_ready);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "wallet_name=\"scraper\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_wallet_balance{") != null);
    try std.testing.expect(set.nodes[0].identity.?.manager == null and set.nodes[0].identity.?.transport == null and set.nodes[0].identity.?.native == null);
}

test "configured scraper remote public identity yields before wallet snapshot and cancels cleanly" {
    const identity_fixture = @import("public_identity_test.zig");
    const response = try identity_fixture.publicResponse(true);
    defer a.free(response);
    var backend: identity_fixture.PublicKeyOnly = .{ .response = response, .google = true, .lease_pending = true, .pending = true };
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixtures.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chains = [_]types.Chain{@import("chain_source_testing.zig").chainFor(&.{url})};
    chains[0].signer = .{ .gcp = .{ .key_version_name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" } };
    var configured = roleSettings(&chains, .scraper);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const registry = try metrics.Registry.init(a, .scraper, .{ .base_version = "fixture" });
    defer registry.deinit();
    const options: health.Options = .{ .source = .{ .curl_library = library, .allow_insecure_loopback = true }, .identity_options = .{ .credentials_provider = backend.provider() } };
    const set = try health.Set.open(a, &configured, &environment, registry, &.{}, options);
    defer set.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    const task = set.descriptors()[0];
    for (0..2) |attempt| {
        try std.testing.expectError(error.PendingReadIo, task.run(task.context, .{ .unix_ms = 1_700_000_000_000 + attempt * 1000, .monotonic_ms = 0 }, &cancel));
        try std.testing.expect(!set.nodes[0].identity_ready and !set.monitors[0].wallet_snapshotted);
        try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    }
    var timer = try std.time.Timer.start();
    while (true) {
        const report = task.run(task.context, .{ .unix_ms = 1_700_000_002_000, .monotonic_ms = 0 }, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthRoleFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        try std.testing.expectEqual(@as(u64, 1), report.work);
        break;
    }
    try std.testing.expectEqual(@as(usize, 2), backend.calls);
    try std.testing.expectEqual(@as(usize, 3), backend.leases);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    try std.testing.expect(set.nodes[0].identity.?.manager == null and set.nodes[0].identity.?.native == null and set.nodes[0].identity.?.timer == null);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "wallet_address=\"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a\",wallet_name=\"scraper\"") != null);

    // A separate still-pending initialization must retire without any auth or
    // chain read after the monitor's stable cancellation token is stopped.
    backend.lease_pending = true;
    const pending = try health.Set.open(a, &configured, &environment, registry, &.{}, options);
    defer pending.deinit();
    const pending_task = pending.descriptors()[0];
    try std.testing.expectError(error.PendingReadIo, pending_task.run(pending_task.context, .{ .unix_ms = 1_700_000_003_000, .monotonic_ms = 0 }, &cancel));
    pending_task.stop_fn.?(pending_task.context);
    try std.testing.expectError(error.RequestCancelled, pending_task.run(pending_task.context, .{ .unix_ms = 1_700_000_003_000, .monotonic_ms = 0 }, &cancel));
    try std.testing.expect(pending.nodes[0].identity.?.timer == null and pending.nodes[0].identity.?.manager == null);
    try std.testing.expectEqual(@as(usize, 2), backend.calls);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
}
fn reply(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    const method = parsed.value.object.get("method").?.string;
    const result: []const u8 = if (std.mem.eql(u8, method, "eth_getBalance")) "\"0x1bc16d674ec80000\"" else if (std.mem.eql(u8, method, "eth_getBlockByNumber")) "{\"number\":\"0x20\",\"hash\":\"0x" ++ "11" ** 32 ++ "\",\"parentHash\":\"0x" ++ "22" ** 32 ++ "\",\"timestamp\":\"0x1\",\"baseFeePerGas\":\"0x10\"}" else return error.UnexpectedHealthRoleRequest;
    return std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ parsed.value.object.get("id").?.integer, result });
}
fn roleSettings(chains: []types.Chain, role: types.Role) settings.Settings {
    var configured: settings.Settings = undefined;
    configured.chains = chains;
    configured.role = switch (role) {
        .relayer => .{ .relayer = std.mem.zeroes(types.Relayer) },
        .scraper => .{ .scraper = std.mem.zeroes(types.Scraper) },
        .validator => blk: {
            const value: types.Validator = .{ .rpcs = &.{}, .origin_chain = chains[1].name, .db = "", .signer = .node, .checkpoint_syncer = .{ .local_storage = "" }, .interval = 5, .max_sign_concurrency = 1, .lightweight = false, .allow_public_rpcs = false, .skip_announce = true, .websocket_url = null, .checkpoint_consensus = null };
            break :blk .{ .validator = value };
        },
    };
    return configured;
}

test "health role set selects destinations indexed chains and wallet-free validator origin without constructor requests" {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixtures.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chains = [_]types.Chain{ @import("chain_source_testing.zig").chainFor(&.{url}), @import("chain_source_testing.zig").chainFor(&.{url}) };
    chains[0].name = "first";
    chains[1].name = "second";
    chains[1].domain = 2;
    // No role/descriptor constructor may resolve these credentials. Scraper's
    // configured public identity is lazy on its supervised provider boundary.
    for (&chains) |*chain| {
        chain.signer = .{ .gcp = .{ .key_version_name = "must-not-resolve" } };
        chain.identity = chain.signer;
        chain.ccs_signer = chain.signer;
    }
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    for ([_]types.Role{ .relayer, .scraper, .validator }) |role| {
        var configured = roleSettings(&chains, role);
        const registry = try metrics.Registry.init(a, @enumFromInt(@intFromEnum(role)), .{ .base_version = "fixture" });
        defer registry.deinit();
        var wallets: Wallets = .{};
        const set = try health.Set.open(a, &configured, &environment, registry, &.{}, .{ .source = .{ .curl_library = library, .allow_insecure_loopback = true }, .wallets = if (role == .scraper) null else wallets.interface() });
        defer set.deinit();
        try std.testing.expectEqual(@as(usize, if (role == .validator) 1 else 2), set.descriptors().len);
        try std.testing.expectEqual(@as(usize, if (role == .relayer) 2 else 0), wallets.resolutions);
        try std.testing.expectEqualStrings(if (role == .validator) "second" else "first", set.monitors[0].options.chain);
        for (set.nodes) |node| {
            try std.testing.expect(node.adapter == null);
            try std.testing.expect(node.options.http_runtime == set.owned_runtime);
            try std.testing.expect(node.options.read_budget == &set.read_budget);
        }
        if (role == .validator) for (set.monitors) |task| try std.testing.expect(task.options.wallet == null);
        if (role == .scraper) for (set.monitors, set.nodes) |task, node| {
            try std.testing.expect(task.options.wallet != null and node.identity != null);
            try std.testing.expect(!node.identity_ready);
        };
        try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
        const rendered = try registry.render(a);
        defer a.free(rendered);
        try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_block_height{") == null);
        try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_wallet_balance{") == null);
    }
    // A later chain constructor failure must retire already-created monitors
    // and providers without touching the endpoint or leaking their owners.
    var configured = roleSettings(&chains, .relayer);
    chains[1].rpc_urls = &.{};
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    const isolated = try health.Set.open(a, &configured, &environment, registry, &.{}, .{ .source = .{ .curl_library = library, .allow_insecure_loopback = true } });
    defer isolated.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.InvalidChainSourceEndpoints, isolated.monitors[1].step(0, &cancel));
    try std.testing.expect(isolated.nodes[1].adapter == null);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    var timer = try std.time.Timer.start();
    while (true) {
        const result = isolated.monitors[0].step(0, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthRoleFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        try std.testing.expectEqual(@as(u64, 1), result.work);
        break;
    }
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_block_height{chain=\"first\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_block_height{chain=\"second\"") == null);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
}

test "health role set actual shared runtime observes late public wallet and drains before providers" {
    try sharedRuntimeFixture(false);
}

test "health role fixture failure unwinds suspended supervisor before registry and providers" {
    // Missing optional native transport skips at the test boundary; expectError
    // below still requires the injected failure after fixture initialization.
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    try std.testing.expectError(error.InjectedHealthFixtureFailure, sharedRuntimeFixture(true));
}

fn sharedRuntimeFixture(fail_before_shutdown: bool) !void {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{.{ .replies = &.{ .{ .body = "" }, .{ .body = "" }, .{ .body = "" }, .{ .body = "", .stall = true } }, .response_fn = reply }};
    var server = try fixtures.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chains = [_]types.Chain{@import("chain_source_testing.zig").chainFor(&.{url})};
    var configured = roleSettings(&chains, .relayer);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    const runtime = try @import("../net/http_runtime.zig").Runtime.start(a, .{ .multi = .{ .library_path = library }, .max_sessions = 8 });
    defer runtime.deinit();
    var budget: @import("../net/read_replay.zig").ByteBudget = .{};
    var wallets: Wallets = .{};
    const tip_cache = try @import("../net/dynamic_tip_cache.zig").Cache.init(a, .{});
    defer tip_cache.deinit();
    // Even if a caller supplies indexing options, actual health reads stay fresh.
    const set = try health.Set.open(a, &configured, &environment, registry, &.{}, .{ .source = .{ .curl_library = library, .allow_insecure_loopback = true, .http_runtime = runtime, .read_budget = &budget, .dynamic_tip_cache = tip_cache, .indexer_tip_cache = true }, .wallets = wallets.interface() });
    var set_open = true;
    defer if (set_open) set.deinit();
    try std.testing.expect(set.owned_runtime == null);
    try std.testing.expect(set.nodes[0].options.http_runtime == runtime);
    try std.testing.expect(set.nodes[0].options.read_budget == &budget);
    var cancel = std.atomic.Value(bool).init(false);
    var completed: usize = 0;
    var timer = try std.time.Timer.start();
    while (completed < 2) {
        const report = set.monitors[0].step(0, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthRoleFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        completed += @intCast(report.work);
        if (completed == 1) try wallets.value.publish("0x1111111111111111111111111111111111111111");
    }
    try std.testing.expectEqual(@as(usize, 3), server.acceptedCount());
    try std.testing.expect(set.nodes[0].adapter.?.owner.chain.signer == null and set.nodes[0].adapter.?.owner.chain.identity == null and set.nodes[0].adapter.?.owner.chain.ccs_signer == null);
    try std.testing.expect(!set.nodes[0].adapter.?.owner.options.indexer_tip_cache);
    const rendered = try registry.render(a);
    defer a.free(rendered);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "wallet_address=\"0x1111111111111111111111111111111111111111\",wallet_name=\"relayer\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_block_height{chain=\"rpc-parallel-fixture\"") != null);
    // Supervisor owns copied descriptors; stopping/joining it precedes any
    // monitor/provider/free and retires every retained callback first.
    const owner = try supervisor.Supervisor.start(a, set.descriptors());
    var owner_open = true;
    defer if (owner_open) {
        owner.stop();
        owner.deinit();
    };
    timer.reset();
    while (true) {
        _ = try owner.tick(.{ .monotonic_ms = 60_000, .unix_ms = 60_000 });
        const state = try owner.health(0);
        if (server.acceptedCount() == 4 and state.suspended > 0) break;
        if (timer.read() > 3 * std.time.ns_per_s) return error.HealthRoleFixtureTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // Fourth physical request is genuinely stalled with an external retained
    // read journal. Stop its common-monitor cancel flag, drain Supervisor jobs,
    // then provider teardown must cancel/drain the still-owned native request.
    if (fail_before_shutdown) return error.InjectedHealthFixtureFailure;
    owner.stop();
    while (!owner.drained()) _ = try owner.tick(.{ .monotonic_ms = 60_000, .unix_ms = 60_000 });
    owner.deinit();
    owner_open = false;
    set.deinit();
    set_open = false;
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try server.check();
}

test "health public wallet publication copies atomically and exposes only caller-owned text" {
    const Writer = struct {
        value: *health.PublicWallet,
        fn run(self: *@This()) void {
            for (0..1000) |n| self.value.publish(if (n % 2 == 0) "aaaaaaaaaaaaaaaa" else "bbbbbbbbbbbbbbbb") catch unreachable;
        }
    };
    var wallet: health.PublicWallet = .{};
    const source = wallet.interface();
    var buffer: [256]u8 = undefined;
    try std.testing.expect(try source.load_into_fn.?(source.context, &buffer) == null);
    var input = "aaaaaaaaaaaaaaaa".*;
    try wallet.publish(&input);
    @memset(&input, 'x');
    try std.testing.expectEqualStrings("aaaaaaaaaaaaaaaa", (try source.load_into_fn.?(source.context, &buffer)).?);
    var writer: Writer = .{ .value = &wallet };
    const thread = try std.Thread.spawn(.{}, Writer.run, .{&writer});
    defer thread.join();
    for (0..2000) |_| {
        const text = (try source.load_into_fn.?(source.context, &buffer)).?;
        try std.testing.expect(text.ptr == &buffer);
        try std.testing.expect(std.mem.allEqual(u8, text, 'a') or std.mem.allEqual(u8, text, 'b'));
    }
}

test "health provider constructor OOM is isolated and recovery clears only its shared critical reason" {
    const critical = @import("../ops/critical_metrics.zig");
    const State = struct {
        tracker: critical.Tracker,
        fn get(context: *anyopaque, _: u32) !?*critical.Tracker {
            const self: *@This() = @ptrCast(@alignCast(context));
            return &self.tracker;
        }
    };
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixtures.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chains = [_]types.Chain{@import("chain_source_testing.zig").chainFor(&.{url})};
    var configured = roleSettings(&chains, .relayer);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var state: State = .{ .tracker = .{ .registry = registry, .chain = chains[0].name } };
    state.tracker.record(.destination);
    const set = try health.Set.open(a, &configured, &environment, registry, &.{}, .{ .source = .{ .curl_library = library, .allow_insecure_loopback = true }, .criticals = .{ .context = &state, .get_fn = State.get } });
    defer set.deinit();
    var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
    set.nodes[0].allocator = failing.allocator();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.OutOfMemory, set.monitors[0].step(0, &cancel));
    try std.testing.expect(set.nodes[0].adapter == null);
    const metrics_bit: u16 = @as(u16, 1) << @intFromEnum(critical.Reason.destination_metrics);
    const destination_bit: u16 = @as(u16, 1) << @intFromEnum(critical.Reason.destination);
    try std.testing.expectEqual(metrics_bit | destination_bit, state.tracker.reasons);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    set.nodes[0].allocator = a;
    var timer = try std.time.Timer.start();
    while (true) {
        const result = set.monitors[0].step(0, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthRoleFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        try std.testing.expectEqual(@as(u64, 1), result.work);
        break;
    }
    try std.testing.expectEqual(destination_bit, state.tracker.reasons);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_critical_error{chain=\"rpc-parallel-fixture\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_block_height{chain=\"rpc-parallel-fixture\"") != null);
}
