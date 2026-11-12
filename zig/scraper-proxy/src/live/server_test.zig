//! Server-level tests with fake sockets, database and LISTEN connection.
//! Scenario parity against real PostgreSQL lives in SCENARIOS.md (harness).
const std = @import("std");
const testing = std.testing;
const core = @import("core");
const json = core.json;
const runtime = @import("runtime.zig");
const live = @import("server.zig");
const es = @import("event_store.zig");
const TestLoop = @import("notification_worker_test.zig").TestLoop;

const a = testing.allocator;

const FakeSocket = struct {
    mutex: std.Thread.Mutex = .{},
    frames: std.ArrayList([]u8) = .empty,
    open: bool = true,
    terminated: bool = false,
    close_code: ?u16 = null,
    close_reason: [128]u8 = undefined,
    close_reason_len: usize = 0,
    pings: usize = 0,
    buffered: usize = 0,
    fail_sends: bool = false,
    /// Hold send completions until `releaseHeld` (a stalled socket).
    hold: bool = false,
    held: std.ArrayList(*Completion) = .empty,
    /// `try_send_inline` behaviour; `.busy` keeps every send on the queued path.
    inline_mode: live.Socket.InlineResult = .busy,
    /// Offer the vectored write (frames corked per turn).
    many: bool = true,
    /// Vectored writes made (one per flushed cork).
    flushes: usize = 0,
    pool: *runtime.Pool,

    fn socket(self: *FakeSocket) live.Socket {
        return .{ .ptr = self, .vtable = if (self.many) &vtable_many else &vtable_single };
    }

    const vtable_single: live.Socket.VTable = .{
        .send = send,
        .buffered_amount = bufferedAmount,
        .is_open = isOpen,
        .snapshot = snapshot,
        .close = close,
        .terminate = terminate,
        .ping = ping,
        .release = release,
        .try_send_inline = trySendInline,
    };
    const vtable_many: live.Socket.VTable = blk: {
        var v = vtable_single;
        v.try_send_inline_many = trySendInlineMany;
        break :blk v;
    };

    const Completion = struct {
        job: runtime.Pool.Job = .{ .run = run },
        send_job: *live.SendJob,
        ok: bool,

        fn run(job: *runtime.Pool.Job) void {
            const self: *Completion = @alignCast(@fieldParentPtr("job", job));
            const send_job = self.send_job;
            const ok = self.ok;
            a.destroy(self);
            send_job.complete(ok);
        }
    };

    fn send(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) bool {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        const completion = a.create(Completion) catch unreachable;
        self.mutex.lock();
        // Record the frame and its held completion atomically.
        self.frames.append(a, a.dupe(u8, bytes) catch unreachable) catch unreachable;
        completion.* = .{ .send_job = job, .ok = !self.fail_sends };
        const hold = self.hold;
        if (hold) self.held.append(a, completion) catch unreachable;
        self.mutex.unlock();
        if (!hold) self.pool.submit(&completion.job);
        return true;
    }

    fn heldCount(self: *FakeSocket) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.held.items.len;
    }

    /// Complete held sends (optionally failing them) and stop holding.
    fn releaseHeld(self: *FakeSocket, ok: ?bool) void {
        self.mutex.lock();
        self.hold = false;
        const held = self.held.toOwnedSlice(a) catch unreachable;
        self.mutex.unlock();
        defer a.free(held);
        for (held) |completion| {
            if (ok) |value| completion.ok = value;
            self.pool.submit(&completion.job);
        }
    }

    /// Complete the oldest held send only.
    fn releaseOne(self: *FakeSocket) bool {
        self.mutex.lock();
        if (self.held.items.len == 0) {
            self.mutex.unlock();
            return false;
        }
        const completion = self.held.orderedRemove(0);
        self.mutex.unlock();
        self.pool.submit(&completion.job);
        return true;
    }
    /// Same modes as `trySendInline`; `.partial` writes nothing inline and
    /// queues every frame with its job.
    fn trySendInlineMany(ptr: *anyopaque, payloads: []const []const u8, jobs: []const *live.SendJob) live.Socket.ManyResult {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        switch (self.inline_mode) {
            .partial => {
                for (payloads, jobs) |bytes, job| _ = send(ptr, bytes, job);
                self.mutex.lock();
                self.flushes += 1;
                self.mutex.unlock();
                return .{ .written = 0 };
            },
            else => {},
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        switch (self.inline_mode) {
            .written => {
                for (payloads) |bytes| self.frames.append(a, a.dupe(u8, bytes) catch unreachable) catch unreachable;
                self.flushes += 1;
                return .{ .written = payloads.len };
            },
            .failed => {
                self.open = false;
                self.terminated = true;
                return .failed;
            },
            .busy, .partial => return .busy,
        }
    }

    /// `.partial` writes the frame and completes `job` like a queued send
    /// (held while `hold` is set); `buffered` counts the frame until then.
    fn trySendInline(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) live.Socket.InlineResult {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        switch (self.inline_mode) {
            .partial => {
                _ = send(ptr, bytes, job);
                return .partial;
            },
            else => {},
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        switch (self.inline_mode) {
            .written => self.frames.append(a, a.dupe(u8, bytes) catch unreachable) catch unreachable,
            .failed => {
                self.open = false;
                self.terminated = true;
            },
            .busy, .partial => {},
        }
        return self.inline_mode;
    }

    fn bufferedAmount(ptr: *anyopaque) usize {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        return self.buffered;
    }
    fn snapshot(ptr: *anyopaque) live.Socket.Snapshot {
        return .{ .open = isOpen(ptr), .buffered = bufferedAmount(ptr) };
    }
    fn isOpen(ptr: *anyopaque) bool {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.open;
    }
    fn close(ptr: *anyopaque, code: u16, text: []const u8) void {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.open) return;
        self.open = false;
        self.close_code = code;
        @memcpy(self.close_reason[0..text.len], text);
        self.close_reason_len = text.len;
    }
    fn terminate(ptr: *anyopaque) void {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.open = false;
        self.terminated = true;
    }
    fn ping(ptr: *anyopaque) void {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        self.pings += 1;
    }
    fn release(_: *anyopaque) void {}

    fn deinit(self: *FakeSocket) void {
        self.held.deinit(a);
        for (self.frames.items) |item| a.free(item);
        self.frames.deinit(a);
    }

    fn count(self: *FakeSocket) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.frames.items.len;
    }

    fn frame(self: *FakeSocket, index: usize) []const u8 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.frames.items[index];
    }

    fn reason(self: *FakeSocket) []const u8 {
        return self.close_reason[0..self.close_reason_len];
    }
};

const Rule = struct {
    contains: []const u8,
    rows: []const u8 = "[]",
    /// Match only when the first parameter (stored domain) equals this.
    domain: ?f64 = null,
    persistent: bool = false,
    fail: bool = false,
};

