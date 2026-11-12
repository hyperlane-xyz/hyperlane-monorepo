//! Opt-in stack high-water marks of the deepest GraphQL request paths
//! (painted stack): `GRAPHQL_STACK=1 ./build.sh test-graphql -Drelease=true
//! -Dtest-filter="stack high-water"`. Each case runs one whole /graphql
//! exchange (body parse, parse, validate, execute with root fields inline,
//! serialize) on a fresh thread whose unused stack is painted first; the
//! report is the deepest byte touched below the entry frame.
const std = @import("std");
const core = @import("core");
const http = @import("http");
const scraperdb = @import("scraperdb");
const schema_mod = @import("schema.zig");
const route_mod = @import("route.zig");

const Value = core.json.Value;
const Allocator = std.mem.Allocator;

const thread_stack = 64 * 1024 * 1024;
const paint_byte: u8 = 0xA5;
/// Left untouched just below the measuring frame (its own locals/calls).
const margin = 16 * 1024;
/// Not painted at the bottom (guard page and slack).
const bottom_slack = 256 * 1024;

const Db = struct {
    fn query(_: *anyopaque, _: Allocator, _: []const u8, _: []const Value, _: *scraperdb.Diag) anyerror![]Value {
        return &.{};
    }
};

const Case = struct { name: []const u8, body: []const u8 };

const Run = struct {
    route: http.Route,
    body: []const u8,
    used: usize = 0,
    status_prefix: [48]u8 = undefined,
    status_len: usize = 0,

    noinline fn paint(top: usize) void {
        var p: usize = top - margin;
        const low = top - (thread_stack - bottom_slack);
        while (p > low) : (p -= 1) @as(*volatile u8, @ptrFromInt(p)).* = paint_byte;
    }

    noinline fn deepest(top: usize) usize {
        const low = top - (thread_stack - bottom_slack);
        var p: usize = low + 1;
        while (p < top - margin and @as(*volatile u8, @ptrFromInt(p)).* == paint_byte) : (p += 1) {}
        return top - p;
    }

    fn entry(self: *Run) void {
        const top = @frameAddress();
        paint(top);
        self.exchange() catch {};
        self.used = deepest(top);
    }

    noinline fn exchange(self: *Run) !void {
        var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const text = try core.json.toWellFormedUtf8(a, self.body);
        const parsed = core.json.parse(a, text, .{ .secure = true, .strip_bom = true }) catch Value.null;
        const headers = [_]http.Header{ .{ .name = "Host", .value = "x" }, .{ .name = "Content-Type", .value = "application/json" } };
        var req: http.Request = .{ .arena = a, .method = "POST", .url = "/graphql", .path = "/graphql", .query = "", .headers = &headers, .remote_address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 1), .body = .{ .json = parsed }, .raw_body = self.body, .complete = true };
        var reply: http.Reply = .{ .arena = a };
        const r = self.route;
        r.hooks.on_request.?(r.ctx, &req, &reply);
        if (!reply.sent) r.hooks.handler(r.ctx, &req, &reply);
        r.hooks.on_send.?(r.ctx, &req, &reply);
        if (reply.body()) |b| {
            self.status_len = @min(b.len, self.status_prefix.len);
            @memcpy(self.status_prefix[0..self.status_len], b[0..self.status_len]);
        }
        r.hooks.on_done.?(r.ctx, &req, &reply, .finished);
    }
};

fn nested(a: Allocator, open: []const u8, close: []const u8, inner: []const u8, levels: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (0..levels) |_| try out.appendSlice(a, open);
    try out.appendSlice(a, inner);
    for (0..levels) |_| try out.appendSlice(a, close);
    return out.items;
}

fn jsonBody(a: Allocator, query: []const u8, variables: ?[]const u8) ![]const u8 {
    const q = try core.json.stringifyAlloc(a, .{ .string = query });
    if (variables) |v| return std.fmt.allocPrint(a, "{{\"query\":{s},\"variables\":{s}}}", .{ q, v });
    return std.fmt.allocPrint(a, "{{\"query\":{s}}}", .{q});
}

