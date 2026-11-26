//! Port of `message-source.ts` (TS #10078, with #10079, #10082, #10080 and #10085): the per-process source for
//! /messages custom subscriptions. One lazy heads snapshot, kept current from
//! NOTIFY; one retained change window per domain; message facts read once
//! per ID (batches of 64, two in flight) and projected per subscriber.
//!
//! Every method requires the loop mutex. TS awaits map onto the live runtime
//! as in szig-scratch/live-measure/p10078/await-map.md:
//! - `advance` and `refresh` run as pool tasks (`Loop.spawn`) that block on
//!   `EventStore.query` (mutex released);
//! - shared promises (an entry's facts read) are refcounted `Cell`s whose
//!   waiters resume FIFO through loop handoffs (`park`/`wake`);
//! - the setup-side `currentHeads()` never blocks: callers queue a
//!   `HeadsWaiter` whose continuation runs as a handoff (`cont`).
const std = @import("std");
const core = @import("core");
const scraperdb = @import("scraperdb");
const runtime = @import("runtime.zig");
const protocol = @import("protocol.zig");
const es = @import("event_store.zig");
const mf = @import("message_facts.zig");
const frames = @import("frames.zig");

const json = core.json;
const Value = json.Value;
const Allocator = std.mem.Allocator;
const Loop = runtime.Loop;

pub const MAX_CHANGES = 50_000;
pub const MAX_FACT_BYTES = 64 * 1024 * 1024;
pub const MAX_PARALLEL_DOMAINS = 4;
pub const FACT_BATCH_SIZE = 64;
pub const MAX_FACT_QUERIES = 2;
pub const DOMAIN_RETRY_MS = 30_000;
pub const MAX_READ_QUEUE = 512;
pub const MAX_EXPOSED = 10_000;
/// TS #10082: exposure pruning on confirmed-height changes, at most this often.
pub const PRUNE_INTERVAL_MS = 1_000;
/// TS #10085: distinct frontier keys cached per facts object.
pub const MAX_PROJECTIONS_PER_FACT = 16;
/// TS #10085 `MAX_EXPLORER_REFRESHES`: publishExplorer's refreshes in flight.
pub const MAX_EXPLORER_REFRESHES = 4;

/// Failure texts kept across turns: as long as any recorded message
/// (`runtime.fail` keeps 512 bytes), so nothing is cut here.
const MAX_TEXT = 512;

pub const RANGE_CAPACITY_MESSAGE = "Message source range limit exceeded";
const QUEUE_FULL_MESSAGE = "Message source read queue full";
const BYTE_LIMIT_MESSAGE = "Message source byte limit exceeded";
const BEHIND_MESSAGE = "Message cursor fell behind retained range";
const REPLACED_MESSAGE = "Message block replaced without rollback boundary";
const MISSING_READ_MESSAGE = "Missing scheduled message read";
const INVALIDATED_MESSAGE = "Message snapshot invalidated during publication";
const EXPOSED_MESSAGE = "Custom provisional message limit exceeded";

/// `MessageRangeCapacityError` (the only error `advance` handles in place).
const RangeCapacity = error.RangeCapacity;

fn oom() noreturn {
    @panic("live: out of memory");
}

/// A failure's message: our fixed texts, else the thread's `runtime.fail` text.
fn message(err: anyerror) []const u8 {
    return switch (err) {
        error.RangeCapacity => RANGE_CAPACITY_MESSAGE,
        error.Invalidated => INVALIDATED_MESSAGE,
        else => runtime.errorMessage(err),
    };
}

// ---------------------------------------------------------------------------
// Runtime glue

/// A parked task (`await` on a promise someone else settles).
const Waiter = struct {
    event: std.Thread.ResetEvent = .{},

    /// Mutex held; returns with it held, in this waiter's handoff turn.
    fn park(self: *Waiter, loop: *Loop) void {
        runtime.assertMayBlock();
        loop.unlock();
        self.event.wait();
        loop.lockHandoff(self);
    }

    /// Mutex held (handoff invariant I2: queue and wake together).
    fn wake(self: *Waiter, loop: *Loop) void {
        loop.handOff(.{ .task = self });
        self.event.set();
    }
};

/// `limitReads(limit)`: bounded FIFO admission; a finishing read hands its
/// slot straight to the next waiter.
const Limiter = struct {
    limit: usize,
    active: usize = 0,
    queue: std.ArrayList(*Waiter) = .empty,

    fn acquire(self: *Limiter, loop: *Loop, allocator: Allocator) error{QueueFull}!void {
        if (self.active < self.limit) {
            self.active += 1;
            return;
        }
        if (self.queue.items.len >= MAX_READ_QUEUE) return error.QueueFull;
        var waiter: Waiter = .{};
        self.queue.append(allocator, &waiter) catch oom();
        waiter.park(loop);
    }

    fn release(self: *Limiter, loop: *Loop) void {
        if (self.queue.items.len > 0) {
            self.queue.orderedRemove(0).wake(loop);
        } else self.active -= 1;
    }
};

// ---------------------------------------------------------------------------
// State

pub const Head = struct {
    head: i128,
    indexed: i128,
    confirmed: i128,
    hash: ?[66]u8 = null,

    pub fn hashText(self: *const Head) ?[]const u8 {
        return if (self.hash) |*h| h else null;
    }
};

/// `{ head, indexed, confirmed }` an advance works towards; `version`
/// stands for the TS object identity (`head === work.head`).
const Work = struct {
    head: i128,
    indexed: i128,
    confirmed: i128,
    version: u64 = 0,
};

const Change = struct { height: i128, id: []const u8 };

/// An immutable change list (TS replaces `window.changes` with new arrays;
/// an advance keeps the array it read).
const Changes = struct {
    refs: u32 = 1,
    arena: std.heap.ArenaAllocator,
    items: []Change = &.{},

    fn create(allocator: Allocator, parts: []const []const Change) *Changes {
        const self = allocator.create(Changes) catch oom();
        self.* = .{ .arena = .init(allocator) };
        const a = self.arena.allocator();
        var total: usize = 0;
        for (parts) |part| total += part.len;
        const items = a.alloc(Change, total) catch oom();
        var i: usize = 0;
        for (parts) |part| for (part) |change| {
            items[i] = .{ .height = change.height, .id = a.dupe(u8, change.id) catch oom() };
            i += 1;
        };
        self.items = items;
        return self;
    }

    fn retain(self: *Changes) *Changes {
        self.refs += 1;
        return self;
    }

    fn release(self: *Changes) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        const allocator = self.arena.child_allocator;
        self.arena.deinit();
        allocator.destroy(self);
    }
};

const Window = struct {
    refs: u32 = 1,
    floor: i128,
    through: i128,
    changes: *Changes,
    loading: bool = false,

    fn retain(self: *Window) *Window {
        self.refs += 1;
        return self;
    }

    fn release(self: *Window, allocator: Allocator) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        self.changes.release();
        allocator.destroy(self);
    }
};

/// A settled facts read: the TS `Promise<MessageFacts | Error | undefined>`.
pub const Outcome = union(enum) {
    missing,
    facts: *mf.Facts,
    /// A per-ID `Error` (the message is owned by the cell).
    failure: []const u8,
};

/// One shared read (`entry.value`); compared by pointer like the TS promise.
const Cell = struct {
    refs: u32,
    state: enum { pending, ok, failed } = .pending,
    outcome: Outcome = .missing,
    /// The rejection's message (`failed`).
    reason: [MAX_TEXT]u8 = undefined,
    reason_len: usize = 0,
    /// Settle order, for `Promise.all`'s first rejection.
    seq: u64 = 0,
    waits: std.ArrayList(*LoadWait) = .empty,
    /// `projections` (TS WeakMap, #10085): one row per frontier key, at most
    /// `MAX_PROJECTIONS_PER_FACT` (cleared at the cap), in insertion order.
    memos: std.ArrayList(*Memo) = .empty,

    fn retain(self: *Cell) *Cell {
        self.refs += 1;
        return self;
    }

    fn reasonText(self: *const Cell) []const u8 {
        return self.reason[0..self.reason_len];
    }
};

/// One projection (`{ key, row }`): the row's JSON and heights, and the
/// upsert frames built from it (TS #10080 `frames`, keyed by
/// `confirmations:domain:height`), shared by every subscriber that gets it.
const Memo = struct {
    key: []u8,
    /// null: the dispatch is not visible (`row` undefined).
    data: ?[]u8,
    heights: std.AutoArrayHashMapUnmanaged(u32, i128),
    frames: std.ArrayList(struct { key: []u8, frame: *anyopaque }) = .empty,
};

