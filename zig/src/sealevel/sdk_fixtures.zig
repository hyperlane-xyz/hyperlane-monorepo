const std = @import("std");
const accounts = @import("accounts.zig");
const instructions = @import("instructions.zig");
const protocol = @import("../protocol/root.zig");
const Fixture = struct { solana: struct { lookup_table: []const u8 }, sealevel: struct {
    inbox: []const u8,
    outbox: []const u8,
    dispatched: []const u8,
    processed: []const u8,
    gas_payment: []const u8,
    process_data: []const u8,
    account_metas: []const u8,
    metadata_spec: []const u8,
    message_id: []const u8,
} };

fn bytes(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, hex.len / 2);
    errdefer allocator.free(out);
    _ = try std.fmt.hexToBytes(out, hex);
    return out;
}

test "production Rust Borsh mailbox and IGP account fixtures" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("../altvm/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value.sealevel;
    const inbox_bytes = try bytes(allocator, fixture.inbox);
    defer allocator.free(inbox_bytes);
    const inbox = try accounts.Inbox.decode(inbox_bytes);
    try std.testing.expectEqual(@as(u32, 2000), inbox.local_domain);
    try std.testing.expectEqual(@as(u8, 255), inbox.bump);
    try std.testing.expectEqual([_]u8{2} ** 32, inbox.default_ism);
    try std.testing.expectEqual(@as(u64, 7), inbox.processed_count);
    const dispatched_bytes = try bytes(allocator, fixture.dispatched);
    defer allocator.free(dispatched_bytes);
    const dispatched = try accounts.DispatchedMessage.decode(dispatched_bytes);
    const expected_id = try bytes(allocator, fixture.message_id);
    defer allocator.free(expected_id);
    try std.testing.expectEqualSlices(u8, expected_id, &dispatched.message.id());
    try std.testing.expectEqual(@as(u32, 4), dispatched.nonce);
    try std.testing.expectEqual(@as(u64, 20), dispatched.slot);
    try std.testing.expectEqualStrings("body", dispatched.message.body);
    const outbox_bytes = try bytes(allocator, fixture.outbox);
    defer allocator.free(outbox_bytes);
    const outbox = try accounts.Outbox.decode(outbox_bytes);
    try std.testing.expectEqual(@as(u32, 1000), outbox.local_domain);
    try std.testing.expectEqual([_]u8{3} ** 32, outbox.owner.?);
    try std.testing.expectEqual(@as(u32, 1), outbox.tree.count);
    var expected_tree = protocol.IncrementalMerkle.init();
    try expected_tree.ingest(dispatched.message.id());
    try std.testing.expectEqual(expected_tree.root(), outbox.tree.root());
    try std.testing.expectEqual(@as(u64, 100), outbox.max_protocol_fee);
    try std.testing.expectEqual(@as(u64, 5), outbox.protocol_fee);
    const processed_bytes = try bytes(allocator, fixture.processed);
    defer allocator.free(processed_bytes);
    const processed = try accounts.ProcessedMessage.decode(processed_bytes);
    try std.testing.expectEqual(@as(u64, 7), processed.sequence);
    try std.testing.expectEqual(dispatched.message.id(), processed.message_id);
    try std.testing.expectEqual(@as(u64, 21), processed.slot);
    const payment_bytes = try bytes(allocator, fixture.gas_payment);
    defer allocator.free(payment_bytes);
    const payment = try accounts.GasPayment.decode(payment_bytes);
    try std.testing.expectEqual(@as(u64, 3), payment.sequence);
    try std.testing.expectEqual(@as(u32, 2000), payment.destination);
    try std.testing.expectEqual(dispatched.message.id(), payment.message_id);
    try std.testing.expectEqual(@as(u64, 150000), payment.gas_amount);
    try std.testing.expectEqual(@as(u64, 90000), payment.payment);
    try std.testing.expectEqual(@as(u64, 22), payment.slot);
    for (0..inbox_bytes.len) |len| try std.testing.expectError(error.TruncatedAccount, accounts.Inbox.decode(inbox_bytes[0..len]));
    for (0..payment_bytes.len) |len| try std.testing.expectError(error.TruncatedAccount, accounts.GasPayment.decode(payment_bytes[0..len]));
}

