//! Actual Root lane loader and public Control handoff share one native store.
const std = @import("std");
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const root = @import("agents/relayer_task.zig");
const control = @import("agents/relayer/control.zig");
const settings = @import("settings/root.zig");
const origins = @import("agents/origin_tasks.zig");
const ethereum = @import("agents/evm_origin.zig");
const history = @import("agents/origin.zig");
const native = @import("agents/store.zig");
const db = @import("db/root.zig");
const protocol = @import("protocol/root.zig");
const denylist = @import("ops/runtime_denylist.zig");
const metrics = @import("ops/metrics.zig");
const relayer_metrics = @import("ops/relayer_metrics.zig");
const A = std.mem.Allocator;
const OriginLane = std.meta.Child(@FieldType(root.Lane, "origins"));
const Item = std.meta.Child(std.meta.Child(@FieldType(@FieldType(root.Lane, "active"), "items")));
const Fixture = struct {
    configured: settings.Settings,
    chains: [2]settings.Chain,
    environment: std.process.EnvMap,
    database: db.rocks.Database,
    origin: ethereum.Service,
    slots: [1]origins.Slot,
    origin_set: origins.Set,
    lane_origins: [1]OriginLane,
    owner: root.TaskSet,
    hub: *control.Hub,
    lane: root.Lane,
    metric_registry: ?*metrics.Registry = null,
    cancel: std.atomic.Value(bool) = .init(false),
    fn init(a: A, path: []const u8, max_active: usize, max_bytes: usize) !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        self.* = undefined;
        self.metric_registry = null;
        self.cancel = .init(false);
        self.chains = undefined;
        self.chains[0].name = "origin";
        self.chains[0].domain = 1;
        self.chains[0].protocol = .ethereum;
        self.chains[1].name = "destination";
        self.chains[1].domain = 2;
        self.chains[1].protocol = .ethereum;
        self.configured.chains = &self.chains;
        self.configured.role = .{ .relayer = std.mem.zeroes(@import("settings/types.zig").Relayer) };
        self.environment = std.process.EnvMap.init(a);
        errdefer self.environment.deinit();
        self.database = try db.rocks.Database.open(a, path, .{ .sync = true });
        errdefer self.database.deinit();
        self.origin = .{ .allocator = a, .chain = &self.chains[0], .store = native.Store.init(a, &self.database, "origin"), .history = undefined, .indexer = undefined, .progress = undefined, .gas_enabled = false };
        self.origin.history = history.Origin.init(a, &self.origin.store, 1, .{0} ** 32, null);
        errdefer self.origin.history.deinit();
        self.slots[0] = .{ .allocator = a, .chain = &self.chains[0], .environment = &self.environment, .database = undefined, .checkpoints = undefined, .options = .{ .source = .{ .curl_library = "unused" } }, .destinations = &.{2}, .implementation = .{ .ethereum = &self.origin }, .ready = .init(true) };
        self.origin_set = .{ .allocator = a, .slots = &self.slots, .tasks = &.{}, .destinations = &.{} };
        self.lane_origins = .{.{}};
        self.owner = undefined;
        self.owner.allocator = a;
        self.owner.settings = &self.configured;
        self.owner.environment = &self.environment;
        self.owner.options = .{ .curl_library = "unused", .max_active = max_active, .max_active_bytes = max_bytes, .max_retained_bytes = 1024 * 1024 };
        self.owner.metric_tracker = null;
        self.owner.origins = &self.origin_set;
        self.owner.memory_mutex = .{};
        self.owner.retained_bytes = 0;
        self.owner.effects_halted = .init(false);
        self.owner.denylist_ready = .init(true);
        self.owner.denylist = try denylist.RuntimeDenylist.init(a, null);
        errdefer self.owner.denylist.deinit();
        self.owner.control_hub = try control.Hub.init(a, &self.configured, &self.environment, &self.origin_set, undefined, null, &self.owner.denylist);
        self.hub = &self.owner.control_hub;
        errdefer self.hub.deinit();
        const commands = try control.Control.init(self.hub, &self.chains[1]);
        errdefer commands.deinit();
        self.lane = .{ .owner = &self.owner, .chain = &self.chains[1], .origins = &self.lane_origins, .control = commands, .worker = undefined };
        self.lane.active = try std.ArrayList(*Item).initCapacity(a, 1);
        return self;
    }
    fn enableMetrics(self: *Fixture, a: A) !void {
        const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
        self.metric_registry = registry;
        self.owner.options.metrics = registry;
        self.owner.metric_tracker = try relayer_metrics.WaitTracker.init(a, registry, .{ .max_active = self.owner.options.max_active, .max_bytes = self.owner.options.max_active_bytes });
        for (&self.lane_origins, 0..) |*origin, index| origin.metrics = try relayer_metrics.Adapter.init(a, self.owner.metric_tracker.?, self.chains[index].name, self.chains[1].name);
    }
    fn deinit(self: *Fixture, a: A) void {
        self.lane.control.deinit();
        for (self.lane.active.items) |item| {
            self.owner.retained_bytes -= item.retained_bytes;
            if (item.metric_app_context) |value| a.free(value);
            item.message.deinit();
            a.destroy(item);
        }
        self.lane.active.deinit(a);
        for (&self.lane_origins) |*origin| {
            if (origin.loader) |*value| value.deinit();
            if (origin.policy) |*value| value.deinit();
            if (origin.metrics) |value| value.deinit();
        }
        if (self.owner.metric_tracker) |tracker| tracker.deinit();
        if (self.metric_registry) |registry| registry.deinit();
        std.debug.assert(self.owner.retained_bytes == 0);
        self.hub.deinit();
        self.owner.denylist.deinit();
        self.origin.history.deinit();
        self.database.deinit();
        self.environment.deinit();
        a.destroy(self);
    }
    const Command = enum { reserve, authorize, commit, reprocess };
    const Caller = struct {
        fixture: *Fixture,
        command: Command,
        message: protocol.Message,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            self.call() catch |err| {
                self.failure = err;
            };
        }
        fn call(self: *@This()) !void {
            const f = self.fixture;
            switch (self.command) {
                .reserve => try f.hub.relayReserve(f.lane.control, 1, .{3} ** 64, &.{self.message}, 3000, &f.cancel),
                .authorize => try f.hub.relayAuthorize(f.lane.control, 1, 3000, &f.cancel),
                .commit => try f.hub.relayCommit(f.lane.control, 1, 3000, &f.cancel),
                .reprocess => {
                    const owner = f.hub.reprocessOwner();
                    const result = try owner.enqueue_fn(owner.context, f.owner.allocator, self.message, &f.cancel);
                    f.owner.allocator.free(result);
                },
            }
        }
    };
    fn command(self: *Fixture, kind: Command, value: protocol.Message) !void {
        var caller: Caller = .{ .fixture = self, .command = kind, .message = value };
        const thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
        var joined = false;
        defer if (!joined) thread.join();
        var timer = try std.time.Timer.start();
        while (!self.lane.control.wake.load(.acquire)) {
            if (timer.read() > 2 * std.time.ns_per_s) {
                self.cancel.store(true, .release);
                return error.ReservationCommandDidNotWake;
            }
            std.Thread.sleep(std.time.ns_per_ms);
        }
        _ = try self.lane.control.drain(&self.lane, .{ .unix_ms = 1000, .monotonic_ms = 1 }, &self.cancel);
        thread.join();
        joined = true;
        if (caller.failure) |err| return err;
    }
};
fn message(nonce: u32, body: []const u8) protocol.Message {
    return .{ .version = 3, .nonce = nonce, .origin = 1, .destination = 2, .sender = .{1} ** 32, .recipient = .{2} ** 32, .body = body };
}
test "Root native public reserve ordinary load and commit retain capacity and per-lane limits" {
    const a = std.testing.allocator;
    const public = message(10, "receipt");
    const canonical = message(0, "canonical");
    const public_bytes = public.encodedLen() + @sizeOf(Item);
    const canonical_bytes = canonical.encodedLen() + @sizeOf(Item);
    for (0..3) |scenario| {
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        const parent = try temp.dir.realpathAlloc(a, ".");
        defer a.free(parent);
        const path = try std.fs.path.join(a, &.{ parent, "rocks" });
        defer a.free(path);
        const fixture = try Fixture.init(a, path, if (scenario == 1) 1 else 2, if (scenario == 2) public_bytes + canonical_bytes - 1 else 1024 * 1024);
        defer fixture.deinit(a);
        try fixture.origin.store.upsertMessage(canonical, 1, null);
        try fixture.command(.reserve, public);
        try std.testing.expectEqual(@as(usize, 1), fixture.lane.control.reservedSlots());
        try std.testing.expectEqual(@as(usize, 1), fixture.lane.active.capacity);
        const loaded = try fixture.lane.load(.{ .unix_ms = 1001, .monotonic_ms = 2 });
        try std.testing.expectEqual(@as(u64, if (scenario == 0) 1 else 0), loaded);
        if (scenario == 0) {
            try std.testing.expect(fixture.lane.active.capacity >= 2);
            try std.testing.expectEqual(canonical.id(), fixture.lane.active.items[0].message.value.id());
        }
        try fixture.command(.authorize, public);
        try fixture.command(.commit, public);
        try std.testing.expectEqual(@as(usize, 0), fixture.lane.control.reservedSlots());
        try std.testing.expectEqual(@as(usize, if (scenario == 0) 2 else 1), fixture.lane.active.items.len);
        try std.testing.expect(fixture.lane.active.items.len <= fixture.owner.options.max_active);
        try std.testing.expect(fixture.lane.active_bytes <= fixture.owner.options.max_active_bytes);
        try std.testing.expectEqual(public.id(), fixture.lane.active.items[fixture.lane.active.items.len - 1].message.value.id());
        try std.testing.expectEqual(fixture.lane.active_bytes + fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
        try std.testing.expect(try fixture.origin.store.operationMessageAuthorized(public));
        var indexed = (try fixture.origin.store.messageByNonce(0)).?;
        defer indexed.deinit();
        try std.testing.expectEqual(canonical.id(), indexed.value.id());
        try std.testing.expect((try fixture.origin.store.messageByNonce(10)) == null);
    }
}

const WatchAllocator = struct {
    backing: A,
    alloc_index: usize = 0,
    fail_index: usize = std.math.maxInt(usize),
    lane: ?*root.Lane = null,
    post_append_failure: bool = false,

    fn allocator(self: *WatchAllocator) A {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(context: *anyopaque, len: usize, alignment: std.mem.Alignment, return_address: usize) ?[*]u8 {
        const self: *WatchAllocator = @ptrCast(@alignCast(context));
        if (self.alloc_index == self.fail_index) {
            if (self.lane != null and self.lane.?.active.items.len > 0) self.post_append_failure = true;
            self.fail_index = std.math.maxInt(usize);
            return null;
        }
        const result = self.backing.rawAlloc(len, alignment, return_address);
        if (result != null) self.alloc_index += 1;
        return result;
    }

    fn resize(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, new_len: usize, return_address: usize) bool {
        const self: *WatchAllocator = @ptrCast(@alignCast(context));
        return self.backing.rawResize(bytes, alignment, new_len, return_address);
    }

    fn remap(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, new_len: usize, return_address: usize) ?[*]u8 {
        const self: *WatchAllocator = @ptrCast(@alignCast(context));
        return self.backing.rawRemap(bytes, alignment, new_len, return_address);
    }

    fn free(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, return_address: usize) void {
        const self: *WatchAllocator = @ptrCast(@alignCast(context));
        self.backing.rawFree(bytes, alignment, return_address);
    }
};

fn enableAppContext(fixture: *Fixture) !void {
    fixture.configured.role.relayer.metric_app_contexts = &.{.{ .name = "app", .matching_list = &.{.{}} }};
    try fixture.enableMetrics(fixture.owner.allocator);
}

test "Root ordinary and public lazy metric labels are inside retained byte budgets" {
    const a = std.testing.allocator;
    const canonical = message(0, "canonical");
    const public = message(10, "receipt");
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    const fixture = try Fixture.init(a, path, 2, 1024 * 1024);
    defer fixture.deinit(a);
    try enableAppContext(fixture);
    try fixture.origin.store.upsertMessage(canonical, 1, null);

    try std.testing.expectEqual(@as(u64, 1), try fixture.lane.load(.{ .unix_ms = 1001, .monotonic_ms = 2 }));
    const ordinary = fixture.lane.active.items[0];
    if (ordinary.metric_app_context == null) return error.MissingOrdinaryAppContext;
    if (ordinary.metric_app_context.?.len != 3) return error.OrdinaryAppContextLengthMismatch;
    if (ordinary.retained_bytes != canonical.encodedLen() + @sizeOf(Item) + 3) return error.OrdinaryRetainedBytesMismatch;
    try std.testing.expectEqual(ordinary.retained_bytes, fixture.lane.active_bytes);
    try std.testing.expectEqual(fixture.lane.active_bytes + fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);

    try fixture.command(.reserve, public);
    try fixture.command(.authorize, public);
    try fixture.command(.commit, public);
    const lazy = fixture.lane.active.items[fixture.lane.active.items.len - 1];
    try std.testing.expect(lazy.lane == null);
    const lazy_app = try fixture.lane_origins[0].policy.?.appContext(public);
    try std.testing.expectEqualStrings("app", lazy_app.?);
    try fixture.origin.store.markTerminal(public.id());
    const active_bytes = fixture.lane.active_bytes;
    try std.testing.expect(try fixture.lane.advance(lazy, .{ .unix_ms = 1002, .monotonic_ms = 3 }, &fixture.cancel));
    if (fixture.lane.active_bytes != active_bytes + 3) return error.LazyActiveBytesMismatch;
    if (lazy.retained_bytes != public.encodedLen() + @sizeOf(Item) + 3) return error.LazyRetainedBytesMismatch;
    try std.testing.expectEqual(fixture.lane.active_bytes + fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
}

test "Root core allocation failures roll back ownership while telemetry pressure preserves admitted work" {
    var saw_post_append_failure = false;
    var saw_core_failure = false;
    for (0..96) |failure_offset| {
        const canonical = message(0, "canonical");
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        var watch: WatchAllocator = .{ .backing = std.testing.allocator };
        const a = watch.allocator();
        const parent = try temp.dir.realpathAlloc(a, ".");
        defer a.free(parent);
        const path = try std.fs.path.join(a, &.{ parent, "rocks" });
        defer a.free(path);
        const fixture = try Fixture.init(a, path, 2, 1024 * 1024);
        defer fixture.deinit(a);
        watch.lane = &fixture.lane;
        try fixture.enableMetrics(a);
        try fixture.origin.store.upsertMessage(canonical, 1, null);
        watch.fail_index = watch.alloc_index + failure_offset;
        const loaded = fixture.lane.load(.{ .unix_ms = 1001, .monotonic_ms = 2 }) catch |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expectEqual(@as(usize, 0), fixture.lane.active.items.len);
            try std.testing.expectEqual(@as(usize, 0), fixture.lane.active_bytes);
            try std.testing.expectEqual(fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
            try std.testing.expectEqual(@as(usize, 0), fixture.owner.metric_tracker.?.activeCount());
            if (fixture.lane_origins[0].loader) |*value| try std.testing.expectEqual(@as(usize, 0), value.loaded.count());
            saw_core_failure = true;
            try std.testing.expect(!watch.post_append_failure);
            continue;
        };
        try std.testing.expectEqual(@as(u64, 1), loaded);
        try std.testing.expectEqual(@as(usize, 1), fixture.lane.active.items.len);
        try std.testing.expectEqual(canonical.encodedLen() + @sizeOf(Item), fixture.lane.active_bytes);
        try std.testing.expectEqual(fixture.lane.active_bytes + fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
        if (watch.post_append_failure) {
            saw_post_append_failure = true;
            try std.testing.expect(fixture.lane.telemetry_failures.load(.monotonic) > 0);
        }
    }
    try std.testing.expect(saw_post_append_failure);
    try std.testing.expect(saw_core_failure);
}

test "Root registry pressure preserves durable retirement and never re-admits a completed actor" {
    const a = std.testing.allocator;
    for (0..3) |pressure| {
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        const parent = try temp.dir.realpathAlloc(a, ".");
        defer a.free(parent);
        const path = try std.fs.path.join(a, &.{ parent, "rocks" });
        defer a.free(path);
        var watch: WatchAllocator = .{ .backing = a };
        const fixture = try Fixture.init(a, path, 2, 1024 * 1024);
        defer fixture.deinit(a);
        try fixture.enableMetrics(watch.allocator());
        const canonical = message(0, "canonical");
        try fixture.origin.store.upsertMessage(canonical, 1, null);
        try std.testing.expectEqual(@as(u64, 1), try fixture.lane.load(.{ .unix_ms = 1001, .monotonic_ms = 2 }));
        const item = fixture.lane.active.items[0];
        const adapter = fixture.lane_origins[0].metrics.?;
        _ = try adapter.recordMetadataWait(.{ .message_id = canonical.id(), .app_context = null, .unix_timestamp_seconds = 1, .monotonic_ms = 2 });
        try std.testing.expectEqual(@as(usize, 1), fixture.owner.metric_tracker.?.activeCount());
        const registry = fixture.metric_registry.?;
        switch (pressure) {
            0 => registry.options.max_series = 1,
            1 => registry.options.max_storage_bytes = 1,
            else => watch.fail_index = watch.alloc_index,
        }
        // A fresh operation series proves actual bounded-registry rejection.
        if (pressure < 2) try std.testing.expectError(if (pressure == 0) error.MetricSeriesLimit else error.MetricStorageLimit, adapter.recordOperation(.submitted, null));
        try fixture.origin.store.markTerminal(canonical.id());
        try std.testing.expect(try fixture.lane.advance(item, .{ .unix_ms = 1002, .monotonic_ms = 3 }, &fixture.cancel));
        try fixture.lane.releaseCompleted(0);
        try std.testing.expect(fixture.lane.telemetry_failures.load(.monotonic) > 0);
        try std.testing.expectEqual(@as(usize, 0), fixture.lane.active.items.len);
        try std.testing.expectEqual(@as(usize, 0), fixture.lane.active_bytes);
        try std.testing.expectEqual(fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
        try std.testing.expectEqual(@as(usize, 0), fixture.owner.metric_tracker.?.activeCount());
        try std.testing.expectEqual(@as(usize, 0), fixture.owner.metric_tracker.?.retainedBytes());
        try std.testing.expectEqual(@as(usize, 0), fixture.lane_origins[0].loader.?.loaded.count());
        // No driver is installed: any accidental retry/broadcast would fail.
        fixture.lane_origins[0].loader.?.rescan();
        try std.testing.expectEqual(@as(u64, 0), try fixture.lane.load(.{ .unix_ms = 1003, .monotonic_ms = 4 }));
        try std.testing.expect(try fixture.origin.store.operationComplete(canonical));
    }
}

test "Root optional app labels cannot consume the core admission budget" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    const canonical = message(0, "canonical");
    const base = canonical.encodedLen() + @sizeOf(Item);
    const fixture = try Fixture.init(a, path, 2, base);
    defer fixture.deinit(a);
    try enableAppContext(fixture);
    try fixture.origin.store.upsertMessage(canonical, 1, null);
    try std.testing.expectEqual(@as(u64, 1), try fixture.lane.load(.{ .unix_ms = 1001, .monotonic_ms = 2 }));
    const item = fixture.lane.active.items[0];
    try std.testing.expect(item.metric_app_context == null);
    try std.testing.expect(!item.metric_active);
    try std.testing.expectEqual(base + fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
    try fixture.origin.store.markTerminal(canonical.id());
    try std.testing.expect(try fixture.lane.advance(item, .{ .unix_ms = 1002, .monotonic_ms = 3 }, &fixture.cancel));
    try fixture.lane.releaseCompleted(0);
    try std.testing.expectEqual(fixture.lane.control.snapshot.retainedBytes(), fixture.owner.retained_bytes);
}

const QueueDestination = struct {
    readers: @import("agents/chain_source.zig").Resources,
    factory: @import("agents/destination/root.zig").Factory,
    fn init(self: *@This(), fixture: *Fixture, vm: @import("settings/types.zig").Protocol, limit: ?u32) void {
        fixture.chains[1].protocol = vm;
        fixture.chains[1].chain_id = "fixture-queue";
        fixture.chains[1].contracts = .{ .mailbox = @splat(2), .merkle_tree_hook = @splat(3), .interchain_gas_paymaster = @splat(0), .validator_announce = @splat(4) };
        fixture.chains[1].max_submit_queue_length = limit;
        fixture.configured.role.relayer.max_message_retries = 20;
        self.readers = undefined;
        self.readers.chain = fixture.chains[1];
        self.factory = .{ .allocator = fixture.owner.allocator, .arena = .init(fixture.owner.allocator), .resources = &self.readers, .options = .{ .origin_bindings = &.{.{ .domain = 1, .hook = @splat(3) }} }, .backend_ready = true, .chain_checked = true };
        // Public initialized identities only. Held preparation must never touch
        // the deliberately absent RPC/SDK clients in these actual typed backends.
        switch (vm) {
            .sealevel => {
                self.factory.backend = .{ .sealevel = undefined };
                self.factory.backend.sealevel.signer.payer = @splat(1);
                self.factory.backend.sealevel.identity = null;
                self.factory.backend.sealevel.announce = @splat(4);
            },
            .cosmos => {
                self.factory.backend = .{ .cosmos = undefined };
                self.factory.backend.cosmos.native = false;
                self.factory.backend.cosmos.announce = @splat(4);
                self.factory.backend.cosmos.signer.public_key = @splat(1);
                self.factory.backend.cosmos.transactions.signer_address = "cosmos1publicfixture";
            },
            .starknet => {
                self.factory.backend = .{ .starknet = undefined };
                self.factory.backend.starknet.account = @import("starknet/codec.zig").Felt.init(1) catch unreachable;
                self.factory.backend.starknet.signer.public_key = @import("starknet/codec.zig").Felt.init(2) catch unreachable;
                self.factory.backend.starknet.announce = @import("starknet/codec.zig").Felt.init(4) catch unreachable;
            },
            else => unreachable,
        }
        fixture.lane.native_destination = &self.factory;
    }
    fn actor(self: *@This(), fixture: *Fixture, value: protocol.Message) !*@import("agents/destination/operation.zig").Operation {
        return @import("agents/destination/operation.zig").Operation.open(fixture.owner.allocator, &fixture.origin.store, .{ .id = value.id(), .context = try self.factory.contextFor(try self.factory.authorityFor(value.origin, value.id(), 1, .process)), .nonce = value.nonce, .origin = value.origin, .destination = value.destination, .policy = .{ .max_retries = 20 } }, .{ .unix_ms = 1000, .monotonic_ms = 0 });
    }
    fn ready(self: *@This(), fixture: *Fixture, value: protocol.Message) !void {
        const op = try self.actor(fixture, value);
        defer op.deinit();
        _ = try op.tick(.{ .unix_ms = 1000, .monotonic_ms = 0 });
        var prepared = try @import("agents/destination/types.zig").Prepared.init(fixture.owner.allocator, try self.factory.authorityFor(value.origin, value.id(), op.value.generation, .process), "{}", null, null);
        defer prepared.deinit();
        try op.staged(&prepared, .{ .unix_ms = 1000, .monotonic_ms = 0 });
        try op.prepared(&prepared, true, true, .{ .unix_ms = 1000, .monotonic_ms = 0 });
    }
};
fn queueFixture(a: A, path: []const u8) !*Fixture {
    return Fixture.init(a, path, 8, 1024 * 1024);
}

test "Root native submit zero holds fresh supported protocols without prepare signing retries or public admission loss" {
    const a = std.testing.allocator;
    for ([_]@import("settings/types.zig").Protocol{ .cosmos, .sealevel, .starknet }) |vm| {
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        const parent = try temp.dir.realpathAlloc(a, ".");
        defer a.free(parent);
        const path = try std.fs.path.join(a, &.{ parent, "rocks" });
        defer a.free(path);
        const fixture = try queueFixture(a, path);
        defer fixture.deinit(a);
        var native_destination: QueueDestination = undefined;
        native_destination.init(fixture, vm, 0);
        defer native_destination.factory.arena.deinit();
        const value = message(0, "fresh");
        try fixture.origin.store.upsertMessage(value, 1, null);
        try std.testing.expectEqual(@as(u64, 1), try fixture.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 }));
        const item = fixture.lane.active.items[0];
        item.metric_active = false; // Business backpressure is not telemetry.
        const before = try fixture.origin.store.status(value.id());
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
        try std.testing.expectEqual(@as(u64, 150), item.next_ms);
        try std.testing.expectEqual(@as(u32, 0), try fixture.origin.store.retryCount(value.id()));
        try std.testing.expect(std.meta.eql(before, try fixture.origin.store.status(value.id())));
        const retained = fixture.owner.retained_bytes;
        const public = message(10, "receipt");
        try fixture.command(.reserve, public);
        try fixture.command(.authorize, public);
        try fixture.command(.commit, public);
        try std.testing.expectEqual(@as(usize, 2), fixture.lane.active.items.len);
        try std.testing.expect(fixture.owner.retained_bytes > retained);
        try std.testing.expect(try fixture.origin.store.operationMessageAuthorized(public));
        fixture.cancel.store(true, .release);
        try std.testing.expectError(error.RequestCancelled, fixture.lane.advance(item, .{ .unix_ms = 1150, .monotonic_ms = 150 }, &fixture.cancel));
    }
}

test "Root native submit cap hydrates restored ready state and control retry releases queue independently of metrics" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    const fixture = try queueFixture(a, path);
    defer fixture.deinit(a);
    var native_destination: QueueDestination = undefined;
    native_destination.init(fixture, .sealevel, 1);
    defer native_destination.factory.arena.deinit();
    const queued = message(0, "restored-ready");
    const fresh = message(1, "fresh");
    try fixture.origin.store.upsertMessage(queued, 1, null);
    try fixture.origin.store.upsertMessage(fresh, 1, null);
    try native_destination.ready(fixture, queued);
    while (try fixture.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 }) != 0) {}
    for (fixture.lane.active.items) |item| item.metric_active = false;
    try std.testing.expect(!try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    var ready_item: ?*Item = null;
    var fresh_item: ?*Item = null;
    for (fixture.lane.active.items) |item| {
        if (std.mem.eql(u8, &item.message.value.id(), &queued.id())) ready_item = item else fresh_item = item;
    }
    try std.testing.expect(ready_item.?.native_submit_queued.?);
    try std.testing.expect(!try fixture.lane.advance(fresh_item.?, .{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    try std.testing.expectEqual(@as(u32, 0), try fixture.origin.store.retryCount(fresh.id()));
    try fixture.command(.reprocess, queued);
    try std.testing.expect(ready_item.?.native_submit_queued == null);
    try std.testing.expect(try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1001, .monotonic_ms = 1 }, &fixture.cancel));
    try std.testing.expect(!ready_item.?.native_submit_queued.?);
    const restored = try native_destination.actor(fixture, queued);
    defer restored.deinit();
    try std.testing.expect(restored.intent == null and restored.signed == null and restored.value.retries == 0);
}

test "Root native submit batch threshold permits overshoot and excludes popped signed or confirmation actors" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    const fixture = try queueFixture(a, path);
    defer fixture.deinit(a);
    var native_destination: QueueDestination = undefined;
    native_destination.init(fixture, .sealevel, 1);
    defer native_destination.factory.arena.deinit();
    const first = message(0, "batch-first");
    const second = message(1, "batch-second");
    for ([_]protocol.Message{ first, second }) |value| try fixture.origin.store.upsertMessage(value, 1, null);
    while (try fixture.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 }) != 0) {}
    try fixture.lane.beginNativePreparationBatch(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel, 2);
    try std.testing.expect(fixture.lane.native_batch_admission.?);
    for (fixture.lane.active.items) |item| try std.testing.expect(item.native_prepare_admitted);
    for ([_]protocol.Message{ first, second }) |value| try native_destination.ready(fixture, value);
    for (fixture.lane.active.items) |item| item.native_submit_queued = null; // Reopen actual persisted state.
    try std.testing.expect(!try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    try std.testing.expect(fixture.lane.native_batch_admission.?); // Admitted batch is not a per-message reservation.
    fixture.lane.native_batch_admission = null;
    for ([_]protocol.Message{ first, second }, 0..) |value, index| {
        const op = try native_destination.actor(fixture, value);
        defer op.deinit();
        if (index == 0) {
            const persistence = op.persistence(.{ .unix_ms = 1000, .monotonic_ms = 0 });
            try persistence.persistSigned(persistence.context, value.id(), .{ .signature512 = @splat(7) }, "public signed fixture");
        } else try op.beginConfirmation(.{ .unix_ms = 1000, .monotonic_ms = 0 });
    }
    for (fixture.lane.active.items) |item| item.native_submit_queued = null;
    try std.testing.expect(try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    for (fixture.lane.active.items) |item| try std.testing.expect(!item.native_submit_queued.?);
}

const PendingSvmRead = struct {
    calls: usize = 0,
    fn fetch(context: *anyopaque, _: A, _: []const u8, _: @import("evm/provider.zig").Options) !@import("evm/provider.zig").WireResponse {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.calls += 1;
        return error.PendingReadIo;
    }
};

fn pendingQueueExercise(ready_first: bool) !void {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    const fixture = try queueFixture(a, path);
    defer fixture.deinit(a);
    var native_destination: QueueDestination = undefined;
    native_destination.init(fixture, .sealevel, 1);
    defer native_destination.factory.arena.deinit();
    var exchange: PendingSvmRead = .{};
    var client: @import("sealevel/provider.zig").Client = .{ .rpc_client = try @import("evm/provider.zig").RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &exchange, .fetch_fn = PendingSvmRead.fetch } }) };
    defer client.rpc_client.deinit();
    native_destination.readers = .{ .allocator = a, .environment = &fixture.environment, .arena = .init(a), .chain = fixture.chains[1], .options = .{ .curl_library = "unused" }, .clients = .{ .sealevel = &client }, .http = @import("cloud/http.zig").HttpTransport.init(a) };
    defer native_destination.readers.arena.deinit();
    defer native_destination.readers.http.deinit();
    native_destination.factory.options.allow_fixture_transport = true;
    native_destination.factory.backend.sealevel.chain = .{ .client = &client, .program = fixture.chains[1].contracts.mailbox, .domain = 2, .payer = @splat(1) };
    const first = message(0, "first");
    const second = message(1, "second");
    for ([_]protocol.Message{ first, second }) |value| try fixture.origin.store.upsertMessage(value, 1, null);
    while (try fixture.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 }) != 0) {}
    if (ready_first) try native_destination.ready(fixture, fixture.lane.active.items[fixture.lane.next_active].message.value);
    try fixture.lane.beginNativePreparationBatch(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel, 1);
    const admitted = fixture.lane.active.items[fixture.lane.next_active];
    const waiting = fixture.lane.active.items[(fixture.lane.next_active + 1) % 2];
    try std.testing.expectEqual(!ready_first, admitted.native_prepare_admitted);
    try std.testing.expect(!waiting.native_prepare_admitted);
    try std.testing.expectError(error.PendingReadIo, fixture.lane.advance(admitted, .{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    try std.testing.expectEqual(!ready_first, admitted.native_prepare_admitted);
    try std.testing.expectEqual(ready_first, admitted.native_submit_inflight);
    try std.testing.expectEqual(@as(usize, 1), exchange.calls);
    fixture.lane.native_batch_admission = null; // A yielded owner callback resumes later.
    try fixture.lane.beginNativePreparationBatch(.{ .unix_ms = 1001, .monotonic_ms = 1 }, &fixture.cancel, 2);
    try std.testing.expectEqual(ready_first, fixture.lane.native_batch_admission.?);
    try std.testing.expectEqual(ready_first, waiting.native_prepare_admitted);
    if (!ready_first) {
        try std.testing.expect(!try fixture.lane.advance(waiting, .{ .unix_ms = 1001, .monotonic_ms = 1 }, &fixture.cancel));
        try std.testing.expectEqual(@as(u64, 151), waiting.next_ms);
    }
    try std.testing.expectEqual(@as(usize, 1), exchange.calls);
    try fixture.command(.reprocess, admitted.message.value);
    if (ready_first) try fixture.command(.reprocess, waiting.message.value);
    try std.testing.expect(!admitted.native_submit_inflight);
    try std.testing.expect(!admitted.native_prepare_admitted);
    fixture.lane.native_batch_admission = null;
    try fixture.lane.beginNativePreparationBatch(.{ .unix_ms = 1151, .monotonic_ms = 151 }, &fixture.cancel, 2);
    for (fixture.lane.active.items) |item| try std.testing.expect(item.native_prepare_admitted);
}

test "Root native submit admitted preparation batch survives pending IO without admitting another batch" {
    try pendingQueueExercise(false);
}

test "Root native submit popped ready IO is excluded from backpressure and control restores admission" {
    try pendingQueueExercise(true);
}

const ViewBatchCaller = struct {
    fixture: *Fixture,
    command: enum { reserve, commit, abort },
    messages: [2]protocol.Message,
    allocation_failure_offset: usize = 0,
    failure: ?anyerror = null,
    fn run(self: *@This()) void {
        self.call() catch |err| {
            self.failure = err;
        };
    }
    fn call(self: *@This()) !void {
        const f = self.fixture;
        switch (self.command) {
            .reserve => try f.hub.relayReserve(f.lane.control, 1, .{3} ** 64, &self.messages, 3000, &f.cancel),
            .commit => try f.hub.relayCommit(f.lane.control, 1, 3000, &f.cancel),
            .abort => try f.hub.relayAbort(f.lane.control, 1, 3000, &f.cancel),
        }
    }
    fn execute(self: *@This(), fail_next_after_queue: ?*WatchAllocator) !void {
        const thread = try std.Thread.spawn(.{}, run, .{self});
        var joined = false;
        defer if (!joined) {
            self.fixture.cancel.store(true, .release);
            thread.join();
        };
        var timer = try std.time.Timer.start();
        while (!self.fixture.lane.control.wake.load(.acquire)) {
            if (timer.read() > 2 * std.time.ns_per_s) return error.ViewBatchCommandDidNotQueue;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        // All queue/clone allocations happened before the owner is released.
        if (fail_next_after_queue) |watch| watch.fail_index = watch.alloc_index + self.allocation_failure_offset;
        _ = try self.fixture.lane.control.drain(&self.fixture.lane, .{ .unix_ms = 1000, .monotonic_ms = 1 }, &self.fixture.cancel);
        thread.join();
        joined = true;
        if (self.failure) |err| return err;
    }
};

test "admin public authorized batch commits owned view rows without any later allocation" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    var watch: WatchAllocator = .{ .backing = a };
    const allocator = watch.allocator();
    const f = try Fixture.init(allocator, path, 2, 1024 * 1024);
    defer f.deinit(allocator);
    const values = [2]protocol.Message{ message(10, "first"), message(11, "second") };
    var reserve: ViewBatchCaller = .{ .fixture = f, .command = .reserve, .messages = values };
    try reserve.execute(null);
    try std.testing.expectEqual(@as(usize, 2), f.lane.control.reservedSlots());
    try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
    const prepared = &f.lane.control.relay_reservation.?;
    try std.testing.expectEqual(@as(usize, 2), prepared.snapshot_rows.count);
    for (prepared.snapshot_rows.items(), values) |row, value| try std.testing.expectEqual(value.id(), row.message.value.id());
    try f.command(.authorize, values[0]);
    for (values) |value| try std.testing.expect(try f.origin.store.operationMessageAuthorized(value));
    var previous = try f.lane.control.snapshot.capture(&f.cancel);
    defer previous.deinit();
    const generation = previous.generation;
    try std.testing.expectEqual(@as(usize, 0), previous.count);
    var commit: ViewBatchCaller = .{ .fixture = f, .command = .commit, .messages = values };
    try commit.execute(&watch);
    // The armed failure is still unconsumed: commit and publication allocate 0.
    try std.testing.expectEqual(watch.alloc_index, watch.fail_index);
    watch.fail_index = std.math.maxInt(usize);
    try std.testing.expect(f.lane.control.relay_reservation == null);
    try std.testing.expectEqual(@as(usize, 2), f.lane.active.items.len);
    try std.testing.expect(!f.lane.control.snapshot.current(generation));
    var current = try f.lane.control.snapshot.capture(&f.cancel);
    defer current.deinit();
    try std.testing.expectEqual(@as(usize, 2), current.count);
    for (current.items(), f.lane.active.items, values) |row, active, value| {
        try std.testing.expectEqual(value.id(), row.message.value.id());
        try std.testing.expectEqual(value.id(), active.message.value.id());
    }
    try std.testing.expectEqual(f.lane.active_bytes + f.lane.control.snapshot.retainedBytes(), f.owner.retained_bytes);
}

test "admin public reservation abort releases prepared rows and leaves current view untouched" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "rocks" });
    defer a.free(path);
    const f = try Fixture.init(a, path, 2, 1024 * 1024);
    defer f.deinit(a);
    const values = [2]protocol.Message{ message(10, "first"), message(11, "second") };
    var reserve: ViewBatchCaller = .{ .fixture = f, .command = .reserve, .messages = values };
    try reserve.execute(null);
    const charged = f.lane.control.snapshot.retainedBytes();
    try std.testing.expect(charged > 2 * @sizeOf(*@import("agents/relayer/queue_view.zig").Row));
    var copy = try f.lane.control.snapshot.capture(&f.cancel);
    defer copy.deinit();
    const generation = copy.generation;
    var abort: ViewBatchCaller = .{ .fixture = f, .command = .abort, .messages = values };
    try abort.execute(null);
    try std.testing.expect(f.lane.control.snapshot.current(generation));
    try std.testing.expect(f.lane.control.relay_reservation == null);
    try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
    try std.testing.expectEqual(2 * @sizeOf(*@import("agents/relayer/queue_view.zig").Row), f.lane.control.snapshot.retainedBytes());
    try std.testing.expectEqual(f.lane.control.snapshot.retainedBytes(), f.owner.retained_bytes);
}

