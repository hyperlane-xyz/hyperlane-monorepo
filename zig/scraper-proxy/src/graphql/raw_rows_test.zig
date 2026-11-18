//! Rows straight to JSON (`execute.RawRows`, IMPLEMENTATION.md): the same
//! query against the same cells must serialize byte-for-byte as today's path
//! (`resolve` returning the materialized row values). A fake database result
//! models db's per-type rules (the exact formatter corpus lives with db's
//! `convert`): int2/int4/oid as numbers, int8/numeric/text-like as strings,
//! bool as t/f, other types not fast.
const std = @import("std");
const core = @import("core");
const json = core.json;
const parser = @import("parser.zig");
const schema_mod = @import("schema.zig");
const values = @import("values.zig");
const execute = @import("execute.zig");
const route = @import("route.zig");

const Value = json.Value;
const Allocator = std.mem.Allocator;

const Oid = enum(u32) {
    bool = 16,
    int8 = 20,
    int2 = 21,
    int4 = 23,
    text = 25,
    oid = 26,
    numeric = 1700,
    varchar = 1043,
    timestamptz = 1184,
    bytea = 17,
    jsonb = 3802,

    fn kind(self: Oid) ?execute.FastKind {
        return switch (self) {
            .int2, .int4 => .number_text,
            .int8, .numeric, .text, .varchar => .string_text,
            .bool => .bool_tf,
            .oid, .timestamptz, .bytea, .jsonb => null,
        };
    }

    /// The fake's convertCell (db's real one is proven against node-pg).
    fn convert(self: Oid, a: Allocator, text: []const u8) Allocator.Error!Value {
        return switch (self) {
            .int2, .int4, .oid => .{ .number = @floatFromInt(std.fmt.parseInt(i64, text, 10) catch unreachable) },
            .bool => .{ .bool = std.mem.eql(u8, text, "t") },
            .jsonb => json.parse(a, text, .{}) catch |err| switch (err) {
                error.OutOfMemory => error.OutOfMemory,
                else => unreachable,
            },
            else => .{ .string = text },
        };
    }
};

const Table = struct {
    names: []const []const u8,
    oids: []const Oid,
    /// rows × columns; null = SQL NULL.
    cells: []const []const ?[]const u8,
    deinits: usize = 0,
    materializes: usize = 0,

    fn columns(self: *const Table, a: Allocator) ![]execute.RawColumn {
        const out = try a.alloc(execute.RawColumn, self.names.len);
        for (out, self.names, self.oids) |*c, n, o| c.* = .{ .name = n, .kind = o.kind(), .nested = o == .jsonb };
        return out;
    }

    /// Today's values: convertCell per type; duplicate names keep the first
    /// position and the last value (pq.convertRows).
    fn materialize(ctx: *anyopaque, a: Allocator) Allocator.Error![]Value {
        const self: *Table = @ptrCast(@alignCast(ctx));
        self.materializes += 1;
        const rows = try a.alloc(Value, self.cells.len);
        for (rows, self.cells) |*row, cells| {
            var members: std.ArrayList(json.Member) = .empty;
            for (self.names, self.oids, cells) |name, oid, maybe_text| {
                const v: Value = if (maybe_text) |text| try oid.convert(a, text) else .null;
                var replaced = false;
                for (members.items) |*m| if (std.mem.eql(u8, m.key, name)) {
                    m.value = v;
                    replaced = true;
                };
                if (!replaced) try members.append(a, .{ .key = name, .value = v });
            }
            row.* = .{ .object = members.items };
        }
        return rows;
    }

    fn cell(ctx: *anyopaque, r: usize, c: usize) ?[]const u8 {
        const self: *Table = @ptrCast(@alignCast(ctx));
        return self.cells[r][c];
    }

    fn writeText(ctx: *anyopaque, w: *std.Io.Writer, a: Allocator, c: usize, text: []const u8) (std.Io.Writer.Error || Allocator.Error)!void {
        const self: *Table = @ptrCast(@alignCast(ctx));
        // Not fast: stringify(convertCell), like LazyRows.writeCell.
        const kind = self.oids[c].kind() orelse return json.stringify(w, try self.oids[c].convert(a, text));
        switch (kind) {
            .number_text => try w.writeAll(text),
            .string_text => try json.writeString(w, text),
            .bool_tf => try w.writeAll(if (std.mem.eql(u8, text, "t")) "true" else "false"),
        }
    }

    fn deinit(ctx: *anyopaque) void {
        const self: *Table = @ptrCast(@alignCast(ctx));
        self.deinits += 1;
    }
};

const Fake = struct {
    table: *Table,
    raw: bool,
    raw_calls: usize = 0,

    fn single(field: []const u8) bool {
        return std.mem.endsWith(u8, field, "_by_pk");
    }

    fn resolve(ctx: *anyopaque, a: Allocator, info: *const execute.Info, _: Value, _: Value) Allocator.Error!execute.ResolveResult {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        if (!std.mem.eql(u8, info.parent_type.name, "query_root")) return .default;
        const rows = try Table.materialize(self.table, a);
        if (single(info.field_name)) return .{ .value = if (rows.len > 0) rows[0] else .null };
        return .{ .value = .{ .array = rows } };
    }

    fn resolveRaw(ctx: *anyopaque, a: Allocator, info: *const execute.Info, _: Value, _: Value) Allocator.Error!execute.RawResult {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        if (!self.raw or !std.mem.eql(u8, info.parent_type.name, "query_root")) return .none;
        self.raw_calls += 1;
        const raw: execute.RawRows = .{
            .ctx = self.table,
            .n_rows = self.table.cells.len,
            .columns = try self.table.columns(a),
            .cell_fn = Table.cell,
            .materialize_fn = Table.materialize,
            .write_text_fn = Table.writeText,
            .deinit_fn = Table.deinit,
        };
        return if (single(info.field_name)) .{ .row = raw } else .{ .rows = raw };
    }
};

