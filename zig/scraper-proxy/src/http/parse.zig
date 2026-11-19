//! Request-head parsing with llhttp (strict, as used by Node) acceptance
//! rules, plus the find-my-way path normalisation and Fastify ContentType
//! parsing the server needs. Behaviour was measured against the TS server
//! (see testdata/http-corpus.json).
const std = @import("std");
const builtin = @import("builtin");
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
/// CRLFs llhttp skips between requests), validating as llhttp does while
/// bytes arrive: the first byte no complete head could accept fails at
/// once, even while the head is incomplete, and Node's header-size count
/// (URL, header names, header values after their leading whitespace) is
/// checked whenever one of those spans ends or the input does, so a syntax
/// error before the overflow point is a 400 and one after it a 431.
/// `parseHead` then applies the rules that need the whole head.
pub fn scanHead(bytes: []const u8) HeadError!Scan {
    var v: HeadScanner = .{};
    return v.scan(bytes);
}

/// `scanHead` resumable across reads, as llhttp is: a connection keeps one
/// per head and passes the head's bytes so far each time; only bytes not
/// yet seen are stepped, so a head arriving a byte at a time costs O(n).
pub const HeadScanner = struct {
    /// Bytes of the head already stepped.
    scanned: usize = 0,
    /// Test-only: every byte ever stepped (linearity checks).
    stepped: if (builtin.is_test) usize else void = if (builtin.is_test) 0 else {},
    state: enum { method, method_sp, url, url_sp, version, version_cr, line_lf, line, name, value_ows, value, value_lf, end_lf } = .method,
    /// Bytes of the current method, URL, version, name or value.
    len: usize = 0,
    method: [16]u8 = undefined,
    /// Methods (bit i: `methods.keys()[i]`) the method bytes so far are a prefix of.
    method_mask: u64 = (@as(u64, 1) << method_count) - 1,
    major: u8 = 0,
    /// The first bytes of the current header name (llhttp's special names).
    name: [17]u8 = undefined,
    /// Where the URL is in llhttp's grammar (`validUrl`'s, byte by byte).
    url_at: enum { start, schema, slash1, slash2, server, path } = .start,
    counted: usize = 0,

    /// Node's glue: a finished (or, at the input's end, partial) span adds
    /// its bytes; reaching the limit is HPE_HEADER_OVERFLOW.
    fn count(self: *HeadScanner, n: usize) HeadError!void {
        self.counted += n;
        if (self.counted >= max_header_bytes) return error.HeaderOverflow;
    }

    /// `bytes` is the head from its first byte, extended since the last call
    /// (the same prefix); the result is as for `scanHead(bytes)`.
    pub fn scan(self: *HeadScanner, bytes: []const u8) HeadError!Scan {
        // The common case: the whole head in the first read, too short to reach
        // the size limit. Stepping it would give the same verdict as finding
        // its end by llhttp's line rules and letting `parseHead` check its
        // bytes, which it does anyway; only a head still arriving needs the
        // byte-wise checks (parse diff: one-shot = this, split = stepping).
        if (self.scanned == 0) if (try wholeHead(bytes)) |end| return .{ .complete = end };
        while (self.scanned < bytes.len) {
            // Inside a span, runs of bytes that only extend it are taken in bulk
            // (vectorised for values and paths); `step` sees the byte that ends
            // or breaks the span. Same states and counts as stepping each byte.
            const rest = bytes[self.scanned..];
            const run: usize = switch (self.state) {
                .value => valueRun(rest),
                .url => if (self.url_at == .path) pathRun(rest) else 0,
                .name => self.nameRun(rest),
                else => 0,
            };
            if (run > 0) {
                self.scanned += run;
                self.len += run;
                if (builtin.is_test) self.stepped += run;
                continue;
            }
            const b = bytes[self.scanned];
            self.scanned += 1;
            if (builtin.is_test) self.stepped += 1;
            if (try self.step(b)) return .{ .complete = self.scanned };
        }
        // Node's glue counts the partial span at the end of each read; the
        // span keeps growing, so the check does not add it to `counted`.
        switch (self.state) {
            .url, .name, .value => if (self.counted + self.len >= max_header_bytes) return error.HeaderOverflow,
            else => {},
        }
        return .incomplete;
    }

    /// Token bytes extending the current header name (the first 17 kept for
    /// `specialName`).
    fn nameRun(self: *HeadScanner, bytes: []const u8) usize {
        var i: usize = 0;
        while (i < bytes.len and token_table[bytes[i]]) : (i += 1) {
            if (self.len + i < self.name.len) self.name[self.len + i] = bytes[i];
        }
        return i;
    }

    fn specialName(self: *const HeadScanner) bool {
        if (self.len > self.name.len) return false;
        for ([_][]const u8{ "connection", "content-length", "proxy-connection", "transfer-encoding", "upgrade" }) |special|
            if (std.ascii.eqlIgnoreCase(self.name[0..self.len], special)) return true;
        return false;
    }

    /// True when `b` ends the head.
    fn step(self: *HeadScanner, b: u8) HeadError!bool {
        switch (self.state) {
            // llhttp validates the method byte by byte.
            .method => {
                if (b == ' ') {
                    if (self.method_mask & method_len_masks[self.len] == 0) return error.BadRequest;
                    self.state = .method_sp;
                    // CONNECT carries an authority-form target: llhttp starts it
                    // as an absolute URL's server part (measured).
                    if (std.mem.eql(u8, self.method[0..self.len], "CONNECT")) self.url_at = .server;
                    return false;
                }
                if (self.len == self.method.len) return error.BadRequest;
                self.method_mask &= method_char_masks[self.len][b];
                if (self.method_mask == 0) return error.BadRequest;
                self.method[self.len] = b;
                self.len += 1;
            },
            .method_sp, .url => {
                if (b == ' ' and self.state == .method_sp) return false;
                if (self.state == .method_sp) {
                    self.state = .url;
                    self.len = 0;
                }
                // llhttp (Node 26.12.1, measured): the URL fails at its first
                // byte outside the grammar; a space after an incomplete
                // scheme fails; a CR after a server or path is a request
                // line with no version (HTTP/0.9: headers follow, and
                // `parseHead` rejects the line).
                const ends = b == ' ' or b == '\r';
                const ok = switch (self.url_at) {
                    .start => b == '/' or b == '*' or std.ascii.isAlphabetic(b),
                    .schema => b == ':' or std.ascii.isAlphabetic(b),
                    .slash1, .slash2 => b == '/',
                    .server => ends or b == '/' or b == '?' or serverChar(b),
                    .path => ends or (b > ' ' and b < 0x7f),
                };
                if (!ok) return error.BadRequest;
                if (ends) {
                    try self.count(self.len);
                    self.state = if (b == ' ') .url_sp else .line_lf;
                    return false;
                }
                self.url_at = switch (self.url_at) {
                    .start => if (std.ascii.isAlphabetic(b)) .schema else .path,
                    .schema => if (b == ':') .slash1 else .schema,
                    .slash1 => .slash2,
                    .slash2 => .server,
                    .server => if (b == '/' or b == '?') .path else .server,
                    .path => self.url_at,
                };
                self.len += 1;
            },
            .url_sp, .version => {
                if (b == ' ' and self.state == .url_sp) return false;
                if (self.state == .url_sp) {
                    self.state = .version;
                    self.len = 0;
                }
                // "HTTP/" DIGIT "." DIGIT, a supported version.
                const ok = switch (self.len) {
                    0...4 => b == "HTTP/"[self.len],
                    5 => b >= '0' and b <= '2',
                    6 => b == '.',
                    7 => switch (self.major) {
                        '0' => b == '9',
                        '1' => b == '0' or b == '1',
                        else => b == '0',
                    },
                    else => unreachable,
                };
                if (!ok) return error.BadRequest;
                if (self.len == 5) self.major = b;
                self.len += 1;
                if (self.len == 8) self.state = .version_cr;
            },
            .version_cr => {
                if (b != '\r') return error.BadRequest;
                self.state = .line_lf;
            },
            .line_lf, .value_lf, .end_lf => {
                if (b != '\n') return error.BadRequest;
                if (self.state == .end_lf) return true;
                self.state = .line;
            },
            .line, .name => {
                if (b == '\r' and self.state == .line) {
                    self.state = .end_lf;
                    return false;
                }
                if (self.state == .line) {
                    self.state = .name;
                    self.len = 0;
                }
                if (b == ':') {
                    if (self.len == 0) return error.BadRequest;
                    try self.count(self.len);
                    self.state = .value_ows;
                    self.len = 0;
                    return false;
                }
                if (!isToken(b)) {
                    // llhttp ends one of its special names' span at a SP before
                    // the whitespace error, so Node's glue counts it first; any
                    // other bad byte fails mid-span, uncounted (Node 26.12.1).
                    if (b == ' ' and self.specialName()) try self.count(self.len);
                    return error.BadRequest;
                }
                if (self.len < self.name.len) self.name[self.len] = b;
                self.len += 1;
            },
            .value_ows, .value => {
                if (b == '\r') {
                    try self.count(self.len);
                    self.state = .value_lf;
                    return false;
                }
                if ((b < ' ' and b != '\t') or b == 0x7f) {
                    // A value's span ends at any byte outside it, then fails:
                    // its bytes count first (Node 26.12.1).
                    if (self.state == .value) try self.count(self.len);
                    return error.BadRequest;
                }
                if (self.state == .value_ows) {
                    if (b == ' ' or b == '\t') return false;
                    self.state = .value;
                }
                self.len += 1;
            },
        }
        return false;
    }
};

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
    if (!(if (connect) validConnectUrl(url) else validUrl(url))) return error.BadRequest;
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
            // `chunked` may appear once, and only as the final coding. llhttp
            // (Node 26.12.1, measured): whitespace before a coding is skipped
            // (SP or HTAB), but after `chunked` only SP may follow; a HTAB
            // there ("chunked\t") makes it not chunked (an invalid
            // Transfer-Encoding), so the raw value is used, not `value`.
            var codings = std.mem.splitScalar(u8, std.mem.trimLeft(u8, line[colon + 1 ..], " \t"), ',');
            while (codings.next()) |coding| {
                if (chunked) return error.BadRequest;
                const token = std.mem.trimRight(u8, std.mem.trimLeft(u8, coding, " \t"), " ");
                if (std.ascii.eqlIgnoreCase(token, "chunked")) chunked = true;
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

/// The end of a head wholly in `bytes` and under the size limit (so no
/// overflow can come first), or null; a LF not after CR fails, as llhttp.
fn wholeHead(bytes: []const u8) HeadError!?usize {
    const window = bytes[0..@min(bytes.len, max_header_bytes)];
    var at: usize = 0;
    while (std.mem.indexOfScalarPos(u8, window, at, '\n')) |lf| : (at = lf + 1) {
        if (lf == 0 or window[lf - 1] != '\r') return error.BadRequest;
        // CRLF after a CRLF (whose LF was checked above): the blank line.
        if (lf >= 2 and window[lf - 2] == '\n') return lf + 1;
    }
    return null;
}

/// A byte of an absolute URL's authority (llhttp, as `validUrl`).
fn serverChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "-_.!~*'()%;:&=+$,[]@", c) != null;
}

