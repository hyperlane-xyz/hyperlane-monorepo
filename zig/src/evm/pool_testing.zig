//! Native loopback fixtures for delegated EVM pool tests. No production imports.
const std = @import("std");
const pool = @import("pool.zig");
const A = std.mem.Allocator;

pub fn nativeLibrary(allocator: A) ![]u8 {
    return std.process.getEnvVarOwned(allocator, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}

pub const Reply = struct {
    status: u16 = 200,
    body: []const u8,
    stall: bool = false,
    delay_ms: u64 = 0,
    stall_after_head: bool = false,
    informational_head: bool = false,
    advertised_bytes: ?usize = null,
    extra_response_headers: []const u8 = "",
};
pub const Behavior = struct {
    replies: []const Reply,
    probe_replies: ?[]const Reply = null,
    /// Fixture-only dynamic JSON-RPC response; called on fast non-stalled paths.
    response_fn: ?*const fn (A, []const u8) anyerror![]u8 = null,
};

pub const Record = struct {
    path: [128]u8 = undefined,
    path_len: usize = 0,
    body: [4096]u8 = undefined,
    body_len: usize = 0,
    authorization: [512]u8 = undefined,
    authorization_len: usize = 0,
    api_key: [512]u8 = undefined,
    api_key_len: usize = 0,
    pub fn pathText(self: *const Record) []const u8 {
        return self.path[0..self.path_len];
    }
    pub fn bodyText(self: *const Record) []const u8 {
        return self.body[0..self.body_len];
    }
    pub fn authorizationText(self: *const Record) []const u8 {
        return self.authorization[0..self.authorization_len];
    }
    pub fn apiKeyText(self: *const Record) []const u8 {
        return self.api_key[0..self.api_key_len];
    }
};

pub const Fixture = struct {
    server: std.net.Server,
    behaviors: []const Behavior = &.{},
    expected: usize,
    accepted: std.atomic.Value(usize) = .init(0),
    hits: [256]std.atomic.Value(usize) = [_]std.atomic.Value(usize){std.atomic.Value(usize).init(0)} ** 256,
    probe_hits: [256]std.atomic.Value(usize) = [_]std.atomic.Value(usize){std.atomic.Value(usize).init(0)} ** 256,
    records: [256]Record = [_]Record{.{}} ** 256,
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    thread: ?std.Thread = null,

    pub fn init(expected: usize, behaviors: []const Behavior) !Fixture {
        if (expected > 256) return error.FixtureTooManyRequests;
        return .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .expected = expected, .behaviors = behaviors };
    }

    pub fn start(self: *Fixture) !void {
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
    }

    pub fn deinit(self: *Fixture) void {
        self.stop.store(true, .release);
        if (self.thread) |thread| thread.join();
        self.server.deinit();
    }

    pub fn check(self: *Fixture) !void {
        if (self.failure) |err| return err;
    }

    pub fn url(self: *Fixture, allocator: A, index: usize) ![]u8 {
        return std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/{d}", .{ self.server.listen_address.getPort(), index });
    }

    pub fn acceptedCount(self: *Fixture) usize {
        return self.accepted.load(.acquire);
    }

    pub fn pathHits(self: *Fixture, index: usize) usize {
        return self.hits[index].load(.acquire);
    }

    pub fn probeHits(self: *Fixture, index: usize) usize {
        return self.probe_hits[index].load(.acquire);
    }

    fn serve(self: *Fixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }

    fn run(self: *Fixture) !void {
        var retained: [256]std.net.Stream = undefined;
        var retained_count: usize = 0;
        defer for (retained[0..retained_count]) |stream| stream.close();
        while (self.acceptedCount() < self.expected and !self.stop.load(.acquire)) {
            var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fd, 10) == 0) continue;
            const connection = try self.server.accept();
            const index = self.acceptedCount();
            var record = Record{};
            const complete = readRequest(connection.stream, &record) catch |err| {
                connection.stream.close();
                return err;
            };
            if (!complete) {
                // A canceled connection with no request bytes is not a request.
                connection.stream.close();
                continue;
            }
            const path_index = std.fmt.parseInt(usize, record.pathText()[1..], 10) catch return error.FixtureBadPath;
            if (path_index >= self.behaviors.len) return error.FixtureMissingBehavior;
            const behavior = self.behaviors[path_index];
            const is_probe = behavior.probe_replies != null and std.mem.indexOf(u8, record.bodyText(), "\"method\":\"eth_blockNumber\"") != null;
            const replies = if (is_probe) behavior.probe_replies.? else behavior.replies;
            if (replies.len == 0) return error.FixtureMissingBehavior;
            const hit = if (is_probe) self.probe_hits[path_index].fetchAdd(1, .acq_rel) else self.hits[path_index].fetchAdd(1, .acq_rel);
            self.records[index] = record;
            _ = self.accepted.fetchAdd(1, .release);
            const reply = replies[@min(hit, replies.len - 1)];
            if (reply.stall) {
                retained[retained_count] = connection.stream;
                retained_count += 1;
                continue;
            }
            if (reply.delay_ms != 0) {
                const thread = try std.Thread.spawn(.{}, delayedReply, .{ connection.stream, reply });
                thread.detach();
                continue;
            }
            const dynamic_body = if (behavior.response_fn) |respond| try respond(std.heap.page_allocator, record.bodyText()) else null;
            defer if (dynamic_body) |owned| std.heap.page_allocator.free(owned);
            const body = dynamic_body orelse reply.body;
            var header: [160]u8 = undefined;
            const headers = try std.fmt.bufPrint(&header, "HTTP/1.1 {d} Fixture\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n{s}\r\n", .{ reply.status, reply.advertised_bytes orelse body.len, reply.extra_response_headers });
            if (reply.informational_head) connection.stream.writeAll("HTTP/1.1 100 Continue\r\nX-Interim: ignored\r\n\r\n") catch {};
            connection.stream.writeAll(headers) catch |err| switch (err) {
                error.BrokenPipe, error.ConnectionResetByPeer => {},
                else => return err,
            };
            if (reply.stall_after_head) {
                retained[retained_count] = connection.stream;
                retained_count += 1;
                continue;
            }
            connection.stream.writeAll(body) catch |err| switch (err) {
                error.BrokenPipe, error.ConnectionResetByPeer => {},
                else => return err,
            };
            connection.stream.close();
        }
        while (!self.stop.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    }
};

