const std = @import("std");
const Curve = std.crypto.ecc.Secp256k1;
const Scalar = Curve.scalar.Scalar;
const secp256k1 = @import("secp256k1.zig");
const reference = @import("secp256k1_reference.zig");
const Hash = [32]u8;
pub const Address = [20]u8;
pub const Signature = [65]u8;

fn reducedHash(digest: Hash) Scalar {
    var wide: [48]u8 = .{0} ** 48;
    wide[16..48].* = digest;
    return Scalar.fromBytes48(wide, .big);
}

fn addressOfCoordinates(x: [32]u8, y: [32]u8) Address {
    const hash = @import("keccak.zig").keccak256(&(x ++ y));
    return hash[12..32].*;
}

fn address(point: secp256k1.Point) !Address {
    const affine = try point.affine();
    return addressOfCoordinates(affine.x.toBytes(), affine.y.toBytes());
}

pub fn secretKeyAddress(secret_key: Hash) !Address {
    var scalar = try Scalar.fromBytes(secret_key, .big);
    defer std.crypto.secureZero(u8, std.mem.asBytes(&scalar));
    if (scalar.isZero()) return error.InvalidSecretKey;
    var little = scalar.toBytes(.little);
    defer std.crypto.secureZero(u8, &little);
    return try address(try secp256k1.mulBase(little));
}

/// Security boundary: Ethereum's v=27/28, nonzero canonical r and low-s only.
/// ECDSA recovery uses Q=r^-1(sR-zG); scalar arithmetic comes from Zig
/// std.crypto, field/point arithmetic and the GLV/wNAF joint multiplication
/// from secp256k1.zig.
/// This is public-input variable-time verification, never secret scalar
/// multiplication. Transaction chain-ID recovery values are rejected.
pub fn recover(digest: Hash, signature: Signature) !Address {
    if (signature[64] != 27 and signature[64] != 28) return error.InvalidRecoveryId;
    const r = try Scalar.fromBytes(signature[0..32].*, .big);
    const s = try Scalar.fromBytes(signature[32..64].*, .big);
    if (r.isZero() or s.isZero()) return error.InvalidSignature;
    if (std.mem.readInt(u256, signature[32..64], .big) > Curve.scalar.field_order / 2)
        return error.HighSignatureS;
    // r < n < p, so r is always a canonical x coordinate.
    const point_r = try secp256k1.Point.fromX(try secp256k1.Fe.fromBytes(signature[0..32].*), signature[64] == 28);
    const z = reducedHash(digest);
    // Q = (-z/r)G + (s/r)R. Both scalars are public signature/digest data.
    const inverse_r = r.invert();
    const public_key = try secp256k1.mulDoubleBasePublic(z.mul(inverse_r).neg().toBytes(.little), point_r, s.mul(inverse_r).toBytes(.little));
    return address(public_key);
}

/// Matches the production ethers-core Signature::recover acceptance policy.
/// Keep separate from strict onchain metadata verification: ethers accepts high
/// s and transaction-style recovery values that Solidity ECDSA rejects.
pub fn recoverCompatible(digest: Hash, r: Hash, s: Hash, v: u64) !Address {
    const parity: u8 = switch (v) {
        0, 1 => @intCast(v),
        27, 28 => @intCast(v - 27),
        35...std.math.maxInt(u64) => @intCast((v - 35) % 2),
        else => return error.InvalidRecoveryId,
    };
    var signature: Signature = undefined;
    signature[0..32].* = r;
    signature[32..64].* = s;
    signature[64] = parity + 27;
    const scalar_s = try Scalar.fromBytes(s, .big);
    if (std.mem.readInt(u256, &s, .big) > Curve.scalar.field_order / 2) {
        signature[32..64].* = scalar_s.neg().toBytes(.big);
        signature[64] = (parity ^ 1) + 27;
    }
    return recover(digest, signature);
}

