//! Explicit, injectable identity flows. No process environment, credential files,
//! ambient network, or wall clock is read unless a caller supplies that input.
const std = @import("std");
const http = @import("http.zig");
const aws = @import("sigv4.zig");
const rs256 = @import("rs256.zig");
const Allocator = std.mem.Allocator;
const Value = std.json.Value;
pub const AwsCredentials = struct {
    arena: std.heap.ArenaAllocator,
    value: aws.Credentials,
    expires_at: ?u64 = null,
    pub fn deinit(self: *AwsCredentials) void {
        std.crypto.secureZero(u8, @constCast(self.value.access_key_id));
        std.crypto.secureZero(u8, @constCast(self.value.secret_access_key));
        if (self.value.session_token) |token| std.crypto.secureZero(u8, @constCast(token));
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const AccessToken = struct {
    arena: std.heap.ArenaAllocator,
    value: []const u8,
    expires_at: u64,
    pub fn deinit(self: *AccessToken) void {
        std.crypto.secureZero(u8, @constCast(self.value));
        self.arena.deinit();
        self.* = undefined;
    }
};
fn field(value: Value, name: []const u8) !Value {
    if (value != .object) return error.InvalidIdentityResponse;
    return value.object.get(name) orelse error.InvalidIdentityResponse;
}
fn text(value: Value) ![]const u8 {
    if (value != .string or value.string.len == 0 or std.mem.indexOfAny(u8, value.string, "\r\n\x00") != null) return error.InvalidIdentityResponse;
    return value.string;
}
fn number(value: Value) !u64 {
    return switch (value) {
        .integer => |n| if (n < 0) error.InvalidIdentityResponse else @intCast(n),
        .number_string => |s| std.fmt.parseInt(u64, s, 10),
        else => error.InvalidIdentityResponse,
    };
}
fn json(allocator: Allocator, bytes: []const u8) !Value {
    return std.json.parseFromSliceLeaky(Value, allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
}
fn validUntil(expires_at: ?u64, now: u64, skew: u64) bool {
    return if (expires_at) |end| end > now and end - now > skew else true;
}

/// UTC timestamps returned by AWS metadata/STS, including fractional seconds.
/// Offsets other than Z are rejected instead of misinterpreted as local time.
pub fn parseUtc(input: []const u8) !u64 {
    if (input.len < 20 or input[4] != '-' or input[7] != '-' or input[10] != 'T' or input[13] != ':' or input[16] != ':' or input[input.len - 1] != 'Z') return error.InvalidCredentialExpiration;
    if (input.len != 20) {
        if (input[19] != '.' or input.len < 22) return error.InvalidCredentialExpiration;
        for (input[20 .. input.len - 1]) |byte| if (!std.ascii.isDigit(byte)) return error.InvalidCredentialExpiration;
    }
    for (input[0..19], 0..) |byte, i| if (i != 4 and i != 7 and i != 10 and i != 13 and i != 16 and !std.ascii.isDigit(byte)) return error.InvalidCredentialExpiration;
    const year = try std.fmt.parseInt(u16, input[0..4], 10);
    const month = try std.fmt.parseInt(u8, input[5..7], 10);
    const day = try std.fmt.parseInt(u8, input[8..10], 10);
    const hour = try std.fmt.parseInt(u8, input[11..13], 10);
    const minute = try std.fmt.parseInt(u8, input[14..16], 10);
    const second = try std.fmt.parseInt(u8, input[17..19], 10);
    if (year < 1970 or month < 1 or month > 12 or day < 1 or hour > 23 or minute > 59 or second > 59) return error.InvalidCredentialExpiration;
    if (day > std.time.epoch.getDaysInMonth(year, @enumFromInt(month))) return error.InvalidCredentialExpiration;
    var days: u64 = day - 1;
    for (1970..year) |y| days += std.time.epoch.getDaysInYear(@intCast(y));
    for (1..month) |m| days += std.time.epoch.getDaysInMonth(year, @enumFromInt(m));
    return days * 86400 + @as(u64, hour) * 3600 + @as(u64, minute) * 60 + second;
}

/// Explicit environment map only; never calls std.process.getEnvMap itself.
/// Partial credentials fail rather than accidentally selecting another identity.
pub fn awsFromEnvironment(allocator: Allocator, environment: *const std.process.EnvMap) !?AwsCredentials {
    const access = environment.get("AWS_ACCESS_KEY_ID");
    const secret = environment.get("AWS_SECRET_ACCESS_KEY");
    if (access == null and secret == null) return null;
    if (access == null or secret == null or access.?.len == 0 or secret.?.len == 0) return error.IncompleteAwsEnvironment;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const temp = arena.allocator();
    const credentials: aws.Credentials = .{ .access_key_id = try temp.dupe(u8, access.?), .secret_access_key = try temp.dupe(u8, secret.?), .session_token = if (environment.get("AWS_SESSION_TOKEN")) |token| try temp.dupe(u8, token) else null };
    return .{ .arena = arena, .value = credentials };
}

pub fn parseAwsCredentials(allocator: Allocator, bytes: []const u8, now: u64) !AwsCredentials {
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const value = try json(arena.allocator(), bytes);
    if (value != .object) return error.InvalidIdentityResponse;
    if (value.object.get("Code")) |code| if (!std.mem.eql(u8, try text(code), "Success")) return error.IdentityRejected;
    const expiration = try parseUtc(try text(try field(value, "Expiration")));
    if (expiration <= now) return error.CredentialsExpired;
    const token = value.object.get("Token") orelse value.object.get("SessionToken") orelse return error.InvalidIdentityResponse;
    return .{ .arena = arena, .value = .{ .access_key_id = try text(try field(value, "AccessKeyId")), .secret_access_key = try text(try field(value, "SecretAccessKey")), .session_token = try text(token) }, .expires_at = expiration };
}

pub const AwsImds = struct {
    allocator: Allocator,
    transport: http.Transport,
    endpoint: []const u8 = "http://169.254.169.254",
    refresh_skew: u64 = 300,
    token: ?[]u8 = null,
    token_expires_at: u64 = 0,
    cached: ?AwsCredentials = null,
    pub fn deinit(self: *AwsImds) void {
        if (self.token) |token| {
            std.crypto.secureZero(u8, token);
            self.allocator.free(token);
        }
        if (self.cached) |*cached| cached.deinit();
        self.* = undefined;
    }
    fn request(self: *AwsImds, method: std.http.Method, path: []const u8, headers: []const http.Header) !http.Response {
        const url = try std.fmt.allocPrint(self.allocator, "{s}{s}", .{ std.mem.trimEnd(u8, self.endpoint, "/"), path });
        defer self.allocator.free(url);
        return self.transport.send(self.allocator, .{ .method = method, .url = url, .headers = headers, .max_response_bytes = 16 * 1024 });
    }
    /// Returned slices borrow the cache until refresh/deinit. One serialized
    /// owner must use the provider; no hidden background refresh or IMDSv1.
    pub fn credentials(self: *AwsImds, now: u64) !aws.Credentials {
        if (self.cached) |cached| if (validUntil(cached.expires_at, now, self.refresh_skew)) return cached.value;
        if (self.token == null or !validUntil(self.token_expires_at, now, 60)) {
            var response = try self.request(.PUT, "/latest/api/token", &.{.{ .name = "x-aws-ec2-metadata-token-ttl-seconds", .value = "21600" }});
            defer response.deinit();
            if (response.status != 200 or response.bytes.len == 0 or std.mem.indexOfAny(u8, response.bytes, "\r\n\x00") != null) return error.ImdsTokenRejected;
            const token = try self.allocator.dupe(u8, response.bytes);
            if (self.token) |old| {
                std.crypto.secureZero(u8, old);
                self.allocator.free(old);
            }
            self.token = token;
            self.token_expires_at = try std.math.add(u64, now, 21600);
        }
        const headers = [_]http.Header{.{ .name = "x-aws-ec2-metadata-token", .value = self.token.? }};
        var role_response = try self.request(.GET, "/latest/meta-data/iam/security-credentials/", &headers);
        defer role_response.deinit();
        if (role_response.status != 200) return error.ImdsRoleRejected;
        const role = std.mem.trim(u8, role_response.bytes, " \r\n\t");
        if (role.len == 0 or role.len > 64) return error.InvalidImdsRole;
        for (role) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "+=,.@_-", byte) == null) return error.InvalidImdsRole;
        const path = try std.fmt.allocPrint(self.allocator, "/latest/meta-data/iam/security-credentials/{s}", .{role});
        defer self.allocator.free(path);
        var response = try self.request(.GET, path, &headers);
        defer response.deinit();
        if (response.status != 200) return error.ImdsCredentialsRejected;
        const fresh = try parseAwsCredentials(self.allocator, response.bytes, now);
        if (self.cached) |*old| old.deinit();
        self.cached = fresh;
        return fresh.value;
    }
};

pub const RefreshConfig = struct { endpoint: []const u8 = "https://oauth2.googleapis.com/token", client_id: []const u8, client_secret: []const u8, refresh_token: []const u8 };
pub const ServiceAccountConfig = struct {
    signer: *rs256.Signer,
    client_email: []const u8,
    private_key_pem: []const u8,
    private_key_id: ?[]const u8 = null,
    scope: []const u8,
    audience: []const u8 = "https://oauth2.googleapis.com/token",
    endpoint: []const u8 = "https://oauth2.googleapis.com/token",
    lifetime_seconds: u32 = 3600,
};
pub const GcpFlow = union(enum) {
    metadata: struct { endpoint: []const u8 = "http://metadata.google.internal", scopes: []const []const u8 = &.{} },
    authorized_user: RefreshConfig,
    service_account: ServiceAccountConfig,
};
pub const GcpProvider = struct {
    allocator: Allocator,
    transport: http.Transport,
    flow: GcpFlow,
    refresh_skew: u64 = 300,
    cached: ?AccessToken = null,
    pub fn deinit(self: *GcpProvider) void {
        if (self.cached) |*cached| cached.deinit();
        self.* = undefined;
    }
    pub fn token(self: *GcpProvider, now: u64) ![]const u8 {
        if (self.cached) |cached| if (validUntil(cached.expires_at, now, self.refresh_skew)) return cached.value;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const temp = arena.allocator();
        var response = switch (self.flow) {
            .metadata => |config| blk: {
                var url: std.ArrayList(u8) = .empty;
                try url.appendSlice(temp, std.mem.trimEnd(u8, config.endpoint, "/"));
                try url.appendSlice(temp, "/computeMetadata/v1/instance/service-accounts/default/token");
                if (config.scopes.len > 0) {
                    try url.appendSlice(temp, "?enforce_scopes=true&scopes=");
                    for (config.scopes, 0..) |scope, i| {
                        if (i > 0) try url.appendSlice(temp, "%2C");
                        try url.appendSlice(temp, try http.percentEncode(temp, scope, false));
                    }
                }
                break :blk try self.transport.send(self.allocator, .{ .method = .GET, .url = url.items, .headers = &.{.{ .name = "Metadata-Flavor", .value = "Google" }}, .max_response_bytes = 16 * 1024 });
            },
            .authorized_user => |config| blk: {
                if (config.client_id.len == 0 or config.client_secret.len == 0 or config.refresh_token.len == 0) return error.IncompleteGoogleRefreshCredentials;
                const body = try form(temp, &.{ .{ .name = "grant_type", .value = "refresh_token" }, .{ .name = "client_id", .value = config.client_id }, .{ .name = "client_secret", .value = config.client_secret }, .{ .name = "refresh_token", .value = config.refresh_token } });
                break :blk try self.transport.send(self.allocator, .{ .method = .POST, .url = config.endpoint, .headers = &.{.{ .name = "content-type", .value = "application/x-www-form-urlencoded" }}, .body = body, .max_response_bytes = 16 * 1024 });
            },
            .service_account => |config| blk: {
                const assertion = try config.signer.signJwt(self.allocator, config.private_key_pem, .{ .issuer = config.client_email, .scope = config.scope, .audience = config.audience, .issued_at = now, .expires_at = try std.math.add(u64, now, config.lifetime_seconds), .key_id = config.private_key_id });
                defer {
                    std.crypto.secureZero(u8, assertion);
                    self.allocator.free(assertion);
                }
                const body = try form(self.allocator, &.{ .{ .name = "grant_type", .value = "urn:ietf:params:oauth:grant-type:jwt-bearer" }, .{ .name = "assertion", .value = assertion } });
                defer {
                    std.crypto.secureZero(u8, body);
                    self.allocator.free(body);
                }
                break :blk try self.transport.send(self.allocator, .{ .method = .POST, .url = config.endpoint, .headers = &.{.{ .name = "content-type", .value = "application/x-www-form-urlencoded" }}, .body = body, .max_response_bytes = 16 * 1024 });
            },
        };
        defer response.deinit();
        if (response.status != 200) return error.GoogleIdentityRejected;
        if (self.flow == .metadata and !response.metadata_flavor_google) return error.InvalidMetadataFlavor;
        const value = try json(temp, response.bytes);
        if (!std.mem.eql(u8, try text(try field(value, "token_type")), "Bearer")) return error.InvalidIdentityResponse;
        const access_token = try text(try field(value, "access_token"));
        const lifetime = try number(try field(value, "expires_in"));
        if (lifetime == 0) return error.CredentialsExpired;
        const expiration = try std.math.add(u64, now, lifetime);
        if (self.cached) |*old| old.deinit();
        self.cached = .{ .arena = arena, .value = access_token, .expires_at = expiration };
        return access_token;
    }
    pub fn projectId(self: *GcpProvider) ![]u8 {
        return self.metadataValue("/computeMetadata/v1/project/project-id");
    }
    pub fn scopes(self: *GcpProvider) ![]u8 {
        return self.metadataValue("/computeMetadata/v1/instance/service-accounts/default/scopes");
    }
    fn metadataValue(self: *GcpProvider, path: []const u8) ![]u8 {
        const config = switch (self.flow) {
            .metadata => |config| config,
            else => return error.NotMetadataIdentity,
        };
        const url = try std.fmt.allocPrint(self.allocator, "{s}{s}", .{ std.mem.trimEnd(u8, config.endpoint, "/"), path });
        defer self.allocator.free(url);
        var response = try self.transport.send(self.allocator, .{ .method = .GET, .url = url, .headers = &.{.{ .name = "Metadata-Flavor", .value = "Google" }}, .max_response_bytes = 16 * 1024 });
        defer response.deinit();
        if (response.status != 200) return error.GoogleIdentityRejected;
        if (!response.metadata_flavor_google) return error.InvalidMetadataFlavor;
        return self.allocator.dupe(u8, response.bytes);
    }
};

pub fn parseAuthorizedUser(allocator: Allocator, bytes: []const u8) !struct { arena: std.heap.ArenaAllocator, config: RefreshConfig } {
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const value = try json(arena.allocator(), bytes);
    const kind = try text(try field(value, "type"));
    if (std.mem.eql(u8, kind, "service_account")) return error.UseServiceAccountParser;
    if (!std.mem.eql(u8, kind, "authorized_user")) return error.UnsupportedGoogleCredentialType;
    return .{ .arena = arena, .config = .{ .client_id = try text(try field(value, "client_id")), .client_secret = try text(try field(value, "client_secret")), .refresh_token = try text(try field(value, "refresh_token")) } };
}
fn form(allocator: Allocator, entries: []const aws.Query) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (entries, 0..) |entry, i| {
        if (i > 0) try out.append(allocator, '&');
        const name = try http.percentEncode(allocator, entry.name, false);
        defer allocator.free(name);
        const value = try http.percentEncode(allocator, entry.value, false);
        defer allocator.free(value);
        try out.appendSlice(allocator, name);
        try out.append(allocator, '=');
        try out.appendSlice(allocator, value);
    }
    return out.toOwnedSlice(allocator);
}

