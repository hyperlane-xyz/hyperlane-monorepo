//! Owner-thread scheduling with bounded I/O workers. One mutable role/client
//! context has at most one retained job, including after owner-side timeout.
const std = @import("std");
const io = @import("io_pool.zig");
const A = std.mem.Allocator;
pub const Times = struct { unix_ms: u64, monotonic_ms: u64 };
pub const Report = struct { work: u64 = 0, next_delay_ms: ?u64 = null, halt: bool = false };
pub const FailureAction = enum { retry, halt_task, halt_all };
pub const Task = struct {
    context: *anyopaque,
    run: *const fn (*anyopaque, Times, *const std.atomic.Value(bool)) anyerror!Report,
    /// Runs on the owner while a timed-out callback may still be retiring.
    /// Classification cannot borrow the callback's mutable role context.
    failure: ?*const fn (anyerror) FailureAction = null,
    interval_ms: u64,
    timeout_ms: u64,
    /// Optional event mailbox. The worker consumes its own flag at job start;
    /// owner-side wake never grants reuse of an active/retiring context.
    wake: ?*const std.atomic.Value(bool) = null,
    /// Nonblocking, thread-safe and idempotent. Cancels external retained work
    /// even after its polling callback yielded and no pool JobId remains active.
    stop_fn: ?*const fn (*anyopaque) void = null,
};
pub const Health = struct {
    started: u64 = 0,
    completed: u64 = 0,
    suspended: u64 = 0,
    timeouts: u64 = 0,
    failures: u64 = 0,
    work: u64 = 0,
    last_success_ms: ?u64 = null,
    last_error: ?anyerror = null,
    halted: bool = false,
};
const Input = struct { index: usize, times: Times };
const Output = struct { index: usize, report: Report };
const Context = struct {
    tasks: []const Task,
    fn run(self: *Context, input: Input, cancel: *const std.atomic.Value(bool)) !Output {
        const task = self.tasks[input.index];
        if (cancel.load(.acquire)) return error.RequestCancelled;
        const report = task.run(task.context, input.times, cancel) catch |err| {
            if (task.failure) |classify| switch (classify(err)) {
                .halt_all => self.stopRetained(),
                .halt_task => if (task.stop_fn) |stop| stop(task.context),
                .retry => {},
            };
            return err;
        };
        if (report.halt) if (task.stop_fn) |stop| stop(task.context);
        return .{ .index = input.index, .report = report };
    }
    fn stopRetained(self: *Context) void {
        for (self.tasks) |task| if (task.stop_fn) |stop| stop(task.context);
    }
    fn freeInput(_: *Context, _: Input) void {}
    fn freeOutput(_: *Context, _: Output) void {}
};
const Workers = io.Pool(Input, Output, Context, 8, 256);
const Entry = struct { health: Health = .{}, next_ms: u64 = 0, active: ?Workers.JobId = null, timed_out: bool = false };
pub const Tick = struct { started: usize = 0, completed: usize = 0, suspended: usize = 0, failures: usize = 0, timeouts: usize = 0, retired: usize = 0 };
pub const Supervisor = struct {
    allocator: A,
    context: Context,
    entries: []Entry,
    workers: *Workers,
    next_task: usize = 0,
    stopping: bool = false,
    terminal_error: ?anyerror = null,
    last_ms: u64 = 0,

    /// Copies task descriptors. Task contexts must remain heap-stable and owned
    /// by the caller through deinit, which cancels and joins all worker jobs.
    pub fn start(a: A, tasks: []const Task) !*Supervisor {
        if (tasks.len == 0 or tasks.len > 4096) return error.InvalidSupervisorTasks;
        for (tasks) |task| if (task.interval_ms == 0 or task.timeout_ms == 0) return error.InvalidSupervisorTaskLimit;
        const self = try a.create(Supervisor);
        errdefer a.destroy(self);
        const copied = try a.dupe(Task, tasks);
        errdefer a.free(copied);
        const entries = try a.alloc(Entry, tasks.len);
        errdefer a.free(entries);
        @memset(entries, .{});
        self.* = .{ .allocator = a, .context = .{ .tasks = copied }, .entries = entries, .workers = undefined };
        self.workers = try Workers.start(a, &self.context, Context.run, Context.freeInput, Context.freeOutput);
        return self;
    }
    pub fn deinit(self: *Supervisor) void {
        self.workers.deinit();
        const a = self.allocator;
        a.free(self.context.tasks);
        a.free(self.entries);
        a.destroy(self);
    }
    pub fn health(self: *const Supervisor, index: usize) !Health {
        if (index >= self.entries.len) return error.InvalidSupervisorTask;
        return self.entries[index].health;
    }
    pub fn taskCount(self: *const Supervisor) usize {
        return self.entries.len;
    }
    /// Owner-thread readback: a fatal worker classification stops the process,
    /// even when other tasks were healthy or already had work in flight.
    pub fn failureReason(self: *const Supervisor) ?anyerror {
        return self.terminal_error;
    }
    pub fn stop(self: *Supervisor) void {
        self.stopping = true;
        self.context.stopRetained();
        for (self.entries) |*entry| if (entry.active) |id| {
            if (!entry.timed_out) {
                _ = self.workers.cancel(id) catch {};
                entry.timed_out = true;
            }
        };
    }
    pub fn drained(self: *Supervisor) bool {
        for (self.entries) |entry| if (entry.active) |id| {
            if (self.workers.retained(id)) return false;
        };
        return true;
    }
    pub fn tick(self: *Supervisor, now: Times) !Tick {
        if (now.monotonic_ms < self.last_ms) return error.MonotonicClockMovedBackwards;
        self.last_ms = now.monotonic_ms;
        var result: Tick = .{};
        while (self.workers.poll(now.monotonic_ms)) |completion| {
            const index = for (self.entries, 0..) |entry, i| {
                if (entry.active) |active| if (std.meta.eql(active, completion.id)) break i;
            } else return error.UnknownSupervisorCompletion;
            const entry = &self.entries[index];
            const task = self.context.tasks[index];
            switch (completion.result) {
                .value => |output| {
                    if (output.index != index) return error.WrongSupervisorCompletion;
                    entry.active = null;
                    entry.health.completed +|= 1;
                    entry.health.work +|= output.report.work;
                    entry.health.last_success_ms = now.monotonic_ms;
                    entry.health.last_error = null;
                    entry.health.halted = output.report.halt or self.terminal_error != null;
                    entry.next_ms = now.monotonic_ms +| (output.report.next_delay_ms orelse task.interval_ms);
                    result.completed += 1;
                },
                .failure => |err| {
                    if (err == error.PendingReadIo) {
                        // A read continuation yields its worker, retaining all
                        // network/session state in its role-owned journal.
                        entry.health.suspended +|= 1;
                        result.suspended += 1;
                        entry.next_ms = now.monotonic_ms +| 1;
                        entry.timed_out = self.workers.retained(completion.id);
                        if (!entry.timed_out) entry.active = null;
                        continue;
                    }
                    entry.health.last_error = err;
                    entry.health.failures +|= 1;
                    result.failures += 1;
                    entry.next_ms = now.monotonic_ms +| task.interval_ms;
                    // Preserve client/context exclusivity until actual callback
                    // retirement. A timeout is never permission to race it.
                    entry.timed_out = self.workers.retained(completion.id);
                    if (!entry.timed_out) entry.active = null;
                    if (err == error.IoTimeout) {
                        entry.health.timeouts +|= 1;
                        result.timeouts += 1;
                    }
                    if (task.failure) |callback| switch (callback(err)) {
                        .retry => {},
                        .halt_task => entry.health.halted = true,
                        .halt_all => {
                            if (self.terminal_error == null) self.terminal_error = err;
                            for (self.entries) |*other| other.health.halted = true;
                            self.stop();
                        },
                    };
                },
            }
        }
        for (self.entries) |*entry| if (entry.active) |id| {
            if (entry.timed_out and !self.workers.retained(id)) {
                entry.active = null;
                entry.timed_out = false;
                result.retired += 1;
            }
        };
        if (self.stopping) return result;
        for (0..self.entries.len) |_| {
            const index = self.next_task;
            self.next_task = (index + 1) % self.entries.len;
            const entry = &self.entries[index];
            const awake = if (self.context.tasks[index].wake) |wake| wake.load(.acquire) else false;
            if (entry.active != null or entry.health.halted or (now.monotonic_ms < entry.next_ms and !awake)) continue;
            const id = self.workers.submit(.{ .index = index, .times = now }, now.monotonic_ms, now.monotonic_ms +| self.context.tasks[index].timeout_ms) catch |err| switch (err) {
                error.IoPoolFull => break,
                else => return err,
            };
            entry.active = id;
            entry.health.started +|= 1;
            result.started += 1;
        }
        return result;
    }
};

