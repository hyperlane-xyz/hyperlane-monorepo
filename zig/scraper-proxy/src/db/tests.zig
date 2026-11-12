//! Port of `src/db/db.service.test.ts` plus libpq integration tests.
//! Mock-driven TS scenarios use `DbService.backend`; tests needing a real
//! server read SCRAPER_PROXY_TEST_DATABASE_URL (skipped when unset).
const std = @import("std");
const core = @import("core");
const root = @import("root.zig");
const service = @import("service.zig");
const pq = @import("pq.zig");
const pool_mod = @import("pool.zig");
const listener_mod = @import("listener.zig");

const testing = std.testing;
const Value = core.json.Value;
const DbService = service.DbService;

const primary_url = "postgresql://scraper-proxy-test";
const replica_url = "postgresql://scraper-proxy-replica-test";

const ready_schema = [_][]const u8{
    "cursor_exists",         "cursor_readable",        "cursor_trigger_exists", "head_exists",
    "head_readable",         "legacy_boundary_exists", "range_index_exists",    "scraper_head_exists",
};

fn schemaRow(a: std.mem.Allocator, false_name: ?[]const u8, drop: bool) ![]Value {
    var b: core.json.ObjectBuilder = .{};
    for (ready_schema) |name| {
        const is_target = false_name != null and std.mem.eql(u8, name, false_name.?);
        if (is_target and drop) continue;
        try b.putNew(a, name, .{ .bool = !is_target });
    }
    const rows = try a.alloc(Value, 1);
    rows[0] = try b.finish(a);
    return rows;
}

const LogCapture = struct {
    var mutex: std.Thread.Mutex = .{};
    var warnings: std.ArrayList([]u8) = .empty;
    var debugs: usize = 0;

    fn sink(_: ?*anyopaque, level: core.log.Level, _: []const u8, msg: []const u8) void {
        mutex.lock();
        defer mutex.unlock();
        switch (level) {
            .warn => warnings.append(testing.allocator, testing.allocator.dupe(u8, msg) catch return) catch {},
            .debug => debugs += 1,
            else => {},
        }
    }

    fn reset() void {
        for (warnings.items) |w| testing.allocator.free(w);
        warnings.clearAndFree(testing.allocator);
        debugs = 0;
    }
};

fn contains(haystack: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, haystack, needle) != null;
}

const FakeClock = struct {
    var now: std.atomic.Value(i64) = .init(0);
    fn get() i64 {
        return now.load(.acquire);
    }
};

/// The pg.Pool.prototype.query mock from the first TS test.
const ReplicaFake = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    saturated_main: bool = false,
    released: bool = false,
    urls: std.StringHashMapUnmanaged([]const u8) = .empty,

    fn query(ctx: *anyopaque, which: service.Backend.Which, conninfo: []const u8, arena: std.mem.Allocator, sql: []const u8, _: []const Value, failure: ?*root.Failure) root.Error!root.Result {
        const self: *ReplicaFake = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        self.urls.put(testing.allocator, sql, conninfo) catch {};
        self.mutex.unlock();
        if (contains(sql, "has_table_privilege")) return .{ .rows = schemaRow(arena, null, false) catch return error.OutOfMemory, .row_count = 1 };
        if (std.mem.eql(u8, sql, "SELECT pg_sleep(1)")) {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.saturated_main = true;
            self.cond.broadcast();
            while (!self.released) self.cond.wait(&self.mutex);
            self.saturated_main = false;
            return .{ .rows = &.{}, .row_count = 0 };
        }
        if (std.mem.eql(u8, sql, "SELECT fail")) {
            if (failure) |f| f.message = "query failed";
            return error.QueryFailed;
        }
        self.mutex.lock();
        const blocked = which == .main and self.saturated_main;
        self.mutex.unlock();
        std.debug.assert(!blocked);
        const one = try arena.alloc(core.json.Member, 1);
        one[0] = .{ .key = "ready", .value = .{ .number = 1 } };
        if (std.mem.eql(u8, sql, "SELECT slow")) {
            _ = FakeClock.now.fetchAdd(1_000, .acq_rel);
            const rows = try arena.alloc(Value, 2);
            const two = try arena.alloc(core.json.Member, 1);
            two[0] = .{ .key = "ready", .value = .{ .number = 2 } };
            rows[0] = .{ .object = one };
            rows[1] = .{ .object = two };
            return .{ .rows = rows, .row_count = 2 };
        }
        const rows = try arena.alloc(Value, 1);
        rows[0] = .{ .object = one };
        return .{ .rows = rows, .row_count = 0 };
    }
};

fn setTestConfig(replica: bool) void {
    core.config.set(.{
        .database_url = primary_url,
        .database_read_replica_url = if (replica) replica_url else null,
        .database_query_timeout_ms = 1000,
    });
}

test "keeps replica health from gating primary live queries" {
    setTestConfig(true);
    core.metrics.init();
    LogCapture.reset();
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    var fake: ReplicaFake = .{};
    defer fake.urls.deinit(testing.allocator);
    const M = core.metrics;
    const before_success = M.database_queries.get(.{ "success", "graphql_replica" });
    const before_error = M.database_queries.get(.{ "error", "graphql_replica" });
    const before_live = M.database_queries.get(.{ "success", "live_primary" });
    const before_rows = M.database_rows.get(.{"graphql_replica"});

    const svc = try DbService.init(testing.allocator, core.log.child("DbServiceTest"));
    defer svc.deinit();
    svc.backend = .{ .ctx = &fake, .query = ReplicaFake.query };
    svc.clock = FakeClock.get;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var failure: root.Failure = .{};
    try svc.start(&failure, arena);
    try testing.expect(svc.main_pool == null); // no warm-up with a replica

    const Saturate = struct {
        fn run(s: *DbService) void {
            var a = std.heap.ArenaAllocator.init(testing.allocator);
            defer a.deinit();
            _ = s.query(a.allocator(), "SELECT pg_sleep(1)", &.{}, null) catch {};
        }
    };
    const t = try std.Thread.spawn(.{}, Saturate.run, .{svc});
    fake.mutex.lock();
    while (!fake.saturated_main) fake.cond.wait(&fake.mutex);
    fake.mutex.unlock();
    const live_rows = try svc.queryLive(arena, "SELECT 1", &.{}, null);
    try testing.expectEqualStrings("[{\"ready\":1}]", try core.json.stringifyAlloc(arena, .{ .array = live_rows }));
    try testing.expectEqualStrings(replica_url, fake.urls.get("SELECT pg_sleep(1)").?);
    try testing.expectEqualStrings(primary_url, fake.urls.get("SELECT 1").?);
    fake.mutex.lock();
    fake.released = true;
    fake.cond.broadcast();
    fake.mutex.unlock();
    t.join();

    const slow = try svc.query(arena, "SELECT slow", &.{}, null);
    try testing.expectEqualStrings("[{\"ready\":1},{\"ready\":2}]", try core.json.stringifyAlloc(arena, .{ .array = slow }));
    try testing.expectError(error.QueryFailed, svc.query(arena, "SELECT fail", &.{}, &failure));
    try testing.expectEqualStrings("query failed", failure.message);
    try testing.expectEqual(@as(usize, 0), LogCapture.debugs);
    try testing.expectEqual(@as(usize, 2), LogCapture.warnings.items.len);
    const w0 = LogCapture.warnings.items[0];
    const w1 = LogCapture.warnings.items[1];
    try testing.expect(std.mem.startsWith(u8, w0, "slow query id="));
    try testing.expect(contains(w0, "role=graphql_replica durationMs=1000"));
    try testing.expect(contains(w0, "sql=SELECT slow values=[]"));
    try testing.expect(std.mem.startsWith(u8, w1, "query failed id="));
    try testing.expect(contains(w1, "role=graphql_replica"));
    try testing.expect(contains(w1, "sql=SELECT fail values=[]"));
    try testing.expectEqual(before_success + 2, M.database_queries.get(.{ "success", "graphql_replica" }));
    try testing.expectEqual(before_error + 1, M.database_queries.get(.{ "error", "graphql_replica" }));
    try testing.expectEqual(before_live + 2, M.database_queries.get(.{ "success", "live_primary" }));
    try testing.expectEqual(before_rows + 2, M.database_rows.get(.{"graphql_replica"}));
    const exposition = try M.render(testing.allocator);
    defer testing.allocator.free(exposition);
    try testing.expect(contains(exposition, "database_query_duration_seconds_count{outcome=\"success\",role=\"graphql_replica\"} 2\n"));
}

