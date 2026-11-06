//! Bounded polling driver. VM adapters supply finalized observations and one
//! checkpoint response per configured endpoint slot; transport errors never
//! shrink the denominator. Secrets stay in the injected implementations.
const std = @import("std");
const validator = @import("../validator.zig");
const objects = @import("../../storage/objects.zig");
pub const Source = struct {
    context: *anyopaque,
    finalized_height: *const fn (*anyopaque, objects.ReorgPeriod) anyerror!u64,
    insertion: *const fn (*anyopaque, u32, u64) anyerror!?validator.Observation,
    checkpoint: *const fn (*anyopaque, usize, objects.ReorgPeriod) anyerror!?validator.Checkpoint,
};
pub const Limits = struct { observations: usize = 64, publications: usize = 32, history: usize = 32 };
pub const Progress = struct { observed: usize, published: usize, unavailable_endpoints: usize, more_observations: bool, history_repaired: usize = 0, snapshot_error: ?anyerror = null, recovery_reset: bool = false };
pub fn tick(service: *validator.Service, source: Source, signer: validator.Signer, publisher: validator.Publisher, timestamp: u64, limits: Limits) !Progress {
    if (limits.observations == 0 or limits.observations > 64 or limits.publications == 0 or limits.publications > 1000 or limits.history == 0 or limits.history > 64) return error.InvalidTickLimit;
    if (service.halted) {
        try service.publishReorg(publisher);
        return error.ValidatorHalted;
    }
    service.invalidateAuthorization();
    var snapshot_error: ?anyerror = null;
    _ = service.bootstrap(publisher) catch |err| blk: {
        if (service.halted) return err;
        snapshot_error = err;
        break :blk false;
    };
    const votes = try service.allocator.alloc(?validator.Checkpoint, service.options.endpoint_count);
    defer service.allocator.free(votes);
    var unavailable: usize = 0;
    var maximum: ?u32 = null;
    for (votes, 0..) |*vote, slot| {
        vote.* = source.checkpoint(source.context, slot, service.options.reorg_period) catch null;
        if (vote.*) |c| {
            if (c.mailbox_domain == service.options.domain and std.mem.eql(u8, &c.merkle_tree_hook_address, &service.options.hook)) maximum = if (maximum) |m| @max(m, c.index) else c.index;
        } else unavailable += 1;
    }
    for (votes) |*vote| {
        if (vote.*) |c| {
            if (c.index < service.tree.count) {
                const authenticated = service.authenticateStoredHistory(c.index, publisher) catch false;
                if (!authenticated) {
                    vote.* = null;
                    unavailable += 1;
                }
            }
        }
    }
    var finalized: ?u64 = null;
    var observed: usize = 0;
    if (maximum) |target| {
        if (service.tree.count <= target) {
            const height = try source.finalized_height(source.context, service.options.reorg_period);
            finalized = height;
            while (service.tree.count <= target and observed < limits.observations) {
                const index = service.tree.count;
                var operation_buffer: [80]u8 = undefined;
                const operation = try std.fmt.bufPrint(&operation_buffer, "merkle_tree_insertion[{d}]", .{index});
                const observation = source.insertion(source.context, index, height) catch |err| {
                    if (service.options.readiness) |status| status.blocked(operation) catch {};
                    return err;
                } orelse {
                    if (service.options.readiness) |status| status.blocked(operation) catch {};
                    break;
                };
                if (service.options.readiness) |status| status.ready(operation);
                try service.observe(index, observation, height);
                observed += 1;
            }
        }
    }
    if (!service.repair_complete and finalized == null) finalized = source.finalized_height(source.context, service.options.reorg_period) catch null;
    const repaired = try service.repairHistory(publisher, source.context, source.insertion, finalized, limits.history, timestamp);
    _ = try service.authorize(votes, timestamp);
    const published = service.publishConcurrent(signer, publisher, timestamp, limits.publications) catch |err| {
        if (err == error.FreshAuthorizationRequired) return .{ .history_repaired = repaired, .snapshot_error = snapshot_error, .observed = observed, .published = 0, .unavailable_endpoints = unavailable, .more_observations = if (maximum) |m| service.tree.count <= m else false };
        return err;
    };
    return .{ .history_repaired = repaired, .snapshot_error = snapshot_error, .observed = observed, .published = published, .unavailable_endpoints = unavailable, .more_observations = if (maximum) |m| service.tree.count <= m else false };
}
