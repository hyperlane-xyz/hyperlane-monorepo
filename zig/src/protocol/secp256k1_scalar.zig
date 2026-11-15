//! Constant-time inversion modulo the secp256k1 group order n, using the
//! Bernstein-Yang "safegcd" divstep algorithm in the form of libsecp256k1's
//! modinv64 (constant-time variant): 10 batches of 59 divsteps on signed
//! 62-bit limbs, each batch applied as a 2x2 transition matrix. Fixed
//! iteration counts and mask arithmetic only; no secret-dependent branch or
//! index. Used for the secret nonce inverse in signing (~4x cheaper than
//! std's fiat divstep inversion).
const std = @import("std");
const field = @import("secp256k1_field.zig");

pub const n: u256 = std.crypto.ecc.Secp256k1.scalar.field_order;
const m62: u64 = std.math.maxInt(u64) >> 2;

const Signed62 = [5]i64;

fn toSigned62(v: u256) Signed62 {
    var out: Signed62 = undefined;
    inline for (0..4) |i| out[i] = @intCast((v >> (62 * i)) & m62);
    out[4] = @intCast(v >> 248);
    return out;
}

fn fromSigned62(v: Signed62) u256 {
    // Normalised limbs: v[0..4] in [0, 2^62), v[4] in [0, 2^8).
    var out: u256 = 0;
    inline for (0..5) |i| out |= @as(u256, @as(u64, @bitCast(v[i]))) << (62 * i);
    return out;
}

const modulus: Signed62 = toSigned62(n);
/// n^-1 mod 2^62 (Newton iteration at comptime).
const modulus_inv62: u64 = blk: {
    const n0: u64 = @truncate(n);
    var inv: u64 = 1;
    for (0..7) |_| inv = inv *% (2 -% n0 *% inv);
    std.debug.assert(n0 *% inv == 1);
    break :blk inv & m62;
};

/// Value barrier: the compiler cannot see through it, so masks derived from
/// secret data stay arithmetic.
inline fn opaque64(x: u64) u64 {
    return asm (""
        : [ret] "=r" (-> u64),
        : [in] "0" (x),
    );
}

const Trans = struct { u: i64, v: i64, q: i64, r: i64 };

/// 59 constant-time divsteps on the low bits of f and g (libsecp256k1
/// secp256k1_modinv64_divsteps_59). zeta = -(delta + 1/2).
fn divsteps59(zeta_in: i64, f0: u64, g0: u64, t: *Trans) i64 {
    var zeta = zeta_in;
    var u: u64 = 8;
    var v: u64 = 0;
    var q: u64 = 0;
    var r: u64 = 8;
    var f = f0;
    var g = g0;
    for (3..62) |_| {
        var mask1 = opaque64(@bitCast(zeta >> 63)); // all ones iff zeta < 0
        const mask2 = opaque64(0 -% (g & 1)); // all ones iff g odd
        const x = (f ^ mask1) -% mask1;
        const y = (u ^ mask1) -% mask1;
        const z = (v ^ mask1) -% mask1;
        g +%= x & mask2;
        q +%= y & mask2;
        r +%= z & mask2;
        mask1 &= mask2;
        zeta = (zeta ^ @as(i64, @bitCast(mask1))) -% 1;
        f +%= g & mask1;
        u +%= q & mask1;
        v +%= r & mask1;
        g >>= 1;
        u <<= 1;
        v <<= 1;
    }
    t.* = .{ .u = @bitCast(u), .v = @bitCast(v), .q = @bitCast(q), .r = @bitCast(r) };
    return zeta;
}

inline fn wide(a: i64, b: i64) i128 {
    return @as(i128, a) *% @as(i128, b);
}

/// [d, e] <- t * [d, e] / 2^62 (mod n), keeping d, e in (-2n, n).
fn updateDe(d: *Signed62, e: *Signed62, t: Trans) void {
    const sd: i64 = d[4] >> 63;
    const se: i64 = e[4] >> 63;
    var md: i64 = (t.u & sd) +% (t.v & se);
    var me: i64 = (t.q & sd) +% (t.r & se);
    var cd: i128 = wide(t.u, d[0]) +% wide(t.v, e[0]);
    var ce: i128 = wide(t.q, d[0]) +% wide(t.r, e[0]);
    // Choose md, me so the low 62 bits of t*[d,e] + n*[md,me] vanish.
    md -%= @bitCast((modulus_inv62 *% @as(u64, @truncate(@as(u128, @bitCast(cd)))) +% @as(u64, @bitCast(md))) & m62);
    me -%= @bitCast((modulus_inv62 *% @as(u64, @truncate(@as(u128, @bitCast(ce)))) +% @as(u64, @bitCast(me))) & m62);
    cd +%= wide(modulus[0], md);
    ce +%= wide(modulus[0], me);
    cd >>= 62;
    ce >>= 62;
    inline for (1..5) |i| {
        cd +%= wide(t.u, d[i]) +% wide(t.v, e[i]) +% wide(modulus[i], md);
        ce +%= wide(t.q, d[i]) +% wide(t.r, e[i]) +% wide(modulus[i], me);
        d[i - 1] = @intCast(@as(u64, @truncate(@as(u128, @bitCast(cd)))) & m62);
        e[i - 1] = @intCast(@as(u64, @truncate(@as(u128, @bitCast(ce)))) & m62);
        cd >>= 62;
        ce >>= 62;
    }
    d[4] = @truncate(cd);
    e[4] = @truncate(ce);
}

