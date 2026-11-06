//! Sequence-aware forward/backfill scheduling from the Rust contract cursors.
//! Cursor position is never proof of a complete stream: counts and contiguous
//! sequences detect omitted logs. Persistence stores per-gap backward positions.
const std = @import("std");
const Allocator = std.mem.Allocator;
pub const Mode = enum { block, sequence };
pub const Direction = enum { forward, backward };
pub const Point = struct { sequence: u32, block: u32 };
pub const Log = Point;
pub const Range = struct { from: u32, to: u32 };
pub const Query = struct { token: u64, direction: Direction, range: Range };
pub const Action = union(enum) { query: Query, sleep_until_ms: u64, yield };
pub const Progress = struct {
    context: *anyopaque,
    block_fn: *const fn (*anyopaque, u32) anyerror!?u32,
    progress_fn: *const fn (*anyopaque, u32) anyerror!?u32,
    save_fn: *const fn (*anyopaque, Point) anyerror!void,
    delete_fn: *const fn (*anyopaque, u32) anyerror!void,
};
pub const Options = struct { chunk: u32 = 1999, lowest: i64 = 0, mode: Mode = .block, idle_ms: u64 = 5000, skip_budget: usize = 64 };
const Snapshot = struct {
    sequence: ?u32,
    block: u32,
    fn next(self: Snapshot) Point {
        return .{ .sequence = if (self.sequence) |value| value +| 1 else 0, .block = self.block };
    }
    fn previous(self: Snapshot) ?Point {
        const value = self.sequence orelse return null;
        if (value == 0) return null;
        return .{ .sequence = value - 1, .block = self.block };
    }
};

