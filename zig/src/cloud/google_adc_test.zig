const std = @import("std");
const adc = @import("google_adc.zig");
const http = @import("http.zig");
const io = @import("credential_io.zig");
const command = @import("command.zig");
const mock = @import("testing.zig");
const rpc = @import("../net/json_rpc.zig");
const A = std.mem.Allocator;
const sts = "{\"access_token\":\"federated-public\",\"issued_token_type\":\"urn:ietf:params:oauth:token-type:access_token\",\"token_type\":\"Bearer\",\"expires_in\":3600}";
const Fields = struct {
    reads: usize = 0,
    bytes: []const u8,
    missing: bool = false,
    fn reader(self: *Fields) io.Reader {
        return .{ .context = self, .read_fn = read };
    }
    fn read(ctx: ?*anyopaque, a: A, _: []const u8, _: usize) !?[]u8 {
        const self: *Fields = @ptrCast(@alignCast(ctx.?));
        self.reads += 1;
        return if (self.missing) null else try a.dupe(u8, self.bytes);
    }
};
const Process = struct {
    calls: usize = 0,
    fn execute(ctx: ?*anyopaque, a: A, argv: []const []const u8, environment: *const std.process.EnvMap, limits: command.Limits) ![]u8 {
        const self: *Process = @ptrCast(@alignCast(ctx.?));
        self.calls += 1;
        try std.testing.expectEqual(@as(usize, 2), argv.len);
        try std.testing.expectEqualStrings("fixture-command", argv[0]);
        try std.testing.expectEqualStrings("--flag", argv[1]);
        try std.testing.expectEqualStrings("1", environment.get("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES").?);
        try std.testing.expectEqual(@as(u32, 1234), limits.timeout_ms);
        return a.dupe(u8, "{\"version\":1,\"success\":true,\"token_type\":\"urn:ietf:params:oauth:token-type:jwt\",\"id_token\":\"public+token\",\"expiration_time\":5000}");
    }
};
fn checkSts(request: http.Request) !void {
    const body = request.body orelse return error.MissingGoogleExchange;
    try std.testing.expect(std.mem.indexOf(u8, body, "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "subject_token=public%2Btoken") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "audience=%2F%2Fiam.googleapis.com%2Fprojects%2Fp%2Flocations%2Fglobal%2FworkloadIdentityPools%2Fw%2Fproviders%2Fi") != null);
}
const file_config = "{\"type\":\"external_account\",\"audience\":\"//iam.googleapis.com/projects/p/locations/global/workloadIdentityPools/w/providers/i\",\"subject_token_type\":\"urn:ietf:params:oauth:token-type:jwt\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"credential_source\":{\"file\":\"/fixture/subject\",\"format\":{\"type\":\"json\",\"subject_token_field_name\":\"token\"}}}";
test "Google ADC file federation exchanges actual STS grant caches token and refreshes injected subject" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var files: Fields = .{ .bytes = "{\"token\":\"public+token\"}" };
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkSts, .response = sts }, .{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkSts, .response = sts } } };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = try adc.Provider.open(a, file_config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner, .reader = files.reader() });
    defer provider.deinit();
    try std.testing.expectEqualStrings("federated-public", try provider.token(0));
    _ = try provider.token(100);
    try std.testing.expectEqual(@as(usize, 1), files.reads);
    _ = try provider.token(3500);
    try std.testing.expectEqual(@as(usize, 2), files.reads);
    try network.expectDone();
}
test "Google ADC URL federation retains configured headers and IAM impersonation uses scoped STS token" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const config = "{\"type\":\"external_account\",\"audience\":\"//iam.googleapis.com/projects/p/locations/global/workloadIdentityPools/w/providers/i\",\"subject_token_type\":\"urn:ietf:params:oauth:token-type:jwt\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"service_account_impersonation_url\":\"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/fixture:generateAccessToken\",\"credential_source\":{\"url\":\"https://id.fixture/subject\",\"headers\":{\"x-fixture-identity\":\"public-header\"}}}";
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "id.fixture/subject", .check = checkSubjectHeader, .response = "public+token" }, .{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkIamScope, .response = sts }, .{ .method = .POST, .suffix = "fixture:generateAccessToken", .check = checkIam, .request_body = "{\"scope\":[\"https://www.googleapis.com/auth/cloud-platform\"],\"lifetime\":\"3600s\"}", .response = "{\"accessToken\":\"impersonated-public\",\"expireTime\":\"1970-01-01T01:00:00Z\"}" } } };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    owner.timeout_ms = 20000;
    const provider = try adc.Provider.open(a, config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner });
    defer provider.deinit();
    try std.testing.expectEqualStrings("impersonated-public", try provider.token(100));
    try std.testing.expectEqual(@as(u32, 20000), owner.timeout_ms);
    try network.expectDone();
}
fn checkSubjectHeader(request: http.Request) !void {
    try std.testing.expectEqualStrings("public-header", mock.header(request, "x-fixture-identity").?);
}
fn checkIamScope(request: http.Request) !void {
    try checkSts(request);
    try std.testing.expect(std.mem.indexOf(u8, request.body.?, "scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fiam") != null);
}
fn checkIam(request: http.Request) !void {
    try std.testing.expectEqualStrings("Bearer federated-public", mock.header(request, "authorization").?);
}
test "Google ADC impersonated authorized-user source pins quota delegates and rejects nested impersonation" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const config = "{\"type\":\"impersonated_service_account\",\"service_account_impersonation_url\":\"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/fixture:generateAccessToken\",\"delegates\":[\"projects/-/serviceAccounts/delegate\"],\"quota_project_id\":\"outer-billing\",\"source_credentials\":{\"type\":\"authorized_user\",\"client_id\":\"client\",\"client_secret\":\"public-client-secret\",\"refresh_token\":\"public-refresh\",\"quota_project_id\":\"source-billing\"}}";
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "oauth2.googleapis.com/token", .response = "{\"access_token\":\"federated-public\",\"expires_in\":3600,\"token_type\":\"Bearer\"}" }, .{ .method = .POST, .suffix = "fixture:generateAccessToken", .check = checkIamQuota, .request_body = "{\"delegates\":[\"projects/-/serviceAccounts/delegate\"],\"scope\":[\"https://www.googleapis.com/auth/cloud-platform\"],\"lifetime\":\"3600s\"}", .response = "{\"accessToken\":\"delegated-public\",\"expireTime\":\"1970-01-01T01:00:00Z\"}" } } };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = try adc.Provider.open(a, config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner });
    defer provider.deinit();
    try std.testing.expectEqualStrings("outer-billing", provider.quota_project.?);
    try std.testing.expectEqualStrings("delegated-public", try provider.token(0));
    try network.expectDone();
}
fn checkIamQuota(request: http.Request) !void {
    try checkIam(request);
    try std.testing.expectEqualStrings("source-billing", mock.header(request, "x-goog-user-project").?);
}
test "Google ADC executable requires explicit source optin supports valid output cache and uses direct whitespace argv" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const config = "{\"type\":\"external_account\",\"audience\":\"//iam.googleapis.com/projects/p/locations/global/workloadIdentityPools/w/providers/i\",\"subject_token_type\":\"urn:ietf:params:oauth:token-type:jwt\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"credential_source\":{\"executable\":{\"command\":\"fixture-command --flag\",\"timeout_millis\":1234}}}";
    var network: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkSts, .response = sts }} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    var process: Process = .{};
    const provider = try adc.Provider.open(a, config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner, .runner = .{ .context = &process, .argv_fn = Process.execute } });
    defer provider.deinit();
    try std.testing.expectError(error.GoogleExecutableNotAllowed, provider.token(0));
    try std.testing.expectEqual(@as(usize, 0), process.calls);
    try environment.put("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES", "1");
    try std.testing.expectEqualStrings("federated-public", try provider.token(0));
    try std.testing.expectEqual(@as(usize, 1), process.calls);
    try network.expectDone();
}
fn allocationAdc(a: A) !void {
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var files: Fields = .{ .bytes = "{\"token\":\"public+token\"}" };
    var network: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .response = sts }} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = try adc.Provider.open(a, file_config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner, .reader = files.reader() });
    defer provider.deinit();
    _ = try provider.token(0);
}
test "Google ADC file federation covers every allocation failure and rejects insecure STS" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationAdc, .{});
    var env = std.process.EnvMap.init(std.testing.allocator);
    defer env.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    var owner = http.HttpTransport.init(std.testing.allocator);
    defer owner.deinit();
    const config = "{\"type\":\"external_account\",\"audience\":\"a\",\"subject_token_type\":\"jwt\",\"token_url\":\"http://untrusted.invalid/token\",\"credential_source\":{\"file\":\"/fixture\"}}";
    try std.testing.expectError(error.InvalidGoogleIdentityEndpoint, adc.Provider.open(std.testing.allocator, config, .{ .environment = &env, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner }));
}

