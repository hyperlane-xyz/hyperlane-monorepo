//! One lazy, retained blocking owner per configured mutating chain lane. Supervisor
//! callbacks only submit/poll; a stalled chain cannot occupy indexing workers.
//! No caller cancellation pointer or callback stack survives poll().
const std = @import("std");
const supervisor = @import("supervisor.zig");
const wake_notifier = @import("wake.zig");
pub const Config = struct {
    timeout_ms: u64,
    stack_size: usize = 1024 * 1024,
    /// Run-while-due: after a successful run that asks to run again within
    /// this many milliseconds, the owner waits that long on its own thread and
    /// runs again instead of handing back to the supervisor. Reports aggregate
    /// into one result for the supervisor's next poll; an error, halt, stop,
    /// cancellation or expiry ends the loop at once. Zero: one run per poll.
    continue_below_ms: u64 = 0,
};
pub const Owner = struct {
    context: *anyopaque,
    run_fn: *const fn (*anyopaque, supervisor.Times, *const std.atomic.Value(bool)) anyerror!supervisor.Report,
    config: Config,
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    thread: ?std.Thread = null,
    state: enum { idle, queued, running, done } = .idle,
    stopping: bool = false,
    cancel: std.atomic.Value(bool) = .init(false),
    times: supervisor.Times = .{ .unix_ms = 0, .monotonic_ms = 0 },
    timer: ?std.time.Timer = null,
    expired: bool = false,
    cancelled: bool = false,
    result: ?(anyerror!supervisor.Report) = null,
    /// Runs continued on the owner thread without a supervisor handoff.
    continued_runs: u64 = 0,

    /// Keep this object and context at stable addresses until deinit joins.
    pub fn init(context: *anyopaque, run_fn: @TypeOf(@as(Owner, undefined).run_fn), config: Config) !Owner {
        if (config.timeout_ms == 0 or config.timeout_ms > 3600000 or config.stack_size < 256 * 1024 or config.continue_below_ms >= config.timeout_ms) return error.InvalidLaneOwnerConfig;
        return .{ .context = context, .run_fn = run_fn, .config = config };
    }
    /// Null means retained work is pending. No mutex wait and no native I/O on
    /// the caller. A deadline cancels, but never grants early context reuse.
    pub fn poll(self: *Owner, times: supervisor.Times, caller_cancel: *const std.atomic.Value(bool)) !?supervisor.Report {
        if (!self.mutex.tryLock()) return null;
        defer self.mutex.unlock();
        if (self.stopping) return error.LaneOwnerStopped;
        if (self.state != .idle) {
            if (caller_cancel.load(.acquire)) {
                self.cancelled = true;
                self.cancel.store(true, .release);
            }
            if (self.state != .done and self.timer.?.read() >= self.config.timeout_ms * std.time.ns_per_ms) {
                self.expired = true;
                self.cancel.store(true, .release);
            }
            if (self.state != .done) return null;
            const result = self.result orelse unreachable;
            self.result = null;
            self.state = .idle;
            if (self.expired) return error.LaneOwnerDeadline;
            if (self.cancelled) return error.RequestCancelled;
            return try result;
        }
        if (caller_cancel.load(.acquire)) return error.RequestCancelled;
        const timer = try std.time.Timer.start();
        if (self.thread == null) self.thread = try std.Thread.spawn(.{ .stack_size = self.config.stack_size }, worker, .{self});
        self.times = times;
        self.timer = timer;
        self.expired = false;
        self.cancelled = false;
        self.cancel.store(false, .release);
        self.state = .queued;
        self.changed.signal();
        return null;
    }
    fn worker(self: *Owner) void {
        // Dedicated thread for one retained callback: its reads wait inline,
        // driving their own pool sessions.
        self.mutex.lock();
        while (true) {
            while (!self.stopping and self.state != .queued) self.changed.wait(&self.mutex);
            if (self.stopping) break;
            self.state = .running;
            self.result = self.runWhileDue();
            if (self.timer.?.read() >= self.config.timeout_ms * std.time.ns_per_ms) self.expired = true;
            self.state = .done;
            // Resume the supervisor task polling this owner (PendingReadIo).
            wake_notifier.notifyIo();
        }
        self.mutex.unlock();
    }
    const max_continue_ns = std.time.ns_per_s;
    /// Mutex held on entry and return. Runs once, then keeps running while the
    /// callback reports more work due within `continue_below_ms`. Each run
    /// restarts the per-run deadline timer; Times advance by elapsed time.
    fn runWhileDue(self: *Owner) anyerror!supervisor.Report {
        const base = self.times;
        var since = self.timer.?;
        var total: supervisor.Report = .{};
        while (true) {
            const elapsed_ms = since.read() / std.time.ns_per_ms;
            const times: supervisor.Times = .{ .unix_ms = base.unix_ms +| elapsed_ms, .monotonic_ms = base.monotonic_ms +| elapsed_ms };
            self.mutex.unlock();
            const outcome = self.run_fn(self.context, times, &self.cancel);
            self.mutex.lock();
            const report = try outcome;
            total.work +|= report.work;
            total.halt = report.halt;
            total.next_delay_ms = report.next_delay_ms;
            const delay = report.next_delay_ms orelse return total;
            if (self.config.continue_below_ms == 0 or delay > self.config.continue_below_ms or report.halt) return total;
            if (self.stopping or self.cancel.load(.acquire)) return total;
            if (self.timer.?.read() >= self.config.timeout_ms * std.time.ns_per_ms) return total;
            // Hand back at least this often so supervisor health stays fresh.
            if (since.read() >= max_continue_ns) return total;
            // Only requestStop signals a running owner; a spurious wake runs early.
            if (delay > 0) self.changed.timedWait(&self.mutex, delay * std.time.ns_per_ms) catch {};
            if (self.stopping or self.cancel.load(.acquire)) return total;
            self.timer = std.time.Timer.start() catch return total;
            self.continued_runs += 1;
        }
    }
    /// Stop and join before freeing clients, keys, metadata executor or DBs.
    /// Idempotent so constructor cleanup and role teardown share the same path.
    pub fn requestStop(self: *Owner) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.stopping = true;
        self.cancel.store(true, .release);
        self.changed.broadcast();
    }
    pub fn deinit(self: *Owner) void {
        self.requestStop();
        self.mutex.lock();
        const thread = self.thread;
        self.thread = null;
        self.mutex.unlock();
        if (thread) |value| value.join();
    }
};

