const std = @import("std");
const abi = @import("../evm/codecs.zig");

pub const aggregate3_selector = [4]u8{ 0x82, 0xad, 0x56, 0xcb };
pub const aggregate3_value_selector = [4]u8{ 0x17, 0x4d, 0xea, 0x71 };
pub const error_selector = [4]u8{ 0x08, 0xc3, 0x79, 0xa0 };

pub const Call = struct {
    to: [20]u8,
    value: u256 = 0,
    data: []const u8,
};

pub const Encoded = struct {
    calldata: []u8,
    value: u256,

    pub fn deinit(self: *Encoded, allocator: std.mem.Allocator) void {
        allocator.free(self.calldata);
        self.* = undefined;
    }
};

pub const Result = struct {
    success: bool,
    return_data: []const u8,
};

fn paddedLength(len: usize) !usize {
    return std.math.add(usize, len, (32 - len % 32) % 32);
}

fn putWord(dest: []u8, value: anytype) void {
    std.mem.writeInt(u256, dest[0..32], value, .big);
}

pub fn encode(allocator: std.mem.Allocator, calls: []const Call) !Encoded {
    var total_value: u256 = 0;
    for (calls) |call|
        total_value = std.math.add(u256, total_value, call.value) catch return error.ValueOverflow;

    const has_value = total_value != 0;
    const tuple_head: usize = if (has_value) 128 else 96;
    var tuples_len: usize = 0;
    for (calls) |call| {
        const data_len = try paddedLength(call.data.len);
        const tuple_len = try std.math.add(usize, tuple_head, try std.math.add(usize, 32, data_len));
        tuples_len = try std.math.add(usize, tuples_len, tuple_len);
    }
    const offsets_len = try std.math.mul(usize, calls.len, 32);
    const len = try std.math.add(usize, 68, try std.math.add(usize, offsets_len, tuples_len));
    const calldata = try allocator.alloc(u8, len);
    errdefer allocator.free(calldata);
    @memset(calldata, 0);
    calldata[0..4].* = if (has_value) aggregate3_value_selector else aggregate3_selector;
    putWord(calldata[4..36], 32);
    putWord(calldata[36..68], calls.len);

    var relative_offset = offsets_len;
    var write_at = try std.math.add(usize, 68, offsets_len);
    for (calls, 0..) |call, i| {
        putWord(calldata[68 + i * 32 ..][0..32], relative_offset);
        const tuple = calldata[write_at..];
        tuple[12..32].* = call.to;
        tuple[63] = 1;
        if (has_value) putWord(tuple[64..96], call.value);
        putWord(tuple[if (has_value) 96 else 64..][0..32], tuple_head);
        putWord(tuple[tuple_head..][0..32], call.data.len);
        const data_start = tuple_head + 32;
        @memcpy(tuple[data_start..][0..call.data.len], call.data);
        const tuple_len = data_start + try paddedLength(call.data.len);
        relative_offset = try std.math.add(usize, relative_offset, tuple_len);
        write_at = try std.math.add(usize, write_at, tuple_len);
    }
    return .{ .calldata = calldata, .value = total_value };
}

pub fn encodeResults(allocator: std.mem.Allocator, results: []const Result) ![]u8 {
    const offsets_len = try std.math.mul(usize, results.len, 32);
    var tuples_len: usize = 0;
    for (results) |result| tuples_len = try std.math.add(usize, tuples_len, try std.math.add(usize, 96, try paddedLength(result.return_data.len)));
    const out = try allocator.alloc(u8, try std.math.add(usize, 64, try std.math.add(usize, offsets_len, tuples_len)));
    errdefer allocator.free(out);
    @memset(out, 0);
    putWord(out[0..32], 32);
    putWord(out[32..64], results.len);
    var relative_offset = offsets_len;
    var write_at = 64 + offsets_len;
    for (results, 0..) |result, i| {
        putWord(out[64 + i * 32 ..][0..32], relative_offset);
        const tuple = out[write_at..];
        tuple[31] = @intFromBool(result.success);
        putWord(tuple[32..64], 64);
        putWord(tuple[64..96], result.return_data.len);
        @memcpy(tuple[96..][0..result.return_data.len], result.return_data);
        const tuple_len = 96 + try paddedLength(result.return_data.len);
        relative_offset = try std.math.add(usize, relative_offset, tuple_len);
        write_at = try std.math.add(usize, write_at, tuple_len);
    }
    return out;
}

