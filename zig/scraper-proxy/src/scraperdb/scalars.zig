//! Port of `scraperdb/scalars.ts`: every custom scalar is pass-through.
//! `parseValue`/`serialize` return the value unchanged; `parseLiteral` returns
//! `ast.value`, so INT/FLOAT literals become their source *text* (strings).
const std = @import("std");

const value = @import("value.zig");
const Value = value.Value;

pub const names = [_][]const u8{ "DiagnosticsJSON", "bigint", "bytea", "interval", "numeric", "timestamp" };

pub fn isPassThrough(name: []const u8) bool {
    for (names) |candidate| if (std.mem.eql(u8, candidate, name)) return true;
    return false;
}

/// A GraphQL literal as the engine sees it. `other` carries the graphql-js
/// `Kind` name (`EnumValue`, `ListValue`, `ObjectValue`) for rejected kinds.
pub const Literal = union(enum) {
    string: []const u8,
    int: []const u8,
    float: []const u8,
    boolean: bool,
    null,
    other: []const u8,
};

pub const LiteralError = struct {
    /// `${name} cannot represent literal ${ast.kind}`
    message: []const u8,
};

pub fn parseLiteral(arena: std.mem.Allocator, name: []const u8, literal: Literal, err: *LiteralError) error{ InvalidLiteral, OutOfMemory }!Value {
    return switch (literal) {
        .string, .int, .float => |text| .{ .string = text },
        .boolean => |b| .{ .bool = b },
        .null => .null,
        .other => |kind| {
            err.message = try std.fmt.allocPrint(arena, "{s} cannot represent literal {s}", .{ name, kind });
            return error.InvalidLiteral;
        },
    };
}

test "custom scalar literals pass through as ast.value" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var err: LiteralError = undefined;
    try std.testing.expectEqualStrings("5", (try parseLiteral(a, "bigint", .{ .int = "5" }, &err)).string);
    try std.testing.expectEqualStrings("1.50", (try parseLiteral(a, "numeric", .{ .float = "1.50" }, &err)).string);
    try std.testing.expect((try parseLiteral(a, "bytea", .{ .boolean = true }, &err)).bool);
    try std.testing.expect(try parseLiteral(a, "timestamp", .null, &err) == .null);
    try std.testing.expectError(error.InvalidLiteral, parseLiteral(a, "bigint", .{ .other = "ListValue" }, &err));
    try std.testing.expectEqualStrings("bigint cannot represent literal ListValue", err.message);
    try std.testing.expect(isPassThrough("interval") and !isPassThrough("Int"));
}
