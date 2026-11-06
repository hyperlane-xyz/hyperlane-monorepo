//! Generation-tagged handoff from a stream owner to the serialized RPC indexer.
const std = @import("std");
pub const Mask = packed struct(u8) {
    dispatch: bool = false,
    insertion: bool = false,
    gas: bool = false,
    reserved: u5 = 0,
    pub fn enabled(self: Mask) [3]bool {
        return .{ !self.dispatch, !self.insertion, !self.gas };
    }
};
pub const Snapshot = struct {
    generation: u64,
    requested: Mask,
    acknowledged_generation: ?u64,
    acknowledged: Mask,
    pub fn paused(self: Snapshot, generation: u64, mask: Mask) bool {
        return self.generation == generation and self.acknowledged_generation == generation and
            std.meta.eql(self.requested, mask) and std.meta.eql(self.acknowledged, mask);
    }
};
pub const Gate = struct {
    mutex: std.Thread.Mutex = .{},
    generation: u64 = 0,
    requested: Mask = .{},
    acknowledged_generation: ?u64 = null,
    acknowledged: Mask = .{},
    wake: std.atomic.Value(bool) = .init(false),
    /// One stream actor issues commands. Stale completions cannot undo newer
    /// commands; changing the gas mask may reuse the current command generation.
    pub fn request(self: *Gate, generation: u64, mask: Mask) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (generation < self.generation) return false;
        if (generation == self.generation and std.meta.eql(mask, self.requested)) return true;
        self.generation = generation;
        self.requested = mask;
        self.acknowledged_generation = null;
        self.wake.store(true, .release);
        return true;
    }
    pub fn snapshot(self: *Gate) Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{ .generation = self.generation, .requested = self.requested, .acknowledged_generation = self.acknowledged_generation, .acknowledged = self.acknowledged };
    }
    /// Only the RPC owner acknowledges, after disabled frames and their read
    /// journals are cancelled, with no concurrent reuse of its mutable client.
    pub fn acknowledge(self: *Gate, generation: u64, mask: Mask) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (generation != self.generation or !std.meta.eql(mask, self.requested)) return false;
        self.acknowledged_generation = generation;
        self.acknowledged = mask;
        return true;
    }
};
test "authority revocation rejects late pause acknowledgements and wakes RPC fallback" {
    var gate: Gate = .{};
    const pair: Mask = .{ .dispatch = true, .insertion = true };
    try std.testing.expect(gate.request(1, pair));
    try std.testing.expect(gate.wake.swap(false, .acq_rel));
    try std.testing.expect(!gate.snapshot().paused(1, pair));
    try std.testing.expect(gate.request(2, .{}));
    try std.testing.expect(!gate.acknowledge(1, pair));
    try std.testing.expect(!gate.request(1, pair));
    try std.testing.expect(gate.acknowledge(2, .{}));
    try std.testing.expect(gate.snapshot().paused(2, .{}));
    try std.testing.expectEqualSlices(bool, &.{ true, true, true }, &gate.snapshot().requested.enabled());
}
test "gas cutover cannot reuse an acknowledgement for the sequenced streams alone" {
    var gate: Gate = .{};
    const pair: Mask = .{ .dispatch = true, .insertion = true };
    const all: Mask = .{ .dispatch = true, .insertion = true, .gas = true };
    try std.testing.expect(gate.request(1, pair));
    try std.testing.expect(gate.acknowledge(1, pair));
    try std.testing.expect(gate.snapshot().paused(1, pair));
    try std.testing.expect(gate.request(1, all));
    try std.testing.expect(!gate.snapshot().paused(1, all));
    try std.testing.expect(!gate.acknowledge(1, pair));
    try std.testing.expect(gate.acknowledge(1, all));
    try std.testing.expect(gate.snapshot().paused(1, all));
}
