//! Bounded native HTTP/1.0 and HTTP/1.1 server. One nonblocking socket owner
//! dispatches owned requests to a fixed I/O pool; callbacks never run on it.
const std = @import("std");
const builtin = @import("builtin");
const io_pool = @import("../runtime/io_pool.zig");
const A = std.mem.Allocator;

fn exclusiveListener(address: std.net.Address) !std.net.Server {
    const posix = std.posix;
    const protocol: u32 = if (address.any.family == posix.AF.UNIX) 0 else posix.IPPROTO.TCP;
    const socket = try posix.socket(address.any.family, posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK, protocol);
    var server: std.net.Server = .{ .listen_address = undefined, .stream = .{ .handle = socket } };
    errdefer server.deinit();
    // Address.listen(reuse_address=true) also enables SO_REUSEPORT in Zig
    // 0.15.2. That would allow two active agent/admin listeners on one port.
    // Reuse only TIME_WAIT addresses; keep exclusive ownership while live.
    try posix.setsockopt(socket, posix.SOL.SOCKET, posix.SO.REUSEADDR, &std.mem.toBytes(@as(c_int, 1)));
    var length = address.getOsSockLen();
    try posix.bind(socket, &address.any, length);
    try posix.listen(socket, 128);
    try posix.getsockname(socket, &server.listen_address.any, &length);
    return server;
}

pub const Version = enum { http_1_0, http_1_1 };
pub const Header = struct { name: []const u8, value: []const u8 };

const Budget = struct {
    used: std.atomic.Value(usize) = .init(0),
    limit: usize,

    fn reserve(self: *Budget, amount: usize) !void {
        var current = self.used.load(.acquire);
        while (true) {
            const next = std.math.add(usize, current, amount) catch return error.HttpAggregateLimit;
            if (next > self.limit) return error.HttpAggregateLimit;
            if (self.used.cmpxchgWeak(current, next, .acq_rel, .acquire)) |actual| {
                current = actual;
            } else return;
        }
    }

    fn release(self: *Budget, amount: usize) void {
        _ = self.used.fetchSub(amount, .acq_rel);
    }
};

pub const Request = struct {
    allocator: A,
    storage: []u8,
    header_storage: []Header,
    budget: ?*Budget = null,
    method: []const u8,
    target: []const u8,
    path: []const u8,
    query: ?[]const u8,
    version: Version,
    headers: []const Header,
    body: []const u8,

    fn init(server: *Server, bytes: []const u8, info: HeadInfo) !Request {
        const reserved = try std.math.add(usize, bytes.len, info.header_count * @sizeOf(Header));
        try server.budget.reserve(reserved);
        errdefer server.budget.release(reserved);
        const storage = try server.allocator.dupe(u8, bytes);
        errdefer server.allocator.free(storage);
        const headers = try server.allocator.alloc(Header, info.header_count);
        errdefer server.allocator.free(headers);
        var lines = std.mem.splitSequence(u8, storage[0..info.head_end], "\r\n");
        const request_line = lines.next() orelse return error.HttpBadRequest;
        const first_space = std.mem.indexOfScalar(u8, request_line, ' ') orelse return error.HttpBadRequest;
        const second_space = std.mem.indexOfScalarPos(u8, request_line, first_space + 1, ' ') orelse return error.HttpBadRequest;
        const target = request_line[first_space + 1 .. second_space];
        const query_start = std.mem.indexOfScalar(u8, target, '?');
        const path = if (query_start) |index| target[0..index] else target;
        const query = if (query_start) |index| target[index + 1 ..] else null;
        var count: usize = 0;
        while (lines.next()) |line| {
            if (line.len == 0) break;
            headers[count] = try parseHeaderLine(line);
            count += 1;
        }
        if (count != headers.len) return error.HttpBadRequest;
        const body_len = if (info.chunked) try decodeChunked(storage, info.head_end) else info.content_length orelse 0;
        return .{
            .allocator = server.allocator,
            .storage = storage,
            .header_storage = headers,
            .budget = &server.budget,
            .method = request_line[0..first_space],
            .target = target,
            .path = path,
            .query = query,
            .version = if (info.http_1_0) .http_1_0 else .http_1_1,
            .headers = headers,
            .body = storage[info.head_end..][0..body_len],
        };
    }

    /// Normally called by the server after callback retirement. All slices are
    /// owned by this value and remain valid until then.
    pub fn deinit(self: *Request) void {
        const reserved = self.storage.len + self.header_storage.len * @sizeOf(Header);
        self.allocator.free(self.storage);
        self.allocator.free(self.header_storage);
        if (self.budget) |budget| budget.release(reserved);
        self.* = undefined;
    }

    pub fn header(self: *const Request, name: []const u8) ?[]const u8 {
        for (self.headers) |item| if (eqlIgnoreCase(item.name, name)) return item.value;
        return null;
    }
};

