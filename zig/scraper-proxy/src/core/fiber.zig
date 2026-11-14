//! Stackful fibers (prototype). A request handler runs on a fiber; where it
//! would block on I/O (a database socket, a pool checkout, a join) it parks
//! the fiber and its event loop keeps serving other sockets, then resumes it
//! on the same thread when the wait is over. Code on a fiber reads as
//! ordinary synchronous code; nothing else changes.
//!
//! Scheduling is supplied by the event loop (`Scheduler`); this file only
//! knows how to switch stacks and how a blocking site parks.
//!
//! API for blocking sites (db, graphql):
//!   if (fiber.inFiber()) try fiber.waitFd(fd, events, deadline_ms) else <poll>
//!   var w: fiber.Waiter = .{}; ... w.park() / (another thread) w.wake()
const std = @import("std");
const builtin = @import("builtin");

const posix = std.posix;
const arch = builtin.cpu.arch;

comptime {
    if (arch != .aarch64 and arch != .x86_64) @compileError("core/fiber.zig: aarch64 or x86_64 only");
}

pub const Events = struct {
    pub const read: u32 = 1;
    pub const write: u32 = 2;
};

/// Provided by the event loop that runs fibers on the current thread.
pub const Scheduler = struct {
    ctx: *anyopaque,
    /// Thread-safe: make the parked fiber `f` runnable on its loop again.
    wake: *const fn (ctx: *anyopaque, f: *Fiber) void,
};

/// What a parked fiber waits for. The scheduler publishes the wait only
/// after the fiber has switched out (`resumeFiber` returned), so a waker on
/// another thread can never resume a fiber that is still running.
pub const ParkedOn = union(enum) {
    /// `park()` without a wait (the caller arranges the resume).
    nothing,
    /// `fresh`: see `waitFdAfterSend` (no level check before parking).
    fd: struct { fd: posix.fd_t, events: u32, deadline_ms: ?i64, fresh: bool = false },
    waiter: struct { w: *Waiter, deadline_ms: ?i64 },
    /// `offFiber`: the scheduler runs `func(ctx)` on its own stack, outside
    /// any fiber, then resumes this fiber at once.
    call: struct { func: *const fn (ctx: *anyopaque) void, ctx: *anyopaque },
};

/// Thread-locals that belong to the request running on a fiber (e.g. the
/// GraphQL admission hook): saved and restored around every switch.
pub const Local = struct {
    save: *const fn (out: *LocalBytes) void,
    restore: *const fn (in: *const LocalBytes) void,
};
pub const LocalBytes = [32]u8;

const max_locals = 8;
var locals: [max_locals]Local = undefined;
var locals_len: usize = 0;

/// Call once at startup, before any fiber runs.
pub fn registerLocal(local: Local) void {
    for (locals[0..locals_len]) |l| if (l.save == local.save) return;
    std.debug.assert(locals_len < max_locals);
    locals[locals_len] = local;
    locals_len += 1;
}

/// A `Local` for a thread-local of up to 32 bytes (`ptr` returns its address
/// on the calling thread).
pub fn localOf(comptime T: type, comptime ptr: fn () *T) Local {
    comptime std.debug.assert(@sizeOf(T) <= @sizeOf(LocalBytes));
    const S = struct {
        fn save(out: *LocalBytes) void {
            @memcpy(out[0..@sizeOf(T)], std.mem.asBytes(ptr()));
        }
        fn restore(in: *const LocalBytes) void {
            @memcpy(std.mem.asBytes(ptr()), in[0..@sizeOf(T)]);
        }
    };
    return .{ .save = S.save, .restore = S.restore };
}

