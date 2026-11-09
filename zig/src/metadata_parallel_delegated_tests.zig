const std = @import("std");
const metadata = @import("relayer/metadata.zig");
const parallel = @import("relayer/metadata_parallel.zig");
const protocol = @import("protocol/root.zig");
const objects = @import("storage/objects.zig");
const evm = @import("evm/root.zig");
const evm_source = @import("relayer/evm_source.zig");
const Pool = @import("evm/pool.zig").Pool;
const pool_fixture = @import("evm/pool_testing.zig");
const ccip = @import("relayer/ccip.zig");
const observability = @import("ops/validator_observability.zig");
const metrics = @import("ops/metrics.zig");
const contract_cache = @import("relayer/contract_cache.zig");
const cached_source = @import("relayer/cached_source.zig");

const A = std.mem.Allocator;
const Address = [20]u8;
const ClockSource = evm_source.Source(evm_source.LocalOrigin);
const ClockCached = cached_source.CachedSource(ClockSource);

const Fixture = struct {
    child_count: usize = 16,
    threshold: usize = 8,
    stall_first: usize = 0,
    stall_enabled: std.atomic.Value(bool) = .init(true),
    ready: [256]std.atomic.Value(bool) = @splat(.init(false)),
    module_calls: [256]std.atomic.Value(usize) = @splat(.init(0)),
    forks: std.atomic.Value(usize) = .init(0),
    retired: std.atomic.Value(usize) = .init(0),
    active: std.atomic.Value(usize) = .init(0),
    max_active: std.atomic.Value(usize) = .init(0),
    refusal_index: ?usize = null,
    invalid_verify: ?usize = null,
    unpriced: bool = false,
    message_id_index: ?usize = null,
    pending_from: ?usize = null,
    awaiting_message_id: bool = false,
    signed: ?objects.SignedCheckpoint = null,
    validator: Address = @splat(1),
    validator_count: usize = 1,
    nested_first: usize = 0,
    nested_children: usize = 8,
    nested_threshold: usize = 0,
    pending_verify: bool = false,
    verify_ready: [256]std.atomic.Value(bool) = @splat(.init(false)),
    latest_calls: std.atomic.Value(usize) = .init(0),
    pending_latest_once: bool = false,
    latest_ready: std.atomic.Value(bool) = .init(false),
    latest_error: ?anyerror = null,
    latest_always_pending: bool = false,
    latest_complete_after_stop: bool = false,
    latest_stop_expired: std.atomic.Value(bool) = .init(false),
    pending_checkpoint_once: bool = false,
    checkpoint_ready: std.atomic.Value(bool) = .init(false),
    pending_checkpoint_passes: usize = 0,
    checkpoint_calls: std.atomic.Value(usize) = .init(0),
    pending_verify_index: ?usize = null,
    pending_verify_passes: usize = 0,
    verify_calls: std.atomic.Value(usize) = .init(0),
    expected_observation_cancel: ?*const std.atomic.Value(bool) = null,
    observation_cancel_matched: std.atomic.Value(bool) = .init(false),
    observation_cancel_initially_false: std.atomic.Value(bool) = .init(false),
    observation_fork_error: ?anyerror = null,
    default_ism: Address = @splat(0),
    default_calls: std.atomic.Value(usize) = .init(0),
    pending_default_once: bool = false,
    default_ready: std.atomic.Value(bool) = .init(false),
    default_error: ?anyerror = null,
    message_id_kind: metadata.ModuleType = .message_id_multisig,
    proof_error: ?anyerror = null,
    ccip_error: ?anyerror = error.CcipReadPending,
    pending_ccip_once: bool = false,
    ccip_ready: std.atomic.Value(bool) = .init(false),
    clock_child: bool = false,
    late_ccip_child: bool = false,
    clock_entered: std.atomic.Value(bool) = .init(false),
    clock_release: std.atomic.Value(bool) = .init(false),
    clock_expired: std.atomic.Value(bool) = .init(false),
    clock_reads: std.atomic.Value(usize) = .init(0),

    fn release(self: *Fixture) void {
        self.stall_enabled.store(false, .release);
        for (0..self.stall_first) |index| self.ready[index].store(true, .release);
    }
};

const Source = struct {
    pub const parallel_quorum = false;
    pub const parallel_latest = false;
    allocator: A,
    fixture: *Fixture,
    cancel: *const std.atomic.Value(bool),
    clock_source: ?*ClockCached = null,

    pub fn fork(self: *const Source, allocator: A, cancel: *const std.atomic.Value(bool)) !*Source {
        if (self.fixture.expected_observation_cancel) |expected| if (cancel == expected) {
            self.fixture.observation_cancel_matched.store(true, .release);
            self.fixture.observation_cancel_initially_false.store(!cancel.load(.acquire), .release);
            if (self.fixture.observation_fork_error) |err| return err;
        };
        const result = try allocator.create(Source);
        errdefer allocator.destroy(result);
        const clock_source = if (self.clock_source) |value| try value.fork(allocator, cancel) else null;
        errdefer if (clock_source) |value| value.deinitFork();
        result.* = .{ .allocator = allocator, .fixture = self.fixture, .cancel = cancel, .clock_source = clock_source };
        const count = self.fixture.forks.fetchAdd(1, .acq_rel) + 1;
        errdefer _ = self.fixture.forks.fetchSub(1, .acq_rel);
        if ((self.fixture.clock_child or self.fixture.late_ccip_child) and count == 4) {
            // Ensure the intentionally uncancellable child already runs on a
            // worker before the caller can assist any queued job itself.
            var timer = try std.time.Timer.start();
            while (!self.fixture.clock_entered.load(.acquire)) {
                if (timer.read() > 5 * std.time.ns_per_s) return error.ClockChildNeverStarted;
                std.Thread.sleep(std.time.ns_per_ms);
            }
        }
        return result;
    }

    pub fn deinitFork(self: *Source) void {
        const allocator = self.allocator;
        if (self.clock_source) |value| value.deinitFork();
        _ = self.fixture.retired.fetchAdd(1, .acq_rel);
        allocator.destroy(self);
    }

    fn nested(fixture: *Fixture, address: Address) bool {
        return address[19] > 0 and address[19] <= fixture.nested_first;
    }

    pub fn moduleType(self: *Source, address: Address) !metadata.ModuleType {
        if (address[19] == 0) return .aggregation;
        if (nested(self.fixture, address)) return .aggregation;
        const index: usize = address[19] - 1;
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        if (self.fixture.clock_child and index == 2) {
            _ = try self.clock_source.?.defaultIsm();
            return .null_ism;
        }
        if (self.fixture.late_ccip_child and index == 2) return .ccip_read;
        const active = self.fixture.active.fetchAdd(1, .acq_rel) + 1;
        defer _ = self.fixture.active.fetchSub(1, .acq_rel);
        var maximum = self.fixture.max_active.load(.acquire);
        while (active > maximum) {
            if (self.fixture.max_active.cmpxchgWeak(maximum, active, .acq_rel, .acquire)) |actual| maximum = actual else break;
        }
        if (index < self.fixture.stall_first and self.fixture.stall_enabled.load(.acquire) and self.fixture.message_id_index != index and !self.fixture.ready[index].load(.acquire)) return error.PendingReadIo;
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        _ = self.fixture.module_calls[index].fetchAdd(1, .acq_rel);
        if (self.fixture.refusal_index == index) return error.MessageMetadataRefused;
        if (self.fixture.pending_from) |from| if (index >= from) return .ccip_read;
        if (self.fixture.message_id_index == index) return self.fixture.message_id_kind;
        return .null_ism;
    }

    pub fn route(_: *Source, _: Address, _: protocol.Message) !Address {
        return error.UnexpectedRoute;
    }

    pub fn defaultIsm(self: *Source) !Address {
        _ = self.fixture.default_calls.fetchAdd(1, .acq_rel);
        if (self.fixture.pending_default_once and !self.fixture.default_ready.swap(true, .acq_rel)) return error.PendingReadIo;
        if (self.fixture.default_error) |err| return err;
        return self.fixture.default_ism;
    }

    pub fn members(self: *Source, address: Address, _: protocol.Message, validators: bool) !metadata.Members {
        if (validators) {
            const addresses = try self.allocator.alloc(Address, self.fixture.validator_count);
            addresses[0] = self.fixture.validator;
            for (addresses[1..], 1..) |*validator_address, index| {
                validator_address.* = @splat(0);
                validator_address.*[19] = @intCast(index + 1);
            }
            return .{ .addresses = addresses, .threshold = 1 };
        }
        const nested_member = nested(self.fixture, address);
        const count = if (nested_member) self.fixture.nested_children else self.fixture.child_count;
        const addresses = try self.allocator.alloc(Address, count);
        for (addresses, 0..) |*child, index| {
            child.* = @splat(0);
            if (nested_member) {
                const base: usize = 32 + (@as(usize, address[19]) - 1) * self.fixture.nested_children;
                child.*[19] = @intCast(base + index + 1);
            } else child.*[19] = @intCast(index + 1);
        }
        return .{ .addresses = addresses, .threshold = if (nested_member) (if (self.fixture.nested_threshold == 0) self.fixture.nested_children else self.fixture.nested_threshold) else self.fixture.threshold };
    }

    pub fn verifyCandidate(self: *Source, address: Address, _: protocol.Message, _: []const u8) !metadata.Verification {
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        const index: usize = address[19] - 1;
        if (self.fixture.pending_verify_index == index and self.fixture.verify_calls.fetchAdd(1, .acq_rel) < self.fixture.pending_verify_passes) return error.PendingReadIo;
        if (self.fixture.pending_verify and !self.fixture.verify_ready[index].swap(true, .acq_rel)) return error.PendingReadIo;
        if (self.fixture.invalid_verify == index) return .{ .valid = false };
        return .{ .valid = true, .cost = if (self.fixture.unpriced) null else 1000 - @as(u256, index) };
    }

    pub fn ccipMetadata(self: *Source, address: Address, _: protocol.Message) ![]u8 {
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        if (self.fixture.late_ccip_child and address[19] == 3) {
            self.fixture.clock_entered.store(true, .release);
            var timer = try std.time.Timer.start();
            while (!self.fixture.clock_release.load(.acquire)) {
                if (timer.read() > 5 * std.time.ns_per_s) {
                    self.fixture.clock_expired.store(true, .release);
                    return error.LateLeafReleaseTimeout;
                }
                std.Thread.sleep(std.time.ns_per_ms);
            }
            return self.allocator.alloc(u8, 0);
        }
        if (self.fixture.pending_ccip_once and !self.fixture.ccip_ready.swap(true, .acq_rel)) return error.PendingReadIo;
        if (self.fixture.ccip_error) |err| return err;
        return self.allocator.alloc(u8, 0);
    }

    pub fn leafIndex(self: *Source, _: [32]u8) !?u32 {
        if (self.fixture.awaiting_message_id) return error.AwaitingValidatorSignatures;
        return 0;
    }

    pub fn highestKnownLeafIndex(_: *Source) !?u32 {
        return 0;
    }

    pub fn fetchCheckpoint(self: *Source, _: Address, _: u32) !?objects.SignedCheckpoint {
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        if (self.fixture.checkpoint_calls.fetchAdd(1, .acq_rel) < self.fixture.pending_checkpoint_passes) return error.PendingReadIo;
        if (self.fixture.pending_checkpoint_once and !self.fixture.checkpoint_ready.swap(true, .acq_rel)) return error.PendingReadIo;
        return self.fixture.signed;
    }

    pub fn latestIndex(_: *Source, _: Address) !?u32 {
        return 0;
    }

    pub fn fetchLatestIndices(self: *Source, validators: []const Address, output: []?u32, _: *usize) !void {
        if (validators.len != output.len) return error.InvalidLatestIndicesLength;
        _ = self.fixture.latest_calls.fetchAdd(1, .acq_rel);
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        if (self.fixture.latest_complete_after_stop) {
            const deadline = std.time.nanoTimestamp() + 5 * std.time.ns_per_s;
            while (!self.cancel.load(.acquire)) {
                if (std.time.nanoTimestamp() >= deadline) {
                    self.fixture.latest_stop_expired.store(true, .release);
                    return error.FixtureStopTimeout;
                }
                std.Thread.sleep(std.time.ns_per_ms);
            }
            // Deliberately model a read which completes successfully after its
            // transport could no longer abort. The owner must reject late data.
        }
        if (self.fixture.latest_always_pending) return error.PendingReadIo;
        if (self.fixture.pending_latest_once and !self.fixture.latest_ready.swap(true, .acq_rel)) return error.PendingReadIo;
        if (self.fixture.latest_error) |err| return err;
        @memset(output, 0);
    }

    pub fn proof(self: *Source, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return self.fixture.proof_error orelse error.NoProof;
    }
};