/// A TCP listener that never accepts: libpq's startup packet is never
/// answered, like the TS `Socket.prototype.connect` mock.
fn stalledListener() !struct { fd: std.posix.socket_t, port: u16 } {
    const addr = try std.net.Address.parseIp("127.0.0.1", 0);
    const fd = try std.posix.socket(std.posix.AF.INET, std.posix.SOCK.STREAM, 0);
    try std.posix.bind(fd, &addr.any, addr.getOsSockLen());
    try std.posix.listen(fd, 16);
    var bound: std.net.Address = undefined;
    var len: std.posix.socklen_t = @sizeOf(std.net.Address);
    try std.posix.getsockname(fd, &bound.any, &len);
    return .{ .fd = fd, .port = bound.getPort() };
}

test "times out stalled replica connections" {
    const stalled = try stalledListener();
    defer std.posix.close(stalled.fd);
    var url_buf: [128]u8 = undefined;
    const url = try std.fmt.bufPrint(&url_buf, "postgresql://u:p@127.0.0.1:{d}/x", .{stalled.port});
    core.config.set(.{ .database_url = primary_url, .database_read_replica_url = url, .database_query_timeout_ms = 1000 });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var failure: root.Failure = .{};
    const started = std.time.milliTimestamp();
    try testing.expectError(error.ConnectionFailed, svc.query(arena_state.allocator(), "SELECT 1", &.{}, &failure));
    const duration = std.time.milliTimestamp() - started;
    try testing.expect(std.ascii.indexOfIgnoreCase(failure.message, "connection timeout") != null);
    try testing.expect(duration >= 1_000);
    try testing.expect(duration < 3_000);
}

const SchemaFake = struct {
    false_name: ?[]const u8 = null,
    drop: bool = false,
    saw_trigger_query: bool = false,

    fn query(ctx: *anyopaque, _: service.Backend.Which, _: []const u8, arena: std.mem.Allocator, sql: []const u8, _: []const Value, _: ?*root.Failure) root.Error!root.Result {
        const self: *SchemaFake = @ptrCast(@alignCast(ctx));
        if (contains(sql, "tgname = 'gas_payment_stream_cursor_assign'") and contains(sql, "tgenabled IN ('O', 'A')")) self.saw_trigger_query = true;
        return .{ .rows = schemaRow(arena, self.false_name, self.drop) catch return error.OutOfMemory, .row_count = 1 };
    }
};

test "fails startup on false or missing stream schema checks" {
    setTestConfig(true);
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    for (ready_schema) |name| {
        for ([_]bool{ false, true }) |missing| {
            var fake: SchemaFake = .{ .false_name = name, .drop = missing };
            const svc = try DbService.init(testing.allocator, null);
            defer svc.deinit();
            svc.backend = .{ .ctx = &fake, .query = SchemaFake.query };
            var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena_state.deinit();
            var failure: root.Failure = .{};
            try testing.expectError(error.QueryFailed, svc.start(&failure, arena_state.allocator()));
            try testing.expect(contains(failure.message, name));
            try testing.expect(std.mem.startsWith(u8, failure.message, "Event stream schema is not ready: "));
        }
    }
}

test "requires an enabled gas cursor assignment trigger at startup" {
    setTestConfig(false);
    var fake: SchemaFake = .{ .false_name = "cursor_trigger_exists" };
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    svc.backend = .{ .ctx = &fake, .query = SchemaFake.query };
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var failure: root.Failure = .{};
    try testing.expectError(error.QueryFailed, svc.start(&failure, arena_state.allocator()));
    try testing.expect(fake.saw_trigger_query);
    try testing.expectEqualStrings("Event stream schema is not ready: cursor_trigger_exists", failure.message);
}

// ---------------------------------------------------------------------------
// Real PostgreSQL
// ---------------------------------------------------------------------------

fn testUrl() ?[]const u8 {
    return std.posix.getenv("SCRAPER_PROXY_TEST_DATABASE_URL");
}

test "libpq: node-pg row conversion, params and failures" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .statement_timeout_ms = 15_000, .query_timeout_ms = 20_000 }, .max = 2 });
    defer p.deinit();
    var failure: root.Failure = .{};
    const r = try p.query(a,
        \\SELECT 1::int4 AS i, 9007199254740993::int8 AS big, 1.50::numeric AS n,
        \\ 0.1::float8 AS f, 'NaN'::float8 AS nan, true AS b, 'x'::text AS t, NULL::text AS z,
        \\ '{"b": 1, "a": [1, 2.50]}'::jsonb AS j, '\x0102'::bytea AS by,
        \\ '2026-09-14 12:00:00.123456'::timestamp AS ts,
        \\ '2026-09-14 12:00:00.123456+00'::timestamptz AS tz,
        \\ ARRAY[1, NULL, 3]::int4[] AS ia, ARRAY['a', 'b,c', NULL]::text[] AS ta,
        \\ $1::int4 AS p1, $2::text AS p2, $3::text[] AS p3, $4::jsonb AS p4, $5::text AS p5, 7 AS i
    , &.{
        .{ .number = 42 },
        .{ .string = "hé\"" },
        .{ .array = @constCast(&[_]Value{ .{ .string = "a\"b" }, .null }) },
        .{ .object = @constCast(&[_]core.json.Member{.{ .key = "k", .value = .{ .number = 1e21 } }}) },
        .null,
    }, &failure);
    try testing.expectEqual(@as(usize, 1), r.row_count);
    try testing.expectEqualStrings(
        "{\"i\":7,\"big\":\"9007199254740993\",\"n\":\"1.50\",\"f\":0.1,\"nan\":null,\"b\":true,\"t\":\"x\",\"z\":null," ++
            "\"j\":{\"a\":[1,2.5],\"b\":1},\"by\":\"\\\\x0102\",\"ts\":\"2026-09-14 12:00:00.123456\",\"tz\":\"2026-09-14T12:00:00.123Z\"," ++
            "\"ia\":[1,null,3],\"ta\":[\"a\",\"b,c\",null],\"p1\":42,\"p2\":\"hé\\\"\",\"p3\":[\"a\\\"b\",null],\"p4\":{\"k\":1e+21},\"p5\":null}",
        try core.json.stringifyAlloc(a, r.rows[0]),
    );
    const empties = try p.query(a, "SELECT ''::text AS e, NULL::text AS n, ''::varchar AS v FROM generate_series(1, 2)", &.{}, &failure);
    try testing.expectEqualStrings("[{\"e\":\"\",\"n\":null,\"v\":\"\"},{\"e\":\"\",\"n\":null,\"v\":\"\"}]", try core.json.stringifyAlloc(a, .{ .array = empties.rows }));
    try testing.expectError(error.QueryFailed, p.query(a, "SELECT * FROM missing_table", &.{}, &failure));
    try testing.expectEqualStrings("relation \"missing_table\" does not exist", failure.message);
    try testing.expectEqualStrings("42P01", failure.code.?);
    // The connection survives a server error.
    const ok = try p.query(a, "SELECT 2 AS two", &.{}, &failure);
    try testing.expectEqual(@as(f64, 2), ok.rows[0].get("two").?.number);
    // Statement timeout (server side) surfaces the server message.
    const short = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .statement_timeout_ms = 50 }, .max = 1 });
    defer short.deinit();
    try testing.expectError(error.QueryFailed, short.query(a, "SELECT pg_sleep(1)", &.{}, &failure));
    try testing.expectEqualStrings("canceling statement due to statement timeout", failure.message);
    try testing.expectEqualStrings("57014", failure.code.?);
    // Client query timeout.
    const client = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .query_timeout_ms = 100 }, .max = 1 });
    defer client.deinit();
    try testing.expectError(error.QueryTimeout, client.query(a, "SELECT pg_sleep(1)", &.{}, &failure));
    try testing.expectEqualStrings("Query read timeout", failure.message);
    try testing.expectEqual(@as(u32, 0), client.stats().total);
    // bytea[] rows re-bound as params round-trip like node-pg Buffers.
    const ba = try p.query(a, "SELECT ARRAY['\\x01ab'::bytea, NULL] AS b, '\\x02'::bytea AS one", &.{}, &failure);
    const echoed = try p.query(a, "SELECT $1::bytea[] AS b, $2::bytea[] AS again", &.{ ba.rows[0].get("b").?, .{ .array = @constCast(&[_]Value{ba.rows[0].get("b").?.array[0]}) } }, &failure);
    try testing.expectEqualStrings("{\"b\":[{\"type\":\"Buffer\",\"data\":[1,171]},null],\"again\":[{\"type\":\"Buffer\",\"data\":[1,171]}]}", try core.json.stringifyAlloc(a, echoed.rows[0]));
    // UPDATE row counts.
    _ = try p.query(a, "CREATE TEMP TABLE IF NOT EXISTS t_rows (x int)", &.{}, &failure);
}