const Fixture = struct {
    owner: Owner = undefined,
    stalled: bool = false,
    release: std.atomic.Value(bool) = .init(false),
    entered: std.atomic.Value(u32) = .init(0),
    retired: std.atomic.Value(u32) = .init(0),
    observed_cancel: std.atomic.Value(bool) = .init(false),
    fn run(context: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        std.debug.assert(cancel == &self.owner.cancel);
        _ = self.entered.fetchAdd(1, .release);
        while (self.stalled and !self.release.load(.acquire)) {
            if (cancel.load(.acquire)) self.observed_cancel.store(true, .release);
            std.Thread.sleep(std.time.ns_per_ms);
        }
        _ = self.retired.fetchAdd(1, .release);
        return .{ .work = 23, .next_delay_ms = 100000 };
    }
    fn poll(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        return try self.owner.poll(times, cancel) orelse error.PendingReadIo;
    }
};
fn waitCount(count: *std.atomic.Value(u32), minimum: u32) !void {
    var timer = try std.time.Timer.start();
    while (count.load(.acquire) < minimum) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.TestOwnerDidNotProgress;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}
test "eight stalled destination owners leave shared supervisor workers available" {
    var fixtures: [9]Fixture = @splat(.{});
    var tasks: [9]supervisor.Task = undefined;
    for (&fixtures, &tasks, 0..) |*fixture, *task, i| {
        fixture.stalled = i < 8;
        fixture.owner = try Owner.init(fixture, Fixture.run, .{ .timeout_ms = 10000 });
        task.* = .{ .context = fixture, .run = Fixture.poll, .interval_ms = 1, .timeout_ms = 1000 };
    }
    const scheduler = try supervisor.Supervisor.start(std.testing.allocator, &tasks);
    defer {
        scheduler.deinit();
        for (&fixtures) |*fixture| {
            fixture.release.store(true, .release);
            fixture.owner.deinit();
        }
    }
    var timer = try std.time.Timer.start();
    while ((try scheduler.health(8)).completed == 0) {
        const elapsed = timer.read() / std.time.ns_per_ms;
        if (elapsed > 5000) return error.TestHealthyDestinationStarved;
        _ = try scheduler.tick(.{ .unix_ms = elapsed, .monotonic_ms = elapsed });
        std.Thread.sleep(std.time.ns_per_ms);
    }
    for (fixtures[0..8], 0..) |*fixture, i| {
        try waitCount(&fixture.entered, 1);
        try std.testing.expectEqual(@as(u32, 0), fixture.retired.load(.acquire));
        const health = try scheduler.health(i);
        try std.testing.expectEqual(@as(u64, 0), health.failures);
        try std.testing.expectEqual(@as(u64, 0), health.timeouts);
    }
    try std.testing.expectEqual(@as(u64, 23), (try scheduler.health(8)).work);
}
test "expired owner keeps stable cancellation and exclusive context through retirement" {
    var fixture: Fixture = .{ .stalled = true };
    fixture.owner = try Owner.init(&fixture, Fixture.run, .{ .timeout_ms = 10 });
    defer {
        fixture.release.store(true, .release);
        fixture.owner.deinit();
    }
    var caller_cancel: std.atomic.Value(bool) = .init(false);
    const times: supervisor.Times = .{ .unix_ms = 0, .monotonic_ms = 0 };
    try std.testing.expect((try fixture.owner.poll(times, &caller_cancel)) == null);
    try waitCount(&fixture.entered, 1);
    std.Thread.sleep(15 * std.time.ns_per_ms);
    try std.testing.expect((try fixture.owner.poll(times, &caller_cancel)) == null);
    var attempts: usize = 0;
    while (!fixture.observed_cancel.load(.acquire)) : (attempts += 1) {
        if (attempts > 5000) return error.TestCancellationNotObserved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect((try fixture.owner.poll(times, &caller_cancel)) == null);
    try std.testing.expectEqual(@as(u32, 1), fixture.entered.load(.acquire));
    fixture.release.store(true, .release);
    try waitCount(&fixture.retired, 1);
    while (true) {
        const result = fixture.owner.poll(times, &caller_cancel) catch |err| {
            try std.testing.expectEqual(error.LaneOwnerDeadline, err);
            break;
        };
        try std.testing.expect(result == null);
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect((try fixture.owner.poll(times, &caller_cancel)) == null);
    try waitCount(&fixture.entered, 2);
}
test "owner completion before deadline survives delayed polling and idle teardown creates no thread" {
    var fixture: Fixture = .{};
    fixture.owner = try Owner.init(&fixture, Fixture.run, .{ .timeout_ms = 1000 });
    defer fixture.owner.deinit();
    var caller_cancel: std.atomic.Value(bool) = .init(false);
    const times: supervisor.Times = .{ .unix_ms = 0, .monotonic_ms = 0 };
    try std.testing.expect(fixture.owner.thread == null);
    try std.testing.expect((try fixture.owner.poll(times, &caller_cancel)) == null);
    try waitCount(&fixture.retired, 1);
    // Expire the owner clock after the recorded native completion. Polling
    // latency does not turn already-completed work into a request timeout.
    while (true) {
        fixture.owner.mutex.lock();
        const completed = fixture.owner.state == .done;
        if (completed) fixture.owner.config.timeout_ms = 1;
        fixture.owner.mutex.unlock();
        if (completed) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    std.Thread.sleep(5 * std.time.ns_per_ms);
    try std.testing.expectEqual(@as(u64, 23), (try fixture.owner.poll(times, &caller_cancel)).?.work);
    var idle = try Owner.init(&fixture, Fixture.run, .{ .timeout_ms = 100 });
    idle.deinit();
    try std.testing.expect(idle.thread == null);
}

const DueFixture = struct {
    owner: Owner = undefined,
    calls: std.atomic.Value(u32) = .init(0),
    due_runs: u32 = 4,
    fail_at: ?u32 = null,
    always_due: bool = false,
    last_monotonic: u64 = 0,
    fn run(context: *anyopaque, times: supervisor.Times, _: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        const call = self.calls.fetchAdd(1, .acq_rel) + 1;
        std.debug.assert(times.monotonic_ms >= self.last_monotonic);
        self.last_monotonic = times.monotonic_ms;
        if (self.fail_at) |at| if (call == at) return error.InjectedLaneFailure;
        if (self.always_due or call <= self.due_runs) return .{ .work = 1, .next_delay_ms = 1 };
        return .{ .work = 1, .next_delay_ms = 100 };
    }
};
fn pollUntilResult(owner: *Owner, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
    var timer = try std.time.Timer.start();
    while (true) {
        if (try owner.poll(times, cancel)) |report| return report;
        if (timer.read() > 5 * std.time.ns_per_s) return error.TestOwnerDidNotProgress;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}
test "due owner keeps cycling on its own thread and hands back one aggregated report when idle" {
    var fixture: DueFixture = .{};
    fixture.owner = try Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 1000, .continue_below_ms = 10 });
    defer fixture.owner.deinit();
    var cancel: std.atomic.Value(bool) = .init(false);
    const times: supervisor.Times = .{ .unix_ms = 1000, .monotonic_ms = 1000 };
    const report = try pollUntilResult(&fixture.owner, times, &cancel);
    // Four due cycles and the idle one ran without a supervisor handoff.
    try std.testing.expectEqual(@as(u32, 5), fixture.calls.load(.acquire));
    try std.testing.expectEqual(@as(u64, 4), fixture.owner.continued_runs);
    try std.testing.expectEqual(@as(u64, 5), report.work);
    try std.testing.expectEqual(@as(?u64, 100), report.next_delay_ms);
    try std.testing.expect(fixture.last_monotonic >= 1004);
    try std.testing.expectError(error.InvalidLaneOwnerConfig, Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 10, .continue_below_ms = 10 }));
}
test "due owner reports an error at once and the next poll starts a fresh loop" {
    var fixture: DueFixture = .{ .fail_at = 3 };
    fixture.owner = try Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 1000, .continue_below_ms = 10 });
    defer fixture.owner.deinit();
    var cancel: std.atomic.Value(bool) = .init(false);
    const times: supervisor.Times = .{ .unix_ms = 0, .monotonic_ms = 0 };
    try std.testing.expectError(error.InjectedLaneFailure, pollUntilResult(&fixture.owner, times, &cancel));
    try std.testing.expectEqual(@as(u32, 3), fixture.calls.load(.acquire));
    fixture.due_runs = 0;
    fixture.last_monotonic = 0;
    const report = try pollUntilResult(&fixture.owner, times, &cancel);
    try std.testing.expectEqual(@as(u64, 1), report.work);
    try std.testing.expectEqual(@as(u32, 4), fixture.calls.load(.acquire));
}
test "due owner loop ends on caller cancellation and on stop" {
    var fixture: DueFixture = .{ .always_due = true };
    fixture.owner = try Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 1000, .continue_below_ms = 10 });
    var cancel: std.atomic.Value(bool) = .init(false);
    const times: supervisor.Times = .{ .unix_ms = 0, .monotonic_ms = 0 };
    try std.testing.expect((try fixture.owner.poll(times, &cancel)) == null);
    try waitCount(&fixture.calls, 3);
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, pollUntilResult(&fixture.owner, times, &cancel));
    cancel.store(false, .release);
    fixture.last_monotonic = 0;
    try std.testing.expect((try fixture.owner.poll(times, &cancel)) == null);
    const before = fixture.calls.load(.acquire);
    try waitCount(&fixture.calls, before + 2);
    var timer = try std.time.Timer.start();
    fixture.owner.deinit();
    try std.testing.expect(timer.read() < std.time.ns_per_s);
}
