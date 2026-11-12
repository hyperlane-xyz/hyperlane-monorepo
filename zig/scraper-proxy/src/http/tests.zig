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
        if (std.mem.eql(u8, req.query, "sleep")) std.Thread.sleep(300 * std.time.ns_per_ms);
        // A wait announced like a DB wait (core.blocking): handed off at once.
        // A short unannounced stall (caught by the monitor, not core.blocking).
        if (std.mem.eql(u8, req.query, "stall")) std.Thread.sleep(20 * std.time.ns_per_ms);
        if (std.mem.eql(u8, req.query, "hooked")) {
            core.blocking.begin();
            std.Thread.sleep(300 * std.time.ns_per_ms);
            core.blocking.end();
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

    fn ignoreSent(_: *anyopaque, _: *ws.Conn, _: bool) void {}

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        const oom = std.mem.startsWith(u8, req.path, "/oom");
        const keep = std.mem.eql(u8, req.path, "/keep");
        const greet = std.mem.eql(u8, req.path, "/greet");
        const kill = std.mem.eql(u8, req.path, "/kill");
        const short = std.mem.eql(u8, req.path, "/short");
        if (!std.mem.eql(u8, req.path, "/agents") and !oom and !keep and !greet and !kill and !short) return socket.destroy();
        const gpa = if (oom) self.failing.? else testing.allocator;
        const conn = self.wss.handleUpgrade(gpa, req, socket, .{
            .ctx = self,
            .on_message = onMessage,
            .on_pong = onPong,
            .on_error = onError,
            .on_close = onClose,
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
        self.mutex.lock();
        defer self.mutex.unlock();
        self.pongs += 1;
    }

    fn onError(ctx: *anyopaque, _: *ws.Conn, message: []const u8) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.errors.append(testing.allocator, testing.allocator.dupe(u8, message) catch return) catch {};
    }

    fn onClose(ctx: *anyopaque, _: *ws.Conn, code: u16, _: []const u8) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
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
    }
};

const Harness = struct {
    echo: Echo = .{},
    wse: WsEcho = .{},
    routes: [2]types.Route = undefined,
    server: *server_mod.Server = undefined,

    fn start(self: *Harness, request_timeout_ms: u32) !void {
        self.routes = .{
            @import("metrics_route.zig").route(),
            .{
                .methods = &.{ "GET", "POST" },
                .path = "/graphql",
                .ctx = &self.echo,
                .hooks = .{ .on_request = Echo.onRequest, .handler = Echo.handler, .error_handler = Echo.errorHandler, .on_done = Echo.onDone, .on_write_blocked = Echo.onWriteBlocked },
                .text_content_types = &.{"application/graphql"},
            },
        };
        self.server = try server_mod.Server.init(testing.allocator, .{
            .host = "127.0.0.1",
            .port = 0,
            .routes = &self.routes,
            .upgrade = .{ .ctx = &self.wse, .on_upgrade = WsEcho.onUpgrade },
            .request_timeout_ms = request_timeout_ms,
        });
        try self.server.start();
    }

    fn stop(self: *Harness) void {
        self.server.deinit();
        self.wse.deinit();
    }

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
        if (!server_mod.writeFd(self.fd, bytes)) return error.WriteFailed;
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
};

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
    // Incomplete upload then client disconnect.
    var c = try h.connect();
    try c.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    std.Thread.sleep(50 * std.time.ns_per_ms);
    c.close();
    var waited: u32 = 0;
    while (h.echo.snapshot().done_closed == 0 and waited < 100) : (waited += 1) std.Thread.sleep(10 * std.time.ns_per_ms);
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

