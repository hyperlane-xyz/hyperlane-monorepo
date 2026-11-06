//! Opt-in native RocksDB/loopback tests for delegated admin handlers.
const std = @import("std");
const http = @import("../http.zig");
const api = @import("api.zig");
const native = @import("native_stores.zig");
const store_mod = @import("../../agents/store.zig");
const origin_mod = @import("../../agents/origin.zig");
const rocks = @import("../../db/rocks.zig");
const json = @import("json.zig");
const protocol = @import("../../protocol/root.zig");

comptime {
    _ = @import("../../db/bzip2_glue.zig");
}

const Environment = struct {
    database: rocks.Database,
    store: *store_mod.Store,
    origin: *origin_mod.Origin,
    domains: [1]native.Domain,
    databases: *native.NativeDatabases,
    state: api.Admin,

    fn open(a: std.mem.Allocator, path: []const u8) !*Environment {
        const self = try a.create(Environment);
        errdefer a.destroy(self);
        self.* = .{ .database = undefined, .store = undefined, .origin = undefined, .domains = undefined, .databases = undefined, .state = undefined };
        self.database = try rocks.Database.open(a, path, .{ .sync = true });
        errdefer self.database.deinit();
        const store = try a.create(store_mod.Store);
        store.* = store_mod.Store.init(a, &self.database, "ethereum");
        errdefer a.destroy(store);
        const origin = try a.create(origin_mod.Origin);
        origin.* = origin_mod.Origin.init(a, store, 1, @splat(2), null);
        errdefer {
            origin.deinit();
            a.destroy(origin);
        }
        self.domains = [1]native.Domain{.{ .name = "ethereum", .id = 1, .store = store, .origin = origin }};
        const databases = try a.create(native.NativeDatabases);
        databases.* = .{ .domains = &self.domains };
        self.store = store;
        self.origin = origin;
        self.databases = databases;
        self.state = .{ .messages = databases.messageDb(), .merkle = databases.merkleDb(), .proofs = databases.proofDb() };
        return self;
    }
    fn close(self: *Environment, a: std.mem.Allocator) void {
        self.origin.deinit();
        a.destroy(self.origin);
        a.destroy(self.store);
        a.destroy(self.databases);
        self.database.deinit();
        a.destroy(self);
    }
};

const fixture_message: protocol.Message = .{
    .version = 3,
    .nonce = 10,
    .origin = 1,
    .sender = @splat(1),
    .destination = 2,
    .recipient = @splat(2),
    .body = &.{ 3, 4 },
};

fn messageRequestBody(a: std.mem.Allocator) ![]u8 {
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    try out.writer.writeAll("{\"messages\":[{\"message\":");
    try json.writeMessage(&out.writer, fixture_message);
    try out.writer.writeAll(",\"message_id\":null,\"dispatched_block_number\":20}]}");
    return json.finish(&out, a);
}

fn merkleRequestBody(a: std.mem.Allocator, id: [32]u8) ![]u8 {
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    try out.writer.writeAll("{\"merkle_tree_insertions\":[{\"chain\":1,\"insertion_block_number\":30,\"leaf_index\":0,\"message_id\":\"");
    try json.writePrefixedHash(&out.writer, id);
    try out.writer.writeAll("\"}]}");
    return json.finish(&out, a);
}

test "native rocks admin message insertion lists and persists after reopen" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "db" });
    defer a.free(path);
    {
        var env = try Environment.open(a, path);
        defer env.close(a);
        var cancel = std.atomic.Value(bool).init(false);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const body = try messageRequestBody(arena.allocator());
        var insert = try testRequest(arena.allocator(), "POST", "/messages", body);
        defer insert.deinit();
        const handler = env.state.handler();
        var inserted = try handler.handle_fn(handler.context, a, insert.value, &cancel);
        defer inserted.deinit();
        try std.testing.expectEqual(@as(u16, 200), inserted.status);
        try std.testing.expectEqualStrings("{\"count\":1,\"skipped\":[]}", inserted.body);

        var request = try testRequest(arena.allocator(), "GET", "/messages?domain_id=1&nonce_start=9&nonce_end=10", "");
        defer request.deinit();
        const list_handler = env.state.handler();
        var response = try list_handler.handle_fn(list_handler.context, a, request.value, &cancel);
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 200), response.status);
        try std.testing.expect(std.mem.indexOf(u8, response.body, "\"nonce\":10") != null);
    }
    {
        var env = try Environment.open(a, path);
        defer env.close(a);
        var cancel = std.atomic.Value(bool).init(false);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var request = try testRequest(arena.allocator(), "GET", "/messages?domain_id=1&nonce_start=10&nonce_end=11", "");
        defer request.deinit();
        const handler = env.state.handler();
        var response = try handler.handle_fn(handler.context, a, request.value, &cancel);
        defer response.deinit();
        try std.testing.expectEqual(@as(u16, 200), response.status);
        try std.testing.expect(std.mem.indexOf(u8, response.body, "\"origin\":1") != null);
    }
}

