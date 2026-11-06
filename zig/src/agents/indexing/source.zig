//! Source-neutral relayer origin cursor. Real chain adapters own network decode;
//! this layer fences canonical reads, persists native DB events before cursor
//! advancement and rotates independent dispatch/tree/gas lanes.
const std = @import("std");
const src = @import("../scraper/source.zig");
const sequence = @import("../../runtime/sequence_cursor.zig");
const block = @import("../../runtime/block_cursor.zig");
const native = @import("../store.zig");
const generic = @import("../scraper/generic.zig");
const A = std.mem.Allocator;
const observation = @import("../../runtime/indexing_observer.zig");
const fetch_backoff = @import("fetch_backoff.zig");
const bootstrap = @import("cursor_bootstrap.zig");
const critical_metrics = @import("../../ops/critical_metrics.zig");
const tick_clock = @import("../validator/tick_clock.zig");
const initialization = @import("../../ops/init_metrics.zig");
pub const Options = struct { transaction_notifications: bool = false, cursor_bootstrap: bool = false, source_fetch_backoff: bool = false, domain: u32, contracts: src.Contracts, chunk: u32, lowest: i64, interval_ms: u64 = 5000, configured_interval_ms: ?u64 = null, gas_enabled: bool = true, enabled_streams: [3]bool = .{ true, true, true }, cooperative_max_range: u32 = 32, max_frame_events: usize = 100000, max_frame_bytes: usize = 128 * 1024 * 1024 };
pub const Report = struct { ranges: usize = 0, messages: usize = 0, insertions: usize = 0, payments: usize = 0, prover_leaves: usize = 0, next_delay_ms: u64 = 0 };
fn sourceIndex(stream: native.Stream) usize {
    return switch (stream) {
        .dispatch => 0,
        .delivery => 1,
        .gas => 2,
        .insertion => 3,
    };
}
fn eventStream(event: src.Event) native.Stream {
    return switch (event.data) {
        .dispatch => .dispatch,
        .delivery => .delivery,
        .gas => .gas,
        .insertion => .insertion,
    };
}
fn index(event: src.Event) !u32 {
    return switch (event.data) {
        .dispatch => |message| message.nonce,
        .insertion => |insert| insert.index,
        .gas, .delivery => event.sequence orelse error.UnsequencedStream,
    };
}
fn cancelled(flag: ?*const std.atomic.Value(bool)) !void {
    if (flag) |value| if (value.load(.acquire)) return error.RequestCancelled;
}
fn ProgressAdapter(comptime Store: type) type {
    return struct {
        store: *Store,
        stream: native.Stream,
        fn interface(self: *@This()) sequence.Progress {
            return .{ .context = self, .block_fn = readBlock, .progress_fn = readProgress, .save_fn = save, .delete_fn = delete };
        }
        fn cast(context: *anyopaque) *@This() {
            return @ptrCast(@alignCast(context));
        }
        fn readBlock(context: *anyopaque, value: u32) !?u32 {
            const self = cast(context);
            const height = (try self.store.logBlock(self.stream, value)) orelse return null;
            return std.math.cast(u32, height) orelse error.IndexHeightOutOfRange;
        }
        fn readProgress(context: *anyopaque, value: u32) !?u32 {
            const self = cast(context);
            const point = (try self.store.backwardProgress(self.stream, value)) orelse return null;
            if (point.sequence != value) return error.InvalidBackwardProgress;
            return point.block;
        }
        fn save(context: *anyopaque, point: sequence.Point) !void {
            const self = cast(context);
            try self.store.saveBackwardProgress(self.stream, .{ .sequence = point.sequence, .block = point.block });
        }
        fn delete(context: *anyopaque, value: u32) !void {
            const self = cast(context);
            try self.store.deleteBackwardProgress(self.stream, value);
        }
    };
}
pub fn Core(comptime Store: type) type {
    return struct {
        const Work = struct {
            selected: usize,
            now_ms: u64,
            stage: enum { begin, tip, plan, fetch, persist, gas_refresh } = .begin,
            tip: src.Tip = .{ .count = null, .tip = 0 },
            query: ?sequence.Query = null,
            range: ?sequence.Range = null,
            batch: ?src.Batch = null,
            unsequenced: bool = false,
            report: Report = .{},
            persisted: usize = 0,
        };
        const FetchFrame = struct {
            arena: std.heap.ArenaAllocator,
            section: src.ReadSection,
            stream: native.Stream,
            range: sequence.Range,
            tip: u32,
            next: u32,
            before: ?src.Header = null,
            phase: enum { before, blocks, after } = .before,
            events: std.ArrayList(src.Event) = .empty,
            seen: std.AutoHashMapUnmanaged(u32, src.Hash) = .empty,
            bytes: usize = 0,
            through: u64 = 0,
            fn deinit(frame: *FetchFrame, allocator: A) void {
                if (frame.section.reservation) |lease| lease.release_fn(lease.context, frame.bytes);
                frame.arena.deinit();
                allocator.destroy(frame);
            }
        };
        allocator: A,
        source: src.Source,
        store: *Store,
        options: Options,
        cursors: [3]?sequence.Cursor = .{ null, null, null },
        gas_block: ?block.Cursor = null,
        progress: [3]ProgressAdapter(Store) = undefined,
        prepared: bool = false,
        next_stream: usize = 0,
        due: [3]u64 = @splat(0),
        observer: ?observation.Observer = null,
        initialization_observer: ?initialization.Observer = null,
        fetch_retries: [3]fetch_backoff.State = @splat(.{}),
        critical: ?*critical_metrics.Tracker = null,
        bootstrap: [3]bootstrap.State = @splat(.{}),
        bootstrap_selected: ?usize = null,
        cycle_clock: tick_clock.Clock = .{},
        current: ?Work = null,
        frame: ?*FetchFrame = null,
        pub fn deinit(self: *@This()) void {
            self.abortWork();
            for (&self.cursors) |*cursor| if (cursor.*) |*value| value.deinit();
        }
        fn enabled(self: *@This(), index_: usize) bool {
            return self.options.enabled_streams[index_] and (index_ != 2 or self.options.gas_enabled);
        }
        pub fn hasEnabledStreams(self: *@This()) bool {
            return self.enabled(0) or self.enabled(1) or self.enabled(2);
        }
        /// Owner-thread only. Transport cancellation/journal reset belongs to
        /// the caller after an aborted frame has released its owned quota.
        pub fn setStreamMask(self: *@This(), mask: [3]bool) bool {
            const old = [_]bool{ self.enabled(0), self.enabled(1), self.enabled(2) };
            self.options.enabled_streams = mask;
            if (self.options.cursor_bootstrap and !mask[0] and !mask[1]) {
                self.bootstrap[0].handoff();
                self.bootstrap[1].handoff();
                if (self.critical) |tracker| tracker.clearDirectRpc();
            }
            for (old, 0..) |was_enabled, i| if (!was_enabled and self.enabled(i)) {
                self.due[i] = 0;
            };
            if (self.current) |work| if (!self.enabled(work.selected)) {
                self.abortWork();
                return true;
            };
            return false;
        }
        fn nextDelay(self: *@This(), now_ms: u64) u64 {
            var ready: u64 = std.math.maxInt(u64);
            for (self.due, 0..) |value, index_| if (self.enabled(index_)) {
                ready = @min(ready, value);
            };
            return ready -| now_ms;
        }
        fn prepare(self: *@This()) !void {
            if (self.options.chunk > 65535 or self.options.interval_ms == 0 or self.options.cooperative_max_range == 0 or self.options.max_frame_events == 0 or self.options.max_frame_bytes == 0) return error.InvalidOriginIndexOptions;
            if (!self.enabled(0) and !self.enabled(1) and !self.enabled(2)) return error.NoOriginStreams;
            if (!self.prepared) {
                const streams = [_]native.Stream{ .dispatch, .insertion, .gas };
                const entities = [_]initialization.Entity{ .message_sync, .merkle_tree_hook_sync, .interchain_gas_payment_sync };
                for (&self.progress, streams, entities) |*progress, stream, entity| {
                    var timer = std.time.Timer.start() catch null;
                    progress.* = .{ .store = self.store, .stream = stream };
                    if (stream != .gas or self.options.gas_enabled) if (self.initialization_observer) |sink| if (timer) |*clock| sink.completed(entity, clock.read());
                }
                self.prepared = true;
            }
        }
        pub fn tick(self: *@This(), now_ms: u64, cancel: ?*const std.atomic.Value(bool)) !Report {
            if (self.options.cursor_bootstrap) {
                try cancelled(cancel);
                try self.cycle_clock.begin(now_ms);
            }
            defer if (self.options.cursor_bootstrap) self.cycle_clock.end();
            self.bootstrap_selected = null;
            if (self.options.cursor_bootstrap) for (&self.bootstrap, 0..) |*state, i| {
                if (self.enabled(i)) state.poll(now_ms, self.critical, i);
            };
            const result = if (self.source.read_section == null and !self.options.transaction_notifications) self.tickLegacy(now_ms, cancel) else self.tickCooperative(now_ms, cancel);
            return result catch |err| {
                const selected = self.bootstrap_selected;
                if (err == error.TxIdQueueFull) return .{ .next_delay_ms = 10 };
                if (err != error.PendingReadIo) self.abortWork();
                if (self.options.cursor_bootstrap) if (selected) |i| {
                    const completed_ms = self.cycle_clock.now(now_ms);
                    if (self.bootstrap[i].failed(err, completed_ms)) {
                        std.log.warn("origin {s} cursor startup failed ({d}/10); retry in 2000ms: {s}", .{ @tagName(bootstrap.reasons[i]), self.bootstrap[i].failures, @errorName(err) });
                        self.due[i] = self.bootstrap[i].retry_at_ms;
                        return self.finishReport(.{}, completed_ms);
                    }
                };
                return err;
            };
        }
        fn bootstrapped(self: *@This(), selected: usize) void {
            if (self.options.cursor_bootstrap) self.bootstrap[selected].succeeded(self.critical, selected);
        }
        fn observe(self: *@This(), selected: usize, count: ?u32, now_ms: u64) void {
            observation.completed(self.observer, ([_]native.Stream{ .dispatch, .insertion, .gas })[selected], if (self.cursors[selected]) |*value| value else null, if (self.gas_block) |*value| value else null, count, now_ms);
        }
        fn admitFetch(self: *@This(), selected: usize, range: sequence.Range, now_ms: u64) bool {
            if (!self.options.source_fetch_backoff) return true;
            if (self.fetch_retries[selected].remainingDelay(range, now_ms)) |remaining| {
                self.due[selected] = now_ms +| @min(remaining, 5000);
                return false;
            }
            if (self.fetch_retries[selected].retryEligible(range, now_ms)) if (self.observer) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected], .delay_ms = 0 } });
            return true;
        }
        fn fetched(self: *@This(), selected: usize, range: sequence.Range) void {
            if (!self.options.source_fetch_backoff) return;
            if (self.fetch_retries[selected].recordSuccess(range)) if (self.observer) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected], .delay_ms = 0 } });
        }
        fn failedFetch(self: *@This(), selected: usize, range: sequence.Range, now_ms: u64, err: anyerror) !Report {
            if (!self.options.source_fetch_backoff or !observation.retryable(err)) return err;
            const delay = self.fetch_retries[selected].recordFailure(range, now_ms);
            self.due[selected] = now_ms +| @min(delay, 5000);
            const stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected];
            if (self.observer) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = stream, .delay_ms = delay, .retry = true } });
            std.log.warn("origin {s} range fetch failed; retry in {d}ms: {s}", .{ @tagName(stream), delay, @errorName(err) });
            return self.finishReport(.{}, now_ms);
        }
        fn tickLegacy(self: *@This(), now_ms: u64, cancel: ?*const std.atomic.Value(bool)) !Report {
            try self.prepare();
            self.source.bindCancellation(cancel);
            defer self.source.bindCancellation(null);
            try cancelled(cancel);
            var report: Report = .{};
            const selected = for (0..3) |_| {
                const candidate = self.next_stream;
                self.next_stream = (candidate + 1) % 3;
                if (self.enabled(candidate) and self.due[candidate] <= now_ms) break candidate;
            } else {
                report.next_delay_ms = self.nextDelay(now_ms);
                return report;
            };
            self.bootstrap_selected = selected;
            self.due[selected] = now_ms +| self.options.interval_ms;
            try self.source.beginCycle();
            const stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[selected];
            const tip = try self.source.streamTip(sourceIndex(stream));
            const height = std.math.cast(u32, tip.tip) orelse return error.IndexHeightOutOfRange;
            if (stream == .gas and tip.count == null) {
                if (self.source.sequence_mode) return error.MissingOriginGasSequenceCount;
                if (self.gas_block) |*cursor| if (cursor.rateLimit(now_ms)) |ready| {
                    self.due[selected] = ready;
                    self.observe(selected, tip.count, now_ms);
                    return self.finishReport(report, now_ms);
                };
                if (self.gas_block == null) self.gas_block = try block.Cursor.init(height, try self.store.gasWatermark(), now_ms, .{ .chunk = self.options.chunk, .lowest = self.options.lowest, .idle_ms = self.options.interval_ms, .configured_interval_ms = self.options.configured_interval_ms });
                const cursor = &self.gas_block.?;
                const action = try cursor.plan(height, now_ms);
                self.bootstrapped(selected);
                self.due[selected] = switch (action) {
                    .sleep_until_ms => |ready| ready,
                    .query => now_ms,
                };
                if (action == .query) {
                    errdefer cursor.failed();
                    if (!self.admitFetch(selected, action.query, now_ms)) {
                        cursor.failed();
                        self.observe(selected, tip.count, now_ms);
                        return self.finishReport(report, now_ms);
                    }
                    var batch = self.fetch(stream, action.query, height, cancel) catch |err| {
                        cursor.failed();
                        return self.failedFetch(selected, action.query, now_ms, err);
                    };
                    self.fetched(selected, action.query);
                    defer batch.deinit();
                    const points = try self.persist(stream, batch.events, false, cancel);
                    defer self.allocator.free(points);
                    try self.store.storeGasWatermark(cursor.watermark());
                    const refreshed = try self.source.streamTip(2);
                    try cursor.update(std.math.cast(u32, refreshed.tip) orelse return error.IndexHeightOutOfRange, now_ms);
                    report.ranges = 1;
                    report.payments = batch.events.len;
                }
            } else {
                const latest = tip.count orelse return error.MissingOriginSequenceCount;
                if (self.cursors[selected] == null) self.cursors[selected] = try sequence.Cursor.init(self.allocator, latest, height, .{ .chunk = self.options.chunk, .lowest = self.options.lowest, .mode = if (self.source.sequence_mode) .sequence else .block, .idle_ms = self.options.interval_ms });
                const cursor = &self.cursors[selected].?;
                const action = try cursor.plan(latest, height, now_ms, self.progress[selected].interface());
                self.bootstrapped(selected);
                self.due[selected] = switch (action) {
                    .sleep_until_ms => |ready| ready,
                    else => now_ms,
                };
                if (action == .query) {
                    errdefer cursor.failed(action.query.token) catch {};
                    if (!self.admitFetch(selected, action.query.range, now_ms)) {
                        try cursor.failed(action.query.token);
                        self.observe(selected, tip.count, now_ms);
                        return self.finishReport(report, now_ms);
                    }
                    var batch = self.fetch(stream, action.query.range, height, cancel) catch |err| {
                        cursor.failed(action.query.token) catch {};
                        return self.failedFetch(selected, action.query.range, now_ms, err);
                    };
                    self.fetched(selected, action.query.range);
                    defer batch.deinit();
                    const points = try self.persist(stream, batch.events, stream == .gas, cancel);
                    defer self.allocator.free(points);
                    try cursor.update(action.query.token, points, now_ms, self.progress[selected].interface());
                    report.ranges = 1;
                    switch (stream) {
                        .dispatch => report.messages = points.len,
                        .insertion => report.insertions = points.len,
                        .gas => report.payments = points.len,
                        .delivery => unreachable,
                    }
                }
            }
            self.observe(selected, tip.count, now_ms);
            return self.finishReport(report, now_ms);
        }
        fn abortWork(self: *@This()) void {
            if (self.frame) |frame| {
                frame.deinit(self.allocator);
                self.frame = null;
            }
            if (self.current) |*work| {
                if (work.batch) |*batch| batch.deinit();
                if (work.query) |query| if (self.cursors[work.selected]) |*cursor| cursor.failed(query.token) catch {};
                if (work.unsequenced) if (self.gas_block) |*cursor| cursor.failed();
            }
            self.current = null;
        }
        fn completeWork(self: *@This(), now_ms: u64) Report {
            const work = &self.current.?;
            self.observe(work.selected, work.tip.count, now_ms);
            const result = self.finishReport(work.report, now_ms);
            if (work.batch) |*batch| batch.deinit();
            self.current = null;
            return result;
        }
        fn tickCooperative(self: *@This(), now_ms: u64, cancel: ?*const std.atomic.Value(bool)) !Report {
            try self.prepare();
            self.source.bindCancellation(cancel);
            defer self.source.bindCancellation(null);
            try cancelled(cancel);
            if (self.current == null) {
                const selected = for (0..3) |_| {
                    const candidate = self.next_stream;
                    self.next_stream = (candidate + 1) % 3;
                    if (self.enabled(candidate) and self.due[candidate] <= now_ms) break candidate;
                } else return .{ .next_delay_ms = self.nextDelay(now_ms) };
                self.due[selected] = now_ms +| self.options.interval_ms;
                self.current = .{ .selected = selected, .now_ms = now_ms };
            }
            const work = &self.current.?;
            self.bootstrap_selected = work.selected;
            const stream = ([_]native.Stream{ .dispatch, .insertion, .gas })[work.selected];
            while (true) {
                try cancelled(cancel);
                switch (work.stage) {
                    .begin => {
                        try self.source.beginCycle();
                        work.stage = .tip;
                        try self.source.commitReadSection();
                    },
                    .tip => {
                        work.tip = try self.source.streamTip(sourceIndex(stream));
                        _ = std.math.cast(u32, work.tip.tip) orelse return error.IndexHeightOutOfRange;
                        work.stage = .plan;
                        try self.source.commitReadSection();
                    },
                    .plan => {
                        const height: u32 = @intCast(work.tip.tip);
                        work.unsequenced = stream == .gas and work.tip.count == null;
                        if (work.unsequenced) {
                            if (self.source.sequence_mode) return error.MissingOriginGasSequenceCount;
                            if (self.gas_block) |*cursor| if (cursor.rateLimit(now_ms)) |ready| {
                                self.due[work.selected] = ready;
                                return self.completeWork(now_ms);
                            };
                            if (self.gas_block == null) self.gas_block = try block.Cursor.init(height, try self.store.gasWatermark(), now_ms, .{ .chunk = self.options.chunk, .lowest = self.options.lowest, .idle_ms = self.options.interval_ms, .configured_interval_ms = self.options.configured_interval_ms });
                            const action = try self.gas_block.?.plan(height, now_ms);
                            self.bootstrapped(work.selected);
                            self.due[work.selected] = switch (action) {
                                .sleep_until_ms => |ready| ready,
                                .query => work.now_ms,
                            };
                            if (action != .query) return self.completeWork(now_ms);
                            work.range = try self.gas_block.?.limitQuery(self.options.cooperative_max_range);
                        } else {
                            const latest = work.tip.count orelse return error.MissingOriginSequenceCount;
                            if (self.cursors[work.selected] == null) self.cursors[work.selected] = try sequence.Cursor.init(self.allocator, latest, height, .{ .chunk = self.options.chunk, .lowest = self.options.lowest, .mode = if (self.source.sequence_mode) .sequence else .block, .idle_ms = self.options.interval_ms });
                            const action = try self.cursors[work.selected].?.plan(latest, height, now_ms, self.progress[work.selected].interface());
                            self.bootstrapped(work.selected);
                            self.due[work.selected] = switch (action) {
                                .sleep_until_ms => |ready| ready,
                                else => work.now_ms,
                            };
                            if (action != .query) return self.completeWork(now_ms);
                            work.query = try self.cursors[work.selected].?.limitQuery(action.query.token, self.options.cooperative_max_range);
                            work.range = work.query.?.range;
                        }
                        if (!self.admitFetch(work.selected, work.range.?, now_ms)) {
                            if (work.query) |query| try self.cursors[work.selected].?.failed(query.token);
                            work.query = null;
                            if (work.unsequenced) self.gas_block.?.failed();
                            return self.completeWork(now_ms);
                        }
                        work.stage = .fetch;
                    },
                    .fetch => {
                        work.batch = (if (self.source.read_section != null) self.fetchFramed(stream, work.range.?, @intCast(work.tip.tip), cancel) else self.fetch(stream, work.range.?, @intCast(work.tip.tip), cancel)) catch |err| {
                            if (!self.options.source_fetch_backoff or !observation.retryable(err)) return err;
                            const selected = work.selected;
                            const range = work.range.?;
                            self.abortWork();
                            return self.failedFetch(selected, range, now_ms, err);
                        };
                        self.fetched(work.selected, work.range.?);
                        work.stage = .persist;
                        try self.source.commitReadSection();
                    },
                    .persist => {
                        const points = try self.persistFrom(stream, work.batch.?.events, !work.unsequenced and stream == .gas, cancel, &work.persisted);
                        defer self.allocator.free(points);
                        work.report.ranges = 1;
                        switch (stream) {
                            .dispatch => work.report.messages = points.len,
                            .insertion => work.report.insertions = points.len,
                            .gas => work.report.payments = if (work.unsequenced) work.batch.?.events.len else points.len,
                            .delivery => unreachable,
                        }
                        if (work.unsequenced) {
                            try self.store.storeGasWatermark(self.gas_block.?.watermark());
                            // Durable storage is complete. A suspended tip refresh
                            // resumes here and never reexecutes prior source reads.
                            work.stage = .gas_refresh;
                            try self.source.commitReadSection();
                        } else {
                            try self.cursors[work.selected].?.update(work.query.?.token, points, now_ms, self.progress[work.selected].interface());
                            work.query = null;
                            try self.source.commitReadSection();
                            return self.completeWork(now_ms);
                        }
                    },
                    .gas_refresh => {
                        const refreshed = try self.source.streamTip(2);
                        try self.gas_block.?.update(std.math.cast(u32, refreshed.tip) orelse return error.IndexHeightOutOfRange, now_ms);
                        work.unsequenced = false;
                        try self.source.commitReadSection();
                        return self.completeWork(now_ms);
                    },
                }
            }
        }
        fn fetchFramed(self: *@This(), stream: native.Stream, range: sequence.Range, tip: u32, cancel: ?*const std.atomic.Value(bool)) !src.Batch {
            if (range.from > range.to or (!self.source.sequence_mode and range.to > tip)) return error.RangeBeyondFinality;
            if (self.frame == null) {
                const frame = try self.allocator.create(FetchFrame);
                frame.* = .{ .arena = std.heap.ArenaAllocator.init(self.allocator), .section = self.source.read_section.?, .stream = stream, .range = range, .tip = tip, .next = range.from };
                self.frame = frame;
            }
            const frame = self.frame.?;
            if (frame.stream != stream or !std.meta.eql(frame.range, range) or frame.tip != tip) return error.ConcurrentOriginReadSection;
            while (true) {
                try cancelled(cancel);
                switch (frame.phase) {
                    .before => {
                        frame.before = try self.source.freshHeader(.{ .height = if (self.source.sequence_mode or range.to == 0) tip else range.to });
                        frame.phase = .blocks;
                        try self.source.commitReadSection();
                    },
                    .blocks => {
                        var batch = try self.fetch(stream, .{ .from = frame.next, .to = frame.next }, tip, cancel);
                        defer batch.deinit();
                        const a = frame.arena.allocator();
                        for (batch.events) |event| {
                            if (self.source.sequence_mode or stream != .gas or event.sequence != null) {
                                const entry = try frame.seen.getOrPut(a, try index(event));
                                const fingerprint = generic.fingerprint(event);
                                if (entry.found_existing) {
                                    if (!std.mem.eql(u8, entry.value_ptr, &fingerprint)) return error.ConflictingOriginSequence;
                                    continue;
                                }
                                entry.value_ptr.* = fingerprint;
                            }
                            if (frame.events.items.len >= self.options.max_frame_events) return error.OriginFrameEventLimit;
                            const body = if (event.data == .dispatch) event.data.dispatch.body else "";
                            const bytes = try std.math.add(usize, 3 * @sizeOf(src.Event) + 256, try std.math.mul(usize, body.len, 2));
                            if (bytes > self.options.max_frame_bytes -| frame.bytes) return error.OriginFrameByteLimit;
                            if (frame.section.reservation) |lease| try lease.reserve_fn(lease.context, bytes);
                            var charged = true;
                            errdefer if (charged) {
                                if (frame.section.reservation) |lease| lease.release_fn(lease.context, bytes);
                            };
                            var copied = event;
                            if (copied.data == .dispatch) copied.data.dispatch.body = try a.dupe(u8, body);
                            try frame.events.append(a, copied);
                            frame.bytes += bytes;
                            charged = false;
                        }
                        frame.through = @max(frame.through, batch.through);
                        if (frame.next == range.to) frame.phase = .after else frame.next += 1;
                        // Only this completed block/sequence leaves the journal.
                        // Prior native decoders never rerun when the next yields.
                        try self.source.commitReadSection();
                    },
                    .after => {
                        const after = try self.source.freshHeader(.{ .height = frame.before.?.height });
                        if (!std.mem.eql(u8, &after.hash, &frame.before.?.hash)) return error.OriginIndexingReorg;
                        std.mem.sort(src.Event, frame.events.items, {}, struct {
                            fn less(_: void, x: src.Event, y: src.Event) bool {
                                if (x.block_number != y.block_number) return x.block_number < y.block_number;
                                if (x.tx_index != y.tx_index) return x.tx_index < y.tx_index;
                                return x.log_index < y.log_index;
                            }
                        }.less);
                        const result: src.Batch = .{ .arena = frame.arena, .events = frame.events.items, .through = if (self.source.sequence_mode) frame.through else range.to, .reservation = if (frame.section.reservation) |lease| .{ .owner = lease, .bytes = frame.bytes } else null };
                        self.frame = null;
                        self.allocator.destroy(frame); // arena/quota ownership moved
                        return result;
                    },
                }
            }
        }
        fn finishReport(self: *@This(), report: Report, now_ms: u64) Report {
            var value = report;
            value.next_delay_ms = self.nextDelay(now_ms);
            return value;
        }
        /// Full-history validator audit uses the same owner/address/hash/finality
        /// fence as ordinary ingestion, independently of existing DB skip markers.
        pub fn fetchInsertionRange(self: *@This(), range: sequence.Range, tip: u32, cancel: ?*const std.atomic.Value(bool)) !src.Batch {
            if (self.source.read_section != null) return self.fetchFramed(.insertion, range, tip, cancel) catch |err| {
                if (err != error.PendingReadIo) if (self.frame) |frame| {
                    frame.deinit(self.allocator);
                    self.frame = null;
                };
                return err;
            };
            return self.fetch(.insertion, range, tip, cancel);
        }

        fn fetch(self: *@This(), stream: native.Stream, range: sequence.Range, tip: u32, cancel: ?*const std.atomic.Value(bool)) !src.Batch {
            if (range.from > range.to or (!self.source.sequence_mode and range.to > tip)) return error.RangeBeyondFinality;
            try cancelled(cancel);
            // Sequence PDA metadata may refer to pruned historical slots; its
            // authenticated immutable account remains authoritative. Fence the live
            // finalized tip, and validate every available nonzero event block hash.
            const fence_height: u64 = if (self.source.sequence_mode or range.to == 0) tip else range.to;
            const fence = try self.source.freshHeader(.{ .height = fence_height });
            var batch = if (self.source.sequence_mode) try self.source.rawSequence(self.allocator, sourceIndex(stream), range.from, range.to) else try self.source.events(self.allocator, range.from, range.to, .{0} ** 4);
            errdefer batch.deinit();
            if (!self.source.sequence_mode and batch.through != range.to) return error.IncompleteOriginBlockRange;
            var kept: usize = 0;
            for (batch.events) |event| if (eventStream(event) == stream) {
                batch.events[kept] = event;
                kept += 1;
            };
            batch.events = batch.events[0..kept];
            std.mem.sort(src.Event, batch.events, {}, struct {
                fn less(_: void, x: src.Event, y: src.Event) bool {
                    if (x.block_number != y.block_number) return x.block_number < y.block_number;
                    if (x.tx_index != y.tx_index) return x.tx_index < y.tx_index;
                    return x.log_index < y.log_index;
                }
            }.less);
            var seen = std.AutoHashMap(u32, src.Hash).init(self.allocator);
            defer seen.deinit();
            var last: ?src.Header = null;
            const emitters = (try self.source.transactionAuthority(self.options.contracts)).emitters;
            kept = 0;
            for (batch.events) |event| {
                try cancelled(cancel);
                if (event.block_number > tip or (!self.source.sequence_mode and (event.block_number < range.from or event.block_number > range.to))) return error.OriginEventOutsideRange;
                const expected = switch (stream) {
                    .dispatch, .delivery => emitters.mailbox,
                    .insertion => emitters.hook,
                    .gas => emitters.paymaster,
                };
                if (!std.mem.eql(u8, &event.address, &expected)) return error.WrongOriginEventEmitter;
                if (event.data == .dispatch and event.data.dispatch.origin != self.options.domain) return error.WrongMessageOrigin;
                if (self.source.sequence_mode or stream != .gas or event.sequence != null) {
                    const value = try index(event);
                    if (self.source.sequence_mode and (value < range.from or value > range.to)) return error.OriginSequenceOutsideRange;
                    const entry = try seen.getOrPut(value);
                    const fingerprint = generic.fingerprint(event);
                    if (entry.found_existing) {
                        if (!std.mem.eql(u8, entry.value_ptr, &fingerprint)) return error.ConflictingOriginSequence;
                        continue;
                    }
                    entry.value_ptr.* = fingerprint;
                }
                if (!std.mem.allEqual(u8, &event.block_hash, 0)) {
                    if (last == null or last.?.height != event.block_number) last = try self.source.header(.{ .height = event.block_number });
                    if (!std.mem.eql(u8, &last.?.hash, &event.block_hash)) return error.OriginLogForkMismatch;
                } else if (!self.source.sequence_mode) return error.MissingOriginBlockHash;
                batch.events[kept] = event;
                kept += 1;
            }
            batch.events = batch.events[0..kept];
            try cancelled(cancel);
            const after = try self.source.freshHeader(.{ .height = fence.height });
            if (!std.mem.eql(u8, &after.hash, &fence.hash)) return error.OriginIndexingReorg;
            return batch;
        }
        fn persist(self: *@This(), stream: native.Stream, events: []const src.Event, indexed_gas: bool, cancel: ?*const std.atomic.Value(bool)) ![]sequence.Log {
            var offset: usize = 0;
            return self.persistFrom(stream, events, indexed_gas, cancel, &offset);
        }
        fn persistFrom(self: *@This(), stream: native.Stream, events: []const src.Event, indexed_gas: bool, cancel: ?*const std.atomic.Value(bool), offset: *usize) ![]sequence.Log {
            var points: std.ArrayList(sequence.Log) = .empty;
            errdefer points.deinit(self.allocator);
            try points.ensureTotalCapacity(self.allocator, events.len);
            for (events, 0..) |event, position| {
                try cancelled(cancel);
                const write = position >= offset.*;
                switch (stream) {
                    .dispatch => {
                        if (write) if (try self.store.storeMessage(event.data.dispatch, event.block_number, event.tx_hash)) if (self.observer) |sink| sink.notify(.{ .stored = .{ .stream = stream } });
                        points.appendAssumeCapacity(.{ .sequence = event.data.dispatch.nonce, .block = std.math.cast(u32, event.block_number) orelse return error.IndexHeightOutOfRange });
                    },
                    .insertion => {
                        const value = event.data.insertion;
                        if (write) if (try self.store.storeInsertion(.{ .leaf_index = value.index, .message_id = value.message_id }, event.block_number)) if (self.observer) |sink| sink.notify(.{ .stored = .{ .stream = stream } });
                        points.appendAssumeCapacity(.{ .sequence = value.index, .block = std.math.cast(u32, event.block_number) orelse return error.IndexHeightOutOfRange });
                    },
                    .gas => {
                        const value = event.data.gas;
                        const payment = @import("../../db/codec.zig").GasPayment{ .message_id = value.message_id, .destination = value.destination, .payment = value.payment, .gas_amount = value.gas };
                        const identity = @import("../../db/codec.zig").GasPaymentMeta{ .transaction_id = event.tx_hash orelse .{0} ** 64, .log_index = event.log_index };
                        if (indexed_gas) {
                            const value_index = event.sequence orelse return error.UnsequencedStream;
                            if (write) if (try self.store.storeIndexedPayment(payment, identity, value_index, event.block_number)) if (self.observer) |sink| sink.notify(.{ .stored = .{ .stream = stream } });
                            points.appendAssumeCapacity(.{ .sequence = value_index, .block = std.math.cast(u32, event.block_number) orelse return error.IndexHeightOutOfRange });
                        } else {
                            if (write) if (try self.store.storePayment(payment, identity)) if (self.observer) |sink| sink.notify(.{ .stored = .{ .stream = stream } });
                        }
                    },
                    .delivery => return error.UnsequencedStream,
                }
                offset.* = @max(offset.*, position + 1);
            }
            return points.toOwnedSlice(self.allocator);
        }
    };
}
