//! `registerMetricsRoute`: GET /metrics -> prom-client exposition.
const std = @import("std");
const core = @import("core");
const types = @import("types.zig");

var ctx_dummy: u8 = 0;

fn handler(_: *anyopaque, req: *types.Request, reply: *types.Reply) void {
    const body = core.metrics.render(req.arena) catch {
        reply.code(500);
        reply.sendText("metrics unavailable");
        return;
    };
    reply.type(core.metrics.content_type);
    reply.sendText(body);
}

pub fn route() types.Route {
    return .{ .methods = &.{"GET"}, .path = "/metrics", .ctx = &ctx_dummy, .hooks = .{ .handler = handler } };
}
