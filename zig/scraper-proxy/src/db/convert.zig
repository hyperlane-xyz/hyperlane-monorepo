//! node-pg value conversion (pg-types 2 text parsers with the overrides in
//! `src/db/db.service.ts`: bytea(17), timestamp(1114), interval(1186) raw text).
//!
//! | OID(s)                      | JS value                         | Value      |
//! | --------------------------- | -------------------------------- | ---------- |
//! | 16 bool                     | boolean                          | .bool      |
//! | 21 int2, 23 int4, 26 oid    | parseInt                         | .number    |
//! | 700 float4, 701 float8      | parseFloat (NaN/Infinity kept)   | .number    |
//! | 20 int8, 1700 numeric       | string                           | .string    |
//! | 114 json, 3802 jsonb        | JSON.parse                       | parsed     |
//! | 1184 timestamptz, 1082 date | Date -> JSON ISO string          | .string    |
//! | 1000/1005/1007/1028/1016/1021/1022/1231/1009/1015/1014/1008/2951/... arrays | element-converted arrays | .array |
//! | everything else             | raw text                         | .string    |
//!
//! Dates: `Date` values are represented by `JSON.stringify(date)` (ISO UTC,
//! millisecond precision, invalid -> null). `date`/`timestamp[]` without a zone
//! are interpreted in UTC (node-pg uses the process zone, which is UTC in the
//! deployed node:alpine image; differs only if TZ is set to a non-UTC zone).
const std = @import("std");
const core = @import("core");
const Value = core.json.Value;
const Allocator = std.mem.Allocator;

pub fn convertText(a: Allocator, oid: u32, text: []const u8) Allocator.Error!Value {
    return convertCell(a, oid, text, .copy);
}

pub const TextOwnership = enum {
    /// `text` is transient (libpq memory): copy it into `a` when kept.
    copy,
    /// `text` already lives in `a`'s lifetime: string results alias it.
    borrow,
};

pub fn convertCell(a: Allocator, oid: u32, text: []const u8, ownership: TextOwnership) Allocator.Error!Value {
    return switch (oid) {
        16 => .{ .bool = parseBool(text) },
        21, 23, 26 => .{ .number = parseInt(text) },
        700, 701 => .{ .number = parseFloatJs(text) },
        114, 3802 => core.json.parse(a, text, .{}) catch .{ .string = try keep(a, text, ownership) },
        1184, 1082 => try dateValue(a, text),
        1000 => try arrayValue(a, text, .bool),
        1005, 1007, 1028 => try arrayValue(a, text, .int),
        1021, 1022, 1231 => try arrayValue(a, text, .float),
        1016 => try arrayValue(a, text, .bigint),
        1001 => try arrayValue(a, text, .bytea),
        199, 3807 => try arrayValue(a, text, .json),
        1115, 1182, 1185 => try arrayValue(a, text, .date),
        651, 1008, 1009, 1014, 1015, 1040, 1041, 3907, 2951, 791, 1183, 1270 => try arrayValue(a, text, .string),
        else => .{ .string = try keep(a, text, ownership) },
    };
}

fn keep(a: Allocator, text: []const u8, ownership: TextOwnership) Allocator.Error![]const u8 {
    return switch (ownership) {
        .copy => try a.dupe(u8, text),
        .borrow => text,
    };
}

fn parseBool(text: []const u8) bool {
    const truthy = [_][]const u8{ "TRUE", "t", "true", "y", "yes", "on", "1" };
    for (truthy) |t| if (std.mem.eql(u8, text, t)) return true;
    return false;
}

/// JS `parseInt(text, 10)` for well-formed integer text.
fn parseInt(text: []const u8) f64 {
    const v = std.fmt.parseInt(i64, std.mem.trim(u8, text, " "), 10) catch return std.math.nan(f64);
    return @floatFromInt(v);
}

