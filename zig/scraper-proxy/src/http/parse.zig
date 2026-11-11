//! Request-head parsing with llhttp (strict, as used by Node) acceptance
//! rules, plus the find-my-way path normalisation and Fastify ContentType
//! parsing the server needs. Behaviour was measured against the TS server
//! (see testdata/http-corpus.json).
const std = @import("std");
const types = @import("types.zig");

const Header = types.Header;

/// Node `http.METHODS`; llhttp rejects anything else (and lowercase).
const methods = std.StaticStringMap(void).initComptime(.{
    .{"ACL"},        .{"BIND"},       .{"CHECKOUT"}, .{"CONNECT"},   .{"COPY"},        .{"DELETE"},
    .{"GET"},        .{"HEAD"},       .{"LINK"},     .{"LOCK"},      .{"M-SEARCH"},    .{"MERGE"},
    .{"MKACTIVITY"}, .{"MKCALENDAR"}, .{"MKCOL"},    .{"MOVE"},      .{"NOTIFY"},      .{"OPTIONS"},
    .{"PATCH"},      .{"POST"},       .{"PROPFIND"}, .{"PROPPATCH"}, .{"PURGE"},       .{"PUT"},
    .{"QUERY"},      .{"REBIND"},     .{"REPORT"},   .{"SEARCH"},    .{"SOURCE"},      .{"SUBSCRIBE"},
    .{"TRACE"},      .{"UNBIND"},     .{"UNLINK"},   .{"UNLOCK"},    .{"UNSUBSCRIBE"},
});

/// Node default `maxHeaderSize`: llhttp counts URL + header name/value bytes.
pub const max_header_bytes = 16 * 1024;
/// Node `server.maxHeadersCount`: later headers are ignored, not rejected.
const max_headers = 2000;

/// `invalid_te`: a request Transfer-Encoding whose last coding is not
/// `chunked`. llhttp dispatches the request, then fails with
/// HPE_INVALID_TRANSFER_ENCODING instead of reading a body or a next request.
pub const Framing = union(enum) { none, length: u64, chunked, invalid_te };

pub const Head = struct {
    method: []const u8,
    url: []const u8,
    major: u8,
    minor: u8,
    headers: []const Header,
    framing: Framing,
    /// Bytes consumed by the head (incl. final CRLFCRLF).
    len: usize,
};

pub const HeadError = error{ BadRequest, HeaderOverflow, OutOfMemory };

/// Result of scanning buffered bytes for a complete head.
pub const Scan = union(enum) { incomplete, complete: usize };

/// Finds the end of the head in `bytes` (which must not start with the
/// CRLFs llhttp skips between requests). Bare LF terminators are errors, and
/// an oversized partial head fails as soon as llhttp would.
pub fn scanHead(bytes: []const u8) HeadError!Scan {
    if (!methodPrefixValid(bytes[0..@min(bytes.len, 16)])) return error.BadRequest;
    var counted: usize = 0;
    var line_start: usize = 0;
    var first = true;
    var i: usize = 0;
    while (i < bytes.len) : (i += 1) {
        if (bytes[i] != '\n') continue;
        if (i == 0 or bytes[i - 1] != '\r') return error.BadRequest;
        const line = bytes[line_start .. i - 1];
        if (line.len == 0) return .{ .complete = i + 1 };
        counted += countedBytes(line, first);
        if (counted >= max_header_bytes) return error.HeaderOverflow;
        first = false;
        line_start = i + 1;
    }
    counted += countedBytes(bytes[line_start..], first);
    if (counted >= max_header_bytes) return error.HeaderOverflow;
    return .incomplete;
}

/// llhttp's header-size accounting for one (possibly partial) line.
fn countedBytes(line: []const u8, request_line: bool) usize {
    if (request_line) {
        const sp = std.mem.indexOfScalar(u8, line, ' ') orelse return 0;
        const rest = std.mem.trimLeft(u8, line[sp..], " ");
        const end = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
        return end;
    }
    const colon = std.mem.indexOfScalar(u8, line, ':') orelse return line.len;
    return colon + std.mem.trimLeft(u8, line[colon + 1 ..], " \t").len;
}

