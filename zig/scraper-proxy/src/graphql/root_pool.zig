//! Reusable threads for concurrent root fields (graphql-js starts every root
//! field at once; resolvers block on the database). Replaces a thread spawn
//! and join per extra root field.
//!
//! FIFO: jobs run in submission order (the database pool's FIFO waiters give
//! fairness across requests; a LIFO queue doubled p99 under load). A submit
//! wakes an idle thread or starts one up to `max_threads`; otherwise it fails
//! and the caller runs the job itself. A caller that finishes its own work
//! takes back any of its jobs no thread has started (`reclaim`), so a request
//! never waits on a queue position. Idle threads exit after `idle_ms`.
const std = @import("std");

pub const Job = struct {
    run: *const fn (*Job) void,
    state: State = .idle,
    done: std.Thread.ResetEvent = .{},
    prev: ?*Job = null,
    next: ?*Job = null,

    pub const State = enum { idle, queued, running };
};

pub const RootPool = struct {
    max_threads: u32,
    idle_ms: u64 = 10_000,
    /// A root field runs the same recursion (argument coercion, SQL build) as
    /// the request thread. Worst case at the TS-emulating depth guards
    /// (stack_test.zig "stack high-water"): 2.5 MiB ReleaseFast, 8.9 MiB
    /// Debug (`_not` variables x2396); sized at 2x or more.
    stack_size: usize = if (@import("builtin").mode == .Debug) 20 * 1024 * 1024 else 8 * 1024 * 1024,
    mutex: std.Thread.Mutex = .{},
    work: std.Thread.Condition = .{},
    exited: std.Thread.Condition = .{},
    head: ?*Job = null,
    tail: ?*Job = null,
    queued: u32 = 0,
    idle: u32 = 0,
    threads: u32 = 0,
    stopping: bool = false,

    pub fn init(max_threads: u32) RootPool {
        return .{ .max_threads = max_threads };
    }

    /// Stops idle threads and waits for every thread to exit. Callers must
    /// have finished (or reclaimed) their jobs.
    pub fn deinit(self: *RootPool) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.stopping = true;
        self.work.broadcast();
        while (self.threads > 0) self.exited.wait(&self.mutex);
    }

    /// Queues `job` for a pool thread; false = run it on the caller.
    pub fn submit(self: *RootPool, job: *Job) bool {
        job.done.reset();
        self.mutex.lock();
        if (self.stopping) {
            self.mutex.unlock();
            return false;
        }
        if (self.idle > self.queued) {
            self.push(job);
            self.mutex.unlock();
            self.work.signal();
            return true;
        }
        if (self.threads >= self.max_threads) {
            self.mutex.unlock();
            return false;
        }
        self.threads += 1;
        self.push(job);
        self.mutex.unlock();
        const thread = std.Thread.spawn(.{ .stack_size = self.stack_size }, worker, .{self}) catch {
            self.mutex.lock();
            self.threads -= 1;
            const reclaimed = job.state == .queued;
            if (reclaimed) self.unlink(job);
            self.exited.broadcast();
            self.mutex.unlock();
            // Another thread may have taken it meanwhile; then it runs there.
            return !reclaimed;
        };
        thread.detach();
        return true;
    }

    /// Takes back `job` if no thread started it (the caller then runs it);
    /// false = it is running or done, `job.done.wait()` for it.
    pub fn reclaim(self: *RootPool, job: *Job) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (job.state != .queued) return false;
        self.unlink(job);
        return true;
    }

    fn push(self: *RootPool, job: *Job) void {
        job.state = .queued;
        job.prev = self.tail;
        job.next = null;
        if (self.tail) |t| t.next = job else self.head = job;
        self.tail = job;
        self.queued += 1;
    }

    fn unlink(self: *RootPool, job: *Job) void {
        if (job.prev) |p| p.next = job.next else self.head = job.next;
        if (job.next) |n| n.prev = job.prev else self.tail = job.prev;
        job.prev = null;
        job.next = null;
        job.state = .idle;
        self.queued -= 1;
    }

    fn worker(self: *RootPool) void {
        self.mutex.lock();
        while (true) {
            if (self.head) |job| {
                self.unlink(job);
                job.state = .running;
                self.mutex.unlock();
                job.run(job);
                // The submitter may free `job` as soon as `done` is set.
                job.done.set();
                self.mutex.lock();
                continue;
            }
            if (self.stopping) break;
            self.idle += 1;
            const timed_out = if (self.work.timedWait(&self.mutex, self.idle_ms * std.time.ns_per_ms)) false else |_| true;
            self.idle -= 1;
            if (timed_out and self.head == null) break;
        }
        self.threads -= 1;
        self.exited.broadcast();
        self.mutex.unlock();
    }
};

test "jobs run on pool threads, in order, and can be reclaimed" {
    var pool = RootPool.init(2);
    defer pool.deinit();
    const Task = struct {
        job: Job = .{ .run = run },
        thread: std.Thread.Id = 0,
        fn run(job: *Job) void {
            const self: *@This() = @fieldParentPtr("job", job);
            self.thread = std.Thread.getCurrentId();
        }
    };
    var tasks: [6]Task = @splat(.{});
    var submitted: [6]bool = undefined;
    for (&tasks, &submitted) |*t, *s| s.* = pool.submit(&t.job);
    // At most two threads; later submits either queue (an idle thread) or fail.
    for (&tasks, submitted) |*t, s| {
        if (!s or pool.reclaim(&t.job)) {
            t.job.run(&t.job);
        } else {
            t.job.done.wait();
        }
    }
    for (tasks) |t| try std.testing.expect(t.thread != 0);
    try std.testing.expect(pool.threads <= 2);
    try std.testing.expect(pool.head == null);
}

test "idle threads exit after the idle timeout" {
    var pool = RootPool.init(4);
    pool.idle_ms = 20;
    defer pool.deinit();
    const Task = struct {
        job: Job = .{ .run = run },
        fn run(_: *Job) void {}
    };
    var t: Task = .{};
    if (pool.submit(&t.job)) {
        if (pool.reclaim(&t.job)) t.job.run(&t.job) else t.job.done.wait();
    }
    var waited: usize = 0;
    while (waited < 200) : (waited += 1) {
        pool.mutex.lock();
        const n = pool.threads;
        pool.mutex.unlock();
        if (n == 0) break;
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    try std.testing.expect(waited < 200);
}
