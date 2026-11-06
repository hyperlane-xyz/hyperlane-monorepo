//! Cloud signing of caller-supplied 32-byte digests. EIP-191 wrapping, if needed,
//! belongs to the caller; KMS must not hash this digest a second time.
const std = @import("std");
const http = @import("http.zig");
const aws = @import("sigv4.zig");
const protocol = @import("../protocol/root.zig");
const Allocator = std.mem.Allocator;
const Scheme = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
const Curve = std.crypto.ecc.Secp256k1;
const Value = std.json.Value;
pub const Hash = [32]u8;
pub const Signature = [65]u8;
pub const PublicKey = struct {
    key: Scheme.PublicKey,
    address: [20]u8,
    pub fn fromSec1(bytes: []const u8) !PublicKey {
        const key = try Scheme.PublicKey.fromSec1(bytes);
        try key.p.rejectIdentity();
        const uncompressed = key.toUncompressedSec1();
        var digest: Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(uncompressed[1..], &digest, .{});
        return .{ .key = key, .address = digest[12..32].* };
    }
};

pub fn crc32c(bytes: []const u8) u32 {
    return std.hash.crc.Crc32Iscsi.hash(bytes);
}

fn derInteger(der: []const u8, cursor: *usize) !Hash {
    if (cursor.* > der.len or der.len - cursor.* < 2 or der[cursor.*] != 2) return error.InvalidKmsDer;
    const len: usize = der[cursor.* + 1];
    cursor.* += 2;
    if (len == 0 or len > 33 or len > der.len - cursor.*) return error.InvalidKmsDer;
    var bytes = der[cursor.*..][0..len];
    cursor.* += len;
    if (bytes[0] & 0x80 != 0) return error.InvalidKmsDer;
    if (len > 1 and bytes[0] == 0) {
        if (bytes[1] & 0x80 == 0) return error.InvalidKmsDer;
        bytes = bytes[1..];
    }
    if (bytes.len > 32) return error.InvalidKmsDer;
    var out: Hash = .{0} ** 32;
    @memcpy(out[32 - bytes.len ..], bytes);
    return out;
}

/// Strict short-form DER for the two positive secp256k1 scalars. No external
/// crypto arithmetic is implemented: scalar/group/verify use std.crypto.
pub fn recoverDer(digest: Hash, der: []const u8, expected: PublicKey) !Signature {
    if (der.len < 8 or der.len > 72 or der[0] != 0x30 or der[1] != der.len - 2) return error.InvalidKmsDer;
    var cursor: usize = 2;
    const r = try derInteger(der, &cursor);
    var s = try derInteger(der, &cursor);
    if (cursor != der.len) return error.InvalidKmsDer;
    const scalar_r = try Curve.scalar.Scalar.fromBytes(r, .big);
    const scalar_s = try Curve.scalar.Scalar.fromBytes(s, .big);
    if (scalar_r.isZero() or scalar_s.isZero()) return error.InvalidKmsSignature;
    if (std.mem.readInt(u256, &s, .big) > Curve.scalar.field_order / 2) s = scalar_s.neg().toBytes(.big);
    const raw: Scheme.Signature = .{ .r = r, .s = s };
    try raw.verifyPrehashed(digest, expected.key);
    var signature: Signature = undefined;
    signature[0..64].* = raw.toBytes();
    for ([_]u8{ 27, 28 }) |v| {
        signature[64] = v;
        const recovered = protocol.signature.recover(digest, signature) catch continue;
        if (std.mem.eql(u8, &recovered, &expected.address)) return signature;
    }
    return error.KmsSignerMismatch;
}

fn base64(allocator: Allocator, bytes: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
    _ = std.base64.standard.Encoder.encode(out, bytes);
    return out;
}
fn unbase64(allocator: Allocator, encoded: []const u8) ![]u8 {
    const len = try std.base64.standard.Decoder.calcSizeForSlice(encoded);
    const out = try allocator.alloc(u8, len);
    errdefer allocator.free(out);
    try std.base64.standard.Decoder.decode(out, encoded);
    return out;
}
fn field(value: Value, key: []const u8) !Value {
    if (value != .object) return error.InvalidKmsResponse;
    return value.object.get(key) orelse error.InvalidKmsResponse;
}
fn text(value: Value) ![]const u8 {
    if (value != .string) return error.InvalidKmsResponse;
    return value.string;
}
fn checksum(value: Value) !u32 {
    return switch (value) {
        .integer => |n| if (n >= 0 and n <= std.math.maxInt(u32)) @intCast(n) else error.InvalidKmsResponse,
        .string => |s| std.fmt.parseInt(u32, s, 10),
        else => error.InvalidKmsResponse,
    };
}
fn endpointHost(allocator: Allocator, endpoint: []const u8) ![]const u8 {
    const uri = try std.Uri.parse(endpoint);
    if (uri.host == null or uri.user != null or uri.password != null or uri.query != null or uri.fragment != null or (uri.path.percent_encoded.len != 0 and !std.mem.eql(u8, uri.path.percent_encoded, "/"))) return error.InvalidKmsEndpoint;
    var host_buffer: [std.Uri.host_name_max]u8 = undefined;
    const host = try uri.getHost(&host_buffer);
    return if (uri.port) |port| std.fmt.allocPrint(allocator, "{s}:{d}", .{ host, port }) else allocator.dupe(u8, host);
}

