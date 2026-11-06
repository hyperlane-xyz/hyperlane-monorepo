//! Optional native HTTP transport. libcurl owns HTTP/2, TLS and DNS; requests
//! have connect/total deadlines, cancellation, bounded headers/body, and no
//! redirects. Load a vetted library explicitly before starting worker threads.
const std = @import("std");
const public_address = @import("../relayer/public_address.zig");
pub const Header = struct { name: []const u8, value: []const u8 };
pub const Method = enum { get, post, put, head, delete };
pub const Request = struct {
    url: []const u8,
    method: Method,
    headers: []const Header = &.{},
    body: ?[]const u8 = null,
    timeout_ms: u32 = 30000,
    connect_timeout_ms: u32 = 30000,
    max_response_bytes: usize = 8 * 1024 * 1024,
    require_http2: bool = false,
    /// Ethereum JSON-RPC rejects rate limits after the complete response head,
    /// before reading a possibly stalled/unbounded body. Other callers keep off.
    stop_after_http429_head: bool = false,
    /// Untrusted CCIP URLs: bypass proxies and validate the actual destination
    /// sockaddr before opening a socket. Trusted RPC/cloud callers leave false.
    public_only: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
};

fn headerToken(char: u8) bool {
    return std.ascii.isAlphanumeric(char) or std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", char) != null;
}
pub fn validateRequest(request: Request) !void {
    for (request.url) |char| if (char <= 32 or char == 127) return error.InvalidHttpUrl;
    const uri = try std.Uri.parse(request.url);
    if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or (!std.mem.eql(u8, uri.scheme, "http") and !std.mem.eql(u8, uri.scheme, "https"))) return error.InvalidHttpUrl;
    if (request.public_only) {
        var buffer: [1024]u8 = undefined;
        const host = try uri.host.?.toRaw(&buffer);
        const unbracketed = if (host.len >= 2 and host[0] == '[' and host[host.len - 1] == ']') host[1 .. host.len - 1] else host;
        const address = std.net.Address.parseIp(unbracketed, 0) catch null;
        if (address) |literal| if (!public_address.isPublic(literal)) return error.NonPublicDestination;
    }
    if (request.timeout_ms == 0 or request.connect_timeout_ms == 0 or request.max_response_bytes == 0) return error.InvalidHttpLimit;
    if (request.method == .head and request.body != null) return error.InvalidHttpRequest;
    var encoding_count: usize = 0;
    for (request.headers) |header| {
        if (header.name.len == 0) return error.InvalidHttpHeader;
        for (header.name) |char| if (!headerToken(char)) return error.InvalidHttpHeader;
        for (header.value) |char| if ((char < 32 and char != '\t') or char == 127) return error.InvalidHttpHeader;
        if (std.ascii.eqlIgnoreCase(header.name, "content-length") or std.ascii.eqlIgnoreCase(header.name, "transfer-encoding")) return error.InvalidHttpHeader;
        if (std.ascii.eqlIgnoreCase(header.name, "accept-encoding")) {
            encoding_count += 1;
            if (encoding_count > 1) return error.InvalidHttpHeader;
            if (!std.ascii.eqlIgnoreCase(std.mem.trim(u8, header.value, " \t"), "identity")) return error.UnsupportedContentEncoding;
        }
    }
}
pub const Response = struct {
    allocator: std.mem.Allocator,
    status: u16,
    http_version: c_long,
    body: []u8,
    headers: []const Header,
    header_storage: []u8,
    /// Move the exact owned payload into another same-allocator response layer.
    /// Header ownership remains with this response until deinit.
    pub fn takeBody(self: *Response) []u8 {
        const body = self.body;
        self.body = &.{};
        return body;
    }
    pub fn deinit(self: *Response) void {
        self.allocator.free(self.body);
        self.allocator.free(self.headers);
        self.allocator.free(self.header_storage);
        self.* = undefined;
    }
};
pub const Handle = anyopaque;
const Slist = extern struct { data: [*:0]u8, next: ?*Slist };
// Prefix of curl_version_info_data for CURLVERSION_FIRST (curl.h); requesting
// age zero never relies on fields introduced by later libcurl releases.
const VersionInfo = extern struct { age: c_int, version: [*:0]const u8, version_num: c_uint, host: [*:0]const u8, features: c_int };
const CurlSockaddr = extern struct { family: c_int, socktype: c_int, protocol: c_int, addrlen: c_uint, addr: std.posix.sockaddr };
const Api = struct {
    version_info: *const fn (c_int) callconv(.c) ?*const VersionInfo,
    global_init: *const fn (c_long) callconv(.c) c_int,
    easy_init: *const fn () callconv(.c) ?*Handle,
    easy_cleanup: *const fn (*Handle) callconv(.c) void,
    easy_reset: *const fn (*Handle) callconv(.c) void,
    easy_setopt: *const fn (*Handle, c_int, ...) callconv(.c) c_int,
    easy_perform: *const fn (*Handle) callconv(.c) c_int,
    easy_getinfo: *const fn (*Handle, c_int, ...) callconv(.c) c_int,
    slist_append: *const fn (?*Slist, [*:0]const u8) callconv(.c) ?*Slist,
    slist_free_all: *const fn (?*Slist) callconv(.c) void,
    fn load(library: *std.DynLib) !Api {
        var api: Api = undefined;
        inline for (std.meta.fields(Api)) |field|
            @field(api, field.name) = library.lookup(field.type, "curl_" ++ field.name) orelse return error.MissingLibcurlSymbol;
        return api;
    }
};
const Sink = struct {
    body: []u8 = &.{},
    /// Null allocator is used only for fixed-buffer callback fixtures.
    allocator: ?std.mem.Allocator = null,
    limit: usize = 0,
    used: usize = 0,
    too_large: bool = false,
    out_of_memory: bool = false,
    header_storage: [32768]u8 = undefined,
    header_used: usize = 0,
    header_total: usize = 0,
    header_too_large: bool = false,
    cancel: ?*const std.atomic.Value(bool),
    non_public_destination: bool = false,
    stop_after_http429_head: bool = false,
    response_status: ?u16 = null,
    http429_head_aborted: bool = false,

    fn openSocket(context: ?*anyopaque, purpose: c_int, target: *const CurlSockaddr) callconv(.c) c_int {
        const self: *Sink = @ptrCast(@alignCast(context orelse return -1));
        const valid_family = (target.family == std.posix.AF.INET and target.addrlen >= @sizeOf(std.posix.sockaddr.in)) or
            (target.family == std.posix.AF.INET6 and target.addrlen >= @sizeOf(std.posix.sockaddr.in6));
        if (purpose != 0 or !valid_family or target.addr.family != target.family or target.socktype != std.posix.SOCK.STREAM or target.protocol < 0) {
            self.non_public_destination = true;
            return -1;
        }
        const address = std.net.Address.initPosix(@alignCast(&target.addr));
        if (!public_address.isPublic(address)) {
            self.non_public_destination = true;
            return -1;
        }
        return std.posix.socket(@intCast(target.family), @intCast(target.socktype), @intCast(target.protocol)) catch -1;
    }
    fn write(pointer: [*]const u8, size: usize, count: usize, context: ?*anyopaque) callconv(.c) usize {
        const self: *Sink = @ptrCast(@alignCast(context orelse return 0));
        const length = std.math.mul(usize, size, count) catch {
            self.too_large = true;
            return 0;
        };
        const limit = if (self.allocator != null) self.limit else self.body.len;
        if (length > limit - self.used) {
            self.too_large = true;
            return 0;
        }
        const required = self.used + length;
        if (required > self.body.len) {
            const allocator = self.allocator orelse unreachable;
            const capacity = @max(required, @min(limit, @max(@as(usize, 4096), self.body.len *| 2)));
            self.body = allocator.realloc(self.body, capacity) catch {
                self.out_of_memory = true;
                return 0;
            };
        }
        @memcpy(self.body[self.used..][0..length], pointer[0..length]);
        self.used = required;
        return length;
    }
    fn takeBody(self: *Sink) ![]u8 {
        const allocator = self.allocator orelse return error.FixedBufferSink;
        // resize may shrink in place; fallback realloc peaks remain <=2*limit,
        // already covered by Multi's unchanged worst-case byte reservation.
        const body = try allocator.realloc(self.body, self.used);
        self.body = &.{};
        self.used = 0;
        return body;
    }
    fn deinit(self: *Sink) void {
        if (self.allocator) |allocator| allocator.free(self.body);
        self.body = &.{};
        self.used = 0;
    }
    fn header(pointer: [*]const u8, size: usize, count: usize, context: ?*anyopaque) callconv(.c) usize {
        const self: *Sink = @ptrCast(@alignCast(context orelse return 0));
        const length = std.math.mul(usize, size, count) catch return 0;
        if (length > self.header_storage.len -| self.header_total) {
            self.header_too_large = true;
            return 0;
        }
        self.header_total += length;
        // Discard proxy CONNECT / informational response headers. Trailers have
        // no HTTP status line and remain alongside the final response headers.
        const line = pointer[0..length];
        if (std.mem.startsWith(u8, line, "HTTP/")) {
            self.header_used = 0;
            var words = std.mem.tokenizeScalar(u8, line, ' ');
            _ = words.next();
            self.response_status = if (words.next()) |status| std.fmt.parseInt(u16, std.mem.trim(u8, status, "\r\n"), 10) catch null else null;
        }
        @memcpy(self.header_storage[self.header_used..][0..length], pointer[0..length]);
        self.header_used += length;
        if (self.stop_after_http429_head and self.response_status == 429 and std.mem.eql(u8, line, "\r\n")) {
            self.http429_head_aborted = true;
            return 0;
        }
        return length;
    }
    fn progress(context: ?*anyopaque, _: i64, _: i64, _: i64, _: i64) callconv(.c) c_int {
        const self: *Sink = @ptrCast(@alignCast(context orelse return 1));
        if (self.cancel) |cancel| if (cancel.load(.acquire)) return 1;
        return 0;
    }
};

