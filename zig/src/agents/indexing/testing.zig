const std = @import("std");
const src = @import("../scraper/source.zig");
const core = @import("source.zig");
const native = @import("../store.zig");
const codec = @import("../../db/codec.zig");
const protocol = @import("../../protocol/root.zig");
const a = std.testing.allocator;
const coreRange = @import("../../runtime/sequence_cursor.zig").Range;
pub const contracts: src.Contracts = .{ .mailbox = @splat(1), .hook = @splat(2), .paymaster = @splat(3) };
fn hash(height: u64) [32]u8 {
    var out: [32]u8 = @splat(0);
    std.mem.writeInt(u64, out[24..32], height, .big);
    return out;
}
fn stream(event: src.Event) usize {
    return switch (event.data) {
        .dispatch => 0,
        .delivery => 1,
        .gas => 2,
        .insertion => 3,
    };
}
fn eventIndex(event: src.Event) u32 {
    return switch (event.data) {
        .dispatch => |value| value.nonce,
        .insertion => |value| value.index,
        else => event.sequence.?,
    };
}
pub fn events() [6]src.Event {
    var result: [6]src.Event = undefined;
    for (0..2) |i| {
        const message: protocol.Message = .{ .version = 3, .nonce = @intCast(i), .origin = 10, .destination = 20, .sender = @splat(4), .recipient = @splat(5), .body = "owned source" };
        const height: u64 = i * 2 + 2;
        const id = message.id();
        result[i * 3] = .{ .block_number = height, .block_hash = hash(height), .address = contracts.mailbox, .tx_hash = @splat(@intCast(i + 1)), .log_index = 0, .data = .{ .dispatch = message } };
        result[i * 3 + 1] = .{ .block_number = height, .block_hash = hash(height), .address = contracts.hook, .tx_hash = @splat(@intCast(i + 1)), .log_index = 1, .data = .{ .insertion = .{ .message_id = id, .index = @intCast(i) } } };
        result[i * 3 + 2] = .{ .block_number = height, .block_hash = hash(height), .address = contracts.paymaster, .tx_hash = @splat(@intCast(i + 1)), .log_index = 2, .sequence = @intCast(i), .data = .{ .gas = .{ .message_id = id, .destination = 20, .gas = 100, .payment = 200 } } };
    }
    return result;
}
pub const Chain = struct {
    logs: []const src.Event,
    sequence: bool = false,
    tip_calls: [4]usize = @splat(0),
    drop_zero: bool = false,
    flip_fence: bool = false,
    events_fetched: bool = false,
    cancel_after: ?*std.atomic.Value(bool) = null,
    unsequenced_gas: bool = false,
    count: u32 = 2,
    height: u32 = 5,
    fetch_error: ?anyerror = null,
    failed_range: coreRange = .{ .from = 0, .to = 1 },
    raw_calls: [4]usize = @splat(0),
    pub fn interface(self: *Chain) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = read, .stream_tip_fn = tip, .raw_sequence_fn = raw, .sequence_mode = self.sequence };
    }
    fn cast(context: *anyopaque) *Chain {
        return @ptrCast(@alignCast(context));
    }
    fn header(context: *anyopaque, selector: src.Selector, fresh: bool) !src.Header {
        const self = cast(context);
        const height = switch (selector) {
            .height => |n| n,
            else => 5,
        };
        var value = hash(height);
        if (fresh and height == 5 and self.flip_fence and self.events_fetched) value[0] = 9;
        return .{ .height = height, .hash = value, .timestamp = 1000 + height };
    }
    fn tip(context: *anyopaque, index: usize) !src.Tip {
        const self = cast(context);
        self.tip_calls[index] += 1;
        return .{ .tip = self.height, .count = if (index == 2 and self.unsequenced_gas) null else self.count };
    }
    fn read(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        return cast(context).batch(allocator, null, from, through);
    }
    fn raw(context: *anyopaque, allocator: std.mem.Allocator, index: usize, from: u32, through: u32) !src.Batch {
        const self = cast(context);
        self.raw_calls[index] += 1;
        if (index == 0 and from <= self.failed_range.to and through >= self.failed_range.from) if (self.fetch_error) |err| return err;
        return self.batch(allocator, index, from, through);
    }
    fn batch(self: *Chain, allocator: std.mem.Allocator, index: ?usize, from: u64, through: u64) !src.Batch {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const alloc = arena.allocator();
        var list: std.ArrayList(src.Event) = .empty;
        for (self.logs) |original| {
            if (self.drop_zero and original.data == .dispatch and original.data.dispatch.nonce == 0) continue;
            const value = if (index != null) eventIndex(original) else original.block_number;
            if (value < from or value > through) continue;
            if (index) |selected| if (stream(original) != selected) continue;
            var event = original;
            if (event.data == .dispatch) event.data.dispatch.body = try alloc.dupe(u8, event.data.dispatch.body);
            if (self.unsequenced_gas and event.data == .gas) event.sequence = null;
            try list.append(alloc, event);
        }
        self.events_fetched = true;
        if (self.cancel_after) |cancel| cancel.store(true, .release);
        const owned = try list.toOwnedSlice(alloc);
        return .{ .arena = arena, .events = owned, .through = through };
    }
};
const Store = struct {
    blocks: [3][16]?u64 = @splat(@splat(null)),
    ids: [16]?[32]u8 = @splat(null),
    leaves: [16]?[32]u8 = @splat(null),
    payments: [16]bool = @splat(false),
    total: u256 = 0,
    watermark: ?u32 = null,
    fail_nonce: ?u32 = null,
    progress: [3][16]?codec.BackwardCursor = @splat(@splat(null)),
    pub fn logBlock(self: *Store, kind: native.Stream, value: u32) !?u64 {
        return self.blocks[@intFromEnum(kind)][value];
    }
    pub fn backwardProgress(self: *Store, kind: native.Stream, value: u32) !?codec.BackwardCursor {
        return self.progress[@intFromEnum(kind)][value];
    }
    pub fn saveBackwardProgress(self: *Store, kind: native.Stream, point: codec.BackwardCursor) !void {
        self.progress[@intFromEnum(kind)][point.sequence] = point;
    }
    pub fn deleteBackwardProgress(self: *Store, kind: native.Stream, value: u32) !void {
        self.progress[@intFromEnum(kind)][value] = null;
    }
    pub fn storeMessage(self: *Store, value: protocol.Message, height: u64, _: ?[64]u8) !bool {
        if (self.fail_nonce == value.nonce) return error.FixtureWriteFailure;
        const exists = self.ids[value.nonce] != null;
        self.ids[value.nonce] = value.id();
        self.blocks[0][value.nonce] = height;
        return !exists;
    }
    pub fn storeInsertion(self: *Store, value: codec.MerkleInsertion, height: u64) !bool {
        const exists = self.leaves[value.leaf_index] != null;
        self.leaves[value.leaf_index] = value.message_id;
        self.blocks[1][value.leaf_index] = height;
        return !exists;
    }
    pub fn storePayment(self: *Store, value: codec.GasPayment, identity: codec.GasPaymentMeta) !bool {
        const position = identity.transaction_id[0];
        if (self.payments[position]) return false;
        self.payments[position] = true;
        self.total += value.payment;
        return true;
    }
    pub fn storeIndexedPayment(self: *Store, value: codec.GasPayment, identity: codec.GasPaymentMeta, index_: u32, height: u64) !bool {
        if (self.blocks[2][index_] != null) return false;
        _ = try self.storePayment(value, identity);
        self.blocks[2][index_] = height;
        return true;
    }
    pub fn gasWatermark(self: *Store) !?u32 {
        return self.watermark;
    }
    pub fn storeGasWatermark(self: *Store, value: u32) !void {
        self.watermark = value;
    }
};
fn worker(chain: *Chain, store: *Store) core.Core(Store) {
    return .{ .allocator = a, .source = chain.interface(), .store = store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000 } };
}
test "native origin generic source rotates block and sequence lanes stores before cursors and avoids disabled gas calls" {
    const logs = events();
    for ([_]bool{ false, true }) |sequence_mode| {
        var chain: Chain = .{ .logs = &logs, .sequence = sequence_mode };
        var store: Store = .{};
        var indexer = worker(&chain, &store);
        defer indexer.deinit();
        const message = try indexer.tick(0, null);
        const insertion = try indexer.tick(0, null);
        const gas = try indexer.tick(0, null);
        try std.testing.expectEqual(@as(usize, 2), message.messages);
        try std.testing.expectEqual(@as(usize, 2), insertion.insertions);
        try std.testing.expectEqual(@as(usize, 2), gas.payments);
        try std.testing.expectEqual(@as(u256, 400), store.total);
        for (0..2) |i| {
            try std.testing.expect(store.ids[i] != null);
            try std.testing.expect(store.leaves[i] != null);
            try std.testing.expect(store.blocks[2][i] != null);
        }
    }
    var chain: Chain = .{ .logs = &logs, .sequence = true };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    indexer.options.gas_enabled = false;
    _ = try indexer.tick(0, null);
    _ = try indexer.tick(0, null);
    try std.testing.expectEqual(@as(usize, 0), chain.tip_calls[2]);
}
test "native origin generic source rejects changed canonical fence and cancellation before durable writes" {
    const logs = events();
    var chain: Chain = .{ .logs = &logs, .sequence = true, .flip_fence = true };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    try std.testing.expectError(error.OriginIndexingReorg, indexer.tick(0, null));
    try std.testing.expect(store.ids[0] == null);
    try std.testing.expect(indexer.cursors[0].?.pending == null);
    chain.flip_fence = false;
    chain.events_fetched = false;
    var cancel = std.atomic.Value(bool).init(false);
    chain.cancel_after = &cancel;
    indexer.next_stream = 0;
    try std.testing.expectError(error.RequestCancelled, indexer.tick(1000, &cancel));
    try std.testing.expect(store.ids[0] == null);
}
test "native origin incomplete source and partial DB failure retain gap repair and replay neighboring rows" {
    const logs = events();
    var chain: Chain = .{ .logs = &logs, .sequence = true, .drop_zero = true };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: @import("../../ops/indexing_metrics.zig").Adapter = .{ .registry = registry, .chain = "gap-fixture", .unix_seconds = 1000 };
    indexer.observer = adapter.interface();
    _ = try indexer.tick(0, null);
    try std.testing.expect(store.ids[0] == null);
    try std.testing.expect(store.ids[1] != null);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 1), try metric(text, "hyperlane_cursor_sequence_gap_retries", "hyperlane_message"));
        try std.testing.expectEqual(@as(?i64, 5), try metric(text, "hyperlane_cursor_sequence_gap_backoff_seconds", "hyperlane_message"));
    }
    chain.drop_zero = false;
    indexer.next_stream = 0;
    _ = try indexer.tick(6000, null);
    try std.testing.expect(store.ids[0] != null);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 1), try metric(text, "hyperlane_cursor_sequence_gap_retries", "hyperlane_message"));
        try std.testing.expectEqual(@as(?i64, 0), try metric(text, "hyperlane_cursor_sequence_gap_backoff_seconds", "hyperlane_message"));
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
    }
    // A fresh store may retain successful rows before a later write fails. The
    // cursor query token is released and a replay safely completes the page.
    var partial: Store = .{ .fail_nonce = 1 };
    var recovering = worker(&chain, &partial);
    defer recovering.deinit();
    try std.testing.expectError(error.FixtureWriteFailure, recovering.tick(0, null));
    try std.testing.expect(partial.ids[0] != null);
    try std.testing.expect(partial.ids[1] == null);
    try std.testing.expect(recovering.cursors[0].?.pending == null);
    partial.fail_nonce = null;
    recovering.next_stream = 0;
    _ = try recovering.tick(1000, null);
    try std.testing.expect(partial.ids[1] != null);
}
test "native origin unsequenced gas keeps separate conservative watermark and source poll cadence" {
    const logs = events();
    var chain: Chain = .{ .logs = &logs, .unsequenced_gas = true };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    indexer.next_stream = 2;
    indexer.options.chunk = 4;
    indexer.options.configured_interval_ms = 1000;
    const report = try indexer.tick(0, null);
    try std.testing.expectEqual(@as(usize, 2), report.payments);
    try std.testing.expect(store.watermark != null);
    try std.testing.expectEqual(@as(u32, 0), store.watermark.?);
    try std.testing.expectEqual(@as(u32, 5), indexer.gas_block.?.next);
}

