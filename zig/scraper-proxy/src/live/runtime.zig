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

/// `-Dloop-hold-stats=true` builds: how long the loop mutex is held per
/// acquisition (lock to unlock or wait, turn-end work included). Off by
/// default: the shipped build does no extra work.
pub const hold_stats = @import("live_options").loop_hold_stats;

/// Cumulative hold times (`hold_stats` builds only).
pub const HoldHistogram = struct {
    /// Upper bounds in microseconds; the last bucket is everything above.
    pub const bounds_us = [_]u64{ 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 50_000 };
    counts: [bounds_us.len + 1]std.atomic.Value(u64) = @splat(.init(0)),
    max_us: std.atomic.Value(u64) = .init(0),

    pub fn record(self: *HoldHistogram, held_ns: i128) void {
        const us: u64 = @intCast(@max(0, @divTrunc(held_ns, 1000)));
        var i: usize = 0;
        while (i < bounds_us.len and us >= bounds_us[i]) i += 1;
        _ = self.counts[i].fetchAdd(1, .monotonic);
        _ = self.max_us.fetchMax(us, .monotonic);
    }

    /// `<10us=N <20us=N ... >=50000us=N maxUs=N`.
    pub fn format(self: *const HoldHistogram, w: *std.Io.Writer) std.Io.Writer.Error!void {
        for (bounds_us, 0..) |b, i| try w.print("<{d}us={d} ", .{ b, self.counts[i].load(.monotonic) });
        try w.print(">={d}us={d} maxUs={d}", .{ bounds_us[bounds_us.len - 1], self.counts[bounds_us.len].load(.monotonic), self.max_us.load(.monotonic) });
    }
};

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

/// Handoff invariants (deadlock freedom, also with a pinned loop thread):
/// - I1: nothing holding the loop mutex waits for a poller or the loop
///   thread; `passEnd` is a poller's only wait for the loop mutex. No fiber
///   ever holds the loop mutex (`assertNotFiber`): fibers park only on
///   their own I/O, and this also keeps `in_run_handoff` thread-scoped.
/// - I2: a `.task` handoff is queued in the same critical section as its
///   task's wake (`resumeWaiter`).
/// - I3: a `.run` continuation never blocks (`assertMayBlock`).
/// - I4: the loop thread never waits indefinitely: no awaited send,
///   `Loop.wait`, `Loop.lockHandoff` or database wait runs on an HTTP loop
///   thread or poller (`core.onEventLoopThread`); their completion needs
///   those threads.
///
/// Set (safety builds) while this thread runs a `.run` handoff (I3).
threadlocal var in_run_handoff: bool = false;

/// I3 and I4: here this thread may block until another thread acts (an
/// awaited send, `Loop.wait`, a query): never inside a `.run` continuation,
/// never on an HTTP loop thread.
pub fn assertMayBlock() void {
    if (std.debug.runtime_safety) {
        std.debug.assert(!in_run_handoff);
        std.debug.assert(!core.onEventLoopThread());
    }
}

/// I1: the loop mutex is never taken on a fiber (a parked fiber holding it
/// would stall every other on its thread).
fn assertNotFiber() void {
    if (std.debug.runtime_safety) std.debug.assert(!core.fiber.inFiber());
}

