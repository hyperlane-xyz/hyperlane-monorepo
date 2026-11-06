//! Authenticate one canonical replay against independent endpoint frontiers at
//! different counts. Matching a later Merkle root authenticates every prefix;
//! endpoint heights need not coincide and no latest value becomes historical.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const Hash = [32]u8;
pub const Anchor = struct { count: u32, root: Hash };
pub const Proof = struct {
    allocator: std.mem.Allocator,
    anchors: []const ?Anchor,
    matched: []bool,
    required: usize,
    trusted_index: ?u32,
    trusted_root: ?Hash = null,
    maximum_count: u32,
    tree: protocol.IncrementalMerkle = .{},
    pub fn init(a: std.mem.Allocator, anchors: []const ?Anchor, required: usize, trusted_index: ?u32) !Proof {
        if (anchors.len == 0 or anchors.len > 256 or required == 0 or required > anchors.len) return error.InvalidCanonicalAuditQuorum;
        const owned = try a.dupe(?Anchor, anchors);
        errdefer a.free(owned);
        const matched = try a.alloc(bool, anchors.len);
        @memset(matched, false);
        var count: u32 = 0;
        for (anchors) |value| if (value) |anchor| {
            count = @max(count, anchor.count);
        };
        return .{ .allocator = a, .anchors = owned, .matched = matched, .required = required, .trusted_index = trusted_index, .maximum_count = count };
    }
    pub fn deinit(self: *Proof) void {
        self.allocator.free(self.anchors);
        self.allocator.free(self.matched);
        self.* = undefined;
    }
    /// Caller independently validates sequence, emitter and canonical block
    /// fences. This function authenticates their cumulative leaf commitment.
    pub fn ingest(self: *Proof, leaf: Hash) !void {
        if (self.tree.count >= self.maximum_count) return error.CanonicalAuditBeyondAnchors;
        try self.tree.ingest(leaf);
        const root = self.tree.root();
        if (self.trusted_index) |index| if (self.tree.count - 1 == index) {
            self.trusted_root = root;
        };
        for (self.anchors, self.matched) |value, *matched| if (value) |anchor| {
            if (anchor.count == self.tree.count and std.mem.eql(u8, &anchor.root, &root)) matched.* = true;
        };
    }
    pub fn authenticated(self: *const Proof) bool {
        if (self.trusted_index != null and self.trusted_root == null) return false;
        var count: usize = 0;
        for (self.anchors, self.matched) |value, matched| {
            if (!matched) continue;
            const anchor = value.?;
            if (self.trusted_index == null or anchor.count > self.trusted_index.?) count += 1;
        }
        return count >= self.required;
    }
};
test "canonical replay authenticates mixed-count quorum without fabricating historical calls" {
    var tree: protocol.IncrementalMerkle = .{};
    const a = std.testing.allocator;
    var anchors: [3]?Anchor = @splat(null);
    for (0..5) |index| {
        try tree.ingest(@splat(@intCast(index + 1)));
        if (index >= 2) anchors[index - 2] = .{ .count = tree.count, .root = tree.root() };
    }
    var proof = try Proof.init(a, &anchors, 2, 1);
    defer proof.deinit();
    for (0..4) |index| {
        try proof.ingest(@splat(@intCast(index + 1)));
        try std.testing.expectEqual(index == 3, proof.authenticated());
    }
    try std.testing.expect(proof.trusted_root != null);
}
test "minority conflicting roots and votes before trusted watermark cannot authenticate" {
    var correct: protocol.IncrementalMerkle = .{};
    try correct.ingest(@splat(1));
    var fork = correct;
    try fork.ingest(@splat(99));
    try correct.ingest(@splat(2));
    var proof = try Proof.init(std.testing.allocator, &.{ .{ .count = 2, .root = fork.root() }, .{ .count = 2, .root = correct.root() }, null }, 2, 0);
    defer proof.deinit();
    try proof.ingest(@splat(1));
    try proof.ingest(@splat(99));
    try std.testing.expect(!proof.authenticated());
    var too_old = try Proof.init(std.testing.allocator, &.{ .{ .count = 2, .root = correct.root() }, .{ .count = 2, .root = correct.root() } }, 2, 2);
    defer too_old.deinit();
    try too_old.ingest(@splat(1));
    try too_old.ingest(@splat(2));
    try std.testing.expect(!too_old.authenticated());
    try std.testing.expectError(error.CanonicalAuditBeyondAnchors, too_old.ingest(@splat(3)));
}
test "canonical audit allocation failures leave no partially initialized proof" {
    const S = struct {
        fn run(a: std.mem.Allocator) !void {
            var proof = try Proof.init(a, &.{.{ .count = 1, .root = @splat(1) }}, 1, null);
            defer proof.deinit();
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, S.run, .{});
}
