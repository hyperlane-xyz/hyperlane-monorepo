//! Source cache metrics. Own one stable adapter per relayer role; caches borrow it.
const std = @import("std");
const metrics = @import("metrics.zig");
pub const cache = @import("../relayer/contract_cache.zig");
pub const Adapter = struct {
    registry: *metrics.Registry,
    mutex: std.Thread.Mutex = .{},
    partitions: [2]cache.MetricsSnapshot = @splat(.{}),
    expired_total: u64 = 0,
    size_total: u64 = 0,
    expired_recorded: u64 = 0,
    size_recorded: u64 = 0,
    failures: usize = 0,

    pub fn interface(self: *Adapter, partition: cache.Partition) cache.Observer {
        return .{ .context = self, .partition = partition, .notify_fn = notify };
    }
    fn integer(value: u64) i64 {
        return std.math.cast(i64, value) orelse std.math.maxInt(i64);
    }
    fn notify(context: *anyopaque, partition: cache.Partition, observation: cache.Observation) void {
        const self: *Adapter = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.record(partition, observation) catch |err| {
            self.failures +|= 1;
            if (self.failures == 1) std.log.warn("contract cache metric update failed: {s}", .{@errorName(err)});
        };
    }
    fn record(self: *Adapter, partition: cache.Partition, observation: cache.Observation) !void {
        const index = @intFromEnum(partition);
        const previous = self.partitions[index];
        self.expired_total +|= observation.snapshot.expired - previous.expired;
        self.size_total +|= observation.snapshot.size - previous.size;
        self.partitions[index] = if (observation.retired) .{} else observation.snapshot;
        // Always refresh gauges even if the decision counter cannot allocate.
        var first_error: ?anyerror = null;
        if (observation.decision) |decision| {
            self.registry.update(if (decision == .hit) "hyperlane_hit_count" else "hyperlane_miss_count", &.{ "relayer_cache", observation.chain, observation.method.?, if (decision == .failure) "failure" else "success" }, .{ .add_int = 1 }) catch |err| {
                first_error = err;
            };
        }
        var total: cache.MetricsSnapshot = .{};
        for (self.partitions) |value| {
            total.entries +|= value.entries;
            total.serialized_bytes +|= value.serialized_bytes;
        }
        self.registry.update("hyperlane_cache_entry_count", &.{"relayer_cache"}, .{ .set_int = integer(total.entries) }) catch |err| {
            first_error = first_error orelse err;
        };
        self.registry.update("hyperlane_cache_weighted_size_bytes", &.{"relayer_cache"}, .{ .set_int = integer(total.serialized_bytes) }) catch |err| {
            first_error = first_error orelse err;
        };
        // Advance each drained counter only after Registry accepted that delta.
        self.registry.update("hyperlane_cache_eviction_count", &.{ "relayer_cache", "expired" }, .{ .add_int = self.expired_total - self.expired_recorded }) catch |err| {
            first_error = first_error orelse err;
            return first_error.?;
        };
        self.expired_recorded = self.expired_total;
        self.registry.update("hyperlane_cache_eviction_count", &.{ "relayer_cache", "size" }, .{ .add_int = self.size_total - self.size_recorded }) catch |err| {
            return first_error orelse err;
        };
        self.size_recorded = self.size_total;
        if (first_error) |err| return err;
    }
};
