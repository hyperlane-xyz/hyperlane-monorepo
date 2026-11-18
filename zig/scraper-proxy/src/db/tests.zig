//! Port of `src/db/db.service.test.ts` plus libpq integration tests.
//! Mock-driven TS scenarios use `DbService.backend`; tests needing a real
//! server read SCRAPER_PROXY_TEST_DATABASE_URL (skipped when unset).
const std = @import("std");
const builtin = @import("builtin");
const core = @import("core");
const root = @import("root.zig");
const service = @import("service.zig");
const pq = @import("pq.zig");
const convert = @import("convert.zig");
const pool_mod = @import("pool.zig");
const listener_mod = @import("listener.zig");

const testing = std.testing;
const Value = core.json.Value;
const DbService = service.DbService;

const primary_url = "postgresql://scraper-proxy-test";
const replica_url = "postgresql://scraper-proxy-replica-test";

const ready_schema = [_][]const u8{ "scraper_head_exists", "scraper_head_readable" };

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
    var infos: std.ArrayList([]u8) = .empty;

    fn sink(_: ?*anyopaque, level: core.log.Level, _: []const u8, msg: []const u8) void {
        mutex.lock();
        defer mutex.unlock();
        switch (level) {
            .warn => warnings.append(testing.allocator, testing.allocator.dupe(u8, msg) catch return) catch {},
            .debug => debugs += 1,
            .info => infos.append(testing.allocator, testing.allocator.dupe(u8, msg) catch return) catch {},
            else => {},
        }
    }

    fn reset() void {
        for (warnings.items) |w| testing.allocator.free(w);
        warnings.clearAndFree(testing.allocator);
        for (infos.items) |i| testing.allocator.free(i);
        infos.clearAndFree(testing.allocator);
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
    const before_validator = M.database_queries.get(.{ "success", "validator_primary" });
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
    const validator_rows = try svc.queryValidator(arena, "SELECT validator", &.{}, null);
    try testing.expectEqualStrings("[{\"ready\":1}]", try core.json.stringifyAlloc(arena, .{ .array = validator_rows }));
    try testing.expectEqualStrings(primary_url, fake.urls.get("SELECT validator").?);
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
    try testing.expectEqual(before_validator + 1, M.database_queries.get(.{ "success", "validator_primary" }));
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

test "bounds the validator pool and times out queued acquisition independently of the live pool" {
    const stalled = try stalledListener();
    defer std.posix.close(stalled.fd);
    var url_buf: [128]u8 = undefined;
    const url = try std.fmt.bufPrint(&url_buf, "postgresql://u:p@127.0.0.1:{d}/x", .{stalled.port});
    // The connects time out after 3 s: the snapshot below must see all six
    // queries started first, however slowly the threads get going.
    core.config.set(.{ .database_url = url, .database_query_timeout_ms = 3000 });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    // Before first use the pool is reported at its limit, empty (TS).
    const empty = svc.metricsSnapshot().pools.validator;
    try testing.expectEqual(@as(f64, 5), empty.limit);
    try testing.expectEqual(@as(f64, 0), empty.total);
    const Query = struct {
        message: [96]u8 = @splat(0),
        err: ?anyerror = null,
        fn run(s: *DbService, q: *@This()) void {
            var a = std.heap.ArenaAllocator.init(testing.allocator);
            defer a.deinit();
            var failure: root.Failure = .{};
            _ = s.queryValidator(a.allocator(), "SELECT 1", &.{}, &failure) catch |e| {
                q.err = e;
                const n = @min(failure.message.len, q.message.len);
                @memcpy(q.message[0..n], failure.message[0..n]);
            };
        }
    };
    var queries: [6]Query = @splat(.{});
    var threads: [6]std.Thread = undefined;
    for (&threads, &queries) |*t, *q| t.* = try std.Thread.spawn(.{}, Query.run, .{ svc, q });
    // Five connecting, one queued; the live pool is untouched.
    var snap = svc.metricsSnapshot();
    const until = deadlineAfter(2_500);
    while ((snap.pools.validator.total < 5 or snap.pools.validator.waiting < 1) and std.time.milliTimestamp() < until) {
        std.Thread.sleep(std.time.ns_per_ms);
        snap = svc.metricsSnapshot();
    }
    try testing.expectEqual(@as(f64, 5), snap.pools.validator.limit);
    try testing.expectEqual(@as(f64, 5), snap.pools.validator.total);
    try testing.expectEqual(@as(f64, 1), snap.pools.validator.waiting);
    try testing.expectEqual(@as(f64, 0), snap.pools.live.total);
    for (threads) |t| t.join();
    for (queries) |q| {
        try testing.expectEqual(@as(?anyerror, error.ConnectionFailed), q.err);
        try testing.expect(std.ascii.indexOfIgnoreCase(&q.message, "timeout") != null);
    }
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

    fn query(ctx: *anyopaque, _: service.Backend.Which, _: []const u8, arena: std.mem.Allocator, _: []const u8, _: []const Value, _: ?*root.Failure) root.Error!root.Result {
        const self: *SchemaFake = @ptrCast(@alignCast(ctx));
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

// ---------------------------------------------------------------------------
// Real PostgreSQL
// ---------------------------------------------------------------------------

/// Wall-clock bound for test waits on another thread's progress (a loaded
/// machine can stall a thread for well over a second).
const wait_bound_ms = 5_000;

fn deadlineAfter(ms: i64) i64 {
    return std.time.milliTimestamp() + ms;
}

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

test "libpq: NUL and lone-surrogate parameters reach PostgreSQL as node-pg sends them (every plan)" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const S = struct {
        fn str(text: []const u8) Value {
            return .{ .string = text };
        }
    };
    const nul_error = "22021 invalid byte sequence for encoding \"UTF8\": 0x00";
    // Expected outcomes: node-pg 8.23 on PostgreSQL 16 and 12 (szig-scratch/db-nul/truth.js).
    const Case = struct { sql: []const u8, params: []const Value, want: []const u8 };
    const cases = [_]Case{
        .{ .sql = "SELECT $1::text AS v", .params = &.{S.str("ab\x00cd")}, .want = nul_error },
        .{ .sql = "SELECT $1::bigint AS v", .params = &.{S.str("\x00")}, .want = nul_error },
        .{ .sql = "SELECT $1::bytea AS v", .params = &.{S.str("\x00")}, .want = nul_error },
        .{ .sql = "SELECT $1::bytea[] AS v", .params = &.{.{ .array = @constCast(&[_]Value{S.str("\x00")}) }}, .want = nul_error },
        .{ .sql = "SELECT $1::int8[] AS v", .params = &.{.{ .array = @constCast(&[_]Value{ S.str("1"), S.str("x\x00") }) }}, .want = nul_error },
        .{ .sql = "SELECT 'abc' LIKE $1 AS v", .params = &.{S.str("a\x00%")}, .want = nul_error },
        // PostgreSQL reads parameters in order: an earlier one's own error wins.
        .{ .sql = "SELECT $1::bigint AS v, $2::text AS w", .params = &.{ S.str("x"), S.str("\x00") }, .want = "22P02 invalid input syntax for type bigint: \"x\"" },
        .{ .sql = "SELECT $1::text AS v, $2::bigint AS w", .params = &.{ S.str("\x00"), S.str("x") }, .want = nul_error },
        .{ .sql = "SELECT 1 AS v WHERE $1::text IS NOT NULL OR true", .params = &.{S.str("\x00")}, .want = nul_error },
        // Lone surrogates (WTF-8) bind as U+FFFD, a split pair as its code point.
        .{ .sql = "SELECT $1::text AS v", .params = &.{S.str("\xed\xa0\x80")}, .want = "\"\u{fffd}\"" },
        .{ .sql = "SELECT $1::text[] AS v", .params = &.{.{ .array = @constCast(&[_]Value{ S.str("a\xed\xb0\x80"), S.str("b") }) }}, .want = "[\"a\u{fffd}\",\"b\"]" },
        .{ .sql = "SELECT $1::text AS v", .params = &.{S.str("\xed\xa0\xbd\xed\xb8\x80")}, .want = "\"\u{1f600}\"" },
        .{ .sql = "SELECT $1::text AS v", .params = &.{S.str("\xed\xa0\x80\x00")}, .want = nul_error },
        // Objects go as JSON text: a NUL is the escape `\u0000`, never cut.
        .{ .sql = "SELECT $1::jsonb AS v", .params = &.{.{ .object = @constCast(&[_]core.json.Member{.{ .key = "k", .value = S.str("\x00") }}) }}, .want = "22P05 unsupported Unicode escape sequence" },
        .{ .sql = "SELECT $1::text AS v", .params = &.{.{ .object = @constCast(&[_]core.json.Member{.{ .key = "k", .value = S.str("\x00") }}) }}, .want = "\"{\\\"k\\\":\\\"\\\\u0000\\\"}\"" },
    };
    // Unnamed, named (prepared on the second run, then reused; generic too),
    // and pipelined after a transaction-scoped setting (fixed_join, serial,
    // serial_generic): a Bind failure mid-pipeline surfaces as exactly that
    // error and leaves the connection clean for the next query. A text keeps
    // one plan per session (`Statements` classes), so each plan gets its own pool.
    for ([_]pq.Plan{ .unnamed, .custom, .reusable, .generic, .fixed_join, .serial, .serial_generic }) |plan| {
        const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
        defer p.deinit();
        for (cases) |c| {
            for (0..3) |_| {
                var failure: root.Failure = .{};
                const got = if (p.queryWith(a, c.sql, c.params, .{ .plan = plan }, &failure)) |r|
                    try core.json.stringifyAlloc(a, r.rows[0].get("v").?)
                else |e| blk: {
                    try testing.expectEqual(error.QueryFailed, e);
                    break :blk try std.fmt.allocPrint(a, "{s} {s}", .{ failure.code.?, failure.message });
                };
                testing.expectEqualStrings(c.want, got) catch |e| {
                    std.debug.print("plan {s}: {s}\n", .{ @tagName(plan), c.sql });
                    return e;
                };
                // The same connection serves the next query, outside any pipeline.
                var next: root.Failure = .{};
                try testing.expectEqual(@as(f64, 7), (try p.queryWith(a, "SELECT 7 AS seven WHERE $1::int = 1", &.{.{ .number = 1 }}, .{ .plan = plan }, &next)).rows[0].get("seven").?.number);
                try testing.expectEqual(@as(u32, 1), p.stats().total);
            }
        }
        // The connection stayed usable throughout.
        var failure: root.Failure = .{};
        try testing.expectEqual(@as(f64, 2), (try p.query(a, "SELECT 2 AS two", &.{}, &failure)).rows[0].get("two").?.number);
        try testing.expectEqual(@as(u32, 1), p.stats().total);
    }
}

test "libpq: a NUL parameter's failed-query line reads like TS's (0x00, escaped values)" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    LogCapture.reset();
    // Lone surrogates log as JSON.stringify escapes them (`\udxxx`).
    try testing.expectError(error.QueryFailed, svc.query(a, "SELECT $1::bigint AS v,\n  $2::text[] AS w, $3::text AS x, $4::text AS y", &.{
        .{ .string = "1\x00" },
        .{ .array = @constCast(&[_]Value{.{ .string = "\xed\xa0\x80" }}) },
        .{ .string = "\xed\xb0\x80x" },
        .{ .string = "\u{1f600}" },
    }, &failure));
    LogCapture.mutex.lock();
    defer LogCapture.mutex.unlock();
    try testing.expectEqual(@as(usize, 1), LogCapture.warnings.items.len);
    const line = LogCapture.warnings.items[0];
    // TS: `query failed id=… role=primary durationMs=… error=${formatError(error)} sql=… values=${json(values)}`.
    try testing.expect(std.mem.startsWith(u8, line, "query failed id="));
    try testing.expectEqualStrings(" error=invalid byte sequence for encoding \"UTF8\": 0x00 sql=SELECT $1::bigint AS v, $2::text[] AS w, $3::text AS x, $4::text AS y values=[\"1\\u0000\",[\"\\ud800\"],\"\\udc00x\",\"\u{1f600}\"]", line[std.mem.indexOf(u8, line, " error=").?..]);
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

test "libpq: fixed_join and serial statements set their planner setting for themselves only (transaction-scoped)" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var failure: root.Failure = .{};
    const settings = "current_setting('join_collapse_limit') || '/' || current_setting('max_parallel_workers_per_gather') AS v";
    const sql = "SELECT " ++ settings ++ " WHERE $1::int = 1";
    const one = [_]Value{.{ .number = 1 }};
    const Check = struct {
        fn expect(want: []const u8, r: root.Result) !void {
            try testing.expectEqualStrings(want, r.rows[0].get("v").?.string);
        }
    };
    const start = try a.dupe(u8, (try p.query(a, sql, &one, &failure)).rows[0].get("v").?.string);
    var parts = std.mem.splitScalar(u8, start, '/');
    const join_default = parts.first();
    const workers_default = parts.next().?;
    try testing.expect(!std.mem.eql(u8, join_default, "1") and !std.mem.eql(u8, workers_default, "0"));
    const fixed_want = try std.fmt.allocPrint(a, "1/{s}", .{workers_default});
    const serial_want = try std.fmt.allocPrint(a, "{s}/0", .{join_default});
    const fixed: pq.QueryOptions = .{ .plan = .fixed_join };
    const serial: pq.QueryOptions = .{ .plan = .serial };
    const notices_before = pq.test_notices.load(.monotonic);
    // Each statement sees its own setting; the next one, of any kind, the
    // session's (nothing to reset: the setting ends with the pipeline).
    for (0..2) |_| {
        try Check.expect(fixed_want, try p.queryWith(a, sql, &one, fixed, &failure));
        try Check.expect(start, try p.query(a, sql, &one, &failure));
        try Check.expect(serial_want, try p.queryWith(a, sql, &one, serial, &failure));
        try Check.expect(start, try p.query(a, "SELECT " ++ settings, &.{}, &failure));
        try Check.expect(fixed_want, try p.queryWith(a, sql, &one, fixed, &failure));
        try Check.expect(serial_want, try p.queryWith(a, sql, &one, serial, &failure));
        for (0..3) |_| try Check.expect(start, try p.queryWith(a, sql, &one, .{ .plan = .reusable }, &failure));
    }
    // Lazy results read the same.
    const lazy_result = try p.queryWith(a, sql, &one, .{ .plan = .fixed_join, .lazy = true }, &failure);
    const lazy = lazy_result.lazy.?;
    defer lazy.deinit();
    try testing.expectEqualStrings(fixed_want, lazy.cell(0, 0).?);
    // A failing execute after the SET LOCAL: the plain statement's error,
    // and the setting is gone with the failed transaction.
    const failing = "SELECT 1 / ($1::int - 1) AS x";
    try testing.expectError(error.QueryFailed, p.query(a, failing, &one, &failure));
    const plain_message = try a.dupe(u8, failure.message);
    for ([_]pq.QueryOptions{ fixed, serial }) |opts| {
        try testing.expectError(error.QueryFailed, p.queryWith(a, failing, &one, opts, &failure));
        try testing.expectEqualStrings(plain_message, failure.message);
        try Check.expect(start, try p.query(a, sql, &one, &failure));
    }
    // No notice reached the client (a SET LOCAL would warn "can only be
    // used in transaction blocks" on every statement).
    try testing.expectEqual(notices_before, pq.test_notices.load(.monotonic));
    // Nothing depends on named statements (a transaction pooler gets the
    // same transaction-scoped setting).
    p.reuse_guard.disabled.store(true, .monotonic);
    try Check.expect(fixed_want, try p.queryWith(a, sql, &one, fixed, &failure));
    try Check.expect(start, try p.query(a, sql, &one, &failure));
    try testing.expectEqual(@as(u32, 1), p.stats().total);
}

test "libpq: serial_generic reuses a generic plan built and chosen without parallel workers; serial never runs it" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var failure: root.Failure = .{};
    const sql = "SELECT current_setting('plan_cache_mode') || '/' || current_setting('max_parallel_workers_per_gather') AS v WHERE $1::int = 1";
    const one = [_]Value{.{ .number = 1 }};
    const Check = struct {
        fn expect(want: []const u8, r: root.Result) !void {
            try testing.expectEqualStrings(want, r.rows[0].get("v").?.string);
        }
    };
    const session = try a.dupe(u8, (try p.query(a, sql, &one, &failure)).rows[0].get("v").?.string);
    const session_mode = session[0..std.mem.indexOfScalar(u8, session, '/').?];
    const generic: pq.QueryOptions = .{ .plan = .serial_generic };
    const notices_before = pq.test_notices.load(.monotonic);
    // First use runs unnamed, planned for its values (serial).
    try Check.expect(try std.fmt.allocPrint(a, "{s}/0", .{session_mode}), try p.queryWith(a, sql, &one, generic, &failure));
    // From the second use (Parse in the same pipeline) on: both settings
    // are in force for the statement's Parse and Bind.
    for (0..4) |_| try Check.expect("force_generic_plan/0", try p.queryWith(a, sql, &one, generic, &failure));
    // Nothing outlives the statement.
    try Check.expect(session, try p.query(a, sql, &one, &failure));
    const counts_sql = "SELECT generic_plans::int AS g, custom_plans::int AS c FROM pg_prepared_statements WHERE statement = $1";
    const counts = struct {
        fn get(pool: *pool_mod.Pool, al: std.mem.Allocator, text: []const u8, f: *root.Failure, q: []const u8) ![2]f64 {
            const rows = (try pool.query(al, q, &.{.{ .string = text }}, f)).rows;
            try testing.expectEqual(@as(usize, 1), rows.len);
            return .{ rows[0].get("g").?.number, rows[0].get("c").?.number };
        }
    }.get;
    // pg_prepared_statements counts plans from PostgreSQL 14 on.
    const version = (try p.query(a, "SELECT current_setting('server_version_num')::int AS v", &.{}, &failure)).rows[0].get("v").?.number;
    const counted = version >= 140000;
    // Every named execution used the generic plan.
    if (counted) try testing.expectEqual([2]f64{ 4, 0 }, try counts(p, a, sql, &failure, counts_sql));
    // The large-set path (`serial`) runs unnamed: the named statement and
    // its generic plan are never executed.
    for (0..3) |_| try Check.expect(try std.fmt.allocPrint(a, "{s}/0", .{session_mode}), try p.queryWith(a, sql, &one, .{ .plan = .serial }, &failure));
    if (counted) try testing.expectEqual([2]f64{ 4, 0 }, try counts(p, a, sql, &failure, counts_sql));
    try Check.expect("force_generic_plan/0", try p.queryWith(a, sql, &one, generic, &failure));
    if (counted) try testing.expectEqual([2]f64{ 5, 0 }, try counts(p, a, sql, &failure, counts_sql));
    // A failing execute: the plain error text, and nothing persists.
    const failing = "SELECT 1 / ($1::int - 1) AS x";
    try testing.expectError(error.QueryFailed, p.query(a, failing, &one, &failure));
    const plain_message = try a.dupe(u8, failure.message);
    for (0..3) |_| {
        try testing.expectError(error.QueryFailed, p.queryWith(a, failing, &one, generic, &failure));
        try testing.expectEqualStrings(plain_message, failure.message);
    }
    try Check.expect(session, try p.query(a, sql, &one, &failure));
    try testing.expectEqual(notices_before, pq.test_notices.load(.monotonic));
    // Named statements off (a transaction pooler): unnamed and serial.
    p.reuse_guard.disabled.store(true, .monotonic);
    try Check.expect(try std.fmt.allocPrint(a, "{s}/0", .{session_mode}), try p.queryWith(a, sql, &one, generic, &failure));
    try Check.expect(session, try p.query(a, sql, &one, &failure));
    try testing.expectEqual(@as(u32, 1), p.stats().total);
}