const mock = @import("testing.zig");
fn assertImdsTokenRequest(request: http.Request) !void {
    try std.testing.expectEqualStrings("21600", mock.header(request, "x-aws-ec2-metadata-token-ttl-seconds") orelse return error.MissingImdsTtl);
}
fn assertImdsToken(request: http.Request) !void {
    try std.testing.expectEqualStrings("fixture-imds-token", mock.header(request, "x-aws-ec2-metadata-token") orelse return error.MissingImdsToken);
}
fn assertGoogleFlavor(request: http.Request) !void {
    try std.testing.expectEqualStrings("Google", mock.header(request, "Metadata-Flavor") orelse return error.MissingMetadataFlavor);
}

test "UTC credential expiration validates calendar and explicit environment requires complete pair" {
    try std.testing.expectEqual(@as(u64, 0), try parseUtc("1970-01-01T00:00:00Z"));
    try std.testing.expectEqual(@as(u64, 946684800), try parseUtc("2000-01-01T00:00:00.123Z"));
    for ([_][]const u8{ "2023-02-29T00:00:00Z", "1969-01-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+01:00", "2026-01-01T00:00:60Z" }) |invalid| try std.testing.expectError(error.InvalidCredentialExpiration, parseUtc(invalid));
    var environment = std.process.EnvMap.init(std.testing.allocator);
    defer environment.deinit();
    try std.testing.expectEqual(@as(?AwsCredentials, null), try awsFromEnvironment(std.testing.allocator, &environment));
    try environment.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try std.testing.expectError(error.IncompleteAwsEnvironment, awsFromEnvironment(std.testing.allocator, &environment));
    try environment.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    try environment.put("AWS_SESSION_TOKEN", "session-fixture");
    var credentials = (try awsFromEnvironment(std.testing.allocator, &environment)).?;
    defer credentials.deinit();
    try std.testing.expectEqualStrings("EXAMPLE", credentials.value.access_key_id);
    try std.testing.expectEqualStrings("session-fixture", credentials.value.session_token.?);
}

