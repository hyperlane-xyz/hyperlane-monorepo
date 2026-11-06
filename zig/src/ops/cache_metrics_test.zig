const std = @import("std");
const cm = @import("cache_metrics.zig");
const metrics = @import("metrics.zig");
const cache = cm.cache;
const a = std.testing.allocator;
const ctx: cache.Context = .{ .domain_name = "ethereum", .context_hash = @splat(1) };
fn sample(registry: *metrics.Registry, name: []const u8, labels: []const u8) !?u64 {
    const text = try registry.render(a);
    defer a.free(text);
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{') continue;
        if (std.mem.indexOf(u8, line, labels) == null) continue;
        const end = std.mem.lastIndexOfScalar(u8, line, ' ') orelse continue;
        return try std.fmt.parseInt(u64, line[end + 1 ..], 10);
    }
    return null;
}
fn expectSample(registry: *metrics.Registry, name: []const u8, labels: []const u8, value: u64) !void {
    try std.testing.expectEqual(@as(?u64, value), try sample(registry, name, labels));
}

test "cache metrics actual decisions aggregate both address partitions and count serialized JSON" {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var evm = try cache.Cache.init(a, .{ .max_entries = 2, .observer = adapter.interface(.evm), .default_ttl_ms = 10 });
    defer evm.deinit();
    var native = try cache.CacheFor([32]u8).Cache.init(a, .{ .max_entries = 2, .observer = adapter.interface(.native) });
    defer native.deinit();
    const q: cache.Query = .moduleType(@splat(2));
    try std.testing.expect(try evm.get(ctx, q, 0) == null);
    try std.testing.expect(try evm.put(ctx, q, &.{ .module_type = .routing }, 0));
    try std.testing.expect((try evm.get(ctx, q, 1)).?.module_type == .routing);
    try std.testing.expect(try native.put(ctx, .moduleType(@splat(3)), &.{ .module_type = .routing }, 0));
    try expectSample(registry, "hyperlane_cache_entry_count", "cache_name=\"relayer_cache\"", 2);
    // Independent JSON literal oracle: actual typed key and untagged value payload.
    const key_json = try std.json.Stringify.valueAlloc(a, .{ .kind = "module_type", .context_hash = ctx.context_hash, .domain_name = ctx.domain_name, .ism = @as([20]u8, @splat(2)), .subject = @as([32]u8, @splat(0)), .origin = @as(?u32, null), .validators = false }, .{});
    defer a.free(key_json);
    const native_key_json = try std.json.Stringify.valueAlloc(a, .{ .kind = "module_type", .context_hash = ctx.context_hash, .domain_name = ctx.domain_name, .ism = @as([32]u8, @splat(3)), .subject = @as([32]u8, @splat(0)), .origin = @as(?u32, null), .validators = false }, .{});
    defer a.free(native_key_json);
    try expectSample(registry, "hyperlane_cache_weighted_size_bytes", "relayer_cache", key_json.len + native_key_json.len + 2 * "\"routing\"".len);
    try std.testing.expect(try evm.put(ctx, q, &.{ .module_type = .aggregation }, 2));
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 2);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"size\"", 0);
    try std.testing.expect(try evm.put(ctx, .moduleType(@splat(4)), &.{ .module_type = .routing }, 2));
    try std.testing.expect(try evm.put(ctx, .moduleType(@splat(5)), &.{ .module_type = .routing }, 2));
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"size\"", 1);
    try std.testing.expect(try evm.get(ctx, .moduleType(@splat(4)), 12) == null);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"expired\"", 1);
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 2);
    _ = try native.get(ctx, .moduleType(@splat(9)), 12);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"size\"", 1);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"expired\"", 1);
    try expectSample(registry, "hyperlane_hit_count", "method=\"module_type\",status=\"success\"", 1);
    try expectSample(registry, "hyperlane_miss_count", "method=\"module_type\",status=\"success\"", 3);
    try std.testing.expectEqual(@as(usize, 0), adapter.failures);
}

test "cache metrics key and output allocation errors are failures never premature hits" {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var storage = std.testing.FailingAllocator.init(a, .{});
    var c = try cache.Cache.init(storage.allocator(), .{ .observer = adapter.interface(.evm) });
    defer c.deinit();
    const msg: @import("../protocol/root.zig").Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    const q: cache.Query = .members(@splat(2), msg, false, .message_specific);
    var members = [_][20]u8{@splat(7)};
    try std.testing.expect(try c.put(ctx, q, &.{ .members = .{ .addresses = &members, .threshold = 1 } }, 0));
    var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = 0 });
    try std.testing.expectError(error.OutOfMemory, c.getAlloc(failing.allocator(), ctx, q, 1));
    storage.fail_index = storage.alloc_index;
    try std.testing.expectError(error.OutOfMemory, c.get(ctx, q, 1));
    try std.testing.expectError(error.OutOfMemory, c.put(ctx, q, &.{ .members = .{ .addresses = &members, .threshold = 1 } }, 1));
    storage.fail_index = std.math.maxInt(usize);
    try expectSample(registry, "hyperlane_miss_count", "method=\"modules_and_threshold\",status=\"failure\"", 2);
    try std.testing.expectEqual(@as(?u64, null), try sample(registry, "hyperlane_hit_count", "method=\"modules_and_threshold\""));
    try std.testing.expectEqual(@as(usize, 0), c.snapshot().hits);
    var value = (try c.get(ctx, q, 1)).?;
    value.deinit(storage.allocator());
    try expectSample(registry, "hyperlane_hit_count", "method=\"modules_and_threshold\",status=\"success\"", 1);
    try std.testing.expectEqual(@as(usize, 1), c.snapshot().hits);
    try std.testing.expectEqual(@as(usize, 0), adapter.failures);
}

