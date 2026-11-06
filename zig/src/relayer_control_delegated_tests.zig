const std = @import("std");
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const control = @import("agents/relayer/control.zig");
const bindings = @import("ops/admin/relayer_bindings.zig");
const settings = @import("settings/root.zig");
const types = @import("settings/types.zig");
const protocol = @import("protocol/root.zig");
const native = @import("agents/store.zig");
const loader = @import("agents/loader.zig");
const relay_policy = @import("agents/relay_policy.zig");
const origin_signers = @import("agents/origin_signers.zig");
const origin_tasks = @import("agents/origin_tasks.zig");
const denylist = @import("ops/runtime_denylist.zig");
const api = @import("ops/admin/api.zig");
const db = @import("db/root.zig");
const A = std.mem.Allocator;

fn relayerSettings() types.Relayer {
    return .{
        .gas_payment_enforcement = &.{.{ .matching_list = &.{.{ .origin_domain = .{ .values = &.{1} } }}, .policy = .{ .minimum = 5 } }},
        .whitelist = &.{},
        .blacklist = &.{},
        .address_blacklist = &.{},
        .metric_app_contexts = &.{},
        .ism_cache_configs = &.{},
        .relay_api_rate_limit_max_requests = null,
        .relay_api_rate_limit_window_secs = null,
        .relay_api_cors_origins = &.{},
        .relay_chains = &.{},
        .db = "unused",
        .transaction_gas_limit = null,
        .skip_transaction_gas_limit_for = &.{},
        .allow_local_checkpoint_syncers = false,
        .allow_contract_call_caching = false,
        .max_message_retries = 10,
        .tx_id_indexing_enabled = false,
        .igp_indexing_enabled = false,
        .runtime_denylist_url = null,
        .runtime_denylist_poll_interval_seconds = 60,
        .websocket_url = null,
        .websocket_authority_enabled = false,
        .relay_api_enabled = false,
        .relay_api_port = null,
    };
}

const TestOriginLane = struct {
    loader: ?loader.Loader = null,
    policy: ?relay_policy.Policy = null,
};
const TestActive = struct {
    origin_index: usize,
    message: native.OwnedMessage,
    next_ms: u64 = 0,
    retained_bytes: usize = 0,
    signer_prepare: origin_signers.Prepare = .{},
};
const TestHandle = struct { chain: *const types.Chain, store: *native.Store };
const TestSlot = struct {
    chain: *const types.Chain,
    store: *native.Store,
    pub fn handle(self: *TestSlot) ?TestHandle {
        return .{ .chain = self.chain, .store = self.store };
    }
};
const TestOrigins = struct { slots: []TestSlot };
const TestOptions = struct {
    max_active: usize = 64,
    max_active_bytes: usize = 1024 * 1024,
    max_retained_bytes: usize = 1024 * 1024,
};
const TestOwner = struct {
    allocator: A,
    settings: *const settings.Settings,
    origins: *TestOrigins,
    options: TestOptions = .{},
    memory_mutex: std.Thread.Mutex = .{},
    retained_bytes: usize = 0,
};
const TestNonceManager = struct {
    scan_resume: ?u256 = null,
    desired: ?u256 = null,
    calls: usize = 0,
    pub fn overwriteUpper(self: *TestNonceManager, _: A, desired: ?u256) !void {
        self.desired = desired;
        self.calls += 1;
    }
};
const TestLanderStore = struct {
    pub fn highestTransactionIndex(_: *TestLanderStore, _: A) !u32 {
        return 9;
    }
};
const TestService = struct {
    nonces: TestNonceManager = .{},
    store: TestLanderStore = .{},
    scan_cursor: u32 = 0,
    queued_transactions: u32 = 3,
    recovery_complete: bool = true,
    recovery_blocked: bool = true,
};
const TestLane = struct {
    owner: *TestOwner,
    chain: *const types.Chain,
    origins: []TestOriginLane,
    active: std.ArrayList(*TestActive) = .empty,
    active_bytes: usize = 0,
    transactions: ?TestService = null,
};

