const std = @import("std");
const metrics = @import("metrics.zig");
const stream = @import("stream_metrics.zig");
const observer = @import("../agents/stream/observer.zig");
const A = std.mem.Allocator;
const prefix = "hyperlane_relayer_scraper_websocket_";
fn sample(wire: []const u8, name: []const u8, labels: []const []const u8) !i64 {
    var lines = std.mem.splitScalar(u8, wire, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{') continue;
        var found = true;
        for (labels) |label| if (std.mem.indexOf(u8, line, label) == null) {
            found = false;
        };
        if (!found) continue;
        const split = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.MissingSampleValue;
        return std.fmt.parseInt(i64, line[split + 1 ..], 10);
    }
    return error.MissingMetricSample;
}

test "Source relayer WS lifecycle records actual decisions and suppresses unchanged gauge polls" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try stream.StreamMetrics.init(a, registry, .{});
    defer adapter.deinit();
    const sink = adapter.interface();
    sink.notify("origin", .initial);
    try std.testing.expectEqual(@as(u64, 11), adapter.gauge_writes);
    var wire = try registry.render(a);
    try std.testing.expect(std.mem.indexOf(u8, wire, prefix ++ "events") == null);
    try std.testing.expect(std.mem.indexOf(u8, wire, "event_type=\"gas_payment\",result=") == null);
    a.free(wire);
    sink.notify("origin", .{ .state = .{ .active = true } });
    for (0..100) |_| sink.notify("origin", .{ .state = .{ .active = true } });
    try std.testing.expectEqual(@as(u64, 12), adapter.gauge_writes);
    sink.notify("origin", .initial); // attachment initialization is not reconnect
    try std.testing.expectEqual(@as(u64, 12), adapter.gauge_writes);
    sink.notify("origin", .{ .event = .{ .kind = .dispatch, .result = .accepted } });
    sink.notify("origin", .{ .event = .{ .kind = .dispatch, .result = .accepted } });
    sink.notify("origin", .{ .event = .{ .kind = .dispatch, .result = .duplicate } });
    sink.notify("origin", .{ .event = .{ .kind = .gas_payment, .result = .shadow } });
    sink.notify("origin", .{ .event = .{ .kind = .gas_payment, .result = .caught_up } });
    sink.notify("origin", .{ .event = .{ .kind = .unknown, .result = .invalid } });
    sink.notify("origin", .{ .event = .{ .kind = .dispatch, .result = .gap } });
    sink.notify("origin", .{ .stream = .{ .kind = .dispatch, .parity_pending = 1, .parity_ready = false } });
    const pending = try registry.render(a);
    defer a.free(pending);
    try std.testing.expectEqual(@as(i64, 1), try sample(pending, prefix ++ "parity_pending", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 0), try sample(pending, prefix ++ "parity_ready", &.{"event_type=\"dispatch\""}));
    sink.notify("origin", .{ .parity = .{ .kind = .dispatch, .result = .match } });
    sink.notify("origin", .{ .stream = .{ .kind = .dispatch, .parity_pending = 0, .parity_ready = true, .caught_up = true } });
    sink.notify("origin", .{ .state = .{ .fresh = true, .authority = true } });
    sink.notify("origin", .{ .state = .{ .fresh = false } }); // Source grace retains authority
    wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "active", &.{"chain=\"origin\""}));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "authority", &.{"chain=\"origin\""}));
    try std.testing.expectEqual(@as(i64, 0), try sample(wire, prefix ++ "fresh", &.{"chain=\"origin\""}));
    try std.testing.expectEqual(@as(i64, 2), try sample(wire, prefix ++ "events", &.{ "event_type=\"dispatch\"", "result=\"accepted\"" }));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "events", &.{ "event_type=\"dispatch\"", "result=\"duplicate\"" }));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "events", &.{ "event_type=\"gas_payment\"", "result=\"shadow\"" }));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "events", &.{ "event_type=\"unknown\"", "result=\"invalid\"" }));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "events", &.{ "event_type=\"dispatch\"", "result=\"gap\"" }));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "parity", &.{ "event_type=\"dispatch\"", "result=\"match\"" }));
    try std.testing.expectEqual(@as(i64, 0), try sample(wire, prefix ++ "parity_pending", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "parity_ready", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "caught_up", &.{"event_type=\"dispatch\""}));
    try std.testing.expect(std.mem.indexOf(u8, wire, prefix ++ "parity{chain=\"origin\",event_type=\"gas_payment\"") == null);
    sink.notify("origin", .{ .state = .{ .active = false, .authority = false, .fresh = false } });
    sink.notify("origin", .{ .stream = .{ .kind = .dispatch, .caught_up = false, .parity_pending = 0, .parity_ready = false } });
    sink.notify("origin", .{ .stream = .{ .kind = .gas_payment, .degraded = true, .caught_up = false } });
    sink.notify("origin", .{ .state = .{ .active = true } }); // new subscribed, still RPC
    const reconnected = try registry.render(a);
    defer a.free(reconnected);
    try std.testing.expectEqual(@as(i64, 1), try sample(reconnected, prefix ++ "active", &.{"chain=\"origin\""}));
    try std.testing.expectEqual(@as(i64, 0), try sample(reconnected, prefix ++ "authority", &.{"chain=\"origin\""}));
    try std.testing.expectEqual(@as(i64, 1), try sample(reconnected, prefix ++ "degraded", &.{"event_type=\"gas_payment\""}));
    try std.testing.expectEqual(@as(i64, 0), try sample(reconnected, prefix ++ "caught_up", &.{"event_type=\"dispatch\""}));
    try std.testing.expectEqual(@as(u64, 8), adapter.counter_writes);
    try std.testing.expectEqual(@as(u64, 0), adapter.failures.load(.acquire));
}