test "cache metrics disabled and default ISM operations are completely unmetered" {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var disabled = try cache.Cache.init(a, .{ .enabled = false, .observer = adapter.interface(.evm) });
    defer disabled.deinit();
    try std.testing.expect(try disabled.get(ctx, .moduleType(@splat(0)), 0) == null);
    try std.testing.expect(!try disabled.put(ctx, .moduleType(@splat(0)), &.{ .module_type = .routing }, 0));
    var c = try cache.Cache.init(a, .{ .observer = adapter.interface(.native), .default_ism_ttl_ms = 1 });
    defer c.deinit();
    try std.testing.expect(try c.get(ctx, .default_ism, 0) == null);
    try std.testing.expect(try c.put(ctx, .default_ism, &.{ .address = @splat(1) }, 0));
    _ = try c.get(ctx, .default_ism, 0);
    _ = try c.get(ctx, .default_ism, 1);
    try std.testing.expectEqual(@as(?u64, null), try sample(registry, "hyperlane_cache_entry_count", "relayer_cache"));
    try std.testing.expectEqual(@as(?u64, null), try sample(registry, "hyperlane_miss_count", "relayer_cache"));
    _ = try c.get(ctx, .moduleType(@splat(0)), 1);
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 0);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"expired\"", 0);
}

test "cache metrics registry allocation failure cannot change cache success" {
    var failing = std.testing.FailingAllocator.init(a, .{});
    const registry = try metrics.Registry.init(failing.allocator(), .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var c = try cache.Cache.init(a, .{ .observer = adapter.interface(.evm) });
    defer c.deinit();
    failing.fail_index = failing.alloc_index;
    try std.testing.expect(try c.put(ctx, .moduleType(@splat(0)), &.{ .module_type = .routing }, 0));
    try std.testing.expect((try c.get(ctx, .moduleType(@splat(0)), 0)).?.module_type == .routing);
    try std.testing.expectEqual(@as(usize, 2), adapter.failures);
    failing.fail_index = std.math.maxInt(usize);
    _ = try c.get(ctx, .moduleType(@splat(0)), 0);
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 1);
    try expectSample(registry, "hyperlane_hit_count", "method=\"module_type\"", 1);
}

test "cache metrics actual CachedSource distinguishes cache success miss from remote call failure" {
    const Source = struct {
        pub const parallel_quorum = false;
        pub const parallel_latest = false;
        calls: usize = 0,
        fail: bool = false,
        pub fn moduleType(self: *@This(), _: [20]u8) !@import("../relayer/metadata.zig").ModuleType {
            self.calls += 1;
            if (self.fail) return error.TransportError;
            return .routing;
        }
    };
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var c = try cache.Cache.init(a, .{ .observer = adapter.interface(.evm) });
    defer c.deinit();
    var source: Source = .{};
    var cached = @import("../relayer/cached_source.zig").CachedSource(Source).initBorrowed(a, &source, &c, .{ .context = ctx });
    _ = try cached.moduleType(@splat(1));
    _ = try cached.moduleType(@splat(1));
    try std.testing.expectEqual(@as(usize, 1), source.calls);
    source.fail = true;
    try std.testing.expectError(error.TransportError, cached.moduleType(@splat(2)));
    try expectSample(registry, "hyperlane_hit_count", "method=\"module_type\",status=\"success\"", 1);
    try expectSample(registry, "hyperlane_miss_count", "method=\"module_type\",status=\"success\"", 2);
    try std.testing.expectEqual(@as(?u64, null), try sample(registry, "hyperlane_miss_count", "status=\"failure\""));
}