const NativeFixture = struct {
    configured: settings.Settings,
    environment: std.process.EnvMap,
    runtime: denylist.RuntimeDenylist,
    database: db.rocks.Database,
    store: native.Store,
    hub: control.Hub,
    control: *control.Control,
    origin_slots: [1]TestSlot,
    origin_set: TestOrigins,
    origin_lanes: [1]TestOriginLane,
    owner: TestOwner,
    lane: TestLane,
    owner_cancel: std.atomic.Value(bool) = .init(false),

    fn init(a: A, path: []const u8) !*NativeFixture {
        const self = try a.create(NativeFixture);
        errdefer a.destroy(self);
        const chains = try a.alloc(types.Chain, 2);
        errdefer a.free(chains);
        chains[0].name = "origin";
        chains[0].domain = 1;
        chains[0].protocol = .ethereum;
        chains[1].name = "destination";
        chains[1].domain = 2;
        chains[1].protocol = .ethereum;
        self.* = .{
            .configured = undefined,
            .environment = std.process.EnvMap.init(a),
            .runtime = try denylist.RuntimeDenylist.init(a, null),
            .database = try db.rocks.Database.open(a, path, .{ .sync = true }),
            .store = undefined,
            .hub = undefined,
            .control = undefined,
            .origin_slots = undefined,
            .origin_set = undefined,
            .origin_lanes = .{.{}},
            .owner = undefined,
            .lane = undefined,
        };
        errdefer self.environment.deinit();
        errdefer self.runtime.deinit();
        errdefer self.database.deinit();
        self.configured.chains = chains;
        self.configured.role = .{ .relayer = relayerSettings() };
        self.store = native.Store.init(a, &self.database, "origin");
        self.origin_slots[0] = .{ .chain = &chains[0], .store = &self.store };
        self.origin_set = .{ .slots = &self.origin_slots };
        self.owner = .{ .allocator = a, .settings = &self.configured, .origins = &self.origin_set };
        self.lane = .{ .owner = &self.owner, .chain = &chains[1], .origins = &self.origin_lanes };
        self.hub = try control.Hub.init(a, &self.configured, &self.environment, undefined, undefined, null, &self.runtime);
        errdefer self.hub.deinit();
        self.control = try control.Control.init(&self.hub, &chains[1]);
        return self;
    }

    fn deinit(self: *NativeFixture, a: A) void {
        self.control.deinit();
        self.hub.deinit();
        for (self.lane.active.items) |item| {
            item.message.deinit();
            a.destroy(item);
        }
        self.lane.active.deinit(a);
        for (&self.origin_lanes) |*origin| {
            if (origin.loader) |*value| value.deinit();
            if (origin.policy) |*value| value.deinit();
        }
        self.database.deinit();
        self.runtime.deinit();
        self.environment.deinit();
        a.free(self.configured.chains);
        a.destroy(self);
    }

    fn addActive(self: *NativeFixture, value: protocol.Message) !*TestActive {
        const a = self.owner.allocator;
        const bytes = try value.encodeAlloc(a);
        errdefer a.free(bytes);
        const item = try a.create(TestActive);
        errdefer a.destroy(item);
        item.* = .{ .origin_index = 0, .message = .{ .allocator = a, .bytes = bytes, .value = try protocol.Message.decode(bytes) } };
        try self.lane.active.append(a, item);
        return item;
    }

    fn drain(self: *NativeFixture) !void {
        _ = try self.control.drain(&self.lane, .{ .unix_ms = 1000, .monotonic_ms = 100 }, &self.owner_cancel);
    }
};

fn temporaryDatabase(a: A, temp: *std.testing.TmpDir) ![]u8 {
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    return std.fs.path.join(a, &.{ parent, "rocks" });
}

