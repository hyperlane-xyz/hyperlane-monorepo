//! Shared explicit RPC endpoint and sensitive custom-header parsing.
const std = @import("std");
const http = @import("../cloud/http.zig");
const A = std.mem.Allocator;
pub const Endpoint = struct { url: []const u8, headers: []const http.Header = &.{} };
/// Source-compatible custom_rpc_header query extraction. Owns the sanitized URL
/// and sensitive header values; diagnostics never format either.
pub const OwnedEndpoint = struct {
    arena: std.heap.ArenaAllocator,
    endpoint: Endpoint,
    /// Canonical original URL, before header/userinfo extraction, as used by
    /// Rust Url equality for validator endpoint-vote deduplication. Sensitive.
    identity: []const u8,
    pub fn parse(allocator: A, text: []const u8) !OwnedEndpoint {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const identity = try canonicalIdentity(a, text);
        var uri = try std.Uri.parse(identity);
        var basic: ?[]const u8 = null;
        if (uri.user) |component| {
            const user = try component.toRawMaybeAlloc(a);
            const password = if (uri.password) |value| try value.toRawMaybeAlloc(a) else "";
            if (std.mem.indexOfScalar(u8, user, ':') != null) return error.InvalidEndpointUrl;
            const credentials = try std.fmt.allocPrint(a, "{s}:{s}", .{ user, password });
            const encoder = std.base64.standard.Encoder;
            const value = try a.alloc(u8, 6 + encoder.calcSize(credentials.len));
            @memcpy(value[0..6], "Basic ");
            _ = encoder.encode(value[6..], credentials);
            basic = value;
            uri.user = null;
            uri.password = null;
        }
        const sanitized = try std.fmt.allocPrint(a, "{f}", .{uri});
        const validated = try validateUrl(a, sanitized);
        var headers: std.ArrayList(http.Header) = .empty;
        var url: std.ArrayList(u8) = .empty;
        const query = std.mem.indexOfScalar(u8, validated, '?') orelse validated.len;
        try url.appendSlice(a, validated[0..query]);
        var retained: usize = 0;
        if (query < validated.len) {
            var pairs = std.mem.splitScalar(u8, validated[query + 1 ..], '&');
            while (pairs.next()) |pair| {
                if (pair.len == 0) continue;
                const equal = std.mem.indexOfScalar(u8, pair, '=') orelse pair.len;
                const key = try formDecode(a, pair[0..equal]);
                const value = try formDecode(a, if (equal == pair.len) "" else pair[equal + 1 ..]);
                if (std.mem.eql(u8, key, "custom_rpc_header")) {
                    const colon = std.mem.indexOfScalar(u8, value, ':') orelse continue;
                    const name = value[0..colon];
                    const contents = value[colon + 1 ..];
                    if (name.len == 0) return error.InvalidEndpointHeader;
                    for (name) |c| if (!std.ascii.isAlphanumeric(c) and std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", c) == null) return error.InvalidEndpointHeader;
                    for (contents) |c| if ((c < 32 and c != '\t') or c == 127) return error.InvalidEndpointHeader;
                    var existing: ?usize = null;
                    for (headers.items, 0..) |header, i| if (std.ascii.eqlIgnoreCase(header.name, name)) {
                        existing = i;
                        break;
                    };
                    if (existing) |i| headers.items[i] = .{ .name = name, .value = contents } else try headers.append(a, .{ .name = name, .value = contents });
                } else {
                    try url.append(a, if (retained == 0) '?' else '&');
                    retained += 1;
                    try formEncode(a, &url, key);
                    try url.append(a, '=');
                    try formEncode(a, &url, value);
                }
            }
        }
        if (basic) |value| {
            for (headers.items) |header| if (std.ascii.eqlIgnoreCase(header.name, "authorization")) return error.AmbiguousEndpointAuthorization;
            try headers.append(a, .{ .name = "authorization", .value = value });
        }
        const clean_url = try url.toOwnedSlice(a);
        const clean_headers = try headers.toOwnedSlice(a);
        return .{ .arena = arena, .endpoint = .{ .url = clean_url, .headers = clean_headers }, .identity = identity };
    }
    pub fn deinit(self: *OwnedEndpoint) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

/// ASCII HTTP(S) WHATWG/Rust Url normalization for endpoint identity. IDNA and
/// legacy numeric IPv4 forms are deliberately rejected rather than counted as
/// separate votes under an incorrectly normalized spelling.
pub fn canonicalIdentity(allocator: A, text: []const u8) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for (text) |c| if (c <= 32 or c >= 127 or c == '\\') return error.UnsupportedEndpointIdentity;
    var uri = try std.Uri.parse(text);
    const scheme = try a.dupe(u8, uri.scheme);
    for (scheme) |*c| c.* = std.ascii.toLower(c.*);
    uri.scheme = scheme;
    if ((!std.mem.eql(u8, scheme, "http") and !std.mem.eql(u8, scheme, "https")) or uri.host == null or uri.fragment != null) return error.InvalidEndpointUrl;
    const raw_host = componentText(uri.host.?);
    if (raw_host.len == 0 or std.mem.indexOfScalar(u8, raw_host, '%') != null) return error.UnsupportedEndpointIdentity;
    const host = try a.dupe(u8, raw_host);
    for (host) |*c| c.* = std.ascii.toLower(c.*);
    if (host[0] == '[') {
        if (host.len < 3 or host[host.len - 1] != ']') return error.InvalidEndpointUrl;
        uri.host = .{ .percent_encoded = try ipv6Canonical(a, host[1 .. host.len - 1]) };
    } else {
        for (host) |c| if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '.' and c != '_') return error.UnsupportedEndpointIdentity;
        const without_dot = std.mem.trimEnd(u8, host, ".");
        const label_start = if (std.mem.lastIndexOfScalar(u8, without_dot, '.')) |i| i + 1 else 0;
        const last = without_dot[label_start..];
        const numeric = last.len > 0 and (allDigits(last) or std.mem.startsWith(u8, last, "0x"));
        if (numeric) {
            const parsed = std.net.Ip4Address.parse(host, 0) catch return error.UnsupportedEndpointIdentity;
            const octets: *const [4]u8 = @ptrCast(&parsed.sa.addr);
            const canonical = try std.fmt.allocPrint(a, "{d}.{d}.{d}.{d}", .{ octets[0], octets[1], octets[2], octets[3] });
            if (!std.mem.eql(u8, canonical, host)) return error.UnsupportedEndpointIdentity;
            uri.host = .{ .percent_encoded = canonical };
        } else uri.host = .{ .percent_encoded = host };
    }
    if ((std.mem.eql(u8, scheme, "https") and uri.port == 443) or (std.mem.eql(u8, scheme, "http") and uri.port == 80)) uri.port = null;
    if (uri.password) |password| if (componentText(password).len == 0) {
        uri.password = null;
    };
    if (uri.user) |user| if (componentText(user).len == 0 and uri.password == null) {
        uri.user = null;
    };
    uri.path = .{ .percent_encoded = try normalizePath(a, componentText(uri.path)) };
    // WHATWG special-URL queries escape ASCII quotes differently from RFC3986.
    // This uncommon form is unsupported until covered by a full URL dependency.
    if (uri.query) |query| if (std.mem.indexOfScalar(u8, componentText(query), '\'') != null) return error.UnsupportedEndpointIdentity;
    const canonical = try std.fmt.allocPrint(a, "{f}", .{uri});
    return allocator.dupe(u8, canonical);
}
fn componentText(value: std.Uri.Component) []const u8 {
    return switch (value) {
        .raw => |text| text,
        .percent_encoded => |text| text,
    };
}
fn allDigits(text: []const u8) bool {
    for (text) |c| if (!std.ascii.isDigit(c)) return false;
    return true;
}
fn dotCount(segment: []const u8) usize {
    var count: usize = 0;
    var i: usize = 0;
    while (i < segment.len) {
        if (segment[i] == '.') i += 1 else if (segment.len - i >= 3 and std.ascii.eqlIgnoreCase(segment[i..][0..3], "%2e")) i += 3 else return 0;
        count += 1;
    }
    return if (count <= 2) count else 0;
}
fn normalizePath(a: A, path: []const u8) ![]u8 {
    if (path.len == 0) return a.dupe(u8, "/");
    if (path[0] != '/') return error.InvalidEndpointUrl;
    var stack: std.ArrayList([]const u8) = .empty;
    var parts = std.mem.splitScalar(u8, path[1..], '/');
    while (parts.next()) |part| {
        switch (dotCount(part)) {
            1 => {
                if (parts.index == null) try stack.append(a, "");
            },
            2 => {
                if (stack.items.len != 0) _ = stack.pop();
                if (parts.index == null) try stack.append(a, "");
            },
            else => try stack.append(a, part),
        }
    }
    return std.fmt.allocPrint(a, "/{s}", .{try std.mem.join(a, "/", stack.items)});
}
fn ipv6Canonical(a: A, host: []const u8) ![]u8 {
    if (std.mem.indexOfScalar(u8, host, '%') != null) return error.UnsupportedEndpointIdentity;
    const parsed = std.net.Ip6Address.parse(host, 0) catch return error.InvalidEndpointUrl;
    var words: [8]u16 = undefined;
    for (&words, 0..) |*word, i| word.* = std.mem.readInt(u16, parsed.sa.addr[i * 2 ..][0..2], .big);
    var best_start: usize = 8;
    var best_len: usize = 0;
    var i: usize = 0;
    while (i < 8) {
        if (words[i] != 0) {
            i += 1;
            continue;
        }
        const start = i;
        while (i < 8 and words[i] == 0) : (i += 1) {}
        if (i - start > best_len) {
            best_start = start;
            best_len = i - start;
        }
    }
    if (best_len < 2) best_start = 8;
    var out: std.ArrayList(u8) = .empty;
    try out.append(a, '[');
    i = 0;
    while (i < 8) {
        if (i == best_start) {
            try out.appendSlice(a, "::");
            i += best_len;
            continue;
        }
        if (i != 0 and out.items[out.items.len - 1] != ':') try out.append(a, ':');
        try out.appendSlice(a, try std.fmt.allocPrint(a, "{x}", .{words[i]}));
        i += 1;
    }
    try out.append(a, ']');
    return out.toOwnedSlice(a);
}
fn formDecode(a: A, text: []const u8) ![]u8 {
    const out = try a.alloc(u8, text.len);
    var used: usize = 0;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] == '%') {
            if (text.len - i < 3) return error.InvalidEndpointUrl;
            out[used] = std.fmt.parseInt(u8, text[i + 1 ..][0..2], 16) catch return error.InvalidEndpointUrl;
            i += 2;
        } else out[used] = if (text[i] == '+') ' ' else text[i];
        used += 1;
    }
    if (!std.unicode.utf8ValidateSlice(out[0..used])) return error.InvalidEndpointUrl;
    return out[0..used];
}
fn formEncode(a: A, out: *std.ArrayList(u8), text: []const u8) !void {
    const digits = "0123456789ABCDEF";
    for (text) |c| {
        if (std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "*-._", c) != null) try out.append(a, c) else if (c == ' ') try out.append(a, '+') else try out.appendSlice(a, &.{ '%', digits[c >> 4], digits[c & 15] });
    }
}
fn validateUrl(a: A, text: []const u8) ![]u8 {
    const uri = try std.Uri.parse(text);
    if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or
        (!std.mem.eql(u8, uri.scheme, "http") and !std.mem.eql(u8, uri.scheme, "https"))) return error.InvalidEndpointUrl;
    return a.dupe(u8, text);
}
test "shared endpoint custom RPC header URLs match production extraction duplicate replacement and form queries" {
    var parsed = try OwnedEndpoint.parse(std.testing.allocator, "https://fixture/wallet?custom_rpc_header=Authorization:First&custom_rpc_header=BadNoColon&custom_rpc_header=authorization:Second+Token&custom_rpc_header=Content-Type:application/json&keep=one%20two&keep=%7E");
    defer parsed.deinit();
    try std.testing.expectEqualStrings("https://fixture/wallet?keep=one+two&keep=%7E", parsed.endpoint.url);
    try std.testing.expectEqual(@as(usize, 2), parsed.endpoint.headers.len);
    try std.testing.expectEqualStrings("Second Token", parsed.endpoint.headers[0].value);
    try std.testing.expectEqualStrings("application/json", parsed.endpoint.headers[1].value);
    try std.testing.expectError(error.InvalidEndpointHeader, OwnedEndpoint.parse(std.testing.allocator, "https://fixture/?custom_rpc_header=Authorization:bad%0D%0Ainjected"));
    var basic = try OwnedEndpoint.parse(std.testing.allocator, "https://fixture-user:fixture-password@fixture/wallet");
    defer basic.deinit();
    try std.testing.expectEqualStrings("https://fixture/wallet", basic.endpoint.url);
    // Fixed expected bytes keep this assertion independent of the production encoder.
    try std.testing.expect(std.mem.startsWith(u8, basic.endpoint.headers[0].value, "Basic "));
    try std.testing.expectEqualSlices(u8, &.{ 90, 109, 108, 52, 100, 72, 86, 121, 90, 83, 49, 49, 99, 50, 86, 121, 79, 109, 90, 112, 101, 72, 82, 49, 99, 109, 85, 116, 99, 71, 70, 122, 99, 51, 100, 118, 99, 109, 81, 61 }, basic.endpoint.headers[0].value[6..]);
    try std.testing.expectError(error.AmbiguousEndpointAuthorization, OwnedEndpoint.parse(std.testing.allocator, "https://user:password@fixture/?custom_rpc_header=authorization:Bearer+fixture"));
}

test "shared endpoint canonical identity matches actual production Rust URL corpus or explicitly rejects unsupported spellings" {
    const a = std.testing.allocator;
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/endpoints.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var total: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = try std.json.parseFromSlice(struct { input: []const u8, canonical: []const u8, supported: bool }, a, line, .{});
        defer parsed.deinit();
        if (parsed.value.supported) {
            const identity = try canonicalIdentity(a, parsed.value.input);
            defer a.free(identity);
            try std.testing.expectEqualStrings(parsed.value.canonical, identity);
            var owned = try OwnedEndpoint.parse(a, parsed.value.input);
            defer owned.deinit();
            try std.testing.expectEqualStrings(identity, owned.identity);
        } else try std.testing.expectError(error.UnsupportedEndpointIdentity, canonicalIdentity(a, parsed.value.input));
        total += 1;
    }
    try std.testing.expectEqual(@as(usize, 26), total);
}