/// Parses a complete head (`bytes` ends with CRLFCRLF). Slices point into a
/// single arena copy of the head.
pub fn parseHead(arena: std.mem.Allocator, raw: []const u8) HeadError!Head {
    const bytes = try arena.dupe(u8, raw);
    var lines = std.mem.splitSequence(u8, bytes[0 .. bytes.len - 4], "\r\n");
    const request_line = lines.next() orelse return error.BadRequest;

    const sp = std.mem.indexOfScalar(u8, request_line, ' ') orelse return error.BadRequest;
    const method = request_line[0..sp];
    if (!methods.has(method)) return error.BadRequest;
    var rest = std.mem.trimLeft(u8, request_line[sp..], " ");
    const url_end = std.mem.indexOfScalar(u8, rest, ' ') orelse return error.BadRequest;
    const url = rest[0..url_end];
    // CONNECT carries an authority-form target.
    const connect = std.mem.eql(u8, method, "CONNECT");
    if (!(if (connect) url.len > 0 else validUrl(url))) return error.BadRequest;
    rest = std.mem.trimLeft(u8, rest[url_end..], " ");
    if (rest.len != 8 or !std.mem.startsWith(u8, rest, "HTTP/") or rest[6] != '.') return error.BadRequest;
    const major = rest[5] -% '0';
    const minor = rest[7] -% '0';
    const supported = (major == 0 and minor == 9) or (major == 1 and minor <= 1) or (major == 2 and minor == 0);
    if (!supported) return error.BadRequest;

    var headers: std.ArrayList(Header) = .empty;
    var content_length: ?u64 = null;
    var transfer_encoding = false;
    var chunked = false;
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.BadRequest;
        const name = line[0..colon];
        if (name.len == 0) return error.BadRequest;
        for (name) |c| if (!isToken(c)) return error.BadRequest;
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
        for (value) |c| if ((c < ' ' and c != '\t') or c == 0x7f) return error.BadRequest;
        if (std.ascii.eqlIgnoreCase(name, "content-length")) {
            if (content_length != null) return error.BadRequest;
            if (value.len == 0) return error.BadRequest;
            for (value) |c| if (!std.ascii.isDigit(c)) return error.BadRequest;
            content_length = std.fmt.parseInt(u64, value, 10) catch return error.BadRequest;
        } else if (std.ascii.eqlIgnoreCase(name, "transfer-encoding")) {
            // `chunked` may appear once, and only as the final coding.
            var codings = std.mem.splitScalar(u8, value, ',');
            while (codings.next()) |coding| {
                if (chunked) return error.BadRequest;
                if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, coding, " \t"), "chunked")) chunked = true;
            }
            transfer_encoding = true;
        }
        if (headers.items.len < max_headers) try headers.append(arena, .{ .name = name, .value = value });
    }
    if (transfer_encoding and content_length != null) return error.BadRequest;
    const framing: Framing = if (chunked)
        .chunked
    else if (transfer_encoding)
        .invalid_te
    else if (content_length) |n| (if (n == 0) .none else .{ .length = n }) else .none;
    return .{
        .method = method,
        .url = url,
        .major = major,
        .minor = minor,
        .headers = headers.items,
        .framing = framing,
        .len = bytes.len,
    };
}

/// llhttp's request-target grammar: origin-form (`/...`), `*`, or
/// absolute-form `scheme://server[/path][?query]`.
fn validUrl(url: []const u8) bool {
    if (url.len == 0) return false;
    for (url) |c| if (c <= ' ' or c >= 0x7f) return false;
    if (url[0] == '/' or url[0] == '*') return true;
    var i: usize = 0;
    while (i < url.len and std.ascii.isAlphabetic(url[i])) i += 1;
    if (i == 0 or !std.mem.startsWith(u8, url[i..], "://")) return false;
    for (url[i + 3 ..]) |c| {
        if (c == '/' or c == '?') return true;
        const server_char = std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "-_.!~*'()%;:&=+$,[]@", c) != null;
        if (!server_char) return false;
    }
    return true;
}

/// llhttp validates the method byte by byte, failing before the line ends.
fn methodPrefixValid(bytes: []const u8) bool {
    const sp = std.mem.indexOfScalar(u8, bytes, ' ');
    const candidate = bytes[0 .. sp orelse bytes.len];
    if (sp != null) return methods.has(candidate);
    for (methods.keys()) |m| if (std.mem.startsWith(u8, m, candidate)) return true;
    return false;
}

