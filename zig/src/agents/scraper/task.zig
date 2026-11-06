//! Operational scraper lanes. Head, delivery, gas, reconciliation and optional
//! CCR have independent mutable clients/cancellation. Native PG leases cover DB
//! work only; no scarce DB connection waits on a receipt RPC.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const types = @import("../../settings/types.zig");
const pg = @import("../../db/postgres.zig");
const pool = @import("../../db/pool.zig");
const Curl = @import("../../net/curl.zig");
const chain_source = @import("../chain_source.zig");
const supervisor = @import("../../runtime/supervisor.zig");
const metrics = @import("../../ops/metrics.zig");
const critical_metrics = @import("../../ops/critical_metrics.zig");
const dynamic_tip_cache = @import("../../net/dynamic_tip_cache.zig");
const src = @import("source.zig");
const storage = @import("storage.zig");
const service = @import("service.zig");
const runtime = @import("runtime.zig");
const enrich = @import("enrichment.zig");
const reconcile = @import("reconciliation.zig");
const ccr = @import("ccr.zig");
const receipt_jobs = @import("receipt_jobs.zig");
const ReceiptBatch = receipt_jobs.Batch(chain_source.Resources);
const HeadOwner = @import("../../runtime/lane_owner.zig").Owner;
const A = std.mem.Allocator;
pub const Options = struct {
    curl_library: []const u8,
    metrics: ?*metrics.Registry = null,
    request_timeout_ms: u32 = 20000,
    db_timeout_ms: u32 = 30000,
    head_timeout_ms: u64 = 120000,
    auxiliary_timeout_ms: u64 = 30000,
    allow_insecure_loopback: bool = false,
    /// Borrowed only during open; the retained configuration clears it.
    startup_cancel: ?*const std.atomic.Value(bool) = null,
    /// Disposable process fixture override; production generates a fresh owner.
    writer_id: ?[]const u8 = null,
};
const Kind = enum { head, delivery, gas, reconciliation, ccr };
const Chain = struct {
    configured: *const types.Chain,
    writer: []u8,
    routers: []ccr.Router,
    critical: critical_metrics.Tracker = .{},
    initialized_mask: std.atomic.Value(u8) = .init(0),
    required_mask: u8 = 15,
};
const Lane = struct {
    owner: *TaskSet,
    chain: *Chain,
    kind: Kind,
    resources: ?*chain_source.Resources = null,
    head_service: ?*service.Pooled = null,
    receipt_lane: enrich.Lane = .{ .stream = .delivery },
    schedule: ?reconcile.Schedule = null,
    backoff: reconcile.Backoff,
    ccr_lane: ?ccr.Lane = null,
    failures: runtime.FailureStreak = .{},
    receipt_batch: ?ReceiptBatch = null,
    receipt_page: ?enrich.Page = null,
    receipt_linked: u64 = 0,
    reconcile_page: ?struct { plan: reconcile.Plan, selected: reconcile.Lane, times: supervisor.Times, started_ns: u64 } = null,
    ccr_page: ?struct { plan: ccr.Plan, requests: []enrich.Request, range: ccr.Range } = null,
    attempt_deadline_ns: ?u64 = null,
    head_owner: ?HeadOwner = null,
    fn criticalReason(self: *const Lane) critical_metrics.Reason {
        return switch (self.kind) {
            .head => .message_sync,
            .delivery => .message_context,
            .gas => .gas_payment_sync,
            .reconciliation => .message_db_loader,
            .ccr => .merkle_tree_db_loader,
        };
    }
    fn initialized(self: *Lane) void {
        const bit = @as(u8, 1) << @as(u3, @intCast(@intFromEnum(self.kind)));
        const previous = self.chain.initialized_mask.fetchOr(bit, .acq_rel);
        self.chain.critical.clear(self.criticalReason());
        if ((previous | bit) == self.chain.required_mask) {
            self.chain.critical.clear(.origin);
            self.chain.critical.started();
        }
    }
    fn clearPending(self: *Lane) void {
        if (self.receipt_batch) |*batch| batch.deinit();
        self.receipt_batch = null;
        if (self.receipt_page) |*page| page.deinit();
        self.receipt_page = null;
        self.receipt_linked = 0;
        if (self.reconcile_page) |*page| page.plan.deinit();
        self.reconcile_page = null;
        if (self.ccr_page) |*page| {
            page.plan.deinit();
            self.owner.allocator.free(page.requests);
        }
        self.ccr_page = null;
    }
    fn deinit(self: *Lane) void {
        if (self.head_owner) |*owner| owner.deinit();
        self.clearPending();
        if (self.head_service) |head_service| head_service.deinit();
        if (self.resources) |resources| resources.deinit();
        self.backoff.deinit();
    }
    fn sourceResources(self: *Lane, cancel: *const std.atomic.Value(bool)) !*chain_source.Resources {
        if (self.resources == null) self.resources = try chain_source.Resources.open(self.owner.allocator, self.chain.configured, self.owner.environment, .{ .curl_library = self.owner.options.curl_library, .request_timeout_ms = self.owner.options.request_timeout_ms, .allow_insecure_loopback = self.owner.options.allow_insecure_loopback, .metrics = self.owner.options.metrics, .http_runtime = self.owner.http_runtime, .read_budget = &self.owner.read_budget, .dynamic_tip_cache = self.owner.dynamic_tip_cache, .indexer_tip_cache = self.kind == .head, .rpc_parallelism = 8, .operation = if (self.kind == .head or self.kind == .delivery or self.kind == .gas) .contract_sync else .unattributed });
        self.resources.?.setCancellation(cancel);
        return self.resources.?;
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Lane = @ptrCast(@alignCast(context));
        if (self.head_owner) |*owner| return (owner.poll(times, cancel) catch |err| {
            if (err == error.LaneOwnerDeadline) self.chain.critical.record(self.criticalReason());
            return err;
        }) orelse error.PendingReadIo;
        return cycle(context, times, cancel);
    }
    fn cycle(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Lane = @ptrCast(@alignCast(context));
        if (cancel.load(.acquire)) {
            self.clearPending();
            self.attempt_deadline_ns = null;
            return error.RequestCancelled;
        }
        if (self.attempt_deadline_ns == null) self.attempt_deadline_ns = (try pg.nowNs()) +| (if (self.kind == .head) self.owner.options.head_timeout_ms else self.owner.options.auxiliary_timeout_ms) *| std.time.ns_per_ms;
        const deadline = self.attempt_deadline_ns.?;
        const resources = self.sourceResources(cancel) catch |err| {
            self.attempt_deadline_ns = null;
            return self.failed(err, times);
        };
        defer resources.setCancellation(null);
        const previous_rpc_deadline = resources.rpc_deadline_ns;
        const previous_rpc_owner = resources.http.rpc_read_owner;
        const rpc_deadline = @min(deadline, @min(previous_rpc_deadline orelse deadline, if (previous_rpc_owner) |owner| owner.deadline_ns else deadline));
        resources.rpc_deadline_ns = rpc_deadline;
        resources.http.rpc_read_owner = .{ .deadline_ns = rpc_deadline, .halt = if (previous_rpc_owner) |owner| owner.halt else null, .retry_physical_timeout = if (previous_rpc_owner) |owner| owner.retry_physical_timeout else true };
        defer {
            resources.rpc_deadline_ns = previous_rpc_deadline;
            resources.http.rpc_read_owner = previous_rpc_owner;
        }
        const io: pg.IoOptions = .{ .timeout_ms = self.owner.options.db_timeout_ms, .deadline_ns = deadline, .cancel = cancel };
        const report = switch (self.kind) {
            .head => self.head(times, io),
            .delivery, .gas => self.receipts(times, io),
            .reconciliation => self.reconciliation(times, io),
            .ccr => self.sameChain(times, io),
        };
        if (report) |value| {
            self.attempt_deadline_ns = null;
            _ = self.failures.record(false, times.monotonic_ms, 60000);
            self.initialized();
            return value;
        } else |err| {
            if (err == error.PendingReadIo) return err;
            if (self.reconcile_page) |page| self.schedule.?.failed(page.selected, times.monotonic_ms) catch {};
            self.clearPending();
            self.attempt_deadline_ns = null;
            return self.failed(err, times);
        }
    }
    fn failed(self: *Lane, err: anyerror, times: supervisor.Times) anyerror {
        std.log.warn("scraper chain={s} lane={s} failed={s}", .{ self.chain.configured.name, @tagName(self.kind), @errorName(err) });
        // Control failures and allocator pressure are not failed source heads.
        // Leave an existing genuine failure streak untouched.
        if (err == error.PendingReadIo or err == error.PendingIo or err == error.RequestCancelled or err == error.OutOfMemory) return err;
        const bit = @as(u8, 1) << @as(u3, @intCast(@intFromEnum(self.kind)));
        if (self.chain.initialized_mask.load(.acquire) & bit == 0 and err != error.PendingReadIo and err != error.PendingIo and err != error.RequestCancelled and err != error.OutOfMemory) {
            self.chain.critical.record(.origin);
            self.chain.critical.record(self.criticalReason());
        }
        if (err == error.ScraperPublishedReorg or err == error.ScraperCriticalFailure) self.chain.critical.record(self.criticalReason());
        if (self.kind == .head and self.head_service != null and self.failures.record(true, times.monotonic_ms, 60000)) {
            self.chain.critical.record(self.criticalReason());
            return error.ScraperCriticalFailure;
        }
        return err;
    }
    fn head(self: *Lane, times: supervisor.Times, io: pg.IoOptions) !supervisor.Report {
        const resources = self.resources.?;
        if (self.head_service == null) self.head_service = try service.Pooled.init(self.owner.allocator, self.owner.database, try resources.source(), self.chain.configured, self.chain.writer, self.owner.options.db_timeout_ms, io);
        const result = try self.head_service.?.headCycle(io);
        const update = self.head_service.?.native.worker.delayAfter(result, times.monotonic_ms);
        if (update.critical) return error.ScraperCriticalFailure;
        const names = [_][]const u8{ "message_dispatch", "message_delivery", "gas_payment", "merkle_tree_insertion" };
        var work: u64 = 0;
        for (result.published, names) |count, name| {
            work +|= count;
            try self.metric("hyperlane_contract_sync_stored_events", &.{ name, self.chain.configured.name }, .{ .add_int = count });
            try self.metric("hyperlane_contract_sync_block_height", &.{ name, self.chain.configured.name }, .{ .set_int = std.math.cast(i64, result.indexed) orelse std.math.maxInt(i64) });
        }
        return .{ .work = work, .next_delay_ms = update.delay_ms };
    }
    fn database(self: *Lane, io: pg.IoOptions) !Db {
        var lease = try self.owner.database.acquire(io);
        errdefer lease.deinit();
        const store: storage.Store = .{ .connection = lease.connection(), .domain = self.chain.configured.domain, .mailbox = self.chain.configured.contracts.mailbox };
        if (self.owner.database.config.session_timeout_ms != self.owner.options.db_timeout_ms) try store.configure(self.owner.options.db_timeout_ms);
        return .{ .lease = lease, .store = store };
    }
    const Db = struct {
        lease: pool.Lease,
        store: storage.Store,
        fn deinit(self: *Db) void {
            self.lease.deinit();
        }
    };
    fn pollInterval(self: *const Lane) u64 {
        return @max(1, self.chain.configured.index.interval *| 1000);
    }
    fn receipts(self: *Lane, _: supervisor.Times, io: pg.IoOptions) !supervisor.Report {
        if (self.receipt_page == null) {
            var db = try self.database(io);
            defer db.deinit();
            self.receipt_page = try self.receipt_lane.plan(self.owner.allocator, db.store);
        }
        const page = &self.receipt_page.?;
        try self.fetchRequests(page.requests, io);
        var db = try self.database(io);
        defer db.deinit();
        var result = try self.receipt_lane.finish(db.store, page.*);
        result.linked +|= self.receipt_linked;
        self.receipt_linked = 0;
        page.deinit();
        self.receipt_page = null;
        return .{ .work = result.linked, .next_delay_ms = if (result.more) 0 else self.pollInterval() };
    }
    const Persist = struct {
        lane: *Lane,
        pub fn store(self: Persist, request: enrich.Request, value: enrich.Txn, header: ?src.Header, io: pg.IoOptions) !void {
            var db = try self.lane.database(io);
            defer db.deinit();
            try enrich.persistFetched(db.store, request, value, header);
            // A stalled sibling must not defer already available receipt links.
            if (self.lane.receipt_page) |page| self.lane.receipt_linked +|= try db.store.linkReceipts(page.stream, page.after, page.through);
        }
    };
    fn fetchRequests(self: *Lane, requests: []const enrich.Request, io: pg.IoOptions) !void {
        if (requests.len == 0) return;
        if (self.receipt_batch == null) self.receipt_batch = try ReceiptBatch.init(self.owner.allocator, self.resources.?, &self.owner.receipt_limit, self.chain.configured.domain, requests, io.deadline_ns.?);
        if (!try self.receipt_batch.?.step(io, Persist{ .lane = self })) return error.PendingReadIo;
        if (self.receipt_batch.?.failures > 0) std.log.warn("scraper chain={s} lane={s} receipt_failures={d} last={s}", .{ self.chain.configured.name, @tagName(self.kind), self.receipt_batch.?.failures, @errorName(self.receipt_batch.?.last_failure.?) });
        self.receipt_batch.?.deinit();
        self.receipt_batch = null;
    }
    fn reconciliation(self: *Lane, times: supervisor.Times, io: pg.IoOptions) !supervisor.Report {
        if (self.reconcile_page != null) return self.completeReconciliation(io);
        const now = times.monotonic_ms;
        const started_ns = try pg.nowNs();
        if (self.schedule == null) {
            var db = try self.database(io);
            defer db.deinit();
            const frontier = db.store.rawFrontier() catch |err| {
                self.schedule = reconcile.Schedule.init(0, now, now +| 2000);
                return err;
            };
            self.schedule = reconcile.Schedule.init(frontier, now, 0);
        }
        const seconds = std.math.cast(i64, times.unix_ms / 1000) orelse return error.InvalidClock;
        const ids = try self.backoff.due(self.owner.allocator, seconds, 100);
        defer self.owner.allocator.free(ids);
        var selected = self.schedule.?.due(now, ids.len > 0) orelse return .{ .next_delay_ms = self.schedule.?.nextDelay(now, self.backoff.nextDelay(seconds)) };
        errdefer |err| if (err != error.PendingReadIo) {
            self.schedule.?.failed(selected, now) catch {};
        };
        switch (selected) {
            .discovery_frontier, .sweep_frontier => {
                var db = try self.database(io);
                defer db.deinit();
                const frontier = try db.store.rawFrontier();
                if (selected == .discovery_frontier) try self.schedule.?.startDiscovery(frontier, now) else try self.schedule.?.startSweep(frontier, now);
                // Source reads the immutable frontier and its first page in
                // the same cycle. A scheduler turn is not a2s page boundary.
                if (selected == .discovery_frontier and self.schedule.?.discovery != null) selected = .discovery_page else if (selected == .sweep_frontier and self.schedule.?.sweep != null) selected = .sweep_page else return .{ .next_delay_ms = self.schedule.?.nextDelay(now, self.backoff.nextDelay(seconds)) };
            },
            else => {},
        }
        const plan = blk: {
            var db = try self.database(io);
            defer db.deinit();
            if (selected == .retry) break :blk try reconcile.planRetry(self.owner.allocator, db.store, self.backoff, ids, seconds);
            const scan = if (selected == .discovery_page) self.schedule.?.discovery.? else self.schedule.?.sweep.?;
            break :blk try reconcile.planPage(self.owner.allocator, db.store, self.backoff, scan.after, scan.through, seconds);
        };
        self.reconcile_page = .{ .plan = plan, .selected = selected, .times = times, .started_ns = started_ns };
        return self.completeReconciliation(io);
    }
    fn completeReconciliation(self: *Lane, io: pg.IoOptions) !supervisor.Report {
        const retained = &self.reconcile_page.?;
        try self.fetchRequests(retained.plan.requests, io);
        var db = try self.database(io);
        defer db.deinit();
        const elapsed = ((try pg.nowNs()) -| retained.started_ns) / std.time.ns_per_ms;
        const completed_seconds = std.math.cast(i64, (retained.times.unix_ms +| elapsed) / 1000) orelse return error.InvalidClock;
        const result = try reconcile.finish(db.store, self.chain.configured.contracts.mailbox, &retained.plan, &self.backoff, completed_seconds);
        const completed_now = retained.times.monotonic_ms +| elapsed;
        switch (retained.selected) {
            .retry => {},
            .discovery_page => try self.schedule.?.completeDiscovery(result, completed_now),
            .sweep_page => try self.schedule.?.completeSweep(result, completed_now),
            else => unreachable,
        }
        try self.metric("hyperlane_raw_message_dispatch_reconciliation_operations", &.{ self.chain.configured.name, @tagName(retained.selected) }, .{ .add_int = 1 });
        try self.metric("hyperlane_raw_message_dispatch_reconciliation_pending_retries", &.{self.chain.configured.name}, .{ .set_int = self.backoff.rows.count() });
        retained.plan.deinit();
        self.reconcile_page = null;
        return .{ .work = result.stored_count, .next_delay_ms = self.schedule.?.nextDelay(completed_now, self.backoff.nextDelay(completed_seconds)) };
    }
    fn sameChain(self: *Lane, _: supervisor.Times, io: pg.IoOptions) !supervisor.Report {
        if (self.ccr_page != null) return self.completeSameChain(io);
        const resources = self.resources.?;
        if (resources.clients != .ethereum) return error.UnsupportedCcrProtocol;
        _ = try resources.source();
        const client = resources.clients.ethereum;
        if (self.ccr_lane == null) {
            var db = try self.database(io);
            defer db.deinit();
            self.ccr_lane = .{ .from = try db.store.ccrCursor(@intCast(@max(0, self.chain.configured.index.from))), .chunk = self.chain.configured.index.chunk };
        }
        const confirmed = blk: {
            var db = try self.database(io);
            defer db.deinit();
            const store: @import("../../db/scraper_store.zig").Store = .{ .connection = db.lease.connection(), .domain = self.chain.configured.domain, .writer_id = self.chain.writer };
            break :blk (try store.state() orelse return error.MissingScraperHead).confirmed;
        };
        const finalized = (try client.blockHeader(.finalized)).number;
        const range = try self.ccr_lane.?.next(confirmed, finalized) orelse return .{ .next_delay_ms = 5000 };
        var chain: ccr.Evm = .{ .rpc_client = client, .domain = self.chain.configured.domain, .routers = self.chain.routers };
        var plan = try chain.plan(self.owner.allocator, range.from, range.through);
        var plan_moved = false;
        errdefer if (!plan_moved) plan.deinit();
        const requests = try self.owner.allocator.alloc(enrich.Request, plan.requests.len);
        for (plan.requests, requests) |meta, *request| request.* = .{ .meta = meta, .block_id = null };
        self.ccr_page = .{ .plan = plan, .requests = requests, .range = range };
        plan_moved = true;
        return self.completeSameChain(io);
    }
    fn completeSameChain(self: *Lane, io: pg.IoOptions) !supervisor.Report {
        const retained = &self.ccr_page.?;
        try self.fetchRequests(retained.requests, io);
        var chain: ccr.Evm = .{ .rpc_client = self.resources.?.clients.ethereum, .domain = self.chain.configured.domain, .routers = self.chain.routers };
        var arena = std.heap.ArenaAllocator.init(self.owner.allocator);
        defer arena.deinit();
        var swaps: std.ArrayList(ccr.Swap) = .empty;
        for (retained.plan.candidates) |candidate| {
            var receipt = try chain.receipt(self.owner.allocator, candidate.meta);
            defer receipt.deinit();
            if (try ccr.assemble(self.chain.configured.domain, self.chain.routers, candidate, receipt)) |swap| try swaps.append(arena.allocator(), swap);
        }
        var db = try self.database(io);
        defer db.deinit();
        // Every candidate's transaction must be present before advancing CCR.
        for (retained.requests) |request| if (try db.store.knownTransaction(request.meta) == null) return error.CcrMissingTransaction;
        const work = try self.ccr_lane.?.commit(db.store, retained.range, swaps.items);
        retained.plan.deinit();
        self.owner.allocator.free(retained.requests);
        self.ccr_page = null;
        return .{ .work = work, .next_delay_ms = 0 };
    }
    fn metric(self: *Lane, name: []const u8, labels: []const []const u8, update: metrics.Update) !void {
        if (self.owner.options.metrics) |registry| try registry.update(name, labels, update);
    }
};
pub const TaskSet = struct {
    allocator: A,
    settings: *const settings.Settings,
    environment: *const std.process.EnvMap,
    options: Options,
    resolver: Curl.Client,
    database: *pool.Pool,
    http_runtime: *chain_source.HttpRuntime.Runtime,
    read_budget: chain_source.ReadReplay.ByteBudget = .{},
    dynamic_tip_cache: ?*dynamic_tip_cache.Cache = null,
    receipt_limit: receipt_jobs.Limiter,
    chains: []Chain,
    lanes: []Lane,
    tasks: []supervisor.Task,
    initialized_chains: usize = 0,
    initialized_lanes: usize = 0,
    pub fn open(a: A, configured: *const settings.Settings, env: *const std.process.EnvMap, options: Options) !*TaskSet {
        if (options.startup_cancel) |cancel| if (cancel.load(.acquire)) return error.PostgresCancelled;
        if (configured.role != .scraper or configured.chains.len == 0) return error.ExpectedScraperSettings;
        if (options.db_timeout_ms == 0 or options.db_timeout_ms > 300000 or options.request_timeout_ms == 0 or options.head_timeout_ms == 0 or options.auxiliary_timeout_ms == 0 or options.head_timeout_ms > 3600000 or options.auxiliary_timeout_ms > 3600000) return error.InvalidScraperTaskOptions;
        const self = try a.create(TaskSet);
        errdefer a.destroy(self);
        var resolver = try Curl.Client.init(a, options.curl_library);
        errdefer resolver.deinit();
        const db = try pool.Pool.init(a, configured.role.scraper.db, .{ .max_connections = std.math.cast(u8, @min(5, configured.role.scraper.db_max_connections)) orelse return error.InvalidPostgresPoolConfig, .acquire_timeout_ms = configured.role.scraper.db_acquire_timeout_ms, .session_timeout_ms = options.db_timeout_ms });
        errdefer db.deinit();
        const http_runtime = try chain_source.HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = options.curl_library, .max_concurrent = 64, .max_pending = 64, .max_response_bytes = 16 * 1024 * 1024, .max_request_bytes = 16 * 1024 * 1024, .max_reserved_bytes = 512 * 1024 * 1024 }, .max_sessions = 64 });
        errdefer http_runtime.deinit();
        const domains = try a.alloc(u32, configured.chains.len);
        defer a.free(domains);
        for (configured.chains, domains) |chain, *domain| domain.* = chain.domain;
        var receipt_limit = try receipt_jobs.Limiter.init(a, domains);
        errdefer receipt_limit.deinit();
        const chains = try a.alloc(Chain, configured.chains.len);
        errdefer a.free(chains);
        var count: usize = configured.chains.len * 4;
        for (configured.chains) |chain| for (configured.role.scraper.ccr_routers) |router| if (router.domain == chain.domain) {
            if (chain.protocol != .ethereum) return error.UnsupportedCcrProtocol;
            count += 1;
            break;
        };
        if (count > 4096) return error.ScraperTaskLimit;
        const lanes = try a.alloc(Lane, count);
        errdefer a.free(lanes);
        const tasks = try a.alloc(supervisor.Task, count);
        errdefer a.free(tasks);
        self.* = .{ .allocator = a, .settings = configured, .environment = env, .options = options, .resolver = resolver, .database = db, .http_runtime = http_runtime, .receipt_limit = receipt_limit, .chains = chains, .lanes = lanes, .tasks = tasks };
        self.dynamic_tip_cache = try dynamic_tip_cache.Cache.init(a, .{});
        errdefer self.dynamic_tip_cache.?.deinit();
        db.config.resolver = &self.resolver;
        {
            // One deadline includes pool acquisition, connection/session setup
            // and every catalog query. No lane can mutate DB/RPC state first.
            const deadline = (try pg.nowNs()) +| @as(u64, options.db_timeout_ms) * std.time.ns_per_ms;
            var lease = try db.acquire(.{ .timeout_ms = options.db_timeout_ms, .deadline_ns = deadline, .cancel = options.startup_cancel });
            defer lease.deinit();
            try @import("../../db/scraper_schema.zig").verifyFrontierIndexes(lease.connection());
        }
        self.options.startup_cancel = null;
        errdefer {
            for (lanes[0..self.initialized_lanes]) |*lane| if (lane.head_owner) |*owner| owner.requestStop();
            for (lanes[0..self.initialized_lanes]) |*lane| if (lane.head_owner) |*owner| owner.deinit();
            for (lanes[0..self.initialized_lanes]) |*lane| lane.deinit();
            for (chains[0..self.initialized_chains]) |chain| {
                a.free(chain.writer);
                a.free(chain.routers);
            }
        }
        var nonce: [16]u8 = undefined;
        std.crypto.random.bytes(&nonce);
        for (configured.chains, chains) |*chain, *owned| {
            const writer = try std.fmt.allocPrint(a, "{s}-{s}-{d}", .{ options.writer_id orelse "ziggy-scraper", std.fmt.bytesToHex(nonce, .lower), chain.domain });
            var writer_transferred = false;
            errdefer if (!writer_transferred) a.free(writer);
            var routers: std.ArrayList(ccr.Router) = .empty;
            errdefer routers.deinit(a);
            for (configured.role.scraper.ccr_routers) |router| if (router.domain == chain.domain) try routers.append(a, .{ .address = router.router, .token = router.token });
            owned.* = .{ .configured = chain, .writer = writer, .routers = try routers.toOwnedSlice(a) };
            owned.critical = .{ .registry = options.metrics, .chain = chain.name };
            owned.required_mask = if (owned.routers.len > 0) 31 else 15;
            self.initialized_chains += 1;
            writer_transferred = true;
            const kinds = [_]Kind{ .head, .delivery, .gas, .reconciliation, .ccr };
            for (kinds) |kind| {
                if (kind == .ccr and owned.routers.len == 0) continue;
                const i = self.initialized_lanes;
                lanes[i] = .{ .owner = self, .chain = owned, .kind = kind, .receipt_lane = .{ .stream = if (kind == .gas) .gas else .delivery }, .backoff = .{ .allocator = a } };
                if (kind == .head) lanes[i].head_owner = try HeadOwner.init(&lanes[i], Lane.cycle, .{ .timeout_ms = options.head_timeout_ms });
                tasks[i] = .{ .context = &lanes[i], .run = Lane.run, .failure = classify, .interval_ms = if (kind == .head) @max(1, @min(60000, chain.index.interval *| 1000)) else if (kind == .delivery or kind == .gas) @max(1, chain.index.interval *| 1000) else 5000, .timeout_ms = if (kind == .head) options.head_timeout_ms else options.auxiliary_timeout_ms };
                self.initialized_lanes += 1;
            }
        }
        if (options.startup_cancel) |cancel| if (cancel.load(.acquire)) return error.PostgresCancelled;
        return self;
    }
    pub fn descriptors(self: *TaskSet) []const supervisor.Task {
        return self.tasks;
    }
    pub fn criticalForChain(self: *TaskSet, domain: u32) ?*critical_metrics.Tracker {
        for (self.chains) |*chain| if (chain.configured.domain == domain) return &chain.critical;
        return null;
    }
    /// Stop and join the supervisor first; all borrowed settings/env outlive us.
    pub fn deinit(self: *TaskSet) void {
        // Signal every blocking head before joining any. Receipt jobs/forks
        // retire next, then their parent clients and the shared transport/DB.
        for (self.lanes) |*lane| if (lane.head_owner) |*owner| owner.requestStop();
        for (self.lanes) |*lane| if (lane.head_owner) |*owner| owner.deinit();
        for (self.lanes) |*lane| lane.deinit();
        self.receipt_limit.deinit();
        if (self.dynamic_tip_cache) |value| value.deinit();
        self.http_runtime.deinit();
        self.database.deinit();
        self.resolver.deinit();
        const a = self.allocator;
        for (self.chains) |chain| {
            a.free(chain.writer);
            a.free(chain.routers);
        }
        a.free(self.chains);
        a.free(self.lanes);
        a.free(self.tasks);
        a.destroy(self);
    }
    fn classify(err: anyerror) supervisor.FailureAction {
        return switch (err) {
            error.ScraperPublishedReorg, error.ScraperCriticalFailure => .halt_all,
            else => .retry,
        };
    }
};

