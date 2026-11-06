//! Durable account-transaction group. Public original intents make an unsigned
//! guarded restage auditable; signed recovery never prepares or signs again.
const std = @import("std");
const op = @import("../destination/operation.zig");
const types = @import("../destination/types.zig");
const db = @import("../../db/root.zig");
const hex = @import("../../evm/codecs.zig");
const A = std.mem.Allocator;
pub const Phase = enum { prepared, signed, included, retired };
pub const Member = struct { origin: u32, nonce: u32, id: []const u8, context: []const u8, original: []const u8, intent: []const u8 };
pub const CanonicalReceipt = struct { identity: []const u8, height: u64, block_hash: []const u8, success: bool };
pub const FailedReceipt = struct { identity: []const u8, height: u64, block_hash: []const u8 };
pub const NonceRetirement = struct { finalized_height: u64, finalized_block_hash: []const u8, account: []const u8, saved_nonce: []const u8, observed_nonce: []const u8, absent_members: []const bool };
pub const Record = struct { version: u8 = 1, phase: Phase, members: []const Member, identity: ?[]const u8 = null, signed: ?[]const u8 = null, included_unix_ms: ?u64 = null, whole_expenditure: ?types.Expenditure = null, allocated_expenditure: ?types.Expenditure = null, unallocated_expenditure: ?types.Expenditure = null, receipt_finalized: bool = false, observation_epoch: ?u64 = null, retirement: ?NonceRetirement = null, failed_receipt: ?FailedReceipt = null, canonical_receipt: ?CanonicalReceipt = null };
pub const Journal = struct {
    arena: std.heap.ArenaAllocator,
    store: db.rocks.Typed,
    id: types.Hash,
    wire: []const u8,
    record: Record,
    pub fn deinit(self: *Journal) void {
        self.arena.deinit();
        self.* = undefined;
    }
    pub fn load(a: A, store: db.rocks.Typed, id: types.Hash) !?Journal {
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const wire = try store.get(arena.allocator(), op.group_record_prefix, &id) orelse {
            arena.deinit();
            return null;
        };
        if (wire.len > op.Operation.max_record_bytes) return error.InvalidNativeGroup;
        const record = (try std.json.parseFromSlice(Record, arena.allocator(), wire, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" })).value;
        if ((record.phase == .included and record.included_unix_ms == null) or ((record.phase == .prepared or record.phase == .signed) and record.included_unix_ms != null) or ((record.phase == .retired) != (record.retirement != null or record.failed_receipt != null)) or (record.retirement != null and record.failed_receipt != null)) return error.InvalidNativeGroup;
        if (record.canonical_receipt) |receipt| {
            if (!record.receipt_finalized) return error.InvalidNativeGroup;
            _ = try hex.fixedHex(32, receipt.block_hash);
            const identity = try hex.fixedHex(32, receipt.identity);
            if (!std.mem.eql(u8, &identity, &try hex.fixedHex(32, record.identity orelse return error.InvalidNativeGroup))) return error.InvalidNativeGroup;
        }
        if (record.failed_receipt) |receipt| {
            if (!record.receipt_finalized) return error.InvalidNativeGroup;
            _ = try hex.fixedHex(32, receipt.block_hash);
            const identity = try hex.fixedHex(32, receipt.identity);
            if (!std.mem.eql(u8, &identity, &try hex.fixedHex(32, record.identity orelse return error.InvalidNativeGroup))) return error.InvalidNativeGroup;
        }
        if (record.retirement) |proof| {
            if (proof.finalized_height == 0 or proof.absent_members.len != record.members.len) return error.InvalidNativeGroup;
            _ = try hex.fixedHex(32, proof.finalized_block_hash);
            _ = try hex.fixedHex(32, proof.account);
            const saved = try hex.fixedHex(32, proof.saved_nonce);
            const observed = try hex.fixedHex(32, proof.observed_nonce);
            if (std.mem.order(u8, &observed, &saved) != .gt) return error.InvalidNativeGroup;
        }
        if (record.whole_expenditure) |whole| {
            const allocated = record.allocated_expenditure orelse return error.InvalidNativeGroup;
            const dust = record.unallocated_expenditure orelse return error.InvalidNativeGroup;
            if ((std.math.add(u256, allocated.gas_used, dust.gas_used) catch return error.InvalidNativeGroup) != whole.gas_used or (std.math.add(u256, allocated.tokens_used, dust.tokens_used) catch return error.InvalidNativeGroup) != whole.tokens_used) return error.InvalidNativeGroup;
        } else if (record.allocated_expenditure != null or record.unallocated_expenditure != null) return error.InvalidNativeGroup;
        if (record.version != 1 or record.members.len == 0 or record.members.len > 4096 or (record.phase == .prepared and (record.identity != null or record.signed != null)) or (record.phase != .prepared and (record.identity == null or record.signed == null))) return error.InvalidNativeGroup;
        var digest = std.crypto.hash.sha2.Sha256.init(.{});
        for (record.members, 0..) |member, index| {
            const member_id = try hex.fixedHex(32, member.id);
            _ = try hex.fixedHex(32, member.context);
            var prepared = try types.Prepared.restore(arena.allocator(), member.intent);
            defer prepared.deinit();
            var original = try types.Prepared.restore(arena.allocator(), member.original);
            defer original.deinit();
            if (prepared.authority.protocol != .starknet or prepared.authority.kind != .process or prepared.authority.origin != member.origin or !std.mem.eql(u8, &prepared.authority.operation_id, &member_id) or !op.groupAuthorityEqual(prepared.authority, original.authority)) return error.InvalidNativeGroup;
            for (record.members[0..index]) |previous| if (std.mem.eql(u8, &try hex.fixedHex(32, previous.id), &member_id)) return error.DuplicateNativeGroupMember;
            try validateOriginal(&prepared, &original, index, record.members.len);
            digest.update(original.canonical_intent);
            digest.update(prepared.canonical_intent);
        }
        var computed: types.Hash = undefined;
        digest.final(&computed);
        if (!std.mem.eql(u8, &computed, &id)) return error.InvalidNativeGroup;
        if (record.identity) |value| _ = try hex.fixedHex(32, value);
        if (record.signed) |value| if (value.len < 4 or value.len > types.Signed.max_bytes * 2 + 2) return error.InvalidNativeGroup;
        return .{ .arena = arena, .store = store, .id = id, .wire = wire, .record = record };
    }
    pub fn create(a: A, store: db.rocks.Typed, actors: []const *op.Operation, prepared: []const types.Prepared, now: op.Times) !Journal {
        if (actors.len != prepared.len or actors.len == 0) return error.InvalidNativeGroup;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        const members = try temporary.alloc(Member, actors.len);
        const pointers = try temporary.alloc(*const types.Prepared, actors.len);
        const previous = try temporary.alloc(types.Hash, actors.len);
        var digest = std.crypto.hash.sha2.Sha256.init(.{});
        for (actors, prepared, 0..) |actor, *next, index| {
            var original = try types.Prepared.restore(temporary, actor.intent orelse return error.MissingNativePreparedIntent);
            defer original.deinit();
            previous[index] = original.digest();
            pointers[index] = next;
            members[index] = .{ .origin = actor.options.origin, .nonce = actor.options.nonce, .id = try hex.hexAlloc(temporary, &actor.options.id), .context = try hex.hexAlloc(temporary, &actor.options.context), .original = actor.intent.?, .intent = next.canonical_intent };
            try validateOriginal(next, &original, index, actors.len);
            digest.update(original.canonical_intent);
            digest.update(next.canonical_intent);
        }
        var id: types.Hash = undefined;
        digest.final(&id);
        const wire = try std.json.Stringify.valueAlloc(temporary, Record{ .phase = .prepared, .members = members }, .{});
        try op.commitGroup(a, actors, .{ .replace_ready = .{ .prepared = pointers, .previous_digests = previous } }, .{ .store = store, .id = id, .expected = null, .value = wire, .links = .set, .manage_nonce = true, .nonce_reservation = try preparedNonce(&prepared[0]) }, now);
        return (try load(a, store, id)) orelse return error.MissingNativeGroup;
    }
    pub fn nonce(self: *const Journal) !types.Hash {
        var prepared = try types.Prepared.restore(self.arena.child_allocator, self.record.members[0].intent);
        defer prepared.deinit();
        return preparedNonce(&prepared);
    }
    pub fn retire(self: *const Journal, actors: []const *op.Operation, consumed: types.RetirementProof, proofs: []const ?types.RetirementProof, epoch: ?u64, now: op.Times) !void {
        var arena = std.heap.ArenaAllocator.init(self.arena.child_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        if (actors.len != self.record.members.len or proofs.len != actors.len) return error.InvalidNativeGroup;
        const absent = try a.alloc(bool, proofs.len);
        for (proofs, 0..) |proof, index| absent[index] = proof != null;
        var record = self.record;
        record.phase = .retired;
        record.observation_epoch = epoch;
        record.whole_expenditure = null;
        record.allocated_expenditure = null;
        record.unallocated_expenditure = null;
        record.receipt_finalized = false;
        record.canonical_receipt = null;
        record.retirement = .{ .finalized_height = consumed.finalized_height, .finalized_block_hash = try hex.hexAlloc(a, &(consumed.finalized_block_hash orelse return error.InvalidNativeRetirementProof)), .account = try hex.hexAlloc(a, &(consumed.nonce_account orelse return error.InvalidNativeRetirementProof)), .saved_nonce = try hex.hexAlloc(a, &(consumed.nonce_boundary orelse return error.InvalidNativeRetirementProof)), .observed_nonce = try hex.hexAlloc(a, &(consumed.nonce_observed orelse return error.InvalidNativeRetirementProof)), .absent_members = absent };
        try self.write(record, actors, .{ .retired = .{ .consumed = consumed, .proofs = proofs } }, now);
    }
    pub fn failed(self: *const Journal, observed: Record, actors: []const *op.Operation, receipt: types.Receipt, now: op.Times) !void {
        if (!receipt.finalized or receipt.success or receipt.identity != .hash256) return error.FinalizedNativeFailureRequired;
        var arena = std.heap.ArenaAllocator.init(self.arena.child_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var record = observed;
        record.phase = .retired;
        record.retirement = null;
        record.receipt_finalized = true;
        record.failed_receipt = .{ .identity = try hex.hexAlloc(a, &receipt.identity.hash256), .height = receipt.height, .block_hash = try hex.hexAlloc(a, &receipt.block_hash) };
        try self.write(record, actors, .{ .failed = receipt }, now);
    }
    pub fn signedValue(self: *const Journal, a: A) !types.Signed {
        const value = self.record.signed orelse return error.UnsignedNativeGroup;
        const bytes = try a.alloc(u8, (value.len - 2) / 2);
        defer a.free(bytes);
        _ = try hex.decodeHex(bytes, value);
        return types.Signed.init(a, .{ .hash256 = try hex.fixedHex(32, self.record.identity.?) }, bytes);
    }
    pub fn write(self: *const Journal, record: Record, actors: []const *op.Operation, transition: op.GroupTransition, now: op.Times) !void {
        const a = self.arena.child_allocator;
        const wire = try std.json.Stringify.valueAlloc(a, record, .{});
        defer a.free(wire);
        try op.commitGroup(a, actors, transition, .{ .store = self.store, .id = self.id, .expected = self.wire, .value = wire, .manage_nonce = true, .release_nonce = record.phase == .included or record.phase == .retired, .nonce_reservation = if (record.phase == .retired) try self.nonce() else null, .detached_nonce = record.phase == .retired and self.record.phase == .included }, now);
    }
};

/// Callback remains scoped to one serial sign/broadcast call. Every successful
/// signed callback commits the shared bytes and ALL member rows before return.
pub const Persistence = struct {
    journal: *const Journal,
    actors: []const *op.Operation,
    now: op.Times,
    observation_clock: ?@import("../operation.zig").ObservationClock = null,
    cancel: ?*const std.atomic.Value(bool) = null,
    halt: ?*const std.atomic.Value(bool) = null,
    deadline_ns: u64 = 0,
    included_rebroadcast: bool = false,
    fn check(self: *Persistence) !void {
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (self.halt) |flag| if (flag.load(.acquire)) return error.CheckpointEffectsHalted;
        if (self.deadline_ns != 0) _ = try @import("../scraper/receipts_common.zig").milliseconds(self.deadline_ns);
    }
    fn time(self: *Persistence) !op.Times {
        return if (self.observation_clock) |clock| clock.now() else self.now;
    }
    fn intent(context: *anyopaque, id: types.Hash, value: []const u8) !void {
        const self: *Persistence = @ptrCast(@alignCast(context));
        if (self.journal.record.phase != .prepared) return error.NativeGroupAlreadySigned;
        return validateIntent(context, id, value);
    }
    fn validateIntent(context: *anyopaque, id: types.Hash, value: []const u8) !void {
        const self: *Persistence = @ptrCast(@alignCast(context));
        try self.check();
        if (self.actors.len == 0 or self.actors.len != self.journal.record.members.len) return error.InvalidNativeGroup;
        if (self.journal.record.phase == .retired) return error.NativeGroupAlreadyRetired;
        if (self.journal.record.phase == .included and !self.included_rebroadcast) return error.NativeGroupAlreadyIncluded;
        if (!std.mem.eql(u8, &id, &self.actors[0].options.id) or !std.mem.eql(u8, value, self.journal.record.members[0].intent)) return error.NativeGroupIntentChanged;
        var arena = std.heap.ArenaAllocator.init(self.journal.arena.child_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const stores = try a.alloc(*@import("../store.zig").Store, self.actors.len);
        var count: usize = 0;
        for (self.actors) |actor| {
            if (actor.store.typed.database != self.journal.store.database) return error.InvalidNativeGroup;
            var known = false;
            for (stores[0..count]) |previous| if (previous == actor.store) {
                known = true;
                break;
            };
            if (!known) {
                stores[count] = actor.store;
                count += 1;
            }
        }
        std.mem.sort(*@import("../store.zig").Store, stores[0..count], {}, struct {
            fn less(_: void, l: *@import("../store.zig").Store, r: *@import("../store.zig").Store) bool {
                return std.mem.lessThan(u8, l.typed.domain_name, r.typed.domain_name);
            }
        }.less);
        for (stores[0..count]) |store| store.mutex.lock();
        defer {
            var remaining = count;
            while (remaining > 0) {
                remaining -= 1;
                stores[remaining].mutex.unlock();
            }
        }
        const nonce_owner = try self.journal.store.get(a, op.group_current_prefix, "");
        if (self.journal.record.phase != .included and (nonce_owner == null or !std.mem.eql(u8, nonce_owner.?, &self.journal.id))) return error.NativeGroupNonceOwnerChanged;
        const reserved = try self.journal.store.get(a, op.group_nonce_prefix, &try self.journal.nonce());
        if (reserved == null or !std.mem.eql(u8, reserved.?, &self.journal.id)) return error.NativeGroupNonceOwnerChanged;
        const current = try self.journal.store.get(a, op.group_record_prefix, &self.journal.id);
        if (current == null or !std.mem.eql(u8, current.?, self.journal.wire)) return error.StaleNativeGroupOwner;
        for (self.actors, self.journal.record.members) |actor, member| {
            if (!std.mem.eql(u8, actor.intent orelse return error.NativeGroupIntentChanged, member.intent)) return error.NativeGroupIntentChanged;
            try actor.assertFreshLocked();
            if (actor.parked or actor.value.stage == .denied or (actor.value.stage == .delivered and !(self.included_rebroadcast and self.journal.record.phase != .prepared and self.journal.record.phase != .retired))) return error.NativeGroupMemberNotReady;
            if (self.journal.record.phase == .prepared) {
                if (actor.signed != null or actor.value.stage != .ready or actor.current_status != .ReadyToSubmit or actor.value.confirmation_started) return error.NativeGroupMemberNotReady;
            } else if (actor.signed == null or (actor.value.stage != .submitting and actor.value.stage != .confirming and !(actor.value.stage == .delivered and self.included_rebroadcast and self.journal.record.phase != .prepared and self.journal.record.phase != .retired))) return error.NativeGroupMemberNotReady;
            const link = try actor.store.typed.get(a, op.group_link_prefix, &actor.options.id);
            if (link == null or !std.mem.eql(u8, link.?, &self.journal.id)) return error.NativeGroupMemberNotOwned;
        }
        try self.check();
    }
    fn signed(context: *anyopaque, id: types.Hash, identity: types.Identity, bytes: []const u8) !void {
        const self: *Persistence = @ptrCast(@alignCast(context));
        try self.check();
        if (self.actors.len == 0 or self.actors.len != self.journal.record.members.len) return error.InvalidNativeGroup;
        if (self.journal.record.phase == .retired) return error.NativeGroupAlreadyRetired;
        if (self.journal.record.phase == .included and !self.included_rebroadcast) return error.NativeGroupAlreadyIncluded;
        if (!std.mem.eql(u8, &id, &self.actors[0].options.id) or identity != .hash256) return error.NativeGroupIntentChanged;
        const a = self.journal.arena.child_allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var record = self.journal.record;
        record.phase = .signed;
        record.identity = try hex.hexAlloc(arena.allocator(), &identity.hash256);
        record.signed = try hex.hexAlloc(arena.allocator(), bytes);
        var value = try types.Signed.init(a, identity, bytes);
        defer value.deinit();
        try validateIntent(context, id, self.journal.record.members[0].intent);
        // During a broadcast callback the same signed barrier is already durable.
        if (self.journal.record.phase != .prepared) {
            var existing = try self.journal.signedValue(a);
            defer existing.deinit();
            for (self.actors) |actor| {
                const durable_signed = actor.signed orelse return error.UnsignedNativeGroup;
                if (!types.Identity.eql(durable_signed.identity, identity) or !std.mem.eql(u8, durable_signed.bytes, bytes)) return error.NativeSignedTransactionConflict;
            }
            if (!types.Identity.eql(existing.identity, identity) or !std.mem.eql(u8, existing.bytes, bytes)) return error.NativeSignedTransactionConflict;
            try self.check();
            return;
        }
        const observed = try self.time();
        try self.check();
        try self.journal.write(record, self.actors, .{ .signed = &value }, observed);
        try self.check();
    }
    pub fn interface(self: *Persistence) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed };
    }
};

fn validateOriginal(prepared: *const types.Prepared, original: *const types.Prepared, index: usize, count: usize) !void {
    if (!op.groupAuthorityEqual(prepared.authority, original.authority)) return error.NativeGroupAuthorityChanged;
    if (count == 1) return;
    const json = @import("../../net/json_rpc.zig");
    const manifest = try json.field(prepared.body, "batch_members");
    if (manifest != .array or manifest.array.items.len != count) return error.InvalidNativeGroup;
    const member = manifest.array.items[index];
    const source_text = try json.string(try json.field(member, "source_intent_digest"));
    if (source_text.len != 64) return error.NativeGroupSourceIntentChanged;
    var source_digest: types.Hash = undefined;
    _ = std.fmt.hexToBytes(&source_digest, source_text) catch return error.NativeGroupSourceIntentChanged;
    if (!std.mem.eql(u8, &source_digest, &original.digest()) or try json.integer(u256, try json.field(member, "gas_limit")) != try json.integer(u256, try json.field(original.body, "gas_limit")) or try json.integer(u256, try json.field(member, "estimated_cost")) != try json.integer(u256, try json.field(original.body, "estimated_cost"))) return error.NativeGroupSourceIntentChanged;
}

fn preparedNonce(prepared: *const types.Prepared) !types.Hash {
    const json = @import("../../net/json_rpc.zig");
    return (try @import("../../starknet/provider.zig").felt(try json.field(try json.field(prepared.body, "transaction"), "nonce"))).toBytes();
}