const FakeDb = struct {
    mutex: std.Thread.Mutex = .{},
    rules: std.ArrayList(Rule) = .empty,
    queries: std.ArrayList([]u8) = .empty,
    /// Called before each query, without any lock (the loop mutex is released).
    before_query: ?struct { ctx: *anyopaque, func: *const fn (ctx: *anyopaque, sql: []const u8) void } = null,

    fn db(self: *FakeDb) es.Db {
        return .{ .ctx = self, .query = query };
    }

    fn query(ctx: *anyopaque, arena: std.mem.Allocator, sql: []const u8, params: []const json.Value) anyerror![]json.Value {
        const self: *FakeDb = @ptrCast(@alignCast(ctx));
        if (self.before_query) |hook| hook.func(hook.ctx, sql);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.queries.append(a, a.dupe(u8, sql) catch unreachable) catch unreachable;
        for (self.rules.items, 0..) |rule, index| {
            if (std.mem.indexOf(u8, sql, rule.contains) == null) continue;
            if (rule.domain) |domain| if (params.len == 0 or params[0] != .number or params[0].number != domain) continue;
            if (!rule.persistent) _ = self.rules.orderedRemove(index);
            if (rule.fail) return runtime.fail("permission denied for table", .{});
            const rows = try json.parse(arena, rule.rows, .{});
            return rows.array;
        }
        return &.{};
    }

    /// One-shot: the next query containing `contains` returns `rows`.
    fn on(self: *FakeDb, contains: []const u8, rows: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.rules.append(a, .{ .contains = contains, .rows = rows }) catch unreachable;
    }

    fn add(self: *FakeDb, rule: Rule) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.rules.append(a, rule) catch unreachable;
    }

    fn deinit(self: *FakeDb) void {
        for (self.queries.items) |q| a.free(q);
        self.queries.deinit(a);
        self.rules.deinit(a);
    }
};

const FakeListen = struct {
    handler: ?live.ListenHandler = null,
    fail: bool = false,
    stopped: usize = 0,

    fn api(self: *FakeListen) live.Listen {
        return .{ .ctx = self, .listen = listen, .unlisten = unlisten };
    }
    fn listen(ctx: *anyopaque, _: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *FakeListen = @ptrCast(@alignCast(ctx));
        if (self.fail) return error.ConnectionFailed;
        self.handler = handler;
        return self;
    }
    fn unlisten(ctx: *anyopaque, _: *anyopaque) void {
        const self: *FakeListen = @ptrCast(@alignCast(ctx));
        self.stopped += 1;
    }
    fn notify(self: *FakeListen, channel: []const u8, payload: []const u8) void {
        self.handler.?.on_notification(self.handler.?.ctx, channel, payload);
    }
};

const Harness = struct {
    t: TestLoop = undefined,
    db: FakeDb = .{},
    listen: FakeListen = .{},
    server: *live.Server = undefined,
    sockets: std.ArrayList(*FakeSocket) = .empty,
    peers: std.ArrayList(*live.Peer) = .empty,

    fn discard(_: ?*anyopaque, _: core.log.Level, _: []const u8, _: []const u8) void {}

    fn init(self: *Harness, limits: live.Limits) !void {
        // stdout is the test runner's IPC channel; keep pino-style lines off it.
        core.log.setSink(discard, null);
        self.t.init();
        self.server = try live.Server.create(a, &self.t.loop, self.db.db(), self.listen.api(), .{ .limits = limits, .batch_size = 500 }, null);
        try self.server.start();
    }

    fn deinit(self: *Harness) void {
        for (self.sockets.items) |socket| socket.releaseHeld(false);
        self.server.stop();
        for (self.peers.items) |peer| self.server.onClose(peer);
        self.settle();
        self.t.pool.deinit();
        self.server.destroy();
        self.t.loop.deinit();
        self.t.fake.deinit();
        for (self.sockets.items) |s| {
            s.deinit();
            a.destroy(s);
        }
        self.sockets.deinit(a);
        self.peers.deinit(a);
        self.db.deinit();
        core.log.setSink(null, null);
    }

    fn newSocket(self: *Harness) *FakeSocket {
        const s = a.create(FakeSocket) catch unreachable;
        s.* = .{ .pool = &self.t.pool };
        self.sockets.append(a, s) catch unreachable;
        return s;
    }

    fn agent(self: *Harness) struct { *FakeSocket, *live.Peer } {
        const s = self.newSocket();
        const peer = self.server.connectAgent(s.socket());
        self.peers.append(a, peer) catch unreachable;
        return .{ s, peer };
    }

    fn explorer(self: *Harness, url: []const u8, ip: ?[]const u8) struct { *FakeSocket, *live.Peer } {
        const s = self.newSocket();
        const peer = self.server.connectExplorer(s.socket(), .{ .url = url, .cf_connecting_ip = ip, .remote_address = "::ffff:127.0.0.1" });
        self.peers.append(a, peer) catch unreachable;
        return .{ s, peer };
    }

    fn settle(_: *Harness) void {
        std.Thread.sleep(30 * std.time.ns_per_ms);
    }

    fn waitFrames(self: *Harness, s: *FakeSocket, n: usize) !void {
        _ = self;
        for (0..10_000) |_| {
            if (s.count() >= n) return;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        std.debug.print("expected {d} frames, got {d}\n", .{ n, s.count() });
        for (s.frames.items) |item| std.debug.print("  {s}\n", .{item});
        return error.Timeout;
    }
};

fn defaultLimits() live.Limits {
    return .{
        .heartbeat_ms = 250,
        .max_agent_clients = 2,
        .max_buffered_bytes = 1_048_576,
        .max_catch_up_ms = 60_000,
        .max_concurrent_catch_ups = 1,
        .max_explorer_clients = 8,
        .max_total_buffered_bytes = 33_554_432,
    };
}

test "agent negotiation: ready, ping, errors and duplicate subscriptions" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    try testing.expectEqualStrings(
        \\{"confirmations":{"unit":"blocks","liveOnly":true},"eventTypes":["dispatch","delivery","gas_payment","merkle_tree_insertion","blocks"],"historicalStreaming":true,"streamCursorVersions":{"gas_payment":3},"type":"ready"}
    , s.frame(0));
    h.server.onMessage(peer, "{\"type\":\"ping\"}");
    h.server.onMessage(peer, "nope");
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1,2,1]},{\"eventType\":\"gas_payment\",\"domains\":[5],\"streamCursorVersion\":3}]}");
    try h.waitFrames(s, 4);
    try testing.expectEqualStrings("{\"type\":\"pong\"}", s.frame(1));
    try testing.expectEqualStrings("{\"error\":\"Invalid JSON message\",\"type\":\"error\"}", s.frame(2));
    try testing.expectEqualStrings(
        \\{"streams":[{"domains":[1,2],"eventType":"dispatch"},{"domains":[5],"eventType":"gas_payment","streamCursorVersion":3}],"type":"subscribed"}
    , s.frame(3));
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\"}]}");
    try h.waitFrames(s, 5);
    try testing.expectEqualStrings("{\"error\":\"Already subscribed\",\"type\":\"error\"}", s.frame(4));
}