test "production Rust process instruction account-meta and recursive ISM fixtures" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("../altvm/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value.sealevel;
    const dispatched_bytes = try bytes(allocator, fixture.dispatched);
    defer allocator.free(dispatched_bytes);
    const dispatched = try accounts.DispatchedMessage.decode(dispatched_bytes);
    const expected = try bytes(allocator, fixture.process_data);
    defer allocator.free(expected);
    var process = try instructions.buildProcess(allocator, .{ .mailbox = .{0x11} ** 32, .payer = .{0x12} ** 32, .noop = .{0x13} ** 32, .ism = .{0x14} ** 32, .destination_domain = 2000, .message = dispatched.message, .metadata = &.{ 1, 2, 3 }, .ism_getter = &.{}, .ism_verify = &.{}, .handle = &.{} });
    defer process.deinit();
    try std.testing.expectEqualSlices(u8, expected, process.data);
    try std.testing.expectEqual(@as(usize, 8), process.metas.len);
    try std.testing.expect(process.metas[0].is_signer);
    try std.testing.expectEqual(dispatched.message.recipient, process.metas[7].key);
    const meta_bytes = try bytes(allocator, fixture.account_metas);
    defer allocator.free(meta_bytes);
    const metas = try instructions.decodeAccountMetas(allocator, meta_bytes);
    defer allocator.free(metas);
    try std.testing.expectEqual(@as(usize, 2), metas.len);
    try std.testing.expectEqual([_]u8{8} ** 32, metas[0].key);
    try std.testing.expect(metas[0].is_signer and !metas[0].is_writable);
    try std.testing.expect(!metas[1].is_signer and metas[1].is_writable);
    const without_sentinel = try instructions.decodeAccountMetas(allocator, meta_bytes[0 .. meta_bytes.len - 1]);
    defer allocator.free(without_sentinel);
    try std.testing.expectEqualDeep(metas, without_sentinel);
    try std.testing.expectError(error.TruncatedAccount, instructions.decodeAccountMetas(allocator, meta_bytes[0 .. meta_bytes.len - 2]));
    const spec_bytes = try bytes(allocator, fixture.metadata_spec);
    defer allocator.free(spec_bytes);
    var spec = try instructions.decodeMetadataSpec(allocator, spec_bytes, .{});
    defer spec.deinit();
    try std.testing.expectEqual(@as(usize, 2), spec.spec.?.aggregation.children.len);
    try std.testing.expectEqual(@as(u8, 1), spec.spec.?.aggregation.threshold);
}

test "Solana SDK ALT bincode metadata respects extension and deactivation windows" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("../altvm/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const encoded = try bytes(allocator, parsed.value.solana.lookup_table);
    defer allocator.free(encoded);
    var table = try accounts.AddressLookupTable.decode(.{9} ** 32, accounts.lookup_table_program, encoded);
    try std.testing.expectEqual(@as(usize, 2), table.len);
    try std.testing.expectEqual([_]u8{8} ** 32, table.authority.?);
    try std.testing.expectEqual(@as(usize, 1), (try table.active(10, &.{})).addresses.len);
    try std.testing.expectEqual(@as(usize, 2), (try table.active(11, &.{})).addresses.len);
    try std.testing.expectError(error.FutureLookupTable, table.active(9, &.{}));
    table.deactivation_slot = 10;
    try std.testing.expectEqual(@as(usize, 2), (try table.active(11, &.{10})).addresses.len);
    try std.testing.expectError(error.DeactivatedLookupTable, table.active(11, &.{}));
    try std.testing.expectError(error.WrongLookupTableOwner, accounts.AddressLookupTable.decode(.{9} ** 32, .{0} ** 32, encoded));
}