/// CONNECT's target as llhttp reads it: an authority (`serverChar`), and
/// after a '/' or '?' path bytes (0x21..0x7e), as `HeadScanner` checks it.
fn validConnectUrl(url: []const u8) bool {
    if (url.len == 0) return false;
    for (url, 0..) |c, i| {
        if (c == '/' or c == '?') {
            for (url[i..]) |p| if (p <= ' ' or p >= 0x7f) return false;
            return true;
        }
        if (!serverChar(c)) return false;
    }
    return true;
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
        if (!serverChar(c)) return false;
    }
    return true;
}

/// llhttp validates the method byte by byte, failing before the line ends:
/// `method_char_masks[i][b]` has bit j when method j has byte b at index i,
/// and `method_len_masks[n]` when method j is n bytes long.
const method_count = methods.keys().len;
const method_char_masks: [16][256]u64 = blk: {
    @setEvalBranchQuota(200_000);
    var t = [_][256]u64{[_]u64{0} ** 256} ** 16;
    for (methods.keys(), 0..) |m, j| {
        for (m, 0..) |c, i| t[i][c] |= @as(u64, 1) << j;
    }
    break :blk t;
};
const method_len_masks: [17]u64 = blk: {
    var t = [_]u64{0} ** 17;
    for (methods.keys(), 0..) |m, j| t[m.len] |= @as(u64, 1) << j;
    break :blk t;
};

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
        // An empty name is accepted, but not a line ending right after ';'
        // (llhttp 9.4.3, measured: "5;=x", "5;;b" valid; "5;", "5;a;" not).
        if (i == line.len) return null;
        while (i < line.len and isToken(line[i])) i += 1;
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