fn run(a: Allocator, query: []const u8, table: *Table, raw: bool) !struct { body: []const u8, raw_calls: usize, deep_scalar: bool } {
    const schema = schema_mod.testing.scraper();
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(a, query, .{}, &diag);
    var fake: Fake = .{ .table = table, .raw = raw };
    const coerced = (try values.getVariableValues(a, schema, doc.definitions[0].operation.variable_definitions, null)).coerced;
    var ex = try execute.Executor.init(a, schema, doc, coerced, .{ .ctx = &fake, .resolve = Fake.resolve, .resolve_raw = Fake.resolveRaw });
    const result = try ex.executeQuery(doc.definitions[0].operation, null);
    return .{ .body = try route.serializeResponse(a, 200, result.data, result.errors), .raw_calls = fake.raw_calls, .deep_scalar = result.deep_scalar };
}

fn expectSame(a: Allocator, query: []const u8, table: *Table) !void {
    const before = table.deinits;
    const old = try run(a, query, table, false);
    const new = try run(a, query, table, true);
    if (!std.mem.eql(u8, old.body, new.body)) {
        std.debug.print("query: {s}\n today: {s}\n   raw: {s}\n", .{ query, old.body, new.body });
        return error.TestUnexpectedResult;
    }
    // Every raw result handed out is released exactly once.
    try std.testing.expectEqual(before + new.raw_calls, table.deinits);
}

const domain_names = [_][]const u8{ "id", "name", "chain_id", "native_token", "is_test_net", "is_deprecated" };
const domain_oids = [_]Oid{ .int4, .text, .int8, .varchar, .bool, .bool };

test "raw rows: domain list, by_pk, aliases, NULLs and fallbacks match today's bytes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rows = [_][]const ?[]const u8{
        &.{ "1", "ethereum", "1", "ETH", "f", "f" },
        &.{ "-2147483648", "quo\"te\\ \u{2028}\u{1F600}\x01", null, "", "t", "f" },
        &.{ "2147483647", "", "9007199254740993", "x", "f", "t" },
    };
    var table: Table = .{ .names = &domain_names, .oids = &domain_oids, .cells = &rows };
    const queries = [_][]const u8{
        "{ domain { id name chain_id native_token is_test_net is_deprecated } }",
        "{ domain { a: id b: id name n2: name } }",
        "{ domain { chain_id } }",
        "{ domain_by_pk(id: 1) { id name chain_id } }",
        "{ domain { id __typename } }", // __typename: today's path
        "{ domain { ...F } } fragment F on domain { id name }",
        "{ domain { id @skip(if: true) name @include(if: true) } }",
        // No fields left after @skip/@include: rows are `{}`.
        "{ domain { id @skip(if: true) } }",
        "{ domain { name @include(if: false) ...F @skip(if: true) } } fragment F on domain { id }",
        "{ domain_by_pk(id: 1) { name @include(if: false) } }",
        "{ x: domain { id } y: domain_by_pk(id: 1) { is_test_net } }",
    };
    for (queries) |q| try expectSame(a, q, &table);
    // The list form went in place (no fallback) for the plain selection.
    const new = try run(a, queries[0], &table, true);
    try std.testing.expect(new.raw_calls == 1);
    try std.testing.expect(std.mem.indexOf(u8, new.body, "\"errors\"") == null);
}

test "raw rows: non-null NULLs, Int range, non-fast and mismatched types take today's path" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // A NULL in non-null `name` (today: a located error and data null).
    const null_name = [_][]const ?[]const u8{&.{ "1", null, "1", "x", "f", "f" }};
    var t1: Table = .{ .names = &domain_names, .oids = &domain_oids, .cells = &null_name };
    try expectSame(a, "{ domain { id name } }", &t1);
    // `id` stored as int8 text beyond 32 bits under an Int field.
    const big = [_][]const ?[]const u8{&.{ "4294967296", "n", "1", "x", "f", "f" }};
    var t2: Table = .{ .names = &domain_names, .oids = &.{ .oid, .text, .int8, .varchar, .bool, .bool }, .cells = &big };
    try expectSame(a, "{ domain { id } }", &t2);
    // Int field over a string_text column (int8): not an identity.
    const int8_id = [_][]const ?[]const u8{&.{ "7", "n", "1", "x", "f", "f" }};
    var t3: Table = .{ .names = &domain_names, .oids = &.{ .int8, .text, .int8, .varchar, .bool, .bool }, .cells = &int8_id };
    try expectSame(a, "{ domain { id } }", &t3);
    // A non-fast column (timestamptz) for a selected field.
    const ts_names = [_][]const u8{ "id", "time_created" };
    const ts_rows = [_][]const ?[]const u8{&.{ "1", "2026-11-14 00:00:00+00" }};
    var t4: Table = .{ .names = &ts_names, .oids = &.{ .int4, .timestamptz }, .cells = &ts_rows };
    try expectSame(a, "{ domain { id time_created } }", &t4);
    // A selected field with no column in the result.
    const only_id = [_][]const u8{"id"};
    const id_rows = [_][]const ?[]const u8{&.{"1"}};
    var t5: Table = .{ .names = &only_id, .oids = &.{.int4}, .cells = &id_rows };
    try expectSame(a, "{ domain { id name } }", &t5);
    // Empty results: list and by_pk.
    const none = [_][]const ?[]const u8{};
    var t6: Table = .{ .names = &domain_names, .oids = &domain_oids, .cells = &none };
    try expectSame(a, "{ domain { id } }", &t6);
    try expectSame(a, "{ domain_by_pk(id: 1) { id } }", &t6);
    // Duplicate column names: convertRows keeps the last value.
    const dup_names = [_][]const u8{ "id", "name", "id" };
    const dup_rows = [_][]const ?[]const u8{&.{ "1", "n", "2" }};
    var t7: Table = .{ .names = &dup_names, .oids = &.{ .int4, .text, .int4 }, .cells = &dup_rows };
    try expectSame(a, "{ domain { id name } }", &t7);
}

