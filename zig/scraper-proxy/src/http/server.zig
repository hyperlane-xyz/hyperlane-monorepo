//! HTTP/1.1 server reproducing Node `http` + Fastify 5 + @fastify/cors
//! behaviour for this app (see `types.zig` for the request lifecycle).
//!
//! Threads: one accept thread; one thread per connection (keep-alive loop,
//! later the WebSocket reader after an upgrade). Every blocking read is
//! bounded by poll() deadlines: requestTimeout (10s from the first byte of a
//! request until it is fully received -> 408), keepAliveTimeout (72s idle).
const std = @import("std");
const builtin = @import("builtin");
const core = @import("core");
const types = @import("types.zig");
const parse = @import("parse.zig");

const posix = std.posix;
const Request = types.Request;
const Reply = types.Reply;
const Route = types.Route;
const Header = types.Header;
const FastifyError = types.FastifyError;

const log = core.log.child("Http");

pub const UpgradeHandler = struct {
    ctx: *anyopaque,
    /// Node `server.on('upgrade', (req, socket, head))`: called on the
    /// connection thread for requests carrying `Upgrade` + `Connection:
    /// upgrade`. The callee owns `socket` from here on: hand it to
    /// `ws.Server.handleUpgrade` or call `socket.destroy()`.
    on_upgrade: *const fn (ctx: *anyopaque, req: *Request, socket: *UpgradeSocket) void,
};

/// A socket detached from HTTP processing (Node `Duplex` in 'upgrade').
pub const UpgradeSocket = struct {
    fd: posix.socket_t,
    /// Bytes received after the request head (Node `head`).
    head: []const u8,
    remote_address: std.net.Address,
    /// Set by `ws` when it takes over the socket: the connection thread runs
    /// this after `on_upgrade` returns (the WebSocket reader loop).
    takeover: ?Takeover = null,
    destroyed: bool = false,

    pub const Takeover = struct { ctx: *anyopaque, run: *const fn (ctx: *anyopaque) void };

    /// `socket.destroy()`.
    pub fn destroy(self: *UpgradeSocket) void {
        if (self.destroyed or self.takeover != null) return;
        self.destroyed = true;
    }
};

pub const Options = struct {
    host: []const u8 = "0.0.0.0",
    port: u16 = 8383,
    routes: []const Route = &.{},
    upgrade: ?UpgradeHandler = null,
    /// Fastify `requestTimeout` (Node enforces it on a 30s check interval;
    /// here it is exact).
    request_timeout_ms: u32 = 10_000,
    /// Fastify default `keepAliveTimeout`.
    keep_alive_timeout_ms: u32 = 72_000,
    /// Thread-per-connection cap; extra clients wait in the kernel backlog.
    max_connections: u32 = 8192,
    /// Per-connection thread stack (virtual; touched pages only).
    thread_stack_bytes: usize = 8 * 1024 * 1024,
    kernel_backlog: u31 = 511,
};