pub const Loop = struct {
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex = .{},
    pool: *Pool,
    scheduler: Scheduler,
    clock: Clock = .{},
    /// Runs with the mutex held just before every release (see `endTurn`).
    turn_end: ?struct { ctx: *anyopaque, func: *const fn (ctx: *anyopaque) void } = null,
    /// Tasks start (first take the mutex) in spawn order, as Node runs
    /// timer callbacks and continuations in order: a later task never starts
    /// before an earlier one (e.g. a batch drain's DB read queues behind the
    /// reads of tasks spawned after it). Tickets are taken in pool order.
    next_ticket: u64 = 1,
    next_start: u64 = 1,
    /// `hold_stats` builds: every hold, and the turn-end hook alone.
    hold: if (hold_stats) HoldHistogram else void = if (hold_stats) .{} else {},
    turn_end_hold: if (hold_stats) HoldHistogram else void = if (hold_stats) .{} else {},
    /// `hold_stats` builds: time `lock` waited for the mutex (and queued
    /// continuations), on HTTP loop threads and pollers vs any thread.
    wait_loop_thread: if (hold_stats) HoldHistogram else void = if (hold_stats) .{} else {},
    wait_any: if (hold_stats) HoldHistogram else void = if (hold_stats) .{} else {},
    locked_at: if (hold_stats) i128 else void = if (hold_stats) 0 else {},
    start_waiters: std.AutoHashMapUnmanaged(u64, *std.Thread.Condition) = .empty,
    /// Continuations a turn resolved (Node's microtasks): they run, in
    /// order, before anything else takes the mutex. `task`: a blocked task
    /// resumes (`lockHandoff`); `run`: a callback the releasing thread runs.
    handoffs: std.ArrayList(Handoff) = .empty,
    handoff_turn: std.Thread.Condition = .{},

    pub const Handoff = union(enum) {
        task: *anyopaque,
        run: struct { ctx: *anyopaque, func: *const fn (ctx: *anyopaque) void },
    };

    pub fn lock(self: *Loop) void {
        assertNotFiber();
        const asked = if (hold_stats) std.time.nanoTimestamp() else {};
        defer if (hold_stats) {
            const waited = std.time.nanoTimestamp() - asked;
            self.wait_any.record(waited);
            if (core.onEventLoopThread()) self.wait_loop_thread.record(waited);
        };
        // A poller thread waiting here hands its other sockets off
        // (`core.blocking`); an uncontended lock costs nothing more.
        if (!self.mutex.tryLock()) {
            core.blocking.begin();
            self.mutex.lock();
            core.blocking.end();
        }
        if (self.handoffs.items.len > 0) {
            core.blocking.begin();
            self.awaitHandoffs();
            core.blocking.end();
        }
        self.holdStart();
    }

    pub fn unlock(self: *Loop) void {
        self.endTurn();
        self.runHandoffs();
        self.holdEnd();
        self.mutex.unlock();
        self.handoff_turn.broadcast();
    }

    /// `await` on a condition: the mutex must be held.
    pub fn wait(self: *Loop, condition: *std.Thread.Condition) void {
        assertNotFiber();
        assertMayBlock();
        self.endTurn();
        self.runHandoffs();
        self.holdEnd();
        self.handoff_turn.broadcast();
        condition.wait(&self.mutex);
        self.awaitHandoffs();
        self.holdStart();
    }

    /// Queue a continuation (mutex held): see `handoffs`.
    pub fn handOff(self: *Loop, handoff: Handoff) void {
        self.handoffs.append(self.allocator, handoff) catch @panic("live: out of memory queueing a continuation");
    }

    /// Take the mutex for the continuation handed off as `token`, when its
    /// turn comes (the task was woken after `handOff(.{ .task = token })`).
    pub fn lockHandoff(self: *Loop, token: *anyopaque) void {
        assertNotFiber();
        assertMayBlock();
        self.mutex.lock();
        while (!(self.handoffs.items.len > 0 and self.handoffs.items[0] == .task and self.handoffs.items[0].task == token))
            self.handoff_turn.wait(&self.mutex);
        _ = self.handoffs.orderedRemove(0);
        self.holdStart();
    }

    fn awaitHandoffs(self: *Loop) void {
        while (self.handoffs.items.len > 0) self.handoff_turn.wait(&self.mutex);
    }

    /// The callbacks at the head of the queue run now, each a turn.
    fn runHandoffs(self: *Loop) void {
        while (self.handoffs.items.len > 0 and self.handoffs.items[0] == .run) {
            const run = self.handoffs.orderedRemove(0).run;
            if (std.debug.runtime_safety) in_run_handoff = true;
            run.func(run.ctx);
            if (std.debug.runtime_safety) in_run_handoff = false;
            self.endTurn();
        }
    }

    /// Releasing the mutex ends the emulated event-loop turn: run work that
    /// Node defers past the current synchronous code (write callbacks).
    fn endTurn(self: *Loop) void {
        const hook = self.turn_end orelse return;
        if (!hold_stats) return hook.func(hook.ctx);
        const started = std.time.nanoTimestamp();
        hook.func(hook.ctx);
        self.turn_end_hold.record(std.time.nanoTimestamp() - started);
    }

    fn holdStart(self: *Loop) void {
        if (hold_stats) self.locked_at = std.time.nanoTimestamp();
    }

    fn holdEnd(self: *Loop) void {
        if (hold_stats) self.hold.record(std.time.nanoTimestamp() - self.locked_at);
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
                const ticket = job.ticket;
                loop.allocator.destroy(closure);
                loop.lock();
                loop.awaitStart(ticket);
                defer loop.unlock();
                @call(.auto, func, call_args);
            }
        };
        const closure = self.allocator.create(Closure) catch {
            // Out of memory: run inline would deadlock (mutex held); abort loudly.
            @panic("live: out of memory spawning task");
        };
        closure.* = .{ .job = .{ .run = Closure.run }, .loop = self, .args = args };
        self.pool.submitOrdered(&closure.job, &self.next_ticket);
    }

    /// Mutex held (just acquired, so no turn work is pending): wait until
    /// every task spawned before this one has started.
    fn awaitStart(self: *Loop, ticket: u64) void {
        if (self.next_start != ticket) {
            var turn: std.Thread.Condition = .{};
            self.start_waiters.put(self.allocator, ticket, &turn) catch @panic("live: out of memory ordering task");
            self.holdEnd();
            while (self.next_start != ticket) turn.wait(&self.mutex);
            self.awaitHandoffs();
            self.holdStart();
            _ = self.start_waiters.remove(ticket);
        }
        self.next_start += 1;
        if (self.start_waiters.get(self.next_start)) |next| next.signal();
    }

    pub fn deinit(self: *Loop) void {
        std.debug.assert(self.start_waiters.count() == 0);
        std.debug.assert(self.handoffs.items.len == 0);
        self.start_waiters.deinit(self.allocator);
        self.handoffs.deinit(self.allocator);
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
        /// Set by `submitOrdered` (start order of loop tasks).
        ticket: u64 = 0,
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
        self.enqueue(job);
    }

    /// `submit` only if a thread is certain to run the job (an idle one, or
    /// one started for it); false leaves it to the caller. For callers that
    /// wait for the job while holding a lock workers may need.
    pub fn trySubmit(self: *Pool, job: *Job) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopping) return false;
        // Every job queued ahead (FIFO) and this one need a free thread: an
        // idle one, or one started now (left running if a later spawn fails).
        const ahead = self.queue.items.len - self.head;
        var free = self.idle;
        while (free < ahead + 1) : (free += 1) {
            const thread = self.spawnWorker() catch return false;
            thread.detach();
            self.threads += 1;
        }
        self.queue.append(self.allocator, job) catch return false;
        self.condition.broadcast();
        return true;
    }

    /// `submit`, numbering the job from `counter` under the pool mutex, so
    /// ticket order is queue order (a worker never waits on a ticket that is
    /// still queued behind it).
    pub fn submitOrdered(self: *Pool, job: *Job, counter: *u64) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        job.ticket = counter.*;
        counter.* += 1;
        self.enqueue(job);
    }

    fn enqueue(self: *Pool, job: *Job) void {
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

/// Live's timers on the process timer thread (`core.scheduler`, monotonic
/// like Node timers). Callbacks run there without the loop mutex and must
/// only spawn tasks (the thread is shared with every module).
///
/// `cancel` never waits, so it is safe with the loop mutex held: whoever
/// removes a timer's slot from `slots` (the firing callback or `cancel`)
/// owns it. `deinit` cancels what is left and waits for callbacks in flight,
/// so no timer can spawn into a pool that is being torn down.
pub const SharedScheduler = struct {
    allocator: std.mem.Allocator,
    timers: *core.scheduler.Scheduler,
    mutex: std.Thread.Mutex = .{},
    drained: std.Thread.Condition = .{},
    slots: std.AutoArrayHashMapUnmanaged(u64, *Slot) = .empty,
    in_flight: usize = 0,

    const Slot = struct {
        owner: *SharedScheduler,
        id: u64 = 0,
        ctx: *anyopaque,
        callback: TimerCallback,
    };

    pub fn init(allocator: std.mem.Allocator, timers: *core.scheduler.Scheduler) SharedScheduler {
        return .{ .allocator = allocator, .timers = timers };
    }

    pub fn deinit(self: *SharedScheduler) void {
        self.mutex.lock();
        const slots = self.allocator.dupe(*Slot, self.slots.values()) catch @panic("live: out of memory");
        self.slots.clearRetainingCapacity();
        self.mutex.unlock();
        defer self.allocator.free(slots);
        for (slots) |slot| {
            // Waits for a firing trampoline, which then finds its slot gone.
            _ = self.timers.cancel(slot.id);
            self.allocator.destroy(slot);
        }
        self.mutex.lock();
        while (self.in_flight > 0) self.drained.wait(&self.mutex);
        self.mutex.unlock();
        self.slots.deinit(self.allocator);
    }

    pub fn scheduler(self: *SharedScheduler) Scheduler {
        return .{ .ptr = self, .vtable = &.{ .schedule = schedule, .cancel = cancel } };
    }

    fn schedule(ptr: *anyopaque, delay_ms: u64, ctx: *anyopaque, callback: TimerCallback) u64 {
        const self: *SharedScheduler = @ptrCast(@alignCast(ptr));
        const slot = self.allocator.create(Slot) catch @panic("live: out of memory scheduling timer");
        slot.* = .{ .owner = self, .ctx = ctx, .callback = callback };
        // Registered before it can fire (the trampoline looks the id up).
        self.mutex.lock();
        defer self.mutex.unlock();
        const id = self.timers.schedule(delay_ms, slot, trampoline) catch @panic("live: out of memory scheduling timer");
        slot.id = id;
        self.slots.put(self.allocator, id, slot) catch @panic("live: out of memory scheduling timer");
        return id;
    }

    fn cancel(ptr: *anyopaque, id: u64) void {
        const self: *SharedScheduler = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        const removed = self.slots.fetchSwapRemove(id);
        self.mutex.unlock();
        const entry = removed orelse return; // fired (or firing) already
        // Pending: removed from the timer list. Firing: its trampoline is
        // waiting for our mutex and will find the slot gone; wait for it.
        _ = self.timers.cancel(id);
        self.allocator.destroy(entry.value);
    }

    fn trampoline(ptr: *anyopaque, id: u64) void {
        const slot: *Slot = @ptrCast(@alignCast(ptr));
        const self = slot.owner;
        self.mutex.lock();
        const owned = self.slots.swapRemove(id);
        if (owned) self.in_flight += 1;
        self.mutex.unlock();
        if (!owned) return; // cancelled: the canceller frees the slot
        const ctx = slot.ctx;
        const callback = slot.callback;
        self.allocator.destroy(slot);
        callback(ctx, id);
        self.mutex.lock();
        self.in_flight -= 1;
        if (self.in_flight == 0) self.drained.broadcast();
        self.mutex.unlock();
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
    // Generous: returns as soon as `check` holds; only a hang should time out.
    for (0..20_000) |_| {
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
