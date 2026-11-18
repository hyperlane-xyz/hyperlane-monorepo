//! Socket-level port of the GraphQL parts of `src/module.test.ts` and the
//! execution cases of `scraperdb/schema.test.ts`: the real HTTP server, the
//! `/graphql` route and `scraperdb.Service` over a scripted fake database.
const std = @import("std");
const core = @import("core");
const http = @import("http");
const scraperdb = @import("scraperdb");
const schema_mod = @import("schema.zig");
const route_mod = @import("route.zig");
const resolvers = @import("resolvers.zig");

const testing = std.testing;
const posix = std.posix;
const Value = core.json.Value;
const Allocator = std.mem.Allocator;

const FakeDb = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    queries: u32 = 0,
    started: u32 = 0,
    /// JSON array of rows returned by every query.
    rows: []const u8 = "[]",
    /// Rows for queries whose SQL contains `needle` (checked first).
    rows_by_sql: []const struct { needle: []const u8, rows: []const u8 } = &.{},
    fail: ?[]const u8 = null,
    fail_first_only: bool = false,
    blocked: bool = false,
    /// Like `blocked`, for queries whose SQL contains this needle only.
    block_sql: ?[]const u8 = null,
    /// Parked fibers waiting for `release` (a thread wait would block the
    /// loop thread every other request needs).
    parked: [64]*core.fiber.Waiter = undefined,
    parked_len: usize = 0,
    /// What each query saw of the request's fiber-locals (`execute.admission`
    /// and `execute.io_events`), in call order.
    seen: [16]Seen = undefined,
    seen_len: usize = 0,
    /// `EXPLAIN (FORMAT JSON)` planning reads (#10076): answered at once with
    /// this Total Cost (TS tests' cheap plan is 1), or no plan row when null.
    /// Not counted in `queries`/`started` and never blocked.
    explain_cost: ?f64 = 1,
    explains: u32 = 0,
    /// Every call's SQL and JSON parameters (EXPLAIN included), in call order.
    calls: [8]Call = undefined,
    calls_len: usize = 0,
    /// Each query's last parameter when it is a number (the LIMIT), in call order.
    tail_numbers: [16]f64 = undefined,
    tail_numbers_len: usize = 0,
    /// Queries whose SQL contains this needle fail with `fail_sql_message`.
    fail_sql: ?[]const u8 = null,
    fail_sql_message: []const u8 = "boom",
    /// Queries whose SQL contains this needle sleep first (completion order).
    delay_sql: ?[]const u8 = null,
    /// Queries whose SQL contains this needle wait before their first read
    /// takes its execution slot, until `releasePreIo` (off-fiber only).
    pre_io_sql: ?[]const u8 = null,
    pre_io_waiting: u32 = 0,
    /// Queries numbered `from..to` (1-based, in start order) wait until their
    /// gate opens (`openGate`); fiber or thread alike.
    gates: [4]Gate = @splat(.{}),

    const Gate = struct { from: u32 = 0, to: u32 = 0, open: bool = true };

    const Seen = struct { admission: ?*anyopaque, io_events: u32 };

    const Call = struct {
        sql_buf: [2048]u8 = undefined,
        sql_len: usize = 0,
        params_buf: [256]u8 = undefined,
        params_len: usize = 0,

        fn sql(self: *const Call) []const u8 {
            return self.sql_buf[0..self.sql_len];
        }

        fn params(self: *const Call) []const u8 {
            return self.params_buf[0..self.params_len];
        }
    };

    fn mustWait(self: *const FakeDb, text: []const u8, n: u32) bool {
        for (self.gates) |g| if (!g.open and n >= g.from and n <= g.to) return true;
        if (self.blocked) return true;
        const needle = self.block_sql orelse return false;
        return std.mem.indexOf(u8, text, needle) != null;
    }

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, params: []const Value, diag: *scraperdb.Diag) anyerror![]Value {
        const self: *FakeDb = @ptrCast(@alignCast(ctx));
        const execute = @import("execute.zig");
        const seen: Seen = .{ .admission = if (execute.admission) |adm| adm.ctx else null, .io_events = execute.io_events };
        self.mutex.lock();
        if (self.calls_len < self.calls.len) {
            const call = &self.calls[self.calls_len];
            call.* = .{};
            const sql = text[0..@min(text.len, call.sql_buf.len)];
            @memcpy(call.sql_buf[0..sql.len], sql);
            call.sql_len = sql.len;
            call.params_len = (std.fmt.bufPrint(&call.params_buf, "{f}", .{Value{ .array = @constCast(params) }}) catch "").len;
            self.calls_len += 1;
        }
        if (self.pre_io_sql) |needle| if (std.mem.indexOf(u8, text, needle) != null) {
            self.pre_io_waiting += 1;
            self.cond.broadcast();
            while (self.pre_io_sql != null) self.cond.wait(&self.mutex);
        };
        self.mutex.unlock();
        if (!execute.beforeIo()) {
            diag.message = route_mod.capacity_message;
            return error.CapacityExceeded;
        }
        execute.afterIo();
        if (std.mem.startsWith(u8, text, "EXPLAIN")) {
            self.mutex.lock();
            self.explains += 1;
            const cost = self.explain_cost;
            self.mutex.unlock();
            const plan = if (cost) |c| try std.fmt.allocPrint(arena, "[{{\"QUERY PLAN\":[{{\"Plan\":{{\"Total Cost\":{d}}}}}]}}]", .{c}) else "[]";
            return (try core.json.parse(arena, plan, .{})).array;
        }
        self.mutex.lock();
        self.queries += 1;
        self.started += 1;
        const n = self.queries;
        if (self.seen_len < self.seen.len) {
            self.seen[self.seen_len] = seen;
            self.seen_len += 1;
        }
        if (params.len > 0 and params[params.len - 1] == .number and self.tail_numbers_len < self.tail_numbers.len) {
            self.tail_numbers[self.tail_numbers_len] = params[params.len - 1].number;
            self.tail_numbers_len += 1;
        }
        self.cond.broadcast();
        if (self.mustWait(text, n)) {
            if (core.fiber.inFiber()) {
                // The loop thread must keep serving: park this fiber.
                while (self.mustWait(text, n)) {
                    var w: core.fiber.Waiter = .{};
                    if (self.parked_len == self.parked.len) @panic("FakeDb: more than 64 parked queries");
                    self.parked[self.parked_len] = &w;
                    self.parked_len += 1;
                    self.mutex.unlock();
                    w.wait();
                    self.mutex.lock();
                }
            } else {
                core.blocking.begin();
                defer core.blocking.end();
                while (self.mustWait(text, n)) self.cond.wait(&self.mutex);
            }
        }
        const fail = self.fail;
        const fail_first = self.fail_first_only;
        var rows = self.rows;
        for (self.rows_by_sql) |r| if (std.mem.indexOf(u8, text, r.needle) != null) {
            rows = r.rows;
            break;
        };
        const fail_sql = self.fail_sql;
        const delay_sql = self.delay_sql;
        self.mutex.unlock();
        if (delay_sql) |needle| if (std.mem.indexOf(u8, text, needle) != null) {
            // A slow query: on a fiber it parks (sibling root fields run
            // meanwhile, as on separate threads); elsewhere the thread sleeps.
            if (core.fiber.inFiber()) {
                var w: core.fiber.Waiter = .{};
                _ = w.waitTimeout(core.fiber.monoMs() + 40);
            } else std.Thread.sleep(40 * std.time.ns_per_ms);
        };
        if (fail_sql) |needle| if (std.mem.indexOf(u8, text, needle) != null) {
            diag.message = self.fail_sql_message;
            return error.QueryFailed;
        };
        if (fail) |message| if (!fail_first or n == 1) {
            diag.message = message;
            return error.QueryFailed;
        };
        const parsed = try core.json.parse(arena, rows, .{});
        return parsed.array;
    }

    fn count(self: *FakeDb) u32 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.queries;
    }

    /// Until `n` queries started; a lost event fails the test (after 30 s)
    /// instead of hanging the runner.
    fn waitStarted(self: *FakeDb, n: u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        var timer = std.time.Timer.start() catch unreachable;
        const limit = 30 * std.time.ns_per_s;
        while (self.started < n) {
            const spent = timer.read();
            if (spent >= limit) std.debug.panic("FakeDb.waitStarted: {d} of {d} queries started within 30 s", .{ self.started, n });
            self.cond.timedWait(&self.mutex, limit - spent) catch {};
        }
    }

    /// Parks every following query until `release` (under the mutex the
    /// query path reads it with).
    fn block(self: *FakeDb) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.blocked = true;
    }

    fn gate(self: *FakeDb, i: usize, from: u32, to: u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.gates[i] = .{ .from = from, .to = to, .open = false };
    }

    fn openGate(self: *FakeDb, i: usize) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.gates[i].open = true;
        self.cond.broadcast();
        for (self.parked[0..self.parked_len]) |w| w.wake();
        self.parked_len = 0;
    }

    fn waitPreIo(self: *FakeDb, n: u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        while (self.pre_io_waiting < n) self.cond.wait(&self.mutex);
    }

    fn releasePreIo(self: *FakeDb) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.pre_io_sql = null;
        self.cond.broadcast();
    }

    fn release(self: *FakeDb) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.blocked = false;
        self.block_sql = null;
        self.cond.broadcast();
        // `wake` never touches a waiter after waking it.
        for (self.parked[0..self.parked_len]) |w| w.wake();
        self.parked_len = 0;
    }
};

/// Overwrites freed memory with 0xAA so use-after-free shows up as garbage.
const PoisonAllocator = struct {
    child: Allocator,

    fn allocator(self: *PoisonAllocator) Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }
    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret: usize) ?[*]u8 {
        const self: *PoisonAllocator = @ptrCast(@alignCast(ctx));
        return self.child.rawAlloc(len, alignment, ret);
    }
    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret: usize) bool {
        const self: *PoisonAllocator = @ptrCast(@alignCast(ctx));
        return self.child.rawResize(memory, alignment, new_len, ret);
    }
    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret: usize) ?[*]u8 {
        const self: *PoisonAllocator = @ptrCast(@alignCast(ctx));
        return self.child.rawRemap(memory, alignment, new_len, ret);
    }
    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret: usize) void {
        const self: *PoisonAllocator = @ptrCast(@alignCast(ctx));
        @memset(memory, 0xAA);
        self.child.rawFree(memory, alignment, ret);
    }
};

