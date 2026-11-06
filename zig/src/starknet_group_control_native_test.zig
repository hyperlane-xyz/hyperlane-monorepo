//! Cold signed group sender-policy acceptance over actual Root/Factory/Rocks/SDK.
const std = @import("std");
const fixtures = @import("starknet_group_native_test.zig");
const Fixture = fixtures.Fixture;
const signers = @import("agents/origin_signers.zig");
const tasks = @import("agents/origin_signer_tasks.zig");
const source = @import("agents/origin_signer_source.zig");
const resources = @import("agents/chain_source.zig");
const evm = @import("evm/provider.zig");
const abi = @import("evm/codecs.zig");
const protocol = @import("protocol/root.zig");
const http = @import("cloud/http.zig");
const deny = @import("ops/runtime_denylist.zig");
const operation = @import("agents/operation.zig");
const a = std.testing.allocator;
const Clock = struct {
    value: operation.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 },
    fn read(ctx: *anyopaque) !operation.Times {
        return @as(*Clock, @ptrCast(@alignCast(ctx))).value;
    }
    fn interface(self: *Clock) operation.ObservationClock {
        return .{ .context = self, .now_fn = read };
    }
    fn at(self: *Clock, elapsed: u64) void {
        self.value = .{ .unix_ms = 1000 + elapsed, .monotonic_ms = elapsed };
    }
};
const Probe = struct {
    sender: u8 = 45,
    failure: ?anyerror = null,
    transaction_reads: usize = 0,
    receipt_reads: usize = 0,
    fn read(ctx: *anyopaque, allocator: std.mem.Allocator, bytes: []const u8, _: evm.Options) !evm.WireResponse {
        const self: *Probe = @ptrCast(@alignCast(ctx));
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
        defer parsed.deinit();
        const method = parsed.value.object.get("method").?.string;
        const id = parsed.value.object.get("id").?;
        var result: std.json.Value = .null;
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const memory = arena.allocator();
        if (std.mem.eql(u8, method, "eth_getTransactionByHash")) {
            self.transaction_reads += 1;
            if (self.failure) |err| return err;
            const tx = parsed.value.object.get("params").?.array.items[0].string;
            const value = try std.json.Stringify.valueAlloc(memory, .{ .hash = tx, .blockNumber = "0x1", .blockHash = "0x" ++ "11" ** 32, .from = try abi.hexAlloc(memory, &([_]u8{self.sender} ** 20)) }, .{});
            result = (try std.json.parseFromSlice(std.json.Value, memory, value, .{ .allocate = .alloc_always })).value;
        } else if (std.mem.eql(u8, method, "eth_getTransactionReceipt")) {
            self.receipt_reads += 1;
        } else return error.UnexpectedSenderRpc;
        const encoded = try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = result }, .{});
        return .{ .bytes = encoded, .len = encoded.len };
    }
};
fn installDocument(f: *Fixture, bytes: []const u8) !void {
    const Rules = struct {
        bytes: []const u8,
        fn fetch(ctx: *anyopaque, allocator: std.mem.Allocator, _: []const u8, _: usize) !deny.Fetched {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, self.bytes) };
        }
        fn unix(_: *anyopaque) i64 {
            return 1000;
        }
    };
    const memory = f.readers.arena.allocator();
    const rules = try memory.create(Rules);
    rules.* = .{ .bytes = try memory.dupe(u8, bytes) };
    f.owner.denylist.config = .{ .url = "https://fixture/denylist", .poll_interval_ms = 1000, .cache_path = try std.fs.path.join(memory, &.{ f.path, "sender-rule-cache.json" }) };
    f.owner.denylist.transport = .{ .context = rules, .fetch = Rules.fetch };
    _ = try f.owner.denylist.refresh(.{ .context = rules, .now_unix = Rules.unix });
}
fn installRules(f: *Fixture, byte: u8) !void {
    const memory = f.readers.arena.allocator();
    var address: [32]u8 = @splat(0);
    @memset(address[12..], byte);
    const bytes = try std.json.Stringify.valueAlloc(memory, .{ .rules = .{.{ .address = try abi.hexAlloc(memory, &address), .reason = "cold group signer rule", .addedBy = "fixture" }} }, .{});
    try installDocument(f, bytes);
    try std.testing.expect(f.owner.denylist.hasAddressRules());
}
fn attach(f: *Fixture, probes: *[2]Probe, stored_hash: [2]bool) !*tasks.Owner {
    const owner = try tasks.Owner.open(a, &f.origin_set, &f.environment, .{ .curl_library = "unused" });
    errdefer owner.deinit();
    for (owner.slots, &f.sources, f.chains[0..2], 0..) |*slot, *origin, *chain, index| {
        if (stored_hash[index]) {
            var hash: [64]u8 = @splat(0);
            hash[63] = @intCast(index + 10);
            _ = try origin.store.storeMessage(f.messages[index], 1, hash);
        }
        const network = try a.create(resources.Resources);
        network.* = .{ .allocator = a, .arena = .init(a), .chain = chain.*, .options = .{ .curl_library = "unused" }, .environment = &f.environment, .http = http.HttpTransport.init(a) };
        slot.network = network;
        network.rpc_client = try evm.RpcClient.init(a, "https://fixture/sender", .{ .exchange = .{ .context = &probes[index], .fetch_fn = Probe.read } });
        network.clients = .{ .ethereum = &network.rpc_client.? };
        slot.source = source.Source.initProvenance(network, source.Provenance.fromStore(&origin.store));
    }
    f.owner.signers = owner;
    try std.testing.expectEqual(@as(usize, 0), owner.cache.stats().entries);
    return owner;
}
fn cold(f: *Fixture) !void {
    const now: operation.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
    for (0..3) |_| _ = try f.lane.tickNativeGroups(now, &f.cancel);
    try std.testing.expectEqual(@as(usize, 2), f.signer.count);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
    try f.restartDatabaseFactoryLane();
    try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
    var journal = try f.journal();
    defer journal.deinit();
    try std.testing.expectEqual(.signed, journal.record.phase);
}

