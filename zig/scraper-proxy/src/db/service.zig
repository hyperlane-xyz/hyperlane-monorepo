//! `DbService` from `src/db/db.service.ts`.
const std = @import("std");
const core = @import("core");
const root = @import("root.zig");
const pq = @import("pq.zig");
const pool_mod = @import("pool.zig");
const listener_mod = @import("listener.zig");
const convert = @import("convert.zig");

const Value = core.json.Value;
const Failure = root.Failure;
const Error = root.Error;
const metrics = core.metrics;
const Role = metrics.DatabaseQueryRole;

pub const MIN_POOL_CLIENTS = 5;
pub const MAX_POOL_CLIENTS = 10;
pub const STATS_INTERVAL_MS = 60_000;
pub const IDLE_TIMEOUT_MS = 300_000;

pub const EVENT_STREAM_SCHEMA_CHECKS = [_][]const u8{
    "head_exists",
    "cursor_exists",
    "range_index_exists",
    "scraper_head_exists",
    "legacy_boundary_exists",
    "cursor_trigger_exists",
    "head_readable",
    "cursor_readable",
};

pub const EVENT_STREAM_SCHEMA_QUERY =
    \\
    \\  SELECT
    \\    to_regclass('gas_payment_stream_head') IS NOT NULL AS head_exists,
    \\    to_regclass('gas_payment_stream_cursor') IS NOT NULL AS cursor_exists,
    \\    to_regclass('gas_payment_stream_cursor_range_key') IS NOT NULL AS range_index_exists,
    \\    to_regclass('scraper_head') IS NOT NULL AS scraper_head_exists,
    \\    EXISTS (
    \\      SELECT 1 FROM pg_attribute
    \\      WHERE attrelid = to_regclass('gas_payment_stream_head')
    \\        AND attname = 'legacy_max_id'
    \\        AND NOT attisdropped
    \\    ) AS legacy_boundary_exists,
    \\    EXISTS (
    \\      SELECT 1 FROM pg_trigger
    \\      WHERE tgrelid = to_regclass('gas_payment')
    \\        AND tgname = 'gas_payment_stream_cursor_assign'
    \\        AND NOT tgisinternal
    \\        AND tgenabled IN ('O', 'A')
    \\    ) AS cursor_trigger_exists,
    \\    COALESCE(
    \\      has_table_privilege(
    \\        current_user,
    \\        to_regclass('gas_payment_stream_head'),
    \\        'SELECT'
    \\      ),
    \\      false
    \\    ) AS head_readable,
    \\    COALESCE(
    \\      has_table_privilege(
    \\        current_user,
    \\        to_regclass('gas_payment_stream_cursor'),
    \\        'SELECT'
    \\      ),
    \\      false
    \\    ) AS cursor_readable
    \\
;

const Stats = struct { errors: u64 = 0, max_ms: i64 = 0, queries: u64 = 0, rows: u64 = 0, total_ms: i64 = 0 };

