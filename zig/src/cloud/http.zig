//! Injected HTTP boundary: no credential discovery and no request/error logging.
const std = @import("std");
const Allocator = std.mem.Allocator;
const curl = @import("../net/curl.zig");
pub const Header = std.http.Header;
pub const Request = struct {
    method: std.http.Method,
    url: []const u8,
    headers: []const Header = &.{},
    body: ?[]const u8 = null,
    max_response_bytes: usize = 50 * 1024,
    /// Only modern ADC's explicit AWS credential_source without an IMDSv2 URL
    /// may opt into Source IMDSv1 at the same narrow metadata paths.
    metadata_imdsv1: bool = false,
};
pub const Response = struct {
    allocator: Allocator,
    bytes: []u8,
    status: u16,
    metadata_flavor_google: bool = false,
    /// Owned response auth/session headers, never logged.
    headers: []const Header = &.{},
    pub fn deinit(self: *Response) void {
        for (self.headers) |header| {
            self.allocator.free(header.name);
            std.crypto.secureZero(u8, @constCast(header.value));
            self.allocator.free(header.value);
        }
        if (self.headers.len != 0) self.allocator.free(self.headers);
        std.crypto.secureZero(u8, self.bytes);
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};
pub const Transport = struct {
    context: *anyopaque,
    send_fn: *const fn (*anyopaque, Allocator, Request) anyerror!Response,
    pub fn send(self: Transport, allocator: Allocator, request: Request) !Response {
        var response = try self.send_fn(self.context, allocator, request);
        errdefer response.deinit();
        if (response.bytes.len >= request.max_response_bytes) return error.CloudResponseTooLarge;
        return response;
    }
};

const Sink = struct {
    writer: std.Io.Writer,
    exceeded: bool = false,
    fn drain(writer: *std.Io.Writer, _: []const []const u8, _: usize) std.Io.Writer.Error!usize {
        const self: *Sink = @fieldParentPtr("writer", writer);
        self.exceeded = true;
        return error.WriteFailed;
    }
};

/// Explicit absolute caller authority. Only known RPC reads opt into physical
/// timeout retry; auth/signing/proving preserve the same deadline without it.
pub const RpcReadOwner = struct {
    deadline_ns: u64,
    halt: ?*const std.atomic.Value(bool) = null,
    retry_physical_timeout: bool = false,
    pub fn remaining(self: RpcReadOwner, cancel: ?*const std.atomic.Value(bool)) !u64 {
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (self.halt) |flag| if (flag.load(.acquire)) return error.CheckpointEffectsHalted;
        const now = try rpcNowNs();
        if (now >= self.deadline_ns) return error.RequestDeadlineExceeded;
        return self.deadline_ns - now;
    }
};
/// Same monotonic Instant domain as operational Clock.deadline_ns.
pub fn rpcNowNs() !u64 {
    const instant = try std.time.Instant.now();
    return std.math.add(u64, try std.math.mul(u64, std.math.cast(u64, instant.timestamp.sec) orelse return error.UnsupportedClock, std.time.ns_per_s), @intCast(instant.timestamp.nsec));
}

pub const HttpTransport = struct {
    /// Diagnostic for the last send only; never changes transport error types.
    /// Set only by a completed native timeout strictly inside a live owner.
    last_native_physical_timeout: bool = false,
    client: std.http.Client,
    /// Caller loads and owns this explicit optional native dependency.
    native_curl: ?*curl.Client = null,
    timeout_ms: u32 = 30000,
    connect_timeout_ms: u32 = 10000,
    cancel: ?*const std.atomic.Value(bool) = null,
    rpc_read_owner: ?RpcReadOwner = null,
    /// Enables only literal loopback hosts for disposable HTTP test servers.
    allow_insecure_loopback: bool = false,
    /// Explicit opt-in for the standard link-local/cloud metadata hosts only.
    allow_metadata_http: bool = false,

    pub fn init(allocator: Allocator) HttpTransport {
        return .{ .client = .{ .allocator = allocator } };
    }
    pub fn deinit(self: *HttpTransport) void {
        self.client.deinit();
        self.* = undefined;
    }
    pub fn interface(self: *HttpTransport) Transport {
        return .{ .context = self, .send_fn = send };
    }
    /// Explicitly configured chain RPCs accept HTTP like the Rust providers.
    /// This distinct per-call capability never changes the owner's strict
    /// credential/storage interface or its metadata-only HTTP allowlist.
    pub fn configuredRpcInterface(self: *HttpTransport) Transport {
        return .{ .context = self, .send_fn = sendConfiguredRpc };
    }
    fn send(context: *anyopaque, allocator: Allocator, request: Request) !Response {
        const self: *HttpTransport = @ptrCast(@alignCast(context));
        return self.sendWithPolicy(allocator, request, false);
    }
    fn sendConfiguredRpc(context: *anyopaque, allocator: Allocator, request: Request) !Response {
        const self: *HttpTransport = @ptrCast(@alignCast(context));
        return self.sendWithPolicy(allocator, request, true);
    }
    fn sendWithPolicy(self: *HttpTransport, allocator: Allocator, request: Request, configured_rpc: bool) !Response {
        self.last_native_physical_timeout = false;
        const uri = try std.Uri.parse(request.url);
        if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null) return error.InvalidCloudUrl;
        if (!std.mem.eql(u8, uri.scheme, "https")) {
            var host_buffer: [std.Uri.host_name_max]u8 = undefined;
            const host = try uri.getHost(&host_buffer);
            const loopback = self.allow_insecure_loopback and (std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "::1"));
            const metadata = self.allow_metadata_http and metadataRequestAllowed(uri, host, request);
            if (!std.mem.eql(u8, uri.scheme, "http") or (!configured_rpc and !loopback and !metadata)) return error.InsecureCloudUrl;
        }
        for (request.headers) |header| {
            if (header.name.len == 0 or std.mem.indexOfAny(u8, header.name, ":\r\n") != null or std.mem.indexOfAny(u8, header.value, "\r\n") != null) return error.InvalidCloudHeader;
            if (std.ascii.eqlIgnoreCase(header.name, "content-length") or std.ascii.eqlIgnoreCase(header.name, "transfer-encoding")) return error.InvalidCloudHeader;
        }
        if (request.max_response_bytes < 2) return error.InvalidResponseLimit;
        if (self.native_curl) |native| {
            const headers = try allocator.alloc(curl.Header, request.headers.len);
            defer allocator.free(headers);
            for (request.headers, headers) |source, *dest| dest.* = .{ .name = source.name, .value = source.value };
            const method: curl.Method = switch (request.method) {
                .GET => .get,
                .POST => .post,
                .PUT => .put,
                .HEAD => .head,
                .DELETE => .delete,
                else => return error.UnsupportedCloudMethod,
            };
            const remaining_ns = if (self.rpc_read_owner) |owner| try owner.remaining(self.cancel) else null;
            const owner_limited = if (remaining_ns) |remaining| @as(u64, self.timeout_ms) * std.time.ns_per_ms >= remaining else true;
            const timeout_ms = if (remaining_ns) |remaining| @min(self.timeout_ms, @as(u32, @intCast(@min(std.math.maxInt(u32), (remaining +| (std.time.ns_per_ms - 1)) / std.time.ns_per_ms)))) else self.timeout_ms;
            var response = native.send(allocator, .{ .url = request.url, .method = method, .headers = headers, .body = request.body, .timeout_ms = timeout_ms, .connect_timeout_ms = @min(timeout_ms, self.connect_timeout_ms), .max_response_bytes = request.max_response_bytes - 1, .cancel = self.cancel }) catch |err| {
                if (err == error.ResponseTooLarge) return error.CloudResponseTooLarge;
                if (err == error.RequestDeadlineExceeded and native.send_override == null) if (self.rpc_read_owner) |owner| {
                    // Check genuine controls even when a completed physical
                    // timeout races the owner's cancellation/deadline.
                    _ = try owner.remaining(self.cancel);
                    self.last_native_physical_timeout = !owner_limited;
                    if (owner.retry_physical_timeout and !owner_limited) return error.UpstreamReadTimeout;
                };
                return err;
            };
            defer response.deinit();
            if (self.rpc_read_owner) |owner| _ = try owner.remaining(self.cancel);
            var count: usize = 0;
            var valid = false;
            for (response.headers) |header| {
                if (std.ascii.eqlIgnoreCase(header.name, "metadata-flavor")) {
                    count += 1;
                    valid = std.mem.eql(u8, header.value, "Google");
                }
            }
            var owned_headers: std.ArrayList(Header) = .empty;
            errdefer freeHeaders(allocator, &owned_headers);
            for (response.headers) |header| try captureHeader(allocator, &owned_headers, header.name, header.value);
            const captured = try owned_headers.toOwnedSlice(allocator);
            const body = response.takeBody();
            return .{ .allocator = allocator, .bytes = body, .status = response.status, .metadata_flavor_google = count == 1 and valid, .headers = captured };
        }
        const bytes = try allocator.alloc(u8, request.max_response_bytes - 1);
        defer allocator.free(bytes);
        var sink: Sink = .{ .writer = .{ .buffer = bytes, .vtable = &.{ .drain = Sink.drain } } };
        // std.Client may otherwise drain an incomplete GET body in Request.deinit
        // to reuse its connection. Closing prevents a rejected oversized body
        // from being drained past the bound by that cleanup path.
        var outbound = try self.client.request(request.method, uri, .{ .keep_alive = false, .headers = .{
            .host = if (hasHeader(request.headers, "host")) .omit else .default,
            .authorization = .omit,
            .content_type = .omit,
            .user_agent = .omit,
            .connection = .omit,
            .accept_encoding = if (hasHeader(request.headers, "accept-encoding")) .omit else .{ .override = "identity" },
        }, .extra_headers = request.headers, .redirect_behavior = .unhandled });
        defer outbound.deinit();
        if (request.body) |body| {
            outbound.transfer_encoding = .{ .content_length = body.len };
            var upload = try outbound.sendBodyUnflushed(&.{});
            try upload.writer.writeAll(body);
            try upload.end();
            try outbound.connection.?.flush();
        } else try outbound.sendBodiless();
        var response = try outbound.receiveHead(&.{});
        if (response.head.content_encoding != .identity) return error.UnsupportedCloudContentEncoding;
        var metadata_flavor_count: usize = 0;
        var metadata_flavor_google = false;
        var owned_headers: std.ArrayList(Header) = .empty;
        errdefer freeHeaders(allocator, &owned_headers);
        var headers = response.head.iterateHeaders();
        while (headers.next()) |header| {
            try captureHeader(allocator, &owned_headers, header.name, header.value);
            if (std.ascii.eqlIgnoreCase(header.name, "metadata-flavor")) {
                metadata_flavor_count += 1;
                metadata_flavor_google = std.mem.eql(u8, header.value, "Google");
            }
        }
        var transfer_buffer: [64]u8 = undefined;
        _ = response.reader(&transfer_buffer).streamRemaining(&sink.writer) catch |err| {
            if (sink.exceeded) return error.CloudResponseTooLarge;
            return err;
        };
        const body = try allocator.dupe(u8, sink.writer.buffered());
        errdefer allocator.free(body);
        return .{ .allocator = allocator, .bytes = body, .status = @intFromEnum(response.head.status), .metadata_flavor_google = metadata_flavor_count == 1 and metadata_flavor_google, .headers = try owned_headers.toOwnedSlice(allocator) };
    }
};