pub const Response = struct {
    allocator: A,
    storage: []u8,
    header_storage: []Header,
    budget: ?*Budget = null,
    status: u16,
    headers: []const Header,
    body: []const u8,
    close: bool = false,

    /// Copies body and every header. The returned value owns all response data.
    pub fn init(allocator: A, status: u16, headers: []const Header, body: []const u8) !Response {
        var storage_len = body.len;
        for (headers) |item| storage_len = try std.math.add(usize, storage_len, try std.math.add(usize, item.name.len, item.value.len));
        const storage = try allocator.alloc(u8, storage_len);
        errdefer allocator.free(storage);
        const header_storage = try allocator.alloc(Header, headers.len);
        errdefer allocator.free(header_storage);
        var offset: usize = 0;
        for (headers, header_storage) |item, *copy| {
            @memcpy(storage[offset..][0..item.name.len], item.name);
            const name = storage[offset..][0..item.name.len];
            offset += item.name.len;
            @memcpy(storage[offset..][0..item.value.len], item.value);
            const value = storage[offset..][0..item.value.len];
            offset += item.value.len;
            copy.* = .{ .name = name, .value = value };
        }
        @memcpy(storage[offset..][0..body.len], body);
        return .{ .allocator = allocator, .storage = storage, .header_storage = header_storage, .status = status, .headers = header_storage, .body = storage[offset..][0..body.len] };
    }

    pub fn deinit(self: *Response) void {
        const reserved = self.storage.len + self.header_storage.len * @sizeOf(Header);
        self.allocator.free(self.storage);
        self.allocator.free(self.header_storage);
        if (self.budget) |budget| budget.release(reserved);
        self.* = undefined;
    }

    fn reserve(self: *Response, budget: *Budget, max_body: usize, max_headers: usize) !void {
        if (self.body.len > max_body or self.storage.len > try std.math.add(usize, max_body, max_headers)) return error.HttpResponseTooLarge;
        try budget.reserve(self.storage.len + self.header_storage.len * @sizeOf(Header));
        self.budget = budget;
    }
};

/// Callback input is owned by the server and freed after the callback returns.
/// Return Response.init values; callbacks must be thread-safe and must observe
/// cancel for bounded shutdown. The allocator must also be thread-safe.
pub const Handler = struct {
    context: *anyopaque,
    handle_fn: *const fn (context: *anyopaque, allocator: A, request: Request, cancel: *const std.atomic.Value(bool)) anyerror!Response,
};

pub const Options = struct {
    address: std.net.Address,
    max_header_bytes: usize = 16 * 1024,
    max_headers: usize = 64,
    max_body_bytes: usize = 2 * 1024 * 1024,
    max_chunk_overhead_bytes: usize = 64 * 1024,
    max_pipeline_bytes: usize = 64 * 1024,
    max_response_bytes: usize = 8 * 1024 * 1024,
    max_aggregate_bytes: usize = 32 * 1024 * 1024,
    max_connections: usize = 128,
    request_timeout_ms: u64 = 5_000,
    keep_alive_timeout_ms: u64 = 5_000,
    write_timeout_ms: u64 = 1_000,

    fn validate(self: Options) !void {
        if (self.max_header_bytes < 64 or self.max_header_bytes > self.max_aggregate_bytes or self.max_headers == 0 or self.max_headers > 256) return error.InvalidHttpConfig;
        if (self.max_body_bytes > self.max_aggregate_bytes or self.max_response_bytes == 0 or self.max_response_bytes > self.max_aggregate_bytes) return error.InvalidHttpConfig;
        if (self.max_chunk_overhead_bytes < 16 or self.max_pipeline_bytes > self.max_aggregate_bytes) return error.InvalidHttpConfig;
        if (self.max_connections == 0 or self.max_connections > 1024) return error.InvalidHttpConfig;
        if (self.request_timeout_ms == 0 or self.keep_alive_timeout_ms == 0 or self.write_timeout_ms == 0) return error.InvalidHttpConfig;
        _ = try std.math.add(usize, self.max_header_bytes, try std.math.add(usize, self.max_body_bytes, try std.math.add(usize, self.max_chunk_overhead_bytes, self.max_pipeline_bytes)));
    }

    fn inputLimit(self: Options) usize {
        return self.max_header_bytes + self.max_body_bytes + self.max_chunk_overhead_bytes + self.max_pipeline_bytes;
    }
};

const JobContext = struct {
    allocator: A,
    handler: Handler,
    budget: *Budget,
    max_response_bytes: usize,
    max_header_bytes: usize,

    fn run(self: *JobContext, request: Request, cancel: *const std.atomic.Value(bool)) anyerror!Response {
        if (cancel.load(.acquire)) return error.HttpCancelled;
        var response = try self.handler.handle_fn(self.handler.context, self.allocator, request, cancel);
        errdefer response.deinit();
        if (cancel.load(.acquire)) return error.HttpCancelled;
        try response.reserve(self.budget, self.max_response_bytes, self.max_header_bytes);
        return response;
    }
    fn freeInput(self: *JobContext, request: Request) void {
        var owned = request;
        owned.deinit();
        _ = self;
    }
    fn freeOutput(self: *JobContext, response: Response) void {
        var owned = response;
        owned.deinit();
        _ = self;
    }
};
const Worker = io_pool.Pool(Request, Response, JobContext, 8, 64);

