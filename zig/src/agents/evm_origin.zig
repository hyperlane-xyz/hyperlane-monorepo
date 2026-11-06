//! Operational relayer origin indexing. Dispatch and tree gaps use the exact
//! sequence cursor; gas payments use the source's separate forward watermark.
const std = @import("std");
const settings = @import("../settings/types.zig");
const indexing = @import("../evm/indexer.zig");
const rpc = @import("../evm/provider.zig");
const rocks = @import("../db/rocks.zig");
const native = @import("store.zig");
const sequence = @import("../runtime/sequence_cursor.zig");
const block = @import("../runtime/block_cursor.zig");
const origin = @import("origin.zig");
const engine = @import("../relayer/remote_checkpoints.zig");
const A = std.mem.Allocator;
const observation = @import("../runtime/indexing_observer.zig");
const fetch_backoff = @import("indexing/fetch_backoff.zig");
const bootstrap = @import("indexing/cursor_bootstrap.zig");
const critical_metrics = @import("../ops/critical_metrics.zig");
const tick_clock = @import("validator/tick_clock.zig");
const initialization = @import("../ops/init_metrics.zig");
pub const Report = struct { ranges: usize = 0, messages: usize = 0, insertions: usize = 0, payments: usize = 0, prover_leaves: usize = 0, next_delay_ms: u64 = 0 };
pub const Service = struct {
    const Retained = struct { batch: indexing.Batch, query: sequence.Query, selected: usize, count: u32, offset: usize = 0 };
    retained: ?Retained = null,
    allocator: A,
    chain: *const settings.Chain,
    store: native.Store,
    history: origin.Origin,
    indexer: indexing.Indexer,
    progress: [2]native.SequenceStore,
    cursors: [2]?sequence.Cursor = .{ null, null },
    gas: ?block.Cursor = null,
    gas_enabled: bool,
    enabled_streams: [3]bool = .{ true, true, true },
    next_stream: usize = 0,
    selected_stream: ?usize = null,
    round_time_ms: ?u64 = null,
    gas_refresh: bool = false,
    gas_stored_payments: usize = 0,
    due: [3]u64 = @splat(0),
    observer: ?observation.Observer = null,
    fetch_retries: [3]fetch_backoff.State = @splat(.{}),
    critical: ?*critical_metrics.Tracker = null,
    bootstrap: [3]bootstrap.State = @splat(.{}),
    cycle_clock: tick_clock.Clock = .{},
    initialization_observer: ?initialization.Observer = null,
    indexer_init_ns: ?u64 = null,
    prover_init_ns: ?u64 = null,
    merkle_init_ns: ?u64 = null,
    pub fn open(a: A, chain: *const settings.Chain, client: *rpc.RpcClient, database: *rocks.Database, remote: *engine.Engine, gas_enabled: bool) !*Service {
        if (chain.protocol != .ethereum or chain.index.mode != .block) return error.ExpectedEvmBlockOrigin;
        if (client.options.native_transport == null) return error.NativeOriginTransportRequired;
        if (chain.index.chunk > 65535) return error.EvmOriginChunkLimit;
        const self = try a.create(Service);
        errdefer a.destroy(self);
        const period: @import("../storage/objects.zig").ReorgPeriod = switch (chain.reorg) {
            .blocks => |n| if (n == 0) .none else .{ .blocks = n },
            .tag => |tag| .{ .tag = tag },
        };
        var timer = std.time.Timer.start() catch null;
        self.* = .{ .allocator = a, .chain = chain, .store = native.Store.init(a, database, chain.name), .history = undefined, .indexer = try indexing.Indexer.init(a, client, .{ .chain_id = try std.fmt.parseInt(u256, chain.chain_id, 0), .domain = chain.domain, .mailbox = try address(chain.contracts.mailbox), .hook = try address(chain.contracts.merkle_tree_hook), .paymaster = try address(chain.contracts.interchain_gas_paymaster), .reorg_period = period }), .progress = undefined, .gas_enabled = gas_enabled };
        if (timer) |*clock| self.indexer_init_ns = clock.lap();
        self.history = origin.Origin.init(a, &self.store, chain.domain, chain.contracts.merkle_tree_hook, remote);
        if (timer) |*clock| self.prover_init_ns = clock.lap();
        self.progress[0] = .{ .store = &self.store, .stream = .dispatch };
        if (timer) |*clock| clock.reset();
        self.progress[1] = .{ .store = &self.store, .stream = .insertion };
        if (timer) |*clock| self.merkle_init_ns = clock.read();
        return self;
    }
    /// Called only after the enclosing origin has passed its chain fence. The
    /// provider/indexer is shared; its construction is charged once to message
    /// sync. Other streams report only their actual native state construction.
    pub fn observeInitialization(self: *Service, observer_: initialization.Observer) void {
        self.initialization_observer = observer_;
        if (self.indexer_init_ns) |elapsed| observer_.completed(.message_sync, elapsed);
        if (self.prover_init_ns) |elapsed| observer_.completed(.prover_sync, elapsed);
        if (self.merkle_init_ns) |elapsed| observer_.completed(.merkle_tree_hook_sync, elapsed);
        self.indexer_init_ns = null;
        self.prover_init_ns = null;
        self.merkle_init_ns = null;
    }
    pub fn deinit(self: *Service) void {
        self.abortRetained();
        for (&self.cursors) |*cursor| if (cursor.*) |*value| value.deinit();
        self.history.deinit();
        self.allocator.destroy(self);
    }
    pub fn hasEnabledStreams(self: *const Service) bool {
        return self.enabled_streams[0] or self.enabled_streams[1] or (self.gas_enabled and self.enabled_streams[2]);
    }
    /// Called only by this service's owner between cooperative passes.
    pub fn setStreamMask(self: *Service, enabled: [3]bool) bool {
        var aborted = false;
        if (self.selected_stream) |selected| if (!enabled[selected]) {
            if (selected < 2) {
                if (self.cursors[selected]) |*cursor| if (cursor.pending) |query| cursor.failed(query.token) catch {};
            } else if (self.gas) |*cursor| cursor.failed();
            self.abortRetained();
            self.selected_stream = null;
            self.round_time_ms = null;
            self.gas_refresh = false;
            self.gas_stored_payments = 0;
            aborted = true;
        };
        for (self.enabled_streams, enabled, 0..) |old, new, i| if (!old and new) {
            self.due[i] = 0;
        };
        self.enabled_streams = enabled;
        if (!enabled[0] and !enabled[1]) {
            self.bootstrap[0].handoff();
            self.bootstrap[1].handoff();
            if (self.critical) |tracker| tracker.clearDirectRpc();
        }
        return aborted;
    }
    /// One bounded range per call; rotating streams prevents gas or historical
    /// tree backfill from monopolizing message indexing. Store sync is replayable.
    pub fn tick(self: *Service, now_ms: u64, cancel: ?*const std.atomic.Value(bool)) !Report {
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        try self.cycle_clock.begin(now_ms);
        defer self.cycle_clock.end();
        for (&self.bootstrap, 0..) |*state, i| {
            if (self.enabled_streams[i] and (i != 2 or self.gas_enabled)) state.poll(now_ms, self.critical, i);
        }
        self.indexer.client.options.cancel = cancel;
        defer self.indexer.client.options.cancel = null;
        if (self.round_time_ms == null) self.round_time_ms = now_ms;
        const report = self.tickRound(self.round_time_ms.?, now_ms) catch |err| {
            const selected = self.selected_stream;
            if (err == error.TxIdQueueFull) return .{ .next_delay_ms = 10 };
            if (err != error.PendingReadIo) {
                self.abortRetained();
                self.selected_stream = null;
                self.round_time_ms = null;
            }
            if (selected) |i| {
                var actual = err;
                // Only a direct native curl timeout is a completed RPC failure.
                // Cooperative journals and caller deadlines retain control status.
                const client = self.indexer.client;
                const canceled = if (cancel) |flag| flag.load(.acquire) else false;
                if (err == error.RequestDeadlineExceeded and !canceled and client.options.exchange == null) if (client.options.native_transport) |transport| {
                    if (transport.send_override == null) actual = error.ConnectionTimedOut;
                };
                const completed_ms = self.cycle_clock.now(now_ms);
                if (self.bootstrap[i].failed(actual, completed_ms)) {
                    std.log.warn("origin {s} cursor startup failed ({d}/10); retry in 2000ms: {s}", .{ @tagName(bootstrap.reasons[i]), self.bootstrap[i].failures, @errorName(actual) });
                    self.due[i] = self.bootstrap[i].retry_at_ms;
                    return .{ .next_delay_ms = self.nextDelay(completed_ms) };
                }
            }
            return err;
        };
        self.selected_stream = null;
        self.round_time_ms = null;
        return report;
    }
    fn abortRetained(self: *Service) void {
        if (self.retained) |*held| {
            if (self.cursors[held.selected]) |*cursor| cursor.failed(held.query.token) catch {};
            held.batch.deinit();
        }
        self.retained = null;
    }
    fn finishRetained(self: *Service, now_ms: u64, report: *Report) !void {
        const held = &self.retained.?;
        const points = try held.batch.storeObservedFrom(&self.store, self.observer, &held.offset);
        defer self.allocator.free(points);
        try self.cursors[held.selected].?.update(held.query.token, points, now_ms, self.progress[held.selected].interface());
        report.ranges += 1;
        if (held.selected == 0) report.messages = points.len else report.insertions = points.len;
        held.batch.deinit();
        self.retained = null;
        try self.indexer.client.commitReadSection();
    }
    fn nextDelay(self: *Service, now_ms: u64) u64 {
        var due: u64 = std.math.maxInt(u64);
        for (self.due, 0..) |value, i| if (self.enabled_streams[i] and (i != 2 or self.gas_enabled)) {
            due = @min(due, value);
        };
        return due -| now_ms;
    }
    fn admitFetch(self: *Service, selected: usize, range: sequence.Range, now_ms: u64) bool {
        if (self.fetch_retries[selected].remainingDelay(range, now_ms)) |remaining| {
            self.due[selected] = now_ms +| @min(remaining, 5000);
            return false;
        }
        if (self.fetch_retries[selected].retryEligible(range, now_ms)) if (self.observer) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected], .delay_ms = 0 } });
        return true;
    }
    fn fetched(self: *Service, selected: usize, range: sequence.Range) void {
        if (self.fetch_retries[selected].recordSuccess(range)) if (self.observer) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected], .delay_ms = 0 } });
    }
    fn failedFetch(self: *Service, selected: usize, range: sequence.Range, now_ms: u64, err: anyerror) !Report {
        if (!observation.retryable(err)) return err;
        const delay = self.fetch_retries[selected].recordFailure(range, now_ms);
        self.due[selected] = now_ms +| @min(delay, 5000);
        const stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected];
        if (self.observer) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = stream, .delay_ms = delay, .retry = true } });
        std.log.warn("origin {s} range fetch failed; retry in {d}ms: {s}", .{ @tagName(stream), delay, @errorName(err) });
        return .{ .next_delay_ms = std.mem.min(u64, &self.due) -| now_ms };
    }
    fn tickRound(self: *Service, planned_ms: u64, now_ms: u64) !Report {
        var report: Report = .{};
        if (self.retained) |held| {
            try self.finishRetained(now_ms, &report);
            observation.completed(self.observer, if (held.selected == 0) .dispatch else .insertion, &self.cursors[held.selected].?, null, held.count, now_ms);
            report.prover_leaves = try self.history.sync(64);
            report.next_delay_ms = if (report.prover_leaves == 64) 0 else self.nextDelay(now_ms);
            return report;
        }
        const streams: usize = if (self.gas_enabled) 3 else 2;
        const selected = self.selected_stream orelse for (0..streams) |_| {
            const candidate = self.next_stream;
            self.next_stream = (candidate + 1) % streams;
            if (self.enabled_streams[candidate] and self.due[candidate] <= now_ms) break candidate;
        } else {
            report.prover_leaves = try self.history.sync(64);
            var due: u64 = std.math.maxInt(u64);
            for (self.due[0..streams], 0..) |value, i| if (self.enabled_streams[i]) {
                due = @min(due, value);
            };
            report.next_delay_ms = if (report.prover_leaves == 64) 0 else due -| now_ms;
            return report;
        };
        self.selected_stream = selected;
        if (!self.indexer.chain_checked) try self.indexer.check();
        var observed = false;
        var observed_count: ?u32 = null;
        // An individual stream error cannot force every other stream to wait
        // its retry interval. The task owner can invoke another short cycle.
        self.due[selected] = planned_ms +| self.chain.index.interval *| 1000;
        if (selected < 2) {
            const stream: native.Stream = if (selected == 0) .dispatch else .insertion;
            const tip = try self.indexer.countTip(stream);
            const count = tip.count orelse return error.MissingEvmCount;
            observed = true;
            observed_count = count;
            if (self.cursors[selected] == null) self.cursors[selected] = try sequence.Cursor.init(self.allocator, count, tip.tip, .{ .chunk = self.chain.index.chunk, .lowest = self.chain.index.from, .idle_ms = self.chain.index.interval *| 1000 });
            const cursor = &self.cursors[selected].?;
            const action = try cursor.plan(count, tip.tip, planned_ms, self.progress[selected].interface());
            self.bootstrap[selected].succeeded(self.critical, selected);
            self.due[selected] = switch (action) {
                .sleep_until_ms => |ready| ready,
                else => now_ms,
            };
            if (action == .query) {
                errdefer |err| if (err != error.TxIdQueueFull) {
                    cursor.failed(action.query.token) catch {};
                };
                if (!self.admitFetch(selected, action.query.range, now_ms)) {
                    try cursor.failed(action.query.token);
                    observation.completed(self.observer, stream, cursor, null, count, now_ms);
                    return .{ .next_delay_ms = std.mem.min(u64, &self.due) -| now_ms };
                }
                const batch = self.indexer.fetch(stream, action.query.range, tip.tip) catch |err| {
                    cursor.failed(action.query.token) catch {};
                    return self.failedFetch(selected, action.query.range, now_ms, err);
                };
                self.fetched(selected, action.query.range);
                self.retained = .{ .batch = batch, .query = action.query, .selected = selected, .count = count };
                try self.finishRetained(now_ms, &report);
            }
        } else gas: {
            if (self.gas_refresh) {
                try self.finishGas(now_ms, &report);
                observed = true;
                break :gas;
            }
            if (self.gas) |*cursor| if (cursor.rateLimit(now_ms)) |ready| {
                self.due[selected] = ready;
                break :gas;
            };
            const head = try self.indexer.finalized();
            observed = true;
            const tip = std.math.cast(u32, head.number) orelse return error.IndexHeightOutOfRange;
            if (self.gas == null) {
                var timer = std.time.Timer.start() catch null;
                self.gas = try block.Cursor.init(tip, try self.store.gasWatermark(), now_ms, .{ .chunk = self.chain.index.chunk, .lowest = self.chain.index.from, .idle_ms = self.chain.index.interval *| 1000, .configured_interval_ms = if (self.chain.index.configured_interval) |n| n *| 1000 else null });
                if (self.initialization_observer) |sink| if (timer) |*clock| sink.completed(.interchain_gas_payment_sync, clock.read());
            }
            const cursor = &self.gas.?;
            const action = try cursor.plan(tip, planned_ms);
            self.bootstrap[selected].succeeded(self.critical, selected);
            self.due[selected] = switch (action) {
                .sleep_until_ms => |ready| ready,
                else => now_ms,
            };
            if (action == .query) {
                errdefer if (!self.gas_refresh) {
                    cursor.failed();
                };
                if (!self.admitFetch(selected, action.query, now_ms)) {
                    cursor.failed();
                    observation.completed(self.observer, .gas, null, cursor, null, now_ms);
                    return .{ .next_delay_ms = std.mem.min(u64, &self.due) -| now_ms };
                }
                var batch = self.indexer.fetch(.gas, action.query, tip) catch |err| {
                    cursor.failed();
                    return self.failedFetch(selected, action.query, now_ms, err);
                };
                self.fetched(selected, action.query);
                defer batch.deinit();
                const points = try batch.storeObserved(&self.store, self.observer);
                self.allocator.free(points);
                try self.store.storeGasWatermark(cursor.watermark());
                // This completed read section has committed. Resume directly
                // at the fresh-tip stage if the next physical read suspends.
                self.gas_refresh = true;
                self.gas_stored_payments = batch.logs.len;
                try self.indexer.client.commitReadSection();
                try self.finishGas(now_ms, &report);
            }
        }
        if (observed) observation.completed(self.observer, ([_]native.Stream{ .dispatch, .insertion, .gas })[selected], if (selected < 2) &self.cursors[selected].? else null, if (self.gas) |*value| value else null, observed_count, now_ms);
        report.prover_leaves = try self.history.sync(64);
        report.next_delay_ms = if (report.prover_leaves == 64) 0 else std.mem.min(u64, self.due[0..streams]) -| now_ms;
        return report;
    }
    fn finishGas(self: *Service, now_ms: u64, report: *Report) !void {
        const refreshed = try self.indexer.finalized();
        try self.gas.?.update(std.math.cast(u32, refreshed.number) orelse return error.IndexHeightOutOfRange, now_ms);
        self.gas_refresh = false;
        report.ranges += 1;
        report.payments = self.gas_stored_payments;
        self.gas_stored_payments = 0;
        try self.indexer.client.commitReadSection();
    }
};
fn address(hash: [32]u8) ![20]u8 {
    if (!std.mem.allEqual(u8, hash[0..12], 0)) return error.InvalidEvmAddress;
    return hash[12..32].*;
}
