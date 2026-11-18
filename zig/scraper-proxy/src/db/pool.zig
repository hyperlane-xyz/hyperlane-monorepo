//! pg-pool equivalent over blocking libpq connections.
//!
//! * acquire: newest idle connection (LIFO, like `_idle.pop()`; on a fiber,
//!   the newest one already registered on its loop, if any), else
//!   open a new one while `total < max`, else wait FIFO; with `connect_timeout_ms` a
//!   waiter gives up with "timeout exceeded when trying to connect".
//! * release: hand straight to the oldest waiter, else park idle.
//! * idle connections above `min` close after `idle_timeout_ms` (reaper thread).
//! * idle connections that the server closed are reported through
//!   `on_idle_error` (pg-pool's `'error'` event) and dropped, not replaced:
//!   by the idle sweep on the reaper's tick (`idle_check_ms`), else at
//!   checkout.
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
    /// pg-pool's idle listener: every this many ms the reaper's tick looks
    /// at the idle connections (before reaping) and reports and drops the
    /// ones the server closed, rather than waiting for their next checkout.
    /// 0: checkout only.
    idle_check_ms: u64 = 0,
    /// Timer thread for the idle reaper; null uses the process scheduler
    /// (`core.scheduler.current()`) or, without one (tests), a private thread.
    scheduler: ?*Scheduler = null,
    /// Fiber loops (`-Dhttp-loops` > 1): a released connection goes to the
    /// oldest waiter on its own loop ahead of an older waiter on another
    /// loop only while that older waiter has waited less than this.
    affinity_bound_ms: u32 = 1,
};

pub const Stats = struct { total: u32, idle: u32, waiting: u32 };

/// Checkout-to-release times, cumulative (`hold_stats` builds only).
pub const HoldHistogram = struct {
    /// Upper bounds in microseconds; the last bucket is everything above.
    pub const bounds_us = [_]u64{ 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 50_000 };
    counts: [bounds_us.len + 1]std.atomic.Value(u64) = @splat(.init(0)),
    /// Where checkouts came from relative to the caller's event loop
    /// (`Conn.home`; pool mutex held when counted): an idle connection of
    /// its loop, another idle one (moves loops unless never waited on), a
    /// release hand-off from the same or another loop, or off a fiber.
    affinity: [@typeInfo(Affinity).@"enum".fields.len]std.atomic.Value(u64) = @splat(.init(0)),
    /// `handoff_starved`: the oldest waiter (another loop's) got the
    /// connection because it had waited `affinity_bound_ms`.
    pub const Affinity = enum { own, other, handoff_same, handoff_other, thread, handoff_starved };

    fn count(self: *HoldHistogram, a: Affinity) void {
        _ = self.affinity[@intFromEnum(a)].fetchAdd(1, .monotonic);
    }

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
        try w.writeAll(" affinity");
        for (self.affinity, 0..) |c, i| try w.print(" {s}={d}", .{ @tagName(@as(Affinity, @enumFromInt(i))), c.load(.monotonic) });
    }
};

/// `seq`: release order (ties in `since_ms` are common), kept when the
/// idle sweep puts a connection back.
const Idle = struct { conn: pq.Conn, since_ms: i64, seq: u64 = 0 };

const Waiter = struct {
    cond: std.Thread.Condition = .{},
    /// Set when the waiter is a fiber: it parks instead of blocking a thread.
    fiber: ?*core.fiber.Waiter = null,
    /// Set by `release` (hand-off) or to signal "try to open" (`slot`).
    conn: ?pq.Conn = null,
    slot: bool = false,
    next: ?*Waiter = null,
    /// A fiber waiter's event loop (null: a thread) and when it queued
    /// (`Pool.handoffWaiter`).
    loop: ?*anyopaque = null,
    queued_ns: i128 = 0,

    /// Pool mutex held.
    fn signal(self: *Waiter) void {
        if (self.fiber) |fw| fw.wake() else self.cond.signal();
    }
};

