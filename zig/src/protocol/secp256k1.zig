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
pub const field = @import("secp256k1_field.zig");
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
        // Digits stay within [-8, 16]; wrapping ops avoid safety-check branches.
        digit.* +%= carry;
        carry = (digit.* +% 8) >> 4;
        digit.* -%= carry *% 16;
    }
    e[64] = carry;
    return e;
}

/// Constant-time k*G. `k` is a canonical little-endian scalar; zero yields
/// error.IdentityElement like std's `mul`.
pub fn mulBase(k: [32]u8) error{IdentityElement}!Point {
    const q = mulBaseUnchecked(k);
    // Only k = 0 (rejected before signing) yields the identity; this branch
    // depends on no secret for valid nonces and keys.
    if (q.isIdentity()) return error.IdentityElement;
    return q;
}

/// Constant-time core of `mulBase`: fixed loop counts, every comb entry of a
/// row scanned with masked selection, no secret-dependent branch or index.
pub fn mulBaseUnchecked(k: [32]u8) Point {
    var e = signedWindows(k);
    defer std.crypto.secureZero(i8, &e);
    var q = Point.identity;
    for (e, &tables.comb) |digit, *row| {
        const bits: u8 = @bitCast(digit);
        const negative: u1 = @truncate(bits >> 7);
        const magnitude: u8 = (bits ^ (0 -% @as(u8, negative))) +% negative;
        // Scan all eight entries; each is masked in or out, so the memory
        // access pattern and instruction stream are independent of the digit.
        var x: [4]u64 = .{ 0, 0, 0, 0 };
        var y: [4]u64 = .{ 1, 0, 0, 0 }; // affine identity marker (0, 1)
        inline for (row, 1..) |*candidate, j| {
            // 1 iff magnitude == j, computed arithmetically.
            const hit: u1 = @truncate((@as(u16, magnitude ^ @as(u8, j)) -% 1) >> 15);
            const mask = 0 -% field.opaqueMask(hit);
            inline for (0..4) |l| {
                x[l] = (x[l] & ~mask) | (candidate[0][l] & mask);
                y[l] = (y[l] & ~mask) | (candidate[1][l] & mask);
            }
        }
        var selected: Affine = .{ .x = .{ .v = @bitCast(x) }, .y = .{ .v = @bitCast(y) } };
        selected.y.cMov(selected.y.neg(), negative);
        // addMixed returns q unchanged for the affine identity marker.
        q = q.addMixed(selected);
        // The selected entry identifies a secret digit.
        std.crypto.secureZero(u64, &x);
        std.crypto.secureZero(u64, &y);
        std.crypto.secureZero(u8, std.mem.asBytes(&selected));
    }
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

/// GLV half: (magnitude, negated). std's split returns residues mod n; a
/// half is either below 2^128 or n minus a value below 2^128. Anything else
/// would overrun the wNAF digit buffer and is rejected in every build mode.
fn half(r: [32]u8) error{GlvBound}!struct { value: u256, negative: bool } {
    const value = std.mem.readInt(u256, &r, .little);
    if (value < 1 << 128) return .{ .value = value, .negative = false };
    if (value < scalar.field_order and scalar.field_order - value < 1 << 128)
        return .{ .value = scalar.field_order - value, .negative = true };
    return error.GlvBound;
}

/// Odd multiples P, 3P, ..., 15P and their endomorphism images, for width-5
/// wNAF. Build once for a fixed public point (a signer's key) or per call.
pub const OddMultiples = struct {
    odd: [8]Point,
    endo: [8]Point,

    pub fn init(point: Point) OddMultiples {
        var table: OddMultiples = undefined;
        table.odd[0] = point;
        const twice = point.dbl();
        for (1..8) |i| table.odd[i] = table.odd[i - 1].add(twice);
        for (table.odd, &table.endo) |p, *image| image.* = .{ .x = p.x.mul(beta), .y = p.y, .z = p.z };
        return table;
    }
};

/// Variable-time g_scalar*G + sum(scalars[i] * points[i]) for PUBLIC scalars
/// and points (signature recovery and verification). Scalars are canonical
/// little-endian. One shared 128-step doubling chain: the GLV endomorphism
/// halves every scalar, G uses width-8 wNAF over the precomputed table and
/// each point width-5 wNAF over its OddMultiples. May return the identity.
pub fn multiMulPublic(comptime count: usize, g_scalar: [32]u8, points: [count]*const OddMultiples, scalars: [count][32]u8) !Point {
    const Half = @typeInfo(@typeInfo(@TypeOf(half)).@"fn".return_type.?).error_union.payload;
    const g_split = try Endomorphism.splitScalar(g_scalar, .little);
    const g_halves = [2]Half{ try half(g_split.r1), try half(g_split.r2) };
    const g_naf = [2]WnafDigits{ wnaf(8, g_halves[0].value), wnaf(8, g_halves[1].value) };
    var halves: [count][2]Half = undefined;
    var nafs: [count][2]WnafDigits = undefined;
    var top = @max(g_naf[0].len, g_naf[1].len);
    for (scalars, &halves, &nafs) |scalar_bytes, *h, *naf| {
        const split = try Endomorphism.splitScalar(scalar_bytes, .little);
        h.* = .{ try half(split.r1), try half(split.r2) };
        naf.* = .{ wnaf(5, h[0].value), wnaf(5, h[1].value) };
        top = @max(top, @max(naf[0].len, naf[1].len));
    }
    var q = Point.identity;
    var pos = top;
    while (pos > 0) {
        pos -= 1;
        q = q.dbl();
        inline for (0..2) |part| {
            const d = g_naf[part].digits[pos];
            if (d != 0) {
                const g = entry(&tables.odd[@abs(d) >> 1]);
                const term: Affine = if (part == 0) g else .{ .x = g.x.mul(beta), .y = g.y };
                q = q.addMixed(if ((d < 0) != g_halves[part].negative) term.neg() else term);
            }
        }
        inline for (0..count) |i| {
            inline for (0..2) |part| {
                const d = nafs[i][part].digits[pos];
                if (d != 0) {
                    const term = if (part == 0) points[i].odd[@abs(d) >> 1] else points[i].endo[@abs(d) >> 1];
                    q = q.add(if ((d < 0) != halves[i][part].negative) term.neg() else term);
                }
            }
        }
    }
    return q;
}

/// Variable-time u1*G + u2*r for PUBLIC scalars and point (signature
/// recovery). Scalars are canonical little-endian. Returns error.IdentityElement
/// for an identity input point or result.
pub fn mulDoubleBasePublic(g_scalar: [32]u8, r: Point, r_scalar: [32]u8) !Point {
    if (r.isIdentity()) return error.IdentityElement;
    const table = OddMultiples.init(r);
    const q = try multiMulPublic(1, g_scalar, .{&table}, .{r_scalar});
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

test "GLV split halves stay below 2^128 and recombine to the scalar" {
    const n = scalar.field_order;
    const lambda: u256 = 37718080363155996902926221483475020450927657555482586988616620542887997980018;
    var prng = std.Random.DefaultPrng.init(0x676c76);
    const edges = [_]u256{ 0, 1, 2, n - 1, n - 2, n / 2, (n / 2) + 1, lambda, n - lambda, 1 << 128, (1 << 128) - 1, (1 << 255), repeated(0xff) % n, repeated(0x80) };
    for (0..edges.len + 100_000) |i| {
        const k: u256 = if (i < edges.len) edges[i] else prng.random().int(u256) % n;
        const split = try Endomorphism.splitScalar(scalarBytes(k), .little);
        const h1 = try half(split.r1);
        const h2 = try half(split.r2);
        try std.testing.expect(h1.value < 1 << 128 and h2.value < 1 << 128);
        // k = (+-h1) + (+-h2) * lambda (mod n)
        const a1: u512 = if (h1.negative) n - h1.value else h1.value;
        const a2: u512 = if (h2.negative) n - h2.value else h2.value;
        try std.testing.expectEqual(@as(u512, k), (a1 + a2 * lambda) % n);
    }
}

test "GLV half rejects values outside both 128-bit bands" {
    const n = scalar.field_order;
    for ([_]u256{ 1 << 128, (1 << 128) + 1, n - (1 << 128), 1 << 255, n - 1 - (1 << 128), n, std.math.maxInt(u256) }) |v| {
        try std.testing.expectError(error.GlvBound, half(scalarBytes(v)));
    }
    try std.testing.expectEqual(@as(u256, (1 << 128) - 1), (try half(scalarBytes((1 << 128) - 1))).value);
    const negative = try half(scalarBytes(n - ((1 << 128) - 1)));
    try std.testing.expect(negative.negative and negative.value == (1 << 128) - 1);
}
