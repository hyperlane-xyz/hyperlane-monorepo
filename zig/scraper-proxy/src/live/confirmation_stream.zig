//! Port of `confirmation-stream.ts`: one paginated reader per stream, with
//! rollback detection (agent and validator streams; TS #10078 moved /messages
//! to `message_source.zig`).
//!
//! Every method requires the loop mutex. `schedule()` runs the drain's
//! synchronous prefix inline (range reservation / refresh-id selection), like
//! the TS `void this.drain()`, then continues on a pool task.
const std = @import("std");
const runtime = @import("runtime.zig");
const protocol = @import("protocol.zig");
const Loop = runtime.Loop;

/// Height, source, row ID. Source distinguishes Explorer's three event tables.
pub const Position = struct {
    height: i128,
    source: u8,
    id: i128,

    pub fn order(a: Position, b: Position) std.math.Order {
        if (a.height != b.height) return std.math.order(a.height, b.height);
        if (a.source != b.source) return std.math.order(a.source, b.source);
        return std.math.order(a.id, b.id);
    }
};

pub const END_OF_HEIGHT: i128 = 9_223_372_036_854_775_807;

pub fn endOfHeight(height: i128) Position {
    return .{ .height = height, .source = 3, .id = END_OF_HEIGHT };
}

pub const ConfirmationHead = struct {
    head: i128,
    indexed: i128,
    confirmed: i128,
    /// Custom agent streams: the checkpoint the stream starts after.
    live_start: ?protocol.LiveStartBoundary = null,
};
pub const Heads = std.AutoArrayHashMapUnmanaged(u32, ConfirmationHead);

pub fn confirmationHeight(head: i128, indexed: i128, confirmations: u64) i128 {
    const height = head - @as(i128, confirmations);
    return if (height < indexed) height else indexed;
}

/// A serialized frame.
pub const Message = struct {
    frame: []const u8,
};

pub const Row = struct {
    position: Position,
    message: Message,
};

/// Paginated row source (`AsyncIterable<ConfirmationRow>`). A row stays valid
/// until the next `next()` or `deinit()`. Both run with the mutex held and may
/// release it while blocking.
pub const Reader = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        next: *const fn (ptr: *anyopaque) anyerror!?Row,
        deinit: *const fn (ptr: *anyopaque) void,
    };

    pub fn next(self: Reader) anyerror!?Row {
        return self.vtable.next(self.ptr);
    }

    pub fn deinit(self: Reader) void {
        self.vtable.deinit(self.ptr);
    }
};

pub const Io = struct {
    ctx: *anyopaque,
    active: *const fn (ctx: *anyopaque) bool,
    read: *const fn (ctx: *anyopaque, domain: u32, after: Position, through: i128) anyerror!Reader,
    /// `await send(message)`: blocks (releasing the mutex) until written.
    send: *const fn (ctx: *anyopaque, message: Message) bool,
    rollback: *const fn (ctx: *anyopaque, domain: u32, from: i128, to: i128) void,
    fail: *const fn (ctx: *anyopaque, err: anyerror) void,
    /// Called once when the stream is freed.
    deinit: ?*const fn (ctx: *anyopaque) void = null,
};

const DomainState = struct {
    live_start: ?protocol.LiveStartBoundary = null,
    position: Position,
    target: i128,
    through: i128,

    fn needsRead(self: DomainState) bool {
        return self.target > self.position.height or
            (self.target == self.position.height and self.position.source < 3);
    }
};

const Step = struct { domain: u32, after: Position, through: i128, revision: u64 };

