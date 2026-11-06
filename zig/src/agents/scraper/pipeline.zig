//! Source-backed near-head observe -> complete range -> publish protocol. All
//! writes go through one Store writer identity; RPC reads recheck fork boundaries.
const std = @import("std");
const src = @import("source.zig");
const db = @import("../../db/scraper_store.zig");
pub const State = db.State;
pub const CountCache = struct { boundary: ?struct { hash: src.Hash, counts: [4]u32 } = null, proven_through: ?u64 = null };
pub fn equal(a: src.Hash, b: src.Hash) bool {
    return std.mem.eql(u8, &a, &b);
}
fn state(store: anytype) !State {
    return try store.state() orelse error.MissingScraperHead;
}
pub fn observe(source: src.Source, store: anytype) !State {
    const current = try state(store);
    if (current.halted) return error.ScraperPublishedReorg;
    const head = try source.header(.latest);
    if (head.height < current.indexed) {
        try store.pause(false);
        return error.ScraperRpcBehind;
    }
    var height = try store.checkpoint(@min(current.indexed, head.height));
    const ancestor = while (true) {
        const header = if (height == head.height) head else try source.header(.{ .height = height });
        const stored = try store.hash(height);
        if (stored != null and equal(stored.?, header.hash)) break header;
        try store.pause(height == current.confirmed);
        if (height <= current.confirmed) return error.ScraperPublishedReorg;
        height = try store.checkpoint(try std.math.sub(u64, height, 1));
    };
    if (!equal(ancestor.hash, head.hash)) try verify(source, head);
    try store.observe(current, ancestor, head);
    return state(store);
}
pub fn advanceSequences(events: []const src.Event, start: [4]u32) ![4]u32 {
    var next = start;
    for (events) |event| {
        const stream: usize = switch (event.data) {
            .dispatch => 0,
            .delivery => 1,
            .gas => 2,
            .insertion => 3,
        };
        const index: ?u32 = switch (event.data) {
            .dispatch => |message| message.nonce,
            .insertion => |insert| insert.index,
            else => event.sequence,
        };
        if (index) |value| {
            if (value != next[stream]) return error.ScraperSequenceGap;
            next[stream] = try std.math.add(u32, value, 1);
        }
    }
    return next;
}
pub fn verify(source: src.Source, header: src.Header) !void {
    if (!equal((try source.freshHeader(.{ .height = header.height })).hash, header.hash)) return error.ScraperForkChanged;
}
pub fn ingest(allocator: std.mem.Allocator, source: src.Source, store: anytype, current: State, chunk: u64, cache: *CountCache) !bool {
    if (chunk == 0) return error.InvalidScraperChunk;
    if (current.indexed == current.head) return false;
    const available = @min((try source.indexingTip()) orelse current.head, current.head);
    if (available <= current.indexed) return false;
    const start = if (cache.boundary) |boundary| if (equal(boundary.hash, current.hash)) boundary.counts else try store.sequenceCounts() else try store.sequenceCounts();
    cache.boundary = .{ .hash = current.hash, .counts = start };
    const requested = if (source.sequence_mode) available else @min(available, current.indexed +| chunk);
    if (try source.hasEventsAfter(start) == false) {
        const boundary = try source.rangeEnd(current.indexed, requested, available, false);
        if (!equal((try source.freshHeader(.{ .height = current.indexed })).hash, current.hash)) return error.ScraperForkChanged;
        try verify(source, boundary);
        try store.append(current, &.{.{ .header = boundary, .events = &.{} }});
        cache.boundary = .{ .hash = boundary.hash, .counts = start };
        return boundary.height < current.head;
    }
    var boundary = try source.rangeEnd(current.indexed, requested, available, false);
    var end = boundary.height;
    const end_counts = source.counts(boundary.hash) catch null; // unavailable historical state stays provisional
    var batch = try source.events(allocator, current.indexed +| 1, end, start);
    defer batch.deinit();
    if (end_counts == null) for (batch.events) |event| {
        if (event.block_number <= current.confirmed) return error.ScraperCrossedConfirmed;
    };
    if (batch.through <= current.indexed or batch.through > end) return error.ScraperBatchNoProgress;
    if (batch.through < end) {
        boundary = try source.rangeEnd(current.indexed, batch.through, available, false);
        end = boundary.height;
    }
    const advanced = advanceSequences(batch.events, start) catch |err| {
        if (current.indexed > current.confirmed) try store.rewindToConfirmed(current);
        cache.boundary = null;
        return err;
    };
    if (end_counts) |expected| {
        if (advanced[0] != expected[0] or advanced[3] != expected[1]) {
            if ((cache.proven_through orelse current.confirmed) < current.indexed and current.indexed > current.confirmed) {
                try store.rewindToConfirmed(current);
                cache.boundary = null;
            }
            return error.ScraperIncompleteRange;
        }
    }
    // Group sparse event blocks. Empty boundary blocks still advance checkpoints.
    std.mem.sort(src.Event, batch.events, {}, lessEvent);
    var blocks: std.ArrayList(src.Block) = .empty;
    defer blocks.deinit(allocator);
    var offset: usize = 0;
    while (offset < batch.events.len) {
        const height = batch.events[offset].block_number;
        if (height <= current.indexed or height > end) return error.ScraperEventOutsideRange;
        var limit = offset + 1;
        while (limit < batch.events.len and batch.events[limit].block_number == height) limit += 1;
        const header = if (height == end) boundary else try source.header(.{ .height = height });
        for (batch.events[offset..limit]) |*event| {
            if (!std.mem.allEqual(u8, &event.block_hash, 0) and !equal(event.block_hash, header.hash)) return error.ScraperLogForkMismatch;
            event.block_hash = header.hash;
        }
        try blocks.append(allocator, .{ .header = header, .events = batch.events[offset..limit] });
        offset = limit;
    }
    if (blocks.items.len == 0 or blocks.items[blocks.items.len - 1].header.height != end) try blocks.append(allocator, .{ .header = boundary, .events = &.{} });
    if (!equal((try source.freshHeader(.{ .height = current.indexed })).hash, current.hash)) return error.ScraperForkChanged;
    try verify(source, boundary);
    try store.append(current, blocks.items);
    cache.boundary = .{ .hash = boundary.hash, .counts = advanced };
    if (end_counts != null) cache.proven_through = end;
    return end < current.head;
}
fn lessEvent(_: void, a: src.Event, b: src.Event) bool {
    if (a.block_number != b.block_number) return a.block_number < b.block_number;
    if (a.tx_index != b.tx_index) return a.tx_index < b.tx_index;
    return a.log_index < b.log_index;
}
pub const Confirmation = struct { counts: [4]u64 = .{0} ** 4, page_limited: bool = false };
pub fn confirmationLease(poll_ms: u64) f64 {
    return @floatFromInt(@max(60000, poll_ms *| 2) / 1000);
}
pub fn confirm(source: src.Source, store: anytype, period: src.Period, lease_seconds: f64, publishable: u64) !Confirmation {
    const current = try state(store);
    if (current.halted) return error.ScraperPublishedReorg;
    if (current.indexed == current.confirmed or publishable <= current.confirmed) return .{};
    const tagged: ?src.Header = switch (period) {
        .safe => try source.header(.safe),
        .finalized => try source.header(.finalized),
        else => null,
    };
    const through = @min(switch (period) {
        .blocks => |depth| current.head -| depth,
        else => if (tagged) |header| header.height else current.head,
    }, current.head);
    if (through <= current.confirmed) return .{};
    const target = @min(@min(through, current.indexed), publishable);
    const page = try store.confirmationBoundary(current.confirmed, target);
    if (page <= current.confirmed) return .{};
    const checkpoint = try store.checkpointBetween(current.confirmed, page);
    const boundary = if (tagged != null and tagged.?.height == page) tagged.? else try source.rangeEnd(if (checkpoint) |height| height -| 1 else current.confirmed, page, page, true);
    if (try store.hash(boundary.height)) |stored| if (!equal(stored, boundary.hash)) return error.ScraperConfirmationForkMismatch;
    if (!equal((try source.freshHeader(.{ .height = current.indexed })).hash, current.hash)) return error.ScraperForkChanged;
    return .{ .counts = try store.confirm(current, boundary, lease_seconds), .page_limited = boundary.height < target };
}
