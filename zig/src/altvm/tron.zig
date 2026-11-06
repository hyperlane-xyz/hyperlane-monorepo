//! Tron protobuf construction mirrors hyperlane-tron/provider/tron.rs.
//! TXID is SHA256(raw_data), signed directly without the EIP-191 envelope.
const std = @import("std");
const base58 = @import("base58.zig");
const protobuf = @import("protobuf.zig");
const cosmos = @import("cosmos.zig");
const sig = @import("../protocol/signature.zig");
pub const Address = [21]u8;

pub fn fromEthereumAddress(address: [20]u8) Address {
    var tron: Address = undefined;
    tron[0] = 0x41;
    tron[1..21].* = address;
    return tron;
}

pub fn secretKeyAddress(secret_key: [32]u8) !Address {
    return fromEthereumAddress(try sig.secretKeyAddress(secret_key));
}

fn checksum(bytes: []const u8) [4]u8 {
    var first: [32]u8 = undefined;
    var second: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &first, .{});
    std.crypto.hash.sha2.Sha256.hash(&first, &second, .{});
    return second[0..4].*;
}

pub fn encodeAddress(allocator: std.mem.Allocator, address: Address) ![]u8 {
    if (address[0] != 0x41) return error.InvalidTronPrefix;
    var bytes: [25]u8 = undefined;
    bytes[0..21].* = address;
    bytes[21..25].* = checksum(&address);
    return base58.encode(allocator, &bytes);
}

pub fn decodeAddress(allocator: std.mem.Allocator, text: []const u8) !Address {
    // 21-byte Tron payload + 4-byte checksum always produces 34 characters.
    if (text.len != 34) return error.InvalidTronAddressLength;
    const bytes = try base58.decode(allocator, text);
    defer allocator.free(bytes);
    if (bytes.len != 25) return error.InvalidTronAddressLength;
    if (bytes[0] != 0x41) return error.InvalidTronPrefix;
    if (!std.mem.eql(u8, bytes[21..25], &checksum(bytes[0..21]))) return error.InvalidTronChecksum;
    return bytes[0..21].*;
}

pub const Trigger = struct { owner: Address, contract: Address, call_value: u64 = 0, data: []const u8 };
pub const Reference = struct { block_number: u64, block_hash: [32]u8, timestamp_ms: u64, expiration_ms: u64, fee_limit: u64 };

pub fn rawTransaction(allocator: std.mem.Allocator, trigger: Trigger, reference: Reference) ![]u8 {
    if (trigger.owner[0] != 0x41 or trigger.contract[0] != 0x41) return error.InvalidTronPrefix;
    if (reference.expiration_ms <= reference.timestamp_ms) return error.InvalidExpiration;
    for ([_]u64{ trigger.call_value, reference.block_number, reference.timestamp_ms, reference.expiration_ms, reference.fee_limit }) |value|
        if (value > std.math.maxInt(i64)) return error.TronIntegerOverflow;
    var trigger_encoder: protobuf.Encoder = .{ .out = try allocator.alloc(u8, try std.math.add(usize, trigger.data.len, 80)) };
    defer allocator.free(trigger_encoder.out);
    try trigger_encoder.bytes(1, &trigger.owner);
    try trigger_encoder.bytes(2, &trigger.contract);
    try trigger_encoder.uint(3, trigger.call_value);
    try trigger_encoder.bytes(4, trigger.data);
    const any = try cosmos.encodeAny(allocator, .{ .type_url = "/protocol.TriggerSmartContract", .value = trigger_encoder.written() });
    defer allocator.free(any);
    var contract_encoder: protobuf.Encoder = .{ .out = try allocator.alloc(u8, try std.math.add(usize, any.len, 32)) };
    defer allocator.free(contract_encoder.out);
    try contract_encoder.uint(1, 31);
    try contract_encoder.message(2, any);
    var enc: protobuf.Encoder = .{ .out = try allocator.alloc(u8, try std.math.add(usize, contract_encoder.pos, 96)) };
    errdefer allocator.free(enc.out);
    var block_bytes: [2]u8 = undefined;
    std.mem.writeInt(u16, &block_bytes, @truncate(reference.block_number), .big);
    try enc.bytes(1, &block_bytes);
    try enc.uint(3, reference.block_number);
    try enc.bytes(4, reference.block_hash[8..16]);
    try enc.uint(8, reference.expiration_ms);
    try enc.message(11, contract_encoder.written());
    try enc.uint(14, reference.timestamp_ms);
    try enc.uint(18, reference.fee_limit);
    return allocator.realloc(enc.out, enc.pos);
}

