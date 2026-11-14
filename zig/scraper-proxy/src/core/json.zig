//! JSON values with JavaScript semantics.
//!
//! `stringify` matches `JSON.stringify` byte for byte: V8 `Number#toString`
//! spelling (`1e+21`, `1e-7`, `-0` -> `0`, non-finite -> `null`), escapes only
//! `"`, `\`, control characters and lone surrogates, and enumerates object keys
//! in ECMAScript `OrdinaryOwnPropertyKeys` order (array-index keys ascending
//! first, then insertion order). `parse` matches `JSON.parse` (last duplicate
//! wins at the first key's position, lone `\u` surrogates kept as WTF-8).
const std = @import("std");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;

pub const Value = union(enum) {
    null,
    bool: bool,
    number: f64,
    /// Verbatim JSON text: a pre-rendered number (e.g. node-pg int8 is a string,
    /// but numeric literals or cached fragments can be embedded) or a complete
    /// pre-serialized JSON fragment. The caller guarantees it is valid JSON.
    raw: []const u8,
    string: []const u8,
    array: []Value,
    object: []Member,

    /// Linear lookup (objects are small rows/args). Returns the first match;
    /// `parse` and `ObjectBuilder` never produce duplicates.
    pub fn get(self: Value, key: []const u8) ?Value {
        if (self != .object) return null;
        for (self.object) |member| if (std.mem.eql(u8, member.key, key)) return member.value;
        return null;
    }

    pub fn getPtr(self: Value, key: []const u8) ?*Value {
        if (self != .object) return null;
        for (self.object) |*member| if (std.mem.eql(u8, member.key, key)) return &member.value;
        return null;
    }

    pub fn isNull(self: Value) bool {
        return self == .null;
    }

    /// `std.fmt` integration: `{f}` prints `JSON.stringify(value)`.
    pub fn format(self: Value, w: *Writer) Writer.Error!void {
        try stringify(w, self);
    }
};

pub const Member = struct {
    key: []const u8,
    value: Value,
};

pub fn string(s: []const u8) Value {
    return .{ .string = s };
}

pub fn number(n: f64) Value {
    return .{ .number = n };
}

pub fn int(n: anytype) Value {
    return .{ .number = @floatFromInt(n) };
}

/// Builds an ordered object; `put` replaces an existing key in place like JS
/// property assignment.
pub const ObjectBuilder = struct {
    members: std.ArrayList(Member) = .empty,

    pub fn put(self: *ObjectBuilder, a: Allocator, key: []const u8, value: Value) Allocator.Error!void {
        for (self.members.items) |*member| if (std.mem.eql(u8, member.key, key)) {
            member.value = value;
            return;
        };
        try self.members.append(a, .{ .key = key, .value = value });
    }

    /// Appends without a duplicate check (caller knows the key is new).
    pub fn putNew(self: *ObjectBuilder, a: Allocator, key: []const u8, value: Value) Allocator.Error!void {
        try self.members.append(a, .{ .key = key, .value = value });
    }

    pub fn finish(self: *ObjectBuilder, a: Allocator) Allocator.Error!Value {
        return .{ .object = try self.members.toOwnedSlice(a) };
    }
};

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/// `JSON.stringify(value)`.
pub fn stringify(w: *Writer, value: Value) Writer.Error!void {
    return stringifyAt(w, value, 0);
}

/// Containers deeper than this are written by `stringifyDeep` (an explicit
/// stack on the heap), so client- or database-supplied nesting never costs
/// more than this many recursive frames.
const recursion_limit = 128;

fn stringifyAt(w: *Writer, value: Value, depth: usize) Writer.Error!void {
    switch (value) {
        .null => try w.writeAll("null"),
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .number => |n| try writeNumber(w, n),
        .raw => |r| try w.writeAll(r),
        .string => |s| try writeString(w, s),
        .array => |items| {
            if (depth >= recursion_limit) return stringifyDeep(w, value);
            try w.writeByte('[');
            for (items, 0..) |item, i| {
                if (i > 0) try w.writeByte(',');
                try stringifyAt(w, item, depth + 1);
            }
            try w.writeByte(']');
        },
        .object => |members| {
            if (depth >= recursion_limit) return stringifyDeep(w, value);
            try writeObject(w, members, depth);
        },
    }
}

/// Object member order of `JSON.stringify`: array-index keys ascending, then
/// the rest in insertion order. Iterates without allocating.
const MemberOrder = struct {
    members: []const Member,
    has_index: bool,
    /// Index phase: last index key written.
    previous: ?u32 = null,
    in_index_phase: bool,
    next: usize = 0,

    fn init(members: []const Member) MemberOrder {
        var has_index = false;
        for (members) |member| {
            if (arrayIndex(member.key) != null) {
                has_index = true;
                break;
            }
        }
        return .{ .members = members, .has_index = has_index, .in_index_phase = has_index };
    }

    fn nextMember(self: *MemberOrder) ?*const Member {
        if (self.in_index_phase) {
            var selected: ?usize = null;
            var smallest: u32 = std.math.maxInt(u32);
            for (self.members, 0..) |member, i| {
                const index = arrayIndex(member.key) orelse continue;
                if ((self.previous == null or index > self.previous.?) and index < smallest) {
                    smallest = index;
                    selected = i;
                }
            }
            if (selected) |i| {
                self.previous = smallest;
                return &self.members[i];
            }
            self.in_index_phase = false;
        }
        while (self.next < self.members.len) {
            const member = &self.members[self.next];
            self.next += 1;
            if (self.has_index and arrayIndex(member.key) != null) continue;
            return member;
        }
        return null;
    }
};

