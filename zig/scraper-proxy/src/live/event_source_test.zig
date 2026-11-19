//! Ports `event-source.test.ts` (TS #10089 + #10090). The fixture mirrors
//! TS's: snapshots report every requested domain at `current` with a live
//! start at `checkpoint ?? current - count`; a range read yields one row per
//! height, gated per domain; frames are recorded as their JSON text.
const std = @import("std");
const testing = std.testing;
const runtime = @import("runtime.zig");
const protocol = @import("protocol.zig");
const cs = protocol;
const es = @import("event_store.zig");
const event_source = @import("event_source.zig");
const TestLoop = @import("notification_worker_test.zig").TestLoop;

const EventSource = event_source.EventSource;
const a = testing.allocator;

fn head(height: i128, previous: i128, domain: u32) protocol.HeadNotification {
    return .{
        .domain = domain,
        .head_height = height,
        .indexed_height = height,
        .previous_indexed_height = previous,
        .confirmed_height = height - 10,
    };
}

fn boundary(height: i128) protocol.LiveStartBoundary {
    var b: protocol.LiveStartBoundary = .{};
    const text = std.fmt.bufPrint(&b.height_buf, "{d}", .{height}) catch unreachable;
    b.height_len = @intCast(text.len);
    _ = std.fmt.bufPrint(&b.hash_buf, "0x{s}", .{"ab" ** 32}) catch unreachable;
    return b;
}

const Call = struct { domain: u32, after: i128, through: i128, event_type: protocol.EventType };

/// One subscription's recorder (TS `subscribe()`'s frames/errors/active).
const Sub = struct {
    f: *Fixture,
    frames: std.ArrayList([]u8) = .empty,
    errors: std.ArrayList([]u8) = .empty,
    active: bool = true,
    refuse: bool = false,
    /// Park the publishing task once this many frames were sent, until
    /// `Fixture.send_gate` opens (a deterministic "mid-publication").
    hold_after: ?usize = null,
    /// Once this many frames were sent, spawn a loop task that records the
    /// frame count when it runs (`Fixture.raced_frames`).
    race_after: ?usize = null,
    /// Once this many frames were sent, start `Fixture.racer`: a thread (a
    /// socket reader, say) that blocks in `Loop.lock` mid-publication.
    thread_race_after: ?usize = null,
    /// Once this many frames were sent, a head for this domain arrives in
    /// the same turn (`EventSource.notify`), scheduling its range read.
    notify_after: ?struct { frames: usize, domain: u32 } = null,
    /// The next send disconnects this peer as the server does: the send
    /// fails, and the subscription is stopped and its last handle dropped.
    drop_on_send: bool = false,
    subscription: ?event_source.Subscription = null,

    fn deinit(self: *Sub) void {
        for (self.frames.items) |frame| a.free(frame);
        self.frames.deinit(a);
        for (self.errors.items) |e| a.free(e);
        self.errors.deinit(a);
    }

    /// The frame's `"key":value` text, e.g. `field(i, "height")` -> `"102"`.
    fn field(self: *const Sub, index: usize, key: []const u8) ?[]const u8 {
        const frame = self.frames.items[index];
        var buf: [64]u8 = undefined;
        const needle = std.fmt.bufPrint(&buf, "\"{s}\":", .{key}) catch unreachable;
        const start = (std.mem.indexOf(u8, frame, needle) orelse return null) + needle.len;
        var end = start;
        while (end < frame.len and frame[end] != ',' and frame[end] != '}') end += 1;
        return frame[start..end];
    }

    fn lastField(self: *const Sub, key: []const u8) ?[]const u8 {
        if (self.frames.items.len == 0) return null;
        return self.field(self.frames.items.len - 1, key);
    }

    fn close(self: *Sub) void {
        const loop = &self.f.t.loop;
        loop.lock();
        defer loop.unlock();
        self.active = false;
        if (self.subscription) |s| s.stop();
    }
};

