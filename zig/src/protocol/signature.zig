const std = @import("std");
const Curve = std.crypto.ecc.Secp256k1;
const Scalar = Curve.scalar.Scalar;
const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
const Hash = [32]u8;
pub const Address = [20]u8;
pub const Signature = [65]u8;

fn reducedHash(digest: Hash) Scalar {
    var wide: [48]u8 = .{0} ** 48;
    wide[16..48].* = digest;
    return Scalar.fromBytes48(wide, .big);
}

fn address(point: Curve) Address {
    const sec1 = point.toUncompressedSec1();
    var hash: Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(sec1[1..], &hash, .{});
    return hash[12..32].*;
}

pub fn secretKeyAddress(secret_key: Hash) !Address {
    const scalar = try Scalar.fromBytes(secret_key, .big);
    if (scalar.isZero()) return error.InvalidSecretKey;
    return address(try Curve.basePoint.mul(secret_key, .big));
}

/// Security boundary: Ethereum's v=27/28, nonzero canonical r and low-s only.
/// ECDSA recovery uses Q=r^-1(sR-zG); all group and scalar operations come from
/// Zig std.crypto. This is public-input variable-time verification, never secret
/// scalar multiplication. Transaction chain-ID recovery values are rejected.
pub fn recover(digest: Hash, signature: Signature) !Address {
    if (signature[64] != 27 and signature[64] != 28) return error.InvalidRecoveryId;
    const r = try Scalar.fromBytes(signature[0..32].*, .big);
    const s = try Scalar.fromBytes(signature[32..64].*, .big);
    if (r.isZero() or s.isZero()) return error.InvalidSignature;
    if (std.mem.readInt(u256, signature[32..64], .big) > Curve.scalar.field_order / 2)
        return error.HighSignatureS;
    var compressed: [33]u8 = undefined;
    compressed[0] = 2 + signature[64] - 27;
    compressed[1..33].* = signature[0..32].*;
    const point_r = try Curve.fromSec1(&compressed);
    const z = reducedHash(digest);
    // Q = (s/r)R + (-z/r)G. Both scalars are public signature/digest data.
    // Use the standard curve's joint multiplication instead of computing
    // sR, zG and then multiplying their difference a third time.
    const inverse_r = r.invert();
    const public_key = try Curve.mulDoubleBasePublic(point_r, s.mul(inverse_r).toBytes(.big), Curve.basePoint, z.mul(inverse_r).neg().toBytes(.big), .big);
    try public_key.rejectIdentity();
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

/// EIP-191 wrapping must happen before calling this function. Secret key bytes
/// and optional fault-hardening noise are supplied by the caller; no global RNG
/// is consulted, making deterministic simulation possible. Null noise produces
/// a deterministic signature. No private keys are formatted or logged here.
pub fn signDigest(secret_key: Hash, digest: Hash, noise: ?[32]u8) !Signature {
    const scalar = try Scalar.fromBytes(secret_key, .big);
    if (scalar.isZero()) return error.InvalidSecretKey;
    const key_pair = try Ecdsa.KeyPair.fromSecretKey(try Ecdsa.SecretKey.fromBytes(secret_key));
    var raw = try key_pair.signPrehashed(digest, noise);
    if (std.mem.readInt(u256, &raw.s, .big) > Curve.scalar.field_order / 2)
        raw.s = (try Scalar.fromBytes(raw.s, .big)).neg().toBytes(.big);
    var signature: Signature = undefined;
    signature[0..64].* = raw.toBytes();
    const expected = address(key_pair.public_key.p);
    for ([_]u8{ 27, 28 }) |v| {
        signature[64] = v;
        const recovered = recover(digest, signature) catch continue;
        if (std.mem.eql(u8, &recovered, &expected)) return signature;
    }
    // Ethereum v=27/28 cannot encode the exceedingly rare x>=curve order case.
    // Fail closed; caller may retry with fresh signing noise.
    return error.UnrepresentableRecoveryId;
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
