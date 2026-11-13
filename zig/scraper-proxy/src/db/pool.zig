//! pg-pool equivalent over blocking libpq connections.
//!
//! * acquire: newest idle connection (LIFO, like `_idle.pop()`), else open a
//!   new one while `total < max`, else wait FIFO; with `connect_timeout_ms` a
//!   waiter gives up with "timeout exceeded when trying to connect".
//! * release: hand straight to the oldest waiter, else park idle.
//! * idle connections above `min` close after `idle_timeout_ms` (reaper thread).
//! * idle connections that the server closed are detected at checkout and
//!   reported through `on_idle_error` (pg-pool's `'error'` event).
//! * `end()` closes idle connections and refuses new work; connections in use
//!   close when released.
const std = @import("std");
const core = @import("core");
const root = @import("root.zig");
const pq = @import("pq.zig");

const Value = core.json.Value;
/// `-Dpool-hold-stats=true` (bench diagnostics): record checkout hold times.
pub const hold_stats = @import("db_options").pool_hold_stats;
const Scheduler = core.scheduler.Scheduler;
const Error = root.Error;
const Failure = root.Failure;

pub const IdleErrorHook = struct {
    ctx: *anyopaque,
    func: *const fn (ctx: *anyopaque, message: []const u8) void,
};

pub const Options = struct {
    conn: pq.ConnOptions,
    max: u32 = 10,
    min: u32 = 0,
    /// pg-pool default 10s; 0 disables reaping.
    idle_timeout_ms: u64 = 10_000,
    on_idle_error: ?IdleErrorHook = null,
    /// Timer thread for the idle reaper; null uses the process scheduler
    /// (`core.scheduler.current()`) or, without one (tests), a private thread.
    scheduler: ?*Scheduler = null,
};

pub const Stats = struct { total: u32, idle: u32, waiting: u32 };

/// Checkout-to-release times, cumulative (`hold_stats` builds only).
pub const HoldHistogram = struct {
    /// Upper bounds in microseconds; the last bucket is everything above.
    pub const bounds_us = [_]u64{ 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 50_000 };
    counts: [bounds_us.len + 1]std.atomic.Value(u64) = @splat(.init(0)),

    fn record(self: *HoldHistogram, held_ns: i128) void {
        const us: u64 = @intCast(@max(0, @divTrunc(held_ns, 1000)));
        var i: usize = 0;
        while (i < bounds_us.len and us >= bounds_us[i]) i += 1;
        _ = self.counts[i].fetchAdd(1, .monotonic);
    }

    /// `<50us=N <100us=N ... >=50000us=N`.
    pub fn format(self: *const HoldHistogram, w: *std.Io.Writer) std.Io.Writer.Error!void {
        for (bounds_us, 0..) |b, i| try w.print("<{d}us={d} ", .{ b, self.counts[i].load(.monotonic) });
        try w.print(">={d}us={d}", .{ bounds_us[bounds_us.len - 1], self.counts[bounds_us.len].load(.monotonic) });
    }
};

const Idle = struct { conn: pq.Conn, since_ms: i64 };

const Waiter = struct {
    cond: std.Thread.Condition = .{},
    /// Set by `release` (hand-off) or to signal "try to open" (`slot`).
    conn: ?pq.Conn = null,
    slot: bool = false,
    next: ?*Waiter = null,
};

