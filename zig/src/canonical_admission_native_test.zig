//! Canonical admission runs before pending actors or destination delivery reads.
const std = @import("std");
const fixture = @import("starknet_group_native_test.zig");
const policy = @import("agents/relay_policy.zig");
const protocol = @import("protocol/root.zig");
const a = std.testing.allocator;
const now = @import("agents/operation.zig").Times{ .unix_ms = 1000, .monotonic_ms = 0 };
const RpcSpy = struct {
    upstream: @import("cloud/http.zig").Transport,
    calls: usize = 0,
    fail_once: ?anyerror = null,
    hook_context: ?*anyopaque = null,
    hook_fn: ?*const fn (*anyopaque, @import("cloud/http.zig").Request) anyerror!void = null,
    fn send(ctx: *anyopaque, allocator: std.mem.Allocator, request: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (self.fail_once) |failure| {
            self.fail_once = null;
            return failure;
        }
        var response = try self.upstream.send_fn(self.upstream.context, allocator, request);
        errdefer response.deinit();
        if (self.hook_fn) |hook| try hook(self.hook_context.?, request);
        return response;
    }
};

fn replacePolicy(f: *fixture.Fixture, config: policy.Config) !void {
    var replacement = try policy.Policy.init(a, config, null, &f.owner.denylist);
    errdefer replacement.deinit();
    f.owner.control_hub.gateway_policy.deinit();
    f.owner.control_hub.gateway_policy = replacement;
}

fn loadMany(f: *fixture.Fixture) !void {
    for (0..16) |_| _ = try f.lane.load(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms });
}
fn useEvm(f: *fixture.Fixture) void {
    f.chains[2].protocol = .ethereum;
    f.lane.context = @splat(88);
    for (f.chains[0..2]) |*chain| chain.contracts = .{ .mailbox = @splat(0), .merkle_tree_hook = @splat(9), .interchain_gas_paymaster = @splat(0), .validator_announce = @splat(0) };
}
fn runtimeDocument(f: *fixture.Fixture, bytes: []const u8) !void {
    const runtime = @import("ops/runtime_denylist.zig");
    const Document = struct {
        bytes: []const u8,
        fn fetch(ctx: *anyopaque, allocator: std.mem.Allocator, _: []const u8, _: usize) !runtime.Fetched {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, self.bytes) };
        }
        fn time(_: *anyopaque) i64 {
            return 1000;
        }
    };
    const memory = f.readers.arena.allocator();
    const document = try memory.create(Document);
    document.* = .{ .bytes = try memory.dupe(u8, bytes) };
    f.owner.denylist.config = .{ .url = "https://fixture/rules", .poll_interval_ms = 1000, .cache_path = try std.fs.path.join(memory, &.{ f.path, "pop-rules.json" }) };
    f.owner.denylist.transport = .{ .context = document, .fetch = Document.fetch };
    _ = try f.owner.denylist.refresh(.{ .context = document, .now_unix = Document.time });
}
fn denyMessage(f: *fixture.Fixture, message: protocol.Message) !void {
    const memory = f.readers.arena.allocator();
    const id = try @import("evm/codecs.zig").hexAlloc(memory, &message.id());
    try runtimeDocument(f, try std.json.Stringify.valueAlloc(memory, .{ .rules = .{.{ .reason = "pop fixture", .addedBy = "fixture", .match = .{ .messageId = .{id} } }} }, .{}));
}
fn freshOnly(f: *fixture.Fixture) !protocol.Message {
    f.clearActive();
    for (&f.sources, f.messages) |*source, message| _ = try source.store.markProcessedIfCanonical(message);
    const message: protocol.Message = .{ .nonce = 20, .origin = 100, .destination = 200, .body = "fresh pending pop" };
    _ = try f.sources[0].store.storeMessage(message, 2, null);
    f.owner.options.max_active = 1;
    return message;
}
fn manualReset(f: *fixture.Fixture, message: protocol.Message, reprocess: bool) !void {
    const Request = struct {
        f: *fixture.Fixture,
        message: protocol.Message,
        reprocess: bool,
        cancel: std.atomic.Value(bool) = .init(false),
        response: ?[]u8 = null,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            if (self.reprocess) {
                const owner = self.f.owner.control_hub.reprocessOwner();
                self.response = owner.enqueue_fn(owner.context, a, self.message, &self.cancel) catch |err| {
                    self.failure = err;
                    return;
                };
            } else {
                const owner = self.f.owner.control_hub.retryOwner();
                const result = owner.retry_fn(owner.context, a, "pop-reset", &.{.{ .message_id = .{ .values = &.{self.message.id()} } }}, &self.cancel) catch |err| {
                    self.failure = err;
                    return;
                };
                if (result.matched != 1 or result.failed != 0) self.failure = error.ManualResetDidNotMatch;
            }
        }
    };
    var request: Request = .{ .f = f, .message = message, .reprocess = reprocess };
    f.lane.control.queue.wake.store(false, .release);
    const thread = try std.Thread.spawn(.{}, Request.run, .{&request});
    var joined = false;
    defer {
        request.cancel.store(true, .release);
        if (!joined) thread.join();
        if (request.response) |bytes| a.free(bytes);
    }
    var polls: usize = 0;
    while (!f.lane.control.wake.load(.acquire) and polls < 2000) : (polls += 1) std.Thread.sleep(std.time.ns_per_ms);
    if (!f.lane.control.wake.load(.acquire)) return error.ManualResetNotQueued;
    _ = try f.lane.control.drain(&f.lane, .{ .unix_ms = 1001, .monotonic_ms = 1 }, &f.cancel);
    thread.join();
    joined = true;
    if (request.failure) |failure| return failure;
}

