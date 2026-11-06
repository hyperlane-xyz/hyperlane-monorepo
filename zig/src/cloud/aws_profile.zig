//! AWS aws-config1.1.9 profile credential semantics, independently of the custom
//! Rusoto KMS chain. Explicit files/environment/transport; no ambient discovery.
const std = @import("std");
const http = @import("http.zig");
const identity = @import("identity.zig");
const sigv4 = @import("sigv4.zig");
const io = @import("credential_io.zig");
const command = @import("command.zig");
const rpc = @import("../net/json_rpc.zig");
const A = std.mem.Allocator;
const Fields = std.StringHashMap([]const u8);
const Profiles = std.StringHashMap(Fields);
pub const Options = struct {
    environment: *const std.process.EnvMap,
    reader: io.Reader = .{},
    writer: io.Writer = .{},
    runner: command.Runner = .{},
    transport: http.Transport,
    metadata_transport: http.Transport,
    http_owner: *http.HttpTransport,
    region: []const u8 = "us-east-1",
    sts_endpoint: []const u8 = "https://sts.amazonaws.com/",
    imds_endpoint: []const u8 = "http://169.254.169.254",
    /// Explicit test-only endpoint injection, never credential-file redirects.
    sso_endpoint: ?[]const u8 = null,
    oidc_endpoint: ?[]const u8 = null,
};
const Document = struct {
    arena: std.heap.ArenaAllocator,
    buffers: [2]?[]u8 = .{ null, null },
    profiles: Profiles,
    sessions: Profiles,
    secrets: std.ArrayList([]u8) = .empty,
    fn init(a: A, options: Options) !*Document {
        const self = try a.create(Document);
        self.* = .{ .arena = .init(a), .profiles = undefined, .sessions = undefined };
        const temporary = self.arena.allocator();
        self.profiles = Profiles.init(temporary);
        self.sessions = Profiles.init(temporary);
        errdefer self.deinit(a);
        for ([_]bool{ true, false }, 0..) |configuration, index| {
            const selected = options.environment.get(if (configuration) "AWS_CONFIG_FILE" else "AWS_SHARED_CREDENTIALS_FILE");
            const path = if (selected) |value| value else if (options.environment.get("HOME")) |home| try std.fs.path.join(temporary, &.{ home, ".aws", if (configuration) "config" else "credentials" }) else continue;
            const bytes = (try options.reader.read(a, path, 64 * 1024)) orelse continue;
            self.buffers[index] = bytes;
            try self.parse(bytes, configuration);
        }
        return self;
    }
    fn deinit(self: *Document, a: A) void {
        for (self.buffers) |buffer| if (buffer) |bytes| {
            std.crypto.secureZero(u8, bytes);
            a.free(bytes);
        };
        for (self.secrets.items) |secret| std.crypto.secureZero(u8, secret);
        self.arena.deinit();
        a.destroy(self);
    }
    fn retainSecret(self: *Document, bytes: []const u8) ![]const u8 {
        const copy = try self.arena.allocator().dupe(u8, bytes);
        try self.secrets.append(self.arena.allocator(), copy);
        return copy;
    }
    fn parse(self: *Document, bytes: []const u8, configuration: bool) !void {
        if (!std.unicode.utf8ValidateSlice(bytes) or std.mem.indexOfScalar(u8, bytes, 0) != null) return error.InvalidAwsProfile;
        const a = self.arena.allocator();
        var selected: ?*Fields = null;
        var lines = std.mem.splitScalar(u8, bytes, '\n');
        while (lines.next()) |raw| {
            const line = std.mem.trim(u8, raw, " \r\t");
            if (line.len == 0 or line[0] == '#' or line[0] == ';') continue;
            if (line[0] == '[') {
                if (line[line.len - 1] != ']') return error.InvalidAwsProfile;
                var name = std.mem.trim(u8, line[1 .. line.len - 1], " \t");
                var target = &self.profiles;
                if (configuration) {
                    if (std.mem.startsWith(u8, name, "profile ")) name = std.mem.trim(u8, name[8..], " \t") else if (std.mem.startsWith(u8, name, "sso-session ")) {
                        name = std.mem.trim(u8, name[12..], " \t");
                        target = &self.sessions;
                    } else if (!std.mem.eql(u8, name, "default")) {
                        selected = null;
                        continue;
                    }
                }
                if (name.len == 0 or name.len > 256) return error.InvalidAwsProfile;
                const entry = try target.getOrPut(name);
                if (!entry.found_existing) entry.value_ptr.* = Fields.init(a);
                selected = entry.value_ptr;
                continue;
            }
            const fields = selected orelse continue;
            const separator = std.mem.indexOfScalar(u8, line, '=') orelse return error.InvalidAwsProfile;
            const key = std.mem.trim(u8, line[0..separator], " \t");
            const value = std.mem.trim(u8, line[separator + 1 ..], " \t");
            if (key.len == 0) return error.InvalidAwsProfile;
            // Source SDK merges credentials over config and accepts the last
            // property in a file. Values remain slices of owned secret buffers.
            try fields.put(key, value);
        }
    }
};
const Role = struct { source: *Provider, arn: []const u8, external: ?[]const u8, session: []const u8 };
const Web = struct { provider: identity.AwsWebIdentity, path: []const u8 };
const Sso = struct { session: ?[]const u8, region: []const u8, start_url: []const u8, account: []const u8, role: []const u8, token: ?Token = null, last_refresh: ?u64 = null };
const Token = struct {
    parsed: std.json.Parsed(std.json.Value),
    path: []u8,
    fn deinit(self: *Token, a: A) void {
        // The parsed arena can contain refresh and client secrets as well as
        // access tokens. Wipe every JSON string before releasing that arena.
        wipeValue(self.parsed.value);
        self.parsed.deinit();
        a.free(self.path);
    }
};
pub const Provider = struct {
    allocator: A,
    options: Options,
    document: ?*Document = null,
    cached: ?identity.AwsCredentials = null,
    node: union(enum) { none, static: sigv4.Credentials, role: Role, web: Web, process: []const u8, imds: identity.AwsImds, container: identity.AwsContainer, sso: Sso } = .none,
    pub fn open(a: A, options: Options) !?*Provider {
        const document = try Document.init(a, options);
        errdefer document.deinit(a);
        const selected = options.environment.get("AWS_PROFILE") orelse options.environment.get("AWS_DEFAULT_PROFILE") orelse "default";
        if (!document.profiles.contains(selected)) {
            if (std.mem.eql(u8, selected, "default")) {
                document.deinit(a);
                return null;
            }
            return error.MissingAwsProfile;
        }
        const result = resolve(a, document, options, selected, &.{}, false) catch |err| {
            if (err == error.NoAwsProfileCredentials) {
                document.deinit(a);
                return null;
            }
            return err;
        };
        result.document = document;
        return result;
    }
    pub fn deinit(self: *Provider) void {
        const a = self.allocator;
        if (self.cached) |*cached| cached.deinit();
        switch (self.node) {
            .role => |role| role.source.deinit(),
            .web => |*web| web.provider.deinit(),
            .imds => |*imds| imds.deinit(),
            .container => |*container| container.deinit(),
            .sso => |*sso| if (sso.token) |*token| token.deinit(a),
            else => {},
        }
        if (self.document) |document| document.deinit(a);
        a.destroy(self);
    }
    pub fn credentials(self: *Provider, now: u64) !sigv4.Credentials {
        if (self.cached) |cached| if (cached.expires_at == null or cached.expires_at.? > now +| 300) return cached.value;
        const a = self.allocator;
        const fresh = switch (self.node) {
            .none => return error.NoAwsProfileCredentials,
            .static => |value| return value,
            .web => |*web| return web.provider.credentials(now),
            .imds => |*imds| return imds.credentials(now),
            .container => |*container| return container.credentials(now),
            .role => |role| try identity.assumeRole(a, self.options.transport, try role.source.credentials(now), .{ .endpoint = self.options.sts_endpoint, .region = self.options.region, .role_arn = role.arn, .session_name = role.session, .external_id = role.external }, now),
            .process => |text| blk: {
                const bytes = try self.options.runner.execute(a, text, self.options.environment, .{ .timeout_ms = @min(self.options.http_owner.timeout_ms, 30000), .cancel = self.options.http_owner.cancel });
                defer {
                    std.crypto.secureZero(u8, bytes);
                    a.free(bytes);
                }
                break :blk try parseProcess(a, bytes, now);
            },
            .sso => |*sso| try self.ssoCredentials(sso, now),
        };
        if (self.cached) |*cached| cached.deinit();
        self.cached = fresh;
        return fresh.value;
    }
    fn readWeb(ctx: *anyopaque, a: A) ![]u8 {
        const self: *Provider = @ptrCast(@alignCast(ctx));
        return (try self.options.reader.read(a, self.node.web.path, 20001)) orelse error.MissingWebIdentityTokenFile;
    }
    fn loadToken(self: *Provider, sso: *Sso) !Token {
        const home = self.options.environment.get("HOME") orelse return error.MissingSsoHome;
        const identifiers = [_]?[]const u8{sso.session orelse sso.start_url};
        for (identifiers) |candidate| if (candidate) |identifier| {
            var sha: [20]u8 = undefined;
            std.crypto.hash.Sha1.hash(identifier, &sha, .{});
            const path = try std.fmt.allocPrint(self.allocator, "{s}/.aws/sso/cache/{s}.json", .{ std.mem.trimEnd(u8, home, "/"), std.fmt.bytesToHex(sha, .lower) });
            errdefer self.allocator.free(path);
            const bytes = (try self.options.reader.read(self.allocator, path, 64 * 1024)) orelse {
                self.allocator.free(path);
                continue;
            };
            defer {
                std.crypto.secureZero(u8, bytes);
                self.allocator.free(bytes);
            }
            var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
            errdefer {
                wipeValue(parsed.value);
                parsed.deinit();
            }
            _ = try rpc.string(try rpc.field(parsed.value, "accessToken"));
            _ = try identity.parseRfc3339(try rpc.string(try rpc.field(parsed.value, "expiresAt")));
            return .{ .parsed = parsed, .path = path };
        };
        return error.MissingSsoToken;
    }
    fn refreshSsoToken(self: *Provider, sso: *Sso, token: *Token, now: u64) !bool {
        const a = self.allocator;
        const value = token.parsed.value;
        const endpoint = self.options.oidc_endpoint orelse try std.fmt.allocPrint(a, "https://oidc.{s}.amazonaws.com/token", .{sso.region});
        defer if (self.options.oidc_endpoint == null) a.free(endpoint);
        const body = try std.json.Stringify.valueAlloc(a, .{ .clientId = try rpc.string(try rpc.field(value, "clientId")), .clientSecret = try rpc.string(try rpc.field(value, "clientSecret")), .grantType = "refresh_token", .refreshToken = try rpc.string(try rpc.field(value, "refreshToken")) }, .{});
        defer {
            std.crypto.secureZero(u8, body);
            a.free(body);
        }
        var response = self.options.transport.send(a, .{ .method = .POST, .url = endpoint, .headers = &.{.{ .name = "content-type", .value = "application/json" }}, .body = body, .max_response_bytes = 64 * 1024 }) catch |err| {
            if (rpc.isControl(err)) return err;
            return false;
        };
        defer response.deinit();
        if (response.status != 200) return false;
        var refreshed = try std.json.parseFromSlice(std.json.Value, a, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        defer {
            wipeValue(refreshed.value);
            refreshed.deinit();
        }
        const access_value = refreshed.value.object.get("accessToken") orelse return false;
        const access = try rpc.string(access_value);
        const seconds = try rpc.integer(u64, try rpc.field(refreshed.value, "expiresIn"));
        if (access.len == 0 or seconds == 0) return error.CredentialsExpired;
        // Rotate refresh state only after its private cache write succeeds.
        // An interrupted write must not silently suppress persistence later.
        const original = try std.json.Stringify.valueAlloc(a, value, .{});
        defer {
            std.crypto.secureZero(u8, original);
            a.free(original);
        }
        var updated = try std.json.parseFromSlice(std.json.Value, a, original, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        var transferred = false;
        defer if (!transferred) {
            wipeValue(updated.value);
            updated.deinit();
        };
        const temporary = updated.arena.allocator();
        if (updated.value.object.get("accessToken")) |old| wipeValue(old);
        try updated.value.object.put("accessToken", .{ .string = try temporary.dupe(u8, access) });
        const expiration = try formatUtc(temporary, try std.math.add(u64, now, seconds));
        if (updated.value.object.get("expiresAt")) |old| wipeValue(old);
        try updated.value.object.put("expiresAt", .{ .string = expiration });
        if (refreshed.value.object.get("refreshToken")) |refresh| {
            if (updated.value.object.get("refreshToken")) |old| wipeValue(old);
            try updated.value.object.put("refreshToken", .{ .string = try temporary.dupe(u8, try rpc.string(refresh)) });
        }
        const encoded = try std.json.Stringify.valueAlloc(a, updated.value, .{});
        defer {
            std.crypto.secureZero(u8, encoded);
            a.free(encoded);
        }
        try self.options.writer.write(a, token.path, encoded);
        wipeValue(token.parsed.value);
        token.parsed.deinit();
        token.parsed = updated;
        transferred = true;
        return true;
    }
    fn ssoCredentials(self: *Provider, sso: *Sso, now: u64) !identity.AwsCredentials {
        const a = self.allocator;
        if (sso.token) |*old| old.deinit(a);
        sso.token = null;
        sso.token = try self.loadToken(sso);
        const token = &sso.token.?;
        var value = token.parsed.value;
        const expiry = try identity.parseRfc3339(try rpc.string(try rpc.field(value, "expiresAt")));
        const registration = if (value.object.get("registrationExpiresAt")) |registration_| try identity.parseRfc3339(try rpc.string(registration_)) else 0;
        const refreshable = sso.session != null and registration > now and value.object.contains("clientId") and value.object.contains("clientSecret") and value.object.contains("refreshToken") and (sso.last_refresh == null or now -| sso.last_refresh.? >= 30);
        if (expiry <= now and !refreshable) return error.SsoLoginRequired;
        if (expiry <= now +| 300 and refreshable) {
            // Source tolerates a failed proactive OIDC refresh while the old
            // access token still lives. Cache-write/parse errors remain fatal.
            const refreshed = try self.refreshSsoToken(sso, token, now);
            sso.last_refresh = now;
            if (!refreshed and expiry <= now) return error.SsoLoginRequired;
            value = token.parsed.value;
        }
        const access_token = try rpc.string(try rpc.field(value, "accessToken"));
        if (access_token.len == 0 or std.mem.indexOfAny(u8, access_token, "\r\n\x00") != null) return error.InvalidSsoToken;
        const endpoint = self.options.sso_endpoint orelse try std.fmt.allocPrint(a, "https://portal.sso.{s}.amazonaws.com", .{sso.region});
        defer if (self.options.sso_endpoint == null) a.free(endpoint);
        const account = try http.percentEncode(a, sso.account, false);
        defer a.free(account);
        const role = try http.percentEncode(a, sso.role, false);
        defer a.free(role);
        const url = try std.fmt.allocPrint(a, "{s}/federation/credentials?account_id={s}&role_name={s}", .{ std.mem.trimEnd(u8, endpoint, "/"), account, role });
        defer a.free(url);
        var response = try self.options.transport.send(a, .{ .method = .GET, .url = url, .headers = &.{.{ .name = "x-amz-sso_bearer_token", .value = access_token }}, .max_response_bytes = 64 * 1024 });
        defer response.deinit();
        if (response.status != 200) return error.SsoCredentialsRejected;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
        const credentials_ = try rpc.field(parsed, "roleCredentials");
        const expires = try rpc.integer(u64, try rpc.field(credentials_, "expiration")) / 1000;
        if (expires <= now) return error.CredentialsExpired;
        return .{ .arena = arena, .expires_at = expires, .value = .{ .access_key_id = try nonempty(credentials_, "accessKeyId"), .secret_access_key = try nonempty(credentials_, "secretAccessKey"), .session_token = if (credentials_.object.get("sessionToken")) |session| try rpc.string(session) else null } };
    }
};
fn allocate(a: A, options: Options) !*Provider {
    const self = try a.create(Provider);
    self.* = .{ .allocator = a, .options = options };
    return self;
}
fn resolve(a: A, document: *Document, options: Options, name: []const u8, visited: []const []const u8, prefer_static: bool) anyerror!*Provider {
    if (visited.len >= 32) return error.AwsProfileChainTooDeep;
    for (visited) |previous| if (std.mem.eql(u8, previous, name)) return error.AwsProfileCycle;
    const fields = document.profiles.get(name) orelse return error.MissingAwsProfile;
    const self = try allocate(a, options);
    errdefer self.deinit();
    if (prefer_static) if (staticCredentials(fields) catch null) |value| {
        self.node = .{ .static = value };
        return self;
    };
    if (fields.get("role_arn")) |arn| if (!fields.contains("web_identity_token_file")) {
        const source = fields.get("source_profile");
        const credential_source = fields.get("credential_source");
        if ((source == null) == (credential_source == null)) return error.InvalidAwsCredentialSource;
        var chain: [32][]const u8 = undefined;
        @memcpy(chain[0..visited.len], visited);
        chain[visited.len] = name;
        const base = if (source != null and !std.mem.eql(u8, source.?, name)) resolve(a, document, options, source.?, chain[0 .. visited.len + 1], true) catch |err| {
            if (err == error.NoAwsProfileCredentials) return error.InvalidAwsCredentialSource;
            return err;
        } else try baseProvider(a, document, options, fields);
        self.node = .{ .role = .{ .source = base, .arn = arn, .external = fields.get("external_id"), .session = fields.get("role_session_name") orelse "assume-role-from-profile" } };
        return self;
    };
    const base = try baseProvider(a, document, options, fields);
    a.destroy(self);
    return base;
}
fn staticCredentials(fields: Fields) !?sigv4.Credentials {
    const access = fields.get("aws_access_key_id");
    const secret = fields.get("aws_secret_access_key");
    const session = fields.get("aws_session_token");
    if (access == null and secret == null and session == null) return null;
    if (access == null or secret == null or access.?.len == 0 or secret.?.len == 0) return error.IncompleteAwsProfile;
    return .{ .access_key_id = access.?, .secret_access_key = secret.?, .session_token = session };
}
fn baseProvider(a: A, document: *Document, options: Options, fields: Fields) !*Provider {
    const self = try allocate(a, options);
    errdefer self.deinit();
    if (fields.get("credential_source")) |source| {
        if (std.mem.eql(u8, source, "Environment")) {
            self.cached = (try sdkEnvironment(a, options.environment)) orelse return error.NoAwsEnvironmentCredentials;
            self.node = .{ .static = self.cached.?.value };
        } else if (std.mem.eql(u8, source, "Ec2InstanceMetadata")) {
            self.node = .{ .imds = .{ .allocator = a, .transport = options.metadata_transport, .endpoint = options.imds_endpoint } };
        } else if (std.mem.eql(u8, source, "EcsContainer")) {
            const endpoint = (try identity.containerEndpointFromEnvironment(document.arena.allocator(), options.environment)) orelse return error.NoAwsContainerEndpoint;
            var authorization = options.environment.get("AWS_CONTAINER_AUTHORIZATION_TOKEN");
            if (options.environment.get("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")) |path| {
                const bytes = (try options.reader.read(a, path, 16384)) orelse return error.MissingContainerTokenFile;
                defer {
                    std.crypto.secureZero(u8, bytes);
                    a.free(bytes);
                }
                authorization = try document.retainSecret(std.mem.trim(u8, bytes, " \r\n\t"));
            }
            self.node = .{ .container = .{ .allocator = a, .transport = options.metadata_transport, .endpoint = endpoint, .authorization_token = authorization } };
        } else return error.UnknownAwsCredentialSource;
    } else if (fields.get("web_identity_token_file")) |path| {
        const arn = fields.get("role_arn") orelse return error.InvalidAwsCredentialSource;
        self.node = .{ .web = .{ .path = path, .provider = .{ .allocator = a, .transport = options.transport, .token_source = .{ .context = self, .read_fn = Provider.readWeb }, .endpoint = options.sts_endpoint, .role_arn = arn, .session_name = fields.get("role_session_name") orelse "web-identity-token-profile" } } };
    } else if (fields.contains("sso_session") or fields.contains("sso_region") or fields.contains("sso_start_url") or fields.contains("sso_account_id") or fields.contains("sso_role_name")) {
        const session_name = fields.get("sso_session");
        const session = if (session_name) |name| document.sessions.get(name) orelse return error.MissingAwsSsoSession else fields;
        if (session_name != null and (fields.contains("sso_region") or fields.contains("sso_start_url"))) return error.InvalidAwsSsoSession;
        const region = session.get("sso_region") orelse return error.IncompleteAwsSsoProfile;
        if (region.len == 0 or region.len > 64) return error.InvalidAwsSsoRegion;
        for (region) |byte| if (!std.ascii.isAlphanumeric(byte) and byte != '-') return error.InvalidAwsSsoRegion;
        self.node = .{ .sso = .{ .session = session_name, .region = region, .start_url = session.get("sso_start_url") orelse return error.IncompleteAwsSsoProfile, .account = fields.get("sso_account_id") orelse return error.IncompleteAwsSsoProfile, .role = fields.get("sso_role_name") orelse return error.IncompleteAwsSsoProfile } };
    } else if (fields.get("credential_process")) |text| {
        self.node = .{ .process = text };
    } else {
        self.node = .{ .static = (try staticCredentials(fields)) orelse return error.NoAwsProfileCredentials };
    }
    return self;
}
fn nonempty(value: std.json.Value, name: []const u8) ![]const u8 {
    const text = try rpc.string(try rpc.field(value, name));
    if (text.len == 0 or std.mem.indexOfAny(u8, text, "\r\n\x00") != null) return error.InvalidAwsCredentialResponse;
    return text;
}
pub fn parseProcess(a: A, bytes: []const u8, now: u64) !identity.AwsCredentials {
    if (bytes.len > 64 * 1024) return error.CredentialCommandOutputLimit;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" });
    if (parsed != .object) return error.InvalidAwsCredentialResponse;
    var normalized = std.json.ObjectMap.init(arena.allocator());
    var fields = parsed.object.iterator();
    while (fields.next()) |entry| {
        const name = try arena.allocator().dupe(u8, entry.key_ptr.*);
        for (name) |*byte| byte.* = std.ascii.toLower(byte.*);
        if (normalized.contains(name)) return error.AmbiguousAwsCredentialResponse;
        try normalized.put(name, entry.value_ptr.*);
    }
    const value: std.json.Value = .{ .object = normalized };
    if (try rpc.integer(u32, try rpc.field(value, "version")) != 1) return error.UnsupportedCredentialProcessVersion;
    const expiry = if (normalized.get("expiration")) |expiration| try identity.parseRfc3339(try rpc.string(expiration)) else null;
    if (expiry != null and expiry.? <= now) return error.CredentialsExpired;
    return .{ .arena = arena, .expires_at = expiry, .value = .{ .access_key_id = try nonempty(value, "accesskeyid"), .secret_access_key = try nonempty(value, "secretaccesskey"), .session_token = if (normalized.get("sessiontoken")) |session| try rpc.string(session) else null } };
}
fn wipeValue(value: std.json.Value) void {
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
fn formatUtc(a: A, seconds: u64) ![]u8 {
    var date: [16]u8 = undefined;
    try identity.amzDate(&date, seconds);
    return std.fmt.allocPrint(a, "{s}-{s}-{s}T{s}:{s}:{s}Z", .{ date[0..4], date[4..6], date[6..8], date[9..11], date[11..13], date[13..15] });
}

test {
    std.testing.refAllDecls(@This());
    _ = @import("aws_profile_test.zig");
}

/// SDK storage environment chain skips partial/blank pairs, supports its actual
/// SECRET_ACCESS_KEY fallback and trims the optional session token. KMS retains
/// the separate Rusoto provider and never calls this helper.
pub fn sdkEnvironment(a: A, env: *const std.process.EnvMap) !?identity.AwsCredentials {
    const access = env.get("AWS_ACCESS_KEY_ID") orelse return null;
    if (std.mem.trim(u8, access, " \r\n\t").len == 0) return null;
    const primary = env.get("AWS_SECRET_ACCESS_KEY");
    const secret = if (primary != null and std.mem.trim(u8, primary.?, " \r\n\t").len != 0) primary.? else env.get("SECRET_ACCESS_KEY") orelse return null;
    if (std.mem.trim(u8, secret, " \r\n\t").len == 0) return null;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const temporary = arena.allocator();
    var session: ?[]const u8 = null;
    if (env.get("AWS_SESSION_TOKEN")) |token| {
        const trimmed = std.mem.trim(u8, token, " \r\n\t");
        if (trimmed.len != 0) session = try temporary.dupe(u8, trimmed);
    }
    const value: sigv4.Credentials = .{ .access_key_id = try temporary.dupe(u8, access), .secret_access_key = try temporary.dupe(u8, secret), .session_token = session };
    return .{ .arena = arena, .value = value };
}