pub fn decode(allocator: std.mem.Allocator, data: []const u8, expected_count: usize) ![]Result {
    if (data.len < 64 or data.len % 32 != 0) return error.InvalidAbi;
    if (try abi.uintWord(usize, data[0..32]) != 32) return error.InvalidAbi;
    const count = try abi.uintWord(usize, data[32..64]);
    if (count != expected_count) return error.ResultCountMismatch;
    const offsets_len = try std.math.mul(usize, count, 32);
    _ = try std.math.add(usize, 64, offsets_len);
    if (offsets_len > data.len - 64) return error.InvalidAbi;

    const results = try allocator.alloc(Result, count);
    errdefer allocator.free(results);
    var relative_offset = offsets_len;
    for (results, 0..) |*result, i| {
        if (try abi.uintWord(usize, data[64 + i * 32 ..][0..32]) != relative_offset) return error.InvalidAbi;
        const tuple_start = try std.math.add(usize, 64, relative_offset);
        const head_end = try std.math.add(usize, tuple_start, 64);
        if (head_end > data.len) return error.InvalidAbi;
        const tuple = data[tuple_start..];
        const success = try abi.decodeBool(tuple[0..32]);
        if (try abi.uintWord(usize, tuple[32..64]) != 64) return error.InvalidAbi;
        const length_end = try std.math.add(usize, head_end, 32);
        if (length_end > data.len) return error.InvalidAbi;
        const return_len = try abi.uintWord(usize, data[head_end..length_end]);
        const padded_len = try paddedLength(return_len);
        const tuple_len = try std.math.add(usize, 96, padded_len);
        const tuple_end = try std.math.add(usize, tuple_start, tuple_len);
        if (tuple_end > data.len) return error.InvalidAbi;
        const return_end = try std.math.add(usize, length_end, return_len);
        if (!std.mem.allEqual(u8, data[return_end..tuple_end], 0)) return error.InvalidAbi;
        result.* = .{ .success = success, .return_data = data[length_end..return_end] };
        relative_offset = try std.math.add(usize, relative_offset, tuple_len);
    }
    if (try std.math.add(usize, 64, relative_offset) != data.len) return error.InvalidAbi;
    return results;
}

pub fn revertReason(data: []const u8) ?[]const u8 {
    if (data.len < 68 or !std.mem.eql(u8, data[0..4], &error_selector)) return null;
    const reason = abi.dynamicBytes(data[4..]) catch return null;
    if (!std.unicode.utf8ValidateSlice(reason)) return null;
    return reason;
}

test "empty aggregate and result use canonical dynamic arrays" {
    const allocator = std.testing.allocator;
    var encoded = try encode(allocator, &.{});
    defer encoded.deinit(allocator);
    try std.testing.expectEqual(@as(u256, 0), encoded.value);
    try std.testing.expectEqual(@as(usize, 68), encoded.calldata.len);
    try std.testing.expectEqualSlices(u8, &aggregate3_selector, encoded.calldata[0..4]);
    try std.testing.expectEqual(@as(usize, 32), try abi.uintWord(usize, encoded.calldata[4..36]));
    try std.testing.expectEqual(@as(usize, 0), try abi.uintWord(usize, encoded.calldata[36..68]));

    var data: [64]u8 = @splat(0);
    putWord(data[0..32], 32);
    const results = try decode(allocator, &data, 0);
    defer allocator.free(results);
    try std.testing.expectEqual(@as(usize, 0), results.len);
    try std.testing.expectError(error.ResultCountMismatch, decode(allocator, &data, 1));
}

