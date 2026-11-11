//! Port of `live/provisional-message.test.ts` (real PostgreSQL, opt-in via
//! SCRAPER_TEST_DATABASE_URL). Uses session-local TEMP tables that shadow the
//! scraper schema; never writes persistent data. Run from `zig/` so the
//! `../src/live/fixtures/message-view.sql` fixture path resolves.
const std = @import("std");
const testing = std.testing;
const Allocator = std.mem.Allocator;
const db = @import("db");

const provisional = @import("provisional_message.zig");
const service = @import("service.zig");
const sql = @import("sql.zig");
const value = @import("value.zig");
const Value = value.Value;

const setup_sql =
    \\
    \\      CREATE TEMP TABLE domain(id integer, chain_id bigint, name text);
    \\      CREATE TEMP TABLE scraper_head(domain integer, confirmed_height bigint, head_height bigint, indexed_height bigint);
    \\      CREATE TEMP TABLE block(id bigint, domain integer, hash bytea, height bigint, timestamp timestamp);
    \\      CREATE TEMP TABLE "transaction"(id bigint, block_id bigint, hash bytea, gas_limit numeric,
    \\        max_priority_fee_per_gas numeric, max_fee_per_gas numeric, gas_price numeric,
    \\        effective_gas_price numeric, nonce bigint, sender bytea, recipient bytea,
    \\        gas_used numeric, cumulative_gas_used numeric);
    \\      CREATE TEMP TABLE raw_message_dispatch(id bigint, msg_id bytea, nonce integer,
    \\        origin_domain integer, destination_domain integer, time_created timestamp,
    \\        sender bytea, recipient bytea, origin_mailbox bytea, origin_tx_hash bytea,
    \\        origin_block_hash bytea, origin_block_height bigint, msg_body bytea);
    \\      CREATE TEMP TABLE message(id bigint, msg_id bytea, nonce integer, origin integer,
    \\        destination integer, time_created timestamp, sender bytea, recipient bytea,
    \\        origin_mailbox bytea, origin_tx_id bigint, msg_body bytea);
    \\      CREATE TEMP TABLE delivered_message(id bigint, msg_id bytea, domain integer,
    \\        time_created timestamp, destination_mailbox bytea, destination_tx_id bigint,
    \\        block_number bigint, block_hash bytea, transaction_hash bytea);
    \\      CREATE TEMP TABLE gas_payment(id bigint, msg_id bytea, domain integer,
    \\        payment numeric, gas_amount numeric, block_number bigint);
    \\      INSERT INTO domain VALUES (1,1,'near-head'),(2,2,'legacy');
    \\      INSERT INTO scraper_head VALUES (1,5,12,10);
    \\      INSERT INTO block VALUES (1,1,decode('aa','hex'),10,now()),
    \\        (2,2,decode('bb','hex'),20,now());
    \\      INSERT INTO "transaction"(id,block_id,hash) VALUES (2,2,decode('dd','hex'));
    \\      INSERT INTO raw_message_dispatch VALUES (1,decode('01','hex'),0,1,2,now(),
    \\        decode('bb','hex'),decode('cc','hex'),decode('ee','hex'),decode('cc','hex'),
    \\        decode('aa','hex'),10,null);
    \\      -- Legacy message has no raw dispatch. Its delivery is on the near-head chain.
    \\      INSERT INTO message VALUES (2,decode('02','hex'),1,2,1,now(),decode('bb','hex'),
    \\        decode('cc','hex'),decode('ee','hex'),2,null);
    \\      INSERT INTO delivered_message VALUES (1,decode('01','hex'),2,now(),null,2,null,null,null),
    \\        (2,decode('02','hex'),1,now(),null,null,10,decode('aa','hex'),decode('cc','hex'));
    \\      INSERT INTO gas_payment VALUES (1,decode('01','hex'),2,100,200,null),
    \\        (2,decode('02','hex'),1,300,400,10);
;

const confirmed_views_sql =
    \\CREATE TEMP VIEW confirmed_delivered_message AS SELECT event.* FROM delivered_message event
    \\  LEFT JOIN scraper_head head ON head.domain=event.domain
    \\  WHERE event.block_number IS NULL OR event.block_number<=coalesce(head.confirmed_height,9223372036854775807);
    \\CREATE TEMP VIEW confirmed_gas_payment AS SELECT event.* FROM gas_payment event
    \\  LEFT JOIN scraper_head head ON head.domain=event.domain
    \\  WHERE event.block_number IS NULL OR event.block_number<=coalesce(head.confirmed_height,9223372036854775807);
;