test "stack high-water of the deepest request paths (opt-in GRAPHQL_STACK=1)" {
    if (std.posix.getenv("GRAPHQL_STACK") == null) return error.SkipZigTest;
    const gpa = std.heap.c_allocator;
    core.metrics.init();
    core.log.setLevel(.@"error");
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var db: u8 = 0;
    const schema = schema_mod.testing.scraper();
    // Root fields inline: the request thread then carries every recursion
    // (an upper bound for any root-field thread).
    var route = route_mod.GraphqlRoute.init(gpa, schema, .{ .db = scraperdb.Service.init(.{ .ctx = &db, .queryFn = Db.query }) }, .{ .root_field_threads = 0 });
    defer route.deinit();

    // The deepest request each guard admits (one level under the cold-TS
    // depth; parser.stack_budget / values.coerce_budget), plus the shapes
    // with no TS limit inside the request size limits.
    const cases = [_]Case{
        .{ .name = "lists x1713", .body = try jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(limit: {s}) {{ id }} }}", .{try nested(a, "[", "]", "1", 1713)}), null) },
        .{ .name = "objects x1360", .body = try jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(where: {{id: {{_eq: {s}}}}}) {{ id }} }}", .{try nested(a, "{a: ", "}", "1", 1360)}), null) },
        .{ .name = "where _and inline x757", .body = try jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(where: {s}) {{ id }} }}", .{try nested(a, "{_and: [", "]}", "{id: {_eq: 1}}", 757)}), null) },
        .{ .name = "where _not inline x1360", .body = try jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(where: {s}) {{ id }} }}", .{try nested(a, "{_not: ", "}", "{id: {_eq: 1}}", 1360)}), null) },
        .{ .name = "selections x1666", .body = try jsonBody(a, try std.fmt.allocPrint(a, "{{ domain {s} }}", .{try nested(a, "{ a ", "}", "b", 1666)}), null) },
        .{ .name = "inline fragments x1642", .body = try jsonBody(a, try std.fmt.allocPrint(a, "{{ {s} }}", .{try nested(a, "... on query_root { ", "}", "__typename", 1642)}), null) },
        .{ .name = "list types x4980 (no TS limit)", .body = try jsonBody(a, try std.fmt.allocPrint(a, "query ($x: {s}) {{ __typename }}", .{try nested(a, "[", "]", "Int", 4980)}), null) },
        .{ .name = "_and variables x625", .body = try jsonBody(a, "query ($w: domain_bool_exp) { domain(where: $w) { id } }", try std.fmt.allocPrint(a, "{{\"w\":{s}}}", .{try nested(a, "{\"_and\":[", "]}", "{\"id\":{\"_eq\":1}}", 625)})) },
        .{ .name = "_not variables x2396", .body = try jsonBody(a, "query ($w: domain_bool_exp) { domain(where: $w) { id } }", try std.fmt.allocPrint(a, "{{\"w\":{s}}}", .{try nested(a, "{\"_not\":", "}", "{\"id\":{\"_eq\":1}}", 2396)})) },
        .{ .name = "@cached _and variables x625", .body = try jsonBody(a, "query ($w: domain_bool_exp) @cached(ttl: 5) { domain(where: $w) { id } }", try std.fmt.allocPrint(a, "{{\"w\":{s}}}", .{try nested(a, "{\"_and\":[", "]}", "{\"id\":{\"_eq\":1}}", 625)})) },
        .{ .name = "JSON body 49k deep (no TS limit)", .body = try std.fmt.allocPrint(a, "{{\"query\":\"{{ __typename }}\",\"x\":{s}}}", .{try nested(a, "[", "]", "1", 49_000)}) },
    };
    for (cases) |c| {
        var run: Run = .{ .route = route.route(), .body = c.body };
        const t = try std.Thread.spawn(.{ .stack_size = thread_stack }, Run.entry, .{&run});
        t.join();
        std.debug.print("stack {s}: {d} KiB ({d} B request) -> {s}\n", .{ c.name, run.used / 1024, c.body.len, run.status_prefix[0..run.status_len] });
    }
}

// ---------------------------------------------------------------------------
// TS stack-overflow emulation: threshold - 1 is processed normally, threshold
// answers TS's 400 "Maximum call stack size exceeded" (no location). The
// constants are the cold-TS depths (parser.stack_budget, values.coerce_budget).
// ---------------------------------------------------------------------------

