//! secp256k1 base field and projective points specialised for p = 2^256 - C,
//! C = 2^32 + 977. Products reduce by folding the high half times C instead
//! of generic Montgomery reduction (~3x faster than std's fiat field here).
//!
//! Elements are kept weakly reduced (any value below 2^256, congruent mod p);
//! `canonical` maps to [0, p). Every operation is branch-free in its inputs,
//! so the same code serves constant-time signing. Point formulas are the
//! complete a = 0 formulas of Renes-Costello-Batina (as in std.crypto).
const std = @import("std");

pub const p: u256 = std.math.maxInt(u256) - c + 1;

// Limb views (@bitCast between u256 and [4]u64) assume little-endian order.
comptime {
    if (@import("builtin").cpu.arch.endian() != .little) @compileError("secp256k1_field requires a little-endian target");
}
const c: u256 = 0x1000003D1;

/// Returns `bit` (0 or 1) through an empty asm barrier: the compiler cannot
/// know its value, so selects and carry corrections stay arithmetic instead
/// of being turned into secret-dependent branches.
pub inline fn opaqueMask(bit: u1) u64 {
    return asm (""
        : [ret] "=r" (-> u64),
        : [in] "0" (@as(u64, bit)),
    );
}

/// Full 512-bit product as little-endian limbs (schoolbook, column order).
fn mulWide(a: u256, b: u256) [8]u64 {
    const x: [4]u64 = @bitCast(a);
    const y: [4]u64 = @bitCast(b);
    var t: [8]u64 = undefined;
    var carry: u128 = 0;
    inline for (0..7) |k| {
        var acc: u128 = carry;
        var hi: u64 = 0;
        inline for (0..4) |i| {
            if (k >= i and k - i < 4) {
                const s = @addWithOverflow(acc, @as(u128, x[i]) * y[k - i]);
                acc = s[0];
                hi += s[1];
            }
        }
        t[k] = @truncate(acc);
        carry = (acc >> 64) | (@as(u128, hi) << 64);
    }
    t[7] = @truncate(carry);
    return t;
}

