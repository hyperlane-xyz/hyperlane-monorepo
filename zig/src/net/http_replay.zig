//! Read-only REST/gRPC reads over a shared HTTP Runtime. Every fetch submits
//! one request and waits for it: a fiber parks, a thread drives inline. The
//! callback is never replayed. JSON-RPC correlation IDs are authenticated.
const std = @import("std");
const curl = @import("curl.zig");
const runtime = @import("http_runtime.zig");
const rpc_replay = @import("read_replay.zig");
const metrics = @import("../ops/rpc_metrics.zig");
const fiber = @import("../runtime/fiber.zig");
const A = std.mem.Allocator;
/// Each attempt (or committed section) is bounded by `max_entries` physical
/// requests and `max_cached_bytes` response bytes, the bytes also reserved
/// from `shared_budget` (read_replay.Quota).
pub const Config = struct { max_attempt_ms: u32 = 120000, max_entries: usize = 512, max_request_bytes: usize = 1024 * 1024, max_cached_bytes: usize = 128 * 1024 * 1024, shared_budget: ?*rpc_replay.ByteBudget = null, recorder: ?*metrics.Recorder = null };
pub const Replay = struct {
    allocator: A,
    owner: *runtime.Runtime,
    config: Config,
    started: ?std.time.Instant = null,
    in_pass: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    quota: rpc_replay.Quota,
    pub fn init(a: A, owner: *runtime.Runtime, config: Config) !Replay {
        if (config.max_attempt_ms == 0 or config.max_attempt_ms > 300000 or config.max_entries == 0 or config.max_entries > 4096 or config.max_request_bytes == 0 or config.max_cached_bytes == 0) return error.InvalidHttpReplayLimit;
        return .{ .allocator = a, .owner = owner, .config = config, .quota = .{ .max_requests = config.max_entries, .max_bytes = config.max_cached_bytes, .shared = config.shared_budget } };
    }
    pub fn deinit(self: *Replay) void {
        self.reset();
        self.* = undefined;
    }
    pub fn beginPass(self: *Replay, cancel: ?*const std.atomic.Value(bool), shared_started: ?std.time.Instant) !void {
        if (self.in_pass) return error.ReadReplayPassAlreadyActive;
        if (cancel) |flag| if (flag.load(.acquire)) {
            self.reset();
            return error.RequestCancelled;
        };
        if (self.started == null) self.started = shared_started orelse try std.time.Instant.now();
        _ = self.remaining() catch |err| {
            self.reset();
            return err;
        };
        self.cancel = cancel;
        self.in_pass = true;
    }
    /// A pass suspended by another source keeps the absolute attempt deadline
    /// and quota.
    pub fn endPass(self: *Replay, failure: ?anyerror) void {
        self.in_pass = false;
        self.cancel = null;
        if (failure) |err| if (err == error.PendingReadIo) return;
        self.reset();
    }
    pub fn reset(self: *Replay) void {
        self.quota.release();
        self.started = null;
        self.in_pass = false;
        self.cancel = null;
    }
    /// Every read completes before fetch returns: no request outlives a call.
    pub fn hasPending(_: *const Replay) bool {
        return false;
    }
    /// Closes a read section: its request/byte quota is released while the
    /// absolute attempt deadline is kept.
    pub fn commitReadSection(self: *Replay) !void {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        self.quota.release();
    }
    fn remaining(self: *Replay) !u32 {
        const elapsed = (try std.time.Instant.now()).since(self.started orelse return error.ReadReplayPassNotActive);
        const total = @as(u64, self.config.max_attempt_ms) * std.time.ns_per_ms;
        if (elapsed >= total) return error.RequestDeadlineExceeded;
        return @intCast((total - elapsed + std.time.ns_per_ms - 1) / std.time.ns_per_ms);
    }
    pub fn override(self: *Replay) curl.SendOverride {
        return .{ .context = self, .send_fn = send };
    }
    fn send(context: *anyopaque, a: A, original: curl.Request) anyerror!curl.Response {
        const self: *Replay = @ptrCast(@alignCast(context));
        return self.fetch(a, original);
    }
    /// One physical request: submit, then park (fiber) or drive (thread)
    /// until its response, deadline or cancellation.
    pub fn fetch(self: *Replay, a: A, original: curl.Request) !curl.Response {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (original.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const remaining_ms = try self.remaining();
        const id = try requestPolicy(a, original, self.config.max_request_bytes);
        try self.quota.admit();
        var request = original;
        request.timeout_ms = @min(request.timeout_ms, remaining_ms);
        request.connect_timeout_ms = @min(request.connect_timeout_ms, request.timeout_ms);
        const observer = if (self.config.recorder) |recorder| try recorder.httpCompletionObserver(request) else null;
        defer if (observer) |o| o.release();
        const handle = while (true) {
            break self.owner.submit(request, observer) catch |err| switch (err) {
                // Retiring sessions own slots until native drain: wait for one.
                error.HttpRuntimeSessionsFull, error.HttpRuntimeByteBudgetExceeded => {
                    if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
                    _ = try self.remaining();
                    var nap: fiber.Waiter = .{};
                    _ = nap.waitTimeout(fiber.monoMs() + 1);
                    continue;
                },
                else => return err,
            };
        };
        var response = self.owner.wait(handle, self.owner.now() +| request.timeout_ms, self.cancel, original.cancel) catch |err| {
            // Preserve source endpoint fallback after a single native request
            // times out; only absolute attempt expiry is control.
            if (err == error.RequestDeadlineExceeded) {
                _ = self.remaining() catch return error.RequestDeadlineExceeded;
                return error.UpstreamReadTimeout;
            }
            return err;
        };
        if (a.ptr == response.allocator.ptr and a.vtable == response.allocator.vtable) {
            errdefer response.deinit();
            try checkDirectResponse(self.allocator, response, id, original.max_response_bytes);
            try self.quota.charge(try responseBytes(response));
            return response;
        }
        defer response.deinit();
        try checkDirectResponse(self.allocator, response, id, original.max_response_bytes);
        try self.quota.charge(try responseBytes(response));
        return cloneResponse(a, response, original.max_response_bytes);
    }
};
fn responseBytes(response: curl.Response) !usize {
    return std.math.add(usize, response.body.len, try std.math.add(usize, response.header_storage.len, try std.math.mul(usize, response.headers.len, @sizeOf(curl.Header))));
}
fn checkDirectResponse(a: A, response: curl.Response, id: ?i64, maximum: usize) !void {
    if (id) |value| if (response.status == 200) try rpc_replay.validateResponse(a, response.body, value);
    if (response.body.len > maximum) return error.ResponseTooLarge;
}
/// Read-only method/route policy; returns the JSON-RPC correlation id when
/// the body is a JSON-RPC request. JSON is depth-bounded before parsing.
fn requestPolicy(a: A, request: curl.Request, maximum: usize) !?i64 {
    try curl.validateRequest(request);
    if (request.public_only or (request.method != .get and request.method != .post)) return error.NonReadOnlyReplayRequest;
    const body = request.body orelse "";
    if (body.len > maximum) return error.ReadReplayRequestTooLarge;
    const trimmed = std.mem.trimStart(u8, body, " \t\r\n");
    if (trimmed.len != 0 and (trimmed[0] == '{' or trimmed[0] == '[')) {
        // One scan: syntax/depth errors propagate (json_bounds), a duplicate key
        // makes it non-JSON-RPC (its tree parse failed), and a JSON-RPC object
        // gets the read-only policy on this same scan.
        const scanned = @import("json_envelope.zig").scan(a, body, @import("json_envelope.zig").pool_options) catch |err| switch (err) {
            error.DuplicateField => null,
            else => return err,
        };
        if (scanned) |top| if (top.object and top.get(.jsonrpc) != null) {
            return try rpc_replay.readOnlyId(&top, body);
        };
    }
    if (request.method == .post and !readOnlyPost(request.url)) return error.NonReadOnlyReplayRequest;
    return null;
}
fn readOnlyPost(url: []const u8) bool {
    const uri = std.Uri.parse(url) catch return false;
    const path = switch (uri.path) {
        .raw => |s| s,
        .percent_encoded => |s| s,
    };
    const paths = @import("../cosmos/proto.zig").paths;
    inline for (comptime std.meta.declarations(paths)) |decl| if (std.mem.endsWith(u8, path, @field(paths, decl.name))) return true;
    const routes = [_][]const u8{ "/cosmos.tx.v1beta1.Service/GetTx", "/cosmos.tx.v1beta1.Service/GetTxsEvent", "/cosmos.base.tendermint.v1beta1.Service/GetBlockByHeight", "/cosmos.base.tendermint.v1beta1.Service/GetLatestBlock", "/status/network-status", "/status/gateway-status", "/transaction/call-preview", "/transaction/preview-v2", "/transaction/committed-details", "/transaction/status", "/stream/transactions", "/state/entity/details", "/wallet/getnowblock", "/wallet/getblockbynum", "/wallet/gettransactionbyid", "/wallet/gettransactioninfobyid", "/wallet/triggerconstantcontract", "/wallet/estimateenergy", "/walletsolidity/getnowblock", "/walletsolidity/getblockbynum", "/walletsolidity/gettransactionbyid", "/walletsolidity/gettransactioninfobyid", "/walletsolidity/triggerconstantcontract" };
    for (routes) |route| if (std.mem.endsWith(u8, path, route)) return true;
    return false;
}
/// Copies a runtime-owned response into the caller allocator.
fn cloneResponse(a: A, source: curl.Response, maximum: usize) !curl.Response {
    const body = try a.dupe(u8, source.body);
    errdefer a.free(body);
    if (body.len > maximum) return error.ResponseTooLarge;
    var storage_size: usize = 0;
    var length_buffer: [20]u8 = undefined;
    const length_text = try std.fmt.bufPrint(&length_buffer, "{d}", .{body.len});
    for (source.headers) |header| storage_size = try std.math.add(usize, storage_size, try std.math.add(usize, header.name.len, if (std.ascii.eqlIgnoreCase(header.name, "content-length")) length_text.len else header.value.len));
    const storage = try a.alloc(u8, storage_size);
    errdefer a.free(storage);
    const headers = try a.alloc(curl.Header, source.headers.len);
    errdefer a.free(headers);
    var at: usize = 0;
    for (source.headers, headers) |header, *out| {
        const name = storage[at..][0..header.name.len];
        @memcpy(name, header.name);
        at += name.len;
        const from = if (std.ascii.eqlIgnoreCase(header.name, "content-length")) length_text else header.value;
        const value = storage[at..][0..from.len];
        @memcpy(value, from);
        at += value.len;
        out.* = .{ .name = name, .value = value };
    }
    return .{ .allocator = a, .status = source.status, .http_version = source.http_version, .body = body, .headers = headers, .header_storage = storage };
}

test "HTTP replay accepts source read routes rejects broadcast and bounds JSON before recursion" {
    const a = std.testing.allocator;
    for ([_][]const u8{
        "/cosmwasm.wasm.v1.Query/SmartContractState", "/walletsolidity/triggerconstantcontract", "/transaction/call-preview", "/stream/transactions",
    }) |path| {
        const url = try std.fmt.allocPrint(a, "https://example.invalid{s}", .{path});
        defer a.free(url);
        _ = try requestPolicy(a, .{ .url = url, .method = .post, .body = "{}" }, 1024);
    }
    for ([_][]const u8{ "/wallet/broadcasttransaction", "/transaction/submit", "/cosmos.tx.v1beta1.Service/BroadcastTx", "/unrecognized" }) |path| {
        const url = try std.fmt.allocPrint(a, "https://example.invalid{s}", .{path});
        defer a.free(url);
        try std.testing.expectError(error.NonReadOnlyReplayRequest, requestPolicy(a, .{ .url = url, .method = .post, .body = "{}" }, 1024));
    }
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requestPolicy(a, .{ .url = "https://example.invalid", .method = .get, .public_only = true }, 1024));
    const write = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}";
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requestPolicy(a, .{ .url = "https://example.invalid", .method = .post, .body = write }, 1024));
    var depth: [258]u8 = undefined;
    @memset(depth[0..129], '[');
    @memset(depth[129..], ']');
    try std.testing.expectError(error.JsonDepthExceeded, requestPolicy(a, .{ .url = "https://example.invalid/status/network-status", .method = .post, .body = &depth }, 1024));
}