pub const AwsConfig = struct {
    endpoint: []const u8,
    region: []const u8,
    credentials: aws.Credentials,
    key_id: []const u8,
    /// Required ARN, even when the request uses an alias: bind response identity.
    expected_key_arn: []const u8,
    public_key: PublicKey,
};

pub fn awsSignDigest(allocator: Allocator, transport: http.Transport, config: AwsConfig, digest: Hash, amz_date: []const u8) !Signature {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const temp = arena.allocator();
    if (config.key_id.len == 0 or config.expected_key_arn.len == 0) return error.InvalidKmsKey;
    const body = try std.json.Stringify.valueAlloc(temp, .{ .KeyId = config.key_id, .Message = try base64(temp, &digest), .MessageType = "DIGEST", .SigningAlgorithm = "ECDSA_SHA_256" }, .{});
    const host = try endpointHost(temp, config.endpoint);
    var signed = try aws.sign(allocator, .{ .method = .POST, .host = host, .path = "/", .headers = &.{ .{ .name = "content-type", .value = "application/x-amz-json-1.1" }, .{ .name = "x-amz-target", .value = "TrentService.Sign" } }, .body = body, .amz_date = amz_date, .region = config.region, .service = "kms", .credentials = config.credentials });
    defer signed.deinit();
    var response = try transport.send(allocator, .{ .method = .POST, .url = try std.fmt.allocPrint(temp, "{s}/", .{std.mem.trimEnd(u8, config.endpoint, "/")}), .headers = signed.headers, .body = body, .max_response_bytes = 16 * 1024 });
    defer response.deinit();
    if (!http.isSuccess(response.status)) return error.KmsHttpStatus;
    const value = try std.json.parseFromSliceLeaky(Value, temp, response.bytes, .{ .duplicate_field_behavior = .@"error" });
    if (!std.mem.eql(u8, try text(try field(value, "KeyId")), config.expected_key_arn)) return error.KmsWrongKey;
    if (!std.mem.eql(u8, try text(try field(value, "SigningAlgorithm")), "ECDSA_SHA_256")) return error.KmsWrongAlgorithm;
    const der = try unbase64(temp, try text(try field(value, "Signature")));
    return recoverDer(digest, der, config.public_key);
}

pub const GcpConfig = struct {
    endpoint: []const u8 = "https://cloudkms.googleapis.com",
    key_version_name: []const u8,
    bearer_token: []const u8,
    quota_project: ?[]const u8 = null,
    public_key: PublicKey,
};

/// Exactly one attempt. The runtime may retry only KmsIntegrityFailure, with a
/// bounded budget; key identity/protection/algorithm failures are never retried.
pub fn gcpSignDigest(allocator: Allocator, transport: http.Transport, config: GcpConfig, digest: Hash) !Signature {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const temp = arena.allocator();
    _ = try endpointHost(temp, config.endpoint);
    if (config.bearer_token.len == 0) return error.MissingCloudCredentials;
    if (!std.mem.startsWith(u8, config.key_version_name, "projects/") or std.mem.indexOf(u8, config.key_version_name, "/cryptoKeyVersions/") == null) return error.InvalidKmsKey;
    const key_name = try http.percentEncode(temp, config.key_version_name, true);
    const body = try std.json.Stringify.valueAlloc(temp, .{ .digest = .{ .sha256 = try base64(temp, &digest) }, .digestCrc32c = try std.fmt.allocPrint(temp, "{d}", .{crc32c(&digest)}) }, .{});
    const headers = try googleHeaders(temp, config.bearer_token, config.quota_project, true);
    var response = try transport.send(allocator, .{ .method = .POST, .url = try std.fmt.allocPrint(temp, "{s}/v1/{s}:asymmetricSign", .{ std.mem.trimEnd(u8, config.endpoint, "/"), key_name }), .headers = headers, .body = body, .max_response_bytes = 16 * 1024 });
    defer response.deinit();
    if (!http.isSuccess(response.status)) return error.KmsHttpStatus;
    const value = try std.json.parseFromSliceLeaky(Value, temp, response.bytes, .{ .duplicate_field_behavior = .@"error" });
    if (!std.mem.eql(u8, try text(try field(value, "name")), config.key_version_name)) return error.KmsWrongKey;
    if (!std.mem.eql(u8, try text(try field(value, "protectionLevel")), "HSM")) return error.KmsWrongProtectionLevel;
    const verified = value.object.get("verifiedDigestCrc32c") orelse return error.KmsIntegrityFailure;
    if (verified != .bool or !verified.bool) return error.KmsIntegrityFailure;
    const der = try unbase64(temp, try text(try field(value, "signature")));
    const response_checksum = value.object.get("signatureCrc32c") orelse return error.KmsIntegrityFailure;
    if (try checksum(response_checksum) != crc32c(der)) return error.KmsIntegrityFailure;
    return recoverDer(digest, der, config.public_key);
}

