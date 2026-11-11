//! Port of `src/diagnostics/stream.test.ts`. Timers are real; where the TS
//! test relied on Node never firing a 1ms timer between two awaited flushes,
//! the retry delay is long so only explicit flushes drain.
const std = @import("std");
const js = @import("js.zig");
const service_mod = @import("service.zig");
const stream_mod = @import("stream.zig");
const Service = service_mod.Service;
const Stream = stream_mod.Stream;
const Frame = stream_mod.Frame;
const Completion = stream_mod.Completion;
const testing = std.testing;
const gpa = testing.allocator;

const long_retry_ms = 60_000;

fn messageId(buf: *[66]u8, n: usize) []const u8 {
    return std.fmt.bufPrint(buf, "0x{x:0>64}", .{n}) catch unreachable;
}

const Ids = struct {
    bufs: [50][66]u8 = undefined,
    slices: [50][]const u8 = undefined,
    fn init(self: *Ids, start: usize) []const []const u8 {
        for (&self.bufs, &self.slices, 0..) |*b, *s, i| s.* = messageId(b, start + i);
        return &self.slices;
    }
};

/// Fake database + LISTEN connection.
const Mock = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    reads: std.ArrayList([]u8) = .empty,
    broken: bool = false,
    generation: usize = 0,
    generate_rows: bool = false,
    connections: usize = 0,
    handlers: std.ArrayList(Service.Handler) = .empty,
    hold_first_connection: bool = false,
    released: bool = false,
    with_listen: bool = true,
    service: Service = undefined,

    fn init(self: *Mock) void {
        self.service = .{
            .db = .{ .ctx = self, .query = query },
            .listen = if (self.with_listen) .{ .ctx = self, .open = open } else null,
        };
    }

    fn deinit(self: *Mock) void {
        for (self.reads.items) |r| gpa.free(r);
        self.reads.deinit(gpa);
        self.handlers.deinit(gpa);
    }

    fn query(ctx: *anyopaque, arena: std.mem.Allocator, _: []const u8, params: []const ?[]const u8) anyerror![]const js.Value {
        const self: *Mock = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        const requested = params[0].?;
        try self.reads.append(gpa, try gpa.dupe(u8, requested));
        if (self.broken) return error.DatabaseUnavailable;
        if (!self.generate_rows) return &.{};
        self.generation += 1;
        // '{"hex","hex"}' -> one future_event row per requested ID.
        var rows: std.ArrayList(js.Value) = .empty;
        var it = std.mem.tokenizeAny(u8, requested, "{}\",");
        var index: usize = 0;
        while (it.next()) |hex| : (index += 1) {
            const text = try std.fmt.allocPrint(arena,
                \\{{"id":"{d}","message_id":"0x{s}","relayer":"0x{x:0>64}","origin":1,"destination":2,
                \\"observed_at":"2026-11-05T00:00:0{d}Z","received_at":"2026-11-05T00:00:0{d}Z","version":1,
                \\"activity":{{"type":"future_event","generation":{d}}}}}
            , .{ self.generation * 10 + index, hex, 9, self.generation, self.generation, self.generation });
            try rows.append(arena, try js.parse(arena, text));
        }
        return rows.items;
    }

    fn open(ctx: *anyopaque, callbacks: Service.Handler) anyerror!Service.Listener {
        const self: *Mock = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.connections += 1;
        try self.handlers.append(gpa, callbacks);
        if (self.connections == 1 and self.hold_first_connection) {
            while (!self.released) self.cond.wait(&self.mutex);
        }
        return .{ .ctx = self, .stop = stopListener };
    }

    fn stopListener(_: *anyopaque) void {}

    fn readCount(self: *Mock) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.reads.items.len;
    }

    fn handler(self: *Mock, i: usize) Service.Handler {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.handlers.items[i];
    }

    fn connectionCount(self: *Mock) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.connections;
    }
};

/// Subscription handles a test still owns; released after `stop()`, like the
/// WebSocket layer unsubscribing on socket close after the stream stops.
const Handles = struct {
    stream: *Stream,
    list: std.ArrayList(*stream_mod.Subscription) = .empty,

    fn add(self: *Handles, sub: *stream_mod.Subscription) !void {
        try self.list.append(gpa, sub);
    }

    fn release(self: *Handles) void {
        self.stream.stop();
        for (self.list.items) |sub| self.stream.unsubscribe(sub);
        self.list.deinit(gpa);
    }
};