const Connection = struct {
    fd: std.posix.fd_t = -1,
    input: std.ArrayList(u8) = .empty,
    input_reserved: usize = 0,
    output: []u8 = &.{},
    output_offset: usize = 0,
    job: ?Worker.JobId = null,
    active: bool = false,
    head: bool = false,
    http_1_0: bool = false,
    close_after_write: bool = false,
    read_closed: bool = false,
    deadline_ms: u64 = 0,
};

pub const Server = struct {
    allocator: A,
    options: Options,
    listener: std.net.Server,
    bound_address: std.net.Address,
    job_context: JobContext,
    budget: Budget,
    pool: *Worker,
    connections: []Connection,
    polls: []std.posix.pollfd,
    thread: std.Thread,
    stopping: std.atomic.Value(bool) = .init(false),
    stop_mutex: std.Thread.Mutex = .{},
    joined: bool = false,
    failure_mutex: std.Thread.Mutex = .{},
    failure_value: ?anyerror = null,

    pub fn start(allocator: A, options: Options, handler: Handler) !*Server {
        try options.validate();
        const self = try allocator.create(Server);
        errdefer allocator.destroy(self);
        const listener = try exclusiveListener(options.address);
        errdefer {
            var owned = listener;
            owned.deinit();
        }
        const connections = try allocator.alloc(Connection, options.max_connections);
        errdefer allocator.free(connections);
        @memset(connections, .{});
        const polls = try allocator.alloc(std.posix.pollfd, options.max_connections + 1);
        errdefer allocator.free(polls);
        self.* = .{
            .allocator = allocator,
            .options = options,
            .listener = listener,
            .bound_address = listener.listen_address,
            .budget = .{ .limit = options.max_aggregate_bytes },
            .job_context = .{ .allocator = allocator, .handler = handler, .budget = undefined, .max_response_bytes = options.max_response_bytes, .max_header_bytes = options.max_header_bytes },
            .pool = undefined,
            .connections = connections,
            .polls = polls,
            .thread = undefined,
        };
        self.job_context.budget = &self.budget;
        self.pool = try Worker.start(allocator, &self.job_context, JobContext.run, JobContext.freeInput, JobContext.freeOutput);
        errdefer self.pool.deinit();
        self.thread = try std.Thread.spawn(.{}, ownerMain, .{self});
        return self;
    }

    pub fn address(self: *const Server) std.net.Address {
        return self.bound_address;
    }

    /// Last fatal listener/owner failure, safe to read while the server runs.
    pub fn failure(self: *Server) ?anyerror {
        self.failure_mutex.lock();
        defer self.failure_mutex.unlock();
        return self.failure_value;
    }

    pub fn checkFailure(self: *Server) !void {
        if (self.failure()) |err| return err;
    }

    /// Stops accepts, closes every socket, cancels and joins all callbacks.
    /// Returns only after handler context is no longer referenced by workers.
    pub fn stop(self: *Server) void {
        self.stop_mutex.lock();
        defer self.stop_mutex.unlock();
        if (self.joined) return;
        self.stopping.store(true, .release);
        self.thread.join();
        self.joined = true;
    }

    pub fn deinit(self: *Server) void {
        self.stop();
        self.allocator.free(self.connections);
        self.allocator.free(self.polls);
        const allocator = self.allocator;
        allocator.destroy(self);
    }

    fn recordFailure(self: *Server, err: anyerror) void {
        self.failure_mutex.lock();
        self.failure_value = err;
        self.failure_mutex.unlock();
    }
};

fn ownerMain(self: *Server) void {
    run(self) catch |err| self.recordFailure(err);
    cleanup(self);
}

fn cleanup(self: *Server) void {
    self.listener.deinit();
    for (self.connections) |*connection| closeConnection(self, connection);
    self.pool.deinit();
}

