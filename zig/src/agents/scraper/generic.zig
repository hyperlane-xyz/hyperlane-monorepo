//! Source-neutral adapter for production indexers: complete sequence pages,
//! common block coverage, per-cycle tip/header caching, and sparse-slot searches.
//! Actual protocol indexers are injected; unsupported capabilities return errors.
const std = @import("std");
const src = @import("source.zig");
pub const Provider = struct { context: *anyopaque, latest_fn: *const fn (*anyopaque) anyerror!u64, header_fn: *const fn (*anyopaque, u64) anyerror!src.Header, unavailable_fn: *const fn (anyerror) bool };
pub const Stream = struct { context: *anyopaque, tip_fn: *const fn (*anyopaque) anyerror!src.Tip, fetch_fn: *const fn (*anyopaque, std.mem.Allocator, u32, u32) anyerror!src.Batch };
pub const Adapter = struct {
    allocator: std.mem.Allocator,
    provider: Provider,
    streams: [4]?Stream,
    contracts: src.Contracts,
    sequence_mode: bool,
    derive_insertions: bool,
    chunk: u32,
    max_events: usize = 100000,
    max_batch_bytes: usize = 64 * 1024 * 1024,
    headers: std.AutoHashMapUnmanaged(u64, src.Header) = .{},
    tips: ?[4]src.Tip = null,
    pub fn deinit(self: *Adapter) void {
        self.headers.deinit(self.allocator);
        self.* = undefined;
    }
    pub fn interface(self: *Adapter) !src.Source {
        if (self.chunk == 0) return error.InvalidScraperChunk;
        for (self.streams, 0..) |stream, index| if (stream == null and !(index == 3 and self.derive_insertions)) return error.UnsupportedScraperStream;
        return .{ .context = self, .header_fn = header, .range_fn = rangeEnd, .events_fn = events, .begin_fn = begin, .tip_fn = indexingTip, .events_after_fn = hasEvents, .tip_counts_fn = tipCounts, .empty_anchor_fn = emptyAnchor, .sequence_mode = self.sequence_mode, .stream_tip_fn = singleTip, .raw_sequence_fn = rawSequence };
    }
    fn cast(context: *anyopaque) *Adapter {
        return @ptrCast(@alignCast(context));
    }
    fn begin(context: *anyopaque) !void {
        const self = cast(context);
        self.headers.clearRetainingCapacity();
        self.tips = null;
    }
    fn latestStreams(self: *Adapter) ![4]src.Tip {
        if (self.tips) |tips| return tips;
        var tips: [4]src.Tip = undefined;
        for (self.streams, 0..) |stream, index| {
            if (index == 3 and self.derive_insertions) {
                tips[3] = tips[0];
                continue;
            }
            const actual = stream orelse return error.UnsupportedScraperStream;
            tips[index] = try actual.tip_fn(actual.context);
        }
        self.tips = tips;
        return tips;
    }
    fn at(self: *Adapter, height: u64, fresh: bool) !src.Header {
        if (!fresh) {
            if (self.headers.get(height)) |cached| return cached;
        }
        const value = try self.provider.header_fn(self.provider.context, height);
        if (value.height != height) return error.WrongScraperHeaderHeight;
        if (self.headers.count() >= self.max_events and !self.headers.contains(height)) return error.ScraperHeaderLimit;
        try self.headers.put(self.allocator, height, value);
        return value;
    }
    fn header(context: *anyopaque, selector: src.Selector, fresh: bool) !src.Header {
        const self = cast(context);
        const height = switch (selector) {
            .height => |height| height,
            .latest => try self.provider.latest_fn(self.provider.context),
            .safe, .finalized => blk: {
                const stream = self.streams[0] orelse return error.UnsupportedScraperStream;
                break :blk (try stream.tip_fn(stream.context)).tip;
            },
        };
        return self.at(height, fresh);
    }
    fn rangeEnd(context: *anyopaque, after: u64, through: u64, head: u64, fresh: bool) !src.Header {
        const self = cast(context);
        if (after >= through or through > head) return error.InvalidScraperRange;
        var height = through;
        var attempts: usize = 0;
        while (height > after) {
            attempts += 1;
            if (attempts > self.max_events) return error.ScraperSparseSearchLimit;
            const value = self.at(height, fresh) catch |err| {
                if (!self.provider.unavailable_fn(err)) return err;
                height -= 1;
                continue;
            };
            return value;
        }
        const limit = @min(head, through +| (through - after));
        height = through;
        while (height < limit) {
            height += 1;
            attempts += 1;
            if (attempts > self.max_events) return error.ScraperSparseSearchLimit;
            const value = self.at(height, fresh) catch |err| {
                if (!self.provider.unavailable_fn(err)) return err;
                continue;
            };
            return value;
        }
        return error.ScraperNoCanonicalBlock;
    }
    fn singleTip(context: *anyopaque, index: usize) !src.Tip {
        const self = cast(context);
        if (index >= 4) return error.InvalidScraperStream;
        const selected = if (index == 3 and self.derive_insertions) 0 else index;
        const stream = self.streams[selected] orelse return error.UnsupportedScraperStream;
        return stream.tip_fn(stream.context);
    }
    fn rawSequence(context: *anyopaque, allocator: std.mem.Allocator, index: usize, from: u32, through: u32) !src.Batch {
        const self = cast(context);
        if (!self.sequence_mode or index >= 4) return error.UnsupportedRawSequenceSource;
        const selected = if (index == 3 and self.derive_insertions) 0 else index;
        const stream = self.streams[selected] orelse return error.UnsupportedScraperStream;
        var batch = try stream.fetch_fn(stream.context, allocator, from, through);
        errdefer batch.deinit();
        for (batch.events) |*event| {
            if (streamIndex(event.*) != selected) return error.WrongScraperStream;
            event.address = switch (index) {
                0, 1 => self.contracts.mailbox,
                2 => self.contracts.paymaster,
                3 => self.contracts.hook,
                else => unreachable,
            };
            if (index == 3 and self.derive_insertions) event.data = .{ .insertion = .{ .message_id = event.data.dispatch.id(), .index = event.data.dispatch.nonce } };
        }
        return batch;
    }
    fn indexingTip(context: *anyopaque) !?u64 {
        const tips = try cast(context).latestStreams();
        var tip: u64 = std.math.maxInt(u64);
        for (tips) |stream| tip = @min(tip, stream.tip);
        return tip;
    }
    fn hasEvents(context: *anyopaque, sequences: [4]u32) !?bool {
        const self = cast(context);
        if (!self.sequence_mode) return null;
        const tips = try self.latestStreams();
        var has = false;
        for (tips, sequences) |tip, next| {
            const count = tip.count orelse return error.MissingScraperSequenceCount;
            if (count < next) return error.ScraperProviderCountBehind;
            has = has or count > next;
        }
        return has;
    }
    fn tipCounts(context: *anyopaque) !?[4]src.Tip {
        const self = cast(context);
        if (self.sequence_mode) return null;
        const tips = try self.latestStreams();
        for (tips) |tip| if (tip.count != null) return tips;
        return null;
    }
    fn emptyAnchor(context: *anyopaque) !?src.Header {
        const self = cast(context);
        const tips = try self.latestStreams();
        var height: u64 = std.math.maxInt(u64);
        for (tips) |tip| {
            if (tip.count != 0) return null;
            height = @min(height, tip.tip);
        }
        return try self.at(height, false);
    }
    const Part = struct { events: []src.Event, through: u64 };
    fn fetch(self: *Adapter, a: std.mem.Allocator, index: usize, tip: src.Tip, from: u32, through: u32, next: u32, budget: *usize) !Part {
        if (tip.tip < through) return error.ScraperStreamTipBehind;
        const stream = self.streams[index] orelse return error.UnsupportedScraperStream;
        var list: std.ArrayList(src.Event) = .empty;
        if (!self.sequence_mode) {
            var batch = try stream.fetch_fn(stream.context, a, from, through);
            defer batch.deinit();
            try copyEvents(a, &list, batch.events, self.max_events, budget, self.max_batch_bytes);
            return .{ .events = try list.toOwnedSlice(a), .through = through };
        }
        const count = tip.count orelse return error.MissingScraperSequenceCount;
        if (count < next) return error.ScraperProviderCountBehind;
        if (count == next) return .{ .events = try a.alloc(src.Event, 0), .through = @min(tip.tip, through) };
        var start = next;
        var previous_block: ?u64 = null;
        var first_block: ?u64 = null;
        while (start < count) {
            const end = @min(count - 1, start +| self.chunk -| 1);
            var batch = try stream.fetch_fn(stream.context, a, start, end);
            defer batch.deinit();
            std.mem.sort(src.Event, batch.events, {}, struct {
                fn less(_: void, x: src.Event, y: src.Event) bool {
                    return sequence(x) < sequence(y);
                }
            }.less);
            var expected = start;
            for (batch.events) |event| {
                if (sequence(event) != expected) return error.ScraperIncompleteSequencePage;
                if (previous_block) |previous| if (previous > event.block_number) return error.ScraperUnorderedSequenceBlocks;
                previous_block = event.block_number;
                expected = try std.math.add(u32, expected, 1);
            }
            if (expected != end + 1 or batch.events.len == 0) return error.ScraperIncompleteSequencePage;
            const first = batch.events[0].block_number;
            const last = batch.events[batch.events.len - 1].block_number;
            if (first_block == null) first_block = first;
            try copyEvents(a, &list, batch.events, self.max_events, budget, self.max_batch_bytes);
            start = try std.math.add(u32, end, 1);
            if (last > through or start == count) return .{ .events = try list.toOwnedSlice(a), .through = @min(tip.tip, through) };
            if (last > first_block.?) return .{ .events = try list.toOwnedSlice(a), .through = @min(last - 1, through) };
        }
        return error.ScraperBatchNoProgress;
    }
    fn events(context: *anyopaque, allocator: std.mem.Allocator, from: u64, through: u64, sequences: [4]u32) !src.Batch {
        const self = cast(context);
        if (from > through or through > std.math.maxInt(u32)) return error.InvalidScraperRange;
        if (self.derive_insertions and sequences[0] != sequences[3]) return error.ScraperDerivedInsertionDiverged;
        const tips = try self.latestStreams();
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var parts: [4]Part = undefined;
        var budget: usize = 0;
        for (&parts, 0..) |*part, index| {
            if (index == 3 and self.derive_insertions) {
                part.* = .{ .events = try a.alloc(src.Event, 0), .through = parts[0].through };
                continue;
            }
            part.* = try self.fetch(a, index, tips[index], @intCast(from), @intCast(through), sequences[index], &budget);
        }
        var covered = through;
        for (parts) |part| covered = @min(covered, part.through);
        var all: std.ArrayList(src.Event) = .empty;
        for (parts, 0..) |part, index| for (part.events) |original| {
            var event = original;
            if (streamIndex(event) != index) return error.WrongScraperStream;
            event.address = switch (index) {
                0, 1 => self.contracts.mailbox,
                2 => self.contracts.paymaster,
                3 => self.contracts.hook,
                else => unreachable,
            };
            if (event.block_number > covered) continue;
            try all.append(a, event);
            if (index == 0 and self.derive_insertions) {
                var insertion = event;
                insertion.address = self.contracts.hook;
                insertion.data = .{ .insertion = .{ .message_id = event.data.dispatch.id(), .index = event.data.dispatch.nonce } };
                try all.append(a, insertion);
            }
            if (all.items.len > self.max_events) return error.ScraperEventLimit;
        };
        std.mem.sort(src.Event, all.items, {}, less);
        var seen = std.AutoHashMap(src.Hash, void).init(a);
        var count: usize = 0;
        for (all.items) |event| {
            const key = fingerprint(event);
            const entry = try seen.getOrPut(key);
            if (entry.found_existing) continue;
            all.items[count] = event;
            count += 1;
        }
        all.shrinkRetainingCapacity(count);
        const owned_events = try all.toOwnedSlice(a);
        return .{ .arena = arena, .events = owned_events, .through = covered };
    }
};
fn copyEvents(a: std.mem.Allocator, list: *std.ArrayList(src.Event), events: []const src.Event, limit: usize, budget: *usize, max_bytes: usize) !void {
    if (events.len > limit - list.items.len) return error.ScraperEventLimit;
    for (events) |original| {
        const size = try std.math.add(usize, @sizeOf(src.Event), if (original.data == .dispatch) original.data.dispatch.body.len else 0);
        if (size > max_bytes -| budget.*) return error.ScraperEventByteLimit;
        budget.* += size;
        var event = original;
        if (event.data == .dispatch) event.data.dispatch.body = try a.dupe(u8, event.data.dispatch.body);
        try list.append(a, event);
    }
}
fn streamIndex(event: src.Event) usize {
    return switch (event.data) {
        .dispatch => 0,
        .delivery => 1,
        .gas => 2,
        .insertion => 3,
    };
}
fn sequence(event: src.Event) u32 {
    return event.sequence orelse switch (event.data) {
        .dispatch => |message| message.nonce,
        .insertion => |insert| insert.index,
        else => std.math.maxInt(u32),
    };
}
fn id(event: src.Event) src.Hash {
    return switch (event.data) {
        .dispatch => |message| message.id(),
        .delivery => |hash| hash,
        .gas => |gas| gas.message_id,
        .insertion => |insert| insert.message_id,
    };
}
fn less(_: void, x: src.Event, y: src.Event) bool {
    if (x.block_number != y.block_number) return x.block_number < y.block_number;
    const xs = streamIndex(x);
    const ys = streamIndex(y);
    if (xs != ys) return xs < ys;
    if (sequence(x) != sequence(y)) return sequence(x) < sequence(y);
    if (x.tx_index != y.tx_index) return x.tx_index < y.tx_index;
    if (x.log_index != y.log_index) return x.log_index < y.log_index;
    return std.mem.order(u8, &id(x), &id(y)) == .lt;
}
pub fn fingerprint(event: src.Event) src.Hash {
    var hasher = std.crypto.hash.sha3.Keccak256.init(.{});
    var buffer: [32]u8 = undefined;
    inline for (.{ event.block_number, event.tx_index, event.log_index }) |number| {
        std.mem.writeInt(u64, buffer[0..8], number, .big);
        hasher.update(buffer[0..8]);
    }
    hasher.update(&event.block_hash);
    hasher.update(&event.address);
    hasher.update(&.{@intFromBool(event.tx_hash != null)});
    if (event.tx_hash) |tx| hasher.update(&tx);
    hasher.update(&.{ @intFromBool(event.sequence != null), @intCast(streamIndex(event)) });
    std.mem.writeInt(u32, buffer[0..4], sequence(event), .big);
    hasher.update(buffer[0..4]);
    hasher.update(&id(event));
    if (event.data == .gas) {
        std.mem.writeInt(u32, buffer[0..4], event.data.gas.destination, .big);
        hasher.update(buffer[0..4]);
        std.mem.writeInt(u256, &buffer, event.data.gas.gas, .big);
        hasher.update(&buffer);
        std.mem.writeInt(u256, &buffer, event.data.gas.payment, .big);
        hasher.update(&buffer);
    }
    var result: src.Hash = undefined;
    hasher.final(&result);
    return result;
}
