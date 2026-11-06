//! Blockhash expiry is a reconciliation trigger, never proof of nondelivery.
//! Caller persists the signature, signed bytes and lease before broadcasting.
const std = @import("std");
const provider = @import("provider.zig");
pub const Action = enum { wait, finalized_success, finalized_failure, reconcile_expiry };
pub const Lease = struct {
    signature: [64]u8,
    blockhash: [32]u8,
    last_valid_block_height: u64,
    finalized: ?bool = null,

    pub fn observe(self: *Lease, current_block_height: u64, status: ?provider.SignatureStatus) Action {
        if (self.finalized) |success| return if (success) .finalized_success else .finalized_failure;
        if (status) |seen| {
            if (seen.confirmation != .finalized) return .wait;
            self.finalized = !seen.failed;
            return if (seen.failed) .finalized_failure else .finalized_success;
        }
        // The blockhash can no longer be newly included, but this RPC could have
        // lost an old transaction record. Query finalized processed-message PDA
        // and reconcile history before deciding whether to create a replacement.
        return if (current_block_height > self.last_valid_block_height) .reconcile_expiry else .wait;
    }
};

test "blockhash expiry never treats ambiguous or unfinalized submission as delivery" {
    var lease: Lease = .{ .signature = .{1} ** 64, .blockhash = .{2} ** 32, .last_valid_block_height = 100 };
    try std.testing.expectEqual(Action.wait, lease.observe(100, null));
    try std.testing.expectEqual(Action.reconcile_expiry, lease.observe(101, null));
    try std.testing.expectEqual(Action.wait, lease.observe(101, .{ .slot = 20, .failed = true, .confirmation = .confirmed }));
    try std.testing.expectEqual(Action.finalized_success, lease.observe(102, .{ .slot = 20, .failed = false, .confirmation = .finalized }));
    try std.testing.expectEqual(Action.finalized_success, lease.observe(103, null));
}