fn run(self: *Server) !void {
    var timer = try std.time.Timer.start();
    while (!self.stopping.load(.acquire)) {
        const now = timer.read() / std.time.ns_per_ms;
        collectJobs(self, now);
        self.polls[0] = .{ .fd = self.listener.stream.handle, .events = if (freeConnection(self) != null) std.posix.POLL.IN else 0, .revents = 0 };
        for (self.connections, self.polls[1..]) |*connection, *poll| {
            poll.* = .{ .fd = connection.fd, .events = 0, .revents = 0 };
            if (connection.fd < 0) continue;
            if (connection.output.len != 0) {
                poll.events = std.posix.POLL.OUT;
            } else if (!connection.read_closed and !connection.close_after_write and connection.input.items.len < self.options.inputLimit()) {
                poll.events = std.posix.POLL.IN;
            }
        }
        _ = try std.posix.poll(self.polls, 5);
        const after = timer.read() / std.time.ns_per_ms;
        if (self.polls[0].revents & std.posix.POLL.NVAL != 0) return error.HttpListenerClosed;
        if (self.polls[0].revents & std.posix.POLL.IN != 0) try acceptConnections(self, after);
        for (self.connections, self.polls[1..]) |*connection, poll| {
            if (connection.fd < 0) continue;
            if (poll.revents & std.posix.POLL.NVAL != 0) {
                closeConnection(self, connection);
                continue;
            }
            if (poll.revents & std.posix.POLL.OUT != 0) writeConnection(self, connection, after);
            if (connection.fd >= 0 and poll.revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) readConnection(self, connection, after);
            if (connection.fd >= 0) advanceConnection(self, connection, after);
        }
        collectJobs(self, timer.read() / std.time.ns_per_ms);
    }
}

fn freeConnection(self: *Server) ?*Connection {
    for (self.connections) |*connection| if (connection.fd < 0) return connection;
    return null;
}

fn acceptConnections(self: *Server, now: u64) !void {
    while (freeConnection(self)) |connection| {
        const accepted = self.listener.accept() catch |err| switch (err) {
            error.WouldBlock => return,
            error.ConnectionAborted, error.ConnectionResetByPeer => continue,
            else => return err,
        };
        var transferred = false;
        defer if (!transferred) accepted.stream.close();
        setNonblocking(accepted.stream.handle) catch continue;
        disableSigpipe(accepted.stream.handle) catch continue;
        connection.* = .{ .fd = accepted.stream.handle, .deadline_ms = now +| self.options.request_timeout_ms };
        transferred = true;
    }
}

fn setNonblocking(fd: std.posix.fd_t) !void {
    const flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags | @as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
}

fn disableSigpipe(fd: std.posix.fd_t) !void {
    if (builtin.os.tag == .macos and @hasDecl(std.posix.SO, "NOSIGPIPE")) {
        try std.posix.setsockopt(fd, std.posix.SOL.SOCKET, std.posix.SO.NOSIGPIPE, &std.mem.toBytes(@as(c_int, 1)));
    }
}

fn readConnection(self: *Server, connection: *Connection, now: u64) void {
    if (connection.read_closed) return;
    var buffer: [8192]u8 = undefined;
    const allowed = @min(buffer.len, self.options.inputLimit() - connection.input.items.len);
    if (allowed == 0) {
        setError(self, connection, 413, now);
        return;
    }
    const count = std.posix.read(connection.fd, buffer[0..allowed]) catch |err| switch (err) {
        error.WouldBlock => return,
        else => {
            closeConnection(self, connection);
            return;
        },
    };
    if (count == 0) {
        connection.read_closed = true;
        connection.close_after_write = true;
        return;
    }
    if (!connection.active) {
        connection.active = true;
        connection.deadline_ms = now +| self.options.request_timeout_ms;
    }
    ensureInput(self, connection, count) catch {
        setError(self, connection, 503, now);
        return;
    };
    connection.input.appendSliceAssumeCapacity(buffer[0..count]);
}

fn ensureInput(self: *Server, connection: *Connection, additional: usize) !void {
    const needed = try std.math.add(usize, connection.input.items.len, additional);
    if (needed <= connection.input.capacity) return;
    try reserveBudget(&self.budget, needed - connection.input_reserved);
    errdefer releaseBudget(&self.budget, needed - connection.input_reserved);
    try connection.input.ensureTotalCapacityPrecise(self.allocator, needed);
    connection.input_reserved = connection.input.capacity;
}

fn advanceConnection(self: *Server, connection: *Connection, now: u64) void {
    if (connection.output.len != 0) {
        if (now >= connection.deadline_ms) closeConnection(self, connection);
        return;
    }
    if (connection.job != null) return;
    if (connection.input.items.len != 0) {
        if (!connection.active) {
            connection.active = true;
            connection.deadline_ms = now +| self.options.request_timeout_ms;
        }
        if (now >= connection.deadline_ms) {
            setError(self, connection, 408, now);
            return;
        }
        parseAndSubmit(self, connection, now);
        if (connection.read_closed and connection.job == null and connection.output.len == 0) closeConnection(self, connection);
        return;
    }
    if (connection.read_closed) {
        closeConnection(self, connection);
    } else if (connection.active and now >= connection.deadline_ms) {
        setError(self, connection, 408, now);
    } else if (!connection.active and now >= connection.deadline_ms and connection.deadline_ms != 0) {
        closeConnection(self, connection);
    }
}

const HeadInfo = struct {
    head_end: usize,
    header_count: usize,
    content_length: ?usize,
    chunked: bool,
    head: bool,
    http_1_0: bool,
    close: bool,
};

const BodyResult = union(enum) { incomplete, complete: usize };

