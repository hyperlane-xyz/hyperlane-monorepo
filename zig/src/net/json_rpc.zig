//! Injected JSON-RPC boundary. Single serialized owner; endpoint/header storage
//! is borrowed. Structured remote errors retain data only in the owned envelope.
//! Existing EVM/Tron clients remain separate until source parity is consolidated.
const std = @import("std");
const http = @import("../cloud/http.zig");
pub const Value = std.json.Value;
pub const Endpoint = @import("endpoint.zig").Endpoint;
pub const Options = struct { max_response_bytes: usize = 8 * 1024 * 1024 };
pub const RemoteError = struct { code: i64, data: ?Value };
pub const Envelope = struct {
    parsed: std.json.Parsed(Value),
    pub fn deinit(self: *Envelope) void {
        self.parsed.deinit();
        self.* = undefined;
    }
    /// Borrowed value. Call only after checking remoteError()==null, or use call().
    pub fn value(self: Envelope) Value {
        return self.parsed.value.object.get("result").?;
    }
    pub fn remoteError(self: Envelope) ?RemoteError {
        const err = self.parsed.value.object.get("error") orelse return null;
        return .{ .code = err.object.get("code").?.integer, .data = err.object.get("data") };
    }
};
pub const Client = struct {
    allocator: std.mem.Allocator,
    transport: http.Transport,
    endpoints: []const Endpoint,
    options: Options,
    next_id: i64 = 1,
    pub fn init(a: std.mem.Allocator, transport: http.Transport, endpoints: []const Endpoint, options: Options) !Client {
        if (endpoints.len == 0) return error.EmptyJsonRpcPool;
        if (options.max_response_bytes < 2) return error.InvalidJsonRpcLimit;
        for (endpoints) |endpoint| {
            const uri = try std.Uri.parse(endpoint.url);
            if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or
                (!std.mem.eql(u8, uri.scheme, "http") and !std.mem.eql(u8, uri.scheme, "https"))) return error.InvalidJsonRpcUrl;
        }
        return .{ .allocator = a, .transport = transport, .endpoints = endpoints, .options = options };
    }
    pub fn callEnvelope(self: *Client, method: []const u8, params: anytype) !Envelope {
        if (method.len == 0 or method.len > 128) return error.InvalidJsonRpcMethod;
        if (self.next_id == std.math.maxInt(i64)) return error.JsonRpcIdExhausted;
        const id = self.next_id;
        self.next_id += 1;
        const body = try std.json.Stringify.valueAlloc(self.allocator, .{ .jsonrpc = "2.0", .id = id, .method = method, .params = params }, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(body);
        var last: anyerror = error.EmptyJsonRpcPool;
        for (self.endpoints) |endpoint| {
            var response = self.send(endpoint, body) catch |err| {
                if (isControl(err)) return err;
                last = err;
                continue;
            };
            validate(response.parsed.value, id) catch |err| {
                response.deinit();
                if (isControl(err)) return err;
                last = err;
                continue;
            };
            // A well-formed remote error is an RPC result, not a transport
            // failure. Preserve code/data so callers can handle not-found/revert.
            return response;
        }
        return last;
    }
    pub fn call(self: *Client, method: []const u8, params: anytype) !Envelope {
        var response = try self.callEnvelope(method, params);
        errdefer response.deinit();
        if (response.remoteError() != null) return error.JsonRpcRemoteError;
        return response;
    }
    fn send(self: *Client, endpoint: Endpoint, body: []const u8) !Envelope {
        var has_type = false;
        for (endpoint.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "content-type")) {
            has_type = true;
        };
        const headers = try self.allocator.alloc(http.Header, endpoint.headers.len + @as(usize, if (has_type) 0 else 1));
        defer self.allocator.free(headers);
        @memcpy(headers[0..endpoint.headers.len], endpoint.headers);
        if (!has_type) headers[endpoint.headers.len] = .{ .name = "content-type", .value = "application/json" };
        var response = try self.transport.send(self.allocator, .{ .method = .POST, .url = endpoint.url, .headers = headers, .body = body, .max_response_bytes = self.options.max_response_bytes });
        defer response.deinit();
        if (response.status < 200 or response.status >= 300) return error.JsonRpcHttpStatus;
        return .{ .parsed = try std.json.parseFromSlice(Value, self.allocator, response.bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error", .max_value_len = self.options.max_response_bytes }) };
    }
};
pub fn isControl(err: anyerror) bool {
    return switch (err) {
        error.PendingReadIo, error.PendingIo, error.OutOfMemory, error.RequestCancelled, error.Cancelled, error.RequestDeadlineExceeded, error.SourceReadDeadline, error.ScraperReceiptDeadline, error.SvmRequestDeadline => true,
        else => false,
    };
}
pub fn field(value: Value, name: []const u8) !Value {
    if (value != .object) return error.InvalidJsonRpcResult;
    return value.object.get(name) orelse error.InvalidJsonRpcResult;
}
pub fn string(value: Value) ![]const u8 {
    if (value != .string) return error.InvalidJsonRpcResult;
    return value.string;
}
pub fn integer(comptime T: type, value: Value) !T {
    return switch (value) {
        .integer => |number| std.math.cast(T, number) orelse error.InvalidJsonRpcResult,
        .number_string => |number| std.fmt.parseInt(T, number, 10) catch error.InvalidJsonRpcResult,
        else => error.InvalidJsonRpcResult,
    };
}
pub fn validate(value: Value, expected_id: i64) !void {
    if (value != .object or !std.mem.eql(u8, try string(try field(value, "jsonrpc")), "2.0")) return error.InvalidJsonRpcEnvelope;
    if (try integer(i64, try field(value, "id")) != expected_id) return error.JsonRpcIdMismatch;
    const result = value.object.contains("result");
    const err = value.object.get("error");
    if (result == (err != null)) return error.InvalidJsonRpcEnvelope;
    if (err) |remote| {
        _ = try integer(i64, try field(remote, "code"));
        _ = try string(try field(remote, "message"));
    }
}

test "shared JSON-RPC owns data rejects ambiguous envelopes and preserves safe remote code and structured data" {
    const a = std.testing.allocator;
    const mock = @import("../cloud/testing.zig");
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/first", .response = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}" },
        .{ .method = .POST, .suffix = "/second", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":29,\"message\":\"not found\",\"data\":{\"fixture\":true}}}" },
    } };
    var client = try Client.init(a, script.transport(), &.{ .{ .url = "https://fixture/first" }, .{ .url = "https://fixture/second" } }, .{});
    var response = try client.callEnvelope("starknet_getTransactionReceipt", .{"0x1"});
    defer response.deinit();
    try std.testing.expectEqual(@as(i64, 29), response.remoteError().?.code);
    try std.testing.expect((try field(response.remoteError().?.data.?, "fixture")).bool);
    try script.expectDone();
    for ([_][]const u8{ "[]", "{}", "{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":null}", "{\"jsonrpc\":\"2.0\",\"id\":1}", "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null,\"error\":null}", "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":\"bad\",\"message\":\"bad\"}}" }) |bad| {
        var parsed = try std.json.parseFromSlice(Value, a, bad, .{});
        defer parsed.deinit();
        if (validate(parsed.value, 1)) |_| return error.AcceptedInvalidJsonRpc else |_| {}
    }
}

