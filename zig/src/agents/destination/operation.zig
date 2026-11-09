//! Native-identity durable lifecycle. The pure state machine uses a correlation
//! digest internally; chain reconciliation ALWAYS receives the full tagged ID.
//! A synchronous RocksDB batch commits signed bytes and Rust status together.
const std = @import("std");
const types = @import("types.zig");
const store = @import("../store.zig");
const db = @import("../../db/root.zig");
const pure = @import("../../runtime/relayer.zig");
const compatibility = @import("../operation.zig");
const hex = @import("../../evm/codecs.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;
const Hash = types.Hash;
const prefix = "zig_native_destination_operation_v1/";
const history_prefix = "zig_native_destination_operation_history_v1/";
const expenditure_prefix = "zig_native_destination_expenditure_v1/";
const finalized_transaction_prefix = "zig_native_finalized_transaction_v1/";
/// Lock order: origin Store mutex(es), then this shared marker mutex. The marker
/// namespace is independent of origin: one native transaction on a destination
/// is counted once even when multiple origin actors share its receipt.
pub var finalized_transaction_mutex: std.Thread.Mutex = .{};
pub const FinalizedWrite = struct { destination: u32, receipt: types.Receipt, committed: *bool };
pub const FinalizationTestFault = struct {
    pub var before_commit: std.atomic.Value(bool) = .init(false);
    pub var after_commit: std.atomic.Value(bool) = .init(false);
};
/// The caller holds finalized_transaction_mutex through its sync batch commit.
/// This stages only an authenticated transaction receipt marker, never a metric
/// or an accounting value. Old operation JSON and all Rust rows stay unchanged.
pub fn stageFinalizedTransaction(a: A, database: *db.rocks.Database, batch: *db.rocks.Batch, destination: u32, receipt: types.Receipt) !bool {
    if (!receipt.finalized) return error.FinalizedNativeReceiptRequired;
    var key: [finalized_transaction_prefix.len + 4 + 1 + 64]u8 = undefined;
    @memcpy(key[0..finalized_transaction_prefix.len], finalized_transaction_prefix);
    std.mem.writeInt(u32, key[finalized_transaction_prefix.len..][0..4], destination, .big);
    const start = finalized_transaction_prefix.len + 4;
    const count: usize = switch (receipt.identity) {
        .hash256 => |value| blk: {
            key[start] = 0;
            @memcpy(key[start + 1 ..][0..32], &value);
            break :blk start + 1 + 32;
        },
        .signature512 => |value| blk: {
            key[start] = 1;
            @memcpy(key[start + 1 ..][0..64], &value);
            break :blk start + 1 + 64;
        },
    };
    if (try database.get(a, key[0..count])) |old| {
        defer a.free(old);
        if (!std.mem.eql(u8, old, &.{1})) return error.InvalidNativeFinalizationMarker;
        return false;
    }
    try batch.put(key[0..count], &.{1});
    return true;
}

pub const Times = compatibility.Times;
pub const Options = struct {
    id: Hash,
    context: Hash,
    nonce: u32,
    origin: u32,
    destination: u32,
    kind: types.Kind = .process,
    target: ?Hash = null,
    policy: pure.Policy = .{},
    /// Process-local authority: recovering old signed effects does not admit a
    /// currently excluded canonical message into pending-operation bookkeeping.
    acknowledge_canonical: bool = true,
    /// Destination namespace, needed only by the read-only ownership probe.
    group_store: ?db.rocks.Typed = null,
};
pub const Effect = union(enum) { none, prepare: u64, build: u64, reconcile: types.Identity, broadcast: types.Identity };
const Record = struct {
    version: u8 = 1,
    context: []const u8,
    id: []const u8,
    nonce: u32,
    origin: u32,
    destination: u32,
    kind: types.Kind,
    target: ?[]const u8,
    stage: pure.Stage,
    generation: u64,
    retries: u32,
    confirmation_started: bool = false,
    deadline: ?compatibility.Deadline,
    intent: ?[]const u8,
    authorization: ?[]const u8,
    identity_kind: ?enum { hash256, signature512 },
    identity_hex: ?[]const u8,
    signed_hex: ?[]const u8,
};
pub const Operation = struct {
    allocator: A,
    store: *store.Store,
    options: Options,
    value: pure.Operation,
    current_status: db.json.Status = .FirstPrepareAttempt,
    status_row: ?db.json.Status = null,
    deadline: ?compatibility.Deadline = null,
    intent: ?[]u8 = null,
    authorization: ?[]u8 = null,
    signed: ?types.Signed = null,
    /// Last full row is the compare-and-swap token under Store.mutex.
    row: ?[]u8 = null,
    parked: bool = false,
    retiring: ?types.Receipt = null,
    retirement_proof: ?types.RetirementProof = null,
    terminal_drop: bool = false,
    callback_times: Times = .{ .unix_ms = 0, .monotonic_ms = 0 },
    pub const max_record_bytes = 64 * 1024 * 1024;
    pub fn open(a: A, origin: *store.Store, options: Options, now: Times) !*Operation {
        return openInner(a, origin, options, now, true);
    }
    /// Validate the same bounded durable record as open(), without normalizing
    /// Manual retry or writing any row on success, failure or allocation error.
    pub fn hasSignedRecovery(a: A, origin: *store.Store, options: Options, now: Times) !bool {
        origin.mutex.lock();
        defer origin.mutex.unlock();
        const self = try openInner(a, origin, options, now, false);
        defer self.deinit();
        if (self.signed != null and self.intent == null) return error.MissingNativePreparedIntent;
        const link = try origin.typed.get(a, group_link_prefix, &options.id);
        defer if (link) |bytes| a.free(bytes);
        if (link) |bytes| {
            if (bytes.len != 32) return error.InvalidNativeGroup;
            const group_store = options.group_store orelse return error.MissingNativeGroupStore;
            var journal = (try @import("../relayer/native_group.zig").Journal.load(a, group_store, bytes[0..32].*)) orelse return error.MissingNativeGroup;
            defer journal.deinit();
            const reserved = try group_store.get(a, group_nonce_prefix, &try journal.nonce());
            defer if (reserved) |value| a.free(value);
            if (reserved == null or !std.mem.eql(u8, reserved.?, &journal.id)) return error.NativeGroupNonceOwnerChanged;
            if (journal.record.phase != .included) {
                const current = try group_store.get(a, group_current_prefix, "");
                defer if (current) |value| a.free(value);
                if (current == null or !std.mem.eql(u8, current.?, &journal.id)) return error.NativeGroupNonceOwnerChanged;
            }
            var found = false;
            for (journal.record.members) |member| {
                if (!std.mem.eql(u8, &try hex.fixedHex(32, member.id), &options.id)) continue;
                if (found or member.origin != options.origin or member.nonce != options.nonce or !std.mem.eql(u8, &try hex.fixedHex(32, member.context), &options.context) or !std.mem.eql(u8, member.intent, self.intent orelse return error.NativeGroupIntentChanged)) return error.NativeGroupAuthorityChanged;
                found = true;
            }
            if (!found or journal.record.phase == .retired) return error.NativeGroupMemberNotOwned;
            if (journal.record.phase == .prepared) {
                if (self.signed != null) return error.NativeSignedTransactionConflict;
                return false;
            }
            const signed = self.signed orelse return error.NativeGroupMemberNotReady;
            var shared = try journal.signedValue(a);
            defer shared.deinit();
            if (!types.Identity.eql(signed.identity, shared.identity) or !std.mem.eql(u8, signed.bytes, shared.bytes)) return error.NativeSignedTransactionConflict;
        } else if (self.signed != null) {
            var restored_intent = try types.Prepared.restore(a, self.intent.?);
            defer restored_intent.deinit();
            if (restored_intent.authority.protocol == .starknet and restored_intent.body == .object and restored_intent.body.object.contains("batch_version")) {
                // Completed group GC removes links only after its independent
                // canonical receipt/nonce fence. Excluded canonical messages
                // can still await acknowledgment; this grants no new recovery
                // authority and leaves their settled signed bytes untouched.
                if (self.value.stage == .delivered) return false;
                return error.NativeGroupMemberNotOwned;
            }
        }
        return self.signed != null;
    }
    fn openInner(a: A, origin: *store.Store, options: Options, now: Times, normalize_manual: bool) !*Operation {
        if (options.kind == .announcement and options.target == null) return error.AnnouncementTargetRequired;
        if (options.kind == .reveal and options.target == null) return error.RevealTargetRequired;
        const self = try a.create(Operation);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .store = origin, .options = options, .value = .{ .id = options.id, .policy = options.policy } };
        errdefer self.clear();
        const bytes = try origin.typed.get(a, prefix, &options.id);
        if (bytes) |wire| {
            self.row = wire;
            if (wire.len > max_record_bytes) return error.NativeOperationTooLarge;
            var parsed = try std.json.parseFromSlice(Record, a, wire, .{ .duplicate_field_behavior = .@"error" });
            defer parsed.deinit();
            const record = parsed.value;
            if (record.version != 1 or record.kind != options.kind or ((record.target == null) != (options.target == null)) or (record.target != null and !std.mem.eql(u8, &try hex.fixedHex(32, record.target.?), &options.target.?)) or record.nonce != options.nonce or record.origin != options.origin or record.destination != options.destination or !std.mem.eql(u8, &try hex.fixedHex(32, record.context), &options.context) or !std.mem.eql(u8, &try hex.fixedHex(32, record.id), &options.id)) return error.OperationContextChanged;
            self.value.stage = record.stage;
            self.value.generation = record.generation;
            self.value.retries = record.retries;
            self.value.confirmation_started = record.confirmation_started;
            self.deadline = record.deadline;
            if (record.deadline) |at| if (at.unix_ms > now.unix_ms) {
                self.value.next_attempt_ms = now.monotonic_ms +| @min(at.unix_ms - now.unix_ms, at.delay_ms);
            };
            if (record.intent) |intent| {
                var restored = try types.Prepared.restore(a, intent);
                defer restored.deinit();
                try self.checkPrepared(&restored);
                self.intent = try a.dupe(u8, intent);
            }
            if (record.authorization) |authorization| {
                if (authorization.len == 0 or authorization.len > types.Signed.max_bytes or self.intent == null) return error.InvalidNativeOperation;
                self.authorization = try a.dupe(u8, authorization);
            }
            if ((record.identity_kind != null) != (record.identity_hex != null) or (record.identity_hex != null) != (record.signed_hex != null)) return error.InvalidNativeOperation;
            if (record.identity_kind) |kind| {
                const identity: types.Identity = switch (kind) {
                    .hash256 => .{ .hash256 = try hex.fixedHex(32, record.identity_hex.?) },
                    .signature512 => .{ .signature512 = try hex.fixedHex(64, record.identity_hex.?) },
                };
                const raw = try decode(a, record.signed_hex.?, types.Signed.max_bytes);
                defer a.free(raw);
                self.signed = try types.Signed.init(a, identity, raw);
                self.value.transaction = correlation(identity);
            }
            if (self.value.stage == .ready and self.intent == null) return error.InvalidNativeOperation;
            if ((self.value.stage == .pending or self.value.stage == .preparing or self.value.stage == .ready) and self.signed != null) return error.InvalidNativeOperation;
            if ((self.value.stage == .submitting or self.value.stage == .confirming) and (self.signed == null or self.intent == null)) return error.InvalidNativeOperation;
        } else {
            const status = if (options.kind == .process) try origin.status(options.id) else null;
            const versioned = if (options.kind == .process) try origin.retryState(options.id) else null;
            const legacy_count = if (options.kind == .process) try origin.retryCount(options.id) else 0;
            const imported = compatibility.importRetry(versioned, legacy_count, status, options.policy.max_retries, now);
            self.value.retries = imported.retry_count;
            self.value.next_attempt_ms = imported.next_attempt_ms;
            self.current_status = imported.status;
            self.value.confirmation_started = compatibility.importConfirmation(versioned, status) and legacy_count <= versioned.?.retry_count;
            if (self.value.confirmation_started and versioned.?.next_attempt_at_millis.? > now.unix_ms) self.deadline = .{ .unix_ms = versioned.?.next_attempt_at_millis.?, .delay_ms = versioned.?.retry_delay_millis.? };
            self.parked = imported.parked;
        }
        self.status_row = if (options.kind == .process) try origin.status(options.id) else null;
        if (self.status_row) |status| self.current_status = status;
        self.parked = !self.value.confirmation_started and self.value.retries >= options.policy.max_retries;
        if (normalize_manual and self.status_row != null and self.status_row.? == .Retry and self.status_row.?.Retry == .Manual and self.value.stage != .delivered) {
            var next = self.value;
            next.retries = 0;
            next.next_attempt_ms = 0;
            next.stage = if (self.signed == null) .pending else .confirming;
            self.deadline = null;
            try self.persist(next, if (self.signed == null) null else self.intent, if (self.signed == null) null else self.authorization, self.signed, now, .{ .Retry = .Manual });
        }
        return self;
    }
    fn clear(self: *Operation) void {
        if (self.intent) |bytes| self.allocator.free(bytes);
        if (self.authorization) |bytes| {
            std.crypto.secureZero(u8, bytes);
            self.allocator.free(bytes);
        }
        if (self.signed) |*signed| signed.deinit();
        if (self.row) |bytes| {
            std.crypto.secureZero(u8, bytes);
            self.allocator.free(bytes);
        }
    }
    pub fn deinit(self: *Operation) void {
        const a = self.allocator;
        self.clear();
        a.destroy(self);
    }
    fn checkPrepared(self: *Operation, value: *const types.Prepared) !void {
        const context = value.authority;
        if (self.options.target) |target| {
            if (context.target == null or !std.mem.eql(u8, &target, &context.target.?)) return error.OperationContextChanged;
        }
        if (!std.mem.eql(u8, &context.operation_id, &self.options.id) or context.kind != self.options.kind or context.origin != self.options.origin or context.destination != self.options.destination or context.generation != self.value.generation) return error.OperationContextChanged;
    }
    fn effect(self: *Operation, value: pure.Effect) !Effect {
        return switch (value) {
            .none => .none,
            .prepare => |generation| .{ .prepare = generation },
            .build_transaction => |generation| .{ .build = generation },
            .broadcast, .reconcile => |digest| blk: {
                const signed = self.signed orelse return error.InvalidNativeOperation;
                if (!std.mem.eql(u8, &digest, &correlation(signed.identity))) return error.InvalidNativeOperation;
                break :blk if (value == .broadcast) .{ .broadcast = signed.identity } else .{ .reconcile = signed.identity };
            },
        };
    }
    pub fn tick(self: *Operation, now: Times) !Effect {
        if (self.parked) return .none;
        var next = self.value;
        const result = try next.apply(.{ .tick = .{ .now_ms = now.monotonic_ms } });
        try self.persist(next, self.intent, self.authorization, self.signed, now, self.current_status);
        return self.effect(result);
    }
    /// Retain a complete public intent for a real, nonbroadcastable fee quote.
    /// Production transaction/prover work still requires prepared(gas_allowed).
    pub fn staged(self: *Operation, value: *const types.Prepared, now: Times) !void {
        try value.validate();
        try self.checkPrepared(value);
        if (self.value.stage != .preparing or self.signed != null) return error.InvalidNativeOperation;
        if (self.intent) |old| if (!std.mem.eql(u8, old, value.canonical_intent)) return error.NativeIntentConflict;
        try self.persist(self.value, value.canonical_intent, self.authorization, null, now, self.current_status);
    }
    pub fn prepared(self: *Operation, value: *const types.Prepared, gas_allowed: bool, metadata_valid: bool, now: Times) !void {
        try value.validate();
        try self.checkPrepared(value);
        var next = self.value;
        _ = try next.apply(.{ .prepared = .{ .generation = value.authority.generation, .gas_allowed = gas_allowed, .metadata_valid = metadata_valid } });
        if (self.intent) |old| if (!std.mem.eql(u8, old, value.canonical_intent)) return error.NativeIntentConflict;
        try self.persist(next, value.canonical_intent, self.authorization, self.signed, now, .ReadyToSubmit);
    }
    /// Struct address stays stable: open() returns a heap owner. One serialized
    /// execution lane may hold this callback through a bounded signing job.
    pub fn persistence(self: *Operation, now: Times) types.Persistence {
        self.callback_times = now;
        return .{ .context = self, .persistIntent = persistIntent, .persistSigned = persistSigned, .persistAuthorization = persistAuthorization, .persistAuthorizationIntent = persistAuthorizationIntent };
    }
    /// Source Lander relations can name transactions submitted by the Rust
    /// agent. A fresh native journal is not evidence those IDs are absent.
    /// Return owned UUIDs so an explicit migration/reconciliation owner may read
    /// the destination Lander database. Never clear these from receipt absence.
    pub fn inheritedPayloads(self: *Operation) ![][16]u8 {
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        if (self.options.kind != .process) return self.allocator.alloc([16]u8, 0);
        return @import("../payload_links.zig").inheritedUuids(self.allocator, self.store, self.options.id);
    }
    pub fn hasInheritedPayloads(self: *Operation) !bool {
        const values = try self.inheritedPayloads();
        defer self.allocator.free(values);
        return values.len != 0;
    }
    /// Caller already owns Store.mutex. Check at durable stage transitions and
    /// again immediately before every key/broadcast callback, including restart.
    fn guardInherited(self: *Operation) !void {
        if (self.options.kind != .process) return;
        const values = try @import("../payload_links.zig").inheritedUuids(self.allocator, self.store, self.options.id);
        defer self.allocator.free(values);
        if (values.len != 0) return error.InheritedPayloadNeedsReconciliation;
    }
    pub fn assertFresh(self: *Operation) !void {
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        return self.assertFreshLocked();
    }
    pub fn assertFreshLocked(self: *Operation) !void {
        const row = try self.store.typed.get(self.allocator, prefix, &self.options.id);
        defer if (row) |bytes| self.allocator.free(bytes);
        if ((row == null) != (self.row == null) or (row != null and !std.mem.eql(u8, row.?, self.row.?))) return error.StaleNativeOperationOwner;
        if (self.options.kind != .process) return;
        try self.guardInherited();
        if (!std.meta.eql(try self.store.status(self.options.id), self.status_row)) return error.StaleNativeOperationOwner;
        try self.assertMessageAuthorized();
    }
    /// Store.mutex is held by persistence/key boundaries. Receipt admission
    /// grants exact ID authority; it never grants authority over nonce indices.
    fn assertMessageAuthorized(self: *Operation) !void {
        var message = (try self.store.messageById(self.options.id)) orelse return error.StaleCanonicalMessage;
        defer message.deinit();
        if (message.value.nonce != self.options.nonce or message.value.origin != self.options.origin or message.value.destination != self.options.destination or !try self.store.operationMessageAuthorized(message.value)) return error.StaleCanonicalMessage;
    }
    fn assertScalarOwned(self: *Operation) !void {
        const link = try self.store.typed.get(self.allocator, group_link_prefix, &self.options.id);
        defer if (link) |bytes| self.allocator.free(bytes);
        if (link != null) return error.NativeGroupOwnsOperation;
    }
    fn persistIntent(ctx: *anyopaque, id: Hash, intent: []const u8) !void {
        const self: *Operation = @ptrCast(@alignCast(ctx));
        try self.assertScalarOwned();
        if (!std.mem.eql(u8, &id, &self.options.id) or self.value.stage != .ready or self.signed != null) return error.InvalidNativeOperation;
        if (self.intent) |old| {
            if (!std.mem.eql(u8, old, intent)) return error.NativeIntentConflict;
            try self.assertFresh();
            return;
        }
        return error.MissingNativePreparedIntent;
    }
    fn persistAuthorizationIntent(ctx: *anyopaque, id: Hash, intent: []const u8) !void {
        const self: *Operation = @ptrCast(@alignCast(ctx));
        if (!std.mem.eql(u8, &id, &self.options.id) or (self.value.stage != .preparing and self.value.stage != .ready) or self.intent == null or self.signed != null or !std.mem.eql(u8, self.intent.?, intent)) return error.InvalidNativeOperation;
        try self.assertFresh();
    }
    fn persistAuthorization(ctx: *anyopaque, id: Hash, authorization: []const u8) !void {
        const self: *Operation = @ptrCast(@alignCast(ctx));
        if (!std.mem.eql(u8, &id, &self.options.id) or self.intent == null or authorization.len == 0 or authorization.len > types.Signed.max_bytes) return error.InvalidNativeOperation;
        if (self.authorization) |old| {
            if (!std.mem.eql(u8, old, authorization)) return error.NativeAuthorizationConflict;
            try self.assertFresh();
            return;
        }
        if (self.signed != null or (self.value.stage != .preparing and self.value.stage != .ready)) return error.InvalidNativeOperation;
        try self.persist(self.value, self.intent, authorization, self.signed, self.callback_times, self.current_status);
    }
    fn persistSigned(ctx: *anyopaque, id: Hash, identity: types.Identity, bytes: []const u8) !void {
        const self: *Operation = @ptrCast(@alignCast(ctx));
        try self.assertScalarOwned();
        if (!std.mem.eql(u8, &id, &self.options.id) or self.intent == null or bytes.len == 0 or bytes.len > types.Signed.max_bytes) return error.InvalidNativeOperation;
        if (self.signed) |old| {
            if (!types.Identity.eql(old.identity, identity) or !std.mem.eql(u8, old.bytes, bytes)) return error.NativeSignedConflict;
            if (self.value.stage != .submitting and self.value.stage != .confirming) return error.InvalidNativeOperation;
            try self.assertFresh();
            return;
        }
        var next = self.value;
        _ = try next.apply(.{ .transaction_built = .{ .generation = next.generation, .transaction = correlation(identity) } });
        const signed: types.Signed = .{ .allocator = self.allocator, .identity = identity, .bytes = @constCast(bytes) };
        try self.persist(next, self.intent, self.authorization, signed, self.callback_times, .ReadyToSubmit);
    }
    pub fn broadcastResult(self: *Operation, accepted: bool, now: Times) !void {
        const signed = self.signed orelse return error.InvalidNativeOperation;
        var next = self.value;
        _ = try next.apply(.{ .broadcast_result = .{ .transaction = correlation(signed.identity), .accepted = accepted } });
        try self.persist(next, self.intent, self.authorization, self.signed, now, self.current_status);
    }
    pub fn rebroadcast(self: *Operation, now: Times) !Effect {
        const signed = self.signed orelse return error.InvalidNativeOperation;
        var next = self.value;
        const result = try next.apply(.{ .rebroadcast = .{ .transaction = correlation(signed.identity) } });
        try self.persist(next, self.intent, self.authorization, self.signed, now, self.current_status);
        return self.effect(result);
    }
    pub fn observe(self: *Operation, finalized: bool, delivered: bool, now: Times) !void {
        var next = self.value;
        if (self.options.kind != .process) {
            // Announcement/reveal owners have their own source polling cadence;
            // process-message success confirmation does not delay their completion.
            next.policy.confirm_delay_ms = 0;
            if (self.signed) |signed| {
                _ = try next.apply(.{ .delivery_observed = .{ .transaction = correlation(signed.identity), .finalized = finalized, .delivered = delivered, .now_ms = now.monotonic_ms } });
            } else if (delivered) {
                _ = try next.apply(.{ .already_delivered = .{ .finalized = finalized, .now_ms = now.monotonic_ms } });
            } else return;
            next.policy = self.value.policy;
            next.confirmation_started = false;
            if (next.stage != .delivered) next.next_attempt_ms = now.monotonic_ms +| self.options.policy.confirm_delay_ms;
            try self.persist(next, self.intent, self.authorization, self.signed, now, self.current_status);
            return;
        }
        if (self.signed) |signed| {
            _ = try next.apply(.{ .delivery_observed = .{ .transaction = correlation(signed.identity), .finalized = finalized, .delivered = delivered, .now_ms = now.monotonic_ms } });
        } else if (delivered) {
            _ = try next.apply(.{ .already_delivered = .{ .finalized = finalized, .now_ms = now.monotonic_ms } });
        } else return;
        const status: db.json.Status = if (next.confirmation_started or next.stage == .delivered) .{ .Confirm = if (self.signed == null) .AlreadySubmitted else .SubmittedBySelf } else self.current_status;
        try self.persist(next, self.intent, self.authorization, self.signed, now, status);
    }
    pub fn beginConfirmation(self: *Operation, now: Times) !void {
        if (self.value.confirmation_started) return;
        var next = self.value;
        next.beginConfirmation(now.monotonic_ms);
        try self.persist(next, self.intent, self.authorization, self.signed, now, .{ .Confirm = if (self.signed == null) .AlreadySubmitted else .SubmittedBySelf });
    }
    /// Another relayer may have delivered before this actor signed anything.
    /// Finalized observation and Rust nonce/pending updates commit together.
    pub fn alreadyDelivered(self: *Operation, finalized: bool, now: Times) !void {
        if (self.options.kind != .process) return error.ProcessOperationRequired;
        var next = self.value;
        _ = try next.apply(.{ .already_delivered = .{ .finalized = finalized, .now_ms = now.monotonic_ms } });
        try self.persist(next, self.intent, self.authorization, self.signed, now, .{ .Confirm = if (self.signed == null) .AlreadySubmitted else .SubmittedBySelf });
    }
    pub const ReceiptCommit = struct { transaction: bool = false, expenditure: bool = false };
    /// Existing accounting callers do not emit transaction observations. In
    /// particular, a Stark batch has one transaction and several member costs.
    pub fn recordExpenditure(self: *Operation, receipt: types.Receipt) !bool {
        if (receipt.expenditure == null) return false;
        return (try self.recordReceipt(receipt, null)).expenditure;
    }
    /// Newly committed actual finalized receipt, independent of fee availability.
    /// The out-latch is set after sync commit, including commit-outcome-unknown
    /// errors, so a borrowed caller can report it after all database locks unwind.
    pub fn recordFinalizedReceipt(self: *Operation, receipt: types.Receipt, committed: *bool) !ReceiptCommit {
        return self.recordReceipt(receipt, committed);
    }
    fn recordReceipt(self: *Operation, receipt: types.Receipt, finalized_committed: ?*bool) !ReceiptCommit {
        if (self.options.kind != .process) return .{};
        const signed = self.signed orelse return error.InvalidNativeOperation;
        if (!receipt.finalized or !types.Identity.eql(signed.identity, receipt.identity)) return error.FinalizedNativeReceiptRequired;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var key: [97]u8 = undefined;
        key[0..32].* = self.options.id;
        key[32] = if (signed.identity == .hash256) 0 else 1;
        const key_len: usize = switch (signed.identity) {
            .hash256 => |id| blk: {
                key[33..65].* = id;
                break :blk 65;
            },
            .signature512 => |id| blk: {
                key[33..97].* = id;
                break :blk 97;
            },
        };
        var marker: std.ArrayList(u8) = .empty;
        defer marker.deinit(a);
        if (receipt.expenditure) |spent| {
            try marker.append(a, if (signed.identity == .hash256) 0 else 1);
            switch (signed.identity) {
                .hash256 => |id| try marker.appendSlice(a, &id),
                .signature512 => |id| try marker.appendSlice(a, &id),
            }
            try marker.appendSlice(a, try db.codec.encode(a, db.codec.GasExpenditureData{ .gas_used = spent.gas_used, .tokens_used = spent.tokens_used }));
        }
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        if (finalized_committed != null) finalized_transaction_mutex.lock();
        defer if (finalized_committed != null) finalized_transaction_mutex.unlock();
        const current = try self.store.typed.get(a, prefix, &self.options.id);
        if ((current == null) != (self.row == null) or (current != null and !std.mem.eql(u8, current.?, self.row.?)) or !std.meta.eql(try self.store.status(self.options.id), self.status_row)) return error.StaleNativeOperationOwner;
        var batch = try self.store.typed.batch(a);
        defer batch.deinit();
        var result: ReceiptCommit = .{};
        if (finalized_committed != null) result.transaction = try stageFinalizedTransaction(a, self.store.typed.database, &batch.batch, self.options.destination, receipt);
        if (receipt.expenditure) |spent| {
            if (try self.store.typed.get(a, expenditure_prefix, key[0..key_len])) |old| {
                if (!std.mem.eql(u8, old, marker.items)) return error.ConflictingNativeExpenditure;
            } else {
                const old = try self.store.expenditure(self.options.id);
                const total = try db.codec.encode(a, db.codec.GasExpenditureData{ .gas_used = old.gas_used +| spent.gas_used, .tokens_used = old.tokens_used +| spent.tokens_used });
                try batch.put(db.keys.Table.gas_expenditure_for_message_id.prefix(), &self.options.id, total);
                try batch.put(expenditure_prefix, key[0..key_len], marker.items);
                result.expenditure = true;
            }
        }
        if (!result.transaction and !result.expenditure) return result;
        if (@import("builtin").is_test and finalized_committed != null) if (FinalizationTestFault.before_commit.swap(false, .acq_rel)) return error.InjectedNativeFinalizationCommitFailure;
        try batch.commitSync();
        if (finalized_committed) |latch| latch.* = latch.* or result.transaction;
        if (@import("builtin").is_test and finalized_committed != null) if (FinalizationTestFault.after_commit.swap(false, .acq_rel)) return error.NativeFinalizationCommitOutcomeUnknown;
        return result;
    }
    pub fn dropNonContract(self: *Operation, now: Times) !void {
        if (self.options.kind != .process or self.signed != null) return error.ProcessOperationRequired;
        try self.assertFresh();
        var next = self.value;
        _ = try next.apply(.deny);
        self.terminal_drop = true;
        defer self.terminal_drop = false;
        try self.persist(next, self.intent, self.authorization, null, now, self.current_status);
    }
    pub fn delay(self: *Operation, reason: db.json.ReprepareReason, delay_ms: u64, now: Times) !void {
        if (self.signed != null) return error.InvalidNativeOperation;
        var next = self.value;
        _ = try next.apply(.{ .delay = .{ .generation = next.generation, .now_ms = now.monotonic_ms, .delay_ms = delay_ms } });
        try self.persist(next, null, null, null, now, .{ .Retry = reason });
    }
    pub fn retry(self: *Operation, reason: db.json.ReprepareReason, now: Times, jitter: u64) !void {
        var next = self.value;
        _ = try next.apply(.{ .retry = .{ .generation = next.generation, .reason = if (reason == .AwaitingValidatorSignatures) .awaiting_signatures else .transient, .now_ms = now.monotonic_ms, .jitter = jitter } });
        if (self.options.kind == .reveal) next.next_attempt_ms = now.monotonic_ms +| self.retryDelay(next.retries, jitter);
        // Retry is legal only before a signed transaction exists. A new prepare
        // generation can get fresh metadata/nonce while all sent work retains ID.
        if (self.signed != null) return error.InvalidNativeOperation;
        try self.persist(next, null, null, null, now, .{ .Retry = reason });
    }
    /// A finalized execution failure is evidence that this exact native ID
    /// cannot deliver. Expiry, absent receipts and RPC timeouts are insufficient.
    pub fn finalizedFailure(self: *Operation, receipt: types.Receipt, now: Times, jitter: u64) !void {
        const signed = self.signed orelse return error.InvalidNativeOperation;
        if (!receipt.finalized or receipt.success or !types.Identity.eql(receipt.identity, signed.identity) or (self.value.stage != .submitting and self.value.stage != .confirming)) return error.FinalizedNativeFailureRequired;
        var next = self.value;
        next.transaction = null;
        next.confirmation_started = false;
        next.stage = .pending;
        next.retries +|= 1;
        next.next_attempt_ms = now.monotonic_ms +| self.retryDelay(next.retries, jitter);
        self.retiring = receipt;
        defer self.retiring = null;
        try self.persist(next, null, null, null, now, .{ .Retry = .RevertedOrReorged });
    }
    fn validateConsumedNonce(self: *Operation, proof: types.RetirementProof, prepared_value: *const types.Prepared) !void {
        const signed = self.signed orelse return error.InvalidNativeRetirementProof;
        if (proof.reason != .starknet_nonce_superseded or prepared_value.authority.protocol != .starknet or proof.kind != self.options.kind or !std.meta.eql(proof.target, self.options.target) or !types.Identity.eql(proof.identity, signed.identity) or proof.generation != self.value.generation or proof.nonce_account == null or proof.nonce_boundary == null or proof.nonce_observed == null or proof.finalized_block_hash == null or proof.finalized_height == 0 or proof.boundary != 0 or proof.observed != 0) return error.InvalidNativeRetirementProof;
        const json = @import("../../net/json_rpc.zig");
        const felt = @import("../../starknet/codec.zig").Felt;
        _ = felt.fromBytes(proof.finalized_block_hash.?) catch return error.InvalidNativeRetirementProof;
        _ = felt.fromBytes(proof.nonce_account.?) catch return error.InvalidNativeRetirementProof;
        _ = felt.fromBytes(proof.nonce_boundary.?) catch return error.InvalidNativeRetirementProof;
        _ = felt.fromBytes(proof.nonce_observed.?) catch return error.InvalidNativeRetirementProof;
        const transaction = try json.field(prepared_value.body, "transaction");
        const account = (try @import("../../starknet/provider.zig").felt(try json.field(transaction, "sender_address"))).toBytes();
        const saved = (try @import("../../starknet/provider.zig").felt(try json.field(transaction, "nonce"))).toBytes();
        if (!std.mem.eql(u8, &account, &proof.nonce_account.?) or !std.mem.eql(u8, &saved, &proof.nonce_boundary.?) or std.mem.order(u8, &proof.nonce_observed.?, &saved) != .gt or !std.mem.eql(u8, &proof.intent_digest, &prepared_value.digest())) return error.InvalidNativeRetirementProof;
    }
    fn validateRetirement(self: *Operation, proof: types.RetirementProof, prepared_value: *const types.Prepared) !void {
        const signed = self.signed orelse return error.InvalidNativeOperation;
        if (proof.kind != self.options.kind or !std.meta.eql(proof.target, self.options.target) or !types.Identity.eql(proof.identity, signed.identity) or proof.generation != self.value.generation or self.intent == null or (self.value.stage != .submitting and self.value.stage != .confirming)) return error.InvalidNativeRetirementProof;
        const expected_protocol: @import("../../settings/types.zig").Protocol = switch (proof.reason) {
            .tron_expired => .tron,
            .svm_blockhash_expired => .sealevel,
            .radix_epoch_expired => .radix,
            .cosmos_sequence_superseded, .cosmos_timeout_expired => prepared_value.authority.protocol,
            .starknet_nonce_superseded => .starknet,
        };
        const cosmos_reason = proof.reason == .cosmos_sequence_superseded or proof.reason == .cosmos_timeout_expired;
        const json = @import("../../net/json_rpc.zig");
        if (proof.reason == .starknet_nonce_superseded) {
            try self.validateConsumedNonce(proof, prepared_value);
            if (!proof.absence_checked) return error.InvalidNativeRetirementProof;
            return;
        }
        const boundary = switch (proof.reason) {
            .starknet_nonce_superseded => unreachable,
            .tron_expired => try json.integer(u64, try json.field(prepared_value.body, "expiration_ms")),
            .svm_blockhash_expired => try json.integer(u64, try json.field(prepared_value.body, "last_valid_block_height")),
            .radix_epoch_expired => try std.math.add(u64, try json.integer(u64, try json.field(prepared_value.body, "epoch")), 2),
            .cosmos_sequence_superseded => try json.integer(u64, try json.field(prepared_value.body, "sequence")),
            .cosmos_timeout_expired => blk: {
                const text = try json.string(try json.field(prepared_value.body, "body"));
                const raw = try self.allocator.alloc(u8, text.len / 2);
                defer self.allocator.free(raw);
                break :blk try @import("../../cosmos/proto.zig").uintField(try hex.decodeHex(raw, text), 3);
            },
        };
        if (proof.boundary != boundary or (proof.reason == .cosmos_timeout_expired and boundary == 0) or ((proof.reason == .tron_expired or cosmos_reason) and proof.finalized_block_hash == null) or ((proof.reason == .svm_blockhash_expired or proof.reason == .cosmos_timeout_expired) and proof.finalized_height != proof.observed)) return error.InvalidNativeRetirementProof;
        if (!std.mem.eql(u8, &proof.intent_digest, &prepared_value.digest()) or prepared_value.authority.protocol != expected_protocol or (cosmos_reason and expected_protocol != .cosmos and expected_protocol != .cosmosnative) or proof.finalized_height == 0 or (switch (proof.reason) {
            .tron_expired, .radix_epoch_expired => proof.observed < proof.boundary,
            else => proof.observed <= proof.boundary,
        })) return error.InvalidNativeRetirementProof;
    }
    pub fn retire(self: *Operation, proof: types.RetirementProof, now: Times, jitter: u64) !void {
        var prepared_value = try types.Prepared.restore(self.allocator, self.intent orelse return error.InvalidNativeRetirementProof);
        defer prepared_value.deinit();
        try self.validateRetirement(proof, &prepared_value);
        var next = self.value;
        next.transaction = null;
        next.confirmation_started = false;
        next.stage = .pending;
        next.retries +|= 1;
        next.next_attempt_ms = now.monotonic_ms +| self.retryDelay(next.retries, jitter);
        self.retirement_proof = proof;
        defer self.retirement_proof = null;
        try self.persist(next, null, null, null, now, .{ .Retry = .RevertedOrReorged });
    }
    pub fn setAllowed(self: *Operation, allowed: bool, now: Times) !void {
        if ((allowed and self.value.stage != .denied) or (!allowed and self.value.stage == .denied)) return;
        var next = self.value;
        _ = try next.apply(if (allowed) .allow else .deny);
        const reset = allowed and self.signed == null;
        try self.persist(next, if (reset) null else self.intent, if (reset) null else self.authorization, self.signed, now, self.current_status);
    }
    /// UR's bounded inner lease attempts and outer 30s..10m schedule differ
    /// from message retry policy. Only an already unsigned auxiliary generation
    /// may have its scheduling deadline changed; signed identity is untouched.
    pub fn scheduleReveal(self: *Operation, delay_ms: u64, now: Times) !void {
        if (self.options.kind != .reveal or self.signed != null or self.value.stage != .pending) return error.InvalidNativeOperation;
        var next = self.value;
        next.next_attempt_ms = now.monotonic_ms +| delay_ms;
        try self.persist(next, self.intent, self.authorization, null, now, self.current_status);
    }
    fn retryDelay(self: *Operation, retries: u32, jitter: u64) u64 {
        if (self.options.kind == .reveal) return @min(@as(u64, 600000), @as(u64, 30000) << @intCast(@min(@as(u32, 5), retries -| 1)));
        return pure.retryDelaySeconds(retries, self.options.policy.max_retries, .transient, jitter) *| 1000;
    }
    fn persist(self: *Operation, next: pure.Operation, intent: ?[]const u8, authorization: ?[]const u8, signed: ?types.Signed, now: Times, status: db.json.Status) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const deadline: ?compatibility.Deadline = if (next.next_attempt_ms > now.monotonic_ms) (if (next.next_attempt_ms == self.value.next_attempt_ms and self.deadline != null) self.deadline else .{ .unix_ms = now.unix_ms +| (next.next_attempt_ms - now.monotonic_ms), .delay_ms = next.next_attempt_ms - now.monotonic_ms }) else null;
        const record: Record = .{ .context = try hex.hexAlloc(a, &self.options.context), .id = try hex.hexAlloc(a, &self.options.id), .nonce = self.options.nonce, .origin = self.options.origin, .destination = self.options.destination, .kind = self.options.kind, .target = if (self.options.target) |target| try hex.hexAlloc(a, &target) else null, .stage = next.stage, .generation = next.generation, .retries = next.retries, .confirmation_started = next.confirmation_started, .deadline = deadline, .intent = intent, .authorization = authorization, .identity_kind = if (signed) |value| switch (value.identity) {
            .hash256 => .hash256,
            .signature512 => .signature512,
        } else null, .identity_hex = if (signed) |value| switch (value.identity) {
            .hash256 => |hash| try hex.hexAlloc(a, &hash),
            .signature512 => |sig| try hex.hexAlloc(a, &sig),
        } else null, .signed_hex = if (signed) |value| try hex.hexAlloc(a, value.bytes) else null };
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, record, .{});
        errdefer {
            std.crypto.secureZero(u8, encoded);
            self.allocator.free(encoded);
        }
        if (encoded.len > max_record_bytes) return error.NativeOperationTooLarge;
        // Clone the full next in-memory state before the durable commit. No OOM
        // can make a successful write invisible to the live owner afterward.
        const next_intent = if (intent) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (next_intent) |value| self.allocator.free(value);
        const next_authorization = if (authorization) |value| try self.allocator.dupe(u8, value) else null;
        errdefer if (next_authorization) |value| {
            std.crypto.secureZero(u8, value);
            self.allocator.free(value);
        };
        var next_signed: ?types.Signed = if (signed) |value| try types.Signed.init(self.allocator, value.identity, value.bytes) else null;
        errdefer if (next_signed) |*value| value.deinit();
        const status_bytes = try status.toJson(a);
        const retry_state: db.json.RetryState = .{ .retry_count = next.retries, .next_attempt_at_millis = if (deadline) |value| value.unix_ms else null, .retry_delay_millis = if (deadline) |value| value.delay_ms else null, .reason = if (status == .Retry) status.Retry else null };
        const retry_bytes = try retry_state.toJson(a);
        var count: [4]u8 = undefined;
        std.mem.writeInt(u32, &count, next.retries, .big);
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        const current = try self.store.typed.get(a, prefix, &self.options.id);
        if ((current == null) != (self.row == null) or (current != null and !std.mem.eql(u8, current.?, self.row.?))) return error.StaleNativeOperationOwner;
        if (self.options.kind == .process and !std.meta.eql(try self.store.status(self.options.id), self.status_row)) return error.StaleNativeOperationOwner;
        // Independent finalized mailbox delivery may acknowledge the message;
        // all preparation, retry and broadcast states retain foreign authority.
        if (next.stage != .delivered and !next.confirmation_started) try self.guardInherited();
        var batch = try self.store.typed.batch(a);
        defer batch.deinit();
        if (self.retiring) |receipt| {
            var key: [40]u8 = undefined;
            key[0..32].* = self.options.id;
            std.mem.writeInt(u64, key[32..40], self.value.generation, .big);
            const history = try std.json.Stringify.valueAlloc(a, .{ .previous_record = self.row orelse return error.InvalidNativeOperation, .finalized_execution_failure = true, .block_hash = try hex.hexAlloc(a, &receipt.block_hash), .height = receipt.height }, .{});
            try batch.put(history_prefix, &key, history);
        }
        if (self.retirement_proof) |proof| {
            var key: [40]u8 = undefined;
            key[0..32].* = self.options.id;
            std.mem.writeInt(u64, key[32..40], self.value.generation, .big);
            const history = try std.json.Stringify.valueAlloc(a, .{ .previous_record = self.row orelse return error.InvalidNativeOperation, .finalized_execution_failure = false, .retirement = .{ .kind = proof.kind, .target = if (proof.target) |hash| try hex.hexAlloc(a, &hash) else null, .reason = proof.reason, .finalized_height = proof.finalized_height, .finalized_block_hash = if (proof.finalized_block_hash) |hash| try hex.hexAlloc(a, &hash) else null, .boundary = proof.boundary, .observed = proof.observed, .nonce_account = if (proof.nonce_account) |value| try hex.hexAlloc(a, &value) else null, .nonce_boundary = if (proof.nonce_boundary) |value| try hex.hexAlloc(a, &value) else null, .nonce_observed = if (proof.nonce_observed) |value| try hex.hexAlloc(a, &value) else null, .absence_checked = proof.absence_checked } }, .{});
            try batch.put(history_prefix, &key, history);
        }
        try batch.put(prefix, &self.options.id, encoded);
        if (self.options.kind == .process) {
            try batch.put(db.keys.Table.status_by_message_id.prefix(), &self.options.id, status_bytes);
            try batch.put(db.keys.Table.pending_message_retry_state.prefix(), &self.options.id, retry_bytes);
            try batch.put(db.keys.Table.pending_message_retry_count.prefix(), &self.options.id, &count);
        }
        if (self.options.acknowledge_canonical and (next.stage == .delivered or self.terminal_drop) and self.options.kind == .process) {
            var nonce: [4]u8 = undefined;
            std.mem.writeInt(u32, &nonce, self.options.nonce, .big);
            var canonical = try self.store.messageByNonce(self.options.nonce);
            defer if (canonical) |*message| message.deinit();
            if (self.terminal_drop) {
                try self.assertMessageAuthorized();
                try batch.put(db.keys.Table.terminally_dropped_message_by_id.prefix(), &self.options.id, &.{1});
            }
            if (canonical != null and std.mem.eql(u8, &canonical.?.value.id(), &self.options.id)) {
                if (next.stage == .delivered) try batch.put(db.keys.Table.nonce_processed.prefix(), &nonce, &.{1});
                const pending = try db.keys.pendingDestination(a, self.options.destination);
                const indexed = try self.store.typed.get(a, pending, &nonce);
                if (indexed != null and std.mem.eql(u8, indexed.?, &self.options.id)) try batch.delete(pending, &nonce);
            }
            if (next.stage == .delivered) try batch.delete(db.keys.Table.terminally_dropped_message_by_id.prefix(), &self.options.id);
        }
        try batch.commitSync();
        self.clear();
        self.row = encoded;
        self.intent = next_intent;
        self.authorization = next_authorization;
        self.signed = next_signed;
        self.value = next;
        self.deadline = deadline;
        self.current_status = status;
        self.status_row = if (self.options.kind == .process) status else null;
        self.parked = !next.confirmation_started and next.retries >= self.options.policy.max_retries;
    }
};
fn decode(a: A, text: []const u8, limit: usize) ![]u8 {
    if (text.len < 4 or text.len % 2 != 0 or (text.len - 2) / 2 > limit) return error.InvalidNativeOperation;
    const result = try a.alloc(u8, (text.len - 2) / 2);
    errdefer a.free(result);
    _ = try hex.decodeHex(result, text);
    return result;
}
fn correlation(identity: types.Identity) Hash {
    var state = std.crypto.hash.sha2.Sha256.init(.{});
    switch (identity) {
        .hash256 => |value| {
            state.update(&.{0});
            state.update(&value);
        },
        .signature512 => |value| {
            state.update(&.{1});
            state.update(&value);
        },
    }
    var result: Hash = undefined;
    state.final(&result);
    return result;
}