test "native origin insertion-only validator lane filters rotation polling and rejects no active streams" {
    const logs = events();
    var chain: Chain = .{ .logs = &logs, .sequence = true };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    indexer.options.enabled_streams = .{ false, true, false };
    const first = try indexer.tick(0, null);
    try std.testing.expectEqual(@as(usize, 2), first.insertions);
    try std.testing.expect(store.ids[0] == null);
    try std.testing.expectEqual(@as(usize, 0), chain.tip_calls[0]);
    try std.testing.expectEqual(@as(usize, 0), chain.tip_calls[2]);
    const next = try indexer.tick(0, null);
    try std.testing.expectEqual(@as(u64, 1000), next.next_delay_ms);
    const calls = chain.tip_calls[3];
    const sleep = try indexer.tick(500, null);
    try std.testing.expectEqual(@as(u64, 500), sleep.next_delay_ms);
    try std.testing.expectEqual(calls, chain.tip_calls[3]);
    indexer.options.enabled_streams = .{ false, false, false };
    try std.testing.expectError(error.NoOriginStreams, indexer.tick(1000, null));
}

const YieldChain = struct {
    const Key = struct { kind: enum { header, events, tip }, from: u64, to: u64 = 0, fresh: bool = false, occurrence: u32 = 0 };
    chain: Chain,
    calls: [128]Key = undefined,
    call_count: usize = 0,
    ready: [128]Key = undefined,
    ready_count: usize = 0,
    decodes: [16]usize = @splat(0),
    commits: usize = 0,
    reserved: usize = 0,
    max_reserved: usize = 0,
    fail_at: ?u64 = null,
    fn beginPass(self: *@This()) void {
        self.call_count = 0;
    }
    fn read(self: *@This(), input: Key) !void {
        var key = input;
        for (self.calls[0..self.call_count]) |previous| if (previous.kind == key.kind and previous.from == key.from and previous.to == key.to and previous.fresh == key.fresh) {
            key.occurrence += 1;
        };
        if (self.call_count >= self.calls.len) return error.FixtureRequestLimit;
        self.calls[self.call_count] = key;
        self.call_count += 1;
        for (self.ready[0..self.ready_count]) |previous| if (std.meta.eql(previous, key)) return;
        if (self.ready_count >= self.ready.len) return error.FixtureRequestLimit;
        self.ready[self.ready_count] = key;
        self.ready_count += 1;
        return error.PendingReadIo;
    }
    fn interface(self: *@This()) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = batch, .stream_tip_fn = tip, .sequence_mode = self.chain.sequence, .raw_sequence_fn = raw, .read_section = .{ .context = self, .commit_fn = commit, .reservation = .{ .context = self, .reserve_fn = reserve, .release_fn = release } } };
    }
    fn cast(context: *anyopaque) *@This() {
        return @ptrCast(@alignCast(context));
    }
    fn commit(context: *anyopaque) !void {
        const self = cast(context);
        self.ready_count = 0;
        self.call_count = 0;
        self.commits += 1;
    }
    fn reserve(context: *anyopaque, bytes: usize) !void {
        const self = cast(context);
        self.reserved += bytes;
        self.max_reserved = @max(self.max_reserved, self.reserved);
    }
    fn release(context: *anyopaque, bytes: usize) void {
        const self = cast(context);
        std.debug.assert(bytes <= self.reserved);
        self.reserved -= bytes;
    }
    fn header(context: *anyopaque, selector: src.Selector, fresh: bool) !src.Header {
        const self = cast(context);
        const height = if (selector == .height) selector.height else 5;
        try self.read(.{ .kind = .header, .from = height, .fresh = fresh });
        return self.chain.interface().header_fn(&self.chain, selector, fresh);
    }
    fn tip(context: *anyopaque, value: usize) !src.Tip {
        const self = cast(context);
        try self.read(.{ .kind = .tip, .from = value });
        return self.chain.interface().streamTip(value);
    }
    fn raw(context: *anyopaque, allocator: std.mem.Allocator, index_: usize, from: u32, to: u32) !src.Batch {
        const self = cast(context);
        try self.read(.{ .kind = .events, .from = from, .to = to });
        return self.chain.interface().rawSequence(allocator, index_, from, to);
    }
    fn batch(context: *anyopaque, allocator: std.mem.Allocator, from: u64, to: u64, sequences: [4]u32) !src.Batch {
        const self = cast(context);
        try self.read(.{ .kind = .events, .from = from, .to = to });
        if (self.fail_at == from) return error.RpcError;
        self.decodes[@intCast(from)] += 1;
        return self.chain.interface().events(allocator, from, to, sequences);
    }
};