test "libpq: reusable statements match unnamed ones, evict, and survive result type changes" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .statement_timeout_ms = 15_000 }, .max = 1 });
    defer p.deinit();
    const reuse: pq.QueryOptions = .{ .plan = .reusable };
    var failure: root.Failure = .{};
    const sql = "SELECT $1::int8 + 1 AS n, $2::text AS t, $3::bytea AS b";
    const params = [_]Value{ .{ .number = 41 }, .{ .string = "x" }, .{ .string = "\\x01" } };
    const unnamed = try core.json.stringifyAlloc(a, .{ .array = (try p.query(a, sql, &params, &failure)).rows });
    // Past PostgreSQL's five custom plans, so a generic plan is in use.
    for (0..8) |_| {
        const named = try p.queryWith(a, sql, &params, reuse, &failure);
        try testing.expectEqualStrings(unnamed, try core.json.stringifyAlloc(a, .{ .array = named.rows }));
    }
    const prepared = "SELECT count(*)::int AS n FROM pg_prepared_statements";
    try testing.expectEqual(@as(f64, 1), (try p.query(a, prepared, &.{}, &failure)).rows[0].get("n").?.number);
    // Errors carry the unnamed messages and are not cached.
    try testing.expectError(error.QueryFailed, p.queryWith(a, "SELECT FROM WHERE $1", &.{.{ .number = 1 }}, reuse, &failure));
    try testing.expectEqualStrings("syntax error at or near \"WHERE\"", failure.message);
    try testing.expectError(error.QueryFailed, p.queryWith(a, sql, &.{ .{ .string = "x" }, .null, .null }, reuse, &failure));
    try testing.expectEqualStrings("invalid input syntax for type bigint: \"x\"", failure.message);
    try testing.expectEqual(@as(f64, 1), (try p.query(a, prepared, &.{}, &failure)).rows[0].get("n").?.number);
    // One-off shapes never pay for a Parse round trip.
    for (0..40) |i| {
        const text = try std.fmt.allocPrint(a, "SELECT $1::int AS v{d}", .{i});
        const r = try p.queryWith(a, text, &.{.{ .number = @floatFromInt(i) }}, reuse, &failure);
        try testing.expectEqual(@as(f64, @floatFromInt(i)), r.rows[0].get(text["SELECT $1::int AS ".len..]).?.number);
    }
    try testing.expectEqual(@as(f64, 1), (try p.query(a, prepared, &.{}, &failure)).rows[0].get("n").?.number);
    // Repeated shapes fill the cache; more hot shapes than slots run unnamed
    // instead of thrashing DEALLOCATE/Parse.
    for (0..3) |_| for (0..12) |i| {
        _ = try p.queryWith(a, try std.fmt.allocPrint(a, "SELECT $1::int AS w{d}", .{i}), &.{.{ .number = 1 }}, reuse, &failure);
    };
    try testing.expectEqual(@as(f64, 8), (try p.query(a, prepared, &.{}, &failure)).rows[0].get("n").?.number);
    // Entries idle for a while make room for a new hot shape.
    for (0..70) |i| _ = try p.queryWith(a, try std.fmt.allocPrint(a, "SELECT $1::int AS w{d}", .{i % 3}), &.{.{ .number = 1 }}, reuse, &failure);
    const fresh = "SELECT $1::int AS fresh";
    for (0..2) |_| _ = try p.queryWith(a, fresh, &.{.{ .number = 1 }}, reuse, &failure);
    try testing.expectEqual(@as(f64, 8), (try p.query(a, prepared, &.{}, &failure)).rows[0].get("n").?.number);
    const has_fresh = try p.query(a, "SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement = $1", &.{.{ .string = fresh }}, &failure);
    try testing.expectEqual(@as(f64, 1), has_fresh.rows[0].get("n").?.number);
    // A view whose columns change under a cached statement: node-pg
    // re-parses unnamed statements, so the named path must retry.
    _ = try p.query(a, "CREATE OR REPLACE TEMP VIEW v_reuse AS SELECT 1 AS a", &.{}, &failure);
    const view_sql = "SELECT * FROM v_reuse WHERE $1::int = 1";
    for (0..7) |_| _ = try p.queryWith(a, view_sql, &.{.{ .number = 1 }}, reuse, &failure);
    const has_view = try p.query(a, "SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement = $1", &.{.{ .string = view_sql }}, &failure);
    try testing.expectEqual(@as(f64, 1), has_view.rows[0].get("n").?.number);
    _ = try p.query(a, "DROP VIEW v_reuse", &.{}, &failure);
    _ = try p.query(a, "CREATE TEMP VIEW v_reuse AS SELECT 2 AS a, 'b'::text AS b", &.{}, &failure);
    const changed = try p.queryWith(a, view_sql, &.{.{ .number = 1 }}, reuse, &failure);
    try testing.expectEqualStrings("[{\"a\":2,\"b\":\"b\"}]", try core.json.stringifyAlloc(a, .{ .array = changed.rows }));
    // A statement that vanished server-side (as behind a transaction
    // pooler) is retried unnamed; a second time within the window turns
    // named statements off for the pool, so 26000 never reaches a client.
    const expected_view = "[{\"a\":2,\"b\":\"b\"}]";
    for (0..2) |round| {
        _ = try p.query(a, "DEALLOCATE ALL", &.{}, &failure);
        const again = try p.queryWith(a, view_sql, &.{.{ .number = 1 }}, reuse, &failure);
        try testing.expectEqualStrings(expected_view, try core.json.stringifyAlloc(a, .{ .array = again.rows }));
        try testing.expectEqual(round == 0, p.reuse_guard.active());
        // Prepared again on the next use while still enabled.
        _ = try p.queryWith(a, view_sql, &.{.{ .number = 1 }}, reuse, &failure);
        const expected_count: f64 = if (round == 0) 1 else 0;
        try testing.expectEqual(expected_count, (try p.query(a, prepared, &.{}, &failure)).rows[0].get("n").?.number);
    }
    try testing.expectEqual(@as(u32, 1), p.stats().total);
}

