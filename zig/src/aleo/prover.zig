//! Source delegated-prover protocol: JWT Authorization response header, endpoint
//! cookie session, fresh endpoint-local X25519 sealed box, no timeout replay.
const std = @import("std");
const http = @import("../cloud/http.zig");
const endpoint = @import("../net/endpoint.zig");
const rest = @import("rest.zig");
const rpc = @import("../net/json_rpc.zig");
const common = @import("../agents/scraper/receipts_common.zig");
const A = std.mem.Allocator;
const Cookie = struct { name: []u8, value: []u8, domain: []u8, path: []u8, secure: bool, host_only: bool, expires: ?i64 };
const Target = struct {
    endpoint: endpoint.OwnedEndpoint,
    auth_url: []u8,
    token: ?[]u8 = null,
    expires_ns: u64 = 0,
    cookies: std.ArrayList(Cookie) = .empty,
};
pub const Prover = struct {
    allocator: A,
    transport: http.Transport,
    network: u16,
    targets: []Target,
    initialized: usize = 0,
    http_owner: ?*http.HttpTransport = null,
    allow_fixture_transport: bool = false,
    last_status: ?u16 = null,
    pub fn init(a: A, transport: http.Transport, urls: []const []const u8, network: u16) !*Prover {
        _ = try rest.networkName(network);
        if (urls.len == 0 or urls.len > 64) return error.InvalidAleoProvers;
        const self = try a.create(Prover);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .transport = transport, .network = network, .targets = try a.alloc(Target, urls.len) };
        errdefer self.clear();
        for (urls, self.targets) |url, *target| {
            var owned = try endpoint.OwnedEndpoint.parse(a, url);
            errdefer owned.deinit();
            var auth: ?[]const u8 = null;
            for (owned.endpoint.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "x-auth-url")) {
                auth = header.value;
            };
            const auth_url = auth orelse return error.MissingAleoProverAuthUrl;
            try validateUrl(owned.endpoint.url);
            try validateUrl(auth_url);
            target.* = .{ .endpoint = owned, .auth_url = try a.dupe(u8, auth_url) };
            self.initialized += 1;
        }
        return self;
    }
    fn clear(self: *Prover) void {
        for (self.targets[0..self.initialized]) |*target| {
            target.endpoint.deinit();
            wipe(self.allocator, target.auth_url);
            if (target.token) |cached| wipe(self.allocator, cached);
            for (target.cookies.items) |cookie| freeCookie(self.allocator, cookie);
            target.cookies.deinit(self.allocator);
        }
        self.allocator.free(self.targets);
    }
    pub fn deinit(self: *Prover) void {
        const a = self.allocator;
        self.clear();
        a.destroy(self);
    }
    fn send(self: *Prover, outbound: http.Request, deadline: u64) !http.Response {
        _ = try common.milliseconds(deadline);
        if (self.http_owner) |owner| {
            var budget: common.DeadlineTransport = .{ .rpc_read = false, .owner = owner, .deadline_ns = deadline, .allow_std_fixture = self.allow_fixture_transport };
            try budget.verify(self.transport);
            return budget.interface().send(self.allocator, outbound);
        }
        if (!self.allow_fixture_transport) return error.NativeProverTransportRequired;
        return self.transport.send(self.allocator, outbound);
    }
    fn token(self: *Prover, target: *Target, deadline: u64, unix_seconds: i64) ![]const u8 {
        const now = try @import("../agents/scraper/receipts_evm.zig").nowNs();
        if (target.token) |cached| if (now < target.expires_ns) return cached;
        var auth_headers: std.ArrayList(http.Header) = .empty;
        defer auth_headers.deinit(self.allocator);
        var explicit_cookie: ?[]const u8 = null;
        for (target.endpoint.endpoint.headers) |header| {
            if (std.ascii.eqlIgnoreCase(header.name, "cookie")) {
                explicit_cookie = header.value;
                continue;
            }
            if (std.ascii.eqlIgnoreCase(header.name, "content-length") or std.ascii.eqlIgnoreCase(header.name, "transfer-encoding")) continue;
            try auth_headers.append(self.allocator, header);
        }
        const cookies = if (explicit_cookie) |value| try self.allocator.dupe(u8, value) else try self.cookieHeader(target, target.auth_url, unix_seconds);
        defer wipe(self.allocator, cookies);
        if (cookies.len > 0) try auth_headers.append(self.allocator, .{ .name = "cookie", .value = cookies });
        // Source reuses its configured default headers and cookie jar for JWT.
        // An explicit empty body makes both HTTP backends emit Content-Length:0.
        var response = try self.send(.{ .method = .POST, .url = target.auth_url, .headers = auth_headers.items, .body = "", .max_response_bytes = 50 * 1024 }, deadline);
        defer response.deinit();
        self.last_status = response.status;
        if (response.status < 200 or response.status >= 300) return error.AleoProverHttpStatus;
        var auth: ?[]const u8 = null;
        for (response.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "authorization")) {
            if (auth != null) return error.DuplicateAleoProverAuthHeader;
            auth = header.value;
        };
        const value = auth orelse return error.MissingAleoProverAuthHeader;
        if (value.len == 0 or value.len > 8192 or std.mem.indexOfAny(u8, value, "\r\n\x00") != null) return error.InvalidAleoProverAuthHeader;
        const copy = try self.allocator.dupe(u8, value);
        errdefer wipe(self.allocator, copy);
        try self.capture(target, target.auth_url, response.headers, unix_seconds);
        if (target.token) |old| wipe(self.allocator, old);
        target.token = copy;
        target.expires_ns = try std.math.add(u64, now, 15 * 60 * std.time.ns_per_s);
        return copy;
    }
    fn request(self: *Prover, target: *Target, segments: []const []const u8, body: ?[]const u8, deadline: u64, unix_seconds: i64) !http.Response {
        const auth = try self.token(target, deadline, unix_seconds);
        const a = self.allocator;
        const url = try rest.appendUrl(a, target.endpoint.endpoint.url, self.network, segments, &.{});
        defer a.free(url);
        var headers: std.ArrayList(http.Header) = .empty;
        defer headers.deinit(a);
        for (target.endpoint.endpoint.headers) |header| if (!std.ascii.eqlIgnoreCase(header.name, "authorization") and !std.ascii.eqlIgnoreCase(header.name, "cookie") and !std.ascii.eqlIgnoreCase(header.name, "content-type")) {
            try headers.append(a, header);
        };
        try headers.append(a, .{ .name = "authorization", .value = auth });
        if (body != null) try headers.append(a, .{ .name = "content-type", .value = "application/json" });
        var explicit_cookie: ?[]const u8 = null;
        for (target.endpoint.endpoint.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "cookie")) {
            explicit_cookie = header.value;
        };
        const cookies = if (explicit_cookie) |value| try a.dupe(u8, value) else try self.cookieHeader(target, url, unix_seconds);
        defer wipe(a, cookies);
        if (cookies.len > 0) try headers.append(a, .{ .name = "cookie", .value = cookies });
        var response = try self.send(.{ .method = if (body == null) .GET else .POST, .url = url, .headers = headers.items, .body = body, .max_response_bytes = 16 * 1024 * 1024 }, deadline);
        errdefer response.deinit();
        self.last_status = response.status;
        if (response.status == 401) {
            // Serial owner: this is still the exact rejected token.
            if (target.token) |old| wipe(a, old);
            target.token = null;
            target.expires_ns = 0;
        }
        try self.capture(target, url, response.headers, unix_seconds);
        if (response.status < 200 or response.status >= 300) return error.AleoProverHttpStatus;
        return response;
    }
    fn attempt(self: *Prover, target: *Target, authorization: []const u8, deadline: u64, unix_seconds: i64) ![]u8 {
        const a = self.allocator;
        self.last_status = null;
        var public_key = try self.request(target, &.{"pubkey"}, null, deadline, unix_seconds);
        defer public_key.deinit();
        var parsed = try std.json.parseFromSlice(rpc.Value, a, public_key.bytes, .{ .duplicate_field_behavior = .@"error" });
        defer parsed.deinit();
        const key_id = try rpc.string(try rpc.field(parsed.value, "key_id"));
        if (key_id.len == 0 or key_id.len > 1024) return error.InvalidAleoProverKeyId;
        const public_b64 = try rpc.string(try rpc.field(parsed.value, "public_key"));
        if (try std.base64.standard.Decoder.calcSizeForSlice(public_b64) != 32) return error.InvalidAleoProverKey;
        var key: [32]u8 = undefined;
        try std.base64.standard.Decoder.decode(&key, public_b64);
        const sealed = try a.alloc(u8, authorization.len + std.crypto.nacl.SealedBox.seal_length);
        defer wipe(a, sealed);
        try std.crypto.nacl.SealedBox.seal(sealed, authorization, key);
        const b64 = try a.alloc(u8, std.base64.standard.Encoder.calcSize(sealed.len));
        defer wipe(a, b64);
        _ = std.base64.standard.Encoder.encode(b64, sealed);
        const body = try std.json.Stringify.valueAlloc(a, .{ .key_id = key_id, .ciphertext = b64 }, .{});
        defer wipe(a, body);
        var response = try self.request(target, &.{ "prove", "authorization" }, body, deadline, unix_seconds);
        defer response.deinit();
        var proof = try std.json.parseFromSlice(rpc.Value, a, response.bytes, .{ .duplicate_field_behavior = .@"error" });
        defer proof.deinit();
        if (proof.value == .object) if (proof.value.object.get("broadcast")) |broadcast| {
            if (broadcast != .null and (broadcast != .bool or broadcast.bool)) return error.AleoProverBroadcastNotAuthorized;
        };
        return std.json.Stringify.valueAlloc(a, try rpc.field(proof.value, "transaction"), .{});
    }
    /// The total proof budget is at most30 seconds, including fresh key/session
    /// retries. A504/timeout/malformed response never forwards to another prover.
    pub fn prove(self: *Prover, authorization: []const u8, deadline_ns: u64, unix_seconds: i64) ![]u8 {
        if (authorization.len == 0 or authorization.len > 16 * 1024 * 1024) return error.AleoAuthorizationLimit;
        const now = try @import("../agents/scraper/receipts_evm.zig").nowNs();
        const deadline = @min(deadline_ns, try std.math.add(u64, now, 30 * std.time.ns_per_s));
        var errors: usize = 0;
        var last: anyerror = error.NoAleoProver;
        while (errors <= 3) {
            for (self.targets) |*target| {
                const result = self.attempt(target, authorization, deadline, unix_seconds) catch |err| {
                    last = err;
                    errors += 1;
                    if (!retryable(err, self.last_status)) return err;
                    continue;
                };
                return result;
            }
            _ = try common.milliseconds(deadline);
            // Match source backoff between rounds, bounded by the same budget.
            if (errors <= 3) std.Thread.sleep(@as(u64, @min(@as(u32, 100), try common.milliseconds(deadline))) * std.time.ns_per_ms);
        }
        return last;
    }
    fn capture(self: *Prover, target: *Target, url: []const u8, headers: []const http.Header, now: i64) !void {
        for (headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "set-cookie")) try self.setCookie(target, url, header.value, now);
    }
    fn setCookie(self: *Prover, target: *Target, url: []const u8, wire: []const u8, now: i64) !void {
        if (wire.len > 8192) return error.InvalidAleoProverCookie;
        const a = self.allocator;
        const uri = try std.Uri.parse(url);
        var host_buffer: [std.Uri.host_name_max]u8 = undefined;
        const host = try uri.getHost(&host_buffer);
        var parts = std.mem.splitScalar(u8, wire, ';');
        const pair = std.mem.trim(u8, parts.next() orelse return error.InvalidAleoProverCookie, " \t");
        const equal = std.mem.indexOfScalar(u8, pair, '=') orelse return error.InvalidAleoProverCookie;
        const name = pair[0..equal];
        const value = pair[equal + 1 ..];
        if (name.len == 0 or std.mem.indexOfAny(u8, name, "()<>@,;:[]?={} \t\"\r\n\x00") != null or std.mem.indexOfScalar(u8, name, '\\') != null or std.mem.indexOfAny(u8, value, "\r\n\x00\"\\,; \t") != null) return error.InvalidAleoProverCookie;
        for (name) |byte| if (byte <= 0x20 or byte >= 0x7f) return error.InvalidAleoProverCookie;
        for (value) |byte| if (byte <= 0x20 or byte >= 0x7f) return error.InvalidAleoProverCookie;
        var domain: []const u8 = host;
        var path: []const u8 = "/";
        const request_path = uri.path.percent_encoded;
        if (std.mem.lastIndexOfScalar(u8, request_path, '/')) |slash| if (slash > 0) {
            path = request_path[0..slash];
        };
        var host_only = true;
        var secure = false;
        var expires: ?i64 = null;
        var max_age: ?i64 = null;
        while (parts.next()) |part| {
            const attr = std.mem.trim(u8, part, " \t");
            const split = std.mem.indexOfScalar(u8, attr, '=') orelse attr.len;
            const key = attr[0..split];
            const data = if (split < attr.len) attr[split + 1 ..] else "";
            if (std.ascii.eqlIgnoreCase(key, "secure")) secure = true;
            if (std.ascii.eqlIgnoreCase(key, "domain")) {
                domain = std.mem.trimStart(u8, data, ".");
                if (domain.len == 0 or !domainMatch(host, domain)) return error.InvalidAleoProverCookieDomain;
                host_only = false;
            }
            if (std.ascii.eqlIgnoreCase(key, "path") and std.mem.startsWith(u8, data, "/")) path = data;
            if (std.ascii.eqlIgnoreCase(key, "max-age")) max_age = std.fmt.parseInt(i64, data, 10) catch return error.InvalidAleoProverCookie;
            if (std.ascii.eqlIgnoreCase(key, "expires")) expires = try httpDate(data);
        }
        if (max_age) |seconds| expires = if (seconds <= 0) 0 else std.math.add(i64, now, seconds) catch std.math.maxInt(i64);
        var old_index: ?usize = null;
        for (target.cookies.items, 0..) |cookie, i| if (std.mem.eql(u8, cookie.name, name) and std.ascii.eqlIgnoreCase(cookie.domain, domain) and std.mem.eql(u8, cookie.path, path)) {
            old_index = i;
            break;
        };
        if (old_index) |i| freeCookie(a, target.cookies.orderedRemove(i));
        if (expires != null and expires.? <= now) return;
        if (target.cookies.items.len >= 64) return error.AleoProverCookieLimit;
        const owned_name = try a.dupe(u8, name);
        errdefer a.free(owned_name);
        const owned_value = try a.dupe(u8, value);
        errdefer wipe(a, owned_value);
        const owned_domain = try a.dupe(u8, domain);
        errdefer a.free(owned_domain);
        const owned_path = try a.dupe(u8, path);
        errdefer a.free(owned_path);
        try target.cookies.append(a, .{ .name = owned_name, .value = owned_value, .domain = owned_domain, .path = owned_path, .host_only = host_only, .secure = secure, .expires = expires });
    }
    fn cookieHeader(self: *Prover, target: *Target, url: []const u8, now: i64) ![]u8 {
        const uri = try std.Uri.parse(url);
        var host_buffer: [std.Uri.host_name_max]u8 = undefined;
        const host = try uri.getHost(&host_buffer);
        var result: std.ArrayList(u8) = .empty;
        errdefer result.deinit(self.allocator);
        for (target.cookies.items) |cookie| {
            if ((cookie.expires != null and cookie.expires.? <= now) or (cookie.secure and !std.mem.eql(u8, uri.scheme, "https"))) continue;
            if (cookie.host_only) {
                if (!std.ascii.eqlIgnoreCase(host, cookie.domain)) continue;
            } else if (!domainMatch(host, cookie.domain)) continue;
            const path = uri.path.percent_encoded;
            if (!std.mem.startsWith(u8, path, cookie.path) or (path.len > cookie.path.len and !std.mem.endsWith(u8, cookie.path, "/") and path[cookie.path.len] != '/')) continue;
            if (result.items.len > 0) try result.appendSlice(self.allocator, "; ");
            try result.appendSlice(self.allocator, cookie.name);
            try result.append(self.allocator, '=');
            try result.appendSlice(self.allocator, cookie.value);
        }
        return result.toOwnedSlice(self.allocator);
    }
};
fn wipe(a: A, bytes: []u8) void {
    std.crypto.secureZero(u8, bytes);
    a.free(bytes);
}
fn freeCookie(a: A, cookie: Cookie) void {
    a.free(cookie.name);
    wipe(a, cookie.value);
    a.free(cookie.domain);
    a.free(cookie.path);
}
fn domainMatch(host: []const u8, domain: []const u8) bool {
    return std.ascii.eqlIgnoreCase(host, domain) or (host.len > domain.len and host[host.len - domain.len - 1] == '.' and std.ascii.eqlIgnoreCase(host[host.len - domain.len ..], domain));
}
fn validateUrl(url: []const u8) !void {
    const uri = try std.Uri.parse(url);
    if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or (!std.mem.eql(u8, uri.scheme, "https") and !std.mem.eql(u8, uri.scheme, "http"))) return error.InvalidAleoProverUrl;
}
fn retryable(err: anyerror, status: ?u16) bool {
    if (err == error.AleoProverHttpStatus) return status == 500 or status == 502 or status == 503;
    return err == error.CouldNotConnect or err == error.ConnectionRefused or err == error.UnknownHostName or err == error.TemporaryNameServerFailure;
}
fn httpDate(wire: []const u8) !i64 {
    // Strict IMF-fixdate. Unsupported obsolete cookie date syntax fails closed.
    var parts = std.mem.tokenizeAny(u8, wire, " ,:");
    _ = parts.next() orelse return error.InvalidAleoCookieDate;
    const day = try std.fmt.parseInt(u8, parts.next() orelse return error.InvalidAleoCookieDate, 10);
    const month_text = parts.next() orelse return error.InvalidAleoCookieDate;
    var month: u8 = 0;
    for ([_][]const u8{ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" }, 1..) |name, number| if (std.ascii.eqlIgnoreCase(name, month_text)) {
        month = @intCast(number);
    };
    const year = try std.fmt.parseInt(u16, parts.next() orelse return error.InvalidAleoCookieDate, 10);
    const hour = try std.fmt.parseInt(u8, parts.next() orelse return error.InvalidAleoCookieDate, 10);
    const minute = try std.fmt.parseInt(u8, parts.next() orelse return error.InvalidAleoCookieDate, 10);
    const second = try std.fmt.parseInt(u8, parts.next() orelse return error.InvalidAleoCookieDate, 10);
    if (month == 0 or year > 9999 or hour > 23 or minute > 59 or second > 59 or !std.mem.eql(u8, parts.next() orelse "", "GMT") or parts.next() != null) return error.InvalidAleoCookieDate;
    const leap = std.time.epoch.isLeapYear(year);
    const lengths = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day == 0 or day > lengths[month - 1]) return error.InvalidAleoCookieDate;
    if (year < 1970) return 0;
    var days: i64 = 0;
    var y: u16 = 1970;
    while (y < year) : (y += 1) days += if (std.time.epoch.isLeapYear(y)) @as(i64, 366) else 365;
    for (lengths[0 .. month - 1]) |length| days += length;
    days += day - 1;
    return days * 86400 + @as(i64, hour) * 3600 + @as(i64, minute) * 60 + second;
}

