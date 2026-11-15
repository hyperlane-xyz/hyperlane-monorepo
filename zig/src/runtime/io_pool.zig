//! Bounded blocking-I/O workers. Agent clocks and state transitions remain on
//! the owner thread; results carry identities so expired responses cannot mutate
//! a newer generation. Timeout ends the owner's wait, not an already-sent RPC.
const std = @import("std");
const wake_notifier = @import("wake.zig");
const fiber = @import("fiber.zig");

pub const Hook = struct { context: *anyopaque, call_fn: *const fn (*anyopaque) void };
pub const Options = struct {
    /// Run each job on a stackful fiber. A job that parks (a cooperative read
    /// waiting for its response) frees its worker for other jobs and resumes
    /// on the same worker when woken: no callback replay, no worker blocking.
    fibers: bool = false,
    notify_completion: bool = false,
    /// Thread workers only: start no threads up front; submit starts one
    /// (up to `workers`) only when no idle worker can take the job.
    lazy_workers: bool = false,
};

pub fn Pool(comptime Input: type, comptime Output: type, comptime Context: type, comptime workers: usize, comptime capacity: usize) type {
    comptime {
        if (workers == 0 or capacity < workers or capacity > 65535) @compileError("invalid I/O pool bounds");
    }
    return struct {
        const Self = @This();
        pub const JobId = struct { slot: u16, sequence: u64 };
        pub const Result = union(enum) { value: Output, failure: anyerror };
        pub const Completion = struct { id: JobId, result: Result };
        const State = enum { free, queued, running, done, abandoned_queued, abandoned_running };
        const Slot = struct { state: State = .free, sequence: u64 = 0, completion_sequence: u64 = 0, deadline_ms: u64 = 0, input: Input = undefined, result: Result = undefined, cancel: std.atomic.Value(bool) = std.atomic.Value(bool).init(false) };
        /// Fiber worker. `lock` guards the ready queue, `idle` and
        /// `interrupt` (wakes from any thread); `timed` and `live` belong to
        /// the worker thread. Lock order: pool mutex, then a worker lock.
        const WorkerState = struct {
            pool: *Self,
            lock: std.Thread.Mutex = .{},
            cond: std.Thread.Condition = .{},
            ready_head: ?*fiber.Fiber = null,
            ready_tail: ?*fiber.Fiber = null,
            /// Parked fibers with a deadline (worker-local list).
            timed: std.ArrayListUnmanaged(*fiber.Fiber) = .empty,
            timed_storage: [capacity]*fiber.Fiber = undefined,
            idle: bool = false,
            live: usize = 0,
            /// The running fiber blocks this thread (driving a socket wait);
            /// wakes for siblings interrupt it.
            interrupt: ?fiber.Interrupt = null,
        };
        const SlotFiber = struct { pool: *Self, index: usize };
        allocator: std.mem.Allocator,
        context: *Context,
        run_fn: *const fn (*Context, Input, *const std.atomic.Value(bool)) anyerror!Output,
        free_input: *const fn (*Context, Input) void,
        free_output: *const fn (*Context, Output) void,
        slots: [capacity]Slot = @splat(.{}),
        threads: [workers]std.Thread = undefined,
        /// Started worker threads (threads[0..spawned]).
        spawned: usize = 0,
        /// Thread workers waiting on `wake`, and wakes already sent to them
        /// (pool mutex): a submit claims an idle worker or starts a new one.
        idle_workers: usize = 0,
        pending_wakes: usize = 0,
        lazy: bool = false,
        mutex: std.Thread.Mutex = .{},
        wake: std.Thread.Condition = .{},
        stopping: bool = false,
        /// `stopping`, readable without the pool mutex (fiber workers).
        stop_flag: std.atomic.Value(bool) = .init(false),
        /// Slots queued or abandoned_queued (changed under the pool mutex):
        /// fiber workers and hasReady test for queued work without it.
        queued: std.atomic.Value(u32) = .init(0),
        /// Set before submissions by the service supervisor: completions and
        /// retirements end its timed wait (runtime/wake.zig).
        notify_completion: bool = false,
        /// Optional owner wake after a completion or retirement, called on the
        /// worker without the pool mutex. Set before the first submission.
        completion_hook: ?Hook = null,
        sequence: u64 = 0,
        completions: u64 = 0,
        fibers: bool = false,
        worker_states: [workers]WorkerState = undefined,
        slot_fibers: [capacity]SlotFiber = undefined,
        /// Fiber parks and resumes (work-count evidence).
        parks: std.atomic.Value(u64) = .init(0),

        /// Input ownership transfers on successful submit only. Output must own
        /// its buffers; it may not borrow Input, which is freed after run returns.
        pub fn start(allocator: std.mem.Allocator, context: *Context, run_fn: *const fn (*Context, Input, *const std.atomic.Value(bool)) anyerror!Output, free_input: *const fn (*Context, Input) void, free_output: *const fn (*Context, Output) void) !*Self {
            return startWith(allocator, context, run_fn, free_input, free_output, .{});
        }
        pub fn startWith(allocator: std.mem.Allocator, context: *Context, run_fn: *const fn (*Context, Input, *const std.atomic.Value(bool)) anyerror!Output, free_input: *const fn (*Context, Input) void, free_output: *const fn (*Context, Output) void, options: Options) !*Self {
            const self = try allocator.create(Self);
            errdefer allocator.destroy(self);
            if (options.lazy_workers and options.fibers) return error.InvalidIoPoolOptions;
            self.* = .{ .allocator = allocator, .context = context, .run_fn = run_fn, .free_input = free_input, .free_output = free_output, .fibers = options.fibers, .notify_completion = options.notify_completion, .lazy = options.lazy_workers };
            for (&self.worker_states) |*state| {
                state.* = .{ .pool = self };
                state.timed = .initBuffer(&state.timed_storage);
            }
            for (&self.slot_fibers, 0..) |*slot_fiber, index| slot_fiber.* = .{ .pool = self, .index = index };
            if (options.lazy_workers) return self;
            errdefer {
                self.mutex.lock();
                self.stopping = true;
                self.stop_flag.store(true, .seq_cst);
                self.wakeAll();
                self.mutex.unlock();
                for (self.threads[0..self.spawned]) |thread| thread.join();
            }
            for (&self.threads, 0..) |*thread, index| {
                thread.* = if (options.fibers) try std.Thread.spawn(.{}, fiberWorker, .{ self, index }) else try std.Thread.spawn(.{}, worker, .{self});
                self.spawned += 1;
            }
            return self;
        }

        pub fn submit(self: *Self, input: Input, now_ms: u64, deadline_ms: u64) !JobId {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.stopping) return error.IoPoolStopped;
            if (deadline_ms <= now_ms) return error.IoDeadlineExpired;
            if (self.sequence == std.math.maxInt(u64)) return error.IoSequenceExhausted;
            for (&self.slots, 0..) |*slot, index| {
                if (slot.state != .free) continue;
                // A lazy pool with no thread yet must start one or refuse.
                const first = self.lazy and self.spawned == 0;
                if (first) try self.spawnLocked();
                self.sequence += 1;
                slot.* = .{ .state = .queued, .sequence = self.sequence, .deadline_ms = deadline_ms, .input = input };
                _ = self.queued.fetchAdd(1, .seq_cst);
                if (first) {
                    // The new worker finds this job before it first waits.
                } else if (self.lazy and self.idle_workers <= self.pending_wakes and self.spawned < workers) {
                    // Every started worker is busy: a new one takes this job.
                    // Failure leaves it queued for a busy worker's next pass.
                    self.spawnLocked() catch {};
                } else self.wakeOne();
                return .{ .slot = @intCast(index), .sequence = self.sequence };
            }
            return error.IoPoolFull;
        }
        /// Pool mutex held.
        fn spawnLocked(self: *Self) !void {
            self.threads[self.spawned] = try std.Thread.spawn(.{}, worker, .{self});
            self.spawned += 1;
        }

        /// Poll with an injected monotonic clock. Expired work is retained in its
        /// bounded slot until the worker returns and discards any late result.
        /// DNS/connect/read may remain blocked: saturation is explicit, and the
        /// process supervisor must bound shutdown if a transport never returns.
        pub fn poll(self: *Self, now_ms: u64) ?Completion {
            var cleanup: ?Output = null;
            self.mutex.lock();
            const completion: ?Completion = blk: {
                defer self.mutex.unlock();
                var selected: ?usize = null;
                // Multisig metadata must consume actual completion order, not
                // configured validator/slot order when several results arrive
                // between owner ticks. Expired active jobs are resolved first
                // so a steady stream of completions cannot starve deadlines.
                for (self.slots, 0..) |slot, index| {
                    if ((slot.state != .queued and slot.state != .running) or now_ms < slot.deadline_ms) continue;
                    if (selected == null or slot.deadline_ms < self.slots[selected.?].deadline_ms) selected = index;
                }
                const expired = selected != null;
                for (self.slots, 0..) |slot, index| {
                    if (expired or slot.state != .done) continue;
                    if (selected == null or slot.completion_sequence < self.slots[selected.?].completion_sequence) selected = index;
                }
                for (&self.slots, 0..) |*slot, index| {
                    if (selected == null or selected.? != index) continue;
                    const id: JobId = .{ .slot = @intCast(index), .sequence = slot.sequence };
                    switch (slot.state) {
                        .done => {
                            const result = slot.result;
                            slot.state = .free;
                            if (now_ms >= slot.deadline_ms) {
                                if (result == .value) cleanup = result.value;
                                break :blk .{ .id = id, .result = .{ .failure = error.IoTimeout } };
                            }
                            break :blk .{ .id = id, .result = result };
                        },
                        .queued, .running => if (now_ms >= slot.deadline_ms) {
                            slot.cancel.store(true, .release);
                            slot.state = if (slot.state == .queued) .abandoned_queued else .abandoned_running;
                            self.wakeOne();
                            break :blk .{ .id = id, .result = .{ .failure = error.IoTimeout } };
                        },
                        else => {},
                    }
                }
                break :blk null;
            };
            if (cleanup) |output| self.free_output(self.context, output);
            return completion;
        }

        /// Caller owns this cancellation completion; no later result for id is
        /// emitted. Cancelling a completed request also destroys its output.
        pub fn cancel(self: *Self, id: JobId) !Completion {
            var cleanup: ?Output = null;
            self.mutex.lock();
            {
                defer self.mutex.unlock();
                if (id.slot >= capacity) return error.InvalidIoJob;
                const slot = &self.slots[id.slot];
                if (slot.sequence != id.sequence or slot.state == .free or slot.state == .abandoned_queued or slot.state == .abandoned_running) return error.StaleIoJob;
                slot.cancel.store(true, .release);
                switch (slot.state) {
                    .queued => slot.state = .abandoned_queued,
                    .running => slot.state = .abandoned_running,
                    .done => {
                        if (slot.result == .value) cleanup = slot.result.value;
                        slot.state = .free;
                    },
                    else => unreachable,
                }
                self.wakeOne();
            }
            if (cleanup) |output| self.free_output(self.context, output);
            return .{ .id = id, .result = .{ .failure = error.IoCancelled } };
        }

        pub fn release(self: *Self, output: Output) void {
            self.free_output(self.context, output);
        }

        /// A timeout completes the owner's wait before a worker necessarily
        /// returns. Resource owners must wait for retirement before reusing a
        /// mutable client/context or destroying any borrowed input resources.
        pub fn retained(self: *Self, id: JobId) bool {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (id.slot >= capacity) return false;
            const slot = &self.slots[id.slot];
            return slot.sequence == id.sequence and slot.state != .free;
        }

        /// Stops accepting work, cancels queued/running jobs, and joins workers.
        /// A run callback must honor the stable pool-owned cancellation token;
        /// transports remain responsible for bounded shutdown without forced
        /// thread termination.
        pub fn deinit(self: *Self) void {
            self.mutex.lock();
            self.stopping = true;
            self.stop_flag.store(true, .seq_cst);
            for (&self.slots) |*slot| {
                slot.cancel.store(true, .release);
                if (slot.state == .queued) slot.state = .abandoned_queued;
                if (slot.state == .running) slot.state = .abandoned_running;
            }
            self.wakeAll();
            const spawned = self.spawned;
            self.mutex.unlock();
            for (self.threads[0..spawned]) |thread| thread.join();
            for (self.slots) |slot| {
                if (slot.state == .done and slot.result == .value) self.free_output(self.context, slot.result.value);
            }
            self.allocator.destroy(self);
        }

        fn worker(self: *Self) void {
            while (true) {
                self.mutex.lock();
                const index = while (true) {
                    var selected: ?usize = null;
                    for (self.slots, 0..) |slot, i| {
                        if (slot.state != .queued and slot.state != .abandoned_queued) continue;
                        if (selected == null or slot.sequence < self.slots[selected.?].sequence) selected = i;
                    }
                    if (selected) |i| break i;
                    if (self.stopping) {
                        self.mutex.unlock();
                        return;
                    }
                    self.idle_workers += 1;
                    self.wake.wait(&self.mutex);
                    self.idle_workers -= 1;
                    if (self.pending_wakes > 0) self.pending_wakes -= 1;
                };
                const slot = &self.slots[index];
                const input = slot.input;
                _ = self.queued.fetchSub(1, .seq_cst);
                if (slot.state == .abandoned_queued) {
                    // Claim cleanup before releasing the mutex. A second
                    // worker must not select and free the same cancelled input.
                    slot.state = .abandoned_running;
                    self.mutex.unlock();
                    self.free_input(self.context, input);
                    self.mutex.lock();
                    slot.state = .free;
                    self.mutex.unlock();
                    // Retirement of an abandoned job frees its supervisor entry.
                    self.completed();
                    continue;
                }
                slot.state = .running;
                self.mutex.unlock();
                const output: Result = if (self.run_fn(self.context, input, &slot.cancel)) |value| .{ .value = value } else |err| .{ .failure = err };
                self.free_input(self.context, input);
                self.mutex.lock();
                if (slot.state == .abandoned_running) {
                    // Free callbacks run without the pool mutex: cleanup may
                    // itself perform allocator or diagnostic synchronization.
                    self.mutex.unlock();
                    if (output == .value) self.free_output(self.context, output.value);
                    self.mutex.lock();
                    slot.state = .free;
                } else {
                    // At most one completion per submission; the checked
                    // submission counter bounds this addition too.
                    self.completions += 1;
                    slot.completion_sequence = self.completions;
                    slot.result = output;
                    slot.state = .done;
                }
                self.mutex.unlock();
                self.completed();
            }
        }
        /// Pool mutex held: one worker should look for queued work.
        fn wakeOne(self: *Self) void {
            if (!self.fibers) {
                if (self.idle_workers > self.pending_wakes) self.pending_wakes += 1;
                return self.wake.signal();
            }
            // Claim the idle worker now: a second submit before it wakes must
            // signal a different worker, not the same one twice.
            for (&self.worker_states) |*state| {
                state.lock.lock();
                defer state.lock.unlock();
                if (!state.idle) continue;
                state.idle = false;
                state.cond.signal();
                return;
            }
            // No idle worker: a fiber driving a socket wait must yield its
            // thread so the queued job starts (a stalled read cannot hold it).
            for (&self.worker_states) |*state| {
                state.lock.lock();
                defer state.lock.unlock();
                const interrupt = state.interrupt orelse continue;
                interrupt.call(interrupt.ctx);
                return;
            }
        }
        fn wakeAll(self: *Self) void {
            self.wake.broadcast();
            if (self.fibers) for (&self.worker_states) |*state| {
                state.lock.lock();
                state.cond.signal();
                state.lock.unlock();
            };
        }
        /// fiber.Scheduler.wake: thread-safe, posts `f` to its own worker.
        fn wakeFiber(context: *anyopaque, f: *fiber.Fiber) void {
            const state: *WorkerState = @ptrCast(@alignCast(context));
            state.lock.lock();
            defer state.lock.unlock();
            pushReady(state, f);
            state.idle = false;
            state.cond.signal();
            if (state.interrupt) |interrupt| interrupt.call(interrupt.ctx);
        }
        /// Called by fibers between driver passes: no pool mutex, no scan.
        fn hasReady(context: *anyopaque) bool {
            const state: *WorkerState = @ptrCast(@alignCast(context));
            state.lock.lock();
            const ready = state.ready_head != null;
            state.lock.unlock();
            return ready or state.pool.queued.load(.seq_cst) != 0;
        }
        fn setInterrupt(context: *anyopaque, interrupt: ?fiber.Interrupt) void {
            const state: *WorkerState = @ptrCast(@alignCast(context));
            state.lock.lock();
            defer state.lock.unlock();
            state.interrupt = interrupt;
        }
        /// fiber.Scheduler.adopt: a child spawned by a fiber on this worker
        /// (so on its thread: `live` needs no lock).
        fn adoptFiber(context: *anyopaque, f: *fiber.Fiber) void {
            const state: *WorkerState = @ptrCast(@alignCast(context));
            state.live += 1;
            state.lock.lock();
            defer state.lock.unlock();
            pushReady(state, f);
            if (state.interrupt) |interrupt| interrupt.call(interrupt.ctx);
        }
        fn pushReady(state: *WorkerState, f: *fiber.Fiber) void {
            f.next_ready = null;
            if (state.ready_tail) |tail| tail.next_ready = f else state.ready_head = f;
            state.ready_tail = f;
        }
        fn popReady(state: *WorkerState) ?*fiber.Fiber {
            const f = state.ready_head orelse return null;
            state.ready_head = f.next_ready;
            if (state.ready_head == null) state.ready_tail = null;
            f.next_ready = null;
            return f;
        }
        fn dropTimed(state: *WorkerState, f: *fiber.Fiber) void {
            for (state.timed.items, 0..) |item, i| if (item == f) {
                _ = state.timed.swapRemove(i);
                return;
            };
        }
        /// Worker of a fiber pool: runs ready fibers, expires timed parks,
        /// starts queued jobs on new fibers, and sleeps only when idle. The
        /// pool mutex is taken only to claim a queued slot.
        fn fiberWorker(self: *Self, index: usize) void {
            defer fiber.releaseThreadCache();
            const state = &self.worker_states[index];
            while (true) {
                state.lock.lock();
                const ready = popReady(state);
                state.lock.unlock();
                if (ready) |f| {
                    dropTimed(state, f);
                    self.step(state, f);
                    continue;
                }
                var next_deadline: ?i64 = null;
                if (state.timed.items.len != 0) {
                    const now = fiber.monoMs();
                    var expired = false;
                    var i: usize = state.timed.items.len;
                    while (i > 0) {
                        i -= 1;
                        const f = state.timed.items[i];
                        const parked = f.parked_on.waiter;
                        const deadline = parked.deadline_ms.?;
                        if (deadline > now) {
                            next_deadline = @min(next_deadline orelse deadline, deadline);
                            continue;
                        }
                        _ = state.timed.swapRemove(i);
                        // A wake that won already posted the fiber.
                        if (parked.w.expire(f)) {
                            f.timed_out = true;
                            state.lock.lock();
                            pushReady(state, f);
                            state.lock.unlock();
                            expired = true;
                        }
                    }
                    if (expired) continue;
                }
                if (self.queued.load(.seq_cst) != 0 and self.claimQueued(state)) continue;
                state.lock.lock();
                // Re-check under the worker lock: a submit counts its job
                // before it looks for an idle worker under this lock, and a
                // wake pushes under it, so neither is missed by this sleep.
                if (state.ready_head != null or self.queued.load(.seq_cst) != 0) {
                    state.lock.unlock();
                    continue;
                }
                if (self.stop_flag.load(.seq_cst) and state.live == 0) {
                    state.lock.unlock();
                    return;
                }
                state.idle = true;
                if (next_deadline) |deadline| {
                    const left = deadline - fiber.monoMs();
                    if (left > 0) state.cond.timedWait(&state.lock, @as(u64, @intCast(left)) * std.time.ns_per_ms) catch {};
                } else state.cond.wait(&state.lock);
                state.idle = false;
                state.lock.unlock();
            }
        }
        /// Claim and start (or retire, if abandoned) the oldest queued job.
        /// False when another worker claimed it first.
        fn claimQueued(self: *Self, state: *WorkerState) bool {
            self.mutex.lock();
            var selected: ?usize = null;
            for (self.slots, 0..) |slot, i| {
                if (slot.state != .queued and slot.state != .abandoned_queued) continue;
                if (selected == null or slot.sequence < self.slots[selected.?].sequence) selected = i;
            }
            const i = selected orelse {
                self.mutex.unlock();
                return false;
            };
            _ = self.queued.fetchSub(1, .seq_cst);
            const slot = &self.slots[i];
            if (slot.state == .abandoned_queued) {
                const input = slot.input;
                slot.state = .abandoned_running;
                self.mutex.unlock();
                self.free_input(self.context, input);
                self.mutex.lock();
                slot.state = .free;
                self.mutex.unlock();
                self.completed();
                return true;
            }
            slot.state = .running;
            self.mutex.unlock();
            const f = fiber.create(.{ .ctx = state, .wake = wakeFiber, .adopt = adoptFiber, .has_ready = hasReady, .set_interrupt = setInterrupt }, jobFiber, &self.slot_fibers[i]) catch |err| {
                // No fiber stack: the job fails without running.
                self.finishJob(slot, err, true);
                return true;
            };
            state.live += 1;
            self.step(state, f);
            return true;
        }
        /// Resume `f` until it parks or finishes; publish its park.
        fn step(self: *Self, state: *WorkerState, f: *fiber.Fiber) void {
            fiber.resumeFiber(f);
            if (fiber.reap(f)) {
                state.live -= 1;
                return;
            }
            _ = self.parks.fetchAdd(1, .monotonic);
            switch (f.parked_on) {
                .nothing => {
                    state.lock.lock();
                    pushReady(state, f);
                    state.lock.unlock();
                },
                .waiter => |parked| {
                    if (parked.w.publish(f)) {
                        state.lock.lock();
                        pushReady(state, f);
                        state.lock.unlock();
                    } else if (parked.deadline_ms != null) {
                        state.timed.appendAssumeCapacity(f);
                    }
                },
            }
        }
        fn jobFiber(arg: *anyopaque) void {
            const slot_fiber: *SlotFiber = @ptrCast(@alignCast(arg));
            const self = slot_fiber.pool;
            self.finishJob(&self.slots[slot_fiber.index], null, false);
        }
        /// Run (unless `failure`) and publish one claimed job's result.
        fn finishJob(self: *Self, slot: *Slot, failure: ?anyerror, _: bool) void {
            const input = slot.input;
            const output: Result = if (failure) |err| .{ .failure = err } else if (self.run_fn(self.context, input, &slot.cancel)) |value| .{ .value = value } else |err| .{ .failure = err };
            self.free_input(self.context, input);
            self.mutex.lock();
            if (slot.state == .abandoned_running) {
                self.mutex.unlock();
                if (output == .value) self.free_output(self.context, output.value);
                self.mutex.lock();
                slot.state = .free;
            } else {
                self.completions += 1;
                slot.completion_sequence = self.completions;
                slot.result = output;
                slot.state = .done;
            }
            self.mutex.unlock();
            self.completed();
        }
        fn completed(self: *Self) void {
            if (self.notify_completion) wake_notifier.notify();
            if (self.completion_hook) |hook| hook.call_fn(hook.context);
        }
    };
}

