//! Runtime regression tests (thread pool and scheduler lifecycles).
const std = @import("std");
const testing = std.testing;
const runtime = @import("runtime.zig");
const core = @import("core");

fn discard(_: ?*anyopaque, _: core.log.Level, _: []const u8, _: []const u8) void {}

const Counter = struct {
    job: runtime.Pool.Job = .{ .run = run },
    done: *std.atomic.Value(usize),

    fn run(job: *runtime.Pool.Job) void {
        const self: *Counter = @alignCast(@fieldParentPtr("job", job));
        _ = self.done.fetchAdd(1, .seq_cst);
    }
};

test "a failed task-thread spawn queues the job for a running worker" {
    var pool = runtime.Pool.init(testing.allocator);
    pool.min_idle = 0;
    try pool.start(1);
    pool.fail_spawns = true;
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    var done = std.atomic.Value(usize).init(0);
    var jobs: [8]Counter = undefined;
    for (&jobs) |*job| {
        job.* = .{ .done = &done };
        pool.submit(&job.job);
    }
    for (0..5000) |_| {
        if (done.load(.seq_cst) == jobs.len) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expectEqual(jobs.len, done.load(.seq_cst));
    pool.mutex.lock();
    try testing.expectEqual(@as(usize, 1), pool.threads);
    pool.mutex.unlock();
    pool.deinit();
}

test "reserve workers do not exit when idle" {
    var pool = runtime.Pool.init(testing.allocator);
    pool.min_idle = 0;
    pool.idle_ms = 1;
    try pool.start(1);
    std.Thread.sleep(20 * std.time.ns_per_ms);
    pool.mutex.lock();
    try testing.expectEqual(@as(usize, 1), pool.threads);
    pool.mutex.unlock();
    pool.deinit();
}

const TimerSpawn = struct {
    loop: *runtime.Loop,
    ran: std.atomic.Value(usize) = .init(0),

    fn fire(ctx: *anyopaque, _: u64) void {
        const self: *TimerSpawn = @ptrCast(@alignCast(ctx));
        // Like NotificationWorker.onTimer: runs without the loop mutex and spawns.
        self.loop.spawn(task, .{self});
    }

    fn task(self: *TimerSpawn) void {
        _ = self.ran.fetchAdd(1, .seq_cst);
    }
};

test "scheduler-before-pool teardown never submits to a dead pool" {
    for (0..50) |_| {
        var pool = runtime.Pool.init(testing.allocator);
        pool.min_idle = 0;
        try pool.start(1);
        var timer_thread = core.scheduler.Scheduler.init(testing.allocator);
        try timer_thread.start();
        defer timer_thread.deinit();
        var scheduler = runtime.SharedScheduler.init(testing.allocator, &timer_thread);
        var loop: runtime.Loop = .{ .allocator = testing.allocator, .pool = &pool, .scheduler = scheduler.scheduler() };
        var timers: TimerSpawn = .{ .loop = &loop };
        for (0..4) |_| _ = loop.scheduler.schedule(0, &timers, TimerSpawn.fire);
        // EventWebSocketServer.deinit order: a fired timer may still spawn until
        // the scheduler's timers are cancelled and drained; the pool then runs it.
        scheduler.deinit();
        pool.deinit();
        loop.deinit();
        try testing.expect(timers.ran.load(.seq_cst) <= 4);
    }
}

test "shared scheduler fires and cancels timers" {
    var timer_thread = core.scheduler.Scheduler.init(testing.allocator);
    try timer_thread.start();
    defer timer_thread.deinit();
    var scheduler = runtime.SharedScheduler.init(testing.allocator, &timer_thread);
    defer scheduler.deinit();
    const Flag = struct {
        hits: std.atomic.Value(usize) = .init(0),
        fn fire(ctx: *anyopaque, _: u64) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            _ = self.hits.fetchAdd(1, .seq_cst);
        }
    };
    var flag: Flag = .{};
    const api = scheduler.scheduler();
    const cancelled = api.schedule(50, &flag, Flag.fire);
    _ = api.schedule(5, &flag, Flag.fire);
    api.cancel(cancelled);
    for (0..2000) |_| {
        if (flag.hits.load(.seq_cst) > 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    std.Thread.sleep(80 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 1), flag.hits.load(.seq_cst));
}

test "timers whose deadline already passed fire immediately (late timer thread start)" {
    var timer_thread = core.scheduler.Scheduler.init(testing.allocator);
    defer timer_thread.deinit();
    var scheduler = runtime.SharedScheduler.init(testing.allocator, &timer_thread);
    defer scheduler.deinit();
    const Flag = struct {
        hits: std.atomic.Value(usize) = .init(0),
        fn fire(ctx: *anyopaque, _: u64) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            _ = self.hits.fetchAdd(1, .seq_cst);
        }
    };
    var flag: Flag = .{};
    const api = scheduler.scheduler();
    _ = api.schedule(0, &flag, Flag.fire);
    _ = api.schedule(1, &flag, Flag.fire);
    _ = api.schedule(5, &flag, Flag.fire);
    std.Thread.sleep(30 * std.time.ns_per_ms); // every deadline is now in the past
    try timer_thread.start();
    for (0..2000) |_| {
        if (flag.hits.load(.seq_cst) == 3) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expectEqual(@as(usize, 3), flag.hits.load(.seq_cst));
}

test "cancel never waits on a firing callback and frees each slot once" {
    var timer_thread = core.scheduler.Scheduler.init(testing.allocator);
    try timer_thread.start();
    defer timer_thread.deinit();
    var scheduler = runtime.SharedScheduler.init(testing.allocator, &timer_thread);
    defer scheduler.deinit();
    const Flag = struct {
        hits: std.atomic.Value(usize) = .init(0),
        fn fire(ctx: *anyopaque, _: u64) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            _ = self.hits.fetchAdd(1, .seq_cst);
        }
    };
    var flag: Flag = .{};
    const api = scheduler.scheduler();
    // Race cancels against firing; testing.allocator catches leaks/double frees.
    for (0..500) |i| {
        const id = api.schedule(0, &flag, Flag.fire);
        if (i % 3 != 0) api.cancel(id);
    }
    for (0..2000) |_| {
        if (timer_thread.pending() == 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    timer_thread.quiesce();
    try testing.expect(flag.hits.load(.seq_cst) >= 167);
}

test "tasks take the loop mutex in spawn order" {
    var pool = runtime.Pool.init(testing.allocator);
    try pool.start(1);
    var timer_thread = core.scheduler.Scheduler.init(testing.allocator);
    defer timer_thread.deinit();
    var scheduler = runtime.SharedScheduler.init(testing.allocator, &timer_thread);
    defer scheduler.deinit();
    var loop: runtime.Loop = .{ .allocator = testing.allocator, .pool = &pool, .scheduler = scheduler.scheduler() };
    const Order = struct {
        seen: [64]u8 = undefined,
        len: usize = 0,
        fn task(self: *@This(), index: u8) void {
            self.seen[self.len] = index;
            self.len += 1;
        }
        fn done(self: *const @This()) bool {
            return self.len == 64;
        }
    };
    var order: Order = .{};
    loop.lock();
    for (0..64) |i| loop.spawn(Order.task, .{ &order, @as(u8, @intCast(i)) });
    loop.unlock();
    // Ordering, not speed, is under test: wait generously (64 thread
    // hand-offs can be slow on a loaded machine).
    for (0..30_000) |_| {
        loop.lock();
        const finished = order.done();
        loop.unlock();
        if (finished) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    pool.deinit();
    loop.deinit();
    for (order.seen, 0..) |index, i| try testing.expectEqual(@as(u8, @intCast(i)), index);
}

test "yieldTurn: a thread already blocked in lock takes the mutex before the caller resumes; nothing waiting returns at once" {
    var pool = runtime.Pool.init(testing.allocator);
    defer pool.deinit();
    var fake = runtime.FakeScheduler.init(testing.allocator);
    defer fake.deinit();
    var loop: runtime.Loop = .{ .allocator = testing.allocator, .pool = &pool, .scheduler = fake.scheduler() };
    defer loop.deinit();
    // Nothing waiting: no deadlock, the caller continues.
    loop.lock();
    loop.yieldTurn();
    loop.unlock();
    const Reader = struct {
        fn run(l: *runtime.Loop, order: *[2]u8, n: *usize) void {
            l.lock();
            order[n.*] = 'r';
            n.* += 1;
            l.unlock();
        }
    };
    // `unlock` + `lock` lets the caller win the non-FIFO mutex straight back
    // (in practice nearly every time): over 50 rounds it would fail.
    for (0..50) |_| {
        var order: [2]u8 = undefined;
        var n: usize = 0;
        loop.lock();
        const reader = try std.Thread.spawn(.{}, Reader.run, .{ &loop, &order, &n });
        var spins: usize = 0;
        while (loop.lock_waiters.load(.acquire) == 0) : (spins += 1) {
            if (spins == 10_000) return error.Timeout;
            std.Thread.sleep(10 * std.time.ns_per_us);
        }
        loop.yieldTurn();
        order[n] = 'y';
        n += 1;
        loop.unlock();
        reader.join();
        try testing.expectEqualStrings("ry", &order);
    }
}

test "yieldTurn: a task spawned under the mutex off the pool runs before the caller resumes" {
    var pool = runtime.Pool.init(testing.allocator);
    var fake = runtime.FakeScheduler.init(testing.allocator);
    var loop: runtime.Loop = .{ .allocator = testing.allocator, .pool = &pool, .scheduler = fake.scheduler() };
    // The pool first: its workers (a task still to run) finish before the loop goes.
    defer {
        pool.deinit();
        loop.deinit();
        fake.deinit();
    }
    const Task = struct {
        fn run(ran: *bool) void {
            ran.* = true;
        }
    };
    // Spawned with the mutex held, the task cannot have started: without
    // waiting for spawned tasks the caller would resume first.
    for (0..50) |_| {
        var ran = false;
        loop.lock();
        loop.spawn(Task.run, .{&ran});
        loop.yieldTurn();
        const seen = ran;
        loop.unlock();
        try testing.expect(seen);
    }
}

const YieldOrder = struct {
    loop: *runtime.Loop,
    /// Task ids in the order they ran (loop mutex held).
    order: std.ArrayList(u8) = .empty,
    done: std.Thread.ResetEvent = .{},

    fn yielder(self: *YieldOrder) void {
        self.order.append(testing.allocator, 'a') catch unreachable;
        // Queued before the yield: it must run during it.
        self.loop.spawn(other, .{self});
        self.loop.yieldTurn();
        self.order.append(testing.allocator, 'c') catch unreachable;
        self.done.set();
    }

    fn other(self: *YieldOrder) void {
        self.order.append(testing.allocator, 'b') catch unreachable;
    }
};

test "yieldTurn: a task spawned before the yield runs during it" {
    var timer_thread = core.scheduler.Scheduler.init(testing.allocator);
    defer timer_thread.deinit();
    var scheduler = runtime.SharedScheduler.init(testing.allocator, &timer_thread);
    defer scheduler.deinit();
    for (0..200) |_| {
        var pool = runtime.Pool.init(testing.allocator);
        try pool.start(2);
        var loop: runtime.Loop = .{ .allocator = testing.allocator, .pool = &pool, .scheduler = scheduler.scheduler() };
        var state: YieldOrder = .{ .loop = &loop };
        defer state.order.deinit(testing.allocator);
        loop.lock();
        loop.spawn(YieldOrder.yielder, .{&state});
        loop.unlock();
        state.done.wait();
        // Read under the mutex, checked after teardown (a failed check leaves no worker behind).
        loop.lock();
        var seen: [3]u8 = @splat(0);
        const len = @min(seen.len, state.order.items.len);
        @memcpy(seen[0..len], state.order.items[0..len]);
        const n = state.order.items.len;
        loop.unlock();
        pool.deinit();
        loop.deinit();
        try testing.expectEqual(@as(usize, 3), n);
        try testing.expectEqualStrings("abc", &seen);
    }
}
