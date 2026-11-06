//! Source contract/cursor metrics from real relayer origin commits and cycles.
const std = @import("std");
const metrics = @import("metrics.zig");
pub const observation = @import("../runtime/indexing_observer.zig");
pub const Adapter = struct {
    registry: *metrics.Registry,
    chain: []const u8,
    unix_seconds: u64 = 0,
    gap_at: [3]u64 = @splat(0),
    failures: usize = 0,
    pub fn interface(self: *Adapter) observation.Observer {
        return .{ .context = self, .notify_fn = notify };
    }
    fn notify(context: *anyopaque, event: observation.Event) void {
        const self: *Adapter = @ptrCast(@alignCast(context));
        self.record(event) catch |err| {
            self.failures +|= 1;
            if (self.failures == 1) std.log.warn("origin indexing metric update failed: {s}", .{@errorName(err)});
        };
    }
    fn dataType(stream: observation.Stream) []const u8 {
        return switch (stream) {
            .dispatch => "dispatched_messages",
            .insertion => "merkle_tree_hook",
            .gas => "gas_payments",
            .delivery => unreachable,
        };
    }
    fn eventType(stream: observation.Stream) []const u8 {
        return switch (stream) {
            .dispatch => "hyperlane_message",
            .insertion => "merkle_tree_insertion",
            .gas => "interchain_gas_payment",
            .delivery => unreachable,
        };
    }
    fn slot(stream: observation.Stream) usize {
        return switch (stream) {
            .dispatch => 0,
            .insertion => 1,
            .gas => 2,
            .delivery => unreachable,
        };
    }
    fn integer(value: u64) i64 {
        return std.math.cast(i64, value) orelse std.math.maxInt(i64);
    }
    pub fn record(self: *Adapter, event: observation.Event) !void {
        switch (event) {
            .tree_ingested => |index| try self.registry.update("hyperlane_latest_tree_insertion_index", &.{self.chain}, .{ .set_int = index }),
            .stored => |value| try self.registry.update("hyperlane_contract_sync_stored_events", &.{ dataType(value.stream), self.chain }, .{ .add_int = value.count }),
            .fetch_backoff => |value| {
                if (value.retry) try self.registry.update("hyperlane_contract_sync_fetch_retries", &.{ dataType(value.stream), self.chain }, .{ .add_int = 1 });
                try self.registry.update("hyperlane_contract_sync_fetch_backoff_seconds", &.{ dataType(value.stream), self.chain }, .{ .set_int = integer(value.delay_ms / 1000) });
            },
            .completed => |value| {
                const kind = eventType(value.stream);
                const forward = if (value.forward_sequence != null) "forward_sequenced" else "forward_rate_limited";
                try self.registry.update("hyperlane_contract_sync_block_height", &.{ dataType(value.stream), self.chain }, .{ .set_int = value.forward_block });
                try self.registry.update("hyperlane_cursor_current_block", &.{ kind, self.chain, forward }, .{ .set_int = value.forward_block });
                if (value.forward_sequence) |n| try self.registry.update("hyperlane_cursor_current_sequence", &.{ kind, self.chain, forward }, .{ .set_int = n });
                if (value.backward_block) |n| try self.registry.update("hyperlane_cursor_current_block", &.{ kind, self.chain, "backward_sequenced" }, .{ .set_int = n });
                if (value.backward_sequence) |n| try self.registry.update("hyperlane_cursor_current_sequence", &.{ kind, self.chain, "backward_sequenced" }, .{ .set_int = n });
                if (value.max_sequence) |n| _ = try self.registry.raiseInt("hyperlane_cursor_max_sequence", &.{ kind, self.chain }, n);
                const previous = &self.gap_at[slot(value.stream)];
                if (previous.* != value.gap_retry_at) {
                    if (value.gap_retry_at != 0) try self.registry.update("hyperlane_cursor_sequence_gap_retries", &.{ kind, self.chain }, .{ .add_int = 1 });
                    try self.registry.update("hyperlane_cursor_sequence_gap_backoff_seconds", &.{ kind, self.chain }, .{ .set_int = integer((value.gap_retry_at -| value.now_ms) / 1000) });
                    previous.* = value.gap_retry_at;
                }
                // A successful cycle is the positive initialization proof,
                // including genuine empty/caught-up cursor decisions.
                try self.registry.update("hyperlane_contract_sync_liveness", &.{ dataType(value.stream), self.chain, "cursor_task" }, .{ .set_int = integer(self.unix_seconds) });
            },
        }
    }
};