test "IMDSv2 token role credentials cache and refresh use only injected time and transport" {
    const response = "{\"Code\":\"Success\",\"AccessKeyId\":\"EXAMPLE\",\"SecretAccessKey\":\"public-fixture\",\"Token\":\"session-fixture\",\"Expiration\":\"1970-01-01T01:00:00Z\"}";
    const next = "{\"Code\":\"Success\",\"AccessKeyId\":\"EXAMPLE2\",\"SecretAccessKey\":\"public-fixture2\",\"Token\":\"session-fixture2\",\"Expiration\":\"1970-01-01T02:00:00Z\"}";
    var transport: mock.Mock = .{ .steps = &.{
        .{ .method = .PUT, .suffix = "/latest/api/token", .check = assertImdsTokenRequest, .response = "fixture-imds-token" },
        .{ .method = .GET, .suffix = "/latest/meta-data/iam/security-credentials/", .check = assertImdsToken, .response = "fixture-role\n" },
        .{ .method = .GET, .suffix = "/latest/meta-data/iam/security-credentials/fixture-role", .check = assertImdsToken, .response = response },
        .{ .method = .GET, .suffix = "/latest/meta-data/iam/security-credentials/", .check = assertImdsToken, .response = "fixture-role\n" },
        .{ .method = .GET, .suffix = "/latest/meta-data/iam/security-credentials/fixture-role", .check = assertImdsToken, .response = next },
    } };
    var provider: AwsImds = .{ .allocator = std.testing.allocator, .transport = transport.transport() };
    defer provider.deinit();
    try std.testing.expectEqualStrings("EXAMPLE", (try provider.credentials(0)).access_key_id);
    try std.testing.expectEqualStrings("EXAMPLE", (try provider.credentials(3299)).access_key_id);
    try std.testing.expectEqual(@as(usize, 3), transport.index);
    try std.testing.expectEqualStrings("EXAMPLE2", (try provider.credentials(3300)).access_key_id);
    try transport.expectDone();
    try std.testing.expectError(error.CredentialsExpired, parseAwsCredentials(std.testing.allocator, response, 3600));
    try std.testing.expectError(error.InvalidIdentityResponse, parseAwsCredentials(std.testing.allocator, "[]", 0));
}

