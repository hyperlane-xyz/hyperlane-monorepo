//! Socket-level tests for the HTTP server and WebSocket layer, plus the HTTP
//! parts of `src/module.test.ts` / `src/metrics.test.ts` that belong to this
//! module (metrics route, CORS, routing options, body limits).
const std = @import("std");
const core = @import("core");
const types = @import("types.zig");
const server_mod = @import("server.zig");
const ws = @import("ws.zig");
const loop_mod = @import("loop.zig");

const testing = std.testing;
const posix = std.posix;

// ---------------------------------------------------------------------------
// Test app: /metrics + an echo route standing in for /graphql
// ---------------------------------------------------------------------------

/// A 300 ms handler wait. On a fiber it parks (as every real wait does there);
/// otherwise it blocks the thread, announced to core.blocking when `hooked`.
/// "?gated" handlers wait while this is closed (at most 3 s), so a test can
/// check what gets answered before them without a wall-clock bound.
var gate_open = std.atomic.Value(bool).init(true);
/// "?gated" handlers that finished waiting.
var gated_done = std.atomic.Value(u32).init(0);

fn gateWait(hooked: bool) void {
    const until = std.time.milliTimestamp() + 3_000;
    while (!gate_open.load(.acquire) and std.time.milliTimestamp() < until) slowWait(5, hooked);
    _ = gated_done.fetchAdd(1, .acq_rel);
}

/// Closes the gate for one test (`defer openGate()`).
fn closeGate() void {
    gated_done.store(0, .release);
    gate_open.store(false, .release);
}

fn openGate() void {
    gate_open.store(true, .release);
}

fn slowWait(ms: i64, hooked: bool) void {
    if (server_mod.fibers and core.fiber.inFiber()) {
        var w: core.fiber.Waiter = .{};
        _ = w.waitTimeout(core.fiber.monoMs() + ms);
        return;
    }
    if (hooked) core.blocking.begin();
    std.Thread.sleep(@as(u64, @intCast(ms)) * std.time.ns_per_ms);
    if (hooked) core.blocking.end();
}

/// What a handler on a poller may use: graphql's deepest admitted request
/// (`_not` via variables) is 8.9 MiB in Debug and 2.5 MiB in ReleaseFast.
const stack_probe_bytes: usize = if (@import("builtin").mode == .Debug) 18 * 1024 * 1024 else 6 * 1024 * 1024;
const deep_frame = 64 * 1024;

/// Touches `deep_frame` bytes of stack per level.
noinline fn deepStack(levels: usize, depth: usize) usize {
    var frame: [deep_frame]u8 = undefined;
    @memset(@as([]volatile u8, &frame), @truncate(depth));
    if (depth + 1 >= levels) return depth + 1;
    const r = deepStack(levels, depth + 1);
    return r + (@as(*volatile u8, &frame[depth % deep_frame]).* & 0);
}

var shared_fd: std.atomic.Value(posix.fd_t) = .init(-1);
/// `?shared` handlers about to wait on `shared_fd` (no input yet): tests write
/// the byte only after this moves, so the wait (and its registration) happens.
var shared_parked: std.atomic.Value(u32) = .init(0);

/// A blocking read on `fd` fails after 10 s instead of hanging the test.
fn setRecvTimeout(fd: posix.socket_t) !void {
    const tv: posix.timeval = .{ .sec = 10, .usec = 0 };
    try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.RCVTIMEO, std.mem.asBytes(&tv));
}

/// Waits until a `?shared` handler parked after `seen` earlier ones.
fn waitSharedParked(seen: u32) !void {
    var waited: u32 = 0;
    while (shared_parked.load(.acquire) == seen) : (waited += 1) {
        if (waited >= 2_000) return error.HandlerNeverParked;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}
/// Owner for the "shared" handler's waits (`waitFdOwned`); 0: none.
var shared_owner: std.atomic.Value(u64) = .init(0);

const Echo = struct {
    mutex: std.Thread.Mutex = .{},
    on_request: u32 = 0,
    handled: u32 = 0,
    errors: u32 = 0,
    done_finished: u32 = 0,
    done_closed: u32 = 0,
    reject_uploads: bool = false,
    body_pending: bool = false,
    write_blocked: u32 = 0,
    peer_closed: u32 = 0,
    /// The status `on_peer_closed` read with `statusNow`.
    peer_closed_status: u16 = 0,

    fn onPeerClosed(ctx: *anyopaque, _: *types.Request, reply: *types.Reply) void {
        const self: *Echo = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.peer_closed += 1;
        self.peer_closed_status = reply.statusNow();
    }

    fn onWriteBlocked(ctx: *anyopaque, _: *types.Request, _: *types.Reply) void {
        const self: *Echo = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.write_blocked += 1;
    }

    fn onRequest(ctx: *anyopaque, req: *types.Request, reply: *types.Reply) void {
        const self: *Echo = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        self.on_request += 1;
        self.body_pending = req.body_pending;
        const reject = self.reject_uploads;
        self.mutex.unlock();
        if (reject and !std.mem.eql(u8, req.method, "GET")) {
            reply.code(503);
            reply.header("retry-after", "1");
            reply.header("connection", "close");
            reply.destroy_after = true;
            reply.sendText("GraphQL upload capacity exceeded");
        }
    }

    fn handler(ctx: *anyopaque, req: *types.Request, reply: *types.Reply) void {
        const self: *Echo = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        self.handled += 1;
        self.mutex.unlock();
        // A slow handler: input arriving meanwhile is merged into one edge.
        if (std.mem.eql(u8, req.query, "sleep")) slowWait(300, false);
        if (std.mem.eql(u8, req.query, "gated")) gateWait(false);
        if (std.mem.eql(u8, req.query, "gated-hooked")) gateWait(true);
        // A wait announced like a DB wait (core.blocking): handed off at once.
        // A short unannounced stall (caught by the monitor, not core.blocking).
        if (std.mem.eql(u8, req.query, "stall")) std.Thread.sleep(20 * std.time.ns_per_ms);
        if (std.mem.eql(u8, req.query, "hooked")) {
            slowWait(300, true);
        }
        if (std.mem.eql(u8, req.query, "deep")) {
            const used = deepStack(stack_probe_bytes / deep_frame, 0);
            return reply.sendText(if (used == stack_probe_bytes / deep_frame) "deep ok" else "deep short");
        }
        if (server_mod.fibers and std.mem.eql(u8, req.query, "spawn")) {
            // A detached child fiber that parks, then wakes the parent.
            const Child = struct {
                done: core.fiber.Waiter = .{},
                ran: bool = false,
                fn run(arg: *anyopaque) void {
                    const c: *@This() = @ptrCast(@alignCast(arg));
                    slowWait(20, false);
                    c.ran = true;
                    c.done.wake();
                }
            };
            var child: Child = .{};
            core.fiber.spawn(Child.run, &child) catch return reply.sendText("spawn failed");
            child.done.wait();
            return reply.sendText(if (child.ran) "spawned" else "not run");
        }
        if (std.mem.eql(u8, req.query, "park")) slowWait(2, false);
        if (server_mod.fibers and std.mem.eql(u8, req.query, "shared")) {
            // A socket every request waits on in turn, like a pooled DB
            // connection: its registration follows the waiting loop.
            const fd = shared_fd.load(.acquire);
            var b: [1]u8 = undefined;
            while (true) {
                const n = posix.read(fd, &b) catch |e| switch (e) {
                    error.WouldBlock => {
                        _ = shared_parked.fetchAdd(1, .release);
                        const deadline = core.fiber.monoMs() + 5_000;
                        const owner = shared_owner.load(.acquire);
                        const waited = if (owner != 0)
                            core.fiber.waitFdOwned(owner, fd, core.fiber.Events.read, deadline)
                        else
                            core.fiber.waitFd(fd, core.fiber.Events.read, deadline);
                        waited catch return reply.sendText("timeout");
                        continue;
                    },
                    else => return reply.sendText("read failed"),
                };
                if (n == 1) break;
                return reply.sendText("eof");
            }
            return reply.sendText("got");
        }
        if (std.mem.eql(u8, req.query, "loopthread")) return reply.sendText(if (core.onEventLoopThread()) "loop" else "other");
        if (std.mem.eql(u8, req.query, "fibercache")) {
            const text = std.fmt.allocPrint(req.arena, "{d}", .{core.fiber.cachedFibers()}) catch "?";
            return reply.sendText(text);
        }
        if (std.mem.eql(u8, req.query, "big")) {
            const big = req.arena.alloc(u8, 16 * 1024 * 1024) catch return;
            @memset(big, 'b');
            return reply.sendText(big);
        }
        var b: core.json.ObjectBuilder = .{};
        b.putNew(req.arena, "method", .{ .string = req.method }) catch {};
        b.putNew(req.arena, "query", .{ .string = req.query }) catch {};
        b.putNew(req.arena, "body", switch (req.body) {
            .none => .null,
            .json => |v| v,
            .text => |t| .{ .string = t },
        }) catch {};
        reply.sendJson(b.finish(req.arena) catch .null);
    }

    fn errorHandler(ctx: *anyopaque, req: *types.Request, reply: *types.Reply, err: types.FastifyError) void {
        const self: *Echo = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        self.errors += 1;
        self.mutex.unlock();
        // mercurius: { data: null, errors: [{ message }] }
        const body = std.fmt.allocPrint(req.arena, "{{\"data\":null,\"errors\":[{{\"message\":{f}}}]}}", .{core.json.Value{ .string = err.message }}) catch "";
        reply.sendSerializedJson(body);
    }

    fn onDone(ctx: *anyopaque, _: *types.Request, _: *types.Reply, reason: types.DoneReason) void {
        const self: *Echo = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        switch (reason) {
            .finished => self.done_finished += 1,
            .closed => self.done_closed += 1,
        }
    }

    /// `on_done` runs once the kernel took the last byte, which can be after
    /// the client already read the response: wait (bounded) for the count.
    fn waitFinished(self: *Echo, n: u32) Echo {
        var waited: u32 = 0;
        while (self.snapshot().done_finished < n and waited < 400) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
        return self.snapshot();
    }

    fn snapshot(self: *Echo) Echo {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.*;
    }
};

const WsEcho = struct {
    wss: ws.Server = .{ .options = .{ .max_payload = 4096, .close_timeout_ms = 500 } },
    /// `UpgradeHandler.removed`: the 'upgrade' listener is gone.
    upgrade_removed: std.atomic.Value(bool) = .init(false),
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    errors: std.ArrayList([]u8) = .empty,
    closes: std.ArrayList(u16) = .empty,
    pongs: u32 = 0,
    late_send: ?ws.SendError!void = null,
    /// A connection the test keeps after on_close (stale-handle checks).
    kept: ?*ws.Conn = null,
    /// Allocator for `/oom*` upgrades (allocation-failure tests).
    failing: ?std.mem.Allocator = null,
    short_busy: bool = false,
    /// Write-pass log: completed frame tags (>= 0), then -1 for a pass that
    /// drained the queue, -2 for one that did not.
    pass_log: std.ArrayList(i32) = .empty,
    send_in_pass_end: std.atomic.Value(bool) = .init(false),
    sent_in_pass_end: std.atomic.Value(bool) = .init(false),
    /// `/batch` connections: B/E read batch, m message, p pong, e error, c close.
    events: std.ArrayList(u8) = .empty,

    fn event(self: *WsEcho, e: u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.events.append(testing.allocator, e) catch @panic("oom");
    }

    fn onReadBegin(ctx: *anyopaque, _: *ws.Conn) void {
        @as(*WsEcho, @ptrCast(@alignCast(ctx))).event('B');
    }

    fn onReadEnd(ctx: *anyopaque, _: *ws.Conn) void {
        @as(*WsEcho, @ptrCast(@alignCast(ctx))).event('E');
    }

    /// `/batch`: reader-side transitions (t), applied inline like live's hook.
    fn onTransition(ctx: *anyopaque, conn: *ws.Conn, ev: ws.Transition) void {
        @as(*WsEcho, @ptrCast(@alignCast(ctx))).event('t');
        conn.applyTransition(ev);
    }

    fn onPassEnd(ctx: *anyopaque, conn: *ws.Conn, drained: bool) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        self.logPass(if (drained) -1 else -2);
        // Like live: block on another thread that sends on this connection
        // (a ws lock or the write token held here would deadlock or stall).
        if (self.send_in_pass_end.swap(false, .acq_rel)) {
            const Sender = struct {
                fn run(c: *ws.Conn, sent: *std.atomic.Value(bool)) void {
                    _ = c.snapshot();
                    _ = c.trySendInline("from-other-thread", false, null) catch {};
                    c.send("queued-from-other-thread", false, null) catch {};
                    sent.store(true, .release);
                }
            };
            const t = std.Thread.spawn(.{}, Sender.run, .{ conn, &self.sent_in_pass_end }) catch return;
            t.join();
        }
    }

    fn logPass(self: *WsEcho, v: i32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.pass_log.append(testing.allocator, v) catch @panic("oom");
    }

    fn ignoreSent(_: *anyopaque, _: *ws.Conn, _: bool) void {}

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        const oom = std.mem.startsWith(u8, req.path, "/oom");
        const keep = std.mem.eql(u8, req.path, "/keep");
        const greet = std.mem.eql(u8, req.path, "/greet");
        const kill = std.mem.eql(u8, req.path, "/kill");
        const short = std.mem.eql(u8, req.path, "/short");
        const batch = std.mem.eql(u8, req.path, "/batch");
        if (std.mem.eql(u8, req.path, "/reject")) return socket.endWith(reject_response);
        if (std.mem.eql(u8, req.path, "/reject-big")) {
            const big = req.arena.alloc(u8, reject_big_len) catch return socket.destroy();
            @memset(big, 'r');
            return socket.endWith(big);
        }
        if (!std.mem.eql(u8, req.path, "/agents") and !oom and !keep and !greet and !kill and !short and !batch) return socket.destroy();
        const gpa = if (oom) self.failing.? else testing.allocator;
        const conn = self.wss.handleUpgrade(gpa, req, socket, .{
            .ctx = self,
            .on_message = onMessage,
            .on_pong = onPong,
            .on_error = onError,
            .on_close = onClose,
            .on_pass_end = onPassEnd,
            .on_read_begin = if (batch) onReadBegin else null,
            .on_read_end = if (batch) onReadEnd else null,
            .transition = if (batch) onTransition else null,
        }) orelse return;
        if (keep) {
            self.kept = conn; // released by the test
            return;
        }
        // A frame sent during the upgrade goes out with the 101 (one write).
        if (greet) _ = conn.trySendInline("ready", false, null) catch {};
        if (kill) conn.terminate();
        if (short) {
            // The kernel takes only part of the pending 101: nothing of the
            // optional frame went out or was queued, so the caller falls back
            // to `send`.
            conn.test_send_cap = 40;
            const cb: ws.SendCallback = .{ .ctx = self, .func = ignoreSent };
            const r = conn.sendInlineCorked(&.{"ready"}, false, &.{cb}, 0) catch null;
            self.mutex.lock();
            self.short_busy = r != null and r.?.written == 0 and r.?.queued == 0;
            self.mutex.unlock();
            conn.send("ready", false, null) catch {};
        }
        conn.release();
    }

    fn onMessage(ctx: *anyopaque, conn: *ws.Conn, data: []const u8, binary: bool) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        self.event('m');
        if (std.mem.eql(u8, data, "close-me")) return conn.close(1008, "Invalid subscription");
        if (std.mem.eql(u8, data, "close-then-send")) {
            conn.close(1000, "bye");
            const r = conn.send("late", false, null);
            self.mutex.lock();
            self.late_send = r;
            self.mutex.unlock();
            return;
        }
        if (std.mem.eql(u8, data, "ping-me")) return conn.ping();
        if (std.mem.eql(u8, data, "sleep-me")) return std.Thread.sleep(300 * std.time.ns_per_ms);
        conn.send(data, binary, null) catch {};
    }

    fn onPong(ctx: *anyopaque, _: *ws.Conn) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        self.event('p');
        self.mutex.lock();
        defer self.mutex.unlock();
        self.pongs += 1;
    }

    fn onError(ctx: *anyopaque, _: *ws.Conn, message: []const u8) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        self.event('e');
        self.mutex.lock();
        defer self.mutex.unlock();
        self.errors.append(testing.allocator, testing.allocator.dupe(u8, message) catch return) catch {};
    }

    fn onClose(ctx: *anyopaque, _: *ws.Conn, code: u16, _: []const u8) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        self.event('c');
        self.mutex.lock();
        defer self.mutex.unlock();
        self.closes.append(testing.allocator, code) catch {};
        self.cond.broadcast();
    }

    fn waitCloses(self: *WsEcho, n: usize) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const deadline = std.time.milliTimestamp() + 3_000;
        while (self.closes.items.len < n) {
            const remaining = deadline - std.time.milliTimestamp();
            if (remaining <= 0) return error.Timeout;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
    }

    fn deinit(self: *WsEcho) void {
        for (self.errors.items) |e| testing.allocator.free(e);
        self.errors.deinit(testing.allocator);
        self.closes.deinit(testing.allocator);
        self.pass_log.deinit(testing.allocator);
        self.events.deinit(testing.allocator);
    }
};

const Harness = struct {
    echo: Echo = .{},
    wse: WsEcho = .{},
    routes: [2]types.Route = undefined,
    server: *server_mod.Server = undefined,
    /// `Options.loops` (fiber mode).
    loops: u32 = 1,

    fn start(self: *Harness, request_timeout_ms: u32) !void {
        self.routes = .{
            @import("metrics_route.zig").route(),
            .{
                .methods = &.{ "GET", "POST" },
                .path = "/graphql",
                .ctx = &self.echo,
                .hooks = .{ .on_request = Echo.onRequest, .handler = Echo.handler, .error_handler = Echo.errorHandler, .on_done = Echo.onDone, .on_write_blocked = Echo.onWriteBlocked, .on_peer_closed = Echo.onPeerClosed },
                .text_content_types = &.{"application/graphql"},
                // Like graphql: TS answers it after an await.
                .ts_async = true,
            },
        };
        self.server = try server_mod.Server.init(testing.allocator, .{
            .host = "127.0.0.1",
            .port = 0,
            .routes = &self.routes,
            .upgrade = .{ .ctx = &self.wse, .on_upgrade = WsEcho.onUpgrade, .removed = &self.wse.upgrade_removed },
            .request_timeout_ms = request_timeout_ms,
            .loops = self.loops,
        });
        try self.server.start();
    }

    fn stop(self: *Harness) void {
        self.server.deinit();
        self.wse.deinit();
    }

    /// macOS: under heavy loopback traffic `connect()` can report EISCONN,
    /// which std treats as `unreachable` (a test-client/std issue, not the
    /// server); the streaming dump test is Linux-only for that reason.
    fn connect(self: *Harness) !Client {
        const addr = try std.net.Address.parseIp("127.0.0.1", self.server.port());
        const stream = try std.net.tcpConnectToAddress(addr);
        return .{ .fd = stream.handle };
    }
};

