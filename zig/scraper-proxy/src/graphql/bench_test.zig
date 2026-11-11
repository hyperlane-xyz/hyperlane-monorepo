//! Opt-in in-process benchmark of the /graphql hot path minus PostgreSQL:
//! real HTTP server + route, fake database returning pre-parsed rows.
//!   GRAPHQL_BENCH=1 ./build.sh test-graphql -Doptimize=ReleaseFast
const std = @import("std");
const core = @import("core");
const http = @import("http");
const scraperdb = @import("scraperdb");
const schema_mod = @import("schema.zig");
const route_mod = @import("route.zig");

const Value = core.json.Value;
const Allocator = std.mem.Allocator;

const Db = struct {
    rows: []Value,
    fn query(ctx: *anyopaque, _: Allocator, _: []const u8, _: []const Value, _: *scraperdb.Diag) anyerror![]Value {
        const self: *Db = @ptrCast(@alignCast(ctx));
        return self.rows;
    }
};

fn cpuMicros() i64 {
    const ru = std.posix.getrusage(std.posix.rusage.SELF);
    return (ru.utime.sec + ru.stime.sec) * 1_000_000 + ru.utime.usec + ru.stime.usec;
}

fn run(port: u16, name: []const u8, body: []const u8, iterations: usize) !void {
    const addr = try std.net.Address.parseIp("127.0.0.1", port);
    const stream = try std.net.tcpConnectToAddress(addr);
    defer stream.close();
    var req_buf: [8192]u8 = undefined;
    const req = try std.fmt.bufPrint(&req_buf, "POST /graphql HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n{s}", .{ body.len, body });
    var buf: [256 * 1024]u8 = undefined;
    const cpu0 = cpuMicros();
    var timer = try std.time.Timer.start();
    for (0..iterations) |_| {
        try stream.writeAll(req);
        var len: usize = 0;
        while (true) {
            len += try stream.read(buf[len..]);
            const head_end = (std.mem.indexOf(u8, buf[0..len], "\r\n\r\n") orelse continue) + 4;
            const cl_at = std.ascii.indexOfIgnoreCase(buf[0..head_end], "content-length: ").? + 16;
            const cl_end = std.mem.indexOfScalarPos(u8, buf[0..head_end], cl_at, '\r').?;
            const n = try std.fmt.parseInt(usize, buf[cl_at..cl_end], 10);
            if (len >= head_end + n) {
                if (!std.mem.startsWith(u8, buf[0..len], "HTTP/1.1 200")) return error.BadStatus;
                break;
            }
        }
    }
    const wall = timer.read() / 1000;
    const cpu = cpuMicros() - cpu0;
    std.debug.print("{s}: {d:.1} us/req wall, {d:.1} us/req cpu (client+server)\n", .{ name, @as(f64, @floatFromInt(wall)) / @as(f64, @floatFromInt(iterations)), @as(f64, @floatFromInt(cpu)) / @as(f64, @floatFromInt(iterations)) });
}

test "graphql hot path benchmark (opt-in)" {
    if (std.posix.getenv("GRAPHQL_BENCH") == null) return error.SkipZigTest;
    const gpa = std.heap.c_allocator;
    core.metrics.init();
    core.log.setLevel(.@"error");
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const rows = try core.json.parse(arena.allocator(), @embedFile("testdata/rows100.json"), .{});
    var db: Db = .{ .rows = rows.array };
    var one: Db = .{ .rows = rows.array[0..1] };
    const schema = schema_mod.testing.scraper();
    var route = route_mod.GraphqlRoute.init(gpa, schema, .{ .db = scraperdb.Service.init(.{ .ctx = &db, .queryFn = Db.query }) }, .{});
    defer route.deinit();
    var route1 = route_mod.GraphqlRoute.init(gpa, schema, .{ .db = scraperdb.Service.init(.{ .ctx = &one, .queryFn = Db.query }) }, .{});
    defer route1.deinit();
    var r100 = route.route();
    r100.path = "/graphql";
    var routes = [_]http.Route{r100};
    const server = try http.Server.init(gpa, .{ .host = "127.0.0.1", .port = 0, .routes = &routes });
    defer server.deinit();
    try server.start();
    var routes1 = [_]http.Route{route1.route()};
    const server1 = try http.Server.init(gpa, .{ .host = "127.0.0.1", .port = 0, .routes = &routes1 });
    defer server1.deinit();
    try server1.start();
    const list100 = "{\"query\":\"query ($o: [Int!]) { message_view(where: {origin_domain_id: {_in: $o}}, order_by: {id: desc}, limit: 100) { id msg_id nonce sender recipient is_delivered send_occurred_at delivery_occurred_at delivery_latency origin_tx_hash destination_tx_hash total_payment num_payments } }\",\"variables\":{\"o\":[42161,8453]}}";
    try run(server.port(), "message_view list 100 rows", list100, 5_000);
    try run(server1.port(), "by_pk-like single row", "{\"query\":\"query ($id: bigint!) { raw_message_dispatch_by_pk(id: $id) { id msg_id nonce } }\",\"variables\":{\"id\":\"500000\"}}", 20_000);
    try run(server1.port(), "cache hit", "{\"query\":\"query @cached(ttl: 300) { domain(order_by: {id: asc}) { id name chain_id native_token is_test_net is_deprecated } }\"}", 20_000);
    // Explorer latest page, @cached(ttl: 5): large body (two 100-row roots here).
    try run(server.port(), "Explorer @cached hit (large body)", @embedFile("testdata/explorer-cached.json"), 20_000);
}