pub const Cursor = struct {
    allocator: Allocator,
    options: Options,
    forward: Point,
    forward_last: Snapshot,
    target: ?Point = null,
    backward: ?Point,
    backward_last: Snapshot,
    pending: ?Query = null,
    token: u64 = 0,
    gap_target: ?u32 = null,
    missing: std.ArrayList(u32) = .empty,
    gap_retries: u32 = 0,
    gap_retry_at: u64 = 0,

    pub fn init(allocator: Allocator, count: u32, tip: u32, options: Options) !Cursor {
        if (options.chunk > 65535 or options.skip_budget == 0 or options.idle_ms == 0) return error.InvalidCursorOptions;
        const forward_last: Snapshot = .{ .sequence = if (count > 0) count - 1 else null, .block = tip };
        const backward_last: Snapshot = .{ .sequence = if (count > 0) count else null, .block = tip };
        return .{ .allocator = allocator, .options = options, .forward = .{ .sequence = count, .block = tip }, .forward_last = forward_last, .backward_last = backward_last, .backward = backward_last.previous() };
    }

    pub fn deinit(self: *Cursor) void {
        self.missing.deinit(self.allocator);
        self.* = undefined;
    }

    fn clearGap(self: *Cursor) void {
        self.gap_target = null;
        self.missing.clearRetainingCapacity();
        self.gap_retries = 0;
        self.gap_retry_at = 0;
    }

    fn query(self: *Cursor, direction: Direction, range: Range) !Action {
        self.token = try std.math.add(u64, self.token, 1);
        const value: Query = .{ .token = self.token, .direction = direction, .range = range };
        self.pending = value;
        return .{ .query = value };
    }

    /// Bound a retained cooperative job without skipping unread positions.
    /// Forward retains its prefix; backward retains its suffix. Both the caller
    /// and update() observe the same token/range. Configured chunk stays a max.
    pub fn limitQuery(self: *Cursor, token: u64, max_steps: u32) !Query {
        if (max_steps == 0) return error.InvalidCursorQueryLimit;
        const active = if (self.pending) |*value| value else return error.NoCursorQuery;
        if (active.token != token) return error.StaleCursorQuery;
        const extent = max_steps - 1;
        switch (active.direction) {
            .forward => active.range.to = @min(active.range.to, active.range.from +| extent),
            .backward => active.range.from = @max(active.range.from, active.range.to -| extent),
        }
        return active.*;
    }

    fn lowest(self: Cursor, count: ?u32, tip: u32) ?u32 {
        if (self.options.lowest >= 0) return std.math.cast(u32, self.options.lowest);
        const base = switch (self.options.mode) {
            .block => tip,
            .sequence => count orelse return null,
        };
        return @intCast(@max(0, @as(i64, base) +| self.options.lowest));
    }

    /// Native storage calls run on a bounded I/O worker, never while holding an
    /// owner queue mutex. Known entries are skipped in bounded slices.
    pub fn plan(self: *Cursor, count: ?u32, tip: u32, now_ms: u64, store: Progress) !Action {
        if (self.pending != null) return error.CursorQueryInFlight;
        var skipped: usize = 0;
        while (try store.block_fn(store.context, self.forward.sequence)) |block| {
            self.forward_last = .{ .sequence = self.forward.sequence, .block = block };
            self.forward = self.forward_last.next();
            if (self.forward.sequence == std.math.maxInt(u32)) break;
            skipped += 1;
            if (skipped >= self.options.skip_budget) return .yield;
        }
        if (count) |latest| {
            if (self.forward.sequence == latest) {
                self.forward.block = tip;
            } else if (self.forward.sequence < latest) {
                self.target = .{ .sequence = latest - 1, .block = tip };
                switch (self.options.mode) {
                    .block => if (self.forward.block <= tip) return self.query(.forward, .{ .from = self.forward.block, .to = @min(tip, self.forward.block +| self.options.chunk) }),
                    .sequence => return self.query(.forward, .{ .from = self.forward.sequence, .to = @min(latest - 1, self.forward.sequence +| self.options.chunk) }),
                }
            }
        }
        skipped = 0;
        while (self.backward) |current| {
            const block = (try store.block_fn(store.context, current.sequence)) orelse break;
            if (try store.progress_fn(store.context, current.sequence) != null) try store.delete_fn(store.context, current.sequence);
            self.backward_last = .{ .sequence = current.sequence, .block = block };
            self.backward = self.backward_last.previous();
            self.clearGap();
            skipped += 1;
            if (skipped >= self.options.skip_budget) return .yield;
        }
        if (self.backward) |*current| {
            if (self.options.mode == .block) if (try store.progress_fn(store.context, current.sequence)) |block| {
                current.block = @min(current.block, block);
            };
            if (now_ms < self.gap_retry_at) return .{ .sleep_until_ms = @min(self.gap_retry_at, now_ms +| self.options.idle_ms) };
            const minimum = self.lowest(count, tip) orelse return .{ .sleep_until_ms = now_ms +| self.options.idle_ms };
            const high = switch (self.options.mode) {
                .block => current.block,
                .sequence => current.sequence,
            };
            if (high >= minimum) return self.query(.backward, .{ .from = @max(minimum, high -| self.options.chunk), .to = high });
            if (self.options.mode == .block) try self.persist(store, true);
        }
        return .{ .sleep_until_ms = now_ms +| self.options.idle_ms };
    }

    pub fn failed(self: *Cursor, token: u64) !void {
        const active = self.pending orelse return error.NoCursorQuery;
        if (active.token != token) return error.StaleCursorQuery;
        self.pending = null;
    }

    fn persist(self: *Cursor, store: Progress, force: bool) !void {
        const current = self.backward orelse return;
        const previous = try store.progress_fn(store.context, current.sequence);
        if (previous == null or (current.block < previous.? and (force or previous.? - current.block >= 1000))) try store.save_fn(store.context, current);
    }

    fn scheduleGap(self: *Cursor, target: u32, range: Range, logs: []const Log, now_ms: u64) !void {
        var missing: std.ArrayList(u32) = .empty;
        defer missing.deinit(self.allocator);
        var sequence = range.from;
        var position: usize = 0;
        while (true) {
            while (position < logs.len and logs[position].sequence < sequence) position += 1;
            if (position == logs.len or logs[position].sequence != sequence) try missing.append(self.allocator, sequence);
            if (sequence == range.to) break;
            sequence += 1;
        }
        if (missing.items.len == 0) {
            sequence = range.from;
            while (true) {
                try missing.append(self.allocator, sequence);
                if (sequence == range.to) break;
                sequence += 1;
            }
        }
        var progressed = true;
        if (self.gap_target == target) {
            var retained: usize = 0;
            var next_missing: usize = 0;
            for (self.missing.items) |previous| {
                while (next_missing < missing.items.len and missing.items[next_missing] < previous) next_missing += 1;
                if (next_missing < missing.items.len and missing.items[next_missing] == previous) {
                    self.missing.items[retained] = previous;
                    retained += 1;
                }
            }
            progressed = retained < self.missing.items.len;
            self.missing.shrinkRetainingCapacity(retained);
        } else {
            try self.missing.ensureTotalCapacity(self.allocator, missing.items.len);
            self.missing.clearRetainingCapacity();
            self.missing.appendSliceAssumeCapacity(missing.items);
        }
        if (self.missing.items.len == 0) return self.clearGap();
        if (progressed) self.gap_retries = 0;
        self.gap_target = target;
        self.gap_retries +|= 1;
        const exponent: u6 = @intCast(@min(6, self.gap_retries - 1));
        const delay = @min(300000, @as(u64, 5000) << exponent);
        self.gap_retry_at = now_ms +| delay;
    }

    /// Logs have already been committed to storage before cursor advancement.
    /// Duplicates retain their first arrival exactly as Rust unique_by does.
    pub fn update(self: *Cursor, token: u64, input: []const Log, now_ms: u64, store: Progress) !void {
        const active = self.pending orelse return error.NoCursorQuery;
        if (active.token != token) return error.StaleCursorQuery;
        if (input.len > 100000) return error.CursorBatchTooLarge;
        var logs: std.ArrayList(Log) = .empty;
        defer logs.deinit(self.allocator);
        var seen: std.AutoHashMapUnmanaged(u32, void) = .empty;
        defer seen.deinit(self.allocator);
        const current = if (active.direction == .forward) self.forward else self.backward orelse return error.NoBackwardTarget;
        for (input) |log| {
            const result = try seen.getOrPut(self.allocator, log.sequence);
            if (result.found_existing) continue;
            if ((active.direction == .forward and log.sequence < current.sequence) or
                (active.direction == .backward and log.sequence > current.sequence)) continue;
            try logs.append(self.allocator, log);
        }
        std.mem.sort(Log, logs.items, {}, struct {
            fn less(_: void, a: Log, b: Log) bool {
                return a.sequence < b.sequence;
            }
        }.less);
        const amount = std.math.cast(u32, logs.items.len) orelse return error.CursorBatchTooLarge;
        const expected_start = switch (self.options.mode) {
            .sequence => active.range.from,
            .block => if (active.direction == .forward) current.sequence else (current.sequence +| 1) -| amount,
        };
        var valid = true;
        if (self.options.mode == .sequence) {
            valid = amount == @as(u64, active.range.to) - active.range.from + 1 and
                (if (active.direction == .forward) active.range.from == current.sequence else active.range.to == current.sequence);
        }
        for (logs.items, 0..) |log, offset| if (@as(u64, expected_start) + offset != log.sequence) {
            valid = false;
        };
        if (!valid) {
            if (active.direction == .forward) {
                self.forward = self.forward_last.next();
            } else {
                self.backward = self.backward_last.previous();
                if (self.options.mode == .sequence) {
                    try self.scheduleGap(current.sequence, active.range, logs.items, now_ms);
                } else if (self.backward) |rewound| try store.save_fn(store.context, rewound);
            }
            self.pending = null;
            return;
        }
        if (active.direction == .forward) {
            if (logs.items.len > 0) {
                const last = logs.items[logs.items.len - 1];
                self.forward_last = .{ .sequence = last.sequence, .block = last.block };
            }
            self.forward = if (self.options.mode == .sequence) self.forward_last.next() else .{ .sequence = current.sequence +| amount, .block = active.range.to };
            if (self.options.mode == .block) if (self.target) |target| {
                if ((self.forward_last.sequence == null or self.forward_last.sequence.? < target.sequence) and active.range.to >= target.block) self.forward = self.forward_last.next();
            };
        } else {
            if (logs.items.len > 0) {
                const first = logs.items[0];
                self.backward_last = .{ .sequence = first.sequence, .block = first.block };
            }
            self.backward = if (self.options.mode == .sequence) self.backward_last.previous() else if (amount > current.sequence) null else .{ .sequence = current.sequence - amount, .block = active.range.from -| 1 };
            if (self.options.mode == .sequence) self.clearGap() else if (logs.items.len == 0) try self.persist(store, false);
        }
        self.pending = null;
    }
};

