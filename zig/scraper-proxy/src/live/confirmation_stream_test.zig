//! Ports `confirmation-stream.test.ts` (the protocol cases live in
//! protocol_test.zig). Frames are plain strings; rollbacks are recorded as
//! `rollback:<domain>:<from>:<to>`.
const std = @import("std");
const testing = std.testing;
const runtime = @import("runtime.zig");
const cs = @import("confirmation_stream.zig");
const protocol = @import("protocol.zig");
const TestLoop = @import("notification_worker_test.zig").TestLoop;

fn head(indexed: i128, previous: i128, height: i128, domain: u32) protocol.HeadNotification {
    return .{
        .domain = domain,
        .confirmed_height = 0,
        .indexed_height = indexed,
        .previous_indexed_height = previous,
        .head_height = height,
    };
}

fn h(indexed: i128, previous: i128) protocol.HeadNotification {
    return head(indexed, previous, indexed, 1);
}

const FakeRow = struct {
    position: cs.Position,
    frame: []const u8,
    id: ?[]const u8 = null,
    domains: ?[]const u32 = null,
};

/// Rows the generator yields; `hold_before` waits on the fixture gate before
/// yielding that index (== rows.len: before finishing).
const Plan = struct {
    rows: [4]FakeRow = undefined,
    len: usize = 0,
    hold_before: ?usize = null,
    fail: bool = false,

    fn push(self: *Plan, row: FakeRow) void {
        self.rows[self.len] = row;
        self.len += 1;
    }
};