const IdlePool = struct { handles: [8]*Handle = undefined, len: usize = 0 };
/// Response validation also guards trusted replay injection boundaries.
pub fn validateResponse(request: Request, response: Response) !void {
    if (response.status < 100 or response.status > 599) return error.InvalidHttpStatus;
    if (request.require_http2 and response.http_version != 3) return error.Http2Required;
    if (response.body.len > request.max_response_bytes) return error.ResponseTooLarge;
    if (response.header_storage.len > 32768 or response.headers.len > 512) return error.ResponseHeadersTooLarge;
    var size: usize = 0;
    for (response.headers) |header| {
        if (header.name.len == 0) return error.InvalidResponseHeader;
        for (header.name) |char| if (!headerToken(char)) return error.InvalidResponseHeader;
        for (header.value) |char| if ((char < 32 and char != '\t') or char == 127) return error.InvalidResponseHeader;
        if (header.name.len > 32768 -| size) return error.ResponseHeadersTooLarge;
        size += header.name.len;
        if (header.value.len > 32768 -| size or 4 > 32768 -| size -| header.value.len) return error.ResponseHeadersTooLarge;
        size += header.value.len + 4;
    }
}

pub const SendOverride = struct {
    context: *anyopaque,
    send_fn: *const fn (*anyopaque, std.mem.Allocator, Request) anyerror!Response,
};
/// Borrowed only during the callback. Callbacks must not retain request/response
/// or log private URLs, authorization headers, or payloads. Native sends only:
/// injected replay returns are intentionally unobserved.
pub const Observation = struct { request: Request, response: ?*const Response = null, failure: ?anyerror = null, duration_ns: u64 };
pub const Observer = struct { context: *anyopaque, event_fn: *const fn (*anyopaque, Observation) void };
// Serializes process-global initialization even with older native curl builds.
var initialization_mutex: std.Thread.Mutex = .{};
pub const Client = struct {
    observer: ?Observer = null,
    /// Trusted read-only replay boundary. Configure only on independently owned
    /// checkpoint reader clients, before use; never signing/broadcast/CCIP.
    send_override: ?SendOverride = null,
    library: std.DynLib,
    api: Api,
    mutex: std.Thread.Mutex = .{},
    // Pool zero is trusted RPC/cloud; pool one is exclusively public-only CCIP.
    // A live connection must never cross these trust classes: reused sockets do
    // not call OPENSOCKETFUNCTION and cannot be checked after the fact.
    idle: [2]IdlePool = .{ .{}, .{} },
    fn acquire(self: *Client, public_only: bool) !*Handle {
        self.mutex.lock();
        const pool = &self.idle[@intFromBool(public_only)];
        if (pool.len != 0) {
            pool.len -= 1;
            const handle = pool.handles[pool.len];
            self.mutex.unlock();
            return handle;
        }
        self.mutex.unlock();
        return self.api.easy_init() orelse error.LibcurlHandleFailed;
    }
    fn release(self: *Client, handle: *Handle, public_only: bool) void {
        // Reset request options/callback pointers, preserving vetted libcurl's
        // connection, DNS and TLS session caches on this exclusively owned handle.
        self.api.easy_reset(handle);
        self.mutex.lock();
        const pool = &self.idle[@intFromBool(public_only)];
        if (pool.len < pool.handles.len) {
            pool.handles[pool.len] = handle;
            pool.len += 1;
            self.mutex.unlock();
        } else {
            self.mutex.unlock();
            self.api.easy_cleanup(handle);
        }
    }
    pub fn init(_: std.mem.Allocator, library_path: []const u8) !Client {
        var library = try std.DynLib.open(library_path);
        errdefer library.close();
        const api = try Api.load(&library);
        initialization_mutex.lock();
        defer initialization_mutex.unlock();
        const version = api.version_info(0) orelse return error.LibcurlVersionUnavailable;
        // With synchronous DNS, CURLOPT_NOSIGNAL can leave a stalled resolver
        // outside the total timeout. Fail configuration instead of promising a
        // deadline the loaded library cannot enforce.
        if (version.features & (1 << 7) == 0) return error.LibcurlAsyncDnsRequired;
        if (api.global_init(3) != 0) return error.LibcurlInitializationFailed;
        return .{ .library = library, .api = api };
    }
    pub fn deinit(self: *Client) void {
        // Caller must join/cancel every send job before destroying this client.
        // Process-global curl resources are intentionally not cleaned up while
        // other HTTP clients/worker transports can still hold native handles.
        for (&self.idle) |*pool| {
            for (pool.handles[0..pool.len]) |handle| self.api.easy_cleanup(handle);
            pool.len = 0;
        }
        self.library.close();
        self.* = undefined;
    }
    fn check(code: c_int) !void {
        if (code != 0) return error.LibcurlOptionFailed;
    }
    /// Bounded native DNS + plain TCP preconnect. Sends no HTTP/PG bytes and
    /// closes immediately. Caller owns the returned numeric hostaddr text; the
    /// original hostname must still be retained for the eventual TLS identity.
    pub fn resolveHost(self: *Client, allocator: std.mem.Allocator, host: []const u8, port: u16, timeout_ms: u32, cancel: ?*const std.atomic.Value(bool)) ![]u8 {
        if (host.len == 0 or host.len > 253 or port == 0 or timeout_ms == 0) return error.InvalidResolveHost;
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (std.net.Address.parseIp(host, port) catch null) |_| return allocator.dupe(u8, host);
        for (host) |char| if (!std.ascii.isAlphanumeric(char) and char != '-' and char != '.' and char != '_') return error.InvalidResolveHost;
        const url = try std.fmt.allocPrintSentinel(allocator, "http://{s}:{d}/", .{ host, port }, 0);
        defer allocator.free(url);
        const handle = self.api.easy_init() orelse return error.LibcurlHandleFailed;
        defer self.api.easy_cleanup(handle); // fresh, never enters an HTTP pool
        const api = self.api;
        var empty: [0]u8 = .{};
        var sink: Sink = .{ .body = &empty, .cancel = cancel };
        try check(api.easy_setopt(handle, 10002, url.ptr));
        try check(api.easy_setopt(handle, 141, @as(c_long, 1))); // CONNECT_ONLY, plain TCP
        try check(api.easy_setopt(handle, 74, @as(c_long, 1))); // FRESH_CONNECT
        try check(api.easy_setopt(handle, 75, @as(c_long, 1))); // FORBID_REUSE
        try check(api.easy_setopt(handle, 10004, @as([*:0]const u8, ""))); // never proxy DNS preconnect
        try check(api.easy_setopt(handle, 10177, @as([*:0]const u8, "*")));
        try check(api.easy_setopt(handle, 52, @as(c_long, 0)));
        try check(api.easy_setopt(handle, 99, @as(c_long, 1)));
        try check(api.easy_setopt(handle, 155, @as(c_long, timeout_ms)));
        try check(api.easy_setopt(handle, 156, @as(c_long, timeout_ms)));
        try check(api.easy_setopt(handle, 43, @as(c_long, 0)));
        try check(api.easy_setopt(handle, 20219, @as(*const fn (?*anyopaque, i64, i64, i64, i64) callconv(.c) c_int, Sink.progress)));
        try check(api.easy_setopt(handle, 10057, &sink));
        const code = api.easy_perform(handle);
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (code == 28) return error.RequestDeadlineExceeded;
        if (code != 0) return error.CurlResolutionFailed;
        var primary: ?[*:0]const u8 = null;
        try check(api.easy_getinfo(handle, 0x100020, &primary)); // CURLINFO_PRIMARY_IP
        const text = std.mem.span(primary orelse return error.CurlResolutionFailed);
        _ = std.net.Address.parseIp(text, port) catch return error.InvalidResolvedAddress;
        return allocator.dupe(u8, text);
    }
    pub fn send(self: *Client, allocator: std.mem.Allocator, request: Request) !Response {
        try validateRequest(request);
        if (request.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.send_override) |override| {
            if (request.public_only) return error.PublicRequestOverrideForbidden;
            var result = try override.send_fn(override.context, allocator, request);
            errdefer result.deinit();
            try validateResponse(request, result);
            if (request.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
            return result;
        }
        const transfer = try Transfer.init(self, allocator, request);
        defer transfer.deinit();
        const started = if (self.observer != null) std.time.Instant.now() catch null else null;
        const result = transfer.finish(self.api.easy_perform(transfer.handle)) catch |err| {
            if (self.observer) |observer| observer.event_fn(observer.context, .{ .request = request, .failure = err, .duration_ns = observationElapsed(started) });
            return err;
        };
        if (self.observer) |observer| observer.event_fn(observer.context, .{ .request = request, .response = &result, .duration_ns = observationElapsed(started) });
        return result;
    }
};

/// Exclusively owned native easy transfer, shared by synchronous and multi HTTP.
/// Remove from any multi handle before deinit. Cancellation tokens are borrowed
/// and must remain stable until completion/deinit; URL/body/headers are copied.
pub const Transfer = struct {
    allocator: std.mem.Allocator,
    client: *Client,
    handle: *Handle,
    request: Request,
    url: [:0]u8,
    body: ?[]u8,
    headers: ?*Slist = null,
    sink: Sink,
    pub fn init(client: *Client, allocator: std.mem.Allocator, original: Request) !*Transfer {
        try validateRequest(original);
        if (original.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        const self = try allocator.create(Transfer);
        errdefer allocator.destroy(self);
        const url = try allocator.dupeZ(u8, original.url);
        errdefer allocator.free(url);
        const owned_body = if (original.body) |bytes| try allocator.dupe(u8, bytes) else null;
        errdefer if (owned_body) |bytes| allocator.free(bytes);
        const handle = try client.acquire(original.public_only);
        errdefer client.release(handle, original.public_only);
        var request = original;
        request.url = url;
        request.body = owned_body;
        self.* = .{ .allocator = allocator, .client = client, .handle = handle, .request = request, .url = url, .body = owned_body, .sink = .{ .allocator = allocator, .limit = request.max_response_bytes, .cancel = request.cancel, .stop_after_http429_head = request.stop_after_http429_head } };
        var headers: ?*Slist = null;
        errdefer client.api.slist_free_all(headers);
        var has_encoding = false;
        for (request.headers) |header| {
            has_encoding = has_encoding or std.ascii.eqlIgnoreCase(header.name, "accept-encoding");
            const line = try std.fmt.allocPrintSentinel(allocator, "{s}: {s}", .{ header.name, header.value }, 0);
            defer allocator.free(line);
            headers = client.api.slist_append(headers, line) orelse return error.OutOfMemory;
        }
        if (!has_encoding) headers = client.api.slist_append(headers, "accept-encoding: identity") orelse return error.OutOfMemory;
        const api = client.api;
        try Client.check(api.easy_setopt(handle, 10002, url.ptr));
        const method: [*:0]const u8 = switch (request.method) {
            .get => "GET",
            .post => "POST",
            .put => "PUT",
            .head => "HEAD",
            .delete => "DELETE",
        };
        try Client.check(api.easy_setopt(handle, 10036, method));
        if (request.method == .head) try Client.check(api.easy_setopt(handle, 44, @as(c_long, 1)));
        if (request.body) |body| {
            try Client.check(api.easy_setopt(handle, 10015, body.ptr));
            try Client.check(api.easy_setopt(handle, 30120, @as(i64, @intCast(body.len))));
        }
        try Client.check(api.easy_setopt(handle, 10023, headers));
        if (request.public_only) {
            // curl.h STRINGPOINT+4, STRINGPOINT+177, FUNCTIONPOINT+163,
            // CBPOINT+164. Never allow environment proxy routes to bypass the
            // actual target-address policy.
            try Client.check(api.easy_setopt(handle, 10004, @as([*:0]const u8, "")));
            try Client.check(api.easy_setopt(handle, 10177, @as([*:0]const u8, "*")));
            try Client.check(api.easy_setopt(handle, 20163, @as(*const fn (?*anyopaque, c_int, *const CurlSockaddr) callconv(.c) c_int, Sink.openSocket)));
            try Client.check(api.easy_setopt(handle, 10164, &self.sink));
        }
        try Client.check(api.easy_setopt(handle, 20011, @as(*const fn ([*]const u8, usize, usize, ?*anyopaque) callconv(.c) usize, Sink.write)));
        try Client.check(api.easy_setopt(handle, 10001, &self.sink));
        try Client.check(api.easy_setopt(handle, 20079, @as(*const fn ([*]const u8, usize, usize, ?*anyopaque) callconv(.c) usize, Sink.header)));
        try Client.check(api.easy_setopt(handle, 10029, &self.sink));
        try Client.check(api.easy_setopt(handle, 155, @as(c_long, request.timeout_ms)));
        try Client.check(api.easy_setopt(handle, 156, @as(c_long, request.connect_timeout_ms)));
        try Client.check(api.easy_setopt(handle, 52, @as(c_long, 0)));
        try Client.check(api.easy_setopt(handle, 99, @as(c_long, 1)));
        // S3 SigV4 signs the exact path; object keys may contain dot segments
        // and repeated slashes, which libcurl otherwise normalizes.
        try Client.check(api.easy_setopt(handle, 234, @as(c_long, 1))); // PATH_AS_IS
        try Client.check(api.easy_setopt(handle, 64, @as(c_long, 1)));
        try Client.check(api.easy_setopt(handle, 81, @as(c_long, 2)));
        if (request.require_http2) try Client.check(api.easy_setopt(handle, 84, @as(c_long, 5)));
        try Client.check(api.easy_setopt(handle, 43, @as(c_long, 0)));
        try Client.check(api.easy_setopt(handle, 20219, @as(*const fn (?*anyopaque, i64, i64, i64, i64) callconv(.c) c_int, Sink.progress)));
        try Client.check(api.easy_setopt(handle, 10057, &self.sink));

        self.headers = headers;
        self.request.headers = &.{};
        return self;
    }
    pub fn deinit(self: *Transfer) void {
        self.client.release(self.handle, self.request.public_only);
        self.client.api.slist_free_all(self.headers);
        self.allocator.free(self.url);
        self.sink.deinit();
        if (self.body) |bytes| self.allocator.free(bytes);
        const allocator = self.allocator;
        allocator.destroy(self);
    }
    pub fn finish(self: *Transfer, code: c_int) !Response {
        if (self.sink.non_public_destination) return error.NonPublicDestination;
        if (self.sink.too_large) return error.ResponseTooLarge;
        if (self.sink.header_too_large) return error.ResponseHeadersTooLarge;
        if (self.request.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.sink.out_of_memory) return error.OutOfMemory;
        if (code == 28) return error.RequestDeadlineExceeded;
        // CURLE_WRITE_ERROR is expected only for our explicit complete HTTP 429 head
        // stop. Bounds, cancellation, deadline and unrelated writes still fail.
        const intentional429 = self.request.stop_after_http429_head and self.sink.http429_head_aborted and self.sink.response_status == 429;
        if (self.sink.http429_head_aborted and code != 23) return error.CurlTransportFailed;
        if (code != 0 and !(code == 23 and intentional429)) return error.CurlTransportFailed;
        const allocator = self.allocator;
        const api = self.client.api;
        const handle = self.handle;
        var status: c_long = 0;
        var version: c_long = 0;
        try Client.check(api.easy_getinfo(handle, 0x200002, &status));
        try Client.check(api.easy_getinfo(handle, 0x20002e, &version));
        if (self.sink.http429_head_aborted and (code != 23 or status != 429 or self.sink.used != 0)) return error.CurlTransportFailed;
        if (self.request.require_http2 and version != 3) return error.Http2Required;
        if (status < 100 or status > 599) return error.InvalidHttpStatus;
        const header_storage = try allocator.dupe(u8, self.sink.header_storage[0..self.sink.header_used]);
        errdefer allocator.free(header_storage);
        var parsed_headers: std.ArrayList(Header) = .empty;
        defer parsed_headers.deinit(allocator);
        var lines = std.mem.splitSequence(u8, header_storage, "\r\n");
        while (lines.next()) |line| {
            if (line.len == 0 or std.mem.startsWith(u8, line, "HTTP/")) continue;
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.InvalidResponseHeader;
            if (colon == 0) return error.InvalidResponseHeader;
            for (line[0..colon]) |char| if (!headerToken(char)) return error.InvalidResponseHeader;
            for (line[colon + 1 ..]) |char| if ((char < 32 and char != '\t') or char == 127) return error.InvalidResponseHeader;
            if (parsed_headers.items.len >= 512) return error.ResponseHeadersTooLarge;
            try parsed_headers.append(allocator, .{ .name = line[0..colon], .value = std.mem.trim(u8, line[colon + 1 ..], " \t") });
        }
        const headers = try parsed_headers.toOwnedSlice(allocator);
        errdefer allocator.free(headers);
        const body = try self.sink.takeBody();
        return .{ .allocator = allocator, .status = @intCast(status), .http_version = version, .body = body, .headers = headers, .header_storage = header_storage };
    }
};

test "native HTTP sink bounds body headers and cancellation without loading curl" {
    std.testing.refAllDecls(Client);
    var body: [3]u8 = undefined;
    var cancelled = std.atomic.Value(bool).init(false);
    var sink: Sink = .{ .body = &body, .cancel = &cancelled };
    try std.testing.expectEqual(@as(usize, 3), Sink.write("abc", 1, 3, &sink));
    try std.testing.expectEqual(@as(usize, 0), Sink.write("d", 1, 1, &sink));
    try std.testing.expect(sink.too_large);
    try std.testing.expectEqual(@as(c_int, 0), Sink.progress(&sink, 0, 0, 0, 0));
    cancelled.store(true, .release);
    try std.testing.expectEqual(@as(c_int, 1), Sink.progress(&sink, 0, 0, 0, 0));
}

test "native HTTP validates NUL controls token headers and content encoding before loading curl" {
    const request: Request = .{ .url = "https://example.com/a/../b//c", .method = .get };
    try validateRequest(request);
    var invalid = request;
    invalid.url = "https://example.com/\x00ignored";
    try std.testing.expectError(error.InvalidHttpUrl, validateRequest(invalid));
    invalid.url = "https://example.com/a b";
    try std.testing.expectError(error.InvalidHttpUrl, validateRequest(invalid));
    invalid = request;
    invalid.headers = &.{.{ .name = "x bad", .value = "x" }};
    try std.testing.expectError(error.InvalidHttpHeader, validateRequest(invalid));
    invalid.headers = &.{.{ .name = "x-test", .value = "a\x00b" }};
    try std.testing.expectError(error.InvalidHttpHeader, validateRequest(invalid));
    invalid.headers = &.{.{ .name = "accept-encoding", .value = "gzip" }};
    try std.testing.expectError(error.UnsupportedContentEncoding, validateRequest(invalid));
    invalid.headers = &.{ .{ .name = "accept-encoding", .value = "identity" }, .{ .name = "Accept-Encoding", .value = "identity" } };
    try std.testing.expectError(error.InvalidHttpHeader, validateRequest(invalid));
    invalid.headers = &.{.{ .name = "Accept-Encoding", .value = "identity" }};
    try validateRequest(invalid);
}

test "public HTTP rejects literal destinations and native socket callback prevents rebinding" {
    for ([_][]const u8{ "http://127.0.0.1/", "http://169.254.169.254/", "http://[::ffff:127.0.0.1]/", "http://[::1]/" }) |url|
        try std.testing.expectError(error.NonPublicDestination, validateRequest(.{ .url = url, .method = .get, .public_only = true }));
    try validateRequest(.{ .url = "https://example.invalid/", .method = .get, .public_only = true });
    var body: [1]u8 = undefined;
    var sink: Sink = .{ .body = &body, .cancel = null };
    var address = try std.net.Address.parseIp("127.0.0.1", 80);
    var target: CurlSockaddr = .{ .family = std.posix.AF.INET, .socktype = std.posix.SOCK.STREAM, .protocol = std.posix.IPPROTO.TCP, .addrlen = @sizeOf(std.posix.sockaddr.in), .addr = address.any };
    try std.testing.expectEqual(@as(c_int, -1), Sink.openSocket(&sink, 0, &target));
    try std.testing.expect(sink.non_public_destination);
    sink.non_public_destination = false;
    address = try std.net.Address.parseIp("8.8.8.8", 443);
    target.addr = address.any;
    const fd = Sink.openSocket(&sink, 0, &target); // creates a socket, never connects
    try std.testing.expect(fd >= 0);
    std.posix.close(fd);
    try std.testing.expect(!sink.non_public_destination);
    var ipv6_target: extern struct { family: c_int, socktype: c_int, protocol: c_int, addrlen: c_uint, addr: std.posix.sockaddr.in6 } = .{ .family = std.posix.AF.INET6, .socktype = std.posix.SOCK.STREAM, .protocol = std.posix.IPPROTO.TCP, .addrlen = @sizeOf(std.posix.sockaddr.in6), .addr = (try std.net.Address.parseIp("::ffff:127.0.0.1", 80)).in6.sa };
    try std.testing.expectEqual(@as(c_int, -1), Sink.openSocket(&sink, 0, @ptrCast(&ipv6_target)));
    try std.testing.expect(sink.non_public_destination);
}

test "native public HTTP blocks localhost and noncanonical numeric IPv4 without connecting" {
    const allocator = std.testing.allocator;
    const library = std.process.getEnvVarOwned(allocator, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(library);
    var client = try Client.init(allocator, library);
    defer client.deinit();
    for ([_][]const u8{ "http://localhost:1/", "http://2130706433:1/", "http://0177.0.0.1:1/", "http://0x7f000001:1/" }) |url| {
        try std.testing.expectError(error.NonPublicDestination, client.send(allocator, .{ .url = url, .method = .get, .public_only = true, .timeout_ms = 500, .connect_timeout_ms = 500 }));
    }
}

const ReuseFixture = struct {
    server: std.net.Server,
    fn serve(self: *ReuseFixture) void {
        self.run() catch @panic("HTTP reuse fixture failed");
    }
    fn run(self: *ReuseFixture) !void {
        // Exactly one accepted connection must serve every trusted request.
        const connection = try self.server.accept();
        defer connection.stream.close();
        const methods = [_][]const u8{ "PUT", "HEAD", "GET", "POST" };
        const paths = [_][]const u8{ "/first", "/second", "/third", "/fourth" };
        for (methods, paths, 0..) |method, path, index| {
            var input: [8192]u8 = undefined;
            var used: usize = 0;
            while (true) {
                if (used == input.len) return error.FixtureRequestTooLarge;
                const count = try connection.stream.read(input[used..]);
                if (count == 0) return error.FixtureEof;
                used += count;
                const end = std.mem.indexOf(u8, input[0..used], "\r\n\r\n") orelse continue;
                const first_end = std.mem.indexOf(u8, input[0..end], "\r\n") orelse return error.FixtureBadRequest;
                var line: [64]u8 = undefined;
                try std.testing.expectEqualStrings(try std.fmt.bufPrint(&line, "{s} {s} HTTP/1.1", .{ method, path }), input[0..first_end]);
                var lines = std.mem.splitSequence(u8, input[first_end + 2 .. end], "\r\n");
                var length: usize = 0;
                var auth = false;
                while (lines.next()) |header| {
                    const colon = std.mem.indexOfScalar(u8, header, ':') orelse return error.FixtureBadHeader;
                    const name = header[0..colon];
                    const value = std.mem.trim(u8, header[colon + 1 ..], " \t");
                    if (std.ascii.eqlIgnoreCase(name, "content-length")) length = try std.fmt.parseInt(usize, value, 10);
                    if (std.ascii.eqlIgnoreCase(name, "authorization")) {
                        auth = true;
                        try std.testing.expectEqualStrings("Bearer fixture", value);
                    }
                }
                if (used < end + 4 + length) continue;
                try std.testing.expectEqual(index == 0, auth);
                const expected_body: []const u8 = if (index == 0) "one" else if (index == 3) "two" else "";
                try std.testing.expectEqualStrings(expected_body, input[end + 4 ..][0..length]);
                break;
            }
            const header = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n";
            try connection.stream.writeAll(header);
            if (index != 1) try connection.stream.writeAll("ok");
        }
    }
};

test "native HTTP reuses keepalive and isolates headers methods cancellation and trust pools" {
    const allocator = std.testing.allocator;
    const library = std.process.getEnvVarOwned(allocator, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(library);
    var client = try Client.init(allocator, library);
    defer client.deinit();
    var fixture: ReuseFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    defer fixture.server.deinit();
    const base = try std.fmt.allocPrint(allocator, "http://localhost:{d}", .{fixture.server.listen_address.getPort()});
    defer allocator.free(base);
    const thread = try std.Thread.spawn(.{}, ReuseFixture.serve, .{&fixture});
    defer thread.join();
    var cancelled = std.atomic.Value(bool).init(false);
    const methods = [_]Method{ .put, .head, .get, .post };
    const paths = [_][]const u8{ "/first", "/second", "/third", "/fourth" };
    for (methods, paths, 0..) |method, path, index| {
        const url = try std.fmt.allocPrint(allocator, "{s}{s}", .{ base, path });
        defer allocator.free(url);
        if (index == 1) {
            // Same hostname and endpoint as the already live trusted channel.
            // A mixed handle pool would reuse it and skip the socket callback.
            try std.testing.expectError(error.NonPublicDestination, client.send(allocator, .{ .url = url, .method = .get, .public_only = true, .timeout_ms = 500, .connect_timeout_ms = 500 }));
        }
        var response = try client.send(allocator, .{ .url = url, .method = method, .headers = if (index == 0) &.{.{ .name = "authorization", .value = "Bearer fixture" }} else &.{}, .body = if (index == 0) "one" else if (index == 3) "two" else null, .cancel = if (index == 0) &cancelled else null, .timeout_ms = 1000, .connect_timeout_ms = 1000 });
        defer response.deinit();
        try std.testing.expectEqualStrings(if (index == 1) "" else "ok", response.body);
        if (index == 0) cancelled.store(true, .release);
    }
}

const ResolveFixture = struct {
    server: std.net.Server,
    failure: ?anyerror = null,
    fn serve(self: *ResolveFixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *ResolveFixture) !void {
        var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&fd, 2000) == 0) return error.FixtureAcceptTimeout;
        const connection = try self.server.accept();
        defer connection.stream.close();
        var ready = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&ready, 2000) == 0) return error.FixtureResolveDidNotClose;
        var bytes: [1024]u8 = undefined;
        try std.testing.expectEqual(@as(usize, 0), try connection.stream.read(&bytes));
    }
};
test "native TCP resolver uses async DNS closes fresh socket and sends no application bytes" {
    const a = std.testing.allocator;
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var client = try Client.init(a, path);
    defer client.deinit();
    var fixture: ResolveFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, ResolveFixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) thread.join();
    const ip = try client.resolveHost(a, "localhost", fixture.server.listen_address.getPort(), 1000, null);
    defer a.free(ip);
    try std.testing.expectEqualStrings("127.0.0.1", ip);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
    try std.testing.expectError(error.InvalidResolveHost, client.resolveHost(a, "user:secret@localhost", 1, 1000, null));
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, client.resolveHost(a, "localhost", 1, 1000, &cancel));
}

