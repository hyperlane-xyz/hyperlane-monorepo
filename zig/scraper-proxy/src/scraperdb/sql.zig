//! Port of `scraperdb/sql.ts`: Hasura-style arguments -> parameterised SQL.
//! Statement order mirrors the TS so the same assertion wins and `$n` numbering
//! matches; output SQL text is byte-identical (asserted via testdata/corpus.json).
const std = @import("std");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;

const tables = @import("tables.zig");
const Table = tables.Table;
const value = @import("value.zig");
const Value = value.Value;

pub const Error = error{ AssertionFailed, OutOfMemory };

/// Carries the TS `assert` message for `error.AssertionFailed`.
pub const Diag = struct {
    message: []const u8 = "",
};

pub const Sql = struct {
    sql: []const u8,
    values: []Value,
};

pub const Source = struct {
    relation: []const u8,
    values: []const Value = &.{},
};

/// Top-level JS null and undefined are equivalent for every argument.
pub const SelectArgs = struct {
    /// Selected fields; duplicates and non-columns are ignored. null = all columns.
    columns: ?[]const []const u8 = null,
    cursor: ?Value = null,
    distinct_on: ?Value = null,
    limit: ?Value = null,
    offset: ?Value = null,
    order_by: ?Value = null,
    where: ?Value = null,
};

pub const CountArgs = struct {
    columns: ?Value = null,
    distinct: ?Value = null,
};

pub const MAX = struct {
    pub const bool_depth = 8;
    pub const bool_predicates = 100;
    pub const distinct_columns = 3;
    pub const in_items = 200;
    pub const limit = 500;
    pub const offset = 5_000;
    pub const order_columns = 3;
};

const OrderColumn = struct { column: []const u8, direction: Value };
const Cursor = struct { id: Value, desc: bool };
const Validated = struct { cursor: ?Cursor, orders: []const OrderColumn };

const Builder = struct {
    arena: Allocator,
    diag: *Diag,
    table: Table,
    values: std.ArrayList(Value) = .empty,

    fn fail(self: *Builder, comptime fmt: []const u8, args: anytype) Error {
        self.diag.message = try std.fmt.allocPrint(self.arena, fmt, args);
        return error.AssertionFailed;
    }

    fn check(self: *Builder, ok: bool, comptime fmt: []const u8, args: anytype) Error!void {
        if (!ok) return self.fail(fmt, args);
    }

    fn assertColumn(self: *Builder, column: Value) Error![]const u8 {
        if (value.string(column)) |name| {
            if (self.table.spec().hasColumn(name)) return name;
        }
        var text: Writer.Allocating = .init(self.arena);
        value.writeJsString(&text.writer, column) catch return error.OutOfMemory;
        return self.fail("Unsupported column {s}.{s}", .{ self.table.name(), text.written() });
    }

    fn bind(self: *Builder, w: *Writer, item: Value) Error!void {
        try self.values.append(self.arena, item);
        w.print("${d}", .{self.values.items.len}) catch return error.OutOfMemory;
    }

    fn newText(self: *Builder) Writer.Allocating {
        return .init(self.arena);
    }
};

pub fn buildSelect(arena: Allocator, table: Table, args: SelectArgs, source: ?Source, diag: *Diag) Error!Sql {
    var b: Builder = .{ .arena = arena, .diag = diag, .table = table };
    const checked = try validate(&b, args);
    if (source) |s| try b.values.appendSlice(arena, s.values);
    const filters = try renderFilters(&b, args.where, checked.cursor);

    var out = b.newText();
    const w = &out.writer;
    write(w, "SELECT ") catch return error.OutOfMemory;
    try writeDistinct(&b, w, args.distinct_on);
    try writeColumns(&b, w, args.columns);
    write(w, " FROM ") catch return error.OutOfMemory;
    writeRelation(w, table, if (source) |s| s.relation else null) catch return error.OutOfMemory;
    if (filters.len > 0) w.print(" WHERE {s}", .{filters}) catch return error.OutOfMemory;
    try writeOrderBy(&b, w, checked.orders, checked.cursor);
    try writeLimit(&b, w, value.present(args.limit) orelse value.integer(MAX.limit), " LIMIT ");
    if (value.present(args.offset)) |offset| try writeLimit(&b, w, offset, " OFFSET ");
    return .{ .sql = out.written(), .values = b.values.items };
}

