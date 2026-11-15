//! secp256k1 scalar multiplications for signing and recovery on the
//! specialised field in secp256k1_field.zig; scalar arithmetic and the GLV
//! split come from std.crypto.
//!
//! - `mulBase`: constant-time k*G from a precomputed comb of affine multiples
//!   (65 mixed additions, no doublings) instead of std's 252 doublings plus 64
//!   table additions.
//! - `mulDoubleBasePublic`: variable-time u1*G + u2*R for public recovery
//!   inputs, using the GLV endomorphism (lambda*(x, y) = (beta*x, y)) to halve
//!   the doubling chain, width-5 wNAF for R and width-8 wNAF over a
//!   precomputed odd-multiple table for G.
const std = @import("std");
const field = @import("secp256k1_field.zig");
const tables = @import("secp256k1_tables.zig");
const scalar = std.crypto.ecc.Secp256k1.scalar;
const Endomorphism = std.crypto.ecc.Secp256k1.Endormorphism;

pub const Fe = field.Fe;
pub const Point = field.Point;
pub const Affine = Point.Affine;

const beta: Fe = .{ .v = 55594575648329892869085402983802832744385952214688224221778511981742606582254 };

fn entry(e: *const tables.Entry) Affine {
    return .{ .x = .{ .v = @bitCast(e[0]) }, .y = .{ .v = @bitCast(e[1]) } };
}

/// Signed 4-bit windows: digits in [-8, 8], 65 of them for a canonical scalar.
/// Branch-free arithmetic, so safe for secret scalars.
fn signedWindows(s: [32]u8) [65]i8 {
    var e: [65]i8 = undefined;
    for (s, 0..) |byte, i| {
        e[2 * i] = @as(i8, @as(u4, @truncate(byte)));
        e[2 * i + 1] = @as(i8, @as(u4, @truncate(byte >> 4)));
    }
    var carry: i8 = 0;
    for (e[0..64]) |*digit| {
        digit.* += carry;
        carry = (digit.* + 8) >> 4;
        digit.* -= carry * 16;
    }
    e[64] = carry;
    return e;
}

/// Constant-time k*G. `k` is a canonical little-endian scalar; zero yields
/// error.IdentityElement like std's `mul`.
pub fn mulBase(k: [32]u8) error{IdentityElement}!Point {
    const e = signedWindows(k);
    var q = Point.identity;
    for (e, &tables.comb) |digit, *row| {
        const bits: u8 = @bitCast(digit);
        const negative: u1 = @truncate(bits >> 7);
        const magnitude: u8 = (bits ^ (0 -% @as(u8, negative))) +% negative;
        var selected = Affine.identity;
        inline for (row, 1..) |*candidate, j| {
            // 1 iff magnitude == j, without branching on the secret digit.
            const hit: u1 = @truncate((@as(u16, magnitude ^ @as(u8, j)) -% 1) >> 15);
            const value = entry(candidate);
            selected.x.cMov(value.x, hit);
            selected.y.cMov(value.y, hit);
        }
        selected.y.cMov(selected.y.neg(), negative);
        // addMixed returns q unchanged for the affine identity marker.
        q = q.addMixed(selected);
    }
    if (q.isIdentity()) return error.IdentityElement;
    return q;
}

const WnafDigits = struct { digits: [132]i8 = @splat(0), len: usize = 0 };

/// Variable-time width-w NAF of a (public) value below 2^130.
fn wnaf(comptime w: u4, value: u256) WnafDigits {
    var out: WnafDigits = .{};
    var k = value;
    var i: usize = 0;
    while (k != 0) : (i += 1) {
        if (k & 1 == 1) {
            var digit: i16 = @intCast(k & ((1 << w) - 1));
            if (digit >= 1 << (w - 1)) digit -= 1 << w;
            out.digits[i] = @intCast(digit);
            if (digit > 0) k -= @intCast(digit) else k += @intCast(-digit);
        }
        k >>= 1;
    }
    out.len = i;
    return out;
}

/// GLV half: (magnitude, negated). std's split returns residues mod n; values
/// with a nonzero upper half are negative and are negated back below 2^128.
fn half(r: [32]u8) struct { value: u256, negative: bool } {
    if (r[16] == 0) return .{ .value = std.mem.readInt(u256, &r, .little), .negative = false };
    const negated = scalar.neg(r, .little) catch unreachable;
    std.debug.assert(negated[16] == 0);
    return .{ .value = std.mem.readInt(u256, &negated, .little), .negative = true };
}

