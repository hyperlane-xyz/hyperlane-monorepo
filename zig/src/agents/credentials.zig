//! Serialized credential owner. Construction reads no files/network. lease()
//! resolves only identities required by settings; no local-key ambient discovery.
const std = @import("std");
const settings = @import("../settings/root.zig");
const cloud = @import("../cloud/root.zig");
const identity = cloud.identity;
const Credentials = @import("validator/config.zig").Credentials;
const A = std.mem.Allocator;
pub const FileReader = cloud.credential_io.Reader;
pub const Options = struct {
    libcrypto_path: ?[]const u8 = null,
    file_reader: FileReader = .{},
    file_writer: cloud.credential_io.Writer = .{},
    command_runner: cloud.command.Runner = .{},
    transport_override: ?cloud.http.Transport = null,
    metadata_transport_override: ?cloud.http.Transport = null,
    allow_std_transport_for_tests: bool = false,
    sts_endpoint: []const u8 = "https://sts.amazonaws.com/",
    imds_endpoint: []const u8 = "http://169.254.169.254",
    gcp_metadata_endpoint: []const u8 = "http://metadata.google.internal",
    oauth_endpoint: ?[]const u8 = null,
    kms_endpoint: ?[]const u8 = null,
    s3_endpoint: ?[]const u8 = null,
    gcs_endpoint: ?[]const u8 = null,
    sso_endpoint: ?[]const u8 = null,
    oidc_endpoint: ?[]const u8 = null,
};
const Need = struct { aws_kms: bool = false, aws_storage: bool = false, gcp_kms: bool = false, gcs: bool = false };
const TokenFile = struct {
    reader: FileReader,
    path: []const u8,
    fn read(context: *anyopaque, a: A) ![]u8 {
        const self: *TokenFile = @ptrCast(@alignCast(context));
        return (try self.reader.read(a, self.path, 20001)) orelse error.MissingWebIdentityTokenFile;
    }
};
const Aws = struct {
    initialized: bool = false,
    source: union(enum) { none, static: identity.AwsCredentials, profile: *cloud.aws_profile.Provider, web: identity.AwsWebIdentity, container: identity.AwsContainer, imds: identity.AwsImds } = .none,
    token_file: ?*TokenFile = null,
    fallback: ?*Aws = null,
    fallback_error: ?anyerror = null,
    pub fn deinit(self: *Aws, a: A) void {
        switch (self.source) {
            .none => {},
            .static => |*value| value.deinit(),
            .profile => |value| value.deinit(),
            .web => |*value| value.deinit(),
            .container => |*value| value.deinit(),
            .imds => |*value| value.deinit(),
        }
        if (self.token_file) |value| a.destroy(value);
        if (self.fallback) |value| {
            value.deinit(a);
            a.destroy(value);
        }
        self.* = undefined;
    }
    fn primary(self: *Aws, now: u64) !cloud.sigv4.Credentials {
        return switch (self.source) {
            .none => error.NoAwsCredentials,
            .static => |value| value.value,
            .profile => |value| value.credentials(now),
            .web => |*value| value.credentials(now),
            .container => |*value| value.credentials(now),
            .imds => |*value| value.credentials(now),
        };
    }
    fn credentials(self: *Aws, now: u64) !cloud.sigv4.Credentials {
        return self.primary(now) catch |err| {
            if (self.fallback) |provider_| return provider_.credentials(now);
            if (self.fallback_error) |fallback_error| return fallback_error;
            return err;
        };
    }
};
const Google = cloud.google_adc.Provider;
pub const Manager = struct {
    allocator: A,
    settings: *const settings.Settings,
    environment: std.process.EnvMap,
    transport: *cloud.http.HttpTransport,
    metadata_transport: cloud.http.HttpTransport,
    options: Options,
    need: Need,
    arena: std.heap.ArenaAllocator,
    aws_kms: Aws = .{},
    aws_storage: Aws = .{},
    gcp_kms: ?*Google = null,
    gcs: ?*Google = null,
    date: [16]u8 = undefined,
    secrets: std.ArrayList([]u8) = .empty,
    pub fn init(a: A, s: *const settings.Settings, environment: *const std.process.EnvMap, transport: *cloud.http.HttpTransport, options: Options) !*Manager {
        return initNeeded(a, s, environment, transport, options, needs(s));
    }
    /// A metrics-only configured signer needs only its own cloud identity. Do
    /// not discover another chain's signer, storage credentials or ambient role.
    /// Like init(), this constructor performs no file, command or network I/O.
    pub fn initForSigner(a: A, s: *const settings.Settings, environment: *const std.process.EnvMap, transport: *cloud.http.HttpTransport, signer: settings.Signer, options: Options) !*Manager {
        var need: Need = .{};
        markSigner(&need, signer);
        return initNeeded(a, s, environment, transport, options, need);
    }
    fn initNeeded(a: A, s: *const settings.Settings, environment: *const std.process.EnvMap, transport: *cloud.http.HttpTransport, options: Options, need: Need) !*Manager {
        const manager = try a.create(Manager);
        manager.* = .{ .allocator = a, .settings = s, .environment = std.process.EnvMap.init(a), .transport = transport, .metadata_transport = cloud.http.HttpTransport.init(a), .options = options, .need = need, .arena = std.heap.ArenaAllocator.init(a) };
        errdefer manager.deinit();
        inline for (.{ "libcrypto_path", "oauth_endpoint", "kms_endpoint", "s3_endpoint", "gcs_endpoint", "sso_endpoint", "oidc_endpoint" }) |field_name| {
            if (@field(options, field_name)) |text| @field(manager.options, field_name) = try manager.arena.allocator().dupe(u8, text);
        }
        inline for (.{ "sts_endpoint", "imds_endpoint", "gcp_metadata_endpoint" }) |field_name| {
            @field(manager.options, field_name) = try manager.arena.allocator().dupe(u8, @field(options, field_name));
        }
        manager.metadata_transport.native_curl = transport.native_curl;
        manager.metadata_transport.cancel = transport.cancel;
        manager.metadata_transport.timeout_ms = 5000;
        manager.metadata_transport.connect_timeout_ms = 1000;
        manager.metadata_transport.allow_metadata_http = true;
        manager.metadata_transport.allow_insecure_loopback = transport.allow_insecure_loopback;
        if (need.aws_kms or need.aws_storage or need.gcp_kms or need.gcs) {
            // External credential commands receive the caller's explicit
            // environment, matching SDK semantics; never inspect ambient env.
            // No cloud need means no values copied and no discovery afterward.
            var entries = environment.iterator();
            while (entries.next()) |entry| try manager.environment.put(entry.key_ptr.*, entry.value_ptr.*);
        }
        return manager;
    }
    pub fn deinit(self: *Manager) void {
        const a = self.allocator;
        self.aws_kms.deinit(a);
        self.aws_storage.deinit(a);
        if (self.gcp_kms) |value| {
            value.deinit();
        }
        if (self.gcs) |value| {
            value.deinit();
        }
        for (self.secrets.items) |buffer| {
            std.crypto.secureZero(u8, buffer);
            a.free(buffer);
        }
        self.secrets.deinit(a);
        wipeEnvironment(&self.environment);
        self.environment.deinit();
        self.metadata_transport.deinit();
        self.arena.deinit();
        a.destroy(self);
    }
    fn cloudTransport(self: *Manager) cloud.http.Transport {
        return self.options.transport_override orelse self.transport.interface();
    }
    fn metadataTransport(self: *Manager) cloud.http.Transport {
        return self.options.metadata_transport_override orelse self.metadata_transport.interface();
    }
    fn nativeRequired(self: *Manager) !void {
        if (!self.options.allow_std_transport_for_tests and self.options.transport_override == null and self.transport.native_curl == null) return error.NativeCredentialTransportRequired;
    }
    pub fn lease(self: *Manager, unix_seconds: u64) !Credentials {
        // The manager outlives a retained worker job. Never retain a previous
        // job's cancellation pointer in the independent metadata HTTP owner.
        self.metadata_transport.native_curl = self.transport.native_curl;
        self.metadata_transport.cancel = self.transport.cancel;
        self.metadata_transport.timeout_ms = self.transport.timeout_ms;
        self.metadata_transport.connect_timeout_ms = self.transport.connect_timeout_ms;
        self.metadata_transport.allow_insecure_loopback = self.transport.allow_insecure_loopback;
        if (self.need.aws_kms or self.need.aws_storage or self.need.gcp_kms or self.need.gcs) try self.nativeRequired();
        try identity.amzDate(&self.date, unix_seconds);
        var result: Credentials = .{ .transport = self.cloudTransport(), .http_owner = if (self.options.transport_override == null) self.transport else null, .amz_date = &self.date, .kms_endpoint = self.options.kms_endpoint, .s3_endpoint = self.options.s3_endpoint, .gcs_endpoint = self.options.gcs_endpoint };
        if (self.need.aws_kms) {
            if (!self.aws_kms.initialized) try self.setupAws(&self.aws_kms, false);
            result.aws = try self.aws_kms.credentials(unix_seconds);
        }
        if (self.need.aws_storage) {
            if (!self.aws_storage.initialized) try self.setupAws(&self.aws_storage, true);
            result.aws_storage = try self.aws_storage.credentials(unix_seconds);
        }
        if (self.need.gcp_kms) {
            if (self.gcp_kms == null) self.gcp_kms = try self.setupGoogle(null, null, false);
            result.gcp_bearer = try self.gcp_kms.?.token(unix_seconds);
            result.gcp_quota_project = self.gcp_kms.?.quota_project;
        }
        if (self.need.gcs) {
            if (self.gcs == null) {
                const syncer = self.settings.role.validator.checkpoint_syncer.gcs;
                if (syncer.service_account_key == null and syncer.user_secrets == null and !syncer.use_application_default) return error.GcsAuthenticatedWriterRequired;
                self.gcs = if (syncer.use_application_default) try self.setupGoogle(null, null, true) else if (syncer.service_account_key) |path| try self.setupGoogle(path, null, true) else try self.setupGoogle(null, syncer.user_secrets, true);
            }
            result.gcs_bearer = try self.gcs.?.token(unix_seconds);
        }
        return result;
    }
    fn setupAws(self: *Manager, target: *Aws, storage: bool) !void {
        var fresh: Aws = .{};
        errdefer fresh.deinit(self.allocator);
        try self.setupAwsValue(&fresh, storage);
        target.* = fresh;
    }
    fn setupAwsValue(self: *Manager, target: *Aws, storage: bool) !void {
        const environment_credentials = if (storage) try cloud.aws_profile.sdkEnvironment(self.allocator, &self.environment) else identity.awsFromEnvironment(self.allocator, &self.environment) catch |err| switch (err) {
            error.IncompleteAwsEnvironment => null,
            else => return err,
        };
        if (environment_credentials) |credentials| {
            target.source = .{ .static = credentials };
            target.initialized = true;
            return;
        }
        if (storage) {
            if (try self.profile()) |provider| {
                target.source = .{ .profile = provider };
                target.initialized = true;
                return;
            }
        }
        var web_error: ?anyerror = null;
        const web = identity.webIdentityEnvironment(&self.environment) catch |err| blk: {
            if (storage) return err;
            web_error = err;
            break :blk null;
        };
        const container = try identity.containerEndpointFromEnvironment(self.arena.allocator(), &self.environment);
        // Authority-sensitive order: S3 SDK web->container; KMS custom Rusoto
        // container->web. KMS never discovers profiles or IMDS by default.
        if (storage and web != null) {
            try self.setupWeb(target, web.?);
            return;
        }
        if (container) |url| {
            try self.nativeRequired();
            var token = self.environment.get("AWS_CONTAINER_AUTHORIZATION_TOKEN");
            if (self.environment.get("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")) |path| {
                const wire = (try self.options.file_reader.read(self.allocator, path, 16384)) orelse return error.MissingContainerTokenFile;
                defer {
                    std.crypto.secureZero(u8, wire);
                    self.allocator.free(wire);
                }
                token = try self.secret(std.mem.trim(u8, wire, " \r\n\t"));
            }
            if (token) |value| if (value.len == 0 or std.mem.indexOfAny(u8, value, "\r\n\x00") != null) return error.InvalidContainerAuthorization;
            target.source = .{ .container = .{ .allocator = self.allocator, .transport = self.metadataTransport(), .endpoint = url, .authorization_token = token } };
            target.initialized = true;
            if (!storage) {
                if (web) |configuration| {
                    const fallback = try self.allocator.create(Aws);
                    fallback.* = .{};
                    errdefer {
                        fallback.deinit(self.allocator);
                        self.allocator.destroy(fallback);
                    }
                    try self.setupWeb(fallback, configuration);
                    target.fallback = fallback;
                } else target.fallback_error = web_error;
            }
            return;
        }
        if (web) |configuration| {
            try self.setupWeb(target, configuration);
            return;
        }
        if (!storage) return web_error orelse error.NoAwsKmsCredentials;
        if (self.environment.get("AWS_EC2_METADATA_DISABLED")) |disabled| if (std.ascii.eqlIgnoreCase(disabled, "true")) return error.AwsMetadataDisabled;
        try self.nativeRequired();
        target.source = .{ .imds = .{ .allocator = self.allocator, .transport = self.metadataTransport(), .endpoint = self.options.imds_endpoint } };
        target.initialized = true;
    }
    fn setupWeb(self: *Manager, target: *Aws, configuration: identity.WebIdentityEnvironment) !void {
        try self.nativeRequired();
        const token = try self.allocator.create(TokenFile);
        errdefer self.allocator.destroy(token);
        token.* = .{ .reader = self.options.file_reader, .path = configuration.token_file };
        target.token_file = token;
        target.source = .{ .web = .{ .allocator = self.allocator, .transport = self.cloudTransport(), .token_source = .{ .context = token, .read_fn = TokenFile.read }, .endpoint = self.options.sts_endpoint, .role_arn = configuration.role_arn, .session_name = configuration.session_name orelse "WebIdentitySession" } };
        target.initialized = true;
    }
    fn secret(self: *Manager, text: []const u8) ![]const u8 {
        const bytes = try self.allocator.dupe(u8, text);
        errdefer {
            std.crypto.secureZero(u8, bytes);
            self.allocator.free(bytes);
        }
        try self.secrets.append(self.allocator, bytes);
        return bytes;
    }
    fn profile(self: *Manager) !?*cloud.aws_profile.Provider {
        return cloud.aws_profile.Provider.open(self.allocator, .{ .environment = &self.environment, .reader = self.options.file_reader, .writer = self.options.file_writer, .runner = self.options.command_runner, .transport = self.cloudTransport(), .metadata_transport = self.metadataTransport(), .http_owner = self.transport, .region = self.settings.role.validator.checkpoint_syncer.s3.region, .sts_endpoint = self.options.sts_endpoint, .imds_endpoint = self.options.imds_endpoint, .sso_endpoint = self.options.sso_endpoint, .oidc_endpoint = self.options.oidc_endpoint });
    }
    fn setupGoogle(self: *Manager, service_path: ?[]const u8, user_path: ?[]const u8, storage: bool) !*Google {
        try self.nativeRequired();
        const a = self.allocator;
        const configured = service_path orelse user_path orelse self.environment.get("GOOGLE_APPLICATION_CREDENTIALS");
        var wire: ?[]u8 = null;
        if (configured) |path| {
            wire = (try self.options.file_reader.read(a, path, 64 * 1024)) orelse return error.MissingGoogleCredentialFile;
        } else if (!storage) {
            // Modern KMS SDK's actual well-known ADC lookup ignores
            // CLOUDSDK_CONFIG. Legacy GCS ADC has no well-known file lookup.
            if (self.environment.get("HOME")) |home| {
                const path = try std.fs.path.join(a, &.{ home, ".config", "gcloud", "application_default_credentials.json" });
                defer a.free(path);
                wire = try self.options.file_reader.read(a, path, 64 * 1024);
            }
        }
        defer if (wire) |bytes| {
            std.crypto.secureZero(u8, bytes);
            a.free(bytes);
        };
        if (storage and wire != null) {
            var parsed = try std.json.parseFromSlice(struct { type: []const u8 }, a, wire.?, .{ .ignore_unknown_fields = true, .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
            defer parsed.deinit();
            if (user_path != null) {
                if (!std.mem.eql(u8, parsed.value.type, "authorized_user")) return error.ExpectedGoogleUserCredentials;
            } else if (!std.mem.eql(u8, parsed.value.type, "service_account")) return error.ExpectedGoogleServiceAccount;
        }
        return Google.open(a, wire, .{ .mode = if (storage) .gcs else .kms, .environment = &self.environment, .transport = self.cloudTransport(), .metadata_transport = self.metadataTransport(), .http_owner = self.transport, .metadata_owner = &self.metadata_transport, .reader = self.options.file_reader, .runner = self.options.command_runner, .libcrypto_path = self.options.libcrypto_path, .oauth_endpoint = self.options.oauth_endpoint, .metadata_endpoint = self.options.gcp_metadata_endpoint, .scope = if (storage) "https://www.googleapis.com/auth/devstorage.read_write" else "https://www.googleapis.com/auth/cloud-platform" });
    }
};
fn fieldString(value: std.json.Value, name: []const u8) ![]const u8 {
    if (value != .object) return error.InvalidCredentialDocument;
    const item = value.object.get(name) orelse return error.InvalidCredentialDocument;
    if (item != .string) return error.InvalidCredentialDocument;
    return item.string;
}
fn needs(s: *const settings.Settings) Need {
    var result: Need = .{};
    switch (s.role) {
        .scraper => {},
        .relayer => for (s.chains) |chain| {
            if (chain.signer) |signer| markSigner(&result, signer);
            if (chain.ccs_signer) |signer| markSigner(&result, signer);
        },
        .validator => |role| {
            markSigner(&result, role.signer);
            if (!role.skip_announce) {
                if (s.chainByName(role.origin_chain)) |chain| if (chain.signer) |signer| markSigner(&result, signer);
            }
            switch (role.checkpoint_syncer) {
                .s3 => result.aws_storage = true,
                .gcs => result.gcs = true,
                else => {},
            }
        },
    }
    return result;
}
fn markSigner(result: *Need, signer: settings.Signer) void {
    switch (signer) {
        .aws => result.aws_kms = true,
        .gcp => result.gcp_kms = true,
        else => {},
    }
}
fn wipeEnvironment(environment: *std.process.EnvMap) void {
    var iterator = environment.iterator();
    while (iterator.next()) |entry| std.crypto.secureZero(u8, @constCast(entry.value_ptr.*));
}
const mock = @import("../cloud/testing.zig");
fn fixtureSettings(a: A) !settings.Settings {
    return settings.Settings.load(a, .validator, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--originChainName=ethereum", "--validator.key=0x11111111111111111111111111111111" ++ "11111111111111111111111111111111", "--checkpointSyncer.type=localStorage", "--checkpointSyncer.path=/tmp/public-fixture" } });
}
fn defaultsDir() []const u8 {
    std.fs.cwd().access("rust/main/config", .{}) catch return "../rust/main/config";
    return "rust/main/config";
}
const Files = struct {
    files: []const struct { path: []const u8, wire: []const u8 },
    reads: usize = 0,
    fn read(context: ?*anyopaque, a: A, path: []const u8, maximum: usize) !?[]u8 {
        const self: *Files = @ptrCast(@alignCast(context.?));
        self.reads += 1;
        for (self.files) |file| if (std.mem.eql(u8, path, file.path)) {
            if (file.wire.len > maximum) return error.FileTooBig;
            return try a.dupe(u8, file.wire);
        };
        return null;
    }
    fn interface(self: *Files) FileReader {
        return .{ .context = self, .read_fn = read };
    }
};
test "credential Manager local-only roles never read ambient files or call transport" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("HOME", "/not-a-real-home");
    try environment.put("AWS_ACCESS_KEY_ID", "incomplete-unused");
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    var files: Files = .{ .files = &.{} };
    var network: mock.Mock = .{ .steps = &.{} };
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport() });
    defer manager.deinit();
    try std.testing.expectEqual(@as(usize, 0), files.reads);
    const lease = try manager.lease(1672531200);
    try std.testing.expect(lease.aws == null and lease.aws_storage == null and lease.gcp_bearer == null and lease.gcs_bearer == null);
    try std.testing.expectEqualStrings("20230101T000000Z", lease.amz_date);
    var old_job = std.atomic.Value(bool).init(true);
    var new_job = std.atomic.Value(bool).init(false);
    manager.metadata_transport.cancel = &old_job;
    transport.cancel = &new_job;
    transport.timeout_ms = 1234;
    transport.connect_timeout_ms = 456;
    _ = try manager.lease(1672531201);
    try std.testing.expect(manager.metadata_transport.cancel == &new_job);
    try std.testing.expectEqual(@as(u32, 1234), manager.metadata_transport.timeout_ms);
    try std.testing.expectEqual(@as(u32, 456), manager.metadata_transport.connect_timeout_ms);
    try std.testing.expectEqual(@as(usize, 0), files.reads);
    try network.expectDone();
}
test "credential Manager preserves different KMS container and S3 profile identities and refreshes date" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .aws = .{ .id = "alias/public-fixture", .region = "us-east-1" } };
    s.role.validator.checkpoint_syncer = .{ .s3 = .{ .bucket = "public-fixture", .region = "us-east-1", .folder = null } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/fixture");
    try environment.put("AWS_SHARED_CREDENTIALS_FILE", "/fixture/credentials");
    try environment.put("AWS_CONFIG_FILE", "/fixture/config");
    var files: Files = .{ .files = &.{.{ .path = "/fixture/credentials", .wire = "[default]\naws_access_key_id=PROFILE\naws_secret_access_key=public-profile-secret\n" }} };
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/v2/credentials/fixture", .response = "{\"AccessKeyId\":\"CONTAINER\",\"SecretAccessKey\":\"public-container\",\"Token\":\"token-one\",\"Expiration\":\"2023-01-01T01:00:00Z\"}" }, .{ .method = .GET, .suffix = "/v2/credentials/fixture", .response = "{\"AccessKeyId\":\"CONTAINER\",\"SecretAccessKey\":\"public-container\",\"Token\":\"token-two\",\"Expiration\":\"2023-01-01T02:00:00Z\"}" } } };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport(), .metadata_transport_override = network.transport() });
    defer manager.deinit();
    try std.testing.expectEqual(@as(usize, 0), files.reads);
    const first = try manager.lease(1672531200);
    try std.testing.expectEqualStrings("CONTAINER", first.aws.?.access_key_id);
    try std.testing.expectEqualStrings("PROFILE", first.aws_storage.?.access_key_id);
    try std.testing.expectEqualStrings("token-one", first.aws.?.session_token.?);
    try std.testing.expectEqual(@as(usize, 2), files.reads);
    const next = try manager.lease(1672534800);
    try std.testing.expectEqualStrings("token-two", next.aws.?.session_token.?);
    try std.testing.expectEqualStrings("20230101T010000Z", next.amz_date);
    try std.testing.expectEqual(@as(usize, 2), files.reads);
    try network.expectDone();
}
test "credential Manager keeps GCS user identity separate from KMS ADC identity" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .gcp = .{ .key_version_name = "projects/public-fixture/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" } };
    s.role.validator.checkpoint_syncer = .{ .gcs = .{ .bucket = "fixture", .folder = null, .service_account_key = null, .user_secrets = "/fixture/gcs.json", .use_application_default = false } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("GOOGLE_APPLICATION_CREDENTIALS", "/fixture/adc.json");
    var files: Files = .{ .files = &.{ .{ .path = "/fixture/adc.json", .wire = "{\"type\":\"authorized_user\",\"client_id\":\"kms\",\"client_secret\":\"public-kms\",\"refresh_token\":\"kms-refresh\"}" }, .{ .path = "/fixture/gcs.json", .wire = "{\"type\":\"authorized_user\",\"client_id\":\"gcs\",\"client_secret\":\"public-gcs\",\"refresh_token\":\"gcs-refresh\"}" } } };
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "/token", .request_body = "grant_type=refresh_token&client_id=kms&client_secret=public-kms&refresh_token=kms-refresh", .response = "{\"access_token\":\"kms-token\",\"expires_in\":3600,\"token_type\":\"Bearer\"}" }, .{ .method = .POST, .suffix = "/token", .request_body = "grant_type=refresh_token&client_id=gcs&client_secret=public-gcs&refresh_token=gcs-refresh", .response = "{\"access_token\":\"gcs-token\",\"expires_in\":3600,\"token_type\":\"Bearer\"}" } } };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport() });
    defer manager.deinit();
    const lease = try manager.lease(1672531200);
    try std.testing.expectEqualStrings("kms-token", lease.gcp_bearer.?);
    try std.testing.expectEqualStrings("gcs-token", lease.gcs_bearer.?);
    _ = try manager.lease(1672531300);
    try std.testing.expectEqual(@as(usize, 2), files.reads);
    try network.expectDone();
}

