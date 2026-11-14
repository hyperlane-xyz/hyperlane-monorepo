//! graphql-js 16 lexer port. Operates on UTF-8 bytes; error texts match
//! graphql-js (`Syntax Error: ` prefix is added by the parser's error sink).
const std = @import("std");

pub const TokenKind = enum {
    sof,
    eof,
    bang,
    dollar,
    amp,
    paren_l,
    paren_r,
    spread,
    colon,
    equals,
    at,
    bracket_l,
    bracket_r,
    brace_l,
    pipe,
    brace_r,
    name,
    int,
    float,
    string,
    block_string,
    comment,

    /// graphql-js `getTokenKindDesc`.
    pub fn desc(self: TokenKind) []const u8 {
        return switch (self) {
            .sof => "<SOF>",
            .eof => "<EOF>",
            .bang => "\"!\"",
            .dollar => "\"$\"",
            .amp => "\"&\"",
            .paren_l => "\"(\"",
            .paren_r => "\")\"",
            .spread => "\"...\"",
            .colon => "\":\"",
            .equals => "\"=\"",
            .at => "\"@\"",
            .bracket_l => "\"[\"",
            .bracket_r => "\"]\"",
            .brace_l => "\"{\"",
            .pipe => "\"|\"",
            .brace_r => "\"}\"",
            .name => "Name",
            .int => "Int",
            .float => "Float",
            .string => "String",
            .block_string => "BlockString",
            .comment => "Comment",
        };
    }

    pub fn hasValue(self: TokenKind) bool {
        return switch (self) {
            .name, .int, .float, .string, .block_string, .comment => true,
            else => false,
        };
    }
};

pub const Token = struct {
    kind: TokenKind,
    start: u32,
    end: u32,
    /// Cooked value for names/numbers/strings (arena-owned or a source slice).
    value: []const u8 = "",
};

pub const Error = error{ SyntaxError, OutOfMemory };

pub const Diagnostic = struct {
    message: []const u8 = "",
    offset: u32 = 0,
    /// The failure is TS's V8 stack overflow (RangeError: no location),
    /// emulated by the parser's nesting budget (parser.zig `stack_budget`).
    stack_overflow: bool = false,
};

