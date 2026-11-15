//! Retained receipt read jobs; all transports are shared, every client/journal
//! is exclusive to one job. At most16 RPC jobs globally and4 per domain.
const std = @import("std");
const enrich = @import("enrichment.zig");
const source = @import("source.zig");
const pg = @import("../../db/postgres.zig");
const fiber = @import("../../runtime/fiber.zig");
const A = std.mem.Allocator;
pub const Limiter = struct {
    allocator: A,
    domains: std.AutoHashMapUnmanaged(u32, u8) = .empty,
    mutex: std.Thread.Mutex = .{},
    active: usize = 0,
    peak: usize = 0,
    global_max: usize = 16,
    domain_max: u8 = 4,
    /// FIFO of parked acquirers. A release hands its permit straight to the
    /// first eligible one, so no queued waiter is ever eligible while a
    /// permit sits free (fresh acquirers never barge past an eligible one).
    head: ?*Wait = null,
    tail: ?*Wait = null,
    /// One parked acquirer; lives on the waiting fiber's stack.
    pub const Wait = struct {
        waiter: fiber.Waiter = .{},
        domain: u32,
        granted: bool = false,
        linked: bool = false,
        prev: ?*Wait = null,
        next: ?*Wait = null,
    };
    pub fn init(a: A, domains: []const u32) !Limiter {
        return initBounded(a, domains, 16, 4);
    }
    /// Rust's receipt streams share 16 global / 4 per-domain RPC permits;
    /// raw-dispatch reconciliation enriches with its own 8-wide concurrency.
    pub fn initBounded(a: A, domains: []const u32, global_max: usize, domain_max: u8) !Limiter {
        if (global_max == 0 or domain_max == 0) return error.InvalidReceiptLimit;
        var self: Limiter = .{ .allocator = a, .global_max = global_max, .domain_max = domain_max };
        errdefer self.domains.deinit(a);
        for (domains) |domain| {
            const entry = try self.domains.getOrPut(a, domain);
            entry.value_ptr.* = 0;
        }
        return self;
    }
    pub fn deinit(self: *Limiter) void {
        std.debug.assert(self.active == 0 and self.head == null);
        self.domains.deinit(self.allocator);
    }
    pub fn acquire(self: *Limiter, domain: u32) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.takeLocked(try self.countLocked(domain));
    }
    fn countLocked(self: *Limiter, domain: u32) !*u8 {
        return self.domains.getPtr(domain) orelse error.UnknownReceiptDomain;
    }
    fn takeLocked(self: *Limiter, count: *u8) bool {
        if (self.active >= self.global_max or count.* >= self.domain_max) return false;
        self.active += 1;
        self.peak = @max(self.peak, self.active);
        count.* += 1;
        return true;
    }
    /// Blocks (parks a fiber) until a permit is handed over, cancellation, or
    /// `deadline_ns` (pg.nowNs clock). A release wakes the waiter directly;
    /// the bounded slice only re-checks cancellation, which has no wake hook.
    pub fn acquireWait(self: *Limiter, domain: u32, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool)) !void {
        var wait: Wait = .{ .domain = domain };
        {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.takeLocked(try self.countLocked(domain))) return;
            self.linkLocked(&wait);
        }
        while (true) {
            const now = try pg.nowNs();
            const remaining_ms = std.math.divCeil(u64, deadline_ns -| now, std.time.ns_per_ms) catch unreachable;
            const stopped = if (cancel) |flag| flag.load(.acquire) else false;
            if (!stopped and remaining_ms != 0) _ = wait.waiter.waitTimeout(fiber.monoMs() + @as(i64, @intCast(@min(remaining_ms, cancel_slice_ms))));
            // The releaser wakes under this mutex: once held, the Waiter is
            // no longer touched and `wait` may leave this stack frame.
            self.mutex.lock();
            defer self.mutex.unlock();
            if (wait.granted) return;
            const cancelled = if (cancel) |flag| flag.load(.acquire) else false;
            if (cancelled or try pg.nowNs() >= deadline_ns) {
                self.unlinkLocked(&wait);
                return if (cancelled) error.RequestCancelled else error.ScraperReceiptDeadline;
            }
            // A slice expired: re-arm the one-shot Waiter (no wake can race:
            // a grant happens only under this mutex and sets `granted`).
            wait.waiter = .{};
        }
    }
    const cancel_slice_ms = 25;
    fn linkLocked(self: *Limiter, wait: *Wait) void {
        wait.prev = self.tail;
        wait.next = null;
        if (self.tail) |tail| tail.next = wait else self.head = wait;
        self.tail = wait;
        wait.linked = true;
    }
    fn unlinkLocked(self: *Limiter, wait: *Wait) void {
        if (!wait.linked) return;
        if (wait.prev) |prev| prev.next = wait.next else self.head = wait.next;
        if (wait.next) |next| next.prev = wait.prev else self.tail = wait.prev;
        wait.prev = null;
        wait.next = null;
        wait.linked = false;
    }
    pub fn release(self: *Limiter, domain: u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const count = self.domains.getPtr(domain).?;
        std.debug.assert(self.active > 0 and count.* > 0);
        self.active -= 1;
        count.* -= 1;
        var next = self.head;
        while (next) |wait| : (next = wait.next) {
            if (!self.takeLocked(self.domains.getPtr(wait.domain).?)) continue;
            self.unlinkLocked(wait);
            wait.granted = true;
            wait.waiter.wake();
            return;
        }
    }
};
pub const max_workers = 16;
/// Parks the current fiber (siblings run) for about `ms` milliseconds.
pub fn nap(ms: i64) void {
    var waiter: fiber.Waiter = .{};
    _ = waiter.waitTimeout(fiber.monoMs() + ms);
}
pub fn Batch(comptime Network: type) type {
    return struct {
        const Self = @This();
        const Job = struct { request: enrich.Request, phase: enum { waiting, fetch, header, persist, done } = .waiting, network: ?*Network = null, value: ?enrich.OwnedTxn = null, header: ?source.Header = null, charged: usize = 0, claimed: bool = false };
        allocator: A,
        parent: *Network,
        limiter: *Limiter,
        domain: u32,
        deadline_ns: u64,
        jobs: []Job,
        completed: usize = 0,
        failures: usize = 0,
        last_failure: ?anyerror = null,
        pub fn init(a: A, parent: *Network, limiter: *Limiter, domain: u32, requests: []const enrich.Request, deadline_ns: u64) !Self {
            if (requests.len > 100) return error.ScraperReceiptPageLimit;
            const jobs = try a.alloc(Job, requests.len);
            for (jobs, requests) |*job, request| job.* = .{ .request = request };
            return .{ .allocator = a, .parent = parent, .limiter = limiter, .domain = domain, .deadline_ns = deadline_ns, .jobs = jobs };
        }
        /// Jobs not yet admitted by the limiter (or claimed by a fiber worker).
        pub fn waiting(self: Self) usize {
            var count: usize = 0;
            for (self.jobs) |job| count += @intFromBool(job.phase == .waiting and !job.claimed);
            return count;
        }
        pub fn done(self: Self) bool {
            return self.completed == self.jobs.len;
        }
        /// Fiber mode: hands the next unclaimed job to exactly one worker.
        pub fn claim(self: *Self) ?usize {
            for (self.jobs, 0..) |*job, index| if (job.phase == .waiting and !job.claimed) {
                job.claimed = true;
                return index;
            };
            return null;
        }
        /// Fiber mode: runs one claimed job to retirement. Reads park this
        /// fiber (siblings' reads overlap); the permit is handed over on release.
        /// Only OutOfMemory and cancellation abort the caller.
        pub fn runJob(self: *Self, index: usize, io: pg.IoOptions, persist: anytype) !void {
            const job = &self.jobs[index];
            self.limiter.acquireWait(self.domain, self.deadline_ns, io.cancel) catch |err| switch (err) {
                error.ScraperReceiptDeadline => return self.failed(job, err),
                error.RequestCancelled => {
                    self.failed(job, err);
                    return err;
                },
                else => return err,
            };
            job.network = self.parent.forkReadFor(self.allocator, .contract_sync) catch |err| {
                self.limiter.release(self.domain);
                self.failed(job, err);
                if (err == error.OutOfMemory) return err;
                return;
            };
            job.phase = .fetch;
            while (job.phase != .persist) {
                if (try pg.nowNs() >= self.deadline_ns) return self.failed(job, error.ScraperReceiptDeadline);
                self.read(job, io.cancel) catch |err| {
                    // Pool pressure can still yield; retry within the deadline.
                    if (err == error.PendingReadIo) {
                        nap(1);
                        continue;
                    }
                    self.failed(job, err);
                    if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
                    return;
                };
            }
            var bounded = io;
            bounded.deadline_ns = self.deadline_ns;
            persist.store(job.request, job.value.?.value, job.header, bounded) catch |err| {
                self.failed(job, err);
                if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
                return;
            };
            self.retire(job);
            job.phase = .done;
            self.completed += 1;
        }
        /// Fiber mode: `workers` sibling fibers drain the batch, each claiming
        /// the next job as soon as its previous one retires (no barrier per
        /// round). Off a fiber the children run inline, i.e. serially.
        pub fn runFibers(self: *Self, io: pg.IoOptions, persist: anytype, workers: usize) !void {
            const Worker = struct {
                batch: *Self,
                io: pg.IoOptions,
                persist: @TypeOf(persist),
                child: fiber.Child = .{},
                err: ?anyerror = null,
                fn run(arg: *anyopaque) void {
                    const worker: *@This() = @ptrCast(@alignCast(arg));
                    while (worker.batch.claim()) |index| worker.batch.runJob(index, worker.io, worker.persist) catch |err| {
                        worker.err = err;
                        return;
                    };
                }
            };
            var pool: [max_workers]Worker = undefined;
            var group: fiber.Group = .{};
            const count = @min(workers, max_workers);
            var spawned: usize = 0;
            defer group.wait();
            for (pool[0..count]) |*worker| {
                worker.* = .{ .batch = self, .io = io, .persist = persist };
                try group.spawn(&worker.child, Worker.run, worker);
                spawned += 1;
            }
            group.wait();
            for (pool[0..spawned]) |worker| if (worker.err) |err| return err;
        }
        pub fn deinit(self: *Self) void {
            for (self.jobs) |*job| self.retire(job);
            self.allocator.free(self.jobs);
            self.* = undefined;
        }
        fn retire(self: *Self, job: *Job) void {
            if (job.value) |*value| value.deinit();
            job.value = null;
            if (job.network) |network| {
                if (job.charged != 0) if (network.options.read_budget) |budget| budget.release(job.charged);
                network.deinit();
                self.limiter.release(self.domain);
            }
            job.charged = 0;
            job.network = null;
        }
        fn failed(self: *Self, job: *Job, err: anyerror) void {
            self.failures += 1;
            self.last_failure = err;
            self.retire(job);
            job.phase = .done;
            self.completed += 1;
        }
        /// Returns true only once every planned request has retired. Persistence
        /// runs after complete pure reads and owns no replayable network section.
        pub fn step(self: *Self, io: pg.IoOptions, persist: anytype) !bool {
            if (io.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
            const expired = try pg.nowNs() >= self.deadline_ns;
            for (self.jobs) |*job| {
                if (job.phase == .done) continue;
                if (expired) {
                    self.failed(job, error.ScraperReceiptDeadline);
                    continue;
                }
                if (job.phase == .waiting) {
                    if (!try self.limiter.acquire(self.domain)) continue;
                    job.network = self.parent.forkReadFor(self.allocator, .contract_sync) catch |err| {
                        self.limiter.release(self.domain);
                        if (err == error.OutOfMemory) return err;
                        self.failed(job, err);
                        continue;
                    };
                    job.phase = .fetch;
                }
                self.read(job, io.cancel) catch |err| {
                    if (err == error.PendingReadIo) continue;
                    if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
                    self.failed(job, err);
                    continue;
                };
                if (job.phase == .persist) {
                    var bounded = io;
                    bounded.deadline_ns = self.deadline_ns;
                    persist.store(job.request, job.value.?.value, job.header, bounded) catch |err| {
                        if (err == error.OutOfMemory or err == error.RequestCancelled) return err;
                        self.failed(job, err);
                        continue;
                    };
                    self.retire(job);
                    job.phase = .done;
                    self.completed += 1;
                }
            }
            return self.completed == self.jobs.len;
        }
        fn read(self: *Self, job: *Job, cancel: ?*const std.atomic.Value(bool)) !void {
            if (job.phase == .persist) return;
            const network = job.network.?;
            const previous_rpc_deadline = network.rpc_deadline_ns;
            const previous_rpc_owner = network.http.rpc_read_owner;
            const rpc_deadline = @min(self.deadline_ns, @min(previous_rpc_deadline orelse self.deadline_ns, if (previous_rpc_owner) |owner| owner.deadline_ns else self.deadline_ns));
            network.rpc_deadline_ns = rpc_deadline;
            network.http.rpc_read_owner = .{ .deadline_ns = rpc_deadline, .halt = if (previous_rpc_owner) |owner| owner.halt else null, .retry_physical_timeout = if (previous_rpc_owner) |owner| owner.retry_physical_timeout else true };
            defer {
                network.rpc_deadline_ns = previous_rpc_deadline;
                network.http.rpc_read_owner = previous_rpc_owner;
            }
            try network.beginReadPass(cancel);
            var failure: ?anyerror = null;
            defer network.endReadPass(failure);
            self.readInner(job) catch |err| {
                failure = err;
                return err;
            };
        }
        fn readInner(self: *Self, job: *Job) !void {
            const network = job.network.?;
            const fetcher = try network.receipts();
            if (job.phase == .fetch) {
                var value = try fetcher.fetch(self.allocator, job.request.meta, self.deadline_ns);
                var moved = false;
                errdefer if (!moved) value.deinit();
                const charge = try std.math.add(usize, @sizeOf(enrich.Txn) + 128, if (value.value.raw_input) |input| input.len else 0);
                if (network.options.read_budget) |budget| try budget.reserve(charge);
                job.charged = charge;
                job.value = value;
                moved = true;
                job.phase = .header;
                try network.commitReadSection();
            }
            if (job.phase == .header) {
                if (job.request.block_id == null) {
                    if (fetcher.header_fn) |header| job.header = try header(fetcher.context, job.request.meta, self.deadline_ns);
                }
                job.phase = .persist;
                try network.commitReadSection();
            }
        }
    };
}

test "receipt limiter enforces16 global4 per domain and releases admission without new threads" {
    const a = std.testing.allocator;
    var limit = try Limiter.init(a, &.{ 1, 2, 3, 4, 5 });
    defer limit.deinit();
    for (1..5) |domain| for (0..4) |_| try std.testing.expect(try limit.acquire(@intCast(domain)));
    try std.testing.expect(!try limit.acquire(1));
    try std.testing.expect(!try limit.acquire(5));
    limit.release(1);
    try std.testing.expect(try limit.acquire(5));
    for (1..5) |domain| for (0..if (domain == 1) @as(usize, 3) else @as(usize, 4)) |_| limit.release(@intCast(domain));
    limit.release(5);
    try std.testing.expectEqual(@as(usize, 16), limit.peak);
}

test "receipt limiter hands a released permit to the parked eligible acquirer and honours deadline and cancellation" {
    const a = std.testing.allocator;
    var limit = try Limiter.initBounded(a, &.{ 1, 2 }, 2, 1);
    defer limit.deinit();
    try std.testing.expect(try limit.acquire(1));
    try std.testing.expect(try limit.acquire(2));
    try std.testing.expectError(error.ScraperReceiptDeadline, limit.acquireWait(1, (try pg.nowNs()) + 30 * std.time.ns_per_ms, null));
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, limit.acquireWait(1, (try pg.nowNs()) + std.time.ns_per_s, &cancelled));
    try std.testing.expectError(error.UnknownReceiptDomain, limit.acquireWait(9, (try pg.nowNs()) + std.time.ns_per_s, null));
    try std.testing.expect(limit.head == null);
    const Parked = struct {
        fn run(limiter: *Limiter, outcome: *?anyerror) void {
            const deadline = (pg.nowNs() catch unreachable) + 10 * std.time.ns_per_s;
            limiter.acquireWait(1, deadline, null) catch |err| {
                outcome.* = err;
                return;
            };
            outcome.* = null;
        }
    };
    var outcome: ?anyerror = error.NotRun;
    const thread = try std.Thread.spawn(.{}, Parked.run, .{ &limit, &outcome });
    while (true) {
        limit.mutex.lock();
        const parked = limit.head != null;
        limit.mutex.unlock();
        if (parked) break;
        std.Thread.yield() catch {};
    }
    // Domain 1 is still full: the freed global permit is not the waiter's,
    // so a fresh domain-2 acquirer takes it without barging past anyone.
    limit.release(2);
    try std.testing.expect(limit.head != null);
    try std.testing.expect(try limit.acquire(2));
    limit.release(2);
    limit.release(1);
    thread.join();
    try std.testing.expectEqual(@as(?anyerror, null), outcome);
    try std.testing.expect(limit.head == null);
    try std.testing.expectEqual(@as(usize, 1), limit.active);
    try std.testing.expect(!try limit.acquire(1));
    limit.release(1);
    try std.testing.expectEqual(@as(usize, 0), limit.active);
}