test "raw rows: randomized cells match today's bytes (property)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var prng = std.Random.DefaultPrng.init(0x5eed_cafe);
    const r = prng.random();
    const queries = [_][]const u8{
        "{ domain { id name chain_id native_token is_test_net is_deprecated } }",
        "{ domain_by_pk(id: 1) { name chain_id is_deprecated } }",
        "{ domain { n: name id i2: id } }",
    };
    for (0..400) |_| {
        const n_rows = r.uintLessThan(usize, 5);
        const rows = try a.alloc([]const ?[]const u8, n_rows);
        for (rows) |*row| {
            const cells = try a.alloc(?[]const u8, domain_names.len);
            for (cells, domain_oids) |*c, oid| {
                if (r.uintLessThan(u8, 8) == 0) {
                    c.* = null;
                    continue;
                }
                c.* = switch (oid) {
                    .int4 => try std.fmt.allocPrint(a, "{d}", .{r.int(i32)}),
                    .int8 => try std.fmt.allocPrint(a, "{d}", .{r.int(i64)}),
                    .bool => if (r.boolean()) "t" else "f",
                    else => blk: {
                        var text: std.ArrayList(u8) = .empty;
                        for (0..r.uintLessThan(usize, 12)) |_| {
                            // Whole UTF-8 sequences only (PG text is valid UTF-8).
                            const picks = [_][]const u8{ "a", "Z", "0", " ", "\"", "\\", "/", "\x01", "\x1f", "\x7f", "\u{2028}", "\u{e9}", "\u{1F600}" };
                            try text.appendSlice(a, picks[r.uintLessThan(usize, picks.len)]);
                        }
                        break :blk text.items;
                    },
                };
            }
            row.* = cells;
        }
        var table: Table = .{ .names = &domain_names, .oids = &domain_oids, .cells = rows };
        try expectSame(a, queries[r.uintLessThan(usize, queries.len)], &table);
    }
}

// raw_message_dispatch: custom scalars over converted (not fast) columns
// (`msg_id: bytea!`, `msg_body: bytea`, `time_created: timestamp!`) keep
// today's path (measured slower per cell); the bytes must match either way.
const rmd_names = [_][]const u8{ "id", "msg_id", "nonce", "msg_body", "time_created", "origin_block_height" };
const rmd_oids = [_]Oid{ .int8, .bytea, .int4, .bytea, .timestamptz, .int8 };
const rmd_list = "{ raw_message_dispatch { id msg_id nonce msg_body time_created origin_block_height } }";
const rmd_by_pk = "{ raw_message_dispatch_by_pk(id: 1) { msg_id time_created msg_body } }";

test "raw rows: custom scalars over converted columns take today's path, NULLs included" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Values and a NULL in the nullable `msg_body`.
    const good = [_][]const ?[]const u8{
        &.{ "1", "\\xab01", "0", null, "2026-11-14 00:00:00", "9007199254740993" },
        &.{ "2", "\\x", "7", "\\x00ff", "1999-01-08 04:05:06.789", "0" },
    };
    var t1: Table = .{ .names = &rmd_names, .oids = &rmd_oids, .cells = &good };
    for ([_][]const u8{ rmd_list, rmd_by_pk, "{ raw_message_dispatch { b: msg_body t: time_created msg_id } }" }) |q| {
        try expectSame(a, q, &t1);
        const before = t1.materializes;
        try std.testing.expectEqual(@as(usize, 1), (try run(a, q, &t1, true)).raw_calls);
        try std.testing.expectEqual(before, t1.materializes); // written in place
    }
    // A NULL in non-null custom fields (bytea!, timestamp!): today's located
    // error; the list's null bubbles to data, by_pk's to the nullable field.
    for ([_]usize{ 1, 4 }) |col| {
        const cells = try a.dupe(?[]const u8, good[1]);
        cells[col] = null;
        const rows = [_][]const ?[]const u8{ good[0], cells };
        var t2: Table = .{ .names = &rmd_names, .oids = &rmd_oids, .cells = &rows };
        try expectSame(a, rmd_list, &t2);
        const single = [_][]const ?[]const u8{cells};
        var t3: Table = .{ .names = &rmd_names, .oids = &rmd_oids, .cells = &single };
        try expectSame(a, rmd_by_pk, &t3);
        const body = (try run(a, rmd_by_pk, &t3, true)).body;
        try std.testing.expect(std.mem.indexOf(u8, body, "Cannot return null for non-nullable field raw_message_dispatch.") != null);
    }
    // A converted value that is null (json `null`) in a non-null custom
    // field: today's error; in a nullable one: `null` either way.
    const json_oids = [_]Oid{ .int8, .jsonb, .int4, .jsonb, .timestamptz, .int8 };
    const json_rows = [_][]const ?[]const u8{&.{ "1", "null", "0", "null", "2026-11-14 00:00:00", "5" }};
    var t4: Table = .{ .names = &rmd_names, .oids = &json_oids, .cells = &json_rows };
    try expectSame(a, rmd_list, &t4);
    try expectSame(a, "{ raw_message_dispatch { id msg_body } }", &t4);
    const json_vals = [_][]const ?[]const u8{&.{ "1", "{\"a\":[1,2.5]}", "0", "[]", "2026-11-14 00:00:00", "5" }};
    var t5: Table = .{ .names = &rmd_names, .oids = &json_oids, .cells = &json_vals };
    try expectSame(a, rmd_list, &t5);
    // json/jsonb columns never go out raw (`RawColumn.nested`): their custom
    // fields take the Value path, where deep documents are flagged.
    const before = t5.materializes;
    _ = try run(a, rmd_list, &t5, true);
    try std.testing.expect(t5.materializes > before);
    // A jsonb document nested past the flag depth is flagged either way.
    const deep = try a.alloc(u8, 2 * 4100 + 1);
    @memset(deep[0..4100], '[');
    deep[4100] = '1';
    @memset(deep[4101..], ']');
    const deep_vals = [_][]const ?[]const u8{&.{ "1", "{}", "0", deep, "2026-11-14 00:00:00", "5" }};
    var t6: Table = .{ .names = &rmd_names, .oids = &json_oids, .cells = &deep_vals };
    for ([_]bool{ false, true }) |raw| try std.testing.expect((try run(a, rmd_list, &t6, raw)).deep_scalar);
    try std.testing.expect(!(try run(a, rmd_list, &t5, true)).deep_scalar);
}