const Fixture = struct {
    t: *TestLoop,
    source: *EventSource = undefined,
    calls: std.ArrayList(Call) = .empty,
    current: i128 = 100,
    checkpoint: ?i128 = null,
    replacement: bool = false,
    /// Domains whose reads wait for `release` (TS `gates`).
    gated: std.AutoHashMapUnmanaged(u32, void) = .empty,
    gate: runtime.Gate = .{},
    subs: std.ArrayList(*Sub) = .empty,
    /// TS "mid-publication" store: 70 rows at this height, ids 1..70, when
    /// the read covers it; nothing otherwise.
    burst_height: ?i128 = null,
    send_gate: runtime.Gate = .{},
    send_held: bool = false,
    /// The racing subscriber's frame count when the raced task ran.
    raced_frames: ?usize = null,
    racer: ?std.Thread = null,
    /// The racing subscriber's frame count when `racer` took the mutex.
    racer_frames: ?usize = null,
    /// `read_frames_of`'s frame count when a read of `read_domain` started.
    read_domain: ?u32 = null,
    read_frames_of: ?*Sub = null,
    read_frames: ?usize = null,
    /// TS's wrapped `confirmationEventRows`: the next read waits for
    /// `gate` (and then fails when `hook_fails`).
    hook_next: bool = false,
    hook_fails: bool = false,
    hook_pending: bool = false,

    fn init(self: *Fixture, limits: event_source.Limits) void {
        self.source = EventSource.create(a, &self.t.loop, self.host(), limits);
    }

    fn deinit(self: *Fixture) void {
        const loop = &self.t.loop;
        loop.lock();
        if (!self.source.stopped) self.source.stop();
        for (self.subs.items) |sub| sub.active = false;
        loop.unlock();
        self.gate.release(loop);
        self.send_gate.release(loop);
        // Let tasks drop their source references.
        for (0..2000) |_| {
            loop.lock();
            const idle = self.source.refs == 1 + self.liveHandles();
            loop.unlock();
            if (idle) break;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        loop.lock();
        for (self.subs.items) |sub| if (sub.subscription) |s| s.deinit();
        std.debug.assert(self.source.release());
        loop.unlock();
        for (self.subs.items) |sub| {
            sub.deinit();
            a.destroy(sub);
        }
        self.subs.deinit(a);
        self.calls.deinit(a);
        self.gated.deinit(a);
    }

    fn liveHandles(self: *const Fixture) u32 {
        var n: u32 = 0;
        for (self.subs.items) |sub| {
            if (sub.subscription != null) n += 1;
        }
        return n;
    }

    fn host(self: *Fixture) event_source.Host {
        return .{
            .ctx = self,
            .read = read,
            .make_frame = makeFrame,
            .send_frame = sendFrame,
            .release_frame = releaseFrame,
            .active = active,
            .fail = fail,
            .retain = noop,
            .release = noop,
        };
    }

    fn noop(_: *anyopaque, _: *anyopaque) void {}

    const Frame = struct { refs: usize = 1, bytes: []u8 };

    fn makeFrame(_: *anyopaque, bytes: []const u8) *anyopaque {
        const frame = a.create(Frame) catch @panic("oom");
        frame.* = .{ .bytes = a.dupe(u8, bytes) catch @panic("oom") };
        return frame;
    }

    fn releaseFrame(_: *anyopaque, ptr: *anyopaque) void {
        const frame: *Frame = @ptrCast(@alignCast(ptr));
        frame.refs -= 1;
        if (frame.refs > 0) return;
        a.free(frame.bytes);
        a.destroy(frame);
    }

    fn sendFrame(ctx: *anyopaque, peer: *anyopaque, ptr: *anyopaque) bool {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        const sub: *Sub = @ptrCast(@alignCast(peer));
        const frame: *Frame = @ptrCast(@alignCast(ptr));
        sub.frames.append(a, a.dupe(u8, frame.bytes) catch @panic("oom")) catch @panic("oom");
        if (sub.race_after) |n| if (sub.frames.items.len == n) self.t.loop.spawn(raced, .{ self, sub });
        if (sub.thread_race_after) |n| if (sub.frames.items.len == n) {
            self.racer = std.Thread.spawn(.{}, threadRace, .{ self, sub }) catch @panic("spawn");
            // Return only once it waits for the mutex this publication holds.
            while (self.t.loop.lock_waiters.load(.acquire) == 0) std.Thread.sleep(10 * std.time.ns_per_us);
        };
        if (sub.notify_after) |n| if (sub.frames.items.len == n.frames) self.source.notify(head(103, 103, n.domain));
        if (sub.hold_after) |n| if (sub.frames.items.len == n) {
            self.send_held = true;
            self.send_gate.wait(&self.t.loop);
        };
        if (sub.drop_on_send) {
            sub.drop_on_send = false;
            sub.active = false;
            if (sub.subscription) |s| {
                s.stop();
                s.deinit();
            }
            sub.subscription = null;
            return false;
        }
        return !sub.refuse;
    }

    fn threadRace(self: *Fixture, sub: *Sub) void {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        self.racer_frames = sub.frames.items.len;
    }

    fn raced(self: *Fixture, sub: *Sub) void {
        self.raced_frames = sub.frames.items.len;
    }

    fn active(_: *anyopaque, peer: *anyopaque) bool {
        const sub: *Sub = @ptrCast(@alignCast(peer));
        return sub.active;
    }

    fn fail(_: *anyopaque, peer: *anyopaque, message: []const u8) void {
        const sub: *Sub = @ptrCast(@alignCast(peer));
        sub.errors.append(a, a.dupe(u8, message) catch @panic("oom")) catch @panic("oom");
        sub.active = false;
    }

    const Reader = struct {
        f: *Fixture,
        event_type: protocol.EventType,
        domain: u32,
        height: i128,
        through: i128,
        orphan: bool,
        waited: bool = false,
        hooked: bool = false,
        burst: ?i128 = null,
        burst_id: i128 = 0,
        frame: std.ArrayList(u8) = .empty,

        fn next(ptr: *anyopaque) anyerror!?cs.Row {
            const self: *Reader = @ptrCast(@alignCast(ptr));
            if (!self.waited) {
                self.waited = true;
                if (self.hooked) {
                    while (!self.f.gate.open) self.f.t.loop.wait(&self.f.gate.condition);
                    if (self.f.hook_fails) return runtime.fail("prefix failed", .{});
                }
                while (self.f.gated.contains(self.domain) and !self.f.gate.open) self.f.t.loop.wait(&self.f.gate.condition);
                if (self.f.burst_height) |burst| {
                    self.burst = if (self.height < burst and self.through >= burst) burst else null;
                    self.burst_id = 0;
                }
            }
            if (self.f.burst_height != null) {
                const burst = self.burst orelse return null;
                self.burst_id += 1;
                if (self.burst_id > 70) return null;
                self.frame.clearRetainingCapacity();
                self.frame.print(a, "{{\"type\":\"event\",\"height\":\"{d}\",\"id\":\"{d}\"}}", .{ burst, self.burst_id }) catch @panic("oom");
                return .{ .position = .{ .height = burst, .source = 0, .id = self.burst_id }, .message = .{ .frame = self.frame.items } };
            }
            self.height += 1;
            if (self.height > self.through) return null;
            self.frame.clearRetainingCapacity();
            self.frame.print(a, "{{\"type\":\"event\",\"eventType\":\"{s}\",\"domain\":{d},\"height\":\"{d}\",\"orphan\":{s}}}", .{
                self.event_type.name(), self.domain, self.height, if (self.orphan) "true" else "false",
            }) catch @panic("oom");
            return .{ .position = .{ .height = self.height, .source = 0, .id = self.height }, .message = .{ .frame = self.frame.items } };
        }

        fn deinit(ptr: *anyopaque) void {
            const self: *Reader = @ptrCast(@alignCast(ptr));
            self.frame.deinit(a);
            a.destroy(self);
        }
    };

    fn read(ctx: *anyopaque, event_type: protocol.EventType, domain: u32, after: cs.Position, through: i128) anyerror!cs.Reader {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        try self.calls.append(a, .{ .domain = domain, .after = after.height, .through = through, .event_type = event_type });
        if (self.read_domain) |d| if (d == domain and self.read_frames == null) {
            self.read_frames = self.read_frames_of.?.frames.items.len;
        };
        const reader = try a.create(Reader);
        reader.* = .{ .f = self, .event_type = event_type, .domain = domain, .height = after.height, .through = through, .orphan = !self.replacement };
        if (self.hook_next and !self.hook_pending) {
            self.hook_pending = true;
            reader.hooked = true;
        }
        return .{ .ptr = reader, .vtable = &.{ .next = Reader.next, .deinit = Reader.deinit } };
    }

    /// TS `f.subscribe(count, domains, eventType)`: snapshot, attach, start.
    fn subscribe(self: *Fixture, count: u64, domains: []const u32, event_type: protocol.EventType) !*Sub {
        const sub = try a.create(Sub);
        sub.* = .{ .f = self };
        try self.subs.append(a, sub);
        const loop = &self.t.loop;
        loop.lock();
        defer loop.unlock();
        const requests = [_]event_source.Request{.{ .event_type = event_type, .confirmations = count, .domains = domains }};
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const policies = try EventSource.policies(arena.allocator(), &requests);
        while (true) {
            var attempt = self.source.attempt(sub) orelse return sub;
            const snapshots = try arena.allocator().alloc(cs.Heads, policies.len);
            for (policies, snapshots) |policy, *heads| {
                heads.* = .empty;
                for (policy.domains) |domain| try heads.put(arena.allocator(), domain, .{
                    .head = self.current,
                    .indexed = self.current,
                    .confirmed = self.current - 10,
                    .live_start = boundary(self.checkpoint orelse self.current - @as(i128, policy.confirmations)),
                });
            }
            const subscription = (try self.source.subscribeWith(&attempt, &requests, policies, snapshots, sub)) orelse continue;
            sub.subscription = subscription;
            subscription.start();
            return sub;
        }
    }

    fn notify(self: *Fixture, n: protocol.HeadNotification) void {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        self.source.notify(n);
    }

    fn metrics(self: *Fixture) event_source.Metrics {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        return self.source.metrics();
    }

    fn until(self: *Fixture, ctx: anytype, comptime check: fn (@TypeOf(ctx)) bool) !void {
        try runtime.until(&self.t.loop, ctx, check);
    }
};

fn newFixture(t: *TestLoop, f: *Fixture, limits: event_source.Limits) void {
    t.init();
    f.* = .{ .t = t };
    f.init(limits);
}

test "shares dispatch reads across 100 connections and ten confirmation policies" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    var subs: [100]*Sub = undefined;
    for (&subs, 0..) |*sub, i| sub.* = try f.subscribe(i % 10, &.{1}, .dispatch);
    try testing.expectEqual(@as(usize, 0), f.calls.items.len); // subscriptions only take bounded snapshots
    f.notify(head(101, 101, 1));
    const Each = struct {
        fn atLeast(comptime n: usize) fn ([]*Sub) bool {
            return struct {
                fn check(all: []*Sub) bool {
                    for (all) |sub| if (sub.frames.items.len < n) return false;
                    return true;
                }
            }.check;
        }
    };
    try f.until(@as([]*Sub, &subs), Each.atLeast(1));
    try testing.expectEqual(@as(usize, 2), f.calls.items.len); // one retained prefix plus one live extension
    try testing.expectEqual(@as(usize, 1), f.metrics().ranges);
    f.t.loop.lock();
    f.calls.clearRetainingCapacity();
    f.t.loop.unlock();
    f.notify(head(102, 102, 1));
    try f.until(@as([]*Sub, &subs), Each.atLeast(2));
    try testing.expectEqual(@as(usize, 1), f.calls.items.len); // each new height is read once for all policies
    for (subs, 0..) |sub, i| {
        try testing.expectEqual(@as(usize, 2), sub.frames.items.len);
        var want: [24]u8 = undefined;
        try testing.expectEqualStrings(try std.fmt.bufPrint(&want, "\"{d}\"", .{101 - (i % 10)}), sub.field(0, "height").?);
        try testing.expectEqualStrings(try std.fmt.bufPrint(&want, "\"{d}\"", .{102 - (i % 10)}), sub.field(1, "height").?);
        // `{...row.message, confirmations}`: confirmations is the last key.
        for (sub.frames.items) |frame| {
            var tail: [40]u8 = undefined;
            try testing.expect(std.mem.endsWith(u8, frame, try std.fmt.bufPrint(&tail, ",\"confirmations\":{d}}}", .{i % 10})));
        }
        sub.close();
    }
    const m = f.metrics();
    try testing.expectEqual(event_source.Metrics{ .ranges = 0, .rows = 0, .bytes = 0 }, m);
}