const FakeNetwork = struct {
    allocator: A,
    stats: *Stats,
    rpc_deadline_ns: ?u64 = null,
    // The fixture only checks the bound scope; it never uses an HTTP client.
    http: @import("../../cloud/http.zig").HttpTransport = .{ .client = undefined },
    options: struct { read_budget: ?*@import("../../net/read_replay.zig").ByteBudget = null } = .{},
    passes: usize = 0,
    const Stats = struct { forks: usize = 0, retired: usize = 0, requests: [32]usize = @splat(0) };
    fn forkReadFor(self: *FakeNetwork, a: A, _: @import("../../ops/rpc_metrics.zig").Operation) !*FakeNetwork {
        const out = try a.create(FakeNetwork);
        out.* = self.*;
        out.allocator = a;
        out.passes = 0;
        self.stats.forks += 1;
        return out;
    }
    fn deinit(self: *FakeNetwork) void {
        self.stats.retired += 1;
        self.allocator.destroy(self);
    }
    fn beginReadPass(self: *FakeNetwork, _: ?*const std.atomic.Value(bool)) !void {
        self.passes += 1;
    }
    fn endReadPass(_: *FakeNetwork, _: ?anyerror) void {}
    fn commitReadSection(_: *FakeNetwork) !void {}
    fn receipts(self: *FakeNetwork) !enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch };
    }
    fn fetch(ctx: *anyopaque, a: A, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *FakeNetwork = @ptrCast(@alignCast(ctx));
        if (self.rpc_deadline_ns != deadline or self.http.rpc_read_owner == null or self.http.rpc_read_owner.?.deadline_ns != deadline) return error.UnboundReceiptRpcDeadline;
        const id = meta.tx_hash[63];
        self.stats.requests[id] += 1;
        if (id < 4 or self.passes < 2) return error.PendingReadIo;
        if (id == 6) return error.WrongReceiptBlock;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const input = try arena.allocator().dupe(u8, "request-data");
        return .{ .arena = arena, .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = 21000, .nonce = id, .sender = @splat(1), .gas_used = 21000, .cumulative_gas_used = 21000, .raw_input = input } };
    }
};
const FakePersist = struct {
    seen: [32]usize = @splat(0),
    fn store(self: *FakePersist, request: enrich.Request, value: enrich.Txn, _: ?source.Header, _: pg.IoOptions) !void {
        if (!std.mem.eql(u8, &request.meta.tx_hash, &value.hash) or !std.mem.eql(u8, &request.meta.block_hash, &value.block_hash) or request.meta.block_number != value.block_number) return error.FakeReceiptMismatch;
        self.seen[value.hash[63]] += 1;
    }
};
test "receipt batches retain four stalled peers while healthy domains persist neighbors once and cancellation releases quota" {
    const a = std.testing.allocator;
    var limiter = try Limiter.init(a, &.{ 1, 2, 3 });
    defer limiter.deinit();
    var budget: @import("../../net/read_replay.zig").ByteBudget = .{ .maximum = 1024 * 1024 };
    var stats: FakeNetwork.Stats = .{};
    var parent: FakeNetwork = .{ .allocator = a, .stats = &stats, .options = .{ .read_budget = &budget } };
    var requests: [12]enrich.Request = undefined;
    for (&requests, 0..) |*request, i| {
        var tx: [64]u8 = @splat(0);
        tx[63] = @intCast(i);
        request.* = .{ .meta = .{ .tx_hash = tx, .block_hash = @splat(2), .block_number = 5 }, .block_id = 1 };
    }
    var batches: [3]Batch(FakeNetwork) = undefined;
    const deadline = (try pg.nowNs()) + std.time.ns_per_s;
    for (&batches, 0..) |*batch, i| batch.* = try Batch(FakeNetwork).init(a, &parent, &limiter, @intCast(i + 1), requests[i * 4 ..][0..4], deadline);
    defer for (&batches) |*batch| batch.deinit();
    for (&batches) |*batch| try std.testing.expectEqual(@as(usize, 4), batch.waiting());
    var persist: FakePersist = .{};
    for (0..8) |_| {
        for (&batches) |*batch| {
            _ = try batch.step(.{}, &persist);
        }
    }
    try std.testing.expectEqual(@as(usize, 0), batches[0].completed);
    // Stalled jobs hold permits; none is left waiting, so a window may plan more.
    try std.testing.expectEqual(@as(usize, 0), batches[0].waiting());
    try std.testing.expectEqual(@as(usize, 4), batches[1].completed);
    try std.testing.expectEqual(@as(usize, 1), batches[1].failures);
    try std.testing.expectEqual(@as(usize, 4), batches[2].completed);
    try std.testing.expectEqual(@as(usize, 4), limiter.active);
    for (4..12) |id| try std.testing.expectEqual(@as(usize, if (id == 6) 0 else 1), persist.seen[id]);
    batches[0].deadline_ns = 0;
    try std.testing.expect(try batches[0].step(.{}, &persist));
    try std.testing.expectEqual(@as(usize, 0), limiter.active);
    try std.testing.expectEqual(@as(usize, 12), stats.forks);
    try std.testing.expectEqual(stats.forks, stats.retired);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}

