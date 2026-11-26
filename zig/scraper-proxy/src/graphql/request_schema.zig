//! Mercurius route schemas as Fastify validates them (ajv, `coerceTypes:
//! 'array'`, `allErrors: false`): POST body / GET querystring coercion and
//! the `body/variables must be object,null` style messages. Also Fastify's
//! querystring parser (fast-querystring + fast-decode-uri-component).
const std = @import("std");
const json = @import("core").json;
const js = @import("js.zig");

const Value = json.Value;
const Member = json.Member;
const Allocator = std.mem.Allocator;

const T = enum { string, boolean, null, object };

const Property = struct { name: []const u8, types: []const T };

const post_properties = [_]Property{
    .{ .name = "query", .types = &.{.string} },
    .{ .name = "persisted", .types = &.{.boolean} },
    .{ .name = "operationName", .types = &.{ .string, .null } },
    .{ .name = "variables", .types = &.{ .object, .null } },
    .{ .name = "extensions", .types = &.{.object} },
};

const get_properties = [_]Property{
    .{ .name = "query", .types = &.{.string} },
    .{ .name = "persisted", .types = &.{.boolean} },
    .{ .name = "operationName", .types = &.{ .string, .null } },
    .{ .name = "variables", .types = &.{.string} },
    .{ .name = "extensions", .types = &.{.string} },
};

pub const Validated = union(enum) {
    /// Coerced request object (properties replaced in place, like ajv).
    ok: Value,
    /// Fastify `request.validationError.message`.
    invalid: []const u8,
};

pub fn validateBody(a: Allocator, body: Value) Allocator.Error!Validated {
    return validateObject(a, body, "body", &post_properties);
}

pub fn validateQuerystring(a: Allocator, query: Value) Allocator.Error!Validated {
    return validateObject(a, query, "querystring", &get_properties);
}

fn validateObject(a: Allocator, data: Value, data_var: []const u8, properties: []const Property) Allocator.Error!Validated {
    if (data != .object) return .{ .invalid = try std.fmt.allocPrint(a, "{s} must be object", .{data_var}) };
    const members = try a.dupe(Member, data.object);
    for (properties) |prop| {
        for (members) |*m| {
            if (!std.mem.eql(u8, m.key, prop.name)) continue;
            m.value = (try coerce(a, m.value, prop.types)) orelse {
                var names: std.ArrayList(u8) = .empty;
                for (prop.types, 0..) |t, i| {
                    if (i > 0) try names.append(a, ',');
                    try names.appendSlice(a, @tagName(t));
                }
                return .{ .invalid = try std.fmt.allocPrint(a, "{s}/{s} must be {s}", .{ data_var, prop.name, names.items }) };
            };
        }
    }
    return .{ .ok = .{ .object = members } };
}

fn matches(v: Value, t: T) bool {
    return switch (t) {
        .string => v == .string,
        .boolean => v == .bool,
        .null => v == .null,
        .object => v == .object,
    };
}

/// ajv coercion (`coerceTypes: 'array'`); null when invalid.
fn coerce(a: Allocator, v: Value, types: []const T) Allocator.Error!?Value {
    for (types) |t| if (matches(v, t)) return v;
    var data = v;
    if (data == .array and data.array.len == 1) {
        data = data.array[0];
        // ajv accepts the unwrapped item as-is only for single-type schemas.
        if (types.len == 1 and matches(data, types[0])) return data;
    }
    for (types) |t| switch (t) {
        .string => switch (data) {
            .number, .raw => return .{ .string = try js.numberString(a, js.asNumber(data).?) },
            .bool => |b| return .{ .string = if (b) "true" else "false" },
            .null => return .{ .string = "" },
            else => {},
        },
        .boolean => {
            if (isString(data, "false") or isNumber(data, 0) or data == .null) return .{ .bool = false };
            if (isString(data, "true") or isNumber(data, 1)) return .{ .bool = true };
        },
        .null => if (isString(data, "") or isNumber(data, 0) or (data == .bool and !data.bool)) return .null,
        .object => {},
    };
    return null;
}

fn isString(v: Value, s: []const u8) bool {
    return v == .string and std.mem.eql(u8, v.string, s);
}

fn isNumber(v: Value, n: f64) bool {
    const x = js.asNumber(v) orelse return false;
    return x == n;
}