/// One complete group record and its member rows share the same native WAL.
/// Callers validate the backend's common transaction/manifest before this API;
/// this boundary independently validates every old journal row and authority.
pub const GroupJournalWrite = struct {
    store: db.rocks.Typed,
    id: Hash,
    expected: ?[]const u8,
    value: []const u8,
    links: enum { set, preserve, clear } = .preserve,
    manage_nonce: bool = false,
    release_nonce: bool = false,
    nonce_reservation: ?Hash = null,
    detached_nonce: bool = false,
    finalization: ?FinalizedWrite = null,
};
pub const GroupTransition = union(enum) {
    replace_ready: struct { prepared: []const *const types.Prepared, previous_digests: []const Hash },
    signed: *const types.Signed,
    confirming: compatibility.Deadline,
    failed: types.Receipt,
    retired: struct { consumed: types.RetirementProof, proofs: []const ?types.RetirementProof, jitter: u64 = 0 },
};
pub const group_record_prefix = "zig_native_submission_group_v1/";
pub const group_nonce_prefix = "zig_native_submission_group_nonce_v1/";
pub const group_history_prefix = "zig_native_submission_group_history_v1/";
pub const group_current_prefix = "zig_native_submission_group_current_v1/";
pub const group_link_prefix = "zig_native_submission_group_member_v1/";
pub const GroupTestFault = struct {
    pub var before_commit: std.atomic.Value(bool) = .init(false);
    pub var after_commit: std.atomic.Value(bool) = .init(false);
};

