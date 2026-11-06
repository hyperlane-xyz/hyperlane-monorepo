//! Native relayer operation durability plus Rust retry/status interoperability.
//! All accepted state and exact signed bytes commit before external effects.
const std = @import("std");
const db = @import("../db/root.zig");
const lifecycle = @import("../runtime/relayer.zig");
const native = @import("store.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
const prefix = "zig_relayer_operation_v1/";
pub const Times = struct { unix_ms: u64, monotonic_ms: u64 };
pub const ObservationClock = struct {
    context: *anyopaque,
    now_fn: *const fn (*anyopaque) anyerror!Times,
    pub fn now(self: ObservationClock) !Times {
        return self.now_fn(self.context);
    }
};
pub const Deadline = struct { unix_ms: u64, delay_ms: u64 };
pub const Options = struct { id: Hash, context: Hash, nonce: u32, destination: u32, policy: lifecycle.Policy = .{} };
const Record = struct { version: u8 = 1, context: Hash, nonce: u32, destination: u32, operation: lifecycle.Operation, deadline: ?Deadline, transaction_bytes: ?[]const u8 };
pub const Imported = struct { retry_count: u32, next_attempt_ms: u64, status: db.json.Status, parked: bool, normalized_manual: bool };

pub fn importConfirmation(versioned: ?db.json.RetryState, status: ?db.json.Status) bool {
    return status != null and status.? == .Confirm and versioned != null and versioned.?.next_attempt_at_millis != null;
}

fn reason(status: db.json.Status) ?db.json.ReprepareReason {
    return if (status == .Retry) status.Retry else null;
}
fn retryKind(value: ?db.json.ReprepareReason) lifecycle.RetryReason {
    return if (value != null and value.? == .AwaitingValidatorSignatures) .awaiting_signatures else .transient;
}

pub fn importRetry(versioned: ?db.json.RetryState, legacy_count: u32, status_: ?db.json.Status, max_retries: u32, now: Times) Imported {
    var status = status_ orelse .FirstPrepareAttempt;
    var count = legacy_count;
    var state = versioned;
    if (state) |value| {
        if (legacy_count > value.retry_count) state = null else count = value.retry_count;
    }
    const manual = status == .Retry and status.Retry == .Manual;
    if (manual) return .{ .retry_count = 0, .next_attempt_ms = 0, .status = status, .parked = false, .normalized_manual = true };
    var next: u64 = 0;
    if (state) |value| {
        if (value.next_attempt_at_millis) |at| if (at > now.unix_ms) {
            const remaining = @min(at - now.unix_ms, value.retry_delay_millis.?);
            next = now.monotonic_ms +| remaining;
            if (value.reason) |retry_reason| status = .{ .Retry = retry_reason };
        };
    } else if (count > 0) {
        next = now.monotonic_ms +| (lifecycle.retryDelaySeconds(count, max_retries, retryKind(reason(status)), 0) *| 1000);
    }
    if (status == .Confirm) status = .FirstPrepareAttempt;
    return .{ .retry_count = count, .next_attempt_ms = next, .status = status, .parked = count >= max_retries, .normalized_manual = false };
}

pub const Operation = struct {
    allocator: Allocator,
    store: *native.Store,
    options: Options,
    value: lifecycle.Operation,
    deadline: ?Deadline = null,
    transaction_bytes: ?[]u8 = null,
    current_status: db.json.Status = .FirstPrepareAttempt,
    row_digest: ?Hash = null,
    status_row: ?db.json.Status = null,
    parked: bool = false,
    pub const max_transaction_bytes = 128 * 1024;
    pub const max_record_bytes = 1024 * 1024;

    pub fn open(allocator: Allocator, store: *native.Store, options: Options, now: Times) !Operation {
        const bytes = try store.typed.get(allocator, prefix, &options.id);
        defer if (bytes) |raw| allocator.free(raw);
        const status = try store.status(options.id);
        var self: Operation = .{ .allocator = allocator, .store = store, .options = options, .value = .{ .id = options.id, .policy = options.policy }, .row_digest = digest(bytes), .status_row = status };
        errdefer if (self.transaction_bytes) |raw| allocator.free(raw);
        if (bytes) |raw| {
            if (raw.len > max_record_bytes) return error.OperationRecordTooLarge;
            var decoded = try std.json.parseFromSlice(Record, allocator, raw, .{ .duplicate_field_behavior = .@"error" });
            defer decoded.deinit();
            const record = decoded.value;
            if (record.version != 1 or record.nonce != options.nonce or record.destination != options.destination or !std.mem.eql(u8, &record.context, &options.context) or !std.mem.eql(u8, &record.operation.id, &options.id)) return error.OperationContextChanged;
            self.value = record.operation;
            self.value.policy = options.policy;
            self.deadline = record.deadline;
            self.value.next_attempt_ms = 0;
            if (record.deadline) |at| if (at.unix_ms > now.unix_ms) {
                self.value.next_attempt_ms = now.monotonic_ms +| @min(at.unix_ms - now.unix_ms, at.delay_ms);
            };
            if ((record.transaction_bytes != null) != (self.value.transaction != null)) return error.OperationMissingSignedBytes;
            if (record.transaction_bytes) |signed| {
                if (signed.len == 0 or signed.len > max_transaction_bytes) return error.InvalidTransactionSize;
                var hash: Hash = undefined;
                std.crypto.hash.sha3.Keccak256.hash(signed, &hash, .{});
                if (!std.mem.eql(u8, &hash, &self.value.transaction.?)) return error.StoredTransactionHashMismatch;
                self.transaction_bytes = try allocator.dupe(u8, signed);
            }
            self.current_status = status orelse .FirstPrepareAttempt;
            self.parked = !self.value.confirmation_started and self.value.retries >= options.policy.max_retries;
        } else {
            const versioned = try store.retryState(options.id);
            const legacy_count = try store.retryCount(options.id);
            const imported = importRetry(versioned, legacy_count, status, options.policy.max_retries, now);
            self.value.retries = imported.retry_count;
            self.value.next_attempt_ms = imported.next_attempt_ms;
            self.current_status = imported.status;
            self.value.confirmation_started = importConfirmation(versioned, status) and legacy_count <= versioned.?.retry_count;
            if (self.value.confirmation_started) self.current_status = status.?;
            self.parked = imported.parked;
            if (self.value.confirmation_started) self.parked = false;
            if (!imported.normalized_manual and imported.next_attempt_ms > now.monotonic_ms and versioned != null and legacy_count <= versioned.?.retry_count) {
                if (versioned.?.next_attempt_at_millis) |at| self.deadline = .{ .unix_ms = at, .delay_ms = versioned.?.retry_delay_millis.? };
            }
        }
        if (status != null and status.? == .Retry and status.?.Retry == .Manual and self.value.stage != .delivered) {
            self.value.retries = 0;
            self.value.next_attempt_ms = 0;
            self.value.stage = if (self.value.transaction == null) .pending else .confirming;
            self.deadline = null;
            self.parked = false;
            self.current_status = .{ .Retry = .Manual };
        }
        // Opening alone has no broadcast/signing effects. Sealing imported
        // retry state also normalizes legacy Manual atomically with its status.
        try self.persist(self.value, self.transaction_bytes, now, self.current_status);
        return self;
    }

    pub fn deinit(self: *Operation) void {
        if (self.transaction_bytes) |raw| self.allocator.free(raw);
        self.* = undefined;
    }

    pub fn apply(self: *Operation, event: lifecycle.Event, now: Times, retry_reason: ?db.json.ReprepareReason) !lifecycle.Effect {
        if (event == .transaction_built) return error.UseRecordTransaction;
        var next = self.value;
        const effect = try next.apply(if (event == .already_delivered) .{ .already_delivered = .{ .finalized = event.already_delivered.finalized, .now_ms = now.monotonic_ms } } else event);
        if (std.meta.eql(next, self.value)) return effect;
        const status: db.json.Status = if (event == .already_delivered) .{ .Confirm = if (next.transaction == null) .AlreadySubmitted else .SubmittedBySelf } else switch (next.stage) {
            .ready => .ReadyToSubmit,
            .submitting, .confirming => if (next.confirmation_started) .{ .Confirm = .SubmittedBySelf } else .ReadyToSubmit,
            .delivered => .{ .Confirm = if (next.transaction == null) .AlreadySubmitted else .SubmittedBySelf },
            .pending => if (event == .retry or event == .delay) .{ .Retry = retry_reason orelse .ErrorBuildingMetadata } else self.current_status,
            else => self.current_status,
        };
        try self.persist(next, self.transaction_bytes, now, status);
        self.value = next;
        self.current_status = status;
        self.parked = false; // Running work parks via its durable long deadline.
        return effect;
    }

    pub fn recordTransaction(self: *Operation, generation: u64, raw: []const u8, now: Times) !lifecycle.Effect {
        if (raw.len == 0 or raw.len > max_transaction_bytes) return error.InvalidTransactionSize;
        var hash: Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(raw, &hash, .{});
        var next = self.value;
        const effect = try next.apply(.{ .transaction_built = .{ .generation = generation, .transaction = hash } });
        const owned = try self.allocator.dupe(u8, raw);
        errdefer self.allocator.free(owned);
        const status: db.json.Status = .ReadyToSubmit;
        try self.persist(next, owned, now, status);
        if (self.transaction_bytes) |previous| self.allocator.free(previous);
        self.transaction_bytes = owned;
        self.value = next;
        self.current_status = status;
        return effect;
    }

    /// The caller has validated/replayed the context-bound payload link. Its
    /// destination Lander owns all signed transaction bytes and nonce state;
    /// do not put a synthetic transaction hash in this operation record.
    pub fn payloadEnqueued(self: *Operation, generation: u64, now: Times) !void {
        if (generation != self.value.generation) return error.StaleResponse;
        if (self.value.transaction != null or self.value.stage == .delivered or self.value.stage == .denied) return error.InvalidTransition;
        var next = self.value;
        next.stage = .ready;
        if (!next.confirmation_started) next.next_attempt_ms = 0;
        const status: db.json.Status = if (next.confirmation_started) .{ .Confirm = .SubmittedBySelf } else .ReadyToSubmit;
        try self.persist(next, null, now, status);
        self.value = next;
        self.current_status = status;
        self.parked = false;
    }

    pub fn beginConfirmation(self: *Operation, now: Times, submitted_by_self: bool) !void {
        if (self.value.confirmation_started) return;
        var next = self.value;
        next.beginConfirmation(now.monotonic_ms);
        const status: db.json.Status = .{ .Confirm = if (submitted_by_self) .SubmittedBySelf else .AlreadySubmitted };
        try self.persist(next, self.transaction_bytes, now, status);
        self.value = next;
        self.current_status = status;
        self.parked = false;
    }

    pub fn waitForFinality(self: *Operation, now: Times, delay_ms: u64) !void {
        if (!self.value.confirmationReady(now.monotonic_ms)) return;
        var next = self.value;
        next.next_attempt_ms = now.monotonic_ms +| delay_ms;
        try self.persist(next, self.transaction_bytes, now, self.current_status);
        self.value = next;
    }

    /// Only after the caller independently checks finalized delivery for this
    /// canonical message and a finalized associated Lander payload.
    pub fn payloadDelivered(self: *Operation, now: Times) !void {
        if (self.value.transaction != null) return error.InvalidTransition;
        var next = self.value;
        _ = try next.apply(.{ .already_delivered = .{ .finalized = true, .now_ms = now.monotonic_ms } });
        const status: db.json.Status = .{ .Confirm = .SubmittedBySelf };
        try self.persist(next, null, now, status);
        self.value = next;
        self.current_status = status;
        self.parked = false;
    }

    fn persist(self: *Operation, value: lifecycle.Operation, signed: ?[]const u8, now: Times, status: db.json.Status) !void {
        var encoded_value = value;
        encoded_value.next_attempt_ms = 0;
        const deadline: ?Deadline = if (value.next_attempt_ms > now.monotonic_ms)
            (if (value.next_attempt_ms == self.value.next_attempt_ms and self.deadline != null) self.deadline else .{ .unix_ms = now.unix_ms +| (value.next_attempt_ms - now.monotonic_ms), .delay_ms = value.next_attempt_ms - now.monotonic_ms })
        else
            null;
        const record = try std.json.Stringify.valueAlloc(self.allocator, Record{ .context = self.options.context, .nonce = self.options.nonce, .destination = self.options.destination, .operation = encoded_value, .deadline = deadline, .transaction_bytes = signed }, .{});
        defer self.allocator.free(record);
        if (record.len > max_record_bytes) return error.OperationRecordTooLarge;
        const retry: db.json.RetryState = .{ .retry_count = value.retries, .next_attempt_at_millis = if (deadline) |at| at.unix_ms else null, .retry_delay_millis = if (deadline) |at| at.delay_ms else null, .reason = reason(status) };
        const retry_bytes = try retry.toJson(self.allocator);
        defer self.allocator.free(retry_bytes);
        const status_bytes = try status.toJson(self.allocator);
        defer self.allocator.free(status_bytes);
        var count: [4]u8 = undefined;
        std.mem.writeInt(u32, &count, value.retries, .big);
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        const current = try self.store.typed.get(self.allocator, prefix, &self.options.id);
        defer if (current) |raw| self.allocator.free(raw);
        if (!std.meta.eql(digest(current), self.row_digest) or !std.meta.eql(try self.store.status(self.options.id), self.status_row)) return error.StaleOperationOwner;
        var batch = try self.store.typed.batch(self.allocator);
        defer batch.deinit();
        try batch.put(prefix, &self.options.id, record);
        try batch.put(db.keys.Table.pending_message_retry_count.prefix(), &self.options.id, &count);
        try batch.put(db.keys.Table.pending_message_retry_state.prefix(), &self.options.id, retry_bytes);
        try batch.put(db.keys.Table.status_by_message_id.prefix(), &self.options.id, status_bytes);
        if (value.stage == .delivered) {
            var nonce: [4]u8 = undefined;
            std.mem.writeInt(u32, &nonce, self.options.nonce, .big);
            const pending = try db.keys.pendingDestination(self.allocator, self.options.destination);
            defer self.allocator.free(pending);
            var canonical = try self.store.messageByNonce(self.options.nonce);
            defer if (canonical) |*message| message.deinit();
            if (canonical != null and std.mem.eql(u8, &canonical.?.value.id(), &self.options.id)) try batch.put(db.keys.Table.nonce_processed.prefix(), &nonce, &.{1});
            const indexed = try self.store.typed.get(self.allocator, pending, &nonce);
            defer if (indexed) |id| self.allocator.free(id);
            if (indexed != null and std.mem.eql(u8, indexed.?, &self.options.id)) try batch.delete(pending, &nonce);
            try batch.delete(db.keys.Table.terminally_dropped_message_by_id.prefix(), &self.options.id);
        }
        try batch.commitSync();
        self.deadline = deadline;
        self.row_digest = digest(record);
        self.status_row = status;
    }
};

fn digest(bytes: ?[]const u8) ?Hash {
    const raw = bytes orelse return null;
    var hash: Hash = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &hash, .{});
    return hash;
}

