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
    /// Queries whose SQL contains this needle fail with `fail_sql_message`.
    fail_sql: ?[]const u8 = null,
    fail_sql_message: []const u8 = "boom",
    /// Queries whose SQL contains this needle sleep first (completion order).
    delay_sql: ?[]const u8 = null,

    fn query(ctx: *anyopaque, arena: Allocator, text: []const u8, _: []const Value, diag: *scraperdb.Diag) anyerror![]Value {
        const self: *FakeDb = @ptrCast(@alignCast(ctx));
        const execute = @import("execute.zig");
        if (!execute.beforeIo()) {
            diag.message = route_mod.capacity_message;
            return error.CapacityExceeded;
        }
        execute.afterIo();
        self.mutex.lock();
        self.queries += 1;
        self.started += 1;
        const n = self.queries;
        self.cond.broadcast();
        while (self.blocked) self.cond.wait(&self.mutex);
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
        if (delay_sql) |needle| if (std.mem.indexOf(u8, text, needle) != null) std.Thread.sleep(40 * std.time.ns_per_ms);
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

    fn waitStarted(self: *FakeDb, n: u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        while (self.started < n) self.cond.wait(&self.mutex);
    }

    fn release(self: *FakeDb) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.blocked = false;
        self.cond.broadcast();
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
    route: route_mod.GraphqlRoute = undefined,
    routes: [2]http.Route = undefined,
    server: *http.Server = undefined,

    fn start(self: *App) !void {
        core.metrics.init();
        core.log.setLevel(.@"error");
        const svc = scraperdb.Service.init(.{ .ctx = &self.db, .queryFn = FakeDb.query });
        self.route = route_mod.GraphqlRoute.init(self.gpa orelse testing.allocator, schema_mod.testing.scraper(), .{ .db = svc }, .{});
        self.routes = .{ http.metricsRoute(), self.route.route() };
        self.server = try http.Server.init(testing.allocator, .{ .host = "127.0.0.1", .port = 0, .routes = &self.routes, .request_timeout_ms = self.request_timeout_ms });
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

    fn get(self: *App, a: Allocator, query_string: []const u8, preflight: bool) !Response {
        return self.request(a, try std.fmt.allocPrint(a, "GET /graphql?{s} HTTP/1.1\r\nHost: x\r\n{s}\r\n", .{ query_string, if (preflight) "mercurius-require-preflight: true\r\n" else "" }));
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
    len: usize = 0,

    fn close(self: *Client) void {
        posix.close(self.fd);
    }

    fn send(self: *Client, bytes: []const u8) !void {
        if (!http.server.writeFd(self.fd, bytes)) return error.WriteFailed;
    }

    fn fill(self: *Client) !usize {
        var fds = [_]posix.pollfd{.{ .fd = self.fd, .events = posix.POLL.IN, .revents = 0 }};
        if (try posix.poll(&fds, 5_000) == 0) return error.Timeout;
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
    const cc = cached.header("cache-control").?;
    try testing.expect(std.mem.eql(u8, cc, "max-age=30, public") or std.mem.eql(u8, cc, "max-age=29, public"));
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
        try app.postQuery(a, "{ result: message_view_aggregate(limit: 1) { aggregate { count } nodes { id msg_id nonce delivery_latency delivery_occurred_at destination_tx_gas_used } } }"),
        200,
        "{\"data\":{\"result\":{\"aggregate\":{\"count\":1},\"nodes\":[{\"id\":1,\"msg_id\":\"0x1111111111111111111111111111111111111111111111111111111111111111\",\"nonce\":42,\"delivery_latency\":null,\"delivery_occurred_at\":\"2026-09-14T12:00:00.000Z\",\"destination_tx_gas_used\":\"123.45\"}]}}}",
    );
    try expectJson(try app.postQuery(a, "{ raw_message_dispatch(limit: 1) { id } }"), 200, "{\"data\":{\"raw_message_dispatch\":[{\"id\":1}]}}");
}

test "bounds concurrent pathological GraphQL requests" {
    var app: App = .{};
    app.db.blocked = true;
    try app.start();
    defer app.stop();
    const Worker = struct {
        fn run(ap: *App, status: *u16) void {
            var arena = std.heap.ArenaAllocator.init(testing.allocator);
            defer arena.deinit();
            const r = ap.postQuery(arena.allocator(), "{ domain(limit: 1) { id } }") catch return;
            status.* = r.status;
        }
    };
    var threads: [25]std.Thread = undefined;
    var statuses = [_]u16{0} ** 25;
    for (&threads, &statuses) |*t, *s| t.* = try std.Thread.spawn(.{}, Worker.run, .{ &app, s });
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
    for (statuses) |s| try testing.expectEqual(@as(u16, 200), s);
    try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, "{ domain(limit: 1) { id } }")).status);
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
    app.db.blocked = true;
    const Parked = struct {
        fn run(ap: *App, status: *u16) void {
            var ar = std.heap.ArenaAllocator.init(testing.allocator);
            defer ar.deinit();
            status.* = (ap.postQuery(ar.allocator(), "{ domain(limit: 2) { id } }") catch return).status;
        }
    };
    var parked: [24]std.Thread = undefined;
    var parked_status = [_]u16{0} ** 24;
    for (&parked, &parked_status) |*t, *st| t.* = try std.Thread.spawn(.{}, Parked.run, .{ &app, st });
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
            for (0..100) |i| {
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
    var last_status: u16 = 0;
    const last = try std.Thread.spawn(.{}, Parked.run, .{ &app, &last_status });
    app.db.waitStarted(26);
    const full = try app.postQuery(a, cached);
    try testing.expectEqual(@as(u16, 503), full.status);
    try testing.expectEqualStrings("GraphQL request capacity exceeded", full.body);
    try testing.expect(full.header("cache-control") == null);
    app.db.release();
    for (parked) |t| t.join();
    last.join();
    for (parked_status) |st| try testing.expectEqual(@as(u16, 200), st);
    try testing.expectEqual(@as(u16, 200), last_status);
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
    std.Thread.sleep(25 * std.time.ns_per_ms);
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
    std.Thread.sleep(25 * std.time.ns_per_ms);
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
    std.Thread.sleep(50 * std.time.ns_per_ms);
    for (0..51) |_| try testing.expectEqual(@as(u16, 200), (try app.postQuery(a, "{ domain(limit: 1) { id } }")).status);
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
    const r = try app.postQuery(arena.allocator(), "{ canonical: message_view(limit: 3) { id } provisional: message_view(confirmations: 0) { id } }");
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
    const r = try app.postQuery(a, "{ x: message_view(where: {nonce: {_eq: 1}}, limit: 1) { id } d: domain(limit: 1) { id } z: message_view(limit: 1) { id } }");
    try expectJson(r, 200, "{\"data\":{\"x\":null,\"d\":[{\"id\":7}],\"z\":null},\"errors\":[{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":89}],\"path\":[\"z\"]},{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"x\"]}]}");
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
    try expectJson(try app.postQuery(a, "{ a: message_view(limit: 1) { id } b: message_view(confirmations: 1001) { id } }"), 200, "{\"data\":{\"a\":null,\"b\":null},\"errors\":[{\"message\":\"confirmations exceeds maximum of 1000\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"b\"]},{\"message\":\"boom\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]}]}");
    // A non-null assertion ends collection before the I/O error settles.
    try expectJson(try app.postQuery(a, "{ a: message_view(limit: 1) { id } b: domain(limit: 501) { id } }"), 200, "{\"data\":null,\"errors\":[{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":36}],\"path\":[\"b\"]}]}");
    // Nullable I/O-free errors are collected before the non-null one.
    try expectJson(try app.postQuery(a, "{ a: domain(limit: 501) { id } b: message_view(confirmations: 1001) { id } }"), 200, "{\"data\":null,\"errors\":[{\"message\":\"confirmations exceeds maximum of 1000\",\"locations\":[{\"line\":1,\"column\":32}],\"path\":[\"b\"]},{\"message\":\"limit exceeds maximum of 500\",\"locations\":[{\"line\":1,\"column\":3}],\"path\":[\"a\"]}]}");
}

test "concurrent root fields stop at the first non-null failure" {
    var app: App = .{};
    app.db.fail_sql = "raw_message_dispatch";
    app.db.delay_sql = "OFFSET";
    app.db.rows = "[{\"id\":7}]";
    try app.start();
    defer app.stop();
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try app.postQuery(a, "{ a: domain(limit: 1) { id } b: raw_message_dispatch(limit: 1) { id } c: raw_message_dispatch(limit: 2, offset: 0) { id } }");
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