const Response = struct {
    status: u16,
    head: []const u8,
    body: []const u8,

    fn header(self: Response, name: []const u8) ?[]const u8 {
        var lines = std.mem.splitSequence(u8, self.head, "\r\n");
        _ = lines.next();
        while (lines.next()) |line| {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            if (std.ascii.eqlIgnoreCase(line[0..colon], name)) return std.mem.trim(u8, line[colon + 1 ..], " ");
        }
        return null;
    }
};

const Client = struct {
    fd: posix.socket_t,
    buf: [256 * 1024]u8 = undefined,
    len: usize = 0,

    fn close(self: *Client) void {
        posix.close(self.fd);
    }

    fn send(self: *Client, bytes: []const u8) !void {
        if (!server_mod.blockingWriteForTests(self.fd, bytes)) return error.WriteFailed;
    }

    fn fill(self: *Client) !usize {
        var fds = [_]posix.pollfd{.{ .fd = self.fd, .events = posix.POLL.IN, .revents = 0 }};
        if (try posix.poll(&fds, 3_000) == 0) return error.Timeout;
        const n = posix.read(self.fd, self.buf[self.len..]) catch return 0;
        self.len += n;
        return n;
    }

    /// Reads one response (Content-Length framed; HEAD -> no body).
    fn read(self: *Client, a: std.mem.Allocator, head_only: bool) !Response {
        while (std.mem.indexOf(u8, self.buf[0..self.len], "\r\n\r\n") == null) {
            if (try self.fill() == 0) return error.EndOfStream;
        }
        const head_end = std.mem.indexOf(u8, self.buf[0..self.len], "\r\n\r\n").? + 4;
        const head = try a.dupe(u8, self.buf[0..head_end]);
        const status = try std.fmt.parseInt(u16, head[9..12], 10);
        var resp: Response = .{ .status = status, .head = head, .body = "" };
        var body_len: usize = 0;
        if (!head_only) if (resp.header("content-length")) |cl| {
            body_len = try std.fmt.parseInt(usize, cl, 10);
        };
        while (self.len < head_end + body_len) {
            if (try self.fill() == 0) return error.EndOfStream;
        }
        resp.body = try a.dupe(u8, self.buf[head_end .. head_end + body_len]);
        const used = head_end + body_len;
        std.mem.copyForwards(u8, self.buf[0 .. self.len - used], self.buf[used..self.len]);
        self.len -= used;
        return resp;
    }

    fn request(self: *Client, a: std.mem.Allocator, bytes: []const u8) !Response {
        try self.send(bytes);
        return self.read(a, std.mem.startsWith(u8, bytes, "HEAD "));
    }

    /// True once the server closed the connection.
    fn closedByPeer(self: *Client) bool {
        return (self.fill() catch return false) == 0;
    }

    /// Nothing left unread, then the server's FIN: EOF, not a reset (5 s).
    fn expectFin(self: *Client) !void {
        try testing.expectEqual(@as(usize, 0), self.len);
        var fds = [_]posix.pollfd{.{ .fd = self.fd, .events = posix.POLL.IN, .revents = 0 }};
        if (try posix.poll(&fds, 5_000) == 0) return error.Timeout;
        var b: [1]u8 = undefined;
        try testing.expectEqual(@as(usize, 0), try posix.read(self.fd, &b));
    }
};

/// The FIN alone aborts a waiting exchange (`hangup_policy` `.eof_drop`, as
/// Node); under `.reset_only` the half-closed client is answered.
fn finAborts() bool {
    const S = server_mod.Server;
    return S.abortsOn(S.hangupPolicyNow(), false);
}

