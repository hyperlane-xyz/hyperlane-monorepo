//! TS #10076's pending GraphQL query cap across a history read's statements
//! (`db.PendingChain`), through the App adapters: TS runs one statement's
//! `finally pendingMainQueries--` and the next one's capacity check in one
//! microtask chain (an EXPLAIN and its statement; a confirmation snapshot
//! and its projection), so another request's query arriving in between
//! cannot take the slot.
const std = @import("std");
const core = @import("core");
const db = @import("db");
const scraperdb = @import("scraperdb");
const parser = @import("parser.zig");
const schema_mod = @import("schema.zig");
const values = @import("values.zig");
const execute = @import("execute.zig");
const resolvers = @import("resolvers.zig");
const root_pool = @import("root_pool.zig");
const route = @import("route.zig");
const App = @import("app.zig").App;

const testing = std.testing;
const Allocator = std.mem.Allocator;
const Value = core.json.Value;

const capacity_message = "GraphQL database query capacity exceeded";
const snapshot_prefix = "WITH custom_frontier AS (";
const projection_prefix = "WITH custom_frontier(domain, height)";
const explain_prefix = "EXPLAIN (FORMAT JSON) ";

/// Test backend: EXPLAINs answer a plan costing `cost`; "SELECT held"
/// waits for `released`; the confirmation snapshot answers `snapshot`;
/// other statements no rows. `fail_explain` /
/// `fail_statement` fail the EXPLAIN of / the statement starting with that
/// text ("" for any) with "boom".
const Fake = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    cost: []const u8 = "1",
    snapshot: []const u8 = "{\"domains\":[],\"heights\":[],\"message_ids\":[]}",
    fail_explain: ?[]const u8 = null,
    fail_statement: ?[]const u8 = null,
    released: bool = false,
    /// On a fiber, other statements park until `wakeParked` (their I/O).
    park: bool = false,
    parked: std.ArrayList(*core.fiber.Waiter) = .empty,

    fn query(ctx: *anyopaque, _: db.service.Backend.Which, _: []const u8, arena: Allocator, sql: []const u8, _: []const Value, failure: ?*db.Failure) db.Error!db.Result {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        if (std.mem.eql(u8, sql, "SELECT held")) {
            self.mutex.lock();
            defer self.mutex.unlock();
            while (!self.released) self.cond.wait(&self.mutex);
            return .{ .rows = &.{}, .row_count = 0 };
        }
        if (std.mem.eql(u8, sql, "SELECT after")) return .{ .rows = &.{}, .row_count = 0 };
        if (self.park and core.fiber.inFiber()) {
            var w: core.fiber.Waiter = .{};
            self.parked.append(testing.allocator, &w) catch return error.OutOfMemory;
            w.wait();
        }
        const explain = std.mem.startsWith(u8, sql, explain_prefix);
        const fail = if (explain) self.fail_explain else self.fail_statement;
        if (fail) |prefix| if (std.mem.startsWith(u8, if (explain) sql[explain_prefix.len..] else sql, prefix)) {
            if (failure) |f| f.message = "boom";
            return error.QueryFailed;
        };
        const row: ?[]const u8 = if (explain)
            std.fmt.allocPrint(arena, "{{\"QUERY PLAN\":[{{\"Plan\":{{\"Total Cost\":{s}}}}}]}}", .{self.cost}) catch return error.OutOfMemory
        else if (std.mem.startsWith(u8, sql, snapshot_prefix))
            self.snapshot
        else
            null;
        const text = row orelse return .{ .rows = &.{}, .row_count = 0 };
        const rows = arena.alloc(Value, 1) catch return error.OutOfMemory;
        rows[0] = core.json.parse(arena, text, .{}) catch return error.OutOfMemory;
        return .{ .rows = rows, .row_count = 1 };
    }

    /// Completes the parked statements' I/O (on the fibers' loop).
    fn wakeParked(self: *Fake) void {
        for (self.parked.items) |w| w.wake();
        self.parked.clearRetainingCapacity();
    }

    fn release(self: *Fake) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.released = true;
        self.cond.broadcast();
    }
};

/// Another request's GraphQL query, on its own thread.
const Competitor = struct {
    dbs: *db.DbService,
    sql: []const u8,
    thread: std.Thread = undefined,
    done: std.atomic.Value(bool) = .init(false),
    refused: bool = false,

    fn run(self: *Competitor) void {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        var failure: db.Failure = .{};
        _ = self.dbs.query(arena.allocator(), self.sql, &.{}, &failure) catch {
            self.refused = std.mem.eql(u8, failure.message, capacity_message);
        };
        self.done.store(true, .release);
    }

    /// Starts it and waits until it was refused or admitted (has a query id).
    fn start(self: *Competitor) void {
        const ids = self.dbs.next_query_id.load(.acquire);
        self.thread = std.Thread.spawn(.{}, run, .{self}) catch @panic("spawn");
        while (!self.done.load(.acquire) and self.dbs.next_query_id.load(.acquire) == ids) std.Thread.sleep(50 * std.time.ns_per_us);
    }
};

/// The request's execution admission (`execute.beforeIo`), called right
/// before each of its database reads, after the previous one completed:
/// from the second on, another request's query runs first.
const Injector = struct {
    dbs: *db.DbService,
    competitor_sql: []const u8,
    /// Refuse this read: the request lost its execution slot.
    refuse: ?usize = null,
    /// Close the service before this read (after the previous one).
    close: ?usize = null,
    ios: usize = 0,
    competitors: [8]Competitor = undefined,
    len: usize = 0,

    fn enter(ctx: *anyopaque) bool {
        const self: *Injector = @ptrCast(@alignCast(ctx));
        self.ios += 1;
        if (self.refuse == self.ios) return false;
        if (self.close == self.ios) self.dbs.close() catch {};
        if (self.ios == 1 or self.len == self.competitors.len) return true;
        const c = &self.competitors[self.len];
        self.len += 1;
        c.* = .{ .dbs = self.dbs, .sql = self.competitor_sql };
        c.start();
        return true;
    }

    fn install(self: *Injector) void {
        self.ios = 0;
        self.len = 0;
        execute.admission = .{ .ctx = self, .enter = enter };
    }

    /// Uninstalls it and joins its competitors (release held ones first).
    fn join(self: *Injector) void {
        execute.admission = null;
        for (self.competitors[0..self.len]) |*c| c.thread.join();
    }

    fn allRefused(self: *const Injector) bool {
        for (self.competitors[0..self.len]) |c| if (!c.refused) return false;
        return true;
    }
};

