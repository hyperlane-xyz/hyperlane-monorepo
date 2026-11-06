//! Deterministic fork/failure fixtures ported from production pipeline tests.
//! This in-memory store is test-only; production Worker uses native PG Store.
const std = @import("std");
const src = @import("source.zig");
const p = @import("pipeline.zig");
const runtime = @import("runtime.zig");
const db = @import("../../db/scraper_store.zig");
const protocol = @import("../../protocol/root.zig");
fn chainHash(height: u64, fork: u8) src.Hash {
    var result: src.Hash = .{0} ** 32;
    result[0] = fork;
    std.mem.writeInt(u64, result[24..32], height + 1, .big);
    return result;
}
pub const Chain = struct {
    head: u64 = 10,
    tag: u64 = 10,
    fork: u8 = 0,
    fork_after: u64 = 0,
    fail_events: bool = false,
    reorg_on_events: bool = false,
    wrong_log_hash: bool = false,
    pruned_below: u64 = 0,
    counts_available: bool = true,
    tip: ?u64 = null,
    tip_counts: ?[4]src.Tip = null,
    items: []const src.Event = &.{},
    pub fn interface(self: *Chain) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .counts_fn = counts, .historical_counts = true, .tip_fn = indexingTip, .tip_counts_fn = tipCounts };
    }
    fn cast(context: *anyopaque) *Chain {
        return @ptrCast(@alignCast(context));
    }
    fn at(self: *Chain, height: u64) src.Header {
        return .{ .height = height, .timestamp = 1, .hash = chainHash(height, if (height > self.fork_after) self.fork else 0), .parent = if (height == 0) .{0} ** 32 else chainHash(height - 1, if (height - 1 > self.fork_after) self.fork else 0) };
    }
    fn header(context: *anyopaque, selector: src.Selector, _: bool) !src.Header {
        const self = cast(context);
        const height = switch (selector) {
            .height => |height| height,
            .latest => self.head,
            .safe, .finalized => self.tag,
        };
        if (height > self.head) return error.FixtureUnavailableHeader;
        return self.at(height);
    }
    fn counts(context: *anyopaque, boundary: src.Hash) !?[2]u32 {
        const self = cast(context);
        const height = std.mem.readInt(u64, boundary[24..32], .big) - 1;
        if (height < self.pruned_below) return error.FixturePrunedState;
        if (!self.counts_available) return null;
        return .{ if (height >= 2) 1 else 0, if (height >= 2) 1 else 0 };
    }
    fn indexingTip(context: *anyopaque) !?u64 {
        return cast(context).tip;
    }
    fn tipCounts(context: *anyopaque) !?[4]src.Tip {
        return cast(context).tip_counts;
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, _: [4]u32) !src.Batch {
        const self = cast(context);
        if (self.fail_events) return error.FixtureLogsUnavailable;
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var list: std.ArrayList(src.Event) = .empty;
        for (self.items) |original| {
            if (original.block_number < from or original.block_number > through) continue;
            var event = original;
            event.block_hash = if (self.wrong_log_hash) .{0xee} ** 32 else self.at(event.block_number).hash;
            if (event.data == .dispatch) event.data.dispatch.body = try a.dupe(u8, event.data.dispatch.body);
            try list.append(a, event);
        }
        if (self.reorg_on_events) {
            self.fork = 99;
            self.fork_after = 0;
        }
        const owned_events = try list.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned_events, .through = through };
    }
};
const FakeStore = struct {
    current: db.State = .{ .indexed = 0, .hash = chainHash(0, 0), .confirmed = 0, .head = 0, .halted = false },
    healthy: bool = true,
    checkpoints: [128]?src.Hash = .{null} ** 128,
    events: [128]src.Event = undefined,
    event_count: usize = 0,
    append_calls: usize = 0,
    confirm_calls: usize = 0,
    fn init() FakeStore {
        var self: FakeStore = .{};
        self.checkpoints[0] = chainHash(0, 0);
        return self;
    }
    pub fn claim(_: *FakeStore, _: f64) !void {}
    pub fn state(self: *FakeStore) !?db.State {
        return self.current;
    }
    pub fn hash(self: *FakeStore, height: u64) !?src.Hash {
        if (height >= self.checkpoints.len) return null;
        return self.checkpoints[@intCast(height)];
    }
    pub fn checkpoint(self: *FakeStore, through: u64) !u64 {
        var height = @min(through, self.checkpoints.len - 1);
        while (true) {
            if (self.checkpoints[@intCast(height)] != null) return height;
            if (height == 0) return error.MissingFixtureCheckpoint;
            height -= 1;
        }
    }
    pub fn checkpointBetween(self: *FakeStore, after: u64, through: u64) !?u64 {
        const height = try self.checkpoint(through);
        return if (height > after) height else null;
    }
    pub fn pause(self: *FakeStore, halt: bool) !void {
        self.healthy = false;
        self.current.halted = self.current.halted or halt;
    }
    pub fn observe(self: *FakeStore, expected: db.State, ancestor: src.Header, head: src.Header) !void {
        if (!p.equal(expected.hash, self.current.hash)) return error.FixtureHeadChanged;
        if (ancestor.height < self.current.confirmed) return error.FixturePublishedReorg;
        self.removeSuffix(ancestor.height);
        self.current.indexed = ancestor.height;
        self.current.hash = ancestor.hash;
        self.current.head = head.height;
        self.healthy = true;
    }
    fn removeSuffix(self: *FakeStore, after: u64) void {
        for (&self.checkpoints, 0..) |*checkpoint_, height| if (height > after) {
            checkpoint_.* = null;
        };
        var count: usize = 0;
        for (self.events[0..self.event_count]) |event| if (event.block_number <= after) {
            self.events[count] = event;
            count += 1;
        };
        self.event_count = count;
    }
    pub fn sequenceCounts(self: *FakeStore) ![4]u32 {
        var result: [4]u32 = .{0} ** 4;
        for (self.events[0..self.event_count]) |event| switch (event.data) {
            .dispatch => |message| result[0] = @max(result[0], message.nonce + 1),
            .delivery => if (event.sequence) |sequence| {
                result[1] = @max(result[1], sequence + 1);
            },
            .gas => if (event.sequence) |sequence| {
                result[2] = @max(result[2], sequence + 1);
            },
            .insertion => |insert| result[3] = @max(result[3], insert.index + 1),
        };
        return result;
    }
    pub fn rewindToConfirmed(self: *FakeStore, expected: db.State) !void {
        if (!p.equal(expected.hash, self.current.hash)) return error.FixtureHeadChanged;
        self.removeSuffix(expected.confirmed);
        self.current.indexed = expected.confirmed;
        self.current.hash = self.checkpoints[@intCast(expected.confirmed)].?;
        self.healthy = false;
    }
    pub fn append(self: *FakeStore, expected: db.State, blocks: []const src.Block) !void {
        if (!self.healthy or !p.equal(expected.hash, self.current.hash)) return error.FixtureHeadChanged;
        for (blocks) |block| {
            if (block.header.height <= self.current.indexed) return error.FixtureUnorderedAppend;
            self.checkpoints[@intCast(block.header.height)] = block.header.hash;
            for (block.events) |event| {
                self.events[self.event_count] = event;
                self.event_count += 1;
            }
            self.current.indexed = block.header.height;
            self.current.hash = block.header.hash;
        }
        self.append_calls += 1;
    }
    pub fn confirmationBoundary(_: *FakeStore, _: u64, through: u64) !u64 {
        return through;
    }
    pub fn confirm(self: *FakeStore, expected: db.State, boundary: src.Header, _: f64) ![4]u64 {
        if (!self.healthy or !p.equal(expected.hash, self.current.hash) or boundary.height > self.current.indexed) return error.FixtureUnsafeConfirmation;
        self.current.confirmed = boundary.height;
        self.checkpoints[@intCast(boundary.height)] = boundary.hash;
        self.confirm_calls += 1;
        return .{0} ** 4;
    }
};
pub fn fixtureEvents() [2]src.Event {
    return .{
        .{ .block_number = 2, .block_hash = chainHash(2, 0), .address = .{1} ** 32, .log_index = 0, .data = .{ .dispatch = .{ .version = 3, .nonce = 0, .origin = 1, .sender = .{1} ** 32, .destination = 2, .recipient = .{2} ** 32, .body = "payload" } } },
        .{ .block_number = 2, .block_hash = chainHash(2, 0), .address = .{2} ** 32, .log_index = 1, .data = .{ .insertion = .{ .message_id = .{3} ** 32, .index = 0 } } },
    };
}

