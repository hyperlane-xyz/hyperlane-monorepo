//! `src/main.ts`: bootstrap, listen, graceful shutdown.
//!
//! Startup (Fastify `listen` runs onReady hooks before binding):
//!   DbService -> diagnostics (optional) -> app routes (graphql + /metrics)
//!   -> EventWebSocketServer -> metrics providers -> db.start() ->
//!   events.start() -> bind 0.0.0.0:PORT.
//! Any startup failure runs the close sequence and exits 1 (Node's uncaught
//! top-level rejection).
//! Shutdown on the first SIGINT/SIGTERM (`process.once` per signal: a repeat
//! of the same signal gets the default action, i.e. immediate termination):
//!   preClose (events.stop) -> HTTP close (stop accepting, close idle
//!   keep-alive sockets, 503 for late requests, drain in-flight) ->
//!   onClose (graphql timers, db.close, diagnostics.close). Failures log
//!   `shutdown failed: ...` and exit 1.
//!
//! graphql/live integrate through these (comptime-detected) entry points:
//!   graphql.App.init(gpa, *db.DbService, ?*diagnostics.Service) !*App,
//!     app.route() http.Route, app.deinit()
//!   live.EventWebSocketServer.init(gpa, *db.DbService, ?*diagnostics.Service) !*S,
//!     s.start(*failure_message ?[]const u8) !void, s.upgradeHandler() http.UpgradeHandler,
//!     s.metricsProvider() core.metrics.WebSocketMetricsProvider, s.stop(), s.deinit()
const std = @import("std");
const builtin = @import("builtin");
const core = @import("core");
const db = @import("db");
const http = @import("http");
const graphql = @import("graphql");
const live = @import("live");
const diagnostics = @import("diagnostics");

const log = core.log.child("Shutdown");

const has_graphql_app = @hasDecl(graphql, "App");
const has_events = @hasDecl(live, "EventWebSocketServer");

const GraphqlApp = if (has_graphql_app) graphql.App else void;
const Events = if (has_events) live.EventWebSocketServer else void;

var signal_pipe: [2]std.posix.fd_t = .{ -1, -1 };

fn onSignal(sig: c_int) callconv(.c) void {
    // `process.once`: the next delivery of this signal uses the default action.
    var dfl: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.DFL }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(@intCast(sig), &dfl, null);
    const byte = [1]u8{@intCast(sig)};
    _ = std.posix.write(signal_pipe[1], &byte) catch {};
}

fn installSignals() !void {
    signal_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
    var act: std.posix.Sigaction = .{ .handler = .{ .handler = onSignal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.INT, &act, null);
    std.posix.sigaction(std.posix.SIG.TERM, &act, null);
    // Node ignores SIGPIPE; socket writes report EPIPE instead.
    var ign: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.PIPE, &ign, null);
}

const App = struct {
    gpa: std.mem.Allocator,
    db: *db.DbService,
    diag: ?*diagnostics.Diagnostics = null,
    graphql_app: if (has_graphql_app) ?*GraphqlApp else void = if (has_graphql_app) null else {},
    events: if (has_events) ?*Events else void = if (has_events) null else {},
    server: ?*http.Server = null,
    routes: std.ArrayList(http.Route) = .empty,

    fn diagnosticsService(self: *App) ?*diagnostics.Service {
        return if (self.diag) |d| &d.service else null;
    }

    /// Fastify `app.close()`. Returns false when a close step failed.
    fn close(self: *App) bool {
        var ok = true;
        // preClose
        if (has_events) if (self.events) |e| e.stop();
        // server close
        if (self.server) |s| s.close(30_000);
        // onClose (registration order: graphql plugin timer, db, diagnostics)
        if (has_graphql_app) if (self.graphql_app) |g| g.deinit();
        // Live tears down its sockets/streams before the db listeners go away.
        if (has_events) if (self.events) |e| e.deinit();
        self.db.close() catch |e| {
            log.err("shutdown failed: {s}", .{@errorName(e)});
            ok = false;
        };
        if (self.diag) |d| d.close();
        return ok;
    }
};

pub fn main() !void {
    const gpa = std.heap.c_allocator;
    var env = try std.process.getEnvMap(gpa);
    defer env.deinit();
    core.log.configure(&env);
    const config = core.config.load(gpa, &env) catch std.process.exit(1);
    core.config.set(config);
    core.metrics.init();
    try installSignals();
    // The process timer thread, shared by every module; lives until exit.
    var timers = core.scheduler.Scheduler.init(gpa);
    try timers.start();
    core.scheduler.setGlobal(&timers);

    var app: App = .{ .gpa = gpa, .db = try db.DbService.init(gpa, null) };
    if (config.diagnostics_database_url) |url| app.diag = try diagnostics.Diagnostics.open(gpa, url);

    // createScraperProxyApp: cors (built into http), /metrics, graphql scope.
    try app.routes.append(gpa, http.metricsRoute());
    if (has_graphql_app) {
        const g = try GraphqlApp.init(gpa, app.db, app.diagnosticsService());
        app.graphql_app = g;
        try app.routes.append(gpa, g.route());
    }
    if (has_events) app.events = try Events.init(gpa, app.db, app.diagnosticsService());

    core.metrics.setDatabaseMetricsProvider(app.db.metricsProvider());
    if (has_events) core.metrics.setWebSocketMetricsProvider(app.events.?.metricsProvider());

    startup(&app, config) catch |e| {
        _ = app.close();
        std.debug.print("{s}\n", .{@errorName(e)});
        std.process.exit(1);
    };

    // Wait for the first SIGINT/SIGTERM.
    var byte: [1]u8 = undefined;
    while (true) {
        const n = std.posix.read(signal_pipe[0], &byte) catch continue;
        if (n == 1) break;
    }
    const ok = app.close();
    std.process.exit(if (ok) 0 else 1);
}

fn startup(app: *App, config: core.config.Config) !void {
    var arena_state = std.heap.ArenaAllocator.init(app.gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // onReady: db.start()
    var failure: db.Failure = .{};
    app.db.start(&failure, arena) catch |e| {
        std.debug.print("Error: {s}\n", .{if (failure.message.len > 0) failure.message else @errorName(e)});
        return e;
    };
    // onReady: eventWebSocketServer.start(app.server)
    if (has_events) {
        var message: ?[]const u8 = null;
        app.events.?.start(&message) catch |e| {
            std.debug.print("Error: {s}\n", .{message orelse @errorName(e)});
            return e;
        };
    }
    if (config.port > 65535) {
        std.debug.print("RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536. Received type number ({d}).\n", .{config.port});
        return error.BadPort;
    }
    const server = http.Server.init(app.gpa, .{
        .host = "0.0.0.0",
        .port = @intCast(config.port),
        .routes = app.routes.items,
        .upgrade = if (has_events) app.events.?.upgradeHandler() else null,
    }) catch |e| {
        if (e == error.AddressInUse) std.debug.print("Error: listen EADDRINUSE: address already in use 0.0.0.0:{d}\n", .{config.port});
        return e;
    };
    app.server = server;
    try server.start();
}
