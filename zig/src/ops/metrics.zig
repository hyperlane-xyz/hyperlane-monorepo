//! Thread-safe, bounded Prometheus text registry over source-generated schemas.
//! Labels are copied once per series; readers never borrow mutable storage.
const std = @import("std");
const schema = @import("metrics_schema.zig");
const A = std.mem.Allocator;
pub const Role = enum { relayer, validator, scraper };
pub const Options = struct { max_series: usize = 100000, max_label_bytes: usize = 4096, max_storage_bytes: usize = 32 * 1024 * 1024, max_render_bytes: usize = 8 * 1024 * 1024, base_version: []const u8 };
pub const Update = union(enum) { set_int: i64, add_int: u64, set_real: f64, add_real: f64, observe: f64 };
const Histogram = struct { buckets: []u64, count: u64 = 0, sum: f64 = 0 };
const Value = union(enum) { integer: i64, counter: u64, real: f64, histogram: Histogram };
const Series = struct { arena: std.heap.ArenaAllocator, key: []const u8, metric: usize, labels: []const []const u8, value: Value, bytes: usize };
const default_buckets = [_]f64{ 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 };
pub const Registry = struct {
    allocator: A,
    role: Role,
    options: Options,
    descriptors: []schema.Descriptor,
    by_name: std.StringHashMapUnmanaged(usize) = .empty,
    series: std.ArrayList(Series) = .empty,
    by_series: std.StringHashMapUnmanaged(usize) = .empty,
    bytes: usize = 0,
    mutex: std.Thread.Mutex = .{},
    pub fn init(a: A, role: Role, options: Options) !*Registry {
        if (options.max_series == 0 or options.max_label_bytes == 0 or options.max_storage_bytes == 0 or options.max_render_bytes == 0 or options.base_version.len == 0) return error.InvalidMetricsLimit;
        const self = try a.create(Registry);
        errdefer a.destroy(self);
        const owned = try a.dupe(u8, options.base_version);
        errdefer a.free(owned);
        const group: []const schema.Descriptor = switch (role) {
            .relayer => &schema.relayer,
            .validator => &schema.validator,
            .scraper => &schema.scraper,
        };
        const descriptors = try std.mem.concat(a, schema.Descriptor, &.{ &schema.shared, &schema.lazy_shared, group });
        errdefer a.free(descriptors);
        std.mem.sort(schema.Descriptor, descriptors, {}, struct {
            fn less(_: void, x: schema.Descriptor, y: schema.Descriptor) bool {
                return std.mem.lessThan(u8, x.name, y.name);
            }
        }.less);
        self.* = .{ .allocator = a, .role = role, .options = options, .descriptors = descriptors };
        self.options.base_version = owned;
        errdefer self.by_name.deinit(a);
        for (descriptors, 0..) |descriptor, i| {
            if (self.by_name.contains(descriptor.name)) return error.DuplicateMetricDescriptor;
            try self.by_name.put(a, descriptor.name, i);
        }
        return self;
    }
    /// This agent has no Tokio scheduler/current Handle or TaskMonitor. Keep
    /// legacy runtime series explicit without claiming process-wide/FFI absence
    /// or mapping native worker lifecycle/health onto Tokio task-drop semantics.
    /// Call at daemon startup; Registry.init remains lazy for other consumers.
    pub fn registerNoTokioAgentRuntime(self: *Registry) !void {
        try self.update("hyperlane_tokio_dropped_tasks", &.{}, .{ .add_int = 0 });
        try self.update("hyperlane_tokio_blocking_threads", &.{}, .{ .set_int = 0 });
        try self.update("hyperlane_tokio_idle_blocking_threads", &.{}, .{ .set_int = 0 });
    }
    /// Stop/join HTTP and metric writers before destroying the registry.
    pub fn deinit(self: *Registry) void {
        for (self.series.items) |*series| series.arena.deinit();
        self.series.deinit(self.allocator);
        self.by_name.deinit(self.allocator);
        self.by_series.deinit(self.allocator);
        self.allocator.free(self.descriptors);
        self.allocator.free(self.options.base_version);
        self.allocator.destroy(self);
    }
    fn key(a: A, index: usize, labels: []const []const u8) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(a);
        var encoded: [8]u8 = undefined;
        std.mem.writeInt(u64, &encoded, index, .big);
        try out.appendSlice(a, &encoded);
        for (labels) |label| {
            std.mem.writeInt(u64, &encoded, label.len, .big);
            try out.appendSlice(a, &encoded);
            try out.appendSlice(a, label);
        }
        return out.toOwnedSlice(a);
    }
    fn buckets(descriptor: schema.Descriptor) []const f64 {
        return if (descriptor.buckets.len > 0) descriptor.buckets else &default_buckets;
    }
    fn locate(self: *Registry, index: usize, labels: []const []const u8) !*Series {
        const descriptor = self.descriptors[index];
        if (labels.len != descriptor.labels.len) return error.MetricLabelCount;
        var total: usize = @sizeOf(Series) + labels.len * (@sizeOf([]const u8) + 16) + 8;
        for (labels) |label| {
            if (label.len > self.options.max_label_bytes or !std.unicode.utf8ValidateSlice(label)) return error.MetricLabelLimit;
            total = try std.math.add(usize, total, label.len * 2);
        }
        const lookup = try key(self.allocator, index, labels);
        defer self.allocator.free(lookup);
        if (self.by_series.get(lookup)) |found| return &self.series.items[found];
        if (self.series.items.len >= self.options.max_series) return error.MetricSeriesLimit;
        if (descriptor.kind == .histogram) total = try std.math.add(usize, total, buckets(descriptor).len * @sizeOf(u64));
        if (total > self.options.max_storage_bytes -| self.bytes) return error.MetricStorageLimit;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const owned = arena.allocator();
        const values = try owned.alloc([]const u8, labels.len);
        for (values, labels) |*value, input| value.* = try owned.dupe(u8, input);
        const stored_key = try owned.dupe(u8, lookup);
        const value: Value = switch (descriptor.kind) {
            .int_gauge => .{ .integer = 0 },
            .int_counter => .{ .counter = 0 },
            .gauge, .counter => .{ .real = 0 },
            .histogram => histogram: {
                const counts = try owned.alloc(u64, buckets(descriptor).len);
                @memset(counts, 0);
                break :histogram .{ .histogram = .{ .buckets = counts } };
            },
        };
        try self.series.ensureUnusedCapacity(self.allocator, 1);
        try self.by_series.ensureUnusedCapacity(self.allocator, 1);
        self.by_series.putAssumeCapacityNoClobber(stored_key, self.series.items.len);
        self.series.appendAssumeCapacity(.{ .arena = arena, .key = stored_key, .metric = index, .labels = values, .value = value, .bytes = total });
        self.bytes += total;
        return &self.series.items[self.series.items.len - 1];
    }
    pub fn update(self: *Registry, name: []const u8, labels: []const []const u8, change: Update) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const index = self.by_name.get(name) orelse return error.UnknownMetric;
        const kind = self.descriptors[index].kind;
        const valid = switch (change) {
            .set_int => kind == .int_gauge,
            .add_int => kind == .int_counter,
            .set_real => kind == .gauge,
            .add_real => |amount| kind == .counter and amount >= 0,
            .observe => kind == .histogram,
        };
        if (!valid) return error.InvalidMetricUpdate;
        const series = try self.locate(index, labels);
        switch (change) {
            .set_int => |value| series.value.integer = value,
            .add_int => |value| series.value.counter +%= value,
            .set_real => |value| series.value.real = value,
            .add_real => |value| series.value.real += value,
            .observe => |value| {
                const histogram = &series.value.histogram;
                histogram.count +%= 1;
                histogram.sum += value;
                for (buckets(self.descriptors[index]), histogram.buckets) |upper, *count| if (value <= upper) {
                    count.* +%= 1;
                };
            },
        }
    }
    /// Source WS cursor progress raises gauges while RPC writers may also set
    /// them. Compare and update under the same registry lock; return true only
    /// if the stored value increased. A new Prometheus gauge starts at zero.
    pub fn raiseInt(self: *Registry, name: []const u8, labels: []const []const u8, minimum: i64) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const index = self.by_name.get(name) orelse return error.UnknownMetric;
        if (self.descriptors[index].kind != .int_gauge) return error.InvalidMetricUpdate;
        const series = try self.locate(index, labels);
        if (series.value.integer >= minimum) return false;
        series.value.integer = minimum;
        return true;
    }
    /// Validator-set changes remove only their old labeled series; counters
    /// persist unless the caller explicitly chooses to remove them.
    pub fn remove(self: *Registry, name: []const u8, labels: []const []const u8) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const metric = self.by_name.get(name) orelse return error.UnknownMetric;
        if (labels.len != self.descriptors[metric].labels.len) return error.MetricLabelCount;
        const lookup = try key(self.allocator, metric, labels);
        defer self.allocator.free(lookup);
        const found = self.by_series.fetchRemove(lookup) orelse return false;
        var removed = self.series.swapRemove(found.value);
        if (found.value < self.series.items.len) self.by_series.getPtr(self.series.items[found.value].key).?.* = found.value;
        self.bytes -= removed.bytes;
        removed.arena.deinit();
        return true;
    }
    pub fn render(self: *Registry, a: A) ![]u8 {
        const buffer = try a.alloc(u8, self.options.max_render_bytes);
        defer a.free(buffer);
        var writer = std.Io.Writer.fixed(buffer);
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.descriptors, 0..) |descriptor, index| {
            var present = false;
            for (self.series.items) |series| if (series.metric == index) {
                present = true;
                break;
            };
            if (!present) continue;
            self.renderFamily(&writer, descriptor, index) catch return error.MetricsRenderLimit;
        }
        return a.dupe(u8, writer.buffered());
    }
    fn renderFamily(self: *Registry, w: *std.Io.Writer, descriptor: schema.Descriptor, index: usize) !void {
        try w.print("# HELP {s} ", .{descriptor.name});
        try escaped(w, descriptor.help, false);
        const kind = switch (descriptor.kind) {
            .int_counter, .counter => "counter",
            .int_gauge, .gauge => "gauge",
            .histogram => "histogram",
        };
        try w.print("\n# TYPE {s} {s}\n", .{ descriptor.name, kind });
        for (self.series.items) |series| {
            if (series.metric != index) continue;
            switch (series.value) {
                .histogram => |histogram| {
                    for (buckets(descriptor), histogram.buckets) |upper, count| {
                        try w.print("{s}_bucket", .{descriptor.name});
                        try self.renderLabels(w, descriptor, series, upper);
                        try w.print(" {d}\n", .{count});
                    }
                    try w.print("{s}_bucket", .{descriptor.name});
                    try self.renderLabels(w, descriptor, series, std.math.inf(f64));
                    try w.print(" {d}\n{s}_sum", .{ histogram.count, descriptor.name });
                    try self.renderLabels(w, descriptor, series, null);
                    try w.writeByte(' ');
                    try real(w, histogram.sum);
                    try w.writeByte('\n');
                    try w.print("{s}_count", .{descriptor.name});
                    try self.renderLabels(w, descriptor, series, null);
                    try w.print(" {d}\n", .{histogram.count});
                },
                else => {
                    try w.writeAll(descriptor.name);
                    try self.renderLabels(w, descriptor, series, null);
                    try w.writeByte(' ');
                    switch (series.value) {
                        .integer => |value| try w.print("{d}", .{value}),
                        .counter => |value| try w.print("{d}", .{value}),
                        .real => |value| try real(w, value),
                        else => unreachable,
                    }
                    try w.writeByte('\n');
                },
            }
        }
    }
    fn renderLabels(self: *Registry, w: *std.Io.Writer, descriptor: schema.Descriptor, series: Series, upper: ?f64) !void {
        if (series.labels.len == 0 and !descriptor.base_labels and upper == null) return;
        try w.writeByte('{');
        var separator = false;
        for (descriptor.labels, series.labels) |name, value| {
            if (separator) try w.writeByte(',');
            try pair(w, name, value);
            separator = true;
        }
        if (descriptor.base_labels) {
            if (separator) try w.writeByte(',');
            try pair(w, "agent", @tagName(self.role));
            try w.writeByte(',');
            try pair(w, "hyperlane_baselib_version", self.options.base_version);
            separator = true;
        }
        if (upper) |value| {
            if (separator) try w.writeByte(',');
            try w.writeAll("le=\"");
            try real(w, value);
            try w.writeByte('"');
        }
        try w.writeByte('}');
    }
};
fn pair(w: *std.Io.Writer, name: []const u8, value: []const u8) !void {
    try w.print("{s}=\"", .{name});
    try escaped(w, value, true);
    try w.writeByte('"');
}
fn escaped(w: *std.Io.Writer, bytes: []const u8, quote: bool) !void {
    for (bytes) |byte| switch (byte) {
        '\\' => try w.writeAll("\\\\"),
        '\n' => try w.writeAll("\\n"),
        '"' => if (quote) try w.writeAll("\\\"") else try w.writeByte(byte),
        else => try w.writeByte(byte),
    };
}
fn real(w: *std.Io.Writer, value: f64) !void {
    if (std.math.isNan(value)) return w.writeAll("NaN");
    if (std.math.isInf(value)) return w.writeAll(if (value > 0) "+Inf" else "-Inf");
    try w.print("{d}", .{value});
}

