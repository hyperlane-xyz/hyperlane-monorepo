//! Readable ports of `sql.test.ts` and the SQL parts of `schema.test.ts`.
//! `corpus_test.zig` covers the same cases (and more) differentially.
const std = @import("std");
const testing = std.testing;
const Allocator = std.mem.Allocator;

const service = @import("service.zig");
const sql = @import("sql.zig");
const Table = @import("tables.zig").Table;
const value = @import("value.zig");
const Value = value.Value;

const Built = union(enum) { ok: sql.Sql, err: []const u8 };

fn args(arena: Allocator, json_text: []const u8) !sql.SelectArgs {
    const obj = value.object(try value.parseLeaky(arena, json_text)).?;
    var columns: ?[]const []const u8 = null;
    if (value.get(obj, "columns")) |list| {
        const items = value.array(list).?;
        const out = try arena.alloc([]const u8, items.len);
        for (items, 0..) |item, i| out[i] = value.string(item).?;
        columns = out;
    }
    return .{
        .columns = columns,
        .cursor = value.get(obj, "cursor"),
        .distinct_on = value.get(obj, "distinct_on"),
        .limit = value.get(obj, "limit"),
        .offset = value.get(obj, "offset"),
        .order_by = value.get(obj, "order_by"),
        .where = value.get(obj, "where"),
    };
}

fn select(arena: Allocator, table: Table, json_text: []const u8) !Built {
    var diag: sql.Diag = .{};
    const query = sql.buildSelect(arena, table, try args(arena, json_text), null, &diag) catch |err| switch (err) {
        error.AssertionFailed => return .{ .err = diag.message },
        else => return err,
    };
    return .{ .ok = query };
}

fn count(arena: Allocator, table: Table, json_text: []const u8, count_json: []const u8) !Built {
    var diag: sql.Diag = .{};
    const count_obj = value.object(try value.parseLeaky(arena, count_json)).?;
    const query = sql.buildCount(arena, table, try args(arena, json_text), .{
        .columns = value.get(count_obj, "columns"),
        .distinct = value.get(count_obj, "distinct"),
    }, &diag) catch |err| switch (err) {
        error.AssertionFailed => return .{ .err = diag.message },
        else => return err,
    };
    return .{ .ok = query };
}

fn expectSql(built: Built, expected_sql: []const u8, expected_values: []const u8) !void {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    try testing.expectEqualStrings(expected_sql, built.ok.sql);
    try testing.expectEqualStrings(expected_values, try value.stringifyAlloc(arena_state.allocator(), built.ok.values));
}

fn expectError(built: Built, needle: []const u8) !void {
    switch (built) {
        .ok => |q| {
            std.debug.print("expected error containing '{s}', got sql {s}\n", .{ needle, q.sql });
            return error.TestExpectedError;
        },
        .err => |message| if (std.mem.indexOf(u8, message, needle) == null) {
            std.debug.print("error '{s}' lacks '{s}'\n", .{ message, needle });
            return error.TestUnexpectedError;
        },
    }
}

fn contains(haystack: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, haystack, needle) != null;
}

const mv_relation = "(SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\"";

test "builds bounded parameterized selects" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try expectSql(try select(a, .domain,
        \\{"columns":["id","name","unknown"],"limit":5,"offset":2,"order_by":{"id":"desc_nulls_first"},
        \\ "where":{"_or":[{"id":{"_gte":1}},{"name":{"_eq":"ethereum"}}]}}
    ), "SELECT \"id\", \"name\" FROM \"domain\" WHERE ((((\"id\" >= $1)) OR ((\"name\" = $2)))) ORDER BY \"id\" DESC NULLS FIRST LIMIT $3 OFFSET $4", "[1,\"ethereum\",5,2]");
}

test "preserves parameters supplied by a custom relation" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var diag: sql.Diag = .{};
    const zero: Value = value.integer(0);
    const query = try sql.buildSelect(a, .message_view, try args(a,
        \\{"limit":5,"where":{"origin_domain_id":{"_eq":1}}}
    ), .{ .relation = "provisional_message_view", .values = &.{zero} }, &diag);
    try testing.expect(std.mem.endsWith(u8, query.sql, "FROM \"provisional_message_view\" WHERE ((\"origin_domain_id\" = $2)) LIMIT $3"));
    try testing.expectEqualStrings("[0,1,5]", try value.stringifyAlloc(a, query.values));
}

test "filters every dispatch read through confirmed history" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var diag: sql.Diag = .{};
    for ([_][]const u8{
        (try select(a, .raw_message_dispatch, "{}")).ok.sql,
        (try count(a, .raw_message_dispatch, "{}", "{}")).ok.sql,
        (try sql.buildByPk(a, .raw_message_dispatch, value.integer(1), null, &diag)).sql,
    }) |text| try testing.expect(contains(text, "FROM \"confirmed_raw_message_dispatch\""));
}