test "libpq: a prepared-statement name collision disables reuse and retries unnamed" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var failure: root.Failure = .{};
    // Another client of a shared backend already owns our next name.
    _ = try p.query(a, "PREPARE sp_1 AS SELECT 1", &.{}, &failure);
    const sql = "SELECT $1::int + 1 AS n";
    for (0..4) |_| {
        const r = try p.queryWith(a, sql, &.{.{ .number = 1 }}, .{ .plan = .reusable }, &failure);
        try testing.expectEqual(@as(f64, 2), r.rows[0].get("n").?.number);
    }
    try testing.expect(!p.reuse_guard.active());
    const names = try p.query(a, "SELECT string_agg(name, ',') AS n FROM pg_prepared_statements", &.{}, &failure);
    try testing.expectEqualStrings("sp_1", names.rows[0].get("n").?.string);
}

test "libpq: the idle reaper runs on a shared scheduler and stops at deinit" {
    const url = testUrl() orelse return error.SkipZigTest;
    var timers = core.scheduler.Scheduler.init(testing.allocator);
    try timers.start();
    defer timers.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 4, .min = 1, .idle_timeout_ms = 50, .scheduler = &timers });
    var conns: [3]pq.Conn = undefined;
    for (&conns) |*c| c.* = try p.acquire(a, null);
    for (conns) |c| p.release(c);
    try testing.expectEqual(@as(u32, 3), p.stats().total);
    var waited: usize = 0;
    while (p.stats().total > 1 and waited < 100) : (waited += 1) std.Thread.sleep(10 * std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, 1), p.stats().total);
    p.deinit();
    // The re-armed timer was cancelled with the pool.
    try testing.expectEqual(@as(usize, 0), timers.pending());
}

test "libpq: socket and pool waits are bracketed by core.blocking" {
    const url = testUrl() orelse return error.SkipZigTest;
    const Counter = struct {
        var begins: usize = 0;
        var ends: usize = 0;
        var depth: isize = 0;
        fn begin(_: *anyopaque) void {
            begins += 1;
            depth += 1;
        }
        fn end(_: *anyopaque) void {
            ends += 1;
            depth -= 1;
        }
    };
    var dummy: u8 = 0;
    core.blocking.hook = .{ .ctx = &dummy, .begin = Counter.begin, .end = Counter.end };
    defer core.blocking.hook = null;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    _ = try p.query(a, "SELECT 1", &.{}, null);
    try testing.expect(Counter.begins > 0);
    try testing.expectEqual(Counter.begins, Counter.ends);
    // A queued acquire (the only connection is checked out) brackets its wait.
    const held = try p.acquire(a, null);
    const Releaser = struct {
        fn run(pool: *pool_mod.Pool, conn: pq.Conn) void {
            std.Thread.sleep(50 * std.time.ns_per_ms);
            pool.release(conn);
        }
    };
    const t = try std.Thread.spawn(.{}, Releaser.run, .{ p, held });
    const before = Counter.begins;
    const again = try p.acquire(a, null);
    t.join();
    try testing.expect(Counter.begins > before);
    try testing.expectEqual(@as(isize, 0), Counter.depth);
    p.release(again);
}

test "libpq: sessions run with jit off unless the URL options say otherwise" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var conn = try pq.Conn.connect(.{ .conninfo = url, .statement_timeout_ms = 1234 }, a, null);
    defer conn.deinit();
    const r = try conn.query(a, "SELECT current_setting('jit') AS jit, current_setting('statement_timeout') AS st", &.{}, null);
    try testing.expectEqualStrings("{\"jit\":\"off\",\"st\":\"1234ms\"}", try core.json.stringifyAlloc(a, r.rows[0]));
    const sep: []const u8 = if (std.mem.indexOfScalar(u8, url, '?') != null) "&" else "?";
    const with_jit = try std.fmt.allocPrint(a, "{s}{s}options=-c%20jit%3Don", .{ url, sep });
    var on = try pq.Conn.connect(.{ .conninfo = with_jit }, a, null);
    defer on.deinit();
    const r2 = try on.query(a, "SELECT current_setting('jit') AS jit", &.{}, null);
    try testing.expectEqualStrings("on", r2.rows[0].get("jit").?.string);
}

test "libpq: custom statements never go generic while reusable ones may, on one session" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var failure: root.Failure = .{};
    const custom_sql = "SELECT $1::int + 1 AS n";
    const reusable_sql = "SELECT $1::int + 2 AS n";
    // Interleaved, so every execution switches plan_cache_mode.
    for (0..12) |i| {
        const x: f64 = @floatFromInt(i);
        const c = try p.queryWith(a, custom_sql, &.{.{ .number = x }}, .{ .plan = .custom }, &failure);
        try testing.expectEqual(x + 1, c.rows[0].get("n").?.number);
        const r = try p.queryWith(a, reusable_sql, &.{.{ .number = x }}, .{ .plan = .reusable }, &failure);
        try testing.expectEqual(x + 2, r.rows[0].get("n").?.number);
    }
    const stats = try p.query(a, "SELECT statement, generic_plans::int AS g, custom_plans::int AS c FROM pg_prepared_statements ORDER BY statement", &.{}, &failure);
    try testing.expectEqual(@as(usize, 2), stats.rows.len);
    for (stats.rows) |row| {
        const generic = row.get("g").?.number;
        if (std.mem.eql(u8, row.get("statement").?.string, custom_sql)) {
            try testing.expectEqual(@as(f64, 0), generic);
            try testing.expectEqual(@as(f64, 11), row.get("c").?.number);
        } else try testing.expect(generic > 0);
    }
    // The session ends up in whichever mode the last statement needed;
    // a failed pipeline (SET rolled back) is re-synchronised next time.
    try testing.expectError(error.QueryFailed, p.queryWith(a, custom_sql, &.{.{ .string = "x" }}, .{ .plan = .custom }, &failure));
    try testing.expectEqualStrings("invalid input syntax for type integer: \"x\"", failure.message);
    const after = try p.queryWith(a, reusable_sql, &.{.{ .number = 1 }}, .{ .plan = .reusable }, &failure);
    try testing.expectEqual(@as(f64, 3), after.rows[0].get("n").?.number);
    const mode = try p.query(a, "SELECT current_setting('plan_cache_mode') AS m", &.{}, &failure);
    try testing.expectEqualStrings("auto", mode.rows[0].get("m").?.string);
}

test "libpq: checkout takes the most recently released idle connection (pg-pool LIFO)" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 3 });
    defer p.deinit();
    var conns: [3]pq.Conn = undefined;
    var pids: [3]f64 = undefined;
    for (&conns, &pids) |*c, *pid| {
        c.* = try p.acquire(a, null);
        pid.* = (try c.query(a, "SELECT pg_backend_pid() AS pid", &.{}, null)).rows[0].get("pid").?.number;
    }
    for (conns) |c| p.release(c);
    // Released 0, 1, 2: a light load keeps hitting backend 2 (hot caches).
    for (0..5) |_| {
        const r = try p.query(a, "SELECT pg_backend_pid() AS pid", &.{}, null);
        try testing.expectEqual(pids[2], r.rows[0].get("pid").?.number);
    }
}

