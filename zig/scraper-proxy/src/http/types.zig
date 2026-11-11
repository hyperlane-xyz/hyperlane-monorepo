//! Request/reply/route types for the Fastify-equivalent HTTP layer.
//!
//! Lifecycle per request (mirrors Fastify 5 for this app):
//!   @fastify/cors onRequest (vary/allow-origin; OPTIONS preflight answered)
//!   -> route `on_request` (body not read yet; may `send` to short-circuit)
//!   -> body read (bodyLimit, Content-Length checks) + content-type parsing
//!   -> route `handler` (must `send`)
//!   framework errors (415/413/400 parse) -> route `error_handler` (or the
//!   Fastify default JSON error) ; every response -> route `on_send` ->
//!   bytes written -> route `on_done` (once, also when the client went away).
//! Hooks run synchronously on the connection's thread; `send` only records
//! the payload, the server finishes the exchange after the hook returns.
const std = @import("std");
const core = @import("core");

pub const Header = struct { name: []const u8, value: []const u8 };

/// Fastify `request.body` after content-type parsing.
pub const Body = union(enum) {
    /// No body (GET/HEAD, or no content-type and empty body).
    none,
    /// `application/json` (secure-json-parse) result.
    json: core.json.Value,
    /// `text/plain` or a route `text_content_types` entry (UTF-8 decoded).
    text: []const u8,
};

pub const Request = struct {
    /// Freed when the exchange ends; use for all per-request allocations.
    arena: std.mem.Allocator,
    method: []const u8,
    /// Raw request-target (`request.url`), e.g. `/graphql?query=...`.
    url: []const u8,
    /// `url` before `?`.
    path: []const u8,
    /// `url` after `?` (no `?`), raw/undecoded; empty when absent.
    query: []const u8,
    /// Headers in arrival order with names as sent.
    headers: []const Header,
    /// Peer address (`request.socket.remoteAddress`).
    remote_address: std.net.Address,
    body: Body = .none,
    /// Raw body bytes (empty until read).
    raw_body: []const u8 = "",
    /// `request.raw.complete`: the whole request (incl. body) was received.
    complete: bool = false,
    /// Set before `on_request`: the request has a body that is not fully
    /// buffered yet, so reading it will wait for the client.
    body_pending: bool = false,
    /// Free slot for route hooks (TS WeakMap state keyed by request).
    state: ?*anyopaque = null,

    /// Case-insensitive header lookup. Duplicates are joined with ", " like
    /// Node (`set-cookie` excepted; first value returned for it).
    pub fn header(self: *const Request, name: []const u8) ?[]const u8 {
        var found: ?[]const u8 = null;
        var joined: ?std.ArrayList(u8) = null;
        for (self.headers) |h| {
            if (!std.ascii.eqlIgnoreCase(h.name, name)) continue;
            if (found == null) {
                found = h.value;
                continue;
            }
            if (isSingleton(name)) continue;
            if (joined == null) {
                joined = .empty;
                joined.?.appendSlice(self.arena, found.?) catch return found;
            }
            joined.?.appendSlice(self.arena, ", ") catch return found;
            joined.?.appendSlice(self.arena, h.value) catch return found;
        }
        if (joined) |j| return j.items;
        return found;
    }

    /// Node `socket.remoteAddress` text (IPv4 dotted, IPv6 compressed, an
    /// IPv4-mapped IPv6 peer as `::ffff:a.b.c.d`).
    pub fn remoteIp(self: *const Request, buf: []u8) []const u8 {
        return formatIp(self.remote_address, buf);
    }
};

