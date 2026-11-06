//! Owner-thread asynchronous HTTP over vetted libcurl multi. No request worker
//! threads. Call poll frequently (or from one dedicated I/O owner) to advance all
//! native sockets. URL/body/headers are copied; completions own response buffers.
//! Trusted and public-only requests use separate native connection caches.
const std = @import("std");
const curl = @import("curl.zig");
const A = std.mem.Allocator;
const Native = anyopaque;
// curl/multi.h CURLMsg: enum, easy pointer, result/pointer union. This ABI prefix
// is stable since libcurl multi's introduction; option13 is MAX_TOTAL_CONNECTIONS.
const Message = extern struct { kind: c_int, easy: *curl.Handle, data: extern union { pointer: ?*anyopaque, result: c_int } };
const Api = struct {
    multi_init: *const fn () callconv(.c) ?*Native,
    multi_cleanup: *const fn (*Native) callconv(.c) c_int,
    multi_add_handle: *const fn (*Native, *curl.Handle) callconv(.c) c_int,
    multi_remove_handle: *const fn (*Native, *curl.Handle) callconv(.c) c_int,
    multi_perform: *const fn (*Native, *c_int) callconv(.c) c_int,
    multi_info_read: *const fn (*Native, *c_int) callconv(.c) ?*Message,
    multi_setopt: *const fn (*Native, c_int, ...) callconv(.c) c_int,
    fn load(library: *std.DynLib) !Api {
        var api: Api = undefined;
        inline for (std.meta.fields(Api)) |field| @field(api, field.name) = library.lookup(field.type, "curl_" ++ field.name) orelse return error.MissingLibcurlMultiSymbol;
        return api;
    }
};
pub const Config = struct {
    library_path: []const u8,
    max_concurrent: u16 = 256,
    max_pending: u16 = 512,
    max_response_bytes: usize = 1024 * 1024,
    max_request_bytes: usize = 1024 * 1024,
    max_reserved_bytes: usize = 64 * 1024 * 1024,
    /// Worst-case reservation for one request under these per-request limits.
    pub fn maxReservationPerRequest(self: Config) !usize {
        return reservation(self.max_request_bytes, self.max_response_bytes);
    }
    pub fn validate(self: Config) !void {
        if (self.library_path.len == 0 or self.max_concurrent == 0 or self.max_concurrent > self.max_pending or self.max_pending > 4096 or self.max_response_bytes == 0 or self.max_request_bytes == 0 or self.max_reserved_bytes == 0) return error.InvalidCurlMultiConfig;
    }
};
pub const Id = struct { slot: u16, sequence: u64 };
pub const Result = union(enum) { response: curl.Response, failure: anyerror };
pub const Completion = struct {
    id: Id,
    result: Result,
    pub fn deinit(self: *Completion) void {
        if (self.result == .response) self.result.response.deinit();
        self.* = undefined;
    }
};
const State = enum { free, queued, active, done };
const Slot = struct {
    state: State = .free,
    sequence: u64 = 0,
    deadline_ms: u64 = 0,
    transfer: ?*curl.Transfer = null,
    result: Result = undefined,
    reserved_bytes: usize = 0,
    completion_sequence: u64 = 0,
    trust: usize = 0,
};
pub const Multi = struct {
    allocator: A,
    config: Config,
    client: curl.Client,
    api: Api,
    handles: [2]*Native,
    slots: []Slot,
    sequence: u64 = 0,
    completions: u64 = 0,
    active: usize = 0,
    reserved_bytes: usize = 0,
    last_ms: u64 = 0,
    first_trust: usize = 0,
    /// The returned object and its callback contexts are heap-stable. All API
    /// methods run on one owner thread; only borrowed atomic cancel flags may be
    /// modified from other threads. No global libcurl cleanup is performed.
    pub fn init(allocator: A, config: Config) !*Multi {
        try config.validate();
        const self = try allocator.create(Multi);
        errdefer allocator.destroy(self);
        var client = try curl.Client.init(allocator, config.library_path);
        errdefer client.deinit();
        const api = try Api.load(&client.library);
        var handles: [2]*Native = undefined;
        var initialized: usize = 0;
        errdefer for (handles[0..initialized]) |handle| {
            _ = api.multi_cleanup(handle);
        };
        for (&handles) |*handle| {
            handle.* = api.multi_init() orelse return error.CurlMultiInitializationFailed;
            initialized += 1;
            if (api.multi_setopt(handle.*, 13, @as(c_long, config.max_concurrent)) != 0) return error.CurlMultiOptionFailed;
            // libcurl owns keepalive pooling; bound idle connection cache too.
            if (api.multi_setopt(handle.*, 6, @as(c_long, config.max_concurrent)) != 0) return error.CurlMultiOptionFailed;
        }
        const slots = try allocator.alloc(Slot, config.max_pending);
        @memset(slots, .{});
        self.* = .{ .allocator = allocator, .config = config, .client = client, .api = api, .handles = handles, .slots = slots };
        return self;
    }
    pub fn deinit(self: *Multi) void {
        for (self.slots) |*slot| {
            if (slot.state == .active) _ = self.api.multi_remove_handle(self.handles[slot.trust], slot.transfer.?.handle);
            if (slot.transfer) |transfer| transfer.deinit();
            if (slot.state == .done and slot.result == .response) slot.result.response.deinit();
        }
        for (self.handles) |handle| {
            _ = self.api.multi_cleanup(handle);
        }
        self.client.deinit();
        self.allocator.free(self.slots);
        const allocator = self.allocator;
        allocator.destroy(self);
    }
    fn clock(self: *Multi, now_ms: u64) !void {
        if (now_ms < self.last_ms) return error.CurlMultiClockWentBackwards;
        self.last_ms = now_ms;
    }
    /// Includes completed-but-unconsumed requests. A full/budget-exhausted queue
    /// rejects explicitly and transfers no input ownership. A queued request's
    /// deadline starts now, rather than when a connection slot becomes available.
    pub fn submit(self: *Multi, request: curl.Request, now_ms: u64) !Id {
        try self.clock(now_ms);
        try curl.validateRequest(request);
        if (request.max_response_bytes > self.config.max_response_bytes) return error.ResponseTooLarge;
        const request_bytes = try requestSize(request);
        if (request_bytes > self.config.max_request_bytes) return error.RequestTooLarge;
        // Charge both the receive and owned-result body plus fixed header sink,
        // copied header bytes and bounded parsed-header descriptors. Completion
        // allocation cannot transiently exceed the application payload budget.
        const reserved = try reservation(request_bytes, request.max_response_bytes);
        if (reserved > self.config.max_reserved_bytes -| self.reserved_bytes) return error.CurlMultiByteBudgetExceeded;
        if (self.sequence == std.math.maxInt(u64)) return error.CurlMultiSequenceExhausted;
        const index = for (self.slots, 0..) |slot, index| {
            if (slot.state == .free) break index;
        } else return error.CurlMultiQueueFull;
        const transfer = try curl.Transfer.init(&self.client, self.allocator, request);
        self.sequence += 1;
        self.slots[index] = .{ .state = .queued, .sequence = self.sequence, .deadline_ms = now_ms +| request.timeout_ms, .transfer = transfer, .reserved_bytes = reserved, .trust = @intFromBool(request.public_only) };
        self.reserved_bytes += reserved;
        return .{ .slot = @intCast(index), .sequence = self.sequence };
    }
    fn selected(self: *Multi, id: Id) !*Slot {
        if (id.slot >= self.slots.len) return error.InvalidCurlMultiId;
        const slot = &self.slots[id.slot];
        if (slot.state == .free or slot.sequence != id.sequence) return error.StaleCurlMultiId;
        return slot;
    }
    /// Cancellation completion is emitted exactly once by poll. Removing a
    /// native handle ends callbacks immediately; no late response can escape.
    pub fn cancel(self: *Multi, id: Id) !void {
        const slot = try self.selected(id);
        if (slot.state == .done) {
            if (slot.result == .response) slot.result.response.deinit();
            slot.result = .{ .failure = error.RequestCancelled };
            return;
        }
        try self.complete(slot, .{ .failure = error.RequestCancelled });
    }
    fn complete(self: *Multi, slot: *Slot, result: Result) !void {
        if (slot.state == .active) {
            if (self.api.multi_remove_handle(self.handles[slot.trust], slot.transfer.?.handle) != 0) return error.CurlMultiRemoveFailed;
            self.active -= 1;
        }
        slot.transfer.?.deinit();
        slot.transfer = null;
        self.completions += 1;
        slot.completion_sequence = self.completions;
        slot.result = result;
        slot.state = .done;
    }
    fn pending(self: *Multi, now_ms: u64) !void {
        for (self.slots) |*slot| {
            if (slot.state != .queued and slot.state != .active) continue;
            const request = slot.transfer.?.request;
            if (request.cancel) |cancel_| if (cancel_.load(.acquire)) {
                try self.complete(slot, .{ .failure = error.RequestCancelled });
                continue;
            };
            if (now_ms >= slot.deadline_ms) try self.complete(slot, .{ .failure = error.RequestDeadlineExceeded });
        }
        while (self.active < self.config.max_concurrent) {
            var selected_slot: ?*Slot = null;
            for (self.slots) |*slot| if (slot.state == .queued and (selected_slot == null or slot.sequence < selected_slot.?.sequence)) {
                selected_slot = slot;
            };
            const slot = selected_slot orelse break;
            const transfer = slot.transfer.?;
            const remaining: c_long = @intCast(slot.deadline_ms - now_ms);
            if (self.client.api.easy_setopt(transfer.handle, 155, remaining) != 0 or self.client.api.easy_setopt(transfer.handle, 156, @as(c_long, @intCast(@min(slot.deadline_ms - now_ms, transfer.request.connect_timeout_ms)))) != 0) {
                try self.complete(slot, .{ .failure = error.LibcurlOptionFailed });
                continue;
            }
            if (self.api.multi_add_handle(self.handles[slot.trust], transfer.handle) != 0) {
                try self.complete(slot, .{ .failure = error.CurlMultiAddFailed });
                continue;
            }
            slot.state = .active;
            self.active += 1;
        }
    }
    /// Nonblocking. Completion order follows libcurl's DONE queue within each
    /// isolated trust cache; the two caches are pumped with alternating priority.
    /// Returned response ownership transfers to the caller, which calls deinit.
    pub fn poll(self: *Multi, now_ms: u64) !?Completion {
        try self.clock(now_ms);
        try self.pending(now_ms);
        for (0..2) |offset| {
            const trust = (self.first_trust + offset) % 2;
            var running: c_int = 0;
            var code = self.api.multi_perform(self.handles[trust], &running);
            while (code == -1) code = self.api.multi_perform(self.handles[trust], &running);
            if (code != 0) return error.CurlMultiPerformFailed;
            var remaining: c_int = 0;
            while (self.api.multi_info_read(self.handles[trust], &remaining)) |message| {
                if (message.kind != 1) return error.InvalidCurlMultiMessage;
                const slot = for (self.slots) |*slot| {
                    if (slot.state == .active and slot.transfer.?.handle == message.easy) break slot;
                } else return error.UnknownCurlMultiHandle;
                const result: Result = if (slot.transfer.?.finish(message.data.result)) |response| .{ .response = response } else |err| .{ .failure = err };
                self.complete(slot, result) catch |err| {
                    var cleanup = result;
                    if (cleanup == .response) cleanup.response.deinit();
                    return err;
                };
            }
        }
        self.first_trust = (self.first_trust + 1) % 2;
        var ready: ?*Slot = null;
        for (self.slots) |*slot| if (slot.state == .done and (ready == null or slot.completion_sequence < ready.?.completion_sequence)) {
            ready = slot;
        };
        const slot = ready orelse return null;
        const index = (@intFromPtr(slot) - @intFromPtr(self.slots.ptr)) / @sizeOf(Slot);
        const completion: Completion = .{ .id = .{ .slot = @intCast(index), .sequence = slot.sequence }, .result = slot.result };
        self.reserved_bytes -= slot.reserved_bytes;
        slot.* = .{};
        return completion;
    }
};
test "curl multi rejects invalid capacities without loading a native library" {
    try std.testing.expectError(error.InvalidCurlMultiConfig, Multi.init(std.testing.allocator, .{ .library_path = "/never/load", .max_concurrent = 0 }));
    try std.testing.expectError(error.InvalidCurlMultiConfig, Multi.init(std.testing.allocator, .{ .library_path = "/never/load", .max_concurrent = 10, .max_pending = 9 }));
}