pub fn buildCount(arena: Allocator, table: Table, args: SelectArgs, count: CountArgs, diag: *Diag) Error!Sql {
    var b: Builder = .{ .arena = arena, .diag = diag, .table = table };
    const checked = try validate(&b, args);

    var count_columns: std.ArrayList([]const u8) = .empty;
    const columns_arg = value.present(count.columns);
    if (columns_arg != null) {
        for (value.listOrSingle(&columns_arg.?)) |column| {
            const name = try b.assertColumn(column);
            if (!containsString(count_columns.items, name)) try count_columns.append(arena, name);
        }
    }

    var distinct_text = b.newText();
    try writeDistinct(&b, &distinct_text.writer, args.distinct_on);
    const distinct_clause = distinct_text.written();
    const filters = try renderFilters(&b, args.where, checked.cursor);

    var limit_text = b.newText();
    if (value.present(args.limit)) |limit| try writeLimit(&b, &limit_text.writer, limit, " LIMIT ");
    var offset_text = b.newText();
    if (value.present(args.offset)) |offset| try writeLimit(&b, &offset_text.writer, offset, " OFFSET ");

    var out = b.newText();
    const w = &out.writer;
    write(w, "SELECT ") catch return error.OutOfMemory;
    writeCountExpression(w, count_columns.items, value.truthy(count.distinct)) catch return error.OutOfMemory;
    write(w, "::int AS count FROM ") catch return error.OutOfMemory;
    const windowed = distinct_clause.len > 0 or limit_text.written().len > 0 or offset_text.written().len > 0;
    if (windowed) {
        w.print("(SELECT {s}", .{distinct_clause}) catch return error.OutOfMemory;
        if (count_columns.items.len > 0)
            writeQuotedList(w, count_columns.items) catch return error.OutOfMemory
        else
            write(w, "1") catch return error.OutOfMemory;
        write(w, " FROM ") catch return error.OutOfMemory;
    }
    writeRelation(w, table, null) catch return error.OutOfMemory;
    if (filters.len > 0) w.print(" WHERE {s}", .{filters}) catch return error.OutOfMemory;
    if (windowed) {
        try writeOrderBy(&b, w, checked.orders, null);
        w.print("{s}{s}) AS rows", .{ limit_text.written(), offset_text.written() }) catch return error.OutOfMemory;
    }
    return .{ .sql = out.written(), .values = b.values.items };
}

pub fn buildByPk(arena: Allocator, table: Table, id: Value, selected: ?[]const []const u8, diag: *Diag) Error!Sql {
    var b: Builder = .{ .arena = arena, .diag = diag, .table = table };
    const spec = table.spec();
    const primary_key = spec.primary_key orelse
        return b.fail("{s} does not expose a primary-key query", .{table.name()});
    var out = b.newText();
    const w = &out.writer;
    write(w, "SELECT ") catch return error.OutOfMemory;
    try writeColumns(&b, w, selected);
    write(w, " FROM ") catch return error.OutOfMemory;
    tables.writeQuoted(w, spec.relation orelse table.name()) catch return error.OutOfMemory;
    write(w, " WHERE ") catch return error.OutOfMemory;
    tables.writeQuoted(w, primary_key) catch return error.OutOfMemory;
    write(w, " = $1 LIMIT 1") catch return error.OutOfMemory;
    const values = try arena.alloc(Value, 1);
    values[0] = id;
    return .{ .sql = out.written(), .values = values };
}

fn write(w: *Writer, text: []const u8) Writer.Error!void {
    try w.writeAll(text);
}

fn containsString(items: []const []const u8, needle: []const u8) bool {
    for (items) |item| if (std.mem.eql(u8, item, needle)) return true;
    return false;
}

fn writeQuotedList(w: *Writer, names: []const []const u8) Writer.Error!void {
    for (names, 0..) |name, index| {
        if (index > 0) try w.writeAll(", ");
        try tables.writeQuoted(w, name);
    }
}

fn writeCountExpression(w: *Writer, columns: []const []const u8, distinct: bool) Writer.Error!void {
    if (columns.len == 0) return w.writeAll("COUNT(*)");
    try w.writeAll(if (distinct) "COUNT(DISTINCT " else "COUNT(");
    if (columns.len == 1) {
        try tables.writeQuoted(w, columns[0]);
    } else {
        try w.writeByte('(');
        try writeQuotedList(w, columns);
        try w.writeByte(')');
    }
    try w.writeByte(')');
}