test "scraper receipt cadence follows configured chain interval" {
    var configured: types.Chain = undefined;
    configured.index = .{ .interval = 1 };
    var chain: Chain = .{ .configured = &configured, .writer = undefined, .routers = undefined };
    const lane: Lane = .{ .owner = undefined, .chain = &chain, .kind = .delivery, .backoff = .{ .allocator = std.testing.allocator } };
    try std.testing.expectEqual(@as(u64, 1000), lane.pollInterval());
    configured.index.interval = 7;
    try std.testing.expectEqual(@as(u64, 7000), lane.pollInterval());
}

fn criticalSample(registry: *metrics.Registry) !?u8 {
    const text = try registry.render(std.testing.allocator);
    defer std.testing.allocator.free(text);
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "hyperlane_critical_error{")) continue;
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidCriticalSample;
        return try std.fmt.parseInt(u8, line[space + 1 ..], 10);
    }
    return null;
}

test "scraper startup and independent lane recovery preserve health construction failure" {
    const registry = try metrics.Registry.init(std.testing.allocator, .scraper, .{ .base_version = "fixture" });
    defer registry.deinit();
    var configured: types.Chain = undefined;
    configured.name = "critical-fixture";
    var chain: Chain = .{ .configured = &configured, .writer = undefined, .routers = undefined, .critical = .{ .registry = registry, .chain = configured.name } };
    const kinds = [_]Kind{ .head, .delivery, .gas, .reconciliation };
    var lanes: [4]Lane = undefined;
    for (&lanes, kinds) |*lane, kind| lane.* = .{ .owner = undefined, .chain = &chain, .kind = kind, .backoff = .{ .allocator = std.testing.allocator } };
    try std.testing.expect((try criticalSample(registry)) == null);
    try std.testing.expectEqual(error.RpcHttpStatus, lanes[2].failed(error.RpcHttpStatus, .{ .unix_ms = 0, .monotonic_ms = 0 }));
    lanes[0].initialized();
    lanes[1].initialized();
    lanes[3].initialized();
    try std.testing.expectEqual(@as(?u8, 1), try criticalSample(registry));
    chain.critical.record(.destination_metrics);
    lanes[2].initialized();
    try std.testing.expectEqual(@as(?u8, 1), try criticalSample(registry));
    chain.critical.clear(.destination_metrics);
    try std.testing.expectEqual(@as(?u8, 0), try criticalSample(registry));
    chain.critical.record(.message_sync); // Actual head-owner timeout path.
    lanes[2].initialized(); // Healthy gas cannot clear head loss of liveness.
    try std.testing.expectEqual(@as(?u8, 1), try criticalSample(registry));
    lanes[0].initialized(); // Only a completed healthy head cycle recovers it.
    try std.testing.expectEqual(@as(?u8, 0), try criticalSample(registry));
}

