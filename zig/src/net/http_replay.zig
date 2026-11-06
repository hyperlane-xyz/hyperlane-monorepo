//! Read-only REST/gRPC continuation journal over a shared HTTP Runtime. JSON-RPC
//! correlation IDs are authenticated then substituted; protobuf/REST bytes keep
//! exact identity. Before/after equal requests are distinct physical occurrences.
const std = @import("std");
const curl = @import("curl.zig");
const runtime = @import("http_runtime.zig");
const rpc_replay = @import("read_replay.zig");
const metrics = @import("../ops/rpc_metrics.zig");
const A = std.mem.Allocator;
pub const Config = struct { max_attempt_ms: u32 = 120000, max_entries: usize = 512, max_request_bytes: usize = 1024 * 1024, max_cached_bytes: usize = 128 * 1024 * 1024, shared_budget: ?*rpc_replay.ByteBudget = null, recorder: ?*metrics.Recorder = null };
const Entry = struct { key: [32]u8, occurrence: u32, id: ?i64, handle: ?runtime.Handle = null, response: ?curl.Response = null, failure: ?anyerror = null, bytes: usize = 0 };
pub const Replay = struct {
    allocator: A,
    owner: *runtime.Runtime,
    config: Config,
    started: ?std.time.Instant = null,
    in_pass: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    entries: std.ArrayList(Entry) = .empty,
    occurrences: std.AutoHashMapUnmanaged([32]u8, u32) = .empty,
    cached: usize = 0,
    pub fn init(a: A, owner: *runtime.Runtime, config: Config) !Replay {
        if (config.max_attempt_ms == 0 or config.max_attempt_ms > 300000 or config.max_entries == 0 or config.max_entries > 4096 or config.max_request_bytes == 0 or config.max_cached_bytes == 0) return error.InvalidHttpReplayLimit;
        return .{ .allocator = a, .owner = owner, .config = config };
    }
    pub fn deinit(self: *Replay) void {
        self.reset();
        self.entries.deinit(self.allocator);
        self.occurrences.deinit(self.allocator);
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
        self.occurrences.clearRetainingCapacity();
        self.cancel = cancel;
        self.in_pass = true;
    }
    pub fn endPass(self: *Replay, failure: ?anyerror) void {
        self.in_pass = false;
        self.cancel = null;
        if (failure) |err| if (err == error.PendingReadIo) return;
        self.reset();
    }
    pub fn reset(self: *Replay) void {
        self.clear();
        self.occurrences.clearRetainingCapacity();
        self.started = null;
        self.in_pass = false;
        self.cancel = null;
    }
    pub fn hasPending(self: *const Replay) bool {
        for (self.entries.items) |entry| if (entry.handle != null) return true;
        return false;
    }
    pub fn commitReadSection(self: *Replay) !void {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        for (self.entries.items) |entry| if (entry.handle != null) return error.PendingReadSection;
        self.clear();
        self.occurrences.clearRetainingCapacity();
    }
    fn clear(self: *Replay) void {
        for (self.entries.items) |*entry| {
            if (entry.handle) |handle| self.owner.cancel(handle);
            if (entry.response) |*response| response.deinit();
            if (self.config.shared_budget) |budget| budget.release(entry.bytes);
        }
        self.entries.clearRetainingCapacity();
        self.cached = 0;
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
    pub fn fetch(self: *Replay, a: A, original: curl.Request) !curl.Response {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (original.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        _ = try self.remaining();
        const identity = try requestIdentity(a, original, self.config.max_request_bytes);
        const occurrence = try self.occurrences.getOrPut(self.allocator, identity.key);
        if (!occurrence.found_existing) occurrence.value_ptr.* = 0;
        const position = occurrence.value_ptr.*;
        occurrence.value_ptr.* = std.math.add(u32, position, 1) catch return error.ReadReplayRequestLimit;
        for (self.entries.items) |*entry| {
            if (entry.occurrence != position or !std.mem.eql(u8, &entry.key, &identity.key)) continue;
            if (entry.failure) |err| return err;
            if (entry.handle) |handle| {
                var response = self.owner.poll(handle) catch |err| {
                    entry.handle = null;
                    // Preserve source endpoint fallback after a single native
                    // request times out; only absolute attempt expiry is control.
                    const failure = if (err == error.RequestDeadlineExceeded) blk: {
                        _ = self.remaining() catch break :blk error.RequestDeadlineExceeded;
                        break :blk error.UpstreamReadTimeout;
                    } else err;
                    entry.failure = failure;
                    return failure;
                } orelse return error.PendingReadIo;
                entry.handle = null;
                errdefer response.deinit();
                if (entry.id) |id| if (response.status == 200) rpc_replay.validateResponse(self.allocator, response.body, id) catch |err| {
                    entry.failure = err;
                    return err;
                };
                const bytes = try std.math.add(usize, response.body.len, try std.math.add(usize, response.header_storage.len, try std.math.mul(usize, response.headers.len, @sizeOf(curl.Header))));
                if (bytes > self.config.max_cached_bytes -| self.cached) {
                    entry.failure = error.ReadReplayByteBudgetExceeded;
                    return error.ReadReplayByteBudgetExceeded;
                }
                if (self.config.shared_budget) |budget| budget.reserve(bytes) catch |err| {
                    entry.failure = err;
                    return err;
                };
                entry.bytes = bytes;
                entry.response = response;
                self.cached += bytes;
            }
            return cloneResponse(a, entry.response orelse return error.InvalidReadReplayEntry, entry.id, identity.id, original.max_response_bytes);
        }
        if (self.entries.items.len >= self.config.max_entries) return error.ReadReplayRequestLimit;
        try self.entries.ensureUnusedCapacity(self.allocator, 1);
        var request = original;
        request.timeout_ms = @min(request.timeout_ms, try self.remaining());
        request.connect_timeout_ms = @min(request.connect_timeout_ms, request.timeout_ms);
        const observer = if (self.config.recorder) |recorder| try recorder.httpCompletionObserver(request) else null;
        defer if (observer) |o| o.release();
        const handle = self.owner.submit(request, observer) catch |err| switch (err) {
            error.HttpRuntimeSessionsFull, error.HttpRuntimeByteBudgetExceeded => return error.PendingReadIo,
            else => return err,
        };
        self.entries.appendAssumeCapacity(.{ .key = identity.key, .occurrence = position, .id = identity.id, .handle = handle });
        return error.PendingReadIo;
    }
};
const Identity = struct { key: [32]u8, id: ?i64 };
fn hashBytes(hash: *std.crypto.hash.sha2.Sha256, bytes: []const u8) void {
    var size: [8]u8 = undefined;
    std.mem.writeInt(u64, &size, bytes.len, .big);
    hash.update(&size);
    hash.update(bytes);
}
fn requestIdentity(a: A, request: curl.Request, maximum: usize) !Identity {
    try curl.validateRequest(request);
    if (request.public_only or (request.method != .get and request.method != .post)) return error.NonReadOnlyReplayRequest;
    const body = request.body orelse "";
    if (body.len > maximum) return error.ReadReplayRequestTooLarge;
    // Binary protobuf is valid on gRPC routes. JSON-shaped bodies must pass the
    // iterative depth check before the DOM parser or recursive serialization.
    const trimmed = std.mem.trimStart(u8, body, " \t\r\n");
    if (trimmed.len != 0 and (trimmed[0] == '{' or trimmed[0] == '[')) try @import("json_bounds.zig").validate(body);
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hashBytes(&hash, @tagName(request.method));
    hashBytes(&hash, request.url);
    for (request.headers) |header| {
        hashBytes(&hash, header.name);
        hashBytes(&hash, header.value);
    }
    var id: ?i64 = null;
    const parsed = std.json.parseFromSlice(std.json.Value, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false }) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => null,
    };
    defer if (parsed) |value| value.deinit();
    if (parsed) |value| if (value.value == .object and value.value.object.contains("jsonrpc")) {
        const identity = try rpc_replay.requestIdentity(a, body, maximum);
        id = identity.id;
        hashBytes(&hash, &identity.key);
    };
    if (id == null) {
        if (request.method == .post and !readOnlyPost(request.url)) return error.NonReadOnlyReplayRequest;
        hashBytes(&hash, body);
    }
    hashBytes(&hash, if (request.require_http2) "http2" else "http");
    hashBytes(&hash, if (request.stop_after_http429_head) "stop429head" else "fullbody");
    var limit: [8]u8 = undefined;
    std.mem.writeInt(u64, &limit, request.max_response_bytes, .big);
    hashBytes(&hash, &limit);
    return .{ .key = hash.finalResult(), .id = id };
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
fn cloneResponse(a: A, source: curl.Response, original_id: ?i64, id: ?i64, maximum: usize) !curl.Response {
    const body = if (id != null and original_id != null and source.status == 200) try rpc_replay.cloneResponse(a, source.body, original_id.?, id.?, maximum) else try a.dupe(u8, source.body);
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

test "HTTP replay separates complete-body and Ethereum429-head transfer identities" {
    const a = std.testing.allocator;
    var request: curl.Request = .{ .url = "https://fixture.invalid", .method = .get };
    const original = try requestIdentity(a, request, 1024);
    request.stop_after_http429_head = true;
    const changed = try requestIdentity(a, request, 1024);
    try std.testing.expect(!std.mem.eql(u8, &original.key, &changed.key));
}

test "HTTP replay accepts source read routes rejects broadcast and bounds JSON before recursion" {
    const a = std.testing.allocator;
    for ([_][]const u8{
        "/cosmwasm.wasm.v1.Query/SmartContractState", "/walletsolidity/triggerconstantcontract", "/transaction/call-preview", "/stream/transactions",
    }) |path| {
        const url = try std.fmt.allocPrint(a, "https://example.invalid{s}", .{path});
        defer a.free(url);
        _ = try requestIdentity(a, .{ .url = url, .method = .post, .body = "{}" }, 1024);
    }
    for ([_][]const u8{ "/wallet/broadcasttransaction", "/transaction/submit", "/cosmos.tx.v1beta1.Service/BroadcastTx", "/unrecognized" }) |path| {
        const url = try std.fmt.allocPrint(a, "https://example.invalid{s}", .{path});
        defer a.free(url);
        try std.testing.expectError(error.NonReadOnlyReplayRequest, requestIdentity(a, .{ .url = url, .method = .post, .body = "{}" }, 1024));
    }
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requestIdentity(a, .{ .url = "https://example.invalid", .method = .get, .public_only = true }, 1024));
    const write = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}";
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requestIdentity(a, .{ .url = "https://example.invalid", .method = .post, .body = write }, 1024));
    var depth: [258]u8 = undefined;
    @memset(depth[0..129], '[');
    @memset(depth[129..], ']');
    try std.testing.expectError(error.JsonDepthExceeded, requestIdentity(a, .{ .url = "https://example.invalid/status/network-status", .method = .post, .body = &depth }, 1024));
}