pub const Fiber = struct {
    /// Stack pointer saved while suspended.
    sp: usize = 0,
    /// The scheduler's stack pointer while this fiber runs.
    caller_sp: usize = 0,
    stack: []align(std.heap.page_size_min) u8,
    entry: *const fn (arg: *anyopaque) void = undefined,
    arg: *anyopaque = undefined,
    done: bool = false,
    sched: Scheduler = undefined,
    /// Set by the loop when a `waitFd` deadline passed first.
    timed_out: bool = false,
    parked_on: ParkedOn = .nothing,
    /// The loop's timer for a timed `Waiter` wait (loop-owned).
    timer_slot: ?u32 = null,
    /// Free slot for the scheduler (e.g. the waiting registration).
    user: ?*anyopaque = null,
    saved: [max_locals]LocalBytes = undefined,
    next_free: ?*Fiber = null,
};

threadlocal var running: ?*Fiber = null;

pub fn current() ?*Fiber {
    return running;
}

pub fn inFiber() bool {
    return running != null;
}

// -- stacks -----------------------------------------------------------------------

/// Virtual reserve per fiber (only touched pages cost memory): at least 2x
/// the deepest request the GraphQL guards admit (`_not` via variables:
/// 2.5 MiB ReleaseFast, 8.9 MiB Debug), the same as the poller threads.
pub const stack_size: usize = if (builtin.mode == .Debug) 20 * 1024 * 1024 else 8 * 1024 * 1024;
const guard = std.heap.page_size_min;
/// A request deeper than this (canary overwritten) gets its stack pages
/// returned to the OS when the fiber is recycled.
const shallow = 512 * 1024;
const canary: u64 = 0x5a1f_f1be_c0de_d00d;

/// Per-thread free list (fibers never move between threads).
threadlocal var free_list: ?*Fiber = null;
threadlocal var free_count: usize = 0;
const keep_free = 64;

fn canaryPtr(f: *Fiber) *u64 {
    return @ptrFromInt(@intFromPtr(f.stack.ptr) + f.stack.len - shallow);
}

fn allocFiber() !*Fiber {
    if (free_list) |f| {
        free_list = f.next_free;
        free_count -= 1;
        f.next_free = null;
        return f;
    }
    const mem = try posix.mmap(null, stack_size + guard, posix.PROT.READ | posix.PROT.WRITE, mapFlags(), -1, 0);
    errdefer posix.munmap(mem);
    // Guard page at the low end: an overflow faults instead of corrupting.
    try posix.mprotect(mem[0..guard], posix.PROT.NONE);
    const f = try std.heap.c_allocator.create(Fiber);
    f.* = .{ .stack = mem };
    canaryPtr(f).* = canary;
    return f;
}

fn mapFlags() posix.MAP {
    var flags: posix.MAP = .{ .TYPE = .PRIVATE, .ANONYMOUS = true };
    if (@hasField(posix.MAP, "NORESERVE")) flags.NORESERVE = true;
    return flags;
}

fn freeFiber(f: *Fiber) void {
    // A deep request touched pages below the shallow mark: give them back.
    if (canaryPtr(f).* != canary) {
        const lo = std.mem.alignForward(usize, @intFromPtr(f.stack.ptr) + guard, std.heap.page_size_min);
        const hi = std.mem.alignBackward(usize, @intFromPtr(canaryPtr(f)), std.heap.page_size_min);
        if (hi > lo) posix.madvise(@ptrFromInt(lo), hi - lo, posix.MADV.DONTNEED) catch {};
        canaryPtr(f).* = canary;
    }
    if (free_count < keep_free) {
        f.next_free = free_list;
        free_list = f;
        free_count += 1;
        return;
    }
    posix.munmap(f.stack);
    std.heap.c_allocator.destroy(f);
}

/// Releases this thread's cached fibers (call at thread exit).
pub fn releaseThreadCache() void {
    while (free_list) |f| {
        free_list = f.next_free;
        posix.munmap(f.stack);
        std.heap.c_allocator.destroy(f);
    }
    free_count = 0;
}

// -- running ----------------------------------------------------------------------

/// Tests: the next `create` fails (as when stacks run out).
pub var test_fail_create: bool = false;

