//! Prometheus registry equivalent to `src/metrics.ts` on prom-client 14.2.0.
//!
//! Exposition is byte-compatible with prom-client: `# HELP`/`# TYPE` lines,
//! metrics separated by a blank line, values via JS `String(n)` (`Nan`,
//! `+Inf`, `-Inf`), prom-client's help/label escaping, histogram `le` first,
//! series in first-insertion order and labels in the TS call-site key order.
//! Metrics render in TS registration order. Node-only `nodejs_*` default
//! metrics are omitted; `process_*` metrics are computed natively.
const std = @import("std");
const builtin = @import("builtin");
const json = @import("json.zig");

pub const prefix = "hyperlane_scraper_proxy_";
pub const content_type = "text/plain; version=0.0.4; charset=utf-8";

const gpa = std.heap.c_allocator;

// ---------------------------------------------------------------------------
// Metric primitives
// ---------------------------------------------------------------------------

pub const Kind = enum { counter, gauge, histogram };

// Hot-path updates are lock-free and mostly thread-private: every series
// keeps `shard_count` cache-line-sized accumulators, a thread updates the one
// assigned to it (round-robin on first use), and `render`/`get` sum them.
// Series live in an append-only list (insertion order = prom-client order);
// only creating a series takes the metric's mutex.

pub const shard_count = 16;

threadlocal var thread_shard: u8 = 0xff;
var next_shard: std.atomic.Value(u32) = .init(0);

inline fn shardIndex() usize {
    if (thread_shard == 0xff) thread_shard = @intCast(next_shard.fetchAdd(1, .monotonic) % shard_count);
    return thread_shard;
}

/// f64 stored as bits (threads beyond `shard_count` share a shard, so adds CAS).
const AtomicF64 = struct {
    bits: std.atomic.Value(u64) = .init(0),

    fn add(self: *AtomicF64, v: f64) void {
        var current = self.bits.load(.monotonic);
        while (true) {
            const next: u64 = @bitCast(@as(f64, @bitCast(current)) + v);
            current = self.bits.cmpxchgWeak(current, next, .monotonic, .monotonic) orelse return;
        }
    }

    fn store(self: *AtomicF64, v: f64) void {
        self.bits.store(@bitCast(v), .monotonic);
    }

    fn load(self: *const AtomicF64) f64 {
        return @bitCast(self.bits.load(.monotonic));
    }
};

/// Append-only, lock-free-readable list of labeled series with sharded data.
fn SeriesList(comptime n: usize, comptime Shard: type) type {
    return struct {
        const List = @This();
        pub const Node = struct {
            labels: [n][]const u8,
            next: std.atomic.Value(?*Node) = .init(null),
            shards: [shard_count]Shard = @splat(.{}),

            pub fn shard(self: *Node) *Shard {
                return &self.shards[shardIndex()];
            }
        };

        mutex: std.Thread.Mutex = .{},
        head: std.atomic.Value(?*Node) = .init(null),
        tail: ?*Node = null,

        fn find(self: *const List, labels: [n][]const u8) ?*Node {
            var it = self.head.load(.acquire);
            while (it) |node| : (it = node.next.load(.acquire)) {
                var same = true;
                for (node.labels, labels) |x, y| if (!std.mem.eql(u8, x, y)) {
                    same = false;
                    break;
                };
                if (same) return node;
            }
            return null;
        }

        pub fn get(self: *List, labels: [n][]const u8) *Node {
            if (self.find(labels)) |node| return node;
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.find(labels)) |node| return node;
            const node = gpa.create(Node) catch @panic("OOM");
            node.* = .{ .labels = undefined };
            for (labels, 0..) |l, i| node.labels[i] = gpa.dupe(u8, l) catch @panic("OOM");
            if (self.tail) |t| t.next.store(node, .release) else self.head.store(node, .release);
            self.tail = node;
            return node;
        }

        pub fn first(self: *const List) ?*Node {
            return self.head.load(.acquire);
        }

        /// Not safe against concurrent updates (registry reset).
        pub fn clear(self: *List) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            var it = self.head.load(.acquire);
            while (it) |node| {
                it = node.next.load(.acquire);
                for (node.labels) |l| gpa.free(l);
                gpa.destroy(node);
            }
            self.head.store(null, .release);
            self.tail = null;
        }
    };
}

const ScalarShard = struct { value: AtomicF64 align(std.atomic.cache_line) = .{} };

/// Counter/gauge with a fixed label order. Unlabeled metrics start with a
/// single zero series like prom-client.
pub fn Scalar(comptime kind: Kind, comptime label_names: []const []const u8) type {
    const n = label_names.len;
    return struct {
        const Self = @This();
        pub const Labels = [n][]const u8;
        name: []const u8,
        help: []const u8,
        series: SeriesList(n, ScalarShard) = .{},

        pub fn init(comptime name: []const u8, comptime help: []const u8) Self {
            return .{ .name = prefix ++ name, .help = help };
        }

        fn ensureBase(self: *Self) void {
            if (n == 0) _ = self.series.get(.{});
        }

        pub fn inc(self: *Self, labels: Labels, value: f64) void {
            self.ensureBase();
            self.series.get(labels).shard().value.add(value);
        }

        pub fn dec(self: *Self, labels: Labels, value: f64) void {
            comptime std.debug.assert(kind == .gauge);
            self.inc(labels, -value);
        }

        /// Replaces the value (a concurrent `inc` on the same series may be
        /// lost; gauges here are either set or inc/dec'd, never both).
        pub fn set(self: *Self, labels: Labels, value: f64) void {
            comptime std.debug.assert(kind == .gauge);
            self.ensureBase();
            const node = self.series.get(labels);
            for (&node.shards, 0..) |*sh, i| sh.value.store(if (i == 0) value else 0);
        }

        fn sum(node: *const SeriesList(n, ScalarShard).Node) f64 {
            var total: f64 = 0;
            for (&node.shards) |*sh| total += sh.value.load();
            return total;
        }

        /// Current value of a series (0 when absent), like `metric.get()`.
        pub fn get(self: *Self, labels: Labels) f64 {
            const node = self.series.find(labels) orelse return 0;
            return sum(node);
        }

        /// prom-client `reset()`: drop every series (unlabeled -> single 0).
        pub fn reset(self: *Self) void {
            self.series.clear();
            self.ensureBase();
        }

        pub fn render(self: *Self, w: *std.Io.Writer) std.Io.Writer.Error!void {
            self.ensureBase();
            try writeHeader(w, self.name, self.help, kind);
            var it = self.series.first();
            while (it) |node| : (it = node.next.load(.acquire)) {
                try w.writeByte('\n');
                try w.writeAll(self.name);
                try writeLabels(w, label_names, &node.labels, null);
                try w.writeByte(' ');
                try writeValue(w, sum(node));
            }
        }
    };
}