fn captureHeader(a: Allocator, headers: *std.ArrayList(Header), name: []const u8, value: []const u8) !void {
    if (!std.ascii.eqlIgnoreCase(name, "authorization") and !std.ascii.eqlIgnoreCase(name, "set-cookie")) return;
    if (headers.items.len >= 64 or name.len > 128 or value.len > 8192 or std.mem.indexOfAny(u8, value, "\r\n") != null) return error.InvalidCloudResponseHeader;
    const owned_name = try a.dupe(u8, name);
    errdefer a.free(owned_name);
    const owned_value = try a.dupe(u8, value);
    errdefer {
        std.crypto.secureZero(u8, owned_value);
        a.free(owned_value);
    }
    try headers.append(a, .{ .name = owned_name, .value = owned_value });
}
fn freeHeaders(a: Allocator, headers: *std.ArrayList(Header)) void {
    for (headers.items) |header| {
        a.free(header.name);
        std.crypto.secureZero(u8, @constCast(header.value));
        a.free(header.value);
    }
    headers.deinit(a);
}

/// Cleartext metadata is an explicit separate capability, restricted to the
/// implemented identity flows. No redirects or ambient DNS endpoint discovery.
fn metadataRequestAllowed(uri: std.Uri, host: []const u8, request: Request) bool {
    if (uri.port != null and uri.port.? != 80) return false;
    const path = switch (uri.path) {
        .percent_encoded => |p| p,
        .raw => |p| p,
    };
    if (std.mem.indexOfAny(u8, path, "%\\") != null or std.mem.indexOf(u8, path, "..") != null or request.body != null) return false;
    if (std.mem.eql(u8, host, "metadata.google.internal") or std.mem.eql(u8, host, "169.254.169.254")) {
        if (request.method == .GET and (std.mem.eql(u8, path, "/computeMetadata/v1/project/project-id") or
            std.mem.eql(u8, path, "/computeMetadata/v1/instance/service-accounts/default/scopes") or
            std.mem.eql(u8, path, "/computeMetadata/v1/instance/service-accounts/default/token") or
            std.mem.eql(u8, path, "/computeMetadata/v1/instance/service-accounts/default/identity")))
        {
            return exactlyHeader(request.headers, "metadata-flavor", "Google");
        }
    }
    // Azure Workload Identity Federation URL sources use this literal link-local
    // endpoint and mandatory Metadata header. It has no general HTTP authority.
    if (std.mem.eql(u8, host, "169.254.169.254") and request.method == .GET and std.mem.eql(u8, path, "/metadata/identity/oauth2/token")) return exactlyHeader(request.headers, "Metadata", "True");
    if (uri.query != null) return false;
    if (std.mem.eql(u8, host, "169.254.169.254")) {
        if (request.method == .PUT and std.mem.eql(u8, path, "/latest/api/token")) {
            const ttl = uniqueHeader(request.headers, "x-aws-ec2-metadata-token-ttl-seconds") orelse return false;
            const seconds = std.fmt.parseInt(u32, ttl, 10) catch return false;
            return seconds >= 1 and seconds <= 21600;
        }
        if (request.method == .GET and (std.mem.startsWith(u8, path, "/latest/meta-data/iam/security-credentials/") or std.mem.eql(u8, path, "/latest/meta-data/iam/security-credentials") or std.mem.eql(u8, path, "/latest/meta-data/placement/availability-zone"))) {
            const token = uniqueHeader(request.headers, "x-aws-ec2-metadata-token") orelse return request.metadata_imdsv1;
            return token.len > 0;
        }
    }
    if (std.mem.eql(u8, host, "169.254.170.2") or std.mem.eql(u8, host, "169.254.170.23")) {
        return request.method == .GET and (std.mem.startsWith(u8, path, "/v2/credentials/") or std.mem.startsWith(u8, path, "/v1/credentials/"));
    }
    return false;
}
fn uniqueHeader(headers: []const Header, name: []const u8) ?[]const u8 {
    var found: ?[]const u8 = null;
    for (headers) |header| if (std.ascii.eqlIgnoreCase(header.name, name)) {
        if (found != null) return null;
        found = header.value;
    };
    return found;
}
fn exactlyHeader(headers: []const Header, name: []const u8, value: []const u8) bool {
    return std.mem.eql(u8, uniqueHeader(headers, name) orelse return false, value);
}

