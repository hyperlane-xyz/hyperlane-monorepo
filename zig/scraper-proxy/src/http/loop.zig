//! Evented core: one epoll (Linux) / kqueue (macOS) set served by an elastic
//! pool of poller threads (leader/followers). Whichever thread receives an
//! event runs the whole step for that socket (read, parse, hooks that may
//! block, write); a thread leaving the poller with no other waiter starts one
//! more, so a blocked hook never stalls the set. See IMPLEMENTATION.md.
//!
//! Sockets are slots in a chunked slab. Registrations are edge-triggered and
//! carry `index | generation << 32`. A slot's state word holds the generation
//! and tokens: an event CASes a token, or sets the matching AGAIN bit when
//! another thread holds it; the holder re-runs before it can release. So
//! exactly one thread drives a socket direction at a time, no edge is lost,
//! and events for a closed (or reused) slot fail the generation check.
const std = @import("std");
const builtin = @import("builtin");
const core = @import("core");

const posix = std.posix;
const linux = std.os.linux;
const is_linux = builtin.os.tag == .linux;
const is_darwin = builtin.os.tag.isDarwin();

comptime {
    if (!is_linux and !is_darwin) @compileError("http/loop.zig needs epoll (Linux) or kqueue (macOS)");
}

const log = std.log.scoped(.http_loop);

/// State word bits (low 32 bits; the generation is the high 32).
pub const R: u32 = 1 << 0; // reader / HTTP owner token
pub const R_AGAIN: u32 = 1 << 1; // input (or any HTTP event) while R was held
pub const W: u32 = 1 << 2; // WebSocket writer token
pub const W_AGAIN: u32 = 1 << 3; // output requested while W was held
pub const KICK: u32 = 1 << 4; // timer expiry / server close: re-evaluate
pub const R_DONE: u32 = 1 << 5; // WebSocket reader finished: W holder tears down
pub const WANT_W: u32 = 1 << 6; // WebSocket frames wait: writable events matter
pub const R_HUP: u32 = 1 << 7; // peer hangup/error seen while R was held

/// Pending bits an R holder must handle before it can release.
pub const r_pending: u32 = R_AGAIN | KICK | R_HUP;

/// What woke a reader: nothing (kick/post), input, or input plus hangup.
pub const Io = enum {
    none,
    io,
    hup,

    pub fn fromPending(pending: u32) Io {
        if (pending & R_HUP != 0) return .hup;
        if (pending & R_AGAIN != 0) return .io;
        return .none;
    }
};

pub const no_deadline: i64 = std.math.maxInt(i64);

pub const Kind = enum(u8) { free, listener, http, ws };

pub const Slot = struct {
    state: std.atomic.Value(u64) = .init(0),
    /// Monotonic ms after which the slot is `KICK`ed (`no_deadline`: never).
    /// Set with `Loop.setDeadline`.
    deadline: std.atomic.Value(i64) = .init(no_deadline),
    /// Key of this slot's entry in the timer heap (`no_deadline`: none). It
    /// is never later than `deadline`: an extended deadline is re-armed when
    /// the earlier entry fires, so most parks take no lock.
    armed: std.atomic.Value(i64) = .init(no_deadline),
    /// Position in the timer heap (timer mutex).
    heap_pos: u32 = none,
    kind: Kind = .free,
    ptr: ?*anyopaque = null,
    next_free: u32 = none,

    pub fn genOf(word: u64) u32 {
        return @truncate(word >> 32);
    }

    pub fn bitsOf(word: u64) u32 {
        return @truncate(word);
    }

    pub fn gen(self: *const Slot) u32 {
        return genOf(self.state.load(.acquire));
    }
};

const none: u32 = std.math.maxInt(u32);

pub const Claim = enum { claimed, busy, stale };

/// Takes `token` for generation `g`, or records `again` for its holder.
pub fn claim(slot: *Slot, g: u32, token: u32, again: u32) Claim {
    var s = slot.state.load(.acquire);
    while (true) {
        if (Slot.genOf(s) != g) return .stale;
        const held = Slot.bitsOf(s) & token != 0;
        const next = if (held) s | again else s | token;
        if (next == s) return .busy;
        if (slot.state.cmpxchgWeak(s, next, .acq_rel, .acquire)) |actual| {
            s = actual;
            continue;
        }
        return if (held) .busy else .claimed;
    }
}

/// Sets `bits` (e.g. `R_DONE`) while holding a token.
pub fn setBits(slot: *Slot, bits: u32) void {
    _ = slot.state.fetchOr(bits, .acq_rel);
}

pub fn clearBits(slot: *Slot, bits: u32) void {
    _ = slot.state.fetchAnd(~@as(u64, bits), .acq_rel);
}

