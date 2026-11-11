//! Differential test: core.json.stringify vs Node 26 `JSON.stringify` on
//! 3000+ generated values (testdata/gen-json-corpus.mjs). Also checks that
//! `parse` of Node's output re-stringifies to the same bytes.
const std = @import("std");
const json = @import("json.zig");

const Value = json.Value;

fn decodeUnits(a: std.mem.Allocator, units: []const Value) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < units.len) : (i += 1) {
        var cp: u21 = @intFromFloat(units[i].number);
        if (cp >= 0xd800 and cp <= 0xdbff and i + 1 < units.len) {
            const low: u21 = @intFromFloat(units[i + 1].number);
            if (low >= 0xdc00 and low <= 0xdfff) {
                cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                i += 1;
            }
        }
        var buf: [4]u8 = undefined;
        const n = try std.unicode.wtf8Encode(cp, &buf);
        try out.appendSlice(a, buf[0..n]);
    }
    return out.items;
}

fn decode(a: std.mem.Allocator, enc: Value) !Value {
    const t = enc.get("t").?.string;
    switch (t[0]) {
        'z' => return .null,
        'b' => return .{ .bool = enc.get("v").?.bool },
        'n' => {
            const b = try std.fmt.parseInt(u64, enc.get("b").?.string, 16);
            return .{ .number = @bitCast(b) };
        },
        's' => return .{ .string = try decodeUnits(a, enc.get("u").?.array) },
        'a' => {
            const items = enc.get("v").?.array;
            const out = try a.alloc(Value, items.len);
            for (items, out) |item, *o| o.* = try decode(a, item);
            return .{ .array = out };
        },
        'o' => {
            const pairs = enc.get("v").?.array;
            const out = try a.alloc(json.Member, pairs.len);
            for (pairs, out) |pair, *m| m.* = .{
                .key = (try decode(a, pair.array[0])).string,
                .value = try decode(a, pair.array[1]),
            };
            return .{ .object = out };
        },
        else => return error.BadCorpus,
    }
}

test "stringify matches Node JSON.stringify on the generated corpus" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const corpus = try json.parse(a, @embedFile("testdata/json-corpus.json"), .{});
    const cases = corpus.get("cases").?.array;
    try std.testing.expect(cases.len > 3000);
    for (cases, 0..) |case, i| {
        const expected = case.get("json").?.string;
        const value = try decode(a, case.get("value").?);
        const actual = try json.stringifyAlloc(a, value);
        if (!std.mem.eql(u8, expected, actual)) {
            std.debug.print("case {d}\n", .{i});
            try std.testing.expectEqualStrings(expected, actual);
        }
        // parse(Node output) re-stringifies identically (parse is JSON.parse).
        const reparsed = try json.stringifyAlloc(a, try json.parse(a, expected, .{}));
        try std.testing.expectEqualStrings(expected, reparsed);
    }
}

test "bench: stringify components (opt-in CORE_BENCH, use -Drelease=true)" {
    if (std.posix.getenv("CORE_BENCH") == null) return error.SkipZigTest;
    const gpa = std.heap.c_allocator;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const keys = [_][]const u8{ "id", "msg_id", "nonce", "sender", "recipient", "is_delivered", "send_occurred_at", "delivery_occurred_at", "delivery_latency", "origin_tx_hash", "destination_tx_hash", "total_payment", "num_payments" };
    const rows = try a.alloc(Value, 100);
    for (rows) |*r| {
        const m = try a.alloc(json.Member, keys.len);
        for (keys, m) |k, *x| x.* = .{ .key = k, .value = .{ .string = "0x97af7a1adecc66996a328333df23398a422513262ca3d44cd263c91ca76caf3b" } };
        r.* = .{ .object = m };
    }
    var out: std.Io.Writer.Allocating = try .initCapacity(gpa, 128 * 1024);
    defer out.deinit();
    const n = 5000;
    var t = try std.time.Timer.start();
    for (0..n) |_| {
        out.clearRetainingCapacity();
        try json.stringify(&out.writer, .{ .array = rows });
    }
    std.debug.print("stringify: {d:.1} us ({d} bytes)\n", .{ @as(f64, @floatFromInt(t.lap() / n)) / 1000, out.written().len });
    for (0..n) |_| {
        out.clearRetainingCapacity();
        for (rows) |r| for (r.object) |m| {
            try out.writer.writeAll(m.key);
            try out.writer.writeAll(m.value.string);
        };
    }
    std.debug.print("raw copy: {d:.1} us\n", .{@as(f64, @floatFromInt(t.lap() / n)) / 1000});
    for (0..n) |_| {
        out.clearRetainingCapacity();
        for (rows) |r| for (r.object) |m| {
            try json.writeString(&out.writer, m.key);
            try json.writeString(&out.writer, m.value.string);
        };
    }
    std.debug.print("writeString only: {d:.1} us\n", .{@as(f64, @floatFromInt(t.lap() / n)) / 1000});
}