test "libpq: generic statements always reuse their generic plan; projections keep slots of their own" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var failure: root.Failure = .{};
    const one = [_]Value{.{ .number = 1 }};
    const settings = "SELECT current_setting('plan_cache_mode') || '/' || current_setting('max_parallel_workers_per_gather') AS v WHERE $1::int = 1";
    const session = try a.dupe(u8, (try p.query(a, settings, &one, &failure)).rows[0].get("v").?.string);
    const slash = std.mem.indexOfScalar(u8, session, '/').?;
    const generic: pq.QueryOptions = .{ .plan = .generic };
    // First use unnamed (planned for its values), then named and forced
    // generic for its own transaction only; parallel workers untouched.
    try testing.expectEqualStrings(session, (try p.queryWith(a, settings, &one, generic, &failure)).rows[0].get("v").?.string);
    for (0..3) |_| try testing.expectEqualStrings(try std.fmt.allocPrint(a, "force_generic_plan{s}", .{session[slash..]}), (try p.queryWith(a, settings, &one, generic, &failure)).rows[0].get("v").?.string);
    try testing.expectEqualStrings(session, (try p.query(a, settings, &one, &failure)).rows[0].get("v").?.string);
    const prepared = "SELECT count(*)::int AS n FROM pg_prepared_statements";
    const count = struct {
        fn n(pool: *pool_mod.Pool, al: std.mem.Allocator, q: []const u8, f: *root.Failure) !f64 {
            return (try pool.query(al, q, &.{}, f)).rows[0].get("n").?.number;
        }
    }.n;
    // A fresh pool so the statement cache starts empty.
    const q = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer q.deinit();
    // Fill the general class (8) with hot lookups, then the projection
    // class (6): every projection still gets a slot.
    for (0..2) |_| for (0..8) |i| {
        _ = try q.queryWith(a, try std.fmt.allocPrint(a, "SELECT $1::int AS g{d}", .{i}), &one, .{ .plan = .reusable }, &failure);
    };
    try testing.expectEqual(@as(f64, 8), try count(q, a, prepared, &failure));
    for (0..2) |_| for (0..6) |i| {
        _ = try q.queryWith(a, try std.fmt.allocPrint(a, "SELECT $1::int AS p{d}", .{i}), &one, .{ .plan = .serial_generic }, &failure);
    };
    try testing.expectEqual(@as(f64, 14), try count(q, a, prepared, &failure));
    // Full on both sides: newcomers run unnamed; nothing is evicted
    // (every entry was used within the last 64 named queries).
    for (0..2) |_| {
        _ = try q.queryWith(a, "SELECT $1::int AS g_extra", &one, .{ .plan = .reusable }, &failure);
        _ = try q.queryWith(a, "SELECT $1::int AS p_extra", &one, .{ .plan = .serial_generic }, &failure);
    }
    try testing.expectEqual(@as(f64, 14), try count(q, a, prepared, &failure));
    const names = (try q.query(a, "SELECT count(*) FILTER (WHERE statement LIKE '%AS p%')::int AS p, count(*) FILTER (WHERE statement LIKE '%AS g%')::int AS g FROM pg_prepared_statements", &.{}, &failure)).rows[0];
    try testing.expectEqual(@as(f64, 6), names.get("p").?.number);
    try testing.expectEqual(@as(f64, 8), names.get("g").?.number);
    // A burst of general statements never takes a projection's slot: once
    // a general entry has idled for 64 named queries it is the one evicted.
    for (0..70) |_| _ = try q.queryWith(a, "SELECT $1::int AS g0", &one, .{ .plan = .reusable }, &failure);
    for (0..2) |_| _ = try q.queryWith(a, "SELECT $1::int AS g_new", &one, .{ .plan = .reusable }, &failure);
    const after = (try q.query(a, "SELECT count(*) FILTER (WHERE statement LIKE '%AS p%')::int AS p, count(*) FILTER (WHERE statement = 'SELECT $1::int AS g_new')::int AS g FROM pg_prepared_statements", &.{}, &failure)).rows[0];
    try testing.expectEqual(@as(f64, 6), after.get("p").?.number);
    try testing.expectEqual(@as(f64, 1), after.get("g").?.number);
    // The reverse: projections first, then the general class still gets
    // all of its slots.
    const r = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer r.deinit();
    for (0..2) |_| for (0..8) |i| {
        _ = try r.queryWith(a, try std.fmt.allocPrint(a, "SELECT $1::int AS rp{d}", .{i}), &one, .{ .plan = .serial_generic }, &failure);
    };
    try testing.expectEqual(@as(f64, 6), try count(r, a, prepared, &failure));
    for (0..2) |_| for (0..8) |i| {
        _ = try r.queryWith(a, try std.fmt.allocPrint(a, "SELECT $1::int AS rg{d}", .{i}), &one, .{ .plan = .generic }, &failure);
    };
    try testing.expectEqual(@as(f64, 14), try count(r, a, prepared, &failure));
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
    // A reply the server delays is waited for on the socket. (A reply can
    // already be there when we look, e.g. on a busy machine: try again.)
    for (0..20) |_| {
        _ = try p.query(a, "SELECT pg_sleep(0.02)", &.{}, null);
        try testing.expectEqual(Counter.begins, Counter.ends);
        if (Counter.begins > 0) break;
    }
    try testing.expect(Counter.begins > 0);
    // A queued acquire (the only connection is checked out) brackets its
    // wait; the connection comes back only once that acquire is queued.
    const held = try p.acquire(a, null);
    const Releaser = struct {
        var queued = std.atomic.Value(bool).init(false);
        fn run(pool: *pool_mod.Pool, conn: pq.Conn) void {
            // Bounded: if the acquire never queues, release anyway and let
            // the test fail on `queued` instead of hanging.
            const deadline = std.time.milliTimestamp() + 5_000;
            while (pool.stats().waiting == 0 and std.time.milliTimestamp() < deadline) std.Thread.sleep(std.time.ns_per_ms);
            queued.store(pool.stats().waiting > 0, .release);
            pool.release(conn);
        }
    };
    const t = try std.Thread.spawn(.{}, Releaser.run, .{ p, held });
    const before = Counter.begins;
    const again = try p.acquire(a, null);
    t.join();
    try testing.expect(Releaser.queued.load(.acquire));
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

