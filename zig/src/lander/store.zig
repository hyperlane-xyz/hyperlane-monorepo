const std = @import("std");
const rocks = @import("../db/rocks.zig");
const codec = @import("../db/codec.zig");
const keys = @import("../db/keys.zig");
const types = @import("types.zig");
const json_view = @import("json_view.zig");

pub const transaction_by_uuid = "transaction_by_uuid_";
pub const tx_index_by_uuid = "tx_index_by_uuid_";
pub const tx_uuid_by_index = "tx_uuid_by_index_";
pub const highest_tx_index = "highest_tx_index_";
pub const payload_by_uuid = "payload_by_uuid_";
pub const transaction_uuid_by_payload_uuid = "transaction_uuid_by_payload_uuid_";
pub const payload_index_by_uuid = "payload_index_by_uuid_";
pub const payload_uuid_by_index = "payload_uuid_by_index_";
pub const highest_payload_index = "highest_payload_index_";
pub const pending_payload_by_index = "pending_payload_by_index_";
pub const pending_payload_index_checkpoint = "pending_payload_index_checkpoint_";
pub const pending_payload_index_write_marker = "pending_payload_index_write_marker_";
pub const finalized_nonce_by_signer = "finalized_nonce_by_signer_address_";
pub const finalized_nonce_present_by_signer = "finalized_nonce_present_by_signer_address_";
pub const upper_nonce_by_signer = "upper_nonce_by_signer_address_";
pub const reorged_nonce_range_by_signer = "reorged_nonce_range_by_signer_address_";
pub const transaction_uuid_by_nonce_and_signer = "transaction_uuid_by_nonce_and_signer_address_";
pub const evm_nonce_by_transaction_uuid = "evm_nonce_by_transaction_uuid_";
pub const signed_attempt_by_uuid_hash = "zig_lander_signed_attempt_by_uuid_hash_v1_";
pub const delivery_by_payload_uuid = "zig_lander_delivery_by_payload_uuid_v1_";
pub const nonce_availability_generation = "zig_lander_nonce_availability_generation_v1_";
pub const active_tx_by_index = "zig_lander_active_tx_by_index_v1_";
pub const active_tx_checkpoint = "zig_lander_active_tx_checkpoint_v1_";
pub const finalized_receipt_by_uuid_hash = "zig_lander_finalized_receipt_by_uuid_hash_v1_";

const singleton = [1]u8{0};

pub const JsonRecord = struct {
    parsed: std.json.Parsed(std.json.Value),

    pub fn value(self: *const JsonRecord) std.json.Value {
        return self.parsed.value;
    }

    pub fn deinit(self: *JsonRecord) void {
        self.parsed.deinit();
        self.* = undefined;
    }
};

pub const ReorgRange = struct { start: u256, end: u256 };

pub const FinalizedReceipt = struct {
    version: u8 = 1,
    transaction_uuid: types.Uuid,
    transaction_hash: types.Hash,
    block_number: u64,
    block_hash: types.Hash,
    executed: bool,
    gas_used: u256,
    effective_gas_price: ?u256,
};

pub const OwnedStatus = struct {
    value: types.Status,
    reason: ?[]u8 = null,

    pub fn deinit(self: *OwnedStatus, allocator: std.mem.Allocator) void {
        if (self.reason) |reason| allocator.free(reason);
        self.* = undefined;
    }
};

pub const Delivery = union(enum) {
    none,
    mailbox_message: types.Hash,
    contract: Contract,

    pub const Contract = struct { to: types.Address, calldata: []const u8 };
};

pub const OwnedDelivery = struct {
    value: Delivery,
    calldata: []u8 = &.{},

    pub fn deinit(self: *OwnedDelivery, allocator: std.mem.Allocator) void {
        if (self.calldata.len > 0) allocator.free(self.calldata);
        self.* = undefined;
    }
};

pub const PayloadUpdate = struct {
    uuid: types.Uuid,
    canonical_json: []const u8,
    pending_json: ?[]const u8 = null,
};

