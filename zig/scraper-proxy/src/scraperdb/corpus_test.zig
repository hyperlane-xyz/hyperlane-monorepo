//! Differential test against the TS builder: `testdata/corpus.json` is produced
//! by `testdata/gen-corpus.ts` (see its header) and holds TS sql/values/errors.
const std = @import("std");
const Allocator = std.mem.Allocator;

const provisional = @import("provisional_message.zig");
const service = @import("service.zig");
const sql = @import("sql.zig");
const tables = @import("tables.zig");
const value = @import("value.zig");
const Value = value.Value;

const corpus_text = @embedFile("testdata/corpus.json");

fn field(obj: value.Object, key: []const u8) ?Value {
    return value.present(value.get(obj, key));
}

fn stringList(arena: Allocator, item: ?Value) !?[]const []const u8 {
    const items = value.array(item orelse return null) orelse return null;
    const out = try arena.alloc([]const u8, items.len);
    for (items, 0..) |entry, index| out[index] = value.string(entry).?;
    return out;
}

fn selectArgs(arena: Allocator, args: ?Value) !sql.SelectArgs {
    const obj = value.object(args) orelse return .{};
    return .{
        .columns = try stringList(arena, value.get(obj, "columns")),
        .cursor = value.get(obj, "cursor"),
        .distinct_on = value.get(obj, "distinct_on"),
        .limit = value.get(obj, "limit"),
        .offset = value.get(obj, "offset"),
        .order_by = value.get(obj, "order_by"),
        .where = value.get(obj, "where"),
    };
}

fn compact(arena: Allocator, text: []const u8) ![]const u8 {
    const placeholders = [_]struct { []const u8, []const u8 }{
        .{ "{{PROVISIONAL}}", provisional.PROVISIONAL_MESSAGE_QUERY },
        .{ "{{PROJECTED}}", provisional.PROJECTED_MESSAGE_QUERY },
        .{ "{{AFFECTED_FILTERED}}", provisional.affectedQuery(true) },
        .{ "{{AFFECTED}}", provisional.affectedQuery(false) },
    };
    var out = text;
    for (placeholders) |entry| out = try std.mem.replaceOwned(u8, arena, out, entry[1], entry[0]);
    return out;
}

fn json(arena: Allocator, item: anytype) ![]const u8 {
    return value.stringifyAlloc(arena, item);
}

const Query = struct { sql: []const u8, values: []const Value };

const FakeDb = struct {
    arena: Allocator,
    queries: std.ArrayList(Query) = .empty,
    snapshot_first: bool,
    snapshot: ?Value,

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *sql.Diag) anyerror![]Value {
        _ = diag;
        const self: *FakeDb = @ptrCast(@alignCast(ctx));
        try self.queries.append(self.arena, .{ .sql = text, .values = try arena.dupe(Value, values) });
        if (self.queries.items.len == 1 and self.snapshot_first) {
            const row = self.snapshot orelse return &.{};
            return try arena.dupe(Value, &.{row});
        }
        return &.{};
    }
};

const Outcome = struct {
    queries: []const Query = &.{},
    err: ?[]const u8 = null,
};

fn runCase(arena: Allocator, case: value.Object, default_snapshot: Value) !Outcome {
    const kind = value.string(value.get(case, "kind").?).?;
    var diag: sql.Diag = .{};
    const table = if (value.get(case, "table")) |t| std.meta.stringToEnum(tables.Table, value.string(t).?).? else .message_view;
    const args = try selectArgs(arena, value.get(case, "args"));
    if (std.mem.eql(u8, kind, "messages")) {
        const args_obj = value.object(value.get(case, "args")).?;
        const confirmations = value.get(args_obj, "confirmations");
        var db: FakeDb = .{
            .arena = arena,
            .snapshot_first = !value.isNullish(confirmations),
            .snapshot = if (value.get(case, "snapshot")) |s| (if (s == .null) null else s) else default_snapshot,
        };
        const svc = service.Service.init(.{ .ctx = &db, .queryFn = FakeDb.query });
        _ = svc.selectMessages(arena, .{ .select = args, .confirmations = confirmations }, &diag) catch |err| switch (err) {
            error.AssertionFailed => return .{ .queries = db.queries.items, .err = diag.message },
            else => return err,
        };
        return .{ .queries = db.queries.items };
    }
    const built = blk: {
        if (std.mem.eql(u8, kind, "select")) {
            var source: ?sql.Source = null;
            if (value.object(value.get(case, "source"))) |s| source = .{
                .relation = value.string(value.get(s, "relation").?).?,
                .values = value.array(value.get(s, "values").?).?,
            };
            break :blk sql.buildSelect(arena, table, args, source, &diag);
        }
        if (std.mem.eql(u8, kind, "count")) {
            const count = value.object(value.get(case, "count"));
            break :blk sql.buildCount(arena, table, args, .{
                .columns = if (count) |c| value.get(c, "columns") else null,
                .distinct = if (count) |c| value.get(c, "distinct") else null,
            }, &diag);
        }
        std.debug.assert(std.mem.eql(u8, kind, "byPk"));
        break :blk sql.buildByPk(arena, table, value.get(case, "id").?, try stringList(arena, value.get(case, "columns")), &diag);
    } catch |err| switch (err) {
        error.AssertionFailed => return .{ .err = diag.message },
        else => return err,
    };
    const queries = try arena.dupe(Query, &.{.{ .sql = built.sql, .values = built.values }});
    return .{ .queries = queries };
}

