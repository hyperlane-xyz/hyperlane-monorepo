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
    return service.Service.init(db.db()).selectMessages(a, .{
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
        fn record(self: *@This(), plan: service.Plan) void {
            self.plans.append(self.arena, plan) catch unreachable;
        }
        fn custom(ctx: *anyopaque, arena: Allocator, _: []const u8, _: []const Value, _: *sql.Diag) anyerror![]Value {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.record(.custom);
            return try arena.dupe(Value, &.{try value.parseLeaky(arena, "{\"message_ids\":[],\"domains\":[],\"heights\":[]}")});
        }
        fn reusable(ctx: *anyopaque, arena: Allocator, _: []const u8, _: []const Value, _: *sql.Diag) anyerror![]Value {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.record(.reusable);
            return try arena.dupe(Value, &.{try value.parseLeaky(arena, "{\"message_ids\":[],\"domains\":[],\"heights\":[]}")});
        }
    };
    var routing: Routing = .{ .arena = a };
    const svc = service.Service.init(.{ .ctx = &routing, .queryFn = Routing.custom, .reusableQueryFn = Routing.reusable });
    var diag: sql.Diag = .{};
    _ = try svc.select(a, .message_view, try args(a, "{\"where\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}"), &diag);
    _ = try svc.select(a, .message_view, try args(a, "{\"where\":{\"sender\":{\"_eq\":\"\\\\x01\"}}}"), &diag);
    _ = try svc.byPk(a, .raw_message_dispatch, .{ .string = "1" }, null, &diag);
    _ = try svc.selectMessages(a, .{ .select = try args(a, "{\"where\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}"), .confirmations = .{ .number = 0 } }, &diag);
    _ = try svc.selectMessages(a, .{ .select = try args(a, "{\"limit\":20}"), .confirmations = .{ .number = 2 } }, &diag);
    _ = try svc.selectMessages(a, .{ .select = try args(a, "{\"where\":{\"id\":{\"_eq\":7}}}"), .confirmations = .{ .number = 0 } }, &diag);
    try testing.expectEqualSlices(service.Plan, &.{ .reusable, .custom, .reusable, .reusable, .reusable, .reusable, .custom, .reusable, .custom }, routing.plans.items);
    try testing.expect(!service.isMessageIdLookup(try value.parseLeaky(a, "{\"id\":{\"_eq\":7}}")));
    try testing.expect(service.isMessageIdLookup(try value.parseLeaky(a, "{\"_and\":{\"msg_id\":{\"_eq\":\"\\\\x01\"}}}")));
}