const App = struct {
    db: FakeDb = .{},
    /// Allocator for the route (caches); defaults to testing.allocator.
    gpa: ?Allocator = null,
    request_timeout_ms: u32 = 10_000,
    /// Event loops (null: the build default).
    loops: ?u32 = null,
    route: route_mod.GraphqlRoute = undefined,
    routes: [2]http.Route = undefined,
    server: *http.Server = undefined,

    fn start(self: *App) !void {
        core.metrics.init();
        core.log.setLevel(.@"error");
        const svc = scraperdb.Service.init(.{ .ctx = &self.db, .queryFn = FakeDb.query });
        self.route = route_mod.GraphqlRoute.init(self.gpa orelse testing.allocator, schema_mod.testing.scraper(), .{ .db = svc }, .{});
        self.routes = .{ http.metricsRoute(), self.route.route() };
        var options: http.Options = .{ .host = "127.0.0.1", .port = 0, .routes = &self.routes, .request_timeout_ms = self.request_timeout_ms };
        if (self.loops) |n| options.loops = n;
        self.server = try http.Server.init(testing.allocator, options);
        try self.server.start();
    }

    fn stop(self: *App) void {
        self.server.deinit();
        self.route.deinit();
    }

    fn connect(self: *App) !Client {
        const addr = try std.net.Address.parseIp("127.0.0.1", self.server.port());
        const stream = try std.net.tcpConnectToAddress(addr);
        return .{ .fd = stream.handle };
    }

    fn request(self: *App, a: Allocator, raw: []const u8) !Response {
        var c = try self.connect();
        defer c.close();
        return c.request(a, raw);
    }

    fn post(self: *App, a: Allocator, body: []const u8) !Response {
        return self.request(a, try std.fmt.allocPrint(a, "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{s}", .{ body.len, body }));
    }

    fn postQuery(self: *App, a: Allocator, query: []const u8) !Response {
        return self.post(a, try std.fmt.allocPrint(a, "{{\"query\":{f}}}", .{Value{ .string = query }}));
    }

    /// A request that stays parked (blocked database) until the test
    /// releases it: a generous read bound, so a lost event fails the test
    /// instead of hanging the runner.
    fn postQueryParked(self: *App, a: Allocator, query: []const u8) !Response {
        var c = try self.connect();
        defer c.close();
        c.timeout_ms = parked_timeout_ms;
        const body = try std.fmt.allocPrint(a, "{{\"query\":{f}}}", .{Value{ .string = query }});
        return c.request(a, try std.fmt.allocPrint(a, "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{s}", .{ body.len, body }));
    }

    fn get(self: *App, a: Allocator, query_string: []const u8, preflight: bool) !Response {
        return self.request(a, try std.fmt.allocPrint(a, "GET /graphql?{s} HTTP/1.1\r\nHost: x\r\n{s}\r\n", .{ query_string, if (preflight) "mercurius-require-preflight: true\r\n" else "" }));
    }
};

const parked_timeout_ms = 30_000;

/// Status of a parked request; failures are reported, not hidden as status 0.
const ParkedResult = struct {
    status: u16 = 0,
    err: ?anyerror = null,

    fn run(self: *ParkedResult, ap: *App, query: []const u8) void {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const r = ap.postQueryParked(arena.allocator(), query) catch |e| {
            self.err = e;
            return;
        };
        self.status = r.status;
    }

    fn expectOk(self: ParkedResult, index: usize) !void {
        if (self.err) |e| {
            std.debug.print("parked request {d} failed: {s} (no response within {d} ms: an event was lost or the request was never served)\n", .{ index, @errorName(e), parked_timeout_ms });
            return e;
        }
        try testing.expectEqual(@as(u16, 200), self.status);
    }
};

const Response = struct {
    status: u16,
    head: []const u8,
    body: []const u8,

    fn header(self: Response, name: []const u8) ?[]const u8 {
        var lines = std.mem.splitSequence(u8, self.head, "\r\n");
        _ = lines.next();
        while (lines.next()) |line| {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            if (std.ascii.eqlIgnoreCase(line[0..colon], name)) return std.mem.trim(u8, line[colon + 1 ..], " ");
        }
        return null;
    }

    fn contains(self: Response, needle: []const u8) bool {
        return std.mem.indexOf(u8, self.body, needle) != null;
    }
};

const Client = struct {
    fd: posix.socket_t,
    buf: [256 * 1024]u8 = undefined,
    /// Read timeout per poll (tests whose requests stay parked use more).
    timeout_ms: i32 = 5_000,
    len: usize = 0,

    fn close(self: *Client) void {
        posix.close(self.fd);
    }

    /// Closes with RST (SO_LINGER 0): a hangup that aborts under either
    /// `http.server` hangup policy (a bare FIN aborts only under `.eof_drop`).
    fn closeWithReset(self: *Client) void {
        const linger: extern struct { onoff: c_int, linger: c_int } = .{ .onoff = 1, .linger = 0 };
        posix.setsockopt(self.fd, posix.SOL.SOCKET, posix.SO.LINGER, std.mem.asBytes(&linger)) catch {};
        posix.close(self.fd);
    }

    fn send(self: *Client, bytes: []const u8) !void {
        if (!http.server.blockingWriteForTests(self.fd, bytes)) return error.WriteFailed;
    }

    fn fill(self: *Client) !usize {
        var fds = [_]posix.pollfd{.{ .fd = self.fd, .events = posix.POLL.IN, .revents = 0 }};
        if (try posix.poll(&fds, self.timeout_ms) == 0) return error.Timeout;
        const n = posix.read(self.fd, self.buf[self.len..]) catch return 0;
        self.len += n;
        return n;
    }

    fn read(self: *Client, a: Allocator) !Response {
        while (std.mem.indexOf(u8, self.buf[0..self.len], "\r\n\r\n") == null) {
            if (try self.fill() == 0) return error.EndOfStream;
        }
        const head_end = std.mem.indexOf(u8, self.buf[0..self.len], "\r\n\r\n").? + 4;
        const head = try a.dupe(u8, self.buf[0..head_end]);
        var resp: Response = .{ .status = try std.fmt.parseInt(u16, head[9..12], 10), .head = head, .body = "" };
        const body_len = if (resp.header("content-length")) |cl| try std.fmt.parseInt(usize, cl, 10) else 0;
        while (self.len < head_end + body_len) {
            if (try self.fill() == 0) return error.EndOfStream;
        }
        resp.body = try a.dupe(u8, self.buf[head_end .. head_end + body_len]);
        const used = head_end + body_len;
        std.mem.copyForwards(u8, self.buf[0 .. self.len - used], self.buf[used..self.len]);
        self.len -= used;
        return resp;
    }

    fn request(self: *Client, a: Allocator, bytes: []const u8) !Response {
        try self.send(bytes);
        return self.read(a);
    }

    fn closedByPeer(self: *Client) bool {
        while (true) {
            const n = self.fill() catch return false;
            if (n == 0) return true;
        }
    }
};

fn expectJson(resp: Response, status: u16, body: []const u8) !void {
    if (resp.status != status or !std.mem.eql(u8, resp.body, body)) {
        std.debug.print("expected {d} {s}\n     got {d} {s}\n", .{ status, body, resp.status, resp.body });
        return error.TestUnexpectedResponse;
    }
}

test "serves GraphQL with compatibility validation (POST, GET, introspection)" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const body = "{\"query\":\"query Domains($unused: String!, $missing: Int!) { domain(limit: 1) { id name } }\",\"variables\":{\"unused\":\"legacy-client-variable\"}}";
    const r = try app.request(a, try std.fmt.allocPrint(a, "POST /graphql HTTP/1.1\r\nHost: x\r\nOrigin: https://example.com\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{s}", .{ body.len, body }));
    try expectJson(r, 200, "{\"data\":{\"domain\":[]}}");
    try testing.expectEqualStrings("https://example.com", r.header("access-control-allow-origin").?);
    try testing.expectEqual(@as(u32, 1), app.db.count());

    const g = try app.get(a, "query=query+Domains%28%24unused%3A+String%21%2C+%24missing%3A+Int%21%29+%7B+domain%28limit%3A+1%29+%7B+id+name+%7D+%7D&variables=%7B%22unused%22%3A%22legacy-client-variable%22%7D", true);
    try expectJson(g, 200, "{\"data\":{\"domain\":[]}}");
    try testing.expectEqual(@as(u32, 2), app.db.count());

    const intro = try app.postQuery(a, "{ __schema { queryType { name } } }");
    try testing.expectEqual(@as(u16, 400), intro.status);
    try testing.expect(intro.contains("Introspection is not allowed"));
}

test "preserves case-insensitive and trailing-slash GraphQL routes" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{ "/graphql/", "/GraphQL" }) |path| {
        const body = "{\"query\":\"{ domain(limit: 1) { id } }\"}";
        const r = try app.request(a, try std.fmt.allocPrint(a, "POST {s} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{s}", .{ path, body.len, body }));
        try expectJson(r, 200, "{\"data\":{\"domain\":[]}}");
    }
}

test "preserves cached query and refresh semantics" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const first = try app.postQuery(a, "query @cached(ttl: 30, refresh: false) { domain(limit: 1) { id } }");
    const cached = try app.postQuery(a, "query @cached(ttl: 30, refresh: false) { domain(limit: 1) { id } }");
    try expectJson(first, 200, "{\"data\":{\"domain\":[]}}");
    try expectJson(cached, 200, first.body);
    try testing.expectEqualStrings("max-age=30, public", first.header("cache-control").?);
    // Remaining seconds rounded up: 30 unless the second request reads it
    // more than a second later (a slow runner).
    const cc = cached.header("cache-control").?;
    try testing.expect(std.mem.eql(u8, cc, "max-age=30, public") or std.mem.eql(u8, cc, "max-age=29, public") or std.mem.eql(u8, cc, "max-age=28, public"));
    try testing.expectEqualStrings("application/json; charset=utf-8", cached.header("content-type").?);
    try testing.expectEqual(@as(u32, 1), app.db.count());
    const refreshed = try app.postQuery(a, "query @cached(ttl: 30, refresh: true) { domain(limit: 1) { id } }");
    try testing.expectEqual(@as(u16, 200), refreshed.status);
    try testing.expectEqual(@as(u32, 2), app.db.count());
    try testing.expectEqualStrings("max-age=30, public", refreshed.header("cache-control").?);
}

test "rejects malformed variables when the response cache is warm" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const q = "\"query @cached(ttl: 30) { domain(limit: 1) { id } }\"";
    const first = try app.post(a, try std.fmt.allocPrint(a, "{{\"query\":{s},\"variables\":{{}}}}", .{q}));
    const cached = try app.post(a, try std.fmt.allocPrint(a, "{{\"query\":{s},\"variables\":{{}}}}", .{q}));
    try expectJson(first, 200, "{\"data\":{\"domain\":[]}}");
    try expectJson(cached, 200, first.body);
    try testing.expectEqual(@as(u32, 1), app.db.count());
    for ([_][]const u8{ "\"{}\"", "1", "true", "[]" }) |malformed| {
        const r = try app.post(a, try std.fmt.allocPrint(a, "{{\"query\":{s},\"variables\":{s}}}", .{ q, malformed }));
        try expectJson(r, 400, "{\"data\":null,\"errors\":[{\"message\":\"body/variables must be object,null\"}]}");
    }
    try testing.expectEqual(@as(u32, 1), app.db.count());
    const bad_get = try app.get(a, "query=query+%40cached%28ttl%3A+30%29+%7B+domain%28limit%3A+1%29+%7B+id+%7D+%7D&variables=not-json", true);
    try expectJson(bad_get, 400, "{\"data\":null,\"errors\":[{\"message\":\"Unexpected token 'o', \\\"not-json\\\" is not valid JSON\"}]}");
    try testing.expectEqual(@as(u32, 1), app.db.count());
    const no_vars = try app.post(a, try std.fmt.allocPrint(a, "{{\"query\":{s}}}", .{q}));
    try testing.expectEqual(@as(u16, 200), no_vars.status);
    try testing.expectEqual(@as(u32, 1), app.db.count());
    const dup = try app.postQuery(a, "query @cached(ttl: 30) @cached(ttl: 30) { domain(limit: 1) { id } }");
    try expectJson(dup, 400, "{\"data\":null,\"errors\":[{\"message\":\"The directive \\\"@cached\\\" can only be used once at this location.\",\"locations\":[{\"line\":1,\"column\":7},{\"line\":1,\"column\":24}]}]}");
    try testing.expectEqual(@as(u32, 1), app.db.count());
}