/// JS `parseFloat` for PostgreSQL float output (`NaN`, `Infinity`, `-Infinity`).
fn parseFloatJs(text: []const u8) f64 {
    const t = std.mem.trim(u8, text, " ");
    if (std.mem.eql(u8, t, "NaN")) return std.math.nan(f64);
    if (std.mem.eql(u8, t, "Infinity")) return std.math.inf(f64);
    if (std.mem.eql(u8, t, "-Infinity")) return -std.math.inf(f64);
    return std.fmt.parseFloat(f64, t) catch std.math.nan(f64);
}

const Element = enum { bool, int, float, bigint, string, json, bytea, date };

fn convertElement(a: Allocator, kind: Element, text: []const u8) Allocator.Error!Value {
    return switch (kind) {
        .bool => .{ .bool = parseBool(text) },
        .int => .{ .number = parseInt(text) },
        .float => .{ .number = parseFloatJs(text) },
        .bigint => .{ .string = try a.dupe(u8, std.mem.trim(u8, text, " ")) },
        .string => .{ .string = try a.dupe(u8, text) },
        .json => core.json.parse(a, text, .{}) catch .{ .string = try a.dupe(u8, text) },
        .bytea => try bufferValue(a, text),
        .date => try dateValue(a, text),
    };
}

/// postgres-array `parse` (quotes, backslash escapes, NULL, nesting,
/// optional `[l:u]=` dimension prefix).
fn arrayValue(a: Allocator, text: []const u8, kind: Element) Allocator.Error!Value {
    var p: ArrayParser = .{ .s = text, .a = a, .kind = kind };
    if (p.s.len > 0 and p.s[0] == '[') {
        if (std.mem.indexOfScalar(u8, p.s, '=')) |eq| p.i = eq + 1;
    }
    return p.parse() catch |e| switch (e) {
        error.OutOfMemory => error.OutOfMemory,
        error.Malformed => .{ .string = try a.dupe(u8, text) },
    };
}

const ArrayParser = struct {
    s: []const u8,
    i: usize = 0,
    a: Allocator,
    kind: Element,

    fn parse(p: *ArrayParser) error{ OutOfMemory, Malformed }!Value {
        if (p.i >= p.s.len or p.s[p.i] != '{') return error.Malformed;
        p.i += 1;
        var items: std.ArrayList(Value) = .empty;
        while (p.i < p.s.len) {
            const c = p.s[p.i];
            switch (c) {
                '}' => {
                    p.i += 1;
                    return .{ .array = try items.toOwnedSlice(p.a) };
                },
                ',' => p.i += 1,
                '{' => try items.append(p.a, try p.parse()),
                '"' => {
                    p.i += 1;
                    var buf: std.ArrayList(u8) = .empty;
                    while (p.i < p.s.len and p.s[p.i] != '"') : (p.i += 1) {
                        if (p.s[p.i] == '\\' and p.i + 1 < p.s.len) p.i += 1;
                        try buf.append(p.a, p.s[p.i]);
                    }
                    if (p.i >= p.s.len) return error.Malformed;
                    p.i += 1;
                    try items.append(p.a, try convertElement(p.a, p.kind, buf.items));
                },
                else => {
                    const start = p.i;
                    while (p.i < p.s.len and p.s[p.i] != ',' and p.s[p.i] != '}') p.i += 1;
                    const raw = p.s[start..p.i];
                    if (std.ascii.eqlIgnoreCase(raw, "NULL")) {
                        try items.append(p.a, .null);
                    } else try items.append(p.a, try convertElement(p.a, p.kind, raw));
                },
            }
        }
        return error.Malformed;
    }
};