test "native origin cooperative frame freezes selected lane and decodes each completed block once across repeated yields" {
    const logs = events();
    var chain: YieldChain = .{ .chain = .{ .logs = &logs } };
    var store: Store = .{};
    var indexer: core.Core(Store) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000 } };
    defer indexer.deinit();
    var passes: usize = 0;
    while (true) {
        chain.beginPass();
        if (indexer.tick(@intCast(passes * 100), null)) |report| {
            try std.testing.expectEqual(@as(usize, 2), report.messages);
            break;
        } else |err| {
            if (err != error.PendingReadIo) return err;
            try std.testing.expectEqual(@as(usize, 0), indexer.current.?.selected);
            try std.testing.expectEqual(@as(u64, 0), indexer.current.?.now_ms);
        }
        passes += 1;
        if (passes > 100) return error.CooperativeFrameLivelock;
    }
    try std.testing.expect(passes > 6);
    try std.testing.expectEqual(@as(usize, 1), chain.chain.tip_calls[0]);
    try std.testing.expectEqual(@as(usize, 0), chain.chain.tip_calls[3]);
    // Only the current quantum may redo typed decoding after a later fence
    // yields; completed prior blocks stay in the bounded owned Frame.
    for (chain.decodes[0..6]) |count| try std.testing.expect(count <= 3);
    try std.testing.expect(chain.max_reserved > 0);
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
    try std.testing.expect(store.ids[0] != null and store.ids[1] != null);
    try std.testing.expect(indexer.current == null and indexer.frame == null);
}

