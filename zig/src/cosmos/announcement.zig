//! Source-backed validator announcement messages. Accept already signed public
//! bytes; this module neither reads keys nor submits a transaction.
const std = @import("std");
const sdk = @import("../altvm/cosmos.zig");
const pb = @import("../altvm/protobuf.zig");
const types = @import("types.zig");
const proto = @import("proto.zig");
fn check(location: []const u8) !void {
    if (location.len > 8192 or !std.unicode.utf8ValidateSlice(location)) return error.InvalidAnnouncementLocation;
}
/// Caller owns returned Any.value; type_url is static. No funds attached.
pub fn wasm(a: std.mem.Allocator, creator: []const u8, contract: []const u8, validator: [20]u8, location: []const u8, signature: [65]u8) !sdk.Any {
    try check(location);
    _ = try types.decodeAddress(creator, null);
    _ = try types.decodeAddress(contract, null);
    const request = try std.json.Stringify.valueAlloc(a, .{ .announce = .{ .validator = std.fmt.bytesToHex(validator, .lower), .storage_location = location, .signature = std.fmt.bytesToHex(signature, .lower) } }, .{});
    defer a.free(request);
    return .{ .type_url = "/cosmwasm.wasm.v1.MsgExecuteContract", .value = try sdk.executeContract(a, creator, contract, request, &.{}) };
}
/// Actual hyperlane-cosmos-rs0.1.4 MsgAnnounceValidator field tags. mailbox_id
/// retains the source's 0x prefix; validator/signature are unprefixed lowerhex.
pub fn native(a: std.mem.Allocator, creator: []const u8, mailbox: [32]u8, validator: [20]u8, location: []const u8, signature: [65]u8) !sdk.Any {
    try check(location);
    _ = try types.decodeAddress(creator, null);
    const mailbox_hex = "0x" ++ std.fmt.bytesToHex(mailbox, .lower);
    const out = try a.alloc(u8, location.len + creator.len + 320);
    errdefer a.free(out);
    var enc: pb.Encoder = .{ .out = out };
    try enc.bytes(1, &std.fmt.bytesToHex(validator, .lower));
    try enc.bytes(2, location);
    try enc.bytes(3, &std.fmt.bytesToHex(signature, .lower));
    try enc.bytes(4, mailbox_hex);
    try enc.bytes(5, creator);
    return .{ .type_url = "/hyperlane.core.interchain_security.v1.MsgAnnounceValidator", .value = try a.realloc(out, enc.pos) };
}
test "Cosmos announcement wire preserves exact CW JSON and native protobuf public payload" {
    const a = std.testing.allocator;
    const creator = "cosmos1l3e9pgs3mmwuwrh95fecme0s0qtn2880f2jmfe";
    const location = "s3://fixture/region";
    const signature = [_]u8{0x11} ** 64 ++ .{27};
    const module = try native(a, creator, .{2} ** 32, .{3} ** 20, location, signature);
    defer a.free(module.value);
    try std.testing.expectEqualStrings("/hyperlane.core.interchain_security.v1.MsgAnnounceValidator", module.type_url);
    try std.testing.expectEqualStrings(&std.fmt.bytesToHex([_]u8{3} ** 20, .lower), try proto.textField(module.value, 1));
    try std.testing.expectEqualStrings(location, try proto.textField(module.value, 2));
    try std.testing.expectEqual(@as(usize, 130), (try proto.textField(module.value, 3)).len);
    try std.testing.expectEqualStrings("0x" ++ "02" ** 32, try proto.textField(module.value, 4));
    try std.testing.expectEqualStrings(creator, try proto.textField(module.value, 5));
    const cw = try wasm(a, creator, creator, .{3} ** 20, location, signature);
    defer a.free(cw.value);
    try std.testing.expectEqualStrings(creator, try proto.textField(cw.value, 2));
    var parsed = try std.json.parseFromSlice(std.json.Value, a, (try proto.bytesField(cw.value, 3)).?, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings(location, parsed.value.object.get("announce").?.object.get("storage_location").?.string);
    try std.testing.expectEqual(@as(usize, 40), parsed.value.object.get("announce").?.object.get("validator").?.string.len);
}

test "Cosmos announcement bytes match exact production CW payload and real SDK native protobuf fixture" {
    const a = std.testing.allocator;
    var fixture = try @import("../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../altvm/fixtures/announcements.json.gz"), .{});
    defer fixture.deinit();
    const fields = fixture.value.object;
    const creator = fields.get("creator").?.string;
    const location = fields.get("location").?.string;
    const cw = try wasm(a, creator, creator, .{5} ** 20, location, .{6} ** 65);
    defer a.free(cw.value);
    const module = try native(a, creator, .{2} ** 32, .{5} ** 20, location, .{6} ** 65);
    defer a.free(module.value);
    for ([_][]const u8{ "cw", "native" }, [_][]const u8{ cw.value, module.value }) |field, actual| {
        const encoded = fields.get(field).?.string;
        const bytes = try a.alloc(u8, encoded.len / 2);
        defer a.free(bytes);
        _ = try std.fmt.hexToBytes(bytes, encoded);
        try std.testing.expectEqualSlices(u8, bytes, actual);
    }
}
