//! Process-wide progress notifier for the service scheduling loop. I/O owners
//! call `notify` when work completes; the loop waits from a generation observed
//! before its tick, so a completion during the tick is never lost. Futex based:
//! `notify` is lock-free and async-signal-safe (signal handlers may call it).
const std = @import("std");

var generation = std.atomic.Value(u32).init(0);
var waiters = std.atomic.Value(u32).init(0);
var io_generation = std.atomic.Value(u32).init(0);
/// Supervisor tasks currently suspended on PendingReadIo. I/O completions wake
/// the service loop only while one exists (blocking fetches need no wake).
var suspended_tasks = std.atomic.Value(u32).init(0);
/// Total notifications, for focused work-count evidence.
pub var notifications = std.atomic.Value(u64).init(0);

pub fn notify() void {
    // seq_cst pairs this increment-then-load with waitFrom's
    // register-then-wait so neither side can miss the other.
    _ = generation.fetchAdd(1, .seq_cst);
    _ = notifications.fetchAdd(1, .monotonic);
    if (waiters.load(.seq_cst) != 0) std.Thread.Futex.wake(&generation, std.math.maxInt(u32));
}

/// An awaited read/IO result completed: suspended (PendingReadIo) tasks may
/// resume. Distinct from `notify` so a task's own PendingReadIo return (a job
/// completion) does not immediately resume it.
pub fn notifyIo() void {
    _ = io_generation.fetchAdd(1, .seq_cst);
    if (suspended_tasks.load(.seq_cst) != 0) notify();
}

pub fn taskSuspended(suspended: bool) void {
    if (suspended) {
        _ = suspended_tasks.fetchAdd(1, .seq_cst);
    } else {
        _ = suspended_tasks.fetchSub(1, .seq_cst);
    }
}

pub fn ioGeneration() u32 {
    return io_generation.load(.seq_cst);
}

pub fn current() u32 {
    return generation.load(.seq_cst);
}

/// Returns once the generation differs from `seen` or after `timeout_ns`.
pub fn waitFrom(seen: u32, timeout_ns: u64) void {
    if (timeout_ns == 0) return;
    _ = waiters.fetchAdd(1, .seq_cst);
    defer _ = waiters.fetchSub(1, .seq_cst);
    std.Thread.Futex.timedWait(&generation, seen, timeout_ns) catch {};
}

test "notify after an observed generation ends a wait immediately" {
    const seen = current();
    notify();
    var timer = try std.time.Timer.start();
    waitFrom(seen, 5 * std.time.ns_per_s);
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    const Notifier = struct {
        fn run() void {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            notify();
        }
    };
    const again = current();
    const thread = try std.Thread.spawn(.{}, Notifier.run, .{});
    waitFrom(again, 5 * std.time.ns_per_s);
    thread.join();
    try std.testing.expect(current() != again);
    try std.testing.expect(timer.read() < 4 * std.time.ns_per_s);
}
