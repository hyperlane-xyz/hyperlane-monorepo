//! Port of `event-source.ts` (TS #10089, with #10090): one retained range per
//! (event type, domain) shared by every subscription of one route. Connections
//! own release cursors, never readers. Agents and validators each own an
//! isolated instance (`Limits`, `VALIDATOR_LIMITS`), reading through their own
//! store and pool (`Host.read`).
//!
//! Every method requires the loop mutex. TS awaits map onto the live runtime:
//! - `advance` runs as a pool task (`Loop.spawn`) that blocks in
//!   `Host.read`'s reader (mutex released while reading);
//! - `await nextTurn()` in `publish` is `Loop.yieldTurn` (tasks spawned
//!   before it, and threads already waiting for the mutex, run first);
//! - `await Promise.race(publications)` parks until one of the publications
//!   in flight when it parked ends (`Waiter.race_seq`); later ones don't count;
//! - the setup-side `await confirmationSnapshots(policies)` is the caller's:
//!   `policies`/`attempt` before the read, `subscribeWith` after it.
const std = @import("std");
const runtime = @import("runtime.zig");
const protocol = @import("protocol.zig");
const cs = protocol;
const es = @import("event_store.zig");

const Allocator = std.mem.Allocator;
const Loop = runtime.Loop;
const EventType = protocol.EventType;
const Position = cs.Position;

pub const RETAINED_LIMIT_MESSAGE = "Event source retained range limit exceeded";
pub const RANGE_CAPACITY_MESSAGE = "Event source range capacity exceeded";
pub const UNAVAILABLE_MESSAGE = "Event source temporarily unavailable";
pub const REPLACED_MESSAGE = "Indexed block replaced without a rollback boundary";
/// Failed policies' cooldown (`Date.now() + 30_000`).
pub const RETRY_MS = 30_000;
/// One range load accepts at most this many rows / bytes (also bounded by `Limits`).
pub const LOAD_MAX_ROWS = 5_000;
pub const LOAD_MAX_BYTES = 4 * 1024 * 1024;
/// `publish` yields after this many sends or bytes (skipped rows included).
pub const FANOUT_MESSAGES = 64;
pub const FANOUT_BYTES = 256 * 1024;
/// A sent frame's accounted overhead beyond the row (`row.bytes + 64`).
const FRAME_OVERHEAD = 64;

/// `CapacityError` (the only error `advance` handles in place).
const Capacity = error.RetainedLimit;

pub const Limits = struct {
    rows: usize = 10_000,
    bytes: usize = 32 * 1024 * 1024,
    parallel: usize = 4,
    ranges: usize = 2048,
};

/// TS `VALIDATOR_SOURCE_LIMITS` (event-websocket.ts).
pub const VALIDATOR_LIMITS: Limits = .{ .rows = 10_000, .bytes = 8 * 1024 * 1024, .parallel = 2, .ranges = 512 };

fn oom() noreturn {
    @panic("live: out of memory");
}

/// The server side of one source (one route).
pub const Host = struct {
    ctx: *anyopaque,
    /// `store.confirmationEventRows(eventType, domain, after, through)` on this
    /// route's store and pool. Row frames are the event message without
    /// `confirmations` (`{...eventMessage(row), height, blockHash}`).
    read: *const fn (ctx: *anyopaque, event_type: EventType, domain: u32, after: Position, through: i128) anyerror!cs.Reader,
    /// TS `serializeShared`: one buffer per frame object. `make_frame`
    /// returns it with one reference.
    make_frame: *const fn (ctx: *anyopaque, bytes: []const u8) *anyopaque,
    /// `queueData(socket, frame)`: false when the socket was shed.
    send_frame: *const fn (ctx: *anyopaque, peer: *anyopaque, frame: *anyopaque) bool,
    release_frame: *const fn (ctx: *anyopaque, frame: *anyopaque) void,
    /// `this.clients.get(socket) === client`.
    active: *const fn (ctx: *anyopaque, peer: *anyopaque) bool,
    /// `failSocket(socket, formatError(error))`.
    fail: *const fn (ctx: *anyopaque, peer: *anyopaque, message: []const u8) void,
    /// A subscriber keeps its peer alive (tasks may fail it after unsubscribe).
    retain: *const fn (ctx: *anyopaque, peer: *anyopaque) void,
    release: *const fn (ctx: *anyopaque, peer: *anyopaque) void,
};

pub const Request = struct {
    event_type: EventType,
    confirmations: u64,
    domains: []const u32,
    allow_unavailable: bool = false,
};

/// A connection's subscription state (TS `Subscriber`).
const Subscriber = struct {
    refs: u32 = 1,
    peer: *anyopaque,
    started: bool = false,
    cursors: std.ArrayList(*Cursor) = .empty,

    fn retain(self: *Subscriber) *Subscriber {
        self.refs += 1;
        return self;
    }
};

pub const Cursor = struct {
    owner: *Subscriber,
    event_type: EventType,
    domain: u32,
    confirmations: u64,
    boundary: ?protocol.LiveStartBoundary,
    position: Position,
    target: i128,
    exposed: i128,
};