test "does not let a stalled domain or disconnected subscriber block other readers" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    try f.gated.put(a, 1, {});
    const slow = try f.subscribe(0, &.{1}, .dispatch);
    const healthy = try f.subscribe(0, &.{2}, .dispatch);
    f.notify(head(101, 100, 1));
    f.notify(head(101, 100, 2));
    const One = struct {
        fn check(sub: *Sub) bool {
            return sub.frames.items.len == 1;
        }
    };
    try f.until(healthy, One.check);
    try testing.expectEqual(@as(usize, 0), slow.frames.items.len);
    slow.close();
    f.gate.release(&f.t.loop);
    std.Thread.sleep(20 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 0), slow.frames.items.len);
    try testing.expectEqual(@as(usize, 1), f.metrics().ranges);
}

test "rejects only an oversized joining prefix and keeps the existing feed alive" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{ .rows = 4, .bytes = 100_000 });
    defer t.deinit();
    defer f.deinit();
    const healthy = try f.subscribe(0, &.{1}, .dispatch);
    f.notify(head(101, 101, 1));
    const Frames = struct {
        fn atLeast(comptime n: usize) fn (*Sub) bool {
            return struct {
                fn check(sub: *Sub) bool {
                    return sub.frames.items.len >= n;
                }
            }.check;
        }
    };
    try f.until(healthy, Frames.atLeast(1));
    f.t.loop.lock();
    f.current = 101;
    f.t.loop.unlock();
    const deep = try f.subscribe(50, &.{1}, .dispatch);
    f.notify(head(102, 102, 1));
    const Pair = struct {
        deep: *Sub,
        healthy: *Sub,
        fn check(ctx: @This()) bool {
            return ctx.deep.errors.items.len == 1 and ctx.healthy.frames.items.len == 2;
        }
    };
    try f.until(Pair{ .deep = deep, .healthy = healthy }, Pair.check);
    try testing.expectEqualStrings(event_source.RETAINED_LIMIT_MESSAGE, deep.errors.items[0]);
    try testing.expectEqualStrings("\"102\"", healthy.lastField("height").?);
    try testing.expectEqual(@as(usize, 0), healthy.errors.items.len);
    try testing.expectEqual(@as(usize, 1), f.metrics().ranges);
    try testing.expectError(error.TemporarilyUnavailable, f.subscribe(50, &.{1}, .dispatch));
    const joining = try f.subscribe(0, &.{1}, .dispatch);
    f.notify(head(103, 103, 1));
    const Saw = struct {
        fn check(sub: *Sub) bool {
            for (sub.frames.items) |frame| if (std.mem.indexOf(u8, frame, "\"height\":\"103\"") != null) return true;
            return false;
        }
    };
    try f.until(joining, Saw.check);
    try testing.expectEqual(@as(usize, 0), joining.errors.items.len);
}

