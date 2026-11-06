//! Source validator readiness/EigenNode/Merkle routes. All state is copied under
//! a mutex; native DB access is injected and executes on the HTTP worker only.
const std = @import("std");
const http = @import("../../ops/http.zig");
const query = @import("../../ops/admin/query.zig");
const A = std.mem.Allocator;
pub const readiness = @import("readiness.zig");
pub const default_max_response_bytes = 8 * 1024 * 1024;
pub const RowBudget = struct {
    maximum: usize = default_max_response_bytes,
    used: usize = "{\"merkle_tree_insertions\":[]}".len,
    rows: usize = 0,
    fn digits(value: u64) usize {
        var count: usize = 1;
        var number = value;
        while (number >= 10) : (number /= 10) count += 1;
        return count;
    }
    /// message_id is the source's ASCII hex representation; Native Store emits
    /// fixed-width H256 text. Charge before allocating each row/hash string.
    pub fn add(self: *RowBudget, height: ?u64, leaf: u32, hash_length: usize) !void {
        const fixed = "{\"insertion_block_number\":".len + ",\"leaf_index\":".len + ",\"message_id\":\"".len + "\"}".len;
        const fields = try std.math.add(usize, fixed + (if (height) |number| digits(number) else @as(usize, 4)) + digits(leaf) + @as(usize, if (self.rows == 0) 0 else 1), hash_length);
        if (fields > self.maximum -| self.used) return error.ResponseTooLarge;
        self.used += fields;
        self.rows += 1;
    }
};
pub const Insertion = struct { insertion_block_number: ?u64, leaf_index: u32, message_id: []const u8 };
pub const Merkle = struct { context: *anyopaque, list_fn: *const fn (*anyopaque, A, u32, u32, *RowBudget, *const std.atomic.Value(bool)) anyerror![]Insertion };
pub const Controller = struct {
    readiness: *readiness.State,
    merkle: ?Merkle = null,
    max_response_bytes: usize = default_max_response_bytes,
    pub fn handler(self: *Controller) http.Handler {
        return .{ .context = self, .handle_fn = respond };
    }
};
fn json(a: A, status: u16, value: anytype) !http.Response {
    const text = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(text);
    return http.Response.init(a, status, &.{.{ .name = "content-type", .value = "application/json" }}, text);
}
fn decimal(text: []const u8) !u32 {
    const digits = if (text.len > 0 and text[0] == '+') text[1..] else text;
    if (text.len == 0) return error.EmptyQueryValue;
    if (digits.len == 0) return error.InvalidQueryValue;
    for (digits) |byte| if (byte < '0' or byte > '9') return error.InvalidQueryValue;
    return std.fmt.parseInt(u32, digits, 10);
}
fn queryError(a: A, reason: []const u8, field: ?[]const u8) !http.Response {
    const text = if (field) |name| try std.fmt.allocPrint(a, "Failed to deserialize query string: {s} `{s}`", .{ reason, name }) else try std.fmt.allocPrint(a, "Failed to deserialize query string: {s}", .{reason});
    defer a.free(text);
    return http.Response.init(a, 400, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, text);
}
fn numericQueryError(a: A, field: []const u8, err: anyerror) !http.Response {
    const reason = switch (err) {
        error.Overflow => "number too large to fit in target type",
        error.EmptyQueryValue => "cannot parse integer from empty string",
        else => "invalid digit found in string",
    };
    const text = try std.fmt.allocPrint(a, "Failed to deserialize query string: {s}: {s}", .{ field, reason });
    defer a.free(text);
    return http.Response.init(a, 400, &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }}, text);
}
fn insertions(self: *Controller, a: A, request: http.Request, cancel: *const std.atomic.Value(bool)) !http.Response {
    const owner = self.merkle orelse return http.Response.init(a, 404, &.{}, "");
    var params = query.parse(a, request.query orelse "") catch |err| {
        if (err == error.OutOfMemory) return err;
        return queryError(a, "invalid query string", null);
    };
    defer params.deinit();
    var starts: usize = 0;
    var ends: usize = 0;
    for (params.pairs) |pair| {
        const is_start = std.mem.eql(u8, pair.name, "leaf_index_start");
        const is_end = std.mem.eql(u8, pair.name, "leaf_index_end");
        if (is_start) starts += 1;
        if (is_end) ends += 1;
        if ((is_start and starts > 1) or (is_end and ends > 1)) return queryError(a, "duplicate field", pair.name);
    }
    if (starts == 0) return queryError(a, "missing field", "leaf_index_start");
    if (ends == 0) return queryError(a, "missing field", "leaf_index_end");
    const start = decimal(params.get("leaf_index_start").?) catch |err| return numericQueryError(a, "leaf_index_start", err);
    const end = decimal(params.get("leaf_index_end").?) catch |err| return numericQueryError(a, "leaf_index_end", err);
    if (end <= start) return json(a, 400, .{ .message = "leaf_index_end less than leaf_index_start" });
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var budget: RowBudget = .{ .maximum = self.max_response_bytes };
    const values = owner.list_fn(owner.context, arena.allocator(), start, end, &budget, cancel) catch |err| {
        if (err == error.ResponseTooLarge) return json(a, 413, .{ .message = "Merkle tree insertions response exceeds configured byte limit" });
        if (err == error.RequestCancelled or err == error.Cancelled or err == error.OutOfMemory) return err;
        return json(a, 500, .{ .message = if (err == error.InsertionBlockReadFailed) "Failed to fetch merkle tree insertion block number" else "Failed to fetch merkle tree insertion" });
    };
    return json(a, 200, .{ .merkle_tree_insertions = values });
}
fn respond(context: *anyopaque, a: A, request: http.Request, cancel: *const std.atomic.Value(bool)) !http.Response {
    if (cancel.load(.acquire)) return error.RequestCancelled;
    const self: *Controller = @ptrCast(@alignCast(context));
    const path = request.path;
    const service_prefix = "/eigen/node/services/";
    const service_health = std.mem.startsWith(u8, path, service_prefix) and std.mem.endsWith(u8, path, "/health") and path.len > service_prefix.len + "/health".len and std.mem.indexOfScalar(u8, path[service_prefix.len .. path.len - "/health".len], '/') == null;
    const exists = service_health or std.mem.eql(u8, path, "/ready") or std.mem.eql(u8, path, "/eigen/node") or std.mem.eql(u8, path, "/eigen/node/health") or std.mem.eql(u8, path, "/eigen/node/services") or std.mem.eql(u8, path, "/merkle_tree_insertions");
    if (!exists) return http.Response.init(a, 404, &.{}, "");
    if (!std.mem.eql(u8, request.method, "GET") and !std.mem.eql(u8, request.method, "HEAD")) return http.Response.init(a, 405, &.{.{ .name = "allow", .value = "GET,HEAD" }}, "");
    if (std.mem.eql(u8, path, "/ready")) {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const value = try self.readiness.snapshot(arena.allocator());
        return json(a, if (value.state == .ready or value.state == .waiting_for_first_message) 200 else 503, value);
    }
    if (std.mem.eql(u8, path, "/merkle_tree_insertions")) return insertions(self, a, request, cancel);
    if (std.mem.eql(u8, path, "/eigen/node/health")) return http.Response.init(a, self.readiness.health(), &.{}, "");
    if (service_health) return http.Response.init(a, 200, &.{}, "");
    if (std.mem.eql(u8, path, "/eigen/node/services")) return json(a, 200, .{
        .{ .id = "hyperlane-validator-indexer", .name = "indexer", .description = "indexes the messages from the origin chain mailbox", .status = "Up" },
        .{ .id = "hyperlane-validator-submitter", .name = "submitter", .description = "signs messages indexed from the indexer", .status = "Up" },
    });
    return json(a, 200, .{ .node_name = "Hyperlane Validator", .spec_version = "0.1.0", .node_version = "0.1.0" });
}