/// Matches Rust's total budget of three integrity attempts. Every other error
/// propagates immediately; no unbounded retry and no request metadata logging.
pub fn gcpSignDigestRetrying(allocator: Allocator, transport: http.Transport, config: GcpConfig, digest: Hash) !Signature {
    var attempt: u8 = 0;
    while (true) : (attempt += 1) {
        return gcpSignDigest(allocator, transport, config, digest) catch |err| {
            if (err == error.KmsIntegrityFailure and attempt < 2) continue;
            return err;
        };
    }
}

fn fixturePublicKey(key: Hash) !PublicKey {
    const pair = try Scheme.KeyPair.fromSecretKey(try Scheme.SecretKey.fromBytes(key));
    return PublicKey.fromSec1(&pair.public_key.toCompressedSec1());
}
fn fixtureDer(allocator: Allocator, signature: Signature) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    try out.appendSlice(allocator, &.{ 0x30, 0 });
    for ([_]Hash{ signature[0..32].*, signature[32..64].* }) |scalar| {
        var first: usize = 0;
        while (first < 31 and scalar[first] == 0) first += 1;
        const padding: u8 = if (scalar[first] & 0x80 != 0) 1 else 0;
        try out.appendSlice(allocator, &.{ 2, @as(u8, @intCast(32 - first)) + padding });
        if (padding == 1) try out.append(allocator, 0);
        try out.appendSlice(allocator, scalar[first..]);
    }
    out.items[1] = @intCast(out.items.len - 2);
    return out.toOwnedSlice(allocator);
}

test "KMS DER signatures normalize low s and bind raw digest to configured public key" {
    const key: Hash = .{0x11} ** 32;
    const digest: Hash = .{0x22} ** 32;
    const signature = try protocol.signature.signDigest(key, digest, null);
    const der = try fixtureDer(std.testing.allocator, signature);
    defer std.testing.allocator.free(der);
    const public_key = try fixturePublicKey(key);
    try std.testing.expectEqual(signature, try recoverDer(digest, der, public_key));
    var high = signature;
    std.mem.writeInt(u256, high[32..64], Curve.scalar.field_order - std.mem.readInt(u256, signature[32..64], .big), .big);
    const high_der = try fixtureDer(std.testing.allocator, high);
    defer std.testing.allocator.free(high_der);
    try std.testing.expectEqual(signature, try recoverDer(digest, high_der, public_key));
    if (recoverDer(digest, der, try fixturePublicKey(.{0x33} ** 32))) |_| return error.ExpectedWrongKeyFailure else |_| {}
    for ([_][]const u8{ &.{}, &.{ 0x30, 6, 2, 1, 0x80, 2, 1, 1 }, &.{ 0x30, 7, 2, 2, 0, 1, 2, 1, 1 }, &.{ 0x30, 6, 2, 0, 2, 2, 1, 1 } }) |invalid|
        try std.testing.expectError(error.InvalidKmsDer, recoverDer(digest, invalid, public_key));
    try std.testing.expectEqual(@as(u32, 0xe3069283), crc32c("123456789"));
}

const mock = @import("testing.zig");
fn checkAwsRequest(request: http.Request) !void {
    try std.testing.expectEqualStrings("TrentService.Sign", mock.header(request, "x-amz-target") orelse return error.MissingKmsTarget);
    try std.testing.expect(mock.header(request, "authorization") != null);
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, request.body orelse return error.MissingKmsBody, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("DIGEST", try text(try field(parsed.value, "MessageType")));
    try std.testing.expectEqualStrings("ECDSA_SHA_256", try text(try field(parsed.value, "SigningAlgorithm")));
    const message = try unbase64(std.testing.allocator, try text(try field(parsed.value, "Message")));
    defer std.testing.allocator.free(message);
    try std.testing.expectEqualSlices(u8, &(.{0x22} ** 32), message);
}
fn checkGcpRequest(request: http.Request) !void {
    try std.testing.expectEqualStrings("Bearer fixture-token", mock.header(request, "authorization") orelse return error.MissingKmsAuthorization);
    var parsed = try std.json.parseFromSlice(Value, std.testing.allocator, request.body orelse return error.MissingKmsBody, .{});
    defer parsed.deinit();
    const digest = try unbase64(std.testing.allocator, try text(try field(try field(parsed.value, "digest"), "sha256")));
    defer std.testing.allocator.free(digest);
    try std.testing.expectEqualSlices(u8, &(.{0x22} ** 32), digest);
    try std.testing.expectEqual(crc32c(digest), try checksum(try field(parsed.value, "digestCrc32c")));
}

