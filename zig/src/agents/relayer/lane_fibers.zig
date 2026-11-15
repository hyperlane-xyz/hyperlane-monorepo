//! Fiber host for one relayer lane's concurrent EVM batch. The lane owner
//! thread itself is the scheduler: it resumes ready fibers, expires timed
//! parks and otherwise sleeps on a condvar until a waker (the RPC pool owner
//! or another thread) posts a fiber. Fibers never leave this thread, and the
//! loop returns only once every fiber it hosts (including adopted Group
//! children) has finished.
const std = @import("std");
const fiber = @import("../../runtime/fiber.zig");

pub const Loop = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    ready_head: ?*fiber.Fiber = null,
    ready_tail: ?*fiber.Fiber = null,
    /// Parked with a deadline; intrusive through `next_ready`, which is free
    /// while a fiber is parked (a fiber is in at most one list).
    timed_head: ?*fiber.Fiber = null,
    live: usize = 0,
    /// The running fiber blocks this thread driving its own socket wait;
    /// a wake for a sibling interrupts it (fiber.Scheduler.set_interrupt).
    interrupt: ?fiber.Interrupt = null,
    /// Work-count evidence: most fibers alive at once, and park count.
    max_live: usize = 0,
    parks: u64 = 0,

    pub fn scheduler(self: *Loop) fiber.Scheduler {
        return .{ .ctx = self, .wake = wake, .adopt = adopt, .has_ready = hasReady, .set_interrupt = setInterrupt };
    }

    /// Off-fiber (the scheduler thread), before or between `run` calls.
    pub fn spawn(self: *Loop, entry: *const fn (arg: *anyopaque) void, arg: *anyopaque) !void {
        const f = try fiber.create(self.scheduler(), entry, arg);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.admit(f);
    }

    /// Runs hosted fibers on the calling thread until none is left.
    pub fn run(self: *Loop) void {
        std.debug.assert(!fiber.inFiber());
        self.mutex.lock();
        while (true) {
            if (self.popReady()) |f| {
                self.mutex.unlock();
                self.step(f);
                self.mutex.lock();
                continue;
            }
            if (self.live == 0) break;
            const now = fiber.monoMs();
            var next: ?i64 = null;
            var link = &self.timed_head;
            while (link.*) |f| {
                const deadline = f.parked_on.waiter.deadline_ms.?;
                // A false expire means a wake already took the fiber: its
                // waker posts it (and unlinks it here) under this mutex.
                if (deadline <= now and f.parked_on.waiter.w.expire(f)) {
                    link.* = f.next_ready;
                    f.timed_out = true;
                    self.pushReady(f);
                    continue;
                }
                if (deadline > now) next = @min(next orelse deadline, deadline);
                link = &f.next_ready;
            }
            if (self.ready_head != null) continue;
            if (next) |deadline| {
                self.cond.timedWait(&self.mutex, @as(u64, @intCast(deadline - now)) * std.time.ns_per_ms) catch {};
            } else self.cond.wait(&self.mutex);
        }
        self.mutex.unlock();
    }

    fn admit(self: *Loop, f: *fiber.Fiber) void {
        self.live += 1;
        self.max_live = @max(self.max_live, self.live);
        self.pushReady(f);
    }

    /// fiber.Scheduler.wake: any thread.
    fn wake(context: *anyopaque, f: *fiber.Fiber) void {
        const self: *Loop = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.unlinkTimed(f);
        self.pushReady(f);
        self.cond.signal();
        if (self.interrupt) |interrupt| interrupt.call(interrupt.ctx);
    }

    /// fiber.Scheduler.has_ready: another fiber of this loop is runnable.
    fn hasReady(context: *anyopaque) bool {
        const self: *Loop = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.ready_head != null;
    }

    fn setInterrupt(context: *anyopaque, interrupt: ?fiber.Interrupt) void {
        const self: *Loop = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.interrupt = interrupt;
    }

    /// fiber.Scheduler.adopt: a Group child spawned by a fiber of this loop.
    fn adopt(context: *anyopaque, f: *fiber.Fiber) void {
        const self: *Loop = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.admit(f);
    }

    /// Resume `f` until it parks or finishes, then publish its park.
    fn step(self: *Loop, f: *fiber.Fiber) void {
        fiber.resumeFiber(f);
        if (fiber.reap(f)) {
            self.mutex.lock();
            self.live -= 1;
            self.mutex.unlock();
            return;
        }
        // Publish under the loop mutex: a waker posts only after `publish`
        // registered the fiber, and its post (which needs this mutex) then
        // finds the fiber already on the timed list.
        self.mutex.lock();
        defer self.mutex.unlock();
        self.parks += 1;
        switch (f.parked_on) {
            .nothing => self.pushReady(f),
            .waiter => |parked| if (parked.w.publish(f)) {
                self.pushReady(f);
            } else if (parked.deadline_ms != null) {
                f.next_ready = self.timed_head;
                self.timed_head = f;
            },
        }
    }

    fn pushReady(self: *Loop, f: *fiber.Fiber) void {
        f.next_ready = null;
        if (self.ready_tail) |tail| tail.next_ready = f else self.ready_head = f;
        self.ready_tail = f;
    }

    fn popReady(self: *Loop) ?*fiber.Fiber {
        const f = self.ready_head orelse return null;
        self.ready_head = f.next_ready;
        if (self.ready_head == null) self.ready_tail = null;
        f.next_ready = null;
        return f;
    }

    fn unlinkTimed(self: *Loop, f: *fiber.Fiber) void {
        var link = &self.timed_head;
        while (link.*) |current| {
            if (current == f) {
                link.* = current.next_ready;
                current.next_ready = null;
                return;
            }
            link = &current.next_ready;
        }
    }
};