/// The serialized destination owner alone writes this journal namespace. Its
/// group ID must bind the complete ordered canonical member intents; callers
/// must never reuse a journal key for a disjoint member set.
/// All supplied actors are scoped, heap-stable owners. No callback or network
/// operation runs while the origin locks are held. Post-commit application does
/// not allocate, so success cannot leave a partly updated live member set.
pub fn commitGroup(a: A, actors: []const *Operation, transition: GroupTransition, journal: GroupJournalWrite, now: Times) !void {
    if (actors.len == 0 or actors.len > 4096 or journal.value.len == 0 or journal.value.len > Operation.max_record_bytes) return error.InvalidNativeGroup;
    if (transition == .retired and transition.retired.proofs.len != actors.len) return error.InvalidNativeGroup;
    if (transition == .replace_ready and (transition.replace_ready.prepared.len != actors.len or transition.replace_ready.previous_digests.len != actors.len)) return error.InvalidNativeGroup;
    if ((transition == .signed or transition == .confirming) and journal.links != .preserve) return error.InvalidNativeGroup;
    if (transition == .signed and transition.signed.identity != .hash256) return error.InvalidNativeGroup;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const snapshots = try a.alloc(GroupSnapshot, actors.len);
    defer a.free(snapshots);
    var initialized: usize = 0;
    defer for (snapshots[0..initialized]) |*snapshot| snapshot.deinit();
    const stores = try temporary.alloc(*store.Store, actors.len);
    var store_count: usize = 0;
    for (actors, 0..) |actor, index| {
        if (actor.store.typed.database != journal.store.database or actor.options.kind != .process or actor.options.target != null or actor.intent == null or actor.authorization != null) return error.InvalidNativeGroup;
        for (actors[0..index]) |previous| if (std.mem.eql(u8, &actor.options.id, &previous.options.id)) return error.DuplicateNativeGroupMember;
        var known = false;
        for (stores[0..store_count]) |previous| {
            if (previous == actor.store) known = true else if (std.mem.eql(u8, previous.typed.domain_name, actor.store.typed.domain_name)) return error.AliasedNativeGroupStore;
        }
        if (!known) {
            stores[store_count] = actor.store;
            store_count += 1;
        }
        snapshots[index] = try GroupSnapshot.create(actor, transition, index, now, temporary);
        initialized += 1;
    }
    std.mem.sort(*store.Store, stores[0..store_count], {}, struct {
        fn less(_: void, left: *store.Store, right: *store.Store) bool {
            return std.mem.lessThan(u8, left.typed.domain_name, right.typed.domain_name);
        }
    }.less);
    const journal_key = try db.keys.scoped(temporary, journal.store.domain_name, group_record_prefix, &journal.id);
    for (stores[0..store_count]) |origin| origin.mutex.lock();
    defer {
        var count = store_count;
        while (count > 0) {
            count -= 1;
            stores[count].mutex.unlock();
        }
    }
    if (journal.finalization) |observed| {
        if (transition != .confirming and transition != .failed) return error.InvalidNativeGroup;
        if (!observed.receipt.finalized) return error.FinalizedNativeReceiptRequired;
        for (actors) |actor| {
            if (actor.options.destination != observed.destination or actor.signed == null or !types.Identity.eql(actor.signed.?.identity, observed.receipt.identity)) return error.FinalizedNativeReceiptRequired;
        }
        finalized_transaction_mutex.lock();
    }
    defer if (journal.finalization != null) finalized_transaction_mutex.unlock();
    const nonce_key = try db.keys.scoped(temporary, journal.store.domain_name, group_current_prefix, "");
    if (journal.manage_nonce) {
        const owner = try journal.store.database.get(temporary, nonce_key);
        if (journal.links == .set) {
            if (owner != null) return error.NativeGroupNonceAlreadyOwned;
            if (journal.nonce_reservation) |nonce| {
                if (try journal.store.get(temporary, group_nonce_prefix, &nonce) != null) return error.NativeGroupNonceAlreadyReserved;
            } else return error.MissingNativeGroupNonce;
        } else if (!journal.detached_nonce and (owner == null or !std.mem.eql(u8, owner.?, &journal.id))) return error.NativeGroupNonceOwnerChanged;
        if (journal.detached_nonce) {
            if ((transition != .retired and transition != .failed) or !journal.release_nonce) return error.InvalidNativeGroup;
            const nonce = journal.nonce_reservation orelse return error.MissingNativeGroupNonce;
            const reserved = try journal.store.get(temporary, group_nonce_prefix, &nonce);
            if (reserved == null or !std.mem.eql(u8, reserved.?, &journal.id)) return error.NativeGroupNonceOwnerChanged;
        }
    }
    const actual_journal = try journal.store.database.get(temporary, journal_key);
    if ((actual_journal == null) != (journal.expected == null) or (actual_journal != null and !std.mem.eql(u8, actual_journal.?, journal.expected.?))) return error.StaleNativeGroupOwner;
    for (snapshots[0..initialized]) |*snapshot| {
        const actor = snapshot.actor;
        const actual = try actor.store.typed.get(temporary, prefix, &actor.options.id);
        if ((actual == null) != (actor.row == null) or (actual != null and !std.mem.eql(u8, actual.?, actor.row.?)) or !std.meta.eql(try actor.store.status(actor.options.id), actor.status_row)) return error.StaleNativeOperationOwner;
        try actor.guardInherited();
        try actor.assertMessageAuthorized();
        const link = try actor.store.typed.get(temporary, group_link_prefix, &actor.options.id);
        if (link) |bytes| {
            if (!std.mem.eql(u8, bytes, &journal.id)) return error.NativeGroupMemberAlreadyOwned;
        } else if (journal.links != .set) return error.NativeGroupMemberNotOwned;
    }
    var batch = try journal.store.database.batch();
    defer batch.deinit();
    try batch.put(journal_key, journal.value);
    const finalized_new = if (journal.finalization) |observed| try stageFinalizedTransaction(temporary, journal.store.database, &batch, observed.destination, observed.receipt) else false;
    if (journal.manage_nonce) {
        if (journal.release_nonce) {
            const owner = try journal.store.database.get(temporary, nonce_key);
            if (owner != null and std.mem.eql(u8, owner.?, &journal.id)) try batch.delete(nonce_key);
        } else if (journal.links == .set) try batch.put(nonce_key, &journal.id);
        if (journal.links == .set) try batch.put(try db.keys.scoped(temporary, journal.store.domain_name, group_nonce_prefix, &journal.nonce_reservation.?), &journal.id);
    }
    for (snapshots[0..initialized]) |*snapshot| {
        try batch.put(snapshot.row_key, snapshot.row.?);
        try batch.put(snapshot.status_key, snapshot.status_bytes);
        try batch.put(snapshot.retry_key, snapshot.retry_bytes);
        try batch.put(snapshot.count_key, &snapshot.count);
        switch (journal.links) {
            .set => try batch.put(snapshot.link_key, &journal.id),
            .clear => try batch.delete(snapshot.link_key),
            .preserve => {},
        }
    }
    if (@import("builtin").is_test) if (GroupTestFault.before_commit.swap(false, .acq_rel)) return error.InjectedNativeGroupCommitFailure;
    try batch.commitSync();
    if (journal.finalization) |observed| observed.committed.* = observed.committed.* or finalized_new;
    if (@import("builtin").is_test) if (GroupTestFault.after_commit.swap(false, .acq_rel)) return error.NativeGroupCommitOutcomeUnknown;
    for (snapshots[0..initialized]) |*snapshot| snapshot.apply();
}