pub const Server = struct {
    gpa: std.mem.Allocator,
    options: Options,
    listen_fd: posix.socket_t,
    address: std.net.Address,
    stop_pipe: [2]posix.fd_t,
    accept_thread: ?std.Thread = null,
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    /// HTTP connections (not upgraded ones).
    connections: u32 = 0,
    /// Upgraded sockets whose reader still runs on a connection thread.
    upgraded: u32 = 0,
    /// Threads in `lingerClose`: they count against `max_connections` but do
    /// not hold up `close()`.
    lingering: u32 = 0,
    closing: std.atomic.Value(bool) = .init(false),
    listener_closed: bool = false,
    /// Live HTTP connections (intrusive list; touched only at connection
    /// start/end, never per request). `close` shuts down the idle ones.
    live: ?*Connection = null,

    /// Binds and listens (like `app.listen`); errors surface immediately.
    pub fn init(gpa: std.mem.Allocator, options: Options) !*Server {
        const address = try std.net.Address.parseIp(options.host, options.port);
        const fd = try posix.socket(address.any.family, posix.SOCK.STREAM | posix.SOCK.CLOEXEC, posix.IPPROTO.TCP);
        errdefer posix.close(fd);
        try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEADDR, &std.mem.toBytes(@as(c_int, 1)));
        var len = address.getOsSockLen();
        try posix.bind(fd, &address.any, len);
        try posix.listen(fd, options.kernel_backlog);
        var bound: std.net.Address = undefined;
        try posix.getsockname(fd, &bound.any, &len);
        const pipe = try posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true });
        const self = try gpa.create(Server);
        self.* = .{ .gpa = gpa, .options = options, .listen_fd = fd, .address = bound, .stop_pipe = pipe };
        return self;
    }

    pub fn port(self: *const Server) u16 {
        return self.address.getPort();
    }

    /// Starts accepting connections.
    pub fn start(self: *Server) !void {
        self.accept_thread = try std.Thread.spawn(.{}, acceptLoop, .{self});
    }

    pub fn isClosing(self: *const Server) bool {
        return self.closing.load(.acquire);
    }

    /// Fastify `close()` server part: stop accepting, close idle keep-alive
    /// connections, answer requests that arrive meanwhile with 503 and wait
    /// for in-flight HTTP requests (bounded by `timeout_ms`). Upgraded
    /// sockets are not touched (their owner closes them).
    pub fn close(self: *Server, timeout_ms: u64) void {
        if (self.closing.swap(true, .acq_rel)) return;
        _ = posix.write(self.stop_pipe[1], "x") catch {};
        if (self.accept_thread) |t| {
            t.join();
            self.accept_thread = null;
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        // Pairs with Connection.enterIdle: either we see `idle`, or the
        // connection sees `closing` after publishing it.
        var it = self.live;
        while (it) |conn| : (it = conn.next) {
            if (conn.idle.load(.seq_cst)) posix.shutdown(conn.fd, .both) catch {};
        }
        const deadline = std.time.milliTimestamp() + @as(i64, @intCast(timeout_ms));
        while (self.connections > 0) {
            const remaining = deadline - std.time.milliTimestamp();
            if (remaining <= 0) break;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
    }

    /// Waits for upgraded connection threads to finish (after their owner
    /// closed them), then frees the server.
    pub fn deinit(self: *Server) void {
        self.close(10_000);
        self.mutex.lock();
        const deadline = std.time.milliTimestamp() + 35_000;
        while (self.upgraded > 0 or self.connections > 0 or self.lingering > 0) {
            const remaining = deadline - std.time.milliTimestamp();
            if (remaining <= 0) break;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
        const leaked = self.upgraded > 0 or self.connections > 0 or self.lingering > 0;
        self.mutex.unlock();
        posix.close(self.stop_pipe[0]);
        posix.close(self.stop_pipe[1]);
        // Connection threads still reference the server: leak rather than free.
        if (!leaked) self.gpa.destroy(self);
    }

    fn acceptLoop(self: *Server) void {
        defer {
            posix.close(self.listen_fd);
            self.listener_closed = true;
        }
        var backoff_ms: u64 = 10;
        var last_accept_log: i64 = 0;
        while (!self.isClosing()) {
            self.mutex.lock();
            while (self.connections + self.upgraded + self.lingering >= self.options.max_connections and !self.isClosing())
                self.cond.timedWait(&self.mutex, 100 * std.time.ns_per_ms) catch {};
            self.mutex.unlock();
            var fds = [_]posix.pollfd{
                .{ .fd = self.listen_fd, .events = posix.POLL.IN, .revents = 0 },
                .{ .fd = self.stop_pipe[0], .events = posix.POLL.IN, .revents = 0 },
            };
            _ = posix.poll(&fds, -1) catch continue;
            if (fds[1].revents != 0 or self.isClosing()) return;
            if (fds[0].revents == 0) continue;
            var addr: std.net.Address = undefined;
            var addr_len: posix.socklen_t = @sizeOf(std.net.Address);
            const fd = posix.accept(self.listen_fd, &addr.any, &addr_len, posix.SOCK.CLOEXEC) catch |e| {
                switch (e) {
                    error.ConnectionAborted, error.WouldBlock => {},
                    else => {
                        // Persistent failures (EMFILE/ENFILE): back off up to 1 s
                        // and log at most once per second.
                        const now = nowMs();
                        if (now - last_accept_log >= 1000) {
                            log.err("accept failed: {s}", .{@errorName(e)});
                            last_accept_log = now;
                        }
                        std.Thread.sleep(backoff_ms * std.time.ns_per_ms);
                        backoff_ms = @min(backoff_ms * 2, 1000);
                    },
                }
                continue;
            };
            backoff_ms = 10;
            setNoDelay(fd);
            if (builtin.os.tag == .macos) {
                posix.setsockopt(fd, posix.SOL.SOCKET, std.c.SO.NOSIGPIPE, &std.mem.toBytes(@as(c_int, 1))) catch {};
            }
            self.mutex.lock();
            self.connections += 1;
            self.mutex.unlock();
            const thread = std.Thread.spawn(.{ .stack_size = self.options.thread_stack_bytes }, connectionMain, .{ self, fd, addr }) catch |e| {
                log.err("connection thread spawn failed: {s}", .{@errorName(e)});
                posix.close(fd);
                self.connectionEnded(false);
                continue;
            };
            thread.detach();
        }
    }

    fn connectionEnded(self: *Server, upgraded: bool) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (upgraded) self.upgraded -= 1 else self.connections -= 1;
        self.cond.broadcast();
    }

    fn link(self: *Server, conn: *Connection) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        conn.next = self.live;
        if (self.live) |head| head.prev = conn;
        self.live = conn;
    }

    fn unlink(self: *Server, conn: *Connection) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (conn.prev) |p| p.next = conn.next else self.live = conn.next;
        if (conn.next) |n| n.prev = conn.prev;
    }

    fn connectionMain(self: *Server, fd: posix.socket_t, addr: std.net.Address) void {
        var conn: Connection = .{ .server = self, .fd = fd, .remote = addr };
        self.link(&conn);
        const outcome = conn.run();
        self.unlink(&conn);
        switch (outcome) {
            .closed => {
                posix.close(fd);
                self.connectionEnded(false);
            },
            .ended => {
                // The exchange is over: don't hold up `close()` on the peer,
                // but keep the thread within the connection cap.
                const linger_ms = self.options.request_timeout_ms;
                self.mutex.lock();
                self.connections -= 1;
                self.lingering += 1;
                self.cond.broadcast();
                self.mutex.unlock();
                lingerClose(self, fd, linger_ms);
                self.mutex.lock();
                self.lingering -= 1;
                self.cond.broadcast();
                self.mutex.unlock();
            },
            .upgraded => |takeover| {
                self.mutex.lock();
                self.connections -= 1;
                self.upgraded += 1;
                self.cond.broadcast();
                self.mutex.unlock();
                takeover.run(takeover.ctx);
                self.connectionEnded(true);
            },
        }
    }
};

