//! Before recursive JSON normalization/serialization, enforce serde_json's
//! default container-depth bound. Scanner uses an iterative tiny bit stack;
//! strings/numbers are skipped as input slices without allocating their values.
const std = @import("std");
pub fn validate(input: []const u8) !void {
    var storage: [256]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&storage);
    var scanner = std.json.Scanner.initCompleteInput(fixed.allocator(), input);
    defer scanner.deinit();
    while (true) {
        const token = try scanner.next();
        if (scanner.stackHeight() > 128) return error.JsonDepthExceeded;
        if (token == .end_of_document) return;
    }
}
test "JSON scanner rejects attacker depth before DOM allocation and ignores delimiters in strings" {
    try validate("{\"text\":\"[[[[{\\\"x\\\":1}]]]]\",\"value\":[1,2]}");
    var bytes: [258]u8 = undefined;
    @memset(bytes[0..129], '[');
    @memset(bytes[129..], ']');
    try std.testing.expectError(error.JsonDepthExceeded, validate(&bytes));
    try validate(bytes[1..257]);
    try std.testing.expectError(error.UnexpectedEndOfInput, validate("{\"x\":[1"));
}
