//! Ports `notification-worker.test.ts`.
const std = @import("std");
const testing = std.testing;
const runtime = @import("runtime.zig");
const NotificationWorker = @import("notification_worker.zig").NotificationWorker;

pub const TestLoop = struct {
    fake: runtime.FakeScheduler,
    pool: runtime.Pool,
    loop: runtime.Loop,

    pub fn init(self: *TestLoop) void {
        self.fake = .init(testing.allocator);
        self.pool = .init(testing.allocator);
        self.pool.min_idle = 0;
        self.loop = .{
            .allocator = testing.allocator,
            .pool = &self.pool,
            .scheduler = self.fake.scheduler(),
            .clock = self.fake.clock(),
        };
    }

    pub fn deinit(self: *TestLoop) void {
        self.pool.deinit();
        self.fake.deinit();
    }
};

const Fixture = struct {
    t: *TestLoop,
    worker: NotificationWorker = undefined,
    calls: usize = 0,
    blocked: runtime.Gate = .{},
    mode: enum { block_first, fail_first, schedule_then_block } = .block_first,
    failures: usize = 0,

    fn drain(ptr: *anyopaque) anyerror!void {
        const self: *Fixture = @ptrCast(@alignCast(ptr));
        self.calls += 1;
        switch (self.mode) {
            .block_first => if (self.calls == 1) self.blocked.wait(&self.t.loop),
            .fail_first => if (self.calls == 1) return error.DatabaseUnavailable,
            .schedule_then_block => if (self.calls == 1) {
                self.worker.schedule();
                self.blocked.wait(&self.t.loop);
            },
        }
    }

    fn fail(ptr: *anyopaque, err: anyerror) void {
        const self: *Fixture = @ptrCast(@alignCast(ptr));
        self.failures += 1;
        if (self.mode != .fail_first) @panic("unexpected drain failure");
        std.debug.assert(err == error.DatabaseUnavailable);
        self.worker.scheduleAfter(50);
    }

    fn callCount(self: *Fixture) usize {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        return self.calls;
    }

    fn flushTask(self: *Fixture) void {
        self.worker.flush();
    }

    fn flushNow(self: *Fixture) void {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        self.worker.flush();
    }

    fn settle() void {
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }
};

fn callsAtLeast(comptime n: usize) fn (*Fixture) bool {
    return struct {
        fn check(f: *Fixture) bool {
            return f.calls >= n;
        }
    }.check;
}

fn setup(t: *TestLoop, f: *Fixture) void {
    f.worker = NotificationWorker.init(&t.loop, 10, f, Fixture.drain, Fixture.fail);
}

test "coalesces notifications and flushes without overlapping an active drain" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    var f: Fixture = .{ .t = &t };
    setup(&t, &f);
    defer {
        t.loop.lock();
        f.worker.stop();
        t.loop.unlock();
    }

    t.loop.lock();
    f.worker.schedule();
    f.worker.schedule();
    t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), t.fake.pending());
    t.fake.tick(9);
    Fixture.settle();
    try testing.expectEqual(@as(usize, 0), f.callCount());
    t.fake.tick(1);
    try runtime.until(&t.loop, &f, callsAtLeast(1));
    // A second flush joins the active drain instead of starting another.
    t.loop.spawn(Fixture.flushTask, .{&f});
    t.loop.lock();
    f.worker.schedule();
    t.loop.unlock();
    t.fake.tick(100);
    Fixture.settle();
    try testing.expectEqual(@as(usize, 1), f.callCount());
    f.blocked.release(&t.loop);
    // The schedule() during the drain re-arms the timer once it finishes.
    for (0..1000) |_| {
        if (t.fake.pending() == 1) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expectEqual(@as(usize, 1), t.fake.pending());
    t.fake.tick(10);
    // TS awaits this timer's still-pending drain via flush(); the task runs it here.
    try runtime.until(&t.loop, &f, callsAtLeast(2));
    Fixture.settle();
    try testing.expectEqual(@as(usize, 2), f.callCount());

    t.loop.lock();
    f.worker.schedule();
    f.worker.stop();
    t.loop.unlock();
    t.fake.tick(100);
    f.flushNow();
    Fixture.settle();
    try testing.expectEqual(@as(usize, 2), f.callCount());
}

test "lets a failed drain request a delayed retry" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    var f: Fixture = .{ .t = &t, .mode = .fail_first };
    setup(&t, &f);
    defer {
        t.loop.lock();
        f.worker.stop();
        t.loop.unlock();
    }
    f.flushNow();
    try testing.expectEqual(@as(usize, 1), f.failures);
    t.fake.tick(49);
    Fixture.settle();
    try testing.expectEqual(@as(usize, 1), f.callCount());
    t.fake.tick(1);
    try runtime.until(&t.loop, &f, callsAtLeast(2));
    // TS awaits the timer's still-pending drain here; the task already ran it.
    Fixture.settle();
    try testing.expectEqual(@as(usize, 2), f.callCount());
}

test "keeps scheduling when a drain schedules before its first await" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    var f: Fixture = .{ .t = &t, .mode = .schedule_then_block };
    setup(&t, &f);
    defer {
        t.loop.lock();
        f.worker.stop();
        t.loop.unlock();
    }
    t.loop.spawn(Fixture.flushTask, .{&f});
    try runtime.until(&t.loop, &f, callsAtLeast(1));
    t.fake.tick(10);
    Fixture.settle();
    try testing.expectEqual(@as(usize, 1), f.callCount());
    f.blocked.release(&t.loop);
    for (0..1000) |_| {
        if (t.fake.pending() == 1) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    t.fake.tick(10);
    try runtime.until(&t.loop, &f, callsAtLeast(2));
    try testing.expectEqual(@as(usize, 2), f.callCount());
}
