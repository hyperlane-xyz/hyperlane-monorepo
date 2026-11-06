//! LegacyMultisig codec from typescript/utils/src/multisig.ts. This is not a
//! metadata builder: current Rust and the TypeScript relayer reject this ISM.
const std = @import("std");
const evm = @import("../../evm/root.zig");

pub const Hash = [32]u8;
pub const Address = [20]u8;
pub const prefix_len = 1093;
pub const signature_len = 65;

pub const Metadata = struct {
    checkpoint_root: Hash,
    checkpoint_index: u32,
    origin_mailbox: Hash,
    proof: [32]Hash,
    signatures: []const u8,
    validators: []const Address,

    pub fn encodedLen(self: Metadata) !usize {
        if (self.signatures.len % signature_len != 0) return error.InvalidSignaturesLength;
        const signature_count = self.signatures.len / signature_len;
        if (signature_count > std.math.maxInt(u8)) return error.InvalidThreshold;
        const signed_len = try std.math.add(usize, prefix_len, self.signatures.len);
        return std.math.add(usize, signed_len, try std.math.mul(usize, self.validators.len, 32));
    }

    pub fn encode(self: Metadata, out: []u8) ![]u8 {
        const length = try self.encodedLen();
        if (out.len < length) return error.BufferTooSmall;
        out[0..32].* = self.checkpoint_root;
        std.mem.writeInt(u32, out[32..36], self.checkpoint_index, .big);
        out[36..68].* = self.origin_mailbox;
        for (self.proof, 0..) |hash, i| out[68 + i * 32 ..][0..32].* = hash;
        out[1092] = @intCast(self.signatures.len / signature_len);
        @memcpy(out[prefix_len..][0..self.signatures.len], self.signatures);
        const validator_offset = prefix_len + self.signatures.len;
        for (self.validators, 0..) |validator, i| {
            const word = out[validator_offset + i * 32 ..][0..32];
            @memset(word, 0);
            word[12..32].* = validator;
        }
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
    validators: []Address,
    value: Metadata,

    pub fn deinit(self: *OwnedMetadata) void {
        self.allocator.free(self.validators);
        self.* = undefined;
    }
};

/// Validators use 32-byte words because ethers solidityPack pads array elements.
/// Signatures and proof borrow the input; only the validator slice is allocated.
pub fn decode(allocator: std.mem.Allocator, bytes: []const u8) !OwnedMetadata {
    if (bytes.len < prefix_len) return error.TruncatedMetadata;
    const signature_count = bytes[1092];
    const signatures_len = @as(usize, signature_count) * signature_len;
    const validator_offset = try std.math.add(usize, prefix_len, signatures_len);
    if (bytes.len < validator_offset) return error.TruncatedMetadata;
    const validator_bytes = bytes.len - validator_offset;
    if (validator_bytes % 32 != 0) return error.InvalidValidatorsLength;
    const validators = try allocator.alloc(Address, validator_bytes / 32);
    errdefer allocator.free(validators);
    for (validators, 0..) |*validator, i| validator.* = try evm.codecs.addressWord(bytes[validator_offset + i * 32 ..][0..32]);
    var proof: [32]Hash = undefined;
    for (&proof, 0..) |*hash, i| hash.* = bytes[68 + i * 32 ..][0..32].*;
    return .{
        .allocator = allocator,
        .validators = validators,
        .value = .{
            .checkpoint_root = bytes[0..32].*,
            .checkpoint_index = std.mem.readInt(u32, bytes[32..36], .big),
            .origin_mailbox = bytes[36..68].*,
            .proof = proof,
            .signatures = bytes[prefix_len..validator_offset],
            .validators = validators,
        },
    };
}