/// Pool backend used by the service; swappable in tests (the TS tests mock
/// `pg.Pool.prototype`).
pub const Backend = struct {
    ctx: *anyopaque,
    query: *const fn (ctx: *anyopaque, which: Which, conninfo: []const u8, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error!root.Result,
    pub const Which = enum { main, live };
};

pub const DbService = struct {
    gpa: std.mem.Allocator,
    logger: core.log.Logger,
    config: core.config.Config,
    main_role: Role,
    mutex: std.Thread.Mutex = .{},
    main_pool: ?*pool_mod.Pool = null,
    live_pool: ?*pool_mod.Pool = null,
    listeners: std.ArrayList(*listener_mod.Listener) = .empty,
    /// Disconnected listeners awaiting `unlisten`/`close`.
    retired: std.ArrayList(*listener_mod.Listener) = .empty,
    idle_hooks: std.ArrayList(*IdleHook) = .empty,
    next_query_id: std.atomic.Value(u64) = .init(0),
    stats_mutex: std.Thread.Mutex = .{},
    stats: Stats = .{},
    stats_thread: ?std.Thread = null,
    /// `setInterval` for the stats log on the process scheduler (0: none).
    stats_timer: u64 = 0,
    stats_timers: ?*core.scheduler.Scheduler = null,
    stats_cond: std.Thread.Condition = .{},
    closing: bool = false,
    /// Set by `close` (under `mutex`): new queries/listens are rejected.
    ended: bool = false,
    /// Queries between admission and return (under `mutex`).
    in_flight: usize = 0,
    in_flight_done: std.Thread.Condition = .{},
    /// Reads early queries' replies as they arrive (`beginLive`).
    prefetch: Prefetcher = .{},
    /// True when `close` gave up waiting: memory must not be freed.
    leaked: bool = false,
    /// Test seam replacing the libpq pools.
    backend: ?Backend = null,
    clock: *const fn () i64 = pq.nowMs,

    pub fn init(gpa: std.mem.Allocator, logger: ?core.log.Logger) !*DbService {
        const self = try gpa.create(DbService);
        const config = core.config.get().*;
        self.* = .{
            .gpa = gpa,
            .logger = logger orelse core.log.child("DbService"),
            .config = config,
            .main_role = if (config.database_read_replica_url != null) .graphql_replica else .graphql_primary,
        };
        return self;
    }

    pub fn deinit(self: *DbService) void {
        self.close() catch {};
        // In-flight queries outlived the drain: they still reference us.
        if (self.leaked) return;
        self.gpa.destroy(self);
    }

    /// Bound for `close` to wait for in-flight queries (node-pg `pool.end()`
    /// waits for checked-out clients; ours is bounded so shutdown finishes).
    pub const close_drain_ms = 30_000;

    /// `start()`: schema checks, warm-up (primary only), stats timer. On
    /// failure `failure.message` holds the TS error message.
    pub fn start(self: *DbService, failure: *Failure, arena: std.mem.Allocator) Error!void {
        // TS validates the schema, then warms the primary pool. The warm-up
        // only opens connections, so it runs alongside the validation (one
        // connect + query less on the startup path). Its outcome counts only
        // once validation succeeded, as in TS: on a schema failure the
        // warmed connections are just closed with the pool, unreported.
        const warm = self.config.database_read_replica_url == null and self.backend == null;
        var warm_up: WarmUp = .{ .service = self };
        defer warm_up.arena.deinit();
        const thread: ?std.Thread = if (warm) std.Thread.spawn(.{}, WarmUp.run, .{&warm_up}) catch null else null;
        const schema = self.validateEventStreamSchema(arena, failure);
        if (warm) {
            if (thread) |t| t.join() else if (schema) |_| warm_up.run() else |_| {}
        }
        try schema;
        if (self.config.database_read_replica_url != null) {
            self.logger.info("GraphQL db role=read-replica; connections open lazily so replica health cannot gate websocket startup", .{});
        } else if (warm) {
            if (warm_up.err) |e| {
                failure.message = arena.dupe(u8, warm_up.failure.message) catch "";
                failure.code = null;
                return e;
            }
            self.logger.info("warmed {d} GraphQL db connections role=primary in {d}ms", .{ MIN_POOL_CLIENTS, warm_up.elapsed_ms });
        }
        if (core.scheduler.current()) |timers| {
            self.stats_timers = timers;
            self.stats_timer = timers.every(STATS_INTERVAL_MS, self, statsTick) catch 0;
        } else self.stats_thread = std.Thread.spawn(.{}, statsLoop, .{self}) catch null;
    }

    const WarmUp = struct {
        service: *DbService,
        arena: std.heap.ArenaAllocator = std.heap.ArenaAllocator.init(std.heap.c_allocator),
        failure: Failure = .{},
        err: ?Error = null,
        elapsed_ms: i64 = 0,

        fn run(w: *WarmUp) void {
            const started = w.service.clock();
            w.service.warmUp(w.arena.allocator(), &w.failure) catch |e| {
                w.err = e;
            };
            w.elapsed_ms = w.service.clock() - started;
        }
    };

    /// `Promise.all(Array.from({ length: 5 }, () => pool.connect()))`: open
    /// the warm-up connections concurrently, then release them all.
    fn warmUp(self: *DbService, arena: std.mem.Allocator, failure: *Failure) Error!void {
        const p = try self.pool(.main);
        const Slot = struct {
            conn: ?pq.Conn = null,
            err: ?Error = null,
            failure: Failure = .{},
            arena: std.heap.ArenaAllocator = std.heap.ArenaAllocator.init(std.heap.c_allocator),
            fn run(slot: *@This(), target: *pool_mod.Pool) void {
                slot.conn = target.acquire(slot.arena.allocator(), &slot.failure) catch |e| blk: {
                    slot.err = e;
                    break :blk null;
                };
            }
        };
        var slots: [MIN_POOL_CLIENTS]Slot = @splat(.{});
        defer for (&slots) |*slot| slot.arena.deinit();
        var threads: [MIN_POOL_CLIENTS - 1]?std.Thread = @splat(null);
        for (&threads, slots[1..]) |*t, *slot| t.* = std.Thread.spawn(.{}, Slot.run, .{ slot, p }) catch null;
        Slot.run(&slots[0], p);
        for (threads, slots[1..]) |t, *slot| {
            if (t) |thread| thread.join() else Slot.run(slot, p);
        }
        var first_error: ?Error = null;
        for (&slots) |*slot| {
            if (slot.conn) |c| p.release(c);
            if (slot.err) |e| if (first_error == null) {
                first_error = e;
                failure.message = arena.dupe(u8, slot.failure.message) catch "";
                failure.code = null;
            };
        }
        if (first_error) |e| return e;
    }

    /// `close()`: listeners, live pool, main pool.
    pub fn close(self: *DbService) !void {
        self.stats_mutex.lock();
        self.closing = true;
        self.stats_cond.signal();
        self.stats_mutex.unlock();
        if (self.stats_thread) |t| {
            t.join();
            self.stats_thread = null;
        }
        if (self.stats_timers) |timers| {
            _ = timers.cancel(self.stats_timer);
            self.stats_timers = null;
        }
        self.logHoldTimes();
        // Teardown: abandoned early queries are dropped, not drained.
        self.prefetch.discardAbandoned();
        self.mutex.lock();
        self.ended = true;
        const deadline = self.clock() + close_drain_ms;
        while (self.in_flight > 0) {
            const remaining = deadline - self.clock();
            if (remaining <= 0) break;
            self.in_flight_done.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
        if (self.in_flight > 0) self.leaked = true;
        var listeners = self.listeners;
        self.listeners = .empty;
        var retired = self.retired;
        self.retired = .empty;
        const live = self.live_pool;
        const main = self.main_pool;
        self.live_pool = null;
        self.main_pool = null;
        self.mutex.unlock();
        self.prefetch.stop();
        for (listeners.items) |l| self.stopListener(l);
        for (retired.items) |l| self.stopListener(l);
        listeners.deinit(self.gpa);
        retired.deinit(self.gpa);
        // Pools wait for (bounded) checked-out connections before freeing.
        if (live) |p| p.deinit();
        if (main) |p| p.deinit();
        if (!self.leaked) {
            for (self.idle_hooks.items) |h| self.gpa.destroy(h);
            self.idle_hooks.clearAndFree(self.gpa);
        }
    }

    pub fn metricsSnapshot(self: *DbService) metrics.DatabaseMetricsSnapshot {
        // Pool stats are read under `mutex` so `close` cannot free a pool in
        // between (lock order: service mutex -> pool mutex).
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{
            .listeners = @floatFromInt(self.listeners.items.len),
            .pools = .{ .live = poolMetrics(self.live_pool), .main = poolMetrics(self.main_pool) },
        };
    }

    fn snapshotThunk(ctx: *anyopaque) metrics.DatabaseMetricsSnapshot {
        const self: *DbService = @ptrCast(@alignCast(ctx));
        return self.metricsSnapshot();
    }

    /// For `core.metrics.setDatabaseMetricsProvider`.
    pub fn metricsProvider(self: *DbService) metrics.DatabaseMetricsProvider {
        return .{ .ctx = self, .snapshot = snapshotThunk };
    }

    /// GraphQL workload (`graphql_primary` or `graphql_replica`). Rows are
    /// allocated in `arena`.
    pub fn query(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.main, self.main_role, arena, sql, params, .{}, failure);
    }

    /// `query` for statements whose generic plan is safe to reuse
    /// (`pq.Plan.reusable`): unique-key lookups and fixed SQL.
    pub fn queryReusable(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.main, self.main_role, arena, sql, params, .{ .plan = .reusable }, failure);
    }

    /// Live workload on the primary (`live_primary`).
    pub fn queryLive(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.live, .live_primary, arena, sql, params, .{}, failure);
    }

    /// `listen(channels, handler, onDisconnect)` on DATABASE_URL; stop with
    /// `unlisten`. Callbacks run on the listener thread.
    pub fn listen(self: *DbService, channels: []const []const u8, handler: listener_mod.Handler, arena: std.mem.Allocator, failure: ?*Failure) Error!*listener_mod.Listener {
        self.mutex.lock();
        const ended = self.ended;
        self.mutex.unlock();
        if (ended) return error.PoolClosed;
        const wrapper = try self.gpa.create(ListenWrapper);
        errdefer self.gpa.destroy(wrapper);
        wrapper.* = .{ .service = self, .inner = handler };
        const l = try listener_mod.Listener.start(self.gpa, self.connOptions(self.config.database_url, null), channels, .{
            .ctx = wrapper,
            .on_notification = ListenWrapper.onNotification,
            .on_disconnect = ListenWrapper.onDisconnect,
        }, .{}, arena, failure);
        wrapper.listener = l;
        self.mutex.lock();
        if (self.ended) {
            // close() ran while we were connecting.
            self.mutex.unlock();
            l.stop(); // the errdefer frees the wrapper
            return error.PoolClosed;
        }
        self.listeners.append(self.gpa, l) catch {};
        self.mutex.unlock();
        var joined: std.ArrayList(u8) = .empty;
        defer joined.deinit(self.gpa);
        for (channels, 0..) |c, i| {
            if (i > 0) joined.appendSlice(self.gpa, ", ") catch {};
            joined.appendSlice(self.gpa, c) catch {};
        }
        self.logger.info("listening on {s}", .{joined.items});
        return l;
    }

    /// The function returned by TS `listen`.
    /// Safe after `on_disconnect` (and inside it); a no-op after `close`.
    pub fn unlisten(self: *DbService, l: *listener_mod.Listener) void {
        if (!self.removeListener(l)) return;
        self.stopListener(l);
    }

    fn stopListener(self: *DbService, l: *listener_mod.Listener) void {
        const wrapper: *ListenWrapper = @ptrCast(@alignCast(l.handler.ctx));
        l.stop();
        self.gpa.destroy(wrapper);
    }

    /// Removes `l` from the live or retired list; false if unknown (already
    /// unlistened or closed).
    fn removeListener(self: *DbService, l: *listener_mod.Listener) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.listeners.items, 0..) |x, i| if (x == l) {
            _ = self.listeners.swapRemove(i);
            return true;
        };
        for (self.retired.items, 0..) |x, i| if (x == l) {
            _ = self.retired.swapRemove(i);
            return true;
        };
        return false;
    }

    fn retireListener(self: *DbService, l: *listener_mod.Listener) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.listeners.items, 0..) |x, i| if (x == l) {
            _ = self.listeners.swapRemove(i);
            self.retired.append(self.gpa, l) catch {};
            return;
        };
    }

    const ListenWrapper = struct {
        service: *DbService,
        inner: listener_mod.Handler,
        listener: ?*listener_mod.Listener = null,

        fn onNotification(ctx: *anyopaque, channel: []const u8, payload: []const u8) void {
            const w: *ListenWrapper = @ptrCast(@alignCast(ctx));
            w.inner.on_notification(w.inner.ctx, channel, payload);
        }

        fn onDisconnect(ctx: *anyopaque, message: ?[]const u8) void {
            const w: *ListenWrapper = @ptrCast(@alignCast(ctx));
            // Retire: no longer counted as a listener connection, freed by
            // `unlisten` or `close` (TS live drops `stopListening` on
            // disconnect without calling it). `w` may be freed by `inner`.
            if (w.listener) |l| w.service.retireListener(l);
            w.inner.on_disconnect(w.inner.ctx, message);
        }
    };

    fn connOptions(self: *DbService, conninfo: []const u8, connect_timeout_ms: ?u64) pq.ConnOptions {
        return .{
            .conninfo = conninfo,
            .connect_timeout_ms = connect_timeout_ms,
            .query_timeout_ms = self.config.database_query_timeout_ms,
            .statement_timeout_ms = self.config.database_statement_timeout_ms,
        };
    }

    const PoolKind = enum { main, live };

    fn pool(self: *DbService, kind: PoolKind) Error!*pool_mod.Pool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const slot = if (kind == .main) &self.main_pool else &self.live_pool;
        if (slot.*) |p| return p;
        // No resurrection after close (TS would lazily recreate the pool).
        if (self.ended) return error.PoolClosed;
        const replica = self.config.database_read_replica_url;
        const conninfo = if (kind == .main) replica orelse self.config.database_url else self.config.database_url;
        const timeout: ?u64 = if (kind == .main and replica != null) self.config.database_query_timeout_ms else null;
        const hook = try self.gpa.create(IdleHook);
        hook.* = .{ .service = self, .role = if (kind == .main) self.main_role else .live_primary };
        self.idle_hooks.append(self.gpa, hook) catch {
            self.gpa.destroy(hook);
            return error.OutOfMemory;
        };
        slot.* = pool_mod.Pool.init(self.gpa, .{
            .conn = self.connOptions(conninfo, timeout),
            .max = MAX_POOL_CLIENTS,
            .min = if (kind == .main) MIN_POOL_CLIENTS else 0,
            .idle_timeout_ms = IDLE_TIMEOUT_MS,
            .on_idle_error = .{ .ctx = hook, .func = IdleHook.call },
        }) catch return error.OutOfMemory;
        return slot.*.?;
    }

    const IdleHook = struct {
        service: *DbService,
        role: Role,
        fn call(ctx: *anyopaque, message: []const u8) void {
            const h: *IdleHook = @ptrCast(@alignCast(ctx));
            h.service.logger.err("idle database connection failed role={s}: {s}", .{ h.role.label(), message });
        }
    };

    fn validateEventStreamSchema(self: *DbService, arena: std.mem.Allocator, failure: *Failure) Error!void {
        const rows = try self.queryLive(arena, EVENT_STREAM_SCHEMA_QUERY, &.{}, failure);
        if (rows.len == 0) {
            failure.message = "Missing event stream schema result";
            return error.QueryFailed;
        }
        var invalid: std.ArrayList([]const u8) = .empty;
        for (EVENT_STREAM_SCHEMA_CHECKS) |name| {
            const v = rows[0].get(name);
            if (v == null or v.? != .bool or !v.?.bool) try invalid.append(arena, name);
        }
        if (invalid.items.len == 0) return;
        std.mem.sort([]const u8, invalid.items, {}, struct {
            fn lt(_: void, x: []const u8, y: []const u8) bool {
                return std.mem.order(u8, x, y) == .lt;
            }
        }.lt);
        var msg: std.ArrayList(u8) = .empty;
        try msg.appendSlice(arena, "Event stream schema is not ready: ");
        for (invalid.items, 0..) |name, i| {
            if (i > 0) try msg.appendSlice(arena, ", ");
            try msg.appendSlice(arena, name);
        }
        failure.message = msg.items;
        failure.code = null;
        return error.QueryFailed;
    }

    fn run(self: *DbService, kind: PoolKind, role: Role, arena: std.mem.Allocator, sql: []const u8, params: []const Value, opts: pq.QueryOptions, failure_opt: ?*Failure) Error![]Value {
        const id = self.next_query_id.fetchAdd(1, .monotonic) + 1;
        const started = self.clock();
        var local_failure: Failure = .{};
        const failure = failure_opt orelse &local_failure;
        try self.admit(failure);
        defer self.leave();
        const result = blk: {
            // node-pg would overflow V8's stack formatting these (TS fails
            // before sending; `convert.exceedsJsStack`).
            if (convert.exceedsJsStack(arena, params) catch |e| break :blk e) {
                failure.* = .{ .message = convert.js_stack_message };
                break :blk error.QueryFailed;
            }
            if (self.backend) |b| {
                const conninfo = if (kind == .main) self.config.database_read_replica_url orelse self.config.database_url else self.config.database_url;
                break :blk b.query(b.ctx, if (kind == .main) .main else .live, conninfo, arena, sql, params, failure);
            }
            const p = self.pool(kind) catch |e| break :blk e;
            break :blk p.queryWith(arena, sql, params, opts, failure);
        };
        return self.report(id, role, arena, sql, params, result, self.clock() - started, failure);
    }

    /// Admission: `close` rejects new work and waits for admitted queries.
    fn admit(self: *DbService, failure: *Failure) Error!void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.ended) {
            failure.message = "Cannot use a pool after calling end on the pool";
            return error.PoolClosed;
        }
        self.in_flight += 1;
    }

    fn leave(self: *DbService) void {
        self.mutex.lock();
        self.in_flight -= 1;
        if (self.in_flight == 0) self.in_flight_done.broadcast();
        self.mutex.unlock();
    }

    /// Metrics, stats and the failed/slow query logs for a finished query
    /// (`id` was assigned when the query started, as in TS).
    fn report(self: *DbService, id: u64, role: Role, arena: std.mem.Allocator, sql: []const u8, params: []const Value, result: Error!root.Result, duration: i64, failure: *Failure) Error![]Value {
        const ok = result catch |e| {
            self.record(role, duration, 0, true);
            const message = if (failure.message.len > 0) failure.message else @errorName(e);
            self.logger.warn("query failed id={d} role={s} durationMs={d} error={s} {f}", .{ id, role.label(), duration, message, QueryDetails{ .arena = arena, .sql = sql, .params = params } });
            return e;
        };
        self.record(role, duration, ok.row_count, false);
        if (duration >= @as(i64, @intCast(self.config.database_slow_query_ms))) {
            self.logger.warn("slow query id={d} role={s} durationMs={d} rows={d} {f}", .{ id, role.label(), duration, ok.row_count, QueryDetails{ .arena = arena, .sql = sql, .params = params } });
        }
        return ok.rows;
    }

    /// A live-pool query sent ahead of its read point (`beginLive`). Its
    /// reply is read by the service's prefetch reader as it arrives, so the
    /// connection goes back to the pool at once whatever the caller does.
    /// Call exactly one of `finish` or `cancel` (both free it; `close` waits).
    /// Only `finish` counts: metrics, stats and logs see the query exactly
    /// like `queryLive`, timed from the send to the reply's arrival (stamped
    /// by the reader when it reads the completing bytes: an upper bound by
    /// its wake-up latency, since it reacts to socket readiness); a
    /// cancelled one is as if never issued.
    /// Test-only (see `Prefetcher`).
    pub fn failPrefetchAllocForTest(on: bool) void {
        Prefetcher.fail_alloc_for_test = on;
    }

    pub const PendingQuery = struct {
        service: *DbService,
        /// Null when nothing was sent early (no idle connection, pool closed,
        /// send error, test backend): `finish` runs `queryLive` then.
        pending: ?pool_mod.Pool.Pending,
        /// Caller-owned until `finish`/`cancel` (rows are converted there).
        arena: std.mem.Allocator,
        sql: []const u8,
        params: []const Value,
        /// `pq.nowMs` when sent (the reply's arrival is timed against it).
        sent_ms: i64 = 0,
        /// Prefetcher state, under `Prefetcher.mutex`.
        registered: bool = false,
        busy: bool = false,
        abandoned: bool = false,
        discard: bool = false,
        /// The reader ran out of memory and gave it up: `finish` reruns it.
        oom: bool = false,

        /// Kept for callers that poll between writes; the prefetch reader
        /// already reads replies as they arrive.
        pub fn poll(_: *PendingQuery) void {}

        /// When the complete reply arrived (`pq.nowMs`), or null if not yet
        /// (or nothing was sent early).
        pub fn arrivedMs(self: *PendingQuery) ?i64 {
            const pf = &self.service.prefetch;
            pf.mutex.lock();
            defer pf.mutex.unlock();
            pf.waitIdle(self);
            const p = self.pending orelse return null;
            return if (p.arrived_ms != 0) p.arrived_ms else null;
        }

        /// The early read failed in a way TS would not have seen at its read
        /// point (`finish` reruns it; a caller may also `cancel` and re-query).
        pub fn failedEarly(self: *PendingQuery) bool {
            const pf = &self.service.prefetch;
            pf.mutex.lock();
            defer pf.mutex.unlock();
            pf.waitIdle(self);
            return self.failedEarlyLocked();
        }

        fn failedEarlyLocked(self: *const PendingQuery) bool {
            if (self.oom) return true;
            const p = self.pending orelse return false;
            if (p.arrived_ms == 0) return false;
            if (p.failed) |e| return e == error.ConnectionFailed or e == error.QueryTimeout;
            const code = p.errorCode() orelse return false;
            return std.mem.eql(u8, code, "57014");
        }

        fn rerunnable(e: Error, failure: Failure) bool {
            const statement_timeout = e == error.QueryFailed and failure.code != null and std.mem.eql(u8, failure.code.?, "57014");
            return e == error.ConnectionFailed or e == error.QueryTimeout or statement_timeout;
        }

        pub fn finish(self: *PendingQuery, failure_opt: ?*Failure) Error![]Value {
            const s = self.service;
            const arena = self.arena;
            const sql = self.sql;
            const params = self.params;
            var local_failure: Failure = .{};
            const failure = failure_opt orelse &local_failure;
            if (self.pending == null) {
                s.gpa.destroy(self);
                return s.queryLive(arena, sql, params, failure);
            }
            const early_failed = s.prefetch.detach(self);
            var p = self.pending.?;
            const sent_ms = self.sent_ms;
            s.gpa.destroy(self);
            defer s.leave();
            // A failure TS would not have seen at this, its read point
            // (connection lost, client or statement timeout while the reply
            // waited): run the query now; the early attempt counts nowhere.
            if (early_failed) {
                p.cancel();
                return s.run(.live, .live_primary, arena, sql, params, .{}, failure);
            }
            // TS assigns the id when it issues the query: here.
            const id = s.next_query_id.fetchAdd(1, .monotonic) + 1;
            const result = p.finish(arena, failure);
            if (result) |_| {} else |e| {
                if (rerunnable(e, failure.*)) {
                    failure.* = .{};
                    return s.run(.live, .live_primary, arena, sql, params, .{}, failure);
                }
            }
            return s.report(id, .live_primary, arena, sql, params, result, p.arrived_ms - sent_ms, failure);
        }

        /// Gives it up. A reply still on its way is drained by the prefetch
        /// reader and the connection goes back to the pool (no reconnect).
        pub fn cancel(self: *PendingQuery) void {
            const s = self.service;
            if (self.pending == null) {
                s.gpa.destroy(self);
                return;
            }
            if (s.prefetch.abandon(self)) return; // the reader frees it
            self.pending.?.cancel();
            s.gpa.destroy(self);
            s.leave();
        }
    };

    /// `queryLive`, split: sends now on a live-pool connection that is idle
    /// right now (never opens, queues or overtakes a waiter) and reads it in
    /// the background (see `PendingQuery`). With nothing idle nothing is sent
    /// early. Returns null only when out of memory (then just query later).
    pub fn beginLive(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value) ?*PendingQuery {
        const early = self.gpa.create(PendingQuery) catch return null;
        early.* = .{ .service = self, .pending = null, .arena = arena, .sql = sql, .params = params };
        if (self.backend != null) return early;
        // Parameters TS could not even format fail at the read point instead.
        if (convert.exceedsJsStack(arena, params) catch true) return early;
        var failure: Failure = .{};
        self.admit(&failure) catch return early;
        const p = self.pool(.live) catch {
            self.leave();
            return early;
        };
        const sent_ms = pq.nowMs();
        early.pending = p.begin(arena, sql, params, &failure) catch |e| blk: {
            self.logger.warn("early query send failed role=live_primary error={s}; it runs at its read point", .{if (failure.message.len > 0) failure.message else @errorName(e)});
            break :blk null;
        };
        if (early.pending == null) {
            self.leave();
            return early;
        }
        early.sent_ms = sent_ms;
        self.prefetch.register(self, early);
        return early;
    }

    /// The prefetch reader: one thread that polls the sockets of early
    /// queries and reads each reply as it arrives, so its connection returns
    /// to the pool without waiting for the caller, and drains abandoned ones
    /// (closing them only at their query timeout or at `close`). It starts on
    /// first use and exits after `idle_exit_ms` with nothing in flight, so it
    /// adds no idle thread. (With fiber loops this becomes the loop's
    /// `waitFd` on the prefetch socket instead of a thread.)
    const Prefetcher = struct {
        mutex: std.Thread.Mutex = .{},
        /// Broadcast when an entry stops being `busy`.
        idle: std.Thread.Condition = .{},
        entries: std.ArrayList(*PendingQuery) = .empty,
        pipe: ?[2]std.posix.fd_t = null,
        thread: ?std.Thread = null,
        stopping: bool = false,
        service: ?*DbService = null,

        const idle_exit_ms = 1_000;
        /// Test-only: the reader's allocations fail.
        var fail_alloc_for_test: bool = false;

        fn register(self: *Prefetcher, service: *DbService, q: *PendingQuery) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.service = service;
            if (self.thread == null) self.start() catch {
                // No reader: the caller's `finish` reads it as before.
                return;
            };
            self.entries.append(service.gpa, q) catch return;
            q.registered = true;
            self.wake();
        }

        /// Mutex held.
        fn start(self: *Prefetcher) !void {
            if (self.pipe == null) self.pipe = try std.posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true });
            self.thread = try std.Thread.spawn(.{}, readLoop, .{self});
        }

        fn wake(self: *Prefetcher) void {
            if (self.pipe) |p| _ = std.posix.write(p[1], "x") catch {};
        }

        /// Mutex held.
        fn waitIdle(self: *Prefetcher, q: *PendingQuery) void {
            while (q.busy) self.idle.wait(&self.mutex);
        }

        /// Mutex held.
        fn unregister(self: *Prefetcher, q: *PendingQuery) void {
            if (!q.registered) return;
            q.registered = false;
            for (self.entries.items, 0..) |e, i| if (e == q) {
                _ = self.entries.swapRemove(i);
                return;
            };
        }

        /// `finish`: take it back from the reader. True when the early read
        /// already failed in a way TS would not have seen.
        fn detach(self: *Prefetcher, q: *PendingQuery) bool {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.waitIdle(q);
            self.unregister(q);
            return q.failedEarlyLocked();
        }

        /// `cancel`: true when the reader keeps it (reply still coming) and
        /// will drain and free it.
        fn abandon(self: *Prefetcher, q: *PendingQuery) bool {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.waitIdle(q);
            if (!q.registered) return false;
            q.abandoned = true;
            self.wake();
            return true;
        }

        /// Out of memory in the reader (mutex held): give every prefetch up.
        /// Callers' ones rerun at their read point (`oom`); abandoned ones
        /// are closed now. Nothing waits and nothing leaks.
        fn giveUpAll(self: *Prefetcher, s: *DbService) void {
            while (self.entries.pop()) |q| {
                q.registered = false;
                q.oom = true;
                if (!q.abandoned) continue;
                q.pending.?.cancel();
                s.gpa.destroy(q);
                s.leave();
            }
        }

        fn discardAbandoned(self: *Prefetcher) void {
            self.mutex.lock();
            defer self.mutex.unlock();
            for (self.entries.items) |q| if (q.abandoned) {
                q.discard = true;
            };
            self.wake();
        }

        fn stop(self: *Prefetcher) void {
            self.mutex.lock();
            self.stopping = true;
            self.wake();
            const thread = self.thread;
            self.thread = null;
            self.mutex.unlock();
            if (thread) |t| t.join();
            if (self.pipe) |p| {
                std.posix.close(p[0]);
                std.posix.close(p[1]);
                self.pipe = null;
            }
            if (self.service) |s| self.entries.deinit(s.gpa);
            self.entries = .empty;
        }

        fn readLoop(self: *Prefetcher) void {
            // Own allocator: after an idle exit the thread is detached and
            // must not touch the service while unwinding.
            const ga = std.heap.c_allocator;
            var fds: std.ArrayList(std.posix.pollfd) = .empty;
            var owners: std.ArrayList(*PendingQuery) = .empty;
            defer {
                fds.deinit(ga);
                owners.deinit(ga);
            }
            var idle_since: ?i64 = null;
            while (true) {
                self.mutex.lock();
                // At `close` (after in-flight queries drained) anything still
                // registered belongs to a caller, who finishes it directly.
                if (self.stopping) {
                    self.mutex.unlock();
                    return;
                }
                // Nothing in flight for a while: exit (`register` restarts it).
                if (self.entries.items.len == 0) {
                    const now_idle = pq.nowMs();
                    const since = idle_since orelse now_idle;
                    idle_since = since;
                    if (now_idle - since >= idle_exit_ms) {
                        if (self.thread) |t| t.detach();
                        self.thread = null;
                        self.mutex.unlock();
                        return;
                    }
                } else idle_since = null;
                const s = self.service.?;
                fds.clearRetainingCapacity();
                owners.clearRetainingCapacity();
                const want = self.entries.items.len + 1;
                if (if (fail_alloc_for_test) error.OutOfMemory else fds.ensureTotalCapacity(ga, want)) |_| {} else |_| {
                    self.giveUpAll(s);
                    self.mutex.unlock();
                    continue;
                }
                if (owners.ensureTotalCapacity(ga, want)) |_| {} else |_| {
                    self.giveUpAll(s);
                    self.mutex.unlock();
                    continue;
                }
                fds.appendAssumeCapacity(.{ .fd = self.pipe.?[0], .events = std.posix.POLL.IN, .revents = 0 });
                var timeout: i32 = if (self.entries.items.len == 0) idle_exit_ms else -1;
                const now = pq.nowMs();
                // Client query timeout (0 = none): an abandoned query still
                // drains until its reply or `close`.
                const limit: i64 = @intCast(s.config.database_query_timeout_ms);
                for (self.entries.items) |q| {
                    const fd = q.pending.?.socket() orelse continue;
                    const events: i16 = if (q.pending.?.wantsWrite()) std.posix.POLL.IN | std.posix.POLL.OUT else std.posix.POLL.IN;
                    fds.appendAssumeCapacity(.{ .fd = fd, .events = events, .revents = 0 });
                    owners.appendAssumeCapacity(q);
                    if (q.discard) timeout = 0;
                    // TLS without the exact check: re-poll every 50 ms.
                    if (q.pending.?.tlsBlind()) timeout = if (timeout < 0) 50 else @min(timeout, 50);
                    if (q.abandoned and limit > 0) {
                        const left: i32 = @intCast(@max(0, @min(q.sent_ms + limit - now, std.math.maxInt(i32))));
                        timeout = if (timeout < 0) left else @min(timeout, left);
                    }
                }
                self.mutex.unlock();
                _ = std.posix.poll(fds.items, timeout) catch 0;
                if (fds.items[0].revents != 0) {
                    var buf: [64]u8 = undefined;
                    while ((std.posix.read(fds.items[0].fd, &buf) catch 0) > 0) {}
                }
                const after = pq.nowMs();
                for (owners.items, fds.items[1..]) |q, fd| {
                    self.mutex.lock();
                    if (!q.registered) {
                        self.mutex.unlock();
                        continue;
                    }
                    const expired = q.abandoned and (q.discard or (limit > 0 and after >= q.sent_ms + limit));
                    if (fd.revents == 0 and !expired and !q.pending.?.tlsBlind()) {
                        self.mutex.unlock();
                        continue;
                    }
                    q.busy = true;
                    self.mutex.unlock();
                    var settled: bool = undefined;
                    if (expired) {
                        q.pending.?.cancel();
                        settled = true;
                    } else settled = q.pending.?.poll();
                    self.mutex.lock();
                    q.busy = false;
                    self.idle.broadcast();
                    const free = settled and q.abandoned;
                    if (settled and q.abandoned) self.unregister(q);
                    if (settled and !q.abandoned) self.unregister(q);
                    self.mutex.unlock();
                    if (free) {
                        q.pending.?.cancel(); // frees the stored reply
                        s.gpa.destroy(q);
                        s.leave();
                    }
                }
            }
        }
    };

    fn record(self: *DbService, role: Role, duration: i64, rows: usize, failed: bool) void {
        self.stats_mutex.lock();
        self.stats.queries += 1;
        self.stats.rows += rows;
        self.stats.total_ms += duration;
        self.stats.max_ms = @max(self.stats.max_ms, duration);
        if (failed) self.stats.errors += 1;
        self.stats_mutex.unlock();
        const outcome = if (failed) "error" else "success";
        metrics.database_queries.inc(.{ outcome, role.label() }, 1);
        metrics.database_query_duration.observe(.{ outcome, role.label() }, @as(f64, @floatFromInt(duration)) / 1_000);
        metrics.database_rows.inc(.{role.label()}, @floatFromInt(rows));
    }

    fn statsTick(ctx: *anyopaque, _: u64) void {
        const self: *DbService = @ptrCast(@alignCast(ctx));
        self.stats_mutex.lock();
        const s = self.stats;
        self.stats = .{};
        self.stats_mutex.unlock();
        self.logStats(s);
    }

    /// Fallback without a process scheduler (tests).
    fn statsLoop(self: *DbService) void {
        self.stats_mutex.lock();
        defer self.stats_mutex.unlock();
        var next = self.clock() + STATS_INTERVAL_MS;
        while (!self.closing) {
            const remaining = next - self.clock();
            if (remaining > 0) {
                self.stats_cond.timedWait(&self.stats_mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
                continue;
            }
            next += STATS_INTERVAL_MS;
            const s = self.stats;
            self.stats = .{};
            self.stats_mutex.unlock();
            self.logStats(s);
            self.stats_mutex.lock();
        }
    }

    fn logStats(self: *DbService, s: Stats) void {
        self.mutex.lock();
        const ps: pool_mod.Stats = if (self.main_pool) |p| p.stats() else .{ .total = 0, .idle = 0, .waiting = 0 };
        self.mutex.unlock();
        const avg: i64 = if (s.queries > 0) jsRound(@as(f64, @floatFromInt(s.total_ms)) / @as(f64, @floatFromInt(s.queries))) else 0;
        self.logger.info("db stats queries={d} errors={d} rows={d} avgMs={d} maxMs={d} poolTotal={d} poolIdle={d} poolWaiting={d}", .{ s.queries, s.errors, s.rows, avg, s.max_ms, ps.total, ps.idle, ps.waiting });
        self.logHoldTimes();
    }

    /// `-Dpool-hold-stats=true` builds: cumulative checkout hold times per
    /// pool, at info (every stats interval and at close).
    fn logHoldTimes(self: *DbService) void {
        if (!pool_mod.hold_stats) return;
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.main_pool) |p| self.logger.info("db pool hold pool=main {f}", .{&p.hold});
        if (self.live_pool) |p| self.logger.info("db pool hold pool=live {f}", .{&p.hold});
    }
};

