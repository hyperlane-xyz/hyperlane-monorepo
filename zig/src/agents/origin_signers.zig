//! Shared origin-transaction signer snapshots and pure prepare backoff state.
//! Cached entries are keyed by the full canonical message id and retain every
//! non-zero signer in source order. All workers must be joined before deinit.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const A = std.mem.Allocator;
pub const Hash = [32]u8;
pub const default_capacity: usize = 100_000;
pub const default_max_bytes: usize = 64 * 1024 * 1024;
pub const hash_wait_ns: u64 = 30 * std.time.ns_per_s;
pub const give_up_cooldown_ns: u64 = 300 * std.time.ns_per_s;
pub const max_failures: u32 = 5;

pub const Lookup = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, A, protocol.Message, u64, ?*const std.atomic.Value(bool)) anyerror![]Hash,
    pub fn fetch(self: Lookup, allocator: A, message: protocol.Message, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool)) ![]Hash {
        return self.fetch_fn(self.context, allocator, message, deadline_ns, cancel);
    }
};

/// Public lookup deadlines are absolute Unix UTC nanoseconds. The timer keeps
/// subsequent waits in the monotonic domain, so wall-clock rollback cannot extend them.
pub const WaitBudget = struct {
    timer: std.time.Timer,
    duration_ns: u64,

    pub fn init(deadline_utc_ns: u64) !WaitBudget {
        const wall_now = std.time.nanoTimestamp();
        if (wall_now < 0) return error.UnsupportedClock;
        const now = std.math.cast(u64, wall_now) orelse return error.UnsupportedClock;
        if (now >= deadline_utc_ns) return error.SourceReadDeadline;
        return .{ .timer = try std.time.Timer.start(), .duration_ns = deadline_utc_ns - now };
    }

    pub fn remaining(self: *WaitBudget) !u64 {
        const elapsed = self.timer.read();
        if (elapsed >= self.duration_ns) return error.SourceReadDeadline;
        return self.duration_ns - elapsed;
    }

    pub fn milliseconds(self: *WaitBudget) !u32 {
        const remaining_ns = try self.remaining();
        return @intCast(@min(std.math.maxInt(u32), (remaining_ns + 999_999) / std.time.ns_per_ms));
    }
};

fn cancelled(cancel: ?*const std.atomic.Value(bool)) !void {
    if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
}