fn writeObject(w: *Writer, members: []const Member, depth: usize) Writer.Error!void {
    try w.writeByte('{');
    var order = MemberOrder.init(members);
    var first = true;
    while (order.nextMember()) |member| {
        if (!first) try w.writeByte(',');
        first = false;
        try writeString(w, member.key);
        try w.writeByte(':');
        try stringifyAt(w, member.value, depth + 1);
    }
    try w.writeByte('}');
}

/// `stringify` with an explicit stack (deep values).
fn stringifyDeep(w: *Writer, value: Value) Writer.Error!void {
    const Frame = union(enum) {
        array: struct { items: []const Value, next: usize = 0 },
        object: struct { order: MemberOrder, first: bool = true },
    };
    const gpa = std.heap.c_allocator;
    var stack: std.ArrayList(Frame) = .empty;
    defer stack.deinit(gpa);
    var v = value;
    while (true) {
        // Open `v` (containers push a frame), or write it.
        switch (v) {
            .array => |items| {
                try w.writeByte('[');
                stack.append(gpa, .{ .array = .{ .items = items } }) catch return error.WriteFailed;
            },
            .object => |members| {
                try w.writeByte('{');
                stack.append(gpa, .{ .object = .{ .order = MemberOrder.init(members) } }) catch return error.WriteFailed;
            },
            else => try stringifyAt(w, v, 0),
        }
        // Find the next value to write, closing finished containers.
        while (true) {
            if (stack.items.len == 0) return;
            switch (stack.items[stack.items.len - 1]) {
                .array => |*f| {
                    if (f.next < f.items.len) {
                        if (f.next > 0) try w.writeByte(',');
                        v = f.items[f.next];
                        f.next += 1;
                        break;
                    }
                    try w.writeByte(']');
                },
                .object => |*f| {
                    if (f.order.nextMember()) |member| {
                        if (!f.first) try w.writeByte(',');
                        f.first = false;
                        try writeString(w, member.key);
                        try w.writeByte(':');
                        v = member.value;
                        break;
                    }
                    try w.writeByte('}');
                },
            }
            _ = stack.pop();
        }
    }
}

/// Nesting depth of `value` (a scalar is 0, `[]`/`{}` are 1), counted
/// iteratively; stops counting at `limit` (returns `limit`). For bounding
/// recursive walks over client-supplied values.
pub fn depthAtLeast(a: Allocator, value: Value, limit: usize) Allocator.Error!usize {
    const Frame = struct { items: []const Value = &.{}, members: []const Member = &.{}, next: usize = 0 };
    var stack: std.ArrayList(Frame) = .empty;
    defer stack.deinit(a);
    var max: usize = 0;
    var v = value;
    while (true) {
        switch (v) {
            .array => |items| {
                try stack.append(a, .{ .items = items });
                max = @max(max, stack.items.len);
            },
            .object => |members| {
                try stack.append(a, .{ .members = members });
                max = @max(max, stack.items.len);
            },
            else => {},
        }
        if (max >= limit) return limit;
        // Next child in depth-first order.
        while (true) {
            if (stack.items.len == 0) return max;
            const top = &stack.items[stack.items.len - 1];
            if (top.next < top.items.len) {
                v = top.items[top.next];
                top.next += 1;
                break;
            }
            if (top.next < top.members.len) {
                v = top.members[top.next].value;
                top.next += 1;
                break;
            }
            _ = stack.pop();
        }
    }
}

