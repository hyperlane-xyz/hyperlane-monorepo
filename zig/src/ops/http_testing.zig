const std = @import("std");
const http = @import("http.zig");
const A = std.mem.Allocator;

pub const Echo = struct {
    entered: std.Thread.Semaphore = .{},
    release: std.Thread.Semaphore = .{},
    retired: std.Thread.Semaphore = .{},
    slow_retired: std.Thread.Semaphore = .{},
    cancelled: std.atomic.Value(bool) = .init(false),
    cancel_address: std.atomic.Value(usize) = .init(0),
    calls: std.atomic.Value(usize) = .init(0),

    pub fn handler(self: *Echo) http.Handler {
        return .{ .context = self, .handle_fn = handle };
    }

    fn handle(context: *anyopaque, allocator: A, request: http.Request, cancel: *const std.atomic.Value(bool)) anyerror!http.Response {
        const self: *Echo = @ptrCast(@alignCast(context));
        _ = self.calls.fetchAdd(1, .acq_rel);
        defer self.retired.post();
        if (std.mem.eql(u8, request.path, "/slow")) {
            self.cancel_address.store(@intFromPtr(cancel), .release);
            self.entered.post();
            var released = false;
            while (!released) {
                if (cancel.load(.acquire)) self.cancelled.store(true, .release);
                released = if (self.release.timedWait(std.time.ns_per_ms)) |_| true else |_| false;
            }
            if (cancel.load(.acquire)) self.cancelled.store(true, .release);
            self.slow_retired.post();
            return http.Response.init(allocator, 200, &.{}, "stale");
        }
        if (std.mem.eql(u8, request.path, "/fail")) return error.FixtureHandlerFailure;
        if (std.mem.eql(u8, request.path, "/oom")) return error.OutOfMemory;
        if (std.mem.eql(u8, request.path, "/bad-header")) return http.Response.init(allocator, 200, &.{.{ .name = "X-Test", .value = "bad\r\nInjected: yes" }}, "bad");
        if (std.mem.eql(u8, request.path, "/bad-length")) return http.Response.init(allocator, 200, &.{.{ .name = "Content-Length", .value = "0" }}, "bad");
        if (std.mem.eql(u8, request.path, "/too-big")) return http.Response.init(allocator, 200, &.{}, "too large for fixture");
        if (std.mem.eql(u8, request.path, "/large")) {
            const body = try allocator.alloc(u8, 1024 * 1024);
            defer allocator.free(body);
            for (body, 0..) |*byte, index| byte.* = @truncate(index);
            return http.Response.init(allocator, 200, &.{}, body);
        }
        if (std.mem.eql(u8, request.path, "/echo")) {
            const text = try std.fmt.allocPrint(allocator, "{s}|{s}|{s}|{s}", .{ request.method, request.path, request.query orelse "-", request.body });
            defer allocator.free(text);
            return http.Response.init(allocator, 200, &.{.{ .name = "Content-Type", .value = "text/plain" }}, text);
        }
        return http.Response.init(allocator, 200, &.{.{ .name = "Content-Type", .value = "text/plain; version=0.0.4" }}, "fixture_metric 1\n");
    }
};

pub const Reply = struct {
    allocator: A,
    bytes: []u8,
    body_offset: usize,
    status: u16,

    pub fn body(self: *const Reply) []const u8 {
        return self.bytes[self.body_offset..];
    }
    pub fn contentLength(self: *const Reply) !usize {
        const head = self.bytes[0..self.body_offset];
        const marker = "Content-Length: ";
        const value_start = std.mem.indexOf(u8, head, marker) orelse return error.MissingContentLength;
        const end = std.mem.indexOfScalarPos(u8, head, value_start + marker.len, '\r') orelse return error.InvalidFixtureReply;
        return std.fmt.parseInt(usize, head[value_start + marker.len .. end], 10);
    }
    pub fn deinit(self: *Reply) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};