test "agent message rate limit closes with 1008" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    for (0..31) |_| h.server.onMessage(peer, "{\"type\":\"ping\"}");
    try h.waitFrames(s, 32);
    try testing.expectEqualStrings("{\"error\":\"Client message rate limit exceeded\",\"type\":\"error\"}", s.frame(31));
    try testing.expectEqual(@as(?u16, 1008), s.close_code);
    try testing.expectEqualStrings("Client message rate limit exceeded", s.reason());
    // A minute later the window resets (messages are ignored once closed).
    h.t.fake.tick(60_000);
}

test "agent connection limit and listener availability" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    _ = h.agent();
    _ = h.agent();
    const third, _ = h.agent();
    try testing.expectEqual(@as(?u16, 1013), third.close_code);
    try testing.expectEqualStrings("Maximum agent websocket clients reached", third.reason());
    h.listen.handler.?.on_disconnect(h.listen.handler.?.ctx, "terminated");
    try testing.expectEqual(@as(?u16, 1013), h.sockets.items[0].close_code);
    try testing.expectEqualStrings("Database event listener disconnected", h.sockets.items[0].reason());
    const late, _ = h.explorer("/messages", "1.2.3.4");
    try testing.expectEqualStrings("Database event listener unavailable", late.reason());
}

test "live dispatch notification publishes the event frame" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    try h.waitFrames(s, 2);
    h.db.on("\"confirmed_raw_message_dispatch\" AS \"event_row\" WHERE \"event_row\".\"id\" = ANY",
        \\[{"notification_id":"7","destination_domain":-1,"id":"7","msg_body":"\\x00","msg_id":"\\xab","nonce":4,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"}]
    );
    // Not subscribed domain: ignored without a read.
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"dispatch\",\"id\":\"8\",\"domain\":2}");
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"dispatch\",\"id\":\"7\",\"domain\":1}");
    h.t.fake.tick(100);
    try h.waitFrames(s, 3);
    try testing.expectEqualStrings(
        \\{"data":{"destination_domain":4294967295,"id":"7","msg_body":"\\x00","msg_id":"\\xab","nonce":4,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"},"domain":1,"eventType":"dispatch","sequence":"4","type":"event"}
    , s.frame(2));
}

test "sequence catch-up replays then hands off, and a gap closes with 1013" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    h.db.on("COALESCE(MIN(\"nonce\")", "[{\"first\":\"0\",\"last\":\"3\"}]");
    h.db.on("\"nonce\" > $3::bigint",
        \\[{"origin_domain":1,"destination_domain":2,"origin_mailbox":"\\x0000000000000000000000000000000000000001","nonce":2},{"origin_domain":1,"destination_domain":2,"origin_mailbox":"\\x0000000000000000000000000000000000000001","nonce":3}]
    );
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","cursors":[{"domain":1,"address":"0x0000000000000000000000000000000000000001","afterSequence":"1"}]}]}
    );
    try h.waitFrames(s, 5);
    try testing.expectEqualStrings(
        \\{"streams":[{"cursors":[{"address":"0x0000000000000000000000000000000000000001","afterSequence":"1","domain":1}],"domains":[1],"eventType":"dispatch"}],"type":"subscribed"}
    , s.frame(1));
    try testing.expectEqualStrings(
        \\{"data":{"origin_domain":1,"destination_domain":2,"origin_mailbox":"\\x0000000000000000000000000000000000000001","nonce":2},"domain":1,"eventType":"dispatch","sequence":"2","type":"event"}
    , s.frame(2));
    try testing.expectEqualStrings(
        \\{"address":"0x0000000000000000000000000000000000000001","domain":1,"eventType":"dispatch","type":"caught_up","sequence":"3"}
    , s.frame(4));
    // Live row with a gap (expected 4).
    h.db.on("\"event_row\".\"id\" = ANY",
        \\[{"notification_id":"9","origin_domain":1,"destination_domain":2,"origin_mailbox":"\\x0000000000000000000000000000000000000001","nonce":6}]
    );
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"dispatch\",\"id\":\"9\",\"domain\":1}");
    h.t.fake.tick(100);
    for (0..10_000) |_| {
        if (s.close_code != null) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expectEqual(@as(?u16, 1013), s.close_code);
    try testing.expectEqualStrings("dispatch sequence gap: expected 4, received 6", s.reason());
}

test "explorer negotiation: ready frames, validation and per-IP limits" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const global, _ = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(global, 1);
    try testing.expectEqualStrings("{\"eventTypes\":[\"message_upsert\"],\"type\":\"ready\"}", global.frame(0));
    const filtered, _ = h.explorer("/messages?messageIds=0x" ++ "AB" ** 32 ++ "&blocks=true", "1.2.3.4");
    try h.waitFrames(filtered, 1);
    try testing.expectEqualStrings("{\"messageIds\":[\"\\\\x" ++ "ab" ** 32 ++ "\"],\"eventTypes\":[\"message_upsert\",\"block\"],\"type\":\"ready\"}", filtered.frame(0));
    const invalid, _ = h.explorer("/messages?blocks=yes", "1.2.3.4");
    try h.waitFrames(invalid, 1);
    try testing.expectEqualStrings("{\"error\":\"Expected blocks=true\",\"type\":\"error\"}", invalid.frame(0));
    try testing.expectEqualStrings("Invalid subscription", invalid.reason());
    const no_ip, _ = h.explorer("/messages", "not-an-ip");
    try testing.expectEqualStrings("Missing or invalid client IP", no_ip.reason());
    for (0..3) |_| _ = h.explorer("/messages", "1.2.3.4");
    const sixth, _ = h.explorer("/messages", "1.2.3.4");
    try testing.expectEqualStrings("Maximum connections per client reached", sixth.reason());
    const other, _ = h.explorer("/messages", "::1");
    try h.waitFrames(other, 1);
    const snapshot = blk: {
        h.t.loop.lock();
        defer h.t.loop.unlock();
        break :blk h.server.metricsSnapshot();
    };
    try testing.expectEqual(@as(f64, 6), snapshot.connections.messages);
    try testing.expectEqual(@as(f64, 2), snapshot.messageClientIps);
    try testing.expectEqual(@as(f64, 5), snapshot.messageMaxConnectionsPerIp);
}