/// A fiber that will run `entry(arg)` when first resumed.
pub fn create(sched: Scheduler, entry: *const fn (arg: *anyopaque) void, arg: *anyopaque) !*Fiber {
    if (builtin.is_test and test_fail_create) {
        test_fail_create = false;
        return error.OutOfMemory;
    }
    const f = try allocFiber();
    f.entry = entry;
    f.arg = arg;
    f.done = false;
    f.timed_out = false;
    f.sched = sched;
    f.user = null;
    f.parked_on = .nothing;
    // The request inherits the thread's values (normally the defaults).
    for (locals[0..locals_len], 0..) |l, i| l.save(&f.saved[i]);
    f.sp = initialStack(f);
    return f;
}

/// Runs `entry(arg)` on a new detached fiber on the current fiber's loop
/// (it inherits the caller's fiber-locals). Nobody joins it: the loop frees
/// it when it finishes, so `entry` signals its own completion (e.g. a Waiter).
pub fn spawn(entry: *const fn (arg: *anyopaque) void, arg: *anyopaque) !void {
    const parent = running orelse return error.NotOnFiber;
    const f = try create(parent.sched, entry, arg);
    parent.sched.wake(parent.sched.ctx, f);
}

/// Frees a fiber that was created but never resumed.
pub fn destroyUnstarted(f: *Fiber) void {
    freeFiber(f);
}

/// Monotonic milliseconds (the clock `waitFd` deadlines use).
pub fn monoMs() i64 {
    const ts = posix.clock_gettime(.MONOTONIC) catch return 0;
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), std.time.ns_per_ms);
}

/// Switches into `f` (on the calling thread) until it parks or finishes.
pub fn resumeFiber(f: *Fiber) void {
    std.debug.assert(running == null);
    var thread_values: [max_locals]LocalBytes = undefined;
    for (locals[0..locals_len], 0..) |l, i| {
        l.save(&thread_values[i]);
        l.restore(&f.saved[i]);
    }
    f.parked_on = .nothing;
    running = f;
    switchContext(&f.caller_sp, f.sp);
    running = null;
    for (locals[0..locals_len], 0..) |l, i| {
        l.save(&f.saved[i]);
        l.restore(&thread_values[i]);
    }
}

/// After `resumeFiber` returned: release a fiber that finished.
pub fn reap(f: *Fiber) bool {
    if (!f.done) return false;
    freeFiber(f);
    return true;
}

/// Parks the running fiber; returns when the scheduler resumes it.
pub fn park() void {
    const f = running.?;
    switchContext(&f.sp, f.caller_sp);
}

/// Waits for `events` on `fd` (fiber only); error.Timeout at the deadline.
/// Safe after any partial read: before parking, the loop checks the socket's
/// level once (a poll(0)), since bytes the reader left behind raise no edge.
pub fn waitFd(fd: posix.fd_t, events: u32, deadline_ms: ?i64) error{Timeout}!void {
    return parkOnFd(fd, events, deadline_ms, false);
}

/// `waitFd` for input that can only arrive after the caller sent something
/// (the first wait for a reply, with every earlier reply fully read): new
/// data raises an edge, so the loop parks without the level check (no
/// syscall). Edges already seen still resume at once. Do not use it to wait
/// for the rest of a reply the reader may have only partly read.
pub fn waitFdAfterSend(fd: posix.fd_t, events: u32, deadline_ms: ?i64) error{Timeout}!void {
    return parkOnFd(fd, events, deadline_ms, true);
}

fn parkOnFd(fd: posix.fd_t, events: u32, deadline_ms: ?i64, fresh: bool) error{Timeout}!void {
    const f = running.?;
    f.timed_out = false;
    f.parked_on = .{ .fd = .{ .fd = fd, .events = events, .deadline_ms = deadline_ms, .fresh = fresh } };
    park();
    if (f.timed_out) return error.Timeout;
}