fn parseAndSubmit(self: *Server, connection: *Connection, now: u64) void {
    const input = connection.input.items;
    const head_end = findHead(input, self.options.max_header_bytes) catch |err| {
        setError(self, connection, parseStatus(err), now);
        return;
    } orelse return;
    const info = analyzeHead(input[0..head_end], self.options.max_headers) catch |err| {
        setError(self, connection, parseStatus(err), now);
        return;
    };
    connection.head = info.head;
    connection.http_1_0 = info.http_1_0;
    const body = parseBody(input, info, self.options.max_body_bytes, self.options.max_chunk_overhead_bytes) catch |err| {
        setError(self, connection, parseStatus(err), now);
        return;
    };
    const consumed = switch (body) {
        .incomplete => return,
        .complete => |length| length,
    };
    var request = Request.init(self, input[0..consumed], info) catch {
        setError(self, connection, 503, now);
        return;
    };
    consumeInput(self, connection, consumed);
    connection.close_after_write = connection.close_after_write or info.close;
    const id = self.pool.submit(request, now, connection.deadline_ms) catch {
        request.deinit();
        setError(self, connection, 503, now);
        return;
    };
    connection.job = id;
}

fn parseStatus(err: anyerror) u16 {
    return switch (err) {
        error.HttpHeadersTooLarge => 431,
        error.HttpBodyTooLarge => 413,
        error.HttpVersionNotSupported => 505,
        else => 400,
    };
}

fn consumeInput(self: *Server, connection: *Connection, consumed: usize) void {
    const remaining = connection.input.items.len - consumed;
    std.mem.copyForwards(u8, connection.input.items[0..remaining], connection.input.items[consumed..]);
    connection.input.items.len = remaining;
    if (remaining == 0 or connection.input.capacity > 64 * 1024) {
        const before = connection.input_reserved;
        connection.input.shrinkAndFree(self.allocator, remaining);
        connection.input_reserved = connection.input.capacity;
        if (before > connection.input_reserved) releaseBudget(&self.budget, before - connection.input_reserved);
    }
}

fn collectJobs(self: *Server, now: u64) void {
    var count: usize = 0;
    while (count < 64) : (count += 1) {
        const completion = self.pool.poll(now) orelse break;
        var found: ?*Connection = null;
        for (self.connections) |*connection| {
            const id = connection.job orelse continue;
            if (id.slot == completion.id.slot and id.sequence == completion.id.sequence) {
                found = connection;
                break;
            }
        }
        const connection = found orelse {
            if (completion.result == .value) {
                var response = completion.result.value;
                response.deinit();
            }
            continue;
        };
        connection.job = null;
        switch (completion.result) {
            .failure => |err| setError(self, connection, if (err == error.IoTimeout) 503 else 500, now),
            .value => |value| {
                var response = value;
                defer response.deinit();
                if (response.close) connection.close_after_write = true;
                const wire = render(self, connection, response) catch {
                    setError(self, connection, 500, now);
                    continue;
                };
                connection.output = wire;
                connection.output_offset = 0;
            },
        }
    }
}

fn render(self: *Server, connection: *Connection, response: Response) ![]u8 {
    if (response.status < 200 or response.status > 599) return error.HttpInvalidResponse;
    const reason = reasonPhrase(response.status);
    for (response.headers) |item| {
        if (!validToken(item.name) or !validHeaderValue(item.value)) return error.HttpInvalidResponse;
        if (eqlIgnoreCase(item.name, "content-length") or eqlIgnoreCase(item.name, "transfer-encoding") or eqlIgnoreCase(item.name, "connection")) return error.HttpInvalidResponse;
    }
    const version = if (connection.http_1_0) "HTTP/1.0" else "HTTP/1.1";
    const connection_header = if (connection.close_after_write) "Connection: close\r\n" else if (connection.http_1_0) "Connection: keep-alive\r\n" else "";
    const status_len = version.len + 1 + 3 + 1 + reason.len + 2;
    var wire_len = status_len + connection_header.len + 2;
    wire_len = try std.math.add(usize, wire_len, std.fmt.count("Content-Length: {d}\r\n", .{response.body.len}));
    for (response.headers) |item| wire_len = try std.math.add(usize, wire_len, item.name.len + 2 + item.value.len + 2);
    if ((response.status == 204 or response.status == 304) and response.body.len != 0) return error.HttpInvalidResponse;
    const body_len = if (connection.head or response.status == 204 or response.status == 304) 0 else response.body.len;
    wire_len = try std.math.add(usize, wire_len, body_len);
    const wire_limit = try std.math.add(usize, self.options.max_response_bytes, try std.math.add(usize, self.options.max_header_bytes, 1024));
    if (wire_len > wire_limit) return error.HttpInvalidResponse;
    try reserveBudget(&self.budget, wire_len);
    errdefer releaseBudget(&self.budget, wire_len);
    const wire = try self.allocator.alloc(u8, wire_len);
    errdefer self.allocator.free(wire);
    var offset: usize = 0;
    const status = try std.fmt.bufPrint(wire[offset..], "{s} {d} {s}\r\n", .{ version, response.status, reason });
    offset += status.len;
    for (response.headers) |item| {
        @memcpy(wire[offset..][0..item.name.len], item.name);
        offset += item.name.len;
        @memcpy(wire[offset..][0..2], ": ");
        offset += 2;
        @memcpy(wire[offset..][0..item.value.len], item.value);
        offset += item.value.len;
        @memcpy(wire[offset..][0..2], "\r\n");
        offset += 2;
    }
    const length = try std.fmt.bufPrint(wire[offset..], "Content-Length: {d}\r\n", .{response.body.len});
    offset += length.len;
    @memcpy(wire[offset..][0..connection_header.len], connection_header);
    offset += connection_header.len;
    @memcpy(wire[offset..][0..2], "\r\n");
    offset += 2;
    @memcpy(wire[offset..][0..body_len], response.body[0..body_len]);
    return wire;
}