test "blocks: snapshot after ready, then deduplicated live heads" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    h.db.on("FROM scraper_head", "[{\"domain\":1,\"indexed_height\":\"10\",\"hash\":\"" ++ "AA" ** 32 ++ "\",\"head_height\":\"12\"},{\"domain\":2,\"indexed_height\":\"5\",\"hash\":null,\"head_height\":\"5\"}]");
    const s, _ = h.explorer("/messages?blocks=true", "1.2.3.4");
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"eventTypes\":[\"message_upsert\",\"block\"],\"type\":\"ready\"}", s.frame(0));
    try testing.expectEqualStrings("{\"type\":\"block\",\"domain\":1,\"height\":\"10\",\"hash\":\"0x" ++ "aa" ** 32 ++ "\",\"headHeight\":\"12\"}", s.frame(1));
    const head = "{\"domain\":1,\"confirmedHeight\":\"9\",\"headHeight\":\"12\",\"indexedHeight\":\"10\",\"indexedHash\":\"" ++ "aa" ** 32 ++ "\"}";
    h.listen.notify(live.HEAD_CHANNEL, head);
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"9\",\"headHeight\":\"13\",\"indexedHeight\":\"11\",\"indexedHash\":\"" ++ "bb" ** 32 ++ "\"}");
    try h.waitFrames(s, 3);
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count());
    try testing.expectEqualStrings("{\"type\":\"block\",\"domain\":1,\"height\":\"11\",\"hash\":\"0x" ++ "bb" ** 32 ++ "\",\"headHeight\":\"13\"}", s.frame(2));
}

test "heartbeat pings, then terminates clients that never pong" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    h.t.fake.tick(250);
    try h.waitFrames(s, 2);
    try testing.expectEqual(@as(usize, 1), s.pings);
    try testing.expectEqualStrings("{\"serverTime\":\"1970-01-01T00:00:00.250Z\",\"type\":\"heartbeat\"}", s.frame(1));
    h.server.onPong(peer);
    h.t.fake.tick(250);
    try testing.expect(!s.terminated);
    h.t.fake.tick(250);
    try testing.expect(s.terminated);
}

test "outbound buffer limit terminates the socket" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.max_buffered_bytes = 1024;
    try h.init(limits);
    defer h.deinit();
    const s = h.newSocket();
    s.buffered = 1000;
    const peer = h.server.connectAgent(s.socket());
    try h.peers.append(a, peer);
    try testing.expect(s.terminated);
    try testing.expectEqual(@as(usize, 0), s.count());
}

test "isoTime matches Date#toISOString" {
    try testing.expectEqualStrings("2024-02-29T23:59:59.007Z", &live.isoTime(1709251199007));
    try testing.expectEqualStrings("1970-01-01T00:00:00.000Z", &live.isoTime(0));
}

fn waitClosed(s: *FakeSocket) !void {
    for (0..10_000) |_| {
        if (!FakeSocket.isOpen(s)) return;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
}

test "explorer canonical upserts follow message notifications and filters" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const id = "ab" ** 32;
    const global, _ = h.explorer("/messages", "1.2.3.4");
    const other, _ = h.explorer("/messages?messageIds=" ++ "cd" ** 32, "1.2.3.4");
    try h.waitFrames(global, 1);
    try h.waitFrames(other, 1);
    h.db.on("FROM \"message_view\"", "[{\"msg_id\":\"\\\\x" ++ id ++ "\",\"nonce\":1}]");
    h.listen.notify(live.EXPLORER_CHANNEL, "{\"messageId\":\"" ++ id ++ "\"}");
    // Unknown ids for filtered-only clients are dropped before queueing.
    h.t.fake.tick(100);
    try h.waitFrames(global, 2);
    try testing.expectEqualStrings("{\"data\":{\"msg_id\":\"\\\\x" ++ id ++ "\",\"nonce\":1},\"type\":\"message_upsert\"}", global.frame(1));
    h.settle();
    try testing.expectEqual(@as(usize, 1), other.count());
}

test "confirmed head ranges publish agent events and queue Explorer ids" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const agent, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\",\"domains\":[1]}]}");
    try h.waitFrames(agent, 2);
    const explorer, _ = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(explorer, 1);
    const id = "cd" ** 32;
    h.db.on("\"confirmed_delivered_message\" AS \"frontier_row\"",
        \\[{"time_created":"t","msg_id":"\\x
    ++ id ++
        \\","domain":1,"destination_mailbox":"\\x01","destination_tx_id":"5","sequence":"3","frontier_id":"11","frontier_height":"9"}]
    );
    h.db.on("FROM \"message_view\"", "[{\"msg_id\":\"\\\\x" ++ id ++ "\"}]");
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"10\",\"previousConfirmedHeight\":\"8\"}");
    h.t.fake.tick(100);
    try h.waitFrames(agent, 3);
    try testing.expectEqualStrings(
        \\{"data":{"time_created":"t","msg_id":"\\x
    ++ id ++
        \\","domain":1,"destination_mailbox":"\\x01","destination_tx_id":"5","sequence":"3"},"domain":1,"eventType":"delivery","type":"event"}
    , agent.frame(2));
    for (0..200) |_| {
        h.t.fake.tick(100);
        if (explorer.count() >= 2) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try h.waitFrames(explorer, 2);
    try testing.expectEqualStrings("{\"data\":{\"msg_id\":\"\\\\x" ++ id ++ "\"},\"type\":\"message_upsert\"}", explorer.frame(1));
}

test "custom Explorer confirmations: canonical fallback domains and rollback frames" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    h.db.on("SELECT domain, head_height, indexed_height, confirmed_height", "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"8\"}]");
    const s, _ = h.explorer("/messages?confirmations=1&domains=1,2", "1.2.3.4");
    try h.waitFrames(s, 1);
    try testing.expectEqualStrings(
        \\{"confirmations":1,"domains":[1,2],"customDomains":[1],"canonicalDomains":[2],"eventTypes":["message_upsert","rollback"],"type":"ready"}
    , s.frame(0));
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"8\",\"headHeight\":\"10\",\"indexedHeight\":\"8\",\"previousIndexedHeight\":\"10\"}");
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"type\":\"rollback\",\"domain\":1,\"confirmations\":1,\"fromHeight\":\"9\",\"toHeight\":\"8\"}", s.frame(1));
}

test "custom confirmations unavailable rejects the agent subscription" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[7],\"confirmations\":2}]}");
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"error\":\"Custom confirmations unavailable for domain 7\",\"type\":\"error\"}", s.frame(1));
    try waitClosed(s);
    try testing.expectEqualStrings("Invalid subscription", s.reason());
}

fn metricsOf(h: *Harness) core.metrics.WebSocketMetricsSnapshot {
    h.t.loop.lock();
    defer h.t.loop.unlock();
    return h.server.metricsSnapshot();
}

fn upsertRows(comptime ids: []const []const u8) []const u8 {
    comptime var out: []const u8 = "[";
    inline for (ids, 0..) |id, index| out = out ++ (if (index > 0) "," else "") ++ "{\"msg_id\":\"\\\\x" ++ id ++ "\"}";
    return out ++ "]";
}