pub fn stringifyAlloc(a: Allocator, value: Value) Allocator.Error![]u8 {
    var out: Writer.Allocating = .init(a);
    errdefer out.deinit();
    stringify(&out.writer, value) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

/// ECMAScript array index: canonical decimal u32 below 2^32-1.
pub fn arrayIndex(key: []const u8) ?u32 {
    if (key.len == 0 or key.len > 10 or (key.len > 1 and key[0] == '0')) return null;
    for (key) |c| if (c < '0' or c > '9') return null;
    const n = std.fmt.parseInt(u32, key, 10) catch return null;
    return if (n == std.math.maxInt(u32)) null else n;
}

const escape_table = blk: {
    var table: [256]u8 = .{0} ** 256;
    for (0..0x20) |c| table[c] = 'u';
    table['\x08'] = 'b';
    table['\t'] = 't';
    table['\n'] = 'n';
    table['\x0c'] = 'f';
    table['\r'] = 'r';
    table['"'] = '"';
    table['\\'] = '\\';
    table[0xed] = 1; // possible WTF-8 lone surrogate
    break :blk table;
};

/// `JSON.stringify(string)`. Input is UTF-8 or WTF-8 (lone surrogates become
/// `\udxxx` like well-formed `JSON.stringify`).
const lanes = 16;

const Block = @Vector(lanes, u8);

inline fn specialMask(block: Block) std.meta.Int(.unsigned, lanes) {
    const special = (block < @as(Block, @splat(0x20))) |
        (block == @as(Block, @splat('"'))) |
        (block == @as(Block, @splat('\\'))) |
        (block == @as(Block, @splat(0xed)));
    return @bitCast(special);
}

pub fn writeString(w: *Writer, s: []const u8) Writer.Error!void {
    // Fast path (enough free buffer for the string plus one block of slack):
    // copy 16-byte blocks straight into the buffer while checking them, so
    // clean strings cost one pass. Bytes past the string are overwritten
    // later (they are beyond `w.end`).
    if (w.buffer.len - w.end >= s.len + 2 + lanes) {
        const dest = w.buffer[w.end + 1 ..];
        w.buffer[w.end] = '"';
        var i: usize = 0;
        while (i < s.len) : (i += lanes) {
            var block: [lanes]u8 = undefined;
            if (i + lanes <= s.len) {
                block = s[i..][0..lanes].*;
            } else {
                block = @splat('a');
                @memcpy(block[0 .. s.len - i], s[i..]);
            }
            dest[i..][0..lanes].* = block;
            const mask = specialMask(block);
            if (mask != 0) {
                // Commit the clean prefix, escape the rest.
                const at = i + @ctz(mask);
                w.end += 1 + at;
                return writeEscaped(w, s, at);
            }
        }
        dest[s.len] = '"';
        w.end += s.len + 2;
        return;
    }
    try w.writeByte('"');
    return writeEscaped(w, s, 0);
}

/// Writes `s[from..]` escaped plus the closing quote (opening quote and
/// `s[0..from]` already written).
fn writeEscaped(w: *Writer, s: []const u8, from: usize) Writer.Error!void {
    var start: usize = from;
    var i: usize = from;
    while (i < s.len) : (i += 1) {
        // Skip clean 16-byte blocks.
        while (i + lanes <= s.len) {
            const mask = specialMask(s[i..][0..lanes].*);
            if (mask == 0) {
                i += lanes;
                continue;
            }
            i += @ctz(mask);
            break;
        }
        if (i >= s.len) break;
        const c = s[i];
        const kind = escape_table[c];
        if (kind == 0) continue;
        if (kind == 1) {
            if (i + 2 < s.len and s[i + 1] >= 0xa0 and s[i + 1] <= 0xbf and s[i + 2] & 0xc0 == 0x80) {
                try w.writeAll(s[start..i]);
                const unit: u16 = (@as(u16, c & 0x0f) << 12) | (@as(u16, s[i + 1] & 0x3f) << 6) | (s[i + 2] & 0x3f);
                try w.print("\\u{x:0>4}", .{unit});
                i += 2;
                start = i + 1;
            }
            continue;
        }
        try w.writeAll(s[start..i]);
        if (kind == 'u') {
            try w.print("\\u{x:0>4}", .{c});
        } else {
            try w.writeByte('\\');
            try w.writeByte(kind);
        }
        start = i + 1;
    }
    try w.writeAll(s[start..]);
    try w.writeByte('"');
}

/// `JSON.stringify(number)`: non-finite -> `null`.
pub fn writeNumber(w: *Writer, value: f64) Writer.Error!void {
    if (!std.math.isFinite(value)) return w.writeAll("null");
    var buf: [64]u8 = undefined;
    try w.writeAll(formatNumber(&buf, value));
}

const digit_pairs: *const [200]u8 = "00010203040506070809101112131415161718192021222324252627282930313233343536373839404142434445464748495051525354555657585960616263646566676869707172737475767778798081828384858687888990919293949596979899";

/// Decimal digits of `v` right-aligned in `buf`; returns the slice.
fn formatU64(buf: *[24]u8, value: u64) []const u8 {
    var v = value;
    var i: usize = buf.len;
    while (v >= 100) {
        const pair = (v % 100) * 2;
        v /= 100;
        i -= 2;
        buf[i] = digit_pairs[pair];
        buf[i + 1] = digit_pairs[pair + 1];
    }
    if (v >= 10) {
        i -= 2;
        buf[i] = digit_pairs[v * 2];
        buf[i + 1] = digit_pairs[v * 2 + 1];
    } else {
        i -= 1;
        buf[i] = @intCast('0' + v);
    }
    return buf[i..];
}

/// ECMAScript `Number::toString(value)` (radix 10). NaN/Infinity spelled like JS.
pub fn formatNumber(buf: *[64]u8, value: f64) []const u8 {
    if (std.math.isNan(value)) return "NaN";
    if (std.math.isInf(value)) return if (value > 0) "Infinity" else "-Infinity";
    if (value == 0) return "0";
    // Fast path: exact integers print as plain decimal.
    if (@abs(value) < 9007199254740992.0 and @trunc(value) == value) {
        var digits: [24]u8 = undefined;
        const text = formatU64(&digits, @intFromFloat(@abs(value)));
        const neg: usize = @intFromBool(value < 0);
        buf[0] = '-';
        @memcpy(buf[neg..][0..text.len], text);
        return buf[0 .. neg + text.len];
    }
    // Shortest round-trip digits and decimal exponent (Ryu), then laid out
    // per ECMAScript Number::toString.
    var digits_buf: [64]u8 = undefined;
    const sci = std.fmt.float.render(&digits_buf, @abs(value), .{ .mode = .scientific }) catch unreachable;
    // `sci` is "d[.ddd]e[-]x".
    const e_at = std.mem.indexOfScalar(u8, sci, 'e').?;
    var digits: [32]u8 = undefined;
    var k: usize = 0;
    for (sci[0..e_at]) |c| {
        if (c == '.') continue;
        digits[k] = c;
        k += 1;
    }
    while (k > 1 and digits[k - 1] == '0') k -= 1;
    const exp10 = std.fmt.parseInt(i32, sci[e_at + 1 ..], 10) catch unreachable;
    const n: i32 = exp10 + 1; // position of decimal point relative to digits
    var out = std.Io.Writer.fixed(buf);
    if (value < 0) out.writeByte('-') catch unreachable;
    const ki: i32 = @intCast(k);
    if (ki <= n and n <= 21) {
        out.writeAll(digits[0..k]) catch unreachable;
        out.splatByteAll('0', @intCast(n - ki)) catch unreachable;
    } else if (0 < n and n <= 21) {
        out.writeAll(digits[0..@intCast(n)]) catch unreachable;
        out.writeByte('.') catch unreachable;
        out.writeAll(digits[@intCast(n)..k]) catch unreachable;
    } else if (-6 < n and n <= 0) {
        out.writeAll("0.") catch unreachable;
        out.splatByteAll('0', @intCast(-n)) catch unreachable;
        out.writeAll(digits[0..k]) catch unreachable;
    } else {
        out.writeByte(digits[0]) catch unreachable;
        if (k > 1) {
            out.writeByte('.') catch unreachable;
            out.writeAll(digits[1..k]) catch unreachable;
        }
        out.writeByte('e') catch unreachable;
        out.writeByte(if (n - 1 >= 0) '+' else '-') catch unreachable;
        out.print("{d}", .{@abs(n - 1)}) catch unreachable;
    }
    return out.buffered();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

pub const ParseError = error{ SyntaxError, OutOfMemory };

pub const ParseOptions = struct {
    /// secure-json-parse (`protoAction`/`constructorAction: 'error'`), used by
    /// Fastify's JSON body parser: reject `__proto__` keys and `constructor`
    /// objects holding a `prototype` key.
    secure: bool = false,
    /// Nesting bound (null: none). The parser is iterative, like V8's
    /// JSON.parse, so depth costs heap, not stack.
    max_depth: ?usize = null,
    /// Strip a leading U+FEFF (secure-json-parse does; JSON.parse does not).
    strip_bom: bool = false,
};

/// `JSON.parse(text)`. Every slice in the result is allocated from `a`
/// (strings without escapes are copied too, so `text` may be freed).
pub fn parse(a: Allocator, text: []const u8, options: ParseOptions) ParseError!Value {
    var p: Parser = .{ .a = a, .s = text, .options = options };
    if (options.strip_bom and std.mem.startsWith(u8, text, "\xef\xbb\xbf")) p.i = 3;
    p.skipWs();
    const value = try p.document();
    p.skipWs();
    if (p.i != p.s.len) return error.SyntaxError;
    return value;
}

const Parser = struct {
    a: Allocator,
    s: []const u8,
    i: usize = 0,
    options: ParseOptions,

    fn skipWs(p: *Parser) void {
        while (p.i < p.s.len) : (p.i += 1) switch (p.s[p.i]) {
            ' ', '\t', '\n', '\r' => {},
            else => return,
        };
    }

    /// A scalar at `p.i`, or null when a container starts there.
    fn scalar(p: *Parser) ParseError!?Value {
        if (p.i >= p.s.len) return error.SyntaxError;
        return switch (p.s[p.i]) {
            '{', '[' => null,
            '"' => .{ .string = try p.str() },
            't' => try p.literal("true", .{ .bool = true }),
            'f' => try p.literal("false", .{ .bool = false }),
            'n' => try p.literal("null", .null),
            '-', '0'...'9' => .{ .number = try p.num() },
            else => error.SyntaxError,
        };
    }

    const Frame = union(enum) {
        array: std.ArrayList(Value),
        object: struct {
            members: std.ArrayList(Member) = .empty,
            /// Duplicate detection beyond `small` members.
            index: std.StringHashMapUnmanaged(usize) = .empty,
            /// Key of the member whose value is being parsed.
            key: []const u8 = "",
        },
    };

    /// One JSON value. Iterative (an explicit stack of open containers), so
    /// nesting depth costs heap rather than call stack, as with V8's
    /// non-recursive JSON.parse.
    fn document(p: *Parser) ParseError!Value {
        var stack: std.ArrayList(Frame) = .empty;
        defer {
            for (stack.items) |*f| switch (f.*) {
                .array => |*items| items.deinit(p.a),
                .object => |*o| {
                    o.members.deinit(p.a);
                    o.index.deinit(p.a);
                },
            };
            stack.deinit(p.a);
        }
        // Parse a value; when it is a scalar or a closed container, attach it
        // to the innermost open container (or return it at the top).
        value: while (true) {
            var v: Value = undefined;
            if (try p.scalar()) |sv| {
                v = sv;
            } else {
                if (p.options.max_depth) |max| if (stack.items.len >= max) return error.SyntaxError;
                const open = p.s[p.i];
                p.i += 1;
                p.skipWs();
                if (open == '[') {
                    if (p.i < p.s.len and p.s[p.i] == ']') {
                        p.i += 1;
                        v = .{ .array = &.{} };
                    } else {
                        try stack.append(p.a, .{ .array = .empty });
                        continue :value;
                    }
                } else {
                    if (p.i < p.s.len and p.s[p.i] == '}') {
                        p.i += 1;
                        v = .{ .object = &.{} };
                    } else {
                        try stack.append(p.a, .{ .object = .{} });
                        try p.objectKey(&stack.items[stack.items.len - 1].object.key);
                        continue :value;
                    }
                }
            }
            // Attach `v`, closing every container that ends right after it.
            while (true) {
                if (stack.items.len == 0) return v;
                const top = &stack.items[stack.items.len - 1];
                switch (top.*) {
                    .array => |*items| {
                        try items.append(p.a, v);
                        p.skipWs();
                        if (p.i >= p.s.len) return error.SyntaxError;
                        if (p.s[p.i] == ',') {
                            p.i += 1;
                            p.skipWs();
                            continue :value;
                        }
                        if (p.s[p.i] != ']') return error.SyntaxError;
                        p.i += 1;
                        v = .{ .array = try items.toOwnedSlice(p.a) };
                    },
                    .object => |*o| {
                        if (p.options.secure) {
                            if (std.mem.eql(u8, o.key, "__proto__")) return error.SyntaxError;
                            if (std.mem.eql(u8, o.key, "constructor") and v == .object and v.get("prototype") != null)
                                return error.SyntaxError;
                        }
                        try p.addMember(&o.members, &o.index, o.key, v);
                        p.skipWs();
                        if (p.i >= p.s.len) return error.SyntaxError;
                        if (p.s[p.i] == ',') {
                            p.i += 1;
                            try p.objectKey(&o.key);
                            continue :value;
                        }
                        if (p.s[p.i] != '}') return error.SyntaxError;
                        p.i += 1;
                        o.index.deinit(p.a);
                        v = .{ .object = try o.members.toOwnedSlice(p.a) };
                    },
                }
                _ = stack.pop();
            }
        }
    }

    /// `"key"` `:` before a member value (whitespace skipped around).
    fn objectKey(p: *Parser, key: *[]const u8) ParseError!void {
        p.skipWs();
        if (p.i >= p.s.len or p.s[p.i] != '"') return error.SyntaxError;
        key.* = try p.str();
        p.skipWs();
        if (p.i >= p.s.len or p.s[p.i] != ':') return error.SyntaxError;
        p.i += 1;
        p.skipWs();
    }

    fn literal(p: *Parser, word: []const u8, v: Value) ParseError!Value {
        if (!std.mem.startsWith(u8, p.s[p.i..], word)) return error.SyntaxError;
        p.i += word.len;
        return v;
    }

    fn num(p: *Parser) ParseError!f64 {
        const start = p.i;
        if (p.s[p.i] == '-') p.i += 1;
        if (p.i >= p.s.len) return error.SyntaxError;
        if (p.s[p.i] == '0') {
            p.i += 1;
        } else if (p.s[p.i] >= '1' and p.s[p.i] <= '9') {
            while (p.i < p.s.len and std.ascii.isDigit(p.s[p.i])) p.i += 1;
        } else return error.SyntaxError;
        if (p.i < p.s.len and p.s[p.i] == '.') {
            p.i += 1;
            const frac = p.i;
            while (p.i < p.s.len and std.ascii.isDigit(p.s[p.i])) p.i += 1;
            if (p.i == frac) return error.SyntaxError;
        }
        if (p.i < p.s.len and (p.s[p.i] == 'e' or p.s[p.i] == 'E')) {
            p.i += 1;
            if (p.i < p.s.len and (p.s[p.i] == '+' or p.s[p.i] == '-')) p.i += 1;
            const exp = p.i;
            while (p.i < p.s.len and std.ascii.isDigit(p.s[p.i])) p.i += 1;
            if (p.i == exp) return error.SyntaxError;
        }
        return std.fmt.parseFloat(f64, p.s[start..p.i]) catch error.SyntaxError;
    }

    fn hex4(p: *Parser) ParseError!u16 {
        if (p.i + 4 > p.s.len) return error.SyntaxError;
        const v = std.fmt.parseInt(u16, p.s[p.i .. p.i + 4], 16) catch return error.SyntaxError;
        // parseInt accepts '+'/'_'; JSON requires exactly four hex digits.
        for (p.s[p.i .. p.i + 4]) |c| if (!std.ascii.isHex(c)) return error.SyntaxError;
        p.i += 4;
        return v;
    }

    /// Index of the first `"`, `\\` or control character at or after `from`.
    fn scanSpecial(s: []const u8, from: usize) usize {
        var i = from;
        while (i + lanes <= s.len) : (i += lanes) {
            const block: Block = s[i..][0..lanes].*;
            const special = (block < @as(Block, @splat(0x20))) |
                (block == @as(Block, @splat('"'))) |
                (block == @as(Block, @splat('\\')));
            const mask: std.meta.Int(.unsigned, lanes) = @bitCast(special);
            if (mask != 0) return i + @ctz(mask);
        }
        while (i < s.len) : (i += 1) {
            const c = s[i];
            if (c == '"' or c == '\\' or c < 0x20) return i;
        }
        return i;
    }

    fn str(p: *Parser) ParseError![]const u8 {
        p.i += 1; // opening quote
        const s = p.s;
        const start = p.i;
        var i = scanSpecial(s, start);
        if (i >= s.len or s[i] < 0x20) return error.SyntaxError;
        if (s[i] == '"') {
            // Fast path: no escapes.
            p.i = i + 1;
            return p.a.dupe(u8, s[start..i]);
        }
        // Escaped: decode into one allocation that is never shorter than the
        // output (the escaped input is never shorter), then give the unused
        // tail back (the arena reclaims a shrunk last allocation). Sized for
        // the rest of the input when that is small; otherwise the closing
        // quote is found first (escapes never hide a raw `"` or `\\` after
        // their first byte) so a long document is not over-allocated.
        var bound = s.len - start;
        if (bound > 64 * 1024) {
            var end = i;
            while (true) {
                if (end >= s.len or s[end] < 0x20) return error.SyntaxError;
                if (s[end] == '"') break;
                end = scanSpecial(s, end + 2); // s[end] is a backslash: skip it and the escaped byte
            }
            bound = end - start;
        }
        const out = try p.a.alloc(u8, bound);
        errdefer p.a.free(out);
        var o = i - start;
        @memcpy(out[0..o], s[start..i]);
        while (true) {
            const c = s[i];
            if (c == '"') break;
            if (c < 0x20) return error.SyntaxError;
            // c == '\\'
            i += 1;
            if (i >= s.len) return error.SyntaxError;
            const e = s[i];
            i += 1;
            switch (e) {
                '"', '\\', '/' => {
                    out[o] = e;
                    o += 1;
                },
                'b', 'f', 'n', 'r', 't' => {
                    out[o] = switch (e) {
                        'b' => 8,
                        'f' => 12,
                        'n' => '\n',
                        'r' => '\r',
                        else => '\t',
                    };
                    o += 1;
                },
                'u' => {
                    p.i = i;
                    var cp: u21 = try p.hex4();
                    if (cp >= 0xd800 and cp <= 0xdbff and p.i + 6 <= s.len and s[p.i] == '\\' and s[p.i + 1] == 'u') {
                        const save = p.i;
                        p.i += 2;
                        const low = try p.hex4();
                        if (low >= 0xdc00 and low <= 0xdfff) {
                            cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                        } else p.i = save;
                    }
                    i = p.i;
                    const len = if (cp >= 0xd800 and cp <= 0xdfff)
                        std.unicode.wtf8Encode(cp, out[o..][0..4]) catch unreachable
                    else
                        std.unicode.utf8Encode(cp, out[o..][0..4]) catch unreachable;
                    o += len;
                },
                else => return error.SyntaxError,
            }
            const next = scanSpecial(s, i);
            @memcpy(out[o..][0 .. next - i], s[i..next]);
            o += next - i;
            i = next;
            if (i >= s.len) return error.SyntaxError;
        }
        p.i = i + 1;
        return p.a.realloc(out, o);
    }

    fn addMember(p: *Parser, members: *std.ArrayList(Member), index: *std.StringHashMapUnmanaged(usize), key: []const u8, v: Value) ParseError!void {
        const small = 16;
        if (members.items.len < small) {
            for (members.items) |*m| if (std.mem.eql(u8, m.key, key)) {
                m.value = v;
                return;
            };
            try members.append(p.a, .{ .key = key, .value = v });
            return;
        }
        if (index.count() == 0) {
            for (members.items, 0..) |m, i| try index.put(p.a, m.key, i);
        }
        const gop = try index.getOrPut(p.a, key);
        if (gop.found_existing) {
            members.items[gop.value_ptr.*].value = v;
            return;
        }
        gop.value_ptr.* = members.items.len;
        try members.append(p.a, .{ .key = key, .value = v });
    }
};

// ---------------------------------------------------------------------------
// UTF-8 decoding like Buffer#toString('utf8') / TextDecoder (WHATWG)
// ---------------------------------------------------------------------------

/// Returns `bytes` unchanged when valid UTF-8, else a copy with each maximal
/// invalid subsequence replaced by U+FFFD (WHATWG decoder semantics, as Node's
/// `Buffer#toString('utf8')`).
pub fn toWellFormedUtf8(a: Allocator, bytes: []const u8) Allocator.Error![]const u8 {
    if (std.unicode.utf8ValidateSlice(bytes)) return bytes;
    var out: std.ArrayList(u8) = try .initCapacity(a, bytes.len + 8);
    errdefer out.deinit(a);
    var i: usize = 0;
    while (i < bytes.len) {
        const c = bytes[i];
        if (c < 0x80) {
            try out.append(a, c);
            i += 1;
            continue;
        }
        var need: usize = 0;
        var lower: u8 = 0x80;
        var upper: u8 = 0xbf;
        switch (c) {
            0xc2...0xdf => need = 1,
            0xe0 => {
                need = 2;
                lower = 0xa0;
            },
            0xe1...0xec, 0xee...0xef => need = 2,
            0xed => {
                need = 2;
                upper = 0x9f;
            },
            0xf0 => {
                need = 3;
                lower = 0x90;
            },
            0xf1...0xf3 => need = 3,
            0xf4 => {
                need = 3;
                upper = 0x8f;
            },
            else => {
                try out.appendSlice(a, "\xef\xbf\xbd");
                i += 1;
                continue;
            },
        }
        var j: usize = 1;
        var ok = true;
        while (j <= need) : (j += 1) {
            if (i + j >= bytes.len) {
                ok = false;
                break;
            }
            const b = bytes[i + j];
            const lo: u8 = if (j == 1) lower else 0x80;
            const hi: u8 = if (j == 1) upper else 0xbf;
            if (b < lo or b > hi) {
                ok = false;
                break;
            }
        }
        if (ok) {
            try out.appendSlice(a, bytes[i .. i + need + 1]);
            i += need + 1;
        } else {
            try out.appendSlice(a, "\xef\xbf\xbd");
            i += j; // consumed lead + valid continuation bytes
        }
    }
    return out.toOwnedSlice(a);
}

// ---------------------------------------------------------------------------
// Tests (expected strings produced by Node 26 `JSON.stringify` / `String(n)`)
// ---------------------------------------------------------------------------

const testing = std.testing;

fn expectNumber(expected: []const u8, value: f64) !void {
    var buf: [64]u8 = undefined;
    try testing.expectEqualStrings(expected, formatNumber(&buf, value));
}

test "number formatting matches V8 Number#toString" {
    try expectNumber("0", 0);
    try expectNumber("0", -0.0);
    try expectNumber("1", 1);
    try expectNumber("-1", -1);
    try expectNumber("0.1", 0.1);
    var tenth: f64 = 0.1;
    _ = &tenth;
    try expectNumber("0.30000000000000004", tenth + 0.2);
    try expectNumber("1e+21", 1e21);
    try expectNumber("100000000000000000000", 1e20);
    try expectNumber("123456789012345680000", 123456789012345678901.0);
    try expectNumber("1e-7", 1e-7);
    try expectNumber("0.000001", 0.000001);
    try expectNumber("0.0000012345", 0.0000012345);
    try expectNumber("1.2345e-7", 0.00000012345);
    try expectNumber("9007199254740992", 9007199254740992.0);
    try expectNumber("9007199254740991", 9007199254740991.0);
    try expectNumber("18014398509481984", 18014398509481984.0);
    try expectNumber("1.7976931348623157e+308", std.math.floatMax(f64));
    try expectNumber("5e-324", 5e-324);
    try expectNumber("-1.5e-10", -1.5e-10);
    try expectNumber("123.456", 123.456);
    try expectNumber("0.0123", 0.0123);
    try expectNumber("1.5e+300", 1.5e300);
    try expectNumber("NaN", std.math.nan(f64));
    try expectNumber("-Infinity", -std.math.inf(f64));
}

test "stringify escapes like JSON.stringify and orders index keys first" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var members = [_]Member{
        .{ .key = "z", .value = .{ .number = -0.0 } },
        .{ .key = "10", .value = .{ .number = 1 } },
        .{ .key = "2", .value = .{ .number = 1e21 } },
        .{ .key = "01", .value = .null },
        .{ .key = "s", .value = .{ .string = "a\"b\\c\n\x01\x7f\u{2028}\xed\xa0\x80" } },
        .{ .key = "inf", .value = .{ .number = std.math.inf(f64) } },
        .{ .key = "raw", .value = .{ .raw = "12345678901234567890" } },
    };
    const out = try stringifyAlloc(a, .{ .object = &members });
    try testing.expectEqualStrings(
        "{\"2\":1e+21,\"10\":1,\"z\":0,\"01\":null,\"s\":\"a\\\"b\\\\c\\n\\u0001\x7f\u{2028}\\ud800\",\"inf\":null,\"raw\":12345678901234567890}",
        out,
    );
}

fn writeStringScalar(w: *Writer, s: []const u8) Writer.Error!void {
    try w.writeByte('"');
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        switch (escape_table[c]) {
            0 => try w.writeByte(c),
            1 => if (i + 2 < s.len and s[i + 1] >= 0xa0 and s[i + 1] <= 0xbf and s[i + 2] & 0xc0 == 0x80) {
                const unit: u16 = (@as(u16, c & 0x0f) << 12) | (@as(u16, s[i + 1] & 0x3f) << 6) | (s[i + 2] & 0x3f);
                try w.print("\\u{x:0>4}", .{unit});
                i += 2;
            } else try w.writeByte(c),
            'u' => try w.print("\\u{x:0>4}", .{c}),
            else => |k| {
                try w.writeByte('\\');
                try w.writeByte(k);
            },
        }
    }
    try w.writeByte('"');
}