/// A chunk-size line's bytes so far (no LF yet): false once no ending could
/// make it valid, as llhttp fails at that byte instead of waiting for the
/// line (HPE_INVALID_CHUNK_SIZE, HPE_STRICT). Mirrors `parseChunkSize`.
pub fn chunkSizePrefixValid(p: []const u8) bool {
    if (p.len > 0 and p[p.len - 1] == '\r') return parseChunkSize(p[0 .. p.len - 1]) != null;
    var i: usize = 0;
    var size: u64 = 0;
    while (i < p.len) : (i += 1) {
        const digit = std.fmt.charToDigit(p[i], 16) catch break;
        size = std.math.mul(u64, size, 16) catch return false;
        size = std.math.add(u64, size, digit) catch return false;
    }
    if (i == p.len) return true;
    if (i == 0) return false;
    while (i < p.len) {
        if (p[i] != ';') return false;
        i += 1;
        while (i < p.len and isToken(p[i])) i += 1;
        if (i == p.len) return true;
        if (p[i] == '=') {
            i += 1;
            if (i == p.len) return true;
            if (p[i] == '"') {
                i += 1;
                while (true) {
                    if (i >= p.len) return true;
                    const c = p[i];
                    i += 1;
                    if (c == '"') break;
                    if (c == '\\') {
                        if (i >= p.len) return true;
                        i += 1;
                    } else if ((c < ' ' and c != '\t') or c == 0x7f) return false;
                }
            } else {
                while (i < p.len and isToken(p[i])) i += 1;
            }
        }
    }
    return true;
}

