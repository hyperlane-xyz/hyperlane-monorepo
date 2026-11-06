//! Bounded canonical-history model shared by live and simulation drivers.
//! Persist whole accepted transitions atomically with indexed event rows.
const std = @import("std");
pub const Hash = [32]u8;
pub const Block = struct {
    height: u64,
    hash: Hash,
    parent: Hash,
    /// Digest of the ordered, normalized event batch, including an empty batch.
    events_digest: Hash,
};

pub fn CanonicalChain(comptime capacity: usize) type {
    return struct {
        const Self = @This();
        anchor_height: u64,
        anchor_hash: Hash,
        blocks: [capacity]Block = undefined,
        len: usize = 0,
        confirmed_height: u64,
        halted: bool = false,
        pub const Outcome = struct { removed: usize, added: usize };

        /// A fresh domain uses a verified start parent; an existing domain uses
        /// an authenticated confirmed checkpoint from its store.
        pub fn init(anchor_height: u64, anchor_hash: Hash) Self {
            return .{ .anchor_height = anchor_height, .anchor_hash = anchor_hash, .confirmed_height = anchor_height };
        }

        /// Validate the entire batch before mutation. A bad trailing header may
        /// not erase a valid provisional suffix or partially advance the cursor.
        pub fn ingest(self: *Self, batch: []const Block) !Outcome {
            if (self.halted) return error.ChainHalted;
            if (batch.len == 0) return .{ .removed = 0, .added = 0 };
            if (batch[0].height <= self.anchor_height) return error.BeforeAnchor;
            const first_offset = batch[0].height - self.anchor_height - 1;
            if (first_offset > self.len) return error.MissingBlock;
            const first: usize = @intCast(first_offset);
            if (batch.len > capacity - first) return error.ChainCapacityReached;
            var parent = if (first == 0) self.anchor_hash else self.blocks[first - 1].hash;
            var height = batch[0].height;
            for (batch) |block| {
                if (block.height != height) return error.NoncontiguousBatch;
                if (!std.mem.eql(u8, &block.parent, &parent)) return error.ParentMismatch;
                parent = block.hash;
                height = std.math.add(u64, height, 1) catch return error.HeightOverflow;
            }
            var different: ?usize = null;
            for (batch, first..) |block, index| {
                if (index < self.len and std.meta.eql(self.blocks[index], block)) continue;
                if (block.height <= self.confirmed_height) {
                    self.halted = true;
                    return error.ConfirmedHistoryConflict;
                }
                if (different == null) different = index;
            }
            const start = different orelse return .{ .removed = 0, .added = 0 };
            const removed = self.len -| start;
            const source_offset = start - first;
            @memcpy(self.blocks[start .. first + batch.len], batch[source_offset..]);
            self.len = first + batch.len;
            return .{ .removed = removed, .added = batch.len - source_offset };
        }

        /// `height/hash` is the adapter's verified finality frontier, bounded by
        /// locally complete sequential batches. Stale responses cannot rewind it.
        pub fn confirm(self: *Self, height: u64, hash: Hash) !void {
            if (self.halted) return error.ChainHalted;
            if (height < self.confirmed_height) return error.StaleFinality;
            if (height < self.anchor_height) return error.BeforeAnchor;
            const local_hash = if (height == self.anchor_height) self.anchor_hash else blk: {
                const offset = height - self.anchor_height - 1;
                if (offset >= self.len) return error.UnindexedFinality;
                break :blk self.blocks[@intCast(offset)].hash;
            };
            if (!std.mem.eql(u8, &local_hash, &hash)) return error.FinalityHashMismatch;
            self.confirmed_height = height;
        }

        /// Reclaim only a confirmed prefix. The store retains its event rows and
        /// checkpoint; memory remains bounded for arbitrarily long histories.
        pub fn compact(self: *Self) void {
            const remove: usize = @intCast(self.confirmed_height - self.anchor_height);
            if (remove == 0) return;
            self.anchor_hash = self.blocks[remove - 1].hash;
            self.anchor_height = self.confirmed_height;
            std.mem.copyForwards(Block, self.blocks[0 .. self.len - remove], self.blocks[remove..self.len]);
            self.len -= remove;
        }
    };
}

fn testBlock(height: u64, hash: u8, parent: u8) Block {
    return .{ .height = height, .hash = @splat(hash), .parent = @splat(parent), .events_digest = @splat(hash) };
}

test "reorg replaces only provisional suffix; confirmed conflict halts" {
    var chain = CanonicalChain(8).init(9, @splat(9));
    _ = try chain.ingest(&.{ testBlock(10, 10, 9), testBlock(11, 11, 10), testBlock(12, 12, 11) });
    try chain.confirm(10, @splat(10));
    const result = try chain.ingest(&.{ testBlock(11, 21, 10), testBlock(12, 22, 21) });
    try std.testing.expectEqual(@as(usize, 2), result.removed);
    try std.testing.expectEqual(@as(usize, 2), result.added);
    try std.testing.expectError(error.ConfirmedHistoryConflict, chain.ingest(&.{testBlock(10, 30, 9)}));
    try std.testing.expectError(error.ChainHalted, chain.confirm(12, @splat(22)));
}

test "malformed batch is atomic, replay idempotent and confirmation cannot jump gaps" {
    var chain = CanonicalChain(8).init(9, @splat(9));
    const batch = [_]Block{ testBlock(10, 10, 9), testBlock(11, 11, 10) };
    _ = try chain.ingest(&batch);
    const before = chain;
    try std.testing.expectError(error.ParentMismatch, chain.ingest(&.{ testBlock(11, 21, 10), testBlock(12, 22, 99) }));
    try std.testing.expectEqualDeep(before.blocks[0..before.len], chain.blocks[0..chain.len]);
    try std.testing.expectEqual(@as(usize, 0), (try chain.ingest(&batch)).added);
    try std.testing.expectError(error.UnindexedFinality, chain.confirm(12, @splat(12)));
    try chain.confirm(10, @splat(10));
    chain.compact();
    try std.testing.expectEqual(@as(u64, 10), chain.anchor_height);
    try std.testing.expectEqual(@as(usize, 1), chain.len);
    try std.testing.expectEqual(@as(u64, 11), chain.blocks[0].height);
}
