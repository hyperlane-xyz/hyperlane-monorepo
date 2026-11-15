//! Concurrent per-endpoint JSON-RPC vote FSM driven by one libcurl multi owner.
//! A single absolute endpoint deadline covers chain ID through final hash fence.
//! The multi (and its keep-alive/TLS connection cache) lives in a caller-owned
//! Engine for the role's lifetime; no transfer outlives one collect call.
const std = @import("std");
const multi = @import("../../net/curl_multi.zig");
const observation = @import("rpc_observation.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const objects = @import("../../storage/objects.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;
pub const Result = struct { identity_ready: bool = false, checkpoint: ?protocol.Checkpoint = null, head: ?rpc.BlockHeader = null, count: ?u32 = null, chain_checked: bool = false, ready: bool = false, failure: ?anyerror = null };
pub const Endpoint = struct { client: *rpc.RpcClient, chain_checked: bool };
pub const Config = struct { identity_only: bool = false, recorder: ?*@import("../../ops/rpc_metrics.zig").Recorder = null, library_path: []const u8, chain_id: u256, domain: u32, hook: abi.Address, hook_hash: [32]u8, reorg_period: objects.ReorgPeriod, timeout_ms: u32 = 20000, connect_timeout_ms: u32 = 5000, cancel: ?*const std.atomic.Value(bool) = null, max_response_bytes: usize = 8 * 1024 * 1024 };
const Phase = enum { chain, tip, head, count, checkpoint, fence, done };
const Slot = struct { observation: ?observation.Pending = null, phase: Phase, id: ?multi.Id = null, rpc_id: i64 = 0, deadline_ms: u64, number: ?u64 = null, result: Result };
/// Role-lifetime vote transport. Owner thread only. Reusing one multi keeps
/// per-endpoint connections alive across rounds instead of reconnecting (and
/// re-handshaking TLS) every round.
pub const Engine = struct {
    multi: ?*multi.Multi = null,
    /// Size once for the role's full endpoint set so sequential single-endpoint
    /// classic reads and full quorum rounds share one connection cache.
    min_capacity: usize = 1,
    capacity: usize = 0,
    max_response_bytes: usize = 0,
    clock: ?std.time.Timer = null,
    pub fn deinit(self: *Engine) void {
        if (self.multi) |value| value.deinit();
        self.* = .{};
    }
    fn acquire(self: *Engine, a: A, config: Config, capacity: usize) !*multi.Multi {
        if (self.clock == null) self.clock = try std.time.Timer.start();
        if (self.multi) |value| {
            if (self.capacity >= capacity and self.max_response_bytes == config.max_response_bytes) return value;
            self.reset();
        }
        const size = @max(capacity, self.min_capacity);
        const pending: u16 = @intCast(size);
        var engine_config: multi.Config = .{ .library_path = config.library_path, .max_concurrent = pending, .max_pending = pending, .max_response_bytes = config.max_response_bytes };
        engine_config.max_reserved_bytes = try std.math.mul(usize, size, try engine_config.maxReservationPerRequest());
        self.multi = try multi.Multi.init(a, engine_config);
        self.capacity = size;
        self.max_response_bytes = config.max_response_bytes;
        return self.multi.?;
    }
    /// Drops cached connections; used only when a round could not be drained.
    fn reset(self: *Engine) void {
        if (self.multi) |value| value.deinit();
        self.multi = null;
        self.capacity = 0;
    }
    fn nowNs(self: *Engine) u64 {
        return self.clock.?.read();
    }
    fn nowMs(self: *Engine) u64 {
        return self.nowNs() / std.time.ns_per_ms;
    }
};
/// Bounded so borrowed cancellation flags are observed promptly even when no
/// socket becomes ready; libcurl timers and request deadlines shorten it.
const max_wait_ms: u32 = 50;
fn waitForSockets(engine: *multi.Multi, now_ms: u64) !void {
    if (comptime @hasDecl(multi.Multi, "wait")) return engine.wait(now_ms, max_wait_ms);
    std.Thread.sleep(500 * std.time.ns_per_us);
}
const Runner = struct {
    a: A,
    engine: *multi.Multi,
    endpoints: []const Endpoint,
    slots: []Slot,
    config: Config,
    owner: *Engine,
    fn request(self: *Runner, index: usize, method: []const u8, params: anytype, now: u64) !void {
        const slot = &self.slots[index];
        if (now >= slot.deadline_ms) return error.RequestDeadlineExceeded;
        const client = self.endpoints[index].client;
        if (client.next_id == std.math.maxInt(i64)) return error.RpcIdExhausted;
        slot.rpc_id = client.next_id;
        client.next_id += 1;
        const body = try std.json.Stringify.valueAlloc(self.a, .{ .jsonrpc = "2.0", .id = slot.rpc_id, .method = method, .params = params }, .{});
        defer self.a.free(body);
        const remaining: u32 = @intCast(@min(std.math.maxInt(u32), slot.deadline_ms - now));
        const request_: @import("../../net/curl.zig").Request = .{ .url = client.url, .method = .post, .headers = client.native_headers, .body = body, .timeout_ms = remaining, .connect_timeout_ms = @min(remaining, self.config.connect_timeout_ms), .max_response_bytes = self.config.max_response_bytes, .cancel = self.config.cancel };
        slot.id = try self.engine.submit(request_, now);
        slot.observation = observation.Pending.init(self.config.recorder, request_, self.owner.nowNs());
    }
    fn submit(self: *Runner, index: usize, now: u64) !void {
        const slot = &self.slots[index];
        const client = self.endpoints[index].client;
        switch (slot.phase) {
            .chain => try self.request(index, "eth_chainId", .{}, now),
            .tip => try self.request(index, "eth_blockNumber", .{}, now),
            .head => {
                const tag = if (slot.number) |n| try abi.quantityAlloc(self.a, n) else try self.a.dupe(u8, switch (self.config.reorg_period) {
                    .tag => |t| t,
                    else => "latest",
                });
                defer self.a.free(tag);
                try self.request(index, "eth_getBlockByNumber", .{ tag, false }, now);
            },
            .count, .checkpoint => {
                const call_data = try abi.hexAlloc(self.a, &abi.selector(if (slot.phase == .count) "count()" else "latestCheckpoint()"));
                defer self.a.free(call_data);
                const to = try abi.hexAlloc(self.a, &self.config.hook);
                defer self.a.free(to);
                const tag = try abi.quantityAlloc(self.a, slot.result.head.?.number);
                defer self.a.free(tag);
                try self.request(index, "eth_call", .{ .{ .to = to, .data = call_data }, tag }, now);
            },
            .fence => {
                const tag = try abi.quantityAlloc(self.a, slot.result.head.?.number);
                defer self.a.free(tag);
                try self.request(index, "eth_getBlockByNumber", .{ tag, false }, now);
            },
            .done => {},
        }
        _ = client;
    }
    fn afterChain(self: *Runner, index: usize) void {
        const slot = &self.slots[index];
        slot.phase = if (self.config.reorg_period == .blocks and self.config.reorg_period.blocks > 0) .tip else .head;
    }
    fn handleResponse(self: *Runner, index: usize, response: @import("../../net/curl.zig").Response, now: u64) !void {
        if (response.status != 200) return error.RpcHttpStatus;
        const parsed = try std.json.parseFromSlice(std.json.Value, self.a, response.body, .{ .duplicate_field_behavior = .@"error", .max_value_len = self.config.max_response_bytes });
        defer parsed.deinit();
        const slot = &self.slots[index];
        const code = try rpc.validateEnvelope(parsed.value, slot.rpc_id);
        self.endpoints[index].client.last_rpc_error_code = code;
        if (code != null) return error.RpcError;
        const value = parsed.value.object.get("result").?;
        switch (slot.phase) {
            .chain => {
                if (try abi.quantityAs(u256, try rpc.string(value)) != self.config.chain_id) return error.WrongChain;
                slot.result.chain_checked = true;
                slot.result.identity_ready = true;
                if (self.config.identity_only) slot.phase = .done else self.afterChain(index);
            },
            .tip => {
                slot.number = (try abi.quantity(try rpc.string(value))) -| self.config.reorg_period.blocks;
                slot.phase = .head;
            },
            .head => {
                const head = try rpc.BlockHeader.parse(value);
                if (slot.number) |n| {
                    if (head.number != n) return error.WrongBlock;
                }
                slot.result.head = head;
                slot.phase = .count;
            },
            .count => {
                const bytes = try abi.fixedHex(32, try rpc.string(value));
                const count = try abi.uintWord(u32, &bytes);
                slot.result.count = count;
                slot.phase = if (count == 0) .fence else .checkpoint;
            },
            .checkpoint => {
                const bytes = try abi.fixedHex(64, try rpc.string(value));
                const checkpoint = try abi.decodeCheckpoint(&bytes);
                if (@as(u64, checkpoint.index) + 1 != slot.result.count.?) return error.CheckpointCountMismatch;
                slot.result.checkpoint = .{ .mailbox_domain = self.config.domain, .merkle_tree_hook_address = self.config.hook_hash, .root = checkpoint.root, .index = checkpoint.index, .message_id = @splat(0) };
                slot.phase = .fence;
            },
            .fence => {
                const head = try rpc.BlockHeader.parse(value);
                if (head.number != slot.result.head.?.number or !std.mem.eql(u8, &head.hash, &slot.result.head.?.hash)) return error.IndexingReorg;
                slot.result.ready = true;
                slot.phase = .done;
            },
            .done => return error.UnexpectedVoteCompletion,
        }
        if (slot.phase != .done) try self.submit(index, now);
    }
    fn fail(self: *Runner, index: usize, err: anyerror) void {
        self.slots[index].result.failure = err;
        if (err == error.WrongChain) self.slots[index].result.chain_checked = false;
        self.slots[index].result.checkpoint = null;
        self.slots[index].phase = .done;
    }
};
/// Inputs and ready predicate are borrowed for this call. All slots are started
/// before waiting; early completion requires a caller-proven safe quorum.
/// Outstanding transfers are cancelled and drained before returning.
pub fn collect(a: A, owner: *Engine, endpoints: []const Endpoint, config: Config, context: *anyopaque, ready: *const fn (*anyopaque, []const Result) bool) ![]Result {
    if (endpoints.len == 0 or endpoints.len > 256 or config.timeout_ms == 0 or config.connect_timeout_ms == 0) return error.InvalidVotePool;
    const engine = try owner.acquire(a, config, endpoints.len);
    const slots = try a.alloc(Slot, endpoints.len);
    defer a.free(slots);
    const results = try a.alloc(Result, endpoints.len);
    errdefer a.free(results);
    for (slots) |*slot| slot.* = .{ .phase = .done, .deadline_ms = 0, .result = .{} };
    defer drain(owner, engine, slots);
    var runner: Runner = .{ .a = a, .engine = engine, .endpoints = endpoints, .slots = slots, .config = config, .owner = owner };
    const started = owner.nowMs();
    for (slots, endpoints, 0..) |*slot, endpoint, i| {
        slot.* = .{ .phase = if (endpoint.chain_checked and !config.identity_only) .head else .chain, .deadline_ms = started +| config.timeout_ms, .result = .{ .chain_checked = endpoint.chain_checked } };
        if (endpoint.chain_checked and !config.identity_only) runner.afterChain(i);
        runner.submit(i, started) catch |err| runner.fail(i, err);
    }
    while (true) {
        if (config.cancel) |flag| {
            if (flag.load(.acquire)) return error.Cancelled;
        }
        while (try engine.poll(owner.nowMs())) |completion_value| {
            var completion = completion_value;
            defer completion.deinit();
            const index = for (slots, 0..) |slot, i| {
                if (slot.id) |id| {
                    if (id.slot == completion.id.slot and id.sequence == completion.id.sequence) break i;
                }
            } else return error.UnknownVoteCompletion;
            slots[index].id = null;
            if (slots[index].observation) |*metric| metric.complete(&completion.result, owner.nowNs());
            slots[index].observation = null;
            switch (completion.result) {
                .failure => |err| runner.fail(index, err),
                .response => |response| runner.handleResponse(index, response, owner.nowMs()) catch |err| runner.fail(index, err),
            }
        }
        var all = true;
        for (slots, 0..) |slot, i| {
            results[i] = slot.result;
            if (slot.phase != .done) all = false;
        }
        if (all or ready(context, results)) return results;
        try waitForSockets(engine, owner.nowMs());
    }
}
/// Early quorum, cancellation and errors leave transfers in flight. Cancel and
/// consume them so the persistent multi never reports a stale completion or
/// retains byte reservations into the next round. A failure to do so drops the
/// multi (and its connections) rather than risking cross-round confusion.
fn drain(owner: *Engine, engine: *multi.Multi, slots: []Slot) void {
    var outstanding = false;
    for (slots) |*slot| {
        const id = slot.id orelse continue;
        slot.id = null;
        outstanding = true;
        engine.cancel(id) catch {
            owner.reset();
            return;
        };
    }
    if (!outstanding) return;
    while (engine.poll(owner.nowMs()) catch {
        owner.reset();
        return;
    }) |completion_value| {
        var completion = completion_value;
        completion.deinit();
    }
}
