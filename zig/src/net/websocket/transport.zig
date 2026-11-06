//! Owner-thread nonblocking WS/WSS transport over libcurl CONNECT_ONLY.
//! No worker threads or subprocesses. Every connection is driven by poll();
//! handshake/read deadlines survive idle polling and cancelled partial reads.
const std = @import("std");
const abi = @import("curl_abi.zig");
const A = std.mem.Allocator;
pub const Limits = struct {
    handshake_header_bytes: usize = 32 * 1024,
    request_bytes: usize = 16 * 1024,
    frame_bytes: usize = 16 * 1024 * 1024,
    message_bytes: usize = 64 * 1024 * 1024,
    outgoing_bytes: usize = 1024 * 1024,
};
pub const Config = struct {
    library_path: []const u8,
    ca_info: ?[]const u8 = null,
    handshake_timeout_ns: u64 = 75 * std.time.ns_per_s,
    read_timeout_ns: u64 = 75 * std.time.ns_per_s,
    idle_wait_ms: u32 = 1,
    limits: Limits = .{},
    cancel: ?*const std.atomic.Value(bool) = null,
};
pub const Event = struct {
    generation: u64,
    kind: Kind,
    pub const Kind = union(enum) {
        connected,
        text: []const u8,
        closed,
        failed: anyerror,
    };
};
const State = enum { idle, connecting, handshake_write, handshake_read, open, closing, closed, failed };
pub const Client = struct {
    allocator: A,
    config: Config,
    library: std.DynLib,
    api: abi.Api,
    easy: ?*abi.Handle = null,
    multi: ?*abi.Multi = null,
    socket: c_int = -1,
    state: State = .idle,
    generation: u64 = 0,
    url: ?[:0]u8 = null,
    timer: ?std.time.Timer = null,
    deadline_ns: u64 = 0,
    input: std.ArrayList(u8) = .empty,
    consumed: usize = 0,
    eof_received: bool = false,
    output: std.ArrayList(u8) = .empty,
    output_offset: usize = 0,
    current_frame_end: usize = 0,
    control: std.ArrayList(u8) = .empty,
    control_offset: usize = 0,
    message: std.ArrayList(u8) = .empty,
    message_opcode: u8 = 0,
    key: [24]u8 = undefined,
    failure: ?anyerror = null,
    terminal_reported: bool = false,

    pub fn init(allocator: A, config: Config) !Client {
        if (config.library_path.len == 0 or config.handshake_timeout_ns == 0 or config.read_timeout_ns == 0 or config.idle_wait_ms > 100 or config.limits.request_bytes == 0 or config.limits.handshake_header_bytes == 0 or config.limits.frame_bytes == 0 or config.limits.message_bytes == 0 or config.limits.outgoing_bytes == 0) return error.InvalidWebSocketConfig;
        var library = try std.DynLib.open(config.library_path);
        errdefer library.close();
        const api = try abi.Api.load(&library);
        try api.initialize(config.ca_info != null);
        return .{ .allocator = allocator, .config = config, .library = library, .api = api };
    }

    pub fn deinit(self: *Client) void {
        self.releaseConnection();
        self.input.deinit(self.allocator);
        self.output.deinit(self.allocator);
        self.control.deinit(self.allocator);
        self.message.deinit(self.allocator);
        self.library.close();
        self.* = undefined;
    }

    fn releaseConnection(self: *Client) void {
        if (self.multi) |multi| {
            if (self.easy) |easy| _ = self.api.multi_remove_handle(multi, easy);
            _ = self.api.multi_cleanup(multi);
        }
        if (self.easy) |easy| self.api.easy_cleanup(easy);
        self.multi = null;
        self.easy = null;
        self.socket = -1;
        if (self.url) |url| self.allocator.free(url);
        self.url = null;
    }

    /// Retire a connection on the owning transport thread. Configuration and
    /// cancellation ownership remain intact; a later connect gets a new generation.
    pub fn disconnect(self: *Client) void {
        self.releaseConnection();
        self.state = .closed;
        self.failure = null;
        self.terminal_reported = true;
    }

    pub fn connect(self: *Client, url: []const u8) !void {
        if (self.state != .idle and self.state != .closed and self.state != .failed) return error.WebSocketClientBusy;
        self.releaseConnection();
        self.input.clearRetainingCapacity();
        self.output.clearRetainingCapacity();
        self.control.clearRetainingCapacity();
        self.message.clearRetainingCapacity();
        self.consumed = 0;
        self.eof_received = false;
        self.output_offset = 0;
        self.current_frame_end = 0;
        self.control_offset = 0;
        self.message_opcode = 0;
        self.terminal_reported = false;
        const uri = try std.Uri.parse(url);
        const secure = std.mem.eql(u8, uri.scheme, "wss");
        if (!secure and !std.mem.eql(u8, uri.scheme, "ws")) return error.UnsupportedWebSocketScheme;
        if (uri.host == null or uri.fragment != null or url.len == 0 or url.len > self.config.limits.request_bytes / 2) return error.InvalidWebSocketUrl;
        for (url) |char| if (char <= 32 or char == 127) return error.InvalidWebSocketUrl;
        try self.api.initialize(secure);
        self.url = try self.allocator.dupeZ(u8, url);
        // Apple libcurl rejects ws/wss schemes; HTTP CONNECT_ONLY carries the
        // same TCP/TLS transport while the handshake remains RFC6455 above it.
        const native_text = if (secure) try std.fmt.allocPrint(self.allocator, "https{s}", .{url[3..]}) else try std.fmt.allocPrint(self.allocator, "http{s}", .{url[2..]});
        defer self.allocator.free(native_text);
        const native_url = try self.allocator.dupeZ(u8, native_text);
        defer self.allocator.free(native_url);
        const easy = self.api.easy_init() orelse return error.CurlOperationFailed;
        self.easy = easy;
        errdefer self.releaseConnection();
        try abi.Api.check(self.api.easy_setopt(easy, 10002, native_url.ptr));
        try abi.Api.check(self.api.easy_setopt(easy, 141, @as(c_long, 1)));
        try abi.Api.check(self.api.easy_setopt(easy, 155, @as(c_long, @intCast(@min(std.math.maxInt(c_long), self.config.handshake_timeout_ns / std.time.ns_per_ms)))));
        try abi.Api.check(self.api.easy_setopt(easy, 156, @as(c_long, @intCast(@min(std.math.maxInt(c_long), self.config.handshake_timeout_ns / std.time.ns_per_ms)))));
        try abi.Api.check(self.api.easy_setopt(easy, 99, @as(c_long, 1)));
        try abi.Api.check(self.api.easy_setopt(easy, 10004, @as([*:0]const u8, "")));
        try abi.Api.check(self.api.easy_setopt(easy, 10177, @as([*:0]const u8, "*")));
        try abi.Api.check(self.api.easy_setopt(easy, 64, @as(c_long, 1)));
        try abi.Api.check(self.api.easy_setopt(easy, 81, @as(c_long, 2)));
        if (self.config.ca_info) |path| {
            const owned = try self.allocator.dupeZ(u8, path);
            defer self.allocator.free(owned);
            try abi.Api.check(self.api.easy_setopt(easy, 10065, owned.ptr));
        }
        const multi = self.api.multi_init() orelse return error.CurlOperationFailed;
        self.multi = multi;
        try abi.Api.check(self.api.multi_add_handle(multi, easy));
        try self.buildHandshake(uri, secure);
        self.current_frame_end = self.output.items.len;
        self.generation +|= 1;
        if (self.generation == 0) self.generation = 1;
        self.timer = try std.time.Timer.start();
        self.deadline_ns = self.config.handshake_timeout_ns;
        self.state = .connecting;
    }

    fn buildHandshake(self: *Client, uri: std.Uri, secure: bool) !void {
        var nonce: [16]u8 = undefined;
        std.crypto.random.bytes(&nonce);
        _ = std.base64.standard.Encoder.encode(&self.key, &nonce);
        var host_buffer: [1024]u8 = undefined;
        const raw_host = try uri.host.?.toRaw(&host_buffer);
        const host = if (std.mem.indexOfScalar(u8, raw_host, ':') != null and raw_host[0] != '[') try std.fmt.allocPrint(self.allocator, "[{s}]", .{raw_host}) else try self.allocator.dupe(u8, raw_host);
        defer self.allocator.free(host);
        const default_port: u16 = if (secure) 443 else 80;
        const authority = if (uri.port != null and uri.port.? != default_port) try std.fmt.allocPrint(self.allocator, "{s}:{d}", .{ host, uri.port.? }) else try self.allocator.dupe(u8, host);
        defer self.allocator.free(authority);
        const target = if (uri.query) |query| try std.fmt.allocPrint(self.allocator, "{s}?{s}", .{ if (uri.path.isEmpty()) "/" else uri.path.percent_encoded, query.percent_encoded }) else try self.allocator.dupe(u8, if (uri.path.isEmpty()) "/" else uri.path.percent_encoded);
        defer self.allocator.free(target);
        for (target) |char| if (char <= 32 or char == 127) return error.InvalidWebSocketUrl;
        try self.appendPrint("GET {s} HTTP/1.1\r\nHost: {s}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {s}\r\nSec-WebSocket-Version: 13\r\n", .{ target, authority, self.key });
        if (uri.user) |user| {
            const password = if (uri.password) |value| value.percent_encoded else "";
            const credentials = try std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ user.percent_encoded, password });
            defer self.allocator.free(credentials);
            const encoded = try self.allocator.alloc(u8, std.base64.standard.Encoder.calcSize(credentials.len));
            defer self.allocator.free(encoded);
            _ = std.base64.standard.Encoder.encode(encoded, credentials);
            try self.appendPrint("Authorization: Basic {s}\r\n", .{encoded});
        }
        try self.output.appendSlice(self.allocator, "\r\n");
        if (self.output.items.len > self.config.limits.request_bytes) return error.WebSocketRequestTooLarge;
        self.output_offset = 0;
    }

    fn appendPrint(self: *Client, comptime format: []const u8, arguments: anytype) !void {
        const text = try std.fmt.allocPrint(self.allocator, format, arguments);
        defer self.allocator.free(text);
        try self.output.appendSlice(self.allocator, text);
    }

    fn event(self: *Client, value: Event.Kind) Event {
        return .{ .generation = self.generation, .kind = value };
    }

    fn fail(self: *Client, err: anyerror) Event {
        self.failure = err;
        self.state = .failed;
        self.terminal_reported = false;
        return self.event(.{ .failed = err });
    }

    pub fn poll(self: *Client) !?Event {
        if (self.state == .idle) return null;
        if (self.state == .closed or self.state == .failed) {
            if (self.terminal_reported) return null;
            self.terminal_reported = true;
            return self.event(if (self.state == .failed) .{ .failed = self.failure orelse error.WebSocketClosed } else .closed);
        }
        if (self.config.cancel) |flag| if (flag.load(.acquire)) return self.fail(error.RequestCancelled);
        if (self.timer.?.read() >= self.deadline_ns) return self.fail(error.RequestDeadlineExceeded);
        return self.step() catch |err| self.fail(err);
    }

    fn step(self: *Client) !?Event {
        if (self.state == .open or self.state == .closing) {
            _ = try self.receive();
            const pending = try self.nextMessage();
            try self.flush();
            if (pending) |value| return value;
            if (self.state == .closing and self.control.items.len == 0) {
                self.state = .closed;
                return self.event(.closed);
            }
            if (self.eof_received) return self.fail(error.WebSocketEof);
            return null;
        }
        if (self.state == .connecting) try self.driveConnect();
        try self.flush();
        if (self.state == .handshake_write and self.output_offset == self.output.items.len) self.state = .handshake_read;
        if (self.state == .handshake_read) {
            _ = try self.receive();
            if (std.mem.indexOf(u8, self.input.items, "\r\n\r\n")) |end| {
                try self.validateHandshake(self.input.items[0 .. end + 4]);
                const remaining = self.input.items.len - (end + 4);
                std.mem.copyForwards(u8, self.input.items[0..remaining], self.input.items[end + 4 ..]);
                self.input.items.len = remaining;
                self.consumed = 0;
                self.output.clearRetainingCapacity();
                self.output_offset = 0;
                self.current_frame_end = 0;
                self.timer.?.reset();
                self.deadline_ns = self.config.read_timeout_ns;
                self.state = .open;
                return self.event(.connected);
            }
        }
        return null;
    }

    fn driveConnect(self: *Client) !void {
        var running: c_int = 0;
        const code = self.api.multi_perform(self.multi.?, &running);
        if (code > 0) return error.CurlConnectFailed;
        if (running > 0) {
            var timeout: c_long = 0;
            try abi.Api.check(self.api.multi_timeout(self.multi.?, &timeout));
            var count: c_int = 0;
            try abi.Api.check(self.api.multi_wait(self.multi.?, null, 0, @intCast(@min(self.config.idle_wait_ms, @as(u32, @intCast(@max(0, timeout))))), &count));
            const after = self.api.multi_perform(self.multi.?, &running);
            if (after > 0) return error.CurlConnectFailed;
        }
        if (running != 0) return;
        var remaining: c_int = 0;
        while (self.api.multi_info_read(self.multi.?, &remaining)) |message| {
            if (message.kind != 1 or message.easy != self.easy.?) continue;
            if (message.data.result != 0) return error.CurlConnectFailed;
            var socket: c_int = -1;
            try abi.Api.check(self.api.easy_getinfo(self.easy.?, 0x50002c, &socket));
            if (socket < 0) return error.CurlConnectFailed;
            self.socket = socket;
            self.state = .handshake_write;
            return;
        }
        return error.CurlConnectFailed;
    }

    fn sendSome(self: *Client, buffer: []const u8, offset: *usize, end: usize) !bool {
        while (offset.* < end) {
            var sent: usize = 0;
            const code = self.api.easy_send(self.easy.?, buffer[offset.*..end].ptr, end - offset.*, &sent);
            if (code == 81) return false;
            if (code != 0) return error.WebSocketWriteFailed;
            offset.* += sent;
            if (sent == 0) return false;
        }
        return true;
    }

    fn flush(self: *Client) !void {
        if (self.state != .handshake_write and self.state != .open and self.state != .closing) return;
        while (true) {
            // A partially sent application frame is atomic on the wire.
            if (self.output_offset > 0 and self.output_offset < self.current_frame_end) {
                if (!try self.sendSome(self.output.items, &self.output_offset, self.current_frame_end)) return;
            }
            if (!try self.sendSome(self.control.items, &self.control_offset, self.control.items.len)) return;
            self.control.clearRetainingCapacity();
            self.control_offset = 0;
            if (self.output_offset == self.current_frame_end and self.current_frame_end > 0) {
                const remaining = self.output.items.len - self.current_frame_end;
                std.mem.copyForwards(u8, self.output.items[0..remaining], self.output.items[self.current_frame_end..]);
                self.output.items.len = remaining;
                self.output_offset = 0;
                self.current_frame_end = remaining;
            }
            if (self.output_offset < self.current_frame_end) {
                if (!try self.sendSome(self.output.items, &self.output_offset, self.current_frame_end)) return;
                continue;
            }
            return;
        }
    }

    fn receive(self: *Client) !usize {
        var buffer: [16 * 1024]u8 = undefined;
        var count: usize = 0;
        const code = self.api.easy_recv(self.easy.?, &buffer, buffer.len, &count);
        if (code == 81) return 0;
        if (code != 0) return error.WebSocketReadFailed;
        if (count == 0) {
            self.eof_received = true;
            return 0;
        }
        const maximum = if (self.state == .handshake_read) self.config.limits.handshake_header_bytes else self.config.limits.frame_bytes + 64 * 1024;
        if (self.input.items.len - self.consumed + count > maximum) return error.WebSocketBufferLimit;
        try self.input.appendSlice(self.allocator, buffer[0..count]);
        return count;
    }

    fn validateHandshake(self: *Client, response: []const u8) !void {
        var lines = std.mem.splitSequence(u8, response, "\r\n");
        const status = lines.next() orelse return error.InvalidWebSocketHandshake;
        if (!std.mem.startsWith(u8, status, "HTTP/1.1 101 ") and !std.mem.startsWith(u8, status, "HTTP/1.0 101 ")) return error.WebSocketUpgradeRejected;
        var upgrade = false;
        var connection = false;
        var accepted = false;
        var extensions = false;
        while (lines.next()) |line| {
            if (line.len == 0) break;
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.InvalidWebSocketHandshake;
            const name = line[0..colon];
            const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
            if (std.ascii.eqlIgnoreCase(name, "upgrade")) upgrade = std.ascii.eqlIgnoreCase(value, "websocket");
            if (std.ascii.eqlIgnoreCase(name, "connection")) connection = containsToken(value, "upgrade");
            if (std.ascii.eqlIgnoreCase(name, "sec-websocket-extensions")) extensions = true;
            if (std.ascii.eqlIgnoreCase(name, "sec-websocket-accept")) {
                var hasher = std.crypto.hash.Sha1.init(.{});
                hasher.update(&self.key);
                hasher.update("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
                var digest: [20]u8 = undefined;
                hasher.final(&digest);
                var expected: [28]u8 = undefined;
                _ = std.base64.standard.Encoder.encode(&expected, &digest);
                accepted = std.mem.eql(u8, value, &expected);
            }
        }
        if (!upgrade or !connection or !accepted or extensions) return error.InvalidWebSocketHandshake;
    }

    fn containsToken(value: []const u8, expected: []const u8) bool {
        var tokens = std.mem.splitScalar(u8, value, ',');
        while (tokens.next()) |token| if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, token, " \t"), expected)) return true;
        return false;
    }

    fn nextMessage(self: *Client) !?Event {
        while (try self.takeFrame()) |frame| {
            self.timer.?.reset();
            self.deadline_ns = self.config.read_timeout_ns;
            switch (frame.opcode) {
                0x8 => {
                    if (self.state == .open) {
                        try self.writeFrame(0x8, frame.payload, true);
                        self.state = .closing;
                    }
                    return null;
                },
                0x9 => try self.writeFrame(0xA, frame.payload, true),
                0xA => {},
                0x0, 0x1, 0x2 => {
                    if (frame.opcode != 0) {
                        if (self.message_opcode != 0) return error.WebSocketFragmentation;
                        self.message_opcode = frame.opcode;
                        self.message.clearRetainingCapacity();
                    } else if (self.message_opcode == 0) return error.WebSocketFragmentation;
                    if (self.message.items.len + frame.payload.len > self.config.limits.message_bytes) return error.WebSocketMessageLimit;
                    try self.message.appendSlice(self.allocator, frame.payload);
                    if (frame.final) {
                        const opcode = self.message_opcode;
                        self.message_opcode = 0;
                        if (opcode == 1 and !std.unicode.utf8ValidateSlice(self.message.items)) return error.InvalidWebSocketUtf8;
                        if (opcode == 1) return self.event(.{ .text = self.message.items });
                        self.message.clearRetainingCapacity();
                    }
                },
                else => return error.InvalidWebSocketOpcode,
            }
        }
        return null;
    }

    const Frame = struct { opcode: u8, final: bool, payload: []const u8 };

    fn takeFrame(self: *Client) !?Frame {
        if (self.consumed > 64 * 1024) {
            const remaining = self.input.items.len - self.consumed;
            std.mem.copyForwards(u8, self.input.items[0..remaining], self.input.items[self.consumed..]);
            self.input.items.len = remaining;
            self.consumed = 0;
        }
        const bytes = self.input.items[self.consumed..];
        if (bytes.len < 2) return null;
        const first = bytes[0];
        const second = bytes[1];
        if (first & 0x70 != 0 or second & 0x80 != 0) return error.InvalidWebSocketFrame;
        const opcode = first & 0x0f;
        const control = opcode & 0x08 != 0;
        if (control and (first & 0x80 == 0 or second & 0x7f > 125)) return error.InvalidWebSocketControlFrame;
        var header: usize = 2;
        var length: u64 = second & 0x7f;
        if (length == 126) {
            if (bytes.len < 4) return null;
            length = std.mem.readInt(u16, bytes[2..4], .big);
            if (length < 126) return error.NoncanonicalWebSocketLength;
            header = 4;
        } else if (length == 127) {
            if (bytes.len < 10) return null;
            length = std.mem.readInt(u64, bytes[2..10], .big);
            if (length < 65536 or length >> 63 != 0) return error.NoncanonicalWebSocketLength;
            header = 10;
        }
        if (length > self.config.limits.frame_bytes) return error.WebSocketFrameLimit;
        const total = std.math.add(usize, header, std.math.cast(usize, length) orelse return error.WebSocketFrameLimit) catch return error.WebSocketFrameLimit;
        if (bytes.len < total) return null;
        const payload = bytes[header..total];
        self.consumed += total;
        if (self.consumed == self.input.items.len) {
            self.input.clearRetainingCapacity();
            self.consumed = 0;
        }
        return .{ .opcode = opcode, .final = first & 0x80 != 0, .payload = payload };
    }

    fn writeFrame(self: *Client, opcode: u8, payload: []const u8, control: bool) !void {
        if (self.output.items.len + self.control.items.len + payload.len + 14 > self.config.limits.outgoing_bytes) return error.WebSocketOutputLimit;
        if (opcode & 0x08 != 0 and payload.len > 125) return error.InvalidWebSocketControlFrame;
        if (!control and self.output_offset == self.current_frame_end and self.current_frame_end > 0) {
            const remaining = self.output.items.len - self.current_frame_end;
            std.mem.copyForwards(u8, self.output.items[0..remaining], self.output.items[self.current_frame_end..]);
            self.output.items.len = remaining;
            self.output_offset = 0;
            self.current_frame_end = remaining;
        }
        const target = if (control) &self.control else &self.output;
        var header: [10]u8 = undefined;
        var length: usize = 2;
        header[0] = 0x80 | opcode;
        if (payload.len < 126) {
            header[1] = 0x80 | @as(u8, @intCast(payload.len));
        } else if (payload.len <= std.math.maxInt(u16)) {
            header[1] = 0x80 | 126;
            std.mem.writeInt(u16, header[2..4], @intCast(payload.len), .big);
            length = 4;
        } else {
            header[1] = 0x80 | 127;
            std.mem.writeInt(u64, header[2..10], payload.len, .big);
            length = 10;
        }
        try target.appendSlice(self.allocator, header[0..length]);
        var mask: [4]u8 = undefined;
        std.crypto.random.bytes(&mask);
        try target.appendSlice(self.allocator, &mask);
        const start = target.items.len;
        try target.appendSlice(self.allocator, payload);
        for (target.items[start..], 0..) |*byte, index| byte.* ^= mask[index % 4];
        if (!control and self.current_frame_end == 0) self.current_frame_end = self.output.items.len;
    }

    fn hasCompleteBufferedFrame(self: *Client) bool {
        if (self.state == .handshake_read) return std.mem.indexOf(u8, self.input.items, "\r\n\r\n") != null;
        if (self.state != .open and self.state != .closing) return false;
        const bytes = self.input.items[self.consumed..];
        if (bytes.len < 2) return false;
        var header: usize = 2;
        var length: u64 = bytes[1] & 0x7f;
        if (length == 126) {
            if (bytes.len < 4) return false;
            length = std.mem.readInt(u16, bytes[2..4], .big);
            header = 4;
        } else if (length == 127) {
            if (bytes.len < 10) return false;
            length = std.mem.readInt(u64, bytes[2..10], .big);
            header = 10;
        }
        const payload = std.math.cast(usize, length) orelse return false;
        return payload <= bytes.len - header;
    }

    /// Wait for native socket/TLS readiness, never a timer-only sleep. Complete
    /// buffered frames return immediately; partial frames wait for more bytes.
    pub fn wait(self: *Client, max_ms: u32, cancel: ?*const std.atomic.Value(bool)) !void {
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (self.hasCompleteBufferedFrame()) return;
        if (self.state == .idle or self.state == .closed or self.state == .failed) return;
        if (self.state == .handshake_read or self.state == .open or self.state == .closing) {
            var reads: usize = 0;
            while (reads < 64) {
                const before = self.input.items.len;
                const count = try self.receive();
                if (count == 0) break;
                reads += 1;
                if (self.hasCompleteBufferedFrame()) return;
                if (self.input.items.len == before) break;
            }
            if (reads == 64) return;
        }
        if (self.socket >= 0 and self.state != .connecting) {
            const write_pending = self.output_offset < self.current_frame_end or self.control_offset < self.control.items.len;
            const events: i16 = std.posix.POLL.IN | (if (write_pending) @as(i16, std.posix.POLL.OUT) else @as(i16, 0));
            var fds = [_]std.posix.pollfd{.{ .fd = self.socket, .events = events, .revents = 0 }};
            _ = try std.posix.poll(&fds, @min(max_ms, 200));
        } else {
            const multi = self.multi orelse return;
            var count: c_int = 0;
            try abi.Api.check(self.api.multi_wait(multi, null, 0, @intCast(@min(max_ms, 200)), &count));
        }
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
    }

    pub fn sendText(self: *Client, text: []const u8) !void {
        if (self.state != .open) return error.WebSocketNotConnected;
        if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidWebSocketUtf8;
        try self.writeFrame(0x1, text, false);
    }

    pub fn sendClose(self: *Client, code: u16, reason: []const u8) !void {
        if (self.state != .open) return error.WebSocketNotConnected;
        if (reason.len > 123 or code < 1000) return error.InvalidWebSocketClose;
        var payload: [125]u8 = undefined;
        std.mem.writeInt(u16, payload[0..2], code, .big);
        @memcpy(payload[2..][0..reason.len], reason);
        try self.writeFrame(0x8, payload[0 .. reason.len + 2], true);
        self.state = .closing;
    }
};
