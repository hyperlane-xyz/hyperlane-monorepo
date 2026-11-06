//! Manifest arguments consumed by actual Radix ValidatorAnnounce. Already
//! signed announcement bytes only; caller builds/signs/notarizes its own tx.
const std = @import("std");
const sbor = @import("sbor.zig");
pub fn args(a: std.mem.Allocator, validator: [20]u8, location: []const u8, signature: [65]u8) ![]u8 {
    if (location.len > 8192 or !std.unicode.utf8ValidateSlice(location)) return error.InvalidAnnouncementLocation;
    var writer: sbor.Writer = .{ .allocator = a };
    errdefer writer.deinit();
    try writer.byte(0x4d);
    try writer.tuple(3);
    // EthAddress is #[sbor(transparent)] around [u8;20], not a nested tuple.
    try writer.bytes(&validator);
    try writer.text(location);
    try writer.bytes(&signature);
    return writer.owned();
}
/// Caller owns args and passes Call{component,method="announce",args} to the
/// existing transaction.instructions / runtime.prepare flow.
pub fn call(a: std.mem.Allocator, component: [30]u8, validator: [20]u8, location: []const u8, signature: [65]u8) !@import("transaction.zig").Call {
    return .{ .component = component, .method = "announce", .args = try args(a, validator, location, signature) };
}
test "Radix announcement manifest uses transparent EthAddress tuple and public signature" {
    const a = std.testing.allocator;
    const value = try args(a, .{3} ** 20, "s3://fixture/region", .{4} ** 65);
    defer a.free(value);
    const decoded = try sbor.decode(value, .manifest);
    try std.testing.expectEqual(@as(u8, 0x21), decoded.kind);
    var fields: [3]sbor.Value = undefined;
    try sbor.fields(decoded, &fields);
    try std.testing.expectEqualSlices(u8, &([_]u8{3} ** 20), try sbor.byteArray(fields[0]));
    try std.testing.expectEqualStrings("s3://fixture/region", try sbor.text(fields[1]));
    try std.testing.expectEqual(@as(usize, 65), (try sbor.byteArray(fields[2])).len);
}

test "Radix announcement manifest bytes match actual pinned production SDK transparent EthAddress" {
    const a = std.testing.allocator;
    var fixture = try @import("../testing/fixture.zig").parse(std.json.Value, a, @embedFile("fixtures/announcement.json.gz"), .{});
    defer fixture.deinit();
    const encoded = fixture.value.object.get("args").?.string;
    const expected = try a.alloc(u8, encoded.len / 2);
    defer a.free(expected);
    _ = try std.fmt.hexToBytes(expected, encoded);
    const actual = try args(a, .{5} ** 20, "s3://fixture/region", .{6} ** 65);
    defer a.free(actual);
    try std.testing.expectEqualSlices(u8, expected, actual);
}
