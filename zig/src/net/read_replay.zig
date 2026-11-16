//! Cooperative READ-ONLY JSON-RPC reads over the real endpoint Pool. Every
//! fetch submits one session and waits for it: a fiber parks (its worker runs
//! other fibers), a thread drives the session inline. The callback is never
//! replayed, so nothing is journaled, hashed or cloned. beginPass/endPass keep
//! one absolute attempt deadline and borrow the caller's cancellation. Each
//! attempt (or committed section) is bounded in physical requests and response
//! bytes, the bytes also against an optional budget shared across forks.
//! Never attach to signing, broadcasting, database or other mutation clients.
const std = @import("std");
const pool = @import("../evm/pool.zig");
const rpc = @import("../evm/provider.zig");
const fiber = @import("../runtime/fiber.zig");
const envelope = @import("json_envelope.zig");
const A = std.mem.Allocator;
pub const ByteBudget = @import("byte_budget.zig").Budget;

pub const Config = struct {
    /// Response bytes of every live attempt are reserved here too, so
    /// concurrently executing forks share one bound.
    shared_budget: ?*ByteBudget = null,
    max_attempt_ms: u32 = 120000,
    /// Physical requests one attempt (or committed section) may submit.
    max_entries: usize = 512,
    max_request_bytes: usize = 1024 * 1024,
    /// Response bytes one attempt (or committed section) may receive.
    max_cached_bytes: usize = 128 * 1024 * 1024,
    /// Opt-in fallback sessions consume this retained owner's remaining budget;
    /// the Pool must separately bound each physical endpoint request.
    use_owner_timeout: bool = false,
};
/// Largest independent read batch overlapped by `Replay.fetchMany`.
pub const max_batch = 64;
/// Per-attempt read bounds shared by the RPC and HTTP read owners. Requests
/// count at submission (failed ones too); response bytes count on arrival and
/// are reserved from the shared budget until the section or attempt closes.
pub const Quota = struct {
    max_requests: usize,
    max_bytes: usize,
    shared: ?*ByteBudget,
    requests: usize = 0,
    bytes: usize = 0,
    pub fn admit(self: *Quota) !void {
        if (self.requests >= self.max_requests) return error.ReadReplayRequestLimit;
        self.requests += 1;
    }
    pub fn charge(self: *Quota, bytes: usize) !void {
        if (bytes > self.max_bytes -| self.bytes) return error.ReadReplayByteBudgetExceeded;
        if (self.shared) |budget| try budget.reserve(bytes);
        self.bytes += bytes;
    }
    pub fn release(self: *Quota) void {
        if (self.shared) |budget| budget.release(self.bytes);
        self.requests = 0;
        self.bytes = 0;
    }
};
pub const Replay = struct {
    allocator: A,
    pool: *pool.Pool,
    config: Config,
    started: ?std.time.Instant = null,
    in_pass: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    quota: Quota,
    pub fn init(a: A, runtime: *pool.Pool, config: Config) !Replay {
        if (config.max_attempt_ms == 0 or config.max_attempt_ms > 300000 or config.max_entries == 0 or config.max_entries > 4096 or config.max_request_bytes == 0 or config.max_cached_bytes == 0) return error.InvalidReadReplayLimit;
        if (config.use_owner_timeout and (runtime.config.strategy != .fallback or runtime.config.strategy.fallback.attempt_timeout_ms == null)) return error.MissingReadReplayPhysicalTimeout;
        return .{ .allocator = a, .pool = runtime, .config = config, .quota = .{ .max_requests = config.max_entries, .max_bytes = config.max_cached_bytes, .shared = config.shared_budget } };
    }
    pub fn deinit(self: *Replay) void {
        self.reset();
        self.* = undefined;
    }
    /// Starts a fresh absolute attempt only once; repeated passes do not refresh
    /// its budget. Caller cancellation is borrowed only until endPass.
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
        self.cancel = cancel;
        self.in_pass = true;
    }
    /// A pass suspended by another source (PendingReadIo) keeps the absolute
    /// attempt deadline and quota; every other result closes the attempt.
    pub fn endPass(self: *Replay, failure: ?anyerror) void {
        self.cancel = null;
        self.in_pass = false;
        if (failure) |err| if (err == error.PendingReadIo) return;
        self.reset();
    }
    /// Every read completes before fetch returns: no session outlives a call.
    pub fn hasPending(_: *const Replay) bool {
        return false;
    }
    /// Closes a read section: its request/byte quota is released while the
    /// absolute attempt deadline is kept.
    pub fn commitReadSection(self: *Replay) !void {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        self.quota.release();
    }
    pub fn reset(self: *Replay) void {
        self.quota.release();
        self.started = null;
        self.in_pass = false;
        self.cancel = null;
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
    /// Pass, cancellation and absolute deadline checks; returns the remainder.
    fn admit(self: *Replay, options: rpc.Options) !u32 {
        if (!self.in_pass) return error.ReadReplayPassNotActive;
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        return self.remainingMs();
    }
    /// One physical read: submit, then park (fiber) or drive (thread) until
    /// its response, deadline or cancellation.
    pub fn fetch(self: *Replay, a: A, body: []const u8, options: rpc.Options) !rpc.WireResponse {
        const remaining = try self.admit(options);
        const handle = try self.submit(a, body, options, remaining);
        return self.wait(a, handle, options, remaining);
    }
    fn submit(self: *Replay, a: A, body: []const u8, options: rpc.Options, remaining: u32) !pool.Handle {
        const request = try scanReadOnly(a, body, self.config.max_request_bytes);
        try self.quota.admit();
        const timeout = if (self.config.use_owner_timeout) remaining else @min(options.timeout_ms, remaining);
        while (true) {
            return self.pool.submitScanned(body, &request.top, timeout, @min(options.connect_timeout_ms, timeout), options.max_response_bytes, options.pool_observer, options.indexer_tip_cache) catch |err| {
                // Retiring sessions own slots until native drain: wait for one
                // within this attempt (rare; bounded by deadline and cancel).
                if (err != error.RpcPoolSessionsFull) return err;
                if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
                if (options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
                _ = try self.remainingMs();
                var nap: fiber.Waiter = .{};
                _ = nap.waitTimeout(fiber.monoMs() + 1); // parks a fiber, sleeps a thread
                continue;
            };
        }
    }
    fn wait(self: *Replay, a: A, handle: pool.Handle, options: rpc.Options, remaining: u32) !rpc.WireResponse {
        const timeout = if (self.config.use_owner_timeout) remaining else @min(options.timeout_ms, remaining);
        const owner_limited = self.config.use_owner_timeout or remaining <= options.timeout_ms;
        const response = self.pool.waitCancels(handle, a, self.pool.now() +| timeout, .{ .first = self.cancel, .second = options.cancel }) catch |err| return self.completedFailure(err, owner_limited, options.cancel);
        self.quota.charge(response.len) catch |err| {
            a.free(response.bytes);
            return err;
        };
        return .{ .bytes = response.bytes, .len = response.len, .validated = response.validated };
    }
    /// Independent reads of one callback: submit every session, then wait for
    /// each (one driver progresses all of them concurrently).
    /// All-or-error: no `out` entry remains allocated on error.
    pub fn fetchMany(self: *Replay, a: A, bodies: []const []const u8, options: rpc.Options, out: []rpc.WireResponse) !void {
        if (bodies.len != out.len or bodies.len > max_batch) return error.InvalidRpcBatch;
        const remaining = try self.admit(options);
        var handles: [max_batch]pool.Handle = undefined;
        var submitted: usize = 0;
        var filled: usize = 0;
        defer if (filled != bodies.len) for (out[0..filled]) |wire| a.free(wire.bytes);
        // Every wait consumes its handle; cancel is idempotent.
        defer for (handles[filled..submitted]) |handle| self.pool.cancel(handle);
        for (bodies) |body| {
            handles[submitted] = try self.submit(a, body, options, remaining);
            submitted += 1;
        }
        for (handles[0..submitted]) |handle| {
            out[filled] = try self.wait(a, handle, options, remaining);
            filled += 1;
        }
    }
};
/// One scan of a read request: the policy's facts plus the scan the Pool
/// adopts, so the body is tokenized once and never parsed into a tree.
pub const ReadRequest = struct { top: envelope.Top, id: i64 };
/// Read-only JSON-RPC envelope/method policy (std.json parse semantics:
/// syntax and duplicate keys in document order, no depth bound). Remote
/// integers are never rounded: the id is the exact i64 spelling.
pub fn scanReadOnly(a: A, body: []const u8, maximum: usize) !ReadRequest {
    if (body.len == 0 or body.len > maximum) return error.ReadReplayRequestTooLarge;
    const top = try envelope.scan(a, body, .{});
    return .{ .top = top, .id = try readOnlyId(&top, body) };
}
/// The policy on an existing scan of `body`.
pub fn readOnlyId(top: *const envelope.Top, body: []const u8) !i64 {
    const facts = try envelope.requestFacts(top, body);
    var buffer: [64]u8 = undefined;
    const method = envelope.stringIn(&buffer, facts.method.span.of(body)) orelse return error.NonReadOnlyReplayRequest;
    if (!readOnly(method)) return error.NonReadOnlyReplayRequest;
    return std.fmt.parseInt(i64, facts.id.of(body), 10) catch return error.InvalidRpcRequest;
}
/// Returns the correlation id of an allowed read request.
pub fn requireReadOnly(a: A, body: []const u8, maximum: usize) !i64 {
    return (try scanReadOnly(a, body, maximum)).id;
}
pub fn readOnly(method: []const u8) bool {
    const methods = [_][]const u8{ "eth_chainId", "net_version", "eth_blockNumber", "eth_call", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs", "eth_getCode", "eth_getStorageAt", "eth_getProof", "eth_getBalance", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_estimateGas", "eth_createAccessList", "getGenesisHash", "getBalance", "getSlot", "getBlockHeight", "getLatestBlockhash", "getSignatureStatuses", "getAccountInfo", "getProgramAccounts", "getSignaturesForAddress", "getTransaction", "getBlock", "getFeeForMessage", "getRecentPrioritizationFees", "simulateTransaction", "status", "block", "block_results", "tx", "tx_search", "abci_query", "starknet_chainId", "starknet_blockNumber", "starknet_getBlockWithTxHashes", "starknet_getBlockWithTxs", "starknet_getTransactionByHash", "starknet_getTransactionReceipt", "starknet_getEvents", "starknet_call", "starknet_getClassHashAt", "starknet_getNonce", "starknet_estimateFee" };
    for (methods) |allowed| if (std.mem.eql(u8, method, allowed)) return true;
    return false;
}
pub fn validateResponse(a: A, body: []const u8, expected_id: i64) !void {
    var response = try envelope.validateResponse(a, body, expected_id, .replay);
    response.deinit();
}

test "cooperative RPC read policy keeps exact ids, forbids writes and malformed envelopes" {
    const a = std.testing.allocator;
    try std.testing.expectEqual(@as(i64, 7), try requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x1\",\"n\":9007199254740993}]}", 4096));
    try std.testing.expectEqual(@as(i64, 1), try requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"method\":\"getBalance\",\"params\":[],\"id\":1}", 4096));
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}", 4096));
    try std.testing.expectError(error.NonReadOnlyReplayRequest, requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sendTransaction\",\"params\":[]}", 4096));
    try std.testing.expectError(error.InvalidRpcRequest, requireReadOnly(a, "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"eth_call\"}", 4096));
    try std.testing.expectError(error.InvalidRpcRequest, requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"eth_call\"}", 4096));
    try std.testing.expectError(error.InvalidRpcRequest, requireReadOnly(a, "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\"}]", 4096));
    try std.testing.expectError(error.ReadReplayRequestTooLarge, requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\"}", 8));
    try std.testing.expectError(error.ReadReplayRequestTooLarge, requireReadOnly(a, "", 8));
    try validateResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":99,\"result\":9007199254740993}", 99);
    try std.testing.expectError(error.RpcIdMismatch, validateResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}", 1));
    try std.testing.expectError(error.InvalidRpcEnvelope, validateResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":1}", 1));
}

