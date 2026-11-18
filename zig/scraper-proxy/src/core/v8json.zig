//! V8 `JSON.parse` SyntaxError messages (Node 26) for text that fails to
//! parse: GraphQL GET `variables`/`extensions` (mercurius `tryJSONParse`
//! surfaces `err.message`) and /validators client frames (`JSON.parse` in
//! `parseValidatorPing`). Positions are UTF-16 indices.
const std = @import("std");

const Allocator = std.mem.Allocator;

/// JS string length (UTF-16 code units) of UTF-8 `bytes`.
pub fn utf16Length(bytes: []const u8) u32 {
    var n: u32 = 0;
    for (bytes) |b| {
        if (b & 0xC0 != 0x80) n += 1; // lead or ASCII byte
        if (b >= 0xF0) n += 1; // supplementary plane -> surrogate pair
    }
    return n;
}

const SourceLocation = struct { line: u32, column: u32 };

const max_context = 10;
const min_source_for_context = max_context * 2 + 1;

pub fn errorMessage(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var s: Scanner = .{ .s = text, .a = a };
    s.parseTop() catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.Invalid => return s.message,
    };
    return "Unexpected end of JSON input"; // not reached for invalid input
}

const Scanner = struct {
    s: []const u8,
    i: usize = 0,
    a: Allocator,
    message: []const u8 = "",

    const Err = error{ Invalid, OutOfMemory };

    fn ws(self: *Scanner) void {
        while (self.i < self.s.len and (self.s[self.i] == ' ' or self.s[self.i] == '\t' or self.s[self.i] == '\n' or self.s[self.i] == '\r')) self.i += 1;
    }

    fn atPosition(self: *Scanner, what: []const u8, pos: usize) Err {
        const p: u32 = @intCast(pos);
        const loc = lineColumn(self.s, p);
        self.message = try std.fmt.allocPrint(self.a, "{s} in JSON at position {d} (line {d} column {d})", .{ what, utf16Length(self.s[0..pos]), loc.line, loc.column });
        return error.Invalid;
    }

    /// Messages already ending in "JSON" omit the " in JSON" infix.
    fn atPositionRaw(self: *Scanner, what: []const u8, pos: usize) Err {
        const p: u32 = @intCast(pos);
        const loc = lineColumn(self.s, p);
        self.message = try std.fmt.allocPrint(self.a, "{s} at position {d} (line {d} column {d})", .{ what, utf16Length(self.s[0..pos]), loc.line, loc.column });
        return error.Invalid;
    }

    fn unexpectedEnd(self: *Scanner) Err {
        self.message = "Unexpected end of JSON input";
        return error.Invalid;
    }

    fn unexpectedToken(self: *Scanner) Err {
        if (self.i >= self.s.len) return self.unexpectedEnd();
        // V8 reports the code unit at the error: a supplementary character's
        // high surrogate alone (WTF-8 here; JSON output escapes it as \\udXXX).
        const total = utf16Length(self.s);
        const pos = utf16Length(self.s[0..self.i]);
        const token = try utf16Slice(self.a, self.s, pos, pos + 1);
        if (total < min_source_for_context) {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', \"{s}\" is not valid JSON", .{ token, self.s });
        } else if (pos < max_context) {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', \"{s}\"... is not valid JSON", .{ token, try utf16Slice(self.a, self.s, 0, pos + max_context) });
        } else if (pos < total - max_context) {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', ...\"{s}\"... is not valid JSON", .{ token, try utf16Slice(self.a, self.s, pos - max_context, pos + max_context) });
        } else {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', ...\"{s}\" is not valid JSON", .{ token, try utf16Slice(self.a, self.s, pos - max_context, total) });
        }
        return error.Invalid;
    }

    fn parseTop(self: *Scanner) Err!void {
        self.ws();
        try self.value();
        self.ws();
        if (self.i < self.s.len) return self.atPositionRaw("Unexpected non-whitespace character after JSON", self.i);
        self.message = "Unexpected end of JSON input";
        return error.Invalid;
    }

    /// One JSON value; iterative (open containers on `stack`) like V8's
    /// non-recursive JSON.parse, so nesting depth costs no call stack.
    fn value(self: *Scanner) Err!void {
        // '{' or '[' per open container.
        var stack: std.ArrayList(u8) = .empty;
        defer stack.deinit(self.a);
        value: while (true) {
            self.ws();
            if (self.i >= self.s.len) return self.unexpectedToken();
            switch (self.s[self.i]) {
                '{' => {
                    self.i += 1;
                    self.ws();
                    if (self.i < self.s.len and self.s[self.i] == '}') {
                        self.i += 1;
                    } else {
                        try stack.append(self.a, '{');
                        try self.memberKey(true);
                        continue :value;
                    }
                },
                '[' => {
                    self.i += 1;
                    self.ws();
                    if (self.i < self.s.len and self.s[self.i] == ']') {
                        self.i += 1;
                    } else {
                        try stack.append(self.a, '[');
                        continue :value;
                    }
                },
                '"' => try self.string(),
                't' => try self.literal("true"),
                'f' => try self.literal("false"),
                'n' => try self.literal("null"),
                '-', '0'...'9' => try self.number(),
                else => return self.unexpectedToken(),
            }
            // A value ended: continue or close the enclosing containers.
            while (stack.items.len > 0) {
                self.ws();
                const open = stack.items[stack.items.len - 1];
                if (self.i < self.s.len and self.s[self.i] == ',') {
                    self.i += 1;
                    if (open == '{') try self.memberKey(false);
                    continue :value;
                }
                const close: u8 = if (open == '{') '}' else ']';
                if (self.i < self.s.len and self.s[self.i] == close) {
                    self.i += 1;
                    _ = stack.pop();
                    continue;
                }
                return self.atPosition(if (open == '{') "Expected ',' or '}' after property value" else "Expected ',' or ']' after array element", self.i);
            }
            return;
        }
    }

    /// `"name":` of an object member (the value follows).
    fn memberKey(self: *Scanner, first: bool) Err!void {
        self.ws();
        if (self.i >= self.s.len or self.s[self.i] != '"') {
            if (first) return self.atPosition("Expected property name or '}'", self.i);
            return self.atPosition("Expected double-quoted property name", self.i);
        }
        try self.string();
        self.ws();
        if (self.i >= self.s.len or self.s[self.i] != ':') return self.atPosition("Expected ':' after property name", self.i);
        self.i += 1;
    }

    fn literal(self: *Scanner, word: []const u8) Err!void {
        for (word) |c| {
            if (self.i >= self.s.len) return self.unexpectedToken();
            if (self.s[self.i] != c) return self.unexpectedToken();
            self.i += 1;
        }
    }

    fn string(self: *Scanner) Err!void {
        self.i += 1; // opening quote
        while (self.i < self.s.len) {
            const c = self.s[self.i];
            if (c == '"') {
                self.i += 1;
                return;
            }
            if (c < 0x20) return self.atPosition("Bad control character in string literal", self.i);
            if (c == '\\') {
                if (self.i + 1 >= self.s.len) return self.unexpectedEnd();
                switch (self.s[self.i + 1]) {
                    '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => self.i += 2,
                    'u' => {
                        // V8 points at the first non-hex digit (or the end).
                        var k: usize = 0;
                        while (k < 4) : (k += 1) {
                            const at = self.i + 2 + k;
                            if (at >= self.s.len or !std.ascii.isHex(self.s[at])) return self.atPosition("Bad Unicode escape", at);
                        }
                        self.i += 6;
                    },
                    // A Latin-1 character (below U+0100: one byte, or a C2/C3 lead)
                    // is a bad escape; anything wider is V8's "Unexpected token".
                    else => |next| {
                        self.i += 1;
                        if (next < 0x80 or next == 0xC2 or next == 0xC3) return self.atPosition("Bad escaped character", self.i);
                        return self.unexpectedToken();
                    },
                }
                continue;
            }
            self.i += 1;
        }
        return self.atPosition("Unterminated string", self.s.len);
    }

    fn number(self: *Scanner) Err!void {
        if (self.s[self.i] == '-') {
            self.i += 1;
            if (self.i >= self.s.len or !std.ascii.isDigit(self.s[self.i])) return self.atPosition("No number after minus sign", self.i);
        }
        if (self.s[self.i] == '0') {
            self.i += 1;
            if (self.i < self.s.len and std.ascii.isDigit(self.s[self.i])) return self.atPosition("Unexpected number", self.i);
        } else {
            while (self.i < self.s.len and std.ascii.isDigit(self.s[self.i])) self.i += 1;
        }
        if (self.i < self.s.len and self.s[self.i] == '.') {
            self.i += 1;
            if (self.i >= self.s.len or !std.ascii.isDigit(self.s[self.i])) return self.atPosition("Unterminated fractional number", self.i);
            while (self.i < self.s.len and std.ascii.isDigit(self.s[self.i])) self.i += 1;
        }
        if (self.i < self.s.len and (self.s[self.i] == 'e' or self.s[self.i] == 'E')) {
            self.i += 1;
            if (self.i < self.s.len and (self.s[self.i] == '+' or self.s[self.i] == '-')) self.i += 1;
            if (self.i >= self.s.len or !std.ascii.isDigit(self.s[self.i])) return self.atPosition("Exponent part is missing a number", self.i);
            while (self.i < self.s.len and std.ascii.isDigit(self.s[self.i])) self.i += 1;
        }
    }
};

