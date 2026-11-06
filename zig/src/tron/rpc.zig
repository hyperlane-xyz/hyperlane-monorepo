//! The production Tron adapter uses HTTP wallet APIs, not gRPC. Its separate
//! Ethereum-compatible JSON-RPC pool supplies logs, receipts and energy prices.
const std = @import("std");
const http = @import("../cloud/http.zig");
const evm = @import("../evm/provider.zig");
const A = std.mem.Allocator;
pub const Value = std.json.Value;
pub const Endpoint = @import("../net/endpoint.zig").Endpoint;
pub const Json = struct {
    parsed: std.json.Parsed(Value),
    pub fn value(self: Json) Value {
        return self.parsed.value;
    }
    pub fn deinit(self: *Json) void {
        self.parsed.deinit();
        self.* = undefined;
    }
};

/// All endpoint/header bytes are borrowed. One serialized owner per pool;
/// callers using an I/O pool own a separate instance for each concurrent job.
pub const Pool = struct {
    allocator: A,
    transport: http.Transport,
    endpoints: []const Endpoint,
    max_response_bytes: usize = 8 * 1024 * 1024,
    next_id: i64 = 1,

    fn postOne(self: *Pool, endpoint: Endpoint, path: []const u8, body: []const u8) !Json {
        const url = try appendPath(self.allocator, endpoint.url, path);
        defer self.allocator.free(url);
        var has_type = false;
        for (endpoint.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "content-type")) {
            has_type = true;
        };
        const headers = try self.allocator.alloc(http.Header, endpoint.headers.len + @as(usize, if (has_type) 0 else 1));
        defer self.allocator.free(headers);
        @memcpy(headers[0..endpoint.headers.len], endpoint.headers);
        if (!has_type) headers[endpoint.headers.len] = .{ .name = "content-type", .value = "application/json" };
        var response = try self.transport.send(self.allocator, .{ .method = .POST, .url = url, .headers = headers, .body = body, .max_response_bytes = self.max_response_bytes });
        defer response.deinit();
        if (response.status < 200 or response.status >= 300) return error.TronHttpStatus;
        const parsed = try std.json.parseFromSlice(Value, self.allocator, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error", .max_value_len = self.max_response_bytes });
        errdefer parsed.deinit();
        if (parsed.value != .object) return error.InvalidTronResponse;
        if (parsed.value.object.get("Error")) |_| return error.TronApiError;
        return .{ .parsed = parsed };
    }

    pub fn wallet(self: *Pool, path: []const u8, body: anytype) !Json {
        return self.walletValidated(path, body, noValidation);
    }
    pub fn walletValidated(self: *Pool, path: []const u8, body: anytype, comptime validate: fn (Value) anyerror!void) !Json {
        if (path.len == 0 or path[0] != '/' or std.mem.indexOfAny(u8, path, "?#") != null) return error.InvalidTronPath;
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, body, .{});
        defer self.allocator.free(encoded);
        if (self.endpoints.len == 0) return error.EmptyTronPool;
        var last: anyerror = error.EmptyTronPool;
        for (self.endpoints) |endpoint| {
            var response = self.postOne(endpoint, path, encoded) catch |err| {
                if (@import("../net/json_rpc.zig").isControl(err)) return err;
                last = err;
                continue;
            };
            validate(response.value()) catch |err| {
                response.deinit();
                if (@import("../net/json_rpc.zig").isControl(err)) return err;
                last = err;
                continue;
            };
            return response;
        }
        return last;
    }

    /// Same request ID/body on all fallback endpoints. Only the envelope's
    /// result is returned by result(); the Json wrapper owns every borrowed byte.
    pub fn call(self: *Pool, method: []const u8, params: anytype) !Json {
        if (method.len == 0 or method.len > 128) return error.InvalidRpcMethod;
        if (self.next_id == std.math.maxInt(i64)) return error.RpcIdExhausted;
        const id = self.next_id;
        self.next_id += 1;
        const encoded = try std.json.Stringify.valueAlloc(self.allocator, .{ .jsonrpc = "2.0", .id = id, .method = method, .params = params }, .{});
        defer self.allocator.free(encoded);
        if (self.endpoints.len == 0) return error.EmptyTronPool;
        var last: anyerror = error.EmptyTronPool;
        for (self.endpoints) |endpoint| {
            var response = self.postOne(endpoint, "", encoded) catch |err| {
                if (@import("../net/json_rpc.zig").isControl(err)) return err;
                last = err;
                continue;
            };
            const code = evm.validateEnvelope(response.value(), id) catch |err| {
                response.deinit();
                if (@import("../net/json_rpc.zig").isControl(err)) return err;
                last = err;
                continue;
            };
            if (code != null) {
                response.deinit();
                last = error.TronRpcError;
                continue;
            }
            return response;
        }
        return last;
    }
};
fn noValidation(_: Value) !void {}

