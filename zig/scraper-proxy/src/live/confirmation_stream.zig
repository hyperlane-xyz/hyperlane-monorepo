//! Port of `confirmation-stream.ts`: one paginated reader per stream, with
//! rollback detection and Explorer provisional-message refreshes.
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
pub const MAX_CUSTOM_MESSAGE_IDS = 10_000;

pub fn endOfHeight(height: i128) Position {
    return .{ .height = height, .source = 3, .id = END_OF_HEIGHT };
}

pub const ConfirmationHead = struct { head: i128, indexed: i128, confirmed: i128 };
pub const Heads = std.AutoArrayHashMapUnmanaged(u32, ConfirmationHead);
/// Domain → exposed height, in JS Map insertion order.
pub const Frontiers = std.AutoArrayHashMapUnmanaged(u32, i128);

pub fn confirmationHeight(head: i128, indexed: i128, confirmations: u64) i128 {
    const height = head - @as(i128, confirmations);
    return if (height < indexed) height else indexed;
}

/// A serialized frame plus the Explorer message id it carries, if any.
pub const Message = struct {
    frame: []const u8,
    message_id: ?[]const u8 = null,
};

pub const Row = struct {
    domains: ?[]const u32 = null,
    position: Position,
    message: ?Message = null,
};

pub const Enriched = struct {
    domains: ?[]const u32 = null,
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

pub const EnrichResult = struct {
    arena: std.heap.ArenaAllocator,
    messages: []const Enriched,

    pub fn deinit(self: *EnrichResult) void {
        self.arena.deinit();
    }
};

pub const Io = struct {
    ctx: *anyopaque,
    active: *const fn (ctx: *anyopaque) bool,
    read: *const fn (ctx: *anyopaque, domain: u32, after: Position, through: i128, frontiers: *const Frontiers) anyerror!Reader,
    /// `await send(message)`: blocks (releasing the mutex) until written.
    send: *const fn (ctx: *anyopaque, message: Message) bool,
    rollback: *const fn (ctx: *anyopaque, domain: u32, from: i128, to: i128) void,
    fail: *const fn (ctx: *anyopaque, err: anyerror) void,
    /// Explorer streams only.
    enrich: ?*const fn (ctx: *anyopaque, ids: []const []const u8, frontiers: *const Frontiers) anyerror!EnrichResult = null,
    /// Called once when the stream is freed.
    deinit: ?*const fn (ctx: *anyopaque) void = null,
};

const DomainState = struct {
    position: Position,
    target: i128,
    through: i128,

    fn needsRead(self: DomainState) bool {
        return self.target > self.position.height or
            (self.target == self.position.height and self.position.source < 3);
    }
};

const Step = union(enum) {
    read: struct { domain: u32, after: Position, through: i128, revision: u64, frontiers: Frontiers },
    enrich: struct { ids: [][]const u8, revision: u64, frontiers: Frontiers },
};

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
    refresh_ids: std.StringArrayHashMapUnmanaged(void) = .empty,
    exposed_ids: std.StringArrayHashMapUnmanaged(Frontiers) = .empty,
    confirmed: std.AutoArrayHashMapUnmanaged(u32, i128) = .empty,
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
        for (self.refresh_ids.keys()) |id| allocator.free(id);
        self.refresh_ids.deinit(allocator);
        for (self.exposed_ids.keys(), self.exposed_ids.values()) |id, *frontiers| {
            allocator.free(id);
            frontiers.deinit(allocator);
        }
        self.exposed_ids.deinit(allocator);
        self.confirmed.deinit(allocator);
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
        while (self.io.active(self.io.ctx)) {
            const revision = self.revision;
            var heads = try read_heads.read(read_heads.ctx, self.allocator);
            defer heads.deinit(self.allocator);
            if (revision != self.revision) continue;
            for (self.domains) |domain| {
                const head = heads.get(domain) orelse {
                    if (allow_canonical) continue;
                    self.unavailable_domain = domain;
                    return error.ConfirmationUnavailable;
                };
                const height = confirmationHeight(head.head, head.indexed, self.confirmations);
                try self.confirmed.put(self.allocator, domain, head.confirmed);
                try self.states.put(self.allocator, domain, .{
                    .position = endOfHeight(height),
                    .target = height,
                    .through = height,
                });
            }
            return;
        }
    }

    /// Domains with a provisional reader, in snapshot order.
    pub fn customDomains(self: *const ConfirmationStream) []const u32 {
        return self.states.keys();
    }

    pub fn isCustom(self: *const ConfirmationStream, domain: u32) bool {
        return self.states.contains(domain);
    }

    pub fn start(self: *ConfirmationStream) void {
        self.started = true;
        self.schedule();
    }

    pub fn refresh(self: *ConfirmationStream, ids: []const []const u8) void {
        if (self.io.enrich == null) return;
        for (ids) |id| self.addRefreshId(id);
        if (self.refresh_ids.count() > MAX_CUSTOM_MESSAGE_IDS) {
            self.io.fail(self.io.ctx, error.CustomMessageNotificationLimitExceeded);
            return;
        }
        self.schedule();
    }

    fn addRefreshId(self: *ConfirmationStream, id: []const u8) void {
        if (self.refresh_ids.contains(id)) return;
        const owned = self.allocator.dupe(u8, id) catch @panic("live: out of memory");
        self.refresh_ids.put(self.allocator, owned, {}) catch @panic("live: out of memory");
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
        self.confirmed.put(self.allocator, head.domain, head.confirmed_height) catch @panic("live: out of memory");
        var index: usize = 0;
        while (index < self.exposed_ids.count()) {
            if (self.isCanonical(&self.exposed_ids.values()[index])) {
                const id = self.exposed_ids.keys()[index];
                var frontiers = self.exposed_ids.values()[index];
                self.exposed_ids.orderedRemoveAt(index);
                self.allocator.free(id);
                frontiers.deinit(self.allocator);
            } else index += 1;
        }
        if (rollback) {
            self.revision += 1;
            // through is reserved BEFORE reading/sending a range. It covers partial
            // pages, events without a public height, and pending send callbacks.
            const exposed_rollback = self.started and state.through > to;
            if (exposed_rollback) self.io.rollback(self.io.ctx, head.domain, state.through, to);
            state.through = to;
            if (state.position.height > to) state.position = endOfHeight(to);
            // Explorer clears its entire provisional overlay on any rollback.
            if (exposed_rollback) self.refresh(self.exposed_ids.keys());
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
        if (self.refresh_ids.count() > 0 or self.anyNeedsRead()) self.schedule();
    }

    fn anyNeedsRead(self: *const ConfirmationStream) bool {
        for (self.states.values()) |state| if (state.needsRead()) return true;
        return false;
    }

    fn snapshotFrontiers(self: *const ConfirmationStream) Frontiers {
        var frontiers: Frontiers = .empty;
        for (self.states.keys(), self.states.values()) |domain, state|
            frontiers.put(self.allocator, domain, state.position.height) catch @panic("live: out of memory");
        return frontiers;
    }

    /// The synchronous part of one drain iteration, up to its first await.
    fn prepare(self: *ConfirmationStream) ?Step {
        if (!self.io.active(self.io.ctx)) return null;
        for (self.states.keys(), self.states.values()) |domain, *state| {
            if (!state.needsRead()) continue;
            const through = state.target;
            var frontiers = self.snapshotFrontiers();
            frontiers.put(self.allocator, domain, through) catch @panic("live: out of memory");
            if (through > state.through) state.through = through;
            return .{ .read = .{ .domain = domain, .after = state.position, .through = through, .revision = self.revision, .frontiers = frontiers } };
        }
        if (self.refresh_ids.count() == 0 or self.io.enrich == null) return null;
        const count = @min(self.refresh_ids.count(), 100);
        const ids = self.allocator.alloc([]const u8, count) catch @panic("live: out of memory");
        @memcpy(ids, self.refresh_ids.keys()[0..count]);
        for (0..count) |_| self.refresh_ids.orderedRemoveAt(0);
        return .{ .enrich = .{ .ids = ids, .revision = self.revision, .frontiers = self.snapshotFrontiers() } };
    }

    /// Returns false when the drain must stop (inactive or send failed).
    fn execute(self: *ConfirmationStream, step: Step) !bool {
        switch (step) {
            .read => |read| {
                var frontiers = read.frontiers;
                defer frontiers.deinit(self.allocator);
                const domain = read.domain;
                const reader = try self.io.read(self.io.ctx, domain, read.after, read.through, &frontiers);
                defer reader.deinit();
                while (try reader.next()) |row| {
                    if (!self.io.active(self.io.ctx)) return false;
                    if (read.revision != self.revision) break;
                    self.states.getPtr(domain).?.position = row.position;
                    if (row.message) |message| {
                        self.remember(message, &frontiers, row.domains);
                        if (!self.io.send(self.io.ctx, message)) {
                            self.started = false;
                            return false;
                        }
                    }
                }
                if (read.revision == self.revision) self.states.getPtr(domain).?.position = endOfHeight(read.through);
                return true;
            },
            .enrich => |enrich| {
                var frontiers = enrich.frontiers;
                defer frontiers.deinit(self.allocator);
                defer {
                    for (enrich.ids) |id| self.allocator.free(id);
                    self.allocator.free(enrich.ids);
                }
                var result = try self.io.enrich.?(self.io.ctx, enrich.ids, &frontiers);
                defer result.deinit();
                for (result.messages) |message| {
                    if (!self.io.active(self.io.ctx)) return false;
                    if (enrich.revision != self.revision) break;
                    self.remember(message.message, &frontiers, message.domains);
                    if (!self.io.send(self.io.ctx, message.message)) {
                        self.started = false;
                        return false;
                    }
                }
                if (enrich.revision != self.revision) for (enrich.ids) |id| self.addRefreshId(id);
                return true;
            },
        }
    }

    fn isCanonical(self: *const ConfirmationStream, frontiers: *const Frontiers) bool {
        for (frontiers.keys(), frontiers.values()) |domain, height| {
            if (height > (self.confirmed.get(domain) orelse 0)) return false;
        }
        return true;
    }

    fn remember(self: *ConfirmationStream, message: Message, frontiers: *const Frontiers, domains: ?[]const u32) void {
        const id = message.message_id orelse return;
        var dependencies: Frontiers = .empty;
        if (domains) |list| {
            for (list) |domain| if (frontiers.get(domain)) |height|
                dependencies.put(self.allocator, domain, height) catch @panic("live: out of memory");
        } else {
            for (frontiers.keys(), frontiers.values()) |domain, height|
                dependencies.put(self.allocator, domain, height) catch @panic("live: out of memory");
        }
        if (self.isCanonical(&dependencies)) {
            dependencies.deinit(self.allocator);
            if (self.exposed_ids.fetchOrderedRemove(id)) |entry| {
                self.allocator.free(entry.key);
                var previous = entry.value;
                previous.deinit(self.allocator);
            }
        } else {
            const entry = self.exposed_ids.getOrPut(self.allocator, id) catch @panic("live: out of memory");
            if (entry.found_existing) {
                entry.value_ptr.deinit(self.allocator);
            } else {
                entry.key_ptr.* = self.allocator.dupe(u8, id) catch @panic("live: out of memory");
            }
            entry.value_ptr.* = dependencies;
        }
        if (self.exposed_ids.count() > MAX_CUSTOM_MESSAGE_IDS)
            self.io.fail(self.io.ctx, error.CustomProvisionalMessageLimitExceeded);
    }
};