/// A local secp256k1 signing identity. The public key Q = d*G (and its wNAF
/// table) is derived once here; it is the signer's identity, used to verify
/// every signature before release.
pub const SigningKey = struct {
    secret: Hash,
    public_key: secp256k1.Affine,
    public_table: secp256k1.WideTable,
    address: Address,

    pub fn init(secret_key: Hash) !SigningKey {
        var d = try Scalar.fromBytes(secret_key, .big);
        defer std.crypto.secureZero(u8, std.mem.asBytes(&d));
        if (d.isZero()) return error.InvalidSecretKey;
        var little = d.toBytes(.little);
        defer std.crypto.secureZero(u8, &little);
        const q = try secp256k1.mulBase(little);
        const affine = try q.affine();
        return .{
            .secret = secret_key,
            .public_key = affine,
            .public_table = secp256k1.WideTable.init(secp256k1.Point.fromAffine(affine)),
            .address = addressOfCoordinates(affine.x.toBytes(), affine.y.toBytes()),
        };
    }

    pub fn deinit(self: *SigningKey) void {
        std.crypto.secureZero(u8, &self.secret);
    }

    /// SEC1 compressed public key.
    pub fn compressedPublicKey(self: *const SigningKey) [33]u8 {
        var out: [33]u8 = undefined;
        out[0] = 2 + @as(u8, @intFromBool(self.public_key.y.isOdd()));
        out[1..33].* = self.public_key.x.toBytes();
        return out;
    }

    /// EIP-191 wrapping must happen before calling this function. Optional
    /// fault-hardening noise is supplied by the caller; no global RNG is
    /// consulted. Null noise produces a deterministic signature.
    ///
    /// Byte-identical to std's EcdsaSecp256k1Sha256.signPrehashed followed by
    /// low-s normalisation; the recovery id comes from R.y parity (flipped
    /// when s is negated).
    ///
    /// Fault-attack countermeasure: with deterministic nonces one faulted
    /// signature can reveal the key, so every signature is verified against
    /// this key's Q (see `verifyBeforeRelease`) and never returned otherwise.
    pub fn sign(self: *const SigningKey, digest: Hash, noise: ?[32]u8) !Signature {
        const signed = try signCore(self.secret, digest, noise);
        try verifyBeforeRelease(self, digest, signed.signature, signed.r_point);
        return signed.signature;
    }
};

/// Convenience for one-off signing: derives the key (one extra d*G) per call.
/// Long-lived signers should hold a SigningKey.
pub fn signDigest(secret_key: Hash, digest: Hash, noise: ?[32]u8) !Signature {
    var key = try SigningKey.init(secret_key);
    defer key.deinit();
    return key.sign(digest, noise);
}

/// Signing without the fault self-check, for benchmark attribution only. It
/// exists only when the executable root declares
/// `kernel_bench_unverified_signing` (zig/bench/main.zig,
/// zig/src/crypto_bench.zig); in any other build, including the agents, using
/// it is a compile error.
pub const benchmark = if (@hasDecl(@import("root"), "kernel_bench_unverified_signing")) struct {
    pub fn signWithoutFaultCheck(secret_key: Hash, digest: Hash, noise: ?[32]u8) !Signature {
        return (try signCore(secret_key, digest, noise)).signature;
    }
} else struct {};

const Signed = struct { signature: Signature, r_point: secp256k1.Affine };

fn signCore(secret_key: Hash, digest: Hash, noise: ?[32]u8) !Signed {
    // Secret intermediates (d, k, k bytes, k^-1, z + r*d) are wiped on return.
    var d = try Scalar.fromBytes(secret_key, .big);
    defer std.crypto.secureZero(u8, std.mem.asBytes(&d));
    if (d.isZero()) return error.InvalidSecretKey;
    const z = reducedHash(digest);
    var k = deterministicNonce(digest, secret_key, noise);
    defer std.crypto.secureZero(u8, std.mem.asBytes(&k));
    var k_bytes = k.toBytes(.little);
    defer std.crypto.secureZero(u8, &k_bytes);
    const point = try (try secp256k1.mulBase(k_bytes)).affine();
    const x = point.x.toBytes();
    // Ethereum v=27/28 cannot encode the exceedingly rare x>=curve order case.
    // Fail closed; caller may retry with fresh signing noise.
    if (std.mem.readInt(u256, &x, .big) >= Curve.scalar.field_order) return error.UnrepresentableRecoveryId;
    const r = try Scalar.fromBytes(x, .big);
    if (r.isZero()) return error.IdentityElement;
    // Constant-time safegcd inversion (secp256k1_scalar.zig).
    var k_inverse = try Scalar.fromBytes(@bitCast(@import("secp256k1_scalar.zig").invert(@bitCast(k_bytes))), .little);
    defer std.crypto.secureZero(u8, std.mem.asBytes(&k_inverse));
    var t = z.add(r.mul(d));
    defer std.crypto.secureZero(u8, std.mem.asBytes(&t));
    var s = k_inverse.mul(t);
    if (s.isZero()) return error.IdentityElement;
    var parity: u8 = @intFromBool(point.y.isOdd());
    var s_bytes = s.toBytes(.big);
    if (std.mem.readInt(u256, &s_bytes, .big) > Curve.scalar.field_order / 2) {
        s = s.neg();
        s_bytes = s.toBytes(.big);
        parity ^= 1;
    }
    var signature: Signature = undefined;
    signature[0..32].* = x;
    signature[32..64].* = s_bytes;
    signature[64] = 27 + parity;
    return .{ .signature = signature, .r_point = point };
}

