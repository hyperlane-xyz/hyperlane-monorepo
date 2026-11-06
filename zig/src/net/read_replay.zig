//! Cooperative READ-ONLY JSON-RPC continuations over the real endpoint Pool.
//! A miss submits one session and yields PendingReadIo; no Supervisor worker
//! waits for DNS/connect/read. Pool owns cancellation through late completion.
//! Never attach to signing, broadcasting, database or other mutation clients.
//! One retained callback owns this journal; beginPass/endPass bracket replays.
//! Partial durable progress requires an explicit commitReadSection boundary.
const std = @import("std");
const pool = @import("../evm/pool.zig");
const rpc = @import("../evm/provider.zig");
const A = std.mem.Allocator;
const V = std.json.Value;
pub const ByteBudget = @import("byte_budget.zig").Budget;

pub const Config = struct {
    shared_budget: ?*ByteBudget = null,
    max_attempt_ms: u32 = 120000,
    max_entries: usize = 512,
    max_request_bytes: usize = 1024 * 1024,
    max_cached_bytes: usize = 128 * 1024 * 1024,
    /// Opt-in fallback sessions consume this retained owner's remaining budget;
    /// the Pool must separately bound each physical endpoint request.
    use_owner_timeout: bool = false,
};
const Entry = struct { key: [32]u8, occurrence: u32, original_id: i64, handle: ?pool.Handle = null, owner_limited: bool = true, bytes: ?[]u8 = null, failure: ?anyerror = null };
pub const Replay = struct {
    allocator: A,
    pool: *pool.Pool,
    config: Config,
    entries: std.ArrayList(Entry) = .empty,
    occurrences: std.AutoHashMapUnmanaged([32]u8, u32) = .empty,
    started: ?std.time.Instant = null,
    in_pass: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    cached_bytes: usize = 0,
    pub fn init(a: A, runtime: *pool.Pool, config: Config) !Replay {
        if (config.max_attempt_ms == 0 or config.max_attempt_ms > 300000 or config.max_entries == 0 or config.max_entries > 4096 or config.max_request_bytes == 0 or config.max_cached_bytes == 0) return error.InvalidReadReplayLimit;
        if (config.use_owner_timeout and (runtime.config.strategy != .fallback or runtime.config.strategy.fallback.attempt_timeout_ms == null)) return error.MissingReadReplayPhysicalTimeout;
        return .{ .allocator = a, .pool = runtime, .config = config };
    }
    pub fn deinit(self: *Replay) void {
        self.reset();
        self.entries.deinit(self.allocator);
        self.occurrences.deinit(self.allocator);
        self.* = undefined;
    }
    /// Starts a fresh absolute attempt only once; repeated passes do not refresh
    /// its120s budget. Caller cancellation is borrowed only until endPass.
    pub fn beginPass(self: *Replay, cancel: ?*const std.atomic.Value(bool)) !void {
        if (self.in_pass) return error.ReadReplayPassAlreadyActive;
        if (cancel) |flag| if (flag.load(.acquire)) {
            self.reset();
            return error.RequestCancelled;
        };
        if (self.started == null) self.started = try std.time.Instant.now();
        _ = self.remainingMs() catch |err| {
            self.reset();
            return err;
        };
        self.occurrences.clearRetainingCapacity();
        self.cancel = cancel;
        self.in_pass = true;
    }
    /// Only PendingReadIo retains the journal. Every real result/failure closes
    /// the attempt, so a new job never inherits stale canonical observations.
    pub fn endPass(self: *Replay, failure: ?anyerror) void {
        self.cancel = null;
        self.in_pass = false;
        if (failure) |err| if (err == error.PendingReadIo) return;
        self.reset();
    }
    /// Caller must have advanced its durable/controller stage such that the
    /// preceding pure read section will not execute again on callback resume.
    /// Preserves the absolute attempt deadline; refuses unfinished native work.
    pub fn hasPending(self: *const Replay) bool {
        for (self.entries.items) |entry| if (entry.handle != null) return true;
        return false;
    }
    pub fn commitReadSection(self: *Replay) !void {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        for (self.entries.items) |entry| if (entry.handle != null) return error.PendingReadSection;
        self.clearEntries();
        self.occurrences.clearRetainingCapacity();
    }
    pub fn reset(self: *Replay) void {
        self.clearEntries();
        self.occurrences.clearRetainingCapacity();
        self.started = null;
        self.in_pass = false;
        self.cancel = null;
    }
    fn clearEntries(self: *Replay) void {
        for (self.entries.items) |entry| {
            if (entry.handle) |handle| self.pool.cancel(handle);
            if (entry.bytes) |bytes| {
                if (self.config.shared_budget) |budget| budget.release(bytes.len);
                self.allocator.free(bytes);
            }
        }
        self.entries.clearRetainingCapacity();
        self.cached_bytes = 0;
    }
    fn remainingMs(self: *Replay) !u32 {
        const started = self.started orelse return error.ReadReplayPassNotActive;
        const elapsed = (try std.time.Instant.now()).since(started);
        const budget = @as(u64, self.config.max_attempt_ms) * std.time.ns_per_ms;
        if (elapsed >= budget) return error.RequestDeadlineExceeded;
        return @intCast((budget - elapsed + std.time.ns_per_ms - 1) / std.time.ns_per_ms);
    }
    // Called only after a real Pool session has completed. Owner-clamped
    // sessions retain control status even when millisecond rounding leaves a
    // sliver of absolute budget. An injected Pool clock has no physical expiry.
    fn completedFailure(self: *Replay, err: anyerror, owner_limited: bool, request_cancel: ?*const std.atomic.Value(bool)) anyerror {
        if (err != error.RequestDeadlineExceeded or owner_limited or self.pool.config.clock != null) return err;
        if (self.cancel) |flag| if (flag.load(.acquire)) return err;
        if (request_cancel) |flag| if (flag.load(.acquire)) return err;
        _ = self.remainingMs() catch return err;
        return error.UpstreamReadTimeout;
    }
    pub fn interface(self: *Replay) rpc.Exchange {
        return .{ .context = self, .fetch_fn = exchange, .commit_read_section_fn = commit };
    }
    fn commit(context: *anyopaque) anyerror!void {
        const self: *Replay = @ptrCast(@alignCast(context));
        try self.commitReadSection();
    }
    fn exchange(context: *anyopaque, a: A, body: []const u8, options: rpc.Options) anyerror!rpc.WireResponse {
        const self: *Replay = @ptrCast(@alignCast(context));
        return self.fetch(a, body, options);
    }
    pub fn fetch(self: *Replay, a: A, body: []const u8, options: rpc.Options) !rpc.WireResponse {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const remaining = try self.remainingMs();
        var identity = try requestIdentity(a, body, self.config.max_request_bytes);
        // A larger later wire cap cannot inherit a cached small-cap failure;
        // a smaller cap must not reuse a response produced under different bounds.
        var bounded = std.crypto.hash.sha2.Sha256.init(.{});
        bounded.update(&identity.key);
        var bound: [8]u8 = undefined;
        std.mem.writeInt(u64, &bound, options.max_response_bytes, .big);
        bounded.update(&bound);
        identity.key = bounded.finalResult();
        const counter = try self.occurrences.getOrPut(self.allocator, identity.key);
        if (!counter.found_existing) counter.value_ptr.* = 0;
        const occurrence = counter.value_ptr.*;
        counter.value_ptr.* = std.math.add(u32, occurrence, 1) catch return error.ReadReplayRequestLimit;
        for (self.entries.items) |*entry| {
            if (entry.occurrence != occurrence or !std.mem.eql(u8, &entry.key, &identity.key)) continue;
            if (entry.failure) |err| return err;
            if (entry.handle) |handle| {
                const result = self.pool.poll(handle, self.allocator) catch |err| {
                    entry.handle = null;
                    const failure = self.completedFailure(err, entry.owner_limited, options.cancel);
                    entry.failure = failure;
                    return failure;
                } orelse return error.PendingReadIo;
                entry.handle = null;
                if (result.bytes.len > self.config.max_cached_bytes -| self.cached_bytes) {
                    self.allocator.free(result.bytes);
                    entry.failure = error.ReadReplayByteBudgetExceeded;
                    return error.ReadReplayByteBudgetExceeded;
                }
                validateResponse(self.allocator, result.bytes, entry.original_id) catch |err| {
                    self.allocator.free(result.bytes);
                    entry.failure = err;
                    return err;
                };
                if (self.config.shared_budget) |budget| budget.reserve(result.bytes.len) catch |err| {
                    self.allocator.free(result.bytes);
                    entry.failure = err;
                    return err;
                };
                entry.bytes = result.bytes;
                self.cached_bytes += result.bytes.len;
            }
            const bytes = try cloneResponse(a, entry.bytes orelse return error.InvalidReadReplayEntry, entry.original_id, identity.id, options.max_response_bytes);
            return .{ .bytes = bytes, .len = bytes.len };
        }
        if (self.entries.items.len >= self.config.max_entries) return error.ReadReplayRequestLimit;
        try self.entries.ensureUnusedCapacity(self.allocator, 1);
        const timeout = if (self.config.use_owner_timeout) remaining else @min(options.timeout_ms, remaining);
        const handle = self.pool.submitObservedCached(body, timeout, @min(options.connect_timeout_ms, timeout), options.max_response_bytes, options.pool_observer, options.indexer_tip_cache) catch |err| switch (err) {
            // Retiring cancelled sessions own slots until native drain. Yield
            // under the same deadline; never reinterpret pressure as success.
            error.RpcPoolSessionsFull => return error.PendingReadIo,
            else => return err,
        };
        self.entries.appendAssumeCapacity(.{ .key = identity.key, .occurrence = occurrence, .original_id = identity.id, .handle = handle, .owner_limited = self.config.use_owner_timeout or remaining <= options.timeout_ms });
        return error.PendingReadIo;
    }
};
pub const Identity = struct { key: [32]u8, id: i64 };
fn readOnly(method: []const u8) bool {
    const methods = [_][]const u8{ "eth_chainId", "net_version", "eth_blockNumber", "eth_call", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs", "eth_getCode", "eth_getStorageAt", "eth_getProof", "eth_getBalance", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_estimateGas", "eth_createAccessList", "getGenesisHash", "getBalance", "getSlot", "getBlockHeight", "getLatestBlockhash", "getSignatureStatuses", "getAccountInfo", "getProgramAccounts", "getSignaturesForAddress", "getTransaction", "getBlock", "getFeeForMessage", "getRecentPrioritizationFees", "simulateTransaction", "status", "block", "block_results", "tx", "tx_search", "abci_query", "starknet_chainId", "starknet_blockNumber", "starknet_getBlockWithTxHashes", "starknet_getBlockWithTxs", "starknet_getTransactionByHash", "starknet_getTransactionReceipt", "starknet_getEvents", "starknet_call", "starknet_getClassHashAt", "starknet_getNonce", "starknet_estimateFee" };
    for (methods) |allowed| if (std.mem.eql(u8, method, allowed)) return true;
    return false;
}
pub fn requestIdentity(a: A, body: []const u8, maximum: usize) !Identity {
    if (body.len == 0 or body.len > maximum) return error.ReadReplayRequestTooLarge;
    var parsed = try std.json.parseFromSlice(V, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = maximum });
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidRpcRequest;
    const object = &parsed.value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcRequest;
    const method = object.get("method") orelse return error.InvalidRpcRequest;
    const id = object.get("id") orelse return error.InvalidRpcRequest;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0") or method != .string or id != .number_string) return error.InvalidRpcRequest;
    if (!readOnly(method.string)) return error.NonReadOnlyReplayRequest;
    const number = std.fmt.parseInt(i64, id.number_string, 10) catch return error.InvalidRpcRequest;
    _ = object.orderedRemove("id");
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    try hashValue(a, &hash, parsed.value, 0);
    return .{ .key = hash.finalResult(), .id = number };
}
fn hashBytes(hash: *std.crypto.hash.sha2.Sha256, bytes: []const u8) void {
    var length: [8]u8 = undefined;
    std.mem.writeInt(u64, &length, bytes.len, .big);
    hash.update(&length);
    hash.update(bytes);
}
fn hashValue(a: A, hash: *std.crypto.hash.sha2.Sha256, value: V, depth: usize) !void {
    if (depth > 128) return error.ReadReplayJsonDepth;
    hash.update(&.{@intFromEnum(value)});
    switch (value) {
        .null => {},
        .bool => |boolean| hash.update(&.{@intFromBool(boolean)}),
        .string, .number_string => |bytes| hashBytes(hash, bytes),
        .array => |array| {
            var count: [8]u8 = undefined;
            std.mem.writeInt(u64, &count, array.items.len, .big);
            hash.update(&count);
            for (array.items) |item| try hashValue(a, hash, item, depth + 1);
        },
        .object => |object| {
            const keys = try a.dupe([]const u8, object.keys());
            defer a.free(keys);
            std.mem.sort([]const u8, keys, {}, struct {
                fn less(_: void, left: []const u8, right: []const u8) bool {
                    return std.mem.lessThan(u8, left, right);
                }
            }.less);
            var count: [8]u8 = undefined;
            std.mem.writeInt(u64, &count, keys.len, .big);
            hash.update(&count);
            for (keys) |key| {
                hashBytes(hash, key);
                try hashValue(a, hash, object.get(key).?, depth + 1);
            }
        },
        // parse_numbers=false is mandatory: never round large remote integers.
        .integer, .float => return error.InvalidReplayNumberRepresentation,
    }
}
pub fn validateResponse(a: A, body: []const u8, expected_id: i64) !void {
    try @import("json_bounds.zig").validate(body);
    const parsed = try std.json.parseFromSlice(V, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false });
    defer parsed.deinit();
    try validateValue(parsed.value, expected_id);
}
fn validateValue(value: V, expected_id: i64) !void {
    if (value != .object) return error.InvalidRpcEnvelope;
    const object = value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcEnvelope;
    const id = object.get("id") orelse return error.InvalidRpcEnvelope;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0") or id != .number_string) return error.InvalidRpcEnvelope;
    if ((std.fmt.parseInt(i64, id.number_string, 10) catch return error.RpcIdMismatch) != expected_id) return error.RpcIdMismatch;
    if (object.contains("result") == object.contains("error")) return error.InvalidRpcEnvelope;
    if (object.get("error")) |rpc_error| {
        if (rpc_error != .object) return error.InvalidRpcEnvelope;
        const code = rpc_error.object.get("code") orelse return error.InvalidRpcEnvelope;
        const message = rpc_error.object.get("message") orelse return error.InvalidRpcEnvelope;
        if (code != .number_string or message != .string) return error.InvalidRpcEnvelope;
        _ = std.fmt.parseInt(i64, code.number_string, 10) catch return error.InvalidRpcEnvelope;
    }
}
pub fn cloneResponse(a: A, body: []const u8, original_id: i64, requested_id: i64, maximum: usize) ![]u8 {
    if (body.len > maximum) return error.ResponseTooLarge;
    if (original_id == requested_id) return a.dupe(u8, body);
    var parsed = try std.json.parseFromSlice(V, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false });
    defer parsed.deinit();
    try validateValue(parsed.value, original_id);
    parsed.value.object.getPtr("id").?.* = .{ .integer = requested_id };
    const bytes = try std.json.Stringify.valueAlloc(a, parsed.value, .{});
    errdefer a.free(bytes);
    if (bytes.len > maximum) return error.ResponseTooLarge;
    return bytes;
}

