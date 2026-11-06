//! Lossless checked-in fixture compression. Decoding preserves the original SDK
//! response bytes; parsed strings own their storage after decompression closes.
const std = @import("std");
const A = std.mem.Allocator;
pub fn bytes(a: A, input: []const u8, maximum: usize) ![]u8 {
    if (input.len < 2 or input[0] != 0x1f or input[1] != 0x8b) {
        if (input.len > maximum) return error.FixtureTooLarge;
        return a.dupe(u8, input);
    }
    var source = std.Io.Reader.fixed(input);
    const buffer = try a.alloc(u8, std.compress.flate.max_window_len);
    defer a.free(buffer);
    var decoder = std.compress.flate.Decompress.init(&source, .gzip, buffer);
    const result = decoder.reader.allocRemaining(a, .limited(maximum)) catch |err| {
        if (err == error.ReadFailed) return decoder.err orelse err;
        return err;
    };
    errdefer a.free(result);
    // One fixture is one member. Reject unnoticed concatenated/trailing bytes.
    if (source.seek != input.len) return error.TrailingFixtureData;
    // Zig0.15's inflater consumes the gzip footer without checking its CRC.
    if (input.len < 18) return error.BadGzipHeader;
    const checksum = std.mem.readInt(u32, input[input.len - 8 ..][0..4], .little);
    const size = std.mem.readInt(u32, input[input.len - 4 ..][0..4], .little);
    if (std.hash.Crc32.hash(result) != checksum) return error.WrongGzipChecksum;
    if (@as(u32, @truncate(result.len)) != size) return error.WrongGzipSize;
    return result;
}
pub fn parse(comptime T: type, a: A, input: []const u8, supplied: std.json.ParseOptions) !std.json.Parsed(T) {
    const decoded = try bytes(a, input, 16 * 1024 * 1024);
    defer a.free(decoded);
    var options = supplied;
    options.allocate = .alloc_always;
    return std.json.parseFromSlice(T, a, decoded, options);
}
const probe = @embedFile("fixtures/gzip-probe.json.gz");
test "compressed SDK fixtures preserve exact bytes numbers and parsed ownership" {
    const a = std.testing.allocator;
    const decoded = try bytes(a, probe, 1024);
    defer a.free(decoded);
    try std.testing.expectEqualStrings("{\"label\":\"public fixture\",\"integer\":123456789012345678901234567890}", decoded);
    const Record = struct { label: []const u8, integer: u256 };
    var parsed = try parse(Record, a, probe, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("public fixture", parsed.value.label);
    try std.testing.expectEqual(@as(u256, 123456789012345678901234567890), parsed.value.integer);
    try std.testing.expectError(error.StreamTooLong, bytes(a, probe, 1));
    var corrupt: [probe.len]u8 = probe.*;
    corrupt[corrupt.len - 8] ^= 1;
    try std.testing.expectError(error.WrongGzipChecksum, bytes(a, &corrupt, 1024));
}
fn allocationSweep(a: A) !void {
    const Record = struct { label: []const u8, integer: u256 };
    var parsed = try parse(Record, a, probe, .{});
    defer parsed.deinit();
}
test "compressed fixture allocation failures release decoded and parsed storage" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}
