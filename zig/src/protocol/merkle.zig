const std = @import("std");
const Hash = [32]u8;
pub const depth = 32;

pub fn hashConcat(left: Hash, right: Hash) Hash {
    var bytes: [64]u8 = undefined;
    bytes[0..32].* = left;
    bytes[32..64].* = right;
    var digest: Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(&bytes, &digest, .{});
    return digest;
}

pub const zero_hashes: [depth + 1]Hash = blk: {
    @setEvalBranchQuota(2000000);
    var hashes: [depth + 1]Hash = undefined;
    hashes[0] = .{0} ** 32;
    for (1..depth + 1) |i| hashes[i] = hashConcat(hashes[i - 1], hashes[i - 1]);
    break :blk hashes;
};

pub const Proof = struct {
    leaf: Hash,
    index: u32,
    path: [depth]Hash,

    pub fn root(self: *const Proof) Hash {
        var node = self.leaf;
        var index = self.index;
        for (self.path) |sibling| {
            node = if (index & 1 == 0) hashConcat(node, sibling) else hashConcat(sibling, node);
            index >>= 1;
        }
        return node;
    }

    pub fn verify(self: *const Proof, expected_root: Hash) bool {
        return std.mem.eql(u8, &self.root(), &expected_root);
    }
};

/// Fixed-depth leading edge frontier. Rust and Solidity deliberately reserve
/// the final leaf: maximum count is 2^32-1, not 2^32.
pub const IncrementalMerkle = struct {
    branch: [depth]Hash = zero_hashes[0..depth].*,
    count: u32 = 0,
    pub const snapshot_len = depth * 32 + 8;

    pub fn init() IncrementalMerkle {
        return .{};
    }

    pub fn ingest(self: *IncrementalMerkle, leaf: Hash) error{TreeFull}!void {
        if (self.count == std.math.maxInt(u32)) return error.TreeFull;
        var node = leaf;
        self.count += 1;
        var size = self.count;
        for (0..depth) |i| {
            if (size & 1 == 1) {
                self.branch[i] = node;
                return;
            }
            node = hashConcat(self.branch[i], node);
            size >>= 1;
        }
        unreachable;
    }

    pub fn root(self: *const IncrementalMerkle) Hash {
        if (self.count == 0) return zero_hashes[depth];
        const skip: usize = @ctz(self.count);
        var node = zero_hashes[skip];
        var size = self.count >> @intCast(skip);
        for (skip..depth) |i| {
            node = if (size & 1 == 1) hashConcat(self.branch[i], node) else hashConcat(node, zero_hashes[i]);
            size >>= 1;
        }
        return node;
    }

    pub fn index(self: *const IncrementalMerkle) error{EmptyTree}!u32 {
        if (self.count == 0) return error.EmptyTree;
        return self.count - 1;
    }

    pub fn verify(self: *const IncrementalMerkle, proof: *const Proof) bool {
        return proof.index < self.count and proof.verify(self.root());
    }

    /// Borsh format of the Rust frontier on 64-bit targets. The count encoding
    /// is always u64 little endian, matching Borsh's platform-independent usize.
    pub fn snapshot(self: *const IncrementalMerkle) [snapshot_len]u8 {
        var bytes: [snapshot_len]u8 = undefined;
        for (self.branch, 0..) |hash, i| bytes[i * 32 ..][0..32].* = hash;
        std.mem.writeInt(u64, bytes[depth * 32 ..][0..8], self.count, .little);
        return bytes;
    }

    /// Caller must compare the root to a trusted finalized checkpoint before
    /// resuming signing. Internal root consistency alone does not prove trust.
    pub fn restore(bytes: []const u8, expected_index: u32, expected_root: Hash) !IncrementalMerkle {
        if (bytes.len != snapshot_len) return error.InvalidSnapshotLength;
        const count = std.mem.readInt(u64, bytes[depth * 32 ..][0..8], .little);
        if (count == 0 or count > std.math.maxInt(u32) or count - 1 != expected_index)
            return error.InvalidSnapshotCount;
        var tree: IncrementalMerkle = .{ .count = @intCast(count) };
        for (&tree.branch, 0..) |*hash, i| hash.* = bytes[i * 32 ..][0..32].*;
        if (!std.mem.eql(u8, &tree.root(), &expected_root)) return error.InvalidSnapshotRoot;
        return tree;
    }
};