/// llhttp chunk-size line: HEXDIG+ (u64, no sign/underscore/whitespace),
/// then `;name[=token|quoted-string]` extensions with no whitespace.
pub fn parseChunkSize(line: []const u8) ?u64 {
    var i: usize = 0;
    var size: u64 = 0;
    while (i < line.len) : (i += 1) {
        const digit = std.fmt.charToDigit(line[i], 16) catch break;
        size = std.math.mul(u64, size, 16) catch return null;
        size = std.math.add(u64, size, digit) catch return null;
    }
    if (i == 0) return null;
    while (i < line.len) {
        if (line[i] != ';') return null;
        i += 1;
        const name_start = i;
        while (i < line.len and isToken(line[i])) i += 1;
        if (i == name_start) return null;
        if (i < line.len and line[i] == '=') {
            i += 1;
            if (i < line.len and line[i] == '"') {
                i += 1;
                while (true) {
                    if (i >= line.len) return null;
                    const c = line[i];
                    i += 1;
                    if (c == '"') break;
                    if (c == '\\') {
                        if (i >= line.len) return null;
                        i += 1;
                    } else if ((c < ' ' and c != '\t') or c == 0x7f) return null;
                }
            } else {
                while (i < line.len and isToken(line[i])) i += 1;
            }
        }
    }
    return size;
}

/// A chunked-trailer field line, validated like a header line.
pub fn validTrailer(line: []const u8) bool {
    const colon = std.mem.indexOfScalar(u8, line, ':') orelse return false;
    if (colon == 0) return false;
    for (line[0..colon]) |c| if (!isToken(c)) return false;
    for (line[colon + 1 ..]) |c| if ((c < ' ' and c != '\t') or c == 0x7f) return false;
    return true;
}

pub fn isToken(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "!#$%&'*+.^_`|~-", c) != null;
}

// ---------------------------------------------------------------------------
// find-my-way path handling (caseSensitive: false, ignoreTrailingSlash: true)
// ---------------------------------------------------------------------------

pub const PathResult = union(enum) {
    /// Lower-cased, decoded, trailing-slash-trimmed path for static matching.
    path: []const u8,
    /// FST_ERR_BAD_URL; carries the path find-my-way reports.
    bad_url: []const u8,
};

/// `Router.find` path preparation: absolute-form extraction, `safeDecodeURI`
/// (throws -> bad url), `trimLastSlash`, `toLowerCase`.
pub fn routerPath(arena: std.mem.Allocator, url: []const u8) error{OutOfMemory}!PathResult {
    var path = url;
    if (path.len == 0 or path[0] != '/') {
        path = (try absolutePath(arena, url)) orelse return .{ .bad_url = url };
    }
    const report = path;
    // Split at the first '?' or '#' after index 0.
    var end = path.len;
    for (path[1..], 1..) |c, i| if (c == '?' or c == '#') {
        end = i;
        break;
    };
    var target = path[0..end];
    var should_decode = false;
    var reencode = false;
    var i: usize = 1;
    while (i < target.len) : (i += 1) {
        if (target[i] != '%') continue;
        const reserved = reservedDecode(target, i);
        if (reserved == 0) should_decode = true else if (reserved == '%') {
            should_decode = true;
            reencode = true;
        }
        i += 2;
    }
    if (reencode) {
        // %25 -> %2525 so decodeURI yields %25 rather than a bare '%'.
        var out: std.ArrayList(u8) = .empty;
        var j: usize = 0;
        while (j < target.len) : (j += 1) {
            try out.append(arena, target[j]);
            if (target[j] == '%' and j > 0 and reservedDecode(target, j) == '%') try out.appendSlice(arena, "25");
        }
        target = out.items;
    }
    if (should_decode) {
        target = decodeUri(arena, target) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.Malformed => return .{ .bad_url = report },
        };
    }
    if (target.len > 1 and target[target.len - 1] == '/') target = target[0 .. target.len - 1];
    return .{ .path = try std.ascii.allocLowerString(arena, target) };
}