const Warnings = struct {
    var count: std.atomic.Value(usize) = .init(0);
    fn sink(_: ?*anyopaque, level: core.log.Level, _: []const u8, _: []const u8) void {
        if (level == .warn) _ = count.fetchAdd(1, .monotonic);
    }
};

/// Sets the cap (and a log sink counting warnings) until `restore`.
const Globals = struct {
    config: core.config.Config,

    fn set(url: []const u8, cap: u64) Globals {
        const saved: Globals = .{ .config = core.config.get().* };
        var config = saved.config;
        config.database_url = url;
        config.database_max_pending_graphql_queries = cap;
        core.config.set(config);
        core.log.setSink(Warnings.sink, null);
        return saved;
    }

    fn restore(self: Globals) void {
        execute.admission = null;
        core.log.setSink(null, null);
        core.config.set(self.config);
    }
};

fn pendingMain(dbs: *db.DbService) usize {
    dbs.mutex.lock();
    defer dbs.mutex.unlock();
    return dbs.pending_main;
}

fn selectArgs(a: Allocator, text: []const u8) !scraperdb.SelectArgs {
    const v = try core.json.parse(a, text, .{});
    return scraperdb.resolvers.selectArgs(&v, null);
}

const Read = enum { select, select_messages, select_lazy };

fn read(svc: scraperdb.Service, a: Allocator, budget: *scraperdb.HistoryBudget, which: Read, args: scraperdb.SelectArgs, diag: *scraperdb.Diag) anyerror!void {
    switch (which) {
        .select => _ = try svc.select(a, budget, .message_view, args, diag),
        .select_messages => _ = try svc.selectMessages(a, budget, .{ .select = args, .confirmations = .{ .number = 2 } }, diag),
        // With a test backend the lazy statement returns null before any check.
        .select_lazy => if (try svc.selectLazy(a, budget, .message_view, args, diag)) |lazy| lazy.deinit(),
    }
}

test "a history read keeps its EXPLAIN's pending slot for its statement (TS microtask handover)" {
    const globals = Globals.set("postgresql://scraper-proxy-test", 1);
    defer globals.restore();
    core.metrics.init();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var fake: Fake = .{};
    defer fake.release();
    const dbs = try db.DbService.init(testing.allocator, null);
    defer dbs.deinit();
    dbs.backend = .{ .ctx = &fake, .query = Fake.query };
    const svc = scraperdb.Service.init(App.database(dbs));
    var injector: Injector = .{ .dbs = dbs, .competitor_sql = "SELECT held" };
    const queries = &core.metrics.database_queries;
    const args = try selectArgs(a, "{\"limit\":100}");

    // select: EXPLAIN, statement; selectMessages: the snapshot's pair (its
    // lazy read, null here, then unconverted), then the projection's;
    // selectLazy: EXPLAIN, lazy read. Every competitor arriving between two
    // reads is refused before it gets a query id, metric or log line.
    const cases = [_]struct { read: Read, statements: u64, competitors: usize }{
        .{ .read = .select, .statements = 2, .competitors = 1 },
        .{ .read = .select_messages, .statements = 4, .competitors = 4 },
        .{ .read = .select_lazy, .statements = 1, .competitors = 1 },
    };
    for (cases) |case| {
        const ids = dbs.next_query_id.load(.acquire);
        const ok = queries.get(.{ "success", "graphql_primary" });
        const failed = queries.get(.{ "error", "graphql_primary" });
        const warnings = Warnings.count.load(.acquire);
        var budget: scraperdb.HistoryBudget = .{};
        var diag: scraperdb.Diag = .{};
        const result = blk: {
            injector.install();
            defer injector.join();
            defer fake.release();
            break :blk read(svc, a, &budget, case.read, args, &diag);
        };
        fake.released = false;
        result catch |err| {
            std.debug.print("{s}: {s} ({s})\n", .{ @tagName(case.read), @errorName(err), diag.message });
            return err;
        };
        try testing.expectEqual(case.competitors, injector.len);
        try testing.expect(injector.allRefused());
        try testing.expectEqual(ids + case.statements, dbs.next_query_id.load(.acquire));
        try testing.expectEqual(ok + @as(f64, @floatFromInt(case.statements)), queries.get(.{ "success", "graphql_primary" }));
        try testing.expectEqual(failed, queries.get(.{ "error", "graphql_primary" }));
        try testing.expectEqual(warnings, Warnings.count.load(.acquire));
        try testing.expectEqual(@as(usize, 0), pendingMain(dbs));
    }
}