/// JS `Math.round`.
pub fn jsRound(x: f64) i64 {
    return @intFromFloat(@floor(x + 0.5));
}

fn poolMetrics(p: ?*pool_mod.Pool) metrics.PoolMetrics {
    const s: pool_mod.Stats = if (p) |x| x.stats() else .{ .total = 0, .idle = 0, .waiting = 0 };
    return .{ .idle = @floatFromInt(s.idle), .limit = MAX_POOL_CLIENTS, .total = @floatFromInt(s.total), .waiting = @floatFromInt(s.waiting) };
}

/// `queryDetails(text, values)`: `sql=<whitespace-collapsed> values=<json>`.
const QueryDetails = struct {
    arena: std.mem.Allocator,
    sql: []const u8,
    params: []const Value,

    pub fn format(self: QueryDetails, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.writeAll("sql=");
        const trimmed = std.mem.trim(u8, self.sql, " \t\n\r\x0b\x0c");
        var in_space = false;
        for (trimmed) |c| {
            if (std.ascii.isWhitespace(c)) {
                if (!in_space) try w.writeByte(' ');
                in_space = true;
            } else {
                in_space = false;
                try w.writeByte(c);
            }
        }
        try w.writeAll(" values=");
        const items = self.arena.dupe(Value, self.params) catch return error.WriteFailed;
        const logged = convert.logValue(self.arena, .{ .array = items }) catch return error.WriteFailed;
        try core.json.stringify(w, logged);
    }
};