fn writeConnection(self: *Server, connection: *Connection, now: u64) void {
    if (connection.output.len == 0) return;
    const flags: u32 = if (@hasDecl(std.posix.MSG, "NOSIGNAL")) std.posix.MSG.NOSIGNAL else 0;
    const count = std.posix.send(connection.fd, connection.output[connection.output_offset..], flags) catch |err| switch (err) {
        error.WouldBlock => return,
        else => {
            closeConnection(self, connection);
            return;
        },
    };
    if (count == 0) {
        closeConnection(self, connection);
        return;
    }
    connection.output_offset += count;
    if (connection.output_offset != connection.output.len) return;
    freeOutput(self, connection);
    if (connection.close_after_write) {
        closeConnection(self, connection);
        return;
    }
    connection.active = false;
    connection.head = false;
    connection.deadline_ms = now +| self.options.keep_alive_timeout_ms;
    advanceConnection(self, connection, now);
}

fn freeOutput(self: *Server, connection: *Connection) void {
    if (connection.output.len == 0) return;
    self.allocator.free(connection.output);
    releaseBudget(&self.budget, connection.output.len);
    connection.output = &.{};
    connection.output_offset = 0;
}

fn setError(self: *Server, connection: *Connection, status: u16, now: u64) void {
    if (connection.fd < 0) return;
    if (connection.job) |id| {
        _ = self.pool.cancel(id) catch null;
        connection.job = null;
    }
    freeOutput(self, connection);
    var response = Response.init(self.allocator, status, &.{.{ .name = "Content-Type", .value = "text/plain; charset=utf-8" }}, reasonPhrase(status)) catch {
        closeConnection(self, connection);
        return;
    };
    defer response.deinit();
    connection.http_1_0 = false;
    connection.close_after_write = true;
    const wire = render(self, connection, response) catch {
        closeConnection(self, connection);
        return;
    };
    connection.output = wire;
    connection.output_offset = 0;
    connection.active = true;
    connection.deadline_ms = now +| self.options.write_timeout_ms;
}

fn closeConnection(self: *Server, connection: *Connection) void {
    if (connection.fd < 0) return;
    if (connection.job) |id| {
        _ = self.pool.cancel(id) catch null;
        connection.job = null;
    }
    freeOutput(self, connection);
    if (connection.input_reserved != 0) releaseBudget(&self.budget, connection.input_reserved);
    connection.input.deinit(self.allocator);
    std.posix.close(connection.fd);
    connection.* = .{};
}

fn reserveBudget(budget: *Budget, amount: usize) !void {
    try budget.reserve(amount);
}

fn releaseBudget(budget: *Budget, amount: usize) void {
    budget.release(amount);
}

fn findHead(input: []const u8, max_bytes: usize) !?usize {
    var index: usize = 0;
    while (index < input.len) : (index += 1) {
        if (input[index] == '\n' and (index == 0 or input[index - 1] != '\r')) return error.HttpBadRequest;
        if (input[index] == '\r' and index + 1 < input.len and input[index + 1] != '\n') return error.HttpBadRequest;
        if (index >= 3 and std.mem.eql(u8, input[index - 3 .. index + 1], "\r\n\r\n")) {
            if (index + 1 > max_bytes) return error.HttpHeadersTooLarge;
            return index + 1;
        }
    }
    if (input.len >= max_bytes) return error.HttpHeadersTooLarge;
    return null;
}