pub const Fe = struct {
    v: u256,

    pub const zero: Fe = .{ .v = 0 };
    pub const one: Fe = .{ .v = 1 };

    /// Big-endian bytes; rejects values >= p.
    pub fn fromBytes(bytes: [32]u8) error{NonCanonical}!Fe {
        const v = std.mem.readInt(u256, &bytes, .big);
        if (v >= p) return error.NonCanonical;
        return .{ .v = v };
    }

    pub fn toBytes(a: Fe) [32]u8 {
        var out: [32]u8 = undefined;
        std.mem.writeInt(u256, &out, a.canonical(), .big);
        return out;
    }

    pub fn canonical(a: Fe) u256 {
        const d = @subWithOverflow(a.v, p);
        // Keep v when v < p (borrow), else v - p. Weak values are < 2^256 < 2p.
        return select(d[1], d[0], a.v);
    }

    pub fn isZero(a: Fe) bool {
        return a.isZeroBit() == 1;
    }

    /// Constant-time zero test: OR-folds the limbs and derives the bit with
    /// arithmetic only, so secret-derived operands never reach a comparison.
    pub fn isZeroBit(a: Fe) u1 {
        const limbs: [4]u64 = @bitCast(a.canonical());
        const any = limbs[0] | limbs[1] | limbs[2] | limbs[3];
        return @truncate(((any | (0 -% any)) >> 63) ^ 1);
    }

    pub fn equivalent(a: Fe, b: Fe) bool {
        return a.canonical() == b.canonical();
    }

    pub fn isOdd(a: Fe) bool {
        return a.canonical() & 1 == 1;
    }

    /// Constant-time: a if bit == 0, b if bit == 1. The mask passes through
    /// an optimisation barrier so LLVM cannot rewrite the select as a branch.
    fn select(bit: u1, a: u256, b: u256) u256 {
        const m = 0 -% opaqueMask(bit);
        const mask: u256 = @bitCast([4]u64{ m, m, m, m });
        return (a & ~mask) | (b & mask);
    }

    pub fn cMov(a: *Fe, b: Fe, bit: u1) void {
        a.v = select(bit, a.v, b.v);
    }

    pub fn add(a: Fe, b: Fe) Fe {
        const s = @addWithOverflow(a.v, b.v);
        // 2^256 = C (mod p). A second carry leaves s2 < C, so s2 + C fits.
        const s2 = @addWithOverflow(s[0], c * opaqueMask(s[1]));
        return .{ .v = s2[0] +% c * opaqueMask(s2[1]) };
    }

    pub fn sub(a: Fe, b: Fe) Fe {
        const d = @subWithOverflow(a.v, b.v);
        // A borrow means d = a - b + 2^256 = a - b + C (mod p): remove C.
        const d2 = @subWithOverflow(d[0], c * opaqueMask(d[1]));
        // A second borrow means d2 >= 2^256 - C, so removing C cannot borrow.
        return .{ .v = d2[0] -% c * opaqueMask(d2[1]) };
    }

    pub fn neg(a: Fe) Fe {
        return zero.sub(a);
    }

    pub fn dbl(a: Fe) Fe {
        return a.add(a);
    }

    pub fn mul(a: Fe, b: Fe) Fe {
        const t = mulWide(a.v, b.v);
        // lo + hi * C: five limbs, top limb below 2^34.
        var r: [4]u64 = undefined;
        var fold: u128 = 0;
        inline for (0..4) |i| {
            fold += @as(u128, t[i]) + @as(u128, t[4 + i]) * @as(u64, @truncate(c));
            r[i] = @truncate(fold);
            fold >>= 64;
        }
        const s = @addWithOverflow(@as(u256, @bitCast(r)), @as(u256, fold) * c);
        // A carry leaves s < 2^67, so adding C cannot carry.
        return .{ .v = s[0] +% c * opaqueMask(s[1]) };
    }

    pub fn sq(a: Fe) Fe {
        return a.mul(a);
    }

    fn sqn(a: Fe, comptime n: usize) Fe {
        var r = a;
        for (0..n) |_| r = r.sq();
        return r;
    }

    /// a^(2^223 - 1) chain shared by inversion and square root (libsecp256k1).
    fn pow223(a: Fe, x2_out: *Fe, x22_out: *Fe) Fe {
        const x2 = a.sq().mul(a);
        const x3 = x2.sq().mul(a);
        const x6 = x3.sqn(3).mul(x3);
        const x9 = x6.sqn(3).mul(x3);
        const x11 = x9.sqn(2).mul(x2);
        const x22 = x11.sqn(11).mul(x11);
        const x44 = x22.sqn(22).mul(x22);
        const x88 = x44.sqn(44).mul(x44);
        const x176 = x88.sqn(88).mul(x88);
        const x220 = x176.sqn(44).mul(x44);
        x2_out.* = x2;
        x22_out.* = x22;
        return x220.sqn(3).mul(x3);
    }

    /// a^(p-2); zero maps to zero. Constant time.
    pub fn invert(a: Fe) Fe {
        var x2: Fe = undefined;
        var x22: Fe = undefined;
        const x223 = a.pow223(&x2, &x22);
        return x223.sqn(23).mul(x22).sqn(5).mul(a).sqn(3).mul(x2).sqn(2).mul(a);
    }

    /// Square root a^((p+1)/4), checked.
    pub fn sqrt(a: Fe) error{NotSquare}!Fe {
        var x2: Fe = undefined;
        var x22: Fe = undefined;
        const x223 = a.pow223(&x2, &x22);
        const r = x223.sqn(23).mul(x22).sqn(6).mul(x2).sqn(2);
        if (!r.sq().equivalent(a)) return error.NotSquare;
        return r;
    }
};

