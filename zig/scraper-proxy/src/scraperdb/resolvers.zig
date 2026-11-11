//! Resolver-facing entry points (port of the `resolver-map.ts` calls into
//! `ScraperDbService`). Arguments are the graphql-js coerced field-args object
//! (only provided args; input-object keys in schema field order). main.zig
//! adapts these to `graphql.DataSource`; graphql does not import scraperdb.
const std = @import("std");
const Allocator = std.mem.Allocator;

const service = @import("service.zig");
const sql = @import("sql.zig");
const Table = @import("tables.zig").Table;
const value = @import("value.zig");
const Value = value.Value;

const Service = service.Service;

pub const Error = error{ ResolverFailed, OutOfMemory };

/// `SelectArgs` from a coerced args object plus `selectedColumns(info)`.
pub fn selectArgs(args: *const Value, columns: ?[]const []const u8) sql.SelectArgs {
    const obj = value.object(args.*) orelse return .{ .columns = columns };
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

/// `domain`, `raw_message_dispatch`, and `message_view_aggregate.nodes`.
pub fn select(svc: Service, arena: Allocator, table: Table, args: *const Value, columns: []const []const u8, message: *[]const u8) Error![]Value {
    var diag: sql.Diag = .{};
    return svc.select(arena, table, selectArgs(args, columns), &diag) catch |err| return failed(err, diag, message);
}

/// `message_view` (may carry `confirmations`).
pub fn selectMessages(svc: Service, arena: Allocator, args: *const Value, columns: []const []const u8, message: *[]const u8) Error![]Value {
    var diag: sql.Diag = .{};
    const confirmations = if (value.object(args.*)) |obj| value.get(obj, "confirmations") else null;
    return svc.selectMessages(arena, .{ .select = selectArgs(args, columns), .confirmations = confirmations }, &diag) catch |err|
        return failed(err, diag, message);
}

/// `*_by_pk`: the row object, or null.
pub fn byPk(svc: Service, arena: Allocator, table: Table, id: *const Value, columns: []const []const u8, message: *[]const u8) Error!?Value {
    var diag: sql.Diag = .{};
    return svc.byPk(arena, table, id.*, columns, &diag) catch |err| return failed(err, diag, message);
}

/// `message_view_aggregate_fields.count(columns, distinct)` with the parent's select args.
pub fn count(svc: Service, arena: Allocator, table: Table, select_args: *const Value, count_args: *const Value, message: *[]const u8) Error!f64 {
    var diag: sql.Diag = .{};
    const obj = value.object(count_args.*);
    const n = svc.count(arena, table, selectArgs(select_args, null), .{
        .columns = if (obj) |o| value.get(o, "columns") else null,
        .distinct = if (obj) |o| value.get(o, "distinct") else null,
    }, &diag) catch |err| return failed(err, diag, message);
    return @floatFromInt(n);
}

fn failed(err: anyerror, diag: sql.Diag, message: *[]const u8) Error {
    if (err == error.OutOfMemory) return error.OutOfMemory;
    // Asserts and node-pg errors both surface their message, as thrown in TS.
    message.* = if (diag.message.len > 0) diag.message else @errorName(err);
    return error.ResolverFailed;
}

test "resolver adapters surface assert messages" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const Db = struct {
        fn query(_: *anyopaque, _: Allocator, _: []const u8, _: []const Value, diag: *sql.Diag) anyerror![]Value {
            diag.message = "relation \"domain\" does not exist";
            return error.QueryFailed;
        }
    };
    var ctx: u8 = 0;
    const svc = Service.init(.{ .ctx = &ctx, .queryFn = Db.query });
    var message: []const u8 = "";
    const bad = try value.parseLeaky(a, "{\"limit\":501}");
    try std.testing.expectError(error.ResolverFailed, select(svc, a, .domain, &bad, &.{"id"}, &message));
    try std.testing.expectEqualStrings("limit exceeds maximum of 500", message);
    const ok = try value.parseLeaky(a, "{}");
    try std.testing.expectError(error.ResolverFailed, select(svc, a, .domain, &ok, &.{"id"}, &message));
    try std.testing.expectEqualStrings("relation \"domain\" does not exist", message);
    const conf = try value.parseLeaky(a, "{\"confirmations\":-1}");
    try std.testing.expectError(error.ResolverFailed, selectMessages(svc, a, &conf, &.{"id"}, &message));
    try std.testing.expectEqualStrings("confirmations must be a non-negative safe integer", message);
}

test "count requires a numeric database result" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const Db = struct {
        var row_json: []const u8 = "";
        fn query(_: *anyopaque, arena: Allocator, _: []const u8, _: []const Value, _: *sql.Diag) anyerror![]Value {
            return try arena.dupe(Value, &.{try value.parseLeaky(arena, row_json)});
        }
    };
    var ctx: u8 = 0;
    const svc = Service.init(.{ .ctx = &ctx, .queryFn = Db.query });
    var message: []const u8 = "";
    const empty = try value.parseLeaky(a, "{}");
    Db.row_json = "{\"count\":7}";
    try std.testing.expectEqual(@as(f64, 7), try count(svc, a, .message_view, &empty, &empty, &message));
    Db.row_json = "{\"count\":\"7\"}";
    try std.testing.expectError(error.ResolverFailed, count(svc, a, .message_view, &empty, &empty, &message));
    try std.testing.expectEqualStrings("Invalid database count result", message);
}