pub const Client = struct {
    allocator: A,
    stream: std.net.Stream,
    input: std.ArrayList(u8) = .empty,

    pub fn connect(allocator: A, address: std.net.Address) !Client {
        return .{ .allocator = allocator, .stream = try std.net.tcpConnectToAddress(address) };
    }
    pub fn deinit(self: *Client) void {
        self.input.deinit(self.allocator);
        self.stream.close();
        self.* = undefined;
    }
    pub fn writeAll(self: *Client, bytes: []const u8) !void {
        try self.stream.writeAll(bytes);
    }
    pub fn shutdownWrite(self: *Client) !void {
        try std.posix.shutdown(self.stream.handle, .send);
    }
    pub fn reset(self: *Client) !void {
        self.input.deinit(self.allocator);
        const linger = extern struct { onoff: c_int, linger: c_int }{ .onoff = 1, .linger = 0 };
        const result = std.posix.setsockopt(self.stream.handle, std.posix.SOL.SOCKET, std.posix.SO.LINGER, &std.mem.toBytes(linger));
        self.stream.close();
        self.* = undefined;
        try result;
    }
    pub fn readReply(self: *Client, head: bool) !Reply {
        var timer = try std.time.Timer.start();
        while (true) {
            if (std.mem.indexOf(u8, self.input.items, "\r\n\r\n")) |header_at| {
                const body_offset = header_at + 4;
                const status_end = std.mem.indexOf(u8, self.input.items, "\r\n") orelse return error.InvalidFixtureReply;
                var words = std.mem.splitScalar(u8, self.input.items[0..status_end], ' ');
                _ = words.next();
                const status = try std.fmt.parseInt(u16, words.next() orelse return error.InvalidFixtureReply, 10);
                const marker = "Content-Length: ";
                const length_start = std.mem.indexOf(u8, self.input.items[0..body_offset], marker) orelse return error.MissingContentLength;
                const length_end = std.mem.indexOfScalarPos(u8, self.input.items, length_start + marker.len, '\r') orelse return error.InvalidFixtureReply;
                const content_length = try std.fmt.parseInt(usize, self.input.items[length_start + marker.len .. length_end], 10);
                const wire_length = body_offset + (if (head) 0 else content_length);
                if (self.input.items.len >= wire_length) {
                    const bytes = try self.allocator.dupe(u8, self.input.items[0..wire_length]);
                    const remaining = self.input.items.len - wire_length;
                    std.mem.copyForwards(u8, self.input.items[0..remaining], self.input.items[wire_length..]);
                    self.input.items.len = remaining;
                    return .{ .allocator = self.allocator, .bytes = bytes, .body_offset = body_offset, .status = status };
                }
            }
            if (timer.read() > 5 * std.time.ns_per_s) return error.FixtureReadTimeout;
            var descriptor = [_]std.posix.pollfd{.{ .fd = self.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&descriptor, 20) == 0) continue;
            var buffer: [8192]u8 = undefined;
            const count = try self.stream.read(&buffer);
            if (count == 0) return error.FixtureUnexpectedEof;
            try self.input.appendSlice(self.allocator, buffer[0..count]);
        }
    }
};

fn loopback() !std.net.Address {
    return std.net.Address.parseIp4("127.0.0.1", 0);
}

fn start(echo: *Echo, options: http.Options) !*http.Server {
    return http.Server.start(std.testing.allocator, options, echo.handler());
}

fn expectReply(client: *Client, head: bool, status: u16) !Reply {
    var reply = try client.readReply(head);
    errdefer reply.deinit();
    try std.testing.expectEqual(status, reply.status);
    return reply;
}

test "metrics keepalive bounded pipelining and HEAD preserve request data" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback() });
    defer server.deinit();
    var client = try Client.connect(a, server.address());
    defer client.deinit();
    try client.writeAll("GET /echo?x=1 HTTP/1.1\r\nHost: fixture\r\n\r\nHEAD /echo HTTP/1.1\r\nHost: fixture\r\n\r\nGET /metrics HTTP/1.1\r\nHost: fixture\r\n\r\n");
    var first = try expectReply(&client, false, 200);
    defer first.deinit();
    try std.testing.expectEqualStrings("GET|/echo|x=1|", first.body());
    var second = try expectReply(&client, true, 200);
    defer second.deinit();
    try std.testing.expectEqual(@as(usize, 0), second.body().len);
    try std.testing.expectEqual((try second.contentLength()), "HEAD|/echo|-|".len);
    var third = try expectReply(&client, false, 200);
    defer third.deinit();
    try std.testing.expectEqualStrings("fixture_metric 1\n", third.body());
}

fn serveGetHeadAndStop(allocator: A, address: std.net.Address) !void {
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = address });
    var stopped = false;
    defer if (!stopped) server.deinit();
    var client = try Client.connect(allocator, server.address());
    defer client.deinit();
    try client.writeAll("GET /metrics HTTP/1.1\r\nHost: fixture\r\n\r\nHEAD /metrics HTTP/1.1\r\nHost: fixture\r\n\r\n");
    var get_reply = try expectReply(&client, false, 200);
    defer get_reply.deinit();
    try std.testing.expectEqualStrings("fixture_metric 1\n", get_reply.body());
    var head_reply = try expectReply(&client, true, 200);
    defer head_reply.deinit();
    try std.testing.expectEqual(@as(usize, 0), head_reply.body().len);
    server.deinit();
    stopped = true;
}