/// Batch-position ordering for one side effect (the Lander handoff): position
/// `i` passes only once every earlier position with the same key (origin)
/// has finished, as Source disposes a prepared batch in per-origin order;
/// other keys never wait on each other. Fibers of one Loop only; never waits
/// off a fiber (a sequential caller is already ordered).
pub const Turnstile = struct {
    pub const max = 32;
    count: usize,
    keys: [max]usize = @splat(0),
    done: [max]bool = @splat(false),
    waiters: [max]?*fiber.Waiter = @splat(null),

    pub fn init(count: usize) Turnstile {
        std.debug.assert(count <= max);
        return .{ .count = count };
    }

    fn clear(self: *const Turnstile, position: usize) bool {
        for (self.done[0..position], self.keys[0..position]) |value, key| if (!value and key == self.keys[position]) return false;
        return true;
    }

    pub fn wait(self: *Turnstile, position: usize) void {
        std.debug.assert(position < self.count);
        while (!self.clear(position)) {
            std.debug.assert(fiber.inFiber());
            var waiter: fiber.Waiter = .{};
            self.waiters[position] = &waiter;
            _ = waiter.waitTimeout(null);
            self.waiters[position] = null;
        }
    }

    /// Called exactly once per position, on every exit path.
    pub fn finish(self: *Turnstile, position: usize) void {
        self.done[position] = true;
        for (position + 1..self.count) |later| if (self.waiters[later]) |waiter| if (self.clear(later)) {
            self.waiters[later] = null;
            waiter.wake();
        };
    }
};

/// One-shot event for fibers of one Loop: `wait` parks until `open`.
pub const Latch = struct {
    opened: bool = false,
    waiters: [Turnstile.max]?*fiber.Waiter = @splat(null),

    pub fn wait(self: *Latch, slot: usize) void {
        while (!self.opened) {
            std.debug.assert(fiber.inFiber());
            var waiter: fiber.Waiter = .{};
            self.waiters[slot] = &waiter;
            _ = waiter.waitTimeout(null);
            self.waiters[slot] = null;
        }
    }

    pub fn open(self: *Latch) void {
        self.opened = true;
        for (&self.waiters) |*slot| if (slot.*) |waiter| {
            slot.* = null;
            waiter.wake();
        };
    }
};

// -- tests ------------------------------------------------------------------------

const Probe = struct {
    loop: *Loop,
    in_flight: *usize,
    peak: *usize,
    order: *std.ArrayList(usize),
    turnstile: ?*Turnstile = null,
    position: usize,
    delay_ms: i64,
    fail: bool = false,
    result: ?anyerror = null,

    fn run(arg: *anyopaque) void {
        const self: *Probe = @ptrCast(@alignCast(arg));
        self.in_flight.* += 1;
        self.peak.* = @max(self.peak.*, self.in_flight.*);
        defer self.in_flight.* -= 1;
        defer if (self.turnstile) |gate| gate.finish(self.position);
        // A timed park with no waker: only deadline expiry resumes it.
        var nap: fiber.Waiter = .{};
        std.debug.assert(!nap.waitTimeout(fiber.monoMs() + self.delay_ms));
        if (self.fail) {
            self.result = error.ProbeFailed;
            return;
        }
        if (self.turnstile) |gate| gate.wait(self.position);
        self.order.append(std.testing.allocator, self.position) catch |err| {
            self.result = err;
        };
    }
};