fn testRequest(controller: *Controller, path: []const u8, raw_query: ?[]const u8, method: []const u8) !http.Response {
    var empty: [0]u8 = .{};
    var headers: [0]http.Header = .{};
    var cancel: std.atomic.Value(bool) = .init(false);
    return controller.handler().handle_fn(controller, std.testing.allocator, .{ .allocator = std.testing.allocator, .storage = &empty, .header_storage = &headers, .method = method, .target = path, .path = path, .query = raw_query, .version = .http_1_1, .headers = &.{}, .body = "" }, &cancel);
}
test "actual source validator routes schemas methods and query bounds" {
    const a = std.testing.allocator;
    var state = readiness.State.init(a);
    defer state.deinit();
    var controller: Controller = .{ .readiness = &state };
    {
        var response = try testRequest(&controller, "/ready", null, "GET");
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 503), response.status);
        var parsed = try std.json.parseFromSlice(std.json.Value, a, response.body, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("starting", parsed.value.object.get("state").?.string);
    }
    state.waiting();
    {
        var response = try testRequest(&controller, "/ready", null, "HEAD");
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 200), response.status);
    }
    {
        var response = try testRequest(&controller, "/eigen/node", null, "GET");
        defer response.deinit();
        try std.testing.expectEqualStrings("{\"node_name\":\"Hyperlane Validator\",\"spec_version\":\"0.1.0\",\"node_version\":\"0.1.0\"}", response.body);
    }
    {
        var response = try testRequest(&controller, "/eigen/node/services", null, "GET");
        defer response.deinit();
        try std.testing.expect(std.mem.indexOf(u8, response.body, "\"status\":\"Up\"") != null);
    }
    {
        var response = try testRequest(&controller, "/eigen/node/services/any-unknown-service/health", null, "GET");
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 200), response.status);
    }
    {
        var response = try testRequest(&controller, "/eigen/node", null, "POST");
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 405), response.status);
    }
    var unused: u8 = 0;
    const Reader = struct {
        fn list(_: *anyopaque, allocator: A, start: u32, end: u32, budget: *RowBudget, _: *const std.atomic.Value(bool)) ![]Insertion {
            try std.testing.expectEqual(@as(u32, 0), start);
            try std.testing.expectEqual(@as(u32, 2), end);
            try budget.add(null, 1, 4);
            const values = try allocator.alloc(Insertion, 1);
            values[0] = .{ .insertion_block_number = null, .leaf_index = 1, .message_id = "0x01" };
            return values;
        }
    };
    controller.merkle = .{ .context = &unused, .list_fn = Reader.list };
    {
        var response = try testRequest(&controller, "/merkle_tree_insertions", "leaf_index_start=0&leaf_index_end=2", "GET");
        defer response.deinit();
        try std.testing.expectEqualStrings("{\"merkle_tree_insertions\":[{\"insertion_block_number\":null,\"leaf_index\":1,\"message_id\":\"0x01\"}]}", response.body);
    }
    for ([_][]const u8{ "leaf_index_start=1&leaf_index_end=1", "leaf_index_start=0&leaf_index_end=0x2", "leaf_index_start=0&leaf_index_end=2_0", "leaf_index_start=0&leaf_index_start=1&leaf_index_end=2", "leaf_index_start=0" }) |raw| {
        var response = try testRequest(&controller, "/merkle_tree_insertions", raw, "GET");
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 400), response.status);
    }
}