const parser = @import("parser.zig");
const values = @import("values.zig");

const overflow_body = "{\"data\":null,\"errors\":[{\"message\":\"Maximum call stack size exceeded\"}]}";

const Probe = struct {
    route: http.Route,
    body: []const u8,
    status: u16 = 0,
    response: []u8 = &.{},

    fn run(self: *Probe) void {
        self.exchange() catch |e| std.debug.panic("probe failed: {s}", .{@errorName(e)});
    }

    fn exchange(self: *Probe) !void {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const parsed = try core.json.parse(a, self.body, .{ .secure = true, .strip_bom = true });
        const headers = [_]http.Header{ .{ .name = "Host", .value = "x" }, .{ .name = "Content-Type", .value = "application/json" } };
        var req: http.Request = .{ .arena = a, .method = "POST", .url = "/graphql", .path = "/graphql", .query = "", .headers = &headers, .remote_address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 1), .body = .{ .json = parsed }, .raw_body = self.body, .complete = true };
        var reply: http.Reply = .{ .arena = a };
        const r = self.route;
        r.hooks.on_request.?(r.ctx, &req, &reply);
        if (!reply.sent) r.hooks.handler(r.ctx, &req, &reply);
        r.hooks.on_send.?(r.ctx, &req, &reply);
        self.status = reply.status;
        self.response = try std.testing.allocator.dupe(u8, reply.body() orelse "");
        r.hooks.on_done.?(r.ctx, &req, &reply, .finished);
    }
};

fn probeOnBigStack(route: http.Route, body: []const u8) !Probe {
    var p: Probe = .{ .route = route, .body = body };
    // Debug frames are several times larger than ReleaseFast ones.
    const t = try std.Thread.spawn(.{ .stack_size = 64 * 1024 * 1024 }, Probe.run, .{&p});
    t.join();
    return p;
}

fn expectThreshold(route: http.Route, a: Allocator, comptime name: []const u8, threshold: usize, build: *const fn (Allocator, usize) anyerror![]const u8) !void {
    const below = try probeOnBigStack(route, try build(a, threshold - 1));
    defer std.testing.allocator.free(below.response);
    if (std.mem.indexOf(u8, below.response, "Maximum call stack size exceeded") != null) {
        std.debug.print("{s}: depth {d} must not overflow, got {d} {s}\n", .{ name, threshold - 1, below.status, below.response[0..@min(below.response.len, 200)] });
        return error.TestUnexpectedResult;
    }
    const at = try probeOnBigStack(route, try build(a, threshold));
    defer std.testing.allocator.free(at.response);
    if (at.status != 400 or !std.mem.eql(u8, at.response, overflow_body)) {
        std.debug.print("{s}: depth {d} must overflow, got {d} {s}\n", .{ name, threshold, at.status, at.response[0..@min(at.response.len, 200)] });
        return error.TestUnexpectedResult;
    }
}

const builders = struct {
    fn list(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(limit: {s}) {{ id }} }}", .{try nested(a, "[", "]", "1", n)}), null);
    }
    fn object(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(where: {{id: {{_eq: {s}}}}}) {{ id }} }}", .{try nested(a, "{a: ", "}", "1", n)}), null);
    }
    fn selection(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain {s} }}", .{try nested(a, "{ a ", "}", "b", n)}), null);
    }
    fn inlineFragment(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ {s} }}", .{try nested(a, "... on query_root { ", "}", "__typename", n)}), null);
    }
    fn andInline(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(where: {s}) {{ id }} }}", .{try nested(a, "{_and: [", "]}", "{id: {_eq: 1}}", n)}), null);
    }
    fn obj2List1(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(limit: {s}) {{ id }} }}", .{try nested(a, "{a: {b: [", "]}}", "1", n)}), null);
    }
    fn list2Obj1(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain(limit: {s}) {{ id }} }}", .{try nested(a, "[[{a: ", "}]]", "1", n)}), null);
    }
    fn listUnderSelections(comptime selections: usize) fn (Allocator, usize) anyerror![]const u8 {
        return struct {
            fn build(a: Allocator, n: usize) anyerror![]const u8 {
                const leaf = try std.fmt.allocPrint(a, "b(x: {s})", .{try nested(a, "[", "]", "1", n)});
                return jsonBody(a, try std.fmt.allocPrint(a, "{{ domain {s} }}", .{try nested(a, "{ a ", "}", leaf, selections)}), null);
            }
        }.build;
    }
    fn notVar(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, "query ($w: domain_bool_exp) { domain(where: $w) { id } }", try std.fmt.allocPrint(a, "{{\"w\":{s}}}", .{try nested(a, "{\"_not\":", "}", "{\"id\":{\"_eq\":1}}", n)}));
    }
    fn andVar(a: Allocator, n: usize) anyerror![]const u8 {
        return jsonBody(a, "query ($w: domain_bool_exp) { domain(where: $w) { id } }", try std.fmt.allocPrint(a, "{{\"w\":{s}}}", .{try nested(a, "{\"_and\":[", "]}", "{\"id\":{\"_eq\":1}}", n)}));
    }
};