test "metadata cleartext policy allows only implemented hosts methods paths and required headers" {
    const cases = [_]struct { url: []const u8, method: std.http.Method = .GET, headers: []const Header = &.{}, allowed: bool = false }{
        .{ .url = "http://169.254.169.254/latest/api/token", .method = .PUT, .headers = &.{.{ .name = "x-aws-ec2-metadata-token-ttl-seconds", .value = "21600" }}, .allowed = true },
        .{ .url = "http://169.254.169.254/latest/meta-data/iam/security-credentials/role", .headers = &.{.{ .name = "x-aws-ec2-metadata-token", .value = "fixture" }}, .allowed = true },
        .{ .url = "http://169.254.170.2/v2/credentials/fixture", .allowed = true },
        .{ .url = "http://169.254.170.23/v1/credentials/fixture", .allowed = true },
        .{ .url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=fixture", .headers = &.{.{ .name = "Metadata-Flavor", .value = "Google" }}, .allowed = true },
        .{ .url = "http://169.254.169.254/computeMetadata/v1/project/project-id", .headers = &.{.{ .name = "Metadata-Flavor", .value = "Google" }}, .allowed = true },
        .{ .url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" },
        .{ .url = "http://169.254.169.254/latest/api/token", .method = .PUT },
        .{ .url = "http://169.254.169.254/latest/meta-data/iam/security-credentials/role" },
        .{ .url = "http://169.254.169.254/latest/user-data" },
        .{ .url = "http://169.254.170.2/v2/credentials/../other" },
        .{ .url = "http://169.254.170.2/v2/credentials/%2e%2e/other" },
        .{ .url = "http://169.254.170.2:8080/v2/credentials/fixture" },
        .{ .url = "http://169.254.170.3/v2/credentials/fixture" },
        .{ .url = "http://metadata.google.internal.evil/computeMetadata/v1/project/project-id", .headers = &.{.{ .name = "Metadata-Flavor", .value = "Google" }} },
    };
    for (cases) |case| {
        const uri = try std.Uri.parse(case.url);
        var buffer: [std.Uri.host_name_max]u8 = undefined;
        try std.testing.expectEqual(case.allowed, metadataRequestAllowed(uri, try uri.getHost(&buffer), .{ .url = case.url, .method = case.method, .headers = case.headers }));
    }
    var transport = HttpTransport.init(std.testing.allocator);
    defer transport.deinit();
    transport.allow_metadata_http = true;
    try std.testing.expectError(error.InsecureCloudUrl, transport.interface().send(std.testing.allocator, .{ .method = .GET, .url = "http://169.254.169.254/latest/user-data" }));
}

fn hasHeader(headers: []const Header, name: []const u8) bool {
    for (headers) |header| if (std.ascii.eqlIgnoreCase(header.name, name)) return true;
    return false;
}

pub fn isSuccess(status: u16) bool {
    return status >= 200 and status < 300;
}

pub fn percentEncode(allocator: Allocator, bytes: []const u8, preserve_slash: bool) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    const digits = "0123456789ABCDEF";
    for (bytes) |byte| {
        if (std.ascii.isAlphanumeric(byte) or std.mem.indexOfScalar(u8, "-_.~", byte) != null or (preserve_slash and byte == '/')) {
            try out.append(allocator, byte);
        } else try out.appendSlice(allocator, &.{ '%', digits[byte >> 4], digits[byte & 15] });
    }
    return out.toOwnedSlice(allocator);
}

test "percent encoding distinguishes path slashes and literal percent signs" {
    const encoded = try percentEncode(std.testing.allocator, "a/b %λ", false);
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings("a%2Fb%20%25%CE%BB", encoded);
    const path = try percentEncode(std.testing.allocator, "/a//../b", true);
    defer std.testing.allocator.free(path);
    try std.testing.expectEqualStrings("/a//../b", path);
}

test "transport rejects credentials in URLs header injection and cleartext before connecting" {
    var transport = HttpTransport.init(std.testing.allocator);
    defer transport.deinit();
    try std.testing.expectError(error.InsecureCloudUrl, transport.interface().send(std.testing.allocator, .{ .method = .GET, .url = "http://example.invalid/" }));
    try std.testing.expectError(error.InvalidCloudUrl, transport.interface().send(std.testing.allocator, .{ .method = .GET, .url = "https://user:password@example.invalid/" }));
    try std.testing.expectError(error.InvalidCloudHeader, transport.interface().send(std.testing.allocator, .{ .method = .GET, .url = "https://example.invalid/", .headers = &.{.{ .name = "authorization", .value = "Bearer\r\nother: bad" }} }));
}

const Loopback = struct {
    server: std.net.Server,
    status: u16,
    body: []const u8,
    failure: ?anyerror = null,
    delay_ms: u64 = 0,
    path: []const u8 = "/",
    fn serve(self: *Loopback) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *Loopback) !void {
        const connection = try self.server.accept();
        defer connection.stream.close();
        var bytes: [8192]u8 = undefined;
        var used: usize = 0;
        while (true) {
            if (used == bytes.len) return error.LoopbackRequestTooLarge;
            const n = try connection.stream.read(bytes[used..]);
            if (n == 0) return error.LoopbackUnexpectedEof;
            used += n;
            if (std.mem.indexOf(u8, bytes[0..used], "\r\n\r\n")) |end| {
                var headers = std.mem.splitSequence(u8, bytes[0..end], "\r\n");
                var request_line: [1024]u8 = undefined;
                const expected = try std.fmt.bufPrint(&request_line, "POST {s} HTTP/1.1", .{self.path});
                if (!std.mem.eql(u8, headers.next().?, expected)) return error.LoopbackRequestPathMismatch;
                var hosts: usize = 0;
                var length: usize = 0;
                while (headers.next()) |line| {
                    const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.LoopbackMalformedHeader;
                    if (std.ascii.eqlIgnoreCase(line[0..colon], "host")) hosts += 1;
                    if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) length = try std.fmt.parseInt(usize, std.mem.trim(u8, line[colon + 1 ..], " "), 10);
                }
                if (used < end + 4 + length) continue;
                if (hosts != 1) return error.LoopbackDuplicateHost;
                if (!std.mem.eql(u8, bytes[end + 4 ..][0..length], "{}")) return error.LoopbackBodyMismatch;
                break;
            }
        }
        if (self.delay_ms != 0) std.Thread.sleep(self.delay_ms * std.time.ns_per_ms);
        var header_buffer: [512]u8 = undefined;
        const header = try std.fmt.bufPrint(&header_buffer, "HTTP/1.1 {d} Fixture\r\nContent-Length: {d}\r\nMetadata-Flavor: Google\r\nAuthorization: Bearer fixture-response\r\nSet-Cookie: session=fixture; Path=/; HttpOnly\r\nLocation: https://example.invalid/\r\nConnection: close\r\n\r\n", .{ self.status, self.body.len });
        try connection.stream.writeAll(header);
        try connection.stream.writeAll(self.body);
    }
};
fn loopbackSend(status: u16, body: []const u8, limit: usize) !u16 {
    return loopbackSendNative(status, body, limit, null, 0);
}
fn loopbackSendNative(status: u16, body: []const u8, limit: usize, native: ?*curl.Client, delay_ms: u64) !u16 {
    return loopbackSendPath(status, body, limit, native, delay_ms, "/");
}
fn loopbackSendPath(status: u16, body: []const u8, limit: usize, native: ?*curl.Client, delay_ms: u64, path: []const u8) !u16 {
    var server: Loopback = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .status = status, .body = body, .delay_ms = delay_ms, .path = path };
    defer server.server.deinit();
    const allocator = std.testing.allocator;
    const port = server.server.listen_address.getPort();
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}{s}", .{ port, path });
    defer allocator.free(url);
    const host = try std.fmt.allocPrint(allocator, "127.0.0.1:{d}", .{port});
    defer allocator.free(host);
    var transport = HttpTransport.init(allocator);
    transport.allow_insecure_loopback = true;
    transport.native_curl = native;
    transport.timeout_ms = 50;
    transport.connect_timeout_ms = 50;
    defer transport.deinit();
    const thread = try std.Thread.spawn(.{}, Loopback.serve, .{&server});
    const response = transport.interface().send(allocator, .{ .method = .POST, .url = url, .body = "{}", .headers = &.{ .{ .name = "host", .value = host }, .{ .name = "authorization", .value = "Bearer fixture" } }, .max_response_bytes = limit });
    thread.join();
    var value = try response;
    defer value.deinit();
    if (server.failure) |err| return err;
    try std.testing.expect(value.metadata_flavor_google);
    try std.testing.expectEqual(@as(usize, 2), value.headers.len);
    try std.testing.expectEqualStrings("Bearer fixture-response", value.headers[0].value);
    try std.testing.expectEqualStrings("session=fixture; Path=/; HttpOnly", value.headers[1].value);
    return value.status;
}