const TestContext = struct {
    entered: std.Thread.Semaphore = .{},
    finish: std.Thread.Semaphore = .{},
    cleaned_input: std.atomic.Value(u32) = std.atomic.Value(u32).init(0),
    cleaned_output: std.atomic.Value(u32) = std.atomic.Value(u32).init(0),
    fn run(self: *TestContext, input: u32, _: *const std.atomic.Value(bool)) !u32 {
        self.entered.post();
        self.finish.wait();
        return input * 2;
    }
    fn freeInput(self: *TestContext, _: u32) void {
        _ = self.cleaned_input.fetchAdd(1, .seq_cst);
    }
    fn freeOutput(self: *TestContext, _: u32) void {
        _ = self.cleaned_output.fetchAdd(1, .seq_cst);
    }
};

const OrderedContext = struct {
    entered: std.Thread.Semaphore = .{},
    gates: [2]std.Thread.Semaphore = @splat(.{}),
    fn run(self: *OrderedContext, input: u32, _: *const std.atomic.Value(bool)) !u32 {
        self.entered.post();
        self.gates[input].wait();
        return input;
    }
    fn free(_: *OrderedContext, _: u32) void {}
};

test "completed I/O follows arrival order when owner polls after multiple responses" {
    var context: OrderedContext = .{};
    const Worker = Pool(u32, u32, OrderedContext, 2, 2);
    const pool = try Worker.start(std.testing.allocator, &context, OrderedContext.run, OrderedContext.free, OrderedContext.free);
    defer {
        context.gates[0].post();
        context.gates[1].post();
        pool.deinit();
    }
    const first = try pool.submit(0, 0, 100);
    const second = try pool.submit(1, 0, 100);
    context.entered.wait();
    context.entered.wait();
    context.gates[1].post();
    var timer = try std.time.Timer.start();
    for ([_]Worker.JobId{ second, first }) |id| {
        if (id.slot == first.slot) context.gates[0].post();
        while (true) {
            pool.mutex.lock();
            const done = pool.slots[id.slot].state == .done;
            pool.mutex.unlock();
            if (done) break;
            if (timer.read() > 5 * std.time.ns_per_s) return error.TestWorkerDeadline;
            std.Thread.yield() catch {};
        }
    }
    const arrived = pool.poll(0).?;
    try std.testing.expectEqual(second, arrived.id);
    try std.testing.expectEqual(@as(u32, 1), arrived.result.value);
    pool.release(arrived.result.value);
    const later = pool.poll(0).?;
    try std.testing.expectEqual(first, later.id);
    pool.release(later.result.value);
}