fn analyzeHead(head: []const u8, max_headers: usize) !HeadInfo {
    var lines = std.mem.splitSequence(u8, head, "\r\n");
    const request_line = lines.next() orelse return error.HttpBadRequest;
    const first_space = std.mem.indexOfScalar(u8, request_line, ' ') orelse return error.HttpBadRequest;
    const second_space = std.mem.indexOfScalarPos(u8, request_line, first_space + 1, ' ') orelse return error.HttpBadRequest;
    if (std.mem.indexOfScalarPos(u8, request_line, second_space + 1, ' ') != null) return error.HttpBadRequest;
    const method = request_line[0..first_space];
    const target = request_line[first_space + 1 .. second_space];
    if (!validToken(method) or !validTarget(target)) return error.HttpBadRequest;
    const version_text = request_line[second_space + 1 ..];
    const http_1_0 = if (std.mem.eql(u8, version_text, "HTTP/1.0")) true else if (std.mem.eql(u8, version_text, "HTTP/1.1")) false else return error.HttpVersionNotSupported;
    var content_length: ?usize = null;
    var transfer_encoding = false;
    var connection_close = false;
    var connection_keep_alive = false;
    var host_count: usize = 0;
    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) break;
        if (count == max_headers) return error.HttpHeadersTooLarge;
        count += 1;
        const parsed = try parseHeaderLine(line);
        if (eqlIgnoreCase(parsed.name, "content-length")) {
            if (content_length != null or transfer_encoding) return error.HttpBadRequest;
            content_length = try parseContentLength(parsed.value);
        } else if (eqlIgnoreCase(parsed.name, "transfer-encoding")) {
            if (transfer_encoding or content_length != null) return error.HttpBadRequest;
            transfer_encoding = true;
            if (!eqlIgnoreCase(std.mem.trim(u8, parsed.value, " \t"), "chunked")) return error.HttpBadRequest;
        } else if (eqlIgnoreCase(parsed.name, "connection")) {
            var tokens = std.mem.splitScalar(u8, parsed.value, ',');
            while (tokens.next()) |raw| {
                const token = std.mem.trim(u8, raw, " \t");
                if (!validToken(token)) return error.HttpBadRequest;
                if (eqlIgnoreCase(token, "close")) connection_close = true;
                if (eqlIgnoreCase(token, "keep-alive")) connection_keep_alive = true;
            }
        } else if (eqlIgnoreCase(parsed.name, "host")) {
            host_count += 1;
            if (host_count > 1 or parsed.value.len == 0) return error.HttpBadRequest;
        }
    }
    if (!http_1_0 and host_count != 1) return error.HttpBadRequest;
    return .{ .head_end = head.len, .header_count = count, .content_length = content_length, .chunked = transfer_encoding, .head = std.mem.eql(u8, method, "HEAD"), .http_1_0 = http_1_0, .close = connection_close or (http_1_0 and !connection_keep_alive) };
}

fn parseHeaderLine(line: []const u8) !Header {
    const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.HttpBadRequest;
    const name = line[0..colon];
    if (!validToken(name)) return error.HttpBadRequest;
    const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
    if (!validHeaderValue(value)) return error.HttpBadRequest;
    return .{ .name = name, .value = value };
}

fn parseContentLength(raw: []const u8) !usize {
    if (raw.len == 0) return error.HttpBadRequest;
    var value: usize = 0;
    for (raw) |byte| {
        if (byte < '0' or byte > '9') return error.HttpBadRequest;
        value = std.math.mul(usize, value, 10) catch return error.HttpBadRequest;
        value = std.math.add(usize, value, byte - '0') catch return error.HttpBadRequest;
    }
    return value;
}

fn parseBody(input: []const u8, info: HeadInfo, max_body: usize, max_overhead: usize) !BodyResult {
    if (!info.chunked) {
        const length = info.content_length orelse 0;
        if (length > max_body) return error.HttpBodyTooLarge;
        const end = std.math.add(usize, info.head_end, length) catch return error.HttpBodyTooLarge;
        if (input.len < end) return .incomplete;
        return .{ .complete = end };
    }
    var position = info.head_end;
    var decoded: usize = 0;
    var overhead: usize = 0;
    while (true) {
        const maybe_line = try readCrlfLine(input, position, max_overhead + 1);
        const line = maybe_line orelse return .incomplete;
        overhead = try addOverhead(overhead, line.consumed, max_overhead);
        const size = try parseChunkSize(line.bytes);
        if (size == 0) {
            position = line.next;
            while (true) {
                const maybe_trailer = try readCrlfLine(input, position, max_overhead + 1);
                const trailer = maybe_trailer orelse return .incomplete;
                overhead = try addOverhead(overhead, trailer.consumed, max_overhead);
                if (trailer.bytes.len == 0) return .{ .complete = trailer.next };
                const item = try parseHeaderLine(trailer.bytes);
                if (eqlIgnoreCase(item.name, "content-length") or eqlIgnoreCase(item.name, "transfer-encoding")) return error.HttpBadRequest;
                position = trailer.next;
            }
        }
        if (size > max_body -| decoded) return error.HttpBodyTooLarge;
        decoded += size;
        const data_end = std.math.add(usize, line.next, size) catch return error.HttpBodyTooLarge;
        const chunk_end = std.math.add(usize, data_end, 2) catch return error.HttpBodyTooLarge;
        if (input.len < chunk_end) return .incomplete;
        if (!std.mem.eql(u8, input[data_end..chunk_end], "\r\n")) return error.HttpBadRequest;
        overhead = try addOverhead(overhead, 2, max_overhead);
        position = chunk_end;
    }
}