test "cooperative read quota bounds requests and bytes per section and releases shared reservations" {
    var shared: ByteBudget = .{ .maximum = 10 };
    var quota: Quota = .{ .max_requests = 2, .max_bytes = 8, .shared = &shared };
    try quota.admit();
    try quota.admit();
    try std.testing.expectError(error.ReadReplayRequestLimit, quota.admit());
    try quota.charge(5);
    try std.testing.expectError(error.ReadReplayByteBudgetExceeded, quota.charge(4));
    try std.testing.expectEqual(@as(usize, 5), shared.used);
    var other: Quota = .{ .max_requests = 2, .max_bytes = 8, .shared = &shared };
    try std.testing.expectError(error.ReadReplayGlobalByteBudgetExceeded, other.charge(6));
    quota.release();
    try std.testing.expectEqual(@as(usize, 0), shared.used);
    try quota.admit();
    try other.charge(6);
    other.release();
    try std.testing.expectEqual(@as(usize, 0), shared.used);
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
    _ = try requireReadOnly(a, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"0x1\",\"address\":[\"0x01\"],\"topics\":[[\"0x02\"]]}]}", 4096);
    try validateResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":999,\"result\":{\"n\":9007199254740993,\"items\":[1,2,3]}}", 999);
}
test "cooperative JSON read policy and response validation free every partial allocation" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationCases, .{});
}