test "vectorized writeString matches the scalar reference" {
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const r = prng.random();
    const alphabet = "abcXYZ019 \"\\\n\t\x01\x1f\x7f\xed\xa0\x80\xc3\xa9";
    var buf: [200]u8 = undefined;
    var out_a: [2048]u8 = undefined;
    var out_b: [2048]u8 = undefined;
    for (0..5000) |_| {
        const len = r.uintLessThan(usize, buf.len);
        for (buf[0..len]) |*b| b.* = alphabet[r.uintLessThan(usize, alphabet.len)];
        var wa = std.Io.Writer.fixed(&out_a);
        var wb = std.Io.Writer.fixed(&out_b);
        try writeString(&wa, buf[0..len]);
        try writeStringScalar(&wb, buf[0..len]);
        try testing.expectEqualStrings(wb.buffered(), wa.buffered());
    }
}

test "parse matches JSON.parse semantics" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const v = try parse(a, " {\"a\": 1, \"b\": [true, null, \"x\\u00e9\\ud83d\\ude00\\ud800\"], \"a\": 2.5e1, \"n\": -0} ", .{});
    const out = try stringifyAlloc(a, v);
    try testing.expectEqualStrings("{\"a\":25,\"b\":[true,null,\"xé😀\\ud800\"],\"n\":0}", out);
    try testing.expectError(error.SyntaxError, parse(a, "{\"a\":1,}", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "01", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "1.", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "\"\t\"", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "[1] x", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "\"\\u12G4\"", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "{\"__proto__\":{}}", .{ .secure = true }));
    try testing.expectError(error.SyntaxError, parse(a, "{\"constructor\":{\"prototype\":1}}", .{ .secure = true }));
    _ = try parse(a, "{\"constructor\":{\"x\":1}}", .{ .secure = true });
    _ = try parse(a, "\xef\xbb\xbf{}", .{ .strip_bom = true });
    try testing.expectError(error.SyntaxError, parse(a, "\xef\xbb\xbf{}", .{}));
}