test "libpq: behind a transaction pooler, a tuned statement's setting never reaches another client (opt-in SCRAPER_PROXY_TEST_POOLER_URL)" {
    // A PgBouncer in transaction mode with default_pool_size = 1, so both
    // clients below share one server backend.
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_POOLER_URL") orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const tuned = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer tuned.deinit();
    const other = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer other.deinit();
    var failure: root.Failure = .{};
    const sql = "SELECT current_setting('join_collapse_limit') || '/' || current_setting('max_parallel_workers_per_gather') || '/' || pg_backend_pid() AS v WHERE $1::int = 1";
    const one = [_]Value{.{ .number = 1 }};
    const start = (try other.query(a, sql, &one, &failure)).rows[0].get("v").?.string;
    const defaults = start[0..std.mem.lastIndexOfScalar(u8, start, '/').?];
    const notices_before = pq.test_notices.load(.monotonic);
    for (0..30) |i| {
        const opts: pq.QueryOptions = .{ .plan = switch (i % 3) {
            0 => .fixed_join,
            1 => .serial,
            else => .serial_generic,
        } };
        const mine = (try tuned.queryWith(a, sql, &one, opts, &failure)).rows[0].get("v").?.string;
        try testing.expect(!std.mem.startsWith(u8, mine, defaults));
        const theirs = (try other.query(a, sql, &one, &failure)).rows[0].get("v").?.string;
        // Same backend (pool size 1), yet the other client sees the defaults.
        try testing.expectEqualStrings(mine[std.mem.lastIndexOfScalar(u8, mine, '/').?..], theirs[std.mem.lastIndexOfScalar(u8, theirs, '/').?..]);
        try testing.expect(std.mem.startsWith(u8, theirs, defaults));
    }
    try testing.expectEqual(notices_before, pq.test_notices.load(.monotonic));
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

test "libpq on a fiber: queries park the fiber, and two fibers interleave on one thread" {
    const url = testUrl() orelse return error.SkipZigTest;
    const Ctx = struct {
        pool: *pool_mod.Pool,
        in_fiber: bool = false,
        rows: [2]usize = .{ 0, 0 },
        err: ?anyerror = null,
        started: std.atomic.Value(usize) = .init(0),

        fn one(self: *@This(), index: usize, sleep: []const u8) void {
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            _ = self.started.fetchAdd(1, .monotonic);
            const sql = std.fmt.allocPrint(arena.allocator(), "SELECT g, pg_sleep({s}) FROM generate_series(1, 3) g", .{sleep}) catch unreachable;
            const r = self.pool.query(arena.allocator(), sql, &.{}, null) catch |e| {
                self.err = e;
                return;
            };
            self.rows[index] = r.rows.len;
        }
        fn second(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            self.one(1, "0");
        }
        fn first(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            self.in_fiber = core.fiber.inFiber();
            core.fiber.spawn(second, self) catch |e| {
                self.err = e;
                return;
            };
            // This query sleeps ~0.2 s server-side while its fiber is parked:
            // the spawned fiber runs and finishes meanwhile.
            self.one(0, "0.1");
        }
    };
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 2 });
    defer p.deinit();
    var ctx: Ctx = .{ .pool = p };
    const started = pq.nowMs();
    try core.fiber.testing.run(Ctx.first, &ctx);
    try testing.expect(ctx.err == null);
    try testing.expect(ctx.in_fiber);
    try testing.expectEqual([2]usize{ 3, 3 }, ctx.rows);
    // Interleaved, not serial: well under two sleeping queries back to back.
    try testing.expect(pq.nowMs() - started < 2_000);
}

test "libpq on a fiber: an exhausted pool times out with node-pg's text" {
    const url = testUrl() orelse return error.SkipZigTest;
    const Ctx = struct {
        pool: *pool_mod.Pool,
        err: ?anyerror = null,
        message: []const u8 = "",
        arena: std.heap.ArenaAllocator = std.heap.ArenaAllocator.init(testing.allocator),

        fn run(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            var failure: root.Failure = .{};
            if (self.pool.acquire(self.arena.allocator(), &failure)) |conn| {
                self.pool.release(conn);
            } else |e| {
                self.err = e;
                self.message = failure.message;
            }
        }
    };
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .connect_timeout_ms = 200 }, .max = 1 });
    defer p.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const held = try p.acquire(arena_state.allocator(), null);
    var ctx: Ctx = .{ .pool = p };
    defer ctx.arena.deinit();
    const started = pq.nowMs();
    try core.fiber.testing.run(Ctx.run, &ctx);
    p.release(held);
    try testing.expectEqual(@as(?anyerror, error.ConnectionFailed), ctx.err);
    try testing.expectEqualStrings("timeout exceeded when trying to connect", ctx.message);
    const waited = pq.nowMs() - started;
    try testing.expect(waited >= 190 and waited < 1_000);
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
    // Check the cap while some worker queues behind the two connections.
    const until = deadlineAfter(wait_bound_ms);
    var mid = p.stats();
    while (mid.waiting == 0 and std.time.milliTimestamp() < until) : (mid = p.stats()) std.Thread.sleep(std.time.ns_per_ms);
    try testing.expect(mid.waiting >= 1);
    try testing.expect(mid.total <= 2);
    for (threads) |t| t.join();
    try testing.expectEqual(@as(u32, 0), errors.load(.monotonic));
    const end = p.stats();
    try testing.expectEqual(@as(u32, 2), end.total);
    try testing.expectEqual(@as(u32, 2), end.idle);
    try testing.expectEqual(@as(u32, 0), end.waiting);
}

/// `base` plus a tag unique to this test process: concurrent runs sharing
/// one database (e.g. a load test) must not receive each other's NOTIFYs or
/// terminate each other's listeners by channel name.
fn uniqueChannel(a: std.mem.Allocator, base: []const u8) ![]const u8 {
    const Tag = struct {
        var value: u32 = 0;
        var once = std.once(init);
        fn init() void {
            value = std.crypto.random.int(u32);
        }
    };
    Tag.once.call();
    return std.fmt.allocPrint(a, "{s}_{x:0>8}", .{ base, Tag.value });
}

/// `LISTEN "<channel>";` as the listener sends it (quotes doubled), for
/// matching its backend in pg_stat_activity.
fn listenStatement(a: std.mem.Allocator, channel: []const u8) ![]const u8 {
    const quoted = try std.mem.replaceOwned(u8, a, channel, "\"", "\"\"");
    return std.fmt.allocPrint(a, "LISTEN \"{s}\";", .{quoted});
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
    /// Stay in on_disconnect this long after reporting (the listener frees
    /// itself only once the callback returns).
    linger_ms: u64 = 0,
    /// Holds the disconnect callback until set (bounded), so the listener
    /// thread outlives whatever the test does meanwhile.
    hold: ?*std.Thread.ResetEvent = null,

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
        {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.disconnected = true;
            if (message) |m| {
                self.message_len = @min(m.len, self.message.len);
                @memcpy(self.message[0..self.message_len], m[0..self.message_len]);
            }
            self.cond.broadcast();
        }
        if (self.linger_ms > 0) std.Thread.sleep(self.linger_ms * std.time.ns_per_ms);
        if (self.hold) |h| h.timedWait(30 * std.time.ns_per_s) catch {};
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
    // Lingering in the callback keeps the self-freeing listener thread alive
    // past the test's end: `svc.deinit` must wait for it (else the testing
    // allocator reports the listener leaked).
    var capture: NotifyCapture = .{ .svc = svc, .unlisten_inside = true, .linger_ms = 200 };
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    const event = try uniqueChannel(a, "scraper_event");
    const mixed = try uniqueChannel(a, "Mixed\"Case");
    const l = try svc.listen(&.{ event, mixed }, .{ .ctx = &capture, .on_notification = NotifyCapture.onNotification, .on_disconnect = NotifyCapture.onDisconnect }, a, &failure);
    capture.listener = l;
    try testing.expectEqual(@as(f64, 1), svc.metricsSnapshot().listeners);
    _ = try svc.queryLive(a, "SELECT pg_notify($1, 'hello'), pg_notify($2, '')", &.{ .{ .string = event }, .{ .string = mixed } }, &failure);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.payloads.items.len == 2;
        }
    }.f);
    try testing.expectEqualStrings("hello", capture.payloads.items[0]);
    try testing.expectEqualStrings("", capture.payloads.items[1]);
    // Kill this listener's backend (matched by its own channel only, so other
    // suites' listeners on the same server survive): on_disconnect fires once
    // and unlistens.
    const pattern = try std.fmt.allocPrint(a, "%{s}%", .{try listenStatement(a, mixed)});
    _ = try svc.queryLive(a, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()", &.{.{ .string = pattern }}, &failure);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.disconnected;
        }
    }.f);
    try testing.expectEqual(@as(f64, 0), svc.metricsSnapshot().listeners);
}

