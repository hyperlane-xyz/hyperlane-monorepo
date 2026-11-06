//! Crash-safe relation between an origin message and a destination Lander
//! payload. Seal the exact replay input and Rust UUID relation in one durable
//! origin batch BEFORE enqueue; replay uses that input after any interruption.
const std = @import("std");
const native = @import("store.zig");
const db = @import("../db/root.zig");
const lander = @import("../lander/root.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
pub const Uuid = [16]u8;
const prefix = "zig_relayer_payload_link_v1/";
const generation_prefix = "zig_relayer_payload_generation_v1/";
pub const max_record_bytes = 8 * 1024 * 1024;
pub const Record = struct {
    version: u8 = 1,
    context: Hash,
    message_id: Hash,
    generation: u64,
    estimated_gas: ?u256 = null,
    payload: lander.records.PayloadInput,
    delivery: lander.store.Delivery,
};
pub const Link = struct {
    parsed: std.json.Parsed(Record),
    store: *native.Store,
    pub fn record(self: *const Link) *const Record {
        return &self.parsed.value;
    }
    pub fn deinit(self: *Link) void {
        self.parsed.deinit();
        self.* = undefined;
    }
    /// Enqueue has no signing or broadcasting effects. The destination owner
    /// recovers nonce/transaction state independently before executing payloads.
    pub fn replay(self: *const Link, destination: anytype) !void {
        const value = self.record();
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        try ensureCanonical(self.store, value.message_id);
        const relation = try inheritedUuids(self.store.allocator, self.store, value.message_id);
        defer self.store.allocator.free(relation);
        if (relation.len != 1 or !std.mem.eql(u8, &relation[0], &value.payload.uuid)) return error.PayloadRelationChanged;
        _ = try destination.enqueue(.{ .payload = value.payload, .delivery = value.delivery });
    }
};

/// UUIDv8 custom namespace: context and message ID are fixed-width, generation
/// is big-endian. It closes the origin-link/destination-enqueue crash window.
pub fn uuid(context: Hash, message_id: Hash, generation: u64) Uuid {
    var digest = std.crypto.hash.sha2.Sha256.init(.{});
    digest.update("hyperlane-zig-relayer-payload-v1\x00");
    digest.update(&context);
    digest.update(&message_id);
    var counter: [8]u8 = undefined;
    std.mem.writeInt(u64, &counter, generation, .big);
    digest.update(&counter);
    var hash: Hash = undefined;
    digest.final(&hash);
    var out = hash[0..16].*;
    out[6] = (out[6] & 0x0f) | 0x80;
    out[8] = (out[8] & 0x3f) | 0x80;
    return out;
}

fn validate(a: A, value: Record) !void {
    if (value.version != 1 or value.generation == 0 or !std.mem.eql(u8, &value.payload.uuid, &uuid(value.context, value.message_id, value.generation))) return error.InvalidPayloadLink;
    if (value.delivery != .mailbox_message or !std.mem.eql(u8, &value.delivery.mailbox_message, &value.message_id)) return error.PayloadDeliveryIdentityMismatch;
    // Validate through the same canonical production payload decoder that the
    // real destination owner uses. This allocates no nonce or signatures.
    var canonical = lander.records.OwnedJson.init(a);
    defer canonical.deinit();
    try lander.records.createPayload(&canonical, value.payload);
}

pub fn load(a: A, store: *native.Store, message_id: Hash, context: Hash) !?Link {
    store.mutex.lock();
    defer store.mutex.unlock();
    const bytes = (try store.typed.get(a, prefix, &message_id)) orelse return null;
    defer a.free(bytes);
    if (bytes.len > max_record_bytes) return error.PayloadLinkTooLarge;
    var parsed = try std.json.parseFromSlice(Record, a, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
    errdefer parsed.deinit();
    if (!std.mem.eql(u8, &parsed.value.context, &context) or !std.mem.eql(u8, &parsed.value.message_id, &message_id)) return error.PayloadLinkContextChanged;
    try validate(a, parsed.value);
    try ensureCanonical(store, message_id);
    return .{ .parsed = parsed, .store = store };
}

fn ensureCanonical(store: *native.Store, message_id: Hash) !void {
    var message = (try store.messageById(message_id)) orelse return error.UnknownCanonicalMessage;
    defer message.deinit();
    if (!try store.operationMessageAuthorized(message.value)) return error.StaleCanonicalMessage;
}

pub fn inheritedUuids(a: A, store: *native.Store, message_id: Hash) ![]Uuid {
    const bytes = (try store.typed.get(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &message_id)) orelse return a.alloc(Uuid, 0);
    defer a.free(bytes);
    // A relayer message currently creates one payload; retain bounded support
    // for older multi-payload records without unbounded database allocation.
    if (bytes.len > 8 + 4096 * @sizeOf(Uuid)) return error.TooManyInheritedPayloads;
    return db.codec.decodeUuids(a, bytes);
}

/// Existing relations must be reconciled first. A different generation/input
/// cannot silently overwrite one that may already have reached the chain.
pub fn seal(a: A, store: *native.Store, value: Record) !void {
    try validate(a, value);
    const encoded = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(encoded);
    if (encoded.len > max_record_bytes) return error.PayloadLinkTooLarge;
    store.mutex.lock();
    defer store.mutex.unlock();
    const old = try store.typed.get(a, prefix, &value.message_id);
    defer if (old) |bytes| a.free(bytes);
    const inherited = try inheritedUuids(a, store, value.message_id);
    defer a.free(inherited);
    try ensureCanonical(store, value.message_id);
    if (old) |bytes| {
        if (!std.mem.eql(u8, bytes, encoded)) return error.PayloadLinkConflict;
        if (inherited.len == 1 and std.mem.eql(u8, &inherited[0], &value.payload.uuid)) return;
        return error.PayloadRelationChanged;
    }
    if (inherited.len != 0) return error.InheritedPayloadNeedsReconciliation;
    const previous = try store.typed.get(a, generation_prefix, &value.message_id);
    defer if (previous) |bytes| a.free(bytes);
    if (previous) |bytes| {
        if (bytes.len != 8) return error.InvalidPayloadGeneration;
        if (value.generation <= std.mem.readInt(u64, bytes[0..8], .big)) return error.StalePayloadGeneration;
    }
    const relation = try db.codec.encodeUuids(a, &.{value.payload.uuid});
    defer a.free(relation);
    var batch = try store.typed.batch(a);
    defer batch.deinit();
    try batch.put(prefix, &value.message_id, encoded);
    var generation: [8]u8 = undefined;
    std.mem.writeInt(u64, &generation, value.generation, .big);
    try batch.put(generation_prefix, &value.message_id, &generation);
    try batch.put(db.keys.Table.payload_uuids_by_message_id.prefix(), &value.message_id, relation);
    try batch.commitSync();
}

/// Call only after a real destination status proves the relation terminal.
/// Compare every UUID under the origin lock so a concurrent newer relation
/// cannot be removed by an old receipt or administrative request.
pub fn clearTerminal(a: A, store: *native.Store, message_id: Hash, expected: []const Uuid) !void {
    store.mutex.lock();
    defer store.mutex.unlock();
    const actual = try inheritedUuids(a, store, message_id);
    defer a.free(actual);
    if (!std.mem.eql(u8, std.mem.sliceAsBytes(actual), std.mem.sliceAsBytes(expected))) return error.PayloadRelationChanged;
    var batch = try store.typed.batch(a);
    defer batch.deinit();
    try batch.delete(prefix, &message_id);
    try batch.delete(db.keys.Table.payload_uuids_by_message_id.prefix(), &message_id);
    try batch.commitSync();
}

test "payload UUID namespace separates chain authority message and retry generation" {
    const a = uuid(@splat(1), @splat(2), 1);
    try std.testing.expectEqual(a, uuid(@splat(1), @splat(2), 1));
    try std.testing.expect(!std.mem.eql(u8, &a, &uuid(@splat(3), @splat(2), 1)));
    try std.testing.expect(!std.mem.eql(u8, &a, &uuid(@splat(1), @splat(3), 1)));
    try std.testing.expect(!std.mem.eql(u8, &a, &uuid(@splat(1), @splat(2), 2)));
    try std.testing.expectEqual(@as(u8, 8), a[6] >> 4);
    try std.testing.expectEqual(@as(u8, 2), a[8] >> 6);
}