fn writeColumns(b: *Builder, w: *Writer, selected: ?[]const []const u8) Error!void {
    const spec = b.table.spec();
    const names = selected orelse spec.columns;
    var allowed: std.ArrayList([]const u8) = .empty;
    for (names) |name| {
        if (spec.hasColumn(name) and !containsString(allowed.items, name)) try allowed.append(b.arena, name);
    }
    if (allowed.items.len == 0) try allowed.append(b.arena, spec.primary_key orelse spec.columns[0]);
    writeQuotedList(w, allowed.items) catch return error.OutOfMemory;
}

fn writeRelation(w: *Writer, table: Table, custom: ?[]const u8) Writer.Error!void {
    if (custom) |relation| if (relation.len > 0) return tables.writeQuoted(w, relation);
    // Provisional state is query metadata, not a stored message_view column.
    if (table == .message_view)
        return w.writeAll("(SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\"");
    try tables.writeQuoted(w, table.spec().relation orelse table.name());
}

fn writeDistinct(b: *Builder, w: *Writer, selected: ?Value) Error!void {
    const list = value.present(selected) orelse return;
    const items = value.listOrSingle(&list);
    if (items.len == 0) return;
    var names = try b.arena.alloc([]const u8, items.len);
    for (items, 0..) |item, index| names[index] = try b.assertColumn(item);
    write(w, "DISTINCT ON (") catch return error.OutOfMemory;
    writeQuotedList(w, names) catch return error.OutOfMemory;
    write(w, ") ") catch return error.OutOfMemory;
}

fn writeLimit(b: *Builder, w: *Writer, item: Value, keyword: []const u8) Error!void {
    write(w, keyword) catch return error.OutOfMemory;
    try b.bind(w, item);
}

fn writeOrderBy(b: *Builder, w: *Writer, orders: []const OrderColumn, cursor: ?Cursor) Error!void {
    if (orders.len == 0) {
        if (cursor) |c| write(w, if (c.desc) " ORDER BY \"id\" DESC" else " ORDER BY \"id\" ASC") catch return error.OutOfMemory;
        return;
    }
    // Assert every column before writing, as TS maps before joining.
    var rendered = b.newText();
    for (orders, 0..) |order, index| {
        const column = try b.assertColumn(.{ .string = order.column });
        const direction = value.string(order.direction) orelse
            return b.fail("direction.split is not a function", .{});
        if (index > 0) write(&rendered.writer, ", ") catch return error.OutOfMemory;
        writeOrder(&rendered.writer, column, direction) catch return error.OutOfMemory;
    }
    w.print(" ORDER BY {s}", .{rendered.written()}) catch return error.OutOfMemory;
}

fn writeOrder(w: *Writer, column: []const u8, direction: []const u8) Writer.Error!void {
    var parts = std.mem.splitScalar(u8, direction, '_');
    const sort = parts.first();
    _ = parts.next();
    const nulls = parts.next();
    try tables.writeQuoted(w, column);
    try w.writeByte(' ');
    try writeUpper(w, sort);
    if (nulls) |n| if (n.len > 0) {
        try w.writeAll(" NULLS ");
        try writeUpper(w, n);
    };
}

fn writeUpper(w: *Writer, text: []const u8) Writer.Error!void {
    for (text) |c| try w.writeByte(std.ascii.toUpper(c));
}

/// `[where(...), cursorWhere(...)].filter(Boolean).join(' AND ')`.
fn renderFilters(b: *Builder, where: ?Value, cursor: ?Cursor) Error![]const u8 {
    var renderer: WhereRenderer = .{ .b = b };
    const rendered_where = try renderer.render(value.object(value.present(where)), 0);
    var out = b.newText();
    const w = &out.writer;
    write(w, rendered_where) catch return error.OutOfMemory;
    if (cursor) |c| {
        if (rendered_where.len > 0) write(w, " AND ") catch return error.OutOfMemory;
        write(w, if (c.desc) "(\"id\" < " else "(\"id\" > ") catch return error.OutOfMemory;
        try b.bind(w, c.id);
        write(w, ")") catch return error.OutOfMemory;
    }
    return out.written();
}