test "canonical admission rejects excluded history before creating a pending actor" {
    const f = try fixture.Fixture.init(a, .{ 1, 3 }, 1);
    defer f.deinit();
    f.clearActive();
    const fresh: protocol.Message = .{ .nonce = 20, .origin = 100, .destination = 200, .body = "unlisted canonical history" };
    _ = try f.sources[0].store.storeMessage(fresh, 2, null);
    try std.testing.expectEqual(@as(?@import("db/json.zig").Status, null), try f.sources[0].store.status(fresh.id()));
    try replacePolicy(f, .{ .whitelist = &.{.{ .message_id = .{ .values = &.{@as([32]u8, @splat(99))} } }} });
    f.network.delivered = true;
    var rpc: RpcSpy = .{ .upstream = f.client.client.transport };
    f.client.client.transport = .{ .context = &rpc, .send_fn = RpcSpy.send };
    const signatures = f.signer.count;
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
    try std.testing.expectEqual(@as(usize, 0), rpc.calls);
    try std.testing.expectEqual(signatures, f.signer.count);
    try std.testing.expectEqual(@as(?@import("db/json.zig").Status, null), try f.sources[0].store.status(fresh.id()));
    var stored = (try f.sources[0].store.messageById(fresh.id())).?;
    defer stored.deinit();
    try std.testing.expectEqualSlices(u8, fresh.body, stored.value.body);
    try std.testing.expect(!try f.sources[0].store.processed(fresh.nonce));
}

test "canonical admission lists preserve manual rows and allow neighbors and rule removal rescan for EVM and native" {
    const json = @import("db/json.zig");
    const metrics = @import("ops/metrics.zig");
    const relayer_metrics = @import("ops/relayer_metrics.zig");
    for ([_]bool{ false, true }) |evm| for (0..3) |mode| {
        errdefer std.debug.print("canonical admission variant evm={any} filter={d}\n", .{ evm, mode });
        const f = try fixture.Fixture.init(a, .{ 1, 3 }, 1);
        defer f.deinit();
        f.clearActive();
        if (evm) useEvm(f);
        const denied: protocol.Message = .{ .nonce = 20, .origin = 100, .destination = 200, .sender = @splat(42), .body = "denied history" };
        const allowed: protocol.Message = .{ .nonce = 21, .origin = 100, .destination = 200, .sender = @splat(43), .body = "allowed neighbor" };
        _ = try f.sources[0].store.storeMessage(denied, 2, null);
        _ = try f.sources[0].store.storeMessage(allowed, 3, null);
        const manual = try (json.Status{ .Retry = .Manual }).toJson(a);
        defer a.free(manual);
        try f.sources[0].store.typed.put(a, @import("db/root.zig").keys.Table.status_by_message_id.prefix(), &denied.id(), manual);
        try replacePolicy(f, switch (mode) {
            0 => .{ .whitelist = &.{.{ .message_id = .{ .values = &.{allowed.id()} } }} },
            1 => .{ .blacklist = &.{.{ .message_id = .{ .values = &.{denied.id()} } }} },
            else => .{ .address_blacklist = &.{&denied.sender} },
        });
        const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "canonical-admission-fixture" });
        defer registry.deinit();
        const tracker = try relayer_metrics.WaitTracker.init(a, registry, .{ .max_active = 16, .max_bytes = 1024 * 1024 });
        defer tracker.deinit();
        f.owner.metric_tracker = tracker;
        const adapter = try relayer_metrics.Adapter.init(a, tracker, f.chains[0].name, f.chains[2].name);
        defer {
            f.lane_origins[0].metrics = null;
            f.owner.metric_tracker = null;
            adapter.deinit();
        }
        f.lane_origins[0].metrics = adapter;
        var rpc: RpcSpy = .{ .upstream = f.client.client.transport };
        f.client.client.transport = .{ .context = &rpc, .send_fn = RpcSpy.send };
        try loadMany(f);
        var found_allowed = false;
        for (f.lane.active.items) |item| {
            try std.testing.expect(!std.mem.eql(u8, &item.message.value.id(), &denied.id()));
            if (std.mem.eql(u8, &item.message.value.id(), &allowed.id())) found_allowed = true;
        }
        try std.testing.expect(found_allowed);
        try std.testing.expectEqual(@as(usize, 0), rpc.calls);
        try std.testing.expect(!try f.sources[0].store.processed(denied.nonce));
        try std.testing.expectEqual(json.Status{ .Retry = .Manual }, (try f.sources[0].store.status(denied.id())).?);
        const body = try registry.render(a);
        defer a.free(body);
        try std.testing.expect(std.mem.indexOf(u8, body, "phase=\"confirmed\"") == null);
        try std.testing.expect(std.mem.indexOf(u8, body, "hyperlane_messages_processed_count{") == null);
        // No permanent rejection marker: current rule removal plus the normal
        // canonical rescan admits the same stored ID without rewriting it.
        try replacePolicy(f, .{});
        for (&f.lane_origins) |*origin| if (origin.loader) |*loader| loader.rescan();
        try loadMany(f);
        var reallowed = false;
        for (f.lane.active.items) |item| if (std.mem.eql(u8, &item.message.value.id(), &denied.id())) {
            reallowed = true;
        };
        try std.testing.expect(reallowed);
        try std.testing.expectEqual(@as(usize, 0), rpc.calls);
    };
}