test "AWS KMS request uses DIGEST and validates response ARN algorithm DER and signer" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const key: Hash = .{0x11} ** 32;
    const digest: Hash = .{0x22} ** 32;
    const signature = try protocol.signature.signDigest(key, digest, null);
    const der = try fixtureDer(allocator, signature);
    const config: AwsConfig = .{ .endpoint = "https://kms.example.invalid", .region = "us-east-1", .credentials = .{ .access_key_id = "EXAMPLE", .secret_access_key = "fixture" }, .key_id = "alias/fixture", .expected_key_arn = "arn:aws:kms:us-east-1:000000000000:key/fixture", .public_key = try fixturePublicKey(key) };
    const response = try std.json.Stringify.valueAlloc(allocator, .{ .KeyId = config.expected_key_arn, .SigningAlgorithm = "ECDSA_SHA_256", .Signature = try base64(allocator, der) }, .{});
    var transport: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/", .check = checkAwsRequest, .response = response }} };
    try std.testing.expectEqual(signature, try awsSignDigest(allocator, transport.transport(), config, digest, "20130524T000000Z"));
    try transport.expectDone();
    const wrong = try std.json.Stringify.valueAlloc(allocator, .{ .KeyId = "wrong", .SigningAlgorithm = "ECDSA_SHA_256", .Signature = try base64(allocator, der) }, .{});
    var invalid: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/", .response = wrong }} };
    try std.testing.expectError(error.KmsWrongKey, awsSignDigest(allocator, invalid.transport(), config, digest, "20130524T000000Z"));
}

test "GCP KMS validates digest CRC response CRC version and HSM before recovery" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const key: Hash = .{0x11} ** 32;
    const digest: Hash = .{0x22} ** 32;
    const signature = try protocol.signature.signDigest(key, digest, null);
    const der = try fixtureDer(allocator, signature);
    const config: GcpConfig = .{ .endpoint = "https://kms.example.invalid", .key_version_name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1", .bearer_token = "fixture-token", .public_key = try fixturePublicKey(key) };
    const Body = struct { name: []const u8, protectionLevel: []const u8 = "HSM", verifiedDigestCrc32c: bool = true, signature: []const u8, signatureCrc32c: []const u8 };
    const value: Body = .{ .name = config.key_version_name, .signature = try base64(allocator, der), .signatureCrc32c = try std.fmt.allocPrint(allocator, "{d}", .{crc32c(der)}) };
    const cases = [_]struct { kind: enum { valid, crc, verified, protection, version }, expected: ?anyerror }{ .{ .kind = .valid, .expected = null }, .{ .kind = .crc, .expected = error.KmsIntegrityFailure }, .{ .kind = .verified, .expected = error.KmsIntegrityFailure }, .{ .kind = .protection, .expected = error.KmsWrongProtectionLevel }, .{ .kind = .version, .expected = error.KmsWrongKey } };
    for (cases) |case| {
        var body = value;
        switch (case.kind) {
            .valid => {},
            .crc => body.signatureCrc32c = "0",
            .verified => body.verifiedDigestCrc32c = false,
            .protection => body.protectionLevel = "SOFTWARE",
            .version => body.name = "projects/wrong",
        }
        var transport: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/v1/projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1:asymmetricSign", .check = checkGcpRequest, .response = try std.json.Stringify.valueAlloc(allocator, body, .{}) }} };
        if (case.expected) |expected| try std.testing.expectError(expected, gcpSignDigest(allocator, transport.transport(), config, digest)) else try std.testing.expectEqual(signature, try gcpSignDigest(allocator, transport.transport(), config, digest));
        try transport.expectDone();
    }
}

test "GCP integrity retry budget is three total calls and permanent errors stop immediately" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const config: GcpConfig = .{ .endpoint = "https://kms.example.invalid", .key_version_name = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1", .bearer_token = "fixture-token", .public_key = try fixturePublicKey(.{0x11} ** 32) };
    const bad_crc = try std.json.Stringify.valueAlloc(allocator, .{ .name = config.key_version_name, .protectionLevel = "HSM", .verifiedDigestCrc32c = false }, .{});
    const step: mock.Step = .{ .method = .POST, .suffix = ":asymmetricSign", .response = bad_crc };
    var transport: mock.Mock = .{ .steps = &.{ step, step, step } };
    try std.testing.expectError(error.KmsIntegrityFailure, gcpSignDigestRetrying(allocator, transport.transport(), config, .{0x22} ** 32));
    try transport.expectDone();
    const permanent = try std.json.Stringify.valueAlloc(allocator, .{ .name = "wrong" }, .{});
    var invalid: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = ":asymmetricSign", .response = permanent }} };
    try std.testing.expectError(error.KmsWrongKey, gcpSignDigestRetrying(allocator, invalid.transport(), config, .{0x22} ** 32));
    try invalid.expectDone();
}

