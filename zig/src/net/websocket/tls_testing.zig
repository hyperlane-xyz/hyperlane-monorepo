//! Loopback-only OpenSSL peer for real WSS verification tests.
const std = @import("std");
const A = std.mem.Allocator;
pub const Certificate = enum { localhost, otherhost };
pub const Server = struct {
    allocator: A,
    child: ?std.process.Child = null,
    port: u16,
    temporary: std.testing.TmpDir,
    ca_path: []u8,
    key_path: []u8,

    pub fn init(a: A, certificate: Certificate) !Server {
        var temporary = std.testing.tmpDir(.{});
        errdefer temporary.cleanup();
        const directory = try temporary.dir.realpathAlloc(a, ".");
        defer a.free(directory);
        const ca_path = try std.fs.path.join(a, &.{ directory, "cert.pem" });
        errdefer a.free(ca_path);
        const key_path = try std.fs.path.join(a, &.{ directory, "key.pem" });
        errdefer a.free(key_path);
        const common_name, const san = switch (certificate) {
            .localhost => .{ "localhost", "DNS:localhost,IP:127.0.0.1" },
            .otherhost => .{ "otherhost", "DNS:otherhost,IP:192.0.2.1" },
        };
        const generated = try std.process.Child.run(.{
            .allocator = a,
            .argv = &.{
                "openssl",             "req",     "-x509",                  "-newkey", "rsa:2048", "-sha256", "-nodes",
                "-keyout",             key_path,  "-out",                   ca_path,   "-days",    "1",       "-subj",
                "/CN=" ++ common_name, "-addext", "subjectAltName=" ++ san,
            },
            .max_output_bytes = 64 * 1024,
        });
        defer a.free(generated.stdout);
        defer a.free(generated.stderr);
        if (generated.term != .Exited or generated.term.Exited != 0) return error.FixtureCertificateFailed;

        var probe = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{});
        const port = probe.listen_address.getPort();
        probe.deinit();
        const address = try std.fmt.allocPrint(a, "127.0.0.1:{d}", .{port});
        defer a.free(address);
        var child = std.process.Child.init(&.{ "openssl", "s_server", "-accept", address, "-cert", ca_path, "-key", key_path, "-quiet" }, a);
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Ignore;
        try child.spawn();
        errdefer {
            _ = child.kill() catch {};
            _ = child.wait() catch {};
        }
        std.Thread.sleep(100 * std.time.ns_per_ms);
        return .{ .allocator = a, .child = child, .port = port, .temporary = temporary, .ca_path = ca_path, .key_path = key_path };
    }

    pub fn url(self: *Server, a: A) ![]u8 {
        return std.fmt.allocPrint(a, "wss://127.0.0.1:{d}/events", .{self.port});
    }

    pub fn caPath(self: *Server, _: Certificate) []const u8 {
        return self.ca_path;
    }

    pub fn completeHandshake(self: *Server, large: bool) !void {
        const child = &self.child.?;
        var request: [16 * 1024]u8 = undefined;
        var used: usize = 0;
        while (std.mem.indexOf(u8, request[0..used], "\r\n\r\n") == null) {
            if (used == request.len) return error.TlsHandshakeTooLarge;
            var fds = [_]std.posix.pollfd{.{ .fd = child.stdout.?.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 5000) == 0) return error.TlsHandshakeTimeout;
            const count = try std.posix.read(child.stdout.?.handle, request[used..]);
            if (count == 0) return error.TlsHandshakeEof;
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
        const text = try std.fmt.bufPrint(&response, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{accept});
        _ = try std.posix.write(child.stdin.?.handle, text);
        if (large) {
            const payload = try self.allocator.alloc(u8, 256 * 1024);
            defer self.allocator.free(payload);
            @memset(payload, 'x');
            const stream: std.fs.File = .{ .handle = child.stdin.?.handle };
            var header: [10]u8 = undefined;
            header[0] = 0x81;
            header[1] = 127;
            std.mem.writeInt(u64, header[2..10], payload.len, .big);
            try stream.writeAll(&header);
            try stream.writeAll(payload);
        }
    }

    pub fn deinit(self: *Server) void {
        if (self.child) |*child| {
            _ = child.kill() catch {};
            _ = child.wait() catch {};
        }
        self.child = null;
        self.allocator.free(self.ca_path);
        self.allocator.free(self.key_path);
        self.temporary.cleanup();
    }
};
