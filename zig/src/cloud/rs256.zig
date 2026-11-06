//! Optional RS256 JWT signing through explicitly loaded OpenSSL 3 libcrypto.
//! No RSA arithmetic, key generation, ambient key lookup, or native error-string
//! formatting is implemented here. All native key/context objects are freed.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Handle = anyopaque;
const PasswordCallback = *const fn ([*]u8, c_int, c_int, ?*anyopaque) callconv(.c) c_int;
const Api = struct {
    BIO_new_mem_buf: *const fn (*const anyopaque, c_int) callconv(.c) ?*Handle,
    BIO_free: *const fn (*Handle) callconv(.c) c_int,
    PEM_read_bio_PrivateKey: *const fn (*Handle, ?*?*Handle, ?PasswordCallback, ?*anyopaque) callconv(.c) ?*Handle,
    EVP_PKEY_free: *const fn (*Handle) callconv(.c) void,
    EVP_PKEY_is_a: *const fn (*const Handle, [*:0]const u8) callconv(.c) c_int,
    EVP_PKEY_get_bits: *const fn (*const Handle) callconv(.c) c_int,
    EVP_MD_CTX_new: *const fn () callconv(.c) ?*Handle,
    EVP_MD_CTX_free: *const fn (*Handle) callconv(.c) void,
    EVP_sha256: *const fn () callconv(.c) ?*const Handle,
    EVP_DigestSignInit: *const fn (*Handle, *?*Handle, *const Handle, ?*Handle, *Handle) callconv(.c) c_int,
    EVP_PKEY_CTX_set_rsa_padding: *const fn (*Handle, c_int) callconv(.c) c_int,
    EVP_DigestSignUpdate: *const fn (*Handle, *const anyopaque, usize) callconv(.c) c_int,
    EVP_DigestSignFinal: *const fn (*Handle, ?[*]u8, *usize) callconv(.c) c_int,
    fn load(library: *std.DynLib) !Api {
        var api: Api = undefined;
        inline for (std.meta.fields(Api)) |field| @field(api, field.name) = library.lookup(field.type, field.name) orelse return error.MissingLibcryptoSymbol;
        return api;
    }
};
pub const Claims = struct {
    issuer: []const u8,
    scope: []const u8,
    audience: []const u8 = "https://oauth2.googleapis.com/token",
    issued_at: u64,
    expires_at: u64,
    key_id: ?[]const u8 = null,
};
pub fn validGoogleAudience(audience: []const u8) bool {
    return std.mem.eql(u8, audience, "https://oauth2.googleapis.com/token") or std.mem.eql(u8, audience, "https://accounts.google.com/o/oauth2/token");
}
pub fn validateClaims(claims: Claims) !void {
    if (claims.expires_at <= claims.issued_at or claims.expires_at - claims.issued_at > 3600) return error.InvalidJwtLifetime;
    if (!validGoogleAudience(claims.audience)) return error.InvalidJwtAudience;
    if (claims.issuer.len == 0 or claims.issuer.len > 320 or std.mem.indexOfScalar(u8, claims.issuer, '@') == null or !std.mem.endsWith(u8, claims.issuer, ".gserviceaccount.com")) return error.InvalidServiceAccountEmail;
    if (claims.scope.len == 0 or claims.scope.len > 4096 or std.mem.indexOfAny(u8, claims.scope, "\r\n\x00") != null or std.mem.indexOfAny(u8, claims.issuer, " \r\n\x00") != null) return error.InvalidJwtClaims;
    if (claims.key_id) |kid| if (kid.len == 0 or kid.len > 256 or std.mem.indexOfAny(u8, kid, "\r\n\x00") != null) return error.InvalidJwtClaims;
}
fn noPassword(_: [*]u8, _: c_int, _: c_int, _: ?*anyopaque) callconv(.c) c_int {
    return 0;
}
fn base64Url(allocator: Allocator, bytes: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, std.base64.url_safe_no_pad.Encoder.calcSize(bytes.len));
    _ = std.base64.url_safe_no_pad.Encoder.encode(out, bytes);
    return out;
}