test "db query cost (opt-in, needs GRAPHQL_BENCH_DB)" {
    const url = std.posix.getenv("GRAPHQL_BENCH_DB") orelse return error.SkipZigTest;
    const db = @import("db");
    const gpa = std.heap.c_allocator;
    core.log.setLevel(.@"error");
    core.config.set(.{ .database_url = url });
    const svc = try db.DbService.init(gpa, null);
    defer svc.deinit();
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    var failure: db.Failure = .{};
    const sqls = [_][]const u8{
        "SELECT \"chain_id\", \"id\", \"is_deprecated\", \"is_test_net\", \"name\", \"native_token\" FROM \"domain\" ORDER BY \"id\" ASC LIMIT $1",
        "SELECT 1",
        "SELECT \"delivery_latency\", \"delivery_occurred_at\", \"destination_tx_hash\", \"id\", \"is_delivered\", \"msg_id\", \"nonce\", \"num_payments\", \"origin_tx_hash\", \"recipient\", \"send_occurred_at\", \"sender\", \"total_payment\" FROM (SELECT *, FALSE AS is_provisional FROM \"message_view\") AS \"message_view\" WHERE (\"origin_domain_id\" IN (42161, 8453)) ORDER BY \"id\" DESC LIMIT $1",
    };
    for (sqls) |sql| {
        const params = [_]Value{.{ .number = if (std.mem.indexOf(u8, sql, "message_view") != null) 100 else 500 }};
        const p: []const Value = if (std.mem.indexOf(u8, sql, "$1") != null) &params else &.{};
        _ = try svc.query(arena.allocator(), sql, p, &failure);
        const n: usize = if (std.mem.indexOf(u8, sql, "message_view") != null) 300 else 2000;
        const cpu0 = cpuMicros();
        var timer = try std.time.Timer.start();
        for (0..n) |_| {
            _ = arena.reset(.retain_capacity);
            _ = try svc.query(arena.allocator(), sql, p, &failure);
        }
        std.debug.print("db {s}: {d:.1} us wall, {d:.1} us cpu per query\n", .{ sql[0..@min(sql.len, 30)], @as(f64, @floatFromInt(timer.read() / 1000)) / @as(f64, @floatFromInt(n)), @as(f64, @floatFromInt(cpuMicros() - cpu0)) / @as(f64, @floatFromInt(n)) });
    }
}

test "executor stage costs (opt-in)" {
    if (std.posix.getenv("GRAPHQL_BENCH") == null) return error.SkipZigTest;
    const parser = @import("parser.zig");
    const values = @import("values.zig");
    const execute = @import("execute.zig");
    const resolvers = @import("resolvers.zig");
    const gpa = std.heap.c_allocator;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const rows = try core.json.parse(arena.allocator(), @embedFile("testdata/rows100.json"), .{});
    var db: Db = .{ .rows = rows.array };
    var map: resolvers.ResolverMap = .{ .db = scraperdb.Service.init(.{ .ctx = &db, .queryFn = Db.query }) };
    const schema = schema_mod.testing.scraper();
    var diag: parser.Diagnostic = .{};
    const doc = try parser.parse(arena.allocator(), "query ($o: [Int!]) { message_view(where: {origin_domain_id: {_in: $o}}, order_by: {id: desc}, limit: 100) { id msg_id nonce sender recipient is_delivered send_occurred_at delivery_occurred_at delivery_latency origin_tx_hash destination_tx_hash total_payment num_payments } }", .{}, &diag);
    const vars_json = try core.json.parse(arena.allocator(), "{\"o\":[42161,8453]}", .{});
    var req = std.heap.ArenaAllocator.init(gpa);
    defer req.deinit();
    const n = 5000;
    var exec_ns: u64 = 0;
    var serialize_ns: u64 = 0;
    for (0..n) |_| {
        _ = req.reset(.retain_capacity);
        const a = req.allocator();
        var t = try std.time.Timer.start();
        const coerced = (try values.getVariableValues(a, schema, doc.definitions[0].operation.variable_definitions, vars_json)).coerced;
        var ex = try execute.Executor.init(a, schema, doc, coerced, map.resolvers());
        const result = try ex.executeQuery(doc.definitions[0].operation, null);
        exec_ns += t.lap();
        _ = try @import("route.zig").serializeResponse(a, 200, result.data, result.errors);
        serialize_ns += t.lap();
    }
    std.debug.print("stage: execute {d:.1} us, serialize {d:.1} us per request\n", .{ @as(f64, @floatFromInt(exec_ns / n)) / 1000, @as(f64, @floatFromInt(serialize_ns / n)) / 1000 });
}

test "json stringify cost (opt-in)" {
    if (std.posix.getenv("GRAPHQL_BENCH") == null) return error.SkipZigTest;
    const gpa = std.heap.c_allocator;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const rows = try core.json.parse(arena.allocator(), @embedFile("testdata/rows100.json"), .{});
    var out: std.Io.Writer.Allocating = try .initCapacity(gpa, 64 * 1024);
    defer out.deinit();
    const n = 5000;
    var t = try std.time.Timer.start();
    for (0..n) |_| {
        out.clearRetainingCapacity();
        try core.json.stringify(&out.writer, rows);
    }
    std.debug.print("json.stringify 100 rows ({d} bytes): {d:.1} us\n", .{ out.written().len, @as(f64, @floatFromInt(t.read() / n)) / 1000 });
}