test "builds cursor ordering and windowed counts" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const cursor = (try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":10},"ordering":"DESC"}]}
    )).ok;
    try testing.expect(std.mem.endsWith(u8, cursor.sql, "WHERE (\"id\" < $1) ORDER BY \"id\" DESC LIMIT $2"));
    try testing.expectEqualStrings("[10,500]", try value.stringifyAlloc(a, cursor.values));
    try expectSql(
        try count(a, .message_view,
            \\{"distinct_on":["origin_domain"],"limit":2,"offset":1}
        , "{}"),
        "SELECT COUNT(*)::int AS count FROM (SELECT DISTINCT ON (\"origin_domain\") 1 FROM " ++ mv_relation ++ " LIMIT $1 OFFSET $2) AS rows",
        "[2,1]",
    );
}

test "builds column and distinct aggregate counts" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try testing.expectEqualStrings(
        "SELECT COUNT(DISTINCT \"origin_domain\")::int AS count FROM " ++ mv_relation,
        (try count(a, .message_view, "{}",
            \\{"columns":["origin_domain"],"distinct":true}
        )).ok.sql,
    );
    try testing.expectEqualStrings(
        "SELECT COUNT(DISTINCT (\"origin_domain\", \"destination_domain\"))::int AS count FROM (SELECT \"origin_domain\", \"destination_domain\" FROM " ++ mv_relation ++ " ORDER BY \"nonce\" DESC LIMIT $1) AS rows",
        (try count(a, .message_view,
            \\{"limit":10,"order_by":{"nonce":"desc"}}
        ,
            \\{"columns":["origin_domain","destination_domain"],"distinct":true}
        )).ok.sql,
    );
}

test "rejects distinct_on ordering mismatches" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try expectError(try select(a, .message_view,
        \\{"distinct_on":["origin_domain"],"order_by":{"nonce":"desc"}}
    ), "leftmost order_by");
    _ = (try select(a, .message_view,
        \\{"distinct_on":["origin_domain"],"order_by":[{"origin_domain":"asc"},{"nonce":"desc"}]}
    )).ok;
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":1}}],"distinct_on":["origin_domain"]}
    ), "leftmost order_by");
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":1}}],"distinct_on":["origin_domain"],"order_by":{"id":null}}
    ), "leftmost order_by");
}

test "builds primary-key queries and rejects unsafe inputs" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var diag: sql.Diag = .{};
    try testing.expectEqualStrings(
        "SELECT \"name\" FROM \"domain\" WHERE \"id\" = $1 LIMIT 1",
        (try sql.buildByPk(a, .domain, value.integer(1), &.{"name"}, &diag)).sql,
    );
    try testing.expectError(error.AssertionFailed, sql.buildByPk(a, .message_view, value.integer(1), null, &diag));
    try testing.expect(contains(diag.message, "primary-key"));
    try expectError(try select(a, .domain, "{\"limit\":501}"), "maximum");
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":1},"ordering":"DESC"}],"order_by":{"id":"asc"}}
    ), "must match order_by");
    _ = (try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":1},"ordering":"ASC"}],"order_by":{"id":"asc"}}
    )).ok;
    _ = (try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":1},"ordering":"DESC"}],"order_by":{"id":"desc"}}
    )).ok;
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"send_occurred_at":"2026-01-01","id":1}}]}
    ), "must contain one column");
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{}}]}
    ), "must contain one column");
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"origin_domain":"ethereum"}}]}
    ), "cursor column must be id");
    try expectError(try select(a, .message_view,
        \\{"cursor":[{"initial_value":{"id":null}}]}
    ), "cursor value must be non-null");
    var in_list: std.Io.Writer.Allocating = .init(a);
    try in_list.writer.writeAll("{\"where\":{\"id\":{\"_in\":[1");
    for (0..200) |_| try in_list.writer.writeAll(",1");
    try in_list.writer.writeAll("]}}}");
    try expectError(try select(a, .domain, in_list.written()), "maximum");
    try expectError(try select(a, .domain,
        \\{"where":{"id":{"_contains":"x"}}}
    ), "Unsupported comparison operator");
}

test "bounds predicate depth and work even when an empty OR would match everything" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const predicate = "{\"id\":{\"_eq\":1}}";
    var nested: []const u8 = predicate;
    for (0..8) |_| nested = try std.fmt.allocPrint(a, "{{\"_not\":{s}}}", .{nested});
    _ = (try select(a, .domain, try std.fmt.allocPrint(a, "{{\"where\":{s}}}", .{nested}))).ok;
    try expectError(try select(a, .domain, try std.fmt.allocPrint(a, "{{\"where\":{{\"_not\":{s}}}}}", .{nested})), "maximum depth");

    var predicates: std.Io.Writer.Allocating = .init(a);
    for (0..50) |i| try predicates.writer.print("{s}{s}", .{ if (i == 0) "" else ",", predicate });
    _ = (try select(a, .domain, try std.fmt.allocPrint(a, "{{\"where\":{{\"_and\":[{s}]}}}}", .{predicates.written()}))).ok;
    try expectError(
        try select(a, .domain, try std.fmt.allocPrint(a, "{{\"where\":{{\"_or\":[{{}},{s}]}}}}", .{predicates.written()})),
        "maximum of 100 predicates",
    );
}

