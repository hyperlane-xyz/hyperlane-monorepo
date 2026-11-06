//! Checkpoint authorization over locally reconstructed, finalized insertions.
//! The durable driver must persist observations, signing reservations, signatures,
//! and fatal reorgs before exposing their corresponding effects.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
pub const Hash = [32]u8;
pub const Checkpoint = protocol.Checkpoint;
pub const Consensus = enum {
    quorum,
    majority,
    pub fn required(self: Consensus, count: usize) !usize {
        if (count == 0) return error.EmptyEndpointPool;
        return switch (self) {
            .quorum => count / 2 + count % 2,
            .majority => count - count / 3,
        };
    }
};

pub fn Validator(comptime history_capacity: usize) type {
    return struct {
        const Self = @This();
        pub const Observation = struct { message_id: Hash, block_height: u64, block_hash: Hash };
        pub const Record = struct { observation: Observation, root: Hash };
        domain: u32,
        hook: Hash,
        endpoints: usize,
        signer: [20]u8,
        consensus: Consensus = .majority,
        tree: protocol.IncrementalMerkle = protocol.IncrementalMerkle.init(),
        history: [history_capacity]Record = undefined,
        signed_indices: [history_capacity]bool = @splat(false),
        len: usize = 0,
        verified_through: ?u32 = null,
        reserved: ?Checkpoint = null,
        signed: ?Checkpoint = null,
        halted: bool = false,

        pub fn init(domain: u32, hook: Hash, endpoints: usize, signer: [20]u8) !Self {
            _ = try Consensus.majority.required(endpoints);
            if (endpoints > 128) return error.TooManyEndpoints;
            return .{ .domain = domain, .hook = hook, .endpoints = endpoints, .signer = signer };
        }

        /// Observations must be finalized by the chain adapter. The height check
        /// prevents accidentally feeding the near-head cursor into signing.
        pub fn observe(self: *Self, index: u32, observation: Observation, finalized_height: u64) !void {
            if (self.halted) return error.ValidatorHalted;
            if (observation.block_height > finalized_height) return error.UnfinalizedObservation;
            if (index < self.len) {
                const previous = self.history[index];
                if (!std.meta.eql(previous.observation, observation)) {
                    self.halted = true;
                    return error.FinalizedHistoryConflict;
                }
                return;
            }
            if (index != self.len) return error.MissingInsertion;
            if (self.len == history_capacity) return error.HistoryCapacityReached;
            if (self.len > 0 and observation.block_height < self.history[self.len - 1].observation.block_height) return error.NonmonotonicHistory;
            if (self.len > 0) {
                const previous = self.history[self.len - 1].observation;
                if (observation.block_height == previous.block_height and !std.mem.eql(u8, &observation.block_hash, &previous.block_hash)) {
                    self.halted = true;
                    return error.FinalizedHistoryConflict;
                }
            }
            try self.tree.ingest(observation.message_id);
            self.history[self.len] = .{ .observation = observation, .root = self.tree.root() };
            self.len += 1;
        }

        pub fn checkpoint(self: *const Self, index: u32) !Checkpoint {
            if (index >= self.len) return error.UnknownCheckpoint;
            return .{
                .mailbox_domain = self.domain,
                .merkle_tree_hook_address = self.hook,
                .index = index,
                .root = self.history[index].root,
                .message_id = self.history[index].observation.message_id,
            };
        }

        fn matchesLocal(self: *const Self, candidate: Checkpoint) bool {
            const local = self.checkpoint(candidate.index) catch return false;
            // RPC checkpoints do not include message IDs. The authenticated
            // local tree supplies the message ID for the eventual signature.
            return local.mailbox_domain == candidate.mailbox_domain and
                std.mem.eql(u8, &local.merkle_tree_hook_address, &candidate.merkle_tree_hook_address) and
                std.mem.eql(u8, &local.root, &candidate.root);
        }

        /// One vote per configured slot, including unavailable endpoints. Each
        /// matching later root authenticates the earlier prefix. Match Rust's
        /// required-th highest locally authenticated index, not identical votes.
        pub fn select(self: *Self, votes: []const ?Checkpoint) !?Checkpoint {
            if (self.halted) return error.ValidatorHalted;
            if (votes.len != self.endpoints) return error.EndpointPoolChanged;
            const threshold = try self.consensus.required(self.endpoints);
            // Agreement on a conflicting committed checkpoint is a fatal reorg,
            // not an ordinary stale/unavailable response. Driver persists halt.
            if (self.verified_through) |committed| {
                const local = try self.checkpoint(committed);
                for (votes) |vote| {
                    const candidate = vote orelse continue;
                    if (candidate.index != committed or candidate.mailbox_domain != self.domain or
                        !std.mem.eql(u8, &candidate.merkle_tree_hook_address, &self.hook) or
                        std.mem.eql(u8, &candidate.root, &local.root)) continue;
                    var conflicts: usize = 0;
                    for (votes) |other| {
                        if (other) |value| {
                            if (value.index == candidate.index and value.mailbox_domain == candidate.mailbox_domain and
                                std.mem.eql(u8, &value.merkle_tree_hook_address, &candidate.merkle_tree_hook_address) and
                                std.mem.eql(u8, &value.root, &candidate.root)) conflicts += 1;
                        }
                    }
                    if (conflicts >= threshold) {
                        self.halted = true;
                        return error.FinalizedHistoryConflict;
                    }
                }
            }
            var matching: [128]u32 = undefined;
            var count: usize = 0;
            for (votes) |vote| {
                const candidate = vote orelse continue;
                if (self.verified_through) |committed| if (candidate.index < committed) continue;
                if (!self.matchesLocal(candidate)) continue;
                matching[count] = candidate.index;
                count += 1;
            }
            if (count >= threshold) {
                std.mem.sort(u32, matching[0..count], {}, std.sort.desc(u32));
                const target = matching[threshold - 1];
                if (self.verified_through == null or target > self.verified_through.?) self.verified_through = target;
            }
            return self.reserveNext();
        }

        /// Latest-first publication with every intermediate checkpoint retained.
        /// Failed signing leaves its reservation available for retry after replay.
        pub fn reserveNext(self: *Self) !?Checkpoint {
            if (self.halted) return error.ValidatorHalted;
            if (self.reserved) |reserved| return reserved;
            const target = self.verified_through orelse return null;
            var index: usize = @as(usize, target) + 1;
            while (index > 0) {
                index -= 1;
                if (self.signed_indices[index]) continue;
                const candidate = try self.checkpoint(@intCast(index));
                self.reserved = candidate;
                return candidate;
            }
            return null;
        }

        /// Called only after a signature has been verified against the configured
        /// signer and durably stored. Publication is an effect of this commit.
        pub fn commitSigned(self: *Self, candidate: Checkpoint, signature: [65]u8) !void {
            if (self.halted) return error.ValidatorHalted;
            const reserved = self.reserved orelse return error.NoSigningReservation;
            if (!std.meta.eql(reserved, candidate)) return error.CheckpointChanged;
            const signer = try protocol.signature.recover(candidate.digest(), signature);
            if (!std.mem.eql(u8, &self.signer, &signer)) return error.WrongSigner;
            const local = try self.checkpoint(candidate.index);
            if (!std.meta.eql(local, candidate)) {
                self.halted = true;
                return error.FinalizedHistoryConflict;
            }
            self.signed_indices[candidate.index] = true;
            if (self.signed == null or candidate.index > self.signed.?.index) self.signed = candidate;
            self.reserved = null;
        }
    };
}

