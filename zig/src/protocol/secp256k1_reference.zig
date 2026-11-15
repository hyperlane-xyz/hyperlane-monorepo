//! std.crypto-only secp256k1 reference for differential tests: std's ECDSA
//! signer (+ low-s, recovery id by std-only trial recovery), std curve
//! recovery and std Keccak. Shares no code with secp256k1.zig, the
//! specialised field, or protocol/keccak.zig. Test/benchmark use only.
const std = @import("std");
pub const Curve = std.crypto.ecc.Secp256k1;
pub const Scalar = Curve.scalar.Scalar;
const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;

pub fn address(point: Curve) [20]u8 {
    const sec1 = point.toUncompressedSec1();
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha3.Keccak256.hash(sec1[1..], &hash, .{});
    return hash[12..32].*;
}

pub fn secretKeyAddress(key: [32]u8) ![20]u8 {
    return address(try Curve.basePoint.mul(key, .big));
}

/// Same acceptance policy as signature.recover: v in {27, 28}, canonical
/// nonzero r and s, low s.
pub fn recover(digest: [32]u8, sig: [65]u8) ![20]u8 {
    if (sig[64] != 27 and sig[64] != 28) return error.InvalidRecoveryId;
    const r = try Scalar.fromBytes(sig[0..32].*, .big);
    const s = try Scalar.fromBytes(sig[32..64].*, .big);
    if (r.isZero() or s.isZero()) return error.InvalidSignature;
    if (std.mem.readInt(u256, sig[32..64], .big) > Curve.scalar.field_order / 2) return error.HighSignatureS;
    var compressed: [33]u8 = undefined;
    compressed[0] = 2 + sig[64] - 27;
    compressed[1..33].* = sig[0..32].*;
    const point_r = try Curve.fromSec1(&compressed);
    var wide: [48]u8 = .{0} ** 48;
    wide[16..48].* = digest;
    const z = Scalar.fromBytes48(wide, .big);
    const inverse_r = r.invert();
    const q = try Curve.mulDoubleBasePublic(point_r, s.mul(inverse_r).toBytes(.big), Curve.basePoint, z.mul(inverse_r).neg().toBytes(.big), .big);
    try q.rejectIdentity();
    return address(q);
}

/// std signer, low-s normalisation, v chosen by std-only recovery.
pub fn sign(key: [32]u8, digest: [32]u8, noise: ?[32]u8) ![65]u8 {
    const pair = try Ecdsa.KeyPair.fromSecretKey(try Ecdsa.SecretKey.fromBytes(key));
    var raw = try pair.signPrehashed(digest, noise);
    if (std.mem.readInt(u256, &raw.s, .big) > Curve.scalar.field_order / 2)
        raw.s = (try Scalar.fromBytes(raw.s, .big)).neg().toBytes(.big);
    var sig: [65]u8 = undefined;
    sig[0..64].* = raw.toBytes();
    const expected = address(pair.public_key.p);
    for ([_]u8{ 27, 28 }) |v| {
        sig[64] = v;
        const recovered = recover(digest, sig) catch continue;
        if (std.mem.eql(u8, &recovered, &expected)) return sig;
    }
    return error.UnrepresentableRecoveryId;
}

/// Identical success value, or identical error.
pub fn sameOutcome(mine: anyerror![20]u8, reference: anyerror![20]u8) bool {
    const m = mine catch |e| {
        const r_err = if (reference) |_| return false else |err| err;
        return e == r_err;
    };
    const r = reference catch return false;
    return std.mem.eql(u8, &m, &r);
}