test "immediate fixed port restart succeeds after real GET and HEAD" {
    const a = std.testing.allocator;
    var probe = try (try loopback()).listen(.{ .reuse_address = true });
    const fixed_address = probe.listen_address;
    probe.deinit();
    for (0..3) |_| try serveGetHeadAndStop(a, fixed_address);
}

test "one live agent exclusively owns its configured port" {
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback() });
    defer server.deinit();
    if (start(&echo, .{ .address = server.address() })) |duplicate| {
        duplicate.deinit();
        return error.DuplicateAgentListener;
    } else |err| try std.testing.expectEqual(error.AddressInUse, err);
}

test "complete request write half close receives full response" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback() });
    defer server.deinit();
    var client = try Client.connect(a, server.address());
    defer client.deinit();
    try client.writeAll("GET /echo?half=close HTTP/1.1\r\nHost: fixture\r\n\r\n");
    try client.shutdownWrite();
    var reply = try expectReply(&client, false, 200);
    defer reply.deinit();
    try std.testing.expectEqualStrings("GET|/echo|half=close|", reply.body());
    var descriptor = [_]std.posix.pollfd{.{ .fd = client.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
    _ = try std.posix.poll(&descriptor, 2_000);
    try std.testing.expect(descriptor[0].revents != 0);
    var byte: [1]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), try client.stream.read(&byte));
}

test "stalled socket and slow callback do not block healthy clients" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .request_timeout_ms = 2_000 });
    defer {
        echo.release.post();
        server.deinit();
    }
    var stalled = try Client.connect(a, server.address());
    defer stalled.deinit();
    try stalled.writeAll("GET / HTTP/1.1\r\nHost: fixture\r\nX-Incomplete: ");
    var healthy = try Client.connect(a, server.address());
    defer healthy.deinit();
    try healthy.writeAll("GET /metrics HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
    var reply = try expectReply(&healthy, false, 200);
    reply.deinit();
    var slow = try Client.connect(a, server.address());
    defer slow.deinit();
    try slow.writeAll("GET /slow HTTP/1.1\r\nHost: fixture\r\n\r\n");
    try echo.entered.timedWait(2 * std.time.ns_per_s);
    var second = try Client.connect(a, server.address());
    defer second.deinit();
    try second.writeAll("GET /metrics HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
    var healthy_again = try expectReply(&second, false, 200);
    healthy_again.deinit();
    echo.release.post();
    var slow_reply = try expectReply(&slow, false, 200);
    defer slow_reply.deinit();
    try std.testing.expectEqualStrings("stale", slow_reply.body());
}

test "partial content length and chunked bodies decode across every boundary" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .request_timeout_ms = 2_000 });
    defer server.deinit();
    var client = try Client.connect(a, server.address());
    defer client.deinit();
    const first = "POST /echo?q=yes HTTP/1.1\r\nHost: fixture\r\nContent-Length: 11\r\n\r\nhello world";
    for (first) |byte| try client.writeAll(&.{byte});
    var reply = try expectReply(&client, false, 200);
    defer reply.deinit();
    try std.testing.expectEqualStrings("POST|/echo|q=yes|hello world", reply.body());
    const second = "POST /echo HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5;fixture=yes\r\npedia\r\n0\r\nX-Trailer: done\r\n\r\n";
    for (second) |byte| try client.writeAll(&.{byte});
    var chunked = try expectReply(&client, false, 200);
    defer chunked.deinit();
    try std.testing.expectEqualStrings("POST|/echo|-|Wikipedia", chunked.body());
}

test "ambiguous and malformed requests fail closed with safe statuses" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .max_header_bytes = 128, .max_body_bytes = 4, .request_timeout_ms = 500 });
    defer server.deinit();
    const Case = struct { wire: []const u8, status: u16 };
    const cases = [_]Case{
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx", .status = 400 },
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", .status = 400 },
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", .status = 400 },
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: gzip\r\n\r\n", .status = 400 },
        .{ .wire = "GET / HTTP/1.1\r\nHost: fixture\r\nBad Name: value\r\n\r\n", .status = 400 },
        .{ .wire = "GET / HTTP/1.1\nHost: fixture\n\n", .status = 400 },
        .{ .wire = "GET / HTTP/1.1\r\nHost: one\r\nHost: two\r\n\r\n", .status = 400 },
        .{ .wire = "GET / HTTP/2.0\r\nHost: fixture\r\n\r\n", .status = 505 },
        .{ .wire = "GET http://fixture/ HTTP/1.1\r\nHost: fixture\r\n\r\n", .status = 400 },
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxXX", .status = 400 },
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nContent-Length: 1\r\n\r\n", .status = 400 },
        .{ .wire = "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: 5\r\n\r\n", .status = 413 },
    };
    for (cases) |case| {
        var client = try Client.connect(a, server.address());
        defer client.deinit();
        try client.writeAll(case.wire);
        var reply = try expectReply(&client, false, case.status);
        reply.deinit();
    }
    var oversized = try Client.connect(a, server.address());
    defer oversized.deinit();
    try oversized.writeAll("GET / HTTP/1.1\r\nHost: fixture\r\nX-Large: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n\r\n");
    var header_reply = try expectReply(&oversized, false, 431);
    header_reply.deinit();
}