pub const Lexer = struct {
    source: []const u8,
    arena: std.mem.Allocator,
    diag: *Diagnostic,
    token: Token = .{ .kind = .sof, .start = 0, .end = 0 },
    last_token: Token = .{ .kind = .sof, .start = 0, .end = 0 },
    /// One token of lookahead buffered by `lookahead()`.
    peeked: ?Token = null,

    pub fn init(arena: std.mem.Allocator, source: []const u8, diag: *Diagnostic) Lexer {
        return .{ .source = source, .arena = arena, .diag = diag };
    }

    pub fn advance(self: *Lexer) Error!Token {
        self.last_token = self.token;
        self.token = try self.lookahead();
        self.peeked = null;
        return self.token;
    }

    /// Next non-comment token without consuming it.
    pub fn lookahead(self: *Lexer) Error!Token {
        if (self.token.kind == .eof) return self.token;
        if (self.peeked) |t| return t;
        var pos = self.token.end;
        while (true) {
            const t = try self.readNextToken(pos);
            if (t.kind != .comment) {
                self.peeked = t;
                return t;
            }
            pos = t.end;
        }
    }

    fn fail(self: *Lexer, offset: usize, comptime fmt: []const u8, args: anytype) Error {
        self.diag.* = .{
            .message = try std.fmt.allocPrint(self.arena, "Syntax Error: " ++ fmt, args),
            .offset = @intCast(offset),
        };
        return error.SyntaxError;
    }

    fn at(self: *const Lexer, pos: usize) i32 {
        return if (pos < self.source.len) self.source[pos] else -1;
    }

    fn tok(kind: TokenKind, start: usize, end: usize) Token {
        return .{ .kind = kind, .start = @intCast(start), .end = @intCast(end) };
    }

    fn readNextToken(self: *Lexer, start: usize) Error!Token {
        const body = self.source;
        var pos = start;
        while (pos < body.len) {
            const c = body[pos];
            switch (c) {
                '\t', ' ', ',', '\n', '\r' => {
                    pos += 1;
                    continue;
                },
                0xEF => if (pos + 2 < body.len and body[pos + 1] == 0xBB and body[pos + 2] == 0xBF) {
                    pos += 3; // BOM
                    continue;
                },
                '#' => return self.readComment(pos),
                '!' => return tok(.bang, pos, pos + 1),
                '$' => return tok(.dollar, pos, pos + 1),
                '&' => return tok(.amp, pos, pos + 1),
                '(' => return tok(.paren_l, pos, pos + 1),
                ')' => return tok(.paren_r, pos, pos + 1),
                '.' => if (self.at(pos + 1) == '.' and self.at(pos + 2) == '.') return tok(.spread, pos, pos + 3),
                ':' => return tok(.colon, pos, pos + 1),
                '=' => return tok(.equals, pos, pos + 1),
                '@' => return tok(.at, pos, pos + 1),
                '[' => return tok(.bracket_l, pos, pos + 1),
                ']' => return tok(.bracket_r, pos, pos + 1),
                '{' => return tok(.brace_l, pos, pos + 1),
                '|' => return tok(.pipe, pos, pos + 1),
                '}' => return tok(.brace_r, pos, pos + 1),
                '"' => {
                    if (self.at(pos + 1) == '"' and self.at(pos + 2) == '"') return self.readBlockString(pos);
                    return self.readString(pos);
                },
                else => {},
            }
            if (isDigit(c) or c == '-') return self.readNumber(pos);
            if (isNameStart(c)) return self.readName(pos);
            if (c == '\'') return self.fail(pos, "Unexpected single quote character ('), did you mean to use a double quote (\")?", .{});
            return self.fail(pos, "Unexpected character: {f}.", .{CodePoint{ .lexer = self, .pos = pos }});
        }
        return tok(.eof, body.len, body.len);
    }

    fn readComment(self: *Lexer, start: usize) Token {
        var pos = start + 1;
        while (pos < self.source.len and self.source[pos] != '\n' and self.source[pos] != '\r') pos += 1;
        return .{ .kind = .comment, .start = @intCast(start), .end = @intCast(pos), .value = self.source[start + 1 .. pos] };
    }

    fn readNumber(self: *Lexer, start: usize) Error!Token {
        var pos = start;
        var is_float = false;
        var c = self.at(pos);
        if (c == '-') {
            pos += 1;
            c = self.at(pos);
        }
        if (c == '0') {
            pos += 1;
            c = self.at(pos);
            if (isDigitI(c)) return self.fail(pos, "Invalid number, unexpected digit after 0: {f}.", .{CodePoint{ .lexer = self, .pos = pos }});
        } else {
            pos = try self.readDigits(pos);
            c = self.at(pos);
        }
        if (c == '.') {
            is_float = true;
            pos += 1;
            pos = try self.readDigits(pos);
            c = self.at(pos);
        }
        if (c == 'E' or c == 'e') {
            is_float = true;
            pos += 1;
            c = self.at(pos);
            if (c == '+' or c == '-') pos += 1;
            pos = try self.readDigits(pos);
            c = self.at(pos);
        }
        if (c == '.' or (c >= 0 and isNameStart(@intCast(c)))) {
            return self.fail(pos, "Invalid number, expected digit but got: {f}.", .{CodePoint{ .lexer = self, .pos = pos }});
        }
        return .{ .kind = if (is_float) .float else .int, .start = @intCast(start), .end = @intCast(pos), .value = self.source[start..pos] };
    }

    fn readDigits(self: *Lexer, start: usize) Error!usize {
        if (!isDigitI(self.at(start))) {
            return self.fail(start, "Invalid number, expected digit but got: {f}.", .{CodePoint{ .lexer = self, .pos = start }});
        }
        var pos = start + 1;
        while (isDigitI(self.at(pos))) pos += 1;
        return pos;
    }

    fn readString(self: *Lexer, start: usize) Error!Token {
        const body = self.source;
        var pos = start + 1;
        var chunk_start = pos;
        var value: std.ArrayList(u8) = .empty;
        while (pos < body.len) {
            const c = body[pos];
            if (c == '"') {
                try value.appendSlice(self.arena, body[chunk_start..pos]);
                return .{ .kind = .string, .start = @intCast(start), .end = @intCast(pos + 1), .value = value.items };
            }
            if (c == '\\') {
                try value.appendSlice(self.arena, body[chunk_start..pos]);
                const size = if (self.at(pos + 1) == 'u')
                    (if (self.at(pos + 2) == '{') try self.readEscapedUnicodeVariableWidth(pos, &value) else try self.readEscapedUnicodeFixedWidth(pos, &value))
                else
                    try self.readEscapedCharacter(pos, &value);
                pos += size;
                chunk_start = pos;
                continue;
            }
            if (c == '\n' or c == '\r') break;
            pos += 1;
        }
        return self.fail(pos, "Unterminated string.", .{});
    }

    fn readEscapedUnicodeVariableWidth(self: *Lexer, pos: usize, out: *std.ArrayList(u8)) Error!usize {
        var point: i64 = 0;
        var size: usize = 3;
        while (size < 12) {
            const c = self.at(pos + size);
            size += 1;
            if (c == '}') {
                if (size < 5 or !isUnicodeScalarValue(point)) break;
                try appendCodePoint(self.arena, out, @intCast(point));
                return size;
            }
            const digit = readHexDigit(c);
            if (digit < 0) break;
            point = (point << 4) | digit;
            if (point > 0x7FFFFFFF) break; // JS `point < 0` after 32-bit overflow
        }
        return self.fail(pos, "Invalid Unicode escape sequence: \"{s}\".", .{self.source[pos..@min(pos + size, self.source.len)]});
    }

    fn readEscapedUnicodeFixedWidth(self: *Lexer, pos: usize, out: *std.ArrayList(u8)) Error!usize {
        const code = self.read16BitHexCode(pos + 2);
        if (code >= 0 and isUnicodeScalarValue(code)) {
            try appendCodePoint(self.arena, out, @intCast(code));
            return 6;
        }
        if (code >= 0xD800 and code <= 0xDBFF) {
            if (self.at(pos + 6) == '\\' and self.at(pos + 7) == 'u') {
                const trailing = self.read16BitHexCode(pos + 8);
                if (trailing >= 0xDC00 and trailing <= 0xDFFF) {
                    const cp = 0x10000 + ((code - 0xD800) << 10) + (trailing - 0xDC00);
                    try appendCodePoint(self.arena, out, @intCast(cp));
                    return 12;
                }
            }
        }
        return self.fail(pos, "Invalid Unicode escape sequence: \"{s}\".", .{self.source[pos..@min(pos + 6, self.source.len)]});
    }

    fn read16BitHexCode(self: *const Lexer, pos: usize) i64 {
        const a = readHexDigit(self.at(pos));
        const b = readHexDigit(self.at(pos + 1));
        const c = readHexDigit(self.at(pos + 2));
        const d = readHexDigit(self.at(pos + 3));
        if (a < 0 or b < 0 or c < 0 or d < 0) return -1;
        return (a << 12) | (b << 8) | (c << 4) | d;
    }

    fn readEscapedCharacter(self: *Lexer, pos: usize, out: *std.ArrayList(u8)) Error!usize {
        const ch: u8 = switch (self.at(pos + 1)) {
            '"' => '"',
            '\\' => '\\',
            '/' => '/',
            'b' => 0x08,
            'f' => 0x0C,
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            else => return self.fail(pos, "Invalid character escape sequence: \"{s}\".", .{self.source[pos..@min(pos + 2 + extraUtf8(self.source, pos + 1), self.source.len)]}),
        };
        try out.append(self.arena, ch);
        return 2;
    }

    fn readBlockString(self: *Lexer, start: usize) Error!Token {
        const body = self.source;
        var pos = start + 3;
        var chunk_start = pos;
        var current: std.ArrayList(u8) = .empty;
        var lines: std.ArrayList([]const u8) = .empty;
        while (pos < body.len) {
            const c = body[pos];
            if (c == '"' and self.at(pos + 1) == '"' and self.at(pos + 2) == '"') {
                try current.appendSlice(self.arena, body[chunk_start..pos]);
                try lines.append(self.arena, current.items);
                const value = try dedentBlockString(self.arena, lines.items);
                return .{ .kind = .block_string, .start = @intCast(start), .end = @intCast(pos + 3), .value = value };
            }
            if (c == '\\' and self.at(pos + 1) == '"' and self.at(pos + 2) == '"' and self.at(pos + 3) == '"') {
                try current.appendSlice(self.arena, body[chunk_start..pos]);
                chunk_start = pos + 1;
                pos += 4;
                continue;
            }
            if (c == '\n' or c == '\r') {
                try current.appendSlice(self.arena, body[chunk_start..pos]);
                try lines.append(self.arena, current.items);
                current = .empty;
                pos += if (c == '\r' and self.at(pos + 1) == '\n') 2 else 1;
                chunk_start = pos;
                continue;
            }
            pos += 1;
        }
        return self.fail(pos, "Unterminated string.", .{});
    }

    fn readName(self: *Lexer, start: usize) Token {
        var pos = start + 1;
        while (pos < self.source.len and isNameContinue(self.source[pos])) pos += 1;
        return .{ .kind = .name, .start = @intCast(start), .end = @intCast(pos), .value = self.source[start..pos] };
    }
};