/// Releases `token` unless one of `pending` arrived meanwhile: then clears
/// and returns those bits, and the caller still holds the token.
pub fn release(slot: *Slot, token: u32, pending: u32) u32 {
    var s = slot.state.load(.acquire);
    while (true) {
        const p = Slot.bitsOf(s) & pending;
        const next = if (p != 0) s & ~@as(u64, p) else s & ~@as(u64, token);
        if (slot.state.cmpxchgWeak(s, next, .acq_rel, .acquire)) |actual| {
            s = actual;
            continue;
        }
        return p;
    }
}

const chunk_bits = 10;
const chunk_len = 1 << chunk_bits;
const max_chunks = 4096; // 4M sockets

const Slots = struct {
    chunks: [max_chunks]std.atomic.Value(?*[chunk_len]Slot) = @splat(.init(null)),
    mutex: std.Thread.Mutex = .{},
    free_head: u32 = none,
    /// Slots ever handed out (iteration bound).
    high: std.atomic.Value(u32) = .init(0),

    fn get(self: *Slots, index: u32) *Slot {
        return &self.chunks[index >> chunk_bits].load(.acquire).?[index & (chunk_len - 1)];
    }

    fn alloc(self: *Slots, gpa: std.mem.Allocator, kind: Kind, ptr: *anyopaque) !struct { index: u32, gen: u32 } {
        self.mutex.lock();
        defer self.mutex.unlock();
        var index = self.free_head;
        if (index != none) {
            self.free_head = self.get(index).next_free;
        } else {
            index = self.high.load(.monotonic);
            const c = index >> chunk_bits;
            if (c >= max_chunks) return error.SystemResources;
            if (self.chunks[c].load(.acquire) == null) {
                const chunk = try gpa.create([chunk_len]Slot);
                chunk.* = @splat(.{});
                self.chunks[c].store(chunk, .release);
            }
            self.high.store(index + 1, .release);
        }
        const slot = self.get(index);
        slot.kind = kind;
        slot.ptr = ptr;
        slot.next_free = none;
        slot.deadline.store(no_deadline, .monotonic);
        const g = slot.gen();
        // Handed out with R held by the creator.
        slot.state.store(@as(u64, g) << 32 | R, .release);
        return .{ .index = index, .gen = g };
    }

    fn free(self: *Slots, index: u32) void {
        const slot = self.get(index);
        const g = slot.gen();
        slot.kind = .free;
        slot.ptr = null;
        slot.deadline.store(no_deadline, .monotonic);
        slot.state.store(@as(u64, g +% 1) << 32, .release);
        self.mutex.lock();
        defer self.mutex.unlock();
        slot.next_free = self.free_head;
        self.free_head = index;
    }

    fn deinit(self: *Slots, gpa: std.mem.Allocator) void {
        for (&self.chunks) |*c| if (c.load(.acquire)) |chunk| gpa.destroy(chunk);
    }
};

pub const Handler = struct {
    ctx: *anyopaque,
    /// Readiness on a socket slot (nothing claimed yet). `hup`: the peer
    /// closed or the socket failed (a short read may then still precede EOF).
    on_event: *const fn (ctx: *anyopaque, index: u32, gen: u32, ev: Event) void,
    /// A slot whose `token` another thread claimed and handed to the pollers.
    on_posted: *const fn (ctx: *anyopaque, index: u32, gen: u32, token: u32) void,
    /// A slot's deadline passed (nothing claimed yet).
    on_expired: *const fn (ctx: *anyopaque, index: u32, gen: u32) void,
    /// Runs on a poller thread just before it exits.
    on_thread_exit: *const fn (ctx: *anyopaque) void,
};

pub const Options = struct {
    /// Pollers running at once (not blocked, not parked). A poller about to
    /// block (`blockingBegin`) hands its place to a parked or new one.
    active: u32 = 1,
    max_threads: u32 = 256,
    stack_size: usize = 8 * 1024 * 1024,
    /// A poller idle (or parked) this long exits while another one keeps
    /// waiting, so the count returns to one soon after load. The last poller
    /// waits without a timeout (no wake-ups at idle).
    idle_exit_ms: i32 = 1_000,
    /// A dispatch running this long without a `blockingBegin` is assumed
    /// blocked (e.g. on a mutex): the monitor hands its place to another.
    stall_us: u32 = 2_000,
};

/// One poller's dispatch state, read by the monitor.
const Rec = struct {
    /// Monotonic ns when the current dispatch started (0: not dispatching).
    start: std.atomic.Value(i64) = .init(0),
    state: std.atomic.Value(State) = .init(.idle),
    used: bool = false,

    const State = enum(u8) { idle, running, blocked, stalled };
};

/// How long a surplus poller waits as a spare before parking.
const surplus_linger_ms = 50;

const wake_udata: u64 = std.math.maxInt(u64) - 1;
const tick_udata: u64 = std.math.maxInt(u64) - 2;