pub const AwsKeyConfig = struct {
    endpoint: []const u8,
    region: []const u8,
    credentials: aws.Credentials,
    key_id: []const u8,
    expected_key_arn: []const u8 = "",
    expected_address: ?[20]u8 = null,
};
pub const ResolvedAwsKey = struct {
    allocator: Allocator,
    key_arn: []u8,
    public_key: PublicKey,
    pub fn deinit(self: *ResolvedAwsKey) void {
        self.allocator.free(self.key_arn);
        self.* = undefined;
    }
};
pub const GcpKeyConfig = struct {
    endpoint: []const u8 = "https://cloudkms.googleapis.com",
    key_version_name: []const u8,
    bearer_token: []const u8,
    quota_project: ?[]const u8 = null,
    expected_address: ?[20]u8 = null,
};

/// Only SubjectPublicKeyInfo with id-ecPublicKey and named secp256k1 is accepted.
/// All lengths here are necessarily canonical short form (56/88 total bytes).
pub fn parseSecp256k1Spki(bytes: []const u8) !PublicKey {
    const algorithm = [_]u8{ 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a };
    if ((bytes.len != 56 and bytes.len != 88) or bytes[0] != 0x30 or bytes[1] != bytes.len - 2) return error.InvalidKmsPublicKey;
    if (!std.mem.eql(u8, bytes[2..20], &algorithm) or bytes[20] != 3 or bytes[21] != bytes.len - 22 or bytes[22] != 0) return error.InvalidKmsPublicKey;
    return PublicKey.fromSec1(bytes[23..]);
}

pub fn parseSecp256k1Pem(allocator: Allocator, pem: []const u8) !PublicKey {
    const trimmed = std.mem.trim(u8, pem, " \t\r\n");
    const begin = "-----BEGIN PUBLIC KEY-----";
    const end = "-----END PUBLIC KEY-----";
    if (!std.mem.startsWith(u8, trimmed, begin) or !std.mem.endsWith(u8, trimmed, end) or trimmed.len <= begin.len + end.len) return error.InvalidKmsPublicKey;
    var encoded: std.ArrayList(u8) = .empty;
    defer encoded.deinit(allocator);
    for (trimmed[begin.len .. trimmed.len - end.len]) |byte| if (!std.ascii.isWhitespace(byte)) try encoded.append(allocator, byte);
    const der = try unbase64(allocator, encoded.items);
    defer allocator.free(der);
    return parseSecp256k1Spki(der);
}

fn bindAddress(public_key: PublicKey, expected: ?[20]u8) !PublicKey {
    if (expected) |address| if (!std.mem.eql(u8, &public_key.address, &address)) return error.KmsSignerMismatch;
    return public_key;
}

