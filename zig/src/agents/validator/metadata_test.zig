const std = @import("std");
const metadata = @import("metadata.zig");
const Url = @import("../../net/url_host.zig");
const settings = @import("../../settings/types.zig");
pub fn nativeLibrary() !Url.Library {
    const path = std.process.getEnvVarOwned(std.testing.allocator, "HYPERLANE_URL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer std.testing.allocator.free(path);
    return Url.Library.open(path);
}
const Fixture = struct { records: []const struct { urls: []const []const u8, allows_public_rpcs: bool, metadata_utf8: []const u8 } };

test "validator metadata full pretty schema matches actual immutable Rust producer including private RPC identities" {
    const a = std.testing.allocator;
    var library = try nativeLibrary();
    defer library.deinit();
    const normalizer = metadata.HostNormalizer.fromLibrary(&library);
    const fixture = try @import("../../testing/fixture.zig").parse(Fixture, a, @embedFile("fixtures/metadata.json.gz"), .{ .ignore_unknown_fields = true });
    defer fixture.deinit();
    for (fixture.value.records) |record| {
        const parsed = try std.json.parseFromSlice(std.json.Value, a, record.metadata_utf8, .{});
        defer parsed.deinit();
        const rpcs = try a.alloc(settings.Rpc, record.urls.len);
        defer a.free(rpcs);
        for (rpcs, record.urls) |*rpc, url| rpc.* = .{ .url = url, .public = false };
        const actual = try metadata.serialize(a, parsed.value.object.get("git_sha").?.string, rpcs, record.allows_public_rpcs, normalizer);
        defer a.free(actual);
        try std.testing.expectEqualStrings(record.metadata_utf8, actual);
        for ([_][]const u8{ "public-fixture", "LOCALHOST", "localhost", "127.0.0.1", "private/path", "custom_rpc_header", "user:" }) |secret| try std.testing.expect(std.mem.indexOf(u8, actual, secret) == null);
    }
}
test "validator metadata keeps full raw RPC identity and malformed or hostless host is empty Keccak" {
    const a = std.testing.allocator;
    var library = try nativeLibrary();
    defer library.deinit();
    const normalizer = metadata.HostNormalizer.fromLibrary(&library);
    const bytes = try metadata.serialize(a, metadata.unknown_git_sha, &.{ .{ .url = "not a URL", .public = false }, .{ .url = "file:///tmp/public-fixture", .public = false } }, false, normalizer);
    defer a.free(bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    for (parsed.value.object.get("rpcs").?.array.items) |entry| try std.testing.expectEqualStrings("0xc5d2460186f7233c927e7db2dcc703c0e5" ++ "00b653ca82273b7bfad8045d85a470", entry.object.get("host_hash").?.string);
}
fn allocations(a: std.mem.Allocator, normalizer: metadata.HostNormalizer) !void {
    const bytes = try metadata.serialize(a, "1111111111111111111111111111111111111111", &.{ .{ .url = "https://user:public-fixture@EXAMPLE.com:443/private?token=public-fixture", .public = false }, .{ .url = "https://[2001:0DB8::1]:443/", .public = false } }, true, normalizer);
    defer a.free(bytes);
}
test "validator metadata every allocation failure releases raw URL normalization and output" {
    var library = try nativeLibrary();
    defer library.deinit();
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocations, .{metadata.HostNormalizer.fromLibrary(&library)});
}

test "validator metadata host hashes ignore userinfo path query port and custom header spelling" {
    const a = std.testing.allocator;
    var library = try nativeLibrary();
    defer library.deinit();
    const normalizer = metadata.HostNormalizer.fromLibrary(&library);
    const bytes = try metadata.serialize(a, metadata.unknown_git_sha, &.{ .{ .url = "https://example.com/", .public = false }, .{ .url = "https://user:public-fixture@EXAMPLE.COM:443/path?value='public'&custom_rpc_header=X-Fixture%3Apublic", .public = false }, .{ .url = "https://%65xample.com/path", .public = false } }, false, normalizer);
    defer a.free(bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    const entries = parsed.value.object.get("rpcs").?.array.items;
    for (entries[1..]) |entry| {
        try std.testing.expectEqualStrings(entries[0].object.get("host_hash").?.string, entry.object.get("host_hash").?.string);
        try std.testing.expect(!std.mem.eql(u8, entries[0].object.get("url_hash").?.string, entry.object.get("url_hash").?.string));
    }
}

fn fixedHost(_: *anyopaque, a: std.mem.Allocator, _: []const u8) ![]u8 {
    return a.dupe(u8, "example.com");
}
test "validator metadata serializer keeps duplicate rows order and flags with an injected public host normalizer" {
    const a = std.testing.allocator;
    var token: u8 = 0;
    const bytes = try metadata.serialize(a, metadata.unknown_git_sha, &.{ .{ .url = "https://example.com/public?fixture=1", .public = false }, .{ .url = "https://example.com/public?fixture=1", .public = true } }, true, .{ .context = &token, .normalize_fn = fixedHost });
    defer a.free(bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(usize, 3), parsed.value.object.count());
    try std.testing.expect(parsed.value.object.get("allows_public_rpcs").?.bool);
    const rows = parsed.value.object.get("rpcs").?.array.items;
    try std.testing.expectEqual(@as(usize, 2), rows.len);
    try std.testing.expectEqualStrings(rows[0].object.get("url_hash").?.string, rows[1].object.get("url_hash").?.string);
    try std.testing.expect(std.mem.indexOf(u8, bytes, "example.com") == null);
}