test "parse decodes escapes at block boundaries and rejects bad strings" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_]struct { in: []const u8, out: []const u8 }{
        .{ .in = "\"\\n\"", .out = "\n" },
        .{ .in = "\"abc\\\"\"", .out = "abc\"" },
        .{ .in = "\"0123456789abcde\\n0123456789abcdef\\t\"", .out = "0123456789abcde\n0123456789abcdef\t" },
        .{ .in = "\"0123456789abcdef\\/\\\\x\\u0041\\u00e9\\u20ac\\ud83d\\ude00\\b\\f\\r\"", .out = "0123456789abcdef/\\xAé€😀\x08\x0c\r" },
        .{ .in = "\"\\\\\\\\\\\\\\\\\"", .out = "\\\\\\\\" },
        .{ .in = "\"\\udc00x\"", .out = "\xed\xb0\x80x" },
    };
    for (cases) |c| {
        const v = try parse(a, c.in, .{});
        try testing.expectEqualStrings(c.out, v.string);
    }
    {
        // Escaped string in a large document (bounded allocation path).
        const big = try a.alloc(u8, 100 * 1024);
        @memset(big, ' ');
        const head = "[\"a\\nb\\\"c\",\"";
        @memcpy(big[0..head.len], head);
        big[big.len - 2] = '"';
        big[big.len - 1] = ']';
        const v = try parse(a, big, .{});
        try testing.expectEqualStrings("a\nb\"c", v.array[0].string);
        try testing.expectEqual(big.len - head.len - 2, v.array[1].string.len);
    }
    for ([_][]const u8{ "\"abc\\\"", "\"\\", "\"a\\n\x01\"", "\"\\\x0a\"", "\"\\x\"", "\"0123456789abcdef0123\\n0123456789abcdef", "\"\\u12\"" }) |bad| {
        try testing.expectError(error.SyntaxError, parse(a, bad, .{}));
    }
}

