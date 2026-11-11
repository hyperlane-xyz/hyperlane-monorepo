//! Port of `scraperdb/scraperdb.service.ts` and `database.ts`.
const std = @import("std");
const Allocator = std.mem.Allocator;

const provisional = @import("provisional_message.zig");
const sql = @import("sql.zig");
const Table = @import("tables.zig").Table;
const value = @import("value.zig");
const Value = value.Value;

const Diag = sql.Diag;
const SelectArgs = sql.SelectArgs;

// Bound unauthenticated custom-frontier scans; larger history uses canonical queries.
pub const MAX_CONFIRMATIONS = 1_000;
pub const MAX_AFFECTED_EVENTS = 10_000;

/// `ScraperDbDatabase`: rows are `.object` Values allocated in `arena`, with
/// node-pg value conversion. Parameters are raw JSON Values (node-pg
/// `prepareValue` semantics are the implementation's job). On failure the
/// implementation sets `diag.message` to the node-pg `error.message` (it
/// becomes the GraphQL error message, as in TS) and returns an error.
pub const Database = struct {
    ctx: *anyopaque,
    queryFn: *const fn (ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value,

    pub fn query(self: Database, arena: Allocator, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value {
        return self.queryFn(self.ctx, arena, text, values, diag);
    }
};

/// `message_view` arguments: the select args plus `confirmations`.
pub const MessageSelectArgs = struct {
    select: SelectArgs = .{},
    confirmations: ?Value = null,
};

pub const Service = struct {
    db: Database,

    pub fn init(db: Database) Service {
        return .{ .db = db };
    }

    pub fn select(self: Service, arena: Allocator, table: Table, args: SelectArgs, diag: *Diag) anyerror![]Value {
        const query = try sql.buildSelect(arena, table, args, null, diag);
        return self.db.query(arena, query.sql, query.values, diag);
    }

    pub fn selectMessages(self: Service, arena: Allocator, args: MessageSelectArgs, diag: *Diag) anyerror![]Value {
        const select_args = args.select;
        const confirmations = value.present(args.confirmations) orelse
            return self.select(arena, .message_view, select_args, diag);
        const queries = try buildMessageQueries(arena, select_args, confirmations, diag);
        const rows = try self.db.query(arena, queries.snapshot.sql, queries.snapshot.values, diag);
        const projection = try buildProjection(arena, select_args, if (rows.len > 0) rows[0] else null, diag);
        return self.db.query(arena, projection.sql, projection.values, diag);
    }

    pub fn byPk(self: Service, arena: Allocator, table: Table, id: Value, columns: ?[]const []const u8, diag: *Diag) anyerror!?Value {
        const query = try sql.buildByPk(arena, table, id, columns, diag);
        const rows = try self.db.query(arena, query.sql, query.values, diag);
        return if (rows.len > 0) rows[0] else null;
    }

    /// `aggregate(...).nodes`. Without selected `nodes` columns TS returns []
    /// without validating; validation then happens in `count`.
    pub fn aggregateNodes(self: Service, arena: Allocator, table: Table, args: SelectArgs, columns: ?[]const []const u8, diag: *Diag) anyerror![]Value {
        const selected = columns orelse return &.{};
        var with_columns = args;
        with_columns.columns = selected;
        return self.select(arena, table, with_columns, diag);
    }

    pub fn count(self: Service, arena: Allocator, table: Table, args: SelectArgs, count_args: sql.CountArgs, diag: *Diag) anyerror!i64 {
        const query = try sql.buildCount(arena, table, args, count_args, diag);
        const rows = try self.db.query(arena, query.sql, query.values, diag);
        const row = if (rows.len > 0) value.object(rows[0]) else null;
        const result = if (row) |r| value.get(r, "count") else null;
        if (result) |n| if (value.isJsNumber(n) and value.isSafeInteger(n)) if (value.number(n)) |number|
            return @intFromFloat(number);
        diag.message = "Invalid database count result";
        return error.AssertionFailed;
    }
};

const SnapshotQuery = struct { snapshot: sql.Sql };

/// Validates the confirmations request and builds the snapshot query.
pub fn buildMessageQueries(arena: Allocator, select_args: SelectArgs, confirmations: Value, diag: *Diag) sql.Error!SnapshotQuery {
    if (!(value.isSafeInteger(confirmations) and value.number(confirmations).? >= 0))
        return fail(diag, "confirmations must be a non-negative safe integer");
    if (value.number(confirmations).? > MAX_CONFIRMATIONS)
        return fail(diag, std.fmt.comptimePrint("confirmations exceeds maximum of {d}", .{MAX_CONFIRMATIONS}));
    if (value.truthy(select_args.offset)) return fail(diag, "offset is unsupported with confirmations");
    if (value.present(select_args.cursor)) |cursor| {
        if (value.listOrSingle(&cursor).len > 0)
            return fail(diag, "cursor is unsupported with confirmations; paginate canonical history separately");
    }
    // Validate filters before either database query, including recursive limits.
    _ = try sql.buildSelect(arena, .message_view, select_args, null, diag);
    const ids = try messageIds(arena, select_args.where);
    const text = if (ids == null) snapshot_sql_unfiltered else snapshot_sql_filtered;
    const values = try arena.alloc(Value, if (ids == null) 1 else 2);
    values[0] = confirmations;
    if (ids) |bound| values[1] = bound;
    return .{ .snapshot = .{ .sql = text, .values = values } };
}

fn snapshotSql(comptime filtered: bool) []const u8 {
    return std.fmt.comptimePrint(
        \\WITH custom_frontier AS (
        \\        SELECT domain, least(indexed_height, head_height-$1::integer) AS height,
        \\          confirmed_height FROM scraper_head
        \\      ), affected AS MATERIALIZED (
        \\        SELECT msg_id FROM ({s}) events
        \\          LIMIT {d}
        \\      ) SELECT array_agg(domain) AS domains, array_agg(height::text) AS heights,
        \\        CASE WHEN (SELECT count(*) FROM affected)>{d}
        \\          THEN NULL ELSE ARRAY(SELECT msg_id FROM affected) END AS message_ids
        \\        FROM custom_frontier
    , .{ provisional.affectedQuery(filtered), MAX_AFFECTED_EVENTS + 1, MAX_AFFECTED_EVENTS });
}

const snapshot_sql_unfiltered = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk snapshotSql(false);
};
const snapshot_sql_filtered = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk snapshotSql(true);
};

