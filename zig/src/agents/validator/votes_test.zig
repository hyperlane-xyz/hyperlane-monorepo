//! Vote FSM against real sockets and native libcurl multi: exact per-round
//! read counts, empty-tree confirmation, fail-closed errors and connection reuse.
const std = @import("std");
const http = @import("../../ops/http.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const votes = @import("votes.zig");
const a = std.testing.allocator;

const CheckpointMode = enum { ok, revert, http_error };
const Fixture = struct {
    checkpoint: CheckpointMode = .ok,
    count: u32 = 5,
    /// Fence returns a different hash for the head height (reorg after reads).
    reorg_fence: bool = false,
    head_calls: std.atomic.Value(usize) = .init(0),
    fence_calls: std.atomic.Value(usize) = .init(0),
    checkpoint_calls: std.atomic.Value(usize) = .init(0),
    count_calls: std.atomic.Value(usize) = .init(0),
    other_calls: std.atomic.Value(usize) = .init(0),
    pinned_mismatch: std.atomic.Value(bool) = .init(false),
    /// EIP-1898 handling: enforce (error unless canonical) or reject the form.
    pin: enum { enforce, reject } = .enforce,
    pinned_calls: std.atomic.Value(usize) = .init(0),

    fn handle(context: *anyopaque, alloc: std.mem.Allocator, request: http.Request, _: *const std.atomic.Value(bool)) !http.Response {
        const self: *Fixture = @ptrCast(@alignCast(context));
        const parsed = try std.json.parseFromSlice(std.json.Value, alloc, request.body, .{});
        defer parsed.deinit();
        const raw = parsed.value.object;
        const method = raw.get("method").?.string;
        const id = raw.get("id").?;
        const params = raw.get("params").?.array.items;
        var bytes: []u8 = undefined;
        if (std.mem.eql(u8, method, "eth_getBlockByNumber")) {
            const tag = params[0].string;
            const head = std.mem.eql(u8, tag, "latest");
            if (head) _ = self.head_calls.fetchAdd(1, .monotonic) else _ = self.fence_calls.fetchAdd(1, .monotonic);
            if (!head and !std.mem.eql(u8, tag, "0x10")) self.pinned_mismatch.store(true, .release);
            const hash = try abi.hexAlloc(alloc, &@as([32]u8, @splat(if (!head and self.reorg_fence) 9 else 7)));
            defer alloc.free(hash);
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = .{ .number = "0x10", .hash = hash, .parentHash = hash, .timestamp = "0x1" } }, .{});
        } else if (std.mem.eql(u8, method, "eth_call")) {
            const data = params[0].object.get("data").?.string;
            if (params[1] == .object) {
                _ = self.pinned_calls.fetchAdd(1, .monotonic);
                const block = params[1].object;
                const head = try abi.hexAlloc(alloc, &@as([32]u8, @splat(7)));
                defer alloc.free(head);
                if (!std.mem.eql(u8, block.get("blockHash").?.string, head) or !block.get("requireCanonical").?.bool) self.pinned_mismatch.store(true, .release);
                // An enforcing node refuses a head that a reorg replaced.
                if (self.pin == .reject or self.reorg_fence) {
                    bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .@"error" = .{ .code = -32602, .message = "invalid block parameter" } }, .{});
                    defer alloc.free(bytes);
                    return http.Response.init(alloc, 200, &.{.{ .name = "Content-Type", .value = "application/json" }}, bytes);
                }
            } else if (!std.mem.eql(u8, params[1].string, "0x10")) self.pinned_mismatch.store(true, .release);
            const latest = try abi.hexAlloc(alloc, &abi.selector("latestCheckpoint()"));
            defer alloc.free(latest);
            if (std.mem.eql(u8, data, latest)) {
                _ = self.checkpoint_calls.fetchAdd(1, .monotonic);
                switch (self.checkpoint) {
                    .http_error => return http.Response.init(alloc, 503, &.{}, "fixture unavailable"),
                    .revert => bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .@"error" = .{ .code = 3, .message = "execution reverted", .data = "0x4e487b710000000000000000000000000000000000000000000000000000000000000011" } }, .{}),
                    .ok => {
                        var words: [64]u8 = @splat(0);
                        @memset(words[0..32], 0xab);
                        std.mem.writeInt(u32, words[60..64], self.count - 1, .big);
                        const text = try abi.hexAlloc(alloc, &words);
                        defer alloc.free(text);
                        bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = text }, .{});
                    },
                }
            } else {
                _ = self.count_calls.fetchAdd(1, .monotonic);
                var word: [32]u8 = @splat(0);
                std.mem.writeInt(u32, word[28..32], self.count, .big);
                const text = try abi.hexAlloc(alloc, &word);
                defer alloc.free(text);
                bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = text }, .{});
            }
        } else {
            _ = self.other_calls.fetchAdd(1, .monotonic);
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = "0x1" }, .{});
        }
        defer alloc.free(bytes);
        return http.Response.init(alloc, 200, &.{.{ .name = "Content-Type", .value = "application/json" }}, bytes);
    }
};

