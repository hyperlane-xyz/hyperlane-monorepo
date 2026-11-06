//! Retained receipt read jobs; all transports are shared, every client/journal
//! is exclusive to one job. At most16 RPC jobs globally and4 per domain.
const std = @import("std");
const enrich = @import("enrichment.zig");
const source = @import("source.zig");
const pg = @import("../../db/postgres.zig");
const A = std.mem.Allocator;
pub const Limiter = struct {
    allocator: A,
    domains: std.AutoHashMapUnmanaged(u32, u8) = .empty,
    mutex: std.Thread.Mutex = .{},
    active: usize = 0,
    peak: usize = 0,
    pub fn init(a: A, domains: []const u32) !Limiter {
        var self: Limiter = .{ .allocator = a };
        errdefer self.domains.deinit(a);
        for (domains) |domain| {
            const entry = try self.domains.getOrPut(a, domain);
            entry.value_ptr.* = 0;
        }
        return self;
    }
    pub fn deinit(self: *Limiter) void {
        std.debug.assert(self.active == 0);
        self.domains.deinit(self.allocator);
    }
    pub fn acquire(self: *Limiter, domain: u32) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const count = self.domains.getPtr(domain) orelse return error.UnknownReceiptDomain;
        if (self.active >= 16 or count.* >= 4) return false;
        self.active += 1;
        self.peak = @max(self.peak, self.active);
        count.* += 1;
        return true;
    }
    pub fn release(self: *Limiter, domain: u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const count = self.domains.getPtr(domain).?;
        std.debug.assert(self.active > 0 and count.* > 0);
        self.active -= 1;
        count.* -= 1;
    }
};
pub fn Batch(comptime Network: type) type {
    return struct {
        const Self = @This();
        const Job = struct { request: enrich.Request, phase: enum { waiting, fetch, header, persist, done } = .waiting, network: ?*Network = null, value: ?enrich.OwnedTxn = null, header: ?source.Header = null, charged: usize = 0 };
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
    var persist: FakePersist = .{};
    for (0..8) |_| {
        for (&batches) |*batch| {
            _ = try batch.step(.{}, &persist);
        }
    }
    try std.testing.expectEqual(@as(usize, 0), batches[0].completed);
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
