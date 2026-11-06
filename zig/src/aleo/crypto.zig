//! Explicit vetted SnarkVM dependency for Aleo public-value cryptography.
const std = @import("std");
pub const Hash = [32]u8;
const Id = *const fn (u32, [*]const u8, usize, *Hash) callconv(.c) i32;
pub const IdKind = enum(u32) { block = 0, transaction = 1, transition = 2 };
const Text = *const fn ([*]const u8, usize, *Hash) callconv(.c) i32;
const IdEncode = *const fn (u32, *const Hash, [*]u8, usize, *usize) callconv(.c) i32;
const Encode = *const fn (*const Hash, [*]u8, usize, *usize) callconv(.c) i32;
const Mapping = *const fn ([*]const u8, usize, [*]const u8, usize, [*]const u8, usize, *Hash) callconv(.c) i32;
pub const Crypto = struct {
    library: std.DynLib,
    decode_fn: Text,
    encode_fn: Encode,
    program_fn: Text,
    mapping_fn: Mapping,
    id_fn: Id,
    id_encode_fn: IdEncode,
    pub fn init(path: []const u8) !Crypto {
        var lib = try std.DynLib.open(path);
        errdefer lib.close();
        const version = lib.lookup(*const fn () callconv(.c) u32, "ziggy_aleo_crypto_abi_version") orelse return error.MissingAleoCryptoSymbol;
        if (version() != 1) return error.IncompatibleAleoCryptoAbi;
        return .{ .library = lib, .id_fn = lib.lookup(Id, "ziggy_aleo_id_decode") orelse return error.MissingAleoCryptoSymbol, .id_encode_fn = lib.lookup(IdEncode, "ziggy_aleo_id_encode") orelse return error.MissingAleoCryptoSymbol, .decode_fn = lib.lookup(Text, "ziggy_aleo_address_decode") orelse return error.MissingAleoCryptoSymbol, .encode_fn = lib.lookup(Encode, "ziggy_aleo_address_encode") orelse return error.MissingAleoCryptoSymbol, .program_fn = lib.lookup(Text, "ziggy_aleo_program_address") orelse return error.MissingAleoCryptoSymbol, .mapping_fn = lib.lookup(Mapping, "ziggy_aleo_mapping_key_id") orelse return error.MissingAleoCryptoSymbol };
    }
    /// All borrowing jobs must finish before unloading the dependency.
    pub fn deinit(self: *Crypto) void {
        self.library.close();
        self.* = undefined;
    }
    pub fn id(self: *Crypto, kind: IdKind, text: []const u8) !Hash {
        var out: Hash = undefined;
        try status(self.id_fn(@intFromEnum(kind), text.ptr, text.len, &out));
        return out;
    }
    pub fn idText(self: *Crypto, a: std.mem.Allocator, kind: IdKind, hash: Hash) ![]u8 {
        var bytes: [128]u8 = undefined;
        var size: usize = 0;
        try status(self.id_encode_fn(@intFromEnum(kind), &hash, &bytes, bytes.len, &size));
        if (size > bytes.len) return error.InvalidAleoCryptoOutput;
        return a.dupe(u8, bytes[0..size]);
    }
    pub fn address(self: *Crypto, text: []const u8) !Hash {
        var out: Hash = undefined;
        try status(self.decode_fn(text.ptr, text.len, &out));
        return out;
    }
    pub fn addressText(self: *Crypto, a: std.mem.Allocator, value: Hash) ![]u8 {
        var buffer: [128]u8 = undefined;
        var len: usize = 0;
        try status(self.encode_fn(&value, &buffer, buffer.len, &len));
        if (len > buffer.len) return error.InvalidAleoCryptoOutput;
        return a.dupe(u8, buffer[0..len]);
    }
    pub fn programAddress(self: *Crypto, program: []const u8) !Hash {
        var out: Hash = undefined;
        try status(self.program_fn(program.ptr, program.len, &out));
        return out;
    }
    pub fn mappingKeyId(self: *Crypto, program: []const u8, mapping: []const u8, key: []const u8) !Hash {
        var out: Hash = undefined;
        try status(self.mapping_fn(program.ptr, program.len, mapping.ptr, mapping.len, key.ptr, key.len, &out));
        return out;
    }
};
fn status(code: i32) !void {
    return switch (code) {
        0 => {},
        -1 => error.InvalidAleoCryptoInput,
        -2 => error.InvalidAleoCryptoValue,
        -4 => error.AleoCryptoOutputTooSmall,
        else => error.AleoCryptoFailure,
    };
}

test "Aleo pinned native primitives validate program address and BHP mapping key IDs" {
    const a = std.testing.allocator;
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var native = try Crypto.init(path);
    defer native.deinit();
    const address = try native.programAddress("credits.aleo");
    const text = try native.addressText(a, address);
    defer a.free(text);
    try std.testing.expectEqual(address, try native.address(text));
    try std.testing.expectError(error.InvalidAleoCryptoValue, native.address("aleo1invalid"));
    try std.testing.expectError(error.InvalidAleoCryptoValue, native.programAddress("credits"));
    const first = try native.mappingKeyId("credits.aleo", "account", "true");
    const second = try native.mappingKeyId("credits.aleo", "account", "false");
    try std.testing.expect(!std.mem.eql(u8, &first, &second));
}