fn library() ![]u8 {
    return std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => a.dupe(u8, if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4"),
        else => err,
    };
}
fn never(_: *anyopaque, _: []const votes.Result) bool {
    return false;
}

const Harness = struct {
    server: *http.Server,
    url: []u8,
    client: rpc.RpcClient,
    path: []u8,
    engine: votes.Engine = .{},
    fn init(self: *Harness, fixture: *Fixture) !void {
        self.server = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("127.0.0.1", 0) }, .{ .context = fixture, .handle_fn = Fixture.handle });
        errdefer self.server.deinit();
        self.url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{self.server.address().getPort()});
        errdefer a.free(self.url);
        self.client = try rpc.RpcClient.init(a, self.url, .{});
        self.path = try library();
        self.engine = .{};
    }
    fn deinit(self: *Harness) void {
        self.engine.deinit();
        a.free(self.path);
        self.client.deinit();
        a.free(self.url);
        self.server.deinit();
    }
    fn round(self: *Harness) !votes.Result {
        return self.roundPinned(false);
    }
    fn roundPinned(self: *Harness, hash_pin: bool) !votes.Result {
        const endpoints = [_]votes.Endpoint{.{ .client = &self.client, .chain_checked = true, .hash_pin = hash_pin }};
        var unused: u8 = 0;
        const results = try votes.collect(a, &self.engine, &endpoints, .{ .library_path = self.path, .chain_id = 1, .domain = 1, .hook = @splat(2), .hook_hash = @splat(0), .reorg_period = .none, .timeout_ms = 15000, .connect_timeout_ms = 5000 }, &unused, never);
        defer a.free(results);
        return results[0];
    }
};

test "vote round reads head, latestCheckpoint and fence only; count derives from the checkpoint at the pinned block" {
    var fixture: Fixture = .{};
    var harness: Harness = undefined;
    try harness.init(&fixture);
    defer harness.deinit();
    for (0..3) |_| {
        const result = try harness.round();
        try std.testing.expect(result.ready);
        try std.testing.expectEqual(@as(?u32, 5), result.count);
        try std.testing.expectEqual(@as(u32, 4), result.checkpoint.?.index);
    }
    try std.testing.expectEqual(@as(usize, 3), fixture.head_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 3), fixture.checkpoint_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 3), fixture.fence_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.count_calls.load(.acquire));
    try std.testing.expect(!fixture.pinned_mismatch.load(.acquire));
    // The persistent multi survives rounds: one engine, no per-round rebuild.
    try std.testing.expect(harness.engine.multi != null);
}