fn waitFor(comptime f: anytype, args: anytype) !void {
    var waited: usize = 0;
    while (!@call(.auto, f, args)) : (waited += 1) {
        if (waited > 2000) return error.Timeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

fn listening(stream: *Stream) bool {
    stream.mutex.lock();
    defer stream.mutex.unlock();
    return stream.listener != null and !stream.connecting;
}

const Rejecting = struct {
    fn send(_: *anyopaque, _: *Frame, done: Completion) bool {
        done.complete(false);
        return false;
    }
    var instance: u8 = 0;
    const sink: stream_mod.Sink = .{ .ctx = &instance, .send = send };
};

/// Records frame types/bytes; optionally rejects or defers completion.
const Recorder = struct {
    mutex: std.Thread.Mutex = .{},
    frames: std.ArrayList(*Frame) = .empty,
    accept: bool = true,
    defer_unavailable: ?Completion = null,
    hold_unavailable: bool = false,

    fn sink(self: *Recorder) stream_mod.Sink {
        return .{ .ctx = self, .send = send };
    }

    fn send(ctx: *anyopaque, frame: *Frame, done: Completion) bool {
        const self: *Recorder = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        frame.retain();
        self.frames.append(gpa, frame) catch unreachable;
        const accept = self.accept;
        const hold = self.hold_unavailable and isUnavailable(frame);
        if (hold) self.defer_unavailable = done;
        self.mutex.unlock();
        if (!hold) done.complete(accept);
        return accept;
    }

    fn deinit(self: *Recorder) void {
        for (self.frames.items) |f| f.release();
        self.frames.deinit(gpa);
    }

    fn count(self: *Recorder) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.frames.items.len;
    }

    fn last(self: *Recorder) *Frame {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.frames.items[self.frames.items.len - 1];
    }
};

fn isUnavailable(frame: *Frame) bool {
    return std.mem.startsWith(u8, frame.bytes, "{\"type\":\"diagnostics_unavailable\"");
}

test "shares the per-IP budget across connections and releases only unused IDs" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .with_listen = false };
    mock.init();
    defer mock.deinit();
    const stream = try Stream.init(gpa, &mock.service);
    defer stream.deinit();
    var a: Ids = .{};
    const ids = a.init(1);
    var extra_buf: [66]u8 = undefined;
    const extra = [_][]const u8{messageId(&extra_buf, 51)};
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    const first = try stream.subscribe("127.0.0.1", ids, Rejecting.sink);
    const duplicate = try stream.subscribe("127.0.0.1", ids, Rejecting.sink);
    try testing.expectError(error.PerIpCapacityExceeded, stream.subscribe("127.0.0.1", &extra, Rejecting.sink));
    try handles.add(try stream.subscribe("127.0.0.2", &extra, Rejecting.sink));
    stream.unsubscribe(first);
    try testing.expectError(error.PerIpCapacityExceeded, stream.subscribe("127.0.0.1", &extra, Rejecting.sink));
    stream.unsubscribe(duplicate);
    try handles.add(try stream.subscribe("127.0.0.1", &extra, Rejecting.sink));
    try testing.expectEqualStrings("Diagnostics subscription per-IP capacity exceeded", stream_mod.subscribeErrorMessage(error.PerIpCapacityExceeded));
}

test "preserves the global budget while allowing overlapping subscriptions" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .with_listen = false };
    mock.init();
    defer mock.deinit();
    const stream = try Stream.init(gpa, &mock.service);
    defer stream.deinit();
    var sets: [4]Ids = .{ .{}, .{}, .{}, .{} };
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    const first = try stream.subscribe("127.0.0.1", sets[0].init(1), Rejecting.sink);
    var ip_bufs: [3][16]u8 = undefined;
    for (1..4) |i| {
        const ip = try std.fmt.bufPrint(&ip_bufs[i - 1], "127.0.0.{d}", .{i + 1});
        try handles.add(try stream.subscribe(ip, sets[i].init(1 + i * 50), Rejecting.sink));
    }
    var b201: [66]u8 = undefined;
    var b200: [66]u8 = undefined;
    const extra = [_][]const u8{messageId(&b201, 201)};
    try testing.expectError(error.CapacityExceeded, stream.subscribe("127.0.0.5", &extra, Rejecting.sink));
    try handles.add(try stream.subscribe("127.0.0.5", &.{messageId(&b200, 200)}, Rejecting.sink));
    stream.unsubscribe(first);
    try handles.add(try stream.subscribe("127.0.0.5", &extra, Rejecting.sink));
}