/// find-my-way `decodeComponentCharCode`: the char a `%XX` decodes to when
/// `decodeURI` would keep it encoded (# $ % & + , / : ; = ? @), else 0.
fn reservedDecode(s: []const u8, i: usize) u8 {
    // Truncated escape: the JS lookup sees NaN and returns 0.
    if (i + 2 >= s.len) return 0;
    const hi = s[i + 1];
    const lo = s[i + 2];
    if (hi < '2' or hi > '4') return 0;
    const pairs = [_]struct { u8, u8, u8 }{
        .{ '2', '3', '#' }, .{ '2', '4', '$' }, .{ '2', '5', '%' }, .{ '2', '6', '&' },
        .{ '2', 'B', '+' }, .{ '2', 'b', '+' }, .{ '2', 'C', ',' }, .{ '2', 'c', ',' },
        .{ '2', 'F', '/' }, .{ '2', 'f', '/' }, .{ '3', 'A', ':' }, .{ '3', 'a', ':' },
        .{ '3', 'B', ';' }, .{ '3', 'b', ';' }, .{ '3', 'D', '=' }, .{ '3', 'd', '=' },
        .{ '3', 'F', '?' }, .{ '3', 'f', '?' }, .{ '4', '0', '@' },
    };
    for (pairs) |p| if (p[0] == hi and p[1] == lo) return p[2];
    return 0;
}

/// JS `decodeURI`: decodes `%XX` UTF-8 sequences except reserved characters
/// (`;/?:@&=+$,#`), throwing (Malformed) on bad hex or invalid UTF-8.
pub fn decodeUri(arena: std.mem.Allocator, s: []const u8) error{ Malformed, OutOfMemory }![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] != '%') {
            try out.append(arena, s[i]);
            i += 1;
            continue;
        }
        const b0 = hexByte(s, i) orelse return error.Malformed;
        if (b0 < 0x80) {
            if (std.mem.indexOfScalar(u8, ";/?:@&=+$,#", b0) != null) {
                try out.appendSlice(arena, s[i .. i + 3]);
            } else try out.append(arena, b0);
            i += 3;
            continue;
        }
        const n: usize = if (b0 & 0xe0 == 0xc0) 2 else if (b0 & 0xf0 == 0xe0) 3 else if (b0 & 0xf8 == 0xf0) 4 else return error.Malformed;
        var buf: [4]u8 = undefined;
        buf[0] = b0;
        for (1..n) |k| {
            const at = i + 3 * k;
            if (at >= s.len or s[at] != '%') return error.Malformed;
            buf[k] = hexByte(s, at) orelse return error.Malformed;
            if (buf[k] & 0xc0 != 0x80) return error.Malformed;
        }
        const cp = std.unicode.utf8Decode(buf[0..n]) catch return error.Malformed;
        if (cp < 0x80 or (n == 3 and cp < 0x800) or (n == 4 and cp < 0x10000) or cp > 0x10ffff) return error.Malformed;
        try out.appendSlice(arena, buf[0..n]);
        i += 3 * n;
    }
    return out.items;
}

fn hexByte(s: []const u8, i: usize) ?u8 {
    if (i + 3 > s.len) return null;
    return std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch null;
}

/// find-my-way `getPathFromAbsoluteUrl` for http(s) absolute-form targets.
/// Returns the target unchanged for other schemes (later fails to match)
/// and null for an invalid authority (bad url).
fn absolutePath(arena: std.mem.Allocator, url: []const u8) error{OutOfMemory}!?[]const u8 {
    const scheme_end = std.mem.indexOf(u8, url, "://") orelse return url;
    const scheme = url[0..scheme_end];
    if (!std.ascii.eqlIgnoreCase(scheme, "http") and !std.ascii.eqlIgnoreCase(scheme, "https")) return url;
    const authority_start = scheme_end + 3;
    var authority_end = url.len;
    const path_start = std.mem.indexOfScalarPos(u8, url, authority_start, '/');
    if (path_start) |p| authority_end = p;
    const query_start = std.mem.indexOfScalarPos(u8, url, authority_start, '?');
    if (query_start) |q| if (q < authority_end) {
        authority_end = q;
    };
    if (std.mem.indexOfScalarPos(u8, url, authority_start, '#') != null or authority_end == authority_start) return null;
    if (!validAuthority(url[authority_start..authority_end])) return null;
    if (authority_end == url.len) return "/";
    if (query_start != null and authority_end == query_start.?) return try std.fmt.allocPrint(arena, "/{s}", .{url[query_start.?..]});
    return url[path_start.?..];
}