test "receipt fiber workers claim each job once, retire every permit and keep failures per job" {
    const a = std.testing.allocator;
    var limiter = try Limiter.init(a, &.{1});
    defer limiter.deinit();
    var budget: @import("../../net/read_replay.zig").ByteBudget = .{ .maximum = 1024 * 1024 };
    var stats: FakeNetwork.Stats = .{};
    var parent: FakeNetwork = .{ .allocator = a, .stats = &stats, .options = .{ .read_budget = &budget } };
    var requests: [6]enrich.Request = undefined;
    for (&requests, 0..) |*request, i| {
        var tx: [64]u8 = @splat(0);
        tx[63] = @intCast(i + 4);
        request.* = .{ .meta = .{ .tx_hash = tx, .block_hash = @splat(2), .block_number = 5 }, .block_id = 1 };
    }
    var batch = try Batch(FakeNetwork).init(a, &parent, &limiter, 1, &requests, (try pg.nowNs()) + 10 * std.time.ns_per_s);
    defer batch.deinit();
    var persist: FakePersist = .{};
    // Off a fiber the workers run inline; the claim/retire protocol is the same.
    try batch.runFibers(.{}, &persist, 4);
    try std.testing.expect(batch.done());
    try std.testing.expectEqual(@as(usize, 0), batch.waiting());
    try std.testing.expect(batch.claim() == null);
    try std.testing.expectEqual(@as(usize, 1), batch.failures);
    for (4..10) |id| try std.testing.expectEqual(@as(usize, if (id == 6) 0 else 1), persist.seen[id]);
    try std.testing.expectEqual(@as(usize, 6), stats.forks);
    try std.testing.expectEqual(stats.forks, stats.retired);
    try std.testing.expectEqual(@as(usize, 0), limiter.active);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}

fn allocationFailures(a: A) !void {
    var limiter = try Limiter.init(a, &.{1});
    defer limiter.deinit();
    var budget: @import("../../net/read_replay.zig").ByteBudget = .{ .maximum = 1024 * 1024 };
    var stats: FakeNetwork.Stats = .{};
    var parent: FakeNetwork = .{ .allocator = a, .stats = &stats, .options = .{ .read_budget = &budget } };
    var tx: [64]u8 = @splat(0);
    tx[63] = 4;
    const request: enrich.Request = .{ .meta = .{ .tx_hash = tx, .block_hash = @splat(2), .block_number = 5 }, .block_id = 1 };
    var batch = try Batch(FakeNetwork).init(a, &parent, &limiter, 1, &.{request}, (try pg.nowNs()) + std.time.ns_per_s);
    defer batch.deinit();
    var persist: FakePersist = .{};
    while (!try batch.step(.{}, &persist)) {}
    try std.testing.expectEqual(@as(usize, 1), persist.seen[4]);
}
test "receipt batches release admission owned results and quota on every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFailures, .{});
}
