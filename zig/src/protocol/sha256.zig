//! SHA-256 compression and keyed HMAC-SHA256 for the RFC6979-style signing
//! nonce. The compression is fully unrolled at comptime with the working
//! variables renamed by index instead of shifted, and HMAC keeps the
//! ipad/opad states so one key can MAC several messages (the nonce loop
//! re-keys only when the key changes). Control flow depends only on public
//! lengths, so it is constant time in keys and messages.
const std = @import("std");

const iv = [8]u32{ 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };

const k = [64]u32{
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

inline fn rotr(x: u32, comptime n: u5) u32 {
    return std.math.rotr(u32, x, n);
}

/// One SHA-256 compression of a 64-byte block into `state`.
pub fn compress(state: *[8]u32, block: *const [64]u8) void {
    @setEvalBranchQuota(10_000);
    var w: [16]u32 = undefined;
    inline for (0..16) |i| w[i] = std.mem.readInt(u32, block[i * 4 ..][0..4], .big);
    // v[(j - i) mod 8] is working variable j (a..h) at round i: renaming by
    // index keeps the eight values in place instead of shifting them.
    var v = state.*;
    inline for (0..64) |i| {
        if (i >= 16) {
            const w15 = w[(i - 15) % 16];
            const w2 = w[(i - 2) % 16];
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >> 10);
            w[i % 16] = w[i % 16] +% s0 +% w[(i - 7) % 16] +% s1;
        }
        const a = (0 + 64 - i) % 8;
        const b = (1 + 64 - i) % 8;
        const c = (2 + 64 - i) % 8;
        const d = (3 + 64 - i) % 8;
        const e = (4 + 64 - i) % 8;
        const f = (5 + 64 - i) % 8;
        const g = (6 + 64 - i) % 8;
        const h = (7 + 64 - i) % 8;
        const big_s1 = rotr(v[e], 6) ^ rotr(v[e], 11) ^ rotr(v[e], 25);
        const ch = (v[e] & v[f]) ^ (~v[e] & v[g]);
        const t1 = v[h] +% big_s1 +% ch +% k[i] +% w[i % 16];
        const big_s0 = rotr(v[a], 2) ^ rotr(v[a], 13) ^ rotr(v[a], 22);
        const maj = (v[a] & v[b]) ^ (v[a] & v[c]) ^ (v[b] & v[c]);
        v[d] +%= t1;
        // The old h slot becomes the new a.
        v[h] = t1 +% big_s0 +% maj;
    }
    inline for (0..8) |i| state[i] +%= v[i];
    // Message words and working variables derive from keys and secrets.
    std.crypto.secureZero(u32, &w);
    std.crypto.secureZero(u32, &v);
}

/// Continues a hash from `state` (which already absorbed `prefix_len` bytes,
/// a multiple of 64) over `data`, pads and returns the digest.
fn finish(start: [8]u32, prefix_len: usize, data: []const u8) [32]u8 {
    var state = start;
    var rest = data;
    while (rest.len >= 64) {
        compress(&state, rest[0..64]);
        rest = rest[64..];
    }
    var block: [128]u8 = @splat(0);
    @memcpy(block[0..rest.len], rest);
    block[rest.len] = 0x80;
    const blocks: usize = if (rest.len < 56) 1 else 2;
    const bits: u64 = @as(u64, prefix_len + data.len) * 8;
    std.mem.writeInt(u64, block[blocks * 64 - 8 ..][0..8], bits, .big);
    compress(&state, block[0..64]);
    if (blocks == 2) compress(&state, block[64..128]);
    var out: [32]u8 = undefined;
    inline for (0..8) |i| std.mem.writeInt(u32, out[i * 4 ..][0..4], state[i], .big);
    std.crypto.secureZero(u8, &block);
    std.crypto.secureZero(u32, &state);
    return out;
}

pub fn hash(data: []const u8) [32]u8 {
    return finish(iv, 0, data);
}

/// HMAC-SHA256 with the key's ipad/opad blocks absorbed once.
pub const HmacKey = struct {
    inner: [8]u32,
    outer: [8]u32,

    pub fn init(key: *const [32]u8) HmacKey {
        var pad: [64]u8 = @splat(0x36);
        for (key, 0..) |byte, i| pad[i] ^= byte;
        var self: HmacKey = .{ .inner = iv, .outer = iv };
        compress(&self.inner, &pad);
        for (&pad) |*byte| byte.* ^= 0x36 ^ 0x5c;
        compress(&self.outer, &pad);
        std.crypto.secureZero(u8, &pad);
        return self;
    }

    pub fn mac(self: *const HmacKey, message: []const u8) [32]u8 {
        var inner = finish(self.inner, 64, message);
        defer std.crypto.secureZero(u8, &inner);
        return finish(self.outer, 64, &inner);
    }

    pub fn wipe(self: *HmacKey) void {
        std.crypto.secureZero(u32, &self.inner);
        std.crypto.secureZero(u32, &self.outer);
    }
};

test "SHA-256 and HMAC-SHA256 match std at every length around block boundaries" {
    var prng = std.Random.DefaultPrng.init(0x736861);
    var data: [300]u8 = undefined;
    prng.random().bytes(&data);
    for (0..data.len + 1) |len| {
        var expected: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(data[0..len], &expected, .{});
        try std.testing.expectEqual(expected, hash(data[0..len]));
        var key: [32]u8 = undefined;
        prng.random().bytes(&key);
        std.crypto.auth.hmac.sha2.HmacSha256.create(&expected, data[0..len], &key);
        try std.testing.expectEqual(expected, HmacKey.init(&key).mac(data[0..len]));
    }
    var abc: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&abc, "ba7816bf8f01cfea414140de5dae2223" ++ "b00361a396177a9cb410ff61f20015ad");
    try std.testing.expectEqual(abc, hash("abc"));
}
