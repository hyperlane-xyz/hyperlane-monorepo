const std = @import("std");
const profile = @import("aws_profile.zig");
const http = @import("http.zig");
const mock = @import("testing.zig");
const io = @import("credential_io.zig");
const command = @import("command.zig");
const rpc = @import("../net/json_rpc.zig");
const A = std.mem.Allocator;
const Files = struct {
    config: []const u8,
    credentials: ?[]const u8 = null,
    token: ?[]const u8 = null,
    cache: ?[]u8 = null,
    writes: usize = 0,
    reject_write: bool = false,
    fn deinit(self: *Files, a: A) void {
        if (self.cache) |bytes| a.free(bytes);
    }
    fn reader(self: *Files) io.Reader {
        return .{ .context = self, .read_fn = read };
    }
    fn writer(self: *Files) io.Writer {
        return .{ .context = self, .write_fn = write };
    }
    fn read(context: ?*anyopaque, a: A, path: []const u8, _: usize) !?[]u8 {
        const self: *Files = @ptrCast(@alignCast(context.?));
        const wire = if (std.mem.eql(u8, path, "/fixture/config")) self.config else if (std.mem.eql(u8, path, "/fixture/credentials")) self.credentials else if (std.mem.indexOf(u8, path, "/.aws/sso/cache/") != null) self.cache orelse self.token else if (std.mem.eql(u8, path, "/fixture/token")) self.token else null;
        return if (wire) |bytes| try a.dupe(u8, bytes) else null;
    }
    fn write(context: ?*anyopaque, a: A, path: []const u8, bytes: []const u8) !void {
        const self: *Files = @ptrCast(@alignCast(context.?));
        try std.testing.expect(std.mem.indexOf(u8, path, "/.aws/sso/cache/") != null);
        self.writes += 1;
        if (self.reject_write) return error.FixtureCacheWriteRejected;
        const next = try a.dupe(u8, bytes);
        if (self.cache) |old| a.free(old);
        self.cache = next;
    }
};
const Process = struct {
    calls: usize = 0,
    result: []const u8,
    fn run(context: ?*anyopaque, a: A, text: []const u8, env: *const std.process.EnvMap, limits: command.Limits) ![]u8 {
        const self: *Process = @ptrCast(@alignCast(context.?));
        self.calls += 1;
        try std.testing.expectEqualStrings("fixture-process --flag", text);
        try std.testing.expectEqualStrings("fixture-value", env.get("CUSTOM_PROVIDER_INPUT").?);
        try std.testing.expectEqual(@as(u32, 1234), limits.timeout_ms);
        return a.dupe(u8, self.result);
    }
};
fn environment(a: A) !std.process.EnvMap {
    var result = std.process.EnvMap.init(a);
    errdefer result.deinit();
    try result.put("HOME", "/fixture");
    try result.put("AWS_CONFIG_FILE", "/fixture/config");
    try result.put("AWS_SHARED_CREDENTIALS_FILE", "/fixture/credentials");
    return result;
}
fn roleResponse(a: A, name: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>{s}</AccessKeyId><SecretAccessKey>public-secret</SecretAccessKey><SessionToken>public-token</SessionToken><Expiration>1970-01-01T01:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>", .{name});
}
test "AWS profile resolves Source nested role chain self static preference and credentials-file override" {
    const a = std.testing.allocator;
    var env = try environment(a);
    defer env.deinit();
    try env.put("AWS_PROFILE", "top");
    var files: Files = .{ .config = "[profile top]\nrole_arn=arn:aws:iam::123456789012:role/top\nsource_profile=middle\nrole_session_name=top-session\n[profile middle]\nrole_arn=arn:aws:iam::123456789012:role/middle\nsource_profile=base\n[profile base]\naws_access_key_id=CONFIG\naws_secret_access_key=config-secret\n", .credentials = "[base]\naws_access_key_id=BASE\naws_secret_access_key=public-base\n" };
    defer files.deinit(a);
    const first = try roleResponse(a, "MIDDLE");
    defer a.free(first);
    const second = try roleResponse(a, "TOP");
    defer a.free(second);
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "sts.amazonaws.com/", .check = checkBase, .response = first }, .{ .method = .POST, .suffix = "sts.amazonaws.com/", .check = checkMiddle, .response = second } } };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = (try profile.Provider.open(a, .{ .environment = &env, .reader = files.reader(), .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner })).?;
    defer provider.deinit();
    try std.testing.expectEqualStrings("TOP", (try provider.credentials(0)).access_key_id);
    try std.testing.expectEqualStrings("TOP", (try provider.credentials(100)).access_key_id);
    try network.expectDone();
}
fn checkBase(request: http.Request) !void {
    try std.testing.expect(std.mem.indexOf(u8, mock.header(request, "authorization").?, "Credential=BASE/") != null);
}
fn checkMiddle(request: http.Request) !void {
    try std.testing.expect(std.mem.indexOf(u8, mock.header(request, "authorization").?, "Credential=MIDDLE/") != null);
}
test "AWS profile process credentials are bounded cached case-insensitive and refreshed at expiration" {
    const a = std.testing.allocator;
    var env = try environment(a);
    defer env.deinit();
    try env.put("CUSTOM_PROVIDER_INPUT", "fixture-value");
    var files: Files = .{ .config = "[default]\ncredential_process=fixture-process --flag\n" };
    var process: Process = .{ .result = "{\"version\":1,\"ACCESSKEYID\":\"PROCESS\",\"SecretAccessKey\":\"public-secret\",\"Expiration\":\"1970-01-01T02:00:00+01:00\"}" };
    var network: mock.Mock = .{ .steps = &.{} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    owner.timeout_ms = 1234;
    const provider = (try profile.Provider.open(a, .{ .environment = &env, .reader = files.reader(), .runner = .{ .context = &process, .run_fn = Process.run }, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner })).?;
    defer provider.deinit();
    try std.testing.expectEqualStrings("PROCESS", (try provider.credentials(0)).access_key_id);
    _ = try provider.credentials(3000);
    try std.testing.expectEqual(@as(usize, 1), process.calls);
    process.result = "{\"Version\":1,\"AccessKeyId\":\"ROTATED\",\"SecretAccessKey\":\"public-next\"}";
    try std.testing.expectEqualStrings("ROTATED", (try provider.credentials(3500)).access_key_id);
    _ = try provider.credentials(100000);
    try std.testing.expectEqual(@as(usize, 2), process.calls);
    try std.testing.expectError(error.AmbiguousAwsCredentialResponse, profile.parseProcess(a, "{\"Version\":1,\"version\":1,\"AccessKeyId\":\"a\",\"SecretAccessKey\":\"b\"}", 0));
    try std.testing.expectError(error.CredentialsExpired, profile.parseProcess(a, "{\"Version\":1,\"AccessKeyId\":\"a\",\"SecretAccessKey\":\"b\",\"Expiration\":\"1970-01-01T00:00:00Z\"}", 0));
    try network.expectDone();
}
test "AWS profile rejects cycles unknown named sources conflicting chains and permits credentials-free default fallback" {
    const a = std.testing.allocator;
    var env = try environment(a);
    defer env.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const cases = [_]struct { wire: []const u8, expected: ?anyerror }{
        .{ .wire = "[default]\nregion=us-east-1\n", .expected = null },
        .{ .wire = "[default]\nrole_arn=role\nsource_profile=two\n[profile two]\nrole_arn=role\nsource_profile=default\n", .expected = error.AwsProfileCycle },
        .{ .wire = "[default]\nrole_arn=role\nsource_profile=two\ncredential_source=Environment\n", .expected = error.InvalidAwsCredentialSource },
        .{ .wire = "[default]\ncredential_source=Unknown\n", .expected = error.UnknownAwsCredentialSource },
        .{ .wire = "[default]\nweb_identity_token_file=/fixture/token\n", .expected = error.InvalidAwsCredentialSource },
        .{ .wire = "[default]\nrole_arn=role\nsource_profile=absent\n", .expected = error.MissingAwsProfile },
        .{ .wire = "[default]\nrole_arn=role\nsource_profile=two\n[profile two]\nregion=us-east-1\n", .expected = error.InvalidAwsCredentialSource },
    };
    for (cases) |case| {
        var files: Files = .{ .config = case.wire };
        const result = profile.Provider.open(a, .{ .environment = &env, .reader = files.reader(), .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner });
        if (case.expected) |expected| try std.testing.expectError(expected, result) else try std.testing.expect((try result) == null);
    }
    try network.expectDone();
}
test "AWS profile SSO refresh writes rotated session cache before role credentials and preserves old cache after write failure" {
    const a = std.testing.allocator;
    var env = try environment(a);
    defer env.deinit();
    var files: Files = .{ .config = "[default]\nsso_session=dev\nsso_account_id=123456789012\nsso_role_name=Read Only\n[sso-session dev]\nsso_region=us-east-1\nsso_start_url=https://public.awsapps.com/start\n", .token = "{\"accessToken\":\"old-public\",\"expiresAt\":\"1970-01-01T00:10:00Z\",\"clientId\":\"client\",\"clientSecret\":\"public-client-secret\",\"refreshToken\":\"old-refresh\",\"registrationExpiresAt\":\"1970-01-01T02:00:00Z\"}", .reject_write = true };
    defer files.deinit(a);
    const refresh = "{\"accessToken\":\"new-public\",\"expiresIn\":3600,\"refreshToken\":\"new-refresh\"}";
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "oidc.us-east-1.amazonaws.com/token", .response = refresh }, .{ .method = .POST, .suffix = "oidc.us-east-1.amazonaws.com/token", .response = refresh }, .{ .method = .GET, .suffix = "/federation/credentials?account_id=123456789012&role_name=Read%20Only", .check = checkSso, .response = "{\"roleCredentials\":{\"accessKeyId\":\"SSO\",\"secretAccessKey\":\"public-role-secret\",\"sessionToken\":\"role-session\",\"expiration\":4600000}}" } } };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = (try profile.Provider.open(a, .{ .environment = &env, .reader = files.reader(), .writer = files.writer(), .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner })).?;
    defer provider.deinit();
    try std.testing.expectError(error.FixtureCacheWriteRejected, provider.credentials(1000));
    try std.testing.expectEqual(@as(usize, 1), files.writes);
    try std.testing.expect(files.cache == null);
    files.reject_write = false;
    try std.testing.expectEqualStrings("SSO", (try provider.credentials(1000)).access_key_id);
    try std.testing.expectEqual(@as(usize, 2), files.writes);
    var parsed = try std.json.parseFromSlice(std.json.Value, a, files.cache.?, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("new-refresh", try rpc.string(try rpc.field(parsed.value, "refreshToken")));
    try std.testing.expectEqualStrings("1970-01-01T01:16:40Z", try rpc.string(try rpc.field(parsed.value, "expiresAt")));
    _ = try provider.credentials(1100);
    try network.expectDone();
}
fn checkSso(request: http.Request) !void {
    try std.testing.expectEqualStrings("new-public", mock.header(request, "x-amz-sso_bearer_token").?);
}