pub fn Counter(comptime label_names: []const []const u8) type {
    return Scalar(.counter, label_names);
}

pub fn Gauge(comptime label_names: []const []const u8) type {
    return Scalar(.gauge, label_names);
}

pub fn Histogram(comptime label_names: []const []const u8, comptime buckets: []const f64) type {
    const n = label_names.len;
    const Shard = struct {
        /// Per bucket (non-cumulative), plus observations above every bound;
        /// `count` is their sum, so `+Inf` always equals `count`.
        counts: [buckets.len + 1]std.atomic.Value(u64) align(std.atomic.cache_line) = @splat(.init(0)),
        sum: AtomicF64 = .{},
    };
    return struct {
        const Self = @This();
        pub const Labels = [n][]const u8;
        name: []const u8,
        help: []const u8,
        series: SeriesList(n, Shard) = .{},

        pub fn init(comptime name: []const u8, comptime help: []const u8) Self {
            return .{ .name = prefix ++ name, .help = help };
        }

        fn ensureBase(self: *Self) void {
            if (n == 0) _ = self.series.get(.{});
        }

        pub fn observe(self: *Self, labels: Labels, value: f64) void {
            self.ensureBase();
            const sh = self.series.get(labels).shard();
            var slot: usize = buckets.len;
            for (buckets, 0..) |bound, i| if (value <= bound) {
                slot = i;
                break;
            };
            _ = sh.counts[slot].fetchAdd(1, .monotonic);
            sh.sum.add(value);
        }

        pub fn render(self: *Self, w: *std.Io.Writer) std.Io.Writer.Error!void {
            self.ensureBase();
            try writeHeader(w, self.name, self.help, .histogram);
            var it = self.series.first();
            while (it) |node| : (it = node.next.load(.acquire)) {
                var counts: [buckets.len + 1]u64 = @splat(0);
                var total_sum: f64 = 0;
                for (&node.shards) |*sh| {
                    for (&counts, &sh.counts) |*c, *src| c.* += src.load(.monotonic);
                    total_sum += sh.sum.load();
                }
                var cumulative: u64 = 0;
                for (buckets, 0..) |bound, i| {
                    cumulative += counts[i];
                    var buf: [64]u8 = undefined;
                    try w.writeByte('\n');
                    try w.print("{s}_bucket", .{self.name});
                    try writeLabels(w, label_names, &node.labels, json.formatNumber(&buf, bound));
                    try w.print(" {d}", .{cumulative});
                }
                const count = cumulative + counts[buckets.len];
                try w.writeByte('\n');
                try w.print("{s}_bucket", .{self.name});
                try writeLabels(w, label_names, &node.labels, "+Inf");
                try w.print(" {d}", .{count});
                try w.writeByte('\n');
                try w.print("{s}_sum", .{self.name});
                try writeLabels(w, label_names, &node.labels, null);
                try w.writeByte(' ');
                try writeValue(w, total_sum);
                try w.writeByte('\n');
                try w.print("{s}_count", .{self.name});
                try writeLabels(w, label_names, &node.labels, null);
                try w.print(" {d}", .{count});
            }
        }
    };
}

fn writeHeader(w: *std.Io.Writer, name: []const u8, help: []const u8, kind: Kind) !void {
    try w.writeAll("# HELP ");
    try writeEscaped(w, name, false);
    try w.writeByte(' ');
    try writeEscaped(w, help, false);
    try w.writeAll("\n# TYPE ");
    try writeEscaped(w, name, false);
    try w.print(" {s}", .{@tagName(kind)});
}

/// prom-client `escapeString` (`\n` -> `\\n`, `\` not followed by `n` ->
/// `\\`) plus `"` -> `\"` for label values.
fn writeEscaped(w: *std.Io.Writer, s: []const u8, quote: bool) !void {
    for (s, 0..) |c, i| switch (c) {
        '\n' => try w.writeAll("\\n"),
        '\\' => try w.writeAll(if (i + 1 < s.len and s[i + 1] == 'n') "\\" else "\\\\"),
        '"' => try w.writeAll(if (quote) "\\\"" else "\""),
        else => try w.writeByte(c),
    };
}

fn writeLabels(w: *std.Io.Writer, names: []const []const u8, values: []const []const u8, le: ?[]const u8) !void {
    if (names.len == 0 and le == null) return;
    try w.writeByte('{');
    var first = true;
    if (le) |bound| {
        try w.print("le=\"{s}\"", .{bound});
        first = false;
    }
    for (names, values) |name, value| {
        if (!first) try w.writeByte(',');
        first = false;
        try w.print("{s}=\"", .{name});
        try writeEscaped(w, value, true);
        try w.writeByte('"');
    }
    try w.writeByte('}');
}