test "libpq: close outlived by a listener thread warns and leaves the service allocated" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    svc.listener_wait_ms = 20;
    // The callback is held until close's wait is over and checked.
    var hold: std.Thread.ResetEvent = .{};
    defer hold.set();
    var capture: NotifyCapture = .{ .svc = svc, .unlisten_inside = true, .hold = &hold };
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    const channel = try uniqueChannel(a, "outlived_channel");
    capture.listener = try svc.listen(&.{channel}, .{ .ctx = &capture, .on_notification = NotifyCapture.onNotification, .on_disconnect = NotifyCapture.onDisconnect }, a, &failure);
    const pattern = try std.fmt.allocPrint(a, "{s}%", .{try listenStatement(a, channel)});
    _ = try svc.queryLive(a, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE $1", &.{.{ .string = pattern }}, &failure);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.disconnected;
        }
    }.f);
    svc.deinit();
    // Still allocated: the late thread's decrement lands in live memory.
    try testing.expect(svc.outlived);
    {
        LogCapture.mutex.lock();
        defer LogCapture.mutex.unlock();
        var warned = false;
        for (LogCapture.warnings.items) |w| warned = warned or contains(w, "listener threads still running after 20 ms at close");
        try testing.expect(warned);
    }
    hold.set();
    try testing.expect(listener_mod.awaitThreads(&svc.listener_threads, 5_000));
    testing.allocator.destroy(svc);
}

test "libpq: listenUnlogged leaves the listening line to logListening" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var capture: NotifyCapture = .{ .svc = svc };
    defer capture.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const channels = [_][]const u8{ "db_quiet_a", "db_quiet_b" };
    const l = try svc.listenUnlogged(&channels, .{ .ctx = &capture, .on_notification = NotifyCapture.onNotification, .on_disconnect = NotifyCapture.onDisconnect }, arena_state.allocator(), null);
    defer svc.unlisten(l);
    const listening = struct {
        fn count() usize {
            LogCapture.mutex.lock();
            defer LogCapture.mutex.unlock();
            var n: usize = 0;
            for (LogCapture.infos.items) |m| {
                if (std.mem.startsWith(u8, m, "listening on")) n += 1;
            }
            return n;
        }
    };
    try testing.expectEqual(@as(usize, 0), listening.count());
    svc.logListening(&channels);
    try testing.expectEqual(@as(usize, 1), listening.count());
    LogCapture.mutex.lock();
    defer LogCapture.mutex.unlock();
    for (LogCapture.infos.items) |m| if (std.mem.startsWith(u8, m, "listening on")) try testing.expectEqualStrings("listening on db_quiet_a, db_quiet_b", m);
}

test "libpq: row conversion is byte-equal to convertCell on every column type's edge values" {
    const url = testUrl() orelse return error.SkipZigTest;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    // Each row: a SQL expression of some type. The same values as text
    // (`::text`) through convertCell are the old path's result.
    const exprs = [_][]const u8{
        "0::int2",                   "(-32768)::int2",                                    "32767::int2",                               "0::int4",                   "(-2147483648)::int4",
        "2147483647::int4",          "4294967295::oid",                                   "0::oid",                                    "true",                      "false",
        "9223372036854775807::int8", "(-9223372036854775808)::int8",                      "12345678901234567890.000100::numeric",      "'NaN'::numeric",            "1e-30::numeric",
        "''::text",                  "E'\\u2028\\u2029 \\U0001F600 \"\\\\ \\t\\n'::text", "'v'::varchar",                              "'x'::name",                 "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
        "1.5::float8",               "(-0.0)::float8",                                    "'Infinity'::float4",                        "'{\"b\":[1,2.50]}'::jsonb", "'{\"b\": 1}'::json",
        "'\\x00ff'::bytea",          "'2020-02-29'::date",                                "'2020-02-29 12:34:56.789+02'::timestamptz", "'{1,NULL,3}'::int4[]",      "'{t,f}'::bool[]",
        "'{\"a b\",c}'::text[]",     "NULL::int4",                                        "NULL::text",                                "NULL::bool",
    };
    var sql: std.ArrayList(u8) = .empty;
    var sql_text: std.ArrayList(u8) = .empty;
    try sql.appendSlice(a, "SELECT ");
    try sql_text.appendSlice(a, "SELECT ");
    for (exprs, 0..) |e, i| {
        if (i > 0) {
            try sql.appendSlice(a, ", ");
            try sql_text.appendSlice(a, ", ");
        }
        try sql.print(a, "{s} AS c{d}", .{ e, i });
        try sql_text.print(a, "({s})::text AS c{d}, pg_typeof({s})::oid::int4 AS t{d}", .{ e, i, e, i });
    }
    const typed = try p.query(a, sql.items, &.{}, null);
    const texts = try p.query(a, sql_text.items, &.{}, null);
    for (exprs, 0..) |e, i| {
        var name_buf: [8]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buf, "c{d}", .{i});
        var oid_buf: [8]u8 = undefined;
        const oid_name = try std.fmt.bufPrint(&oid_buf, "t{d}", .{i});
        const got = typed.rows[0].get(name).?;
        const raw = texts.rows[0].get(name).?;
        const want: core.json.Value = if (raw == .null) .null else try convert.convertCell(a, @intFromFloat(texts.rows[0].get(oid_name).?.number), raw.string, .copy);
        const got_json = try core.json.stringifyAlloc(a, got);
        const want_json = try core.json.stringifyAlloc(a, want);
        if (!std.mem.eql(u8, got_json, want_json)) std.debug.print("{s}: got {s} want {s}\n", .{ e, got_json, want_json });
        try testing.expectEqualStrings(want_json, got_json);
    }
    // bpchar keeps its padding as a plain string (`::text` would trim it).
    const padded = try p.query(a, "SELECT 'pad'::char(6) AS c", &.{}, null);
    try testing.expectEqualStrings("pad   ", padded.rows[0].get("c").?.string);
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
    try waitIdleReadable(p);
    const again = try p.query(a, "SELECT 1 AS one", &.{}, null);
    try testing.expectEqual(@as(f64, 1), again.rows[0].get("one").?.number);
    try testing.expectEqual(@as(u32, 1), Hook.count.load(.monotonic));
}

/// Waits (event, not a fixed sleep) until the server has closed the pool's
/// only idle connection (its FATAL may arrive before the FIN, and libpq only
/// sees an idle connection die at EOF).
fn waitIdleReadable(p: *pool_mod.Pool) !void {
    p.mutex.lock();
    const fd = p.idle.items[0].conn.socket();
    p.mutex.unlock();
    if (builtin.os.tag == .linux) {
        // POLLRDHUP (0x2000); Zig 0.15.2's std.os.linux.POLL doesn't define it.
        const pollrdhup: i16 = 0x2000;
        var fds = [_]std.posix.pollfd{.{ .fd = fd, .events = pollrdhup, .revents = 0 }};
        try testing.expect(try std.posix.poll(&fds, 5_000) == 1);
        return;
    }
    // kqueue reports EV_EOF on the read filter once the FIN is in, even with
    // unread data before it.
    const kq = try std.posix.kqueue();
    defer std.posix.close(kq);
    const change = [_]std.posix.Kevent{.{ .ident = @intCast(fd), .filter = std.c.EVFILT.READ, .flags = std.c.EV.ADD, .fflags = 0, .data = 0, .udata = 0 }};
    _ = try std.posix.kevent(kq, &change, &.{}, null);
    const deadline = std.time.milliTimestamp() + 5_000;
    while (std.time.milliTimestamp() < deadline) {
        var events: [1]std.posix.Kevent = undefined;
        const ts: std.posix.timespec = .{ .sec = 0, .nsec = 50 * std.time.ns_per_ms };
        const n = try std.posix.kevent(kq, &.{}, &events, &ts);
        if (n == 1 and events[0].flags & std.c.EV.EOF != 0) return;
    }
    return error.TestUnexpectedResult;
}

test "libpq: a socket libpq closed itself leaves no fiber-loop record under its number" {
    const url = testUrl() orelse return error.SkipZigTest;
    // Stand-ins for the HTTP loop's registry hooks, logged in order.
    const Rec = struct {
        const Kind = enum { closed, forget };
        var mutex: std.Thread.Mutex = .{};
        var events: [32]struct { kind: Kind, fd: std.posix.fd_t } = undefined;
        var len: usize = 0;
        fn add(kind: Kind, fd: std.posix.fd_t) void {
            mutex.lock();
            defer mutex.unlock();
            if (len < events.len) events[len] = .{ .kind = kind, .fd = fd };
            len += 1;
        }
        fn onClosed(fd: std.posix.fd_t) void {
            add(.closed, fd);
        }
        fn onForget(fd: std.posix.fd_t) void {
            add(.forget, fd);
        }
        /// The first hook call for `fd` since `reset`.
        fn first(fd: std.posix.fd_t) ?Kind {
            mutex.lock();
            defer mutex.unlock();
            for (events[0..@min(len, events.len)]) |e| if (e.fd == fd) return e.kind;
            return null;
        }
        fn reset() void {
            mutex.lock();
            defer mutex.unlock();
            len = 0;
        }
    };
    Rec.reset();
    core.fiber.fd_closed = Rec.onClosed;
    core.fiber.fd_closing = Rec.onForget;
    defer core.fiber.fd_closed = null;
    defer core.fiber.fd_closing = null;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const r = try p.query(a, "SELECT pg_backend_pid() AS pid", &.{}, null);
    const pid = r.rows[0].get("pid").?.number;
    p.mutex.lock();
    const old_fd = p.idle.items[0].conn.socket();
    p.mutex.unlock();
    // A new socket starts by clearing any registration under its number.
    try testing.expectEqual(@as(?Rec.Kind, .forget), Rec.first(old_fd));
    Rec.reset();
    const killer = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer killer.deinit();
    _ = try killer.query(a, "SELECT pg_terminate_backend($1)", &.{.{ .number = pid }}, null);
    try waitIdleReadable(p);
    // Checkout meets EOF, libpq closes the socket, the pool reconnects.
    const again = try p.query(a, "SELECT 1 AS one", &.{}, null);
    try testing.expectEqual(@as(f64, 1), again.rows[0].get("one").?.number);
    // The dead socket's number left the registry at once, without a kernel
    // unregister (a later forget is the new socket's own, if it reused it).
    try testing.expectEqual(@as(?Rec.Kind, .closed), Rec.first(old_fd));
}

test "libpq on a fiber: idle checks skip the socket until the loop saw input; a killed idle backend is still replaced" {
    const url = testUrl() orelse return error.SkipZigTest;
    // Stands in for the HTTP loop's readiness word (`core.fiber.readiness`).
    const Loop = struct {
        var bits: std.atomic.Value(u32) = .init(0);
        fn readiness(_: std.posix.fd_t) ?*const std.atomic.Value(u32) {
            return &bits;
        }
    };
    Loop.bits.store(0, .release);
    core.fiber.fd_readiness = Loop.readiness;
    defer core.fiber.fd_readiness = null;
    const Hook = struct {
        var count: std.atomic.Value(u32) = .init(0);
        fn call(_: *anyopaque, _: []const u8) void {
            _ = count.fetchAdd(1, .monotonic);
        }
    };
    var dummy: u8 = 0;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1, .on_idle_error = .{ .ctx = &dummy, .func = Hook.call } });
    defer p.deinit();
    const Ctx = struct {
        pool: *pool_mod.Pool,
        pid: f64 = 0,
        err: ?anyerror = null,
        fn run(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            // A fiber wait: the connection picks up its readiness word.
            const r = self.pool.query(arena.allocator(), "SELECT pg_backend_pid() AS pid, pg_sleep(0.02)", &.{}, null) catch |e| {
                self.err = e;
                return;
            };
            self.pid = r.rows[0].get("pid").?.number;
        }
    };
    var ctx: Ctx = .{ .pool = p };
    try core.fiber.testing.run(Ctx.run, &ctx);
    try testing.expect(ctx.err == null);
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    // Nothing arrived since the last exchange: checkout makes no syscall.
    const before = pq.Conn.idle_socket_checks.load(.monotonic);
    _ = try p.query(a, "SELECT 1", &.{}, null);
    try testing.expectEqual(before, pq.Conn.idle_socket_checks.load(.monotonic));
    // The server terminates the idle backend; the loop records the edge.
    const killer = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer killer.deinit();
    _ = try killer.query(a, "SELECT pg_terminate_backend($1)", &.{.{ .number = ctx.pid }}, null);
    try waitIdleReadable(p);
    Loop.bits.store(core.fiber.Events.read, .release);
    // As pg-pool: the dead connection is dropped and reported once, and the
    // request gets a fresh one.
    const again = try p.query(a, "SELECT 1 AS one", &.{}, null);
    try testing.expectEqual(@as(f64, 1), again.rows[0].get("one").?.number);
    try testing.expect(pq.Conn.idle_socket_checks.load(.monotonic) > before);
    try testing.expectEqual(@as(u32, 1), Hook.count.load(.monotonic));
    try testing.expectEqual(@as(u32, 1), p.stats().total);
}

