//! One lazy, retained blocking owner per configured mutating chain lane. Supervisor
//! callbacks only submit/poll; a stalled chain cannot occupy indexing workers.
//! No caller cancellation pointer or callback stack survives poll().
const std = @import("std");
const supervisor = @import("supervisor.zig");
const wake_notifier = @import("wake.zig");
pub const Config = struct {
    timeout_ms: u64,
    stack_size: usize = 1024 * 1024,
    /// Owner-held cadence: after a successful run, the owner waits the run's
    /// next_delay_ms on its own thread (cut short by `kick`) and runs again
    /// with fresh Times while that next run starts within `hold_ms` of the
    /// poll that started the loop. Reports aggregate into one result for the
    /// supervisor's next poll; an error, halt, stop, cancellation or expiry
    /// ends the loop at once. Zero: one run per poll.
    hold_ms: u64 = 0,
    /// Publish through wake.notifyIo (a supervisor task suspended on this
    /// owner resumes on the I/O generation). False: the task sets
    /// Task.owner_wake = ownerWake() and a publish is one wake.notify().
    notify_io: bool = true,
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
    /// Set with `.done` (mutex held), cleared when poll consumes the result:
    /// the supervisor Task.owner_wake flag, so a publish costs one service
    /// wake and no global I/O resumption.
    published: std.atomic.Value(bool) = .init(false),
    /// Sticky external work (e.g. a queued control command): while set the
    /// owner does not wait out a cadence delay. Its writers call `kick`.
    kick_source: ?*const std.atomic.Value(bool) = null,
    /// A kick since the current run started (mutex).
    kicked: bool = false,
    /// `kick_source` when the current run started (mutex): only a source
    /// that became set during the run skips the wait. One left set (work
    /// the run could not take yet) must not turn the cadence into a spin.
    source_at_start: bool = false,
    /// Between continued runs (mutex): no callback runs, so no deadline.
    waiting: bool = false,
    /// Task.owner_deadline: the current run's expiry in the poller's
    /// monotonic ms (+1 so the poll's own timer has passed it), 0 when no
    /// run is in progress.
    run_deadline_ms: std.atomic.Value(u64) = .init(0),
    /// Runs continued on the owner thread without a supervisor handoff.
    continued_runs: u64 = 0,

    /// Keep this object and context at stable addresses until deinit joins.
    pub fn init(context: *anyopaque, run_fn: @TypeOf(@as(Owner, undefined).run_fn), config: Config) !Owner {
        if (config.timeout_ms == 0 or config.timeout_ms > 3600000 or config.stack_size < 256 * 1024 or config.hold_ms > supervisor.max_wait_ms) return error.InvalidLaneOwnerConfig;
        return .{ .context = context, .run_fn = run_fn, .config = config };
    }
    /// The supervisor Task.owner_wake flag for this owner.
    pub fn ownerWake(self: *Owner) *std.atomic.Value(bool) {
        return &self.published;
    }
    /// The supervisor Task.owner_deadline for this owner.
    pub fn ownerDeadline(self: *Owner) *std.atomic.Value(u64) {
        return &self.run_deadline_ms;
    }
    /// Null means retained work is pending. No native I/O on the caller; the
    /// owner holds its mutex only between runs, never across `run_fn`. A
    /// deadline cancels, but never grants early context reuse.
    pub fn poll(self: *Owner, times: supervisor.Times, caller_cancel: *const std.atomic.Value(bool)) !?supervisor.Report {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopping) return error.LaneOwnerStopped;
        if (self.state != .idle) {
            if (caller_cancel.load(.acquire)) {
                self.cancelled = true;
                self.cancel.store(true, .release);
                self.changed.broadcast();
            }
            if (self.state != .done and !self.waiting and self.timer.?.read() >= self.config.timeout_ms * std.time.ns_per_ms) {
                self.expired = true;
                self.cancel.store(true, .release);
                self.changed.broadcast();
                // Signalled: the poller falls back to its backstop instead
                // of re-polling a run that is already retiring.
                self.run_deadline_ms.store(0, .release);
            }
            if (self.state != .done) return null;
            const result = self.result orelse unreachable;
            self.result = null;
            self.state = .idle;
            self.published.store(false, .release);
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
        // Published before the poller computes its next wait.
        self.run_deadline_ms.store(times.monotonic_ms +| self.config.timeout_ms +| 1, .release);
        self.state = .queued;
        self.changed.signal();
        return null;
    }
    /// Thread-safe: new external work. Ends a cadence wait at once; a kick
    /// during a run makes the owner run again without waiting.
    pub fn kick(self: *Owner) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.kicked = true;
        self.changed.signal();
    }
    pub fn kickHook(context: *anyopaque) void {
        const self: *Owner = @ptrCast(@alignCast(context));
        self.kick();
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
            self.published.store(true, .release);
            self.mutex.unlock();
            // Ends the service loop's wait; its tick sees `published` (or,
            // unwired, the I/O generation).
            if (self.config.notify_io) wake_notifier.notifyIo() else wake_notifier.notify();
            self.mutex.lock();
        }
        self.mutex.unlock();
    }
    fn pendingKick(self: *const Owner) bool {
        if (self.kicked) return true;
        const source = self.kick_source orelse return false;
        return !self.source_at_start and source.load(.acquire);
    }
    /// Mutex held on entry and return. Runs once, then keeps running while
    /// the next run is due within the hold window. Each run restarts the
    /// per-run deadline timer; Times advance by elapsed time.
    fn runWhileDue(self: *Owner) anyerror!supervisor.Report {
        const base = self.times;
        var since = self.timer.?;
        var total: supervisor.Report = .{};
        const hold_ns = self.config.hold_ms * std.time.ns_per_ms;
        const continued_at_poll = self.continued_runs;
        while (true) {
            const elapsed_ms = since.read() / std.time.ns_per_ms;
            const times: supervisor.Times = .{ .unix_ms = base.unix_ms +| elapsed_ms, .monotonic_ms = base.monotonic_ms +| elapsed_ms };
            self.kicked = false;
            self.source_at_start = if (self.kick_source) |source| source.load(.acquire) else false;
            if (self.continued_runs != continued_at_poll) {
                self.run_deadline_ms.store(times.monotonic_ms +| self.config.timeout_ms +| 1, .release);
                // A poller already asleep wakes at least every max_wait_ms
                // and then sees this deadline; a shorter timeout needs a wake.
                if (self.config.timeout_ms < supervisor.max_wait_ms) wake_notifier.notify();
            }
            self.mutex.unlock();
            const outcome = self.run_fn(self.context, times, &self.cancel);
            self.mutex.lock();
            self.run_deadline_ms.store(0, .release);
            const report = try outcome;
            total.work +|= report.work;
            total.halt = report.halt;
            total.next_delay_ms = report.next_delay_ms;
            const delay = report.next_delay_ms orelse return total;
            if (hold_ns == 0 or report.halt) return total;
            if (self.stopping or self.cancel.load(.acquire)) return total;
            if (self.timer.?.read() >= self.config.timeout_ms * std.time.ns_per_ms) return total;
            const delay_ns = delay *| std.time.ns_per_ms;
            // Hand back when the next run would start past the hold window,
            // so supervisor health stays fresh; it then sleeps to the delay.
            if (since.read() +| delay_ns >= hold_ns) return total;
            var waited = std.time.Timer.start() catch return total;
            self.waiting = true;
            while (!self.stopping and !self.cancel.load(.acquire) and !self.pendingKick()) {
                const spent = waited.read();
                if (spent >= delay_ns) break;
                self.changed.timedWait(&self.mutex, delay_ns - spent) catch break;
            }
            self.waiting = false;
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
test "due owner keeps cycling on its own thread and hands back one aggregated report past its hold window" {
    var fixture: DueFixture = .{};
    fixture.owner = try Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 1000, .hold_ms = 99 });
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
    try std.testing.expectError(error.InvalidLaneOwnerConfig, Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 10, .hold_ms = supervisor.max_wait_ms + 1 }));
}
test "due owner reports an error at once and the next poll starts a fresh loop" {
    var fixture: DueFixture = .{ .fail_at = 3 };
    fixture.owner = try Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 1000, .hold_ms = 99 });
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
    fixture.owner = try Owner.init(&fixture, DueFixture.run, .{ .timeout_ms = 1000, .hold_ms = 1000 });
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

