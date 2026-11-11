//! Event-loop emulation for the live module.
//!
//! All live state is guarded by `Loop.mutex`, which plays the role of the
//! Node.js event loop: code runs with the mutex held, and every TS `await`
//! becomes "release the mutex, block, reacquire" (`Loop.wait` on a
//! condition, or `Loop.unlocked` around blocking I/O). Continuations that TS
//! starts with `void promise()` run as tasks on an elastic thread pool, which
//! never queues a task behind a blocked one (tasks block on DB reads and send
//! completions, so a fixed-size pool could deadlock).
const std = @import("std");
const core = @import("core");

pub const Clock = struct {
    ptr: ?*anyopaque = null,
    nowFn: *const fn (?*anyopaque) i64 = systemNow,

    pub fn now(self: Clock) i64 {
        return self.nowFn(self.ptr);
    }

    fn systemNow(_: ?*anyopaque) i64 {
        return std.time.milliTimestamp();
    }
};

pub const TimerCallback = *const fn (ctx: *anyopaque, id: u64) void;

/// One-shot timers. Callbacks run on the scheduler's thread without the loop
/// mutex held and without any scheduler lock held.
pub const Scheduler = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        schedule: *const fn (ptr: *anyopaque, delay_ms: u64, ctx: *anyopaque, callback: TimerCallback) u64,
        cancel: *const fn (ptr: *anyopaque, id: u64) void,
    };

    pub fn schedule(self: Scheduler, delay_ms: u64, ctx: *anyopaque, callback: TimerCallback) u64 {
        return self.vtable.schedule(self.ptr, delay_ms, ctx, callback);
    }

    pub fn cancel(self: Scheduler, id: u64) void {
        self.vtable.cancel(self.ptr, id);
    }
};

pub const Loop = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    pool: *Pool,
    scheduler: Scheduler,
    clock: Clock = .{},
    /// Runs with the mutex held just before every release (see `endTurn`).
    turn_end: ?struct { ctx: *anyopaque, func: *const fn (ctx: *anyopaque) void } = null,

    pub fn lock(self: *Loop) void {
        self.mutex.lock();
    }

    pub fn unlock(self: *Loop) void {
        self.endTurn();
        self.mutex.unlock();
    }

    /// `await` on a condition: the mutex must be held.
    pub fn wait(self: *Loop, condition: *std.Thread.Condition) void {
        self.endTurn();
        condition.wait(&self.mutex);
    }

    /// Releasing the mutex ends the emulated event-loop turn: run work that
    /// Node defers past the current synchronous code (write callbacks).
    fn endTurn(self: *Loop) void {
        if (self.turn_end) |hook| hook.func(hook.ctx);
    }

    pub fn now(self: *Loop) i64 {
        return self.clock.now();
    }

    /// Run `func(args...)` on a pool thread with the loop mutex held.
    pub fn spawn(self: *Loop, comptime func: anytype, args: std.meta.ArgsTuple(@TypeOf(func))) void {
        const Args = @TypeOf(args);
        const Closure = struct {
            job: Pool.Job,
            loop: *Loop,
            args: Args,

            fn run(job: *Pool.Job) void {
                const closure: *@This() = @alignCast(@fieldParentPtr("job", job));
                const loop = closure.loop;
                const call_args = closure.args;
                loop.allocator.destroy(closure);
                loop.lock();
                defer loop.unlock();
                @call(.auto, func, call_args);
            }
        };
        const closure = self.allocator.create(Closure) catch {
            // Out of memory: run inline would deadlock (mutex held); abort loudly.
            @panic("live: out of memory spawning task");
        };
        closure.* = .{ .job = .{ .run = Closure.run }, .loop = self, .args = args };
        self.pool.submit(&closure.job);
    }
};