fn message() protocol.Message {
    return .{ .version = 3, .origin = 1, .destination = 2, .sender = @splat(3), .recipient = @splat(4), .body = "parallel-message" };
}

fn drain(root: *parallel.Root, fixture: *Fixture) !void {
    var timer = try std.time.Timer.start();
    while (root.executor.retainedJobs() != 0 or fixture.forks.load(.acquire) != fixture.retired.load(.acquire)) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.FixtureRetirementTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedOutputBytes());
}

fn expectSelection(bytes: []const u8, count: usize, present: []const usize) !void {
    const decoded = try protocol.metadata.Aggregation.decode(bytes, count);
    for (0..count) |index| {
        const expected = std.mem.indexOfScalar(usize, present, index) != null;
        const actual = try decoded.metadataAt(index);
        try std.testing.expectEqual(expected, actual != null);
        if (expected and actual != null) try std.testing.expectEqual(@as(usize, 0), actual.?.len);
    }
}

fn postLater(fixture: *Fixture, index: usize) void {
    std.Thread.sleep(25 * std.time.ns_per_ms);
    fixture.ready[index].store(true, .release);
}

test "parallel threshold returns with eight stalled peers and later builds are independent" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var fixture: Fixture = .{ .stall_first = 8 };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const body = try allocator.dupe(u8, "owned-by-caller");
    var input = message();
    input.body = body;
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    var present: [8]usize = undefined;
    for (&present, 8..16) |*slot, index| slot.* = index;
    try expectSelection(encoded, 16, &present);
    allocator.free(body);

    fixture.release();
    try drain(root, &fixture);
    input.body = "second-build";
    const second = try builder.build(@splat(0), input);
    defer allocator.free(second);
    try drain(root, &fixture);
}

test "failed verification does not reach threshold" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var fixture: Fixture = .{ .stall_first = 8, .invalid_verify = 8 };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const releaser = try std.Thread.spawn(.{}, postLater, .{ &fixture, 0 });
    const encoded = try builder.build(@splat(0), message());
    releaser.join();
    defer allocator.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 16);
    try std.testing.expect((try decoded.metadataAt(0)) != null);
    try std.testing.expect((try decoded.metadataAt(8)) == null);
    try std.testing.expectEqual(@as(usize, 1), builder.diagnostics.verification_failures);
    fixture.release();
    try drain(root, &fixture);
}

test "first observed refusal wins but a cancelled late refusal cannot veto" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var cancel = std.atomic.Value(bool).init(false);

    // Keep fewer than threshold valid children ready until the refusal is
    // observed. Thread scheduling must not manufacture the expected arrival.
    var immediate: Fixture = .{ .threshold = 2, .stall_first = 16, .refusal_index = 9 };
    immediate.ready[8].store(true, .release);
    immediate.ready[9].store(true, .release);
    var immediate_source: Source = .{ .allocator = allocator, .fixture = &immediate, .cancel = &cancel };
    var immediate_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &immediate_source, .executor = &root.executor };
    try std.testing.expectError(error.MessageMetadataRefused, immediate_builder.build(@splat(0), message()));
    immediate.release();
    try drain(root, &immediate);

    var late: Fixture = .{ .threshold = 2, .stall_first = 16, .refusal_index = 0 };
    late.ready[8].store(true, .release);
    late.ready[9].store(true, .release);
    var late_source: Source = .{ .allocator = allocator, .fixture = &late, .cancel = &cancel };
    var late_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &late_source, .executor = &root.executor };
    const encoded = try late_builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try expectSelection(encoded, 16, &.{ 8, 9 });
    late.release();
    try drain(root, &late);
    late.stall_enabled.store(true, .release);
    for (&late.ready) |*ready| ready.store(false, .release);
    late.ready[0].store(true, .release);
    try std.testing.expectError(error.MessageMetadataRefused, late_builder.build(@splat(0), message()));
    late.release();
    try drain(root, &late);
}

test "unpriced valid candidates preserve arrival set and index order without fake zero gas" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var fixture: Fixture = .{ .threshold = 2, .stall_first = 8, .unpriced = true };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 16);
    for (0..8) |index| try std.testing.expect((try decoded.metadataAt(index)) == null);
    var selected: usize = 0;
    for (8..16) |index| if ((try decoded.metadataAt(index)) != null) {
        selected += 1;
    };
    try std.testing.expectEqual(@as(usize, 2), selected);
    fixture.release();
    try drain(root, &fixture);
}

test "parallel CCIP pending is terminal only after unmet threshold" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var cancel = std.atomic.Value(bool).init(false);

    var pending: Fixture = .{ .child_count = 2, .threshold = 1, .invalid_verify = 0, .pending_from = 1 };
    var pending_source: Source = .{ .allocator = allocator, .fixture = &pending, .cancel = &cancel };
    var pending_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &pending_source, .executor = &root.executor };
    try std.testing.expectError(error.CcipReadPending, pending_builder.build(@splat(0), message()));
    try drain(root, &pending);

    var refusal: Fixture = .{ .child_count = 2, .threshold = 1, .refusal_index = 0, .pending_from = 1 };
    var refusal_source: Source = .{ .allocator = allocator, .fixture = &refusal, .cancel = &cancel };
    var refusal_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &refusal_source, .executor = &root.executor };
    try std.testing.expectError(error.MessageMetadataRefused, refusal_builder.build(@splat(0), message()));
    try drain(root, &refusal);

    var healthy: Fixture = .{ .child_count = 2, .threshold = 1, .pending_from = 1 };
    var healthy_source: Source = .{ .allocator = allocator, .fixture = &healthy, .cancel = &cancel };
    var healthy_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &healthy_source, .executor = &root.executor };
    const encoded = try healthy_builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try expectSelection(encoded, 2, &.{0});
    try drain(root, &healthy);
}

fn signedCheckpoint(input: protocol.Message, key: [32]u8) !objects.SignedCheckpoint {
    return objects.SignedCheckpoint.sign(.{
        .mailbox_domain = input.origin,
        .merkle_tree_hook_address = @splat(9),
        .root = @splat(7),
        .index = 0,
        .message_id = input.id(),
    }, key, null);
}

const RecordingObserver = struct {
    const LeafEvent = struct { kind: metadata.ModuleType, success: bool };
    mutex: std.Thread.Mutex = .{},
    calls: usize = 0,
    origin: u32 = 0,
    destination: u32 = 0,
    app_context: []const u8 = "",
    app_storage: [256]u8 = undefined,
    count: usize = 0,
    validators: [256]Address = undefined,
    latest_values: [256]?u32 = @splat(null),
    events: [128]LeafEvent = undefined,
    event_count: usize = 0,
    mismatch_calls: usize = 0,
    mismatch_origin: u32 = 0,

    fn observation(self: *RecordingObserver) metadata.Observation {
        return .{ .context = self, .latest_fn = latestValues, .leaf_complete_fn = leafComplete, .merkle_mismatch_fn = merkleMismatch };
    }

    fn copyAppContext(self: *RecordingObserver, app_context: []const u8) !void {
        if (app_context.len > self.app_storage.len) return error.ObservationAppContextTooLong;
        @memcpy(self.app_storage[0..app_context.len], app_context);
        self.app_context = self.app_storage[0..app_context.len];
    }

    fn latestValues(context: *anyopaque, origin: u32, destination: u32, app_context: []const u8, validators: []const Address, latest_values: []const ?u32) anyerror!void {
        const self: *RecordingObserver = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.calls += 1;
        self.origin = origin;
        self.destination = destination;
        try self.copyAppContext(app_context);
        self.count = validators.len;
        @memcpy(self.validators[0..validators.len], validators);
        @memcpy(self.latest_values[0..latest_values.len], latest_values);
    }

    fn leafComplete(context: *anyopaque, _: u32, _: u32, app_context: []const u8, ism_type: []const u8, success: bool) anyerror!void {
        const self: *RecordingObserver = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.event_count == self.events.len) return error.ObservationEventLimit;
        try self.copyAppContext(app_context);
        self.events[self.event_count] = .{ .kind = std.meta.stringToEnum(metadata.ModuleType, ism_type) orelse return error.UnknownObservedIsm, .success = success };
        self.event_count += 1;
    }

    fn merkleMismatch(context: *anyopaque, origin: u32) anyerror!void {
        const self: *RecordingObserver = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.mismatch_calls += 1;
        self.mismatch_origin = origin;
    }
};

fn expectLeafEvent(recorder: *const RecordingObserver, index: usize, kind: metadata.ModuleType, success: bool) !void {
    try std.testing.expect(index < recorder.event_count);
    try std.testing.expectEqual(kind, recorder.events[index].kind);
    try std.testing.expectEqual(success, recorder.events[index].success);
}