test "canonical admission applies runtime messages and cached signers without an origin lookup" {
    const runtime = @import("ops/runtime_denylist.zig");
    const tasks = @import("agents/origin_signer_tasks.zig");
    const abi = @import("evm/codecs.zig");
    const Document = struct {
        bytes: []const u8,
        fn fetch(ctx: *anyopaque, allocator: std.mem.Allocator, _: []const u8, _: usize) !runtime.Fetched {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, self.bytes) };
        }
        fn time(_: *anyopaque) i64 {
            return 1000;
        }
    };
    const Lookup = struct {
        calls: usize = 0,
        fn fetch(ctx: *anyopaque, allocator: std.mem.Allocator, _: protocol.Message, _: u64, _: ?*const std.atomic.Value(bool)) ![][32]u8 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return allocator.dupe([32]u8, &.{@as([32]u8, @splat(45))});
        }
    };
    for ([_]bool{ false, true }) |cached_signer| {
        const f = try fixture.Fixture.init(a, .{ 1, 3 }, 1);
        defer f.deinit();
        f.clearActive();
        const denied: protocol.Message = .{ .nonce = 20, .origin = 100, .destination = 200, .sender = @splat(42), .body = "runtime denied" };
        const neighbor: protocol.Message = .{ .nonce = 21, .origin = 100, .destination = 200, .sender = @splat(43), .body = "cold allowed neighbor" };
        _ = try f.sources[0].store.storeMessage(denied, 2, null);
        _ = try f.sources[0].store.storeMessage(neighbor, 3, null);
        const memory = f.readers.arena.allocator();
        const address = try abi.hexAlloc(memory, &@as([32]u8, @splat(45)));
        const id = try abi.hexAlloc(memory, &denied.id());
        var document: Document = .{ .bytes = if (cached_signer)
            try std.json.Stringify.valueAlloc(memory, .{ .rules = .{.{ .reason = "fixture cached signer", .addedBy = "fixture", .address = address }} }, .{})
        else
            try std.json.Stringify.valueAlloc(memory, .{ .rules = .{.{ .reason = "fixture message", .addedBy = "fixture", .match = .{ .messageId = .{id} } }} }, .{}) };
        f.owner.denylist.config = .{ .url = "https://fixture/rules", .poll_interval_ms = 1000, .cache_path = try std.fs.path.join(memory, &.{ f.path, "admission-rules.json" }) };
        f.owner.denylist.transport = .{ .context = &document, .fetch = Document.fetch };
        _ = try f.owner.denylist.refresh(.{ .context = &document, .now_unix = Document.time });
        const signers = try tasks.Owner.open(a, &f.origin_set, &f.environment, .{ .curl_library = "unused" });
        defer signers.deinit();
        f.owner.signers = signers;
        var lookup: Lookup = .{};
        if (cached_signer) {
            var snapshot = (try signers.cache.lookup(a, denied, true, true, .{ .context = &lookup, .fetch_fn = Lookup.fetch }, std.math.maxInt(u64), null)).?;
            snapshot.deinit();
        }
        try loadMany(f);
        var allowed = false;
        for (f.lane.active.items) |item| {
            try std.testing.expect(!std.mem.eql(u8, &denied.id(), &item.message.value.id()));
            if (std.mem.eql(u8, &neighbor.id(), &item.message.value.id())) allowed = true;
        }
        try std.testing.expect(allowed);
        try std.testing.expectEqual(@as(usize, if (cached_signer) 1 else 0), lookup.calls);
        try std.testing.expect(!try f.sources[0].store.processed(denied.nonce));
        try std.testing.expect((try f.sources[0].store.status(denied.id())) == null);
    }
}

