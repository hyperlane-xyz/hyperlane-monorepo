//! ISM-aware metadata-root classification. Operation/queue classification is
//! separate; children inherit this resolved root context rather than querying
//! their own module against the mailbox default.
const std = @import("std");
const contract = @import("contract_cache.zig");

pub fn classify(comptime Address: type, root: Address, explicit: ?[]const u8, cache: ?*contract.CacheFor(Address).Cache, context: contract.Context, fetch: contract.CacheFor(Address).DefaultIsmFetch, now_ms: u64) ![]const u8 {
    if (explicit) |name| return name;
    // Source MessageMetadataBuilder::new propagates default-ISM lookup errors.
    // A failed classifier must not silently turn into an Unknown build.
    const actual = if (cache) |value| try contract.defaultIsmFor(Address, value, context, fetch, now_ms) else try fetch.get(now_ms);
    return if (std.mem.eql(u8, &root, &actual)) "default_ism" else "Unknown";
}

const TestAddress = [32]u8;
const Fetch = struct {
    value: TestAddress = @splat(7),
    error_value: ?anyerror = null,
    calls: usize = 0,
    now_ms: u64 = 100,
    clock_error: bool = false,
    fn get(context: *anyopaque, _: u64) !TestAddress {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.error_value) |err| return err;
        return self.value;
    }
    fn now(context: *anyopaque) !u64 {
        const self: *@This() = @ptrCast(@alignCast(context));
        if (self.clock_error) return error.UnsupportedClock;
        return self.now_ms;
    }
    fn interface(self: *@This()) contract.CacheFor(TestAddress).DefaultIsmFetch {
        return .{ .context = self, .get_fn = get, .now_ms_fn = now };
    }
};

test "metadata root app classification preserves explicit precedence strict errors and post fetch TTL" {
    const a = std.testing.allocator;
    const context: contract.Context = .{ .domain_name = "destination", .context_hash = @splat(1) };
    var cache = try contract.CacheFor(TestAddress).Cache.init(a, .{});
    defer cache.deinit();
    var fetch: Fetch = .{ .error_value = error.RpcHttpStatus };
    try std.testing.expectEqualStrings("explicit", try classify(TestAddress, @splat(7), "explicit", &cache, context, fetch.interface(), 0));
    try std.testing.expectEqual(@as(usize, 0), fetch.calls);
    try std.testing.expectError(error.RpcHttpStatus, classify(TestAddress, @splat(7), null, &cache, context, fetch.interface(), 0));
    fetch.error_value = error.PendingReadIo;
    try std.testing.expectError(error.PendingReadIo, classify(TestAddress, @splat(7), null, &cache, context, fetch.interface(), 0));
    fetch.error_value = null;
    try std.testing.expectEqualStrings("default_ism", try classify(TestAddress, @splat(7), null, &cache, context, fetch.interface(), 0));
    try std.testing.expectEqual(@as(usize, 3), fetch.calls);
    try std.testing.expectEqualStrings("Unknown", try classify(TestAddress, @splat(8), null, &cache, context, fetch.interface(), 600_099));
    try std.testing.expectEqual(@as(usize, 3), fetch.calls);
    fetch.now_ms = 600_100;
    try std.testing.expectEqualStrings("default_ism", try classify(TestAddress, @splat(7), null, &cache, context, fetch.interface(), 600_100));
    try std.testing.expectEqual(@as(usize, 4), fetch.calls);
}

test "successful default RPC survives clock failure and no cache still classifies strictly" {
    const a = std.testing.allocator;
    const context: contract.Context = .{ .domain_name = "destination", .context_hash = @splat(2) };
    var cache = try contract.CacheFor(TestAddress).Cache.init(a, .{});
    defer cache.deinit();
    var fetch: Fetch = .{ .clock_error = true };
    try std.testing.expectEqualStrings("default_ism", try classify(TestAddress, @splat(7), null, &cache, context, fetch.interface(), 20));
    try std.testing.expect(try cache.get(context, .default_ism, 600_019) != null);
    try std.testing.expect(try cache.get(context, .default_ism, 600_020) == null);
    fetch.error_value = error.RpcHttpStatus;
    try std.testing.expectError(error.RpcHttpStatus, classify(TestAddress, @splat(7), null, null, context, fetch.interface(), 0));
    fetch.error_value = null;
    try std.testing.expectEqualStrings("Unknown", try classify(TestAddress, @splat(8), null, null, context, fetch.interface(), 0));
}