/// Half-closes, then discards input until the peer closes (bounded; cut
/// short once the server is closing).
fn lingerClose(server: *const Server, fd: posix.socket_t, timeout_ms: u32) void {
    defer posix.close(fd);
    posix.shutdown(fd, .send) catch return;
    const deadline = nowMs() + timeout_ms;
    var buf: [16 * 1024]u8 = undefined;
    while (!server.isClosing()) {
        const remaining = deadline - nowMs();
        if (remaining <= 0) return;
        var fds = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.IN, .revents = 0 }};
        const ready = posix.poll(&fds, @intCast(@min(remaining, 100))) catch return;
        if (ready == 0) continue;
        const n = posix.read(fd, &buf) catch return;
        if (n == 0) return;
    }
}

fn setNoDelay(fd: posix.socket_t) void {
    posix.setsockopt(fd, posix.IPPROTO.TCP, posix.TCP.NODELAY, &std.mem.toBytes(@as(c_int, 1))) catch {};
}

fn nowMs() i64 {
    return std.time.milliTimestamp();
}
// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/// `closed`: destroy the socket; `ended`: Node `socket.end()` after a final
/// response (half-close, then read until the peer closes so unread request
/// bytes do not turn into a TCP reset).
const Outcome = union(enum) { closed, ended, upgraded: UpgradeSocket.Takeover };

const ReadError = error{ Timeout, Closed };

/// Node `clientError` handled by Fastify's `defaultClientErrorHandler`.
const ClientError = enum {
    bad_request,
    header_overflow,
    timeout,

    fn bytes(self: ClientError) []const u8 {
        return switch (self) {
            .bad_request => "HTTP/1.1 400 Bad Request\r\nContent-Length: 65\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Bad Request\",\"message\":\"Client Error\",\"statusCode\":400}",
            .header_overflow => "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 114\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Request Header Fields Too Large\",\"message\":\"Exceeded maximum allowed HTTP header size\",\"statusCode\":431}",
            .timeout => "HTTP/1.1 408 Request Timeout\r\nContent-Length: 71\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Request Timeout\",\"message\":\"Client Timeout\",\"statusCode\":408}",
        };
    }
};