/// One cached row: the event message's bytes (`JSON.stringify(row.message)`).
const RowData = struct {
    refs: u32 = 1,
    position: Position,
    frame: []u8,

    fn retain(self: *RowData) *RowData {
        self.refs += 1;
        return self;
    }

    fn release(self: *RowData, allocator: Allocator) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        allocator.free(self.frame);
        allocator.destroy(self);
    }
};

/// An immutable row list (TS replaces `window.rows` with new arrays; a
/// publication keeps iterating the array it started with).
const Rows = struct {
    refs: u32 = 1,
    items: []*RowData,

    fn create(allocator: Allocator, parts: []const []const *RowData) *Rows {
        var total: usize = 0;
        for (parts) |part| total += part.len;
        const items = allocator.alloc(*RowData, total) catch oom();
        var i: usize = 0;
        for (parts) |part| for (part) |row| {
            items[i] = row.retain();
            i += 1;
        };
        const self = allocator.create(Rows) catch oom();
        self.* = .{ .items = items };
        return self;
    }

    fn retain(self: *Rows) *Rows {
        self.refs += 1;
        return self;
    }

    fn release(self: *Rows, allocator: Allocator) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        for (self.items) |row| row.release(allocator);
        allocator.free(self.items);
        allocator.destroy(self);
    }
};

const Key = struct { event_type: EventType, domain: u32 };

const Window = struct {
    refs: u32 = 1,
    key: Key,
    cursors: std.ArrayList(*Cursor) = .empty,
    floor: i128,
    through: i128,
    rows: *Rows,
    bytes: usize = 0,
    revision: u64 = 0,
    running: bool = false,

    fn retain(self: *Window) *Window {
        self.refs += 1;
        return self;
    }

    fn release(self: *Window, allocator: Allocator) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        self.rows.release(allocator);
        self.cursors.deinit(allocator);
        allocator.destroy(self);
    }

    fn hasCursor(self: *const Window, cursor: *const Cursor) bool {
        return std.mem.indexOfScalar(*Cursor, self.cursors.items, @constCast(cursor)) != null;
    }
};

/// A head notification kept for late joiners (`this.heads`).
const ObservedHead = struct {
    version: u64,
    /// `indexed_hash` is not kept here (map entries move): see `view`.
    head: protocol.HeadNotification,
    hash: [66]u8 = undefined,
    hash_len: usize = 0,
    has_hash: bool = false,

    fn view(self: *const ObservedHead) protocol.HeadNotification {
        var head = self.head;
        head.indexed_hash = if (self.has_hash) self.hash[0..self.hash_len] else null;
        return head;
    }
};

const Retry = struct { until: i64, confirmations: u64 };

/// A parked task (`await` on a promise someone else settles).
const Waiter = struct {
    event: std.Thread.ResetEvent = .{},
    /// `Promise.race(publications)`: the publications in flight at park time
    /// are those numbered up to this (`EventSource.publication_seq`).
    race_seq: u64 = 0,

    fn park(self: *Waiter, loop: *Loop) void {
        runtime.assertMayBlock();
        loop.unlock();
        self.event.wait();
        loop.lockHandoff(self);
    }

    fn wake(self: *Waiter, loop: *Loop) void {
        loop.handOff(.{ .task = self });
        self.event.set();
    }
};

pub const Metrics = struct { ranges: usize, rows: usize, bytes: usize };

/// `subscribe` failed before attaching cursors.
pub const SubscribeError = error{
    /// `ConfirmationUnavailableError(domain)` (see `Attempt.unavailable_domain`).
    ConfirmationUnavailable,
    /// UNAVAILABLE_MESSAGE.
    TemporarilyUnavailable,
    /// RANGE_CAPACITY_MESSAGE.
    RangeCapacity,
};

/// One `confirmationSnapshots` read of a `subscribe` attempt.
pub const Attempt = struct {
    revision: u64,
    version: u64,
    unavailable_domain: u32 = 0,
};

/// The value TS `subscribe` returns: `{ starts, start(), stop() }`.
pub const Subscription = struct {
    source: *EventSource,
    owner: *Subscriber,

    /// `starts`: every cursor in request order (advisory ones without heads
    /// included, with no boundary).
    pub fn starts(self: Subscription) []const *Cursor {
        return self.owner.cursors.items;
    }

    pub fn start(self: Subscription) void {
        const source = self.source;
        if (!source.host.active(source.host.ctx, self.owner.peer) or source.stopped) return;
        self.owner.started = true;
        source.scheduleAvailable();
    }

    pub fn stop(self: Subscription) void {
        self.source.remove(self.owner);
    }

    /// Another handle on the same subscription (TS shares one object): its
    /// cursors stay readable until every handle is dropped.
    pub fn retain(self: Subscription) Subscription {
        _ = self.owner.retain();
        _ = self.source.retain();
        return self;
    }

    /// Drop the handle (after `stop`, or when never started).
    pub fn deinit(self: Subscription) void {
        self.source.releaseOwner(self.owner);
        _ = self.source.release();
    }
};

