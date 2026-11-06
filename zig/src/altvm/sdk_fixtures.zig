const std = @import("std");
const solana = @import("solana.zig");
const cosmos = @import("cosmos.zig");
const tron = @import("tron.zig");
const bech32 = @import("bech32.zig");

const Fixture = struct {
    solana: struct { payer: []const u8, message: []const u8, transaction: []const u8, pdas: []const struct { seeds: []const []const u8, key: []const u8, bump: u8 }, v0: []const u8, v0_transaction: []const u8 },
    cosmos: struct { public_key: []const u8, address: []const u8, bech32: []const u8, body: []const u8, auth: []const u8, sign_doc: []const u8, digest: []const u8, signature: []const u8, raw: []const u8 },
    tron: struct { raw: []const u8, txid: []const u8 },
};

fn expectHex(expected: []const u8, actual: []const u8) !void {
    const bytes = try std.testing.allocator.alloc(u8, expected.len / 2);
    defer std.testing.allocator.free(bytes);
    _ = try std.fmt.hexToBytes(bytes, expected);
    try std.testing.expectEqualSlices(u8, bytes, actual);
}

test "independent Solana SDK compile sign and PDA vectors" {
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, std.testing.allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value.solana;
    const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{0} ** 32);
    const payer = pair.public_key.toBytes();
    try expectHex(fixture.payer, &payer);
    const instruction: solana.Instruction = .{ .program = .{2} ** 32, .accounts = &.{ .{ .key = .{1} ** 32, .is_writable = true }, .{ .key = payer } }, .data = "test" };
    var message: [1232]u8 = undefined;
    const compiled = try solana.compileLegacy(payer, .{3} ** 32, &.{instruction}, &message);
    try expectHex(fixture.message, compiled.bytes);
    var transaction: [1232]u8 = undefined;
    try expectHex(fixture.transaction, try solana.signTransaction(compiled, &.{.{0} ** 32}, &transaction));
    for (fixture.pdas) |pda| {
        var seeds: [16][]const u8 = undefined;
        var decoded: [16][32]u8 = undefined;
        for (pda.seeds, 0..) |hex, i| seeds[i] = try std.fmt.hexToBytes(&decoded[i], hex);
        const actual = try solana.findProgramAddress(seeds[0..pda.seeds.len], .{0x11} ** 32);
        try expectHex(pda.key, &actual.key);
        try std.testing.expectEqual(pda.bump, actual.bump);
    }
}

test "independent Solana v0 SDK lookup table compilation and Ed25519 transaction" {
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, std.testing.allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value.solana;
    const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{0} ** 32);
    const payer = pair.public_key.toBytes();
    const instruction: solana.Instruction = .{ .program = .{2} ** 32, .accounts = &.{ .{ .key = .{1} ** 32, .is_writable = true }, .{ .key = .{4} ** 32 }, .{ .key = payer } }, .data = "test" };
    const tables = [_]solana.LookupTable{.{ .key = .{9} ** 32, .addresses = &.{ .{4} ** 32, .{1} ** 32, .{2} ** 32, payer } }};
    var message: [1232]u8 = undefined;
    const compiled = try solana.compileV0(payer, .{3} ** 32, &.{instruction}, &tables, &message);
    try expectHex(fixture.v0, compiled.bytes);
    var transaction: [1232]u8 = undefined;
    try expectHex(fixture.v0_transaction, try solana.signTransaction(compiled, &.{.{0} ** 32}, &transaction));
}

test "independent Cosmos SDK DIRECT protobuf address and signature vectors" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value.cosmos;
    const key = [_]u8{0x11} ** 32;
    const public_key = try cosmos.compressedPublicKey(key);
    try expectHex(fixture.public_key, &public_key);
    const address = try cosmos.accountAddress(key, .bitcoin);
    try expectHex(fixture.address, &address);
    var text: [90]u8 = undefined;
    try std.testing.expectEqualStrings(fixture.bech32, try bech32.encode("cosmos", &address, &text));
    const body = try cosmos.txBody(allocator, &.{.{ .type_url = "/test.Msg", .value = &.{ 8, 1 } }}, "memo", 500);
    defer allocator.free(body);
    try expectHex(fixture.body, body);
    const auth = try cosmos.authInfo(allocator, public_key, 7, .{ .amount = &.{.{ .denom = "uatom", .amount = "123" }}, .gas_limit = 200000 });
    defer allocator.free(auth);
    try expectHex(fixture.auth, auth);
    const doc = try cosmos.signDoc(allocator, body, auth, "cosmoshub-4", 12);
    defer allocator.free(doc);
    try expectHex(fixture.sign_doc, doc);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(doc, &digest, .{});
    try expectHex(fixture.digest, &digest);
    var signature: [64]u8 = undefined;
    _ = try std.fmt.hexToBytes(&signature, fixture.signature);
    const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
    try Ecdsa.Signature.fromBytes(signature).verifyPrehashed(digest, try Ecdsa.PublicKey.fromSec1(&public_key));
    const raw = try cosmos.txRaw(allocator, body, auth, &.{signature});
    defer allocator.free(raw);
    try expectHex(fixture.raw, raw);
}

test "independent Tron prost transaction TAPOS and SHA256 txid vector" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value.tron;
    const raw = try tron.rawTransaction(allocator, .{ .owner = try tron.secretKeyAddress(.{0x11} ** 32), .contract = tron.fromEthereumAddress(.{0x22} ** 20), .data = &.{ 1, 2, 3 } }, .{ .block_number = 0x123456, .block_hash = .{0x33} ** 32, .timestamp_ms = 1700000000000, .expiration_ms = 1700000060000, .fee_limit = 100000000 });
    defer allocator.free(raw);
    try expectHex(fixture.raw, raw);
    try expectHex(fixture.txid, &tron.txId(raw));
}