test "consensus preserves failed endpoint denominator and authenticates local root" {
    const key: Hash = @splat(0x11);
    var v = try Validator(16).init(1, @splat(2), 4, try protocol.signature.secretKeyAddress(key));
    try v.observe(0, .{ .message_id = @splat(3), .block_height = 10, .block_hash = @splat(4) }, 10);
    const local = try v.checkpoint(0);
    try std.testing.expectEqual(@as(?Checkpoint, null), try v.select(&.{ local, local, null, null }));
    var bad = local;
    bad.root = @splat(9);
    try std.testing.expectEqual(@as(?Checkpoint, null), try v.select(&.{ bad, bad, bad, bad }));
    try std.testing.expectEqual(local, (try v.select(&.{ local, local, local, null })).?);
    try std.testing.expectError(error.WrongSigner, v.commitSigned(local, try protocol.signature.signDigest(@splat(0x22), local.digest(), null)));
    try v.commitSigned(local, try protocol.signature.signDigest(key, local.digest(), null));
    try std.testing.expectEqual(@as(?Checkpoint, null), try v.select(&.{ local, local, local, local }));
}

test "gaps and unfinalized insertions do not advance the local tree" {
    var v = try Validator(16).init(1, @splat(2), 2, @splat(0));
    const observation: Validator(16).Observation = .{ .message_id = @splat(3), .block_height = 10, .block_hash = @splat(4) };
    try std.testing.expectError(error.UnfinalizedObservation, v.observe(0, observation, 9));
    try std.testing.expectError(error.MissingInsertion, v.observe(1, observation, 10));
    try std.testing.expectEqual(@as(usize, 0), v.len);
    try v.observe(0, observation, 10);
    try v.observe(0, observation, 10);
    try std.testing.expectEqual(@as(usize, 1), v.len);
}

