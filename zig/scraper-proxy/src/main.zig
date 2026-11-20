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
//!     s.metricsProvider() core.metrics.WebSocketMetricsProvider, s.setFiberHost(*http loop group),
//!     s.stop(), s.deinit()
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
        // Fastify sets `closing` before preClose: from here new requests get
        // the 503 while the listener still accepts (upgrades reach live until
        // its stop() removes the 'upgrade' listener).
        if (self.server) |s| s.beginClose();
        // preClose: events.stop(), which in TS also awaits each ws server's
        // close(), i.e. every client closed (its close handshake, or ws's
        // 30 s close timeout). avvio bounds the hook by Fastify's
        // pluginTimeout: past it, close goes on (the listener closes) and
        // app.close() rejects with the timeout once everything else is done.
        const pre_close_started = std.time.milliTimestamp();
        if (has_events) if (self.events) |e| e.stop();
        const pre_close_left: u64 = @intCast(@max(0, plugin_timeout_ms - (std.time.milliTimestamp() - pre_close_started)));
        // A stop() that alone used the whole bound has timed out too.
        const pre_close_in_time = pre_close_left > 0 and (if (self.server) |s| s.waitUpgraded(pre_close_left) == 0 else true);
        // server close; Node's close callback also waits for the upgraded
        // sockets (still the server's connections).
        if (self.server) |s| {
            s.close(30_000);
            _ = s.waitUpgraded(35_000);
        }
        // onClose (registration order: graphql plugin timer, db, diagnostics)
        if (has_graphql_app) if (self.graphql_app) |g| g.deinit();
        // Live tears down its sockets/streams before the db listeners go away.
        if (has_events) if (self.events) |e| e.deinit();
        self.db.close() catch |e| {
            log.err("shutdown failed: {s}", .{@errorName(e)});
            ok = false;
        };
        if (self.diag) |d| d.close();
        if (!pre_close_in_time) {
            log.err("shutdown failed: Plugin did not start in time: ''. You may have forgotten to call 'done' function or to resolve a Promise", .{});
            ok = false;
        }
        return ok;
    }
};

/// Fastify's default `pluginTimeout` (avvio's bound on each preClose hook).
const plugin_timeout_ms: i64 = 10_000;

/// glibc's mallopt (M_ARENA_MAX = -8).
extern "c" fn mallopt(param: c_int, value: c_int) c_int;

/// Node's `PlatformInit` (src/node.cc, v26.12.1): raise RLIMIT_NOFILE's
/// soft limit before anything else runs. With a finite hard limit, one
/// `setrlimit` to it; with RLIM_INFINITY, a binary search up to 1 << 20 for
/// the largest soft limit the kernel accepts (macOS caps it below its
/// infinite hard limit). Failures are ignored, as in Node:
///   if (getrlimit(RLIMIT_NOFILE, &lim) == 0 && lim.rlim_cur != lim.rlim_max) {
///     rlim_t min = lim.rlim_cur; rlim_t max = 1 << 20;
///     if (lim.rlim_max != RLIM_INFINITY) { min = lim.rlim_max; max = lim.rlim_max; }
///     do { lim.rlim_cur = min + (max - min) / 2;
///          if (setrlimit(RLIMIT_NOFILE, &lim)) max = lim.rlim_cur; else min = lim.rlim_cur;
///     } while (min + 1 < max); }
fn raiseOpenFileLimit() void {
    const Os = struct {
        fn get(_: void) ?std.posix.rlimit {
            return std.posix.getrlimit(.NOFILE) catch null;
        }
        fn set(_: void, lim: std.posix.rlimit) bool {
            std.posix.setrlimit(.NOFILE, lim) catch return false;
            return true;
        }
    };
    raiseNoFile({}, Os.get, Os.set);
}