test "Rust retry import preserves manual authority stale-version precedence and rollback clamps" {
    const now: Times = .{ .unix_ms = 1000, .monotonic_ms = 10 };
    const state: db.json.RetryState = .{ .retry_count = 4, .next_attempt_at_millis = 50000, .retry_delay_millis = 1000, .reason = .AwaitingValidatorSignatures };
    const restored = importRetry(state, 2, .{ .Retry = .Manual }, 3, now);
    try std.testing.expectEqual(@as(u32, 0), restored.retry_count);
    try std.testing.expect(!restored.parked);
    const clamped = importRetry(state, 2, .FirstPrepareAttempt, 66, now);
    try std.testing.expectEqual(@as(u64, 1010), clamped.next_attempt_ms);
    try std.testing.expectEqual(db.json.Status{ .Retry = .AwaitingValidatorSignatures }, clamped.status);
    const legacy = importRetry(state, 5, .FirstPrepareAttempt, 66, now);
    try std.testing.expectEqual(@as(u32, 5), legacy.retry_count);
    try std.testing.expectEqual(@as(u64, 180010), legacy.next_attempt_ms);
    const confirmed = importRetry(null, 0, .{ .Confirm = .SubmittedBySelf }, 66, now);
    try std.testing.expectEqual(db.json.Status.FirstPrepareAttempt, confirmed.status);
}