pub fn awsGetPublicKey(allocator: Allocator, transport: http.Transport, config: AwsKeyConfig, amz_date: []const u8) !PublicKey {
    if (config.expected_key_arn.len == 0) return error.InvalidKmsKey;
    var resolved = try awsResolvePublicKey(allocator, transport, config, amz_date);
    defer resolved.deinit();
    return resolved.public_key;
}
/// Resolve an alias once over the caller's trusted SigV4/TLS transport, then
/// pin BOTH returned ARN and public key for every subsequent Sign request.
/// Configured concrete key ARNs never float; optional expected ARN/address pin.
pub fn awsResolvePublicKey(allocator: Allocator, transport: http.Transport, config: AwsKeyConfig, amz_date: []const u8) !ResolvedAwsKey {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const temp = arena.allocator();
    if (config.key_id.len == 0 or config.region.len == 0) return error.InvalidKmsKey;
    const body = try std.json.Stringify.valueAlloc(temp, .{ .KeyId = config.key_id }, .{});
    var signed = try aws.sign(allocator, .{ .method = .POST, .host = try endpointHost(temp, config.endpoint), .path = "/", .headers = &.{ .{ .name = "content-type", .value = "application/x-amz-json-1.1" }, .{ .name = "x-amz-target", .value = "TrentService.GetPublicKey" } }, .body = body, .amz_date = amz_date, .region = config.region, .service = "kms", .credentials = config.credentials });
    defer signed.deinit();
    var response = try transport.send(allocator, .{ .method = .POST, .url = try std.fmt.allocPrint(temp, "{s}/", .{std.mem.trimEnd(u8, config.endpoint, "/")}), .headers = signed.headers, .body = body, .max_response_bytes = 16 * 1024 });
    defer response.deinit();
    if (!http.isSuccess(response.status)) return error.KmsHttpStatus;
    const value = try std.json.parseFromSliceLeaky(Value, temp, response.bytes, .{ .duplicate_field_behavior = .@"error" });
    const key_arn = try text(try field(value, "KeyId"));
    const resolved_arn = try kmsArn(key_arn, config.region, false);
    if (config.expected_key_arn.len != 0 and !std.mem.eql(u8, key_arn, config.expected_key_arn)) return error.KmsWrongKey;
    if (std.mem.startsWith(u8, config.key_id, "arn:")) {
        const requested = try kmsArn(config.key_id, config.region, true);
        if (std.mem.startsWith(u8, requested.resource, "key/")) {
            if (!std.mem.eql(u8, key_arn, config.key_id)) return error.KmsWrongKey;
        } else if (!std.mem.eql(u8, requested.partition, resolved_arn.partition) or !std.mem.eql(u8, requested.account, resolved_arn.account)) return error.KmsWrongKey;
    } else if (!std.mem.startsWith(u8, config.key_id, "alias/")) {
        if (!std.mem.eql(u8, config.key_id, resolved_arn.resource[4..])) return error.KmsWrongKey;
    } else if (config.key_id.len == "alias/".len) return error.InvalidKmsKey;
    if (!std.mem.eql(u8, try text(try field(value, "KeyUsage")), "SIGN_VERIFY")) return error.KmsWrongKeyUsage;
    if (!std.mem.eql(u8, try text(try field(value, "KeySpec")), "ECC_SECG_P256K1")) return error.KmsWrongAlgorithm;
    const algorithms = try field(value, "SigningAlgorithms");
    if (algorithms != .array) return error.InvalidKmsResponse;
    var found = false;
    for (algorithms.array.items) |algorithm| if (std.mem.eql(u8, try text(algorithm), "ECDSA_SHA_256")) {
        found = true;
    };
    if (!found) return error.KmsWrongAlgorithm;
    const der = try unbase64(temp, try text(try field(value, "PublicKey")));
    const public_key = try bindAddress(try parseSecp256k1Spki(der), config.expected_address);
    return .{ .allocator = allocator, .key_arn = try allocator.dupe(u8, key_arn), .public_key = public_key };
}
const KmsArn = struct { partition: []const u8, account: []const u8, resource: []const u8 };
fn kmsArn(arn: []const u8, region: []const u8, allow_alias: bool) !KmsArn {
    var parts = std.mem.splitScalar(u8, arn, ':');
    if (!std.mem.eql(u8, parts.next() orelse return error.InvalidKmsKeyArn, "arn")) return error.InvalidKmsKeyArn;
    const partition = parts.next() orelse return error.InvalidKmsKeyArn;
    if (!std.mem.eql(u8, partition, "aws") and !std.mem.startsWith(u8, partition, "aws-")) return error.InvalidKmsKeyArn;
    if (!std.mem.eql(u8, parts.next() orelse return error.InvalidKmsKeyArn, "kms")) return error.InvalidKmsKeyArn;
    const actual_region = parts.next() orelse return error.InvalidKmsKeyArn;
    if (!std.mem.eql(u8, actual_region, region)) return error.KmsWrongRegion;
    const account = parts.next() orelse return error.InvalidKmsKeyArn;
    if (account.len != 12) return error.InvalidKmsKeyArn;
    for (account) |c| if (!std.ascii.isDigit(c)) return error.InvalidKmsKeyArn;
    const resource = parts.next() orelse return error.InvalidKmsKeyArn;
    if (parts.next() != null) return error.InvalidKmsKeyArn;
    const prefix: usize = if (std.mem.startsWith(u8, resource, "key/")) 4 else if (allow_alias and std.mem.startsWith(u8, resource, "alias/")) 6 else return error.InvalidKmsKeyArn;
    if (resource.len <= prefix) return error.InvalidKmsKeyArn;
    for (resource[prefix..]) |c| if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_' and !(allow_alias and prefix == 6 and c == '/')) return error.InvalidKmsKeyArn;
    return .{ .partition = partition, .account = account, .resource = resource };
}

