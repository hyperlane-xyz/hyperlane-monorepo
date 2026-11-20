//! Port of `scraperdb/scraperdb.service.ts` and `database.ts`.
const std = @import("std");
const Allocator = std.mem.Allocator;

const core = @import("core");
const db_mod = @import("db");
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

/// TS #10076: PostgreSQL's estimate for one history statement, and for all
/// of one GraphQL operation's history statements (`ScraperDbService`).
pub const MAX_STATEMENT_PLAN_COST: f64 = 100_000;
pub const OPERATION_PLAN_COST: f64 = 250_000;

/// The planning budget one GraphQL operation's history statements share,
/// concurrent aliases included (TS builds a `ScraperDbService`, and so a
/// `remainingPlanCost`, per request). Created by the route per operation.
pub const HistoryBudget = struct {
    mutex: std.Thread.Mutex = .{},
    remaining: f64 = OPERATION_PLAN_COST,

    /// TS: `assert(cost <= remainingPlanCost)` then subtract, one step once
    /// the statement's EXPLAIN returned. False when it does not fit.
    pub fn consume(self: *HistoryBudget, cost: f64) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!(cost <= self.remaining)) return false;
        self.remaining -= cost;
        return true;
    }
};

/// `EXPLAIN (FORMAT JSON) <sql>`'s top-level `Plan."Total Cost"`, as node-pg
/// returns the json column (`[{"Plan": {...}}]`); null when absent or not a
/// JS number (TS `typeof cost === 'number'`).
fn planTotalCost(rows: []const Value) ?f64 {
    if (rows.len == 0) return null;
    const row = value.object(rows[0]) orelse return null;
    const document = value.get(row, "QUERY PLAN") orelse return null;
    const items = value.array(document) orelse return null;
    if (items.len == 0) return null;
    const first = value.object(items[0]) orelse return null;
    const plan = value.object(value.get(first, "Plan") orelse return null) orelse return null;
    const cost = value.get(plan, "Total Cost") orelse return null;
    if (!value.isJsNumber(cost)) return null;
    return value.number(cost);
}