const WhereRenderer = struct {
    b: *Builder,
    predicates: usize = 0,

    fn render(self: *WhereRenderer, expression: ?value.Object, depth: usize) Error![]const u8 {
        const obj = expression orelse return "";
        try self.b.check(depth <= MAX.bool_depth, "where exceeds maximum depth of {d}", .{MAX.bool_depth});
        var parts: std.ArrayList([]const u8) = .empty;
        for (0..value.len(obj)) |index| {
            const key = value.keyAt(obj, index);
            const item = value.valueAt(obj, index).*;
            const is_group = std.mem.eql(u8, key, "_and") or std.mem.eql(u8, key, "_or");
            self.predicates += if (is_group) (if (value.array(item)) |items| items.len else 1) else 1;
            try self.b.check(self.predicates <= MAX.bool_predicates, "where exceeds maximum of {d} predicates", .{MAX.bool_predicates});
            const rendered = try self.boolean(key, value.valueAt(obj, index), depth);
            if (rendered.len > 0) try parts.append(self.b.arena, rendered);
        }
        return self.join(parts.items, " AND ");
    }

    fn boolean(self: *WhereRenderer, key: []const u8, item: *const Value, depth: usize) Error![]const u8 {
        if (item.* == .null) return "";
        const is_and = std.mem.eql(u8, key, "_and");
        const is_or = std.mem.eql(u8, key, "_or");
        if (is_and or is_or) {
            const children = value.listOrSingle(item);
            if (is_or and children.len == 0) return "FALSE";
            const value_count = self.b.values.items.len;
            var parts: std.ArrayList([]const u8) = .empty;
            for (children) |child| {
                const rendered = try self.render(value.object(child), depth + 1);
                if (rendered.len > 0) try parts.append(self.b.arena, rendered);
            }
            if (is_or and parts.items.len < children.len) {
                // An empty OR branch matches everything; drop its parameters too.
                self.b.values.shrinkRetainingCapacity(value_count);
                return "";
            }
            return self.join(parts.items, if (is_and) " AND " else " OR ");
        }
        if (std.mem.eql(u8, key, "_not")) {
            const rendered = try self.render(value.object(item.*), depth + 1);
            if (rendered.len == 0) return "FALSE";
            return std.fmt.allocPrint(self.b.arena, "NOT {s}", .{rendered});
        }
        const column = try self.b.assertColumn(.{ .string = key });
        var quoted = self.b.newText();
        tables.writeQuoted(&quoted.writer, column) catch return error.OutOfMemory;
        var parts: std.ArrayList([]const u8) = .empty;
        if (value.object(item.*)) |comparisons| {
            for (0..value.len(comparisons)) |index| {
                const rendered = try self.comparison(quoted.written(), value.keyAt(comparisons, index), value.valueAt(comparisons, index).*);
                if (rendered.len > 0) try parts.append(self.b.arena, rendered);
            }
        }
        return self.join(parts.items, " AND ");
    }

    fn comparison(self: *WhereRenderer, column: []const u8, operator: []const u8, operand: Value) Error![]const u8 {
        const b = self.b;
        if (operand == .null) return "";
        if (std.mem.eql(u8, operator, "_is_null"))
            return std.fmt.allocPrint(b.arena, "{s} IS {s}NULL", .{ column, if (value.truthy(operand)) "" else "NOT " });
        const sql_operator = operators.get(operator) orelse
            return b.fail("Unsupported comparison operator {s}", .{operator});
        var out = b.newText();
        const w = &out.writer;
        const is_in = std.mem.eql(u8, operator, "_in");
        if (is_in or std.mem.eql(u8, operator, "_nin")) {
            const items = value.array(operand) orelse &.{};
            try b.check(items.len <= MAX.in_items, "{s} exceeds maximum of {d} items", .{ operator, MAX.in_items });
            if (items.len == 0) return if (is_in) "FALSE" else "TRUE";
            w.print("{s} {s}(", .{ column, if (is_in) "= ANY" else "<> ALL" }) catch return error.OutOfMemory;
            try b.bind(w, operand);
            write(w, ")") catch return error.OutOfMemory;
            return out.written();
        }
        w.print("{s} {s} ", .{ column, sql_operator }) catch return error.OutOfMemory;
        try b.bind(w, operand);
        return out.written();
    }

    fn join(self: *WhereRenderer, parts: []const []const u8, separator: []const u8) Error![]const u8 {
        if (parts.len == 0) return "";
        var out = self.b.newText();
        const w = &out.writer;
        write(w, "(") catch return error.OutOfMemory;
        for (parts, 0..) |part, index| {
            if (index > 0) write(w, separator) catch return error.OutOfMemory;
            write(w, part) catch return error.OutOfMemory;
        }
        write(w, ")") catch return error.OutOfMemory;
        return out.written();
    }
};