/// node `Buffer#toJSON` for a bytea hex literal (`\x...`).
fn bufferValue(a: Allocator, text: []const u8) Allocator.Error!Value {
    var bytes: std.ArrayList(Value) = .empty;
    if (std.mem.startsWith(u8, text, "\\x")) {
        var i: usize = 2;
        while (i + 1 < text.len) : (i += 2) {
            const b = std.fmt.parseInt(u8, text[i .. i + 2], 16) catch break;
            try bytes.append(a, .{ .number = @floatFromInt(b) });
        }
    } else for (text) |b| try bytes.append(a, .{ .number = @floatFromInt(b) });
    const members = try a.alloc(core.json.Member, 2);
    members[0] = .{ .key = buffer_type_key, .value = .{ .string = "Buffer" } };
    members[1] = .{ .key = "data", .value = .{ .array = try bytes.toOwnedSlice(a) } };
    return .{ .object = members };
}

/// Buffers (bytea[] elements) are `Buffer#toJSON` objects whose first key is
/// this exact slice. The pointer identity marks DB-originated Buffers, so
/// client JSON that merely looks like `{"type":"Buffer",...}` stays an object.
const buffer_type_key: []const u8 = "type";

/// The bytes of a DB-originated Buffer value, or null.
pub fn bufferBytes(a: Allocator, v: Value) Allocator.Error!?[]u8 {
    if (v != .object or v.object.len != 2) return null;
    const first = v.object[0];
    if (first.key.ptr != buffer_type_key.ptr or first.key.len != buffer_type_key.len) return null;
    const data = v.object[1].value;
    if (data != .array) return null;
    const out = try a.alloc(u8, data.array.len);
    for (data.array, out) |item, *b| b.* = @intFromFloat(item.number);
    return out;
}

/// Wraps raw bytes as a Buffer value (what node-pg returns for bytea[] items).
pub fn bufferValueFromBytes(a: Allocator, bytes: []const u8) Allocator.Error!Value {
    const items = try a.alloc(Value, bytes.len);
    for (bytes, items) |b, *item| item.* = .{ .number = @floatFromInt(b) };
    const members = try a.alloc(core.json.Member, 2);
    members[0] = .{ .key = buffer_type_key, .value = .{ .string = "Buffer" } };
    members[1] = .{ .key = "data", .value = .{ .array = items } };
    return .{ .object = members };
}

/// postgres-date -> `JSON.stringify(Date)`.
fn dateValue(a: Allocator, text: []const u8) Allocator.Error!Value {
    const ms = parseDateMs(text) orelse return .null;
    return .{ .string = try isoString(a, ms) orelse return .null };
}

/// Milliseconds since the epoch, or null for infinity/invalid input.
pub fn parseDateMs(text: []const u8) ?i64 {
    var s = text;
    var bc = false;
    if (std.mem.endsWith(u8, s, " BC")) {
        bc = true;
        s = s[0 .. s.len - 3];
    }
    if (s.len < 10) return null;
    const dash = std.mem.indexOfScalarPos(u8, s, 1, '-') orelse return null;
    var year = std.fmt.parseInt(i64, s[0..dash], 10) catch return null;
    if (bc) year = 1 - year;
    if (dash + 6 > s.len) return null;
    const month = std.fmt.parseInt(i64, s[dash + 1 .. dash + 3], 10) catch return null;
    const day = std.fmt.parseInt(i64, s[dash + 4 .. dash + 6], 10) catch return null;
    var rest = s[dash + 6 ..];
    var ms: i64 = daysFromCivil(year, month, day) * 86_400_000;
    if (rest.len == 0) return ms;
    if (rest[0] != ' ' and rest[0] != 'T') return null;
    rest = rest[1..];
    if (rest.len < 8) return null;
    const hh = std.fmt.parseInt(i64, rest[0..2], 10) catch return null;
    const mm = std.fmt.parseInt(i64, rest[3..5], 10) catch return null;
    const ss = std.fmt.parseInt(i64, rest[6..8], 10) catch return null;
    ms += ((hh * 60 + mm) * 60 + ss) * 1000;
    rest = rest[8..];
    if (rest.len > 0 and rest[0] == '.') {
        var end: usize = 1;
        while (end < rest.len and std.ascii.isDigit(rest[end])) end += 1;
        // 1000 * parseFloat('0.' + fraction), truncated by Date.UTC.
        var frac: i64 = 0;
        var scale: i64 = 100;
        for (rest[1..end]) |d| {
            if (scale == 0) break;
            frac += (d - '0') * scale;
            scale = @divTrunc(scale, 10);
        }
        ms += frac;
        rest = rest[end..];
    }
    if (rest.len > 0) {
        if (rest[0] == 'Z') return ms;
        if (rest[0] != '+' and rest[0] != '-') return null;
        const sign: i64 = if (rest[0] == '-') -1 else 1;
        const parts = rest[1..];
        const oh = std.fmt.parseInt(i64, parts[0..@min(2, parts.len)], 10) catch return null;
        var offset_s = oh * 3600;
        if (parts.len >= 5 and parts[2] == ':') offset_s += (std.fmt.parseInt(i64, parts[3..5], 10) catch return null) * 60;
        if (parts.len >= 8 and parts[5] == ':') offset_s += std.fmt.parseInt(i64, parts[6..8], 10) catch return null;
        ms -= sign * offset_s * 1000;
    }
    return ms;
}