test "Starknet Root control cold signed recovery performs initial sender lookup before new address policy permits rebroadcast" {
    const f = try Fixture.init(a, .{ 1, 3 }, 2);
    defer f.deinit();
    try cold(f);
    var probes = [_]Probe{ .{ .sender = 44 }, .{} };
    const owner = try attach(f, &probes, .{ true, true });
    defer owner.deinit();
    try installRules(f, 44);
    var clock: Clock = .{};
    f.owner.options.observation_clock = clock.interface();
    const receipt_before = f.network.receipt_reads;
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 1), probes[0].transaction_reads);
    try std.testing.expectEqual(@as(usize, 1), probes[0].receipt_reads);
    try std.testing.expectEqual(@as(usize, 1), owner.cache.stats().entries);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 2), f.signer.count);
    try std.testing.expect(f.network.receipt_reads > receipt_before); // reconciliation remains allowed
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 1), probes[0].transaction_reads);
    try installRules(f, 46); // cached sender44 is now allowed, rules remain active
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 2), f.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 2), f.signer.count);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.nonce_reads);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.estimates);
    try std.testing.expectEqual(@as(usize, 1), probes[0].transaction_reads);
    try std.testing.expectEqual(@as(usize, 1), probes[1].transaction_reads);
}

test "Starknet Root control cold sender peer failures retain Source30 60 120 240 second waits before giveup" {
    const f = try Fixture.init(a, .{ 1, 3 }, 2);
    defer f.deinit();
    try cold(f);
    var probes = [_]Probe{ .{ .failure = error.ConnectionRefused }, .{} };
    const owner = try attach(f, &probes, .{ true, true });
    defer owner.deinit();
    try installRules(f, 44);
    var clock: Clock = .{};
    f.owner.options.observation_clock = clock.interface();
    const boundaries = [_]u64{ 0, 30000, 90000, 210000, 450000 };
    for (boundaries, 0..) |boundary, index| {
        if (index != 0) {
            clock.at(boundary - 1);
            _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
            try std.testing.expectEqual(index, probes[0].transaction_reads);
            try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
        }
        clock.at(boundary);
        _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
        try std.testing.expectEqual(index + 1, probes[0].transaction_reads);
        try std.testing.expectEqual(@as(usize, if (index == 4) 2 else 1), f.network.base.broadcasts);
        try std.testing.expectEqual(@as(usize, 2), f.signer.count);
    }
    clock.at(451000);
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 5), probes[0].transaction_reads); // cached-only cooldown
    try std.testing.expectEqual(@as(usize, 2), f.signer.count);
}

test "Starknet Root control missing dispatch hash waits once30 seconds on cold signed recovery" {
    const f = try Fixture.init(a, .{ 1, 3 }, 2);
    defer f.deinit();
    try cold(f);
    var probes = [_]Probe{ .{}, .{} };
    const owner = try attach(f, &probes, .{ false, true });
    defer owner.deinit();
    try installRules(f, 44);
    var clock: Clock = .{};
    f.owner.options.observation_clock = clock.interface();
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 0), probes[0].transaction_reads);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
    clock.at(29999);
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
    clock.at(30000);
    _ = try f.lane.tickNativeGroups(clock.value, &f.cancel);
    try std.testing.expectEqual(@as(usize, 2), f.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 0), probes[0].transaction_reads);
    try std.testing.expectEqual(@as(usize, 1), probes[1].transaction_reads);
    try std.testing.expectEqual(@as(usize, 2), f.signer.count);
}