test "a history read gives its pending slot back on every failure path" {
    const globals = Globals.set("postgresql://scraper-proxy-test", 1);
    defer globals.restore();
    core.metrics.init();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const args = try selectArgs(a, "{\"limit\":100}");

    const statement_budget = "History query exceeds the database planning budget";
    const operation_budget = "GraphQL operation exceeds its database planning budget";
    const Case = struct {
        read: Read = .select,
        fake: Fake = .{},
        remaining: f64 = scraperdb.service.OPERATION_PLAN_COST,
        refuse: ?usize = null,
        close: ?usize = null,
        /// The cap is full (another request's query is running).
        full: bool = false,
        err: anyerror,
        message: []const u8,
    };
    const cases = [_]Case{
        // The first EXPLAIN is refused at the cap; nothing runs.
        .{ .full = true, .err = error.QueryFailed, .message = capacity_message },
        .{ .read = .select_messages, .full = true, .err = error.QueryFailed, .message = capacity_message },
        .{ .read = .select_lazy, .full = true, .err = error.QueryFailed, .message = capacity_message },
        // After the EXPLAIN kept its slot.
        .{ .fake = .{ .cost = "100001" }, .err = error.AssertionFailed, .message = statement_budget },
        .{ .fake = .{ .cost = "50" }, .remaining = 10, .err = error.AssertionFailed, .message = operation_budget },
        .{ .fake = .{ .fail_explain = "" }, .err = error.QueryFailed, .message = "boom" },
        .{ .fake = .{ .fail_statement = "" }, .err = error.QueryFailed, .message = "boom" },
        .{ .refuse = 2, .err = error.CapacityExceeded, .message = route.capacity_message },
        // The statement inherits the slot, then the service is closed.
        .{ .close = 2, .err = error.PoolClosed, .message = "Cannot use a pool after calling end on the pool" },
        .{ .read = .select_lazy, .fake = .{ .cost = "100001" }, .err = error.AssertionFailed, .message = statement_budget },
        .{ .read = .select_lazy, .fake = .{ .fail_explain = "" }, .err = error.QueryFailed, .message = "boom" },
        .{ .read = .select_lazy, .refuse = 2, .err = error.CapacityExceeded, .message = route.capacity_message },
        // With confirmations: after the snapshot's statement kept its slot.
        .{ .read = .select_messages, .fake = .{ .snapshot = "{\"domains\":[],\"heights\":[],\"message_ids\":null}" }, .err = error.AssertionFailed, .message = "Confirmation snapshot exceeds 10000 affected events; query canonical history or narrow msg_id" },
        .{ .read = .select_messages, .fake = .{ .fail_explain = projection_prefix }, .err = error.QueryFailed, .message = "boom" },
        .{ .read = .select_messages, .fake = .{ .fail_statement = projection_prefix }, .err = error.QueryFailed, .message = "boom" },
        .{ .read = .select_messages, .fake = .{ .cost = "50" }, .remaining = 60, .err = error.AssertionFailed, .message = operation_budget },
        .{ .read = .select_messages, .refuse = 4, .err = error.CapacityExceeded, .message = route.capacity_message },
        .{ .read = .select_messages, .fake = .{ .cost = "100001" }, .err = error.AssertionFailed, .message = statement_budget },
    };
    for (cases, 0..) |case, i| {
        errdefer std.debug.print("case {d}\n", .{i});
        var fake = case.fake;
        defer fake.release();
        const dbs = try db.DbService.init(testing.allocator, null);
        defer dbs.deinit();
        dbs.backend = .{ .ctx = &fake, .query = Fake.query };
        const svc = scraperdb.Service.init(App.database(dbs));
        var holder: Competitor = .{ .dbs = dbs, .sql = "SELECT held" };
        var held = case.full;
        if (held) holder.start();
        defer if (held) {
            fake.release();
            holder.thread.join();
        };
        var budget: scraperdb.HistoryBudget = .{ .remaining = case.remaining };
        var diag: scraperdb.Diag = .{};
        var injector: Injector = .{ .dbs = dbs, .competitor_sql = "SELECT after", .refuse = case.refuse, .close = case.close };
        const result = blk: {
            injector.install();
            defer injector.join();
            break :blk read(svc, a, &budget, case.read, args, &diag);
        };
        try testing.expectError(case.err, result);
        try testing.expectEqualStrings(case.message, diag.message);
        try testing.expect(diag.chain == null);
        try testing.expect(injector.allRefused());
        if (held) {
            // Refused at the cap before any I/O: TS does not yield there, so
            // the request never asked for its execution slot.
            try testing.expectEqual(@as(usize, 0), injector.ios);
            try testing.expectEqual(@as(usize, 1), pendingMain(dbs));
            fake.release();
            holder.thread.join();
            held = false;
        }
        try testing.expectEqual(@as(usize, 0), pendingMain(dbs));
        if (case.close == null) _ = try dbs.query(a, "SELECT after", &.{}, null);
    }
}

test "PostgreSQL: lazy history reads keep their EXPLAIN's pending slot (bench shape)" {
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_DATABASE_URL") orelse return error.SkipZigTest;
    const gpa = testing.allocator;
    const globals = Globals.set(url, 1);
    defer globals.restore();
    var scheduler = core.scheduler.Scheduler.init(gpa);
    try scheduler.start();
    core.scheduler.setGlobal(&scheduler);
    defer {
        core.scheduler.setGlobal(null);
        scheduler.deinit();
    }
    const dbs = try db.DbService.init(gpa, null);
    defer dbs.deinit();
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const svc = scraperdb.Service.init(App.database(dbs));
    var injector: Injector = .{ .dbs = dbs, .competitor_sql = "SELECT pg_sleep(0.2)" };
    const args = try selectArgs(a, "{\"limit\":100,\"order_by\":{\"id\":\"desc\"}}");
    const messages_args = try selectArgs(a, "{\"limit\":20}");

    // The bench's root: the EXPLAIN, then the lazy (raw rows) statement.
    var budget: scraperdb.HistoryBudget = .{};
    var diag: scraperdb.Diag = .{};
    const lazy = blk: {
        injector.install();
        defer injector.join();
        break :blk svc.selectLazy(a, &budget, .message_view, args, &diag);
    };
    const rows = lazy catch |err| {
        std.debug.print("selectLazy: {s} ({s})\n", .{ @errorName(err), diag.message });
        return err;
    };
    try testing.expectEqual(@as(usize, 1), injector.len);
    try testing.expect(injector.allRefused());
    const result = rows orelse return error.TestUnexpectedResult;
    defer result.deinit();
    // The `small` fixture has more than 100 messages within the budget.
    try testing.expectEqual(@as(usize, 100), result.rows);
    try testing.expectEqual(@as(usize, 0), pendingMain(dbs));

    // With confirmations: the lazy snapshot statement takes its EXPLAIN's
    // slot, the projection's EXPLAIN the snapshot's, the projection its
    // EXPLAIN's.
    budget = .{};
    const messages = blk: {
        injector.install();
        defer injector.join();
        break :blk svc.selectMessages(a, &budget, .{ .select = messages_args, .confirmations = .{ .number = 2 } }, &diag);
    };
    _ = messages catch |err| {
        std.debug.print("selectMessages: {s} ({s})\n", .{ @errorName(err), diag.message });
        return err;
    };
    try testing.expectEqual(@as(usize, 3), injector.len);
    try testing.expect(injector.allRefused());
    try testing.expectEqual(@as(usize, 0), pendingMain(dbs));
}

