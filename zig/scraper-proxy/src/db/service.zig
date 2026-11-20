//! `DbService` from `src/db/db.service.ts`.
const std = @import("std");
const core = @import("core");
const root = @import("root.zig");
const pq = @import("pq.zig");
const pool_mod = @import("pool.zig");
const listener_mod = @import("listener.zig");
const convert = @import("convert.zig");
const admission_shape_ms = @import("db_options").admission_shape_ms;

const Value = core.json.Value;
const Failure = root.Failure;
const Error = root.Error;
const metrics = core.metrics;
const Role = metrics.DatabaseQueryRole;

pub const MIN_POOL_CLIENTS = 5;
pub const MAX_POOL_CLIENTS = 10;
/// The validator WebSocket's pool (#10061): bounded apart from the live pool.
pub const MAX_VALIDATOR_POOL_CLIENTS = 5;
pub const STATS_INTERVAL_MS = 60_000;
pub const IDLE_TIMEOUT_MS = 300_000;
/// pg-pool's idle listener reports a server-closed idle connection at once;
/// the pools look at idle connections this often (`Pool.Options.idle_check_ms`).
pub const IDLE_CHECK_MS = 1_000;

pub const EVENT_STREAM_SCHEMA_CHECKS = [_][]const u8{
    "scraper_head_exists",
    "scraper_head_readable",
};

pub const EVENT_STREAM_SCHEMA_QUERY =
    \\
    \\  SELECT to_regclass('scraper_head') IS NOT NULL AS scraper_head_exists,
    \\    COALESCE(has_table_privilege(current_user, to_regclass('scraper_head'), 'SELECT'), false) AS scraper_head_readable
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

/// TS #10076 `query`'s assert message at DATABASE_MAX_PENDING_GRAPHQL_QUERIES.
pub const pending_capacity_message = "GraphQL database query capacity exceeded";

/// TS #10076's pending GraphQL query slot carried across statements that TS
/// issues in one microtask chain (scraperdb `historyQuery`: the EXPLAIN,
/// then its statement). There, one statement's `finally
/// pendingMainQueries--` and the next one's capacity assert and `++` run
/// with no other request's code in between (each pg result is its own
/// macrotask), so the next statement's check always passes and no other
/// query can take the slot in between. A main-pool statement run with a
/// chain takes the slot the previous one kept instead of checking the cap,
/// and keeps its own when it succeeds; a failed statement gives its slot
/// back, as its `finally` did. The owner calls `release` once the chain
/// ends (on every path): it gives back a slot no statement took. Used by
/// one thread or fiber at a time.
pub const PendingChain = struct {
    kept: ?*DbService = null,

    pub fn release(self: *PendingChain) void {
        const service = self.kept orelse return;
        self.kept = null;
        service.leavePendingMain();
    }

    fn take(self: *PendingChain, service: *DbService) bool {
        const kept = self.kept orelse return false;
        std.debug.assert(kept == service);
        self.kept = null;
        return true;
    }
};