const CadenceFixture = struct {
    owner: Owner = undefined,
    calls: std.atomic.Value(u32) = .init(0),
    delay_ms: u64 = 500,
    block: std.atomic.Value(bool) = .init(false),
    fn run(context: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        _ = self.calls.fetchAdd(1, .acq_rel);
        while (self.block.load(.acquire) and !cancel.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
        return .{ .work = 1, .next_delay_ms = self.delay_ms };
    }
    fn poll(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        return try self.owner.poll(times, cancel) orelse error.PendingReadIo;
    }
};
test "idle cadence waits on the owner thread and a kick or queued work ends the wait" {
    var fixture: CadenceFixture = .{};
    fixture.owner = try Owner.init(&fixture, CadenceFixture.run, .{ .timeout_ms = 10000, .hold_ms = 1000 });
    defer fixture.owner.deinit();
    var pending: std.atomic.Value(bool) = .init(false);
    fixture.owner.kick_source = &pending;
    var cancel: std.atomic.Value(bool) = .init(false);
    try std.testing.expect((try fixture.owner.poll(.{ .unix_ms = 0, .monotonic_ms = 0 }, &cancel)) == null);
    try waitCount(&fixture.calls, 1);
    // Waiting out its 500 ms cadence inside the hold window: no hand-back.
    fixture.owner.kick();
    try waitCount(&fixture.calls, 2);
    // A source set while the owner waits, then kicked by its writer: runs.
    pending.store(true, .release);
    fixture.owner.kick();
    try waitCount(&fixture.calls, 3);
    // Left set (work the run could not take): the cadence wait resumes; a
    // level-triggered source would rerun without waiting, thousands of times.
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try std.testing.expectEqual(@as(u32, 3), fixture.calls.load(.acquire));
    fixture.owner.mutex.lock();
    const continued = fixture.owner.continued_runs;
    fixture.owner.mutex.unlock();
    try std.testing.expectEqual(@as(u64, 2), continued);
    pending.store(false, .release);
    var timer = try std.time.Timer.start();
    fixture.owner.requestStop();
    fixture.owner.deinit();
    try std.testing.expect(timer.read() < std.time.ns_per_s);
}
test "supervisor resumes an owner-backed task on its publish only, not on I/O or its control wake" {
    var fixture: CadenceFixture = .{ .delay_ms = 100000 };
    fixture.owner = try Owner.init(&fixture, CadenceFixture.run, .{ .timeout_ms = 10000, .hold_ms = 1000, .notify_io = false });
    defer fixture.owner.deinit();
    var control: std.atomic.Value(bool) = .init(false);
    const scheduler = try supervisor.Supervisor.start(std.testing.allocator, &.{.{ .context = &fixture, .run = CadenceFixture.poll, .interval_ms = 100, .timeout_ms = 10000, .wake = &control, .wake_notified = true, .owner_wake = fixture.owner.ownerWake(), .nonblocking = true }});
    defer scheduler.deinit();
    const seen = wake_notifier.current();
    const first = try scheduler.tick(.{ .unix_ms = 0, .monotonic_ms = 0 });
    try std.testing.expectEqual(@as(usize, 1), first.suspended);
    try waitCount(&fixture.calls, 1);
    var timer = try std.time.Timer.start();
    while (!fixture.owner.published.load(.acquire)) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.TestOwnerDidNotPublish;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // The publish notified the service loop and makes the task due now.
    try std.testing.expect(wake_notifier.current() != seen);
    try std.testing.expectEqual(@as(u64, 0), scheduler.nextDelayMs(1));
    const resumed = try scheduler.tick(.{ .unix_ms = 1, .monotonic_ms = 1 });
    try std.testing.expectEqual(@as(usize, 1), resumed.completed);
    try std.testing.expect(!fixture.owner.published.load(.acquire));
    try std.testing.expectEqual(@as(u64, 1), (try scheduler.health(0)).work);
    // Idle owner: due at its report's delay. A control wake's writer
    // notifies; the woken tick runs it at once without making it "due".
    try std.testing.expectEqual(supervisor.max_wait_ms, scheduler.nextDelayMs(1));
    control.store(true, .release);
    try std.testing.expectEqual(supervisor.max_wait_ms, scheduler.nextDelayMs(1));
    fixture.block.store(true, .release);
    const second = try scheduler.tick(.{ .unix_ms = 2, .monotonic_ms = 2 });
    try std.testing.expectEqual(@as(usize, 1), second.started);
    try std.testing.expectEqual(@as(usize, 1), second.suspended);
    // Suspended on its running owner: the still-set control wake and
    // unrelated I/O completions neither re-poll it nor shorten the backstop.
    wake_notifier.notifyIo();
    try waitCount(&fixture.calls, 2);
    try std.testing.expectEqual(supervisor.max_wait_ms, scheduler.nextDelayMs(2));
    try std.testing.expectEqual(@as(usize, 0), (try scheduler.tick(.{ .unix_ms = 3, .monotonic_ms = 3 })).started);
    // The backstop still polls (deadline/cancel observation).
    try std.testing.expectEqual(@as(usize, 1), (try scheduler.tick(.{ .unix_ms = 1002, .monotonic_ms = 1002 })).suspended);
    fixture.block.store(false, .release);
    control.store(false, .release);
    scheduler.stop();
}

test "an unwired owner polled by a pooled task publishes through the I/O generation" {
    var fixture: CadenceFixture = .{ .delay_ms = 100000 };
    fixture.owner = try Owner.init(&fixture, CadenceFixture.run, .{ .timeout_ms = 10000 });
    defer fixture.owner.deinit();
    const scheduler = try supervisor.Supervisor.start(std.testing.allocator, &.{.{ .context = &fixture, .run = CadenceFixture.poll, .interval_ms = 60000, .timeout_ms = 10000 }});
    defer scheduler.deinit();
    const io_before = wake_notifier.ioGeneration();
    _ = try scheduler.tick(.{ .unix_ms = 0, .monotonic_ms = 0 });
    var timer = try std.time.Timer.start();
    // The pooled poll returns PendingReadIo: the task suspends on I/O.
    while ((try scheduler.health(0)).suspended == 0) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.TestTaskDidNotSuspend;
        std.Thread.sleep(std.time.ns_per_ms);
        _ = try scheduler.tick(.{ .unix_ms = 1, .monotonic_ms = 1 });
    }
    while (!fixture.owner.published.load(.acquire)) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.TestOwnerDidNotPublish;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    // Publish bumped the I/O generation: resumable after resume spacing,
    // not only on the poll_slice backstop.
    try std.testing.expect(wake_notifier.ioGeneration() != io_before);
    try std.testing.expect(scheduler.nextDelayMs(1) <= supervisor.resume_spacing_ms);
}