/// Fan-out test backend: records each statement's first parameter (a
/// number) or else its SQL, and parks the calling fiber until `releaseAll`.
const ParkingDb = struct {
    seen: std.ArrayList([]const u8) = .empty,
    parked: std.ArrayList(*core.fiber.Waiter) = .empty,

    fn query(ctx: *anyopaque, _: db.service.Backend.Which, _: []const u8, _: Allocator, sql: []const u8, params: []const Value, _: ?*db.Failure) db.Error!db.Result {
        const self: *ParkingDb = @ptrCast(@alignCast(ctx));
        const copy = (if (params.len > 0 and params[0] == .number)
            std.fmt.allocPrint(testing.allocator, "{d}", .{params[0].number})
        else
            testing.allocator.dupe(u8, sql)) catch return error.OutOfMemory;
        self.seen.append(testing.allocator, copy) catch return error.OutOfMemory;
        var w: core.fiber.Waiter = .{};
        self.parked.append(testing.allocator, &w) catch return error.OutOfMemory;
        w.wait();
        return .{ .rows = &.{}, .row_count = 0 };
    }

    fn deinit(self: *ParkingDb) void {
        for (self.seen.items) |tag| testing.allocator.free(tag);
        self.seen.deinit(testing.allocator);
        self.parked.deinit(testing.allocator);
    }
};

test "a request's root fields reach their first pending check back to back (graphql-js executeFields)" {
    // A cap of 4: whichever four checks come first run, the fifth is refused.
    const globals = Globals.set("postgresql://scraper-proxy-test", 4);
    defer globals.restore();
    var parking: ParkingDb = .{};
    defer parking.deinit();
    const dbs = try db.DbService.init(testing.allocator, null);
    defer dbs.deinit();
    dbs.backend = .{ .ctx = &parking, .query = ParkingDb.query };
    var pool = root_pool.RootPool.init(4);
    defer pool.deinit();

    // On one loop: request A (four roots), then request B (one query) is
    // ready, then a fiber that releases the parked reads once A's and B's
    // checks are done. graphql-js runs A's four resolvers in one turn, so
    // B's check cannot come between them: A's four run, B is refused.
    const Ctx = struct {
        dbs: *db.DbService,
        parking: *ParkingDb,
        pool: *root_pool.RootPool,
        map: resolvers.ResolverMap,
        body: ?[]const u8 = null,
        b_refused: bool = false,
        b_done: bool = false,
        arena: std.heap.ArenaAllocator,

        fn driver(arg: *anyopaque) void {
            core.fiber.spawn(requestA, arg) catch @panic("spawn");
            core.fiber.spawn(requestB, arg) catch @panic("spawn");
            core.fiber.spawn(releaser, arg) catch @panic("spawn");
        }

        fn requestA(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            const a = self.arena.allocator();
            const query = "{ a: domain_by_pk(id: 1) { id } b: domain_by_pk(id: 2) { id } c: domain_by_pk(id: 3) { id } d: domain_by_pk(id: 4) { id } }";
            const schema = schema_mod.testing.scraper();
            var diag: parser.Diagnostic = .{};
            const doc = parser.parse(a, query, .{}, &diag) catch @panic("parse");
            const coerced = switch (values.getVariableValues(a, schema, doc.definitions[0].operation.variable_definitions, null) catch @panic("oom")) {
                .coerced => |c| c,
                else => @panic("variables"),
            };
            var ex = execute.Executor.init(a, schema, doc, coerced, self.map.resolvers()) catch @panic("oom");
            const result = ex.executeQuery(doc.definitions[0].operation, .{ .pool = self.pool, .backing = testing.allocator }) catch @panic("oom");
            defer result.deinit();
            self.body = route.serializeResponse(a, 200, result.data, result.errors) catch @panic("oom");
        }

        fn requestB(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            var failure: db.Failure = .{};
            if (self.dbs.query(self.arena.allocator(), "SELECT b", &.{}, &failure)) |_| {} else |_| {
                self.b_refused = std.mem.eql(u8, failure.message, capacity_message);
            }
            self.b_done = true;
        }

        fn bParked(self: *@This()) bool {
            for (self.parking.seen.items) |tag| if (std.mem.eql(u8, tag, "SELECT b")) return true;
            return false;
        }

        fn releaser(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            // A's four reads and B's check decided: B refused, or admitted
            // and parked (the order this test rejects).
            while (self.parking.parked.items.len < 4 or !(self.b_done or self.bParked())) {
                // Yield: back of the ready queue.
                const f = core.fiber.current().?;
                f.sched.wake(f.sched.ctx, f);
                core.fiber.park();
            }
            for (self.parking.parked.items) |w| w.wake();
        }
    };
    var ctx: Ctx = .{
        .dbs = dbs,
        .parking = &parking,
        .pool = &pool,
        .map = .{ .db = scraperdb.Service.init(App.database(dbs)) },
        .arena = std.heap.ArenaAllocator.init(testing.allocator),
    };
    defer ctx.arena.deinit();
    try core.fiber.testing.run(Ctx.driver, &ctx);

    const seen = try std.mem.join(testing.allocator, ",", parking.seen.items);
    defer testing.allocator.free(seen);
    try testing.expectEqualStrings("1,2,3,4", seen);
    try testing.expect(ctx.b_refused);
    try testing.expectEqualStrings("{\"data\":{\"a\":null,\"b\":null,\"c\":null,\"d\":null}}", ctx.body orelse "");
    try testing.expectEqual(@as(usize, 0), pendingMain(dbs));
}