pub const Signer = struct {
    library: std.DynLib,
    api: Api,
    pub fn init(_: Allocator, explicit_library_path: []const u8) !Signer {
        var library = try std.DynLib.open(explicit_library_path);
        errdefer library.close();
        return .{ .library = library, .api = try Api.load(&library) };
    }
    /// Caller must join all signing jobs before unloading the native library.
    pub fn deinit(self: *Signer) void {
        self.library.close();
        self.* = undefined;
    }

    pub fn signPem(self: *Signer, allocator: Allocator, private_pem: []const u8, message: []const u8) ![]u8 {
        if (private_pem.len == 0 or private_pem.len > 32 * 1024 or message.len > 64 * 1024) return error.RsaInputTooLarge;
        const trimmed = std.mem.trim(u8, private_pem, " \t\r\n");
        if (std.mem.count(u8, trimmed, "-----BEGIN ") != 1 or std.mem.count(u8, trimmed, "-----END ") != 1 or std.mem.indexOfScalar(u8, trimmed, 0) != null) return error.UnsupportedRsaPem;
        const pkcs8 = std.mem.startsWith(u8, trimmed, "-----BEGIN PRIVATE KEY-----") and std.mem.endsWith(u8, trimmed, "-----END PRIVATE KEY-----");
        const pkcs1 = std.mem.startsWith(u8, trimmed, "-----BEGIN RSA PRIVATE KEY-----") and std.mem.endsWith(u8, trimmed, "-----END RSA PRIVATE KEY-----");
        if (!pkcs8 and !pkcs1) return error.UnsupportedRsaPem;
        const owned = try allocator.dupe(u8, trimmed);
        defer {
            std.crypto.secureZero(u8, owned);
            allocator.free(owned);
        }
        const api = self.api;
        const bio = api.BIO_new_mem_buf(owned.ptr, @intCast(owned.len)) orelse return error.RsaKeyLoadFailed;
        defer _ = api.BIO_free(bio);
        const key = api.PEM_read_bio_PrivateKey(bio, null, noPassword, null) orelse return error.RsaKeyLoadFailed;
        defer api.EVP_PKEY_free(key);
        if (api.EVP_PKEY_is_a(key, "RSA") != 1 or api.EVP_PKEY_is_a(key, "RSA-PSS") == 1) return error.UnsupportedRsaKeyType;
        const bits = api.EVP_PKEY_get_bits(key);
        if (bits < 2048 or bits > 8192) return error.UnsupportedRsaKeySize;
        const context = api.EVP_MD_CTX_new() orelse return error.RsaSignFailed;
        defer api.EVP_MD_CTX_free(context);
        const sha256 = api.EVP_sha256() orelse return error.RsaSignFailed;
        var key_context: ?*Handle = null;
        if (api.EVP_DigestSignInit(context, &key_context, sha256, null, key) != 1) return error.RsaSignFailed;
        if (api.EVP_PKEY_CTX_set_rsa_padding(key_context orelse return error.RsaSignFailed, 1) != 1) return error.RsaSignFailed;
        if (api.EVP_DigestSignUpdate(context, message.ptr, message.len) != 1) return error.RsaSignFailed;
        var length: usize = 0;
        if (api.EVP_DigestSignFinal(context, null, &length) != 1 or length < 256 or length > 1024) return error.RsaSignFailed;
        const signature = try allocator.alloc(u8, length);
        errdefer allocator.free(signature);
        const expected = length;
        if (api.EVP_DigestSignFinal(context, signature.ptr, &length) != 1 or length != expected) return error.RsaSignFailed;
        return signature;
    }

    /// Google Cloud SDK scoped self-signed access JWT: scope+sub, no OAuth
    /// audience or token exchange. Same vetted RS256 implementation and bounds.
    pub fn signAccessJwt(self: *Signer, allocator: Allocator, private_pem: []const u8, claims: Claims) ![]u8 {
        try validateClaims(claims);
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const temporary = arena.allocator();
        const header = try std.json.Stringify.valueAlloc(temporary, .{ .alg = "RS256", .typ = "JWT", .kid = claims.key_id }, .{ .emit_null_optional_fields = false });
        const payload = try std.json.Stringify.valueAlloc(temporary, .{ .iss = claims.issuer, .scope = claims.scope, .sub = claims.issuer, .iat = claims.issued_at, .exp = claims.expires_at }, .{});
        const signing_input = try std.fmt.allocPrint(temporary, "{s}.{s}", .{ try base64Url(temporary, header), try base64Url(temporary, payload) });
        const signature = try self.signPem(temporary, private_pem, signing_input);
        return std.fmt.allocPrint(allocator, "{s}.{s}", .{ signing_input, try base64Url(temporary, signature) });
    }
    pub fn signJwt(self: *Signer, allocator: Allocator, private_pem: []const u8, claims: Claims) ![]u8 {
        try validateClaims(claims);
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const temp = arena.allocator();
        const header = try std.json.Stringify.valueAlloc(temp, .{ .alg = "RS256", .typ = "JWT", .kid = claims.key_id }, .{ .emit_null_optional_fields = false });
        const payload = try std.json.Stringify.valueAlloc(temp, .{ .iss = claims.issuer, .scope = claims.scope, .aud = claims.audience, .iat = claims.issued_at, .exp = claims.expires_at }, .{});
        const signing_input = try std.fmt.allocPrint(temp, "{s}.{s}", .{ try base64Url(temp, header), try base64Url(temp, payload) });
        const signature = try self.signPem(temp, private_pem, signing_input);
        const signature_base64 = try base64Url(temp, signature);
        return std.fmt.allocPrint(allocator, "{s}.{s}", .{ signing_input, signature_base64 });
    }
};