test "a hangup that arrives with data during a slow request is not lost" {
    var h: Harness = .{};
    try h.start(10_000);
    defer h.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Keep-alive: a pipelined request plus the client's FIN reach the
    // server while it is busy; both responses arrive, then EOF.
    var c = try h.connect();
    defer c.close();
    _ = try c.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try c.send("GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n");
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try c.send("GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try posix.shutdown(c.fd, .send);
    try testing.expectEqual(@as(u16, 200), (try c.read(a, false)).status);
    try testing.expectEqual(@as(u16, 404), (try c.read(a, false)).status);
    try testing.expect(c.closedByPeer());
    // Upload: a partial body plus FIN behind a slow request reports on_done(.closed).
    var c2 = try h.connect();
    defer c2.close();
    try c2.send("GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n");
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try c2.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    try posix.shutdown(c2.fd, .send);
    try testing.expectEqual(@as(u16, 200), (try c2.read(a, false)).status);
    var waited: u32 = 0;
    while (h.echo.snapshot().done_closed == 0 and waited < 200) : (waited += 1) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, 1), h.echo.snapshot().done_closed);
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
            const r = cl.request(ar.allocator(), "GET /graphql?sleep HTTP/1.1\r\nHost: a\r\n\r\n") catch return;
            status.* = r.status;
        }
    };
    var threads: [24]std.Thread = undefined;
    var statuses = [_]u16{0} ** 24;
    for (&threads, &statuses) |*t, *st| t.* = try std.Thread.spawn(.{}, Slow.run, .{ h.server.port(), st });
    std.Thread.sleep(50 * std.time.ns_per_ms);
    const t0 = std.time.milliTimestamp();
    var c = try h.connect();
    defer c.close();
    const r = try c.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    // Each slow request sleeps 300 ms; the accept must not wait for them.
    try testing.expect(std.time.milliTimestamp() - t0 < 150);
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
    for (&slow) |*cl| try cl.send("GET /graphql?hooked HTTP/1.1\r\nHost: a\r\n\r\n");
    const t0 = std.time.milliTimestamp();
    const r = try fast.request(a, "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 404), r.status);
    // Each hooked wait is 300 ms; nothing may queue behind them.
    try testing.expect(std.time.milliTimestamp() - t0 < 100);
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
            if (!server_mod.writeFd(fd, req)) return error.WriteFailed;
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
                _ = server_mod.writeFd(stream.handle, "GET /agents HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
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
    const loop = &h.server.loop;
    loop.mutex.lock();
    const peak = loop.threads;
    loop.mutex.unlock();
    try testing.expect(peak > 1);
    var waited: u32 = 0;
    while (waited < 300) : (waited += 1) {
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
    try testing.expect(h.server.loop.monitor_running.load(.acquire));
}

test "the first unhooked stall after an idle second is handed off promptly" {
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
    // The handler sleeps 300 ms; a hand-off answers long before.
    try testing.expect(took < 150);
}

test "close() ends idle keep-alive sockets with FIN; a request mid-head still gets 503" {
    var h: Harness = .{};
    try h.start(10_000);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Only fds: a Client carries a 256 KiB buffer.
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
    try mid.send("GET /nope HTTP/1.1\r\n");
    std.Thread.sleep(100 * std.time.ns_per_ms); // all parked
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

test "late requests during close get 503" {
    var h: Harness = .{};
    try h.start(10_000);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var c = try h.connect();
    defer c.close();
    // Start a request so the connection is busy, then close the server.
    try c.send("GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    _ = try c.read(arena.allocator(), false);
    // Let the server reach its keep-alive wait first: a socket still on
    // its way back to idle when close() begins is ended instead (as Node's
    // close() ends idle sockets).
    std.Thread.sleep(100 * std.time.ns_per_ms);
    h.server.closing.store(true, .release);
    const r = try c.request(arena.allocator(), "GET /graphql HTTP/1.1\r\nHost: a\r\n\r\n");
    try testing.expectEqual(@as(u16, 503), r.status);
    try testing.expectEqualStrings("{\"error\":\"Service Unavailable\",\"message\":\"Service Unavailable\",\"statusCode\":503}", r.body);
    h.server.closing.store(false, .release);
    h.stop();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

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
            .eof => 'E',
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
    while (waited < 300) : (waited += 1) {
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
    while (true) {
        owner.mutex.lock();
        const ready = owner.conns.items.len;
        owner.mutex.unlock();
        if (ready == n) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const ticker = try std.Thread.spawn(.{}, StressOwner.run, .{&owner});
    std.Thread.sleep(100 * std.time.ns_per_ms);
    // Clients end every way while ticks keep writing.
    const close_frame = try wsFrame(a, 0x8, &.{ 0x03, 0xe8 }, true, true);
    const garbage = try wsFrame(a, 0x1, "x", false, true); // unmasked: protocol error
    for (fds, 0..) |fd, i| switch (i % 3) {
        0 => _ = server_mod.writeFd(fd, close_frame),
        1 => _ = server_mod.writeFd(fd, garbage),
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
    // Upgrade succeeds (1 allocation: the Conn), the message buffer fails: the
    // reader destroys the socket instead of ignoring input forever.
    var fail_read = std.testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 1 });
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
    while (waited < 300) : (waited += 1) {
        h.wse.mutex.lock();
        const kept = h.wse.kept;
        h.wse.mutex.unlock();
        if (kept) |conn| return conn;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
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
    std.debug.print("A\n", .{});
    try testing.expect(try conn.trySendInline(big, false, counts.cb()));
    std.debug.print("B\n", .{});
    const queued = conn.bufferedAmount();
    std.debug.print("C queued={d}\n", .{queued});
    try testing.expect(queued > 0 and queued < big.len + 10);
    try testing.expectEqual(@as(u32, 0), counts.ok.load(.monotonic));
    // Queue busy: nothing written, no callback, accounting untouched.
    var small_counts: CompletionCount = .{};
    try testing.expect(!try conn.trySendInline("small", false, small_counts.cb()));
    try testing.expectEqual(queued, conn.bufferedAmount());
    try testing.expectEqual(@as(u32, 0), small_counts.ok.load(.monotonic) + small_counts.failed.load(.monotonic));
    try conn.send("small", false, small_counts.cb());
    // Drain: the big frame arrives intact, then the fallback frame.
    std.debug.print("D\n", .{});
    const first = try wsReadLarge(&c, a);
    std.debug.print("E\n", .{});
    try testing.expectEqual(@as(u8, 0x1), first.opcode);
    try testing.expectEqualSlices(u8, big, first.payload);
    const second = try wsRead(&c);
    defer testing.allocator.free(second.payload);
    try testing.expectEqualStrings("small", second.payload);
    var waited: usize = 0;
    while (small_counts.ok.load(.monotonic) == 0 and waited < 1000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
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
    while (counts.ok.load(.monotonic) != r2.queued and waited < 1000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
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