/// Runs `query` on a fiber with root fields fanned out as in production
/// (sibling fibers), on the App adapters over `dbs`.
/// (sibling fibers), on the App adapters over `dbs`; `fake`'s parked
/// statements complete a loop round later.
fn runOnFiber(a: Allocator, dbs: *db.DbService, fake: *Fake, query: []const u8) ![]const u8 {
    return runOnFiberWith(a, dbs, fake, query, .{});
}

const RunOptions = struct {
    /// The first sibling root's fiber cannot be made.
    fail_create: bool = false,
    /// JSON variables.
    vars: ?[]const u8 = null,
    diagnostics: ?resolvers.Diagnostics = null,
};

fn runOnFiberWith(a: Allocator, dbs: *db.DbService, fake: *Fake, query: []const u8, options: RunOptions) ![]const u8 {
    var pool = root_pool.RootPool.init(4);
    defer pool.deinit();
    const Ctx = struct {
        a: Allocator,
        query: []const u8,
        pool: *root_pool.RootPool,
        fake: *Fake,
        map: resolvers.ResolverMap,
        body: anyerror![]const u8 = error.NotRun,
        done: bool = false,
        options: RunOptions,

        fn start(arg: *anyopaque) void {
            core.fiber.spawn(run, arg) catch @panic("spawn");
            core.fiber.spawn(io, arg) catch @panic("spawn");
        }

        fn run(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            self.body = self.runQuery();
            self.done = true;
        }

        /// The statements' I/O: completes what parked, once per loop round.
        fn io(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            while (!self.done) {
                self.fake.wakeParked();
                const f = core.fiber.current().?;
                f.sched.wake(f.sched.ctx, f);
                core.fiber.park();
            }
        }

        fn runQuery(self: *@This()) ![]const u8 {
            const schema = schema_mod.testing.scraper();
            var diag: parser.Diagnostic = .{};
            const doc = try parser.parse(self.a, self.query, .{}, &diag);
            const vars: ?Value = if (self.options.vars) |v| try core.json.parse(self.a, v, .{}) else null;
            const coerced = switch (try values.getVariableValues(self.a, schema, doc.definitions[0].operation.variable_definitions, vars)) {
                .coerced => |c| c,
                else => return error.BadVariables,
            };
            var ex = try execute.Executor.init(self.a, schema, doc, coerced, self.map.resolvers());
            // The first sibling root's fiber cannot be made: it runs inline.
            if (self.options.fail_create) core.fiber.test_fail_create.store(true, .release);
            const result = try ex.executeQuery(doc.definitions[0].operation, .{ .pool = self.pool, .backing = testing.allocator });
            defer result.deinit();
            return route.serializeResponse(self.a, 200, result.data, result.errors);
        }
    };
    var ctx: Ctx = .{ .a = a, .query = query, .pool = &pool, .fake = fake, .options = options, .map = .{ .db = scraperdb.Service.init(App.database(dbs)), .diagnostics = options.diagnostics } };
    try core.fiber.testing.run(Ctx.start, &ctx);
    return ctx.body;
}