/// Waits until the server classified another FIN after `seen`.
fn waitFinSeen(seen: u32) !void {
    var waited: u32 = 0;
    while (server_mod.test_fin_hangups.load(.monotonic) == seen) : (waited += 1) {
        if (waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

fn expectHeader(resp: Response, name: []const u8, value: []const u8) !void {
    const actual = resp.header(name) orelse {
        std.debug.print("missing header {s} in:\n{s}\n", .{ name, resp.head });
        return error.MissingHeader;
    };
    try testing.expectEqualStrings(value, actual);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test "404, CORS vary/allow-origin and header order match Fastify" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /nope?x=1 HTTP/1.1\r\nHost: a\r\nOrigin: https://example.com\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    try testing.expectEqualStrings("{\"message\":\"Route GET:/nope?x=1 not found\",\"error\":\"Not Found\",\"statusCode\":404}", r.body);
    try testing.expect(std.mem.startsWith(u8, r.head, "HTTP/1.1 404 Not Found\r\nvary: Origin\r\naccess-control-allow-origin: https://example.com\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 80\r\nDate: "));
    try testing.expect(std.mem.endsWith(u8, r.head, " GMT\r\nConnection: keep-alive\r\nKeep-Alive: timeout=72\r\n\r\n"));
    // Same socket keeps working (keep-alive).
    const r2 = try c.request(arena.allocator(), "DELETE /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqualStrings("{\"message\":\"Route DELETE:/graphql not found\",\"error\":\"Not Found\",\"statusCode\":404}", r2.body);
    try testing.expect(r2.header("access-control-allow-origin") == null);
    try expectHeader(r2, "vary", "Origin");
}

test "a request that gets no fiber is answered 503 and its handler never runs on the loop thread" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const handled = h.echo.snapshot().handled;
    var c = try h.connect();
    defer c.close();
    core.fiber.test_fail_create.store(true, .release);
    defer core.fiber.test_fail_create.store(false, .release);
    const r = try c.request(arena.allocator(), "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 503), r.status);
    // The 503 came from the injected failure (it can't stay armed).
    try testing.expect(!core.fiber.test_fail_create.load(.acquire));
    try testing.expectEqual(handled, h.echo.snapshot().handled);
    // The next connection is served normally.
    var c2 = try h.connect();
    defer c2.close();
    try testing.expectEqual(@as(u16, 200), (try c2.request(arena.allocator(), "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n")).status);
}

test "handlers run on a thread that reports itself as an event-loop thread" {
    try testing.expect(!core.onEventLoopThread());
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /graphql?loopthread HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqualStrings("loop", r.body);
}

test "metrics snapshot providers never run on a fiber (they take OS mutexes)" {
    const Probe = struct {
        var calls = std.atomic.Value(u32).init(0);
        var on_fiber = std.atomic.Value(bool).init(false);
        fn snapshot(_: *anyopaque, _: std.mem.Allocator) std.mem.Allocator.Error!core.metrics.WebSocketMetricsSnapshot {
            _ = calls.fetchAdd(1, .monotonic);
            if (core.fiber.inFiber()) on_fiber.store(true, .monotonic);
            return .{};
        }
    };
    var dummy: u8 = 0;
    core.metrics.setWebSocketMetricsProvider(.{ .ctx = &dummy, .snapshot = Probe.snapshot });
    defer core.metrics.setWebSocketMetricsProvider(null);
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /metrics HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 200), r.status);
    try testing.expect(Probe.calls.load(.monotonic) > 0);
    try testing.expect(!Probe.on_fiber.load(.monotonic));
}

test "metrics route: content type, case-insensitive, trailing slash, HEAD" {
    core.metrics.init();
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /METRICS/ HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 200), r.status);
    try expectHeader(r, "content-type", "text/plain; version=0.0.4; charset=utf-8");
    try testing.expect(std.mem.indexOf(u8, r.body, "hyperlane_scraper_proxy_websocket_send_failures_total{reason=\"buffer_limit\"} 0") != null);
    const head = try c.request(arena.allocator(), "HEAD /metrics HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 200), head.status);
    try testing.expect(head.header("content-length") != null);
    try testing.expectEqualStrings("", head.body);
    // Next request on the same socket proves no body bytes were sent for HEAD.
    const post = try c.request(arena.allocator(), "POST /metrics HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), post.status);
}

test "CORS preflight (strict) answers any path" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const ok = try c.request(arena.allocator(), "OPTIONS /graphql HTTP/1.1\r\nHost: a\r\nOrigin: https://example.com\r\nAccess-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: mercurius-require-preflight\r\n\r\n");
    try testing.expectEqual(@as(u16, 204), ok.status);
    try testing.expect(std.mem.startsWith(u8, ok.head, "HTTP/1.1 204 No Content\r\nvary: Origin, Access-Control-Request-Headers\r\naccess-control-allow-origin: https://example.com\r\naccess-control-allow-methods: GET,HEAD,POST\r\naccess-control-allow-headers: mercurius-require-preflight\r\ncontent-length: 0\r\nDate: "));
    const bad = try c.request(arena.allocator(), "OPTIONS /anything HTTP/1.1\r\nHost: a\r\nAccess-Control-Request-Method: GET\r\n\r\n");
    try testing.expectEqual(@as(u16, 400), bad.status);
    try testing.expectEqualStrings("Invalid Preflight Request", bad.body);
    try expectHeader(bad, "content-type", "text/plain");
}

test "body parsing: json, text, application/graphql, chunked, errors" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const json_ok = try c.request(a, "POST /GraphQL/ HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 26\r\n\r\n{\"query\":\"{ x }\",\"n\":1e21}");
    try testing.expectEqual(@as(u16, 200), json_ok.status);
    try testing.expectEqualStrings("{\"method\":\"POST\",\"query\":\"\",\"body\":{\"query\":\"{ x }\",\"n\":1e+21}}", json_ok.body);
    try expectHeader(json_ok, "content-type", "application/json; charset=utf-8");
    const gql = try c.request(a, "POST /graphql?a=1 HTTP/1.1\r\nHost: a\r\nContent-Type: application/graphql; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{ x\r\n2\r\n }\r\n0\r\n\r\n");
    try testing.expectEqualStrings("{\"method\":\"POST\",\"query\":\"a=1\",\"body\":\"{ x }\"}", gql.body);
    const get = try c.request(a, "GET /graphql?query=%7Bx%7D HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqualStrings("{\"method\":\"GET\",\"query\":\"query=%7Bx%7D\",\"body\":null}", get.body);
    const no_ct = try c.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqualStrings("{\"method\":\"POST\",\"query\":\"\",\"body\":null}", no_ct.body);

    const empty = try c.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n");
    try testing.expectEqual(@as(u16, 400), empty.status);
    try testing.expectEqualStrings("{\"data\":null,\"errors\":[{\"message\":\"Body cannot be empty when content-type is set to 'application/json'\"}]}", empty.body);
    try testing.expect(std.mem.startsWith(u8, empty.head, "HTTP/1.1 400 Bad Request\r\nvary: Origin\r\nconnection: close\r\ncontent-type: application/json; charset=utf-8\r\n"));
    try testing.expect(c.closedByPeer());

    var c2 = try h.connect();
    defer c2.close();
    const bad = try c2.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\n{bad");
    try testing.expectEqual(@as(u16, 400), bad.status);
    try testing.expectEqualStrings("{\"data\":null,\"errors\":[{\"message\":\"Body is not valid JSON but content-type is set to 'application/json'\"}]}", bad.body);
    var c3 = try h.connect();
    defer c3.close();
    const proto = try c3.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n{\"__proto__\":{}}");
    try testing.expectEqual(@as(u16, 400), proto.status);
    var c4 = try h.connect();
    defer c4.close();
    const xml = try c4.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/xml\r\nContent-Length: 4\r\n\r\n<a/>");
    try testing.expectEqual(@as(u16, 415), xml.status);
    try testing.expectEqualStrings("{\"data\":null,\"errors\":[{\"message\":\"Unsupported Media Type\"}]}", xml.body);
    const snap = h.echo.waitFinished(8);
    try testing.expectEqual(@as(u32, 4), snap.handled);
    try testing.expectEqual(@as(u32, 4), snap.errors);
    try testing.expectEqual(@as(u32, 8), snap.done_finished);
}

test "rejects oversized bodies with 413 before reading them" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 102401\r\n\r\n");
    try testing.expectEqual(@as(u16, 413), r.status);
    try testing.expectEqualStrings("{\"data\":null,\"errors\":[{\"message\":\"Request body is too large\"}]}", r.body);
    try expectHeader(r, "connection", "close");
    try testing.expect(c.closedByPeer());
    // Chunked bodies are cut off once they exceed the limit.
    var c2 = try h.connect();
    defer c2.close();
    var big: std.ArrayList(u8) = .empty;
    defer big.deinit(testing.allocator);
    try big.appendSlice(testing.allocator, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n19001\r\n");
    try big.appendNTimes(testing.allocator, 'x', 0x19001);
    try big.appendSlice(testing.allocator, "\r\n0\r\n\r\n");
    const r2 = try c2.request(arena.allocator(), big.items);
    try testing.expectEqual(@as(u16, 413), r2.status);
}

test "on_request short-circuit closes the socket; aborted uploads report on_done(.closed)" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // Incomplete upload then client disconnect (once its head was seen).
    var c = try h.connect();
    const seen = h.echo.snapshot().on_request;
    try c.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    var seen_waited: u32 = 0;
    while (h.echo.snapshot().on_request == seen) : (seen_waited += 1) {
        if (seen_waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    c.close();
    var waited: u32 = 0;
    while (h.echo.snapshot().done_closed == 0 and waited < 500) : (waited += 1) std.Thread.sleep(10 * std.time.ns_per_ms);
    var snap = h.echo.snapshot();
    try testing.expectEqual(@as(u32, 1), snap.done_closed);
    try testing.expectEqual(@as(u32, 0), snap.handled);

    h.echo.mutex.lock();
    h.echo.reject_uploads = true;
    h.echo.mutex.unlock();
    var c2 = try h.connect();
    defer c2.close();
    const r = try c2.request(arena.allocator(), "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 102400\r\n\r\n{");
    try testing.expectEqual(@as(u16, 503), r.status);
    try testing.expectEqualStrings("GraphQL upload capacity exceeded", r.body);
    try testing.expect(std.mem.startsWith(u8, r.head, "HTTP/1.1 503 Service Unavailable\r\nvary: Origin\r\nretry-after: 1\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: 32\r\nDate: "));
    try testing.expect(c2.closedByPeer());
    snap = h.echo.waitFinished(1);
    try testing.expectEqual(@as(u32, 1), snap.done_finished);
}

test "connection: close and HTTP/1.0 are honoured; requestTimeout covers the head only" {
    var h: Harness = .{};
    try h.start(300);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
    try expectHeader(r, "connection", "close");
    try testing.expect(c.closedByPeer());
    var c2 = try h.connect();
    defer c2.close();
    const r2 = try c2.request(arena.allocator(), "GET /nope HTTP/1.0\r\n\r\n");
    try expectHeader(r2, "connection", "close");
    var c3 = try h.connect();
    defer c3.close();
    // Measured against Node: a stalled body is never timed out ...
    try c3.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Length: 10\r\nContent-Type: text/plain\r\n\r\nabc");
    std.Thread.sleep(600 * std.time.ns_per_ms);
    try c3.send("defghij");
    const r3 = try c3.read(arena.allocator(), false);
    try testing.expectEqual(@as(u16, 200), r3.status);
    // ... but a stalled head gets Fastify's 408 client error.
    var c5 = try h.connect();
    defer c5.close();
    try c5.send("GET /nope HTTP/1.1\r\nHost: a\r\n");
    const r5 = try c5.read(arena.allocator(), false);
    try testing.expectEqual(@as(u16, 408), r5.status);
    try testing.expectEqualStrings("{\"error\":\"Request Timeout\",\"message\":\"Client Timeout\",\"statusCode\":408}", r5.body);
    var c4 = try h.connect();
    defer c4.close();
    const r4 = try c4.request(arena.allocator(), "GARBAGE\r\n\r\n");
    try testing.expectEqual(@as(u16, 400), r4.status);
}

test "a Connection: close response closes at once like Node's destroySoon: later bytes get RST" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // The body follows the response: the socket is already closed (no drain).
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "POST /nope HTTP/1.1\r\nHost: a\r\nConnection: close\r\nContent-Length: 10\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    try testing.expect(c.closedByPeer());
    try c.send("0123456789");
    // The RST sets the socket error (Linux: EPIPE in CLOSE_WAIT; macOS: ECONNRESET).
    var reset = false;
    var tries: u32 = 0;
    while (!reset and tries < 500) : (tries += 1) {
        reset = try socketError(c.fd) != 0;
        if (!reset) std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    try testing.expect(reset);
    // A body already sent is discarded before the close: the response stays whole.
    var c2 = try h.connect();
    defer c2.close();
    var big: std.ArrayList(u8) = .empty;
    defer big.deinit(testing.allocator);
    try big.appendSlice(testing.allocator, "POST /nope HTTP/1.1\r\nHost: a\r\nConnection: close\r\nContent-Length: 20000\r\n\r\n");
    try big.appendNTimes(testing.allocator, 'x', 20000);
    const r2 = try c2.request(arena.allocator(), big.items);
    try testing.expectEqual(@as(u16, 404), r2.status);
    try testing.expect(c2.closedByPeer());
}

fn socketError(fd: posix.socket_t) !i32 {
    var err_bytes: [4]u8 = undefined;
    try posix.getsockopt(fd, posix.SOL.SOCKET, posix.SO.ERROR, &err_bytes);
    return std.mem.readInt(i32, &err_bytes, @import("builtin").cpu.arch.endian());
}

test "Node-written Connection: close responses (missing Host 400) dump the body before closing" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    // More body than one read takes, all of it queued before the server
    // answers (one write that fits the socket buffers): without the dump,
    // close() with that unread input would RST (and could take the 400 with it).
    var req: std.ArrayList(u8) = .empty;
    defer req.deinit(testing.allocator);
    try req.appendSlice(testing.allocator, "POST /nope HTTP/1.1\r\nContent-Length: 100000\r\n\r\n");
    try req.appendNTimes(testing.allocator, 'x', 100_000);
    const r = try c.request(arena.allocator(), req.items);
    try testing.expectEqual(@as(u16, 400), r.status);
    // Linux (loopback buffers hold the whole write before the server answers):
    // the dump leaves nothing unread, so a clean FIN and no RST. Elsewhere the
    // body may still be arriving, and Node's own dump races the close there too.
    std.Thread.sleep(50 * std.time.ns_per_ms);
    if (@import("builtin").os.tag == .linux) try testing.expectEqual(@as(i32, 0), try socketError(c.fd));
    var reads: u32 = 0;
    while (try c.fill() > 0 and reads < 10) reads += 1;
    try testing.expect(reads < 10);
}

test "the body dump before a close is bounded: a client streaming without end cannot hold the loop" {
    // Linux only: full reads (the unbounded case) need Linux's loopback
    // buffers, and macOS connect() can report EISCONN under this load.
    if (@import("builtin").os.tag != .linux) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var streamer = try h.connect();
    defer streamer.close();
    try streamer.send("POST /nope HTTP/1.1\r\nHost: a\r\nConnection: close\r\nContent-Length: 1000000000\r\n\r\n");
    const Feed = struct {
        fn run(fd: posix.socket_t, stop: *std.atomic.Value(bool), failed: *std.atomic.Value(bool)) void {
            const chunk = [_]u8{'x'} ** (64 * 1024);
            while (!stop.load(.acquire)) {
                if (!server_mod.blockingWriteForTests(fd, &chunk)) {
                    // RST: the server closed (the failed write consumes the socket error).
                    failed.store(true, .release);
                    return;
                }
            }
        }
    };
    var stop: std.atomic.Value(bool) = .init(false);
    var failed: std.atomic.Value(bool) = .init(false);
    const feeder = try std.Thread.spawn(.{}, Feed.run, .{ streamer.fd, &stop, &failed });
    defer {
        stop.store(true, .release);
        feeder.join();
    }
    // The streaming client gets its 404, then the closed socket's RST.
    const r = try streamer.read(arena.allocator(), false);
    try testing.expectEqual(@as(u16, 404), r.status);
    // Meanwhile the loop serves another connection promptly.
    var other = try h.connect();
    defer other.close();
    const started = std.time.milliTimestamp();
    const r2 = try other.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r2.status);
    try testing.expect(std.time.milliTimestamp() - started < 3_000);
    var reset = false;
    var tries: u32 = 0;
    while (!reset and tries < 500) : (tries += 1) {
        reset = failed.load(.acquire) or try socketError(streamer.fd) != 0;
        if (!reset) std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    try testing.expect(reset);
}

test "a close response with body bytes in flight: input during the turn is discarded (FIN), after it gets RST" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // Widen the turn (normally one loop pass) so the second part can be timed into it.
    server_mod.test_close_turn_ms.store(1_000, .monotonic);
    defer server_mod.test_close_turn_ms.store(0, .monotonic);
    var rest: [10_000]u8 = undefined;
    @memset(&rest, 'x');
    {
        // Second part during the turn: discarded, then a clean FIN.
        var c = try h.connect();
        defer c.close();
        try c.send("POST /nope HTTP/1.1\r\nHost: a\r\nConnection: close\r\nContent-Length: 20000\r\n\r\n");
        try c.send(rest[0..]);
        const r = try c.read(arena.allocator(), false);
        try testing.expectEqual(@as(u16, 404), r.status);
        std.Thread.sleep(50 * std.time.ns_per_ms);
        try c.send(rest[0..]);
        try testing.expect(c.closedByPeer());
        std.Thread.sleep(50 * std.time.ns_per_ms);
        try testing.expectEqual(@as(i32, 0), try socketError(c.fd));
    }
    server_mod.test_close_turn_ms.store(0, .monotonic);
    {
        // Second part after the turn: it meets the closed socket (RST), as with Node.
        var c = try h.connect();
        defer c.close();
        try c.send("POST /nope HTTP/1.1\r\nHost: a\r\nConnection: close\r\nContent-Length: 20000\r\n\r\n");
        try c.send(rest[0..]);
        const r = try c.read(arena.allocator(), false);
        try testing.expectEqual(@as(u16, 404), r.status);
        try testing.expect(c.closedByPeer());
        try c.send(rest[0..]);
        var reset = false;
        var tries: u32 = 0;
        while (!reset and tries < 500) : (tries += 1) {
            reset = try socketError(c.fd) != 0;
            if (!reset) std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        try testing.expect(reset);
    }
}

test "chunked bodies count received bytes against the limit (Fastify), not declared sizes" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    // A chunk declared beyond the limit: nothing is answered until the bytes arrive.
    try c.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n19001\r\nabc");
    var fds = [_]posix.pollfd{.{ .fd = c.fd, .events = posix.POLL.IN, .revents = 0 }};
    try testing.expectEqual(@as(usize, 0), try posix.poll(&fds, 200));
    var rest: std.ArrayList(u8) = .empty;
    defer rest.deinit(testing.allocator);
    try rest.appendNTimes(testing.allocator, 'x', 0x19001 - 3);
    try c.send(rest.items);
    const r = try c.read(arena.allocator(), false);
    try testing.expectEqual(@as(u16, 413), r.status);
}

fn waitEcho(h: *Harness, comptime field: []const u8, n: u32) !void {
    var waited: u32 = 0;
    while (@field(h.echo.snapshot(), field) < n) : (waited += 1) {
        if (waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

/// Closes `fd` with RST (SO_LINGER 0).
fn closeWithReset(fd: posix.socket_t) void {
    const linger: extern struct { onoff: c_int, linger: c_int } = .{ .onoff = 1, .linger = 0 };
    posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.LINGER, std.mem.asBytes(&linger)) catch {};
    posix.close(fd);
}

test "a peer hangup while the handler waits aborts the exchange: on_peer_closed once, no response, then on_done(.closed)" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    closeGate();
    defer openGate();
    // EOF (half-close, Linux RDHUP / kqueue EV_EOF): Node's socketOnEnd ends the
    // socket, so the response never goes out.
    eof: {
        const before = h.echo.snapshot();
        var c = try h.connect();
        defer c.close();
        try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\n");
        try waitEcho(&h, "handled", before.handled + 1);
        const fins = server_mod.test_fin_hangups.load(.monotonic);
        const resets = server_mod.test_reset_hangups.load(.monotonic);
        try posix.shutdown(c.fd, .send);
        if (!finAborts()) {
            // reset_only: the FIN is seen, the response still goes out.
            try waitFinSeen(fins);
            openGate();
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            try testing.expectEqual(@as(u16, 200), (try c.read(arena.allocator(), false)).status);
            try waitEcho(&h, "done_finished", before.done_finished + 1);
            try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
            break :eof;
        }
        // The hook runs while the handler still waits at the gate.
        try waitEcho(&h, "peer_closed", before.peer_closed + 1);
        try testing.expectEqual(before.done_closed, h.echo.snapshot().done_closed);
        try testing.expectEqual(@as(u16, 200), h.echo.snapshot().peer_closed_status);
        // Classified as a bare FIN (the half-close decision), not a reset.
        try testing.expect(server_mod.test_fin_hangups.load(.monotonic) > fins);
        try testing.expectEqual(resets, server_mod.test_reset_hangups.load(.monotonic));
        openGate();
        try waitEcho(&h, "done_closed", before.done_closed + 1);
        // No byte of the response: EOF only.
        try testing.expect(c.closedByPeer());
        try testing.expectEqual(@as(usize, 0), c.len);
        const after = h.echo.snapshot();
        try testing.expectEqual(before.peer_closed + 1, after.peer_closed);
        try testing.expectEqual(before.done_finished, after.done_finished);
    }
    closeGate();
    // RST while the handler waits.
    {
        const before = h.echo.snapshot();
        var c = try h.connect();
        try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\n");
        try waitEcho(&h, "handled", before.handled + 1);
        const resets = server_mod.test_reset_hangups.load(.monotonic);
        closeWithReset(c.fd);
        try waitEcho(&h, "peer_closed", before.peer_closed + 1);
        // Classified as a reset: it aborts whatever the half-close policy.
        try testing.expect(server_mod.test_reset_hangups.load(.monotonic) > resets);
        try testing.expectEqual(before.done_closed, h.echo.snapshot().done_closed);
        openGate();
        try waitEcho(&h, "done_closed", before.done_closed + 1);
        const after = h.echo.snapshot();
        try testing.expectEqual(before.peer_closed + 1, after.peer_closed);
        try testing.expectEqual(before.done_finished, after.done_finished);
    }
    // A hangup after the response: finish already won, no hook.
    {
        const before = h.echo.snapshot();
        var c = try h.connect();
        const r = try c.request(std.testing.allocator, "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
        std.testing.allocator.free(r.head);
        std.testing.allocator.free(r.body);
        try waitEcho(&h, "done_finished", before.done_finished + 1);
        try posix.shutdown(c.fd, .send);
        std.Thread.sleep(50 * std.time.ns_per_ms);
        c.close();
        std.Thread.sleep(50 * std.time.ns_per_ms);
        try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
    }
}

test "hangup policy: eof_drop aborts on FIN and reset; reset_only only on reset" {
    const S = server_mod.Server;
    try testing.expect(S.abortsOn(.eof_drop, false));
    try testing.expect(S.abortsOn(.eof_drop, true));
    try testing.expect(!S.abortsOn(.reset_only, false));
    try testing.expect(S.abortsOn(.reset_only, true));
}

/// Holds the loop's only thread (a fiber that does not yield) so input
/// queues up in the kernel; `release` lets the loop see it all in one wait.
const LoopHold = struct {
    started: std.atomic.Value(bool) = .init(false),
    held: std.atomic.Value(bool) = .init(true),

    fn run(arg: *anyopaque) void {
        const self: *LoopHold = @ptrCast(@alignCast(arg));
        self.started.store(true, .release);
        while (self.held.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    }

    fn hold(self: *LoopHold, h: *Harness) !void {
        try h.server.loop.startFiber(run, self, null);
        var waited: u32 = 0;
        while (!self.started.load(.acquire)) : (waited += 1) {
            if (waited >= 5_000) return error.Timeout;
            std.Thread.sleep(std.time.ns_per_ms);
        }
    }

    fn release(self: *LoopHold) void {
        self.held.store(false, .release);
    }
};

test "a hangup read together with the request still aborts once the handler waits (FIN merged, RST merged)" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    closeGate();
    defer openGate();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // Request plus FIN queued while the loop is held: the loop reads both in
    // one go, so no event follows once the handler waits.
    fin: {
        const before = h.echo.snapshot();
        const merged = server_mod.test_merged_hangups.load(.monotonic);
        const fins = server_mod.test_fin_hangups.load(.monotonic);
        var c = try h.connect();
        defer c.close();
        _ = try c.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        var hold: LoopHold = .{};
        try hold.hold(&h);
        try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\n");
        try posix.shutdown(c.fd, .send);
        std.Thread.sleep(50 * std.time.ns_per_ms);
        hold.release();
        if (!finAborts()) {
            // reset_only: the FIN is seen, the response still goes out.
            try waitFinSeen(fins);
            openGate();
            try testing.expectEqual(@as(u16, 200), (try c.read(arena.allocator(), false)).status);
            try testing.expectEqual(merged, server_mod.test_merged_hangups.load(.monotonic));
            try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
            closeGate();
            break :fin;
        }
        try waitEcho(&h, "peer_closed", before.peer_closed + 1);
        // Decided on the merged path (right after the handler parked), as a FIN.
        try testing.expectEqual(merged + 1, server_mod.test_merged_hangups.load(.monotonic));
        try testing.expect(server_mod.test_fin_hangups.load(.monotonic) > fins);
        openGate();
        try waitEcho(&h, "done_closed", before.done_closed + 1);
        try testing.expect(c.closedByPeer());
        try testing.expectEqual(@as(usize, 0), c.len);
        try testing.expectEqual(before.done_finished, h.echo.snapshot().done_finished);
        closeGate();
    }
    // Request plus RST queued while the loop is held: a reset, whatever the
    // half-close policy. If the reset kept the request from being read, no
    // handler runs; either way no response finishes.
    {
        const before = h.echo.snapshot();
        const resets = server_mod.test_reset_hangups.load(.monotonic);
        var c = try h.connect();
        _ = try c.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        var hold: LoopHold = .{};
        try hold.hold(&h);
        try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\n");
        std.Thread.sleep(20 * std.time.ns_per_ms);
        closeWithReset(c.fd);
        std.Thread.sleep(50 * std.time.ns_per_ms);
        hold.release();
        std.Thread.sleep(100 * std.time.ns_per_ms);
        const mid = h.echo.snapshot();
        if (mid.handled > before.handled) {
            try waitEcho(&h, "peer_closed", before.peer_closed + 1);
            try testing.expect(server_mod.test_reset_hangups.load(.monotonic) > resets);
        }
        openGate();
        if (mid.handled > before.handled) try waitEcho(&h, "done_closed", before.done_closed + 1);
        try testing.expectEqual(before.done_finished, h.echo.snapshot().done_finished);
    }
}

test "under the reset_only policy a client that only half-closed still gets its response" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    server_mod.test_reset_only.store(true, .monotonic);
    defer server_mod.test_reset_only.store(false, .monotonic);
    closeGate();
    defer openGate();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const before = h.echo.snapshot();
    const fins = server_mod.test_fin_hangups.load(.monotonic);
    var c = try h.connect();
    defer c.close();
    try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitEcho(&h, "handled", before.handled + 1);
    try posix.shutdown(c.fd, .send);
    var waited: u32 = 0;
    while (server_mod.test_fin_hangups.load(.monotonic) == fins and waited < 5_000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
    try testing.expect(server_mod.test_fin_hangups.load(.monotonic) > fins);
    openGate();
    const r = try c.read(arena.allocator(), false);
    try testing.expectEqual(@as(u16, 200), r.status);
    try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
}

/// Sends `bytes` on a fresh connection and returns everything the server
/// sends until it closes (bounded 5 s).
fn exchangeAll(h: *Harness, a: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    var c = try h.connect();
    defer c.close();
    try c.send(bytes);
    try setRecvTimeout(c.fd);
    var out: std.ArrayList(u8) = .empty;
    var buf: [16 * 1024]u8 = undefined;
    while (true) {
        const n = posix.read(c.fd, &buf) catch break;
        if (n == 0) break;
        try out.appendSlice(a, buf[0..n]);
    }
    return out.items;
}

fn statusLines(a: std.mem.Allocator, all: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var it = std.mem.splitSequence(u8, all, "HTTP/1.1 ");
    _ = it.next();
    while (it.next()) |part| {
        if (out.items.len > 0) try out.append(a, '+');
        try out.appendSlice(a, part[0..3]);
    }
    return out.items;
}

test "data after a non-keep-alive request: the answer policy (default) ignores it; node_400 matches TS per request" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const close = "Connection: close\r\n";
    // The answer policy: the response, nothing else.
    if (server_mod.Server.closed_connection_policy == .answer)
        try testing.expectEqualStrings("404", try statusLines(a, try exchangeAll(&h, a, "GET /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "\r\nx")));
    server_mod.test_node_400.store(true, .monotonic);
    defer server_mod.test_node_400.store(false, .monotonic);
    // TS (rig probes): a sync route answers, then clientError's 400.
    try testing.expectEqualStrings("404+400", try statusLines(a, try exchangeAll(&h, a, "GET /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "\r\nx")));
    try testing.expectEqualStrings("404+400", try statusLines(a, try exchangeAll(&h, a, "GET /nope HTTP/1.0\r\n\r\nGET /nope HTTP/1.1\r\nHost: a\r\n\r\n")));
    try testing.expectEqualStrings("404+400", try statusLines(a, try exchangeAll(&h, a, "POST /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\nx")));
    try testing.expectEqualStrings("204+400", try statusLines(a, try exchangeAll(&h, a, "OPTIONS /graphql HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Origin: http://o\r\nAccess-Control-Request-Method: POST\r\n\r\nx")));
    // CR/LF after the message is skipped (llhttp's closed state).
    try testing.expectEqualStrings("404", try statusLines(a, try exchangeAll(&h, a, "GET /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "\r\n\r\n")));
    // An async route (and any parsed body): only the 400; the response is dropped.
    const before = h.echo.snapshot();
    const all = try exchangeAll(&h, a, "GET /graphql HTTP/1.1\r\nHost: a\r\n" ++ close ++ "\r\nx");
    try testing.expectEqualStrings("400", try statusLines(a, all));
    try testing.expect(std.mem.endsWith(u8, all, "{\"error\":\"Bad Request\",\"message\":\"Client Error\",\"statusCode\":400}"));
    try waitEcho(&h, "done_closed", before.done_closed + 1);
    try testing.expect(h.echo.snapshot().peer_closed > before.peer_closed);
    try testing.expectEqualStrings("400", try statusLines(a, try exchangeAll(&h, a, "POST /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Content-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}x")));
    try testing.expectEqualStrings("400", try statusLines(a, try exchangeAll(&h, a, "POST /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Content-Type: text/plain\r\nContent-Length: 0\r\n\r\nx")));
    try testing.expectEqualStrings("400", try statusLines(a, try exchangeAll(&h, a, "GET /metrics HTTP/1.1\r\nHost: a\r\n" ++ close ++ "\r\nx")));
    // A body no parser reads: Node's parser never reaches the closed state.
    try testing.expectEqualStrings("404", try statusLines(a, try exchangeAll(&h, a, "POST /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Content-Length: 5\r\n\r\nhellox")));
    try testing.expectEqualStrings("404", try statusLines(a, try exchangeAll(&h, a, "GET /nope HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Content-Length: 5\r\n\r\nhellox")));
    try testing.expectEqualStrings("204", try statusLines(a, try exchangeAll(&h, a, "OPTIONS /graphql HTTP/1.1\r\nHost: a\r\n" ++ close ++ "Origin: http://o\r\nAccess-Control-Request-Method: POST\r\nContent-Length: 2\r\n\r\n{}x")));
}

test "node_400: a byte arriving while an async route's handler waits replaces its response with the 400" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    server_mod.test_node_400.store(true, .monotonic);
    defer server_mod.test_node_400.store(false, .monotonic);
    closeGate();
    defer openGate();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const before = h.echo.snapshot();
    var c = try h.connect();
    defer c.close();
    try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
    try waitEcho(&h, "handled", before.handled + 1);
    // CR/LF alone changes nothing (more than one peek's worth); another
    // byte aborts (Node reads it at once).
    try c.send("\r\n" ** 1500);
    std.Thread.sleep(30 * std.time.ns_per_ms);
    try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
    try c.send("\r\n" ** 1500 ++ "x");
    try waitEcho(&h, "peer_closed", before.peer_closed + 1);
    // The 400 and the FIN while the handler still waits (Node destroys the
    // socket at once); the junk was read, so no reset.
    const r = try c.read(a, false);
    try testing.expectEqual(@as(u16, 400), r.status);
    try c.expectFin();
    openGate();
    try waitEcho(&h, "done_closed", before.done_closed + 1);
    try testing.expectEqual(before.done_finished, h.echo.snapshot().done_finished);
}

test "node_400: data before a hangup in the same read still gets the 400 (Node's 'data' before 'end')" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    server_mod.test_node_400.store(true, .monotonic);
    defer server_mod.test_node_400.store(false, .monotonic);
    closeGate();
    defer openGate();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Request + junk + FIN read in one go while the loop was held.
    {
        const before = h.echo.snapshot();
        var c = try h.connect();
        defer c.close();
        _ = try c.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        var hold: LoopHold = .{};
        try hold.hold(&h);
        try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\nx");
        try posix.shutdown(c.fd, .send);
        std.Thread.sleep(50 * std.time.ns_per_ms);
        hold.release();
        try waitEcho(&h, "peer_closed", before.peer_closed + 1);
        try testing.expectEqual(@as(u16, 400), (try c.read(a, false)).status);
        try c.expectFin();
        openGate();
        try waitEcho(&h, "done_closed", before.done_closed + 1);
        try testing.expectEqual(before.peer_closed + 1, h.echo.snapshot().peer_closed);
        try testing.expectEqual(before.done_finished, h.echo.snapshot().done_finished);
        closeGate();
    }
    // Junk + FIN in one edge while the handler waits.
    {
        const before = h.echo.snapshot();
        var c = try h.connect();
        defer c.close();
        try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
        try waitEcho(&h, "handled", before.handled + 1);
        var hold: LoopHold = .{};
        try hold.hold(&h);
        try c.send("x");
        try posix.shutdown(c.fd, .send);
        std.Thread.sleep(50 * std.time.ns_per_ms);
        hold.release();
        try waitEcho(&h, "peer_closed", before.peer_closed + 1);
        try testing.expectEqual(@as(u16, 400), (try c.read(a, false)).status);
        try c.expectFin();
        openGate();
        try waitEcho(&h, "done_closed", before.done_closed + 1);
        try testing.expectEqual(before.peer_closed + 1, h.echo.snapshot().peer_closed);
        try testing.expectEqual(before.done_finished, h.echo.snapshot().done_finished);
    }
}

test "node_400: body bytes no parser reads, arriving while an async handler waits, are not data after the message" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    server_mod.test_node_400.store(true, .monotonic);
    defer server_mod.test_node_400.store(false, .monotonic);
    closeGate();
    defer openGate();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const before = h.echo.snapshot();
    var c = try h.connect();
    defer c.close();
    // GET: no parser, so the handler runs before its body arrives (TS: response only).
    try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\nConnection: close\r\nContent-Length: 5\r\n\r\n");
    try waitEcho(&h, "handled", before.handled + 1);
    try c.send("hello");
    std.Thread.sleep(30 * std.time.ns_per_ms);
    try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
    openGate();
    try testing.expectEqual(@as(u16, 200), (try c.read(arena.allocator(), false)).status);
    try testing.expect(c.closedByPeer());
    try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
}

test "pipelined keep-alive requests, then a half-close while the first waits: neither is answered" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    closeGate();
    defer openGate();
    const before = h.echo.snapshot();
    var c = try h.connect();
    defer c.close();
    try c.send("GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\nGET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitEcho(&h, "handled", before.handled + 1);
    const fins = server_mod.test_fin_hangups.load(.monotonic);
    try posix.shutdown(c.fd, .send);
    if (!finAborts()) {
        // reset_only: both are answered, then the server closes.
        try waitFinSeen(fins);
        openGate();
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        try testing.expectEqual(@as(u16, 200), (try c.read(arena.allocator(), false)).status);
        try testing.expectEqual(@as(u16, 200), (try c.read(arena.allocator(), false)).status);
        try testing.expect(c.closedByPeer());
        try testing.expectEqual(before.peer_closed, h.echo.snapshot().peer_closed);
        return;
    }
    try waitEcho(&h, "peer_closed", before.peer_closed + 1);
    openGate();
    try waitEcho(&h, "done_closed", before.done_closed + 1);
    try testing.expect(c.closedByPeer());
    try testing.expectEqual(@as(usize, 0), c.len);
    // The port never starts the second request (it is parsed only after the
    // first response). Node may have emitted it already: see the TS probe.
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try testing.expectEqual(before.handled + 1, h.echo.snapshot().handled);
}

test "a hangup that arrives with data during a slow request is not lost" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Keep-alive: a pipelined request plus the client's FIN reach the server
    // while it is busy. Node (httpAllowHalfOpen false) ends the socket on the
    // FIN, so neither response goes out (TS, measured): EOF only.
    var c = try h.connect();
    defer c.close();
    _ = try c.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    const before = h.echo.snapshot();
    try c.send("GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitEcho(&h, "handled", before.handled + 1);
    try c.send("GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try posix.shutdown(c.fd, .send);
    if (!finAborts()) {
        // reset_only: both are answered, then the server closes.
        try testing.expectEqual(@as(u16, 200), (try c.read(a, false)).status);
        try testing.expectEqual(@as(u16, 404), (try c.read(a, false)).status);
    }
    try testing.expect(c.closedByPeer());
    try testing.expectEqual(@as(usize, 0), c.len);
    // Upload: a partial body plus FIN behind a slow request: the slow one is
    // aborted (on_done(.closed)), nothing is answered.
    var c2 = try h.connect();
    defer c2.close();
    const before2 = h.echo.snapshot();
    try c2.send("GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitEcho(&h, "handled", before2.handled + 1);
    try c2.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    try posix.shutdown(c2.fd, .send);
    // reset_only: the slow one is answered; the cut-off upload never is.
    if (!finAborts()) try testing.expectEqual(@as(u16, 200), (try c2.read(a, false)).status);
    try testing.expect(c2.closedByPeer());
    try testing.expectEqual(@as(usize, 0), c2.len);
    try waitEcho(&h, "done_closed", before2.done_closed + 1);
    // WebSocket: a frame plus close behind a slow message handler -> on_close.
    var c3 = try h.connect();
    defer c3.close();
    _ = try wsHandshake(&c3, a, "/agents");
    try c3.send(try wsFrame(a, 0x1, "sleep-me", true, true));
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try c3.send(try wsFrame(a, 0x1, "x", true, true));
    try posix.shutdown(c3.fd, .send);
    try h.wse.waitCloses(1);
}

test "body_pending before on_request; on_write_blocked once when a response parks" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var c = try h.connect();
    defer c.close();
    _ = try c.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok");
    try testing.expect(!h.echo.snapshot().body_pending);
    _ = try c.request(a, "POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n");
    try testing.expect(!h.echo.snapshot().body_pending);
    const seen = h.echo.snapshot().on_request;
    try c.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nok");
    var waited: u32 = 0;
    while (h.echo.snapshot().on_request == seen and waited < 400) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expect(h.echo.snapshot().body_pending);
    try c.send("ok");
    _ = try c.read(a, false);
    // 16 MiB the client does not read yet: the write parks once.
    try c.send("GET /graphql?big HTTP/1.1\r\nHost: a\r\n\r\n");
    waited = 0;
    while (h.echo.snapshot().write_blocked == 0 and waited < 400) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, 1), h.echo.snapshot().write_blocked);
    var got: usize = 0;
    var buf: [256 * 1024]u8 = undefined;
    while (got < 16 * 1024 * 1024) {
        const n = try posix.read(c.fd, &buf);
        if (n == 0) return error.EndOfStream;
        got += n;
    }
    try testing.expectEqual(@as(u32, 1), h.echo.snapshot().write_blocked);
}

test "a handler on a poller has the stack of graphql's deepest admitted request (2x)" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /graphql?deep HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 200), r.status);
    try testing.expectEqualStrings("deep ok", r.body);
}

test "a handler's detached child fiber runs, parks and is reaped" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    for (0..3) |_| {
        const r = try c.request(arena.allocator(), "GET /graphql?spawn HTTP/1.1\r\nHost: a\r\n\r\n");
        try testing.expectEqualStrings("spawned", r.body);
    }
}

test "two loops share the listener: parked requests from many connections all complete" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{ .loops = 2 };
    try h.start(10_000);
    defer h.stop();
    const Worker = struct {
        fn run(port: u16, failures: *std.atomic.Value(u32)) void {
            const addr = std.net.Address.parseIp("127.0.0.1", port) catch return;
            var ar = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer ar.deinit();
            for (0..10) |_| {
                const stream = std.net.tcpConnectToAddress(addr) catch {
                    _ = failures.fetchAdd(1, .monotonic);
                    continue;
                };
                var cl: Client = .{ .fd = stream.handle };
                defer cl.close();
                for (0..5) |_| {
                    const r = cl.request(ar.allocator(), "GET /graphql?park HTTP/1.1\r\nHost: a\r\n\r\n") catch {
                        _ = failures.fetchAdd(1, .monotonic);
                        break;
                    };
                    if (r.status != 200) _ = failures.fetchAdd(1, .monotonic);
                }
            }
        }
    };
    var failures = std.atomic.Value(u32).init(0);
    var threads: [8]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Worker.run, .{ h.server.port(), &failures });
    for (threads) |t| t.join();
    try testing.expectEqual(@as(u32, 0), failures.load(.monotonic));
}

test "an fd number reused after a close behind the registry's back is registered again" {
    try fdReuse(.owned);
}

test "forgetClosedFd: a record whose socket closed elsewhere gives way to the number's next socket" {
    try fdReuse(.forget_closed);
}

/// A fiber waits on a socket; it closes without `forgetFd` and a new socket
/// takes its number. `.owned`: each socket's waits name their owner, so the
/// loop notices on its own. `.forget_closed`: unowned waits, with the
/// closer calling `forgetClosedFd`. Either way the new socket's wait wakes.
fn fdReuse(mode: enum { owned, forget_closed }) !void {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const nonblock = struct {
        fn set(fd: posix.fd_t) !void {
            const flags = try posix.fcntl(fd, posix.F.GETFL, 0);
            _ = try posix.fcntl(fd, posix.F.SETFL, flags | @as(usize, 1 << @bitOffsetOf(posix.O, "NONBLOCK")));
        }
    };
    // First owner: a fiber waits on the fd (the loop registers it).
    var a: [2]posix.socket_t = undefined;
    if (std.c.socketpair(posix.AF.UNIX, posix.SOCK.STREAM, 0, &a) != 0) return error.SocketPair;
    defer posix.close(a[1]);
    try nonblock.set(a[0]);
    const number = a[0];
    shared_fd.store(number, .release);
    if (mode == .owned) shared_owner.store(core.fiber.newOwner(), .release);
    defer {
        shared_fd.store(-1, .release);
        shared_owner.store(0, .release);
        core.fiber.forgetFd(number);
        posix.close(number);
    }
    var c = try h.connect();
    defer c.close();
    var seen = shared_parked.load(.acquire);
    try c.send("GET /graphql?shared HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitSharedParked(seen);
    _ = try posix.write(a[1], "x");
    try testing.expectEqualStrings("got", (try c.read(arena.allocator(), false)).body);
    // The owner's socket closes without forgetFd (as when libpq drops a
    // connection itself); a new socket takes the same number.
    var b: [2]posix.socket_t = undefined;
    if (std.c.socketpair(posix.AF.UNIX, posix.SOCK.STREAM, 0, &b) != 0) return error.SocketPair;
    defer posix.close(b[1]);
    try posix.dup2(b[0], number); // closes the old socket at `number`
    posix.close(b[0]);
    try nonblock.set(number);
    switch (mode) {
        .owned => shared_owner.store(core.fiber.newOwner(), .release),
        .forget_closed => core.fiber.forgetClosedFd(number),
    }
    // The new owner's wait must see its own socket's input.
    seen = shared_parked.load(.acquire);
    try c.send("GET /graphql?shared HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitSharedParked(seen);
    _ = try posix.write(b[1], "y");
    const t0 = std.time.milliTimestamp();
    try testing.expectEqualStrings("got", (try c.read(arena.allocator(), false)).body);
    try testing.expect(std.time.milliTimestamp() - t0 < 2_000);
}

test "readiness: an fd fibers waited on reports later input without a waiter" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var pair: [2]posix.socket_t = undefined;
    if (std.c.socketpair(posix.AF.UNIX, posix.SOCK.STREAM, 0, &pair) != 0) return error.SocketPair;
    defer posix.close(pair[1]);
    const flags = try posix.fcntl(pair[0], posix.F.GETFL, 0);
    _ = try posix.fcntl(pair[0], posix.F.SETFL, flags | @as(usize, 1 << @bitOffsetOf(posix.O, "NONBLOCK")));
    shared_fd.store(pair[0], .release);
    defer {
        shared_fd.store(-1, .release);
        core.fiber.forgetFd(pair[0]);
        posix.close(pair[0]);
    }
    // Not waited on yet: nothing watches it.
    try testing.expect(core.fiber.readiness(pair[0]) == null);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const seen = shared_parked.load(.acquire);
    try c.send("GET /graphql?shared HTTP/1.1\r\nHost: a\r\n\r\n");
    try waitSharedParked(seen);
    _ = try posix.write(pair[1], "x");
    try testing.expectEqualStrings("got", (try c.read(arena.allocator(), false)).body);
    const bits = core.fiber.readiness(pair[0]) orelse return error.NotRegistered;
    // The wait consumed its edge; nothing new yet.
    try testing.expect(!core.fiber.inputSeen(bits));
    // Input with no fiber waiting is still seen.
    _ = try posix.write(pair[1], "y");
    var waited: u32 = 0;
    while (!core.fiber.inputSeen(bits) and waited < 1000) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expect(core.fiber.inputSeen(bits));
}

test "two loops: a socket fibers wait on in turn follows the waiting loop" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{ .loops = 2 };
    try h.start(10_000);
    defer h.stop();
    var pair: [2]posix.socket_t = undefined;
    if (std.c.socketpair(posix.AF.UNIX, posix.SOCK.STREAM, 0, &pair) != 0) return error.SocketPair;
    defer posix.close(pair[1]);
    const flags = try posix.fcntl(pair[0], posix.F.GETFL, 0);
    _ = try posix.fcntl(pair[0], posix.F.SETFL, flags | @as(usize, 1 << @bitOffsetOf(posix.O, "NONBLOCK")));
    shared_fd.store(pair[0], .release);
    defer {
        shared_fd.store(-1, .release);
        core.fiber.forgetFd(pair[0]);
        posix.close(pair[0]);
    }
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Fresh connections land on either loop; each request waits on the
    // shared socket until the byte arrives.
    for (0..30) |_| {
        var c = try h.connect();
        defer c.close();
        const seen = shared_parked.load(.acquire);
        try c.send("GET /graphql?shared HTTP/1.1\r\nHost: a\r\n\r\n");
        try waitSharedParked(seen);
        _ = try posix.write(pair[1], "x");
        const r = try c.read(a, false);
        try testing.expectEqualStrings("got", r.body);
    }
}

test "blocked requests in one accept batch never hold up later accepts" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // A burst of connections whose requests block their pollers: several
    // land in one accept batch with their data already queued.
    const Slow = struct {
        fn run(port: u16, status: *u16) void {
            const addr = std.net.Address.parseIp("127.0.0.1", port) catch return;
            const stream = std.net.tcpConnectToAddress(addr) catch return;
            var cl: Client = .{ .fd = stream.handle };
            defer cl.close();
            var ar = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer ar.deinit();
            const r = cl.request(ar.allocator(), "GET /graphql?gated HTTP/1.1\r\nHost: a\r\n\r\n") catch return;
            status.* = r.status;
        }
    };
    closeGate();
    defer openGate();
    var threads: [24]std.Thread = undefined;
    var statuses = [_]u16{0} ** 24;
    for (&threads, &statuses) |*t, *st| t.* = try std.Thread.spawn(.{}, Slow.run, .{ h.server.port(), st });
    std.Thread.sleep(50 * std.time.ns_per_ms);
    var c = try h.connect();
    defer c.close();
    const r = try c.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    // The slow requests wait on the gate: the later accept was answered
    // while they all still waited (not after the gate's 3 s cap).
    try testing.expectEqual(@as(u32, 0), gated_done.load(.acquire));
    openGate();
    for (threads) |t| t.join();
    for (statuses) |st| try testing.expectEqual(@as(u16, 200), st);
}

