//! `EventWebSocketServer` as `main.zig` uses it: owns the event-loop runtime
//! (pool, scheduler, loop mutex) and adapts `server.zig` to the HTTP upgrade
//! hook, `ws.Conn`, `DbService.queryLive/listen` and the diagnostics stream.
const std = @import("std");
const core = @import("core");
const db = @import("db");
const http = @import("http");
const diagnostics = @import("diagnostics");
const runtime = @import("runtime.zig");
const protocol = @import("protocol.zig");
const live = @import("server.zig");
const es = @import("event_store.zig");

const ws = http.ws;
const Allocator = std.mem.Allocator;

pub const EventWebSocketServer = struct {
    gpa: Allocator,
    db: *db.DbService,
    pool: runtime.Pool,
    scheduler: runtime.ThreadScheduler,
    loop: runtime.Loop,
    server: *live.Server,
    diagnostics_stream: ?*diagnostics.stream.Stream,
    agent_ws: ws.Server = .{ .options = .{ .max_payload = live.MAX_AGENT_MESSAGE_BYTES } },
    explorer_ws: ws.Server = .{ .options = .{ .max_payload = live.MAX_EXPLORER_MESSAGE_BYTES } },
    start_error: [128]u8 = undefined,

    /// `new EventWebSocketServer(db, {}, diagnostics)`.
    pub fn init(gpa: Allocator, db_service: *db.DbService, diagnostics_service: ?*diagnostics.Service) !*EventWebSocketServer {
        const self = try gpa.create(EventWebSocketServer);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .db = db_service,
            .pool = .init(gpa),
            .scheduler = .init(gpa),
            .loop = undefined,
            .server = undefined,
            .diagnostics_stream = null,
        };
        if (diagnostics_service) |service| self.diagnostics_stream = try diagnostics.stream.Stream.init(gpa, service);
        errdefer if (self.diagnostics_stream) |stream| stream.deinit();
        // One permanent worker: a later spawn failure queues instead of failing.
        try self.pool.start(1);
        errdefer self.pool.deinit();
        try self.scheduler.start();
        errdefer self.scheduler.deinit();
        self.loop = .{ .allocator = gpa, .pool = &self.pool, .scheduler = self.scheduler.scheduler() };
        const config = core.config.get();
        self.server = try live.Server.create(gpa, &self.loop, .{ .ctx = self, .query = query }, .{
            .ctx = self,
            .listen = listen,
            .unlisten = unlisten,
        }, .{
            .limits = live.Limits.fromConfig(config),
            .batch_size = config.event_stream_batch_size,
            .production = if (config.node_env) |env| std.mem.eql(u8, env, "production") else false,
        }, self.diagnostics_stream);
        return self;
    }

    /// `start(server)`; `message` receives the failure text for main's exit path.
    pub fn start(self: *EventWebSocketServer, message: *?[]const u8) !void {
        self.server.start() catch |err| {
            message.* = std.fmt.bufPrint(&self.start_error, "Invalid heartbeatMs {d}: must be an integer between 1 and 2147483647", .{self.server.limits.heartbeat_ms}) catch null;
            return err;
        };
    }

    pub fn stop(self: *EventWebSocketServer) void {
        self.server.stop();
    }

    /// After `stop()` and the HTTP server closed (all upgraded sockets gone).
    pub fn deinit(self: *EventWebSocketServer) void {
        // Scheduler first: a timer dequeued before stop() may still spawn a task.
        self.scheduler.deinit();
        self.pool.deinit();
        // Sink releases for subscriptions freed after stop() run here and touch peers.
        if (self.diagnostics_stream) |stream| stream.deinit();
        self.server.destroy();
        self.gpa.destroy(self);
    }

    pub fn metricsProvider(self: *EventWebSocketServer) core.metrics.WebSocketMetricsProvider {
        return self.server.metricsProvider();
    }

    pub fn upgradeHandler(self: *EventWebSocketServer) http.UpgradeHandler {
        return .{ .ctx = self, .on_upgrade = onUpgrade };
    }

    // -- HTTP upgrade (`handleUpgrade`) ---------------------------------------

    fn onUpgrade(ctx: *anyopaque, req: *http.Request, socket: *http.UpgradeSocket) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        // stop() removes the TS 'upgrade' listener.
        self.loop.lock();
        const stopped = self.server.stopped;
        self.loop.unlock();
        if (stopped) return socket.destroy();
        // `request.url?.split('?', 1)[0]`, compared exactly (no Fastify routing).
        const route: live.Route = if (std.mem.eql(u8, req.path, live.AGENT_PATH))
            .agent
        else if (std.mem.eql(u8, req.path, live.MESSAGE_PATH))
            .explorer
        else {
            socket.destroy();
            return;
        };
        const ws_server = if (route == .agent) &self.agent_ws else &self.explorer_ws;
        const handler: ws.Handler = .{
            .ctx = self,
            .on_message = onMessage,
            .on_pong = onPong,
            .on_error = onError,
            .on_close = onClose,
        };
        const conn = ws_server.handleUpgrade(self.gpa, req, socket, handler) orelse return;
        const sock: live.Socket = .{ .ptr = conn, .vtable = &conn_vtable };
        // The reader loop starts after on_upgrade returns, so `user` is set first.
        conn.user = switch (route) {
            .agent => self.server.connectAgent(sock),
            .explorer => blk: {
                var buffer: [64]u8 = undefined;
                const remote = req.remoteIp(&buffer);
                break :blk self.server.connectExplorer(sock, .{
                    .url = req.url,
                    .cf_connecting_ip = req.header("cf-connecting-ip"),
                    .remote_address = if (remote.len > 0) remote else null,
                });
            },
        };
    }

    fn peerOf(conn: *ws.Conn) *live.Peer {
        return @ptrCast(@alignCast(conn.user.?));
    }

    fn onMessage(ctx: *anyopaque, conn: *ws.Conn, data: []const u8, binary: bool) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        const peer = peerOf(conn);
        // `/messages` registers no message handler.
        if (peer.route != .agent) return;
        if (!binary) return self.server.onMessage(peer, data);
        // `rawData`: Buffer#toString('utf8') for binary frames.
        const text = core.json.toWellFormedUtf8(self.gpa, data) catch return;
        defer if (text.ptr != data.ptr) self.gpa.free(text);
        self.server.onMessage(peer, text);
    }

    fn onPong(ctx: *anyopaque, conn: *ws.Conn) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.server.onPong(peerOf(conn));
    }

    fn onError(ctx: *anyopaque, conn: *ws.Conn, message: []const u8) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.server.onError(peerOf(conn), message);
    }

    fn onClose(ctx: *anyopaque, conn: *ws.Conn, _: u16, _: []const u8) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.server.onClose(peerOf(conn));
    }

    // -- ws.Conn as live.Socket ----------------------------------------------

    const conn_vtable: live.Socket.VTable = .{
        .send = connSend,
        .buffered_amount = connBuffered,
        .is_open = connOpen,
        .close = connClose,
        .terminate = connTerminate,
        .ping = connPing,
        .release = connRelease,
        .try_send_inline = connTrySendInline,
    };

    fn asConn(ptr: *anyopaque) *ws.Conn {
        return @ptrCast(@alignCast(ptr));
    }
    fn connSend(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) bool {
        asConn(ptr).send(bytes, false, .{ .ctx = job, .func = sendDone }) catch return false;
        return true;
    }
    fn connTrySendInline(ptr: *anyopaque, bytes: []const u8) live.Socket.InlineResult {
        const c = asConn(ptr);
        // No callback: a partial write's tail stays queued in order, and its
        // flush needs no completion (the frame was accepted, like Node).
        const accepted = c.trySendInline(bytes, false, null) catch return .failed;
        if (!accepted) return .busy;
        // A socket error destroys the conn (readyState no longer open).
        return if (c.readyState() == .open) .written else .failed;
    }
    fn sendDone(ctx: *anyopaque, _: *ws.Conn, ok: bool) void {
        const job: *live.SendJob = @ptrCast(@alignCast(ctx));
        job.complete(ok);
    }
    fn connBuffered(ptr: *anyopaque) usize {
        return asConn(ptr).bufferedAmount();
    }
    fn connOpen(ptr: *anyopaque) bool {
        return asConn(ptr).readyState() == .open;
    }
    fn connClose(ptr: *anyopaque, code: u16, reason: []const u8) void {
        asConn(ptr).close(code, reason);
    }
    fn connTerminate(ptr: *anyopaque) void {
        asConn(ptr).terminate();
    }
    fn connPing(ptr: *anyopaque) void {
        asConn(ptr).ping();
    }
    fn connRelease(ptr: *anyopaque) void {
        asConn(ptr).release();
    }

    // -- DbService as es.Db / live.Listen --------------------------------------

    fn query(ctx: *anyopaque, arena: Allocator, sql: []const u8, params: []const core.json.Value) anyerror![]core.json.Value {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        var failure: db.Failure = .{};
        return self.db.queryLive(arena, sql, params, &failure) catch |err|
            runtime.fail("{s}", .{core.log.formatError(err, if (failure.message.len > 0) failure.message else null)});
    }

    fn listen(ctx: *anyopaque, channels: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        var arena = std.heap.ArenaAllocator.init(self.gpa);
        defer arena.deinit();
        var failure: db.Failure = .{};
        const listener = self.db.listen(channels, .{
            .ctx = handler.ctx,
            .on_notification = handler.on_notification,
            .on_disconnect = handler.on_disconnect,
        }, arena.allocator(), &failure) catch |err|
            return runtime.fail("{s}", .{core.log.formatError(err, if (failure.message.len > 0) failure.message else null)});
        return listener;
    }

    fn unlisten(ctx: *anyopaque, handle: *anyopaque) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.db.unlisten(@ptrCast(@alignCast(handle)));
    }
};