/// A trailer line's bytes so far (no LF yet), as `chunkSizePrefixValid`:
/// the blank line's CR, or a field line by `validTrailer`'s rules.
pub fn trailerPrefixValid(p: []const u8) bool {
    if (p.len == 0) return true;
    if (p[p.len - 1] == '\r') return p.len == 1 or validTrailer(p[0 .. p.len - 1]);
    const colon = std.mem.indexOfScalar(u8, p, ':') orelse {
        for (p) |c| if (!isToken(c)) return false;
        return true;
    };
    if (colon == 0) return false;
    for (p[0..colon]) |c| if (!isToken(c)) return false;
    for (p[colon + 1 ..]) |c| if ((c < ' ' and c != '\t') or c == 0x7f) return false;
    return true;
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
    return token_table[c];
}

const token_table: [256]bool = blk: {
    @setEvalBranchQuota(20_000);
    var t = [_]bool{false} ** 256;
    for (0..256) |c| t[c] = std.ascii.isAlphanumeric(@intCast(c)) or std.mem.indexOfScalar(u8, "!#$%&'*+.^_`|~-", @intCast(c)) != null;
    break :blk t;
};

const Lanes = @Vector(16, u8);

/// Leading bytes that only extend a header value: HTAB, SP..0x7e, 0x80..0xff.
fn valueRun(bytes: []const u8) usize {
    var i: usize = 0;
    while (i + 16 <= bytes.len) : (i += 16) {
        const v: Lanes = bytes[i..][0..16].*;
        const ctl: u16 = @bitCast(v < @as(Lanes, @splat(0x20)));
        const tab: u16 = @bitCast(v == @as(Lanes, @splat('\t')));
        const del: u16 = @bitCast(v == @as(Lanes, @splat(0x7f)));
        const stop = (ctl & ~tab) | del;
        if (stop != 0) return i + @ctz(stop);
    }
    while (i < bytes.len) : (i += 1) {
        const c = bytes[i];
        if ((c < ' ' and c != '\t') or c == 0x7f) return i;
    }
    return i;
}