test "treats nullable optional arguments as omitted" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const query = (try select(a, .domain,
        \\{"limit":null,"offset":null,"order_by":{"id":null}}
    )).ok;
    try testing.expect(!contains(query.sql, "ORDER BY") and !contains(query.sql, "OFFSET"));
    try testing.expect(std.mem.endsWith(u8, query.sql, "LIMIT $1"));
    try testing.expectEqualStrings("[500]", try value.stringifyAlloc(a, query.values));
}

test "rejects expensive public pattern operators" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    for ([_][]const u8{ "_like", "_ilike", "_regex", "_similar" }) |operator| {
        const text = try std.fmt.allocPrint(a, "{{\"where\":{{\"name\":{{\"{s}\":\"eth%\"}}}}}}", .{operator});
        try expectError(try select(a, .domain, text), "Unsupported comparison operator");
    }
}

test "empty OR, empty OR child, empty NOT and null comparisons" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    try testing.expect(contains((try select(a, .domain, "{\"where\":{\"_or\":[]}}")).ok.sql, "WHERE (FALSE)"));
    const child = (try select(a, .domain,
        \\{"where":{"_or":[{"id":{"_eq":1}},{}]}}
    )).ok;
    try testing.expect(!contains(child.sql, "WHERE"));
    try testing.expectEqualStrings("[500]", try value.stringifyAlloc(a, child.values));
    try testing.expect(contains((try select(a, .domain, "{\"where\":{\"_not\":{}}}")).ok.sql, "WHERE (FALSE)"));
    try testing.expect(!contains((try select(a, .domain,
        \\{"where":{"id":{"_is_null":null}}}
    )).ok.sql, "WHERE"));
}

test "binds IN lists as PostgreSQL arrays" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const query = (try select(a, .domain,
        \\{"where":{"id":{"_in":[1,2,3],"_nin":[4,5]}}}
    )).ok;
    try testing.expect(contains(query.sql, "\"id\" = ANY($1)"));
    try testing.expect(contains(query.sql, "\"id\" <> ALL($2)"));
    try testing.expectEqualStrings("[[1,2,3],[4,5],500]", try value.stringifyAlloc(a, query.values));
}

// ---- schema.test.ts (service paths) ----

/// TS `cheapPlan`: the cost check's EXPLAIN result for fakes.
fn cheapPlan(arena: Allocator) ![]Value {
    return try arena.dupe(Value, &.{try value.parseLeaky(arena, "{\"QUERY PLAN\":[{\"Plan\":{\"Total Cost\":1}}]}")});
}

fn isExplain(text: []const u8) bool {
    return std.mem.startsWith(u8, text, "EXPLAIN");
}

const RecordingDb = struct {
    arena: Allocator,
    calls: usize = 0,
    first_sql: []const u8 = "",
    first_values: []const Value = &.{},
    snapshot: ?Value = null,
    fail_on_query: bool = false,

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *sql.Diag) anyerror![]Value {
        _ = diag;
        const self: *RecordingDb = @ptrCast(@alignCast(ctx));
        if (self.fail_on_query) return error.UnexpectedDatabaseQuery;
        if (isExplain(text)) return cheapPlan(arena);
        self.calls += 1;
        if (self.calls == 1) {
            self.first_sql = text;
            self.first_values = try self.arena.dupe(Value, values);
            if (self.snapshot) |row| return try arena.dupe(Value, &.{row});
        }
        return &.{};
    }

    fn db(self: *RecordingDb) service.Database {
        return .{ .ctx = self, .queryFn = query };
    }
};

fn selectMessages(a: Allocator, db: *RecordingDb, json_args: []const u8, diag: *sql.Diag) anyerror![]Value {
    const parsed = value.object(try value.parseLeaky(a, json_args)).?;
    var budget: service.HistoryBudget = .{};
    return service.Service.init(db.db()).selectMessages(a, &budget, .{
        .select = try args(a, json_args),
        .confirmations = value.get(parsed, "confirmations"),
    }, diag);
}

test "rejects invalid confirmations before querying the database" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var db: RecordingDb = .{ .arena = a, .fail_on_query = true };
    var diag: sql.Diag = .{};
    try testing.expectError(error.AssertionFailed, selectMessages(a, &db, "{\"confirmations\":-1}", &diag));
    try testing.expect(contains(diag.message, "non-negative"));
    for ([_][]const u8{ "1001", "100000", "2147483647" }) |n| {
        try testing.expectError(error.AssertionFailed, selectMessages(a, &db, try std.fmt.allocPrint(a, "{{\"confirmations\":{s}}}", .{n}), &diag));
        try testing.expect(contains(diag.message, "maximum of 1000"));
    }
    try testing.expectError(error.AssertionFailed, selectMessages(a, &db,
        \\{"confirmations":0,"cursor":[{"initial_value":{"id":2},"ordering":"DESC"}]}
    , &diag));
    try testing.expect(contains(diag.message, "paginate canonical history separately"));
    try testing.expectError(error.AssertionFailed, selectMessages(a, &db, "{\"confirmations\":0,\"offset\":1}", &diag));
    try testing.expect(contains(diag.message, "offset"));
}