test "deadline returns promptly, keeps capacity bounded and discards late completion" {
    var context: TestContext = .{};
    const Worker = Pool(u32, u32, TestContext, 1, 1);
    const pool = try Worker.start(std.testing.allocator, &context, TestContext.run, TestContext.freeInput, TestContext.freeOutput);
    const id = try pool.submit(21, 0, 10);
    context.entered.wait();
    try std.testing.expectEqual(@as(?Worker.Completion, null), pool.poll(9));
    const expired = pool.poll(10).?;
    try std.testing.expectEqual(id, expired.id);
    try std.testing.expectEqual(error.IoTimeout, expired.result.failure);
    try std.testing.expectError(error.IoPoolFull, pool.submit(22, 10, 20));
    context.finish.post();
    pool.deinit();
    try std.testing.expectEqual(@as(u32, 1), context.cleaned_input.load(.seq_cst));
    try std.testing.expectEqual(@as(u32, 1), context.cleaned_output.load(.seq_cst));
}

test "queued cancellation never executes; running output is discarded after cancellation" {
    var context: TestContext = .{};
    const Worker = Pool(u32, u32, TestContext, 1, 2);
    const pool = try Worker.start(std.testing.allocator, &context, TestContext.run, TestContext.freeInput, TestContext.freeOutput);
    const first = try pool.submit(1, 0, 100);
    context.entered.wait();
    const second = try pool.submit(2, 0, 100);
    try std.testing.expectEqual(error.IoCancelled, (try pool.cancel(second)).result.failure);
    try std.testing.expectEqual(error.IoCancelled, (try pool.cancel(first)).result.failure);
    try std.testing.expectError(error.StaleIoJob, pool.cancel(first));
    context.finish.post();
    pool.deinit();
    try std.testing.expectEqual(@as(u32, 2), context.cleaned_input.load(.seq_cst));
    try std.testing.expectEqual(@as(u32, 1), context.cleaned_output.load(.seq_cst));
}