test "credential Manager KMS custom chain falls through container failure to web identity without profile discovery" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("AWS_ACCESS_KEY_ID", "partial-source-env");
    try environment.put("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/fixture");
    try environment.put("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/fixture");
    try environment.put("AWS_WEB_IDENTITY_TOKEN_FILE", "/fixture/token");
    try environment.put("AWS_SHARED_CREDENTIALS_FILE", "/must-not-read-profile");
    var files: Files = .{ .files = &.{.{ .path = "/fixture/token", .wire = "public-token" }} };
    const xml = "<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>WEB</AccessKeyId><SecretAccessKey>public-web</SecretAccessKey><SessionToken>public-session</SessionToken><Expiration>1970-01-01T01:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>";
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .GET, .suffix = "/v2/credentials/fixture", .status = 503 }, .{ .method = .POST, .suffix = "sts.amazonaws.com/", .response = xml }, .{ .method = .GET, .suffix = "/v2/credentials/fixture", .status = 503 } } };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport(), .metadata_transport_override = network.transport() });
    defer manager.deinit();
    const lease = try manager.lease(0);
    try std.testing.expectEqualStrings("WEB", lease.aws.?.access_key_id);
    _ = try manager.lease(100);
    try std.testing.expectEqual(@as(usize, 1), files.reads);
    try network.expectDone();
}
test "credential Manager partial unused web identity cannot shadow valid KMS container credentials" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/fixture");
    try environment.put("AWS_WEB_IDENTITY_TOKEN_FILE", "/unused-partial-token");
    var network: mock.Mock = .{ .steps = &.{.{ .method = .GET, .suffix = "/v2/credentials/fixture", .response = "{\"AccessKeyId\":\"CONTAINER\",\"SecretAccessKey\":\"public-container\",\"Token\":\"public-session\",\"Expiration\":\"1970-01-01T01:00:00Z\"}" }} };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    var files: Files = .{ .files = &.{} };
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport(), .metadata_transport_override = network.transport() });
    defer manager.deinit();
    try std.testing.expectEqualStrings("CONTAINER", (try manager.lease(0)).aws.?.access_key_id);
    try std.testing.expectEqual(@as(usize, 0), files.reads);
    try network.expectDone();
}
fn allocatorManager(a: A) !void {
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } };
    s.role.validator.checkpoint_syncer = .{ .s3 = .{ .bucket = "fixture", .region = "us-east-1", .folder = null } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try environment.put("AWS_SECRET_ACCESS_KEY", "public-allocator-secret");
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    var mock_: mock.Mock = .{ .steps = &.{} };
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .transport_override = mock_.transport() });
    defer manager.deinit();
    _ = try manager.lease(0);
}
test "credential Manager allocation failures preserve owners and wipe independent static leases" {
    // Linux can remap the settings arena in place on one run and move it on
    // another. Force allocation for growth so every injected failure has a
    // deterministic index while retaining the complete constructor/lease sweep.
    var backing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .resize_fail_index = 0 });
    try std.testing.checkAllAllocationFailures(backing.allocator(), allocatorManager, .{});
}

