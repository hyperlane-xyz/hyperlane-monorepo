//! Relayer message-submission and processor metrics. A role-wide bounded tracker
//! owns all retained labels; message IDs are keys, never Prometheus labels.
const std = @import("std");
const metrics = @import("metrics.zig");
const db = @import("../db/json.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;

pub const OperationPhase = enum { prepared, submitted, confirmed, failed, dropped };
pub const Queue = enum { prepare_queue, submit_queue, confirm_queue };
pub const MetadataStatus = enum { success, failure };
pub const WaitEnd = enum { recovered, ended, cancelled };

pub const MetadataBuildInput = struct {
    app_context: ?[]const u8,
    status: MetadataStatus,
    duration_ns: u64,
};
pub const PendingInput = struct {
    message_id: Hash,
    app_context: ?[]const u8,
    first_seen_unix_seconds: u64,
};
pub const WaitInput = struct {
    message_id: Hash,
    app_context: ?[]const u8,
    unix_timestamp_seconds: u64,
    monotonic_ms: u64,
};
pub const WaitObservation = struct {
    first_observation: bool,
    elapsed_ms: u64,
};
pub const MetadataResult = enum { success, failure, awaiting_validator_signatures, cancelled };
pub const MetadataObserver = struct {
    context: *anyopaque,
    start_fn: ?*const fn (*anyopaque) anyerror!void = null,
    complete_fn: *const fn (*anyopaque, MetadataResult) anyerror!void,

    pub fn start(self: MetadataObserver) !void {
        if (self.start_fn) |function| try function(self.context);
    }

    pub fn complete(self: MetadataObserver, result: MetadataResult) !void {
        try self.complete_fn(self.context, result);
    }
};
pub const TrackerOptions = struct {
    max_active: usize,
    max_bytes: usize,
    max_label_bytes: usize = 4096,
};

const Labels = struct {
    origin: []const u8,
    remote: []const u8,
    app_context: []const u8,

    fn matches(self: Labels, other: Labels) bool {
        return std.mem.eql(u8, self.origin, other.origin) and std.mem.eql(u8, self.remote, other.remote) and std.mem.eql(u8, self.app_context, other.app_context);
    }

    fn values(self: Labels) [3][]const u8 {
        return .{ self.app_context, self.origin, self.remote };
    }
};

const Entry = struct {
    arena: std.heap.ArenaAllocator,
    labels: Labels,
    bytes: usize,
    pending_references: usize = 0,
    pending_first_seen: i64 = 0,
    wait_active: bool = false,
    wait_started_ms: u64 = 0,
    wait_unix_seconds: i64 = 0,

    fn create(parent: Allocator, labels: Labels, bytes: usize) !*Entry {
        const self = try parent.create(Entry);
        errdefer parent.destroy(self);
        self.* = .{ .arena = std.heap.ArenaAllocator.init(parent), .labels = undefined, .bytes = bytes };
        errdefer self.arena.deinit();
        const a = self.arena.allocator();
        const origin = try a.dupe(u8, labels.origin);
        const remote = try a.dupe(u8, labels.remote);
        const app_context = try a.dupe(u8, labels.app_context);
        self.labels = .{ .origin = origin, .remote = remote, .app_context = app_context };
        return self;
    }

    fn destroy(self: *Entry, parent: Allocator) void {
        self.arena.deinit();
        parent.destroy(self);
    }
};

pub const WaitTracker = struct {
    allocator: Allocator,
    registry: *metrics.Registry,
    options: TrackerOptions,
    entries: std.AutoHashMapUnmanaged(Hash, *Entry) = .empty,
    bytes: usize = 0,
    mutex: std.Thread.Mutex = .{},

    pub fn init(a: Allocator, registry: *metrics.Registry, options: TrackerOptions) !*WaitTracker {
        if (options.max_active == 0 or options.max_bytes == 0 or options.max_label_bytes == 0) return error.InvalidMetricsLimit;
        const self = try a.create(WaitTracker);
        self.* = .{ .allocator = a, .registry = registry, .options = options };
        return self;
    }

    /// Join every lane/producer before destruction. Registry may outlive tracker.
    pub fn deinit(self: *WaitTracker) void {
        var iterator = self.entries.iterator();
        while (iterator.next()) |entry| entry.value_ptr.*.destroy(self.allocator);
        self.entries.deinit(self.allocator);
        self.allocator.destroy(self);
    }

    pub fn activeCount(self: *WaitTracker) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.entries.count();
    }

    pub fn retainedBytes(self: *WaitTracker) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.bytes;
    }

    fn labelsFor(self: *WaitTracker, adapter: *const Adapter, app_context: ?[]const u8) !Labels {
        const labels: Labels = .{ .origin = adapter.origin, .remote = adapter.remote, .app_context = app_context orelse "Unknown" };
        for ([_][]const u8{ labels.origin, labels.remote, labels.app_context }) |label| {
            if (label.len > self.options.max_label_bytes or !std.unicode.utf8ValidateSlice(label)) return error.InvalidMetricLabel;
        }
        return labels;
    }

    fn entryBytes(labels: Labels) !usize {
        var total: usize = @sizeOf(Entry) + @sizeOf(Hash);
        for ([_][]const u8{ labels.origin, labels.remote, labels.app_context }) |label| total = try std.math.add(usize, total, label.len);
        return total;
    }

    fn getOrCreate(self: *WaitTracker, message_id: Hash, labels: Labels) !struct { entry: *Entry, created: bool } {
        if (self.entries.get(message_id)) |entry| return .{ .entry = entry, .created = false };
        const required = try entryBytes(labels);
        if (self.entries.count() >= self.options.max_active or required > self.options.max_bytes -| self.bytes) return error.MetricTrackerLimit;
        const entry = try Entry.create(self.allocator, labels, required);
        errdefer entry.destroy(self.allocator);
        try self.entries.put(self.allocator, message_id, entry);
        self.bytes += required;
        return .{ .entry = entry, .created = true };
    }

    fn remove(self: *WaitTracker, message_id: Hash, entry: *Entry) void {
        const removed = self.entries.fetchRemove(message_id) orelse return;
        std.debug.assert(removed.value == entry);
        self.bytes -= entry.bytes;
    }

    fn syncPending(self: *WaitTracker, labels: Labels) !void {
        var active: u64 = 0;
        var oldest: ?i64 = null;
        var iterator = self.entries.iterator();
        while (iterator.next()) |item| {
            const entry = item.value_ptr.*;
            if (entry.pending_references == 0 or !entry.labels.matches(labels)) continue;
            active +|= 1;
            if (oldest == null or entry.pending_first_seen < oldest.?) oldest = entry.pending_first_seen;
        }
        const values = labels.values();
        try self.registry.update("hyperlane_pending_message_active", &values, .{ .set_int = wrappingI64(active) });
        try self.registry.update("hyperlane_pending_message_oldest_timestamp_seconds", &values, .{ .set_int = oldest orelse 0 });
    }

    fn syncWait(self: *WaitTracker, labels: Labels) !void {
        var active: u64 = 0;
        var oldest: ?i64 = null;
        var iterator = self.entries.iterator();
        while (iterator.next()) |item| {
            const entry = item.value_ptr.*;
            if (!entry.wait_active or !entry.labels.matches(labels)) continue;
            active +|= 1;
            if (oldest == null or entry.wait_unix_seconds < oldest.?) oldest = entry.wait_unix_seconds;
        }
        const values = labels.values();
        try self.registry.update("hyperlane_metadata_wait_active", &values, .{ .set_int = wrappingI64(active) });
        try self.registry.update("hyperlane_metadata_wait_oldest_timestamp_seconds", &values, .{ .set_int = oldest orelse 0 });
    }

    fn waitEvent(self: *WaitTracker, labels: Labels, event: []const u8) !void {
        try self.registry.update("hyperlane_metadata_wait_event_count", &.{ labels.app_context, labels.origin, labels.remote, event }, .{ .add_int = 1 });
    }

    fn recordPending(self: *WaitTracker, adapter: *Adapter, input: PendingInput) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const labels = try self.labelsFor(adapter, input.app_context);
        const found = try self.getOrCreate(input.message_id, labels);
        const first = found.entry.pending_references == 0;
        if (!first) {
            found.entry.pending_references +|= 1;
            return false;
        }
        found.entry.pending_references = 1;
        found.entry.pending_first_seen = saturatingI64(input.first_seen_unix_seconds);
        errdefer {
            found.entry.pending_references = 0;
            if (found.created) {
                self.remove(input.message_id, found.entry);
                found.entry.destroy(self.allocator);
            }
        }
        try self.syncPending(found.entry.labels);
        return true;
    }

    fn finishPending(self: *WaitTracker, message_id: Hash) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const entry = self.entries.get(message_id) orelse return false;
        if (entry.pending_references == 0) return false;
        if (entry.pending_references > 1) {
            entry.pending_references -= 1;
            return false;
        }
        entry.pending_references = 0;
        const discard = !entry.wait_active;
        if (discard) self.remove(message_id, entry);
        defer if (discard) entry.destroy(self.allocator);
        try self.syncPending(entry.labels);
        return true;
    }

    fn recordWait(self: *WaitTracker, adapter: *Adapter, input: WaitInput) !WaitObservation {
        self.mutex.lock();
        defer self.mutex.unlock();
        const labels = try self.labelsFor(adapter, input.app_context);
        const found = try self.getOrCreate(input.message_id, labels);
        const first = !found.entry.wait_active;
        if (first) {
            found.entry.wait_active = true;
            found.entry.wait_started_ms = input.monotonic_ms;
            found.entry.wait_unix_seconds = saturatingI64(input.unix_timestamp_seconds);
            errdefer {
                found.entry.wait_active = false;
                if (found.created) {
                    self.remove(input.message_id, found.entry);
                    found.entry.destroy(self.allocator);
                }
            }
            try self.syncWait(found.entry.labels);
        }
        try self.waitEvent(found.entry.labels, "wait");
        return .{ .first_observation = first, .elapsed_ms = input.monotonic_ms -| found.entry.wait_started_ms };
    }

    fn finishWait(self: *WaitTracker, message_id: Hash, outcome: WaitEnd, monotonic_ms: u64) !?u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        const entry = self.entries.get(message_id) orelse return null;
        if (!entry.wait_active) return null;
        const elapsed = monotonic_ms -| entry.wait_started_ms;
        entry.wait_active = false;
        const discard = entry.pending_references == 0;
        if (discard) self.remove(message_id, entry);
        defer if (discard) entry.destroy(self.allocator);
        try self.syncWait(entry.labels);
        try self.waitEvent(entry.labels, if (outcome == .recovered) "recovered" else "ended");
        return elapsed;
    }
};