pub fn gcpGetPublicKey(allocator: Allocator, transport: http.Transport, config: GcpKeyConfig) !PublicKey {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const temp = arena.allocator();
    _ = try endpointHost(temp, config.endpoint);
    if (config.bearer_token.len == 0) return error.MissingCloudCredentials;
    if (!std.mem.startsWith(u8, config.key_version_name, "projects/") or std.mem.indexOf(u8, config.key_version_name, "/cryptoKeyVersions/") == null) return error.InvalidKmsKey;
    const path = try http.percentEncode(temp, config.key_version_name, true);
    var response = try transport.send(allocator, .{ .method = .GET, .url = try std.fmt.allocPrint(temp, "{s}/v1/{s}/publicKey", .{ std.mem.trimEnd(u8, config.endpoint, "/"), path }), .headers = try googleHeaders(temp, config.bearer_token, config.quota_project, false), .max_response_bytes = 16 * 1024 });
    defer response.deinit();
    if (!http.isSuccess(response.status)) return error.KmsHttpStatus;
    const value = try std.json.parseFromSliceLeaky(Value, temp, response.bytes, .{ .duplicate_field_behavior = .@"error" });
    if (!std.mem.eql(u8, try text(try field(value, "name")), config.key_version_name)) return error.KmsWrongKey;
    if (!std.mem.eql(u8, try text(try field(value, "protectionLevel")), "HSM")) return error.KmsWrongProtectionLevel;
    if (!std.mem.eql(u8, try text(try field(value, "algorithm")), "EC_SIGN_SECP256K1_SHA256")) return error.KmsWrongAlgorithm;
    const pem = try text(try field(value, "pem"));
    const crc = value.object.get("pemCrc32c") orelse return error.KmsIntegrityFailure;
    if (try checksum(crc) != crc32c(pem)) return error.KmsIntegrityFailure;
    return bindAddress(try parseSecp256k1Pem(temp, pem), config.expected_address);
}

fn fixtureSpki(allocator: Allocator, public_key: PublicKey, compressed: bool) ![]u8 {
    const bytes = if (compressed) try allocator.dupe(u8, &public_key.key.toCompressedSec1()) else try allocator.dupe(u8, &public_key.key.toUncompressedSec1());
    const prefix = [_]u8{ 0x30, 0, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, 3, 0, 0 };
    const out = try allocator.alloc(u8, prefix.len + bytes.len);
    @memcpy(out[0..prefix.len], &prefix);
    @memcpy(out[prefix.len..], bytes);
    out[1] = @intCast(out.len - 2);
    out[21] = @intCast(bytes.len + 1);
    return out;
}

test "SPKI PEM bootstrap pins secp256k1 OIDs rejects mutation and validates cloud metadata" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const key = try fixturePublicKey(.{0x11} ** 32);
    for ([_]bool{ false, true }) |compressed| {
        const der = try fixtureSpki(allocator, key, compressed);
        try std.testing.expectEqual(key.address, (try parseSecp256k1Spki(der)).address);
        der[19] ^= 1;
        try std.testing.expectError(error.InvalidKmsPublicKey, parseSecp256k1Spki(der));
    }
    const der = try fixtureSpki(allocator, key, false);
    const pem = try std.fmt.allocPrint(allocator, "-----BEGIN PUBLIC KEY-----\n{s}\n-----END PUBLIC KEY-----\n", .{try base64(allocator, der)});
    const version = "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1";
    const response = try std.json.Stringify.valueAlloc(allocator, .{ .name = version, .algorithm = "EC_SIGN_SECP256K1_SHA256", .protectionLevel = "HSM", .pem = pem, .pemCrc32c = try std.fmt.allocPrint(allocator, "{d}", .{crc32c(pem)}) }, .{});
    var gcp: mock.Mock = .{ .steps = &.{.{ .method = .GET, .suffix = "/publicKey", .response = response }} };
    try std.testing.expectEqual(key.address, (try gcpGetPublicKey(allocator, gcp.transport(), .{ .key_version_name = version, .bearer_token = "fixture", .expected_address = key.address })).address);
    try gcp.expectDone();
    const arn = "arn:aws:kms:us-east-1:000000000000:key/fixture";
    const aws_response = try std.json.Stringify.valueAlloc(allocator, .{ .KeyId = arn, .KeySpec = "ECC_SECG_P256K1", .KeyUsage = "SIGN_VERIFY", .SigningAlgorithms = .{"ECDSA_SHA_256"}, .PublicKey = try base64(allocator, der) }, .{});
    var amazon: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/", .response = aws_response }} };
    try std.testing.expectEqual(key.address, (try awsGetPublicKey(allocator, amazon.transport(), .{ .endpoint = "https://kms.example.invalid", .region = "us-east-1", .credentials = .{ .access_key_id = "EXAMPLE", .secret_access_key = "fixture" }, .key_id = "alias/fixture", .expected_key_arn = arn, .expected_address = key.address }, "20130524T000000Z")).address);
    try amazon.expectDone();
}