/// A one-shot wait for a wake from another thread (pool checkout, join).
/// On a fiber it parks the fiber; elsewhere it blocks the thread.
pub const Waiter = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    /// Published by the scheduler once the fiber is suspended.
    fiber: ?*Fiber = null,
    woken: bool = false,

    pub fn wait(self: *Waiter) void {
        _ = self.waitTimeout(null);
    }

    /// False when the monotonic `deadline_ms` passed before the wake (the
    /// race is decided under the mutex: a wake that won returns true).
    pub fn waitTimeout(self: *Waiter, deadline_ms: ?i64) bool {
        if (running) |f| {
            f.timed_out = false;
            f.parked_on = .{ .waiter = .{ .w = self, .deadline_ms = deadline_ms } };
            park();
            return !f.timed_out;
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        while (!self.woken) {
            if (deadline_ms) |d| {
                const left = d - monoMs();
                if (left <= 0) return false;
                self.cond.timedWait(&self.mutex, @as(u64, @intCast(left)) * std.time.ns_per_ms) catch {};
            } else self.cond.wait(&self.mutex);
        }
        return true;
    }

    pub fn wake(self: *Waiter) void {
        self.mutex.lock();
        self.woken = true;
        const f = self.fiber;
        self.fiber = null;
        self.cond.signal();
        self.mutex.unlock();
        // `self` may be gone now (the waiter returned): only `f` is used.
        if (f) |fib| fib.sched.wake(fib.sched.ctx, fib);
    }

    /// Scheduler side, after the fiber switched out: true when the wake
    /// already happened (resume now), else the waker resumes it later.
    pub fn publish(self: *Waiter, f: *Fiber) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.woken) return true;
        self.fiber = f;
        return false;
    }

    /// Scheduler side, at the deadline: true if `f` was still waiting (it
    /// now times out); false if a wake already took it.
    pub fn expire(self: *Waiter, f: *Fiber) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.fiber != f) return false;
        self.fiber = null;
        return true;
    }
};

/// Runs `func(args...)` on a helper thread and parks the calling fiber until
/// it returns (off a fiber: a plain call). For work that must not run on a
/// fiber stack or block the loop: name resolution, TLS handshakes. If no
/// helper thread can start, it runs inline.
pub fn offload(comptime func: anytype, args: std.meta.ArgsTuple(@TypeOf(func))) @typeInfo(@TypeOf(func)).@"fn".return_type.? {
    const R = @typeInfo(@TypeOf(func)).@"fn".return_type.?;
    if (running == null) return @call(.auto, func, args);
    const Job = struct {
        args: std.meta.ArgsTuple(@TypeOf(func)),
        result: R = undefined,
        done: Waiter = .{},
        fn run(job: *@This()) void {
            job.result = @call(.auto, func, job.args);
            job.done.wake(); // last touch of `job`
        }
    };
    var job: Job = .{ .args = args };
    const thread = std.Thread.spawn(.{}, Job.run, .{&job}) catch return @call(.auto, func, args);
    thread.detach();
    job.done.wait();
    return job.result;
}

/// Runs `func(args...)` on the calling thread but outside the fiber: the
/// fiber switches to its scheduler, which makes the call on its own stack
/// and resumes the fiber straight after (no thread, no wait). For short
/// work that takes OS locks no fiber may hold (e.g. live's loop mutex): a
/// fiber never holds them, so it can never park while holding them. Off a
/// fiber: a plain call. `func` sees the thread's fiber-locals, not the
/// calling fiber's, so never route request-scoped work through it; and it
/// runs on the loop thread, so it must never wait indefinitely.
pub fn offFiber(comptime func: anytype, args: std.meta.ArgsTuple(@TypeOf(func))) @typeInfo(@TypeOf(func)).@"fn".return_type.? {
    const R = @typeInfo(@TypeOf(func)).@"fn".return_type.?;
    const f = running orelse return @call(.auto, func, args);
    const Call = struct {
        args: std.meta.ArgsTuple(@TypeOf(func)),
        result: R = undefined,
        fn run(ctx: *anyopaque) void {
            const c: *@This() = @ptrCast(@alignCast(ctx));
            c.result = @call(.auto, func, c.args);
        }
    };
    var call: Call = .{ .args = args };
    f.parked_on = .{ .call = .{ .func = Call.run, .ctx = &call } };
    park();
    return call.result;
}

