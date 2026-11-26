//! `registerGraphqlRoute(app, db, { diagnostics })` wiring for main.zig:
//! builds the schema, adapts `db.DbService` to `scraperdb.Database` and
//! `diagnostics.Service` to the resolver boundary, starts the stats timer.
const std = @import("std");
const core = @import("core");
const db = @import("db");
const http = @import("http");
const scraperdb = @import("scraperdb");
const diagnostics = @import("diagnostics");
const schema_mod = @import("schema.zig");
const route_mod = @import("route.zig");
const resolvers = @import("resolvers.zig");
const execute = @import("execute.zig");

const Allocator = std.mem.Allocator;
const Value = core.json.Value;

pub const App = struct {
    gpa: Allocator,
    schema: *schema_mod.Schema,
    db: *db.DbService,
    diagnostics: ?*diagnostics.Service,
    route_state: route_mod.GraphqlRoute = undefined,

    pub fn init(gpa: Allocator, dbs: *db.DbService, diag: ?*diagnostics.Service) !*App {
        const self = try gpa.create(App);
        errdefer gpa.destroy(self);
        const schema = try schema_mod.buildScraperSchema(gpa);
        self.* = .{ .gpa = gpa, .schema = schema, .db = dbs, .diagnostics = diag };
        const config = core.config.get();
        self.route_state = route_mod.GraphqlRoute.init(gpa, schema, .{
            .db = scraperdb.Service.init(database(dbs)),
            .diagnostics = if (diag != null) self.diagnosticsSource() else null,
        }, .{
            .max_active_requests = @intCast(config.graphql_max_active_requests),
            .max_active_uploads = @intCast(config.graphql_max_active_uploads),
        });
        try self.route_state.startStatsTimer();
        return self;
    }

    pub fn route(self: *App) http.Route {
        return self.route_state.route();
    }

    pub fn deinit(self: *App) void {
        self.route_state.deinit();
        self.schema.deinit();
        self.gpa.destroy(self.schema);
        self.gpa.destroy(self);
    }

    /// `self.diagnostics` as the resolvers' `Diagnostics`.
    pub fn diagnosticsSource(self: *App) resolvers.Diagnostics {
        return .{ .ctx = self, .history = history, .snapshot = snapshot };
    }

    /// `dbs` as the resolvers' `scraperdb.Database`.
    pub fn database(dbs: *db.DbService) scraperdb.Database {
        return .{ .ctx = dbs, .queryFn = query, .plannedQueryFn = queryPlanned, .lazyQueryFn = queryLazy, .shapeFn = shape };
    }

    fn shape(ctx: *anyopaque, roots: usize) void {
        const dbs: *db.DbService = @ptrCast(@alignCast(ctx));
        dbs.admitShape(roots);
    }

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *scraperdb.Diag) anyerror![]Value {
        return run(ctx, arena, text, values, diag, .custom);
    }

    /// `scraperdb` statements with a planner hint (`scraperdb.Plan`).
    fn queryPlanned(ctx: *anyopaque, arena: Allocator, plan: scraperdb.Plan, text: []const u8, values: []const Value, diag: *scraperdb.Diag) anyerror![]Value {
        return run(ctx, arena, text, values, diag, plan);
    }

    fn run(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *scraperdb.Diag, plan: scraperdb.Plan) anyerror![]Value {
        const dbs: *db.DbService = @ptrCast(@alignCast(ctx));
        var own: db.PendingChain = .{};
        defer own.release();
        const chain = diag.chain orelse &own;
        var failure: db.Failure = .{};
        try admit(dbs, chain, diag, &failure);
        return dbs.queryChained(arena, text, values, pqPlan(plan), chain, &failure) catch |err| {
            diag.message = if (failure.message.len > 0) failure.message else @errorName(err);
            return err;
        };
    }

    /// Before a main-pool statement: TS's pending-query cap, then the
    /// request's execution slot. TS refuses a statement over the cap
    /// synchronously, so the request does not yield there: only a statement
    /// that will run takes the slot (the request's first I/O, route.zig),
    /// and a refused one is an I/O-free failure (graphql-js settle order).
    fn admit(dbs: *db.DbService, chain: *db.PendingChain, diag: *scraperdb.Diag, failure: *db.Failure) anyerror!void {
        // A request already answered by the preHandler 503 never counts as
        // pending in TS: no reservation. One that loses its slot below gives
        // the reservation back as soon as this read fails (`chain`'s owner).
        if (execute.admissionRejected()) {
            diag.message = route_mod.capacity_message;
            return error.CapacityExceeded;
        }
        dbs.reserveMain(chain, failure) catch |err| {
            diag.message = failure.message;
            return err;
        };
        if (!execute.beforeIo()) {
            diag.message = route_mod.capacity_message;
            return error.CapacityExceeded;
        }
        execute.afterIo();
    }

    /// custom = `query`'s unnamed statement (node-pg's).
    fn pqPlan(plan: scraperdb.Plan) db.Plan {
        return switch (plan) {
            .custom => .unnamed,
            .reusable => .reusable,
            .fixed_join => .fixed_join,
            .serial => .serial,
            .serial_generic => .serial_generic,
            .generic => .generic,
        };
    }

    /// `run`'s query with the rows left unconverted (`db.LazyRows`, owned by
    /// the caller): the same admission, plan, pending chain, errors and
    /// diagnostics.
    fn queryLazy(ctx: *anyopaque, arena: Allocator, plan: scraperdb.Plan, text: []const u8, values: []const Value, diag: *scraperdb.Diag) anyerror!?*db.LazyRows {
        const dbs: *db.DbService = @ptrCast(@alignCast(ctx));
        var own: db.PendingChain = .{};
        defer own.release();
        const chain = diag.chain orelse &own;
        var failure: db.Failure = .{};
        try admit(dbs, chain, diag, &failure);
        return dbs.queryLazy(arena, text, values, pqPlan(plan), chain, &failure) catch |err| {
            diag.message = if (failure.message.len > 0) failure.message else @errorName(err);
            return err;
        };
    }

    fn history(ctx: *anyopaque, a: Allocator, message_id: []const u8, before_id: ?[]const u8, limit: i64, failure: *execute.ResolveFailure) resolvers.Diagnostics.Error!Value {
        const self: *App = @ptrCast(@alignCast(ctx));
        // Admission is taken before the call (argument errors inside it
        // precede I/O but are not separable from here; see route.zig).
        if (!execute.beforeIo()) return capacityFailure(failure);
        const v = self.diagnostics.?.history(a, message_id, before_id, limit) catch |err| return fail(err, failure);
        execute.afterIo();
        return diagnostics.js.toCore(a, v);
    }

    fn snapshot(ctx: *anyopaque, a: Allocator, message_id: []const u8, failure: *execute.ResolveFailure) resolvers.Diagnostics.Error!Value {
        const self: *App = @ptrCast(@alignCast(ctx));
        if (!execute.beforeIo()) return capacityFailure(failure);
        const list = self.diagnostics.?.snapshots(a, &.{message_id}) catch |err| return fail(err, failure);
        execute.afterIo();
        if (list.len == 0) return .null;
        return diagnostics.js.toCore(a, list[0]);
    }

    fn capacityFailure(failure: *execute.ResolveFailure) resolvers.Diagnostics.Error {
        failure.* = .{ .message = route_mod.capacity_message };
        return error.ResolverFailed;
    }

    fn fail(err: diagnostics.service.Error, failure: *execute.ResolveFailure) resolvers.Diagnostics.Error {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        // Unavailable comes from the database read; argument errors precede I/O.
        if (err == error.Unavailable) execute.afterIo();
        failure.* = .{ .message = diagnostics.service.errorMessage(err), .code = diagnostics.service.errorCode(err) };
        return error.ResolverFailed;
    }
};