test "native HTTP read-only override validates request cancellation and response bounds without loading curl" {
    const Fake = struct {
        called: usize = 0,
        body: []const u8 = "abc",
        header: Header = .{ .name = "content-type", .value = "application/json" },
        fn send(context: *anyopaque, a: std.mem.Allocator, _: Request) !Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.called += 1;
            const body = try a.dupe(u8, self.body);
            errdefer a.free(body);
            const headers = try a.dupe(Header, &.{self.header});
            errdefer a.free(headers);
            return .{ .allocator = a, .body = body, .headers = headers, .header_storage = try a.alloc(u8, 0), .status = 200, .http_version = 2 };
        }
    };
    var fake: Fake = .{};
    var client: Client = .{ .library = undefined, .api = undefined, .send_override = .{ .context = &fake, .send_fn = Fake.send } };
    const a = std.testing.allocator;
    const request: Request = .{ .url = "https://fixture.invalid/read", .method = .post, .max_response_bytes = 3 };
    var result = try client.send(a, request);
    result.deinit();
    try std.testing.expectEqual(@as(usize, 1), fake.called);
    var invalid = request;
    invalid.url = "https://fixture.invalid/\x00";
    try std.testing.expectError(error.InvalidHttpUrl, client.send(a, invalid));
    var cancel = std.atomic.Value(bool).init(true);
    invalid = request;
    invalid.cancel = &cancel;
    try std.testing.expectError(error.RequestCancelled, client.send(a, invalid));
    invalid = request;
    invalid.public_only = true;
    try std.testing.expectError(error.PublicRequestOverrideForbidden, client.send(a, invalid));
    try std.testing.expectEqual(@as(usize, 1), fake.called);
    fake.body = "abcd";
    try std.testing.expectError(error.ResponseTooLarge, client.send(a, request));
    fake.body = "abc";
    fake.header.name = "invalid:header";
    try std.testing.expectError(error.InvalidResponseHeader, client.send(a, request));
    fake.header.name = "type";
    fake.header.value = "bad\rvalue";
    try std.testing.expectError(error.InvalidResponseHeader, client.send(a, request));
    fake.header.value = "valid";
    invalid = request;
    invalid.require_http2 = true;
    try std.testing.expectError(error.Http2Required, client.send(a, invalid));
}