const TestStore = struct {
    allocator: Allocator = std.testing.allocator,
    blocks: std.AutoHashMapUnmanaged(u32, u32) = .empty,
    progress: std.AutoHashMapUnmanaged(u32, u32) = .empty,
    fn deinit(self: *TestStore) void {
        self.blocks.deinit(self.allocator);
        self.progress.deinit(self.allocator);
    }
    fn interface(self: *TestStore) Progress {
        return .{ .context = self, .block_fn = block, .progress_fn = position, .save_fn = save, .delete_fn = delete };
    }
    fn block(context: *anyopaque, sequence: u32) !?u32 {
        const self: *TestStore = @ptrCast(@alignCast(context));
        return self.blocks.get(sequence);
    }
    fn position(context: *anyopaque, sequence: u32) !?u32 {
        const self: *TestStore = @ptrCast(@alignCast(context));
        return self.progress.get(sequence);
    }
    fn save(context: *anyopaque, point: Point) !void {
        const self: *TestStore = @ptrCast(@alignCast(context));
        try self.progress.put(self.allocator, point.sequence, point.block);
    }
    fn delete(context: *anyopaque, sequence: u32) !void {
        const self: *TestStore = @ptrCast(@alignCast(context));
        _ = self.progress.remove(sequence);
    }
};