test "rejects non-number confirmations with the safe-integer assert" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    // Callers other than the route (GraphQL Int coercion) may pass anything.
    for ([_][]const u8{ "\"1\"", "true", "{}", "[0]", "1.5", "-1", "9007199254740992" }) |json| {
        var diag: sql.Diag = .{};
        try testing.expectError(error.AssertionFailed, service.buildMessageQueries(a, .{}, try value.parseLeaky(a, json), &diag));
        try testing.expectEqualStrings("confirmations must be a non-negative safe integer", diag.message);
    }
    var diag: sql.Diag = .{};
    _ = try service.buildMessageQueries(a, .{}, .{ .number = 0 }, &diag);
    _ = try service.buildMessageQueries(a, .{}, .{ .number = 1000 }, &diag);
    try testing.expectError(error.AssertionFailed, service.buildMessageQueries(a, .{}, .{ .number = 1001 }, &diag));
    try testing.expectEqualStrings("confirmations exceeds maximum of 1000", diag.message);
}

test "bounds affected scans using necessary message ID predicates" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const cases = [_]struct { where: []const u8, expected: []const u8 }{
        .{ .where = "{\"msg_id\":{\"_eq\":\"\\\\x01\"}}", .expected = "[1000,[\"\\\\x01\"]]" },
        .{ .where = "{\"_and\":[{\"sender\":{\"_eq\":\"\\\\x99\"}},{\"msg_id\":{\"_in\":[\"\\\\x01\",\"\\\\x02\"]}}]}", .expected = "[1000,[\"\\\\x01\",\"\\\\x02\"]]" },
        .{ .where = "{\"_or\":[{\"msg_id\":{\"_eq\":\"\\\\x01\"}},{\"msg_id\":{\"_in\":[\"\\\\x02\"]}}]}", .expected = "[1000,[\"\\\\x01\",\"\\\\x02\"]]" },
        .{ .where = "{\"_or\":[{\"msg_id\":{\"_eq\":\"\\\\x01\"}},{\"sender\":{\"_eq\":\"\\\\x99\"}}]}", .expected = "[1000]" },
        .{ .where = "{\"_not\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}", .expected = "[1000]" },
        .{ .where = "{\"_or\":[]}", .expected = "[1000,[]]" },
    };
    for (cases) |case| {
        var db: RecordingDb = .{ .arena = a, .snapshot = try value.parseLeaky(a,
            \\{"message_ids":[],"domains":[],"heights":[]}
        ) };
        var diag: sql.Diag = .{};
        _ = try selectMessages(a, &db, try std.fmt.allocPrint(a, "{{\"confirmations\":1000,\"where\":{s}}}", .{case.where}), &diag);
        try testing.expectEqualStrings(case.expected, try value.stringifyAlloc(a, db.first_values));
        try testing.expect(contains(db.first_sql, "UNION ALL"));
        try testing.expect(contains(db.first_sql, "LIMIT 10001"));
        try testing.expect(!contains(db.first_sql, "LATERAL (\n    SELECT delivery"));
        try testing.expectEqual(@as(usize, 2), db.calls);
    }
}

test "rejects excessive affected events before running a projection" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var db: RecordingDb = .{ .arena = a, .snapshot = try value.parseLeaky(a, "{\"message_ids\":null}") };
    var diag: sql.Diag = .{};
    try testing.expectError(error.AssertionFailed, selectMessages(a, &db, "{\"confirmations\":0}", &diag));
    try testing.expect(contains(diag.message, "10000 affected events"));
    try testing.expectEqual(@as(usize, 1), db.calls);
}