test "requests behind a DB-style wait in the same batch are served promptly" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Keep-alive connections, so their next requests arrive as one batch.
    var slow: [6]Client = undefined;
    for (&slow) |*cl| cl.* = try h.connect();
    defer for (&slow) |*cl| cl.close();
    var fast = try h.connect();
    defer fast.close();
    for (&slow) |*cl| _ = try cl.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    _ = try fast.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    closeGate();
    defer openGate();
    for (&slow) |*cl| try cl.send("GET /graphql?gated-hooked HTTP/1.1\r\nHost: a\r\n\r\n");
    const r = try fast.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    // The hooked waits hold until the gate opens: nothing queued behind them.
    try testing.expectEqual(@as(u32, 0), gated_done.load(.acquire));
    openGate();
    for (&slow) |*cl| try testing.expectEqual(@as(u16, 200), (try cl.read(a, false)).status);
}

test "a steal racing the end of a stalled dispatch loses and repeats nothing" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    loop_mod.test_steal_delay_ns = 30 * std.time.ns_per_ms; // the stall ends mid-steal
    defer loop_mod.test_steal_delay_ns = 0;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Keep-alive sockets whose next requests land in one batch behind a stall.
    var cs: [12]posix.socket_t = undefined;
    for (&cs) |*fd| {
        var cl = try h.connect();
        _ = try cl.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        fd.* = cl.fd;
    }
    defer for (cs) |fd| posix.close(fd);
    for (0..5) |_| {
        for (cs, 0..) |fd, i| {
            const req: []const u8 = if (i == 0) "GET /graphql?stall HTTP/1.1\r\nHost: a\r\n\r\n" else "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n";
            if (!server_mod.blockingWriteForTests(fd, req)) return error.WriteFailed;
        }
        // Exactly one response each: none lost (a lost edge hangs the read),
        // none run twice (an extra response would desync the next round).
        for (cs, 0..) |fd, i| {
            var cl: Client = .{ .fd = fd };
            const r = try cl.read(a, false);
            try testing.expectEqual(@as(u16, if (i == 0) 200 else 404), r.status);
            try testing.expectEqual(@as(usize, 0), cl.len);
        }
    }
}