test "libpq: TLS replies and notifications never wait on bytes OpenSSL already holds (opt-in SCRAPER_PROXY_TEST_TLS_URL)" {
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_TLS_URL") orelse return error.SkipZigTest;
    // Both input checks: the exact OpenSSL one and the bounded fallback.
    for ([_]bool{ false, true }) |fallback| {
        pq.forceTlsFallback(fallback);
        defer pq.forceTlsFallback(false);
        // libpq here loads a shared libssl, so the exact check resolves.
        try testing.expectEqual(!fallback, pq.tlsExact());
        try tlsRoundTrips(url);
    }
}

fn tlsRoundTrips(url: []const u8) !void {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .query_timeout_ms = 20_000 }, .max = 1 });
    defer p.deinit();
    var failure: root.Failure = .{};
    const ssl = try p.query(a, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &.{}, &failure);
    try testing.expect(ssl.rows[0].get("ssl").?.bool);
    // Several MB over TLS: completes in about the time of the transfer, not
    // stalled until more TCP data or the query timeout.
    for ([_]f64{ 2000, 8000 }) |n| {
        const started = pq.nowMs();
        const r = try p.query(a, "SELECT g, repeat(md5(g::text), 32) AS pad FROM generate_series(1, $1::int) g", &.{.{ .number = n }}, &failure);
        try testing.expectEqual(@as(usize, @intFromFloat(n)), r.rows.len);
        try testing.expect(pq.nowMs() - started < 3_000);
    }
    // A burst of large NOTIFY payloads arrives promptly over TLS.
    const Counter = struct {
        count: std.atomic.Value(usize) = .init(0),
        fn onNotification(ctx: *anyopaque, _: []const u8, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            _ = self.count.fetchAdd(1, .monotonic);
        }
        fn onDisconnect(_: *anyopaque, _: ?[]const u8) void {}
    };
    var counter: Counter = .{};
    const l = try listener_mod.Listener.start(testing.allocator, .{ .conninfo = url }, &.{"tls_test"}, .{ .ctx = &counter, .on_notification = Counter.onNotification, .on_disconnect = Counter.onDisconnect }, .{}, a, &failure);
    defer l.stop();
    _ = try p.query(a, "SELECT pg_notify('tls_test', repeat('x', 7000) || g) FROM generate_series(1, 20) g", &.{}, &failure);
    const started = pq.nowMs();
    while (counter.count.load(.monotonic) < 20 and pq.nowMs() - started < 2_000) std.Thread.sleep(5 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 20), counter.count.load(.monotonic));
}

test "libpq: TCP connections run with TCP_NODELAY (libpq sets it, like node-pg's noDelay)" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var conn = try pq.Conn.connect(.{ .conninfo = url }, arena_state.allocator(), null);
    defer conn.deinit();
    var value: c_int = 0;
    try std.posix.getsockopt(conn.socket(), std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, std.mem.asBytes(&value));
    try testing.expect(value != 0);
}

test "libpq: the deepest jsonb PostgreSQL returns converts and re-serializes without recursion" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    // PostgreSQL's default max_stack_depth (2 MB) caps jsonb output at about
    // 16k levels; 15k stays below that and far above any native recursion.
    const depth = 15_000;
    const r = try p.query(a, "SELECT (repeat('[', $1::int) || repeat(']', $1::int))::jsonb AS j", &.{.{ .number = depth }}, null);
    const text = try core.json.stringifyAlloc(a, r.rows[0].get("j").?);
    try testing.expectEqual(@as(usize, depth * 2), text.len);
}

test "libpq: pool waiters are served FIFO and capped at max" {
    const url = testUrl() orelse return error.SkipZigTest;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 2 });
    defer p.deinit();
    const Worker = struct {
        fn run(pool: *pool_mod.Pool, errors: *std.atomic.Value(u32)) void {
            var a = std.heap.ArenaAllocator.init(testing.allocator);
            defer a.deinit();
            _ = pool.query(a.allocator(), "SELECT pg_sleep(0.05)", &.{}, null) catch {
                _ = errors.fetchAdd(1, .monotonic);
            };
        }
    };
    var errors: std.atomic.Value(u32) = .init(0);
    var threads: [6]std.Thread = undefined;
    for (&threads) |*t| t.* = try std.Thread.spawn(.{}, Worker.run, .{ p, &errors });
    std.Thread.sleep(20 * std.time.ns_per_ms);
    const mid = p.stats();
    try testing.expect(mid.total <= 2);
    for (threads) |t| t.join();
    try testing.expectEqual(@as(u32, 0), errors.load(.monotonic));
    const end = p.stats();
    try testing.expectEqual(@as(u32, 2), end.total);
    try testing.expectEqual(@as(u32, 2), end.idle);
    try testing.expectEqual(@as(u32, 0), end.waiting);
}

const NotifyCapture = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    payloads: std.ArrayList([]u8) = .empty,
    disconnected: bool = false,
    message: [128]u8 = undefined,
    message_len: usize = 0,
    svc: ?*DbService = null,
    listener: ?*listener_mod.Listener = null,
    unlisten_inside: bool = false,

    fn onNotification(ctx: *anyopaque, channel: []const u8, payload: []const u8) void {
        const self: *NotifyCapture = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        _ = channel;
        self.payloads.append(testing.allocator, testing.allocator.dupe(u8, payload) catch return) catch {};
        self.cond.broadcast();
    }

    fn onDisconnect(ctx: *anyopaque, message: ?[]const u8) void {
        const self: *NotifyCapture = @ptrCast(@alignCast(ctx));
        if (self.unlisten_inside) if (self.svc) |s| s.unlisten(self.listener.?);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.disconnected = true;
        if (message) |m| {
            self.message_len = @min(m.len, self.message.len);
            @memcpy(self.message[0..self.message_len], m[0..self.message_len]);
        }
        self.cond.broadcast();
    }

    fn deinit(self: *NotifyCapture) void {
        for (self.payloads.items) |p| testing.allocator.free(p);
        self.payloads.deinit(testing.allocator);
    }

    fn waitFor(self: *NotifyCapture, comptime cond: fn (*NotifyCapture) bool) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const deadline = std.time.milliTimestamp() + 5_000;
        while (!cond(self)) {
            const remaining = deadline - std.time.milliTimestamp();
            if (remaining <= 0) return error.Timeout;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
    }
};

test "libpq: LISTEN round trip, disconnect and unlisten inside on_disconnect" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var capture: NotifyCapture = .{ .svc = svc, .unlisten_inside = true };
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    const l = try svc.listen(&.{ "scraper_event", "Mixed\"Case" }, .{ .ctx = &capture, .on_notification = NotifyCapture.onNotification, .on_disconnect = NotifyCapture.onDisconnect }, a, &failure);
    capture.listener = l;
    try testing.expectEqual(@as(f64, 1), svc.metricsSnapshot().listeners);
    _ = try svc.queryLive(a, "SELECT pg_notify('scraper_event', 'hello'), pg_notify('Mixed\"Case', '')", &.{}, &failure);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.payloads.items.len == 2;
        }
    }.f);
    try testing.expectEqualStrings("hello", capture.payloads.items[0]);
    try testing.expectEqualStrings("", capture.payloads.items[1]);
    // Kill the listener backend: on_disconnect fires once and unlistens.
    _ = try svc.queryLive(a, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()", &.{}, &failure);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.disconnected;
        }
    }.f);
    try testing.expectEqual(@as(f64, 0), svc.metricsSnapshot().listeners);
}