const ProcessFixture = struct {
    calls: usize = 0,
    fn run(context: ?*anyopaque, a: A, text: []const u8, environment: *const std.process.EnvMap, limits: cloud.command.Limits) ![]u8 {
        const self: *ProcessFixture = @ptrCast(@alignCast(context.?));
        self.calls += 1;
        try std.testing.expectEqualStrings("fixture-process", text);
        try std.testing.expectEqualStrings("public-extra", environment.get("CUSTOM_PROVIDER_INPUT").?);
        try std.testing.expectEqual(@as(u32, 1234), limits.timeout_ms);
        return a.dupe(u8, "{\"Version\":1,\"AccessKeyId\":\"PROCESS\",\"SecretAccessKey\":\"public-process\"}");
    }
};
test "credential Manager storage SDK process chain remains separate from KMS custom container chain" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } };
    s.role.validator.checkpoint_syncer = .{ .s3 = .{ .bucket = "fixture", .region = "us-east-1", .folder = null } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("AWS_ACCESS_KEY_ID", "partial-source-env");
    try environment.put("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/fixture");
    try environment.put("AWS_CONFIG_FILE", "/fixture/config");
    try environment.put("AWS_SHARED_CREDENTIALS_FILE", "/fixture/credentials");
    try environment.put("CUSTOM_PROVIDER_INPUT", "public-extra");
    var files: Files = .{ .files = &.{.{ .path = "/fixture/config", .wire = "[default]\ncredential_process=fixture-process\n" }} };
    var network: mock.Mock = .{ .steps = &.{.{ .method = .GET, .suffix = "/v2/credentials/fixture", .response = "{\"AccessKeyId\":\"CONTAINER\",\"SecretAccessKey\":\"public-secret\",\"Token\":\"public-session\",\"Expiration\":\"1970-01-01T01:00:00Z\"}" }} };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    transport.timeout_ms = 1234;
    var process: ProcessFixture = .{};
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .command_runner = .{ .context = &process, .run_fn = ProcessFixture.run }, .transport_override = network.transport(), .metadata_transport_override = network.transport() });
    defer manager.deinit();
    const first = try manager.lease(0);
    try std.testing.expectEqualStrings("CONTAINER", first.aws.?.access_key_id);
    try std.testing.expectEqualStrings("PROCESS", first.aws_storage.?.access_key_id);
    _ = try manager.lease(100);
    try std.testing.expectEqual(@as(usize, 1), process.calls);
    try std.testing.expectEqual(@as(usize, 2), files.reads);
    try network.expectDone();
}

