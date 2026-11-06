//! Test-only bounded HTTP/REST loopback server; routes by first numeric path segment.
const std = @import("std");
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
            readRequest(connection.stream, &record) catch |err| {
                connection.stream.close();
                return err;
            };
            const path_index = std.fmt.parseInt(usize, std.mem.sliceTo(record.pathText()[1..], '/'), 10) catch return error.FixtureBadPath;
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

fn readRequest(stream: std.net.Stream, record: *Record) !void {
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
        if (got == 0) return error.FixtureUnexpectedEof;
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
}

fn parseHeaders(input: []const u8, record: *Record, content_length: *?usize) !void {
    var lines = std.mem.splitSequence(u8, input, "\r\n");
    const first = lines.next() orelse return error.FixtureBadRequest;
    const start: usize = if (std.mem.startsWith(u8, first, "POST ")) 5 else if (std.mem.startsWith(u8, first, "GET ")) 4 else return error.FixtureBadRequest;
    if (start == 4) content_length.* = 0;
    const path_end = std.mem.indexOfPos(u8, first, start, " ") orelse return error.FixtureBadRequest;
    const path = first[start..path_end];
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