pub const Cache = struct {
    const Entry = struct {
        key: Hash,
        state: enum { pending, ready, failed } = .pending,
        signers: []Hash = &.{},
        failure: anyerror = error.OriginSignerLookupFailed,
        references: usize = 1,
        cached: bool = true,
        older: ?*Entry = null,
        newer: ?*Entry = null,
    };

    allocator: A,
    entries: std.AutoHashMapUnmanaged(Hash, *Entry) = .empty,
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    newest: ?*Entry = null,
    oldest: ?*Entry = null,
    capacity: usize,
    max_bytes: usize,
    cached_bytes: usize = 0,

    pub fn init(allocator: A, capacity: usize, max_bytes: usize) !Cache {
        if (capacity == 0 or capacity > default_capacity or max_bytes < @sizeOf(Entry)) return error.InvalidOriginSignerCacheLimit;
        return .{ .allocator = allocator, .capacity = capacity, .max_bytes = max_bytes };
    }

    pub fn initDefault(allocator: A) !Cache {
        return init(allocator, default_capacity, default_max_bytes);
    }

    pub fn deinit(self: *Cache) void {
        var iterator = self.entries.iterator();
        while (iterator.next()) |item| {
            const entry = item.value_ptr.*;
            std.debug.assert(entry.state != .pending);
            self.allocator.free(entry.signers);
            self.allocator.destroy(entry);
        }
        self.entries.deinit(self.allocator);
        self.* = undefined;
    }

    pub const Stats = struct { entries: usize, bytes: usize };
    pub fn stats(self: *Cache) Stats {
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{ .entries = self.entries.count(), .bytes = self.cached_bytes };
    }

    pub const Snapshot = struct {
        cache: *Cache,
        entry: *Entry,

        pub fn signers(self: Snapshot) []const Hash {
            std.debug.assert(self.entry.state == .ready);
            return self.entry.signers;
        }

        pub fn deinit(self: *Snapshot) void {
            self.cache.release(self.entry);
            self.* = undefined;
        }
    };

    fn release(self: *Cache, entry: *Entry) void {
        self.mutex.lock();
        std.debug.assert(entry.references > 0);
        entry.references -= 1;
        const destroy = entry.references == 0 and !entry.cached;
        self.mutex.unlock();
        if (destroy) {
            self.allocator.free(entry.signers);
            self.allocator.destroy(entry);
        }
    }

    fn unlink(self: *Cache, entry: *Entry) void {
        if (entry.newer) |newer| newer.older = entry.older else self.newest = entry.older;
        if (entry.older) |older| older.newer = entry.newer else self.oldest = entry.newer;
        entry.older = null;
        entry.newer = null;
    }

    fn link(self: *Cache, entry: *Entry) void {
        entry.newer = self.newest;
        if (self.newest) |newest| newest.older = entry;
        self.newest = entry;
        if (self.oldest == null) self.oldest = entry;
    }

    fn touch(self: *Cache, entry: *Entry) void {
        self.unlink(entry);
        self.link(entry);
    }

    fn evict(self: *Cache, entry: *Entry) void {
        std.debug.assert(entry.cached);
        std.debug.assert(entry.state == .ready);
        _ = self.entries.remove(entry.key);
        self.unlink(entry);
        entry.cached = false;
        self.cached_bytes -= @sizeOf(Entry) + entry.signers.len * @sizeOf(Hash);
    }

    fn makeRoom(self: *Cache, needed: usize) void {
        if (needed > self.max_bytes) return;
        var candidate = self.oldest;
        while (candidate) |entry| {
            if (self.entries.count() <= self.capacity and self.cached_bytes + needed <= self.max_bytes) break;
            candidate = entry.newer;
            if (entry.references == 0) self.evict(entry);
        }
    }

    pub fn cached(self: *Cache, id: Hash) ?Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        const entry = self.entries.get(id) orelse return null;
        if (entry.state != .ready) return null;
        entry.references += 1;
        self.touch(entry);
        return .{ .cache = self, .entry = entry };
    }

    /// No source call occurs unless address rules are active or the caller
    /// explicitly needs signers. Positive and empty results share one snapshot;
    /// all current waiters also share an in-flight error without caching it.
    pub fn lookup(self: *Cache, allocator: A, message: protocol.Message, address_rules_active: bool, explicit_signers: bool, source: Lookup, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool)) !?Snapshot {
        if (!address_rules_active and !explicit_signers) return null;
        const id = message.id();
        self.mutex.lock();
        if (self.entries.get(id)) |entry| {
            entry.references += 1;
            var budget: ?WaitBudget = null;
            while (entry.state == .pending) {
                cancelled(cancel) catch |err| {
                    self.releaseLocked(entry);
                    self.mutex.unlock();
                    return err;
                };
                if (budget == null) budget = WaitBudget.init(deadline_ns) catch |err| {
                    self.releaseLocked(entry);
                    self.mutex.unlock();
                    return err;
                };
                const remaining = if (budget) |*active| active.remaining() catch |err| {
                    self.releaseLocked(entry);
                    self.mutex.unlock();
                    return err;
                } else unreachable;
                self.changed.timedWait(&self.mutex, @min(10 * std.time.ns_per_ms, remaining)) catch {};
            }
            if (entry.state == .ready) {
                if (entry.cached) self.touch(entry);
                self.mutex.unlock();
                return Snapshot{ .cache = self, .entry = entry };
            }
            const failure = entry.failure;
            self.releaseLocked(entry);
            self.mutex.unlock();
            return failure;
        }
        const entry = self.allocator.create(Entry) catch |err| {
            self.mutex.unlock();
            return err;
        };
        entry.* = .{ .key = id };
        self.entries.put(self.allocator, id, entry) catch |err| {
            self.allocator.destroy(entry);
            self.mutex.unlock();
            return err;
        };
        self.mutex.unlock();

        const result: anyerror![]Hash = blk: {
            const raw = source.fetch(allocator, message, deadline_ns, cancel) catch |err| break :blk err;
            var nonzero: usize = 0;
            for (raw) |signer| if (!std.mem.allEqual(u8, &signer, 0)) {
                nonzero += 1;
            };
            const normalized = allocator.alloc(Hash, nonzero) catch |err| {
                allocator.free(raw);
                break :blk err;
            };
            var at: usize = 0;
            for (raw) |signer| if (!std.mem.allEqual(u8, &signer, 0)) {
                normalized[at] = signer;
                at += 1;
            };
            allocator.free(raw);
            break :blk normalized;
        };

        self.mutex.lock();
        if (result) |signers| {
            entry.signers = signers;
            entry.state = .ready;
            const needed = @sizeOf(Entry) + signers.len * @sizeOf(Hash);
            self.makeRoom(needed);
            if (self.entries.count() <= self.capacity and self.cached_bytes + needed <= self.max_bytes) {
                self.link(entry);
                self.cached_bytes += needed;
            } else {
                _ = self.entries.remove(id);
                entry.cached = false;
            }
            self.changed.broadcast();
            self.mutex.unlock();
            return Snapshot{ .cache = self, .entry = entry };
        } else |err| {
            entry.failure = err;
            entry.state = .failed;
            _ = self.entries.remove(id);
            entry.cached = false;
            self.releaseLocked(entry);
            self.changed.broadcast();
            self.mutex.unlock();
            return err;
        }
    }

    fn releaseLocked(self: *Cache, entry: *Entry) void {
        std.debug.assert(entry.references > 0);
        entry.references -= 1;
        if (entry.references == 0 and !entry.cached) {
            self.allocator.free(entry.signers);
            self.allocator.destroy(entry);
        }
    }
};

