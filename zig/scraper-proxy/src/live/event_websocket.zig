//! `EventWebSocketServer` as `main.zig` uses it: owns the event-loop runtime
//! (pool, timers on the process timer thread, loop mutex) and adapts `server.zig` to the HTTP upgrade
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
/// The HTTP server's loop group (fibers run on its loops).
pub const FiberHost = @FieldType(http.Server, "loop");

pub const EventWebSocketServer = struct {
    gpa: Allocator,
    db: *db.DbService,
    pool: runtime.Pool,
    scheduler: runtime.SharedScheduler,
    loop: runtime.Loop,
    server: *live.Server,
    diagnostics_stream: ?*diagnostics.stream.Stream,
    agent_ws: ws.Server = .{ .options = .{ .max_payload = live.MAX_AGENT_MESSAGE_BYTES } },
    explorer_ws: ws.Server = .{ .options = .{ .max_payload = live.MAX_EXPLORER_MESSAGE_BYTES } },
    validator_ws: ws.Server = .{ .options = .{ .max_payload = live.MAX_VALIDATOR_MESSAGE_BYTES } },
    start_error: [128]u8 = undefined,
    /// `-Dlive-fiber-queries`: where `queryAsync` runs its fibers.
    fiber_host: ?*FiberHost = null,

    /// `new EventWebSocketServer(db, {}, diagnostics)`.
    pub fn init(gpa: Allocator, db_service: *db.DbService, diagnostics_service: ?*diagnostics.Service) !*EventWebSocketServer {
        const self = try gpa.create(EventWebSocketServer);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .db = db_service,
            .pool = .init(gpa),
            .scheduler = .init(gpa, core.scheduler.global()),
            .loop = undefined,
            .server = undefined,
            .diagnostics_stream = null,
        };
        if (diagnostics_service) |service| self.diagnostics_stream = try diagnostics.stream.Stream.init(gpa, service);
        errdefer if (self.diagnostics_stream) |stream| stream.deinit();
        // One permanent worker: a later spawn failure queues instead of failing.
        try self.pool.start(1);
        errdefer self.pool.deinit();
        errdefer self.scheduler.deinit();
        self.loop = .{ .allocator = gpa, .pool = &self.pool, .scheduler = self.scheduler.scheduler() };
        const config = core.config.get();
        self.server = try live.Server.create(gpa, &self.loop, .{ .ctx = self, .query = query, .query_async = if (runtime.fiber_queries) queryAsync else null }, .{
            .ctx = self,
            .listen = listen,
            .listen_unlogged = listenUnlogged,
            .log_listening = logListening,
            .unlisten = unlisten,
        }, .{
            .limits = live.Limits.fromConfig(config),
            .batch_size = config.event_stream_batch_size,
            .production = if (config.node_env) |env| std.mem.eql(u8, env, "production") else false,
            // Validator setups always run as continuations (`query_async`).
            .validator_db = .{ .ctx = self, .query = queryValidator, .query_async = queryValidatorAsync },
        }, self.diagnostics_stream);
        return self;
    }

    /// The HTTP server whose loops run live's database fibers; before it
    /// accepts (`-Dlive-fiber-queries`).
    pub fn setFiberHost(self: *EventWebSocketServer, host: *FiberHost) void {
        self.fiber_host = host;
    }

    /// `start(server)`; `message` receives the failure text for main's exit path.
    pub fn start(self: *EventWebSocketServer, message: *?[]const u8) !void {
        self.server.start() catch |err| {
            message.* = std.fmt.bufPrint(&self.start_error, "Invalid heartbeatMs {d}: must be an integer between 1 and 2147483647", .{self.server.limits.heartbeat_ms}) catch null;
            return err;
        };
    }

    /// Open the LISTEN connection while the rest of startup runs (`start`
    /// adopts it where TS awaits it).
    pub fn listenEarly(self: *EventWebSocketServer) void {
        self.server.listenEarly();
    }

    pub fn stop(self: *EventWebSocketServer) void {
        self.server.stop();
    }

    /// After `stop()` and the HTTP server closed (all upgraded sockets gone).
    pub fn deinit(self: *EventWebSocketServer) void {
        // Timers first: one that fired before stop() may still spawn a task.
        self.scheduler.deinit();
        self.pool.deinit();
        // Sink releases for subscriptions freed after stop() run here and touch peers.
        if (self.diagnostics_stream) |stream| stream.deinit();
        self.server.destroy();
        self.loop.deinit();
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
        // Wiring, all builds: main hands the loops over before accepting.
        if (self.fiber_host == null) @panic("live: an upgrade before setFiberHost (validator setups always read through query_async)");
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
        else if (std.mem.eql(u8, req.path, live.VALIDATOR_PATH))
            .validator
        else {
            socket.destroy();
            return;
        };
        const handler: ws.Handler = .{
            .ctx = self,
            .on_message = onMessage,
            .on_pong = onPong,
            .on_error = onError,
            .on_close = onClose,
            .transition = onTransition,
            .on_pass_end = onPassEnd,
        };
        if (route == .validator) return self.upgradeValidator(req, socket, handler);
        const ws_server = if (route == .agent) &self.agent_ws else &self.explorer_ws;
        const conn = ws_server.handleUpgrade(self.gpa, req, socket, handler) orelse return;
        const sock: live.Socket = .{ .ptr = conn, .vtable = &conn_vtable };
        // The reader loop starts after on_upgrade returns, so `user` is set first.
        conn.user = switch (route) {
            .validator => unreachable,
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

    /// `/validators`: admission before the upgrade (a bare HTTP status on
    /// rejection), then `connectValidator`, all under live's mutex so the
    /// reservation is taken in the same step as the checks.
    fn upgradeValidator(self: *EventWebSocketServer, req: *http.Request, socket: *http.UpgradeSocket, handler: ws.Handler) void {
        var buffer: [64]u8 = undefined;
        const remote = req.remoteIp(&buffer);
        self.loop.lock();
        defer self.loop.unlock();
        if (self.server.stopped) return socket.destroy();
        const admission = self.server.admitValidator(.{
            .url = req.url,
            .cf_connecting_ip = req.header("cf-connecting-ip"),
            .remote_address = if (remote.len > 0) remote else null,
        });
        const admitted = switch (admission) {
            .rejected => |status| {
                var response: [96]u8 = undefined;
                socket.endWith(std.fmt.bufPrint(&response, "HTTP/1.1 {d} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", .{status}) catch unreachable);
                return;
            },
            .admitted => |value| value,
        };
        // ws's handshake only buffers or writes without blocking.
        const conn = self.validator_ws.handleUpgrade(self.gpa, req, socket, handler) orelse {
            self.gpa.free(admitted.ip);
            return;
        };
        conn.user = self.server.connectValidator(.{ .ptr = conn, .vtable = &conn_vtable }, admitted.ip, admitted.subscription);
    }

    fn peerOf(conn: *ws.Conn) *live.Peer {
        return @ptrCast(@alignCast(conn.user.?));
    }

    fn onMessage(ctx: *anyopaque, conn: *ws.Conn, data: []const u8, binary: bool) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        const peer = peerOf(conn);
        if (peer.route == .validator) return self.server.onValidatorMessage(peer, data, binary);
        // `/messages` registers no message handler.
        if (peer.route != .agent) return;
        if (!binary) return self.server.onMessage(peer, data);
        // `rawData`: Buffer#toString('utf8') for binary frames.
        const text = core.json.toWellFormedUtf8(self.gpa, data) catch return;
        defer if (text.ptr != data.ptr) self.gpa.free(text);
        self.server.onMessage(peer, text);
    }

    /// Node processes a peer's close frame, a protocol error or EOF as an I/O
    /// event between ticks: apply it once the current emulated tick (and the
    /// frames it sent) is over, so every frame sent in that tick sees OPEN.
    fn onTransition(ctx: *anyopaque, conn: *ws.Conn, event: ws.Transition) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.loop.lock();
        defer self.loop.unlock();
        conn.applyTransition(event);
    }

    fn onPong(ctx: *anyopaque, conn: *ws.Conn) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.server.onPong(peerOf(conn));
    }

    fn onError(ctx: *anyopaque, conn: *ws.Conn, message: []const u8) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.server.onError(peerOf(conn), message);
    }

    /// ws ended a write pass (frames' callbacks recorded just before): live
    /// applies them as one Node macrotask. The peer is alive: 'close' (which
    /// precedes its release) comes after the last pass.
    fn onPassEnd(ctx: *anyopaque, conn: *ws.Conn, _: bool) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.server.passEnd(peerOf(conn));
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
        .snapshot = connSnapshot,
        .close = connClose,
        .terminate = connTerminate,
        .ping = connPing,
        .release = connRelease,
        .try_send_inline = connTrySendInline,
        .try_send_inline_many = connTrySendInlineMany,
    };

    fn asConn(ptr: *anyopaque) *ws.Conn {
        return @ptrCast(@alignCast(ptr));
    }
    fn connSend(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) bool {
        asConn(ptr).send(bytes, false, .{ .ctx = job, .func = sendDone }) catch return false;
        return true;
    }
    fn connTrySendInline(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) live.Socket.InlineResult {
        const callbacks = [1]ws.SendCallback{.{ .ctx = job, .func = sendDone }};
        const outcome = asConn(ptr).sendInlineCorked(&.{bytes}, false, &callbacks, 1) catch |err| return switch (err) {
            error.NotOpen => .closed,
            else => .failed,
        };
        // Not written whole: queued (kernel full, or behind queued frames).
        return if (outcome.written == 1) .written else .partial;
    }
    fn connTrySendInlineMany(ptr: *anyopaque, payloads: []const []const u8, jobs: []const *live.SendJob, required: usize) live.Socket.ManyResult {
        var callbacks: [ws.Conn.max_inline_frames]ws.SendCallback = undefined;
        std.debug.assert(jobs.len <= callbacks.len);
        for (jobs, callbacks[0..jobs.len]) |job, *cb| cb.* = .{ .ctx = job, .func = sendDone };
        const outcome = asConn(ptr).sendInlineCorked(payloads, false, callbacks[0..jobs.len], required) catch |err| return switch (err) {
            error.NotOpen => .closed,
            else => .failed,
        };
        return .{ .done = .{ .written = outcome.written, .queued = outcome.queued } };
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
    fn connSnapshot(ptr: *anyopaque) live.Socket.Snapshot {
        const state = asConn(ptr).snapshot();
        return .{ .open = state.ready_state == .open, .buffered = state.buffered_amount, .control = state.control };
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

    fn queryValidator(ctx: *anyopaque, arena: Allocator, sql: []const u8, params: []const core.json.Value) anyerror![]core.json.Value {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        var failure: db.Failure = .{};
        return self.db.queryValidator(arena, sql, params, &failure) catch |err|
            runtime.fail("{s}", .{core.log.formatError(err, if (failure.message.len > 0) failure.message else null)});
    }

    /// `queryAsync` on the validator pool.
    fn queryValidatorAsync(ctx: *anyopaque, request: *es.AsyncQuery) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        request.backend = self;
        request.run_query = queryValidator;
        dispatchQuery(&self.pool, self.fiber_host, request);
    }

    /// `Db.query_async`: on an HTTP loop thread, a fiber on that loop (its
    /// pool checkout and socket waits park the fiber); otherwise, or if the
    /// fiber cannot be created, a pool job (a worker waits, as `query`).
    /// Never runs the query here: the caller holds live's mutex.
    fn queryAsync(ctx: *anyopaque, request: *es.AsyncQuery) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        request.backend = self;
        request.run_query = query;
        dispatchQuery(&self.pool, self.fiber_host, request);
    }

    /// `queryAsync`'s choice (tests drive it with their own pool and host).
    pub fn dispatchQuery(pool: *runtime.Pool, fiber_host: ?*FiberHost, request: *es.AsyncQuery) void {
        // `setFiberHost` before accepts is wiring (main always calls it).
        if (fiber_host == null and core.fiber.onEventLoopThread()) @panic("live: a query_async read on an HTTP loop thread without setFiberHost");
        if (core.fiber.onEventLoopThread()) if (fiber_host) |host| {
            // The calling thread's loop: the fiber is created and reaped on
            // this thread (its fiber cache), with no cross-thread post.
            const loop = host.current();
            if (core.fiber.create(loop.fiberScheduler(), runQueryFiber, request)) |fiber| {
                loop.postFiber(fiber);
                return;
            } else |_| {}
        };
        request.job = .{ .run = runQueryJob };
        pool.submit(&request.job);
    }

    fn runQueryFiber(arg: *anyopaque) void {
        runQuery(@ptrCast(@alignCast(arg)));
    }

    fn runQueryJob(job: *runtime.Pool.Job) void {
        runQuery(@alignCast(@fieldParentPtr("job", job)));
    }

    /// The read itself (`request.run_query`), then `done` (no live lock held).
    fn runQuery(request: *es.AsyncQuery) void {
        if (request.run_query(request.backend, request.arena.allocator(), request.sql, request.params)) |rows| {
            request.rows = rows;
        } else |err| request.setFailure(err);
        request.done(request);
    }

    fn listen(ctx: *anyopaque, channels: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        const listener = try self.openListener(channels, handler);
        self.db.logListening(channels);
        return listener;
    }

    /// The early LISTEN: TS has not called `listen` yet, so no log line here.
    fn listenUnlogged(ctx: *anyopaque, channels: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        return self.openListener(channels, handler);
    }

    fn logListening(ctx: *anyopaque, channels: []const []const u8) void {
        const self: *EventWebSocketServer = @ptrCast(@alignCast(ctx));
        self.db.logListening(channels);
    }

    fn openListener(self: *EventWebSocketServer, channels: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        var arena = std.heap.ArenaAllocator.init(self.gpa);
        defer arena.deinit();
        var failure: db.Failure = .{};
        const listener = self.db.listenUnlogged(channels, .{
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

test "queryAsync off an HTTP loop thread runs the read on a pool job, then done" {
    const testing = std.testing;
    var pool = runtime.Pool.init(testing.allocator);
    defer pool.deinit();
    const Probe = struct {
        done: std.Thread.ResetEvent = .{},
        thread: std.Thread.Id = 0,
        fn run(_: *anyopaque, arena: Allocator, _: []const u8, _: []const core.json.Value) anyerror![]core.json.Value {
            const rows = try arena.alloc(core.json.Value, 1);
            rows[0] = core.json.int(7);
            return rows;
        }
        fn finished(request: *es.AsyncQuery) void {
            const self: *@This() = @ptrCast(@alignCast(request.owner));
            self.thread = std.Thread.getCurrentId();
            self.done.set();
        }
    };
    var probe: Probe = .{};
    var request = es.AsyncQuery.init(testing.allocator, Probe.finished);
    defer request.deinit();
    request.owner = &probe;
    request.backend = &probe;
    request.run_query = Probe.run;
    try testing.expect(!core.fiber.onEventLoopThread());
    EventWebSocketServer.dispatchQuery(&pool, null, &request);
    probe.done.wait();
    try testing.expect(probe.thread != std.Thread.getCurrentId());
    try testing.expectEqual(@as(usize, 1), request.rows.len);
    try testing.expect(request.err == null);
}