fn delayedReply(stream: std.net.Stream, reply: Reply) void {
    defer stream.close();
    std.Thread.sleep(reply.delay_ms * std.time.ns_per_ms);
    var buffer: [160]u8 = undefined;
    const headers = std.fmt.bufPrint(&buffer, "HTTP/1.1 {d} Fixture\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ reply.status, reply.body.len }) catch return;
    stream.writeAll(headers) catch return;
    stream.writeAll(reply.body) catch return;
}

fn readRequest(stream: std.net.Stream, record: *Record) !bool {
    var input: [8192]u8 = undefined;
    var used: usize = 0;
    var header_end: ?usize = null;
    var content_length: ?usize = null;
    var timer = try std.time.Timer.start();
    while (true) {
        if (header_end) |end| if (content_length) |length| {
            if (used >= end + 4 + length) break;
        };
        if (used == input.len) return error.FixtureRequestTooLarge;
        if (timer.read() > 5 * std.time.ns_per_s) return error.FixtureReadTimeout;
        var fd = [_]std.posix.pollfd{.{ .fd = stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&fd, 20) == 0) continue;
        const got = try stream.read(input[used..]);
        if (got == 0) {
            if (used == 0) return false;
            return error.FixtureUnexpectedEof;
        }
        used += got;
        if (header_end == null) if (std.mem.indexOf(u8, input[0..used], "\r\n\r\n")) |end| {
            header_end = end;
            try parseHeaders(input[0..end], record, &content_length);
        };
    }
    const end = header_end.?;
    const length = content_length.?;
    if (length > record.body.len) return error.FixtureBodyTooLarge;
    @memcpy(record.body[0..length], input[end + 4 ..][0..length]);
    record.body_len = length;
    return true;
}

fn parseHeaders(input: []const u8, record: *Record, content_length: *?usize) !void {
    var lines = std.mem.splitSequence(u8, input, "\r\n");
    const first = lines.next() orelse return error.FixtureBadRequest;
    if (!std.mem.startsWith(u8, first, "POST ")) return error.FixtureBadRequest;
    const path_end = std.mem.indexOfPos(u8, first, 5, " ") orelse return error.FixtureBadRequest;
    const path = first[5..path_end];
    if (path.len > record.path.len) return error.FixturePathTooLarge;
    @memcpy(record.path[0..path.len], path);
    record.path_len = path.len;
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.FixtureBadHeader;
        const name = line[0..colon];
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
        if (std.ascii.eqlIgnoreCase(name, "content-length")) {
            content_length.* = try std.fmt.parseInt(usize, value, 10);
        } else if (std.ascii.eqlIgnoreCase(name, "authorization")) {
            if (value.len > record.authorization.len) return error.FixtureHeaderTooLarge;
            @memcpy(record.authorization[0..value.len], value);
            record.authorization_len = value.len;
        } else if (std.ascii.eqlIgnoreCase(name, "x-api-key")) {
            if (value.len > record.api_key.len) return error.FixtureHeaderTooLarge;
            @memcpy(record.api_key[0..value.len], value);
            record.api_key_len = value.len;
        }
    }
}