test "root fields failing without I/O settle in TS's microtask order (bytes from Node 26.12.1)" {
    // The TS oracle: createScraperProxyApp on a real DbService (pg mocked),
    // DATABASE_MAX_PENDING_GRAPHQL_QUERIES = cap, one query held; at cap 2
    // the first root field (document order) is admitted and runs.
    // Without a held query (cap 25), assertion failures only.
    // `.diag`: the diagnostics service configured (its database unused:
    // every diagnostics read here fails its argument checks); `.vars`: the
    // request's variables.
    const cases = [_]struct { cap: u64, hold: bool = true, diag: bool = false, vars: ?[]const u8 = null, query: []const u8, body: []const u8 }{
        // v26.12.1 cap 1
        .{ .cap = 1, .query = "{ m: message_view(limit: 1) { id } d: domain(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"d\"]}]}" },
        .{ .cap = 1, .query = "{ d: domain(limit: 1) { id } m: message_view(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":30}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        .{ .cap = 1, .query = "{ m: message_view(limit: 1) { id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":{\"m\":null,\"p\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"p\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m\"]}]}" },
        .{ .cap = 1, .query = "{ p: domain_by_pk(id: 1) { id } m: message_view(limit: 1) { id } }", .body = "{\"data\":{\"p\":null,\"m\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"p\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":33}],\"path\":[\"m\"]}]}" },
        .{ .cap = 1, .query = "{ d: domain(limit: 1) { id } r: raw_message_dispatch(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        .{ .cap = 1, .query = "{ r: raw_message_dispatch(limit: 1) { id } d: domain(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"r\"]}]}" },
        .{ .cap = 1, .query = "{ db: domain(limit: 501) { id } m: message_view(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"db\"]}]}" },
        .{ .cap = 1, .query = "{ m: message_view(limit: 1) { id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"db\"]}]}" },
        .{ .cap = 1, .query = "{ ac: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } } m: message_view(limit: 1) { id } }", .body = "{\"data\":{\"ac\":{\"aggregate\":null},\"m\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":104}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":94}],\"path\":[\"ac\",\"aggregate\",\"count\"]}]}" },
        .{ .cap = 1, .query = "{ ac: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } } d: domain(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":104}],\"path\":[\"d\"]}]}" },
        .{ .cap = 1, .query = "{ mc: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: 2) { id } m: message_view(limit: 1) { id } }", .body = "{\"data\":{\"mc\":null,\"m\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"mc\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":77}],\"path\":[\"m\"]}]}" },
        .{ .cap = 1, .query = "{ ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } m: message_view(limit: 1) { id } }", .body = "{\"data\":{\"ma\":null,\"m\":null},\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"ma\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":78}],\"path\":[\"m\"]}]}" },
        .{ .cap = 1, .query = "{ m: message_view(limit: 1) { id } ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } }", .body = "{\"data\":{\"m\":null,\"ma\":null},\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"ma\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m\"]}]}" },
        .{ .cap = 1, .query = "{ ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":{\"ma\":null,\"p\":null},\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"ma\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":78}],\"path\":[\"p\"]}]}" },
        .{ .cap = 1, .query = "{ d: domain(limit: 1) { id } m: message_view(limit: 1) { id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":63}],\"path\":[\"p\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":30}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        .{ .cap = 1, .query = "{ ac: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } } q: raw_message_dispatch_by_pk(id: 1) { id } m: message_view(limit: 1) { id } r: raw_message_dispatch(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":104}],\"path\":[\"q\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":148}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":181}],\"path\":[\"r\"]}]}" },
        .{ .cap = 1, .query = "{ ac: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } } m: message_view(limit: 1) { id } mc: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: 2) { id } q: raw_message_dispatch_by_pk(id: 1) { id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":{\"ac\":{\"aggregate\":null},\"m\":null,\"mc\":null,\"q\":null,\"p\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":211}],\"path\":[\"q\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":255}],\"path\":[\"p\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":137}],\"path\":[\"mc\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":104}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":94}],\"path\":[\"ac\",\"aggregate\",\"count\"]}]}" },
        .{ .cap = 1, .query = "{ r: raw_message_dispatch(limit: 1) { id } d: domain(limit: 1) { id } a: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { nodes { id } } m: message_view(limit: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":164}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"r\"]}]}" },
        .{ .cap = 1, .query = "{ a: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { nodes { id } } p: domain_by_pk(id: 1) { id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":96}],\"path\":[\"p\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":126}],\"path\":[\"db\"]}]}" },
        // v26.12.1 cap 2
        .{ .cap = 2, .query = "{ p: domain_by_pk(id: 1) { id } m: message_view(limit: 1) { id } d: domain(limit: 1) { id } q: raw_message_dispatch_by_pk(id: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":93}],\"path\":[\"q\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":33}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":66}],\"path\":[\"d\"]}]}" },
        .{ .cap = 2, .query = "{ q: raw_message_dispatch_by_pk(id: 1) { id } ac: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } } p: domain_by_pk(id: 1) { id } m: message_view(limit: 1) { id } }", .body = "{\"data\":{\"q\":null,\"ac\":{\"aggregate\":null},\"p\":null,\"m\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":148}],\"path\":[\"p\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":178}],\"path\":[\"m\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":138}],\"path\":[\"ac\",\"aggregate\",\"count\"]}]}" },
        .{ .cap = 2, .query = "{ m: message_view(limit: 1) { id } q: raw_message_dispatch_by_pk(id: 1) { id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":{\"m\":[],\"q\":null,\"p\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"q\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":80}],\"path\":[\"p\"]}]}" },
        .{ .cap = 2, .query = "{ d: domain(limit: 1) { id } q: raw_message_dispatch_by_pk(id: 1) { id } mc: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: 2) { id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":{\"d\":[],\"q\":null,\"mc\":null,\"p\":null},\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":30}],\"path\":[\"q\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":148}],\"path\":[\"p\"]},{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":74}],\"path\":[\"mc\"]}]}" },
        // v26.12.1, no query held (assertions only)
        .{ .cap = 25, .hold = false, .query = "{ m5: message_view(limit: 501) { id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":39}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ db: domain(limit: 501) { id } m5: message_view(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":33}],\"path\":[\"m5\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ m5: message_view(limit: 501) { id } c5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { aggregate { count } } }", .body = "{\"data\":{\"m5\":null,\"c5\":{\"aggregate\":null}},\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":132}],\"path\":[\"c5\",\"aggregate\",\"count\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ c5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { aggregate { count } } m5: message_view(limit: 501) { id } }", .body = "{\"data\":{\"c5\":{\"aggregate\":null},\"m5\":null},\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":106}],\"path\":[\"m5\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":96}],\"path\":[\"c5\",\"aggregate\",\"count\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ c5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { aggregate { count } } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":106}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ db: domain(limit: 501) { id } r5: raw_message_dispatch(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ r5: raw_message_dispatch(limit: 501) { id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"r5\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } c5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { aggregate { count } } }", .body = "{\"data\":{\"ma\":null,\"c5\":{\"aggregate\":null}},\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"ma\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":171}],\"path\":[\"c5\",\"aggregate\",\"count\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ a5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { nodes { id } } ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":99}],\"path\":[\"ma\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a5\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ c5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { aggregate { count } } a5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { nodes { id } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":106}],\"path\":[\"a5\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } m5: message_view(limit: 501) { id } }", .body = "{\"data\":{\"ma\":null,\"m5\":null},\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"ma\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":78}],\"path\":[\"m5\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ m5: message_view(limit: 501) { id } ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } }", .body = "{\"data\":{\"m5\":null,\"ma\":null},\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":39}],\"path\":[\"ma\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]}]}" },
        // v26.12.1 d_diag: cap 25, held 0, diagnostics configured
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ db: domain(limit: 501) { id } d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } m5: message_view(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":70}],\"path\":[\"m5\"]},{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ m5: message_view(limit: 501) { id } d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]},{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":39}],\"path\":[\"d\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ dl: message_activity(message_id: \"0x1111111111111111111111111111111111111111111111111111111111111111\", limit: 0) { has_more } m5: message_view(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":129}],\"path\":[\"m5\"]},{\"message\":\"limit must be between 1 and 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"dl\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ dbf: message_activity(message_id: \"0x1111111111111111111111111111111111111111111111111111111111111111\", before_id: \"x\") { has_more } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"before_id must be a non-negative bigint string\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"dbf\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ s: message_diagnostics(message_id: \"0xbad\") { message_id } m5: message_view(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":62}],\"path\":[\"m5\"]},{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"s\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ m5: message_view(limit: 501) { id } s: message_diagnostics(message_id: \"0xbad\") { message_id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]},{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":39}],\"path\":[\"s\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ s: message_diagnostics(message_id: \"0xbad\") { message_id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":62}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ db: domain(limit: 501) { id } s: message_diagnostics(message_id: \"0xbad\") { message_id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } s: message_diagnostics(message_id: \"0xbad\") { message_id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ s: message_diagnostics(message_id: \"0xbad\") { message_id } d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":62}],\"path\":[\"d\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } s: message_diagnostics(message_id: \"0xbad\") { message_id } p: domain_by_pk(id: 1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"ma\"]},{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":78}],\"path\":[\"s\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .query = "{ d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":70}],\"path\":[\"ma\"]},{\"message\":\"Expected a 32-byte message ID\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"]}]}" },
        // v26.12.1 d_nodiag: cap 25, held 0, diagnostics not configured
        .{ .cap = 25, .hold = false, .query = "{ s: message_diagnostics(message_id: \"0xbad\") { message_id } m5: message_view(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":62}],\"path\":[\"m5\"]},{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"s\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}" },
        .{ .cap = 25, .hold = false, .query = "{ m5: message_view(limit: 501) { id } s: message_diagnostics(message_id: \"0xbad\") { message_id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]},{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":39}],\"path\":[\"s\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}" },
        .{ .cap = 25, .hold = false, .query = "{ s: message_diagnostics(message_id: \"0xbad\") { message_id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"s\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}" },
        .{ .cap = 25, .hold = false, .query = "{ db: domain(limit: 501) { id } s: message_diagnostics(message_id: \"0xbad\") { message_id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .query = "{ d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } m5: message_view(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"d\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}" },
        .{ .cap = 25, .hold = false, .query = "{ m5: message_view(limit: 501) { id } d: message_activity(message_id: \"0xnot-a-message-id\") { has_more } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m5\"]},{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":39}],\"path\":[\"d\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}" },
        .{ .cap = 25, .hold = false, .query = "{ p: domain_by_pk(id: 1) { id } s: message_diagnostics(message_id: \"0xbad\") { message_id } ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"confirmations must be a non-negative safe integer\",\"locations\":[{\"line\":1,\"column\":92}],\"path\":[\"ma\"]},{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":33}],\"path\":[\"s\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}" },
        // v26.12.1 d_vars: cap 25, held 0, diagnostics configured
        .{ .cap = 25, .hold = false, .diag = true, .vars = "{\"v\":null}", .query = "query($v: Int = 1) { p: domain_by_pk(id: $v) { id } m: message_view(order_by: {nonce: desc}, limit: 1) { id } }", .body = "{\"data\":{\"p\":null,\"m\":null},\"errors\":[{\"message\":\"Argument \\\"id\\\" of non-null type \\\"Int!\\\" must not be null.\",\"locations\":[{\"line\":1,\"column\":42}],\"path\":[\"p\"]},{\"message\":\"Use ID ordering for history, nonce for an identifier, or send time for a provisional-only feed\",\"locations\":[{\"line\":1,\"column\":53}],\"path\":[\"m\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .vars = "{\"m\":null}", .query = "query($m: String = \"x\") { d: message_activity(message_id: $m) { has_more } ma: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: -1) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Argument \\\"message_id\\\" of non-null type \\\"String!\\\" must not be null.\",\"locations\":[{\"line\":1,\"column\":59}],\"path\":[\"d\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .vars = "{\"v\":null}", .query = "query($v: Int = 1) { m5: message_view(limit: 501) { id } p: domain_by_pk(id: $v) { id } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"Argument \\\"id\\\" of non-null type \\\"Int!\\\" must not be null.\",\"locations\":[{\"line\":1,\"column\":78}],\"path\":[\"p\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":22}],\"path\":[\"m5\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":89}],\"path\":[\"db\"]}]}" },
        .{ .cap = 25, .hold = false, .diag = true, .vars = "{\"m\":null}", .query = "query($m: String = \"x\") { m5: message_view(limit: 501) { id } d: message_activity(message_id: $m) { has_more } db: domain(limit: 501) { id } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":27}],\"path\":[\"m5\"]},{\"message\":\"Argument \\\"message_id\\\" of non-null type \\\"String!\\\" must not be null.\",\"locations\":[{\"line\":1,\"column\":95}],\"path\":[\"d\"]}]}" },
        // v26.12.1 d_stop: cap 1, held 1, diagnostics configured
        .{ .cap = 1, .diag = true, .query = "{ db: domain(limit: 501) { id } m: message_view(limit: 1) { id } x: message_view_aggregate { aggregate { count } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":33}],\"path\":[\"m\"]},{\"message\":\"History aggregates require an exact message or transaction identifier\",\"locations\":[{\"line\":1,\"column\":66}],\"path\":[\"x\"]}]}" },
        .{ .cap = 1, .diag = true, .query = "{ db: domain(limit: 501) { id } c5: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 501) { aggregate { count } } x: message_view_aggregate { aggregate { count } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"History aggregates require an exact message or transaction identifier\",\"locations\":[{\"line\":1,\"column\":136}],\"path\":[\"x\"]}]}" },
        .{ .cap = 1, .diag = true, .query = "{ dm: domain(limit: 1) { id } ac: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } } x: message_view_aggregate { aggregate { count } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"History aggregates require an exact message or transaction identifier\",\"locations\":[{\"line\":1,\"column\":132}],\"path\":[\"x\"]}]}" },
        .{ .cap = 1, .diag = true, .query = "{ dm: domain(limit: 1) { id } m: message_view(limit: 1) { id } x: message_view_aggregate { aggregate { count } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":31}],\"path\":[\"m\"]},{\"message\":\"History aggregates require an exact message or transaction identifier\",\"locations\":[{\"line\":1,\"column\":64}],\"path\":[\"x\"]}]}" },
        .{ .cap = 1, .diag = true, .query = "{ m: message_view(limit: 1) { id } dm: domain(limit: 1) { id } x: message_view_aggregate { aggregate { count } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"m\"]},{\"message\":\"History aggregates require an exact message or transaction identifier\",\"locations\":[{\"line\":1,\"column\":64}],\"path\":[\"x\"]}]}" },
        .{ .cap = 1, .diag = true, .query = "{ db: domain(limit: 501) { id } p: domain_by_pk(id: 1) { id } x: message_view_aggregate { aggregate { count } } }", .body = "{\"data\":null,\"errors\":[{\"message\":\"GraphQL database query capacity exceeded\",\"locations\":[{\"line\":1,\"column\":33}],\"path\":[\"p\"]},{\"message\":\"History aggregates require an exact message or transaction identifier\",\"locations\":[{\"line\":1,\"column\":63}],\"path\":[\"x\"]}]}" },
    };
    for (cases, 0..) |case, i| {
        errdefer std.debug.print("case {d}: {s}\n", .{ i, case.query });
        const globals = Globals.set("postgresql://scraper-proxy-test", case.cap);
        defer globals.restore();
        var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena_state.deinit();
        const a = arena_state.allocator();
        var fake: Fake = .{ .park = true };
        defer fake.parked.deinit(testing.allocator);
        defer fake.release();
        const dbs = try db.DbService.init(testing.allocator, null);
        defer dbs.deinit();
        dbs.backend = .{ .ctx = &fake, .query = Fake.query };
        var holder: Competitor = .{ .dbs = dbs, .sql = "SELECT held" };
        if (case.hold) holder.start();
        defer if (case.hold) holder.thread.join();
        defer fake.release();
        const NoRows = struct {
            fn query(_: *anyopaque, _: Allocator, _: []const u8, _: []const ?[]const u8) anyerror![]const @import("diagnostics").js.Value {
                return &.{};
            }
        };
        var unused: u8 = 0;
        var diagnostics: @import("diagnostics").Service = .{ .db = .{ .ctx = &unused, .query = NoRows.query } };
        var app: App = .{ .gpa = testing.allocator, .schema = undefined, .db = dbs, .diagnostics = &diagnostics };
        const body = try runOnFiberWith(a, dbs, &fake, case.query, .{ .vars = case.vars, .diagnostics = if (case.diag) app.diagnosticsSource() else null });
        try testing.expectEqualStrings(case.body, body);
    }
}