test "native HTTP growing body sink is lazy bounded and transfers exact ownership" {
    const a = std.testing.allocator;
    var sink: Sink = .{ .allocator = a, .limit = 10000, .cancel = null };
    defer sink.deinit();
    try std.testing.expectEqual(@as(usize, 0), sink.body.len);
    try std.testing.expectEqual(@as(usize, 3), Sink.write("abc", 1, 3, &sink));
    try std.testing.expectEqual(@as(usize, 4096), sink.body.len);
    var next: [4094]u8 = .{7} ** 4094;
    try std.testing.expectEqual(@as(usize, 4094), Sink.write(&next, 1, next.len, &sink));
    try std.testing.expectEqual(@as(usize, 8192), sink.body.len);
    const owned = try sink.takeBody();
    defer a.free(owned);
    try std.testing.expectEqual(@as(usize, 4097), owned.len);
    try std.testing.expectEqualStrings("abc", owned[0..3]);
    try std.testing.expectEqual(@as(usize, 0), sink.body.len);
    var limited: Sink = .{ .allocator = a, .limit = 3, .cancel = null };
    defer limited.deinit();
    try std.testing.expectEqual(@as(usize, 3), Sink.write("abc", 1, 3, &limited));
    try std.testing.expectEqual(@as(usize, 3), limited.body.len);
    try std.testing.expectEqual(@as(usize, 0), Sink.write("d", 1, 1, &limited));
    try std.testing.expect(limited.too_large);
    const unchanged = limited.body.ptr;
    try std.testing.expectEqual(@as(usize, 0), Sink.write("x", std.math.maxInt(usize), 2, &limited));
    try std.testing.expectEqual(unchanged, limited.body.ptr);
}
fn growingSinkAllocationCase(a: std.mem.Allocator) !void {
    var sink: Sink = .{ .allocator = a, .limit = 10000, .cancel = null };
    defer sink.deinit();
    if (Sink.write("abc", 1, 3, &sink) != 3) {
        if (sink.out_of_memory) return error.OutOfMemory;
        return error.UnexpectedSinkFailure;
    }
    var next: [4094]u8 = .{7} ** 4094;
    if (Sink.write(&next, 1, next.len, &sink) != next.len) {
        if (sink.out_of_memory) return error.OutOfMemory;
        return error.UnexpectedSinkFailure;
    }
    const body = try sink.takeBody();
    defer a.free(body);
    try std.testing.expectEqual(@as(usize, 4097), body.len);
}
test "native HTTP growing sink preserves OOM and cleanup on every allocation" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, growingSinkAllocationCase, .{});
    var storage: [0]u8 = .{};
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    var sink: Sink = .{ .allocator = fixed.allocator(), .limit = 1024, .cancel = null };
    defer sink.deinit();
    try std.testing.expectEqual(@as(usize, 0), Sink.write("x", 1, 1, &sink));
    try std.testing.expect(sink.out_of_memory);
    try std.testing.expect(!sink.too_large);
    var transfer: Transfer = undefined;
    transfer.request = .{ .url = "https://fixture.invalid", .method = .get };
    transfer.sink = sink;
    try std.testing.expectError(error.OutOfMemory, transfer.finish(23));
}
test "native HTTP max8MiB transfer initialization fits64KiB without eager body allocation" {
    const a = std.testing.allocator;
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var client = try Client.init(a, path);
    defer client.deinit();
    var storage: [64 * 1024]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    const transfer = try Transfer.init(&client, fixed.allocator(), .{ .url = "https://fixture.invalid/no-network", .method = .get, .max_response_bytes = 8 * 1024 * 1024 });
    defer transfer.deinit();
    try std.testing.expectEqual(@as(usize, 0), transfer.sink.body.len);
    try std.testing.expectEqual(@as(usize, 8 * 1024 * 1024), transfer.sink.limit);
}
test "native HTTP response payload moves across owned adapters without copying" {
    const a = std.testing.allocator;
    var response: Response = .{ .allocator = a, .status = 200, .http_version = 2, .body = try a.dupe(u8, "moved"), .headers = try a.alloc(Header, 0), .header_storage = try a.alloc(u8, 0) };
    const original = response.body.ptr;
    const body = response.takeBody();
    defer a.free(body);
    response.deinit();
    try std.testing.expectEqual(original, body.ptr);
    try std.testing.expectEqualStrings("moved", body);
}

