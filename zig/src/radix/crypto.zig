//! Native Radix crypto: Blake2b-256 and Ed25519 sign the already domain-separated
//! transaction digest. No external signing service or key discovery.
const std = @import("std");
const Ed = std.crypto.sign.Ed25519;
pub fn hash(bytes: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    std.crypto.hash.blake2.Blake2b256.hash(bytes, &out, .{});
    return out;
}
pub fn hashParts(parts: []const []const u8) [32]u8 {
    var digest = std.crypto.hash.blake2.Blake2b256.init(.{});
    for (parts) |part| digest.update(part);
    var out: [32]u8 = undefined;
    digest.final(&out);
    return out;
}
pub fn publicKey(seed: [32]u8) ![32]u8 {
    return (try Ed.KeyPair.generateDeterministic(seed)).public_key.toBytes();
}
pub fn sign(seed: [32]u8, digest: [32]u8) ![64]u8 {
    const pair = try Ed.KeyPair.generateDeterministic(seed);
    return (try pair.sign(&digest, null)).toBytes();
}
pub fn verify(key: [32]u8, digest: [32]u8, signature: [64]u8) !void {
    try Ed.Signature.fromBytes(signature).verify(&digest, try Ed.PublicKey.fromBytes(key));
}
pub fn account(key: [32]u8) [30]u8 {
    var out = hash(&key)[2..32].*;
    out[0] = 0x51;
    return out;
}
pub fn secpAccount(key: [33]u8) ![30]u8 {
    _ = try std.crypto.ecc.Secp256k1.fromSec1(&key);
    var out = hash(&key)[2..32].*;
    out[0] = 0xd1;
    return out;
}
