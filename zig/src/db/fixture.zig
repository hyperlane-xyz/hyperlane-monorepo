//! Helpers for public, generated interoperability fixtures; not runtime DB data.
const std = @import("std");
pub fn hexBytes(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(allocator);
    if (value == .string) {
        try text.appendSlice(allocator, value.string);
    } else if (value == .array) {
        for (value.array.items) |chunk| {
            if (chunk != .string) return error.ExpectedHexChunk;
            try text.appendSlice(allocator, chunk.string);
        }
    } else return error.ExpectedHexBytes;
    if (text.items.len % 2 != 0) return error.OddHexLength;
    const bytes = try allocator.alloc(u8, text.items.len / 2);
    errdefer allocator.free(bytes);
    _ = try std.fmt.hexToBytes(bytes, text.items);
    return bytes;
}