test "cooperative RPC replay identity preserves exact numbers, normalizes keys, forbids writes" {
    const a = std.testing.allocator;
    const first = try requestIdentity(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x1\",\"n\":9007199254740993}]}", 4096);
    const second = try requestIdentity(a, "{\"params\":[{\"n\":9007199254740993,\"to\":\"0x1\"}],\"method\":\"eth_call\",\"id\":99,\"jsonrpc\":\"2.0\"}", 4096);
    try std.testing.expectEqualSlices(u8, &first.key, &second.key);
    const changed = try requestIdentity(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x1\",\"n\":9007199254740992}]}", 4096);
    try std.testing.expect(!std.mem.eql(u8, &first.key, &changed.key));
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requestIdentity(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}", 4096));
    const copied = try cloneResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":9007199254740993}", 1, 99, 4096);
    defer a.free(copied);
    try std.testing.expect(std.mem.indexOf(u8, copied, "9007199254740993") != null);
    try validateResponse(a, copied, 99);
    try std.testing.expectError(error.RpcIdMismatch, cloneResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}", 1, 99, 4096));
}

test "cooperative shared replay byte budget rejects overflow and releases exact reservations" {
    var budget: ByteBudget = .{ .maximum = 8 };
    try budget.reserve(5);
    try std.testing.expectError(error.ReadReplayGlobalByteBudgetExceeded, budget.reserve(4));
    try std.testing.expectEqual(@as(usize, 5), budget.used);
    budget.release(5);
    try budget.reserve(8);
    budget.release(8);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
}
fn allocationCases(a: A) !void {
    _ = try requestIdentity(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"0x1\",\"address\":[\"0x01\"],\"topics\":[[\"0x02\"]]}]}", 4096);
    const copied = try cloneResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":9007199254740993,\"items\":[1,2,3]}}", 1, 999, 4096);
    defer a.free(copied);
    try validateResponse(a, copied, 999);
}
test "cooperative JSON identity and ID substitution free every partial allocation" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationCases, .{});
}