test "terminal multisig and CCIP observations exclude replay and cancellation" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    const validator = try protocol.signature.secretKeyAddress(key);
    var cancel = std.atomic.Value(bool).init(false);
    var recorder: RecordingObserver = .{};

    var rejected: Fixture = .{ .child_count = 2, .threshold = 2, .message_id_index = 0, .invalid_verify = 0, .signed = try signedCheckpoint(input, key), .validator = validator };
    var rejected_source: Source = .{ .allocator = allocator, .fixture = &rejected, .cancel = &cancel };
    var rejected_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &rejected_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    try std.testing.expectError(error.AggregationThresholdNotMet, rejected_builder.build(@splat(0), input));
    try drain(root, &rejected);
    try std.testing.expectEqual(@as(usize, 1), recorder.event_count);
    try expectLeafEvent(&recorder, 0, .message_id_multisig, true);

    var awaiting: Fixture = .{ .child_count = 1, .threshold = 1, .message_id_index = 0, .message_id_kind = .merkle_root_multisig, .awaiting_message_id = true };
    var awaiting_source: Source = .{ .allocator = allocator, .fixture = &awaiting, .cancel = &cancel };
    var awaiting_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &awaiting_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    try std.testing.expectError(error.AwaitingValidatorSignatures, awaiting_builder.build(@splat(0), input));
    try drain(root, &awaiting);
    try expectLeafEvent(&recorder, 1, .merkle_root_multisig, false);

    var pending: Fixture = .{ .child_count = 1, .threshold = 1, .pending_from = 0 };
    var pending_source: Source = .{ .allocator = allocator, .fixture = &pending, .cancel = &cancel };
    var pending_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &pending_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    try std.testing.expectError(error.CcipReadPending, pending_builder.build(@splat(0), input));
    try drain(root, &pending);
    try expectLeafEvent(&recorder, 2, .ccip_read, false);

    var replayed: Fixture = .{ .child_count = 1, .threshold = 1, .pending_from = 0, .ccip_error = null, .pending_ccip_once = true };
    var replayed_source: Source = .{ .allocator = allocator, .fixture = &replayed, .cancel = &cancel };
    var replayed_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &replayed_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const replayed_encoded = try replayed_builder.build(@splat(0), input);
    defer allocator.free(replayed_encoded);
    try drain(root, &replayed);
    try expectLeafEvent(&recorder, 3, .ccip_read, true);

    var cancelled: Fixture = .{ .child_count = 1, .threshold = 1, .pending_from = 0, .ccip_error = error.RequestCancelled };
    var cancelled_source: Source = .{ .allocator = allocator, .fixture = &cancelled, .cancel = &cancel };
    var cancelled_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &cancelled_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    try std.testing.expectError(error.RequestCancelled, cancelled_builder.build(@splat(0), input));
    try drain(root, &cancelled);
    try std.testing.expectEqual(@as(usize, 4), recorder.event_count);

    var mismatch: Fixture = .{ .child_count = 1, .threshold = 1, .message_id_index = 0, .message_id_kind = .merkle_root_multisig, .signed = try signedCheckpoint(input, key), .validator = validator, .proof_error = error.MerkleRootMismatch };
    var mismatch_source: Source = .{ .allocator = allocator, .fixture = &mismatch, .cancel = &cancel };
    var mismatch_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &mismatch_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    try std.testing.expectError(error.AggregationThresholdNotMet, mismatch_builder.build(@splat(0), input));
    try drain(root, &mismatch);
    try std.testing.expectEqual(@as(usize, 5), recorder.event_count);
    try expectLeafEvent(&recorder, 4, .merkle_root_multisig, false);
}

test "EVM proof observation latches only actual root mismatch" {
    const allocator = std.testing.allocator;
    const input = message();
    const leaves = [_][32]u8{input.id()};
    var tree = protocol.IncrementalMerkle.init();
    try tree.ingest(input.id());
    const checkpoint: protocol.Checkpoint = .{ .mailbox_domain = input.origin, .merkle_tree_hook_address = @splat(9), .root = tree.root(), .index = 0, .message_id = input.id() };
    var origin: evm_source.LocalOrigin = .{ .allocator = allocator, .leaves = &leaves, .stores = &.{} };
    var client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{});
    defer client.deinit();
    var recorder: RecordingObserver = .{};
    var source: evm_source.Source(evm_source.LocalOrigin) = .{ .allocator = allocator, .client = &client, .block_number = 0, .origin = &origin, .observation = recorder.observation() };
    _ = try source.proof(0, checkpoint);
    try std.testing.expectEqual(@as(usize, 0), recorder.mismatch_calls);
    var changed = checkpoint;
    changed.root[0] ^= 1;
    try std.testing.expectError(error.MerkleRootMismatch, source.proof(0, changed));
    try std.testing.expectEqual(@as(usize, 1), recorder.mismatch_calls);
    try std.testing.expectEqual(input.origin, recorder.mismatch_origin);
    var wrong_id = checkpoint;
    wrong_id.message_id = @splat(8);
    try std.testing.expectError(error.WrongCheckpointMessageId, source.proof(0, wrong_id));
    try std.testing.expectEqual(@as(usize, 1), recorder.mismatch_calls);

    const RefusalOrigin = struct {
        failure: anyerror,
        pub fn proof(self: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
            return self.failure;
        }
    };
    for ([_]anyerror{ error.WrongCheckpointContext, error.WrongCheckpointMessageId, error.ValidatorReorg, error.RequestCancelled, error.PendingReadIo }) |failure| {
        var refusal: RefusalOrigin = .{ .failure = failure };
        var refusal_source: evm_source.Source(RefusalOrigin) = .{ .allocator = allocator, .client = &client, .block_number = 0, .origin = &refusal, .observation = recorder.observation() };
        try std.testing.expectError(failure, refusal_source.proof(0, checkpoint));
    }
    try std.testing.expectEqual(@as(usize, 1), recorder.mismatch_calls);

    const registry = try metrics.Registry.init(allocator, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var manager = observability.Manager.init(allocator, registry, .{ .context = undefined, .now_ms_fn = struct {
        fn now(_: *anyopaque) u64 {
            return 0;
        }
    }.now });
    defer manager.deinit();
    var active: observability.Active = .{ .manager = &manager, .resolver = .{ .context = undefined, .name_fn = struct {
        fn name(_: *anyopaque, domain: u32) ![]const u8 {
            return if (domain == 1) "origin" else "destination";
        }
    }.name } };
    source.observation = active.observation();
    try std.testing.expectError(error.MerkleRootMismatch, source.proof(0, changed));
    _ = try source.proof(0, checkpoint);
    const text = try registry.render(allocator);
    defer allocator.free(text);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, text, "hyperlane_merkle_root_mismatch{origin=\"origin\""));
    try std.testing.expect(std.mem.indexOf(u8, text, "hyperlane_merkle_root_mismatch{origin=\"origin\",agent=\"relayer\",hyperlane_baselib_version=\"fixture\"} 1\n") != null);
}

fn expectRootAppContext(expected: []const u8, explicit: ?[]const u8, default_ism: Address, pending_default: bool) !void {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const registry = try metrics.Registry.init(allocator, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var manager = observability.Manager.init(allocator, registry, .{ .context = undefined, .now_ms_fn = struct {
        fn now(_: *anyopaque) u64 {
            return 0;
        }
    }.now });
    defer manager.deinit();
    var active: observability.Active = .{ .manager = &manager, .resolver = .{ .context = undefined, .name_fn = struct {
        fn name(_: *anyopaque, domain: u32) ![]const u8 {
            return if (domain == 1) "origin" else "destination";
        }
    }.name } };
    var metadata_cache = try contract_cache.Cache.init(allocator, .{ .enabled = false });
    defer metadata_cache.deinit();
    var default_cache = try contract_cache.Cache.init(allocator, .{});
    defer default_cache.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
        .default_ism = default_ism,
        .pending_default_once = pending_default,
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    const Cached = cached_source.CachedSource(Source);
    var wrapper = Cached.initBorrowed(allocator, &source, &metadata_cache, .{
        .context = .{ .domain_name = "origin", .context_hash = @splat(1) },
        .default_ism_cache = &default_cache,
    });
    const Default = struct {
        fn get(context: *anyopaque, _: u64) !Address {
            const value: *Source = @ptrCast(@alignCast(context));
            return value.defaultIsm();
        }
    };
    var builder: metadata.Builder(Cached) = .{ .allocator = allocator, .source = &wrapper, .executor = &root.executor, .observation = active.observation() };
    for (0..2) |_| {
        var attempts: usize = 0;
        const root_app_context = while (true) {
            const classified = @import("relayer/app_context.zig").classify(Address, @splat(0), explicit, &default_cache, .{ .domain_name = "origin", .context_hash = @splat(1) }, .{ .context = &source, .get_fn = Default.get }, 0) catch |err| {
                if (err != error.PendingReadIo) return err;
                attempts += 1;
                if (attempts > 4) return error.AppContextReplayLimit;
                continue;
            };
            break classified;
        };
        wrapper.setMessage(@splat(0), root_app_context, 0);
        builder.app_context = root_app_context;
        const encoded = try builder.build(@splat(0), input);
        allocator.free(encoded);
        try drain(root, &fixture);
    }
    const expected_calls: usize = if (explicit != null) 0 else if (pending_default) 2 else 1;
    try std.testing.expectEqual(expected_calls, fixture.default_calls.load(.acquire));
    const text = try registry.render(allocator);
    defer allocator.free(text);
    const label = try std.fmt.allocPrint(allocator, "app_context=\"{s}\"", .{expected});
    defer allocator.free(label);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, text, label));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, text, "hyperlane_ism_build_count{"));
    try std.testing.expectEqual(@as(u64, 0), manager.failures.load(.acquire));
}

test "root ISM app context preserves explicit default Unknown and replay semantics" {
    try expectRootAppContext("explicit-app", "explicit-app", @splat(0), false);
    try expectRootAppContext("default_ism", null, @splat(0), true);
    try expectRootAppContext("Unknown", null, @splat(9), false);
}