fn notifyExplorer(h: *Harness, comptime id: []const u8) void {
    h.listen.notify(live.EXPLORER_CHANNEL, "{\"messageId\":\"" ++ id ++ "\"}");
}

test "keeps fast Explorer clients independent from a stalled client (60, 64)" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const stalled, _ = h.explorer("/messages", "1.2.3.4");
    const fast, _ = h.explorer("/messages", "1.2.3.5");
    try h.waitFrames(stalled, 1);
    try h.waitFrames(fast, 1);
    h.settle();
    stalled.hold = true;
    const first = "02" ** 32;
    const second = "03" ** 32;
    h.db.on("FROM \"message_view\"", comptime upsertRows(&.{ first, second }));
    notifyExplorer(&h, first);
    notifyExplorer(&h, second);
    h.t.fake.tick(100);
    try h.waitFrames(fast, 3);
    try h.waitFrames(stalled, 2);
    h.settle();
    try testing.expectEqual(@as(usize, 2), stalled.count());
    const frame_bytes = stalled.frame(1).len;
    const pending = metricsOf(&h);
    try testing.expectEqual(@as(f64, 1), pending.explorerPendingMessages);
    try testing.expectEqual(@as(f64, @floatFromInt(frame_bytes)), pending.explorerPendingBytes);
    try testing.expectEqual(@as(f64, @floatFromInt(frame_bytes)), pending.outboundPendingBytes);
    stalled.releaseHeld(null);
    try h.waitFrames(stalled, 3);
    try testing.expectEqualStrings(fast.frame(2), stalled.frame(2));
}

test "sheds only an Explorer client that exceeds its queue limit (62)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000; // the tick loop below must not trigger heartbeats
    try h.init(limits);
    defer h.deinit();
    const slow, _ = h.explorer("/messages", "1.2.3.4");
    const fast, _ = h.explorer("/messages", "1.2.3.5");
    try h.waitFrames(slow, 1);
    try h.waitFrames(fast, 1);
    h.settle();
    slow.hold = true;
    // Deterministic pacing: before each message_view batch, wait until the fast
    // client has been sent everything queued so far (TS: real DB latency).
    const Pacer = struct {
        fast: *FakeSocket,
        batches: usize = 0,
        fn before(ctx: *anyopaque, sql: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            if (std.mem.indexOf(u8, sql, "FROM \"message_view\"") == null) return;
            const expected = 1 + 100 * self.batches;
            self.batches += 1;
            for (0..10_000) |_| {
                if (self.fast.count() >= expected) return;
                std.Thread.sleep(std.time.ns_per_ms);
            }
        }
    };
    var pacer: Pacer = .{ .fast = fast };
    h.db.before_query = .{ .ctx = &pacer, .func = Pacer.before };
    const before = core.metrics.websocket_send_failures.get(.{"queue_limit"});
    // 21 batches of 100 ids, each answered with 100 rows.
    var batch: std.ArrayList(u8) = .empty;
    defer batch.deinit(a);
    try batch.append(a, '[');
    for (0..100) |index| {
        if (index > 0) try batch.append(a, ',');
        try batch.print(a, "{{\"msg_id\":\"\\\\x{x:0>64}\"}}", .{index});
    }
    try batch.append(a, ']');
    for (0..21) |_| h.db.on("FROM \"message_view\"", batch.items);
    for (0..2100) |index| {
        var payload: [96]u8 = undefined;
        h.listen.notify(live.EXPLORER_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"messageId\":\"{x:0>64}\"}}", .{index + 1}));
    }
    h.t.fake.tick(100);
    for (0..30_000) |_| {
        if (slow.terminated and fast.count() >= 2101) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expect(slow.terminated);
    try testing.expect(!fast.terminated and FakeSocket.isOpen(fast));
    try h.waitFrames(fast, 2101);
    try testing.expectEqual(before + 1, core.metrics.websocket_send_failures.get(.{"queue_limit"}));
    const after = metricsOf(&h);
    try testing.expectEqual(@as(f64, 1), after.connections.messages);
    try testing.expectEqual(@as(f64, 0), after.explorerPendingMessages);
}

test "releases a peer-closed Explorer queue immediately (63)" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    const first = "04" ** 32;
    const second = "05" ** 32;
    h.db.on("FROM \"message_view\"", comptime upsertRows(&.{ first, second }));
    notifyExplorer(&h, first);
    notifyExplorer(&h, second);
    h.t.fake.tick(100);
    try h.waitFrames(s, 2);
    h.settle();
    try testing.expectEqual(@as(f64, 1), metricsOf(&h).explorerPendingMessages);
    h.server.onClose(peer);
    _ = h.peers.pop();
    const closed = metricsOf(&h);
    try testing.expectEqual(@as(f64, 0), closed.connections.messages);
    try testing.expectEqual(@as(f64, 0), closed.explorerPendingMessages);
    try testing.expectEqual(@as(f64, 0), closed.explorerPendingBytes);
    s.releaseHeld(false);
    h.settle();
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
}

test "reports an active send failure once (65)" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, _ = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(s, 1);
    h.settle();
    s.fail_sends = true;
    const before = core.metrics.websocket_send_failures.get(.{"send_error"});
    const id = "06" ** 32;
    h.db.on("FROM \"message_view\"", comptime upsertRows(&.{id}));
    notifyExplorer(&h, id);
    h.t.fake.tick(100);
    for (0..1000) |_| {
        if (s.terminated) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.settle();
    try testing.expect(s.terminated);
    try testing.expectEqual(before + 1, core.metrics.websocket_send_failures.get(.{"send_error"}));
}

test "does not report heartbeat cleanup as a send failure (68)" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, _ = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    const id = "07" ** 32;
    h.db.on("FROM \"message_view\"", comptime upsertRows(&.{id}));
    notifyExplorer(&h, id);
    h.t.fake.tick(100);
    try h.waitFrames(s, 2);
    const before = core.metrics.websocket_send_failures.get(.{"send_error"});
    h.t.fake.tick(250); // ping (no pong)
    h.t.fake.tick(250); // terminate
    try testing.expect(s.terminated);
    s.releaseHeld(false);
    h.settle();
    try testing.expectEqual(before, core.metrics.websocket_send_failures.get(.{"send_error"}));
    const after = metricsOf(&h);
    try testing.expectEqual(@as(f64, 0), after.outboundPendingBytes);
    try testing.expectEqual(@as(f64, 0), after.connections.messages);
}

test "rejects out-of-range heartbeat intervals without starting timers (69)" {
    for ([_]u64{ 0, 2147483648 }) |heartbeat| {
        var h: Harness = .{};
        var limits = defaultLimits();
        limits.heartbeat_ms = heartbeat;
        try testing.expectError(error.InvalidHeartbeat, h.init(limits));
        try testing.expectEqual(@as(usize, 0), h.t.fake.pending());
        try testing.expectEqual(@as(usize, 0), h.listen.stopped);
        try testing.expect(h.listen.handler == null);
        h.t.pool.deinit();
        h.server.destroy();
        h.t.fake.deinit();
        core.log.setSink(null, null);
    }
}