/// Verifies the serialized (r, s, v) against the key's true Q, using the R
/// computed while signing and no inversion: x(R) must equal r, R' (R with
/// the y parity v names) must be R or -R, and s*R' == z*G + r*Q, checked as
/// z*G + r*Q + (n - s)*R' == identity with one shared GLV/wNAF chain. This
/// catches faults in d, k, k*G, s and serialization. Only public values
/// enter the variable-time multiplication.
fn verifyBeforeRelease(key: *const SigningKey, digest: Hash, signature: Signature, r_point: secp256k1.Affine) error{SignatureSelfCheckFailed}!void {
    const fail = error.SignatureSelfCheckFailed;
    if (!std.mem.eql(u8, &r_point.x.toBytes(), signature[0..32])) return fail;
    if (signature[64] != 27 and signature[64] != 28) return fail;
    const r = Scalar.fromBytes(signature[0..32].*, .big) catch return fail;
    const s = Scalar.fromBytes(signature[32..64].*, .big) catch return fail;
    if (r.isZero() or s.isZero()) return fail;
    const odd = signature[64] == 28;
    const named: secp256k1.Affine = if (r_point.y.isOdd() == odd) r_point else r_point.neg();
    const r_table = secp256k1.OddMultiples.init(secp256k1.Point.fromAffine(named));
    const z = reducedHash(digest);
    const sum = secp256k1.multiMulPublicFixed(1, .{.{ .table = &key.public_table, .scalar = r.toBytes(.little) }}, 1, z.toBytes(.little), .{&r_table}, .{s.neg().toBytes(.little)}) catch return fail;
    if (!sum.isIdentity()) return fail;
}

/// std.crypto.sign.ecdsa deterministicScalar for secp256k1/HMAC-SHA256: the
/// RFC6979-with-additional-randomness construction, replicated exactly so
/// signatures remain byte-identical to the std signer.
fn deterministicNonce(h: Hash, secret_key: Hash, noise: ?[32]u8) Scalar {
    const Prf = std.crypto.auth.hmac.sha2.HmacSha256;
    // HMAC key/state and the message buffer (which holds the secret key) are
    // wiped on return; the returned scalar is wiped by the caller.
    var k: [32]u8 = .{0} ** 32;
    defer std.crypto.secureZero(u8, &k);
    var m: [32 + 1 + 32 + 32 + 32]u8 = .{0} ** (32 + 1 + 32 + 32 + 32);
    defer std.crypto.secureZero(u8, &m);
    const m_v = m[0..32];
    const m_i = &m[32];
    @memset(m_v, 0x01);
    if (noise) |n| m[33..65].* = n;
    m[65..97].* = secret_key;
    m[97..129].* = h;
    Prf.create(&k, &m, &k);
    Prf.create(m_v, m_v, &k);
    m_i.* = 0x01;
    Prf.create(&k, &m, &k);
    Prf.create(m_v, m_v, &k);
    while (true) {
        Prf.create(m_v, m_v, &k);
        if (Scalar.fromBytes(m_v.*, .big)) |scalar| return scalar else |_| {}
        m_i.* = 0x00;
        Prf.create(&k, m[0..33], &k);
        Prf.create(m_v, m_v, &k);
    }
}

/// Ordered validator-subsequence verification matches AbstractMultisigISM:
/// recovered signers must appear in strictly increasing validator positions.
/// Exact threshold signatures prevent trailing unused metadata ambiguity.
pub fn verifyQuorum(digest: Hash, signatures: []const u8, validators: []const Address, threshold: usize) !void {
    if (threshold == 0 or threshold > validators.len) return error.InvalidThreshold;
    if (signatures.len % 65 != 0 or signatures.len / 65 != threshold) return error.InvalidSignatureCount;
    // Duplicate validator entries could otherwise satisfy a threshold twice.
    for (validators, 0..) |validator, i| {
        for (validators[0..i]) |previous| {
            if (std.mem.eql(u8, &validator, &previous)) return error.DuplicateValidator;
        }
    }
    var next_validator: usize = 0;
    for (0..threshold) |i| {
        const signer = try recover(digest, signatures[i * 65 ..][0..65].*);
        while (next_validator < validators.len and !std.mem.eql(u8, &signer, &validators[next_validator]))
            next_validator += 1;
        if (next_validator == validators.len) return error.InvalidSignerOrder;
        next_validator += 1;
    }
}