test "truncated body and idle accepted socket observe absolute deadlines" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .request_timeout_ms = 40, .write_timeout_ms = 500 });
    defer server.deinit();
    var idle = try Client.connect(a, server.address());
    defer idle.deinit();
    var client = try Client.connect(a, server.address());
    defer client.deinit();
    try client.writeAll("POST /echo HTTP/1.1\r\nHost: fixture\r\nContent-Length: 5\r\n\r\nxx");
    var reply = try expectReply(&client, false, 408);
    reply.deinit();
    var buffer: [1]u8 = undefined;
    var timer = try std.time.Timer.start();
    while (true) {
        var descriptor = [_]std.posix.pollfd{.{ .fd = idle.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        _ = try std.posix.poll(&descriptor, 20);
        if (descriptor[0].revents != 0) {
            try std.testing.expectEqual(@as(usize, 0), try idle.stream.read(&buffer));
            break;
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureIdleDeadlineMissing;
    }
}

test "cancel token remains stable and late output cannot reach reused slots" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .max_connections = 2, .request_timeout_ms = 2_000 });
    defer {
        echo.release.post();
        server.deinit();
    }
    var slow = try Client.connect(a, server.address());
    try slow.writeAll("GET /slow HTTP/1.1\r\nHost: fixture\r\n\r\n");
    try echo.entered.timedWait(2 * std.time.ns_per_s);
    const token = echo.cancel_address.load(.acquire);
    try slow.reset();
    var timer = try std.time.Timer.start();
    while (!echo.cancelled.load(.acquire)) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureCancellationMissing;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(token, echo.cancel_address.load(.acquire));
    for (0..2) |_| {
        var healthy = try Client.connect(a, server.address());
        defer healthy.deinit();
        try healthy.writeAll("GET /metrics HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
        var reply = try expectReply(&healthy, false, 200);
        defer reply.deinit();
        try std.testing.expectEqualStrings("fixture_metric 1\n", reply.body());
    }
    echo.release.post();
    try echo.slow_retired.timedWait(2 * std.time.ns_per_s);
    try std.testing.expectEqual(token, echo.cancel_address.load(.acquire));
}

test "full bounded handler pool returns 503 without affecting listener" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .max_connections = 65, .request_timeout_ms = 3_000 });
    defer {
        for (0..65) |_| echo.release.post();
        server.deinit();
    }
    var clients: [65]Client = undefined;
    var connected: usize = 0;
    defer for (clients[0..connected]) |*client| client.deinit();
    for (&clients) |*client| {
        client.* = try Client.connect(a, server.address());
        connected += 1;
        try client.writeAll("GET /slow HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
    }
    var rejected = try expectReply(&clients[64], false, 503);
    rejected.deinit();
    for (0..64) |_| echo.release.post();
    for (clients[0..64]) |*client| {
        var reply = try expectReply(client, false, 200);
        reply.deinit();
    }
}

test "handler failures OOM oversized and injecting responses become generic 500" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .max_response_bytes = 4 });
    defer server.deinit();
    for ([_][]const u8{ "/fail", "/oom", "/bad-header", "/bad-length", "/too-big" }) |path| {
        var client = try Client.connect(a, server.address());
        defer client.deinit();
        const request = try std.fmt.allocPrint(a, "GET {s} HTTP/1.1\r\nHost: fixture\r\n\r\n", .{path});
        defer a.free(request);
        try client.writeAll(request);
        var reply = try expectReply(&client, false, 500);
        defer reply.deinit();
        try std.testing.expectEqualStrings("Internal Server Error", reply.body());
        try std.testing.expect(std.mem.indexOf(u8, reply.bytes, "Injected") == null);
    }
    var head_client = try Client.connect(a, server.address());
    defer head_client.deinit();
    try head_client.writeAll("HEAD /fail HTTP/1.1\r\nHost: fixture\r\n\r\n");
    var head_reply = try expectReply(&head_client, true, 500);
    defer head_reply.deinit();
    try std.testing.expectEqual(@as(usize, 0), head_reply.body().len);
    try std.testing.expectEqual("Internal Server Error".len, try head_reply.contentLength());
}