/// In-memory mirror of `active_tx_by_index` (Rust keeps its inclusion pool
/// in memory the same way). The database stays the source of truth: the set
/// is rebuilt from one prefix scan, and each committed write that changes the
/// index applies its change right after the commit returns. Any failed write
/// or allocation marks the set stale, so it is rebuilt before its next use;
/// a crash simply loses it, and open rebuilds it.
pub const ActiveSet = struct {
    allocator: std.mem.Allocator,
    /// Sorted by index (the key order of `active_tx_by_index`).
    entries: std.ArrayListUnmanaged(Entry) = .empty,
    fresh: bool = false,

    pub const Entry = struct { index: u32, uuid: types.Uuid };
    pub const Change = struct { index: u32, uuid: types.Uuid, active: bool };

    pub fn init(allocator: std.mem.Allocator) ActiveSet {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *ActiveSet) void {
        self.entries.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn count(self: *const ActiveSet) usize {
        return self.entries.items.len;
    }

    fn lowerBound(self: *const ActiveSet, index: u32) usize {
        var low: usize = 0;
        var high = self.entries.items.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            if (self.entries.items[middle].index < index) low = middle + 1 else high = middle;
        }
        return low;
    }

    /// The lowest active entry at or after `index`.
    pub fn atOrAfter(self: *const ActiveSet, index: u32) ?Entry {
        const position = self.lowerBound(index);
        return if (position < self.entries.items.len) self.entries.items[position] else null;
    }

    /// Mirrors a committed change. A stale set ignores it (it will be rebuilt).
    pub fn apply(self: *ActiveSet, change: Change) void {
        if (!self.fresh) return;
        const position = self.lowerBound(change.index);
        const present = position < self.entries.items.len and self.entries.items[position].index == change.index;
        if (!change.active) {
            if (present) _ = self.entries.orderedRemove(position);
        } else if (present) {
            self.entries.items[position].uuid = change.uuid;
        } else {
            self.entries.insert(self.allocator, position, .{ .index = change.index, .uuid = change.uuid }) catch {
                self.fresh = false;
            };
        }
    }

    /// Replaces the contents with the durable index, read with one iterator.
    pub fn rebuild(self: *ActiveSet, store: Store) !void {
        self.fresh = false;
        self.entries.clearRetainingCapacity();
        var iterator = try store.typed.prefix(self.allocator, active_tx_by_index);
        defer iterator.deinit();
        while (try iterator.nextBorrowed()) |entry| {
            if (entry.key.len != 4 or entry.value.len != 16) return error.InvalidLanderRecord;
            try self.entries.append(self.allocator, .{ .index = std.mem.readInt(u32, entry.key[0..4], .big), .uuid = entry.value[0..16].* });
        }
        self.fresh = true;
    }

    /// Test oracle: a fresh set equals the durable index.
    pub fn matchesStore(self: *const ActiveSet, store: Store) !bool {
        if (!self.fresh) return true;
        var durable = ActiveSet.init(self.allocator);
        defer durable.deinit();
        try durable.rebuild(store);
        if (durable.entries.items.len != self.entries.items.len) return false;
        for (durable.entries.items, self.entries.items) |left, right| {
            if (left.index != right.index or !std.mem.eql(u8, &left.uuid, &right.uuid)) return false;
        }
        return true;
    }
};

/// Lowest payload index that may hold a `pending_payload_by_index` row, as
/// the Service knows it. Building deletes a payload's row, so the index's
/// low end is a run of tombstones that every scan from the prefix start
/// would step over; scans start here instead. A write lowers it before it
/// commits; only a scan's first observation raises it. Open starts at 0.
pub const PendingFloor = struct {
    index: u64 = 0,

    /// No pending row at all.
    pub const none: u64 = std.math.maxInt(u32) + 1;

    pub fn lower(self: *PendingFloor, index: u32) void {
        self.index = @min(self.index, index);
    }

    /// A fresh scan from the floor saw `first` (null: nothing) before any
    /// write: no row lies below it.
    pub fn observe(self: *PendingFloor, first: ?u32) void {
        self.index = first orelse none;
    }
};