test "cooperative RPC completed timeout preserves owner clamp expiry cancellation and injected clocks" {
    var runtime: pool.Pool = undefined;
    runtime.config.clock = null;
    var value: Replay = .{ .allocator = std.testing.allocator, .pool = &runtime, .config = .{ .max_attempt_ms = 1000 }, .started = try std.time.Instant.now() };
    try std.testing.expectEqual(error.UpstreamReadTimeout, value.completedFailure(error.RequestDeadlineExceeded, false, null));
    // Even with positive remainingMs, an owner-clamped request is control. This
    // covers equal limits and the sub-millisecond ceil at the owner boundary.
    try std.testing.expectEqual(error.RequestDeadlineExceeded, value.completedFailure(error.RequestDeadlineExceeded, true, null));
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectEqual(error.RequestDeadlineExceeded, value.completedFailure(error.RequestDeadlineExceeded, false, &cancel));
    value.cancel = &cancel;
    try std.testing.expectEqual(error.RequestDeadlineExceeded, value.completedFailure(error.RequestDeadlineExceeded, false, null));
    value.cancel = null;
    value.config.max_attempt_ms = 1;
    std.Thread.sleep(2 * std.time.ns_per_ms);
    try std.testing.expectEqual(error.RequestDeadlineExceeded, value.completedFailure(error.RequestDeadlineExceeded, false, null));
    value.config.max_attempt_ms = 1000;
    var context: u8 = 0;
    runtime.config.clock = .{ .context = &context, .now_ms_fn = struct {
        fn now(_: *anyopaque) u64 {
            return 0;
        }
    }.now };
    try std.testing.expectEqual(error.RequestDeadlineExceeded, value.completedFailure(error.RequestDeadlineExceeded, false, null));
    try std.testing.expectEqual(error.PendingReadIo, value.completedFailure(error.PendingReadIo, false, null));
}