test "coalesces notifications and reads only affected watched messages" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{};
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, long_retry_ms);
    defer stream.deinit();
    stream.auto_drain = false;
    stream.start();
    try waitFor(listening, .{stream});
    var recorder: Recorder = .{};
    defer recorder.deinit();
    var b1: [66]u8 = undefined;
    var b2: [66]u8 = undefined;
    var b3: [66]u8 = undefined;
    const m1 = messageId(&b1, 1);
    const m2 = messageId(&b2, 2);
    const m3 = messageId(&b3, 3);
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    try handles.add(try stream.subscribe("127.0.0.1", &.{ m1, m2 }, recorder.sink()));
    stream.flush();
    try testing.expectEqual(@as(usize, 1), mock.readCount());
    const expected_first = try std.fmt.allocPrint(gpa, "{{\"{s}\",\"{s}\"}}", .{ m1[2..], m2[2..] });
    defer gpa.free(expected_first);
    try testing.expectEqualStrings(expected_first, mock.reads.items[0]);
    const h = mock.handler(0);
    h.notify(h.ctx, m2[2..]);
    h.notify(h.ctx, m2[2..]);
    h.notify(h.ctx, m3[2..]);
    h.notify(h.ctx, "invalid");
    stream.flush();
    try testing.expectEqual(@as(usize, 2), mock.readCount());
    const expected_second = try std.fmt.allocPrint(gpa, "{{\"{s}\"}}", .{m2[2..]});
    defer gpa.free(expected_second);
    try testing.expectEqualStrings(expected_second, mock.reads.items[1]);
    // Initial snapshots only; the unchanged update is suppressed.
    try testing.expectEqual(@as(usize, 2), recorder.count());
}

const Fair = struct {
    mutex: std.Thread.Mutex = .{},
    remaining: usize = 2,
    mock: *Mock,
    first_frames: std.ArrayList(*Frame) = .empty,
    received: [3]std.StringHashMapUnmanaged(void) = .{ .empty, .empty, .empty },
    subs: [3]Sub = undefined,

    const Sub = struct { fair: *Fair, index: usize };

    fn send(ctx: *anyopaque, frame: *Frame, done: Completion) bool {
        const sub: *Sub = @ptrCast(@alignCast(ctx));
        const self = sub.fair;
        if (isUnavailable(frame)) {
            done.complete(true);
            return true;
        }
        self.mutex.lock();
        if (self.mock.generation == 1) {
            frame.retain();
            self.first_frames.append(gpa, frame) catch unreachable;
        }
        const sent = sub.index > 0 and self.remaining > 0;
        if (sent) {
            self.remaining -= 1;
            self.received[sub.index].put(gpa, frame.message_id, {}) catch unreachable;
        }
        self.mutex.unlock();
        done.complete(sent);
        return sent;
    }
};

test "rotates changing snapshots fairly and shares encoded frame inputs" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .with_listen = false, .generate_rows = true };
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, long_retry_ms);
    defer stream.deinit();
    stream.auto_drain = false;
    var b1: [66]u8 = undefined;
    var b2: [66]u8 = undefined;
    const watched = [_][]const u8{ messageId(&b1, 1), messageId(&b2, 2) };
    var fair: Fair = .{ .mock = &mock };
    defer {
        for (fair.first_frames.items) |f| f.release();
        fair.first_frames.deinit(gpa);
        for (&fair.received) |*r| r.deinit(gpa);
    }
    var ip_bufs: [3][16]u8 = undefined;
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    for (0..3) |i| {
        fair.subs[i] = .{ .fair = &fair, .index = i };
        const ip = try std.fmt.bufPrint(&ip_bufs[i], "127.0.0.{d}", .{i + 1});
        try handles.add(try stream.subscribe(ip, &watched, .{ .ctx = &fair.subs[i], .send = Fair.send }));
    }
    for (0..2) |_| {
        fair.mutex.lock();
        fair.remaining = 2;
        fair.mutex.unlock();
        stream.flush();
    }
    var first_id: usize = 0;
    var shared: ?*Frame = null;
    for (fair.first_frames.items) |frame| {
        if (!std.mem.eql(u8, frame.message_id, watched[0])) continue;
        first_id += 1;
        if (shared) |s| try testing.expect(s == frame) else shared = frame;
    }
    try testing.expectEqual(@as(usize, 3), first_id);
    try testing.expectEqual(@as(u32, 0), fair.received[0].count());
    try testing.expectEqual(@as(u32, 2), fair.received[1].count());
    try testing.expectEqual(@as(u32, 2), fair.received[2].count());
}