test "scraper optional CCR startup participates and canceled setup has no failure sample" {
    const registry = try metrics.Registry.init(std.testing.allocator, .scraper, .{ .base_version = "fixture" });
    defer registry.deinit();
    var configured: types.Chain = undefined;
    configured.name = "critical-ccr-fixture";
    var chain: Chain = .{ .configured = &configured, .writer = undefined, .routers = undefined, .critical = .{ .registry = registry, .chain = configured.name }, .required_mask = 31 };
    const kinds = [_]Kind{ .head, .delivery, .gas, .reconciliation, .ccr };
    var lanes: [5]Lane = undefined;
    for (&lanes, kinds) |*lane, kind| lane.* = .{ .owner = undefined, .chain = &chain, .kind = kind, .backoff = .{ .allocator = std.testing.allocator } };
    try std.testing.expectEqual(error.RequestCancelled, lanes[4].failed(error.RequestCancelled, .{ .unix_ms = 0, .monotonic_ms = 0 }));
    for (lanes[0..4]) |*lane| lane.initialized();
    try std.testing.expect((try criticalSample(registry)) == null);
    lanes[4].initialized();
    try std.testing.expectEqual(@as(?u8, 0), try criticalSample(registry));
}

test "scraper head control and allocation errors cannot create or reset source failure streak" {
    var configured: types.Chain = undefined;
    configured.name = "head-control-fixture";
    var chain: Chain = .{ .configured = &configured, .writer = undefined, .routers = undefined, .initialized_mask = .init(15) };
    var pooled: service.Pooled = undefined; // Presence only; failed() performs no DB/network work.
    for ([_]anyerror{ error.RequestCancelled, error.OutOfMemory, error.PendingReadIo, error.PendingIo }) |control| {
        var lane: Lane = .{ .owner = undefined, .chain = &chain, .kind = .head, .head_service = &pooled, .backoff = .{ .allocator = std.testing.allocator } };
        try std.testing.expectEqual(control, lane.failed(control, .{ .unix_ms = 0, .monotonic_ms = 0 }));
        try std.testing.expectEqual(control, lane.failed(control, .{ .unix_ms = 60000, .monotonic_ms = 60000 }));
        try std.testing.expectEqual(@as(u16, 0), chain.critical.reasons);
        // A control event must not reset an already existing genuine streak.
        try std.testing.expectEqual(error.RpcHttpStatus, lane.failed(error.RpcHttpStatus, .{ .unix_ms = 70000, .monotonic_ms = 70000 }));
        try std.testing.expectEqual(control, lane.failed(control, .{ .unix_ms = 100000, .monotonic_ms = 100000 }));
        try std.testing.expectEqual(error.ScraperCriticalFailure, lane.failed(error.RpcHttpStatus, .{ .unix_ms = 130000, .monotonic_ms = 130000 }));
        chain.critical = .{};
    }
}