test "canonical admission recovery cannot enqueue a reveal or acknowledge canonical history" {
    const db = @import("db/root.zig");
    const store_module = @import("agents/store.zig");
    const actor_module = @import("agents/destination/operation.zig");
    const driver = @import("agents/relayer/native_driver.zig");
    const Spy = struct {
        calls: usize = 0,
        pub fn onDelivered(self: *@This(), _: *store_module.Store, _: protocol.Message, _: @import("agents/destination/root.zig").Clock) !void {
            self.calls += 1;
        }
    };
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = store_module.Store.init(a, &database, "origin");
    const message: protocol.Message = .{ .nonce = 0, .origin = 100, .destination = 200, .body = "public reveal hook authority fixture" };
    _ = try store.storeMessage(message, 1, null);
    try store.markTerminal(message.id());
    const pending_prefix = try db.keys.pendingDestination(a, 200);
    defer a.free(pending_prefix);
    var options: actor_module.Options = .{ .id = message.id(), .context = @splat(4), .nonce = 0, .origin = 100, .destination = 200, .acknowledge_canonical = false };
    var spy: Spy = .{};
    const clock: @import("agents/destination/root.zig").Clock = .{ .unix_ms = now.unix_ms, .deadline_ns = (try @import("agents/scraper/receipts_evm.zig").nowNs()) + 30 * std.time.ns_per_s };
    {
        const actor = try actor_module.Operation.open(a, &store, options, now);
        defer actor.deinit();
        try driver.NativeTests.confirmExisting(&spy, actor, message, clock, now);
        try std.testing.expectEqual(@as(usize, 0), spy.calls);
        try actor.alreadyDelivered(true, .{ .unix_ms = now.unix_ms + 600000, .monotonic_ms = now.monotonic_ms + 600000 });
        try std.testing.expectEqual(.delivered, actor.value.stage);
        try std.testing.expect(!try store.processed(0));
        try std.testing.expect(try store.terminal(message.id()));
        const pending = (try store.typed.get(a, pending_prefix, &([_]u8{0} ** 4))).?;
        defer a.free(pending);
        try std.testing.expectEqualSlices(u8, &message.id(), pending);
    }
    // The capability is process-local. An allowed reopen can publish the
    // completion and run the hook without preparing/signing a process again.
    options.acknowledge_canonical = true;
    const actor = try actor_module.Operation.open(a, &store, options, .{ .unix_ms = now.unix_ms + 600000, .monotonic_ms = now.monotonic_ms + 600000 });
    defer actor.deinit();
    try driver.NativeTests.confirmExisting(&spy, actor, message, clock, now);
    try actor.alreadyDelivered(true, .{ .unix_ms = now.unix_ms + 600000, .monotonic_ms = now.monotonic_ms + 600000 });
    try std.testing.expectEqual(@as(usize, 1), spy.calls);
    try std.testing.expect(try store.processed(0));
    try std.testing.expect(!try store.terminal(message.id()));
    try std.testing.expect((try store.typed.get(a, pending_prefix, &([_]u8{0} ** 4))) == null);
}

