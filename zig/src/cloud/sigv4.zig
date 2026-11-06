const std = @import("std");
const http = @import("http.zig");
const Allocator = std.mem.Allocator;
const Hmac = std.crypto.auth.hmac.sha2.HmacSha256;
const Sha256 = std.crypto.hash.sha2.Sha256;
pub const Credentials = struct { access_key_id: []const u8, secret_access_key: []const u8, session_token: ?[]const u8 = null };
pub const Query = struct { name: []const u8, value: []const u8 };
pub const Input = struct {
    method: std.http.Method,
    host: []const u8,
    /// Raw path bytes, not already percent encoded. S3 slashes are preserved.
    path: []const u8,
    query: []const Query = &.{},
    headers: []const http.Header = &.{},
    body: []const u8 = &.{},
    amz_date: []const u8,
    region: []const u8,
    service: []const u8,
    credentials: Credentials,
    include_content_sha256: bool = true,
    spaced_authorization: bool = false,
};
pub const SignedRequest = struct {
    arena: std.heap.ArenaAllocator,
    headers: []const http.Header,
    canonical_path: []const u8,
    canonical_query: []const u8,
    authorization: []const u8,
    signature: [32]u8,
    pub fn deinit(self: *SignedRequest) void {
        for (self.headers) |header| if (std.mem.eql(u8, header.name, "x-amz-security-token")) std.crypto.secureZero(u8, @constCast(header.value));
        self.arena.deinit();
        self.* = undefined;
    }
};

fn sha256(bytes: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    Sha256.hash(bytes, &out, .{});
    return out;
}
fn hmac(key: []const u8, bytes: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    Hmac.create(&out, bytes, key);
    return out;
}
fn headerLess(_: void, a: http.Header, b: http.Header) bool {
    return std.mem.order(u8, a.name, b.name) == .lt;
}
fn queryLess(_: void, a: Query, b: Query) bool {
    const order = std.mem.order(u8, a.name, b.name);
    return order == .lt or (order == .eq and std.mem.order(u8, a.value, b.value) == .lt);
}
fn validScopePart(part: []const u8) bool {
    if (part.len == 0 or part.len > 128) return false;
    for (part) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '-') return false;
    return true;
}
fn normalizeHeader(allocator: Allocator, header: http.Header) !http.Header {
    if (header.name.len == 0 or std.mem.indexOfAny(u8, header.value, "\r\n") != null) return error.InvalidSigningHeader;
    const name = try allocator.dupe(u8, header.name);
    for (name) |*byte| {
        byte.* = std.ascii.toLower(byte.*);
        if (!std.ascii.isAlphanumeric(byte.*) and byte.* != '-') return error.InvalidSigningHeader;
    }
    const trimmed = std.mem.trim(u8, header.value, " \t");
    var value: std.ArrayList(u8) = .empty;
    var in_space = false;
    for (trimmed) |byte| {
        if (byte == ' ' or byte == '\t') {
            if (!in_space) try value.append(allocator, ' ');
            in_space = true;
        } else {
            if (byte < 0x20 or byte == 0x7f) return error.InvalidSigningHeader;
            try value.append(allocator, byte);
            in_space = false;
        }
    }
    return .{ .name = name, .value = try value.toOwnedSlice(allocator) };
}