test "metrics preserve source labels help types histogram buckets and escaping" {
    const a = std.testing.allocator;
    const registry = try Registry.init(a, .validator, .{ .base_version = "2.0.0", .max_render_bytes = 32768 });
    defer registry.deinit();
    try registry.update("hyperlane_announced", &.{"chain\"\\\n"}, .{ .set_int = 1 });
    try registry.update("hyperlane_messages_processed_count", &.{ "origin", "remote" }, .{ .add_int = 2 });
    try registry.update("hyperlane_fallback_hedge_duration_seconds", &.{ "chain", "eth_call", "secondary" }, .{ .observe = 0.02 });
    try registry.update("hyperlane_fallback_hedge_duration_seconds", &.{ "chain", "eth_call", "secondary" }, .{ .observe = 0.08 });
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "# HELP hyperlane_announced Whether the validator has been announced\n# TYPE hyperlane_announced gauge\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "chain=\"chain\\\"\\\\\\n\",agent=\"validator\",hyperlane_baselib_version=\"2.0.0\"} 1\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_messages_processed_count{origin=\"origin\",remote=\"remote\",agent=\"validator\",hyperlane_baselib_version=\"2.0.0\"} 2\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "le=\"0.025\"} 1\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "le=\"+Inf\"} 2\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "_count{chain=\"chain\",method=\"eth_call\",winner=\"secondary\",agent=\"validator\",hyperlane_baselib_version=\"2.0.0\"} 2\n") != null);
    try std.testing.expectError(error.MetricLabelCount, registry.update("hyperlane_announced", &.{}, .{ .set_int = 1 }));
    try std.testing.expectError(error.InvalidMetricUpdate, registry.update("hyperlane_announced", &.{"chain"}, .{ .add_int = 1 }));
    try std.testing.expectError(error.UnknownMetric, registry.update("unknown", &.{}, .{ .set_int = 1 }));
}
const Concurrent = struct {
    registry: *Registry,
    failure: ?anyerror = null,
    fn run(self: *Concurrent) void {
        for (0..1000) |_| self.registry.update("hyperlane_messages_processed_count", &.{ "one", "two" }, .{ .add_int = 1 }) catch |err| {
            self.failure = err;
            return;
        };
    }
};
test "metrics concurrent counters are lossless and series removal frees its bounded budget" {
    const a = std.testing.allocator;
    const registry = try Registry.init(a, .relayer, .{ .base_version = "fixture", .max_series = 1, .max_render_bytes = 1024 });
    defer registry.deinit();
    var contexts: [4]Concurrent = undefined;
    var threads: [4]std.Thread = undefined;
    var started: usize = 0;
    var joined = false;
    defer if (!joined) for (threads[0..started]) |thread| thread.join();
    for (&contexts, &threads) |*context, *thread| {
        context.* = .{ .registry = registry };
        thread.* = try std.Thread.spawn(.{}, Concurrent.run, .{context});
        started += 1;
    }
    for (threads) |thread| thread.join();
    joined = true;
    for (contexts) |context| if (context.failure) |err| return err;
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.endsWith(u8, text, "} 4000\n"));
    try std.testing.expectError(error.MetricSeriesLimit, registry.update("hyperlane_announced", &.{"other"}, .{ .set_int = 1 }));
    try std.testing.expect(try registry.remove("hyperlane_messages_processed_count", &.{ "one", "two" }));
    try std.testing.expect(!try registry.remove("hyperlane_messages_processed_count", &.{ "one", "two" }));
    try std.testing.expectEqual(@as(usize, 0), registry.bytes);
    try registry.update("hyperlane_announced", &.{"other"}, .{ .set_int = 1 });
    registry.options.max_render_bytes = 4;
    try std.testing.expectError(error.MetricsRenderLimit, registry.render(a));
}
fn failingLabels(a: A) !void {
    const registry = try Registry.init(a, .validator, .{ .base_version = "fixture" });
    defer registry.deinit();
    try registry.update("hyperlane_fallback_hedge_duration_seconds", &.{ "chain", "eth_call", "secondary" }, .{ .observe = 1 });
    const text = try registry.render(a);
    a.free(text);
    _ = try registry.remove("hyperlane_fallback_hedge_duration_seconds", &.{ "chain", "eth_call", "secondary" });
}
test "metrics allocation failure does not leak partially installed series" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, failingLabels, .{});
}