test "credential Manager modern KMS wellknown ADC and legacy GCS metadata use different discovery and quota rules" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.signer = .{ .gcp = .{ .key_version_name = "projects/fixture/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" } };
    s.role.validator.checkpoint_syncer = .{ .gcs = .{ .bucket = "fixture", .folder = null, .service_account_key = "/ignored-source-path", .user_secrets = null, .use_application_default = true } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("HOME", "/fixture");
    try environment.put("CLOUDSDK_CONFIG", "/not-source-sdk-discovery");
    try environment.put("GOOGLE_CLOUD_QUOTA_PROJECT", "override-billing");
    var files: Files = .{ .files = &.{.{ .path = "/fixture/.config/gcloud/application_default_credentials.json", .wire = "{\"type\":\"authorized_user\",\"client_id\":\"kms\",\"client_secret\":\"public-secret\",\"refresh_token\":\"public-refresh\",\"quota_project_id\":\"file-billing\"}" }} };
    var network: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "oauth2.googleapis.com/token", .response = "{\"access_token\":\"kms-user\",\"expires_in\":3600,\"token_type\":\"Bearer\"}" }, .{ .method = .GET, .suffix = "devstorage.read_write", .check = checkGcsMetadata, .metadata_flavor_google = true, .response = "{\"access_token\":\"gcs-metadata\",\"expires_in\":3600,\"token_type\":\"Bearer\"}" } } };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport(), .metadata_transport_override = network.transport() });
    defer manager.deinit();
    const lease = try manager.lease(0);
    try std.testing.expectEqualStrings("kms-user", lease.gcp_bearer.?);
    try std.testing.expectEqualStrings("gcs-metadata", lease.gcs_bearer.?);
    try std.testing.expectEqualStrings("override-billing", lease.gcp_quota_project.?);
    try std.testing.expectEqual(@as(usize, 1), files.reads);
    try network.expectDone();
}
fn checkGcsMetadata(request: cloud.http.Request) !void {
    try std.testing.expectEqualStrings("Google", mock.header(request, "Metadata-Flavor").?);
    try std.testing.expect(std.mem.startsWith(u8, request.url, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?"));
}
test "credential Manager legacy GCS application-default does not silently adopt modern authorized-user ADC" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.role.validator.checkpoint_syncer = .{ .gcs = .{ .bucket = "fixture", .folder = null, .service_account_key = null, .user_secrets = null, .use_application_default = true } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("GOOGLE_APPLICATION_CREDENTIALS", "/fixture/user.json");
    var files: Files = .{ .files = &.{.{ .path = "/fixture/user.json", .wire = "{\"type\":\"authorized_user\",\"client_id\":\"fixture\",\"client_secret\":\"public-secret\",\"refresh_token\":\"public-refresh\"}" }} };
    var network: mock.Mock = .{ .steps = &.{} };
    var transport = cloud.http.HttpTransport.init(a);
    defer transport.deinit();
    const manager = try Manager.init(a, &s, &environment, &transport, .{ .file_reader = files.interface(), .transport_override = network.transport() });
    defer manager.deinit();
    try std.testing.expectError(error.ExpectedGoogleServiceAccount, manager.lease(0));
    try network.expectDone();
}