test "raw rows: randomized converted custom columns match today's bytes (property)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var prng = std.Random.DefaultPrng.init(0xb17e_a0);
    const r = prng.random();
    const queries = [_][]const u8{ rmd_list, rmd_by_pk, "{ raw_message_dispatch { m: msg_id nonce msg_id t: time_created } }" };
    for (0..400) |_| {
        const rows = try a.alloc([]const ?[]const u8, r.uintLessThan(usize, 5));
        for (rows) |*row| {
            const cells = try a.alloc(?[]const u8, rmd_names.len);
            for (cells, rmd_oids) |*c, oid| {
                if (r.uintLessThan(u8, 10) == 0) {
                    c.* = null;
                    continue;
                }
                c.* = switch (oid) {
                    .int4 => try std.fmt.allocPrint(a, "{d}", .{r.int(i32)}),
                    .int8 => try std.fmt.allocPrint(a, "{d}", .{r.int(i64)}),
                    .bytea => blk: {
                        var text: std.ArrayList(u8) = .empty;
                        try text.appendSlice(a, "\\x");
                        for (0..r.uintLessThan(usize, 40)) |_| try text.print(a, "{x:0>2}", .{r.int(u8)});
                        break :blk text.items;
                    },
                    else => try std.fmt.allocPrint(a, "20{d:0>2}-0{d}-1{d} 0{d}:00:00.{d}", .{ r.uintLessThan(u8, 100), r.uintLessThan(u8, 9) + 1, r.uintLessThan(u8, 9), r.uintLessThan(u8, 10), r.uintLessThan(u32, 1_000_000) }),
                };
            }
            row.* = cells;
        }
        var table: Table = .{ .names = &rmd_names, .oids = &rmd_oids, .cells = rows };
        try expectSame(a, queries[r.uintLessThan(usize, queries.len)], &table);
    }
}

test "raw rows: column lookup at the map threshold, duplicate names keep the last value" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // raw_message_dispatch columns (fast or custom types); `nonce` repeats.
    const all_names = [_][]const u8{ "id", "nonce", "origin_domain", "destination_domain", "origin_block_height", "msg_id", "sender", "recipient", "nonce", "time_created", "msg_body" };
    const all_oids = [_]Oid{ .int8, .int4, .int4, .int4, .int8, .bytea, .bytea, .bytea, .int4, .timestamptz, .bytea };
    const row_a = [_]?[]const u8{ "1", "7", "1", "2", "100", "\\x01", "\\x02", "\\x03", "8", "2026-01-01 00:00:00", null };
    const row_b = [_]?[]const u8{ "2", "9", "3", "4", "101", "\\x04", "\\x05", "\\x06", "10", "2026-01-02 00:00:00", "\\x07" };
    // 7 and 8 columns: scan; 9, 10, 11: name index (threshold is > 8).
    for ([_]usize{ 7, 8, 9, 10, 11 }) |n| {
        const rows = [_][]const ?[]const u8{ row_a[0..n], row_b[0..n] };
        var table: Table = .{ .names = all_names[0..n], .oids = all_oids[0..n], .cells = &rows };
        var selection: std.ArrayList(u8) = .empty;
        for (all_names[0..n]) |name| {
            try selection.appendSlice(a, name);
            try selection.append(a, ' ');
        }
        for ([_][]const u8{
            try std.fmt.allocPrint(a, "{{ raw_message_dispatch {{ {s} }} }}", .{selection.items}),
            try std.fmt.allocPrint(a, "{{ raw_message_dispatch {{ x: nonce {s} y: nonce }} }}", .{selection.items}),
            try std.fmt.allocPrint(a, "{{ raw_message_dispatch_by_pk(id: 1) {{ nonce id }} }}", .{}),
        }) |q| {
            try expectSame(a, q, &table);
            const before = table.materializes;
            try std.testing.expectEqual(@as(usize, 1), (try run(a, q, &table, true)).raw_calls);
            try std.testing.expectEqual(before, table.materializes); // written in place
        }
        // A selected field with no column: today's path at every width.
        try expectSame(a, "{ raw_message_dispatch { id origin_mailbox } }", &table);
    }
}

// ---- Against PostgreSQL: the real App adapters (`queryLazy` → `LazyRows`)
// vs the same App with the lazy path off, on the harness scraper schema.
// Needs SCRAPER_PROXY_TEST_DATABASE_URL (`parity/fixtures/db.sh env harness`).

const Counted = struct {
    var inner: ?@import("scraperdb").Database = null;
    /// Lazy queries for raw rows.
    var lazy_calls: usize = 0;
    /// Lazy confirmation snapshots (scraperdb binds their arrays back as
    /// text; the rows themselves are not raw).
    var snapshot_calls: usize = 0;

    fn lazyQuery(_: *anyopaque, arena: Allocator, plan: @import("scraperdb").service.Plan, text: []const u8, vals: []const Value, diag: *@import("scraperdb").Diag) anyerror!?*@import("db").LazyRows {
        const db = inner.?;
        if (std.mem.startsWith(u8, text, "WITH custom_frontier AS (")) snapshot_calls += 1 else lazy_calls += 1;
        return db.lazyQueryFn.?(db.ctx, arena, plan, text, vals, diag);
    }
};

fn runDb(a: Allocator, map: *@import("resolvers.zig").ResolverMap, query: []const u8, vars: ?[]const u8) ![]const u8 {
    const schema = schema_mod.testing.scraper();
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(a, query, .{}, &diag);
    const vars_json: ?Value = if (vars) |v| try json.parse(a, v, .{}) else null;
    const coerced = switch (try values.getVariableValues(a, schema, doc.definitions[0].operation.variable_definitions, vars_json)) {
        .coerced => |c| c,
        else => return error.BadVariables,
    };
    var ex = try execute.Executor.init(a, schema, doc, coerced, map.resolvers());
    const result = try ex.executeQuery(doc.definitions[0].operation, null);
    return route.serializeResponse(a, 200, result.data, result.errors);
}

/// A real `App` on PostgreSQL with two resolver maps: `on` (the App's
/// lazy adapter, counted) and `off` (lazy path disabled: today's path).
const DbFixture = struct {
    gpa: Allocator,
    scheduler: core.scheduler.Scheduler,
    dbs: *@import("db").DbService,
    app: *@import("app.zig").App,
    on: @import("resolvers.zig").ResolverMap,
    off: @import("resolvers.zig").ResolverMap,

    fn init(self: *DbFixture, gpa: Allocator, url: []const u8) !void {
        core.log.setLevel(.@"error");
        core.config.set(.{ .database_url = url });
        self.gpa = gpa;
        self.scheduler = core.scheduler.Scheduler.init(gpa);
        try self.scheduler.start();
        core.scheduler.setGlobal(&self.scheduler);
        self.dbs = try @import("db").DbService.init(gpa, null);
        self.app = try @import("app.zig").App.init(gpa, self.dbs, null);
        const real = self.app.route_state.resolver_map;
        Counted.inner = real.db.db;
        self.on = real;
        self.on.db.db.lazyQueryFn = Counted.lazyQuery;
        self.off = real;
        self.off.db.db.lazyQueryFn = null;
    }

    fn deinit(self: *DbFixture) void {
        Counted.inner = null;
        self.app.deinit();
        self.dbs.deinit();
        core.scheduler.setGlobal(null);
        self.scheduler.deinit();
    }
};