const GroupSnapshot = struct {
    actor: *Operation,
    next: pure.Operation,
    deadline: ?compatibility.Deadline,
    status: db.json.Status,
    row: ?[]u8,
    intent: ?[]u8,
    signed: ?types.Signed,
    row_key: []const u8,
    status_key: []const u8,
    retry_key: []const u8,
    count_key: []const u8,
    link_key: []const u8,
    status_bytes: []const u8,
    retry_bytes: []const u8,
    count: [4]u8,
    fn create(actor: *Operation, transition: GroupTransition, index: usize, now: Times, temporary: A) !GroupSnapshot {
        const current_intent = actor.intent orelse return error.MissingNativePreparedIntent;
        var old_prepared = try types.Prepared.restore(temporary, current_intent);
        defer old_prepared.deinit();
        try actor.checkPrepared(&old_prepared);
        if (old_prepared.authority.protocol != .starknet or actor.value.stage == .denied or (actor.parked and actor.signed == null)) return error.InvalidNativeGroup;
        if (actor.value.stage == .delivered and (transition == .replace_ready or actor.signed == null)) return error.InvalidNativeGroup;
        var next = actor.value;
        var deadline = actor.deadline;
        var status = actor.current_status;
        var intent_bytes: ?[]const u8 = current_intent;
        var signed_value: ?types.Signed = actor.signed;
        switch (transition) {
            .replace_ready => |replacement| {
                if (actor.value.stage != .ready or actor.current_status != .ReadyToSubmit or actor.signed != null or actor.value.confirmation_started) return error.NativeGroupMemberNotReady;
                if (!std.mem.eql(u8, &old_prepared.digest(), &replacement.previous_digests[index])) return error.NativeGroupIntentChanged;
                const prepared = replacement.prepared[index];
                try prepared.validate();
                try actor.checkPrepared(prepared);
                if (!groupAuthorityEqual(old_prepared.authority, prepared.authority)) return error.NativeGroupAuthorityChanged;
                intent_bytes = prepared.canonical_intent;
            },
            .signed => |shared| {
                if (actor.signed) |old| {
                    if (!types.Identity.eql(old.identity, shared.identity) or !std.mem.eql(u8, old.bytes, shared.bytes)) return error.NativeSignedConflict;
                } else {
                    if (actor.value.stage != .ready or actor.current_status != .ReadyToSubmit or actor.value.confirmation_started) return error.NativeGroupMemberNotReady;
                    _ = try next.apply(.{ .transaction_built = .{ .generation = next.generation, .transaction = correlation(shared.identity) } });
                    status = .ReadyToSubmit;
                }
                signed_value = shared.*;
            },
            .confirming => |at| {
                if (actor.value.stage == .delivered) {
                    // Preserve a member completed before a delayed common receipt.
                } else {
                    if (actor.signed == null or (actor.value.stage != .submitting and actor.value.stage != .confirming)) return error.InvalidNativeGroup;
                    next.confirmation_started = true;
                    const effective = if (actor.value.confirmation_started) existing: {
                        const earlier = actor.deadline orelse break :existing compatibility.Deadline{ .unix_ms = now.unix_ms, .delay_ms = 0 };
                        break :existing if (earlier.unix_ms < at.unix_ms) earlier else at;
                    } else at;
                    const rebased = now.monotonic_ms +| @min(effective.unix_ms -| now.unix_ms, effective.delay_ms);
                    next.next_attempt_ms = if (actor.value.confirmation_started) @min(actor.value.next_attempt_ms, rebased) else rebased;
                    deadline = effective;
                    status = .{ .Confirm = .SubmittedBySelf };
                }
            },
            .failed => |receipt| {
                if (!receipt.finalized or receipt.success or actor.signed == null or !types.Identity.eql(actor.signed.?.identity, receipt.identity)) return error.FinalizedNativeFailureRequired;
                if (actor.value.stage != .delivered) {
                    if (actor.value.stage != .submitting and actor.value.stage != .confirming) return error.FinalizedNativeFailureRequired;
                    next.transaction = null;
                    next.confirmation_started = false;
                    next.stage = .pending;
                    next.retries +|= 1;
                    next.next_attempt_ms = now.monotonic_ms +| actor.retryDelay(next.retries, 0);
                    deadline = .{ .unix_ms = now.unix_ms +| (next.next_attempt_ms -| now.monotonic_ms), .delay_ms = next.next_attempt_ms -| now.monotonic_ms };
                    intent_bytes = null;
                    signed_value = null;
                    status = .{ .Retry = .RevertedOrReorged };
                }
            },
            .retired => |retirement| {
                if (index == 0) try actor.validateConsumedNonce(retirement.consumed, &old_prepared);
                if (actor.value.stage != .delivered) {
                    const proof = retirement.proofs[index] orelse return error.InvalidNativeRetirementProof;
                    try actor.validateRetirement(proof, &old_prepared);
                    if (proof.finalized_height != retirement.consumed.finalized_height or !std.meta.eql(proof.finalized_block_hash, retirement.consumed.finalized_block_hash) or !std.meta.eql(proof.nonce_account, retirement.consumed.nonce_account) or !std.meta.eql(proof.nonce_boundary, retirement.consumed.nonce_boundary) or !std.meta.eql(proof.nonce_observed, retirement.consumed.nonce_observed)) return error.InvalidNativeRetirementProof;
                    next.transaction = null;
                    next.confirmation_started = false;
                    next.stage = .pending;
                    next.retries +|= 1;
                    next.next_attempt_ms = now.monotonic_ms +| actor.retryDelay(next.retries, retirement.jitter);
                    deadline = .{ .unix_ms = now.unix_ms +| (next.next_attempt_ms -| now.monotonic_ms), .delay_ms = next.next_attempt_ms -| now.monotonic_ms };
                    intent_bytes = null;
                    signed_value = null;
                    status = .{ .Retry = .RevertedOrReorged };
                } else if (retirement.proofs[index] != null) return error.InvalidNativeRetirementProof;
            },
        }
        if (signed_value) |value| if (value.identity != .hash256) return error.InvalidNativeGroup;
        const cloned_intent = if (intent_bytes) |bytes| try actor.allocator.dupe(u8, bytes) else null;
        errdefer if (cloned_intent) |bytes| actor.allocator.free(bytes);
        var cloned_signed: ?types.Signed = if (signed_value) |value| try types.Signed.init(actor.allocator, value.identity, value.bytes) else null;
        errdefer if (cloned_signed) |*value| value.deinit();
        const record: Record = .{ .context = try hex.hexAlloc(temporary, &actor.options.context), .id = try hex.hexAlloc(temporary, &actor.options.id), .nonce = actor.options.nonce, .origin = actor.options.origin, .destination = actor.options.destination, .kind = .process, .target = null, .stage = next.stage, .generation = next.generation, .retries = next.retries, .confirmation_started = next.confirmation_started, .deadline = deadline, .intent = intent_bytes, .authorization = null, .identity_kind = if (signed_value) |_| .hash256 else null, .identity_hex = if (signed_value) |value| try hex.hexAlloc(temporary, &value.identity.hash256) else null, .signed_hex = if (signed_value) |value| try hex.hexAlloc(temporary, value.bytes) else null };
        const row = try std.json.Stringify.valueAlloc(actor.allocator, record, .{});
        errdefer actor.allocator.free(row);
        if (row.len > Operation.max_record_bytes) return error.NativeOperationTooLarge;
        const retry: db.json.RetryState = .{ .retry_count = next.retries, .next_attempt_at_millis = if (deadline) |value| value.unix_ms else null, .retry_delay_millis = if (deadline) |value| value.delay_ms else null, .reason = if (status == .Retry) status.Retry else null };
        var count: [4]u8 = undefined;
        std.mem.writeInt(u32, &count, next.retries, .big);
        return .{ .actor = actor, .next = next, .deadline = deadline, .status = status, .row = row, .intent = cloned_intent, .signed = cloned_signed, .row_key = try db.keys.scoped(temporary, actor.store.typed.domain_name, prefix, &actor.options.id), .status_key = try db.keys.scoped(temporary, actor.store.typed.domain_name, db.keys.Table.status_by_message_id.prefix(), &actor.options.id), .retry_key = try db.keys.scoped(temporary, actor.store.typed.domain_name, db.keys.Table.pending_message_retry_state.prefix(), &actor.options.id), .count_key = try db.keys.scoped(temporary, actor.store.typed.domain_name, db.keys.Table.pending_message_retry_count.prefix(), &actor.options.id), .link_key = try db.keys.scoped(temporary, actor.store.typed.domain_name, group_link_prefix, &actor.options.id), .status_bytes = try status.toJson(temporary), .retry_bytes = try retry.toJson(temporary), .count = count };
    }
    fn deinit(self: *GroupSnapshot) void {
        if (self.row) |bytes| self.actor.allocator.free(bytes);
        if (self.intent) |bytes| self.actor.allocator.free(bytes);
        if (self.signed) |*value| value.deinit();
    }
    fn apply(self: *GroupSnapshot) void {
        const actor = self.actor;
        actor.clear();
        actor.row = self.row;
        actor.intent = self.intent;
        actor.authorization = null;
        actor.signed = self.signed;
        actor.value = self.next;
        actor.deadline = self.deadline;
        actor.current_status = self.status;
        actor.status_row = self.status;
        actor.parked = !self.next.confirmation_started and self.next.retries >= actor.options.policy.max_retries;
        self.row = null;
        self.intent = null;
        self.signed = null;
    }
};

