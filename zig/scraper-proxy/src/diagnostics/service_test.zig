//! Service-level ports from `src/diagnostics/diagnostics.test.ts` (selection
//! and reduction parity lives in corpus_test.zig).
const std = @import("std");
const js = @import("js.zig");
const svc_mod = @import("service.zig");
const testing = std.testing;

const id = "0x" ++ "01" ** 32;

const Recording = struct {
    sql: []const u8 = "",
    params: []const ?[]const u8 = &.{},
    rows: []const js.Value = &.{},
    fail: bool = false,
    calls: usize = 0,

    fn query(ctx: *anyopaque, arena: std.mem.Allocator, sql: []const u8, params: []const ?[]const u8) anyerror![]const js.Value {
        const self: *Recording = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (self.fail) return error.ConnectionRefusedPostgresSecret;
        self.sql = try arena.dupe(u8, sql);
        self.params = try arena.dupe(?[]const u8, params);
        return self.rows;
    }

    fn service(self: *Recording) svc_mod.Service {
        return .{ .db = .{ .ctx = self, .query = query } };
    }
};

fn progressRow(arena: std.mem.Allocator, number: usize) !js.Value {
    const text = try std.fmt.allocPrint(arena,
        \\{{"id":"{d}","message_id":"{s}","relayer":"relayer-a","origin":1,"destination":2,
        \\"observed_at":"2026-11-05 00:00:00+00","received_at":"2026-11-05 00:00:01+00","version":1,
        \\"activity":{{"type":"progress","stage":"prepare","outcome":"started"}}}}
    , .{ number, id });
    return js.parse(arena, text);
}

test "validates history bounds before querying" {
    @import("testing_log.zig").silence();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var db: Recording = .{};
    const svc = db.service();
    try testing.expectError(error.InvalidMessageId, svc.history(arena, "invalid", null, 100));
    try testing.expectError(error.InvalidLimit, svc.history(arena, id, null, 501));
    try testing.expectError(error.InvalidLimit, svc.history(arena, id, null, 0));
    try testing.expectError(error.InvalidBeforeId, svc.history(arena, id, "9223372036854775808", 100));
    try testing.expectError(error.InvalidBeforeId, svc.history(arena, id, "-1", 100));
    try testing.expectError(error.InvalidBeforeId, svc.history(arena, id, "", 100));
    // Message ID errors win over limit errors, as in TS.
    try testing.expectError(error.InvalidMessageId, svc.history(arena, "invalid", null, 0));
    try testing.expectEqual(@as(usize, 0), db.calls);
    try testing.expectEqualStrings("limit must be between 1 and 500", svc_mod.errorMessage(error.InvalidLimit));
    try testing.expectEqualStrings("Expected 1\u{2013}20 message IDs", svc_mod.errorMessage(error.InvalidBatch));
}

test "paginates history and marks truncated snapshot state as partial" {
    @import("testing_log.zig").silence();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const rows = try arena.alloc(js.Value, 101);
    for (rows, 0..) |*row, i| row.* = try progressRow(arena, 101 - i);
    var db: Recording = .{ .rows = rows };
    const svc = db.service();
    const page = (try svc.history(arena, id, "102", 100)).object;
    try testing.expect(page.get("has_more").bool);
    try testing.expectEqualStrings("2", page.get("next_before_id").string);
    try testing.expectEqual(@as(usize, 100), page.get("activities").array.items.len);
    try testing.expectEqual(@as(usize, 3), db.params.len);
    try testing.expectEqualStrings(id[2..], db.params[0].?);
    try testing.expectEqualStrings("101", db.params[1].?);
    try testing.expectEqualStrings("102", db.params[2].?);
    try testing.expect(std.mem.indexOf(u8, db.sql, "id < $3::bigint") != null);

    const snapshot = (try svc.snapshots(arena, &.{id}))[0].object;
    try testing.expect(snapshot.get("partial").bool);
    const activities = snapshot.get("activities").array.items;
    try testing.expectEqualStrings("2", activities[0].object.get("id").string);
    try testing.expectEqualStrings("101", activities[activities.len - 1].object.get("id").string);
    try testing.expectEqualStrings("{\"" ++ id[2..] ++ "\"}", db.params[0].?);
    try testing.expectEqualStrings("101", db.params[1].?);

    // History without more rows reports a null cursor.
    db.rows = rows[0..3];
    const last = (try svc.history(arena, id, null, 7)).object;
    try testing.expect(!last.get("has_more").bool);
    try testing.expect(last.get("next_before_id") == .null);
    try testing.expect(db.params[2] == null);

    var broken: Recording = .{ .fail = true };
    try testing.expectError(error.Unavailable, broken.service().history(arena, id, null, 100));
    try testing.expectEqualStrings("Diagnostics temporarily unavailable", svc_mod.errorMessage(error.Unavailable));
    try testing.expectEqualStrings("DIAGNOSTICS_UNAVAILABLE", svc_mod.errorCode(error.Unavailable).?);
}

test "history rows serialize like the TypeScript page" {
    @import("testing_log.zig").silence();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const row = try js.parse(arena,
        \\{"version":1,"activity":{"b":1,"2":"x","type":"delivered"},"observed_at":"t","received_at":"r",
        \\"origin":"42","destination":2,"relayer":"0xaa","message_id":"0x01","id":"9","extra":true}
    );
    var db: Recording = .{ .rows = &.{row} };
    const page = try db.service().history(arena, "\\x" ++ "AB" ** 32, null, 1);
    try testing.expectEqualStrings(
        "{\"message_id\":\"0x" ++ "ab" ** 32 ++ "\",\"activities\":[{\"id\":\"9\",\"message_id\":\"0x01\",\"relayer\":\"0xaa\"," ++
            "\"origin\":42,\"destination\":2,\"observed_at\":\"t\",\"received_at\":\"r\",\"version\":1," ++
            "\"activity\":{\"2\":\"x\",\"b\":1,\"type\":\"delivered\"}}],\"has_more\":false,\"next_before_id\":null}",
        try js.stringifyAlloc(arena, page),
    );
}
