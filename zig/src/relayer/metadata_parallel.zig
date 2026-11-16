//! Bounded, type-erased metadata jobs. Worker-run jobs execute on stackful
//! fibers: a job whose read parks frees its worker for other jobs and resumes
//! when its response completes, so every queued job starts without help from
//! a waiting caller. Callers waiting for an operation's results therefore
//! never run queued jobs: an unrelated or no-longer-needed job (a stalled
//! sibling) could hold the caller until that job's read deadline although its
//! threshold is already met. The one exception is a worker thread running a
//! job without a fiber stack: its nested waits still execute queued work, so
//! nested aggregations cannot strand every worker waiting for its children.
//! A job that still yields (`.suspended`) re-runs on its own fiber after a
//! short backoff park, without retiring its source or operation; off a fiber
//! it is requeued for a worker.
const std = @import("std");
const fiber = @import("../runtime/fiber.zig");

/// Owned ancestry for assisted nested jobs. A descendant can poll an ancestor's
/// external cancellation even while that ancestor's caller executes queued work.
/// retain/release keep the ancestor's cancellation storage alive after a parent
/// returns early; stopping the ancestor detaches any borrowed external flag.
pub const CancelLink = struct {
    context: *anyopaque,
    poll_fn: *const fn (*anyopaque) bool,
    retain_fn: *const fn (*anyopaque) void,
    release_fn: *const fn (*anyopaque) void,
    pub fn poll(self: CancelLink) bool {
        return self.poll_fn(self.context);
    }
    pub fn retain(self: CancelLink) void {
        self.retain_fn(self.context);
    }
    pub fn release(self: CancelLink) void {
        self.release_fn(self.context);
    }
};

pub const Config = struct {
    workers: usize = 8,
    max_retained_jobs: usize = 1024,
    max_output_bytes: usize = 64 * 1024 * 1024,
};

/// `.done`: the executor releases the job's slot after run returns.
/// `.retired`: the job released it (Job.retire) before publishing completion.
pub const RunResult = enum { done, suspended, retired };
pub const Job = struct {
    next: ?*Job = null,
    due_ms: u64 = 0,
    run_fn: *const fn (*Job) RunResult,
    /// Set by submit: the executor a worker fiber reports this job to.
    executor: ?*Executor = null,

    /// Release this job's executor slot before waking its joiner, so a woken
    /// joiner never observes it retained (or a submit after it saturated).
    /// Then run_fn returns `.retired`; the executor touches nothing after.
    pub fn retire(self: *Job) void {
        self.executor.?.retire();
    }
};

/// The executor whose worker thread is running a job without a fiber stack.
threadlocal var inline_worker: ?*Executor = null;

fn nowMs() u64 {
    return @intCast(std.time.milliTimestamp());
}

const WorkerState = struct {
    executor: *Executor,
    ready_head: ?*fiber.Fiber = null,
    ready_tail: ?*fiber.Fiber = null,
    timed: std.ArrayListUnmanaged(*fiber.Fiber) = .empty,
    cond: std.Thread.Condition = .{},
    idle: bool = false,
    live: usize = 0,
    interrupt: ?fiber.Interrupt = null,
};