test "routes only unique-key lookups and confirmation snapshots to reusable plans" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const cases = [_]struct { where: []const u8, point: bool }{
        .{ .where = "{\"msg_id\":{\"_eq\":\"\\\\x01\"}}", .point = true },
        .{ .where = "{\"send_occurred_at\":{\"_is_null\":false},\"msg_id\":{\"_eq\":\"\\\\x01\"}}", .point = true },
        .{ .where = "{\"_and\":[{\"sender\":{\"_eq\":\"\\\\x99\"}},{\"id\":{\"_eq\":7}}]}", .point = true },
        .{ .where = "{\"msg_id\":{\"_eq\":null}}", .point = false },
        .{ .where = "{\"msg_id\":{\"_in\":[\"\\\\x01\"]}}", .point = false },
        .{ .where = "{\"_or\":[{\"msg_id\":{\"_eq\":\"\\\\x01\"}}]}", .point = false },
        .{ .where = "{\"_not\":{\"id\":{\"_eq\":1}}}", .point = false },
        .{ .where = "{\"sender\":{\"_eq\":\"\\\\x99\"}}", .point = false },
        .{ .where = "null", .point = false },
    };
    for (cases) |case| {
        try testing.expectEqual(case.point, service.isPointLookup(try value.parseLeaky(a, case.where)));
    }
    const Routing = struct {
        plans: std.ArrayList(service.Plan) = .empty,
        arena: Allocator,
        /// Affected message ids the reusable (snapshot) query returns.
        affected: usize = 0,
        fn snapshot(self: *@This(), arena: Allocator) ![]Value {
            const ids = try arena.alloc(Value, self.affected);
            for (ids) |*id| id.* = .{ .string = "\\x01" };
            const row = try value.parseLeaky(arena, "{\"message_ids\":[],\"domains\":[],\"heights\":[]}");
            for (row.object) |*member| {
                if (std.mem.eql(u8, member.key, "message_ids")) member.value = .{ .array = ids };
            }
            return try arena.dupe(Value, &.{row});
        }
        fn custom(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *sql.Diag) anyerror![]Value {
            if (isExplain(text)) return cheapPlan(arena);
            return planned(ctx, arena, .custom, text, values, diag);
        }
        fn planned(ctx: *anyopaque, arena: Allocator, plan: service.Plan, _: []const u8, _: []const Value, _: *sql.Diag) anyerror![]Value {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.plans.append(self.arena, plan) catch unreachable;
            // Snapshots are the reusable statements of these requests.
            return if (plan == .reusable) self.snapshot(arena) else try arena.dupe(Value, &.{});
        }
    };
    var routing: Routing = .{ .arena = a };
    const svc = service.Service.init(.{ .ctx = &routing, .queryFn = Routing.custom, .plannedQueryFn = Routing.planned });
    var diag: sql.Diag = .{};
    var budget: service.HistoryBudget = .{};
    _ = try svc.select(a, &budget, .message_view, try args(a, "{\"where\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}"), &diag);
    _ = try svc.select(a, &budget, .message_view, try args(a, "{\"where\":{\"sender\":{\"_eq\":\"\\\\x01\"}}}"), &diag);
    _ = try svc.byPk(a, .raw_message_dispatch, .{ .string = "1" }, null, &diag);
    _ = try svc.selectMessages(a, &budget, .{ .select = try args(a, "{\"where\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}"), .confirmations = .{ .number = 0 } }, &diag);
    _ = try svc.selectMessages(a, &budget, .{ .select = try args(a, "{\"limit\":20}"), .confirmations = .{ .number = 2 } }, &diag);
    _ = try svc.selectMessages(a, &budget, .{ .select = try args(a, "{\"where\":{\"id\":{\"_eq\":7}}}"), .confirmations = .{ .number = 0 } }, &diag);
    // Confirmation projections not bounded by msg_id run without parallel
    // workers, on a reused generic plan while few messages are affected.
    try testing.expectEqualSlices(service.Plan, &.{ .reusable, .custom, .reusable, .reusable, .reusable, .reusable, .serial_generic, .reusable, .serial_generic }, routing.plans.items);
    const limit_args = try args(a, "{\"limit\":20}");
    for ([_]usize{ service.GENERIC_PROJECTION_MAX_IDS, service.GENERIC_PROJECTION_MAX_IDS + 1 }) |affected| {
        routing.plans.clearRetainingCapacity();
        routing.affected = affected;
        _ = try svc.selectMessages(a, &budget, .{ .select = limit_args, .confirmations = .{ .number = 2 } }, &diag);
        const projection: service.Plan = if (affected <= service.GENERIC_PROJECTION_MAX_IDS) .serial_generic else .serial;
        try testing.expectEqualSlices(service.Plan, &.{ .reusable, projection }, routing.plans.items);
    }
    // A select pinning a transaction hash, totally ordered by id, always
    // uses a generic plan; unordered, or pinning a tx sender (skewed), not.
    routing.plans.clearRetainingCapacity();
    const nn = "{\"send_occurred_at\":{\"_is_null\":false}}";
    const hash_cases = [_]struct { args: []const u8, plan: service.Plan }{
        .{ .args = "{\"where\":{\"_and\":[" ++ nn ++ ",{\"origin_tx_hash\":{\"_eq\":\"\\\\x01\"}}]},\"order_by\":{\"id\":\"desc\"},\"limit\":20}", .plan = .generic },
        .{ .args = "{\"where\":{\"destination_tx_hash\":{\"_eq\":\"\\\\x01\"}},\"order_by\":[{\"send_occurred_at\":\"desc\"},{\"id\":\"asc\"}]}", .plan = .generic },
        .{ .args = "{\"where\":{\"origin_tx_hash\":{\"_eq\":\"\\\\x01\"}},\"limit\":20}", .plan = .custom },
        .{ .args = "{\"where\":{\"origin_tx_hash\":{\"_in\":[\"\\\\x01\"]}},\"order_by\":{\"id\":\"desc\"}}", .plan = .custom },
        .{ .args = "{\"where\":{\"_or\":[{\"origin_tx_hash\":{\"_eq\":\"\\\\x01\"}}]},\"order_by\":{\"id\":\"desc\"}}", .plan = .custom },
        .{ .args = "{\"where\":{\"_and\":[" ++ nn ++ ",{\"destination_tx_sender\":{\"_eq\":\"\\\\x01\"}}]},\"order_by\":{\"id\":\"desc\"},\"limit\":20}", .plan = .custom },
        .{ .args = "{\"where\":{\"origin_tx_sender\":{\"_eq\":\"\\\\x01\"}},\"order_by\":{\"id\":\"desc\"}}", .plan = .custom },
        // A hash pins the rows whatever its siblings filter (bench DB: the
        // busiest relayer as sender, generic as fast as custom).
        .{ .args = "{\"where\":{\"_and\":[{\"origin_tx_hash\":{\"_eq\":\"\\\\x01\"}},{\"destination_tx_sender\":{\"_eq\":\"\\\\x02\"}}]},\"order_by\":{\"id\":\"desc\"}}", .plan = .generic },
        .{ .args = "{\"where\":{\"origin_tx_hash\":{\"_eq\":\"\\\\x01\"},\"origin_tx_sender\":{\"_eq\":\"\\\\x02\"}},\"order_by\":{\"id\":\"desc\"}}", .plan = .generic },
        .{ .args = "{\"where\":{\"msg_id\":{\"_eq\":\"\\\\x01\"},\"origin_tx_hash\":{\"_eq\":\"\\\\x01\"}},\"order_by\":{\"id\":\"desc\"}}", .plan = .reusable },
    };
    for (hash_cases) |case| {
        routing.plans.clearRetainingCapacity();
        _ = try svc.select(a, &budget, .message_view, try args(a, case.args), &diag);
        try testing.expectEqualSlices(service.Plan, &.{case.plan}, routing.plans.items);
    }
    // Unfiltered `domain` selects totally ordered by id reuse a generic
    // plan; filtered ones (a custom plan evaluates the filter's constants
    // while planning) or ordered by another column (ties) are planned per
    // call as before.
    const domain_cases = [_]struct { args: []const u8, plan: service.Plan }{
        .{ .args = "{\"order_by\":{\"id\":\"asc\"}}", .plan = .generic },
        .{ .args = "{\"order_by\":[{\"name\":\"asc\"},{\"id\":\"asc\"}],\"limit\":5}", .plan = .generic },
        .{ .args = "{\"where\":{\"is_test_net\":{\"_eq\":false}},\"order_by\":{\"id\":\"asc\"}}", .plan = .custom },
        .{ .args = "{\"where\":{\"_and\":[{\"id\":{\"_in\":[1,2]}},{\"name\":{\"_neq\":\"x\"}}]},\"order_by\":{\"id\":\"asc\"},\"limit\":0}", .plan = .custom },
        .{ .args = "{\"order_by\":{\"name\":\"asc\"}}", .plan = .custom },
        .{ .args = "{\"limit\":5}", .plan = .custom },
    };
    for (domain_cases) |case| {
        routing.plans.clearRetainingCapacity();
        _ = try svc.select(a, &budget, .domain, try args(a, case.args), &diag);
        try testing.expectEqualSlices(service.Plan, &.{case.plan}, routing.plans.items);
    }
    try testing.expect(!service.isMessageIdLookup(try value.parseLeaky(a, "{\"id\":{\"_eq\":7}}")));
    try testing.expect(service.isMessageIdLookup(try value.parseLeaky(a, "{\"_and\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}")));
}

