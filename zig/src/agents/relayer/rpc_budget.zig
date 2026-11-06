//! Shared deadline for a sequence of RPC calls on one exclusive client.
const std = @import("std");
const rpc = @import("../../evm/provider.zig");
pub const Scope = struct {
    client: *rpc.RpcClient,
    original: rpc.Options,
    timer: std.time.Timer,
    timeout_ms: u32,
    owner_deadline_ns: u64,
    attached: bool = false,
    pub fn init(client: *rpc.RpcClient, timeout_ms: u32) !Scope {
        if (timeout_ms == 0 or client.options.exchange == null) return error.ProtectedRpcExchangeRequired;
        const started = try @import("../../cloud/http.zig").rpcNowNs();
        return .{ .client = client, .original = client.options, .timer = try std.time.Timer.start(), .timeout_ms = timeout_ms, .owner_deadline_ns = started +| @as(u64, timeout_ms) * std.time.ns_per_ms };
    }
    /// Keep the Scope address stable through detach; never fork this client.
    pub fn attach(self: *Scope) void {
        std.debug.assert(!self.attached);
        self.client.options.exchange = .{ .context = self, .fetch_fn = fetch };
        self.attached = true;
    }
    pub fn remaining(self: *Scope) !u32 {
        const total = @as(u64, self.timeout_ms) * std.time.ns_per_ms;
        const elapsed = self.timer.read();
        if (elapsed >= total) return error.ProtectedEstimateDeadline;
        return @intCast((total - elapsed + std.time.ns_per_ms - 1) / std.time.ns_per_ms);
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
    const Mock = struct {
        calls: usize = 0,
        last_timeout: u32 = std.math.maxInt(u32),
        fn fetch(context: *anyopaque, a: std.mem.Allocator, _: []const u8, options: rpc.Options) !rpc.WireResponse {
            const self: *@This() = @ptrCast(@alignCast(context));
            try std.testing.expect(options.timeout_ms <= self.last_timeout);
            self.last_timeout = options.timeout_ms;
            self.calls += 1;
            if (self.calls == 1) std.Thread.sleep(20 * std.time.ns_per_ms);
            const bytes = try a.dupe(u8, "{}");
            return .{ .bytes = bytes, .len = bytes.len };
        }
    };
    var mock: Mock = .{};
    const exchange: rpc.Exchange = .{ .context = &mock, .fetch_fn = Mock.fetch };
    var client = try rpc.RpcClient.init(std.testing.allocator, "https://fixture.invalid/rpc", .{ .exchange = exchange });
    defer client.deinit();
    {
        var scope = try Scope.init(&client, 10);
        scope.attach();
        defer scope.deinit();
        try std.testing.expectError(error.ProtectedEstimateDeadline, client.options.exchange.?.fetch_fn(&scope, std.testing.allocator, "{}", client.options));
        try std.testing.expectEqual(@as(usize, 1), mock.calls);
        try std.testing.expectError(error.ProtectedEstimateDeadline, client.options.exchange.?.fetch_fn(&scope, std.testing.allocator, "{}", client.options));
        try std.testing.expectEqual(@as(usize, 1), mock.calls);
    }
    try std.testing.expect(client.options.exchange.?.context == exchange.context);
    try std.testing.expect(client.options.exchange.?.fetch_fn == exchange.fetch_fn);
}