test "handler deadline returns 503 and late retirement does not block health" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .request_timeout_ms = 40, .write_timeout_ms = 500 });
    defer {
        echo.release.post();
        server.deinit();
    }
    var slow = try Client.connect(a, server.address());
    defer slow.deinit();
    try slow.writeAll("GET /slow HTTP/1.1\r\nHost: fixture\r\n\r\n");
    try echo.entered.timedWait(2 * std.time.ns_per_s);
    var reply = try expectReply(&slow, false, 503);
    reply.deinit();
    var healthy = try Client.connect(a, server.address());
    defer healthy.deinit();
    try healthy.writeAll("GET /metrics HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
    var healthy_reply = try expectReply(&healthy, false, 200);
    healthy_reply.deinit();
    echo.release.post();
    try echo.slow_retired.timedWait(2 * std.time.ns_per_s);
}

test "HTTP 1.0 close and explicit keepalive are honored" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback() });
    defer server.deinit();
    var client = try Client.connect(a, server.address());
    defer client.deinit();
    try client.writeAll("GET /echo HTTP/1.0\r\nConnection: keep-alive\r\n\r\nGET /metrics HTTP/1.0\r\n\r\n");
    var first = try expectReply(&client, false, 200);
    defer first.deinit();
    try std.testing.expect(std.mem.startsWith(u8, first.bytes, "HTTP/1.0 200"));
    try std.testing.expect(std.mem.indexOf(u8, first.bytes, "Connection: keep-alive") != null);
    var second = try expectReply(&client, false, 200);
    defer second.deinit();
    try std.testing.expect(std.mem.indexOf(u8, second.bytes, "Connection: close") != null);
}

fn startStopAllocated(allocator: A, address: std.net.Address, handler: http.Handler) !void {
    const server = try http.Server.start(allocator, .{ .address = address }, handler);
    server.deinit();
}

fn responseAllocated(allocator: A) !void {
    var response = try http.Response.init(allocator, 200, &.{.{ .name = "Content-Type", .value = "text/plain" }}, "fixture");
    defer response.deinit();
}

test "server construction and response ownership survive induced OOM" {
    var echo: Echo = .{};
    try std.testing.checkAllAllocationFailures(std.testing.allocator, startStopAllocated, .{ try loopback(), echo.handler() });
    try std.testing.checkAllAllocationFailures(std.testing.allocator, responseAllocated, .{});
}

test "large responses drain through nonblocking partial writes" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .request_timeout_ms = 2_000, .write_timeout_ms = 2_000 });
    defer server.deinit();
    var client = try Client.connect(a, server.address());
    defer client.deinit();
    try client.writeAll("GET /large HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
    std.Thread.sleep(50 * std.time.ns_per_ms);
    var reply = try expectReply(&client, false, 200);
    defer reply.deinit();
    try std.testing.expectEqual(@as(usize, 1024 * 1024), reply.body().len);
    for (reply.body(), 0..) |byte, index| try std.testing.expectEqual(@as(u8, @truncate(index)), byte);
}

test "aggregate request reservations reject excess work and recover" {
    const a = std.testing.allocator;
    var echo: Echo = .{};
    const server = try start(&echo, .{ .address = try loopback(), .max_connections = 3, .max_header_bytes = 128, .max_body_bytes = 64, .max_response_bytes = 64, .max_aggregate_bytes = 850, .max_pipeline_bytes = 0, .request_timeout_ms = 2_000 });
    defer {
        for (0..3) |_| echo.release.post();
        server.deinit();
    }
    var clients: [3]Client = undefined;
    var connected: usize = 0;
    defer for (clients[0..connected]) |*client| client.deinit();
    const body = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    for (&clients) |*client| {
        client.* = try Client.connect(a, server.address());
        connected += 1;
        try client.writeAll("POST /slow HTTP/1.1\r\nHost: fixture\r\nContent-Length: 64\r\nConnection: close\r\n\r\n");
        try client.writeAll(body);
    }
    var rejected = try expectReply(&clients[2], false, 503);
    rejected.deinit();
    for (0..2) |_| echo.release.post();
    for (clients[0..2]) |*client| {
        var reply = try expectReply(client, false, 200);
        reply.deinit();
    }
}
