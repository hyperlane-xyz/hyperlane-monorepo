//! ArbL2ToL1 Outbox metadata ABI codec from the TypeScript relayer. Bridge
//! status/proof construction remains unsupported because Rust has no builder.
const std = @import("std");
const evm = @import("../../evm/root.zig");

pub const Hash = [32]u8;
pub const Address = [20]u8;
pub const head_len = 9 * 32;

pub const Metadata = struct {
    proof: []const Hash,
    position: u256,
    caller: Address,
    destination: Address,
    arb_block_num: u256,
    eth_block_num: u256,
    timestamp: u256,
    callvalue: u256,
    data: []const u8,

    pub fn encodedLen(self: Metadata) !usize {
        const proof_len = try std.math.add(usize, 32, try std.math.mul(usize, self.proof.len, 32));
        const data_padding = (32 - self.data.len % 32) % 32;
        const data_len = try std.math.add(usize, 32, try std.math.add(usize, self.data.len, data_padding));
        return std.math.add(usize, head_len, try std.math.add(usize, proof_len, data_len));
    }

    pub fn encode(self: Metadata, out: []u8) ![]u8 {
        const length = try self.encodedLen();
        if (out.len < length) return error.BufferTooSmall;
        @memset(out[0..length], 0);
        const data_offset = head_len + 32 + self.proof.len * 32;
        std.mem.writeInt(u256, out[0..32], head_len, .big);
        std.mem.writeInt(u256, out[32..64], self.position, .big);
        out[76..96].* = self.caller;
        out[108..128].* = self.destination;
        std.mem.writeInt(u256, out[128..160], self.arb_block_num, .big);
        std.mem.writeInt(u256, out[160..192], self.eth_block_num, .big);
        std.mem.writeInt(u256, out[192..224], self.timestamp, .big);
        std.mem.writeInt(u256, out[224..256], self.callvalue, .big);
        std.mem.writeInt(u256, out[256..288], data_offset, .big);
        std.mem.writeInt(u256, out[head_len..][0..32], self.proof.len, .big);
        for (self.proof, 0..) |hash, i| out[head_len + 32 + i * 32 ..][0..32].* = hash;
        std.mem.writeInt(u256, out[data_offset..][0..32], self.data.len, .big);
        @memcpy(out[data_offset + 32 ..][0..self.data.len], self.data);
        return out[0..length];
    }

    pub fn encodeAlloc(self: Metadata, allocator: std.mem.Allocator) ![]u8 {
        const out = try allocator.alloc(u8, try self.encodedLen());
        errdefer allocator.free(out);
        _ = try self.encode(out);
        return out;
    }
};

pub const OwnedMetadata = struct {
    allocator: std.mem.Allocator,
    proof: []Hash,
    value: Metadata,

    pub fn deinit(self: *OwnedMetadata) void {
        self.allocator.free(self.proof);
        self.* = undefined;
    }
};

/// Canonical standard ABI encoding. Proof and scalar values are copied; data
/// borrows the input. Non-canonical offsets and nonzero padding are rejected.
pub fn decode(allocator: std.mem.Allocator, bytes: []const u8) !OwnedMetadata {
    if (bytes.len < head_len or bytes.len % 32 != 0) return error.InvalidArbMetadata;
    if (try evm.codecs.uintWord(usize, bytes[0..32]) != head_len) return error.InvalidArbMetadata;
    const proof_count = try evm.codecs.uintWord(usize, bytes[head_len..][0..32]);
    const proof_bytes = try std.math.mul(usize, proof_count, 32);
    const data_offset = try std.math.add(usize, head_len + 32, proof_bytes);
    if (data_offset > bytes.len or try evm.codecs.uintWord(usize, bytes[256..288]) != data_offset) return error.InvalidArbMetadata;
    if (bytes.len < data_offset + 32) return error.InvalidArbMetadata;
    const data_len = try evm.codecs.uintWord(usize, bytes[data_offset..][0..32]);
    const data_padding = (32 - data_len % 32) % 32;
    const expected_len = try std.math.add(usize, data_offset + 32, try std.math.add(usize, data_len, data_padding));
    if (bytes.len != expected_len) return error.InvalidArbMetadata;
    if (!std.mem.allEqual(u8, bytes[data_offset + 32 + data_len ..], 0)) return error.InvalidArbMetadata;
    const proof = try allocator.alloc(Hash, proof_count);
    errdefer allocator.free(proof);
    for (proof, 0..) |*hash, i| hash.* = bytes[head_len + 32 + i * 32 ..][0..32].*;
    return .{
        .allocator = allocator,
        .proof = proof,
        .value = .{
            .proof = proof,
            .position = std.mem.readInt(u256, bytes[32..64], .big),
            .caller = try evm.codecs.addressWord(bytes[64..96]),
            .destination = try evm.codecs.addressWord(bytes[96..128]),
            .arb_block_num = std.mem.readInt(u256, bytes[128..160], .big),
            .eth_block_num = std.mem.readInt(u256, bytes[160..192], .big),
            .timestamp = std.mem.readInt(u256, bytes[192..224], .big),
            .callvalue = std.mem.readInt(u256, bytes[224..256], .big),
            .data = bytes[data_offset + 32 ..][0..data_len],
        },
    };
}

pub fn containsMessageId(data: []const u8, message_id: Hash) bool {
    return std.mem.indexOf(u8, data, &message_id) != null;
}
