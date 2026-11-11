//! Port of `src/diagnostics/stream.ts` (and the `NotificationWorker` it uses).
//!
//! PostgreSQL notifications are wakeups, not the data source. Initial and
//! reconnect reads repair gaps; normal reads contain only affected watched IDs.
//!
//! Threading: one timer thread runs coalesced drains and reconnect timers;
//! listener connects run on short-lived threads; subscribe/notify/completions
//! arrive from any thread. All state is guarded by `mutex`, which is never held
//! while calling into the sink (WebSocket layer) or the database, so a sink may
//! complete synchronously inside `send`.
const std = @import("std");
const core = @import("core");
const Allocator = std.mem.Allocator;
const js = @import("js.zig");
const service_mod = @import("service.zig");
const Service = service_mod.Service;

const MAX_DIAGNOSTICS_IDS = 200;
const MAX_DIAGNOSTICS_IDS_PER_IP = 50;
pub const NOTIFICATION_BATCH_MS = 25;
pub const RETRY_MS = 1_000;

pub const event_types = [_][]const u8{ "diagnostics", "diagnostics_unavailable" };
const unavailable_message = "Diagnostics temporarily unavailable; retrying";
const snapshot_prefix = "{\"type\":\"diagnostics\",\"data\":";

pub const SubscribeError = error{ Stopped, PerIpCapacityExceeded, CapacityExceeded, OutOfMemory };

pub fn subscribeErrorMessage(err: SubscribeError) []const u8 {
    return switch (err) {
        error.Stopped => "Diagnostics stream stopped",
        error.PerIpCapacityExceeded => "Diagnostics subscription per-IP capacity exceeded",
        error.CapacityExceeded => "Diagnostics subscription capacity exceeded",
        error.OutOfMemory => "Out of memory",
    };
}

