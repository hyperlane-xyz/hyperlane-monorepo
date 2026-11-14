//! Dedicated LISTEN connection (node-pg `Client` + `LISTEN` + 'notification'
//! / 'error' / 'end' events) on its own thread: `poll` on `PQsocket` and a stop
//! pipe, then `PQconsumeInput` + `PQnotifies`. Optional periodic `SELECT 1`
//! health check (diagnostics' LISTENER_HEALTH_MS).
const std = @import("std");
const core = @import("core");
const root = @import("root.zig");
const pq = @import("pq.zig");

pub const Handler = struct {
    ctx: *anyopaque,
    /// Called on the listener thread for each NOTIFY (payload "" when none).
    on_notification: *const fn (ctx: *anyopaque, channel: []const u8, payload: []const u8) void,
    /// Called once on the listener thread when the connection fails or ends
    /// (never after `stop`). `message` is the failure text, if any.
    on_disconnect: *const fn (ctx: *anyopaque, message: ?[]const u8) void,
};

pub const Options = struct {
    /// Run `SELECT 1` this often; failure disconnects (diagnostics only).
    health_check_ms: ?u64 = null,
    /// Test seam: statements run on the connection after the LISTENs,
    /// before the notification thread starts (e.g. a self-NOTIFY).
    after_listen_sql: []const []const u8 = &.{},
};

