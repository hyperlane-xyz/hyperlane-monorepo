//! Bounded blocking-I/O workers. Agent clocks and state transitions remain on
//! the owner thread; results carry identities so expired responses cannot mutate
//! a newer generation. Timeout ends the owner's wait, not an already-sent RPC.
const std = @import("std");

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
        allocator: std.mem.Allocator,
        context: *Context,
        run_fn: *const fn (*Context, Input, *const std.atomic.Value(bool)) anyerror!Output,
        free_input: *const fn (*Context, Input) void,
        free_output: *const fn (*Context, Output) void,
        slots: [capacity]Slot = @splat(.{}),
        threads: [workers]std.Thread = undefined,
        mutex: std.Thread.Mutex = .{},
        wake: std.Thread.Condition = .{},
        stopping: bool = false,
        sequence: u64 = 0,
        completions: u64 = 0,

        /// Input ownership transfers on successful submit only. Output must own
        /// its buffers; it may not borrow Input, which is freed after run returns.
        pub fn start(allocator: std.mem.Allocator, context: *Context, run_fn: *const fn (*Context, Input, *const std.atomic.Value(bool)) anyerror!Output, free_input: *const fn (*Context, Input) void, free_output: *const fn (*Context, Output) void) !*Self {
            const self = try allocator.create(Self);
            errdefer allocator.destroy(self);
            self.* = .{ .allocator = allocator, .context = context, .run_fn = run_fn, .free_input = free_input, .free_output = free_output };
            var started: usize = 0;
            errdefer {
                self.mutex.lock();
                self.stopping = true;
                self.wake.broadcast();
                self.mutex.unlock();
                for (self.threads[0..started]) |thread| thread.join();
            }
            for (&self.threads) |*thread| {
                thread.* = try std.Thread.spawn(.{}, worker, .{self});
                started += 1;
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
                self.sequence += 1;
                slot.* = .{ .state = .queued, .sequence = self.sequence, .deadline_ms = deadline_ms, .input = input };
                self.wake.signal();
                return .{ .slot = @intCast(index), .sequence = self.sequence };
            }
            return error.IoPoolFull;
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
                            self.wake.signal();
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
                self.wake.signal();
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
            for (&self.slots) |*slot| {
                slot.cancel.store(true, .release);
                if (slot.state == .queued) slot.state = .abandoned_queued;
                if (slot.state == .running) slot.state = .abandoned_running;
            }
            self.wake.broadcast();
            self.mutex.unlock();
            for (self.threads) |thread| thread.join();
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
                    self.wake.wait(&self.mutex);
                };
                const slot = &self.slots[index];
                const input = slot.input;
                if (slot.state == .abandoned_queued) {
                    // Claim cleanup before releasing the mutex. A second
                    // worker must not select and free the same cancelled input.
                    slot.state = .abandoned_running;
                    self.mutex.unlock();
                    self.free_input(self.context, input);
                    self.mutex.lock();
                    slot.state = .free;
                    self.mutex.unlock();
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
            }
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