test "two workers claim cancelled-input cleanup exactly once" {
    const Context = struct {
        entered: std.Thread.Semaphore = .{},
        finish: std.Thread.Semaphore = .{},
        cleanup_entered: std.Thread.Semaphore = .{},
        cleanup_finish: std.Thread.Semaphore = .{},
        probe: std.Thread.Semaphore = .{},
        cleanup_count: std.atomic.Value(u32) = std.atomic.Value(u32).init(0),
        fn run(self: *@This(), input: u32, _: *const std.atomic.Value(bool)) !u32 {
            if (input == 4) {
                self.probe.post();
            } else {
                self.entered.post();
                self.finish.wait();
            }
            return input;
        }
        fn freeInput(self: *@This(), input: u32) void {
            if (input != 3) return;
            _ = self.cleanup_count.fetchAdd(1, .seq_cst);
            self.cleanup_entered.post();
            self.cleanup_finish.wait();
        }
        fn freeOutput(_: *@This(), _: u32) void {}
    };
    var context: Context = .{};
    const Worker = Pool(u32, u32, Context, 2, 4);
    const pool = try Worker.start(std.testing.allocator, &context, Context.run, Context.freeInput, Context.freeOutput);
    _ = try pool.submit(1, 0, 100);
    _ = try pool.submit(2, 0, 100);
    context.entered.wait();
    context.entered.wait();
    const cancelled = try pool.submit(3, 0, 100);
    _ = try pool.cancel(cancelled);
    context.finish.post();
    context.cleanup_entered.wait();
    _ = try pool.submit(4, 0, 100);
    context.finish.post();
    const progressed = if (context.probe.timedWait(2 * std.time.ns_per_s)) |_| true else |_| false;
    // Also release a duplicate cleanup in a regressed implementation so this
    // regression test fails instead of hanging during worker shutdown.
    context.cleanup_finish.post();
    context.cleanup_finish.post();
    pool.deinit();
    try std.testing.expect(progressed);
    try std.testing.expectEqual(@as(u32, 1), context.cleanup_count.load(.seq_cst));
}