test "admits a full custom fleet up to the range limit and rejects the next range" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{ .ranges = 8 });
    defer t.deinit();
    defer f.deinit();
    const domains = [_]u32{ 1, 2 };
    _ = try f.subscribe(0, &domains, .dispatch);
    _ = try f.subscribe(0, &domains, .delivery);
    _ = try f.subscribe(0, &domains, .gas_payment);
    _ = try f.subscribe(0, &domains, .merkle_tree_insertion);
    try testing.expectEqual(@as(usize, 8), f.metrics().ranges);
    try testing.expectError(error.RangeCapacity, f.subscribe(0, &.{3}, .dispatch));
    // Joining existing ranges needs no new capacity.
    _ = try f.subscribe(5, &domains, .dispatch);
}

test "isolates a failed send from every other subscriber" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const failed = try f.subscribe(0, &.{1}, .dispatch);
    failed.refuse = true;
    const healthy = try f.subscribe(0, &.{1}, .dispatch);
    f.notify(head(101, 101, 1));
    const Frames = struct {
        fn atLeast(comptime n: usize) fn (*Sub) bool {
            return struct {
                fn check(sub: *Sub) bool {
                    return sub.frames.items.len >= n;
                }
            }.check;
        }
    };
    try f.until(healthy, Frames.atLeast(1));
    f.notify(head(102, 102, 1));
    try f.until(healthy, Frames.atLeast(2));
    try testing.expectEqual(@as(usize, 1), failed.frames.items.len);
    try testing.expectEqual(@as(usize, 0), healthy.errors.items.len);
}

test "fails only the affected domain on a same-height hash replacement" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const one = try f.subscribe(0, &.{1}, .dispatch);
    const two = try f.subscribe(0, &.{2}, .dispatch);
    var first = head(101, 101, 1);
    first.indexed_hash = "0x" ++ "01" ** 32;
    f.notify(first);
    var replaced = head(101, 101, 1);
    replaced.indexed_hash = "0x" ++ "02" ** 32;
    f.notify(replaced);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), one.errors.items.len);
    try testing.expectEqualStrings(event_source.REPLACED_MESSAGE, one.errors.items[0]);
    try testing.expectEqual(@as(usize, 0), two.errors.items.len);
}

test "policies group domains by confirmation count in first-seen order" {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const requests = [_]event_source.Request{
        .{ .event_type = .dispatch, .confirmations = 2, .domains = &.{ 3, 1 } },
        .{ .event_type = .delivery, .confirmations = 0, .domains = &.{1} },
        .{ .event_type = .gas_payment, .confirmations = 2, .domains = &.{ 1, 4 } },
    };
    const policies = try EventSource.policies(arena.allocator(), &requests);
    try testing.expectEqual(@as(usize, 2), policies.len);
    try testing.expectEqual(@as(u64, 2), policies[0].confirmations);
    try testing.expectEqualSlices(u32, &.{ 3, 1, 4 }, policies[0].domains);
    try testing.expectEqual(@as(u64, 0), policies[1].confirmations);
    try testing.expectEqualSlices(u32, &.{1}, policies[1].domains);
}

fn framesAtLeast(comptime n: usize) fn (*Sub) bool {
    return struct {
        fn check(sub: *Sub) bool {
            return sub.frames.items.len >= n;
        }
    }.check;
}

fn setHead(f: *Fixture, current: i128, checkpoint: ?i128) void {
    f.t.loop.lock();
    defer f.t.loop.unlock();
    f.current = current;
    f.checkpoint = checkpoint;
}