/// `ScraperDbDatabase`: rows are `.object` Values allocated in `arena`, with
/// node-pg value conversion. Parameters are raw JSON Values (node-pg
/// `prepareValue` semantics are the implementation's job). On failure the
/// implementation sets `diag.message` to the node-pg `error.message` (it
/// becomes the GraphQL error message, as in TS) and returns an error. An
/// implementation that caps pending statements runs each in `diag.chain`
/// when set (`db.PendingChain`).
pub const Database = struct {
    ctx: *anyopaque,
    /// Runs a statement planned as node-pg would (`Plan.custom`); test
    /// backends need only this.
    queryFn: QueryFn,
    /// Optional: the same contract, planned as `plan` (see `Plan`); null
    /// runs every plan through `queryFn`.
    plannedQueryFn: ?PlannedQueryFn = null,
    /// Optional: the same query (planned as `plan`), with libpq's result
    /// returned unconverted (`db.LazyRows`, owned by the caller; null when
    /// the implementation cannot, e.g. a test backend).
    lazyQueryFn: ?LazyQueryFn = null,
    /// Optional: before a request's root fields start (`db.DbService.admitShape`).
    shapeFn: ?*const fn (ctx: *anyopaque, roots: usize) void = null,

    pub const QueryFn = *const fn (ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value;
    pub const PlannedQueryFn = *const fn (ctx: *anyopaque, arena: Allocator, plan: Plan, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value;
    pub const LazyQueryFn = *const fn (ctx: *anyopaque, arena: Allocator, plan: Plan, text: []const u8, values: []const Value, diag: *Diag) anyerror!?*db_mod.LazyRows;

    pub fn query(self: Database, arena: Allocator, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value {
        return self.queryFn(self.ctx, arena, text, values, diag);
    }

    pub fn queryPlanned(self: Database, arena: Allocator, plan: Plan, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value {
        const f = self.plannedQueryFn orelse return self.queryFn(self.ctx, arena, text, values, diag);
        return f(self.ctx, arena, plan, text, values, diag);
    }
};

/// How PostgreSQL may plan a statement. `custom` (node-pg's unnamed
/// statements) plans every execution with the actual parameter values.
/// `reusable` lets the connection keep a named statement whose generic plan
/// PostgreSQL may reuse; only for shapes where that plan cannot be worse:
/// unique-key lookups and the fixed confirmation snapshot SQL (bench DB:
/// generic never slower across 41 message ids and confirmations 0..1000).
///
/// `fixed_join` plans like `custom` but with the view's join order fixed
/// (`join_collapse_limit = 1`), for selects whose rows no plan can change
/// and whose fixed-order plan is never slower (`sql.Sql.fixed_join`).
///
/// `serial` plans like `custom` but without parallel workers, for the
/// confirmation projection: its parallel plan spends most of its time
/// starting workers (bench DB: 25 -> 10 ms per call at 214 affected
/// messages, never slower from 0 to 10,000), and its result order differs
/// only among rows tying on the ORDER BY, which the parallel plan (TS's
/// too) already leaves unspecified.
///
/// `serial_generic` is `serial` with a reused generic plan, for that same
/// projection when at most `GENERIC_PROJECTION_MAX_IDS` messages are
/// affected: planning is most of its cost there (bench DB: 7.9 -> 1.9 ms
/// per call at 214 messages; -24% to -98% from 0 to 500, also with one
/// origin or one sender holding all of them), while larger sets need
/// plans for their values (generic +27% to +488% from 2,000 up).
///
/// `generic` always uses the generic plan of a named statement, for
/// `message_view` selects ordered by `id` that pin a transaction hash
/// (`pinsTxHash`): their plan never depends on the value.
pub const Plan = enum { custom, reusable, fixed_join, serial, serial_generic, generic };

/// The largest affected-message set whose projection reuses a generic plan
/// (`Plan.serial_generic`); larger sets are planned per call (`serial`).
pub const GENERIC_PROJECTION_MAX_IDS = 500;

/// True when `where` pins a unique key (`id` or `msg_id`, unique or
/// near-unique in every public table) with `_eq` in a top-level conjunct.
/// Call after the builder validated `where` (bounded depth).
pub fn isPointLookup(where: ?Value) bool {
    return pinsKey(where, true);
}

/// `isPointLookup` restricted to `msg_id`: the only key that also bounds a
/// confirmation snapshot (`messageIds`); with `id` the projection still
/// covers every affected message, and canonical/provisional ids can collide.
pub fn isMessageIdLookup(where: ?Value) bool {
    return pinsKey(where, false);
}

fn pinsKey(where: ?Value, allow_id: bool) bool {
    const keys: []const []const u8 = if (allow_id) &.{ "msg_id", "id" } else &.{"msg_id"};
    return pinsAny(where, keys);
}

/// True when `where` pins `origin_tx_hash` or `destination_tx_hash` with
/// `_eq` in a top-level conjunct: `transaction.hash` is globally unique
/// (scraper migration `create_table_transaction`), so the select reads the
/// messages of one transaction whatever the value, and a generic plan keeps
/// its shape (bench DB: identical plan, 1.4-1.9 ms planning saved, hit and
/// miss). The `*_tx_sender` columns are excluded: a busy relayer's generic
/// plan is 56-345x slower.
pub fn pinsTxHash(where: ?Value) bool {
    return pinsAny(where, &.{ "origin_tx_hash", "destination_tx_hash" });
}

fn pinsAny(where: ?Value, keys: []const []const u8) bool {
    const obj = value.object(value.present(where)) orelse return false;
    for (0..value.len(obj)) |index| {
        const key = value.keyAt(obj, index);
        const item = value.valueAt(obj, index);
        if (std.mem.eql(u8, key, "_and")) {
            for (value.listOrSingle(item)) |child| if (pinsAny(child, keys)) return true;
            continue;
        }
        for (keys) |k| if (std.mem.eql(u8, key, k)) {
            if (value.object(item.*)) |comparisons| {
                if (value.present(value.get(comparisons, "_eq")) != null) return true;
            }
        };
    }
    return false;
}

fn planFor(where: ?Value) Plan {
    return if (isPointLookup(where)) .reusable else .custom;
}

/// `planFor`; for a non-lookup select, `generic` when it pins a
/// transaction hash, or reads all of `domain`, and is totally ordered by
/// `id` (no plan can reorder its rows), else `fixed_join` when it qualifies.
fn planForSelect(table: Table, where: ?Value, query: sql.Sql) Plan {
    const plan = planFor(where);
    if (plan != .custom) return plan;
    if (table == .message_view and query.ordered_by_id and pinsTxHash(where)) return .generic;
    // An unfiltered `domain` select (a small table): a generic plan, reused,
    // skips planning each call. Only when the rows are totally ordered by
    // `id`, so no plan can reorder them, and with no `where`: a custom plan
    // (node-pg's) evaluates a filter's constants while planning, a generic
    // one only against rows, so with a filter the two could fail
    // differently.
    if (table == .domain and query.ordered_by_id and where == null) return .generic;
    return if (query.fixed_join) .fixed_join else plan;
}

/// The snapshot row's affected message ids (`buildProjection` already
/// checked it is an array).
fn affectedCount(snapshot_row: Value) usize {
    const ids = value.get(value.object(snapshot_row).?, "message_ids").?;
    if (db_mod.convert.literal(ids)) |l| return db_mod.convert.literalArrayLen(l).?;
    return value.array(ids).?.len;
}

/// `message_view` arguments: the select args plus `confirmations`.
pub const MessageSelectArgs = struct {
    select: SelectArgs = .{},
    confirmations: ?Value = null,
};

pub const Service = struct {
    db: Database,

    /// TS #10076 `historyQuery`'s check, before a history statement runs:
    /// PostgreSQL's estimate for exactly this statement (`EXPLAIN (FORMAT
    /// JSON)`, run as node-pg runs any query: unnamed, planned for the
    /// bound values, through the same admission, pending cap, metrics and
    /// logs), at most MAX_STATEMENT_PLAN_COST, then taken from the
    /// operation's `budget`. The statement itself may then run with any
    /// plan: its rows do not depend on it.
    fn checkHistoryCost(self: Service, arena: Allocator, budget: *HistoryBudget, text: []const u8, values: []const Value, diag: *Diag) anyerror!void {
        const explain = try std.mem.concat(arena, u8, &.{ "EXPLAIN (FORMAT JSON) ", text });
        const rows = try self.db.query(arena, explain, values, diag);
        const cost = planTotalCost(rows) orelse return fail(diag, "History query exceeds the database planning budget");
        if (!std.math.isFinite(cost) or cost < 0 or cost > MAX_STATEMENT_PLAN_COST)
            return fail(diag, "History query exceeds the database planning budget");
        if (!budget.consume(cost)) return fail(diag, "GraphQL operation exceeds its database planning budget");
    }

    pub fn init(db: Database) Service {
        return .{ .db = db };
    }

    /// TS `historyQuery`: the cost check, then the statement (planned as
    /// `plan`; the EXPLAIN is always node-pg's unnamed custom plan), in one
    /// pending chain.
    fn historyQuery(self: Service, arena: Allocator, budget: *HistoryBudget, plan: Plan, text: []const u8, values: []const Value, diag: *Diag) anyerror![]Value {
        var chain: db_mod.PendingChain = .{};
        const own = beginChain(diag, &chain);
        defer if (own) endChain(diag, &chain);
        try self.checkHistoryCost(arena, budget, text, values, diag);
        return self.db.queryPlanned(arena, plan, text, values, diag);
    }

    /// Runs `diag`'s next statements in `chain` unless they already run in
    /// one (the caller's); true when `chain` is now theirs: the caller must
    /// then `endChain` on every path. TS issues a history statement's
    /// EXPLAIN, the statement, and with confirmations the projection's two
    /// after the snapshot's, each from the previous one's continuation (no
    /// other request's code in between), so they share one pending slot.
    fn beginChain(diag: *Diag, chain: *db_mod.PendingChain) bool {
        if (diag.chain != null) return false;
        diag.chain = chain;
        return true;
    }

    fn endChain(diag: *Diag, chain: *db_mod.PendingChain) void {
        diag.chain = null;
        chain.release();
    }

    /// Every table but `domain` is history (TS `select`): its statement is
    /// checked against `budget` first.
    pub fn select(self: Service, arena: Allocator, budget: *HistoryBudget, table: Table, args: SelectArgs, diag: *Diag) anyerror![]Value {
        const query = try sql.buildSelect(arena, table, args, null, diag);
        const plan = planForSelect(table, args.where, query);
        if (table == .domain) return self.db.queryPlanned(arena, plan, query.sql, query.values, diag);
        return self.historyQuery(arena, budget, plan, query.sql, query.values, diag);
    }

    /// `select`'s query with its rows left unconverted (`db.LazyRows`, which
    /// the caller must `deinit`); null when the database cannot (then use
    /// `select`). Same SQL, plan, errors and diagnostics as `select`.
    pub fn selectLazy(self: Service, arena: Allocator, budget: *HistoryBudget, table: Table, args: SelectArgs, diag: *Diag) anyerror!?*db_mod.LazyRows {
        // Null before any statement makes the caller run `select` instead,
        // with one cost check. A lazy path that returns null after the
        // check (only `DbService` with a test backend) makes it check twice.
        const f = self.db.lazyQueryFn orelse return null;
        const query = try sql.buildSelect(arena, table, args, null, diag);
        var chain: db_mod.PendingChain = .{};
        const own = table != .domain and beginChain(diag, &chain);
        defer if (own) endChain(diag, &chain);
        if (table != .domain) try self.checkHistoryCost(arena, budget, query.sql, query.values, diag);
        return f(self.db.ctx, arena, planForSelect(table, args.where, query), query.sql, query.values, diag);
    }

    /// `byPk`'s query with its rows left unconverted (at most one; null when
    /// the database cannot, then use `byPk`). The caller must `deinit` it.
    pub fn byPkLazy(self: Service, arena: Allocator, table: Table, id: Value, columns: ?[]const []const u8, diag: *Diag) anyerror!?*db_mod.LazyRows {
        const f = self.db.lazyQueryFn orelse return null;
        const query = try sql.buildByPk(arena, table, id, columns, diag);
        return f(self.db.ctx, arena, .reusable, query.sql, query.values, diag);
    }

    pub fn selectMessages(self: Service, arena: Allocator, budget: *HistoryBudget, args: MessageSelectArgs, diag: *Diag) anyerror![]Value {
        const select_args = args.select;
        const confirmations = value.present(args.confirmations) orelse
            return self.select(arena, budget, .message_view, select_args, diag);
        const queries = try buildMessageQueries(arena, select_args, confirmations, diag);
        var chain: db_mod.PendingChain = .{};
        const own = beginChain(diag, &chain);
        defer if (own) endChain(diag, &chain);
        try self.checkHistoryCost(arena, budget, queries.snapshot.sql, queries.snapshot.values, diag);
        const snapshot = try self.snapshotRow(arena, queries.snapshot, diag);
        const projection = try buildProjection(arena, select_args, snapshot, diag);
        // buildProjection rejected a missing snapshot and a message_ids that
        // is not an array, so `affectedCount(snapshot.?)` holds below.
        const plan: Plan = if (isMessageIdLookup(select_args.where))
            .reusable
        else if (affectedCount(snapshot.?) <= GENERIC_PROJECTION_MAX_IDS)
            .serial_generic
        else
            .serial;
        return self.historyQuery(arena, budget, plan, projection.sql, projection.values, diag);
    }

    /// The confirmation snapshot's row (null: none). Its arrays only feed
    /// the projection's parameters, so with a lazy backend they stay
    /// PostgreSQL's text (`db.convert.literalValue`) instead of being
    /// converted (a Buffer per message id) and re-encoded.
    fn snapshotRow(self: Service, arena: Allocator, snapshot: sql.Sql, diag: *Diag) anyerror!?Value {
        const f = self.db.lazyQueryFn orelse {
            const rows = try self.db.queryPlanned(arena, .reusable, snapshot.sql, snapshot.values, diag);
            return if (rows.len > 0) rows[0] else null;
        };
        const lazy = try f(self.db.ctx, arena, .reusable, snapshot.sql, snapshot.values, diag) orelse {
            const rows = try self.db.queryPlanned(arena, .reusable, snapshot.sql, snapshot.values, diag);
            return if (rows.len > 0) rows[0] else null;
        };
        defer lazy.deinit();
        if (lazy.rows == 0) return null;
        const members = try arena.alloc(core.json.Member, lazy.columns.len);
        for (lazy.columns, members, 0..) |column, *m, i| {
            m.* = .{
                .key = column.name,
                .value = if (lazy.cell(0, i)) |text| try db_mod.convert.literalValue(arena, column.oid, text) else .null,
            };
        }
        return .{ .object = members };
    }

    pub fn byPk(self: Service, arena: Allocator, table: Table, id: Value, columns: ?[]const []const u8, diag: *Diag) anyerror!?Value {
        const query = try sql.buildByPk(arena, table, id, columns, diag);
        const rows = try self.db.queryPlanned(arena, .reusable, query.sql, query.values, diag);
        return if (rows.len > 0) rows[0] else null;
    }

    /// `aggregate(...).nodes`. Without selected `nodes` columns TS returns []
    /// without validating; validation then happens in `count`. Always a
    /// history statement (TS `historyQuery`, whatever the table).
    pub fn aggregateNodes(self: Service, arena: Allocator, budget: *HistoryBudget, table: Table, args: SelectArgs, columns: ?[]const []const u8, diag: *Diag) anyerror![]Value {
        const selected = columns orelse return &.{};
        var with_columns = args;
        with_columns.columns = selected;
        const query = try sql.buildSelect(arena, table, with_columns, null, diag);
        return self.historyQuery(arena, budget, planForSelect(table, with_columns.where, query), query.sql, query.values, diag);
    }

    pub fn count(self: Service, arena: Allocator, budget: *HistoryBudget, table: Table, args: SelectArgs, count_args: sql.CountArgs, diag: *Diag) anyerror!i64 {
        const query = try sql.buildCount(arena, table, args, count_args, diag);
        const rows = try self.historyQuery(arena, budget, .custom, query.sql, query.values, diag);
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
    // TS `Number.isSafeInteger(confirmations) && confirmations >= 0`: a
    // non-number fails the same assert.
    const count = (if (value.isSafeInteger(confirmations)) value.number(confirmations) else null) orelse
        return fail(diag, "confirmations must be a non-negative safe integer");
    if (!(count >= 0)) return fail(diag, "confirmations must be a non-negative safe integer");
    if (count > MAX_CONFIRMATIONS)
        return fail(diag, std.fmt.comptimePrint("confirmations exceeds maximum of {d}", .{MAX_CONFIRMATIONS}));
    if (value.truthy(select_args.offset)) return fail(diag, "offset is unsupported with confirmations");
    if (value.present(select_args.cursor)) |cursor| {
        if (value.listOrSingle(&cursor).len > 0)
            return fail(diag, "cursor is unsupported with confirmations; paginate canonical history separately");
    }
    // Validate filters before either database query, including recursive limits.
    _ = try sql.buildSelect(arena, .message_view, select_args, null, diag);
    const ids = try messageIds(arena, select_args.where);
    // TS `confirmations === 0`: the affected query without its legacy branch.
    const zero = count == 0;
    const text = if (zero)
        (if (ids == null) snapshot_sql_zero_unfiltered else snapshot_sql_zero_filtered)
    else if (ids == null) snapshot_sql_unfiltered else snapshot_sql_filtered;
    const values = try arena.alloc(Value, if (ids == null) 1 else 2);
    values[0] = confirmations;
    if (ids) |bound| values[1] = bound;
    return .{ .snapshot = .{ .sql = text, .values = values } };
}

fn snapshotSql(comptime filtered: bool, comptime zero_confirmations: bool) []const u8 {
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
    , .{ provisional.affectedQuery(filtered, zero_confirmations), MAX_AFFECTED_EVENTS + 1, MAX_AFFECTED_EVENTS });
}

const snapshot_sql_unfiltered = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk snapshotSql(false, false);
};
const snapshot_sql_filtered = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk snapshotSql(true, false);
};
const snapshot_sql_zero_unfiltered = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk snapshotSql(false, true);
};
const snapshot_sql_zero_filtered = blk: {
    @setEvalBranchQuota(1_000_000);
    break :blk snapshotSql(true, true);
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
    const is_array = if (message_ids) |ids| ids == .array or
        (if (db_mod.convert.literal(ids)) |l| db_mod.convert.literalArrayLen(l) != null else false) else false;
    if (!is_array) return fail(diag, "Invalid confirmation snapshot");
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