/// prom-client `getValueAsString`.
pub fn writeValue(w: *std.Io.Writer, value: f64) !void {
    if (std.math.isNan(value)) return w.writeAll("Nan");
    if (std.math.isInf(value)) return w.writeAll(if (value < 0) "-Inf" else "+Inf");
    var buf: [64]u8 = undefined;
    try w.writeAll(json.formatNumber(&buf, value));
}

// ---------------------------------------------------------------------------
// Snapshot providers (setDatabaseMetricsProvider / setWebSocketMetricsProvider)
// ---------------------------------------------------------------------------

pub const PoolMetrics = struct { idle: f64 = 0, limit: f64 = 0, total: f64 = 0, waiting: f64 = 0 };

/// `DatabaseMetricsSnapshot`; pools enumerate `live` then `main` like TS.
pub const DatabaseMetricsSnapshot = struct {
    listeners: f64 = 0,
    pools: struct { live: PoolMetrics = .{}, main: PoolMetrics = .{} } = .{},
};

pub const RouteCounts = struct { agent: f64 = 0, messages: f64 = 0 };
pub const SubscriptionCounts = struct { catchingUp: f64 = 0, live: f64 = 0 };

/// `WebSocketMetricsSnapshot`; `subscriptions` field order matches the TS
/// object literal (delivery, dispatch, gas_payment, merkle_tree_insertion).
pub const WebSocketMetricsSnapshot = struct {
    catchUps: f64 = 0,
    connections: RouteCounts = .{},
    explorerPendingBytes: f64 = 0,
    explorerPendingMessages: f64 = 0,
    maxExplorerPendingBytes: f64 = 0,
    maxExplorerPendingMessages: f64 = 0,
    messageClientIps: f64 = 0,
    messageMaxConnectionsPerIp: f64 = 0,
    limits: struct {
        agentConnections: f64 = 0,
        catchUpMs: f64 = 0,
        clientMessagesPerMinute: f64 = 0,
        concurrentCatchUps: f64 = 0,
        explorerPendingBytes: f64 = 0,
        explorerPendingMessages: f64 = 0,
        messageConnections: f64 = 0,
        messageConnectionsPerIp: f64 = 0,
        notificationEvents: f64 = 0,
        pendingEvents: f64 = 0,
        socketBufferedBytes: f64 = 0,
        totalPendingBytes: f64 = 0,
    } = .{},
    listenerReady: bool = false,
    maxCatchUpDurationMs: f64 = 0,
    maxCatchUpRows: f64 = 0,
    maxClientBufferedBytes: f64 = 0,
    maxPendingCatchUpEvents: f64 = 0,
    notificationQueue: RouteCounts = .{},
    outboundPendingBytes: f64 = 0,
    pendingCatchUpEvents: f64 = 0,
    subscriptions: struct {
        delivery: SubscriptionCounts = .{},
        dispatch: SubscriptionCounts = .{},
        gas_payment: SubscriptionCounts = .{},
        merkle_tree_insertion: SubscriptionCounts = .{},
    } = .{},
};

pub fn Provider(comptime T: type) type {
    return struct { ctx: *anyopaque, snapshot: *const fn (ctx: *anyopaque) T };
}
pub const DatabaseMetricsProvider = Provider(DatabaseMetricsSnapshot);
pub const WebSocketMetricsProvider = Provider(WebSocketMetricsSnapshot);

var provider_mutex: std.Thread.Mutex = .{};
var database_provider: ?DatabaseMetricsProvider = null;
var websocket_provider: ?WebSocketMetricsProvider = null;

/// Providers are called from the `/metrics` request thread; they must be
/// thread-safe with respect to their owner's state. With fibers they run on
/// the event-loop thread (`core.fiber.offFiber`), so they must only take
/// short locks: no queries, I/O, log waits or other unbounded waits.
pub fn setDatabaseMetricsProvider(provider: ?DatabaseMetricsProvider) void {
    provider_mutex.lock();
    defer provider_mutex.unlock();
    database_provider = provider;
}

pub fn setWebSocketMetricsProvider(provider: ?WebSocketMetricsProvider) void {
    provider_mutex.lock();
    defer provider_mutex.unlock();
    websocket_provider = provider;
}

// ---------------------------------------------------------------------------
// Metrics from src/metrics.ts (registration order)
// ---------------------------------------------------------------------------

pub const DatabaseQueryRole = enum {
    graphql_primary,
    graphql_replica,
    live_primary,
    pub fn label(self: DatabaseQueryRole) []const u8 {
        return @tagName(self);
    }
};

pub var graphql_active_requests = Gauge(&.{}).init("graphql_active_requests", "Current number of active GraphQL requests.");
pub var graphql_active_request_limit = Gauge(&.{}).init("graphql_active_request_limit", "Maximum number of concurrent GraphQL requests.");
pub var graphql_requests = Counter(&.{"outcome"}).init("graphql_requests_total", "GraphQL requests by outcome.");
pub var graphql_errors = Counter(&.{}).init("graphql_errors_total", "GraphQL errors returned to clients.");
pub var graphql_request_duration = Histogram(&.{}, &.{ 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20 }).init("graphql_request_duration_seconds", "GraphQL request duration in seconds.");
pub var database_queries = Counter(&.{ "outcome", "role" }).init("database_queries_total", "Database queries by fixed workload role and outcome.");
pub var database_query_duration = Histogram(&.{ "outcome", "role" }, &.{ 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20 }).init("database_query_duration_seconds", "Database query duration in seconds by fixed workload role and outcome.");
pub var database_rows = Counter(&.{"role"}).init("database_rows_total", "Database rows returned by fixed workload role.");
pub var websocket_connections = Counter(&.{"route"}).init("websocket_connections_total", "Accepted WebSocket connections by route.");
pub var websocket_connection_rejections = Counter(&.{ "reason", "route" }).init("websocket_connection_rejections_total", "Rejected WebSocket connections by route and reason.");
pub var websocket_catch_ups = Counter(&.{"outcome"}).init("websocket_catch_ups_total", "Historical WebSocket catch-ups by outcome.");
pub var websocket_client_message_rejections = Counter(&.{}).init("websocket_client_message_rejections_total", "Agent WebSocket messages rejected by the per-client rate limit.");
pub var websocket_send_failures = Counter(&.{"reason"}).init("websocket_send_failures_total", "WebSocket send failures by reason.");
pub var websocket_notification_queue_overflows = Counter(&.{"route"}).init("websocket_notification_queue_overflows_total", "PostgreSQL notification queue overflows by isolated route.");