/// graphql-js `printCodePointAt`.
pub const CodePoint = struct {
    lexer: *const Lexer,
    pos: usize,

    pub fn format(self: CodePoint, w: *std.Io.Writer) std.Io.Writer.Error!void {
        const src = self.lexer.source;
        if (self.pos >= src.len) return w.writeAll("<EOF>");
        const cp = decodeAt(src, self.pos);
        if (cp >= 0x20 and cp <= 0x7E) {
            if (cp == '"') return w.writeAll("'\"'");
            return w.print("\"{c}\"", .{@as(u8, @intCast(cp))});
        }
        return w.print("U+{X:0>4}", .{cp});
    }
};

fn extraUtf8(src: []const u8, pos: usize) usize {
    if (pos >= src.len) return 0;
    const len = std.unicode.utf8ByteSequenceLength(src[pos]) catch return 0;
    return len - 1;
}

fn decodeAt(src: []const u8, pos: usize) u21 {
    const len = std.unicode.utf8ByteSequenceLength(src[pos]) catch return 0xFFFD;
    if (pos + len > src.len) return 0xFFFD;
    return std.unicode.utf8Decode(src[pos .. pos + len]) catch 0xFFFD;
}

fn appendCodePoint(arena: std.mem.Allocator, out: *std.ArrayList(u8), cp: u21) !void {
    var buf: [4]u8 = undefined;
    const n = std.unicode.utf8Encode(cp, &buf) catch unreachable;
    try out.appendSlice(arena, buf[0..n]);
}

