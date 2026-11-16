//! Wakes for borrowed cancellation flags. A blocking wait that observes a
//! borrowed `*const std.atomic.Value(bool)` (a socket wait, a condition or a
//! parked fiber) registers a waker for the flag while it waits; runtime code
//! that raises the flag through `raise` calls every waker registered for it,
//! so cancellation ends the wait at once instead of at a recheck slice.
//!
//! Ordering: `raise` stores the flag before it takes the shard lock, and a
//! waiter checks the flag after `register` released that lock (and again
//! under its own wait lock where the waker takes that lock). Either the
//! waker runs, or the waiter's check sees the flag.
//!
//! Flags raised by a plain store still work; their waits end at the
//! waiter's recheck slice (a backstop).
const std = @import("std");
const cancel_wake = @This();

pub const Waker = struct {
    context: *anyopaque,
    /// Thread-safe and nonblocking; may run on any thread under a shard lock
    /// (it must not register, unregister or raise).
    call: *const fn (*anyopaque) void,
};

/// Caller-owned registration storage (typically on the waiting stack).
pub const Registration = struct {
    flag: *const std.atomic.Value(bool) = undefined,
    waker: Waker = undefined,
    prev: ?*Registration = null,
    next: ?*Registration = null,
    registered: bool = false,
};

const shard_count = 16;
const Shard = struct { mutex: std.Thread.Mutex = .{}, head: ?*Registration = null };
var shards: [shard_count]Shard = @splat(.{});
/// Waker calls made (work-count evidence for tests and diagnostics).
pub var delivered: std.atomic.Value(u64) = .init(0);

fn shardFor(flag: *const std.atomic.Value(bool)) *Shard {
    const address = @intFromPtr(flag);
    return &shards[(address >> 4 ^ address >> 12) % shard_count];
}

/// Calls `waker` for every later `raise(flag)` until `unregister`.
pub fn register(registration: *Registration, flag: *const std.atomic.Value(bool), waker: Waker) void {
    std.debug.assert(!registration.registered);
    registration.* = .{ .flag = flag, .waker = waker, .registered = true };
    const shard = shardFor(flag);
    shard.mutex.lock();
    defer shard.mutex.unlock();
    registration.next = shard.head;
    if (shard.head) |head| head.prev = registration;
    shard.head = registration;
}

/// After return no waker call for this registration is in progress or will
/// start: its storage and waker context may be released.
pub fn unregister(registration: *Registration) void {
    if (!registration.registered) return;
    const shard = shardFor(registration.flag);
    shard.mutex.lock();
    defer shard.mutex.unlock();
    if (registration.prev) |prev| prev.next = registration.next else shard.head = registration.next;
    if (registration.next) |next| next.prev = registration.prev;
    registration.* = .{};
}

/// Raises `flag` and wakes every wait registered on it. Call without
/// holding a lock a waker might need; under a lock, store the flag there and
/// call `wake` after unlocking (the flag's storage must outlive the call).
pub fn raise(flag: *std.atomic.Value(bool)) void {
    flag.store(true, .seq_cst);
    wake(flag);
}

/// Wakes the waits registered on an already raised `flag`. A flag that was
/// reset meanwhile (its owner started new work) wakes nothing.
pub fn wake(flag: *const std.atomic.Value(bool)) void {
    const shard = shardFor(flag);
    shard.mutex.lock();
    defer shard.mutex.unlock();
    // Checked under the shard lock: a wait registered after a reset (and
    // so after this lock) cannot be woken spuriously by an older raise.
    if (!flag.load(.seq_cst)) return;
    var cursor = shard.head;
    while (cursor) |registration| : (cursor = registration.next) {
        if (registration.flag != flag) continue;
        _ = delivered.fetchAdd(1, .monotonic);
        registration.waker.call(registration.waker.context);
    }
}

/// Registrations for up to two borrowed flags (either may be null).
pub const Pair = struct {
    first: Registration = .{},
    second: Registration = .{},
    pub fn register(self: *Pair, first: ?*const std.atomic.Value(bool), second: ?*const std.atomic.Value(bool), waker: Waker) void {
        if (first) |flag| cancel_wake.register(&self.first, flag, waker);
        if (second) |flag| if (first != flag) cancel_wake.register(&self.second, flag, waker);
    }
    pub fn unregister(self: *Pair) void {
        cancel_wake.unregister(&self.first);
        cancel_wake.unregister(&self.second);
    }
};

test "raise wakes only the waits registered on that flag, until they unregister" {
    const Count = struct {
        calls: usize = 0,
        fn call(context: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.calls += 1;
        }
    };
    var flag: std.atomic.Value(bool) = .init(false);
    var other: std.atomic.Value(bool) = .init(false);
    var woken: Count = .{};
    var bystander: Count = .{};
    var registration: Registration = .{};
    var unrelated: Registration = .{};
    register(&registration, &flag, .{ .context = &woken, .call = Count.call });
    register(&unrelated, &other, .{ .context = &bystander, .call = Count.call });
    raise(&flag);
    try std.testing.expect(flag.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), woken.calls);
    try std.testing.expectEqual(@as(usize, 0), bystander.calls);
    unregister(&registration);
    unregister(&registration);
    raise(&flag);
    try std.testing.expectEqual(@as(usize, 1), woken.calls);
    unregister(&unrelated);
    var pair: Pair = .{};
    pair.register(&flag, &flag, .{ .context = &woken, .call = Count.call });
    raise(&flag);
    // One flag passed twice is registered once.
    try std.testing.expectEqual(@as(usize, 2), woken.calls);
    pair.unregister();
}

test "a raise from another thread ends a registered condition wait without a slice" {
    const Wait = struct {
        mutex: std.Thread.Mutex = .{},
        cond: std.Thread.Condition = .{},
        fn call(context: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.mutex.lock();
            self.cond.signal();
            self.mutex.unlock();
        }
    };
    var flag: std.atomic.Value(bool) = .init(false);
    var wait: Wait = .{};
    var registration: Registration = .{};
    register(&registration, &flag, .{ .context = &wait, .call = Wait.call });
    defer unregister(&registration);
    const thread = try std.Thread.spawn(.{}, raise, .{&flag});
    defer thread.join();
    var timer = try std.time.Timer.start();
    wait.mutex.lock();
    // Checked under the lock the waker takes: no lost wake.
    while (!flag.load(.acquire)) wait.cond.timedWait(&wait.mutex, 10 * std.time.ns_per_s) catch break;
    wait.mutex.unlock();
    try std.testing.expect(flag.load(.acquire));
    try std.testing.expect(timer.read() < 5 * std.time.ns_per_s);
}