/// Rough WHATWG URL host check: non-empty host, optional numeric port.
fn validAuthority(authority: []const u8) bool {
    var host = authority;
    if (std.mem.lastIndexOfScalar(u8, authority, '@')) |at| host = authority[at + 1 ..];
    if (std.mem.lastIndexOfScalar(u8, host, ':')) |colon| {
        if (std.mem.indexOfScalar(u8, host, ']') == null or colon > std.mem.indexOfScalar(u8, host, ']').?) {
            for (host[colon + 1 ..]) |c| if (!std.ascii.isDigit(c)) return false;
            host = host[0..colon];
        }
    }
    return host.len > 0;
}

// ---------------------------------------------------------------------------
// Fastify ContentType
// ---------------------------------------------------------------------------

/// Fastify `ContentType#mediaType` (lower-cased `type/subtype`), or null when
/// the header is invalid (`isValid === false` -> 415).
pub fn mediaType(arena: std.mem.Allocator, header: []const u8) ?[]const u8 {
    if (header.len == 0 or std.mem.eql(u8, header, "undefined")) return null;
    const semi = std.mem.indexOfScalar(u8, header, ';');
    const media = if (semi) |s| header[0..s] else header;
    const slash = std.mem.indexOfScalar(u8, media, '/') orelse return null;
    const type_name = std.mem.trimLeft(u8, media[0..slash], " \t\r\n\x0b\x0c");
    const subtype = std.mem.trimRight(u8, media[slash + 1 ..], " \t\r\n\x0b\x0c");
    if (type_name.len == 0 or subtype.len == 0) return null;
    for (type_name) |c| if (!isTypeChar(c)) return null;
    for (subtype) |c| if (!isTypeChar(c)) return null;
    const out = std.fmt.allocPrint(arena, "{s}/{s}", .{ type_name, subtype }) catch return null;
    for (out) |*c| c.* = std.ascii.toLower(c.*);
    return out;
}

fn isTypeChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "_!#$%&'*+.^`|~-", c) != null;
}

test "scanHead counts llhttp header bytes and rejects bare LF" {
    try std.testing.expectEqual(Scan{ .complete = 31 }, try scanHead("GET /nope HTTP/1.1\r\nHost: a\r\n\r\n"));
    try std.testing.expectEqual(Scan.incomplete, try scanHead("GET /nope HTTP/1.1\r\nHost: a\r\n"));
    try std.testing.expectError(error.BadRequest, scanHead("GET /nope HTTP/1.1\nHost: a\r\n\n"));
    // Measured: a 16409-byte head of this shape is the first that Node rejects.
    const prefix = "GET /nope HTTP/1.1\r\nHost: a\r\nX: ";
    var big: [16_409]u8 = undefined;
    @memcpy(big[0..prefix.len], prefix);
    @memset(big[prefix.len .. big.len - 4], 'a');
    @memcpy(big[big.len - 4 ..], "\r\n\r\n");
    try std.testing.expectError(error.HeaderOverflow, scanHead(&big));
    const ok = big[1..];
    @memcpy(ok[0..prefix.len], prefix);
    try std.testing.expectEqual(Scan{ .complete = ok.len }, try scanHead(ok));
}

