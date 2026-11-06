//! Loopback-only native WebSocket fixture used by delegated tests.
const std = @import("std");
const A = std.mem.Allocator;
pub const Script = enum { full, reconnect, eof, silent, plain, partial_control, coalesced, message_limit, wait_probe };
pub const Server = struct {
    listener: std.net.Server,
    script: Script,
    thread: ?std.Thread = null,
    failure: ?anyerror = null,
    stopping: std.atomic.Value(bool) = .init(false),
    waiting_accept: std.atomic.Value(bool) = .init(false),
    accepted_count: std.atomic.Value(usize) = .init(0),
    mutex: std.Thread.Mutex = .{},
    active_socket: ?std.posix.socket_t = null,

    pub fn init(script: Script) !Server {
        return .{ .listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{ .force_nonblocking = true }), .script = script };
    }
    pub fn url(self: *Server, a: A, secure: bool) ![]u8 {
        return std.fmt.allocPrint(a, "{s}://127.0.0.1:{d}/events?fixture=public", .{ if (secure) "wss" else "ws", self.listener.listen_address.getPort() });
    }
    pub fn start(self: *Server) !void {
        self.thread = try std.Thread.spawn(.{}, Server.serve, .{self});
    }
    pub fn deinit(self: *Server) void {
        self.stopping.store(true, .release);
        // The fixture worker alone closes accepted fds. Under this lock, shutdown
        // cannot race a close/fd reuse; it wakes blocked handshake/frame I/O.
        self.mutex.lock();
        if (self.active_socket) |fd| std.posix.shutdown(fd, .both) catch {};
        self.mutex.unlock();
        if (self.thread) |thread| thread.join();
        // Keep the nonblocking listener live until its bounded poll has retired.
        // Closing it from this thread does not reliably wake accept on macOS.
        self.listener.deinit();
        if (self.failure) |err| if (err != error.ConnectionAborted) std.debug.panic("WebSocket fixture failed: {s}", .{@errorName(err)});
    }
    fn serve(self: *Server) void {
        self.run() catch |err| {
            const cancelled_io = switch (err) {
                error.FixtureStopped, error.FrameEof, error.HandshakeEof, error.ConnectionResetByPeer, error.ConnectionAborted, error.BrokenPipe, error.SocketNotConnected => true,
                else => false,
            };
            if (!self.stopping.load(.acquire) or !cancelled_io) self.failure = err;
        };
    }
    fn acceptConnection(self: *Server) !std.net.Server.Connection {
        self.waiting_accept.store(true, .release);
        defer self.waiting_accept.store(false, .release);
        while (!self.stopping.load(.acquire)) {
            var fds = [_]std.posix.pollfd{.{ .fd = self.listener.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 100) == 0) continue;
            const connection = self.listener.accept() catch |err| {
                if (err == error.WouldBlock) continue;
                return err;
            };
            self.mutex.lock();
            if (self.stopping.load(.acquire)) {
                self.mutex.unlock();
                connection.stream.close();
                return error.FixtureStopped;
            }
            self.active_socket = connection.stream.handle;
            self.mutex.unlock();
            errdefer self.closeConnection(connection.stream);
            // Darwin may inherit the listener's O_NONBLOCK on accepted sockets;
            // scripts retain blocking writes plus their explicit read polls.
            const flags = try std.posix.fcntl(connection.stream.handle, std.posix.F.GETFL, 0);
            _ = try std.posix.fcntl(connection.stream.handle, std.posix.F.SETFL, flags & ~@as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
            _ = self.accepted_count.fetchAdd(1, .acq_rel);
            return connection;
        }
        return error.FixtureStopped;
    }
    fn closeConnection(self: *Server, stream: std.net.Stream) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        std.debug.assert(self.active_socket == stream.handle);
        self.active_socket = null;
        stream.close();
    }
    fn run(self: *Server) !void {
        switch (self.script) {
            .full => try self.full(),
            .reconnect => for (0..2) |_| try self.simple(),
            .eof => {
                const connection = try self.acceptConnection();
                defer self.closeConnection(connection.stream);
                try self.handshake(connection.stream);
            },
            .silent => {
                const connection = try self.acceptConnection();
                defer self.closeConnection(connection.stream);
                std.Thread.sleep(100 * std.time.ns_per_ms);
            },
            .plain => {
                const connection = try self.acceptConnection();
                defer self.closeConnection(connection.stream);
                var buffer: [1024]u8 = undefined;
                _ = try connection.stream.read(&buffer);
            },
            .partial_control => try self.partialControl(),
            .coalesced => try self.coalesced(),
            .message_limit => try self.messageLimit(),
            .wait_probe => try self.waitProbe(),
        }
    }
    fn waitProbe(self: *Server) !void {
        const connection = try self.acceptConnection();
        defer self.closeConnection(connection.stream);
        const stream = connection.stream;
        try self.handshake(stream);
        try stream.writeAll(&.{ 0x81, 2, '{' });
        std.Thread.sleep(30 * std.time.ns_per_ms);
        try stream.writeAll(&.{'}'});
        try writeFrame(stream, 0x8, &.{ 0x03, 0xe8 });
    }
    fn simple(self: *Server) !void {
        const connection = try self.acceptConnection();
        defer self.closeConnection(connection.stream);
        try self.handshake(connection.stream);
        try writeFrame(connection.stream, 0x1, "{\"type\":\"ready\"}");
        try writeFrame(connection.stream, 0x8, &.{ 0x03, 0xe8 });
        const close_frame = try readFrame(std.testing.allocator, connection.stream);
        defer close_frame.deinit(std.testing.allocator);
    }
    fn partialControl(self: *Server) !void {
        const connection = try self.acceptConnection();
        defer self.closeConnection(connection.stream);
        const stream = connection.stream;
        try self.handshake(stream);
        std.Thread.sleep(20 * std.time.ns_per_ms);
        try writeFrame(stream, 0x9, "abc");
        const app = try readFrame(std.testing.allocator, stream);
        defer app.deinit(std.testing.allocator);
        try std.testing.expectEqual(@as(u8, 0x1), app.opcode);
        try std.testing.expectEqual(@as(usize, 512 * 1024), app.payload.len);
        for (app.payload) |byte| try std.testing.expectEqual(@as(u8, 'x'), byte);
        const pong = try readFrame(std.testing.allocator, stream);
        defer pong.deinit(std.testing.allocator);
        try std.testing.expectEqual(@as(u8, 0xA), pong.opcode);
        try std.testing.expectEqualStrings("abc", pong.payload);
        try writeFrame(stream, 0x8, &.{ 0x03, 0xe8 });
        const close_frame = try readFrame(std.testing.allocator, stream);
        defer close_frame.deinit(std.testing.allocator);
    }
    fn coalesced(self: *Server) !void {
        const connection = try self.acceptConnection();
        defer self.closeConnection(connection.stream);
        const stream = connection.stream;
        try self.handshake(stream);
        const large = try std.testing.allocator.alloc(u8, 70 * 1024);
        defer std.testing.allocator.free(large);
        @memset(large, 'a');
        try writeSized(stream, 0x1, large, true);
        try writeSized(stream, 0x1, &.{0xe2}, false);
        try writeSized(stream, 0x0, &.{ 0x82, 0xac }, true);
        try writeFrame(stream, 0x8, &.{ 0x03, 0xe8 });
        const close_frame = try readFrame(std.testing.allocator, stream);
        defer close_frame.deinit(std.testing.allocator);
    }
    fn messageLimit(self: *Server) !void {
        const connection = try self.acceptConnection();
        defer self.closeConnection(connection.stream);
        const stream = connection.stream;
        try self.handshake(stream);
        try writeSized(stream, 0x1, "01234567890123456789", true);
    }
    fn full(self: *Server) !void {
        const connection = try self.acceptConnection();
        defer self.closeConnection(connection.stream);
        const stream = connection.stream;
        try self.handshake(stream);
        const ready = "{\"type\":\"ready\"}";
        var first = [_]u8{ 0x01, 8 };
        try stream.writeAll(&first);
        try stream.writeAll(ready[0..8]);
        var ping = [_]u8{ 0x89, 3, 'a' };
        try stream.writeAll(&ping);
        std.Thread.sleep(std.time.ns_per_ms);
        var remaining = [_]u8{ 'b', 'c', 0x80, @intCast(ready.len - 8) };
        try stream.writeAll(&remaining);
        try stream.writeAll(ready[8..]);
        const pong = try readFrame(std.testing.allocator, stream);
        defer pong.deinit(std.testing.allocator);
        try std.testing.expectEqual(@as(u8, 0xA), pong.opcode);
        try std.testing.expectEqualStrings("abc", pong.payload);
        const subscribe = try readFrame(std.testing.allocator, stream);
        defer subscribe.deinit(std.testing.allocator);
        try std.testing.expectEqual(@as(u8, 0x1), subscribe.opcode);
        try std.testing.expect(subscribe.payload.len > 16000);
        try writeFrame(stream, 0x8, &.{ 0x03, 0xe8 });
        const close = try readFrame(std.testing.allocator, stream);
        defer close.deinit(std.testing.allocator);
        try std.testing.expectEqual(@as(u8, 0x8), close.opcode);
    }
    fn handshake(_: *Server, stream: std.net.Stream) !void {
        var request: [16 * 1024]u8 = undefined;
        var used: usize = 0;
        while (std.mem.indexOf(u8, request[0..used], "\r\n\r\n") == null) {
            if (used == request.len) return error.HandshakeTooLarge;
            try waitRead(stream);
            const count = try stream.read(request[used..]);
            if (count == 0) return error.HandshakeEof;
            used += count;
        }
        const key_start = std.mem.indexOf(u8, request[0..used], "Sec-WebSocket-Key: ") orelse return error.MissingWebsocketKey;
        const key_end = std.mem.indexOfPos(u8, request[0..used], key_start, "\r\n") orelse return error.MissingWebsocketKey;
        const key = request[key_start + "Sec-WebSocket-Key: ".len .. key_end];
        var hasher = std.crypto.hash.Sha1.init(.{});
        hasher.update(key);
        hasher.update("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        var digest: [20]u8 = undefined;
        hasher.final(&digest);
        var accept: [28]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&accept, &digest);
        var response: [512]u8 = undefined;
        const text = try std.fmt.bufPrint(&response, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{accept});
        try stream.writeAll(text);
    }
};

