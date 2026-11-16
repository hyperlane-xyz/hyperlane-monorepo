//! Borrowed views of stored Lander JSON rows. A row is validated by one
//! allocation-free token pass; callers read only the fields they need and
//! rewrite a field by splicing its value, so the rest of the row (including
//! Rust's byte-array encodings and any unknown fields) is kept byte for byte.
const std = @import("std");

/// Raw value text of the requested top-level fields of a JSON object (null:
/// absent). The whole document is validated; a repeated requested key is an
/// error, as is a non-object document. Slices borrow `json`.
pub fn fields(comptime N: usize, scratch: std.mem.Allocator, json: []const u8, names: [N][]const u8) ![N]?[]const u8 {
    var result: [N]?[]const u8 = @splat(null);
    var scanner = std.json.Scanner.initCompleteInput(scratch, json);
    defer scanner.deinit();
    if (try scanner.next() != .object_begin) return error.InvalidLanderRecord;
    while (true) {
        const key = try scanner.nextAllocMax(scratch, .alloc_if_needed, json.len);
        const text = switch (key) {
            .object_end => break,
            .string => |value| value,
            .allocated_string => |value| value,
            else => return error.InvalidLanderRecord,
        };
        defer if (key == .allocated_string) scratch.free(key.allocated_string);
        _ = try scanner.peekNextTokenType();
        const start = scanner.cursor;
        try scanner.skipValue();
        const value = std.mem.trimRight(u8, json[start..scanner.cursor], " \t\r\n");
        for (names, &result) |name, *slot| if (std.mem.eql(u8, name, text)) {
            if (slot.* != null) return error.InvalidLanderRecord;
            slot.* = value;
        };
    }
    if (try scanner.next() != .end_of_document) return error.InvalidLanderRecord;
    return result;
}

pub fn field(scratch: std.mem.Allocator, json: []const u8, name: []const u8) !?[]const u8 {
    return (try fields(1, scratch, json, .{name}))[0];
}

/// `json` with the value slice `old` (borrowed from `json`) replaced.
pub fn splice(allocator: std.mem.Allocator, json: []const u8, old: []const u8, replacement: []const u8) ![]u8 {
    const start = @intFromPtr(old.ptr) - @intFromPtr(json.ptr);
    std.debug.assert(start + old.len <= json.len);
    const out = try allocator.alloc(u8, json.len - old.len + replacement.len);
    @memcpy(out[0..start], json[0..start]);
    @memcpy(out[start..][0..replacement.len], replacement);
    @memcpy(out[start + replacement.len ..], json[start + old.len ..]);
    return out;
}

/// Decodes Rust's serde `Vec<u8>` encoding (an array of 0..=255 integers).
/// `raw` must already be validated JSON (as returned by `fields`).
pub fn byteArray(allocator: std.mem.Allocator, raw: []const u8) ![]u8 {
    if (raw.len < 2 or raw[0] != '[') return error.InvalidLanderRecord;
    var out: std.ArrayList(u8) = try .initCapacity(allocator, raw.len / 2);
    errdefer out.deinit(allocator);
    var i: usize = 1;
    i = skipSpace(raw, i);
    if (i < raw.len and raw[i] == ']') {
        if (skipSpace(raw, i + 1) != raw.len) return error.InvalidLanderRecord;
        return out.toOwnedSlice(allocator);
    }
    while (true) {
        i = skipSpace(raw, i);
        const begin = i;
        var value: u16 = 0;
        while (i < raw.len and raw[i] >= '0' and raw[i] <= '9') : (i += 1) {
            value = value * 10 + (raw[i] - '0');
            if (value > 255) return error.InvalidLanderRecord;
        }
        if (i == begin or (raw[begin] == '0' and i - begin > 1)) return error.InvalidLanderRecord;
        out.appendAssumeCapacity(@intCast(value));
        i = skipSpace(raw, i);
        if (i >= raw.len) return error.InvalidLanderRecord;
        if (raw[i] == ',') {
            i += 1;
            continue;
        }
        if (raw[i] != ']' or skipSpace(raw, i + 1) != raw.len) return error.InvalidLanderRecord;
        return out.toOwnedSlice(allocator);
    }
}

/// Appends Rust's serde `Vec<u8>` encoding of `bytes` (compact, as
/// std.json.Stringify writes an array of integers).
pub fn writeByteArray(out: *std.ArrayList(u8), allocator: std.mem.Allocator, bytes: []const u8) !void {
    try out.ensureUnusedCapacity(allocator, 2 + bytes.len * 4);
    out.appendAssumeCapacity('[');
    for (bytes, 0..) |byte, i| {
        if (i != 0) out.appendAssumeCapacity(',');
        out.appendSliceAssumeCapacity(decimal[byte]);
    }
    out.appendAssumeCapacity(']');
}