test "libpq: close stops listeners, then the live, validator and main pools" {
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
    _ = try svc.queryValidator(a, "SELECT 1", &.{}, &failure);
    const before = svc.metricsSnapshot();
    try testing.expectEqual(@as(f64, 1), before.listeners);
    try testing.expectEqual(@as(f64, 1), before.pools.main.total);
    try testing.expectEqual(@as(f64, 1), before.pools.live.total);
    try testing.expectEqual(@as(f64, 1), before.pools.validator.total);
    try testing.expectEqual(@as(f64, 5), before.pools.validator.limit);
    try svc.close();
    const after = svc.metricsSnapshot();
    try testing.expectEqual(@as(f64, 0), after.listeners);
    try testing.expectEqual(@as(f64, 0), after.pools.main.total);
    try testing.expectEqual(@as(f64, 0), after.pools.validator.total);
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
    // Close once the query is in flight (connecting or running).
    const until = deadlineAfter(wait_bound_ms);
    while (std.time.milliTimestamp() < until) {
        svc.mutex.lock();
        const in_flight = svc.in_flight;
        svc.mutex.unlock();
        if (in_flight > 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
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
    const until = deadlineAfter(wait_bound_ms);
    while (p.stats().waiting == 0 and std.time.milliTimestamp() < until) std.Thread.sleep(std.time.ns_per_ms);
    try testing.expect(p.stats().waiting == 1);
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
    const early = try uniqueChannel(arena_state.allocator(), "early_channel");
    const notify = try std.fmt.allocPrint(arena_state.allocator(), "NOTIFY {s}, 'early'", .{early});
    const l = try listener_mod.Listener.start(testing.allocator, .{ .conninfo = url }, &.{early}, .{
        .ctx = &capture,
        .on_notification = NotifyCapture.onNotification,
        .on_disconnect = NotifyCapture.onDisconnect,
        // The SELECT round trip guarantees libpq already parsed the NOTIFY
        // (queued in PQnotifies) before the thread's first poll.
    }, .{ .after_listen_sql = &.{ notify, "SELECT 1" } }, arena_state.allocator(), null);
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
    const retire = try uniqueChannel(a, "retire_channel");
    const l = try listener_mod.Listener.start(testing.allocator, .{ .conninfo = url }, &.{retire}, .{
        .ctx = &capture,
        .on_notification = NotifyCapture.onNotification,
        .on_disconnect = NotifyCapture.onDisconnect,
    }, .{}, a, null);
    const killer = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer killer.deinit();
    const retire_pattern = try std.fmt.allocPrint(a, "{s}%", .{try listenStatement(a, retire)});
    _ = try killer.query(a, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE $1", &.{.{ .string = retire_pattern }}, null);
    try capture.waitFor(struct {
        fn f(c: *NotifyCapture) bool {
            return c.disconnected;
        }
    }.f);
    var cleaned = false;
    for (0..200) |_| {
        cleaned = l.selfCleaned();
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
    const timeout_ms = 1_000;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .connect_timeout_ms = timeout_ms }, .max = 1 });
    defer p.deinit();
    const Attempt = struct {
        fn run(pool: *pool_mod.Pool, elapsed: *std.atomic.Value(i64), message: *[96]u8) void {
            var a = std.heap.ArenaAllocator.init(testing.allocator);
            defer a.deinit();
            var failure: root.Failure = .{};
            const t0 = std.time.milliTimestamp();
            _ = pool.query(a.allocator(), "SELECT 1", &.{}, &failure) catch {};
            elapsed.store(@max(1, std.time.milliTimestamp() - t0), .release);
            const n = @min(failure.message.len, message.len);
            @memcpy(message[0..n], failure.message[0..n]);
        }
    };
    var e1: std.atomic.Value(i64) = .init(0);
    var e2: std.atomic.Value(i64) = .init(0);
    var m1: [96]u8 = @splat(0);
    var m2: [96]u8 = @splat(0);
    // Gate on pool state, not sleeps: the first request holds the only slot
    // (connecting) before the second starts, and the second is queued.
    const t1 = try std.Thread.spawn(.{}, Attempt.run, .{ p, &e1, &m1 });
    const until = deadlineAfter(wait_bound_ms);
    while (p.stats().total == 0 and e1.load(.acquire) == 0 and std.time.milliTimestamp() < until) std.Thread.sleep(std.time.ns_per_ms);
    const t2 = try std.Thread.spawn(.{}, Attempt.run, .{ p, &e2, &m2 });
    while (p.stats().waiting == 0 and e2.load(.acquire) == 0 and std.time.milliTimestamp() < until) std.Thread.sleep(std.time.ns_per_ms);
    t1.join();
    t2.join();
    try testing.expect(std.mem.startsWith(u8, &m1, "Connection terminated due to connection timeout"));
    try testing.expect(std.mem.startsWith(u8, &m2, "timeout exceeded when trying to connect"));
    // Its timer runs from its own call (about timeout_ms), not queue wait
    // plus a fresh connect (nearly 2 x timeout_ms): half a timeout of slack.
    try testing.expect(e2.load(.acquire) < timeout_ms + timeout_ms / 2);
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

test "libpq on a fiber: checkout prefers the newest idle connection of the fiber's loop" {
    const url = testUrl() orelse return error.SkipZigTest;
    const Ctx = struct {
        pool: *pool_mod.Pool,
        err: ?anyerror = null,
        own_waited: bool = false,
        picked_own: bool = false,
        picked_top: bool = false,
        var other_loop: u8 = 0;

        fn run(arg: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(arg));
            self.body() catch |e| {
                self.err = e;
            };
        }
        fn body(self: *@This()) !void {
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            const a = arena.allocator();
            const here = core.fiber.current().?.sched.ctx;
            // A query waiting on a fiber records the fiber's loop.
            var q = try self.pool.acquire(a, null);
            _ = try q.query(a, "SELECT pg_sleep(0.05)", &.{}, null);
            self.own_waited = q.home == here;
            self.pool.release(q);
            // Idle stack, oldest first: own loop's connection, then five of
            // another loop's: the own one is taken from the bottom.
            var conns: [6]pq.Conn = undefined;
            for (&conns) |*c| c.* = try self.pool.acquire(a, null);
            conns[0].home = here;
            for (conns[1..]) |*c| c.home = &other_loop;
            for (conns) |c| self.pool.release(c);
            const own = try self.pool.acquire(a, null);
            self.picked_own = own.socket() == conns[0].socket();
            // None of this loop's left: plain LIFO.
            const top = try self.pool.acquire(a, null);
            const next = try self.pool.acquire(a, null);
            self.picked_top = top.socket() == conns[5].socket() and next.socket() == conns[4].socket();
            for ([_]pq.Conn{ own, next, top }) |c| self.pool.release(c);
        }
    };
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 6 });
    defer p.deinit();
    var ctx: Ctx = .{ .pool = p };
    try core.fiber.testing.run(Ctx.run, &ctx);
    try testing.expect(ctx.err == null);
    try testing.expect(ctx.own_waited);
    try testing.expect(ctx.picked_own);
    try testing.expect(ctx.picked_top);
}

test "libpq on fibers: a waiter on another loop passed over for affinity keeps its deadline and text" {
    const url = testUrl() orelse return error.SkipZigTest;
    // Two fiber "loops": a testing.run scheduler on each of two threads.
    // B's deadline starts only once A holds the connection (`held`), and A's
    // second fiber holds it three times as long.
    const timeout_ms = 1_000;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .connect_timeout_ms = timeout_ms }, .max = 1, .affinity_bound_ms = 60_000 });
    defer p.deinit();
    const State = struct {
        pool: *pool_mod.Pool,
        holder_done: std.atomic.Value(bool) = .init(false),
        held: std.atomic.Value(bool) = .init(false),
        b_err: ?anyerror = null,
        b_message: [96]u8 = @splat(0),
        b_elapsed: i64 = 0,
        a2_got: std.atomic.Value(bool) = .init(false),
        err: ?anyerror = null,

        // Loop A, fiber 1: checks out the connection (its home becomes A),
        // and releases it once the other loop's waiter and A's second
        // waiter are both queued.
        fn holder(arg: *anyopaque) void {
            const st: *@This() = @ptrCast(@alignCast(arg));
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            var conn = st.pool.acquire(arena.allocator(), null) catch |e| {
                st.err = e;
                return;
            };
            st.held.store(true, .release);
            _ = conn.query(arena.allocator(), "SELECT pg_sleep(0.01)", &.{}, null) catch |e| {
                st.err = e;
            };
            core.fiber.spawn(second, st) catch |e| {
                st.err = e;
            };
            // Off-fiber wait for the queue to fill (testing.run runs the
            // spawned fiber only when this one parks: park via a short query).
            const until = deadlineAfter(wait_bound_ms);
            while (st.pool.stats().waiting < 2) {
                if (std.time.milliTimestamp() > until) {
                    st.err = error.Timeout;
                    break;
                }
                _ = conn.query(arena.allocator(), "SELECT pg_sleep(0.005)", &.{}, null) catch {};
            }
            st.pool.release(conn);
            st.holder_done.store(true, .release);
        }
        // Loop A, fiber 2: newer than B's waiter but on the connection's
        // loop: served first. Holds the connection well past B's deadline.
        fn second(arg: *anyopaque) void {
            const st: *@This() = @ptrCast(@alignCast(arg));
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            // Queue only after B (FIFO position matters).
            const until = deadlineAfter(wait_bound_ms);
            while (st.pool.stats().waiting < 1) {
                if (std.time.milliTimestamp() > until) {
                    st.err = error.Timeout;
                    return;
                }
            }
            var conn = st.pool.acquire(arena.allocator(), null) catch |e| {
                st.err = e;
                return;
            };
            st.a2_got.store(true, .release);
            _ = conn.query(arena.allocator(), "SELECT pg_sleep(3)", &.{}, null) catch {};
            st.pool.release(conn);
        }
        // Loop B: the oldest waiter, passed over for A's second waiter.
        fn other(arg: *anyopaque) void {
            const st: *@This() = @ptrCast(@alignCast(arg));
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            var failure: root.Failure = .{};
            const t0 = std.time.milliTimestamp();
            if (st.pool.acquire(arena.allocator(), &failure)) |conn| {
                st.pool.release(conn);
            } else |e| {
                st.b_err = e;
                const n = @min(failure.message.len, st.b_message.len);
                @memcpy(st.b_message[0..n], failure.message[0..n]);
            }
            st.b_elapsed = std.time.milliTimestamp() - t0;
        }
        fn runA(st: *@This()) void {
            core.fiber.testing.run(holder, st) catch |e| {
                st.err = e;
            };
        }
        fn runB(st: *@This()) void {
            core.fiber.testing.run(other, st) catch |e| {
                st.err = e;
            };
        }
    };
    var st: State = .{ .pool = p };
    const a = try std.Thread.spawn(.{}, State.runA, .{&st});
    // B queues once A holds the connection (connected and checked out).
    const until = deadlineAfter(wait_bound_ms);
    while (!st.held.load(.acquire) and std.time.milliTimestamp() < until) std.Thread.sleep(std.time.ns_per_ms);
    if (!st.held.load(.acquire)) {
        a.join();
        return error.TestUnexpectedResult;
    }
    const b = try std.Thread.spawn(.{}, State.runB, .{&st});
    b.join();
    a.join();
    try testing.expect(st.err == null);
    try testing.expect(st.a2_got.load(.acquire));
    // B never got the connection and failed at its own deadline, with
    // node-pg's text, as without the affinity rule.
    try testing.expectEqual(@as(?anyerror, error.ConnectionFailed), st.b_err);
    try testing.expect(std.mem.startsWith(u8, &st.b_message, "timeout exceeded when trying to connect"));
    try testing.expect(st.b_elapsed >= timeout_ms - 5 and st.b_elapsed < 3 * timeout_ms);
}