fn isUnicodeScalarValue(code: i64) bool {
    return (code >= 0 and code <= 0xD7FF) or (code >= 0xE000 and code <= 0x10FFFF);
}

fn readHexDigit(c: i32) i64 {
    return switch (c) {
        '0'...'9' => c - '0',
        'A'...'F' => c - 'A' + 10,
        'a'...'f' => c - 'a' + 10,
        else => -1,
    };
}

pub fn isDigit(c: u8) bool {
    return c >= '0' and c <= '9';
}

fn isDigitI(c: i32) bool {
    return c >= '0' and c <= '9';
}

pub fn isNameStart(c: u8) bool {
    return (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c == '_';
}

pub fn isNameContinue(c: u8) bool {
    return isNameStart(c) or isDigit(c);
}

fn isWhiteSpace(c: u8) bool {
    return c == ' ' or c == '\t';
}

/// graphql-js `dedentBlockStringLines` joined with "\n".
pub fn dedentBlockString(arena: std.mem.Allocator, lines: []const []const u8) ![]const u8 {
    var common: usize = std.math.maxInt(usize);
    var first_non_empty: ?usize = null;
    var last_non_empty: usize = 0;
    for (lines, 0..) |line, i| {
        var indent: usize = 0;
        while (indent < line.len and isWhiteSpace(line[indent])) indent += 1;
        if (indent == line.len) continue; // skip empty lines
        if (first_non_empty == null) first_non_empty = i;
        last_non_empty = i;
        if (i != 0 and indent < common) common = indent;
    }
    const first = first_non_empty orelse return "";
    var out: std.ArrayList(u8) = .empty;
    for (lines[first .. last_non_empty + 1], first..) |line, i| {
        if (i != first) try out.append(arena, '\n');
        if (i == 0 or common == std.math.maxInt(usize)) {
            try out.appendSlice(arena, line);
        } else {
            try out.appendSlice(arena, line[@min(common, line.len)..]);
        }
    }
    return out.items;
}

test "lexer basics" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    var lx = Lexer.init(arena_state.allocator(), "{ a: \"x\\u00e9\\u{1F600}\" -1.5e3 # c\n }", &diag);
    try std.testing.expectEqual(TokenKind.brace_l, (try lx.advance()).kind);
    try std.testing.expectEqualStrings("a", (try lx.advance()).value);
    _ = try lx.advance();
    try std.testing.expectEqualStrings("x\xc3\xa9\xf0\x9f\x98\x80", (try lx.advance()).value);
    const f = try lx.advance();
    try std.testing.expectEqual(TokenKind.float, f.kind);
    try std.testing.expectEqual(TokenKind.brace_r, (try lx.advance()).kind);
    try std.testing.expectEqual(TokenKind.eof, (try lx.advance()).kind);
}