pub const Executor = struct {
    allocator: std.mem.Allocator,
    config: Config,
    threads: [8]std.Thread = undefined,
    thread_count: usize = 0,
    worker_states: [8]WorkerState = undefined,
    /// Fiber parks (work-count evidence).
    parks: std.atomic.Value(u64) = .init(0),
    /// `.suspended` job returns (work-count evidence: each is a re-run).
    suspensions: std.atomic.Value(u64) = .init(0),
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    head: ?*Job = null,
    tail: ?*Job = null,
    retained_jobs: usize = 0,
    output_bytes: usize = 0,
    stopping: bool = false,
    stop_signal: std.atomic.Value(bool) = .init(false),
    test_parked_workers: if (@import("builtin").is_test) usize else void = if (@import("builtin").is_test) 0 else {},

    fn init(self: *Executor, allocator: std.mem.Allocator, config: Config) !void {
        if (config.workers == 0 or config.workers > 8 or config.max_retained_jobs < config.workers or config.max_output_bytes == 0) return error.InvalidMetadataExecutorConfig;
        self.* = .{ .allocator = allocator, .config = config };
        errdefer {
            self.stop_signal.store(true, .release);
            self.mutex.lock();
            self.stopping = true;
            self.wake.broadcast();
            for (self.worker_states[0..self.thread_count]) |*state| state.cond.signal();
            self.mutex.unlock();
            for (self.threads[0..self.thread_count]) |thread| thread.join();
        }
        for (&self.worker_states) |*state| state.* = .{ .executor = self };
        for (0..config.workers) |index| {
            self.threads[self.thread_count] = try std.Thread.spawn(.{}, worker, .{ self, index });
            self.thread_count += 1;
        }
    }

    fn append(self: *Executor, job: *Job) void {
        job.next = null;
        if (self.tail) |tail| tail.next = job else self.head = job;
        self.tail = job;
    }

    /// Queue storage is owned by the operation, not allocated per submission.
    pub fn submit(self: *Executor, job: *Job) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopping) return error.MetadataExecutorStopped;
        if (self.retained_jobs >= self.config.max_retained_jobs) return error.MetadataExecutorSaturated;
        self.retained_jobs += 1;
        job.due_ms = nowMs();
        job.executor = self;
        self.append(job);
        self.wakeWorker();
    }
    /// Mutex held: wake one idle worker (claimed now, so a second submit before
    /// it runs reaches a different worker), and the shared condition for
    /// waits that are not fiber workers.
    fn wakeWorker(self: *Executor) void {
        self.wake.signal();
        for (self.worker_states[0..self.thread_count]) |*state| if (state.idle) {
            state.idle = false;
            state.cond.signal();
            return;
        };
        // No idle worker: a fiber driving a socket wait on its thread must
        // yield it so the queued job starts (a stalled read cannot hold it).
        for (self.worker_states[0..self.thread_count]) |*state| if (state.interrupt) |interrupt| {
            interrupt.call(interrupt.ctx);
            return;
        };
    }

    fn take(self: *Executor) ?*Job {
        self.mutex.lock();
        defer self.mutex.unlock();
        const job = self.head orelse return null;
        if (job.due_ms > nowMs()) return null;
        self.head = job.next;
        if (self.head == null) self.tail = null;
        job.next = null;
        return job;
    }

    fn retire(self: *Executor) void {
        self.mutex.lock();
        std.debug.assert(self.retained_jobs > 0);
        self.retained_jobs -= 1;
        self.mutex.unlock();
    }

    /// Off a fiber (no fiber stack, or that worker's nested assist): a
    /// suspended job returns to the queue for a worker fiber.
    fn run(self: *Executor, job: *Job) void {
        switch (job.run_fn(job)) {
            .done => self.retire(),
            .retired => {},
            .suspended => {
                _ = self.suspensions.fetchAdd(1, .monotonic);
                self.mutex.lock();
                job.due_ms = nowMs() + 1;
                self.append(job);
                self.wakeWorker();
                self.mutex.unlock();
            },
        }
    }

    /// First and last backoff of a suspended job on its fiber. Sources inside
    /// metadata jobs park on their own completions; a remaining suspension is
    /// contention without a notifier, so its re-runs back off.
    const suspend_first_ms: i64 = 1;
    const suspend_max_ms: i64 = 16;

    /// On a worker fiber: re-run a suspended job in place after a timed park.
    /// The fiber host runs other fibers and jobs meanwhile; nothing requeues.
    fn runFiber(self: *Executor, job: *Job) void {
        var backoff_ms = suspend_first_ms;
        var result = job.run_fn(job);
        while (result == .suspended) : (result = job.run_fn(job)) {
            _ = self.suspensions.fetchAdd(1, .monotonic);
            var nap: fiber.Waiter = .{};
            _ = nap.waitTimeout(fiber.monoMs() + backoff_ms);
            backoff_ms = @min(backoff_ms * 2, suspend_max_ms);
        }
        if (result == .done) self.retire();
    }

    /// Only this executor's worker thread running a job without a fiber stack
    /// may execute queued work while it waits (else workers all so occupied
    /// could strand their children). Every other waiter, on or off a fiber,
    /// waits for completion: a job run inline holds its caller until the job's
    /// own reads finish, even when the caller no longer needs its result.
    fn mayAssist(self: *Executor) bool {
        return inline_worker == self;
    }

    /// Execute one ready queued job if this caller may (see mayAssist).
    /// Delayed continuations remain retained.
    pub fn assist(self: *Executor) bool {
        if (!self.mayAssist()) return false;
        const job = self.take() orelse return false;
        self.run(job);
        return true;
    }

    /// Priority discovery runs its prefix job, never an unrelated trailing job
    /// (same rule as assist).
    pub fn assistJob(self: *Executor, target: *Job) bool {
        if (!self.mayAssist()) return false;
        self.mutex.lock();
        var previous: ?*Job = null;
        var current = self.head;
        while (current) |job| {
            if (job == target) {
                if (job.due_ms > nowMs()) {
                    self.mutex.unlock();
                    return false;
                }
                if (previous) |before| before.next = job.next else self.head = job.next;
                if (self.tail == job) self.tail = previous;
                job.next = null;
                self.mutex.unlock();
                self.run(job);
                return true;
            }
            previous = job;
            current = job.next;
        }
        self.mutex.unlock();
        return false;
    }

    /// Fiber host: runs ready fibers, expires timed parks, starts due jobs on
    /// new fibers, and sleeps only when idle (until the next due time).
    fn worker(self: *Executor, index: usize) void {
        defer fiber.releaseThreadCache();
        const state = &self.worker_states[index];
        defer state.timed.deinit(self.allocator);
        self.mutex.lock();
        // After each ready step, expire parks and start one due job before the
        // next: a fiber that is always ready again (a yield, or a park whose
        // deadline could not be tracked) cannot starve queued jobs, which no
        // waiting caller runs (see mayAssist).
        var fair = false;
        while (true) {
            if (!fair) if (popReady(state)) |f| {
                dropTimed(state, f);
                self.mutex.unlock();
                self.step(state, f);
                self.mutex.lock();
                fair = true;
                continue;
            };
            fair = false;
            var next_deadline: ?i64 = null;
            if (state.timed.items.len != 0) {
                const now = fiber.monoMs();
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
                    if (parked.w.expire(f)) {
                        f.timed_out = true;
                        pushReady(state, f);
                    }
                }
            }
            if (self.head) |job| if (job.due_ms <= nowMs()) {
                self.head = job.next;
                if (self.head == null) self.tail = null;
                job.next = null;
                state.live += 1;
                self.mutex.unlock();
                const f = fiber.create(.{ .ctx = state, .wake = wakeFiber, .adopt = adoptFiber, .has_ready = hasReady, .set_interrupt = setInterrupt }, jobMain, job) catch {
                    // No fiber stack: run the job on this thread (it may block;
                    // its nested waits assist, see mayAssist).
                    inline_worker = self;
                    self.run(job);
                    inline_worker = null;
                    self.mutex.lock();
                    state.live -= 1;
                    continue;
                };
                self.step(state, f);
                self.mutex.lock();
                continue;
            } else {
                const due: i64 = @intCast(job.due_ms);
                const due_mono = fiber.monoMs() + @max(due - @as(i64, @intCast(nowMs())), 0);
                next_deadline = @min(next_deadline orelse due_mono, due_mono);
            };
            if (state.ready_head != null) continue;
            if (self.head == null and self.stopping and state.live == 0) {
                self.mutex.unlock();
                return;
            }
            state.idle = true;
            if (@import("builtin").is_test) self.test_parked_workers += 1;
            if (next_deadline) |deadline| {
                const left = deadline - fiber.monoMs();
                if (left > 0) state.cond.timedWait(&self.mutex, @as(u64, @intCast(left)) * std.time.ns_per_ms) catch {};
            } else state.cond.wait(&self.mutex);
            if (@import("builtin").is_test) self.test_parked_workers -= 1;
            state.idle = false;
        }
    }
    fn jobMain(arg: *anyopaque) void {
        const job: *Job = @ptrCast(@alignCast(arg));
        job.executor.?.runFiber(job);
    }
    fn step(self: *Executor, state: *WorkerState, f: *fiber.Fiber) void {
        fiber.resumeFiber(f);
        if (fiber.reap(f)) {
            self.mutex.lock();
            state.live -= 1;
            self.mutex.unlock();
            return;
        }
        _ = self.parks.fetchAdd(1, .monotonic);
        switch (f.parked_on) {
            .nothing => {
                self.mutex.lock();
                pushReady(state, f);
                self.mutex.unlock();
            },
            .waiter => |parked| {
                if (parked.w.publish(f)) {
                    self.mutex.lock();
                    pushReady(state, f);
                    self.mutex.unlock();
                } else if (parked.deadline_ms != null) {
                    self.mutex.lock();
                    state.timed.append(self.allocator, f) catch {
                        // Cannot track the deadline: time the wait out now
                        // (its caller rechecks). If a wake already took the
                        // fiber, that waker makes it ready; never both.
                        if (parked.w.expire(f)) {
                            f.timed_out = true;
                            pushReady(state, f);
                        }
                    };
                    self.mutex.unlock();
                }
            },
        }
    }
    fn wakeFiber(context: *anyopaque, f: *fiber.Fiber) void {
        const state: *WorkerState = @ptrCast(@alignCast(context));
        const self = state.executor;
        self.mutex.lock();
        defer self.mutex.unlock();
        pushReady(state, f);
        state.idle = false;
        state.cond.signal();
        if (state.interrupt) |interrupt| interrupt.call(interrupt.ctx);
    }
    fn adoptFiber(context: *anyopaque, f: *fiber.Fiber) void {
        const state: *WorkerState = @ptrCast(@alignCast(context));
        const self = state.executor;
        self.mutex.lock();
        defer self.mutex.unlock();
        state.live += 1;
        pushReady(state, f);
        if (state.interrupt) |interrupt| interrupt.call(interrupt.ctx);
    }
    fn hasReady(context: *anyopaque) bool {
        const state: *WorkerState = @ptrCast(@alignCast(context));
        const self = state.executor;
        self.mutex.lock();
        defer self.mutex.unlock();
        if (state.ready_head != null) return true;
        const job = self.head orelse return false;
        return job.due_ms <= nowMs();
    }
    fn setInterrupt(context: *anyopaque, interrupt: ?fiber.Interrupt) void {
        const state: *WorkerState = @ptrCast(@alignCast(context));
        const self = state.executor;
        self.mutex.lock();
        defer self.mutex.unlock();
        state.interrupt = interrupt;
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

    /// Queued callbacks still run so their operations can release owned state.
    fn deinit(self: *Executor) void {
        // Detached jobs must borrow this lifetime-stable token rather than an
        // operation's token: the operation can retire before its observer does.
        // Signal even currently executing I/O before waiting for any worker.
        self.stop_signal.store(true, .release);
        self.mutex.lock();
        self.stopping = true;
        self.wake.broadcast();
        for (self.worker_states[0..self.thread_count]) |*state| state.cond.signal();
        self.mutex.unlock();
        for (self.threads[0..self.thread_count]) |thread| thread.join();
        std.debug.assert(self.head == null and self.retained_jobs == 0 and self.output_bytes == 0);
        self.* = undefined;
    }

    /// Borrow until the executor has drained all retained jobs. The pointer is
    /// stable after Root.start and cancellation is published before shutdown
    /// joins, including for callbacks currently executing blocking I/O.
    pub fn stopToken(self: *Executor) *const std.atomic.Value(bool) {
        return &self.stop_signal;
    }

    pub fn reserveOutput(self: *Executor, bytes: usize) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (bytes > self.config.max_output_bytes -| self.output_bytes) return false;
        self.output_bytes += bytes;
        return true;
    }

    pub fn releaseOutput(self: *Executor, bytes: usize) void {
        self.mutex.lock();
        std.debug.assert(bytes <= self.output_bytes);
        self.output_bytes -= bytes;
        self.mutex.unlock();
    }

    pub fn retainedJobs(self: *Executor) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.retained_jobs;
    }

    pub fn retainedOutputBytes(self: *Executor) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.output_bytes;
    }
};

