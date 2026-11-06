//! Source-compatible network-prefixed Aleo REST requests with injected transport.
const std = @import("std");
const http = @import("../cloud/http.zig");
const endpoint = @import("../net/endpoint.zig");
pub const Endpoint = endpoint.Endpoint;
pub const Pair = struct { name: []const u8, value: []const u8 };
pub const Response = struct {
    parsed: std.json.Parsed(std.json.Value),
    pub fn value(self: *const Response) std.json.Value {
        return self.parsed.value;
    }
    pub fn deinit(self: *Response) void {
        self.parsed.deinit();
        self.* = undefined;
    }
};
pub const Client = struct {
    allocator: std.mem.Allocator,
    transport: http.Transport,
    endpoints: []const Endpoint,
    network: u16,
    max_response_bytes: usize = 16 * 1024 * 1024,
    pub fn init(a: std.mem.Allocator, transport: http.Transport, endpoints: []const Endpoint, network: u16) !Client {
        _ = try networkName(network);
        if (endpoints.len == 0 or endpoints.len > 64) return error.InvalidAleoEndpoints;
        for (endpoints) |item| {
            const uri = try std.Uri.parse(item.url);
            if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or (!std.mem.eql(u8, uri.scheme, "https") and !std.mem.eql(u8, uri.scheme, "http"))) return error.InvalidAleoEndpoint;
        }
        return .{ .allocator = a, .transport = transport, .endpoints = endpoints, .network = network };
    }
    pub fn get(self: *Client, segments: []const []const u8, query: []const Pair) !Response {
        return (try self.request(.GET, segments, query, null, false)).?;
    }
    pub fn optional(self: *Client, segments: []const []const u8, query: []const Pair) !?Response {
        return self.request(.GET, segments, query, null, true);
    }
    /// A POST never automatically retries another endpoint after an uncertain send.
    /// Persist intent and reconcile its transaction hash before explicit retry.
    pub fn post(self: *Client, segments: []const []const u8, body: []const u8) !Response {
        return (try self.request(.POST, segments, &.{}, body, false)).?;
    }
    fn request(self: *Client, method: std.http.Method, segments: []const []const u8, query: []const Pair, body: ?[]const u8, optional_: bool) !?Response {
        if (self.max_response_bytes < 2 or self.max_response_bytes > 64 * 1024 * 1024) return error.InvalidAleoResponseLimit;
        var last: anyerror = error.NoAleoEndpoint;
        const targets = if (method == .POST) self.endpoints[0..1] else self.endpoints;
        for (targets) |item| {
            const url = try appendUrl(self.allocator, item.url, self.network, segments, query);
            defer self.allocator.free(url);
            var headers: std.ArrayList(http.Header) = .empty;
            defer headers.deinit(self.allocator);
            for (item.headers) |header| if (!std.ascii.eqlIgnoreCase(header.name, "content-type")) {
                try headers.append(self.allocator, header);
            };
            if (body != null) try headers.append(self.allocator, .{ .name = "content-type", .value = "application/json" });
            var response = self.transport.send(self.allocator, .{ .method = method, .url = url, .headers = headers.items, .body = body, .max_response_bytes = self.max_response_bytes }) catch |err| {
                if (@import("../net/json_rpc.zig").isControl(err)) return err;
                last = err;
                continue;
            };
            defer response.deinit();
            if (optional_ and response.status == 404) return null;
            if (response.status < 200 or response.status >= 300) {
                last = error.AleoHttpStatus;
                continue;
            }
            const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" }) catch |err| {
                if (@import("../net/json_rpc.zig").isControl(err)) return err;
                last = err;
                continue;
            };
            return .{ .parsed = parsed };
        }
        return last;
    }
};
pub fn networkName(network: u16) ![]const u8 {
    return switch (network) {
        0 => "mainnet",
        1 => "testnet",
        2 => "canary",
        else => error.UnknownAleoNetwork,
    };
}
fn encode(a: std.mem.Allocator, out: *std.ArrayList(u8), value: []const u8, path: bool) !void {
    const digits = "0123456789ABCDEF";
    for (value) |byte| {
        const plain = std.ascii.isAlphanumeric(byte) or std.mem.indexOfScalar(u8, "-._~", byte) != null or (path and std.mem.indexOfScalar(u8, "!$&'()*+,:;=@", byte) != null);
        if (plain) try out.append(a, byte) else try out.appendSlice(a, &.{ '%', digits[byte >> 4], digits[byte & 15] });
    }
}
pub fn appendUrl(a: std.mem.Allocator, base: []const u8, network: u16, segments: []const []const u8, query: []const Pair) ![]u8 {
    const network_name = try networkName(network);
    const uri = try std.Uri.parse(base);
    if (uri.fragment != null) return error.InvalidAleoEndpoint;
    const end = std.mem.indexOfScalar(u8, base, '?') orelse base.len;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(a);
    try out.appendSlice(a, std.mem.trimEnd(u8, base[0..end], "/"));
    try out.append(a, '/');
    try out.appendSlice(a, network_name);
    for (segments) |segment| {
        if (segment.len == 0 or std.mem.eql(u8, segment, ".") or std.mem.eql(u8, segment, "..") or std.mem.indexOfScalar(u8, segment, '/') != null) return error.InvalidAleoPathSegment;
        try out.append(a, '/');
        try encode(a, &out, segment, true);
    }
    var has_query = false;
    if (uri.query != null) {
        const raw = base[end + 1 ..];
        if (raw.len > 0) {
            try out.append(a, '?');
            try out.appendSlice(a, raw);
            has_query = true;
        }
    }
    for (query) |pair| {
        try out.append(a, if (has_query) '&' else '?');
        has_query = true;
        try encode(a, &out, pair.name, false);
        try out.append(a, '=');
        try encode(a, &out, pair.value, false);
    }
    return out.toOwnedSlice(a);
}

test "Aleo REST URL matches actual Rust Url segment and bracket escaping" {
    const a = std.testing.allocator;
    const url = try appendUrl(a, "https://api.explorer.provable.com/v2/", 0, &.{ "program", "hyp_validator_announce.aleo", "mapping", "storage_sequences", "{ bytes: [79u8, 151u8] }" }, &.{});
    defer a.free(url);
    try std.testing.expectEqualStrings("https://api.explorer.provable.com/v2/mainnet/program/hyp_validator_announce.aleo/mapping/storage_sequences/%7B%20bytes:%20%5B79u8,%20151u8%5D%20%7D", url);
    const query = try appendUrl(a, "https://example/v2?token=public", 1, &.{ "mapping", "true" }, &.{.{ .name = "metadata", .value = "true" }});
    defer a.free(query);
    try std.testing.expectEqualStrings("https://example/v2/testnet/mapping/true?token=public&metadata=true", query);
    try std.testing.expectError(error.UnknownAleoNetwork, appendUrl(a, "https://example", 3, &.{}, &.{}));
}

test "Aleo cooperative control never advances read fallback" {
    const Pending = struct {
        calls: usize = 0,
        fn send(ctx: *anyopaque, _: std.mem.Allocator, _: http.Request) !http.Response {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return error.PendingReadIo;
        }
    };
    var pending: Pending = .{};
    var client = try Client.init(std.testing.allocator, .{ .context = &pending, .send_fn = Pending.send }, &.{ .{ .url = "https://one.fixture" }, .{ .url = "https://two.fixture" } }, 0);
    try std.testing.expectError(error.PendingReadIo, client.get(&.{"latest"}, &.{}));
    try std.testing.expectEqual(@as(usize, 1), pending.calls);
}