test "cache metrics grow replace budget eviction and partition retirement never reset cumulative totals" {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var c = try cache.Cache.init(a, .{ .max_entries = 8, .max_bytes = 300, .observer = adapter.interface(.evm) });
    const msg: @import("../protocol/root.zig").Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    const q: cache.Query = .members(@splat(2), msg, false, .message_specific);
    var one = [_][20]u8{@splat(1)};
    var six = [_][20]u8{@splat(1)} ** 6;
    try std.testing.expect(try c.put(ctx, q, &.{ .members = .{ .addresses = &one, .threshold = 1 } }, 0));
    try std.testing.expect(try c.put(ctx, .moduleType(@splat(2)), &.{ .module_type = .routing }, 0));
    try std.testing.expect(try c.put(ctx, q, &.{ .members = .{ .addresses = &six, .threshold = 1 } }, 0));
    try std.testing.expect(c.snapshot().bytes <= 300);
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 1);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"size\"", 1);
    var native = try cache.CacheFor([32]u8).Cache.init(a, .{ .observer = adapter.interface(.native) });
    defer native.deinit();
    try std.testing.expect(try native.put(ctx, .moduleType(@splat(4)), &.{ .module_type = .routing }, 0));
    c.deinit();
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 1);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"size\"", 1);
    c = try cache.Cache.init(a, .{ .max_entries = 1, .observer = adapter.interface(.evm) });
    defer c.deinit();
    for (0..3) |n| try std.testing.expect(try c.put(ctx, .moduleType(@splat(@intCast(n))), &.{ .module_type = .routing }, 0));
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 2);
    try expectSample(registry, "hyperlane_cache_eviction_count", "cause=\"size\"", 3);
    try std.testing.expectEqual(@as(usize, 0), adapter.failures);
}

const Worker = struct {
    c: *cache.Cache,
    marker: u8,
    error_value: ?anyerror = null,
    fn run(self: *Worker) void {
        self.runInner() catch |err| {
            self.error_value = err;
        };
    }
    fn runInner(self: *Worker) !void {
        for (0..40) |_| {
            _ = try self.c.put(ctx, .moduleType(@splat(self.marker)), &.{ .module_type = .routing }, 0);
            _ = try self.c.get(ctx, .moduleType(@splat(self.marker)), 0);
        }
    }
};
test "cache metrics concurrent callbacks preserve shared counters and partition gauges" {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var evm = try cache.Cache.init(a, .{ .observer = adapter.interface(.evm) });
    defer evm.deinit();
    // The observer contract is independent of address width; two distinct caches
    // exercise concurrent partition snapshots and same-label counter increments.
    var native = try cache.Cache.init(a, .{ .observer = adapter.interface(.native) });
    defer native.deinit();
    var workers = [_]Worker{ .{ .c = &evm, .marker = 1 }, .{ .c = &evm, .marker = 2 }, .{ .c = &native, .marker = 3 }, .{ .c = &native, .marker = 4 } };
    var threads: [4]std.Thread = undefined;
    for (&threads, &workers) |*thread, *worker| thread.* = try std.Thread.spawn(.{}, Worker.run, .{worker});
    for (threads) |thread| thread.join();
    for (workers) |worker| try std.testing.expectEqual(@as(?anyerror, null), worker.error_value);
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 4);
    try expectSample(registry, "hyperlane_hit_count", "method=\"module_type\",status=\"success\"", 160);
    try std.testing.expectEqual(@as(usize, 0), adapter.failures);
}

test "cache metrics Source method labels cover all typed query kinds without default ISM" {
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: cm.Adapter = .{ .registry = registry };
    var c = try cache.Cache.init(a, .{ .observer = adapter.interface(.evm) });
    defer c.deinit();
    const msg: @import("../protocol/root.zig").Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(0), .recipient = @splat(0), .body = "" };
    var addresses = [_][20]u8{@splat(1)};
    var encoded = "urlcallextra".*;
    var urls = [_][]const u8{encoded[0..3]};
    const queries = [_]cache.Query{ .moduleType(@splat(1)), .route(@splat(1), msg, .message_specific), .members(@splat(1), msg, false, .message_specific), .members(@splat(1), msg, true, .message_specific), .recipientIsm(@splat(1)), .offchainLookup(@splat(1), msg) };
    const values = [_]cache.Value{
        .{ .module_type = .routing },
        .{ .address = @splat(1) },
        .{ .members = .{ .addresses = &addresses, .threshold = 1 } },
        .{ .validators = .{ .addresses = &addresses, .threshold = 1 } },
        .{ .address = @splat(1) },
        .{ .offchain_lookup = .{ .allocator = a, .encoded = &encoded, .sender = @splat(1), .urls = &urls, .call_data = encoded[3..7], .callback_function = @splat(2), .extra_data = encoded[7..] } },
    };
    const methods = [_][]const u8{ "module_type", "route", "modules_and_threshold", "validators_and_threshold", "recipient_ism", "get_offchain_verify_info" };
    for (queries, values, methods) |q, value, method| {
        try std.testing.expect(try c.get(ctx, q, 0) == null);
        try std.testing.expect(try c.put(ctx, q, &value, 0));
        var owned = (try c.get(ctx, q, 0)).?;
        owned.deinit(a);
        var buf: [128]u8 = undefined;
        const labels = try std.fmt.bufPrint(&buf, "method=\"{s}\",status=\"success\"", .{method});
        try expectSample(registry, "hyperlane_hit_count", labels, 1);
        try expectSample(registry, "hyperlane_miss_count", labels, 1);
    }
    try expectSample(registry, "hyperlane_cache_entry_count", "relayer_cache", 6);
    try std.testing.expectEqual(@as(usize, 0), adapter.failures);
}
