//! One timer thread for the whole process: every module's one-shot and
//! periodic timers share it instead of owning an idle thread each.
//!
//! Deadlines use CLOCK_MONOTONIC (wall-clock steps never delay or fire a
//! timer, like Node timers); equal deadlines fire in scheduling order.
//! Callbacks run on the timer thread with no scheduler lock held and must be
//! short: log, close an idle connection, or hand work to another thread.
//! Teardown is `cancel(id)` per timer: when it returns the timer will not
//! start again and is not running, so its context can be freed.
const std = @import("std");

pub const Callback = *const fn (ctx: *anyopaque, id: u64) void;

pub const Error = error{OutOfMemory};

pub const Scheduler = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    /// Wakes the timer thread (earlier deadline, stop).
    wake: std.Thread.Condition = .{},
    /// Broadcast after every callback (`cancel` of a running timer, `quiesce`).
    done: std.Thread.Condition = .{},
    /// Sorted by deadline; insertion keeps scheduling order among ties.
    timers: std.ArrayList(Entry) = .empty,
    next_id: u64 = 1,
    /// The timer whose callback is running (0: none).
    running: u64 = 0,
    /// `cancel` was called for `running`: do not re-arm it.
    running_cancelled: bool = false,
    stopping: bool = false,
    thread: ?std.Thread = null,
    thread_id: ?std.Thread.Id = null,

    const Entry = struct {
        id: u64,
        deadline: i128,
        /// 0 for one-shot timers.
        period_ns: i128,
        ctx: *anyopaque,
        callback: Callback,
    };

    pub fn init(allocator: std.mem.Allocator) Scheduler {
        return .{ .allocator = allocator };
    }

    pub fn start(self: *Scheduler) !void {
        std.debug.assert(self.thread == null);
        self.thread = try std.Thread.spawn(.{ .stack_size = 256 * 1024 }, run, .{self});
        self.thread.?.setName("timers") catch {};
    }

    /// Stops the thread (a running callback finishes first); pending timers are dropped.
    pub fn deinit(self: *Scheduler) void {
        self.mutex.lock();
        self.stopping = true;
        self.wake.signal();
        self.mutex.unlock();
        if (self.thread) |thread| thread.join();
        self.thread = null;
        self.timers.deinit(self.allocator);
    }

    /// One-shot timer; returns its id (never 0).
    pub fn schedule(self: *Scheduler, delay_ms: u64, ctx: *anyopaque, callback: Callback) Error!u64 {
        return self.add(delay_ms, 0, ctx, callback);
    }

    /// Periodic timer: fires every `period_ms`, each deadline computed from
    /// the previous one (a late callback does not shift the phase; missed
    /// periods are skipped, not replayed).
    pub fn every(self: *Scheduler, period_ms: u64, ctx: *anyopaque, callback: Callback) Error!u64 {
        std.debug.assert(period_ms > 0);
        return self.add(period_ms, period_ms, ctx, callback);
    }

    fn add(self: *Scheduler, delay_ms: u64, period_ms: u64, ctx: *anyopaque, callback: Callback) Error!u64 {
        const deadline = monotonicNs() + @as(i128, delay_ms) * std.time.ns_per_ms;
        self.mutex.lock();
        defer self.mutex.unlock();
        const id = self.next_id;
        try self.insert(.{ .id = id, .deadline = deadline, .period_ns = @as(i128, period_ms) * std.time.ns_per_ms, .ctx = ctx, .callback = callback });
        self.next_id += 1;
        return id;
    }

    /// Mutex held.
    fn insert(self: *Scheduler, entry: Entry) Error!void {
        var index = self.timers.items.len;
        while (index > 0 and self.timers.items[index - 1].deadline > entry.deadline) index -= 1;
        try self.timers.insert(self.allocator, index, entry);
        if (index == 0) self.wake.signal();
    }

    /// After this returns the timer will not start again and its callback is
    /// not running (from inside its own callback: it just won't re-arm).
    /// Returns false if the timer had already finished or is unknown.
    pub fn cancel(self: *Scheduler, id: u64) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.timers.items, 0..) |entry, index| {
            if (entry.id != id) continue;
            _ = self.timers.orderedRemove(index);
            return true;
        }
        if (self.running != id) return false;
        self.running_cancelled = true;
        if (self.thread_id != std.Thread.getCurrentId()) {
            while (self.running == id) self.done.wait(&self.mutex);
        }
        return true;
    }

    /// Returns once no callback is running. Never call from a callback.
    pub fn quiesce(self: *Scheduler) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        std.debug.assert(self.thread_id != std.Thread.getCurrentId());
        while (self.running != 0) self.done.wait(&self.mutex);
    }

    /// Pending timers (tests).
    pub fn pending(self: *Scheduler) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.timers.items.len;
    }

    fn run(self: *Scheduler) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.thread_id = std.Thread.getCurrentId();
        while (!self.stopping) {
            if (self.timers.items.len == 0) {
                self.wake.wait(&self.mutex);
                continue;
            }
            const first = self.timers.items[0];
            const now = monotonicNs();
            if (first.deadline > now) {
                self.wake.timedWait(&self.mutex, @intCast(first.deadline - now)) catch {};
                continue;
            }
            _ = self.timers.orderedRemove(0);
            self.running = first.id;
            self.running_cancelled = false;
            self.mutex.unlock();
            first.callback(first.ctx, first.id);
            self.mutex.lock();
            if (first.period_ns > 0 and !self.running_cancelled and !self.stopping) {
                var next = first;
                next.deadline += first.period_ns;
                const after = monotonicNs();
                if (next.deadline <= after) {
                    // Skip missed periods but keep the phase.
                    const missed = @divFloor(after - next.deadline, first.period_ns) + 1;
                    next.deadline += missed * first.period_ns;
                }
                // Out of memory cannot happen here: the entry's slot was just freed.
                self.insert(next) catch unreachable;
            }
            self.running = 0;
            self.done.broadcast();
        }
    }
};