test "paces historical sends by send completion (24)" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    h.db.on("COALESCE(MIN(\"leaf_index\")", "[{\"first\":\"0\",\"last\":\"1\"}]");
    h.db.on("\"leaf_index\" > $3::bigint",
        \\[{"domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":0,"message_id":"\\xaa","block_number":5},{"domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":1,"message_id":"\\xbb","block_number":6}]
    );
    s.hold = true;
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","cursors":[{"domain":1,"address":"0x0000000000000000000000000000000000000001","afterSequence":"-1"}]}]}
    );
    try h.waitFrames(s, 3);
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count()); // ready, subscribed, event 0
    try testing.expect(std.mem.indexOf(u8, s.frame(2), "\"sequence\":\"0\"") != null);
    try testing.expectEqual(@as(usize, 2), s.heldCount()); // subscribed + event 0
    try testing.expect(s.releaseOne()); // subscribed
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count()); // still paced on event 0
    try testing.expect(s.releaseOne()); // event 0
    try h.waitFrames(s, 4);
    h.settle();
    try testing.expectEqual(@as(usize, 4), s.count());
    try testing.expect(std.mem.indexOf(u8, s.frame(3), "\"sequence\":\"1\"") != null);
    s.releaseHeld(null);
    try h.waitFrames(s, 5);
    try testing.expectEqualStrings(
        \\{"address":"0x0000000000000000000000000000000000000001","domain":1,"eventType":"merkle_tree_insertion","type":"caught_up","sequence":"1"}
    , s.frame(4));
}

test "keeps one failing frontier domain from blocking another, then disconnects only its subscribers (49, 50)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const both, const both_peer = h.agent();
    const two, const two_peer = h.agent();
    h.server.onMessage(both_peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\",\"domains\":[1,2]}]}");
    h.server.onMessage(two_peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\",\"domains\":[2]}]}");
    try h.waitFrames(both, 2);
    try h.waitFrames(two, 2);
    const frontier = "\"confirmed_delivered_message\" AS \"frontier_row\"";
    h.db.add(.{ .contains = frontier, .domain = 1, .persistent = true, .fail = true });
    h.db.add(.{ .contains = frontier, .domain = 2, .persistent = true, .rows =
        \\[{"time_created":"t","msg_id":"\\xcd","domain":2,"destination_mailbox":"\\x01","destination_tx_id":"5","sequence":"3","frontier_id":"11","frontier_height":"9"}]
    });
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"10\",\"previousConfirmedHeight\":\"8\"}");
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":2,\"confirmedHeight\":\"10\",\"previousConfirmedHeight\":\"8\"}");
    h.t.fake.tick(100);
    // Domain 2 is published despite domain 1 failing first.
    try h.waitFrames(both, 3);
    try h.waitFrames(two, 3);
    try testing.expect(FakeSocket.isOpen(both));
    // Second and third failures retry after LISTENER_RETRY_MS.
    for (0..2) |_| {
        h.settle();
        h.t.fake.tick(1_000);
    }
    try waitClosed(both);
    try testing.expectEqual(@as(?u16, 1013), both.close_code);
    try testing.expectEqualStrings("Event stream read failed", both.reason());
    h.settle();
    try testing.expect(FakeSocket.isOpen(two));
    try testing.expectEqual(@as(usize, 3), two.count());
    const metrics = metricsOf(&h);
    try testing.expectEqual(@as(f64, 1), metrics.connections.agent);
}

fn subscribeMerkleCursor(h: *Harness, peer: *live.Peer) void {
    h.db.on("COALESCE(MIN(\"leaf_index\")", "[{\"first\":\"0\",\"last\":\"0\"}]");
    h.db.on("\"leaf_index\" > $3::bigint",
        \\[{"domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":0,"message_id":"\\xaa","block_number":5}]
    );
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","cursors":[{"domain":1,"address":"0x0000000000000000000000000000000000000001","afterSequence":"-1"}]}]}
    );
}

test "queues catch-ups at the concurrency limit and cancels waiters on disconnect (25)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const first, const first_peer = h.agent();
    const second, const second_peer = h.agent();
    try h.waitFrames(first, 1);
    try h.waitFrames(second, 1);
    h.settle();
    first.hold = true;
    subscribeMerkleCursor(&h, first_peer);
    try h.waitFrames(first, 3); // subscribed + event 0, write pending
    subscribeMerkleCursor(&h, second_peer);
    try h.waitFrames(second, 2); // subscribed only: waiting for the slot
    h.settle();
    try testing.expectEqual(@as(usize, 2), second.count());
    try testing.expectEqual(@as(f64, 1), metricsOf(&h).catchUps);
    // A waiting catch-up is cancelled by disconnect without taking the slot.
    const aborted = core.metrics.websocket_catch_ups.get(.{"aborted"});
    h.server.onClose(second_peer);
    h.peers.items[1] = h.peers.items[0];
    _ = h.peers.pop();
    h.settle();
    try testing.expectEqual(aborted, core.metrics.websocket_catch_ups.get(.{"aborted"}));
    const success = core.metrics.websocket_catch_ups.get(.{"success"});
    first.releaseHeld(null);
    try h.waitFrames(first, 4);
    try testing.expectEqualStrings(
        \\{"address":"0x0000000000000000000000000000000000000001","domain":1,"eventType":"merkle_tree_insertion","type":"caught_up","sequence":"0"}
    , first.frame(3));
    h.settle();
    try testing.expectEqual(success + 1, core.metrics.websocket_catch_ups.get(.{"success"}));
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).catchUps);
}

test "a queued catch-up starts when the slot is released (25)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const first, const first_peer = h.agent();
    const second, const second_peer = h.agent();
    try h.waitFrames(first, 1);
    try h.waitFrames(second, 1);
    h.settle();
    first.hold = true;
    subscribeMerkleCursor(&h, first_peer);
    try h.waitFrames(first, 3);
    subscribeMerkleCursor(&h, second_peer);
    try h.waitFrames(second, 2);
    h.settle();
    try testing.expectEqual(@as(usize, 2), second.count());
    first.releaseHeld(null);
    try h.waitFrames(first, 4);
    try h.waitFrames(second, 4);
    try testing.expect(std.mem.indexOf(u8, second.frame(2), "\"sequence\":\"0\"") != null);
    try testing.expect(std.mem.indexOf(u8, second.frame(3), "caught_up") != null);
}

