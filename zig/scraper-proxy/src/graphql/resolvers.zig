//! `resolver-map.ts`: query_root resolvers over `scraperdb.Service` and the
//! optional diagnostics service, `selectedColumns`/`nestedColumns`, and the
//! `message_view_aggregate_fields.count` resolver.
const std = @import("std");
const json = @import("core").json;
const scraperdb = @import("scraperdb");
const db = @import("db");
const ast = @import("ast.zig");
const execute = @import("execute.zig");

const Value = json.Value;
const Member = json.Member;
const Allocator = std.mem.Allocator;
const Info = execute.Info;
const ResolveResult = execute.ResolveResult;
const RawResult = execute.RawResult;

/// Diagnostics boundary (main.zig adapts `diagnostics.Service`). On failure
/// set `failure.message` (exact TS text) and `failure.code` for GraphQLErrors
/// with `extensions.code`, then return `error.ResolverFailed`.
pub const Diagnostics = struct {
    ctx: *anyopaque,
    history: *const fn (ctx: *anyopaque, a: Allocator, message_id: []const u8, before_id: ?[]const u8, limit: i64, failure: *execute.ResolveFailure) Error!Value,
    /// `(await snapshots([id]))[0]`.
    snapshot: *const fn (ctx: *anyopaque, a: Allocator, message_id: []const u8, failure: *execute.ResolveFailure) Error!Value,

    pub const Error = error{ ResolverFailed, OutOfMemory };
};