fn expectedQueries(arena: Allocator, result: value.Object, kind: []const u8) ![]const Query {
    if (std.mem.eql(u8, kind, "messages")) {
        const items = value.array(value.get(result, "queries").?).?;
        const out = try arena.alloc(Query, items.len);
        for (items, 0..) |item, index| {
            const q = value.object(item).?;
            out[index] = .{ .sql = value.string(value.get(q, "sql").?).?, .values = value.array(value.get(q, "values").?).? };
        }
        return out;
    }
    if (value.get(result, "error") != null) return &.{};
    return try arena.dupe(Query, &.{.{
        .sql = value.string(value.get(result, "sql").?).?,
        .values = value.array(value.get(result, "values").?).?,
    }});
}

test "SQL builder matches the TS corpus" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const parsed = try value.parseLeaky(arena, corpus_text);
    const root = value.object(parsed).?;

    const shared = value.object(value.get(root, "provisional")).?;
    try std.testing.expectEqualStrings(value.string(value.get(shared, "provisional").?).?, provisional.PROVISIONAL_MESSAGE_QUERY);
    try std.testing.expectEqualStrings(value.string(value.get(shared, "projected").?).?, provisional.PROJECTED_MESSAGE_QUERY);
    try std.testing.expectEqualStrings(value.string(value.get(shared, "affected").?).?, provisional.affectedQuery(false));
    try std.testing.expectEqualStrings(value.string(value.get(shared, "affectedFiltered").?).?, provisional.affectedQuery(true));

    const table_specs = value.object(value.get(root, "tables")).?;
    for (0..value.len(table_specs)) |table_index| {
        const spec = std.meta.stringToEnum(tables.Table, value.keyAt(table_specs, table_index)).?.spec();
        const expected = value.object(value.valueAt(table_specs, table_index).*).?;
        const columns = value.array(value.get(expected, "columns").?).?;
        try std.testing.expectEqual(columns.len, spec.columns.len);
        for (columns, spec.columns) |want, have| try std.testing.expectEqualStrings(value.string(want).?, have);
        const pk = field(expected, "primaryKey");
        try std.testing.expectEqualStrings(if (pk) |p| value.string(p).? else "", spec.primary_key orelse "");
        const relation = field(expected, "relation");
        try std.testing.expectEqualStrings(if (relation) |r| value.string(r).? else "", spec.relation orelse "");
    }

    const default_snapshot = try value.parseLeaky(arena,
        \\{"message_ids":["\\x0a"],"domains":[1],"heights":["7"]}
    );
    var failures: usize = 0;
    const cases = value.array(value.get(root, "cases").?).?;
    for (cases, 0..) |item, index| {
        const case = value.object(item).?;
        const kind = value.string(value.get(case, "kind").?).?;
        const result = value.object(value.get(case, "result").?).?;
        const outcome = try runCase(arena, case, default_snapshot);
        const want_err = if (value.get(result, "error")) |e| value.string(e).? else null;
        const want_queries = try expectedQueries(arena, result, kind);
        var ok = std.mem.eql(u8, want_err orelse "", outcome.err orelse "") and (want_err == null) == (outcome.err == null);
        ok = ok and want_queries.len == outcome.queries.len;
        if (ok) for (want_queries, outcome.queries) |want, have| {
            const have_sql = if (std.mem.eql(u8, kind, "messages")) try compact(arena, have.sql) else have.sql;
            if (!std.mem.eql(u8, want.sql, have_sql) or
                !std.mem.eql(u8, try json(arena, want.values), try json(arena, have.values))) ok = false;
        };
        if (!ok) {
            failures += 1;
            std.debug.print("\ncase {d} ({s}) {s}\n  want err={?s} queries={d}\n  have err={?s} queries={d}\n", .{
                index, kind, try json(arena, value.get(case, "args") orelse value.get(case, "id")), want_err, want_queries.len, outcome.err, outcome.queries.len,
            });
            for (want_queries, 0..) |want, i| {
                if (i >= outcome.queries.len) break;
                const have = outcome.queries[i];
                const have_sql = if (std.mem.eql(u8, kind, "messages")) try compact(arena, have.sql) else have.sql;
                std.debug.print("  want sql: {s}\n  have sql: {s}\n  want values: {s}\n  have values: {s}\n", .{
                    want.sql, have_sql, try json(arena, want.values), try json(arena, have.values),
                });
            }
        }
    }
    try std.testing.expectEqual(@as(usize, 0), failures);
    try std.testing.expect(cases.len > 150);
}