test "Starknet Root control cold denied sender still reconciles actual inclusion without new sign or broadcast" {
    const f = try Fixture.init(a, .{ 1, 3 }, 2);
    defer f.deinit();
    try cold(f);
    var probes = [_]Probe{ .{ .sender = 44 }, .{} };
    const owner = try attach(f, &probes, .{ true, true });
    defer owner.deinit();
    try installRules(f, 44);
    f.network.included = true;
    const receipt_before = f.network.receipt_reads;
    _ = try f.lane.tickNativeGroups(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel);
    try std.testing.expect(f.network.receipt_reads > receipt_before);
    try std.testing.expectEqual(@as(usize, 0), probes[0].transaction_reads);
    try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 2), f.signer.count);
    var journal = try f.journal();
    defer journal.deinit();
    try std.testing.expectEqual(.included, journal.record.phase);
    for (0..2) |i| {
        const actor = try f.actor(i, .{ .unix_ms = 2000, .monotonic_ms = 1000 });
        defer actor.deinit();
        try std.testing.expect(actor.value.confirmation_started);
    }
}

fn submittedCount(registry: *@import("ops/metrics.zig").Registry) !u64 {
    const text = try registry.render(a);
    defer a.free(text);
    var lines = std.mem.splitScalar(u8, text, '\n');
    var total: u64 = 0;
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "hyperlane_operations_processed_count{")) continue;
        if (std.mem.indexOf(u8, line, "phase=\"submitted\"") == null) continue;
        const split = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        total += try std.fmt.parseInt(u64, line[split + 1 ..], 10);
    }
    return total;
}

test "Starknet Root control submitted counts two cold group members once across unknown inclusion outcome and historical Confirm restore" {
    const metric = @import("ops/metrics.zig");
    const relayer_metric = @import("ops/relayer_metrics.zig");
    const native_op = @import("agents/destination/operation.zig");
    for ([_]bool{ false, true }) |unknown| {
        const f = try Fixture.init(a, .{ 1, 3 }, 2);
        defer f.deinit();
        try cold(f);
        const registry = try metric.Registry.init(a, .relayer, .{ .base_version = "group-control-fixture" });
        defer registry.deinit();
        const tracker = try relayer_metric.WaitTracker.init(a, registry, .{ .max_active = 16, .max_bytes = 1024 * 1024 });
        defer tracker.deinit();
        f.owner.metric_tracker = tracker;
        var adapters: [2]*relayer_metric.Adapter = undefined;
        var initialized: usize = 0;
        defer {
            f.owner.metric_tracker = null;
            for (adapters[0..initialized], 0..) |adapter, index| {
                f.lane_origins[index].metrics = null;
                adapter.deinit();
            }
        }
        for (&adapters, 0..) |*slot, index| {
            slot.* = try relayer_metric.Adapter.init(a, tracker, f.chains[index].name, f.chains[2].name);
            initialized += 1;
            f.lane_origins[index].metrics = slot.*;
        }
        try std.testing.expectEqual(@as(usize, 0), f.lane.active.items.len);
        try std.testing.expectEqual(@as(u64, 0), try submittedCount(registry));
        f.network.included = true;
        if (unknown) {
            native_op.GroupTestFault.after_commit.store(true, .release);
            defer native_op.GroupTestFault.after_commit.store(false, .release);
            try std.testing.expectError(error.NativeGroupCommitOutcomeUnknown, f.lane.tickNativeGroups(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel));
        } else _ = try f.lane.tickNativeGroups(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &f.cancel);
        try std.testing.expectEqual(@as(u64, 2), try submittedCount(registry));
        _ = try f.lane.tickNativeGroups(.{ .unix_ms = 2001, .monotonic_ms = 1001 }, &f.cancel);
        try std.testing.expectEqual(@as(u64, 2), try submittedCount(registry));
        _ = try f.lane.load(.{ .unix_ms = 2001, .monotonic_ms = 1001 });
        _ = try f.lane.load(.{ .unix_ms = 2001, .monotonic_ms = 1001 });
        for (f.lane.active.items) |item| _ = try f.lane.advance(item, .{ .unix_ms = 2001, .monotonic_ms = 1001 }, &f.cancel);
        try std.testing.expectEqual(@as(u64, 2), try submittedCount(registry));
        // A new process epoch restores Confirm state; it must not replay events.
        try f.restartDatabaseFactoryLane();
        for (adapters, 0..) |adapter, index| f.lane_origins[index].metrics = adapter;
        _ = try f.lane.tickNativeGroups(.{ .unix_ms = 2002, .monotonic_ms = 1002 }, &f.cancel);
        try std.testing.expectEqual(@as(u64, 2), try submittedCount(registry));
        try std.testing.expectEqual(@as(usize, 2), f.signer.count);
        try std.testing.expectEqual(@as(usize, 1), f.network.base.broadcasts);
    }
}