pub const ResolverMap = struct {
    db: scraperdb.Service,
    diagnostics: ?Diagnostics = null,

    pub fn resolvers(self: *ResolverMap) execute.Resolvers {
        return .{ .ctx = self, .resolve = resolve, .resolve_raw = resolveRaw, .fails_synchronously = failsSynchronously, .parent_types = &.{ "query_root", "message_view_aggregate_fields" } };
    }

    /// resolver-map.ts: `message_activity` is a plain function whose
    /// `getDiagnostics()` throws "Diagnostics are not configured" before any
    /// promise; every other root resolver is async (or returns a promise), so
    /// its failures are rejections.
    fn failsSynchronously(ctx: *anyopaque, field_name: []const u8) bool {
        const self: *ResolverMap = @ptrCast(@alignCast(ctx));
        return self.diagnostics == null and std.mem.eql(u8, field_name, "message_activity");
    }

    /// `resolve`'s table fields with the rows left as libpq's result: the
    /// same SQL, plan, errors and messages (`scraperdb.resolvers.*Lazy`).
    /// `message_view` with `confirmations`, and other fields: `.none`.
    fn resolveRaw(ctx: *anyopaque, a: Allocator, info: *const Info, _: Value, args: Value) Allocator.Error!RawResult {
        const self: *ResolverMap = @ptrCast(@alignCast(ctx));
        if (!std.mem.eql(u8, info.parent_type.name, "query_root")) return .none;
        const field = std.meta.stringToEnum(RootField, info.field_name) orelse return .none;
        var message: []const u8 = "";
        switch (field) {
            .domain, .raw_message_dispatch, .message_view => {
                const table: scraperdb.Table = switch (field) {
                    .domain => .domain,
                    .raw_message_dispatch => .raw_message_dispatch,
                    else => .message_view,
                };
                // `selectMessages` without confirmations is `select` (service.zig).
                if (field == .message_view and scraperdb.value.present(args.get("confirmations")) != null) return .none;
                const columns = try selectedColumns(a, info, info.field_nodes);
                const lazy = scraperdb.resolvers.selectLazy(self.db, a, table, &args, columns, &message) catch |err| return rawFailed(err, message);
                return .{ .rows = try rawRows(a, lazy orelse return .none) };
            },
            .domain_by_pk, .raw_message_dispatch_by_pk => {
                const table: scraperdb.Table = if (field == .domain_by_pk) .domain else .raw_message_dispatch;
                const id = args.get("id") orelse Value.null;
                const columns = try selectedColumns(a, info, info.field_nodes);
                const lazy = scraperdb.resolvers.byPkLazy(self.db, a, table, &id, columns, &message) catch |err| return rawFailed(err, message);
                return .{ .row = try rawRows(a, lazy orelse return .none) };
            },
            else => return .none,
        }
    }

    fn resolve(ctx: *anyopaque, a: Allocator, info: *const Info, parent: Value, args: Value) Allocator.Error!ResolveResult {
        const self: *ResolverMap = @ptrCast(@alignCast(ctx));
        const parent_name = info.parent_type.name;
        if (std.mem.eql(u8, parent_name, "message_view_aggregate_fields")) {
            if (!std.mem.eql(u8, info.field_name, "count")) return .default;
            // Parent is `{ args, table }` from the aggregate resolver.
            const select_args = parent.get("args") orelse Value.null;
            var message: []const u8 = "";
            const n = scraperdb.resolvers.count(self.db, a, .message_view, &select_args, &args, &message) catch |err| return failed(err, message);
            return .{ .value = .{ .number = n } };
        }
        if (!std.mem.eql(u8, parent_name, "query_root")) return .default;
        const field = std.meta.stringToEnum(RootField, info.field_name) orelse return .default;
        var message: []const u8 = "";
        switch (field) {
            .domain, .raw_message_dispatch => {
                const table: scraperdb.Table = if (field == .domain) .domain else .raw_message_dispatch;
                const rows = scraperdb.resolvers.select(self.db, a, table, &args, try selectedColumns(a, info, info.field_nodes), &message) catch |err| return failed(err, message);
                return .{ .value = .{ .array = rows } };
            },
            .message_view => {
                const rows = scraperdb.resolvers.selectMessages(self.db, a, &args, try selectedColumns(a, info, info.field_nodes), &message) catch |err| return failed(err, message);
                return .{ .value = .{ .array = rows } };
            },
            .domain_by_pk, .raw_message_dispatch_by_pk => {
                const table: scraperdb.Table = if (field == .domain_by_pk) .domain else .raw_message_dispatch;
                const id = args.get("id") orelse Value.null;
                const row = scraperdb.resolvers.byPk(self.db, a, table, &id, try selectedColumns(a, info, info.field_nodes), &message) catch |err| return failed(err, message);
                return .{ .value = row orelse .null };
            },
            .message_view_aggregate => {
                // `db.aggregate`: nodes are queried only when selected.
                var rows: []Value = &.{};
                if (try nestedColumns(a, info, "nodes")) |columns| {
                    rows = scraperdb.resolvers.select(self.db, a, .message_view, &args, columns, &message) catch |err| return failed(err, message);
                }
                const aggregate = try a.dupe(Member, &.{ .{ .key = "args", .value = args }, .{ .key = "table", .value = .{ .string = "message_view" } } });
                const result = try a.dupe(Member, &.{ .{ .key = "aggregate", .value = .{ .object = aggregate } }, .{ .key = "nodes", .value = .{ .array = rows } } });
                return .{ .value = .{ .object = result } };
            },
            .message_activity, .message_diagnostics => {
                const diagnostics = self.diagnostics orelse return .{ .failure = .{ .message = "Diagnostics are not configured", .code = "DIAGNOSTICS_UNAVAILABLE" } };
                const message_id = stringArg(args, "message_id") orelse "";
                var failure: execute.ResolveFailure = .{ .message = "" };
                const result = if (field == .message_activity)
                    diagnostics.history(diagnostics.ctx, a, message_id, stringArg(args, "before_id"), intArg(args, "limit") orelse 100, &failure)
                else
                    diagnostics.snapshot(diagnostics.ctx, a, message_id, &failure);
                const v = result catch |err| switch (err) {
                    error.OutOfMemory => return error.OutOfMemory,
                    error.ResolverFailed => return .{ .failure = failure },
                };
                return .{ .value = v };
            },
        }
    }
};

const RootField = enum {
    domain,
    domain_by_pk,
    message_view,
    message_view_aggregate,
    raw_message_dispatch,
    raw_message_dispatch_by_pk,
    message_activity,
    message_diagnostics,
};

fn failed(err: anyerror, message: []const u8) Allocator.Error!ResolveResult {
    if (err == error.OutOfMemory) return error.OutOfMemory;
    return .{ .failure = .{ .message = message } };
}

fn rawFailed(err: anyerror, message: []const u8) Allocator.Error!RawResult {
    if (err == error.OutOfMemory) return error.OutOfMemory;
    return .{ .failure = .{ .message = message } };
}