const Posted = struct { index: u32, gen: u32, token: u32 };

pub const Event = struct { udata: u64, readable: bool, writable: bool, hup: bool };

pub const Loop = struct {
    gpa: std.mem.Allocator,
    options: Options,
    handler: Handler,
    fd: posix.fd_t,
    /// Linux eventfd / timerfd (kqueue uses EVFILT_USER / EVFILT_TIMER).
    wake_fd: posix.fd_t = -1,
    tick_fd: posix.fd_t = -1,
    slots: Slots = .{},

    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    threads: u32 = 0,
    idle: std.atomic.Value(u32) = .init(0),
    /// Pollers not blocked and not parked.
    active: std.atomic.Value(u32) = .init(0),
    /// Surplus pollers waiting for a hand-off (`park_cond`).
    parked: u32 = 0,
    wakeups: u32 = 0,
    park_cond: std.Thread.Condition = .{},
    recs: []Rec = &.{},
    monitor_running: std.atomic.Value(bool) = .init(false),
    stopping: std.atomic.Value(bool) = .init(false),
    posted: std.ArrayList(Posted) = .empty,
    posted_spare: std.ArrayList(Posted) = .empty,

    /// Deadline min-heap of slot indices (keys in `Slot.armed`) and the
    /// one-shot timer armed for its top.
    timer_mutex: std.Thread.Mutex = .{},
    heap: std.ArrayList(u32) = .empty,
    timer_at: i64 = no_deadline,

    pub fn init(self: *Loop, gpa: std.mem.Allocator, options: Options, handler: Handler) !void {
        self.* = .{ .gpa = gpa, .options = options, .handler = handler, .fd = -1 };
        self.recs = try gpa.alloc(Rec, options.max_threads);
        errdefer gpa.free(self.recs);
        @memset(self.recs, .{});
        if (is_linux) {
            self.fd = try sysFd(linux.epoll_create1(linux.EPOLL.CLOEXEC));
            errdefer posix.close(self.fd);
            self.wake_fd = try sysFd(linux.eventfd(0, linux.EFD.CLOEXEC | linux.EFD.NONBLOCK));
            errdefer posix.close(self.wake_fd);
            self.tick_fd = try sysFd(linux.timerfd_create(.MONOTONIC, .{ .CLOEXEC = true, .NONBLOCK = true }));
            errdefer posix.close(self.tick_fd);
            try self.epollCtl(linux.EPOLL.CTL_ADD, self.wake_fd, linux.EPOLL.IN | linux.EPOLL.ET, wake_udata);
            try self.epollCtl(linux.EPOLL.CTL_ADD, self.tick_fd, linux.EPOLL.IN | linux.EPOLL.ET, tick_udata);
        } else {
            self.fd = try posix.kqueue();
            errdefer posix.close(self.fd);
            try self.kev(&.{.{ .ident = 0, .filter = std.c.EVFILT.USER, .flags = std.c.EV.ADD | std.c.EV.CLEAR, .fflags = 0, .data = 0, .udata = wake_udata }});
        }
    }

    /// Starts the first poller (more start on demand).
    pub fn start(self: *Loop) !void {
        self.mutex.lock();
        self.threads += 1;
        self.mutex.unlock();
        _ = self.active.fetchAdd(1, .seq_cst);
        const t = std.Thread.spawn(.{ .stack_size = self.options.stack_size }, worker, .{self}) catch |e| {
            self.mutex.lock();
            self.threads -= 1;
            self.mutex.unlock();
            _ = self.active.fetchSub(1, .seq_cst);
            return e;
        };
        t.detach();
    }

    /// Stops and waits for every poller, then frees the set. Slots must be
    /// unused by then (callers free their sockets first).
    pub fn deinit(self: *Loop) void {
        self.stopping.store(true, .seq_cst);
        self.signalWake();
        self.mutex.lock();
        self.park_cond.broadcast();
        while (self.threads > 0 or self.monitor_running.load(.acquire)) self.cond.timedWait(&self.mutex, std.time.ns_per_ms) catch {};
        self.mutex.unlock();
        if (self.wake_fd >= 0) posix.close(self.wake_fd);
        if (self.tick_fd >= 0) posix.close(self.tick_fd);
        posix.close(self.fd);
        self.posted.deinit(self.gpa);
        self.posted_spare.deinit(self.gpa);
        self.heap.deinit(self.gpa);
        self.gpa.free(self.recs);
        self.slots.deinit(self.gpa);
    }

    pub fn isStopping(self: *const Loop) bool {
        return self.stopping.load(.acquire);
    }

    // -- slots ------------------------------------------------------------------

    pub fn slot(self: *Loop, index: u32) *Slot {
        return self.slots.get(index);
    }

    /// Allocates a slot (R held by the caller).
    pub fn allocSlot(self: *Loop, kind: Kind, ptr: *anyopaque) !struct { index: u32, gen: u32 } {
        const r = try self.slots.alloc(self.gpa, kind, ptr);
        return .{ .index = r.index, .gen = r.gen };
    }

    /// Frees a slot (the caller holds its tokens and has closed the fd).
    pub fn freeSlot(self: *Loop, index: u32) void {
        const sl = self.slots.get(index);
        if (sl.armed.load(.acquire) != no_deadline) {
            self.timer_mutex.lock();
            if (sl.heap_pos != none) self.heapRemove(sl.heap_pos);
            sl.armed.store(no_deadline, .release);
            self.timer_mutex.unlock();
        }
        self.slots.free(index);
    }

    /// Converts a held slot to another kind (HTTP -> WebSocket).
    pub fn setKind(self: *Loop, index: u32, kind: Kind, ptr: *anyopaque) void {
        const s = self.slots.get(index);
        s.ptr = ptr;
        s.kind = kind;
    }

    /// Slots ever allocated (for sweeps); `slot(i)` is valid below this.
    pub fn slotCount(self: *Loop) u32 {
        return self.slots.high.load(.acquire);
    }

    // -- registration -------------------------------------------------------------

    fn udataOf(index: u32, gen: u32) u64 {
        return @as(u64, gen) << 32 | index;
    }

    /// Edge-triggered read interest.
    pub fn register(self: *Loop, fd: posix.fd_t, index: u32, gen: u32) !void {
        if (is_linux) {
            try self.epollCtl(linux.EPOLL.CTL_ADD, fd, linux.EPOLL.IN | linux.EPOLL.RDHUP | linux.EPOLL.ET, udataOf(index, gen));
        } else {
            try self.kev(&.{.{ .ident = @intCast(fd), .filter = std.c.EVFILT.READ, .flags = std.c.EV.ADD | std.c.EV.CLEAR, .fflags = 0, .data = 0, .udata = udataOf(index, gen) }});
        }
    }

    /// Adds edge-triggered write interest (after a write hit EAGAIN).
    pub fn enableWrite(self: *Loop, fd: posix.fd_t, index: u32, gen: u32) !void {
        if (is_linux) {
            try self.epollCtl(linux.EPOLL.CTL_MOD, fd, linux.EPOLL.IN | linux.EPOLL.RDHUP | linux.EPOLL.OUT | linux.EPOLL.ET, udataOf(index, gen));
        } else {
            try self.kev(&.{.{ .ident = @intCast(fd), .filter = std.c.EVFILT.WRITE, .flags = std.c.EV.ADD | std.c.EV.CLEAR, .fflags = 0, .data = 0, .udata = udataOf(index, gen) }});
        }
    }

    /// Removes a registered fd (closing it does the same).
    pub fn unregister(self: *Loop, fd: posix.fd_t, write: bool) void {
        if (is_linux) {
            self.epollCtl(linux.EPOLL.CTL_DEL, fd, 0, 0) catch {};
        } else {
            self.kev(&.{.{ .ident = @intCast(fd), .filter = std.c.EVFILT.READ, .flags = std.c.EV.DELETE, .fflags = 0, .data = 0, .udata = 0 }}) catch {};
            if (write) self.kev(&.{.{ .ident = @intCast(fd), .filter = std.c.EVFILT.WRITE, .flags = std.c.EV.DELETE, .fflags = 0, .data = 0, .udata = 0 }}) catch {};
        }
    }

    fn epollCtl(self: *Loop, op: u32, fd: posix.fd_t, events: u32, udata: u64) !void {
        var ev: linux.epoll_event = .{ .events = events, .data = .{ .u64 = udata } };
        const rc = linux.epoll_ctl(self.fd, op, fd, &ev);
        switch (linux.E.init(rc)) {
            .SUCCESS => {},
            .NOMEM, .NOSPC => return error.SystemResources,
            else => |e| {
                log.warn("epoll_ctl failed: {s}", .{@tagName(e)});
                return error.Unexpected;
            },
        }
    }

    fn kev(self: *Loop, changes: []const posix.Kevent) !void {
        var none_out: [0]posix.Kevent = .{};
        _ = posix.kevent(self.fd, changes, &none_out, null) catch |e| {
            log.warn("kevent failed: {s}", .{@errorName(e)});
            return e;
        };
    }

    // -- cross-thread hand-off ----------------------------------------------------------

    /// Hands a slot whose `token` the caller claimed to a poller thread.
    pub fn post(self: *Loop, index: u32, gen: u32, token: u32) void {
        self.mutex.lock();
        const was_empty = self.posted.items.len == 0;
        self.posted.append(self.gpa, .{ .index = index, .gen = gen, .token = token }) catch {
            self.mutex.unlock();
            // Out of memory: drive it here rather than lose the token.
            self.handler.on_posted(self.handler.ctx, index, gen, token);
            return;
        };
        self.mutex.unlock();
        if (was_empty) self.signalWake();
    }

    fn signalWake(self: *Loop) void {
        if (is_linux) {
            const one: u64 = 1;
            _ = posix.write(self.wake_fd, std.mem.asBytes(&one)) catch {};
        } else {
            self.kev(&.{.{ .ident = 0, .filter = std.c.EVFILT.USER, .flags = 0, .fflags = std.c.NOTE.TRIGGER, .data = 0, .udata = wake_udata }}) catch {};
        }
    }

    fn onWake(self: *Loop) void {
        if (is_linux) {
            var counter: u64 = 0;
            _ = posix.read(self.wake_fd, std.mem.asBytes(&counter)) catch {};
        }
        // Take the batch (concurrent drainers each get their own list).
        self.mutex.lock();
        var batch = self.posted;
        self.posted = self.posted_spare;
        self.posted_spare = .empty;
        self.mutex.unlock();
        for (batch.items) |p| self.handler.on_posted(self.handler.ctx, p.index, p.gen, p.token);
        batch.clearRetainingCapacity();
        self.mutex.lock();
        if (self.posted_spare.capacity == 0) {
            self.posted_spare = batch;
        } else batch.deinit(self.gpa);
        self.mutex.unlock();
    }

    // -- deadlines --------------------------------------------------------------------

    /// Sets when `index` is kicked. O(1) without a lock unless the deadline
    /// moves earlier than the slot's armed timer entry (an extended deadline
    /// is re-armed when the earlier entry fires), so idle sockets cost
    /// nothing per request and nothing per tick.
    pub fn setDeadline(self: *Loop, index: u32, deadline: i64) void {
        const sl = self.slots.get(index);
        sl.deadline.store(deadline, .release);
        if (deadline >= sl.armed.load(.acquire)) return;
        self.timer_mutex.lock();
        defer self.timer_mutex.unlock();
        self.arm(index, deadline);
    }

    /// Timer mutex held.
    fn arm(self: *Loop, index: u32, deadline: i64) void {
        const sl = self.slots.get(index);
        if (deadline >= sl.armed.load(.acquire)) return;
        sl.armed.store(deadline, .release);
        if (sl.heap_pos == none) {
            self.heap.append(self.gpa, index) catch {
                // Out of memory: the deadline waits for the next fired entry.
                sl.armed.store(no_deadline, .release);
                return;
            };
            sl.heap_pos = @intCast(self.heap.items.len - 1);
        }
        self.siftUp(sl.heap_pos);
        if (deadline < self.timer_at) self.setTimer(deadline);
    }

    fn key(self: *Loop, pos: u32) i64 {
        return self.slots.get(self.heap.items[pos]).armed.load(.monotonic);
    }

    fn place(self: *Loop, pos: u32, index: u32) void {
        self.heap.items[pos] = index;
        self.slots.get(index).heap_pos = pos;
    }

    fn siftUp(self: *Loop, from: u32) void {
        var pos = from;
        const index = self.heap.items[pos];
        const k = self.slots.get(index).armed.load(.monotonic);
        while (pos > 0) {
            const parent = (pos - 1) / 2;
            if (self.key(parent) <= k) break;
            self.place(pos, self.heap.items[parent]);
            pos = parent;
        }
        self.place(pos, index);
    }

    fn siftDown(self: *Loop, from: u32) void {
        var pos = from;
        const n: u32 = @intCast(self.heap.items.len);
        const index = self.heap.items[pos];
        const k = self.slots.get(index).armed.load(.monotonic);
        while (true) {
            var child = 2 * pos + 1;
            if (child >= n) break;
            if (child + 1 < n and self.key(child + 1) < self.key(child)) child += 1;
            if (self.key(child) >= k) break;
            self.place(pos, self.heap.items[child]);
            pos = child;
        }
        self.place(pos, index);
    }

    fn heapRemove(self: *Loop, pos: u32) void {
        const removed = self.heap.items[pos];
        self.slots.get(removed).heap_pos = none;
        const last = self.heap.pop().?;
        if (pos == self.heap.items.len) return;
        self.place(pos, last);
        self.siftDown(pos);
        self.siftUp(self.slots.get(last).heap_pos);
    }

    /// One-shot timer at monotonic `at` ms (`no_deadline`: disarm). Timer mutex held.
    fn setTimer(self: *Loop, at: i64) void {
        self.timer_at = at;
        if (is_linux) {
            const spec: linux.itimerspec = if (at == no_deadline)
                .{ .it_interval = .{ .sec = 0, .nsec = 0 }, .it_value = .{ .sec = 0, .nsec = 0 } }
            else
                .{ .it_interval = .{ .sec = 0, .nsec = 0 }, .it_value = .{ .sec = @intCast(@divTrunc(at, 1000)), .nsec = @intCast(@as(i64, @rem(at, 1000)) * std.time.ns_per_ms) } };
            _ = linux.timerfd_settime(self.tick_fd, .{ .ABSTIME = true }, &spec, null);
        } else if (at == no_deadline) {
            // A one-shot timer that already fired is gone: ENOENT is fine.
            var none_out: [0]posix.Kevent = .{};
            _ = posix.kevent(self.fd, &.{.{ .ident = 1, .filter = std.c.EVFILT.TIMER, .flags = std.c.EV.DELETE, .fflags = 0, .data = 0, .udata = tick_udata }}, &none_out, null) catch {};
        } else {
            const ms = @max(1, at - monoMs());
            self.kev(&.{.{ .ident = 1, .filter = std.c.EVFILT.TIMER, .flags = std.c.EV.ADD | std.c.EV.ONESHOT, .fflags = 0, .data = @intCast(ms), .udata = tick_udata }}) catch {};
        }
    }

    /// The timer fired: pop due entries, re-arm extended deadlines, report
    /// the expired ones.
    fn onTick(self: *Loop) void {
        if (is_linux) {
            var expirations: u64 = 0;
            _ = posix.read(self.tick_fd, std.mem.asBytes(&expirations)) catch {};
        }
        var due: [256]struct { index: u32, gen: u32 } = undefined;
        while (true) {
            var n: usize = 0;
            const now = monoMs();
            self.timer_mutex.lock();
            while (n < due.len and self.heap.items.len > 0 and self.key(0) <= now) {
                const index = self.heap.items[0];
                self.heapRemove(0);
                const sl = self.slots.get(index);
                sl.armed.store(no_deadline, .release);
                due[n] = .{ .index = index, .gen = sl.gen() };
                n += 1;
            }
            const more = n == due.len;
            self.setTimer(if (self.heap.items.len > 0) self.key(0) else no_deadline);
            self.timer_mutex.unlock();
            for (due[0..n]) |d| {
                const sl = self.slots.get(d.index);
                if (sl.gen() != d.gen) continue;
                const deadline = sl.deadline.load(.acquire);
                if (deadline == no_deadline) continue;
                if (deadline > now) {
                    self.setDeadline(d.index, deadline);
                } else self.handler.on_expired(self.handler.ctx, d.index, d.gen);
            }
            if (!more) return;
        }
    }

    // -- pollers ----------------------------------------------------------------------


    fn wait(self: *Loop, timeout_ms: i32) union(enum) { event: Event, timeout, interrupted } {
        if (is_linux) {
            var ev: [1]linux.epoll_event = undefined;
            const rc = linux.epoll_wait(self.fd, &ev, 1, timeout_ms);
            switch (linux.E.init(rc)) {
                .SUCCESS => {},
                .INTR => return .interrupted,
                else => |e| {
                    log.err("epoll_wait failed: {s}", .{@tagName(e)});
                    return .interrupted;
                },
            }
            if (rc == 0) return .timeout;
            const m = ev[0].events;
            return .{ .event = .{
                .udata = ev[0].data.u64,
                .readable = m & (linux.EPOLL.IN | linux.EPOLL.RDHUP | linux.EPOLL.HUP | linux.EPOLL.ERR) != 0,
                .writable = m & (linux.EPOLL.OUT | linux.EPOLL.HUP | linux.EPOLL.ERR) != 0,
                .hup = m & (linux.EPOLL.RDHUP | linux.EPOLL.HUP | linux.EPOLL.ERR) != 0,
            } };
        }
        var ev: [1]posix.Kevent = undefined;
        const ts: posix.timespec = .{ .sec = @divTrunc(timeout_ms, 1000), .nsec = @rem(timeout_ms, 1000) * std.time.ns_per_ms };
        var none_in: [0]posix.Kevent = .{};
        const n = posix.kevent(self.fd, &none_in, &ev, if (timeout_ms < 0) null else &ts) catch return .interrupted;
        if (n == 0) return .timeout;
        return .{ .event = .{
            .udata = ev[0].udata,
            .readable = ev[0].filter == std.c.EVFILT.READ,
            .writable = ev[0].filter == std.c.EVFILT.WRITE,
            .hup = ev[0].flags & (std.c.EV.EOF | std.c.EV.ERROR) != 0,
        } };
    }

    fn worker(self: *Loop) void {
        tls_poller = self;
        tls_rec = self.claimRec();
        if (@hasDecl(core, "blocking")) core.blocking.hook = .{ .ctx = self, .begin = hookBegin, .end = hookEnd };
        while (true) {
            if (self.isStopping()) {
                // Pass the stop on: the wake fd is edge-triggered.
                self.signalWake();
                return self.exitThread(false);
            }
            // A poller back from a blocking section is surplus while enough
            // run: it stays in the poller briefly as the spare the next
            // `blockingBegin` finds waiting (no wake-up), then parks.
            const surplus = self.active.load(.seq_cst) > self.options.active;
            _ = self.idle.fetchAdd(1, .seq_cst);
            const alone = @atomicLoad(u32, &self.threads, .monotonic) <= 1;
            const got = self.wait(if (surplus) surplus_linger_ms else if (alone) -1 else self.options.idle_exit_ms);
            const others = self.idle.fetchSub(1, .seq_cst) - 1;
            if (self.isStopping()) continue;
            switch (got) {
                .interrupted => continue,
                .timeout => if (surplus) {
                    if (self.active.load(.seq_cst) > self.options.active and self.park()) return self.exitThread(true);
                } else if (self.retire()) return self.exitThread(true),
                .event => |ev| {
                    // Grow to `options.active` pollers on demand.
                    if (others == 0 and self.active.load(.seq_cst) < self.options.active) self.spawnWorker();
                    self.dispatchTracked(ev);
                },
            }
        }
    }

    /// Parks a surplus poller until a hand-off; true when it should exit
    /// (parked for the idle timeout, or stopping).
    fn park(self: *Loop) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.active.load(.seq_cst) <= self.options.active) return false;
        _ = self.active.fetchSub(1, .seq_cst);
        self.parked += 1;
        while (self.wakeups == 0) {
            if (self.isStopping()) {
                self.parked -= 1;
                self.threads -= 1;
                return true;
            }
            self.park_cond.timedWait(&self.mutex, @as(u64, @intCast(self.options.idle_exit_ms)) * std.time.ns_per_ms) catch {
                if (self.wakeups > 0) break;
                self.parked -= 1;
                self.threads -= 1;
                return true;
            };
        }
        // The waker counted us active.
        self.wakeups -= 1;
        return false;
    }

    /// Restores `options.active` running pollers: unparks one, or starts one.
    fn handOff(self: *Loop) void {
        self.mutex.lock();
        if (self.parked > 0) {
            self.parked -= 1;
            self.wakeups += 1;
            _ = self.active.fetchAdd(1, .seq_cst);
            self.park_cond.signal();
            self.mutex.unlock();
            return;
        }
        self.mutex.unlock();
        self.spawnWorker();
    }

    fn hookBegin(ctx: *anyopaque) void {
        _ = ctx;
        blockingBegin();
    }

    fn hookEnd(ctx: *anyopaque) void {
        _ = ctx;
        blockingEnd();
    }

    fn dispatchTracked(self: *Loop, ev: Event) void {
        const rec = tls_rec orelse return self.dispatch(ev);
        if (!self.monitor_running.load(.monotonic)) self.startMonitor();
        rec.state.store(.running, .seq_cst);
        rec.start.store(monoNs(), .release);
        self.dispatch(ev);
        rec.start.store(0, .release);
        // The monitor counted a stalled dispatch out: count it back in.
        if (rec.state.swap(.idle, .seq_cst) == .stalled) _ = self.active.fetchAdd(1, .seq_cst);
    }

    fn claimRec(self: *Loop) ?*Rec {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.recs) |*r| if (!r.used) {
            r.* = .{ .used = true };
            return r;
        };
        return null;
    }

    fn startMonitor(self: *Loop) void {
        if (self.monitor_running.swap(true, .acq_rel)) return;
        const t = std.Thread.spawn(.{ .stack_size = 512 * 1024 }, monitor, .{self}) catch {
            self.monitor_running.store(false, .release);
            return;
        };
        t.detach();
    }

    /// Hands off for dispatches stuck outside `blockingBegin` (a mutex, a
    /// sleep): checks every millisecond while pollers dispatch, exits after
    /// 1 s without dispatches (the next dispatch restarts it), so an idle
    /// server runs no monitor.
    fn monitor(self: *Loop) void {
        var quiet_ms: u64 = 0;
        while (!self.isStopping() and quiet_ms < 1_000) {
            std.Thread.sleep(std.time.ns_per_ms);
            const now = monoNs();
            var busy = false;
            for (self.recs) |*r| {
                const began = r.start.load(.acquire);
                if (began == 0) continue;
                busy = true;
                if (now - began < @as(i64, self.options.stall_us) * std.time.ns_per_us) continue;
                if (r.state.cmpxchgStrong(.running, .stalled, .seq_cst, .seq_cst) != null) continue;
                const left = self.active.fetchSub(1, .seq_cst) - 1;
                if (left < self.options.active and self.idle.load(.seq_cst) == 0 and !self.isStopping()) self.handOff();
            }
            quiet_ms = if (busy) 0 else quiet_ms + 1;
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        self.monitor_running.store(false, .release);
        self.cond.broadcast();
    }

    fn dispatch(self: *Loop, ev: Event) void {
        switch (ev.udata) {
            wake_udata => self.onWake(),
            tick_udata => self.onTick(),
            else => self.handler.on_event(self.handler.ctx, @truncate(ev.udata), @truncate(ev.udata >> 32), ev),
        }
    }

    /// An idle poller leaves while another one keeps waiting.
    fn retire(self: *Loop) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.threads <= 1 or self.idle.load(.seq_cst) == 0) return false;
        self.threads -= 1;
        _ = self.active.fetchSub(1, .seq_cst);
        return true;
    }

    fn spawnWorker(self: *Loop) void {
        if (@atomicLoad(u32, &self.threads, .monotonic) >= self.options.max_threads) return;
        self.mutex.lock();
        if (self.threads >= self.options.max_threads or self.isStopping()) {
            self.mutex.unlock();
            return;
        }
        self.threads += 1;
        self.mutex.unlock();
        _ = self.active.fetchAdd(1, .seq_cst);
        const t = std.Thread.spawn(.{ .stack_size = self.options.stack_size }, worker, .{self}) catch |e| {
            log.err("poller thread spawn failed: {s}", .{@errorName(e)});
            _ = self.active.fetchSub(1, .seq_cst);
            self.mutex.lock();
            self.threads -= 1;
            self.cond.broadcast();
            self.mutex.unlock();
            return;
        };
        t.detach();
    }

    fn exitThread(self: *Loop, counted: bool) void {
        // A running poller (not one leaving from park) gives up its place.
        if (!counted) _ = self.active.fetchSub(1, .seq_cst);
        self.handler.on_thread_exit(self.handler.ctx);
        self.mutex.lock();
        if (tls_rec) |r| r.used = false;
        tls_rec = null;
        defer self.mutex.unlock();
        if (!counted) self.threads -= 1;
        // Last touch of `self` by this thread.
        self.cond.broadcast();
    }
};

