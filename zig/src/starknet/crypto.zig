//! Explicit optional native cryptographic dependency; never loaded by default.
//! Only pinned, vetted primitives cross this C ABI. No custom Stark curve code.
const std = @import("std");
const codec = @import("codec.zig");
const Felt = codec.Felt;
pub const Signature = struct { r: Felt, s: Felt };
const Binary = *const fn (*const [32]u8, *const [32]u8, *[32]u8) callconv(.c) i32;
const Many = *const fn ([*]const u8, usize, *[32]u8) callconv(.c) i32;
const Public = *const fn (*const [32]u8, *[32]u8) callconv(.c) i32;
const Sign = *const fn (*const [32]u8, *const [32]u8, *[64]u8) callconv(.c) i32;
const Verify = *const fn (*const [32]u8, *const [32]u8, *const [64]u8, *u8) callconv(.c) i32;
pub const Crypto = struct {
    allocator: std.mem.Allocator,
    library: std.DynLib,
    pedersen_fn: Binary,
    poseidon_fn: Many,
    public_fn: Public,
    sign_fn: Sign,
    verify_fn: Verify,
    pub fn init(allocator: std.mem.Allocator, path: []const u8) !Crypto {
        var library = try std.DynLib.open(path);
        errdefer library.close();
        const version = library.lookup(*const fn () callconv(.c) u32, "ziggy_starknet_crypto_abi_version") orelse return error.MissingStarknetCryptoSymbol;
        if (version() != 1) return error.IncompatibleStarknetCryptoAbi;
        return .{ .allocator = allocator, .library = library, .pedersen_fn = library.lookup(Binary, "ziggy_starknet_pedersen") orelse return error.MissingStarknetCryptoSymbol, .poseidon_fn = library.lookup(Many, "ziggy_starknet_poseidon") orelse return error.MissingStarknetCryptoSymbol, .public_fn = library.lookup(Public, "ziggy_starknet_public_key") orelse return error.MissingStarknetCryptoSymbol, .sign_fn = library.lookup(Sign, "ziggy_starknet_sign") orelse return error.MissingStarknetCryptoSymbol, .verify_fn = library.lookup(Verify, "ziggy_starknet_verify") orelse return error.MissingStarknetCryptoSymbol };
    }
    /// Every borrowing job must finish before the native library is unloaded.
    pub fn deinit(self: *Crypto) void {
        self.library.close();
        self.* = undefined;
    }
    pub fn pedersen(self: *Crypto, left: Felt, right: Felt) !Felt {
        var out: [32]u8 = undefined;
        try status(self.pedersen_fn(&try validatedBytes(left), &try validatedBytes(right), &out));
        return Felt.fromBytes(out);
    }
    pub fn poseidon(self: *Crypto, values: []const Felt) !Felt {
        if (values.len > 1_000_000) return error.StarknetHashInputTooLarge;
        const input = try self.allocator.alloc(u8, try std.math.mul(usize, values.len, 32));
        defer self.allocator.free(input);
        for (values, 0..) |value, i| input[i * 32 ..][0..32].* = try validatedBytes(value);
        var out: [32]u8 = undefined;
        try status(self.poseidon_fn(input.ptr, values.len, &out));
        return Felt.fromBytes(out);
    }
    pub fn publicKey(self: *Crypto, secret: [32]u8) !Felt {
        var secret_copy = secret;
        defer std.crypto.secureZero(u8, &secret_copy);
        _ = try Felt.fromBytes(secret_copy);
        var out: [32]u8 = undefined;
        try status(self.public_fn(&secret_copy, &out));
        return Felt.fromBytes(out);
    }
    pub fn sign(self: *Crypto, secret: [32]u8, digest: Felt) !Signature {
        var secret_copy = secret;
        defer std.crypto.secureZero(u8, &secret_copy);
        _ = try Felt.fromBytes(secret_copy);
        var out: [64]u8 = undefined;
        try status(self.sign_fn(&secret_copy, &try validatedBytes(digest), &out));
        return .{ .r = try Felt.fromBytes(out[0..32].*), .s = try Felt.fromBytes(out[32..64].*) };
    }
    pub fn verify(self: *Crypto, public: Felt, digest: Felt, signature: Signature) !bool {
        var bytes: [64]u8 = undefined;
        bytes[0..32].* = try validatedBytes(signature.r);
        bytes[32..64].* = try validatedBytes(signature.s);
        var valid: u8 = 0;
        try status(self.verify_fn(&try validatedBytes(public), &try validatedBytes(digest), &bytes, &valid));
        if (valid > 1) return error.InvalidStarknetCryptoResult;
        return valid == 1;
    }
    pub fn hashOnElements(self: *Crypto, values: []const Felt) !Felt {
        var hash = Felt.zero;
        for (values) |value| hash = try self.pedersen(hash, value);
        return self.pedersen(hash, try Felt.init(values.len));
    }
};
fn validatedBytes(value: Felt) ![32]u8 {
    return (try Felt.init(value.value)).toBytes();
}
fn status(code: i32) !void {
    switch (code) {
        0 => {},
        -1 => return error.InvalidStarknetCryptoInput,
        -2 => return error.InvalidStarknetCryptoScalar,
        else => return error.StarknetCryptoFailure,
    }
}

test "Starknet native crypto optional pinned-library hashing signing and malformed scalars" {
    const a = std.testing.allocator;
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_STARKNET_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var crypto = try Crypto.init(a, path);
    defer crypto.deinit();
    var key: [32]u8 = .{0} ** 32;
    key[31] = 17;
    defer std.crypto.secureZero(u8, &key);
    const digest = try Felt.init(42);
    const public = try crypto.publicKey(key);
    const signature = try crypto.sign(key, digest);
    try std.testing.expect(try crypto.verify(public, digest, signature));
    try std.testing.expect(!try crypto.verify(public, try Felt.init(43), signature));
    try std.testing.expectError(error.InvalidStarknetCryptoScalar, crypto.publicKey(.{0} ** 32));
    _ = try crypto.poseidon(&.{});
    _ = try crypto.hashOnElements(&.{ try Felt.init(1), try Felt.init(2) });
}