fn decodePercent(a: A, bytes: []const u8) ![]const u8 {
    const component: std.Uri.Component = .{ .percent_encoded = bytes };
    return component.toRawMaybeAlloc(a);
}
fn checkAwsExchange(request: http.Request) !void {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fields = std.mem.splitScalar(u8, request.body.?, '&');
    var subject: ?[]const u8 = null;
    while (fields.next()) |field| if (std.mem.startsWith(u8, field, "subject_token=")) {
        subject = try decodePercent(a, field["subject_token=".len..]);
    };
    const document = try std.json.parseFromSliceLeaky(std.json.Value, a, try decodePercent(a, subject.?), .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
    try std.testing.expectEqualStrings("https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15", try rpc.string(try rpc.field(document, "url")));
    try std.testing.expectEqualStrings("POST", try rpc.string(try rpc.field(document, "method")));
    try std.testing.expectEqualStrings("", try rpc.string(try rpc.field(document, "body")));
    const headers = try rpc.field(document, "headers");
    try std.testing.expectEqual(@as(usize, 5), headers.array.items.len);
    var auth: ?[]const u8 = null;
    for (headers.array.items) |header| {
        const name = try rpc.string(try rpc.field(header, "key"));
        const value = try rpc.string(try rpc.field(header, "value"));
        try std.testing.expect(!std.mem.eql(u8, name, "x-amz-content-sha256"));
        if (std.mem.eql(u8, name, "Authorization")) auth = value;
        if (std.mem.eql(u8, name, "x-amz-security-token")) try std.testing.expectEqualStrings("public-aws-session", value);
    }
    // Independent Python stdlib HMAC/SHA256 reconstruction of the pinned SDK
    // aws_sourced.rs canonical request at the injected Unix epoch.
    try std.testing.expectEqualStrings("AWS4-HMAC-SHA256 Credential=PUBLICAWS/19700101/us-east-1/sts/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token;x-goog-cloud-target-resource, Signature=02fc107d4cc4db5b019345a159965c9a" ++ "c5243846729a59ca610a7dcfe3e85e9b", auth.?);
}
const aws_config = "{\"type\":\"external_account\",\"audience\":\"//iam.googleapis.com/projects/p/locations/global/workloadIdentityPools/w/providers/i\",\"subject_token_type\":\"urn:ietf:params:aws:token-type:aws4_request\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"credential_source\":{\"environment_id\":\"aws1\"}}";
test "Google ADC AWS federation signs native Source GetCallerIdentity envelope and never sends AWS request" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("AWS_REGION", "us-east-1");
    try environment.put("AWS_ACCESS_KEY_ID", "PUBLICAWS");
    try environment.put("AWS_SECRET_ACCESS_KEY", "public-aws-secret");
    try environment.put("AWS_SESSION_TOKEN", "public-aws-session");
    var network: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkAwsExchange, .response = sts }} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = try adc.Provider.open(a, aws_config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner });
    defer provider.deinit();
    try std.testing.expectEqualStrings("federated-public", try provider.token(0));
    try network.expectDone();
}
fn checkImdsToken(request: http.Request) !void {
    try std.testing.expectEqualStrings("public-metadata-session", mock.header(request, "x-aws-ec2-metadata-token").?);
    try std.testing.expect(!request.metadata_imdsv1);
}
test "Google ADC AWS federation preserves explicit IMDSv2 token region role and credentials metadata sequence" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const config = "{\"type\":\"external_account\",\"audience\":\"//iam.googleapis.com/projects/p/locations/global/workloadIdentityPools/w/providers/i\",\"subject_token_type\":\"urn:ietf:params:aws:token-type:aws4_request\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"credential_source\":{\"environment_id\":\"aws1\",\"region_url\":\"http://169.254.169.254/latest/meta-data/placement/availability-zone\",\"url\":\"http://169.254.169.254/latest/meta-data/iam/security-credentials\",\"imdsv2_session_token_url\":\"http://169.254.169.254/latest/api/token\"}}";
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .PUT, .suffix = "/latest/api/token", .response = "public-metadata-session" }, .{ .method = .GET, .suffix = "/placement/availability-zone", .check = checkImdsToken, .response = "us-east-1a\n" }, .{ .method = .GET, .suffix = "/iam/security-credentials", .check = checkImdsToken, .response = "fixture\n" }, .{ .method = .GET, .suffix = "/iam/security-credentials/fixture", .check = checkImdsToken, .response = "{\"AccessKeyId\":\"PUBLICAWS\",\"SecretAccessKey\":\"public-aws-secret\",\"Token\":\"public-aws-session\"}" }, .{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkAwsExchange, .response = sts } } };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = try adc.Provider.open(a, config, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner });
    defer provider.deinit();
    try std.testing.expectEqualStrings("federated-public", try provider.token(0));
    try network.expectDone();
}