test "close() while upgrades are in flight never treats a WebSocket as HTTP" {
    var h: Harness = .{};
    try h.start(10_000);
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const Upgrader = struct {
        fn run(port: u16) void {
            const addr = std.net.Address.parseIp("127.0.0.1", port) catch return;
            for (0..20) |_| {
                const stream = std.net.tcpConnectToAddress(addr) catch return;
                defer stream.close();
                _ = server_mod.blockingWriteForTests(stream.handle, "GET /agents HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
            }
        }
    };
    var threads: [8]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Upgrader.run, .{h.server.port()});
    std.Thread.sleep(5 * std.time.ns_per_ms);
    h.server.close(1_000);
    for (threads) |t| t.join();
    h.stop(); // a WebSocket destroyed as an HTTP Connection would corrupt memory here
}

test "pollers settle back to one soon after a burst of blocked requests" {
    // Thread hand-off model only: fiber mode pins one thread, no monitor.
    if (server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    // Blocked requests make the monitor hand off: extra pollers start.
    const Slow = struct {
        fn run(port: u16) void {
            const addr = std.net.Address.parseIp("127.0.0.1", port) catch return;
            const stream = std.net.tcpConnectToAddress(addr) catch return;
            var cl: Client = .{ .fd = stream.handle };
            defer cl.close();
            var ar = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer ar.deinit();
            _ = cl.request(ar.allocator(), "GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n") catch return;
        }
    };
    var threads: [8]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Slow.run, .{h.server.port()});
    for (threads) |t| t.join();
    const loop = &h.server.loop.loops[0];
    loop.mutex.lock();
    const peak = loop.threads;
    loop.mutex.unlock();
    try testing.expect(peak > 1);
    var waited: u32 = 0;
    while (waited < 600) : (waited += 1) {
        loop.mutex.lock();
        const now = loop.threads;
        loop.mutex.unlock();
        if (now == 1 and !loop.monitor_running.load(.acquire)) break;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    // Idle exit is 1 s (+ the 50 ms spare linger, + the monitor's 1 s quiet).
    try testing.expect(waited < 300);
}

test "the stall monitor thread starts (pthread stack minimum on Linux)" {
    // Thread hand-off model only: fiber mode pins one thread, no monitor.
    if (server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    // The first dispatch spawns the monitor; a spawn failure would assert
    // (Zig asserts pthread_attr_setstacksize) or leave it stopped.
    _ = try c.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expect(h.server.loop.loops[0].monitor_running.load(.acquire));
}

test "the first unhooked stall after an idle second is handed off promptly" {
    // Thread hand-off model only: fiber mode pins one thread, no monitor.
    if (server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var w = try h.connect();
    defer w.close();
    _ = try wsHandshake(&w, a, "/agents");
    // Idle long enough for the stall monitor to exit.
    std.Thread.sleep(1_500 * std.time.ns_per_ms);
    // A handler blocks its poller without core.blocking (like live's loop mutex).
    try w.send(try wsFrame(a, 0x1, "sleep-me", true, true));
    std.Thread.sleep(20 * std.time.ns_per_ms);
    const t0 = std.time.milliTimestamp();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    const took = std.time.milliTimestamp() - t0;
    try testing.expectEqual(@as(u16, 404), r.status);
    // The handler sleeps 300 ms; a hand-off answers before it wakes.
    try testing.expect(took < 300);
}

test "close() ends idle keep-alive sockets with FIN; a request mid-head still gets 503" {
    var h: Harness = .{};
    try h.start(10_000);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Only fds: a Client carries a 256 KiB buffer.
    const idle_parks = server_mod.test_idle_parks.load(.acquire);
    var idle: [200]posix.socket_t = undefined;
    for (&idle) |*fd| {
        var cl = try h.connect();
        _ = try cl.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        fd.* = cl.fd;
    }
    defer for (idle) |fd| posix.close(fd);
    var mid = try h.connect();
    defer mid.close();
    _ = try mid.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    const head_parks = server_mod.test_head_parks.load(.acquire);
    try mid.send("GET /nope HTTP/1.1\r\n");
    // All parked: 200 idle keep-alive sockets plus `mid`, which read its
    // partial head first (else close() would still see it idle).
    var parked_waited: u32 = 0;
    while (server_mod.test_head_parks.load(.acquire) == head_parks or server_mod.test_idle_parks.load(.acquire) -% idle_parks < 201) : (parked_waited += 1) {
        if (parked_waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const Closer = struct {
        fn run(server: *server_mod.Server) void {
            server.close(2_000);
        }
    };
    const closer = try std.Thread.spawn(.{}, Closer.run, .{h.server});
    // Idle sockets: a clean EOF (FIN, no bytes, no reset).
    for (idle) |fd| {
        var buf: [16]u8 = undefined;
        var fds = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
        try testing.expect(try posix.poll(&fds, 2_000) == 1);
        try testing.expectEqual(@as(usize, 0), try posix.read(fd, &buf));
    }
    // The request in progress completes with Fastify's 503 and a close.
    try mid.send("Host: a\r\n\r\n");
    const r = try mid.read(a, false);
    try testing.expectEqual(@as(u16, 503), r.status);
    try testing.expect(mid.closedByPeer());
    closer.join();
    h.stop();
}

/// A handler that reads like libpq: at most 16 KiB per wakeup, waiting with
/// `core.fiber.waitFd` (on a fiber when `server.fibers`).
const ChunkReader = struct {
    fn handler(_: *anyopaque, req: *types.Request, reply: *types.Reply) void {
        var pair: [2]posix.socket_t = undefined;
        if (std.c.socketpair(posix.AF.UNIX, posix.SOCK.STREAM, 0, &pair) != 0) return reply.sendText("socketpair failed");
        defer posix.close(pair[0]);
        const total = 8 * 1024 * 1024;
        const Writer = struct {
            fn run(fd: posix.socket_t) void {
                defer posix.close(fd);
                var chunk: [64 * 1024]u8 = undefined;
                @memset(&chunk, 'w');
                var sent: usize = 0;
                while (sent < total) sent += posix.write(fd, chunk[0..@min(chunk.len, total - sent)]) catch return;
            }
        };
        const t = std.Thread.spawn(.{}, Writer.run, .{pair[1]}) catch return reply.sendText("spawn failed");
        defer t.join();
        defer core.fiber.forgetFd(pair[0]);
        const flags = posix.fcntl(pair[0], posix.F.GETFL, 0) catch 0;
        _ = posix.fcntl(pair[0], posix.F.SETFL, flags | @as(usize, 1 << @bitOffsetOf(posix.O, "NONBLOCK"))) catch {};
        var got: usize = 0;
        var buf: [16 * 1024]u8 = undefined;
        while (got < total) {
            const n = posix.read(pair[0], &buf) catch |e| switch (e) {
                error.WouldBlock => {
                    if (core.fiber.inFiber()) {
                        core.fiber.waitFd(pair[0], core.fiber.Events.read, core.fiber.monoMs() + 10_000) catch return reply.sendText("timeout");
                    } else {
                        var fds = [_]posix.pollfd{.{ .fd = pair[0], .events = posix.POLL.IN, .revents = 0 }};
                        _ = posix.poll(&fds, 10_000) catch {};
                    }
                    continue;
                },
                else => return reply.sendText("read failed"),
            };
            if (n == 0) break;
            got += n;
            // Like PQconsumeInput: one read per wakeup, then wait again.
            if (core.fiber.inFiber()) core.fiber.waitFd(pair[0], core.fiber.Events.read, core.fiber.monoMs() + 10_000) catch return reply.sendText("timeout");
        }
        reply.sendText(std.fmt.allocPrint(req.arena, "{d}", .{got}) catch "oom");
    }
};

test "a fiber reading 8 MiB at 16 KiB per wake completes (level check before parking)" {
    var dummy: u8 = 0;
    const routes = [_]types.Route{.{ .methods = &.{"GET"}, .path = "/read", .ctx = &dummy, .hooks = .{ .handler = ChunkReader.handler } }};
    const server = try server_mod.Server.init(testing.allocator, .{ .host = "127.0.0.1", .port = 0, .routes = &routes });
    try server.start();
    defer server.deinit();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const stream = try std.net.tcpConnectToAddress(try std.net.Address.parseIp("127.0.0.1", server.port()));
    var c: Client = .{ .fd = stream.handle };
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /read HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqualStrings("8388608", r.body);
}

test "late requests during close get 503" {
    var h: Harness = .{};
    try h.start(10_000);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const idle_parks = server_mod.test_idle_parks.load(.acquire);
    var c = try h.connect();
    defer c.close();
    // Start a request so the connection is busy, then close the server.
    try c.send("GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    _ = try c.read(arena.allocator(), false);
    // Let the server reach its keep-alive wait first: a socket still on
    // its way back to idle when close() begins is ended instead (as Node's
    // close() ends idle sockets).
    var idle_waited: u32 = 0;
    while (server_mod.test_idle_parks.load(.acquire) == idle_parks) : (idle_waited += 1) {
        if (idle_waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.server.closing.store(true, .release);
    const r = try c.request(arena.allocator(), "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 503), r.status);
    try testing.expectEqualStrings("{\"error\":\"Service Unavailable\",\"message\":\"Service Unavailable\",\"statusCode\":503}", r.body);
    h.server.closing.store(false, .release);
    h.stop();
}

test "an upgrade request while the server is closing gets the closing 503, like any request (TS: no 'upgrade' listener)" {
    var h: Harness = .{};
    try h.start(10_000);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const idle_parks = server_mod.test_idle_parks.load(.acquire);
    var c = try h.connect();
    defer c.close();
    // A keep-alive connection that is idle when close() begins (as in the
    // late-request test), then sends an upgrade request.
    _ = try c.request(a, "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    var idle_waited: u32 = 0;
    while (server_mod.test_idle_parks.load(.acquire) == idle_parks) : (idle_waited += 1) {
        if (idle_waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.server.closing.store(true, .release);
    const r = try c.request(a, "GET /agents HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    try testing.expectEqual(@as(u16, 503), r.status);
    try testing.expectEqualStrings("{\"error\":\"Service Unavailable\",\"message\":\"Service Unavailable\",\"statusCode\":503}", r.body);
    try expectHeader(r, "connection", "close");
    try testing.expect(c.closedByPeer());
    h.server.closing.store(false, .release);
    h.stop();
}

test "beginClose: requests get the 503 while the listener accepts; upgrades reach the owner until it removes its listener; waitUpgraded counts open WebSockets" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const upgrade = "GET /agents HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
    // An open WebSocket, as TS's clients when preClose begins.
    var w = try h.connect();
    defer w.close();
    try testing.expectEqual(@as(u16, 101), (try wsHandshake(&w, a, "/agents")).status);
    h.server.beginClose();
    // New connections are still accepted: plain requests get the 503.
    var c = try h.connect();
    defer c.close();
    try testing.expectEqual(@as(u16, 503), (try c.request(a, "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n")).status);
    try testing.expect(c.closedByPeer());
    // TS's stop() is still awaiting (its listener is on): an upgrade reaches the owner.
    var u = try h.connect();
    defer u.close();
    try u.send(upgrade);
    try testing.expectEqual(@as(u16, 101), (try u.read(a, true)).status);
    // Listener removed: Node routes the upgrade like any request.
    h.wse.upgrade_removed.store(true, .release);
    defer h.wse.upgrade_removed.store(false, .release);
    var r = try h.connect();
    defer r.close();
    try testing.expectEqual(@as(u16, 503), (try r.request(a, upgrade)).status);
    // Two WebSockets open: the wait times out with both counted.
    try testing.expectEqual(@as(u32, 2), h.server.waitUpgraded(100));
    // Their close handshakes complete: the wait returns 0.
    try w.send(try wsFrame(a, 0x8, &.{ 0x03, 0xe8 }, true, true));
    try u.send(try wsFrame(a, 0x8, &.{ 0x03, 0xe8 }, true, true));
    try testing.expectEqual(@as(u32, 0), h.server.waitUpgraded(5_000));
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const reject_response = "HTTP/1.1 429 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const reject_big_len = 8 * 1024 * 1024;

test "close() returns while an endWith write is parked, and the write still completes" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    const fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM, 0);
    defer posix.close(fd);
    try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.RCVBUF, &std.mem.toBytes(@as(c_int, 4096)));
    const addr = try std.net.Address.parseIp("127.0.0.1", h.server.port());
    try posix.connect(fd, &addr.any, addr.getOsSockLen());
    var slow: Client = .{ .fd = fd };
    const write_parks = server_mod.test_write_parks.load(.acquire);
    try slow.send("GET /reject-big HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    // The endWith write parked on the full window.
    var write_waited: u32 = 0;
    while (server_mod.test_write_parks.load(.acquire) == write_parks) : (write_waited += 1) {
        if (write_waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // Like an in-flight response: close() waits for it until its timeout.
    const t0 = std.time.milliTimestamp();
    h.server.close(300);
    const waited = std.time.milliTimestamp() - t0;
    try testing.expect(waited >= 250 and waited < 3_000);
    // The parked write is intact: reading drains it, then EOF, so deinit
    // (`h.stop`) finds no connection left.
    try setRecvTimeout(fd);
    var buf: [64 * 1024]u8 = undefined;
    var total: usize = 0;
    while (true) {
        const n = try posix.read(fd, &buf);
        if (n == 0) break;
        total += n;
    }
    try testing.expectEqual(@as(usize, reject_big_len), total);
}

test "endWith never blocks the loop on a client that stops reading" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    // A client with a tiny receive window that does not read yet: the
    // server's write has to wait for it.
    const fd = try posix.socket(posix.AF.INET, posix.SOCK.STREAM, 0);
    defer posix.close(fd);
    try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.RCVBUF, &std.mem.toBytes(@as(c_int, 4096)));
    const addr = try std.net.Address.parseIp("127.0.0.1", h.server.port());
    try posix.connect(fd, &addr.any, addr.getOsSockLen());
    var slow: Client = .{ .fd = fd };
    try slow.send("GET /reject-big HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    std.Thread.sleep(100 * std.time.ns_per_ms);
    // The loop still serves others while that write waits.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    // Reading now drains every byte, then EOF (FIN, then destroy).
    try setRecvTimeout(fd);
    var buf: [64 * 1024]u8 = undefined;
    var total: usize = 0;
    while (true) {
        const n = try posix.read(fd, &buf);
        if (n == 0) break;
        for (buf[0..n]) |b| try testing.expectEqual(@as(u8, 'r'), b);
        total += n;
    }
    try testing.expectEqual(@as(usize, reject_big_len), total);
}

test "an upgrade rejected with endWith gets exactly those bytes, then EOF" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var c = try h.connect();
    defer c.close();
    try c.send("GET /reject HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    try setRecvTimeout(c.fd);
    var buf: [256]u8 = undefined;
    var len: usize = 0;
    while (true) {
        const n = try posix.read(c.fd, buf[len..]);
        if (n == 0) break;
        len += n;
    }
    try testing.expectEqualStrings(reject_response, buf[0..len]);
}

fn wsHandshake(c: *Client, a: std.mem.Allocator, path: []const u8) !Response {
    const req = try std.fmt.allocPrint(a, "GET {s} HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", .{path});
    try c.send(req);
    return c.read(a, true);
}

fn wsFrame(a: std.mem.Allocator, opcode: u8, payload: []const u8, masked: bool, fin: bool) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(a, (if (fin) @as(u8, 0x80) else 0) | opcode);
    const mask_bit: u8 = if (masked) 0x80 else 0;
    if (payload.len < 126) {
        try out.append(a, mask_bit | @as(u8, @intCast(payload.len)));
    } else if (payload.len <= 0xffff) {
        try out.append(a, mask_bit | 126);
        var len: [2]u8 = undefined;
        std.mem.writeInt(u16, &len, @intCast(payload.len), .big);
        try out.appendSlice(a, &len);
    } else {
        try out.append(a, mask_bit | 127);
        var len: [8]u8 = undefined;
        std.mem.writeInt(u64, &len, payload.len, .big);
        try out.appendSlice(a, &len);
    }
    const mask = [4]u8{ 1, 2, 3, 4 };
    if (masked) try out.appendSlice(a, &mask);
    for (payload, 0..) |b, i| try out.append(a, if (masked) b ^ mask[i % 4] else b);
    return out.items;
}

/// Reads one unmasked server frame.
fn wsRead(c: *Client) !struct { opcode: u8, payload: []const u8 } {
    while (c.len < 2) if (try c.fill() == 0) return error.EndOfStream;
    var hlen: usize = 2;
    var len: usize = c.buf[1] & 0x7f;
    if (len == 126) {
        while (c.len < 4) if (try c.fill() == 0) return error.EndOfStream;
        len = std.mem.readInt(u16, c.buf[2..4], .big);
        hlen = 4;
    } else if (len == 127) {
        while (c.len < 10) if (try c.fill() == 0) return error.EndOfStream;
        len = @intCast(std.mem.readInt(u64, c.buf[2..10], .big));
        hlen = 10;
    }
    while (c.len < hlen + len) if (try c.fill() == 0) return error.EndOfStream;
    const opcode = c.buf[0] & 0x0f;
    const payload = try testing.allocator.dupe(u8, c.buf[hlen .. hlen + len]);
    std.mem.copyForwards(u8, c.buf[0 .. c.len - hlen - len], c.buf[hlen + len .. c.len]);
    c.len -= hlen + len;
    return .{ .opcode = opcode, .payload = payload };
}

test "websocket: handshake, echo, ping/pong, server close handshake" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const hs = try wsHandshake(&c, a, "/agents");
    try testing.expectEqualStrings("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n", hs.head);
    try c.send(try wsFrame(a, 0x1, "hello", true, true));
    const echo = try wsRead(&c);
    defer testing.allocator.free(echo.payload);
    try testing.expectEqual(@as(u8, 0x1), echo.opcode);
    try testing.expectEqualStrings("hello", echo.payload);
    // Fragmented text with an interleaved ping (auto-pong).
    try c.send(try wsFrame(a, 0x1, "fra", true, false));
    try c.send(try wsFrame(a, 0x9, "p", true, true));
    try c.send(try wsFrame(a, 0x0, "gment", true, true));
    const pong = try wsRead(&c);
    defer testing.allocator.free(pong.payload);
    try testing.expectEqual(@as(u8, 0xA), pong.opcode);
    try testing.expectEqualStrings("p", pong.payload);
    const joined = try wsRead(&c);
    defer testing.allocator.free(joined.payload);
    try testing.expectEqualStrings("fragment", joined.payload);
    // Server ping -> client pong -> on_pong.
    try c.send(try wsFrame(a, 0x1, "ping-me", true, true));
    const ping = try wsRead(&c);
    defer testing.allocator.free(ping.payload);
    try testing.expectEqual(@as(u8, 0x9), ping.opcode);
    try c.send(try wsFrame(a, 0xA, "", true, true));
    // Server-initiated close: close frame with code + reason, then we echo.
    try c.send(try wsFrame(a, 0x1, "close-me", true, true));
    const close = try wsRead(&c);
    defer testing.allocator.free(close.payload);
    try testing.expectEqual(@as(u8, 0x8), close.opcode);
    try testing.expectEqual(@as(u16, 1008), std.mem.readInt(u16, close.payload[0..2], .big));
    try testing.expectEqualStrings("Invalid subscription", close.payload[2..]);
    try c.send(try wsFrame(a, 0x8, close.payload, true, true));
    try h.wse.waitCloses(1);
    try testing.expect(c.closedByPeer());
    h.wse.mutex.lock();
    defer h.wse.mutex.unlock();
    try testing.expectEqual(@as(u16, 1008), h.wse.closes.items[0]);
    try testing.expectEqual(@as(u32, 1), h.wse.pongs);
}

test "websocket: a frame sent during the upgrade follows the 101; terminate still answers 101" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const hs = try wsHandshake(&c, a, "/greet");
    try testing.expectEqual(@as(u16, 101), hs.status);
    const f = try wsRead(&c);
    defer testing.allocator.free(f.payload);
    try testing.expectEqualStrings("ready", f.payload);
    // `ws` writes the 101 before handlers can destroy the socket.
    var c2 = try h.connect();
    defer c2.close();
    const hs2 = try wsHandshake(&c2, a, "/kill");
    try testing.expectEqual(@as(u16, 101), hs2.status);
    try testing.expect(c2.closedByPeer());
}

test "websocket: a short write inside the pending 101 keeps 101 then the frame in order" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const hs = try wsHandshake(&c, a, "/short");
    try testing.expectEqualStrings("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n", hs.head);
    const f = try wsRead(&c);
    defer testing.allocator.free(f.payload);
    try testing.expectEqual(@as(u8, 0x1), f.opcode);
    try testing.expectEqualStrings("ready", f.payload);
    h.wse.mutex.lock();
    defer h.wse.mutex.unlock();
    try testing.expect(h.wse.short_busy);
}

test "accepted sockets have TCP_NODELAY (inherited from the listener on Linux)" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, arena_state.allocator());
    defer conn.release();
    var value: c_int = 0;
    var len: posix.socklen_t = @sizeOf(c_int);
    try testing.expectEqual(@as(c_int, 0), std.c.getsockopt(conn.fd, posix.IPPROTO.TCP, posix.TCP.NODELAY, @ptrCast(&value), &len));
    try testing.expect(value != 0);
}

/// An owner that applies reader-side transitions under its own "tick" lock,
/// as live does with its loop mutex.
const TickOwner = struct {
    wss: ws.Server = .{ .options = .{ .max_payload = 4096, .close_timeout_ms = 300 } },
    tick: std.Thread.Mutex = .{},
    mutex: std.Thread.Mutex = .{},
    events: std.ArrayList(u8) = .empty,
    conn: ?*ws.Conn = null,
    closed: bool = false,

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *TickOwner = @ptrCast(@alignCast(ctx));
        const conn = self.wss.handleUpgrade(testing.allocator, req, socket, .{
            .ctx = self,
            .on_message = onMessage,
            .on_error = onError,
            .on_close = onClose,
            .transition = onTransition,
        }) orelse return;
        self.mutex.lock();
        self.conn = conn;
        self.mutex.unlock();
    }

    fn record(self: *TickOwner, c: u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.events.append(testing.allocator, c) catch {};
    }

    fn onMessage(ctx: *anyopaque, conn: *ws.Conn, data: []const u8, _: bool) void {
        const self: *TickOwner = @ptrCast(@alignCast(ctx));
        if (std.mem.eql(u8, data, "fail-close")) return conn.close(1000, "");
        self.record('m');
    }
    fn onError(ctx: *anyopaque, _: *ws.Conn, _: []const u8) void {
        @as(*TickOwner, @ptrCast(@alignCast(ctx))).record('e');
    }
    fn onClose(ctx: *anyopaque, conn: *ws.Conn, _: u16, _: []const u8) void {
        const self: *TickOwner = @ptrCast(@alignCast(ctx));
        self.record('c');
        self.mutex.lock();
        self.closed = true;
        self.mutex.unlock();
        conn.release();
    }
    fn onTransition(ctx: *anyopaque, conn: *ws.Conn, event: ws.Transition) void {
        const self: *TickOwner = @ptrCast(@alignCast(ctx));
        self.tick.lock(); // waits for the current "tick" to end
        defer self.tick.unlock();
        self.record(switch (event) {
            .close_frame => 'F',
            .receiver_error => 'R',
            .eof, .reset => 'E',
            .close_timeout => 'T',
        });
        conn.applyTransition(event);
    }

    fn waitClosed(self: *TickOwner) !void {
        var waited: u32 = 0;
        while (waited < 300) : (waited += 1) {
            self.mutex.lock();
            const done = self.closed;
            self.mutex.unlock();
            if (done) return;
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        return error.Timeout;
    }

    fn eventsEqual(self: *TickOwner, want: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try testing.expectEqualStrings(want, self.events.items);
    }
};

fn tickHarness(owner: *TickOwner) !*server_mod.Server {
    const server = try server_mod.Server.init(testing.allocator, .{ .host = "127.0.0.1", .port = 0, .upgrade = .{ .ctx = owner, .on_upgrade = TickOwner.onUpgrade } });
    try server.start();
    return server;
}

fn tickConnect(server: *server_mod.Server, owner: *TickOwner, a: std.mem.Allocator) !Client {
    const addr = try std.net.Address.parseIp("127.0.0.1", server.port());
    const stream = try std.net.tcpConnectToAddress(addr);
    var c: Client = .{ .fd = stream.handle };
    _ = try wsHandshake(&c, a, "/agents");
    var waited: u32 = 0;
    while (waited < 5_000) : (waited += 1) {
        owner.mutex.lock();
        const ready = owner.conn != null;
        owner.mutex.unlock();
        if (ready) return c;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
}

test "websocket transitions: a peer close lands after the owner's tick, whose frames all go out" {
    var owner: TickOwner = .{};
    defer owner.events.deinit(testing.allocator);
    const server = try tickHarness(&owner);
    defer server.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try tickConnect(server, &owner, a);
    defer c.close();
    const conn = owner.conn.?;
    // A tick is running: the client's close frame arrives meanwhile.
    owner.tick.lock();
    try c.send(try wsFrame(a, 0x8, &.{ 0x03, 0xe8 }, true, true));
    std.Thread.sleep(50 * std.time.ns_per_ms);
    // Still OPEN inside the tick: frames sent now are written, like Node's.
    try testing.expectEqual(ws.ReadyState.open, conn.readyState());
    try conn.send("in-tick", false, null);
    owner.tick.unlock();
    const f = try wsRead(&c);
    defer testing.allocator.free(f.payload);
    try testing.expectEqualStrings("in-tick", f.payload);
    const echo = try wsRead(&c);
    defer testing.allocator.free(echo.payload);
    try testing.expectEqual(@as(u8, 0x8), echo.opcode);
    posix.shutdown(c.fd, .send) catch {};
    try owner.waitClosed();
    try owner.eventsEqual("FEc");
}

test "websocket transitions: protocol errors, EOF and the close timeout go through the hook" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    {
        // Receiver error: transition, then 'error' (outside the hook), then close.
        var owner: TickOwner = .{};
        defer owner.events.deinit(testing.allocator);
        const server = try tickHarness(&owner);
        defer server.deinit();
        var c = try tickConnect(server, &owner, a);
        defer c.close();
        try c.send(try wsFrame(a, 0x1, "x", false, true)); // unmasked
        const close = try wsRead(&c);
        defer testing.allocator.free(close.payload);
        try testing.expectEqual(@as(u8, 0x8), close.opcode);
        posix.shutdown(c.fd, .send) catch {};
        try owner.waitClosed();
        try owner.eventsEqual("ReEc");
    }
    {
        // EOF without a close frame.
        var owner: TickOwner = .{};
        defer owner.events.deinit(testing.allocator);
        const server = try tickHarness(&owner);
        defer server.deinit();
        var c = try tickConnect(server, &owner, a);
        c.close();
        try owner.waitClosed();
        try owner.eventsEqual("Ec");
    }
    {
        // Our close is never answered: the close timeout terminates.
        var owner: TickOwner = .{};
        defer owner.events.deinit(testing.allocator);
        const server = try tickHarness(&owner);
        defer server.deinit();
        var c = try tickConnect(server, &owner, a);
        defer c.close();
        try c.send(try wsFrame(a, 0x1, "fail-close", true, true));
        try owner.waitClosed();
        try owner.eventsEqual("Tc");
    }
}

/// Many sockets, one owner "tick" lock shared by sends and the transition
/// hook (live's loop mutex), clients closing every way at once.
const StressOwner = struct {
    wss: ws.Server = .{ .options = .{ .max_payload = 4096, .close_timeout_ms = 300 } },
    tick: std.Thread.Mutex = .{},
    mutex: std.Thread.Mutex = .{},
    conns: std.ArrayList(*ws.Conn) = .empty,
    closed: std.atomic.Value(u32) = .init(0),
    stop: std.atomic.Value(bool) = .init(false),

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *StressOwner = @ptrCast(@alignCast(ctx));
        const conn = self.wss.handleUpgrade(testing.allocator, req, socket, .{
            .ctx = self,
            .on_message = onMessage,
            .on_close = onClose,
            .transition = onTransition,
        }) orelse return;
        self.mutex.lock();
        defer self.mutex.unlock();
        self.conns.append(testing.allocator, conn) catch conn.terminate();
    }
    fn onMessage(_: *anyopaque, _: *ws.Conn, _: []const u8, _: bool) void {}
    fn onClose(ctx: *anyopaque, _: *ws.Conn, _: u16, _: []const u8) void {
        _ = @as(*StressOwner, @ptrCast(@alignCast(ctx))).closed.fetchAdd(1, .monotonic);
    }
    fn onTransition(ctx: *anyopaque, conn: *ws.Conn, event: ws.Transition) void {
        const self: *StressOwner = @ptrCast(@alignCast(ctx));
        self.tick.lock();
        defer self.tick.unlock();
        conn.applyTransition(event);
    }
    fn ignore(_: *anyopaque, _: *ws.Conn, _: bool) void {}

    /// Ticks: under the lock, write to every socket and sometimes close one.
    fn run(self: *StressOwner) void {
        var prng = std.Random.DefaultPrng.init(42);
        const rand = prng.random();
        const cb: ws.SendCallback = .{ .ctx = self, .func = ignore };
        while (!self.stop.load(.acquire)) {
            self.tick.lock();
            self.mutex.lock();
            const conns = self.conns.items;
            for (conns) |conn| {
                _ = conn.sendInlineCorked(&.{ "tick-a", "tick-b" }, false, &.{ cb, cb }, 2) catch {};
                _ = conn.snapshot();
                switch (rand.uintLessThan(u32, 200)) {
                    0 => conn.close(1000, "owner"),
                    1 => conn.terminate(),
                    else => {},
                }
            }
            self.mutex.unlock();
            self.tick.unlock();
            std.Thread.sleep(200 * std.time.ns_per_us);
        }
    }
};

test "websocket transitions: no deadlock between the owner's tick and reader transitions (stress)" {
    var owner: StressOwner = .{};
    const server = try server_mod.Server.init(testing.allocator, .{ .host = "127.0.0.1", .port = 0, .upgrade = .{ .ctx = &owner, .on_upgrade = StressOwner.onUpgrade } });
    try server.start();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const n = 64;
    var fds: [n]posix.socket_t = undefined;
    for (&fds) |*fd| {
        const stream = try std.net.tcpConnectToAddress(try std.net.Address.parseIp("127.0.0.1", server.port()));
        var c: Client = .{ .fd = stream.handle };
        _ = try wsHandshake(&c, a, "/agents");
        fd.* = stream.handle;
    }
    var connect_waited: u32 = 0;
    while (true) : (connect_waited += 1) {
        owner.mutex.lock();
        const ready = owner.conns.items.len;
        owner.mutex.unlock();
        if (ready == n) break;
        if (connect_waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const ticker = try std.Thread.spawn(.{}, StressOwner.run, .{&owner});
    std.Thread.sleep(100 * std.time.ns_per_ms);
    // Clients end every way while ticks keep writing.
    const close_frame = try wsFrame(a, 0x8, &.{ 0x03, 0xe8 }, true, true);
    const garbage = try wsFrame(a, 0x1, "x", false, true); // unmasked: protocol error
    for (fds, 0..) |fd, i| switch (i % 3) {
        0 => _ = server_mod.blockingWriteForTests(fd, close_frame),
        1 => _ = server_mod.blockingWriteForTests(fd, garbage),
        else => {
            posix.close(fd);
            fds[i] = -1;
        },
    };
    // Drain what the server writes and end the rest, so every socket closes.
    std.Thread.sleep(100 * std.time.ns_per_ms);
    for (&fds) |*fd| if (fd.* >= 0) {
        posix.close(fd.*);
        fd.* = -1;
    };
    var waited: u32 = 0;
    while (owner.closed.load(.monotonic) < n and waited < 500) : (waited += 1) std.Thread.sleep(10 * std.time.ns_per_ms);
    owner.stop.store(true, .release);
    ticker.join();
    try testing.expectEqual(@as(u32, n), owner.closed.load(.monotonic));
    for (owner.conns.items) |conn| conn.release();
    owner.conns.deinit(testing.allocator);
    server.deinit();
}

fn wsEvents(h: *Harness, a: std.mem.Allocator) ![]u8 {
    h.wse.mutex.lock();
    defer h.wse.mutex.unlock();
    return a.dupe(u8, h.wse.events.items);
}

test "websocket read batches: one read's frames share one on_read_begin/on_read_end, closed before on_close" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    // Message, pong, message, ping (auto-pong, no callback) and a close frame
    // in one write: one batch around all of them, then on_close.
    var c = try h.connect();
    defer c.close();
    _ = try wsHandshake(&c, a, "/batch");
    var one: std.ArrayList(u8) = .empty;
    try one.appendSlice(a, try wsFrame(a, 0x1, "a", true, true));
    try one.appendSlice(a, try wsFrame(a, 0xA, "", true, true));
    try one.appendSlice(a, try wsFrame(a, 0x1, "b", true, true));
    try one.appendSlice(a, try wsFrame(a, 0x9, "", true, true));
    try one.appendSlice(a, try wsFrame(a, 0x8, &.{ 0x03, 0xe8 }, true, true));
    try c.send(one.items);
    try h.wse.waitCloses(1);
    // The close frame's transition is inside the batch; the close timeout's
    // (the client never closes) comes after it, outside.
    try testing.expectEqualStrings("BmpmtEtc", try wsEvents(&h, a));
}

test "websocket read batches: a protocol error mid-read reports on_error inside the batch" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    _ = try wsHandshake(&c, a, "/batch");
    // A message, then an unmasked client frame (protocol error), in one write.
    var one: std.ArrayList(u8) = .empty;
    try one.appendSlice(a, try wsFrame(a, 0x1, "a", true, true));
    try one.appendSlice(a, try wsFrame(a, 0x1, "x", false, true));
    try c.send(one.items);
    try h.wse.waitCloses(1);
    // `fail`: the receiver-error transition, then on_error, both inside; the
    // close timeout's transition comes after, outside.
    try testing.expectEqualStrings("BmteEtc", try wsEvents(&h, a));
}

fn waitWsEvents(h: *Harness, a: std.mem.Allocator, want: []const u8) !void {
    var waited: u32 = 0;
    while (!std.mem.eql(u8, try wsEvents(h, a), want)) : (waited += 1) {
        if (waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

test "websocket read batches: separate reads are separate batches; a read without callbacks opens none; EOF is outside" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    _ = try wsHandshake(&c, a, "/batch");
    // Two reads (the second sent once the first was handled): two batches.
    try c.send(try wsFrame(a, 0x1, "a", true, true));
    try waitWsEvents(&h, a, "BmE");
    testing.allocator.free((try wsRead(&c)).payload); // echo of "a"
    try c.send(try wsFrame(a, 0x1, "b", true, true));
    try waitWsEvents(&h, a, "BmEBmE");
    testing.allocator.free((try wsRead(&c)).payload);
    // A lone ping: auto-pong, no callback, so no batch.
    try c.send(try wsFrame(a, 0x9, "", true, true));
    const pong = try wsRead(&c);
    defer testing.allocator.free(pong.payload);
    try testing.expectEqual(@as(u8, 0xA), pong.opcode);
    try c.send(try wsFrame(a, 0x1, "c", true, true));
    try waitWsEvents(&h, a, "BmEBmEBmE");
    // EOF: the reader's eof transition is outside any batch.
    try posix.shutdown(c.fd, .send);
    try h.wse.waitCloses(1);
    try testing.expectEqualStrings("BmEBmEBmEtc", try wsEvents(&h, a));
}

test "websocket: protocol violations close like ws" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const Case = struct { frame: []const u8, code: u16, message: []const u8 };
    var big: [5000]u8 = undefined;
    @memset(&big, 'x');
    const cases = [_]Case{
        .{ .frame = try wsFrame(a, 0x1, "x", false, true), .code = 1002, .message = "Invalid WebSocket frame: MASK must be set" },
        .{ .frame = try wsFrame(a, 0x1, &big, true, true), .code = 1009, .message = "Max payload size exceeded" },
        .{ .frame = try wsFrame(a, 0x1, "\xff", true, true), .code = 1007, .message = "Invalid WebSocket frame: invalid UTF-8 sequence" },
        .{ .frame = try wsFrame(a, 0x3, "", true, true), .code = 1002, .message = "Invalid WebSocket frame: invalid opcode 3" },
        .{ .frame = try wsFrame(a, 0x0, "x", true, true), .code = 1002, .message = "Invalid WebSocket frame: invalid opcode 0" },
        .{ .frame = try wsFrame(a, 0x9, "x", true, false), .code = 1002, .message = "Invalid WebSocket frame: FIN must be set" },
    };
    for (cases, 0..) |case, i| {
        var c = try h.connect();
        defer c.close();
        _ = try wsHandshake(&c, a, "/agents");
        try c.send(case.frame);
        const close = try wsRead(&c);
        defer testing.allocator.free(close.payload);
        try testing.expectEqual(@as(u8, 0x8), close.opcode);
        try testing.expectEqual(@as(usize, 2), close.payload.len);
        try testing.expectEqual(case.code, std.mem.readInt(u16, close.payload[0..2], .big));
        c.close();
        c = try h.connect(); // replaced so the deferred close stays valid
        try h.wse.waitCloses(i + 1);
        h.wse.mutex.lock();
        try testing.expectEqualStrings(case.message, h.wse.errors.items[i]);
        try testing.expectEqual(@as(u16, 1006), h.wse.closes.items[i]);
        h.wse.mutex.unlock();
    }
}

test "websocket: invalid handshakes and unknown paths" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    try c.send("GET /agents HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    const r = try c.read(a, false);
    try testing.expectEqual(@as(u16, 400), r.status);
    try testing.expectEqualStrings("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 47\r\nSec-WebSocket-Version: 13, 8\r\n\r\n", r.head);
    try testing.expectEqualStrings("Missing or invalid Sec-WebSocket-Version header", r.body);
    var c2 = try h.connect();
    defer c2.close();
    try c2.send("GET /other HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    try testing.expect(c2.closedByPeer());
}

test "websocket: no data frame after the close frame" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    _ = try wsHandshake(&c, a, "/agents");
    try c.send(try wsFrame(a, 0x1, "close-then-send", true, true));
    const close = try wsRead(&c);
    defer testing.allocator.free(close.payload);
    try testing.expectEqual(@as(u8, 0x8), close.opcode);
    try c.send(try wsFrame(a, 0x8, close.payload, true, true));
    try h.wse.waitCloses(1);
    try testing.expect(c.closedByPeer());
    h.wse.mutex.lock();
    defer h.wse.mutex.unlock();
    try testing.expectError(error.NotOpen, h.wse.late_send.?);
}

test "websocket: a stale handle never touches a reused descriptor" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    _ = try wsHandshake(&c, a, "/keep");
    c.close();
    try h.wse.waitCloses(1);
    const stale = h.wse.kept.?;
    defer stale.release();
    // New connections likely reuse the closed descriptor number.
    var clients: [4]Client = undefined;
    for (&clients) |*cl| {
        cl.* = try h.connect();
        try cl.send("GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        _ = try cl.read(a, false);
    }
    defer for (&clients) |*cl| cl.close();
    stale.close(1000, "late");
    stale.terminate();
    try testing.expectError(error.NotOpen, stale.send("x", false, null));
    try testing.expectEqual(ws.ReadyState.closed, stale.readyState());
    for (&clients) |*cl| {
        const r = try cl.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
        try testing.expectEqual(@as(u16, 404), r.status);
    }
}

test "websocket: allocation failures never leave a dead upgraded socket" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    // Connection setup fails: no 101, the socket is closed.
    var fail_create = std.testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    h.wse.failing = fail_create.allocator();
    var c = try h.connect();
    defer c.close();
    try c.send("GET /oom HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    try testing.expect(c.closedByPeer());
    try testing.expectEqual(@as(usize, 0), c.len);
    // Upgrade succeeds (2 allocations: the Conn and its pending 101 head),
    // the message buffer fails: the reader destroys the socket instead of
    // ignoring input forever.
    var fail_read = std.testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 2 });
    h.wse.failing = fail_read.allocator();
    var c2 = try h.connect();
    defer c2.close();
    _ = try wsHandshake(&c2, a, "/oom");
    try c2.send(try wsFrame(a, 0x1, "hello", true, true));
    try testing.expect(c2.closedByPeer());
    try h.wse.waitCloses(1);
    h.wse.mutex.lock();
    defer h.wse.mutex.unlock();
    try testing.expectEqual(@as(u16, 1006), h.wse.closes.items[0]);
}

// ---------------------------------------------------------------------------
// ws.Conn.trySendInline
// ---------------------------------------------------------------------------

const CompletionCount = struct {
    ok: std.atomic.Value(u32) = .init(0),
    failed: std.atomic.Value(u32) = .init(0),
    fn func(ctx: *anyopaque, _: *ws.Conn, ok: bool) void {
        const self: *CompletionCount = @ptrCast(@alignCast(ctx));
        _ = (if (ok) &self.ok else &self.failed).fetchAdd(1, .monotonic);
    }
    fn cb(self: *CompletionCount) ws.SendCallback {
        return .{ .ctx = self, .func = func };
    }
};

fn keptConn(h: *Harness, c: *Client, a: std.mem.Allocator) !*ws.Conn {
    _ = try wsHandshake(c, a, "/keep");
    var waited: usize = 0;
    while (waited < 5_000) : (waited += 1) {
        h.wse.mutex.lock();
        const kept = h.wse.kept;
        h.wse.mutex.unlock();
        if (kept) |conn| return conn;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
}

/// A send callback that logs its frame's tag in `WsEcho.pass_log`.
const PassTag = struct {
    echo: *WsEcho,
    tag: i32,
    fn func(ctx: *anyopaque, _: *ws.Conn, ok: bool) void {
        const self: *PassTag = @ptrCast(@alignCast(ctx));
        self.echo.logPass(if (ok) self.tag else 1000 + self.tag);
    }
    fn cb(self: *PassTag) ws.SendCallback {
        return .{ .ctx = self, .func = func };
    }
};

fn passLog(h: *Harness, a: std.mem.Allocator) ![]i32 {
    h.wse.mutex.lock();
    defer h.wse.mutex.unlock();
    return a.dupe(i32, h.wse.pass_log.items);
}

/// Waits until a send callback reported a failure (`PassTag`: tag + 1000).
fn waitFailedSend(h: *Harness, a: std.mem.Allocator) !void {
    var waited: u32 = 0;
    while (waited < 5_000) : (waited += 1) {
        for (try passLog(h, a)) |v| if (v >= 1000) return;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
}

test "a peer FIN with frames queued: they are all written, then FIN; no send fails (ws socketOnEnd)" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // The client reads nothing yet: frames queue and the writer waits for room.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    const tags = try a.alloc(PassTag, 4000);
    const payload = try a.alloc(u8, 4000);
    @memset(payload, 'p');
    var n: usize = 0;
    while (conn.bufferedAmount() < 256 * 1024) : (n += 1) {
        if (n == tags.len) return error.Timeout;
        tags[n] = .{ .echo = &h.wse, .tag = @intCast(n) };
        try conn.send(payload, true, tags[n].cb());
        if (n % 64 == 63) std.Thread.sleep(std.time.ns_per_ms);
    }
    // The peer half-closes, then reads everything.
    try posix.shutdown(c.fd, .send);
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try testing.expect(conn.readyState() != .open);
    try setRecvTimeout(c.fd);
    var got: usize = 0;
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        const r = try posix.read(c.fd, &buf);
        if (r == 0) break;
        got += r;
    }
    // Every frame (4-byte header + 4000), then the FIN.
    try testing.expectEqual(n * (4 + 4000), got);
    try h.wse.waitCloses(1);
    for (try passLog(&h, a)) |v| try testing.expect(v < 1000);
}

test "frames a turn corked while OPEN still go out when the peer's FIN is read before the turn flushes them" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // Frames queue behind a client that reads nothing yet.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    const tags = try a.alloc(PassTag, 4002);
    const payload = try a.alloc(u8, 4000);
    @memset(payload, 'p');
    var n: usize = 0;
    while (conn.bufferedAmount() < 256 * 1024) : (n += 1) {
        if (n == 4000) return error.Timeout;
        tags[n] = .{ .echo = &h.wse, .tag = @intCast(n) };
        try conn.send(payload, true, tags[n].cb());
        if (n % 64 == 63) std.Thread.sleep(std.time.ns_per_ms);
    }
    // The peer's FIN is read (CLOSING, flushing) between a turn's cork and its flush.
    try posix.shutdown(c.fd, .send);
    var waited: u32 = 0;
    while (conn.readyState() == .open) : (waited += 1) {
        if (waited >= 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // The turn's flush: Node wrote these before it processed 'end'.
    tags[n] = .{ .echo = &h.wse, .tag = @intCast(n) };
    tags[n + 1] = .{ .echo = &h.wse, .tag = @intCast(n + 1) };
    const corked = try conn.sendInlineCorked(&.{ payload, payload }, true, &.{ tags[n].cb(), tags[n + 1].cb() }, 2);
    try testing.expectEqual(@as(usize, 2), corked.written + corked.queued);
    // A plain send after the FIN is refused, as for ws's CLOSING.
    try testing.expectError(error.NotOpen, conn.send(payload, true, null));
    try setRecvTimeout(c.fd);
    var got: usize = 0;
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        const r = try posix.read(c.fd, &buf);
        if (r == 0) break;
        got += r;
    }
    try testing.expectEqual((n + 2) * (4 + 4000), got);
    try h.wse.waitCloses(1);
    for (try passLog(&h, a)) |v| try testing.expect(v < 1000);
}

test "send failure text: a reset after the peer stopped reading fails the queue 'write ECANCELED' (Node reads first)" {
    if (@import("builtin").os.tag != .linux) return error.SkipZigTest; // epoll HUP|ERR edge
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // The client reads nothing: frames queue and the writer waits for room.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    // Until the kernel buffers on both sides are full and frames wait.
    const tags = try a.alloc(PassTag, 4000);
    const payload = try a.alloc(u8, 4000);
    @memset(payload, 'p');
    var n: usize = 0;
    while (conn.bufferedAmount() < 256 * 1024) : (n += 1) {
        if (n == tags.len) return error.Timeout;
        tags[n] = .{ .echo = &h.wse, .tag = @intCast(n) };
        try conn.send(payload, true, tags[n].cb());
        if (n % 64 == 63) std.Thread.sleep(std.time.ns_per_ms);
    }
    // Stalled: no write progress for longer than `write_stall_ms`.
    std.Thread.sleep((ws.write_stall_ms + 50) * std.time.ns_per_ms);
    try testing.expect(conn.bufferedAmount() > 0);
    closeWithReset(c.fd);
    try waitFailedSend(&h, a);
    try testing.expectEqualStrings("write ECANCELED", conn.sendFailureText());
    // Teardown has run every callback (`tags` lives in the arena) once 'close' is out.
    try h.wse.waitCloses(1);
}

test "send failure text: a reset while the writer only just hit EAGAIN fails the write 'write ECONNRESET' (Node writes first)" {
    if (@import("builtin").os.tag != .linux) return error.SkipZigTest; // epoll HUP|ERR edge
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // The client reads nothing: frames queue and the writer waits for room.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    // Until the kernel buffers on both sides are full and frames wait.
    const tags = try a.alloc(PassTag, 4000);
    const payload = try a.alloc(u8, 4000);
    @memset(payload, 'p');
    var n: usize = 0;
    while (conn.bufferedAmount() < 256 * 1024) : (n += 1) {
        if (n == tags.len) return error.Timeout;
        tags[n] = .{ .echo = &h.wse, .tag = @intCast(n) };
        try conn.send(payload, true, tags[n].cb());
        if (n % 64 == 63) std.Thread.sleep(std.time.ns_per_ms);
    }
    // Right away: the writer is behind, not stalled.
    try testing.expect(!conn.writeStalled());
    closeWithReset(c.fd);
    try waitFailedSend(&h, a);
    try testing.expectEqualStrings("write ECONNRESET", conn.sendFailureText());
    // Teardown has run every callback (`tags` lives in the arena) once 'close' is out.
    try h.wse.waitCloses(1);
}

test "send failure text: a write that fails after a reset gives Node's 'write ECONNRESET'/'write EPIPE'" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // The loop is held: the reset is not read before the write hits it.
    var hold: LoopHold = .{};
    try hold.hold(&h);
    closeWithReset(c.fd);
    std.Thread.sleep(50 * std.time.ns_per_ms);
    var tag: PassTag = .{ .echo = &h.wse, .tag = 0 };
    _ = conn.trySendInline("x", false, tag.cb()) catch {};
    hold.release();
    try h.wse.waitCloses(1);
    const text = conn.sendFailureText();
    if (!std.mem.eql(u8, text, "write ECONNRESET") and !std.mem.eql(u8, text, "write EPIPE")) {
        std.debug.print("unexpected send failure text: {s}\n", .{text});
        return error.TestUnexpectedResult;
    }
}

test "write passes complete their frames together, in order, then report drained" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // The client reads nothing yet: the frames queue behind a small buffer.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    var tags: [20]PassTag = undefined;
    const payload = try a.alloc(u8, 4000);
    @memset(payload, 'p');
    for (&tags, 0..) |*t, i| {
        t.* = .{ .echo = &h.wse, .tag = @intCast(i) };
        try conn.send(payload, true, t.cb());
    }
    // Drain every frame (2-byte header + 2-byte length + 4000 each).
    var got: usize = 0;
    var buf: [64 * 1024]u8 = undefined;
    while (got < tags.len * (4 + 4000)) got += try posix.read(c.fd, &buf);
    // Until every frame completed and its pass ended (an earlier pass may
    // have drained the queue before the last frames were sent).
    var waited: u32 = 0;
    var log = try passLog(&h, a);
    while (waited < 400) : (waited += 1) {
        var completed: usize = 0;
        for (log) |v| completed += @intFromBool(v >= 0);
        if (completed == tags.len and log[log.len - 1] < 0) break;
        std.Thread.sleep(5 * std.time.ns_per_ms);
        log = try passLog(&h, a);
    }
    // Callbacks in queue order; each pass end follows that pass's
    // completions; the last pass drained the queue.
    try testing.expect(log.len > 0 and log[log.len - 1] == -1);
    var next: i32 = 0;
    var in_pass: u32 = 0;
    for (log) |v| {
        if (v >= 0) {
            try testing.expectEqual(next, v);
            next += 1;
            in_pass += 1;
        } else {
            try testing.expect(in_pass > 0);
            in_pass = 0;
        }
    }
    try testing.expectEqual(@as(i32, tags.len), next);
}

test "on_pass_end may block on another thread that sends on the same connection" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    h.wse.send_in_pass_end.store(true, .release);
    var tag: PassTag = .{ .echo = &h.wse, .tag = 0 };
    try conn.send("first", false, tag.cb());
    var waited: u32 = 0;
    while (!h.wse.sent_in_pass_end.load(.acquire) and waited < 400) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expect(h.wse.sent_in_pass_end.load(.acquire));
    // Everything arrives, in order.
    for ([_][]const u8{ "first", "from-other-thread", "queued-from-other-thread" }) |want| {
        const f = try wsRead(&c);
        defer testing.allocator.free(f.payload);
        try testing.expectEqualStrings(want, f.payload);
    }
}

test "teardown fails the queued frames, then ends the pass undrained" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    var tags: [20]PassTag = undefined;
    // Far more than the client's receive buffer: frames are left unwritten.
    const payload = try a.alloc(u8, 64 * 1024);
    @memset(payload, 'p');
    for (&tags, 0..) |*t, i| {
        t.* = .{ .echo = &h.wse, .tag = @intCast(i) };
        try conn.send(payload, true, t.cb());
    }
    c.close(); // unread data: the server's socket fails
    // Until every frame completed (a pass that hit EAGAIN also ends undrained).
    var waited: u32 = 0;
    var log = try passLog(&h, a);
    while (waited < 400) : (waited += 1) {
        var completed: usize = 0;
        for (log) |v| completed += @intFromBool(v >= 0);
        if (completed == tags.len) break;
        std.Thread.sleep(5 * std.time.ns_per_ms);
        log = try passLog(&h, a);
    }
    // Teardown's pass end comes right after its failed callbacks.
    waited = 0;
    log = try passLog(&h, a);
    while (!(log.len > 0 and log[log.len - 1] == -2) and waited < 1000) : (waited += 1) {
        std.Thread.sleep(5 * std.time.ns_per_ms);
        log = try passLog(&h, a);
    }
    try testing.expect(log.len > 0 and log[log.len - 1] == -2);
    try testing.expect(log[log.len - 2] >= 1000);
    // Every frame completed exactly once, written ones before failed ones.
    var seen = [_]bool{false} ** 20;
    var failed_started = false;
    for (log) |v| {
        if (v < 0) continue;
        const tag: usize = @intCast(@mod(v, 1000));
        try testing.expect(!seen[tag]);
        seen[tag] = true;
        if (v >= 1000) failed_started = true else try testing.expect(!failed_started);
    }
    for (seen) |b| try testing.expect(b);
}

