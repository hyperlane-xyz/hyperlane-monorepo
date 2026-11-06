//! Bounded retry set plus immutable-frontier discovery and completeness sweeps.
//! Near-head discovery preempts sweeps; only the failing lane backs off. Clock
//! arguments are injected: monotonic milliseconds for Schedule, UTC seconds for
//! retry age/backoff, preserving production semantics without global timers.
const std = @import("std");
const storage = @import("storage.zig");
const enrich = @import("enrichment.zig");
pub const PageResult = struct { candidate_count: usize = 0, attempted_count: usize = 0, skipped_backoff_count: usize = 0, untracked_count: usize = 0, stored_count: u64 = 0, next_after_id: i64 = 0 };
const Due = struct { id: i64, at: i64 };
const Retry = struct { attempts: u32 = 0, next_seconds: i64, created_seconds: i64 };
pub const Backoff = struct {
    allocator: std.mem.Allocator,
    rows: std.AutoHashMapUnmanaged(i64, Retry) = .{},
    pub fn deinit(self: *Backoff) void {
        self.rows.deinit(self.allocator);
        self.* = undefined;
    }
    pub fn shouldAttempt(self: Backoff, id: i64, now_seconds: i64) bool {
        const retry = self.rows.get(id) orelse return true;
        return retry.next_seconds <= now_seconds;
    }
    pub fn missing(self: *Backoff, id: i64, created_seconds: i64, now_seconds: i64) !?u32 {
        if (!self.rows.contains(id) and self.rows.count() >= 1000) return null;
        const entry = try self.rows.getOrPut(self.allocator, id);
        if (!entry.found_existing) entry.value_ptr.* = .{ .next_seconds = now_seconds, .created_seconds = created_seconds };
        const retry = entry.value_ptr;
        retry.created_seconds = created_seconds;
        retry.attempts +|= 1;
        const shift: u6 = @intCast(@min(retry.attempts -| 1, 4));
        const delay = @min(@as(i64, 60) * (@as(i64, 1) << shift), 900);
        retry.next_seconds = now_seconds +| delay;
        return retry.attempts;
    }
    pub fn success(self: *Backoff, id: i64) void {
        _ = self.rows.remove(id);
    }
    pub fn due(self: Backoff, allocator: std.mem.Allocator, now_seconds: i64, limit: usize) ![]i64 {
        if (limit > 100) return error.InvalidReconciliationRetryLimit;
        var list: std.ArrayList(Due) = .empty;
        defer list.deinit(allocator);
        var iterator = self.rows.iterator();
        while (iterator.next()) |entry| if (entry.value_ptr.next_seconds <= now_seconds) {
            try list.append(allocator, .{ .id = entry.key_ptr.*, .at = entry.value_ptr.next_seconds });
        };
        std.mem.sort(Due, list.items, {}, struct {
            fn less(_: void, a: Due, b: Due) bool {
                return if (a.at != b.at) a.at < b.at else a.id < b.id;
            }
        }.less);
        const ids = try allocator.alloc(i64, @min(limit, list.items.len));
        for (ids, list.items[0..ids.len]) |*id, entry| id.* = entry.id;
        return ids;
    }
    pub fn removeAbsent(self: *Backoff, requested: []const i64, returned: []const storage.RawDispatch) void {
        for (requested) |id| {
            const found = for (returned) |row| {
                if (row.id == id) break true;
            } else false;
            if (!found) _ = self.rows.remove(id);
        }
    }
    pub fn nextDelay(self: Backoff, now_seconds: i64) u64 {
        var delay: u64 = std.math.maxInt(u64);
        var it = self.rows.valueIterator();
        while (it.next()) |retry| delay = @min(delay, @as(u64, @intCast(@max(@as(i64, 0), retry.next_seconds -| now_seconds))) *| 1000);
        return delay;
    }
    pub fn maxAge(self: Backoff, now_seconds: i64) u64 {
        var result: u64 = 0;
        var it = self.rows.valueIterator();
        while (it.next()) |retry| result = @max(result, @as(u64, @intCast(@max(@as(i64, 0), now_seconds -| retry.created_seconds))));
        return result;
    }
};
pub const Plan = struct {
    arena: std.heap.ArenaAllocator,
    rows: []const storage.RawDispatch,
    eligible: []const bool,
    requests: []const enrich.Request,
    requested_ids: []const i64 = &.{},
    pub fn deinit(self: *Plan) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub fn planPage(allocator: std.mem.Allocator, store: anytype, backoff: Backoff, after: i64, through: i64, now_seconds: i64) !Plan {
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const rows = try store.rawPage(a, after, through, 100);
    return buildPlan(&arena, store, backoff, rows, now_seconds, &.{});
}
pub fn planRetry(allocator: std.mem.Allocator, store: anytype, backoff: Backoff, ids: []const i64, now_seconds: i64) !Plan {
    if (ids.len > 100) return error.InvalidReconciliationRetryLimit;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const copied = try a.dupe(i64, ids);
    const rows = try store.rawByIds(a, copied);
    return buildPlan(&arena, store, backoff, rows, now_seconds, copied);
}
fn buildPlan(arena: *std.heap.ArenaAllocator, store: anytype, backoff: Backoff, rows: []const storage.RawDispatch, now_seconds: i64, ids: []const i64) !Plan {
    const a = arena.allocator();
    if (rows.len > 100) return error.InvalidReconciliationPage;
    const eligible = try a.alloc(bool, rows.len);
    var requests: std.ArrayList(enrich.Request) = .empty;
    var unique = std.AutoHashMap([64]u8, [32]u8).init(a);
    for (rows, eligible) |row, *attempt| {
        attempt.* = backoff.shouldAttempt(row.id, now_seconds);
        if (!attempt.* or unfetchable(row.meta)) continue;
        if (try store.knownTransaction(row.meta) != null) continue;
        const entry = try unique.getOrPut(row.meta.tx_hash);
        if (entry.found_existing) {
            if (!std.mem.eql(u8, entry.value_ptr, &row.meta.block_hash)) return error.InconsistentReceiptBlock;
            continue;
        }
        entry.value_ptr.* = row.meta.block_hash;
        try requests.append(a, .{ .meta = row.meta, .block_id = try store.knownBlock(row.meta) });
    }
    const owned_requests = try requests.toOwnedSlice(a);
    return .{ .arena = arena.*, .rows = rows, .eligible = eligible, .requests = owned_requests, .requested_ids = ids };
}
fn unfetchable(meta: enrich.Meta) bool {
    return std.mem.allEqual(u8, &meta.tx_hash, 0) or std.mem.allEqual(u8, &meta.block_hash, 0);
}
pub fn finish(store: anytype, mailbox: [32]u8, plan: *Plan, backoff: *Backoff, completed_at_seconds: i64) !PageResult {
    const a = plan.arena.allocator();
    var messages: std.ArrayList(storage.Storable) = .empty;
    var resolved: std.ArrayList(i64) = .empty;
    var missing: std.ArrayList(storage.RawDispatch) = .empty;
    var result: PageResult = .{ .candidate_count = plan.rows.len };
    for (plan.rows, plan.eligible) |row, attempt| {
        result.next_after_id = @max(result.next_after_id, row.id);
        if (!attempt) {
            result.skipped_backoff_count += 1;
            continue;
        }
        result.attempted_count += 1;
        const transaction = if (unfetchable(row.meta)) null else try store.knownTransaction(row.meta);
        if (transaction != null or unfetchable(row.meta)) {
            try messages.append(a, .{ .message = row.message, .transaction_id = transaction, .id_override = row.message_id });
            try resolved.append(a, row.id);
        } else try missing.append(a, row);
    }
    result.stored_count = try store.storeMessages(mailbox, messages.items);
    for (resolved.items) |id| backoff.success(id);
    for (missing.items) |row| if (try backoff.missing(row.id, row.created_seconds, completed_at_seconds) == null) {
        result.untracked_count += 1;
    };
    if (plan.requested_ids.len != 0) backoff.removeAbsent(plan.requested_ids, plan.rows);
    return result;
}
pub const Scan = struct {
    after: i64,
    through: i64,
    next_ms: u64,
    fn create(after: i64, through: i64, now_ms: u64) ?Scan {
        return if (through > after) .{ .after = after, .through = through, .next_ms = now_ms } else null;
    }
    fn complete(self: *Scan, result: PageResult, now_ms: u64) !bool {
        if (result.candidate_count < 100) return true;
        if (result.next_after_id <= self.after or result.next_after_id > self.through) return error.ReconciliationPageNoProgress;
        self.after = result.next_after_id;
        self.next_ms = now_ms +| 2000;
        return false;
    }
};
pub const Lane = enum { retry, discovery_frontier, discovery_page, sweep_frontier, sweep_page };
pub const Schedule = struct {
    discovery_watermark: i64,
    discovery: ?Scan = null,
    sweep: ?Scan = null,
    next_discovery_ms: u64,
    next_sweep_ms: u64,
    retry_not_before_ms: u64,
    global_not_before_ms: u64,
    pub fn init(watermark: i64, now_ms: u64, global_not_before_ms: u64) Schedule {
        return .{ .discovery_watermark = watermark, .next_discovery_ms = now_ms, .next_sweep_ms = now_ms, .retry_not_before_ms = now_ms, .global_not_before_ms = global_not_before_ms };
    }
    pub fn due(self: Schedule, now_ms: u64, has_retry: bool) ?Lane {
        if (now_ms < self.global_not_before_ms) return null;
        if (has_retry and now_ms >= self.retry_not_before_ms) return .retry;
        if (self.discovery) |scan| {
            if (now_ms >= scan.next_ms) return .discovery_page;
            return null;
        }
        if (now_ms >= self.next_discovery_ms) return .discovery_frontier;
        if (self.sweep) |scan| {
            if (now_ms >= scan.next_ms) return .sweep_page;
        } else if (now_ms >= self.next_sweep_ms) return .sweep_frontier;
        return null;
    }
    /// Source loop sleeps until its first due lane (capped at30s for liveness).
    /// No global cross-domain throttle; unfinished discovery suppresses sweeps.
    pub fn nextDelay(self: Schedule, now_ms: u64, retry_delay_ms: u64) u64 {
        const retry = @max(retry_delay_ms, self.retry_not_before_ms -| now_ms);
        const discovery = if (self.discovery) |scan| scan.next_ms -| now_ms else self.next_discovery_ms -| now_ms;
        const sweep = if (self.discovery != null) std.math.maxInt(u64) else if (self.sweep) |scan| scan.next_ms -| now_ms else self.next_sweep_ms -| now_ms;
        return @max(self.global_not_before_ms -| now_ms, @min(@as(u64, 30000), @min(retry, @min(discovery, sweep))));
    }
    pub fn startDiscovery(self: *Schedule, frontier: i64, now_ms: u64) !void {
        if (self.discovery != null) return error.ReconciliationLaneBusy;
        self.discovery = Scan.create(self.discovery_watermark, frontier, now_ms);
        if (self.discovery == null) self.next_discovery_ms = now_ms +| 5000;
    }
    pub fn startSweep(self: *Schedule, frontier: i64, now_ms: u64) !void {
        if (self.discovery != null or self.sweep != null) return error.ReconciliationLaneBusy;
        self.next_sweep_ms = now_ms +| 1800000;
        self.sweep = Scan.create(0, frontier, now_ms);
    }
    pub fn completeDiscovery(self: *Schedule, result: PageResult, now_ms: u64) !void {
        var scan = self.discovery orelse return error.MissingReconciliationScan;
        if (try scan.complete(result, now_ms)) {
            self.discovery_watermark = @max(self.discovery_watermark, scan.through);
            self.discovery = null;
            self.next_discovery_ms = now_ms +| 5000;
        } else self.discovery = scan;
    }
    pub fn completeSweep(self: *Schedule, result: PageResult, now_ms: u64) !void {
        var scan = self.sweep orelse return error.MissingReconciliationScan;
        const done = try scan.complete(result, now_ms);
        self.discovery_watermark = @max(self.discovery_watermark, if (done) scan.through else scan.after);
        self.sweep = if (done) null else scan;
    }
    pub fn failed(self: *Schedule, lane: Lane, now_ms: u64) !void {
        self.global_not_before_ms = now_ms +| 2000;
        const next = now_ms +| 4000;
        switch (lane) {
            .retry => self.retry_not_before_ms = next,
            .discovery_frontier => self.next_discovery_ms = next,
            .discovery_page => {
                if (self.discovery) |*scan| scan.next_ms = next else return error.MissingReconciliationScan;
            },
            .sweep_frontier => self.next_sweep_ms = next,
            .sweep_page => {
                if (self.sweep) |*scan| scan.next_ms = next else return error.MissingReconciliationScan;
            },
        }
    }
};

test "reconciliation first page is immediately due after frontier and domains have independent cadence" {
    var first = Schedule.init(0, 0, 0);
    var second = Schedule.init(0, 0, 0);
    try first.startDiscovery(101, 0);
    try std.testing.expectEqual(Lane.discovery_page, first.due(0, false).?);
    try std.testing.expectEqual(@as(u64, 0), first.nextDelay(0, std.math.maxInt(u64)));
    try first.completeDiscovery(.{ .candidate_count = 100, .next_after_id = 100 }, 100);
    try std.testing.expectEqual(@as(u64, 2000), first.nextDelay(100, std.math.maxInt(u64)));
    // The first domain's page boundary cannot postpone another domain's work.
    try std.testing.expectEqual(Lane.discovery_frontier, second.due(100, false).?);
    try second.startDiscovery(1, 100);
    try std.testing.expectEqual(Lane.discovery_page, second.due(100, false).?);
    try second.completeDiscovery(.{ .candidate_count = 1, .next_after_id = 1 }, 150);
    // A full sweep frontier is due immediately; its first page is immediate too.
    try std.testing.expectEqual(Lane.sweep_frontier, second.due(150, false).?);
    try second.startSweep(1, 150);
    try std.testing.expectEqual(Lane.sweep_page, second.due(150, false).?);
    try second.completeSweep(.{ .candidate_count = 1, .next_after_id = 1 }, 200);
    try std.testing.expectEqual(@as(u64, 4950), second.nextDelay(200, std.math.maxInt(u64)));
    try second.failed(.discovery_frontier, 200);
    try std.testing.expectEqual(@as(u64, 4000), second.nextDelay(200, std.math.maxInt(u64)));
}