test "MessageId observation replays once and publishes full set without changing refusal" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .pending_latest_once = true,
        .pending_checkpoint_once = true,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    try drain(root, &fixture);
    try std.testing.expectEqual(@as(usize, 1), recorder.calls);
    try std.testing.expectEqual(@as(usize, 2), fixture.latest_calls.load(.acquire));
    try std.testing.expectEqual(@as(u32, 1), recorder.origin);
    try std.testing.expectEqual(@as(u32, 2), recorder.destination);
    try std.testing.expectEqualStrings("app", recorder.app_context);
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
    try std.testing.expectEqual(@as(?u32, 0), recorder.latest_values[0]);

    var failed: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .pending_latest_once = true,
        .latest_error = error.MockStorageUnavailable,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var failed_source: Source = .{ .allocator = allocator, .fixture = &failed, .cancel = &cancel };
    var failed_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &failed_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const failed_encoded = try failed_builder.build(@splat(0), input);
    defer allocator.free(failed_encoded);
    try drain(root, &failed);
    try std.testing.expectEqual(@as(usize, 1), recorder.calls);

    var refusal: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .refusal_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var refusal_source: Source = .{ .allocator = allocator, .fixture = &refusal, .cancel = &cancel };
    var refusal_builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &refusal_source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    try std.testing.expectError(error.MessageMetadataRefused, refusal_builder.build(@splat(0), input));
    try drain(root, &refusal);
}

test "direct root observation submits once across checkpoint replay" {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .pending_latest_once = true,
        .pending_checkpoint_once = true,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    var address: Address = @splat(0);
    address[19] = 1;
    const encoded = try builder.build(address, input);
    defer allocator.free(encoded);
    try drain(root, &fixture);
    try std.testing.expectEqual(@as(usize, 1), recorder.calls);
    try std.testing.expectEqual(@as(usize, 2), fixture.latest_calls.load(.acquire));
}

test "observation enqueue saturation preserves valid metadata and releases its fork exactly once" {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{ .workers = 1, .max_retained_jobs = 1 });
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
        .expected_observation_cancel = root.executor.stopToken(),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    const aggregation = try protocol.metadata.Aggregation.decode(encoded, 1);
    _ = try protocol.metadata.MessageIdMultisig.decode((try aggregation.metadataAt(0)) orelse return error.MissingMultisigMetadata);
    try drain(root, &fixture);
    try std.testing.expect(fixture.observation_cancel_matched.load(.acquire));
    try std.testing.expect(fixture.observation_cancel_initially_false.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), recorder.calls);
    try std.testing.expect(fixture.forks.load(.acquire) > 0);
    try std.testing.expectEqual(fixture.forks.load(.acquire), fixture.retired.load(.acquire));
}

test "pending latest observation retires on global stop without publishing" {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{ .workers = 1 });
    var closed = false;
    defer if (!closed) root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
        .latest_always_pending = true,
        .expected_observation_cancel = root.executor.stopToken(),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    try std.testing.expect(fixture.observation_cancel_matched.load(.acquire));
    try std.testing.expect(fixture.observation_cancel_initially_false.load(.acquire));
    try std.testing.expect(root.executor.retainedJobs() >= 1);
    var timer = try std.time.Timer.start();
    root.deinit();
    closed = true;
    try std.testing.expect(timer.read() < 5 * std.time.ns_per_s);
    try std.testing.expectEqual(@as(usize, 0), recorder.calls);
    try std.testing.expectEqual(fixture.forks.load(.acquire), fixture.retired.load(.acquire));
}

test "detached observation publishes exactly 27 validators to production Registry" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const registry = try metrics.Registry.init(allocator, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var manager = observability.Manager.init(allocator, registry, .{ .context = undefined, .now_ms_fn = struct {
        fn now(_: *anyopaque) u64 {
            return 0;
        }
    }.now });
    defer manager.deinit();
    var active: observability.Active = .{ .manager = &manager, .resolver = .{ .context = undefined, .name_fn = struct {
        fn name(_: *anyopaque, domain: u32) ![]const u8 {
            return if (domain == 1) "origin" else "destination";
        }
    }.name } };
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var fixture: Fixture = .{
        .child_count = 27,
        .threshold = 1,
        .validator_count = 27,
        .message_id_index = 0,
        .pending_latest_once = true,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = active.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    try drain(root, &fixture);
    const text = try registry.render(allocator);
    defer allocator.free(text);
    try std.testing.expectEqual(@as(usize, 27), std.mem.count(u8, text, "hyperlane_observed_validator_latest_index{"));
    try std.testing.expectEqual(@as(u64, 0), manager.failures.load(.acquire));
}

test "threshold one MessageIdMultisig fast path cancels trailing discovery" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var fixture: Fixture = .{
        .threshold = 1,
        .stall_first = 8,
        .message_id_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 16);
    try std.testing.expect((try decoded.metadataAt(0)).?.len > 0);
    for (1..16) |index| try std.testing.expect((try decoded.metadataAt(index)) == null);
    try std.testing.expectEqual(@as(usize, 1), fixture.module_calls[0].load(.acquire));
    fixture.release();
    try drain(root, &fixture);
}

test "fast path fallback reuses discovered source types" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var fixture: Fixture = .{ .threshold = 1, .message_id_index = 0, .awaiting_message_id = true };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 16);
    try std.testing.expect((try decoded.metadataAt(0)) == null);
    var selected: ?usize = null;
    for (1..16) |index| if ((try decoded.metadataAt(index)) != null) {
        try std.testing.expect(selected == null);
        selected = index;
    };
    try std.testing.expect(selected != null);
    try std.testing.expectEqual(@as(usize, 1), fixture.module_calls[0].load(.acquire));
    try std.testing.expect(fixture.module_calls[selected.?].load(.acquire) >= 1);
    try drain(root, &fixture);
}

test "verification replay does not consume cumulative ISM count twice" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    // Require all four children: a partial quorum may cancel a trailing child
    // before it enters, making an exact visit count depend on scheduling.
    var fixture: Fixture = .{ .child_count = 4, .threshold = 4, .pending_verify = true };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .max_count = 5 };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try expectSelection(encoded, 4, &.{ 0, 1, 2, 3 });
    for (fixture.verify_ready[0..4]) |*ready| try std.testing.expect(ready.load(.acquire));
    try std.testing.expectEqual(@as(usize, 5), builder.visited);
    try drain(root, &fixture);
}

test "nested fast path fallback counts a fresh build rather than a replay" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .nested_first = 1,
        .nested_children = 2,
        .nested_threshold = 1,
        .message_id_index = 32,
        .awaiting_message_id = true,
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .max_count = 5, .max_depth = 4 };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try std.testing.expectEqual(@as(usize, 5), builder.visited);
    try drain(root, &fixture);
}

test "nested aggregations cooperate on eight workers and enforce exact shared bounds" {
    const allocator = std.heap.c_allocator;
    const root = try parallel.Root.start(allocator, .{ .max_retained_jobs = 256 });
    defer root.deinit();
    var fixture: Fixture = .{ .child_count = 8, .threshold = 8, .nested_first = 8, .nested_children = 8, .pending_verify = true };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .max_count = 73, .max_depth = 3 };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try std.testing.expectEqual(@as(usize, 73), builder.visited);
    try drain(root, &fixture);

    builder.max_count = 72;
    try std.testing.expectError(error.IsmCountExceeded, builder.build(@splat(0), message()));
    try drain(root, &fixture);
    builder.max_count = 73;
    builder.max_depth = 2;
    try std.testing.expectError(error.IsmDepthExceeded, builder.build(@splat(0), message()));
    try drain(root, &fixture);
}

const LockedFailAllocator = struct {
    backing: A,
    fail_at: usize,
    count: usize = 0,
    mutex: std.Thread.Mutex = .{},

    fn allocator(self: *LockedFailAllocator) A {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn alloc(context: *anyopaque, length: usize, alignment: std.mem.Alignment, address: usize) ?[*]u8 {
        const self: *LockedFailAllocator = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.count == self.fail_at) return null;
        const result = self.backing.rawAlloc(length, alignment, address) orelse return null;
        self.count += 1;
        return result;
    }

    fn resize(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, length: usize, address: usize) bool {
        const self: *LockedFailAllocator = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.backing.rawResize(bytes, alignment, length, address);
    }

    fn remap(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, length: usize, address: usize) ?[*]u8 {
        const self: *LockedFailAllocator = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.backing.rawRemap(bytes, alignment, length, address);
    }

    fn free(context: *anyopaque, bytes: []u8, alignment: std.mem.Alignment, address: usize) void {
        const self: *LockedFailAllocator = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.backing.rawFree(bytes, alignment, address);
    }
};

fn allocationExercise(allocator: A, nested_tree: bool) !void {
    const root = try parallel.Root.start(allocator, .{ .workers = 1, .max_retained_jobs = 64 });
    defer root.deinit();
    var fixture: Fixture = if (nested_tree) .{ .child_count = 2, .threshold = 2, .nested_first = 1, .nested_children = 2, .nested_threshold = 2 } else .{ .child_count = 4, .threshold = 4 };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
}

fn allocationFailureSweep(nested_tree: bool) !void {
    var fail_at: usize = 0;
    while (fail_at < 4096) {
        var allocator: LockedFailAllocator = .{ .backing = std.testing.allocator, .fail_at = fail_at };
        allocationExercise(allocator.allocator(), nested_tree) catch |err| {
            if (err != error.OutOfMemory) return err;
            fail_at += 1;
            continue;
        };
        return;
    }
    return error.OomSweepDidNotConverge;
}

test "OOM at every allocation cancels and retires without output leaks" {
    try allocationFailureSweep(false);
}

test "nested cancellation ancestry retires at every allocation failure" {
    try allocationFailureSweep(true);
}

fn unexpectedCcipFetch(_: *anyopaque, _: Address, _: protocol.Message) anyerror![]u8 {
    return error.UnexpectedCcipFetch;
}

test "EVM fork rejects uncloneable CCIP handler context" {
    const allocator = std.testing.allocator;
    var client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{});
    defer client.deinit();
    var origin: evm_source.LocalOrigin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
    var context: u8 = 0;
    var source: evm_source.Source(evm_source.LocalOrigin) = .{
        .allocator = allocator,
        .client = &client,
        .block_number = 42,
        .origin = &origin,
        .ccip_handler = .{ .context = &context, .fetch_fn = unexpectedCcipFetch },
    };
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.CcipHandlerForkUnsupported, source.fork(allocator, &cancel));
}

const CcipCloneFixture = struct {
    root_client: *evm.RpcClient,
    correct_context: bool = false,
    deinit_count: usize = 0,

    fn clone(context: *anyopaque, _: A, client: *evm.RpcClient, block_number: u64, _: *const std.atomic.Value(bool)) anyerror!ccip.Handler {
        const self: *CcipCloneFixture = @ptrCast(@alignCast(context));
        self.correct_context = client != self.root_client and block_number == 42;
        return .{ .context = context, .fetch_fn = unexpectedCcipFetch, .deinit_fn = deinit };
    }

    fn deinit(context: *anyopaque) void {
        const self: *CcipCloneFixture = @ptrCast(@alignCast(context));
        self.deinit_count += 1;
    }
};