test "serializes the production query surface consistently" {
    var app: App = .{};
    app.db.rows = "[{\"count\":1,\"delivery_latency\":null,\"delivery_occurred_at\":\"2026-09-14T12:00:00.000Z\",\"destination_tx_gas_used\":\"123.45\",\"id\":1,\"msg_id\":\"0x1111111111111111111111111111111111111111111111111111111111111111\",\"name\":\"ethereum\",\"nonce\":42}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.postQuery(a, "{ domain(limit: 1) { id name } }"), 200, "{\"data\":{\"domain\":[{\"id\":1,\"name\":\"ethereum\"}]}}");
    try expectJson(try app.post(a, "{\"query\":\"query Domain($id: Int!, $unused: String) { domain_by_pk(id: $id) { id name } }\",\"variables\":{\"id\":1,\"unused\":\"legacy-client-variable\"}}"), 200, "{\"data\":{\"domain_by_pk\":{\"id\":1,\"name\":\"ethereum\"}}}");
    try expectJson(
        try app.postQuery(a, "{ result: message_view_aggregate(where: {origin_tx_hash: {_eq: \"0x11\"}}, limit: 1) { aggregate { count } nodes { id msg_id nonce delivery_latency delivery_occurred_at destination_tx_gas_used } } }"),
        200,
        "{\"data\":{\"result\":{\"aggregate\":{\"count\":1},\"nodes\":[{\"id\":1,\"msg_id\":\"0x1111111111111111111111111111111111111111111111111111111111111111\",\"nonce\":42,\"delivery_latency\":null,\"delivery_occurred_at\":\"2026-09-14T12:00:00.000Z\",\"destination_tx_gas_used\":\"123.45\"}]}}}",
    );
    try expectJson(try app.postQuery(a, "{ raw_message_dispatch(limit: 1) { id } }"), 200, "{\"data\":{\"raw_message_dispatch\":[{\"id\":1}]}}");
}

test "bounds concurrent pathological GraphQL requests" {
    var app: App = .{};
    app.db.block();
    try app.start();
    defer app.stop();
    var threads: [25]std.Thread = undefined;
    var results = [_]ParkedResult{.{}} ** 25;
    for (&threads, &results) |*t, *r| t.* = try std.Thread.spawn(.{}, ParkedResult.run, .{ r, &app, "{ domain(limit: 1) { id } }" });
    app.db.waitStarted(25);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rejected = try app.postQuery(a, "{ domain(limit: 1) { id } }");
    try testing.expectEqual(@as(u16, 503), rejected.status);
    try testing.expectEqualStrings("1", rejected.header("retry-after").?);
    try testing.expectEqualStrings("GraphQL request capacity exceeded", rejected.body);
    try testing.expectEqual(@as(u16, 200), (try app.request(a, "GET /metrics HTTP/1.1\r\nHost: x\r\n\r\n")).status);
    app.db.release();
    for (threads) |t| t.join();
    for (results, 0..) |r, i| try r.expectOk(i);
    try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, "{ domain(limit: 1) { id } }")).status);
}

test "a parked request keeps its own fiber-locals while another runs (route FiberLocals)" {
    // `execute.admission` and `execute.io_events` are thread-locals that
    // route.zig registers as fiber-locals. Request A's one field reads a
    // confirmation snapshot (parked here) and then its projection; request B
    // runs to completion on the same loop meanwhile. A's second query must
    // still see A's admission and A's own I/O count.
    const frontier = "custom_frontier AS";
    var app: App = .{};
    app.db.block_sql = frontier;
    app.db.rows_by_sql = &.{.{ .needle = frontier, .rows = "[{\"domains\":[],\"heights\":[],\"message_ids\":[]}]" }};
    try app.start();
    defer app.stop();
    var a_result: ParkedResult = .{};
    const a_thread = try std.Thread.spawn(.{}, ParkedResult.run, .{ &a_result, &app, "{ message_view(confirmations: 0, where: {is_provisional: {_eq: true}}, limit: 1) { id } }" });
    app.db.waitStarted(1);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.postQuery(a, "{ d1: domain(limit: 1) { id } d2: domain(limit: 2) { id } }"), 200, "{\"data\":{\"d1\":[],\"d2\":[]}}");
    app.db.release();
    a_thread.join();
    try a_result.expectOk(0);
    app.db.mutex.lock();
    const seen_copy = app.db.seen;
    const seen_len = app.db.seen_len;
    app.db.mutex.unlock();
    const seen = seen_copy[0..seen_len];
    try testing.expectEqual(@as(usize, 4), seen.len);
    const first = seen[0];
    const last = seen[3];
    try testing.expect(first.admission != null);
    for (seen[1..3]) |b| {
        try testing.expect(b.admission != null);
        try testing.expect(b.admission != first.admission);
    }
    try testing.expectEqual(first.admission, last.admission);
    // Between them: the projection's EXPLAIN planning read (#10076).
    try testing.expectEqual(first.io_events +% 2, last.io_events);
}

test "only requests parked on I/O hold execution slots (Node turn semantics)" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cached = "query @cached(ttl: 300) { domain(limit: 1) { id } }";
    try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, cached)).status);
    // 24 requests parked on the database leave one slot.
    app.db.block();
    const parked_query = "{ domain(limit: 2) { id } }";
    var parked: [24]std.Thread = undefined;
    var parked_results = [_]ParkedResult{.{}} ** 24;
    for (&parked, &parked_results) |*t, *r| t.* = try std.Thread.spawn(.{}, ParkedResult.run, .{ r, &app, parked_query });
    app.db.waitStarted(25);
    // Many concurrent keep-alive clients whose requests never yield: none is
    // rejected (TS admits and finishes each within one event-loop turn).
    const Hammer = struct {
        fn run(ap: *App, rejected: *std.atomic.Value(u32), failed: *std.atomic.Value(u32)) void {
            var ar = std.heap.ArenaAllocator.init(testing.allocator);
            defer ar.deinit();
            const c = testing.allocator.create(Client) catch return;
            defer testing.allocator.destroy(c);
            c.* = ap.connect() catch {
                _ = failed.fetchAdd(1, .monotonic);
                return;
            };
            defer c.close();
            const hit = std.fmt.allocPrint(ar.allocator(), "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{{\"query\":\"{s}\"}}", .{ cached.len + 12, cached }) catch return;
            const invalid_body = "{\"query\":\"{ domain { idx } }\"}";
            const invalid = std.fmt.comptimePrint("POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n", .{invalid_body.len}) ++ invalid_body;
            for (0..25) |i| {
                const r = c.request(ar.allocator(), if (i % 4 == 3) invalid else hit) catch {
                    _ = failed.fetchAdd(1, .monotonic);
                    return;
                };
                if (r.status == 503) _ = rejected.fetchAdd(1, .monotonic);
            }
        }
    };
    var rejected: std.atomic.Value(u32) = .init(0);
    var failed: std.atomic.Value(u32) = .init(0);
    var hammers: [64]std.Thread = undefined;
    for (&hammers) |*t| t.* = try std.Thread.spawn(.{}, Hammer.run, .{ &app, &rejected, &failed });
    for (hammers) |t| t.join();
    try testing.expectEqual(@as(u32, 0), failed.load(.monotonic));
    try testing.expectEqual(@as(u32, 0), rejected.load(.monotonic));
    // A 25th parked request fills the last slot; then even a cache hit is
    // rejected at preHandler, as in TS.
    var last_result: ParkedResult = .{};
    const last = try std.Thread.spawn(.{}, ParkedResult.run, .{ &last_result, &app, parked_query });
    app.db.waitStarted(26);
    const full = try app.postQuery(a, cached);
    try testing.expectEqual(@as(u16, 503), full.status);
    try testing.expectEqualStrings("GraphQL request capacity exceeded", full.body);
    try testing.expect(full.header("cache-control") == null);
    app.db.release();
    for (parked) |t| t.join();
    last.join();
    for (parked_results, 0..) |r, i| try r.expectOk(i);
    try last_result.expectOk(24);
    try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, cached)).status);
}

test "rejects batch and oversized request bodies" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.post(a, "[{\"query\":\"{ domain { id } }\"},{\"query\":\"{ domain { id } }\"}]"), 400, "{\"data\":null,\"errors\":[{\"message\":\"body must be object\"}]}");
    const big = try a.alloc(u8, 102_400);
    @memset(big, 'x');
    const oversized = try app.post(a, try std.fmt.allocPrint(a, "{{\"query\":\"#{s}\\n{{ domain {{ id }} }}\"}}", .{big}));
    try testing.expectEqual(@as(u16, 413), oversized.status);
    var q: std.ArrayList(u8) = .empty;
    try q.appendSlice(a, "{ __typename }");
    for (0..1500) |i| try q.print(a, " fragment F{d} on query_root {{ __typename }}", .{i});
    const tokens = try app.postQuery(a, q.items);
    try testing.expectEqual(@as(u16, 400), tokens.status);
    try testing.expect(tokens.contains("more that 10000 tokens"));
}

test "preserves the CSRF request contract" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const unsafe = try app.get(a, "query=%7B%20domain%20%7B%20id%20%7D%20%7D", false);
    try testing.expectEqual(@as(u16, 400), unsafe.status);
    try testing.expect(unsafe.contains("Cross-Site Request Forgery"));
    for ([_][]const u8{ "x-apollo-operation-name", "apollo-require-preflight", "x-mercurius-operation-name", "mercurius-require-preflight" }) |name| {
        const r = try app.request(a, try std.fmt.allocPrint(a, "GET /graphql?query=%7B%20domain%20%7B%20id%20%7D%20%7D HTTP/1.1\r\nHost: x\r\n{s}: Domains\r\n\r\n", .{name}));
        try expectJson(r, 200, "{\"data\":{\"domain\":[]}}");
    }
    for ([_][]const u8{ "text/plain", "application/x-www-form-urlencoded" }) |ct| {
        const r = try app.request(a, try std.fmt.allocPrint(a, "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: {s}\r\nContent-Length: 18\r\n\r\nquery={{domain{{id}}}}", .{ct}));
        try testing.expectEqual(@as(u16, 400), r.status);
        try testing.expect(r.contains("Cross-Site Request Forgery"));
        try testing.expectEqualStrings("close", r.header("connection").?);
    }
    const gql = try app.request(a, "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/graphql\r\nContent-Length: 17\r\n\r\n{ domain { id } }");
    try expectJson(gql, 200, "{\"data\":{\"domain\":[]}}");
    const preflight = try app.request(a, "OPTIONS /graphql HTTP/1.1\r\nHost: x\r\nAccess-Control-Request-Headers: mercurius-require-preflight\r\nAccess-Control-Request-Method: GET\r\nOrigin: https://example.com\r\n\r\n");
    try testing.expectEqual(@as(u16, 204), preflight.status);
    try testing.expect(std.ascii.indexOfIgnoreCase(preflight.header("access-control-allow-headers").?, "mercurius-require-preflight") != null);
    for (0..2) |_| _ = try app.get(a, "query=query%20%40cached(ttl%3A%2030)%20%7B%20domain%20%7B%20id%20%7D%20%7D", true);
    try testing.expectEqual(@as(u32, 6), app.db.count());
}