test "registry cursor raises are atomic with other writers and preserve metric shape" {
    const registry = try Registry.init(std.testing.allocator, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const name = "hyperlane_cursor_current_sequence";
    const labels: []const []const u8 = &.{ "hyperlane_message", "origin", "forward_sequenced" };
    try registry.update(name, labels, .{ .set_int = 100 });
    try std.testing.expect(!try registry.raiseInt(name, labels, 50));
    try std.testing.expect(try registry.raiseInt(name, labels, 101));
    const Writer = struct {
        fn run(value: *Registry, offset: usize) void {
            for (0..100) |i| {
                _ = value.raiseInt("hyperlane_cursor_current_sequence", &.{ "hyperlane_message", "origin", "forward_sequenced" }, @intCast(offset + i)) catch @panic("cursor metric raise failed");
            }
        }
    };
    const first = try std.Thread.spawn(.{}, Writer.run, .{ registry, 200 });
    const second = std.Thread.spawn(.{}, Writer.run, .{ registry, 300 }) catch |err| {
        first.join();
        return err;
    };
    first.join();
    second.join();
    try std.testing.expect(!try registry.raiseInt(name, labels, 399));
    const wire = try registry.render(std.testing.allocator);
    defer std.testing.allocator.free(wire);
    try std.testing.expect(std.mem.indexOf(u8, wire, " 399\n") != null);
    try std.testing.expectError(error.UnknownMetric, registry.raiseInt("unknown", &.{}, 1));
    try std.testing.expectError(error.InvalidMetricUpdate, registry.raiseInt("hyperlane_request_count", &.{}, 1));
    try std.testing.expectError(error.MetricLabelCount, registry.raiseInt(name, &.{"origin"}, 1));
}

test "explicit agent Tokio runtime zero families preserve role labels help types and laziness" {
    const a = std.testing.allocator;
    inline for (.{ Role.relayer, Role.validator, Role.scraper }) |role| {
        const registry = try Registry.init(a, role, .{ .base_version = "fixture", .max_render_bytes = 4096 });
        defer registry.deinit();
        const empty = try registry.render(a);
        defer a.free(empty);
        try std.testing.expectEqualStrings("", empty);
        try std.testing.expectEqual(@as(usize, 0), registry.series.items.len);
        try registry.registerNoTokioAgentRuntime();
        const first = try registry.render(a);
        defer a.free(first);
        inline for (.{
            .{ "hyperlane_tokio_dropped_tasks", "The number of tasks dropped", "counter" },
            .{ "hyperlane_tokio_blocking_threads", "The number of Tokio blocking pool threads, including idle threads", "gauge" },
            .{ "hyperlane_tokio_idle_blocking_threads", "The number of idle Tokio blocking pool threads", "gauge" },
        }) |family| {
            const expected = "# HELP " ++ family[0] ++ " " ++ family[1] ++ "\n# TYPE " ++ family[0] ++ " " ++ family[2] ++ "\n" ++ family[0] ++ "{agent=\"" ++ @tagName(role) ++ "\",hyperlane_baselib_version=\"fixture\"} 0\n";
            try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, first, expected));
        }
        try std.testing.expectEqual(@as(usize, 3), registry.series.items.len);
        const bytes = registry.bytes;
        try registry.registerNoTokioAgentRuntime();
        const again = try registry.render(a);
        defer a.free(again);
        try std.testing.expectEqualStrings(first, again);
        try std.testing.expectEqual(bytes, registry.bytes);
        try std.testing.expectEqual(@as(usize, 3), registry.series.items.len);
        try registry.update("hyperlane_tokio_dropped_tasks", &.{}, .{ .add_int = 7 });
        try registry.registerNoTokioAgentRuntime();
        const updated = try registry.render(a);
        defer a.free(updated);
        try std.testing.expect(std.mem.indexOf(u8, updated, "hyperlane_tokio_dropped_tasks{agent=\"" ++ @tagName(role) ++ "\",hyperlane_baselib_version=\"fixture\"} 7\n") != null);
    }
}

fn failingRuntimeStartup(a: A) !void {
    const registry = try Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 4096 });
    defer registry.deinit();
    try registry.registerNoTokioAgentRuntime();
    const rendered = try registry.render(a);
    a.free(rendered);
}

test "explicit agent Tokio startup allocation failures propagate without leaks and constructor stays bounded lazy" {
    const a = std.testing.allocator;
    const registry = try Registry.init(a, .relayer, .{ .base_version = "fixture", .max_series = 1, .max_render_bytes = 4096 });
    defer registry.deinit();
    try std.testing.expectEqual(@as(usize, 0), registry.series.items.len);
    try std.testing.expectError(error.MetricSeriesLimit, registry.registerNoTokioAgentRuntime());
    try std.testing.expectEqual(@as(usize, 1), registry.series.items.len);
    try std.testing.checkAllAllocationFailures(a, failingRuntimeStartup, .{});
}