test "EVM fork owns cloned CCIP handler through actual retirement" {
    const allocator = std.testing.allocator;
    var client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{});
    defer client.deinit();
    var origin: evm_source.LocalOrigin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
    var fixture: CcipCloneFixture = .{ .root_client = &client };
    var source: evm_source.Source(evm_source.LocalOrigin) = .{
        .allocator = allocator,
        .client = &client,
        .block_number = 42,
        .origin = &origin,
        .ccip_handler = .{ .context = &fixture, .fetch_fn = unexpectedCcipFetch, .fork_fn = CcipCloneFixture.clone },
    };
    var cancel = std.atomic.Value(bool).init(false);
    const forked = try source.fork(allocator, &cancel);
    try std.testing.expect(fixture.correct_context);
    try std.testing.expectEqual(@as(usize, 0), fixture.deinit_count);
    forked.deinitFork();
    try std.testing.expectEqual(@as(usize, 1), fixture.deinit_count);
}

fn appendWord(out: *std.ArrayList(u8), allocator: A, value: u256) !void {
    var buffer: [64]u8 = undefined;
    const text = try std.fmt.bufPrint(&buffer, "{x:0>64}", .{value});
    try out.appendSlice(allocator, text);
}

fn rpcResult(allocator: A, id: i64, result: []const u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x{s}\"}}", .{ id, result });
}

fn metadataRpcResponse(allocator: A, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
    defer parsed.deinit();
    const object = parsed.value.object;
    const id = object.get("id").?.integer;
    const method = object.get("method").?.string;
    const params = object.get("params").?.array.items;
    if (std.mem.eql(u8, method, "eth_estimateGas")) {
        if (!std.mem.eql(u8, params[1].string, "0x2a")) return error.UnpinnedRpcBlock;
        return std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x64\"}}", .{id});
    }
    if (!std.mem.eql(u8, method, "eth_call")) return error.UnexpectedMetadataRpc;
    if (!std.mem.eql(u8, params[1].string, "0x2a")) return error.UnpinnedRpcBlock;
    const call = params[0].object;
    const data = call.get("data").?.string;
    const module_selector = try evm.codecs.hexAlloc(allocator, &evm.codecs.selector("moduleType()"));
    defer allocator.free(module_selector);
    if (std.mem.eql(u8, data, module_selector)) {
        const to = call.get("to").?.string;
        return rpcResult(allocator, id, if (std.mem.eql(u8, to, "0x0000000000000000000000000000000000000000"))
            "00000000000000000000000000000000" ++ "00000000000000000000000000000002"
        else
            "00000000000000000000000000000000" ++ "00000000000000000000000000000006");
    }
    const members_selector = try evm.codecs.hexAlloc(allocator, &evm.codecs.selector("modulesAndThreshold(bytes)"));
    defer allocator.free(members_selector);
    if (std.mem.startsWith(u8, data, members_selector)) {
        var result: std.ArrayList(u8) = .empty;
        defer result.deinit(allocator);
        try appendWord(&result, allocator, 64);
        try appendWord(&result, allocator, 2);
        try appendWord(&result, allocator, 16);
        for (1..17) |index| try appendWord(&result, allocator, index);
        return rpcResult(allocator, id, result.items);
    }
    const verify_selector = try evm.codecs.hexAlloc(allocator, &evm.codecs.selector("verify(bytes,bytes)"));
    defer allocator.free(verify_selector);
    if (std.mem.startsWith(u8, data, verify_selector)) return rpcResult(allocator, id, "00000000000000000000000000000000" ++ "00000000000000000000000000000001");
    return error.UnexpectedMetadataCalldata;
}

const NativeMetadataServer = struct {
    listener: std.net.Server,
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    thread: ?std.Thread = null,
    schedule: ?*NativeMetadataSchedule = null,
    hits: [16]std.atomic.Value(usize) = @splat(.init(0)),
    stalled: [4096]std.net.Stream = undefined,
    stalled_count: usize = 0,

    fn init() !NativeMetadataServer {
        return .{ .listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    }

    fn start(self: *NativeMetadataServer) !void {
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
    }

    fn deinit(self: *NativeMetadataServer) void {
        self.stop.store(true, .release);
        if (self.thread) |thread| thread.join();
        self.listener.deinit();
    }

    fn url(self: *NativeMetadataServer, allocator: A, index: usize) ![]u8 {
        return std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/{d}", .{ self.listener.listen_address.getPort(), index });
    }

    fn pathHits(self: *NativeMetadataServer, index: usize) usize {
        return self.hits[index].load(.acquire);
    }

    fn check(self: *NativeMetadataServer) !void {
        if (self.failure) |err| return err;
    }

    fn serve(self: *NativeMetadataServer) void {
        self.run() catch |err| {
            self.failure = err;
            if (self.schedule) |schedule| schedule.failure(err);
        };
    }

    fn run(self: *NativeMetadataServer) !void {
        defer if (self.schedule) |schedule| schedule.clear();
        defer for (self.stalled[0..self.stalled_count]) |stream| stream.close();
        while (!self.stop.load(.acquire)) {
            if (self.schedule) |schedule| try schedule.progress();
            var descriptor = [_]std.posix.pollfd{.{ .fd = self.listener.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&descriptor, 10) == 0) continue;
            const connection = try self.listener.accept();
            try self.handle(connection.stream);
        }
    }

    fn handle(self: *NativeMetadataServer, stream: std.net.Stream) !void {
        var retained = false;
        defer if (!retained) stream.close();
        var input: [16384]u8 = undefined;
        var used: usize = 0;
        var body: []const u8 = undefined;
        var path_index: usize = undefined;
        while (true) {
            if (std.mem.indexOf(u8, input[0..used], "\r\n\r\n")) |header_at| {
                const header = input[0..header_at];
                const length_start = std.ascii.indexOfIgnoreCase(header, "content-length: ") orelse return error.FixtureMissingLength;
                const value_start = length_start + 16;
                const value_end = std.mem.indexOfPos(u8, input[0..used], value_start, "\r\n") orelse return error.FixtureMissingLength;
                const length = try std.fmt.parseInt(usize, input[value_start..value_end], 10);
                if (header_at + 4 + length > input.len) return error.FixtureRequestTooLarge;
                if (used < header_at + 4 + length) {
                    const count = stream.read(input[used..]) catch |err| switch (err) {
                        error.ConnectionResetByPeer => return,
                        else => return err,
                    };
                    if (count == 0) return;
                    used += count;
                    continue;
                }
                body = input[header_at + 4 ..][0..length];
                const first_end = std.mem.indexOf(u8, header, "\r\n") orelse header.len;
                const first = header[0..first_end];
                if (!std.mem.startsWith(u8, first, "POST /")) return error.FixtureBadRequest;
                const path_end = std.mem.indexOfScalarPos(u8, first, 6, ' ') orelse return error.FixtureBadPath;
                path_index = try std.fmt.parseInt(usize, first[6..path_end], 10);
                if (path_index >= 16) return error.FixtureBadPath;
                break;
            }
            if (used == input.len) return error.FixtureRequestTooLarge;
            const count = stream.read(input[used..]) catch |err| switch (err) {
                error.ConnectionResetByPeer => return,
                else => return err,
            };
            if (count == 0) return;
            used += count;
        }
        _ = self.hits[path_index].fetchAdd(1, .acq_rel);
        if (path_index < 8) {
            if (self.stalled_count == self.stalled.len) return error.FixtureTooManyStalls;
            self.stalled[self.stalled_count] = stream;
            self.stalled_count += 1;
            retained = true;
            return;
        }
        const response = try metadataRpcResponse(std.heap.page_allocator, body);
        defer std.heap.page_allocator.free(response);
        if (self.schedule) |schedule| {
            if (try schedule.capture(stream, body, response)) {
                retained = true;
                return;
            }
        }
        if (try writeMetadataResponse(stream, response)) if (self.schedule) |schedule| schedule.sent(try NativeMetadataSchedule.call(body));
    }
};

fn blockingPoolExchange(context: *anyopaque, allocator: A, body: []const u8, options: evm.provider.Options) anyerror!evm.provider.WireResponse {
    const runtime: *Pool = @ptrCast(@alignCast(context));
    const response = try runtime.fetch(allocator, body, options.timeout_ms, options.connect_timeout_ms, options.cancel, options.max_response_bytes);
    return .{ .bytes = response.bytes, .len = response.len };
}

fn drainExecutor(root: *parallel.Root) !void {
    var timer = try std.time.Timer.start();
    while (root.executor.retainedJobs() != 0) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.FixtureRetirementTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedOutputBytes());
}

const MetadataPoolObserver = struct {
    upstream_failures: std.atomic.Value(usize) = .init(0),
    request_failures: std.atomic.Value(usize) = .init(0),
    attempt_timeouts: std.atomic.Value(usize) = .init(0),

    fn interface(self: *MetadataPoolObserver) @import("evm/pool.zig").Observer {
        return .{ .context = self, .event_fn = record };
    }

    fn record(context: *anyopaque, event: @import("evm/pool.zig").Event) void {
        const self: *MetadataPoolObserver = @ptrCast(@alignCast(context));
        switch (event.kind) {
            .upstream_completed => {
                if (!event.success and !event.cancelled) _ = self.upstream_failures.fetchAdd(1, .acq_rel);
            },
            .request_failed => {
                if (!event.cancelled) _ = self.request_failures.fetchAdd(1, .acq_rel);
            },
            .attempt_timed_out => {
                _ = self.attempt_timeouts.fetchAdd(1, .acq_rel);
            },
            else => {},
        }
    }

    fn expectClean(self: *const MetadataPoolObserver) !void {
        try std.testing.expectEqual(@as(usize, 0), self.upstream_failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), self.request_failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), self.attempt_timeouts.load(.acquire));
    }
};

const NativePoolFailureRecord = struct {
    schema: u8 = 1,
    phase: enum { metadata_build } = .metadata_build,
    build_iteration: u8 = 1,
    build_error: enum { aggregation_threshold_not_met, other_build_error },
    child_error_details: enum { unknown_not_retained } = .unknown_not_retained,
    observation_scope: enum { before_teardown_counters_may_still_advance } = .before_teardown_counters_may_still_advance,
    request_timeout_ms: u32,
    connect_timeout_ms: u32,
    root_next_request_id: i64,
    build_elapsed_ns: ?u64,
    upstream_failures: usize,
    request_failures: usize,
    attempt_timeouts: usize,
    metadata_storage_errors: usize,
    metadata_awaiting_signatures: usize,
    metadata_verification_failures: usize,
    stalled_path_hits: [8]usize,
    healthy_path_hits: [8]usize,
};