/// Builds the projection query from the snapshot row (`rows[0]`, if any).
pub fn buildProjection(arena: Allocator, select_args: SelectArgs, snapshot_row: ?Value, diag: *Diag) sql.Error!sql.Sql {
    const snapshot = snapshot_row orelse return fail(diag, "Missing confirmation snapshot");
    const fields = value.object(snapshot);
    const message_ids = if (fields) |f| value.get(f, "message_ids") else null;
    if (message_ids != null and message_ids.? == .null)
        return fail(diag, std.fmt.comptimePrint(
            "Confirmation snapshot exceeds {d} affected events; query canonical history or narrow msg_id",
            .{MAX_AFFECTED_EVENTS},
        ));
    if (message_ids == null or message_ids.? != .array) return fail(diag, "Invalid confirmation snapshot");
    // Branches retain every column used by outer filters, ordering, or DISTINCT.
    var branch_args = select_args;
    branch_args.columns = null;
    branch_args.offset = null;
    const missing: Value = .null;
    const canonical = try sql.buildSelect(arena, .message_view, branch_args, .{
        .relation = "canonical_message_view",
        .values = &.{ message_ids.?, value.get(fields.?, "domains") orelse missing, value.get(fields.?, "heights") orelse missing },
    }, diag);
    const projected = try sql.buildSelect(arena, .message_view, branch_args, .{
        .relation = "affected_projection",
        .values = canonical.values,
    }, diag);
    const query = try sql.buildSelect(arena, .message_view, select_args, .{
        .relation = "provisional_message_view",
        .values = projected.values,
    }, diag);
    const text = try std.mem.concat(arena, u8, &.{
        projection_head, canonical.sql, ") UNION ALL (", projected.sql,
        ")\n      ) ",   query.sql,
    });
    return .{ .sql = text, .values = query.values };
}

const projection_head = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk std.fmt.comptimePrint(
        \\WITH custom_frontier(domain, height) AS (
        \\        SELECT * FROM unnest($2::integer[], $3::bigint[])
        \\      ), projected_message AS ({s}),
        \\      affected_projection AS (
        \\        SELECT projection.*, TRUE AS is_provisional
        \\        FROM ({s}) projection
        \\      ),
        \\      canonical_message_view AS (
        \\        SELECT canonical.*, FALSE AS is_provisional FROM message_view canonical
        \\        WHERE canonical.msg_id NOT IN (SELECT msg_id FROM projected_message
        \\          WHERE msg_id IS NOT NULL)
        \\          AND NOT EXISTS (SELECT 1 FROM custom_frontier frontier
        \\            WHERE frontier.domain=canonical.origin_domain_id
        \\              AND canonical.origin_block_height>frontier.height)
        \\          AND NOT EXISTS (SELECT 1 FROM raw_message_dispatch dispatch
        \\            JOIN custom_frontier frontier ON frontier.domain=dispatch.origin_domain
        \\            WHERE dispatch.msg_id=canonical.msg_id
        \\              AND dispatch.origin_block_height>frontier.height)
        \\      ), provisional_message_view AS (
        \\        (
    , .{ provisional.PROJECTED_MESSAGE_QUERY, provisional.PROVISIONAL_MESSAGE_QUERY });
};

fn fail(diag: *Diag, message: []const u8) sql.Error {
    diag.message = message;
    return error.AssertionFailed;
}

/// Return a necessary msg_id bound, never narrowing an unbounded OR branch.
pub fn messageIds(arena: Allocator, where: ?Value) Allocator.Error!?Value {
    const obj = value.object(where) orelse return null;
    if (value.get(obj, "msg_id")) |msg_id| {
        if (value.object(msg_id)) |comparison| {
            if (value.get(comparison, "_eq")) |eq| if (eq != .null) return try value.makeArray(arena, &.{eq});
            if (value.get(comparison, "_in")) |in| if (in == .array) return in;
        }
    }
    if (value.get(obj, "_and")) |and_value| {
        for (value.listOrSingle(&and_value)) |child| {
            if (try messageIds(arena, child)) |ids| return ids;
        }
    }
    if (value.get(obj, "_or")) |or_value| {
        var flat: std.ArrayList(Value) = .empty;
        const bounded = for (value.listOrSingle(&or_value)) |child| {
            const ids = try messageIds(arena, child) orelse break false;
            try flat.appendSlice(arena, value.array(ids).?);
        } else true;
        if (bounded) return try value.makeArray(arena, flat.items);
    }
    return null;
}
