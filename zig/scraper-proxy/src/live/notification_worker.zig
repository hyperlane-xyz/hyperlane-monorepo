//! Port of `notification-worker.ts`: coalesce wakeups and serialize a drain,
//! including explicit flushes. All methods require the loop mutex.
const std = @import("std");
const runtime = @import("runtime.zig");
const Loop = runtime.Loop;

pub const NotificationWorker = struct {
    loop: *Loop,
    batch_ms: u64,
    ctx: *anyopaque,
    drainFn: *const fn (ctx: *anyopaque) anyerror!void,
    failFn: *const fn (ctx: *anyopaque, err: anyerror) void,
    timer: ?u64 = null,
    running: bool = false,
    /// Incremented when a drain finishes; flush() callers wait on it.
    generation: u64 = 0,
    finished: std.Thread.Condition = .{},
    next_delay: ?u64 = null,
    stopped: bool = false,

    pub fn init(
        loop: *Loop,
        batch_ms: u64,
        ctx: *anyopaque,
        drainFn: *const fn (ctx: *anyopaque) anyerror!void,
        failFn: *const fn (ctx: *anyopaque, err: anyerror) void,
    ) NotificationWorker {
        return .{ .loop = loop, .batch_ms = batch_ms, .ctx = ctx, .drainFn = drainFn, .failFn = failFn };
    }

    pub fn schedule(self: *NotificationWorker) void {
        self.scheduleAfter(self.batch_ms);
    }

    pub fn scheduleAfter(self: *NotificationWorker, delay: u64) void {
        if (self.stopped or self.timer != null) return;
        self.next_delay = delay;
        if (self.running) return;
        self.timer = self.loop.scheduler.schedule(delay, self, onTimer);
    }

    fn onTimer(ptr: *anyopaque, id: u64) void {
        const self: *NotificationWorker = @ptrCast(@alignCast(ptr));
        self.loop.spawn(fired, .{ self, id });
    }

    fn fired(self: *NotificationWorker, id: u64) void {
        // A flush() or stop() between firing and this task cleared the timer;
        // in Node that clearTimeout would have prevented the callback.
        if (self.timer != id) return;
        self.timer = null;
        self.flush();
    }

    /// Runs the drain on the calling thread, or waits for the active one.
    pub fn flush(self: *NotificationWorker) void {
        if (self.stopped) return;
        if (self.timer) |id| self.loop.scheduler.cancel(id);
        self.timer = null;
        if (self.running) {
            const generation = self.generation;
            while (self.generation == generation) self.loop.wait(&self.finished);
            return;
        }
        self.next_delay = null;
        self.running = true;
        self.drainFn(self.ctx) catch |err| self.failFn(self.ctx, err);
        self.running = false;
        self.generation +%= 1;
        self.finished.broadcast();
        if (self.next_delay) |delay| self.scheduleAfter(delay);
    }

    pub fn stop(self: *NotificationWorker) void {
        self.stopped = true;
        if (self.timer) |id| self.loop.scheduler.cancel(id);
        self.timer = null;
    }
};
