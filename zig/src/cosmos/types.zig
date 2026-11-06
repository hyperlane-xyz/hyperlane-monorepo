const std = @import("std");
const bech32 = @import("../altvm/bech32.zig");
pub const Hash = [32]u8;
pub fn field(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidCosmosJson;
    return value.object.get(name) orelse error.MissingCosmosField;
}
pub fn string(value: std.json.Value) ![]const u8 {
    if (value != .string) return error.InvalidCosmosJson;
    return value.string;
}
pub fn uint(value: std.json.Value) !u64 {
    return switch (value) {
        .integer => |number| if (number >= 0) @intCast(number) else error.InvalidCosmosInteger,
        .string, .number_string => |text| std.fmt.parseInt(u64, text, 10),
        else => error.InvalidCosmosInteger,
    };
}
pub fn hash(text: []const u8) !Hash {
    const encoded = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
    if (encoded.len != 64) return error.InvalidCosmosHash;
    var out: Hash = undefined;
    _ = try std.fmt.hexToBytes(&out, encoded);
    return out;
}
pub fn hex(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const text = try allocator.alloc(u8, try std.math.mul(usize, bytes.len, 2));
    for (bytes, 0..) |byte, i| {
        text[i * 2] = "0123456789abcdef"[byte >> 4];
        text[i * 2 + 1] = "0123456789abcdef"[byte & 15];
    }
    return text;
}
pub fn contractAddress(prefix: []const u8, address: Hash, byte_count: usize, out: []u8) ![]u8 {
    if (byte_count == 0 or byte_count > 32) return error.InvalidContractAddressBytes;
    return bech32.encode(prefix, address[32 - byte_count ..], out);
}
pub fn decodeAddress(text: []const u8, expected_prefix: ?[]const u8) !Hash {
    var bytes: [32]u8 = undefined;
    const decoded = try bech32.decode(text, &bytes);
    if (expected_prefix) |prefix| if (!std.ascii.eqlIgnoreCase(prefix, decoded.hrp)) return error.WrongCosmosAddressPrefix;
    if (decoded.bytes.len == 0 or decoded.bytes.len > 32) return error.InvalidCosmosAddressLength;
    var address: Hash = .{0} ** 32;
    @memcpy(address[32 - decoded.bytes.len ..], decoded.bytes);
    return address;
}