test "sequence cursor prioritizes forward traffic detects missing logs and accepts duplicate overlap" {
    var store: TestStore = .{};
    defer store.deinit();
    var cursor = try Cursor.init(std.testing.allocator, 10, 100, .{ .chunk = 99 });
    defer cursor.deinit();
    const first = (try cursor.plan(12, 102, 0, store.interface())).query;
    try std.testing.expectEqual(.forward, first.direction);
    try std.testing.expectEqual(Range{ .from = 100, .to = 102 }, first.range);
    try std.testing.expectError(error.StaleCursorQuery, cursor.update(first.token + 1, &.{}, 0, store.interface()));
    try std.testing.expect(cursor.pending != null);
    try cursor.update(first.token, &.{.{ .sequence = 11, .block = 102 }}, 0, store.interface());
    try std.testing.expectEqual(Point{ .sequence = 10, .block = 100 }, cursor.forward);
    const retry = (try cursor.plan(12, 102, 1, store.interface())).query;
    try cursor.update(retry.token, &.{ .{ .sequence = 11, .block = 102 }, .{ .sequence = 9, .block = 100 }, .{ .sequence = 10, .block = 101 }, .{ .sequence = 10, .block = 999 } }, 1, store.interface());
    try std.testing.expectEqual(Point{ .sequence = 12, .block = 102 }, cursor.forward);
    const backward = (try cursor.plan(12, 103, 2, store.interface())).query;
    try std.testing.expectEqual(.backward, backward.direction);
    try std.testing.expectEqual(Range{ .from = 1, .to = 100 }, backward.range);
    try cursor.failed(backward.token);
    // Reaching the reported target with an omitted event must rewind too.
    const forward = (try cursor.plan(13, 103, 3, store.interface())).query;
    try cursor.update(forward.token, &.{}, 3, store.interface());
    try std.testing.expectEqual(@as(u32, 12), cursor.forward.sequence);
    try std.testing.expectEqual(@as(u32, 102), cursor.forward.block);
}