fn advisoryTest(comptime available: bool) !void {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.db.on("SELECT domain, head_height, indexed_height, confirmed_height", if (available)
        "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"5\"}]"
    else
        "[]");
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","includeZeroConfirmations":true,"cursors":[{"domain":1,"address":"0x0000000000000000000000000000000000000001","afterSequence":"-1"},{"domain":2,"address":"0x0000000000000000000000000000000000000001","afterSequence":"-1"}]}]}
    );
    // ready, subscribed, two caught_up frames (no history): no rejection.
    try h.waitFrames(s, 4);
    try testing.expect(std.mem.indexOf(u8, s.frame(1), "\"includeZeroConfirmations\":true") != null);
    for ([_][]const u8{ "1", "2" }) |domain| {
        var payload: [160]u8 = undefined;
        h.listen.notify(live.HEAD_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"domain\":{s},\"headHeight\":\"11\",\"indexedHeight\":\"11\",\"previousIndexedHeight\":\"10\",\"confirmedHeight\":\"5\"}}", .{domain}));
    }
    h.t.fake.tick(100);
    h.settle();
    h.settle();
    var reads: usize = 0;
    h.db.mutex.lock();
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "confirmation_events") != null) reads += 1;
    }
    h.db.mutex.unlock();
    try testing.expectEqual(@as(usize, if (available) 1 else 0), reads);
    for (s.frames.items) |item| try testing.expect(std.mem.indexOf(u8, item, "\"type\":\"error\"") == null);
    try testing.expect(FakeSocket.isOpen(s));
}

test "preserves canonical replay with no advisory near-head coverage (#10026)" {
    try advisoryTest(false);
}

test "preserves canonical replay with partial advisory near-head coverage (#10026)" {
    try advisoryTest(true);
}

test "an upgrade that races stop() is closed and never admitted" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    h.server.stop();
    const agent, _ = h.agent();
    const explorer, _ = h.explorer("/messages", "1.2.3.4");
    for ([_]*FakeSocket{ agent, explorer }) |s| {
        try testing.expectEqual(@as(?u16, 1001), s.close_code);
        try testing.expectEqualStrings("Server stopping", s.reason());
        try testing.expectEqual(@as(usize, 0), s.count());
    }
    const after = metricsOf(&h);
    try testing.expectEqual(@as(f64, 0), after.connections.agent);
    try testing.expectEqual(@as(f64, 0), after.connections.messages);
}

test "agent notification queue: coalesces at the 10k cap, then fails the stream on overflow" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\",\"domains\":[1]}]}");
    try h.waitFrames(s, 2);
    var payload: [96]u8 = undefined;
    for (0..10_000) |id| h.listen.notify(live.EVENT_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"eventType\":\"delivery\",\"id\":\"{d}\",\"domain\":1}}", .{id}));
    // A repeat of a queued id coalesces at the cap instead of overflowing.
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"delivery\",\"id\":\"0\",\"domain\":1}");
    try testing.expectEqual(@as(f64, 10_000), metricsOf(&h).notificationQueue.agent);
    try testing.expect(FakeSocket.isOpen(s));
    const overflows = core.metrics.websocket_notification_queue_overflows.get(.{"agent"});
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"delivery\",\"id\":\"10000\",\"domain\":1}");
    try testing.expectEqual(overflows + 1, core.metrics.websocket_notification_queue_overflows.get(.{"agent"}));
    try testing.expectEqualStrings("Event stream read failed", s.reason());
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).notificationQueue.agent);
}

test "agent notification queue drains 10k ids in 1000-id batches in order" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\",\"domains\":[1]}]}");
    try h.waitFrames(s, 2);
    var payload: [96]u8 = undefined;
    for (0..10_000) |id| h.listen.notify(live.EVENT_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"eventType\":\"delivery\",\"id\":\"{d}\",\"domain\":1}}", .{id}));
    h.t.fake.tick(100);
    for (0..10_000) |_| {
        if (metricsOf(&h).notificationQueue.agent == 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.settle();
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    var batches: usize = 0;
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "\"confirmed_delivered_message\" AS \"event_row\"") != null) batches += 1;
    }
    try testing.expectEqual(@as(usize, 10), batches);
}

test "a heartbeat fired long after its deadline pings, then terminates a silent client" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, _ = h.agent();
    try h.waitFrames(s, 1);
    // One tick far past several deadlines: each fire re-arms from the fire time.
    h.t.fake.tick(10_000);
    try testing.expect(s.terminated);
    try testing.expect(s.pings >= 1);
    try testing.expect(std.mem.indexOf(u8, s.frame(1), "\"type\":\"heartbeat\"") != null);
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).connections.agent);
}

test "inline writes: catch-up completes without send callbacks" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true; // any queued send would stall the replay
    s.inline_mode = .written;
    h.db.on("COALESCE(MIN(\"leaf_index\")", "[{\"first\":\"0\",\"last\":\"1\"}]");
    h.db.on("\"leaf_index\" > $3::bigint",
        \\[{"domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":0,"message_id":"\\xaa","block_number":5},{"domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":1,"message_id":"\\xbb","block_number":6}]
    );
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","cursors":[{"domain":1,"address":"0x0000000000000000000000000000000000000001","afterSequence":"-1"}]}]}
    );
    try h.waitFrames(s, 5);
    try testing.expect(std.mem.indexOf(u8, s.frame(4), "caught_up") != null);
    try testing.expectEqual(@as(usize, 0), s.heldCount());
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
}

test "inline writes: Explorer queue drains in order without callbacks" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, _ = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    s.inline_mode = .written;
    const first = "08" ** 32;
    const second = "09" ** 32;
    h.db.on("FROM \"message_view\"", comptime upsertRows(&.{ first, second }));
    notifyExplorer(&h, first);
    notifyExplorer(&h, second);
    h.t.fake.tick(100);
    try h.waitFrames(s, 3);
    try testing.expect(std.mem.indexOf(u8, s.frame(1), first) != null);
    try testing.expect(std.mem.indexOf(u8, s.frame(2), second) != null);
    try testing.expectEqual(@as(usize, 0), s.heldCount());
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).explorerPendingMessages);
}

test "inline write failure counts one send error and terminates" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.inline_mode = .failed;
    const before = core.metrics.websocket_send_failures.get(.{"send_error"});
    h.server.onMessage(peer, "{\"type\":\"ping\"}");
    try testing.expect(s.terminated);
    try testing.expectEqual(before + 1, core.metrics.websocket_send_failures.get(.{"send_error"}));
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).connections.agent);
}

