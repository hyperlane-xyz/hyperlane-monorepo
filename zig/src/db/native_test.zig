//! Opt-in tests: link the production RocksDB 10.4.2 native library and compression
//! libraries. Not imported by the std-only test suite.
const std = @import("std");
const rocks = @import("rocks.zig");
const codec = @import("codec.zig");
const keys = @import("keys.zig");
comptime {
    _ = @import("bzip2_glue.zig");
}

fn expectValue(db: *rocks.Database, key: []const u8, expected: []const u8) !void {
    const value = (try db.get(std.testing.allocator, key)) orelse return error.MissingValue;
    defer std.testing.allocator.free(value);
    try std.testing.expectEqualSlices(u8, expected, value);
}

test "native batch fsync reopen empty values domain isolation and copied iterator ownership" {
    const allocator = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(base);
    const path = try std.fs.path.join(allocator, &.{ base, "db" });
    defer allocator.free(path);
    var retained: ?rocks.Entry = null;
    defer if (retained) |*entry| entry.deinit();
    {
        var db = try rocks.Database.open(allocator, path, .{ .sync = true });
        defer db.deinit();
        try std.testing.expect((try db.get(allocator, "missing")) == null);
        try db.put("empty", "");
        try expectValue(&db, "empty", "");
        try db.put("old", "delete me");
        var batch = try db.batch();
        defer batch.deinit();
        try batch.put("prefix_2", "two");
        try batch.put("prefix_1", "one");
        try batch.put("prefix_\xff", "last");
        try batch.put("prefix_other", "nested");
        try batch.put("other", "untouched");
        try batch.delete("old");
        try std.testing.expect((try db.get(allocator, "prefix_1")) == null);
        try batch.commit();
        try std.testing.expectError(error.ClosedBatch, batch.commit());
        try std.testing.expect((try db.get(allocator, "old")) == null);
        const typed: rocks.Typed = .{ .database = &db, .domain_name = "arbitrum" };
        const other: rocks.Typed = .{ .database = &db, .domain_name = "ethereum" };
        const nonce = try codec.encode(allocator, @as(u32, 42));
        defer allocator.free(nonce);
        const value = try codec.encode(allocator, true);
        defer allocator.free(value);
        try typed.put(allocator, keys.Table.nonce_processed.prefix(), nonce, value);
        try std.testing.expect((try other.get(allocator, keys.Table.nonce_processed.prefix(), nonce)) == null);
        var iterator = try db.prefix(allocator, "prefix_");
        defer iterator.deinit();
        retained = (try iterator.next(allocator)) orelse return error.MissingValue;
        try std.testing.expectEqualStrings("prefix_1", retained.?.key);
        var count: usize = 1;
        while (try iterator.next(allocator)) |item| {
            var entry = item;
            defer entry.deinit();
            count += 1;
        }
        try std.testing.expectEqual(@as(usize, 4), count);
        try std.testing.expect(db.sequence() >= 8);
    }
    // Retained iterator entries own their bytes after iterator/DB destruction.
    try std.testing.expectEqualStrings("one", retained.?.value);
    {
        var db = try rocks.Database.open(allocator, path, .{});
        defer db.deinit();
        try expectValue(&db, "prefix_2", "two");
        var batch = try db.batch();
        defer batch.deinit();
        try batch.deletePrefix(allocator, "prefix_");
        try batch.commit();
        try std.testing.expect((try db.get(allocator, "prefix_1")) == null);
        try expectValue(&db, "other", "untouched");
        var iterator = try db.prefix(allocator, "prefix_");
        defer iterator.deinit();
        try std.testing.expect((try iterator.next(allocator)) == null);
    }
    {
        var db = try rocks.Database.open(allocator, path, .{ .read_only = true });
        defer db.deinit();
        try expectValue(&db, "other", "untouched");
        try std.testing.expectError(error.ReadOnly, db.put("bad", "bad"));
        try std.testing.expectError(error.ReadOnly, db.batch());
    }
}

test "native open errors copy diagnostic before freeing C allocation" {
    const allocator = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(base);
    const path = try std.fs.path.join(allocator, &.{ base, "missing", "nested" });
    defer allocator.free(path);
    var diagnostic: rocks.Diagnostic = .{};
    try std.testing.expectError(error.RocksDB, rocks.Database.open(allocator, path, .{ .create_if_missing = false, .diagnostic = &diagnostic }));
    try std.testing.expect(diagnostic.message().len > 0);
    try std.testing.expectError(error.InvalidPath, rocks.Database.open(allocator, "bad\x00path", .{}));
}

test "native typed seeks retain bounds and highest fixed key skips overlapping records" {
    const allocator = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(base);
    const path = try std.fs.path.join(allocator, &.{ base, "db" });
    defer allocator.free(path);
    var database = try rocks.Database.open(allocator, path, .{});
    defer database.deinit();
    const typed: rocks.Typed = .{ .database = &database, .domain_name = "ethereum" };
    const first = [_]u8{ 0, 0, 0, 1 };
    const third = [_]u8{ 0, 0, 0, 3 };
    try typed.put(allocator, "ordered_", &first, "one");
    try typed.put(allocator, "ordered_", &third, "three");
    try typed.put(allocator, "other_", &first, "outside");
    {
        var entry = (try typed.atOrAfter(allocator, "ordered_", &.{ 0, 0, 0, 2 })) orelse return error.MissingValue;
        defer entry.deinit();
        try std.testing.expectEqualSlices(u8, &third, entry.key);
        try std.testing.expectEqualStrings("three", entry.value);
    }
    {
        var entry = (try typed.atOrBefore(allocator, "ordered_", &.{ 0, 0, 0, 2 })) orelse return error.MissingValue;
        defer entry.deinit();
        try std.testing.expectEqualSlices(u8, &first, entry.key);
    }
    try std.testing.expect((try typed.atOrAfter(allocator, "ordered_", &.{255})) == null);
    try std.testing.expect((try typed.atOrBefore(allocator, "ordered_", &.{0})) == null);
    try typed.put(allocator, "ordered_", &.{ 0, 0, 0, 4, 0 }, "overlapping-width");
    try std.testing.expectEqual(third, (try typed.lastFixedKey(4, allocator, "ordered_")).?);
    try std.testing.expect((try typed.lastFixedKey(4, allocator, "absent_")) == null);
}