test "canonical admission signed group recovery after Rocks reopen preserves fees nonce and later allowed acknowledgment" {
    const f = try fixture.Fixture.init(a, .{ 1, 3 }, 2);
    defer f.deinit();
    for (0..3) |_| _ = try f.lane.tickNativeGroups(now, &f.cancel);
    {
        var journal = try f.journal();
        defer journal.deinit();
        try std.testing.expectEqual(.signed, journal.record.phase);
    }
    const signed_before = blk: {
        const actor = try f.actor(0, now);
        defer actor.deinit();
        break :blk try a.dupe(u8, actor.signed.?.bytes);
    };
    defer a.free(signed_before);
    const keys = f.signer.count;
    const nonces = f.network.base.nonce_reads;
    const estimates = f.network.base.estimates;
    const broadcasts = f.network.base.broadcasts;
    try f.restartDatabaseFactoryLane();
    f.chains[2].max_submit_queue_length = 1;
    try replacePolicy(f, .{ .whitelist = &.{.{ .message_id = .{ .values = &.{@as([32]u8, @splat(99))} } }} });
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 2), f.lane.active.items.len);
    for (f.lane.active.items) |item| {
        try std.testing.expect(item.recovery_only);
        try std.testing.expect(!item.metric_active);
    }
    try std.testing.expect(try f.lane.nativePreparationAllowed(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel));
    for (f.lane.active.items) |item| {
        try std.testing.expectEqual(@as(?bool, false), item.native_submit_queued);
        try std.testing.expectEqual(@as(?bool, false), item.native_needs_preparation);
    }
    _ = try f.lane.tickNativeGroups(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel);
    try std.testing.expectEqual(broadcasts, f.network.base.broadcasts);
    f.network.included = true;
    f.network.delivered = true;
    _ = try f.lane.tickNativeGroups(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel);
    for (f.lane.active.items) |item| try std.testing.expect(!try f.lane.advance(item, .{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel));
    while (f.lane.active.items.len != 0) {
        const item = f.lane.active.items[0];
        try std.testing.expect(try f.lane.advance(item, .{ .unix_ms = 602001, .monotonic_ms = 601001 }, &f.cancel));
        try f.lane.releaseCompleted(0);
    }
    for (&f.sources, f.messages, 0..) |*source, message, index| {
        try std.testing.expect(!try source.store.processed(message.nonce));
        var pending = (try source.store.pendingAtOrAfter(200, message.nonce)).?;
        defer pending.deinit();
        try std.testing.expectEqualSlices(u8, &message.id(), &pending.value.id());
        const actor = try f.actor(index, .{ .unix_ms = 602001, .monotonic_ms = 601001 });
        defer actor.deinit();
        try std.testing.expectEqualSlices(u8, signed_before, actor.signed.?.bytes);
    }
    try std.testing.expectEqual(@as(u256, 25), (try f.sources[0].store.expenditure(f.messages[0].id())).tokens_used);
    try std.testing.expectEqual(@as(u256, 75), (try f.sources[1].store.expenditure(f.messages[1].id())).tokens_used);
    // Canonical group GC retires the nonce/journal even though current message
    // policy withholds canonical acknowledgment. A later denied rescan must
    // skip those settled rows, not mistake retained signed bytes for an orphan.
    _ = try f.lane.tickNativeGroups(.{ .unix_ms = 602002, .monotonic_ms = 601002 }, &f.cancel);
    for (&f.lane_origins) |*origin| if (origin.loader) |*loader| loader.rescan();
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
    try replacePolicy(f, .{});
    for (&f.lane_origins) |*origin| if (origin.loader) |*loader| loader.rescan();
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 2), f.lane.active.items.len);
    while (f.lane.active.items.len != 0) {
        const item = f.lane.active.items[0];
        try std.testing.expect(!item.recovery_only);
        try std.testing.expect(try f.lane.advance(item, .{ .unix_ms = 602002, .monotonic_ms = 601002 }, &f.cancel));
        try f.lane.releaseCompleted(0);
    }
    for (&f.sources, f.messages) |*source, message| try std.testing.expect(try source.store.processed(message.nonce));
    try std.testing.expectEqual(keys, f.signer.count);
    try std.testing.expectEqual(nonces, f.network.base.nonce_reads);
    try std.testing.expectEqual(estimates, f.network.base.estimates);
    try std.testing.expectEqual(broadcasts, f.network.base.broadcasts);
    try std.testing.expectEqual(@as(u256, 25), (try f.sources[0].store.expenditure(f.messages[0].id())).tokens_used);
    try std.testing.expectEqual(@as(u256, 75), (try f.sources[1].store.expenditure(f.messages[1].id())).tokens_used);
}