pub const Listener = struct {
    gpa: std.mem.Allocator,
    conn: pq.Conn,
    handler: Handler,
    options: Options,
    stop_pipe: [2]std.posix.fd_t,
    thread: ?std.Thread = null,
    thread_id: std.Thread.Id = 0,
    mutex: std.Thread.Mutex = .{},
    stopped: bool = false,
    /// Set when the loop has exited (the owner may still need to call stop).
    exited: bool = false,
    /// `stop` was called from the listener thread: the thread frees itself.
    detached: bool = false,
    message_buf: [256]u8 = undefined,
    /// The connection is closed as soon as the loop ends; the struct stays
    /// valid until `stop`.
    conn_closed: bool = false,
    /// Loop ended on a disconnect without stop(): thread detached, pipe
    /// closed; stop() only frees the struct.
    self_cleaned: bool = false,

    /// Connects, issues `LISTEN "<channel>"` for each channel (identifier
    /// quoted like `quoteIdentifier`) and starts the notification thread.
    pub fn start(
        gpa: std.mem.Allocator,
        conn_options: pq.ConnOptions,
        channels: []const []const u8,
        handler: Handler,
        options: Options,
        arena: std.mem.Allocator,
        failure: ?*root.Failure,
    ) root.Error!*Listener {
        var conn = try pq.Conn.connect(.{
            .conninfo = conn_options.conninfo,
            .connect_timeout_ms = conn_options.connect_timeout_ms,
            .statement_timeout_ms = conn_options.statement_timeout_ms,
            .options = conn_options.options,
            .query_timeout_ms = conn_options.query_timeout_ms,
        }, arena, failure);
        errdefer conn.deinit();
        // One simple-protocol round trip for all channels (node-pg queues the
        // TS Promise.all of LISTENs one after another on the same client;
        // any failure fails the listen either way).
        if (channels.len > 0) {
            var sql: std.ArrayList(u8) = .empty;
            for (channels) |channel| {
                try sql.appendSlice(arena, "LISTEN \"");
                for (channel) |c| {
                    if (c == '"') try sql.append(arena, '"');
                    try sql.append(arena, c);
                }
                try sql.appendSlice(arena, "\";");
            }
            _ = try conn.query(arena, sql.items, &.{}, failure);
        }
        for (options.after_listen_sql) |extra| _ = try conn.query(arena, extra, &.{}, failure);
        const self = try gpa.create(Listener);
        errdefer gpa.destroy(self);
        const pipe = std.posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true }) catch return error.ConnectionFailed;
        self.* = .{ .gpa = gpa, .conn = conn, .handler = handler, .options = options, .stop_pipe = pipe };
        // Hold the mutex across spawn: loop() takes it first, so `thread` is
        // set before the thread can detach itself.
        self.mutex.lock();
        defer self.mutex.unlock();
        self.thread = std.Thread.spawn(.{}, loop, .{self}) catch {
            std.posix.close(pipe[0]);
            std.posix.close(pipe[1]);
            return error.ConnectionFailed;
        };
        return self;
    }

    /// `unlisten`: closes the connection and frees the listener. Call exactly
    /// once per listener, also after `on_disconnect` fired (the connection is
    /// already closed then; this only frees). Safe to call from inside
    /// `on_disconnect`/`on_notification` (the thread frees itself after the
    /// callback returns).
    pub fn stop(self: *Listener) void {
        self.mutex.lock();
        if (self.stopped) {
            self.mutex.unlock();
            return;
        }
        self.stopped = true;
        if (self.self_cleaned) {
            // Disconnected earlier: thread detached, fds closed; free memory.
            self.mutex.unlock();
            self.gpa.destroy(self);
            return;
        }
        const own_thread = self.thread_id == std.Thread.getCurrentId();
        if (own_thread) self.detached = true;
        self.mutex.unlock();
        _ = std.posix.write(self.stop_pipe[1], "x") catch {};
        if (own_thread) {
            self.thread.?.detach();
            return;
        }
        self.thread.?.join();
        self.destroy();
    }

    fn destroy(self: *Listener) void {
        if (!self.conn_closed) self.conn.deinit();
        self.closePipe();
        self.gpa.destroy(self);
    }

    fn closePipe(self: *Listener) void {
        std.posix.close(self.stop_pipe[0]);
        std.posix.close(self.stop_pipe[1]);
    }

    fn isStopped(self: *Listener) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.stopped;
    }

    fn loop(self: *Listener) void {
        self.mutex.lock();
        self.thread_id = std.Thread.getCurrentId();
        self.mutex.unlock();
        const message = self.run();
        self.mutex.lock();
        self.exited = true;
        const notify = !self.stopped;
        if (notify) {
            // Like node-pg after 'error'/'end': the socket is gone. Copy the
            // message out of the connection-owned buffer first.
            self.conn.deinit();
            self.conn_closed = true;
        }
        self.mutex.unlock();
        if (notify) self.handler.on_disconnect(self.handler.ctx, message);
        self.mutex.lock();
        if (self.detached) {
            // stop() was called from inside a callback on this thread.
            self.mutex.unlock();
            self.destroy();
            return;
        }
        if (!self.stopped) {
            // Disconnected and not (yet) stopped: release the thread and the
            // pipe now so a retired listener only keeps its small struct
            // until the owner calls stop().
            self.self_cleaned = true;
            self.closePipe();
            self.thread.?.detach();
        }
        // else: another thread is in stop() joining us; it frees.
        self.mutex.unlock();
    }

    /// Returns the failure message when the connection ends.
    fn run(self: *Listener) ?[]const u8 {
        var next_health: ?i64 = if (self.options.health_check_ms) |ms| pq.nowMs() + @as(i64, @intCast(ms)) else null;
        // NOTIFYs parsed together with the LISTEN replies in start() already
        // sit in libpq's queue; poll() would not report them.
        self.deliver();
        while (true) {
            if (self.isStopped()) return null;
            // TLS without the exact OpenSSL check: waits are capped so input
            // a bounded drain left inside OpenSSL is read within 50 ms.
            const wait_until = self.conn.inputDeadline(next_health);
            const capped = wait_until != null and (next_health == null or wait_until.? < next_health.?);
            var timeout: i32 = -1;
            if (wait_until) |t| timeout = @intCast(@max(0, @min(t - pq.nowMs(), std.math.maxInt(i32))));
            var fds = [_]std.posix.pollfd{
                .{ .fd = self.conn.socket(), .events = std.posix.POLL.IN, .revents = 0 },
                .{ .fd = self.stop_pipe[0], .events = std.posix.POLL.IN, .revents = 0 },
            };
            const n = std.posix.poll(&fds, timeout) catch return "poll failed";
            if (self.isStopped()) return null;
            if (n == 0 and capped) {
                self.conn.consume() catch {
                    self.deliver();
                    return "Connection terminated unexpectedly";
                };
                self.deliver();
                continue;
            }
            if (n == 0) {
                var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
                defer arena.deinit();
                var failure: root.Failure = .{};
                _ = self.conn.query(arena.allocator(), "SELECT 1", &.{}, &failure) catch {
                    const len = @min(failure.message.len, self.message_buf.len);
                    @memcpy(self.message_buf[0..len], failure.message[0..len]);
                    return self.message_buf[0..len];
                };
                self.deliver();
                next_health = pq.nowMs() + @as(i64, @intCast(self.options.health_check_ms.?));
                continue;
            }
            if (fds[0].revents != 0) {
                self.conn.consume() catch {
                    self.deliver();
                    return "Connection terminated unexpectedly";
                };
                self.deliver();
            }
        }
    }

    fn deliver(self: *Listener) void {
        while (self.conn.nextNotify()) |n| {
            defer pq.freeNotify(n);
            if (self.isStopped()) continue;
            self.handler.on_notification(self.handler.ctx, std.mem.span(n.relname), std.mem.span(n.extra));
        }
    }
};