test "raw rows: PostgreSQL results through the App adapters match today's bytes" {
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_DATABASE_URL") orelse return error.SkipZigTest;
    const db = @import("db");
    const gpa = std.testing.allocator;
    var f: DbFixture = undefined;
    try f.init(gpa, url);
    defer f.deinit();
    const dbs = f.dbs;

    var case_arena = std.heap.ArenaAllocator.init(gpa);
    defer case_arena.deinit();
    const ca = case_arena.allocator();
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    var failure: db.Failure = .{};
    const ids = try dbs.query(ca, "SELECT (SELECT max(id) FROM domain) AS d, (SELECT min(id)::text FROM raw_message_dispatch) AS r", &.{}, &failure);
    const domain_id = ids[0].get("d").?.number;
    const rmd_id = ids[0].get("r").?.string;

    const Case = struct { query: []const u8, vars: ?[]const u8 = null, lazy: bool, snapshot: bool = false };
    const cases = [_]Case{
        .{ .query = "{ domain(order_by: {id: asc}) { id name chain_id native_token is_test_net is_deprecated } }", .lazy = true },
        .{ .query = try std.fmt.allocPrint(ca, "{{ a: domain(limit: 3, order_by: {{id: desc}}) {{ x: id id name name n2: native_token }} b: domain_by_pk(id: {d}) {{ chain_id id is_test_net }} c: domain_by_pk(id: -1) {{ id }} }}", .{domain_id}), .lazy = true },
        .{ .query = "{ domain(limit: 5) { ...F ... on domain { id is_deprecated } } } fragment F on domain { name chain_id }", .lazy = true },
        .{ .query = "{ domain(where: {id: {_lt: -5}}) { id name } }", .lazy = true },
        .{ .query = "{ a: domain(limit: 3) { id @skip(if: true) } b: domain_by_pk(id: -1) { name @include(if: false) } }", .lazy = true },
        .{ .query = "query ($n: Int) { domain(limit: $n, order_by: {name: desc}) { native_token chain_id } }", .vars = "{\"n\":7}", .lazy = true },
        // Custom scalars over converted columns (bytea, timestamp, interval): today's path.
        .{ .query = "{ raw_message_dispatch(order_by: {id: desc}, limit: 50) { id msg_id nonce origin_domain destination_domain sender recipient msg_body origin_block_height origin_tx_hash time_created } }", .lazy = true },
        .{ .query = try std.fmt.allocPrint(ca, "{{ raw_message_dispatch_by_pk(id: \"{s}\") {{ id msg_id nonce sender time_created }} }}", .{rmd_id}), .lazy = true },
        .{ .query = "query ($o: [Int!]) { message_view(where: {origin_domain_id: {_in: $o}}, order_by: {id: desc}, limit: 100) { id msg_id nonce sender recipient is_delivered send_occurred_at delivery_occurred_at delivery_latency origin_tx_hash destination_tx_hash total_payment num_payments } }", .vars = "{\"o\":[42161,8453]}", .lazy = true },
        .{ .query = "{ message_view(order_by: {id: desc}, limit: 500) { id nonce is_delivered is_provisional origin_chain_id origin_block_height destination_chain_id total_payment num_payments origin_domain destination_domain } }", .lazy = true },
        // Fallbacks: __typename, confirmations, aggregate.
        .{ .query = "{ domain(limit: 2) { __typename id } }", .lazy = false },
        .{ .query = "{ message_view(confirmations: 0, order_by: {id: desc}, limit: 20) { id nonce is_provisional } }", .lazy = false, .snapshot = true },
        .{ .query = "{ message_view_aggregate(where: {is_delivered: {_eq: true}}) { aggregate { count } nodes { id nonce } } }", .lazy = false },
        .{ .query = "{ raw_message_dispatch(limit: 20, order_by: {id: asc}) { id nonce origin_domain destination_domain origin_block_height } }", .lazy = true },
        // Errors: PostgreSQL's and the builder's, through the lazy query.
        .{ .query = "{ domain(limit: -1) { id } }", .lazy = false }, // builder: before any query
        .{ .query = "{ domain(where: {chain_id: {_eq: \"x\"}}) { id } }", .lazy = true },
        .{ .query = "{ a: domain(limit: 1) { id } b: domain(where: {chain_id: {_eq: \"y\"}}) { name } }", .lazy = true },
    };
    for (cases) |c| {
        _ = arena_state.reset(.retain_capacity);
        const before = Counted.lazy_calls;
        const snapshots_before = Counted.snapshot_calls;
        const today = try runDb(a, &f.off, c.query, c.vars);
        const raw = try runDb(a, &f.on, c.query, c.vars);
        if (!std.mem.eql(u8, today, raw)) {
            std.debug.print("query: {s}\n today: {s}\n   raw: {s}\n", .{ c.query, today, raw });
            return error.TestUnexpectedResult;
        }
        if (c.lazy != (Counted.lazy_calls > before) or c.snapshot != (Counted.snapshot_calls > snapshots_before)) {
            std.debug.print("query: {s}: expected lazy={} snapshot={}, calls {d} and {d}\n body: {s}\n", .{ c.query, c.lazy, c.snapshot, Counted.lazy_calls - before, Counted.snapshot_calls - snapshots_before, today[0..@min(today.len, 300)] });
            return error.TestUnexpectedResult;
        }
    }
}

