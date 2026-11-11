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
            .db = scraperdb.Service.init(.{ .ctx = dbs, .queryFn = query }),
            .diagnostics = if (diag != null) .{ .ctx = self, .history = history, .snapshot = snapshot } else null,
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

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, values: []const Value, diag: *scraperdb.Diag) anyerror![]Value {
        const dbs: *db.DbService = @ptrCast(@alignCast(ctx));
        execute.io_events +%= 1;
        var failure: db.Failure = .{};
        return dbs.query(arena, text, values, &failure) catch |err| {
            diag.message = if (failure.message.len > 0) failure.message else @errorName(err);
            return err;
        };
    }

    fn history(ctx: *anyopaque, a: Allocator, message_id: []const u8, before_id: ?[]const u8, limit: i64, failure: *execute.ResolveFailure) resolvers.Diagnostics.Error!Value {
        const self: *App = @ptrCast(@alignCast(ctx));
        const v = self.diagnostics.?.history(a, message_id, before_id, limit) catch |err| return fail(err, failure);
        execute.io_events +%= 1;
        return diagnostics.js.toCore(a, v);
    }

    fn snapshot(ctx: *anyopaque, a: Allocator, message_id: []const u8, failure: *execute.ResolveFailure) resolvers.Diagnostics.Error!Value {
        const self: *App = @ptrCast(@alignCast(ctx));
        const list = self.diagnostics.?.snapshots(a, &.{message_id}) catch |err| return fail(err, failure);
        execute.io_events +%= 1;
        if (list.len == 0) return .null;
        return diagnostics.js.toCore(a, list[0]);
    }

    fn fail(err: diagnostics.service.Error, failure: *execute.ResolveFailure) resolvers.Diagnostics.Error {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        // Unavailable comes from the database read; argument errors precede I/O.
        if (err == error.Unavailable) execute.io_events +%= 1;
        failure.* = .{ .message = diagnostics.service.errorMessage(err), .code = diagnostics.service.errorCode(err) };
        return error.ResolverFailed;
    }
};