test "libpq: lazy results write and materialize byte-identically to converted rows" {
    const url = testUrl() orelse return error.SkipZigTest;
    const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer p.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    // Fast types at their edges plus excluded types (which convert).
    const select =
        \\SELECT * FROM (VALUES
        \\ ((-32768)::int2, (-2147483648)::int4, 9007199254740993::int8, 1.2300e-5::numeric, ''::text, 'pad'::char(6), E'   \U0001F600 "\\ \t\n'::varchar, true, 1.5::float8, '{"a": [1, 2.50]}'::jsonb, '\x00ff'::bytea, '2020-02-29'::date, '{1,NULL}'::int4[], 4294967295::oid, '2026-10-01 12:34:56.789012'::timestamp, '2026-10-01 12:34:56.5+02'::timestamptz, '1 year 2 mons 3 days 04:05:06.789'::interval),
        \\ (32767::int2, 2147483647::int4, (-9223372036854775808)::int8, 'NaN'::numeric, repeat('x', 3000), NULL, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, 'infinity'::timestamp, '-infinity'::timestamptz, '-00:00:01'::interval),
        \\ (NULL, NULL, NULL, NULL, NULL, ''::char(1), E'\x01\x1f'::varchar, NULL, 'NaN'::float8, 'null'::jsonb, ''::bytea, NULL, '{}'::int4[], 0::oid, '0001-01-01 00:00:00 BC'::timestamp, NULL, NULL),
        \\ (0::int2, 0::int4, 0::int8, 0::numeric, 'z', 'x', 'y', true, 0::float8, '[]'::jsonb, decode(repeat('00ff7f80', 64), 'hex'), '0001-01-01'::date, '{NULL}'::int4[], 1::oid, '1970-01-01 00:00:00'::timestamp, '1970-01-01 00:00:00+00'::timestamptz, '0'::interval),
        \\ (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
        \\) AS t(i2, i4, i8, num, txt, bp, vc, b, f8, j, by, d, arr, o, ts, tstz, iv)
    ;
    for ([_]struct { sql: []const u8, params: []const core.json.Value, plan: pq.Plan }{
        .{ .sql = select, .params = &.{}, .plan = .unnamed },
        // The named (pipelined) path, both plan modes.
        .{ .sql = select ++ " WHERE $1::int = 1", .params = &.{.{ .number = 1 }}, .plan = .custom },
        .{ .sql = select ++ " WHERE $1::int = 1", .params = &.{.{ .number = 1 }}, .plan = .reusable },
    }) |q| for (0..3) |_| { // repeated: named statements prepare on second use
        const plain = try p.queryWith(a, q.sql, q.params, .{ .plan = q.plan }, null);
        const lazy_result = try p.queryWith(a, q.sql, q.params, .{ .plan = q.plan, .lazy = true }, null);
        const lazy = lazy_result.lazy.?;
        defer lazy.deinit();
        try testing.expectEqual(@as(usize, 0), lazy_result.rows.len);
        try testing.expectEqual(plain.row_count, lazy.row_count);
        try testing.expectEqual(plain.rows.len, lazy.rows);
        try testing.expectEqualStrings(
            try core.json.stringifyAlloc(a, .{ .array = plain.rows }),
            try core.json.stringifyAlloc(a, .{ .array = try lazy.materialize(a) }),
        );
        for (plain.rows, 0..) |row, r| for (lazy.columns, 0..) |c, ci| {
            var out: std.Io.Writer.Allocating = .init(a);
            try lazy.writeCell(&out.writer, a, r, ci);
            try testing.expectEqualStrings(try core.json.stringifyAlloc(a, row.get(c.name).?), out.written());
        };
        try testing.expectEqual(@as(?usize, 13), lazy.column("o"));
    };
    // A failing lazy query keeps the error and the connection.
    var failure: root.Failure = .{};
    try testing.expectError(error.QueryFailed, p.queryWith(a, "SELECT 1 / $1::int AS x", &.{.{ .number = 0 }}, .{ .lazy = true }, &failure));
    try testing.expectEqualStrings("division by zero", failure.message);
    const after = try p.query(a, "SELECT 2 AS x", &.{}, null);
    try testing.expectEqual(@as(f64, 2), after.rows[0].get("x").?.number);
    try testing.expectEqual(@as(u32, 1), p.stats().total);
}

/// Runs `n` concurrent `Pool.acquire` calls on fibers of one scheduler and
/// records each outcome and its elapsed time.
const FiberBurst = struct {
    pool: *pool_mod.Pool,
    n: usize,
    ok: std.atomic.Value(usize) = .init(0),
    messages: [16][96]u8 = @splat(@splat(0)),
    elapsed: [16]i64 = @splat(0),
    next: std.atomic.Value(usize) = .init(0),
    err: ?anyerror = null,

    fn one(arg: *anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(arg));
        const i = self.next.fetchAdd(1, .monotonic);
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        var failure: root.Failure = .{};
        const t0 = std.time.milliTimestamp();
        if (self.pool.acquire(arena.allocator(), &failure)) |conn| {
            _ = self.ok.fetchAdd(1, .monotonic);
            self.elapsed[i] = std.time.milliTimestamp() - t0;
            // Hold it (fiber parked on the query) while the others connect.
            var c = conn;
            _ = c.query(arena.allocator(), "SELECT pg_sleep(0.3)", &.{}, null) catch {};
            self.pool.release(c);
        } else |_| {
            self.elapsed[i] = std.time.milliTimestamp() - t0;
            const m = @min(failure.message.len, self.messages[i].len);
            @memcpy(self.messages[i][0..m], failure.message[0..m]);
        }
    }
    fn root_(arg: *anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(arg));
        for (1..self.n) |_| core.fiber.spawn(one, self) catch |e| {
            self.err = e;
        };
        one(arg);
    }
};

fn withHost(a: std.mem.Allocator, url: []const u8, host: []const u8) ![]const u8 {
    const i = std.mem.indexOf(u8, url, "127.0.0.1") orelse return url;
    return std.fmt.allocPrint(a, "{s}{s}{s}", .{ url[0..i], host, url[i + "127.0.0.1".len ..] });
}

test "startMayBlock: only host names need the resolver thread" {
    try testing.expect(!pq.startMayBlock("postgresql://u:p@127.0.0.1:5432/x"));
    try testing.expect(!pq.startMayBlock("postgresql://u:p@[::1]:5432/x"));
    try testing.expect(!pq.startMayBlock("host=10.0.0.1,10.0.0.2 port=5432,5433 dbname=x"));
    try testing.expect(!pq.startMayBlock("host=/var/run/postgresql dbname=x"));
    try testing.expect(!pq.startMayBlock("host=db.example hostaddr=10.0.0.1 dbname=x"));
    try testing.expect(pq.startMayBlock("postgresql://u:p@localhost:5432/x"));
    try testing.expect(pq.startMayBlock("host=10.0.0.1,db.example dbname=x"));
    try testing.expect(pq.startMayBlock("dbname=x"));
    try testing.expect(pq.startMayBlock("not a conninfo ="));
}

test "libpq on a fiber: cold connects use at most Connector.max_workers threads" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    // The test URL's own host (an IP locally, a container name on Linux CI)
    // and, when it is an IP, the same server by name.
    for ([_][]const u8{ url, try withHost(arena_state.allocator(), url, "localhost") }) |u| {
        const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = u }, .max = 10 });
        defer p.deinit();
        var waited: usize = 0;
        while (pool_mod.connectorStats().workers > 0 and waited < 300) : (waited += 1) std.Thread.sleep(10 * std.time.ns_per_ms);
        pool_mod.resetConnectorPeak();
        var burst: FiberBurst = .{ .pool = p, .n = 10 };
        try core.fiber.testing.run(FiberBurst.root_, &burst);
        try testing.expect(burst.err == null);
        try testing.expectEqual(@as(usize, 10), burst.ok.load(.monotonic));
        try testing.expectEqual(@as(u32, 10), p.stats().total);
        // The CPU steps (each PQconnectPoll) always run on the workers; name
        // resolution too when the host is a name.
        const peak = pool_mod.connectorStats().peak;
        try testing.expect(peak >= 1 and peak <= 4);
    }
    // Workers leave once idle.
    var waited: usize = 0;
    while (pool_mod.connectorStats().workers > 0 and waited < 300) : (waited += 1) std.Thread.sleep(10 * std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, 0), pool_mod.connectorStats().workers);
}

test "libpq on a fiber: connects keep their deadline and node-pg's timeout text" {
    const stalled = try stalledListener();
    defer std.posix.close(stalled.fd);
    var url_buf: [128]u8 = undefined;
    const timeout_ms = 400;
    // Both start paths: inline (IP) and through the workers (name).
    for ([_][]const u8{ "127.0.0.1", "localhost" }) |host| {
        const url = try std.fmt.bufPrint(&url_buf, "postgresql://u:p@{s}:{d}/x?sslmode=disable", .{ host, stalled.port });
        const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url, .connect_timeout_ms = timeout_ms }, .max = 10 });
        defer p.deinit();
        var burst: FiberBurst = .{ .pool = p, .n = 8 };
        try core.fiber.testing.run(FiberBurst.root_, &burst);
        try testing.expect(burst.err == null);
        try testing.expectEqual(@as(usize, 0), burst.ok.load(.monotonic));
        for (0..8) |i| {
            try testing.expect(std.mem.startsWith(u8, &burst.messages[i], "Connection terminated due to connection timeout"));
            try testing.expect(burst.elapsed[i] >= timeout_ms - 5);
            try testing.expect(burst.elapsed[i] < timeout_ms + timeout_ms / 2);
        }
    }
}

test "libpq: connect errors read the same on a fiber (both start paths) as a direct connect" {
    const refused = try stalledListener();
    const port = refused.port;
    std.posix.close(refused.fd);
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    for ([_][]const u8{ "127.0.0.1", "localhost" }) |host| {
        const url = try std.fmt.allocPrint(arena_state.allocator(), "postgresql://u:p@{s}:{d}/x?sslmode=disable", .{ host, port });
        var direct: root.Failure = .{};
        try testing.expectError(error.ConnectionFailed, pq.Conn.connect(.{ .conninfo = url }, arena_state.allocator(), &direct));
        const p = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
        defer p.deinit();
        var burst: FiberBurst = .{ .pool = p, .n = 1 };
        try core.fiber.testing.run(FiberBurst.root_, &burst);
        try testing.expectEqualStrings(direct.message, std.mem.sliceTo(&burst.messages[0], 0));
    }
}