const decimal: [256][]const u8 = blk: {
    @setEvalBranchQuota(100_000);
    var table: [256][]const u8 = undefined;
    for (&table, 0..) |*text, i| text.* = std.fmt.comptimePrint("{d}", .{i});
    break :blk table;
};

test "byte array text matches Stringify for every byte" {
    const allocator = std.testing.allocator;
    var all: [256]u8 = undefined;
    for (&all, 0..) |*byte, i| byte.* = @intCast(i);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);
    try writeByteArray(&out, allocator, &all);
    var items: [256]std.json.Value = undefined;
    for (&items, all) |*item, byte| item.* = .{ .integer = byte };
    const expected = try std.json.Stringify.valueAlloc(allocator, std.json.Value{ .array = .{ .items = &items, .capacity = 256, .allocator = allocator } }, .{});
    defer allocator.free(expected);
    try std.testing.expectEqualStrings(expected, out.items);
}

fn skipSpace(raw: []const u8, start: usize) usize {
    var i = start;
    while (i < raw.len and (raw[i] == ' ' or raw[i] == '\t' or raw[i] == '\r' or raw[i] == '\n')) i += 1;
    return i;
}

/// Parses one raw value slice (small fields only) into a Value tree.
pub fn parseValue(allocator: std.mem.Allocator, raw: []const u8) !std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, allocator, raw, .{ .duplicate_field_behavior = .@"error", .allocate = .alloc_always });
}

/// A JSON string field's decoded text (borrowed when unescaped).
pub fn string(allocator: std.mem.Allocator, raw: []const u8) ![]const u8 {
    if (raw.len < 2 or raw[0] != '"') return error.InvalidLanderRecord;
    if (std.mem.indexOfScalar(u8, raw, '\\') == null) return raw[1 .. raw.len - 1];
    return std.json.parseFromSliceLeaky([]const u8, allocator, raw, .{ .allocate = .alloc_always });
}

test "fields borrow values, reject duplicates and splice preserves bytes" {
    const a = std.testing.allocator;
    const json = "{\"a\":[1, 2,3] ,\"s\":{\"x\":\"y\"},\"n\":12,\"t\":null}";
    const got = try fields(3, a, json, .{ "s", "n", "missing" });
    try std.testing.expectEqualStrings("{\"x\":\"y\"}", got[0].?);
    try std.testing.expectEqualStrings("12", got[1].?);
    try std.testing.expect(got[2] == null);
    const bytes = try byteArray(a, (try field(a, json, "a")).?);
    defer a.free(bytes);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, bytes);
    const out = try splice(a, json, got[1].?, "\"x\"");
    defer a.free(out);
    try std.testing.expectEqualStrings("{\"a\":[1, 2,3] ,\"s\":{\"x\":\"y\"},\"n\":\"x\",\"t\":null}", out);
    try std.testing.expectError(error.InvalidLanderRecord, field(a, "{\"n\":1,\"n\":2}", "n"));
    try std.testing.expectError(error.InvalidLanderRecord, field(a, "[1]", "n"));
    try std.testing.expectError(error.SyntaxError, field(a, "{\"n\":1,}", "n"));
    try std.testing.expectError(error.SyntaxError, field(a, "{\"n\":1} 2", "n"));
    try std.testing.expectEqualStrings("1", (try field(a, "{\"\\u006e\":1}", "n")).?);
}

test "byte arrays match the Value decoder" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "[]", "[ ]", "[0]", "[255,0, 7 ]" }) |raw| {
        const got = try byteArray(a, raw);
        defer a.free(got);
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(a);
        try writeByteArray(&out, a, got);
        const parsed = try std.json.parseFromSlice([]u8, a, raw, .{});
        defer parsed.deinit();
        try std.testing.expectEqualSlices(u8, parsed.value, got);
    }
    for ([_][]const u8{ "[256]", "[-1]", "[1.0]", "[01]", "[1,]", "[,]", "[1e2]", "{}", "\"ab\"" }) |raw| {
        try std.testing.expectError(error.InvalidLanderRecord, byteArray(a, raw));
    }
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(a);
    try writeByteArray(&out, a, &.{ 0, 10, 255 });
    var items: [3]std.json.Value = .{ .{ .integer = 0 }, .{ .integer = 10 }, .{ .integer = 255 } };
    const reference = try std.json.Stringify.valueAlloc(a, std.json.Value{ .array = .{ .items = &items, .capacity = 3, .allocator = a } }, .{});
    defer a.free(reference);
    try std.testing.expectEqualStrings(reference, out.items);
}