threadlocal var tls_poller: ?*Loop = null;
threadlocal var tls_rec: ?*Rec = null;
threadlocal var tls_block_depth: u32 = 0;

/// The calling thread may block (DB wait, join): on a poller, another poller
/// takes its place until `blockingEnd`. No-op on other threads.
pub fn blockingBegin() void {
    const self = tls_poller orelse return;
    const rec = tls_rec orelse return;
    tls_block_depth += 1;
    if (tls_block_depth > 1) return;
    // Already counted out by the monitor: nothing to hand off.
    if (rec.state.cmpxchgStrong(.running, .blocked, .seq_cst, .seq_cst) != null) return;
    const left = self.active.fetchSub(1, .seq_cst) - 1;
    // A poller already waiting for events covers for us: no wake-up needed.
    if (left < self.options.active and self.idle.load(.seq_cst) == 0 and !self.isStopping()) self.handOff();
}

pub fn blockingEnd() void {
    if (tls_poller == null) return;
    const rec = tls_rec orelse return;
    tls_block_depth -= 1;
    if (tls_block_depth > 0) return;
    if (rec.state.cmpxchgStrong(.blocked, .running, .seq_cst, .seq_cst) == null)
        _ = tls_poller.?.active.fetchAdd(1, .seq_cst);
}