const Mock = struct {
    calls: usize = 0,
    proofs: usize = 0,
    terminal: bool = false,
    previous_ciphertext: ?[32]u8 = null,
    fn response(a: A, status: u16, body: []const u8, headers: []const http.Header) !http.Response {
        var owned: std.ArrayList(http.Header) = .empty;
        errdefer {
            for (owned.items) |header| {
                a.free(header.name);
                wipe(a, @constCast(header.value));
            }
            owned.deinit(a);
        }
        for (headers) |header| {
            const name = try a.dupe(u8, header.name);
            errdefer a.free(name);
            const value = try a.dupe(u8, header.value);
            errdefer wipe(a, value);
            try owned.append(a, .{ .name = name, .value = value });
        }
        const bytes = try a.dupe(u8, body);
        errdefer a.free(bytes);
        return .{ .allocator = a, .status = status, .bytes = bytes, .headers = try owned.toOwnedSlice(a) };
    }
    fn transport(self: *Mock) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(ctx: *anyopaque, a: A, request_: http.Request) !http.Response {
        const self: *Mock = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (std.mem.endsWith(u8, request_.url, "/jwt")) {
            try std.testing.expectEqual(std.http.Method.POST, request_.method);
            try std.testing.expectEqualStrings("", request_.body.?);
            return response(a, 200, "", &.{ .{ .name = "Authorization", .value = "Bearer fixture" }, .{ .name = "set-cookie", .value = "auth=session; Secure; Path=/" } });
        }
        const auth = @import("../cloud/testing.zig").header(request_, "authorization") orelse return error.MissingFixtureAuth;
        try std.testing.expectEqualStrings("Bearer fixture", auth);
        const cookie = @import("../cloud/testing.zig").header(request_, "cookie") orelse return error.MissingFixtureCookie;
        try std.testing.expect(std.mem.indexOf(u8, cookie, "auth=session") != null);
        const pair = try std.crypto.nacl.SealedBox.KeyPair.generateDeterministic(.{9} ** 32);
        if (std.mem.endsWith(u8, request_.url, "/pubkey")) {
            var public_key: [44]u8 = undefined;
            _ = std.base64.standard.Encoder.encode(&public_key, &pair.public_key);
            const body = try std.json.Stringify.valueAlloc(a, .{ .key_id = "public-fixture", .public_key = public_key[0..] }, .{});
            defer a.free(body);
            return response(a, 200, body, &.{.{ .name = "set-cookie", .value = "prover=cookie; Secure; Path=/v2/mainnet" }});
        }
        try std.testing.expect(std.mem.endsWith(u8, request_.url, "/prove/authorization"));
        try std.testing.expect(std.mem.indexOf(u8, cookie, "prover=cookie") != null);
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request_.body.?, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("public-fixture", try rpc.string(try rpc.field(parsed.value, "key_id")));
        const b64 = try rpc.string(try rpc.field(parsed.value, "ciphertext"));
        const sealed = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(b64));
        defer wipe(a, sealed);
        try std.base64.standard.Decoder.decode(sealed, b64);
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(sealed, &digest, .{});
        if (self.previous_ciphertext) |old| try std.testing.expect(!std.mem.eql(u8, &old, &digest));
        self.previous_ciphertext = digest;
        const plaintext_bytes = try a.alloc(u8, sealed.len - std.crypto.nacl.SealedBox.seal_length);
        defer wipe(a, plaintext_bytes);
        try std.crypto.nacl.SealedBox.open(plaintext_bytes, sealed, pair);
        try std.testing.expectEqualStrings("source binary authorization with explicit false broadcast bit", plaintext_bytes);
        self.proofs += 1;
        if (self.terminal) return response(a, 504, "", &.{});
        if (self.proofs == 1) return response(a, 503, "", &.{});
        return response(a, 200, "{\"transaction\":{\"fixture\":true},\"broadcast\":false}", &.{});
    }
};
test "Aleo delegated prover refreshes endpoint key seals binary auth and preserves JWT cookie session" {
    const a = std.testing.allocator;
    var mock: Mock = .{};
    const prover = try Prover.init(a, mock.transport(), &.{"https://fixture/v2?custom_rpc_header=x-auth-url:https%3A%2F%2Ffixture%2Fjwt"}, 0);
    defer prover.deinit();
    prover.allow_fixture_transport = true;
    const deadline = try std.math.add(u64, try @import("../agents/scraper/receipts_evm.zig").nowNs(), 10 * std.time.ns_per_s);
    const result = try prover.prove("source binary authorization with explicit false broadcast bit", deadline, 1000);
    defer a.free(result);
    try std.testing.expectEqualStrings("{\"fixture\":true}", result);
    try std.testing.expectEqual(@as(usize, 5), mock.calls);
    try std.testing.expectEqual(@as(usize, 2), mock.proofs);
}
test "Aleo delegated gateway504 never forwards the authorization to another prover" {
    const a = std.testing.allocator;
    var mock: Mock = .{ .terminal = true };
    const prover = try Prover.init(a, mock.transport(), &.{ "https://fixture/v2?custom_rpc_header=x-auth-url:https%3A%2F%2Ffixture%2Fjwt", "https://another/v2?custom_rpc_header=x-auth-url:https%3A%2F%2Fanother%2Fjwt" }, 0);
    defer prover.deinit();
    prover.allow_fixture_transport = true;
    const deadline = try std.math.add(u64, try @import("../agents/scraper/receipts_evm.zig").nowNs(), 10 * std.time.ns_per_s);
    try std.testing.expectError(error.AleoProverHttpStatus, prover.prove("source binary authorization with explicit false broadcast bit", deadline, 1000));
    try std.testing.expectEqual(@as(usize, 3), mock.calls);
}
test "Aleo prover cookie host path expiry and deletion enforce session authority" {
    const a = std.testing.allocator;
    var mock: Mock = .{};
    const prover = try Prover.init(a, mock.transport(), &.{"https://prover.fixture/v2?custom_rpc_header=x-auth-url:https%3A%2F%2Fprover.fixture%2Fjwt"}, 0);
    defer prover.deinit();
    const target = &prover.targets[0];
    try std.testing.expectError(error.InvalidAleoProverCookieDomain, prover.setCookie(target, "https://prover.fixture/v2/pubkey", "cookie=secret; Domain=evil.fixture; Path=/", 1000));
    try prover.setCookie(target, "https://prover.fixture/v2/pubkey", "cookie=value; Path=/v2; Secure; Max-Age=10", 1000);
    const allowed = try prover.cookieHeader(target, "https://prover.fixture/v2/prove", 1001);
    defer wipe(a, allowed);
    try std.testing.expectEqualStrings("cookie=value", allowed);
    for ([_][]const u8{ "http://prover.fixture/v2/prove", "https://prover.fixture/v22/prove", "https://evil.fixture/v2/prove" }) |url| {
        const rejected = try prover.cookieHeader(target, url, 1001);
        defer wipe(a, rejected);
        try std.testing.expectEqual(@as(usize, 0), rejected.len);
    }
    try prover.setCookie(target, "https://prover.fixture/v2/pubkey", "cookie=; Path=/v2; Max-Age=0", 1001);
    try std.testing.expectEqual(@as(usize, 0), target.cookies.items.len);
    try std.testing.expectEqual(@as(i64, 1445412480), try httpDate("Wed, 21 Oct 2015 07:28:00 GMT"));
    try std.testing.expectError(error.InvalidAleoCookieDate, httpDate("Wed, 31 Feb 2015 07:28:00 GMT"));
}
