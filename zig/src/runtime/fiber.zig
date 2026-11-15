//! Stackful fibers for retained task callbacks (ported from the scraper-proxy
//! core/fiber.zig). Code on a fiber reads as ordinary synchronous code; where
//! it would wait for a read it parks on a `Waiter`, and its host thread runs
//! other fibers until a waker (any thread) makes it runnable again. A fiber
//! never moves between threads: TLS addresses cached across a park stay valid.
//!
//! The scheduler (`Scheduler`) is supplied by the host loop (runtime/io_pool).
const std = @import("std");
const builtin = @import("builtin");

const posix = std.posix;
const arch = builtin.cpu.arch;

comptime {
    if (arch != .aarch64 and arch != .x86_64) @compileError("runtime/fiber.zig: aarch64 or x86_64 only");
}

/// Provided by the loop that runs fibers on the current thread.
pub const Scheduler = struct {
    ctx: *anyopaque,
    /// Thread-safe: make the parked fiber `f` runnable on its loop again.
    wake: *const fn (ctx: *anyopaque, f: *Fiber) void,
    /// Take ownership of a newly spawned fiber and make it runnable (the loop
    /// reaps it when it finishes). Null: this loop does not support spawn.
    adopt: ?*const fn (ctx: *anyopaque, f: *Fiber) void = null,
    /// True when another fiber on this loop is runnable now.
    has_ready: ?*const fn (ctx: *anyopaque) bool = null,
    /// While the running fiber blocks its thread (e.g. driving a socket
    /// wait), a wake for another fiber on this loop calls `interrupt`.
    set_interrupt: ?*const fn (ctx: *anyopaque, interrupt: ?Interrupt) void = null,
};

pub const Interrupt = struct { ctx: *anyopaque, call: *const fn (ctx: *anyopaque) void };

/// On a fiber: may it block its thread now? Only when the loop supports
/// interrupts and no sibling fiber is runnable. Off a fiber: always.
pub fn mayBlockThread() bool {
    const f = running orelse return true;
    const has_ready = f.sched.has_ready orelse return false;
    if (f.sched.set_interrupt == null) return false;
    return !has_ready(f.sched.ctx);
}

/// On a fiber: another fiber on this loop became runnable.
pub fn siblingReady() bool {
    const f = running orelse return false;
    const has_ready = f.sched.has_ready orelse return true;
    return has_ready(f.sched.ctx);
}

/// Register (or clear with null) the running fiber's thread-block interrupt.
pub fn setInterrupt(interrupt: ?Interrupt) void {
    const f = running orelse return;
    if (f.sched.set_interrupt) |set| set(f.sched.ctx, interrupt);
}

pub const ParkedOn = union(enum) {
    nothing,
    waiter: struct { w: *Waiter, deadline_ms: ?i64 },
};

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
    /// Set by the loop when a timed wait's deadline passed first.
    timed_out: bool = false,
    parked_on: ParkedOn = .nothing,
    /// Free slot for the scheduler (e.g. the job that owns this fiber).
    user: ?*anyopaque = null,
    next_free: ?*Fiber = null,
    /// Scheduler-owned ready-queue link.
    next_ready: ?*Fiber = null,
};

threadlocal var running: ?*Fiber = null;

pub fn current() ?*Fiber {
    return running;
}

pub fn inFiber() bool {
    return running != null;
}

// -- stacks -----------------------------------------------------------------------

/// Virtual reserve per fiber; only touched pages cost memory. Matches the
/// role callbacks' worker threads (default 16 MiB Zig thread stacks would be
/// excessive; agents run with <1 MiB measured depth, lane owners use 1 MiB).
pub const stack_size: usize = if (builtin.mode == .Debug) 16 * 1024 * 1024 else 8 * 1024 * 1024;
const guard = std.heap.page_size_min;
/// A callback deeper than this (canary overwritten) has its stack pages
/// returned to the OS when the fiber is recycled.
const shallow = 512 * 1024;
const canary: u64 = 0x5a1f_f1be_c0de_d00d;