/// AWS SigV4 with signed payload, explicit timestamp and explicit credentials.
/// No environment, clock, network, credential cache or secret logging is used.
pub fn sign(allocator: Allocator, input: Input) !SignedRequest {
    if (input.amz_date.len != 16 or input.amz_date[8] != 'T' or input.amz_date[15] != 'Z') return error.InvalidSigningDate;
    for (input.amz_date, 0..) |byte, i| if (i != 8 and i != 15 and !std.ascii.isDigit(byte)) return error.InvalidSigningDate;
    if (!validScopePart(input.region) or !validScopePart(input.service) or input.credentials.access_key_id.len == 0 or input.credentials.secret_access_key.len == 0 or input.path.len == 0 or input.path[0] != '/') return error.InvalidSigningInput;
    for (input.credentials.access_key_id) |byte| if (!std.ascii.isAlphanumeric(byte)) return error.InvalidSigningInput;
    if (input.host.len == 0 or std.mem.indexOfAny(u8, input.host, " /\t\r\n") != null) return error.InvalidSigningInput;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const temp = arena.allocator();
    var headers: std.ArrayList(http.Header) = .empty;
    try headers.append(temp, .{ .name = "host", .value = input.host });
    try headers.append(temp, .{ .name = "x-amz-date", .value = input.amz_date });
    const payload_hash = std.fmt.bytesToHex(sha256(input.body), .lower);
    if (input.include_content_sha256) try headers.append(temp, .{ .name = "x-amz-content-sha256", .value = try temp.dupe(u8, &payload_hash) });
    if (input.credentials.session_token) |token| try headers.append(temp, try normalizeHeader(temp, .{ .name = "x-amz-security-token", .value = token }));
    for (input.headers) |raw| {
        const normalized = try normalizeHeader(temp, raw);
        if (std.mem.eql(u8, normalized.name, "host") or std.mem.eql(u8, normalized.name, "authorization") or std.mem.eql(u8, normalized.name, "x-amz-date") or std.mem.eql(u8, normalized.name, "x-amz-content-sha256") or std.mem.eql(u8, normalized.name, "x-amz-security-token")) return error.ReservedSigningHeader;
        try headers.append(temp, normalized);
    }
    std.mem.sort(http.Header, headers.items, {}, headerLess);
    var canonical_headers: std.ArrayList(u8) = .empty;
    defer std.crypto.secureZero(u8, canonical_headers.items);
    var signed_names: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < headers.items.len) {
        const header = headers.items[i];
        if (signed_names.items.len != 0) try signed_names.append(temp, ';');
        try signed_names.appendSlice(temp, header.name);
        try canonical_headers.appendSlice(temp, header.name);
        try canonical_headers.append(temp, ':');
        try canonical_headers.appendSlice(temp, header.value);
        i += 1;
        while (i < headers.items.len and std.mem.eql(u8, header.name, headers.items[i].name)) : (i += 1) {
            try canonical_headers.append(temp, ',');
            try canonical_headers.appendSlice(temp, headers.items[i].value);
        }
        try canonical_headers.append(temp, '\n');
    }
    const encoded_query = try temp.alloc(Query, input.query.len);
    for (input.query, 0..) |query, n| encoded_query[n] = .{ .name = try http.percentEncode(temp, query.name, false), .value = try http.percentEncode(temp, query.value, false) };
    std.mem.sort(Query, encoded_query, {}, queryLess);
    var canonical_query: std.ArrayList(u8) = .empty;
    for (encoded_query, 0..) |query, n| {
        if (n != 0) try canonical_query.append(temp, '&');
        try canonical_query.appendSlice(temp, query.name);
        try canonical_query.append(temp, '=');
        try canonical_query.appendSlice(temp, query.value);
    }
    const canonical_path = try http.percentEncode(temp, input.path, true);
    const canonical = try std.fmt.allocPrint(temp, "{s}\n{s}\n{s}\n{s}\n{s}\n{s}", .{ @tagName(input.method), canonical_path, canonical_query.items, canonical_headers.items, signed_names.items, payload_hash });
    defer std.crypto.secureZero(u8, canonical);
    const scope = try std.fmt.allocPrint(temp, "{s}/{s}/{s}/aws4_request", .{ input.amz_date[0..8], input.region, input.service });
    const to_sign = try std.fmt.allocPrint(temp, "AWS4-HMAC-SHA256\n{s}\n{s}\n{s}", .{ input.amz_date, scope, std.fmt.bytesToHex(sha256(canonical), .lower) });
    const key_seed = try std.fmt.allocPrint(allocator, "AWS4{s}", .{input.credentials.secret_access_key});
    defer {
        std.crypto.secureZero(u8, key_seed);
        allocator.free(key_seed);
    }
    var date_key = hmac(key_seed, input.amz_date[0..8]);
    defer std.crypto.secureZero(u8, &date_key);
    var region_key = hmac(&date_key, input.region);
    defer std.crypto.secureZero(u8, &region_key);
    var service_key = hmac(&region_key, input.service);
    defer std.crypto.secureZero(u8, &service_key);
    var signing_key = hmac(&service_key, "aws4_request");
    defer std.crypto.secureZero(u8, &signing_key);
    const signature = hmac(&signing_key, to_sign);
    const authorization = if (input.spaced_authorization) try std.fmt.allocPrint(temp, "AWS4-HMAC-SHA256 Credential={s}/{s}, SignedHeaders={s}, Signature={s}", .{ input.credentials.access_key_id, scope, signed_names.items, std.fmt.bytesToHex(signature, .lower) }) else try std.fmt.allocPrint(temp, "AWS4-HMAC-SHA256 Credential={s}/{s},SignedHeaders={s},Signature={s}", .{ input.credentials.access_key_id, scope, signed_names.items, std.fmt.bytesToHex(signature, .lower) });
    try headers.append(temp, .{ .name = "authorization", .value = authorization });
    return .{ .arena = arena, .headers = headers.items, .canonical_path = canonical_path, .canonical_query = canonical_query.items, .authorization = authorization, .signature = signature };
}

test "published AWS S3 GET Object SigV4 fixture" {
    // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
    // These credentials are AWS's published example, never a real account.
    var signed = try sign(std.testing.allocator, .{ .method = .GET, .host = "examplebucket.s3.amazonaws.com", .path = "/test.txt", .headers = &.{.{ .name = "Range", .value = "bytes=0-9" }}, .amz_date = "20130524T000000Z", .region = "us-east-1", .service = "s3", .credentials = .{ .access_key_id = "AKIAIOSFODNN" ++ "7EXAMPLE", .secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" } });
    defer signed.deinit();
    try std.testing.expectEqualStrings("f0e8bdb87c964420e857bd35b5d6ed31" ++ "0bd44f0170aba48dd91039c6036bdb41", &std.fmt.bytesToHex(signed.signature, .lower));
}

test "query sorting session credentials and header whitespace are canonical" {
    const input: Input = .{ .method = .GET, .host = "example.invalid", .path = "/a//b %", .query = &.{ .{ .name = "z", .value = "/" }, .{ .name = "a", .value = "2" }, .{ .name = "a", .value = "1" } }, .headers = &.{.{ .name = " X", .value = "bad" }}, .amz_date = "20130524T000000Z", .region = "us-east-1", .service = "s3", .credentials = .{ .access_key_id = "EXAMPLE", .secret_access_key = "fixture", .session_token = "session-fixture" } };
    try std.testing.expectError(error.InvalidSigningHeader, sign(std.testing.allocator, input));
    var valid = input;
    valid.headers = &.{.{ .name = "X-Test", .value = "  a \t b  " }};
    var signed = try sign(std.testing.allocator, valid);
    defer signed.deinit();
    try std.testing.expectEqualStrings("a=1&a=2&z=%2F", signed.canonical_query);
    try std.testing.expectEqualStrings("/a//b%20%25", signed.canonical_path);
    try std.testing.expect(std.mem.indexOf(u8, signed.authorization, "x-amz-security-token") != null);
    for (signed.headers) |header| if (std.mem.eql(u8, header.name, "x-test")) try std.testing.expectEqualStrings("a b", header.value);
}