test "JSON integer boundaries retain full unsigned precision and reject fractional quantities" {
    const a = std.testing.allocator;
    const maximum = try std.fmt.allocPrint(a, "{d}", .{std.math.maxInt(u256)});
    defer a.free(maximum);
    var parsed = try std.json.parseFromSlice(Value, a, maximum, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(std.math.maxInt(u256), try integer(u256, parsed.value));
    try std.testing.expectError(error.InvalidJsonRpcResult, integer(u64, parsed.value));
    try std.testing.expectError(error.InvalidJsonRpcResult, integer(u64, .{ .number_string = "1.5" }));
    try std.testing.expectError(error.InvalidJsonRpcResult, integer(u64, .{ .integer = -1 }));
}

test "JSON RPC cooperative control never advances endpoint fallback" {
    const Pending = struct {
        calls: usize = 0,
        fn send(ctx: *anyopaque, _: std.mem.Allocator, _: http.Request) !http.Response {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return error.PendingReadIo;
        }
    };
    var pending: Pending = .{};
    var client = try Client.init(std.testing.allocator, .{ .context = &pending, .send_fn = Pending.send }, &.{ .{ .url = "https://one.fixture" }, .{ .url = "https://two.fixture" } }, .{});
    try std.testing.expectError(error.PendingReadIo, client.call("read", .{}));
    try std.testing.expectEqual(@as(usize, 1), pending.calls);
}