pub const Pool = struct {
    gpa: std.mem.Allocator,
    options: Options,
    conninfo: []u8,
    mutex: std.Thread.Mutex = .{},
    idle: std.ArrayList(Idle) = .empty,
    total: u32 = 0,
    waiting: u32 = 0,
    head: ?*Waiter = null,
    tail: ?*Waiter = null,
    closed: bool = false,
    reaper: ?std.Thread = null,
    reaper_cond: std.Thread.Condition = .{},
    /// Scheduler-driven reaper: the pending one-shot timer (under `mutex`).
    timers: ?*Scheduler = null,
    reap_timer: u64 = 0,
    /// How long checkouts were held (`hold_stats` builds only).
    hold: HoldHistogram = .{},
    /// Disables named statements for this pool behind a transaction pooler.
    reuse_guard: pq.ReuseGuard = .{},
    /// Signalled whenever `total` drops (for `deinit` draining).
    drained: std.Thread.Condition = .{},

    pub fn init(gpa: std.mem.Allocator, options: Options) !*Pool {
        const self = try gpa.create(Pool);
        errdefer gpa.destroy(self);
        const conninfo = try gpa.dupe(u8, options.conn.conninfo);
        errdefer gpa.free(conninfo);
        var opts = options;
        opts.conn.conninfo = conninfo;
        if (opts.conn.options) |o| opts.conn.options = try gpa.dupe(u8, o);
        self.* = .{ .gpa = gpa, .options = opts, .conninfo = conninfo };
        if (opts.idle_timeout_ms > 0) {
            if (opts.scheduler orelse core.scheduler.current()) |timers| {
                self.timers = timers;
                self.reap_timer = try timers.schedule(opts.idle_timeout_ms, self, reapTick);
            } else self.reaper = try std.Thread.spawn(.{}, reapLoop, .{self});
        }
        return self;
    }

    /// Ends the pool (if not already), waits up to `drain_timeout_ms` for
    /// checked-out connections to come back, then frees it. If some never
    /// return the pool is leaked rather than freed under their feet.
    pub fn deinit(self: *Pool) void {
        self.deinitTimeout(30_000);
    }

    pub fn deinitTimeout(self: *Pool, drain_timeout_ms: u64) void {
        self.end();
        if (self.reaper) |t| t.join();
        self.reaper = null;
        if (self.timers) |timers| {
            // `end` set `closed`, so a running tick will not re-arm; `cancel`
            // waits for it, or drops the pending one.
            self.mutex.lock();
            const id = self.reap_timer;
            self.mutex.unlock();
            _ = timers.cancel(id);
        }
        self.mutex.lock();
        const deadline = pq.nowMs() + @as(i64, @intCast(drain_timeout_ms));
        while (self.total > 0) {
            const remaining = deadline - pq.nowMs();
            if (remaining <= 0) break;
            self.drained.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
        const busy = self.total > 0;
        self.mutex.unlock();
        if (busy) return;
        self.idle.deinit(self.gpa);
        if (self.options.conn.options) |o| self.gpa.free(o);
        self.gpa.free(self.conninfo);
        self.gpa.destroy(self);
    }

    /// `pool.end()`.
    pub fn end(self: *Pool) void {
        self.mutex.lock();
        if (self.closed) {
            self.mutex.unlock();
            return;
        }
        self.closed = true;
        var idle = self.idle;
        self.idle = .empty;
        self.total -= @intCast(idle.items.len);
        // Wake waiters so they fail with PoolClosed.
        var w = self.head;
        while (w) |waiter| : (w = waiter.next) waiter.cond.signal();
        self.reaper_cond.signal();
        self.mutex.unlock();
        for (idle.items) |*i| i.conn.deinit();
        idle.deinit(self.gpa);
    }

    pub fn stats(self: *Pool) Stats {
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{ .total = self.total, .idle = @intCast(self.idle.items.len), .waiting = self.waiting };
    }

    /// `pool.query(text, values)`.
    pub fn query(self: *Pool, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error!root.Result {
        return self.queryWith(arena, sql, params, .{}, failure);
    }

    pub fn queryWith(self: *Pool, arena: std.mem.Allocator, sql: []const u8, params: []const Value, opts: pq.QueryOptions, failure: ?*Failure) Error!root.Result {
        var conn = try self.acquire(arena, failure);
        var with_guard = opts;
        with_guard.guard = &self.reuse_guard;
        const result = conn.queryWith(arena, sql, params, with_guard, failure);
        self.release(conn);
        return result;
    }

    /// `pool.connect()`; pair with `release`.
    pub fn acquire(self: *Pool, arena: std.mem.Allocator, failure: ?*Failure) Error!pq.Conn {
        return (try self.acquireWith(arena, failure, true)).?;
    }

    /// A query sent ahead of its read point (`begin`). `poll` reads what has
    /// arrived without waiting and, once the reply is complete, keeps the
    /// result and returns the connection to the pool at once; `finish`
    /// returns it (waiting for the rest if needed); `cancel` abandons it.
    pub const Pending = struct {
        pool: *Pool,
        /// Null once the connection went back to the pool.
        conn: ?pq.Conn,
        reply: pq.RawReply = .{},
        /// A transport failure or client timeout while reading.
        failed: ?Error = null,
        /// When the reply was complete (pq.nowMs; 0 while pending).
        arrived_ms: i64 = 0,

        /// Reads what has arrived without waiting; once the reply is
        /// complete (or the connection failed) the connection goes back to
        /// the pool. True when settled. Rows stay unconverted (any thread).
        pub fn poll(self: *Pending) bool {
            const conn = if (self.conn) |*c| c else return true;
            const done = conn.pollRaw(&self.reply) catch |e| {
                self.settle(e);
                return true;
            };
            if (done) self.settle(null);
            return done;
        }

        /// See `pq.Conn.tlsBlind`: poll it on a short timer too.
        pub fn tlsBlind(self: *const Pending) bool {
            return if (self.conn) |c| c.tlsBlind() else false;
        }

        /// The socket to wait on for more of the reply (null once settled).
        pub fn socket(self: *const Pending) ?std.posix.fd_t {
            return if (self.conn) |c| c.socket() else null;
        }

        /// Part of the query is still unsent: wait for writability too.
        pub fn wantsWrite(self: *const Pending) bool {
            return if (self.conn) |c| c.wantsWrite() else false;
        }

        /// Waits for the rest of the reply if needed (client timeout counted
        /// from here) and returns the rows, converted in `arena`.
        pub fn finish(self: *Pending, arena: std.mem.Allocator, failure: ?*Failure) Error!root.Result {
            if (self.conn) |*conn| self.settle(if (conn.finishRaw(&self.reply)) |_| null else |e| e);
            if (self.failed) |e| {
                self.reply.deinit();
                setFailed(arena, failure, e);
                return e;
            }
            return self.reply.take(arena, failure);
        }

        /// Abandons it: the connection is closed if the reply is still
        /// coming (callers that can wait use `poll` until settled instead).
        pub fn cancel(self: *Pending) void {
            if (self.conn) |*conn| {
                conn.discardQuery();
                self.pool.release(conn.*);
                self.conn = null;
            }
            self.reply.deinit();
        }

        /// SQLSTATE of a server error already received (borrowed).
        pub fn errorCode(self: *const Pending) ?[]const u8 {
            return self.reply.errorCode();
        }

        fn settle(self: *Pending, failed: ?Error) void {
            self.failed = failed;
            self.arrived_ms = pq.nowMs();
            self.pool.release(self.conn.?);
            self.conn = null;
        }

        fn setFailed(arena: std.mem.Allocator, failure: ?*Failure, e: Error) void {
            const f = failure orelse return;
            f.message = arena.dupe(u8, if (e == error.QueryTimeout) "Query read timeout" else "Connection terminated unexpectedly") catch "";
            f.code = null;
        }
    };

    /// Sends an unnamed query on a connection that is idle right now and
    /// returns without reading it (see `Pending`); null (nothing sent) when
    /// no connection is idle. Never opens a connection, never queues, never
    /// takes one ahead of a waiting request, never waits on the socket (a
    /// message the kernel does not take at once is finished by `poll` or
    /// `finish`; wait for writability while `wantsWrite`).
    pub fn begin(self: *Pool, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error!?Pending {
        var conn = try self.acquireWith(arena, failure, false) orelse return null;
        conn.sendQuery(arena, sql, params, failure) catch |e| {
            self.release(conn);
            return e;
        };
        return .{ .pool = self, .conn = conn };
    }

    /// `acquire`, or (`wait == false`) an idle connection or null at once.
    fn acquireWith(self: *Pool, arena: std.mem.Allocator, failure: ?*Failure, wait: bool) Error!?pq.Conn {
        // pg-pool: a queued request's connectionTimeoutMillis timer runs from
        // the `connect()` call, also while its new client is connecting.
        const deadline: ?i64 = if (self.options.conn.connect_timeout_ms) |ms| (if (ms > 0) pq.nowMs() + @as(i64, @intCast(ms)) else null) else null;
        while (true) {
            var blocked = false;
            const got = self.checkout(arena, failure, deadline, wait, &blocked);
            // Paired with the `begin` in `checkout`, outside the pool mutex.
            if (blocked) core.blocking.end();
            switch (try got) {
                .busy => return null,
                .conn => |c| {
                    var conn = c;
                    var idle_failure: Failure = .{};
                    if (conn.checkIdle(arena, &idle_failure)) {
                        if (hold_stats) conn.checked_out_ns = std.time.nanoTimestamp();
                        return conn;
                    }
                    if (self.options.on_idle_error) |hook| hook.func(hook.ctx, idle_failure.message);
                    self.discard(&conn);
                },
                .open => |queued| {
                    var opts = self.options.conn;
                    if (queued) if (deadline) |d| {
                        opts.connect_timeout_ms = @intCast(@max(1, d - pq.nowMs()));
                    };
                    var conn = pq.Conn.connect(opts, arena, failure) catch |e| {
                        self.mutex.lock();
                        self.total -= 1;
                        self.wakeOne();
                        self.drained.broadcast();
                        self.mutex.unlock();
                        if (queued and deadline != null and pq.nowMs() >= deadline.?) {
                            if (failure) |f| f.message = arena.dupe(u8, "timeout exceeded when trying to connect") catch "";
                        }
                        return e;
                    };
                    self.mutex.lock();
                    const closed = self.closed;
                    self.mutex.unlock();
                    if (closed) {
                        self.discard(&conn);
                        return error.PoolClosed;
                    }
                    if (hold_stats) conn.checked_out_ns = std.time.nanoTimestamp();
                    return conn;
                },
            }
        }
    }

    /// `open`: a slot is reserved (counted in `total`); true when it was
    /// obtained after queueing.
    const Checkout = union(enum) { conn: pq.Conn, open: bool, busy };

    /// Sets `blocked` after `core.blocking.begin()` (caller calls `end`).
    fn checkout(self: *Pool, arena: std.mem.Allocator, failure: ?*Failure, deadline: ?i64, wait: bool, blocked: *bool) Error!Checkout {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.closed) return error.PoolClosed;
        if (self.head == null) {
            if (self.idle.pop()) |i| return .{ .conn = i.conn };
            if (!wait) return .busy;
            if (self.total < self.options.max) {
                self.total += 1;
                return .{ .open = false };
            }
        }
        if (!wait) return .busy;
        var waiter: Waiter = .{};
        if (self.tail) |t| t.next = &waiter else self.head = &waiter;
        self.tail = &waiter;
        self.waiting += 1;
        defer self.waiting -= 1;
        // About to sleep: let an HTTP poller hand off its work. The hook runs
        // with the pool mutex released; a hand-off meanwhile is seen by the
        // loop condition below.
        self.mutex.unlock();
        core.blocking.begin();
        blocked.* = true;
        self.mutex.lock();
        while (waiter.conn == null and !waiter.slot and !self.closed) {
            if (deadline) |d| {
                const remaining = d - pq.nowMs();
                if (remaining <= 0) {
                    self.unlink(&waiter);
                    if (failure) |f| f.message = arena.dupe(u8, "timeout exceeded when trying to connect") catch "";
                    return error.ConnectionFailed;
                }
                waiter.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
            } else waiter.cond.wait(&self.mutex);
        }
        if (waiter.conn) |c| return .{ .conn = c };
        // `wakeOne` already reserved the slot.
        if (waiter.slot) return .{ .open = true };
        self.unlink(&waiter);
        return error.PoolClosed;
    }

    fn unlink(self: *Pool, waiter: *Waiter) void {
        var prev: ?*Waiter = null;
        var cur = self.head;
        while (cur) |c| : (cur = c.next) {
            if (c == waiter) {
                if (prev) |p| p.next = c.next else self.head = c.next;
                if (self.tail == c) self.tail = prev;
                return;
            }
            prev = c;
        }
    }

    fn popWaiter(self: *Pool) ?*Waiter {
        const w = self.head orelse return null;
        self.head = w.next;
        if (self.head == null) self.tail = null;
        w.next = null;
        return w;
    }

    /// A slot freed up: let the oldest waiter open a connection.
    fn wakeOne(self: *Pool) void {
        if (self.total >= self.options.max) return;
        if (self.popWaiter()) |w| {
            // Reserve now so a newcomer cannot take the slot before the
            // waiter runs (which would exceed `max`).
            self.total += 1;
            w.slot = true;
            w.cond.signal();
        }
    }

    pub fn release(self: *Pool, conn_in: pq.Conn) void {
        var conn = conn_in;
        if (hold_stats and conn.checked_out_ns != 0) self.hold.record(std.time.nanoTimestamp() - conn.checked_out_ns);
        if (!conn.ok()) return self.discard(&conn);
        self.mutex.lock();
        if (self.closed) {
            self.total -= 1;
            self.drained.broadcast();
            self.mutex.unlock();
            conn.deinit();
            return;
        }
        if (self.popWaiter()) |w| {
            w.conn = conn;
            w.cond.signal();
            self.mutex.unlock();
            return;
        }
        self.idle.append(self.gpa, .{ .conn = conn, .since_ms = pq.nowMs() }) catch {
            self.total -= 1;
            self.drained.broadcast();
            self.mutex.unlock();
            conn.deinit();
            return;
        };
        self.mutex.unlock();
    }

    fn discard(self: *Pool, conn: *pq.Conn) void {
        conn.deinit();
        self.mutex.lock();
        self.total -= 1;
        self.wakeOne();
        self.drained.broadcast();
        self.mutex.unlock();
    }

    /// One reaper pass on the shared timer thread: closes idle connections
    /// past `idle_timeout_ms` (above `min`) and re-arms for the next expiry.
    fn reapTick(ctx: *anyopaque, _: u64) void {
        const self: *Pool = @ptrCast(@alignCast(ctx));
        const timeout: i64 = @intCast(self.options.idle_timeout_ms);
        var expired: [16]pq.Conn = undefined;
        while (true) {
            var n: usize = 0;
            self.mutex.lock();
            const now = pq.nowMs();
            var next_check: i64 = timeout;
            var i: usize = 0;
            while (i < self.idle.items.len) {
                const age = now - self.idle.items[i].since_ms;
                if (age >= timeout and self.total > self.options.min and n < expired.len) {
                    expired[n] = self.idle.orderedRemove(i).conn;
                    n += 1;
                    self.total -= 1;
                    continue;
                }
                next_check = @min(next_check, timeout - age);
                i += 1;
            }
            if (n > 0) self.drained.broadcast();
            const more = n == expired.len;
            if (!more and !self.closed) {
                const wait_ms: u64 = @intCast(@max(next_check, 10));
                // Out of memory leaves the pool without a reaper (as a
                // failed thread spawn would): idle connections then stay open.
                self.reap_timer = self.timers.?.schedule(wait_ms, self, reapTick) catch 0;
            }
            self.mutex.unlock();
            // Quick: PQfinish sends Terminate and closes the socket.
            for (expired[0..n]) |*conn| conn.deinit();
            if (!more) return;
        }
    }

    fn reapLoop(self: *Pool) void {
        const timeout: i64 = @intCast(self.options.idle_timeout_ms);
        self.mutex.lock();
        defer self.mutex.unlock();
        while (!self.closed) {
            const now = pq.nowMs();
            var next_check: i64 = timeout;
            var i: usize = 0;
            while (i < self.idle.items.len) {
                const age = now - self.idle.items[i].since_ms;
                if (age >= timeout and self.total > self.options.min) {
                    var conn = self.idle.orderedRemove(i).conn;
                    self.total -= 1;
                    self.drained.broadcast();
                    self.mutex.unlock();
                    conn.deinit();
                    self.mutex.lock();
                    continue;
                }
                next_check = @min(next_check, timeout - age);
                i += 1;
            }
            const wait_ms: u64 = @intCast(@max(next_check, 10));
            self.reaper_cond.timedWait(&self.mutex, wait_ms * std.time.ns_per_ms) catch {};
        }
    }
};