pub const DbService = struct {
    gpa: std.mem.Allocator,
    logger: core.log.Logger,
    config: core.config.Config,
    main_role: Role,
    mutex: std.Thread.Mutex = .{},
    main_pool: ?*pool_mod.Pool = null,
    live_pool: ?*pool_mod.Pool = null,
    validator_pool: ?*pool_mod.Pool = null,
    /// This service's running listener threads (`close` waits for them).
    listener_threads: listener_mod.ThreadCount = .init(0),
    /// How long `close` waits for them (test seam).
    listener_wait_ms: u64 = close_listener_wait_ms,
    /// A listener thread outlived `close`'s wait: it still decrements
    /// `listener_threads`, so `deinit` leaves this struct allocated.
    outlived: bool = false,
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
    /// GraphQL (main-pool) statements queued for a connection or running,
    /// including those whose client disconnected (TS #10076
    /// `pendingMainQueries`; capped by DATABASE_MAX_PENDING_GRAPHQL_QUERIES).
    pending_main: usize = 0,
    /// `admitShape` waiters, oldest first.
    shape_waiters: std.ArrayList(*ShapeWaiter) = .empty,
    in_flight_done: std.Thread.Condition = .{},
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
        self.shape_waiters.deinit(self.gpa);
        // In-flight queries outlived the drain, or a listener thread outlived
        // close: they still reference us.
        if (self.leaked or self.outlived) return;
        self.gpa.destroy(self);
    }

    /// Bound for `close` to wait for in-flight queries (node-pg `pool.end()`
    /// waits for checked-out clients; ours is bounded so shutdown finishes).
    pub const close_drain_ms = 30_000;
    /// Bound for `close` to wait for listener threads that are finishing.
    pub const close_listener_wait_ms = 5_000;

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

    /// `close()`: listeners, live pool, validator pool, main pool.
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
        const validator = self.validator_pool;
        const main = self.main_pool;
        self.live_pool = null;
        self.validator_pool = null;
        self.main_pool = null;
        self.mutex.unlock();
        for (listeners.items) |l| self.stopListener(l);
        for (retired.items) |l| self.stopListener(l);
        listeners.deinit(self.gpa);
        retired.deinit(self.gpa);
        // Listeners a callback stopped free themselves on their own thread
        // once the callback returns; let them finish before we go away.
        if (!listener_mod.awaitThreads(&self.listener_threads, self.listener_wait_ms)) {
            // Should never happen. The late threads still decrement our
            // counter, so this struct is left allocated (`deinit`).
            self.logger.warn("{d} listener threads still running after {d} ms at close", .{ self.listener_threads.load(.acquire), self.listener_wait_ms });
            self.outlived = true;
        }
        // Pools wait for (bounded) checked-out connections before freeing.
        if (live) |p| p.deinit();
        if (validator) |p| p.deinit();
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
            .pools = .{
                .live = poolMetrics(self.live_pool, MAX_POOL_CLIENTS),
                .main = poolMetrics(self.main_pool, MAX_POOL_CLIENTS),
                .validator = poolMetrics(self.validator_pool, MAX_VALIDATOR_POOL_CLIENTS),
            },
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

    /// `query` for selects planned with the view's join order fixed
    /// (`pq.Plan.fixed_join`): same SQL, rows and errors.
    pub fn queryFixedJoin(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.main, self.main_role, arena, sql, params, .{ .plan = .fixed_join }, failure);
    }

    /// `query` planned without parallel workers (`pq.Plan.serial`): same
    /// SQL, rows and errors.
    pub fn querySerial(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.main, self.main_role, arena, sql, params, .{ .plan = .serial }, failure);
    }

    /// `query` as a named statement with a reused generic plan, built
    /// without parallel workers (`pq.Plan.serial_generic`): same SQL, rows
    /// and errors.
    pub fn querySerialGeneric(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.main, self.main_role, arena, sql, params, .{ .plan = .serial_generic }, failure);
    }

    /// `query` as a named statement that always uses its generic plan
    /// (`pq.Plan.generic`): same SQL, rows and errors.
    pub fn queryGeneric(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.main, self.main_role, arena, sql, params, .{ .plan = .generic }, failure);
    }

    /// The validator WebSocket's reads on the primary (`validator_primary`;
    /// own pool of `MAX_VALIDATOR_POOL_CLIENTS`, queued checkouts time out
    /// after DATABASE_QUERY_TIMEOUT_MS like TS's connectionTimeoutMillis).
    pub fn queryValidator(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.validator, .validator_primary, arena, sql, params, .{}, failure);
    }

    /// TS `query`'s capacity check (and `++`) alone, for a statement then
    /// run in `chain`, which takes the slot: lets the caller do work that
    /// TS does after the check before the statement starts (the GraphQL
    /// route's execution admission). A no-op when `chain` already holds a
    /// slot. The caller releases `chain` on every path.
    pub fn reserveMain(self: *DbService, chain: *PendingChain, failure: *Failure) Error!void {
        if (chain.kept != null) return;
        try self.enterPendingMain(failure);
        chain.kept = self;
    }

    /// `query` planned as `plan`, in `chain` when not null (`PendingChain`).
    pub fn queryChained(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, plan: pq.Plan, chain: ?*PendingChain, failure: ?*Failure) Error![]Value {
        return (try self.runResult(.main, self.main_role, arena, sql, params, .{ .plan = plan }, chain, failure)).rows;
    }

    /// Live workload on the primary (`live_primary`).
    pub fn queryLive(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, failure: ?*Failure) Error![]Value {
        return self.run(.live, .live_primary, arena, sql, params, .{}, failure);
    }

    /// `listen(channels, handler, onDisconnect)` on DATABASE_URL; stop with
    /// `unlisten`. Callbacks run on the listener thread.
    pub fn listen(self: *DbService, channels: []const []const u8, handler: listener_mod.Handler, arena: std.mem.Allocator, failure: ?*Failure) Error!*listener_mod.Listener {
        const l = try self.listenUnlogged(channels, handler, arena, failure);
        self.logListening(channels);
        return l;
    }

    /// `listen` without its "listening on" line, for a listener connected
    /// ahead of the point where TS calls `listen` (live's early LISTEN): the
    /// caller logs it there with `logListening`.
    pub fn listenUnlogged(self: *DbService, channels: []const []const u8, handler: listener_mod.Handler, arena: std.mem.Allocator, failure: ?*Failure) Error!*listener_mod.Listener {
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
        }, .{ .threads = &self.listener_threads }, arena, failure);
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
        return l;
    }

    /// TS `listen`'s "listening on <channels>" line.
    pub fn logListening(self: *DbService, channels: []const []const u8) void {
        var joined: std.ArrayList(u8) = .empty;
        defer joined.deinit(self.gpa);
        for (channels, 0..) |c, i| {
            if (i > 0) joined.appendSlice(self.gpa, ", ") catch {};
            joined.appendSlice(self.gpa, c) catch {};
        }
        self.logger.info("listening on {s}", .{joined.items});
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

    const PoolKind = enum { main, live, validator };

    fn pool(self: *DbService, kind: PoolKind) Error!*pool_mod.Pool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const slot = switch (kind) {
            .main => &self.main_pool,
            .live => &self.live_pool,
            .validator => &self.validator_pool,
        };
        if (slot.*) |p| return p;
        // No resurrection after close (TS would lazily recreate the pool).
        if (self.ended) return error.PoolClosed;
        const replica = self.config.database_read_replica_url;
        const conninfo = if (kind == .main) replica orelse self.config.database_url else self.config.database_url;
        const timeout: ?u64 = switch (kind) {
            .main => if (replica != null) self.config.database_query_timeout_ms else null,
            .live => null,
            .validator => self.config.database_query_timeout_ms,
        };
        const hook = try self.gpa.create(IdleHook);
        hook.* = .{ .service = self, .role = switch (kind) {
            .main => self.main_role,
            .live => .live_primary,
            .validator => .validator_primary,
        } };
        self.idle_hooks.append(self.gpa, hook) catch {
            self.gpa.destroy(hook);
            return error.OutOfMemory;
        };
        slot.* = pool_mod.Pool.init(self.gpa, .{
            .conn = self.connOptions(conninfo, timeout),
            .max = if (kind == .validator) MAX_VALIDATOR_POOL_CLIENTS else MAX_POOL_CLIENTS,
            .min = if (kind == .main) MIN_POOL_CLIENTS else 0,
            .idle_timeout_ms = IDLE_TIMEOUT_MS,
            .idle_check_ms = IDLE_CHECK_MS,
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

    /// TS #10076 `query`'s capacity assert: at most
    /// DATABASE_MAX_PENDING_GRAPHQL_QUERIES GraphQL statements queued or
    /// running at once.
    fn enterPendingMain(self: *DbService, failure: *Failure) Error!void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.pending_main >= self.config.database_max_pending_graphql_queries) {
            failure.* = .{ .message = pending_capacity_message };
            return error.QueryFailed;
        }
        self.pending_main += 1;
    }

    fn leavePendingMain(self: *DbService) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.pending_main -= 1;
        if (comptime admission_shape_ms != 0) self.wakeShaped();
    }

    pub const ShapeWaiter = struct { need: usize, w: core.fiber.Waiter = .{} };

    /// A request about to run `roots` root fields waits, at most
    /// `-Dadmission-shape-ms` (default 2), while some but fewer than `roots`
    /// pending slots are free (or older requests wait), oldest first. Under a
    /// full cap this keeps slots from being split across requests, each then
    /// answering with capacity errors. Each root is still checked on its own
    /// once the wait ends, as TS checks them when its loop reaches the
    /// request (DEVIATIONS.md).
    pub fn admitShape(self: *DbService, roots: usize) void {
        if (comptime admission_shape_ms == 0) return;
        // More roots than the cap can never all be admitted: wait for a full cap.
        const need = @min(roots, self.config.database_max_pending_graphql_queries);
        if (need < 2) return;
        var waiter: ShapeWaiter = .{ .need = need };
        {
            self.mutex.lock();
            defer self.mutex.unlock();
            const free = self.config.database_max_pending_graphql_queries -| self.pending_main;
            if (free == 0) return;
            if (free >= need and self.shape_waiters.items.len == 0) return;
            self.shape_waiters.append(self.gpa, &waiter) catch return;
        }
        if (waiter.w.waitTimeout(core.fiber.monoMs() + admission_shape_ms)) return;
        // Timed out: the waker wakes under `mutex`, so once we hold it no
        // wake can still touch `waiter`.
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.shape_waiters.items, 0..) |x, i| if (x == &waiter) {
            _ = self.shape_waiters.orderedRemove(i);
            break;
        };
    }

    /// Under `mutex`: wakes the oldest shaped request once its slots are free.
    fn wakeShaped(self: *DbService) void {
        if (self.shape_waiters.items.len == 0) return;
        const head = self.shape_waiters.items[0];
        if (self.config.database_max_pending_graphql_queries -| self.pending_main < head.need) return;
        _ = self.shape_waiters.orderedRemove(0);
        head.w.wake();
    }

    fn run(self: *DbService, kind: PoolKind, role: Role, arena: std.mem.Allocator, sql: []const u8, params: []const Value, opts: pq.QueryOptions, failure_opt: ?*Failure) Error![]Value {
        return (try self.runResult(kind, role, arena, sql, params, opts, null, failure_opt)).rows;
    }

    /// `query`/`queryReusable` (`plan`) returning libpq's result unconverted
    /// (`pq.LazyRows`; same pool, timeouts, errors, logs and metrics). The
    /// caller owns it and must `deinit` it; its pending slot is given back
    /// (or kept in `chain`) when this returns. Null with a test `backend`
    /// (before any check: `chain` is left as it was).
    pub fn queryLazy(self: *DbService, arena: std.mem.Allocator, sql: []const u8, params: []const Value, plan: pq.Plan, chain: ?*PendingChain, failure: ?*Failure) Error!?*pq.LazyRows {
        if (self.backend != null) return null;
        const result = try self.runResult(.main, self.main_role, arena, sql, params, .{ .plan = plan, .lazy = true }, chain, failure);
        return result.lazy;
    }

    fn runResult(self: *DbService, kind: PoolKind, role: Role, arena: std.mem.Allocator, sql: []const u8, params: []const Value, opts: pq.QueryOptions, chain: ?*PendingChain, failure_opt: ?*Failure) Error!root.Result {
        std.debug.assert(chain == null or kind == .main);
        var local_failure: Failure = .{};
        const failure = failure_opt orelse &local_failure;
        // TS `query`: the cap is asserted before the query gets an id, a
        // metric or a log line; in a chain, the slot its previous statement
        // kept is this one's (`PendingChain`).
        const inherited = if (chain) |c| c.take(self) else false;
        if (kind == .main and !inherited) try self.enterPendingMain(failure);
        var keep = false;
        defer if (kind == .main and !keep) self.leavePendingMain();
        const id = self.next_query_id.fetchAdd(1, .monotonic) + 1;
        const started = self.clock();
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
        const reported = self.report(id, role, arena, sql, params, result, self.clock() - started, failure);
        if (chain) |c| if (reported) |_| {
            c.kept = self;
            keep = true;
        } else |_| {};
        return reported;
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
    fn report(self: *DbService, id: u64, role: Role, arena: std.mem.Allocator, sql: []const u8, params: []const Value, result: Error!root.Result, duration: i64, failure: *Failure) Error!root.Result {
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
        return ok;
    }

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
        if (self.validator_pool) |p| self.logger.info("db pool hold pool=validator {f}", .{&p.hold});
    }
};

/// JS `Math.round`.
pub fn jsRound(x: f64) i64 {
    return @intFromFloat(@floor(x + 0.5));
}

fn poolMetrics(p: ?*pool_mod.Pool, limit: u32) metrics.PoolMetrics {
    const s: pool_mod.Stats = if (p) |x| x.stats() else .{ .total = 0, .idle = 0, .waiting = 0 };
    return .{ .idle = @floatFromInt(s.idle), .limit = @floatFromInt(limit), .total = @floatFromInt(s.total), .waiting = @floatFromInt(s.waiting) };
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
