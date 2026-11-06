//! Append-only historical proofs. Completed subtrees never change; only the
//! incomplete right edge is reconstructed for an earlier root. Matches Rust's
//! PackedMerkle layout with 256 hashes per allocation, no per-leaf heap nodes.
const std = @import("std");
const merkle = @import("../protocol/merkle.zig");
const Hash = [32]u8;
const hashes_per_chunk = 256;
const Chunk = [hashes_per_chunk]Hash;

const Level = struct {
    chunks: std.ArrayList(*Chunk) = .empty,
    len: usize = 0,

    fn deinit(self: *Level, allocator: std.mem.Allocator) void {
        for (self.chunks.items) |chunk| allocator.destroy(chunk);
        self.chunks.deinit(allocator);
    }

    fn reserve(self: *Level, allocator: std.mem.Allocator) !void {
        if (self.len < self.chunks.items.len * hashes_per_chunk) return;
        try self.chunks.ensureUnusedCapacity(allocator, 1);
        const chunk = try allocator.create(Chunk);
        self.chunks.appendAssumeCapacity(chunk);
    }

    fn append(self: *Level, hash: Hash) void {
        self.chunks.items[self.len / hashes_per_chunk][self.len % hashes_per_chunk] = hash;
        self.len += 1;
    }

    fn get(self: Level, index: usize) Hash {
        std.debug.assert(index < self.len);
        return self.chunks.items[index / hashes_per_chunk][index % hashes_per_chunk];
    }
};

pub const Prover = struct {
    allocator: std.mem.Allocator,
    levels: [33]Level = @splat(.{}),
    count: u64 = 0,
    root_hash: Hash = merkle.zero_hashes[32],

    pub fn init(allocator: std.mem.Allocator) Prover {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Prover) void {
        for (&self.levels) |*level| level.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn ingest(self: *Prover, leaf: Hash) !void {
        if (self.count >= @as(u64, 1) << 32) return error.TreeFull;
        const next = self.count + 1;
        const populated: usize = @as(usize, @ctz(next)) + 1;
        // Reserve every required allocation before mutating logical state. An
        // allocation failure may retain spare capacity, never a partial leaf.
        for (self.levels[0..populated]) |*level| try level.reserve(self.allocator);
        var node = leaf;
        var size = next;
        for (self.levels[0..populated]) |*level| {
            level.append(node);
            if (size & 1 == 1) break;
            node = merkle.hashConcat(level.get(level.len - 2), node);
            size >>= 1;
        }
        self.count = next;
        self.root_hash = self.subtree(0, 32, next);
    }

    pub fn root(self: *const Prover) Hash {
        return self.root_hash;
    }

    fn subtree(self: *const Prover, start: u64, height: u6, count: u64) Hash {
        if (start >= count) return merkle.zero_hashes[height];
        if (start + (@as(u64, 1) << height) <= count) return self.levels[height].get(@intCast(start >> height));
        const child = height - 1;
        const half = @as(u64, 1) << child;
        return merkle.hashConcat(self.subtree(start, child, count), self.subtree(start + half, child, count));
    }

    pub fn rootAt(self: *const Prover, root_index: u32) !Hash {
        if (root_index >= self.count) return error.UnknownMerkleLeaf;
        return self.subtree(0, 32, @as(u64, root_index) + 1);
    }

    pub fn proof(self: *const Prover, leaf_index: u32, root_index: u32) !merkle.Proof {
        if (root_index >= self.count or leaf_index > root_index) return error.UnknownMerkleLeaf;
        var result: merkle.Proof = .{ .leaf = self.levels[0].get(leaf_index), .index = leaf_index, .path = undefined };
        for (&result.path, 0..) |*sibling, height_| {
            const height: u6 = @intCast(height_);
            const start = ((@as(u64, leaf_index) >> height) ^ 1) << height;
            sibling.* = self.subtree(start, height, @as(u64, root_index) + 1);
        }
        return result;
    }
};

test "packed prover authenticates historical prefixes across chunk and power-of-two boundaries" {
    const allocator = std.testing.allocator;
    var prover = Prover.init(allocator);
    defer prover.deinit();
    var incremental = merkle.IncrementalMerkle.init();
    var roots: [513]Hash = undefined;
    for (&roots, 0..) |*root, index| {
        var leaf: Hash = @splat(0);
        std.mem.writeInt(u64, leaf[24..32], @intCast(index), .big);
        try prover.ingest(leaf);
        try incremental.ingest(leaf);
        root.* = incremental.root();
        try std.testing.expectEqualSlices(u8, root, &prover.root());
    }
    for (roots, 0..) |root, index_| {
        const index: u32 = @intCast(index_);
        try std.testing.expectEqualSlices(u8, &root, &try prover.rootAt(index));
        for ([_]u32{ 0, index / 2, index }) |leaf| {
            const proof_ = try prover.proof(leaf, index);
            try std.testing.expect(proof_.verify(root));
        }
    }
    try std.testing.expectError(error.UnknownMerkleLeaf, prover.proof(1, 0));
    try std.testing.expectError(error.UnknownMerkleLeaf, prover.proof(0, 513));
}

fn allocationExercise(allocator: std.mem.Allocator) !void {
    var prover = Prover.init(allocator);
    defer prover.deinit();
    for (0..257) |i| {
        var leaf: Hash = @splat(1);
        std.mem.writeInt(u64, leaf[24..32], @intCast(i), .big);
        const previous_count = prover.count;
        const previous_root = prover.root();
        prover.ingest(leaf) catch |err| {
            try std.testing.expectEqual(previous_count, prover.count);
            try std.testing.expectEqualSlices(u8, &previous_root, &prover.root());
            return err;
        };
    }
}

test "packed prover allocation failures retain logical tree and release every chunk" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationExercise, .{});
}