test "native rocks merkle insertion listing proof and socket dispatch" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const base = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "db" });
    defer a.free(path);
    var env = try Environment.open(a, path);
    defer env.close(a);
    const id = fixture_message.id();
    var cancel = std.atomic.Value(bool).init(false);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const body = try merkleRequestBody(arena.allocator(), id);
    var insert = try testRequest(arena.allocator(), "POST", "/merkle_tree_insertions", body);
    defer insert.deinit();
    const handler = env.state.handler();
    var inserted = try handler.handle_fn(handler.context, a, insert.value, &cancel);
    defer inserted.deinit();
    try std.testing.expectEqual(@as(u16, 200), inserted.status);
    try std.testing.expectEqualStrings("{\"count\":1,\"skipped\":[]}", inserted.body);
    _ = try env.origin.sync(1);

    const server = try http.Server.start(a, .{
        .address = try std.net.Address.parseIp4("127.0.0.1", 0),
        .request_timeout_ms = 15_000,
    }, env.state.handler());
    defer server.deinit();
    {
        const reply = try socketRequest(a, server.address(), "GET", "/merkle_tree_insertions?domain_id=1&leaf_index_start=0&leaf_index_end=1", "");
        defer a.free(reply);
        try std.testing.expect(std.mem.indexOf(u8, reply, "200 OK") != null);
        try std.testing.expect(std.mem.indexOf(u8, reply, "\"insertion_block_number\":30") != null);
    }
    {
        const reply = try socketRequest(a, server.address(), "GET", "/merkle_proofs?domain_id=1&leaf_index=0&root_index=0", "");
        defer a.free(reply);
        try std.testing.expect(std.mem.indexOf(u8, reply, "200 OK") != null);
        try std.testing.expect(std.mem.indexOf(u8, reply, "\"path\":[") != null);
    }
}

fn testRequest(a: std.mem.Allocator, method: []const u8, target: []const u8, body: []const u8) !TestRequest {
    _ = json;
    return TestRequest.init(a, method, target, body);
}

const TestRequest = struct {
    value: http.Request,
    storage: []u8,
    headers: []http.Header,
    fn init(a: std.mem.Allocator, method: []const u8, target: []const u8, body: []const u8) !TestRequest {
        const head = try std.fmt.allocPrint(a, "{s} {s} HTTP/1.1\r\nHost: native\r\nContent-Type: application/json\r\nContent-Length: {d}\r\n\r\n", .{ method, target, body.len });
        defer a.free(head);
        const storage = try a.alloc(u8, head.len + body.len);
        @memcpy(storage[0..head.len], head);
        @memcpy(storage[head.len..], body);
        const headers = try a.alloc(http.Header, 2);
        headers[0] = .{ .name = "Host", .value = "native" };
        headers[1] = .{ .name = "Content-Type", .value = "application/json" };
        const method_end = std.mem.indexOfScalar(u8, storage, ' ').?;
        const target_start = method_end + 1;
        const target_end = target_start + target.len;
        const target_text = storage[target_start..target_end];
        const query = std.mem.indexOfScalar(u8, target_text, '?');
        return .{
            .value = .{
                .allocator = a,
                .storage = storage,
                .header_storage = headers,
                .method = storage[0..method_end],
                .target = target_text,
                .path = if (query) |index| target_text[0..index] else target_text,
                .query = if (query) |index| target_text[index + 1 ..] else null,
                .version = .http_1_1,
                .headers = headers,
                .body = storage[head.len..],
            },
            .storage = storage,
            .headers = headers,
        };
    }
    fn deinit(self: *TestRequest) void {
        const a = self.value.allocator;
        a.free(self.storage);
        a.free(self.headers);
    }
};

fn socketRequest(a: std.mem.Allocator, address: std.net.Address, method: []const u8, target: []const u8, body: []const u8) ![]u8 {
    var stream = try std.net.tcpConnectToAddress(address);
    defer stream.close();
    const request = try std.fmt.allocPrint(a, "{s} {s} HTTP/1.1\r\nHost: native\r\nConnection: close\r\nContent-Length: {d}\r\n\r\n{s}", .{ method, target, body.len, body });
    defer a.free(request);
    try stream.writeAll(request);
    var output = std.array_list.Managed(u8).init(a);
    errdefer output.deinit();
    var buffer: [4096]u8 = undefined;
    while (true) {
        const count = try stream.read(&buffer);
        if (count == 0) break;
        try output.appendSlice(buffer[0..count]);
    }
    return output.toOwnedSlice();
}