const CrlfLine = struct { bytes: []const u8, next: usize, consumed: usize };
fn readCrlfLine(input: []const u8, start: usize, max_len: usize) !?CrlfLine {
    if (start > input.len) return error.HttpBadRequest;
    var index = start;
    while (index < input.len) : (index += 1) {
        if (index - start >= max_len) return error.HttpBodyTooLarge;
        if (input[index] == '\n') {
            if (index == start or input[index - 1] != '\r') return error.HttpBadRequest;
            return .{ .bytes = input[start .. index - 1], .next = index + 1, .consumed = index + 1 - start };
        }
        if (input[index] == '\r' and index + 1 < input.len and input[index + 1] != '\n') return error.HttpBadRequest;
    }
    if (input.len - start >= max_len) return error.HttpBodyTooLarge;
    return null;
}

fn parseChunkSize(line: []const u8) !usize {
    const end = std.mem.indexOfScalar(u8, line, ';') orelse line.len;
    if (end == 0) return error.HttpBadRequest;
    var value: usize = 0;
    for (line[0..end]) |byte| {
        const digit = std.fmt.charToDigit(byte, 16) catch return error.HttpBadRequest;
        value = std.math.mul(usize, value, 16) catch return error.HttpBodyTooLarge;
        value = std.math.add(usize, value, digit) catch return error.HttpBodyTooLarge;
    }
    if (!validHeaderValue(line[end..])) return error.HttpBadRequest;
    return value;
}

fn addOverhead(current: usize, amount: usize, max: usize) !usize {
    const next = std.math.add(usize, current, amount) catch return error.HttpBodyTooLarge;
    if (next > max) return error.HttpBodyTooLarge;
    return next;
}

fn decodeChunked(storage: []u8, start: usize) !usize {
    var source = start;
    var destination = start;
    while (true) {
        const line = (try readCrlfLine(storage, source, storage.len - source + 1)) orelse return error.HttpBadRequest;
        const size = try parseChunkSize(line.bytes);
        if (size == 0) return destination - start;
        std.mem.copyForwards(u8, storage[destination..][0..size], storage[line.next..][0..size]);
        destination += size;
        source = line.next + size + 2;
    }
}

fn validToken(value: []const u8) bool {
    if (value.len == 0) return false;
    for (value) |byte| switch (byte) {
        'a'...'z', 'A'...'Z', '0'...'9', '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~' => {},
        else => return false,
    };
    return true;
}

fn validHeaderValue(value: []const u8) bool {
    for (value) |byte| if (byte == '\t' or byte == ' ' or (byte >= 0x21 and byte != 0x7f)) {} else return false;
    return true;
}

fn validTarget(target: []const u8) bool {
    if (target.len == 0) return false;
    if (!std.mem.startsWith(u8, target, "/") and !std.mem.eql(u8, target, "*")) return false;
    for (target) |byte| if (byte < 0x21 or byte > 0x7e) return false;
    return true;
}

fn eqlIgnoreCase(left: []const u8, right: []const u8) bool {
    return std.ascii.eqlIgnoreCase(left, right);
}

fn reasonPhrase(status: u16) []const u8 {
    return switch (status) {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        505 => "HTTP Version Not Supported",
        else => "Status",
    };
}

test "generated malformed request boundaries stay bounded and panic free" {
    var prng = std.Random.DefaultPrng.init(0x485454502d534146);
    const random = prng.random();
    const prefixes = [_][]const u8{
        "GET / HTTP/1.1\r\nHost: fixture\r\n",
        "POST / HTTP/1.1\r\nHost: fixture\r\nContent-Length: 4\r\n\r\n",
        "POST / HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\n\r\n",
    };
    var bytes: [256]u8 = undefined;
    for (0..2_000) |iteration| {
        const prefix = prefixes[iteration % prefixes.len];
        @memcpy(bytes[0..prefix.len], prefix);
        const length = prefix.len + random.intRangeAtMost(usize, 0, bytes.len - prefix.len);
        random.bytes(bytes[prefix.len..length]);
        const input = bytes[0..length];
        const maybe_head = findHead(input, 128) catch continue;
        const head_end = maybe_head orelse continue;
        const info = analyzeHead(input[0..head_end], 8) catch continue;
        const result = parseBody(input, info, 64, 64) catch continue;
        if (result == .complete) try std.testing.expect(result.complete <= input.len);
    }
}

test "aggregate reservation is atomic and strictly bounded" {
    var budget: Budget = .{ .limit = 64 };
    try budget.reserve(64);
    try std.testing.expectError(error.HttpAggregateLimit, budget.reserve(1));
    budget.release(64);
    try std.testing.expectEqual(@as(usize, 0), budget.used.load(.acquire));
}
