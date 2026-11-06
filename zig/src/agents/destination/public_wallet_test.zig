//! Public formatting from initialized backends. No signer/key/network work.
const std = @import("std");
const Factory = @import("factory.zig").Factory;
const a = std.testing.allocator;

test "health native public wallet encodings use actual initialized signer identities" {
    var factory: Factory = .{ .allocator = a, .arena = .init(a), .resources = undefined, .options = .{} };
    defer factory.arena.deinit();
    var out: [256]u8 = undefined;
    try std.testing.expectError(error.NativeDestinationNotInitialized, factory.publicWalletInto(&out));
    factory.backend_ready = true;
    factory.backend = .{ .sealevel = undefined };
    factory.backend.sealevel.signer.payer = @splat(0);
    try std.testing.expectEqualStrings("11111111111111111111111111111111", try factory.publicWalletInto(&out));
    try std.testing.expectError(error.InvalidHealthWalletBuffer, factory.publicWalletInto(out[0..1]));
    factory.backend = .{ .cosmos = undefined };
    factory.backend.cosmos.transactions.signer_address = "cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a";
    try std.testing.expectEqualStrings("cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a", try factory.publicWalletInto(&out));
    factory.backend = .{ .tron = undefined };
    factory.backend.tron.signer.address = @import("../../altvm/tron.zig").fromEthereumAddress(@splat(0));
    try std.testing.expectEqualStrings("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", try factory.publicWalletInto(&out));
    factory.backend = .{ .starknet = undefined };
    factory.backend.starknet.account = try @import("../../starknet/codec.zig").Felt.init(0x123);
    try std.testing.expectEqualStrings("0x123", try factory.publicWalletInto(&out));
    var radix_client: @import("../../radix/provider.zig").Client = undefined;
    radix_client.network = .mainnet;
    factory.backend = .{ .radix = undefined };
    factory.backend.radix.chain.provider = radix_client;
    factory.backend.radix.signer.public_key = try @import("../../radix/crypto.zig").publicKey(@splat(0x11));
    const sdk = (try @import("../../testing/fixture.zig").parse(struct { account_text: []const u8 }, a, @embedFile("../../radix/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true }));
    defer sdk.deinit();
    try std.testing.expectEqualStrings(sdk.value.account_text, try factory.publicWalletInto(&out));
}

test "health native Aleo public wallet uses actual native addressText" {
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var crypto = try @import("../../aleo/crypto.zig").Crypto.init(path);
    defer crypto.deinit();
    const address = try crypto.programAddress("credits.aleo");
    const expected = try crypto.addressText(a, address);
    defer a.free(expected);
    var factory: Factory = .{ .allocator = a, .arena = .init(a), .resources = undefined, .options = .{}, .backend_ready = true, .backend = .{ .aleo = undefined } };
    defer factory.arena.deinit();
    factory.backend.aleo.signer.address = address;
    factory.backend.aleo.chain.provider = undefined;
    // Actual provider holds the native public crypto decoder, no signing key.
    var provider: @import("../../aleo/provider.zig").Provider = undefined;
    provider.native = &crypto;
    factory.backend.aleo.chain.provider = &provider;
    var out: [256]u8 = undefined;
    try std.testing.expectEqualStrings(expected, try factory.publicWalletInto(&out));
    try std.testing.expect(std.mem.startsWith(u8, out[0..expected.len], "aleo1"));
}