test "native origin cooperative frame rejects a late range fork and releases retained budget before DB writes" {
    const logs = events();
    var chain: YieldChain = .{ .chain = .{ .logs = &logs, .flip_fence = true } };
    var store: Store = .{};
    var indexer: core.Core(Store) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000 } };
    defer indexer.deinit();
    var passes: usize = 0;
    while (true) {
        chain.beginPass();
        if (indexer.tick(@intCast(passes * 100), null)) |_| return error.UnfencedRangeAccepted else |err| {
            if (err == error.OriginIndexingReorg) break;
            if (err != error.PendingReadIo) return err;
        }
        passes += 1;
        if (passes > 100) return error.CooperativeFrameLivelock;
    }
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
    try std.testing.expect(store.ids[0] == null and store.ids[1] == null);
    try std.testing.expect(indexer.cursors[0].?.pending == null);
    try std.testing.expect(indexer.current == null and indexer.frame == null);
}

test "native origin stream mask aborts only disabled pending frame releases quota and resumes unskipped cursor" {
    const logs = events();
    var chain: YieldChain = .{ .chain = .{ .logs = &logs } };
    var store: Store = .{};
    var indexer: core.Core(Store) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000 } };
    defer indexer.deinit();
    var passes: usize = 0;
    while (chain.reserved == 0) {
        chain.beginPass();
        try std.testing.expectError(error.PendingReadIo, indexer.tick(passes, null));
        passes += 1;
        if (passes > 100) return error.MissingRetainedFrame;
    }
    try std.testing.expect(indexer.hasEnabledStreams());
    try std.testing.expect(!indexer.setStreamMask(.{ true, false, false }));
    try std.testing.expect(indexer.frame != null);
    const cursor = indexer.cursors[0].?.backward;
    try std.testing.expect(indexer.setStreamMask(.{ false, false, false }));
    try std.testing.expect(!indexer.hasEnabledStreams());
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
    try std.testing.expect(indexer.current == null and indexer.frame == null);
    try std.testing.expect(indexer.cursors[0].?.pending == null);
    try std.testing.expectEqual(cursor, indexer.cursors[0].?.backward);
    try std.testing.expect(store.ids[0] == null and store.ids[1] == null);
    // The transport owner retires cancelled handles before restarting a pass.
    chain.ready_count = 0;
    chain.beginPass();
    indexer.due[0] = 999999;
    try std.testing.expect(!indexer.setStreamMask(.{ true, false, false }));
    try std.testing.expectEqual(@as(u64, 0), indexer.due[0]);
    while (true) {
        chain.beginPass();
        if (indexer.tick(passes, null)) |report| {
            try std.testing.expectEqual(@as(usize, 2), report.messages);
            break;
        } else |err| if (err != error.PendingReadIo) return err;
        passes += 1;
        if (passes > 200) return error.PausedCursorDidNotResume;
    }
    try std.testing.expect(store.ids[0] != null and store.ids[1] != null);
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
    indexer.options.gas_enabled = false;
    try std.testing.expect(!indexer.setStreamMask(.{ false, false, true }));
    try std.testing.expect(!indexer.hasEnabledStreams());
}

