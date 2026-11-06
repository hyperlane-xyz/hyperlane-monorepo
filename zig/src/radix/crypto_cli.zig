//! Test-only independent SDK differential bridge; never built as an agent.
const std = @import("std");
const crypto = @import("crypto.zig");
pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    if (args.len != 4) return error.ExpectedKindSeedDigest;
    var seed: [32]u8 = undefined;
    var digest: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&seed, args[2]);
    _ = try std.fmt.hexToBytes(&digest, args[3]);
    var signature: [65]u8 = .{0} ** 65;
    var public: [33]u8 = .{0} ** 33;
    var siglen: usize = undefined;
    var publen: usize = undefined;
    if (std.mem.eql(u8, args[1], "ed")) {
        signature[0..64].* = try crypto.sign(seed, digest);
        public[0..32].* = try crypto.publicKey(seed);
        siglen = 64;
        publen = 32;
    } else if (std.mem.eql(u8, args[1], "secp")) {
        const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
        const Curve = std.crypto.ecc.Secp256k1;
        const key = try Ecdsa.KeyPair.fromSecretKey(try Ecdsa.SecretKey.fromBytes(seed));
        var sig = try key.signPrehashed(digest, null);
        if (std.mem.readInt(u256, &sig.s, .big) > Curve.scalar.field_order / 2) sig.s = (try Curve.scalar.Scalar.fromBytes(sig.s, .big)).neg().toBytes(.big);
        signature[0] = 0;
        signature[1..65].* = sig.toBytes();
        public = key.public_key.toCompressedSec1();
        siglen = 65;
        publen = 33;
    } else return error.UnknownFixtureKind;
    const signature_hex = std.fmt.bytesToHex(signature, .lower);
    const public_hex = std.fmt.bytesToHex(public, .lower);
    const text = try std.fmt.allocPrint(allocator, "{{\"signature\":\"{s}\",\"public\":\"{s}\"}}\n", .{ signature_hex[0 .. siglen * 2], public_hex[0 .. publen * 2] });
    defer allocator.free(text);
    var pos: usize = 0;
    while (pos < text.len) pos += try std.posix.write(std.posix.STDOUT_FILENO, text[pos..]);
}