test "trySendInline: interleaved inline and queued sends from two threads keep order" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    const n = 300;
    const Sender = struct {
        fn run(cn: *ws.Conn, prefix: u8, inline_first: bool) void {
            var buf: [32]u8 = undefined;
            for (0..n) |i| {
                const msg = std.fmt.bufPrint(&buf, "{c}{d}", .{ prefix, i }) catch unreachable;
                if (inline_first) {
                    if (cn.trySendInline(msg, false, null) catch return) continue;
                }
                cn.send(msg, false, null) catch return;
            }
        }
    };
    const t1 = try std.Thread.spawn(.{}, Sender.run, .{ conn, 'a', true });
    const t2 = try std.Thread.spawn(.{}, Sender.run, .{ conn, 'b', false });
    var next = [2]usize{ 0, 0 };
    for (0..2 * n) |_| {
        const f = try wsRead(&c);
        defer testing.allocator.free(f.payload);
        try testing.expectEqual(@as(u8, 0x1), f.opcode);
        const which: usize = if (f.payload[0] == 'a') 0 else 1;
        try testing.expectEqual(next[which], try std.fmt.parseInt(usize, f.payload[1..], 10));
        next[which] += 1;
    }
    t1.join();
    t2.join();
    try testing.expectEqual(@as(usize, 0), conn.bufferedAmount());
}