fn reprocessMember(f: *Fixture, index: usize) !void {
    const Request = struct {
        owner: @import("ops/admin/api.zig").ReprocessOwner,
        message: protocol.Message,
        cancel: *const std.atomic.Value(bool),
        response: ?[]u8 = null,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            self.response = self.owner.enqueue_fn(self.owner.context, a, self.message, self.cancel) catch |err| {
                self.failure = err;
                return;
            };
        }
    };
    var cancel = std.atomic.Value(bool).init(false);
    var request: Request = .{ .owner = f.owner.control_hub.reprocessOwner(), .message = f.messages[index], .cancel = &cancel };
    var joined = false;
    f.lane.control.queue.wake.store(false, .release); // queue is empty; observe this request's publication
    const thread = try std.Thread.spawn(.{}, Request.run, .{&request});
    defer {
        cancel.store(true, .release);
        if (!joined) thread.join();
        if (request.response) |bytes| a.free(bytes);
    }
    var waited: u64 = 0;
    while (!f.lane.control.wake.load(.acquire) and waited < 2000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
    if (!f.lane.control.wake.load(.acquire)) return error.ControlRequestNotQueued;
    _ = try f.lane.control.drain(&f.lane, .{ .unix_ms = 1001, .monotonic_ms = 1 }, &f.cancel);
    thread.join();
    joined = true;
    if (request.failure) |err| return err;
    try std.testing.expect(request.response != null);
    try std.testing.expect(std.mem.indexOf(u8, request.response.?, "status: Retry(Manual)") != null);
}

test "Starknet Root control deny cancel and real manual reprocess cut whole prepared group before executable signature" {
    for (0..3) |mode| {
        const f = try Fixture.init(a, .{ 1, 3 }, 2);
        defer f.deinit();
        const original = try f.actor(1, .{ .unix_ms = 1000, .monotonic_ms = 0 });
        const original_intent = try a.dupe(u8, original.intent.?);
        defer a.free(original_intent);
        original.deinit();
        _ = try f.lane.tickNativeGroups(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &f.cancel);
        {
            var journal = try f.journal();
            defer journal.deinit();
            try std.testing.expectEqual(.prepared, journal.record.phase);
        }
        try std.testing.expectEqual(@as(usize, 1), f.signer.count); // query estimate only
        switch (mode) {
            0 => try installDocument(f, "{\"rules\":[{\"reason\":\"member rule\",\"addedBy\":\"fixture\",\"match\":{\"originDomain\":100}}]}"),
            1 => f.cancel.store(true, .release),
            2 => try reprocessMember(f, 0),
            else => unreachable,
        }
        if (mode == 1) {
            try std.testing.expectError(error.RequestCancelled, f.lane.tickNativeGroups(.{ .unix_ms = 1001, .monotonic_ms = 1 }, &f.cancel));
            f.cancel.store(false, .release);
            var journal = try f.journal();
            defer journal.deinit();
            try std.testing.expectEqual(.prepared, journal.record.phase); // cancellation retains recoverable unsigned group
        } else {
            _ = try f.lane.tickNativeGroups(.{ .unix_ms = 1001, .monotonic_ms = 1 }, &f.cancel);
            try std.testing.expectError(error.MissingNativeGroup, f.journal());
            const untouched = try f.actor(1, .{ .unix_ms = 1001, .monotonic_ms = 1 });
            defer untouched.deinit();
            try std.testing.expectEqualStrings(original_intent, untouched.intent.?);
            try std.testing.expectEqual(.ready, untouched.value.stage);
            try std.testing.expect(untouched.signed == null);
        }
        try std.testing.expectEqual(@as(usize, 1), f.signer.count);
        try std.testing.expectEqual(@as(usize, 0), f.network.base.broadcasts);
        for (0..2) |i| {
            const actor = try f.actor(i, .{ .unix_ms = 1001, .monotonic_ms = 1 });
            defer actor.deinit();
            try std.testing.expect(actor.signed == null);
        }
    }
}