/// Per-thread free list (fibers never move between threads).
threadlocal var free_list: ?*Fiber = null;
threadlocal var free_count: usize = 0;
const keep_free = 16;

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

/// A fiber that will run `entry(arg)` when first resumed.
pub fn create(sched: Scheduler, entry: *const fn (arg: *anyopaque) void, arg: *anyopaque) !*Fiber {
    const f = try allocFiber();
    f.entry = entry;
    f.arg = arg;
    f.done = false;
    f.timed_out = false;
    f.sched = sched;
    f.user = null;
    f.parked_on = .nothing;
    f.sp = initialStack(f);
    return f;
}

/// Monotonic milliseconds (the clock `Waiter` deadlines use).
pub fn monoMs() i64 {
    const ts = posix.clock_gettime(.MONOTONIC) catch return 0;
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), std.time.ns_per_ms);
}

/// Switches into `f` (on the calling thread) until it parks or finishes.
pub fn resumeFiber(f: *Fiber) void {
    std.debug.assert(running == null);
    f.parked_on = .nothing;
    running = f;
    switchContext(&f.caller_sp, f.sp);
    running = null;
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

/// A one-shot wait for a wake from another thread. On a fiber it parks the
/// fiber (its host keeps running other fibers); elsewhere it blocks the thread.
pub const Waiter = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    /// Published by the scheduler once the fiber is suspended.
    fiber: ?*Fiber = null,
    woken: bool = false,

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

// -- structured concurrency ----------------------------------------------------------

/// Storage for one `Group` child; embed it in the child's own state.
pub const Child = struct {
    group: *Group = undefined,
    entry: *const fn (arg: *anyopaque) void = undefined,
    arg: *anyopaque = undefined,
};

/// Spawn/join: children run as sibling fibers on the caller's loop (their
/// waits overlap); `wait` parks until every child returned. Off a fiber, or on
/// a loop without spawn support, `spawn` runs the child inline.
pub const Group = struct {
    mutex: std.Thread.Mutex = .{},
    pending: usize = 0,
    waiter: ?*Waiter = null,

    pub fn spawn(self: *Group, child: *Child, entry: *const fn (arg: *anyopaque) void, arg: *anyopaque) !void {
        child.* = .{ .group = self, .entry = entry, .arg = arg };
        const parent = running orelse return entry(arg);
        const adopt = parent.sched.adopt orelse return entry(arg);
        const f = try create(parent.sched, childMain, child);
        self.mutex.lock();
        self.pending += 1;
        self.mutex.unlock();
        adopt(parent.sched.ctx, f);
    }

    /// Returns once every spawned child has returned.
    pub fn wait(self: *Group) void {
        while (true) {
            var waiter: Waiter = .{};
            self.mutex.lock();
            if (self.pending == 0) {
                self.mutex.unlock();
                return;
            }
            self.waiter = &waiter;
            self.mutex.unlock();
            _ = waiter.waitTimeout(null);
        }
    }

    fn childMain(arg: *anyopaque) void {
        const child: *Child = @ptrCast(@alignCast(arg));
        child.entry(child.arg);
        const self = child.group;
        // Wake under the mutex: `wait` re-reads `waiter` under it, so the
        // Waiter (on the parent's stack) is alive for the whole wake.
        self.mutex.lock();
        defer self.mutex.unlock();
        self.pending -= 1;
        if (self.pending == 0) if (self.waiter) |waiter| {
            self.waiter = null;
            waiter.wake();
        };
    }
};

// -- context switch -----------------------------------------------------------------

/// Saves callee-saved registers on the current stack, stores the stack
/// pointer in `save`, switches to `to` and restores what is saved there.
/// Naked functions (not file-level asm) so every backend, including the
/// self-hosted x86_64 Debug backend, can assemble them.
fn hypFiberSwitch() callconv(.naked) void {
    switch (arch) {
        .aarch64 => asm volatile (
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
        ),
        .x86_64 => asm volatile (
            \\  pushq %%rbp
            \\  pushq %%rbx
            \\  pushq %%r12
            \\  pushq %%r13
            \\  pushq %%r14
            \\  pushq %%r15
            \\  movq %%rsp, (%%rdi)
            \\  movq %%rsi, %%rsp
            \\  popq %%r15
            \\  popq %%r14
            \\  popq %%r13
            \\  popq %%r12
            \\  popq %%rbx
            \\  popq %%rbp
            \\  retq
        ),
        else => unreachable,
    }
}

/// First frame of a fresh fiber: moves `f` (restored into a callee-saved
/// register by the switch) into the first argument and calls hypFiberMain.
fn hypFiberTrampoline() callconv(.naked) noreturn {
    switch (arch) {
        .aarch64 => asm volatile (
            \\  mov x0, x19
            \\  bl %[main]
            \\  brk #0
            :
            : [main] "X" (&hypFiberMain),
        ),
        .x86_64 => asm volatile (
            \\  movq %%r15, %%rdi
            \\  andq $-16, %%rsp
            \\  callq %[main:P]
            \\  ud2
            :
            : [main] "X" (&hypFiberMain),
        ),
        else => unreachable,
    }
}

const SwitchFn = *const fn (save: *usize, to: usize) callconv(.c) void;

fn switchContext(save: *usize, to: usize) void {
    // A naked function is entered with the C argument registers intact.
    const switch_fn: SwitchFn = @ptrCast(&hypFiberSwitch);
    switch_fn(save, to);
}

fn hypFiberMain(f: *Fiber) callconv(.c) noreturn {
    f.entry(f.arg);
    f.done = true;
    switchContext(&f.sp, f.caller_sp);
    unreachable;
}

/// A suspended frame that `hypFiberSwitch` restores into the trampoline,
/// which calls `hypFiberMain(f)`.
fn initialStack(f: *Fiber) usize {
    const top = std.mem.alignBackward(usize, @intFromPtr(f.stack.ptr) + f.stack.len, 16);
    switch (arch) {
        .aarch64 => {
            const sp = top - 0xb0;
            const regs: [*]usize = @ptrFromInt(sp);
            @memset(regs[0 .. 0xb0 / 8], 0);
            regs[0] = @intFromPtr(f); // x19
            regs[10] = 0; // x29 (frame pointer: end of chain)
            regs[11] = @intFromPtr(&hypFiberTrampoline); // x30 (return address)
            return sp;
        },
        .x86_64 => {
            // pops r15, r14, r13, r12, rbx, rbp, then `ret` to the trampoline.
            const sp = top - 8 * 8;
            const regs: [*]usize = @ptrFromInt(sp);
            @memset(regs[0..8], 0);
            regs[0] = @intFromPtr(f); // r15
            regs[6] = @intFromPtr(&hypFiberTrampoline);
            return sp;
        },
        else => unreachable,
    }
}

test "fibers switch, park and resume on their host thread" {
    const Ctx = struct {
        steps: [4]u8 = undefined,
        len: usize = 0,
        fn run(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            self.steps[self.len] = 'a';
            self.len += 1;
            park();
            self.steps[self.len] = 'b';
            self.len += 1;
        }
    };
    const sched: Scheduler = .{ .ctx = undefined, .wake = undefined };
    var ctx: Ctx = .{};
    const f = try create(sched, Ctx.run, &ctx);
    resumeFiber(f);
    try std.testing.expect(!f.done);
    try std.testing.expectEqualStrings("a", ctx.steps[0..ctx.len]);
    resumeFiber(f);
    try std.testing.expect(reap(f));
    try std.testing.expectEqualStrings("ab", ctx.steps[0..ctx.len]);
    releaseThreadCache();
}

test "a Waiter blocks a plain thread until woken or its deadline" {
    var never: Waiter = .{};
    try std.testing.expect(!never.waitTimeout(monoMs() + 10));
    var w: Waiter = .{};
    const Waker = struct {
        fn run(target: *Waiter) void {
            std.Thread.sleep(10 * std.time.ns_per_ms);
            target.wake();
        }
    };
    const thread = try std.Thread.spawn(.{}, Waker.run, .{&w});
    try std.testing.expect(w.waitTimeout(monoMs() + 5000));
    thread.join();
}