pub const Root = struct {
    allocator: std.mem.Allocator,
    executor: Executor,

    pub fn start(allocator: std.mem.Allocator, config: Config) !*Root {
        const self = try allocator.create(Root);
        errdefer allocator.destroy(self);
        self.allocator = allocator;
        try self.executor.init(allocator, config);
        return self;
    }

    pub fn deinit(self: *Root) void {
        const allocator = self.allocator;
        self.executor.deinit();
        allocator.destroy(self);
    }
};

pub fn Attempt(comptime Diagnostics: type) type {
    return struct {
        const Self = @This();
        allocator: std.mem.Allocator,
        references: std.atomic.Value(usize) = std.atomic.Value(usize).init(1),
        visited: std.atomic.Value(usize) = std.atomic.Value(usize).init(0),
        mutex: std.Thread.Mutex = .{},
        diagnostics: Diagnostics = .{},

        pub fn create(allocator: std.mem.Allocator) !*Self {
            const self = try allocator.create(Self);
            self.* = .{ .allocator = allocator };
            return self;
        }

        pub fn retain(self: *Self) void {
            _ = self.references.fetchAdd(1, .acq_rel);
        }

        pub fn release(self: *Self) void {
            if (self.references.fetchSub(1, .acq_rel) == 1) self.allocator.destroy(self);
        }

        pub fn enter(self: *Self, maximum: usize) !void {
            var current = self.visited.load(.acquire);
            while (true) {
                if (current >= maximum) return error.IsmCountExceeded;
                if (self.visited.cmpxchgWeak(current, current + 1, .acq_rel, .acquire)) |actual| {
                    current = actual;
                } else return;
            }
        }

        pub fn mergeDiagnostics(self: *Self, addition: Diagnostics) void {
            self.mutex.lock();
            inline for (std.meta.fields(Diagnostics)) |field| {
                const left = &@field(self.diagnostics, field.name);
                left.* += @field(addition, field.name);
            }
            self.mutex.unlock();
        }

        pub fn snapshotDiagnostics(self: *Self) Diagnostics {
            self.mutex.lock();
            defer self.mutex.unlock();
            return self.diagnostics;
        }
    };
}