test "returns useful GraphQL parse, validation, and execution errors" {
    var app: App = .{};
    app.db.fail = "database unavailable";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const before = core.metrics.graphql_errors.get(.{});
    try expectJson(try app.postQuery(a, "{"), 400, "{\"data\":null,\"errors\":[{\"message\":\"Syntax Error: Expected Name, found <EOF>.\",\"locations\":[{\"line\":1,\"column\":2}]}]}");
    try expectJson(try app.postQuery(a, "{ missing_field }"), 400, "{\"data\":null,\"errors\":[{\"message\":\"Cannot query field \\\"missing_field\\\" on type \\\"query_root\\\".\",\"locations\":[{\"line\":1,\"column\":3}]}]}");
    try expectJson(try app.postQuery(a, "{ domain(limit: 1) { id } }"), 200, "{\"data\":null,\"errors\":[{\"message\":\"database unavailable\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"domain\"]}]}");
    try testing.expectEqual(@as(f64, 3), core.metrics.graphql_errors.get(.{}) - before);
}

test "does not cache pathological resolver failures" {
    var app: App = .{};
    app.db.fail = "database unavailable";
    app.db.fail_first_only = true;
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const failed = try app.postQuery(a, "query @cached(ttl: 30) { domain(limit: 1) { id } }");
    try testing.expectEqualStrings("no-store", failed.header("cache-control").?);
    try testing.expect(failed.contains("database unavailable"));
    try expectJson(try app.postQuery(a, "query @cached(ttl: 30) { domain(limit: 1) { id } }"), 200, "{\"data\":{\"domain\":[]}}");
    try testing.expectEqual(@as(u32, 2), app.db.count());
}

test "an unpaired surrogate in the query text is graphql-js's invalid character (400)" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.post(a, "{\"query\":\"{ domain(limit: 1) { id } } # \\udfff\"}"), 400, "{\"data\":null,\"errors\":[{\"message\":\"Syntax Error: Invalid character: U+DFFF.\",\"locations\":[{\"line\":1,\"column\":31}]}]}");
    try expectJson(try app.post(a, "{\"query\":\"{ domain(where: {name: {_eq: \\\"a\\ud800\\\"}}) { id } }\"}"), 400, "{\"data\":null,\"errors\":[{\"message\":\"Syntax Error: Invalid character within String: U+D800.\",\"locations\":[{\"line\":1,\"column\":32}]}]}");
    // Columns count UTF-16 units: é is 1, 😀 is 2 (graphql-js).
    try expectJson(try app.post(a, "{\"query\":\"# \\u00e9\\ud83d\\ude00\\udfff\"}"), 400, "{\"data\":null,\"errors\":[{\"message\":\"Syntax Error: Invalid character: U+DFFF.\",\"locations\":[{\"line\":1,\"column\":6}]}]}");
    try expectJson(try app.post(a, "{\"query\":\"{ a(b: \\\"\\u00e9\\ud83d\\ude00\\ud800\\\") }\"}"), 400, "{\"data\":null,\"errors\":[{\"message\":\"Syntax Error: Invalid character within String: U+D800.\",\"locations\":[{\"line\":1,\"column\":12}]}]}");
    // A surrogate pair is one valid character.
    try testing.expectEqual(@as(u16, 200), (try app.post(a, "{\"query\":\"{ domain(limit: 1) { id } } # \\ud83d\\ude00\"}")).status);
}

// ---- deep custom-scalar output (DEVIATIONS.md): TS's JSON.stringify overflows ----

test "a response nested response_depth_limit deep fails like TS's JSON.stringify" {
    const values = @import("values.zig");
    // {"data":{"raw_message_dispatch":[{"msg_body":X}]}}: X's outermost
    // array is at depth 5, so n nested arrays reach depth 4 + n.
    for ([_]struct { n: usize, overflow: bool }{
        .{ .n = values.response_depth_limit - 5, .overflow = false },
        .{ .n = values.response_depth_limit - 4, .overflow = true },
        .{ .n = values.response_depth_limit + 1000, .overflow = true },
    }) |c| {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const open = try a.alloc(u8, c.n);
        @memset(open, '[');
        const close = try a.alloc(u8, c.n);
        @memset(close, ']');
        var app: App = .{};
        app.db.rows = try std.fmt.allocPrint(a, "[{{\"id\":\"1\",\"msg_body\":{s}0{s}}}]", .{ open, close });
        try app.start();
        defer app.stop();
        for ([_][]const u8{ "{ raw_message_dispatch(limit: 1) { msg_body } }", "query @cached(ttl: 30) { raw_message_dispatch(limit: 1) { msg_body } }" }) |q| {
            const resp = try app.postQuery(a, q);
            if (c.overflow) {
                try expectJson(resp, 200, "{\"data\":null,\"errors\":[{\"message\":\"Maximum call stack size exceeded\"}]}");
                if (std.mem.indexOf(u8, q, "@cached") != null) try testing.expectEqualStrings("no-store", resp.header("cache-control").?);
            } else {
                try testing.expectEqual(@as(u16, 200), resp.status);
                try testing.expect(std.mem.startsWith(u8, resp.body, "{\"data\":{\"raw_message_dispatch\":[{\"msg_body\":[[["));
            }
        }
    }
}

test "keeps incomplete uploads outside GraphQL execution admission" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var sockets: [25]Client = undefined;
    for (&sockets) |*s| {
        s.* = try app.connect();
        try s.send("POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    }
    defer for (&sockets) |*s| s.close();
    try waitUploads(&app.route, 25, 5_000);
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqual(@as(u16, 200), (try app.postQuery(arena.allocator(), "{ domain(limit: 1) { id } }")).status);
}

test "bounds near-limit uploads and recovers capacity after cancellation and parsing errors" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const payload = try a.alloc(u8, 102_399);
    @memset(payload, ' ');
    payload[0] = '{';
    const head = "POST /GraphQL/ HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 102400\r\n\r\n";
    var sockets: [50]Client = undefined;
    var open: usize = 0;
    defer for (sockets[0..open]) |*s| s.close();
    for (&sockets) |*s| {
        s.* = try app.connect();
        open += 1;
        try s.send(head);
        try s.send(payload);
    }
    try waitUploads(&app.route, 50, 5_000);
    for (0..4) |_| {
        var extra = try app.connect();
        defer extra.close();
        try extra.send("POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 102400\r\n\r\n");
        extra.send(payload) catch {};
        const r = try extra.read(a);
        try testing.expectEqual(@as(u16, 503), r.status);
        try testing.expectEqualStrings("close", r.header("connection").?);
        try testing.expect(extra.closedByPeer());
    }
    try testing.expectEqual(@as(u16, 503), (try app.postQuery(a, "{ domain(limit: 1) { id } }")).status);
    try testing.expectEqual(@as(u32, 0), app.db.count());
    try testing.expectEqual(@as(u16, 200), (try app.get(a, "query=%7B+domain%28limit%3A+1%29+%7B+id+%7D+%7D", true)).status);

    // Completing an invalid body releases its upload slot despite parser failure.
    try sockets[0].send("]");
    _ = try sockets[0].read(a);
    try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, "{ domain(limit: 1) { id } }")).status);

    // Aborted uploads also return capacity; completed requests can reuse it.
    for (sockets[0..open]) |*s| s.close();
    open = 0;
    try waitUploads(&app.route, 0, 5_000);
    for (0..51) |_| try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, "{ domain(limit: 1) { id } }")).status);
}

test "the deepest admitted request runs on a real poller stack" {
    // `_not` through variables is the deepest request the guards admit
    // (not_depth - 1 levels, see values.coerce_budget). stack_test measures it
    // on a private thread; this runs it where production does, on an
    // http.Server poller (loop.poller_stack_bytes). One level more must
    // answer, not crash.
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const limit = @import("values.zig").coerce_budget.not_depth;
    for ([_]usize{ limit - 1, limit }) |levels| {
        var w: std.Io.Writer.Allocating = .init(a);
        try w.writer.writeAll("{\"query\":\"query ($w: domain_bool_exp) { domain(where: $w) { id } }\",\"variables\":{\"w\":");
        for (0..levels) |_| try w.writer.writeAll("{\"_not\":");
        try w.writer.writeAll("{\"id\":{\"_eq\":1}}");
        for (0..levels) |_| try w.writer.writeByte('}');
        try w.writer.writeAll("}}");
        const resp = try app.post(a, w.written());
        if (levels < limit) {
            // Coerced in full, then refused by the resolver's own depth rule.
            try expectJson(resp, 200, "{\"data\":null,\"errors\":[{\"message\":\"where exceeds maximum depth of 8\",\"locations\":[{\"line\":1,\"column\":31}],\"path\":[\"domain\"]}]}");
        } else {
            // TS's variable-coercion overflow: 400, message only.
            try expectJson(resp, 400, "{\"data\":null,\"errors\":[{\"message\":\"Maximum call stack size exceeded\"}]}");
        }
    }
    try expectJson(try app.postQuery(a, "{ domain(limit: 1) { id } }"), 200, "{\"data\":{\"domain\":[]}}");
}

// ---- scraperdb/schema.test.ts execution cases ----

test "accepts literal and variable null optional arguments" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.postQuery(a, "{ domain(limit: null, offset: null, order_by: { id: null }) { id } }"), 200, "{\"data\":{\"domain\":[]}}");
    try expectJson(try app.post(a, "{\"query\":\"query Nullable($limit: Int, $offset: Int, $order: domain_order_by!) { domain(limit: $limit, offset: $offset, order_by: [$order]) { id } }\",\"variables\":{\"limit\":null,\"offset\":null,\"order\":{\"id\":null}}}"), 200, "{\"data\":{\"domain\":[]}}");
}

test "rejects an empty message cursor through the resolver" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const r = try app.postQuery(arena.allocator(), "{ message_view(cursor: [{initial_value: {}}]) { id } }");
    try testing.expectEqual(@as(u16, 200), r.status);
    try testing.expect(r.contains("must contain one column"));
    try testing.expect(r.contains("\"path\":[\"message_view\"]"));
}