pub fn txId(raw: []const u8) [32]u8 {
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &hash, .{});
    return hash;
}

/// Returns v=27/28 matching the existing Rust ethers Signature::to_vec().
/// Tron also accepts recovery IDs 0/1, but callers must choose one convention.
pub fn signRaw(secret_key: [32]u8, raw: []const u8, noise: ?[32]u8) !sig.Signature {
    return sig.signDigest(secret_key, txId(raw), noise);
}

pub fn signedTransaction(allocator: std.mem.Allocator, raw: []const u8, signatures: []const sig.Signature) ![]u8 {
    const signatures_size = try std.math.mul(usize, signatures.len, 80);
    const size = try std.math.add(usize, try std.math.add(usize, raw.len, signatures_size), 16);
    var enc: protobuf.Encoder = .{ .out = try allocator.alloc(u8, size) };
    errdefer allocator.free(enc.out);
    try enc.message(1, raw);
    for (signatures) |signature| try enc.message(2, &signature);
    return allocator.realloc(enc.out, enc.pos);
}

test "Tron zero-address base58check fixture and checksum rejection" {
    const allocator = std.testing.allocator;
    const address = fromEthereumAddress(.{0} ** 20);
    const encoded = try encodeAddress(allocator, address);
    defer allocator.free(encoded);
    try std.testing.expectEqualStrings("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", encoded);
    try std.testing.expectEqual(address, try decodeAddress(allocator, encoded));
    encoded[33] = if (encoded[33] == '1') '2' else '1';
    try std.testing.expectError(error.InvalidTronChecksum, decodeAddress(allocator, encoded));
}

test "Tron raw transaction TAPOS and direct signature" {
    const allocator = std.testing.allocator;
    const key = [_]u8{0x11} ** 32;
    const owner = try secretKeyAddress(key);
    const raw = try rawTransaction(allocator, .{ .owner = owner, .contract = fromEthereumAddress(.{0x22} ** 20), .data = &.{ 1, 2, 3 } }, .{ .block_number = 0x123456, .block_hash = .{0x33} ** 32, .timestamp_ms = 1700000000000, .expiration_ms = 1700000060000, .fee_limit = 100000000 });
    defer allocator.free(raw);
    var dec: protobuf.Decoder = .{ .input = raw };
    try std.testing.expectEqualSlices(u8, &.{ 0x34, 0x56 }, (try dec.next()).?.value.bytes);
    try std.testing.expectEqual(@as(u64, 0x123456), (try dec.next()).?.value.uint);
    try std.testing.expectEqualSlices(u8, &(.{0x33} ** 8), (try dec.next()).?.value.bytes);
    const signature = try signRaw(key, raw, null);
    try std.testing.expectEqualSlices(u8, owner[1..21], &try sig.recover(txId(raw), signature));
    const signed = try signedTransaction(allocator, raw, &.{signature});
    defer allocator.free(signed);
    var signed_decoder: protobuf.Decoder = .{ .input = signed };
    try std.testing.expectEqualSlices(u8, raw, (try signed_decoder.next()).?.value.bytes);
    try std.testing.expectEqualSlices(u8, &signature, (try signed_decoder.next()).?.value.bytes);
}
