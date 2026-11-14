//! Local HTTP/WebSocket transport bench server (no database). Skipped unless
//! `HTTP_BENCH_SECONDS` is set:
//!
//!   HTTP_BENCH_SECONDS=60 HTTP_BENCH_PORT=28400 ./build.sh test-http -Drelease=true
//!
//! Routes: `GET /metrics`, `GET|POST /graphql` (small JSON echo), 404 for the
//! rest, and WebSocket upgrades on `/messages` (idle; `HTTP_BENCH_WS_FANOUT_MS`
//! broadcasts a 200-byte text frame to every socket at that interval).
const std = @import("std");
const types = @import("types.zig");
const server_mod = @import("server.zig");
const ws = @import("ws.zig");

const Bench = struct {
    mutex: std.Thread.Mutex = .{},
    conns: std.ArrayList(*ws.Conn) = .empty,
    wss: ws.Server = .{ .options = .{} },

    fn handler(_: *anyopaque, _: *types.Request, reply: *types.Reply) void {
        reply.sendSerializedJson("{\"data\":{\"ok\":true}}");
    }

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *Bench = @ptrCast(@alignCast(ctx));
        if (!std.mem.eql(u8, req.path, "/messages")) return socket.destroy();
        const conn = self.wss.handleUpgrade(std.heap.c_allocator, req, socket, .{ .ctx = self, .on_message = onMessage, .on_close = onClose }) orelse return;
        self.mutex.lock();
        defer self.mutex.unlock();
        self.conns.append(std.heap.c_allocator, conn) catch conn.terminate();
    }

    fn onMessage(_: *anyopaque, _: *ws.Conn, _: []const u8, _: bool) void {}

    fn onClose(ctx: *anyopaque, conn: *ws.Conn, _: u16, _: []const u8) void {
        const self: *Bench = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        for (self.conns.items, 0..) |c, i| if (c == conn) {
            _ = self.conns.swapRemove(i);
            break;
        };
        self.mutex.unlock();
        conn.release();
    }

    fn fanout(self: *Bench, frame: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.conns.items) |c| {
            if (c.trySendInline(frame, false, null) catch continue) continue;
            c.send(frame, false, null) catch {};
        }
    }
};

test "bench server (HTTP_BENCH_SECONDS)" {
    const secs_text = std.posix.getenv("HTTP_BENCH_SECONDS") orelse return error.SkipZigTest;
    const secs = try std.fmt.parseInt(u64, secs_text, 10);
    const port = try std.fmt.parseInt(u16, std.posix.getenv("HTTP_BENCH_PORT") orelse "28400", 10);
    const fanout_ms = if (std.posix.getenv("HTTP_BENCH_WS_FANOUT_MS")) |t| try std.fmt.parseInt(u64, t, 10) else 0;
    var bench: Bench = .{};
    var dummy: u8 = 0;
    const routes = [_]types.Route{
        @import("metrics_route.zig").route(),
        .{ .methods = &.{ "GET", "POST" }, .path = "/graphql", .ctx = &dummy, .hooks = .{ .handler = Bench.handler } },
    };
    var options: server_mod.Options = .{
        .host = "127.0.0.1",
        .port = port,
        .routes = &routes,
        .upgrade = .{ .ctx = &bench, .on_upgrade = Bench.onUpgrade },
    };
    if (@hasField(server_mod.Options, "max_threads")) if (std.posix.getenv("HTTP_BENCH_MAX_THREADS")) |t| {
        options.max_threads = try std.fmt.parseInt(u32, t, 10);
    };
    if (@hasField(server_mod.Options, "pollers")) if (std.posix.getenv("HTTP_BENCH_POLLERS")) |t| {
        options.pollers = try std.fmt.parseInt(u32, t, 10);
    };
    const server = try server_mod.Server.init(std.heap.c_allocator, options);
    try server.start();
    std.debug.print("bench server pid={d} port={d}\n", .{ std.c.getpid(), server.port() });
    var frame: [200]u8 = undefined;
    @memset(&frame, 'x');
    const deadline = std.time.milliTimestamp() + @as(i64, @intCast(secs * 1000));
    while (std.time.milliTimestamp() < deadline) {
        if (fanout_ms > 0) {
            bench.fanout(&frame);
            std.Thread.sleep(fanout_ms * std.time.ns_per_ms);
        } else std.Thread.sleep(100 * std.time.ns_per_ms);
    }
    bench.mutex.lock();
    for (bench.conns.items) |c| c.terminate();
    bench.mutex.unlock();
    server.deinit();
}