const StallFixture = struct {
    owner: Owner = undefined,
    calls: std.atomic.Value(u32) = .init(0),
    /// Monotonic ns at which the stalled run observed its cancellation.
    cancelled_at: std.atomic.Value(u64) = .init(0),
    stall: bool = false,
    /// Runs before the stalling one (each asks to run again in 1 ms).
    stall_after: u32 = 0,
    stalled_at: std.atomic.Value(u64) = .init(0),
    timer: std.time.Timer = undefined,
    fn run(context: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        const call = self.calls.fetchAdd(1, .acq_rel) + 1;
        if (self.stall and call <= self.stall_after) return .{ .work = 1, .next_delay_ms = 1 };
        if (self.stall) {
            self.stalled_at.store(self.timer.read(), .release);
            while (!cancel.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
            self.cancelled_at.store(self.timer.read(), .release);
            return error.RequestCancelled;
        }
        return .{ .work = 1, .next_delay_ms = 500 };
    }
    fn poll(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *@This() = @ptrCast(@alignCast(context));
        return try self.owner.poll(times, cancel) orelse error.PendingReadIo;
    }
    fn stop(context: *anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.owner.requestStop();
    }
    fn task(self: *@This(), timeout_ms: u64) supervisor.Task {
        return .{ .context = self, .run = poll, .interval_ms = 100, .timeout_ms = timeout_ms, .owner_wake = self.owner.ownerWake(), .owner_deadline = self.owner.ownerDeadline(), .stop_fn = stop, .nonblocking = true };
    }
};
test "supervisor stop ends an owner's idle cadence wait at once, not at its hand-back" {
    var fixture: StallFixture = .{};
    fixture.owner = try Owner.init(&fixture, StallFixture.run, .{ .timeout_ms = 10000, .hold_ms = 1000, .notify_io = false });
    defer fixture.owner.deinit();
    const scheduler = try supervisor.Supervisor.start(std.testing.allocator, &.{fixture.task(10000)});
    defer scheduler.deinit();
    _ = try scheduler.tick(.{ .unix_ms = 0, .monotonic_ms = 0 });
    try waitCount(&fixture.calls, 1);
    // The owner now waits its 500 ms cadence inside the 1 s hold window.
    std.Thread.sleep(5 * std.time.ns_per_ms);
    var timer = try std.time.Timer.start();
    scheduler.stop();
    // stop_fn broadcasts the owner's condvar: the wait ends and it joins.
    fixture.owner.deinit();
    // Generous for a loaded test host; the wait it must not sit out is 500 ms.
    try std.testing.expect(timer.read() < 200 * std.time.ns_per_ms);
    try std.testing.expectEqual(@as(u32, 1), fixture.calls.load(.acquire));
}
fn expectDeadlineCancel(stall_after: u32) !void {
    var fixture: StallFixture = .{ .stall = true, .stall_after = stall_after };
    fixture.timer = try std.time.Timer.start();
    fixture.owner = try Owner.init(&fixture, StallFixture.run, .{ .timeout_ms = 100, .hold_ms = 1000, .notify_io = false });
    defer fixture.owner.deinit();
    const scheduler = try supervisor.Supervisor.start(std.testing.allocator, &.{fixture.task(100)});
    defer scheduler.deinit();
    // The service loop: tick, then sleep to nextDelayMs or a notification.
    const base_ms: u64 = 1000;
    var expired_at: ?u64 = null;
    while (fixture.timer.read() < 5 * std.time.ns_per_s) {
        const seen = wake_notifier.current();
        const now = base_ms + fixture.timer.read() / std.time.ns_per_ms;
        _ = try scheduler.tick(.{ .unix_ms = now, .monotonic_ms = now });
        if ((try scheduler.health(0)).last_error) |err| {
            try std.testing.expectEqual(error.LaneOwnerDeadline, err);
            expired_at = fixture.timer.read();
            break;
        }
        wake_notifier.waitFrom(seen, @max(scheduler.nextDelayMs(now), 1) * std.time.ns_per_ms);
    }
    scheduler.stop();
    // Cancelled at the run's 100 ms deadline (not the 1 s backstop) and
    // reported once it retired. Slack for a loaded test host.
    try std.testing.expect(expired_at != null);
    const stalled = fixture.stalled_at.load(.acquire);
    const cancelled = fixture.cancelled_at.load(.acquire);
    try std.testing.expect(cancelled >= stalled + 50 * std.time.ns_per_ms);
    try std.testing.expect(cancelled < stalled + 400 * std.time.ns_per_ms);
    try std.testing.expect(expired_at.? < stalled + 400 * std.time.ns_per_ms);
}
test "an owner run past its timeout is cancelled at its deadline by the polling supervisor" {
    // First run of a poll, and a run continued on the owner thread.
    try expectDeadlineCancel(0);
    try expectDeadlineCancel(2);
}