test "aggregate value addition overflows instead of wrapping" {
    const calls = [_]Call{
        .{ .to = @splat(0x11), .value = std.math.maxInt(u256), .data = &.{} },
        .{ .to = @splat(0x22), .value = 1, .data = &.{} },
    };
    try std.testing.expectError(error.ValueOverflow, encode(std.testing.allocator, &calls));
}

test "Error string reason is borrowed and strictly validated" {
    var data: [100]u8 = @splat(0);
    data[0..4].* = error_selector;
    putWord(data[4..36], 32);
    putWord(data[36..68], 6);
    @memcpy(data[68..74], "denied");
    const reason = revertReason(&data).?;
    try std.testing.expectEqualStrings("denied", reason);
    try std.testing.expectEqual(@as(usize, 68), @intFromPtr(reason.ptr) - @intFromPtr(&data));

    data[74] = 1;
    try std.testing.expect(revertReason(&data) == null);
    data[74] = 0;
    data[68] = 0xff;
    try std.testing.expect(revertReason(&data) == null);
    data[68] = 'd';
    data[3] = 0;
    try std.testing.expect(revertReason(&data) == null);
}

fn hexChunksAlloc(allocator: std.mem.Allocator, chunks: []const []const u8) ![]u8 {
    var len: usize = 0;
    for (chunks) |chunk| {
        if (chunk.len % 2 != 0) return error.InvalidHex;
        len = try std.math.add(usize, len, chunk.len / 2);
    }
    const bytes = try allocator.alloc(u8, len);
    errdefer allocator.free(bytes);
    var offset: usize = 0;
    for (chunks) |chunk| {
        const chunk_len = chunk.len / 2;
        _ = std.fmt.hexToBytes(bytes[offset..][0..chunk_len], chunk) catch return error.InvalidHex;
        offset += chunk_len;
    }
    return bytes;
}

const oracle_aggregate3_zero = [_][]const u8{
    "82ad56cb000000000000000000000000",
    "00000000000000000000000000000000",
    "00000020000000000000000000000000",
    "00000000000000000000000000000000",
    "00000002000000000000000000000000",
    "00000000000000000000000000000000",
    "00000040000000000000000000000000",
    "00000000000000000000000000000000",
    "000000e0000000000000000000000000",
    "11111111111111111111111111111111",
    "11111111000000000000000000000000",
    "00000000000000000000000000000000",
    "00000001000000000000000000000000",
    "00000000000000000000000000000000",
    "00000060000000000000000000000000",
    "00000000000000000000000000000000",
    "00000004deadbeef0000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "22222222222222222222222222222222",
    "22222222000000000000000000000000",
    "00000000000000000000000000000000",
    "00000001000000000000000000000000",
    "00000000000000000000000000000000",
    "00000060000000000000000000000000",
    "00000000000000000000000000000000",
    "00000005010203040500000000000000",
    "00000000000000000000000000000000",
    "00000000",
};

const oracle_aggregate3_value = [_][]const u8{
    "174dea71000000000000000000000000",
    "00000000000000000000000000000000",
    "00000020000000000000000000000000",
    "00000000000000000000000000000000",
    "00000002000000000000000000000000",
    "00000000000000000000000000000000",
    "00000040000000000000000000000000",
    "00000000000000000000000000000000",
    "00000100000000000000000000000000",
    "11111111111111111111111111111111",
    "11111111000000000000000000000000",
    "00000000000000000000000000000000",
    "00000001000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000080000000000000000000000000",
    "00000000000000000000000000000000",
    "00000004deadbeef0000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "22222222222222222222222222222222",
    "22222222000000000000000000000000",
    "00000000000000000000000000000000",
    "00000001000000000000000000000000",
    "00000000000000000000000000000000",
    "00000007000000000000000000000000",
    "00000000000000000000000000000000",
    "00000080000000000000000000000000",
    "00000000000000000000000000000000",
    "00000005010203040500000000000000",
    "00000000000000000000000000000000",
    "00000000",
};

