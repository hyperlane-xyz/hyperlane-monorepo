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