test "keeps canonical aliases when a provisional snapshot exceeds the cap" {
    var app: App = .{};
    app.db.rows = "[{\"id\":\"1\"}]";
    app.db.rows_by_sql = &.{.{ .needle = "custom_frontier", .rows = "[{\"message_ids\":null}]" }};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const r = try app.postQuery(arena.allocator(), "{ canonical: message_view(limit: 3) { id } provisional: message_view(confirmations: 0, where: {is_provisional: {_eq: true}}) { id } }");
    try testing.expectEqual(@as(u16, 200), r.status);
    try testing.expect(std.mem.startsWith(u8, r.body, "{\"data\":{\"canonical\":[{\"id\":\"1\"}],\"provisional\":null},\"errors\":[{\"message\":\"Confirmation snapshot exceeds 10000 affected events"));
    try testing.expect(r.contains("\"path\":[\"provisional\"]"));
}

test "diagnostics resolvers report DIAGNOSTICS_UNAVAILABLE when not configured" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.postQuery(a, "{ domain { id } message_activity(message_id: \"x\") { has_more } }"), 200, "{\"data\":null,\"errors\":[{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":17}],\"path\":[\"message_activity\"],\"extensions\":{\"code\":\"DIAGNOSTICS_UNAVAILABLE\"}}]}");
}

test "a type-system extension in a request is reported at its `extend` keyword (ExecutableDefinitions)" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectJson(try app.postQuery(a, "{ __typename } extend type domain { z: Int }"), 400, "{\"data\":null,\"errors\":[{\"message\":\"The \\\"domain\\\" definition is not executable.\",\"locations\":[{\"line\":1,\"column\":16}]}]}");
    try expectJson(try app.postQuery(a, "{ __typename }\n  extend schema { mutation: domain }"), 400, "{\"data\":null,\"errors\":[{\"message\":\"The schema definition is not executable.\",\"locations\":[{\"line\":2,\"column\":3}]}]}");
}

test "history reads: unsupported filters, orders and arguments fail before any query (module.test.ts)" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_][]const u8{
        "{ message_view(where: {is_delivered: {_eq: true}}, limit: 1) { id } }",
        "{ message_view(confirmations: 0, where: {_or: [{is_provisional: {_eq: true}}, {is_delivered: {_eq: false}}]}) { id } }",
        "{ message_view_aggregate(where: {_or: [{id: {_eq: \"1\"}}, {}]}) { nodes { id } aggregate { count } } }",
        "{ message_view_aggregate(where: {msg_id: {_eq: null}}) { nodes { id } } }",
        "{ message_view(where: {total_payment: {_gt: \"0\"}}) { id } }",
        "{ message_view(order_by: {nonce: desc}) { id } }",
        "{ message_view(order_by: {send_occurred_at: desc}) { id } }",
        "{ message_view(distinct_on: [sender]) { id } }",
        "{ raw_message_dispatch(where: {msg_body: {_eq: \"hello\"}}) { id } }",
        "{ raw_message_dispatch(offset: 1) { id } }",
    }) |query| {
        const r = try app.postQuery(a, query);
        testing.expect(r.contains("\"errors\":[")) catch |err| {
            std.debug.print("no errors for {s}: {s}\n", .{ query, r.body });
            return err;
        };
    }
    try testing.expectEqual(@as(u32, 0), app.db.count());
}

test "history reads: Explorer's 500-row pending page, a transaction page and the domain catalog (module.test.ts)" {
    var app: App = .{};
    var domains: std.ArrayList(u8) = .empty;
    defer domains.deinit(testing.allocator);
    try domains.append(testing.allocator, '[');
    for (0..207) |id| try domains.print(testing.allocator, "{s}{{\"id\":{d}}}", .{ if (id == 0) "" else ",", id });
    try domains.append(testing.allocator, ']');
    app.db.rows_by_sql = &.{.{ .needle = "FROM \"domain\"", .rows = domains.items }};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try app.postQuery(a, "query { pendingCandidates: message_view(order_by: {id: desc}, limit: 500) { id is_delivered } transactionMessages: message_view(where: {origin_tx_hash: {_eq: \"\\\\x" ++ "ab" ** 32 ++ "\"}}, order_by: {nonce: asc}, limit: 500) { id } domain { id } }");
    try testing.expectEqual(@as(u16, 200), r.status);
    testing.expect(!r.contains("\"errors\"")) catch |err| {
        std.debug.print("{s}\n", .{r.body});
        return err;
    };
    try testing.expect(r.contains(domains.items));
    // Root fields run concurrently: every query's LIMIT is 500, in any order.
    try testing.expectEqual(@as(usize, 3), app.db.tail_numbers_len);
    for (app.db.tail_numbers[0..3]) |limit| try testing.expectEqual(@as(f64, 500), limit);
}

test "history reads: bound values reach EXPLAIN; over-budget and missing plans fail closed (module.test.ts)" {
    var app: App = .{};
    app.db.rows = "[{\"id\":\"123\",\"is_delivered\":true}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const body = "{\"query\":\"query($id: bigint!){ message_view(where: {id: {_eq: $id}}, limit: 1) { id is_delivered } }\",\"variables\":{\"id\":\"123\"}}";
    const over = "{\"data\":{\"message_view\":null},\"errors\":[{\"message\":\"History query exceeds the database planning budget\",\"locations\":[{\"line\":1,\"column\":22}],\"path\":[\"message_view\"]}]}";
    for ([_]?f64{ 100_001, null, 1 }, 0..) |cost, i| {
        app.db.mutex.lock();
        app.db.explain_cost = cost;
        app.db.mutex.unlock();
        try expectJson(try app.post(a, body), 200, if (i < 2) over else "{\"data\":{\"message_view\":[{\"id\":\"123\",\"is_delivered\":true}]}}");
    }
    app.db.mutex.lock();
    defer app.db.mutex.unlock();
    try testing.expectEqual(@as(usize, 4), app.db.calls_len);
    for (app.db.calls[0..4]) |*c| try testing.expectEqualStrings("[\"123\",1]", c.params());
    try testing.expectEqualStrings(try std.mem.concat(a, u8, &.{ "EXPLAIN (FORMAT JSON) ", app.db.calls[3].sql() }), app.db.calls[2].sql());
}

test "history reads: aliases share one planning budget; the next request gets a fresh one (module.test.ts)" {
    var app: App = .{};
    app.db.explain_cost = 100_000;
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for (1..3) |i| {
        const r = try app.postQuery(a, "{ a: message_view { id } b: message_view { id } c: message_view { id } }");
        try testing.expectEqual(@as(u16, 200), r.status);
        try testing.expect(r.contains("\"errors\":[{\"message\":\"GraphQL operation exceeds its database planning budget\""));
        try testing.expectEqual(@as(u32, @intCast(i * 2)), app.db.count());
    }
    // Domain reads are not planned (TS `select('domain')` skips EXPLAIN).
    app.db.mutex.lock();
    const explains = app.db.explains;
    app.db.mutex.unlock();
    try expectJson(try app.postQuery(a, "{ domain { id } }"), 200, "{\"data\":{\"domain\":[]}}");
    app.db.mutex.lock();
    defer app.db.mutex.unlock();
    try testing.expectEqual(explains, app.db.explains);
}
test "history reads: policy rejections are synchronous throws (graphql-js executeFields)" {
    var app: App = .{};
    app.db.rows = "[{\"id\":\"1\"}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ordering = "Use ID ordering for history, nonce for an identifier, or send time for a provisional-only feed";
    const aggregate = "History aggregates require an exact message or transaction identifier";
    // A nullable rejection is recorded before an I/O-free async failure.
    try expectJson(
        try app.postQuery(a, "{ a: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: 2000) { id } b: message_view(order_by: {nonce: desc}) { id } }"),
        200,
        "{\"data\":{\"a\":null,\"b\":null},\"errors\":[{\"message\":\"" ++ ordering ++ "\",\"locations\":[{\"line\":1,\"column\":79}],\"path\":[\"b\"]},{\"message\":\"confirmations exceeds maximum of 1000\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]}]}",
    );
    // A non-null rejection ends the loop; earlier fields settle first
    // (`promiseForObject(results).finally(() => { throw error; })`).
    try expectJson(
        try app.postQuery(a, "{ a: message_view(order_by: {nonce: desc}) { id } b: message_view_aggregate { nodes { id } } }"),
        200,
        "{\"data\":null,\"errors\":[{\"message\":\"" ++ ordering ++ "\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]},{\"message\":\"" ++ aggregate ++ "\",\"locations\":[{\"line\":1,\"column\":51}],\"path\":[\"b\"]}]}",
    );
    app.db.fail_sql = "msg_id";
    try expectJson(
        try app.postQuery(a, "{ a: message_view(where: {msg_id: {_eq: \"0x01\"}}) { id } b: message_view_aggregate { nodes { id } } }"),
        200,
        "{\"data\":null,\"errors\":[{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]},{\"message\":\"" ++ aggregate ++ "\",\"locations\":[{\"line\":1,\"column\":58}],\"path\":[\"b\"]}]}",
    );
    // An earlier non-null failure rejects first; `finally` replaces its error.
    app.db.fail_sql = "\"domain\"";
    try expectJson(
        try app.postQuery(a, "{ a: domain(limit: 1) { id } b: message_view_aggregate { nodes { id } } }"),
        200,
        "{\"data\":null,\"errors\":[{\"message\":\"" ++ aggregate ++ "\",\"locations\":[{\"line\":1,\"column\":30}],\"path\":[\"b\"]}]}",
    );
}
test "GET variables that are not an object, array or null fail graphql-js's execution-argument check" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const not_object = "{\"data\":null,\"errors\":[{\"message\":\"Variables must be provided as an Object where each property is a variable value. Perhaps look to see if an unparsed JSON string was provided.\"}]}";
    // The raw empty string, and JSON that parses to a string, number or boolean.
    for ([_][]const u8{ "", "%22x%22", "1", "0", "false", "true", "%22%22" }) |v| {
        try expectJson(try app.get(a, try std.fmt.allocPrint(a, "query=%7B__typename%7D&variables={s}", .{v}), true), 200, not_object);
    }
    // null, an object or an array pass the check (POST bodies are schema-checked instead).
    for ([_][]const u8{ "null", "%7B%7D", "%5B%5D" }) |v| {
        try expectJson(try app.get(a, try std.fmt.allocPrint(a, "query=%7B__typename%7D&variables={s}", .{v}), true), 200, "{\"data\":{\"__typename\":\"query_root\"}}");
    }
}

test "a non-null root field failing synchronously starts no later root field (graphql-js executeFields)" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const unavailable = "{\"message\":\"Diagnostics are not configured\",\"locations\":[{\"line\":1,\"column\":";
    // message_activity throws before any promise (TS): the fields after it never start.
    var r = try app.postQuery(a, "{ message_activity(message_id: \"x\") { has_more } d: domain { id } r: raw_message_dispatch(limit: 1) { id } }");
    try testing.expect(std.mem.startsWith(u8, r.body, "{\"data\":null,\"errors\":[" ++ unavailable ++ "3}]"));
    try testing.expectEqual(@as(u32, 0), app.db.count());
    // The field before it has already started and still runs; only the sync error is reported.
    r = try app.postQuery(a, "{ d: domain { id } message_activity(message_id: \"x\") { has_more } r: raw_message_dispatch(limit: 1) { id } }");
    try testing.expect(std.mem.startsWith(u8, r.body, "{\"data\":null,\"errors\":[" ++ unavailable ++ "20}]"));
    try testing.expectEqual(@as(u32, 1), app.db.count());
    // message_diagnostics is async in TS (a rejection): later fields start.
    r = try app.postQuery(a, "{ message_diagnostics(message_id: \"x\") { partial } d: domain { id } }");
    try testing.expect(std.mem.startsWith(u8, r.body, "{\"data\":null,\"errors\":[" ++ unavailable ++ "3}]"));
    try testing.expectEqual(@as(u32, 2), app.db.count());
}