fn daysFromCivil(y_in: i64, m: i64, d: i64) i64 {
    const y = if (m <= 2) y_in - 1 else y_in;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400;
    const mp = @mod(m + 9, 12);
    const doy = @divFloor(153 * mp + 2, 5) + d - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

/// `Date#toISOString` (null outside the ±8.64e15 ms range like Invalid Date).
pub fn isoString(a: Allocator, ms: i64) Allocator.Error!?[]const u8 {
    if (ms > 8_640_000_000_000_000 or ms < -8_640_000_000_000_000) return null;
    const days = @divFloor(ms, 86_400_000);
    const in_day = @mod(ms, 86_400_000);
    const z = days + 719468;
    const era = @divFloor(z, 146097);
    const doe = z - era * 146097;
    const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
    const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
    const mp = @divFloor(5 * doy + 2, 153);
    const d = doy - @divFloor(153 * mp + 2, 5) + 1;
    const m = if (mp < 10) mp + 3 else mp - 9;
    const y = yoe + era * 400 + @as(i64, if (m <= 2) 1 else 0);
    const hh = @divFloor(in_day, 3_600_000);
    const mi = @divFloor(@mod(in_day, 3_600_000), 60_000);
    const ss = @divFloor(@mod(in_day, 60_000), 1000);
    const mss = @mod(in_day, 1000);
    if (y >= 0 and y <= 9999) {
        // Hot path (every timestamptz cell): fixed-width digits, no fmt.
        const out = try a.alloc(u8, 24);
        putDigits(out[0..4], @intCast(y));
        out[4] = '-';
        putDigits(out[5..7], @intCast(m));
        out[7] = '-';
        putDigits(out[8..10], @intCast(d));
        out[10] = 'T';
        putDigits(out[11..13], @intCast(hh));
        out[13] = ':';
        putDigits(out[14..16], @intCast(mi));
        out[16] = ':';
        putDigits(out[17..19], @intCast(ss));
        out[19] = '.';
        putDigits(out[20..23], @intCast(mss));
        out[23] = 'Z';
        return out;
    }
    const sign: u8 = if (y < 0) '-' else '+';
    return try std.fmt.allocPrint(a, "{c}{d:0>6}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        sign, @as(u64, @intCast(@abs(y))), @as(u64, @intCast(m)), @as(u64, @intCast(d)), @as(u64, @intCast(hh)), @as(u64, @intCast(mi)), @as(u64, @intCast(ss)), @as(u64, @intCast(mss)),
    });
}

/// Zero-padded decimal `n` filling `out` (n < 10^out.len).
fn putDigits(out: []u8, n: u64) void {
    var v = n;
    var i = out.len;
    while (i > 0) {
        i -= 1;
        out[i] = @intCast('0' + v % 10);
        v /= 10;
    }
}