/// `query` as the route executes it (null when it would not execute: parse,
/// validation or variable errors, or no matching operation).
fn runRequest(a: Allocator, map: *@import("resolvers.zig").ResolverMap, query: []const u8, vars: ?Value, operation_name: ?[]const u8) !?[]const u8 {
    const schema = schema_mod.testing.scraper();
    var diag: parser.Diagnostic = .{};
    const doc = parser.parse(a, query, .{}, &diag) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return null,
    };
    if ((try @import("validate.zig").validate(a, schema, doc)).len > 0) return null;
    var op: ?*const @import("ast.zig").Operation = null;
    for (doc.definitions) |d| if (d == .operation) {
        const name = if (d.operation.name) |n| n.value else null;
        if (operation_name) |wanted| {
            if (name != null and std.mem.eql(u8, name.?, wanted)) op = d.operation;
        } else if (op == null) op = d.operation else return null;
    };
    const operation = op orelse return null;
    const coerced = switch (try values.getVariableValues(a, schema, operation.variable_definitions, vars)) {
        .coerced => |c| c,
        else => return null,
    };
    var ex = try execute.Executor.init(a, schema, doc, coerced, map.resolvers());
    const result = try ex.executeQuery(operation, null);
    return try route.serializeResponse(a, 200, result.data, result.errors);
}

// Every GraphQL request of the parity HTTP corpus through both paths, on the
// parity database its samples come from:
//   node src/graphql/tools/dump-http-corpus.mjs parity > /tmp/corpus.json
//   RAW_ROWS_CORPUS=/tmp/corpus.json SCRAPER_PROXY_TEST_DATABASE_URL=$(parity/fixtures/db.sh url scraper_parity) \
//     ./build.sh test-graphql -Dtest-filter="raw rows corpus"
test "raw rows corpus: parity HTTP queries on PostgreSQL match today's bytes (opt-in)" {
    const path = std.posix.getenv("RAW_ROWS_CORPUS") orelse return error.SkipZigTest;
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_DATABASE_URL") orelse return error.SkipZigTest;
    const gpa = std.testing.allocator;
    var f: DbFixture = undefined;
    try f.init(gpa, url);
    defer f.deinit();
    var corpus_arena = std.heap.ArenaAllocator.init(gpa);
    defer corpus_arena.deinit();
    const text = try std.fs.cwd().readFileAlloc(corpus_arena.allocator(), path, 64 << 20);
    const corpus = try json.parse(corpus_arena.allocator(), text, .{});
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var executed: usize = 0;
    var lazy: usize = 0;
    for (corpus.array) |c| {
        _ = arena_state.reset(.retain_capacity);
        const a = arena_state.allocator();
        const query = c.get("query").?.string;
        const vars: ?Value = if (c.get("variables")) |v| (if (v == .null) null else v) else null;
        const op_name: ?[]const u8 = if (c.get("operationName")) |v| (if (v == .string) v.string else null) else null;
        const before = Counted.lazy_calls;
        const today = try runRequest(a, &f.off, query, vars, op_name) orelse continue;
        const raw = (try runRequest(a, &f.on, query, vars, op_name)).?;
        executed += 1;
        if (Counted.lazy_calls > before) lazy += 1;
        if (!std.mem.eql(u8, today, raw)) {
            std.debug.print("case: {s}\n today: {s}\n   raw: {s}\n", .{ c.get("name").?.string, today, raw });
            return error.TestUnexpectedResult;
        }
    }
    std.debug.print("raw rows corpus: {d} of {d} requests executed, {d} used raw rows, all byte-equal\n", .{ executed, corpus.array.len, lazy });
    try std.testing.expect(lazy > 0);
}

// Opt-in: CPU per request of today's path vs raw rows on PostgreSQL
// (execute + serialize, query included), e.g.
//   GRAPHQL_BENCH=1 SCRAPER_PROXY_TEST_DATABASE_URL=... ./build.sh test-graphql -Doptimize=ReleaseFast -Dtest-filter="raw rows bench"
test "raw rows bench: today vs raw on PostgreSQL (opt-in)" {
    if (std.posix.getenv("GRAPHQL_BENCH") == null) return error.SkipZigTest;
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_DATABASE_URL") orelse return error.SkipZigTest;
    const gpa = std.heap.c_allocator;
    var f: DbFixture = undefined;
    try f.init(gpa, url);
    defer f.deinit();
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const Bench = struct { name: []const u8, query: []const u8, n: usize };
    for ([_]Bench{
        .{ .name = "domains (63 rows)", .query = "{ domain(order_by: {id: asc}) { id name chain_id native_token is_test_net is_deprecated } }", .n = 4000 },
        .{ .name = "message_view 500 rows, fast columns", .query = "{ message_view(order_by: {id: desc}, limit: 500) { id nonce is_delivered is_provisional origin_chain_id origin_block_height destination_chain_id total_payment num_payments origin_domain destination_domain } }", .n = 400 },
        .{ .name = "raw_message_dispatch 500 rows with bodies", .query = "{ raw_message_dispatch(order_by: {id: desc}, limit: 500) { id msg_id nonce origin_domain destination_domain sender recipient msg_body origin_block_height origin_tx_hash time_created } }", .n = 200 },
        .{ .name = "message_view list 100", .query = "{ message_view(where: {origin_domain_id: {_in: [42161, 8453]}}, order_by: {id: desc}, limit: 100) { id msg_id nonce sender recipient is_delivered send_occurred_at delivery_occurred_at delivery_latency origin_tx_hash destination_tx_hash total_payment num_payments } }", .n = 400 },
    }) |b| for ([_]bool{ false, true, false, true }) |raw| {
        const map = if (raw) &f.on else &f.off;
        for (0..b.n / 10) |_| {
            _ = arena_state.reset(.retain_capacity);
            _ = try runDb(arena_state.allocator(), map, b.query, null);
        }
        const ru0 = std.posix.getrusage(std.posix.rusage.SELF);
        var timer = try std.time.Timer.start();
        for (0..b.n) |_| {
            _ = arena_state.reset(.retain_capacity);
            _ = try runDb(arena_state.allocator(), map, b.query, null);
        }
        const wall = timer.read();
        const ru1 = std.posix.getrusage(std.posix.rusage.SELF);
        const cpu_us = (ru1.utime.sec - ru0.utime.sec) * 1_000_000 + (ru1.utime.usec - ru0.utime.usec) + (ru1.stime.sec - ru0.stime.sec) * 1_000_000 + (ru1.stime.usec - ru0.stime.usec);
        std.debug.print("{s} [{s}]: {d:.1} us cpu, {d:.1} us wall per request\n", .{ b.name, if (raw) "raw" else "today", @as(f64, @floatFromInt(cpu_us)) / @as(f64, @floatFromInt(b.n)), @as(f64, @floatFromInt(wall / 1000)) / @as(f64, @floatFromInt(b.n)) });
    };
}