/// The pre-scan policy (json_bounds, Value parse, then requireReadOnly), verbatim.
fn legacyRequestPolicy(a: A, request: curl.Request, maximum: usize) !?i64 {
    try curl.validateRequest(request);
    if (request.public_only or (request.method != .get and request.method != .post)) return error.NonReadOnlyReplayRequest;
    const body = request.body orelse "";
    if (body.len > maximum) return error.ReadReplayRequestTooLarge;
    const trimmed = std.mem.trimStart(u8, body, " \t\r\n");
    if (trimmed.len != 0 and (trimmed[0] == '{' or trimmed[0] == '[')) {
        try @import("json_bounds.zig").validate(body);
        const parsed = std.json.parseFromSlice(std.json.Value, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false }) catch |err| switch (err) {
            error.OutOfMemory => return err,
            else => null,
        };
        defer if (parsed) |value| value.deinit();
        if (parsed) |value| if (value.value == .object and value.value.object.contains("jsonrpc")) {
            return try @import("json_envelope_differential_test.zig").legacyRequireReadOnly(a, body, maximum);
        };
    }
    if (request.method == .post and !readOnlyPost(request.url)) return error.NonReadOnlyReplayRequest;
    return null;
}

test "HTTP replay JSON policy matches the pre-scan policy on every body shape" {
    const a = std.testing.allocator;
    var deep: [260]u8 = undefined;
    @memset(deep[0..129], '[');
    @memset(deep[129..258], ']');
    var bodies: std.ArrayList([]const u8) = .empty;
    defer bodies.deinit(a);
    try bodies.appendSlice(a, &.{
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"status\",\"params\":[]}",
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"broadcast_tx_sync\",\"params\":[]}",
        "{\"jsonrpc\":\"2.0\",\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"broadcast_tx_sync\"}",
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"status\",\"params\":{\"a\":1,\"a\":2}}",
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"status\",\"params\":[}",
        "{\"query\":{\"count\":{}}}",
        "{\"q\":{\"k\":1,\"k\":2}}",
        "[{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"status\"}]",
        "{\"jsonrpc\":1,\"id\":4,\"method\":\"status\"}",
        "{\"\\u006asonrpc\":\"2.0\",\"id\":4,\"method\":\"tx\"}",
        "  \n{}",
        "plain text",
        "",
        deep[0..258],
        deep[1..257],
    });
    for (bodies.items) |body| for ([_][]const u8{ "https://example.invalid/status/network-status", "https://example.invalid/unrecognized" }) |url| {
        const request: curl.Request = .{ .url = url, .method = .post, .body = body };
        const old = legacyRequestPolicy(a, request, 1024);
        const new = requestPolicy(a, request, 1024);
        if (old) |id| try std.testing.expectEqual(id, try new) else |err| try std.testing.expectError(err, new);
    };
}