fn cachedDeepScalar(a: Allocator, n: usize, object: bool) ![]const u8 {
    const v = if (object) try nested(a, "{\"a\":", "}", "1", n) else try nested(a, "[", "]", "1", n);
    return std.fmt.allocPrint(a, "{{\"query\":\"query ($x: bigint!) @cached(ttl: 5) {{ raw_message_dispatch_by_pk(id: $x) {{ id }} }}\",\"variables\":{{\"x\":{s}}}}}", .{v});
}

test "deep @cached variables answer like TS's preHandler overflow" {
    core.metrics.init();
    core.log.setLevel(.@"error");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var db: u8 = 0;
    var route = route_mod.GraphqlRoute.init(std.testing.allocator, schema_mod.testing.scraper(), .{ .db = scraperdb.Service.init(.{ .ctx = &db, .queryFn = Db.query }) }, .{ .root_field_threads = 0 });
    defer route.deinit();
    for ([_]struct { object: bool, depth: usize }{ .{ .object = false, .depth = 2734 }, .{ .object = true, .depth = 2074 } }) |c| {
        const below = try probeOnBigStack(route.route(), try cachedDeepScalar(a, c.depth - 1, c.object));
        defer std.testing.allocator.free(below.response);
        try std.testing.expect(std.mem.indexOf(u8, below.response, "Maximum call stack size exceeded") == null);
        const at = try probeOnBigStack(route.route(), try cachedDeepScalar(a, c.depth, c.object));
        defer std.testing.allocator.free(at.response);
        try std.testing.expectEqual(@as(u16, 200), at.status);
        try std.testing.expectEqualStrings(overflow_body, at.response);
    }
}

test "deep nesting answers like a cold TS process at its stack limit" {
    core.metrics.init();
    core.log.setLevel(.@"error");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var db: u8 = 0;
    var route = route_mod.GraphqlRoute.init(std.testing.allocator, schema_mod.testing.scraper(), .{ .db = scraperdb.Service.init(.{ .ctx = &db, .queryFn = Db.query }) }, .{ .root_field_threads = 0 });
    defer route.deinit();
    const r = route.route();
    const b = parser.stack_budget;
    const c = values.coerce_budget;
    try expectThreshold(r, a, "list", b.list_depth, builders.list);
    try expectThreshold(r, a, "object", b.object_depth, builders.object);
    try expectThreshold(r, a, "selection", b.selection_depth, builders.selection);
    try expectThreshold(r, a, "inline fragment", b.inline_fragment_depth, builders.inlineFragment);
    try expectThreshold(r, a, "_not variables", c.not_depth, builders.notVar);
    // Mixed shapes (not used for fitting): the cold-TS depths they overflow at.
    try expectThreshold(r, a, "_and inline", 758, builders.andInline);
    try expectThreshold(r, a, "object:list 2:1", 488, builders.obj2List1);
    try expectThreshold(r, a, "[[{a:", 526, builders.list2Obj1);
    try expectThreshold(r, a, "list under 600 selections", 1097, builders.listUnderSelections(600));
    try expectThreshold(r, a, "list under 1200 selections", 480, builders.listUnderSelections(1200));
    try expectThreshold(r, a, "_and variables", c.and_depth, builders.andVar);
}