test "GCP metadata scopes project cache refresh and response flavor verification" {
    const token = "{\"access_token\":\"fixture-access\",\"expires_in\":3600,\"token_type\":\"Bearer\"}";
    const token_path = "/default/token?enforce_scopes=true&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform";
    var transport: mock.Mock = .{ .steps = &.{
        .{ .method = .GET, .suffix = token_path, .check = assertGoogleFlavor, .response = token, .metadata_flavor_google = true },
        .{ .method = .GET, .suffix = "/project/project-id", .check = assertGoogleFlavor, .response = "fixture-project", .metadata_flavor_google = true },
        .{ .method = .GET, .suffix = "/default/scopes", .check = assertGoogleFlavor, .response = "https://www.googleapis.com/auth/cloud-platform\n", .metadata_flavor_google = true },
        .{ .method = .GET, .suffix = token_path, .check = assertGoogleFlavor, .response = token, .metadata_flavor_google = true },
    } };
    var provider: GcpProvider = .{ .allocator = std.testing.allocator, .transport = transport.transport(), .flow = .{ .metadata = .{ .scopes = &.{"https://www.googleapis.com/auth/cloud-platform"} } } };
    defer provider.deinit();
    try std.testing.expectEqualStrings("fixture-access", try provider.token(0));
    try std.testing.expectEqualStrings("fixture-access", try provider.token(3299));
    const project = try provider.projectId();
    defer std.testing.allocator.free(project);
    try std.testing.expectEqualStrings("fixture-project", project);
    const scopes = try provider.scopes();
    defer std.testing.allocator.free(scopes);
    try std.testing.expect(std.mem.startsWith(u8, scopes, "https://"));
    _ = try provider.token(3300);
    try transport.expectDone();
    var invalid: mock.Mock = .{ .steps = &.{.{ .method = .GET, .suffix = "/default/token", .response = token }} };
    var unsafe: GcpProvider = .{ .allocator = std.testing.allocator, .transport = invalid.transport(), .flow = .{ .metadata = .{} } };
    defer unsafe.deinit();
    try std.testing.expectError(error.InvalidMetadataFlavor, unsafe.token(0));
}

test "authorized-user ADC refresh escapes form secrets and selects the correct credential parser" {
    const allocator = std.testing.allocator;
    const adc = "{\"type\":\"authorized_user\",\"client_id\":\"fixture-client\",\"client_secret\":\"fixture+&secret\",\"refresh_token\":\"fixture/refresh=\"}";
    var parsed = try parseAuthorizedUser(allocator, adc);
    defer parsed.arena.deinit();
    var transport: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/token", .request_body = "grant_type=refresh_token&client_id=fixture-client&client_secret=fixture%2B%26secret&refresh_token=fixture%2Frefresh%3D", .response = "{\"access_token\":\"fixture-access\",\"expires_in\":3600,\"token_type\":\"Bearer\"}" }} };
    var provider: GcpProvider = .{ .allocator = allocator, .transport = transport.transport(), .flow = .{ .authorized_user = parsed.config } };
    defer provider.deinit();
    try std.testing.expectEqualStrings("fixture-access", try provider.token(100));
    try std.testing.expectEqualStrings("fixture-access", try provider.token(200));
    try transport.expectDone();
    try std.testing.expectError(error.UseServiceAccountParser, parseAuthorizedUser(allocator, "{\"type\":\"service_account\"}"));
}

