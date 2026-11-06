//! Source hyperlane-core FallbackProvider<GrpcChannel>: per-call endpoint
//! snapshots, >=4 errors,100ms retry rounds,10-error reprioritization and a
//! serialized latest-validator-set height probe after120s. No URLs/headers here.
const std = @import("std");
const grpc = @import("grpc.zig");
const proto = @import("proto.zig");
const Http = @import("../net/http_replay.zig");
const Runtime = @import("../net/http_runtime.zig").Runtime;
const Budget = @import("../net/byte_budget.zig").Budget;
const Metrics = @import("../ops/rpc_metrics.zig").Recorder;
const A = std.mem.Allocator;
const Snapshot = struct { index: usize, failed: u32 = 0, height: u64 = 0, seen: u64 };
fn nowNs() u64 {
    const t = std.time.Instant.now() catch unreachable;
    return @as(u64, @intCast(t.timestamp.sec)) *| std.time.ns_per_s +| @as(u64, @intCast(t.timestamp.nsec));
}
pub const Clock = struct { context: *anyopaque, now_fn: *const fn (*anyopaque) u64 };
pub const Health = struct {
    allocator: A,
    mutex: std.Thread.Mutex = .{},
    priorities: []Snapshot,
    probing: []bool,
    clock: ?Clock = null,
    pub fn init(a: A, count: usize, clock: ?Clock) !Health {
        if (count == 0 or count > 64) return error.InvalidGrpcEndpoints;
        const entries = try a.alloc(Snapshot, count);
        errdefer a.free(entries);
        const probes = try a.alloc(bool, count);
        @memset(probes, false);
        const initial_now = if (clock) |c| c.now_fn(c.context) else nowNs();
        for (entries, 0..) |*entry, i| entry.* = .{ .index = i, .seen = initial_now };
        return .{ .allocator = a, .priorities = entries, .probing = probes, .clock = clock };
    }
    pub fn deinit(self: *Health) void {
        for (self.probing) |value| std.debug.assert(!value);
        self.allocator.free(self.priorities);
        self.allocator.free(self.probing);
    }
    fn now(self: *Health) u64 {
        return if (self.clock) |c| c.now_fn(c.context) else nowNs();
    }
    fn snapshot(self: *Health, a: A) ![]Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        return a.dupe(Snapshot, self.priorities);
    }
    fn position(self: *Health, index: usize) usize {
        for (self.priorities, 0..) |entry, i| if (entry.index == index) return i;
        unreachable;
    }
    fn deprioritize(self: *Health, entry: Snapshot) void {
        const i = self.position(entry.index);
        std.mem.copyForwards(Snapshot, self.priorities[i .. self.priorities.len - 1], self.priorities[i + 1 ..]);
        self.priorities[self.priorities.len - 1] = entry;
    }
    fn failed(self: *Health, entry: Snapshot) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.priorities[self.position(entry.index)].failed +|= 1;
        if (entry.failed +| 1 >= 10) {
            var reset = entry;
            reset.failed = 0;
            self.deprioritize(reset);
        }
    }
    fn acquireProbe(self: *Health, entry: Snapshot, max_age: u64) ?Snapshot {
        if (self.priorities.len == 1 or self.now() -| entry.seen <= max_age) return null;
        self.mutex.lock();
        defer self.mutex.unlock();
        const current = self.priorities[self.position(entry.index)];
        if (self.probing[entry.index] or self.now() -| current.seen <= max_age) return null;
        self.probing[entry.index] = true;
        return current;
    }
    fn releaseProbe(self: *Health, index: usize, height: ?u64) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        std.debug.assert(self.probing[index]);
        self.probing[index] = false;
        if (height) |latest| {
            const old = self.priorities[self.position(index)];
            const updated: Snapshot = .{ .index = index, .height = @max(latest, old.height), .seen = self.now() };
            if (latest <= old.height) self.deprioritize(updated) else self.priorities[self.position(index)] = updated;
        }
    }
};
pub const Backend = struct { context: *anyopaque, call_fn: *const fn (*anyopaque, A, usize, grpc.Request, ?*Http.Replay) anyerror!grpc.Response };
pub const Config = struct { cooperative: bool = false, runtime: ?*Runtime = null, budget: ?*Budget = null, recorder: ?*Metrics = null, max_attempt_ms: u32 = 120000, max_block_time_ms: u32 = 120000, retry_ms: u32 = 100, provider_timeout_ms: u32 = 30000 };
const Op = struct {
    key: [32]u8,
    occurrence: u32,
    priorities: []Snapshot,
    cursor: usize = 0,
    errors: usize = 0,
    last_error: anyerror = error.EmptyGrpcPool,
    phase: enum { request, probe, retry, complete } = .request,
    outcome: ?grpc.Response = null,
    failure: ?anyerror = null,
    probe: ?Snapshot = null,
    replay: ?Http.Replay = null,
    started_ns: u64,
    provider_deadline: u64 = 0,
    retry_at: u64 = 0,
    bytes: usize = 0,
    metadata_bytes: usize,
    fn deinit(self: *Op, owner: *Client) void {
        if (self.probe) |probe| owner.health.releaseProbe(probe.index, null);
        if (self.replay) |*replay| replay.deinit();
        if (self.outcome) |*response| response.deinit();
        if (owner.config.budget) |budget| budget.release(self.bytes);
        if (owner.config.budget) |budget| budget.release(self.metadata_bytes);
        owner.allocator.free(self.priorities);
        owner.allocator.destroy(self);
    }
};
pub const Client = struct {
    allocator: A,
    health: *Health,
    backend: Backend,
    config: Config,
    operations: std.ArrayList(*Op) = .empty,
    occurrences: std.AutoHashMapUnmanaged([32]u8, u32) = .empty,
    in_pass: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    shared_started: ?std.time.Instant = null,
    pub fn init(a: A, health: *Health, backend: Backend, config: Config) !Client {
        if (config.max_attempt_ms == 0 or config.max_attempt_ms > 300000 or config.provider_timeout_ms == 0 or config.provider_timeout_ms > 30000) return error.InvalidGrpcFallbackLimit;
        return .{ .allocator = a, .health = health, .backend = backend, .config = config };
    }
    pub fn deinit(self: *Client) void {
        self.reset();
        self.operations.deinit(self.allocator);
        self.occurrences.deinit(self.allocator);
    }
    pub fn beginPass(self: *Client, cancel: ?*const std.atomic.Value(bool), started: ?std.time.Instant) !void {
        if (self.in_pass) return error.GrpcPassAlreadyActive;
        if (cancel) |flag| if (flag.load(.acquire)) {
            self.reset();
            return error.RequestCancelled;
        };
        self.in_pass = true;
        self.cancel = cancel;
        self.shared_started = started;
        self.occurrences.clearRetainingCapacity();
    }
    pub fn endPass(self: *Client, failure: ?anyerror) void {
        self.in_pass = false;
        self.cancel = null;
        if (failure) |err| if (err == error.PendingReadIo) return;
        self.reset();
    }
    pub fn hasPending(self: *Client) bool {
        for (self.operations.items) |op| if (op.phase != .complete) return true;
        return false;
    }
    pub fn commitReadSection(self: *Client) !void {
        if (self.hasPending()) return error.PendingReadSection;
        self.clear();
        self.occurrences.clearRetainingCapacity();
    }
    fn clear(self: *Client) void {
        for (self.operations.items) |op| op.deinit(self);
        self.operations.clearRetainingCapacity();
    }
    fn reset(self: *Client) void {
        self.clear();
        self.occurrences.clearRetainingCapacity();
        self.in_pass = false;
        self.cancel = null;
        self.shared_started = null;
    }
    fn create(self: *Client, key: [32]u8, occurrence: u32) !*Op {
        const metadata_bytes = @sizeOf(Op) + 128 + self.health.priorities.len * @sizeOf(Snapshot);
        if (self.config.budget) |budget| try budget.reserve(metadata_bytes);
        errdefer if (self.config.budget) |budget| budget.release(metadata_bytes);
        const priorities = try self.health.snapshot(self.allocator);
        errdefer self.allocator.free(priorities);
        const op = try self.allocator.create(Op);
        errdefer self.allocator.destroy(op);
        op.* = .{ .key = key, .occurrence = occurrence, .priorities = priorities, .started_ns = self.health.now(), .metadata_bytes = metadata_bytes };
        if (self.config.cooperative) {
            if (self.config.runtime) |runtime| op.replay = try Http.Replay.init(self.allocator, runtime, .{ .shared_budget = self.config.budget, .recorder = self.config.recorder, .max_request_bytes = grpc.max_message_bytes + 5, .max_attempt_ms = self.config.max_attempt_ms });
        }
        return op;
    }
    pub fn call(self: *Client, a: A, request: grpc.Request) !grpc.Response {
        try grpc.validateMethod(request.method);
        if (request.protobuf.len > grpc.max_message_bytes or request.timeout_ms == 0) return error.InvalidGrpcRequest;
        if (request.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (!self.config.cooperative) {
            const op = try self.create(@splat(0), 0);
            defer op.deinit(self);
            while (true) {
                self.advance(op, request) catch |err| {
                    if (err != error.PendingReadIo) return err;
                    // External read-vote capture owns its continuation. Never
                    // sleep/retry a PendingReadIo returned by that transport.
                    if (op.phase != .retry) return err;
                    if (request.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
                    std.Thread.sleep(std.time.ns_per_ms);
                    continue;
                };
                return clone(a, op.outcome.?);
            }
        }
        if (!self.in_pass) return error.GrpcPassNotActive;
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const key = requestKey(request);
        const slot = try self.occurrences.getOrPut(self.allocator, key);
        if (!slot.found_existing) slot.value_ptr.* = 0;
        const occurrence = slot.value_ptr.*;
        slot.value_ptr.* = try std.math.add(u32, occurrence, 1);
        for (self.operations.items) |op| if (op.occurrence == occurrence and std.mem.eql(u8, &op.key, &key)) {
            try self.advance(op, request);
            return clone(a, op.outcome.?);
        };
        if (self.operations.items.len >= 512) return error.GrpcOperationLimit;
        try self.operations.ensureUnusedCapacity(self.allocator, 1);
        const op = try self.create(key, occurrence);
        self.operations.appendAssumeCapacity(op);
        try self.advance(op, request);
        return clone(a, op.outcome.?);
    }
    fn raw(self: *Client, op: *Op, index: usize, request: grpc.Request) !grpc.Response {
        if (op.replay) |*replay| try replay.beginPass(self.cancel, self.shared_started);
        var failure: ?anyerror = null;
        defer if (op.replay) |*replay| replay.endPass(failure);
        return self.backend.call_fn(self.backend.context, self.allocator, index, request, if (op.replay) |*replay| replay else null) catch |err| {
            failure = err;
            return err;
        };
    }
    fn failedAttempt(self: *Client, op: *Op, err: anyerror) void {
        if (op.probe) |probe| {
            self.health.releaseProbe(probe.index, null);
            op.probe = null;
        }
        if (op.replay) |*replay| replay.reset();
        if (op.outcome) |*response| response.deinit();
        op.outcome = null;
        if (self.config.budget) |budget| budget.release(op.bytes);
        op.bytes = 0;
        self.health.failed(op.priorities[op.cursor]);
        op.last_error = err;
        op.errors += 1;
        op.cursor += 1;
        op.provider_deadline = 0;
        if (op.cursor == op.priorities.len) {
            if (op.errors > 3) {
                op.phase = .complete;
                op.failure = err;
            } else {
                op.phase = .retry;
                op.retry_at = self.health.now() +| @as(u64, self.config.retry_ms) * std.time.ns_per_ms;
            }
        } else op.phase = .request;
    }
    fn check(self: *Client, op: *Op, request: grpc.Request) !void {
        if (self.cancel orelse request.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.health.now() -| op.started_ns >= @as(u64, self.config.max_attempt_ms) * std.time.ns_per_ms) return error.RequestDeadlineExceeded;
    }
    fn advance(self: *Client, op: *Op, requested: grpc.Request) anyerror!void {
        while (true) {
            try self.check(op, requested);
            switch (op.phase) {
                .complete => {
                    if (op.failure) |err| return err;
                    return;
                },
                .retry => {
                    if (self.health.now() < op.retry_at) return error.PendingReadIo;
                    const priorities = try self.health.snapshot(self.allocator);
                    self.allocator.free(op.priorities);
                    op.priorities = priorities;
                    op.cursor = 0;
                    op.phase = .request;
                },
                .request, .probe => {
                    const now = self.health.now();
                    if (op.provider_deadline == 0) op.provider_deadline = now +| @as(u64, @min(self.config.provider_timeout_ms, requested.timeout_ms)) * std.time.ns_per_ms;
                    if (now >= op.provider_deadline) {
                        self.failedAttempt(op, error.GrpcProviderDeadline);
                        continue;
                    }
                    var request = requested;
                    request.cancel = self.cancel orelse requested.cancel;
                    request.timeout_ms = @intCast(@min((op.provider_deadline - now + std.time.ns_per_ms - 1) / std.time.ns_per_ms, std.math.maxInt(u32)));
                    if (op.phase == .request) {
                        op.outcome = self.raw(op, op.priorities[op.cursor].index, request) catch |err| {
                            if (control(err) or (self.config.cooperative and err == error.RequestDeadlineExceeded)) return err;
                            self.failedAttempt(op, err);
                            continue;
                        };
                        if (self.config.budget) |budget| budget.reserve(op.outcome.?.protobuf.len) catch |err| {
                            op.outcome.?.deinit();
                            op.outcome = null;
                            op.phase = .complete;
                            op.failure = err;
                            return err;
                        };
                        op.bytes = op.outcome.?.protobuf.len;
                        op.probe = self.health.acquireProbe(op.priorities[op.cursor], @as(u64, self.config.max_block_time_ms) * std.time.ns_per_ms);
                        op.phase = if (op.probe != null) .probe else .complete;
                    } else {
                        request.method = proto.paths.latest_validators;
                        request.protobuf = "";
                        request.height = null;
                        var probe_response = self.raw(op, op.probe.?.index, request) catch |err| {
                            if (control(err) or (self.config.cooperative and err == error.RequestDeadlineExceeded)) return err;
                            if (err == error.RequestDeadlineExceeded or err == error.UpstreamReadTimeout or err == error.GrpcProviderDeadline) {
                                self.failedAttempt(op, err);
                                continue;
                            }
                            self.health.releaseProbe(op.probe.?.index, op.probe.?.height);
                            op.probe = null;
                            op.phase = .complete;
                            continue;
                        };
                        defer probe_response.deinit();
                        const height = proto.latestValidatorHeight(probe_response.protobuf) catch op.probe.?.height;
                        self.health.releaseProbe(op.probe.?.index, height);
                        op.probe = null;
                        op.phase = .complete;
                    }
                },
            }
        }
    }
};
fn control(err: anyerror) bool {
    return switch (err) {
        error.PendingReadIo, error.PendingIo, error.RequestCancelled, error.Cancelled, error.OutOfMemory, error.ReadReplayGlobalByteBudgetExceeded, error.ReadReplayByteBudgetExceeded, error.ReadReplayRequestLimit, error.HttpRuntimeStopped, error.HttpRuntimeFailed, error.InvalidHttpHandle => true,
        else => false,
    };
}
fn clone(a: A, response: grpc.Response) !grpc.Response {
    return .{ .allocator = a, .protobuf = try a.dupe(u8, response.protobuf), .height = response.height };
}
fn requestKey(request: grpc.Request) [32]u8 {
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update(request.method);
    h.update(&.{0});
    h.update(request.protobuf);
    var number: [9]u8 = @splat(0);
    if (request.height) |height| {
        number[0] = 1;
        std.mem.writeInt(u64, number[1..], height, .big);
    }
    h.update(&number);
    return h.finalResult();
}

const Fake = struct {
    time: u64 = 0,
    bad: [4]bool = @splat(false),
    calls: [4]usize = @splat(0),
    probes: [4]usize = @splat(0),
    pending: [4]bool = @splat(false),
    yield_reads: bool = false,
    yield_probe: bool = false,
    probe_pending: bool = false,
    probe_error: ?anyerror = null,
    probe_height: u8 = 123,
    fn now(ctx: *anyopaque) u64 {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        return self.time;
    }
    fn call(ctx: *anyopaque, a: A, index: usize, request: grpc.Request, _: ?*Http.Replay) !grpc.Response {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        const probe = std.mem.eql(u8, request.method, proto.paths.latest_validators);
        if (probe) {
            if (self.yield_probe and !self.probe_pending) {
                self.probe_pending = true;
                return error.PendingReadIo;
            }
            self.probes[index] += 1;
            if (self.probe_error) |err| return err;
            return .{ .allocator = a, .protobuf = try a.dupe(u8, &.{ 8, self.probe_height }) };
        }
        if (self.yield_reads and !self.pending[index]) {
            self.pending[index] = true;
            return error.PendingReadIo;
        }
        self.pending[index] = false;
        self.calls[index] += 1;
        if (self.bad[index]) return error.GrpcHttpStatus;
        return .{ .allocator = a, .protobuf = try a.dupe(u8, &.{ 8, @intCast(self.calls[index]) }), .height = request.height };
    }
    fn clock(self: *Fake) Clock {
        return .{ .context = self, .now_fn = now };
    }
    fn backend(self: *Fake) Backend {
        return .{ .context = self, .call_fn = call };
    }
};
const test_request: grpc.Request = .{ .method = proto.paths.mailbox, .protobuf = &.{ 8, 1 }, .height = 100 };
test "gRPC fallback retries full snapshots until at least four errors with cooperative100ms rounds" {
    const a = std.testing.allocator;
    var fake: Fake = .{ .bad = .{ true, true, false, false } };
    var health = try Health.init(a, 2, fake.clock());
    defer health.deinit();
    var client = try Client.init(a, &health, fake.backend(), .{ .cooperative = true });
    defer client.deinit();
    try client.beginPass(null, null);
    try std.testing.expectError(error.PendingReadIo, client.call(a, test_request));
    client.endPass(error.PendingReadIo);
    try std.testing.expectEqualSlices(usize, &.{ 1, 1 }, fake.calls[0..2]);
    try std.testing.expectEqual(@as(u32, 1), health.priorities[0].failed);
    try client.beginPass(null, null);
    try std.testing.expectError(error.PendingReadIo, client.call(a, test_request));
    client.endPass(error.PendingReadIo);
    try std.testing.expectEqualSlices(usize, &.{ 1, 1 }, fake.calls[0..2]);
    fake.time = 101 * std.time.ns_per_ms;
    try client.beginPass(null, null);
    try std.testing.expectError(error.GrpcHttpStatus, client.call(a, test_request));
    try std.testing.expectEqualSlices(usize, &.{ 2, 2 }, fake.calls[0..2]);
    try std.testing.expectEqual(@as(u32, 2), health.priorities[0].failed);
    client.endPass(error.GrpcHttpStatus);
}
test "gRPC typed continuations keep identical before after calls physically distinct and memoize completed prefix once" {
    const a = std.testing.allocator;
    var fake: Fake = .{ .yield_reads = true };
    var health = try Health.init(a, 1, fake.clock());
    defer health.deinit();
    var budget: Budget = .{ .maximum = 4096 };
    var client = try Client.init(a, &health, fake.backend(), .{ .cooperative = true, .budget = &budget });
    defer client.deinit();
    var first: u64 = 0;
    var last: u64 = 0;
    var passes: usize = 0;
    while (true) {
        try client.beginPass(null, null);
        var before = client.call(a, test_request) catch |err| {
            client.endPass(err);
            if (err != error.PendingReadIo) return err;
            passes += 1;
            continue;
        };
        first = try proto.uintField(before.protobuf, 1);
        before.deinit();
        var after = client.call(a, test_request) catch |err| {
            client.endPass(err);
            if (err != error.PendingReadIo) return err;
            passes += 1;
            continue;
        };
        last = try proto.uintField(after.protobuf, 1);
        after.deinit();
        try client.commitReadSection();
        client.endPass(null);
        break;
    }
    try std.testing.expectEqual(@as(usize, 2), passes);
    try std.testing.expectEqual(@as(u64, 1), first);
    try std.testing.expectEqual(@as(u64, 2), last);
    try std.testing.expectEqual(@as(usize, 2), fake.calls[0]);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}
test "gRPC shared height probe is serialized across fork clients and late result retains original query height" {
    const a = std.testing.allocator;
    var fake: Fake = .{ .yield_probe = true };
    var health = try Health.init(a, 2, fake.clock());
    defer health.deinit();
    fake.time = 120001 * std.time.ns_per_ms;
    var client = try Client.init(a, &health, fake.backend(), .{ .cooperative = true });
    defer client.deinit();
    var other = try Client.init(a, &health, fake.backend(), .{ .cooperative = true });
    defer other.deinit();
    try client.beginPass(null, null);
    try std.testing.expectError(error.PendingReadIo, client.call(a, test_request));
    client.endPass(error.PendingReadIo);
    try std.testing.expect(health.probing[0]);
    try other.beginPass(null, null);
    var parallel_response = try other.call(a, test_request);
    defer parallel_response.deinit();
    other.endPass(null);
    try std.testing.expectEqual(@as(?u64, 100), parallel_response.height);
    try client.beginPass(null, null);
    var response = try client.call(a, test_request);
    defer response.deinit();
    client.endPass(null);
    try std.testing.expectEqual(@as(?u64, 100), response.height);
    try std.testing.expectEqual(@as(usize, 1), fake.probes[0]);
    try std.testing.expectEqual(@as(u64, 123), health.priorities[0].height);
    try std.testing.expect(!health.probing[0]);
}
test "gRPC health10failures reprioritize subsequent snapshots while single endpoint never probes" {
    const a = std.testing.allocator;
    var fake: Fake = .{ .bad = .{ true, false, false, false } };
    var health = try Health.init(a, 2, fake.clock());
    defer health.deinit();
    var client = try Client.init(a, &health, fake.backend(), .{});
    defer client.deinit();
    for (0..11) |_| {
        var response = try client.call(a, test_request);
        response.deinit();
    }
    try std.testing.expectEqual(@as(usize, 10), fake.calls[0]);
    try std.testing.expectEqual(@as(usize, 11), fake.calls[1]);
    try std.testing.expectEqual(@as(usize, 1), health.priorities[0].index);
    var single = try Health.init(a, 1, fake.clock());
    defer single.deinit();
    fake.bad[0] = false;
    fake.time = 120001 * std.time.ns_per_ms;
    var only = try Client.init(a, &single, fake.backend(), .{});
    defer only.deinit();
    var response = try only.call(a, test_request);
    defer response.deinit();
    try std.testing.expectEqual(@as(usize, 0), fake.probes[0]);
}
test "gRPC probe timeout rotates without publishing stale success and cancellation releases shared probe lock" {
    const a = std.testing.allocator;
    var fake: Fake = .{ .probe_error = error.UpstreamReadTimeout };
    var health = try Health.init(a, 2, fake.clock());
    defer health.deinit();
    fake.time = 120001 * std.time.ns_per_ms;
    // Endpoint1 was freshly observed; endpoint0's probe times out, so only1's
    // original result may escape. Query0's already owned response is discarded.
    health.priorities[1].seen = fake.time;
    var budget: Budget = .{ .maximum = 4096 };
    var client = try Client.init(a, &health, fake.backend(), .{ .cooperative = true, .budget = &budget });
    defer client.deinit();
    try client.beginPass(null, null);
    var response = try client.call(a, test_request);
    defer response.deinit();
    client.endPass(null);
    try std.testing.expectEqual(@as(usize, 1), fake.calls[1]);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try std.testing.expect(!health.probing[0]);
    fake.yield_probe = true;
    fake.probe_pending = false;
    fake.probe_error = null;
    health.priorities[0].seen = 0;
    try client.beginPass(null, null);
    try std.testing.expectError(error.PendingReadIo, client.call(a, test_request));
    client.endPass(error.PendingReadIo);
    try std.testing.expect(health.probing[0]);
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, client.beginPass(&cancel, null));
    try std.testing.expect(!health.probing[0]);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}

fn allocations(a: A) !void {
    var fake: Fake = .{ .bad = .{ true, false, false, false }, .yield_reads = true };
    var health = try Health.init(a, 2, fake.clock());
    defer health.deinit();
    var budget: Budget = .{ .maximum = 8192 };
    var client = try Client.init(a, &health, fake.backend(), .{ .cooperative = true, .budget = &budget });
    defer {
        client.deinit();
        std.debug.assert(budget.used == 0);
    }
    while (true) {
        try client.beginPass(null, null);
        var response = client.call(a, test_request) catch |err| {
            client.endPass(err);
            if (err != error.PendingReadIo) return err;
            continue;
        };
        response.deinit();
        try client.commitReadSection();
        client.endPass(null);
        break;
    }
}
test "gRPC fallback releases shared quota snapshots outcomes and probe locks on every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocations, .{});
}
test "gRPC direct vote capture propagates control without retry or poisoning endpoint health" {
    const a = std.testing.allocator;
    var fake: Fake = .{ .yield_reads = true };
    var health = try Health.init(a, 1, fake.clock());
    defer health.deinit();
    var client = try Client.init(a, &health, fake.backend(), .{});
    defer client.deinit();
    try std.testing.expectError(error.PendingReadIo, client.call(a, test_request));
    try std.testing.expectEqual(@as(u32, 0), health.priorities[0].failed);
    var response = try client.call(a, test_request);
    defer response.deinit();
    try std.testing.expectEqual(@as(usize, 1), fake.calls[0]);
}
