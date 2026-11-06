const std = @import("std");
const host = @import("url_host.zig");
fn library() !host.Library {
    const a = std.testing.allocator;
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_URL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    return host.Library.open(path);
}
test "URL host native exact Rust IDNA numeric IPv4 IPv6 and invalid parse semantics" {
    var native = try library();
    defer native.deinit();
    const Case = struct { raw: []const u8, expected: []const u8 };
    for ([_]Case{
        .{ .raw = "https://EXAMPLE.com:443/a?fixture=redacted", .expected = "example.com" },
        .{ .raw = "https://bücher.example/", .expected = "xn--bcher-kva.example" },
        .{ .raw = "https://例え.テスト/", .expected = "xn--r8jz45g.xn--zckzah" },
        .{ .raw = "http://127.1/", .expected = "127.0.0.1" },
        .{ .raw = "http://0177.0.0.1/", .expected = "127.0.0.1" },
        .{ .raw = "http://0x7f000001/", .expected = "127.0.0.1" },
        .{ .raw = "http://2130706433/", .expected = "127.0.0.1" },
        .{ .raw = "http://[2001:0db8::1]:9090/", .expected = "[2001:db8::1]" },
        .{ .raw = "https://user:publicfixture@exa%6dple.com/", .expected = "example.com" },
        .{ .raw = "mailto:fixture@example.com", .expected = "" },
        .{ .raw = "invalid URL", .expected = "" },
        .{ .raw = "https://", .expected = "" },
    }) |case| {
        const result = try native.normalize(std.testing.allocator, case.raw);
        defer std.testing.allocator.free(result);
        try std.testing.expectEqualStrings(case.expected, result);
    }
    try std.testing.expectError(error.InvalidUrlHostInput, native.normalize(std.testing.allocator, &.{0xff}));
}
fn allocation(a: std.mem.Allocator, native: *host.Library, input: []const u8) !void {
    const value = try native.normalize(a, input);
    defer a.free(value);
    try std.testing.expect(value.len != 0);
}
test "URL host long opaque hosts caller ownership and every Zig allocation failure" {
    const a = std.testing.allocator;
    var native = try library();
    defer native.deinit();
    const input = try a.alloc(u8, 2048 + 7);
    defer a.free(input);
    @memcpy(input[0..6], "foo://");
    @memset(input[6 .. input.len - 1], 'A');
    input[input.len - 1] = '/';
    const result = try native.normalize(a, input);
    defer a.free(result);
    try std.testing.expectEqual(@as(usize, 2048), result.len);
    try std.testing.expect(std.mem.allEqual(u8, result, 'A'));
    @memset(input, 0);
    try std.testing.expect(std.mem.allEqual(u8, result, 'A'));
    try std.testing.checkAllAllocationFailures(a, allocation, .{ &native, "http://127.1" });
    @memcpy(input[0..6], "foo://");
    @memset(input[6 .. input.len - 1], 'A');
    input[input.len - 1] = '/';
    try std.testing.checkAllAllocationFailures(a, allocation, .{ &native, input });
    const oversized = try a.alloc(u8, host.maximum_input + 1);
    defer a.free(oversized);
    try std.testing.expectError(error.UrlHostInputTooLarge, native.normalize(a, oversized));
}

test "URL host config-size boundary accepts query larger than one megabyte" {
    const a = std.testing.allocator;
    var native = try library();
    defer native.deinit();
    const prefix = "https://example.com/?fixture=";
    const input = try a.alloc(u8, 2 * 1024 * 1024 + prefix.len);
    defer a.free(input);
    @memcpy(input[0..prefix.len], prefix);
    @memset(input[prefix.len..], 'x');
    const result = try native.normalize(a, input);
    defer a.free(result);
    try std.testing.expectEqualStrings("example.com", result);
}