/// Leading bytes that only extend a URL path: 0x21..0x7e.
fn pathRun(bytes: []const u8) usize {
    var i: usize = 0;
    while (i + 16 <= bytes.len) : (i += 16) {
        const v: Lanes = bytes[i..][0..16].*;
        const low: u16 = @bitCast(v < @as(Lanes, @splat(0x21)));
        const high: u16 = @bitCast(v > @as(Lanes, @splat(0x7e)));
        const stop = low | high;
        if (stop != 0) return i + @ctz(stop);
    }
    while (i < bytes.len) : (i += 1) {
        const c = bytes[i];
        if (c <= ' ' or c >= 0x7f) return i;
    }
    return i;
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

test "Transfer-Encoding codings follow llhttp's token rules (Node 26.12.1)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const framing = struct {
        fn f(alloc: std.mem.Allocator, te: []const u8) HeadError!Framing {
            const head = try std.fmt.allocPrint(alloc, "POST / HTTP/1.1\r\nTransfer-Encoding: {s}\r\n\r\n", .{te});
            return (try parseHead(alloc, head)).framing;
        }
    }.f;
    // Chunked (measured: body read).
    for ([_][]const u8{ "chunked", "Chunked", "CHUNKED", "\tchunked", "chunked ", "chunked  ", ",chunked", "gzip ,chunked", "gzip,\tchunked", "gzip\t,chunked", "gzip,,chunked", "gzip;q=1, chunked", "gzip, chunked " }) |te|
        try std.testing.expectEqual(Framing.chunked, try framing(a, te));
    // Not chunked (measured: HPE_INVALID_TRANSFER_ENCODING after the head).
    for ([_][]const u8{ "chunked\t", "chunked \t", "chunked\t ", "gzip,chunked\t", "chunked;x=1", "xchunked", "chunkedx", "gzip" }) |te|
        try std.testing.expectEqual(Framing.invalid_te, try framing(a, te));
    // A coding after chunked fails inside the head (measured).
    for ([_][]const u8{ "chunked,", "chunked, chunked", "chunked, gzip" }) |te|
        try std.testing.expectError(error.BadRequest, framing(a, te));
}

test "scanHead fails at the first invalid byte, before the head completes, and before a later overflow" {
    const E = error.BadRequest;
    // Incomplete heads that no continuation could make valid (llhttp: at once).
    try std.testing.expectError(E, scanHead("GET / HTTP/1.1\r\nHost: a\r\n\x00"));
    try std.testing.expectError(E, scanHead("GET / HTTP/1.0\r,"));
    try std.testing.expectError(E, scanHead("GET /a\x7f"));
    try std.testing.expectError(E, scanHead("GET / http/1.1"));
    try std.testing.expectError(E, scanHead("GET / HTTP/1.2"));
    try std.testing.expectError(E, scanHead("GET / HTTP/1.1\r\nX y"));
    try std.testing.expectError(E, scanHead("GET / HTTP/1.1\r\n: y"));
    try std.testing.expectError(E, scanHead("GET / HTTP/1.1\r\nX: a\rb"));
    // The URL fails at its first byte outside llhttp's grammar (measured, Node 26.12.1).
    for ([_][]const u8{ "GET ?", "GET 1", "GET %", "GET a ", "GET a\r", "GET a:/ ", "GET http:/a", "GET http:/\r", "GET h-", "GET http://a#", "GET http://a{", "GET /\x01", "GET /a\x80", "GET /a\x7f", "CONNECT a\x01", "CONNECT {", "CONNECT a#" }) |prefix|
        try std.testing.expectError(E, scanHead(prefix));
    for ([_][]const u8{ "GET a", "GET a:/", "GET http:/", "GET http://a@b@c/", "GET *x", "CONNECT ?", "CONNECT %", "CONNECT a/{", "CONNECT [::1]:1" }) |prefix|
        try std.testing.expectEqual(Scan.incomplete, try scanHead(prefix));
    // A request line with no version (HTTP/0.9): headers follow; `parseHead` rejects it.
    try std.testing.expectEqual(Scan.incomplete, try scanHead("GET /x\r\nHost: a\r\n"));
    try std.testing.expectEqual(Scan{ .complete = 15 }, try scanHead("GET http://\r\n\r\n"));
    // Still valid prefixes wait.
    try std.testing.expectEqual(Scan.incomplete, try scanHead("GET / HTTP/1."));
    try std.testing.expectEqual(Scan.incomplete, try scanHead("GET / HTTP/1.1\r\nX: a b\t"));
    // Precedence: a syntax error before the size limit is reached is a 400 ...
    var big: [max_header_bytes + 64]u8 = undefined;
    const prefix = "GET / HTTP/9.9\r\nX: ";
    @memcpy(big[0..prefix.len], prefix);
    @memset(big[prefix.len..], 'b');
    try std.testing.expectError(E, scanHead(&big));
    @memcpy(big[0..prefix.len], "POST ?x HTTP/1.1\r\nX");
    try std.testing.expectError(E, scanHead(&big));
    // ... and an overflow reached first (a long value ends) is a 431, whatever follows.
    var big2: [max_header_bytes + 64]u8 = undefined;
    const p2 = "GET / HTTP/1.1\r\nX: ";
    @memcpy(big2[0..p2.len], p2);
    @memset(big2[p2.len..], 'b');
    @memcpy(big2[big2.len - 8 ..], "\r\n\x00: y\r\n");
    try std.testing.expectError(error.HeaderOverflow, scanHead(&big2));
    // Which spans cut short by a bad byte still count (Node 26.12.1): a value's,
    // and a special name's before a SP; other names' and the URL's do not. The
    // head before the tail holds 16,369 counted bytes.
    for ([_]struct { []const u8, HeadError }{
        .{ "\r\nTransfer-Encoding chunked", error.HeaderOverflow },
        .{ "\r\nTRANSFER-ENCODING chunked", error.HeaderOverflow },
        .{ "\r\nX-Transfer-Encodi chunked", error.BadRequest },
        .{ "\r\nTransfer-Encoding\x0bchunked", error.BadRequest },
        .{ "\r\nY: cccccccccccccccc\x0b", error.HeaderOverflow },
        .{ "\r\nY: cccccccccccccccc\n", error.HeaderOverflow },
    }) |case| {
        var big3: [max_header_bytes + 64]u8 = undefined;
        @memcpy(big3[0..p2.len], p2);
        @memset(big3[p2.len..], 'b');
        @memcpy(big3[max_header_bytes + 2 ..][0..case[0].len], case[0]);
        try std.testing.expectError(case[1], scanHead(big3[0 .. max_header_bytes + 2 + case[0].len]));
    }
}