/// `lazy` as the executor's `RawRows` (which then owns it: on error here it
/// is released).
pub fn rawRows(a: Allocator, lazy: *db.LazyRows) Allocator.Error!execute.RawRows {
    errdefer lazy.deinit();
    const columns = try a.alloc(execute.RawColumn, lazy.columns.len);
    for (columns, lazy.columns) |*out, c| out.* = .{
        .name = c.name,
        .nested = switch (c.oid) {
            114, 3802, 199, 3807 => true, // json, jsonb, json[], jsonb[]
            else => false,
        },
        .kind = switch (c.kind) {
            .number => blk: {
                // `FastKind.number_text` promises a 32-bit integer (Int fields
                // skip the range check): only int2/int4 qualify.
                std.debug.assert(c.oid == 21 or c.oid == 23);
                break :blk .number_text;
            },
            .string => .string_text,
            .boolean => .bool_tf,
            .none => null,
        },
    };
    return .{
        .ctx = lazy,
        .n_rows = lazy.rows,
        .columns = columns,
        .cell_fn = LazyAdapter.cell,
        .materialize_fn = LazyAdapter.materialize,
        .write_text_fn = LazyAdapter.writeText,
        .deinit_fn = LazyAdapter.deinit,
    };
}

const LazyAdapter = struct {
    fn of(ctx: *anyopaque) *db.LazyRows {
        return @ptrCast(@alignCast(ctx));
    }
    fn cell(ctx: *anyopaque, row: usize, col: usize) ?[]const u8 {
        return of(ctx).cell(row, col);
    }
    fn materialize(ctx: *anyopaque, a: Allocator) Allocator.Error![]Value {
        return of(ctx).materialize(a);
    }
    fn writeText(ctx: *anyopaque, w: *std.Io.Writer, a: Allocator, col: usize, text: []const u8) (std.Io.Writer.Error || Allocator.Error)!void {
        return db.LazyRows.writeText(w, a, of(ctx).columns[col].oid, text);
    }
    fn deinit(ctx: *anyopaque) void {
        of(ctx).deinit();
    }
};

fn stringArg(args: Value, name: []const u8) ?[]const u8 {
    const v = args.get(name) orelse return null;
    return if (v == .string) v.string else null;
}

fn intArg(args: Value, name: []const u8) ?i64 {
    const v = args.get(name) orelse return null;
    return if (v == .number) @intFromFloat(v.number) else null;
}

/// `selectedColumns(info, nodes)`: field names under `nodes` (fragments
/// flattened, directives ignored), minus `__typename`, duplicates kept.
pub fn selectedColumns(a: Allocator, info: *const Info, nodes: []const *const ast.Field) Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    for (nodes) |node| {
        const set = node.selection_set orelse continue;
        try collectNames(a, info, set.selections, &out);
    }
    return out.items;
}

fn collectNames(a: Allocator, info: *const Info, selections: []const ast.Selection, out: *std.ArrayList([]const u8)) Allocator.Error!void {
    for (selections) |sel| switch (sel) {
        .field => |f| if (!std.mem.eql(u8, f.name.value, "__typename")) try out.append(a, f.name.value),
        .inline_fragment => |f| try collectNames(a, info, f.selection_set.selections, out),
        .fragment_spread => |fs| if (info.fragments.get(fs.name.value)) |frag| try collectNames(a, info, frag.selection_set.selections, out),
    };
}

/// `nestedColumns(info, name)`: columns of the `name` sub-fields, or null when absent.
pub fn nestedColumns(a: Allocator, info: *const Info, name: []const u8) Allocator.Error!?[]const []const u8 {
    var nested: std.ArrayList(*const ast.Field) = .empty;
    for (info.field_nodes) |node| {
        const set = node.selection_set orelse continue;
        try collectFieldsNamed(a, info, set.selections, name, &nested);
    }
    if (nested.items.len == 0) return null;
    return try selectedColumns(a, info, nested.items);
}

fn collectFieldsNamed(a: Allocator, info: *const Info, selections: []const ast.Selection, name: []const u8, out: *std.ArrayList(*const ast.Field)) Allocator.Error!void {
    for (selections) |sel| switch (sel) {
        .field => |f| if (std.mem.eql(u8, f.name.value, name)) try out.append(a, f),
        .inline_fragment => |f| try collectFieldsNamed(a, info, f.selection_set.selections, name, out),
        .fragment_spread => |fs| if (info.fragments.get(fs.name.value)) |frag| try collectFieldsNamed(a, info, frag.selection_set.selections, name, out),
    };
}
