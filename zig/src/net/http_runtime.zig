//! One bounded native HTTP I/O owner shared by independent read-only chain lanes.
//! Requests and cancellation are owned through real completion drain. Callers
//! submit/poll/cancel without occupying a blocking network worker.
const std = @import("std");
const curl = @import("curl.zig");
const multi = @import("curl_multi.zig");
const A = std.mem.Allocator;
pub const Handle = struct { id: u64 };
pub const Observer = struct {
    context: *anyopaque,
    complete_fn: *const fn (*anyopaque, *const multi.Result, u64) void,
    retain_fn: ?*const fn (*anyopaque) void = null,
    release_fn: ?*const fn (*anyopaque) void = null,
    pub fn retain(self: Observer) void {
        if (self.retain_fn) |f| f(self.context);
    }
    pub fn release(self: Observer) void {
        if (self.release_fn) |f| f(self.context);
    }
};
pub const Config = struct { multi: multi.Config, max_sessions: u16 = 256 };
const Session = struct {
    arena: std.heap.ArenaAllocator,
    id: u64,
    request: curl.Request,
    observer: ?Observer,
    started: std.time.Instant,
    deadline_ms: u64,
    native_id: ?multi.Id = null,
    result: ?multi.Result = null,
    closed: std.atomic.Value(bool) = .init(false),
    consumed: bool = false,
    reserved: usize,
    reported: bool = false,
    fn deinit(self: *Session, a: A) void {
        if (self.result) |*result| if (result.* == .response) result.response.deinit();
        if (self.observer) |observer| observer.release();
        self.arena.deinit();
        a.destroy(self);
    }
};
pub const Runtime = struct {
    allocator: A,
    config: Config,
    native: *multi.Multi,
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    sessions: []?*Session,
    /// Owner-thread copy of `sessions`, allocated once (no per-pass 32 KiB fill).
    snapshot: []?*Session,
    /// Owner loop passes; evidence that the owner blocks on sockets/timers.
    owner_iterations: std.atomic.Value(u64) = .init(0),
    next_id: u64 = 1,
    reserved: usize = 0,
    stopping: bool = false,
    native_failed: bool = false,
    wait_failure: ?anyerror = null,
    thread: std.Thread = undefined,
    started: std.time.Instant,
    /// Thread-safe allocator required. All native Multi operations stay on one
    /// dedicated owner; independent logical lanes only use synchronized handles.
    pub fn start(a: A, config: Config) !*Runtime {
        if (config.max_sessions == 0 or config.max_sessions > 4096 or config.max_sessions > config.multi.max_pending) return error.InvalidHttpRuntimeLimit;
        const self = try a.create(Runtime);
        errdefer a.destroy(self);
        const native = try multi.Multi.init(a, config.multi);
        errdefer native.deinit();
        const sessions = try a.alloc(?*Session, config.max_sessions);
        errdefer a.free(sessions);
        @memset(sessions, null);
        const snapshot = try a.alloc(?*Session, config.max_sessions);
        errdefer a.free(snapshot);
        self.* = .{ .allocator = a, .config = config, .native = native, .sessions = sessions, .snapshot = snapshot, .started = try std.time.Instant.now() };
        self.thread = try std.Thread.spawn(.{}, run, .{self});
        return self;
    }
    /// Join all handle callers before teardown. Cancels and drains every native
    /// transfer, including requests whose callers have already been cancelled.
    pub fn deinit(self: *Runtime) void {
        self.mutex.lock();
        self.stopping = true;
        for (self.sessions) |entry| if (entry) |session| {
            session.closed.store(true, .release);
            session.consumed = true;
        };
        self.wake.broadcast();
        if (!self.native_failed) self.native.wakeup();
        self.mutex.unlock();
        self.thread.join();
        std.debug.assert(self.reserved == 0);
        if (!self.native_failed) self.native.deinit();
        self.allocator.free(self.sessions);
        self.allocator.free(self.snapshot);
        const a = self.allocator;
        a.destroy(self);
    }
    fn now(self: *Runtime) u64 {
        return (std.time.Instant.now() catch self.started).since(self.started) / std.time.ns_per_ms;
    }
    pub fn submit(self: *Runtime, original: curl.Request, observer: ?Observer) !Handle {
        try curl.validateRequest(original);
        if (original.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (observer) |o| if ((o.retain_fn == null) != (o.release_fn == null)) return error.InvalidHttpObserver;
        if (original.max_response_bytes > self.config.multi.max_response_bytes) return error.ResponseTooLarge;
        var request_bytes = try std.math.add(usize, original.url.len, (original.body orelse "").len);
        request_bytes = try std.math.add(usize, request_bytes, try std.math.mul(usize, original.headers.len, @sizeOf(curl.Header)));
        for (original.headers) |header| request_bytes = try std.math.add(usize, request_bytes, try std.math.add(usize, header.name.len, header.value.len));
        if (request_bytes > self.config.multi.max_request_bytes) return error.RequestTooLarge;
        const reserved = try std.math.add(usize, try multi.reservationBound(original), request_bytes);
        const started = try std.time.Instant.now();
        const deadline_ms = self.now() +| original.timeout_ms;
        // Admission precedes copying. This short bounded-memory critical section
        // prevents concurrent rejected producers allocating outside the quota.
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopping) return error.HttpRuntimeStopped;
        if (self.native_failed) return error.HttpRuntimeFailed;
        if (reserved > self.config.multi.max_reserved_bytes -| self.reserved) return error.HttpRuntimeByteBudgetExceeded;
        const slot = for (self.sessions, 0..) |entry, i| {
            if (entry == null) break i;
        } else return error.HttpRuntimeSessionsFull;
        if (self.next_id == std.math.maxInt(u64)) return error.HttpRuntimeIdExhausted;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var request = original;
        request.url = try a.dupe(u8, original.url);
        request.body = if (original.body) |body| try a.dupe(u8, body) else null;
        const headers = try a.alloc(curl.Header, original.headers.len);
        for (headers, original.headers) |*to, from| to.* = .{ .name = try a.dupe(u8, from.name), .value = try a.dupe(u8, from.value) };
        request.headers = headers;
        const session = try self.allocator.create(Session);
        errdefer self.allocator.destroy(session);
        session.* = .{ .arena = arena, .id = self.next_id, .request = request, .observer = observer, .started = started, .deadline_ms = deadline_ms, .reserved = reserved };
        // No borrowed caller flag survives submit: native callbacks use this
        // heap-stable owner token even after the caller returns PendingReadIo.
        session.request.cancel = &session.closed;
        if (observer) |o| o.retain();
        self.next_id += 1;
        self.reserved += reserved;
        self.sessions[slot] = session;
        self.wakeOwner();
        return .{ .id = session.id };
    }
    /// Terminal poll consumes the handle. Response transfers owned runtime-
    /// allocator buffers; adapters must clone to their requested allocator.
    pub fn poll(self: *Runtime, handle: Handle) !?curl.Response {
        self.mutex.lock();
        defer self.mutex.unlock();
        const session = self.find(handle) orelse return error.InvalidHttpHandle;
        const result = session.result orelse return null;
        session.result = null;
        session.consumed = true;
        self.wakeOwner();
        return switch (result) {
            .failure => |err| err,
            .response => |response| response,
        };
    }
    pub fn cancel(self: *Runtime, handle: Handle) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const session = self.find(handle) orelse return;
        session.closed.store(true, .release);
        session.consumed = true;
        self.wakeOwner();
    }
    /// Caller holds the mutex, so a poisoned native owner is never touched
    /// after the owner thread destroys it (it flips native_failed first).
    fn wakeOwner(self: *Runtime) void {
        self.wake.signal();
        if (!self.native_failed) self.native.wakeup();
    }
    fn find(self: *Runtime, handle: Handle) ?*Session {
        for (self.sessions) |entry| if (entry) |session| if (session.id == handle.id and !session.consumed) return session;
        return null;
    }
    fn finish(self: *Runtime, session: *Session, result: multi.Result) void {
        if (session.observer) |observer| if (!session.reported) {
            observer.complete_fn(observer.context, &result, (std.time.Instant.now() catch session.started).since(session.started));
        };
        session.reported = true;
        self.mutex.lock();
        session.result = result;
        self.mutex.unlock();
    }
    fn pollNative(self: *Runtime, now_ms: u64) !?multi.Completion {
        if (self.wait_failure) |err| return err;
        return self.native.poll(now_ms);
    }
    fn run(self: *Runtime) void {
        while (true) {
            const snapshot = self.snapshot;
            self.mutex.lock();
            @memcpy(snapshot, self.sessions);
            self.mutex.unlock();
            const now_ms = self.now();
            for (snapshot) |entry| if (entry) |session| {
                if (self.native_failed) {
                    session.native_id = null;
                    if (!session.reported) self.finish(session, .{ .failure = error.HttpRuntimeFailed });
                    continue;
                }
                if (session.closed.load(.acquire)) {
                    if (session.native_id) |id| self.native.cancel(id) catch {} else if (!session.reported) self.finish(session, .{ .failure = error.RequestCancelled });
                } else if (!session.reported and session.native_id == null) {
                    if (now_ms >= session.deadline_ms) {
                        self.finish(session, .{ .failure = error.RequestDeadlineExceeded });
                        continue;
                    }
                    var request = session.request;
                    request.timeout_ms = @intCast(@min(session.deadline_ms - now_ms, std.math.maxInt(u32)));
                    request.connect_timeout_ms = @min(request.connect_timeout_ms, request.timeout_ms);
                    session.native_id = self.native.submit(request, now_ms) catch |err| switch (err) {
                        error.CurlMultiQueueFull, error.CurlMultiByteBudgetExceeded => continue,
                        else => {
                            self.finish(session, .{ .failure = err });
                            continue;
                        },
                    };
                }
            };
            var completed = false;
            while (if (self.native_failed) @as(?multi.Completion, null) else self.pollNative(now_ms) catch |err| blk: {
                // A native multi API failure poisons this owner. Destroy native
                // callbacks while every session token/context is still alive,
                // then deliver the original error and reject future admission.
                self.mutex.lock();
                self.native_failed = true;
                self.mutex.unlock();
                self.native.deinit();
                for (snapshot) |entry| if (entry) |session| {
                    session.native_id = null;
                    if (!session.reported) self.finish(session, .{ .failure = err });
                };
                break :blk null;
            }) |value| {
                completed = true;
                var completion = value;
                defer completion.deinit();
                for (snapshot) |entry| if (entry) |session| {
                    if (session.native_id) |id| if (std.meta.eql(id, completion.id)) {
                        session.native_id = null;
                        self.finish(session, completion.result);
                        completion.result = .{ .failure = error.HttpRuntimeResponseMoved };
                        break;
                    };
                };
            }
            self.mutex.lock();
            for (self.sessions) |*entry| if (entry.*) |session| {
                if (session.consumed and session.native_id == null and session.reported) {
                    entry.* = null;
                    self.reserved -= session.reserved;
                    session.deinit(self.allocator);
                }
            };
            const empty = for (self.sessions) |entry| {
                if (entry != null) break false;
            } else true;
            const stopped = self.stopping;
            _ = self.owner_iterations.fetchAdd(1, .monotonic);
            if (empty and !stopped) {
                self.wake.wait(&self.mutex);
            } else if (!empty and self.native_failed) {
                // Every session is already finished; wait for consumers.
                self.wake.wait(&self.mutex);
            } else if (!empty and !completed) {
                // Completions are delivered above; loop once more before
                // blocking so freed capacity admits queued sessions. Otherwise
                // block on sockets, the earliest unsubmitted session deadline,
                // or wakeOwner (level-triggered curl_multi_wakeup).
                // Live table under the mutex: the snapshot may name retired sessions.
                var next: u64 = std.math.maxInt(u32);
                for (self.sessions) |entry| if (entry) |session| {
                    if (!session.reported and session.native_id == null) next = @min(next, @max(session.deadline_ms -| now_ms, 1));
                };
                self.mutex.unlock();
                // A failed native wait poisons the owner on the next pass,
                // exactly like a failed native poll.
                self.native.wait(now_ms, @intCast(next)) catch |err| {
                    self.wait_failure = err;
                };
                self.mutex.lock();
            }
            self.mutex.unlock();
            if (empty and stopped) return;
        }
    }
};