test "known key address and deterministic canonical sign/recover" {
    const key = [_]u8{0x11} ** 32;
    var expected: Address = undefined;
    _ = try std.fmt.hexToBytes(&expected, "19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");
    try std.testing.expectEqualSlices(u8, &expected, &try secretKeyAddress(key));
    for ([_]Hash{ .{0x22} ** 32, .{0} ** 32, .{255} ** 32 }) |digest| {
        const signature = try signDigest(key, digest, null);
        try std.testing.expectEqualSlices(u8, &expected, &try recover(digest, signature));
        try std.testing.expectEqualSlices(u8, &signature, &try signDigest(key, digest, null));
        try std.testing.expect(std.mem.readInt(u256, signature[32..64], .big) <= Curve.scalar.field_order / 2);
    }
}

test "invalid scalar recovery ID and high s signatures rejected" {
    const key = [_]u8{0x11} ** 32;
    const digest = [_]u8{0x22} ** 32;
    const signature = try signDigest(key, digest, null);
    var invalid = signature;
    invalid[64] = 0;
    try std.testing.expectError(error.InvalidRecoveryId, recover(digest, invalid));
    invalid = signature;
    @memset(invalid[0..32], 0);
    try std.testing.expectError(error.InvalidSignature, recover(digest, invalid));
    invalid = signature;
    @memset(invalid[32..64], 0);
    try std.testing.expectError(error.InvalidSignature, recover(digest, invalid));
    invalid = signature;
    std.mem.writeInt(u256, invalid[32..64], Curve.scalar.field_order - 1, .big);
    try std.testing.expectError(error.HighSignatureS, recover(digest, invalid));
    invalid = signature;
    @memset(invalid[0..32], 255);
    try std.testing.expectError(error.NonCanonical, recover(digest, invalid));
    try std.testing.expectError(error.InvalidSecretKey, secretKeyAddress(.{0} ** 32));
    try std.testing.expectError(error.InvalidSecretKey, signDigest(.{0} ** 32, digest, null));
    const n = Curve.scalar.field_order;
    for ([_]u8{ 1, 26, 29, 35, 37, 255 }) |v| {
        invalid = signature;
        invalid[64] = v;
        try std.testing.expectError(error.InvalidRecoveryId, recover(digest, invalid));
    }
    for ([_]u256{ n, n + 1, std.math.maxInt(u256) }) |value| {
        invalid = signature;
        std.mem.writeInt(u256, invalid[0..32], value, .big);
        try std.testing.expectError(error.NonCanonical, recover(digest, invalid));
        invalid = signature;
        std.mem.writeInt(u256, invalid[32..64], value, .big);
        try std.testing.expectError(error.NonCanonical, recover(digest, invalid));
    }
    // s = n/2 is the largest accepted low s; n/2 + 1 is rejected.
    invalid = signature;
    std.mem.writeInt(u256, invalid[32..64], n / 2 + 1, .big);
    try std.testing.expectError(error.HighSignatureS, recover(digest, invalid));
    invalid = signature;
    std.mem.writeInt(u256, invalid[32..64], n / 2, .big);
    _ = recover(digest, invalid) catch |err| try std.testing.expect(err != error.HighSignatureS);
    // r = 5 is not the x coordinate of a curve point (5^3 + 7 is a non-residue).
    invalid = signature;
    std.mem.writeInt(u256, invalid[0..32], 5, .big);
    try std.testing.expectError(error.NotSquare, recover(digest, invalid));
}

test "high-s compatibility recovery equals strict low-s recovery" {
    var prng = std.Random.DefaultPrng.init(0x68696768);
    for (0..64) |_| {
        var key: Hash = undefined;
        prng.random().bytes(&key);
        var digest: Hash = undefined;
        prng.random().bytes(&digest);
        const signed = signDigest(key, digest, null) catch continue;
        const expected = try recover(digest, signed);
        const high_s = (try Scalar.fromBytes(signed[32..64].*, .big)).neg().toBytes(.big);
        const parity = signed[64] - 27;
        // ethers accepts the malleated (high-s, flipped v) form and normalises it.
        try std.testing.expectEqual(expected, try recoverCompatible(digest, signed[0..32].*, high_s, parity ^ 1));
        try std.testing.expectEqual(expected, try recoverCompatible(digest, signed[0..32].*, signed[32..64].*, 27 + parity));
        try std.testing.expectEqual(expected, try recoverCompatible(digest, signed[0..32].*, signed[32..64].*, 35 + 2 * 5 + parity));
        // Strict recovery rejects the malleated form.
        var malleated = signed;
        malleated[32..64].* = high_s;
        malleated[64] = 27 + (parity ^ 1);
        try std.testing.expectError(error.HighSignatureS, recover(digest, malleated));
    }
}