var init_once = std.once(initMetrics);

/// Registers the zero series TS creates at import time and samples the
/// process baseline. Idempotent; `render` calls it too.
pub fn init() void {
    init_once.call();
}

fn initMetrics() void {
    process.init();
    for ([_][]const u8{ "graphql_primary", "graphql_replica", "live_primary" }) |role| {
        for ([_][]const u8{ "error", "success" }) |outcome| database_queries.inc(.{ outcome, role }, 0);
        database_rows.inc(.{role}, 0);
    }
    for ([_][]const u8{ "aborted", "capacity_rejected", "failure", "success" }) |outcome| websocket_catch_ups.inc(.{outcome}, 0);
    for ([_][]const u8{ "buffer_limit", "notification_queue_limit", "queue_limit", "send_error" }) |reason| websocket_send_failures.inc(.{reason}, 0);
    for ([_][]const u8{ "agent", "messages" }) |route| {
        for ([_][]const u8{ "connection_limit", "listener_unavailable" }) |reason| websocket_connection_rejections.inc(.{ reason, route }, 0);
    }
    for ([_][]const u8{ "invalid_client_ip", "per_ip_limit" }) |reason| websocket_connection_rejections.inc(.{ reason, "messages" }, 0);
    for ([_][]const u8{ "agent", "messages" }) |route| websocket_notification_queue_overflows.inc(.{route}, 0);
}

