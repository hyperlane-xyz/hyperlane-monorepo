const std = @import("std");
const db = @import("../../db/scraper_store.zig");
pub const Hash = [32]u8;
pub const Header = db.Header;
pub const Event = db.Event;
pub const EventData = db.EventData;
pub const Block = db.Block;
pub const Contracts = db.Contracts;
/// Actual protocol emitters and position namespace for transaction events.
/// EVM keeps global log indices; Aleo mapping counters are per emitter/stream.
pub const TransactionAuthority = struct {
    emitters: Contracts,
    positions: enum { global_log_index, per_emitter_stream } = .global_log_index,
};
pub const Selector = union(enum) { height: u64, latest, safe, finalized };
pub const Period = union(enum) { blocks: u32, latest, safe, finalized };
pub const Tip = struct { count: ?u32, tip: u64 };
pub const Reservation = struct { context: *anyopaque, reserve_fn: *const fn (*anyopaque, usize) anyerror!void, release_fn: *const fn (*anyopaque, usize) void };
pub const ReadSection = struct { context: *anyopaque, commit_fn: *const fn (*anyopaque) anyerror!void, reservation: ?Reservation = null };
pub const Batch = struct {
    arena: std.heap.ArenaAllocator,
    events: []Event,
    through: u64,
    reservation: ?struct { owner: Reservation, bytes: usize } = null,
    pub fn deinit(self: *Batch) void {
        self.arena.deinit();
        if (self.reservation) |lease| lease.owner.release_fn(lease.owner.context, lease.bytes);
        self.* = undefined;
    }
};
pub const Source = struct {
    read_section: ?ReadSection = null,
    context: *anyopaque,
    header_fn: *const fn (*anyopaque, Selector, bool) anyerror!Header,
    events_fn: *const fn (*anyopaque, std.mem.Allocator, u64, u64, [4]u32) anyerror!Batch,
    range_fn: ?*const fn (*anyopaque, u64, u64, u64, bool) anyerror!Header = null,
    begin_fn: ?*const fn (*anyopaque) anyerror!void = null,
    counts_fn: ?*const fn (*anyopaque, Hash) anyerror!?[2]u32 = null,
    tip_fn: ?*const fn (*anyopaque) anyerror!?u64 = null,
    events_after_fn: ?*const fn (*anyopaque, [4]u32) anyerror!?bool = null,
    tip_counts_fn: ?*const fn (*anyopaque) anyerror!?[4]Tip = null,
    empty_anchor_fn: ?*const fn (*anyopaque) anyerror!?Header = null,
    stream_tip_fn: ?*const fn (*anyopaque, usize) anyerror!Tip = null,
    raw_sequence_fn: ?*const fn (*anyopaque, std.mem.Allocator, usize, u32, u32) anyerror!Batch = null,
    transaction_fn: ?*const fn (*anyopaque, std.mem.Allocator, [64]u8) anyerror!Batch = null,
    transaction_authority_fn: ?*const fn (*anyopaque) anyerror!TransactionAuthority = null,
    cancel_fn: ?*const fn (*anyopaque, ?*const std.atomic.Value(bool)) void = null,
    historical_counts: bool = false,
    sequence_mode: bool = false,
    /// Relayer cursor view: selected stream only where the protocol exposes it.
    /// Sequence account adapters must authenticate owner/PDA/domain before data.
    pub fn streamTip(self: Source, index: usize) !Tip {
        if (index >= 4) return error.InvalidScraperStream;
        if (self.stream_tip_fn) |call| return call(self.context, index);
        if (try self.tipCounts()) |tips| return tips[index];
        const latest = try self.header(.latest);
        const height = @min((try self.indexingTip()) orelse latest.height, latest.height);
        const header_ = if (height == latest.height) latest else try self.header(.{ .height = height });
        const counts_ = try self.counts(header_.hash);
        return .{ .tip = height, .count = if (counts_) |values| switch (index) {
            0 => values[0],
            3 => values[1],
            else => null,
        } else null };
    }
    pub fn transactionAuthority(self: Source, fallback: Contracts) !TransactionAuthority {
        if (self.transaction_authority_fn) |call| return call(self.context);
        return .{ .emitters = fallback };
    }
    /// Optional Source tx-ID companion capability. Unsupported protocols keep
    /// Rust's empty-result behavior and never acquire a new receipt requirement.
    pub fn transactionEvents(self: Source, allocator: std.mem.Allocator, transaction: [64]u8) !Batch {
        if (self.transaction_fn) |call| return call(self.context, allocator, transaction);
        return .{ .arena = std.heap.ArenaAllocator.init(allocator), .events = &.{}, .through = 0 };
    }
    pub fn rawSequence(self: Source, allocator: std.mem.Allocator, stream: usize, from: u32, through: u32) !Batch {
        if (!self.sequence_mode or stream >= 4 or from > through) return error.InvalidScraperSequenceRange;
        const call = self.raw_sequence_fn orelse return error.UnsupportedRawSequenceSource;
        return call(self.context, allocator, stream, from, through);
    }
    pub fn bindCancellation(self: Source, cancel: ?*const std.atomic.Value(bool)) void {
        if (self.cancel_fn) |call| call(self.context, cancel);
    }
    pub fn commitReadSection(self: Source) !void {
        if (self.read_section) |section| try section.commit_fn(section.context);
    }
    pub fn beginCycle(self: Source) !void {
        if (self.begin_fn) |call| try call(self.context);
    }
    pub fn header(self: Source, selector: Selector) !Header {
        return self.header_fn(self.context, selector, false);
    }
    pub fn freshHeader(self: Source, selector: Selector) !Header {
        return self.header_fn(self.context, selector, true);
    }
    pub fn rangeEnd(self: Source, after: u64, through: u64, head: u64, fresh: bool) !Header {
        if (after >= through or through > head) return error.InvalidScraperRange;
        const result = if (self.range_fn) |call| try call(self.context, after, through, head, fresh) else try self.header_fn(self.context, .{ .height = through }, fresh);
        if (result.height <= after or result.height > head) return error.InvalidScraperBoundary;
        return result;
    }
    pub fn events(self: Source, allocator: std.mem.Allocator, from: u64, through: u64, sequences: [4]u32) !Batch {
        if (from > through) return error.InvalidScraperRange;
        return self.events_fn(self.context, allocator, from, through, sequences);
    }
    pub fn counts(self: Source, hash: Hash) !?[2]u32 {
        return if (self.counts_fn) |call| try call(self.context, hash) else null;
    }
    pub fn indexingTip(self: Source) !?u64 {
        return if (self.tip_fn) |call| try call(self.context) else null;
    }
    pub fn hasEventsAfter(self: Source, sequences: [4]u32) !?bool {
        return if (self.events_after_fn) |call| try call(self.context, sequences) else null;
    }
    pub fn emptyAnchor(self: Source) !?Header {
        return if (self.empty_anchor_fn) |call| try call(self.context) else null;
    }
    pub fn tipCounts(self: Source) !?[4]Tip {
        return if (self.tip_counts_fn) |call| try call(self.context) else null;
    }
};