test "origin Source fetch backoff preserves healthy streams disjoint forward work and exact retry metrics" {
    const metrics = @import("../../ops/metrics.zig");
    const adapter_module = @import("../../ops/indexing_metrics.zig");
    const original = events();
    var logs: [7]src.Event = undefined;
    @memcpy(logs[0..6], &original);
    var next = original[3];
    next.block_number = 5;
    next.block_hash = hash(5);
    next.data.dispatch.nonce = 2;
    next.tx_hash = @splat(3);
    logs[6] = next;
    var chain: Chain = .{ .logs = &logs, .sequence = true, .fetch_error = error.RpcError };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: adapter_module.Adapter = .{ .registry = registry, .chain = "source-fixture", .unix_seconds = 1000 };
    indexer.observer = adapter.interface();
    _ = try indexer.tick(0, null); // Real failed range schedules5s.
    try std.testing.expect(store.ids[0] == null);
    try std.testing.expectEqual(@as(usize, 1), chain.raw_calls[0]);
    _ = try indexer.tick(0, null); // Healthy insertion stream is not parked.
    _ = try indexer.tick(0, null); // Healthy gas stream is not parked.
    try std.testing.expect(store.leaves[0] != null and store.blocks[2][0] != null);
    indexer.next_stream = 0;
    _ = try indexer.tick(4999, null);
    try std.testing.expectEqual(@as(usize, 1), chain.raw_calls[0]);
    indexer.next_stream = 0;
    _ = try indexer.tick(5000, null); // Same failed range now schedules10s.
    try std.testing.expectEqual(@as(usize, 2), chain.raw_calls[0]);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_fetch_retries", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 10), try metric(text, "hyperlane_contract_sync_fetch_backoff_seconds", "dispatched_messages"));
        try std.testing.expect((try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages")) == null);
    }
    chain.count = 3;
    indexer.next_stream = 0;
    _ = try indexer.tick(10000, null); // New disjoint nonce2 bypasses old backoff.
    try std.testing.expect(store.ids[2] != null and store.ids[0] == null);
    try std.testing.expectEqual(@as(u32, 2), indexer.fetch_retries[0].consecutive_failures);
    chain.fetch_error = null;
    indexer.next_stream = 0;
    adapter.unix_seconds = 1015;
    _ = try indexer.tick(15000, null); // Original gap recovers, clears backoff.
    try std.testing.expect(store.ids[0] != null and store.ids[1] != null);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_fetch_retries", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 0), try metric(text, "hyperlane_contract_sync_fetch_backoff_seconds", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 3), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
        try std.testing.expectEqual(@as(?i64, 1015), try metric(text, "hyperlane_contract_sync_liveness", "dispatched_messages"));
    }
}

