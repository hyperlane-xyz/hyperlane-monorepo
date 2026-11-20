//! Differential fixtures generated from graphql-js (tools/gen-validation-fixtures.mjs).
const std = @import("std");
const ast = @import("ast.zig");
const parser = @import("parser.zig");
const schema_mod = @import("schema.zig");
const validate = @import("validate.zig");
const validation_rule = @import("validation_rule.zig");

const Location = struct { line: u32, column: u32 };
const ExpectedError = struct { message: []const u8, locations: []const Location };
const Case = struct {
    query: []const u8,
    errors: ?[]const ExpectedError = null,
    syntax: ?ExpectedError = null,
};

test "validation matches graphql-js fixtures" {
    const gpa = std.testing.allocator;
    const parsed = try std.json.parseFromSlice([]const Case, gpa, @embedFile("testdata/validation.json"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const schema = schema_mod.testing.scraper();
    var failures: usize = 0;
    for (parsed.value) |case| {
        var arena_state = std.heap.ArenaAllocator.init(gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        var diag: parser.Diagnostic = .{};
        const doc = parser.parse(arena, case.query, .{ .max_tokens = validation_rule.max_graphql_tokens }, &diag) catch |err| {
            if (err != error.SyntaxError) return err;
            const expected = case.syntax orelse {
                std.debug.print("unexpected syntax error for {s}: {s}\n", .{ case.query, diag.message });
                failures += 1;
                continue;
            };
            const loc = ast.location(case.query, diag.offset);
            if (!std.mem.eql(u8, expected.message, diag.message) or expected.locations[0].line != loc.line or expected.locations[0].column != loc.column) {
                std.debug.print("syntax mismatch for {s}\n  want {s} {any}\n  got  {s} {d}:{d}\n", .{ case.query, expected.message, expected.locations, diag.message, loc.line, loc.column });
                failures += 1;
            }
            continue;
        };
        const errors = try validate.validate(arena, schema, doc);
        const expected = case.errors orelse &.{};
        var ok = errors.len == expected.len;
        if (ok) for (errors, expected) |got, want| {
            if (!std.mem.eql(u8, got.message, want.message) or got.locations.len != want.locations.len) {
                ok = false;
                break;
            }
            for (got.locations, want.locations) |offset, wl| {
                const loc = ast.location(case.query, offset);
                if (loc.line != wl.line or loc.column != wl.column) ok = false;
            }
        };
        if (!ok) {
            failures += 1;
            std.debug.print("validation mismatch for {s}\n", .{case.query[0..@min(case.query.len, 200)]});
            for (expected) |e| std.debug.print("  want: {s} {any}\n", .{ e.message, e.locations });
            for (errors) |e| {
                std.debug.print("  got:  {s} [", .{e.message});
                for (e.locations) |o| {
                    const loc = ast.location(case.query, o);
                    std.debug.print("{d}:{d} ", .{ loc.line, loc.column });
                }
                std.debug.print("]\n", .{});
            }
        }
    }
    try std.testing.expectEqual(@as(usize, 0), failures);
}