test "concurrent root fields collect errors in settle order (graphql-js)" {
    var app: App = .{};
    // x settles last (delayed I/O), z settles first; both nullable I/O failures.
    app.db.delay_sql = "LIMIT $2";
    app.db.fail_sql = "message_view";
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try app.postQuery(a, "{ x: message_view(where: {msg_id: {_eq: \"0x01\"}}, limit: 1) { id } d: domain(limit: 1) { id } z: message_view(limit: 1) { id } }");
    try expectJson(r, 200, "{\"data\":{\"x\":null,\"d\":[{\"id\":7}],\"z\":null},\"errors\":[{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":95}],\"path\":[\"z\"]},{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"x\"]}]}");
}

test "I/O-free failures settle before I/O failures" {
    var app: App = .{};
    app.db.fail_sql = "message_view";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Nullable I/O error first in the document, nullable assertion second.
    try expectJson(try app.postQuery(a, "{ a: message_view(limit: 1) { id } b: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: 1001) { id } }"), 200, "{\"data\":{\"a\":null,\"b\":null},\"errors\":[{\"message\":\"confirmations exceeds maximum of 1000\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"b\"]},{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]}]}");
    // A non-null assertion ends collection before the I/O error settles.
    try expectJson(try app.postQuery(a, "{ a: message_view(limit: 1) { id } b: domain(limit: 501) { id } }"), 200, "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"b\"]}]}");
    // Nullable I/O-free errors are collected before the non-null one.
    try expectJson(try app.postQuery(a, "{ a: domain(limit: 501) { id } b: message_view(where: {msg_id: {_eq: \"0x01\"}}, confirmations: 1001) { id } }"), 200, "{\"data\":null,\"errors\":[{\"message\":\"confirmations exceeds maximum of 1000\",\"locations\":[{\"line\":1,\"column\":32}],\"path\":[\"b\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]}]}");
}

test "concurrent root fields stop at the first non-null failure" {
    var app: App = .{};
    app.db.fail_sql = "raw_message_dispatch";
    app.db.delay_sql = "DESC";
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try app.postQuery(a, "{ a: domain(limit: 1) { id } b: raw_message_dispatch(limit: 1) { id } c: raw_message_dispatch(limit: 2, order_by: {id: desc}) { id } }");
    try expectJson(r, 200, "{\"data\":null,\"errors\":[{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":30}],\"path\":[\"b\"]}]}");
}

fn evictDocuments(route: *route_mod.GraphqlRoute) void {
    route.documents.evictAll();
}

test "cached document outlives response serialization (eviction during a request)" {
    var poison: PoisonAllocator = .{ .child = testing.allocator };
    var app: App = .{ .gpa = poison.allocator() };
    app.db.rows = "[{\"id\":1,\"name\":\"ethereum\"}]";
    try app.start();
    defer app.stop();
    // Evict (and, without a request reference, free) the document after
    // execution but before serialization; response keys live in its arena.
    app.route.after_execute_hook = evictDocuments;
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for (0..3) |_| {
        try expectJson(try app.postQuery(a, "{ first_alias: domain(limit: 1) { id renamed_name: name } second_alias: domain(limit: 2) { id } }"), 200, "{\"data\":{\"first_alias\":[{\"id\":1,\"renamed_name\":\"ethereum\"}],\"second_alias\":[{\"id\":1}]}}");
    }
}

test "concurrent first-time identical queries serialize intact" {
    var poison: PoisonAllocator = .{ .child = testing.allocator };
    var app: App = .{ .gpa = poison.allocator() };
    app.db.rows = "[{\"id\":1,\"name\":\"ethereum\"}]";
    try app.start();
    defer app.stop();
    const expected = "{\"data\":{\"alias_a\":[{\"id\":1,\"alias_name\":\"ethereum\"}],\"alias_b\":[{\"id\":1}]}}";
    const Worker = struct {
        fn run(ap: *App, query: []const u8, ok: *bool) void {
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            const r = ap.postQuery(arena.allocator(), query) catch return;
            ok.* = r.status == 200 and std.mem.eql(u8, r.body, expected);
        }
    };
    for (0..20) |round| {
        var buf: [256]u8 = undefined;
        // A never-seen query text each round (the comment differs).
        const query = try std.fmt.bufPrint(&buf, "{{ alias_a: domain(limit: 1) {{ id alias_name: name }} alias_b: domain(limit: 2) {{ id }} }} # {d}", .{round});
        var threads: [8]std.Thread = undefined;
        var oks = [_]bool{false} ** 8;
        for (&threads, &oks) |*t, *ok| t.* = try std.Thread.spawn(.{}, Worker.run, .{ &app, query, ok });
        for (threads) |t| t.join();
        for (oks) |ok| try testing.expect(ok);
    }
}

fn activeUploads(route: *route_mod.GraphqlRoute) u32 {
    return route.active_uploads.load(.monotonic);
}

fn waitUploads(route: *route_mod.GraphqlRoute, want: u32, timeout_ms: u64) !void {
    var waited: u64 = 0;
    while (activeUploads(route) != want) : (waited += 10) {
        if (waited > timeout_ms) {
            std.debug.print("active_uploads {d}, want {d}\n", .{ activeUploads(route), want });
            return error.UploadSlotLeak;
        }
        std.Thread.sleep(10 * std.time.ns_per_ms);
    }
}

test "upload slots return after a client aborts mid-body" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    for (0..5) |_| {
        var c = try app.connect();
        try c.send("POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"query\":");
        try waitUploads(&app.route, 1, 2_000);
        c.close();
        try waitUploads(&app.route, 0, 2_000);
    }
}

test "a stalled upload keeps its slot past requestTimeout until the client closes (Node parity)" {
    // Node applies requestTimeout to the request head only; a stalled body
    // never times out, so the upload slot is held until the socket closes.
    var app: App = .{ .request_timeout_ms = 200 };
    try app.start();
    defer app.stop();
    var c = try app.connect();
    try c.send("POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"query\":");
    try waitUploads(&app.route, 1, 2_000);
    std.Thread.sleep(500 * std.time.ns_per_ms);
    try testing.expectEqual(@as(u32, 1), activeUploads(&app.route));
    c.close();
    try waitUploads(&app.route, 0, 2_000);
}

// ---- single-flight (DEVIATIONS.md): concurrent misses on one @cached key ----

/// One request on its own connection: status, cache-control and body.
const FlightResult = struct {
    status: u16 = 0,
    cache_control: [64]u8 = undefined,
    cache_control_len: usize = 0,
    body: [256]u8 = undefined,
    body_len: usize = 0,
    /// `content-type` comes before `cache-control` (a miss's header order).
    miss_order: bool = false,
    /// The response head with its `Date` value masked.
    head: [512]u8 = undefined,
    head_len: usize = 0,
    err: ?anyerror = null,

    fn run(self: *FlightResult, ap: *App, query: []const u8) void {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const r = ap.postQueryParked(arena.allocator(), query) catch |e| {
            self.err = e;
            return;
        };
        self.status = r.status;
        var masked: std.ArrayList(u8) = .empty;
        var lines = std.mem.splitSequence(u8, r.head, "\r\n");
        while (lines.next()) |line| {
            masked.appendSlice(arena.allocator(), if (std.ascii.startsWithIgnoreCase(line, "date:")) "Date: <masked>" else line) catch return;
            masked.appendSlice(arena.allocator(), "\r\n") catch return;
        }
        self.head_len = @min(masked.items.len, self.head.len);
        @memcpy(self.head[0..self.head_len], masked.items[0..self.head_len]);
        if (std.ascii.indexOfIgnoreCase(r.head, "content-type:")) |ct| {
            if (std.ascii.indexOfIgnoreCase(r.head, "cache-control:")) |cc_at| self.miss_order = ct < cc_at;
        }
        const cc = r.header("cache-control") orelse "";
        self.cache_control_len = @min(cc.len, self.cache_control.len);
        @memcpy(self.cache_control[0..self.cache_control_len], cc[0..self.cache_control_len]);
        self.body_len = @min(r.body.len, self.body.len);
        @memcpy(self.body[0..self.body_len], r.body[0..self.body_len]);
    }

    fn expect(self: *const FlightResult, status: u16, cache_control: []const u8, body: []const u8) !void {
        if (self.err) |e| return e;
        try testing.expectEqual(status, self.status);
        try testing.expectEqualStrings(cache_control, self.cache_control[0..self.cache_control_len]);
        try testing.expectEqualStrings(body, self.body[0..self.body_len]);
    }
};

/// Requests on their own threads (and connections).
const Flock = struct {
    threads: []std.Thread,
    results: []FlightResult,

    fn start(ap: *App, n: usize, query: []const u8) !Flock {
        const threads = try testing.allocator.alloc(std.Thread, n);
        const results = try testing.allocator.alloc(FlightResult, n);
        for (results) |*r| r.* = .{};
        for (threads, results) |*t, *r| t.* = try std.Thread.spawn(.{}, FlightResult.run, .{ r, ap, query });
        return .{ .threads = threads, .results = results };
    }

    fn join(self: Flock) void {
        for (self.threads) |t| t.join();
    }

    fn deinit(self: Flock) void {
        testing.allocator.free(self.threads);
        testing.allocator.free(self.results);
    }
};

fn waitFlightWaiters(route: *route_mod.GraphqlRoute, want: u32) !void {
    var waited: u64 = 0;
    while (route.flight_waiters.load(.monotonic) != want) : (waited += 1) {
        if (waited > 10_000) {
            std.debug.print("flight waiters: {d}, want {d}\n", .{ route.flight_waiters.load(.monotonic), want });
            return error.Timeout;
        }
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

const flight_query = "query @cached(ttl: 300) { domain(limit: 1) { id } }";
const flight_body = "{\"data\":{\"domain\":[{\"id\":7}]}}";

test "single-flight: concurrent misses on one key run one query, same bytes" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, 40, flight_query);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, 40);
    // Parked waiters hold no execution slot, and the active-requests gauge
    // stays the admission count (DEVIATIONS.md: TS would count all 41).
    try testing.expectEqual(@as(u32, 1), app.route.active_requests.load(.monotonic));
    try testing.expectEqual(@as(f64, 1), core.metrics.graphql_active_requests.get(.{}));
    app.db.release();
    leader.join();
    waiters.join();
    try leader.results[0].expect(200, "max-age=300, public", flight_body);
    for (waiters.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    try testing.expectEqual(@as(u32, 1), app.db.count());
    try testing.expectEqual(@as(u32, 0), app.route.flight_waiters.load(.monotonic));
}

