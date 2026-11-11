//! Socket-level tests for the HTTP server and WebSocket layer, plus the HTTP
//! parts of `src/module.test.ts` / `src/metrics.test.ts` that belong to this
//! module (metrics route, CORS, routing options, body limits).
const std = @import("std");
const core = @import("core");
const types = @import("types.zig");
const server_mod = @import("server.zig");
const ws = @import("ws.zig");

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

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *WsEcho = @ptrCast(@alignCast(ctx));
        const oom = std.mem.startsWith(u8, req.path, "/oom");
        const keep = std.mem.eql(u8, req.path, "/keep");
        if (!std.mem.eql(u8, req.path, "/agents") and !oom and !keep) return socket.destroy();
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
    const snap = h.echo.snapshot();
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
    snap = h.echo.snapshot();
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
    try c.send("POST /graphql HTTP/1.1\r\nHost: a\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nok");
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try testing.expect(h.echo.snapshot().body_pending);
    try c.send("ok");
    _ = try c.read(a, false);
    // 16 MiB the client does not read yet: the write parks once.
    try c.send("GET /graphql?big HTTP/1.1\r\nHost: a\r\n\r\n");
    std.Thread.sleep(200 * std.time.ns_per_ms);
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
