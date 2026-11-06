const std = @import("std");
const control = @import("control.zig");
const settings = @import("../../settings/root.zig");
const types = @import("../../settings/types.zig");
const denylist = @import("../../ops/runtime_denylist.zig");
const A = std.mem.Allocator;

fn relayerSettings() types.Relayer {
    return .{
        .gas_payment_enforcement = &.{},
        .whitelist = &.{},
        .blacklist = &.{},
        .address_blacklist = &.{},
        .metric_app_contexts = &.{},
        .ism_cache_configs = &.{},
        .relay_api_rate_limit_max_requests = null,
        .relay_api_rate_limit_window_secs = null,
        .relay_api_cors_origins = &.{},
        .relay_chains = &.{},
        .db = "unused",
        .transaction_gas_limit = null,
        .skip_transaction_gas_limit_for = &.{},
        .allow_local_checkpoint_syncers = false,
        .allow_contract_call_caching = false,
        .max_message_retries = 10,
        .tx_id_indexing_enabled = false,
        .igp_indexing_enabled = false,
        .runtime_denylist_url = null,
        .runtime_denylist_poll_interval_seconds = 60,
        .websocket_url = null,
        .websocket_authority_enabled = false,
        .relay_api_enabled = false,
        .relay_api_port = null,
    };
}

const Fixture = struct {
    configured: settings.Settings,
    environment: std.process.EnvMap,
    runtime: denylist.RuntimeDenylist,
    hub: control.Hub,
    chain: settings.Chain,
    lane: *control.Control,

    fn init(a: A) !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        const chains = try a.alloc(settings.Chain, 1);
        errdefer a.free(chains);
        self.* = .{
            .configured = undefined,
            .environment = std.process.EnvMap.init(a),
            .runtime = try denylist.RuntimeDenylist.init(a, null),
            .hub = undefined,
            .chain = undefined,
            .lane = undefined,
        };
        errdefer self.environment.deinit();
        errdefer self.runtime.deinit();
        chains[0].name = "destination";
        chains[0].domain = 2;
        chains[0].protocol = .ethereum;
        self.configured.chains = chains;
        self.configured.role = .{ .relayer = relayerSettings() };
        self.chain = chains[0];
        self.hub = try control.Hub.init(a, &self.configured, &self.environment, undefined, undefined, null, &self.runtime);
        errdefer self.hub.deinit();
        self.lane = try control.Control.init(&self.hub, &chains[0]);
        return self;
    }

    fn deinit(self: *Fixture, a: A) void {
        self.lane.deinit();
        self.hub.deinit();
        self.runtime.deinit();
        self.environment.deinit();
        a.free(self.configured.chains);
        a.destroy(self);
    }
};

test "relayer control declarations" {
    std.testing.refAllDecls(control);
}

test "control construction performs no origin or signer access" {
    var fixture = try Fixture.init(std.testing.allocator);
    defer fixture.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), fixture.hub.controls.items.len);
    try std.testing.expectEqual(@as(usize, 0), fixture.lane.ledger.rules.items.len);
    try std.testing.expect(!fixture.hub.nonceOwner().contains_fn(fixture.hub.nonceOwner().context, 99));
    try std.testing.expect(fixture.hub.nonceOwner().contains_fn(fixture.hub.nonceOwner().context, 2));
}

const QueuedGas = struct {
    owner: @import("../../ops/admin/api.zig").GasOwner,
    cancel: std.atomic.Value(bool) = .init(false),
    started: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    rule: @import("../../ops/admin/api.zig").GasRule,

    fn run(self: *QueuedGas) void {
        self.started.store(true, .release);
        self.owner.add_fn(self.owner.context, std.testing.allocator, self.rule, &self.cancel) catch |err| {
            self.failure = err;
        };
    }
};

test "queued cancellation skips gas mutation and retires independent request memory" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit(a);
    const domains = try a.dupe(u32, &.{7});
    const rules = try a.alloc(types.Rule, 1);
    rules[0] = .{ .origin_domain = .{ .values = domains } };
    var caller: QueuedGas = .{ .owner = fixture.hub.gasOwner(), .rule = .{ .policy = .none, .matching_list = rules } };
    const thread = try std.Thread.spawn(.{}, QueuedGas.run, .{&caller});
    while (!caller.started.load(.acquire) or !fixture.lane.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    caller.cancel.store(true, .release);
    thread.join();
    try std.testing.expectEqual(error.RequestCancelled, caller.failure.?);
    a.free(rules);
    a.free(domains);
    try std.testing.expectEqual(@as(usize, 0), fixture.lane.ledger.rules.items.len);
}

fn allocationSweep(a: A) !void {
    const fixture = try Fixture.init(a);
    defer fixture.deinit(a);
}

test "control pre-init allocation failures clean hub lane and policy ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}

test "control policy initialization metrics follow actual successful first constructor and exclude allocation failure" {
    const metric = @import("../../ops/metrics.zig");
    const initialization = @import("../../ops/init_metrics.zig");
    const Policy = @import("../relay_policy.zig").Policy;
    const ObservedLane = struct {
        origins: [1]struct { policy: ?Policy = null } = .{.{}},
        adapter: initialization.Adapter,
        observations: usize = 0,
        pub fn observeGasEnforcer(self: *@This(), index: usize, elapsed_ns: u64) void {
            std.debug.assert(index == 0);
            self.observations += 1;
            self.adapter.observer().completed(.gas_payment_enforcer, elapsed_ns);
        }
    };
    const a = std.testing.allocator;
    const registry = try metric.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var allocator = std.testing.FailingAllocator.init(a, .{});
    const fixture = try Fixture.init(allocator.allocator());
    defer fixture.deinit(allocator.allocator());
    var lane: ObservedLane = .{ .adapter = .{ .registry = registry, .chain = "origin", .role = .origin } };
    defer if (lane.origins[0].policy) |*value| value.deinit();
    allocator.fail_index = allocator.alloc_index;
    try std.testing.expectError(error.OutOfMemory, fixture.lane.ensurePolicy(&lane, 0));
    try std.testing.expect(lane.origins[0].policy == null);
    try std.testing.expectEqual(@as(usize, 0), lane.observations);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expect(std.mem.indexOf(u8, text, "entity=\"gas_payment_enforcer\"") == null);
    }
    allocator.fail_index = std.math.maxInt(usize);
    try fixture.lane.ensurePolicy(&lane, 0);
    try fixture.lane.ensurePolicy(&lane, 0);
    try std.testing.expectEqual(@as(usize, 1), lane.observations);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "chain=\"origin\",role=\"origin\",entity=\"gas_payment_enforcer\"") != null);
}