test "scraper source complete range counts publish and restart catches fork" {
    const events = fixtureEvents();
    var chain: Chain = .{ .items = &events };
    var store = FakeStore.init();
    var worker: runtime.Worker(FakeStore) = .{ .allocator = std.testing.allocator, .source = chain.interface(), .store = &store, .options = .{ .period = .{ .blocks = 2 }, .chunk_size = 10 } };
    const outcome = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 10), outcome.indexed);
    try std.testing.expectEqual(@as(u64, 8), outcome.confirmed);
    try std.testing.expectEqual([4]u32{ 1, 0, 0, 1 }, try store.sequenceCounts());
    chain.fork = 7;
    chain.fork_after = 8;
    chain.head = 12;
    chain.tag = 12;
    const after = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 10), after.confirmed);
    try std.testing.expect(p.equal(store.current.hash, chain.at(12).hash));
}

test "scraper dropped tail never publishes and recovers without a new block" {
    const events = fixtureEvents();
    var chain: Chain = .{ .items = events[0..1] };
    var store = FakeStore.init();
    var worker: runtime.Worker(FakeStore) = .{ .allocator = std.testing.allocator, .source = chain.interface(), .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    try std.testing.expectError(error.ScraperIncompleteRange, worker.cycle());
    try std.testing.expectEqual(@as(u64, 0), store.current.confirmed);
    try std.testing.expectEqual(@as(u64, 0), store.current.indexed);
    chain.items = &events;
    _ = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 10), store.current.confirmed);
}