test "libpq: idle connection killed by the server is replaced and reported" {
    const url = testUrl() orelse return error.SkipZigTest;
    const Hook = struct {
        var count: std.atomic.Value(u32) = .init(0);
        fn call(_: *anyopaque, _: []const u8) void {
            _ = count.fetchAdd(1, .monotonic);
        }
    };
    var dummy: u8 = 0;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1, .on_idle_error = .{ .ctx = &dummy, .func = Hook.call } });
    defer p.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const r = try p.query(a, "SELECT pg_backend_pid() AS pid", &.{}, null);
    const pid = r.rows[0].get("pid").?.number;
    const killer = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer killer.deinit();
    _ = try killer.query(a, "SELECT pg_terminate_backend($1)", &.{.{ .number = pid }}, null);
    std.Thread.sleep(50 * std.time.ns_per_ms);
    const again = try p.query(a, "SELECT 1 AS one", &.{}, null);
    try testing.expectEqual(@as(f64, 1), again.rows[0].get("one").?.number);
    try testing.expectEqual(@as(u32, 1), Hook.count.load(.monotonic));
}

test "libpq: close stops listeners, then the live and main pools" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var capture: NotifyCapture = .{};
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    _ = try svc.listen(&.{"scraper_event"}, .{ .ctx = &capture, .on_notification = NotifyCapture.onNotification, .on_disconnect = NotifyCapture.onDisconnect }, a, &failure);
    _ = try svc.query(a, "SELECT 1", &.{}, &failure);
    _ = try svc.queryLive(a, "SELECT 1", &.{}, &failure);
    const before = svc.metricsSnapshot();
    try testing.expectEqual(@as(f64, 1), before.listeners);
    try testing.expectEqual(@as(f64, 1), before.pools.main.total);
    try testing.expectEqual(@as(f64, 1), before.pools.live.total);
    try svc.close();
    const after = svc.metricsSnapshot();
    try testing.expectEqual(@as(f64, 0), after.listeners);
    try testing.expectEqual(@as(f64, 0), after.pools.main.total);
    // A stopped listener never reports a disconnect.
    try testing.expect(!capture.disconnected);
    // Closing twice is a no-op.
    try svc.close();
}

test "bench: query cpu cost (opt-in DB_BENCH=url, use -Drelease=true)" {
    const url = std.posix.getenv("DB_BENCH") orelse return error.SkipZigTest;
    core.log.setLevel(.@"error");
    core.config.set(.{ .database_url = url });
    const svc = try DbService.init(std.heap.c_allocator, null);
    defer svc.deinit();
    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const sqls = [_][]const u8{
        "SELECT 1",
        "SELECT \"delivery_latency\", \"delivery_occurred_at\", \"destination_tx_hash\", \"id\", \"is_delivered\", \"msg_id\", \"nonce\", \"num_payments\", \"origin_tx_hash\", \"recipient\", \"send_occurred_at\", \"sender\", \"total_payment\" FROM (SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\" WHERE (\"origin_domain_id\" IN (42161, 8453)) ORDER BY \"id\" DESC LIMIT $1",
    };
    for (sqls) |sql| {
        const params = [_]Value{.{ .number = 100 }};
        const p: []const Value = if (std.mem.indexOf(u8, sql, "$1") != null) &params else &.{};
        _ = try svc.query(arena.allocator(), sql, p, null);
        const n: u64 = if (std.posix.getenv("DB_BENCH_N")) |v| std.fmt.parseInt(u64, v, 10) catch 500 else 500;
        const ru0 = std.posix.getrusage(std.posix.rusage.SELF);
        for (0..n) |_| {
            _ = arena.reset(.retain_capacity);
            _ = try svc.query(arena.allocator(), sql, p, null);
        }
        const ru1 = std.posix.getrusage(std.posix.rusage.SELF);
        const us = struct {
            fn f(r: std.posix.rusage) i64 {
                return (r.utime.sec + r.stime.sec) * 1_000_000 + r.utime.usec + r.stime.usec;
            }
        }.f;
        const user = (ru1.utime.sec - ru0.utime.sec) * 1_000_000 + ru1.utime.usec - ru0.utime.usec;
        std.debug.print("{s}: cpu {d} us/q (user {d})\n", .{ sql[0..@min(sql.len, 20)], @divTrunc(us(ru1) - us(ru0), @as(i64, @intCast(n))), @divTrunc(user, @as(i64, @intCast(n))) });
    }
}

// ---------------------------------------------------------------------------
// Regression tests for the review findings (diagnostics' db review)
// ---------------------------------------------------------------------------

test "regression: close waits for in-flight queries, then rejects without recreating pools" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    const Slow = struct {
        fn run(s: *DbService, ok: *std.atomic.Value(bool)) void {
            var a = std.heap.ArenaAllocator.init(testing.allocator);
            defer a.deinit();
            const rows = s.queryLive(a.allocator(), "SELECT pg_sleep(0.3) AS slept, 1 AS one", &.{}, null) catch return;
            ok.store(rows.len == 1, .release);
        }
    };
    var ok: std.atomic.Value(bool) = .init(false);
    const t = try std.Thread.spawn(.{}, Slow.run, .{ svc, &ok });
    std.Thread.sleep(80 * std.time.ns_per_ms);
    const started = std.time.milliTimestamp();
    try svc.close();
    t.join();
    try testing.expect(ok.load(.acquire)); // finished, not freed under it
    try testing.expect(std.time.milliTimestamp() - started >= 150);
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var failure: root.Failure = .{};
    try testing.expectError(error.PoolClosed, svc.query(arena_state.allocator(), "SELECT 1", &.{}, &failure));
    try testing.expectEqualStrings("Cannot use a pool after calling end on the pool", failure.message);
    try testing.expect(svc.main_pool == null and svc.live_pool == null);
    const snap = svc.metricsSnapshot();
    try testing.expectEqual(@as(f64, 0), snap.pools.main.total);
}

test "regression: pool never exceeds max while waiters are handed freed slots" {
    const url = testUrl() orelse return error.SkipZigTest;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var held = try p.acquire(a, null);
    const Waiter = struct {
        fn run(pool: *pool_mod.Pool) void {
            var wa = std.heap.ArenaAllocator.init(testing.allocator);
            defer wa.deinit();
            const conn = pool.acquire(wa.allocator(), null) catch return;
            std.Thread.sleep(100 * std.time.ns_per_ms);
            pool.release(conn);
        }
    };
    const waiter = try std.Thread.spawn(.{}, Waiter.run, .{p});
    while (p.stats().waiting == 0) std.Thread.sleep(std.time.ns_per_ms);
    // Discarding hands the freed slot to the queued waiter; a newcomer that
    // runs before the waiter wakes must queue, not open a second connection.
    held.broken = true;
    p.release(held);
    const newcomer = try p.acquire(a, null);
    try testing.expect(p.stats().total <= 1);
    p.release(newcomer);
    waiter.join();
    try testing.expectEqual(@as(u32, 1), p.stats().total);
}

test "regression: NOTIFY parsed with the LISTEN replies is delivered" {
    const url = testUrl() orelse return error.SkipZigTest;
    var capture: NotifyCapture = .{};
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const l = try listener_mod.Listener.start(testing.allocator, .{ .conninfo = url }, &.{"early_channel"}, .{
        .ctx = &capture,
        .on_notification = NotifyCapture.onNotification,
        .on_disconnect = NotifyCapture.onDisconnect,
        // The SELECT round trip guarantees libpq already parsed the NOTIFY
        // (queued in PQnotifies) before the thread's first poll.
    }, .{ .after_listen_sql = &.{ "NOTIFY early_channel, 'early'", "SELECT 1" } }, arena_state.allocator(), null);
    defer l.stop();
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.payloads.items.len == 1;
        }
    }.f);
    try testing.expectEqualStrings("early", capture.payloads.items[0]);
}