/// Variable-time u1*G + u2*r for PUBLIC scalars and point (signature
/// recovery). Scalars are canonical little-endian. Returns error.IdentityElement
/// for an identity input point or result.
pub fn mulDoubleBasePublic(g_scalar: [32]u8, r: Point, r_scalar: [32]u8) !Point {
    if (r.isIdentity()) return error.IdentityElement;
    const split1 = try Endomorphism.splitScalar(g_scalar, .little);
    const split2 = try Endomorphism.splitScalar(r_scalar, .little);
    const g1 = half(split1.r1);
    const g2 = half(split1.r2);
    const p1 = half(split2.r1);
    const p2 = half(split2.r2);
    const ng1 = wnaf(8, g1.value);
    const ng2 = wnaf(8, g2.value);
    const np1 = wnaf(5, p1.value);
    const np2 = wnaf(5, p2.value);

    // Odd multiples r, 3r, ..., 15r and their endomorphism images.
    var odd_r: [8]Point = undefined;
    odd_r[0] = r;
    const r2 = r.dbl();
    for (1..8) |i| odd_r[i] = odd_r[i - 1].add(r2);
    var odd_lr: [8]Point = undefined;
    for (odd_r, &odd_lr) |point, *image| image.* = .{ .x = point.x.mul(beta), .y = point.y, .z = point.z };

    var q = Point.identity;
    var pos = @max(@max(ng1.len, ng2.len), @max(np1.len, np2.len));
    while (pos > 0) {
        pos -= 1;
        q = q.dbl();
        if (ng1.digits[pos] != 0) {
            const d = ng1.digits[pos];
            const g = entry(&tables.odd[@abs(d) >> 1]);
            q = q.addMixed(if ((d < 0) != g1.negative) g.neg() else g);
        }
        if (ng2.digits[pos] != 0) {
            const d = ng2.digits[pos];
            const g = entry(&tables.odd[@abs(d) >> 1]);
            const image: Affine = .{ .x = g.x.mul(beta), .y = g.y };
            q = q.addMixed(if ((d < 0) != g2.negative) image.neg() else image);
        }
        if (np1.digits[pos] != 0) {
            const d = np1.digits[pos];
            const point = odd_r[@abs(d) >> 1];
            q = q.add(if ((d < 0) != p1.negative) point.neg() else point);
        }
        if (np2.digits[pos] != 0) {
            const d = np2.digits[pos];
            const point = odd_lr[@abs(d) >> 1];
            q = q.add(if ((d < 0) != p2.negative) point.neg() else point);
        }
    }
    if (q.isIdentity()) return error.IdentityElement;
    return q;
}

const Std = std.crypto.ecc.Secp256k1;

fn scalarBytes(v: u256) [32]u8 {
    var out: [32]u8 = undefined;
    std.mem.writeInt(u256, &out, v, .little);
    return out;
}

/// The byte repeated across all 32 bytes (every signed window at one extreme).
fn repeated(comptime byte: u8) u256 {
    return @as(u256, byte) * (std.math.maxInt(u256) / 0xff);
}

fn sameAsStd(mine: Point, reference: Std) !bool {
    const a = try mine.affine();
    const b = reference.affineCoordinates();
    return std.mem.eql(u8, &a.x.toBytes(), &b.x.toBytes(.big)) and std.mem.eql(u8, &a.y.toBytes(), &b.y.toBytes(.big));
}

fn fromStd(reference: Std) !Point {
    const a = reference.affineCoordinates();
    return Point.fromAffine(.{ .x = try Fe.fromBytes(a.x.toBytes(.big)), .y = try Fe.fromBytes(a.y.toBytes(.big)) });
}

test "generator tables match std arithmetic" {
    var base = Std.basePoint;
    for (&tables.comb) |*row| {
        var acc = Std.identityElement;
        for (row) |*e| {
            acc = acc.add(base);
            try std.testing.expect(try sameAsStd(Point.fromAffine(entry(e)), acc));
        }
        base = base.dbl().dbl().dbl().dbl();
    }
    const two_g = Std.basePoint.dbl();
    var acc = Std.basePoint;
    for (&tables.odd) |*e| {
        try std.testing.expect(try sameAsStd(Point.fromAffine(entry(e)), acc));
        acc = acc.add(two_g);
    }
}

test "mulBase matches std base multiplication" {
    var prng = std.Random.DefaultPrng.init(0x6d756c62);
    const n = scalar.field_order;
    const edges = [_]u256{ 1, 2, 7, 8, 9, 15, 16, 17, n - 1, n - 2, n / 2, (n / 2) + 1, repeated(0x88), repeated(0x77), 1 << 255 };
    for (0..300 + edges.len) |i| {
        const k: u256 = if (i < edges.len) edges[i] else prng.random().int(u256) % n;
        if (k == 0) continue;
        const bytes = scalarBytes(k);
        try std.testing.expect(try sameAsStd(try mulBase(bytes), try Std.basePoint.mul(bytes, .little)));
    }
    try std.testing.expectError(error.IdentityElement, mulBase(scalarBytes(0)));
}

test "mulDoubleBasePublic matches std double-base multiplication" {
    var prng = std.Random.DefaultPrng.init(0x64626d75);
    const n = scalar.field_order;
    const edges = [_]u256{ 1, 2, n - 1, n / 2, 1 << 128, (1 << 128) - 1 };
    for (0..200) |i| {
        const ug: u256 = if (i < edges.len) edges[i] else prng.random().int(u256) % n;
        const ur: u256 = if (i < edges.len) edges[edges.len - 1 - i] else prng.random().int(u256) % n;
        const reference_point = try Std.basePoint.mul(scalarBytes(prng.random().int(u256) % (n - 1) + 1), .little);
        const point = try fromStd(reference_point);
        const expected = Std.mulDoubleBasePublic(Std.basePoint, scalarBytes(ug), reference_point, scalarBytes(ur), .little) catch {
            try std.testing.expectError(error.IdentityElement, mulDoubleBasePublic(scalarBytes(ug), point, scalarBytes(ur)));
            continue;
        };
        try std.testing.expect(try sameAsStd(try mulDoubleBasePublic(scalarBytes(ug), point, scalarBytes(ur)), expected));
    }
    // ug*G + ur*(cG) is the identity when ug = -ur*c.
    const c: u256 = 12345;
    const point = try mulBase(scalarBytes(c));
    const ur: u256 = 777;
    const ug = n - (ur * c) % n;
    try std.testing.expectError(error.IdentityElement, mulDoubleBasePublic(scalarBytes(ug), point, scalarBytes(ur)));
    try std.testing.expectError(error.IdentityElement, mulDoubleBasePublic(scalarBytes(1), Point.identity, scalarBytes(1)));
}