const Harness = struct {
    conn: *db.pq.Conn,
    arena: Allocator,
    last_sql: []const u8 = "",
    last_values: []const Value = &.{},
    last_rows: []Value = &.{},

    fn exec(self: *Harness, text: []const u8, params: []const Value) ![]Value {
        var failure: db.Failure = .{};
        const result = self.conn.query(self.arena, text, params, &failure) catch |err| {
            std.debug.print("query failed: {s}\n", .{failure.message});
            return err;
        };
        return result.rows;
    }

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *sql.Diag) anyerror![]Value {
        const self: *Harness = @ptrCast(@alignCast(ctx));
        self.last_sql = text;
        self.last_values = try arena.dupe(Value, values);
        var failure: db.Failure = .{};
        const result = self.conn.query(arena, text, values, &failure) catch |err| {
            diag.message = failure.message;
            return err;
        };
        self.last_rows = result.rows;
        return result.rows;
    }

    fn svc(self: *Harness) service.Service {
        return service.Service.init(.{ .ctx = self, .queryFn = query });
    }

    /// `service.selectMessages(JSON.parse(args_json))`.
    fn messages(self: *Harness, args_json: []const u8) ![]Value {
        var diag: sql.Diag = .{};
        const args = try value.parseLeaky(self.arena, args_json);
        const obj = value.object(args).?;
        var columns: ?[]const []const u8 = null;
        if (value.get(obj, "columns")) |list| {
            const items = value.array(list).?;
            const out = try self.arena.alloc([]const u8, items.len);
            for (items, out) |item, *name| name.* = value.string(item).?;
            columns = out;
        }
        const select: sql.SelectArgs = .{
            .columns = columns,
            .cursor = value.get(obj, "cursor"),
            .distinct_on = value.get(obj, "distinct_on"),
            .limit = value.get(obj, "limit"),
            .offset = value.get(obj, "offset"),
            .order_by = value.get(obj, "order_by"),
            .where = value.get(obj, "where"),
        };
        return self.svc().selectMessages(self.arena, .{ .select = select, .confirmations = value.get(obj, "confirmations") }, &diag) catch |err| {
            if (err == error.AssertionFailed) std.debug.print("assert: {s}\n", .{diag.message});
            return err;
        };
    }

    fn rejects(self: *Harness, args_json: []const u8, needle: []const u8) !void {
        var diag: sql.Diag = .{};
        const args = try value.parseLeaky(self.arena, args_json);
        const obj = value.object(args).?;
        const select: sql.SelectArgs = .{ .cursor = value.get(obj, "cursor"), .where = value.get(obj, "where") };
        const result = self.svc().selectMessages(self.arena, .{ .select = select, .confirmations = value.get(obj, "confirmations") }, &diag);
        try testing.expectError(error.AssertionFailed, result);
        try testing.expect(std.mem.indexOf(u8, diag.message, needle) != null);
    }
};

fn field(row: Value, key: []const u8) Value {
    return value.get(value.object(row).?, key) orelse .null;
}

fn str(row: Value, key: []const u8) []const u8 {
    return value.string(field(row, key)).?;
}

fn ids(a: Allocator, rows: []const Value) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    for (rows, 0..) |row, i| try out.writer.print("{s}{s}", .{ if (i == 0) "" else ",", str(row, "id") });
    return out.written();
}

fn jsonOf(a: Allocator, item: Value) ![]const u8 {
    return value.stringifyAlloc(a, item);
}

fn findByOrigin(rows: []const Value, origin: f64) ?Value {
    for (rows) |row| if (value.number(field(row, "origin_domain_id")) == origin) return row;
    return null;
}

const PlanTotals = struct { affected_projection_cte: bool = false, payment_loops: f64 = 0 };

fn walkPlan(plan: Value, totals: *PlanTotals) void {
    const obj = value.object(plan) orelse return;
    if (value.get(obj, "CTE Name")) |name| {
        if (value.string(name)) |n| if (std.mem.eql(u8, n, "affected_projection")) {
            totals.affected_projection_cte = true;
        };
    }
    if (value.get(obj, "Alias")) |alias| {
        if (value.string(alias)) |n| if (std.mem.eql(u8, n, "payment")) {
            totals.payment_loops += value.number(value.get(obj, "Actual Loops").?).?;
        };
    }
    if (value.get(obj, "Plans")) |children| for (value.array(children).?) |child| walkPlan(child, totals);
}