pub const WebIdentityEnvironment = struct { role_arn: []const u8, token_file: []const u8, session_name: ?[]const u8 };
pub fn webIdentityEnvironment(environment: *const std.process.EnvMap) !?WebIdentityEnvironment {
    const role = environment.get("AWS_ROLE_ARN");
    const token_file = environment.get("AWS_WEB_IDENTITY_TOKEN_FILE");
    if (role == null and token_file == null) return null;
    if (role == null or token_file == null or role.?.len == 0 or token_file.?.len == 0) return error.IncompleteWebIdentityEnvironment;
    return .{ .role_arn = role.?, .token_file = token_file.?, .session_name = environment.get("AWS_ROLE_SESSION_NAME") };
}
pub const IdentityTokenSource = struct {
    context: *anyopaque,
    read_fn: *const fn (*anyopaque, Allocator) anyerror![]u8,
    pub fn read(self: IdentityTokenSource, allocator: Allocator) ![]u8 {
        return self.read_fn(self.context, allocator);
    }
};
pub const AwsWebIdentity = struct {
    allocator: Allocator,
    transport: http.Transport,
    token_source: IdentityTokenSource,
    endpoint: []const u8 = "https://sts.amazonaws.com/",
    role_arn: []const u8,
    session_name: []const u8,
    duration_seconds: u32 = 3600,
    refresh_skew: u64 = 300,
    cached: ?AwsCredentials = null,
    pub fn deinit(self: *AwsWebIdentity) void {
        if (self.cached) |*cached| cached.deinit();
        self.* = undefined;
    }
    pub fn credentials(self: *AwsWebIdentity, now: u64) !aws.Credentials {
        if (self.cached) |cached| if (validUntil(cached.expires_at, now, self.refresh_skew)) return cached.value;
        if (self.role_arn.len == 0 or self.session_name.len < 2 or self.session_name.len > 64 or self.duration_seconds < 900 or self.duration_seconds > 43200) return error.InvalidWebIdentityConfiguration;
        for (self.session_name) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "+=,.@_-", byte) == null) return error.InvalidWebIdentityConfiguration;
        const identity = try self.token_source.read(self.allocator);
        defer {
            std.crypto.secureZero(u8, identity);
            self.allocator.free(identity);
        }
        const token = std.mem.trim(u8, identity, " \r\n\t");
        if (token.len == 0 or token.len > 20000 or std.mem.indexOfAny(u8, token, "\r\n\x00") != null) return error.InvalidWebIdentityToken;
        const duration = try std.fmt.allocPrint(self.allocator, "{d}", .{self.duration_seconds});
        defer self.allocator.free(duration);
        const body = try form(self.allocator, &.{ .{ .name = "Action", .value = "AssumeRoleWithWebIdentity" }, .{ .name = "Version", .value = "2011-06-15" }, .{ .name = "RoleArn", .value = self.role_arn }, .{ .name = "RoleSessionName", .value = self.session_name }, .{ .name = "WebIdentityToken", .value = token }, .{ .name = "DurationSeconds", .value = duration } });
        defer {
            std.crypto.secureZero(u8, body);
            self.allocator.free(body);
        }
        var response = try self.transport.send(self.allocator, .{ .method = .POST, .url = self.endpoint, .headers = &.{ .{ .name = "content-type", .value = "application/x-www-form-urlencoded" }, .{ .name = "accept", .value = "application/xml" } }, .body = body, .max_response_bytes = 64 * 1024 });
        defer response.deinit();
        if (response.status != 200) return error.StsIdentityRejected;
        const fresh = try parseStsCredentials(self.allocator, response.bytes, now);
        if (self.cached) |*old| old.deinit();
        self.cached = fresh;
        return fresh.value;
    }
};

/// Deliberately restricted structural parser for the STS Query response, not a
/// general XML engine. Rejects DTD/entity/CDATA/comment constructs entirely;
/// credentials are accepted only at the exact response/result/credentials path.
/// Standard AWS credential values are plain ASCII and need no entity expansion.
pub fn parseStsCredentials(allocator: Allocator, xml: []const u8, now: u64) !AwsCredentials {
    if (xml.len > 64 * 1024 or std.mem.indexOfScalar(u8, xml, '&') != null or std.mem.indexOf(u8, xml, "<!") != null) return error.UnsupportedStsXml;
    const field_names = [_][]const u8{ "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration" };
    var fields: [4]?[]const u8 = @splat(null);
    var stack: [32][]const u8 = undefined;
    var depth: usize = 0;
    var cursor: usize = 0;
    var seen_root = false;
    while (cursor < xml.len) {
        const next = std.mem.indexOfPos(u8, xml, cursor, "<") orelse xml.len;
        if (depth == 0 and std.mem.trim(u8, xml[cursor..next], " \t\r\n").len != 0) return error.InvalidStsXml;
        const response_name: []const u8 = if (depth != 0 and std.mem.eql(u8, stack[0], "AssumeRoleResponse")) "AssumeRoleResponse" else "AssumeRoleWithWebIdentityResponse";
        const result_name: []const u8 = if (std.mem.eql(u8, response_name, "AssumeRoleResponse")) "AssumeRoleResult" else "AssumeRoleWithWebIdentityResult";
        if (depth == 4 and std.mem.eql(u8, stack[0], response_name) and std.mem.eql(u8, stack[1], result_name) and std.mem.eql(u8, stack[2], "Credentials")) {
            for (field_names, 0..) |name, i| if (std.mem.eql(u8, name, stack[3])) {
                if (fields[i] != null) return error.InvalidStsXml;
                const value = std.mem.trim(u8, xml[cursor..next], " \t\r\n");
                if (value.len == 0 or std.mem.indexOfAny(u8, value, "\r\n\x00") != null) return error.InvalidStsXml;
                fields[i] = value;
            };
        }
        if (next == xml.len) {
            cursor = next;
            break;
        }
        var end = next + 1;
        var quote: ?u8 = null;
        while (end < xml.len) : (end += 1) {
            const byte = xml[end];
            if (quote) |q| {
                if (byte == q) quote = null;
            } else if (byte == '\'' or byte == '"') {
                quote = byte;
            } else if (byte == '>') {
                break;
            } else if (byte == '<') return error.InvalidStsXml;
        }
        if (end == xml.len) return error.InvalidStsXml;
        const raw = std.mem.trim(u8, xml[next + 1 .. end], " \t\r\n");
        cursor = end + 1;
        if (std.mem.startsWith(u8, raw, "?xml ") and std.mem.endsWith(u8, raw, "?")) {
            if (seen_root or depth != 0) return error.InvalidStsXml;
            continue;
        }
        if (raw.len == 0 or raw[0] == '?' or raw[0] == '!') return error.InvalidStsXml;
        if (raw[0] == '/') {
            const name = std.mem.trim(u8, raw[1..], " \t\r\n");
            if (depth == 0 or !std.mem.eql(u8, name, stack[depth - 1])) return error.InvalidStsXml;
            depth -= 1;
            continue;
        }
        const name_end = std.mem.indexOfAny(u8, raw, " \t\r\n/") orelse raw.len;
        const name = raw[0..name_end];
        if (name.len == 0) return error.InvalidStsXml;
        for (name) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '_') return error.UnsupportedStsXml;
        if (depth == 0) {
            if (seen_root or (!std.mem.eql(u8, name, "AssumeRoleWithWebIdentityResponse") and !std.mem.eql(u8, name, "AssumeRoleResponse"))) return error.InvalidStsXml;
            seen_root = true;
        }
        if (depth == stack.len) return error.InvalidStsXml;
        stack[depth] = name;
        depth += 1;
        if (std.mem.endsWith(u8, raw, "/")) depth -= 1;
    }
    if (depth != 0 or !seen_root) return error.InvalidStsXml;
    for (fields) |value| if (value == null) return error.InvalidStsXml;
    const expiration = try parseUtc(fields[3].?);
    if (expiration <= now) return error.CredentialsExpired;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const temp = arena.allocator();
    const credentials: aws.Credentials = .{ .access_key_id = try temp.dupe(u8, fields[0].?), .secret_access_key = try temp.dupe(u8, fields[1].?), .session_token = try temp.dupe(u8, fields[2].?) };
    return .{ .arena = arena, .value = credentials, .expires_at = expiration };
}

