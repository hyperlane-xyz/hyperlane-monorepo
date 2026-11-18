//! Dedicated LISTEN connection (node-pg `Client` + `LISTEN` + 'notification'
//! / 'error' / 'end' events). Every listener in the process is served by one
//! hub thread: `poll` on all their sockets and a wake pipe, then per
//! connection `PQconsumeInput` + `PQnotifies`. Optional periodic `SELECT 1`
//! health check (diagnostics' LISTENER_HEALTH_MS), sent and awaited without
//! blocking, so no connection ever delays another's notifications or
//! disconnect detection. Connecting (and so reconnecting) happens in `start`,
//! on the caller's thread, never on the hub.
const std = @import("std");
const core = @import("core");
const root = @import("root.zig");
const pq = @import("pq.zig");

/// `-Dlistener-hub-stats` builds: callback durations per listener.
const hub_stats = @import("db_options").listener_hub_stats;

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
    /// Counts this listener while the hub may still run its callbacks
    /// (`awaitThreads`).
    threads: ?*ThreadCount = null,
};

/// Counts an owner's listeners the hub may still call back
/// (`Options.threads`), including one that frees itself after a callback
/// stopped it.
pub const ThreadCount = std.atomic.Value(u32);

/// Waits until the hub is done with every listener `count` tracks (at most
/// `timeout_ms`; false on timeout). A listener stopped from inside its own
/// callback is freed by the hub after the callback returns, so an owner
/// tearing down (e.g. `DbService.close`) waits here before the memory goes
/// away.
pub fn awaitThreads(count: *const ThreadCount, timeout_ms: u64) bool {
    const deadline = pq.nowMs() + @as(i64, @intCast(timeout_ms));
    while (count.load(.acquire) > 0) {
        if (pq.nowMs() >= deadline) return false;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return true;
}

pub const Listener = struct {
    gpa: std.mem.Allocator,
    conn: pq.Conn,
    handler: Handler,
    options: Options,
    // Hub state, guarded by `hub.mutex`.
    /// `stop` was called.
    stopped: bool = false,
    /// `stop` was called while the hub ran this listener's callback on the
    /// hub thread: the hub frees it once the callback returns.
    detached: bool = false,
    /// The hub is done with it (counts released); `stop` from another thread
    /// waits for this.
    released: bool = false,
    /// Disconnected without `stop`: the hub let it go and only the struct
    /// remains until `stop` frees it.
    self_cleaned: bool = false,
    conn_closed: bool = false,
    // Hub-thread state (only the hub touches these while registered).
    /// NOTIFYs parsed with the LISTEN replies in `start` sit in libpq's queue
    /// (poll would not report them): delivered on the first pass.
    fresh: bool = true,
    next_health: ?i64 = null,
    /// The health `SELECT 1` in flight: its deadline (null: none in flight),
    /// and whether part of it is still unsent.
    health_deadline: ?i64 = null,
    health_unflushed: bool = false,
    /// The health query's result so far (a failure may precede its end).
    health: pq.Conn.SimpleState = .{},
    /// `hub_stats` builds: notification callbacks run, and their longest and
    /// total durations (ns).
    callbacks: if (hub_stats) struct { count: u64 = 0, max_ns: u64 = 0, total_ns: u64 = 0, first_channel: [64]u8 = undefined, channel_len: usize = 0 } else void = if (hub_stats) .{} else {},

    /// Connects, issues `LISTEN "<channel>"` for each channel (identifier
    /// quoted like `quoteIdentifier`) and hands the connection to the hub.
    pub fn start(
        gpa: std.mem.Allocator,
        conn_options: pq.ConnOptions,
        channels: []const []const u8,
        handler: Handler,
        options: Options,
        arena: std.mem.Allocator,
        failure: ?*root.Failure,
    ) root.Error!*Listener {
        // Connecting here would stall every listener: owners reconnect from
        // their own threads, never from a hub callback.
        std.debug.assert(!hub.onHubThreadUnlocked());
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
        self.* = .{ .gpa = gpa, .conn = conn, .handler = handler, .options = options };
        if (options.health_check_ms) |ms| self.next_health = pq.nowMs() + @as(i64, @intCast(ms));
        if (options.threads) |t| _ = t.fetchAdd(1, .acq_rel);
        hub.register(self) catch {
            if (options.threads) |t| _ = t.fetchSub(1, .acq_rel);
            return error.ConnectionFailed;
        };
        return self;
    }

    /// `unlisten`: closes the connection and frees the listener. Call exactly
    /// once per listener, also after `on_disconnect` fired (the connection is
    /// already closed then; this only frees). Safe to call from inside
    /// `on_disconnect`/`on_notification` (the hub frees it after the callback
    /// returns). From another thread it returns once no callback can run.
    pub fn stop(self: *Listener) void {
        hub.mutex.lock();
        if (self.stopped) {
            hub.mutex.unlock();
            return;
        }
        self.stopped = true;
        if (self.self_cleaned) {
            // Disconnected earlier: the hub let it go; free the struct.
            hub.mutex.unlock();
            self.gpa.destroy(self);
            return;
        }
        if (hub.onHubThread()) {
            // Inside a callback (this listener's or another's): the hub
            // releases and frees it before it polls again.
            self.detached = true;
            hub.mutex.unlock();
            return;
        }
        hub.wakeLocked();
        while (!self.released) hub.released.wait(&hub.mutex);
        hub.mutex.unlock();
        self.gpa.destroy(self);
    }

    /// Hub thread, between polls: one pass over this connection. Returns the
    /// failure message when the connection ends.
    fn pass(self: *Listener, revents: i16, now: i64) ?[]const u8 {
        if (self.fresh) {
            self.fresh = false;
            self.deliver();
        }
        const pending = self.health_deadline != null;
        if (pending and self.health_unflushed and revents & std.posix.POLL.OUT != 0) {
            self.health_unflushed = !(self.conn.flushPending() catch return "Connection terminated unexpectedly");
        }
        const readable = revents & (std.posix.POLL.IN | std.posix.POLL.ERR | std.posix.POLL.HUP | std.posix.POLL.NVAL) != 0;
        // TLS without the exact OpenSSL check: input a bounded drain left
        // inside OpenSSL is read within 50 ms (`inputDeadline`).
        const capped = if (self.conn.inputDeadline(null)) |t| now >= t else false;
        if (readable or capped) {
            self.conn.consumeInput(pending) catch {
                self.deliver();
                return "Connection terminated unexpectedly";
            };
            if (pending) switch (self.conn.takeSimple(&self.health)) {
                .busy => {},
                .ok => {
                    self.health_deadline = null;
                    self.health_unflushed = false;
                    self.next_health = now + @as(i64, @intCast(self.options.health_check_ms.?));
                },
                .failed => |message| {
                    self.deliver();
                    return message;
                },
            };
            self.deliver();
        }
        if (self.health_deadline) |due| {
            if (now >= due) return "Query read timeout";
        } else if (self.next_health) |due| if (now >= due) {
            self.health = .{};
            self.conn.sendSimple("SELECT 1") catch return "Connection terminated unexpectedly";
            self.health_unflushed = !(self.conn.flushPending() catch return "Connection terminated unexpectedly");
            // `query`'s deadline: the connection's query timeout (none: no limit).
            const timeout = self.conn.query_timeout_ms orelse 0;
            self.health_deadline = if (timeout > 0) now + @as(i64, @intCast(timeout)) else std.math.maxInt(i64);
        };
        return null;
    }

    /// The earliest moment this connection needs a pass without input.
    fn deadline(self: *Listener) ?i64 {
        var earliest = self.conn.inputDeadline(null);
        const timer = self.health_deadline orelse self.next_health;
        if (timer) |t| earliest = if (earliest) |e| @min(e, t) else t;
        return earliest;
    }

    fn events(self: *const Listener) i16 {
        var wanted: i16 = std.posix.POLL.IN;
        if (self.health_unflushed) wanted |= std.posix.POLL.OUT;
        return wanted;
    }

    /// Tests: the hub let a disconnected listener go (only `stop` remains).
    pub fn selfCleaned(self: *Listener) bool {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        return self.self_cleaned;
    }

    fn isStopped(self: *Listener) bool {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        return self.stopped;
    }

    fn deliver(self: *Listener) void {
        while (self.conn.nextNotify()) |n| {
            defer pq.freeNotify(n);
            if (self.isStopped()) continue;
            const started = if (comptime hub_stats) std.time.nanoTimestamp() else 0;
            self.handler.on_notification(self.handler.ctx, std.mem.span(n.relname), std.mem.span(n.extra));
            if (comptime hub_stats) {
                const took: u64 = @intCast(@max(0, std.time.nanoTimestamp() - started));
                const c = &self.callbacks;
                if (c.count == 0) {
                    const channel = std.mem.span(n.relname);
                    c.channel_len = @min(channel.len, c.first_channel.len);
                    @memcpy(c.first_channel[0..c.channel_len], channel[0..c.channel_len]);
                }
                c.count += 1;
                c.total_ns += took;
                c.max_ns = @max(c.max_ns, took);
            }
        }
    }
};

/// The process's one listener thread. It runs while any listener is
/// registered (started by the first `start`, gone after the last release).
const Hub = struct {
    mutex: std.Thread.Mutex = .{},
    /// `stop` from another thread waits here for `Listener.released`.
    released: std.Thread.Condition = .{},
    listeners: std.ArrayList(*Listener) = .empty,
    /// Wakes `poll` (registration, stop). Created once, never closed.
    wake: ?[2]std.posix.fd_t = null,
    running: bool = false,
    thread_id: ?std.Thread.Id = null,
    /// The hub thread's per-pass lists (poll set, the listeners it covers,
    /// connections to close after the unlock). Their capacity is reserved by
    /// `register`, where a failure reaches the caller, in the `spare` copies:
    /// the hub swaps a spare in (under the mutex) when it outgrew its list,
    /// so building a pass never allocates and `register` never touches a
    /// list the hub is using without the mutex.
    fds: std.ArrayList(std.posix.pollfd) = .empty,
    fds_spare: std.ArrayList(std.posix.pollfd) = .empty,
    batch: std.ArrayList(*Listener) = .empty,
    batch_spare: std.ArrayList(*Listener) = .empty,
    closing: std.ArrayList(pq.Conn) = .empty,
    closing_spare: std.ArrayList(pq.Conn) = .empty,

    fn onHubThreadUnlocked(self: *Hub) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.onHubThread();
    }

    fn onHubThread(self: *Hub) bool {
        return self.thread_id != null and self.thread_id.? == std.Thread.getCurrentId();
    }

    fn wakeLocked(self: *Hub) void {
        if (self.wake) |pipe| _ = std.posix.write(pipe[1], "x") catch {};
    }

    fn register(self: *Hub, listener: *Listener) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.wake == null) self.wake = std.posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true }) catch return error.ConnectionFailed;
        const a = std.heap.c_allocator;
        const count = self.listeners.items.len + 1;
        try self.fds_spare.ensureTotalCapacity(a, count + 1);
        try self.batch_spare.ensureTotalCapacity(a, count);
        try self.closing_spare.ensureTotalCapacity(a, count);
        try self.listeners.append(a, listener);
        if (!self.running) {
            const thread = std.Thread.spawn(.{}, run, .{self}) catch {
                _ = self.listeners.pop();
                return error.ConnectionFailed;
            };
            thread.detach();
            self.running = true;
        } else self.wakeLocked();
    }

    /// Mutex held: the hub is done with `listener` (stopped): its connection
    /// closes; `stop` (or, detached, the hub) frees the struct.
    /// The connection is handed to `closing`: closed after the unlock, so a
    /// close never runs under the lock every listener shares.
    fn releaseLocked(self: *Hub, index: usize) void {
        const listener = self.listeners.orderedRemove(index);
        if (comptime hub_stats) logStats(listener);
        if (!listener.conn_closed) {
            // Reserved by `register`: one slot per listener.
            self.closing.appendAssumeCapacity(listener.conn);
            listener.conn_closed = true;
        }
        const threads = listener.options.threads;
        if (listener.detached) {
            listener.gpa.destroy(listener);
        } else {
            listener.released = true;
            self.released.broadcast();
        }
        if (threads) |t| _ = t.fetchSub(1, .acq_rel);
    }

    /// Mutex held: the hub's lists can hold this pass (a spare reserved by
    /// `register` is swapped in when a list outgrew its capacity).
    fn fitLocked(self: *Hub) void {
        const count = self.listeners.items.len;
        if (self.fds.capacity < count + 1) std.mem.swap(std.ArrayList(std.posix.pollfd), &self.fds, &self.fds_spare);
        if (self.batch.capacity < count) std.mem.swap(std.ArrayList(*Listener), &self.batch, &self.batch_spare);
        if (self.closing.capacity < count) std.mem.swap(std.ArrayList(pq.Conn), &self.closing, &self.closing_spare);
        std.debug.assert(self.fds.capacity >= count + 1 and self.batch.capacity >= count and self.closing.capacity >= count);
    }

    fn run(self: *Hub) void {
        self.mutex.lock();
        self.thread_id = std.Thread.getCurrentId();
        while (true) {
            self.fitLocked();
            // Stopped listeners leave (their callbacks have returned).
            var index: usize = 0;
            while (index < self.listeners.items.len) {
                if (self.listeners.items[index].stopped) self.releaseLocked(index) else index += 1;
            }
            if (self.listeners.items.len == 0) {
                if (self.closing.items.len > 0) {
                    // Close them first (unlocked), then look again: this
                    // thread only exits with nothing left to touch, so a
                    // hub started by a `register` meanwhile never shares a
                    // list with it.
                    self.closeDeferred();
                    self.mutex.lock();
                    continue;
                }
                self.running = false;
                self.thread_id = null;
                self.mutex.unlock();
                return;
            }
            self.fds.clearRetainingCapacity();
            self.batch.clearRetainingCapacity();
            const wake = self.wake.?;
            self.fds.appendAssumeCapacity(.{ .fd = wake[0], .events = std.posix.POLL.IN, .revents = 0 });
            var earliest: ?i64 = null;
            for (self.listeners.items) |listener| {
                // Pending first passes (queued NOTIFYs) run without waiting.
                if (listener.fresh) earliest = 0;
                self.fds.appendAssumeCapacity(.{ .fd = listener.conn.socket(), .events = listener.events(), .revents = 0 });
                self.batch.appendAssumeCapacity(listener);
                if (listener.deadline()) |d| earliest = if (earliest) |e| @min(e, d) else d;
            }
            self.closeDeferred();
            var timeout: i32 = -1;
            if (earliest) |t| timeout = @intCast(@max(0, @min(t - pq.nowMs(), std.math.maxInt(i32))));
            // poll already retries EINTR (and EAGAIN is ENOMEM-class): a
            // poll error names no descriptor, so it is retried shortly rather
            // than failing every connection. A bad descriptor reports
            // POLLNVAL on its own entry and fails only that listener.
            _ = std.posix.poll(self.fds.items, timeout) catch {
                std.Thread.sleep(10 * std.time.ns_per_ms);
                self.mutex.lock();
                continue;
            };
            var drain: [64]u8 = undefined;
            if (self.fds.items[0].revents != 0) while ((std.posix.read(wake[0], &drain) catch 0) == drain.len) {};
            const now = pq.nowMs();
            for (self.batch.items, self.fds.items[1..]) |listener, fd| {
                self.mutex.lock();
                const skip = listener.stopped;
                self.mutex.unlock();
                if (skip) continue;
                const message = listener.pass(fd.revents, now) orelse continue;
                self.disconnect(listener, message);
            }
            self.mutex.lock();
        }
    }

    /// Releases the mutex, then closes the connections released this pass
    /// (never under the lock every listener shares).
    fn closeDeferred(self: *Hub) void {
        const closing = self.closing.items;
        self.closing.items.len = 0;
        self.mutex.unlock();
        // (`closing` is the hub's: `register` only grows the spare.)
        for (closing) |*conn| conn.deinit();
    }

    /// The connection ended without `stop`: close it, report, let it go.
    fn disconnect(self: *Hub, listener: *Listener, message: []const u8) void {
        self.mutex.lock();
        // Like node-pg after 'error'/'end': the socket is gone. The message
        // is a literal or in `health.buffer`, not connection-owned. Closed
        // outside the shared lock (nothing else touches it now).
        var conn = listener.conn;
        listener.conn_closed = true;
        const notify = !listener.stopped;
        self.mutex.unlock();
        conn.deinit();
        if (notify) listener.handler.on_disconnect(listener.handler.ctx, message);
        self.mutex.lock();
        defer self.mutex.unlock();
        const index = std.mem.indexOfScalar(*Listener, self.listeners.items, listener).?;
        if (listener.stopped) {
            // Stopped meanwhile (inside the callback: detached; another
            // thread: waiting for `released`). Its connection is closed.
            self.releaseLocked(index);
            return;
        }
        if (comptime hub_stats) logStats(listener);
        // Disconnected and not (yet) stopped: only the struct remains until
        // the owner calls stop().
        _ = self.listeners.orderedRemove(index);
        listener.self_cleaned = true;
        if (listener.options.threads) |t| _ = t.fetchSub(1, .acq_rel);
    }
};

var hub: Hub = .{};

fn logStats(listener: *Listener) void {
    const c = &listener.callbacks;
    if (c.count == 0) return;
    core.log.child("ListenerHub").info("callbacks channel={s} count={d} max_us={d} mean_us={d}", .{
        c.first_channel[0..c.channel_len], c.count, c.max_ns / 1000, c.total_ns / c.count / 1000,
    });
}