// ---------------------------------------------------------------------------
// Parameters (node-pg prepareValue)
// ---------------------------------------------------------------------------

/// node-pg `prepareValue` for a JS-like value; null -> SQL NULL.
pub fn prepareValue(a: Allocator, v: Value) Allocator.Error!?[:0]const u8 {
    return switch (v) {
        .null => null,
        .bool => |b| try a.dupeZ(u8, if (b) "true" else "false"),
        .number => |n| blk: {
            var buf: [64]u8 = undefined;
            break :blk try a.dupeZ(u8, core.json.formatNumber(&buf, n));
        },
        .raw => |r| try a.dupeZ(u8, r),
        .string => |s| try a.dupeZ(u8, s),
        .array => |items| blk: {
            var out: std.ArrayList(u8) = .empty;
            try arrayString(a, &out, items);
            break :blk try out.toOwnedSliceSentinel(a, 0);
        },
        .object => blk: {
            // node-pg sends a Buffer as bytea; `\x<hex>` text is the same value.
            if (try bufferBytes(a, v)) |bytes| break :blk try std.fmt.allocPrintSentinel(a, "\\x{x}", .{bytes}, 0);
            const text = try core.json.stringifyAlloc(a, v);
            break :blk try a.dupeZ(u8, text);
        },
    };
}

fn arrayString(a: Allocator, out: *std.ArrayList(u8), items: []const Value) Allocator.Error!void {
    try out.append(a, '{');
    for (items, 0..) |item, i| {
        if (i > 0) try out.append(a, ',');
        switch (item) {
            .null => try out.appendSlice(a, "NULL"),
            .array => |nested| try arrayString(a, out, nested),
            .object => if (try bufferBytes(a, item)) |bytes| {
                // node-pg arrayString: unquoted `\\x<hex>` for Buffers.
                try out.print(a, "\\\\x{x}", .{bytes});
            } else try appendQuoted(a, out, item),
            else => try appendQuoted(a, out, item),
        }
    }
    try out.append(a, '}');
}

fn appendQuoted(a: Allocator, out: *std.ArrayList(u8), item: Value) Allocator.Error!void {
    const text = (try prepareValue(a, item)).?;
    try out.append(a, '"');
    for (text) |c| {
        if (c == '\\' or c == '"') try out.append(a, '\\');
        try out.append(a, c);
    }
    try out.append(a, '"');
}

/// `logValue` + `JSON.stringify` from db.service.ts for query logs: strings
/// over 500 UTF-16 units truncated with `… (N chars)`, arrays over 10 items
/// summarised as `{count, sample}`.
pub fn logValue(a: Allocator, v: Value) Allocator.Error!Value {
    switch (v) {
        .string => |s| {
            const units = utf16Len(s);
            if (units <= 500) return v;
            const cut = utf16Prefix(s, 500);
            return .{ .string = try std.fmt.allocPrint(a, "{s}… ({d} chars)", .{ cut, units }) };
        },
        .array => |items| {
            const mapped = try a.alloc(Value, items.len);
            for (items, mapped) |item, *m| m.* = try logValue(a, item);
            if (mapped.len <= 10) return .{ .array = mapped };
            const sample = try a.alloc(Value, 9);
            @memcpy(sample[0..8], mapped[0..8]);
            sample[8] = .{ .string = "…" };
            const members = try a.alloc(core.json.Member, 2);
            members[0] = .{ .key = "count", .value = .{ .number = @floatFromInt(mapped.len) } };
            members[1] = .{ .key = "sample", .value = .{ .array = sample } };
            return .{ .object = members };
        },
        .object => |members| {
            const out = try a.alloc(core.json.Member, members.len);
            for (members, out) |m, *o| o.* = .{ .key = m.key, .value = try logValue(a, m.value) };
            return .{ .object = out };
        },
        else => return v,
    }
}

