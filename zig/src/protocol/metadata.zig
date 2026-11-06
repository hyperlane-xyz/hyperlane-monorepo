const std = @import("std");
const merkle = @import("merkle.zig");
const Checkpoint = @import("checkpoint.zig").Checkpoint;
const Message = @import("message.zig").Message;
const signature = @import("signature.zig");
const Hash = [32]u8;
pub const signature_len = 65;

/// Structural parsers do not authenticate signatures. The ISM's validator set,
/// ordering and threshold must be checked by the metadata consumer.
pub const MessageIdMultisig = struct {
    hook: Hash,
    root: Hash,
    index: u32,
    signatures: []const u8,
    pub const prefix_len = 68;

    pub fn decode(bytes: []const u8) !MessageIdMultisig {
        if (bytes.len < prefix_len) return error.TruncatedMetadata;
        if ((bytes.len - prefix_len) % signature_len != 0) return error.InvalidSignaturesLength;
        return .{ .hook = bytes[0..32].*, .root = bytes[32..64].*, .index = std.mem.readInt(u32, bytes[64..68], .big), .signatures = bytes[prefix_len..] };
    }

    pub fn signatureCount(self: MessageIdMultisig) usize {
        return self.signatures.len / signature_len;
    }

    pub fn signatureAt(self: MessageIdMultisig, index: usize) ![65]u8 {
        if (index >= self.signatureCount()) return error.SignatureOutOfBounds;
        return self.signatures[index * signature_len ..][0..signature_len].*;
    }

    pub fn checkpoint(self: MessageIdMultisig, domain: u32, message_id: Hash) Checkpoint {
        return .{ .merkle_tree_hook_address = self.hook, .mailbox_domain = domain, .root = self.root, .index = self.index, .message_id = message_id };
    }

    pub fn verify(self: MessageIdMultisig, message: Message, validators: []const signature.Address, threshold: usize) !void {
        try signature.verifyQuorum(self.checkpoint(message.origin, message.id()).digest(), self.signatures, validators, threshold);
    }

    pub fn encode(self: MessageIdMultisig, out: []u8) ![]u8 {
        if (self.signatures.len % signature_len != 0) return error.InvalidSignaturesLength;
        if (out.len < prefix_len or out.len - prefix_len < self.signatures.len) return error.BufferTooSmall;
        out[0..32].* = self.hook;
        out[32..64].* = self.root;
        std.mem.writeInt(u32, out[64..68], self.index, .big);
        @memcpy(out[prefix_len..][0..self.signatures.len], self.signatures);
        return out[0 .. prefix_len + self.signatures.len];
    }
};

pub const MerkleRootMultisig = struct {
    hook: Hash,
    message_index: u32,
    signed_message_id: Hash,
    proof: [32]Hash,
    signed_index: u32,
    signatures: []const u8,
    pub const prefix_len = 1096;

    pub fn decode(bytes: []const u8) !MerkleRootMultisig {
        if (bytes.len < prefix_len) return error.TruncatedMetadata;
        if ((bytes.len - prefix_len) % signature_len != 0) return error.InvalidSignaturesLength;
        var decoded: MerkleRootMultisig = .{
            .hook = bytes[0..32].*,
            .message_index = std.mem.readInt(u32, bytes[32..36], .big),
            .signed_message_id = bytes[36..68].*,
            .proof = undefined,
            .signed_index = std.mem.readInt(u32, bytes[1092..1096], .big),
            .signatures = bytes[prefix_len..],
        };
        for (&decoded.proof, 0..) |*hash, i| hash.* = bytes[68 + i * 32 ..][0..32].*;
        return decoded;
    }

    pub fn checkpoint(self: *const MerkleRootMultisig, domain: u32, message_id: Hash) !Checkpoint {
        if (self.message_index > self.signed_index) return error.MessageAfterCheckpoint;
        const proof: merkle.Proof = .{ .leaf = message_id, .index = self.message_index, .path = self.proof };
        return .{ .merkle_tree_hook_address = self.hook, .mailbox_domain = domain, .root = proof.root(), .index = self.signed_index, .message_id = self.signed_message_id };
    }

    pub fn signatureCount(self: MerkleRootMultisig) usize {
        return self.signatures.len / signature_len;
    }

    pub fn verify(self: *const MerkleRootMultisig, message: Message, validators: []const signature.Address, threshold: usize) !void {
        const signed = try self.checkpoint(message.origin, message.id());
        try signature.verifyQuorum(signed.digest(), self.signatures, validators, threshold);
    }

    pub fn signatureAt(self: MerkleRootMultisig, index: usize) ![65]u8 {
        if (index >= self.signatureCount()) return error.SignatureOutOfBounds;
        return self.signatures[index * signature_len ..][0..signature_len].*;
    }

    pub fn encode(self: *const MerkleRootMultisig, out: []u8) ![]u8 {
        if (self.signatures.len % signature_len != 0) return error.InvalidSignaturesLength;
        if (out.len < prefix_len or out.len - prefix_len < self.signatures.len) return error.BufferTooSmall;
        out[0..32].* = self.hook;
        std.mem.writeInt(u32, out[32..36], self.message_index, .big);
        out[36..68].* = self.signed_message_id;
        for (self.proof, 0..) |hash, i| out[68 + i * 32 ..][0..32].* = hash;
        std.mem.writeInt(u32, out[1092..1096], self.signed_index, .big);
        @memcpy(out[prefix_len..][0..self.signatures.len], self.signatures);
        return out[0 .. prefix_len + self.signatures.len];
    }
};