/// `metricsRegistry.metrics()`.
pub fn render(a: std.mem.Allocator) std.mem.Allocator.Error![]u8 {
    init();
    // The exposition is ~17-25 KiB; size once instead of growing.
    var out: std.Io.Writer.Allocating = try .initCapacity(a, 32 * 1024);
    errdefer out.deinit();
    renderTo(&out.writer) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

pub fn renderTo(w: *std.Io.Writer) std.Io.Writer.Error!void {
    try process.render(w);
    try graphql_active_requests.render(w);
    try w.writeAll("\n\n");
    try graphql_active_request_limit.render(w);
    try w.writeAll("\n\n");
    try graphql_requests.render(w);
    try w.writeAll("\n\n");
    try graphql_errors.render(w);
    try w.writeAll("\n\n");
    try graphql_request_duration.render(w);
    try w.writeAll("\n\n");
    try database_queries.render(w);
    try w.writeAll("\n\n");
    try database_query_duration.render(w);
    try w.writeAll("\n\n");
    try database_rows.render(w);
    try w.writeAll("\n\n");
    try websocket_connections.render(w);
    try w.writeAll("\n\n");
    try websocket_connection_rejections.render(w);
    try w.writeAll("\n\n");
    try websocket_catch_ups.render(w);
    try w.writeAll("\n\n");
    try websocket_client_message_rejections.render(w);
    try w.writeAll("\n\n");
    try websocket_send_failures.render(w);
    try w.writeAll("\n\n");
    try websocket_notification_queue_overflows.render(w);
    try renderSnapshotGauges(w);
    try w.writeByte('\n');
}

const SnapshotSeries = struct { labels: []const []const u8 = &.{}, value: f64 };

/// One snapshot gauge (prom-client `collect() { reset(); set(...) }`):
/// unlabeled gauges render `0` without a snapshot, labeled ones render none.
fn snapshotGauge(w: *std.Io.Writer, comptime name: []const u8, help: []const u8, label_names: []const []const u8, series: []const SnapshotSeries, have_snapshot: bool) !void {
    try w.writeAll("\n\n");
    try writeHeader(w, prefix ++ name, help, .gauge);
    if (!have_snapshot) {
        if (label_names.len == 0) try w.writeAll("\n" ++ prefix ++ name ++ " 0");
        return;
    }
    for (series) |s| {
        try w.writeAll("\n" ++ prefix ++ name);
        try writeLabels(w, label_names, s.labels, null);
        try w.writeByte(' ');
        try writeValue(w, s.value);
    }
}

fn renderSnapshotGauges(w: *std.Io.Writer) !void {
    provider_mutex.lock();
    const dbp = database_provider;
    const wsp = websocket_provider;
    provider_mutex.unlock();

    const db_snapshot: ?DatabaseMetricsSnapshot = if (dbp) |p| p.snapshot(p.ctx) else null;
    const d = db_snapshot orelse DatabaseMetricsSnapshot{};
    const has_db = db_snapshot != null;
    const pool_state = [_][]const u8{ "pool", "state" };
    const pool = [_][]const u8{"pool"};
    try snapshotGauge(w, "database_pool_connections", "Current database pool connections by pool and state.", &pool_state, &.{
        .{ .labels = &.{ "live", "active" }, .value = d.pools.live.total - d.pools.live.idle },
        .{ .labels = &.{ "live", "idle" }, .value = d.pools.live.idle },
        .{ .labels = &.{ "main", "active" }, .value = d.pools.main.total - d.pools.main.idle },
        .{ .labels = &.{ "main", "idle" }, .value = d.pools.main.idle },
    }, has_db);
    try snapshotGauge(w, "database_pool_connection_limit", "Maximum database connections by pool.", &pool, &.{
        .{ .labels = &.{"live"}, .value = d.pools.live.limit },
        .{ .labels = &.{"main"}, .value = d.pools.main.limit },
    }, has_db);
    try snapshotGauge(w, "database_pool_waiting_requests", "Current requests waiting for a database connection by pool.", &pool, &.{
        .{ .labels = &.{"live"}, .value = d.pools.live.waiting },
        .{ .labels = &.{"main"}, .value = d.pools.main.waiting },
    }, has_db);
    try snapshotGauge(w, "database_listener_connections", "Current dedicated PostgreSQL listener connections.", &.{}, &.{.{ .value = d.listeners }}, has_db);

    const ws_snapshot: ?WebSocketMetricsSnapshot = if (wsp) |p| p.snapshot(p.ctx) else null;
    const s = ws_snapshot orelse WebSocketMetricsSnapshot{};
    const has = ws_snapshot != null;
    const route = [_][]const u8{"route"};
    const none = [_][]const u8{};
    try snapshotGauge(w, "websocket_connections", "Current WebSocket connections by route.", &route, &.{
        .{ .labels = &.{"agent"}, .value = s.connections.agent },
        .{ .labels = &.{"messages"}, .value = s.connections.messages },
    }, has);
    try snapshotGauge(w, "websocket_connection_limit", "Maximum WebSocket connections by route.", &route, &.{
        .{ .labels = &.{"agent"}, .value = s.limits.agentConnections },
        .{ .labels = &.{"messages"}, .value = s.limits.messageConnections },
    }, has);
    try snapshotGauge(w, "websocket_message_client_ips", "Current number of distinct /messages client IPs.", &none, &.{.{ .value = s.messageClientIps }}, has);
    try snapshotGauge(w, "websocket_message_connection_limit_per_ip", "Maximum /messages WebSocket connections per client IP.", &none, &.{.{ .value = s.limits.messageConnectionsPerIp }}, has);
    try snapshotGauge(w, "websocket_message_max_connections_per_ip", "Largest current /messages connection count for one client IP.", &none, &.{.{ .value = s.messageMaxConnectionsPerIp }}, has);
    try snapshotGauge(w, "websocket_listener_ready", "Whether the database event listener is ready.", &none, &.{.{ .value = if (s.listenerReady) 1 else 0 }}, has);
    try snapshotGauge(w, "websocket_catch_ups", "Current historical WebSocket catch-ups.", &none, &.{.{ .value = s.catchUps }}, has);
    try snapshotGauge(w, "websocket_catch_up_concurrency_limit", "Maximum concurrent historical WebSocket catch-ups.", &none, &.{.{ .value = s.limits.concurrentCatchUps }}, has);
    try snapshotGauge(w, "websocket_max_catch_up_rows", "Largest current row count delivered by one historical catch-up.", &none, &.{.{ .value = s.maxCatchUpRows }}, has);
    try snapshotGauge(w, "websocket_catch_up_duration_limit_seconds", "Maximum duration of one historical WebSocket catch-up in seconds.", &none, &.{.{ .value = s.limits.catchUpMs / 1_000 }}, has);
    try snapshotGauge(w, "websocket_max_catch_up_duration_seconds", "Longest current historical WebSocket catch-up duration in seconds.", &none, &.{.{ .value = s.maxCatchUpDurationMs / 1_000 }}, has);
    try snapshotGauge(w, "websocket_pending_catch_up_events", "Current live events buffered behind historical catch-ups.", &none, &.{.{ .value = s.pendingCatchUpEvents }}, has);
    try snapshotGauge(w, "websocket_pending_catch_up_event_limit", "Maximum live events buffered behind one historical catch-up.", &none, &.{.{ .value = s.limits.pendingEvents }}, has);
    try snapshotGauge(w, "websocket_max_pending_catch_up_events", "Largest current live-event buffer behind one historical catch-up.", &none, &.{.{ .value = s.maxPendingCatchUpEvents }}, has);
    try snapshotGauge(w, "websocket_client_message_limit_per_minute", "Maximum agent messages accepted per client per minute.", &none, &.{.{ .value = s.limits.clientMessagesPerMinute }}, has);
    const sub = s.subscriptions;
    try snapshotGauge(w, "websocket_subscriptions", "Current agent subscriptions by event type and state.", &.{ "event_type", "state" }, &.{
        .{ .labels = &.{ "delivery", "catching_up" }, .value = sub.delivery.catchingUp },
        .{ .labels = &.{ "delivery", "live" }, .value = sub.delivery.live },
        .{ .labels = &.{ "dispatch", "catching_up" }, .value = sub.dispatch.catchingUp },
        .{ .labels = &.{ "dispatch", "live" }, .value = sub.dispatch.live },
        .{ .labels = &.{ "gas_payment", "catching_up" }, .value = sub.gas_payment.catchingUp },
        .{ .labels = &.{ "gas_payment", "live" }, .value = sub.gas_payment.live },
        .{ .labels = &.{ "merkle_tree_insertion", "catching_up" }, .value = sub.merkle_tree_insertion.catchingUp },
        .{ .labels = &.{ "merkle_tree_insertion", "live" }, .value = sub.merkle_tree_insertion.live },
    }, has);
    try snapshotGauge(w, "websocket_notification_queue", "Current queued database notifications by route.", &route, &.{
        .{ .labels = &.{"agent"}, .value = s.notificationQueue.agent },
        .{ .labels = &.{"messages"}, .value = s.notificationQueue.messages },
    }, has);
    try snapshotGauge(w, "websocket_notification_queue_limit", "Maximum queued PostgreSQL notifications before route clients are closed.", &route, &.{
        .{ .labels = &.{"agent"}, .value = s.limits.notificationEvents },
        .{ .labels = &.{"messages"}, .value = s.limits.notificationEvents },
    }, has);
    try snapshotGauge(w, "websocket_explorer_pending_bytes", "Current serialized Explorer bytes queued behind send callbacks.", &none, &.{.{ .value = s.explorerPendingBytes }}, has);
    try snapshotGauge(w, "websocket_explorer_max_pending_bytes", "Largest current serialized Explorer byte queue for one client.", &none, &.{.{ .value = s.maxExplorerPendingBytes }}, has);
    try snapshotGauge(w, "websocket_explorer_pending_byte_limit", "Maximum serialized Explorer bytes queued behind one client callback.", &none, &.{.{ .value = s.limits.explorerPendingBytes }}, has);
    try snapshotGauge(w, "websocket_explorer_pending_messages", "Current Explorer messages queued behind per-client send callbacks.", &none, &.{.{ .value = s.explorerPendingMessages }}, has);
    try snapshotGauge(w, "websocket_explorer_max_pending_messages", "Largest current per-client Explorer message queue.", &none, &.{.{ .value = s.maxExplorerPendingMessages }}, has);
    try snapshotGauge(w, "websocket_explorer_pending_message_limit", "Maximum Explorer messages queued behind one client send callback.", &none, &.{.{ .value = s.limits.explorerPendingMessages }}, has);
    try snapshotGauge(w, "websocket_outbound_pending_bytes", "Current bytes awaiting WebSocket send callbacks.", &none, &.{.{ .value = s.outboundPendingBytes }}, has);
    try snapshotGauge(w, "websocket_outbound_pending_byte_limit", "Maximum total bytes awaiting WebSocket send callbacks.", &none, &.{.{ .value = s.limits.totalPendingBytes }}, has);
    try snapshotGauge(w, "websocket_max_client_buffered_bytes", "Largest current ws bufferedAmount among connected clients.", &none, &.{.{ .value = s.maxClientBufferedBytes }}, has);
    try snapshotGauge(w, "websocket_client_buffered_byte_limit", "Maximum ws bufferedAmount allowed for one client.", &none, &.{.{ .value = s.limits.socketBufferedBytes }}, has);
}

// ---------------------------------------------------------------------------
// process_* default metrics (prom-client collectDefaultMetrics, prefixed)
// ---------------------------------------------------------------------------

const process = struct {
    var mutex: std.Thread.Mutex = .{};
    var last_user_us: i64 = 0;
    var last_system_us: i64 = 0;
    var user_total: f64 = 0;
    var system_total: f64 = 0;
    var cpu_total: f64 = 0;
    var start_seconds: f64 = 0;
    var max_fds: ?f64 = null;

    fn cpuMicros() [2]i64 {
        const usage = std.posix.getrusage(std.posix.rusage.SELF);
        return .{
            @as(i64, usage.utime.sec) * 1_000_000 + usage.utime.usec,
            @as(i64, usage.stime.sec) * 1_000_000 + usage.stime.usec,
        };
    }

    fn init() void {
        const cpu = cpuMicros();
        last_user_us = cpu[0];
        last_system_us = cpu[1];
        start_seconds = @round(@as(f64, @floatFromInt(std.time.milliTimestamp())) / 1000.0);
        if (builtin.os.tag == .linux) max_fds = readMaxFds();
    }

    fn render(w: *std.Io.Writer) !void {
        mutex.lock();
        const cpu = cpuMicros();
        const user = cpu[0] - last_user_us;
        const system = cpu[1] - last_system_us;
        last_user_us = cpu[0];
        last_system_us = cpu[1];
        user_total += @as(f64, @floatFromInt(user)) / 1e6;
        system_total += @as(f64, @floatFromInt(system)) / 1e6;
        cpu_total += @as(f64, @floatFromInt(user + system)) / 1e6;
        const u = user_total;
        const s = system_total;
        const t = cpu_total;
        mutex.unlock();
        try simple(w, "process_cpu_user_seconds_total", "Total user CPU time spent in seconds.", .counter, u);
        try simple(w, "process_cpu_system_seconds_total", "Total system CPU time spent in seconds.", .counter, s);
        try simple(w, "process_cpu_seconds_total", "Total user and system CPU time spent in seconds.", .counter, t);
        try simple(w, "process_start_time_seconds", "Start time of the process since unix epoch in seconds.", .gauge, start_seconds);
        if (builtin.os.tag == .linux) {
            const mem = readProcStatus();
            try simpleOpt(w, "process_resident_memory_bytes", "Resident memory size in bytes.", mem[0]);
            try simpleOpt(w, "process_virtual_memory_bytes", "Virtual memory size in bytes.", mem[1]);
            try simpleOpt(w, "process_heap_bytes", "Process heap size in bytes.", mem[2]);
            try simpleOpt(w, "process_open_fds", "Number of open file descriptors.", countOpenFds());
            if (max_fds) |m| try simple(w, "process_max_fds", "Maximum number of open file descriptors.", .gauge, m);
        } else {
            try simpleOpt(w, "process_resident_memory_bytes", "Resident memory size in bytes.", residentBytes());
        }
    }

    fn simple(w: *std.Io.Writer, comptime name: []const u8, help: []const u8, kind: Kind, value: f64) !void {
        try writeHeader(w, prefix ++ name, help, kind);
        try w.writeAll("\n" ++ prefix ++ name ++ " ");
        try writeValue(w, value);
        try w.writeAll("\n\n");
    }

    /// prom-client gauges whose collect failed keep their unlabeled 0 series.
    fn simpleOpt(w: *std.Io.Writer, comptime name: []const u8, help: []const u8, value: ?f64) !void {
        try simple(w, name, help, .gauge, value orelse 0);
    }

    fn readProcStatus() [3]?f64 {
        var buf: [4096]u8 = undefined;
        const text = readSmallFile("/proc/self/status", &buf) orelse return .{ null, null, null };
        var result: [3]?f64 = .{ null, null, null };
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |line| {
            const keys = [_][]const u8{ "VmRSS", "VmSize", "VmData" };
            for (keys, 0..) |key, i| if (std.mem.startsWith(u8, line, key) and line.len > key.len and line[key.len] == ':') {
                const rest = std.mem.trim(u8, line[key.len + 1 ..], " \t");
                const digits = std.mem.trimRight(u8, rest, " kB");
                const kb = std.fmt.parseFloat(f64, digits) catch continue;
                result[i] = kb * 1024;
            };
        }
        return result;
    }

    fn countOpenFds() ?f64 {
        var dir = std.fs.openDirAbsolute("/proc/self/fd", .{ .iterate = true }) catch return null;
        defer dir.close();
        var it = dir.iterate();
        var n: f64 = 0;
        while (it.next() catch return null) |_| n += 1;
        return n - 1; // the iteration's own descriptor, like prom-client
    }

    fn readMaxFds() ?f64 {
        var buf: [8192]u8 = undefined;
        const text = readSmallFile("/proc/self/limits", &buf) orelse return null;
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |line| if (std.mem.startsWith(u8, line, "Max open files")) {
            var parts = std.mem.tokenizeSequence(u8, line, "  ");
            _ = parts.next();
            const raw = std.mem.trim(u8, parts.next() orelse return null, " ");
            return std.fmt.parseFloat(f64, raw) catch null;
        };
        return null;
    }

    fn readSmallFile(path: []const u8, buf: []u8) ?[]const u8 {
        const file = std.fs.openFileAbsolute(path, .{}) catch return null;
        defer file.close();
        const n = file.readAll(buf) catch return null;
        return buf[0..n];
    }

    const mach = struct {
        const MachTaskBasicInfo = extern struct {
            virtual_size: u64,
            resident_size: u64,
            resident_size_max: u64,
            user_time: [2]i32,
            system_time: [2]i32,
            policy: i32,
            suspend_count: i32,
        };
        extern "c" fn mach_task_self() std.c.mach_port_t;
        extern "c" fn task_info(task: std.c.mach_port_t, flavor: u32, info: *anyopaque, count: *u32) c_int;
    };

    fn residentBytes() ?f64 {
        if (builtin.os.tag != .macos) return null;
        var info: mach.MachTaskBasicInfo = undefined;
        var count: u32 = @sizeOf(mach.MachTaskBasicInfo) / @sizeOf(u32);
        const MACH_TASK_BASIC_INFO = 20;
        if (mach.task_info(mach.mach_task_self(), MACH_TASK_BASIC_INFO, &info, &count) != 0) return null;
        return @floatFromInt(info.resident_size);
    }
};

// ---------------------------------------------------------------------------
// Tests (port of src/metrics.test.ts registry assertions)
// ---------------------------------------------------------------------------

const testing = std.testing;

const TestProviders = struct {
    fn db(_: *anyopaque) DatabaseMetricsSnapshot {
        return .{ .listeners = 1, .pools = .{
            .live = .{ .idle = 1, .limit = 10, .total = 2, .waiting = 0 },
            .main = .{ .idle = 3, .limit = 10, .total = 5, .waiting = 2 },
        } };
    }
    fn ws(_: *anyopaque) WebSocketMetricsSnapshot {
        return .{
            .catchUps = 2,
            .connections = .{ .agent = 3, .messages = 4 },
            .explorerPendingBytes = 1_024,
            .explorerPendingMessages = 9,
            .maxExplorerPendingBytes = 512,
            .maxExplorerPendingMessages = 5,
            .messageClientIps = 2,
            .messageMaxConnectionsPerIp = 3,
            .limits = .{
                .agentConnections = 100,
                .catchUpMs = 60_000,
                .clientMessagesPerMinute = 30,
                .concurrentCatchUps = 5,
                .explorerPendingBytes = 16_777_216,
                .explorerPendingMessages = 2_000,
                .messageConnections = 400,
                .messageConnectionsPerIp = 5,
                .notificationEvents = 10_000,
                .pendingEvents = 5_000,
                .socketBufferedBytes = 1_024,
                .totalPendingBytes = 4_096,
            },
            .listenerReady = true,
            .maxCatchUpDurationMs = 3_000,
            .maxCatchUpRows = 500,
            .maxClientBufferedBytes = 128,
            .maxPendingCatchUpEvents = 5,
            .notificationQueue = .{ .agent = 6, .messages = 7 },
            .outboundPendingBytes = 256,
            .pendingCatchUpEvents = 8,
            .subscriptions = .{
                .delivery = .{ .catchingUp = 0, .live = 1 },
                .dispatch = .{ .catchingUp = 1, .live = 2 },
                .gas_payment = .{ .catchingUp = 0, .live = 0 },
                .merkle_tree_insertion = .{ .catchingUp = 1, .live = 0 },
            },
        };
    }
};

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    if (std.mem.indexOf(u8, haystack, needle) == null) {
        std.debug.print("missing: {s}\n", .{needle});
        return error.TestExpectedContains;
    }
}