const ParkContext = struct {
    gate: fiber.Waiter = .{},
    parked: std.atomic.Value(bool) = .init(false),
    fn run(self: *ParkContext, input: u32, cancel: *const std.atomic.Value(bool)) !u32 {
        if (input == 1) {
            // Parks this job's fiber; the single worker keeps serving jobs.
            self.parked.store(true, .release);
            while (!self.gate.waitTimeout(fiber.monoMs() + 50)) if (cancel.load(.acquire)) return error.Cancelled;
        }
        return input * 10;
    }
    fn freeInput(_: *ParkContext, _: u32) void {}
    fn freeOutput(_: *ParkContext, _: u32) void {}
};
test "fiber workers run other jobs while a job is parked and resume it on wake" {
    var context: ParkContext = .{};
    const pool = try Pool(u32, u32, ParkContext, 1, 4).startWith(std.testing.allocator, &context, ParkContext.run, ParkContext.freeInput, ParkContext.freeOutput, .{ .fibers = true });
    defer pool.deinit();
    const parked = try pool.submit(1, 0, 60_000);
    while (!context.parked.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    const quick = try pool.submit(2, 0, 60_000);
    var timer = try std.time.Timer.start();
    // One worker, first job parked: the second still completes.
    const first = while (true) {
        if (pool.poll(1)) |completion| break completion;
        if (timer.read() > 2 * std.time.ns_per_s) return error.ParkedJobBlockedWorker;
        std.Thread.sleep(std.time.ns_per_ms);
    };
    try std.testing.expectEqual(quick, first.id);
    try std.testing.expectEqual(@as(u32, 20), first.result.value);
    context.gate.wake();
    const second = while (true) {
        if (pool.poll(1)) |completion| break completion;
        if (timer.read() > 4 * std.time.ns_per_s) return error.ParkedJobNotResumed;
        std.Thread.sleep(std.time.ns_per_ms);
    };
    try std.testing.expectEqual(parked, second.id);
    try std.testing.expectEqual(@as(u32, 10), second.result.value);
    try std.testing.expect(pool.parks.load(.acquire) >= 1);
}

const GroupContext = struct {
    const Job = struct {
        child: fiber.Child = .{},
        done: bool = false,
        fn run(arg: *anyopaque) void {
            const job: *Job = @ptrCast(@alignCast(arg));
            // Each child parks for 100 ms; siblings overlap on one worker.
            var nap: fiber.Waiter = .{};
            _ = nap.waitTimeout(fiber.monoMs() + 100);
            job.done = true;
        }
    };
    fn run(_: *GroupContext, input: u32, _: *const std.atomic.Value(bool)) !u32 {
        var jobs: [4]Job = @splat(.{});
        var group: fiber.Group = .{};
        for (&jobs) |*job| try group.spawn(&job.child, Job.run, job);
        group.wait();
        var done: u32 = 0;
        for (jobs) |job| done += @intFromBool(job.done);
        return input * 100 + done;
    }
    fn freeInput(_: *GroupContext, _: u32) void {}
    fn freeOutput(_: *GroupContext, _: u32) void {}
};
test "fiber group children overlap their parks on one worker and join" {
    var context: GroupContext = .{};
    const pool = try Pool(u32, u32, GroupContext, 1, 4).startWith(std.testing.allocator, &context, GroupContext.run, GroupContext.freeInput, GroupContext.freeOutput, .{ .fibers = true });
    defer pool.deinit();
    var timer = try std.time.Timer.start();
    _ = try pool.submit(3, 0, 60_000);
    const completion = while (true) {
        if (pool.poll(1)) |value| break value;
        if (timer.read() > 5 * std.time.ns_per_s) return error.GroupDidNotJoin;
        std.Thread.sleep(std.time.ns_per_ms);
    };
    try std.testing.expectEqual(@as(u32, 304), completion.result.value);
    // Four 100 ms parks overlapped (serial would take 400 ms).
    try std.testing.expect(timer.read() < 350 * std.time.ns_per_ms);
    // Off a fiber the same code runs children inline.
    try std.testing.expectEqual(@as(u32, 504), try GroupContext.run(&context, 5, undefined));
}

test "fiber readiness checks use the worker lock and a queued count, not the pool mutex" {
    var context: TestContext = .{};
    const Worker = Pool(u32, u32, TestContext, 1, 4);
    const pool = try Worker.startWith(std.testing.allocator, &context, TestContext.run, TestContext.freeInput, TestContext.freeOutput, .{ .fibers = true });
    defer pool.deinit();
    _ = try pool.submit(1, 0, 60_000);
    // The only worker is inside the first job (blocking its thread).
    context.entered.wait();
    try std.testing.expectEqual(@as(u32, 0), pool.queued.load(.acquire));
    _ = try pool.submit(2, 0, 60_000);
    try std.testing.expectEqual(@as(u32, 1), pool.queued.load(.acquire));
    // A fiber driving a socket asks between passes; with the pool mutex
    // held elsewhere it still answers (it would deadlock if it took it).
    pool.mutex.lock();
    const ready = Worker.hasReady(&pool.worker_states[0]);
    pool.mutex.unlock();
    try std.testing.expect(ready);
    context.finish.post();
    context.entered.wait();
    try std.testing.expectEqual(@as(u32, 0), pool.queued.load(.acquire));
    context.finish.post();
    var timer = try std.time.Timer.start();
    var completed: usize = 0;
    while (completed < 2) {
        if (pool.poll(1)) |completion| {
            pool.release(completion.result.value);
            completed += 1;
        } else std.Thread.sleep(std.time.ns_per_ms);
        if (timer.read() > 5 * std.time.ns_per_s) return error.FiberJobsDidNotComplete;
    }
}