test "trySendInline: partial write queues the tail; busy queue falls back without side effects" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    const big = try a.alloc(u8, 4 * 1024 * 1024);
    for (big, 0..) |*b, i| b.* = @intCast('a' + i % 26);
    var counts: CompletionCount = .{};
    // The client is not reading: the kernel takes only part of 4 MiB.
    try testing.expect(try conn.trySendInline(big, false, counts.cb()));
    const queued = conn.bufferedAmount();
    try testing.expect(queued > 0 and queued < big.len + 10);
    try testing.expectEqual(@as(u32, 0), counts.ok.load(.monotonic));
    // Queue busy: nothing written, no callback, accounting untouched.
    var small_counts: CompletionCount = .{};
    try testing.expect(!try conn.trySendInline("small", false, small_counts.cb()));
    try testing.expectEqual(queued, conn.bufferedAmount());
    try testing.expectEqual(@as(u32, 0), small_counts.ok.load(.monotonic) + small_counts.failed.load(.monotonic));
    try conn.send("small", false, small_counts.cb());
    // Drain: the big frame arrives intact, then the fallback frame.
    const first = try wsReadLarge(&c, a);
    try testing.expectEqual(@as(u8, 0x1), first.opcode);
    try testing.expectEqualSlices(u8, big, first.payload);
    const second = try wsRead(&c);
    defer testing.allocator.free(second.payload);
    try testing.expectEqualStrings("small", second.payload);
    var waited: usize = 0;
    while (small_counts.ok.load(.monotonic) == 0 and waited < 5000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, 1), counts.ok.load(.monotonic));
    try testing.expectEqual(@as(u32, 1), small_counts.ok.load(.monotonic));
    try testing.expectEqual(@as(u32, 0), counts.failed.load(.monotonic));
    try testing.expectEqual(@as(usize, 0), conn.bufferedAmount());
}