/// Node drops duplicates of these request headers (keeps the first).
fn isSingleton(name: []const u8) bool {
    const singles = [_][]const u8{ "age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "server", "user-agent" };
    for (singles) |s| if (std.ascii.eqlIgnoreCase(s, name)) return true;
    return false;
}

pub fn formatIp(address: std.net.Address, buf: []u8) []const u8 {
    switch (address.any.family) {
        std.posix.AF.INET => {
            const b: *const [4]u8 = @ptrCast(&address.in.sa.addr);
            return std.fmt.bufPrint(buf, "{d}.{d}.{d}.{d}", .{ b[0], b[1], b[2], b[3] }) catch "";
        },
        std.posix.AF.INET6 => {
            const b = address.in6.sa.addr;
            if (std.mem.eql(u8, b[0..12], &[_]u8{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff })) {
                return std.fmt.bufPrint(buf, "::ffff:{d}.{d}.{d}.{d}", .{ b[12], b[13], b[14], b[15] }) catch "";
            }
            var w = std.Io.Writer.fixed(buf);
            // Longest run of zero groups (>= 2) compresses to "::".
            var groups: [8]u16 = undefined;
            for (&groups, 0..) |*g, i| g.* = (@as(u16, b[2 * i]) << 8) | b[2 * i + 1];
            var best_start: usize = 8;
            var best_len: usize = 0;
            var i: usize = 0;
            while (i < 8) {
                if (groups[i] != 0) {
                    i += 1;
                    continue;
                }
                var j = i;
                while (j < 8 and groups[j] == 0) j += 1;
                if (j - i > best_len and j - i >= 2) {
                    best_start = i;
                    best_len = j - i;
                }
                i = j;
            }
            i = 0;
            while (i < 8) {
                if (i == best_start) {
                    w.writeAll("::") catch return "";
                    i += best_len;
                    continue;
                }
                if (i > 0 and i != best_start + best_len) w.writeByte(':') catch return "";
                w.print("{x}", .{groups[i]}) catch return "";
                i += 1;
            }
            return w.buffered();
        },
        else => return "",
    }
}

/// A Fastify error passed to error handlers (FST_ERR_* or a route error).
pub const FastifyError = struct {
    status: u16,
    /// e.g. "FST_ERR_CTP_INVALID_JSON_BODY".
    code: []const u8,
    message: []const u8,

    pub const invalid_media_type: FastifyError = .{ .status = 415, .code = "FST_ERR_CTP_INVALID_MEDIA_TYPE", .message = "Unsupported Media Type" };
    pub const body_too_large: FastifyError = .{ .status = 413, .code = "FST_ERR_CTP_BODY_TOO_LARGE", .message = "Request body is too large" };
    pub const invalid_content_length: FastifyError = .{ .status = 400, .code = "FST_ERR_CTP_INVALID_CONTENT_LENGTH", .message = "Request body size did not match Content-Length" };
    pub const empty_json_body: FastifyError = .{ .status = 400, .code = "FST_ERR_CTP_EMPTY_JSON_BODY", .message = "Body cannot be empty when content-type is set to 'application/json'" };
    pub const invalid_json_body: FastifyError = .{ .status = 400, .code = "FST_ERR_CTP_INVALID_JSON_BODY", .message = "Body is not valid JSON but content-type is set to 'application/json'" };
};

pub const Payload = union(enum) {
    /// `reply.send()` with no payload.
    none,
    bytes: []const u8,
};

/// Fastify `reply`. Header names are lowercased; setting an existing header
/// replaces it in place (JS object key order), which fixes the wire order.
pub const Reply = struct {
    arena: std.mem.Allocator,
    status: u16 = 200,
    headers: std.ArrayList(Header) = .empty,
    payload: Payload = .none,
    sent: bool = false,
    /// Destroy the socket once the response is written (graphql.ts
    /// `reply.raw.once('finish', () => request.raw.destroy())`).
    destroy_after: bool = false,
    /// Set by the server for the error path (`reply[kReplyIsError]`).
    error_value: ?FastifyError = null,

    pub fn code(self: *Reply, status: u16) void {
        self.status = status;
    }

    pub fn header(self: *Reply, name: []const u8, value: []const u8) void {
        const lower = std.ascii.allocLowerString(self.arena, name) catch return;
        for (self.headers.items) |*h| if (std.mem.eql(u8, h.name, lower)) {
            h.value = self.arena.dupe(u8, value) catch return;
            return;
        };
        self.headers.append(self.arena, .{ .name = lower, .value = self.arena.dupe(u8, value) catch return }) catch {};
    }

    pub fn getHeader(self: *const Reply, name: []const u8) ?[]const u8 {
        for (self.headers.items) |h| if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        return null;
    }

    pub fn removeHeader(self: *Reply, name: []const u8) void {
        for (self.headers.items, 0..) |h, i| if (std.ascii.eqlIgnoreCase(h.name, name)) {
            _ = self.headers.orderedRemove(i);
            return;
        };
    }

    /// `reply.type(contentType)`.
    pub fn @"type"(self: *Reply, content_type: []const u8) void {
        self.header("content-type", content_type);
    }

    /// `reply.send(string)`: default `text/plain; charset=utf-8`; a JSON
    /// content type without charset gets `; charset=utf-8` appended.
    pub fn sendText(self: *Reply, text: []const u8) void {
        if (self.getHeader("content-type")) |ct| {
            if (std.mem.indexOf(u8, mediaType(ct), "json") != null and !hasCharset(ct)) {
                const trimmed = std.mem.trimRight(u8, std.mem.trim(u8, ct, " \t"), ";");
                self.header("content-type", std.fmt.allocPrint(self.arena, "{s}; charset=utf-8", .{trimmed}) catch ct);
            }
        } else self.header("content-type", "text/plain; charset=utf-8");
        self.payload = .{ .bytes = text };
        self.sent = true;
    }

    /// `reply.send(object)`: default `application/json; charset=utf-8`.
    pub fn sendJson(self: *Reply, value: core.json.Value) void {
        const text = core.json.stringifyAlloc(self.arena, value) catch "";
        self.sendSerializedJson(text);
    }

    /// `reply.send(object)` where the caller already serialized the JSON.
    pub fn sendSerializedJson(self: *Reply, serialized: []const u8) void {
        if (self.getHeader("content-type")) |ct| {
            if (std.mem.indexOf(u8, mediaType(ct), "json") != null and !hasCharset(ct)) {
                const trimmed = std.mem.trimRight(u8, std.mem.trim(u8, ct, " \t"), ";");
                self.header("content-type", std.fmt.allocPrint(self.arena, "{s}; charset=utf-8", .{trimmed}) catch ct);
            }
        } else self.header("content-type", "application/json; charset=utf-8");
        self.payload = .{ .bytes = serialized };
        self.sent = true;
    }

    /// `reply.send(buffer)` / raw bytes with whatever content-type is set.
    pub fn sendBytes(self: *Reply, bytes: []const u8) void {
        self.payload = .{ .bytes = bytes };
        self.sent = true;
    }

    /// `reply.send()`.
    pub fn sendEmpty(self: *Reply) void {
        self.payload = .none;
        self.sent = true;
    }

    /// `reply.send(error)`: routes to the error handler.
    pub fn sendError(self: *Reply, err: FastifyError) void {
        self.error_value = err;
        self.sent = true;
    }

    /// Body bytes as sent (for on_send hooks such as the response cache).
    pub fn body(self: *const Reply) ?[]const u8 {
        return switch (self.payload) {
            .none => null,
            .bytes => |b| b,
        };
    }
};

fn mediaType(ct: []const u8) []const u8 {
    const semi = std.mem.indexOfScalar(u8, ct, ';') orelse ct.len;
    return std.mem.trim(u8, ct[0..semi], " \t");
}

fn hasCharset(ct: []const u8) bool {
    var it = std.mem.splitScalar(u8, ct, ';');
    _ = it.next();
    while (it.next()) |param| {
        const p = std.mem.trim(u8, param, " \t");
        if (p.len >= 8 and std.ascii.eqlIgnoreCase(p[0..8], "charset=")) return true;
    }
    return false;
}

pub const DoneReason = enum {
    /// Response fully written.
    finished,
    /// Connection closed/aborted before the response finished.
    closed,
};

pub const Hooks = struct {
    on_request: ?*const fn (ctx: *anyopaque, req: *Request, reply: *Reply) void = null,
    handler: *const fn (ctx: *anyopaque, req: *Request, reply: *Reply) void,
    /// Fastify `setErrorHandler` for this route's scope (mercurius installs
    /// one). Must `send`. Null -> Fastify default JSON error.
    error_handler: ?*const fn (ctx: *anyopaque, req: *Request, reply: *Reply, err: FastifyError) void = null,
    on_send: ?*const fn (ctx: *anyopaque, req: *Request, reply: *Reply) void = null,
    /// At most once per request, before `on_done`: the response write would
    /// block and the rest waits for the client to read.
    on_write_blocked: ?*const fn (ctx: *anyopaque, req: *Request, reply: *Reply) void = null,
    on_done: ?*const fn (ctx: *anyopaque, req: *Request, reply: *Reply, reason: DoneReason) void = null,
};

pub const Route = struct {
    /// Upper-case methods; GET also answers HEAD (Fastify exposeHeadRoutes).
    methods: []const []const u8,
    /// Lower-case path without trailing slash, e.g. "/graphql". Matching is
    /// case-insensitive and ignores one trailing slash.
    path: []const u8,
    ctx: *anyopaque,
    hooks: Hooks,
    /// Additional content types parsed as UTF-8 text (mercurius registers
    /// `application/graphql`). `application/json` and `text/plain` are built in.
    text_content_types: []const []const u8 = &.{},
    /// Fastify `bodyLimit`.
    body_limit: usize = 100 * 1024,
};

test "remoteIp formatting" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("127.0.0.1", formatIp(try std.net.Address.parseIp("127.0.0.1", 1), &buf));
    try std.testing.expectEqualStrings("::1", formatIp(try std.net.Address.parseIp("::1", 1), &buf));
    try std.testing.expectEqualStrings("2001:db8::1:0:0:1", formatIp(try std.net.Address.parseIp("2001:db8:0:0:1:0:0:1", 1), &buf));
    try std.testing.expectEqualStrings("::ffff:10.0.0.1", formatIp(try std.net.Address.parseIp("::ffff:10.0.0.1", 1), &buf));
}

test "reply header order and json charset" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var reply: Reply = .{ .arena = arena.allocator() };
    reply.header("Vary", "Origin");
    reply.header("cache-control", "max-age=30, public");
    reply.type("application/json");
    reply.sendText("{}");
    reply.header("VARY", "Origin");
    try std.testing.expectEqualStrings("vary", reply.headers.items[0].name);
    try std.testing.expectEqualStrings("application/json; charset=utf-8", reply.getHeader("content-type").?);
    try std.testing.expectEqual(@as(usize, 3), reply.headers.items.len);
}
