//! Arrival-ordered multisig collection, including Rust's same-root poisoning
//! behavior and Aleo's full-validator positional signature padding.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const objects = @import("../storage/objects.zig");
pub const Address = [20]u8;
pub const Arrival = struct { validator_index: usize, signed: objects.SignedCheckpoint };
pub const Destination = enum { standard, aleo };
pub const Quorum = struct {
    checkpoint: protocol.Checkpoint,
    signatures: []objects.Signature,
    allocator: std.mem.Allocator,
    pub fn deinit(self: *Quorum) void {
        self.allocator.free(self.signatures);
        self.* = undefined;
    }
};

/// Results must arrive in the same order as the asynchronous source completes.
/// Missing/failed fetches are absent arrivals. First root reaching threshold
/// wins; signatures in its result follow configured validator positions.
pub fn collect(allocator: std.mem.Allocator, arrivals: []const Arrival, validators: []const Address, threshold: usize, index: u32, destination: Destination) !?Quorum {
    var collector = try Collector.init(allocator, validators, threshold, index, destination);
    for (arrivals) |arrival| {
        if (try collector.push(arrival)) |result| return result;
    }
    return null;
}

pub const Collector = struct {
    allocator: std.mem.Allocator,
    validators: []const Address,
    threshold: usize,
    index: u32,
    destination: Destination,
    accepted: [256]Arrival = undefined,
    accepted_len: usize = 0,
    seen: [256]bool = @splat(false),
    complete: bool = false,

    pub fn init(allocator: std.mem.Allocator, validators: []const Address, threshold: usize, index: u32, destination: Destination) !Collector {
        if (threshold == 0 or threshold > validators.len or validators.len > 256) return error.InvalidThreshold;
        for (validators, 0..) |validator, i| {
            for (validators[0..i]) |previous| if (std.mem.eql(u8, &validator, &previous)) return error.DuplicateValidator;
        }
        return .{ .allocator = allocator, .validators = validators, .threshold = threshold, .index = index, .destination = destination };
    }

    /// Streaming completion order. Recover each validator signature once and
    /// stop storage/network work immediately when the first root wins quorum.
    pub fn push(self: *Collector, arrival: Arrival) !?Quorum {
        if (self.complete) return error.QuorumAlreadyComplete;
        if (arrival.validator_index >= self.validators.len) return error.ValidatorOutOfBounds;
        if (self.seen[arrival.validator_index]) return error.DuplicateResponse;
        self.seen[arrival.validator_index] = true;
        if (arrival.signed.value.index != self.index) return null;
        const signer = arrival.signed.recover() catch return null;
        if (!std.mem.eql(u8, &signer, &self.validators[arrival.validator_index])) return null;
        self.accepted[self.accepted_len] = arrival;
        self.accepted_len += 1;
        var matches: [256]Arrival = undefined;
        var count: usize = 0;
        for (self.accepted[0..self.accepted_len]) |other| {
            if (std.mem.eql(u8, &other.signed.value.root, &arrival.signed.value.root)) {
                matches[count] = other;
                count += 1;
            }
        }
        if (count < self.threshold) return null;
        std.mem.sort(Arrival, matches[0..count], {}, struct {
            fn less(_: void, left: Arrival, right: Arrival) bool {
                return left.validator_index < right.validator_index;
            }
        }.less);
        const checkpoint = matches[0].signed.value;
        for (matches[1..count]) |other| {
            // Rust groups by root, then TryFrom requires the complete value to
            // match. Do not silently discard the poisoned group and try another.
            if (!std.meta.eql(checkpoint, other.signed.value)) return error.InconsistentCheckpoints;
        }
        const signatures = try self.allocator.alloc(objects.Signature, if (self.destination == .aleo) self.validators.len else count);
        if (self.destination == .aleo) {
            @memset(signatures, .{ .r = 1, .s = 1, .v = 1 });
            for (matches[0..count]) |entry| signatures[entry.validator_index] = entry.signed.signature;
        } else {
            for (matches[0..count], signatures) |entry, *signature| signature.* = entry.signed.signature;
        }
        self.complete = true;
        return .{ .checkpoint = checkpoint, .signatures = signatures, .allocator = self.allocator };
    }
};

/// Range search starts at the threshold-th highest reported latest index,
/// capped by the locally provable tree frontier. No missing index is fabricated.
pub fn rangeStart(latest: []const ?u32, threshold: usize, minimum: u32, maximum: u32) !?u32 {
    if (threshold == 0 or threshold > latest.len or latest.len > 256) return error.InvalidThreshold;
    var indices: [256]u32 = undefined;
    var count: usize = 0;
    for (latest) |maybe| if (maybe) |index| {
        indices[count] = index;
        count += 1;
    };
    if (count < threshold) return null;
    std.mem.sort(u32, indices[0..count], {}, std.sort.desc(u32));
    const start = @min(maximum, indices[threshold - 1]);
    return if (start < minimum) null else start;
}

test "arrival order selects root while output signatures follow validator order; Aleo pads" {
    const keys = [_][32]u8{ @splat(0x11), @splat(0x22), @splat(0x33) };
    var validators: [3]Address = undefined;
    for (keys, &validators) |key, *validator| validator.* = try protocol.signature.secretKeyAddress(key);
    const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = @splat(1), .mailbox_domain = 1, .root = @splat(2), .index = 3, .message_id = @splat(4) };
    const arrivals = [_]Arrival{
        .{ .validator_index = 2, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[2], null) },
        .{ .validator_index = 0, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null) },
    };
    var standard = (try collect(std.testing.allocator, &arrivals, &validators, 2, 3, .standard)).?;
    defer standard.deinit();
    try std.testing.expectEqualSlices(u8, &validators[0], &try standard.signatures[0].recover(checkpoint.digest()));
    try std.testing.expectEqualSlices(u8, &validators[2], &try standard.signatures[1].recover(checkpoint.digest()));
    var aleo = (try collect(std.testing.allocator, &arrivals, &validators, 2, 3, .aleo)).?;
    defer aleo.deinit();
    try std.testing.expectEqual(objects.Signature{ .r = 1, .s = 1, .v = 1 }, aleo.signatures[1]);
    var poisoned = checkpoint;
    poisoned.message_id = @splat(5);
    var conflicting = arrivals;
    conflicting[1].signed = try objects.SignedCheckpoint.sign(poisoned, keys[0], null);
    try std.testing.expectError(error.InconsistentCheckpoints, collect(std.testing.allocator, &conflicting, &validators, 2, 3, .standard));
}

test "range boundary includes missing latest slots without claiming a quorum" {
    try std.testing.expectEqual(@as(?u32, 1004), try rangeStart(&.{ 1010, 1008, 1006, 1004, 1002 }, 4, 100, 1010));
    try std.testing.expectEqual(@as(?u32, 1000), try rangeStart(&.{ 1010, 1008, 1006, null, null }, 3, 100, 1000));
    try std.testing.expectEqual(@as(?u32, null), try rangeStart(&.{ 1010, null, null }, 2, 100, 1000));
}
