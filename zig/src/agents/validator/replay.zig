//! Round-scoped replay of concrete READ-ONLY checkpoint operations. A cache miss
//! starts one native multi transfer and unwinds with PendingReadIo; the collector
//! re-executes Reader.latest/at against verified responses. Never attach to a
//! signer, database, publisher or transaction client. All state is owner-thread.
const std = @import("std");
const curl = @import("../../net/curl.zig");
const multi = @import("../../net/curl_multi.zig");
const observation = @import("rpc_observation.zig");
const rpc = @import("../../evm/provider.zig");
const A = std.mem.Allocator;
pub const Budget = struct { used: usize = 0, maximum: usize = 128 * 1024 * 1024 };
pub const Config = struct { recorder: ?*@import("../../ops/rpc_metrics.zig").Recorder = null, max_requests: usize = 64, max_request_bytes: usize = 1024 * 1024 };
const Entry = struct { position: usize, key: [32]u8, request_id: ?i64, response: ?curl.Response = null, failure: ?anyerror = null, bytes: usize = 0, observation: ?observation.Pending = null };
pub const Cache = struct {
    allocator: A,
    engine: *multi.Multi,
    budget: *Budget,
    config: Config,
    /// Absolute round budget, not a fresh deadline per re-execution.
    deadline_ms: u64,
    now_ms: u64 = 0,
    timer: std.time.Timer,
    entries: std.ArrayList(Entry) = .empty,
    position: usize = 0,
    pending: ?struct { id: multi.Id, entry: usize } = null,
    pub fn init(a: A, engine: *multi.Multi, budget: *Budget, deadline_ms: u64, config: Config) !Cache {
        if (deadline_ms == 0 or config.max_requests == 0 or config.max_requests > 256 or config.max_request_bytes == 0 or budget.maximum == 0 or budget.used > budget.maximum) return error.InvalidReadReplayBudget;
        return .{ .allocator = a, .engine = engine, .budget = budget, .config = config, .deadline_ms = deadline_ms, .timer = try std.time.Timer.start() };
    }
    /// Reset only the logical read cursor, never the verified round cache.
    /// Distinct equal requests (notably before/after block-hash fences) must
    /// produce independent native transfers in their original call positions.
    pub fn beginAttempt(self: *Cache, now_ms: u64) void {
        self.position = 0;
        self.now_ms = now_ms;
    }
    pub fn override(self: *Cache) curl.SendOverride {
        return .{ .context = self, .send_fn = send };
    }
    pub fn expire(self: *Cache) void {
        if (self.pending) |pending| {
            const entry = &self.entries.items[pending.entry];
            const failure: multi.Result = .{ .failure = error.RequestDeadlineExceeded };
            if (entry.observation) |*metric| metric.complete(&failure, self.timer.read());
        }
    }
    pub fn deinit(self: *Cache) void {
        if (self.pending) |p| {
            self.engine.cancel(p.id) catch {};
        }
        for (self.entries.items) |*entry| {
            if (entry.response) |*response| response.deinit();
            self.budget.used -= entry.bytes;
        }
        self.entries.deinit(self.allocator);
        self.* = undefined;
    }
    fn send(ctx: *anyopaque, a: A, original: curl.Request) anyerror!curl.Response {
        const self: *Cache = @ptrCast(@alignCast(ctx));
        if (original.public_only or (original.method != .get and original.method != .post)) return error.InvalidReadReplayRequest;
        if (original.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.now_ms >= self.deadline_ms) return error.RequestDeadlineExceeded;
        if ((original.body orelse "").len > self.config.max_request_bytes) return error.ReadReplayRequestTooLarge;
        if (self.position >= self.config.max_requests) return error.ReadReplayRequestLimit;
        const position = self.position;
        self.position += 1;
        const identity = try requestIdentity(a, original);
        for (self.entries.items) |entry| {
            if (entry.position != position or !std.mem.eql(u8, &entry.key, &identity.key)) continue;
            if (entry.failure) |err| return err;
            if (entry.response) |response| return cloneResponse(a, response, identity.request_id);
            return error.PendingReadIo;
        }
        if (self.pending != null) return error.PendingReadIo;
        if (self.entries.items.len >= self.config.max_requests) return error.ReadReplayRequestLimit;
        try self.entries.ensureUnusedCapacity(self.allocator, 1);
        var request = original;
        request.timeout_ms = @intCast(@min(original.timeout_ms, self.deadline_ms - self.now_ms));
        request.connect_timeout_ms = @min(request.connect_timeout_ms, request.timeout_ms);
        const id = try self.engine.submit(request, self.now_ms);
        const index = self.entries.items.len;
        self.entries.appendAssumeCapacity(.{ .position = position, .key = identity.key, .request_id = identity.request_id, .observation = observation.Pending.init(self.config.recorder, request, self.timer.read()) });
        self.pending = .{ .id = id, .entry = index };
        return error.PendingReadIo;
    }
    /// Ownership moves out of a matching completion. JSON-RPC's ORIGINAL wire
    /// ID is checked before a replay may substitute the new invocation's ID.
    pub fn consume(self: *Cache, completion: *multi.Completion) !bool {
        const pending = self.pending orelse return false;
        if (!std.meta.eql(pending.id, completion.id)) return false;
        self.pending = null;
        const entry = &self.entries.items[pending.entry];
        if (entry.observation) |*metric| metric.complete(&completion.result, self.timer.read());
        switch (completion.result) {
            .failure => |err| entry.failure = err,
            .response => |response| {
                if (entry.request_id != null and response.status == 200) {
                    const id = entry.request_id.?;
                    validateJsonResponse(self.allocator, response.body, id) catch |err| {
                        entry.failure = err;
                        return true;
                    };
                }
                const bytes = try std.math.add(usize, try std.math.add(usize, response.body.len, response.header_storage.len), try std.math.mul(usize, response.headers.len, @sizeOf(curl.Header)));
                if (bytes > self.budget.maximum -| self.budget.used) {
                    entry.failure = error.ReadReplayCacheBudgetExceeded;
                    return true;
                }
                self.budget.used += bytes;
                entry.bytes = bytes;
                entry.response = response;
                completion.result = .{ .failure = error.ReadReplayResponseMoved };
            },
        }
        return true;
    }
};
fn update(hash: *std.crypto.hash.sha2.Sha256, value: []const u8) void {
    var length: [8]u8 = undefined;
    std.mem.writeInt(u64, &length, value.len, .big);
    hash.update(&length);
    hash.update(value);
}
const Identity = struct { key: [32]u8, request_id: ?i64 };
fn requestIdentity(a: A, request: curl.Request) !Identity {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    update(&hash, @tagName(request.method));
    update(&hash, request.url);
    for (request.headers) |header| {
        update(&hash, header.name);
        update(&hash, header.value);
    }
    var id: ?i64 = null;
    const body = request.body orelse "";
    var parsed = std.json.parseFromSlice(std.json.Value, a, body, .{ .duplicate_field_behavior = .@"error" }) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => null,
    };
    defer if (parsed) |*p| p.deinit();
    if (parsed) |*p| {
        if (p.value == .object) {
            if (p.value.object.get("jsonrpc")) |version| {
                if (version == .string and std.mem.eql(u8, version.string, "2.0")) {
                    const method = p.value.object.get("method") orelse return error.InvalidReadReplayRequest;
                    if (method != .string or !readOnlyRpc(method.string)) return error.NonReadOnlyReplayRequest;
                    const value = p.value.object.get("id") orelse return error.InvalidRpcEnvelope;
                    if (value != .integer) return error.InvalidRpcEnvelope;
                    id = value.integer;
                    _ = p.value.object.orderedRemove("id");
                }
            }
        }
    }
    if (id != null) {
        const normalized = try std.json.Stringify.valueAlloc(a, parsed.?.value, .{});
        defer a.free(normalized);
        update(&hash, "jsonrpc");
        update(&hash, normalized);
    } else {
        if (request.method == .post and !readOnlyPost(request.url)) return error.NonReadOnlyReplayRequest;
        update(&hash, "raw");
        update(&hash, body);
    }
    update(&hash, if (request.require_http2) "http2" else "http");
    var bound: [8]u8 = undefined;
    std.mem.writeInt(u64, &bound, request.max_response_bytes, .big);
    update(&hash, &bound);
    return .{ .key = hash.finalResult(), .request_id = id };
}
fn readOnlyRpc(method: []const u8) bool {
    for ([_][]const u8{ "eth_chainId", "eth_call", "eth_getBlockByNumber", "eth_blockNumber", "getAccountInfo", "getGenesisHash", "getSlot", "getBlockHeight", "starknet_blockNumber", "starknet_getBlockWithTxHashes", "starknet_call", "starknet_chainId" }) |allowed| if (std.mem.eql(u8, method, allowed)) return true;
    return false;
}
fn readOnlyPost(url: []const u8) bool {
    const path_end = std.mem.indexOfScalar(u8, url, '?') orelse url.len;
    const path = url[0..path_end];
    const paths = @import("../../cosmos/proto.zig").paths;
    for ([_][]const u8{ paths.latest_validators, paths.smart_query, paths.tree, "/status/network-status", "/transaction/call-preview", "/walletsolidity/triggerconstantcontract" }) |allowed| if (std.mem.endsWith(u8, path, allowed)) return true;
    return false;
}
fn validateJsonResponse(a: A, bytes: []const u8, id: i64) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{ .duplicate_field_behavior = .@"error" });
    defer parsed.deinit();
    _ = try rpc.validateEnvelope(parsed.value, id);
}
fn cloneResponse(a: A, source: curl.Response, request_id: ?i64) !curl.Response {
    const rewrite_id = if (source.status == 200) request_id else null;
    const body = if (rewrite_id) |id| blk: {
        var parsed = try std.json.parseFromSlice(std.json.Value, a, source.body, .{ .duplicate_field_behavior = .@"error" });
        defer parsed.deinit();
        try parsed.value.object.put("id", .{ .integer = id });
        break :blk try std.json.Stringify.valueAlloc(a, parsed.value, .{});
    } else try a.dupe(u8, source.body);
    errdefer a.free(body);
    var length_text: [20]u8 = undefined;
    const body_length = try std.fmt.bufPrint(&length_text, "{d}", .{body.len});
    var length: usize = 0;
    for (source.headers) |header| {
        const value = if (rewrite_id != null and std.ascii.eqlIgnoreCase(header.name, "content-length")) body_length else header.value;
        length = try std.math.add(usize, length, try std.math.add(usize, header.name.len, value.len));
    }
    const storage = try a.alloc(u8, length);
    errdefer a.free(storage);
    const headers = try a.alloc(curl.Header, source.headers.len);
    errdefer a.free(headers);
    var cursor: usize = 0;
    for (source.headers, headers) |header, *out| {
        const name = storage[cursor..][0..header.name.len];
        @memcpy(name, header.name);
        cursor += name.len;
        const source_value = if (rewrite_id != null and std.ascii.eqlIgnoreCase(header.name, "content-length")) body_length else header.value;
        const value = storage[cursor..][0..source_value.len];
        @memcpy(value, source_value);
        cursor += value.len;
        out.* = .{ .name = name, .value = value };
    }
    return .{ .allocator = a, .status = source.status, .http_version = source.http_version, .body = body, .headers = headers, .header_storage = storage };
}
test "read replay identity ignores only RPC correlation ID and validates original response before rewriting" {
    const a = std.testing.allocator;
    const r: curl.Request = .{ .url = "http://127.0.0.1:1", .method = .post, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}" };
    var other = r;
    other.body = "{\"jsonrpc\":\"2.0\",\"id\":999,\"method\":\"eth_chainId\",\"params\":[]}";
    try std.testing.expectEqualSlices(u8, &(try requestIdentity(a, r)).key, &(try requestIdentity(a, other)).key);
    other.url = "http://127.0.0.1:2";
    try std.testing.expect(!std.mem.eql(u8, &(try requestIdentity(a, r)).key, &(try requestIdentity(a, other)).key));
    try validateJsonResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}", 1);
    try std.testing.expectError(error.RpcIdMismatch, validateJsonResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x1\"}", 1));
    try std.testing.expectError(error.DuplicateField, validateJsonResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"id\":1,\"result\":0}", 1));
}

