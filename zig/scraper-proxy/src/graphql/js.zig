//! JavaScript semantics needed by graphql-js ports: `inspect`, `Number(string)`,
//! `String(number)` and `Object.keys` order over `core.json.Value`.
const std = @import("std");
const json = @import("core").json;

const Value = json.Value;
const Allocator = std.mem.Allocator;

const max_array_length = 10;
const max_recursive_depth = 2;

/// graphql-js `inspect(value)`.
pub fn inspect(a: Allocator, value: Value) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try formatValue(a, &out, value, 0);
    return out.items;
}

fn formatValue(a: Allocator, out: *std.ArrayList(u8), value: Value, seen: usize) Allocator.Error!void {
    switch (value) {
        .string => |s| try writeJsonString(a, out, s),
        .null => try out.appendSlice(a, "null"),
        .bool => |b| try out.appendSlice(a, if (b) "true" else "false"),
        .number => |n| try appendNumber(a, out, n),
        .raw => |r| try appendNumber(a, out, std.fmt.parseFloat(f64, r) catch std.math.nan(f64)),
        .array => |items| {
            if (items.len == 0) return out.appendSlice(a, "[]");
            if (seen + 1 > max_recursive_depth) return out.appendSlice(a, "[Array]");
            const len = @min(max_array_length, items.len);
            try out.append(a, '[');
            for (items[0..len], 0..) |item, i| {
                if (i > 0) try out.appendSlice(a, ", ");
                try formatValue(a, out, item, seen + 1);
            }
            const remaining = items.len - len;
            if (remaining == 1) try out.appendSlice(a, ", ... 1 more item");
            if (remaining > 1) try out.print(a, ", ... {d} more items", .{remaining});
            try out.append(a, ']');
        },
        .object => |members| {
            if (members.len == 0) return out.appendSlice(a, "{}");
            if (seen + 1 > max_recursive_depth) return out.appendSlice(a, "[Object]");
            try out.appendSlice(a, "{ ");
            const order = try keyOrder(a, members);
            for (order, 0..) |idx, i| {
                if (i > 0) try out.appendSlice(a, ", ");
                try out.appendSlice(a, members[idx].key);
                try out.appendSlice(a, ": ");
                try formatValue(a, out, members[idx].value, seen + 1);
            }
            try out.appendSlice(a, " }");
        },
    }
}

fn writeJsonString(a: Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    var w: std.Io.Writer.Allocating = .fromArrayList(a, out);
    json.writeString(&w.writer, s) catch return error.OutOfMemory;
    out.* = w.toArrayList();
}

/// JS `String(number)`.
pub fn appendNumber(a: Allocator, out: *std.ArrayList(u8), n: f64) !void {
    if (std.math.isNan(n)) return out.appendSlice(a, "NaN");
    if (std.math.isInf(n)) return out.appendSlice(a, if (n > 0) "Infinity" else "-Infinity");
    var buf: [64]u8 = undefined;
    try out.appendSlice(a, json.formatNumber(&buf, n));
}

pub fn numberString(a: Allocator, n: f64) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try appendNumber(a, &out, n);
    return out.items;
}

/// `Object.keys` order: array-index keys ascending, then insertion order.
pub fn keyOrder(a: Allocator, members: []const json.Member) Allocator.Error![]const usize {
    const order = try a.alloc(usize, members.len);
    var n: usize = 0;
    var has_index = false;
    for (members) |m| if (json.arrayIndex(m.key) != null) {
        has_index = true;
        break;
    };
    if (has_index) {
        for (members, 0..) |m, i| if (json.arrayIndex(m.key) != null) {
            order[n] = i;
            n += 1;
        };
        std.mem.sort(usize, order[0..n], members, struct {
            fn lessThan(ms: []const json.Member, x: usize, y: usize) bool {
                return json.arrayIndex(ms[x].key).? < json.arrayIndex(ms[y].key).?;
            }
        }.lessThan);
    }
    for (members, 0..) |m, i| if (!has_index or json.arrayIndex(m.key) == null) {
        order[n] = i;
        n += 1;
    };
    return order;
}

/// JS `Number(string)` (StringToNumber); null for NaN.
pub fn stringToNumber(s: []const u8) ?f64 {
    const t = std.mem.trim(u8, s, " \t\n\r\x0b\x0c");
    if (t.len == 0) return 0;
    if (t.len > 2 and t[0] == '0') {
        const base: ?u8 = switch (t[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            'b', 'B' => 2,
            else => null,
        };
        if (base) |b| {
            var acc: f64 = 0;
            for (t[2..]) |c| {
                const d = std.fmt.charToDigit(c, b) catch return null;
                acc = acc * @as(f64, @floatFromInt(b)) + @as(f64, @floatFromInt(d));
            }
            return acc;
        }
    }
    var body = t;
    var negative = false;
    if (body[0] == '+' or body[0] == '-') {
        negative = body[0] == '-';
        body = body[1..];
    }
    if (std.mem.eql(u8, body, "Infinity")) return if (negative) -std.math.inf(f64) else std.math.inf(f64);
    // StrUnsignedDecimalLiteral: digits [. digits] [e[+-]digits] | . digits [exp]
    var i: usize = 0;
    var digits: usize = 0;
    while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) digits += 1;
    if (i < body.len and body[i] == '.') {
        i += 1;
        while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) digits += 1;
    }
    if (digits == 0) return null;
    if (i < body.len and (body[i] == 'e' or body[i] == 'E')) {
        i += 1;
        if (i < body.len and (body[i] == '+' or body[i] == '-')) i += 1;
        const start = i;
        while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) {}
        if (i == start) return null;
    }
    if (i != body.len) return null;
    const v = std.fmt.parseFloat(f64, body) catch return null;
    return if (negative) -v else v;
}

/// JS `typeof value === 'number'` view of a Value (raw numeric text counts).
pub fn asNumber(value: Value) ?f64 {
    return switch (value) {
        .number => |n| n,
        .raw => |r| std.fmt.parseFloat(f64, r) catch null,
        else => null,
    };
}

test "inspect matches graphql-js" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try std.testing.expectEqualStrings("\"x\"", try inspect(a, .{ .string = "x" }));
    try std.testing.expectEqualStrings("1.5", try inspect(a, .{ .number = 1.5 }));
    var inner = [_]json.Member{.{ .key = "b", .value = .{ .number = 1 } }};
    var deeper = [_]json.Member{.{ .key = "c", .value = .{ .object = &inner } }};
    var members = [_]json.Member{ .{ .key = "a", .value = .{ .object = &deeper } }, .{ .key = "1", .value = .null } };
    try std.testing.expectEqualStrings("{ 1: null, a: { c: [Object] } }", try inspect(a, .{ .object = &members }));
    var items: [12]Value = undefined;
    for (&items, 0..) |*it, i| it.* = .{ .number = @floatFromInt(i) };
    try std.testing.expectEqualStrings("[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, ... 2 more items]", try inspect(a, .{ .array = &items }));
    try std.testing.expectEqual(@as(?f64, 7), stringToNumber(" 7 "));
    try std.testing.expectEqual(@as(?f64, 31), stringToNumber("0x1F"));
    try std.testing.expectEqual(@as(?f64, null), stringToNumber("1_0"));
    try std.testing.expectEqual(@as(?f64, 0.5), stringToNumber(".5"));
}