pub const max_visit_path = 32;
pub const route_visit = std.math.maxInt(u16);
pub const fast_visit = std.math.maxInt(u16) - 1;
pub const general_visit = std.math.maxInt(u16) - 2;
pub const VisitPath = struct {
    indices: [max_visit_path]u16 = @splat(0),
    len: u8 = 0,

    pub fn child(self: VisitPath, index: u16) !VisitPath {
        if (self.len >= max_visit_path) return error.IsmDepthExceeded;
        var result = self;
        result.indices[self.len] = index;
        result.len += 1;
        return result;
    }
};

/// A root job and all nested operations share this memo across replay passes.
/// Stable recursion paths make re-execution idempotent for the global ISM count.
pub fn VisitMemo(comptime AttemptType: type) type {
    return struct {
        const Self = @This();
        const Node = struct { observation_started: bool = false, leaf_recorded: bool = false };
        allocator: std.mem.Allocator,
        references: std.atomic.Value(usize) = std.atomic.Value(usize).init(1),
        mutex: std.Thread.Mutex = .{},
        nodes: std.AutoHashMapUnmanaged(VisitPath, Node) = .empty,

        pub fn create(allocator: std.mem.Allocator) !*Self {
            const self = try allocator.create(Self);
            self.* = .{ .allocator = allocator };
            return self;
        }

        pub fn retain(self: *Self) void {
            _ = self.references.fetchAdd(1, .acq_rel);
        }

        pub fn release(self: *Self) void {
            if (self.references.fetchSub(1, .acq_rel) != 1) return;
            self.nodes.deinit(self.allocator);
            self.allocator.destroy(self);
        }

        pub fn enter(self: *Self, attempt: *AttemptType, path: VisitPath, maximum: usize) !void {
            self.mutex.lock();
            defer self.mutex.unlock();
            const entry = try self.nodes.getOrPut(self.allocator, path);
            if (entry.found_existing) return;
            entry.value_ptr.* = .{};
            errdefer _ = self.nodes.remove(path);
            try attempt.enter(maximum);
        }

        /// Claim only metadata-observation state; no I/O or callbacks run under
        /// this lock. The node already exists after enter(), so metric replay
        /// bookkeeping cannot introduce an allocation failure.
        pub fn claimObservation(self: *Self, path: VisitPath) bool {
            self.mutex.lock();
            defer self.mutex.unlock();
            const node = self.nodes.getPtr(path) orelse return false;
            if (node.observation_started) return false;
            node.observation_started = true;
            return true;
        }

        pub fn resetObservation(self: *Self, path: VisitPath) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.nodes.getPtr(path)) |node| node.observation_started = false;
        }

        pub fn recordLeaf(self: *Self, path: VisitPath) bool {
            self.mutex.lock();
            defer self.mutex.unlock();
            const node = self.nodes.getPtr(path) orelse return false;
            if (node.leaf_recorded) return false;
            node.leaf_recorded = true;
            return true;
        }
    };
}