const Connection = struct {
    server: *Server,
    fd: posix.socket_t,
    remote: std.net.Address,
    buf: [64 * 1024]u8 = undefined,
    start: usize = 0,
    end: usize = 0,
    /// Waiting for the next keep-alive request (`close` may shut it down).
    idle: std.atomic.Value(bool) = .init(false),
    /// Current SO_RCVTIMEO in ms (0 = none); reads block with this timeout
    /// instead of a poll() per read.
    recv_timeout_ms: ?u32 = null,
    prev: ?*Connection = null,
    next: ?*Connection = null,

    fn run(self: *Connection) Outcome {
        var arena_state = std.heap.ArenaAllocator.init(std.heap.c_allocator);
        defer arena_state.deinit();
        var first = true;
        while (true) {
            _ = arena_state.reset(.{ .retain_with_limit = 256 * 1024 });
            const arena = arena_state.allocator();
            if (self.end == self.start) {
                // Node: a fresh socket gets requestTimeout (-> 408); an idle
                // keep-alive socket is closed silently after keepAliveTimeout.
                if (!first) {
                    self.idle.store(true, .seq_cst);
                    if (self.server.isClosing()) return .closed;
                }
                const timeout = if (first) self.server.options.request_timeout_ms else self.server.options.keep_alive_timeout_ms;
                const got = self.fill(timeout);
                self.idle.store(false, .seq_cst);
                _ = got catch |e| switch (e) {
                    error.Closed => return .closed,
                    error.Timeout => {
                        if (first) self.clientError(.timeout);
                        return .closed;
                    },
                };
            }
            first = false;
            const deadline = nowMs() + @as(i64, self.server.options.request_timeout_ms);
            const head = self.readHead(arena, deadline) catch |e| switch (e) {
                error.Timeout => return self.failClient(.timeout),
                error.HeaderOverflow => return self.failClient(.header_overflow),
                error.BadRequest => return self.failClient(.bad_request),
                error.Closed, error.OutOfMemory => return .closed,
            };
            self.start += head.len;
            const keep = self.exchange(arena, head, deadline) catch return .closed;
            switch (keep) {
                .keep_alive => continue,
                .close => return .closed,
                .end => return .ended,
                .upgraded => |t| return .{ .upgraded = t },
            }
        }
    }

    fn failClient(self: *Connection, kind: ClientError) Outcome {
        self.clientError(kind);
        return .closed;
    }

    fn clientError(self: *Connection, kind: ClientError) void {
        _ = writeFd(self.fd, kind.bytes());
    }

    /// Reads more bytes into `buf` (compacting first). `timeout_ms` 0 waits
    /// indefinitely.
    fn fill(self: *Connection, timeout_ms: u32) ReadError!usize {
        if (self.start == self.end) {
            self.start = 0;
            self.end = 0;
        } else if (self.end == self.buf.len) {
            std.mem.copyForwards(u8, self.buf[0 .. self.end - self.start], self.buf[self.start..self.end]);
            self.end -= self.start;
            self.start = 0;
        }
        if (!self.setRecvTimeout(timeout_ms)) return error.Closed;
        const n = posix.read(self.fd, self.buf[self.end..]) catch |e| switch (e) {
            error.WouldBlock => return error.Timeout,
            else => return error.Closed,
        };
        if (n == 0) return error.Closed;
        self.end += n;
        return n;
    }

    /// False when the timeout could not be set (the connection is dropped
    /// rather than reading with a stale or missing timeout).
    fn setRecvTimeout(self: *Connection, ms: u32) bool {
        if (self.recv_timeout_ms == ms) return true;
        const tv: posix.timeval = .{ .sec = @intCast(ms / 1000), .usec = @intCast((ms % 1000) * 1000) };
        posix.setsockopt(self.fd, posix.SOL.SOCKET, posix.SO.RCVTIMEO, std.mem.asBytes(&tv)) catch |e| {
            log.warn("SO_RCVTIMEO failed: {s}", .{@errorName(e)});
            self.recv_timeout_ms = null;
            return false;
        };
        self.recv_timeout_ms = ms;
        return true;
    }

    /// Time left until `deadline` for a fill (at least 1 ms), or Timeout.
    fn remaining(deadline: i64) ReadError!u32 {
        if (deadline == std.math.maxInt(i64)) return 0;
        const left = deadline - nowMs();
        if (left <= 0) return error.Timeout;
        return @intCast(@min(left, std.math.maxInt(u32)));
    }

    fn readHead(self: *Connection, arena: std.mem.Allocator, deadline: i64) (ReadError || parse.HeadError)!parse.Head {
        while (true) {
            // llhttp skips CRLFs between requests.
            while (self.start < self.end and (self.buf[self.start] == '\r' or self.buf[self.start] == '\n')) self.start += 1;
            switch (try parse.scanHead(self.buf[self.start..self.end])) {
                .complete => |len| return parse.parseHead(arena, self.buf[self.start .. self.start + len]),
                .incomplete => if (self.start == 0 and self.end == self.buf.len) return error.HeaderOverflow,
            }
            _ = try self.fill(try remaining(deadline));
        }
    }

    const Keep = union(enum) { keep_alive, close, end, upgraded: UpgradeSocket.Takeover };

    fn exchange(self: *Connection, arena: std.mem.Allocator, head: parse.Head, deadline: i64) !Keep {
        const server = self.server;
        const q = std.mem.indexOfScalar(u8, head.url, '?');
        var req: Request = .{
            .arena = arena,
            .method = head.method,
            .url = head.url,
            .path = head.url[0 .. q orelse head.url.len],
            .query = if (q) |i| head.url[i + 1 ..] else "",
            .headers = head.headers,
            .remote_address = self.remote,
        };
        // Measured: Node applies requestTimeout to the head only; a stalled
        // body (read by a parser or dumped after the response) never times out.
        _ = deadline;
        var body: BodyReader = .{ .conn = self, .framing = head.framing, .deadline = std.math.maxInt(i64) };
        const ctx: Exchange = .{ .keep_alive = keepAliveRequested(&req, head) };

        // Node: CONNECT and upgrade requests go to their events, unprocessed.
        if (std.mem.eql(u8, req.method, "CONNECT")) return .close;
        if (server.options.upgrade) |handler| if (isUpgrade(&req)) {
            var socket: UpgradeSocket = .{ .fd = self.fd, .head = self.buf[self.start..self.end], .remote_address = self.remote };
            handler.on_upgrade(handler.ctx, &req, &socket);
            if (socket.takeover) |t| return .{ .upgraded = t };
            return .close;
        };

        // Node `requireHostHeader`.
        if (head.major == 1 and head.minor == 1 and req.header("host") == null) {
            var out: std.Io.Writer.Allocating = .init(arena);
            try out.writer.print("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nDate: {s}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", .{httpDate()});
            _ = writeFd(self.fd, out.written());
            return .end;
        }

        // Node `Expect` handling (HTTP/1.1 only, no checkContinue listener).
        if (head.major == 1 and head.minor == 1) if (req.header("expect")) |expect| {
            if (expectsContinue(expect)) {
                if (!writeFd(self.fd, "HTTP/1.1 100 Continue\r\n\r\n")) return .close;
            } else {
                var out: std.Io.Writer.Allocating = .init(arena);
                try out.writer.print("HTTP/1.1 417 Expectation Failed\r\nDate: {s}\r\n", .{httpDate()});
                try self.connectionHeaders(&out.writer, ctx.keep_alive);
                try out.writer.writeAll("Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
                return self.complete(out.written(), ctx.keep_alive, &body);
            }
        };

        // Fastify `return503OnClosing`.
        if (server.isClosing()) {
            var out: std.Io.Writer.Allocating = .init(arena);
            try out.writer.print("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 80\r\nDate: {s}\r\n\r\n{{\"error\":\"Service Unavailable\",\"message\":\"Service Unavailable\",\"statusCode\":503}}", .{httpDate()});
            _ = writeFd(self.fd, out.written());
            return .end;
        }

        // find-my-way lookup (bad URLs answer before any Fastify hook).
        const route = switch (try parse.routerPath(arena, req.url)) {
            .bad_url => |path| {
                const message = try std.fmt.allocPrint(arena, "'{s}' is not a valid url component", .{path});
                const payload = try std.fmt.allocPrint(arena, "{{\"error\":\"Bad Request\",\"code\":\"FST_ERR_BAD_URL\",\"message\":{f},\"statusCode\":400}}", .{core.json.Value{ .string = message }});
                var out: std.Io.Writer.Allocating = .init(arena);
                try out.writer.print("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nDate: {s}\r\n", .{ payload.len, httpDate() });
                try self.connectionHeaders(&out.writer, ctx.keep_alive);
                try out.writer.print("\r\n{s}", .{payload});
                return self.complete(out.written(), ctx.keep_alive, &body);
            },
            .path => |path| matchRoute(server.options.routes, req.method, path),
        };

        var reply: Reply = .{ .arena = arena };

        // @fastify/cors onRequest (root scope: every route incl. 404).
        const origin = req.header("origin");
        reply.header("vary", "Origin");
        if (origin) |o| if (o.len > 0) reply.header("access-control-allow-origin", o);
        if (std.mem.eql(u8, req.method, "OPTIONS")) {
            const acrm = req.header("access-control-request-method");
            if (origin == null or origin.?.len == 0 or acrm == null or acrm.?.len == 0) {
                reply.code(400);
                reply.type("text/plain");
                reply.sendText("Invalid Preflight Request");
            } else {
                reply.header("access-control-allow-methods", "GET,HEAD,POST");
                if (req.header("access-control-request-headers")) |h| reply.header("access-control-allow-headers", h);
                reply.header("vary", "Origin, Access-Control-Request-Headers");
                reply.code(204);
                reply.header("content-length", "0");
                reply.sendEmpty();
            }
            return self.finish(&req, &reply, null, &body, ctx);
        }

        if (route) |r| if (r.hooks.on_request) |hook| {
            hook(r.ctx, &req, &reply);
            if (reply.sent) return self.finish(&req, &reply, route, &body, ctx);
        };

        self.handleRequest(&req, &reply, route, &body) catch |e| {
            if (route) |r| if (r.hooks.on_done) |hook| hook(r.ctx, &req, &reply, .closed);
            switch (e) {
                error.RequestTimeout => self.clientError(.timeout),
                error.BadChunk => self.clientError(.bad_request),
                error.ClientGone => {},
                error.OutOfMemory => return error.OutOfMemory,
            }
            return .close;
        };
        if (!reply.sent) {
            if (route) |r| {
                r.hooks.handler(r.ctx, &req, &reply);
                if (!reply.sent) reply.sendEmpty();
            } else notFound(&req, &reply);
        }
        return self.finish(&req, &reply, route, &body, ctx);
    }

    /// Fastify `handleRequest` + content-type parsing. Sends framework errors
    /// on `reply`; otherwise leaves the reply unsent for the handler.
    fn handleRequest(self: *Connection, req: *Request, reply: *Reply, route: ?*const Route, body: *BodyReader) error{ RequestTimeout, BadChunk, ClientGone, OutOfMemory }!void {
        _ = self;
        const method = req.method;
        if (isBodyless(method)) return;
        if (!isBodyWith(method)) return;
        const ct_header = req.header("content-type");
        const empty = req.header("transfer-encoding") == null and
            (req.header("content-length") == null or std.mem.eql(u8, req.header("content-length").?, "0"));
        if (std.mem.eql(u8, method, "QUERY")) {
            if (ct_header == null) return reply.sendError(.{ .status = 400, .code = "FST_ERR_ROUTE_MISSING_CONTENT_TYPE", .message = "Method 'QUERY' must provide a 'Content-Type' header." });
            if (empty) return reply.sendError(.{ .status = 400, .code = "FST_ERR_ROUTE_MISSING_CONTENT", .message = "Method 'QUERY' must provide a request body." });
        }
        const Kind = enum { json, text };
        var kind: Kind = undefined;
        if (ct_header) |ct| {
            const media = parse.mediaType(req.arena, ct) orelse return reply.sendError(FastifyError.invalid_media_type);
            if (std.mem.eql(u8, media, "application/json")) {
                kind = .json;
            } else if (std.mem.eql(u8, media, "text/plain")) {
                kind = .text;
            } else {
                const extra = if (route) |r| r.text_content_types else &.{};
                for (extra) |t| {
                    if (std.mem.eql(u8, media, t)) break;
                } else {
                    // No parser: the 404 handler ignores the body; routes 415.
                    if (route == null) return;
                    return reply.sendError(FastifyError.invalid_media_type);
                }
                kind = .text;
            }
        } else {
            if (empty) return;
            if (route == null) return;
            return reply.sendError(FastifyError.invalid_media_type);
        }

        const limit = if (route) |r| r.body_limit else default_body_limit;
        // Parser failures close the connection: the client may still be sending.
        switch (body.framing) {
            .length => |n| if (n > limit) return parserError(reply, FastifyError.body_too_large),
            else => {},
        }
        const raw = body.readAll(req.arena, limit) catch |e| switch (e) {
            error.TooLarge => return parserError(reply, FastifyError.body_too_large),
            error.Timeout => return error.RequestTimeout,
            error.Closed => return error.ClientGone,
            error.BadRequest => return error.BadChunk,
            error.OutOfMemory => return error.OutOfMemory,
        };
        req.raw_body = raw;
        req.complete = true;
        // `setEncoding('utf8')`: invalid sequences become U+FFFD, and Fastify
        // then compares the decoded byte length with Content-Length.
        const text = try core.json.toWellFormedUtf8(req.arena, raw);
        switch (body.framing) {
            .length => |n| if (text.len != n) return parserError(reply, FastifyError.invalid_content_length),
            else => {},
        }
        switch (kind) {
            .text => req.body = .{ .text = text },
            .json => {
                if (text.len == 0) return parserError(reply, FastifyError.empty_json_body);
                const value = core.json.parse(req.arena, text, .{ .secure = true, .strip_bom = true }) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                    error.SyntaxError => return parserError(reply, FastifyError.invalid_json_body),
                };
                req.body = .{ .json = value };
            },
        }
    }

    fn finish(self: *Connection, req: *Request, reply: *Reply, route: ?*const Route, body: *BodyReader, ctx: Exchange) !Keep {
        const arena = req.arena;
        if (body.framing == .none) req.complete = true;
        if (reply.error_value) |err| {
            reply.error_value = null;
            if (reply.status < 400) reply.status = err.status;
            reply.sent = false;
            if (route) |r| if (r.hooks.error_handler) |handler| handler(r.ctx, req, reply, err);
            if (!reply.sent or reply.error_value != null) defaultErrorBody(reply, err);
        }
        if (route) |r| if (r.hooks.on_send) |hook| hook(r.ctx, req, reply);

        const is_head = std.mem.eql(u8, req.method, "HEAD");
        switch (reply.payload) {
            .none => if (reply.status >= 200 and reply.status != 204 and reply.status != 304 and !is_head and reply.getHeader("content-length") == null) reply.header("content-length", "0"),
            .bytes => |b| {
                const existing = reply.getHeader("content-length");
                const len_text = try std.fmt.allocPrint(arena, "{d}", .{b.len});
                if (existing == null or (!is_head and !std.mem.eql(u8, existing.?, len_text))) reply.header("content-length", len_text);
            },
        }

        var keep_alive = ctx.keep_alive and !self.server.isClosing();
        const user_connection = reply.getHeader("connection");
        if (user_connection) |c| {
            if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, c, " "), "close")) keep_alive = false;
        }
        const payload = reply.body() orelse "";
        var out: std.Io.Writer.Allocating = try .initCapacity(arena, 512);
        const w = &out.writer;
        try w.print("HTTP/1.1 {d} {s}\r\n", .{ reply.status, statusText(reply.status) });
        for (reply.headers.items) |h| try w.print("{s}: {s}\r\n", .{ h.name, h.value });
        try w.print("Date: {s}\r\n", .{httpDate()});
        if (user_connection == null) try self.connectionHeaders(w, keep_alive);
        try w.writeAll("\r\n");
        const send_body = !is_head and reply.status != 204 and reply.status != 304;
        // Head and body go out in one sendmsg; the body is never copied.
        const written = writeVecFd(self.fd, &.{ out.written(), if (send_body) payload else "" });
        if (route) |r| if (r.hooks.on_done) |hook| hook(r.ctx, req, reply, if (written) .finished else .closed);
        if (!written or reply.destroy_after) return .close;
        return self.afterResponse(keep_alive, body);
    }

    /// Writes a response that bypasses Fastify, then continues like `finish`.
    fn complete(self: *Connection, bytes: []const u8, keep_alive: bool, body: *BodyReader) Keep {
        if (!writeFd(self.fd, bytes)) return .close;
        return self.afterResponse(keep_alive and !self.server.isClosing(), body);
    }

    /// Node dumps an unconsumed request body after the response, keeping the
    /// connection; a malformed or late body becomes a client error.
    fn afterResponse(self: *Connection, keep_alive: bool, body: *BodyReader) Keep {
        // llhttp reports HPE_INVALID_TRANSFER_ENCODING as soon as the request
        // was dispatched, so the client error follows even `Connection: close`.
        if (body.framing == .invalid_te and !body.finished) {
            self.clientError(.bad_request);
            return .close;
        }
        if (!keep_alive) return .end;
        body.drain() catch |e| switch (e) {
            error.BadRequest => {
                self.clientError(.bad_request);
                return .close;
            },
            error.Timeout => {
                self.clientError(.timeout);
                return .close;
            },
            error.Closed => return .close,
        };
        return .keep_alive;
    }

    fn connectionHeaders(self: *Connection, w: *std.Io.Writer, keep_alive: bool) !void {
        if (keep_alive) {
            try w.print("Connection: keep-alive\r\nKeep-Alive: timeout={d}\r\n", .{self.server.options.keep_alive_timeout_ms / 1000});
        } else try w.writeAll("Connection: close\r\n");
    }
};