const sts_fixture = "<?xml version=\"1.0\"?><AssumeRoleWithWebIdentityResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>EXAMPLE</AccessKeyId><SecretAccessKey>public-fixture</SecretAccessKey><SessionToken>session-fixture</SessionToken><Expiration>1970-01-01T01:00:00Z</Expiration></Credentials><SubjectFromWebIdentityToken>fixture-subject</SubjectFromWebIdentityToken></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>";
const TestIdentitySource = struct {
    reads: usize = 0,
    fn read(context: *anyopaque, allocator: Allocator) ![]u8 {
        const self: *TestIdentitySource = @ptrCast(@alignCast(context));
        self.reads += 1;
        return allocator.dupe(u8, "fixture.jwt.token\n");
    }
};

test "STS web identity form uses rotated injected token and caches temporary credentials" {
    var source: TestIdentitySource = .{};
    var transport: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/", .request_body = "Action=AssumeRoleWithWebIdentity&Version=2011-06-15&RoleArn=arn%3Aaws%3Aiam%3A%3A000000000000%3Arole%2Ffixture&RoleSessionName=zig-fixture&WebIdentityToken=fixture.jwt.token&DurationSeconds=3600", .response = sts_fixture }} };
    var provider: AwsWebIdentity = .{ .allocator = std.testing.allocator, .transport = transport.transport(), .token_source = .{ .context = &source, .read_fn = TestIdentitySource.read }, .role_arn = "arn:aws:iam::000000000000:role/fixture", .session_name = "zig-fixture" };
    defer provider.deinit();
    try std.testing.expectEqualStrings("EXAMPLE", (try provider.credentials(0)).access_key_id);
    try std.testing.expectEqualStrings("session-fixture", (try provider.credentials(100)).session_token.?);
    try std.testing.expectEqual(@as(usize, 1), source.reads);
    try transport.expectDone();
    var environment = std.process.EnvMap.init(std.testing.allocator);
    defer environment.deinit();
    try environment.put("AWS_ROLE_ARN", provider.role_arn);
    try std.testing.expectError(error.IncompleteWebIdentityEnvironment, webIdentityEnvironment(&environment));
    try environment.put("AWS_WEB_IDENTITY_TOKEN_FILE", "/injected/fixture-only.jwt");
    try std.testing.expectEqualStrings(provider.role_arn, (try webIdentityEnvironment(&environment)).?.role_arn);
}

test "STS structural parser rejects duplicate credential fields unbalanced XML and entities" {
    var valid = try parseStsCredentials(std.testing.allocator, sts_fixture, 0);
    defer valid.deinit();
    try std.testing.expectEqualStrings("EXAMPLE", valid.value.access_key_id);
    for (0..sts_fixture.len) |len| {
        if (parseStsCredentials(std.testing.allocator, sts_fixture[0..len], 0)) |result| {
            var owned = result;
            owned.deinit();
            return error.AcceptedTruncatedStsXml;
        } else |_| {}
    }
    try std.testing.expectError(error.UnsupportedStsXml, parseStsCredentials(std.testing.allocator, "<!DOCTYPE x SYSTEM 'file:///private'>", 0));
    try std.testing.expectError(error.UnsupportedStsXml, parseStsCredentials(std.testing.allocator, "<x>&external;</x>", 0));
    try std.testing.expectError(error.InvalidStsXml, parseStsCredentials(std.testing.allocator, "<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>a</AccessKeyId><AccessKeyId>b</AccessKeyId></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>", 0));
}

/// ECS/Fargate credentials, the middle source in the Rust AWS provider chain.
/// Endpoint/token selection is explicit; HttpTransport restricts cleartext to
/// its metadata allowlist. No full-URI/file/env discovery occurs implicitly.
pub const AwsContainer = struct {
    allocator: Allocator,
    transport: http.Transport,
    endpoint: []const u8,
    authorization_token: ?[]const u8 = null,
    refresh_skew: u64 = 300,
    cached: ?AwsCredentials = null,
    pub fn deinit(self: *AwsContainer) void {
        if (self.cached) |*cached| cached.deinit();
        self.* = undefined;
    }
    pub fn credentials(self: *AwsContainer, now: u64) !aws.Credentials {
        if (self.cached) |cached| if (validUntil(cached.expires_at, now, self.refresh_skew)) return cached.value;
        var headers: [1]http.Header = undefined;
        if (self.authorization_token) |token| headers[0] = .{ .name = "authorization", .value = token };
        var response = try self.transport.send(self.allocator, .{ .method = .GET, .url = self.endpoint, .headers = if (self.authorization_token != null) headers[0..1] else headers[0..0], .max_response_bytes = 16 * 1024 });
        defer response.deinit();
        if (response.status != 200) return error.ContainerCredentialsRejected;
        const fresh = try parseAwsCredentials(self.allocator, response.bytes, now);
        if (self.cached) |*old| old.deinit();
        self.cached = fresh;
        return fresh.value;
    }
};

pub fn containerEndpointFromEnvironment(allocator: Allocator, environment: *const std.process.EnvMap) !?[]u8 {
    if (environment.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")) |relative| {
        if (relative.len == 0 or relative[0] != '/' or std.mem.indexOfAny(u8, relative, "\r\n\x00") != null) return error.InvalidContainerEndpoint;
        return try std.fmt.allocPrint(allocator, "http://169.254.170.2{s}", .{relative});
    }
    if (environment.get("AWS_CONTAINER_CREDENTIALS_FULL_URI")) |full| {
        const uri = try std.Uri.parse(full);
        if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null) return error.InvalidContainerEndpoint;
        if (!std.mem.eql(u8, uri.scheme, "https")) {
            var host_buffer: [std.Uri.host_name_max]u8 = undefined;
            const host = try uri.getHost(&host_buffer);
            if (!std.mem.eql(u8, uri.scheme, "http") or (!std.mem.eql(u8, host, "169.254.170.2") and !std.mem.eql(u8, host, "169.254.170.23") and !std.mem.eql(u8, host, "127.0.0.1") and !std.mem.eql(u8, host, "::1"))) return error.InvalidContainerEndpoint;
        }
        return try allocator.dupe(u8, full);
    }
    return null;
}