test "scraper historical count outage holds provisional tail and restart reproof repairs it" {
    const events = fixtureEvents();
    var chain: Chain = .{ .items = events[0..1], .counts_available = false };
    var store = FakeStore.init();
    var worker: runtime.Worker(FakeStore) = .{ .allocator = std.testing.allocator, .source = chain.interface(), .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    const provisional = try worker.cycle();
    try std.testing.expect(provisional.ingestion_failed);
    try std.testing.expectEqual(@as(u64, 10), store.current.indexed);
    try std.testing.expectEqual(@as(u64, 0), store.current.confirmed);
    worker.cache = .{};
    chain.counts_available = true;
    chain.items = &events;
    _ = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 10), store.current.confirmed);
    try std.testing.expectEqual([4]u32{ 1, 0, 0, 1 }, try store.sequenceCounts());
}

test "scraper lagging RPC and midrange reorg pause publication" {
    const events = fixtureEvents();
    var chain: Chain = .{ .items = &events, .reorg_on_events = true };
    var store = FakeStore.init();
    var worker: runtime.Worker(FakeStore) = .{ .allocator = std.testing.allocator, .source = chain.interface(), .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    try std.testing.expectError(error.ScraperLogForkMismatch, worker.cycle());
    try std.testing.expectEqual(@as(u64, 0), store.current.confirmed);
    chain.reorg_on_events = false;
    chain.fork = 0;
    _ = try worker.cycle();
    chain.head = 9;
    try std.testing.expectError(error.ScraperRpcBehind, worker.cycle());
    try std.testing.expectEqual(@as(u64, 10), store.current.confirmed);
    try std.testing.expect(!store.healthy);
}

test "scraper stream tips cap ingestion and confirmed fork mismatch halts" {
    const events = fixtureEvents();
    var chain: Chain = .{ .items = &events, .tip = 5 };
    var store = FakeStore.init();
    var worker: runtime.Worker(FakeStore) = .{ .allocator = std.testing.allocator, .source = chain.interface(), .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    _ = try worker.cycle();
    try std.testing.expectEqual(@as(u64, 5), store.current.indexed);
    try std.testing.expectEqual(@as(u64, 5), store.current.confirmed);
    chain.fork = 2;
    chain.fork_after = 0;
    try std.testing.expectError(error.ScraperPublishedReorg, worker.cycle());
    try std.testing.expect(store.current.halted);
}

test "scraper empty sparse range rechecks its canonical tip after fetching logs" {
    var chain: Chain = .{ .head = 1, .tag = 1, .reorg_on_events = true };
    var store = FakeStore.init();
    var worker: runtime.Worker(FakeStore) = .{ .allocator = std.testing.allocator, .source = chain.interface(), .store = &store, .options = .{ .period = .latest, .chunk_size = 10 } };
    try std.testing.expectError(error.ScraperForkChanged, worker.cycle());
    try std.testing.expectEqual(@as(u64, 0), store.current.indexed);
}

const ReceiptStore = struct {
    cached: [3]bool = .{ false, true, false },
    missing_block: bool = false,
    linked: u64 = 0,
    fn meta(index: u8) @import("enrichment.zig").Meta {
        var tx: [64]u8 = .{0} ** 64;
        tx[63] = index + 1;
        return .{ .block_number = 2, .block_hash = .{2} ** 32, .tx_hash = tx };
    }
    pub fn pendingReceipts(_: *ReceiptStore, a: std.mem.Allocator, _: @import("enrichment.zig").Stream, after: i64, _: usize) ![]@import("enrichment.zig").Row {
        if (after != 0) return a.alloc(@import("enrichment.zig").Row, 0);
        const rows = try a.alloc(@import("enrichment.zig").Row, 3);
        for (rows, 0..) |*row, index| row.* = .{ .id = @intCast(index + 1), .meta = meta(@intCast(index)) };
        return rows;
    }
    pub fn knownBlock(self: *ReceiptStore, _: @import("enrichment.zig").Meta) !?i64 {
        return if (self.missing_block) null else 7;
    }
    pub fn ensureBlock(_: *ReceiptStore, _: src.Header) !i64 {
        return 7;
    }
    pub fn knownTransaction(self: *ReceiptStore, value: @import("enrichment.zig").Meta) !?i64 {
        return if (self.cached[value.tx_hash[63] - 1]) @as(i64, value.tx_hash[63]) + 10 else null;
    }
    pub fn storeTransaction(self: *ReceiptStore, block: i64, value: @import("enrichment.zig").Txn) !void {
        try std.testing.expectEqual(@as(i64, 7), block);
        self.cached[value.hash[63] - 1] = true;
    }
    pub fn linkReceipts(self: *ReceiptStore, _: @import("enrichment.zig").Stream, _: i64, _: i64) !u64 {
        self.linked = 0;
        for (self.cached) |cached| {
            if (cached) self.linked += 1;
        }
        return self.linked;
    }
};
const ReceiptFetcher = struct {
    fn fetch(_: *anyopaque, a: std.mem.Allocator, meta: @import("enrichment.zig").Meta, _: u64) !@import("enrichment.zig").OwnedTxn {
        if (meta.tx_hash[63] == 1) return error.FixtureReceiptTimeout;
        return .{ .arena = std.heap.ArenaAllocator.init(a), .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = 1, .nonce = 0, .sender = .{0} ** 32, .gas_used = 1, .cumulative_gas_used = 1 } };
    }
};
test "scraper receipt timeout preserves cached and independently persisted neighbors" {
    const enrich = @import("enrichment.zig");
    var store: ReceiptStore = .{};
    var lane: enrich.Lane = .{ .stream = .delivery };
    var page = try lane.plan(std.testing.allocator, &store);
    defer page.deinit();
    try std.testing.expectEqual(@as(usize, 2), page.requests.len);
    var context: u8 = 0;
    const fetcher: enrich.Fetcher = .{ .context = &context, .fetch_fn = ReceiptFetcher.fetch };
    try std.testing.expectError(error.FixtureReceiptTimeout, enrich.fetchAndPersist(std.testing.allocator, &store, fetcher, page.requests[0], 1));
    try enrich.fetchAndPersist(std.testing.allocator, &store, fetcher, page.requests[1], 1);
    const outcome = try lane.finish(&store, page);
    try std.testing.expectEqual(@as(u64, 2), outcome.linked);
    try std.testing.expectEqual(@as(usize, 1), outcome.pending);
    try std.testing.expectEqual(@as(i64, 3), lane.after);
    try std.testing.expect(!outcome.more);
    var next = try lane.plan(std.testing.allocator, &store);
    defer next.deinit();
    try std.testing.expectEqual(@as(i64, 0), lane.after);
}
test "scraper receipt plan rejects missing retained headers" {
    var store: ReceiptStore = .{ .missing_block = true };
    var lane: @import("enrichment.zig").Lane = .{ .stream = .gas };
    try std.testing.expectError(error.MissingRetainedReceiptBlock, lane.plan(std.testing.allocator, &store));
}

test "scraper reconciliation snapshots frontiers preempts sweeps and backs off only failed lane" {
    const r = @import("reconciliation.zig");
    var schedule = r.Schedule.init(0, 0, 0);
    try schedule.startSweep(200, 0);
    try schedule.completeSweep(.{ .candidate_count = 100, .next_after_id = 100 }, 0);
    try std.testing.expectEqual(@as(i64, 100), schedule.discovery_watermark);
    try std.testing.expectEqual(r.Lane.discovery_frontier, schedule.due(5000, false).?);
    try schedule.startDiscovery(250, 5000);
    try std.testing.expectEqual(r.Lane.discovery_page, schedule.due(5000, false).?);
    try schedule.completeDiscovery(.{ .candidate_count = 0 }, 5000);
    try std.testing.expectEqual(@as(i64, 250), schedule.discovery_watermark);
    try std.testing.expectEqual(r.Lane.sweep_page, schedule.due(5000, false).?);
    try schedule.failed(.retry, 5000);
    try std.testing.expectEqual(@as(?r.Lane, null), schedule.due(6999, true));
    try std.testing.expectEqual(r.Lane.sweep_page, schedule.due(7000, true).?);
    try std.testing.expectEqual(r.Lane.retry, schedule.due(9000, true).?);
}
test "scraper reconciliation poison retry tracking is bounded and ordered" {
    const r = @import("reconciliation.zig");
    var backoff: r.Backoff = .{ .allocator = std.testing.allocator };
    defer backoff.deinit();
    for (1..1001) |index| {
        _ = try backoff.missing(@intCast(index), 0, 0);
    }
    try std.testing.expectEqual(@as(?u32, null), try backoff.missing(1001, 0, 0));
    try std.testing.expect(!backoff.shouldAttempt(1, 59));
    try std.testing.expect(backoff.shouldAttempt(1, 60));
    const due = try backoff.due(std.testing.allocator, 60, 100);
    defer std.testing.allocator.free(due);
    try std.testing.expectEqual(@as(i64, 1), due[0]);
    try std.testing.expectEqual(@as(i64, 100), due[99]);
    try std.testing.expectEqual(@as(u64, 60), backoff.maxAge(60));
    backoff.success(1);
    try std.testing.expectEqual(@as(?u32, 1), try backoff.missing(1001, 60, 60));
}

const GenericProvider = struct {
    head: u64 = 5,
    skipped_through: u64 = 0,
    calls: usize = 0,
    fn latest(context: *anyopaque) !u64 {
        const self: *GenericProvider = @ptrCast(@alignCast(context));
        return self.head;
    }
    fn header(context: *anyopaque, height: u64) !src.Header {
        const self: *GenericProvider = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (height <= self.skipped_through and self.skipped_through != 0) return error.FixtureSkipped;
        if (height > self.head) return error.FixtureUnavailableHeader;
        return .{ .height = height, .hash = chainHash(height, 0), .timestamp = 1 };
    }
    fn unavailable(err: anyerror) bool {
        return err == error.FixtureSkipped;
    }
};
const GenericStream = struct {
    tip: src.Tip,
    items: []const src.Event = &.{},
    tip_calls: usize = 0,
    fn getTip(context: *anyopaque) !src.Tip {
        const self: *GenericStream = @ptrCast(@alignCast(context));
        self.tip_calls += 1;
        return self.tip;
    }
    fn fetch(context: *anyopaque, allocator: std.mem.Allocator, from: u32, through: u32) !src.Batch {
        const self: *GenericStream = @ptrCast(@alignCast(context));
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var list: std.ArrayList(src.Event) = .empty;
        for (self.items) |event| {
            const sequence_ = event.sequence orelse event.data.dispatch.nonce;
            if (sequence_ >= from and sequence_ <= through) try list.append(a, event);
        }
        const owned_events = try list.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned_events, .through = through };
    }
    fn interface(self: *GenericStream) @import("generic.zig").Stream {
        return .{ .context = self, .tip_fn = getTip, .fetch_fn = fetch };
    }
};
test "scraper generic source pages complete blocks derives insertions and caches cycle tips" {
    const generic = @import("generic.zig");
    var provider: GenericProvider = .{};
    var messages = [_]src.Event{ fixtureEvents()[0], fixtureEvents()[0], fixtureEvents()[0] };
    for (&messages, 0..) |*message, index| {
        message.data.dispatch.nonce = @intCast(index);
        message.sequence = @intCast(index);
        message.block_number = index + 2;
        message.log_index = index;
    }
    var dispatch: GenericStream = .{ .tip = .{ .count = 3, .tip = 5 }, .items = &messages };
    var delivery: GenericStream = .{ .tip = .{ .count = 0, .tip = 5 } };
    var gas: GenericStream = .{ .tip = .{ .count = 0, .tip = 5 } };
    var adapter: generic.Adapter = .{ .allocator = std.testing.allocator, .provider = .{ .context = &provider, .latest_fn = GenericProvider.latest, .header_fn = GenericProvider.header, .unavailable_fn = GenericProvider.unavailable }, .streams = .{ dispatch.interface(), delivery.interface(), gas.interface(), null }, .contracts = .{ .mailbox = .{1} ** 32, .hook = .{2} ** 32, .paymaster = .{3} ** 32 }, .sequence_mode = true, .derive_insertions = true, .chunk = 1 };
    defer adapter.deinit();
    const source = try adapter.interface();
    try source.beginCycle();
    try std.testing.expectEqual(@as(?u64, 5), try source.indexingTip());
    try std.testing.expectEqual(@as(?u64, 5), try source.indexingTip());
    try std.testing.expectEqual(@as(usize, 1), dispatch.tip_calls);
    var first = try source.events(std.testing.allocator, 1, 5, .{0} ** 4);
    defer first.deinit();
    try std.testing.expectEqual(@as(u64, 2), first.through);
    try std.testing.expectEqual(@as(usize, 2), first.events.len);
    try std.testing.expectEqual(@as(u32, 0), first.events[1].data.insertion.index);
    var next = try source.events(std.testing.allocator, 3, 5, .{ 1, 0, 0, 1 });
    defer next.deinit();
    try std.testing.expectEqual(@as(u64, 5), next.through);
    try std.testing.expectEqual(@as(usize, 4), next.events.len);
    try std.testing.expectEqual(@as(u32, 1), next.events[0].data.dispatch.nonce);
    try std.testing.expectError(error.ScraperDerivedInsertionDiverged, source.events(std.testing.allocator, 3, 5, .{ 1, 0, 0, 0 }));
    dispatch.items = messages[0..2];
    try std.testing.expectError(error.ScraperIncompleteSequencePage, source.events(std.testing.allocator, 3, 5, .{ 1, 0, 0, 1 }));
    dispatch.items = &messages;
    adapter.max_batch_bytes = 1;
    try std.testing.expectError(error.ScraperEventByteLimit, source.events(std.testing.allocator, 3, 5, .{ 1, 0, 0, 1 }));
}
test "scraper generic sparse slots advance past an entirely skipped chunk within observed head" {
    const generic = @import("generic.zig");
    var provider: GenericProvider = .{ .skipped_through = 3 };
    var stream: GenericStream = .{ .tip = .{ .count = 0, .tip = 5 } };
    var adapter: generic.Adapter = .{ .allocator = std.testing.allocator, .provider = .{ .context = &provider, .latest_fn = GenericProvider.latest, .header_fn = GenericProvider.header, .unavailable_fn = GenericProvider.unavailable }, .streams = .{ stream.interface(), stream.interface(), stream.interface(), stream.interface() }, .contracts = .{ .mailbox = .{1} ** 32, .hook = .{2} ** 32, .paymaster = .{3} ** 32 }, .sequence_mode = false, .derive_insertions = false, .chunk = 3 };
    defer adapter.deinit();
    const source = try adapter.interface();
    const boundary = try source.rangeEnd(0, 3, 5, true);
    try std.testing.expectEqual(@as(u64, 4), boundary.height);
    try std.testing.expectEqual(@as(u64, 5), (try source.emptyAnchor()).?.height);
    _ = try source.header(.{ .height = 5 });
    const calls = provider.calls;
    _ = try source.header(.{ .height = 5 });
    try std.testing.expectEqual(calls, provider.calls);
    _ = try source.freshHeader(.{ .height = 5 });
    try std.testing.expectEqual(calls + 1, provider.calls);
}