test "marks disconnects unavailable, reconnects, and repairs missed wakeups" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{};
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, 1);
    defer stream.deinit();
    stream.auto_drain = false;
    var recorder: Recorder = .{};
    defer recorder.deinit();
    var b1: [66]u8 = undefined;
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    try handles.add(try stream.subscribe("127.0.0.1", &.{messageId(&b1, 1)}, recorder.sink()));
    stream.start();
    try waitFor(listening, .{stream});
    stream.flush();
    try testing.expectEqual(@as(usize, 1), mock.readCount());
    const h = mock.handler(0);
    h.disconnect(h.ctx);
    try testing.expect(isUnavailable(recorder.last()));
    try waitFor(struct {
        fn f(m: *Mock, s: *Stream) bool {
            return m.connectionCount() == 2 and listening(s);
        }
    }.f, .{ &mock, stream });
    stream.flush();
    try testing.expectEqual(@as(usize, 2), mock.connectionCount());
    try testing.expectEqual(@as(usize, 2), mock.readCount());
    try testing.expect(!isUnavailable(recorder.last()));
}

test "reconnects when a listener disconnects before setup settles" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .hold_first_connection = true };
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, 1);
    defer stream.deinit();
    stream.start();
    try waitFor(struct {
        fn f(m: *Mock) bool {
            return m.connectionCount() == 1;
        }
    }.f, .{&mock});
    const h = mock.handler(0);
    h.disconnect(h.ctx);
    mock.mutex.lock();
    mock.released = true;
    mock.cond.broadcast();
    mock.mutex.unlock();
    try waitFor(struct {
        fn f(m: *Mock, s: *Stream) bool {
            return m.connectionCount() == 2 and listening(s);
        }
    }.f, .{ &mock, stream });
}

test "lets healthy recovery supersede a delayed unavailable frame" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{};
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, 1);
    defer stream.deinit();
    stream.auto_drain = false;
    var recorder: Recorder = .{ .hold_unavailable = true };
    defer recorder.deinit();
    var b1: [66]u8 = undefined;
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    try handles.add(try stream.subscribe("127.0.0.1", &.{messageId(&b1, 1)}, recorder.sink()));
    stream.start();
    try waitFor(listening, .{stream});
    stream.flush();
    const h = mock.handler(0);
    h.disconnect(h.ctx);
    try waitFor(struct {
        fn f(m: *Mock, s: *Stream) bool {
            return m.connectionCount() == 2 and listening(s);
        }
    }.f, .{ &mock, stream });
    stream.flush();
    recorder.defer_unavailable.?.complete(true);
    try testing.expectEqual(@as(usize, 3), recorder.count());
    try testing.expect(!isUnavailable(recorder.frames.items[0]));
    try testing.expect(isUnavailable(recorder.frames.items[1]));
    try testing.expect(!isUnavailable(recorder.frames.items[2]));
}

test "retries affected snapshots and outages until their writes succeed" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{};
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, long_retry_ms);
    defer stream.deinit();
    stream.auto_drain = false;
    stream.start();
    try waitFor(listening, .{stream});
    var recorder: Recorder = .{ .accept = false };
    defer recorder.deinit();
    var b1: [66]u8 = undefined;
    const m1 = messageId(&b1, 1);
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    try handles.add(try stream.subscribe("127.0.0.1", &.{m1}, recorder.sink()));
    stream.flush();
    try testing.expectEqual(@as(usize, 1), recorder.count());
    recorder.accept = true;
    stream.flush();
    try testing.expectEqual(@as(usize, 2), recorder.count());
    try testing.expectEqualStrings(recorder.frames.items[0].bytes, recorder.frames.items[1].bytes);
    mock.mutex.lock();
    mock.broken = true;
    mock.mutex.unlock();
    recorder.accept = false;
    const h = mock.handler(0);
    h.notify(h.ctx, m1[2..]);
    stream.flush();
    try testing.expect(isUnavailable(recorder.last()));
    recorder.accept = true;
    stream.flush();
    mock.mutex.lock();
    mock.broken = false;
    mock.mutex.unlock();
    stream.flush();
    try testing.expect(!isUnavailable(recorder.last()));
}

