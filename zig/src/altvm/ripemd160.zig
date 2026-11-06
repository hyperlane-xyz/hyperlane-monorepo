//! RIPEMD-160 for Cosmos account addresses. Published RIPEMD-160 algorithm
//! parameters; no runtime dependency. Security-sensitive signing uses std.crypto.
const std = @import("std");
const left_index = [_]u4{ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13 };
const right_index = [_]u4{ 5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11 };
const left_shift = [_]u5{ 11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6 };
const right_shift = [_]u5{ 8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11 };

fn f(round: usize, x: u32, y: u32, z: u32) u32 {
    return switch (round) {
        0 => x ^ y ^ z,
        1 => (x & y) | (~x & z),
        2 => (x | ~y) ^ z,
        3 => (x & z) | (y & ~z),
        4 => x ^ (y | ~z),
        else => unreachable,
    };
}
fn compress(state: *[5]u32, block: *const [64]u8) void {
    var words: [16]u32 = undefined;
    for (&words, 0..) |*word, i| word.* = std.mem.readInt(u32, block[i * 4 ..][0..4], .little);
    var left = state.*;
    var right = state.*;
    const left_constants = [_]u32{ 0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e };
    const right_constants = [_]u32{ 0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0 };
    for (0..80) |i| {
        const round = i / 16;
        const l = std.math.rotl(u32, left[0] +% f(round, left[1], left[2], left[3]) +% words[left_index[i]] +% left_constants[round], left_shift[i]) +% left[4];
        const next_left = [_]u32{ left[4], l, left[1], std.math.rotl(u32, left[2], 10), left[3] };
        left = next_left;
        const r = std.math.rotl(u32, right[0] +% f(4 - round, right[1], right[2], right[3]) +% words[right_index[i]] +% right_constants[round], right_shift[i]) +% right[4];
        const next_right = [_]u32{ right[4], r, right[1], std.math.rotl(u32, right[2], 10), right[3] };
        right = next_right;
    }
    const next_state = [_]u32{
        state[1] +% left[2] +% right[3],
        state[2] +% left[3] +% right[4],
        state[3] +% left[4] +% right[0],
        state[4] +% left[0] +% right[1],
        state[0] +% left[1] +% right[2],
    };
    state.* = next_state;
}

pub fn hash(bytes: []const u8) [20]u8 {
    var state = [_]u32{ 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0 };
    var offset: usize = 0;
    while (bytes.len - offset >= 64) : (offset += 64) compress(&state, bytes[offset..][0..64]);
    var tail: [128]u8 = .{0} ** 128;
    @memcpy(tail[0 .. bytes.len - offset], bytes[offset..]);
    tail[bytes.len - offset] = 128;
    const padded_len: usize = if (bytes.len - offset < 56) 64 else 128;
    std.mem.writeInt(u64, tail[padded_len - 8 ..][0..8], @as(u64, @truncate(bytes.len)) *% 8, .little);
    compress(&state, tail[0..64]);
    if (padded_len == 128) compress(&state, tail[64..128]);
    var out: [20]u8 = undefined;
    for (state, 0..) |word, i| std.mem.writeInt(u32, out[i * 4 ..][0..4], word, .little);
    return out;
}

test "RIPEMD-160 published vectors and multi-block padding boundaries" {
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "9c1185a5c5e9fc54612808977ee8f548b2258d31");
        try std.testing.expectEqual(expected, hash(""));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "0bdc9d2d256b3ee9daae347be6f4dc835a467ffe");
        try std.testing.expectEqual(expected, hash("a"));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
        try std.testing.expectEqual(expected, hash("abc"));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "5d0689ef49d2fae572b881b123a85ffa21595f36");
        try std.testing.expectEqual(expected, hash("message digest"));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "f71c27109c692c1b56bbdceb5b9d2865b3708dbc");
        try std.testing.expectEqual(expected, hash("abcdefghijklmnopqrstuvwxyz"));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "9b752e45573d4b39f4dbd3323cab82bf63326bfb");
        try std.testing.expectEqual(expected, hash("12345678901234567890123456789012345678901234567890123456789012345678901234567890"));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "0d8a8c9063a48576a7c97e9f95253a6e53ff6765");
        try std.testing.expectEqual(expected, hash(&(.{'a'} ** 55)));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "e72334b46c83cc70bef979e15453706c95b888be");
        try std.testing.expectEqual(expected, hash(&(.{'a'} ** 56)));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "e640041293fe663b9bf3f8c21ffecac03819e6b2");
        try std.testing.expectEqual(expected, hash(&(.{'a'} ** 63)));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "9dfb7d374ad924f3f88de96291c33e9abed53e32");
        try std.testing.expectEqual(expected, hash(&(.{'a'} ** 64)));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "99724bb11811e7166af38f671b6a082d8ab4960b");
        try std.testing.expectEqual(expected, hash(&(.{'a'} ** 65)));
    }
    {
        var expected: [20]u8 = undefined;
        _ = try std.fmt.hexToBytes(&expected, "aa69deee9a8922e92f8105e007f76110f381e9cf");
        try std.testing.expectEqual(expected, hash(&(.{'a'} ** 1000)));
    }
}