/// `pq.Conn.connect` from a fiber without blocking its loop: the fiber
/// waits for the socket (TCP, TLS, startup and auth round trips stay async,
/// as node-pg's connect), while `Connector`'s few workers run the CPU steps
/// (each `PQconnectPoll`) and the host-name resolution in `connectStart`
/// (not needed for IP literals or Unix sockets).
fn connectOffFiber(opts: pq.ConnOptions, arena: std.mem.Allocator, failure: ?*Failure) Error!pq.Conn {
    if (!core.fiber.inFiber()) return pq.Conn.connect(opts, arena, failure);
    const started = if (pq.startMayBlock(opts.conninfo)) try connector.start(opts, arena, failure) else try pq.Conn.connectStart(opts, arena, failure);
    return pq.Conn.connectFinish(started, arena, failure, connector.poller());
}

/// Process-wide bounded executor for the CPU-heavy or blocking steps of
/// fiber connects: `connectStart` (libpq's blocking host-name resolution)
/// and each `PQconnectPoll` call (TLS handshake crypto, SCRAM-SHA-256's
/// PBKDF2: ~2 ms per connect), which would otherwise stall the fiber's loop
/// (node-pg also runs SCRAM's PBKDF2 off its main thread). Network waits
/// stay on the fiber, so a worker is held only for one CPU step at a time.
/// At most `max_workers` threads, started on demand, exiting after
/// `idle_exit_ms` without work (no idle threads). Jobs run FIFO. A start
/// job counts its queue time against the connect timeout, which runs from
/// `pool.connect()` as in pg-pool and node-pg: one whose deadline passed
/// while queued fails with node-pg's timeout text without starting.
const Connector = struct {
    mutex: std.Thread.Mutex = .{},
    work: std.Thread.Condition = .{},
    head: ?*Job = null,
    tail: ?*Job = null,
    workers: u32 = 0,
    idle: u32 = 0,
    /// Test-only: the most workers alive at once.
    peak: u32 = 0,

    pub const max_workers = 4;
    const idle_exit_ms = 250;

    const Job = struct {
        kind: union(enum) {
            start: struct {
                opts: pq.ConnOptions,
                arena: std.mem.Allocator,
                failure: ?*Failure,
                deadline: ?i64,
                result: Error!pq.Conn.Starting = error.ConnectionFailed,
            },
            poll: struct { pg: *anyopaque, state: c_int = 0 },
        },
        done: core.fiber.Waiter = .{},
        next: ?*Job = null,
    };

    fn start(self: *Connector, opts: pq.ConnOptions, arena: std.mem.Allocator, failure: ?*Failure) Error!pq.Conn.Starting {
        const deadline: ?i64 = if (opts.connect_timeout_ms) |ms| (if (ms > 0) pq.nowMs() + @as(i64, @intCast(ms)) else null) else null;
        var job: Job = .{ .kind = .{ .start = .{ .opts = opts, .arena = arena, .failure = failure, .deadline = deadline } } };
        if (!self.submit(&job)) return pq.Conn.connectStart(opts, arena, failure);
        job.done.wait();
        return job.kind.start.result;
    }

    /// `pq.Conn.Poller`: one `PQconnectPoll` call on a worker.
    fn poll(ctx: *anyopaque, pg: *anyopaque) c_int {
        const self: *Connector = @ptrCast(@alignCast(ctx));
        var job: Job = .{ .kind = .{ .poll = .{ .pg = pg } } };
        if (!self.submit(&job)) return pq.pollConnect(pg);
        job.done.wait();
        return job.kind.poll.state;
    }

    fn poller(self: *Connector) pq.Conn.Poller {
        return .{ .ctx = self, .poll = poll };
    }

    /// Queues `job`, starting a worker if none is free. False when no
    /// worker thread exists or can be started (the caller runs it inline).
    fn submit(self: *Connector, job: *Job) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.tail) |t| t.next = job else self.head = job;
        self.tail = job;
        if (self.idle > 0) {
            self.work.signal();
        } else if (self.workers < max_workers) {
            if (std.Thread.spawn(.{}, workerLoop, .{self})) |thread| {
                thread.detach();
                self.workers += 1;
                self.peak = @max(self.peak, self.workers);
            } else |_| if (self.workers == 0) {
                self.unlinkLocked(job);
                return false;
            }
        }
        return true;
    }

    fn unlinkLocked(self: *Connector, job: *Job) void {
        var prev: ?*Job = null;
        var cur = self.head;
        while (cur) |c| : (cur = c.next) {
            if (c == job) {
                if (prev) |p| p.next = c.next else self.head = c.next;
                if (self.tail == c) self.tail = prev;
                return;
            }
            prev = c;
        }
    }

    fn workerLoop(self: *Connector) void {
        self.mutex.lock();
        while (true) {
            const job = self.head orelse {
                self.idle += 1;
                const timed_out = if (self.work.timedWait(&self.mutex, idle_exit_ms * std.time.ns_per_ms)) |_| false else |_| true;
                self.idle -= 1;
                if (timed_out and self.head == null) {
                    self.workers -= 1;
                    self.mutex.unlock();
                    return;
                }
                continue;
            };
            self.head = job.next;
            if (self.head == null) self.tail = null;
            self.mutex.unlock();
            switch (job.kind) {
                .start => |*st| st.result = startJob(st.opts, st.arena, st.failure, st.deadline),
                .poll => |*pl| pl.state = pq.pollConnect(pl.pg),
            }
            job.done.wake(); // last touch of `job` (it lives on the caller's stack)
            self.mutex.lock();
        }
    }

    fn startJob(opts_in: pq.ConnOptions, arena: std.mem.Allocator, failure: ?*Failure, deadline: ?i64) Error!pq.Conn.Starting {
        var opts = opts_in;
        if (deadline) |d| {
            const left = d - pq.nowMs();
            if (left <= 0) {
                if (failure) |f| f.* = .{ .message = arena.dupe(u8, "Connection terminated due to connection timeout") catch "" };
                return error.ConnectionFailed;
            }
            opts.connect_timeout_ms = @intCast(left);
        }
        return pq.Conn.connectStart(opts, arena, failure);
    }
};