test "regression: a disconnected listener releases its thread and fds before stop()" {
    const url = testUrl() orelse return error.SkipZigTest;
    var capture: NotifyCapture = .{};
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const l = try listener_mod.Listener.start(testing.allocator, .{ .conninfo = url }, &.{"retire_channel"}, .{
        .ctx = &capture,
        .on_notification = NotifyCapture.onNotification,
        .on_disconnect = NotifyCapture.onDisconnect,
    }, .{}, a, null);
    const killer = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer killer.deinit();
    _ = try killer.query(a, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN \"retire_channel\"%'", &.{}, null);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.disconnected;
        }
    }.f);
    var cleaned = false;
    for (0..200) |_| {
        l.mutex.lock();
        cleaned = l.self_cleaned;
        l.mutex.unlock();
        if (cleaned) break;
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    try testing.expect(cleaned);
    l.stop(); // frees the struct only
}

/// Minimal PostgreSQL server: completes startup, then never reads again.
const DeafServer = struct {
    fd: std.posix.socket_t,
    port: u16,
    thread: ?std.Thread = null,
    client: std.posix.socket_t = -1,

    fn start() !*DeafServer {
        const l = try stalledListener();
        const self = try testing.allocator.create(DeafServer);
        self.* = .{ .fd = l.fd, .port = l.port };
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
        return self;
    }

    fn serve(self: *DeafServer) void {
        const c = std.posix.accept(self.fd, null, null, 0) catch return;
        self.client = c;
        var buf: [4096]u8 = undefined;
        _ = std.posix.read(c, &buf) catch return; // StartupMessage
        // AuthenticationOk, ReadyForQuery(idle). Then stop reading.
        const reply = [_]u8{ 'R', 0, 0, 0, 8, 0, 0, 0, 0, 'Z', 0, 0, 0, 5, 'I' };
        _ = std.posix.write(c, &reply) catch {};
    }

    fn stop(self: *DeafServer) void {
        if (self.thread) |t| t.join();
        if (self.client >= 0) std.posix.close(self.client);
        std.posix.close(self.fd);
        testing.allocator.destroy(self);
    }
};

test "regression: query_timeout also bounds sending to a server that stopped reading" {
    const server = try DeafServer.start();
    defer server.stop();
    var url_buf: [128]u8 = undefined;
    const url = try std.fmt.bufPrint(&url_buf, "host=127.0.0.1 port={d} user=u dbname=x sslmode=disable gssencmode=disable", .{server.port});
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    var conn = try pq.Conn.connect(.{ .conninfo = url, .query_timeout_ms = 300 }, a, &failure);
    defer conn.deinit();
    // Far more than the socket buffers hold.
    const big = try a.alloc(u8, 64 * 1024 * 1024);
    @memset(big, 'x');
    const started = std.time.milliTimestamp();
    try testing.expectError(error.QueryTimeout, conn.query(a, "SELECT $1::text", &.{.{ .string = big }}, &failure));
    try testing.expect(std.time.milliTimestamp() - started < 2_000);
    try testing.expectEqualStrings("Query read timeout", failure.message);
    try testing.expect(!conn.ok());
}

test "regression: allocation failure mid-result discards the connection" {
    const url = testUrl() orelse return error.SkipZigTest;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var warm = std.heap.ArenaAllocator.init(testing.allocator);
    defer warm.deinit();
    _ = try p.query(warm.allocator(), "SELECT 1", &.{}, null);
    // Fails during row conversion (after the send succeeded).
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    // Every allocation counts: allocation #9 is the second text chunk (mid-conversion).
    var failing = std.testing.FailingAllocator.init(arena_state.allocator(), .{ .fail_index = 9 });
    try testing.expectError(error.OutOfMemory, p.query(failing.allocator(), "SELECT g, g::text AS t FROM generate_series(1, 5000) g", &.{}, null));
    try testing.expectEqual(@as(u32, 0), p.stats().total);
    // The pool still works with a fresh connection.
    const again = try p.query(warm.allocator(), "SELECT 2 AS two", &.{}, null);
    try testing.expectEqual(@as(f64, 2), again.rows[0].get("two").?.number);
}

test "regression: a queued request's connect timeout counts its queue time" {
    const stalled = try stalledListener();
    defer std.posix.close(stalled.fd);
    var url_buf: [128]u8 = undefined;
    const url = try std.fmt.bufPrint(&url_buf, "postgresql://u:p@127.0.0.1:{d}/x?sslmode=disable", .{stalled.port});
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .connect_timeout_ms = 500 }, .max = 1 });
    defer p.deinit();
    const Attempt = struct {
        fn run(pool: *pool_mod.Pool, elapsed: *i64, message: *[96]u8) void {
            var a = std.heap.ArenaAllocator.init(testing.allocator);
            defer a.deinit();
            var failure: root.Failure = .{};
            const t0 = std.time.milliTimestamp();
            _ = pool.query(a.allocator(), "SELECT 1", &.{}, &failure) catch {};
            elapsed.* = std.time.milliTimestamp() - t0;
            const n = @min(failure.message.len, message.len);
            @memcpy(message[0..n], failure.message[0..n]);
        }
    };
    var e1: i64 = 0;
    var e2: i64 = 0;
    var m1: [96]u8 = @splat(0);
    var m2: [96]u8 = @splat(0);
    const t1 = try std.Thread.spawn(.{}, Attempt.run, .{ p, &e1, &m1 });
    std.Thread.sleep(100 * std.time.ns_per_ms);
    const t2 = try std.Thread.spawn(.{}, Attempt.run, .{ p, &e2, &m2 });
    t1.join();
    t2.join();
    try testing.expect(std.mem.startsWith(u8, &m1, "Connection terminated due to connection timeout"));
    try testing.expect(std.mem.startsWith(u8, &m2, "timeout exceeded when trying to connect"));
    try testing.expect(e2 < 800); // not queue wait + a fresh 500ms connect
}

test "libpq: start warms five primary connections concurrently" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var failure: root.Failure = .{};
    svc.start(&failure, arena_state.allocator()) catch |e| {
        // The disposable test DB may lack the event-stream schema objects.
        if (std.mem.startsWith(u8, failure.message, "Event stream schema is not ready")) return error.SkipZigTest;
        return e;
    };
    const snap = svc.metricsSnapshot();
    try testing.expectEqual(@as(f64, 5), snap.pools.main.total);
    try testing.expectEqual(@as(f64, 5), snap.pools.main.idle);
}

test "libpq: TLS is only negotiated when the URL asks for it (node-pg)" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    var plain = try pq.Conn.connect(.{ .conninfo = url }, a, &failure);
    const r = try plain.query(a, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", &.{}, &failure);
    plain.deinit();
    try testing.expect(!r.rows[0].get("ssl").?.bool);
    // An explicit sslmode is honoured (the test server has no TLS).
    const sep: []const u8 = if (std.mem.indexOfScalar(u8, url, '?') != null) "&" else "?";
    const required = try std.fmt.allocPrint(a, "{s}{s}sslmode=require", .{ url, sep });
    try testing.expectError(error.ConnectionFailed, pq.Conn.connect(.{ .conninfo = required }, a, &failure));
}

// ---------------------------------------------------------------------------
// Stress: bursts above max, idle past the reaper timeout, discards, server
// kills, listener reconnects and a racing close. Cycles: DB_STRESS_CYCLES.
// ---------------------------------------------------------------------------