const SetupStore = struct {
    saved: ?db.State = null,
    initializations: usize = 0,
    validations: usize = 0,
    pub fn state(self: *SetupStore) !?db.State {
        return self.saved;
    }
    pub fn anchorHeight(_: *SetupStore, from: u64) !u64 {
        return from -| 1;
    }
    pub fn initialize(self: *SetupStore, header: src.Header, _: src.Contracts) !void {
        self.initializations += 1;
        self.saved = .{ .indexed = header.height, .hash = header.hash, .confirmed = header.height, .head = header.height, .halted = false };
    }
    pub fn validateCheckpoints(self: *SetupStore) !void {
        self.validations += 1;
    }
    pub fn validateContracts(self: *SetupStore, _: src.Contracts) !void {
        self.validations += 1;
    }
};
test "scraper setup validates capabilities before cutover and does not demand saved indexed RPC height" {
    const setup = @import("setup.zig");
    const settings = @import("../../settings/types.zig");
    var chain: Chain = .{ .head = 1000, .tag = 1001 };
    var store: SetupStore = .{};
    var config: struct { protocol: settings.Protocol, index: settings.Index, contracts: settings.Contracts, reorg: settings.Reorg } = .{ .protocol = .ethereum, .index = settings.Index{ .from = -100 }, .contracts = settings.Contracts{ .mailbox = .{1} ** 32, .interchain_gas_paymaster = .{3} ** 32, .merkle_tree_hook = .{2} ** 32, .validator_announce = .{4} ** 32 }, .reorg = settings.Reorg{ .tag = "finalized" } };
    try std.testing.expectError(error.FixtureUnavailableHeader, setup.prepare(chain.interface(), &store, config));
    try std.testing.expectEqual(@as(usize, 0), store.initializations);
    chain.tag = 900;
    try setup.prepare(chain.interface(), &store, config);
    try std.testing.expectEqual(@as(u64, 899), store.saved.?.indexed);
    chain.head = 800;
    chain.tag = 790;
    try setup.prepare(chain.interface(), &store, config);
    try std.testing.expectEqual(@as(usize, 1), store.initializations);
    try std.testing.expectEqual(@as(usize, 2), store.validations);
    store.saved = null;
    config.protocol = .cosmos;
    config.index.from = 0;
    config.reorg = .{ .blocks = 0 };
    try setup.prepare(chain.interface(), &store, config);
    try std.testing.expectEqual(@as(u64, 1), store.saved.?.indexed);
    store.saved = null;
    var source = chain.interface();
    source.sequence_mode = true;
    try std.testing.expectError(error.ScraperExplicitCutoverRequired, setup.prepare(source, &store, config));
}