const Entry = struct {
    /// TS `refs`: retained changes and loads holding this ID.
    refs: i64 = 0,
    bytes: usize = 0,
    value: ?*Cell = null,
    /// TS #10082: the settled facts (owned by `value`), for fork scoping.
    facts: ?*mf.Facts = null,
    /// Awaiting its transaction rows: re-read by the next load.
    stale: bool = false,
    /// Memory: the entries map plus batches and loads using the pointer.
    pins: u32 = 1,
    id: []u8,
};

/// A `Promise.all` over a load's cells: woken once, on the first rejection
/// or when every cell has settled.
const LoadWait = struct {
    waiter: Waiter = .{},
    unsettled: usize,
    failed: bool = false,
    woken: bool = false,
};

pub const Subscriber = struct {
    refs: u32 = 1,
    source: *MessageSource,
    subscribed: bool = true,
    confirmations: u64,
    /// The policy's domains, in URL (`Set`) order.
    domains: []u32,
    /// null: every ID; empty: none (block/rollback updates only).
    ids: ?[][]u8,
    frontiers: std.AutoArrayHashMapUnmanaged(u32, i128) = .empty,
    /// TS #10082: highest visible fact height per domain, per exposed ID.
    exposed: std.StringArrayHashMapUnmanaged(std.AutoArrayHashMapUnmanaged(u32, i128)) = .empty,
    /// The server's peer (send/fail target), valid while `subscribed`.
    peer: *anyopaque,
    /// TS #10085 `prunedAt`: the last over-limit prune (`Date.now()`).
    pruned_at: i64 = 0,

    fn retain(self: *Subscriber) *Subscriber {
        self.refs += 1;
        return self;
    }

    pub fn release(self: *Subscriber) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        const allocator = self.source.allocator;
        const source = self.source;
        self.frontiers.deinit(allocator);
        for (self.exposed.keys(), self.exposed.values()) |id, *deps| {
            allocator.free(id);
            deps.deinit(allocator);
        }
        self.exposed.deinit(allocator);
        if (self.ids) |ids| {
            for (ids) |id| allocator.free(id);
            allocator.free(ids);
        }
        allocator.free(self.domains);
        source.host.release(source.host.ctx, self.peer);
        allocator.destroy(self);
        source.release();
    }

    pub fn hasId(self: *const Subscriber, id: []const u8) bool {
        const ids = self.ids orelse return true;
        for (ids) |candidate| if (std.mem.eql(u8, candidate, id)) return true;
        return false;
    }

    /// `sub.ids?.size !== 0`.
    fn readsMessages(self: *const Subscriber) bool {
        const ids = self.ids orelse return true;
        return ids.len != 0;
    }

    fn removeExposed(self: *Subscriber, id: []const u8) void {
        const allocator = self.source.allocator;
        if (self.exposed.fetchOrderedRemove(id)) |entry| {
            allocator.free(entry.key);
            var deps = entry.value;
            deps.deinit(allocator);
        }
    }
};

/// The server side of a subscriber: its socket's queue and failure path.
pub const Host = struct {
    ctx: *anyopaque,
    /// `enqueueExplorer(socket, client, [serialize(frame)])` for a frame of its own.
    send: *const fn (ctx: *anyopaque, peer: *anyopaque, frame: []const u8) void,
    /// TS #10080 `serializeShared`: one buffer for every subscriber sent the
    /// same frame object. `make_frame` returns it with one reference.
    make_frame: *const fn (ctx: *anyopaque, bytes: []const u8) *anyopaque,
    send_frame: *const fn (ctx: *anyopaque, peer: *anyopaque, frame: *anyopaque) void,
    release_frame: *const fn (ctx: *anyopaque, frame: *anyopaque) void,
    /// `failSocket(socket, formatError(error))`.
    fail: *const fn (ctx: *anyopaque, peer: *anyopaque, message: []const u8) void,
    /// The subscriber keeps its peer alive (tasks may fail it after unsubscribe).
    retain: *const fn (ctx: *anyopaque, peer: *anyopaque) void,
    release: *const fn (ctx: *anyopaque, peer: *anyopaque) void,
};

/// A setup flow awaiting `currentHeads()`; `resume` runs as a continuation
/// (handoff) with the failure message, if the snapshot failed.
pub const HeadsWaiter = struct {
    resume_fn: *const fn (waiter: *HeadsWaiter, failure: ?[]const u8) void,
    failure: [MAX_TEXT]u8 = undefined,
    failure_len: usize = 0,
    failed: bool = false,

    pub fn run(ctx: *anyopaque) void {
        const self: *HeadsWaiter = @ptrCast(@alignCast(ctx));
        self.resume_fn(self, if (self.failed) self.failure[0..self.failure_len] else null);
    }
};

/// TS #10085 `explorerRefreshes`: publishExplorer's refreshes in flight;
/// `Promise.race` wakes every parked publisher when any one settles.
pub const Pacer = struct {
    in_flight: usize = 0,
    waiters: std.ArrayList(*Waiter) = .empty,

    pub fn deinit(self: *Pacer, allocator: Allocator) void {
        self.waiters.deinit(allocator);
    }

    fn done(self: *Pacer, loop: *Loop, allocator: Allocator) void {
        self.in_flight -= 1;
        const waiters = self.waiters.toOwnedSlice(allocator) catch oom();
        defer allocator.free(waiters);
        for (waiters) |waiter| waiter.wake(loop);
    }

    /// Task context: `while (size > MAX_EXPLORER_REFRESHES) await Promise.race(...)`.
    pub fn pace(self: *Pacer, loop: *Loop, allocator: Allocator) void {
        while (self.in_flight > MAX_EXPLORER_REFRESHES) {
            var waiter: Waiter = .{};
            self.waiters.append(allocator, &waiter) catch oom();
            waiter.park(loop);
        }
    }
};

pub const Metrics = struct { ranges: usize, changes: usize, fact_bytes: usize };