test "real HTTP loopback enforces exclusive byte cap no redirect and one signed host" {
    try std.testing.expectEqual(@as(u16, 200), try loopbackSend(200, "ok", 3));
    try std.testing.expectError(error.CloudResponseTooLarge, loopbackSend(200, "ok", 2));
    try std.testing.expectEqual(@as(u16, 302), try loopbackSend(302, "", 2));
}

test "opt-in native cloud transport enforces deadline cancellation byte cap and no redirect" {
    const allocator = std.testing.allocator;
    const path = std.process.getEnvVarOwned(allocator, "HYPERLANE_CLOUD_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(path);
    var native = try curl.Client.init(allocator, path);
    defer native.deinit();
    try std.testing.expectEqual(@as(u16, 200), try loopbackSendNative(200, "ok", 3, &native, 0));
    // SigV4 covers this exact S3 object path. Curl must not remove dot segments
    // or collapse repeated slashes before sending the signed request.
    try std.testing.expectEqual(@as(u16, 200), try loopbackSendPath(200, "ok", 3, &native, 0, "/a/../b//c"));
    try std.testing.expectError(error.CloudResponseTooLarge, loopbackSendNative(200, "ok", 2, &native, 0));
    try std.testing.expectEqual(@as(u16, 302), try loopbackSendNative(302, "", 2, &native, 0));
    try std.testing.expectError(error.RequestDeadlineExceeded, loopbackSendNative(200, "ok", 3, &native, 100));
    var cancelled = std.atomic.Value(bool).init(true);
    var transport = HttpTransport.init(allocator);
    defer transport.deinit();
    transport.native_curl = &native;
    transport.cancel = &cancelled;
    transport.allow_insecure_loopback = true;
    try std.testing.expectError(error.RequestCancelled, transport.interface().send(allocator, .{ .method = .GET, .url = "http://127.0.0.1:1/" }));
}

test "ADC AWS metadata IMDSv1 is explicit per request and never widens host path or token defaults" {
    const uri = try std.Uri.parse("http://169.254.169.254/latest/meta-data/placement/availability-zone");
    var request: Request = .{ .method = .GET, .url = "http://169.254.169.254/latest/meta-data/placement/availability-zone" };
    try std.testing.expect(!metadataRequestAllowed(uri, "169.254.169.254", request));
    request.metadata_imdsv1 = true;
    try std.testing.expect(metadataRequestAllowed(uri, "169.254.169.254", request));
    try std.testing.expect(!metadataRequestAllowed(uri, "example.invalid", request));
    const forbidden = try std.Uri.parse("http://169.254.169.254/latest/user-data");
    try std.testing.expect(!metadataRequestAllowed(forbidden, "169.254.169.254", request));
    const azure = try std.Uri.parse("http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=public");
    try std.testing.expect(!metadataRequestAllowed(azure, "169.254.169.254", request));
    request.headers = &.{.{ .name = "Metadata", .value = "True" }};
    try std.testing.expect(metadataRequestAllowed(azure, "169.254.169.254", request));
    request.headers = &.{};
    const identity_uri = try std.Uri.parse("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=public");
    request.metadata_imdsv1 = false;
    try std.testing.expect(!metadataRequestAllowed(identity_uri, "metadata.google.internal", request));
    request.headers = &.{.{ .name = "Metadata-Flavor", .value = "Google" }};
    try std.testing.expect(metadataRequestAllowed(identity_uri, "metadata.google.internal", request));
}