const default_body_limit = 100 * 1024;

const Exchange = struct { keep_alive: bool };

fn parserError(reply: *Reply, err: FastifyError) void {
    reply.header("connection", "close");
    reply.sendError(err);
}

/// Fastify's default 404 handler.
fn notFound(req: *Request, reply: *Reply) void {
    reply.code(404);
    const message = std.fmt.allocPrint(req.arena, "Route {s}:{s} not found", .{ req.method, req.url }) catch "";
    var members = [_]core.json.Member{
        .{ .key = "message", .value = .{ .string = message } },
        .{ .key = "error", .value = .{ .string = "Not Found" } },
        .{ .key = "statusCode", .value = .{ .number = 404 } },
    };
    reply.sendJson(.{ .object = &members });
}

pub fn writeFd(fd: posix.socket_t, bytes: []const u8) bool {
    var off: usize = 0;
    while (off < bytes.len) {
        const flags: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
        const n = posix.send(fd, bytes[off..], flags) catch return false;
        off += n;
    }
    return true;
}

/// Writes all `parts` with as few `sendmsg` calls as possible.
pub fn writeVecFd(fd: posix.socket_t, parts: []const []const u8) bool {
    var iov_buf: [4]posix.iovec_const = undefined;
    std.debug.assert(parts.len <= iov_buf.len);
    var count: usize = 0;
    for (parts) |part| if (part.len > 0) {
        iov_buf[count] = .{ .base = part.ptr, .len = part.len };
        count += 1;
    };
    var iov: []posix.iovec_const = iov_buf[0..count];
    const flags: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
    while (iov.len > 0) {
        const msg: posix.msghdr_const = .{
            .name = null,
            .namelen = 0,
            .iov = iov.ptr,
            .iovlen = @intCast(iov.len),
            .control = null,
            .controllen = 0,
            .flags = 0,
        };
        var n = posix.sendmsg(fd, &msg, flags) catch return false;
        while (iov.len > 0 and n >= iov[0].len) {
            n -= iov[0].len;
            iov = iov[1..];
        }
        if (n > 0) {
            iov[0].base += n;
            iov[0].len -= n;
        }
    }
    return true;
}

