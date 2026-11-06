const std = @import("std");
const rocks = @import("../db/rocks.zig");
const codec = @import("../db/codec.zig");
const keys = @import("../db/keys.zig");
const types = @import("types.zig");

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

pub const Store = struct {
    typed: rocks.Typed,

    pub fn init(database: *rocks.Database, domain_name: []const u8) Store {
        return .{ .typed = .{ .database = database, .domain_name = domain_name } };
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

    pub fn transactionStatus(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid) !?OwnedStatus {
        var record = (try self.loadTransaction(allocator, uuid)) orelse return null;
        defer record.deinit();
        var status = try types.statusFromJson(try types.field(record.value(), "status"));
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

    fn bumpAvailabilityIfChanged(self: Store, batch: *rocks.TypedBatch, allocator: std.mem.Allocator, uuid: types.Uuid, new_json: []const u8) !void {
        const old_bytes = (try self.typed.get(allocator, transaction_by_uuid, &uuid)) orelse return;
        defer allocator.free(old_bytes);
        var old_parsed = try std.json.parseFromSlice(std.json.Value, allocator, old_bytes, .{});
        defer old_parsed.deinit();
        var new_parsed = try std.json.parseFromSlice(std.json.Value, allocator, new_json, .{});
        defer new_parsed.deinit();
        const old_status = try types.statusFromJson(try types.field(old_parsed.value, "status"));
        const new_status = try types.statusFromJson(try types.field(new_parsed.value, "status"));
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

    pub fn putActive(batch: *rocks.TypedBatch, index: u32, uuid: types.Uuid, active: bool) !void {
        var encoded: [4]u8 = undefined;
        std.mem.writeInt(u32, &encoded, index, .big);
        if (active) try batch.put(active_tx_by_index, &encoded, &uuid) else try batch.delete(active_tx_by_index, &encoded);
    }

    pub fn setActive(self: Store, allocator: std.mem.Allocator, index: u32, uuid: types.Uuid, active: bool) !void {
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try putActive(&batch, index, uuid, active);
        try batch.commitSync();
    }

    fn updateActive(self: Store, batch: *rocks.TypedBatch, allocator: std.mem.Allocator, uuid: types.Uuid, json: []const u8) !void {
        const index = (try self.transactionIndex(allocator, uuid)) orelse return;
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
        defer parsed.deinit();
        const status = try types.statusFromJson(try types.field(parsed.value, "status"));
        try putActive(batch, index, uuid, status.isActive());
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
        try batch.commitSync();
        try self.markPayloadCheckpoint(allocator);
        return index;
    }

    fn markPayloadCheckpoint(self: Store, allocator: std.mem.Allocator) !void {
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try putInt(&batch, u64, pending_payload_index_checkpoint, &singleton, self.typed.database.sequence());
        try batch.commitSync();
    }

    fn putPayloadPending(self: Store, batch: *rocks.TypedBatch, index: u32, pending_json: ?[]const u8) !void {
        _ = self;
        var encoded: [4]u8 = undefined;
        std.mem.writeInt(u32, &encoded, index, .big);
        if (pending_json) |json| try batch.put(pending_payload_by_index, &encoded, json) else try batch.delete(pending_payload_by_index, &encoded);
    }

    pub fn writeBuiltTransaction(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, payloads: []const PayloadUpdate) !u32 {
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
        try self.bumpAvailabilityIfChanged(&batch, allocator, uuid, transaction_json);
        try self.updateActive(&batch, allocator, uuid, transaction_json);
        if (existing == null) try putActive(&batch, index, uuid, true);
        try batch.put(transaction_by_uuid, &uuid, transaction_json);
        for (payloads) |payload| {
            const payload_index = (try self.payloadIndex(allocator, payload.uuid)) orelse return error.MissingPayload;
            try batch.put(payload_by_uuid, &payload.uuid, payload.canonical_json);
            try batch.put(transaction_uuid_by_payload_uuid, &payload.uuid, &uuid);
            try self.putPayloadPending(&batch, payload_index, payload.pending_json);
        }
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitSync();
        try self.markPayloadCheckpoint(allocator);
        return index;
    }

    pub fn writeTransaction(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8) !void {
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, transaction_json, .{});
        defer parsed.deinit();
        const status = try types.statusFromJson(try types.field(parsed.value, "status"));
        if (status == .finalized) return error.MissingFinalizedReceipt;
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try deleteFinalizedReceiptsForTransaction(&batch, allocator, uuid);
        try self.bumpAvailabilityIfChanged(&batch, allocator, uuid, transaction_json);
        try self.updateActive(&batch, allocator, uuid, transaction_json);
        try batch.put(transaction_by_uuid, &uuid, transaction_json);
        try batch.commitSync();
    }

    pub fn writeTransactionAndPayloads(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, payloads: []const PayloadUpdate) !void {
        return self.writeTransactionAndPayloadsWithReceipt(allocator, uuid, transaction_json, payloads, null);
    }

    pub fn writeTransactionAndPayloadsWithReceipt(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, payloads: []const PayloadUpdate, receipt: ?FinalizedReceipt) !void {
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, transaction_json, .{});
        defer parsed.deinit();
        const status = try types.statusFromJson(try types.field(parsed.value, "status"));
        if (status == .finalized and receipt == null) return error.MissingFinalizedReceipt;
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try deleteFinalizedReceiptsForTransaction(&batch, allocator, uuid);
        if (receipt) |value| try putFinalizedReceipt(&batch, value);
        try self.bumpAvailabilityIfChanged(&batch, allocator, uuid, transaction_json);
        try self.updateActive(&batch, allocator, uuid, transaction_json);
        try batch.put(transaction_by_uuid, &uuid, transaction_json);
        for (payloads) |payload| {
            const payload_index = (try self.payloadIndex(allocator, payload.uuid)) orelse return error.MissingPayload;
            try batch.put(payload_by_uuid, &payload.uuid, payload.canonical_json);
            try self.putPayloadPending(&batch, payload_index, payload.pending_json);
        }
        try batch.put(pending_payload_index_write_marker, &singleton, &.{1});
        try batch.commitSync();
        try self.markPayloadCheckpoint(allocator);
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

    fn deleteFinalizedReceiptsForTransaction(batch: *rocks.TypedBatch, allocator: std.mem.Allocator, transaction_uuid: types.Uuid) !void {
        const prefix = try keys.scoped(allocator, batch.domain_name, finalized_receipt_by_uuid_hash, &transaction_uuid);
        defer allocator.free(prefix);
        try batch.batch.deletePrefix(allocator, prefix);
    }

    pub fn writeSubmission(self: Store, allocator: std.mem.Allocator, uuid: types.Uuid, transaction_json: []const u8, attempt: ?struct { hash: types.Hash, nonce: u256, bytes: []const u8 }) !void {
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, transaction_json, .{});
        defer parsed.deinit();
        const status = try types.statusFromJson(try types.field(parsed.value, "status"));
        if (status == .finalized) return error.MissingFinalizedReceipt;
        var batch = try self.typed.batch(allocator);
        defer batch.deinit();
        try deleteFinalizedReceiptsForTransaction(&batch, allocator, uuid);
        try self.bumpAvailabilityIfChanged(&batch, allocator, uuid, transaction_json);
        try self.updateActive(&batch, allocator, uuid, transaction_json);
        try batch.put(transaction_by_uuid, &uuid, transaction_json);
        if (attempt) |value| try putAttempt(&batch, uuid, value.hash, value.nonce, value.bytes);
        try batch.commitSync();
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
