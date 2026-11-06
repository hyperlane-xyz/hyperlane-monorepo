//! Disposable loopback JSON-RPC fixture, shared only by tests.
const std = @import("std");
const rpc = @import("../evm/provider.zig");
pub const Server = struct {
    server: std.net.Server,
    exchange: rpc.Exchange,
    requests: usize,
    failure: ?anyerror = null,
    pub fn init(exchange: rpc.Exchange, requests: usize) !Server {
        return .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .exchange = exchange, .requests = requests };
    }
    pub fn deinit(self: *Server) void {
        self.server.deinit();
    }
    pub fn url(self: *Server, a: std.mem.Allocator) ![]u8 {
        return std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{self.server.listen_address.getPort()});
    }
    pub fn serve(self: *Server) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *Server) !void {
        const a = std.testing.allocator;
        for (0..self.requests) |_| {
            var fds = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 5000) == 0) return error.FixtureTimeout;
            const connection = try self.server.accept();
            defer connection.stream.close();
            var bytes: [16384]u8 = undefined;
            var used: usize = 0;
            const body = while (true) {
                if (used == bytes.len) return error.FixtureRequestTooLarge;
                var input = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&input, 5000) == 0) return error.FixtureTimeout;
                const n = try connection.stream.read(bytes[used..]);
                if (n == 0) return error.FixtureEof;
                used += n;
                if (std.mem.indexOf(u8, bytes[0..used], "\r\n\r\n")) |end| {
                    const needle = "content-length: ";
                    const start = (std.mem.indexOf(u8, bytes[0..end], needle) orelse return error.MissingContentLength) + needle.len;
                    const line_end = std.mem.indexOfPos(u8, bytes[0..used], start, "\r\n") orelse return error.MissingContentLength;
                    const len = try std.fmt.parseInt(usize, bytes[start..line_end], 10);
                    if (used < end + 4 + len) continue;
                    break bytes[end + 4 ..][0..len];
                }
            };
            const result = try self.exchange.fetch_fn(self.exchange.context, a, body, .{});
            defer a.free(result.bytes);
            var header: [200]u8 = undefined;
            try connection.stream.writeAll(try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{result.len}));
            try connection.stream.writeAll(result.bytes[0..result.len]);
        }
    }
};
