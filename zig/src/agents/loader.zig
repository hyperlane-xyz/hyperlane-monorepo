//! Bounded per-origin native message loader. New/high and historical/low
//! destination scans alternate, with one reservation per canonical message ID.
//! Policy decisions stay with the caller; policy changes reopen the low scan.
const std = @import("std");
const native = @import("store.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
pub const Options = struct { max_loaded: usize = 4096, max_reconsider: usize = 4096, scan_budget: usize = 64, migration_page: usize = 256 };
const Direction = enum { high, low, reconsider };
const Destination = struct {
    domain: u32,
    high: ?u32,
    low: ?u32,
    next_low: bool = false,
    reopen_pending: bool = false,
    reconsider: std.ArrayList(u32) = .empty,
    fn reopen(self: *Destination) void {
        self.low = if (self.high) |h| std.math.sub(u32, h, 1) catch null else std.math.maxInt(u32);
        self.reopen_pending = false;
    }
    fn advance(self: *Destination, direction: Direction, nonce: u32) void {
        switch (direction) {
            .high => {
                self.high = std.math.add(u32, nonce, 1) catch null;
                self.next_low = true;
            },
            .low => {
                self.low = std.math.sub(u32, nonce, 1) catch null;
                self.next_low = false;
            },
            .reconsider => {
                _ = self.reconsider.orderedRemove(0);
            },
        }
    }
};
const Reservation = struct { destination: usize, nonce: u32 };
pub const Candidate = struct { message: native.OwnedMessage, destination_index: usize };
pub const Loader = struct {
    allocator: A,
    store: *native.Store,
    options: Options,
    destinations: []Destination,
    loaded: std.AutoHashMapUnmanaged(Hash, Reservation) = .empty,
    next_destination: usize = 0,
    migration_high: ?u32,
    migration_low: ?u32,
    migrate_low: bool = false,

    pub fn init(a: A, store: *native.Store, domains: []const u32, options: Options) !Loader {
        if (domains.len == 0 or domains.len > 4096 or options.max_loaded == 0 or options.max_reconsider == 0 or options.scan_budget == 0 or options.migration_page == 0 or options.migration_page > 256) return error.InvalidLoaderBounds;
        const highest = try store.highestSeenNonce();
        const destinations = try a.alloc(Destination, domains.len);
        errdefer a.free(destinations);
        for (domains, 0..) |domain, i| {
            for (domains[0..i]) |previous| if (domain == previous) return error.DuplicateLoaderDestination;
            destinations[i] = .{ .domain = domain, .high = highest orelse 0, .low = if (highest) |h| std.math.sub(u32, h, 1) catch null else null };
        }
        return .{ .allocator = a, .store = store, .options = options, .destinations = destinations, .migration_high = highest orelse 0, .migration_low = if (highest) |h| std.math.sub(u32, h, 1) catch null else null };
    }
    pub fn deinit(self: *Loader) void {
        for (self.destinations) |*destination| destination.reconsider.deinit(self.allocator);
        self.allocator.free(self.destinations);
        self.loaded.deinit(self.allocator);
        self.* = undefined;
    }
    pub fn migrationComplete(self: *const Loader) bool {
        return self.migration_high == null and self.migration_low == null;
    }
    /// No marker skips startup repair. Progress is process-local; every DB row
    /// is revalidated atomically against the current canonical nonce.
    pub fn migrate(self: *Loader) !usize {
        const low = self.migration_low != null and (self.migrate_low or self.migration_high == null);
        const first = (if (low) self.migration_low else self.migration_high) orelse return 0;
        const page = if (low) try self.store.reconcileLegacyBefore(first, self.options.migration_page) else try self.store.reconcileLegacyPage(first, self.options.migration_page);
        if (low) self.migration_low = page.next else self.migration_high = page.next;
        self.migrate_low = !low;
        // Migration can repair an older nonce after its destination passed it.
        // A range boundary costs O(destinations), never O(historical rows).
        for (self.destinations) |*destination| {
            if (destination.low == null) destination.reopen() else destination.reopen_pending = true;
        }
        return page.scanned;
    }
    pub fn rescan(self: *Loader) void {
        for (self.destinations) |*destination| {
            if (destination.low == null) destination.reopen() else destination.reopen_pending = true;
        }
    }
    pub fn release(self: *Loader, id: Hash, reconsider: bool) !void {
        const item = self.loaded.fetchRemove(id) orelse return;
        if (!reconsider) return;
        const destination = &self.destinations[item.value.destination];
        const nonce = item.value.nonce;
        if ((destination.high != null and nonce >= destination.high.?) or (destination.low != null and nonce <= destination.low.?)) return;
        const at = std.sort.lowerBound(u32, destination.reconsider.items, nonce, struct {
            fn less(a: u32, b: u32) std.math.Order {
                return std.math.order(a, b);
            }
        }.less);
        if (at < destination.reconsider.items.len and destination.reconsider.items[at] == nonce) return;
        if (destination.reconsider.items.len >= self.options.max_reconsider) {
            destination.reopen();
            return;
        }
        destination.reconsider.insert(self.allocator, at, nonce) catch |err| {
            destination.reopen(); // Ownership is released; rescan still retains work.
            return err;
        };
    }
    pub fn next(self: *Loader) !?Candidate {
        if (self.loaded.count() >= self.options.max_loaded) return null;
        var scanned: usize = 0;
        var idle: usize = 0;
        while (scanned < self.options.scan_budget and idle < self.destinations.len) {
            const destination_index = self.next_destination;
            self.next_destination = (destination_index + 1) % self.destinations.len;
            const destination = &self.destinations[destination_index];
            if (destination.low == null and destination.reopen_pending) destination.reopen();
            var selected: ?native.OwnedMessage = null;
            var direction: Direction = .high;
            if (destination.reconsider.items.len > 0) {
                const nonce = destination.reconsider.items[0];
                selected = try self.store.pendingAtOrAfter(destination.domain, nonce);
                if (selected != null and selected.?.value.nonce != nonce) {
                    selected.?.deinit();
                    selected = null;
                }
                if (selected == null) _ = destination.reconsider.orderedRemove(0) else direction = .reconsider;
            }
            if (selected == null) {
                for (0..2) |attempt| {
                    const low = if (attempt == 0) destination.next_low else !destination.next_low;
                    const boundary = (if (low) destination.low else destination.high) orelse continue;
                    selected = if (low) try self.store.pendingAtOrBefore(destination.domain, boundary) else try self.store.pendingAtOrAfter(destination.domain, boundary);
                    if (selected != null) {
                        direction = if (low) .low else .high;
                        break;
                    }
                    if (low) {
                        destination.low = null;
                        if (destination.reopen_pending) destination.reopen();
                    }
                }
            }
            if (selected) |value| {
                var message = value;
                var transferred = false;
                defer if (!transferred) message.deinit();
                scanned += 1;
                idle = 0;
                const id = message.value.id();
                if (self.loaded.contains(id)) {
                    destination.advance(direction, message.value.nonce);
                    continue;
                }
                // Reserve before advancing so allocation failure cannot skip work.
                try self.loaded.put(self.allocator, id, .{ .destination = destination_index, .nonce = message.value.nonce });
                destination.advance(direction, message.value.nonce);
                transferred = true;
                return .{ .message = message, .destination_index = destination_index };
            } else idle += 1;
        }
        return null;
    }
};