test "sequence cursor resumes empty backwards scans and clears per-gap progress after indexed recovery" {
    var store: TestStore = .{};
    defer store.deinit();
    var cursor = try Cursor.init(std.testing.allocator, 100, 1000, .{ .chunk = 99 });
    defer cursor.deinit();
    const first = (try cursor.plan(100, 1000, 0, store.interface())).query;
    try std.testing.expectEqual(Range{ .from = 901, .to = 1000 }, first.range);
    try cursor.update(first.token, &.{}, 0, store.interface());
    try std.testing.expectEqual(@as(?u32, 900), store.progress.get(99));
    var restarted = try Cursor.init(std.testing.allocator, 100, 1000, .{ .chunk = 99 });
    defer restarted.deinit();
    const resumed = (try restarted.plan(100, 1000, 0, store.interface())).query;
    try std.testing.expectEqual(Range{ .from = 801, .to = 900 }, resumed.range);
    try restarted.failed(resumed.token);
    try store.blocks.put(store.allocator, 99, 850);
    const recovered = (try restarted.plan(100, 1000, 0, store.interface())).query;
    try std.testing.expectEqual(Range{ .from = 751, .to = 850 }, recovered.range);
    try std.testing.expectEqual(@as(u32, 98), restarted.backward.?.sequence);
    try std.testing.expect(store.progress.get(99) == null);
    try restarted.failed(recovered.token);
    // Newly reported traffic takes precedence even while old history remains.
    const near_head = (try restarted.plan(101, 1001, 0, store.interface())).query;
    try std.testing.expectEqual(.forward, near_head.direction);
}

test "sequence cursor cumulative missing sets prevent alternating response retry storms" {
    var store: TestStore = .{};
    defer store.deinit();
    var cursor = try Cursor.init(std.testing.allocator, 6, 100, .{ .chunk = 4, .mode = .sequence });
    defer cursor.deinit();
    var next = (try cursor.plan(6, 100, 0, store.interface())).query;
    try std.testing.expectEqual(Range{ .from = 1, .to = 5 }, next.range);
    try cursor.update(next.token, &.{ .{ .sequence = 1, .block = 1 }, .{ .sequence = 3, .block = 3 }, .{ .sequence = 5, .block = 5 } }, 0, store.interface());
    try std.testing.expectEqual(@as(u64, 5000), cursor.gap_retry_at);
    try std.testing.expectEqual(@as(u64, 5000), (try cursor.plan(6, 100, 1, store.interface())).sleep_until_ms);
    next = (try cursor.plan(6, 100, 5000, store.interface())).query;
    try cursor.update(next.token, &.{ .{ .sequence = 2, .block = 2 }, .{ .sequence = 3, .block = 3 }, .{ .sequence = 5, .block = 5 } }, 5000, store.interface());
    try std.testing.expectEqualSlices(u32, &.{4}, cursor.missing.items);
    try std.testing.expectEqual(@as(u64, 10000), cursor.gap_retry_at);
    next = (try cursor.plan(6, 100, 10000, store.interface())).query;
    try cursor.update(next.token, &.{ .{ .sequence = 1, .block = 1 }, .{ .sequence = 3, .block = 3 }, .{ .sequence = 5, .block = 5 } }, 10000, store.interface());
    try std.testing.expectEqual(@as(u64, 20000), cursor.gap_retry_at);
    next = (try cursor.plan(6, 100, 20000, store.interface())).query;
    try cursor.update(next.token, &.{ .{ .sequence = 2, .block = 2 }, .{ .sequence = 4, .block = 4 }, .{ .sequence = 5, .block = 5 } }, 20000, store.interface());
    try std.testing.expectEqual(@as(u64, 0), cursor.gap_retry_at);
}

