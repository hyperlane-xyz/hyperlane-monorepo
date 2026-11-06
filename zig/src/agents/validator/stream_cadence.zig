//! Rust submit.rs: notifications cannot bypass interval; retained samples waiting
//! for insertions refresh at30s; authenticated idle frontiers audit at60s.
const std = @import("std");
pub const Cadence = struct {
    const Sample = enum { none, waiting_insertions, verified };
    sample: Sample = .none,
    attempted: bool = false,
    next_attempt_ms: u64 = 0,
    sampled_at_ms: u64 = 0,
    pub fn due(self: Cadence, now_ms: u64, rpc_fallback: bool, next_leaf_cached: bool, tree_count: u32) bool {
        if (now_ms < self.next_attempt_ms) return false;
        if (!self.attempted or rpc_fallback or self.sample == .none) return true;
        if (self.sample == .waiting_insertions) return now_ms -| self.sampled_at_ms >= 30000;
        return next_leaf_cached or (tree_count > 0 and now_ms -| self.sampled_at_ms >= 60000);
    }
    pub fn verified(self: Cadence) bool {
        return self.sample == .verified;
    }
    pub fn attemptedAt(self: *Cadence, completed_ms: u64, interval_ms: u64) void {
        self.attempted = true;
        self.sample = .none;
        self.sampled_at_ms = completed_ms;
        self.next_attempt_ms = completed_ms +| interval_ms;
    }
    pub fn processed(self: *Cadence, authorized: bool, waiting_insertions: bool, authenticated_empty: bool) void {
        self.sample = if (authorized or authenticated_empty) .verified else if (waiting_insertions) .waiting_insertions else .none;
    }
};
test "stream cadence retains source minimum retries thirty-second waiting samples and sixty-second idle audits" {
    var c: Cadence = .{};
    try std.testing.expect(c.due(0, false, false, 0));
    c.attemptedAt(100, 1000);
    try std.testing.expect(!c.due(1099, true, true, 3));
    try std.testing.expect(c.due(1100, false, false, 3)); // failed read retry
    c.processed(false, true, false);
    try std.testing.expect(!c.due(30099, false, true, 1));
    try std.testing.expect(c.due(30100, false, false, 1));
    c.processed(true, false, false);
    try std.testing.expect(!c.due(60099, false, false, 3));
    try std.testing.expect(c.due(60100, false, false, 3));
    try std.testing.expect(c.due(1100, false, true, 3));
    try std.testing.expect(c.due(1100, true, false, 3));
    c.processed(false, false, true);
    try std.testing.expect(!c.due(9999999, false, false, 0));
    try std.testing.expect(c.due(1100, false, true, 0));
}