fn defaultErrorBody(reply: *Reply, err: FastifyError) void {
    if (reply.getHeader("content-type") == null) reply.header("content-type", "application/json; charset=utf-8");
    const payload = std.fmt.allocPrint(reply.arena, "{{\"statusCode\":{d},\"code\":{f},\"error\":{f},\"message\":{f}}}", .{
        reply.status,
        core.json.Value{ .string = err.code },
        core.json.Value{ .string = statusText(reply.status) },
        core.json.Value{ .string = err.message },
    }) catch "";
    reply.payload = .{ .bytes = payload };
    reply.sent = true;
}

const BodyReader = struct {
    conn: *Connection,
    framing: parse.Framing,
    deadline: i64,
    finished: bool = false,

    const Error = ReadError || error{ BadRequest, TooLarge, OutOfMemory };

    fn done(self: *const BodyReader) bool {
        return self.finished or self.framing == .none;
    }

    /// Reads the whole body; fails with TooLarge beyond `limit` bytes.
    fn readAll(self: *BodyReader, a: std.mem.Allocator, limit: usize) Error![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        try self.consume(a, &out, limit);
        return out.items;
    }

    /// Node `req._dump()`: discard whatever body remains.
    fn drain(self: *BodyReader) (ReadError || error{BadRequest})!void {
        self.consume(null, null, std.math.maxInt(usize)) catch |e| switch (e) {
            error.TooLarge, error.OutOfMemory => unreachable,
            else => |err| return err,
        };
    }

    /// Walks the body framing, appending to `out` when given.
    fn consume(self: *BodyReader, a: ?std.mem.Allocator, out: ?*std.ArrayList(u8), limit: usize) Error!void {
        if (self.done()) return;
        const c = self.conn;
        switch (self.framing) {
            .none => {},
            // HPE_INVALID_TRANSFER_ENCODING right after dispatch.
            .invalid_te => return error.BadRequest,
            .length => |n| {
                if (out) |o| try o.ensureTotalCapacity(a.?, @intCast(n));
                var remaining = n;
                while (remaining > 0) {
                    if (c.end == c.start) _ = try c.fill(try Connection.remaining(self.deadline));
                    const take: usize = @intCast(@min(remaining, c.end - c.start));
                    if (out) |o| o.appendSliceAssumeCapacity(c.buf[c.start .. c.start + take]);
                    c.start += take;
                    remaining -= take;
                }
            },
            .chunked => {
                var total: usize = 0;
                while (true) {
                    const line = try self.readLine();
                    const size64 = parse.parseChunkSize(line) orelse return error.BadRequest;
                    const size = std.math.cast(usize, size64) orelse return error.BadRequest;
                    if (size == 0) {
                        while (true) {
                            const trailer = try self.readLine();
                            if (trailer.len == 0) break;
                            if (!parse.validTrailer(trailer)) return error.BadRequest;
                        }
                        break;
                    }
                    total +|= size;
                    if (total > limit) return error.TooLarge;
                    var remaining = size;
                    while (remaining > 0) {
                        if (c.end == c.start) _ = try c.fill(try Connection.remaining(self.deadline));
                        const take = @min(remaining, c.end - c.start);
                        if (out) |o| try o.appendSlice(a.?, c.buf[c.start .. c.start + take]);
                        c.start += take;
                        remaining -= take;
                    }
                    if ((try self.readLine()).len != 0) return error.BadRequest;
                }
            },
        }
        self.finished = true;
    }

    fn readLine(self: *BodyReader) (ReadError || error{BadRequest})![]const u8 {
        const c = self.conn;
        while (true) {
            if (std.mem.indexOfScalar(u8, c.buf[c.start..c.end], '\n')) |pos| {
                if (pos == 0 or c.buf[c.start + pos - 1] != '\r') return error.BadRequest;
                const line = c.buf[c.start .. c.start + pos - 1];
                c.start += pos + 1;
                return line;
            }
            if (c.end - c.start > 4096) return error.BadRequest;
            _ = try c.fill(try Connection.remaining(self.deadline));
        }
    }
};