pub fn groupAuthorityEqual(left: types.Authority, right: types.Authority) bool {
    return left.protocol == right.protocol and left.origin == right.origin and left.destination == right.destination and left.generation == right.generation and left.kind == right.kind and std.mem.eql(u8, &left.mailbox, &right.mailbox) and std.mem.eql(u8, &left.operation_id, &right.operation_id) and std.mem.eql(u8, left.chain_id, right.chain_id) and std.meta.eql(left.origin_hook, right.origin_hook) and std.meta.eql(left.target, right.target);
}

/// An unsigned group may be invalidated by a manual retry/control update. Keep
/// that updated member, restore the untouched scalar members and release every
/// link in one WAL batch. A signed member makes abandonment forbidden.
pub fn abandonUnsignedGroup(a: A, actors: []const *Operation, originals: []const *const types.Prepared, grouped_intents: []const []const u8, journal: GroupJournalWrite, now: Times) !void {
    if (actors.len == 0 or actors.len != originals.len or actors.len != grouped_intents.len or journal.expected == null) return error.InvalidNativeGroup;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const stores = try temporary.alloc(*store.Store, actors.len);
    var store_count: usize = 0;
    const snapshots = try a.alloc(GroupSnapshot, actors.len);
    defer a.free(snapshots);
    var snapshot_count: usize = 0;
    defer for (snapshots[0..snapshot_count]) |*snapshot| snapshot.deinit();
    for (actors, 0..) |actor, index| {
        if (actor.signed != null or actor.store.typed.database != journal.store.database) return error.SignedNativeGroupCannotBeAbandoned;
        var known = false;
        for (stores[0..store_count]) |previous| {
            if (previous == actor.store) known = true else if (std.mem.eql(u8, previous.typed.domain_name, actor.store.typed.domain_name)) return error.AliasedNativeGroupStore;
        }
        if (!known) {
            stores[store_count] = actor.store;
            store_count += 1;
        }
        if (actor.intent != null and std.mem.eql(u8, actor.intent.?, grouped_intents[index]) and actor.value.stage == .ready and actor.current_status == .ReadyToSubmit) {
            var grouped = try types.Prepared.restore(temporary, grouped_intents[index]);
            defer grouped.deinit();
            const values = [_]*const types.Prepared{originals[index]};
            const digests = [_]Hash{grouped.digest()};
            snapshots[snapshot_count] = try GroupSnapshot.create(actor, .{ .replace_ready = .{ .prepared = &values, .previous_digests = &digests } }, 0, now, temporary);
            snapshot_count += 1;
        }
    }
    std.mem.sort(*store.Store, stores[0..store_count], {}, struct {
        fn less(_: void, l: *store.Store, r: *store.Store) bool {
            return std.mem.lessThan(u8, l.typed.domain_name, r.typed.domain_name);
        }
    }.less);
    for (stores[0..store_count]) |origin| origin.mutex.lock();
    defer {
        var count = store_count;
        while (count > 0) {
            count -= 1;
            stores[count].mutex.unlock();
        }
    }
    const current = try journal.store.get(temporary, group_record_prefix, &journal.id);
    if (current == null or !std.mem.eql(u8, current.?, journal.expected.?)) return error.StaleNativeGroupOwner;
    for (actors) |actor| {
        const actual = try actor.store.typed.get(temporary, prefix, &actor.options.id);
        if ((actual == null) != (actor.row == null) or (actual != null and !std.mem.eql(u8, actual.?, actor.row.?)) or !std.meta.eql(try actor.store.status(actor.options.id), actor.status_row)) return error.StaleNativeOperationOwner;
        const link = try actor.store.typed.get(temporary, group_link_prefix, &actor.options.id);
        if (link == null or !std.mem.eql(u8, link.?, &journal.id)) return error.NativeGroupMemberNotOwned;
    }
    var batch = try journal.store.database.batch();
    defer batch.deinit();
    const journal_key = try db.keys.scoped(temporary, journal.store.domain_name, group_record_prefix, &journal.id);
    try batch.delete(journal_key);
    if (journal.manage_nonce) {
        const key = try db.keys.scoped(temporary, journal.store.domain_name, group_current_prefix, "");
        const owner = try journal.store.database.get(temporary, key);
        if (owner == null or !std.mem.eql(u8, owner.?, &journal.id)) return error.NativeGroupNonceOwnerChanged;
        try batch.delete(key);
        const nonce = journal.nonce_reservation orelse return error.MissingNativeGroupNonce;
        const reserved = try journal.store.get(temporary, group_nonce_prefix, &nonce);
        if (reserved == null or !std.mem.eql(u8, reserved.?, &journal.id)) return error.NativeGroupNonceOwnerChanged;
        try batch.delete(try db.keys.scoped(temporary, journal.store.domain_name, group_nonce_prefix, &nonce));
    }
    for (actors) |actor| try batch.delete(try db.keys.scoped(temporary, actor.store.typed.domain_name, group_link_prefix, &actor.options.id));
    for (snapshots[0..snapshot_count]) |*snapshot| {
        try batch.put(snapshot.row_key, snapshot.row.?);
        try batch.put(snapshot.status_key, snapshot.status_bytes);
        try batch.put(snapshot.retry_key, snapshot.retry_bytes);
        try batch.put(snapshot.count_key, &snapshot.count);
    }
    try batch.commitSync();
    for (snapshots[0..snapshot_count]) |*snapshot| snapshot.apply();
}