pub const MessageSource = struct {
    allocator: Allocator,
    loop: *Loop,
    store: *es.EventStore,
    host: Host,
    /// The server's reference plus one per task and subscriber.
    refs: u32 = 1,
    subscribers: std.ArrayList(*Subscriber) = .empty,
    advances: std.AutoArrayHashMapUnmanaged(u32, *Work) = .empty,
    heads: std.AutoArrayHashMapUnmanaged(u32, Head) = .empty,
    snapshot: enum { none, pending, ready } = .none,
    heads_waiters: std.ArrayList(*HeadsWaiter) = .empty,
    retry_after: std.AutoHashMapUnmanaged(u32, i64) = .empty,
    windows: std.AutoArrayHashMapUnmanaged(u32, *Window) = .empty,
    entries: std.StringArrayHashMapUnmanaged(*Entry) = .empty,
    scan: Limiter = .{ .limit = MAX_PARALLEL_DOMAINS },
    /// `hydrate` (`limitReads(2)`): batches beyond the 2 in flight wait here
    /// as descriptors (no parked thread each); a finishing batch hands its
    /// slot to the next one.
    hydrate_active: usize = 0,
    hydrate_queue: std.ArrayList(*Batch) = .empty,
    changes: usize = 0,
    bytes: usize = 0,
    stopped: bool = false,
    settle_seq: u64 = 0,
    logger: core.log.Logger,
    /// The server's `explorerRefreshes` (outlives a replaced source).
    pacer: *Pacer,
    /// TS #10082 `nextPrune` (`Date.now()` milliseconds).
    next_prune: i64 = 0,

    pub fn create(allocator: Allocator, loop: *Loop, store: *es.EventStore, host: Host, pacer: *Pacer) *MessageSource {
        const self = allocator.create(MessageSource) catch oom();
        self.* = .{ .allocator = allocator, .loop = loop, .store = store, .host = host, .logger = core.log.child("MessageSource"), .pacer = pacer };
        return self;
    }

    pub fn retain(self: *MessageSource) *MessageSource {
        self.refs += 1;
        return self;
    }

    /// Mutex held. The last reference frees the source (after `stop`).
    pub fn release(self: *MessageSource) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        std.debug.assert(self.stopped);
        const allocator = self.allocator;
        self.subscribers.deinit(allocator);
        self.advances.deinit(allocator);
        self.heads.deinit(allocator);
        self.heads_waiters.deinit(allocator);
        self.retry_after.deinit(allocator);
        self.windows.deinit(allocator);
        self.entries.deinit(allocator);
        self.scan.queue.deinit(allocator);
        self.hydrate_queue.deinit(allocator);
        allocator.destroy(self);
    }

    pub fn metrics(self: *const MessageSource) Metrics {
        return .{ .ranges = self.windows.count(), .changes = self.changes, .fact_bytes = self.bytes };
    }

    // -- Heads ---------------------------------------------------------------

    /// `currentHeads()`. `waiter` resumes as a continuation (also when the
    /// snapshot is ready: `await` on a settled promise is still a microtask).
    /// Returns true when the caller must read MESSAGE_HEADS_QUERY and report
    /// it with `headsLoaded`/`headsFailed`.
    pub fn currentHeads(self: *MessageSource, waiter: *HeadsWaiter) bool {
        switch (self.snapshot) {
            .ready => {
                self.loop.handOff(.{ .run = .{ .ctx = waiter, .func = HeadsWaiter.run } });
                return false;
            },
            .pending => {
                self.heads_waiters.append(self.allocator, waiter) catch oom();
                return false;
            },
            .none => {
                self.snapshot = .pending;
                self.heads_waiters.append(self.allocator, waiter) catch oom();
                return true;
            },
        }
    }

    pub fn headsReady(self: *const MessageSource) bool {
        return self.snapshot == .ready;
    }

    /// The snapshot's rows: domains a notification set meanwhile keep theirs.
    pub fn headsLoaded(self: *MessageSource, rows: []const Value) void {
        var parsed = parseHeads(self.allocator, rows) catch |err| return self.headsFailed(message(err));
        defer parsed.deinit(self.allocator);
        for (parsed.keys(), parsed.values()) |domain, head| {
            if (!self.heads.contains(domain)) self.heads.put(self.allocator, domain, head) catch oom();
        }
        self.snapshot = .ready;
        self.resumeHeadsWaiters(null);
    }

    pub fn headsFailed(self: *MessageSource, failure: []const u8) void {
        self.snapshot = .none;
        self.heads.clearRetainingCapacity();
        self.resumeHeadsWaiters(failure);
    }

    fn resumeHeadsWaiters(self: *MessageSource, failure: ?[]const u8) void {
        const waiters = self.heads_waiters.toOwnedSlice(self.allocator) catch oom();
        defer self.allocator.free(waiters);
        for (waiters) |waiter| {
            if (failure) |text| {
                waiter.failed = true;
                waiter.failure_len = @min(text.len, waiter.failure.len);
                @memcpy(waiter.failure[0..waiter.failure_len], text[0..waiter.failure_len]);
            }
            self.loop.handOff(.{ .run = .{ .ctx = waiter, .func = HeadsWaiter.run } });
        }
    }

    /// `messageHeads()`' rows → `new Map(...)` (a later duplicate replaces
    /// the value in place).
    pub fn parseHeads(allocator: Allocator, rows: []const Value) !std.AutoArrayHashMapUnmanaged(u32, Head) {
        var heads: std.AutoArrayHashMapUnmanaged(u32, Head) = .empty;
        errdefer heads.deinit(allocator);
        var scratch = std.heap.ArenaAllocator.init(allocator);
        defer scratch.deinit();
        for (rows) |row| {
            const domain = try es.rowDomain(row, "domain");
            var head: Head = .{
                .head = try es.parseId(row.get("head_height")),
                .indexed = try es.parseId(row.get("indexed_height")),
                .confirmed = try es.parseId(row.get("confirmed_height")),
            };
            if (try protocol.parseOptionalBlockHash(scratch.allocator(), row.get("hash"))) |hash| head.hash = hash[0..66].*;
            try heads.put(allocator, domain, head);
        }
        return heads;
    }

    /// `observe(head)`: every HEAD_CHANNEL notification, once a snapshot started.
    pub fn observe(self: *MessageSource, n: protocol.HeadNotification) void {
        if (self.snapshot == .none) return;
        const previous = self.heads.get(n.domain);
        const indexed = n.indexed_height orelse (if (previous) |p| p.indexed else return);
        const tip = n.head_height orelse (if (previous) |p| p.head else return);
        var next: Head = .{ .head = tip, .indexed = indexed, .confirmed = n.confirmed_height };
        if (n.indexed_hash) |hash| {
            if (hash.len == 66) next.hash = hash[0..66].*;
        } else if (previous) |p| {
            if (p.indexed == indexed) next.hash = p.hash;
        }
        self.heads.put(self.allocator, n.domain, next) catch oom();
        const window = self.windows.get(n.domain);
        const replaced = if (previous) |p|
            p.indexed == indexed and p.hash != null and next.hash != null and !std.mem.eql(u8, &p.hash.?, &next.hash.?)
        else
            false;
        if (replaced or (n.previous_indexed_height != null and indexed < n.previous_indexed_height.?)) {
            _ = self.advances.swapRemove(n.domain);
            if (window) |w| self.dropWindow(n.domain, w);
            if (replaced) {
                const subs = self.snapshotSubscribers();
                defer self.releaseSubscribers(subs);
                for (subs) |sub| if (sub.frontiers.contains(n.domain)) self.failSub(sub, REPLACED_MESSAGE);
            }
            // Cross-domain projections can include a removed delivery/payment
            // even when the retained change is on a different domain. Settled facts
            // list every domain they read; anything else is invalidated conservatively.
            for (self.entries.values()) |e| {
                const facts = e.facts orelse {
                    self.invalidate(e);
                    continue;
                };
                if (std.mem.indexOfScalar(u32, facts.dependencies.items, n.domain) != null) self.invalidate(e);
            }
        } else if (window) |w| {
            if (w.loading) return;
            // Retain only what the lowest active frontier has not processed; a
            // deeper late joiner expands the window backward. The fixed depth still
            // stops a stalled domain from pinning old rows forever.
            const hard = protocol.confirmationHeight(next.head, next.indexed, 2 * protocol.MAX_CONFIRMATIONS);
            const lowest = self.lowestFrontier(n.domain);
            const floor = if (lowest == null or lowest.? < hard) hard else lowest.?;
            if (floor > w.through and !self.readsDomain(n.domain)) {
                self.dropWindow(n.domain, w);
                return;
            }
            self.trim(w, if (floor < w.through) floor else w.through);
        }
    }

    pub fn invalidateIds(self: *MessageSource, ids: []const []const u8) void {
        for (ids) |id| if (self.entries.get(id)) |e| self.invalidate(e);
    }

    fn invalidate(self: *MessageSource, e: *Entry) void {
        self.bytes -= e.bytes;
        e.bytes = 0;
        if (e.value) |cell| self.releaseCell(cell);
        e.value = null;
        e.facts = null;
        e.stale = false;
    }

    fn trim(self: *MessageSource, window: *Window, floor: i128) void {
        if (floor <= window.floor) return;
        var removed: usize = 0;
        for (window.changes.items) |change| {
            if (change.height > floor) break;
            if (self.entries.get(change.id)) |e| e.refs -= 1;
            removed += 1;
        }
        if (removed > 0) {
            const rest = Changes.create(self.allocator, &.{window.changes.items[removed..]});
            window.changes.release();
            window.changes = rest;
        }
        self.changes -= removed;
        window.floor = floor;
    }

    fn dropWindow(self: *MessageSource, domain: u32, window: *Window) void {
        if (self.windows.get(domain) != window) return;
        _ = self.windows.orderedRemove(domain);
        if (window.changes.items.len > 0) self.trim(window, window.changes.items[window.changes.items.len - 1].height);
        window.release(self.allocator);
    }

    fn getEntry(self: *MessageSource, id: []const u8) error{RangeCapacity}!*Entry {
        if (self.entries.get(id)) |found| return found;
        if (self.entries.count() >= MAX_CHANGES) {
            self.evictIdle();
            if (self.entries.count() >= MAX_CHANGES) return RangeCapacity;
        }
        const created = self.allocator.create(Entry) catch oom();
        created.* = .{ .id = self.allocator.dupe(u8, id) catch oom() };
        self.entries.put(self.allocator, created.id, created) catch oom();
        return created;
    }

    fn unpin(self: *MessageSource, e: *Entry) void {
        e.pins -= 1;
        if (e.pins > 0) return;
        std.debug.assert(e.value == null);
        self.allocator.free(e.id);
        self.allocator.destroy(e);
    }

    fn readsDomain(self: *const MessageSource, domain: u32) bool {
        for (self.subscribers.items) |sub|
            if (sub.readsMessages() and sub.frontiers.contains(domain)) return true;
        return false;
    }

    fn lowestFrontier(self: *const MessageSource, domain: u32) ?i128 {
        var lowest: ?i128 = null;
        for (self.subscribers.items) |sub| {
            const frontier = sub.frontiers.get(domain) orelse continue;
            if (sub.readsMessages() and (lowest == null or frontier < lowest.?)) lowest = frontier;
        }
        return lowest;
    }

    fn evictIdle(self: *MessageSource) void {
        // An idle or offline domain may never send another head to trim its window.
        const domains = self.allocator.dupe(u32, self.windows.keys()) catch oom();
        defer self.allocator.free(domains);
        for (domains) |domain| {
            const window = self.windows.get(domain) orelse continue;
            if (!self.advances.contains(domain) and !self.readsDomain(domain)) self.dropWindow(domain, window);
        }
        // Backwards with swap removal: O(n). `entries` order is never observable
        // (only observe's invalidation, eviction and stop iterate it).
        var index = self.entries.count();
        while (index > 0) {
            index -= 1;
            const e = self.entries.values()[index];
            if (e.refs != 0 or (e.value != null and e.bytes == 0)) continue;
            self.invalidate(e);
            self.entries.swapRemoveAt(index);
            self.unpin(e);
        }
    }

    fn releaseCell(self: *MessageSource, cell: *Cell) void {
        cell.refs -= 1;
        if (cell.refs > 0) return;
        std.debug.assert(cell.waits.items.len == 0);
        switch (cell.outcome) {
            .missing => {},
            .facts => |facts| facts.destroy(),
            .failure => |text| self.allocator.free(text),
        }
        for (cell.memos.items) |memo| self.freeMemo(memo);
        cell.memos.deinit(self.allocator);
        cell.waits.deinit(self.allocator);
        self.allocator.destroy(cell);
    }

    fn freeMemo(self: *MessageSource, memo: *Memo) void {
        self.allocator.free(memo.key);
        if (memo.data) |data| self.allocator.free(data);
        memo.heights.deinit(self.allocator);
        for (memo.frames.items) |item| {
            self.allocator.free(item.key);
            self.host.release_frame(self.host.ctx, item.frame);
        }
        memo.frames.deinit(self.allocator);
        self.allocator.destroy(memo);
    }

    // -- Facts reads ---------------------------------------------------------

    const Batch = struct {
        source: *MessageSource,
        ids: [][]const u8,
        entries: []*Entry,
        cells: []*Cell,
    };

    /// `fetchBatch(batch)`: the cells are installed now; the read runs as a task.
    fn fetchBatch(self: *MessageSource, batch: []const *Entry) void {
        const b = self.allocator.create(Batch) catch oom();
        b.* = .{
            .source = self.retain(),
            .ids = self.allocator.alloc([]const u8, batch.len) catch oom(),
            .entries = self.allocator.dupe(*Entry, batch) catch oom(),
            .cells = self.allocator.alloc(*Cell, batch.len) catch oom(),
        };
        for (batch, b.ids, b.cells) |e, *id, *cell| {
            id.* = self.allocator.dupe(u8, e.id) catch oom();
            e.pins += 1;
            const created = self.allocator.create(Cell) catch oom();
            // The entry's reference and the batch's.
            created.* = .{ .refs = 2 };
            cell.* = created;
            e.value = created;
        }
        if (self.hydrate_active < MAX_FACT_QUERIES) {
            self.hydrate_active += 1;
            self.loop.spawn(runBatch, .{b});
        } else if (self.hydrate_queue.items.len >= MAX_READ_QUEUE) {
            // TS rejects `result` asynchronously: the cells settle as failed now
            // (load's Promise.all sees the queue-full text), and each entry's
            // `.catch` invalidation follows as a microtask, after load's check
            // that every entry still has its value.
            for (b.cells) |cell| self.settle(cell, .failed, .missing, QUEUE_FULL_MESSAGE);
            self.loop.handOff(.{ .run = .{ .ctx = b, .func = invalidateRejectedBatch } });
        } else self.hydrate_queue.append(self.allocator, b) catch oom();
    }

    fn invalidateRejectedBatch(ctx: *anyopaque) void {
        const b: *Batch = @ptrCast(@alignCast(ctx));
        const self = b.source;
        for (b.entries, b.cells) |e, cell| if (e.value == cell) self.invalidate(e);
        self.freeBatch(b);
    }

    /// The `finally` of a batch read: the slot goes to the next queued batch.
    fn releaseHydrate(self: *MessageSource) void {
        if (self.hydrate_queue.items.len > 0) {
            self.loop.spawn(runBatch, .{self.hydrate_queue.orderedRemove(0)});
        } else self.hydrate_active -= 1;
    }

    fn freeBatch(self: *MessageSource, b: *Batch) void {
        for (b.ids) |id| self.allocator.free(id);
        self.allocator.free(b.ids);
        for (b.entries) |e| self.unpin(e);
        self.allocator.free(b.entries);
        for (b.cells) |cell| self.releaseCell(cell);
        self.allocator.free(b.cells);
        self.allocator.destroy(b);
        self.release();
    }

    fn runBatch(b: *Batch) void {
        const self = b.source;
        defer self.freeBatch(b);
        var collected: ?mf.Collected = null;
        var failure: ?[]const u8 = null;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        read: {
            // Read every scheduled ID (TS #10079): a filtered ID would be cached
            // as a missing message and served to a later subscriber that wants it.
            if (self.stopped) break :read;
            const rows = self.store.messageFacts(arena.allocator(), b.ids) catch |err| {
                failure = arena.allocator().dupe(u8, message(err)) catch oom();
                break :read;
            };
            collected = mf.collect(self.allocator, rows) catch oom();
        }
        self.releaseHydrate();
        defer if (collected) |*c| c.deinit();
        for (b.ids, b.entries, b.cells) |id, e, cell| {
            if (failure) |text| {
                self.reject(e, cell, text);
                continue;
            }
            const outcome: Outcome = blk: {
                const c = if (collected) |*c| c else break :blk .missing;
                const taken = c.take(id) orelse break :blk .missing;
                break :blk switch (taken) {
                    .facts => |facts| .{ .facts = facts },
                    .failure => |text| .{ .failure = text },
                };
            };
            if (e.value == cell) {
                const bytes: usize = switch (outcome) {
                    .facts => |facts| facts.bytes,
                    else => 1,
                };
                if (self.bytes + bytes > MAX_FACT_BYTES) self.evictIdle();
                if (self.bytes + bytes > MAX_FACT_BYTES) {
                    freeOutcome(self.allocator, outcome);
                    self.reject(e, cell, BYTE_LIMIT_MESSAGE);
                    continue;
                }
                e.bytes = bytes;
                self.bytes += bytes;
                if (outcome == .facts) {
                    e.facts = outcome.facts;
                    e.stale = awaitingTransactions(outcome.facts);
                }
            }
            self.settle(cell, .ok, outcome, "");
        }
    }

    /// Origin/destination transaction rows join after the dispatch or delivery.
    fn awaitingTransactions(facts: *const mf.Facts) bool {
        for (facts.pending) |member| if (std.mem.eql(u8, member.key, "origin_tx_id")) {
            if (member.value == .null) return true;
            break;
        };
        const delivery = facts.delivery orelse return false;
        for (delivery.fields) |field| if (std.mem.eql(u8, field.key, "destination_tx_id")) return field.value == .null;
        return false;
    }

    fn freeOutcome(allocator: Allocator, outcome: Outcome) void {
        switch (outcome) {
            .missing => {},
            .facts => |facts| facts.destroy(),
            .failure => |text| allocator.free(text),
        }
    }

    /// `.catch`: a rejected read leaves its entry unloaded.
    fn reject(self: *MessageSource, e: *Entry, cell: *Cell, reason: []const u8) void {
        if (e.value == cell) self.invalidate(e);
        self.settle(cell, .failed, .missing, reason);
    }

    fn settle(self: *MessageSource, cell: *Cell, state: @TypeOf(@as(Cell, undefined).state), outcome: Outcome, reason: []const u8) void {
        cell.state = state;
        cell.outcome = outcome;
        cell.reason_len = @min(reason.len, cell.reason.len);
        @memcpy(cell.reason[0..cell.reason_len], reason[0..cell.reason_len]);
        self.settle_seq += 1;
        cell.seq = self.settle_seq;
        const waits = cell.waits.toOwnedSlice(self.allocator) catch oom();
        defer self.allocator.free(waits);
        for (waits) |wait| {
            wait.unsettled -= 1;
            if (state == .failed) wait.failed = true;
            if (!wait.woken and (wait.failed or wait.unsettled == 0)) {
                wait.woken = true;
                wait.waiter.wake(self.loop);
            }
        }
    }

    /// A load's settled cells by ID, in `reads` order; release with `deinit`.
    const Loaded = struct {
        ids: []const []const u8,
        cells: []*Cell,
        /// `new Map(...)`: id → index in `ids`/`cells`.
        index: std.StringHashMapUnmanaged(usize) = .empty,

        fn get(self: *const Loaded, id: []const u8) ?*Cell {
            const i = self.index.get(id) orelse return null;
            return self.cells[i];
        }

        fn deinit(self: *Loaded, source: *MessageSource) void {
            for (self.cells) |cell| source.releaseCell(cell);
            source.allocator.free(self.cells);
            source.allocator.free(self.ids);
            self.index.deinit(source.allocator);
        }
    };

    /// `load(ids)` (task context: may park). `ids` must outlive the result.
    fn load(self: *MessageSource, ids: []const []const u8) !Loaded {
        var reads: std.ArrayList(*Entry) = .empty;
        defer {
            for (reads.items) |e| {
                e.refs -= 1;
                self.unpin(e);
            }
            reads.deinit(self.allocator);
        }
        for (ids) |id| {
            const e = try self.getEntry(id);
            e.refs += 1;
            e.pins += 1;
            if (e.stale) self.invalidate(e);
            reads.append(self.allocator, e) catch oom();
        }
        // Recheck the entire batch after the last read settles. A receipt or fork
        // can invalidate an early result while another ID is still loading.
        var attempt: usize = 0;
        while (attempt < 3 and !self.stopped) : (attempt += 1) {
            var missing: std.ArrayList(*Entry) = .empty;
            defer missing.deinit(self.allocator);
            for (reads.items) |e| if (e.value == null) missing.append(self.allocator, e) catch oom();
            var start: usize = 0;
            while (start < missing.items.len) : (start += FACT_BATCH_SIZE)
                self.fetchBatch(missing.items[start..@min(start + FACT_BATCH_SIZE, missing.items.len)]);
            const pending = self.allocator.alloc(*Cell, reads.items.len) catch oom();
            var held: usize = 0;
            errdefer {
                for (pending[0..held]) |cell| self.releaseCell(cell);
                self.allocator.free(pending);
            }
            for (reads.items) |e| {
                const cell = e.value orelse return runtime.fail("{s}", .{MISSING_READ_MESSAGE});
                pending[held] = cell.retain();
                held += 1;
            }
            try self.awaitAll(pending);
            const same = for (reads.items, pending) |e, cell| {
                if (e.value != cell) break false;
            } else true;
            if (same) {
                var loaded: Loaded = .{ .ids = self.allocator.dupe([]const u8, ids) catch oom(), .cells = pending };
                loaded.index.ensureTotalCapacity(self.allocator, @intCast(ids.len)) catch oom();
                for (loaded.ids, 0..) |id, i| loaded.index.putAssumeCapacity(id, i);
                return loaded;
            }
            for (pending) |cell| self.releaseCell(cell);
            self.allocator.free(pending);
        }
        // Every invalidation schedules its own refresh or advance: callers retry.
        return error.Invalidated;
    }

    /// `await Promise.all(pending)`: the first rejection (in settle order)
    /// fails it; otherwise it resolves when every cell has settled.
    fn awaitAll(self: *MessageSource, cells: []const *Cell) !void {
        var wait: LoadWait = .{ .unsettled = 0 };
        for (cells) |cell| {
            if (cell.state == .failed) wait.failed = true;
            if (cell.state != .pending) continue;
            wait.unsettled += 1;
            cell.waits.append(self.allocator, &wait) catch oom();
        }
        if (!wait.failed and wait.unsettled > 0) wait.waiter.park(self.loop);
        // Deregister from cells still pending (a rejection woke us early).
        for (cells) |cell| {
            if (cell.state != .pending) continue;
            for (cell.waits.items, 0..) |candidate, i| if (candidate == &wait) {
                _ = cell.waits.orderedRemove(i);
                break;
            };
        }
        var first: ?*Cell = null;
        for (cells) |cell| if (cell.state == .failed and (first == null or cell.seq < first.?.seq)) {
            first = cell;
        };
        if (first) |cell| return runtime.fail("{s}", .{cell.reasonText()});
    }

    // -- Subscribers -----------------------------------------------------------

    pub const Subscription = struct {
        sub: *Subscriber,
        /// `[...frontiers.keys()]` and the rest, both in URL order.
        custom_domains: []u32,
        canonical_domains: []u32,

        pub fn deinit(self: *Subscription, allocator: Allocator) void {
            allocator.free(self.custom_domains);
            allocator.free(self.canonical_domains);
        }
    };

    /// `subscribe(policy, ids, send, fail)`. The caller keeps `sub` (one
    /// reference) and calls `unsubscribe` when its socket goes away.
    pub fn subscribe(self: *MessageSource, confirmations: u64, domains: []const u32, ids: ?[]const []const u8, peer: *anyopaque) Subscription {
        const sub = self.allocator.create(Subscriber) catch oom();
        sub.* = .{
            .source = self.retain(),
            .confirmations = confirmations,
            .domains = self.allocator.dupe(u32, domains) catch oom(),
            .ids = if (ids) |list| blk: {
                const out = self.allocator.alloc([]u8, list.len) catch oom();
                for (list, out) |id, *copy| copy.* = self.allocator.dupe(u8, id) catch oom();
                break :blk out;
            } else null,
            .peer = peer,
        };
        self.host.retain(self.host.ctx, peer);
        var custom: std.ArrayList(u32) = .empty;
        var canonical: std.ArrayList(u32) = .empty;
        for (domains) |domain| {
            if (self.heads.get(domain)) |head| {
                sub.frontiers.put(self.allocator, domain, protocol.confirmationHeight(head.head, head.indexed, confirmations)) catch oom();
                custom.append(self.allocator, domain) catch oom();
            } else canonical.append(self.allocator, domain) catch oom();
        }
        self.subscribers.append(self.allocator, sub.retain()) catch oom();
        return .{
            .sub = sub,
            .custom_domains = custom.toOwnedSlice(self.allocator) catch oom(),
            .canonical_domains = canonical.toOwnedSlice(self.allocator) catch oom(),
        };
    }

    /// The subscription's `unsubscribe()` (on the source it subscribed to).
    pub fn unsubscribe(sub: *Subscriber) void {
        const self = sub.source;
        self.removeSubscriber(sub);
        for (sub.frontiers.keys()) |domain| {
            if (self.readsDomain(domain)) continue;
            _ = self.advances.swapRemove(domain);
            if (self.windows.get(domain)) |window| self.dropWindow(domain, window);
        }
    }

    /// `this.subscribers.delete(sub)`.
    fn removeSubscriber(self: *MessageSource, sub: *Subscriber) void {
        for (self.subscribers.items, 0..) |candidate, i| if (candidate == sub) {
            _ = self.subscribers.orderedRemove(i);
            sub.subscribed = false;
            sub.release();
            return;
        };
    }

    fn isSubscribed(self: *const MessageSource, sub: *const Subscriber) bool {
        _ = self;
        return sub.subscribed;
    }

    /// Live `Set` iteration: a snapshot (callers skip removed subscribers).
    fn snapshotSubscribers(self: *MessageSource) []*Subscriber {
        const subs = self.allocator.dupe(*Subscriber, self.subscribers.items) catch oom();
        for (subs) |sub| _ = sub.retain();
        return subs;
    }

    fn releaseSubscribers(self: *MessageSource, subs: []*Subscriber) void {
        for (subs) |sub| sub.release();
        self.allocator.free(subs);
    }

    /// `sub.fail(error)`: `failSocket`, a no-op for a socket already gone.
    fn failSub(self: *MessageSource, sub: *Subscriber, text: []const u8) void {
        self.host.fail(self.host.ctx, sub.peer, text);
    }

    fn send(self: *MessageSource, sub: *Subscriber, frame: []const u8) void {
        self.host.send(self.host.ctx, sub.peer, frame);
    }

    // -- Notify / advance ------------------------------------------------------

    /// `notify(event)`: from `notifyConfirmationStreams`.
    pub fn notify(self: *MessageSource, n: protocol.HeadNotification) void {
        const indexed = n.indexed_height orelse return;
        const tip = n.head_height orelse return;
        const domain = n.domain;
        const rollback = n.previous_indexed_height != null and indexed < n.previous_indexed_height.?;
        // `refresh`: subscriber → ids, in subscriber order (TS #10082).
        var selections: std.ArrayList(Selection) = .empty;
        defer selections.deinit(self.allocator);
        var needed = false;
        const subs = self.snapshotSubscribers();
        defer self.releaseSubscribers(subs);
        for (subs) |sub| {
            if (!sub.subscribed) continue;
            const from = sub.frontiers.get(domain) orelse continue;
            const to = protocol.confirmationHeight(tip, indexed, sub.confirmations);
            if (rollback) {
                if (to < from) {
                    sub.frontiers.put(self.allocator, domain, to) catch oom();
                    self.sendRollback(sub, domain, from, to);
                }
                // Rows whose facts on this domain all survive the rewind are intact.
                // Without a lower frontier, a removed payment can still shift a fold.
                const floor = if (to < from) to else indexed;
                var ids: std.StringArrayHashMapUnmanaged(void) = .empty;
                self.compactExposed(sub, .{ .domain = domain, .floor = floor, .ids = &ids });
                if (ids.count() > 0) {
                    selections.append(self.allocator, .{ .sub = sub.retain(), .ids = ids }) catch oom();
                } else ids.deinit(self.allocator);
            }
            if (to > from and sub.readsMessages()) needed = true;
            if (!sub.readsMessages()) sub.frontiers.put(self.allocator, domain, to) catch oom();
        }
        const now = self.loop.now();
        if ((n.previous_confirmed_height == null or n.previous_confirmed_height.? != n.confirmed_height) and now >= self.next_prune) {
            // Exposure only feeds the rollback refresh and the size limit, and both
            // re-check settlement, so pruning at most once per interval is enough.
            self.next_prune = now + PRUNE_INTERVAL_MS;
            for (self.subscribers.items) |sub| self.prune(sub);
        }
        if (selections.items.len > 0) {
            var union_ids: std.StringArrayHashMapUnmanaged(void) = .empty;
            defer union_ids.deinit(self.allocator);
            for (selections.items) |selection| for (selection.ids.keys()) |id| union_ids.put(self.allocator, id, {}) catch oom();
            const job = self.newRefreshJob(union_ids.keys(), selections.items);
            selections.clearRetainingCapacity(); // owned by the job now
            self.loop.spawn(runRefresh, .{job});
        }
        if (self.advances.get(domain)) |pending| {
            pending.* = .{ .head = tip, .indexed = indexed, .confirmed = n.confirmed_height, .version = pending.version + 1 };
        } else if (needed and (self.retry_after.get(domain) orelse 0) <= now) {
            _ = self.retry_after.remove(domain);
            const work = self.allocator.create(Work) catch oom();
            work.* = .{ .head = tip, .indexed = indexed, .confirmed = n.confirmed_height };
            self.advances.put(self.allocator, domain, work) catch oom();
            self.loop.spawn(runAdvance, .{ self.retain(), domain, work });
        }
    }

    /// One rollback refresh target: its subscriber (a reference) and owned ids.
    const Selection = struct { sub: *Subscriber, ids: std.StringArrayHashMapUnmanaged(void) };

    /// `settled(sub, heights)`: a rollback never rewinds below the confirmed
    /// height, so facts at or below it stay visible to this subscriber.
    fn settled(self: *const MessageSource, sub: *const Subscriber, heights: *const std.AutoArrayHashMapUnmanaged(u32, i128)) bool {
        for (heights.keys(), heights.values()) |domain, height| {
            // Only a rollback on a followed domain refreshes this subscriber (#10085).
            if (!sub.frontiers.contains(domain)) continue;
            const confirmed: i128 = if (self.heads.get(domain)) |h| h.confirmed else 0;
            if (height > confirmed - @as(i128, sub.confirmations)) return false;
        }
        return true;
    }

    fn prune(self: *const MessageSource, sub: *Subscriber) void {
        self.compactExposed(sub, null);
    }

    /// One ordered pass over `sub.exposed` (O(n)): drop settled ids and, for a
    /// rollback, select (in Map order) the kept ids with a fact above `floor`
    /// on `domain` (an owned copy of each id goes into `ids`).
    fn compactExposed(self: *const MessageSource, sub: *Subscriber, select: ?struct { domain: u32, floor: i128, ids: *std.StringArrayHashMapUnmanaged(void) }) void {
        const allocator = self.allocator;
        var kept: std.StringArrayHashMapUnmanaged(std.AutoArrayHashMapUnmanaged(u32, i128)) = .empty;
        kept.ensureTotalCapacity(allocator, sub.exposed.count()) catch oom();
        for (sub.exposed.keys(), sub.exposed.values()) |id, *heights| {
            if (self.settled(sub, heights)) {
                allocator.free(id);
                heights.deinit(allocator);
                continue;
            }
            if (select) |sel| if ((heights.get(sel.domain) orelse sel.floor) > sel.floor)
                sel.ids.put(allocator, allocator.dupe(u8, id) catch oom(), {}) catch oom();
            kept.putAssumeCapacity(id, heights.*);
        }
        sub.exposed.deinit(allocator);
        sub.exposed = kept;
    }

    fn sendRollback(self: *MessageSource, sub: *Subscriber, domain: u32, from: i128, to: i128) void {
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        var o = frames.Object.begin(&out.writer) catch oom();
        o.string("type", "rollback") catch oom();
        o.int("domain", domain) catch oom();
        o.int("confirmations", sub.confirmations) catch oom();
        o.bigString("fromHeight", from) catch oom();
        o.bigString("toHeight", to) catch oom();
        o.end() catch oom();
        self.send(sub, out.written());
    }

    const Range = struct { sub: *Subscriber, from: i128, to: i128 };
    const Release = struct { sub: *Subscriber, to: i128, start: usize, end: usize };

    fn runAdvance(self: *MessageSource, domain: u32, work: *Work) void {
        defer {
            if (self.advances.get(domain) == work) _ = self.advances.swapRemove(domain);
            self.allocator.destroy(work);
            self.release();
        }
        self.advance(domain, work) catch |err| {
            // TS #10079: frontiers have not moved, so subscribers lose nothing by
            // waiting. Back off instead of rescanning a failing domain on every head.
            self.warnWith(.{ .domain = domain }, message(err), "Message range read failed; retrying after backoff");
            if (self.advances.get(domain) != work) return;
            self.retry_after.put(self.allocator, domain, self.loop.now() + DOMAIN_RETRY_MS) catch oom();
            if (self.windows.get(domain)) |window| self.dropWindow(domain, window);
        };
    }

    fn advance(self: *MessageSource, domain: u32, work: *Work) !void {
        while (self.advances.get(domain) == work) {
            const head = work.*;
            var ranges: std.ArrayList(Range) = .empty;
            defer {
                for (ranges.items) |range| range.sub.release();
                ranges.deinit(self.allocator);
            }
            for (self.subscribers.items) |sub| {
                const from = sub.frontiers.get(domain) orelse continue;
                const to = protocol.confirmationHeight(head.head, head.indexed, sub.confirmations);
                if (from < to and sub.readsMessages()) ranges.append(self.allocator, .{ .sub = sub.retain(), .from = from, .to = to }) catch oom();
            }
            if (ranges.items.len == 0) return;
            var after = ranges.items[0].from;
            for (ranges.items) |range| after = @min(after, range.from);
            const window = self.prepare(domain, after, head) catch |err| {
                if (err != RangeCapacity) return err;
                if (self.windows.get(domain)) |retained| {
                    if (retained.floor == retained.through) self.dropWindow(domain, retained);
                }
                // The deepest cursor owns an expansion that does not fit. Preserve
                // the existing window and let shallower subscribers advance.
                for (ranges.items) |range| if (range.from == after) {
                    self.removeSubscriber(range.sub);
                    self.failSub(range.sub, RANGE_CAPACITY_MESSAGE);
                };
                continue;
            };
            defer window.release(self.allocator);
            if (self.advances.get(domain) != work) return;
            // Keep one range per domain. Store only two indexes per subscriber,
            // even when every browser subscribes to the same busy chain.
            const changes = window.changes.retain();
            defer changes.release();
            var ids: std.StringArrayHashMapUnmanaged(void) = .empty;
            defer ids.deinit(self.allocator);
            var releases: std.ArrayList(Release) = .empty;
            defer releases.deinit(self.allocator);
            for (ranges.items) |range| {
                if (!range.sub.subscribed) continue;
                if (range.from < window.floor) {
                    self.failSub(range.sub, BEHIND_MESSAGE);
                    continue;
                }
                const start = firstAfter(changes.items, range.from);
                const end = firstAfter(changes.items, range.to);
                for (changes.items[start..end]) |change|
                    if (range.sub.hasId(change.id)) ids.put(self.allocator, change.id, {}) catch oom();
                releases.append(self.allocator, .{ .sub = range.sub, .to = range.to, .start = start, .end = end }) catch oom();
            }
            var loaded = self.load(ids.keys()) catch |err| switch (err) {
                error.Invalidated => continue,
                else => return err,
            };
            defer loaded.deinit(self);
            if (self.advances.get(domain) != work) return;
            for (releases.items) |rel| {
                const sub = rel.sub;
                if (!sub.subscribed or rel.to > protocol.confirmationHeight(work.head, work.indexed, sub.confirmations)) continue;
                sub.frontiers.put(self.allocator, domain, rel.to) catch oom();
                var sent: std.StringHashMapUnmanaged(void) = .empty;
                defer sent.deinit(self.allocator);
                var i = rel.start;
                while (i < rel.end and sub.subscribed) : (i += 1) {
                    const id = changes.items[i].id;
                    if (!sub.hasId(id) or sent.contains(id)) continue;
                    sent.put(self.allocator, id, {}) catch oom();
                    self.upsert(sub, id, loaded.get(id), .{ .domain = domain, .height = rel.to });
                }
            }
            if (head.version == work.version) return;
        }
    }

    /// `prepare(domain, after, head)`: the returned window carries a reference.
    fn prepare(self: *MessageSource, domain: u32, after: i128, head: Work) !*Window {
        const window = self.windows.get(domain) orelse blk: {
            const created = self.allocator.create(Window) catch oom();
            created.* = .{ .floor = after, .through = after, .changes = Changes.create(self.allocator, &.{}) };
            self.windows.put(self.allocator, domain, created) catch oom();
            break :blk created;
        };
        const current = window.retain();
        defer current.release(self.allocator);
        const through = protocol.confirmationHeight(head.head, head.indexed, 0);
        if (after < current.floor or current.through < through) {
            current.loading = true;
            defer current.loading = false;
            self.scan.acquire(self.loop, self.allocator) catch return runtime.fail("{s}", .{QUEUE_FULL_MESSAGE});
            defer self.scan.release(self.loop);
            try self.scanRange(domain, current, after, through);
        }
        if (self.readsDomain(domain) and self.windows.get(domain) == current and current.through < through)
            return self.prepare(domain, after, head);
        return current.retain();
    }

    fn scanActive(self: *const MessageSource, domain: u32, current: *Window) bool {
        return !self.stopped and self.windows.get(domain) == current and self.readsDomain(domain);
    }

    /// The `scan` body: page through `messageChanges` and install the range.
    fn scanRange(self: *MessageSource, domain: u32, current: *Window, after: i128, through: i128) !void {
        if (!self.scanActive(domain, current)) return;
        const backward = after < current.floor;
        const start = if (backward) after else current.through;
        const end = if (backward) current.floor else through;
        var prefix = std.heap.ArenaAllocator.init(self.allocator);
        defer prefix.deinit();
        var added: std.ArrayList(Change) = .empty;
        var installed = false;
        defer if (!installed) for (added.items) |change| {
            if (self.entries.get(change.id)) |e| e.refs -= 1;
            self.changes -= 1;
        };
        var position = protocol.endOfHeight(start);
        while (true) {
            var page_arena = std.heap.ArenaAllocator.init(self.allocator);
            defer page_arena.deinit();
            const rows = try self.store.messageChanges(page_arena.allocator(), domain, position, end);
            if (rows.len == 0) break;
            const page = try parseChanges(prefix.allocator(), rows, &position);
            if (!self.scanActive(domain, current)) return;
            if (self.changes + page.len > MAX_CHANGES) self.evictIdle();
            if (self.changes + page.len > MAX_CHANGES) return RangeCapacity;
            for (page) |change| {
                const e = try self.getEntry(change.id);
                e.refs += 1;
                // Cached facts already reflect older changes; only new ones can
                // make them stale (#10085).
                if (start >= current.floor) self.invalidate(e);
                added.append(prefix.allocator(), change) catch oom();
                self.changes += 1;
            }
            // Check before the iterator can issue its next page query.
            if (!self.scanActive(domain, current)) return;
            if (rows.len < self.store.batch_size) break;
        }
        if (!self.scanActive(domain, current)) return;
        const merged = if (start < current.floor)
            Changes.create(self.allocator, &.{ added.items, current.changes.items })
        else
            Changes.create(self.allocator, &.{ current.changes.items, added.items });
        current.changes.release();
        current.changes = merged;
        if (start < current.floor) current.floor = start else current.through = through;
        installed = true;
    }

    /// One `messageChanges` page: `{ height, id: msg_id }`, advancing `position`.
    fn parseChanges(a: Allocator, rows: []const Value, position: *protocol.Position) ![]Change {
        const page = a.alloc(Change, rows.len) catch oom();
        for (rows, page) |row, *change| {
            const source = row.get("source");
            position.* = .{
                .height = try es.parseId(row.get("height")),
                .source = if (source != null and source.? == .number) @intFromFloat(source.?.number) else 0,
                .id = try es.parseId(row.get("id")),
            };
            const id = row.get("msg_id");
            change.* = .{ .height = position.height, .id = a.dupe(u8, if (id != null and id.? == .string) id.?.string else "") catch oom() };
        }
        return page;
    }

    // -- Refresh -----------------------------------------------------------------

    const RefreshJob = struct {
        source: *MessageSource,
        ids: [][]const u8,
        /// `[...targets]`, taken when the refresh is called.
        targets: []*Subscriber,
        /// Rollback refreshes: each target's ids (aligned with `targets`).
        selections: ?[]std.StringArrayHashMapUnmanaged(void) = null,
        /// Counted in the pacer (publishExplorer's refreshes).
        paced: bool = false,
    };

    /// `void this.refresh(ids)`: every current subscriber (TS #10079: not awaited).
    pub fn refreshIds(self: *MessageSource, ids: []const []const u8) void {
        const job = self.newRefreshJob(ids, null);
        job.paced = true;
        self.pacer.in_flight += 1;
        self.loop.spawn(runRefresh, .{job});
    }

    /// The job owns `selections`' subscriber references and id sets.
    fn newRefreshJob(self: *MessageSource, ids: []const []const u8, selections: ?[]const Selection) *RefreshJob {
        const job = self.allocator.create(RefreshJob) catch oom();
        job.* = .{
            .source = self.retain(),
            .ids = self.allocator.alloc([]const u8, ids.len) catch oom(),
            .targets = undefined,
        };
        for (ids, job.ids) |id, *copy| copy.* = self.allocator.dupe(u8, id) catch oom();
        if (selections) |list| {
            job.targets = self.allocator.alloc(*Subscriber, list.len) catch oom();
            const sets = self.allocator.alloc(std.StringArrayHashMapUnmanaged(void), list.len) catch oom();
            for (list, job.targets, sets) |selection, *target, *set| {
                target.* = selection.sub;
                set.* = selection.ids;
            }
            job.selections = sets;
        } else job.targets = self.snapshotSubscribers();
        return job;
    }

    fn runRefresh(job: *RefreshJob) void {
        const self = job.source;
        defer {
            for (job.ids) |id| self.allocator.free(id);
            self.allocator.free(job.ids);
            self.releaseSubscribers(job.targets);
            if (job.selections) |sets| {
                for (sets) |*set| {
                    for (set.keys()) |id| self.allocator.free(id);
                    set.deinit(self.allocator);
                }
                self.allocator.free(sets);
            }
            const paced = job.paced;
            self.allocator.destroy(job);
            if (paced) self.pacer.done(self.loop, self.allocator);
            self.release();
        }
        self.refresh(job);
    }

    /// `refresh(ids, rollback?)` (task context).
    fn refresh(self: *MessageSource, job: *const RefreshJob) void {
        const recipients = job.targets;
        var selected: std.ArrayList([]const u8) = .empty;
        defer selected.deinit(self.allocator);
        for (job.ids) |id| {
            for (recipients, 0..) |sub, i| if (interested(job, sub, i, id)) {
                selected.append(self.allocator, id) catch oom();
                break;
            };
        }
        if (selected.items.len == 0) return;
        const rollback_refresh = job.selections != null;
        var loaded: Loaded = while (!self.stopped and listening(recipients)) {
            break self.load(selected.items) catch |err| switch (err) {
                error.Invalidated => continue,
                else => {
                    const text = message(err);
                    var copy: [MAX_TEXT]u8 = undefined;
                    const reason = copy[0..@min(text.len, copy.len)];
                    @memcpy(reason, text[0..reason.len]);
                    // A global stream keeps its rows; the next refresh or advance
                    // retries. An ID subscription or a rollback refresh cannot
                    // leave a stale row (#10085).
                    var skipped = false;
                    for (recipients, 0..) |sub, i| {
                        if (!sub.subscribed) continue;
                        for (selected.items) |id| if (interested(job, sub, i, id)) {
                            if (sub.ids != null or rollback_refresh) self.failSub(sub, reason) else skipped = true;
                            break;
                        };
                    }
                    if (skipped) self.warnWith(.{}, reason, "Message refresh failed; global streams keep their rows");
                    return;
                },
            };
        } else return;
        defer loaded.deinit(self);
        const rollback = rollback_refresh;
        for (recipients, 0..) |sub, i| for (loaded.ids, loaded.cells) |id, cell| {
            if (!sub.subscribed) break;
            if (!interested(job, sub, i, id)) continue;
            const show = switch (cell.outcome) {
                .missing => false,
                .failure => true,
                .facts => |facts| rollback or containsDomain(sub.domains, facts.origin) or containsDomain(sub.domains, facts.destination),
            };
            if (show) self.upsert(sub, id, cell, null);
        };
    }

    fn listening(recipients: []const *Subscriber) bool {
        for (recipients) |sub| if (sub.subscribed) return true;
        return false;
    }

    /// pino `logger.warn({ ...fields, error }, msg)`.
    fn warnWith(self: *MessageSource, fields: anytype, err_text: []const u8, comptime msg: []const u8) void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var object: json.ObjectBuilder = .{};
        inline for (std.meta.fields(@TypeOf(fields))) |field| object.putNew(a, field.name, json.int(@field(fields, field.name))) catch oom();
        object.putNew(a, "error", .{ .string = err_text }) catch oom();
        self.logger.withFields(.warn, object.finish(a) catch oom(), msg, .{});
    }

    fn interested(job: *const RefreshJob, sub: *const Subscriber, index: usize, id: []const u8) bool {
        if (!sub.hasId(id)) return false;
        const sets = job.selections orelse return true;
        return sets[index].contains(id);
    }

    fn containsDomain(domains: []const u32, domain: u32) bool {
        return std.mem.indexOfScalar(u32, domains, domain) != null;
    }

    // -- Upsert ------------------------------------------------------------------

    const Fields = struct { domain: u32, height: i128 };

    fn upsert(self: *MessageSource, sub: *Subscriber, id: []const u8, cell_opt: ?*Cell, fields: ?Fields) void {
        const outcome: Outcome = if (cell_opt) |cell| cell.outcome else .missing;
        switch (outcome) {
            .failure => |text| {
                sub.removeExposed(id);
                if (sub.ids != null) return self.failSub(sub, text);
                var out: std.Io.Writer.Allocating = .init(self.allocator);
                defer out.deinit();
                var o = frames.Object.begin(&out.writer) catch oom();
                o.string("type", "error") catch oom();
                o.string("messageId", id) catch oom();
                o.string("error", text) catch oom();
                o.end() catch oom();
                return self.send(sub, out.written());
            },
            .missing => return sub.removeExposed(id),
            .facts => {},
        }
        const cell = cell_opt.?;
        const memo = self.project(cell, sub);
        if (memo.data == null) return sub.removeExposed(id);
        // Only facts above this subscriber's settled height can change in a
        // rollback (TS #10082).
        if (self.settled(sub, &memo.heights)) {
            sub.removeExposed(id);
        } else {
            const slot = sub.exposed.getOrPut(self.allocator, id) catch oom();
            if (slot.found_existing) {
                slot.value_ptr.deinit(self.allocator);
            } else slot.key_ptr.* = self.allocator.dupe(u8, id) catch oom();
            slot.value_ptr.* = memo.heights.clone(self.allocator) catch oom();
        }
        if (sub.exposed.count() > MAX_EXPOSED) {
            // A full prune is O(exposed); a subscriber pinned at the limit should
            // not pay it on every row.
            const now = self.loop.now();
            if (sub.pruned_at + PRUNE_INTERVAL_MS <= now) {
                sub.pruned_at = now;
                self.prune(sub);
            }
        }
        if (sub.exposed.count() > MAX_EXPOSED) return self.failSub(sub, EXPOSED_MESSAGE);
        self.host.send_frame(self.host.ctx, sub.peer, self.upsertFrame(memo, sub.confirmations, fields));
    }

    /// `upsertFrame(data, confirmations, fields)`: one frame per projection and
    /// `confirmations:domain:height` (TS #10080), so subscribers share its buffer.
    fn upsertFrame(self: *MessageSource, memo: *Memo, confirmations: u64, fields: ?Fields) *anyopaque {
        var key_buf: [96]u8 = undefined;
        const key = if (fields) |f|
            std.fmt.bufPrint(&key_buf, "{d}:{d}:{d}", .{ confirmations, f.domain, f.height }) catch unreachable
        else
            std.fmt.bufPrint(&key_buf, "{d}:", .{confirmations}) catch unreachable;
        for (memo.frames.items) |item| if (std.mem.eql(u8, item.key, key)) return item.frame;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        var o = frames.Object.begin(&out.writer) catch oom();
        o.string("type", "message_upsert") catch oom();
        o.int("confirmations", confirmations) catch oom();
        if (fields) |f| {
            o.int("domain", f.domain) catch oom();
            o.bigString("height", f.height) catch oom();
        }
        o.key("data") catch oom();
        out.writer.writeAll(memo.data.?) catch oom();
        o.end() catch oom();
        const frame = self.host.make_frame(self.host.ctx, out.written());
        memo.frames.append(self.allocator, .{ .key = self.allocator.dupe(u8, key) catch oom(), .frame = frame }) catch oom();
        return frame;
    }

    const FrontierCtx = struct {
        source: *const MessageSource,
        sub: *const Subscriber,

        fn get(ctx: *const anyopaque, domain: u32) ?i128 {
            const self: *const FrontierCtx = @ptrCast(@alignCast(ctx));
            if (self.sub.frontiers.get(domain)) |height| return height;
            return if (self.source.heads.get(domain)) |head| head.confirmed else null;
        }
    };

    /// `project(facts, sub)`, memoised per frontier key (the hidden result too).
    fn project(self: *MessageSource, cell: *Cell, sub: *Subscriber) *Memo {
        const facts = cell.outcome.facts;
        const ctx: FrontierCtx = .{ .source = self, .sub = sub };
        var key: std.Io.Writer.Allocating = .init(self.allocator);
        defer key.deinit();
        for (facts.dependencies.items, 0..) |domain, i| {
            if (i > 0) key.writer.writeByte(',') catch oom();
            if (FrontierCtx.get(&ctx, domain)) |height| key.writer.print("{d}", .{height}) catch oom() else key.writer.writeByte('*') catch oom();
        }
        for (cell.memos.items) |memo| if (std.mem.eql(u8, memo.key, key.written())) return memo;
        if (cell.memos.items.len >= MAX_PROJECTIONS_PER_FACT) {
            for (cell.memos.items) |memo| self.freeMemo(memo);
            cell.memos.clearRetainingCapacity();
        }
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const projected = mf.project(arena.allocator(), facts, .{ .ctx = &ctx, .get = FrontierCtx.get }) catch oom();
        const memo = self.allocator.create(Memo) catch oom();
        memo.* = .{
            .key = key.toOwnedSlice() catch oom(),
            .data = if (projected) |row| json.stringifyAlloc(self.allocator, row.data) catch oom() else null,
            .heights = if (projected) |row| row.heights.clone(self.allocator) catch oom() else .empty,
        };
        cell.memos.append(self.allocator, memo) catch oom();
        return memo;
    }

    // -- Stop --------------------------------------------------------------------

    /// `stop()`: in-flight work sees `stopped`; the caller then drops its reference.
    pub fn stop(self: *MessageSource) void {
        self.stopped = true;
        self.advances.clearRetainingCapacity();
        const subs = self.subscribers.toOwnedSlice(self.allocator) catch oom();
        for (subs) |sub| {
            sub.subscribed = false;
            sub.release();
        }
        self.allocator.free(subs);
        while (self.windows.count() > 0) {
            const domain = self.windows.keys()[0];
            self.dropWindow(domain, self.windows.values()[0]);
        }
        for (self.entries.values()) |e| self.invalidate(e);
        const entries = self.allocator.dupe(*Entry, self.entries.values()) catch oom();
        defer self.allocator.free(entries);
        self.entries.clearRetainingCapacity();
        for (entries) |e| self.unpin(e);
        // Setup flows still waiting for the snapshot keep waiting on it.
    }
};

/// `firstAfter(changes, height)`: the first index with a greater height.
fn firstAfter(changes: []const Change, height: i128) usize {
    var lo: usize = 0;
    var hi: usize = changes.len;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        if (changes[mid].height <= height) lo = mid + 1 else hi = mid;
    }
    return lo;
}