const Stress = struct {
    pool: *pool_mod.Pool,
    url: []const u8,
    stop: std.atomic.Value(bool) = .init(false),
    queries: std.atomic.Value(u64) = .init(0),
    errors: std.atomic.Value(u64) = .init(0),
    max_total: std.atomic.Value(u32) = .init(0),
    reconnects: std.atomic.Value(u64) = .init(0),
    unexpected: std.atomic.Value(bool) = .init(false),

    fn burstWorker(self: *Stress, seed: u64) void {
        var prng = std.Random.DefaultPrng.init(seed);
        const r = prng.random();
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        for (0..4) |_| {
            _ = arena.reset(.retain_capacity);
            const a = arena.allocator();
            var conn = self.pool.acquire(a, null) catch {
                _ = self.errors.fetchAdd(1, .monotonic);
                return;
            };
            _ = self.max_total.fetchMax(self.pool.stats().total, .monotonic);
            const sql = if (r.boolean()) "SELECT pg_sleep(0.005), g FROM generate_series(1, 50) g" else "SELECT 1";
            var failure: root.Failure = .{};
            _ = conn.query(a, sql, &.{}, &failure) catch {
                _ = self.errors.fetchAdd(1, .monotonic);
                // Only the test's own kills (racing a reuse) may fail queries.
                if (!std.mem.eql(u8, failure.message, "terminating connection due to administrator command") and
                    !std.mem.eql(u8, failure.message, "Connection terminated unexpectedly"))
                {
                    std.debug.print("unexpected query failure: {s}\n", .{failure.message});
                    self.unexpected.store(true, .release);
                }
            };
            _ = self.queries.fetchAdd(1, .monotonic);
            switch (r.uintLessThan(u8, 10)) {
                0 => conn.broken = true, // discard path
                1 => {
                    // Server-side kill while idle: detected at the next checkout.
                    var k = std.heap.ArenaAllocator.init(testing.allocator);
                    defer k.deinit();
                    const pid = conn.query(k.allocator(), "SELECT pg_backend_pid() AS pid", &.{}, null) catch null;
                    self.pool.release(conn);
                    if (pid) |res| {
                        var killer = pq.Conn.connect(.{ .conninfo = self.url }, k.allocator(), null) catch return;
                        defer killer.deinit();
                        _ = killer.query(k.allocator(), "SELECT pg_terminate_backend($1)", &.{res.rows[0].get("pid").?}, null) catch {};
                    }
                    continue;
                },
                else => {},
            }
            self.pool.release(conn);
        }
    }

    fn listenerChurn(self: *Stress) void {
        const Noop = struct {
            fn n(_: *anyopaque, _: []const u8, _: []const u8) void {}
            fn d(_: *anyopaque, _: ?[]const u8) void {}
        };
        var dummy: u8 = 0;
        while (!self.stop.load(.acquire)) {
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            const l = listener_mod.Listener.start(testing.allocator, .{ .conninfo = self.url }, &.{"stress_channel"}, .{
                .ctx = &dummy,
                .on_notification = Noop.n,
                .on_disconnect = Noop.d,
            }, .{}, arena.allocator(), null) catch continue;
            // Half the time the server kills it (disconnect path), half stop().
            if (self.reconnects.fetchAdd(1, .monotonic) % 2 == 0) {
                var killer = pq.Conn.connect(.{ .conninfo = self.url }, arena.allocator(), null) catch {
                    l.stop();
                    continue;
                };
                _ = killer.query(arena.allocator(), "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN \"stress_channel\"%'", &.{}, null) catch {};
                killer.deinit();
                std.Thread.sleep(5 * std.time.ns_per_ms);
            }
            l.stop();
        }
    }
};

test "stress: pool reaper vs bursts, discards, kills, listener churn and close" {
    const url = testUrl() orelse return error.SkipZigTest;
    const cycles: usize = if (std.posix.getenv("DB_STRESS_CYCLES")) |c| std.fmt.parseInt(usize, c, 10) catch 12 else 12;
    for (0..2) |round| {
        _ = round;
        const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 10, .min = 5, .idle_timeout_ms = 40 });
        var stress: Stress = .{ .pool = p, .url = url };
        const churn = try std.Thread.spawn(.{}, Stress.listenerChurn, .{&stress});
        for (0..cycles) |cycle| {
            var workers: [24]std.Thread = undefined;
            for (&workers, 0..) |*w, i| w.* = try std.Thread.spawn(.{}, Stress.burstWorker, .{ &stress, cycle * 100 + i });
            for (workers) |w| w.join();
            // Idle past the reaper timeout, with a trickle racing the reap.
            const trickle = try std.Thread.spawn(.{}, Stress.burstWorker, .{ &stress, cycle * 100 + 99 });
            std.Thread.sleep(@as(u64, 30 + (cycle % 4) * 20) * std.time.ns_per_ms);
            trickle.join();
            const st = p.stats();
            try testing.expect(st.total <= 10);
            try testing.expectEqual(@as(u32, 0), st.waiting);
        }
        // Raw pools have no admission control: deinit only after users are
        // done (DbService provides the guarded close; raced below).
        p.deinit();
        stress.stop.store(true, .release);
        churn.join();
        try testing.expect(stress.max_total.load(.monotonic) <= 10);
        try testing.expect(!stress.unexpected.load(.acquire));
        std.debug.print("stress pool: {d} queries, {d} errors, {d} listener cycles\n", .{ stress.queries.load(.monotonic), stress.errors.load(.monotonic), stress.reconnects.load(.monotonic) });
    }
}

test "stress: DbService close races in-flight queries, listens and metrics" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const cycles: usize = if (std.posix.getenv("DB_STRESS_CYCLES")) |c| std.fmt.parseInt(usize, c, 10) catch 12 else 12;
    core.config.set(.{ .database_url = url });
    const Worker = struct {
        fn run(svc: *DbService, live: bool) void {
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            for (0..50) |_| {
                _ = arena.reset(.retain_capacity);
                const r = if (live) svc.queryLive(arena.allocator(), "SELECT pg_sleep(0.002)", &.{}, null) else svc.query(arena.allocator(), "SELECT 1", &.{}, null);
                _ = r catch |e| if (e == error.PoolClosed) return;
                _ = svc.metricsSnapshot();
            }
        }
        fn listen(svc: *DbService) void {
            const Noop = struct {
                fn n(_: *anyopaque, _: []const u8, _: []const u8) void {}
                fn d(_: *anyopaque, _: ?[]const u8) void {}
            };
            var dummy: u8 = 0;
            for (0..20) |_| {
                var arena = std.heap.ArenaAllocator.init(testing.allocator);
                defer arena.deinit();
                const l = svc.listen(&.{"stress_service"}, .{ .ctx = &dummy, .on_notification = Noop.n, .on_disconnect = Noop.d }, arena.allocator(), null) catch return;
                svc.unlisten(l);
            }
        }
    };
    for (0..cycles) |cycle| {
        const svc = try DbService.init(testing.allocator, null);
        var threads: [9]std.Thread = undefined;
        for (threads[0..8], 0..) |*t, i| t.* = try std.Thread.spawn(.{}, Worker.run, .{ svc, i % 2 == 0 });
        threads[8] = try std.Thread.spawn(.{}, Worker.listen, .{svc});
        std.Thread.sleep(@as(u64, 5 + (cycle % 5) * 10) * std.time.ns_per_ms);
        try svc.close();
        for (threads) |t| t.join();
        try testing.expect(!svc.leaked);
        svc.deinit();
    }
}