test "single-flight: a failed leader's waiters each run their own query" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    app.db.fail = "database unavailable";
    app.db.fail_first_only = true;
    try app.start();
    defer app.stop();
    app.db.block();
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, 10, flight_query);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, 10);
    app.db.release();
    leader.join();
    waiters.join();
    try leader.results[0].expect(200, "no-store", "{\"data\":null,\"errors\":[{\"message\":\"database unavailable\",\"locations\":[{\"line\":1,\"column\":27}],\"path\":[\"domain\"]}]}");
    // Not cached: waiters read once, and each that misses runs its own query
    // (like TS); one that reads after another waiter's write gets that hit.
    for (waiters.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    try testing.expect(app.db.count() >= 2 and app.db.count() <= 11);
}

test "single-flight: after a failed miss, the key's next misses run at once (TS concurrency)" {
    var app: App = .{};
    app.db.fail = "database unavailable";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const failed = try app.postQuery(arena.allocator(), flight_query);
    try testing.expectEqualStrings("no-store", failed.header("cache-control").?);
    // Within the mark's second: concurrent misses all reach the database.
    app.db.block();
    const burst = try Flock.start(&app, 6, flight_query);
    defer burst.deinit();
    app.db.waitStarted(7);
    try testing.expectEqual(@as(u32, 0), app.route.flight_waiters.load(.monotonic));
    app.db.release();
    burst.join();
    for (burst.results) |*r| try testing.expectEqual(@as(u16, 200), r.status);
    try testing.expectEqual(@as(u32, 7), app.db.count());
}

test "single-flight: an uncacheable (oversized) response sends waiters to their own query" {
    var app: App = .{};
    const big = try testing.allocator.alloc(u8, 1_100_000);
    defer testing.allocator.free(big);
    @memset(big, 'x');
    const rows = try std.fmt.allocPrint(testing.allocator, "[{{\"id\":7,\"name\":\"{s}\"}}]", .{big});
    defer testing.allocator.free(rows);
    app.db.rows = rows;
    try app.start();
    defer app.stop();
    app.db.block();
    const q = "query @cached(ttl: 300) { domain(limit: 1) { id name } }";
    const leader = try Flock.start(&app, 1, q);
    defer leader.deinit();
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, 5, q);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, 5);
    app.db.release();
    leader.join();
    waiters.join();
    // (The test client's buffer is smaller than these responses: only the
    // query count is checked.) Never cached, so every waiter ran its own.
    try testing.expectEqual(@as(u32, 6), app.db.count());
}

test "single-flight: only requests with the same ttl share a flight" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    const leader = try Flock.start(&app, 1, "query @cached(ttl: 30) { domain(limit: 1) { id } }");
    defer leader.deinit();
    app.db.waitStarted(1);
    // Same cache key (it leaves out @cached), another ttl: not a waiter on
    // the ttl-30 flight but its own query (a TS miss answers its own max-age).
    const other = try Flock.start(&app, 1, flight_query);
    defer other.deinit();
    app.db.waitStarted(2);
    try testing.expectEqual(@as(u32, 0), app.route.flight_waiters.load(.monotonic));
    app.db.release();
    leader.join();
    other.join();
    try leader.results[0].expect(200, "max-age=30, public", flight_body);
    try other.results[0].expect(200, "max-age=300, public", flight_body);
    try testing.expectEqual(@as(u32, 2), app.db.count());
}

test "single-flight: refresh and ttl 0 requests never wait on a flight" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(1);
    // Same key (the key strips @cached): each runs its own query at once.
    const refresh = try Flock.start(&app, 1, "query @cached(ttl: 300, refresh: true) { domain(limit: 1) { id } }");
    defer refresh.deinit();
    app.db.waitStarted(2);
    const no_store = try Flock.start(&app, 1, "query @cached(ttl: 0) { domain(limit: 1) { id } }");
    defer no_store.deinit();
    app.db.waitStarted(3);
    try testing.expectEqual(@as(u32, 0), app.route.flight_waiters.load(.monotonic));
    app.db.release();
    leader.join();
    refresh.join();
    no_store.join();
    try leader.results[0].expect(200, "max-age=300, public", flight_body);
    try refresh.results[0].expect(200, "max-age=300, public", flight_body);
    try no_store.results[0].expect(200, "no-store", flight_body);
    try testing.expectEqual(@as(u32, 3), app.db.count());
}

test "single-flight: past the waiter cap, misses run their own query" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    const cap = 8;
    app.route.response_cache.max_waiters = cap;
    app.db.block();
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, cap, flight_query);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, cap);
    const extra = try Flock.start(&app, 3, flight_query);
    defer extra.deinit();
    app.db.waitStarted(4);
    try testing.expectEqual(@as(u32, cap), app.route.flight_waiters.load(.monotonic));
    app.db.release();
    leader.join();
    waiters.join();
    extra.join();
    for (leader.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    for (waiters.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    for (extra.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    try testing.expectEqual(@as(u32, 4), app.db.count());
}

test "single-flight: the leader's client going away sends its waiters to their own queries" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const body = try std.fmt.allocPrint(arena.allocator(), "{{\"query\":{f}}}", .{Value{ .string = flight_query }});
    var c = try app.connect();
    try c.send(try std.fmt.allocPrint(arena.allocator(), "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{s}", .{ body.len, body }));
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, 8, flight_query);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, 8);
    c.closeWithReset();
    // The close ends the flight unwritten (TS's onSend after 'close' caches
    // nothing), so each waiter runs its own query, as TS's concurrent misses
    // did, while the leader's query is still blocked.
    app.db.waitStarted(9);
    app.db.release();
    waiters.join();
    for (waiters.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    try testing.expectEqual(@as(u32, 9), app.db.count());
}

var flight_clock = struct {
    base: std.atomic.Value(i64) = .init(0),
    /// Calls left at `base`; after that, `base + later_ms`.
    at_base: std.atomic.Value(i32) = .init(1 << 30),
    later_ms: i64 = 0,
}{};

fn flightNow() i64 {
    const base = flight_clock.base.load(.monotonic);
    if (flight_clock.at_base.fetchSub(1, .monotonic) > 0) return base;
    return base + flight_clock.later_ms;
}

test "single-flight: a waiter answers as the TS miss it stands for (own ttl, miss header order)" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    flight_clock.base.store(1_000_000, .monotonic);
    flight_clock.later_ms = 1_000;
    flight_clock.at_base.store(1 << 30, .monotonic);
    app.route.response_cache.now_ms = flightNow;
    app.db.block();
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, 4, flight_query);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, 4);
    // The entry is written at `base`; waiters read it 1 s later and still
    // answer their own ttl (a TS miss), in a miss's header order; a later
    // plain hit answers the remaining seconds, cache-control first.
    flight_clock.at_base.store(1, .monotonic);
    app.db.release();
    leader.join();
    waiters.join();
    try leader.results[0].expect(200, "max-age=300, public", flight_body);
    try testing.expect(leader.results[0].miss_order);
    for (waiters.results) |*r| {
        try r.expect(200, "max-age=300, public", flight_body);
        try testing.expect(r.miss_order);
        // The whole head (Date masked) is the leader's, a miss's.
        try testing.expectEqualStrings(leader.results[0].head[0..leader.results[0].head_len], r.head[0..r.head_len]);
    }
    const hit = try Flock.start(&app, 1, flight_query);
    defer hit.deinit();
    hit.join();
    try hit.results[0].expect(200, "max-age=299, public", flight_body);
    try testing.expect(!hit.results[0].miss_order);
    try testing.expectEqual(@as(u32, 1), app.db.count());
}

var flight_loops_mutex: std.Thread.Mutex = .{};
var flight_loops: [8]usize = undefined;
var flight_loops_len: usize = 0;

fn recordFlightLoop(_: *route_mod.GraphqlRoute) void {
    const f = core.fiber.current() orelse return;
    const loop = @intFromPtr(f.sched.ctx);
    flight_loops_mutex.lock();
    defer flight_loops_mutex.unlock();
    for (flight_loops[0..flight_loops_len]) |l| if (l == loop) return;
    if (flight_loops_len < flight_loops.len) {
        flight_loops[flight_loops_len] = loop;
        flight_loops_len += 1;
    }
}

test "single-flight: waiters on two event loops all wake (no lost wakeups)" {
    for (0..5) |_| {
        var app: App = .{ .loops = 2 };
        app.db.rows = "[{\"id\":7}]";
        try app.start();
        defer app.stop();
        flight_loops_len = 0;
        app.route.flight_park_hook = recordFlightLoop;
        app.db.block();
        const leader = try Flock.start(&app, 1, flight_query);
        defer leader.deinit();
        app.db.waitStarted(1);
        const waiters = try Flock.start(&app, 60, flight_query);
        defer waiters.deinit();
        try waitFlightWaiters(&app.route, 60);
        app.db.release();
        leader.join();
        waiters.join();
        for (leader.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
        for (waiters.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
        try testing.expectEqual(@as(u32, 1), app.db.count());
        try testing.expectEqual(@as(usize, 2), flight_loops_len);
    }
}

// ---- client abort (TS `complete()` on 'close'): the peer-close hook, called the way the
// HTTP layer will (on another thread while the handler is parked; never with onSend/onDone).

/// A request run through the route's hooks on its own thread (no socket),
/// so a test can call `on_peer_closed` while the handler is parked.
const Direct = struct {
    route: http.Route,
    /// The HTTP layer skips `on_send` after a peer close (one reading of
    /// its contract): `on_done` alone must still land a flight.
    skip_on_send_after_close: bool = true,
    closed: std.atomic.Value(bool) = .init(false),
    arena: std.heap.ArenaAllocator = .init(testing.allocator),
    req: http.Request = undefined,
    reply: http.Reply = undefined,
    thread: std.Thread = undefined,

    fn start(self: *Direct, query: []const u8) !void {
        const a = self.arena.allocator();
        const body = try std.fmt.allocPrint(a, "{{\"query\":{f}}}", .{Value{ .string = query }});
        const headers = try a.dupe(http.Header, &.{ .{ .name = "Host", .value = "x" }, .{ .name = "Content-Type", .value = "application/json" } });
        self.req = .{ .arena = a, .method = "POST", .url = "/graphql", .path = "/graphql", .query = "", .headers = headers, .remote_address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 1), .body = .{ .json = try core.json.parse(a, body, .{}) }, .raw_body = body, .complete = true };
        self.reply = .{ .arena = a };
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }

    fn run(self: *Direct) void {
        const h = self.route.hooks;
        h.on_request.?(self.route.ctx, &self.req, &self.reply);
        if (!self.reply.sent) h.handler(self.route.ctx, &self.req, &self.reply);
        if (!(self.skip_on_send_after_close and self.closed.load(.acquire))) h.on_send.?(self.route.ctx, &self.req, &self.reply);
        h.on_done.?(self.route.ctx, &self.req, &self.reply, .closed);
    }

    fn peerClosed(self: *Direct) void {
        self.closed.store(true, .release);
        self.route.hooks.on_peer_closed.?(self.route.ctx, &self.req, &self.reply);
    }

    fn finish(self: *Direct) void {
        self.thread.join();
        self.arena.deinit();
    }
};

fn successes() f64 {
    return core.metrics.graphql_requests.get(.{"success"});
}

/// "GraphQL request error" log lines (a `core.log` sink; tests run one at a time).
const ErrorLines = struct {
    var count: std.atomic.Value(u32) = .init(0);
    fn capture(_: ?*anyopaque, _: core.log.Level, _: []const u8, msg: []const u8) void {
        if (std.mem.indexOf(u8, msg, "GraphQL request error") != null) _ = count.fetchAdd(1, .monotonic);
    }
};

test "client abort: a query failing after the close counts no GraphQL error and logs none" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    core.log.setLevel(.warn);
    defer core.log.setLevel(.@"error");
    ErrorLines.count.store(0, .monotonic);
    core.log.setSink(ErrorLines.capture, null);
    defer core.log.setSink(null, null);
    app.db.block();
    var d: Direct = .{ .route = app.route.route() };
    const errors_before = core.metrics.graphql_errors.get(.{});
    const stats_before = app.route.stats.errors.load(.monotonic);
    const before = successes();
    try d.start("{ domain(limit: 1) { id } }");
    app.db.waitStarted(1);
    d.peerClosed();
    try testing.expectEqual(before + 1, successes());
    // The backend dies after the client left (e.g. pg_terminate_backend).
    app.db.mutex.lock();
    app.db.fail = "terminating connection due to administrator command";
    app.db.mutex.unlock();
    app.db.release();
    d.finish();
    // TS errorFormatter finds no request state after complete(): no count, no log.
    try testing.expectEqual(errors_before, core.metrics.graphql_errors.get(.{}));
    try testing.expectEqual(stats_before, app.route.stats.errors.load(.monotonic));
    try testing.expectEqual(@as(u32, 0), ErrorLines.count.load(.monotonic));
    try testing.expectEqual(before + 1, successes());
}

