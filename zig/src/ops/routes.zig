//! Agent routes over the bounded native HTTP server.
const std = @import("std");
const http = @import("http.zig");
const metrics = @import("metrics.zig");

pub const Routes = struct {
    registry: *metrics.Registry,
    mutex: std.Thread.Mutex = .{},
    extra: ?http.Handler = null,

    pub fn setExtra(self: *Routes, handler_: ?http.Handler) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.extra = handler_;
    }
    pub fn handler(self: *Routes) http.Handler {
        return .{ .context = self, .handle_fn = respond };
    }

    fn respond(context: *anyopaque, a: std.mem.Allocator, request: http.Request, cancel: *const std.atomic.Value(bool)) !http.Response {
        if (cancel.load(.acquire)) return error.Cancelled;
        const self: *Routes = @ptrCast(@alignCast(context));
        if (!std.mem.eql(u8, request.path, "/metrics")) {
            self.mutex.lock();
            const extra = self.extra;
            self.mutex.unlock();
            if (extra) |handler_| return handler_.handle_fn(handler_.context, a, request, cancel);
            return http.Response.init(a, 404, &.{}, "");
        }
        if (!std.mem.eql(u8, request.method, "GET") and !std.mem.eql(u8, request.method, "HEAD"))
            return http.Response.init(a, 405, &.{.{ .name = "allow", .value = "GET,HEAD" }}, "");
        const body = self.registry.render(a) catch return http.Response.init(a, 500, &.{}, "Failed to gather metrics");
        defer a.free(body);
        // The HTTP serializer handles HEAD: retain the GET representation's
        // content length while suppressing response-body bytes on the wire.
        return http.Response.init(a, 200, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, body);
    }
};