fn nativePoolFailureSnapshot(failure: anyerror, observer: *const MetadataPoolObserver, server: *NativeMetadataServer, diagnostics: metadata.Diagnostics, options: evm.provider.Options, next_id: i64, elapsed_ns: ?u64) NativePoolFailureRecord {
    var stalled: [8]usize = undefined;
    var healthy: [8]usize = undefined;
    for (0..8) |index| {
        stalled[index] = server.pathHits(index);
        healthy[index] = server.pathHits(index + 8);
    }
    return .{
        .build_error = if (failure == error.AggregationThresholdNotMet) .aggregation_threshold_not_met else .other_build_error,
        .request_timeout_ms = options.timeout_ms,
        .connect_timeout_ms = options.connect_timeout_ms,
        .root_next_request_id = next_id,
        .build_elapsed_ns = elapsed_ns,
        .upstream_failures = observer.upstream_failures.load(.acquire),
        .request_failures = observer.request_failures.load(.acquire),
        .attempt_timeouts = observer.attempt_timeouts.load(.acquire),
        .metadata_storage_errors = diagnostics.storage_errors,
        .metadata_awaiting_signatures = diagnostics.awaiting_signatures,
        .metadata_verification_failures = diagnostics.verification_failures,
        .stalled_path_hits = stalled,
        .healthy_path_hits = healthy,
    };
}

fn nativePoolFailureJson(buffer: []u8, record: NativePoolFailureRecord) ![]const u8 {
    var writer = std.Io.Writer.fixed(buffer);
    try std.json.Stringify.value(record, .{}, &writer);
    return writer.buffered();
}

test "native Pool failure record projects existing counters and preserves unknown child errors" {
    var observer: MetadataPoolObserver = .{};
    observer.upstream_failures.store(3, .release);
    observer.request_failures.store(2, .release);
    observer.attempt_timeouts.store(1, .release);
    var server: NativeMetadataServer = .{ .listener = undefined };
    for (0..16) |index| server.hits[index].store(index + 10, .release);
    const options: evm.provider.Options = .{ .timeout_ms = 20000, .connect_timeout_ms = 20000 };
    const record = nativePoolFailureSnapshot(error.AggregationThresholdNotMet, &observer, &server, .{ .storage_errors = 4, .awaiting_signatures = 5, .verification_failures = 6 }, options, 3, 42);
    try std.testing.expectEqual(@as(usize, 3), record.upstream_failures);
    try std.testing.expectEqual(@as(usize, 2), record.request_failures);
    try std.testing.expectEqual(@as(usize, 1), record.attempt_timeouts);
    try std.testing.expectEqual(@as(usize, 4), record.metadata_storage_errors);
    try std.testing.expectEqual(@as(usize, 5), record.metadata_awaiting_signatures);
    try std.testing.expectEqual(@as(usize, 6), record.metadata_verification_failures);
    try std.testing.expectEqual(@as(i64, 3), record.root_next_request_id);
    try std.testing.expectEqual(@as(?u64, 42), record.build_elapsed_ns);
    try std.testing.expectEqual(@as(u32, 20000), record.request_timeout_ms);
    try std.testing.expectEqual(@as(u32, 20000), record.connect_timeout_ms);
    for (0..8) |index| {
        try std.testing.expectEqual(index + 10, record.stalled_path_hits[index]);
        try std.testing.expectEqual(index + 18, record.healthy_path_hits[index]);
    }
    var buffer: [2048]u8 = undefined;
    const wire = try nativePoolFailureJson(&buffer, record);
    try std.testing.expect(std.mem.indexOf(u8, wire, "aggregation_threshold_not_met") != null);
    try std.testing.expect(std.mem.indexOf(u8, wire, "unknown_not_retained") != null);
    const unknown = nativePoolFailureSnapshot(error.PRIVATE_ERROR_DO_NOT_EXPORT, &observer, &server, .{}, options, 3, null);
    const redacted = try nativePoolFailureJson(&buffer, unknown);
    try std.testing.expect(std.mem.indexOf(u8, redacted, "other_build_error") != null);
    try std.testing.expect(std.mem.indexOf(u8, redacted, "PRIVATE") == null);
    try std.testing.expect(std.mem.indexOf(u8, redacted, "http") == null);
    try std.testing.expect(unknown.build_elapsed_ns == null);
}

test "native Pool failure record stays bounded for maximum numeric counters" {
    var observer: MetadataPoolObserver = .{};
    observer.upstream_failures.store(std.math.maxInt(usize), .release);
    observer.request_failures.store(std.math.maxInt(usize), .release);
    observer.attempt_timeouts.store(std.math.maxInt(usize), .release);
    var server: NativeMetadataServer = .{ .listener = undefined };
    for (&server.hits) |*value| value.store(std.math.maxInt(usize), .release);
    var buffer: [2048]u8 = undefined;
    const record = nativePoolFailureSnapshot(error.OutOfMemory, &observer, &server, .{ .storage_errors = std.math.maxInt(usize), .awaiting_signatures = std.math.maxInt(usize), .verification_failures = std.math.maxInt(usize) }, .{ .timeout_ms = std.math.maxInt(u32), .connect_timeout_ms = std.math.maxInt(u32) }, std.math.minInt(i64), std.math.maxInt(u64));
    const wire = try nativePoolFailureJson(&buffer, record);
    try std.testing.expect(wire.len < buffer.len);
    var tiny: [1]u8 = undefined;
    try std.testing.expectError(error.WriteFailed, nativePoolFailureJson(&tiny, record));
}

test "native Pool yields eight stalled peers and verifies healthy EVM children three times" {
    const allocator = std.testing.allocator;
    const library = try pool_fixture.nativeLibrary(allocator);
    defer allocator.free(library);
    var server = try NativeMetadataServer.init();
    try server.start();
    defer server.deinit();
    var owned_urls: [16][]u8 = undefined;
    var urls: [16][]const u8 = undefined;
    for (&owned_urls, &urls, 0..) |*owned, *url, index| {
        owned.* = try server.url(allocator, index);
        url.* = owned.*;
    }
    defer for (&owned_urls) |url| allocator.free(url);
    var observer: MetadataPoolObserver = .{};
    const runtime = try Pool.start(allocator, .{
        .library_path = library,
        .observer = observer.interface(),
        .urls = &urls,
        .strategy = .{ .quorum = .{ .threshold = 8, .max_attempts = 1, .retry_delay_ms = 1 } },
        .max_sessions = 4,
        .max_concurrent = 128,
        .max_pending = 512,
        .max_response_bytes = 16384,
        .max_request_bytes = 16384,
        .max_reserved_bytes = 64 * 1024 * 1024,
    });
    defer runtime.deinit();
    const root = try parallel.Root.start(allocator, .{ .max_retained_jobs = 128 });
    defer root.deinit();
    var client = try evm.RpcClient.init(allocator, urls[0], .{
        .async_pool = runtime,
        .exchange = .{ .context = runtime, .fetch_fn = blockingPoolExchange },
        .max_response_bytes = 16384,
        .timeout_ms = 20000,
        .connect_timeout_ms = 20000,
    });
    defer client.deinit();
    var origin: evm_source.LocalOrigin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
    var source: evm_source.Source(evm_source.LocalOrigin) = .{
        .allocator = allocator,
        .client = &client,
        .block_number = 42,
        .origin = &origin,
    };
    var builder: metadata.Builder(@TypeOf(source)) = .{ .allocator = allocator, .source = &source, .executor = &root.executor };
    const build_started: ?std.time.Instant = std.time.Instant.now() catch null;
    const encoded = builder.build(@splat(0), message()) catch |err| {
        const elapsed_ns: ?u64 = if (build_started) |started| if (std.time.Instant.now()) |finished| finished.since(started) else |_| null else null;
        const failure = nativePoolFailureSnapshot(err, &observer, &server, builder.diagnostics, client.options, client.next_id, elapsed_ns);
        var diagnostic_buffer: [2048]u8 = undefined;
        const diagnostic = nativePoolFailureJson(&diagnostic_buffer, failure) catch "{\"schema\":1,\"collection_status\":\"unavailable\"}";
        std.debug.print("NATIVE_METADATA_POOL_FAILURE {s}\n", .{diagnostic});
        try server.check();
        return err;
    };
    defer allocator.free(encoded);
    try observer.expectClean();
    try std.testing.expectEqual(@as(i64, 3), client.next_id);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 16);
    var selected: usize = 0;
    for (0..16) |index| if ((try decoded.metadataAt(index)) != null) {
        selected += 1;
    };
    try std.testing.expectEqual(@as(usize, 2), selected);
    try drainExecutor(root);
    for (8..16) |index| try std.testing.expect(server.pathHits(index) >= 8);
    try server.check();
}

fn repeatedLeafReplayScenario(nested_leaf: bool) !void {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = if (nested_leaf) 32 else 0,
        .nested_first = if (nested_leaf) 1 else 0,
        .nested_children = 1,
        .pending_checkpoint_passes = 20,
        .pending_verify_index = 0,
        .pending_verify_passes = 20,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "replayed-root" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    try drain(root, &fixture);
    try std.testing.expectEqual(@as(usize, 1), recorder.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.latest_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), recorder.event_count);
    try expectLeafEvent(&recorder, 0, .message_id_multisig, true);
    try std.testing.expectEqualStrings("replayed-root", recorder.app_context);
    try std.testing.expect(fixture.checkpoint_calls.load(.acquire) >= 21);
    try std.testing.expectEqual(@as(usize, 21), fixture.verify_calls.load(.acquire));
    try std.testing.expectEqual(fixture.forks.load(.acquire), fixture.retired.load(.acquire));
}

test "one leaf observation survives twenty quorum and candidate verification suspensions" {
    try repeatedLeafReplayScenario(false);
}

test "nested leaf observation survives twenty parent verification replays" {
    try repeatedLeafReplayScenario(true);
}

test "successful latest read completing after global stop cannot publish" {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{});
    var closed = false;
    defer if (!closed) root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
        .latest_complete_after_stop = true,
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    var timer = try std.time.Timer.start();
    while (fixture.latest_calls.load(.acquire) == 0) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.LatestReadNeverStarted;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    root.deinit();
    closed = true;
    try std.testing.expect(!fixture.latest_stop_expired.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), recorder.calls);
    try std.testing.expectEqual(fixture.forks.load(.acquire), fixture.retired.load(.acquire));
}