threadlocal var event_loop_thread: bool = false;

/// True on an HTTP event-loop thread (a pinned fiber loop or a poller), on
/// its fibers too. Owners assert it is false where they may wait without
/// bound (e.g. live's loop waits): the loop thread must never do that.
pub fn onEventLoopThread() bool {
    return event_loop_thread;
}

/// Set by the event loop on each of its threads at start.
pub fn setEventLoopThread(on: bool) void {
    event_loop_thread = on;
}

/// Set by the event loop: drop the registration for `fd` (the owner is
/// about to close it; the number may be reused).
pub var fd_closing: ?*const fn (fd: posix.fd_t) void = null;

/// Call before closing an fd that `waitFd` may have registered.
pub fn forgetFd(fd: posix.fd_t) void {
    if (fd_closing) |f| f(fd);
}

// -- test scheduler -----------------------------------------------------------------

/// A minimal poll()-based scheduler for module tests that have no HTTP loop
/// (db, graphql): `testing.run(entry, arg)` runs `entry(arg)` on a fiber on
/// the calling thread, with every wait (`waitFd`, `Waiter`, `offload`,
/// `spawn`) working as on the real loop, and returns once it and every fiber
/// it spawned finished. Not for production: one poll() per round, O(n) lists.
pub const testing = struct {
    const gpa = std.heap.c_allocator;

    const FdPark = struct { f: *Fiber, fd: posix.fd_t, events: i16, deadline: ?i64 };
    const TimerPark = struct { f: *Fiber, w: *Waiter, deadline: i64 };

    const Loop = struct {
        mutex: std.Thread.Mutex = .{},
        /// Woken from any thread (`Scheduler.wake`).
        posted: std.ArrayListUnmanaged(*Fiber) = .empty,
        pipe: [2]posix.fd_t,
        ready: std.ArrayListUnmanaged(*Fiber) = .empty,
        fds: std.ArrayListUnmanaged(FdPark) = .empty,
        timers: std.ArrayListUnmanaged(TimerPark) = .empty,
        /// Started and not finished.
        live: std.AutoHashMapUnmanaged(*Fiber, void) = .empty,

        fn wake(ctx: *anyopaque, f: *Fiber) void {
            const self: *Loop = @ptrCast(@alignCast(ctx));
            self.mutex.lock();
            self.posted.append(gpa, f) catch @panic("fiber.testing: out of memory");
            self.mutex.unlock();
            _ = posix.write(self.pipe[1], "x") catch {};
        }

        fn step(self: *Loop, f: *Fiber) !void {
            // A timed wait that ended by a wake: drop its timer.
            var i: usize = self.timers.items.len;
            while (i > 0) {
                i -= 1;
                if (self.timers.items[i].f == f) _ = self.timers.swapRemove(i);
            }
            try self.live.put(gpa, f, {});
            resumeFiber(f);
            if (reap(f)) {
                _ = self.live.remove(f);
                return;
            }
            switch (f.parked_on) {
                .nothing => {},
                .call => |c| {
                    c.func(c.ctx);
                    try self.ready.append(gpa, f);
                },
                .waiter => |p| {
                    if (p.w.publish(f)) return self.ready.append(gpa, f);
                    if (p.deadline_ms) |d| try self.timers.append(gpa, .{ .f = f, .w = p.w, .deadline = d });
                },
                .fd => |p| {
                    var ev: i16 = 0;
                    if (p.events & Events.read != 0) ev |= posix.POLL.IN;
                    if (p.events & Events.write != 0) ev |= posix.POLL.OUT;
                    try self.fds.append(gpa, .{ .f = f, .fd = p.fd, .events = ev, .deadline = p.deadline_ms });
                },
            }
        }

        fn pollOnce(self: *Loop) !void {
            var pfds: std.ArrayListUnmanaged(posix.pollfd) = .empty;
            defer pfds.deinit(gpa);
            try pfds.append(gpa, .{ .fd = self.pipe[0], .events = posix.POLL.IN, .revents = 0 });
            var next: ?i64 = null;
            for (self.fds.items) |p| {
                try pfds.append(gpa, .{ .fd = p.fd, .events = p.events, .revents = 0 });
                if (p.deadline) |d| next = if (next) |n| @min(n, d) else d;
            }
            for (self.timers.items) |t| next = if (next) |n| @min(n, t.deadline) else t.deadline;
            const timeout: i32 = if (next) |n| @intCast(std.math.clamp(n - monoMs(), 0, 60_000)) else -1;
            _ = try posix.poll(pfds.items, timeout);
            var sink: [64]u8 = undefined;
            while (true) _ = posix.read(self.pipe[0], &sink) catch break;
            const now = monoMs();
            // pfds[1..] mirrors fds: walk both backwards while removing.
            var i: usize = self.fds.items.len;
            while (i > 0) {
                i -= 1;
                const p = self.fds.items[i];
                const ready = pfds.items[i + 1].revents != 0;
                const expired = if (p.deadline) |d| d <= now else false;
                if (!ready and !expired) continue;
                _ = self.fds.orderedRemove(i);
                p.f.timed_out = !ready;
                try self.ready.append(gpa, p.f);
            }
            i = self.timers.items.len;
            while (i > 0) {
                i -= 1;
                const t = self.timers.items[i];
                if (t.deadline > now) continue;
                _ = self.timers.swapRemove(i);
                // A wake that won is already posted.
                if (t.w.expire(t.f)) {
                    t.f.timed_out = true;
                    try self.ready.append(gpa, t.f);
                }
            }
        }
    };

    pub fn run(entry: *const fn (arg: *anyopaque) void, arg: *anyopaque) !void {
        var loop: Loop = .{ .pipe = try posix.pipe2(.{ .NONBLOCK = true, .CLOEXEC = true }) };
        defer {
            posix.close(loop.pipe[0]);
            posix.close(loop.pipe[1]);
            loop.posted.deinit(gpa);
            loop.ready.deinit(gpa);
            loop.fds.deinit(gpa);
            loop.timers.deinit(gpa);
            loop.live.deinit(gpa);
        }
        const root = try create(.{ .ctx = &loop, .wake = Loop.wake }, entry, arg);
        try loop.ready.append(gpa, root);
        while (true) {
            while (loop.ready.items.len > 0) try loop.step(loop.ready.orderedRemove(0));
            loop.mutex.lock();
            try loop.ready.appendSlice(gpa, loop.posted.items);
            loop.posted.clearRetainingCapacity();
            loop.mutex.unlock();
            if (loop.ready.items.len > 0) continue;
            if (loop.live.count() == 0) return;
            try loop.pollOnce();
        }
    }
};

