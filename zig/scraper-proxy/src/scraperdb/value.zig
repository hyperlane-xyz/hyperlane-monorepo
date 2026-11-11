//! The only place scraperdb touches the JSON value representation
//! (`core.json.Value`). Helpers mirror the JS semantics the TS builder relies
//! on (nullishness, truthiness, Number checks).
const std = @import("std");
const json = @import("core").json;

pub const Value = json.Value;
/// Ordered members (graphql-js coercion order for input objects).
pub const Object = []const json.Member;

/// `value == null` in JS (null or undefined).
pub fn isNullish(value: ?Value) bool {
    return value == null or value.? == .null;
}

/// Collapses JS null/undefined to Zig null.
pub fn present(value: ?Value) ?Value {
    return if (isNullish(value)) null else value;
}

pub fn number(value: Value) ?f64 {
    return switch (value) {
        .number => |n| n,
        .raw => |s| std.fmt.parseFloat(f64, s) catch null,
        else => null,
    };
}

/// `typeof value === 'number'` (node-pg int2/int4/float columns).
pub fn isJsNumber(value: Value) bool {
    return value == .number;
}

/// JS `Boolean(value)`.
pub fn truthy(value: ?Value) bool {
    const v = value orelse return false;
    return switch (v) {
        .null => false,
        .bool => |b| b,
        .number => |n| n != 0 and !std.math.isNan(n),
        .raw => |s| if (std.fmt.parseFloat(f64, s)) |n| n != 0 and !std.math.isNan(n) else |_| true,
        .string => |s| s.len > 0,
        .array, .object => true,
    };
}

/// `Number.isInteger(value)`.
pub fn isInteger(value: Value) bool {
    const n = number(value) orelse return false;
    return std.math.isFinite(n) and @floor(n) == n;
}

/// `Number.isSafeInteger(value)`.
pub fn isSafeInteger(value: Value) bool {
    const n = number(value) orelse return false;
    return isInteger(value) and @abs(n) <= 9007199254740991;
}

pub fn string(value: Value) ?[]const u8 {
    return switch (value) {
        .string => |s| s,
        else => null,
    };
}

pub fn object(value: ?Value) ?Object {
    return switch (value orelse return null) {
        .object => |members| members,
        else => null,
    };
}

pub fn array(value: Value) ?[]const Value {
    return switch (value) {
        .array => |items| items,
        else => null,
    };
}

/// `Array.isArray(value) ? value : [value]` without allocating.
pub fn listOrSingle(value: *const Value) []const Value {
    return array(value.*) orelse @as(*const [1]Value, value);
}

pub fn get(obj: Object, key: []const u8) ?Value {
    for (obj) |member| if (std.mem.eql(u8, member.key, key)) return member.value;
    return null;
}

pub fn len(obj: Object) usize {
    return obj.len;
}

pub fn keyAt(obj: Object, index: usize) []const u8 {
    return obj[index].key;
}

pub fn valueAt(obj: Object, index: usize) *const Value {
    return &obj[index].value;
}

pub fn integer(n: i64) Value {
    return json.int(n);
}

pub fn makeArray(allocator: std.mem.Allocator, items: []const Value) std.mem.Allocator.Error!Value {
    return .{ .array = try allocator.dupe(Value, items) };
}

/// JS `String(value)` for primitives; only used in error messages.
pub fn writeJsString(writer: *std.Io.Writer, value: Value) std.Io.Writer.Error!void {
    switch (value) {
        .null => try writer.writeAll("null"),
        .bool => |b| try writer.writeAll(if (b) "true" else "false"),
        .number => |n| try json.writeNumber(writer, n),
        .raw, .string => |s| try writer.writeAll(s),
        .array => try writer.writeAll("[array]"),
        .object => try writer.writeAll("[object Object]"),
    }
}

/// Test/fixture helper: parse JSON text into a Value (arena-owned).
pub fn parseLeaky(arena: std.mem.Allocator, text: []const u8) !Value {
    return json.parse(arena, text, .{});
}

/// Test/fixture helper: `JSON.stringify` of a Value, ?Value or value slice.
pub fn stringifyAlloc(arena: std.mem.Allocator, item: anytype) ![]const u8 {
    const T = @TypeOf(item);
    const v: Value = if (T == Value)
        item
    else if (T == ?Value)
        item orelse return "undefined"
    else
        .{ .array = try arena.dupe(Value, item) };
    return json.stringifyAlloc(arena, v);
}