test "projects mixed-chain and legacy messages at independent frontiers" {
    const url = std.posix.getenv("SCRAPER_TEST_DATABASE_URL") orelse return error.SkipZigTest;
    var arena_state = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: db.Failure = .{};
    var conn = db.pq.Conn.connect(.{ .conninfo = url }, a, &failure) catch |err| {
        std.debug.print("connect failed: {s}\n", .{failure.message});
        return err;
    };
    defer conn.deinit();
    var h: Harness = .{ .conn = &conn, .arena = a };
    _ = try h.exec(setup_sql, &.{});

    const project = struct {
        fn run(harness: *Harness, height: ?[]const u8) ![]Value {
            const params_json = if (height) |hgt|
                try std.fmt.allocPrint(harness.arena, "[[\"\\\\x01\",\"\\\\x02\"],[1],[\"{s}\"]]", .{hgt})
            else
                "[[\"\\\\x01\",\"\\\\x02\"],[],[]]";
            const params = try value.parseLeaky(harness.arena, params_json);
            return harness.exec(provisional.PROVISIONAL_MESSAGE_QUERY, value.array(params).?);
        }
    }.run;

    // near-head dispatch must wait for its requested frontier
    var rows = try project(&h, "9");
    try testing.expectEqual(@as(usize, 1), rows.len);
    try testing.expectEqual(@as(?f64, 2), value.number(field(rows[0], "origin_domain_id")));
    try testing.expect(!field(rows[0], "is_delivered").bool); // legacy origin does not bypass destination confirmations
    try testing.expectEqualStrings("0", str(rows[0], "total_payment"));

    rows = try project(&h, "10");
    try testing.expectEqual(@as(usize, 2), rows.len);
    const near_head = findByOrigin(rows, 1).?;
    const legacy = findByOrigin(rows, 2).?;
    try testing.expect(field(near_head, "is_delivered").bool); // canonical destination updates remain visible
    try testing.expectEqualStrings("100", str(near_head, "total_payment"));
    try testing.expectEqualStrings("[2]", try jsonOf(a, field(near_head, "payment_domain_ids")));
    try testing.expect(field(legacy, "is_delivered").bool);
    try testing.expectEqualStrings("300", str(legacy, "total_payment"));
    try testing.expectEqualStrings("[1]", try jsonOf(a, field(legacy, "payment_domain_ids")));

    rows = try project(&h, "9");
    try testing.expectEqual(@as(usize, 1), rows.len); // rollback removes the provisional origin
    try testing.expect(!field(rows[0], "is_delivered").bool); // rollback also undoes delivery on a legacy message
    try testing.expectEqualStrings("0", str(rows[0], "total_payment"));

    rows = try project(&h, null);
    try testing.expectEqual(@as(usize, 1), rows.len); // canonical-only clients use scraper finality on unselected chains
    try testing.expectEqual(@as(?f64, 2), value.number(field(rows[0], "origin_domain_id")));
    try testing.expect(!field(rows[0], "is_delivered").bool);

    _ = try h.exec(confirmed_views_sql, &.{});
    const fixture = try std.fs.cwd().readFileAlloc(a, "../../typescript/scraper-proxy/src/live/fixtures/message-view.sql", 1 << 20);
    _ = try h.exec(fixture, &.{});

    // preserves canonical defaults, frontier boundaries, and selection semantics
    try testing.expectEqualStrings("2", try ids(a, try h.messages("{}")));
    try testing.expectEqualStrings("2", try ids(a, try h.messages("{\"confirmations\":null}")));
    const zero = try h.messages("{\"confirmations\":0,\"order_by\":{\"id\":\"asc\"}}");
    try testing.expectEqualStrings("1,2", try ids(a, zero));
    for (zero) |row| try testing.expect(field(row, "is_provisional").bool);
    try testing.expectEqualStrings("300", str(zero[1], "total_payment"));
    const before = try h.messages("{\"confirmations\":3}");
    try testing.expectEqual(@as(usize, 1), before.len);
    try testing.expect(!field(before[0], "is_delivered").bool);
    try testing.expectEqualStrings("0", str(before[0], "total_payment"));
    try testing.expectEqualStrings("1", try ids(a, try h.messages(
        \\{"confirmations":0,"where":{"origin_domain_id":{"_eq":1}},"columns":["id"],"order_by":{"send_occurred_at":"desc"},"limit":1}
    )));
    try testing.expectEqual(@as(usize, 0), (try h.messages("{\"where\":{\"is_provisional\":{\"_eq\":true}}}")).len);
    {
        var diag: sql.Diag = .{};
        const where = try value.parseLeaky(a, "{\"msg_id\":{\"_in\":[\"\\\\x02\"]}}");
        const q = try sql.buildSelect(a, .message_view, .{ .where = where }, null, &diag);
        try testing.expect(!field((try h.exec(q.sql, q.values))[0], "is_provisional").bool);
    }

    // deduplicates before DISTINCT and limits; raw IDs never become history cursors
    {
        _ = try h.exec("BEGIN", &.{});
        defer _ = h.exec("ROLLBACK", &.{}) catch {};
        _ = try h.exec(
            \\UPDATE scraper_head SET confirmed_height=10, head_height=13, indexed_height=13;
            \\INSERT INTO gas_payment VALUES (3,decode('02','hex'),1,10,20,13);
            \\INSERT INTO message VALUES (1,decode('01','hex'),0,1,2,now(),decode('bb','hex'),decode('cc','hex'),decode('ee','hex'),1,null);
            \\INSERT INTO "transaction"(id,block_id,hash) VALUES (1,1,decode('cc','hex'));
        , &.{});
        const distinct = try h.messages(
            \\{"confirmations":0,"distinct_on":["sender"],"order_by":[{"sender":"asc"},{"id":"desc"}],"limit":1}
        );
        try testing.expectEqual(@as(usize, 1), distinct.len);
        try testing.expectEqualStrings("\\x02", str(distinct[0], "msg_id"));
        const ordered = try h.messages("{\"confirmations\":0,\"order_by\":{\"id\":\"asc\"}}");
        try testing.expectEqual(@as(usize, 2), ordered.len);
        try testing.expect(!field(ordered[0], "is_provisional").bool and field(ordered[1], "is_provisional").bool);
        _ = try h.exec(
            \\UPDATE scraper_head SET confirmed_height=5;
            \\INSERT INTO raw_message_dispatch VALUES (2,decode('03','hex'),3,1,2,now(),null,null,null,decode('cc','hex'),decode('aa','hex'),10,null);
        , &.{});
        const mixed = try h.messages("{\"confirmations\":0}");
        var twos: usize = 0;
        for (mixed) |row| {
            if (std.mem.eql(u8, str(row, "id"), "2")) twos += 1;
        }
        try testing.expectEqual(@as(usize, 2), twos);
        try h.rejects(
            \\{"confirmations":0,"cursor":[{"initial_value":{"id":2},"ordering":"DESC"}]}
        , "cursor is unsupported");
        try testing.expectEqualStrings("2", try ids(a, try h.messages(
            \\{"cursor":[{"initial_value":{"id":3},"ordering":"DESC"}],"order_by":{"id":"desc"},"limit":1}
        )));
    }

    // rebuilds unmatched raw hashes from canonical origins without losing nullable origins
    {
        _ = try h.exec("BEGIN", &.{});
        defer _ = h.exec("ROLLBACK", &.{}) catch {};
        _ = try h.exec(
            \\INSERT INTO message VALUES
            \\  (1001,decode('11','hex'),11,2,1,now(),null,null,null,null,null),
            \\  (1006,decode('16','hex'),16,2,1,now(),null,null,null,2,null);
            \\INSERT INTO raw_message_dispatch VALUES
            \\  (1006,decode('16','hex'),16,2,1,now(),null,null,null,decode('dd','hex'),decode('ff','hex'),20,null);
            \\INSERT INTO gas_payment VALUES
            \\  (1001,decode('11','hex'),1,1,1,10), (1006,decode('16','hex'),1,1,1,10);
            \\INSERT INTO delivered_message VALUES
            \\  (1006,decode('16','hex'),1,now(),null,null,10,null,null);
        , &.{});
        for ([_][]const u8{ "11", "16" }) |msg_id| {
            const found = try h.messages(try std.fmt.allocPrint(a,
                \\{{"confirmations":0,"where":{{"_and":[{{"msg_id":{{"_eq":"\\x{s}"}}}}]}}}}
            , .{msg_id}));
            try testing.expect(found.len >= 1);
            const row = found[0];
            const is_16 = std.mem.eql(u8, msg_id, "16");
            try testing.expectEqual(is_16, field(row, "is_provisional").bool);
            if (is_16) {
                try testing.expectEqualStrings("1", str(row, "total_payment"));
                try testing.expect(field(row, "is_delivered").bool);
                try testing.expectEqualStrings("\\xbb", str(row, "origin_block_hash"));
            }
        }
        const strict = try h.messages(
            \\{"confirmations":3,"where":{"msg_id":{"_in":["\\x16"]}}}
        );
        try testing.expect(!field(strict[0], "is_delivered").bool);
        try testing.expectEqualStrings("0", str(strict[0], "total_payment"));
    }

    // keeps canonical IDs and bodies, and orders reloads by send time
    {
        _ = try h.exec("BEGIN", &.{});
        {
            defer _ = h.exec("ROLLBACK", &.{}) catch {};
            _ = try h.exec(
                \\INSERT INTO message VALUES (100,decode('01','hex'),0,1,2,now(),null,null,null,null,decode('99','hex'));
                \\UPDATE delivered_message SET block_number=4 WHERE domain=1;
                \\UPDATE gas_payment SET block_number=4 WHERE domain=1;
            , &.{});
            const row = (try h.messages(
                \\{"confirmations":0,"where":{"msg_id":{"_eq":"\\x01"},"message_body":{"_eq":"\\x99"}}}
            ))[0];
            try testing.expectEqualStrings("100", str(row, "id"));
            try testing.expectEqualStrings("\\x99", str(row, "message_body"));
            const live = (try h.messages(
                \\{"confirmations":0,"where":{"is_provisional":{"_eq":true}},"order_by":[{"send_occurred_at":"desc"},{"id":"desc"}],"limit":1}
            ))[0];
            try testing.expectEqualStrings("100", str(live, "id"));
            _ = try h.exec("INSERT INTO scraper_head VALUES (2,20,22,22)", &.{});
            try testing.expectEqual(@as(usize, 0), (try h.messages("{\"confirmations\":3}")).len);
        }
        _ = try h.exec(
            \\INSERT INTO message VALUES (100,decode('01','hex'),0,1,2,now(),null,null,null,null,null);
            \\             UPDATE scraper_head SET confirmed_height=indexed_height
        , &.{});
        const caught_up = try h.messages("{\"confirmations\":0}");
        try testing.expectEqual(@as(usize, 2), caught_up.len);
        for (caught_up) |row| try testing.expect(!field(row, "is_provisional").bool);
    }

    // excludes canonical IDs without rebuilding or materializing the wide projection
    {
        _ = try h.exec("BEGIN", &.{});
        defer _ = h.exec("ROLLBACK", &.{}) catch {};
        _ = try h.exec(
            \\UPDATE scraper_head SET confirmed_height=0;
            \\INSERT INTO raw_message_dispatch
            \\  SELECT id, decode(lpad(to_hex(id),8,'0'),'hex'), id,1,2,now(),decode('bb','hex'),null,null,
            \\    null,decode('aa','hex'),10,null FROM generate_series(100,226) id;
            \\INSERT INTO message(id,msg_id,origin,destination,sender)
            \\  SELECT id+10000,msg_id,1,2,sender FROM raw_message_dispatch WHERE id>=100;
            \\ANALYZE raw_message_dispatch; ANALYZE message;
        , &.{});
        for ([_]?[]const u8{ null, "{\"sender\":{\"_eq\":\"\\\\xff\"}}" }) |where| {
            const args = if (where) |w| try std.fmt.allocPrint(a, "{{\"confirmations\":0,\"where\":{s}}}", .{w}) else "{\"confirmations\":0}";
            const found = try h.messages(args);
            try testing.expectEqual(@as(usize, if (where == null) 129 else 0), found.len);
            const explain = try h.exec(try std.fmt.allocPrint(a, "EXPLAIN (ANALYZE, FORMAT JSON) {s}", .{h.last_sql}), h.last_values);
            const plan = value.get(value.object(value.array(field(explain[0], "QUERY PLAN")).?[0]).?, "Plan").?;
            var totals: PlanTotals = .{};
            walkPlan(plan, &totals);
            // the wide projection must inline so filters reach dispatches
            try testing.expect(!totals.affected_projection_cte);
            // payment work runs once per projected message, never for canonical exclusion
            try testing.expectEqual(@as(f64, if (where == null) 129 else 0), totals.payment_loops);
        }
    }

    // bounds backlog candidates before projection while keeping exact lookups available
    {
        _ = try h.exec("BEGIN", &.{});
        defer _ = h.exec("ROLLBACK", &.{}) catch {};
        _ = try h.exec(
            \\UPDATE scraper_head SET confirmed_height=0;
            \\INSERT INTO gas_payment SELECT id, decode(lpad(to_hex(id),8,'0'),'hex'), 1, 1, 1, 10
            \\  FROM generate_series(10000,20001) id;
        , &.{});
        try h.rejects("{\"confirmations\":0}", "10000 affected events");
        // overflow IDs must remain in PostgreSQL rather than being transferred
        try testing.expect(field(h.last_rows[0], "message_ids") == .null);
        const found = try h.messages(
            \\{"confirmations":0,"where":{"_or":[{"msg_id":{"_eq":"\\x01"}},{"msg_id":{"_in":["\\x02"]}}]}}
        );
        try testing.expectEqual(@as(usize, 2), found.len);
    }
}
