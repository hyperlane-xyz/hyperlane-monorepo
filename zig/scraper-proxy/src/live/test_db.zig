//! Tests: `Db.query_async` for a fake blocking `query` (on a thread of its
//! own, so `done` never runs inside the call, as the contract requires).
const std = @import("std");
const core = @import("core");
const es = @import("event_store.zig");

const QueryFn = fn (ctx: *anyopaque, arena: std.mem.Allocator, sql: []const u8, params: []const core.json.Value) anyerror![]core.json.Value;

pub fn threadAsync(comptime query: QueryFn) *const fn (ctx: *anyopaque, request: *es.AsyncQuery) void {
    return struct {
        fn start(ctx: *anyopaque, request: *es.AsyncQuery) void {
            request.backend = ctx;
            const thread = std.Thread.spawn(.{}, run, .{request}) catch @panic("test: thread spawn failed");
            thread.detach();
        }
        fn run(request: *es.AsyncQuery) void {
            if (query(request.backend, request.arena.allocator(), request.sql, request.params)) |rows| {
                request.rows = rows;
            } else |err| request.setFailure(err);
            request.done(request);
        }
    }.start;
}