test "cooperative RPC completed timeout preserves owner clamp expiry cancellation and injected clocks" {
    var runtime: pool.Pool = undefined;
    runtime.config.clock = null;
    var value: Replay = .{ .allocator = std.testing.allocator, .pool = &runtime, .config = .{ .max_attempt_ms = 1000 }, .started = try std.time.Instant.now(), .quota = .{ .max_requests = 1, .max_bytes = 1, .shared = null } };
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

test "cooperative RPC fetch enforces pass, cancellation, deadline and read-only policy before any submit" {
    const a = std.testing.allocator;
    // Never touched: every case fails before submission.
    var runtime: pool.Pool = undefined;
    var value = try Replay.init(a, &runtime, .{ .max_attempt_ms = 20 });
    defer value.deinit();
    const read = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}";
    const write = "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_sendRawTransaction\",\"params\":[]}";
    try std.testing.expectError(error.ReadReplayPassNotActive, value.fetch(a, read, .{}));
    try value.beginPass(null);
    try std.testing.expectError(error.ReadReplayPassAlreadyActive, value.beginPass(null));
    try std.testing.expect(!value.hasPending());
    try value.commitReadSection();
    try std.testing.expectError(error.NonReadOnlyReplayRequest, value.fetch(a, write, .{}));
    var out: [1]rpc.WireResponse = undefined;
    try std.testing.expectError(error.NonReadOnlyReplayRequest, value.fetchMany(a, &.{write}, .{}, &out));
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, value.fetch(a, read, .{ .cancel = &cancelled }));
    // A suspension by another source keeps the absolute attempt start; later
    // passes never refresh the budget.
    const started = value.started.?;
    value.endPass(error.PendingReadIo);
    try value.beginPass(null);
    try std.testing.expectEqual(started, value.started.?);
    value.endPass(error.PendingReadIo);
    std.Thread.sleep(25 * std.time.ns_per_ms);
    try std.testing.expectError(error.RequestDeadlineExceeded, value.beginPass(null));
    try std.testing.expect(value.started == null);
    try std.testing.expectError(error.RequestCancelled, value.beginPass(&cancelled));
}