test "Source relayer WS terminal parity and event labels are bounded actual outcomes" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try stream.StreamMetrics.init(a, registry, .{ .max_chains = 1 });
    defer adapter.deinit();
    inline for (@typeInfo(observer.ParityResult).@"enum".fields) |field| try adapter.record("origin", .{ .parity = .{ .kind = .merkle_tree_insertion, .result = @enumFromInt(field.value) } });
    inline for (@typeInfo(observer.EventResult).@"enum".fields) |field| try adapter.record("origin", .{ .event = .{ .kind = .gas_payment, .result = @enumFromInt(field.value) } });
    const wire = try registry.render(a);
    defer a.free(wire);
    inline for (@typeInfo(observer.ParityResult).@"enum".fields) |field| try std.testing.expectEqual(@as(i64, 1), try sample(wire, prefix ++ "parity", &.{ "event_type=\"merkle_tree_insertion\"", "result=\"" ++ field.name ++ "\"" }));
    try std.testing.expectError(error.UnsupportedSourceMetric, adapter.record("origin", .{ .stream = .{ .kind = .dispatch, .degraded = true } }));
    try std.testing.expectError(error.UnsupportedSourceMetric, adapter.record("origin", .{ .stream = .{ .kind = .gas_payment, .parity_pending = 1 } }));
    try std.testing.expectError(error.UnsupportedSourceMetric, adapter.record("origin", .{ .event = .{ .kind = .dispatch, .result = .shadow } }));
    try std.testing.expectError(error.UnsupportedSourceMetric, adapter.record("origin", .{ .event = .{ .kind = .unknown, .result = .accepted } }));
    try std.testing.expectError(error.StreamMetricChainLimit, adapter.record("another", .initial));
    try std.testing.expectError(error.InvalidMetricChain, adapter.record("", .initial));
}

test "Source WS cursor labels raise atomically over RPC progress and canonical max-only probes" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try stream.StreamMetrics.init(a, registry, .{});
    defer adapter.deinit();
    try registry.update("hyperlane_cursor_current_sequence", &.{ "hyperlane_message", "origin", "forward_sequenced" }, .{ .set_int = 100 });
    try registry.update("hyperlane_cursor_max_sequence", &.{ "hyperlane_message", "origin" }, .{ .set_int = 100 });
    try adapter.record("origin", .{ .cursor = .{ .kind = .dispatch, .sequence = 50 } });
    try std.testing.expectEqual(@as(u64, 0), adapter.gauge_writes);
    try adapter.record("origin", .{ .cursor = .{ .kind = .dispatch, .sequence = 101 } });
    try adapter.record("origin", .{ .cursor = .{ .kind = .dispatch, .sequence = 150, .max_only = true } });
    try adapter.record("origin", .{ .cursor = .{ .kind = .dispatch, .sequence = 100 } }); // replay
    try registry.update("hyperlane_cursor_current_sequence", &.{ "hyperlane_message", "origin", "forward_sequenced" }, .{ .set_int = 201 });
    try adapter.record("origin", .{ .cursor = .{ .kind = .dispatch, .sequence = 200 } });
    try adapter.record("origin", .{ .cursor = .{ .kind = .merkle_tree_insertion, .sequence = 7 } });
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(i64, 201), try sample(wire, "hyperlane_cursor_current_sequence", &.{ "event_type=\"hyperlane_message\"", "cursor_type=\"forward_sequenced\"" }));
    try std.testing.expectEqual(@as(i64, 200), try sample(wire, "hyperlane_cursor_max_sequence", &.{"event_type=\"hyperlane_message\""}));
    try std.testing.expectEqual(@as(i64, 7), try sample(wire, "hyperlane_cursor_current_sequence", &.{ "event_type=\"merkle_tree_insertion\"", "cursor_type=\"forward_sequenced\"" }));
    try std.testing.expect(std.mem.indexOf(u8, wire, "event_type=\"dispatch\"") == null);
}

fn allocationExercise(a: A) !void {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const adapter = try stream.StreamMetrics.init(a, registry, .{});
    defer adapter.deinit();
    try adapter.record("origin", .initial);
    try adapter.record("origin", .{ .event = .{ .kind = .dispatch, .result = .accepted } });
    try adapter.record("origin", .{ .parity = .{ .kind = .dispatch, .result = .match } });
    try adapter.record("origin", .{ .cursor = .{ .kind = .dispatch, .sequence = 5 } });
    try adapter.record("another", .initial);
}
test "Source relayer stream metrics release every partial allocation" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationExercise, .{});
}