test "lexer errors" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const cases = [_]struct { src: []const u8, msg: []const u8 }{
        .{ .src = "?", .msg = "Syntax Error: Unexpected character: \"?\"." },
        .{ .src = "'", .msg = "Syntax Error: Unexpected single quote character ('), did you mean to use a double quote (\")?" },
        .{ .src = "\xf0\x9f\x98\x80", .msg = "Syntax Error: Unexpected character: U+1F600." },
        .{ .src = "01", .msg = "Syntax Error: Invalid number, unexpected digit after 0: \"1\"." },
        .{ .src = "1a", .msg = "Syntax Error: Invalid number, expected digit but got: \"a\"." },
        .{ .src = "1.", .msg = "Syntax Error: Invalid number, expected digit but got: <EOF>." },
        .{ .src = "\"abc", .msg = "Syntax Error: Unterminated string." },
        .{ .src = "\"\\x\"", .msg = "Syntax Error: Invalid character escape sequence: \"\\x\"." },
        .{ .src = "\"\\u12\"", .msg = "Syntax Error: Invalid Unicode escape sequence: \"\\u12\"\"." },
        .{ .src = "\"", .msg = "Syntax Error: Unterminated string." },
        .{ .src = "\"\"\"abc", .msg = "Syntax Error: Unterminated string." },
        .{ .src = "\x07", .msg = "Syntax Error: Unexpected character: U+0007." },
    };
    for (cases) |case| {
        var diag: Diagnostic = .{};
        var lx = Lexer.init(arena_state.allocator(), case.src, &diag);
        try std.testing.expectError(error.SyntaxError, lx.advance());
        try std.testing.expectEqualStrings(case.msg, diag.message);
    }
}

test "block string dedent" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    var lx = Lexer.init(arena_state.allocator(), "\"\"\"\n    hello\n      world\n\n  \"\"\"", &diag);
    try std.testing.expectEqualStrings("hello\n  world", (try lx.advance()).value);
}