test "Merkle row budget matches serialization and rejects before the next row allocation" {
    const a = std.testing.allocator;
    const hash = "0x" ++ "01010101010101010101010101010101" ++ "01010101010101010101010101010101";
    const rows = [_]Insertion{
        .{ .insertion_block_number = null, .leaf_index = 0, .message_id = hash },
        .{ .insertion_block_number = std.math.maxInt(u64), .leaf_index = std.math.maxInt(u32), .message_id = hash },
    };
    var exact: RowBudget = .{};
    for (rows) |row| try exact.add(row.insertion_block_number, row.leaf_index, row.message_id.len);
    const encoded = try std.json.Stringify.valueAlloc(a, .{ .merkle_tree_insertions = &rows }, .{});
    defer a.free(encoded);
    try std.testing.expectEqual(encoded.len, exact.used);
    exact.maximum = exact.used;
    try std.testing.expectError(error.ResponseTooLarge, exact.add(null, 1, hash.len));
    try std.testing.expectEqual(encoded.len, exact.used);
    const Producer = struct {
        allocations: usize = 0,
        fn list(ctx: *anyopaque, allocator: A, _: u32, _: u32, budget: *RowBudget, _: *const std.atomic.Value(bool)) ![]Insertion {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            for (0..2) |index| {
                try budget.add(null, @intCast(index), hash.len);
                _ = try allocator.alloc(Insertion, 1);
                self.allocations += 1;
            }
            return error.UnexpectedUnboundedProducer;
        }
    };
    var producer: Producer = .{};
    var first: RowBudget = .{};
    try first.add(null, 0, hash.len);
    var state = readiness.State.init(a);
    defer state.deinit();
    var controller: Controller = .{ .readiness = &state, .max_response_bytes = first.used, .merkle = .{ .context = &producer, .list_fn = Producer.list } };
    var response = try testRequest(&controller, "/merkle_tree_insertions", "leaf_index_start=0&leaf_index_end=4294967295", "GET");
    defer response.deinit();
    try std.testing.expectEqual(@as(u16, 413), response.status);
    try std.testing.expectEqual(@as(usize, 1), producer.allocations);
}