test "admin public reservation allocation failures never partially publish or authorize" {
    const a = std.testing.allocator;
    var observed_failure = false;
    var observed_success = false;
    for (0..24) |offset| {
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        const parent = try temp.dir.realpathAlloc(a, ".");
        defer a.free(parent);
        const path = try std.fs.path.join(a, &.{ parent, "rocks" });
        defer a.free(path);
        var watch: WatchAllocator = .{ .backing = a };
        const allocator = watch.allocator();
        const f = try Fixture.init(allocator, path, 2, 1024 * 1024);
        defer f.deinit(allocator);
        // Finish initial policy publication before injecting into reserve only.
        _ = try f.lane.control.drain(&f.lane, .{ .unix_ms = 1000, .monotonic_ms = 1 }, &f.cancel);
        const values = [2]protocol.Message{ message(10, "first"), message(11, "second") };
        var reserve: ViewBatchCaller = .{ .fixture = f, .command = .reserve, .messages = values, .allocation_failure_offset = offset };
        reserve.execute(&watch) catch |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            observed_failure = true;
            try std.testing.expect(f.lane.control.relay_reservation == null);
            try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
            try std.testing.expectEqual(@as(usize, 0), f.lane.control.snapshot.rows.items.len);
            try std.testing.expectEqual(f.lane.control.snapshot.retainedBytes(), f.owner.retained_bytes);
            for (values) |value| try std.testing.expect(!try f.origin.store.operationMessageAuthorized(value));
            continue;
        };
        watch.fail_index = std.math.maxInt(usize);
        observed_success = true;
        try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
        try std.testing.expectEqual(@as(usize, 0), f.lane.control.snapshot.rows.items.len);
        try std.testing.expectEqual(@as(usize, 2), f.lane.control.relay_reservation.?.snapshot_rows.count);
        for (values) |value| try std.testing.expect(!try f.origin.store.operationMessageAuthorized(value));
        var abort: ViewBatchCaller = .{ .fixture = f, .command = .abort, .messages = values };
        try abort.execute(null);
        try std.testing.expectEqual(f.lane.control.snapshot.retainedBytes(), f.owner.retained_bytes);
    }
    try std.testing.expect(observed_failure and observed_success);
}
