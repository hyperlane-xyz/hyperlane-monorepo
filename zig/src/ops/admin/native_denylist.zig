//! Cancellation-aware native transport for administrative denylist refresh.
const std = @import("std");
const runtime = @import("../runtime_denylist.zig");
const curl = @import("../../net/curl.zig");

pub const CancellableTransport = struct {
    client: *curl.Client,
    gate: @import("../../runtime/cancel_gate.zig").Gate = .{},
    active_cancel: ?*const std.atomic.Value(bool) = null,

    /// Constructor performs no I/O and retains no secret-bearing text.
    pub fn init(client: *curl.Client) CancellableTransport {
        return .{ .client = client };
    }
    pub fn interface(self: *CancellableTransport) runtime.Transport {
        return .{ .context = self, .fetch = fetch };
    }
    pub fn binder(self: *CancellableTransport) api.DenylistRefreshBinder {
        return .{ .context = self, .bind_fn = bind, .unbind_fn = unbind };
    }
    fn bind(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self: *CancellableTransport = @ptrCast(@alignCast(context));
        try self.gate.lock(cancel);
        self.active_cancel = cancel;
    }
    fn unbind(context: *anyopaque, cancel: *const std.atomic.Value(bool)) void {
        const self: *CancellableTransport = @ptrCast(@alignCast(context));
        std.debug.assert(self.active_cancel == cancel);
        self.active_cancel = null;
        self.gate.unlock();
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, url: []const u8, limit: usize) anyerror!runtime.Fetched {
        const self: *CancellableTransport = @ptrCast(@alignCast(context));
        // The binder owns the gate throughout refresh and every native fetch.
        const cancel = self.active_cancel orelse return error.DenylistRefreshNotBound;
        var response = try self.client.send(a, .{
            .url = url,
            .method = .get,
            .timeout_ms = runtime.fetch_timeout_ms,
            .connect_timeout_ms = runtime.fetch_timeout_ms,
            .max_response_bytes = limit,
            .cancel = cancel,
        });
        defer response.deinit();
        return .{ .allocator = a, .status = response.status, .bytes = try a.dupe(u8, response.body) };
    }
};

const api = @import("api.zig");
