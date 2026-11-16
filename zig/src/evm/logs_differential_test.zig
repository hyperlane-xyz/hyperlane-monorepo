//! rawLogs against the tree decoders it replaces (Log.parse per element;
//! with absent_removed, scraper.evm.parseLog's removed normalisation): it
//! may decline, but whatever it decides equals the tree result, and it
//! never decides where the tree path fails.
const std = @import("std");
const A = std.mem.Allocator;
const provider = @import("provider.zig");
const envelope = @import("../net/json_envelope.zig");
const mutate = @import("../net/json_envelope_differential_test.zig").mutate;
const Log = provider.Log;

fn log(comptime topics: []const u8, comptime extra: []const u8) []const u8 {
    return "{\"address\":\"0x" ++ "11" ** 20 ++ "\",\"topics\":[" ++ topics ++ "],\"data\":\"0x" ++ "44" ** 64 ++ "\",\"blockNumber\":\"0x1b4\",\"transactionHash\":\"0x" ++ "cd" ** 32 ++ "\",\"transactionIndex\":\"0x3\",\"blockHash\":\"0x" ++ "ab" ** 32 ++ "\",\"logIndex\":\"0x7\"" ++ extra ++ "}";
}
const t1 = "\"0x" ++ "22" ** 32 ++ "\"";
const t2 = "\"0x" ++ "33" ** 32 ++ "\"";
const corpus = [_][]const u8{
    "[]",
    "[" ++ log(t1 ++ "," ++ t2, ",\"removed\":false") ++ "]",
    "[" ++ log(t1, ",\"removed\":false") ++ " ,\n " ++ log("", ",\"removed\":false") ++ "," ++ log(t1 ++ "," ++ t1 ++ "," ++ t2 ++ " , " ++ t2, ",\"removed\":false,\"blockTimestamp\":\"0x5\"") ++ "]",
    "[" ++ log(t1, "") ++ "]", // removed absent
    "[" ++ log(t1, ",\"removed\":null") ++ "]",
    "[" ++ log(t1, ",\"removed\":true") ++ "]",
    "[" ++ log(t1 ++ "," ++ t1 ++ "," ++ t1 ++ "," ++ t1 ++ "," ++ t1, ",\"removed\":false") ++ "]", // five topics
    "[" ++ log(t1, ",\"removed\":false") ++ ",1]",
    "[[]]",
    "{}",
    "null",
};

fn freeLogs(a: A, logs: []Log) void {
    provider.freeLogs(a, logs);
}

/// The tree path: parse the result, then Log.parse (or parseLog) each element.
fn tree(a: A, result: []const u8, absent_removed: bool) ![]Log {
    var parsed = try envelope.parseValue(a, result, true);
    defer parsed.deinit();
    if (parsed.value != .array) return error.InvalidRpcResult;
    var logs: std.ArrayList(Log) = .empty;
    errdefer {
        for (logs.items) |*item| item.deinit();
        logs.deinit(a);
    }
    for (parsed.value.array.items) |item| {
        if (absent_removed and item == .object and (item.object.get("removed") orelse std.json.Value.null) == .null) {
            var copy = try item.object.clone();
            defer copy.deinit();
            try copy.put("removed", .{ .bool = false });
            try logs.append(a, try Log.parse(a, .{ .object = copy }));
        } else try logs.append(a, try Log.parse(a, item));
    }
    return logs.toOwnedSlice(a);
}

const Counts = struct { decided: usize = 0, total: usize = 0 };
fn check(a: A, result: []const u8, absent_removed: bool, counts: *Counts) !void {
    counts.total += 1;
    const raw = try provider.rawLogs(a, result, absent_removed);
    defer if (raw) |logs| freeLogs(a, logs);
    const expected = tree(a, result, absent_removed) catch |err| {
        if (err == error.OutOfMemory) return err;
        if (raw != null) {
            std.debug.print("rawLogs decided where the tree fails ({s}): {s}\n", .{ @errorName(err), result });
            return error.TestUnexpectedResult;
        }
        return;
    };
    defer freeLogs(a, expected);
    const actual = raw orelse return;
    counts.decided += 1;
    try std.testing.expectEqual(expected.len, actual.len);
    for (expected, actual) |want, got| {
        try std.testing.expectEqualSlices(u8, want.data, got.data);
        var w = want;
        var g = got;
        w.data = &.{};
        g.data = &.{};
        try std.testing.expectEqualDeep(w, g);
    }
}

test "raw logs decide the corpus exactly as the tree decoders" {
    const a = std.testing.allocator;
    var counts: Counts = .{};
    for (corpus) |result| for ([_]bool{ false, true }) |absent| try check(a, result, absent, &counts);
    // [], two valid documents, and absent/null removed when normalised.
    try std.testing.expect(counts.decided >= 8);
}

test "raw logs on seeded mutations decline or match" {
    const a = std.testing.allocator;
    var prng = std.Random.DefaultPrng.init(0x5eed_1065_0000_0003);
    const random = prng.random();
    var buffer: std.ArrayList(u8) = .empty;
    defer buffer.deinit(a);
    var counts: Counts = .{};
    for (0..4000) |round| {
        try mutate(random, corpus[1 + random.uintLessThan(usize, 4)], &buffer, a);
        try check(a, buffer.items, round % 2 == 0, &counts);
    }
    // Most mutations break these documents; ~1% still decide.
    try std.testing.expect(counts.decided > 20);
}

test "raw logs free everything on allocation failure" {
    const run = struct {
        fn run(a: A) !void {
            freeLogs(a, (try provider.rawLogs(a, corpus[2], false)).?);
        }
    }.run;
    try std.testing.checkAllAllocationFailures(std.testing.allocator, run, .{});
}
