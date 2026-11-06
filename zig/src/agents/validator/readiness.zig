//! Thread-safe source ValidatorReadiness and Eigen checkpoint health state.
const std = @import("std");
const A = std.mem.Allocator;
pub const StateName = enum { starting, waiting_for_first_message, ready, signing_blocked };
pub const Clock = struct { context: *anyopaque, now_ms: *const fn (*anyopaque) anyerror!u64 };
const Blocker = struct { failures: u64, first_ms: u64 };
pub const Snapshot = struct { state: StateName, consecutive_failures: u64, failure_duration_ms: u64, signing_blocked: bool, blocked_operations: []const []const u8 };
pub const State = struct {
    allocator: A,
    mutex: std.Thread.Mutex = .{},
    healthy: StateName = .starting,
    blockers: std.StringHashMapUnmanaged(Blocker) = .{},
    origin: ?std.time.Instant = null,
    clock: ?Clock = null,
    observed: i64 = 0,
    processed: i64 = 0,
    pub fn init(a: A) State {
        return .{ .allocator = a };
    }
    pub fn deinit(self: *State) void {
        var iterator = self.blockers.iterator();
        while (iterator.next()) |entry| self.allocator.free(entry.key_ptr.*);
        self.blockers.deinit(self.allocator);
        self.* = undefined;
    }
    fn now(self: *State) !u64 {
        if (self.clock) |clock| return clock.now_ms(clock.context);
        const sampled = try std.time.Instant.now();
        if (self.origin == null) self.origin = sampled;
        return if (sampled.order(self.origin.?) == .lt) 0 else sampled.since(self.origin.?) / std.time.ns_per_ms;
    }
    pub fn waiting(self: *State) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.healthy = .waiting_for_first_message;
    }
    pub fn ready(self: *State, operation: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.healthy = .ready;
        if (self.blockers.fetchRemove(operation)) |entry| self.allocator.free(entry.key);
    }
    pub fn blocked(self: *State, operation: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const now_ms = try self.now();
        if (self.blockers.getPtr(operation)) |value| {
            value.failures +|= 1;
            return;
        }
        const name = try self.allocator.dupe(u8, operation);
        errdefer self.allocator.free(name);
        try self.blockers.put(self.allocator, name, .{ .failures = 1, .first_ms = now_ms });
    }
    pub fn checkpoints(self: *State, observed: ?u32, processed: ?u32) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (observed) |value| self.observed = value;
        if (processed) |value| self.processed = value;
    }
    pub fn snapshot(self: *State, a: A) !Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        const now_ms = try self.now();
        const names = try a.alloc([]const u8, self.blockers.count());
        var initialized: usize = 0;
        errdefer {
            for (names[0..initialized]) |name| a.free(name);
            a.free(names);
        }
        var failures: u64 = 0;
        var duration: u64 = 0;
        var iterator = self.blockers.iterator();
        while (iterator.next()) |entry| {
            names[initialized] = try a.dupe(u8, entry.key_ptr.*);
            initialized += 1;
            failures = @max(failures, entry.value_ptr.failures);
            duration = @max(duration, now_ms -| entry.value_ptr.first_ms);
        }
        std.mem.sort([]const u8, names, {}, struct {
            fn less(_: void, l: []const u8, r: []const u8) bool {
                return std.mem.lessThan(u8, l, r);
            }
        }.less);
        const state: StateName = if (names.len > 0) .signing_blocked else self.healthy;
        return .{ .state = state, .consecutive_failures = failures, .failure_duration_ms = duration, .signing_blocked = state == .signing_blocked, .blocked_operations = names };
    }
    pub fn health(self: *State) u16 {
        self.mutex.lock();
        defer self.mutex.unlock();
        const delta = self.observed -| self.processed;
        return if (delta <= 1) 200 else if (delta <= 10) 206 else 503;
    }
};

test "source readiness retains unrelated blockers sorts names and reports maxima" {
    const Fixture = struct {
        value: u64 = 100,
        fn nowMs(ctx: *anyopaque) !u64 {
            return (@as(*@This(), @ptrCast(@alignCast(ctx)))).value;
        }
    };
    const a = std.testing.allocator;
    var clock: Fixture = .{};
    var state = State.init(a);
    defer state.deinit();
    state.clock = .{ .context = &clock, .now_ms = Fixture.nowMs };
    try state.blocked("merkle_tree_hook.tree");
    clock.value = 110;
    try state.blocked("base_merkle_tree_hook.count");
    try state.blocked("base_merkle_tree_hook.count");
    state.waiting();
    state.ready("unrelated_success");
    clock.value = 150;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const value = try state.snapshot(arena.allocator());
    try std.testing.expectEqual(StateName.signing_blocked, value.state);
    try std.testing.expectEqual(@as(u64, 2), value.consecutive_failures);
    try std.testing.expectEqual(@as(u64, 50), value.failure_duration_ms);
    try std.testing.expectEqualStrings("base_merkle_tree_hook.count", value.blocked_operations[0]);
    state.ready("base_merkle_tree_hook.count");
    try std.testing.expect((try state.snapshot(arena.allocator())).signing_blocked);
    state.ready("merkle_tree_hook.tree");
    try std.testing.expectEqual(StateName.ready, (try state.snapshot(arena.allocator())).state);
}
test "Eigen source delta thresholds include negative and initially zero gauges" {
    var state = State.init(std.testing.allocator);
    defer state.deinit();
    try std.testing.expectEqual(@as(u16, 200), state.health());
    state.checkpoints(42, 30);
    try std.testing.expectEqual(@as(u16, 503), state.health());
    state.checkpoints(42, 34);
    try std.testing.expectEqual(@as(u16, 206), state.health());
    state.checkpoints(42, 41);
    try std.testing.expectEqual(@as(u16, 200), state.health());
    state.checkpoints(42, 50);
    try std.testing.expectEqual(@as(u16, 200), state.health());
}