fn message(nonce: u32) protocol.Message {
    return .{ .version = 3, .nonce = nonce, .origin = 1, .destination = 2, .sender = @splat(1), .recipient = @splat(2), .body = "payload" };
}

const RetryCaller = struct {
    owner: api.RetryOwner,
    pattern: types.MatchingList,
    cancel: std.atomic.Value(bool) = .init(false),
    result: ?api.RetryResult = null,
    failure: ?anyerror = null,
    fn run(self: *RetryCaller) void {
        const result = self.owner.retry_fn(self.owner.context, std.testing.allocator, "request", self.pattern, &self.cancel) catch |err| {
            self.failure = err;
            return;
        };
        self.result = result;
    }
};
const DrainWorker = struct {
    fixture: *NativeFixture,
    failure: ?anyerror = null,
    fn run(self: *DrainWorker) void {
        self.fixture.drain() catch |err| {
            self.failure = err;
        };
    }
};

test "native manual retry is canonical durable and preserves in-flight message and dispatched hash" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path);
    defer fixture.deinit(a);
    const original = message(7);
    const transaction: [64]u8 = @splat(3);
    try fixture.store.upsertMessage(original, 20, transaction);
    try fixture.store.storeRetry(original.id(), .{ .retry_count = 8, .next_attempt_at_millis = 5000, .retry_delay_millis = 1000, .reason = .CouldNotFetchMetadata }, .{ .Retry = .CouldNotFetchMetadata });
    const item = try fixture.addActive(original);
    const native_bytes = item.message.bytes;
    var caller: RetryCaller = .{ .owner = fixture.hub.retryOwner(), .pattern = &.{.{}} };
    const thread = try std.Thread.spawn(.{}, RetryCaller.run, .{&caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(api.RetryResult{ .evaluated = 1, .matched = 1 }, caller.result.?);
    try std.testing.expectEqual(@as(u32, 0), try fixture.store.retryCount(original.id()));
    try std.testing.expectEqual(db.json.Status{ .Retry = .Manual }, (try fixture.store.status(original.id())).?);
    const state = (try fixture.store.retryState(original.id())).?;
    try std.testing.expectEqual(@as(u32, 0), state.retry_count);
    try std.testing.expect(state.next_attempt_at_millis == null and state.retry_delay_millis == null and state.reason == null);
    try std.testing.expectEqual(transaction, (try fixture.store.dispatchedTransaction(original.id())).?);
    try std.testing.expectEqual(@as(u64, 100), item.next_ms);
    try std.testing.expect(native_bytes.ptr == item.message.bytes.ptr);
}

test "native running caller timeout retires after durable mutation and orphan cannot resurrect" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path);
    defer fixture.deinit(a);
    fixture.hub.command_timeout_ms = 200;
    const original = message(3);
    try fixture.store.upsertMessage(original, 20, null);
    _ = try fixture.addActive(original);
    fixture.store.mutex.lock();
    var caller: RetryCaller = .{ .owner = fixture.hub.retryOwner(), .pattern = &.{.{}} };
    const caller_thread = try std.Thread.spawn(.{}, RetryCaller.run, .{&caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    var worker: DrainWorker = .{ .fixture = fixture };
    const owner_thread = try std.Thread.spawn(.{}, DrainWorker.run, .{&worker});
    std.Thread.sleep(20 * std.time.ns_per_ms);
    caller_thread.join();
    try std.testing.expectEqual(error.CommandDeadline, caller.failure.?);
    fixture.store.mutex.unlock();
    owner_thread.join();
    try std.testing.expect(worker.failure == null);
    try std.testing.expectEqual(@as(u32, 0), try fixture.store.retryCount(original.id()));
    try std.testing.expectEqual(db.json.Status{ .Retry = .Manual }, (try fixture.store.status(original.id())).?);

    var replacement = original;
    replacement.body = "canonical";
    try fixture.store.upsertMessage(replacement, 21, null);
    const orphan = try fixture.addActive(original);
    _ = orphan;
    caller = .{ .owner = fixture.hub.retryOwner(), .pattern = &.{.{ .message_id = .{ .values = &.{original.id()} } }} };
    const second = try std.Thread.spawn(.{}, RetryCaller.run, .{&caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    second.join();
    try std.testing.expectEqual(api.RetryResult{ .evaluated = 2, .failed = 2 }, caller.result.?);
    try std.testing.expectEqual(@as(u32, 0), try fixture.store.retryCount(replacement.id()));
    try std.testing.expect((try fixture.store.status(replacement.id())) == null);
}

test "native reprocess uses canonical store reset and source pending debug" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path);
    defer fixture.deinit(a);
    const original = message(4);
    try fixture.store.upsertMessage(original, 20, null);
    const owner = fixture.hub.reprocessOwner();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var caller_cancel = std.atomic.Value(bool).init(false);
    const Enqueue = struct {
        owner: api.ReprocessOwner,
        allocator: A,
        value: protocol.Message,
        cancel: *const std.atomic.Value(bool),
        response: ?[]u8 = null,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            const result = self.owner.enqueue_fn(self.owner.context, self.allocator, self.value, self.cancel) catch |err| {
                self.failure = err;
                return;
            };
            self.response = result;
        }
    };
    var caller: Enqueue = .{ .owner = owner, .allocator = arena.allocator(), .value = original, .cancel = &caller_cancel };
    const thread = try std.Thread.spawn(.{}, Enqueue.run, .{&caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expect(std.mem.startsWith(u8, caller.response.?, "PendingMessage { num_retries: 0, since_last_attempt_s: 0, next_attempt_after_s: 0, message_id: 0x"));
    try std.testing.expect(std.mem.endsWith(u8, caller.response.?, ", status: Retry(Manual), app_context: None }"));
    try std.testing.expectEqual(db.json.Status{ .Retry = .Manual }, (try fixture.store.status(original.id())).?);
}

test "native gas broadcast rebuilds current and future policies and queue snapshot is source shaped" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path);
    defer fixture.deinit(a);
    const original = message(5);
    try fixture.store.upsertMessage(original, 20, null);
    _ = try fixture.addActive(original);
    try fixture.drain();
    var cancel = std.atomic.Value(bool).init(false);
    const gas = fixture.hub.gasOwner();
    const add = struct {
        owner: api.GasOwner,
        cancel: *const std.atomic.Value(bool),
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            self.owner.add_fn(self.owner.context, std.testing.allocator, .{ .policy = .none, .matching_list = &.{} }, self.cancel) catch |err| {
                self.failure = err;
            };
        }
    };
    var adding: add = .{ .owner = gas, .cancel = &cancel };
    var thread = try std.Thread.spawn(.{}, add.run, .{&adding});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    thread.join();
    try std.testing.expect(adding.failure == null);
    const policy = &fixture.origin_lanes[0].policy.?;
    try std.testing.expectEqual(@import("relayer/policies.zig").Status{ .met = 100 }, try policy.evaluateGas(original, null, .{}, .{ .gas_limit = 100 }));
    const queue = fixture.hub.queueOwner();
    const QueueCaller = struct {
        owner: api.QueueOwner,
        cancel: *const std.atomic.Value(bool),
        response: ?[]u8 = null,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            const result = self.owner.render_fn(self.owner.context, std.testing.allocator, 2, self.cancel) catch |err| {
                self.failure = err;
                return;
            };
            self.response = result;
        }
    };
    var queue_caller: QueueCaller = .{ .owner = queue, .cancel = &cancel };
    thread = try std.Thread.spawn(.{}, QueueCaller.run, .{&queue_caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    thread.join();
    try std.testing.expect(queue_caller.failure == null);
    defer a.free(queue_caller.response.?);
    try std.testing.expect(std.mem.indexOf(u8, queue_caller.response.?, "\"type\": \"PendingMessage\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, queue_caller.response.?, "\"num_retries\": 0") != null);

    policy.deinit();
    fixture.origin_lanes[0].policy = null;
    try fixture.drain();
    try std.testing.expectEqual(@import("relayer/policies.zig").Status{ .met = 100 }, try fixture.origin_lanes[0].policy.?.evaluateGas(original, null, .{}, .{ .gas_limit = 100 }));
}

test "native nonce command resets manager scan and reopens recovery including null sentinel" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path);
    defer fixture.deinit(a);
    fixture.lane.transactions = .{ .nonces = .{ .scan_resume = 4 } };
    const service = &fixture.lane.transactions.?;
    const owner = fixture.hub.nonceOwner();
    const Caller = struct {
        owner: api.NonceOwner,
        desired: ?u64,
        failure: ?anyerror = null,
        owner_cancel: std.atomic.Value(bool) = .init(false),
        fn run(self: *@This()) void {
            self.owner.overwrite_fn(self.owner.context, 2, self.desired, &self.owner_cancel) catch |err| {
                self.failure = err;
            };
        }
    };
    var caller: Caller = .{ .owner = owner, .desired = 7 };
    var thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(@as(?u256, 7), service.nonces.desired);
    try std.testing.expectEqual(@as(u32, 9), service.scan_cursor);
    try std.testing.expectEqual(@as(u32, 0), service.queued_transactions);
    try std.testing.expect(!service.recovery_complete and !service.recovery_blocked);
    try std.testing.expect(service.nonces.scan_resume == null);
    caller = .{ .owner = owner, .desired = null };
    thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    while (!fixture.control.wake.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    try fixture.drain();
    thread.join();
    try std.testing.expectEqual(@as(?u256, null), service.nonces.desired);
    try std.testing.expectEqual(@as(usize, 2), service.nonces.calls);
}