fn optionalLatestOomScenario(fork_oom: bool) !void {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{});
    defer root.deinit();
    const input = message();
    const key: [32]u8 = @splat(0x11);
    var recorder: RecordingObserver = .{};
    var fixture: Fixture = .{
        .child_count = 1,
        .threshold = 1,
        .message_id_index = 0,
        .signed = try signedCheckpoint(input, key),
        .validator = try protocol.signature.secretKeyAddress(key),
        .latest_error = if (fork_oom) null else error.OutOfMemory,
        .expected_observation_cancel = root.executor.stopToken(),
        .observation_fork_error = if (fork_oom) error.OutOfMemory else null,
    };
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .observation = recorder.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), input);
    defer allocator.free(encoded);
    try drain(root, &fixture);
    const aggregation = try protocol.metadata.Aggregation.decode(encoded, 1);
    const leaf = try protocol.metadata.MessageIdMultisig.decode((try aggregation.metadataAt(0)) orelse return error.MissingMultisigMetadata);
    try std.testing.expectEqual(@as(usize, 65), leaf.signatures.len);
    try std.testing.expectEqual(@as(usize, 0), recorder.calls);
    try std.testing.expectEqual(@as(usize, 1), recorder.event_count);
    try expectLeafEvent(&recorder, 0, .message_id_multisig, true);
}

test "latest-only storage OOM does not veto an exact signed quorum" {
    try optionalLatestOomScenario(false);
}

test "latest-only fork OOM does not veto an exact signed quorum or leak owned copies" {
    try optionalLatestOomScenario(true);
}

const LateClock = struct {
    fn now(context: *anyopaque) !@import("agents/operation.zig").Times {
        const fixture: *Fixture = @ptrCast(@alignCast(context));
        _ = fixture.clock_reads.fetchAdd(1, .acq_rel);
        return .{ .unix_ms = 1000, .monotonic_ms = 1000 };
    }
    fn expiredParentClock(_: *anyopaque) !u64 {
        return error.ExpiredParentClock;
    }
    fn exchange(context: *anyopaque, allocator: A, body: []const u8, _: evm.provider.Options) !evm.provider.WireResponse {
        const fixture: *Fixture = @ptrCast(@alignCast(context));
        fixture.clock_entered.store(true, .release);
        var timer = try std.time.Timer.start();
        while (!fixture.clock_release.load(.acquire)) {
            if (timer.read() > 5 * std.time.ns_per_s) {
                fixture.clock_expired.store(true, .release);
                return error.ClockChildReleaseTimeout;
            }
            std.Thread.sleep(std.time.ns_per_ms);
        }
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer parsed.deinit();
        const id = parsed.value.object.get("id").?.integer;
        const word = "000000000000000000000000" ++ "7777777777777777777777777777777777777777";
        const bytes = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x{s}\"}}", .{ id, word });
        return .{ .bytes = bytes, .len = bytes.len };
    }
};

fn earlyThresholdParentFrame(root: *parallel.Root, fixture: *Fixture, cache: *contract_cache.Cache, origin: *evm_source.LocalOrigin, cancel: *const std.atomic.Value(bool)) !void {
    const allocator = std.testing.allocator;
    var client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{ .exchange = .{ .context = fixture, .fetch_fn = LateClock.exchange } });
    defer client.deinit();
    var source: ClockSource = .{ .allocator = allocator, .client = &client, .block_number = 1, .origin = origin, .mailbox = @splat(1), .observation_clock = .{ .context = fixture, .now_fn = LateClock.now } };
    // This callback deliberately models the no-longer-valid parent stack clock.
    // The retained fork must use its own Source clock rather than this option.
    var wrapper = ClockCached.initBorrowed(allocator, &source, cache, .{ .context = .{ .domain_name = "late-clock", .context_hash = @splat(8) }, .default_ism_now = .{ .context = fixture, .now_ms_fn = LateClock.expiredParentClock } });
    wrapper.setMessage(@splat(1), "app", 0);
    var build_source: Source = .{ .allocator = allocator, .fixture = fixture, .cancel = cancel, .clock_source = &wrapper };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &build_source, .executor = &root.executor, .cancel = cancel };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try std.testing.expect(fixture.clock_entered.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.clock_reads.load(.acquire));
    // Root Source, client and wrapper leave scope with a retained child still
    // inside its independent EVM Source fork's uncancellable physical read.
}

test "early threshold child uses owned EVM fork clock after parent frame returns" {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{ .workers = 4 });
    defer root.deinit();
    var fixture: Fixture = .{ .child_count = 4, .threshold = 2, .clock_child = true };
    var cache = try contract_cache.Cache.init(allocator, .{ .max_entries = 4 });
    defer cache.deinit();
    var origin: evm_source.LocalOrigin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
    var cancel = std.atomic.Value(bool).init(false);
    defer {
        fixture.clock_release.store(true, .release);
        drain(root, &fixture) catch @panic("late clock child did not retire");
    }
    try earlyThresholdParentFrame(root, &fixture, &cache, &origin, &cancel);
    fixture.clock_release.store(true, .release);
    try drain(root, &fixture);
    try std.testing.expect(!fixture.clock_expired.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), fixture.clock_reads.load(.acquire));
    const context: contract_cache.Context = .{ .domain_name = "late-clock", .context_hash = @splat(8) };
    try std.testing.expect(try cache.get(context, .default_ism, 600999) != null);
    try std.testing.expect(try cache.get(context, .default_ism, 601000) == null);
}

test "early threshold discards uncancellable leaf completion without a terminal metric" {
    const allocator = std.testing.allocator;
    const root = try parallel.Root.start(allocator, .{ .workers = 4 });
    defer root.deinit();
    var fixture: Fixture = .{ .child_count = 4, .threshold = 2, .late_ccip_child = true };
    defer {
        fixture.clock_release.store(true, .release);
        drain(root, &fixture) catch @panic("late CCIP child did not retire");
    }
    var recorder: RecordingObserver = .{};
    var cancel = std.atomic.Value(bool).init(false);
    var source: Source = .{ .allocator = allocator, .fixture = &fixture, .cancel = &cancel };
    var builder: metadata.Builder(Source) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .cancel = &cancel, .observation = recorder.observation(), .app_context = "app" };
    const encoded = try builder.build(@splat(0), message());
    defer allocator.free(encoded);
    try std.testing.expect(fixture.clock_entered.load(.acquire));
    fixture.clock_release.store(true, .release);
    try drain(root, &fixture);
    try std.testing.expect(!fixture.clock_expired.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), recorder.event_count);
}