test "HeadScanner resumes across reads: a head fed one byte per read is stepped once per byte, with scanHead's results" {
    var buf: [max_header_bytes + 64]u8 = undefined;
    const head_start = "GET / HTTP/1.1\r\nX: ";
    @memcpy(buf[0..head_start.len], head_start);
    const tail = "\r\n\r\n";
    const len = max_header_bytes - 64;
    @memset(buf[head_start.len .. len - tail.len], 'b');
    @memcpy(buf[len - tail.len .. len], tail);
    var v: HeadScanner = .{};
    for (1..len) |n| try std.testing.expectEqual(Scan.incomplete, try v.scan(buf[0..n]));
    try std.testing.expectEqual(Scan{ .complete = len }, try v.scan(buf[0..len]));
    try std.testing.expectEqual(@as(usize, len), v.stepped);
    try std.testing.expectEqual(Scan{ .complete = len }, try scanHead(buf[0..len]));
    // The whole head in one read: found by its lines, nothing stepped.
    var whole: HeadScanner = .{};
    try std.testing.expectEqual(Scan{ .complete = len }, try whole.scan(buf[0..len]));
    try std.testing.expectEqual(@as(usize, 0), whole.stepped);
    // The partial-span overflow check at a read's end does not count twice:
    // a long value split over many reads overflows where one read would.
    @memset(buf[head_start.len..], 'b');
    var w: HeadScanner = .{};
    var at: usize = head_start.len;
    var first_error: ?HeadError = null;
    while (at <= buf.len) : (at += 1) {
        _ = w.scan(buf[0..at]) catch |e| {
            first_error = e;
            break;
        };
    }
    try std.testing.expectEqual(@as(?HeadError, error.HeaderOverflow), first_error);
    try std.testing.expectError(error.HeaderOverflow, scanHead(buf[0..at]));
    try std.testing.expectEqual(Scan.incomplete, try scanHead(buf[0 .. at - 1]));
}