test "canonical admission signed Tron scalar Root recovery preserves exact bytes without new key or send" {
    const NativeFixture = @import("native_sender_recovery_test.zig").Fixture;
    const control = @import("agents/relayer/control.zig");
    const settings = @import("settings/root.zig");
    const f = try NativeFixture.init();
    defer f.deinit();
    var prepared = try @import("agents/destination/types.zig").Prepared.restore(a, f.actor.intent.?);
    defer prepared.deinit();
    var signed = try f.factory.sign(&prepared, null, f.actor.persistence(f.now), try f.clock());
    defer signed.deinit();
    const exact = try a.dupe(u8, signed.bytes);
    defer a.free(exact);
    const keys = f.signer.count;
    const estimates = f.estimates;
    try f.reopen();
    var configured: settings.Settings = .{
        .config = try @import("config.zig").Config.load(a, .{}),
        .chains = &.{},
        .metrics_port = 0,
        .role = .{ .relayer = std.mem.zeroes(@import("settings/types.zig").Relayer) },
    };
    defer configured.config.deinit();
    configured.role.relayer.max_message_retries = 100;
    configured.role.relayer.gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }};
    f.owner.settings = &configured;
    f.owner.environment = &f.env;
    f.owner.metric_tracker = null;
    f.owner.memory_mutex = .{};
    f.owner.retained_bytes = 0;
    f.owner.control_hub = try control.Hub.init(a, &configured, &f.env, &f.origin_set, f.sender_owner, null, &f.owner.denylist);
    defer f.owner.control_hub.deinit();
    f.lane.control = try control.Control.init(&f.owner.control_hub, &f.destination_chain);
    defer f.lane.control.deinit();
    f.lane.native_destination = &f.factory;
    defer {
        while (f.lane.active.items.len != 0) f.lane.releaseCompleted(0) catch unreachable;
        f.lane.active.deinit(a);
        if (f.origin_lanes[0].loader) |*loader| loader.deinit();
        f.origin_lanes[0].loader = null;
    }
    const excluded = try policy.Policy.init(a, .{ .whitelist = &.{.{ .message_id = .{ .values = &.{@as([32]u8, @splat(99))} } }} }, null, &f.owner.denylist);
    f.owner.control_hub.gateway_policy.deinit();
    f.owner.control_hub.gateway_policy = excluded;
    _ = try f.lane.load(.{ .unix_ms = f.now.unix_ms, .monotonic_ms = f.now.monotonic_ms });
    try std.testing.expectEqual(@as(usize, 1), f.lane.active.items.len);
    try std.testing.expect(f.lane.active.items[0].recovery_only);
    try std.testing.expect(!try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = f.now.unix_ms, .monotonic_ms = f.now.monotonic_ms }, &f.cancel));
    try std.testing.expectEqual(@as(usize, 0), f.broadcasts);
    f.delivered = true;
    f.receipt = true;
    try std.testing.expect(!try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = f.now.unix_ms, .monotonic_ms = f.now.monotonic_ms }, &f.cancel));
    f.now = .{ .unix_ms = 1600001, .monotonic_ms = 600001 };
    try std.testing.expect(try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = f.now.unix_ms, .monotonic_ms = f.now.monotonic_ms }, &f.cancel));
    try f.lane.releaseCompleted(0);
    try std.testing.expect(!try f.origin.store.processed(0));
    try std.testing.expectEqual(@as(u256, 100), (try f.origin.store.expenditure(f.message.id())).tokens_used);
    f.owner.control_hub.gateway_policy.deinit();
    f.owner.control_hub.gateway_policy = try policy.Policy.init(a, .{}, null, &f.owner.denylist);
    f.origin_lanes[0].loader.?.rescan();
    _ = try f.lane.load(.{ .unix_ms = f.now.unix_ms, .monotonic_ms = f.now.monotonic_ms });
    try std.testing.expectEqual(@as(usize, 1), f.lane.active.items.len);
    try std.testing.expect(!f.lane.active.items[0].recovery_only);
    try std.testing.expect(try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = f.now.unix_ms, .monotonic_ms = f.now.monotonic_ms }, &f.cancel));
    try f.lane.releaseCompleted(0);
    try std.testing.expect(try f.origin.store.processed(0));
    try std.testing.expectEqualSlices(u8, exact, f.actor.signed.?.bytes);
    try std.testing.expectEqual(keys, f.signer.count);
    try std.testing.expectEqual(estimates, f.estimates);
    try std.testing.expectEqual(@as(usize, 0), f.broadcasts);
    try std.testing.expectEqual(@as(u256, 100), (try f.origin.store.expenditure(f.message.id())).tokens_used);
}

test "canonical admission EVM recovery requires the exact sealed context and inherited UUID relation" {
    const links = @import("agents/payload_links.zig");
    const db = @import("db/root.zig");
    const root = @import("agents/relayer_task.zig");
    const f = try fixture.Fixture.init(a, .{ 1, 3 }, 1);
    defer f.deinit();
    f.clearActive();
    useEvm(f);
    const message: protocol.Message = .{ .nonce = 20, .origin = 100, .destination = 200, .body = "durably sealed EVM work" };
    _ = try f.sources[0].store.storeMessage(message, 2, null);
    const context = root.NativeTests.evmOperationContext(f.lane.context.?, &f.chains[0]);
    const record: links.Record = .{
        .context = context,
        .message_id = message.id(),
        .generation = 1,
        .estimated_gas = 21000,
        .payload = .{
            .uuid = links.uuid(context, message.id(), 1),
            .metadata = "public fixture sealed payload",
            .data_json = "[{\"type\":\"0x00\",\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]",
            .gas_limit = 21000,
            .to = f.chains[2].contracts.mailbox,
        },
        .delivery = .{ .mailbox_message = message.id() },
    };
    try links.seal(a, &f.sources[0].store, record);
    try replacePolicy(f, .{ .whitelist = &.{.{ .message_id = .{ .values = &.{@as([32]u8, @splat(99))} } }} });
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 1), f.lane.active.items.len);
    try std.testing.expect(f.lane.active.items[0].recovery_only);
    try std.testing.expect(!f.lane.active.items[0].metric_active);
    try std.testing.expect(!try f.sources[0].store.processed(message.nonce));
    try f.lane.releaseCompleted(0);
    f.lane_origins[0].loader.?.rescan();
    const relation = try db.codec.encodeUuids(a, &.{@as([16]u8, @splat(99))});
    defer a.free(relation);
    try f.sources[0].store.typed.put(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &message.id(), relation);
    try std.testing.expectError(error.PayloadRelationChanged, f.lane.load(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms }));
    try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
    // Exact authority failure is preserved instead of falling through to a
    // fresh prepare. Canonical row and the durable sealed payload remain.
    try std.testing.expect(!try f.sources[0].store.processed(message.nonce));
    var sealed = (try links.load(a, &f.sources[0].store, message.id(), context)).?;
    defer sealed.deinit();
    try std.testing.expectEqual(@as(?u256, 21000), sealed.record().estimated_gas);
}