test "origin indexing metrics count committed partial rows and keep cancellation IO refusal out of retries" {
    const metrics = @import("../../ops/metrics.zig");
    const adapter_module = @import("../../ops/indexing_metrics.zig");
    const logs = events();
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: adapter_module.Adapter = .{ .registry = registry, .chain = "partial-fixture", .unix_seconds = 1000 };
    var chain: Chain = .{ .logs = &logs, .sequence = true };
    var store: Store = .{ .fail_nonce = 1 };
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    indexer.observer = adapter.interface();
    try std.testing.expectError(error.FixtureWriteFailure, indexer.tick(0, null));
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 1), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
        try std.testing.expect((try metric(text, "hyperlane_contract_sync_liveness", "dispatched_messages")) == null);
        try std.testing.expect((try metric(text, "hyperlane_contract_sync_fetch_retries", "dispatched_messages")) == null);
    }
    store.fail_nonce = null;
    indexer.next_stream = 0;
    _ = try indexer.tick(1000, null);
    {
        const text = try registry.render(a);
        defer a.free(text);
        try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
    }
    for ([_]anyerror{ error.PendingReadIo, error.RequestCancelled, error.SourceReadDeadline, error.ValidatorReorg, error.MessageMetadataRefused, error.OutOfMemory }) |err| {
        var fresh_store: Store = .{};
        var controlled = worker(&chain, &fresh_store);
        defer controlled.deinit();
        controlled.observer = adapter.interface();
        chain.fetch_error = err;
        try std.testing.expectError(err, controlled.tick(2000, null));
        try std.testing.expectEqual(@as(u32, 0), controlled.fetch_retries[0].consecutive_failures);
    }
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect((try metric(text, "hyperlane_contract_sync_fetch_retries", "dispatched_messages")) == null);
}