test "sequence cursor bounds database skipping relative floors and unavailable counts" {
    var store: TestStore = .{};
    defer store.deinit();
    for (10..20) |sequence| try store.blocks.put(store.allocator, @intCast(sequence), @intCast(sequence));
    var cursor = try Cursor.init(std.testing.allocator, 10, 100, .{ .skip_budget = 2, .lowest = -5 });
    defer cursor.deinit();
    try std.testing.expectEqual(.yield, try cursor.plan(20, 100, 0, store.interface()));
    try std.testing.expectEqual(@as(u32, 12), cursor.forward.sequence);
    var relative = try Cursor.init(std.testing.allocator, 6, 100, .{ .mode = .sequence, .lowest = -1 });
    defer relative.deinit();
    const action = (try relative.plan(6, 100, 0, store.interface())).query;
    try std.testing.expectEqual(Range{ .from = 5, .to = 5 }, action.range);
    try relative.failed(action.token);
    try std.testing.expectEqual(@as(u64, 5000), (try relative.plan(null, 100, 0, store.interface())).sleep_until_ms);
}

test "cooperative cursor query slicing preserves forward prefixes backward suffixes and exact pending tokens" {
    var store: TestStore = .{};
    defer store.deinit();
    var forward = try Cursor.init(std.testing.allocator, 0, 10, .{ .mode = .sequence, .chunk = 99 });
    defer forward.deinit();
    const action = try forward.plan(100, 100, 0, store.interface());
    const sliced = try forward.limitQuery(action.query.token, 3);
    try std.testing.expectEqual(Range{ .from = 0, .to = 2 }, sliced.range);
    try std.testing.expectEqual(sliced, forward.pending.?);
    try std.testing.expectError(error.StaleCursorQuery, forward.limitQuery(sliced.token + 1, 2));
    try std.testing.expectError(error.InvalidCursorQueryLimit, forward.limitQuery(sliced.token, 0));
    try forward.update(sliced.token, &.{ .{ .sequence = 0, .block = 10 }, .{ .sequence = 1, .block = 10 }, .{ .sequence = 2, .block = 10 } }, 0, store.interface());
    const next = try forward.plan(100, 100, 1, store.interface());
    try std.testing.expectEqual(@as(u32, 3), next.query.range.from);
    var backward = try Cursor.init(std.testing.allocator, 100, 100, .{ .mode = .sequence, .chunk = 99 });
    defer backward.deinit();
    const previous = try backward.plan(100, 100, 0, store.interface());
    const tail = try backward.limitQuery(previous.query.token, 3);
    try std.testing.expectEqual(Range{ .from = 97, .to = 99 }, tail.range);
    try backward.update(tail.token, &.{ .{ .sequence = 97, .block = 97 }, .{ .sequence = 98, .block = 98 }, .{ .sequence = 99, .block = 99 } }, 0, store.interface());
    const before = try backward.plan(100, 100, 1, store.interface());
    try std.testing.expectEqual(@as(u32, 96), before.query.range.to);
}
test "cooperative cursor sliced block gaps persist only the searched suffix and resume after restart" {
    var store: TestStore = .{};
    defer store.deinit();
    var cursor = try Cursor.init(std.testing.allocator, 10, 100, .{ .mode = .block, .chunk = 99, .lowest = 0 });
    defer cursor.deinit();
    const action = try cursor.plan(10, 100, 0, store.interface());
    const slice = try cursor.limitQuery(action.query.token, 3);
    try std.testing.expectEqual(Range{ .from = 98, .to = 100 }, slice.range);
    try cursor.update(slice.token, &.{}, 0, store.interface());
    try std.testing.expectEqual(@as(?u32, 97), store.progress.get(9));
    var reopened = try Cursor.init(std.testing.allocator, 10, 100, .{ .mode = .block, .chunk = 99, .lowest = 0 });
    defer reopened.deinit();
    const resumed = try reopened.plan(10, 100, 1, store.interface());
    try std.testing.expectEqual(@as(u32, 97), resumed.query.range.to);
    try std.testing.expectError(error.StaleCursorQuery, reopened.limitQuery(resumed.query.token + 1, 3));
    try reopened.failed(resumed.query.token);
    try std.testing.expectError(error.NoCursorQuery, reopened.limitQuery(resumed.query.token, 3));
}
