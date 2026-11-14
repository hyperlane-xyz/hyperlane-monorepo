//! Byte-for-byte parity with the TypeScript DiagnosticsService over the
//! generated corpus (testdata/gen-corpus.ts).
const std = @import("std");
const js = @import("js.zig");
const service = @import("service.zig");

const corpus = @embedFile("testdata/reducer-corpus.json");

const Fixture = struct {
    rows: []const js.Value,
    fn query(ctx: *anyopaque, _: std.mem.Allocator, _: []const u8, _: []const ?[]const u8) anyerror![]const js.Value {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        return self.rows;
    }
};

test "snapshots match the TypeScript oracle corpus" {
    @import("testing_log.zig").silence();
    var corpus_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer corpus_arena.deinit();
    const cases = try js.parse(corpus_arena.allocator(), corpus);
    var failures: usize = 0;
    var compared: usize = 0;
    for (cases.array.items) |case_value| {
        var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        const case = case_value.object;
        const raw_rows = case.get("rows").array.items;
        const rows = try arena.alloc(js.Value, raw_rows.len);
        for (raw_rows, rows) |raw, *row| {
            const object = try js.newObject(arena);
            for (raw.object.entries.items) |entry| {
                if (std.mem.eql(u8, entry.key, "activity_text")) {
                    try object.put(arena, "activity", try js.parse(arena, entry.value.string));
                } else try object.put(arena, entry.key, entry.value);
            }
            row.* = .{ .object = object };
        }
        var fixture: Fixture = .{ .rows = rows };
        const svc: service.Service = .{ .db = .{ .ctx = &fixture, .query = Fixture.query } };
        const ids_value = case.get("ids").array.items;
        const ids = try arena.alloc([]const u8, ids_value.len);
        for (ids_value, ids) |v, *id| id.* = v.string;
        const name = case.get("name").string;
        const expected = case.get("expected");
        const result = svc.snapshots(arena, ids) catch |err| {
            const oracle = case.get("error").str() orelse "";
            const matches = switch (err) {
                error.Unavailable => std.mem.eql(u8, oracle, "DIAGNOSTICS_UNAVAILABLE"),
                error.InvalidMessageId, error.InvalidBatch => std.mem.endsWith(u8, oracle, service.errorMessage(err)),
                else => false,
            };
            if (expected == .null and matches) continue;
            std.debug.print("case {s}: unexpected error {s}\n", .{ name, @errorName(err) });
            failures += 1;
            continue;
        };
        compared += 1;
        const actual = try js.stringifyAlloc(arena, .{ .array = try js.newArray(arena, result) });
        if (expected != .string or !std.mem.eql(u8, actual, expected.string)) {
            failures += 1;
            if (failures <= 3) std.debug.print("case {s}:\n expected {s}\n actual   {s}\n", .{
                name,
                if (expected == .string) expected.string else "<error>",
                actual,
            });
        }
    }
    try std.testing.expectEqual(@as(usize, 0), failures);
    try std.testing.expect(compared >= 70);
}