test "canonical admission signed group recovery rejects missing or foreign account nonce ownership" {
    const op = @import("agents/destination/operation.zig");
    for ([_]bool{ false, true }) |nonce_key| for ([_]bool{ false, true }) |missing| {
        const f = try fixture.Fixture.init(a, .{ 1, 3 }, 2);
        defer f.deinit();
        for (0..3) |_| _ = try f.lane.tickNativeGroups(now, &f.cancel);
        var journal = try f.journal();
        defer journal.deinit();
        const reserved_nonce = try journal.nonce();
        f.clearActive();
        try replacePolicy(f, .{ .whitelist = &.{.{ .message_id = .{ .values = &.{@as([32]u8, @splat(99))} } }} });
        const key: []const u8 = if (nonce_key) &reserved_nonce else "";
        const prefix = if (nonce_key) op.group_nonce_prefix else op.group_current_prefix;
        if (missing) {
            var batch = try journal.store.batch(a);
            defer batch.deinit();
            try batch.delete(prefix, key);
            try batch.commitSync();
        } else try journal.store.put(a, prefix, key, &@as([32]u8, @splat(99)));
        const keys = f.signer.count;
        const sends = f.network.base.broadcasts;
        try std.testing.expectError(error.NativeGroupNonceOwnerChanged, f.lane.load(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms }));
        try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
        try std.testing.expectEqual(keys, f.signer.count);
        try std.testing.expectEqual(sends, f.network.base.broadcasts);
        for (&f.sources, f.messages) |*source, message| try std.testing.expect(!try source.store.processed(message.nonce));
    };
}

test "canonical admission prepare pop rechecks deny after cap hold releases capacity and preserves confirmation drain" {
    const f = try fixture.Fixture.init(a, .{ 1, 3 }, 1);
    defer f.deinit();
    const message = try freshOnly(f);
    f.chains[2].max_submit_queue_length = 0;
    f.network.delivered = true;
    var rpc: RpcSpy = .{ .upstream = f.client.client.transport };
    f.client.client.transport = .{ .context = &rpc, .send_fn = RpcSpy.send };
    _ = try f.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 });
    try std.testing.expectEqual(@as(usize, 1), f.lane.active.items.len);
    try std.testing.expect(!try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 1000, .monotonic_ms = 0 }, &f.cancel));
    try std.testing.expect(!f.lane.active.items[0].native_pop_checked);
    try std.testing.expectEqual(@as(usize, 0), rpc.calls);
    try denyMessage(f, message);
    f.chains[2].max_submit_queue_length = 1;
    try std.testing.expect(try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 1150, .monotonic_ms = 150 }, &f.cancel));
    try f.lane.releaseCompleted(0);
    try std.testing.expectEqual(@as(usize, 0), rpc.calls);
    try std.testing.expectEqual(@as(usize, 0), f.signer.count);
    try std.testing.expectEqual(@as(usize, 0), f.network.base.broadcasts);
    try std.testing.expect(!try f.sources[0].store.processed(message.nonce));
    const neighbor: protocol.Message = .{ .nonce = 21, .origin = 100, .destination = 200, .body = "capacity neighbor" };
    _ = try f.sources[0].store.storeMessage(neighbor, 3, null);
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 1), f.lane.active.items.len);
    try std.testing.expectEqualSlices(u8, &neighbor.id(), &f.lane.active.items[0].message.value.id());
    try f.lane.releaseCompleted(0);
    try runtimeDocument(f, "{\"rules\":[]}");
    try replacePolicy(f, .{ .whitelist = &.{.{ .message_id = .{ .values = &.{message.id()} } }} });
    f.lane_origins[0].loader.?.rescan();
    try loadMany(f);
    try std.testing.expectEqual(@as(usize, 1), f.lane.active.items.len);
    try std.testing.expect(!try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 1150, .monotonic_ms = 150 }, &f.cancel));
    try std.testing.expect(rpc.calls > 0);
    // Confirm was legitimately acquired before the next rule. Source does not
    // evict this queue or revoke already-enqueued auxiliary child ownership.
    try denyMessage(f, message);
    try std.testing.expect(try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 601151, .monotonic_ms = 600151 }, &f.cancel));
    try f.lane.releaseCompleted(0);
    try std.testing.expect(try f.sources[0].store.processed(message.nonce));
    try std.testing.expectEqual(@as(usize, 0), f.signer.count);
    try std.testing.expectEqual(@as(usize, 0), f.network.base.broadcasts);
}