test "native bindings bound ranges cancel and dynamically hide unready origins" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{ .sync = true });
    defer database.deinit();
    var store = native.Store.init(a, &database, "origin");
    const original = message(0);
    try store.upsertMessage(original, 20, null);
    var binding = bindings.Bindings.fromDomains(&.{.{ .name = "origin", .id = 1, .store = &store, .origin = undefined }});
    const owner = binding.messageDb();
    try std.testing.expect(owner.contains_fn(owner.context, 1));
    try std.testing.expect(!owner.contains_fn(owner.context, 2));
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    const found = try owner.list_fn(owner.context, arena.allocator(), 1, 0, 0, &cancel);
    try std.testing.expectEqual(@as(usize, 1), found.messages.len);
    try std.testing.expectEqualSlices(u8, original.body, found.messages[0].body);
    try std.testing.expectError(error.AdminRangeTooLarge, owner.list_fn(owner.context, arena.allocator(), 1, 0, 4096, &cancel));
    cancel.store(true, .release);
    try std.testing.expectError(error.Cancelled, owner.list_fn(owner.context, arena.allocator(), 1, 0, 0, &cancel));

    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var engine: @import("relayer/remote_checkpoints.zig").Engine = undefined;
    var chains: [1]types.Chain = undefined;
    chains[0].name = "origin";
    chains[0].domain = 1;
    chains[0].protocol = .ethereum;
    chains[0].index = .{ .interval = 2 };
    const database_owner = try origin_tasks.DatabaseOwner.init(a, "/nonexistent/ziggy-relayer-bindings");
    defer database_owner.deinit();
    const set = try origin_tasks.Set.open(a, &chains, &environment, database_owner, &engine, .{ .source = .{ .curl_library = "/nonexistent/ziggy-native" } });
    defer set.deinit();
    var dynamic = bindings.Bindings.init(set);
    const dynamic_messages = dynamic.messageDb();
    try std.testing.expect(!dynamic_messages.contains_fn(dynamic_messages.context, 1));
    try std.testing.expect(database_owner.value == null);
}

test {
    _ = @import("agents/relayer/control_test.zig");
}