test "sheds the retaining policy under global pressure instead of an unrelated live reader" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{ .rows = 4, .bytes = 100_000 });
    defer t.deinit();
    defer f.deinit();
    const live = try f.subscribe(0, &.{1}, .dispatch);
    const retainer = try f.subscribe(4, &.{1}, .dispatch);
    const other = try f.subscribe(0, &.{2}, .dispatch);
    f.notify(head(101, 101, 1));
    const Pair = struct {
        x: *Sub,
        y: *Sub,
        fn check(ctx: @This()) bool {
            return ctx.x.frames.items.len == 1 and ctx.y.frames.items.len == 1;
        }
    };
    try f.until(Pair{ .x = live, .y = retainer }, Pair.check);
    try testing.expectEqual(@as(usize, 4), f.metrics().rows);
    f.notify(head(101, 100, 2));
    try f.until(other, framesAtLeast(1));
    f.t.loop.lock();
    try testing.expectEqual(@as(usize, 1), retainer.errors.items.len);
    try testing.expectEqualStrings(event_source.RETAINED_LIMIT_MESSAGE, retainer.errors.items[0]);
    f.t.loop.unlock();
    try testing.expectError(error.TemporarilyUnavailable, f.subscribe(4, &.{1}, .dispatch));
    try testing.expectEqual(@as(usize, 0), live.errors.items.len);
    try testing.expectEqual(@as(usize, 0), other.errors.items.len);
}

test "starts from the remaining checkpoint when a stale reader disconnects" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{ .rows = 4, .bytes = 100_000 });
    defer t.deinit();
    defer f.deinit();
    const previous = try f.subscribe(0, &.{1}, .dispatch);
    setHead(&f, 110, null);
    const current = try f.subscribe(0, &.{1}, .dispatch);
    previous.close();
    f.notify(head(111, 110, 1));
    try f.until(current, framesAtLeast(1));
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), f.calls.items.len);
    try testing.expectEqual(@as(i128, 110), f.calls.items[0].after);
    try testing.expectEqualStrings("\"111\"", current.field(0, "height").?);
    try testing.expectEqual(@as(usize, 0), current.errors.items.len);
}

test "lets eligible publications drain before shedding under cache pressure" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{ .rows = 7, .bytes = 100_000 });
    defer t.deinit();
    defer f.deinit();
    var readers: [72]*Sub = undefined;
    for (readers[0..70]) |*sub| sub.* = try f.subscribe(0, &.{1}, .dispatch);
    readers[70] = try f.subscribe(0, &.{2}, .dispatch);
    readers[71] = try f.subscribe(0, &.{3}, .dispatch);
    for ([_]u32{ 1, 2, 3 }) |domain| f.notify(head(103, 100, domain));
    const All = struct {
        fn check(all: []*Sub) bool {
            for (all) |sub| if (sub.frames.items.len < 3) return false;
            return true;
        }
    };
    try f.until(@as([]*Sub, &readers), All.check);
    for (readers) |sub| try testing.expectEqual(@as(usize, 0), sub.errors.items.len);
}

test "streams the sparse checkpoint gap at startup without waiting for another head" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    setHead(&f, 100, 98);
    const sub = try f.subscribe(0, &.{1}, .dispatch);
    try f.until(sub, framesAtLeast(2));
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqualStrings("\"99\"", sub.field(0, "height").?);
    try testing.expectEqualStrings("\"100\"", sub.field(1, "height").?);
    try testing.expectEqualStrings("98", sub.subscription.?.starts()[0].boundary.?.height());
    try testing.expectEqual(@as(usize, 1), f.calls.items.len);
}

test "invalidates handoff and suppresses stale fanout when rollback arrives between send batches" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    var subs: [100]*Sub = undefined;
    for (&subs) |*sub| sub.* = try f.subscribe(0, &.{1}, .dispatch);
    for (subs) |sub| try testing.expectEqualStrings("100", sub.subscription.?.starts()[0].boundary.?.height());
    f.notify(head(101, 101, 1));
    const Any = struct {
        fn check(all: []*Sub) bool {
            for (all) |sub| if (sub.frames.items.len > 0) return true;
            return false;
        }
    };
    try f.until(@as([]*Sub, &subs), Any.check);
    f.notify(head(99, 101, 1));
    std.Thread.sleep(20 * std.time.ns_per_ms);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    for (subs) |sub| {
        var rollback: ?usize = null;
        for (sub.frames.items, 0..) |frame, i| {
            if (std.mem.startsWith(u8, frame, "{\"type\":\"rollback\"")) {
                rollback = i;
                break;
            }
        }
        try testing.expect(rollback != null);
        for (sub.frames.items[rollback.? + 1 ..]) |frame| try testing.expect(!std.mem.startsWith(u8, frame, "{\"type\":\"event\""));
        try testing.expect(sub.subscription.?.starts()[0].boundary == null);
    }
}

test "does not turn a head-only retreat into a rollback" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const sub = try f.subscribe(2, &.{1}, .dispatch);
    f.notify(head(101, 101, 1));
    try f.until(sub, framesAtLeast(1));
    var retreat = head(101, 101, 1);
    retreat.head_height = 100;
    f.notify(retreat);
    std.Thread.sleep(20 * std.time.ns_per_ms);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), sub.frames.items.len);
    try testing.expectEqual(@as(i128, 98), cs.confirmationHeight(100, 101, 2));
}

test "rollback frames carry eventType before domain and the effective count" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const sub = try f.subscribe(1, &.{1}, .merkle_tree_insertion);
    f.notify(head(102, 102, 1));
    try f.until(sub, framesAtLeast(2));
    f.notify(head(100, 102, 1));
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqualStrings(
        "{\"type\":\"rollback\",\"eventType\":\"merkle_tree_insertion\",\"domain\":1,\"confirmations\":1,\"fromHeight\":\"101\",\"toHeight\":\"99\"}",
        sub.frames.items[sub.frames.items.len - 1],
    );
}

