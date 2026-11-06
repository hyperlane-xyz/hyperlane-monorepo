//! Address deny checks with Rust's exact byte-prefix scanning semantics.
const std = @import("std");
const settings = @import("../settings/types.zig");
pub const CompiledAddress = struct {
    /// Caller-owned canonical bytes. An empty entry matches every message.
    bytes: []const u8,
    reason: []const u8 = "",
};
pub const AddressBlacklist = struct {
    allocator: std.mem.Allocator,
    addresses: []CompiledAddress,
    backing: []u8,
    pub fn init(allocator: std.mem.Allocator, raw: []const []const u8) !AddressBlacklist {
        var total: usize = 0;
        for (raw) |entry| total += try std.math.add(usize, entry.len, 1);
        const backing = try allocator.alloc(u8, total);
        errdefer allocator.free(backing);
        var offset: usize = 0;
        const addresses = try allocator.alloc(CompiledAddress, raw.len);
        errdefer allocator.free(addresses);
        for (raw, 0..) |entry, i| {
            @memcpy(backing[offset..][0..entry.len], entry);
            addresses[i] = .{ .bytes = backing[offset..][0..entry.len] };
            offset += entry.len;
            backing[offset] = 0;
            offset += 1;
        }
        return .{ .allocator = allocator, .addresses = addresses, .backing = backing };
    }
    pub fn deinit(self: *AddressBlacklist) void {
        self.allocator.free(self.addresses);
        self.allocator.free(self.backing);
        self.* = undefined;
    }
    pub fn find(self: *const AddressBlacklist, sender: []const u8, recipient: []const u8, body: []const u8) ?CompiledAddress {
        for (self.addresses) |address| {
            if (contains(sender, address.bytes) or contains(recipient, address.bytes) or contains(body, address.bytes)) return address;
        }
        return null;
    }
};
/// Rust calls this `is_subsequence`, but its loop only accepts a contiguous
/// prefix after sliding one byte at a time. Empty needles always match.
pub fn contains(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    var offset: usize = 0;
    while (offset < haystack.len) : (offset += 1) {
        if (needle.len > haystack.len - offset) return false;
        if (std.mem.eql(u8, haystack[offset .. offset + needle.len], needle)) return true;
    }
    return false;
}
test "address scanner preserves Rust prefix and empty-needle semantics" {
    const raw = [_][]const u8{ "he", "" };
    var list = try AddressBlacklist.init(std.testing.allocator, &raw);
    defer list.deinit();
    try std.testing.expect(contains("hello", "he"));
    try std.testing.expect(contains("hello", "lo"));
    try std.testing.expect(contains("hello", ""));
    try std.testing.expect(!contains("hello", "hello world"));
    try std.testing.expect(!contains("hello", "world"));
    try std.testing.expect(list.find("", "", &.{}) != null);
}