fn metric(text: []const u8, name: []const u8, data_type: []const u8) !?i64 {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, name) or line.len <= name.len or line[name.len] != '{' or std.mem.indexOf(u8, line, data_type) == null) continue;
        const space = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        return try std.fmt.parseInt(i64, line[space + 1 ..], 10);
    }
    return null;
}

test "origin cooperative fetch failure abandons uncommitted frame keeps healthy stream and resumes exact range" {
    const logs = events();
    var chain: YieldChain = .{ .chain = .{ .logs = &logs }, .fail_at = 3 };
    var store: Store = .{};
    var indexer: core.Core(Store) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000, .gas_enabled = false } };
    defer indexer.deinit();
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = @import("../../ops/metrics_schema.zig").baselib_version });
    defer registry.deinit();
    var adapter: @import("../../ops/indexing_metrics.zig").Adapter = .{ .registry = registry, .chain = "cooperative-fixture", .unix_seconds = 1000 };
    indexer.observer = adapter.interface();
    const failed = try completeYieldCycle(&indexer, &chain, 1000);
    try std.testing.expectEqual(@as(usize, 0), failed.ranges);
    try std.testing.expect(chain.max_reserved > 0 and chain.commits > 0);
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
    try std.testing.expect(indexer.current == null and indexer.frame == null);
    try std.testing.expect(store.ids[0] == null and store.ids[1] == null);
    try std.testing.expect(indexer.cursors[0].?.pending == null);
    try std.testing.expectEqual(@as(u32, 1), indexer.fetch_retries[0].consecutive_failures);
    chain.fail_at = null;
    _ = try completeYieldCycle(&indexer, &chain, 1000);
    try std.testing.expect(store.leaves[0] != null and store.ids[0] == null);
    indexer.next_stream = 0;
    _ = try completeYieldCycle(&indexer, &chain, 6000);
    try std.testing.expect(store.ids[0] != null and store.ids[1] != null);
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expectEqual(@as(?i64, 1), try metric(text, "hyperlane_contract_sync_fetch_retries", "dispatched_messages"));
    try std.testing.expectEqual(@as(?i64, 0), try metric(text, "hyperlane_contract_sync_fetch_backoff_seconds", "dispatched_messages"));
    try std.testing.expectEqual(@as(?i64, 2), try metric(text, "hyperlane_contract_sync_stored_events", "dispatched_messages"));
}
fn completeYieldCycle(indexer: *core.Core(Store), chain: *YieldChain, now_ms: u64) !core.Report {
    for (0..100) |_| {
        chain.beginPass();
        if (indexer.tick(now_ms, null)) |report| {
            // Real Resources.endReadPass(null) closes a completed/handled pass.
            chain.ready_count = 0;
            return report;
        } else |err| if (err != error.PendingReadIo) return err;
    }
    return error.CooperativeFrameLivelock;
}

