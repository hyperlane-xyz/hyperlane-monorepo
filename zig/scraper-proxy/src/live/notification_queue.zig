//! An insertion-ordered set/map of pending notification keys with O(1)
//! insert/update and O(batch) removal from the front: the JS `Map`/`Set`
//! operations the TS drains use (`set` keeps an existing key's position,
//! batches are taken from the front, `clear`).
const std = @import("std");
const Allocator = std.mem.Allocator;

pub fn Queue(comptime V: type) type {
    return struct {
        const Self = @This();

        /// Owned keys in insertion order; `order[head..]` are live.
        order: std.ArrayList([]u8) = .empty,
        head: usize = 0,
        /// Key (borrowed from `order`) -> value.
        values: std.StringHashMapUnmanaged(V) = .empty,

        pub fn deinit(self: *Self, allocator: Allocator) void {
            self.clear(allocator);
            self.order.deinit(allocator);
            self.values.deinit(allocator);
        }

        pub fn count(self: *const Self) usize {
            return self.values.count();
        }

        pub fn contains(self: *const Self, key: []const u8) bool {
            return self.values.contains(key);
        }

        /// `map.set(key, value)`: a new key goes last; an existing key keeps
        /// its position and takes the new value.
        pub fn put(self: *Self, allocator: Allocator, key: []const u8, value: V) Allocator.Error!void {
            if (self.values.getPtr(key)) |slot| {
                slot.* = value;
                return;
            }
            const owned = try allocator.dupe(u8, key);
            errdefer allocator.free(owned);
            try self.order.append(allocator, owned);
            errdefer _ = self.order.pop();
            try self.values.put(allocator, owned, value);
        }

        pub const Entry = struct { key: []u8, value: V };

        /// Removes up to `max` entries from the front into `out` (cleared
        /// first). Keys in `out` are owned by the caller (free with `allocator`).
        pub fn takeFront(self: *Self, allocator: Allocator, max: usize, out: *std.ArrayList(Entry)) Allocator.Error!void {
            out.clearRetainingCapacity();
            const take = @min(max, self.order.items.len - self.head);
            try out.ensureTotalCapacity(allocator, take);
            for (self.order.items[self.head .. self.head + take]) |key| {
                const removed = self.values.fetchRemove(key).?;
                out.appendAssumeCapacity(.{ .key = key, .value = removed.value });
            }
            self.head += take;
            // Compact once the consumed prefix dominates (amortized O(1) per key).
            if (self.head == self.order.items.len) {
                self.order.clearRetainingCapacity();
                self.head = 0;
            } else if (self.head > 1024 and self.head * 2 > self.order.items.len) {
                const live = self.order.items[self.head..];
                std.mem.copyForwards([]u8, self.order.items[0..live.len], live);
                self.order.shrinkRetainingCapacity(live.len);
                self.head = 0;
            }
        }

        pub fn clear(self: *Self, allocator: Allocator) void {
            for (self.order.items[self.head..]) |key| allocator.free(key);
            self.order.clearRetainingCapacity();
            self.head = 0;
            self.values.clearRetainingCapacity();
        }
    };
}

test "keeps JS Map insertion order, updates in place and drains in batches" {
    const a = std.testing.allocator;
    var queue: Queue(u32) = .{};
    defer queue.deinit(a);
    try queue.put(a, "a", 1);
    try queue.put(a, "b", 2);
    try queue.put(a, "a", 3); // keeps first position
    try queue.put(a, "c", 4);
    var out: std.ArrayList(Queue(u32).Entry) = .empty;
    defer out.deinit(a);
    try queue.takeFront(a, 2, &out);
    try std.testing.expectEqual(@as(usize, 2), out.items.len);
    try std.testing.expectEqualStrings("a", out.items[0].key);
    try std.testing.expectEqual(@as(u32, 3), out.items[0].value);
    try std.testing.expectEqualStrings("b", out.items[1].key);
    for (out.items) |entry| a.free(entry.key);
    try std.testing.expect(!queue.contains("a"));
    try queue.put(a, "a", 5); // re-added after removal: goes last
    try queue.takeFront(a, 10, &out);
    try std.testing.expectEqual(@as(usize, 2), out.items.len);
    try std.testing.expectEqualStrings("c", out.items[0].key);
    try std.testing.expectEqualStrings("a", out.items[1].key);
    for (out.items) |entry| a.free(entry.key);
    try std.testing.expectEqual(@as(usize, 0), queue.count());
    try queue.put(a, "x", 1);
    queue.clear(a);
    try std.testing.expectEqual(@as(usize, 0), queue.count());
}

test "drains a full 10k queue in O(batch) steps preserving order" {
    const a = std.testing.allocator;
    var queue: Queue(void) = .{};
    defer queue.deinit(a);
    var key: [16]u8 = undefined;
    for (0..10_000) |i| try queue.put(a, try std.fmt.bufPrint(&key, "{d}", .{i}), {});
    var out: std.ArrayList(Queue(void).Entry) = .empty;
    defer out.deinit(a);
    var next: usize = 0;
    var batches: usize = 0;
    while (queue.count() > 0) {
        try queue.takeFront(a, 100, &out);
        batches += 1;
        // New keys arriving mid-drain go to the back.
        if (batches == 50) try queue.put(a, "late", {});
        for (out.items) |entry| {
            defer a.free(entry.key);
            if (std.mem.eql(u8, entry.key, "late")) {
                try std.testing.expectEqual(@as(usize, 10_000), next);
                continue;
            }
            try std.testing.expectEqualStrings(try std.fmt.bufPrint(&key, "{d}", .{next}), entry.key);
            next += 1;
        }
        // The live window never holds consumed slots for long.
        try std.testing.expect(queue.order.items.len <= 10_001);
    }
    try std.testing.expectEqual(@as(usize, 10_000), next);
    try std.testing.expectEqual(@as(usize, 101), batches);
}
