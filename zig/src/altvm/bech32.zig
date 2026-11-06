//! BIP-173 Bech32 (checksum constant 1), as used by Cosmos account IDs.
const std = @import("std");
const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn step(check: u32, value: u5) u32 {
    const top = check >> 25;
    var next = ((check & 0x1ffffff) << 5) ^ value;
    const generators = [_]u32{ 0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3 };
    for (generators, 0..) |generator, i| if ((top >> @intCast(i)) & 1 != 0) {
        next ^= generator;
    };
    return next;
}

fn prefixCheck(hrp: []const u8) u32 {
    var check: u32 = 1;
    for (hrp) |char| check = step(check, @intCast(std.ascii.toLower(char) >> 5));
    check = step(check, 0);
    for (hrp) |char| check = step(check, @intCast(char & 31));
    return check;
}

pub fn encode(hrp: []const u8, bytes: []const u8, out: []u8) ![]u8 {
    return encodeVariant(hrp, bytes, out, 1, true);
}
pub fn encodeM(hrp: []const u8, bytes: []const u8, out: []u8) ![]u8 {
    return encodeVariant(hrp, bytes, out, 0x2bc830a3, false);
}
fn encodeVariant(hrp: []const u8, bytes: []const u8, out: []u8, checksum: u32, enforce_90: bool) ![]u8 {
    if (hrp.len == 0 or hrp.len > 83) return error.InvalidPrefix;
    for (hrp) |char| {
        if (char < 33 or char > 126 or std.ascii.isUpper(char)) return error.InvalidPrefix;
    }
    const data_len = (try std.math.add(usize, try std.math.mul(usize, bytes.len, 8), 4)) / 5;
    const length = try std.math.add(usize, hrp.len + 7, data_len);
    if (enforce_90 and length > 90) return error.Bech32TooLong;
    if (out.len < length) return error.BufferTooSmall;
    @memcpy(out[0..hrp.len], hrp);
    out[hrp.len] = '1';
    var check = prefixCheck(hrp);
    var acc: u32 = 0;
    var bits: u5 = 0;
    var pos = hrp.len + 1;
    for (bytes) |byte| {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            const digit: u5 = @truncate(acc >> bits);
            out[pos] = alphabet[digit];
            pos += 1;
            check = step(check, digit);
        }
        acc &= (@as(u32, 1) << bits) - 1;
    }
    if (bits != 0) {
        const digit: u5 = @intCast(acc << (5 - bits));
        out[pos] = alphabet[digit];
        pos += 1;
        check = step(check, digit);
    }
    for (0..6) |_| check = step(check, 0);
    check ^= checksum;
    for (0..6) |i| out[pos + i] = alphabet[@as(u5, @truncate(check >> @intCast(5 * (5 - i))))];
    return out[0..length];
}

pub const Decoded = struct { hrp: []const u8, bytes: []u8 };
pub fn decode(text: []const u8, out: []u8) !Decoded {
    return decodeVariant(text, out, false);
}
/// Generic address decoding matches bech32 0.11: accept either Bech32 or
/// Bech32m checksum; no BIP173 whole-string 90-character limit. HRP <=83.
/// Cosmos callers continue using strict decode().
pub fn decodeAny(text: []const u8, out: []u8) !Decoded {
    return decodeVariant(text, out, true);
}
fn decodeVariant(text: []const u8, out: []u8, any_checksum: bool) !Decoded {
    if (text.len < 8 or (!any_checksum and text.len > 90)) return error.InvalidBech32Length;
    var lower = false;
    var upper = false;
    for (text) |char| {
        if (char < 33 or char > 126) return error.InvalidBech32Character;
        lower = lower or std.ascii.isLower(char);
        upper = upper or std.ascii.isUpper(char);
    }
    if (lower and upper) return error.MixedBech32Case;
    const separator = std.mem.lastIndexOfScalar(u8, text, '1') orelse return error.MissingSeparator;
    if (separator == 0 or separator + 7 > text.len) return error.InvalidBech32Length;
    const hrp = text[0..separator];
    if (hrp.len > 83) return error.InvalidPrefix;
    var check = prefixCheck(hrp);
    var acc: u32 = 0;
    var bits: u5 = 0;
    var pos: usize = 0;
    for (text[separator + 1 ..], 0..) |char, i| {
        const digit: u5 = @intCast(std.mem.indexOfScalar(u8, alphabet, std.ascii.toLower(char)) orelse return error.InvalidBech32Character);
        check = step(check, digit);
        if (i >= text.len - separator - 7) continue;
        acc = (acc << 5) | digit;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            if (pos == out.len) return error.BufferTooSmall;
            out[pos] = @truncate(acc >> bits);
            pos += 1;
        }
        acc &= (@as(u32, 1) << bits) - 1;
    }
    if (check != 1 and (!any_checksum or check != 0x2bc830a3)) return error.InvalidChecksum;
    if (bits >= 5 or acc != 0) return error.InvalidPadding;
    return .{ .hrp = hrp, .bytes = out[0..pos] };
}

test "Cosmos address source fixture and BIP173 mixed case checksum" {
    var key: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&key, "1b16866227825a5166eb44031cdcf656" ++ "8b3e80b52f2806e01b89a34dc90ae616");
    var text: [90]u8 = undefined;
    const encoded = try encode("dual", &key, &text);
    try std.testing.expectEqualStrings("dual1rvtgvc38sfd9zehtgsp3eh8k269naq949u5qdcqm3x35mjg2uctqfdn3yq", encoded);
    var bytes: [32]u8 = undefined;
    const decoded = try decode(encoded, &bytes);
    try std.testing.expectEqualStrings("dual", decoded.hrp);
    try std.testing.expectEqualSlices(u8, &key, decoded.bytes);
    const empty = try decode("A12UEL5L", &bytes);
    try std.testing.expectEqual(@as(usize, 0), empty.bytes.len);
    try std.testing.expectError(error.MixedBech32Case, decode("a12UEL5L", &bytes));
    try std.testing.expectError(error.InvalidChecksum, decode("a12uel5q", &bytes));
}

test "generic addresses decode BIP350 without weakening Cosmos checksum policy" {
    var out: [32]u8 = undefined;
    const empty = try decodeAny("A1LQFN3A", &out);
    try std.testing.expectEqual(@as(usize, 0), empty.bytes.len);
    try std.testing.expectError(error.InvalidChecksum, decode("A1LQFN3A", &out));
    const long_prefix = [_]u8{'a'} ** 83;
    const source = [_]u8{0xab} ** 32;
    var text: [143]u8 = undefined;
    const encoded = try encodeM(&long_prefix, &source, &text);
    try std.testing.expect(encoded.len > 90);
    const decoded = try decodeAny(encoded, &out);
    try std.testing.expectEqualSlices(u8, &source, decoded.bytes);
    try std.testing.expectEqualStrings(&long_prefix, decoded.hrp);
    try std.testing.expectError(error.InvalidBech32Length, decode(encoded, &out));
    text[encoded.len - 1] = if (text[encoded.len - 1] == 'q') 'p' else 'q';
    try std.testing.expectError(error.InvalidChecksum, decodeAny(encoded, &out));
}