// ---- TS #10076: history cost checks (scraperdb.service.ts historyQuery) ----

/// Records every call; EXPLAINs answer with the next scripted plan document
/// (JSON text of the `QUERY PLAN` row, or null for no row), statements with
/// one `{"count":1}` row.
const CostDb = struct {
    arena: Allocator,
    plans: []const ?[]const u8 = &.{},
    calls: std.ArrayList(Call) = .empty,

    const Call = struct { sql: []const u8, values: []const u8, plan: ?service.Plan };

    fn record(self: *CostDb, arena: Allocator, plan: ?service.Plan, text: []const u8, values: []const Value) ![]Value {
        try self.calls.append(self.arena, .{ .sql = text, .values = try value.stringifyAlloc(self.arena, Value{ .array = @constCast(values) }), .plan = plan });
        if (!isExplain(text)) return try arena.dupe(Value, &.{try value.parseLeaky(arena, "{\"count\":1}")});
        const next = self.plans[0];
        self.plans = self.plans[1..];
        const row = next orelse return &.{};
        return try arena.dupe(Value, &.{try value.parseLeaky(arena, row)});
    }

    /// Unplanned (node-pg's unnamed custom plan): `plan` recorded as null.
    fn custom(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, _: *sql.Diag) anyerror![]Value {
        const self: *CostDb = @ptrCast(@alignCast(ctx));
        return self.record(arena, null, text, values);
    }

    fn planned(ctx: *anyopaque, arena: Allocator, plan: service.Plan, text: []const u8, values: []const Value, _: *sql.Diag) anyerror![]Value {
        const self: *CostDb = @ptrCast(@alignCast(ctx));
        return self.record(arena, plan, text, values);
    }

    fn svc(self: *CostDb) service.Service {
        return service.Service.init(.{ .ctx = self, .queryFn = custom, .plannedQueryFn = planned });
    }
};

fn costPlan(comptime cost: []const u8) ?[]const u8 {
    return "{\"QUERY PLAN\":[{\"Plan\":{\"Total Cost\":" ++ cost ++ "}}]}";
}

