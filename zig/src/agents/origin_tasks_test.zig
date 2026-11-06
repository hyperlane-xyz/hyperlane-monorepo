const std = @import("std");
const tasks = @import("origin_tasks.zig");
const settings = @import("../settings/types.zig");
const remote = @import("../relayer/remote_checkpoints.zig");

test "origin task construction performs no database network or native-library discovery" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    // Only descriptor fields are relevant before workers execute. The engine
    // address is valid; constructor/deinit must never read the borrowed engine.
    var engine: remote.Engine = undefined;
    var chains: [2]settings.Chain = undefined;
    for (&chains, 0..) |*chain, i| {
        chain.domain = @intCast(i + 1);
        chain.name = if (i == 0) "first" else "second";
        chain.protocol = if (i == 0) .ethereum else .sealevel;
        chain.index = .{ .interval = 2 };
    }
    const database = try tasks.DatabaseOwner.init(a, "/nonexistent/ziggy-origin-constructor-test/database");
    defer database.deinit();
    const registry = try @import("../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    const set = try tasks.Set.open(a, &chains, &environment, database, &engine, .{ .source = .{ .curl_library = "/nonexistent/ziggy-native-library", .metrics = registry } });
    defer set.deinit();
    try std.testing.expect(database.value == null);
    try std.testing.expectEqual(@as(usize, 2), set.descriptors().len);
    for (set.slots) |*slot| {
        try std.testing.expect(slot.handle() == null);
        if (slot.metrics) |*adapter| try std.testing.expectEqual(@intFromPtr(adapter), @intFromPtr(adapter.interface().context)) else return error.MissingOriginMetricAdapter;
        try std.testing.expect(slot.network == null);
        try std.testing.expect(slot.discovery_network == null);
    }
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_contract_sync_liveness{") == null);
}

test "origin bootstrap pre-canceled descriptor never constructs resources or records failures" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var engine: remote.Engine = undefined;
    var chains: [1]settings.Chain = undefined;
    chains[0].name = "pre-canceled";
    chains[0].domain = 1;
    chains[0].index = .{};
    const database = try tasks.DatabaseOwner.init(a, "/nonexistent/pre-canceled-origin");
    defer database.deinit();
    const registry = try @import("../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var tracker: @import("../ops/critical_metrics.zig").Tracker = .{ .registry = registry, .chain = "pre-canceled" };
    const set = try tasks.Set.open(a, &chains, &environment, database, &engine, .{ .source = .{ .curl_library = "/nonexistent/pre-canceled-curl", .metrics = registry } });
    defer set.deinit();
    set.slots[0].critical = &tracker;
    var cancel = std.atomic.Value(bool).init(true);
    const descriptor = set.descriptors()[0];
    for (0..5) |i| try std.testing.expectError(error.RequestCancelled, descriptor.run(descriptor.context, .{ .unix_ms = i, .monotonic_ms = i }, &cancel));
    try std.testing.expectEqual(@as(u8, 0), set.slots[0].initialization_failures);
    try std.testing.expectEqual(@as(u16, 0), tracker.reasons);
    try std.testing.expect(set.slots[0].network == null);
    try std.testing.expect(database.value == null);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_critical_error{") == null);
}

test "transaction-ID disabled role flag performs ordinary indexing without companion construction or receipt requests" {
    const a = std.testing.allocator;
    const fixture = try @import("indexing/tx_id_native_test.zig").Harness.init(a, 1, 2);
    defer fixture.deinit();
    fixture.service.store.dispatch_notifications = null; // a newly constructed role Store has no observer
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var engine: remote.Engine = undefined;
    var chains: [2]settings.Chain = .{ fixture.chain, undefined };
    chains[1].name = "test2";
    chains[1].domain = 9913372;
    chains[1].protocol = .ethereum;
    chains[1].index = .{ .interval = 1 };
    const database = try tasks.DatabaseOwner.init(a, fixture.path);
    database.value = fixture.database; // borrowed handle for this descriptor fixture
    defer {
        database.value = null;
        database.deinit();
    }
    const set = try tasks.Set.open(a, &chains, &environment, database, &engine, .{ .source = .{ .curl_library = "/nonexistent/disabled-tx-id-library" }, .tx_id_indexing_enabled = false });
    defer {
        set.slots[0].implementation = .none;
        set.deinit();
    }
    const resources = @import("chain_source.zig");
    const network = try a.create(resources.Resources);
    network.* = .{ .allocator = a, .arena = std.heap.ArenaAllocator.init(a), .chain = chains[0], .options = .{ .curl_library = "unused" }, .environment = &environment, .http = @import("../cloud/http.zig").HttpTransport.init(a) };
    set.slots[0].network = network;
    set.slots[0].implementation = .{ .ethereum = fixture.service };
    set.slots[0].migration = try @import("loader.zig").Loader.init(a, &fixture.service.store, &.{9913372}, .{});
    set.slots[0].ready.store(true, .release);
    const descriptor = set.descriptors()[0];
    var cancel = std.atomic.Value(bool).init(false);
    for (0..3) |_| _ = try descriptor.run(descriptor.context, .{ .monotonic_ms = 0, .unix_ms = 1000 }, &cancel);
    try std.testing.expect(set.slots[0].transaction_queue == null);
    try std.testing.expect(set.slots[0].transaction_companion == null);
    try std.testing.expect(set.slots[0].transaction_network == null);
    try std.testing.expect(fixture.service.store.dispatch_notifications == null);
    try std.testing.expectEqual([2]usize{ 0, 0 }, fixture.wire.receipt_reads);
    var stored = (try fixture.service.store.messageByNonce(0)).?;
    defer stored.deinit();
    try std.testing.expectEqual(fixture.wire.messages[0].id(), stored.value.id());
}