/// Projective point (X : Y : Z); identity is (0 : 1 : 0).
pub const Point = struct {
    x: Fe,
    y: Fe,
    z: Fe,

    pub const identity: Point = .{ .x = Fe.zero, .y = Fe.one, .z = Fe.zero };

    pub const Affine = struct {
        x: Fe,
        y: Fe,
        /// Affine identity marker (x = 0 is not on the curve: 7 is not a square).
        pub const identity: Affine = .{ .x = Fe.zero, .y = Fe.one };

        pub fn neg(q: Affine) Affine {
            return .{ .x = q.x, .y = q.y.neg() };
        }
    };

    pub fn fromAffine(q: Affine) Point {
        return .{ .x = q.x, .y = q.y, .z = Fe.one };
    }

    /// Decompress an x coordinate with the given y parity.
    pub fn fromX(x: Fe, odd: bool) error{NotSquare}!Point {
        var y = try x.sq().mul(x).add(.{ .v = 7 }).sqrt();
        if (y.isOdd() != odd) y = y.neg();
        return .{ .x = x, .y = y, .z = Fe.one };
    }

    pub fn isIdentity(q: Point) bool {
        return q.z.isZero();
    }

    pub fn neg(q: Point) Point {
        return .{ .x = q.x, .y = q.y.neg(), .z = q.z };
    }

    fn mul21(t: Fe) Fe {
        const t4 = t.dbl().dbl();
        return t4.dbl().dbl().add(t4).add(t);
    }

    /// Algorithm 9, eprint 2015/1060.
    pub fn dbl(q: Point) Point {
        var t0 = q.y.sq();
        var z3 = t0.dbl().dbl().dbl();
        var t1 = q.y.mul(q.z);
        var t2 = mul21(q.z.sq());
        var x3 = t2.mul(z3);
        var y3 = t0.add(t2);
        z3 = t1.mul(z3);
        t1 = t2.dbl();
        t2 = t1.add(t2);
        t0 = t0.sub(t2);
        y3 = t0.mul(y3);
        y3 = x3.add(y3);
        t1 = q.x.mul(q.y);
        x3 = t0.mul(t1);
        x3 = x3.dbl();
        return .{ .x = x3, .y = y3, .z = z3 };
    }

    /// Algorithm 7, eprint 2015/1060 (complete).
    pub fn add(a: Point, b: Point) Point {
        var t0 = a.x.mul(b.x);
        var t1 = a.y.mul(b.y);
        var t2 = a.z.mul(b.z);
        var t3 = a.x.add(a.y);
        var t4 = b.x.add(b.y);
        t3 = t3.mul(t4);
        t4 = t0.add(t1);
        t3 = t3.sub(t4);
        t4 = a.y.add(a.z);
        var x3 = b.y.add(b.z);
        t4 = t4.mul(x3);
        x3 = t1.add(t2);
        t4 = t4.sub(x3);
        x3 = a.x.add(a.z);
        var y3 = b.x.add(b.z);
        x3 = x3.mul(y3);
        y3 = t0.add(t2);
        y3 = x3.sub(y3);
        x3 = t0.dbl();
        t0 = x3.add(t0);
        t2 = mul21(t2);
        var z3 = t1.add(t2);
        t1 = t1.sub(t2);
        y3 = mul21(y3);
        x3 = t4.mul(y3);
        t2 = t3.mul(t1);
        x3 = t2.sub(x3);
        y3 = y3.mul(t0);
        t1 = t1.mul(z3);
        y3 = t1.add(y3);
        t0 = t0.mul(t3);
        z3 = z3.mul(t4);
        z3 = z3.add(t0);
        return .{ .x = x3, .y = y3, .z = z3 };
    }

    /// Algorithm 8, eprint 2015/1060; `b` may be the affine identity marker.
    pub fn addMixed(a: Point, b: Affine) Point {
        var t0 = a.x.mul(b.x);
        var t1 = a.y.mul(b.y);
        var t3 = b.x.add(b.y);
        var t4 = a.x.add(a.y);
        t3 = t3.mul(t4);
        t4 = t0.add(t1);
        t3 = t3.sub(t4);
        t4 = b.y.mul(a.z);
        t4 = t4.add(a.y);
        var y3 = b.x.mul(a.z);
        y3 = y3.add(a.x);
        var x3 = t0.dbl();
        t0 = x3.add(t0);
        var t2 = mul21(a.z);
        var z3 = t1.add(t2);
        t1 = t1.sub(t2);
        y3 = mul21(y3);
        x3 = t4.mul(y3);
        t2 = t3.mul(t1);
        x3 = t2.sub(x3);
        y3 = y3.mul(t0);
        t1 = t1.mul(z3);
        y3 = t1.add(y3);
        t0 = t0.mul(t3);
        z3 = z3.mul(t4);
        z3 = z3.add(t0);
        var r: Point = .{ .x = x3, .y = y3, .z = z3 };
        const is_identity = b.x.isZeroBit();
        r.x.cMov(a.x, is_identity);
        r.y.cMov(a.y, is_identity);
        r.z.cMov(a.z, is_identity);
        return r;
    }

    /// Affine coordinates; error for the identity.
    pub fn affine(q: Point) error{IdentityElement}!Affine {
        if (q.isIdentity()) return error.IdentityElement;
        const zinv = q.z.invert();
        return .{ .x = q.x.mul(zinv), .y = q.y.mul(zinv) };
    }
};