fn lineColumn(s: []const u8, pos: u32) SourceLocation {
    var line: u32 = 1;
    var start: usize = 0;
    for (s[0..pos], 0..) |c, i| if (c == '\n') {
        line += 1;
        start = i + 1;
    };
    return .{ .line = line, .column = 1 + utf16Length(s[start..pos]) };
}

/// The UTF-16 index range [from, to) of UTF-8 `s` (JS `slice`): a surrogate
/// pair cut by either end leaves its half as WTF-8, as V8's message does.
fn utf16Slice(a: Allocator, s: []const u8, from: usize, to: usize) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var units: usize = 0;
    var i: usize = 0;
    while (i < s.len and units < to) {
        const len = @min(std.unicode.utf8ByteSequenceLength(s[i]) catch 1, s.len - i);
        const seq = s[i .. i + len];
        const cp: ?u21 = if (len == 4) std.unicode.utf8Decode(seq) catch null else null;
        if (cp != null and cp.? >= 0x10000) {
            const v = cp.? - 0x10000;
            const halves = [2]u21{ @intCast(0xD800 + (v >> 10)), @intCast(0xDC00 + (v & 0x3FF)) };
            const take_high = units >= from and units < to;
            const take_low = units + 1 >= from and units + 1 < to;
            if (take_high and take_low) {
                try out.appendSlice(a, seq);
            } else for ([2]bool{ take_high, take_low }, halves) |take, unit| if (take) {
                var buf: [3]u8 = undefined;
                buf = .{ @intCast(0xE0 | (unit >> 12)), @intCast(0x80 | ((unit >> 6) & 0x3F)), @intCast(0x80 | (unit & 0x3F)) };
                try out.appendSlice(a, &buf);
            };
            units += 2;
        } else {
            if (units >= from) try out.appendSlice(a, seq);
            units += if (len == 4) 2 else 1; // an undecodable 4-byte lead counts as utf16Length does
        }
        i += len;
    }
    return out.items;
}

