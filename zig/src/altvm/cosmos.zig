//! Cosmos SIGN_MODE_DIRECT and CosmWasm wire messages. Chain adapters must
//! resolve account number/sequence, simulate gas and reconcile inclusion.
//! Sources: cosmos-sdk v0.53.0 proto/cosmos/tx/v1beta1/tx.proto;
//! cosmwasm/wasmd proto/cosmwasm/wasm/v1/tx.proto.
const std = @import("std");
const protobuf = @import("protobuf.zig");
const sig = @import("../protocol/signature.zig");
const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
pub const Any = struct { type_url: []const u8, value: []const u8 };
pub const Coin = struct { denom: []const u8, amount: []const u8 };
pub const Fee = struct { amount: []const Coin, gas_limit: u64, payer: []const u8 = "", granter: []const u8 = "" };

fn buffer(allocator: std.mem.Allocator, lengths: []const usize, overhead: usize) ![]u8 {
    var size = overhead;
    for (lengths) |length| size = try std.math.add(usize, size, length);
    return allocator.alloc(u8, size);
}

fn finish(allocator: std.mem.Allocator, enc: protobuf.Encoder) ![]u8 {
    return allocator.realloc(enc.out, enc.pos);
}

pub fn encodeAny(allocator: std.mem.Allocator, value: Any) ![]u8 {
    var enc: protobuf.Encoder = .{ .out = try buffer(allocator, &.{ value.type_url.len, value.value.len }, 32) };
    errdefer allocator.free(enc.out);
    try enc.bytes(1, value.type_url);
    try enc.bytes(2, value.value);
    return finish(allocator, enc);
}

fn encodeCoin(allocator: std.mem.Allocator, coin: Coin) ![]u8 {
    var enc: protobuf.Encoder = .{ .out = try buffer(allocator, &.{ coin.denom.len, coin.amount.len }, 32) };
    errdefer allocator.free(enc.out);
    try enc.bytes(1, coin.denom);
    try enc.bytes(2, coin.amount);
    return finish(allocator, enc);
}

pub fn txBody(allocator: std.mem.Allocator, messages: []const Any, memo: []const u8, timeout_height: u64) ![]u8 {
    var size = try std.math.add(usize, memo.len, 32);
    for (messages) |message| {
        size = try std.math.add(usize, size, try std.math.add(usize, message.type_url.len, message.value.len));
        size = try std.math.add(usize, size, 48);
    }
    var enc: protobuf.Encoder = .{ .out = try allocator.alloc(u8, size) };
    errdefer allocator.free(enc.out);
    for (messages) |message| {
        const encoded = try encodeAny(allocator, message);
        defer allocator.free(encoded);
        try enc.message(1, encoded);
    }
    try enc.bytes(2, memo);
    try enc.uint(3, timeout_height);
    return finish(allocator, enc);
}

pub fn compressedPublicKey(secret_key: [32]u8) ![33]u8 {
    const scalar = try std.crypto.ecc.Secp256k1.scalar.Scalar.fromBytes(secret_key, .big);
    if (scalar.isZero()) return error.InvalidSecretKey;
    const pair = try Ecdsa.KeyPair.fromSecretKey(try Ecdsa.SecretKey.fromBytes(secret_key));
    return pair.public_key.toCompressedSec1();
}

pub const AccountAddressType = enum { bitcoin, ethereum };
pub fn publicKeyAddress(public_key: [33]u8, kind: AccountAddressType) ![20]u8 {
    const parsed = try Ecdsa.PublicKey.fromSec1(&public_key);
    return switch (kind) {
        .bitcoin => blk: {
            var sha: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(&public_key, &sha, .{});
            break :blk @import("ripemd160.zig").hash(&sha);
        },
        .ethereum => blk: {
            const uncompressed = parsed.toUncompressedSec1();
            var digest: [32]u8 = undefined;
            std.crypto.hash.sha3.Keccak256.hash(uncompressed[1..], &digest, .{});
            break :blk digest[12..32].*;
        },
    };
}
pub fn accountAddress(secret_key: [32]u8, kind: AccountAddressType) ![20]u8 {
    return publicKeyAddress(try compressedPublicKey(secret_key), kind);
}