const Frame = struct {
    allocator: A,
    opcode: u8,
    payload: []u8,
    fn deinit(self: Frame, a: A) void {
        a.free(self.payload);
    }
};
fn waitRead(stream: std.net.Stream) !void {
    var fds = [_]std.posix.pollfd{.{ .fd = stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
    if (try std.posix.poll(&fds, 5000) == 0) return error.FixtureReadTimeout;
}
fn readExact(stream: std.net.Stream, bytes: []u8) !void {
    var used: usize = 0;
    while (used < bytes.len) {
        try waitRead(stream);
        const count = try stream.read(bytes[used..]);
        if (count == 0) return error.FrameEof;
        used += count;
    }
}
fn readFrame(a: A, stream: std.net.Stream) !Frame {
    var header: [10]u8 = undefined;
    try readExact(stream, header[0..2]);
    const opcode = header[0] & 0x0f;
    if (header[1] & 0x80 == 0) return error.UnmaskedClientFrame;
    var length: u64 = header[1] & 0x7f;
    if (length == 126) {
        try readExact(stream, header[2..4]);
        length = std.mem.readInt(u16, header[2..4], .big);
    } else if (length == 127) {
        try readExact(stream, header[2..10]);
        length = std.mem.readInt(u64, header[2..10], .big);
    }
    var mask: [4]u8 = undefined;
    try readExact(stream, &mask);
    const payload = try a.alloc(u8, std.math.cast(usize, length) orelse return error.FrameTooLarge);
    errdefer a.free(payload);
    try readExact(stream, payload);
    for (payload, 0..) |*byte, index| byte.* ^= mask[index % 4];
    return .{ .allocator = a, .opcode = opcode, .payload = payload };
}
fn writeSized(stream: std.net.Stream, opcode: u8, payload: []const u8, final: bool) !void {
    var header: [10]u8 = undefined;
    var length: usize = 2;
    header[0] = (if (final) @as(u8, 0x80) else 0) | opcode;
    if (payload.len < 126) {
        header[1] = @intCast(payload.len);
    } else if (payload.len <= std.math.maxInt(u16)) {
        header[1] = 126;
        std.mem.writeInt(u16, header[2..4], @intCast(payload.len), .big);
        length = 4;
    } else {
        header[1] = 127;
        std.mem.writeInt(u64, header[2..10], payload.len, .big);
        length = 10;
    }
    try stream.writeAll(header[0..length]);
    try stream.writeAll(payload);
}
fn writeFrame(stream: std.net.Stream, opcode: u8, payload: []const u8) !void {
    if (payload.len > 125) return error.FixtureFrameTooLarge;
    try stream.writeAll(&.{ 0x80 | opcode, @intCast(payload.len) });
    try stream.writeAll(payload);
}

fn awaitFixture(condition: *const std.atomic.Value(bool)) !void {
    var timer = try std.time.Timer.start();
    while (!condition.load(.acquire)) {
        if (timer.read() > std.time.ns_per_s) return error.FixtureStartDeadline;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}
test "fixture teardown wakes accept when a test aborts before any expected reconnect connection" {
    var server = try Server.init(.reconnect);
    var live = true;
    defer if (live) server.deinit();
    try server.start();
    try awaitFixture(&server.waiting_accept);
    var timer = try std.time.Timer.start();
    server.deinit();
    live = false;
    try std.testing.expect(timer.read() < std.time.ns_per_s);
    try std.testing.expectEqual(@as(usize, 0), server.accepted_count.load(.acquire));
}
test "fixture teardown shuts down an active incomplete handshake without closing a reused descriptor" {
    var server = try Server.init(.full);
    var live = true;
    defer if (live) server.deinit();
    try server.start();
    var client = try std.net.tcpConnectToAddress(server.listener.listen_address);
    defer client.close();
    var timer = try std.time.Timer.start();
    while (server.accepted_count.load(.acquire) == 0) {
        if (timer.read() > std.time.ns_per_s) return error.FixtureStartDeadline;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    timer.reset();
    server.deinit();
    live = false;
    try std.testing.expect(timer.read() < std.time.ns_per_s);
}
test "fixture teardown retires reconnect accept after only the first expected connection completes" {
    var server = try Server.init(.reconnect);
    var live = true;
    defer if (live) server.deinit();
    try server.start();
    var client = try std.net.tcpConnectToAddress(server.listener.listen_address);
    defer client.close();
    try client.writeAll("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    var response: [1024]u8 = undefined;
    var received: usize = 0;
    while (std.mem.indexOf(u8, response[0..received], "\r\n\r\n") == null) {
        try waitRead(client);
        const count = try client.read(response[received..]);
        if (count == 0) return error.HandshakeEof;
        received += count;
    }
    try client.writeAll(&.{ 0x88, 0x80, 0, 0, 0, 0 });
    try awaitFixture(&server.waiting_accept);
    try std.testing.expectEqual(@as(usize, 1), server.accepted_count.load(.acquire));
    var timer = try std.time.Timer.start();
    server.deinit();
    live = false;
    try std.testing.expect(timer.read() < std.time.ns_per_s);
}