fn observationElapsed(started: ?std.time.Instant) u64 {
    if (started) |start| if (std.time.Instant.now()) |now| return now.since(start) else |_| {};
    return 0;
}

test "native HTTP429 policy stops only complete final head and preserves other errors" {
    var sink: Sink = .{ .cancel = null, .stop_after_http429_head = true };
    const interim = [_][]const u8{ "HTTP/1.1 200 Connection established\r\n", "Proxy-Agent: fixture\r\n", "\r\n", "HTTP/1.1 100 Continue\r\n", "X-Interim: ignored\r\n", "\r\n", "HTTP/2 429 Too Many Requests\r\n", "Retry-After: 7\r\n" };
    for (interim) |line| try std.testing.expectEqual(line.len, Sink.header(line.ptr, 1, line.len, &sink));
    try std.testing.expect(!sink.http429_head_aborted);
    try std.testing.expectEqual(@as(usize, 0), Sink.header("\r\n", 1, 2, &sink));
    try std.testing.expect(sink.http429_head_aborted);
    try std.testing.expectEqualStrings("HTTP/2 429 Too Many Requests\r\nRetry-After: 7\r\n\r\n", sink.header_storage[0..sink.header_used]);
    try std.testing.expectEqual(@as(usize, 0), sink.body.len);
    var disabled: Sink = .{ .cancel = null };
    for ([_][]const u8{ "HTTP/1.1 429 Rejected\r\n", "\r\n" }) |line| try std.testing.expectEqual(line.len, Sink.header(line.ptr, 1, line.len, &disabled));
    try std.testing.expect(!disabled.http429_head_aborted);
    var redirects: Sink = .{ .cancel = null, .stop_after_http429_head = true };
    for ([_][]const u8{ "HTTP/1.1 302 Redirect\r\n", "Location: /next\r\n", "\r\n", "HTTP/1.1 200 OK\r\n", "\r\n" }) |line| try std.testing.expectEqual(line.len, Sink.header(line.ptr, 1, line.len, &redirects));
    try std.testing.expect(!redirects.http429_head_aborted);
    var transfer: Transfer = undefined;
    transfer.request = .{ .url = "https://fixture.invalid", .method = .get, .stop_after_http429_head = true };
    transfer.sink = sink;
    try std.testing.expectError(error.RequestDeadlineExceeded, transfer.finish(28));
    try std.testing.expectError(error.CurlTransportFailed, transfer.finish(0));
    var cancel = std.atomic.Value(bool).init(true);
    transfer.request.cancel = &cancel;
    try std.testing.expectError(error.RequestCancelled, transfer.finish(23));
    transfer.request.cancel = null;
    transfer.sink.too_large = true;
    try std.testing.expectError(error.ResponseTooLarge, transfer.finish(23));
    transfer.sink.too_large = false;
    transfer.sink.header_too_large = true;
    try std.testing.expectError(error.ResponseHeadersTooLarge, transfer.finish(23));
    transfer.sink.header_too_large = false;
    transfer.sink.out_of_memory = true;
    try std.testing.expectError(error.OutOfMemory, transfer.finish(23));
    transfer.sink = .{ .cancel = null };
    try std.testing.expectError(error.CurlTransportFailed, transfer.finish(23));
}