/// Aggregation ISM range-table codec. A null submodule has no metadata;
/// an empty but present slice is significant for a null ISM.
pub fn encodeAggregation(parts: []const ?[]const u8, out: []u8) ![]u8 {
    const header_len = try std.math.mul(usize, parts.len, 8);
    var length = header_len;
    for (parts) |part| if (part) |bytes| {
        length = try std.math.add(usize, length, bytes.len);
    };
    if (length > std.math.maxInt(u32)) return error.MetadataTooLarge;
    if (out.len < length) return error.BufferTooSmall;
    @memset(out[0..header_len], 0);
    var offset = header_len;
    for (parts, 0..) |part, i| {
        if (part) |bytes| {
            std.mem.writeInt(u32, out[i * 8 ..][0..4], @intCast(offset), .big);
            @memcpy(out[offset..][0..bytes.len], bytes);
            offset += bytes.len;
            std.mem.writeInt(u32, out[i * 8 + 4 ..][0..4], @intCast(offset), .big);
        }
    }
    return out[0..length];
}

pub const Aggregation = struct {
    bytes: []const u8,
    module_count: usize,

    pub fn decode(bytes: []const u8, module_count: usize) !Aggregation {
        const header_len = try std.math.mul(usize, module_count, 8);
        if (bytes.len < header_len) return error.TruncatedMetadata;
        const metadata: Aggregation = .{ .bytes = bytes, .module_count = module_count };
        for (0..module_count) |i| _ = try metadata.metadataAt(i);
        return metadata;
    }

    pub fn metadataAt(self: Aggregation, index: usize) !?[]const u8 {
        if (index >= self.module_count) return error.ModuleOutOfBounds;
        const start = std.mem.readInt(u32, self.bytes[index * 8 ..][0..4], .big);
        const end = std.mem.readInt(u32, self.bytes[index * 8 + 4 ..][0..4], .big);
        if (start == 0) {
            if (end != 0) return error.InvalidMetadataRange;
            return null;
        }
        if (start < self.module_count * 8 or end < start or end > self.bytes.len)
            return error.InvalidMetadataRange;
        return self.bytes[start..end];
    }
};

test "multisig metadata roundtrips and rejects truncation" {
    const signatures = [_]u8{0x11} ** 130;
    const metadata: MessageIdMultisig = .{ .hook = .{0x22} ** 32, .root = .{0x33} ** 32, .index = 19, .signatures = &signatures };
    var bytes: [MessageIdMultisig.prefix_len + signatures.len]u8 = undefined;
    _ = try metadata.encode(&bytes);
    const decoded = try MessageIdMultisig.decode(&bytes);
    try std.testing.expectEqualDeep(metadata, decoded);
    try std.testing.expectEqual(@as(usize, 2), decoded.signatureCount());
    try std.testing.expectEqualSlices(u8, signatures[0..65], &try decoded.signatureAt(0));
    try std.testing.expectError(error.SignatureOutOfBounds, decoded.signatureAt(std.math.maxInt(usize)));
    for (0..MessageIdMultisig.prefix_len) |len| try std.testing.expectError(error.TruncatedMetadata, MessageIdMultisig.decode(bytes[0..len]));
    try std.testing.expectError(error.InvalidSignaturesLength, MessageIdMultisig.decode(bytes[0 .. bytes.len - 1]));
}

test "merkle root multisig layout roundtrip and index validation" {
    const metadata: MerkleRootMultisig = .{ .hook = .{0x11} ** 32, .message_index = 4, .signed_message_id = .{0x22} ** 32, .proof = merkle.zero_hashes[0..32].*, .signed_index = 6, .signatures = &.{} };
    var bytes: [MerkleRootMultisig.prefix_len]u8 = undefined;
    _ = try metadata.encode(&bytes);
    const decoded = try MerkleRootMultisig.decode(&bytes);
    try std.testing.expectEqualDeep(metadata, decoded);
    const checkpoint = try decoded.checkpoint(9, .{0x33} ** 32);
    try std.testing.expectEqual(@as(u32, 9), checkpoint.mailbox_domain);
    try std.testing.expectEqual(@as(u32, 6), checkpoint.index);
    var invalid = decoded;
    invalid.message_index = 7;
    try std.testing.expectError(error.MessageAfterCheckpoint, invalid.checkpoint(9, .{0x33} ** 32));
    for (0..MerkleRootMultisig.prefix_len) |len| try std.testing.expectError(error.TruncatedMetadata, MerkleRootMultisig.decode(bytes[0..len]));
}

test "aggregation preserves absent and empty metadata and validates ranges" {
    const parts = [_]?[]const u8{ "abc", null, "", "de" };
    var buffer: [37]u8 = undefined;
    const bytes = try encodeAggregation(&parts, &buffer);
    const decoded = try Aggregation.decode(bytes, parts.len);
    for (parts, 0..) |part, i| try std.testing.expectEqualDeep(part, try decoded.metadataAt(i));
    try std.testing.expectError(error.ModuleOutOfBounds, decoded.metadataAt(4));
    try std.testing.expectError(error.TruncatedMetadata, Aggregation.decode(bytes[0..31], parts.len));
    var invalid = buffer;
    std.mem.writeInt(u32, invalid[0..4], 3, .big);
    try std.testing.expectError(error.InvalidMetadataRange, Aggregation.decode(&invalid, parts.len));
    invalid = buffer;
    std.mem.writeInt(u32, invalid[4..8], 38, .big);
    try std.testing.expectError(error.InvalidMetadataRange, Aggregation.decode(&invalid, parts.len));
    invalid = buffer;
    std.mem.writeInt(u32, invalid[12..16], 1, .big);
    try std.testing.expectError(error.InvalidMetadataRange, Aggregation.decode(&invalid, parts.len));
    try std.testing.expectError(error.BufferTooSmall, encodeAggregation(&parts, buffer[0..36]));
}