var connector: Connector = .{};

/// Test-only view of the connect executor.
pub fn connectorStats() struct { workers: u32, peak: u32 } {
    connector.mutex.lock();
    defer connector.mutex.unlock();
    return .{ .workers = connector.workers, .peak = connector.peak };
}

/// Test-only.
pub fn resetConnectorPeak() void {
    connector.mutex.lock();
    defer connector.mutex.unlock();
    connector.peak = connector.workers;
}

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
    /// The next idle entry's `seq` (under `mutex`).
    release_seq: u64 = 0,

    pub fn init(gpa: std.mem.Allocator, options: Options) !*Pool {
        const self = try gpa.create(Pool);
        errdefer gpa.destroy(self);
        const conninfo = try gpa.dupe(u8, options.conn.conninfo);
        errdefer gpa.free(conninfo);
        var opts = options;
        opts.conn.conninfo = conninfo;
        if (opts.conn.options) |o| opts.conn.options = try gpa.dupe(u8, o);
        self.* = .{ .gpa = gpa, .options = opts, .conninfo = conninfo };
        if (opts.idle_timeout_ms > 0 or opts.idle_check_ms > 0) {
            if (opts.scheduler orelse core.scheduler.current()) |timers| {
                self.timers = timers;
                // With the idle sweep the tick runs only while connections
                // are idle: the first release arms it (`putBack`).
                if (opts.idle_check_ms == 0) self.reap_timer = try timers.schedule(opts.idle_timeout_ms, self, reapTick);
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
            // 0: no tick pending or running (`Scheduler.cancel(0)` would
            // wait for an idle scheduler).
            if (id != 0) _ = timers.cancel(id);
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
        while (w) |waiter| : (w = waiter.next) waiter.signal();
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
        // pg-pool: a queued request's connectionTimeoutMillis timer runs from
        // the `connect()` call, also while its new client is connecting.
        const deadline: ?i64 = if (self.options.conn.connect_timeout_ms) |ms| (if (ms > 0) pq.nowMs() + @as(i64, @intCast(ms)) else null) else null;
        while (true) {
            var blocked = false;
            const got = self.checkout(arena, failure, deadline, &blocked);
            // Paired with the `begin` in `checkout`, outside the pool mutex.
            if (blocked) core.blocking.end();
            switch (try got) {
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
                    var conn = connectOffFiber(opts, arena, failure) catch |e| {
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
    const Checkout = union(enum) { conn: pq.Conn, open: bool };

    /// The newest idle connection (LIFO). On a fiber, the newest one whose
    /// socket is registered on the fiber's loop, if any (the list holds at
    /// most `max`): another loop's would have to move to this one (epoll_ctl
    /// DEL and ADD under the loop group's lock). Mutex held.
    fn takeIdle(self: *Pool) ?pq.Conn {
        const items = self.idle.items;
        if (items.len == 0) return null;
        if (core.fiber.current()) |f| {
            var i = items.len;
            while (i > 0) {
                i -= 1;
                if (items[i].conn.home == f.sched.ctx) {
                    if (hold_stats) self.hold.count(.own);
                    return self.idle.orderedRemove(i).conn;
                }
            }
            if (hold_stats) self.hold.count(.other);
        } else if (hold_stats) self.hold.count(.thread);
        return self.idle.pop().?.conn;
    }

    /// Sets `blocked` after `core.blocking.begin()` (caller calls `end`).
    fn checkout(self: *Pool, arena: std.mem.Allocator, failure: ?*Failure, deadline: ?i64, blocked: *bool) Error!Checkout {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.closed) return error.PoolClosed;
        if (self.head == null) {
            if (self.takeIdle()) |c| return .{ .conn = c };
            if (self.total < self.options.max) {
                self.total += 1;
                return .{ .open = false };
            }
        }
        var waiter: Waiter = .{};
        if (self.tail) |t| t.next = &waiter else self.head = &waiter;
        self.tail = &waiter;
        self.waiting += 1;
        defer self.waiting -= 1;
        // A fiber parks (no thread blocked) until a hand-off, a free slot
        // or the checkout deadline (`waitTimeout`).
        if (core.fiber.inFiber()) {
            const mono: ?i64 = if (deadline) |d| core.fiber.monoMs() + (d - pq.nowMs()) else null;
            waiter.loop = core.fiber.current().?.sched.ctx;
            waiter.queued_ns = std.time.nanoTimestamp();
            while (waiter.conn == null and !waiter.slot and !self.closed) {
                var fw: core.fiber.Waiter = .{};
                waiter.fiber = &fw;
                self.mutex.unlock();
                const woken = fw.waitTimeout(mono);
                self.mutex.lock();
                waiter.fiber = null;
                if (!woken and waiter.conn == null and !waiter.slot) {
                    self.unlink(&waiter);
                    if (failure) |f| f.message = arena.dupe(u8, "timeout exceeded when trying to connect") catch "";
                    return error.ConnectionFailed;
                }
            }
            if (waiter.conn) |c| return .{ .conn = c };
            if (waiter.slot) return .{ .open = true };
            self.unlink(&waiter);
            return error.PoolClosed;
        }
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

    /// The waiter a released connection goes to. pg-pool serves waiters
    /// FIFO. With several fiber loops, the oldest waiter on the connection's
    /// loop (`home`) goes first, so the socket need not move between loops,
    /// unless the oldest waiter overall is a thread, has waited
    /// `affinity_bound_ms`, or no waiter of that loop is ahead of the first
    /// thread waiter. With one loop every fiber waiter is on `home`: plain
    /// FIFO. Deadlines are untouched (a skipped waiter times out as before).
    /// Mutex held.
    fn handoffWaiter(self: *Pool, home: ?*anyopaque, now_ns: i128) ?*Waiter {
        const head = self.head orelse return null;
        const h = home orelse return self.popWaiter();
        if (head.loop == null or head.loop == h) return self.popWaiter();
        if (now_ns - head.queued_ns >= @as(i128, self.options.affinity_bound_ms) * std.time.ns_per_ms) {
            if (hold_stats) self.hold.count(.handoff_starved);
            return self.popWaiter();
        }
        var prev = head;
        while (prev.next) |c| : (prev = c) {
            if (c.loop == null) break; // threads are never passed over
            if (c.loop == h) {
                prev.next = c.next;
                if (self.tail == c) self.tail = prev;
                c.next = null;
                return c;
            }
        }
        return self.popWaiter();
    }

    /// A slot freed up: let the oldest waiter open a connection.
    fn wakeOne(self: *Pool) void {
        if (self.total >= self.options.max) return;
        if (self.popWaiter()) |w| {
            // Reserve now so a newcomer cannot take the slot before the
            // waiter runs (which would exceed `max`).
            self.total += 1;
            w.slot = true;
            w.signal();
        }
    }

    pub fn release(self: *Pool, conn_in: pq.Conn) void {
        var conn = conn_in;
        if (hold_stats and conn.checked_out_ns != 0) self.hold.record(std.time.nanoTimestamp() - conn.checked_out_ns);
        if (!conn.ok()) return self.discard(&conn);
        self.putBack(.{ .conn = conn, .since_ms = pq.nowMs() }, false);
    }

    /// Hands a usable connection to a waiter, else parks it idle: a release
    /// goes last (newest); the sweep puts a healthy connection back where
    /// it was (`swept`: its `seq` and `since_ms` kept), so LIFO checkout and
    /// the reaper's ages are unchanged.
    fn putBack(self: *Pool, entry_in: Idle, swept: bool) void {
        var entry = entry_in;
        var conn = entry.conn;
        self.mutex.lock();
        if (self.closed) {
            self.total -= 1;
            self.drained.broadcast();
            self.mutex.unlock();
            conn.deinit();
            return;
        }
        if (self.handoffWaiter(conn.home, std.time.nanoTimestamp())) |w| {
            if (hold_stats) {
                self.hold.count(if (w.loop == null) .thread else if (w.loop == conn.home) .handoff_same else .handoff_other);
            }
            w.conn = conn;
            w.signal();
            self.mutex.unlock();
            return;
        }
        var at = self.idle.items.len;
        if (swept) {
            while (at > 0 and self.idle.items[at - 1].seq > entry.seq) at -= 1;
        } else {
            entry.seq = self.release_seq;
            self.release_seq += 1;
        }
        self.idle.insert(self.gpa, at, entry) catch {
            self.total -= 1;
            self.drained.broadcast();
            self.mutex.unlock();
            conn.deinit();
            return;
        };
        // An idle connection restarts the idle sweep's tick if it stopped
        // (it stops while none is idle; the reaper has nothing to do then).
        if (self.options.idle_check_ms > 0) {
            if (self.timers) |timers| {
                // Out of memory: the next release tries again.
                if (self.reap_timer == 0) self.reap_timer = timers.schedule(self.nextTick(if (self.options.idle_timeout_ms > 0) @intCast(self.options.idle_timeout_ms) else null), self, reapTick) catch 0;
            } else if (self.idle.items.len == 1) self.reaper_cond.signal();
        }
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

    /// Whether an idle connection may hold input (a FATAL, an EOF): the
    /// event loop's readiness word when a fiber ever waited on it (no
    /// syscall unless an edge arrived; the word stays set until the next
    /// fiber wait, so a stale one costs a poll), else a poll. Mutex held:
    /// the connection is in `idle`, so its readiness record is still its own.
    fn idleInputPending(conn: *const pq.Conn) bool {
        if (conn.readiness) |bits| if (!core.fiber.inputSeen(bits)) return false;
        var fds = [_]std.posix.pollfd{.{ .fd = conn.socket(), .events = std.posix.POLL.IN, .revents = 0 }};
        const ready = std.posix.poll(&fds, 0) catch return true;
        return ready > 0;
    }

    /// pg-pool's idle listener (`idle_check_ms`): idle connections with
    /// input are taken out of `idle` (which makes them the sweep's, as a
    /// checkout's) and checked off the mutex. One the server closed is
    /// reported (`on_idle_error`) and dropped, not replaced; a healthy one
    /// (e.g. a stray notice) goes back in release order, or closes if the
    /// pool ended meanwhile. Mutex not held.
    fn sweep(self: *Pool) void {
        if (self.options.idle_check_ms == 0) return;
        var taken: [16]Idle = undefined;
        var n: usize = 0;
        self.mutex.lock();
        if (!self.closed) {
            var i: usize = 0;
            while (i < self.idle.items.len and n < taken.len) {
                if (idleInputPending(&self.idle.items[i].conn)) {
                    taken[n] = self.idle.orderedRemove(i);
                    n += 1;
                } else i += 1;
            }
        }
        self.mutex.unlock();
        if (n == 0) return;
        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        for (taken[0..n]) |*entry| {
            var failure: Failure = .{};
            if (entry.conn.checkIdle(arena_state.allocator(), &failure)) {
                self.putBack(entry.*, true);
                continue;
            }
            if (self.options.on_idle_error) |hook| hook.func(hook.ctx, failure.message);
            self.discard(&entry.conn);
        }
    }

    /// An idle connection the reaper is closing: if the server closed it
    /// first, report it as pg-pool's idle listener would have (it may have
    /// died since the last sweep). Mutex not held.
    fn reportIfDead(self: *Pool, conn: *pq.Conn) void {
        const hook = self.options.on_idle_error orelse return;
        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        var failure: Failure = .{};
        if (!conn.checkIdle(arena_state.allocator(), &failure)) hook.func(hook.ctx, failure.message);
    }

    /// The reaper's next wait: the next expiry, at most `idle_check_ms`.
    fn nextTick(self: *const Pool, next_expiry: ?i64) u64 {
        const check: i64 = @intCast(self.options.idle_check_ms);
        const wait = if (next_expiry) |e| (if (check > 0) @min(e, check) else e) else check;
        return @intCast(@max(wait, 10));
    }

    /// One reaper pass on the shared timer thread: the idle sweep, then
    /// closes idle connections past `idle_timeout_ms` (above `min`) and
    /// re-arms for the next expiry or sweep. With the sweep, a tick that
    /// finds no idle connection does not re-arm (`putBack` does). A tick in
    /// progress is `reap_timer` until its last locked section, so `deinit`'s
    /// cancel waits for it; nothing touches the pool after that section.
    fn reapTick(ctx: *anyopaque, _: u64) void {
        const self: *Pool = @ptrCast(@alignCast(ctx));
        self.sweep();
        const timeout: i64 = @intCast(self.options.idle_timeout_ms);
        var expired: [16]pq.Conn = undefined;
        while (true) {
            var n: usize = 0;
            self.mutex.lock();
            const now = pq.nowMs();
            var next_check: i64 = timeout;
            // Expired connections stay counted in `total` until closed (and
            // reported), so `deinit` waits for them.
            var counted = self.total;
            var i: usize = 0;
            while (timeout > 0 and i < self.idle.items.len) {
                const age = now - self.idle.items[i].since_ms;
                if (age >= timeout and counted > self.options.min and n < expired.len) {
                    expired[n] = self.idle.orderedRemove(i).conn;
                    n += 1;
                    counted -= 1;
                    continue;
                }
                next_check = @min(next_check, timeout - age);
                i += 1;
            }
            self.mutex.unlock();
            // Quick: PQfinish sends Terminate and closes the socket.
            for (expired[0..n]) |*conn| {
                self.reportIfDead(conn);
                conn.deinit();
            }
            self.mutex.lock();
            if (n > 0) {
                self.total -= @intCast(n);
                self.wakeOne();
                self.drained.broadcast();
            }
            const more = n == expired.len;
            if (!more and !self.closed) {
                if (self.options.idle_check_ms > 0 and self.idle.items.len == 0) {
                    self.reap_timer = 0;
                } else {
                    // Out of memory leaves the pool without a reaper (as a
                    // failed thread spawn would): idle connections then stay
                    // open (with the sweep, until the next release re-arms).
                    self.reap_timer = self.timers.?.schedule(self.nextTick(if (timeout > 0) next_check else null), self, reapTick) catch 0;
                }
            }
            self.mutex.unlock();
            if (!more) return;
        }
    }

    fn reapLoop(self: *Pool) void {
        const timeout: i64 = @intCast(self.options.idle_timeout_ms);
        self.mutex.lock();
        defer self.mutex.unlock();
        while (!self.closed) {
            if (self.options.idle_check_ms > 0) {
                self.mutex.unlock();
                self.sweep();
                self.mutex.lock();
                if (self.closed) break;
            }
            const now = pq.nowMs();
            var next_check: i64 = timeout;
            var i: usize = 0;
            while (timeout > 0 and i < self.idle.items.len) {
                const age = now - self.idle.items[i].since_ms;
                if (age >= timeout and self.total > self.options.min) {
                    var conn = self.idle.orderedRemove(i).conn;
                    self.total -= 1;
                    self.drained.broadcast();
                    self.mutex.unlock();
                    self.reportIfDead(&conn);
                    conn.deinit();
                    self.mutex.lock();
                    continue;
                }
                next_check = @min(next_check, timeout - age);
                i += 1;
            }
            if (self.options.idle_check_ms > 0 and self.idle.items.len == 0) {
                // Nothing to sweep or reap until a release (`putBack`) or `end`.
                self.reaper_cond.wait(&self.mutex);
                continue;
            }
            const wait_ms = self.nextTick(if (timeout > 0) next_check else null);
            self.reaper_cond.timedWait(&self.mutex, wait_ms * std.time.ns_per_ms) catch {};
        }
    }
};

test "hand-off: own loop first within the bound, FIFO otherwise, threads never passed over" {
    const p = try Pool.init(std.testing.allocator, .{ .conn = .{ .conninfo = "postgresql://unused" }, .idle_timeout_ms = 0 });
    defer p.deinit();
    var loop_a: u8 = 0;
    var loop_b: u8 = 0;
    // A fixed clock: the bound is judged against `now`, never the wall
    // clock, so a slow or preempted run cannot age a waiter past it.
    const now: i128 = 1_000 * std.time.ns_per_s;
    const Q = struct {
        fn set(pool: *Pool, ws: []Waiter) void {
            pool.head = null;
            pool.tail = null;
            for (ws) |*w| {
                w.next = null;
                if (pool.tail) |t| t.next = w else pool.head = w;
                pool.tail = w;
            }
        }
    };
    p.mutex.lock();
    defer p.mutex.unlock();
    // b (oldest, fresh), a, a: the first waiter of loop a goes first.
    var ws = [_]Waiter{ .{ .loop = &loop_b, .queued_ns = now }, .{ .loop = &loop_a, .queued_ns = now }, .{ .loop = &loop_a, .queued_ns = now } };
    Q.set(p, &ws);
    try std.testing.expectEqual(&ws[1], p.handoffWaiter(&loop_a, now).?);
    try std.testing.expectEqual(&ws[0], p.head.?);
    try std.testing.expectEqual(&ws[2], p.head.?.next.?);
    try std.testing.expectEqual(&ws[2], p.tail.?);
    // The last waiter can be taken too (tail fix-up).
    try std.testing.expectEqual(&ws[2], p.handoffWaiter(&loop_a, now).?);
    try std.testing.expectEqual(&ws[0], p.tail.?);
    // No waiter of the connection's loop: FIFO.
    try std.testing.expectEqual(&ws[0], p.handoffWaiter(&loop_a, now).?);
    try std.testing.expect(p.head == null and p.tail == null);
    // The oldest waited past the bound: FIFO. Just inside it: own loop.
    const bound: i128 = @as(i128, p.options.affinity_bound_ms) * std.time.ns_per_ms;
    var inside = [_]Waiter{ .{ .loop = &loop_b, .queued_ns = now - bound + 1 }, .{ .loop = &loop_a, .queued_ns = now } };
    Q.set(p, &inside);
    try std.testing.expectEqual(&inside[1], p.handoffWaiter(&loop_a, now).?);
    var starved = [_]Waiter{ .{ .loop = &loop_b, .queued_ns = now - bound }, .{ .loop = &loop_a, .queued_ns = now } };
    Q.set(p, &starved);
    try std.testing.expectEqual(&starved[0], p.handoffWaiter(&loop_a, now).?);
    // A thread waiter is never passed over, at the head or further back.
    var threads = [_]Waiter{ .{ .loop = &loop_b, .queued_ns = now }, .{ .loop = null }, .{ .loop = &loop_a, .queued_ns = now } };
    Q.set(p, &threads);
    try std.testing.expectEqual(&threads[0], p.handoffWaiter(&loop_a, now).?);
    try std.testing.expectEqual(&threads[1], p.handoffWaiter(&loop_a, now).?);
    // A connection no fiber waited on (no home), or one loop only: FIFO.
    var one = [_]Waiter{ .{ .loop = &loop_a, .queued_ns = now }, .{ .loop = &loop_a, .queued_ns = now } };
    Q.set(p, &one);
    try std.testing.expectEqual(&one[0], p.handoffWaiter(null, now).?);
    try std.testing.expectEqual(&one[1], p.handoffWaiter(&loop_a, now).?);
}