test "shared indexing core keeps existing caller fetch error semantics unless relayer enables Source backoff" {
    const logs = events();
    var chain: Chain = .{ .logs = &logs, .sequence = true, .fetch_error = error.RpcError };
    var store: Store = .{};
    var indexer = worker(&chain, &store);
    defer indexer.deinit();
    indexer.options.source_fetch_backoff = false;
    try std.testing.expectError(error.RpcError, indexer.tick(0, null));
    try std.testing.expectEqual(@as(u32, 0), indexer.fetch_retries[0].consecutive_failures);
}

test "origin cooperative backed-off candidate computes remaining delay from resumed clock" {
    const logs = events();
    var chain: YieldChain = .{ .chain = .{ .logs = &logs }, .fail_at = 3 };
    var store: Store = .{};
    var indexer: core.Core(Store) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000, .gas_enabled = false, .enabled_streams = .{ true, false, false } } };
    defer indexer.deinit();
    _ = try completeYieldCycle(&indexer, &chain, 1000); // Next retry6000.
    chain.beginPass();
    try std.testing.expectError(error.PendingReadIo, indexer.tick(6000, null));
    _ = try completeYieldCycle(&indexer, &chain, 14000); // Failed after IO =>24000.
    try std.testing.expectEqual(@as(u32, 2), indexer.fetch_retries[0].consecutive_failures);
    chain.beginPass();
    try std.testing.expectError(error.PendingReadIo, indexer.tick(20000, null));
    chain.beginPass();
    const report = try indexer.tick(21000, null);
    try std.testing.expectEqual(@as(u64, 3000), report.next_delay_ms);
    try std.testing.expect(indexer.current == null and indexer.frame == null);
    try std.testing.expectEqual(@as(u32, 2), indexer.fetch_retries[0].consecutive_failures);
}

test "origin cooperative gap delay starts at actual completed observation and suppresses early duplicate fetch" {
    const logs = events();
    var chain: YieldChain = .{ .chain = .{ .logs = &.{}, .sequence = true } };
    var store: Store = .{};
    var indexer: core.Core(Store) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .source_fetch_backoff = true, .domain = 10, .contracts = contracts, .chunk = 5, .lowest = 0, .interval_ms = 1000, .gas_enabled = false, .enabled_streams = .{ true, false, false } } };
    defer indexer.deinit();
    chain.beginPass();
    try std.testing.expectError(error.PendingReadIo, indexer.tick(1000, null));
    _ = try completeYieldCycle(&indexer, &chain, 20000);
    try std.testing.expect(store.ids[0] == null and store.ids[1] == null);
    try std.testing.expectEqual(@as(u64, 25000), indexer.cursors[0].?.gap_retry_at);
    const fetches = chain.chain.raw_calls[0];
    const held = try completeYieldCycle(&indexer, &chain, 24999);
    try std.testing.expectEqual(@as(u64, 1), held.next_delay_ms);
    try std.testing.expectEqual(fetches, chain.chain.raw_calls[0]);
    chain.chain.logs = &logs;
    _ = try completeYieldCycle(&indexer, &chain, 25000);
    try std.testing.expect(store.ids[0] != null and store.ids[1] != null);
    try std.testing.expectEqual(@as(u64, 0), indexer.cursors[0].?.gap_retry_at);
    try std.testing.expectEqual(@as(usize, 0), chain.reserved);
}