test "opt-in Google ADC service account uses independent verified direct access JWT without OAuth network" {
    const a = std.testing.allocator;
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_LIBCRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    const directory = try std.process.getEnvVarOwned(a, "HYPERLANE_TEST_RSA_FIXTURE_DIR");
    defer a.free(directory);
    var dir = try std.fs.openDirAbsolute(directory, .{});
    defer dir.close();
    const bytes = try dir.readFileAlloc(a, "service-account.json", 64 * 1024);
    defer {
        std.crypto.secureZero(u8, bytes);
        a.free(bytes);
    }
    const expected = try dir.readFileAlloc(a, "access-jwt.txt", 16384);
    defer a.free(expected);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const provider = try adc.Provider.open(a, bytes, .{ .environment = &environment, .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner, .libcrypto_path = library });
    defer provider.deinit();
    try std.testing.expectEqualStrings(expected, try provider.token(1000));
    try std.testing.expectEqualStrings(expected, try provider.token(1100));
    try network.expectDone();
}

fn checkSaml(request: http.Request) !void {
    try std.testing.expect(std.mem.indexOf(u8, request.body.?, "subject_token=%3Csaml%3E%0Apublic%0A%3C%2Fsaml%3E") != null);
}
test "Google ADC JSON subject preserves multiline SAML through form encoding" {
    const a = std.testing.allocator;
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var files: Fields = .{ .bytes = "{\"assertion\":\"<saml>\\npublic\\n</saml>\"}" };
    var network: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "sts.googleapis.com/v1/token", .check = checkSaml, .response = sts }} };
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    const config = "{\"type\":\"external_account\",\"audience\":\"public\",\"subject_token_type\":\"urn:ietf:params:oauth:token-type:saml2\",\"token_url\":\"https://sts.googleapis.com/v1/token\",\"credential_source\":{\"file\":\"/fixture/assertion\",\"format\":{\"type\":\"json\",\"subject_token_field_name\":\"assertion\"}}}";
    const provider = try adc.Provider.open(a, config, .{ .environment = &env, .reader = files.reader(), .transport = network.transport(), .metadata_transport = network.transport(), .http_owner = &owner });
    defer provider.deinit();
    try std.testing.expectEqualStrings("federated-public", try provider.token(0));
    try network.expectDone();
}