/// The search itself (unsigned `rlim_t` arithmetic wraps, as in C).
fn raiseNoFile(ctx: anytype, comptime get: fn (@TypeOf(ctx)) ?std.posix.rlimit, comptime set: fn (@TypeOf(ctx), std.posix.rlimit) bool) void {
    var lim = get(ctx) orelse return;
    if (lim.cur == lim.max) return;
    var min: std.posix.rlim_t = lim.cur;
    var max: std.posix.rlim_t = 1 << 20;
    if (lim.max != std.posix.RLIM.INFINITY) {
        min = lim.max;
        max = lim.max;
    }
    while (true) {
        lim.cur = min +% (max -% min) / 2;
        if (set(ctx, lim)) min = lim.cur else max = lim.cur;
        if (!(min +% 1 < max)) break;
    }
}

pub fn main() !void {
    raiseOpenFileLimit();
    // At most 4 glibc malloc arenas: every thread that mallocs (e.g. a burst
    // of live task workers) otherwise gets its own, whose pages stay
    // resident after the thread exits. Not on musl or macOS.
    if (comptime builtin.os.tag == .linux and builtin.abi.isGnu()) _ = mallopt(-8, 4);
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
    // The LISTEN connection opens alongside db.start() (adopted by start()).
    if (has_events) app.events.?.listenEarly();

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
    // Live's subscribe, Explorer and validator setup reads run as fibers on these loops.
    if (has_events) app.events.?.setFiberHost(&server.loop);
    try server.start();
}

const FakeLimits = struct {
    lim: std.posix.rlimit,
    /// The largest soft limit the fake kernel accepts.
    accepts: std.posix.rlim_t,
    calls: std.ArrayList(std.posix.rlim_t) = .empty,

    fn get(self: *FakeLimits) ?std.posix.rlimit {
        return self.lim;
    }
    fn set(self: *FakeLimits, lim: std.posix.rlimit) bool {
        self.calls.append(std.testing.allocator, lim.cur) catch unreachable;
        if (lim.cur > self.accepts or lim.cur > lim.max) return false;
        self.lim = lim;
        return true;
    }
};

test "raiseNoFile follows Node's PlatformInit: soft = finite hard, binary search under RLIM_INFINITY, nothing when equal" {
    const testing = std.testing;
    const inf = std.posix.RLIM.INFINITY;
    // Finite hard limit: one setrlimit to it.
    {
        var f: FakeLimits = .{ .lim = .{ .cur = 256, .max = 65_536 }, .accepts = inf };
        defer f.calls.deinit(testing.allocator);
        raiseNoFile(&f, FakeLimits.get, FakeLimits.set);
        try testing.expectEqual(@as(std.posix.rlim_t, 65_536), f.lim.cur);
        try testing.expectEqualSlices(std.posix.rlim_t, &.{65_536}, f.calls.items);
    }
    // Refused (e.g. a sandbox): silently left as it was.
    {
        var f: FakeLimits = .{ .lim = .{ .cur = 256, .max = 65_536 }, .accepts = 256 };
        defer f.calls.deinit(testing.allocator);
        raiseNoFile(&f, FakeLimits.get, FakeLimits.set);
        try testing.expectEqual(@as(std.posix.rlim_t, 256), f.lim.cur);
    }
    // RLIM_INFINITY (macOS): the largest value the kernel takes, here 10240
    // (kern.maxfilesperproc), found by bisecting [256, 1 << 20].
    {
        var f: FakeLimits = .{ .lim = .{ .cur = 256, .max = inf }, .accepts = 10_240 };
        defer f.calls.deinit(testing.allocator);
        raiseNoFile(&f, FakeLimits.get, FakeLimits.set);
        try testing.expectEqual(@as(std.posix.rlim_t, 10_240), f.lim.cur);
        try testing.expectEqual(@as(std.posix.rlim_t, 524_416), f.calls.items[0]);
    }
    // Already equal: no call.
    {
        var f: FakeLimits = .{ .lim = .{ .cur = 4096, .max = 4096 }, .accepts = inf };
        defer f.calls.deinit(testing.allocator);
        raiseNoFile(&f, FakeLimits.get, FakeLimits.set);
        try testing.expectEqual(@as(usize, 0), f.calls.items.len);
    }
}