pub fn result(response: Json) Value {
    return response.value().object.get("result").?;
}
pub fn field(value: Value, name: []const u8) !Value {
    if (value != .object) return error.InvalidTronResponse;
    return value.object.get(name) orelse error.InvalidTronResponse;
}
pub fn string(value: Value) ![]const u8 {
    if (value != .string) return error.InvalidTronResponse;
    return value.string;
}
pub fn nonnegative(value: Value) !u64 {
    if (value != .integer or value.integer < 0) return error.InvalidTronResponse;
    return @intCast(value.integer);
}

/// Appends the wallet method before an existing query, preserving endpoint
/// API keys without interpreting or logging them. Query-only JSON-RPC unchanged.
pub fn appendPath(allocator: A, base: []const u8, path: []const u8) ![]u8 {
    const uri = try std.Uri.parse(base);
    if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or
        (!std.mem.eql(u8, uri.scheme, "https") and !std.mem.eql(u8, uri.scheme, "http"))) return error.InvalidTronUrl;
    if (path.len == 0) return allocator.dupe(u8, base);
    const query = std.mem.indexOfScalar(u8, base, '?') orelse base.len;
    return std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ std.mem.trimEnd(u8, base[0..query], "/"), path, base[query..] });
}

test "Tron pools preserve paths and query, reject failure envelopes and mismatched RPC IDs" {
    const mock = @import("../cloud/testing.zig");
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/wallet/getnowblock?token=fixture", .request_body = "{}", .response = "{\"Error\":\"node failure\"}" },
        .{ .method = .POST, .suffix = "/wallet/getnowblock", .response = "{\"blockID\":\"00\"}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}" },
    } };
    var pool: Pool = .{ .allocator = std.testing.allocator, .transport = script.transport(), .endpoints = &.{ .{ .url = "https://first/wallet/?token=fixture" }, .{ .url = "https://second/wallet" } } };
    var response = try pool.wallet("/getnowblock", struct {}{});
    response.deinit();
    pool.endpoints = &.{.{ .url = "https://first/rpc" }};
    try std.testing.expectError(error.RpcIdMismatch, pool.call("eth_gasPrice", .{}));
    try script.expectDone();
}

test "Tron cooperative control preserves wallet and JSON RPC endpoint ordering" {
    const Pending = struct {
        calls: usize = 0,
        fn send(ctx: *anyopaque, _: std.mem.Allocator, _: http.Request) !http.Response {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return error.PendingReadIo;
        }
    };
    var pending: Pending = .{};
    var pool: Pool = .{ .allocator = std.testing.allocator, .transport = .{ .context = &pending, .send_fn = Pending.send }, .endpoints = &.{ .{ .url = "https://one.fixture" }, .{ .url = "https://two.fixture" } } };
    try std.testing.expectError(error.PendingReadIo, pool.wallet("/getnowblock", .{}));
    try std.testing.expectEqual(@as(usize, 1), pending.calls);
    pending.calls = 0;
    try std.testing.expectError(error.PendingReadIo, pool.call("eth_chainId", .{}));
    try std.testing.expectEqual(@as(usize, 1), pending.calls);
}