pub fn oneReply(body: []const u8) [1]Reply {
    return .{.{ .body = body }};
}

pub fn config(library: []const u8, urls: []const []const u8, strategy: pool.Strategy) pool.Config {
    return .{
        .library_path = library,
        .urls = urls,
        .strategy = strategy,
        .max_concurrent = 64,
        .max_pending = 256,
        .max_response_bytes = 1024 * 1024,
        .max_request_bytes = 64 * 1024,
        .max_reserved_bytes = 64 * 1024 * 1024,
    };
}

pub const chain_id_body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}";
pub const chain_id_ok = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}";

test "pool fixture serves a real request after an empty preheader close" {
    const replies = [_]Reply{.{ .body = "{\"ok\":true}" }};
    const behaviors = [_]Behavior{.{ .replies = &replies }};
    var fixture = try Fixture.init(1, &behaviors);
    try fixture.start();
    defer fixture.deinit();
    const abandoned = try std.net.tcpConnectToAddress(fixture.server.listen_address);
    abandoned.close();
    const client = try std.net.tcpConnectToAddress(fixture.server.listen_address);
    defer client.close();
    try client.writeAll("POST /0 HTTP/1.1\r\nHost: fixture\r\nContent-Length: 2\r\n\r\n{}");
    var response: [512]u8 = undefined;
    var used: usize = 0;
    var timer = try std.time.Timer.start();
    while (used < response.len and timer.read() < 2 * std.time.ns_per_s) {
        var descriptors = [_]std.posix.pollfd{.{ .fd = client.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&descriptors, 10) == 0) continue;
        const count = try client.read(response[used..]);
        if (count == 0) break;
        used += count;
    }
    fixture.stop.store(true, .release);
    fixture.thread.?.join();
    fixture.thread = null;
    try fixture.check();
    try std.testing.expect(std.mem.startsWith(u8, response[0..used], "HTTP/1.1 200 Fixture\r\n"));
    try std.testing.expect(std.mem.endsWith(u8, response[0..used], "{\"ok\":true}"));
    try std.testing.expectEqual(@as(usize, 1), fixture.acceptedCount());
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 0), fixture.probeHits(0));
    try std.testing.expectEqualStrings("/0", fixture.records[0].pathText());
    try std.testing.expectEqualStrings("{}", fixture.records[0].bodyText());
}

test "pool fixture still rejects every nonempty partial header or body EOF" {
    const replies = [_]Reply{.{ .body = "unused" }};
    const behaviors = [_]Behavior{.{ .replies = &replies }};
    for ([_][]const u8{
        "POST /0 HTTP/1.1\r\nHost: fixture\r\nContent-Length: 2\r\n",
        "POST /0 HTTP/1.1\r\nHost: fixture\r\nContent-Length: 4\r\n\r\n{}",
    }) |request| {
        var fixture = try Fixture.init(1, &behaviors);
        defer fixture.deinit();
        const Watched = struct {
            fixture: *Fixture,
            done: std.atomic.Value(bool) = .init(false),
            fn serve(self: *@This()) void {
                self.fixture.serve();
                self.done.store(true, .release);
            }
        };
        var watched: Watched = .{ .fixture = &fixture };
        const thread = try std.Thread.spawn(.{}, Watched.serve, .{&watched});
        var joined = false;
        defer if (!joined) {
            fixture.stop.store(true, .release);
            thread.join();
        };
        {
            const client = try std.net.tcpConnectToAddress(fixture.server.listen_address);
            defer client.close();
            try client.writeAll(request);
        }
        var timer = try std.time.Timer.start();
        while (!watched.done.load(.acquire) and timer.read() < 2 * std.time.ns_per_s) std.Thread.sleep(std.time.ns_per_ms);
        const finished_before_stop = watched.done.load(.acquire);
        fixture.stop.store(true, .release);
        thread.join();
        joined = true;
        try std.testing.expect(finished_before_stop);
        try std.testing.expectError(error.FixtureUnexpectedEof, fixture.check());
        try std.testing.expectEqual(@as(usize, 0), fixture.acceptedCount());
        try std.testing.expectEqual(@as(usize, 0), fixture.pathHits(0));
        try std.testing.expectEqual(@as(usize, 0), fixture.probeHits(0));
    }
}