/// Furthest stage a Wycheproof case reaches in `recover`/`recoverCompatible`.
const WycheproofStage = enum(u3) { not_der, unencodable, scalar_rejected, high_s_rejected, not_on_curve, curve_reached };

test "Wycheproof secp256k1 ECDSA vectors by rejection stage" {
    const Case = struct { id: u32, low_s_required: bool, x: []const u8, y: []const u8, digest: []const u8, der_valid: bool, r: []const u8, s: []const u8, result: []const u8 };
    const parsed = try @import("../testing/fixture.zig").parse(struct { cases: []const Case }, std.testing.allocator, @embedFile("fixtures/wycheproof-secp256k1.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const n = Curve.scalar.field_order;
    // [stage][expected valid]
    var counts: [6][2]usize = @splat(.{ 0, 0 });
    var curve_valid_accepted: usize = 0;
    var curve_invalid_rejected: usize = 0;
    var unrepresentable_x: usize = 0;
    for (parsed.value.cases) |case| {
        const expected_valid = std.mem.eql(u8, case.result, "valid");
        var x: [32]u8 = undefined;
        var y: [32]u8 = undefined;
        var digest: Hash = undefined;
        _ = try std.fmt.hexToBytes(&x, case.x);
        _ = try std.fmt.hexToBytes(&y, case.y);
        _ = try std.fmt.hexToBytes(&digest, case.digest);
        const signer = addressOfCoordinates(x, y);
        var stage: WycheproofStage = .not_der;
        var accepted = false;
        if (case.der_valid) stage = .unencodable;
        if (case.der_valid and !std.mem.eql(u8, case.r, "out_of_range") and !std.mem.eql(u8, case.s, "out_of_range")) {
            var r: Hash = undefined;
            var s: Hash = undefined;
            std.mem.writeInt(u256, &r, try std.fmt.parseInt(u256, case.r, 10), .big);
            std.mem.writeInt(u256, &s, try std.fmt.parseInt(u256, case.s, 10), .big);
            for ([_]u8{ 27, 28 }) |v| {
                var signature: Signature = undefined;
                signature[0..32].* = r;
                signature[32..64].* = s;
                signature[64] = v;
                // Bitcoin-profile vectors require low s, like strict `recover`;
                // the plain profile accepts either s, like `recoverCompatible`.
                const outcome = if (case.low_s_required) recover(digest, signature) else recoverCompatible(digest, r, s, v);
                const reached: WycheproofStage = if (outcome) |recovered| reached: {
                    if (std.mem.eql(u8, &recovered, &signer)) accepted = true;
                    break :reached .curve_reached;
                } else |err| switch (err) {
                    error.NonCanonical, error.InvalidSignature => .scalar_rejected,
                    error.HighSignatureS => .high_s_rejected,
                    error.NotSquare => .not_on_curve,
                    error.IdentityElement => .curve_reached,
                    else => return err,
                };
                if (@intFromEnum(reached) > @intFromEnum(stage)) stage = reached;
            }
        }
        counts[@intFromEnum(stage)][@intFromBool(expected_valid)] += 1;
        // Never accept a signature Wycheproof rejects.
        if (accepted and !expected_valid) {
            std.debug.print("wycheproof case {d} accepted but expected invalid\n", .{case.id});
            return error.AcceptedInvalidSignature;
        }
        if (stage == .curve_reached) {
            if (accepted) curve_valid_accepted += 1;
            if (!expected_valid) curve_invalid_rejected += 1;
        }
        if (!expected_valid or accepted) continue;
        // The only tolerated miss: ECDSA-valid signatures whose R.x >= n, which
        // Ethereum's v = 27/28 cannot encode. Confirm with std arithmetic.
        const r = try Scalar.fromBytes(@bitCast(std.mem.nativeToBig(u256, try std.fmt.parseInt(u256, case.r, 10))), .big);
        const s = try Scalar.fromBytes(@bitCast(std.mem.nativeToBig(u256, try std.fmt.parseInt(u256, case.s, 10))), .big);
        const w = s.invert();
        var sec1: [65]u8 = undefined;
        sec1[0] = 4;
        sec1[1..33].* = x;
        sec1[33..65].* = y;
        const big_r = try Curve.mulDoubleBasePublic(Curve.basePoint, reducedHash(digest).mul(w).toBytes(.big), try Curve.fromSec1(&sec1), r.mul(w).toBytes(.big), .big);
        const rx = std.mem.readInt(u256, &big_r.affineCoordinates().x.toBytes(.big), .big);
        if (rx < n) {
            std.debug.print("wycheproof case {d} rejected but expected valid\n", .{case.id});
            return error.RejectedValidSignature;
        }
        unrepresentable_x += 1;
    }
    // Snapshot of the fixture (940 cases); a change means behaviour changed.
    // Indexed [stage][expected valid]: valid cases must all reach the curve.
    const expected_counts = [6][2]usize{
        .{ 383, 0 }, // not strict DER
        .{ 83, 0 }, // r or s negative or wider than 256 bits
        .{ 102, 0 }, // r or s zero or >= n
        .{ 4, 0 }, // high s under the low-s (bitcoin) profile
        .{ 11, 0 }, // r is not an x coordinate for either parity
        .{ 27, 330 }, // reached the curve arithmetic
    };
    try std.testing.expectEqual(expected_counts, counts);
    // Every curve-reaching invalid case recovered a different signer, and every
    // curve-reaching valid case recovered the signer except the R.x >= n ones.
    try std.testing.expectEqual(@as(usize, 27), curve_invalid_rejected);
    try std.testing.expectEqual(@as(usize, 327), curve_valid_accepted);
    try std.testing.expectEqual(@as(usize, 3), unrepresentable_x);
    try std.testing.expectEqual(counts[5][1], curve_valid_accepted + unrepresentable_x);
}

test "quorum requires configured threshold ordered unique signers" {
    const digest = [_]u8{0x22} ** 32;
    const keys = [_]Hash{ .{0x11} ** 32, .{0x22} ** 32, .{0x33} ** 32 };
    var validators: [3]Address = undefined;
    for (keys, 0..) |key, i| validators[i] = try secretKeyAddress(key);
    var signatures: [130]u8 = undefined;
    signatures[0..65].* = try signDigest(keys[0], digest, null);
    signatures[65..130].* = try signDigest(keys[2], digest, null);
    try verifyQuorum(digest, &signatures, &validators, 2);
    try std.testing.expectError(error.InvalidThreshold, verifyQuorum(digest, &signatures, &validators, 0));
    try std.testing.expectError(error.InvalidSignatureCount, verifyQuorum(digest, signatures[0..65], &validators, 2));
    var reversed = signatures;
    reversed[0..65].* = signatures[65..130].*;
    reversed[65..130].* = signatures[0..65].*;
    try std.testing.expectError(error.InvalidSignerOrder, verifyQuorum(digest, &reversed, &validators, 2));
    var duplicate = validators;
    duplicate[1] = validators[0];
    try std.testing.expectError(error.DuplicateValidator, verifyQuorum(digest, &signatures, &duplicate, 2));
    signatures[65..130].* = signatures[0..65].*;
    try std.testing.expectError(error.InvalidSignerOrder, verifyQuorum(digest, &signatures, &validators, 2));
}

test "recovery acceptance matches exact production ethers revision fixture" {
    const Fixture = struct {
        cases: []const struct {
            input: struct { digest: []const []const u8, r: []const []const u8, s: []const []const u8, v: []const u8 },
            expected: struct { signer: ?[]const u8 },
        },
    };
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, std.testing.allocator, @embedFile("fixtures/ethers-recovery.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const Decode = struct {
        fn hash(chunks: []const []const u8) !Hash {
            var out: Hash = undefined;
            var pos: usize = 0;
            for (chunks) |chunk| {
                const bytes = try std.fmt.hexToBytes(out[pos..], chunk);
                pos += bytes.len;
            }
            if (pos != 32) return error.InvalidFixtureHash;
            return out;
        }
    };
    for (parsed.value.cases) |case| {
        const result = recoverCompatible(try Decode.hash(case.input.digest), try Decode.hash(case.input.r), try Decode.hash(case.input.s), try std.fmt.parseInt(u64, case.input.v, 0));
        if (case.expected.signer) |signer| {
            var expected: Address = undefined;
            _ = try std.fmt.hexToBytes(&expected, signer);
            try std.testing.expectEqual(expected, try result);
        } else if (result) |_| {
            return error.ExpectedRecoveryRejection;
        } else |_| {}
    }
}

test "derived recovery id recovers signer and matches std-only reference signer bytes" {
    var prng = std.Random.DefaultPrng.init(0x5349474e);
    const random = prng.random();
    var parities = [2]usize{ 0, 0 };
    for (0..512) |i| {
        var key: Hash = undefined;
        random.bytes(&key);
        const d = Scalar.fromBytes(key, .big) catch continue;
        if (d.isZero()) continue;
        var digest: Hash = undefined;
        random.bytes(&digest);
        var noise_bytes: [32]u8 = undefined;
        random.bytes(&noise_bytes);
        const noise: ?[32]u8 = if (i % 2 == 0) null else noise_bytes;
        const signed = try signDigest(key, digest, noise);
        // Oracle: std.crypto only (secp256k1_reference.zig).
        const expected = try reference.secretKeyAddress(key);
        try std.testing.expectEqualSlices(u8, &expected, &try secretKeyAddress(key));
        try std.testing.expectEqualSlices(u8, &expected, &try recover(digest, signed));
        try std.testing.expectEqualSlices(u8, &try reference.sign(key, digest, noise), &signed);
        parities[signed[64] - 27] += 1;
    }
    // Both recovery ids must be exercised for the parity derivation to be tested.
    try std.testing.expect(parities[0] > 100 and parities[1] > 100);
}

test "fault self-check rejects any corrupted signature component" {
    var key = try SigningKey.init(.{0x11} ** 32);
    defer key.deinit();
    const digest = [_]u8{0x22} ** 32;
    const good = try signCore(key.secret, digest, null);
    try verifyBeforeRelease(&key, digest, good.signature, good.r_point);
    try std.testing.expectEqual(good.signature, try key.sign(digest, null));
    try std.testing.expectEqual(good.signature, try signDigest(key.secret, digest, null));
    // Simulated faults: flipped bits in r, s and v; R from another nonce (a
    // faulted k*G); and a signature checked against another key (a faulted d)
    // all fail closed.
    for ([_]usize{ 0, 17, 31, 32, 50, 63, 64 }) |byte| {
        var faulted = good.signature;
        faulted[byte] ^= 1;
        try std.testing.expectError(error.SignatureSelfCheckFailed, verifyBeforeRelease(&key, digest, faulted, good.r_point));
    }
    const other_nonce = try signCore(key.secret, digest, .{0x33} ** 32);
    try std.testing.expectError(error.SignatureSelfCheckFailed, verifyBeforeRelease(&key, digest, good.signature, other_nonce.r_point));
    var mixed = good.signature;
    mixed[0..32].* = other_nonce.signature[0..32].*;
    try std.testing.expectError(error.SignatureSelfCheckFailed, verifyBeforeRelease(&key, digest, mixed, other_nonce.r_point));
    var other_key = try SigningKey.init(.{0x12} ** 32);
    defer other_key.deinit();
    try std.testing.expectError(error.SignatureSelfCheckFailed, verifyBeforeRelease(&other_key, digest, good.signature, good.r_point));
    // A consistently faulted d (signature made with d' but checked against the
    // true Q) is caught, unlike a (z + r*d)*G == s*R style check.
    const faulted_d = try signCore(other_key.secret, digest, null);
    try std.testing.expectError(error.SignatureSelfCheckFailed, verifyBeforeRelease(&key, digest, faulted_d.signature, faulted_d.r_point));
    try std.testing.expectEqualSlices(u8, &key.address, &try secretKeyAddress(key.secret));
    try std.testing.expectEqualSlices(u8, &(try Curve.basePoint.mul(key.secret, .big)).toCompressedSec1(), &key.compressedPublicKey());
}

/// Random cases for the in-tree differential; reduced in Debug where std's
/// reference arithmetic is ~20x slower.
const differential_cases: usize = if (@import("builtin").mode == .Debug) 1_000 else 10_000;

test "sign/recover differential against std-only reference, with edge vectors" {
    const n = Curve.scalar.field_order;
    const p = secp256k1.field.p;
    const repeated = struct {
        fn f(byte: u8) u256 {
            return @as(u256, byte) * (std.math.maxInt(u256) / 0xff);
        }
    }.f;
    // Keys/digests/r/s that drive scalar and field reductions through carry
    // and borrow paths: limits of n and p, all-ones limbs, single high bits.
    const key_edges = [_]u256{ 1, 2, 3, n - 1, n - 2, n / 2, n / 2 + 1, 1 << 128, (1 << 128) - 1, 1 << 255, repeated(0x7f), repeated(0x80) % n, std.math.maxInt(u64), (1 << 192) - 1 };
    const digest_edges = [_]u256{ 0, 1, n - 1, n, n + 1, p - 1, p, std.math.maxInt(u256), 1 << 255, repeated(0x80), (1 << 128) - 1, std.math.maxInt(u256) - n };
    const r_edges = [_]u256{ 1, 2, 3, 4, n - 1, n - 2, (1 << 128), (1 << 255), n / 2, std.math.maxInt(u64) };
    const s_edges = [_]u256{ 1, 2, n / 2, n / 2 + 1, n - 1, (1 << 128) - 1, std.math.maxInt(u64) };
    var prng = std.Random.DefaultPrng.init(0x64696666);
    const random = prng.random();
    var counts = struct { signed: usize = 0, recovered: usize = 0, garbage: usize = 0 }{};
    for (0..differential_cases) |i| {
        var key: Hash = undefined;
        var digest: Hash = undefined;
        if (i < key_edges.len * digest_edges.len) {
            std.mem.writeInt(u256, &key, key_edges[i % key_edges.len], .big);
            std.mem.writeInt(u256, &digest, digest_edges[i / key_edges.len], .big);
        } else {
            random.bytes(&key);
            random.bytes(&digest);
        }
        var noise_bytes: [32]u8 = undefined;
        random.bytes(&noise_bytes);
        const noise: ?[32]u8 = if (i % 3 == 0) noise_bytes else null;
        const mine = signDigest(key, digest, noise);
        const theirs = reference.sign(key, digest, noise);
        if (mine) |signed| {
            try std.testing.expectEqual(try theirs, signed);
            try std.testing.expect(reference.sameOutcome(recover(digest, signed), reference.recover(digest, signed)));
            try std.testing.expectEqual(try reference.secretKeyAddress(key), try recover(digest, signed));
            counts.signed += 1;
            counts.recovered += 1;
        } else |_| {
            // Only invalid keys may fail; the reference must reject them too.
            try std.testing.expect(std.meta.isError(theirs));
        }
        // Arbitrary and edge (r, s, v) triples: identical address or error.
        var garbage: Signature = undefined;
        random.bytes(&garbage);
        if (i % 4 == 1) std.mem.writeInt(u256, garbage[0..32], r_edges[(i / 4) % r_edges.len], .big);
        if (i % 4 == 2) std.mem.writeInt(u256, garbage[32..64], s_edges[(i / 4) % s_edges.len], .big);
        if (i % 2 == 0) garbage[32] &= 0x7f;
        garbage[64] = 27 + (garbage[64] & 1);
        try std.testing.expect(reference.sameOutcome(recover(digest, garbage), reference.recover(digest, garbage)));
        counts.garbage += 1;
    }
    try std.testing.expect(counts.signed > differential_cases - 64);

    // Field level: specialised field vs std.crypto's fiat field on canonical
    // edge and random values (std requires canonical inputs).
    const Fe = secp256k1.Fe;
    const StdFe = Curve.Fe;
    const max64: u256 = std.math.maxInt(u64);
    const field_edges = [_]u256{ 0, 1, 2, 3, p - 1, p - 2, p - 3, 0x1000003D1, 0x1000003D0, 0x1000003D2, max64, max64 << 64, max64 << 128, max64 << 192, (1 << 255), (1 << 255) - 1, p - (1 << 32), (1 << 128) - 1, max64 | (max64 << 128), (max64 << 64) | (max64 << 192), p - max64, (p - 1) / 2 };
    for (0..field_edges.len * field_edges.len + differential_cases) |i| {
        const a: u256 = if (i < field_edges.len * field_edges.len) field_edges[i % field_edges.len] else random.int(u256) % p;
        const b: u256 = if (i < field_edges.len * field_edges.len) field_edges[i / field_edges.len] else random.int(u256) % p;
        var a_bytes: [32]u8 = undefined;
        var b_bytes: [32]u8 = undefined;
        std.mem.writeInt(u256, &a_bytes, a, .big);
        std.mem.writeInt(u256, &b_bytes, b, .big);
        const fa = try Fe.fromBytes(a_bytes);
        const fb = try Fe.fromBytes(b_bytes);
        const sa = try StdFe.fromBytes(a_bytes, .big);
        const sb = try StdFe.fromBytes(b_bytes, .big);
        try std.testing.expectEqual(sa.mul(sb).toBytes(.big), fa.mul(fb).toBytes());
        try std.testing.expectEqual(sa.add(sb).toBytes(.big), fa.add(fb).toBytes());
        try std.testing.expectEqual(sa.sub(sb).toBytes(.big), fa.sub(fb).toBytes());
        try std.testing.expectEqual(sa.neg().toBytes(.big), fa.neg().toBytes());
        if (i % 16 == 0) {
            try std.testing.expectEqual(sa.invert().toBytes(.big), fa.invert().toBytes());
            const std_root = sa.sqrt();
            const my_root = fa.sqrt();
            try std.testing.expectEqual(std.meta.isError(std_root), std.meta.isError(my_root));
            if (my_root) |root| try std.testing.expect(root.sq().equivalent(fa)) else |_| {}
        }
    }
}