test "libpq: queryValidator binds int4[] and int8[] array params (validator confirmation snapshots)" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url });
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    // The shape of live's confirmationSnapshots: unnest of an integer[] of
    // stored domains (signed: > 2^31 wraps) and a bigint[] of confirmations.
    var domains = [_]Value{ .{ .number = 1 }, .{ .number = -1 }, .{ .number = 2147483647 } };
    var confs = [_]Value{ .{ .number = 0 }, .{ .number = 3 }, .{ .number = 9007199254740991 } };
    const rows = try svc.queryValidator(a, "SELECT requested.domain, requested.confirmations::text AS c FROM unnest($1::integer[], $2::bigint[]) requested(domain, confirmations) ORDER BY 1", &.{ .{ .array = &domains }, .{ .array = &confs } }, &failure);
    try testing.expectEqualStrings(
        "[{\"domain\":-1,\"c\":\"3\"},{\"domain\":1,\"c\":\"0\"},{\"domain\":2147483647,\"c\":\"9007199254740991\"}]",
        try core.json.stringifyAlloc(a, .{ .array = rows }),
    );
    // A bad element fails with PostgreSQL's text, as queryLive would.
    var bad = [_]Value{.{ .number = 1.5 }};
    try testing.expectError(error.QueryFailed, svc.queryValidator(a, "SELECT * FROM unnest($1::integer[])", &.{.{ .array = &bad }}, &failure));
    try testing.expect(std.mem.indexOf(u8, failure.message, "invalid input syntax for type integer") != null);
}

test "libpq: literal parameters bind the decoded values and log byte-identically (slow and failed queries)" {
    const url = testUrl() orelse return error.SkipZigTest;
    core.config.set(.{ .database_url = url, .database_slow_query_ms = 1 });
    core.log.setSink(LogCapture.sink, null);
    defer core.log.setSink(null, null);
    defer LogCapture.reset();
    const svc = try DbService.init(testing.allocator, null);
    defer svc.deinit();
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: root.Failure = .{};
    // The confirmation snapshot's shapes: 214 message ids (a summarised
    // log array), int4[] domains, text[] heights, and NULL (over the cap).
    const row_sql =
        \\SELECT (SELECT array_agg(decode(lpad(to_hex(g), 64, '0'), 'hex') ORDER BY g) FROM generate_series(1, 214) g) AS message_ids,
        \\  ARRAY[1, 8453, 42161]::int4[] AS domains, ARRAY['10', '9223372036854775807', '0']::text[] AS heights,
        \\  NULL::bytea[] AS none, '{}'::bytea[] AS empty
    ;
    const decoded = (try svc.query(a, row_sql, &.{}, &failure))[0];
    const lazy = (try svc.queryLazy(a, row_sql, &.{}, .unnamed, &failure)).?;
    defer lazy.deinit();
    var literal: [5]Value = undefined;
    var plain: [5]Value = undefined;
    for (lazy.columns, 0..) |column, i| {
        literal[i] = if (lazy.cell(0, i)) |text| try convert.literalValue(a, column.oid, text) else .null;
        plain[i] = decoded.get(column.name).?;
    }
    try testing.expectEqual(@as(?usize, 214), convert.literalArrayLen(convert.literal(literal[0]).?));
    try testing.expectEqual(@as(?usize, 0), convert.literalArrayLen(convert.literal(literal[4]).?));
    // PostgreSQL reads both texts as the same values.
    const params = try std.mem.concat(a, Value, &.{ &literal, &plain });
    const same = try svc.query(a, "SELECT $1::bytea[] = $6::bytea[] AND $2::int4[] = $7::int4[] AND $3::text[] = $8::text[] AND $4::bytea[] IS NULL AND $9::bytea[] IS NULL AND $5::bytea[] = $10::bytea[] AS same", params, &failure);
    try testing.expect(same[0].get("same").?.bool);
    // Slow and failed query lines show the same values either way.
    const Lines = struct {
        fn of(s: *DbService, al: std.mem.Allocator, sql: []const u8, values: []const Value, fails: bool) ![]const u8 {
            LogCapture.reset();
            var f: root.Failure = .{};
            if (fails) {
                try testing.expectError(error.QueryFailed, s.query(al, sql, values, &f));
            } else _ = try s.query(al, sql, values, &f);
            LogCapture.mutex.lock();
            defer LogCapture.mutex.unlock();
            try testing.expectEqual(@as(usize, 1), LogCapture.warnings.items.len);
            const line = LogCapture.warnings.items[0];
            // Only the query id and duration may differ.
            const role = std.mem.indexOf(u8, line, " role=").?;
            const dur = std.mem.indexOf(u8, line, " durationMs=").?;
            const after_dur = std.mem.indexOfScalarPos(u8, line, dur + 1, ' ').?;
            return std.fmt.allocPrint(al, "{s}{s}|{s}", .{ line[0..std.mem.indexOf(u8, line, " id=").?], line[role..dur], line[after_dur..] });
        }
    };
    const slow = "SELECT pg_sleep(0.01), $1::bytea[] AS i, $2::int4[] AS d, $3::text[] AS h, $4::bytea[] AS n, $5::bytea[] AS e";
    const failing = "SELECT 1 / 0, $1::bytea[] AS i, $2::int4[] AS d, $3::text[] AS h, $4::bytea[] AS n, $5::bytea[] AS e";
    try testing.expectEqualStrings(try Lines.of(svc, a, slow, &plain, false), try Lines.of(svc, a, slow, &literal, false));
    try testing.expectEqualStrings(try Lines.of(svc, a, failing, &plain, true), try Lines.of(svc, a, failing, &literal, true));
}

// ---------------------------------------------------------------------------
// The listener hub: one thread serves every LISTEN connection; a stalled or
// failing connection never delays another's notifications.

/// A TCP proxy to the test server whose forwarding can be cut off (a
/// blackhole: sockets stay open, nothing passes either way).
const HoleProxy = struct {
    listen_fd: std.posix.socket_t,
    port: u16,
    /// The test server's host and port, as its URL names them (not always
    /// loopback: the Linux runs reach it on the bench network).
    upstream_host: []const u8,
    upstream_port: u16,
    blackhole: std.atomic.Value(bool) = .init(false),
    done: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,

    fn start(upstream_host: []const u8, upstream_port: u16) !*HoleProxy {
        const self = try testing.allocator.create(HoleProxy);
        errdefer testing.allocator.destroy(self);
        const fd = try std.posix.socket(std.posix.AF.INET, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC, 0);
        var address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 0);
        try std.posix.bind(fd, &address.any, address.getOsSockLen());
        try std.posix.listen(fd, 4);
        var len = address.getOsSockLen();
        try std.posix.getsockname(fd, &address.any, &len);
        self.* = .{ .listen_fd = fd, .port = address.getPort(), .upstream_host = upstream_host, .upstream_port = upstream_port };
        self.thread = try std.Thread.spawn(.{}, serve, .{self});
        return self;
    }

    fn serve(self: *HoleProxy) void {
        const client = std.posix.accept(self.listen_fd, null, null, std.posix.SOCK.CLOEXEC) catch return;
        defer std.posix.close(client);
        const server = std.net.tcpConnectToHost(std.heap.page_allocator, self.upstream_host, self.upstream_port) catch return;
        defer server.close();
        var buf: [16384]u8 = undefined;
        while (!self.done.load(.acquire)) {
            var fds = [_]std.posix.pollfd{
                .{ .fd = client, .events = std.posix.POLL.IN, .revents = 0 },
                .{ .fd = server.handle, .events = std.posix.POLL.IN, .revents = 0 },
            };
            _ = std.posix.poll(&fds, 10) catch return;
            if (self.blackhole.load(.acquire)) continue;
            for ([_][2]std.posix.socket_t{ .{ client, server.handle }, .{ server.handle, client } }, fds) |pair, fd| {
                if (fd.revents == 0) continue;
                const n = std.posix.read(pair[0], &buf) catch return;
                if (n == 0) return;
                _ = std.posix.write(pair[1], buf[0..n]) catch return;
            }
        }
    }

    fn stop(self: *HoleProxy) void {
        self.done.store(true, .release);
        // Unblock a serve() still in accept().
        if (std.net.tcpConnectToAddress(std.net.Address.initIp4(.{ 127, 0, 0, 1 }, self.port))) |s| s.close() else |_| {}
        if (self.thread) |t| t.join();
        std.posix.close(self.listen_fd);
        testing.allocator.destroy(self);
    }
};

/// `url` with its host:port replaced by 127.0.0.1:`port`.
fn throughPort(a: std.mem.Allocator, url: []const u8, port: u16) ![]const u8 {
    const uri = try std.Uri.parse(url);
    const host = switch (uri.host.?) {
        .raw, .percent_encoded => |h| h,
    };
    const old = try std.fmt.allocPrint(a, "@{s}:{d}/", .{ host, uri.port orelse 5432 });
    const new = try std.fmt.allocPrint(a, "@127.0.0.1:{d}/", .{port});
    return std.mem.replaceOwned(u8, a, url, old, new);
}

const LatencyCapture = struct {
    mutex: std.Thread.Mutex = .{},
    received: std.ArrayList(i64) = .empty,
    /// The first disconnect (a later one must not move it).
    disconnected_at: ?i64 = null,
    disconnects: usize = 0,

    fn onNotification(ctx: *anyopaque, _: []const u8, _: []const u8) void {
        const self: *LatencyCapture = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.received.append(testing.allocator, std.time.milliTimestamp()) catch {};
    }
    fn onDisconnect(ctx: *anyopaque, _: ?[]const u8) void {
        const self: *LatencyCapture = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.disconnects += 1;
        if (self.disconnected_at == null) self.disconnected_at = std.time.milliTimestamp();
    }
    fn count(self: *LatencyCapture) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.received.items.len;
    }
};

/// One healthy and one blackholed listener on the hub: the healthy one's
/// NOTIFYs arrive promptly throughout the other's stalled health check, and
/// the stalled one is still detected on time (health interval + query timeout).
const HubFault = enum { blackhole, kill };

extern "pq" fn PQbackendPID(conn: *const anyopaque) c_int;