test "v8 JSON.parse messages" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const cases = [_][2][]const u8{
        .{ "not-json", "Unexpected token 'o', \"not-json\" is not valid JSON" },
        .{ "{", "Expected property name or '}' in JSON at position 1 (line 1 column 2)" },
        .{ "{\"a\" 1}", "Expected ':' after property name in JSON at position 5 (line 1 column 6)" },
        .{ "{\"a\":1,}", "Expected double-quoted property name in JSON at position 7 (line 1 column 8)" },
        .{ "[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON" },
        .{ "[1 2]", "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)" },
        .{ "1 2", "Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)" },
        .{ "\"abc", "Unterminated string in JSON at position 4 (line 1 column 5)" },
        .{ "\"a\\x\"", "Bad escaped character in JSON at position 3 (line 1 column 4)" },
        .{ "\"\\\u{E9}\"", "Bad escaped character in JSON at position 2 (line 1 column 3)" },
        .{ "\"\\\u{4E2D}\"", "Unexpected token '\u{4E2D}', \"\"\\\u{4E2D}\"\" is not valid JSON" },
        .{ "\"abc\\", "Unexpected end of JSON input" },
        .{ "\"\\u12\"", "Bad Unicode escape in JSON at position 5 (line 1 column 6)" },
        .{ "\"\\u", "Bad Unicode escape in JSON at position 3 (line 1 column 4)" },
        .{ "{\"a\":\"\\u12\"}", "Bad Unicode escape in JSON at position 10 (line 1 column 11)" },
        .{ "\"\x01\"", "Bad control character in string literal in JSON at position 1 (line 1 column 2)" },
        .{ "-", "No number after minus sign in JSON at position 1 (line 1 column 2)" },
        .{ "1.", "Unterminated fractional number in JSON at position 2 (line 1 column 3)" },
        .{ "1e", "Exponent part is missing a number in JSON at position 2 (line 1 column 3)" },
        .{ "", "Unexpected end of JSON input" },
        .{ "nul", "Unexpected end of JSON input" },
        .{ "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "Unexpected token 'x', \"xxxxxxxxxx\"... is not valid JSON" },
        .{ "{\"query\":\"aaaaaaaaaaaaaaaaaaaaaaaa\" bbbbbbbbbbbbbbbbbbbbbbbbbbbbb}", "Expected ',' or '}' after property value in JSON at position 36 (line 1 column 37)" },
        .{ "[[[[[}]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]", "Unexpected token '}', \"[[[[[}]]]]]]]]]\"... is not valid JSON" },
        .{ "\n\n  {x", "Expected property name or '}' in JSON at position 5 (line 3 column 4)" },
        // UTF-16 units (Node 26): an emoji's high surrogate as the token, and context
        // snippets that cut a pair at either end (WTF-8 halves: ED A0 BD, ED B8 80).
        .{ "{\"a\":\u{1F600}}", "Unexpected token '\xed\xa0\xbd', \"{\"a\":\u{1F600}}\" is not valid JSON" },
        .{ "a" ++ "\u{1F600}" ** 11, "Unexpected token 'a', \"a" ++ "\u{1F600}" ** 4 ++ "\xed\xa0\xbd\"... is not valid JSON" },
        .{ "{\"" ++ "\u{1F600}" ** 11 ++ "\": \u{1F600}}", "Unexpected token '\xed\xa0\xbd', ...\"\xed\xb8\x80" ++ "\u{1F600}" ** 3 ++ "\": \u{1F600}}\" is not valid JSON" },
    };
    for (cases) |c| try std.testing.expectEqualStrings(c[1], try errorMessage(a, c[0]));
}