test "serves current usage and limits (metrics.test.ts)" {
    var dummy: u8 = 0;
    setDatabaseMetricsProvider(.{ .ctx = &dummy, .snapshot = TestProviders.db });
    setWebSocketMetricsProvider(.{ .ctx = &dummy, .snapshot = TestProviders.ws });
    defer setDatabaseMetricsProvider(null);
    defer setWebSocketMetricsProvider(null);
    const output = try render(testing.allocator);
    defer testing.allocator.free(output);
    const p = prefix;
    try expectContains(output, p ++ "websocket_connections{route=\"agent\"} 3\n");
    try expectContains(output, p ++ "websocket_connection_limit{route=\"messages\"} 400\n");
    try expectContains(output, p ++ "websocket_subscriptions{event_type=\"dispatch\",state=\"catching_up\"} 1\n");
    try expectContains(output, p ++ "websocket_outbound_pending_bytes 256\n");
    try expectContains(output, p ++ "websocket_explorer_pending_messages 9\n");
    try expectContains(output, p ++ "websocket_explorer_pending_bytes 1024\n");
    try expectContains(output, p ++ "websocket_notification_queue_limit{route=\"agent\"} 10000\n");
    try expectContains(output, p ++ "websocket_catch_up_duration_limit_seconds 60\n");
    try expectContains(output, p ++ "websocket_max_catch_up_duration_seconds 3\n");
    for ([_][]const u8{ "buffer_limit", "notification_queue_limit", "queue_limit", "send_error" }) |reason| {
        var buf: [256]u8 = undefined;
        try expectContains(output, try std.fmt.bufPrint(&buf, "websocket_send_failures_total{{reason=\"{s}\"}} 0\n", .{reason}));
    }
    for ([_][]const u8{ "aborted", "capacity_rejected", "failure", "success" }) |outcome| {
        var buf: [256]u8 = undefined;
        try expectContains(output, try std.fmt.bufPrint(&buf, "websocket_catch_ups_total{{outcome=\"{s}\"}} 0\n", .{outcome}));
    }
    for ([_][]const u8{ "agent", "messages" }) |route| {
        var buf: [256]u8 = undefined;
        try expectContains(output, try std.fmt.bufPrint(&buf, "websocket_notification_queue_overflows_total{{route=\"{s}\"}} 0\n", .{route}));
        for ([_][]const u8{ "connection_limit", "listener_unavailable" }) |reason| {
            try expectContains(output, try std.fmt.bufPrint(&buf, "websocket_connection_rejections_total{{reason=\"{s}\",route=\"{s}\"}} 0\n", .{ reason, route }));
        }
    }
    for ([_][]const u8{ "invalid_client_ip", "per_ip_limit" }) |reason| {
        var buf: [256]u8 = undefined;
        try expectContains(output, try std.fmt.bufPrint(&buf, "websocket_connection_rejections_total{{reason=\"{s}\",route=\"messages\"}} 0\n", .{reason}));
    }
    try expectContains(output, p ++ "database_pool_connections{pool=\"main\",state=\"active\"} 2\n");
    try expectContains(output, p ++ "database_pool_waiting_requests{pool=\"main\"} 2\n");
    try expectContains(output, p ++ "process_cpu");
    try testing.expect(std.mem.endsWith(u8, output, p ++ "websocket_client_buffered_byte_limit 1024\n"));
}

