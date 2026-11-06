//! Source Lander observer adapter. The destination is borrowed from stable lane
//! configuration; Registry owns every installed label value.
const std = @import("std");
const metrics = @import("metrics.zig");
const lander = struct {
    pub const observer = @import("../lander/observer.zig");
    pub const types = @import("../lander/types.zig");
    pub const Observer = observer.Observer;
    pub const Metric = observer.Metric;
};

pub const Adapter = struct {
    registry: *metrics.Registry,
    destination: []const u8,
    mismatched_nonce_count: u64 = 0,

    pub fn observer(self: *Adapter) lander.Observer {
        return .{ .context = self, .metric_fn = observe };
    }

    pub fn record(self: *Adapter, event: lander.Metric) !void {
        if (self.destination.len == 0 or !std.unicode.utf8ValidateSlice(self.destination)) return error.InvalidMetricDestination;
        const destination = [_][]const u8{self.destination};
        switch (event) {
            .transaction_submission => |fee| {
                try self.registry.update("hyperlane_lander_transaction_submissions", &destination, .{ .add_int = 1 });
                if (fee.gas_price) |value| try self.registry.update("hyperlane_lander_gas_price", &destination, .{ .set_int = wrappingI64(value) });
                if (fee.priority_fee) |value| try self.registry.update("hyperlane_lander_priority_fee", &destination, .{ .set_int = wrappingI64(value) });
                try self.registry.update("hyperlane_lander_gas_limit", &destination, .{ .set_int = wrappingI64(fee.gas_limit) });
            },
            .finalized_transaction => try self.registry.update("hyperlane_lander_finalized_transactions", &destination, .{ .add_int = 1 }),
            .dropped_payload => |reason| try self.registry.update("hyperlane_lander_dropped_payloads", &.{ self.destination, reason.name }, .{ .add_int = 1 }),
            .dropped_transaction => |reason| try self.registry.update("hyperlane_lander_dropped_transactions", &.{ self.destination, reason.name }, .{ .add_int = 1 }),
            .batch_built => |batch| try self.registry.update("hyperlane_lander_batched_transactions", &.{ self.destination, if (batch.success) "success" else "failed" }, .{ .add_int = batch.payloads }),
            .mev_submission => |success| try self.registry.update("hyperlane_lander_mev_submissions", &.{ self.destination, if (success) "success" else "error" }, .{ .add_int = 1 }),
            .status_read_batch => |count| try self.registry.update("hyperlane_lander_status_read_transactions", &.{ self.destination, "InclusionStage" }, .{ .add_int = count }),
            .status_read_requests => |count| try self.registry.update("hyperlane_lander_status_read_requests", &.{ self.destination, "InclusionStage" }, .{ .add_int = count }),
            .status_read_requests_avoided => |count| try self.registry.update("hyperlane_lander_status_read_requests_avoided", &.{ self.destination, "InclusionStage" }, .{ .add_int = count }),
            .task_liveness => |liveness| try self.registry.update("hyperlane_lander_task_liveness", &.{ self.destination, stageName(liveness.stage) }, .{ .set_int = wrappingI64(liveness.unix_seconds) }),
            .finalized_nonce => |nonce| try self.recordNonce("hyperlane_lander_finalized_nonce", nonce),
            .upper_nonce => |nonce| try self.recordNonce("hyperlane_lander_upper_nonce", nonce),
            .mismatched_nonce => |nonce| {
                self.mismatched_nonce_count +%= 1;
                try self.recordNonceValue("hyperlane_lander_mismatched_nonce", nonce.signer, self.mismatched_nonce_count);
            },
            .inclusion_error => |reason| try self.registry.update("hyperlane_lander_inclusion_stage_error", &.{ self.destination, reason.name, reason.detail orelse "false" }, .{ .add_int = 1 }),
            .building_queue_length => |length| try self.registry.update("hyperlane_lander_building_stage_queue_length", &destination, .{ .set_int = wrappingI64(length) }),
            .inclusion_pool_length => |length| try self.registry.update("hyperlane_lander_inclusion_stage_pool_length", &destination, .{ .set_int = wrappingI64(length) }),
            .finality_pool_length => |length| try self.registry.update("hyperlane_lander_finality_stage_pool_length", &destination, .{ .set_int = wrappingI64(length) }),
            .oldest_unchecked_transaction_age_seconds => |age| try self.registry.update("hyperlane_lander_oldest_unchecked_transaction_age_seconds", &.{ self.destination, "InclusionStage" }, .{ .set_int = saturatingI64(age) }),
            .status_scan_duration_milliseconds => |duration| try self.registry.update("hyperlane_lander_status_scan_duration_milliseconds", &.{ self.destination, "InclusionStage" }, .{ .set_int = saturatingI64(duration) }),
            .call_retries => |reason| try self.registry.update("hyperlane_lander_call_retries", &.{ self.destination, reason.detail orelse reason.name, reason.name }, .{ .add_int = 1 }),
        }
    }

    fn recordNonce(self: *Adapter, name: []const u8, nonce: lander.Metric.NonceMetric) !void {
        try self.recordNonceValue(name, nonce.signer, nonce.value);
    }

    fn recordNonceValue(self: *Adapter, name: []const u8, signer: lander.types.Address, value: anytype) !void {
        var storage: [42]u8 = undefined;
        const address = try std.fmt.bufPrint(&storage, "0x{s}", .{std.fmt.bytesToHex(signer, .lower)});
        try self.registry.update(name, &.{ self.destination, address }, .{ .set_int = wrappingI64(value) });
    }
};

fn observe(context: *anyopaque, event: lander.Metric) anyerror!void {
    const self: *Adapter = @ptrCast(@alignCast(context));
    try self.record(event);
}

fn stageName(stage: lander.Metric.Stage) []const u8 {
    return switch (stage) {
        .building => "BuildingStage",
        .inclusion => "InclusionStage",
        .finality => "FinalityStage",
    };
}

fn wrappingI64(value: anytype) i64 {
    const low: u64 = @truncate(value);
    return @bitCast(low);
}

fn saturatingI64(value: u64) i64 {
    return std.math.cast(i64, value) orelse std.math.maxInt(i64);
}