test "lane fiber loop overlaps timed parks, orders handoffs and joins after a failure" {
    var loop: Loop = .{};
    var in_flight: usize = 0;
    var peak: usize = 0;
    var order: std.ArrayList(usize) = .empty;
    defer order.deinit(std.testing.allocator);
    var gate = Turnstile.init(4);
    // Later positions wake first; the handoff order must still follow position.
    const delays = [_]i64{ 40, 25, 5, 1 };
    var probes: [4]Probe = undefined;
    for (&probes, 0..) |*probe, i| {
        probe.* = .{ .loop = &loop, .in_flight = &in_flight, .peak = &peak, .order = &order, .turnstile = &gate, .position = i, .delay_ms = delays[i], .fail = i == 1 };
        try loop.spawn(Probe.run, probe);
    }
    loop.run();
    try std.testing.expectEqual(@as(usize, 0), loop.live);
    try std.testing.expectEqual(@as(usize, 4), peak);
    try std.testing.expectEqual(@as(usize, 4), loop.max_live);
    try std.testing.expectEqualSlices(usize, &.{ 0, 2, 3 }, order.items);
    try std.testing.expectEqual(@as(?anyerror, error.ProbeFailed), probes[1].result);
    for ([_]usize{ 0, 2, 3 }) |i| try std.testing.expectEqual(@as(?anyerror, null), probes[i].result);
}

const CrossWake = struct {
    waiter: fiber.Waiter = .{},
    woken: bool = false,
    early: bool,
    fn run(arg: *anyopaque) void {
        const self: *CrossWake = @ptrCast(@alignCast(arg));
        self.woken = self.waiter.waitTimeout(fiber.monoMs() + 10_000);
    }
    fn waker(self: *CrossWake) void {
        if (!self.early) std.Thread.sleep(20 * std.time.ns_per_ms);
        self.waiter.wake();
    }
};

test "lane turnstile orders handoffs within a key and never across keys" {
    var loop: Loop = .{};
    var in_flight: usize = 0;
    var peak: usize = 0;
    var order: std.ArrayList(usize) = .empty;
    defer order.deinit(std.testing.allocator);
    var gate = Turnstile.init(4);
    // Keys: positions 0 and 2 share one origin, 1 and 3 another. Position 0
    // is slowest: 2 waits for it, but 1 and 3 hand off without waiting.
    gate.keys = .{ 7, 9, 7, 9 } ++ @as([Turnstile.max - 4]usize, @splat(0));
    const delays = [_]i64{ 40, 20, 1, 5 };
    var probes: [4]Probe = undefined;
    for (&probes, 0..) |*probe, i| {
        probe.* = .{ .loop = &loop, .in_flight = &in_flight, .peak = &peak, .order = &order, .turnstile = &gate, .position = i, .delay_ms = delays[i] };
        try loop.spawn(Probe.run, probe);
    }
    loop.run();
    try std.testing.expectEqualSlices(usize, &.{ 1, 3, 0, 2 }, order.items);
}

test "lane fiber loop resumes a fiber woken from another thread before or after it parks" {
    for ([_]bool{ true, false }) |early| {
        var loop: Loop = .{};
        var probe: CrossWake = .{ .early = early };
        if (early) probe.waiter.wake();
        try loop.spawn(CrossWake.run, &probe);
        const thread = if (early) null else try std.Thread.spawn(.{}, CrossWake.waker, .{&probe});
        loop.run();
        if (thread) |value| value.join();
        try std.testing.expect(probe.woken);
        try std.testing.expectEqual(@as(?*fiber.Fiber, null), loop.timed_head);
    }
}

const Parent = struct {
    group: fiber.Group = .{},
    children: [3]fiber.Child = undefined,
    finished: usize = 0,
    fn run(arg: *anyopaque) void {
        const self: *Parent = @ptrCast(@alignCast(arg));
        for (&self.children) |*slot| self.group.spawn(slot, Parent.child, self) catch unreachable;
        self.group.wait();
        std.debug.assert(self.finished == 3);
    }
    fn child(arg: *anyopaque) void {
        const self: *Parent = @ptrCast(@alignCast(arg));
        var nap: fiber.Waiter = .{};
        _ = nap.waitTimeout(fiber.monoMs() + 2);
        self.finished += 1;
    }
};

test "lane fiber loop adopts Group children of its fibers" {
    var loop: Loop = .{};
    var parent: Parent = .{};
    try loop.spawn(Parent.run, &parent);
    loop.run();
    try std.testing.expectEqual(@as(usize, 3), parent.finished);
    try std.testing.expectEqual(@as(usize, 4), loop.max_live);
}