pub const ConfirmationStream = struct {
    allocator: std.mem.Allocator,
    loop: *Loop,
    confirmations: u64,
    domains: []const u32,
    io: Io,
    states: std.AutoArrayHashMapUnmanaged(u32, DomainState) = .empty,
    revision: u64 = 0,
    running: bool = false,
    started: bool = false,
    /// Owner reference plus one per running task; freed at zero.
    refs: usize = 1,
    /// Set when `initialize` fails with `error.ConfirmationUnavailable`.
    unavailable_domain: u32 = 0,

    pub fn create(allocator: std.mem.Allocator, loop: *Loop, confirmations: u64, domains: []const u32, io: Io) !*ConfirmationStream {
        const self = try allocator.create(ConfirmationStream);
        errdefer allocator.destroy(self);
        self.* = .{
            .allocator = allocator,
            .loop = loop,
            .confirmations = confirmations,
            .domains = try allocator.dupe(u32, domains),
            .io = io,
        };
        return self;
    }

    pub fn retain(self: *ConfirmationStream) void {
        self.refs += 1;
    }

    pub fn release(self: *ConfirmationStream) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        const allocator = self.allocator;
        if (self.io.deinit) |deinit| deinit(self.io.ctx);
        self.states.deinit(allocator);
        allocator.free(self.domains);
        allocator.destroy(self);
    }

    pub const ReadHeads = struct {
        ctx: *anyopaque,
        /// Blocking read; returns heads allocated with `allocator`.
        read: *const fn (ctx: *anyopaque, allocator: std.mem.Allocator) anyerror!Heads,
    };

    /// Notifications can arrive during negotiation. Retry the snapshot, before
    /// sending ready/subscribed, if its ancestry may already have changed.
    pub fn initialize(self: *ConfirmationStream, read_heads: ReadHeads, allow_canonical: bool) !void {
        while (self.initializeRead()) |revision| {
            var heads = try read_heads.read(read_heads.ctx, self.allocator);
            defer heads.deinit(self.allocator);
            if (try self.initializeWith(revision, &heads, allow_canonical)) return;
        }
    }

    /// `initialize`'s loop head: the revision to read heads at, or null once
    /// the stream is inactive (`initialize` returns).
    pub fn initializeRead(self: *ConfirmationStream) ?u64 {
        if (!self.io.active(self.io.ctx)) return null;
        return self.revision;
    }

    /// `initialize` after its read resolved with `heads`: false when the
    /// ancestry changed meanwhile (read again).
    pub fn initializeWith(self: *ConfirmationStream, revision: u64, heads: *const Heads, allow_canonical: bool) !bool {
        if (revision != self.revision) return false;
        for (self.domains) |domain| {
            const head = heads.get(domain) orelse {
                if (allow_canonical) continue;
                self.unavailable_domain = domain;
                return error.ConfirmationUnavailable;
            };
            const target = confirmationHeight(head.head, head.indexed, self.confirmations);
            // `BigInt(liveStart.height)`: at most 20 digits, within i128.
            const height = if (head.live_start) |boundary| std.fmt.parseInt(i128, boundary.height(), 10) catch unreachable else target;
            try self.states.put(self.allocator, domain, .{
                .live_start = head.live_start,
                .position = endOfHeight(height),
                .target = target,
                .through = height,
            });
        }
        return true;
    }

    /// `liveStart(domain)`.
    pub fn liveStart(self: *const ConfirmationStream, domain: u32) ?protocol.LiveStartBoundary {
        const state = self.states.getPtr(domain) orelse return null;
        return state.live_start;
    }

    pub fn isCustom(self: *const ConfirmationStream, domain: u32) bool {
        return self.states.contains(domain);
    }

    pub fn start(self: *ConfirmationStream) void {
        self.started = true;
        self.schedule();
    }

    pub fn notify(self: *ConfirmationStream, head: protocol.HeadNotification) void {
        if (std.mem.indexOfScalar(u32, self.domains, head.domain) == null) return;
        const head_height = head.head_height orelse return;
        const indexed_height = head.indexed_height orelse return;
        const rollback = if (head.previous_indexed_height) |previous| indexed_height < previous else false;
        const state = self.states.getPtr(head.domain) orelse {
            // Capabilities are fixed until reconnect. During negotiation, retry the
            // snapshot only if ancestry changed; afterwards this domain stays canonical.
            if (!self.started and rollback) self.revision += 1;
            return;
        };
        const to = confirmationHeight(head_height, indexed_height, self.confirmations);
        state.target = to;
        if (rollback) {
            self.revision += 1;
            // Never authorize handoff using a snapshot from before a rollback.
            state.live_start = null;
            // through is reserved BEFORE reading/sending a range. It covers partial
            // pages, events without a public height, and pending send callbacks.
            const exposed_rollback = self.started and state.through > to;
            if (exposed_rollback) self.io.rollback(self.io.ctx, head.domain, state.through, to);
            state.through = to;
            if (state.position.height > to) state.position = endOfHeight(to);
        }
        self.schedule();
    }

    fn schedule(self: *ConfirmationStream) void {
        if (!self.started or self.running or !self.io.active(self.io.ctx)) return;
        self.running = true;
        const step = self.prepare() orelse return self.finish();
        self.retain();
        self.loop.spawn(runTask, .{ self, step });
    }

    fn runTask(self: *ConfirmationStream, first: Step) void {
        defer self.release();
        var step: ?Step = first;
        while (step) |current| {
            const proceed = self.execute(current) catch |err| {
                self.started = false;
                self.io.fail(self.io.ctx, err);
                break;
            };
            if (!proceed) break;
            step = self.prepare();
        }
        self.finish();
    }

    fn finish(self: *ConfirmationStream) void {
        self.running = false;
        if (self.anyNeedsRead()) self.schedule();
    }

    fn anyNeedsRead(self: *const ConfirmationStream) bool {
        for (self.states.values()) |state| if (state.needsRead()) return true;
        return false;
    }

    /// The synchronous part of one drain iteration, up to its first await.
    fn prepare(self: *ConfirmationStream) ?Step {
        if (!self.io.active(self.io.ctx)) return null;
        for (self.states.keys(), self.states.values()) |domain, *state| {
            if (!state.needsRead()) continue;
            const through = state.target;
            if (through > state.through) state.through = through;
            return .{ .domain = domain, .after = state.position, .through = through, .revision = self.revision };
        }
        return null;
    }

    /// Returns false when the drain must stop (inactive or send failed).
    fn execute(self: *ConfirmationStream, read: Step) !bool {
        const domain = read.domain;
        const reader = try self.io.read(self.io.ctx, domain, read.after, read.through);
        defer reader.deinit();
        while (try reader.next()) |row| {
            if (!self.io.active(self.io.ctx)) return false;
            if (read.revision != self.revision) break;
            self.states.getPtr(domain).?.position = row.position;
            if (!self.io.send(self.io.ctx, row.message)) {
                self.started = false;
                return false;
            }
        }
        if (read.revision == self.revision) self.states.getPtr(domain).?.position = endOfHeight(read.through);
        return true;
    }
};