/// Elastic pool: an idle thread takes each job, otherwise a new thread starts.
/// Threads beyond `min_idle` exit after `idle_ms` without work.
pub const Pool = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    condition: std.Thread.Condition = .{},
    drained: std.Thread.Condition = .{},
    queue: std.ArrayList(*Job) = .empty,
    head: usize = 0,
    idle: usize = 0,
    threads: usize = 0,
    stopping: bool = false,
    idle_ms: u64 = 30_000,
    min_idle: usize = 4,
    /// Workers started by `start` never exit before `deinit`, so a failed
    /// spawn under thread/memory pressure can always queue its job.
    reserve: usize = 0,
    stack_size: usize = 1024 * 1024,
    /// Test hook: simulate `std.Thread.spawn` failure.
    fail_spawns: bool = false,

    pub const Job = struct {
        run: *const fn (*Job) void,
    };

    pub fn init(allocator: std.mem.Allocator) Pool {
        return .{ .allocator = allocator };
    }

    /// Waits for every thread to exit; queued jobs still run first.
    pub fn deinit(self: *Pool) void {
        self.mutex.lock();
        self.stopping = true;
        self.condition.broadcast();
        while (self.threads > 0) self.drained.wait(&self.mutex);
        self.queue.deinit(self.allocator);
        self.mutex.unlock();
    }

    /// Starts `reserve` permanent workers (startup fails if it can't).
    pub fn start(self: *Pool, reserve: usize) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        while (self.threads < reserve) {
            const thread = try std.Thread.spawn(.{ .stack_size = self.stack_size }, worker, .{self});
            thread.detach();
            self.threads += 1;
        }
        self.reserve = reserve;
    }

    fn spawnWorker(self: *Pool) !std.Thread {
        if (self.fail_spawns) return error.SystemResources;
        return std.Thread.spawn(.{ .stack_size = self.stack_size }, worker, .{self});
    }

    pub fn submit(self: *Pool, job: *Job) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.queue.append(self.allocator, job) catch @panic("live: out of memory queueing task");
        if (self.queue.items.len - self.head <= self.idle) {
            self.condition.signal();
            return;
        }
        std.debug.assert(!(self.stopping and self.threads == 0)); // submit after deinit
        const thread = self.spawnWorker() catch |err| {
            // Under thread/memory pressure, leave the job queued for a running
            // worker (they block only on DB reads and send completions).
            if (self.threads == 0) @panic("live: cannot spawn task thread");
            core.log.child("EventWebSocketServer").warn("task thread spawn failed ({s}); queued for {d} running workers", .{ @errorName(err), self.threads });
            return;
        };
        thread.detach();
        self.threads += 1;
    }

    fn worker(self: *Pool) void {
        self.mutex.lock();
        while (true) {
            if (self.head < self.queue.items.len) {
                const job = self.queue.items[self.head];
                self.head += 1;
                if (self.head == self.queue.items.len) {
                    self.queue.clearRetainingCapacity();
                    self.head = 0;
                }
                self.mutex.unlock();
                job.run(job);
                self.mutex.lock();
                continue;
            }
            if (self.stopping) break;
            self.idle += 1;
            const timed_out = if (self.condition.timedWait(&self.mutex, self.idle_ms * std.time.ns_per_ms)) |_| false else |_| true;
            self.idle -= 1;
            if (timed_out and self.head == self.queue.items.len and self.idle >= self.min_idle and self.threads > self.reserve) break;
        }
        self.threads -= 1;
        if (self.threads == 0) self.drained.broadcast();
        self.mutex.unlock();
    }
};

/// Node timers are monotonic: wall-clock steps must not delay or fire them.
fn monotonicNs() i128 {
    const ts = std.posix.clock_gettime(std.posix.CLOCK.MONOTONIC) catch unreachable;
    return @as(i128, ts.sec) * std.time.ns_per_s + ts.nsec;
}

/// Real scheduler: one thread and a deadline-ordered list.
pub const ThreadScheduler = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    condition: std.Thread.Condition = .{},
    timers: std.ArrayList(Entry) = .empty,
    next_id: u64 = 1,
    stopping: bool = false,
    thread: ?std.Thread = null,

    const Entry = struct { id: u64, deadline: i128, ctx: *anyopaque, callback: TimerCallback };

    pub fn init(allocator: std.mem.Allocator) ThreadScheduler {
        return .{ .allocator = allocator };
    }

    pub fn start(self: *ThreadScheduler) !void {
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }

    pub fn deinit(self: *ThreadScheduler) void {
        self.mutex.lock();
        self.stopping = true;
        self.condition.signal();
        self.mutex.unlock();
        if (self.thread) |thread| thread.join();
        self.timers.deinit(self.allocator);
    }

    pub fn scheduler(self: *ThreadScheduler) Scheduler {
        return .{ .ptr = self, .vtable = &.{ .schedule = schedule, .cancel = cancel } };
    }

    fn schedule(ptr: *anyopaque, delay_ms: u64, ctx: *anyopaque, callback: TimerCallback) u64 {
        const self: *ThreadScheduler = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        const id = self.next_id;
        self.next_id += 1;
        const deadline = monotonicNs() + @as(i128, delay_ms) * std.time.ns_per_ms;
        // Keep insertion order among equal deadlines, like Node timers.
        var index = self.timers.items.len;
        while (index > 0 and self.timers.items[index - 1].deadline > deadline) index -= 1;
        self.timers.insert(self.allocator, index, .{ .id = id, .deadline = deadline, .ctx = ctx, .callback = callback }) catch
            @panic("live: out of memory scheduling timer");
        self.condition.signal();
        return id;
    }

    fn cancel(ptr: *anyopaque, id: u64) void {
        const self: *ThreadScheduler = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.timers.items, 0..) |entry, index| {
            if (entry.id == id) {
                _ = self.timers.orderedRemove(index);
                return;
            }
        }
    }

    fn run(self: *ThreadScheduler) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        while (!self.stopping) {
            if (self.timers.items.len == 0) {
                self.condition.wait(&self.mutex);
                continue;
            }
            const first = self.timers.items[0];
            const now = monotonicNs();
            if (first.deadline > now) {
                self.condition.timedWait(&self.mutex, @intCast(first.deadline - now)) catch {};
                continue;
            }
            _ = self.timers.orderedRemove(0);
            self.mutex.unlock();
            first.callback(first.ctx, first.id);
            self.mutex.lock();
        }
    }
};