test "incremental root matches independently constructed full tree" {
    var leaves: [256]Hash = undefined;
    for (&leaves, 0..) |*leaf, i| {
        leaf.* = .{0} ** 32;
        std.mem.writeInt(u64, leaf[24..32], @intCast(i), .big);
    }
    var tree = IncrementalMerkle.init();
    try std.testing.expectEqualSlices(u8, &zero_hashes[depth], &tree.root());
    try std.testing.expectError(error.EmptyTree, tree.index());
    for (leaves, 0..) |leaf, i| {
        try tree.ingest(leaf);
        var level = leaves;
        var width = i + 1;
        for (0..depth) |height| {
            const next_width = (width + 1) / 2;
            for (0..next_width) |j| {
                const right = if (j * 2 + 1 < width) level[j * 2 + 1] else zero_hashes[height];
                level[j] = hashConcat(level[j * 2], right);
            }
            width = next_width;
        }
        try std.testing.expectEqualSlices(u8, &level[0], &tree.root());
        try std.testing.expectEqual(@as(u32, @intCast(i)), try tree.index());
    }
}

test "three-leaf Merkle fixture" {
    var tree = IncrementalMerkle.init();
    const ethHash = @import("checkpoint.zig").ethSignedMessageHash;
    // Fixture hashes use EIP-191 on the UTF-8 word, not on a 32-byte hash.
    _ = ethHash;
    const leaf_hexes = [_][]const u8{
        "f0fe7c99ef23ace1835385e83dd61c9e" ++ "cb6192d6514fcc13356ef912788eaa8a",
        "65ad6b7c39c687dad3edc05bec09300b" ++ "742363f5c1f42db586bdce40c9fc5eef",
    };
    var leaves: [3]Hash = undefined;
    for (leaf_hexes, 0..) |hex, i| _ = try std.fmt.hexToBytes(&leaves[i], hex);
    var hasher = std.crypto.hash.sha3.Keccak256.init(.{});
    hasher.update("\x19Ethereum Signed Message:\n5three");
    hasher.final(&leaves[2]);
    for (leaves) |leaf| try tree.ingest(leaf);
    var expected: Hash = undefined;
    _ = try std.fmt.hexToBytes(&expected, "18f2f1646fee335a1eaf5191a8ce58ea" ++ "772080057d0fda687df59c45e47e6f68");
    try std.testing.expectEqualSlices(u8, &expected, &tree.root());
    var proof: Proof = .{ .leaf = leaves[0], .index = 0, .path = zero_hashes[0..depth].* };
    proof.path[0] = leaves[1];
    proof.path[1] = hashConcat(leaves[2], zero_hashes[0]);
    try std.testing.expect(tree.verify(&proof));
    proof.path[7][0] ^= 1;
    try std.testing.expect(!tree.verify(&proof));
}

test "full tree rejects without mutation" {
    var tree: IncrementalMerkle = .{ .count = std.math.maxInt(u32) };
    const before = tree;
    try std.testing.expectError(error.TreeFull, tree.ingest(.{1} ** 32));
    try std.testing.expectEqualDeep(before, tree);
}

test "snapshot restore checks count root and shape" {
    var tree = IncrementalMerkle.init();
    try tree.ingest(.{1} ** 32);
    const bytes = tree.snapshot();
    try std.testing.expectEqualDeep(tree, try IncrementalMerkle.restore(&bytes, 0, tree.root()));
    try std.testing.expectError(error.InvalidSnapshotLength, IncrementalMerkle.restore(bytes[0..100], 0, tree.root()));
    try std.testing.expectError(error.InvalidSnapshotCount, IncrementalMerkle.restore(&bytes, 1, tree.root()));
    var wrong_root = tree.root();
    wrong_root[0] ^= 1;
    try std.testing.expectError(error.InvalidSnapshotRoot, IncrementalMerkle.restore(&bytes, 0, wrong_root));
    var oversized = bytes;
    std.mem.writeInt(u64, oversized[depth * 32 ..][0..8], 0x100000001, .little);
    try std.testing.expectError(error.InvalidSnapshotCount, IncrementalMerkle.restore(&oversized, 0, tree.root()));
}