test "conflicting finalized observations halt even after a signed checkpoint" {
    const key: Hash = @splat(0x11);
    var v = try Validator(16).init(1, @splat(2), 1, try protocol.signature.secretKeyAddress(key));
    try v.observe(0, .{ .message_id = @splat(3), .block_height = 10, .block_hash = @splat(4) }, 10);
    const local = try v.checkpoint(0);
    _ = try v.select(&.{local});
    try v.commitSigned(local, try protocol.signature.signDigest(key, local.digest(), null));
    try std.testing.expectError(error.FinalizedHistoryConflict, v.observe(0, .{ .message_id = @splat(5), .block_height = 10, .block_hash = @splat(6) }, 10));
    try std.testing.expectError(error.ValidatorHalted, v.select(&.{local}));
}

test "thresholds match Rust ceil-half and ceil-two-thirds" {
    for ([_]usize{ 1, 2, 3, 4, 5, 6, 7 }, [_]usize{ 1, 2, 2, 3, 4, 4, 5 }, [_]usize{ 1, 1, 2, 2, 3, 3, 4 }) |n, majority, quorum| {
        try std.testing.expectEqual(majority, try Consensus.majority.required(n));
        try std.testing.expectEqual(quorum, try Consensus.quorum.required(n));
    }
}

test "mixed endpoint heights authenticate required-th index and every intermediate signature" {
    const key: Hash = @splat(0x11);
    var v = try Validator(16).init(1, @splat(2), 3, try protocol.signature.secretKeyAddress(key));
    for (0..5) |index| {
        var id: Hash = @splat(0);
        id[0] = @intCast(index);
        try v.observe(@intCast(index), .{ .message_id = id, .block_height = 10 + index, .block_hash = id }, 20);
    }
    const first = (try v.select(&.{ try v.checkpoint(4), try v.checkpoint(3), try v.checkpoint(2) })).?;
    try std.testing.expectEqual(@as(u32, 3), first.index);
    try v.commitSigned(first, try protocol.signature.signDigest(key, first.digest(), null));
    var signed_count: usize = 1;
    while (try v.reserveNext()) |next| {
        try std.testing.expectEqual(@as(u32, @intCast(3 - signed_count)), next.index);
        try v.commitSigned(next, try protocol.signature.signDigest(key, next.digest(), null));
        signed_count += 1;
    }
    try std.testing.expectEqual(@as(usize, 4), signed_count);
    try std.testing.expectEqual(@as(u32, 3), v.signed.?.index);
    var conflicting = try v.checkpoint(3);
    conflicting.root = @splat(0xff);
    try std.testing.expectError(error.FinalizedHistoryConflict, v.select(&.{ conflicting, conflicting, null }));
    try std.testing.expectError(error.ValidatorHalted, v.reserveNext());
}
