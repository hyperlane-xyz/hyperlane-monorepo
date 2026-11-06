const std = @import("std");
const codec = @import("codec.zig");
const json = @import("json.zig");
const Value = std.json.Value;
const allocator = std.testing.allocator;

fn join(value: Value) ![]u8 {
    if (value == .string) return allocator.dupe(u8, value.string);
    if (value != .array) return error.ExpectedChunks;
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    for (value.array.items) |chunk| {
        if (chunk != .string) return error.ExpectedChunkString;
        try output.appendSlice(allocator, chunk.string);
    }
    return output.toOwnedSlice(allocator);
}

fn bytes(value: Value) ![]u8 {
    const text = try join(value);
    defer allocator.free(text);
    const output = try allocator.alloc(u8, text.len / 2);
    errdefer allocator.free(output);
    _ = try std.fmt.hexToBytes(output, text);
    return output;
}

fn number(comptime T: type, value: Value) !T {
    return std.fmt.parseInt(T, switch (value) {
        .string => value.string,
        .number_string => value.number_string,
        else => return error.ExpectedDecimal,
    }, 10);
}

fn record(comptime T: type, wire: []const u8, fields: Value) !void {
    const decoded = try codec.decode(T, wire);
    inline for (std.meta.fields(T)) |field| {
        const expected = fields.object.get(field.name) orelse return error.MissingExpectedField;
        if (@typeInfo(field.type) == .int) {
            try std.testing.expectEqual(try number(field.type, expected), @field(decoded, field.name));
        } else {
            const expected_bytes = try bytes(expected);
            defer allocator.free(expected_bytes);
            try std.testing.expectEqualSlices(u8, expected_bytes, &@field(decoded, field.name));
        }
    }
    const encoded = try codec.encode(allocator, decoded);
    defer allocator.free(encoded);
    try std.testing.expectEqualSlices(u8, wire, encoded);
    for (0..wire.len) |length|
        try std.testing.expectError(error.TruncatedRecord, codec.decode(T, wire[0..length]));
}

fn scalar(comptime T: type, wire: []const u8, fields: Value) !void {
    const decoded = try codec.decode(T, wire);
    const expected = fields.object.get("value") orelse return error.MissingExpectedField;
    if (T == bool) try std.testing.expectEqual(expected.bool, decoded) else try std.testing.expectEqual(try number(T, expected), decoded);
    const encoded = try codec.encode(allocator, decoded);
    defer allocator.free(encoded);
    try std.testing.expectEqualSlices(u8, wire, encoded);
}

fn hash(comptime size: usize, wire: []const u8) !void {
    const decoded = try codec.decode([size]u8, wire);
    try std.testing.expectEqualSlices(u8, wire, &decoded);
    const encoded = try codec.encode(allocator, decoded);
    defer allocator.free(encoded);
    try std.testing.expectEqualSlices(u8, wire, encoded);
}

test "93 production Rust DB codec fixtures and all fixed-record truncation boundaries" {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(allocator, @embedFile("fixtures/codecs.jsonl.gz"), 16 * 1024 * 1024);
    defer allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        const parsed = try std.json.parseFromSlice(Value, allocator, line, .{ .parse_numbers = false });
        defer parsed.deinit();
        const object = parsed.value.object;
        const kind = (object.get("kind") orelse return error.MissingKind).string;
        const valid = (object.get("valid") orelse return error.MissingValidity).bool;
        if (object.get("wire_utf8_chunks")) |chunks| {
            const wire = try join(chunks);
            defer allocator.free(wire);
            if (std.mem.eql(u8, kind, "Status")) {
                const value = try json.Status.parse(allocator, wire);
                const encoded = try value.toJson(allocator);
                defer allocator.free(encoded);
                try std.testing.expectEqualStrings(wire, encoded);
            } else if (std.mem.eql(u8, kind, "RetryState")) {
                const result = json.RetryState.parse(allocator, wire);
                if (valid) {
                    const encoded = try (try result).toJson(allocator);
                    defer allocator.free(encoded);
                    try std.testing.expectEqualStrings(wire, encoded);
                } else {
                    if (result) |_| return error.AcceptedInvalidRetryState else |_| {}
                }
            } else return error.UnknownFixture;
        } else {
            const wire = try bytes(object.get("wire_hex_chunks") orelse return error.MissingWire);
            defer allocator.free(wire);
            const fields = object.get("fields") orelse return error.MissingExpectedFields;
            if (std.mem.eql(u8, kind, "u32")) {
                try scalar(u32, wire, fields);
            } else if (std.mem.eql(u8, kind, "u64")) {
                try scalar(u64, wire, fields);
            } else if (std.mem.eql(u8, kind, "u256")) {
                try scalar(u256, wire, fields);
            } else if (std.mem.eql(u8, kind, "bool")) {
                try scalar(bool, wire, fields);
            } else if (std.mem.eql(u8, kind, "hash16")) {
                try hash(16, wire);
            } else if (std.mem.eql(u8, kind, "hash20")) {
                try hash(20, wire);
            } else if (std.mem.eql(u8, kind, "hash32")) {
                try hash(32, wire);
            } else if (std.mem.eql(u8, kind, "hash64")) {
                try hash(64, wire);
            } else if (std.mem.eql(u8, kind, "GasPaymentKey")) {
                try record(codec.GasPaymentKey, wire, fields);
            } else if (std.mem.eql(u8, kind, "GasPaymentMeta")) {
                try record(codec.GasPaymentMeta, wire, fields);
            } else if (std.mem.eql(u8, kind, "GasPayment")) {
                try record(codec.GasPayment, wire, fields);
            } else if (std.mem.eql(u8, kind, "GasPaymentData")) {
                try record(codec.GasPaymentData, wire, fields);
            } else if (std.mem.eql(u8, kind, "GasExpenditureData")) {
                try record(codec.GasExpenditureData, wire, fields);
            } else if (std.mem.eql(u8, kind, "MerkleInsertion")) {
                try record(codec.MerkleInsertion, wire, fields);
            } else if (std.mem.eql(u8, kind, "BackwardCursor")) {
                try record(codec.BackwardCursor, wire, fields);
            } else if (std.mem.eql(u8, kind, "IndexedMerkleInsertion")) {
                const decoded = try codec.decode(codec.Indexed(codec.MerkleInsertion), wire);
                const sequence = fields.object.get("sequence") orelse return error.MissingSequence;
                try std.testing.expectEqual(if (sequence == .null) null else @as(?u32, try number(u32, sequence)), decoded.sequence);
                try std.testing.expectEqual(try number(u32, fields.object.get("leaf_index").?), decoded.value.leaf_index);
                const expected_id = try bytes(fields.object.get("message_id").?);
                defer allocator.free(expected_id);
                try std.testing.expectEqualSlices(u8, expected_id, &decoded.value.message_id);
                const encoded = try codec.encode(allocator, decoded);
                defer allocator.free(encoded);
                try std.testing.expectEqualSlices(u8, wire, encoded);
            } else if (std.mem.eql(u8, kind, "UuidList")) {
                const decoded = try codec.decodeUuids(allocator, wire);
                defer allocator.free(decoded);
                try std.testing.expectEqual(try number(usize, fields.object.get("count").?), decoded.len);
                const encoded = try codec.encodeUuids(allocator, decoded);
                defer allocator.free(encoded);
                try std.testing.expectEqualSlices(u8, wire, encoded);
            } else return error.UnknownFixture;
        }
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 93), count);
}