const Fixture = struct {
    entered: std.Thread.Semaphore = .{},
    release: std.Thread.Semaphore = .{},
    calls: std.atomic.Value(usize) = .init(0),
    fn run(context: *anyopaque, _: Times, _: *const std.atomic.Value(bool)) !Report {
        const self: *Fixture = @ptrCast(@alignCast(context));
        _ = self.calls.fetchAdd(1, .release);
        self.entered.post();
        self.release.wait();
        return .{ .work = 1 };
    }
};
test "supervisor timeout retains mutable role exclusively until actual worker retirement" {
    var fixture: Fixture = .{};
    const scheduler = try Supervisor.start(std.testing.allocator, &.{.{ .context = &fixture, .run = Fixture.run, .interval_ms = 1, .timeout_ms = 10 }});
    defer scheduler.deinit();
    defer fixture.release.post();
    _ = try scheduler.tick(.{ .unix_ms = 0, .monotonic_ms = 0 });
    fixture.entered.wait();
    const timed = try scheduler.tick(.{ .unix_ms = 10, .monotonic_ms = 10 });
    try std.testing.expectEqual(@as(usize, 1), timed.timeouts);
    _ = try scheduler.tick(.{ .unix_ms = 100, .monotonic_ms = 100 });
    try std.testing.expectEqual(@as(usize, 1), fixture.calls.load(.acquire));
    fixture.release.post();
    var attempts: usize = 0;
    while (scheduler.workers.retained(scheduler.entries[0].active.?)) : (attempts += 1) {
        if (attempts > 5000) return error.FixtureWorkerStalled;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const resumed = try scheduler.tick(.{ .unix_ms = 101, .monotonic_ms = 101 });
    try std.testing.expectEqual(@as(usize, 1), resumed.started);
    fixture.entered.wait();
    scheduler.stop();
    fixture.release.post();
    // Late output is discarded by the worker and never counts successful work.
    while (!scheduler.drained()) std.Thread.sleep(std.time.ns_per_ms);
    const status = try scheduler.health(0);
    try std.testing.expectEqual(@as(u64, 0), status.completed);
    try std.testing.expectEqual(@as(u64, 1), status.timeouts);
}

test "supervisor fatal classification exposes original error halts all lanes and drains cancellation" {
    const Fatal = struct {
        entered: std.Thread.Semaphore = .{},
        release: std.Thread.Semaphore = .{},
        retired: std.atomic.Value(bool) = .init(false),
        fn fail(context: *anyopaque, _: Times, _: *const std.atomic.Value(bool)) !Report {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.entered.post();
            self.release.wait();
            return error.ConfirmedReorg;
        }
        fn wait(context: *anyopaque, _: Times, cancel: *const std.atomic.Value(bool)) !Report {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.entered.post();
            while (!cancel.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            self.retired.store(true, .release);
            return .{ .work = 999 };
        }
        fn classify(_: anyerror) FailureAction {
            return .halt_all;
        }
    };
    var fixture: Fatal = .{};
    const owner = try Supervisor.start(std.testing.allocator, &.{
        .{ .context = &fixture, .run = Fatal.fail, .failure = Fatal.classify, .interval_ms = 1, .timeout_ms = 10000 },
        .{ .context = &fixture, .run = Fatal.wait, .interval_ms = 1, .timeout_ms = 10000 },
    });
    defer owner.deinit();
    defer fixture.release.post();
    _ = try owner.tick(.{ .unix_ms = 0, .monotonic_ms = 0 });
    fixture.entered.wait();
    fixture.entered.wait();
    fixture.release.post();
    var now_ms: u64 = 1;
    while (owner.failureReason() == null) : (now_ms += 1) {
        if (now_ms > 5000) return error.FatalClassificationNotObserved;
        _ = try owner.tick(.{ .unix_ms = now_ms, .monotonic_ms = now_ms });
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(error.ConfirmedReorg, owner.failureReason().?);
    try std.testing.expect(owner.stopping);
    for (0..owner.taskCount()) |index| try std.testing.expect((try owner.health(index)).halted);
    while (!owner.drained()) std.Thread.sleep(std.time.ns_per_ms);
    try std.testing.expect(fixture.retired.load(.acquire));
    const after = try owner.tick(.{ .unix_ms = now_ms, .monotonic_ms = now_ms });
    try std.testing.expectEqual(@as(usize, 0), after.started);
    try std.testing.expectEqual(@as(u64, 0), (try owner.health(1)).work);
    try std.testing.expectEqual(error.ConfirmedReorg, owner.failureReason().?);
}

test "supervisor mailbox wake bypasses interval without reusing active or retiring role" {
    const Woken = struct {
        fixture: Fixture = .{},
        pending: std.atomic.Value(bool) = .init(false),
        fn run(context: *anyopaque, times: Times, cancel: *const std.atomic.Value(bool)) !Report {
            const self: *@This() = @ptrCast(@alignCast(context));
            _ = self.pending.swap(false, .acq_rel);
            return Fixture.run(&self.fixture, times, cancel);
        }
    };
    var state: Woken = .{};
    const owner = try Supervisor.start(std.testing.allocator, &.{.{ .context = &state, .run = Woken.run, .interval_ms = 60000, .timeout_ms = 20, .wake = &state.pending }});
    defer owner.deinit();
    defer state.fixture.release.post();
    _ = try owner.tick(.{ .unix_ms = 0, .monotonic_ms = 0 });
    state.fixture.entered.wait();
    state.fixture.release.post();
    const now: u64 = 1;
    var attempts: usize = 0;
    while ((try owner.health(0)).completed == 0) : (attempts += 1) {
        if (attempts >= 5000) return error.WakeFixtureNotRetired;
        std.Thread.sleep(std.time.ns_per_ms);
        _ = try owner.tick(.{ .unix_ms = now, .monotonic_ms = now });
    }
    try std.testing.expectEqual(@as(usize, 0), (try owner.tick(.{ .unix_ms = now, .monotonic_ms = now })).started);
    state.pending.store(true, .release);
    try std.testing.expectEqual(@as(usize, 1), (try owner.tick(.{ .unix_ms = now, .monotonic_ms = now })).started);
    state.fixture.entered.wait();
    state.pending.store(true, .release);
    _ = try owner.tick(.{ .unix_ms = now + 20, .monotonic_ms = now + 20 });
    _ = try owner.tick(.{ .unix_ms = now + 21, .monotonic_ms = now + 21 });
    try std.testing.expectEqual(@as(usize, 2), state.fixture.calls.load(.acquire));
    try std.testing.expectEqual(@as(u64, 1), (try owner.health(0)).timeouts);
    owner.stop();
    state.fixture.release.post();
    while (!owner.drained()) std.Thread.sleep(std.time.ns_per_ms);
}

test "supervisor cooperative reads resume without consuming failures retries or completion" {
    const Read = struct {
        calls: std.atomic.Value(usize) = .init(0),
        fn run(context: *anyopaque, _: Times, _: *const std.atomic.Value(bool)) !Report {
            const self: *@This() = @ptrCast(@alignCast(context));
            if (self.calls.fetchAdd(1, .acq_rel) < 2) return error.PendingReadIo;
            return .{ .work = 3 };
        }
    };
    var state: Read = .{};
    const owner = try Supervisor.start(std.testing.allocator, &.{.{ .context = &state, .run = Read.run, .interval_ms = 60000, .timeout_ms = 10000 }});
    defer owner.deinit();
    var millis: u64 = 0;
    while ((try owner.health(0)).completed == 0) : (millis += 1) {
        if (millis >= 5000) return error.ContinuationFixtureStalled;
        _ = try owner.tick(.{ .unix_ms = millis, .monotonic_ms = millis });
        std.Thread.sleep(std.time.ns_per_ms);
    }
    const health_ = try owner.health(0);
    try std.testing.expectEqual(@as(u64, 2), health_.suspended);
    try std.testing.expectEqual(@as(u64, 0), health_.failures);
    try std.testing.expectEqual(@as(u64, 0), health_.timeouts);
    try std.testing.expectEqual(@as(u64, 1), health_.completed);
    try std.testing.expectEqual(@as(u64, 3), health_.work);
    try std.testing.expect(health_.last_error == null);
    try std.testing.expectEqual(@as(usize, 3), state.calls.load(.acquire));
}