test "a root field whose fiber cannot be made runs inline: same bytes" {
    const globals = Globals.set("postgresql://scraper-proxy-test", 25);
    defer globals.restore();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var fake: Fake = .{ .park = true };
    defer fake.parked.deinit(testing.allocator);
    const dbs = try db.DbService.init(testing.allocator, null);
    defer dbs.deinit();
    dbs.backend = .{ .ctx = &fake, .query = Fake.query };
    const query = "{ a: domain_by_pk(id: 1) { id } b: domain(limit: 1) { id } c: domain_by_pk(id: 2) { id } }";
    const expected = "{\"data\":{\"a\":null,\"b\":[],\"c\":null}}";
    try testing.expectEqualStrings(expected, try runOnFiberWith(a, dbs, &fake, query, .{}));
    try testing.expectEqualStrings(expected, try runOnFiberWith(a, dbs, &fake, query, .{ .fail_create = true }));
    try testing.expect(!core.fiber.test_fail_create.load(.acquire));
    try testing.expectEqual(@as(usize, 0), pendingMain(dbs));
}

test "a request that already lost its execution slot reserves no pending slot" {
    const globals = Globals.set("postgresql://scraper-proxy-test", 1);
    defer globals.restore();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var fake: Fake = .{};
    const dbs = try db.DbService.init(testing.allocator, null);
    defer dbs.deinit();
    dbs.backend = .{ .ctx = &fake, .query = Fake.query };
    const svc = scraperdb.Service.init(App.database(dbs));
    const Gate = struct {
        dbs: *db.DbService,
        rejected: bool,
        /// Pending main queries seen by each `enter`.
        seen: [4]usize = undefined,
        calls: usize = 0,
        fn enter(ctx: *anyopaque) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.seen[self.calls] = pendingMain(self.dbs);
            self.calls += 1;
            return false;
        }
        fn isRejected(ctx: *anyopaque) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.rejected;
        }
    };
    const args = try selectArgs(a, "{\"limit\":1}");
    for ([_]bool{ true, false }) |rejected| {
        var gate: Gate = .{ .dbs = dbs, .rejected = rejected };
        var budget: scraperdb.HistoryBudget = .{};
        var diag: scraperdb.Diag = .{};
        const result = blk: {
            execute.admission = .{ .ctx = &gate, .enter = Gate.enter, .rejected = Gate.isRejected };
            defer execute.admission = null;
            break :blk svc.select(a, &budget, .domain, args, &diag);
        };
        try testing.expectError(error.CapacityExceeded, result);
        try testing.expectEqualStrings(route.capacity_message, diag.message);
        if (rejected) {
            // Already the preHandler 503: no reservation, no admission call.
            try testing.expectEqual(@as(usize, 0), gate.calls);
        } else {
            // Lost the race at this read: its reservation is given back at once.
            try testing.expectEqual(@as(usize, 1), gate.calls);
            try testing.expectEqual(@as(usize, 1), gate.seen[0]);
        }
        try testing.expectEqual(@as(usize, 0), pendingMain(dbs));
    }
}