test "retries a rolled-back setup snapshot, but not an ordinary advance" {
    for ([_]bool{ true, false }) |rollback| {
        var t: TestLoop = undefined;
        var f: Fixture = undefined;
        newFixture(&t, &f, .{});
        defer t.deinit();
        defer f.deinit();
        const sub = try a.create(Sub);
        sub.* = .{ .f = &f };
        try f.subs.append(a, sub);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const requests = [_]event_source.Request{.{ .event_type = .dispatch, .confirmations = 0, .domains = &.{1} }};
        const loop = &f.t.loop;
        loop.lock();
        const policies = try EventSource.policies(arena.allocator(), &requests);
        var reads: usize = 0;
        var subscription: ?event_source.Subscription = null;
        while (subscription == null) {
            var attempt = f.source.attempt(sub).?;
            reads += 1;
            // The first snapshot is read before a notification lands.
            const value: i128 = if (reads == 1) 100 else 99;
            if (reads == 1) f.source.notify(head(if (rollback) 99 else 101, 100, 1));
            const snapshots = try arena.allocator().alloc(cs.Heads, 1);
            snapshots[0] = .empty;
            try snapshots[0].put(arena.allocator(), 1, .{ .head = value, .indexed = value, .confirmed = 90 });
            subscription = try f.source.subscribeWith(&attempt, &requests, policies, snapshots, sub);
        }
        sub.subscription = subscription;
        subscription.?.start();
        loop.unlock();
        try testing.expectEqual(@as(usize, if (rollback) 2 else 1), reads);
        if (!rollback) {
            const Last = struct {
                fn check(s: *Sub) bool {
                    return s.frames.items.len > 0 and std.mem.eql(u8, s.lastField("height").?, "\"101\"");
                }
            };
            try f.until(sub, Last.check);
        }
        loop.lock();
        for (sub.frames.items) |frame| try testing.expect(!std.mem.startsWith(u8, frame, "{\"type\":\"rollback\""));
        loop.unlock();
    }
}

fn eventIds(sub: *const Sub, out: *std.AutoHashMapUnmanaged(i128, void)) !usize {
    var events: usize = 0;
    for (sub.frames.items) |frame| {
        if (!std.mem.startsWith(u8, frame, "{\"type\":\"event\"")) continue;
        events += 1;
        const start = (std.mem.indexOf(u8, frame, "\"id\":\"") orelse continue) + 6;
        const end = std.mem.indexOfScalarPos(u8, frame, start, '"').?;
        try out.put(a, try std.fmt.parseInt(i128, frame[start..end], 10), {});
    }
    return events;
}

fn countEvents(sub: *const Sub) usize {
    var n: usize = 0;
    for (sub.frames.items) |frame| {
        if (std.mem.startsWith(u8, frame, "{\"type\":\"event\"")) n += 1;
    }
    return n;
}

test "finishes every row of a height after a mid-publication join or rollback" {
    for ([_]bool{ true, false }) |join| {
        var t: TestLoop = undefined;
        var f: Fixture = undefined;
        newFixture(&t, &f, .{});
        defer t.deinit();
        defer f.deinit();
        f.burst_height = if (join) 101 else 102;
        const first = try f.subscribe(0, &.{1}, .dispatch);
        first.hold_after = 30;
        f.notify(head(103, 103, 1));
        const Held = struct {
            fn check(fx: *Fixture) bool {
                return fx.send_held;
            }
        };
        try f.until(&f, Held.check);
        var late = first;
        if (join) {
            setHead(&f, 103, 100);
            late = try f.subscribe(0, &.{1}, .dispatch);
        } else f.notify(head(102, 103, 1));
        f.send_gate.release(&f.t.loop);
        const Done = struct {
            x: *Sub,
            y: *Sub,
            fn check(ctx: @This()) bool {
                return countEvents(ctx.x) == 70 and countEvents(ctx.y) == 70;
            }
        };
        try f.until(Done{ .x = first, .y = late }, Done.check);
        f.t.loop.lock();
        defer f.t.loop.unlock();
        for ([_]*Sub{ first, late }) |sub| {
            var ids: std.AutoHashMapUnmanaged(i128, void) = .empty;
            defer ids.deinit(a);
            _ = try eventIds(sub, &ids);
            try testing.expectEqual(@as(u32, 70), ids.count());
        }
    }
}

test "reads a late cursor prefix before advancing it during a forward scan" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const first = try f.subscribe(0, &.{1}, .dispatch);
    try f.gated.put(a, 1, {});
    f.notify(head(101, 101, 1));
    const OneCall = struct {
        fn check(fx: *Fixture) bool {
            return fx.calls.items.len == 1;
        }
    };
    try f.until(&f, OneCall.check);
    setHead(&f, 101, 98);
    const late = try f.subscribe(2, &.{1}, .dispatch);
    f.gate.release(&f.t.loop);
    try f.until(late, framesAtLeast(1));
    const FirstDone = struct {
        fn check(sub: *Sub) bool {
            return sub.frames.items.len > 0 and std.mem.eql(u8, sub.lastField("height").?, "\"101\"");
        }
    };
    try f.until(first, FirstDone.check);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), late.frames.items.len);
    try testing.expectEqualStrings("\"99\"", late.field(0, "height").?);
}

test "rolls back events released after their confirmation target advances during a read" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    _ = try f.subscribe(0, &.{1}, .dispatch);
    const delayed = try f.subscribe(2, &.{1}, .dispatch);
    try f.gated.put(a, 1, {});
    f.notify(head(103, 103, 1));
    const Called = struct {
        fn check(fx: *Fixture) bool {
            return fx.calls.items.len > 0;
        }
    };
    try f.until(&f, Called.check);
    f.notify(head(105, 105, 1));
    f.gate.release(&f.t.loop);
    const At103 = struct {
        fn check(sub: *Sub) bool {
            return sub.frames.items.len > 0 and std.mem.eql(u8, sub.lastField("height").?, "\"103\"");
        }
    };
    try f.until(delayed, At103.check);
    f.notify(head(104, 105, 1));
    f.t.loop.lock();
    defer f.t.loop.unlock();
    var found = false;
    for (delayed.frames.items, 0..) |frame, i| {
        if (!std.mem.startsWith(u8, frame, "{\"type\":\"rollback\"")) continue;
        const from = delayed.field(i, "fromHeight").?;
        const from_n = try std.fmt.parseInt(i128, from[1 .. from.len - 1], 10);
        if (from_n >= 103 and std.mem.eql(u8, delayed.field(i, "toHeight").?, "\"102\"")) found = true;
    }
    try testing.expect(found);
}