// -- context switch -----------------------------------------------------------------

/// Saves callee-saved registers on the current stack, stores the stack
/// pointer in `save`, switches to `to` and restores what is saved there.
extern fn szigFiberSwitch(save: *usize, to: usize) void;
extern fn szigFiberTrampoline() void;

fn switchContext(save: *usize, to: usize) void {
    szigFiberSwitch(save, to);
}

export fn szigFiberMain(f: *Fiber) callconv(.c) noreturn {
    f.entry(f.arg);
    f.done = true;
    switchContext(&f.sp, f.caller_sp);
    unreachable;
}

const sym_prefix = if (builtin.os.tag.isDarwin()) "_" else "";

comptime {
    switch (arch) {
        .aarch64 => asm (
            \\.text
            \\.p2align 2
            \\.global _szigFiberSwitch
            \\.global szigFiberSwitch
            \\_szigFiberSwitch:
            \\szigFiberSwitch:
            \\  sub sp, sp, #0xb0
            \\  stp x19, x20, [sp, #0x00]
            \\  stp x21, x22, [sp, #0x10]
            \\  stp x23, x24, [sp, #0x20]
            \\  stp x25, x26, [sp, #0x30]
            \\  stp x27, x28, [sp, #0x40]
            \\  stp x29, x30, [sp, #0x50]
            \\  stp d8, d9, [sp, #0x60]
            \\  stp d10, d11, [sp, #0x70]
            \\  stp d12, d13, [sp, #0x80]
            \\  stp d14, d15, [sp, #0x90]
            \\  mov x2, sp
            \\  str x2, [x0]
            \\  mov sp, x1
            \\  ldp x19, x20, [sp, #0x00]
            \\  ldp x21, x22, [sp, #0x10]
            \\  ldp x23, x24, [sp, #0x20]
            \\  ldp x25, x26, [sp, #0x30]
            \\  ldp x27, x28, [sp, #0x40]
            \\  ldp x29, x30, [sp, #0x50]
            \\  ldp d8, d9, [sp, #0x60]
            \\  ldp d10, d11, [sp, #0x70]
            \\  ldp d12, d13, [sp, #0x80]
            \\  ldp d14, d15, [sp, #0x90]
            \\  add sp, sp, #0xb0
            \\  ret
            \\.global _szigFiberTrampoline
            \\.global szigFiberTrampoline
            \\_szigFiberTrampoline:
            \\szigFiberTrampoline:
            \\  mov x0, x19
            \\  bl 
        ++ sym_prefix ++ "szigFiberMain\n" ++
            \\  brk #0
            \\
        ),
        .x86_64 => asm (
            \\.text
            \\.global szigFiberSwitch
            \\szigFiberSwitch:
            \\  pushq %rbp
            \\  pushq %rbx
            \\  pushq %r12
            \\  pushq %r13
            \\  pushq %r14
            \\  pushq %r15
            \\  movq %rsp, (%rdi)
            \\  movq %rsi, %rsp
            \\  popq %r15
            \\  popq %r14
            \\  popq %r13
            \\  popq %r12
            \\  popq %rbx
            \\  popq %rbp
            \\  retq
            \\.global szigFiberTrampoline
            \\szigFiberTrampoline:
            \\  movq %r15, %rdi
            \\  andq $-16, %rsp
            \\  callq 
        ++ sym_prefix ++ "szigFiberMain\n" ++
            \\  ud2
            \\
        ),
        else => unreachable,
    }
}

/// A suspended frame that `szigFiberSwitch` restores into the trampoline,
/// which calls `szigFiberMain(f)`.
fn initialStack(f: *Fiber) usize {
    const top = std.mem.alignBackward(usize, @intFromPtr(f.stack.ptr) + f.stack.len, 16);
    switch (arch) {
        .aarch64 => {
            const sp = top - 0xb0;
            const regs: [*]usize = @ptrFromInt(sp);
            @memset(regs[0 .. 0xb0 / 8], 0);
            regs[0] = @intFromPtr(f); // x19
            regs[10] = 0; // x29 (frame pointer: end of chain)
            regs[11] = @intFromPtr(&szigFiberTrampoline); // x30 (return address)
            return sp;
        },
        .x86_64 => {
            // pops r15, r14, r13, r12, rbx, rbp, then `ret` to the trampoline.
            const sp = top - 8 * 8;
            const regs: [*]usize = @ptrFromInt(sp);
            @memset(regs[0..8], 0);
            regs[0] = @intFromPtr(f); // r15
            regs[6] = @intFromPtr(&szigFiberTrampoline);
            return sp;
        },
        else => unreachable,
    }
}

test "fibers switch, park and resume with their own locals" {
    const State = struct {
        threadlocal var value: usize = 0;
        fn ptr() *usize {
            return &value;
        }
    };
    registerLocal(localOf(usize, State.ptr));
    defer locals_len -= 1;
    const Ctx = struct {
        steps: std.ArrayList(u8) = .empty,
        fn run(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            State.value = 7;
            self.steps.append(std.testing.allocator, 'a') catch {};
            park();
            self.steps.append(std.testing.allocator, if (State.value == 7) 'b' else 'x') catch {};
        }
    };
    const sched: Scheduler = .{ .ctx = undefined, .wake = undefined };
    var ctx: Ctx = .{};
    defer ctx.steps.deinit(std.testing.allocator);
    State.value = 1;
    const f = try create(sched, Ctx.run, &ctx);
    resumeFiber(f);
    try std.testing.expect(!f.done);
    try std.testing.expectEqual(@as(usize, 1), State.value); // the thread's own value
    try std.testing.expectEqualStrings("a", ctx.steps.items);
    resumeFiber(f);
    try std.testing.expect(reap(f));
    try std.testing.expectEqualStrings("ab", ctx.steps.items);
    try std.testing.expectEqual(@as(usize, 1), State.value);
    releaseThreadCache();
}

test "testing.run: fd waits, timed and woken Waiters, offload and spawn" {
    const Ctx = struct {
        pipe: [2]posix.fd_t,
        got: u8 = 0,
        timed_out: bool = false,
        woken: bool = false,
        child_ran: bool = false,
        offloaded: u32 = 0,
        child_done: Waiter = .{},

        fn writer(fd: posix.fd_t) void {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            _ = posix.write(fd, "k") catch {};
        }
        fn waker(w: *Waiter) void {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            w.wake();
        }
        fn twice(x: u32) u32 {
            return x * 2;
        }
        fn child(arg: *anyopaque) void {
            const c: *@This() = @ptrCast(@alignCast(arg));
            var w: Waiter = .{};
            _ = w.waitTimeout(monoMs() + 5);
            c.child_ran = true;
            c.child_done.wake();
        }
        fn main(arg: *anyopaque) void {
            const c: *@This() = @ptrCast(@alignCast(arg));
            const t = std.Thread.spawn(.{}, writer, .{c.pipe[1]}) catch return;
            waitFd(c.pipe[0], Events.read, monoMs() + 5_000) catch return;
            t.join();
            var b: [1]u8 = undefined;
            _ = posix.read(c.pipe[0], &b) catch return;
            c.got = b[0];
            var never: Waiter = .{};
            c.timed_out = !never.waitTimeout(monoMs() + 10);
            var w: Waiter = .{};
            const t2 = std.Thread.spawn(.{}, waker, .{&w}) catch return;
            c.woken = w.waitTimeout(monoMs() + 5_000);
            t2.join();
            c.offloaded = offload(twice, .{21});
            spawn(child, c) catch return;
            c.child_done.wait();
        }
    };
    var c: Ctx = .{ .pipe = try posix.pipe2(.{ .NONBLOCK = true, .CLOEXEC = true }) };
    defer {
        posix.close(c.pipe[0]);
        posix.close(c.pipe[1]);
    }
    try testing.run(Ctx.main, &c);
    try std.testing.expectEqual(@as(u8, 'k'), c.got);
    try std.testing.expect(c.timed_out);
    try std.testing.expect(c.woken);
    try std.testing.expectEqual(@as(u32, 42), c.offloaded);
    try std.testing.expect(c.child_ran);
}

test "offFiber runs the call outside the fiber, on the same thread, and returns its result" {
    const Ctx = struct {
        thread: std.Thread.Id = 0,
        inside_thread: std.Thread.Id = 0,
        inside_fiber: bool = true,
        result: u32 = 0,
        fn work(c: *@This(), x: u32) u32 {
            c.inside_fiber = inFiber();
            c.inside_thread = std.Thread.getCurrentId();
            return x + 1;
        }
        fn main(arg: *anyopaque) void {
            const c: *@This() = @ptrCast(@alignCast(arg));
            c.thread = std.Thread.getCurrentId();
            c.result = offFiber(work, .{ c, 41 });
        }
    };
    var c: Ctx = .{};
    try testing.run(Ctx.main, &c);
    try std.testing.expectEqual(@as(u32, 42), c.result);
    try std.testing.expect(!c.inside_fiber);
    try std.testing.expectEqual(c.thread, c.inside_thread);
}