/// [f, g] <- t * [f, g] / 2^62 (exact).
fn updateFg(f: *Signed62, g: *Signed62, t: Trans) void {
    var cf: i128 = wide(t.u, f[0]) +% wide(t.v, g[0]);
    var cg: i128 = wide(t.q, f[0]) +% wide(t.r, g[0]);
    cf >>= 62;
    cg >>= 62;
    inline for (1..5) |i| {
        cf +%= wide(t.u, f[i]) +% wide(t.v, g[i]);
        cg +%= wide(t.q, f[i]) +% wide(t.r, g[i]);
        f[i - 1] = @intCast(@as(u64, @truncate(@as(u128, @bitCast(cf)))) & m62);
        g[i - 1] = @intCast(@as(u64, @truncate(@as(u128, @bitCast(cg)))) & m62);
        cf >>= 62;
        cg >>= 62;
    }
    f[4] = @truncate(cf);
    g[4] = @truncate(cg);
}

/// Maps r in (-2n, n) to [0, n), negating first when `sign` < 0.
fn normalize(r: *Signed62, sign: i64) void {
    const m: i64 = @intCast(m62);
    var cond_add: i64 = @bitCast(opaque64(@bitCast(r[4] >> 63)));
    inline for (0..5) |i| r[i] +%= modulus[i] & cond_add;
    const cond_negate: i64 = @bitCast(opaque64(@bitCast(sign >> 63)));
    inline for (0..5) |i| r[i] = (r[i] ^ cond_negate) -% cond_negate;
    inline for (0..4) |i| {
        r[i + 1] +%= r[i] >> 62;
        r[i] &= m;
    }
    cond_add = @bitCast(opaque64(@bitCast(r[4] >> 63)));
    inline for (0..5) |i| r[i] +%= modulus[i] & cond_add;
    inline for (0..4) |i| {
        r[i + 1] +%= r[i] >> 62;
        r[i] &= m;
    }
}

/// a^-1 mod n for canonical a < n; zero maps to zero. Constant time.
pub fn invert(a: u256) u256 {
    var d: Signed62 = .{ 0, 0, 0, 0, 0 };
    var e: Signed62 = .{ 1, 0, 0, 0, 0 };
    var f: Signed62 = modulus;
    var g: Signed62 = toSigned62(a);
    var zeta: i64 = -1;
    for (0..10) |_| {
        var t: Trans = undefined;
        zeta = divsteps59(zeta, @bitCast(f[0]), @bitCast(g[0]), &t);
        updateDe(&d, &e, t);
        updateFg(&f, &g, t);
    }
    normalize(&d, f[4]);
    const result = fromSigned62(d);
    std.crypto.secureZero(i64, &e);
    std.crypto.secureZero(i64, &g);
    std.crypto.secureZero(i64, &d);
    return result;
}

test "safegcd scalar inversion matches std.crypto on edge and random values" {
    const Scalar = std.crypto.ecc.Secp256k1.scalar.Scalar;
    var prng = std.Random.DefaultPrng.init(0x7361666567636421);
    const max64: u256 = std.math.maxInt(u64);
    const edges = [_]u256{ 0, 1, 2, 3, n - 1, n - 2, n - 3, n / 2, n / 2 + 1, 1 << 255, (1 << 128) - 1, 1 << 128, max64, max64 << 192, (1 << 248) - 1, 1 << 248, (1 << 62) - 1, 1 << 62, @as(u256, m62) << 186 };
    for (0..edges.len + 20000) |i| {
        const a: u256 = if (i < edges.len) edges[i] else prng.random().int(u256) % n;
        const expected: u256 = @bitCast((try Scalar.fromBytes(@bitCast(a), .little)).invert().toBytes(.little));
        const got = invert(a);
        try std.testing.expectEqual(expected, got);
        if (a != 0) try std.testing.expectEqual(@as(u512, 1), (@as(u512, a) * got) % n);
    }
    _ = field;
}
