//! V8 `JSON.parse` SyntaxError messages (Node 26) for text that fails to
//! parse. Only reachable from GET `variables`/`extensions` (mercurius
//! `tryJSONParse` surfaces `err.message`). Positions are UTF-16 indices.
const std = @import("std");
const ast = @import("ast.zig");

const Allocator = std.mem.Allocator;

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
        self.message = try std.fmt.allocPrint(self.a, "{s} in JSON at position {d} (line {d} column {d})", .{ what, ast.utf16Length(self.s[0..pos]), loc.line, loc.column });
        return error.Invalid;
    }

    /// Messages already ending in "JSON" omit the " in JSON" infix.
    fn atPositionRaw(self: *Scanner, what: []const u8, pos: usize) Err {
        const p: u32 = @intCast(pos);
        const loc = lineColumn(self.s, p);
        self.message = try std.fmt.allocPrint(self.a, "{s} at position {d} (line {d} column {d})", .{ what, ast.utf16Length(self.s[0..pos]), loc.line, loc.column });
        return error.Invalid;
    }

    fn unexpectedToken(self: *Scanner) Err {
        if (self.i >= self.s.len) {
            self.message = "Unexpected end of JSON input";
            return error.Invalid;
        }
        const len = std.unicode.utf8ByteSequenceLength(self.s[self.i]) catch 1;
        const token = self.s[self.i..@min(self.s.len, self.i + len)];
        const total = ast.utf16Length(self.s);
        const pos = ast.utf16Length(self.s[0..self.i]);
        if (total < min_source_for_context) {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', \"{s}\" is not valid JSON", .{ token, self.s });
        } else if (pos < max_context) {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', \"{s}\"... is not valid JSON", .{ token, utf16Slice(self.s, 0, pos + max_context) });
        } else if (pos < total - max_context) {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', ...\"{s}\"... is not valid JSON", .{ token, utf16Slice(self.s, pos - max_context, pos + max_context) });
        } else {
            self.message = try std.fmt.allocPrint(self.a, "Unexpected token '{s}', ...\"{s}\" is not valid JSON", .{ token, utf16Slice(self.s, pos - max_context, total) });
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

    fn value(self: *Scanner) Err!void {
        self.ws();
        if (self.i >= self.s.len) return self.unexpectedToken();
        switch (self.s[self.i]) {
            '{' => {
                self.i += 1;
                self.ws();
                if (self.i < self.s.len and self.s[self.i] == '}') {
                    self.i += 1;
                    return;
                }
                var first = true;
                while (true) {
                    self.ws();
                    if (self.i >= self.s.len or self.s[self.i] != '"') {
                        if (first) return self.atPosition("Expected property name or '}'", self.i);
                        return self.atPosition("Expected double-quoted property name", self.i);
                    }
                    first = false;
                    try self.string();
                    self.ws();
                    if (self.i >= self.s.len or self.s[self.i] != ':') return self.atPosition("Expected ':' after property name", self.i);
                    self.i += 1;
                    try self.value();
                    self.ws();
                    if (self.i < self.s.len and self.s[self.i] == ',') {
                        self.i += 1;
                        continue;
                    }
                    if (self.i < self.s.len and self.s[self.i] == '}') {
                        self.i += 1;
                        return;
                    }
                    return self.atPosition("Expected ',' or '}' after property value", self.i);
                }
            },
            '[' => {
                self.i += 1;
                self.ws();
                if (self.i < self.s.len and self.s[self.i] == ']') {
                    self.i += 1;
                    return;
                }
                while (true) {
                    try self.value();
                    self.ws();
                    if (self.i < self.s.len and self.s[self.i] == ',') {
                        self.i += 1;
                        continue;
                    }
                    if (self.i < self.s.len and self.s[self.i] == ']') {
                        self.i += 1;
                        return;
                    }
                    return self.atPosition("Expected ',' or ']' after array element", self.i);
                }
            },
            '"' => try self.string(),
            't' => try self.literal("true"),
            'f' => try self.literal("false"),
            'n' => try self.literal("null"),
            '-', '0'...'9' => try self.number(),
            else => return self.unexpectedToken(),
        }
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
                if (self.i + 1 >= self.s.len) break;
                switch (self.s[self.i + 1]) {
                    '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => self.i += 2,
                    'u' => {
                        var k: usize = 0;
                        while (k < 4) : (k += 1) {
                            const at = self.i + 2 + k;
                            if (at >= self.s.len) return self.atPosition("Bad Unicode escape", self.i);
                            if (!std.ascii.isHex(self.s[at])) return self.atPosition("Bad Unicode escape", self.i);
                        }
                        self.i += 6;
                    },
                    else => return self.atPosition("Bad escaped character", self.i + 1),
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

fn lineColumn(s: []const u8, pos: u32) ast.SourceLocation {
    var line: u32 = 1;
    var start: usize = 0;
    for (s[0..pos], 0..) |c, i| if (c == '\n') {
        line += 1;
        start = i + 1;
    };
    return .{ .line = line, .column = 1 + ast.utf16Length(s[start..pos]) };
}

/// Byte slice covering UTF-16 index range [from, to).
fn utf16Slice(s: []const u8, from: usize, to: usize) []const u8 {
    var units: usize = 0;
    var start: usize = s.len;
    var end: usize = s.len;
    var i: usize = 0;
    while (i < s.len) {
        if (units == from and start == s.len) start = i;
        if (units >= to) {
            end = i;
            break;
        }
        const len = std.unicode.utf8ByteSequenceLength(s[i]) catch 1;
        units += if (len == 4) 2 else 1;
        i += len;
    }
    if (start == s.len and units == from) start = i;
    return s[@min(start, end)..end];
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
    };
    for (cases) |c| try std.testing.expectEqualStrings(c[1], try errorMessage(a, c[0]));
}
