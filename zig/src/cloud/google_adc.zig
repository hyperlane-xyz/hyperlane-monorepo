//! Explicit modern Google Cloud ADC token providers. File/URL federation and
//! IAM impersonation follow pinned google-cloud-auth1.14.0, independently of
//! GCS's legacy ya-gcp/yup-oauth2 discovery rules (selected by the caller).
const std = @import("std");
const http = @import("http.zig");
const identity = @import("identity.zig");
const rs256 = @import("rs256.zig");
const io = @import("credential_io.zig");
const command = @import("command.zig");
const rpc = @import("../net/json_rpc.zig");
const sigv4 = @import("sigv4.zig");
const A = std.mem.Allocator;
const Value = std.json.Value;
pub const Mode = enum { kms, gcs };
pub const Options = struct {
    mode: Mode = .kms,
    environment: *const std.process.EnvMap,
    transport: http.Transport,
    metadata_transport: http.Transport,
    http_owner: *http.HttpTransport,
    metadata_owner: ?*http.HttpTransport = null,
    reader: io.Reader = .{},
    runner: command.Runner = .{},
    libcrypto_path: ?[]const u8 = null,
    oauth_endpoint: ?[]const u8 = null,
    metadata_endpoint: []const u8 = "http://metadata.google.internal",
    scope: []const u8 = "https://www.googleapis.com/auth/cloud-platform",
};
const Service = struct { signer: *rs256.Signer, account: identity.ParsedServiceAccount, oauth: identity.GcpProvider };
const Impersonated = struct { source: *Provider, url: []const u8, delegates: ?[]const []const u8 };
pub const Provider = struct {
    allocator: A,
    options: Options,
    document: ?std.json.Parsed(Value) = null,
    quota_project: ?[]const u8 = null,
    cached: ?identity.AccessToken = null,
    node: union(enum) { none, basic: identity.GcpProvider, service: Service, external: Value, impersonated: Impersonated } = .none,
    pub fn open(a: A, bytes: ?[]const u8, options: Options) !*Provider {
        return openDepth(a, bytes, options, 0);
    }
    fn openDepth(a: A, bytes: ?[]const u8, options: Options, depth: u8) anyerror!*Provider {
        if (depth > 4) return error.GoogleCredentialChainTooDeep;
        const self = try a.create(Provider);
        self.* = .{ .allocator = a, .options = options };
        errdefer self.deinit();
        if (bytes) |wire| {
            if (wire.len > 64 * 1024) return error.GoogleCredentialDocumentTooLarge;
            self.document = try std.json.parseFromSlice(Value, a, wire, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
            const value = self.document.?.value;
            const kind = try nonempty(value, "type");
            if (options.mode == .kms) {
                self.quota_project = options.environment.get("GOOGLE_CLOUD_QUOTA_PROJECT") orelse if (value.object.get("quota_project_id")) |project| try nonemptyValue(project) else null;
            }
            if (std.mem.eql(u8, kind, "authorized_user")) {
                self.node = .{ .basic = .{ .allocator = a, .transport = options.transport, .flow = .{ .authorized_user = .{ .endpoint = options.oauth_endpoint orelse "https://oauth2.googleapis.com/token", .client_id = try nonempty(value, "client_id"), .client_secret = try nonempty(value, "client_secret"), .refresh_token = try nonempty(value, "refresh_token") } } } };
            } else if (std.mem.eql(u8, kind, "service_account")) {
                const library = options.libcrypto_path orelse return error.MissingLibcryptoPath;
                const signer = try a.create(rs256.Signer);
                errdefer a.destroy(signer);
                signer.* = try rs256.Signer.init(a, library);
                errdefer signer.deinit();
                var account = try identity.parseServiceAccount(a, wire, signer, options.scope);
                errdefer account.deinit();
                if (options.oauth_endpoint) |endpoint| account.config.endpoint = endpoint;
                self.node = .{ .service = .{ .signer = signer, .account = account, .oauth = .{ .allocator = a, .transport = options.transport, .flow = .{ .service_account = account.config } } } };
            } else if (std.mem.eql(u8, kind, "external_account")) {
                if (options.mode != .kms) return error.UnsupportedGcsAdcCredentialType;
                _ = try nonempty(value, "audience");
                _ = try nonempty(value, "subject_token_type");
                try httpsEndpoint(try nonempty(value, "token_url"));
                const source = try rpc.field(value, "credential_source");
                if (source != .object) return error.InvalidGoogleCredentialSource;
                if (!source.object.contains("environment_id") and !source.object.contains("file") and !source.object.contains("url") and !source.object.contains("executable")) return error.InvalidGoogleCredentialSource;
                if (value.object.get("service_account_impersonation_url")) |url| try httpsEndpoint(try nonemptyValue(url));
                if (value.object.get("workforce_pool_user_project")) |_| {
                    const audience = try nonempty(value, "audience");
                    if (!std.mem.startsWith(u8, audience, "//iam.googleapis.com/locations/") or std.mem.indexOf(u8, audience, "/workforcePools/") == null) return error.InvalidGoogleWorkforceAudience;
                }
                self.node = .{ .external = value };
            } else if (std.mem.eql(u8, kind, "impersonated_service_account")) {
                if (options.mode != .kms) return error.UnsupportedGcsAdcCredentialType;
                const source = try rpc.field(value, "source_credentials");
                if (std.mem.eql(u8, try nonempty(source, "type"), "impersonated_service_account")) return error.NestedGoogleImpersonation;
                const url = try nonempty(value, "service_account_impersonation_url");
                try httpsEndpoint(url);
                const serialized = try std.json.Stringify.valueAlloc(a, source, .{});
                defer {
                    std.crypto.secureZero(u8, serialized);
                    a.free(serialized);
                }
                var source_options = options;
                source_options.scope = "https://www.googleapis.com/auth/cloud-platform";
                const base = try openDepth(a, serialized, source_options, depth + 1);
                errdefer base.deinit();
                var delegates: std.ArrayList([]const u8) = .empty;
                const temporary = self.document.?.arena.allocator();
                if (value.object.get("delegates")) |list| {
                    if (list != .array or list.array.items.len > 32) return error.InvalidGoogleDelegates;
                    for (list.array.items) |item| try delegates.append(temporary, try nonemptyValue(item));
                }
                self.options.scope = try configuredScope(temporary, value, options.scope);
                self.node = .{ .impersonated = .{ .source = base, .url = url, .delegates = if (value.object.contains("delegates")) delegates.items else null } };
            } else return error.UnsupportedGoogleCredentialType;
        } else {
            self.quota_project = if (options.mode == .kms) options.environment.get("GOOGLE_CLOUD_QUOTA_PROJECT") else null;
            self.node = .{ .basic = .{ .allocator = a, .transport = options.metadata_transport, .flow = .{ .metadata = .{ .endpoint = options.metadata_endpoint, .scopes = try oneScope(self, options.scope) } } } };
        }
        return self;
    }
    pub fn deinit(self: *Provider) void {
        const a = self.allocator;
        if (self.cached) |*cached| cached.deinit();
        switch (self.node) {
            .basic => |*basic| basic.deinit(),
            .service => |*service| {
                service.oauth.deinit();
                service.account.deinit();
                service.signer.deinit();
                a.destroy(service.signer);
            },
            .impersonated => |value| value.source.deinit(),
            else => {},
        }
        if (self.document) |*document| {
            wipeValue(document.value);
            document.deinit();
        }
        a.destroy(self);
    }
    pub fn token(self: *Provider, now: u64) ![]const u8 {
        if (self.cached) |cached| if (cached.expires_at > now +| 300) return cached.value;
        const fresh = switch (self.node) {
            .none => return error.InvalidGoogleProvider,
            .basic => |*basic| return basic.token(now),
            .service => |*service| blk: {
                if (self.options.mode == .gcs) return service.oauth.token(now);
                const config = service.account.config;
                const expiration = try std.math.add(u64, now, 3600);
                const jwt = try service.signer.signAccessJwt(self.allocator, config.private_key_pem, .{ .issuer = config.client_email, .scope = self.options.scope, .issued_at = now, .expires_at = expiration, .key_id = config.private_key_id });
                defer {
                    std.crypto.secureZero(u8, jwt);
                    self.allocator.free(jwt);
                }
                break :blk try ownedToken(self.allocator, jwt, expiration);
            },
            .external => |value| try self.exchange(value, now),
            .impersonated => |value| try impersonate(self.allocator, self.options.transport, value.url, try value.source.token(now), self.options.scope, value.delegates, value.source.quota_project, now),
        };
        if (self.cached) |*cached| cached.deinit();
        self.cached = fresh;
        return fresh.value;
    }
    fn exchange(self: *Provider, value: Value, now: u64) !identity.AccessToken {
        const a = self.allocator;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        const subject = try self.readSubject(value, now);
        defer {
            std.crypto.secureZero(u8, subject);
            a.free(subject);
        }
        const impersonation = if (value.object.get("service_account_impersonation_url")) |url| try nonemptyValue(url) else null;
        var fields: std.ArrayList(sigv4.Query) = .empty;
        try fields.appendSlice(temporary, &.{ .{ .name = "grant_type", .value = "urn:ietf:params:oauth:grant-type:token-exchange" }, .{ .name = "requested_token_type", .value = "urn:ietf:params:oauth:token-type:access_token" }, .{ .name = "subject_token", .value = subject }, .{ .name = "subject_token_type", .value = try nonempty(value, "subject_token_type") }, .{ .name = "scope", .value = if (impersonation != null) "https://www.googleapis.com/auth/iam" else try configuredScope(temporary, value, self.options.scope) }, .{ .name = "audience", .value = try nonempty(value, "audience") } });
        var headers: std.ArrayList(http.Header) = .empty;
        try headers.append(temporary, .{ .name = "content-type", .value = "application/x-www-form-urlencoded" });
        const client_id = value.object.get("client_id");
        const client_secret = value.object.get("client_secret");
        if (client_id != null and client_secret != null) {
            const raw = try std.fmt.allocPrint(temporary, "{s}:{s}", .{ try rpc.string(client_id.?), try rpc.string(client_secret.?) });
            const encoded = try temporary.alloc(u8, std.base64.url_safe_no_pad.Encoder.calcSize(raw.len));
            _ = std.base64.url_safe_no_pad.Encoder.encode(encoded, raw);
            try headers.append(temporary, .{ .name = "authorization", .value = try std.fmt.allocPrint(temporary, "Basic {s}", .{encoded}) });
        } else if (client_id == null and client_secret == null) if (value.object.get("workforce_pool_user_project")) |project| {
            try fields.append(temporary, .{ .name = "options", .value = try std.json.Stringify.valueAlloc(temporary, .{ .userProject = try nonemptyValue(project) }, .{}) });
        };
        const body = try form(a, fields.items);
        defer {
            std.crypto.secureZero(u8, body);
            a.free(body);
        }
        var response = try self.options.transport.send(a, .{ .method = .POST, .url = try nonempty(value, "token_url"), .headers = headers.items, .body = body, .max_response_bytes = 64 * 1024 });
        defer response.deinit();
        if (!http.isSuccess(response.status)) return error.GoogleStsRejected;
        var parsed = try std.json.parseFromSlice(Value, a, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        defer {
            wipeValue(parsed.value);
            parsed.deinit();
        }
        if (!std.mem.eql(u8, try nonempty(parsed.value, "token_type"), "Bearer") or !std.mem.eql(u8, try nonempty(parsed.value, "issued_token_type"), "urn:ietf:params:oauth:token-type:access_token")) return error.InvalidGoogleStsResponse;
        const access = try nonempty(parsed.value, "access_token");
        const seconds = try rpc.integer(u64, try rpc.field(parsed.value, "expires_in"));
        if (seconds == 0) return error.CredentialsExpired;
        if (impersonation) |url| return impersonate(a, self.options.transport, url, access, try configuredScope(temporary, value, self.options.scope), null, null, now);
        return ownedToken(a, access, try std.math.add(u64, now, seconds));
    }
    fn readSubject(self: *Provider, value: Value, now: u64) ![]u8 {
        const a = self.allocator;
        const source = try rpc.field(value, "credential_source");
        if (source.object.contains("environment_id")) return self.awsSubject(source, try nonempty(value, "audience"), now);
        if (source.object.get("executable")) |executable| return self.runExecutable(executable, now);
        if (source.object.get("url")) |url| {
            const target = try nonemptyValue(url);
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            var headers: std.ArrayList(http.Header) = .empty;
            if (source.object.get("headers")) |values| {
                if (values != .object or values.object.count() > 64) return error.InvalidGoogleSubjectHeaders;
                var iterator = values.object.iterator();
                while (iterator.next()) |entry| try headers.append(arena.allocator(), .{ .name = entry.key_ptr.*, .value = try rpc.string(entry.value_ptr.*) });
            }
            const owner = if (std.mem.startsWith(u8, target, "http://")) self.options.metadata_owner orelse self.options.http_owner else self.options.http_owner;
            const timeout = owner.timeout_ms;
            const connect = owner.connect_timeout_ms;
            defer {
                owner.timeout_ms = timeout;
                owner.connect_timeout_ms = connect;
            }
            owner.timeout_ms = @min(timeout, 10000);
            owner.connect_timeout_ms = @min(connect, owner.timeout_ms);
            const transport = if (std.mem.startsWith(u8, target, "http://")) self.options.metadata_transport else self.options.transport;
            var response = try transport.send(a, .{ .method = .GET, .url = target, .headers = headers.items, .max_response_bytes = 64 * 1024 });
            defer response.deinit();
            if (!http.isSuccess(response.status)) return error.GoogleSubjectRejected;
            return extractSubject(a, source, response.bytes);
        }
        const path = try nonempty(source, "file");
        const bytes = (try self.options.reader.read(a, path, 64 * 1024)) orelse return error.MissingGoogleSubjectFile;
        defer {
            std.crypto.secureZero(u8, bytes);
            a.free(bytes);
        }
        return extractSubject(a, source, bytes);
    }
    fn awsMetadata(self: *Provider, source: Value, url: []const u8, token_: ?[]const u8) !http.Response {
        const headers: []const http.Header = if (token_) |token_value| &.{.{ .name = "x-aws-ec2-metadata-token", .value = token_value }} else &.{};
        var response = try self.options.metadata_transport.send(self.allocator, .{ .method = .GET, .url = url, .headers = headers, .max_response_bytes = 64 * 1024, .metadata_imdsv1 = !source.object.contains("imdsv2_session_token_url") });
        errdefer response.deinit();
        if (!http.isSuccess(response.status)) return error.GoogleAwsMetadataRejected;
        return response;
    }
    fn awsSubject(self: *Provider, source: Value, audience: []const u8, now: u64) ![]u8 {
        const a = self.allocator;
        if (!std.mem.eql(u8, try nonempty(source, "environment_id"), "aws1")) return error.UnsupportedGoogleAwsEnvironment;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        var credential_document: ?Value = null;
        defer if (credential_document) |document| wipeValue(document);
        var metadata_token: ?[]u8 = null;
        defer if (metadata_token) |token_| {
            std.crypto.secureZero(u8, token_);
            a.free(token_);
        };
        if (source.object.get("imdsv2_session_token_url")) |url| {
            var response = try self.options.metadata_transport.send(a, .{ .method = .PUT, .url = try nonemptyValue(url), .headers = &.{.{ .name = "x-aws-ec2-metadata-token-ttl-seconds", .value = "21600" }}, .max_response_bytes = 16384 });
            defer response.deinit();
            if (!http.isSuccess(response.status) or response.bytes.len == 0 or std.mem.indexOfAny(u8, response.bytes, "\r\n\x00") != null) return error.GoogleAwsMetadataRejected;
            metadata_token = try a.dupe(u8, response.bytes);
        }
        const environment = self.options.environment;
        const region = environment.get("AWS_REGION") orelse environment.get("AWS_DEFAULT_REGION") orelse blk: {
            var response = try self.awsMetadata(source, try nonempty(source, "region_url"), metadata_token);
            defer response.deinit();
            const zone = std.mem.trim(u8, response.bytes, " \r\n\t");
            if (zone.len == 0) return error.MissingGoogleAwsRegion;
            const length = if (zone.len > 1 and std.ascii.isAlphabetic(zone[zone.len - 1]) and std.ascii.isDigit(zone[zone.len - 2])) zone.len - 1 else zone.len;
            break :blk try temporary.dupe(u8, zone[0..length]);
        };
        if (region.len == 0 or region.len > 64) return error.InvalidGoogleAwsRegion;
        for (region) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '-') return error.InvalidGoogleAwsRegion;
        var credentials: sigv4.Credentials = undefined;
        if (environment.get("AWS_ACCESS_KEY_ID") != null and environment.get("AWS_SECRET_ACCESS_KEY") != null) {
            credentials = .{ .access_key_id = environment.get("AWS_ACCESS_KEY_ID").?, .secret_access_key = environment.get("AWS_SECRET_ACCESS_KEY").?, .session_token = environment.get("AWS_SESSION_TOKEN") };
        } else {
            const role_url = try nonempty(source, "url");
            var role = try self.awsMetadata(source, role_url, metadata_token);
            defer role.deinit();
            const name = std.mem.trim(u8, role.bytes, " \r\n\t");
            if (name.len == 0 or name.len > 64) return error.InvalidImdsRole;
            for (name) |byte| if (!std.ascii.isAlphanumeric(byte) and std.mem.indexOfScalar(u8, "+=,.@_-", byte) == null) return error.InvalidImdsRole;
            const url = try std.fmt.allocPrint(temporary, "{s}/{s}", .{ std.mem.trimEnd(u8, role_url, "/"), name });
            var response = try self.awsMetadata(source, url, metadata_token);
            defer response.deinit();
            const value = try std.json.parseFromSliceLeaky(Value, temporary, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
            credential_document = value;
            credentials = .{ .access_key_id = try nonempty(value, "AccessKeyId"), .secret_access_key = try nonempty(value, "SecretAccessKey"), .session_token = if (value.object.get("Token")) |token_| try nonemptyValue(token_) else null };
        }
        const template = if (source.object.get("regional_cred_verification_url")) |url| try nonemptyValue(url) else "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15";
        const replaced = try std.mem.replaceOwned(u8, temporary, template, "{region}", region);
        const raw_url = if (std.mem.startsWith(u8, replaced, "https://")) replaced else try std.fmt.allocPrint(temporary, "https://{s}", .{replaced});
        try httpsEndpoint(raw_url);
        const uri = try std.Uri.parse(raw_url);
        const host = try uri.host.?.toRawMaybeAlloc(temporary);
        const raw_path = try uri.path.toRawMaybeAlloc(temporary);
        if (raw_path.len != 0 and !std.mem.eql(u8, raw_path, "/")) return error.InvalidGoogleAwsVerificationUrl;
        const query = if (uri.query) |query_| switch (query_) {
            .raw => |raw| raw,
            .percent_encoded => |raw| raw,
        } else "";
        var fields: std.ArrayList(sigv4.Query) = .empty;
        var pairs = std.mem.splitScalar(u8, query, '&');
        while (pairs.next()) |pair| {
            const equal = std.mem.indexOfScalar(u8, pair, '=') orelse return error.InvalidGoogleAwsVerificationUrl;
            try fields.append(temporary, .{ .name = try decodeQuery(temporary, pair[0..equal]), .value = try decodeQuery(temporary, pair[equal + 1 ..]) });
        }
        var date: [16]u8 = undefined;
        try identity.amzDate(&date, now);
        var signed = try sigv4.sign(a, .{ .method = .POST, .host = host, .path = "/", .query = fields.items, .headers = &.{.{ .name = "x-goog-cloud-target-resource", .value = audience }}, .body = "", .amz_date = &date, .region = region, .service = "sts", .credentials = credentials, .include_content_sha256 = false, .spaced_authorization = true });
        defer signed.deinit();
        const Header = struct { key: []const u8, value: []const u8 };
        var headers: std.ArrayList(Header) = .empty;
        for (signed.headers) |header| try headers.append(temporary, .{ .key = if (std.mem.eql(u8, header.name, "authorization")) "Authorization" else header.name, .value = header.value });
        const authority = if (uri.port) |port| try std.fmt.allocPrint(temporary, "{s}:{d}", .{ host, port }) else host;
        const url = try std.fmt.allocPrint(temporary, "https://{s}/?{s}", .{ authority, query });
        const json = try std.json.Stringify.valueAlloc(a, .{ .url = url, .method = "POST", .headers = headers.items, .body = "" }, .{});
        defer {
            std.crypto.secureZero(u8, json);
            a.free(json);
        }
        return http.percentEncode(a, json, false);
    }
    fn runExecutable(self: *Provider, config: Value, now: u64) ![]u8 {
        const a = self.allocator;
        if (config != .object) return error.InvalidGoogleExecutable;
        if (config.object.get("output_file")) |path| {
            const cached = self.options.reader.read(a, try nonemptyValue(path), 64 * 1024) catch |err| blk: {
                if (rpc.isControl(err)) return err;
                break :blk null;
            };
            if (cached) |bytes| {
                defer {
                    std.crypto.secureZero(u8, bytes);
                    a.free(bytes);
                }
                if (parseExecutable(a, bytes, now)) |token_| return token_ else |err| if (rpc.isControl(err)) return err;
            }
        }
        if (!std.mem.eql(u8, self.options.environment.get("GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES") orelse "0", "1")) return error.GoogleExecutableNotAllowed;
        const text = try nonempty(config, "command");
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var argv: std.ArrayList([]const u8) = .empty;
        var split = std.mem.tokenizeAny(u8, text, " \t\r\n");
        while (split.next()) |arg| try argv.append(arena.allocator(), arg);
        if (argv.items.len == 0) return error.InvalidCredentialCommand;
        const configured = if (config.object.get("timeout_millis")) |milliseconds| try rpc.integer(u32, milliseconds) else 30000;
        const output = try self.options.runner.executeArgv(a, argv.items, self.options.environment, .{ .timeout_ms = @min(configured, self.options.http_owner.timeout_ms), .cancel = self.options.http_owner.cancel });
        defer {
            std.crypto.secureZero(u8, output);
            a.free(output);
        }
        return parseExecutable(a, output, now);
    }
};
fn decodeQuery(a: A, raw: []const u8) ![]const u8 {
    const plus = try a.dupe(u8, raw);
    for (plus) |*byte| if (byte.* == '+') {
        byte.* = ' ';
    };
    const component: std.Uri.Component = .{ .percent_encoded = plus };
    return component.toRawMaybeAlloc(a);
}
fn oneScope(self: *Provider, scope: []const u8) ![]const []const u8 {
    // Metadata has no JSON document; own the tiny scope list with a parsed arena
    // so the provider's complete storage has the same release boundary.
    self.document = try std.json.parseFromSlice(Value, self.allocator, "{}", .{ .allocate = .alloc_always });
    const out = try self.document.?.arena.allocator().alloc([]const u8, 1);
    out[0] = scope;
    return out;
}
fn subjectText(value: Value) ![]const u8 {
    const text = try rpc.string(value);
    if (text.len == 0 or std.mem.indexOfScalar(u8, text, 0) != null or !std.unicode.utf8ValidateSlice(text)) return error.InvalidGoogleSubjectToken;
    return text;
}
fn nonemptyValue(value: Value) ![]const u8 {
    const text = try rpc.string(value);
    if (text.len == 0 or std.mem.indexOfAny(u8, text, "\r\n\x00") != null) return error.InvalidGoogleCredentialValue;
    return text;
}
fn nonempty(value: Value, name: []const u8) ![]const u8 {
    return nonemptyValue(try rpc.field(value, name));
}
fn httpsEndpoint(url: []const u8) !void {
    const uri = try std.Uri.parse(url);
    if (!std.mem.eql(u8, uri.scheme, "https") or uri.host == null or uri.user != null or uri.password != null or uri.fragment != null) return error.InvalidGoogleIdentityEndpoint;
}
fn ownedToken(a: A, text: []const u8, expires: u64) !identity.AccessToken {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const value = try arena.allocator().dupe(u8, text);
    return .{ .arena = arena, .value = value, .expires_at = expires };
}
fn configuredScope(a: A, value: Value, fallback: []const u8) ![]const u8 {
    if (value.object.get("scopes")) |scopes| {
        if (scopes != .array or scopes.array.items.len > 64) return error.InvalidGoogleScopes;
        if (scopes.array.items.len > 0) {
            var result: std.ArrayList(u8) = .empty;
            for (scopes.array.items, 0..) |scope, i| {
                if (i != 0) try result.append(a, ' ');
                try result.appendSlice(a, try nonemptyValue(scope));
            }
            return result.items;
        }
    }
    return fallback;
}
fn form(a: A, fields: []const sigv4.Query) ![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(a);
    for (fields, 0..) |field, i| {
        if (i != 0) try output.append(a, '&');
        const key = try http.percentEncode(a, field.name, false);
        defer a.free(key);
        const value = try http.percentEncode(a, field.value, false);
        defer {
            std.crypto.secureZero(u8, value);
            a.free(value);
        }
        try output.appendSlice(a, key);
        try output.append(a, '=');
        try output.appendSlice(a, value);
    }
    return output.toOwnedSlice(a);
}
fn extractSubject(a: A, source: Value, bytes: []const u8) ![]u8 {
    if (source.object.get("format")) |format| {
        const kind = try nonempty(format, "type");
        if (std.mem.eql(u8, kind, "json")) {
            var parsed = try std.json.parseFromSlice(Value, a, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
            defer {
                wipeValue(parsed.value);
                parsed.deinit();
            }
            return a.dupe(u8, try subjectText(try rpc.field(parsed.value, try nonempty(format, "subject_token_field_name"))));
        }
        if (!std.mem.eql(u8, kind, "text")) return error.UnsupportedGoogleSubjectFormat;
    }
    if (bytes.len == 0 or !std.unicode.utf8ValidateSlice(bytes) or std.mem.indexOfScalar(u8, bytes, 0) != null) return error.InvalidGoogleSubjectToken;
    return a.dupe(u8, bytes);
}
fn parseExecutable(a: A, bytes: []const u8, now: u64) ![]u8 {
    var parsed = try std.json.parseFromSlice(Value, a, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
    defer {
        wipeValue(parsed.value);
        parsed.deinit();
    }
    if (try rpc.integer(u32, try rpc.field(parsed.value, "version")) != 1 or !try boolean(try rpc.field(parsed.value, "success"))) return error.GoogleExecutableRejected;
    if (parsed.value.object.get("expiration_time")) |expiration| if (try rpc.integer(u64, expiration) < now) return error.CredentialsExpired;
    const kind = try nonempty(parsed.value, "token_type");
    const token_ = if (std.mem.eql(u8, kind, "urn:ietf:params:oauth:token-type:saml2")) try subjectText(try rpc.field(parsed.value, "saml_response")) else if (std.mem.eql(u8, kind, "urn:ietf:params:oauth:token-type:jwt") or std.mem.eql(u8, kind, "urn:ietf:params:oauth:token-type:id_token") or std.mem.eql(u8, kind, "urn:ietf:params:oauth:token-type:access_token")) try subjectText(try rpc.field(parsed.value, "id_token")) else return error.UnsupportedGoogleExecutableTokenType;
    return a.dupe(u8, token_);
}
fn impersonate(a: A, transport: http.Transport, url: []const u8, bearer: []const u8, scope: []const u8, delegates: ?[]const []const u8, quota_project: ?[]const u8, now: u64) !identity.AccessToken {
    try httpsEndpoint(url);
    const authorization = try std.fmt.allocPrint(a, "Bearer {s}", .{bearer});
    defer {
        std.crypto.secureZero(u8, authorization);
        a.free(authorization);
    }
    var scopes = std.mem.tokenizeScalar(u8, scope, ' ');
    var list: std.ArrayList([]const u8) = .empty;
    defer list.deinit(a);
    while (scopes.next()) |item| try list.append(a, item);
    const body = try std.json.Stringify.valueAlloc(a, .{ .delegates = delegates, .scope = list.items, .lifetime = "3600s" }, .{ .emit_null_optional_fields = false });
    defer a.free(body);
    var headers: std.ArrayList(http.Header) = .empty;
    defer headers.deinit(a);
    try headers.appendSlice(a, &.{ .{ .name = "authorization", .value = authorization }, .{ .name = "content-type", .value = "application/json" } });
    if (quota_project) |project| try headers.append(a, .{ .name = "x-goog-user-project", .value = project });
    var response = try transport.send(a, .{ .method = .POST, .url = url, .headers = headers.items, .body = body, .max_response_bytes = 64 * 1024 });
    defer response.deinit();
    if (!http.isSuccess(response.status)) return error.GoogleImpersonationRejected;
    var parsed = try std.json.parseFromSlice(Value, a, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
    defer {
        wipeValue(parsed.value);
        parsed.deinit();
    }
    const expires = try identity.parseRfc3339(try nonempty(parsed.value, "expireTime"));
    if (expires <= now) return error.CredentialsExpired;
    return ownedToken(a, try nonempty(parsed.value, "accessToken"), expires);
}
fn boolean(value: Value) !bool {
    if (value != .bool) return error.InvalidGoogleCredentialValue;
    return value.bool;
}
fn wipeValue(value: Value) void {
    switch (value) {
        .string => |text| std.crypto.secureZero(u8, @constCast(text)),
        .object => |object| {
            var iterator = object.iterator();
            while (iterator.next()) |entry| wipeValue(entry.value_ptr.*);
        },
        .array => |array| for (array.items) |item| wipeValue(item),
        else => {},
    }
}
test {
    std.testing.refAllDecls(@This());
    _ = @import("google_adc_test.zig");
}