test "inline writes stay charged until the end of the turn: aggregate Explorer budget (66)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.max_total_buffered_bytes = 1024;
    try h.init(limits);
    defer h.deinit();
    var sockets: [4]*FakeSocket = undefined;
    for (&sockets, 0..) |*slot, index| {
        var ip: [16]u8 = undefined;
        slot.*, _ = h.explorer("/messages", try std.fmt.bufPrint(&ip, "10.0.0.{d}", .{index + 1}));
        try h.waitFrames(slot.*, 1);
    }
    h.settle();
    for (sockets) |s| s.inline_mode = .written;
    const before = core.metrics.websocket_send_failures.get(.{"buffer_limit"});
    const id = "0a" ** 32;
    // One ~600-byte upsert: two of them exceed the 1024-byte aggregate budget.
    h.db.on("FROM \"message_view\"", "[{\"msg_id\":\"\\\\x" ++ id ++ "\",\"message_body\":\"" ++ "ff" ** 270 ++ "\"}]");
    notifyExplorer(&h, id);
    h.t.fake.tick(100);
    for (0..10_000) |_| {
        if (sockets[3].terminated) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.settle();
    try testing.expectEqual(@as(usize, 2), sockets[0].count());
    for (sockets[1..]) |s| {
        try testing.expect(s.terminated);
        try testing.expectEqual(@as(usize, 1), s.count());
    }
    try testing.expectEqual(before + 3, core.metrics.websocket_send_failures.get(.{"buffer_limit"}));
    const after = metricsOf(&h);
    try testing.expectEqual(@as(f64, 0), after.outboundPendingBytes);
    try testing.expectEqual(@as(f64, 1), after.connections.messages);
}

test "a partially written inline frame stays charged until its remainder is written" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.max_total_buffered_bytes = 1024;
    try h.init(limits);
    defer h.deinit();
    const slow_id = "0b" ** 32;
    const fast_id = "0c" ** 32;
    const slow, _ = h.explorer("/messages?messageIds=" ++ slow_id, "10.0.0.1");
    const fast, _ = h.explorer("/messages?messageIds=" ++ fast_id, "10.0.0.2");
    try h.waitFrames(slow, 1);
    try h.waitFrames(fast, 1);
    h.settle();
    // The kernel takes only part of the slow client's frame; the rest stays
    // queued and its completion is held.
    slow.inline_mode = .partial;
    slow.hold = true;
    fast.inline_mode = .written;
    const before = core.metrics.websocket_send_failures.get(.{"buffer_limit"});
    // ~600-byte upserts: one still-pending frame plus another exceeds 1024 bytes.
    const body = "\",\"message_body\":\"" ++ "ff" ** 270 ++ "\"}";
    h.db.on("FROM \"message_view\"", "[{\"msg_id\":\"\\\\x" ++ slow_id ++ body ++ ",{\"msg_id\":\"\\\\x" ++ fast_id ++ body ++ "]");
    notifyExplorer(&h, slow_id);
    h.t.fake.tick(100);
    try h.waitFrames(slow, 2);
    h.settle();
    // TS: the write went async, so its callback (and the pendingBytes release)
    // waits for the remainder; a later turn still sees the frame charged.
    const frame_len: f64 = @floatFromInt(slow.frames.items[1].len);
    try testing.expectEqual(frame_len, metricsOf(&h).outboundPendingBytes);
    notifyExplorer(&h, fast_id);
    h.t.fake.tick(100);
    for (0..10_000) |_| {
        if (fast.terminated) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.settle();
    try testing.expect(fast.terminated);
    try testing.expect(!slow.terminated);
    try testing.expectEqual(before + 1, core.metrics.websocket_send_failures.get(.{"buffer_limit"}));
    // Once the remainder is written the charge is released.
    slow.releaseHeld(true);
    h.settle();
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
}

const three_dispatch_rows =
    \\[{"notification_id":"7","destination_domain":2,"id":"7","msg_body":"\\x00","msg_id":"\\xa7","nonce":4,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"},
    \\{"notification_id":"8","destination_domain":2,"id":"8","msg_body":"\\x00","msg_id":"\\xa8","nonce":5,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"},
    \\{"notification_id":"9","destination_domain":2,"id":"9","msg_body":"\\x00","msg_id":"\\xa9","nonce":6,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"}]
;

fn subscribeLiveDispatch(h: *Harness) struct { *FakeSocket, *live.Peer } {
    const s, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    h.waitFrames(s, 2) catch unreachable;
    h.settle();
    return .{ s, peer };
}

fn notifyThreeDispatches(h: *Harness) void {
    h.db.on("\"confirmed_raw_message_dispatch\" AS \"event_row\" WHERE \"event_row\".\"id\" = ANY", three_dispatch_rows);
    for ([_][]const u8{ "7", "8", "9" }) |id| {
        var payload: [96]u8 = undefined;
        h.listen.notify(live.EVENT_CHANNEL, std.fmt.bufPrint(&payload, "{{\"eventType\":\"dispatch\",\"id\":\"{s}\",\"domain\":1}}", .{id}) catch unreachable);
    }
    h.t.fake.tick(100);
}

test "frames published to a peer in one turn are written with one syscall, in order" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const first, _ = subscribeLiveDispatch(&h);
    const second, _ = subscribeLiveDispatch(&h);
    for ([_]*FakeSocket{ first, second }) |s| {
        s.inline_mode = .written;
        s.flushes = 0;
    }
    notifyThreeDispatches(&h);
    try h.waitFrames(first, 5);
    try h.waitFrames(second, 5);
    h.settle();
    for ([_]*FakeSocket{ first, second }) |s| {
        try testing.expectEqual(@as(usize, 1), s.flushes);
        for (s.frames.items[2..5], [_][]const u8{ "\"sequence\":\"4\"", "\"sequence\":\"5\"", "\"sequence\":\"6\"" }) |frame, needle|
            try testing.expect(std.mem.indexOf(u8, frame, needle) != null);
    }
    // Fully written frames are released at the end of the turn.
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
}

test "corked frames are decided against the real bufferedAmount once their bound exceeds the limit" {
    var h: Harness = .{};
    var limits = defaultLimits();
    // ~390-byte frames: two corked fit the bound, a third would not if they
    // were all still buffered.
    limits.max_buffered_bytes = 1_000;
    try h.init(limits);
    defer h.deinit();
    const s, _ = subscribeLiveDispatch(&h);
    s.inline_mode = .written;
    s.flushes = 0;
    notifyThreeDispatches(&h);
    try h.waitFrames(s, 5);
    h.settle();
    // ws: each frame reached the kernel, bufferedAmount stayed 0, nothing
    // tripped: the third frame flushed the first two and was checked exactly.
    try testing.expect(!s.terminated);
    try testing.expectEqual(@as(usize, 1), s.flushes);
    try testing.expectEqual(@as(usize, 5), s.count());
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
}

test "a corked frame the socket cannot take whole stays charged until written" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, _ = subscribeLiveDispatch(&h);
    s.inline_mode = .partial;
    s.hold = true;
    notifyThreeDispatches(&h);
    try h.waitFrames(s, 5);
    h.settle();
    var expected: f64 = 0;
    for (s.frames.items[2..5]) |frame| expected += @floatFromInt(frame.len);
    try testing.expectEqual(expected, metricsOf(&h).outboundPendingBytes);
    s.releaseHeld(true);
    h.settle();
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
    try testing.expect(!s.terminated);
}