pub const Store = struct {
    typed: rocks.Typed,
    /// Owned by the Service, the sole writer of lander rows while it is open.
    /// Writes through a Store copy without it leave the mirror unaware.
    active: ?*ActiveSet = null,
    /// Owned by the Service, like `active`.
    pending_floor: ?*PendingFloor = null,

    pub fn init(database: *rocks.Database, domain_name: []const u8) Store {
        return .{ .typed = .{ .database = database, .domain_name = domain_name } };
    }

    fn applyActive(self: Store, change: ?ActiveSet.Change) void {
        const set = self.active orelse return;
        if (change) |value| set.apply(value);
    }

    /// A write failed: whether it reached the database is unknown, so the
    /// mirror must be rebuilt from it.
    fn invalidateActive(self: Store) void {
        if (self.active) |set| set.fresh = false;
    }

    pub fn loadJson(self: Store, allocator: std.mem.Allocator, prefix: []const u8, key: []const u8) !?JsonRecord {
        const bytes = (try self.typed.get(allocator, prefix, key)) orelse return null;
        defer allocator.free(bytes);
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{ .duplicate_field_behavior = .@"error" });
        return .{ .parsed = parsed };
    }

    pub fn loadTransaction(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?JsonRecord {
        return self.loadJson(allocator, transaction_by_uuid, &uuid);
    }

    pub fn loadPayload(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?JsonRecord {
        return self.loadJson(allocator, payload_by_uuid, &uuid);
    }

    /// The stored payload row, undecoded (see records.PayloadView).
    pub fn loadPayloadBytes(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?[]u8 {
        return self.typed.get(allocator, payload_by_uuid, &uuid);
    }

    pub fn transactionStatus(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?OwnedStatus {
        const bytes = (try self.typed.get(allocator, transaction_by_uuid, &uuid)) orelse return null;
        defer allocator.free(bytes);
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const raw = (try json_view.field(arena.allocator(), bytes, "status")) orelse return error.InvalidLanderRecord;
        var status = try types.statusFromJson(try json_view.parseValue(arena.allocator(), raw));
        const reason = switch (status) {
            .dropped => |drop| switch (drop) {
                .other => |text| try allocator.dupe(u8, text),
                else => null,
            },
            else => null,
        };
        if (reason) |text| status.dropped.other = text;
        return .{ .value = status, .reason = reason };
    }

    pub fn payloadTransaction(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?types.Uuid {
        const bytes = (try self.typed.get(allocator, transaction_uuid_by_payload_uuid, &uuid)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len != 16) return error.InvalidLanderRecord;
        return bytes[0..16].*;
    }

    pub fn transactionUuidByIndex(self: Store, allocator: std.mem.Allocator, index: u32) !?types.Uuid {
        var encoded: [4]u8 = undefined;
        std.mem.writeInt(u32, &encoded, index, .big);
        const bytes = (try self.typed.get(allocator, tx_uuid_by_index, &encoded)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len != 16) return error.InvalidLanderRecord;
        return bytes[0..16].*;
    }

    pub fn highestTransactionIndex(self: Store, allocator: std.mem.Allocator) !u32 {
        return (try self.getInt(u32, allocator, highest_tx_index, &singleton)) orelse 0;
    }

    pub fn highestPayloadIndex(self: Store, allocator: std.mem.Allocator) !u32 {
        return (try self.getInt(u32, allocator, highest_payload_index, &singleton)) orelse 0;
    }

    pub fn payloadIndex(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?u32 {
        return self.getInt(u32, allocator, payload_index_by_uuid, &uuid);
    }

    pub fn transactionIndex(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?u32 {
        return self.getInt(u32, allocator, tx_index_by_uuid, &uuid);
    }

    pub fn payloadUuidByIndex(self: Store, allocator: std.mem.Allocator, index: u32) !?types.Uuid {
        var encoded: [4]u8 = undefined;
        std.mem.writeInt(u32, &encoded, index, .big);
        const bytes = (try self.typed.get(allocator, payload_uuid_by_index, &encoded)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len != 16) return error.InvalidLanderRecord;
        return bytes[0..16].*;
    }

    pub fn beginPendingReconciliation(self: Store, allocator: std.mem.Allocator) !u32 {
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try batch.deletePrefix(pending_payload_by_index);
        try batch.delete(pending_payload_index_checkpoint, &singleton);
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitSync();
        return self.highestPayloadIndex(allocator);
    }

    pub fn reconcilePendingEntry(self: Store, allocator: std.mem.Allocator, index: u32, canonical_json: []const u8, pending: bool) !void {
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try self.putPayloadPending(&batch, index, if (pending) canonical_json else null);
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitSync();
    }

    pub fn finishPendingReconciliation(self: Store, allocator: std.mem.Allocator) !void {
        return self.markPayloadCheckpoint(allocator);
    }

    pub fn availabilityGeneration(self: Store, allocator: std.mem.Allocator) !u64 {
        return (try self.getInt(u64, allocator, nonce_availability_generation, &singleton)) orelse 0;
    }

    /// Bumps the nonce availability generation when a write flips whether the
    /// stored transaction is dropped. Only the rows' status fields are decoded.
    fn bumpAvailabilityIfChanged(self: Store, batch: *rocks.TypedBatch, allocator: std.mem.Allocator, uuid: types.Uuid, new_status: StatusTag) !void {
        const old_bytes = (try self.typed.get(allocator, transaction_by_uuid, &uuid)) orelse return;
        defer allocator.free(old_bytes);
        const old_status = try statusTag(allocator, old_bytes);
        if ((old_status == .dropped) == (new_status == .dropped)) return;
        const next = try std.math.add(u64, try self.availabilityGeneration(allocator), 1);
        try putInt(batch, u64, nonce_availability_generation, &singleton, next);
    }

    pub fn activeCheckpoint(self: Store, allocator: std.mem.Allocator) !bool {
        const bytes = (try self.typed.get(allocator, active_tx_checkpoint, &singleton)) orelse return false;
        defer allocator.free(bytes);
        if (bytes.len != 1 or bytes[0] > 1) return error.InvalidLanderRecord;
        return bytes[0] == 1;
    }

    pub fn setActiveCheckpoint(self: Store, allocator: std.mem.Allocator) !void {
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try batch.put(active_tx_checkpoint, &singleton, &.{1});
        try batch.commitSync();
    }

    pub fn putActive(batch: *rocks.TypedBatch, index: u32, uuid: types.Uuid, active: bool) !ActiveSet.Change {
        var encoded: [4]u8 = undefined;
        std.mem.writeInt(u32, &encoded, index, .big);
        if (active) try batch.put(active_tx_by_index, &encoded, &uuid) else try batch.delete(active_tx_by_index, &encoded);
        return .{ .index = index, .uuid = uuid, .active = active };
    }

    pub fn setActive(self: Store, allocator: std.mem.Allocator, index: u32, uuid: types.Uuid, active: bool) !void {
        errdefer self.invalidateActive();
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        const change = try putActive(&batch, index, uuid, active);
        try batch.commitSync();
        self.applyActive(change);
    }

    fn getInt(self: Store, comptime T: type, allocator: std.mem.Allocator, prefix: []const u8, key: []const u8) !?T {
        const bytes = (try self.typed.get(allocator, prefix, key)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len != @sizeOf(T)) return error.InvalidLanderRecord;
        return std.mem.readInt(T, bytes[0..@sizeOf(T)], if (T == u256) .little else .big);
    }

    fn putInt(batch: *rocks.TypedBatch, comptime T: type, prefix: []const u8, key: []const u8, value: T) !void {
        var bytes: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &bytes, value, if (T == u256) .little else .big);
        try batch.put(prefix, key, &bytes);
    }

    pub fn writePayload(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, canonical_json: []const u8, pending_json: ?[]const u8, delivery_value: Delivery) !u32 {
        return self.writePayloadWith(allocator, uuid, canonical_json, pending_json, delivery_value, .sync);
    }

    /// `.deferred`: see rocks.Durability; the caller owes a covering sync.
    pub fn writePayloadWith(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, canonical_json: []const u8, pending_json: ?[]const u8, delivery_value: Delivery, durability: rocks.Durability) !u32 {
        const existing = try self.payloadIndex(allocator, uuid);
        const index = if (existing) |value| value else try std.math.add(u32, try self.highestPayloadIndex(allocator), 1);
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        if (existing == null) {
            try putInt(&batch, u32, highest_payload_index, &singleton, index);
            try putInt(&batch, u32, payload_index_by_uuid, &uuid, index);
            var encoded: [4]u8 = undefined;
            std.mem.writeInt(u32, &encoded, index, .big);
            try batch.put(payload_uuid_by_index, &encoded, &uuid);
        }
        try batch.put(payload_by_uuid, &uuid, canonical_json);
        try self.putPayloadPending(&batch, index, pending_json);
        try putDelivery(&batch, uuid, delivery_value);
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitWith(durability);
        try self.markPayloadCheckpoint(allocator);
        return index;
    }

    /// The checkpoint is a hint (as Rust's, which it writes unsynced): a
    /// stale or missing one only makes a reader re-validate or rebuild the
    /// pending index, and open always rebuilds it. Every row it describes was
    /// already committed before it in the ordered WAL (synced, or deferred
    /// with a covering sync owed), so it never survives a crash without them.
    fn markPayloadCheckpoint(self: Store, allocator: std.mem.Allocator) !void {
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try putInt(&batch, u64, pending_payload_index_checkpoint, &singleton, self.typed.database.sequence());
        try batch.commitUnsynced();
    }

    fn putPayloadPending(self: Store, batch: *rocks.TypedBatch, index: u32, pending_json: ?[]const u8) !void {
        if (pending_json != null) if (self.pending_floor) |floor| floor.lower(index);
        var encoded: [4]u8 = undefined;
        std.mem.writeInt(u32, &encoded, index, .big);
        if (pending_json) |json| try batch.put(pending_payload_by_index, &encoded, json) else try batch.delete(pending_payload_by_index, &encoded);
    }

    pub fn writeBuiltTransaction(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, payloads: []const PayloadUpdate) !u32 {
        errdefer self.invalidateActive();
        const existing = try self.transactionIndex(allocator, uuid);
        const index = if (existing) |value| value else try std.math.add(u32, try self.highestTransactionIndex(allocator), 1);
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        if (existing == null) {
            try putInt(&batch, u32, highest_tx_index, &singleton, index);
            try putInt(&batch, u32, tx_index_by_uuid, &uuid, index);
            var encoded: [4]u8 = undefined;
            std.mem.writeInt(u32, &encoded, index, .big);
            try batch.put(tx_uuid_by_index, &encoded, &uuid);
        }
        const status = try statusTag(allocator, transaction_json);
        try self.bumpAvailabilityIfChanged(&batch, allocator, uuid, status);
        const change = try putActive(&batch, index, uuid, existing == null or (status != .dropped and status != .finalized));
        try batch.put(transaction_by_uuid, &uuid, transaction_json);
        for (payloads) |payload| {
            const payload_index = (try self.payloadIndex(allocator, payload.uuid)) orelse return error.MissingPayload;
            try batch.put(payload_by_uuid, &payload.uuid, payload.canonical_json);
            try batch.put(transaction_uuid_by_payload_uuid, &payload.uuid, &uuid);
            try self.putPayloadPending(&batch, payload_index, payload.pending_json);
        }
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitSync();
        // Before any later fallible step: the change is durable now.
        self.applyActive(change);
        try self.markPayloadCheckpoint(allocator);
        return index;
    }

    pub fn writeTransaction(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8) !void {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        return self.writeTransactionRow(allocator, try self.describeRow(arena.allocator(), uuid, transaction_json));
    }

    /// `writeTransaction` for a caller that holds the decoded row and what it
    /// replaces: nothing is read back or decoded again.
    pub fn writeTransactionRow(self: Store, allocator: std.mem.Allocator, row: Row) !void {
        if (row.status == .finalized) return error.MissingFinalizedReceipt;
        errdefer self.invalidateActive();
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        const change = try self.putTransactionRow(&batch, allocator, row);
        try batch.commitSync();
        self.applyActive(change);
    }

    pub fn writeTransactionAndPayloads(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, payloads: []const PayloadUpdate) !void {
        return self.writeTransactionAndPayloadsWithReceipt(allocator, uuid, transaction_json, payloads, null);
    }

    pub fn writeTransactionAndPayloadsWithReceipt(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, payloads: []const PayloadUpdate, receipt: ?FinalizedReceipt) !void {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        return self.writeTransactionRowAndPayloads(allocator, try self.describeRow(arena.allocator(), uuid, transaction_json), payloads, receipt);
    }

    pub fn writeTransactionRowAndPayloads(self: Store, allocator: std.mem.Allocator, row: Row, payloads: []const PayloadUpdate, receipt: ?FinalizedReceipt) !void {
        if (row.status == .finalized and receipt == null) return error.MissingFinalizedReceipt;
        errdefer self.invalidateActive();
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        const change = try self.putTransactionRow(&batch, allocator, row);
        if (receipt) |value| try putFinalizedReceipt(&batch, value);
        for (payloads) |payload| {
            const payload_index = (try self.payloadIndex(allocator, payload.uuid)) orelse return error.MissingPayload;
            try batch.put(payload_by_uuid, &payload.uuid, payload.canonical_json);
            try self.putPayloadPending(&batch, payload_index, payload.pending_json);
        }
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitSync();
        // Before any later fallible step: the change is durable now.
        self.applyActive(change);
        try self.markPayloadCheckpoint(allocator);
    }

    /// A transaction row write, with what is known of the stored row it
    /// replaces, so the write reads nothing back.
    pub const Row = struct {
        uuid: types.Uuid,
        json: []const u8,
        status: StatusTag,
        /// The row's `tx_hashes`: the only hashes a finalized receipt of this
        /// transaction can be keyed by.
        hashes: []const types.Hash,
        prior: Prior,
    };

    pub const Prior = struct {
        /// Status of the stored row (null: no stored row).
        status: ?StatusTag,
        /// The transaction's index (null: not indexed).
        index: ?u32,
    };

    /// The `Row` of `json` for a caller that does not hold it decoded: the
    /// stored row and index are read. Allocations live in `arena`.
    fn describeRow(self: Store, arena: std.mem.Allocator, uuid: types.Uuid, json: []const u8) !Row {
        const raw = try json_view.fields(2, arena, json, .{ "status", "tx_hashes" });
        const status = std.meta.activeTag(try types.statusFromJson(try json_view.parseValue(arena, raw[0] orelse return error.InvalidLanderRecord)));
        var hashes: []types.Hash = &.{};
        if (raw[1]) |text| {
            const value = try json_view.parseValue(arena, text);
            if (value != .array) return error.InvalidLanderRecord;
            hashes = try arena.alloc(types.Hash, value.array.items.len);
            for (value.array.items, hashes) |item, *hash| {
                if (item != .string) return error.InvalidLanderRecord;
                hash.* = try types.parseHash(item.string);
            }
        }
        const old_status: ?StatusTag = if (try self.typed.get(arena, transaction_by_uuid, &uuid)) |old| try statusTag(arena, old) else null;
        return .{ .uuid = uuid, .json = json, .status = status, .hashes = hashes, .prior = .{ .status = old_status, .index = try self.transactionIndex(arena, uuid) } };
    }

    /// Puts the row and its derived changes: stale finalized receipts are
    /// removed, the nonce availability generation is bumped when the row's
    /// dropped-ness flips, and the active index follows the new status.
    fn putTransactionRow(self: Store, batch: *rocks.TypedBatch, allocator: std.mem.Allocator, row: Row) !?ActiveSet.Change {
        try deleteFinalizedReceipts(batch, allocator, row);
        if (row.prior.status) |old| if ((old == .dropped) != (row.status == .dropped)) {
            const next = try std.math.add(u64, try self.availabilityGeneration(allocator), 1);
            try putInt(batch, u64, nonce_availability_generation, &singleton, next);
        };
        const index = row.prior.index orelse {
            try batch.put(transaction_by_uuid, &row.uuid, row.json);
            return null;
        };
        const change = try putActive(batch, index, row.uuid, row.status != .dropped and row.status != .finalized);
        try batch.put(transaction_by_uuid, &row.uuid, row.json);
        return change;
    }

    pub fn loadFinalizedReceipt(self: Store, allocator: std.mem.Allocator, transaction_uuid: types.Uuid, transaction_hash: types.Hash) !?FinalizedReceipt {
        var key: [48]u8 = undefined;
        key[0..16].* = transaction_uuid;
        key[16..48].* = transaction_hash;
        const bytes = (try self.typed.get(allocator, finalized_receipt_by_uuid_hash, &key)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len != 123 and bytes.len != 155) return error.InvalidFinalizedReceipt;
        if (bytes[0] != 1) return error.InvalidFinalizedReceipt;
        if (bytes[89] > 1) return error.InvalidFinalizedReceipt;
        if (bytes[122] > 1) return error.InvalidFinalizedReceipt;
        if ((bytes[122] == 0) != (bytes.len == 123)) return error.InvalidFinalizedReceipt;
        if (!std.mem.eql(u8, bytes[1..17], &transaction_uuid) or !std.mem.eql(u8, bytes[17..49], &transaction_hash)) return error.InvalidFinalizedReceipt;
        return .{
            .transaction_uuid = transaction_uuid,
            .transaction_hash = transaction_hash,
            .block_number = std.mem.readInt(u64, bytes[49..57], .big),
            .block_hash = bytes[57..89].*,
            .executed = bytes[89] == 1,
            .gas_used = std.mem.readInt(u256, bytes[90..122], .little),
            .effective_gas_price = if (bytes[122] == 1) std.mem.readInt(u256, bytes[123..155], .little) else null,
        };
    }

    fn putFinalizedReceipt(batch: *rocks.TypedBatch, receipt: FinalizedReceipt) !void {
        if (receipt.version != 1) return error.InvalidFinalizedReceipt;
        var key: [48]u8 = undefined;
        key[0..16].* = receipt.transaction_uuid;
        key[16..48].* = receipt.transaction_hash;
        var bytes: [155]u8 = @splat(0);
        bytes[0] = 1;
        bytes[1..17].* = receipt.transaction_uuid;
        bytes[17..49].* = receipt.transaction_hash;
        std.mem.writeInt(u64, bytes[49..57], receipt.block_number, .big);
        bytes[57..89].* = receipt.block_hash;
        bytes[89] = @intFromBool(receipt.executed);
        std.mem.writeInt(u256, bytes[90..122], receipt.gas_used, .little);
        if (receipt.effective_gas_price) |price| {
            bytes[122] = 1;
            std.mem.writeInt(u256, bytes[123..155], price, .little);
        }
        try batch.put(finalized_receipt_by_uuid_hash, &key, if (receipt.effective_gas_price == null) bytes[0..123] else bytes[0..155]);
    }

    /// A finalized receipt is keyed by its transaction and winning hash, one
    /// of the row's `tx_hashes`. Leaving finalized removes all of them with a
    /// range delete (rare: a reorg past finality). Any other write removes
    /// only the row's own hashes with point deletes, which also clears what a
    /// foreign writer (a Rust rollback) left behind, without putting a range
    /// tombstone in front of every later read.
    fn deleteFinalizedReceipts(batch: *rocks.TypedBatch, allocator: std.mem.Allocator, row: Row) !void {
        if (row.prior.status == .finalized) {
            const prefix = try keys.scoped(allocator, batch.domain_name, finalized_receipt_by_uuid_hash, &row.uuid);
            defer allocator.free(prefix);
            return batch.batch.deletePrefix(allocator, prefix);
        }
        for (row.hashes) |hash| {
            var key: [48]u8 = undefined;
            key[0..16].* = row.uuid;
            key[16..48].* = hash;
            try batch.delete(finalized_receipt_by_uuid_hash, &key);
        }
    }

    pub const SubmissionAttempt = struct { hash: types.Hash, nonce: u256, bytes: []const u8 };

    pub fn writeSubmission(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, attempt: ?SubmissionAttempt) !void {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        return self.writeSubmissionRow(allocator, try self.describeRow(arena.allocator(), uuid, transaction_json), attempt);
    }

    pub fn writeSubmissionRow(self: Store, allocator: std.mem.Allocator, row: Row, attempt: ?SubmissionAttempt) !void {
        if (row.status == .finalized) return error.MissingFinalizedReceipt;
        errdefer self.invalidateActive();
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        const change = try self.putTransactionRow(&batch, allocator, row);
        if (attempt) |value| try putAttempt(&batch, row.uuid, value.hash, value.nonce, value.bytes);
        try batch.commitSync();
        self.applyActive(change);
    }

    pub fn finalizedNonce(self: Store, allocator: std.mem.Allocator, signer: types.Address) !?u256 {
        const present = (try self.typed.get(allocator, finalized_nonce_present_by_signer, &signer)) orelse null;
        defer if (present) |bytes| allocator.free(bytes);
        if (present) |bytes| {
            if (bytes.len != 1 or bytes[0] > 1) return error.InvalidLanderRecord;
            if (bytes[0] == 0) return null;
        }
        return self.getInt(u256, allocator, finalized_nonce_by_signer, &signer);
    }

    pub fn upperNonce(self: Store, allocator: std.mem.Allocator, signer: types.Address) !u256 {
        return (try self.getInt(u256, allocator, upper_nonce_by_signer, &signer)) orelse 0;
    }

    pub fn reorgRange(self: Store, allocator: std.mem.Allocator, signer: types.Address) !?ReorgRange {
        const bytes = (try self.typed.get(allocator, reorged_nonce_range_by_signer, &signer)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len == 0 or bytes[0] > 1) return error.InvalidLanderRecord;
        if (bytes[0] == 0) return null;
        if (bytes.len != 65) return error.InvalidLanderRecord;
        return .{
            .start = std.mem.readInt(u256, bytes[1..33], .little),
            .end = std.mem.readInt(u256, bytes[33..65], .little),
        };
    }

    pub fn trackedUuid(self: Store, allocator: std.mem.Allocator, signer: types.Address, nonce: u256) !types.Uuid {
        const key = nonceSignerKey(nonce, signer);
        const bytes = (try self.typed.get(allocator, transaction_uuid_by_nonce_and_signer, &key)) orelse return types.nil_uuid;
        defer allocator.free(bytes);
        if (bytes.len != 16) return error.InvalidLanderRecord;
        return bytes[0..16].*;
    }

    pub fn transactionNonce(self: Store, allocator: std.mem.Allocator, signer: types.Address, uuid: types.Uuid) !?u256 {
        var key: [36]u8 = undefined;
        key[0..20].* = signer;
        key[20..36].* = uuid;
        const nonce = (try self.getInt(u256, allocator, evm_nonce_by_transaction_uuid, &key)) orelse return null;
        return if (nonce == std.math.maxInt(u256)) null else nonce;
    }

    pub fn putFinalized(batch: *rocks.TypedBatch, signer: types.Address, nonce: ?u256) !void {
        if (nonce) |value| {
            try putInt(batch, u256, finalized_nonce_by_signer, &signer, value);
            try batch.put(finalized_nonce_present_by_signer, &signer, &.{1});
        } else {
            try batch.put(finalized_nonce_present_by_signer, &signer, &.{0});
        }
    }

    pub fn putUpper(batch: *rocks.TypedBatch, signer: types.Address, nonce: u256) !void {
        try putInt(batch, u256, upper_nonce_by_signer, &signer, nonce);
    }

    pub fn putReorgRange(batch: *rocks.TypedBatch, signer: types.Address, range: ?ReorgRange) !void {
        if (range) |value| {
            var bytes: [65]u8 = undefined;
            bytes[0] = 1;
            std.mem.writeInt(u256, bytes[1..33], value.start, .little);
            std.mem.writeInt(u256, bytes[33..65], value.end, .little);
            try batch.put(reorged_nonce_range_by_signer, &signer, &bytes);
        } else {
            try batch.put(reorged_nonce_range_by_signer, &signer, &.{0});
        }
    }

    pub fn putTracked(batch: *rocks.TypedBatch, signer: types.Address, nonce: u256, uuid: types.Uuid) !void {
        const key = nonceSignerKey(nonce, signer);
        try batch.put(transaction_uuid_by_nonce_and_signer, &key, &uuid);
        var reverse: [36]u8 = undefined;
        reverse[0..20].* = signer;
        reverse[20..36].* = uuid;
        try putInt(batch, u256, evm_nonce_by_transaction_uuid, &reverse, nonce);
    }

    pub fn clearTracked(batch: *rocks.TypedBatch, signer: types.Address, nonce: u256, uuid: types.Uuid) !void {
        const key = nonceSignerKey(nonce, signer);
        try batch.put(transaction_uuid_by_nonce_and_signer, &key, &types.nil_uuid);
        var reverse: [36]u8 = undefined;
        reverse[0..20].* = signer;
        reverse[20..36].* = uuid;
        try putInt(batch, u256, evm_nonce_by_transaction_uuid, &reverse, std.math.maxInt(u256));
    }

    pub fn putAttempt(batch: *rocks.TypedBatch, uuid: types.Uuid, hash: types.Hash, nonce: u256, signed_bytes: []const u8) !void {
        if (signed_bytes.len == 0) return error.InvalidTransactionSize;
        var key: [48]u8 = undefined;
        key[0..16].* = uuid;
        key[16..48].* = hash;
        const allocator = batch.allocator;
        const value = try allocator.alloc(u8, 33 + signed_bytes.len);
        defer allocator.free(value);
        value[0] = 1;
        std.mem.writeInt(u256, value[1..33], nonce, .little);
        @memcpy(value[33..], signed_bytes);
        try batch.put(signed_attempt_by_uuid_hash, &key, value);
    }

    pub const Attempt = struct { nonce: u256, bytes: []u8 };

    pub fn loadAttempt(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, hash: types.Hash) !?Attempt {
        var key: [48]u8 = undefined;
        key[0..16].* = uuid;
        key[16..48].* = hash;
        const bytes = (try self.typed.get(allocator, signed_attempt_by_uuid_hash, &key)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len < 34 or bytes[0] != 1) return error.InvalidSignedAttempt;
        return .{ .nonce = std.mem.readInt(u256, bytes[1..33], .little), .bytes = try allocator.dupe(u8, bytes[33..]) };
    }

    /// Pending payload rows from the floor on (all of them without one).
    /// Null when the floor says none exist. Call `observeFirstPending` with
    /// the first entry before any write.
    pub fn pendingPayloads(self: Store, allocator: std.mem.Allocator) !?rocks.PrefixIterator {
        const floor = if (self.pending_floor) |value| value.index else 0;
        if (floor == PendingFloor.none) return null;
        var start: [4]u8 = undefined;
        std.mem.writeInt(u32, &start, @intCast(floor), .big);
        return try self.typed.prefixFrom(allocator, pending_payload_by_index, &start);
    }

    /// Raises the floor to the first row (`key`: its encoded index) a fresh
    /// `pendingPayloads` scan saw.
    pub fn observeFirstPending(self: Store, key: ?[]const u8) void {
        const floor = self.pending_floor orelse return;
        const first = key orelse return floor.observe(null);
        if (first.len != 4) return;
        floor.observe(std.mem.readInt(u32, first[0..4], .big));
    }

    /// Test oracle: no pending row lies below the floor.
    pub fn pendingFloorHolds(self: Store, allocator: std.mem.Allocator) !bool {
        const floor = self.pending_floor orelse return true;
        var iterator = try self.typed.prefix(allocator, pending_payload_by_index);
        defer iterator.deinit();
        const first = (try iterator.nextBorrowed()) orelse return true;
        return first.key.len == 4 and std.mem.readInt(u32, first.key[0..4], .big) >= floor.index;
    }

    pub fn attemptPrefix(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) ![]u8 {
        return keys.scoped(allocator, self.typed.domain_name, signed_attempt_by_uuid_hash, &uuid);
    }

    pub fn delivery(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?OwnedDelivery {
        const bytes = (try self.typed.get(allocator, delivery_by_payload_uuid, &uuid)) orelse return null;
        defer allocator.free(bytes);
        if (bytes.len < 2 or bytes[0] != 1) return error.InvalidDeliveryRecord;
        return switch (bytes[1]) {
            0 => if (bytes.len == 2) .{ .value = .none } else error.InvalidDeliveryRecord,
            1 => if (bytes.len == 34) .{ .value = .{ .mailbox_message = bytes[2..34].* } } else error.InvalidDeliveryRecord,
            2 => blk: {
                if (bytes.len < 26) return error.InvalidDeliveryRecord;
                const length = std.mem.readInt(u32, bytes[22..26], .big);
                if (bytes.len != 26 + length) return error.InvalidDeliveryRecord;
                const calldata = try allocator.dupe(u8, bytes[26..]);
                break :blk .{ .value = .{ .contract = .{ .to = bytes[2..22].*, .calldata = calldata } }, .calldata = calldata };
            },
            else => error.InvalidDeliveryRecord,
        };
    }
};

pub const StatusTag = std.meta.Tag(types.Status);

/// The status of a stored transaction row, decoding only its status field.
pub fn statusTag(allocator: std.mem.Allocator, json: []const u8) !StatusTag {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const raw = (try json_view.field(arena.allocator(), json, "status")) orelse return error.InvalidLanderRecord;
    return std.meta.activeTag(try types.statusFromJson(try json_view.parseValue(arena.allocator(), raw)));
}

fn nonceSignerKey(nonce: u256, signer: types.Address) [52]u8 {
    var key: [52]u8 = undefined;
    std.mem.writeInt(u256, key[0..32], nonce, .little);
    key[32..52].* = signer;
    return key;
}

fn putDelivery(batch: *rocks.TypedBatch, uuid: types.Uuid, delivery: Delivery) !void {
    const allocator = batch.allocator;
    const length: usize = switch (delivery) {
        .none => 2,
        .mailbox_message => 34,
        .contract => |call| try std.math.add(usize, 26, call.calldata.len),
    };
    const bytes = try allocator.alloc(u8, length);
    defer allocator.free(bytes);
    bytes[0] = 1;
    switch (delivery) {
        .none => bytes[1] = 0,
        .mailbox_message => |id| {
            bytes[1] = 1;
            bytes[2..34].* = id;
        },
        .contract => |call| {
            bytes[1] = 2;
            bytes[2..22].* = call.to;
            std.mem.writeInt(u32, bytes[22..26], std.math.cast(u32, call.calldata.len) orelse return error.InvalidDeliveryRecord, .big);
            @memcpy(bytes[26..], call.calldata);
        },
    }
    try batch.put(delivery_by_payload_uuid, &uuid, bytes);
}