test "checks each history statement's plan cost before running it" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const statement_message = "History query exceeds the database planning budget";
    const operation_message = "GraphQL operation exceeds its database planning budget";
    const select_args = try args(a, "{\"where\":{\"id\":{\"_eq\":\"123\"}},\"limit\":1}");

    // The EXPLAIN is the same SQL with the same values, unplanned, and
    // precedes the statement.
    {
        var db: CostDb = .{ .arena = a, .plans = &.{costPlan("1")} };
        var budget: service.HistoryBudget = .{};
        var diag: sql.Diag = .{};
        _ = try db.svc().select(a, &budget, .message_view, select_args, &diag);
        try testing.expectEqual(@as(usize, 2), db.calls.items.len);
        const explain = db.calls.items[0];
        const statement = db.calls.items[1];
        try testing.expectEqualStrings(try std.mem.concat(a, u8, &.{ "EXPLAIN (FORMAT JSON) ", statement.sql }), explain.sql);
        try testing.expectEqualStrings("[\"123\",1]", explain.values);
        try testing.expectEqualStrings(statement.values, explain.values);
        try testing.expectEqual(@as(?service.Plan, null), explain.plan);
        try testing.expectEqual(@as(?service.Plan, .reusable), statement.plan);
        try testing.expectEqual(service.OPERATION_PLAN_COST - 1, budget.remaining);
    }

    // Missing, malformed and over-limit plans fail closed with the statement
    // text, run nothing and leave the budget untouched, even when the
    // operation budget could not have covered them either.
    const bad_plans = [_]?[]const u8{
        null,
        "{\"QUERY PLAN\":[]}",
        "{\"QUERY PLAN\":{\"Plan\":{\"Total Cost\":1}}}",
        "{\"QUERY PLAN\":[{\"Plan\":{}}]}",
        costPlan("\"5\""),
        costPlan("null"),
        costPlan("-1"),
        costPlan("100000.5"),
        costPlan("100001"),
        costPlan("1e400"),
    };
    for (bad_plans) |plan| {
        var db: CostDb = .{ .arena = a, .plans = &.{plan} };
        var budget: service.HistoryBudget = .{ .remaining = 50_000 };
        var diag: sql.Diag = .{};
        try testing.expectError(error.AssertionFailed, db.svc().select(a, &budget, .raw_message_dispatch, select_args, &diag));
        try testing.expectEqualStrings(statement_message, diag.message);
        try testing.expectEqual(@as(usize, 1), db.calls.items.len);
        try testing.expectEqual(@as(f64, 50_000), budget.remaining);
    }

    // The operation budget: 100,000 is allowed per statement, and the
    // third such statement exceeds 250,000 without running.
    {
        var db: CostDb = .{ .arena = a, .plans = &.{ costPlan("100000"), costPlan("100000"), costPlan("100000"), costPlan("50000") } };
        var budget: service.HistoryBudget = .{};
        var diag: sql.Diag = .{};
        _ = try db.svc().select(a, &budget, .message_view, select_args, &diag);
        _ = try db.svc().count(a, &budget, .message_view, select_args, .{}, &diag);
        try testing.expectError(error.AssertionFailed, db.svc().select(a, &budget, .message_view, select_args, &diag));
        try testing.expectEqualStrings(operation_message, diag.message);
        try testing.expectEqual(@as(usize, 5), db.calls.items.len);
        try testing.expectEqual(@as(f64, 50_000), budget.remaining);
        // What is left still fits exactly.
        _ = try db.svc().select(a, &budget, .message_view, select_args, &diag);
        try testing.expectEqual(@as(f64, 0), budget.remaining);
    }
}

test "only history reads are cost-checked" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var budget: service.HistoryBudget = .{};
    var diag: sql.Diag = .{};

    // `domain` and `*_by_pk` run directly.
    var db: CostDb = .{ .arena = a };
    _ = try db.svc().select(a, &budget, .domain, try args(a, "{}"), &diag);
    _ = try db.svc().byPk(a, .raw_message_dispatch, .{ .string = "1" }, null, &diag);
    _ = try db.svc().byPk(a, .domain, .{ .number = 1 }, null, &diag);
    for (db.calls.items) |call| try testing.expect(!isExplain(call.sql));
    try testing.expectEqual(@as(usize, 3), db.calls.items.len);

    // Aggregate nodes (always history) and count: EXPLAIN, statement; no
    // selected nodes columns, no query.
    db = .{ .arena = a, .plans = &.{ costPlan("1"), costPlan("1") } };
    try testing.expectEqual(@as(usize, 0), (try db.svc().aggregateNodes(a, &budget, .message_view, .{}, null, &diag)).len);
    try testing.expectEqual(@as(usize, 0), db.calls.items.len);
    _ = try db.svc().aggregateNodes(a, &budget, .message_view, .{}, &.{"id"}, &diag);
    try testing.expectEqual(@as(i64, 1), try db.svc().count(a, &budget, .message_view, .{}, .{}, &diag));
    try testing.expectEqual(@as(usize, 4), db.calls.items.len);
    for (db.calls.items, 0..) |call, i| try testing.expectEqual(i % 2 == 0, isExplain(call.sql));
}

