//! Immutable SDK multi-call vectors; no regeneration or external chain needed.
const std = @import("std");
const tx = @import("transaction.zig");
const codec = @import("codec.zig");
const rpc = @import("../net/json_rpc.zig");
const A = std.mem.Allocator;
fn fixtureFelt(a: A, value: std.json.Value) !codec.Felt {
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(a);
    if (value != .array) return error.InvalidStarknetFixture;
    for (value.array.items) |chunk| try text.appendSlice(a, try rpc.string(chunk));
    if (text.items.len != 64) return error.InvalidStarknetFixture;
    var bytes: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&bytes, text.items);
    return codec.Felt.fromBytes(bytes);
}
fn fixtureFelts(a: A, value: std.json.Value) ![]codec.Felt {
    if (value != .array) return error.InvalidStarknetFixture;
    const result = try a.alloc(codec.Felt, value.array.items.len);
    errdefer a.free(result);
    for (value.array.items, result) |item, *out| out.* = try fixtureFelt(a, item);
    return result;
}
test "Starknet batch call decoder matches all immutable SDK multi-call encodings and rejects every truncation" {
    const a = std.testing.allocator;
    const bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(bytes);
    var lines = std.mem.splitScalar(u8, bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const scratch = arena.allocator();
        const parsed = (try std.json.parseFromSlice(std.json.Value, scratch, line, .{})).value;
        if (!std.mem.eql(u8, try rpc.string(try rpc.field(parsed, "kind")), "invoke")) continue;
        const input = try rpc.field(parsed, "input");
        const expected = try fixtureFelts(scratch, try rpc.field(try rpc.field(parsed, "expected"), "encoded"));
        const mode: tx.Encoding = if ((try rpc.field(input, "legacy")).bool) .legacy else .modern;
        const calls = try tx.decodeCalls(a, expected, mode, 32);
        defer a.free(calls);
        const raw_calls = (try rpc.field(input, "calls")).array.items;
        try std.testing.expectEqual(raw_calls.len, calls.len);
        for (raw_calls, calls) |raw, actual| {
            try std.testing.expectEqual(try fixtureFelt(scratch, try rpc.field(raw, "to")), actual.to);
            try std.testing.expectEqual(try fixtureFelt(scratch, try rpc.field(raw, "selector")), actual.selector);
            try std.testing.expectEqualSlices(codec.Felt, try fixtureFelts(scratch, try rpc.field(raw, "calldata")), actual.calldata);
        }
        const encoded = try tx.encodeCalls(a, calls, mode);
        defer a.free(encoded);
        try std.testing.expectEqualSlices(codec.Felt, expected, encoded);
        for (0..expected.len) |end| {
            if (tx.decodeCalls(a, expected[0..end], mode, 32)) |bad| {
                a.free(bad);
                return error.AcceptedTruncatedStarknetCalls;
            } else |_| {}
        }
        try std.testing.expectError(error.StarknetCallLimit, tx.decodeCalls(a, expected, mode, calls.len - 1));
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 14), count);
}
fn allocation(a: A) !void {
    const values = [_]codec.Felt{ try codec.Felt.init(2), try codec.Felt.init(1), try codec.Felt.init(2), try codec.Felt.init(1), try codec.Felt.init(3), try codec.Felt.init(4), try codec.Felt.init(5), try codec.Felt.init(0) };
    const result = try tx.decodeCalls(a, &values, .modern, 2);
    defer a.free(result);
    try std.testing.expectEqual(@as(usize, 2), result.len);
}
test "Starknet batch strict legacy offsets trailing data limits and allocation ownership" {
    const a = std.testing.allocator;
    const call = [_]tx.Call{ .{ .to = try codec.Felt.init(1), .selector = try codec.Felt.init(2), .calldata = &.{try codec.Felt.init(3)} }, .{ .to = try codec.Felt.init(4), .selector = try codec.Felt.init(5), .calldata = &.{try codec.Felt.init(6)} } };
    const encoded = try tx.encodeCalls(a, &call, .legacy);
    defer a.free(encoded);
    encoded[7] = try codec.Felt.init(0); // overlapping second offset
    try std.testing.expectError(error.InvalidStarknetCalls, tx.decodeCalls(a, encoded, .legacy, 2));
    encoded[7] = try codec.Felt.init(1);
    encoded[9] = try codec.Felt.init(3); // false total calldata length
    try std.testing.expectError(error.InvalidStarknetCalls, tx.decodeCalls(a, encoded, .legacy, 2));
    const trailing = [_]codec.Felt{ codec.Felt.zero, codec.Felt.zero };
    try std.testing.expectError(error.TrailingCairoData, tx.decodeCalls(a, &trailing, .modern, 2));
    try std.testing.checkAllAllocationFailures(a, allocation, .{});
}

test "Starknet batch generated call codec roundtrip canonical ownership seed 0x62746368636f6465 cases 260" {
    const a = std.testing.allocator;
    var generator = std.Random.DefaultPrng.init(0x62746368636f6465);
    const random = generator.random();
    for ([_]tx.Encoding{ .legacy, .modern }) |mode| {
        // Explicit empty, singleton, and maximum-sized arrays precede generated cases.
        for (0..130) |case| {
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            const scratch = arena.allocator();
            const count: usize = switch (case) {
                0 => 0,
                1 => 1,
                2 => 32,
                else => random.uintLessThan(usize, 33),
            };
            const calls = try scratch.alloc(tx.Call, count);
            for (calls, 0..) |*call, i| {
                const data = try scratch.alloc(codec.Felt, if (case == 2) 32 else random.uintLessThan(usize, 33));
                for (data) |*felt| felt.* = try codec.Felt.init(random.int(u256) % codec.prime);
                call.* = .{ .to = try codec.Felt.init(i), .selector = try codec.Felt.init(random.int(u256) % codec.prime), .calldata = data };
            }
            const encoded = try tx.encodeCalls(scratch, calls, mode);
            const decoded = try tx.decodeCalls(a, encoded, mode, 32);
            defer a.free(decoded);
            try std.testing.expectEqual(calls.len, decoded.len);
            for (calls, decoded) |expected, actual| {
                try std.testing.expectEqual(expected.to, actual.to);
                try std.testing.expectEqual(expected.selector, actual.selector);
                try std.testing.expectEqualSlices(codec.Felt, expected.calldata, actual.calldata);
            }
            const canonical = try tx.encodeCalls(scratch, decoded, mode);
            try std.testing.expectEqualSlices(codec.Felt, encoded, canonical);
            if (case < 3) for (0..encoded.len) |end| {
                if (tx.decodeCalls(a, encoded[0..end], mode, 32)) |bad| {
                    a.free(bad);
                    return error.AcceptedTruncatedStarknetCalls;
                } else |_| {}
            };
            const extended = try scratch.alloc(codec.Felt, encoded.len + 1);
            @memcpy(extended[0..encoded.len], encoded);
            extended[encoded.len] = codec.Felt.zero;
            if (tx.decodeCalls(a, extended, mode, 32)) |bad| {
                a.free(bad);
                return error.AcceptedTrailingStarknetCalls;
            } else |_| {}
        }
    }
}
