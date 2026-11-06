//! Pure transaction lifecycle plus explicit read-only process preparation. No
//! secret discovery, submission, durable state or automatic replacement signing.
const std = @import("std");
const provider = @import("provider.zig");
const tx = @import("transaction.zig");
const crypto = @import("crypto.zig");
const address = @import("address.zig");
const json = @import("../cosmos/types.zig");
const protocol = @import("../protocol/root.zig");
const events = @import("events.zig");
pub const Decision = enum { wait, success, execution_failed, rejected, reconcile_expired };
pub fn observe(end_epoch_exclusive: u64, current_epoch: u64, status: provider.StatusResult) !Decision {
    return switch (status.status) {
        .committed_success => if (status.committed_state_version != null) .success else error.MissingRadixCommitState,
        .committed_failure => if (status.committed_state_version != null) .execution_failed else error.MissingRadixCommitState,
        .rejected => .rejected,
        else => if (current_epoch >= end_epoch_exclusive) .reconcile_expired else .wait,
    };
}
pub fn lockedFee(receipt: std.json.Value) !i192 {
    const summary = try json.field(receipt, "fee_summary");
    var total: i192 = 0;
    inline for (.{ "xrd_total_execution_cost", "xrd_total_finalization_cost", "xrd_total_royalty_cost", "xrd_total_storage_cost" }) |name| {
        const value = try events.decimalAttos(try json.string(try json.field(summary, name)));
        if (value < 0) return error.NegativeRadixFee;
        total = try std.math.add(i192, total, value);
    }
    // Same fixed-point floor as Radix Decimal * Decimal("1.5").
    return std.math.add(i192, total, @divTrunc(total, 2));
}
fn invisibleComponent(network: address.Network, message: []const u8) ?[30]u8 {
    const marker = "component_";
    var offset: usize = 0;
    while (std.mem.indexOfPos(u8, message, offset, marker)) |start| {
        var end = start;
        while (end < message.len and (std.ascii.isAlphanumeric(message[end]) or message[end] == '_')) end += 1;
        var bytes: [30]u8 = undefined;
        const decoded = address.decode(network, "component", message[start..end], &bytes) catch {
            offset = end;
            continue;
        };
        if (decoded.len != 30) return null;
        return decoded[0..30].*;
    }
    return null;
}
pub fn prepareProcess(client: provider.Client, mailbox: [30]u8, domain: u32, message: protocol.Message, metadata: []const u8, notary_public_key: [32]u8, discriminator: u64) !tx.Prepared {
    if (message.version != 3 or message.destination != domain) return error.WrongRadixMessageDestination;
    const allocator = client.allocator;
    const ledger = try client.gatewayState();
    const encoded = try message.encodeAlloc(allocator);
    defer allocator.free(encoded);
    const header: tx.Header = .{ .network_id = client.network.id, .epoch = ledger.epoch, .discriminator = discriminator, .notary_key = notary_public_key };
    var visible: [5][30]u8 = undefined;
    var count: usize = 0;
    for (0..5) |_| {
        const args = try tx.processArgs(allocator, metadata, encoded, visible[0..count]);
        defer allocator.free(args);
        const preview_instructions = try tx.instructions(allocator, null, 0, &.{.{ .component = mailbox, .method = "process", .args = args }});
        defer allocator.free(preview_instructions);
        var prepared = try tx.prepare(allocator, header, preview_instructions);
        defer prepared.deinit();
        var response = try client.preview(prepared);
        defer response.deinit();
        const receipt = try json.field(response.value(), "receipt");
        const status = try json.string(try json.field(receipt, "status"));
        if (std.mem.eql(u8, status, "Succeeded")) {
            const instructions = try tx.instructions(allocator, crypto.account(notary_public_key), try lockedFee(receipt), &.{.{ .component = mailbox, .method = "process", .args = args }});
            defer allocator.free(instructions);
            return tx.prepare(allocator, header, instructions);
        }
        const text = try json.string(try json.field(receipt, "error_message"));
        const component = invisibleComponent(client.network, text) orelse return error.RadixPreviewFailed;
        for (visible[0..count]) |existing| if (std.mem.eql(u8, &existing, &component)) return error.RadixVisibilityDidNotConverge;
        visible[count] = component;
        count += 1;
    }
    return error.RadixVisibilityDidNotConverge;
}
test "Radix expiry requires reconciliation and never proves nondelivery" {
    try std.testing.expectEqual(Decision.wait, try observe(102, 101, .{ .status = .pending, .committed_state_version = null }));
    try std.testing.expectEqual(Decision.reconcile_expired, try observe(102, 102, .{ .status = .unknown, .committed_state_version = null }));
    try std.testing.expectEqual(Decision.success, try observe(102, 103, .{ .status = .committed_success, .committed_state_version = 10 }));
    try std.testing.expectEqual(Decision.execution_failed, try observe(102, 103, .{ .status = .committed_failure, .committed_state_version = 10 }));
}