pub const Adapter = struct {
    allocator: Allocator,
    tracker: *WaitTracker,
    origin: []u8,
    remote: []u8,
    last_processed_nonce: u32 = 0,

    pub fn init(a: Allocator, tracker: *WaitTracker, origin: []const u8, remote: []const u8) !*Adapter {
        if (origin.len == 0 or remote.len == 0 or origin.len > tracker.options.max_label_bytes or remote.len > tracker.options.max_label_bytes or !std.unicode.utf8ValidateSlice(origin) or !std.unicode.utf8ValidateSlice(remote)) return error.InvalidMetricLabel;
        const self = try a.create(Adapter);
        errdefer a.destroy(self);
        const owned_origin = try a.dupe(u8, origin);
        errdefer a.free(owned_origin);
        const owned_remote = try a.dupe(u8, remote);
        self.* = .{ .allocator = a, .tracker = tracker, .origin = owned_origin, .remote = owned_remote };
        return self;
    }

    pub fn deinit(self: *Adapter) void {
        self.allocator.free(self.origin);
        self.allocator.free(self.remote);
        self.allocator.destroy(self);
    }

    /// Call only after the canonical processed-message store commit succeeds.
    pub fn recordProcessed(self: *Adapter, nonce: u32) !void {
        self.tracker.mutex.lock();
        defer self.tracker.mutex.unlock();
        self.last_processed_nonce = @max(self.last_processed_nonce, nonce);
        try self.tracker.registry.update("hyperlane_last_known_message_nonce", &.{ "message_processed", self.origin }, .{ .set_int = self.last_processed_nonce });
        try self.tracker.registry.update("hyperlane_messages_processed_count", &.{ self.origin, self.remote }, .{ .add_int = 1 });
    }

    pub fn recordOperation(self: *Adapter, phase: OperationPhase, app_context: ?[]const u8) !void {
        try self.tracker.registry.update("hyperlane_operations_processed_count", &.{ app_context orelse "Unknown", @tagName(phase), self.remote }, .{ .add_int = 1 });
    }

    pub fn setQueueLength(self: *Adapter, queue: Queue, status: db.Status, app_context: ?[]const u8, length: u64) !void {
        var storage: [512]u8 = undefined;
        const label = try statusLabel(status, &storage);
        try self.tracker.registry.update("hyperlane_submitter_queue_length", &.{ self.remote, @tagName(queue), label, app_context orelse "Unknown" }, .{ .set_int = wrappingI64(length) });
    }

    /// Call once for a terminal logical metadata build, never for a PIO replay.
    pub fn recordMetadataBuild(self: *Adapter, input: MetadataBuildInput) !void {
        const labels = [_][]const u8{ input.app_context orelse "Unknown", self.origin, self.remote, @tagName(input.status) };
        try self.tracker.registry.update("hyperlane_metadata_build_count", &labels, .{ .add_int = 1 });
        try self.tracker.registry.update("hyperlane_metadata_build_duration", &labels, .{ .add_real = @as(f64, @floatFromInt(input.duration_ns)) / std.time.ns_per_s });
    }

    pub fn recordPending(self: *Adapter, input: PendingInput) !bool {
        return self.tracker.recordPending(self, input);
    }

    pub fn finishPending(self: *Adapter, message_id: Hash) !bool {
        return self.tracker.finishPending(message_id);
    }

    pub fn recordMetadataWait(self: *Adapter, input: WaitInput) !WaitObservation {
        return self.tracker.recordWait(self, input);
    }

    pub fn finishMetadataWait(self: *Adapter, message_id: Hash, outcome: WaitEnd, monotonic_ms: u64) !?u64 {
        return self.tracker.finishWait(message_id, outcome, monotonic_ms);
    }
};

