//! Shared deadline for a sequence of RPC calls on one exclusive client.
const std = @import("std");
const rpc = @import("../../evm/provider.zig");
const http = @import("../../cloud/http.zig");
/// Monotonic nanoseconds; the same clock as the transport's owner deadline.
pub const Clock = *const fn () anyerror!u64;
fn monotonicNs() anyerror!u64 {
    return http.rpcNowNs();
}
pub const Scope = struct {
    client: *rpc.RpcClient,
    original: rpc.Options,
    clock: Clock,
    timeout_ms: u32,
    owner_deadline_ns: u64,
    attached: bool = false,
    pub fn init(client: *rpc.RpcClient, timeout_ms: u32) !Scope {
        return initClock(client, timeout_ms, monotonicNs);
    }
    fn initClock(client: *rpc.RpcClient, timeout_ms: u32, clock: Clock) !Scope {
        if (timeout_ms == 0 or client.options.exchange == null) return error.ProtectedRpcExchangeRequired;
        const started = try clock();
        return .{ .client = client, .original = client.options, .clock = clock, .timeout_ms = timeout_ms, .owner_deadline_ns = started +| @as(u64, timeout_ms) * std.time.ns_per_ms };
    }
    /// Keep the Scope address stable through detach; never fork this client.
    pub fn attach(self: *Scope) void {
        std.debug.assert(!self.attached);
        self.client.options.exchange = .{ .context = self, .fetch_fn = fetch };
        self.attached = true;
    }
    pub fn remaining(self: *Scope) !u32 {
        const now = try self.clock();
        if (now >= self.owner_deadline_ns) return error.ProtectedEstimateDeadline;
        const left_ms = (self.owner_deadline_ns - now + std.time.ns_per_ms - 1) / std.time.ns_per_ms;
        return @intCast(@min(left_ms, self.timeout_ms));
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, body: []const u8, supplied: rpc.Options) !rpc.WireResponse {
        const self: *Scope = @ptrCast(@alignCast(context));
        var bounded = supplied;
        bounded.owner_deadline_ns = @min(supplied.owner_deadline_ns orelse self.owner_deadline_ns, self.owner_deadline_ns);
        bounded.timeout_ms = @min(supplied.timeout_ms, try self.remaining());
        bounded.connect_timeout_ms = @min(bounded.connect_timeout_ms, bounded.timeout_ms);
        bounded.exchange = self.original.exchange;
        const exchange = self.original.exchange.?;
        const result = try exchange.fetch_fn(exchange.context, a, body, bounded);
        errdefer a.free(result.bytes);
        _ = try self.remaining();
        return result;
    }
    pub fn deinit(self: *Scope) void {
        if (self.attached) self.client.options = self.original;
        self.* = undefined;
    }
};
test "protected estimate sequence shares one deadline and restores its client's transport" {
    // Injected clock: each reply advances time by a fixed step, so expiry is
    // decided by event order rather than by how the host schedules the test.
    const FakeClock = struct {
        var now_ns: u64 = 1000 * std.time.ns_per_s;
        fn read() anyerror!u64 {
            return now_ns;
        }
    };
    const step_ms = 60;
    const Mock = struct {
        calls: usize = 0,
        timeouts: [2]u32 = .{ 0, 0 },
        deadlines: [2]?u64 = .{ null, null },
        fn fetch(context: *anyopaque, a: std.mem.Allocator, _: []const u8, options: rpc.Options) !rpc.WireResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
            try std.testing.expect(self.calls < self.timeouts.len);
            try std.testing.expect(options.connect_timeout_ms <= options.timeout_ms);
            self.timeouts[self.calls] = options.timeout_ms;
            self.deadlines[self.calls] = options.owner_deadline_ns;
            self.calls += 1;
            FakeClock.now_ns += step_ms * std.time.ns_per_ms;
            const bytes = try a.dupe(u8, "{}");
            return .{ .bytes = bytes, .len = bytes.len };
        }
    };
    var mock: Mock = .{};
    const exchange: rpc.Exchange = .{ .context = &mock, .fetch_fn = Mock.fetch };
    var client = try rpc.RpcClient.init(std.testing.allocator, "https://fixture.invalid/rpc", .{ .exchange = exchange });
    defer client.deinit();
    const started = FakeClock.now_ns;
    const deadline = started + 100 * std.time.ns_per_ms;
    {
        var scope = try Scope.initClock(&client, 100, FakeClock.read);
        scope.attach();
        defer scope.deinit();
        const scoped = client.options.exchange.?;
        // First reply lands at 60ms of the 100ms budget.
        const first = try scoped.fetch_fn(scoped.context, std.testing.allocator, "{}", client.options);
        std.testing.allocator.free(first.bytes);
        // Second request gets only the 40ms left; its reply lands at 120ms and
        // is discarded because the shared deadline passed while it was in flight.
        try std.testing.expectError(error.ProtectedEstimateDeadline, scoped.fetch_fn(scoped.context, std.testing.allocator, "{}", client.options));
        try std.testing.expectEqual(@as(usize, 2), mock.calls);
        try std.testing.expectEqual([2]u32{ 100, 100 - step_ms }, mock.timeouts);
        try std.testing.expectEqual([2]?u64{ deadline, deadline }, mock.deadlines);
        // Exhausted scope rejects further requests before the transport.
        try std.testing.expectError(error.ProtectedEstimateDeadline, scoped.fetch_fn(scoped.context, std.testing.allocator, "{}", client.options));
        try std.testing.expectEqual(@as(usize, 2), mock.calls);
    }
    try std.testing.expect(client.options.exchange.?.context == exchange.context);
    try std.testing.expect(client.options.exchange.?.fetch_fn == exchange.fetch_fn);
}