const oracle_results = [_][]const u8{
    "00000000000000000000000000000000",
    "00000000000000000000000000000020",
    "00000000000000000000000000000000",
    "00000000000000000000000000000002",
    "00000000000000000000000000000000",
    "00000000000000000000000000000040",
    "00000000000000000000000000000000",
    "000000000000000000000000000000c0",
    "00000000000000000000000000000000",
    "00000000000000000000000000000001",
    "00000000000000000000000000000000",
    "00000000000000000000000000000040",
    "00000000000000000000000000000000",
    "00000000000000000000000000000002",
    "cafe0000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000040",
    "00000000000000000000000000000000",
    "00000000000000000000000000000064",
    "08c379a0000000000000000000000000",
    "00000000000000000000000000000000",
    "00000020000000000000000000000000",
    "00000000000000000000000000000000",
    "0000000664656e696564000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
    "00000000000000000000000000000000",
};

test "aggregate encodings exactly match pinned ethers" {
    const allocator = std.testing.allocator;
    var calls = [_]Call{
        .{ .to = @splat(0x11), .data = &.{ 0xde, 0xad, 0xbe, 0xef } },
        .{ .to = @splat(0x22), .data = &.{ 1, 2, 3, 4, 5 } },
    };
    var zero = try encode(allocator, &calls);
    defer zero.deinit(allocator);
    const expected_zero = try hexChunksAlloc(allocator, &oracle_aggregate3_zero);
    defer allocator.free(expected_zero);
    try std.testing.expectEqual(@as(u256, 0), zero.value);
    try std.testing.expectEqualSlices(u8, expected_zero, zero.calldata);

    calls[1].value = 7;
    var nonzero = try encode(allocator, &calls);
    defer nonzero.deinit(allocator);
    const expected_nonzero = try hexChunksAlloc(allocator, &oracle_aggregate3_value);
    defer allocator.free(expected_nonzero);
    try std.testing.expectEqual(@as(u256, 7), nonzero.value);
    try std.testing.expectEqualSlices(u8, expected_nonzero, nonzero.calldata);
}

test "aggregate results borrow return data and revert reasons" {
    const allocator = std.testing.allocator;
    const data = try hexChunksAlloc(allocator, &oracle_results);
    defer allocator.free(data);
    const results = try decode(allocator, data, 2);
    defer allocator.free(results);
    try std.testing.expectEqual(@as(usize, 2), results.len);
    try std.testing.expect(results[0].success);
    try std.testing.expect(!results[1].success);
    try std.testing.expectEqualSlices(u8, &.{ 0xca, 0xfe }, results[0].return_data);
    try std.testing.expectEqualStrings("denied", revertReason(results[1].return_data).?);
    try std.testing.expectEqual(@as(usize, 224), @intFromPtr(results[0].return_data.ptr) - @intFromPtr(data.ptr));
    try std.testing.expectEqual(@as(usize, 352), @intFromPtr(results[1].return_data.ptr) - @intFromPtr(data.ptr));
}

test "aggregate result decoding rejects counts offsets bounds padding and trailing data" {
    const allocator = std.testing.allocator;
    const data = try hexChunksAlloc(allocator, &oracle_results);
    defer allocator.free(data);
    try std.testing.expectError(error.ResultCountMismatch, decode(allocator, data, 1));
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data[0 .. data.len - 32], 2));

    data[31] = 64;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 2));
    data[31] = 32;
    data[63] = 3;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 3));
    data[63] = 2;
    data[95] = 65;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 2));
    data[95] = 64;
    data[127] = 193;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 2));
    data[127] = 192;
    data[159] = 2;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 2));
    data[159] = 1;
    data[191] = 63;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 2));
    data[191] = 64;

    @memset(data[192..224], 0xff);
    try std.testing.expectError(error.IntegerOverflow, decode(allocator, data, 2));
    @memset(data[192..224], 0);
    data[223] = 2;
    data[226] = 1;
    try std.testing.expectError(error.InvalidAbi, decode(allocator, data, 2));
    data[226] = 0;

    const trailing = try allocator.alloc(u8, data.len + 32);
    defer allocator.free(trailing);
    @memcpy(trailing[0..data.len], data);
    @memset(trailing[data.len..], 0);
    try std.testing.expectError(error.InvalidAbi, decode(allocator, trailing, 2));
}