test "trySendInline: full write completes once; close after it follows the data; NotOpen afterwards" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    var counts: CompletionCount = .{};
    try testing.expect(try conn.trySendInline("inline", false, counts.cb()));
    try testing.expectEqual(@as(u32, 1), counts.ok.load(.monotonic));
    try testing.expectEqual(@as(usize, 0), conn.bufferedAmount());
    conn.close(1000, "bye");
    try testing.expectError(error.NotOpen, conn.trySendInline("late", false, counts.cb()));
    const data = try wsRead(&c);
    defer testing.allocator.free(data.payload);
    try testing.expectEqualStrings("inline", data.payload);
    const close = try wsRead(&c);
    defer testing.allocator.free(close.payload);
    try testing.expectEqual(@as(u8, 0x8), close.opcode);
    try testing.expectEqual(@as(u32, 1), counts.ok.load(.monotonic));
}

test "snapshot: readyState and bufferedAmount under one lock" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, arena_state.allocator());
    defer conn.release();
    const open = conn.snapshot();
    try testing.expectEqual(ws.ReadyState.open, open.ready_state);
    try testing.expectEqual(@as(usize, 0), open.buffered_amount);
    conn.close(1000, "bye");
    try testing.expectEqual(ws.ReadyState.closing, conn.snapshot().ready_state);
}

test "snapshot: queued ping and close frames are reported as control bytes" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    // The client reads nothing yet: a large data frame stays queued, so the
    // ping and the close frame behind it queue too.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    const big = try a.alloc(u8, 4 * 1024 * 1024);
    @memset(big, 'd');
    try conn.send(big, true, null);
    conn.ping();
    conn.close(1000, "bye");
    const snap = conn.snapshot();
    // ping: 2-byte header; close: 2-byte header + code + "bye".
    try testing.expectEqual(@as(usize, 2 + 2 + 2 + 3), snap.control);
    try testing.expect(snap.buffered_amount >= big.len + snap.control);
    // Draining the socket writes everything: nothing is left charged. (Read
    // by bytes, not by calls: an 8 KiB send buffer hands over small pieces.)
    var buf: [256 * 1024]u8 = undefined;
    var got: usize = 0;
    while (got < snap.buffered_amount) {
        const n = try posix.read(c.fd, &buf);
        if (n == 0) break;
        got += n;
    }
    var waited: u32 = 0;
    while (conn.snapshot().buffered_amount > 0 and waited < 400) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    const drained = conn.snapshot();
    try testing.expectEqual(@as(usize, 0), drained.buffered_amount);
    try testing.expectEqual(@as(usize, 0), drained.control);
}

test "a ping queued behind an in-flight write stays in control until its whole batch is written (Node)" {
    // Mirrors live's real-Node trace (tools/node-heartbeat.mjs): an 8 MB
    // frame is in flight with the reader paused; ping + a 30 MB frame are
    // sent; at the 8 MB frame's callback Node's bufferedAmount is 30000012
    // (ping 2 + 30000010) although the ping's bytes went out first; at the
    // 30 MB frame's callback it is 0.
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    const Seen = struct {
        conn: *ws.Conn,
        control: std.atomic.Value(usize) = .init(std.math.maxInt(usize)),
        fn func(ctx: *anyopaque, _: *ws.Conn, ok: bool) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (ok) self.control.store(self.conn.snapshot().control, .release);
        }
        fn cb(self: *@This()) ws.SendCallback {
            return .{ .ctx = self, .func = func };
        }
    };
    // Small buffers (as in the macOS trace), so the 8 MB frame is still in
    // flight when the ping is sent. The receive buffer stays above loopback's
    // 64 KiB MSS: an 8 KiB one never opens a full segment of window after a
    // read, and the sender then waits on zero-window probes with exponential
    // backoff (under CPU load the transfer stalled for minutes; gdb showed
    // both sides idle with 32 KiB queued).
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    try posix.setsockopt(c.fd, posix.SOL.SOCKET, posix.SO.RCVBUF, &std.mem.toBytes(@as(c_int, 131072)));
    try setRecvTimeout(c.fd);
    var f1: Seen = .{ .conn = conn };
    var heartbeat: Seen = .{ .conn = conn };
    const big = try a.alloc(u8, 8_000_000);
    @memset(big, 'a');
    try conn.send(big, false, f1.cb());
    std.Thread.sleep(100 * std.time.ns_per_ms);
    conn.ping();
    const huge = try a.alloc(u8, 30_000_000);
    @memset(huge, 'h');
    try conn.send(huge, false, heartbeat.cb());
    try testing.expectEqual(@as(usize, 2), conn.snapshot().control);
    // Read everything: 8000010 + 2 + 30000010 bytes.
    var buf: [256 * 1024]u8 = undefined;
    var got: usize = 0;
    while (got < 8_000_010 + 2 + 30_000_010) {
        const n = try posix.read(c.fd, &buf);
        if (n == 0) break;
        got += n;
    }
    var waited: u32 = 0;
    while (heartbeat.control.load(.acquire) == std.math.maxInt(usize) and waited < 400) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 2), f1.control.load(.acquire));
    try testing.expectEqual(@as(usize, 0), heartbeat.control.load(.acquire));
    try testing.expectEqual(@as(usize, 0), conn.snapshot().control);
}

test "sendInlineCorked: the frames before `required` go out or queue together, in order" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var c = try h.connect();
    defer c.close();
    const conn = try keptConn(&h, &c, a);
    defer conn.release();
    var counts: CompletionCount = .{};
    const cbs = [_]ws.SendCallback{ counts.cb(), counts.cb(), counts.cb() };
    // Everything fits: written, nothing queued, no callbacks.
    const r = try conn.sendInlineCorked(&.{ "a", "b", "c" }, false, &cbs, 3);
    try testing.expectEqual(@as(usize, 3), r.written);
    try testing.expectEqual(@as(usize, 0), r.queued);
    for ([_][]const u8{ "a", "b", "c" }) |want| {
        const f = try wsRead(&c);
        defer testing.allocator.free(f.payload);
        try testing.expectEqualStrings(want, f.payload);
    }
    // The kernel stops inside frame k: k and every later required frame are
    // queued whole at once, so a pong (or any other frame) cannot get between.
    try posix.setsockopt(conn.fd, posix.SOL.SOCKET, posix.SO.SNDBUF, &std.mem.toBytes(@as(c_int, 8192)));
    var frames: [40][]const u8 = undefined;
    for (&frames, 0..) |*f, i| f.* = try std.fmt.allocPrint(a, "{d:0>4000}", .{i});
    var many_cbs: [40]ws.SendCallback = undefined;
    for (&many_cbs) |*cb| cb.* = counts.cb();
    const r2 = try conn.sendInlineCorked(&frames, false, &many_cbs, 39);
    try testing.expect(r2.written < 39 and r2.written + r2.queued == 39);
    try testing.expect(conn.snapshot().buffered_amount > 0);
    // The optional last frame was left to the caller; send it the normal way.
    try conn.send(frames[39], false, null);
    conn.ping();
    for (frames) |want| {
        const f = try wsRead(&c);
        defer testing.allocator.free(f.payload);
        try testing.expectEqualStrings(want, f.payload);
    }
    const p = try wsRead(&c);
    defer testing.allocator.free(p.payload);
    try testing.expectEqual(@as(u8, 0x9), p.opcode);
    var waited: usize = 0;
    while (counts.ok.load(.monotonic) != r2.queued and waited < 5000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, @intCast(r2.queued)), counts.ok.load(.monotonic));
    // Output already queued: nothing is written, the required frames queue behind it.
    try conn.send("x" ** 600_000, false, null);
    const r3 = try conn.sendInlineCorked(&.{ "after1", "after2" }, false, cbs[0..2], 1);
    try testing.expectEqual(@as(usize, 0), r3.written);
    try testing.expectEqual(@as(usize, 1), r3.queued);
    const big = try wsReadLarge(&c, a);
    try testing.expectEqual(@as(usize, 600_000), big.payload.len);
    const after = try wsRead(&c);
    defer testing.allocator.free(after.payload);
    try testing.expectEqualStrings("after1", after.payload);
}

/// wsRead for frames larger than the client buffer.
fn wsReadLarge(c: *Client, a: std.mem.Allocator) !struct { opcode: u8, payload: []u8 } {
    while (c.len < 10) if (try c.fill() == 0) return error.EndOfStream;
    const opcode = c.buf[0] & 0x0f;
    var hlen: usize = 2;
    var len: usize = c.buf[1] & 0x7f;
    if (len == 126) {
        len = std.mem.readInt(u16, c.buf[2..4], .big);
        hlen = 4;
    } else if (len == 127) {
        len = @intCast(std.mem.readInt(u64, c.buf[2..10], .big));
        hlen = 10;
    }
    const out = try a.alloc(u8, len);
    var got: usize = 0;
    var start = hlen;
    while (got < len) {
        if (start >= c.len) {
            c.len = 0;
            start = 0;
            if (try c.fill() == 0) return error.EndOfStream;
        }
        const take = @min(len - got, c.len - start);
        @memcpy(out[got .. got + take], c.buf[start .. start + take]);
        got += take;
        start += take;
    }
    std.mem.copyForwards(u8, c.buf[0 .. c.len - start], c.buf[start..c.len]);
    c.len -= start;
    return .{ .opcode = opcode, .payload = out };
}

const StartProbe = struct {
    var ran = std.atomic.Value(u32).init(0);
    var on_loop_fiber = std.atomic.Value(u32).init(0);
    var done = std.atomic.Value(u32).init(0);
    var failed = std.atomic.Value(u32).init(0);
    var wait_ms: i64 = 0;

    fn reset(ms: i64) void {
        ran.store(0, .release);
        on_loop_fiber.store(0, .release);
        done.store(0, .release);
        failed.store(0, .release);
        wait_ms = ms;
    }

    fn run(_: *anyopaque) void {
        _ = ran.fetchAdd(1, .acq_rel);
        if (core.fiber.inFiber() and core.onEventLoopThread()) _ = on_loop_fiber.fetchAdd(1, .acq_rel);
        // A real wait parks the fiber (the loop goes on meanwhile).
        if (wait_ms > 0) {
            var w: core.fiber.Waiter = .{};
            _ = w.waitTimeout(core.fiber.monoMs() + wait_ms);
        }
        _ = done.fetchAdd(1, .acq_rel);
    }

    fn fail(_: *anyopaque) void {
        _ = failed.fetchAdd(1, .acq_rel);
    }

    fn until(counter: *std.atomic.Value(u32), want: u32) !void {
        var waited: u32 = 0;
        while (counter.load(.acquire) < want and waited < 2_000) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
        try testing.expectEqual(want, counter.load(.acquire));
    }
};

test "startFiber from non-loop threads runs every job on a loop fiber while requests are served" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    StartProbe.reset(2);
    const Poster = struct {
        fn run(group: *loop_mod.Group, n: u32, errors: *std.atomic.Value(u32)) void {
            var dummy: u8 = 0;
            for (0..n) |_| group.startFiber(StartProbe.run, &dummy, StartProbe.fail) catch {
                _ = errors.fetchAdd(1, .acq_rel);
            };
        }
    };
    var errors = std.atomic.Value(u32).init(0);
    var threads: [4]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Poster.run, .{ &h.server.loop, 250, &errors });
    // HTTP keeps flowing meanwhile.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    for (0..50) |_| try testing.expectEqual(@as(u16, 404), (try c.request(arena.allocator(), "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n")).status);
    for (threads) |t| t.join();
    try testing.expectEqual(@as(u32, 0), errors.load(.acquire));
    try StartProbe.until(&StartProbe.done, 1000);
    try testing.expectEqual(@as(u32, 1000), StartProbe.on_loop_fiber.load(.acquire));
    try testing.expectEqual(@as(u32, 0), StartProbe.failed.load(.acquire));
}

test "startFiber: a fiber that cannot be created calls on_fail on the loop instead" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    StartProbe.reset(0);
    core.fiber.test_fail_create.store(true, .release);
    defer core.fiber.test_fail_create.store(false, .release);
    var dummy: u8 = 0;
    try h.server.loop.startFiber(StartProbe.run, &dummy, StartProbe.fail);
    try StartProbe.until(&StartProbe.failed, 1);
    try testing.expectEqual(@as(u32, 0), StartProbe.ran.load(.acquire));
    try testing.expect(!core.fiber.test_fail_create.load(.acquire));
    // The next one runs normally.
    try h.server.loop.startFiber(StartProbe.run, &dummy, StartProbe.fail);
    try StartProbe.until(&StartProbe.done, 1);
}

test "startFiber at shutdown: every job either runs or gets on_fail" {
    if (!server_mod.fibers) return error.SkipZigTest;
    var h: Harness = .{};
    try h.start(10_000);
    StartProbe.reset(0);
    var dummy: u8 = 0;
    // Hold the loop (a test-only blocking job) so the next jobs are still
    // queued when the server stops.
    const Blocker = struct {
        fn run(_: *anyopaque) void {
            std.Thread.sleep(300 * std.time.ns_per_ms);
        }
    };
    try h.server.loop.startFiber(Blocker.run, &dummy, null);
    std.Thread.sleep(20 * std.time.ns_per_ms);
    for (0..100) |_| try h.server.loop.startFiber(StartProbe.run, &dummy, StartProbe.fail);
    h.stop();
    // Each ran (if it reached the loop in time) or was told it did not.
    try testing.expectEqual(@as(u32, 100), StartProbe.done.load(.acquire) + StartProbe.failed.load(.acquire));
    try testing.expectEqual(StartProbe.ran.load(.acquire), StartProbe.done.load(.acquire));
}

test "a burst of fibers leaves a stack cache the idle loop trims once idle long enough" {
    if (!server_mod.fibers) return error.SkipZigTest;
    // Shortened for the test (set before the loop starts).
    const saved = core.fiber.idle_trim_ms;
    core.fiber.idle_trim_ms = 1_000;
    defer core.fiber.idle_trim_ms = saved;
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    // 20 requests parked at once: 20 fibers, then 20 cached stacks.
    const Slow = struct {
        fn run(port: u16) void {
            const addr = std.net.Address.parseIp("127.0.0.1", port) catch return;
            const stream = std.net.tcpConnectToAddress(addr) catch return;
            var cl: Client = .{ .fd = stream.handle };
            defer cl.close();
            var ar = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer ar.deinit();
            _ = cl.request(ar.allocator(), "GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n") catch return;
        }
    };
    var threads: [20]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Slow.run, .{h.server.port()});
    for (threads) |t| t.join();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    // Right after the burst the cache is fat (this request runs on one of them).
    const busy = try std.fmt.parseInt(usize, (try c.request(arena.allocator(), "GET /graphql?fibercache HTTP/1.1\r\nHost: a\r\n\r\n")).body, 10);
    try testing.expect(busy > core.fiber.idle_keep);
    // After a quiet second the loop wakes on its own and trims it.
    const trims = core.fiber.test_trims.load(.monotonic);
    var waited: i64 = 0;
    while (core.fiber.test_trims.load(.monotonic) == trims) : (waited += 1) {
        if (waited >= core.fiber.idle_trim_ms + 5_000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const idle = try std.fmt.parseInt(usize, (try c.request(arena.allocator(), "GET /graphql?fibercache HTTP/1.1\r\nHost: a\r\n\r\n")).body, 10);
    try testing.expect(idle < core.fiber.idle_keep);
}