test "checks both statements of a confirmation read" {
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const Snapshot = struct {
        calls: std.ArrayList([]const u8) = .empty,
        arena: Allocator,
        fail_projection: bool = false,
        fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, _: []const Value, _: *sql.Diag) anyerror![]Value {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            try self.calls.append(self.arena, text);
            if (isExplain(text)) {
                // The projection's EXPLAIN (the third call) is over the limit.
                if (self.fail_projection and self.calls.items.len == 3)
                    return try arena.dupe(Value, &.{try value.parseLeaky(arena, costPlan("100001").?)});
                return cheapPlan(arena);
            }
            if (self.calls.items.len == 2) return try arena.dupe(Value, &.{try value.parseLeaky(arena, "{\"message_ids\":[],\"domains\":[],\"heights\":[]}")});
            return &.{};
        }
    };
    for ([_]f64{ 0, 2 }) |confirmations| {
        var db: Snapshot = .{ .arena = a };
        const svc = service.Service.init(.{ .ctx = &db, .queryFn = Snapshot.query });
        var budget: service.HistoryBudget = .{};
        var diag: sql.Diag = .{};
        _ = try svc.selectMessages(a, &budget, .{ .select = try args(a, "{\"limit\":20}"), .confirmations = .{ .number = confirmations } }, &diag);
        const calls = db.calls.items;
        try testing.expectEqual(@as(usize, 4), calls.len);
        for (calls, 0..) |call, i| try testing.expectEqual(i % 2 == 0, isExplain(call));
        try testing.expectEqualStrings(try std.mem.concat(a, u8, &.{ "EXPLAIN (FORMAT JSON) ", calls[1] }), calls[0]);
        try testing.expectEqualStrings(try std.mem.concat(a, u8, &.{ "EXPLAIN (FORMAT JSON) ", calls[3] }), calls[2]);
        // TS `buildProvisionalMessageAffectedQuery(_, confirmations === 0)`:
        // no legacy-dispatch branch at zero confirmations.
        try testing.expectEqual(confirmations != 0, contains(calls[1], "legacy"));
        try testing.expectEqual(service.OPERATION_PLAN_COST - 2, budget.remaining);
    }
    var db: Snapshot = .{ .arena = a, .fail_projection = true };
    const svc = service.Service.init(.{ .ctx = &db, .queryFn = Snapshot.query });
    var budget: service.HistoryBudget = .{};
    var diag: sql.Diag = .{};
    try testing.expectError(error.AssertionFailed, svc.selectMessages(a, &budget, .{ .select = try args(a, "{}"), .confirmations = .{ .number = 1 } }, &diag));
    try testing.expectEqualStrings("History query exceeds the database planning budget", diag.message);
    try testing.expectEqual(@as(usize, 3), db.calls.items.len);
}

test "affected-query variants match TS buildProvisionalMessageAffectedQuery" {
    const provisional = @import("provisional_message.zig");
    for ([_]bool{ false, true }) |filtered| {
        const full = provisional.affectedQuery(filtered, false);
        const zero = provisional.affectedQuery(filtered, true);
        // `${eventScans}` then the legacy branch; zero is `eventScans` alone.
        try testing.expect(std.mem.startsWith(u8, full, zero));
        try testing.expect(std.mem.startsWith(u8, full[zero.len..], "\n  UNION ALL\n  -- A stricter frontier"));
        try testing.expect(std.mem.endsWith(u8, zero, "\n    ) event\n  "));
        try testing.expectEqual(filtered, contains(zero, "AND event.msg_id=ANY($2::bytea[])"));
    }
}

test "a history read counts its EXPLAIN as a database query" {
    const core = @import("core");
    const db = @import("db");
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    core.config.set(.{ .database_url = "postgresql://scraper-proxy-test" });
    core.metrics.init();
    const Backend = struct {
        fn query(_: *anyopaque, _: db.service.Backend.Which, _: []const u8, arena: Allocator, text: []const u8, _: []const Value, _: ?*db.Failure) db.Error!db.Result {
            const rows: []Value = if (isExplain(text)) cheapPlan(arena) catch return error.OutOfMemory else &.{};
            return .{ .rows = rows, .row_count = rows.len };
        }
        /// app.zig's adapter, minus admission.
        fn run(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *sql.Diag) anyerror![]Value {
            const dbs: *db.DbService = @ptrCast(@alignCast(ctx));
            var failure: db.Failure = .{};
            return dbs.query(arena, text, values, &failure) catch |err| {
                diag.message = failure.message;
                return err;
            };
        }
    };
    const dbs = try db.DbService.init(testing.allocator, null);
    defer dbs.deinit();
    var unused: u8 = 0;
    dbs.backend = .{ .ctx = &unused, .query = Backend.query };
    const svc = service.Service.init(.{ .ctx = dbs, .queryFn = Backend.run });
    const queries = &core.metrics.database_queries;
    const before = queries.get(.{ "success", "graphql_primary" });
    var budget: service.HistoryBudget = .{};
    var diag: sql.Diag = .{};
    _ = try svc.select(a, &budget, .raw_message_dispatch, try args(a, "{}"), &diag);
    try testing.expectEqual(before + 2, queries.get(.{ "success", "graphql_primary" }));
    _ = try svc.select(a, &budget, .domain, try args(a, "{}"), &diag);
    try testing.expectEqual(before + 3, queries.get(.{ "success", "graphql_primary" }));
}