test "exposition format matches prom-client for counters, histograms and escaping" {
    const H = Histogram(&.{ "outcome", "role" }, &.{ 0.005, 0.01, 0.025 });
    var h = H.init("test_duration_seconds", "Help with \\ backslash\nand newline.");
    h.observe(.{ "success", "live_primary" }, 0.0123);
    var c = Counter(&.{ "route", "reason" }).init("test_total", "Counter.");
    c.inc(.{ "agent", "x\"y\\z\n" }, 1);
    var g = Gauge(&.{}).init("test_gauge", "Gauge.");
    g.set(.{}, std.math.nan(f64));
    var buf: [4096]u8 = undefined;
    var w = std.Io.Writer.fixed(&buf);
    try h.render(&w);
    try w.writeAll("\n\n");
    try c.render(&w);
    try w.writeAll("\n\n");
    try g.render(&w);
    try testing.expectEqualStrings(
        \\# HELP hyperlane_scraper_proxy_test_duration_seconds Help with \\ backslash\nand newline.
        \\# TYPE hyperlane_scraper_proxy_test_duration_seconds histogram
        \\hyperlane_scraper_proxy_test_duration_seconds_bucket{le="0.005",outcome="success",role="live_primary"} 0
        \\hyperlane_scraper_proxy_test_duration_seconds_bucket{le="0.01",outcome="success",role="live_primary"} 0
        \\hyperlane_scraper_proxy_test_duration_seconds_bucket{le="0.025",outcome="success",role="live_primary"} 1
        \\hyperlane_scraper_proxy_test_duration_seconds_bucket{le="+Inf",outcome="success",role="live_primary"} 1
        \\hyperlane_scraper_proxy_test_duration_seconds_sum{outcome="success",role="live_primary"} 0.0123
        \\hyperlane_scraper_proxy_test_duration_seconds_count{outcome="success",role="live_primary"} 1
        \\
        \\# HELP hyperlane_scraper_proxy_test_total Counter.
        \\# TYPE hyperlane_scraper_proxy_test_total counter
        \\hyperlane_scraper_proxy_test_total{route="agent",reason="x\"y\\z\n"} 1
        \\
        \\# HELP hyperlane_scraper_proxy_test_gauge Gauge.
        \\# TYPE hyperlane_scraper_proxy_test_gauge gauge
        \\hyperlane_scraper_proxy_test_gauge Nan
    , w.buffered());
}

test "unlabeled histogram renders zero buckets before observations" {
    var h = Histogram(&.{}, &.{ 0.5, 1 }).init("h", "H.");
    var buf: [1024]u8 = undefined;
    var w = std.Io.Writer.fixed(&buf);
    try h.render(&w);
    try testing.expectEqualStrings(
        \\# HELP hyperlane_scraper_proxy_h H.
        \\# TYPE hyperlane_scraper_proxy_h histogram
        \\hyperlane_scraper_proxy_h_bucket{le="0.5"} 0
        \\hyperlane_scraper_proxy_h_bucket{le="1"} 0
        \\hyperlane_scraper_proxy_h_bucket{le="+Inf"} 0
        \\hyperlane_scraper_proxy_h_sum 0
        \\hyperlane_scraper_proxy_h_count 0
    , w.buffered());
}