test "isolates a disconnected prefix request when its read fails or finishes" {
    for ([_]bool{ false, true }) |fails| {
        var t: TestLoop = undefined;
        var f: Fixture = undefined;
        newFixture(&t, &f, .{});
        defer t.deinit();
        defer f.deinit();
        const live = try f.subscribe(0, &.{1}, .dispatch);
        const slow = try f.subscribe(5, &.{1}, .dispatch);
        f.notify(head(105, 105, 1));
        const At100 = struct {
            fn check(sub: *Sub) bool {
                return sub.frames.items.len > 0 and std.mem.eql(u8, sub.lastField("height").?, "\"100\"");
            }
        };
        try f.until(slow, At100.check);
        f.t.loop.lock();
        f.hook_next = true;
        f.hook_fails = fails;
        f.t.loop.unlock();
        setHead(&f, 106, 98);
        const requester = try f.subscribe(6, &.{1}, .dispatch);
        const Pending = struct {
            fn check(fx: *Fixture) bool {
                return fx.hook_pending;
            }
        };
        try f.until(&f, Pending.check);
        requester.close();
        slow.close();
        setHead(&f, 106, 99);
        const late = try f.subscribe(1, &.{1}, .dispatch);
        f.gate.release(&f.t.loop);
        const Late = struct {
            late: *Sub,
            live: *Sub,
            fn check(ctx: @This()) bool {
                return (ctx.late.frames.items.len > 0 and std.mem.eql(u8, ctx.late.lastField("height").?, "\"105\"")) or ctx.live.errors.items.len > 0;
            }
        };
        try f.until(Late{ .late = late, .live = live }, Late.check);
        f.t.loop.lock();
        defer f.t.loop.unlock();
        try testing.expectEqual(@as(usize, 0), live.errors.items.len);
        try testing.expectEqual(@as(usize, 6), late.frames.items.len);
        for (late.frames.items, 0..) |_, i| {
            var want: [8]u8 = undefined;
            try testing.expectEqualStrings(try std.fmt.bufPrint(&want, "\"{d}\"", .{100 + i}), late.field(i, "height").?);
        }
    }
}

test "releases cached rows with rollback coverage and suppresses in-flight orphans" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const zero = try f.subscribe(0, &.{1}, .dispatch);
    const delayed = try f.subscribe(2, &.{1}, .dispatch);
    f.notify(head(101, 101, 1));
    const Both = struct {
        x: *Sub,
        y: *Sub,
        fn check(ctx: @This()) bool {
            return ctx.x.frames.items.len == 1 and ctx.y.frames.items.len == 1;
        }
    };
    try f.until(Both{ .x = zero, .y = delayed }, Both.check);
    try f.gated.put(a, 1, {});
    f.notify(head(102, 102, 1));
    const Reading = struct {
        fn check(fx: *Fixture) bool {
            for (fx.calls.items) |call| if (call.through == 102) return true;
            return false;
        }
    };
    try f.until(&f, Reading.check);
    f.notify(head(99, 102, 1));
    f.t.loop.lock();
    try testing.expect(std.mem.startsWith(u8, zero.frames.items[zero.frames.items.len - 1], "{\"type\":\"rollback\""));
    try testing.expect(std.mem.startsWith(u8, delayed.frames.items[delayed.frames.items.len - 1], "{\"type\":\"rollback\""));
    f.replacement = true;
    _ = f.gated.remove(1);
    f.t.loop.unlock();
    f.gate.release(&f.t.loop);
    f.notify(head(102, 102, 1));
    const Caught = struct {
        x: *Sub,
        y: *Sub,
        fn check(ctx: @This()) bool {
            return ctx.x.frames.items.len > 0 and ctx.y.frames.items.len > 0 and
                std.mem.eql(u8, ctx.x.lastField("height") orelse "", "\"102\"") and
                std.mem.eql(u8, ctx.y.lastField("height") orelse "", "\"100\"");
        }
    };
    try f.until(Caught{ .x = zero, .y = delayed }, Caught.check);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    for ([_]*Sub{ zero, delayed }) |sub| {
        var seen_rollback = false;
        for (sub.frames.items, 0..) |frame, i| {
            if (std.mem.startsWith(u8, frame, "{\"type\":\"rollback\"")) {
                seen_rollback = true;
                continue;
            }
            if (seen_rollback) try testing.expectEqualStrings("false", sub.field(i, "orphan").?);
        }
        try testing.expectEqual(@as(usize, 0), sub.errors.items.len);
    }
}

test "admits a full custom fleet without overflowing the shared read queue" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    var domains: [512]u32 = undefined;
    for (&domains, 1..) |*d, i| d.* = @intCast(i);
    var subs: [4]*Sub = undefined;
    for (&subs, [_]protocol.EventType{ .dispatch, .delivery, .gas_payment, .merkle_tree_insertion }) |*sub, event_type| sub.* = try f.subscribe(0, &domains, event_type);
    try testing.expectEqual(@as(usize, 2048), f.metrics().ranges);
    try testing.expectError(error.RangeCapacity, f.subscribe(0, &.{513}, .dispatch));
    for (domains) |domain| f.notify(head(101, 100, domain));
    const All = struct {
        fn check(all: []*Sub) bool {
            for (all) |sub| if (sub.frames.items.len < 512) return false;
            return true;
        }
    };
    try f.until(@as([]*Sub, &subs), All.check);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    for (subs) |sub| try testing.expectEqual(@as(usize, 0), sub.errors.items.len);
    try testing.expectEqual(@as(usize, 2048), f.calls.items.len);
}

