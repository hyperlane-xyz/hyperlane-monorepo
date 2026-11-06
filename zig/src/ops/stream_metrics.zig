//! Real Source WS metric observations. Registration is generated from Rust;
//! this adapter copies bounded chain labels and never performs network I/O.
const std = @import("std");
const metrics = @import("metrics.zig");
pub const observer = @import("../agents/stream/observer.zig");
const A = std.mem.Allocator;
pub const Options = struct { max_chains: usize = 1024 };
const Gauge = enum { active, authority, fresh, caught_dispatch, caught_gas, caught_merkle, degraded_gas, pending_dispatch, pending_merkle, ready_dispatch, ready_merkle };
const Chain = struct {
    initialized: bool = false,
    values: [@typeInfo(Gauge).@"enum".fields.len]?i64 = @splat(null),
};
pub const StreamMetrics = struct {
    allocator: A,
    registry: *metrics.Registry,
    options: Options,
    chains: std.StringHashMapUnmanaged(Chain) = .empty,
    mutex: std.Thread.Mutex = .{},
    failures: std.atomic.Value(u64) = .init(0),
    gauge_writes: u64 = 0,
    counter_writes: u64 = 0,

    pub fn init(a: A, registry: *metrics.Registry, options: Options) !*StreamMetrics {
        if (options.max_chains == 0 or options.max_chains > 4096) return error.InvalidStreamMetricLimit;
        const self = try a.create(StreamMetrics);
        self.* = .{ .allocator = a, .registry = registry, .options = options };
        return self;
    }
    /// All bridge/origin writers must join before destroying this borrowed
    /// observer context. Registry destruction follows adapter destruction.
    pub fn deinit(self: *StreamMetrics) void {
        var keys = self.chains.keyIterator();
        while (keys.next()) |key| self.allocator.free(key.*);
        self.chains.deinit(self.allocator);
        self.allocator.destroy(self);
    }
    pub fn interface(self: *StreamMetrics) observer.Observer {
        return .{ .context = self, .notify_fn = notify };
    }
    fn notify(context: *anyopaque, chain: []const u8, change: observer.Change) void {
        const self: *StreamMetrics = @ptrCast(@alignCast(context));
        self.record(chain, change) catch |err| {
            if (self.failures.fetchAdd(1, .monotonic) == 0) std.log.warn("stream metric update failed: {s}", .{@errorName(err)});
        };
    }
    fn chainState(self: *StreamMetrics, chain: []const u8) !*Chain {
        if (chain.len == 0 or chain.len > 256 or !std.unicode.utf8ValidateSlice(chain)) return error.InvalidMetricChain;
        if (self.chains.getPtr(chain)) |found| return found;
        if (self.chains.count() >= self.options.max_chains) return error.StreamMetricChainLimit;
        const owned = try self.allocator.dupe(u8, chain);
        errdefer self.allocator.free(owned);
        try self.chains.put(self.allocator, owned, .{});
        return self.chains.getPtr(owned).?;
    }
    fn set(self: *StreamMetrics, state: *Chain, chain: []const u8, gauge: Gauge, value: i64) !void {
        const previous = &state.values[@intFromEnum(gauge)];
        if (previous.* == value) return;
        const suffix: []const u8 = switch (gauge) {
            .active => "active",
            .authority => "authority",
            .fresh => "fresh",
            .caught_dispatch, .caught_gas, .caught_merkle => "caught_up",
            .degraded_gas => "degraded",
            .pending_dispatch, .pending_merkle => "parity_pending",
            .ready_dispatch, .ready_merkle => "parity_ready",
        };
        const kind: ?[]const u8 = switch (gauge) {
            .active, .authority, .fresh => null,
            .caught_dispatch, .pending_dispatch, .ready_dispatch => "dispatch",
            .caught_gas, .degraded_gas => "gas_payment",
            .caught_merkle, .pending_merkle, .ready_merkle => "merkle_tree_insertion",
        };
        var name: [96]u8 = undefined;
        const family = try std.fmt.bufPrint(&name, "hyperlane_relayer_scraper_websocket_{s}", .{suffix});
        try self.registry.update(family, if (kind) |event_type| &.{ chain, event_type } else &.{chain}, .{ .set_int = value });
        previous.* = value;
        self.gauge_writes +|= 1;
    }
    fn validate(change: observer.Change) !void {
        switch (change) {
            .stream => |value| {
                if (value.degraded != null and value.kind != .gas_payment) return error.UnsupportedSourceMetric;
                if (value.kind == .gas_payment and (value.parity_pending != null or value.parity_ready != null)) return error.UnsupportedSourceMetric;
                if (value.parity_pending) |n| if (n > std.math.maxInt(i64)) return error.MetricIntegerOverflow;
            },
            .event => |value| {
                if (value.kind == .unknown and value.result != .invalid) return error.UnsupportedSourceMetric;
                if ((value.result == .shadow or value.result == .conflict or value.result == .caught_up) and value.kind != .gas_payment) return error.UnsupportedSourceMetric;
            },
            else => {},
        }
    }
    pub fn record(self: *StreamMetrics, chain: []const u8, change: observer.Change) !void {
        try validate(change);
        self.mutex.lock();
        defer self.mutex.unlock();
        const state = try self.chainState(chain);
        switch (change) {
            .initial => {
                if (state.initialized) return;
                inline for (@typeInfo(Gauge).@"enum".fields) |field| try self.set(state, chain, @enumFromInt(field.value), 0);
                state.initialized = true;
            },
            .state => |value| {
                if (value.active) |v| try self.set(state, chain, .active, @intFromBool(v));
                if (value.authority) |v| try self.set(state, chain, .authority, @intFromBool(v));
                if (value.fresh) |v| try self.set(state, chain, .fresh, @intFromBool(v));
            },
            .stream => |value| {
                if (value.caught_up) |v| try self.set(state, chain, switch (value.kind) {
                    .dispatch => .caught_dispatch,
                    .gas_payment => .caught_gas,
                    .merkle_tree_insertion => .caught_merkle,
                }, @intFromBool(v));
                if (value.degraded) |v| try self.set(state, chain, .degraded_gas, @intFromBool(v));
                if (value.parity_pending) |v| try self.set(state, chain, if (value.kind == .dispatch) .pending_dispatch else .pending_merkle, @intCast(v));
                if (value.parity_ready) |v| try self.set(state, chain, if (value.kind == .dispatch) .ready_dispatch else .ready_merkle, @intFromBool(v));
            },
            .event => |value| {
                try self.registry.update("hyperlane_relayer_scraper_websocket_events", &.{ chain, @tagName(value.kind), @tagName(value.result) }, .{ .add_int = 1 });
                self.counter_writes +|= 1;
            },
            .parity => |value| {
                try self.registry.update("hyperlane_relayer_scraper_websocket_parity", &.{ chain, @tagName(value.kind), @tagName(value.result) }, .{ .add_int = 1 });
                self.counter_writes +|= 1;
            },
            .cursor => |value| {
                if (try self.registry.raiseInt("hyperlane_cursor_max_sequence", &.{ value.kind.cursorLabel(), chain }, value.sequence)) self.gauge_writes +|= 1;
                if (!value.max_only) {
                    if (try self.registry.raiseInt("hyperlane_cursor_current_sequence", &.{ value.kind.cursorLabel(), chain, "forward_sequenced" }, value.sequence)) self.gauge_writes +|= 1;
                }
            },
        }
    }
};

test {
    _ = @import("stream_metrics_test.zig");
}