var global_instance: ?*Scheduler = null;

/// The process scheduler; `main` sets it before starting any module.
pub fn global() *Scheduler {
    return global_instance orelse @panic("core.scheduler: global scheduler not set");
}

/// The process scheduler if one is set (code that also runs without `main`,
/// e.g. module tests, falls back to its own thread when null).
pub fn current() ?*Scheduler {
    return global_instance;
}

pub fn setGlobal(scheduler: ?*Scheduler) void {
    global_instance = scheduler;
}

fn monotonicNs() i128 {
    const ts = std.posix.clock_gettime(std.posix.CLOCK.MONOTONIC) catch unreachable;
    return @as(i128, ts.sec) * std.time.ns_per_s + ts.nsec;
}

const testing = std.testing;

const TestLog = struct {
    mutex: std.Thread.Mutex = .{},
    order: [64]u8 = undefined,
    len: usize = 0,

    fn push(self: *TestLog, tag: u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.len < self.order.len) self.order[self.len] = tag;
        self.len += 1;
    }

    fn count(self: *TestLog) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.len;
    }
};

const TestCtx = struct {
    log: *TestLog,
    tag: u8,
    sleep_ms: u64 = 0,
    scheduler: ?*Scheduler = null,

    fn fire(ptr: *anyopaque, id: u64) void {
        const ctx: *TestCtx = @ptrCast(@alignCast(ptr));
        ctx.log.push(ctx.tag);
        if (ctx.sleep_ms > 0) std.Thread.sleep(ctx.sleep_ms * std.time.ns_per_ms);
        // Self-cancel from inside the callback must not deadlock.
        if (ctx.scheduler) |s| _ = s.cancel(id);
    }
};

fn waitFor(log: *TestLog, n: usize) !void {
    for (0..400) |_| {
        if (log.count() >= n) return;
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return error.Timeout;
}

test "one-shot timers fire in deadline order, FIFO on ties; cancel removes" {
    var scheduler = Scheduler.init(testing.allocator);
    defer scheduler.deinit();
    try scheduler.start();
    var log: TestLog = .{};
    var a: TestCtx = .{ .log = &log, .tag = 'a' };
    var b: TestCtx = .{ .log = &log, .tag = 'b' };
    var c: TestCtx = .{ .log = &log, .tag = 'c' };
    var d: TestCtx = .{ .log = &log, .tag = 'd' };
    _ = try scheduler.schedule(30, &c, TestCtx.fire);
    _ = try scheduler.schedule(10, &a, TestCtx.fire);
    _ = try scheduler.schedule(10, &b, TestCtx.fire);
    const cancelled = try scheduler.schedule(20, &d, TestCtx.fire);
    try testing.expect(scheduler.cancel(cancelled));
    try testing.expect(!scheduler.cancel(cancelled));
    try waitFor(&log, 3);
    scheduler.quiesce();
    try testing.expectEqualStrings("abc", log.order[0..log.len]);
    try testing.expectEqual(@as(usize, 0), scheduler.pending());
}

test "periodic timer repeats until cancelled; cancel waits for a running callback" {
    var scheduler = Scheduler.init(testing.allocator);
    defer scheduler.deinit();
    try scheduler.start();
    var log: TestLog = .{};
    var p: TestCtx = .{ .log = &log, .tag = 'p', .sleep_ms = 20 };
    const id = try scheduler.every(5, &p, TestCtx.fire);
    try waitFor(&log, 3);
    try testing.expect(scheduler.cancel(id));
    // Not running and never again once cancel returned.
    const after = log.count();
    std.Thread.sleep(60 * std.time.ns_per_ms);
    try testing.expectEqual(after, log.count());
    try testing.expectEqual(@as(usize, 0), scheduler.pending());
}

test "a periodic callback can cancel itself" {
    var scheduler = Scheduler.init(testing.allocator);
    defer scheduler.deinit();
    try scheduler.start();
    var log: TestLog = .{};
    var p: TestCtx = .{ .log = &log, .tag = 's', .scheduler = &scheduler };
    _ = try scheduler.every(5, &p, TestCtx.fire);
    try waitFor(&log, 1);
    std.Thread.sleep(40 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 1), log.count());
    try testing.expectEqual(@as(usize, 0), scheduler.pending());
}