test "unavailable frame helper matches the TS frame shape" {
    @import("testing_log.zig").silence();
    const bytes = try stream_mod.unavailableFrameAlloc(gpa, &.{"0xab"}, "Diagnostics are not configured");
    defer gpa.free(bytes);
    try testing.expectEqualStrings(
        "{\"type\":\"diagnostics_unavailable\",\"message_ids\":[\"0xab\"],\"message\":\"Diagnostics are not configured\"}",
        bytes,
    );
}

test "unsubscribe after stop releases the handle" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .with_listen = false };
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 0, long_retry_ms);
    defer stream.deinit();
    var recorder: Recorder = .{};
    defer recorder.deinit();
    var b1: [66]u8 = undefined;
    const sub = try stream.subscribe("127.0.0.1", &.{messageId(&b1, 1)}, recorder.sink());
    stream.flush();
    stream.stop();
    try testing.expectError(error.Stopped, stream.subscribe("127.0.0.1", &.{messageId(&b1, 1)}, recorder.sink()));
    stream.unsubscribe(sub);
}

const Releasing = struct {
    released: std.atomic.Value(usize) = .init(0),
    fn send(_: *anyopaque, _: *Frame, done: Completion) bool {
        done.complete(true);
        return true;
    }
    fn release(ctx: *anyopaque) void {
        const self: *Releasing = @ptrCast(@alignCast(ctx));
        _ = self.released.fetchAdd(1, .acq_rel);
    }
    fn sink(self: *Releasing) stream_mod.Sink {
        return .{ .ctx = self, .send = send, .release = release };
    }
    fn count(self: *Releasing) usize {
        return self.released.load(.acquire);
    }
};

test "sink release runs once after the last send, off the caller's thread" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .with_listen = false };
    mock.init();
    defer mock.deinit();
    var live_sink: Releasing = .{};
    var late_sink: Releasing = .{};
    {
        const stream = try Stream.initWithTiming(gpa, &mock.service, 0, long_retry_ms);
        defer stream.deinit();
        var b1: [66]u8 = undefined;
        const sub = try stream.subscribe("127.0.0.1", &.{messageId(&b1, 1)}, live_sink.sink());
        const late = try stream.subscribe("127.0.0.2", &.{messageId(&b1, 1)}, late_sink.sink());
        stream.flush();
        try testing.expectEqual(@as(usize, 0), live_sink.count());
        stream.unsubscribe(sub);
        try waitFor(struct {
            fn f(r: *Releasing) bool {
                return r.count() == 1;
            }
        }.f, .{&live_sink});
        stream.stop();
        stream.unsubscribe(late);
        // After stop the release is delivered by deinit.
        try testing.expectEqual(@as(usize, 0), late_sink.count());
    }
    try testing.expectEqual(@as(usize, 1), live_sink.count());
    try testing.expectEqual(@as(usize, 1), late_sink.count());
}

fn timerThreadState(stream: *Stream) enum { none, running, exited } {
    stream.mutex.lock();
    defer stream.mutex.unlock();
    if (stream.thread == null) return .none;
    return if (stream.thread_exited) .exited else .running;
}

fn timerThreadExited(stream: *Stream) bool {
    return timerThreadState(stream) == .exited;
}

test "the timer thread starts on demand and exits when idle" {
    @import("testing_log.zig").silence();
    var mock: Mock = .{ .generate_rows = true };
    mock.init();
    defer mock.deinit();
    const stream = try Stream.initWithTiming(gpa, &mock.service, 1, long_retry_ms);
    defer stream.deinit();
    stream.idle_exit_ms = 20;
    var recorder: Recorder = .{};
    defer recorder.deinit();
    stream.start();
    try waitFor(listening, .{stream});
    // Connected with nothing scheduled: no timer thread at all.
    try testing.expectEqual(.none, timerThreadState(stream));
    var b1: [66]u8 = undefined;
    const m1 = messageId(&b1, 1);
    var handles: Handles = .{ .stream = stream };
    defer handles.release();
    try handles.add(try stream.subscribe("127.0.0.1", &.{m1}, recorder.sink()));
    const h = mock.handler(0);
    for (0..2) |_| {
        const before = recorder.count();
        // A notification schedules a drain: the thread (re)starts and drains it.
        h.notify(h.ctx, m1[2..]);
        try waitFor(struct {
            fn more(r: *Recorder, n: usize) bool {
                return r.count() > n;
            }
        }.more, .{ &recorder, before });
        try waitFor(timerThreadExited, .{stream});
    }
}
