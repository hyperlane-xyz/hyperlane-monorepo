//! Public validator build/config metadata. Only Keccak identities leave this
//! boundary: original RPC URLs and their credential/header components never do.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const Url = @import("../../net/url_host.zig");
pub const unknown_git_sha = "VERGEN_IDEMPOTENT_OUTPUT";
const Entry = struct { url_hash: []const u8, host_hash: []const u8 };
fn hash(a: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha3.Keccak256.hash(bytes, &digest, .{});
    return std.fmt.allocPrint(a, "0x{s}", .{std.fmt.bytesToHex(digest, .lower)});
}
pub const HostNormalizer = struct {
    context: *anyopaque,
    normalize_fn: *const fn (*anyopaque, std.mem.Allocator, []const u8) anyerror![]u8,
    pub fn normalize(self: HostNormalizer, a: std.mem.Allocator, text: []const u8) ![]u8 {
        return self.normalize_fn(self.context, a, text);
    }
    pub fn fromLibrary(library: *Url.Library) HostNormalizer {
        return .{ .context = library, .normalize_fn = nativeHost };
    }
    fn nativeHost(context: *anyopaque, a: std.mem.Allocator, text: []const u8) ![]u8 {
        const library: *Url.Library = @ptrCast(@alignCast(context));
        return library.normalize(a, text);
    }
};
pub fn serialize(a: std.mem.Allocator, git_sha: []const u8, rpcs: []const settings.Rpc, allows_public_rpcs: bool, normalizer: HostNormalizer) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const entries = try temporary.alloc(Entry, rpcs.len);
    for (rpcs, entries) |rpc, *entry| entry.* = .{ .url_hash = try hash(temporary, rpc.url), .host_hash = try hash(temporary, try normalizer.normalize(temporary, rpc.url)) };
    return std.json.Stringify.valueAlloc(a, .{ .git_sha = git_sha, .rpcs = entries, .allows_public_rpcs = allows_public_rpcs }, .{ .whitespace = .indent_2 });
}