/// Standard Cosmos secp256k1 signer. Ethermint/Injective use different key type
/// URLs and signing rules; callers must not reuse this builder for those chains.
pub fn authInfo(allocator: std.mem.Allocator, public_key: [33]u8, sequence: u64, fee: Fee) ![]u8 {
    _ = try Ecdsa.PublicKey.fromSec1(&public_key);
    var pk_bytes: [35]u8 = undefined;
    var pk_encoder: protobuf.Encoder = .{ .out = &pk_bytes };
    try pk_encoder.bytes(1, &public_key);
    const pk_any = try encodeAny(allocator, .{ .type_url = "/cosmos.crypto.secp256k1.PubKey", .value = pk_encoder.written() });
    defer allocator.free(pk_any);
    var signer: protobuf.Encoder = .{ .out = try buffer(allocator, &.{pk_any.len}, 32) };
    defer allocator.free(signer.out);
    try signer.message(1, pk_any);
    // ModeInfo.single { Single.mode = SIGN_MODE_DIRECT = 1 }
    try signer.message(2, &.{ 10, 2, 8, 1 });
    try signer.uint(3, sequence);
    var fee_size = try std.math.add(usize, fee.payer.len, fee.granter.len);
    fee_size = try std.math.add(usize, fee_size, 64);
    for (fee.amount) |coin| {
        fee_size = try std.math.add(usize, fee_size, try std.math.add(usize, coin.denom.len, coin.amount.len));
        fee_size = try std.math.add(usize, fee_size, 48);
    }
    var fee_encoder: protobuf.Encoder = .{ .out = try allocator.alloc(u8, fee_size) };
    defer allocator.free(fee_encoder.out);
    for (fee.amount) |coin| {
        const encoded = try encodeCoin(allocator, coin);
        defer allocator.free(encoded);
        try fee_encoder.message(1, encoded);
    }
    try fee_encoder.uint(2, fee.gas_limit);
    try fee_encoder.bytes(3, fee.payer);
    try fee_encoder.bytes(4, fee.granter);
    var enc: protobuf.Encoder = .{ .out = try buffer(allocator, &.{ signer.pos, fee_encoder.pos }, 32) };
    errdefer allocator.free(enc.out);
    try enc.message(1, signer.written());
    try enc.message(2, fee_encoder.written());
    return finish(allocator, enc);
}

pub fn signDoc(allocator: std.mem.Allocator, body: []const u8, auth_info: []const u8, chain_id: []const u8, account_number: u64) ![]u8 {
    if (chain_id.len == 0) return error.EmptyChainId;
    var enc: protobuf.Encoder = .{ .out = try buffer(allocator, &.{ body.len, auth_info.len, chain_id.len }, 64) };
    errdefer allocator.free(enc.out);
    try enc.bytes(1, body);
    try enc.bytes(2, auth_info);
    try enc.bytes(3, chain_id);
    try enc.uint(4, account_number);
    return finish(allocator, enc);
}

pub fn signDirect(secret_key: [32]u8, sign_doc: []const u8, noise: ?[32]u8) ![64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(sign_doc, &digest, .{});
    const signature = try sig.signDigest(secret_key, digest, noise);
    return signature[0..64].*;
}

pub fn txRaw(allocator: std.mem.Allocator, body: []const u8, auth_info: []const u8, signatures: []const [64]u8) ![]u8 {
    var enc: protobuf.Encoder = .{ .out = try buffer(allocator, &.{ body.len, auth_info.len, try std.math.mul(usize, signatures.len, 80) }, 32) };
    errdefer allocator.free(enc.out);
    try enc.bytes(1, body);
    try enc.bytes(2, auth_info);
    for (signatures) |signature| try enc.message(3, &signature);
    return finish(allocator, enc);
}

pub fn txId(raw: []const u8) [32]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &digest, .{});
    return digest;
}

pub fn executeContract(allocator: std.mem.Allocator, sender: []const u8, contract: []const u8, msg: []const u8, funds: []const Coin) ![]u8 {
    var size = try std.math.add(usize, try std.math.add(usize, sender.len, contract.len), msg.len);
    size = try std.math.add(usize, size, 48);
    for (funds) |coin| {
        size = try std.math.add(usize, size, try std.math.add(usize, coin.denom.len, coin.amount.len));
        size = try std.math.add(usize, size, 48);
    }
    var enc: protobuf.Encoder = .{ .out = try allocator.alloc(u8, size) };
    errdefer allocator.free(enc.out);
    try enc.bytes(1, sender);
    try enc.bytes(2, contract);
    try enc.bytes(3, msg);
    for (funds) |coin| {
        const encoded = try encodeCoin(allocator, coin);
        defer allocator.free(encoded);
        try enc.message(5, encoded);
    }
    return finish(allocator, enc);
}

test "direct signing preserves chain account and sequence replay protection" {
    const allocator = std.testing.allocator;
    const key = [_]u8{0x11} ** 32;
    const body = try txBody(allocator, &.{.{ .type_url = "/test.Msg", .value = &.{ 8, 1 } }}, "memo", 500);
    defer allocator.free(body);
    const auth = try authInfo(allocator, try compressedPublicKey(key), 7, .{ .amount = &.{.{ .denom = "uatom", .amount = "123" }}, .gas_limit = 200000 });
    defer allocator.free(auth);
    const doc = try signDoc(allocator, body, auth, "cosmoshub-4", 12);
    defer allocator.free(doc);
    const signature = try signDirect(key, doc, null);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(doc, &digest, .{});
    try Ecdsa.Signature.fromBytes(signature).verifyPrehashed(digest, try Ecdsa.PublicKey.fromSec1(&try compressedPublicKey(key)));
    const raw = try txRaw(allocator, body, auth, &.{signature});
    defer allocator.free(raw);
    var decoded: protobuf.Decoder = .{ .input = raw };
    try std.testing.expectEqualSlices(u8, body, (try decoded.next()).?.value.bytes);
    try std.testing.expectEqualSlices(u8, auth, (try decoded.next()).?.value.bytes);
    try std.testing.expectEqualSlices(u8, &signature, (try decoded.next()).?.value.bytes);
    try std.testing.expectError(error.EmptyChainId, signDoc(allocator, body, auth, "", 12));
}