test "canonical admission pop permission survives PIO but real retry and reprocess require a new check" {
    for (0..3) |mode| {
        const f = try fixture.Fixture.init(a, .{ 1, 3 }, 1);
        defer f.deinit();
        const message = try freshOnly(f);
        f.chains[2].max_submit_queue_length = 1;
        f.network.delivered = true;
        var rpc: RpcSpy = .{ .upstream = f.client.client.transport, .fail_once = error.PendingReadIo };
        f.client.client.transport = .{ .context = &rpc, .send_fn = RpcSpy.send };
        _ = try f.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 });
        try std.testing.expectError(error.PendingReadIo, f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 1000, .monotonic_ms = 0 }, &f.cancel));
        try std.testing.expect(f.lane.active.items[0].native_pop_checked);
        if (mode != 0) {
            try manualReset(f, message, mode == 2);
            try std.testing.expect(!f.lane.active.items[0].native_pop_checked);
        }
        try denyMessage(f, message);
        if (mode == 0) {
            try std.testing.expect(!try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 1001, .monotonic_ms = 1 }, &f.cancel));
            try std.testing.expect(rpc.calls > 1);
            try std.testing.expectEqual(@import("db/json.zig").Status{ .Confirm = .AlreadySubmitted }, f.lane.active.items[0].metric_status);
        } else {
            try std.testing.expect(try f.lane.advance(f.lane.active.items[0], .{ .unix_ms = 1001, .monotonic_ms = 1 }, &f.cancel));
            try f.lane.releaseCompleted(0);
            try std.testing.expectEqual(@as(usize, 1), rpc.calls);
        }
        try std.testing.expect(!try f.sources[0].store.processed(message.nonce));
        try std.testing.expectEqual(@as(usize, 0), f.signer.count);
        try std.testing.expectEqual(@as(usize, 0), f.network.base.broadcasts);
    }
}

test "canonical admission group final local sweep rejects a message rule refreshed by the last member RPC" {
    const Hook = struct {
        f: *fixture.Fixture,
        target: usize,
        trigger: usize,
        calls: usize = 0,
        fired: bool = false,
        fn after(ctx: *anyopaque, request: @import("cloud/http.zig").Request) !void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            var parsed = try std.json.parseFromSlice(std.json.Value, a, request.body.?, .{});
            defer parsed.deinit();
            if (!std.mem.eql(u8, parsed.value.object.get("method").?.string, "starknet_call")) return;
            self.calls += 1;
            if (!self.fired and self.calls == self.trigger) {
                self.fired = true;
                try denyMessage(self.f, self.f.messages[self.target]);
            }
        }
    };
    for ([_]bool{ false, true }) |before_sign| for (0..2) |target| {
        const f = try fixture.Fixture.init(a, .{ 1, 3 }, 2);
        defer f.deinit();
        if (before_sign) _ = try f.lane.tickNativeGroups(now, &f.cancel);
        var hook: Hook = .{ .f = f, .target = target, .trigger = if (before_sign) 2 else 4 };
        var rpc: RpcSpy = .{ .upstream = f.client.client.transport, .hook_context = &hook, .hook_fn = Hook.after };
        f.client.client.transport = .{ .context = &rpc, .send_fn = RpcSpy.send };
        _ = try f.lane.tickNativeGroups(now, &f.cancel);
        try std.testing.expect(hook.fired);
        // A query signature before the rule is permitted. No executable
        // signature, new intent group or account nonce reservation survives.
        try std.testing.expectEqual(@as(usize, 1), f.signer.count);
        try std.testing.expectEqual(@as(usize, 0), f.network.base.broadcasts);
        try std.testing.expectError(error.MissingNativeGroup, f.journal());
        const typed: @import("db/root.zig").rocks.Typed = .{ .database = try f.database.get(&f.cancel), .domain_name = f.chains[2].name };
        try std.testing.expect((try typed.atOrAfter(a, @import("agents/destination/operation.zig").group_nonce_prefix, &.{})) == null);
        for (0..2) |index| {
            const actor = try f.actor(index, now);
            defer actor.deinit();
            try std.testing.expect(actor.signed == null);
            try std.testing.expectEqual(.ready, actor.value.stage);
            try std.testing.expect(!try f.sources[index].store.processed(f.messages[index].nonce));
        }
        rpc.hook_fn = null;
        try runtimeDocument(f, "{\"rules\":[]}");
        _ = try f.lane.tickNativeGroups(now, &f.cancel);
        _ = try f.lane.tickNativeGroups(now, &f.cancel);
        var journal = try f.journal();
        defer journal.deinit();
        try std.testing.expectEqual(.signed, journal.record.phase);
        try std.testing.expectEqual(@as(usize, 3), f.signer.count);
        try std.testing.expectEqual(@as(usize, 0), f.network.base.broadcasts);
    };
}