pub const Outcome = enum { success, hash_not_stored, peer_failure, control };
pub const Action = union(enum) {
    lookup,
    cached_only,
    proceed,
    delay_ns: u64,
    general_retry,
    control,
};

/// Per-message state. Delays are returned as data so the root actor can use its
/// no-retry-budget Event.delay path. This type never sleeps or performs I/O.
pub const Prepare = struct {
    failures: u32 = 0,
    hash_waited: bool = false,
    skip_until_ns: ?u64 = null,

    pub fn begin(self: *const Prepare, now_ns: u64) Action {
        if (self.skip_until_ns) |until| if (now_ns < until) return .cached_only;
        return .lookup;
    }

    pub fn complete(self: *Prepare, now_ns: u64, fail_fast: bool, outcome: Outcome) Action {
        switch (outcome) {
            .control => return .control,
            .success => {
                self.failures = 0;
                self.skip_until_ns = null;
                return .proceed;
            },
            .hash_not_stored => {
                if (fail_fast) return .general_retry;
                if (!self.hash_waited) {
                    self.hash_waited = true;
                    return .{ .delay_ns = hash_wait_ns };
                }
                return .proceed;
            },
            .peer_failure => {
                if (fail_fast) return .general_retry;
                self.failures +|= 1;
                if (self.failures < max_failures) return .{ .delay_ns = 30 * std.time.ns_per_s * (@as(u64, 1) << @intCast(self.failures - 1)) };
                self.skip_until_ns = now_ns +| give_up_cooldown_ns;
                return .proceed;
            },
        }
    }
};

pub fn isControlError(err: anyerror) bool {
    return switch (err) {
        error.OutOfMemory,
        error.RequestCancelled,
        error.RequestDeadlineExceeded,
        error.SourceReadDeadline,
        error.ScraperReceiptDeadline,
        error.SvmRequestDeadline,
        error.OriginSignerLookupPending,
        error.StaleCanonicalMessage,
        error.CanonicalMessageMissing,
        => true,
        else => false,
    };
}