fn utf16Len(s: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const len = std.unicode.utf8ByteSequenceLength(s[i]) catch 1;
        n += if (len == 4) 2 else 1;
        i += len;
    }
    return n;
}

/// First `units` UTF-16 code units (a split surrogate pair keeps its first
/// half as a WTF-8 lone surrogate, like `String#slice`).
fn utf16Prefix(s: []const u8, units: usize) []const u8 {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len and n < units) {
        const len = std.unicode.utf8ByteSequenceLength(s[i]) catch 1;
        const w: usize = if (len == 4) 2 else 1;
        if (n + w > units) break;
        n += w;
        i += len;
    }
    return s[0..@min(i, s.len)];
}

const testing = std.testing;

test "convertText follows pg-types with TS overrides" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const J = core.json;
    const cases = [_]struct { oid: u32, text: []const u8, json: []const u8 }{
        .{ .oid = 16, .text = "t", .json = "true" },
        .{ .oid = 16, .text = "f", .json = "false" },
        .{ .oid = 23, .text = "-42", .json = "-42" },
        .{ .oid = 20, .text = "9007199254740993", .json = "\"9007199254740993\"" },
        .{ .oid = 1700, .text = "123.4500", .json = "\"123.4500\"" },
        .{ .oid = 701, .text = "0.1", .json = "0.1" },
        .{ .oid = 701, .text = "NaN", .json = "null" },
        .{ .oid = 701, .text = "1e+21", .json = "1e+21" },
        .{ .oid = 3802, .text = "{\"b\": 1, \"a\": [1, 2.50]}", .json = "{\"b\":1,\"a\":[1,2.5]}" },
        .{ .oid = 17, .text = "\\x0102", .json = "\"\\\\x0102\"" },
        .{ .oid = 1114, .text = "2026-09-14 12:00:00.123456", .json = "\"2026-09-14 12:00:00.123456\"" },
        .{ .oid = 1186, .text = "00:00:01.5", .json = "\"00:00:01.5\"" },
        .{ .oid = 1184, .text = "2026-09-14 12:00:00.123456+02", .json = "\"2026-09-14T10:00:00.123Z\"" },
        .{ .oid = 1184, .text = "infinity", .json = "null" },
        .{ .oid = 1082, .text = "2024-02-29", .json = "\"2024-02-29T00:00:00.000Z\"" },
        .{ .oid = 1007, .text = "{1,NULL,3}", .json = "[1,null,3]" },
        .{ .oid = 1016, .text = "{1,2}", .json = "[\"1\",\"2\"]" },
        .{ .oid = 1231, .text = "{1.5,2}", .json = "[1.5,2]" },
        .{ .oid = 1009, .text = "{a,\"b,c\",\"d\\\"e\",NULL,\"NULL\"}", .json = "[\"a\",\"b,c\",\"d\\\"e\",null,\"NULL\"]" },
        .{ .oid = 1007, .text = "{{1,2},{3,4}}", .json = "[[1,2],[3,4]]" },
        .{ .oid = 1007, .text = "[0:1]={7,8}", .json = "[7,8]" },
        .{ .oid = 25, .text = "plain", .json = "\"plain\"" },
    };
    for (cases) |case| {
        const v = try convertText(a, case.oid, case.text);
        try testing.expectEqualStrings(case.json, try J.stringifyAlloc(a, v));
    }
}

