//! Native RocksDB fixture; imported only by the linked native DB test root.
const std = @import("std");
const db = @import("../../db/root.zig");
const settings = @import("../../settings/types.zig");
const service = @import("service.zig");
const fixture = @import("testing.zig");
const protocol = @import("../../protocol/root.zig");
const initialization = @import("../../ops/init_metrics.zig");
const Initialization = struct {
    adapter: initialization.Adapter,
    counts: [10]usize = @splat(0),
    fn observer(self: *@This()) initialization.Observer {
        return .{ .context = self, .completed_fn = completed };
    }
    fn completed(context: *anyopaque, entity: initialization.Entity, elapsed_ns: u64) void {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.counts[@intFromEnum(entity)] += 1;
        self.adapter.observer().completed(entity, elapsed_ns);
    }
};
test "native generic relayer origin persists every stream reopens cursors and builds historical proofs" {
    const a = std.testing.allocator;
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const base = try directory.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "generic-origin" });
    defer a.free(path);
    const events = fixture.events();
    var source: fixture.Chain = .{ .logs = &events };
    // Only these typed configuration fields are consumed by this borrowed-source
    // service; no signer/connection descriptor is consulted by native indexing.
    var chain: settings.Chain = undefined;
    chain.protocol = .cosmos;
    chain.name = "cosmos-native-fixture";
    chain.domain = 10;
    chain.index = .{ .from = 1, .chunk = 5, .mode = .block, .interval = 1 };
    chain.contracts = .{ .mailbox = fixture.contracts.mailbox, .merkle_tree_hook = fixture.contracts.hook, .interchain_gas_paymaster = fixture.contracts.paymaster, .validator_announce = @splat(0) };
    var database = try db.rocks.Database.open(a, path, .{});
    var closed = false;
    defer if (!closed) database.deinit();
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: @import("../../ops/indexing_metrics.zig").Adapter = .{ .registry = registry, .chain = chain.name, .unix_seconds = 1000 };
    var initialized: Initialization = .{ .adapter = .{ .registry = registry, .chain = chain.name, .role = .origin } };
    const driver = try service.Service.open(a, &chain, source.interface(), &database, null, true);
    driver.observeInitialization(initialized.observer());
    driver.observeInitialization(initialized.observer());
    driver.indexer.observer = adapter.interface();
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expect((try metric(text, "hyperlane_contract_sync_liveness", "dispatched_messages")) == null);
        try std.testing.expect((try metric(text, "hyperlane_chain_init_latency", "prover_sync")) != null);
        try std.testing.expect((try metric(text, "hyperlane_chain_init_latency", "message_sync")) == null);
    }
    var destroyed = false;
    defer if (!destroyed) driver.deinit();
    const messages = try driver.tick(0, null);
    const insertions = try driver.tick(0, null);
    const payments = try driver.tick(0, null);
    for ([_]initialization.Entity{ .prover_sync, .message_sync, .merkle_tree_hook_sync, .interchain_gas_payment_sync }) |entity| try std.testing.expectEqual(@as(usize, 1), initialized.counts[@intFromEnum(entity)]);
    try std.testing.expectEqual(@as(usize, 2), messages.messages);
    try std.testing.expectEqual(@as(usize, 2), insertions.insertions);
    try std.testing.expectEqual(@as(usize, 2), payments.payments);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "merkle_tree_hook"));
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "gas_payments"));
        try std.testing.expectEqual(@as(?i64, 1000), try metric(text, "hyperlane_contract_sync_liveness", "dispatched_messages"));
    }
    // Actual caught-up cycles refresh liveness but do not claim another store.
    adapter.unix_seconds = 1001;
    _ = try driver.tick(1000, null);
    for ([_]initialization.Entity{ .prover_sync, .message_sync, .merkle_tree_hook_sync, .interchain_gas_payment_sync }) |entity| try std.testing.expectEqual(@as(usize, 1), initialized.counts[@intFromEnum(entity)]);
    _ = try driver.tick(1000, null);
    _ = try driver.tick(1000, null);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 1001), try metric(text, "hyperlane_contract_sync_liveness", "dispatched_messages"));
    }
    var tree = protocol.IncrementalMerkle.init();
    for (0..2) |i| {
        const message = events[i * 3].data.dispatch;
        try tree.ingest(message.id());
        var stored = (try driver.store.messageByNonce(@intCast(i))).?;
        defer stored.deinit();
        try std.testing.expectEqualSlices(u8, &message.id(), &stored.value.id());
        const payment = (try driver.store.payment(.{ .message_id = message.id(), .destination = 20 })).?;
        try std.testing.expectEqual(@as(u256, 200), payment.payment);
    }
    const checkpoint: protocol.Checkpoint = .{ .mailbox_domain = 10, .merkle_tree_hook_address = fixture.contracts.hook, .root = tree.root(), .index = 1, .message_id = events[3].data.dispatch.id() };
    try std.testing.expect((try driver.history.proof(0, checkpoint)).verify(checkpoint.root));
    driver.deinit();
    destroyed = true;
    database.deinit();
    closed = true;
    var reopened = try db.rocks.Database.open(a, path, .{});
    defer reopened.deinit();
    const resumed = try service.Service.open(a, &chain, source.interface(), &reopened, null, false);
    defer resumed.deinit();
    const resumed_registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer resumed_registry.deinit();
    var resumed_initialization: Initialization = .{ .adapter = .{ .registry = resumed_registry, .chain = chain.name, .role = .origin } };
    resumed.observeInitialization(resumed_initialization.observer());
    resumed.indexer.observer = adapter.interface();
    adapter.unix_seconds = 1002;
    const replay = try resumed.tick(1000, null);
    try std.testing.expectEqual(@as(usize, 0), resumed_initialization.counts[@intFromEnum(initialization.Entity.interchain_gas_payment_sync)]);
    {
        const text = try resumed_registry.render(a);
        defer a.free(text);
        try std.testing.expect((try metric(text, "hyperlane_chain_init_latency", "interchain_gas_payment_sync")) == null);
    }
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 1002), try metric(text, "hyperlane_contract_sync_liveness", "dispatched_messages"));
    }
    try std.testing.expectEqual(@as(usize, 0), replay.messages);
    try std.testing.expectEqual(@as(usize, 2), replay.prover_leaves);
    try std.testing.expect((try resumed.history.proof(0, checkpoint)).verify(checkpoint.root));
}

fn metric(text: []const u8, name: []const u8, data_type: []const u8) !?i64 {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{' or std.mem.indexOf(u8, line, data_type) == null) continue;
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        return try std.fmt.parseInt(i64, line[space + 1 ..], 10);
    }
    return null;
}

test {
    _ = @import("evm_native_test.zig");
}

test {
    _ = @import("testing.zig");
}

test {
    _ = @import("bootstrap_native_test.zig");
    _ = @import("cursor_bootstrap.zig");
}