fn wrappingI64(value: anytype) i64 {
    const low: u64 = @truncate(value);
    return @bitCast(low);
}

fn saturatingI64(value: u64) i64 {
    return std.math.cast(i64, value) orelse std.math.maxInt(i64);
}

fn statusLabel(status: db.Status, storage: []u8) ![]const u8 {
    return switch (status) {
        .FirstPrepareAttempt => "FirstPrepareAttempt",
        .ReadyToSubmit => "ReadyToSubmit",
        .Retry => |reason| try std.fmt.bufPrint(storage, "Retry({s})", .{reprepareLabel(reason)}),
        .Confirm => |reason| try std.fmt.bufPrint(storage, "Confirm({s})", .{switch (reason) {
            .SubmittedBySelf => "Submitted by this relayer",
            .AlreadySubmitted => "Already submitted, awaiting confirmation",
            .ErrorConfirmingDelivery => "ErrorConfirmingDelivery",
            .ErrorRecordingProcessSuccess => "ErrorRecordingProcessSuccess",
        }}),
    };
}

fn reprepareLabel(reason: db.ReprepareReason) []const u8 {
    return switch (reason) {
        .Manual => "Manual retry",
        .ErrorCheckingDeliveryStatus => "Error checking message delivery status",
        .ErrorCheckingIfRecipientIsContract => "Error checking if message recipient is a contract",
        .ErrorFetchingIsmAddress => "Error fetching ISM address",
        .ErrorGettingMetadataBuilder => "Error getting message metadata builder",
        .ErrorSubmitting => "Error submitting",
        .ErrorBuildingMetadata => "Error building metadata",
        .CouldNotFetchMetadata => "Could not fetch metadata",
        .ErrorEstimatingGas => "Error estimating costs for process call",
        .ErrorCheckingGasRequirement => "Error checking if message meets gas payment requirement",
        .GasPaymentRequirementNotMet => "Gas payment requirement not met",
        .GasPaymentNotFound => "GasPaymentNotFound",
        .ExceedsMaxGasLimit => "Message delivery estimated gas exceeds max gas limit",
        .RevertedOrReorged => "Delivery transaction reverted or reorged",
        .MessageMetadataRefused => "Message metadata refused",
        .ApplicationReport => |report| switch (report) {
            .AmountBelowMinimum => "ApplicationReport(AmountBelowMinimum)",
            .MalformedMessage => "ApplicationReport(MalformedMessage)",
            .ZeroAmount => "ApplicationReport(ZeroAmount)",
        },
        .ErrorCreatingPayload => "Failed to create payload for message and metadata",
        .ErrorStoringPayloadUuidsByMessageId => "Failed to store payload uuid by message id",
        .ErrorRetrievingPayloadUuids => "Failed to retrieve payload uuids by message id",
        .ErrorRetrievingPayloadStatus => "Failed to retrieve payload uuid status by message id",
        .ErrorPersistingTerminalMessage => "Failed to persist terminal message state",
        .ErrorCreatingPayloadSuccessCriteria => "Failed to create payload success criteria",
        .AwaitingValidatorSignatures => "Awaiting validator signatures",
        .AwaitingIcaReveal => "Awaiting ICA reveal commit confirmation",
        .ErrorFetchingOriginTxSender => "Error fetching origin transaction sender",
    };
}