fn monoNs() i64 {
    const ts = posix.clock_gettime(.MONOTONIC) catch return 0;
    return @as(i64, ts.sec) * std.time.ns_per_s + ts.nsec;
}

fn sysFd(rc: usize) !posix.fd_t {
    return switch (linux.E.init(rc)) {
        .SUCCESS => @intCast(rc),
        .MFILE => error.ProcessFdQuotaExceeded,
        .NFILE => error.SystemFdQuotaExceeded,
        .NOMEM => error.SystemResources,
        else => error.Unexpected,
    };
}

/// Monotonic milliseconds (deadlines).
pub fn monoMs() i64 {
    const ts = posix.clock_gettime(.MONOTONIC) catch return 0;
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), std.time.ns_per_ms);
}

test "claim/release tokens and generations" {
    var s: Slot = .{};
    s.state.store(@as(u64, 7) << 32, .release);
    try std.testing.expectEqual(Claim.claimed, claim(&s, 7, R, R_AGAIN));
    try std.testing.expectEqual(Claim.busy, claim(&s, 7, R, R_AGAIN));
    try std.testing.expectEqual(Claim.stale, claim(&s, 6, R, R_AGAIN));
    try std.testing.expectEqual(Claim.claimed, claim(&s, 7, W, W_AGAIN));
    try std.testing.expectEqual(R_AGAIN, release(&s, R, R_AGAIN | KICK));
    try std.testing.expectEqual(@as(u32, 0), release(&s, R, R_AGAIN | KICK));
    try std.testing.expectEqual(W, Slot.bitsOf(s.state.load(.acquire)));
}