const Fixture = struct {
    t: *TestLoop,
    stream: *cs.ConfirmationStream = undefined,
    messages: std.ArrayList([]const u8) = .empty,
    active: bool = true,
    failed: bool = false,
    held: runtime.Gate = .{},
    reads: usize = 0,
    enrichments: usize = 0,
    ranges: std.ArrayList(i128) = .empty,
    // Per-test behaviour.
    planFn: *const fn (f: *Fixture, domain: u32, after: cs.Position, through: i128, frontiers: *const cs.Frontiers) Plan,
    sendHoldFn: ?*const fn (f: *Fixture) bool = null,
    enrichFn: ?*const fn (f: *Fixture, ids: []const []const u8, frontiers: *const cs.Frontiers, out: *Plan) void = null,
    flag: bool = true,

    const a = testing.allocator;

    fn deinit(self: *Fixture) void {
        self.t.loop.lock();
        self.active = false;
        self.t.loop.unlock();
        self.held.release(&self.t.loop);
        // Let tasks observe inactivity and drop their stream references.
        for (0..1000) |_| {
            self.t.loop.lock();
            const idle = self.stream.refs == 1;
            self.t.loop.unlock();
            if (idle) break;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        self.t.loop.lock();
        self.stream.release();
        self.t.loop.unlock();
        for (self.messages.items) |message| a.free(message);
        self.messages.deinit(a);
        self.ranges.deinit(a);
    }

    fn io(self: *Fixture) cs.Io {
        return .{
            .ctx = self,
            .active = active_,
            .read = read,
            .send = send,
            .rollback = rollback,
            .fail = fail,
            .enrich = if (self.enrichFn != null) enrich else null,
        };
    }

    fn active_(ctx: *anyopaque) bool {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        return self.active;
    }

    fn record(self: *Fixture, frame: []const u8) void {
        self.messages.append(a, a.dupe(u8, frame) catch @panic("oom")) catch @panic("oom");
    }

    fn send(ctx: *anyopaque, message: cs.Message) bool {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        self.record(message.frame);
        if (self.sendHoldFn) |hold| if (hold(self)) self.held.wait(&self.t.loop);
        return self.active;
    }

    fn rollback(ctx: *anyopaque, domain: u32, from: i128, to: i128) void {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        var buffer: [96]u8 = undefined;
        self.record(std.fmt.bufPrint(&buffer, "rollback:{d}:{d}:{d}", .{ domain, from, to }) catch unreachable);
    }

    fn fail(ctx: *anyopaque, err: anyerror) void {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        std.debug.print("unexpected stream failure: {s}\n", .{@errorName(err)});
        self.failed = true;
        self.active = false;
    }

    const FakeReader = struct {
        f: *Fixture,
        domain: u32,
        after: cs.Position,
        through: i128,
        frontiers: cs.Frontiers,
        plan: ?Plan = null,
        index: usize = 0,

        fn next(ptr: *anyopaque) anyerror!?cs.Row {
            const self: *FakeReader = @ptrCast(@alignCast(ptr));
            if (self.plan == null) self.plan = self.f.planFn(self.f, self.domain, self.after, self.through, &self.frontiers);
            const plan = &self.plan.?;
            if (plan.fail) return error.NoHeightRangeExpected;
            if (plan.hold_before) |hold| if (hold == self.index) self.f.held.wait(&self.f.t.loop);
            if (self.index >= plan.len) return null;
            const row = plan.rows[self.index];
            self.index += 1;
            return .{ .position = row.position, .domains = row.domains, .message = .{ .frame = row.frame, .message_id = row.id } };
        }

        fn deinit(ptr: *anyopaque) void {
            const self: *FakeReader = @ptrCast(@alignCast(ptr));
            self.frontiers.deinit(a);
            a.destroy(self);
        }
    };

    fn read(ctx: *anyopaque, domain: u32, after: cs.Position, through: i128, frontiers: *const cs.Frontiers) anyerror!cs.Reader {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        const reader = try a.create(FakeReader);
        reader.* = .{ .f = self, .domain = domain, .after = after, .through = through, .frontiers = try frontiers.clone(a) };
        return .{ .ptr = reader, .vtable = &.{ .next = FakeReader.next, .deinit = FakeReader.deinit } };
    }

    fn enrich(ctx: *anyopaque, ids: []const []const u8, frontiers: *const cs.Frontiers) anyerror!cs.EnrichResult {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        var plan: Plan = .{};
        self.enrichFn.?(self, ids, frontiers, &plan);
        if (plan.hold_before != null) self.held.wait(&self.t.loop);
        var arena = std.heap.ArenaAllocator.init(a);
        const messages = try arena.allocator().alloc(cs.Enriched, plan.len);
        for (plan.rows[0..plan.len], messages) |row, *message| message.* = .{
            .domains = row.domains,
            .message = .{ .frame = try arena.allocator().dupe(u8, row.frame), .message_id = row.id },
        };
        return .{ .arena = arena, .messages = messages };
    }

    const HeadsCtx = struct {
        domains: []const u32,
        initial: i128,

        fn readHeads(ctx: *anyopaque, allocator: std.mem.Allocator) anyerror!cs.Heads {
            const self: *HeadsCtx = @ptrCast(@alignCast(ctx));
            var heads: cs.Heads = .empty;
            for (self.domains) |domain| try heads.put(allocator, domain, .{ .head = self.initial, .indexed = self.initial, .confirmed = 0 });
            return heads;
        }
    };

    fn setup(self: *Fixture, initial: i128, domains: []const u32) !void {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        self.stream = try cs.ConfirmationStream.create(a, &self.t.loop, 0, domains, self.io());
        var heads: HeadsCtx = .{ .domains = domains, .initial = initial };
        try self.stream.initialize(.{ .ctx = &heads, .read = HeadsCtx.readHeads }, false);
        self.stream.start();
    }

    fn notify(self: *Fixture, notification: protocol.HeadNotification) void {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        self.stream.notify(notification);
    }

    fn count(self: *Fixture, prefix: []const u8) usize {
        var total: usize = 0;
        for (self.messages.items) |message| {
            if (std.mem.startsWith(u8, message, prefix)) total += 1;
        }
        return total;
    }

    fn last(self: *Fixture) []const u8 {
        return self.messages.items[self.messages.items.len - 1];
    }

    fn waitFor(self: *Fixture, comptime check: fn (*Fixture) bool) !void {
        try runtime.until(&self.t.loop, self, check);
    }

    fn settle() void {
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }
};

fn messagesAtLeast(comptime n: usize) fn (*Fixture) bool {
    return struct {
        fn check(f: *Fixture) bool {
            return f.messages.items.len >= n;
        }
    }.check;
}

fn readsAtLeast(comptime n: usize) fn (*Fixture) bool {
    return struct {
        fn check(f: *Fixture) bool {
            return f.reads >= n;
        }
    }.check;
}

test "uses the lower of indexed progress and head minus confirmations" {
    try testing.expectEqual(@as(i128, 15), cs.confirmationHeight(20, 18, 5));
    try testing.expectEqual(@as(i128, 12), cs.confirmationHeight(20, 12, 5));
}

fn rewindTest(comptime pause: enum { read, send }) !void {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Behaviour = struct {
        fn plan(f: *Fixture, _: u32, _: cs.Position, _: i128, _: *const cs.Frontiers) Plan {
            f.reads += 1;
            var result: Plan = .{};
            result.push(.{ .position = .{ .height = 10, .source = 0, .id = 1 }, .frame = if (f.flag) "orphan" else "replacement" });
            if (pause == .read and f.flag) result.hold_before = 0;
            return result;
        }
        fn hold(f: *Fixture) bool {
            return pause == .send and f.flag;
        }
        fn ready(f: *Fixture) bool {
            return if (pause == .read) f.reads == 1 else f.messages.items.len == 1;
        }
        fn replaced(f: *Fixture) bool {
            return f.count("replacement") > 0;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan, .sendHoldFn = Behaviour.hold };
    try f.setup(9, &.{ 1, 2 });
    defer f.deinit();
    f.notify(h(10, 9));
    try f.waitFor(Behaviour.ready);
    f.notify(h(9, 10));
    t.loop.lock();
    try testing.expectEqualStrings("rollback:1:10:9", f.last());
    f.flag = false;
    t.loop.unlock();
    f.notify(h(10, 9));
    f.held.release(&t.loop);
    try f.waitFor(Behaviour.replaced);
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expectEqual(@as(usize, if (pause == .read) 0 else 1), f.count("orphan"));
    try testing.expect(!f.failed);
}

test "rewinds an in-flight read and delivers replacements after a head drop" {
    try rewindTest(.read);
}

test "rewinds an in-flight send and delivers replacements after a head drop" {
    try rewindTest(.send);
}

fn midPageTest(comptime rollback_domain: u32) !void {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Behaviour = struct {
        fn plan(f: *Fixture, domain: u32, after: cs.Position, _: i128, _: *const cs.Frontiers) Plan {
            var result: Plan = .{};
            if (domain != 1) return result;
            f.reads += 1;
            for ([_]i128{ 1, 2 }) |id| {
                if (after.height == 10 and after.id >= id) continue;
                if (f.reads == 1 and id == 2) result.hold_before = result.len;
                result.push(.{ .position = .{ .height = 10, .source = 0, .id = id }, .frame = if (id == 1) "id:1" else "id:2" });
            }
            return result;
        }
        fn second(f: *Fixture) bool {
            return f.count("id:2") > 0;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan };
    try f.setup(9, &.{ 1, 2 });
    defer f.deinit();
    f.notify(h(10, 9));
    try f.waitFor(messagesAtLeast(1));
    f.notify(if (rollback_domain == 1) h(10, 11) else head(8, 9, 8, 2));
    f.held.release(&t.loop);
    try f.waitFor(Behaviour.second);
    t.loop.lock();
    defer t.loop.unlock();
    var ids: std.ArrayList([]const u8) = .empty;
    defer ids.deinit(testing.allocator);
    for (f.messages.items) |message| if (std.mem.startsWith(u8, message, "id:")) try ids.append(testing.allocator, message);
    try testing.expectEqual(@as(usize, 2), ids.items.len);
    try testing.expectEqualStrings("id:1", ids.items[0]);
    try testing.expectEqualStrings("id:2", ids.items[1]);
}

test "resumes within a height after domain 1 rolls back mid-page" {
    try midPageTest(1);
}

test "resumes within a height after domain 2 rolls back mid-page" {
    try midPageTest(2);
}

test "coalesces advancing heads and does not treat a head-only drop as a fork" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Behaviour = struct {
        fn plan(f: *Fixture, _: u32, _: cs.Position, through: i128, _: *const cs.Frontiers) Plan {
            f.ranges.append(testing.allocator, through) catch @panic("oom");
            var result: Plan = .{};
            if (through == 10) result.hold_before = 0;
            result.push(.{ .position = .{ .height = through, .source = 0, .id = 1 }, .frame = "height" });
            return result;
        }
        fn started(f: *Fixture) bool {
            return f.ranges.items.len == 1;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan };
    try f.setup(9, &.{ 1, 2 });
    defer f.deinit();
    f.notify(h(10, 9));
    try f.waitFor(Behaviour.started);
    f.notify(h(11, 10));
    f.notify(h(12, 11));
    f.held.release(&t.loop);
    try f.waitFor(messagesAtLeast(2));
    f.notify(head(12, 12, 11, 1));
    Fixture.settle();
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expectEqualSlices(i128, &.{ 10, 12 }, f.ranges.items);
    try testing.expectEqual(@as(usize, 0), f.count("rollback"));
}

const NegotiationFixture = struct {
    t: *TestLoop,
    stream: *cs.ConfirmationStream = undefined,
    held: runtime.Gate = .{},
    reads: usize = 0,
    hold_every_read: bool,
    done: bool = false,

    fn active(_: *anyopaque) bool {
        return true;
    }
    fn read(_: *anyopaque, _: u32, _: cs.Position, _: i128, _: *const cs.Frontiers) anyerror!cs.Reader {
        @panic("not started");
    }
    fn send(_: *anyopaque, _: cs.Message) bool {
        @panic("not started");
    }
    fn rollback(_: *anyopaque, _: u32, _: i128, _: i128) void {
        @panic("no initial frames to roll back");
    }
    fn fail(_: *anyopaque, _: anyerror) void {
        @panic("unexpected failure");
    }
    fn readHeads(ctx: *anyopaque, allocator: std.mem.Allocator) anyerror!cs.Heads {
        const self: *NegotiationFixture = @ptrCast(@alignCast(ctx));
        self.reads += 1;
        if (self.reads == 1 or self.hold_every_read) self.held.wait(&self.t.loop);
        var heads: cs.Heads = .empty;
        try heads.put(allocator, 1, .{ .head = 9, .indexed = 9, .confirmed = 0 });
        return heads;
    }
    fn initialize(self: *NegotiationFixture) void {
        self.stream.initialize(.{ .ctx = self, .read = readHeads }, false) catch @panic("initialize failed");
        self.done = true;
    }
    fn reading(self: *NegotiationFixture) bool {
        return self.reads == 1;
    }
    fn finished(self: *NegotiationFixture) bool {
        return self.done;
    }

    fn run(self: *NegotiationFixture, notification: protocol.HeadNotification) !void {
        self.t.loop.lock();
        self.stream = try cs.ConfirmationStream.create(testing.allocator, &self.t.loop, 0, &.{1}, .{
            .ctx = self,
            .active = active,
            .read = read,
            .send = send,
            .rollback = rollback,
            .fail = fail,
        });
        self.t.loop.unlock();
        self.t.loop.spawn(initialize, .{self});
        try runtime.until(&self.t.loop, self, reading);
        self.t.loop.lock();
        self.stream.notify(notification);
        self.t.loop.unlock();
        self.held.release(&self.t.loop);
        try runtime.until(&self.t.loop, self, finished);
    }
};

test "retries negotiation if a rollback arrives during the initial read" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    var f: NegotiationFixture = .{ .t = &t, .hold_every_read = false };
    try f.run(h(9, 10));
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expectEqual(@as(usize, 2), f.reads);
    f.stream.release();
}

test "does not retry negotiation for an advancing head or emit rollback before start" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    var f: NegotiationFixture = .{ .t = &t, .hold_every_read = true };
    try f.run(h(10, 9));
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expectEqual(@as(usize, 1), f.reads);
    f.stream.notify(h(8, 9));
    f.stream.release();
}

fn exposedRollbackTest(comptime rollback_domain: u32) !void {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Change = struct { id: []const u8, height: i128 };
    const changes = [_]Change{ .{ .id = "six", .height = 6 }, .{ .id = "nine", .height = 9 } };
    const Behaviour = struct {
        fn plan(_: *Fixture, domain: u32, after: cs.Position, through: i128, _: *const cs.Frontiers) Plan {
            var result: Plan = .{};
            if (domain != 1) return result;
            for (changes) |change| {
                if (change.height > after.height and change.height <= through)
                    result.push(.{ .position = .{ .height = change.height, .source = 0, .id = 1 }, .frame = if (change.height == 6) "six delivered=true" else "nine delivered=true", .id = change.id });
            }
            return result;
        }
        fn enrich(_: *Fixture, ids: []const []const u8, frontiers: *const cs.Frontiers, out: *Plan) void {
            for (changes) |change| {
                if (!protocol.containsString(ids, change.id) or change.height > (frontiers.get(1) orelse 0)) continue;
                const delivered = (frontiers.get(2) orelse 0) >= 6;
                const frame = if (change.height == 6)
                    (if (delivered) "six delivered=true" else "six delivered=false")
                else
                    (if (delivered) "nine delivered=true" else "nine delivered=false");
                out.push(.{ .position = undefined, .frame = frame, .id = change.id });
            }
        }
        fn twoSix(f: *Fixture) bool {
            return f.count("six") == 2;
        }
        fn twoNine(f: *Fixture) bool {
            return f.count("nine") == 2;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan, .enrichFn = Behaviour.enrich };
    try f.setup(5, &.{ 1, 2 });
    defer f.deinit();
    f.notify(head(6, 5, 6, 2));
    f.notify(h(10, 5));
    try f.waitFor(messagesAtLeast(2));
    f.notify(if (rollback_domain == 1) h(8, 10) else head(5, 6, 5, 2));
    try f.waitFor(Behaviour.twoSix);
    {
        t.loop.lock();
        defer t.loop.unlock();
        try testing.expect(std.mem.startsWith(u8, f.messages.items[2], "rollback"));
        try testing.expect(std.mem.startsWith(u8, f.messages.items[3], "six"));
    }
    if (rollback_domain == 2) {
        t.loop.lock();
        try testing.expectEqualStrings("six delivered=false", f.messages.items[3]);
        t.loop.unlock();
        try f.waitFor(Behaviour.twoNine);
    } else {
        Fixture.settle();
        t.loop.lock();
        defer t.loop.unlock();
        try testing.expectEqual(@as(usize, 1), f.count("nine"));
    }
}

test "refreshes previously exposed messages after domain 1 rolls back" {
    try exposedRollbackTest(1);
}

test "refreshes previously exposed messages after domain 2 rolls back" {
    try exposedRollbackTest(2);
}

test "stops retaining messages after their exposed frontiers become canonical" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Behaviour = struct {
        fn plan(_: *Fixture, _: u32, after: cs.Position, through: i128, _: *const cs.Frontiers) Plan {
            var result: Plan = .{};
            if (after.height < 10 and through >= 10)
                result.push(.{ .position = .{ .height = 10, .source = 0, .id = 1 }, .frame = "canonical", .id = "canonical", .domains = &.{1} });
            return result;
        }
        fn enrich(f: *Fixture, _: []const []const u8, _: *const cs.Frontiers, _: *Plan) void {
            f.enrichments += 1;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan, .enrichFn = Behaviour.enrich };
    try f.setup(9, &.{ 1, 2, 3 });
    defer f.deinit();
    f.notify(h(10, 9));
    try f.waitFor(messagesAtLeast(1));
    var confirmed = h(10, 10);
    confirmed.confirmed_height = 10;
    f.notify(confirmed);
    var advanced = h(12, 10);
    advanced.confirmed_height = 10;
    f.notify(advanced);
    Fixture.settle();
    var dropped = h(11, 12);
    dropped.confirmed_height = 10;
    f.notify(dropped);
    Fixture.settle();
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expect(std.mem.startsWith(u8, f.last(), "rollback"));
    try testing.expectEqual(@as(usize, 0), f.enrichments);
}

test "retains the exposed snapshot height when a head-only drop interrupts a page" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Behaviour = struct {
        fn plan(f: *Fixture, _: u32, _: cs.Position, _: i128, _: *const cs.Frontiers) Plan {
            f.reads += 1;
            var result: Plan = .{};
            if (f.reads == 1) {
                result.push(.{ .position = .{ .height = 10, .source = 0, .id = 1 }, .frame = "height:11" });
                result.hold_before = 1;
            }
            return result;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan };
    try f.setup(9, &.{ 1, 2 });
    defer f.deinit();
    f.notify(h(11, 9));
    try f.waitFor(messagesAtLeast(1));
    f.notify(head(11, 11, 10, 1));
    f.notify(head(8, 9, 8, 2));
    f.held.release(&t.loop);
    try f.waitFor(readsAtLeast(2));
    f.notify(h(10, 11));
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expectEqualStrings("rollback:1:11:10", f.last());
}

test "re-reads Explorer metadata if its frontier rolls back during enrichment" {
    var t: TestLoop = undefined;
    t.init();
    defer t.deinit();
    const Behaviour = struct {
        fn plan(_: *Fixture, _: u32, _: cs.Position, _: i128, _: *const cs.Frontiers) Plan {
            return .{ .fail = true };
        }
        fn enrich(f: *Fixture, _: []const []const u8, frontiers: *const cs.Frontiers, out: *Plan) void {
            f.reads += 1;
            const height = frontiers.get(1).?;
            out.push(.{ .position = undefined, .frame = if (height == 8) "height:8" else if (height == 9) "height:9" else "height:?" });
            if (f.reads == 1) out.hold_before = 0;
        }
        fn eight(f: *Fixture) bool {
            return f.count("height:8") > 0;
        }
    };
    var f: Fixture = .{ .t = &t, .planFn = Behaviour.plan, .enrichFn = Behaviour.enrich };
    try f.setup(9, &.{ 1, 2 });
    defer f.deinit();
    t.loop.lock();
    f.stream.refresh(&.{"message"});
    t.loop.unlock();
    try f.waitFor(readsAtLeast(1));
    f.notify(h(8, 9));
    f.held.release(&t.loop);
    try f.waitFor(Behaviour.eight);
    t.loop.lock();
    defer t.loop.unlock();
    try testing.expectEqual(@as(usize, 0), f.count("height:9"));
    try testing.expectEqual(@as(usize, 2), f.reads);
    try testing.expect(!f.failed);
}