test "parse handles deep nesting without recursion (V8 JSON.parse is iterative)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const depth = 200_000;
    var text: std.ArrayList(u8) = .empty;
    for (0..depth) |i| try text.appendSlice(a, if (i % 2 == 0) "[" else "{\"k\":");
    try text.append(a, '1');
    var i: usize = depth;
    while (i > 0) {
        i -= 1;
        try text.append(a, if (i % 2 == 0) ']' else '}');
    }
    var v = try parse(a, text.items, .{ .secure = true });
    var levels: usize = 0;
    while (true) : (levels += 1) switch (v) {
        .array => |items| v = items[0],
        .object => |members| v = members[0].value,
        else => break,
    };
    try testing.expectEqual(@as(usize, depth), levels);
    try testing.expectError(error.SyntaxError, parse(a, text.items[0 .. text.items.len - 1], .{}));
    try testing.expectError(error.SyntaxError, parse(a, "[[1]", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "[1]]", .{}));
    try testing.expectError(error.SyntaxError, parse(a, "[[[1]]]", .{ .max_depth = 2 }));
    _ = try parse(a, "[[1]]", .{ .max_depth = 2 });
}

test "stringify writes deep values without deep recursion, same bytes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Mixed nesting with index-ordered keys at every level, deeper than the
    // recursion limit (the deep path must match the recursive one).
    const depth = 50_000;
    var text: std.ArrayList(u8) = .empty;
    for (0..depth) |i| try text.appendSlice(a, if (i % 3 == 0) "[0," else "{\"b\":1,\"2\":2,\"x\":");
    try text.appendSlice(a, "\"\\u0001\"");
    var i: usize = depth;
    while (i > 0) {
        i -= 1;
        try text.appendSlice(a, if (i % 3 == 0) "]" else ",\"10\":3}");
    }
    const v = try parse(a, text.items, .{});
    const out = try stringifyAlloc(a, v);
    // Expected: index keys first ("2", "10"), then "b", "x".
    var want: std.ArrayList(u8) = .empty;
    for (0..depth) |j| try want.appendSlice(a, if (j % 3 == 0) "[0," else "{\"2\":2,\"10\":3,\"b\":1,\"x\":");
    try want.appendSlice(a, "\"\\u0001\"");
    i = depth;
    while (i > 0) {
        i -= 1;
        try want.appendSlice(a, if (i % 3 == 0) "]" else "}");
    }
    try testing.expectEqualStrings(want.items, out);
    try testing.expectEqualStrings("[[],{},[{}],{\"a\":[]}]", try stringifyAlloc(a, try parse(a, "[[],{},[{}],{\"a\":[]}]", .{})));
}

test "parse keeps first position for duplicates in large objects" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var src: std.ArrayList(u8) = .empty;
    try src.append(a, '{');
    for (0..40) |i| try src.print(a, "\"k{d}\":{d},", .{ i, i });
    try src.appendSlice(a, "\"k3\":99}");
    const v = try parse(a, src.items, .{});
    try testing.expectEqual(@as(usize, 40), v.object.len);
    try testing.expectEqual(@as(f64, 99), v.get("k3").?.number);
    try testing.expectEqualStrings("k3", v.object[3].key);
}

test "toWellFormedUtf8 replaces invalid sequences like Buffer#toString" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("abc", try toWellFormedUtf8(a, "abc"));
    try testing.expectEqualStrings("a\u{fffd}b", try toWellFormedUtf8(a, "a\xffb"));
    try testing.expectEqualStrings("\u{fffd}\u{fffd}", try toWellFormedUtf8(a, "\xed\xa0\x80"[0..2] ++ ""));
    try testing.expectEqualStrings("\u{fffd}x", try toWellFormedUtf8(a, "\xe2\x82x"));
}