// Test-only response barriers. All backpressure is produced by the real shared
// Pool's four occupied sessions, never by an injected PendingReadIo/error.
const NativeMetadataSchedule = struct {
    const Phase = enum { collect_verify, gas_boundary, release_selected_gas };
    const Kind = enum { other, module_type, verify, gas };
    const Call = struct { kind: Kind, member: ?usize = null };
    const Held = struct { stream: std.net.Stream, response: []u8, call: Call };
    const Slots = struct { total: usize = 0, verify: usize = 0, gas: usize = 0, other: usize = 0 };

    runtime: *Pool,
    timer: std.time.Timer,
    abort: std.atomic.Value(bool) = .init(false),
    phase: Phase = .collect_verify,
    held: [64]Held = undefined,
    held_count: usize = 0,
    held_peak: usize = 0,
    initial_verify_mask: u16 = 0,
    release_verify_mask: u16 = 0,
    gas_mask: u16 = 0,
    held_verify_counts: [16]usize = @splat(0),
    held_gas_counts: [16]usize = @splat(0),
    module_responses: [16]usize = @splat(0),
    verify_responses: [16]usize = @splat(0),
    gas_responses: [16]usize = @splat(0),
    real_pressure_refusals: usize = 0,
    cached_gas_members: u16 = 0,
    last_slots: Slots = .{},

    fn bit(member: usize) u16 {
        return @as(u16, 1) << @as(u4, @intCast(member));
    }

    fn call(body: []const u8) !Call {
        const parsed = try std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, body, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        const method = object.get("method").?.string;
        if (!std.mem.eql(u8, method, "eth_call") and !std.mem.eql(u8, method, "eth_estimateGas")) return .{ .kind = .other };
        const request = object.get("params").?.array.items[0].object;
        const address = try evm.codecs.fixedHex(20, request.get("to").?.string);
        for (address[0..19]) |byte| if (byte != 0) return error.FixtureUnexpectedScheduledAddress;
        if (address[19] == 0) return .{ .kind = .other };
        if (address[19] > 16) return error.FixtureUnexpectedScheduledAddress;
        const member: usize = address[19] - 1;
        if (std.mem.eql(u8, method, "eth_estimateGas")) return .{ .kind = .gas, .member = member };
        const data = request.get("data").?.string;
        const module = try evm.codecs.hexAlloc(std.heap.page_allocator, &evm.codecs.selector("moduleType()"));
        defer std.heap.page_allocator.free(module);
        if (std.mem.eql(u8, data, module)) return .{ .kind = .module_type, .member = member };
        const verify = try evm.codecs.hexAlloc(std.heap.page_allocator, &evm.codecs.selector("verify(bytes,bytes)"));
        defer std.heap.page_allocator.free(verify);
        return .{ .kind = if (std.mem.startsWith(u8, data, verify)) .verify else .other, .member = member };
    }

    fn capture(self: *NativeMetadataSchedule, stream: std.net.Stream, body: []const u8, response: []const u8) !bool {
        const request = try call(body);
        if (request.member) |member| {
            var hold = false;
            if (request.kind == .verify) {
                if (self.phase == .collect_verify) {
                    self.initial_verify_mask |= bit(member);
                    if (@popCount(self.initial_verify_mask) > 4) return error.FixtureTooManyInitialVerifyGroups;
                    self.held_verify_counts[member] += 1;
                    hold = true;
                } else if (self.phase == .gas_boundary and self.initial_verify_mask & bit(member) != 0 and self.release_verify_mask & bit(member) == 0) hold = true;
            } else if (request.kind == .gas) {
                // Each member is an ISM address decoded from actual calldata,
                // not one of the sixteen transport URL path indices.
                if (self.module_responses[member] != 8 or self.verify_responses[member] != 8) return error.FixtureGasBeforeCachedReads;
                if (self.phase != .release_selected_gas) {
                    self.cached_gas_members |= bit(member);
                    self.gas_mask |= bit(member);
                    self.held_gas_counts[member] += 1;
                    hold = true;
                } else {
                    // Only the two actually gated children may win. Other
                    // healthy gas replies stay owned until real cancellation.
                    hold = self.gas_mask & bit(member) == 0;
                }
            }
            if (hold) {
                if (self.held_count == self.held.len) return error.FixtureScheduleReplyLimit;
                const owned = try std.heap.page_allocator.dupe(u8, response);
                self.held[self.held_count] = .{ .stream = stream, .response = owned, .call = request };
                self.held_count += 1;
                self.held_peak = @max(self.held_peak, self.held_count);
                return true;
            }
        }
        return false;
    }

    fn sent(self: *NativeMetadataSchedule, request: Call) void {
        const member = request.member orelse return;
        switch (request.kind) {
            .module_type => self.module_responses[member] += 1,
            .verify => self.verify_responses[member] += 1,
            .gas => self.gas_responses[member] += 1,
            .other => {},
        }
    }

    fn inspectSlots(self: *NativeMetadataSchedule) !Slots {
        self.runtime.mutex.lock();
        defer self.runtime.mutex.unlock();
        var result: Slots = .{};
        for (self.runtime.sessions) |entry| if (entry) |session| {
            result.total += 1;
            const request = try call(session.original.body);
            switch (request.kind) {
                .verify => result.verify += 1,
                .gas => result.gas += 1,
                else => result.other += 1,
            }
        };
        return result;
    }

    fn pressure(self: *NativeMetadataSchedule, verify: usize, gas: usize) !void {
        self.last_slots = try self.inspectSlots();
        if (self.last_slots.total != 4 or self.last_slots.verify != verify or self.last_slots.gas != gas or self.last_slots.other != 0) return error.FixtureUnexpectedRealPoolState;
        // The mutex is released before calling the Pool. The live held HTTP
        // replies prevent these four real sessions completing across this call.
        const selector = try evm.codecs.hexAlloc(std.heap.page_allocator, &evm.codecs.selector("moduleType()"));
        defer std.heap.page_allocator.free(selector);
        const probe = try std.fmt.allocPrint(std.heap.page_allocator, "{{\"jsonrpc\":\"2.0\",\"id\":99999,\"method\":\"eth_call\",\"params\":[{{\"to\":\"0x0000000000000000000000000000000000000001\",\"data\":\"{s}\"}},\"0x2a\"]}}", .{selector});
        defer std.heap.page_allocator.free(probe);
        if (self.runtime.submit(probe, 20000, 20000, 16384)) |handle| {
            self.runtime.cancel(handle);
            return error.FixtureExpectedRealPoolPressure;
        } else |err| {
            if (err != error.RpcPoolSessionsFull) return err;
            self.real_pressure_refusals += 1;
        }
    }

    fn flush(self: *NativeMetadataSchedule) !void {
        var index: usize = 0;
        while (index < self.held_count) {
            const item = self.held[index];
            const release = (self.phase == .release_selected_gas and (item.call.kind == .verify or (item.call.kind == .gas and self.gas_mask & bit(item.call.member.?) != 0))) or (self.phase == .gas_boundary and item.call.kind == .verify and self.release_verify_mask & bit(item.call.member.?) != 0);
            if (!release) {
                index += 1;
                continue;
            }
            self.held_count -= 1;
            self.held[index] = self.held[self.held_count];
            defer item.stream.close();
            defer std.heap.page_allocator.free(item.response);
            if (try writeMetadataResponse(item.stream, item.response)) self.sent(item.call);
        }
    }

    fn progress(self: *NativeMetadataSchedule) !void {
        if (self.phase == .release_selected_gas) return self.flush();
        if (self.timer.read() > 5 * std.time.ns_per_s) return error.FixtureScheduleBarrierTimeout;
        if (self.phase == .collect_verify and @popCount(self.initial_verify_mask) == 4) {
            var ready = true;
            for (0..16) |member| {
                if (self.initial_verify_mask & bit(member) != 0 and self.held_verify_counts[member] != 8) ready = false;
            }
            if (ready) {
                try self.pressure(4, 0);
                for (0..16) |member| {
                    if (self.initial_verify_mask & bit(member) != 0 and @popCount(self.release_verify_mask) < 2) self.release_verify_mask |= bit(member);
                }
                self.phase = .gas_boundary;
            }
        } else if (self.phase == .gas_boundary and @popCount(self.gas_mask) == 2) {
            var ready = true;
            for (0..16) |member| {
                if (self.gas_mask & bit(member) != 0 and self.held_gas_counts[member] != 8) ready = false;
            }
            if (ready) {
                try self.pressure(2, 2);
                self.phase = .release_selected_gas;
            }
        }
        try self.flush();
    }

    fn clear(self: *NativeMetadataSchedule) void {
        for (self.held[0..self.held_count]) |item| {
            item.stream.close();
            std.heap.page_allocator.free(item.response);
        }
        self.held_count = 0;
    }

    fn failure(self: *NativeMetadataSchedule, err: anyerror) void {
        self.abort.store(true, .release);
        self.last_slots = self.inspectSlots() catch self.last_slots;
        std.debug.print("NATIVE_METADATA_SCHEDULE_FAILURE phase={s} error={s} slots={d} verify={d} gas={d} held={d} peak={d} verify_groups={d} gas_groups={d} pressure_checks={d} cached_members={d}\n", .{ @tagName(self.phase), @errorName(err), self.last_slots.total, self.last_slots.verify, self.last_slots.gas, self.held_count, self.held_peak, @popCount(self.initial_verify_mask), @popCount(self.gas_mask), self.real_pressure_refusals, @popCount(self.cached_gas_members) });
    }
};

fn writeMetadataResponse(stream: std.net.Stream, response: []const u8) !bool {
    var header_buffer: [160]u8 = undefined;
    const header = try std.fmt.bufPrint(&header_buffer, "HTTP/1.1 200 Fixture\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{response.len});
    stream.writeAll(header) catch |err| switch (err) {
        error.BrokenPipe, error.ConnectionResetByPeer => return false,
        else => return err,
    };
    stream.writeAll(response) catch |err| switch (err) {
        error.BrokenPipe, error.ConnectionResetByPeer => return false,
        else => return err,
    };
    return true;
}

fn waitNativeMetadataPoolDrain(runtime: *Pool) !void {
    var timer = try std.time.Timer.start();
    while (true) {
        runtime.mutex.lock();
        const empty = for (runtime.sessions) |entry| {
            if (entry != null) break false;
        } else true;
        if (empty) {
            // No submitters remain after drainExecutor; the owner has retired
            // every peer/native handle before clearing each protected slot.
            runtime.mutex.unlock();
            return;
        }
        runtime.mutex.unlock();
        if (timer.read() > 5 * std.time.ns_per_s) return error.FixturePoolDrainTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

test "native shared Pool preserves cached verification across deterministic four slot gas pressure and drains" {
    const allocator = std.testing.allocator;
    const library = try pool_fixture.nativeLibrary(allocator);
    defer allocator.free(library);
    var server = try NativeMetadataServer.init();
    var server_live = false;
    var server_closed = false;
    defer if (!server_closed) {
        if (server_live) server.deinit() else server.listener.deinit();
    };
    var owned_urls: [16][]u8 = undefined;
    var urls: [16][]const u8 = undefined;
    for (&owned_urls, &urls, 0..) |*owned, *url, index| {
        owned.* = try server.url(allocator, index);
        url.* = owned.*;
    }
    defer for (&owned_urls) |url| allocator.free(url);
    var observer: MetadataPoolObserver = .{};
    const runtime = try Pool.start(allocator, .{
        .library_path = library,
        .observer = observer.interface(),
        .urls = &urls,
        .strategy = .{ .quorum = .{ .threshold = 8, .max_attempts = 1, .retry_delay_ms = 1 } },
        .max_sessions = 4,
        .max_concurrent = 128,
        .max_pending = 512,
        .max_response_bytes = 16384,
        .max_request_bytes = 16384,
        .max_reserved_bytes = 64 * 1024 * 1024,
    });
    var runtime_live = true;
    defer if (runtime_live) runtime.deinit();
    var schedule: NativeMetadataSchedule = .{ .runtime = runtime, .timer = try std.time.Timer.start() };
    server.schedule = &schedule;
    try server.start();
    server_live = true;
    // Stop/join the server before the Pool is freed on every error path too.
    defer if (!server_closed) {
        server.deinit();
        server_closed = true;
        server_live = false;
    };
    const root = try parallel.Root.start(allocator, .{ .max_retained_jobs = 128 });
    defer root.deinit();
    var client = try evm.RpcClient.init(allocator, urls[0], .{
        .async_pool = runtime,
        .exchange = .{ .context = runtime, .fetch_fn = blockingPoolExchange },
        .max_response_bytes = 16384,
        .timeout_ms = 20000,
        .connect_timeout_ms = 20000,
    });
    var client_live = true;
    defer if (client_live) client.deinit();
    var origin: evm_source.LocalOrigin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
    var source: evm_source.Source(evm_source.LocalOrigin) = .{ .allocator = allocator, .client = &client, .block_number = 42, .origin = &origin };
    var builder: metadata.Builder(@TypeOf(source)) = .{ .allocator = allocator, .source = &source, .executor = &root.executor, .cancel = &schedule.abort };
    const encoded = builder.build(@splat(0), message()) catch |err| {
        schedule.abort.store(true, .release);
        server.deinit();
        server_closed = true;
        server_live = false;
        // Server-owned proof fields are stable only after its thread joins.
        schedule.failure(err);
        try server.check();
        return err;
    };
    defer allocator.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 16);
    var selected: usize = 0;
    var selected_mask: u16 = 0;
    for (0..16) |index| {
        if ((try decoded.metadataAt(index)) != null) {
            selected += 1;
            selected_mask |= NativeMetadataSchedule.bit(index);
        }
    }
    try std.testing.expectEqual(@as(usize, 2), selected);
    try drainExecutor(root);
    try waitNativeMetadataPoolDrain(runtime);
    try observer.expectClean();
    // Join before reading schedule's server-owned non-atomic proof fields.
    server.deinit();
    server_live = false;
    server_closed = true;
    // Pool.deinit joins the real native owner and asserts retained response
    // accounting is zero, after the logical jobs and all slots have drained.
    client.deinit();
    client_live = false;
    runtime.deinit();
    runtime_live = false;
    try std.testing.expectEqual(NativeMetadataSchedule.Phase.release_selected_gas, schedule.phase);
    try std.testing.expectEqual(@as(usize, 2), schedule.real_pressure_refusals);
    try std.testing.expectEqual(schedule.gas_mask, selected_mask);
    for (0..16) |member| {
        if (selected_mask & NativeMetadataSchedule.bit(member) == 0) continue;
        try std.testing.expectEqual(@as(usize, 8), schedule.module_responses[member]);
        try std.testing.expectEqual(@as(usize, 8), schedule.verify_responses[member]);
        try std.testing.expectEqual(@as(usize, 8), schedule.gas_responses[member]);
    }
    try std.testing.expectEqual(@as(usize, 2), @as(usize, @popCount(schedule.cached_gas_members)));
    try std.testing.expectEqual(@as(usize, 0), schedule.held_count);
    try server.check();
}
