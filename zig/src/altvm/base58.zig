const std = @import("std");
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Caller owns returned text. Leading zero bytes are preserved as '1'.
pub fn encode(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const size = try std.math.add(usize, try std.math.mul(usize, bytes.len, 138) / 100, 1);
    const digits = try allocator.alloc(u8, size);
    defer allocator.free(digits);
    @memset(digits, 0);
    var zeros: usize = 0;
    while (zeros < bytes.len and bytes[zeros] == 0) zeros += 1;
    var used: usize = 0;
    for (bytes[zeros..]) |byte| {
        var carry: u32 = byte;
        for (0..used) |j| {
            carry += @as(u32, digits[j]) * 256;
            digits[j] = @intCast(carry % 58);
            carry /= 58;
        }
        while (carry != 0) {
            digits[used] = @intCast(carry % 58);
            used += 1;
            carry /= 58;
        }
    }
    const out = try allocator.alloc(u8, zeros + used);
    @memset(out[0..zeros], '1');
    for (0..used) |i| out[zeros + i] = alphabet[digits[used - 1 - i]];
    return out;
}

pub fn decode(allocator: std.mem.Allocator, text: []const u8) ![]u8 {
    const size = try std.math.add(usize, try std.math.mul(usize, text.len, 733) / 1000, 1);
    const digits = try allocator.alloc(u8, size);
    defer allocator.free(digits);
    @memset(digits, 0);
    var zeros: usize = 0;
    while (zeros < text.len and text[zeros] == '1') zeros += 1;
    var used: usize = 0;
    for (text[zeros..]) |char| {
        var carry: u32 = @intCast(std.mem.indexOfScalar(u8, alphabet, char) orelse return error.InvalidBase58);
        for (0..used) |j| {
            carry += @as(u32, digits[j]) * 58;
            digits[j] = @truncate(carry);
            carry >>= 8;
        }
        while (carry != 0) {
            digits[used] = @truncate(carry);
            used += 1;
            carry >>= 8;
        }
    }
    const out = try allocator.alloc(u8, zeros + used);
    @memset(out[0..zeros], 0);
    for (0..used) |i| out[zeros + i] = digits[used - 1 - i];
    return out;
}

test "base58 fixed vectors leading zeroes and invalid alphabet" {
    const fixtures = [_]struct { []const u8, []const u8 }{
        .{ "", "" },                           .{ &.{0}, "1" }, .{ &.{ 0, 0, 1 }, "112" },
        .{ "Hello World", "JxF12TrwUP45BMd" },
    };
    for (fixtures) |fixture| {
        const encoded = try encode(std.testing.allocator, fixture[0]);
        defer std.testing.allocator.free(encoded);
        try std.testing.expectEqualStrings(fixture[1], encoded);
        const decoded = try decode(std.testing.allocator, encoded);
        defer std.testing.allocator.free(decoded);
        try std.testing.expectEqualSlices(u8, fixture[0], decoded);
    }
    for ("0OIl+ ") |char| try std.testing.expectError(error.InvalidBase58, decode(std.testing.allocator, &.{char}));
}