test "sheds an owner holding two retaining cursors on one window" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{ .rows = 4, .bytes = 100_000 });
    defer t.deinit();
    defer f.deinit();
    const live = try f.subscribe(0, &.{1}, .dispatch);
    // One owner, two identical retaining cursors on the dispatch:1 window:
    // failing it empties the window while the walk still holds it.
    const retainer = try a.create(Sub);
    retainer.* = .{ .f = &f };
    try f.subs.append(a, retainer);
    {
        const loop = &f.t.loop;
        loop.lock();
        defer loop.unlock();
        const requests = [_]event_source.Request{
            .{ .event_type = .dispatch, .confirmations = 4, .domains = &.{1} },
            .{ .event_type = .dispatch, .confirmations = 4, .domains = &.{1} },
        };
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const policies = try EventSource.policies(arena.allocator(), &requests);
        var attempt = f.source.attempt(retainer).?;
        const snapshots = try arena.allocator().alloc(cs.Heads, policies.len);
        snapshots[0] = .empty;
        try snapshots[0].put(arena.allocator(), 1, .{ .head = 100, .indexed = 100, .confirmed = 90, .live_start = boundary(96) });
        const subscription = (try f.source.subscribeWith(&attempt, &requests, policies, snapshots, retainer)).?;
        try testing.expectEqual(@as(usize, 2), subscription.starts().len);
        retainer.subscription = subscription;
        subscription.start();
    }
    const other = try f.subscribe(0, &.{2}, .dispatch);
    f.notify(head(101, 101, 1));
    try f.until(retainer, framesAtLeast(2));
    try f.until(live, framesAtLeast(1));
    // The live reader leaves: rows above the retainers' target stay cached,
    // and the owner now holds every cursor of the window.
    live.close();
    try testing.expectEqual(@as(usize, 4), f.metrics().rows);
    f.notify(head(101, 100, 2));
    try f.until(other, framesAtLeast(1));
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), retainer.errors.items.len);
    try testing.expectEqualStrings(event_source.RETAINED_LIMIT_MESSAGE, retainer.errors.items[0]);
    try testing.expectEqual(@as(usize, 0), other.errors.items.len);
}

test "survives a rollback send that stops and drops its own subscription" {
    // notify -> update -> send: the server's disconnect can stop and drop the
    // last handle inside send_frame; update still writes the cursor after it.
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const dropped = try f.subscribe(1, &.{1}, .merkle_tree_insertion);
    const other = try f.subscribe(1, &.{1}, .merkle_tree_insertion);
    f.notify(head(102, 102, 1));
    try f.until(dropped, framesAtLeast(2));
    try f.until(other, framesAtLeast(2));
    f.t.loop.lock();
    dropped.drop_on_send = true;
    f.t.loop.unlock();
    f.notify(head(100, 102, 1));
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expect(dropped.subscription == null);
    try testing.expectEqualStrings("\"rollback\"", dropped.lastField("type").?);
    try testing.expectEqualStrings("\"rollback\"", other.lastField("type").?);
    try testing.expectEqual(@as(usize, 1), f.source.metrics().ranges);
}

test "a retained subscription handle keeps its cursors readable after stop" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    const sub = try f.subscribe(1, &.{1}, .dispatch);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    const second = sub.subscription.?.retain();
    sub.active = false;
    sub.subscription.?.stop();
    sub.subscription.?.deinit();
    sub.subscription = null;
    try testing.expectEqual(@as(usize, 1), second.starts().len);
    try testing.expectEqualStrings("99", second.starts()[0].boundary.?.height());
    second.deinit();
    try testing.expectEqual(@as(usize, 0), f.source.metrics().ranges);
}

test "a publication yields to tasks spawned before its yield" {
    // TS `await nextTurn()` is setImmediate: work queued before it runs
    // before the publication resumes, every 64 sends or 256 KiB.
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    f.burst_height = 101;
    const sub = try f.subscribe(0, &.{1}, .dispatch);
    sub.race_after = 1;
    f.notify(head(103, 103, 1));
    const Done = struct {
        fn check(fx: *Fixture) bool {
            return fx.raced_frames != null and countEvents(fx.subs.items[0]) == 70;
        }
    };
    try f.until(&f, Done.check);
    // The 64th send yields before its frame: 63 sent, the task runs, then the rest.
    try testing.expectEqual(@as(?usize, event_source.FANOUT_MESSAGES - 1), f.raced_frames);
}

test "a range read scheduled before a publication's yield starts before it resumes" {
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    f.burst_height = 101;
    const sub = try f.subscribe(0, &.{1}, .dispatch);
    const other = try f.subscribe(0, &.{2}, .dispatch);
    // Domain 2's head arrives in the publication's turn, after its first send.
    sub.notify_after = .{ .frames = 1, .domain = 2 };
    f.read_domain = 2;
    f.read_frames_of = sub;
    f.notify(head(103, 103, 1));
    const Done = struct {
        x: *Sub,
        y: *Sub,
        fn check(ctx: @This()) bool {
            return countEvents(ctx.x) == 70 and countEvents(ctx.y) == 70;
        }
    };
    try f.until(Done{ .x = sub, .y = other }, Done.check);
    f.t.loop.lock();
    defer f.t.loop.unlock();
    try testing.expectEqual(@as(?usize, event_source.FANOUT_MESSAGES - 1), f.read_frames);
}

test "a publication yields to a thread already blocked for the loop" {
    // A socket reader or finished database read blocked in `Loop.lock` runs
    // at the yield too (Node runs pending I/O callbacks before an immediate).
    var t: TestLoop = undefined;
    var f: Fixture = undefined;
    newFixture(&t, &f, .{});
    defer t.deinit();
    defer f.deinit();
    f.burst_height = 101;
    const sub = try f.subscribe(0, &.{1}, .dispatch);
    sub.thread_race_after = 1;
    f.notify(head(103, 103, 1));
    const Done = struct {
        fn check(fx: *Fixture) bool {
            return fx.racer_frames != null and countEvents(fx.subs.items[0]) == 70;
        }
    };
    try f.until(&f, Done.check);
    f.racer.?.join();
    try testing.expectEqual(@as(?usize, event_source.FANOUT_MESSAGES - 1), f.racer_frames);
}
