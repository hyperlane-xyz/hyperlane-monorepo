//! Source relayer component construction latency. Call only for a real completed
//! component; no constructor/descriptor allocation creates synthetic samples.
const std = @import("std");
const metrics = @import("metrics.zig");
pub const Role = enum { origin, destination };
pub const Entity = enum {
    gas_payment_enforcer,
    prover_sync,
    message_sync,
    interchain_gas_payment_sync,
    merkle_tree_hook_sync,
    validator_announce,
    application_operation_verifier,
    ccip_signers,
    dispatcher_and_entrypoint,
    mailbox,
};
pub const Observer = struct {
    context: *anyopaque,
    completed_fn: *const fn (*anyopaque, Entity, u64) void,
    pub fn completed(self: Observer, entity: Entity, elapsed_ns: u64) void {
        self.completed_fn(self.context, entity, elapsed_ns);
    }
};
pub const Adapter = struct {
    registry: *metrics.Registry,
    /// Configuration-owned immutable label; retain through all constructors.
    chain: []const u8,
    role: Role,
    failures: std.atomic.Value(u64) = .init(0),
    pub fn observer(self: *Adapter) Observer {
        return .{ .context = self, .completed_fn = complete };
    }
    fn complete(context: *anyopaque, entity: Entity, elapsed_ns: u64) void {
        const self: *Adapter = @ptrCast(@alignCast(context));
        self.record(entity, elapsed_ns) catch |err| {
            if (self.failures.fetchAdd(1, .monotonic) == 0) std.log.warn("initialization metric update failed: {s}", .{@errorName(err)});
        };
    }
    pub fn record(self: *Adapter, entity: Entity, elapsed_ns: u64) !void {
        const origin_entity = switch (entity) {
            .gas_payment_enforcer, .prover_sync, .message_sync, .interchain_gas_payment_sync, .merkle_tree_hook_sync, .validator_announce => true,
            else => false,
        };
        if (origin_entity != (self.role == .origin)) return error.InvalidInitializationMetricEntity;
        try self.registry.update("hyperlane_chain_init_latency", &.{ self.chain, @tagName(self.role), @tagName(entity) }, .{ .set_int = @intCast(elapsed_ns / std.time.ns_per_ms) });
    }
};

fn sample(wire: []const u8, entity: []const u8) !?i64 {
    var lines = std.mem.splitScalar(u8, wire, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "hyperlane_chain_init_latency{") or std.mem.indexOf(u8, line, entity) == null) continue;
        const at = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidSample;
        return try std.fmt.parseInt(i64, line[at + 1 ..], 10);
    }
    return null;
}
test "initialization adapter has no sample until actual completion and preserves Source millisecond gauge labels" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    var adapter: Adapter = .{ .registry = registry, .chain = "origin", .role = .origin };
    {
        const wire = try registry.render(a);
        defer a.free(wire);
        try std.testing.expect((try sample(wire, "prover_sync")) == null);
    }
    adapter.observer().completed(.prover_sync, 12_999_999);
    {
        const wire = try registry.render(a);
        defer a.free(wire);
        try std.testing.expectEqual(@as(?i64, 12), try sample(wire, "prover_sync"));
        try std.testing.expect(std.mem.indexOf(u8, wire, "chain=\"origin\",role=\"origin\",entity=\"prover_sync\"") != null);
    }
    try adapter.record(.prover_sync, 8_000_000);
    try std.testing.expectError(error.InvalidInitializationMetricEntity, adapter.record(.mailbox, 1));
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(?i64, 8), try sample(wire, "prover_sync"));
    try std.testing.expect((try sample(wire, "mailbox")) == null);
}
test "actual submillisecond destination completion may be zero and telemetry failure cannot fail construction" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0", .max_series = 1 });
    defer registry.deinit();
    var adapter: Adapter = .{ .registry = registry, .chain = "remote", .role = .destination };
    adapter.observer().completed(.mailbox, 999_999);
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(?i64, 0), try sample(wire, "mailbox"));
    // Test the fallible API directly: the nonthrowing callback catches this same
    // registry error without changing the completed component's business result.
    try std.testing.expectError(error.MetricSeriesLimit, adapter.record(.dispatcher_and_entrypoint, 1_000_000));
    adapter.observer().completed(.dispatcher_and_entrypoint, 1_000_000);
    try std.testing.expectEqual(@as(u64, 1), adapter.failures.load(.monotonic));
}