/// llhttp `should_keep_alive` for the request.
fn keepAliveRequested(req: *const Request, head: parse.Head) bool {
    const http11 = head.major > 0 and head.minor > 0;
    const c = req.header("connection") orelse return http11;
    var keep = false;
    var it = std.mem.splitScalar(u8, c, ',');
    while (it.next()) |tok| {
        const t = std.mem.trim(u8, tok, " \t");
        if (std.ascii.eqlIgnoreCase(t, "close")) return false;
        if (std.ascii.eqlIgnoreCase(t, "keep-alive")) keep = true;
    }
    return http11 or keep;
}

/// Node `continueExpression`: /(?:^|\W)100-continue(?:$|\W)/i.
fn expectsContinue(expect: []const u8) bool {
    const needle = "100-continue";
    var i: usize = 0;
    while (i + needle.len <= expect.len) : (i += 1) {
        if (!std.ascii.eqlIgnoreCase(expect[i .. i + needle.len], needle)) continue;
        const before_ok = i == 0 or !isWordChar(expect[i - 1]);
        const after = i + needle.len;
        const after_ok = after == expect.len or !isWordChar(expect[after]);
        if (before_ok and after_ok) return true;
    }
    return false;
}

fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

fn isUpgrade(req: *const Request) bool {
    if (req.header("upgrade") == null) return false;
    const c = req.header("connection") orelse return false;
    var it = std.mem.splitScalar(u8, c, ',');
    while (it.next()) |tok| if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, tok, " \t"), "upgrade")) return true;
    return false;
}