test "ECS container credentials are cached and full URI cleartext is explicitly constrained" {
    var environment = std.process.EnvMap.init(std.testing.allocator);
    defer environment.deinit();
    try environment.put("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/fixture");
    const endpoint = (try containerEndpointFromEnvironment(std.testing.allocator, &environment)).?;
    defer std.testing.allocator.free(endpoint);
    try std.testing.expectEqualStrings("http://169.254.170.2/v2/credentials/fixture", endpoint);
    var transport: mock.Mock = .{ .steps = &.{.{ .method = .GET, .suffix = "/v2/credentials/fixture", .response = "{\"AccessKeyId\":\"EXAMPLE\",\"SecretAccessKey\":\"public-fixture\",\"Token\":\"session-fixture\",\"Expiration\":\"1970-01-01T01:00:00Z\"}" }} };
    var provider: AwsContainer = .{ .allocator = std.testing.allocator, .transport = transport.transport(), .endpoint = endpoint };
    defer provider.deinit();
    try std.testing.expectEqualStrings("EXAMPLE", (try provider.credentials(0)).access_key_id);
    _ = try provider.credentials(100);
    try transport.expectDone();
    environment.remove("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI");
    try environment.put("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://untrusted.example/credentials");
    try std.testing.expectError(error.InvalidContainerEndpoint, containerEndpointFromEnvironment(std.testing.allocator, &environment));
}

const ServiceAccountWire = struct {
    type: []const u8,
    private_key: []u8,
    private_key_id: ?[]const u8 = null,
    client_email: []const u8,
    token_uri: []const u8 = "https://oauth2.googleapis.com/token",
};
pub const ParsedServiceAccount = struct {
    parsed: std.json.Parsed(ServiceAccountWire),
    config: ServiceAccountConfig,
    pub fn deinit(self: *ParsedServiceAccount) void {
        std.crypto.secureZero(u8, self.parsed.value.private_key);
        self.parsed.deinit();
        self.* = undefined;
    }
};
/// Parses supplied ADC bytes only; no filesystem/env lookup. Private PEM bytes
/// in the successful parsed document are owned mutable memory, wiped on deinit.
/// The caller retains responsibility for the original input byte buffer.
pub fn parseServiceAccount(allocator: Allocator, bytes: []const u8, signer: *rs256.Signer, scope: []const u8) !ParsedServiceAccount {
    if (bytes.len > 64 * 1024) return error.CredentialDocumentTooLarge;
    var parsed = try std.json.parseFromSlice(ServiceAccountWire, allocator, bytes, .{ .allocate = .alloc_always, .ignore_unknown_fields = true, .max_value_len = 32 * 1024 });
    errdefer {
        std.crypto.secureZero(u8, parsed.value.private_key);
        parsed.deinit();
    }
    const value = parsed.value;
    if (!std.mem.eql(u8, value.type, "service_account")) return error.UnsupportedGoogleCredentialType;
    if (value.private_key.len == 0 or value.private_key.len > 32 * 1024) return error.InvalidServiceAccountKey;
    try rs256.validateClaims(.{ .issuer = value.client_email, .scope = scope, .audience = value.token_uri, .issued_at = 0, .expires_at = 3600, .key_id = value.private_key_id });
    return .{ .parsed = parsed, .config = .{ .signer = signer, .client_email = value.client_email, .private_key_pem = value.private_key, .private_key_id = value.private_key_id, .scope = scope, .audience = value.token_uri, .endpoint = value.token_uri } };
}

const JwtExchangeCheck = struct {
    expected: []const u8,
    calls: usize = 0,
    fn send(context: *anyopaque, allocator: Allocator, request: http.Request) !http.Response {
        const self: *JwtExchangeCheck = @ptrCast(@alignCast(context));
        self.calls += 1;
        try std.testing.expectEqual(std.http.Method.POST, request.method);
        try std.testing.expectEqualStrings("https://oauth2.googleapis.com/token", request.url);
        try std.testing.expectEqualStrings("application/x-www-form-urlencoded", mock.header(request, "content-type") orelse return error.MissingOAuthContentType);
        const expected_body = try form(allocator, &.{ .{ .name = "grant_type", .value = "urn:ietf:params:oauth:grant-type:jwt-bearer" }, .{ .name = "assertion", .value = self.expected } });
        defer allocator.free(expected_body);
        try std.testing.expectEqualStrings(expected_body, request.body orelse return error.MissingOAuthBody);
        return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, "{\"access_token\":\"fixture-service-account-token\",\"expires_in\":3600,\"token_type\":\"Bearer\"}") };
    }
};