const StopTokenTestJob = struct {
    job: Job = .{ .run_fn = run },
    token: *const std.atomic.Value(bool),
    blocking: bool,
    deadline_ns: i128,
    entered: std.atomic.Value(bool) = .init(false),
    stopped: std.atomic.Value(bool) = .init(false),
    expired: std.atomic.Value(bool) = .init(false),
    fn run(job: *Job) RunResult {
        const self: *@This() = @alignCast(@fieldParentPtr("job", job));
        self.entered.store(true, .release);
        while (!self.token.load(.acquire)) {
            // A regression must fail with a bounded test rather than strand CI.
            if (std.time.nanoTimestamp() >= self.deadline_ns) {
                self.expired.store(true, .release);
                return .done;
            }
            if (!self.blocking) return .suspended;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        self.stopped.store(true, .release);
        return .done;
    }
};

fn awaitStopTestEntry(job: *StopTokenTestJob) !void {
    while (!job.entered.load(.acquire)) {
        if (std.time.nanoTimestamp() >= job.deadline_ns) return error.StopTestJobNeverEntered;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

test "executor lifetime stop token cancels active blocking and queued jobs before join" {
    const root = try Root.start(std.testing.allocator, .{ .workers = 1 });
    var closed = false;
    defer if (!closed) root.deinit();
    const token = root.executor.stopToken();
    try std.testing.expect(!token.load(.acquire));
    const deadline = std.time.nanoTimestamp() + 2 * std.time.ns_per_s;
    var active: StopTokenTestJob = .{ .token = token, .blocking = true, .deadline_ns = deadline };
    var queued: StopTokenTestJob = .{ .token = token, .blocking = false, .deadline_ns = deadline };
    try root.executor.submit(&active.job);
    try awaitStopTestEntry(&active);
    try root.executor.submit(&queued.job);
    root.deinit();
    closed = true;
    try std.testing.expect(active.stopped.load(.acquire));
    try std.testing.expect(queued.stopped.load(.acquire));
    try std.testing.expect(!active.expired.load(.acquire));
    try std.testing.expect(!queued.expired.load(.acquire));
    // Token storage belonged to the now-joined executor; never read it here.
}

test "executor lifetime stop token retires a retained cooperative continuation" {
    const root = try Root.start(std.testing.allocator, .{ .workers = 1 });
    var closed = false;
    defer if (!closed) root.deinit();
    var pending: StopTokenTestJob = .{ .token = root.executor.stopToken(), .blocking = false, .deadline_ns = std.time.nanoTimestamp() + 2 * std.time.ns_per_s };
    try root.executor.submit(&pending.job);
    try awaitStopTestEntry(&pending);
    try std.testing.expectEqual(@as(usize, 1), root.executor.retainedJobs());
    root.deinit();
    closed = true;
    try std.testing.expect(pending.stopped.load(.acquire));
    try std.testing.expect(!pending.expired.load(.acquire));
}

test "only a stackless worker thread of the executor assists queued jobs" {
    const root = try Root.start(std.testing.allocator, .{ .workers = 1 });
    defer root.deinit();
    const Gate = struct {
        job: Job = .{ .run_fn = run },
        entered: std.atomic.Value(bool) = .init(false),
        release: std.atomic.Value(bool) = .init(false),
        fn run(job: *Job) RunResult {
            const self: *@This() = @fieldParentPtr("job", job);
            self.entered.store(true, .release);
            while (!self.release.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            return .done;
        }
    };
    const Probe = struct {
        job: Job = .{ .run_fn = run },
        thread: ?std.Thread.Id = null,
        fn run(job: *Job) RunResult {
            const self: *@This() = @fieldParentPtr("job", job);
            self.thread = std.Thread.getCurrentId();
            return .done;
        }
    };
    // The only worker is held, so probes stay queued until assisted.
    var gate: Gate = .{};
    defer gate.release.store(true, .release);
    try root.executor.submit(&gate.job);
    var timer = try std.time.Timer.start();
    while (!gate.entered.load(.acquire)) {
        if (timer.read() > std.time.ns_per_s) return error.WorkerDidNotEnter;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    var first: Probe = .{};
    var second: Probe = .{};
    try root.executor.submit(&first.job);
    try root.executor.submit(&second.job);
    try std.testing.expect(!root.executor.assist());
    try std.testing.expect(!root.executor.assistJob(&second.job));
    try std.testing.expectEqual(@as(usize, 3), root.executor.retainedJobs());
    // As the worker's fallback marks its thread while running a job inline.
    inline_worker = &root.executor;
    defer inline_worker = null;
    try std.testing.expect(root.executor.assistJob(&second.job));
    try std.testing.expectEqual(@as(?std.Thread.Id, std.Thread.getCurrentId()), second.thread);
    try std.testing.expectEqual(@as(?std.Thread.Id, null), first.thread);
    try std.testing.expect(root.executor.assist());
    try std.testing.expectEqual(@as(?std.Thread.Id, std.Thread.getCurrentId()), first.thread);
    try std.testing.expect(!root.executor.assist());
    try std.testing.expectEqual(@as(usize, 1), root.executor.retainedJobs());
}

test "executor off-fiber last suspension wakes parked workers and retires cancellation" {
    const root = try Root.start(std.testing.allocator, .{ .workers = 1 });
    defer root.deinit();
    const Gate = struct {
        job: Job = .{ .run_fn = run },
        entered: std.atomic.Value(bool) = .init(false),
        release: std.atomic.Value(bool) = .init(false),
        fn run(job: *Job) RunResult {
            const self: *@This() = @fieldParentPtr("job", job);
            self.entered.store(true, .release);
            while (!self.release.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            return .done;
        }
    };
    var gate: Gate = .{};
    defer gate.release.store(true, .release);
    try root.executor.submit(&gate.job);
    var timer = try std.time.Timer.start();
    while (!gate.entered.load(.acquire)) {
        if (timer.read() > std.time.ns_per_s) return error.WorkerDidNotEnter;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const Assisted = struct {
        job: Job = .{ .run_fn = run },
        executor: *Executor,
        gate: *Gate,
        caller: std.Thread.Id,
        cancel: std.atomic.Value(bool) = .init(false),
        retired: std.atomic.Value(bool) = .init(false),
        parked: bool = false,
        fn run(job: *Job) RunResult {
            const self: *@This() = @fieldParentPtr("job", job);
            if (self.cancel.load(.acquire)) {
                self.retired.store(true, .release);
                return .done;
            }
            std.debug.assert(std.Thread.getCurrentId() == self.caller);
            self.gate.release.store(true, .release);
            var wait = std.time.Timer.start() catch return .done;
            while (true) {
                self.executor.mutex.lock();
                self.parked = self.executor.test_parked_workers == self.executor.thread_count;
                self.executor.mutex.unlock();
                if (self.parked) break;
                if (wait.read() > std.time.ns_per_s) return .done;
                std.Thread.sleep(std.time.ns_per_ms);
            }
            // The worker is now parked with an empty queue. Only this caller's
            // suspended continuation can wake it; no submit/deinit follows.
            self.cancel.store(true, .release);
            return .suspended;
        }
    };
    var assisted: Assisted = .{ .executor = &root.executor, .gate = &gate, .caller = std.Thread.getCurrentId() };
    try root.executor.submit(&assisted.job);
    // A caller outside the executor never runs queued work.
    try std.testing.expect(!root.executor.assist());
    try std.testing.expect(!root.executor.assistJob(&assisted.job));
    // The off-fiber path a stackless worker uses: run here, then requeue.
    const job = root.executor.take() orelse return error.QueuedJobMissing;
    try std.testing.expectEqual(&assisted.job, job);
    root.executor.run(job);
    try std.testing.expect(assisted.parked);
    timer.reset();
    while (!assisted.retired.load(.acquire) or root.executor.retainedJobs() != 0) {
        if (timer.read() > std.time.ns_per_s) return error.CallerSuspensionLostWake;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedJobs());
}