test "client abort: the slot is freed and the request recorded at close, once" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    app.db.block();
    var d: Direct = .{ .route = app.route.route() };
    const before = successes();
    try d.start("{ domain(limit: 1) { id } }");
    app.db.waitStarted(1);
    try testing.expectEqual(@as(u32, 1), app.route.active_requests.load(.monotonic));
    d.peerClosed();
    // TS frees the slot and records (status 200 so far) while the query runs.
    try testing.expectEqual(@as(u32, 0), app.route.active_requests.load(.monotonic));
    try testing.expectEqual(@as(f64, 0), core.metrics.graphql_active_requests.get(.{}));
    try testing.expectEqual(before + 1, successes());
    app.db.release();
    d.finish();
    // The handler's own completion records nothing more.
    try testing.expectEqual(before + 1, successes());
    try testing.expectEqual(@as(u32, 0), app.route.active_requests.load(.monotonic));
}

test "client abort: an aborted @cached miss is not cached" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    var d: Direct = .{ .route = app.route.route() };
    try d.start(flight_query);
    app.db.waitStarted(1);
    d.peerClosed();
    app.db.release();
    d.finish();
    // The next request is a miss (TS onSend found no state: no write).
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const r = try app.postQuery(arena.allocator(), flight_query);
    try testing.expectEqualStrings("max-age=300, public", r.header("cache-control").?);
    try testing.expectEqual(@as(u32, 2), app.db.count());
}

test "client abort: an aborted leader ends its flight; its waiters each run their own query" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    var d: Direct = .{ .route = app.route.route() };
    try d.start(flight_query);
    app.db.waitStarted(1);
    const waiters = try Flock.start(&app, 3, flight_query);
    defer waiters.deinit();
    try waitFlightWaiters(&app.route, 3);
    d.peerClosed();
    // Woken with nothing stored: each runs its own query (a TS miss), now
    // parked on the still-blocked database.
    app.db.waitStarted(4);
    try testing.expectEqual(@as(u32, 0), app.route.flight_waiters.load(.monotonic));
    app.db.release();
    d.finish();
    waiters.join();
    for (waiters.results) |*r| try r.expect(200, "max-age=300, public", flight_body);
    try testing.expectEqual(@as(u32, 4), app.db.count());
}

test "client abort: an aborted leader with on_send skipped ends its flight and caches nothing" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    var d: Direct = .{ .route = app.route.route(), .skip_on_send_after_close = true };
    try d.start(flight_query);
    app.db.waitStarted(1);
    d.peerClosed();
    app.db.release();
    d.finish();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    // The flight is gone (landed at close) and nothing was cached.
    try testing.expectEqualStrings("max-age=300, public", (try app.postQuery(arena.allocator(), flight_query)).header("cache-control").?);
    try testing.expectEqual(@as(u32, 2), app.db.count());
}

fn outcomes(name: []const u8) f64 {
    return core.metrics.graphql_requests.get(.{name});
}

test "client abort: closed before its first read decided, then refused the last slot: the 503 TS's preHandler would have counted" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    // R is admitted (slots free) and stops just before its first read.
    app.db.pre_io_sql = "\"name\"";
    var d: Direct = .{ .route = app.route.route() };
    try d.start("{ domain(limit: 1) { name } }");
    app.db.waitPreIo(1);
    // 25 others take every slot meanwhile.
    app.db.block_sql = "\"id\"";
    const fillers = try Flock.start(&app, 25, "{ domain(limit: 1) { id } }");
    defer fillers.deinit();
    app.db.waitStarted(25);
    const success = outcomes("success");
    const rejected = outcomes("capacity_rejected");
    d.peerClosed(); // undecided: not recorded yet
    try testing.expectEqual(success, outcomes("success"));
    app.db.releasePreIo(); // R's read loses the last slot
    d.finish();
    try testing.expectEqual(rejected + 1, outcomes("capacity_rejected"));
    try testing.expectEqual(success, outcomes("success"));
    app.db.release();
    fillers.join();
}

test "client abort: closed before its first read decided, then admitted: completed at that read with the close's status" {
    var app: App = .{};
    try app.start();
    defer app.stop();
    app.db.pre_io_sql = "\"name\"";
    app.db.block_sql = "\"name\"";
    var d: Direct = .{ .route = app.route.route() };
    try d.start("{ domain(limit: 1) { name } }");
    app.db.waitPreIo(1);
    const success = outcomes("success");
    d.peerClosed();
    try testing.expectEqual(success, outcomes("success"));
    app.db.releasePreIo();
    app.db.waitStarted(1); // its read took a slot, saw the close, gave it back
    try testing.expectEqual(success + 1, outcomes("success"));
    try testing.expectEqual(@as(u32, 0), app.route.active_requests.load(.monotonic));
    app.db.release();
    d.finish();
    try testing.expectEqual(success + 1, outcomes("success"));
}

test "client abort: a waiter parked on a flight is completed at the close (TS: a miss holding its slot)" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    app.db.block();
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(1);
    var d: Direct = .{ .route = app.route.route() };
    try d.start(flight_query);
    try waitFlightWaiters(&app.route, 1);
    const success = outcomes("success");
    d.peerClosed();
    try testing.expectEqual(success + 1, outcomes("success"));
    app.db.release();
    leader.join();
    d.finish(); // served the leader's entry; recorded nothing more
    try testing.expectEqual(success + 2, outcomes("success")); // + the leader
    try testing.expectEqual(@as(u32, 1), app.db.count());
}

var pause_gate = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    paused: bool = false,
    open: bool = false,
}{};

fn pauseAfterAdmission(_: *route_mod.GraphqlRoute) void {
    pause_gate.mutex.lock();
    defer pause_gate.mutex.unlock();
    pause_gate.paused = true;
    pause_gate.cond.broadcast();
    while (!pause_gate.open) pause_gate.cond.wait(&pause_gate.mutex);
}

test "client abort: closed after admission, before leading a flight: the flight it then leads ends in on_done" {
    var app: App = .{};
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    pause_gate = .{};
    app.route.after_admission_hook = pauseAfterAdmission;
    var d: Direct = .{ .route = app.route.route() }; // on_send skipped after the close
    const success = outcomes("success");
    try d.start(flight_query);
    {
        pause_gate.mutex.lock();
        defer pause_gate.mutex.unlock();
        while (!pause_gate.paused) pause_gate.cond.wait(&pause_gate.mutex);
    }
    d.peerClosed(); // admitted, no slot, no flight yet: nothing to land, not recorded
    try testing.expectEqual(success, outcomes("success"));
    app.route.after_admission_hook = null;
    {
        pause_gate.mutex.lock();
        defer pause_gate.mutex.unlock();
        pause_gate.open = true;
        pause_gate.cond.broadcast();
    }
    d.finish(); // leads, reads (completed at that read), on_send skipped, on_done lands
    try testing.expectEqual(success + 1, outcomes("success"));
    try testing.expectEqual(@as(u32, 0), app.route.active_requests.load(.monotonic));
    // The flight ended (a new request is not stranded on it: the key was marked
    // uncacheable for 1 s, so it runs as a plain miss) and nothing was cached.
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectEqualStrings("max-age=300, public", (try app.postQuery(arena.allocator(), flight_query)).header("cache-control").?);
    try testing.expectEqual(@as(u32, 2), app.db.count());
    try testing.expectEqual(@as(u32, 0), app.route.flight_waiters.load(.monotonic));
}

test "client abort: a closed waiter whose leader cached nothing runs its query without a slot (no 503 for the 25th live request)" {
    var app: App = .{};
    // Uncacheable: a null in a non-null field (an error, no-store).
    app.db.rows = "[{\"id\":null,\"name\":\"x\"}]";
    try app.start();
    defer app.stop();
    // Query order: 23 fillers, the leader, one more filler, the waiter's own query.
    app.db.gate(0, 1, 23);
    app.db.gate(1, 24, 24);
    app.db.gate(2, 25, 25);
    app.db.gate(3, 26, 26);
    const fillers = try Flock.start(&app, 23, "{ domain(limit: 1) { name } }");
    defer fillers.deinit();
    app.db.waitStarted(23);
    const leader = try Flock.start(&app, 1, flight_query);
    defer leader.deinit();
    app.db.waitStarted(24);
    var d: Direct = .{ .route = app.route.route() };
    try d.start(flight_query); // admitted (24 active), parks on the leader's flight
    try waitFlightWaiters(&app.route, 1);
    const last_filler = try Flock.start(&app, 1, "{ domain(limit: 1) { name } }");
    defer last_filler.deinit();
    app.db.waitStarted(25); // 25 active: the leader and 24 fillers
    d.peerClosed();
    app.db.openGate(1); // the leader fails (not cached): the waiter runs its own query
    leader.join();
    app.db.waitStarted(26); // the waiter's query, parked at its gate
    // 24 fillers hold slots; the closed waiter's query holds none (TS: uncounted).
    try testing.expectEqual(@as(u32, 24), app.route.active_requests.load(.monotonic));
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const live = try app.postQuery(arena.allocator(), "{ domain(limit: 1) { name } }");
    try testing.expectEqual(@as(u16, 200), live.status);
    for (0..4) |i| app.db.openGate(i);
    fillers.join();
    last_filler.join();
    d.finish();
}