/// Manual-time scheduler and clock for tests (`t.mock.timers`).
pub const FakeScheduler = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    now_ms: i64 = 0,
    next_id: u64 = 1,
    timers: std.ArrayList(Entry) = .empty,

    const Entry = struct { id: u64, deadline: i64, ctx: *anyopaque, callback: TimerCallback };

    pub fn init(allocator: std.mem.Allocator) FakeScheduler {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *FakeScheduler) void {
        self.timers.deinit(self.allocator);
    }

    pub fn scheduler(self: *FakeScheduler) Scheduler {
        return .{ .ptr = self, .vtable = &.{ .schedule = schedule, .cancel = cancel } };
    }

    pub fn clock(self: *FakeScheduler) Clock {
        return .{ .ptr = self, .nowFn = nowFn };
    }

    fn nowFn(ptr: ?*anyopaque) i64 {
        const self: *FakeScheduler = @ptrCast(@alignCast(ptr.?));
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.now_ms;
    }

    fn schedule(ptr: *anyopaque, delay_ms: u64, ctx: *anyopaque, callback: TimerCallback) u64 {
        const self: *FakeScheduler = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        const id = self.next_id;
        self.next_id += 1;
        self.timers.append(self.allocator, .{
            .id = id,
            .deadline = self.now_ms + @as(i64, @intCast(delay_ms)),
            .ctx = ctx,
            .callback = callback,
        }) catch @panic("oom");
        return id;
    }

    fn cancel(ptr: *anyopaque, id: u64) void {
        const self: *FakeScheduler = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.timers.items, 0..) |entry, index| {
            if (entry.id == id) {
                _ = self.timers.orderedRemove(index);
                return;
            }
        }
    }

    /// Advance time, firing due timers in deadline order on this thread.
    pub fn tick(self: *FakeScheduler, ms: i64) void {
        self.mutex.lock();
        const target = self.now_ms + ms;
        while (true) {
            var due: ?usize = null;
            for (self.timers.items, 0..) |entry, index| {
                if (entry.deadline <= target and (due == null or entry.deadline < self.timers.items[due.?].deadline)) due = index;
            }
            const index = due orelse break;
            const entry = self.timers.orderedRemove(index);
            self.now_ms = @max(self.now_ms, entry.deadline);
            self.mutex.unlock();
            entry.callback(entry.ctx, entry.id);
            self.mutex.lock();
        }
        self.now_ms = target;
        self.mutex.unlock();
    }

    pub fn pending(self: *FakeScheduler) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.timers.items.len;
    }
};

/// Test helper: poll `check(ctx)` under the loop mutex until true (≈ the TS
/// `until()` helper that yields to the event loop between checks).
pub fn until(loop: *Loop, ctx: anytype, comptime check: fn (@TypeOf(ctx)) bool) !void {
    for (0..2000) |_| {
        loop.lock();
        const done = check(ctx);
        loop.unlock();
        if (done) return;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
}

/// Test helper: a one-shot gate awaited under the loop mutex.
pub const Gate = struct {
    open: bool = false,
    condition: std.Thread.Condition = .{},

    /// Mutex held.
    pub fn wait(self: *Gate, loop: *Loop) void {
        while (!self.open) loop.wait(&self.condition);
    }

    /// Takes the loop mutex.
    pub fn release(self: *Gate, loop: *Loop) void {
        loop.lock();
        defer loop.unlock();
        self.open = true;
        self.condition.broadcast();
    }
};

// ---------------------------------------------------------------------------
// Error messages: Zig errors carry no text, so failures that TS reports via
// `formatError(error)` (logs only) record their message per thread here.

threadlocal var error_buffer: [512]u8 = undefined;
threadlocal var error_len: usize = 0;

/// Record `fmt` as the current thread's failure message; returns error.Failed.
pub fn fail(comptime fmt: []const u8, args: anytype) error{Failed} {
    const message = std.fmt.bufPrint(&error_buffer, fmt, args) catch blk: {
        const ellipsis = "...";
        @memcpy(error_buffer[error_buffer.len - ellipsis.len ..], ellipsis);
        break :blk error_buffer[0..];
    };
    error_len = message.len;
    return error.Failed;
}

/// `formatError(error)`: the recorded message for error.Failed, else the name.
pub fn errorMessage(err: anyerror) []const u8 {
    if (err == error.Failed) return error_buffer[0..error_len];
    return @errorName(err);
}