/// The response body as the route sends it: the executor's prefixed buffer
/// when it wrote one (no copy; errors are absent in these benches).
fn stageBody(a: Allocator, result: execute.Result) ![]const u8 {
    if (result.body) |b| if (result.errors.len == 0) return b.writer.buffered();
    return route.serializeResponse(a, 200, result.data, result.errors);
}

// Opt-in: the stage cut 1 replaces, isolated from PostgreSQL and libpq: one
// lazy result fetched once, then per request either today's (materialize +
// complete + serialize) or raw rows (written from the PGresult).
//   GRAPHQL_BENCH=1 SCRAPER_PROXY_TEST_DATABASE_URL=... ./build.sh test-graphql -Doptimize=ReleaseFast -Dtest-filter="raw rows stage"
test "raw rows stage bench: today vs raw from one result (opt-in)" {
    if (std.posix.getenv("GRAPHQL_BENCH") == null) return error.SkipZigTest;
    const url = std.posix.getenv("SCRAPER_PROXY_TEST_DATABASE_URL") orelse return error.SkipZigTest;
    const db = @import("db");
    const gpa = std.heap.c_allocator;
    var f: DbFixture = undefined;
    try f.init(gpa, url);
    defer f.deinit();
    const Stage = struct {
        var lazy: *db.LazyRows = undefined;
        var raw_on = false;
        fn noDeinit(_: *anyopaque) void {}
        /// The resolver's SQL work (selected columns + `buildSelect`), whose
        /// query is not sent: the prefetched result stands in for it.
        fn buildSql(a: Allocator, info: *const execute.Info, args: Value) Allocator.Error!void {
            const scraperdb = @import("scraperdb");
            const table = std.meta.stringToEnum(scraperdb.Table, info.field_name) orelse return;
            const columns = try @import("resolvers.zig").selectedColumns(a, info, info.field_nodes);
            var diag: scraperdb.Diag = .{};
            _ = scraperdb.buildSelect(a, table, scraperdb.resolvers.selectArgs(&args, columns), null, &diag) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => @panic("stage bench SQL"),
            };
        }
        fn resolve(_: *anyopaque, a: Allocator, info: *const execute.Info, _: Value, args: Value) Allocator.Error!execute.ResolveResult {
            if (!std.mem.eql(u8, info.parent_type.name, "query_root")) return .default;
            try buildSql(a, info, args);
            return .{ .value = .{ .array = try lazy.materialize(a) } };
        }
        fn resolveRaw(_: *anyopaque, a: Allocator, info: *const execute.Info, _: Value, args: Value) Allocator.Error!execute.RawResult {
            if (!raw_on or !std.mem.eql(u8, info.parent_type.name, "query_root")) return .none;
            try buildSql(a, info, args);
            var raw = try @import("resolvers.zig").rawRows(a, lazy);
            raw.deinit_fn = noDeinit;
            return .{ .rows = raw };
        }
    };
    var keep = std.heap.ArenaAllocator.init(gpa);
    defer keep.deinit();
    var failure: db.Failure = .{};
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const Bench = struct { name: []const u8, sql: []const u8, query: []const u8, n: usize };
    // GRAPHQL_PROFILE_STAGE=<name prefix>: loop that case's today path for a
    // sampler (pid in GRAPHQL_PROFILE_PID_FILE) instead of comparing.
    const profile = std.posix.getenv("GRAPHQL_PROFILE_STAGE");
    if (std.posix.getenv("GRAPHQL_PROFILE_PID_FILE")) |path| {
        var buf: [16]u8 = undefined;
        try std.fs.cwd().writeFile(.{ .sub_path = path, .data = try std.fmt.bufPrint(&buf, "{d}\n", .{std.c.getpid()}) });
    }
    for ([_]Bench{
        .{ .name = "rmd 500 with bodies", .sql = "SELECT \"id\", \"msg_id\", \"nonce\", \"origin_domain\", \"destination_domain\", \"sender\", \"recipient\", \"msg_body\", \"origin_block_height\", \"origin_tx_hash\", \"time_created\" FROM \"raw_message_dispatch\" ORDER BY \"id\" DESC LIMIT 500", .query = "{ raw_message_dispatch { id msg_id nonce origin_domain destination_domain sender recipient msg_body origin_block_height origin_tx_hash time_created } }", .n = 2000 },
        .{ .name = "mv 500 Explorer stub", .sql = "SELECT \"id\", \"msg_id\", \"nonce\", \"sender\", \"recipient\", \"is_delivered\", \"is_provisional\", \"send_occurred_at\", \"delivery_occurred_at\", \"delivery_latency\", \"origin_chain_id\", \"origin_block_height\", \"origin_domain_id\", \"origin_tx_id\", \"origin_tx_hash\", \"origin_tx_sender\", \"origin_tx_recipient\", \"destination_chain_id\", \"destination_domain_id\", \"destination_tx_id\", \"destination_tx_hash\", \"destination_tx_sender\", \"destination_tx_recipient\", \"message_body\" FROM (SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\" ORDER BY \"id\" DESC LIMIT 500", .query = "{ message_view { id msg_id nonce sender recipient is_delivered is_provisional send_occurred_at delivery_occurred_at delivery_latency origin_chain_id origin_block_height origin_domain_id origin_tx_id origin_tx_hash origin_tx_sender origin_tx_recipient destination_chain_id destination_domain_id destination_tx_id destination_tx_hash destination_tx_sender destination_tx_recipient message_body } }", .n = 1000 },
        .{ .name = "mv list 100", .sql = "SELECT \"id\", \"msg_id\", \"nonce\", \"sender\", \"recipient\", \"is_delivered\", \"send_occurred_at\", \"delivery_occurred_at\", \"delivery_latency\", \"origin_tx_hash\", \"destination_tx_hash\", \"total_payment\", \"num_payments\" FROM (SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\" WHERE \"origin_domain_id\" IN (42161, 8453) ORDER BY \"id\" DESC LIMIT 100", .query = "{ message_view { id msg_id nonce sender recipient is_delivered send_occurred_at delivery_occurred_at delivery_latency origin_tx_hash destination_tx_hash total_payment num_payments } }", .n = 5000 },
        .{ .name = "by id details", .sql = "SELECT \"id\", \"msg_id\", \"nonce\", \"sender\", \"recipient\", \"is_delivered\", \"is_provisional\", \"send_occurred_at\", \"delivery_occurred_at\", \"delivery_latency\", \"origin_chain_id\", \"origin_block_height\", \"origin_domain_id\", \"origin_tx_id\", \"origin_tx_hash\", \"origin_tx_sender\", \"origin_tx_recipient\", \"destination_chain_id\", \"destination_domain_id\", \"destination_tx_id\", \"destination_tx_hash\", \"destination_tx_sender\", \"destination_tx_recipient\", \"message_body\", \"origin_block_hash\", \"origin_block_id\", \"origin_mailbox\", \"origin_tx_cumulative_gas_used\", \"origin_tx_effective_gas_price\", \"origin_tx_gas_limit\", \"origin_tx_gas_price\", \"origin_tx_gas_used\", \"origin_tx_max_fee_per_gas\", \"origin_tx_max_priority_fee_per_gas\", \"origin_tx_nonce\", \"destination_block_hash\", \"destination_block_height\", \"destination_block_id\", \"destination_mailbox\", \"destination_tx_cumulative_gas_used\", \"destination_tx_effective_gas_price\", \"destination_tx_gas_limit\", \"destination_tx_gas_price\", \"destination_tx_gas_used\", \"destination_tx_max_fee_per_gas\", \"destination_tx_max_priority_fee_per_gas\", \"destination_tx_nonce\", \"total_gas_amount\", \"total_payment\", \"num_payments\" FROM (SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\" WHERE \"msg_id\" = (SELECT \"msg_id\" FROM \"message_view\" ORDER BY \"id\" DESC LIMIT 1) LIMIT 1", .query = "{ message_view(where: {send_occurred_at: {_is_null: false}, msg_id: {_eq: \"\\\\x00\"}}, limit: 1) { id msg_id nonce sender recipient is_delivered is_provisional send_occurred_at delivery_occurred_at delivery_latency origin_chain_id origin_block_height origin_domain_id origin_tx_id origin_tx_hash origin_tx_sender origin_tx_recipient destination_chain_id destination_domain_id destination_tx_id destination_tx_hash destination_tx_sender destination_tx_recipient message_body origin_block_hash origin_block_id origin_mailbox origin_tx_cumulative_gas_used origin_tx_effective_gas_price origin_tx_gas_limit origin_tx_gas_price origin_tx_gas_used origin_tx_max_fee_per_gas origin_tx_max_priority_fee_per_gas origin_tx_nonce destination_block_hash destination_block_height destination_block_id destination_mailbox destination_tx_cumulative_gas_used destination_tx_effective_gas_price destination_tx_gas_limit destination_tx_gas_price destination_tx_gas_used destination_tx_max_fee_per_gas destination_tx_max_priority_fee_per_gas destination_tx_nonce total_gas_amount total_payment num_payments } }", .n = 40000 },
        .{ .name = "domains 63", .sql = "SELECT \"id\", \"name\", \"chain_id\", \"native_token\", \"is_test_net\", \"is_deprecated\" FROM \"domain\" ORDER BY \"id\" ASC", .query = "{ domain { id name chain_id native_token is_test_net is_deprecated } }", .n = 40000 },
    }) |b| {
        Stage.lazy = (try f.dbs.queryLazy(keep.allocator(), b.sql, &.{}, .unnamed, &failure)).?;
        defer Stage.lazy.deinit();
        const schema = schema_mod.testing.scraper();
        var diag: parser.Diagnostic = .{};
        const doc = try parser.parse(keep.allocator(), b.query, .{}, &diag);
        const coerced = (try values.getVariableValues(keep.allocator(), schema, doc.definitions[0].operation.variable_definitions, null)).coerced;
        if (profile) |name| {
            if (!std.mem.startsWith(u8, b.name, name)) continue;
            // The profile arm loops the raw path only (production's path);
            // the comparison rows below still time both arms.
            Stage.raw_on = true;
            for (0..b.n * 100) |_| {
                _ = arena_state.reset(.retain_capacity);
                const a = arena_state.allocator();
                var ex = try execute.Executor.init(a, schema, doc, coerced, .{ .ctx = &Stage.raw_on, .resolve = Stage.resolve, .resolve_raw = Stage.resolveRaw });
                const result = try ex.executeQuery(doc.definitions[0].operation, null);
                _ = try stageBody(a, result);
            }
            continue;
        }
        var bodies: [2][]const u8 = undefined;
        var samples: [2][7]f64 = undefined;
        for (0..7) |round| for ([_]bool{ false, true }) |raw| {
            Stage.raw_on = raw;
            const t0 = try std.time.Instant.now();
            for (0..b.n) |_| {
                _ = arena_state.reset(.retain_capacity);
                const a = arena_state.allocator();
                var ex = try execute.Executor.init(a, schema, doc, coerced, .{ .ctx = &Stage.raw_on, .resolve = Stage.resolve, .resolve_raw = Stage.resolveRaw });
                const result = try ex.executeQuery(doc.definitions[0].operation, null);
                const body = try stageBody(a, result);
                if (round == 0) bodies[@intFromBool(raw)] = try keep.allocator().dupe(u8, body);
            }
            const t1 = try std.time.Instant.now();
            samples[@intFromBool(raw)][round] = @as(f64, @floatFromInt(t1.since(t0))) / 1000.0 / @as(f64, @floatFromInt(b.n));
        };
        try std.testing.expectEqualStrings(bodies[0], bodies[1]);
        for (&samples) |*s| std.mem.sort(f64, s, {}, std.sort.asc(f64));
        std.debug.print("{s}: today {d:.2} us, raw {d:.2} us per request (median of 7; min {d:.2} / {d:.2}); raw/today {d:.3}\n", .{ b.name, samples[0][3], samples[1][3], samples[0][0], samples[1][0], samples[1][3] / samples[0][3] });
    }
}