/// `{"type":"diagnostics_unavailable","message_ids":[...],"message":...}`.
pub fn unavailableFrameAlloc(gpa: Allocator, ids: []const []const u8, message: []const u8) Allocator.Error![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    writeUnavailable(&out.writer, ids, message) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

fn writeUnavailable(w: *std.Io.Writer, ids: []const []const u8, message: []const u8) std.Io.Writer.Error!void {
    try w.writeAll("{\"type\":\"diagnostics_unavailable\",\"message_ids\":[");
    for (ids, 0..) |id, i| {
        if (i > 0) try w.writeByte(',');
        try js.writeString(w, id);
    }
    try w.writeAll("],\"message\":");
    try js.writeString(w, message);
    try w.writeByte('}');
}

/// Serialized frame shared by every recipient of one publication.
pub const Frame = struct {
    refs: std.atomic.Value(u32) = .init(1),
    gpa: Allocator,
    /// Exact `JSON.stringify(frame)` bytes.
    bytes: []u8,
    /// `JSON.stringify(data)` for snapshot frames (a slice of `bytes`).
    fingerprint: []const u8,
    message_id: []const u8,

    pub fn retain(self: *Frame) void {
        _ = self.refs.fetchAdd(1, .monotonic);
    }

    pub fn release(self: *Frame) void {
        if (self.refs.fetchSub(1, .acq_rel) != 1) return;
        self.gpa.free(self.bytes);
        self.gpa.free(self.message_id);
        self.gpa.destroy(self);
    }
};

pub const Sink = struct {
    ctx: *anyopaque,
    /// True means accepted for sending; `done.complete(sent)` reports delivery
    /// and must be called exactly once (synchronously or later).
    send: *const fn (ctx: *anyopaque, frame: *Frame, done: Completion) bool,
    /// Called exactly once after the subscription's last possible `send` or
    /// completion. Runs on the stream's timer thread (or in `deinit` after
    /// `stop`), never inside `send`/`complete`/`unsubscribe` and never with
    /// the stream mutex held.
    release: ?*const fn (ctx: *anyopaque) void = null,
};

/// `null` marks an unavailable notice; a frame marks a snapshot fingerprint.
const Slot = union(enum) {
    unavailable,
    frame: *Frame,

    fn isUnavailable(slot: ?Slot) bool {
        return slot != null and slot.? == .unavailable;
    }

    fn hasFingerprint(slot: ?Slot, frame: *Frame) bool {
        const s = slot orelse return false;
        return s == .frame and std.mem.eql(u8, s.frame.fingerprint, frame.fingerprint);
    }
};

/// Owned by the stream's set and by the caller's handle (see `unsubscribe`).
pub const Subscription = struct {
    refs: u32 = 2,
    subscribed: bool = true,
    ip: []u8,
    ids: [][]u8,
    sink: Sink,
    previous: std.StringHashMapUnmanaged(Slot) = .empty,
    in_flight: std.StringHashMapUnmanaged(Slot) = .empty,

    fn watches(self: *const Subscription, id: []const u8) ?[]const u8 {
        for (self.ids) |own| if (std.mem.eql(u8, own, id)) return own;
        return null;
    }
};

/// One publication's shared retry bookkeeping (the TS closure variables).
const Publish = struct {
    refs: u32,
    items: []Item,
    retry_start: ?usize,
    retrying: bool = false,

    const Item = struct { id: []const u8, subscription: *Subscription, frame: *Frame };
};

const UnavailableNotice = struct {
    subscription: *Subscription,
    ids: [][]const u8,
};

pub const Completion = struct {
    stream: *Stream,
    kind: union(enum) {
        snapshot: struct { publish: *Publish, index: usize },
        unavailable: *UnavailableNotice,
    },

    pub fn complete(self: Completion, sent: bool) void {
        const s = self.stream;
        s.mutex.lock();
        defer s.mutex.unlock();
        switch (self.kind) {
            .snapshot => |p| s.completeSnapshot(p.publish, p.index, sent),
            .unavailable => |n| s.completeUnavailable(n, sent),
        }
    }
};

fn monotonicNs() u64 {
    const ts = std.posix.clock_gettime(std.posix.CLOCK.MONOTONIC) catch unreachable;
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

const ListenerHandle = struct {
    stream: *Stream,
    attempt: u64,
};

pub const Stream = struct {
    gpa: Allocator,
    service: *const Service,
    batch_ms: u64,
    retry_ms: u64,

    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    subscriptions: std.ArrayList(*Subscription) = .empty,
    pending: std.StringArrayHashMapUnmanaged(void) = .empty,
    fanout_start: ?struct { id: []u8, subscription: *Subscription } = null,

    // NotificationWorker
    timer_at: ?u64 = null,
    next_delay: ?u64 = null,
    running: bool = false,
    drains_started: u64 = 0,
    drains_finished: u64 = 0,
    worker_stopped: bool = false,
    /// Tests clear this so only explicit `flush()` calls drain, matching Node
    /// never firing a timer between synchronous statements.
    auto_drain: bool = true,

    // Listener lifecycle
    reconnect_at: ?u64 = null,
    connecting: bool = false,
    connect_thread: ?std.Thread = null,
    listener_attempt: u64 = 0,
    listener: ?Service.Listener = null,
    listener_handle: ?*ListenerHandle = null,
    retired: std.ArrayList(struct { listener: Service.Listener, handle: *ListenerHandle }) = .empty,
    /// Sinks whose subscriptions were freed; `release` runs off-lock on the
    /// timer thread. Capacity is reserved per live subscription at subscribe.
    sink_releases: std.ArrayList(Sink) = .empty,
    live_subscriptions: usize = 0,
    started: bool = false,
    stopped: bool = false,
    thread: ?std.Thread = null,

    pub fn init(gpa: Allocator, service: *const Service) Allocator.Error!*Stream {
        return initWithTiming(gpa, service, NOTIFICATION_BATCH_MS, RETRY_MS);
    }

    pub fn initWithTiming(gpa: Allocator, service: *const Service, batch_ms: u64, retry_ms: u64) Allocator.Error!*Stream {
        const self = try gpa.create(Stream);
        self.* = .{ .gpa = gpa, .service = service, .batch_ms = batch_ms, .retry_ms = retry_ms };
        return self;
    }

    /// Stops (if needed) and frees the stream.
    pub fn deinit(self: *Stream) void {
        self.stop();
        for (self.sink_releases.items) |sink| sink.release.?(sink.ctx);
        self.sink_releases.deinit(self.gpa);
        self.subscriptions.deinit(self.gpa);
        self.pending.deinit(self.gpa);
        self.retired.deinit(self.gpa);
        self.gpa.destroy(self);
    }

    fn ensureThread(self: *Stream) void {
        if (self.thread != null or self.stopped) return;
        self.thread = std.Thread.spawn(.{}, timerLoop, .{self}) catch |err| {
            core.log.child("Diagnostics").err("diagnostics timer thread failed: {s}", .{@errorName(err)});
            return;
        };
    }

    pub fn start(self: *Stream) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.started or self.stopped) return;
        self.started = true;
        self.ensureThread();
        self.connectListener();
    }

    pub fn subscribe(self: *Stream, ip: []const u8, ids: []const []const u8, sink: Sink) SubscribeError!*Subscription {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.stopped) return error.Stopped;
        var scratch = std.heap.ArenaAllocator.init(self.gpa);
        defer scratch.deinit();
        const arena = scratch.allocator();
        var ip_ids: std.StringHashMapUnmanaged(void) = .empty;
        var all_ids: std.StringHashMapUnmanaged(void) = .empty;
        for (self.subscriptions.items) |s| {
            for (s.ids) |id| {
                if (std.mem.eql(u8, s.ip, ip)) try ip_ids.put(arena, id, {});
                try all_ids.put(arena, id, {});
            }
        }
        for (ids) |id| {
            try ip_ids.put(arena, id, {});
            try all_ids.put(arena, id, {});
        }
        if (ip_ids.count() > MAX_DIAGNOSTICS_IDS_PER_IP) return error.PerIpCapacityExceeded;
        if (all_ids.count() > MAX_DIAGNOSTICS_IDS) return error.CapacityExceeded;

        const sub = try self.gpa.create(Subscription);
        errdefer self.gpa.destroy(sub);
        const own_ip = try self.gpa.dupe(u8, ip);
        errdefer self.gpa.free(own_ip);
        const own_ids = try self.gpa.alloc([]u8, ids.len);
        var copied: usize = 0;
        errdefer {
            for (own_ids[0..copied]) |id| self.gpa.free(id);
            self.gpa.free(own_ids);
        }
        for (ids, own_ids) |id, *own| {
            own.* = try self.gpa.dupe(u8, id);
            copied += 1;
        }
        sub.* = .{ .ip = own_ip, .ids = own_ids, .sink = sink };
        try self.sink_releases.ensureTotalCapacity(self.gpa, self.live_subscriptions + 1);
        try self.subscriptions.append(self.gpa, sub);
        self.live_subscriptions += 1;
        self.enqueue(ids, 0);
        return sub;
    }

    /// Releases the handle returned by `subscribe`: call exactly once per
    /// subscription, also after `stop()` (which already removed it from the
    /// set, as TS socket-close handlers run after `stop`). Call `deinit` only
    /// after every unsubscribe and every pending `Completion`.
    pub fn unsubscribe(self: *Stream, sub: *Subscription) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (sub.subscribed) {
            sub.subscribed = false;
            for (self.subscriptions.items, 0..) |s, i| if (s == sub) {
                _ = self.subscriptions.orderedRemove(i);
                break;
            };
            self.releaseSubscription(sub);
        }
        self.releaseSubscription(sub);
    }

    fn releaseSubscription(self: *Stream, sub: *Subscription) void {
        sub.refs -= 1;
        if (sub.refs > 0) return;
        inline for (.{ &sub.previous, &sub.in_flight }) |map| {
            var it = map.valueIterator();
            while (it.next()) |slot| if (slot.* == .frame) slot.frame.release();
            map.deinit(self.gpa);
        }
        for (sub.ids) |id| self.gpa.free(id);
        self.gpa.free(sub.ids);
        self.gpa.free(sub.ip);
        const sink = sub.sink;
        self.gpa.destroy(sub);
        self.live_subscriptions -= 1;
        if (sink.release != null) {
            self.sink_releases.appendAssumeCapacity(sink);
            self.ensureThread();
            self.cond.broadcast();
        }
    }

    /// Mutex held; runs sink releases with it released.
    fn runSinkReleases(self: *Stream) void {
        while (self.sink_releases.pop()) |sink| {
            self.mutex.unlock();
            sink.release.?(sink.ctx);
            self.mutex.lock();
        }
    }

    fn setSlot(self: *Stream, map: *std.StringHashMapUnmanaged(Slot), key: []const u8, slot: Slot) void {
        if (slot == .frame) slot.frame.retain();
        const entry = map.getOrPut(self.gpa, key) catch {
            if (slot == .frame) slot.frame.release();
            return;
        };
        if (entry.found_existing and entry.value_ptr.* == .frame) entry.value_ptr.frame.release();
        entry.value_ptr.* = slot;
    }

    fn deleteSlot(map: *std.StringHashMapUnmanaged(Slot), key: []const u8) void {
        const removed = map.fetchRemove(key) orelse return;
        if (removed.value == .frame) removed.value.frame.release();
    }

    /// Drain queued wakeups immediately (blocks until the drain finishes).
    pub fn flush(self: *Stream) void {
        self.mutex.lock();
        if (self.worker_stopped) return self.mutex.unlock();
        self.timer_at = null;
        if (self.running) {
            const target = self.drains_started;
            while (self.drains_finished < target) self.cond.wait(&self.mutex);
            return self.mutex.unlock();
        }
        self.next_delay = null;
        self.running = true;
        self.drains_started += 1;
        self.mutex.unlock();

        self.drain();

        self.mutex.lock();
        defer self.mutex.unlock();
        self.running = false;
        self.drains_finished += 1;
        self.cond.broadcast();
        if (self.next_delay) |delay| self.schedule(delay);
    }

    pub fn stop(self: *Stream) void {
        self.mutex.lock();
        if (self.stopped and self.thread == null and self.connect_thread == null) return self.mutex.unlock();
        self.stopped = true;
        self.worker_stopped = true;
        self.timer_at = null;
        self.reconnect_at = null;
        self.cond.broadcast();
        const connect_thread = self.connect_thread;
        self.connect_thread = null;
        self.mutex.unlock();
        // await this.connecting
        if (connect_thread) |t| t.join();
        self.mutex.lock();
        const listener = self.listener;
        const handle = self.listener_handle;
        self.listener = null;
        self.listener_handle = null;
        // await this.running
        while (self.running) self.cond.wait(&self.mutex);
        const thread = self.thread;
        self.thread = null;
        self.mutex.unlock();
        if (listener) |l| l.stop(l.ctx);
        if (handle) |h| self.gpa.destroy(h);
        if (thread) |t| t.join();
        self.mutex.lock();
        defer self.mutex.unlock();
        self.stopRetired();
        for (self.subscriptions.items) |sub| {
            sub.subscribed = false;
            self.releaseSubscription(sub);
        }
        self.subscriptions.clearRetainingCapacity();
        self.clearPending();
        if (self.fanout_start) |f| {
            self.gpa.free(f.id);
            self.releaseSubscription(f.subscription);
            self.fanout_start = null;
        }
    }

    // ------------------------------------------------------ worker

    /// `NotificationWorker.schedule` (mutex held).
    fn schedule(self: *Stream, delay_ms: u64) void {
        if (self.worker_stopped or self.timer_at != null) return;
        self.next_delay = delay_ms;
        if (self.running) return;
        self.ensureThread();
        self.timer_at = monotonicNs() + delay_ms * std.time.ns_per_ms;
        self.cond.broadcast();
    }

    fn timerLoop(self: *Stream) void {
        self.mutex.lock();
        while (!self.stopped) {
            self.stopRetired();
            self.runSinkReleases();
            const now = monotonicNs();
            if (self.timer_at) |at| if (self.auto_drain and at <= now) {
                self.timer_at = null;
                self.mutex.unlock();
                self.flush();
                self.mutex.lock();
                continue;
            };
            if (self.reconnect_at) |at| if (at <= now) {
                self.reconnect_at = null;
                self.connectListener();
                continue;
            };
            var wake: ?u64 = null;
            for ([_]?u64{ if (self.auto_drain) self.timer_at else null, self.reconnect_at }) |d| {
                if (d) |at| wake = if (wake) |w| @min(w, at) else at;
            }
            if (wake) |at| {
                self.cond.timedWait(&self.mutex, at - now) catch {};
            } else self.cond.wait(&self.mutex);
        }
        self.mutex.unlock();
    }

    /// Listeners that disconnected are stopped off their own thread (mutex held).
    fn stopRetired(self: *Stream) void {
        while (self.retired.pop()) |r| {
            self.mutex.unlock();
            r.listener.stop(r.listener.ctx);
            self.gpa.destroy(r.handle);
            self.mutex.lock();
        }
    }

    fn clearPending(self: *Stream) void {
        for (self.pending.keys()) |id| self.gpa.free(id);
        self.pending.clearRetainingCapacity();
    }

    fn watched(self: *const Stream, id: []const u8) bool {
        for (self.subscriptions.items) |s| if (s.watches(id) != null) return true;
        return false;
    }

    /// Mutex held.
    fn enqueue(self: *Stream, ids: []const []const u8, delay_ms: u64) void {
        for (ids) |id| {
            if (!self.watched(id) or self.pending.contains(id)) continue;
            const own = self.gpa.dupe(u8, id) catch continue;
            self.pending.put(self.gpa, own, {}) catch self.gpa.free(own);
        }
        if (self.pending.count() > 0) self.schedule(delay_ms);
    }

    fn scheduleRetry(self: *Stream) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.pending.count() > 0) self.schedule(self.retry_ms);
    }

    fn drain(self: *Stream) void {
        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        self.drainInto(arena) catch self.scheduleRetry();
    }

    fn drainInto(self: *Stream, arena: Allocator) Allocator.Error!void {
        self.mutex.lock();
        var queued: std.ArrayList([]const u8) = .empty;
        for (self.pending.keys()) |id| {
            if (self.watched(id)) queued.append(arena, try arena.dupe(u8, id)) catch |err| {
                self.mutex.unlock();
                return err;
            };
        }
        self.clearPending();
        self.mutex.unlock();

        var snapshots: std.ArrayList(js.Value) = .empty;
        var offset: usize = 0;
        while (offset < queued.items.len) : (offset += service_mod.SNAPSHOT_BATCH_SIZE) {
            self.mutex.lock();
            const stopped = self.stopped;
            self.mutex.unlock();
            if (stopped) break;
            const batch = queued.items[offset..@min(offset + service_mod.SNAPSHOT_BATCH_SIZE, queued.items.len)];
            const result = self.service.snapshots(arena, batch) catch {
                self.unavailable(batch);
                self.mutex.lock();
                self.enqueue(queued.items[offset..], self.retry_ms);
                self.mutex.unlock();
                break;
            };
            try snapshots.appendSlice(arena, result);
        }
        try self.publish(arena, snapshots.items);
    }

    fn makeFrame(self: *Stream, data: js.Value) Allocator.Error!*Frame {
        var out: std.Io.Writer.Allocating = .init(self.gpa);
        errdefer out.deinit();
        out.writer.writeAll(snapshot_prefix) catch return error.OutOfMemory;
        js.stringify(&out.writer, data) catch return error.OutOfMemory;
        out.writer.writeByte('}') catch return error.OutOfMemory;
        const bytes = try out.toOwnedSlice();
        errdefer self.gpa.free(bytes);
        const message_id = try self.gpa.dupe(u8, data.object.get("message_id").string);
        errdefer self.gpa.free(message_id);
        const frame = try self.gpa.create(Frame);
        frame.* = .{
            .gpa = self.gpa,
            .bytes = bytes,
            .fingerprint = bytes[snapshot_prefix.len .. bytes.len - 1],
            .message_id = message_id,
        };
        return frame;
    }

    fn publish(self: *Stream, arena: Allocator, snapshots: []const js.Value) Allocator.Error!void {
        var items: std.ArrayList(Publish.Item) = .empty;
        defer items.deinit(self.gpa);
        for (snapshots) |data| {
            const frame = try self.makeFrame(data);
            defer frame.release();
            const id = frame.message_id;
            self.mutex.lock();
            defer self.mutex.unlock();
            for (self.subscriptions.items) |sub| {
                const own_id = sub.watches(id) orelse continue;
                const pending = sub.in_flight.get(own_id);
                if (Slot.hasFingerprint(pending, frame)) continue;
                if (Slot.hasFingerprint(sub.previous.get(own_id), frame) and !Slot.isUnavailable(pending)) continue;
                try items.append(self.gpa, .{ .id = own_id, .subscription = sub, .frame = frame });
                sub.refs += 1;
                frame.retain();
            }
        }
        _ = arena;
        if (items.items.len == 0) {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.fanout_start) |f| {
                self.gpa.free(f.id);
                self.releaseSubscription(f.subscription);
                self.fanout_start = null;
            }
            return;
        }
        self.mutex.lock();
        if (self.fanout_start) |resume_at| {
            for (items.items, 0..) |item, i| {
                if (item.subscription == resume_at.subscription and std.mem.eql(u8, item.id, resume_at.id)) {
                    if (i > 0) std.mem.rotate(Publish.Item, items.items, i);
                    break;
                }
            }
            self.gpa.free(resume_at.id);
            self.releaseSubscription(resume_at.subscription);
            self.fanout_start = null;
        }
        const n = items.items.len;
        const publication = self.gpa.create(Publish) catch |err| {
            for (items.items) |item| {
                item.frame.release();
                self.releaseSubscription(item.subscription);
            }
            self.mutex.unlock();
            return err;
        };
        publication.* = .{
            .refs = @intCast(n + 1),
            .items = items.toOwnedSlice(self.gpa) catch unreachable,
            .retry_start = if (n > 1) 1 else 0,
        };
        self.mutex.unlock();

        for (publication.items, 0..) |item, index| {
            self.mutex.lock();
            self.setSlot(&item.subscription.in_flight, item.id, .{ .frame = item.frame });
            self.mutex.unlock();
            const accepted = item.subscription.sink.send(item.subscription.sink.ctx, item.frame, .{
                .stream = self,
                .kind = .{ .snapshot = .{ .publish = publication, .index = index } },
            });
            if (accepted) {
                self.mutex.lock();
                publication.retry_start = (index + 1) % n;
                if (publication.retrying) self.setRetryStart(publication);
                self.mutex.unlock();
            }
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        self.releasePublish(publication);
    }

    fn setRetryStart(self: *Stream, publication: *Publish) void {
        const index = publication.retry_start orelse return;
        const item = publication.items[index];
        const id = self.gpa.dupe(u8, item.id) catch return;
        if (self.fanout_start) |f| {
            self.gpa.free(f.id);
            self.releaseSubscription(f.subscription);
        }
        item.subscription.refs += 1;
        self.fanout_start = .{ .id = id, .subscription = item.subscription };
    }

    fn releasePublish(self: *Stream, publication: *Publish) void {
        publication.refs -= 1;
        if (publication.refs > 0) return;
        for (publication.items) |item| {
            item.frame.release();
            self.releaseSubscription(item.subscription);
        }
        self.gpa.free(publication.items);
        self.gpa.destroy(publication);
    }

    /// Mutex held.
    fn completeSnapshot(self: *Stream, publication: *Publish, index: usize, sent: bool) void {
        defer self.releasePublish(publication);
        const item = publication.items[index];
        const sub = item.subscription;
        if (!Slot.hasFingerprint(sub.in_flight.get(item.id), item.frame)) return;
        deleteSlot(&sub.in_flight, item.id);
        if (sent) {
            self.setSlot(&sub.previous, item.id, .{ .frame = item.frame });
        } else if (sub.subscribed) {
            publication.retrying = true;
            self.setRetryStart(publication);
            self.enqueue(&.{item.id}, self.retry_ms);
        }
    }

    fn unavailable(self: *Stream, ids: []const []const u8) void {
        var notices: std.ArrayList(*UnavailableNotice) = .empty;
        defer notices.deinit(self.gpa);
        self.mutex.lock();
        for (self.subscriptions.items) |sub| {
            var failed: std.ArrayList([]const u8) = .empty;
            for (sub.ids) |id| {
                var requested = false;
                for (ids) |other| if (std.mem.eql(u8, id, other)) {
                    requested = true;
                    break;
                };
                if (!requested or Slot.isUnavailable(sub.previous.get(id)) or sub.in_flight.contains(id)) continue;
                failed.append(self.gpa, id) catch continue;
            }
            if (failed.items.len == 0) continue;
            const notice = self.gpa.create(UnavailableNotice) catch {
                failed.deinit(self.gpa);
                continue;
            };
            notice.* = .{ .subscription = sub, .ids = failed.toOwnedSlice(self.gpa) catch unreachable };
            notices.append(self.gpa, notice) catch {
                self.gpa.free(notice.ids);
                self.gpa.destroy(notice);
                continue;
            };
            for (notice.ids) |id| self.setSlot(&sub.in_flight, id, .unavailable);
            sub.refs += 1;
        }
        self.mutex.unlock();
        for (notices.items) |notice| {
            const frame = self.unavailableFrame(notice.ids) catch null;
            const done: Completion = .{ .stream = self, .kind = .{ .unavailable = notice } };
            if (frame) |f| {
                _ = notice.subscription.sink.send(notice.subscription.sink.ctx, f, done);
                f.release();
            } else done.complete(false);
        }
    }

    fn unavailableFrame(self: *Stream, ids: []const []const u8) Allocator.Error!*Frame {
        const bytes = try unavailableFrameAlloc(self.gpa, ids, unavailable_message);
        errdefer self.gpa.free(bytes);
        const message_id = try self.gpa.alloc(u8, 0);
        errdefer self.gpa.free(message_id);
        const frame = try self.gpa.create(Frame);
        frame.* = .{ .gpa = self.gpa, .bytes = bytes, .fingerprint = "", .message_id = message_id };
        return frame;
    }

    /// Mutex held.
    fn completeUnavailable(self: *Stream, notice: *UnavailableNotice, sent: bool) void {
        const sub = notice.subscription;
        for (notice.ids) |id| {
            if (!Slot.isUnavailable(sub.in_flight.get(id))) continue;
            deleteSlot(&sub.in_flight, id);
            if (sent) {
                self.setSlot(&sub.previous, id, .unavailable);
            } else if (sub.subscribed) self.enqueue(&.{id}, self.retry_ms);
        }
        self.gpa.free(notice.ids);
        self.gpa.destroy(notice);
        self.releaseSubscription(sub);
    }

    fn watchedIds(self: *Stream, arena: Allocator) Allocator.Error![]const []const u8 {
        var ids: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (self.subscriptions.items) |s| for (s.ids) |id| try ids.put(arena, try arena.dupe(u8, id), {});
        return ids.keys();
    }

    // ------------------------------------------------------ listener

    /// Mutex held.
    fn connectListener(self: *Stream) void {
        const listen = self.service.listen orelse return;
        if (self.stopped or self.connecting or self.listener != null) return;
        self.listener_attempt += 1;
        const attempt = self.listener_attempt;
        self.connecting = true;
        if (self.connect_thread) |t| {
            // The previous attempt already finished (connecting was false).
            self.mutex.unlock();
            t.join();
            self.mutex.lock();
            self.connect_thread = null;
            if (self.stopped) {
                self.connecting = false;
                return;
            }
        }
        self.connect_thread = std.Thread.spawn(.{}, connectWorker, .{ self, listen, attempt }) catch {
            self.connecting = false;
            self.scheduleReconnect();
            return;
        };
    }

    fn connectWorker(self: *Stream, listen: Service.Listen, attempt: u64) void {
        const handle = self.gpa.create(ListenerHandle) catch {
            self.mutex.lock();
            defer self.mutex.unlock();
            self.connecting = false;
            self.scheduleReconnect();
            return;
        };
        handle.* = .{ .stream = self, .attempt = attempt };
        const result = listen.open(listen.ctx, .{ .ctx = handle, .notify = onNotify, .disconnect = onDisconnect });
        self.mutex.lock();
        if (result) |listener| {
            if (self.stopped or attempt != self.listener_attempt) {
                self.mutex.unlock();
                listener.stop(listener.ctx);
                self.gpa.destroy(handle);
                self.mutex.lock();
            } else {
                self.listener = listener;
                self.listener_handle = handle;
                var scratch = std.heap.ArenaAllocator.init(self.gpa);
                defer scratch.deinit();
                if (self.watchedIds(scratch.allocator())) |ids| self.enqueue(ids, 0) else |_| {}
            }
        } else |_| {
            self.gpa.destroy(handle);
            if (!self.stopped and attempt == self.listener_attempt) {
                var scratch = std.heap.ArenaAllocator.init(self.gpa);
                defer scratch.deinit();
                const ids = self.watchedIds(scratch.allocator()) catch &.{};
                self.mutex.unlock();
                self.unavailable(ids);
                self.mutex.lock();
            }
        }
        self.connecting = false;
        if (self.listener == null) self.scheduleReconnect();
        self.cond.broadcast();
        self.mutex.unlock();
    }

    fn onNotify(ctx: *anyopaque, payload: []const u8) void {
        const handle: *ListenerHandle = @ptrCast(@alignCast(ctx));
        const self = handle.stream;
        if (payload.len != 64) return;
        var id: [66]u8 = undefined;
        id[0] = '0';
        id[1] = 'x';
        for (payload, id[2..]) |c, *o| {
            if (!std.ascii.isHex(c)) return;
            o.* = std.ascii.toLower(c);
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        if (handle.attempt != self.listener_attempt) return;
        self.enqueue(&.{&id}, self.batch_ms);
    }

    fn onDisconnect(ctx: *anyopaque) void {
        const handle: *ListenerHandle = @ptrCast(@alignCast(ctx));
        const self = handle.stream;
        var scratch = std.heap.ArenaAllocator.init(self.gpa);
        defer scratch.deinit();
        self.mutex.lock();
        if (self.stopped or handle.attempt != self.listener_attempt) return self.mutex.unlock();
        self.listener_attempt += 1;
        if (self.listener) |l| {
            // `void stop?.()`: never stop a listener on its own callback thread.
            self.retired.append(self.gpa, .{ .listener = l, .handle = self.listener_handle.? }) catch {};
            self.listener = null;
            self.listener_handle = null;
            self.ensureThread();
            self.cond.broadcast();
        }
        const ids = self.watchedIds(scratch.allocator()) catch &.{};
        self.mutex.unlock();
        self.unavailable(ids);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.connecting) self.scheduleReconnect();
    }

    /// Mutex held.
    fn scheduleReconnect(self: *Stream) void {
        if (self.stopped or self.reconnect_at != null or self.service.listen == null) return;
        self.ensureThread();
        self.reconnect_at = monotonicNs() + self.retry_ms * std.time.ns_per_ms;
        self.cond.broadcast();
    }
};