test "JWT claims require Google audience service account email and bounded lifetime" {
    var claims: Claims = .{ .issuer = "fixture@project.iam.gserviceaccount.com", .scope = "https://www.googleapis.com/auth/cloud-platform", .issued_at = 1000, .expires_at = 4600, .key_id = "fixture-key" };
    try validateClaims(claims);
    claims.expires_at = 4601;
    try std.testing.expectError(error.InvalidJwtLifetime, validateClaims(claims));
    claims.expires_at = 1000;
    try std.testing.expectError(error.InvalidJwtLifetime, validateClaims(claims));
    claims.expires_at = 4600;
    claims.audience = "https://untrusted.example/token";
    try std.testing.expectError(error.InvalidJwtAudience, validateClaims(claims));
    claims.audience = "https://oauth2.googleapis.com/token";
    claims.issuer = "fixture@example.invalid";
    try std.testing.expectError(error.InvalidServiceAccountEmail, validateClaims(claims));
}

test "opt-in OpenSSL RS256 agrees with external Node generated ephemeral fixtures" {
    const allocator = std.testing.allocator;
    const library_path = std.process.getEnvVarOwned(allocator, "HYPERLANE_LIBCRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(library_path);
    const fixture_path = try std.process.getEnvVarOwned(allocator, "HYPERLANE_TEST_RSA_FIXTURE_DIR");
    defer allocator.free(fixture_path);
    var dir = try std.fs.openDirAbsolute(fixture_path, .{});
    defer dir.close();
    const pem = try dir.readFileAlloc(allocator, "private.pem", 32 * 1024);
    defer {
        std.crypto.secureZero(u8, pem);
        allocator.free(pem);
    }
    var signer = try Signer.init(allocator, library_path);
    defer signer.deinit();
    const message = try dir.readFileAlloc(allocator, "message.bin", 65536);
    defer allocator.free(message);
    const expected_signature = try dir.readFileAlloc(allocator, "signature.bin", 1024);
    defer allocator.free(expected_signature);
    const signature = try signer.signPem(allocator, pem, message);
    defer allocator.free(signature);
    try std.testing.expectEqualSlices(u8, expected_signature, signature);
    const jwt = try signer.signJwt(allocator, pem, .{ .issuer = "fixture@project.iam.gserviceaccount.com", .scope = "https://www.googleapis.com/auth/cloud-platform", .issued_at = 1000, .expires_at = 4600, .key_id = "fixture-key" });
    defer allocator.free(jwt);
    const expected_jwt = try dir.readFileAlloc(allocator, "jwt.txt", 16384);
    defer allocator.free(expected_jwt);
    try std.testing.expectEqualStrings(expected_jwt, jwt);
    const access_jwt = try signer.signAccessJwt(allocator, pem, .{ .issuer = "fixture@project.iam.gserviceaccount.com", .scope = "https://www.googleapis.com/auth/cloud-platform", .issued_at = 1000, .expires_at = 4600, .key_id = "fixture-key" });
    defer allocator.free(access_jwt);
    const expected_access_jwt = try dir.readFileAlloc(allocator, "access-jwt.txt", 16384);
    defer allocator.free(expected_access_jwt);
    try std.testing.expectEqualStrings(expected_access_jwt, access_jwt);
    for ([_]struct { name: []const u8, expected: anyerror }{ .{ .name = "rsa1024.pem", .expected = error.UnsupportedRsaKeySize }, .{ .name = "ec-private.pem", .expected = error.UnsupportedRsaKeyType } }) |case| {
        const invalid = try dir.readFileAlloc(allocator, case.name, 32768);
        defer {
            std.crypto.secureZero(u8, invalid);
            allocator.free(invalid);
        }
        try std.testing.expectError(case.expected, signer.signPem(allocator, invalid, message));
    }
}