test "field arithmetic matches big-integer reference" {
    var prng = std.Random.DefaultPrng.init(0x6665);
    const random = prng.random();
    const max = std.math.maxInt(u256);
    const max64: u256 = std.math.maxInt(u64);
    const edges = [_]u256{
        0,                       1,                         2,                            c - 1,                       c,                             c + 1,
        2 * c,                   p - 2,                     p - 1,                        p,                           p + 1,                         max - 2,
        max - 1,                 max,                       1 << 255,                     (1 << 255) - 1,              max64,                         (1 << 128) - 1,
        (1 << 192) - 1,          max - max64,               max64 | (max64 << 128),       (max64 << 64) | (max64 << 192), (1 << 64),                   (1 << 128),
        (1 << 192),              p - (1 << 32),             max - (1 << 128) + 1,         (p - 1) / 2,
    };
    const P: u512 = p;
    for (0..edges.len * edges.len + 4000) |i| {
        const a: u256 = if (i < edges.len * edges.len) edges[i % edges.len] else random.int(u256);
        const b: u256 = if (i < edges.len * edges.len) edges[i / edges.len] else random.int(u256);
        const fa: Fe = .{ .v = a };
        const fb: Fe = .{ .v = b };
        try std.testing.expectEqual(@as(u512, (@as(u512, a) * b) % P), fa.mul(fb).canonical());
        try std.testing.expectEqual(@as(u512, (@as(u512, a) + b) % P), fa.add(fb).canonical());
        try std.testing.expectEqual(@as(u512, (@as(u512, a) % P + P - @as(u512, b) % P) % P), fa.sub(fb).canonical());
        try std.testing.expectEqual(@as(u512, a % P), fa.canonical());
        if (a % P != 0) try std.testing.expect(fa.mul(fa.invert()).equivalent(Fe.one));
        const square = fa.sq();
        const root = try square.sqrt();
        try std.testing.expect(root.sq().equivalent(square));
    }
    try std.testing.expect(Fe.zero.invert().isZero());
    try std.testing.expectError(error.NotSquare, (Fe{ .v = 7 }).sqrt());
}

test "points match std secp256k1 arithmetic" {
    const Std = std.crypto.ecc.Secp256k1;
    const toStd = struct {
        fn f(q: Point) !Std {
            const a = try q.affine();
            var sec1: [65]u8 = undefined;
            sec1[0] = 4;
            sec1[1..33].* = a.x.toBytes();
            sec1[33..65].* = a.y.toBytes();
            return Std.fromSec1(&sec1);
        }
    }.f;
    const g_std = Std.basePoint.affineCoordinates();
    const g = Point.fromAffine(.{ .x = try Fe.fromBytes(g_std.x.toBytes(.big)), .y = try Fe.fromBytes(g_std.y.toBytes(.big)) });
    var mine = g;
    var reference = Std.basePoint;
    for (0..64) |_| {
        try std.testing.expect((try toStd(mine)).equivalent(reference));
        try std.testing.expect((try toStd(mine.dbl())).equivalent(reference.dbl()));
        try std.testing.expect((try toStd(mine.add(g))).equivalent(reference.add(Std.basePoint)));
        try std.testing.expect((try toStd(mine.addMixed(try g.affine()))).equivalent(reference.add(Std.basePoint)));
        // Complete formulas: doubling through add and cancellation to identity.
        try std.testing.expect((try toStd(mine.add(mine))).equivalent(reference.dbl()));
        try std.testing.expect(mine.add(mine.neg()).isIdentity());
        try std.testing.expect(mine.addMixed((try mine.affine()).neg()).isIdentity());
        mine = mine.add(mine.dbl());
        reference = reference.add(reference.dbl());
    }
    try std.testing.expect(Point.identity.addMixed(Point.Affine.identity).isIdentity());
    try std.testing.expect((try toStd(Point.identity.addMixed(try g.affine()))).equivalent(Std.basePoint));
    const decompressed = try Point.fromX(try Fe.fromBytes(g_std.x.toBytes(.big)), g_std.y.isOdd());
    try std.testing.expect((try toStd(decompressed)).equivalent(Std.basePoint));
}