test "latestCheckpoint revert is empty only after an explicit zero count at the same block" {
    var fixture: Fixture = .{ .checkpoint = .revert, .count = 0 };
    var harness: Harness = undefined;
    try harness.init(&fixture);
    defer harness.deinit();
    const empty = try harness.round();
    try std.testing.expect(empty.ready);
    try std.testing.expectEqual(@as(?u32, 0), empty.count);
    try std.testing.expect(empty.checkpoint == null);
    try std.testing.expectEqual(@as(usize, 1), fixture.count_calls.load(.acquire));
    try std.testing.expect(!fixture.pinned_mismatch.load(.acquire));
    // Same revert with a nonzero count is contradictory: the round fails.
    fixture.count = 3;
    const contradictory = try harness.round();
    try std.testing.expect(!contradictory.ready);
    try std.testing.expectEqual(@as(?anyerror, error.CheckpointReadFailed), contradictory.failure);
}

test "transport error and post-read reorg fail the vote instead of producing an empty or stale checkpoint" {
    var fixture: Fixture = .{ .checkpoint = .http_error, .count = 0 };
    var harness: Harness = undefined;
    try harness.init(&fixture);
    defer harness.deinit();
    const unavailable = try harness.round();
    try std.testing.expect(!unavailable.ready);
    try std.testing.expect(unavailable.failure != null);
    try std.testing.expect(unavailable.checkpoint == null);
    try std.testing.expectEqual(@as(usize, 0), fixture.count_calls.load(.acquire));
    fixture.checkpoint = .ok;
    fixture.count = 5;
    fixture.reorg_fence = true;
    const reorged = try harness.round();
    try std.testing.expect(!reorged.ready);
    try std.testing.expectEqual(@as(?anyerror, error.IndexingReorg), reorged.failure);
    try std.testing.expect(reorged.checkpoint == null);
}

test "EIP-1898 canonical-pinned reads replace the fence: head plus one call per round" {
    var fixture: Fixture = .{};
    var harness: Harness = undefined;
    try harness.init(&fixture);
    defer harness.deinit();
    for (0..2) |_| {
        const result = try harness.roundPinned(true);
        try std.testing.expect(result.ready);
        try std.testing.expect(!result.hash_pin_rejected);
        try std.testing.expectEqual(@as(?u32, 5), result.count);
    }
    try std.testing.expectEqual(@as(usize, 2), fixture.head_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 2), fixture.pinned_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.fence_calls.load(.acquire));
    try std.testing.expect(!fixture.pinned_mismatch.load(.acquire));
    // Empty tree: the pinned revert is confirmed by a pinned count() of zero.
    fixture.checkpoint = .revert;
    fixture.count = 0;
    const empty = try harness.roundPinned(true);
    try std.testing.expect(empty.ready);
    try std.testing.expectEqual(@as(?u32, 0), empty.count);
    try std.testing.expectEqual(@as(usize, 0), fixture.fence_calls.load(.acquire));
}

test "EIP-1898 rejection falls back to number plus fence and a non-canonical head fails the vote" {
    var fixture: Fixture = .{ .pin = .reject };
    var harness: Harness = undefined;
    try harness.init(&fixture);
    defer harness.deinit();
    const fallback = try harness.roundPinned(true);
    try std.testing.expect(fallback.ready);
    try std.testing.expect(fallback.hash_pin_rejected);
    try std.testing.expectEqual(@as(?u32, 5), fallback.count);
    try std.testing.expectEqual(@as(usize, 2), fixture.pinned_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), fixture.fence_calls.load(.acquire));
    // Head replaced after it was read: the enforcing node refuses both pinned
    // reads, the unpinned fallback hits the fence and the vote fails without
    // demoting the endpoint's pinning.
    fixture.pin = .enforce;
    fixture.reorg_fence = true;
    const reorged = try harness.roundPinned(true);
    try std.testing.expect(!reorged.ready);
    try std.testing.expectEqual(@as(?anyerror, error.IndexingReorg), reorged.failure);
    try std.testing.expect(reorged.checkpoint == null);
    try std.testing.expect(!reorged.hash_pin_rejected);
}