fn jsonEqual(left: std.json.Value, right: std.json.Value) bool {
    if (std.meta.activeTag(left) != std.meta.activeTag(right)) return false;
    return switch (left) {
        .null => true,
        .bool => |v| v == right.bool,
        .integer => |v| v == right.integer,
        .float => |v| v == right.float,
        .string => |v| std.mem.eql(u8, v, right.string),
        .number_string => |v| std.mem.eql(u8, v, right.number_string),
        .array => |v| blk: {
            if (v.items.len != right.array.items.len) break :blk false;
            for (v.items, right.array.items) |a, b| if (!jsonEqual(a, b)) break :blk false;
            break :blk true;
        },
        .object => |v| blk: {
            if (v.count() != right.object.count()) break :blk false;
            var iterator = v.iterator();
            while (iterator.next()) |entry| {
                const other = right.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!jsonEqual(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}
test "29 actual production Axum validator routes exact status schema fields methods and errors" {
    const fixture_bytes = try @import("../../testing/fixture.zig").bytes(std.testing.allocator, @embedFile("fixtures/http.jsonl.gz"), 16 * 1024 * 1024);
    defer std.testing.allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const fixture = (try std.json.parseFromSlice(std.json.Value, a, line, .{ .allocate = .alloc_always })).value.object;
        const input = fixture.get("input").?.object;
        const expected = fixture.get("expected").?.object;
        var state = readiness.State.init(a);
        defer state.deinit();
        if (input.get("actions")) |actions| for (actions.array.items) |action| {
            const kind = action.array.items[0].string;
            const operation = action.array.items[1].string;
            if (std.mem.eql(u8, kind, "blocked")) try state.blocked(operation) else if (std.mem.eql(u8, kind, "ready")) state.ready(operation) else state.waiting();
        };
        state.observed = if (input.get("observed")) |value| value.integer else 0;
        state.processed = if (input.get("processed")) |value| value.integer else 0;
        const Producer = struct {
            rows: ?std.json.Value,
            fn list(ctx: *anyopaque, allocator: A, start: u32, end: u32, budget: *RowBudget, _: *const std.atomic.Value(bool)) ![]Insertion {
                const self: *@This() = @ptrCast(@alignCast(ctx));
                var values: std.ArrayList(Insertion) = .empty;
                if (self.rows) |rows| for (rows.array.items) |item| {
                    const fields = item.object;
                    const index: u32 = @intCast(fields.get("index").?.integer);
                    if (index < start or index > end) continue;
                    const height: ?u64 = if (fields.get("block").? == .null) null else @intCast(fields.get("block").?.integer);
                    try budget.add(height, index, 66);
                    const byte: u8 = @intCast(fields.get("byte").?.integer);
                    const id: [32]u8 = @splat(byte);
                    try values.append(allocator, .{ .insertion_block_number = height, .leaf_index = index, .message_id = try std.fmt.allocPrint(allocator, "0x{s}", .{std.fmt.bytesToHex(id, .lower)}) });
                };
                return values.toOwnedSlice(allocator);
            }
        };
        var producer: Producer = .{ .rows = input.get("insertions") };
        var controller: Controller = .{ .readiness = &state, .merkle = .{ .context = &producer, .list_fn = Producer.list } };
        const target = input.get("path").?.string;
        const question = std.mem.indexOfScalar(u8, target, '?');
        const method = input.get("method").?.string;
        var response = try testRequest(&controller, if (question) |q| target[0..q] else target, if (question) |q| target[q + 1 ..] else null, method);
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, @intCast(expected.get("status").?.integer)), response.status);
        for ([_][]const u8{ "content_type", "allow" }) |name| {
            const header_name = if (std.mem.eql(u8, name, "content_type")) "content-type" else name;
            var value: ?[]const u8 = null;
            for (response.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, header_name)) {
                value = header.value;
                break;
            };
            if (expected.get(name).? == .null) try std.testing.expect(value == null) else try std.testing.expectEqualStrings(expected.get(name).?.string, value orelse "");
        }
        var body: std.ArrayList(u8) = .empty;
        for (expected.get("body_utf8_chunks").?.array.items) |part| try body.appendSlice(a, part.string);
        const actual = if (std.mem.eql(u8, method, "HEAD")) "" else response.body;
        if (body.items.len > 0 and (body.items[0] == '{' or body.items[0] == '[')) {
            const wanted = (try std.json.parseFromSlice(std.json.Value, a, body.items, .{})).value;
            var observed = (try std.json.parseFromSlice(std.json.Value, a, actual, .{})).value;
            if (observed == .object and observed.object.contains("failure_duration_ms")) try observed.object.put("failure_duration_ms", .null);
            try std.testing.expect(jsonEqual(wanted, observed));
        } else try std.testing.expectEqualStrings(body.items, actual);
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 29), count);
}