test "prepareValue matches node-pg" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expect((try prepareValue(a, .null)) == null);
    try testing.expectEqualStrings("1e+21", (try prepareValue(a, .{ .number = 1e21 })).?);
    try testing.expectEqualStrings("true", (try prepareValue(a, .{ .bool = true })).?);
    var items = [_]Value{ .{ .string = "a\"b\\c" }, .null, .{ .number = 2 } };
    try testing.expectEqualStrings("{\"a\\\"b\\\\c\",NULL,\"2\"}", (try prepareValue(a, .{ .array = &items })).?);
    var members = [_]core.json.Member{.{ .key = "k", .value = .{ .number = 1 } }};
    try testing.expectEqualStrings("{\"k\":1}", (try prepareValue(a, .{ .object = &members })).?);
    // DB-originated Buffers bind as bytea; lookalike client JSON does not.
    const buf = try bufferValueFromBytes(a, "\x01\xab");
    try testing.expectEqualStrings("\\x01ab", (try prepareValue(a, buf)).?);
    var bufs = [_]Value{ buf, .null };
    try testing.expectEqualStrings("{\\\\x01ab,NULL}", (try prepareValue(a, .{ .array = &bufs })).?);
    const roundtrip = try convertText(a, 1001, "{\"\\\\x01ab\"}");
    try testing.expectEqualStrings("{\\\\x01ab}", (try prepareValue(a, roundtrip)).?);
    const lookalike = try core.json.parse(a, "{\"type\":\"Buffer\",\"data\":[1]}", .{});
    try testing.expectEqualStrings("{\"type\":\"Buffer\",\"data\":[1]}", (try prepareValue(a, lookalike)).?);
}

test "logValue truncates long strings and summarises long arrays" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const long = "x" ** 501;
    const v = try logValue(a, .{ .string = long });
    try testing.expectEqualStrings("x" ** 500 ++ "… (501 chars)", v.string);
    var items: [11]Value = undefined;
    for (&items, 0..) |*item, i| item.* = .{ .number = @floatFromInt(i) };
    const s = try core.json.stringifyAlloc(a, try logValue(a, .{ .array = &items }));
    try testing.expectEqualStrings("{\"count\":11,\"sample\":[0,1,2,3,4,5,6,7,\"…\"]}", s);
}

test "isoString matches the zero-padded fmt rendering across the 4-digit range" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const r = prng.random();
    const lo: i64 = -62_167_219_200_000; // 0000-01-01T00:00:00.000Z
    const hi: i64 = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
    var i: usize = 0;
    while (i < 200_000) : (i += 1) {
        const ms = switch (i) {
            0 => lo,
            1 => hi,
            2 => 0,
            3 => -1,
            else => r.intRangeAtMost(i64, lo, hi),
        };
        const fast = (try isoString(a, ms)).?;
        const days = @divFloor(ms, 86_400_000);
        const in_day = @mod(ms, 86_400_000);
        const z = days + 719468;
        const era = @divFloor(z, 146097);
        const doe = z - era * 146097;
        const yoe = @divFloor(doe - @divFloor(doe, 1460) + @divFloor(doe, 36524) - @divFloor(doe, 146096), 365);
        const doy = doe - (365 * yoe + @divFloor(yoe, 4) - @divFloor(yoe, 100));
        const mp = @divFloor(5 * doy + 2, 153);
        const d = doy - @divFloor(153 * mp + 2, 5) + 1;
        const m = if (mp < 10) mp + 3 else mp - 9;
        const y = yoe + era * 400 + @as(i64, if (m <= 2) 1 else 0);
        const expected = try std.fmt.allocPrint(a, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
            @as(u64, @intCast(y)),                            @as(u64, @intCast(m)),                         @as(u64, @intCast(d)),
            @as(u64, @intCast(@divFloor(in_day, 3_600_000))), @as(u64, @intCast(@divFloor(@mod(in_day, 3_600_000), 60_000))), @as(u64, @intCast(@divFloor(@mod(in_day, 60_000), 1000))),
            @as(u64, @intCast(@mod(in_day, 1000))),
        });
        try testing.expectEqualStrings(expected, fast);
    }
    try testing.expectEqualStrings("+010000-01-01T00:00:00.000Z", (try isoString(a, hi + 1)).?);
    try testing.expectEqualStrings("-000001-12-31T23:59:59.999Z", (try isoString(a, lo - 1)).?);
}