test "AWS profile SDK environment skips partial pairs uses actual fallback secret and trims only session token" {
    const a = std.testing.allocator;
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("AWS_ACCESS_KEY_ID", "PUBLIC");
    try std.testing.expect((try profile.sdkEnvironment(a, &env)) == null);
    try env.put("AWS_SECRET_ACCESS_KEY", "  ");
    try env.put("SECRET_ACCESS_KEY", "public-fallback");
    try env.put("AWS_SESSION_TOKEN", "  public-session \n");
    var credentials = (try profile.sdkEnvironment(a, &env)).?;
    defer credentials.deinit();
    try std.testing.expectEqualStrings("PUBLIC", credentials.value.access_key_id);
    try std.testing.expectEqualStrings("public-fallback", credentials.value.secret_access_key);
    try std.testing.expectEqualStrings("public-session", credentials.value.session_token.?);
}
fn allocationProfile(a: A) !void {
    var env = try environment(a);
    defer env.deinit();
    var files: Files = .{ .config = "[default]\nrole_arn=arn:aws:iam::123456789012:role/test\nsource_profile=base\n[profile base]\naws_access_key_id=BASE\naws_secret_access_key=public-secret\n" };
    var network: mock.Mock = .{ .steps = &.{} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = (try profile.Provider.open(a, .{ .environment = &env, .reader = files.reader(), .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner })).?;
    defer provider.deinit();
}
test "AWS profile every allocation failure preserves recursive provider document ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationProfile, .{});
}