const FanoutFixture = struct {
    server: std.net.Server,
    stop: std.atomic.Value(bool) = .init(false),
    accepted: std.atomic.Value(usize) = .init(0),
    failure: ?anyerror = null,
    fn serve(self: *FanoutFixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *FanoutFixture) !void {
        var retained: [8]std.net.Stream = undefined;
        var count: usize = 0;
        defer for (retained[0..count]) |stream| stream.close();
        var timer = try std.time.Timer.start();
        while (self.accepted.load(.acquire) < 16) {
            if (timer.read() > 5 * std.time.ns_per_s or self.stop.load(.acquire)) return error.FixtureAcceptTimeout;
            var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fd, 20) == 0) continue;
            const connection = try self.server.accept();
            errdefer connection.stream.close();
            var input: [4096]u8 = undefined;
            var used: usize = 0;
            while (std.mem.indexOf(u8, input[0..used], "\r\n\r\n") == null) {
                if (timer.read() > 5 * std.time.ns_per_s or self.stop.load(.acquire)) return error.FixtureReadTimeout;
                var read_fd = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&read_fd, 20) == 0) continue;
                if (used == input.len) return error.FixtureRequestTooLarge;
                const got = try connection.stream.read(input[used..]);
                if (got == 0) return error.FixtureUnexpectedEof;
                used += got;
            }
            _ = self.accepted.fetchAdd(1, .release);
            if (std.mem.startsWith(u8, input[0..used], "GET /slow ")) {
                if (count == retained.len) return error.FixtureTooManySlowRequests;
                retained[count] = connection.stream;
                count += 1;
            } else {
                try std.testing.expect(std.mem.startsWith(u8, input[0..used], "GET /fast "));
                try connection.stream.writeAll("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                connection.stream.close();
            }
        }
        while (!self.stop.load(.acquire) and timer.read() < 5 * std.time.ns_per_s) std.Thread.sleep(std.time.ns_per_ms);
    }
};
fn nativeLibrary(allocator: A) ![]u8 {
    return std.process.getEnvVarOwned(allocator, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}
test "curl multi starts healthy validators beyond eight stalled requests and cancels every loser" {
    const allocator = std.testing.allocator;
    const library = try nativeLibrary(allocator);
    defer allocator.free(library);
    const multi = try Multi.init(allocator, .{ .library_path = library, .max_concurrent = 16, .max_pending = 16 });
    defer multi.deinit();
    var fixture: FanoutFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, FanoutFixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    var ids: [16]Id = undefined;
    for (&ids, 0..) |*id, index| {
        const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/{s}", .{ fixture.server.listen_address.getPort(), if (index < 8) "slow" else "fast" });
        defer allocator.free(url);
        id.* = try multi.submit(.{ .url = url, .method = .get, .timeout_ms = 3000, .max_response_bytes = 32 }, 0);
    }
    var timer = try std.time.Timer.start();
    var received: usize = 0;
    while (received < 8) {
        if (try multi.poll(timer.read() / std.time.ns_per_ms)) |value| {
            var completion = value;
            defer completion.deinit();
            try std.testing.expect(completion.id.slot >= 8);
            try std.testing.expect(completion.result == .response);
            try std.testing.expectEqualStrings("ok", completion.result.response.body);
            received += 1;
        } else std.Thread.sleep(std.time.ns_per_ms);
        if (timer.read() > 2 * std.time.ns_per_s) return error.HealthyFanoutStalled;
    }
    try std.testing.expectEqual(@as(usize, 16), fixture.accepted.load(.acquire));
    for (ids[0..8]) |id| try multi.cancel(id);
    received = 0;
    while (received < 8) {
        var completion = (try multi.poll(timer.read() / std.time.ns_per_ms)) orelse return error.MissingCancellationCompletion;
        defer completion.deinit();
        try std.testing.expect(completion.id.slot < 8);
        try std.testing.expectEqual(error.RequestCancelled, completion.result.failure);
        received += 1;
    }
    try std.testing.expectEqual(@as(usize, 0), multi.reserved_bytes);
    try std.testing.expectEqual(@as(usize, 0), multi.active);
    try std.testing.expectEqual(@as(?Completion, null), try multi.poll(timer.read() / std.time.ns_per_ms));
    try std.testing.expectError(error.StaleCurlMultiId, multi.cancel(ids[0]));
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}
test "curl multi bounds queued memory capacity deadlines and stale identities without network" {
    const allocator = std.testing.allocator;
    const library = try nativeLibrary(allocator);
    defer allocator.free(library);
    const multi = try Multi.init(allocator, .{ .library_path = library, .max_concurrent = 1, .max_pending = 2, .max_response_bytes = 32, .max_request_bytes = 128, .max_reserved_bytes = 200000 });
    defer multi.deinit();
    const request: curl.Request = .{ .url = "http://127.0.0.1:1/never-connect", .method = .get, .timeout_ms = 10, .max_response_bytes = 32 };
    const first = try multi.submit(request, 0);
    const second = try multi.submit(request, 0);
    try std.testing.expectError(error.CurlMultiByteBudgetExceeded, multi.submit(.{ .url = request.url, .method = .get, .max_response_bytes = 32 }, 0));
    try std.testing.expectError(error.ResponseTooLarge, multi.submit(.{ .url = request.url, .method = .get, .max_response_bytes = 33 }, 0));
    try multi.cancel(first);
    var cancelled = (try multi.poll(10)).?;
    defer cancelled.deinit();
    try std.testing.expectEqual(first, cancelled.id);
    try std.testing.expectEqual(error.RequestCancelled, cancelled.result.failure);
    var expired = (try multi.poll(10)).?;
    defer expired.deinit();
    try std.testing.expectEqual(second, expired.id);
    try std.testing.expectEqual(error.RequestDeadlineExceeded, expired.result.failure);
    const reused = try multi.submit(request, 10);
    try std.testing.expectEqual(first.slot, reused.slot);
    try std.testing.expect(first.sequence != reused.sequence);
    try std.testing.expectError(error.StaleCurlMultiId, multi.cancel(first));
    try multi.cancel(reused);
    var final = (try multi.poll(10)).?;
    defer final.deinit();
    try std.testing.expectError(error.CurlMultiClockWentBackwards, multi.poll(9));
    try std.testing.expectEqual(@as(usize, 0), multi.reserved_bytes);
}

fn allocationExercise(allocator: A, library: []const u8) !void {
    const multi = try Multi.init(allocator, .{ .library_path = library, .max_concurrent = 1, .max_pending = 1 });
    defer multi.deinit();
    const id = try multi.submit(.{ .url = "https://fixture.invalid/no-network", .method = .post, .headers = &.{.{ .name = "x-fixture", .value = "owned" }}, .body = "payload", .max_response_bytes = 32 }, 0);
    try multi.cancel(id);
    var completion = (try multi.poll(0)).?;
    defer completion.deinit();
}
test "curl multi releases partial allocation failures and never retains borrowed request buffers" {
    const library = try nativeLibrary(std.testing.allocator);
    defer std.testing.allocator.free(library);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationExercise, .{library});
}
const ReplyFixture = struct {
    server: std.net.Server,
    responses: []const []const u8,
    failure: ?anyerror = null,
    fn serve(self: *ReplyFixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *ReplyFixture) !void {
        for (self.responses) |response| {
            var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fd, 3000) == 0) return error.FixtureAcceptTimeout;
            const connection = try self.server.accept();
            defer connection.stream.close();
            var timer = try std.time.Timer.start();
            var input: [4096]u8 = undefined;
            var used: usize = 0;
            while (std.mem.indexOf(u8, input[0..used], "\r\n\r\n") == null) {
                if (timer.read() > 3 * std.time.ns_per_s or used == input.len) return error.FixtureReadTimeout;
                var read_fd = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&read_fd, 20) == 0) continue;
                const got = try connection.stream.read(input[used..]);
                if (got == 0) return error.FixtureUnexpectedEof;
                used += got;
            }
            connection.stream.writeAll(response) catch |err| switch (err) {
                error.BrokenPipe, error.ConnectionResetByPeer => {},
                else => return err,
            };
        }
    }
};
fn waitOne(multi: *Multi, timer: *std.time.Timer) !Completion {
    while (timer.read() < 3 * std.time.ns_per_s) {
        if (try multi.poll(timer.read() / std.time.ns_per_ms)) |completion| return completion;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.FixtureCompletionTimeout;
}
test "curl multi enforces body and header caps no redirects and private socket policy" {
    const allocator = std.testing.allocator;
    const library = try nativeLibrary(allocator);
    defer allocator.free(library);
    const multi = try Multi.init(allocator, .{ .library_path = library, .max_concurrent = 2, .max_pending = 4 });
    defer multi.deinit();
    const oversized_header = try std.fmt.allocPrint(allocator, "HTTP/1.1 200 OK\r\nX-Large: {s}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", .{&([_]u8{'a'} ** 33000)});
    defer allocator.free(oversized_header);
    const responses = [_][]const u8{
        "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nwide",
        oversized_header,
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/never-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    };
    var fixture: ReplyFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .responses = &responses };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, ReplyFixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) thread.join();
    const url = try std.fmt.allocPrint(allocator, "http://localhost:{d}/exact/a/../b//c", .{fixture.server.listen_address.getPort()});
    defer allocator.free(url);
    var timer = try std.time.Timer.start();
    for (0..3) |index| {
        _ = try multi.submit(.{ .url = url, .method = .get, .max_response_bytes = if (index == 0) 3 else 64, .timeout_ms = 1500 }, timer.read() / std.time.ns_per_ms);
        var completion = try waitOne(multi, &timer);
        defer completion.deinit();
        if (index == 0) try std.testing.expectEqual(error.ResponseTooLarge, completion.result.failure) else if (index == 1) try std.testing.expectEqual(error.ResponseHeadersTooLarge, completion.result.failure) else try std.testing.expectEqual(@as(u16, 302), completion.result.response.status);
    }
    // A trusted request to this exact hostname has already succeeded. A public
    // request cannot reuse its native multi connection/DNS cache to bypass checks.
    _ = try multi.submit(.{ .url = url, .method = .get, .max_response_bytes = 16, .timeout_ms = 500, .public_only = true }, timer.read() / std.time.ns_per_ms);
    var blocked = try waitOne(multi, &timer);
    defer blocked.deinit();
    try std.testing.expectEqual(error.NonPublicDestination, blocked.result.failure);
    try std.testing.expectEqual(@as(usize, 0), multi.reserved_bytes);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}

fn requestSize(request: curl.Request) !usize {
    var size = try std.math.add(usize, request.url.len +| 1, if (request.body) |body| body.len else 0);
    for (request.headers) |header| size = try std.math.add(usize, size, try std.math.add(usize, header.name.len +| 4, header.value.len));
    return size;
}
fn reservation(request_bytes: usize, response_bytes: usize) !usize {
    return std.math.add(usize, try std.math.add(usize, request_bytes, try std.math.mul(usize, response_bytes, 2)), 3 * 32768);
}
/// Actual application payload reservation charged by submit, without native IO.
pub fn reservationBound(request: curl.Request) !usize {
    return reservation(try requestSize(request), request.max_response_bytes);
}