fn isBodyless(method: []const u8) bool {
    return std.mem.eql(u8, method, "GET") or std.mem.eql(u8, method, "HEAD") or std.mem.eql(u8, method, "TRACE");
}

fn isBodyWith(method: []const u8) bool {
    for ([_][]const u8{ "DELETE", "OPTIONS", "PATCH", "PUT", "POST", "QUERY" }) |m| if (std.mem.eql(u8, m, method)) return true;
    return false;
}

/// Static route lookup on a `parse.routerPath` result; GET routes answer HEAD.
pub fn matchRoute(routes: []const Route, method: []const u8, path: []const u8) ?*const Route {
    for (routes) |*r| {
        if (!std.mem.eql(u8, r.path, path)) continue;
        for (r.methods) |m| {
            if (std.mem.eql(u8, m, method)) return r;
            if (std.mem.eql(u8, m, "GET") and std.mem.eql(u8, method, "HEAD")) return r;
        }
    }
    return null;
}

pub fn statusText(status: u16) []const u8 {
    return switch (status) {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        417 => "Expectation Failed",
        422 => "Unprocessable Entity",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        else => "Unknown",
    };
}

/// RFC 7231 IMF-fixdate (Node `Date` header), cached per second per thread.
threadlocal var date_cache_second: i64 = -1;
threadlocal var date_cache: [29]u8 = undefined;

pub fn httpDate() []const u8 {
    const now = std.time.timestamp();
    if (now != date_cache_second) {
        date_cache_second = now;
        const es: std.time.epoch.EpochSeconds = .{ .secs = @intCast(now) };
        const day = es.getEpochDay();
        const yd = day.calculateYearDay();
        const md = yd.calculateMonthDay();
        const ds = es.getDaySeconds();
        const weekday = @mod(day.day + 4, 7); // 1970-01-01 was a Thursday
        const days = [_][]const u8{ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
        const months = [_][]const u8{ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        _ = std.fmt.bufPrint(&date_cache, "{s}, {d:0>2} {s} {d} {d:0>2}:{d:0>2}:{d:0>2} GMT", .{
            days[weekday],        md.day_index + 1,        months[md.month.numeric() - 1], yd.year,
            ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute(),
        }) catch {};
    }
    return &date_cache;
}

test "expectsContinue mirrors Node's continueExpression" {
    try std.testing.expect(expectsContinue("100-continue"));
    try std.testing.expect(expectsContinue("100-Continue, foo"));
    try std.testing.expect(!expectsContinue("x100-continue"));
    try std.testing.expect(!expectsContinue("foo"));
}

test "httpDate format" {
    const d = httpDate();
    try std.testing.expectEqual(@as(usize, 29), d.len);
    try std.testing.expect(std.mem.endsWith(u8, d, " GMT"));
}