fn hubIsolation(blackholed_first: bool, fault: HubFault) !void {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const uri = try std.Uri.parse(url);
    const host = switch (uri.host.?) {
        .raw, .percent_encoded => |h| h,
    };
    const proxy = try HoleProxy.start(host, uri.port orelse 5432);
    defer proxy.stop();
    const proxied = try throughPort(a, url, proxy.port);
    var healthy: LatencyCapture = .{};
    defer healthy.received.deinit(testing.allocator);
    var stalled: LatencyCapture = .{};
    defer stalled.received.deinit(testing.allocator);
    const health_ms = 200;
    const timeout_ms = 400;
    // Per process: concurrent runs on one server must not see each other's
    // NOTIFYs (and the kill below targets one backend by PID).
    const bad_channel = try uniqueChannel(a, "hub_iso_bad");
    const good_channel = try uniqueChannel(a, "hub_iso_good");
    // Registration order varies so either may be first in the hub's pass.
    var bad: *listener_mod.Listener = undefined;
    var good: *listener_mod.Listener = undefined;
    const startBad = struct {
        fn f(al: std.mem.Allocator, u: []const u8, channel: []const u8, cap: *LatencyCapture) !*listener_mod.Listener {
            return listener_mod.Listener.start(testing.allocator, .{ .conninfo = u, .query_timeout_ms = timeout_ms }, &.{channel}, .{ .ctx = cap, .on_notification = LatencyCapture.onNotification, .on_disconnect = LatencyCapture.onDisconnect }, .{ .health_check_ms = health_ms }, al, null);
        }
    }.f;
    const startGood = struct {
        fn f(al: std.mem.Allocator, u: []const u8, channel: []const u8, cap: *LatencyCapture) !*listener_mod.Listener {
            return listener_mod.Listener.start(testing.allocator, .{ .conninfo = u }, &.{channel}, .{ .ctx = cap, .on_notification = LatencyCapture.onNotification, .on_disconnect = LatencyCapture.onDisconnect }, .{}, al, null);
        }
    }.f;
    if (blackholed_first) {
        bad = try startBad(a, proxied, bad_channel, &stalled);
        good = try startGood(a, url, good_channel, &healthy);
    } else {
        good = try startGood(a, url, good_channel, &healthy);
        bad = try startBad(a, proxied, bad_channel, &stalled);
    }
    defer good.stop();
    defer bad.stop();
    const notifier = try pool_mod.Pool.init(testing.allocator, .{ .conn = .{ .conninfo = url }, .max = 1 });
    defer notifier.deinit();
    // The owner's reconnect, on its own thread as live's and diagnostics'
    // are: one attempt at the faulted address (never answered when
    // blackholed: it waits out its connect timeout), then a fresh listener
    // on a reachable one, registered with the hub while it serves the
    // healthy listener.
    const Reconnect = struct {
        stalled: *LatencyCapture,
        channel: []const u8,
        faulted_url: []const u8,
        url: []const u8,
        listener: ?*listener_mod.Listener = null,
        attempt_ms: i64 = 0,
        registered_at: ?i64 = null,
        /// Set once `run` is over (`listener`/`registered_at` final).
        done: std.atomic.Value(bool) = .init(false),
        fn run(self: *@This()) void {
            while (true) {
                self.stalled.mutex.lock();
                const down = self.stalled.disconnected_at != null;
                self.stalled.mutex.unlock();
                if (down) break;
                std.Thread.sleep(std.time.ns_per_ms);
            }
            var scratch = std.heap.ArenaAllocator.init(testing.allocator);
            defer scratch.deinit();
            const started = std.time.milliTimestamp();
            if (listener_mod.Listener.start(testing.allocator, .{ .conninfo = self.faulted_url, .connect_timeout_ms = 300 }, &.{self.channel}, .{ .ctx = self.stalled, .on_notification = LatencyCapture.onNotification, .on_disconnect = LatencyCapture.onDisconnect }, .{}, scratch.allocator(), null)) |l| {
                // Reachable after all (the kill fault): use it.
                self.listener = l;
            } else |_| {
                self.listener = listener_mod.Listener.start(testing.allocator, .{ .conninfo = self.url }, &.{self.channel}, .{ .ctx = self.stalled, .on_notification = LatencyCapture.onNotification, .on_disconnect = LatencyCapture.onDisconnect }, .{}, scratch.allocator(), null) catch null;
            }
            self.attempt_ms = std.time.milliTimestamp() - started;
            if (self.listener != null) self.registered_at = std.time.milliTimestamp();
            self.done.store(true, .release);
        }
    };
    var reconnect: Reconnect = .{ .stalled = &stalled, .channel = bad_channel, .faulted_url = proxied, .url = url };
    const reconnector = try std.Thread.spawn(.{}, Reconnect.run, .{&reconnect});
    var reconnector_joined = false;
    defer if (!reconnector_joined) {
        stalled.mutex.lock();
        if (stalled.disconnected_at == null) stalled.disconnected_at = 0;
        stalled.mutex.unlock();
        reconnector.join();
        if (reconnect.listener) |l| l.stop();
    };
    // The fault lands anywhere in the health cycle (idle, check in flight).
    const bad_pid = PQbackendPID(bad.conn.pg);
    std.Thread.sleep(std.crypto.random.intRangeLessThan(u64, 0, health_ms + 50) * std.time.ns_per_ms);
    const cut = std.time.milliTimestamp();
    // The kill's own round trip (included in `detection`), for diagnosis.
    var fault_ms: i64 = 0;
    switch (fault) {
        .blackhole => proxy.blackhole.store(true, .release),
        // The database side goes away: exactly its backend is terminated (by
        // PID: after a health check its query text is `SELECT 1`).
        .kill => {
            const killed = try notifier.query(a, "SELECT pg_terminate_backend($1)", &.{.{ .number = @floatFromInt(bad_pid) }}, null);
            try testing.expectEqual(@as(?core.json.Value, .{ .bool = true }), killed.rows[0].get("pg_terminate_backend"));
            fault_ms = std.time.milliTimestamp() - cut;
        },
    }
    // At least 50 NOTIFYs over ~1.5 s, and on until one is sent after the
    // reconnect is over (bounded): across the bad one's health send, its
    // stall, its timeout, the hub closing it (PQfinish's Terminate included),
    // the owner's failed attempt at the faulted address and the new
    // listener's registration.
    const notify_good = try std.fmt.allocPrint(a, "NOTIFY \"{s}\"", .{good_channel});
    // Delivery is measured from the NOTIFY query's return (sent and
    // committed; it can arrive before the reply, so this may be negative)
    // and, as a sanity bound that also includes that query's round trip,
    // from before it was sent.
    var max_latency: i64 = 0;
    var max_after_commit: i64 = std.math.minInt(i64);
    const window_end = deadlineAfter(wait_bound_ms);
    var i: usize = 0;
    while (true) : (i += 1) {
        const reconnected = reconnect.done.load(.acquire);
        const before = healthy.count();
        const sent = std.time.milliTimestamp();
        _ = try notifier.query(a, notify_good, &.{}, null);
        const committed = std.time.milliTimestamp();
        var waited: usize = 0;
        while (healthy.count() == before and waited < 2000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
        try testing.expect(healthy.count() > before);
        healthy.mutex.lock();
        const got = healthy.received.items[healthy.received.items.len - 1];
        healthy.mutex.unlock();
        max_latency = @max(max_latency, got - sent);
        max_after_commit = @max(max_after_commit, got - committed);
        if (i + 1 >= 50 and reconnected) break;
        if (std.time.milliTimestamp() > window_end) break;
        std.Thread.sleep(30 * std.time.ns_per_ms);
    }
    // Detection: the health SELECT 1 is due ≤ health_ms after the cut and
    // times out timeout_ms later.
    var waited: usize = 0;
    while (waited < 3000) : (waited += 10) {
        stalled.mutex.lock();
        const at = stalled.disconnected_at;
        stalled.mutex.unlock();
        if (at != null) break;
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
    stalled.mutex.lock();
    const detected = stalled.disconnected_at;
    stalled.mutex.unlock();
    try testing.expect(detected != null);
    const detection = detected.? - cut;
    reconnector.join();
    reconnector_joined = true;
    defer if (reconnect.listener) |l| l.stop();
    try testing.expect(reconnect.registered_at != null);
    // The window measured above covers the reconnect.
    healthy.mutex.lock();
    const last_received = healthy.received.items[healthy.received.items.len - 1];
    healthy.mutex.unlock();
    try testing.expect(reconnect.registered_at.? <= last_received);
    std.debug.print("hub isolation ({s}): close + reconnect attempt {d} ms, re-registered {d} ms after the fault\n", .{ @tagName(fault), reconnect.attempt_ms, reconnect.registered_at.? - cut });
    std.debug.print("hub isolation ({s} {s}): healthy NOTIFY max latency {d} ms ({d} ms after its query returned); failed one detected after {d} ms (fault applied in {d} ms)\n", .{ @tagName(fault), if (blackholed_first) "first" else "second", max_latency, max_after_commit, detection, fault_ms });
    // Serialising behind the stalled connection would show as its timeout
    // (timeout_ms) or more: half of that leaves room for a scheduler hiccup.
    try testing.expect(max_after_commit < timeout_ms / 2);
    try testing.expect(max_latency <= 250);
    if (fault == .kill) {
        // A terminated backend is seen at its socket's EOF, not by the health
        // check: soon after the kill query returns (150 ms bound). (Measured from the
        // cut, detection also includes that query's own round trip, which a
        // saturated machine stretches; the cut-based bound is a sanity check.)
        try testing.expect(detection - fault_ms <= 150);
        try testing.expect(detection <= 250);
    } else try testing.expect(detection <= health_ms + timeout_ms + 150);
    stalled.mutex.lock();
    const stalled_disconnects = stalled.disconnects;
    stalled.mutex.unlock();
    // Only the faulted connection went (the reconnected one stays up).
    try testing.expectEqual(@as(usize, 1), stalled_disconnects);
    healthy.mutex.lock();
    const good_disconnected = healthy.disconnected_at;
    healthy.mutex.unlock();
    try testing.expect(good_disconnected == null);
}

test "listener hub: a blackholed connection never delays another's notifications (registered first)" {
    try hubIsolation(true, .blackhole);
}

test "listener hub: a blackholed connection never delays another's notifications (registered second)" {
    try hubIsolation(false, .blackhole);
}

test "listener hub: a connection whose database goes away never delays another's notifications (first)" {
    try hubIsolation(true, .kill);
}

test "listener hub: a connection whose database goes away never delays another's notifications (second)" {
    try hubIsolation(false, .kill);
}

test "listener hub: a failing health query's error survives until its reply completes" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var conn = try pq.Conn.connect(.{ .conninfo = url }, a, null);
    defer conn.deinit();
    var state: pq.Conn.SimpleState = .{};
    try conn.sendSimple("SELECT 1; SELECT 1/0; SELECT 2");
    const until = pq.nowMs() + wait_bound_ms;
    while (!try conn.flushPending()) {
        if (pq.nowMs() > until) return error.Timeout;
        _ = pq.waitSocket(conn.socket(), std.posix.POLL.OUT, until);
    }
    // (Whether the error and the end of the reply arrive in one read or
    // two, the failure must be reported once the reply completes.)
    const outcome = while (true) {
        if (pq.nowMs() > until) return error.Timeout;
        _ = pq.waitSocket(conn.socket(), std.posix.POLL.IN, until);
        try conn.consumeInput(true);
        const result = conn.takeSimple(&state);
        if (result != .busy) break result;
    };
    try testing.expect(outcome == .failed);
    try testing.expectEqualStrings("division by zero", outcome.failed);
    try testing.expectEqual(@as(?usize, null), state.failed_len);
    // A healthy query afterwards reports ok.
    try conn.sendSimple("SELECT 1");
    const again = pq.nowMs() + wait_bound_ms;
    while (!try conn.flushPending()) {
        if (pq.nowMs() > again) return error.Timeout;
        _ = pq.waitSocket(conn.socket(), std.posix.POLL.OUT, again);
    }
    const healthy = while (true) {
        if (pq.nowMs() > again) return error.Timeout;
        _ = pq.waitSocket(conn.socket(), std.posix.POLL.IN, again);
        try conn.consumeInput(true);
        const result = conn.takeSimple(&state);
        if (result != .busy) break result;
    };
    try testing.expect(healthy == .ok);
}

test "listener hub: stopping the last listener and registering the next at once, 1,000 times" {
    const url = testUrl() orelse return error.SkipZigTest;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var capture: LatencyCapture = .{};
    defer capture.received.deinit(testing.allocator);
    var threads: listener_mod.ThreadCount = .init(0);
    // Each stop releases the hub's last listener, so the hub closes its
    // connection and heads for exit while the next start registers (and may
    // start a new hub): the two must never share a list.
    for (0..1000) |_| {
        _ = arena.reset(.retain_capacity);
        const l = try listener_mod.Listener.start(testing.allocator, .{ .conninfo = url }, &.{try uniqueChannel(arena.allocator(), "hub_restart")}, .{ .ctx = &capture, .on_notification = LatencyCapture.onNotification, .on_disconnect = LatencyCapture.onDisconnect }, .{ .threads = &threads }, arena.allocator(), null);
        l.stop();
    }
    try testing.expect(listener_mod.awaitThreads(&threads, 5_000));
    capture.mutex.lock();
    defer capture.mutex.unlock();
    try testing.expectEqual(@as(?i64, null), capture.disconnected_at);
}