test "AWS alias resolution owns canonical ARN pins key metadata and rejects later alias rotation" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temp = arena.allocator();
    const first = try fixturePublicKey(.{0x11} ** 32);
    const second = try fixturePublicKey(.{0x22} ** 32);
    const arn_first = "arn:aws:kms:us-east-1:000000000000:key/first";
    const arn_second = "arn:aws:kms:us-east-1:000000000000:key/second";
    const response_first = try std.json.Stringify.valueAlloc(temp, .{ .KeyId = arn_first, .KeySpec = "ECC_SECG_P256K1", .KeyUsage = "SIGN_VERIFY", .SigningAlgorithms = .{"ECDSA_SHA_256"}, .PublicKey = try base64(temp, try fixtureSpki(temp, first, false)) }, .{});
    const response_second = try std.json.Stringify.valueAlloc(temp, .{ .KeyId = arn_second, .KeySpec = "ECC_SECG_P256K1", .KeyUsage = "SIGN_VERIFY", .SigningAlgorithms = .{"ECDSA_SHA_256"}, .PublicKey = try base64(temp, try fixtureSpki(temp, second, false)) }, .{});
    var backend: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "/", .response = response_first }, .{ .method = .POST, .suffix = "/", .response = response_second }, .{ .method = .POST, .suffix = "/", .response = "{\"KeyId\":\"arn:aws:kms:us-east-1:000000000000:key/second\",\"SigningAlgorithm\":\"ECDSA_SHA_256\",\"Signature\":\"AA==\"}" } } };
    const config: AwsKeyConfig = .{ .endpoint = "https://kms.example.invalid", .region = "us-east-1", .credentials = .{ .access_key_id = "EXAMPLE", .secret_access_key = "fixture" }, .key_id = "alias/current" };
    var pinned = try awsResolvePublicKey(a, backend.transport(), config, "20130524T000000Z");
    defer pinned.deinit();
    try std.testing.expectEqualStrings(arn_first, pinned.key_arn);
    try std.testing.expectEqual(first.address, pinned.public_key.address);
    var newly_resolved = try awsResolvePublicKey(a, backend.transport(), config, "20130524T000000Z");
    defer newly_resolved.deinit();
    try std.testing.expectEqualStrings(arn_second, newly_resolved.key_arn);
    try std.testing.expectEqual(second.address, newly_resolved.public_key.address);
    try std.testing.expectError(error.KmsWrongKey, awsSignDigest(a, backend.transport(), .{ .endpoint = config.endpoint, .region = config.region, .credentials = config.credentials, .key_id = pinned.key_arn, .expected_key_arn = pinned.key_arn, .public_key = pinned.public_key }, .{0x33} ** 32, "20130524T000000Z"));
    try backend.expectDone();
    var concrete: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/", .response = response_second }} };
    var concrete_config = config;
    concrete_config.key_id = arn_first;
    try std.testing.expectError(error.KmsWrongKey, awsResolvePublicKey(a, concrete.transport(), concrete_config, "20130524T000000Z"));
    try concrete.expectDone();
    for ([_]struct { arn: []const u8, err: anyerror }{
        .{ .arn = "arn:aws:kms:eu-west-1:000000000000:key/first", .err = error.KmsWrongRegion },
        .{ .arn = "arn:aws:s3:us-east-1:000000000000:key/first", .err = error.InvalidKmsKeyArn },
        .{ .arn = "arn:aws:kms:us-east-1:123:key/first", .err = error.InvalidKmsKeyArn },
    }) |invalid| {
        const wire = try std.json.Stringify.valueAlloc(temp, .{ .KeyId = invalid.arn }, .{});
        var wrong: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/", .response = wire }} };
        try std.testing.expectError(invalid.err, awsResolvePublicKey(a, wrong.transport(), config, "20130524T000000Z"));
        try wrong.expectDone();
    }
}

fn googleHeaders(a: Allocator, token: []const u8, quota_project: ?[]const u8, content_type: bool) ![]const http.Header {
    var headers: std.ArrayList(http.Header) = .empty;
    try headers.append(a, .{ .name = "authorization", .value = try std.fmt.allocPrint(a, "Bearer {s}", .{token}) });
    if (content_type) try headers.append(a, .{ .name = "content-type", .value = "application/json" });
    if (quota_project) |project| {
        if (project.len == 0 or project.len > 256 or std.mem.indexOfAny(u8, project, " \t\r\n\x00") != null) return error.InvalidGoogleQuotaProject;
        try headers.append(a, .{ .name = "x-goog-user-project", .value = project });
    }
    return headers.items;
}
test "GCP KMS propagates explicit ADC quota billing project without mixing bearer identity" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const headers = try googleHeaders(arena.allocator(), "public-kms-token", "billing-fixture", true);
    try std.testing.expectEqualStrings("Bearer public-kms-token", headers[0].value);
    try std.testing.expectEqualStrings("x-goog-user-project", headers[2].name);
    try std.testing.expectEqualStrings("billing-fixture", headers[2].value);
    try std.testing.expectError(error.InvalidGoogleQuotaProject, googleHeaders(arena.allocator(), "fixture", "bad\r\nheader", false));
}