test "parseHead acceptance rules" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const h = try parseHead(a, "POST /graphql?x=1 HTTP/1.1\r\nHost: a\r\nContent-Length:  2 \r\nX: a \t\r\n\r\n");
    try std.testing.expectEqualStrings("/graphql?x=1", h.url);
    try std.testing.expectEqual(Framing{ .length = 2 }, h.framing);
    try std.testing.expectEqualStrings("a", h.headers[2].value);
    try std.testing.expectEqual(@as(u8, 2), (try parseHead(a, "GET / HTTP/2.0\r\n\r\n")).major);
    _ = try parseHead(a, "GET  /nope HTTP/1.1\r\n\r\n");
    _ = try parseHead(a, "PURGE / HTTP/1.1\r\nX: \xc3\xa9t\xc3\xa9\r\n\r\n");
    for ([_][]const u8{
        "GET / HTTP/1.2\r\n\r\n",                                                             "get / HTTP/1.1\r\n\r\n",
        "FOO / HTTP/1.1\r\n\r\n",                                                             "GET /\xc3\xa9t\xc3\xa9 HTTP/1.1\r\n\r\n",
        "GET / HTTP/1.1\r\nHost : a\r\n\r\n",                                                 "GET / HTTP/1.1\r\nX: a\x01b\r\n\r\n",
        "GET / HTTP/1.1\r\n folded\r\n\r\n",                                                  "GET / HTTP/1.1\r\nContent-Length: +3\r\n\r\n",
        "GET / HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",                   "GET / HTTP/1.1\r\nTransfer-Encoding: chunked, gzip\r\n\r\n",
        "GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n", "GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n",
    }) |bad| try std.testing.expectError(error.BadRequest, parseHead(a, bad));
    try std.testing.expectEqual(Framing.invalid_te, (try parseHead(a, "POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n")).framing);
    try std.testing.expectEqual(Framing.chunked, (try parseHead(a, "POST / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n")).framing);
}

test "chunk-size lines and trailers follow llhttp" {
    for ([_]struct { []const u8, ?u64 }{
        .{ "a", 10 },             .{ "A", 10 },          .{ "000a", 10 },         .{ "a;x=1", 10 },
        .{ "a;x", 10 },           .{ "a;x=", 10 },       .{ "a;x=1;y=2", 10 },    .{ "a;x=\"q\\\"z\"", 10 },
        .{ "+a", null },          .{ "1_0", null },      .{ "a ", null },         .{ " a", null },
        .{ "a ;x=1", null },      .{ "a;", null },       .{ "a; x=1", null },     .{ "a;x =1", null },
        .{ "a;x= 1", null },      .{ "a;x=\"open", null }, .{ "a;x=1 ", null },   .{ "a\t", null },
        .{ "a;x=@", null },       .{ "0xa", null },      .{ "ffffffffffffffffff", null }, .{ "", null },
    }) |case| try std.testing.expectEqual(case[1], parseChunkSize(case[0]));
    try std.testing.expect(validTrailer("X: y") and validTrailer("X:y"));
    try std.testing.expect(!validTrailer("X : y") and !validTrailer("Bad Trailer"));
}

test "routerPath mirrors find-my-way" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const cases = [_]struct { []const u8, []const u8 }{
        .{ "/GraphQL/", "/graphql" },          .{ "/%6Detrics", "/metrics" },     .{ "/METRICS?%zz", "/metrics" },
        .{ "/%41%2F", "/a%2f" },               .{ "/graphql%2F", "/graphql%2f" }, .{ "//metrics", "//metrics" },
        .{ "HTTP://X/metrics?a", "/metrics" }, .{ "http://x", "/" },              .{ "*", "*" },
        .{ "/a#b", "/a" },                     .{ "/%25", "/%25" },               .{ "/%C3%A9t%C3%A9", "/\xc3\xa9t\xc3\xa9" },
    };
    for (cases) |c| {
        const r = try routerPath(a, c[0]);
        std.testing.expectEqualStrings(c[1], r.path) catch |e| {
            std.debug.print("routerPath({s})\n", .{c[0]});
            return e;
        };
    }
    for ([_]struct { []const u8, []const u8 }{
        .{ "/%zz?x=1", "/%zz?x=1" },     .{ "/%E0%A4", "/%E0%A4" }, .{ "/a%2", "/a%2" }, .{ "http://x/%zz", "/%zz" },
        .{ "http://x#a", "http://x#a" },
    }) |c| {
        const r = try routerPath(a, c[0]);
        try std.testing.expectEqualStrings(c[1], r.bad_url);
    }
}

test "Fastify media types" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try std.testing.expectEqualStrings("application/json", mediaType(a, "Application/JSON; charset=utf-8").?);
    try std.testing.expectEqualStrings("text/plain", mediaType(a, " text/plain  ").?);
    try std.testing.expect(mediaType(a, ";;") == null);
    try std.testing.expect(mediaType(a, "application/ json") == null);
    try std.testing.expect(mediaType(a, "json") == null);
}