pub const EventSource = struct {
    allocator: Allocator,
    loop: *Loop,
    host: Host,
    limits: Limits,
    /// The server's reference plus one per task and subscription handle.
    refs: u32 = 1,
    windows: std.AutoArrayHashMapUnmanaged(Key, *Window) = .empty,
    heads: std.AutoHashMapUnmanaged(u32, ObservedHead) = .empty,
    retry_after: std.AutoHashMapUnmanaged(Key, Retry) = .empty,
    /// In-flight publications (`this.publications.size`) and the advances
    /// awaiting `Promise.race(this.publications)`.
    publications: usize = 0,
    /// The last publication's number (each `publish` takes the next).
    publication_seq: u64 = 0,
    publication_waiters: std.ArrayList(*Waiter) = .empty,
    running: usize = 0,
    version: u64 = 0,
    revision: u64 = 0,
    stopped: bool = false,
    bytes: usize = 0,
    rows: usize = 0,
    pending_bytes: usize = 0,
    pending_rows: usize = 0,

    pub fn create(allocator: Allocator, loop: *Loop, host: Host, limits: Limits) *EventSource {
        const self = allocator.create(EventSource) catch oom();
        self.* = .{ .allocator = allocator, .loop = loop, .host = host, .limits = limits };
        return self;
    }

    pub fn retain(self: *EventSource) *EventSource {
        self.refs += 1;
        return self;
    }

    /// The last reference frees the source (after `stop`). Returns true then.
    pub fn release(self: *EventSource) bool {
        self.refs -= 1;
        if (self.refs > 0) return false;
        std.debug.assert(self.stopped);
        const allocator = self.allocator;
        self.windows.deinit(allocator);
        self.heads.deinit(allocator);
        self.retry_after.deinit(allocator);
        self.publication_waiters.deinit(allocator);
        allocator.destroy(self);
        return true;
    }

    pub fn metrics(self: *const EventSource) Metrics {
        return .{
            .ranges = self.windows.count(),
            .rows = self.rows + self.pending_rows,
            .bytes = self.bytes + self.pending_bytes,
        };
    }

    // -- Setup ---------------------------------------------------------------

    /// `policies`: confirmation count -> domains, in first-seen order (`Map`
    /// and `Set` insertion order), allocated in `arena`.
    pub fn policies(arena: Allocator, requests: []const Request) Allocator.Error![]es.EventStore.Policy {
        var counts: std.ArrayList(u64) = .empty;
        var domains: std.ArrayList(std.ArrayList(u32)) = .empty;
        for (requests) |request| {
            const index = std.mem.indexOfScalar(u64, counts.items, request.confirmations) orelse blk: {
                try counts.append(arena, request.confirmations);
                try domains.append(arena, .empty);
                break :blk counts.items.len - 1;
            };
            const list = &domains.items[index];
            for (request.domains) |domain| {
                if (std.mem.indexOfScalar(u32, list.items, domain) == null) try list.append(arena, domain);
            }
        }
        const out = try arena.alloc(es.EventStore.Policy, counts.items.len);
        for (out, counts.items, domains.items) |*policy, count, list| policy.* = .{ .confirmations = count, .domains = list.items };
        return out;
    }

    /// The loop head of `subscribe` before its snapshot read: null when the
    /// caller must not read (inactive peer or stopped source; TS breaks and
    /// returns an empty subscription).
    pub fn attempt(self: *EventSource, peer: *anyopaque) ?Attempt {
        if (!self.host.active(self.host.ctx, peer) or self.stopped) return null;
        return .{ .revision = self.revision, .version = self.version };
    }

    /// `subscribe` after its read resolved: null when ancestry changed meanwhile
    /// (read again with a new `attempt`). `snapshots` is aligned with
    /// `policies(requests)`. On error nothing is attached.
    pub fn subscribeWith(
        self: *EventSource,
        attempt_: *Attempt,
        requests: []const Request,
        policy_list: []const es.EventStore.Policy,
        snapshots: []const cs.Heads,
        peer: *anyopaque,
    ) SubscribeError!?Subscription {
        if (!self.host.active(self.host.ctx, peer) or self.stopped) return self.emptySubscription(peer);
        if (attempt_.revision != self.revision) return null;
        const now = self.loop.now();
        // Validate the entire negotiation before attaching any cursors.
        var new_ranges: usize = 0;
        var seen_new: std.ArrayList(Key) = .empty;
        defer seen_new.deinit(self.allocator);
        for (requests) |request| for (request.domains) |domain| {
            const head = snapshotHead(policy_list, snapshots, request.confirmations, domain);
            if (head == null and !request.allow_unavailable) {
                attempt_.unavailable_domain = domain;
                return error.ConfirmationUnavailable;
            }
            const key: Key = .{ .event_type = request.event_type, .domain = domain };
            if (self.retry_after.get(key)) |retry| {
                if (retry.until > now and request.confirmations >= retry.confirmations) return error.TemporarilyUnavailable;
            }
            if (head != null and !self.windows.contains(key) and !containsKey(seen_new.items, key)) {
                seen_new.append(self.allocator, key) catch oom();
                new_ranges += 1;
            }
        };
        if (self.windows.count() + new_ranges > self.limits.ranges) return error.RangeCapacity;

        const owner = self.newOwner(peer);
        for (requests) |request| for (request.domains) |domain| {
            const head = snapshotHead(policy_list, snapshots, request.confirmations, domain);
            const target = if (head) |h| cs.confirmationHeight(h.head, h.indexed, request.confirmations) else 0;
            // `BigInt(liveStart.height)`: at most 20 digits, within i128.
            const height = if (head) |h| (if (h.live_start) |boundary| std.fmt.parseInt(i128, boundary.height(), 10) catch unreachable else target) else target;
            const cursor = self.allocator.create(Cursor) catch oom();
            cursor.* = .{
                .owner = owner,
                .event_type = request.event_type,
                .domain = domain,
                .confirmations = request.confirmations,
                .boundary = if (head) |h| h.live_start else null,
                .position = cs.endOfHeight(height),
                .target = target,
                .exposed = height,
            };
            owner.cursors.append(self.allocator, cursor) catch oom();
            if (head == null) continue; // Advisory coverage is fixed until reconnect.
            if (self.heads.getPtr(domain)) |observed| {
                if (observed.version > attempt_.version) self.update(cursor, observed.view());
            }
            const key: Key = .{ .event_type = request.event_type, .domain = domain };
            const window = self.windows.get(key) orelse blk: {
                const window = self.allocator.create(Window) catch oom();
                window.* = .{ .key = key, .floor = height, .through = height, .rows = Rows.create(self.allocator, &.{}) };
                self.windows.put(self.allocator, key, window) catch oom();
                break :blk window;
            };
            window.cursors.append(self.allocator, cursor) catch oom();
        };
        return .{ .source = self.retain(), .owner = owner };
    }

    fn emptySubscription(self: *EventSource, peer: *anyopaque) Subscription {
        return .{ .source = self.retain(), .owner = self.newOwner(peer) };
    }

    fn newOwner(self: *EventSource, peer: *anyopaque) *Subscriber {
        const owner = self.allocator.create(Subscriber) catch oom();
        owner.* = .{ .peer = peer };
        self.host.retain(self.host.ctx, peer);
        return owner;
    }

    fn releaseOwner(self: *EventSource, owner: *Subscriber) void {
        owner.refs -= 1;
        if (owner.refs > 0) return;
        for (owner.cursors.items) |cursor| self.allocator.destroy(cursor);
        owner.cursors.deinit(self.allocator);
        self.host.release(self.host.ctx, owner.peer);
        self.allocator.destroy(owner);
    }

    fn snapshotHead(policy_list: []const es.EventStore.Policy, snapshots: []const cs.Heads, confirmations: u64, domain: u32) ?cs.ConfirmationHead {
        for (policy_list, snapshots) |policy, heads| {
            if (policy.confirmations == confirmations) return heads.get(domain);
        }
        return null;
    }

    // -- Heads ---------------------------------------------------------------

    pub fn notify(self: *EventSource, head: protocol.HeadNotification) void {
        const head_height = head.head_height orelse return;
        const indexed_height = head.indexed_height orelse return;
        _ = head_height;
        const previous = if (self.heads.getPtr(head.domain)) |observed| observed.view() else null;
        const replaced = if (previous) |p|
            p.indexed_height != null and p.indexed_height.? == indexed_height and
                p.indexed_hash != null and head.indexed_hash != null and
                !std.mem.eql(u8, p.indexed_hash.?, head.indexed_hash.?)
        else
            false;
        self.version += 1;
        self.storeHead(head);
        const rollback = if (head.previous_indexed_height) |p| indexed_height < p else false;
        if (rollback or replaced) self.revision += 1;
        // Windows of this domain, in map order; failing a subscriber can
        // remove windows, so walk a snapshot.
        const windows = self.domainWindows(head.domain);
        defer {
            for (windows) |window| window.release(self.allocator);
            self.allocator.free(windows);
        }
        for (windows) |window| {
            if (self.windows.get(window.key) != window) continue;
            if (replaced) {
                self.failWindow(window, REPLACED_MESSAGE);
                continue;
            }
            if (rollback) {
                window.revision += 1;
                self.clear(window);
            }
            // `update` can send, and a send can disconnect a peer (this one or
            // another), which stops and drops its subscription: hold the owners.
            const cursors = self.allocator.dupe(*Cursor, window.cursors.items) catch oom();
            defer self.allocator.free(cursors);
            for (cursors) |cursor| _ = cursor.owner.retain();
            defer for (cursors) |cursor| self.releaseOwner(cursor.owner);
            for (cursors) |cursor| if (window.hasCursor(cursor)) self.update(cursor, head);
            if (rollback and window.cursors.items.len > 0) {
                window.floor = minimumPosition(window);
                window.through = window.floor;
            }
            self.schedule(window);
        }
    }

    fn storeHead(self: *EventSource, head: protocol.HeadNotification) void {
        const gop = self.heads.getOrPut(self.allocator, head.domain) catch oom();
        gop.value_ptr.* = .{ .version = self.version, .head = head };
        gop.value_ptr.head.indexed_hash = null;
        if (head.indexed_hash) |hash| {
            const len = @min(hash.len, gop.value_ptr.hash.len);
            @memcpy(gop.value_ptr.hash[0..len], hash[0..len]);
            gop.value_ptr.hash_len = len;
            gop.value_ptr.has_hash = true;
        }
    }

    fn domainWindows(self: *EventSource, domain: u32) []*Window {
        var out: std.ArrayList(*Window) = .empty;
        for (self.windows.values()) |window| {
            if (window.key.domain == domain) out.append(self.allocator, window.retain()) catch oom();
        }
        return out.toOwnedSlice(self.allocator) catch oom();
    }

    /// `for (const cursor of window.cursors) this.fail(cursor.owner, error)`:
    /// a failed owner leaves the set, so the walk skips its other cursors.
    fn failWindow(self: *EventSource, window: *Window, message: []const u8) void {
        var copy: [512]u8 = undefined;
        const text = copy[0..@min(message.len, copy.len)];
        @memcpy(text, message[0..text.len]);
        const cursors = self.allocator.dupe(*Cursor, window.cursors.items) catch oom();
        defer self.allocator.free(cursors);
        var owners: std.ArrayList(*Subscriber) = .empty;
        defer {
            for (owners.items) |owner| self.releaseOwner(owner);
            owners.deinit(self.allocator);
        }
        for (cursors) |cursor| owners.append(self.allocator, cursor.owner.retain()) catch oom();
        for (cursors, owners.items) |cursor, owner| {
            if (window.hasCursor(cursor)) self.fail(owner, text);
        }
    }

    fn update(self: *EventSource, cursor: *Cursor, head: protocol.HeadNotification) void {
        const head_height = head.head_height orelse return;
        const indexed_height = head.indexed_height orelse return;
        cursor.target = cs.confirmationHeight(head_height, indexed_height, cursor.confirmations);
        const previous = head.previous_indexed_height orelse return;
        if (indexed_height >= previous) return;
        cursor.boundary = null;
        if (cursor.owner.started and cursor.exposed > cursor.target) {
            var buf: std.Io.Writer.Allocating = .init(self.allocator);
            defer buf.deinit();
            buf.writer.print(
                "{{\"type\":\"rollback\",\"eventType\":\"{s}\",\"domain\":{d},\"confirmations\":{d},\"fromHeight\":\"{d}\",\"toHeight\":\"{d}\"}}",
                .{ cursor.event_type.name(), cursor.domain, cursor.confirmations, cursor.exposed, cursor.target },
            ) catch oom();
            const frame = self.host.make_frame(self.host.ctx, buf.written());
            defer self.host.release_frame(self.host.ctx, frame);
            self.send(cursor, frame);
        }
        cursor.exposed = cursor.target;
        if (cursor.position.height > cursor.target) cursor.position = cs.endOfHeight(cursor.target);
    }

    /// The caller holds `cursor.owner`: a failed send, or the host's own
    /// disconnect inside `send_frame`, can stop and drop the subscription.
    fn send(self: *EventSource, cursor: *Cursor, frame: *anyopaque) void {
        const peer = cursor.owner.peer;
        if (!self.host.active(self.host.ctx, peer) or !self.host.send_frame(self.host.ctx, peer, frame)) self.remove(cursor.owner);
    }

    // -- Reads ---------------------------------------------------------------

    fn schedule(self: *EventSource, window: *Window) void {
        if (window.running or self.stopped or self.running >= self.limits.parallel or !self.needsRead(window)) return;
        self.running += 1;
        window.running = true;
        self.loop.spawn(runAdvance, .{ self.retain(), window.retain() });
    }

    fn scheduleAvailable(self: *EventSource) void {
        if (self.stopped) return;
        const windows = self.allocator.dupe(*Window, self.windows.values()) catch oom();
        defer self.allocator.free(windows);
        for (windows) |window| {
            if (self.running >= self.limits.parallel) break;
            if (self.windows.get(window.key) != window) continue;
            self.schedule(window);
        }
    }

    fn needsRead(self: *const EventSource, window: *const Window) bool {
        for (window.cursors.items) |cursor| {
            if (cursor.owner.started and self.host.active(self.host.ctx, cursor.owner.peer) and cursor.target > completedHeight(cursor)) return true;
        }
        return false;
    }

    fn runAdvance(self: *EventSource, window: *Window) void {
        defer _ = self.release();
        defer window.release(self.allocator);
        self.advance(window) catch |err| {
            self.cooldown(window, 0);
            self.failWindow(window, runtime.errorMessage(err));
        };
        self.running -= 1;
        window.running = false;
        // Rotate completed ranges for fairness. Idle windows are the queue;
        // disconnected clients leave no queued tasks or retained closures.
        if (self.windows.get(window.key) == window) {
            _ = self.windows.orderedRemove(window.key);
            self.windows.put(self.allocator, window.key, window) catch oom();
        }
        self.scheduleAvailable();
    }

    fn advance(self: *EventSource, window: *Window) !void {
        if (self.stopped or self.windows.get(window.key) != window or !self.needsRead(window)) return;
        self.trim(window);
        const floor = minimumPosition(window);
        const prefix = floor < window.floor;
        var through = window.through;
        for (window.cursors.items) |cursor| {
            if (cursor.owner.started and cursor.target > through) through = cursor.target;
        }
        const after = if (prefix) floor else window.through;
        const end = if (prefix) window.floor else through;
        // The deeper cursors a failed prefix or capacity load fails.
        var lagging: std.ArrayList(*Cursor) = .empty;
        defer {
            for (lagging.items) |cursor| self.releaseOwner(cursor.owner);
            lagging.deinit(self.allocator);
        }
        for (window.cursors.items) |cursor| {
            if (completedHeight(cursor) == floor) {
                _ = cursor.owner.retain();
                lagging.append(self.allocator, cursor) catch oom();
            }
        }
        for (window.cursors.items) |cursor| {
            if (cursor.owner.started and cursor.target > cursor.exposed) cursor.exposed = cursor.target;
        }
        if (end > after) {
            const revision = window.revision;
            var pending: std.ArrayList(*RowData) = .empty;
            var bytes: usize = 0;
            var installed = false;
            defer {
                self.pending_bytes -= bytes;
                self.pending_rows -= pending.items.len;
                if (!installed) for (pending.items) |row| row.release(self.allocator);
                pending.deinit(self.allocator);
            }
            const loaded = self.load(window, revision, after, end, &pending, &bytes) catch |err| {
                return self.loadFailed(window, revision, prefix, lagging.items, err);
            };
            if (!loaded) return;
            if (self.stopped or window.cursors.items.len == 0) return;
            if (revision != window.revision or (prefix and end != window.floor)) return;
            while (self.rows + pending.items.len > self.limits.rows or self.bytes + bytes > self.limits.bytes) {
                // An in-progress publication can free space without shedding a
                // subscriber. Publishers do not wait on pending scan admission.
                if (self.publications > 0) {
                    var waiter: Waiter = .{ .race_seq = self.publication_seq };
                    self.publication_waiters.append(self.allocator, &waiter) catch oom();
                    waiter.park(self.loop);
                    if (self.stopped or window.cursors.items.len == 0 or revision != window.revision or (prefix and end != window.floor)) return;
                    continue;
                }
                // A new historical prefix must pay for itself. Growing live ranges
                // shed the policy retaining the largest cache, not an unrelated
                // zero-confirmation subscriber that happens to publish next.
                if (prefix or !self.evictRetainer()) {
                    return self.loadFailed(window, revision, prefix, lagging.items, Capacity);
                }
                if (window.cursors.items.len == 0 or revision != window.revision) return;
            }
            const old = window.rows;
            window.rows = if (prefix) Rows.create(self.allocator, &.{ pending.items, old.items }) else Rows.create(self.allocator, &.{ old.items, pending.items });
            old.release(self.allocator);
            for (pending.items) |row| row.release(self.allocator);
            installed = true;
            window.bytes += bytes;
            self.bytes += bytes;
            self.rows += pending.items.len;
            if (prefix) window.floor = floor else window.through = end;
        }
        self.publications += 1;
        self.publication_seq += 1;
        const seq = self.publication_seq;
        const completed = self.publish(window);
        if (completed) self.trim(window);
        self.publications -= 1;
        // `Promise.race(publications)`: an advance parked while this
        // publication was in flight resumes and re-checks.
        var i: usize = 0;
        while (i < self.publication_waiters.items.len) {
            const waiter = self.publication_waiters.items[i];
            if (waiter.race_seq >= seq) {
                _ = self.publication_waiters.orderedRemove(i);
                waiter.wake(self.loop);
            } else i += 1;
        }
    }

    /// The scan of one range load. False when the read stopped early
    /// (stopped source, no cursors left or a new revision).
    fn load(self: *EventSource, window: *Window, revision: u64, after: i128, end: i128, pending: *std.ArrayList(*RowData), bytes: *usize) !bool {
        const reader = try self.host.read(self.host.ctx, window.key.event_type, window.key.domain, cs.endOfHeight(after), end);
        defer reader.deinit();
        while (try reader.next()) |row| {
            if (self.stopped or window.cursors.items.len == 0 or revision != window.revision) return false;
            const data = self.allocator.create(RowData) catch oom();
            data.* = .{ .position = row.position, .frame = self.allocator.dupe(u8, row.message.frame) catch oom() };
            const row_bytes = data.frame.len;
            bytes.* += row_bytes;
            pending.append(self.allocator, data) catch oom();
            self.pending_bytes += row_bytes;
            self.pending_rows += 1;
            if (pending.items.len > @min(LOAD_MAX_ROWS, self.limits.rows) or bytes.* > @min(LOAD_MAX_BYTES, self.limits.bytes)) return Capacity;
        }
        return true;
    }

    /// TS `advance`'s catch for a load or capacity failure.
    fn loadFailed(self: *EventSource, window: *Window, revision: u64, prefix: bool, lagging: []const *Cursor, err: anyerror) !void {
        if (revision != window.revision) return;
        // A deeper joining policy can fail its own prefix scan without
        // interrupting subscribers already served by the retained window.
        if (!prefix and err != Capacity) return err;
        var affected: std.ArrayList(*Cursor) = .empty;
        defer affected.deinit(self.allocator);
        for (lagging) |cursor| if (window.hasCursor(cursor)) affected.append(self.allocator, cursor) catch oom();
        if (affected.items.len == 0) return;
        var min_count = affected.items[0].confirmations;
        for (affected.items) |cursor| min_count = @min(min_count, cursor.confirmations);
        self.cooldown(window, min_count);
        const text = if (err == Capacity) RETAINED_LIMIT_MESSAGE else runtime.errorMessage(err);
        var copy: [512]u8 = undefined;
        const message = copy[0..@min(text.len, copy.len)];
        @memcpy(message, text[0..message.len]);
        for (affected.items) |cursor| self.fail(cursor.owner, message);
    }

    const Pass = struct { cursor: *Cursor, target: i128 };

    /// Returns false when the window changed under a yield (no trim).
    fn publish(self: *EventSource, window: *Window) bool {
        const revision = window.revision;
        var passes: std.ArrayList(Pass) = .empty;
        defer {
            for (passes.items) |pass| self.releaseOwner(pass.cursor.owner);
            passes.deinit(self.allocator);
        }
        for (window.cursors.items) |cursor| {
            if (!cursor.owner.started or completedHeight(cursor) < window.floor) continue;
            _ = cursor.owner.retain();
            passes.append(self.allocator, .{ .cursor = cursor, .target = if (cursor.target < window.through) cursor.target else window.through }) catch oom();
        }
        const rows = window.rows.retain();
        defer rows.release(self.allocator);
        var sent: usize = 0;
        var sent_bytes: usize = 0;
        for (rows.items) |row| {
            var frames: std.ArrayList(struct { confirmations: u64, frame: *anyopaque }) = .empty;
            defer {
                for (frames.items) |entry| self.host.release_frame(self.host.ctx, entry.frame);
                frames.deinit(self.allocator);
            }
            for (passes.items) |*pass| {
                const cursor = pass.cursor;
                // Skipped rows also consume fanout work. Recheck ancestry after yielding.
                sent += 1;
                if (sent >= FANOUT_MESSAGES or sent_bytes >= FANOUT_BYTES) {
                    sent = 0;
                    sent_bytes = 0;
                    self.nextTurn();
                    if (self.stopped or revision != window.revision or self.windows.get(window.key) != window) return false;
                }
                if (cursor.target < pass.target) pass.target = cursor.target;
                if (!cursor.owner.started or row.position.height > pass.target or comparePosition(row.position, cursor.position) <= 0) continue;
                cursor.position = row.position;
                if (row.position.height > cursor.exposed) cursor.exposed = row.position.height;
                const frame = for (frames.items) |entry| {
                    if (entry.confirmations == cursor.confirmations) break entry.frame;
                } else blk: {
                    const frame = self.makeEventFrame(row.frame, cursor.confirmations);
                    frames.append(self.allocator, .{ .confirmations = cursor.confirmations, .frame = frame }) catch oom();
                    break :blk frame;
                };
                self.send(cursor, frame);
                sent_bytes += row.frame.len + FRAME_OVERHEAD;
            }
        }
        for (passes.items) |pass| {
            const cursor = pass.cursor;
            if (!cursor.owner.started) continue;
            const completed = if (cursor.target < pass.target) cursor.target else pass.target;
            if (completed >= cursor.position.height) cursor.position = cs.endOfHeight(completed);
        }
        return true;
    }

    /// `{...row.message, confirmations}`: the row's object with
    /// `"confirmations":N` appended last.
    fn makeEventFrame(self: *EventSource, message: []const u8, confirmations: u64) *anyopaque {
        std.debug.assert(message.len >= 2 and message[message.len - 1] == '}');
        var buf: std.Io.Writer.Allocating = .init(self.allocator);
        defer buf.deinit();
        buf.writer.writeAll(message[0 .. message.len - 1]) catch oom();
        buf.writer.print("{s}\"confirmations\":{d}}}", .{ if (message.len > 2) "," else "", confirmations }) catch oom();
        return self.host.make_frame(self.host.ctx, buf.written());
    }

    /// `await nextTurn()` (`setImmediate`): end this turn; queued
    /// continuations, every task spawned before it and every thread already
    /// blocked for the mutex (pending I/O) run before this one continues
    /// (`Loop.yieldTurn`).
    fn nextTurn(self: *EventSource) void {
        self.loop.yieldTurn();
    }

    fn trim(self: *EventSource, window: *Window) void {
        if (window.cursors.items.len == 0) return;
        const floor = minimumPosition(window);
        if (floor <= window.floor) return;
        var removed: usize = 0;
        var bytes: usize = 0;
        for (window.rows.items) |row| {
            if (row.position.height > floor) break;
            removed += 1;
            bytes += row.frame.len;
        }
        if (removed > 0) {
            const old = window.rows;
            window.rows = Rows.create(self.allocator, &.{old.items[removed..]});
            old.release(self.allocator);
        }
        window.bytes -= bytes;
        self.bytes -= bytes;
        self.rows -= removed;
        window.floor = floor;
        if (floor > window.through) {
            // A newer checkpoint can outlive every reader of the skipped interval.
            window.through = floor;
            window.revision += 1;
        }
    }

    fn evictRetainer(self: *EventSource) bool {
        var victim: ?*Window = null;
        var retainers: std.ArrayList(*Cursor) = .empty;
        defer retainers.deinit(self.allocator);
        for (self.windows.values()) |window| {
            if (window.rows.items.len == 0) continue;
            const last = window.rows.items[window.rows.items.len - 1];
            if (victim) |v| if (window.bytes <= v.bytes) continue;
            const oldest = minimumPosition(window);
            var found: std.ArrayList(*Cursor) = .empty;
            for (window.cursors.items) |cursor| {
                if (completedHeight(cursor) == oldest and cursor.target < last.position.height) found.append(self.allocator, cursor) catch oom();
            }
            if (found.items.len > 0) {
                victim = window;
                retainers.deinit(self.allocator);
                retainers = found;
            } else found.deinit(self.allocator);
        }
        // Failing an owner can empty and free the victim window.
        const window = (victim orelse return false).retain();
        defer window.release(self.allocator);
        var min_count = retainers.items[0].confirmations;
        for (retainers.items) |cursor| min_count = @min(min_count, cursor.confirmations);
        self.cooldown(window, min_count);
        var owners: std.ArrayList(*Subscriber) = .empty;
        defer {
            for (owners.items) |owner| self.releaseOwner(owner);
            owners.deinit(self.allocator);
        }
        for (retainers.items) |cursor| owners.append(self.allocator, cursor.owner.retain()) catch oom();
        for (retainers.items, owners.items) |cursor, owner| {
            if (window.hasCursor(cursor)) self.fail(owner, RETAINED_LIMIT_MESSAGE);
        }
        return true;
    }

    fn cooldown(self: *EventSource, window: *const Window, confirmations: u64) void {
        const now = self.loop.now();
        const previous = self.retry_after.get(window.key);
        self.retry_after.put(self.allocator, window.key, .{
            .until = now + RETRY_MS,
            .confirmations = if (previous) |p| (if (p.until > now) @min(p.confirmations, confirmations) else confirmations) else confirmations,
        }) catch oom();
    }

    fn fail(self: *EventSource, owner: *Subscriber, message: []const u8) void {
        self.remove(owner);
        self.host.fail(self.host.ctx, owner.peer, message);
    }

    fn remove(self: *EventSource, owner: *Subscriber) void {
        owner.started = false;
        for (owner.cursors.items) |cursor| {
            const key: Key = .{ .event_type = cursor.event_type, .domain = cursor.domain };
            const window = self.windows.get(key) orelse continue;
            if (std.mem.indexOfScalar(*Cursor, window.cursors.items, cursor)) |index| _ = window.cursors.orderedRemove(index);
            if (window.cursors.items.len > 0) {
                self.trim(window);
            } else {
                self.clear(window);
                _ = self.windows.orderedRemove(key);
                window.release(self.allocator);
            }
        }
    }

    fn clear(self: *EventSource, window: *Window) void {
        self.rows -= window.rows.items.len;
        self.bytes -= window.bytes;
        window.rows.release(self.allocator);
        window.rows = Rows.create(self.allocator, &.{});
        window.bytes = 0;
    }

    pub fn stop(self: *EventSource) void {
        self.stopped = true;
        for (self.windows.values()) |window| {
            self.clear(window);
            window.release(self.allocator);
        }
        self.windows.clearRetainingCapacity();
        self.heads.clearRetainingCapacity();
    }
};

fn containsKey(keys: []const Key, key: Key) bool {
    for (keys) |k| if (k.event_type == key.event_type and k.domain == key.domain) return true;
    return false;
}

fn minimumPosition(window: *const Window) i128 {
    var floor: ?i128 = null;
    for (window.cursors.items) |cursor| {
        const completed = completedHeight(cursor);
        if (floor == null or completed < floor.?) floor = completed;
    }
    return floor orelse window.through;
}

fn completedHeight(cursor: *const Cursor) i128 {
    return if (cursor.position.source == cs.endOfHeight(0).source) cursor.position.height else cursor.position.height - 1;
}

/// TS `comparePosition`: height, then row id (the source is not compared).
fn comparePosition(a: Position, b: Position) i8 {
    if (a.height < b.height) return -1;
    if (a.height > b.height) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
}
