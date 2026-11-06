const std = @import("std");
const tx = @import("transaction.zig");
const crypto = @import("crypto.zig");
const sbor = @import("sbor.zig");
const address = @import("address.zig");
const Case = struct { length: usize, metadata: []const u8, message: []const u8, visible: []const []const u8, args: []const u8, instructions: []const u8, intent: []const u8, preview: []const u8, signed_intent: []const u8, notarized: []const u8, intent_hash: []const u8, signed_intent_hash: []const u8, notarized_hash: []const u8, core_hash: []const u8 };
const Fixture = struct { account: []const u8, account_text: []const u8, component: []const u8, cases: []const Case };
fn bytes(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, hex.len / 2);
    _ = try std.fmt.hexToBytes(out, hex);
    return out;
}
fn equalHex(expected: []const u8, actual: []const u8) !void {
    const encoded = try std.testing.allocator.alloc(u8, actual.len * 2);
    defer std.testing.allocator.free(encoded);
    for (actual, 0..) |byte, i| {
        encoded[2 * i] = "0123456789abcdef"[byte >> 4];
        encoded[2 * i + 1] = "0123456789abcdef"[byte & 15];
    }
    try std.testing.expectEqualStrings(expected, encoded);
}
test "Radix production SDK V2 manifest intent preview hashes and notarization fixtures" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true })).value;
    const seed = [_]u8{0x11} ** 32;
    const public = try crypto.publicKey(seed);
    const account = crypto.account(public);
    try equalHex(fixture.account, &account);
    var text: [160]u8 = undefined;
    try std.testing.expectEqualStrings(fixture.account_text, try address.encode(.mainnet, "account", &account, &text));
    const component = (try bytes(allocator, fixture.component))[0..30].*;
    for (fixture.cases) |case| {
        const metadata = try bytes(allocator, case.metadata);
        const message = try bytes(allocator, case.message);
        const visible = try allocator.alloc([30]u8, case.visible.len);
        for (case.visible, visible) |hex, *out| out.* = (try bytes(allocator, hex))[0..30].*;
        const args = try tx.processArgs(allocator, metadata, message, visible);
        try equalHex(case.args, args);
        const instructions = try tx.instructions(allocator, account, 1500000000000000000, &.{.{ .component = component, .method = "process", .args = args }});
        try equalHex(case.instructions, instructions);
        var prepared = try tx.prepare(allocator, .{ .network_id = 1, .epoch = 100, .discriminator = case.length, .notary_key = public }, instructions);
        defer prepared.deinit();
        try equalHex(case.intent, prepared.intent);
        try equalHex(case.preview, prepared.preview);
        try equalHex(case.signed_intent, prepared.signed_intent);
        try equalHex(case.core_hash, &prepared.core_hash);
        try equalHex(case.intent_hash, &prepared.intent_hash);
        try equalHex(case.signed_intent_hash, &prepared.signed_intent_hash);
        var signed = try tx.notarize(allocator, prepared, seed);
        defer signed.deinit();
        try equalHex(case.notarized, signed.raw);
        try equalHex(case.notarized_hash, &signed.notarized_hash);
        _ = try sbor.decode(signed.raw, .manifest);
        const encoded = try bytes(allocator, case.notarized);
        for (0..encoded.len) |length| try std.testing.expectError(error.TruncatedSbor, sbor.decode(encoded[0..length], .manifest));
    }
}