test "read replay cloning owns headers and rewrites correlation ID without modifying cached response" {
    const a = std.testing.allocator;
    var wire = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}".*;
    const source: curl.Response = .{ .allocator = a, .status = 200, .http_version = 2, .body = &wire, .headers = &.{.{ .name = "content-length", .value = "39" }}, .header_storage = &.{} };
    var copy = try cloneResponse(a, source, 999);
    defer copy.deinit();
    try validateJsonResponse(a, copy.body, 999);
    try validateJsonResponse(a, &wire, 1);
    try std.testing.expectEqual(copy.body.len, try std.fmt.parseInt(usize, copy.headers[0].value, 10));
    try curl.validateResponse(.{ .url = "http://127.0.0.1", .method = .post }, copy);
}

fn allocationFixture(a: A) !void {
    const request: curl.Request = .{ .url = "http://127.0.0.1", .method = .post, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}" };
    _ = try requestIdentity(a, request);
    var body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1}".*;
    const source: curl.Response = .{ .allocator = a, .status = 200, .http_version = 2, .body = &body, .headers = &.{.{ .name = "content-type", .value = "application/json" }}, .header_storage = &.{} };
    var copied = try cloneResponse(a, source, 2);
    defer copied.deinit();
}
test "read replay allocation failures unwind and write methods are rejected" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationFixture, .{});
    const request: curl.Request = .{ .url = "http://127.0.0.1", .method = .post, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}" };
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requestIdentity(std.testing.allocator, request));
    try std.testing.expect(!readOnlyPost("http://127.0.0.1/wallet/broadcasthex"));
    try std.testing.expect(!readOnlyPost("http://127.0.0.1/cosmos.tx.v1beta1.Service/BroadcastTx"));
}