test "chunk framing lines fail at the first byte no line could accept (llhttp)" {
    // Measured on Node 26.12.1 (llhttp 9.4.3), as prefixes or as whole lines.
    for ([_][]const u8{ "", "5", "fF", "5;", "5;a", "5;a=", "5;a=b", "5;a=\"x", "5;a=\"x\\", "5;a=\"x\";b", "5\r", "0\r", "5;a=b\r", "ffffffffffffffff", "5;=", "5;=x\r", "5;;b\r", "5;=;b\r", "5;a=;b\r", "5;a=\r", "5;=\"x\"\r" }) |p|
        try std.testing.expect(chunkSizePrefixValid(p));
    for ([_][]const u8{ "\r", "x", "\x00", "5 ", "5x", "5;\r", "5;;\r", "5;a;\r", "5;=;\r", "5;a=b=", "5;a==", "5;a=\"x\"y", "5;\"", "5;a b", "5;a=\"\x01", "5\rx", "10000000000000000" }) |p|
        try std.testing.expect(!chunkSizePrefixValid(p));
    try std.testing.expectEqual(@as(?u64, 5), parseChunkSize("5;=x"));
    try std.testing.expectEqual(@as(?u64, null), parseChunkSize("5;a;"));
    for ([_][]const u8{ "", "\r", "X", "X-Y", "X:", "X: y", "X:\ty z", "X: y\r" }) |p|
        try std.testing.expect(trailerPrefixValid(p));
    for ([_][]const u8{ "\rx", "\r,", ":", "X y", "X: \x00", "X\r", "\x00" }) |p|
        try std.testing.expect(!trailerPrefixValid(p));
}

test "a whole head's verdict is the stepped one: the line rules here, the rest in parseHead" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Bare LF fails in the line search itself.
    try std.testing.expectError(error.BadRequest, scanHead("GET / HTTP/1.1\nHost: a\r\n\r\n"));
    try std.testing.expectError(error.BadRequest, scanHead("GET / HTTP/1.1\r\nX: a\nb\r\n\r\n"));
    // Byte rules stepping enforces, left to parseHead for a whole head.
    for ([_][]const u8{
        "CONNECT { HTTP/1.1\r\n\r\n",
        "CONNECT a# HTTP/1.1\r\n\r\n",
        "GET ?x HTTP/1.1\r\n\r\n",
        "GET / HTTP/1.1\r\nX: a\r\n b\r\n\r\n",
        "GET / HTTP/1.1\r\nX y: a\r\n\r\n",
        "GET / HTTP/1.1\r\nX: a\x00\r\n\r\n",
        "GET / HTTP/1.1 \r\n\r\n",
        "GET /x\r\nHost: a\r\n\r\n",
    }) |head| {
        const end = switch (try scanHead(head)) {
            .complete => |n| n,
            .incomplete => return error.TestUnexpectedResult,
        };
        try std.testing.expectError(error.BadRequest, parseHead(a, head[0..end]));
        // Stepped (as when the head arrives in parts): a 400 at the bad byte,
        // or (HTTP/0.9's versionless line) the same head for parseHead.
        var v: HeadScanner = .{};
        _ = try v.scan(head[0..1]);
        if (v.scan(head)) |r| {
            try std.testing.expectEqual(Scan{ .complete = end }, r);
        } else |e| try std.testing.expectEqual(error.BadRequest, e);
    }
    _ = try parseHead(a, "CONNECT [::1]:1 HTTP/1.1\r\n\r\n");
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
        .{ "a", 10 },        .{ "A", 10 },            .{ "000a", 10 },                 .{ "a;x=1", 10 },
        .{ "a;x", 10 },      .{ "a;x=", 10 },         .{ "a;x=1;y=2", 10 },            .{ "a;x=\"q\\\"z\"", 10 },
        .{ "+a", null },     .{ "1_0", null },        .{ "a ", null },                 .{ " a", null },
        .{ "a ;x=1", null }, .{ "a;", null },         .{ "a; x=1", null },             .{ "a;x =1", null },
        .{ "a;x= 1", null }, .{ "a;x=\"open", null }, .{ "a;x=1 ", null },             .{ "a\t", null },
        .{ "a;x=@", null },  .{ "0xa", null },        .{ "ffffffffffffffffff", null }, .{ "", null },
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