/// fast-querystring `parse`: `+` -> space, percent-decoding with raw fallback,
/// repeated keys become arrays.
pub fn parseQuerystring(a: Allocator, input: []const u8) Allocator.Error!Value {
    var members: std.ArrayList(Member) = .empty;
    var it = std.mem.splitScalar(u8, input, '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=');
        const raw_key = if (eq) |e| pair[0..e] else pair;
        if (eq == null and raw_key.len == 0) continue;
        const key = try decodeComponent(a, raw_key);
        const val: []const u8 = if (eq) |e| try decodeComponent(a, pair[e + 1 ..]) else "";
        for (members.items) |*m| {
            if (!std.mem.eql(u8, m.key, key)) continue;
            if (m.value == .array) {
                const grown = try a.alloc(Value, m.value.array.len + 1);
                @memcpy(grown[0..m.value.array.len], m.value.array);
                grown[m.value.array.len] = .{ .string = val };
                m.value = .{ .array = grown };
            } else {
                const pairv = try a.alloc(Value, 2);
                pairv[0] = m.value;
                pairv[1] = .{ .string = val };
                m.value = .{ .array = pairv };
            }
            break;
        } else try members.append(a, .{ .key = key, .value = .{ .string = val } });
    }
    return .{ .object = members.items };
}

fn decodeComponent(a: Allocator, raw: []const u8) Allocator.Error![]const u8 {
    const plus = std.mem.indexOfScalar(u8, raw, '+') != null;
    const pct = std.mem.indexOfScalar(u8, raw, '%') != null;
    if (!plus and !pct) return raw;
    const spaced = if (plus) try std.mem.replaceOwned(u8, a, raw, "+", " ") else raw;
    if (!pct) return spaced;
    return (try percentDecode(a, spaced)) orelse spaced;
}

/// fast-decode-uri-component: null on malformed escapes or invalid UTF-8.
fn percentDecode(a: Allocator, s: []const u8) Allocator.Error!?[]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] != '%') {
            try out.append(a, s[i]);
            i += 1;
            continue;
        }
        if (i + 3 > s.len) return null;
        const byte = std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch return null;
        try out.append(a, byte);
        i += 3;
    }
    if (!std.unicode.utf8ValidateSlice(out.items)) return null;
    return out.items;
}

test "ajv coercion matrix" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const Case = struct { types: []const T, input: []const u8, want: ?[]const u8 };
    const cases = [_]Case{
        .{ .types = &.{.string}, .input = "5", .want = "\"5\"" },
        .{ .types = &.{.string}, .input = "1e21", .want = "\"1e+21\"" },
        .{ .types = &.{.string}, .input = "null", .want = "\"\"" },
        .{ .types = &.{.string}, .input = "[\"x\"]", .want = "\"x\"" },
        .{ .types = &.{.string}, .input = "[null]", .want = "\"\"" },
        .{ .types = &.{.string}, .input = "[]", .want = null },
        .{ .types = &.{.string}, .input = "{}", .want = null },
        .{ .types = &.{.boolean}, .input = "null", .want = "false" },
        .{ .types = &.{.boolean}, .input = "1", .want = "true" },
        .{ .types = &.{.boolean}, .input = "\"1\"", .want = null },
        .{ .types = &.{.boolean}, .input = "[true]", .want = "true" },
        .{ .types = &.{ .string, .null }, .input = "[\"x\"]", .want = null },
        .{ .types = &.{ .string, .null }, .input = "[5]", .want = "\"5\"" },
        .{ .types = &.{ .string, .null }, .input = "[null]", .want = "\"\"" },
        .{ .types = &.{ .string, .null }, .input = "false", .want = "\"false\"" },
        .{ .types = &.{ .object, .null }, .input = "false", .want = "null" },
        .{ .types = &.{ .object, .null }, .input = "\"\"", .want = "null" },
        .{ .types = &.{ .object, .null }, .input = "1", .want = null },
        .{ .types = &.{ .object, .null }, .input = "[{}]", .want = null },
        .{ .types = &.{ .object, .null }, .input = "[null]", .want = null },
    };
    for (cases) |c| {
        const got = try coerce(a, try json.parse(a, c.input, .{}), c.types);
        if (c.want) |w| {
            try std.testing.expectEqualStrings(w, try json.stringifyAlloc(a, got.?));
        } else try std.testing.expect(got == null);
    }
}

test "querystring parsing" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const q = try parseQuerystring(a, "query={+domain+{+id+}+}&x=%7B&x=2&bad=%ZZ&flag&=v");
    try std.testing.expectEqualStrings("{\"query\":\"{ domain { id } }\",\"x\":[\"{\",\"2\"],\"bad\":\"%ZZ\",\"flag\":\"\",\"\":\"v\"}", try json.stringifyAlloc(a, q));
}