test "HTTP replay fetch enforces pass, cancellation and read-only policy before any submit" {
    const a = std.testing.allocator;
    // Never touched: every case fails before submission.
    var owner: runtime.Runtime = undefined;
    var value = try Replay.init(a, &owner, .{ .max_attempt_ms = 1000 });
    defer value.deinit();
    try std.testing.expectError(error.ReadReplayPassNotActive, value.fetch(a, .{ .url = "https://example.invalid/status/network-status", .method = .post, .body = "{}" }));
    try value.beginPass(null, null);
    try std.testing.expect(!value.hasPending());
    try value.commitReadSection();
    try std.testing.expectError(error.NonReadOnlyReplayRequest, value.fetch(a, .{ .url = "https://example.invalid/transaction/submit", .method = .post, .body = "{}" }));
    try std.testing.expectError(error.NonReadOnlyReplayRequest, value.fetch(a, .{ .url = "https://example.invalid", .method = .post, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}" }));
    try std.testing.expectError(error.NonReadOnlyReplayRequest, value.fetch(a, .{ .url = "https://example.invalid", .method = .get, .public_only = true }));
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, value.fetch(a, .{ .url = "https://example.invalid/status/network-status", .method = .post, .body = "{}", .cancel = &cancelled }));
    // A suspension by another source keeps the absolute attempt start.
    const started = value.started.?;
    value.endPass(error.PendingReadIo);
    try value.beginPass(null, null);
    try std.testing.expectEqual(started, value.started.?);
    value.endPass(null);
    try std.testing.expect(value.started == null);
    try std.testing.expectError(error.RequestCancelled, value.beginPass(&cancelled, null));
}
