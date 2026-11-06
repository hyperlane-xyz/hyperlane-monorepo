//! Bounded dispatch→receipt fanout. The mutex protects metadata only: no DB,
//! decoder or transport operation runs while it is held. Pending IDs survive a
//! failed read; ready neighbors rotate past failures under independent due times.
const std = @import("std");
const observation = @import("../../runtime/tx_id_observer.zig");
pub const Mask = packed struct(u2) {
    tree: bool = false,
    gas: bool = false,
    pub fn any(self: Mask) bool {
        return self.tree or self.gas;
    }
};
const Entry = struct { notice: observation.Notification, mask: Mask, generation: u64, ready_ms: u64 = 0, inflight: bool = false };
const Completed = struct { notice: observation.Notification, mask: Mask };
const Deferred = struct { notice: observation.Notification, ready_ms: u64 };
pub const Lease = struct { index: usize, generation: u64, notice: observation.Notification, mask: Mask };
pub const Queue = struct {
    allocator: std.mem.Allocator,
    entries: []?Entry,
    completed: []?Completed,
    deferred: []?Deferred,
    mutex: std.Thread.Mutex = .{},
    mask: Mask,
    next: usize = 0,
    completed_next: usize = 0,
    deferred_next: usize = 0,
    now_ms: u64 = 0,
    replay_due_ms: ?u64 = null,
    generation: u64 = 0,
    wake: ?*std.atomic.Value(bool) = null,
    pub fn init(a: std.mem.Allocator, capacity: usize, mask: Mask) !Queue {
        if (capacity == 0 or capacity > 4096) return error.InvalidTxIdQueueCapacity;
        const entries = try a.alloc(?Entry, capacity);
        errdefer a.free(entries);
        const completed = try a.alloc(?Completed, capacity);
        errdefer a.free(completed);
        const deferred = try a.alloc(?Deferred, capacity);
        @memset(entries, null);
        @memset(completed, null);
        @memset(deferred, null);
        return .{ .allocator = a, .entries = entries, .completed = completed, .deferred = deferred, .mask = mask };
    }
    /// Producers and the owner callback have joined before destruction.
    pub fn deinit(self: *Queue) void {
        self.allocator.free(self.entries);
        self.allocator.free(self.completed);
        self.allocator.free(self.deferred);
        self.* = undefined;
    }
    pub fn observer(self: *Queue) observation.Observer {
        return .{ .context = self, .notify_fn = notify };
    }
    fn notify(context: *anyopaque, value: observation.Notification) !void {
        const self: *Queue = @ptrCast(@alignCast(context));
        try self.admit(value);
    }
    fn same(a: observation.Notification, b: observation.Notification) bool {
        return a.block_number == b.block_number and std.mem.eql(u8, &a.transaction, &b.transaction);
    }
    pub fn admit(self: *Queue, value: observation.Notification) !void {
        if (std.mem.allEqual(u8, &value.transaction, 0)) return;
        self.mutex.lock();
        defer self.mutex.unlock();
        var wanted = self.mask;
        if (!wanted.any()) return;
        for (self.deferred) |*item| if (item.*) |pending| if (same(pending.notice, value)) {
            // Dispatch is durably canonical. A failed receipt yields its RAM
            // admission slot; the bounded canonical scan retries after cooldown.
            if (self.now_ms < pending.ready_ms) return;
            item.* = null;
        };
        for (self.completed) |item| if (item) |done| if (same(done.notice, value)) {
            wanted.tree = wanted.tree and !done.mask.tree;
            wanted.gas = wanted.gas and !done.mask.gas;
        };
        if (!wanted.any()) return;
        var free: ?usize = null;
        for (self.entries, 0..) |item, i| {
            if (item) |*entry| {
                if (!same(entry.notice, value)) continue;
                self.entries[i].?.mask.tree = entry.mask.tree or wanted.tree;
                self.entries[i].?.mask.gas = entry.mask.gas or wanted.gas;
                return;
            } else if (free == null) free = i;
        }
        const at = free orelse return error.TxIdQueueFull;
        self.generation +%= 1;
        self.entries[at] = .{ .notice = value, .mask = wanted, .generation = self.generation };
        if (self.wake) |flag| flag.store(true, .release);
    }
    pub fn take(self: *Queue, now_ms: u64) ?Lease {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (0..self.entries.len) |_| {
            const at = self.next;
            self.next = (at + 1) % self.entries.len;
            if (self.entries[at]) |*entry| {
                if (entry.inflight or entry.ready_ms > now_ms) continue;
                entry.inflight = true;
                return .{ .index = at, .generation = entry.generation, .notice = entry.notice, .mask = entry.mask };
            }
        }
        return null;
    }
    fn leasedEntry(self: *Queue, lease: Lease) !*Entry {
        if (self.entries[lease.index]) |*value| {
            if (value.generation != lease.generation or !value.inflight) return error.StaleTxIdLease;
            return value;
        }
        return error.StaleTxIdLease;
    }
    pub fn retry(self: *Queue, lease: Lease, now_ms: u64, delay_ms: u64) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const value = try self.leasedEntry(lease);
        value.inflight = false;
        value.ready_ms = now_ms +| delay_ms;
    }
    pub fn advance(self: *Queue, now_ms: u64) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.now_ms = now_ms;
    }
    pub fn deferReplay(self: *Queue, lease: Lease, now_ms: u64, delay_ms: u64) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const value = try self.leasedEntry(lease);
        self.deferred[self.deferred_next] = .{ .notice = value.notice, .ready_ms = now_ms +| delay_ms };
        self.replay_due_ms = @min(self.replay_due_ms orelse (now_ms +| delay_ms), now_ms +| delay_ms);
        self.deferred_next = (self.deferred_next + 1) % self.deferred.len;
        self.entries[lease.index] = null; // never a successful completion
    }
    pub fn replayAt(self: *Queue) ?u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.replay_due_ms;
    }
    /// Consume one durable replay request, independently of whether its old
    /// canonical message is still pending. New failures request another pass.
    pub fn beginReplay(self: *Queue, now_ms: u64) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const due = self.replay_due_ms orelse return false;
        if (now_ms < due) return false;
        self.replay_due_ms = null;
        for (self.deferred) |*item| if (item.*) |value| {
            if (value.ready_ms <= now_ms) item.* = null else self.replay_due_ms = @min(self.replay_due_ms orelse value.ready_ms, value.ready_ms);
        };
        return true;
    }
    pub fn complete(self: *Queue, lease: Lease) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const value = try self.leasedEntry(lease);
        const done = value.*;
        value.mask.tree = value.mask.tree and !lease.mask.tree;
        value.mask.gas = value.mask.gas and !lease.mask.gas;
        value.inflight = false;
        if (!value.mask.any()) self.entries[lease.index] = null;
        self.completed[self.completed_next] = .{ .notice = done.notice, .mask = lease.mask };
        self.completed_next = (self.completed_next + 1) % self.completed.len;
    }
    /// Owner cancels/releases its current lease before changing this mask.
    pub fn setMask(self: *Queue, mask: Mask) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (std.meta.eql(self.mask, mask)) return false;
        self.mask = mask;
        for (self.entries) |*item| if (item.*) |*value| {
            value.mask.tree = value.mask.tree and mask.tree;
            value.mask.gas = value.mask.gas and mask.gas;
            if (!value.mask.any()) item.* = null;
        };
        @memset(self.completed, null);
        @memset(self.deferred, null);
        self.replay_due_ms = null;
        return true;
    }
    pub fn nextDelay(self: *Queue, now_ms: u64) u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        var due = now_ms +| 1000;
        for (self.entries) |item| if (item) |value| {
            due = @min(due, if (value.inflight) now_ms +| 10 else value.ready_ms);
        };
        if (self.replay_due_ms) |at| due = @min(due, at);
        return due -| now_ms;
    }
    pub fn count(self: *Queue) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        var result: usize = 0;
        for (self.entries) |item| if (item != null) {
            result += 1;
        };
        return result;
    }
};
test "transaction-ID queue bounds admission deduplicates full IDs and rotates failed neighbors" {
    var queue = try Queue.init(std.testing.allocator, 2, .{ .tree = true, .gas = true });
    defer queue.deinit();
    var a: observation.Notification = .{ .transaction = @splat(1), .block_number = 7 };
    var b = a;
    b.transaction[0] = 2; // preserve the high half, not only EVM low32.
    var c = a;
    c.transaction[0] = 3;
    try queue.admit(a);
    try queue.admit(a);
    try queue.admit(b);
    try std.testing.expectEqual(@as(usize, 2), queue.count());
    try std.testing.expectError(error.TxIdQueueFull, queue.admit(c));
    const first = queue.take(0).?;
    try queue.retry(first, 100, 2000);
    const healthy = queue.take(100).?;
    try std.testing.expectEqual(b.transaction, healthy.notice.transaction);
    try queue.complete(healthy);
    try queue.admit(b); // completed same notification has no duplicate query.
    try std.testing.expectEqual(@as(usize, 1), queue.count());
    try std.testing.expect(queue.take(2099) == null);
    const retried = queue.take(2100).?;
    try std.testing.expectEqual(a.transaction, retried.notice.transaction);
    try queue.complete(retried);
    a.transaction = @splat(0);
    try queue.admit(a);
    try std.testing.expectEqual(@as(usize, 0), queue.count());
}
test "transaction-ID queue allocation failures release every partial buffer" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, struct {
        fn run(a: std.mem.Allocator) !void {
            var queue = try Queue.init(a, 2, .{ .gas = true });
            defer queue.deinit();
        }
    }.run, .{});
}

test "transaction-ID failed replay hints bound memory yield admission and expire without a busy loop" {
    var queue = try Queue.init(std.testing.allocator, 1, .{ .gas = true });
    defer queue.deinit();
    const first = observation.Notification{ .transaction = @splat(1), .block_number = 7 };
    const second = observation.Notification{ .transaction = @splat(2), .block_number = 7 };
    queue.advance(100);
    try queue.admit(first);
    try queue.deferReplay(queue.take(100).?, 100, 2000);
    try queue.admit(first); // durable pending row is cooling down, not completed
    try std.testing.expectEqual(@as(usize, 0), queue.count());
    try queue.admit(second);
    try queue.complete(queue.take(101).?);
    try std.testing.expect(!queue.beginReplay(2099));
    try std.testing.expect(queue.beginReplay(2100));
    try std.testing.expect(queue.replayAt() == null);
    try std.testing.expectEqual(@as(u64, 1000), queue.nextDelay(2100));
    queue.advance(2100);
    try queue.admit(first); // failed ID was never falsely completed
    try std.testing.expectEqual(first.transaction, queue.take(2100).?.notice.transaction);
}