test "opt-in service-account ADC JWT exchange matches external signature and caches token" {
    const allocator = std.testing.allocator;
    const library = std.process.getEnvVarOwned(allocator, "HYPERLANE_LIBCRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(library);
    const fixture = try std.process.getEnvVarOwned(allocator, "HYPERLANE_TEST_RSA_FIXTURE_DIR");
    defer allocator.free(fixture);
    var directory = try std.fs.openDirAbsolute(fixture, .{});
    defer directory.close();
    const bytes = try directory.readFileAlloc(allocator, "service-account.json", 64 * 1024);
    defer {
        std.crypto.secureZero(u8, bytes);
        allocator.free(bytes);
    }
    var signer = try rs256.Signer.init(allocator, library);
    defer signer.deinit();
    var parsed = try parseServiceAccount(allocator, bytes, &signer, "https://www.googleapis.com/auth/cloud-platform");
    defer parsed.deinit();
    const expected_jwt = try directory.readFileAlloc(allocator, "jwt.txt", 16384);
    defer allocator.free(expected_jwt);
    var check: JwtExchangeCheck = .{ .expected = expected_jwt };
    var provider: GcpProvider = .{ .allocator = allocator, .transport = .{ .context = &check, .send_fn = JwtExchangeCheck.send }, .flow = .{ .service_account = parsed.config } };
    defer provider.deinit();
    try std.testing.expectEqualStrings("fixture-service-account-token", try provider.token(1000));
    try std.testing.expectEqualStrings("fixture-service-account-token", try provider.token(2000));
    try std.testing.expectEqual(@as(usize, 1), check.calls);
}

/// RFC3339 credentials returned by external processes and SSO cache, including
/// explicit offsets. Metadata/STS parseUtc remains strict UTC.
pub fn parseRfc3339(input: []const u8) !u64 {
    if (input.len < 20) return error.InvalidCredentialExpiration;
    if (input[input.len - 1] == 'Z') return parseUtc(input);
    if (input.len < 25) return error.InvalidCredentialExpiration;
    const n = input.len;
    if ((input[n - 6] != '+' and input[n - 6] != '-') or input[n - 3] != ':') return error.InvalidCredentialExpiration;
    const hours = std.fmt.parseInt(u8, input[n - 5 .. n - 3], 10) catch return error.InvalidCredentialExpiration;
    const minutes = std.fmt.parseInt(u8, input[n - 2 .. n], 10) catch return error.InvalidCredentialExpiration;
    if (hours > 23 or minutes > 59 or n > 64) return error.InvalidCredentialExpiration;
    var buffer: [64]u8 = undefined;
    @memcpy(buffer[0 .. n - 6], input[0 .. n - 6]);
    buffer[n - 6] = 'Z';
    const seconds = try parseUtc(buffer[0 .. n - 5]);
    const offset = @as(u64, hours) * 3600 + @as(u64, minutes) * 60;
    return if (input[n - 6] == '+') std.math.sub(u64, seconds, offset) catch error.InvalidCredentialExpiration else std.math.add(u64, seconds, offset) catch error.InvalidCredentialExpiration;
}
pub fn amzDate(buffer: *[16]u8, seconds: u64) !void {
    if (seconds > 253402300799) return error.InvalidCredentialClock;
    const epoch: std.time.epoch.EpochSeconds = .{ .secs = seconds };
    const date = epoch.getEpochDay().calculateYearDay();
    const month = date.calculateMonthDay();
    const time = epoch.getDaySeconds();
    _ = try std.fmt.bufPrint(buffer, "{d:0>4}{d:0>2}{d:0>2}T{d:0>2}{d:0>2}{d:0>2}Z", .{ date.year, @intFromEnum(month.month), @as(u16, month.day_index) + 1, time.getHoursIntoDay(), time.getMinutesIntoHour(), time.getSecondsIntoMinute() });
}
pub fn assumeRole(a: Allocator, transport: http.Transport, credentials: aws.Credentials, config: struct { endpoint: []const u8 = "https://sts.amazonaws.com/", region: []const u8 = "us-east-1", role_arn: []const u8, session_name: []const u8, external_id: ?[]const u8 = null }, now: u64) !AwsCredentials {
    if (config.role_arn.len == 0 or config.session_name.len < 2 or config.session_name.len > 64) return error.InvalidAssumeRoleConfiguration;
    for (config.session_name) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "+=,.@_-", byte) == null) return error.InvalidAssumeRoleConfiguration;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    var entries: std.ArrayList(aws.Query) = .empty;
    try entries.appendSlice(temporary, &.{ .{ .name = "Action", .value = "AssumeRole" }, .{ .name = "Version", .value = "2011-06-15" }, .{ .name = "RoleArn", .value = config.role_arn }, .{ .name = "RoleSessionName", .value = config.session_name } });
    if (config.external_id) |external_id| try entries.append(temporary, .{ .name = "ExternalId", .value = external_id });
    const body = try form(temporary, entries.items);
    const uri = try std.Uri.parse(config.endpoint);
    if (uri.user != null or uri.password != null or uri.query != null or uri.fragment != null or !std.mem.eql(u8, uri.scheme, "https") or uri.host == null) return error.InvalidAssumeRoleEndpoint;
    const host = try uri.host.?.toRawMaybeAlloc(temporary);
    const authority = if (uri.port) |port| try std.fmt.allocPrint(temporary, "{s}:{d}", .{ host, port }) else host;
    const path = try uri.path.toRawMaybeAlloc(temporary);
    var date: [16]u8 = undefined;
    try amzDate(&date, now);
    var signed = try aws.sign(a, .{ .method = .POST, .host = authority, .path = if (path.len == 0) "/" else path, .body = body, .amz_date = &date, .region = config.region, .service = "sts", .credentials = credentials, .headers = &.{.{ .name = "content-type", .value = "application/x-www-form-urlencoded" }} });
    defer signed.deinit();
    var response = try transport.send(a, .{ .method = .POST, .url = config.endpoint, .headers = signed.headers, .body = body, .max_response_bytes = 64 * 1024 });
    defer response.deinit();
    if (response.status != 200) return error.StsAssumeRoleRejected;
    return parseStsCredentials(a, response.bytes, now);
}
test "profile credential RFC3339 offsets and signed AssumeRole use exact STS structural path" {
    try std.testing.expectEqual(@as(u64, 0), try parseRfc3339("1970-01-01T01:30:00.123+01:30"));
    try std.testing.expectEqual(@as(u64, 3600), try parseRfc3339("1970-01-01T00:00:00-01:00"));
    try std.testing.expectError(error.InvalidCredentialExpiration, parseRfc3339("1970-01-01T00:00:00+01:00"));
    const wire = "<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ROLE</AccessKeyId><SecretAccessKey>public-secret</SecretAccessKey><SessionToken>public-token</SessionToken><Expiration>1970-01-01T01:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>";
    var network: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "sts.amazonaws.com/", .request_body = "Action=AssumeRole&Version=2011-06-15&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ffixture&RoleSessionName=fixture&ExternalId=public%2Bexternal", .response = wire, .check = assertRoleSigned }} };
    var credentials = try assumeRole(std.testing.allocator, network.transport(), .{ .access_key_id = "BASE", .secret_access_key = "public-secret" }, .{ .role_arn = "arn:aws:iam::123456789012:role/fixture", .session_name = "fixture", .external_id = "public+external" }, 0);
    defer credentials.deinit();
    try std.testing.expectEqualStrings("ROLE", credentials.value.access_key_id);
    try network.expectDone();
}
fn assertRoleSigned(request: http.Request) !void {
    const authorization = mock.header(request, "authorization") orelse return error.MissingRoleAuthorization;
    try std.testing.expect(std.mem.indexOf(u8, authorization, "Credential=BASE/19700101/us-east-1/sts/aws4_request") != null);
}