const operators = std.StaticStringMap([]const u8).initComptime(.{
    .{ "_eq", "=" },
    .{ "_gt", ">" },
    .{ "_gte", ">=" },
    .{ "_in", "IN" },
    .{ "_lt", "<" },
    .{ "_lte", "<=" },
    .{ "_neq", "<>" },
    .{ "_nin", "NOT IN" },
});

fn validate(b: *Builder, args: SelectArgs) Error!Validated {
    try boundedInteger(b, args.limit, "limit", MAX.limit);
    try boundedInteger(b, args.offset, "offset", MAX.offset);
    const distinct_arg = value.present(args.distinct_on);
    const distinct_items: []const Value = if (distinct_arg != null) value.listOrSingle(&distinct_arg.?) else &.{};
    try boundedColumns(b, distinct_items.len, "distinct_on", MAX.distinct_columns);

    var orders: std.ArrayList(OrderColumn) = .empty;
    const order_arg = value.present(args.order_by);
    if (order_arg != null) {
        for (value.listOrSingle(&order_arg.?)) |order| {
            const obj = value.object(order) orelse continue;
            for (0..value.len(obj)) |index| {
                const direction = value.valueAt(obj, index).*;
                if (direction == .null) continue;
                try orders.append(b.arena, .{ .column = value.keyAt(obj, index), .direction = direction });
            }
        }
    }
    try boundedColumns(b, orders.items.len, "order_by", MAX.order_columns);
    const cursor = try validateCursor(b, args.cursor, orders.items);

    if (distinct_items.len > 0) {
        const order_count = if (orders.items.len > 0) orders.items.len else if (cursor != null) @as(usize, 1) else 0;
        if (order_count > 0) {
            for (distinct_items, 0..) |item, index| {
                const order_column: ?[]const u8 = if (index >= order_count)
                    null
                else if (orders.items.len > 0) orders.items[index].column else "id";
                const name = value.string(item);
                const matches = order_column != null and name != null and std.mem.eql(u8, order_column.?, name.?);
                try b.check(matches, "distinct_on columns must match the leftmost order_by columns", .{});
            }
        }
    }
    return .{ .cursor = cursor, .orders = orders.items };
}

fn validateCursor(b: *Builder, cursors_arg: ?Value, orders: []const OrderColumn) Error!?Cursor {
    const cursors_value = value.present(cursors_arg) orelse return null;
    const cursors = value.listOrSingle(&cursors_value);
    if (cursors.len == 0) return null;
    try b.check(b.table == .message_view, "Only message_view supports cursors", .{});
    const cursor = value.object(cursors[0]);
    const initial = if (cursor) |c| value.object(value.get(c, "initial_value")) else null;
    const key_count = if (initial) |i| value.len(i) else 0;
    try b.check(cursors.len == 1 and key_count == 1, "message_view cursor must contain one column", .{});
    const cursor_column = value.keyAt(initial.?, 0);
    const cursor_value = value.valueAt(initial.?, 0).*;
    try b.check(std.mem.eql(u8, cursor_column, "id"), "message_view cursor column must be id", .{});
    try b.check(cursor_value != .null, "message_view cursor value must be non-null", .{});
    const ordering = value.get(cursor.?, "ordering");
    const desc = if (ordering) |o| if (value.string(o)) |s| std.mem.eql(u8, s, "DESC") else false else false;
    if (orders.len == 0) return .{ .id = cursor_value, .desc = desc };

    const order_desc = if (value.string(orders[0].direction)) |d| std.mem.startsWith(u8, d, "desc") else false;
    try b.check(
        orders.len == 1 and std.mem.eql(u8, cursor_column, orders[0].column) and desc == order_desc,
        "cursor columns and directions must match order_by",
        .{},
    );
    return .{ .id = cursor_value, .desc = desc };
}

fn boundedInteger(b: *Builder, arg: ?Value, name: []const u8, max: u32) Error!void {
    const item = value.present(arg) orelse return;
    try b.check(value.isInteger(item) and value.number(item).? >= 0, "{s} must be a non-negative integer", .{name});
    try b.check(value.number(item).? <= @as(f64, @floatFromInt(max)), "{s} exceeds maximum of {d}", .{ name, max });
}

fn boundedColumns(b: *Builder, count: usize, name: []const u8, max: usize) Error!void {
    try b.check(count == 0 or count <= max, "{s} exceeds maximum of {d} columns", .{ name, max });
}
