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
    /// Complete each queued send before `send` returns (ws's poller wrote
    /// it at once, on another thread, before the caller looked).
    complete_in_send: bool = false,
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
        /// Already reported (`complete_in_send`): only the pass ends here.
        recorded: bool = false,

        /// ws reports the frame (one flush pass each), then ends the pass.
        fn run(job: *runtime.Pool.Job) void {
            const self: *Completion = @alignCast(@fieldParentPtr("job", job));
            const send_job = self.send_job;
            const ok = self.ok;
            const recorded = self.recorded;
            a.destroy(self);
            const peer = send_job.peer;
            const server = send_job.server;
            peer.retain();
            if (!recorded) send_job.complete(ok);
            server.passEnd(peer);
            peer.releaseUnlocked();
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
        const now = self.complete_in_send and !hold;
        self.mutex.unlock();
        if (now) {
            // Reported at once (the caller holds the loop mutex); the pass
            // ends on another thread.
            job.complete(completion.ok);
            completion.recorded = true;
        }
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
    fn trySendInlineMany(ptr: *anyopaque, payloads: []const []const u8, jobs: []const *live.SendJob, required: usize) live.Socket.ManyResult {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        switch (self.inline_mode) {
            // Nothing written whole: the required frames are queued.
            .partial, .busy => {
                for (payloads[0..required], jobs[0..required]) |bytes, job| _ = send(ptr, bytes, job);
                self.mutex.lock();
                if (self.inline_mode == .partial) self.flushes += 1;
                self.mutex.unlock();
                return .{ .done = .{ .written = 0, .queued = required } };
            },
            else => {},
        }
        self.mutex.lock();
        defer self.mutex.unlock();
        switch (self.inline_mode) {
            .written => {
                for (payloads) |bytes| self.frames.append(a, a.dupe(u8, bytes) catch unreachable) catch unreachable;
                self.flushes += 1;
                return .{ .done = .{ .written = payloads.len, .queued = 0 } };
            },
            .failed => {
                self.open = false;
                self.terminated = true;
                return .failed;
            },
            .closed => {
                self.open = false;
                return .closed;
            },
            .busy, .partial => unreachable,
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
            .closed => self.open = false,
            .busy, .partial => {},
        }
        return self.inline_mode;
    }

    fn bufferedAmount(ptr: *anyopaque) usize {
        const self: *FakeSocket = @ptrCast(@alignCast(ptr));
        return self.buffered;
    }
    fn snapshot(ptr: *anyopaque) live.Socket.Snapshot {
        // `buffered` is set by tests as bytes ws holds of its own (no job).
        return .{ .open = isOpen(ptr), .buffered = bufferedAmount(ptr), .control = bufferedAmount(ptr) };
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

    /// `query_async` reads started (each on a thread of its own, after `before_query`).
    async_started: usize = 0,

    fn db(self: *FakeDb) es.Db {
        return .{ .ctx = self, .query = query, .query_async = queryAsync };
    }

    fn queryAsync(ctx: *anyopaque, request: *es.AsyncQuery) void {
        const self: *FakeDb = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        self.async_started += 1;
        self.mutex.unlock();
        request.backend = self;
        const thread = std.Thread.spawn(.{}, runAsync, .{request}) catch unreachable;
        thread.detach();
    }

    fn runAsync(request: *es.AsyncQuery) void {
        const self: *FakeDb = @ptrCast(@alignCast(request.backend));
        if (query(self, request.arena.allocator(), request.sql, request.params)) |rows| {
            request.rows = rows;
        } else |err| request.setFailure(err);
        request.done(request);
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
            if (std.mem.indexOf(u8, sql, "unnest($1::integer[], $2::bigint[])") != null) return expandPairs(arena, rows.array, params);
            return rows.array;
        }
        return &.{};
    }

    /// `confirmationSnapshots`: `unnest(domains, confirmations) JOIN
    /// scraper_head`, i.e. each rule row (one per domain) once per requested
    /// pair of its domain, with `confirmations` set.
    fn expandPairs(arena: std.mem.Allocator, rows: []json.Value, params: []const json.Value) ![]json.Value {
        var out: std.ArrayList(json.Value) = .empty;
        for (params[0].array, params[1].array) |domain, count| {
            for (rows) |row| {
                const row_domain = row.get("domain") orelse continue;
                const stored: f64 = if (row_domain.number > 0x7fff_ffff) row_domain.number - 0x1_0000_0000 else row_domain.number;
                if (stored != domain.number) continue;
                var members: std.ArrayList(json.Member) = .empty;
                for (row.object) |member| {
                    if (!std.mem.eql(u8, member.key, "confirmations")) try members.append(arena, member);
                }
                try members.append(arena, .{ .key = "confirmations", .value = .{ .string = try std.fmt.allocPrint(arena, "{d}", .{count.number}) } });
                try out.append(arena, .{ .object = members.items });
            }
        }
        return out.items;
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
    listens: usize = 0,
    /// Connects without the "listening on" line (the early LISTEN).
    unlogged: usize = 0,
    /// "listening on" lines: one per logged `listen` plus `log_listening`.
    logged: usize = 0,
    /// When set, `unlisten` waits for it.
    unlisten_gate: ?*std.Thread.ResetEvent = null,

    fn api(self: *FakeListen) live.Listen {
        return .{ .ctx = self, .listen = listen, .listen_unlogged = listenUnlogged, .log_listening = logListening, .unlisten = unlisten };
    }
    fn listenUnlogged(ctx: *anyopaque, channels: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *FakeListen = @ptrCast(@alignCast(ctx));
        self.unlogged += 1;
        const handle = try listen(ctx, channels, handler);
        self.logged -= 1;
        return handle;
    }
    fn logListening(ctx: *anyopaque, _: []const []const u8) void {
        const self: *FakeListen = @ptrCast(@alignCast(ctx));
        self.logged += 1;
    }
    fn listen(ctx: *anyopaque, _: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *FakeListen = @ptrCast(@alignCast(ctx));
        self.listens += 1;
        if (self.fail) return error.ConnectionFailed;
        self.handler = handler;
        self.logged += 1;
        return self;
    }
    fn unlisten(ctx: *anyopaque, _: *anyopaque) void {
        const self: *FakeListen = @ptrCast(@alignCast(ctx));
        // A pending listener shutdown (`stopListening()` not yet resolved).
        if (self.unlisten_gate) |gate| gate.wait();
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
        return self.initBatch(limits, 500);
    }

    /// Kept for the tests written against the continuation path (now the only one).
    fn initAsync(self: *Harness, limits: live.Limits) !void {
        try self.initBatch(limits, 500);
    }

    fn initBatch(self: *Harness, limits: live.Limits, batch_size: u64) !void {
        // stdout is the test runner's IPC channel; keep pino-style lines off it.
        core.log.setSink(discard, null);
        self.t.init();
        self.server = try live.Server.create(a, &self.t.loop, self.db.db(), self.listen.api(), .{ .limits = limits, .batch_size = batch_size }, null);
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

    const ValidatorOutcome = union(enum) { rejected: u16, connected: struct { *FakeSocket, *live.Peer } };

    /// `/validators` upgrade: admission, then `connectValidator` in one step.
    fn validator(self: *Harness, url: []const u8, ip: ?[]const u8) ValidatorOutcome {
        self.t.loop.lock();
        defer self.t.loop.unlock();
        const admission = self.server.admitValidator(.{ .url = url, .cf_connecting_ip = ip, .remote_address = "::ffff:127.0.0.1" });
        const admitted = switch (admission) {
            .rejected => |status| return .{ .rejected = status },
            .admitted => |value| value,
        };
        const s = self.newSocket();
        const peer = self.server.connectValidator(s.socket(), admitted.ip, admitted.subscription);
        self.peers.append(a, peer) catch unreachable;
        return .{ .connected = .{ s, peer } };
    }

    fn connectedValidator(self: *Harness, url: []const u8, ip: ?[]const u8) !struct { *FakeSocket, *live.Peer } {
        return switch (self.validator(url, ip)) {
            .connected => |pair| pair,
            .rejected => |status| {
                std.debug.print("{s} rejected with {d}\n", .{ url, status });
                return error.TestUnexpectedResult;
            },
        };
    }

    /// ws 'close' for one peer (removed from the deinit list).
    fn close(self: *Harness, peer: *live.Peer) void {
        for (self.peers.items, 0..) |item, index| if (item == peer) {
            _ = self.peers.orderedRemove(index);
            break;
        };
        self.server.onClose(peer);
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
        \\{"confirmations":{"unit":"blocks","liveOnly":true,"byDomain":true},"eventTypes":["dispatch","delivery","gas_payment","merkle_tree_insertion","blocks"],"historicalStreaming":false,"liveStartVersion":1,"type":"ready"}
    , s.frame(0));
    h.server.onMessage(peer, "{\"type\":\"ping\"}");
    h.server.onMessage(peer, "nope");
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1,2,1]},{\"eventType\":\"gas_payment\",\"domains\":[5]}]}");
    // subscribed, then one live start per requested domain (no checkpoints).
    try h.waitFrames(s, 7);
    try testing.expectEqualStrings("{\"type\":\"pong\"}", s.frame(1));
    try testing.expectEqualStrings("{\"error\":\"Invalid JSON message\",\"type\":\"error\"}", s.frame(2));
    try testing.expectEqualStrings(
        \\{"streams":[{"domains":[1,2],"eventType":"dispatch"},{"domains":[5],"eventType":"gas_payment"}],"type":"subscribed"}
    , s.frame(3));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":1,"eventTypes":["dispatch"],"reason":"No healthy live-start scraper checkpoint"}
    , s.frame(4));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":2,"eventTypes":["dispatch"],"reason":"No healthy live-start scraper checkpoint"}
    , s.frame(5));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":5,"eventTypes":["gas_payment"],"reason":"No healthy live-start scraper checkpoint"}
    , s.frame(6));
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\"}]}");
    try h.waitFrames(s, 8);
    try testing.expectEqualStrings("{\"error\":\"Already subscribed\",\"type\":\"error\"}", s.frame(7));
}

test "rejects agent backfills without reads and starts live on every connection" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"gas_payment","domains":[1],"streamCursorVersion":3,"cursors":[{"address":"0x0000000000000000000000000000000000000001","domain":1,"afterStreamCursor":"0"}]}]}
    );
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings(
        \\{"error":"Agent streams are live-only; replay cursors are unsupported. Recover history through RPC.","type":"error"}
    , s.frame(1));
    try testing.expectEqual(@as(usize, 0), queryCount(&h));
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"gas_payment\",\"domains\":[1]}]}");
    try h.waitFrames(s, 4);
    try testing.expectEqualStrings("{\"streams\":[{\"domains\":[1],\"eventType\":\"gas_payment\"}],\"type\":\"subscribed\"}", s.frame(2));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":1,"eventTypes":["gas_payment"],"reason":"No healthy live-start scraper checkpoint"}
    , s.frame(3));
    // One primary boundary read, no history.
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    try testing.expectEqual(@as(usize, 1), h.db.queries.items.len);
    try testing.expect(std.mem.indexOf(u8, h.db.queries.items[0], "JOIN scraper_checkpoint") != null);
}

test "live starts: custom streams in request order, then canonical boundaries in row order" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    const checkpoint = "\"hash\":\"" ++ "AB" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"";
    // Custom heads: domain 1 has a checkpoint at or below its frontier, 2 none.
    h.db.on("SELECT h.domain, h.head_height", "[{\"domain\":1,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":\"17\"," ++ checkpoint ++ "}," ++
        "{\"domain\":2,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":null,\"hash\":null,\"mailbox\":null,\"merkle_tree_hook\":null,\"interchain_gas_paymaster\":null}]");
    // Canonical boundaries in database row order (no ORDER BY).
    h.db.on("JOIN scraper_checkpoint c", "[{\"domain\":3,\"height\":\"15\"," ++ checkpoint ++ "},{\"domain\":-2,\"height\":\"9007199254740993\"," ++ checkpoint ++ "}]");
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":3,"domains":[1,2]},{"eventType":"gas_payment","domains":[4294967294,3]}]}
    );
    try h.waitFrames(s, 6);
    try testing.expectEqualStrings(
        \\{"streams":[{"confirmations":3,"domains":[1,2],"eventType":"dispatch"},{"domains":[4294967294,3],"eventType":"gas_payment"}],"type":"subscribed"}
    , s.frame(1));
    try testing.expectEqualStrings("{\"type\":\"live_start\",\"domain\":1,\"confirmations\":3,\"height\":\"17\",\"hash\":\"0x" ++ "ab" ** 32 ++ "\",\"streams\":[{\"eventType\":\"dispatch\",\"address\":\"0x" ++ "11" ** 20 ++ "\"}]}", s.frame(2));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":2,"confirmations":3,"eventTypes":["dispatch"],"reason":"No healthy live-start scraper checkpoint"}
    , s.frame(3));
    try testing.expectEqualStrings("{\"type\":\"live_start\",\"domain\":3,\"height\":\"15\",\"hash\":\"0x" ++ "ab" ** 32 ++ "\",\"streams\":[{\"eventType\":\"gas_payment\",\"address\":\"0x" ++ "33" ** 32 ++ "\"}]}", s.frame(4));
    try testing.expectEqualStrings("{\"type\":\"live_start\",\"domain\":4294967294,\"height\":\"9007199254740993\",\"hash\":\"0x" ++ "ab" ** 32 ++ "\",\"streams\":[{\"eventType\":\"gas_payment\",\"address\":\"0x" ++ "33" ** 32 ++ "\"}]}", s.frame(5));
    h.settle();
    try testing.expectEqual(@as(usize, 6), s.count());
    // The canonical read names exactly the canonical streams' domains.
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    var boundary_reads: usize = 0;
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "JOIN scraper_checkpoint c") == null) continue;
        boundary_reads += 1;
        try testing.expect(std.mem.indexOf(u8, query, "AND h.domain=ANY($1::integer[])") != null);
    }
    try testing.expectEqual(@as(usize, 1), boundary_reads);
}

test "every custom stream of a subscribe shares one batched heads snapshot (#10047)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .persistent = true, .rows = "[{\"domain\":1,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":null}]" });
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":2,"domains":[1,2]},{"eventType":"delivery","confirmations":2,"domains":[2,1]},{"eventType":"merkle_tree_insertion","confirmations":5,"domains":[1]}]}
    );
    // Domain 2 has no head: the first stream fails negotiation.
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"error\":\"Custom confirmations unavailable for domain 2\",\"type\":\"error\"}", s.frame(1));
    try waitClosed(s);
    h.settle();
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    var reads: usize = 0;
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "SELECT h.domain, h.head_height") != null) reads += 1;
    }
    // One read of every (confirmations, domain) pair: (2, 1), (2, 2), (5, 1).
    try testing.expectEqual(@as(usize, 1), reads);
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "SELECT h.domain, h.head_height") != null)
            try testing.expect(std.mem.indexOf(u8, query, "unnest($1::integer[], $2::bigint[])") != null);
    }
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
    try h.waitFrames(s, 3);
    h.db.on("\"confirmed_raw_message_dispatch\" AS \"event_row\" WHERE \"event_row\".\"id\" = ANY",
        \\[{"notification_id":"7","destination_domain":-1,"id":"7","msg_body":"\\x00","msg_id":"\\xab","nonce":4,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"}]
    );
    // Not subscribed domain: ignored without a read.
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"dispatch\",\"id\":\"8\",\"domain\":2}");
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"dispatch\",\"id\":\"7\",\"domain\":1}");
    h.t.fake.tick(100);
    try h.waitFrames(s, 4);
    try testing.expectEqualStrings(
        \\{"type":"event","eventType":"dispatch","domain":1,"data":{"destination_domain":4294967295,"id":"7","msg_body":"\\x00","msg_id":"\\xab","nonce":4,"origin_block_hash":"\\x01","origin_block_height":"10","origin_domain":1,"origin_mailbox":"\\x0000000000000000000000000000000000000001","origin_tx_hash":"\\x02","recipient":"\\x03","sender":"\\x04","time_created":"2024-01-01T00:00:00"},"sequence":"4"}
    , s.frame(3));
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
    try h.waitFrames(agent, 3);
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
    try h.waitFrames(agent, 4);
    try testing.expectEqualStrings(
        \\{"type":"event","eventType":"delivery","domain":1,"data":{"time_created":"t","msg_id":"\\x
    ++ id ++
        \\","domain":1,"destination_mailbox":"\\x01","destination_tx_id":"5","sequence":"3"}}
    , agent.frame(3));
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

test "paces live starts by send completion" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"domains\":[1,2]}]}");
    try h.waitFrames(s, 3);
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count()); // ready, subscribed, live start 1
    try testing.expect(std.mem.indexOf(u8, s.frame(2), "\"domain\":1") != null);
    try testing.expectEqual(@as(usize, 2), s.heldCount()); // subscribed + live start 1
    try testing.expect(s.releaseOne()); // subscribed
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count()); // still awaiting live start 1
    try testing.expect(s.releaseOne()); // live start 1
    try h.waitFrames(s, 4);
    h.settle();
    try testing.expectEqual(@as(usize, 4), s.count());
    try testing.expect(std.mem.indexOf(u8, s.frame(3), "\"domain\":2") != null);
    s.releaseHeld(null);
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
    try h.waitFrames(both, 4); // ready, subscribed, two live starts
    try h.waitFrames(two, 3);
    const frontier = "\"confirmed_delivered_message\" AS \"frontier_row\"";
    h.db.add(.{ .contains = frontier, .domain = 1, .persistent = true, .fail = true });
    h.db.add(.{ .contains = frontier, .domain = 2, .persistent = true, .rows = 
        \\[{"time_created":"t","msg_id":"\\xcd","domain":2,"destination_mailbox":"\\x01","destination_tx_id":"5","sequence":"3","frontier_id":"11","frontier_height":"9"}]
    });
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"10\",\"previousConfirmedHeight\":\"8\"}");
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":2,\"confirmedHeight\":\"10\",\"previousConfirmedHeight\":\"8\"}");
    h.t.fake.tick(100);
    // Domain 2 is published despite domain 1 failing first.
    try h.waitFrames(both, 5);
    try h.waitFrames(two, 4);
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
    try testing.expectEqual(@as(usize, 4), two.count());
    const metrics = metricsOf(&h);
    try testing.expectEqual(@as(f64, 1), metrics.connections.agent);
}

fn advisoryTest(comptime available: bool) !void {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.db.on("SELECT h.domain, h.head_height", if (available)
        "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"5\"}]"
    else
        "[]");
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","includeZeroConfirmations":true,"domains":[1,2]}]}
    );
    // ready, subscribed, zero-confirmation then canonical live starts for
    // both domains (no checkpoints): no rejection.
    try h.waitFrames(s, 6);
    try testing.expect(std.mem.indexOf(u8, s.frame(2), "\"domain\":1,\"confirmations\":0") != null);
    try testing.expect(std.mem.indexOf(u8, s.frame(3), "\"domain\":2,\"confirmations\":0") != null);
    try testing.expect(std.mem.indexOf(u8, s.frame(4), "\"domain\":1,\"eventTypes\"") != null);
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

test "preserves canonical live events with no advisory near-head coverage (#10026)" {
    try advisoryTest(false);
}

test "preserves canonical live events with partial advisory near-head coverage (#10026)" {
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
    try h.waitFrames(s, 3);
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
    try h.waitFrames(s, 3);
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

test "inline writes: live starts complete without send callbacks" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true; // any queued send would stall the awaited live starts
    s.inline_mode = .written;
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"domains\":[1,2,3]}]}");
    try h.waitFrames(s, 5);
    try testing.expect(std.mem.indexOf(u8, s.frame(4), "\"domain\":3") != null);
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
    h.waitFrames(s, 3) catch unreachable; // ready, subscribed, live start
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
    try h.waitFrames(first, 6);
    try h.waitFrames(second, 6);
    h.settle();
    for ([_]*FakeSocket{ first, second }) |s| {
        try testing.expectEqual(@as(usize, 1), s.flushes);
        for (s.frames.items[3..6], [_][]const u8{ "\"sequence\":\"4\"", "\"sequence\":\"5\"", "\"sequence\":\"6\"" }) |frame, needle|
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
    try h.waitFrames(s, 6);
    h.settle();
    // ws: each frame reached the kernel, bufferedAmount stayed 0, nothing
    // tripped: the third frame flushed the first two and was checked exactly.
    try testing.expect(!s.terminated);
    try testing.expectEqual(@as(usize, 1), s.flushes);
    try testing.expectEqual(@as(usize, 6), s.count());
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
    try h.waitFrames(s, 6);
    h.settle();
    var expected: f64 = 0;
    for (s.frames.items[3..6]) |frame| expected += @floatFromInt(frame.len);
    try testing.expectEqual(expected, metricsOf(&h).outboundPendingBytes);
    s.releaseHeld(true);
    h.settle();
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
    try testing.expect(!s.terminated);
}

/// `listenEarly`, then wait for the early connection (no `start` yet).
fn initEarly(h: *Harness) !void {
    core.log.setSink(Harness.discard, null);
    h.t.init();
    h.server = try live.Server.create(a, &h.t.loop, h.db.db(), h.listen.api(), .{ .limits = defaultLimits(), .batch_size = 500 }, null);
    h.server.listenEarly();
    for (0..10_000) |_| {
        if (h.listen.handler != null) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expect(h.listen.handler != null);
}

fn queryCount(h: *Harness) usize {
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    return h.db.queries.items.len;
}

test "notifications on the early listener before start change nothing" {
    var h: Harness = .{};
    try initEarly(&h);
    const early = h.listen.handler.?;
    // TS is not listening yet: none of these may queue work or read rows.
    h.listen.notify(live.EXPLORER_CHANNEL, "{\"messageId\":\"0x01\"}");
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"dispatch\",\"id\":\"7\",\"domain\":1}");
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"1\"}");
    h.t.fake.tick(1_000); // any batch timer would fire
    h.settle();
    try testing.expectEqual(@as(usize, 0), queryCount(&h));
    try h.server.start();
    defer h.deinit();
    // Adopted: the same connection, now delivering.
    try testing.expectEqual(@as(usize, 1), h.listen.listens);
    try testing.expectEqual(early.ctx, h.listen.handler.?.ctx);
    const s, _ = h.explorer("/messages", "1.2.3.4");
    try h.waitFrames(s, 1);
    h.listen.notify(live.EXPLORER_CHANNEL, "{\"messageId\":\"" ++ "01" ** 32 ++ "\"}");
    h.t.fake.tick(100);
    for (0..10_000) |_| {
        if (queryCount(&h) > 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expectEqual(@as(usize, 1), queryCount(&h));
}

test "an early listener lost before start is replaced by a fresh connect, silently" {
    var h: Harness = .{};
    try initEarly(&h);
    h.listen.handler.?.on_disconnect(h.listen.handler.?.ctx, "terminated");
    h.t.fake.tick(10_000); // no reconnect timer was armed
    try testing.expectEqual(@as(usize, 1), h.listen.listens);
    try h.server.start();
    defer h.deinit();
    try testing.expectEqual(@as(usize, 2), h.listen.listens);
    try testing.expectEqual(@as(usize, 1), h.listen.stopped); // the lost one
}

test "a failed early listener is retried at start, as TS connects there" {
    var h: Harness = .{};
    h.listen.fail = true;
    core.log.setSink(Harness.discard, null);
    h.t.init();
    h.server = try live.Server.create(a, &h.t.loop, h.db.db(), h.listen.api(), .{ .limits = defaultLimits(), .batch_size = 500 }, null);
    h.server.listenEarly();
    for (0..10_000) |_| {
        if (h.listen.listens > 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.listen.fail = false;
    try h.server.start();
    defer h.deinit();
    try testing.expectEqual(@as(usize, 2), h.listen.listens);
    try testing.expect(h.listen.handler != null);
}

test "an awaited frame completed before its sender looked still resumes like an await" {
    // The completion ran (another thread) before `sendAndWait` checked: the
    // frames after it on the socket must not stay held.
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    s.complete_in_send = true;
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","domains":[1,2,3]},{"eventType":"dispatch","domains":[1]}]}
    );
    try h.waitFrames(s, 5); // ready, subscribed, 3 awaited live starts
    notifyThreeDispatches(&h);
    try h.waitFrames(s, 8);
    h.settle();
    try testing.expectEqual(@as(f64, 0), metricsOf(&h).outboundPendingBytes);
}

/// Holds every query whose SQL contains `contains` until `open`.
const QueryGate = struct {
    contains: []const u8,
    started: std.Thread.ResetEvent = .{},
    released: std.Thread.ResetEvent = .{},

    fn before(ctx: *anyopaque, sql: []const u8) void {
        const self: *QueryGate = @ptrCast(@alignCast(ctx));
        if (std.mem.indexOf(u8, sql, self.contains) == null) return;
        self.started.set();
        self.released.wait();
    }
};

fn countFrames(s: *FakeSocket, needle: []const u8) usize {
    s.mutex.lock();
    defer s.mutex.unlock();
    var total: usize = 0;
    for (s.frames.items) |item| {
        if (std.mem.indexOf(u8, item, needle) != null) total += 1;
    }
    return total;
}

test "closes a failed boundary snapshot without claiming a live start" {
    var h: Harness = .{};
    try h.init(defaultLimits());
    defer h.deinit();
    h.db.add(.{ .contains = "JOIN scraper_checkpoint", .fail = true });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    try waitClosed(s);
    try testing.expect(s.terminated);
    try testing.expectEqual(@as(usize, 1), countFrames(s, "\"type\":\"subscribed\""));
    try testing.expectEqual(@as(usize, 0), countFrames(s, "live_start"));
}

test "registers live delivery before reading the boundary" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = "JOIN scraper_checkpoint" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    h.db.add(.{ .contains = "JOIN scraper_checkpoint", .rows = "[{\"domain\":1,\"height\":\"100\",\"hash\":\"" ++ "ab" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]" });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"domains\":[1]}]}");
    gate.started.wait();
    try h.waitFrames(s, 2);
    h.db.on("\"confirmed_merkle_tree_insertion\" AS \"event_row\" WHERE",
        \\[{"notification_id":"21","domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":0,"message_id":"\\xaa","block_number":101}]
    );
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"merkle_tree_insertion\",\"id\":\"21\",\"domain\":1}");
    h.t.fake.tick(100);
    try h.waitFrames(s, 3);
    try testing.expect(std.mem.indexOf(u8, s.frame(2), "\"type\":\"event\"") != null);
    gate.released.set();
    try h.waitFrames(s, 4);
    try testing.expect(std.mem.startsWith(u8, s.frame(3), "{\"type\":\"live_start\",\"domain\":1,\"height\":\"100\""));
}

fn cancelsSetupDuringBlockSnapshot(comptime route: live.Route) !void {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = "encode(indexed_hash, 'hex')" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    const s, const peer = if (route == .agent) h.agent() else h.explorer("/messages?blocks=true&confirmations=0&domains=1", "1.2.3.4");
    if (route == .agent) {
        try h.waitFrames(s, 1);
        h.server.onMessage(peer,
            \\{"type":"subscribe","streams":[{"eventType":"blocks","domains":[1]},{"eventType":"dispatch","domains":[1],"confirmations":0}]}
        );
    }
    gate.started.wait();
    h.server.onClose(peer);
    _ = h.peers.pop();
    gate.released.set();
    h.settle();
    const snapshot = metricsOf(&h);
    try testing.expectEqual(@as(f64, 0), snapshot.connections.agent + snapshot.connections.messages);
    // No stream was initialized: no heads read, nothing acknowledged.
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    for (h.db.queries.items) |query| try testing.expect(std.mem.indexOf(u8, query, "confirmed_height") == null);
    // Agents saw only `ready`; Explorer never got its `ready`.
    try testing.expectEqual(@as(usize, if (route == .agent) 1 else 0), s.count());
}

test "agents cancels confirmation setup when disconnected during the block snapshot" {
    try cancelsSetupDuringBlockSnapshot(.agent);
}

test "messages cancels confirmation setup when disconnected during the block snapshot" {
    try cancelsSetupDuringBlockSnapshot(.explorer);
}

/// `confirmationHeads(…, 2)` rows for domain 1: before (P) and after (P2) an
/// indexed-height rollback from 100 to 99 (TS 493's fixture).
const heads_before = "[{\"domain\":1,\"head_height\":\"102\",\"indexed_height\":\"100\",\"confirmed_height\":\"90\",\"height\":\"100\",\"hash\":\"" ++ "ab" ** 32 ++
    "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]";
const heads_after = "[{\"domain\":1,\"head_height\":\"101\",\"indexed_height\":\"99\",\"confirmed_height\":\"90\",\"height\":\"99\",\"hash\":\"" ++ "cd" ** 32 ++
    "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]";
const rollback_head = "{\"domain\":1,\"confirmedHeight\":\"90\",\"previousConfirmedHeight\":\"90\",\"indexedHeight\":\"99\",\"previousIndexedHeight\":\"100\",\"headHeight\":\"101\"}";
const two_custom_streams =
    \\{"type":"subscribe","streams":[{"eventType":"dispatch","domains":[1],"confirmations":2},{"eventType":"delivery","domains":[1],"confirmations":2}]}
;

fn headsReads(h: *Harness) usize {
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    var reads: usize = 0;
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "SELECT h.domain, h.head_height") != null) reads += 1;
    }
    return reads;
}

fn revisionOf(h: *Harness) u64 {
    h.t.loop.lock();
    defer h.t.loop.unlock();
    return h.server.confirmation_revision;
}

fn liveStartOf(s: *FakeSocket, comptime event_type: []const u8) ?[]const u8 {
    s.mutex.lock();
    defer s.mutex.unlock();
    for (s.frames.items) |item| {
        if (std.mem.startsWith(u8, item, "{\"type\":\"live_start") and std.mem.indexOf(u8, item, "\"" ++ event_type ++ "\"") != null) return item;
    }
    return null;
}

test "custom streams sharing a snapshot both retry on a fresh one when a rollback lands during the read" {
    // TS 493 (rollback): both streams await the same read; the rollback bumps
    // both revisions, so both read again and share the fresh snapshot.
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = "SELECT h.domain, h.head_height" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    h.db.on("SELECT h.domain, h.head_height", heads_before);
    h.db.on("SELECT h.domain, h.head_height", heads_after);
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, two_custom_streams);
    gate.started.wait();
    h.listen.notify(live.HEAD_CHANNEL, rollback_head);
    for (0..10_000) |_| {
        if (revisionOf(&h) == 1) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expectEqual(@as(u64, 1), revisionOf(&h));
    // The retry's read must not wait for the gate again.
    h.db.before_query = null;
    gate.released.set();
    try h.waitFrames(s, 4);
    h.settle();
    try testing.expectEqual(@as(usize, 2), headsReads(&h));
    for ([_]?[]const u8{ liveStartOf(s, "dispatch"), liveStartOf(s, "delivery") }) |frame| {
        try testing.expect(std.mem.indexOf(u8, frame.?, "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":2,\"height\":\"99\",\"hash\":\"0x" ++ "cd" ** 32) != null);
    }
    try testing.expect(FakeSocket.isOpen(s));
}

test "custom streams sharing a snapshot both keep it when a rollback lands after it resolved" {
    // Both streams continue from the same read before anything else runs
    // (the promise's reactions), and `subscribed` plus the first live start
    // follow in the same burst. A rollback can land only once that send is
    // awaited: it clears both live starts, so the second stream reports
    // unavailable, and neither reads again.
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    h.db.on("SELECT h.domain, h.head_height", heads_before);
    h.db.on("SELECT h.domain, h.head_height", heads_after);
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    h.server.onMessage(peer, two_custom_streams);
    try h.waitFrames(s, 3); // subscribed, then the first live start (awaited)
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count());
    h.listen.notify(live.HEAD_CHANNEL, rollback_head);
    for (0..10_000) |_| {
        if (revisionOf(&h) == 1) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    s.releaseHeld(null);
    for (0..10_000) |_| {
        if (liveStartOf(s, "delivery") != null) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.settle();
    s.releaseHeld(null);
    try testing.expectEqual(@as(usize, 1), headsReads(&h));
    try testing.expect(std.mem.startsWith(u8, liveStartOf(s, "dispatch").?, "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":2,\"height\":\"100\",\"hash\":\"0x" ++ "ab" ** 32));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":1,"confirmations":2,"eventTypes":["delivery"],"reason":"No healthy live-start scraper checkpoint"}
    , liveStartOf(s, "delivery").?);
    // Both streams expose the rollback (they reserved through height 100).
    try testing.expectEqual(@as(usize, 2), countFrames(s, "\"type\":\"rollback\""));
    try testing.expect(FakeSocket.isOpen(s));
}

test "an early listener logs \"listening on\" only when start adopts it, like TS's db.listen" {
    var h: Harness = .{};
    try initEarly(&h);
    // Connected ahead of start (db.start may still fail): nothing logged yet.
    try testing.expectEqual(@as(usize, 1), h.listen.unlogged);
    try testing.expectEqual(@as(usize, 0), h.listen.logged);
    try h.server.start();
    defer h.deinit();
    try testing.expectEqual(@as(usize, 1), h.listen.listens);
    try testing.expectEqual(@as(usize, 1), h.listen.logged);
}

test "an early listener lost before start is replaced by a logged connect" {
    var h: Harness = .{};
    try initEarly(&h);
    h.listen.handler.?.on_disconnect(h.listen.handler.?.ctx, "terminated");
    try h.server.start();
    defer h.deinit();
    // The fresh connect logs; the lost early one never did.
    try testing.expectEqual(@as(usize, 2), h.listen.listens);
    try testing.expectEqual(@as(usize, 1), h.listen.logged);
}

// -- canonical-only subscribes inline, then the async boundary read

test "async canonical subscribe: subscribed at once, live starts after the boundary read" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    h.db.add(.{ .contains = "JOIN scraper_checkpoint", .rows = "[{\"domain\":2,\"height\":\"15\",\"hash\":\"" ++ "ab" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]" });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1,2]}]}");
    // Inline: acknowledged before onMessage returned, the read issued.
    try testing.expectEqualStrings("{\"streams\":[{\"domains\":[1,2],\"eventType\":\"dispatch\"}],\"type\":\"subscribed\"}", s.frame(1));
    try testing.expectEqual(@as(usize, 1), h.db.async_started);
    try h.waitFrames(s, 4);
    // Boundary rows first, then the remaining requested domains (TS's Set).
    try testing.expect(std.mem.startsWith(u8, s.frame(2), "{\"type\":\"live_start\",\"domain\":2,\"height\":\"15\""));
    try testing.expectEqualStrings(
        \\{"type":"live_start_unavailable","domain":1,"eventTypes":["dispatch"],"reason":"No healthy live-start scraper checkpoint"}
    , s.frame(3));
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"delivery\"}]}");
    try h.waitFrames(s, 5);
    try testing.expectEqualStrings("{\"error\":\"Already subscribed\",\"type\":\"error\"}", s.frame(4));
}

test "async canonical subscribe: live delivery is registered before the boundary read resolves" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = "JOIN scraper_checkpoint" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"domains\":[1]}]}");
    gate.started.wait();
    h.db.on("\"confirmed_merkle_tree_insertion\" AS \"event_row\" WHERE",
        \\[{"notification_id":"21","domain":1,"merkle_tree_hook":"\\x0000000000000000000000000000000000000001","leaf_index":0,"message_id":"\\xaa","block_number":101}]
    );
    h.listen.notify(live.EVENT_CHANNEL, "{\"eventType\":\"merkle_tree_insertion\",\"id\":\"21\",\"domain\":1}");
    h.t.fake.tick(100);
    try h.waitFrames(s, 3);
    try testing.expect(std.mem.indexOf(u8, s.frame(2), "\"type\":\"event\"") != null);
    gate.released.set();
    try h.waitFrames(s, 4);
    try testing.expect(std.mem.startsWith(u8, s.frame(3), "{\"type\":\"live_start_unavailable\",\"domain\":1"));
}

test "async canonical subscribe: a failed boundary read terminates without a live start" {
    var h: Harness = .{};
    try h.initAsync(defaultLimits());
    defer h.deinit();
    h.db.add(.{ .contains = "JOIN scraper_checkpoint", .fail = true });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    try waitClosed(s);
    try testing.expect(s.terminated);
    try testing.expectEqual(@as(usize, 1), countFrames(s, "\"type\":\"subscribed\""));
    try testing.expectEqual(@as(usize, 0), countFrames(s, "live_start"));
}

test "async canonical subscribe: a client gone before the read resolves gets nothing, and stop waits for the read" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    var gate: QueryGate = .{ .contains = "JOIN scraper_checkpoint" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    gate.started.wait();
    h.server.onClose(peer);
    _ = h.peers.pop();
    // stop() must wait for the read in flight (its `done` touches the pool).
    const Releaser = struct {
        fn run(g: *QueryGate) void {
            std.Thread.sleep(50 * std.time.ns_per_ms);
            g.released.set();
        }
    };
    const releaser = try std.Thread.spawn(.{}, Releaser.run, .{&gate});
    defer h.deinit();
    h.server.stop();
    releaser.join();
    h.t.loop.lock();
    const outstanding = h.server.async_outstanding;
    h.t.loop.unlock();
    try testing.expectEqual(@as(usize, 0), outstanding);
    h.settle();
    try testing.expectEqual(@as(usize, 2), s.count()); // ready, subscribed
}

test "async subscribe with blocks: block heads, then subscribed, blocks and live starts, as continuations" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    h.db.on("FROM scraper_head", "[{\"domain\":1,\"indexed_height\":\"10\",\"hash\":\"" ++ "AA" ** 32 ++ "\",\"head_height\":\"12\"}]");
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"blocks\",\"domains\":[1]},{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    try h.waitFrames(s, 4);
    try testing.expectEqualStrings("{\"streams\":[{\"domains\":[1],\"eventType\":\"blocks\"},{\"domains\":[1],\"eventType\":\"dispatch\"}],\"type\":\"subscribed\"}", s.frame(1));
    try testing.expectEqualStrings("{\"type\":\"block\",\"domain\":1,\"height\":\"10\",\"hash\":\"0x" ++ "aa" ** 32 ++ "\",\"headHeight\":\"12\"}", s.frame(2));
    try testing.expect(std.mem.startsWith(u8, s.frame(3), "{\"type\":\"live_start_unavailable\",\"domain\":1"));
    try testing.expectEqual(@as(usize, 2), h.db.async_started); // block heads, boundaries
}

test "async subscribe with custom streams: shared snapshot, custom live starts, then canonical" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    const checkpoint = "\"hash\":\"" ++ "AB" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"";
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .persistent = true, .rows = "[{\"domain\":1,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":\"17\"," ++ checkpoint ++ "}]" });
    h.db.on("JOIN scraper_checkpoint c", "[{\"domain\":3,\"height\":\"15\"," ++ checkpoint ++ "}]");
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":3,"domains":[1]},{"eventType":"delivery","confirmations":3,"domains":[1]},{"eventType":"gas_payment","domains":[3]}]}
    );
    try h.waitFrames(s, 5);
    try testing.expect(std.mem.indexOf(u8, s.frame(1), "\"type\":\"subscribed\"") != null);
    try testing.expect(std.mem.startsWith(u8, s.frame(2), "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":3,\"height\":\"17\""));
    try testing.expect(std.mem.indexOf(u8, s.frame(2), "\"eventType\":\"dispatch\"") != null);
    try testing.expect(std.mem.indexOf(u8, s.frame(3), "\"eventType\":\"delivery\"") != null);
    try testing.expect(std.mem.startsWith(u8, s.frame(4), "{\"type\":\"live_start\",\"domain\":3,\"height\":\"15\""));
    h.settle();
    // One heads read shared by both custom streams, one boundary read.
    try testing.expectEqual(@as(usize, 1), headsReads(&h));
    try testing.expectEqual(@as(usize, 1), boundaryReads(&h));
}

fn boundaryReads(h: *Harness) usize {
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    var reads: usize = 0;
    for (h.db.queries.items) |query| {
        if (std.mem.indexOf(u8, query, "JOIN scraper_checkpoint c") != null) reads += 1;
    }
    return reads;
}

test "async subscribe: custom confirmations unavailable rejects the subscription" {
    var h: Harness = .{};
    try h.initAsync(defaultLimits());
    defer h.deinit();
    const s, const peer = h.agent();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[7],\"confirmations\":2}]}");
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"error\":\"Custom confirmations unavailable for domain 7\",\"type\":\"error\"}", s.frame(1));
    try waitClosed(s);
    try testing.expectEqualStrings("Invalid subscription", s.reason());
}

test "async subscribe: custom streams retry on a fresh snapshot after a rollback during the read" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = "SELECT h.domain, h.head_height" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    h.db.on("SELECT h.domain, h.head_height", heads_before);
    h.db.on("SELECT h.domain, h.head_height", heads_after);
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, two_custom_streams);
    gate.started.wait();
    h.listen.notify(live.HEAD_CHANNEL, rollback_head);
    for (0..10_000) |_| {
        if (revisionOf(&h) == 1) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.db.before_query = null;
    gate.released.set();
    try h.waitFrames(s, 4);
    h.settle();
    try testing.expectEqual(@as(usize, 2), headsReads(&h));
    for ([_]?[]const u8{ liveStartOf(s, "dispatch"), liveStartOf(s, "delivery") }) |frame| {
        try testing.expect(std.mem.indexOf(u8, frame.?, "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":2,\"height\":\"99\"") != null);
    }
}

/// Holds only the first query whose SQL contains `contains`.
const FirstQueryGate = struct {
    contains: []const u8,
    seen: std.atomic.Value(usize) = .init(0),
    started: std.Thread.ResetEvent = .{},
    released: std.Thread.ResetEvent = .{},

    fn before(ctx: *anyopaque, sql: []const u8) void {
        const self: *FirstQueryGate = @ptrCast(@alignCast(ctx));
        if (std.mem.indexOf(u8, sql, self.contains) == null) return;
        if (self.seen.fetchAdd(1, .monotonic) != 0) return;
        self.started.set();
        self.released.wait();
    }
};

test "async live starts across queued sends: domain order holds through each resume" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    // `.busy`: every frame is queued; each resumes from its write callback.
    s.inline_mode = .busy;
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[3,1,2]}]}");
    try h.waitFrames(s, 5);
    for ([_][]const u8{ "\"domain\":3", "\"domain\":1", "\"domain\":2" }, 2..) |needle, index|
        try testing.expect(std.mem.indexOf(u8, s.frame(index), needle) != null);
}

test "async live starts: a failed awaited send ends the loop, no further live start" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1,2,3]}]}");
    try h.waitFrames(s, 3); // ready, subscribed, live start 1 (held)
    h.settle();
    s.releaseHeld(false); // the awaited live start fails
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count());
    try testing.expect(s.terminated);
}

test "async reads continue in completion order, not issue order" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    var gate: FirstQueryGate = .{ .contains = "JOIN scraper_checkpoint" };
    h.db.before_query = .{ .ctx = &gate, .func = FirstQueryGate.before };
    defer gate.released.set();
    const first, const first_peer = h.agent();
    const second, const second_peer = h.agent();
    try h.waitFrames(first, 1);
    try h.waitFrames(second, 1);
    h.server.onMessage(first_peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    gate.started.wait();
    h.server.onMessage(second_peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[2]}]}");
    try h.waitFrames(second, 3);
    try testing.expectEqual(@as(usize, 2), first.count()); // still awaiting its read
    gate.released.set();
    try h.waitFrames(first, 3);
    try testing.expect(std.mem.indexOf(u8, first.frame(2), "\"domain\":1") != null);
}

test "async reads: a burst of subscribes all get their live start once" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    limits.max_agent_clients = 40;
    try h.initAsync(limits);
    defer h.deinit();
    var agents: [40]struct { *FakeSocket, *live.Peer } = undefined;
    for (&agents) |*agent| agent.* = h.agent();
    for (agents) |agent| try h.waitFrames(agent[0], 1);
    for (agents) |agent| h.server.onMessage(agent[1], "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1]}]}");
    for (agents) |agent| try h.waitFrames(agent[0], 3);
    h.settle();
    for (agents) |agent| try testing.expectEqual(@as(usize, 1), countFrames(agent[0], "live_start"));
}

test "async live starts: stop with an awaited live start still queued frees everything" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit(); // fails the held frame, stops, drains (leaks are test failures)
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1,2]}]}");
    try h.waitFrames(s, 3);
}

test "async Explorer setup: block heads and the custom heads read as continuations, then ready" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    h.db.on("encode(indexed_hash, 'hex')", "[{\"domain\":1,\"indexed_height\":\"10\",\"hash\":\"" ++ "AA" ** 32 ++ "\",\"head_height\":\"12\"}]");
    h.db.on("SELECT domain, head_height, indexed_height, confirmed_height", "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"8\"}]");
    const s, _ = h.explorer("/messages?confirmations=1&domains=1,2&blocks=true", "1.2.3.4");
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings(
        \\{"confirmations":1,"domains":[1,2],"customDomains":[1],"canonicalDomains":[2],"eventTypes":["message_upsert","rollback","block"],"type":"ready"}
    , s.frame(0));
    try testing.expectEqualStrings("{\"type\":\"block\",\"domain\":1,\"height\":\"10\",\"hash\":\"0x" ++ "aa" ** 32 ++ "\",\"headHeight\":\"12\"}", s.frame(1));
    try testing.expectEqual(@as(usize, 2), h.db.async_started);
}

// -- async subscribes: failure paths (phase 2)

test "async subscribe: a failed block heads read fails the socket, nothing acknowledged" {
    var h: Harness = .{};
    try h.initAsync(defaultLimits());
    defer h.deinit();
    h.db.add(.{ .contains = "encode(indexed_hash, 'hex')", .fail = true });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"blocks\",\"domains\":[1]},{\"eventType\":\"dispatch\",\"domains\":[1],\"confirmations\":2}]}");
    try waitClosed(s);
    try testing.expect(s.terminated);
    try testing.expectEqual(@as(usize, 0), countFrames(s, "subscribed"));
}

test "async subscribe: a failed heads snapshot read fails the socket (not a negotiation error)" {
    var h: Harness = .{};
    try h.initAsync(defaultLimits());
    defer h.deinit();
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .fail = true });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1],\"confirmations\":2}]}");
    try waitClosed(s);
    try testing.expect(s.terminated);
    try testing.expectEqual(@as(usize, 1), s.count()); // ready only: no error frame, no subscribed
}

test "async subscribe: one stream failing on the shared snapshot settles the subscribe" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    var gate: FirstQueryGate = .{ .contains = "SELECT h.domain, h.head_height" };
    h.db.before_query = .{ .ctx = &gate, .func = FirstQueryGate.before };
    defer gate.released.set();
    // The batched read (dispatch (2, [1]), delivery (3, [7])) is held;
    // domain 7 has no head.
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .persistent = true, .domain = null, .rows = "[{\"domain\":1,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":null}]" });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer,
        \\{"type":"subscribe","streams":[{"eventType":"dispatch","confirmations":2,"domains":[1]},{"eventType":"delivery","confirmations":3,"domains":[7]}]}
    );
    gate.started.wait();
    try testing.expectEqual(@as(usize, 1), s.count()); // nothing settles before the read
    gate.released.set();
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"error\":\"Custom confirmations unavailable for domain 7\",\"type\":\"error\"}", s.frame(1));
    try waitClosed(s);
    h.settle();
    try testing.expectEqual(@as(usize, 2), s.count());
}

test "async subscribe: a client gone during the block heads read gets nothing more" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = "encode(indexed_hash, 'hex')" };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"blocks\",\"domains\":[1]},{\"eventType\":\"dispatch\",\"domains\":[1],\"confirmations\":0}]}");
    gate.started.wait();
    h.server.onClose(peer);
    _ = h.peers.pop();
    gate.released.set();
    h.settle();
    try testing.expectEqual(@as(usize, 1), s.count());
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    for (h.db.queries.items) |query| try testing.expect(std.mem.indexOf(u8, query, "confirmed_height") == null);
}

fn customTwoDomainsHeld(h: *Harness) !struct { *FakeSocket, *live.Peer } {
    const checkpoint = "\"hash\":\"" ++ "AB" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"";
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .persistent = true, .rows = "[{\"domain\":1,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":\"17\"," ++ checkpoint ++ "},{\"domain\":2,\"head_height\":\"20\",\"indexed_height\":\"20\",\"confirmed_height\":\"15\",\"height\":\"17\"," ++ checkpoint ++ "}]" });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.settle();
    s.hold = true;
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"confirmations\":2,\"domains\":[1,2]}]}");
    try h.waitFrames(s, 3); // ready, subscribed, live start for domain 1 (held)
    h.settle();
    return .{ s, peer };
}

test "async subscribe: a failed custom live start (resume with !ok) ends the flow" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    const s, _ = try customTwoDomainsHeld(&h);
    s.releaseHeld(false);
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count());
    try testing.expectEqual(@as(usize, 0), boundaryReads(&h)); // no canonical read after a failed send
}

test "async subscribe: a client gone during the custom live starts gets no more frames" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    const s, const peer = try customTwoDomainsHeld(&h);
    h.server.onClose(peer);
    _ = h.peers.pop();
    s.releaseHeld(true);
    h.settle();
    try testing.expectEqual(@as(usize, 3), s.count());
    try testing.expectEqual(@as(usize, 0), boundaryReads(&h));
}

test "async reads after stop fail at once and still release their flow" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.t.loop.lock();
    h.server.stopped = true; // as after stop(): a read issued now must not start
    h.t.loop.unlock();
    h.server.onMessage(peer, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"dispatch\",\"domains\":[1],\"confirmations\":2}]}");
    h.settle();
    try testing.expectEqual(@as(usize, 0), h.db.async_started);
    try testing.expect(s.terminated);
    h.t.loop.lock();
    h.server.stopped = false;
    h.t.loop.unlock();
}

// ---------------------------------------------------------------------------
// `/validators` (TS #10061)

const domain_one = "SELECT id FROM domain";
const validator_boundary = "[{\"domain\":1,\"height\":\"100\",\"hash\":\"" ++ "ab" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]";

fn validatorHarness(h: *Harness, limits: live.Limits) !void {
    try h.initAsync(limits);
    h.db.add(.{ .contains = domain_one, .persistent = true, .domain = 1, .rows = "[{\"id\":1}]" });
}

/// Every validator setup ended (its live start's send completed).
fn waitSetups(h: *Harness) !void {
    for (0..10_000) |_| {
        if (h.server.metricsSnapshot().validatorPendingSetups == 0) return;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    return error.Timeout;
}

fn rejectionCount(reason: []const u8) f64 {
    return core.metrics.websocket_connection_rejections.get(.{ reason, "validators" });
}

test "validators: URL admission answers with a status before any read" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    defer h.deinit();
    const long = "/validators?domain=1&" ++ "x" ** 1024;
    for ([_][]const u8{ "/validators", "/validators?domain=1,2", "/validators?domain=1&domain=2", "/validators?domain=1&blocks=true", long, "/validators?domain=1&%64omain=1" }) |url| {
        try testing.expectEqual(Harness.ValidatorOutcome{ .rejected = 400 }, h.validator(url, null));
    }
    // A latin1 byte counts twice in `Buffer.byteLength`.
    const at_limit = "/validators?domain=1&" ++ "x" ** (1024 - 21);
    try testing.expect(h.validator(at_limit, null) == .rejected);
    try testing.expectEqual(Harness.ValidatorOutcome{ .rejected = 403 }, h.validator("/validators?domain=1", "not-an-ip"));
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    try testing.expectEqual(@as(usize, 0), h.db.queries.items.len);
}

test "validators: canonical ready, live start, ping-only frames" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    defer h.deinit();
    h.db.on("JOIN scraper_checkpoint c", validator_boundary);
    const s, const peer = try h.connectedValidator("/validators?domain=1", null);
    try h.waitFrames(s, 2);
    try testing.expectEqualStrings("{\"type\":\"ready\",\"domain\":1,\"eventTypes\":[\"merkle_tree_insertion\"],\"historicalStreaming\":false,\"liveStartVersion\":1}", s.frame(0));
    try testing.expectEqualStrings("{\"type\":\"live_start\",\"domain\":1,\"height\":\"100\",\"hash\":\"0x" ++ "ab" ** 32 ++ "\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"address\":\"0x" ++ "22" ** 32 ++ "\"}]}", s.frame(1));
    try waitSetups(&h);
    const snapshot = h.server.metricsSnapshot();
    try testing.expectEqual(@as(f64, 0), snapshot.connections.agent);
    try testing.expectEqual(@as(f64, 1), snapshot.connections.validators);
    try testing.expectEqual(@as(f64, 0), snapshot.subscriptions.merkle_tree_insertion);
    try testing.expectEqual(@as(f64, 0), snapshot.validatorPendingSetups);
    try testing.expectEqual(@as(f64, 1), snapshot.validatorClientIps);
    {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        h.t.loop.lock();
        const full = try h.server.metricsSnapshotIn(arena.allocator());
        h.t.loop.unlock();
        try testing.expectEqual(@as(usize, 1), full.validatorSubscriptions.len);
        try testing.expectEqual(core.metrics.ValidatorSubscription{ .domain = 1, .canonical = 1 }, full.validatorSubscriptions[0]);
    }
    h.server.onValidatorMessage(peer, "{\"type\":\"ping\"}", false);
    try h.waitFrames(s, 3);
    try testing.expectEqualStrings("{\"type\":\"pong\"}", s.frame(2));
    const before = rejectionCount("invalid_message");
    h.server.onValidatorMessage(peer, "invalid", false);
    try h.waitFrames(s, 4);
    try testing.expectEqualStrings("{\"error\":\"Unexpected token 'i', \\\"invalid\\\" is not valid JSON\",\"type\":\"error\"}", s.frame(3));
    try testing.expectEqual(@as(?u16, 1008), s.close_code);
    try testing.expectEqualStrings("Invalid subscription", s.reason());
    try testing.expectEqual(before + 1, rejectionCount("invalid_message"));
}

test "validators: binary, subscription and other frames are rejected" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    defer h.deinit();
    const cases = [_]struct { data: []const u8, binary: bool, message: []const u8 }{
        .{ .data = "{\"type\":\"ping\"}", .binary = true, .message = "Expected a text ping" },
        .{ .data = "{\"type\":\"subscribe\",\"streams\":[]}", .binary = false, .message = "Only ping is allowed; reconnect to change the subscription" },
        .{ .data = "{\"type\":\"ping\",\"domain\":2}", .binary = false, .message = "Only ping is allowed; reconnect to change the subscription" },
    };
    for (cases) |case| {
        const s, const peer = try h.connectedValidator("/validators?domain=1", null);
        try h.waitFrames(s, 2);
        h.server.onValidatorMessage(peer, case.data, case.binary);
        try h.waitFrames(s, 3);
        try testing.expect(std.mem.indexOf(u8, s.frame(2), case.message) != null);
        try testing.expectEqual(@as(?u16, 1008), s.close_code);
        h.close(peer);
    }
    // The 31st message in a minute.
    const s, const peer = try h.connectedValidator("/validators?domain=1", null);
    try h.waitFrames(s, 2);
    for (0..31) |_| h.server.onValidatorMessage(peer, "{\"type\":\"ping\"}", false);
    try h.waitFrames(s, 33);
    try testing.expectEqualStrings("{\"error\":\"Client message rate limit exceeded\",\"type\":\"error\"}", s.frame(32));
    try testing.expectEqualStrings("Invalid subscription", s.reason());
}

test "validators: an unknown domain closes 1008 before any reader" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    defer h.deinit();
    const s, _ = try h.connectedValidator("/validators?domain=999&confirmations=0", null);
    try h.waitFrames(s, 1);
    try testing.expectEqualStrings("{\"error\":\"Unknown domain 999\",\"type\":\"error\"}", s.frame(0));
    try waitClosed(s);
    try testing.expectEqual(@as(?u16, 1008), s.close_code);
    h.settle();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().validatorSharedReaders);
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    try testing.expectEqual(@as(usize, 1), h.db.queries.items.len);
}

test "validators: limits by IP, total and pending setups; reservations last until close and setup end" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.max_validator_clients = 4;
    limits.max_validator_clients_per_ip = 2;
    try validatorHarness(&h, limits);
    defer h.deinit();
    var gate: QueryGate = .{ .contains = domain_one };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    defer gate.released.set();
    _, const first = try h.connectedValidator("/validators?domain=1", "203.0.113.1");
    _ = try h.connectedValidator("/validators?domain=1", "203.0.113.1");
    try testing.expectEqual(Harness.ValidatorOutcome{ .rejected = 429 }, h.validator("/validators?domain=1", "203.0.113.1"));
    _ = try h.connectedValidator("/validators?domain=1", "203.0.113.2");
    _ = try h.connectedValidator("/validators?domain=1", "203.0.113.3");
    try testing.expectEqual(Harness.ValidatorOutcome{ .rejected = 503 }, h.validator("/validators?domain=1", "203.0.113.4"));
    gate.started.wait();
    try testing.expectEqual(@as(f64, 4), h.server.metricsSnapshot().validatorPendingSetups);
    // A disconnected pending setup keeps its reservation, even once closed.
    h.close(first);
    var snapshot = h.server.metricsSnapshot();
    try testing.expectEqual(@as(f64, 3), snapshot.connections.validators);
    try testing.expectEqual(@as(f64, 4), snapshot.validatorReservedConnections);
    try testing.expectEqual(Harness.ValidatorOutcome{ .rejected = 503 }, h.validator("/validators?domain=1", "203.0.113.4"));
    gate.released.set();
    for (0..1000) |_| {
        if (h.server.metricsSnapshot().validatorPendingSetups == 0) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    snapshot = h.server.metricsSnapshot();
    try testing.expectEqual(@as(f64, 3), snapshot.validatorReservedConnections);
    try testing.expectEqual(@as(f64, 0), snapshot.validatorPendingSetups);
    _ = try h.connectedValidator("/validators?domain=1", "203.0.113.4");
}

test "validators: a rejected socket keeps its reservation until it closes" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.max_validator_clients = 2;
    try validatorHarness(&h, limits);
    defer h.deinit();
    const s, const peer = try h.connectedValidator("/validators?domain=1", "203.0.113.80");
    _ = try h.connectedValidator("/validators?domain=1", "203.0.113.81");
    try h.waitFrames(s, 2);
    try waitSetups(&h);
    h.server.onValidatorMessage(peer, "{\"type\":\"subscribe\"}", false);
    try waitClosed(s);
    const snapshot = h.server.metricsSnapshot();
    try testing.expectEqual(@as(f64, 1), snapshot.connections.validators);
    try testing.expectEqual(@as(f64, 2), snapshot.validatorReservedConnections);
    try testing.expectEqual(Harness.ValidatorOutcome{ .rejected = 503 }, h.validator("/validators?domain=1", null));
    h.close(peer);
    try testing.expectEqual(@as(f64, 1), h.server.metricsSnapshot().validatorReservedConnections);
    _ = try h.connectedValidator("/validators?domain=1", null);
}

test "validators: one shared custom reader per domain and count; the last member releases it" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try validatorHarness(&h, limits);
    defer h.deinit();
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .persistent = true, .domain = null, .rows = "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"5\",\"height\":\"10\",\"hash\":\"" ++ "ab" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]" });
    const s1, const p1 = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s1, 2);
    const s2, const p2 = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s2, 2);
    for ([_]*FakeSocket{ s1, s2 }) |s| {
        try testing.expectEqualStrings("{\"type\":\"ready\",\"domain\":1,\"confirmations\":0,\"eventTypes\":[\"merkle_tree_insertion\"],\"historicalStreaming\":false,\"liveStartVersion\":1}", s.frame(0));
        try testing.expect(std.mem.startsWith(u8, s.frame(1), "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":0,\"height\":\"10\""));
    }
    try testing.expectEqual(@as(f64, 1), h.server.metricsSnapshot().validatorSharedReaders);
    {
        h.db.mutex.lock();
        defer h.db.mutex.unlock();
        var snapshots: usize = 0;
        for (h.db.queries.items) |query| snapshots += @intFromBool(std.mem.indexOf(u8, query, "unnest(") != null);
        // The creator's initialization plus the joiner's current boundary.
        try testing.expectEqual(@as(usize, 2), snapshots);
    }
    h.close(p1);
    try testing.expectEqual(@as(f64, 1), h.server.metricsSnapshot().validatorSharedReaders);
    h.close(p2);
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().validatorSharedReaders);
}

test "validators: an unavailable custom policy closes 1008; a failed read closes 1013 without a frame" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    defer h.deinit();
    const s, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s, 1);
    try testing.expectEqualStrings("{\"error\":\"Custom confirmations unavailable for domain 1\",\"type\":\"error\"}", s.frame(0));
    try waitClosed(s);
    try testing.expectEqual(@as(?u16, 1008), s.close_code);
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .fail = true });
    const before = rejectionCount("setup_error");
    const s2, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try waitClosed(s2);
    try testing.expectEqual(@as(?u16, 1013), s2.close_code);
    try testing.expectEqualStrings("Stream unavailable", s2.reason());
    try testing.expectEqual(@as(usize, 0), s2.count());
    try testing.expectEqual(before + 1, rejectionCount("setup_error"));
    h.settle();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().validatorPendingSetups);
}

test "validators: validator-only canonical notifications use their own queue; agent ones reach validators too" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try validatorHarness(&h, limits);
    defer h.deinit();
    const s, _ = try h.connectedValidator("/validators?domain=1", null);
    try h.waitFrames(s, 2);
    try waitSetups(&h);
    h.db.add(.{ .contains = "notification_id", .persistent = true, .rows = "[{\"notification_id\":\"7\",\"domain\":1,\"merkle_tree_hook\":\"\\\\x22\",\"leaf_index\":1,\"message_id\":\"\\\\xaa\",\"block_number\":\"9\",\"id\":\"7\"}]" });
    h.listen.notify("scraper_event", "{\"eventType\":\"merkle_tree_insertion\",\"domain\":1,\"id\":\"7\"}");
    h.t.loop.lock();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().notificationQueue.agent);
    try testing.expectEqual(@as(f64, 1), h.server.metricsSnapshot().notificationQueue.validators);
    h.t.loop.unlock();
    h.t.fake.tick(100);
    try h.waitFrames(s, 3);
    try testing.expect(std.mem.startsWith(u8, s.frame(2), "{\"type\":\"event\",\"eventType\":\"merkle_tree_insertion\""));
    // Another domain or event type: not queued at all.
    h.listen.notify("scraper_event", "{\"eventType\":\"merkle_tree_insertion\",\"domain\":2,\"id\":\"8\"}");
    h.listen.notify("scraper_event", "{\"eventType\":\"dispatch\",\"domain\":1,\"id\":\"9\"}");
    h.t.loop.lock();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().notificationQueue.validators);
    h.t.loop.unlock();
    // With an agent subscriber the agent queue carries it; validators get it too.
    const as, const agent = h.agent();
    try h.waitFrames(as, 1);
    h.server.onMessage(agent, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"domains\":[1]}]}");
    try h.waitFrames(as, 3);
    h.listen.notify("scraper_event", "{\"eventType\":\"merkle_tree_insertion\",\"domain\":1,\"id\":\"7\"}");
    h.t.loop.lock();
    try testing.expectEqual(@as(f64, 1), h.server.metricsSnapshot().notificationQueue.agent);
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().notificationQueue.validators);
    h.t.loop.unlock();
    h.t.fake.tick(100);
    try h.waitFrames(as, 4);
    try h.waitFrames(s, 4);
}

test "per-domain confirmations: echoed map, custom group first, canonical publication excludes overridden domains" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.initAsync(limits);
    defer h.deinit();
    h.db.add(.{ .contains = "SELECT h.domain, h.head_height", .persistent = true, .domain = null, .rows = "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"5\",\"height\":null},{\"domain\":2,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"5\",\"height\":null}]" });
    const s, const peer = h.agent();
    try h.waitFrames(s, 1);
    h.server.onMessage(peer,
        \\{"type":"subscribe","confirmationsByDomain":{"2":0,"1":3},"streams":[{"eventType":"dispatch","domains":[1,2,7],"includeZeroConfirmations":true}]}
    );
    // subscribed, custom (3,[1]), custom (0,[2]), advisory zero over [1,7], canonical [7].
    try h.waitFrames(s, 7);
    try testing.expectEqualStrings(
        \\{"confirmationsByDomain":{"1":3,"2":0},"streams":[{"includeZeroConfirmations":true,"domains":[1,2,7],"eventType":"dispatch"}],"type":"subscribed"}
    , s.frame(1));
    try testing.expect(std.mem.startsWith(u8, s.frame(2), "{\"type\":\"live_start_unavailable\",\"domain\":1,\"confirmations\":3,"));
    try testing.expect(std.mem.startsWith(u8, s.frame(3), "{\"type\":\"live_start_unavailable\",\"domain\":2,\"confirmations\":0,"));
    try testing.expect(std.mem.startsWith(u8, s.frame(4), "{\"type\":\"live_start_unavailable\",\"domain\":1,\"confirmations\":0,"));
    try testing.expect(std.mem.startsWith(u8, s.frame(5), "{\"type\":\"live_start_unavailable\",\"domain\":7,\"confirmations\":0,"));
    try testing.expect(std.mem.startsWith(u8, s.frame(6), "{\"type\":\"live_start_unavailable\",\"domain\":7,\"eventTypes\""));
    h.settle();
    try testing.expectEqual(@as(usize, 7), s.count());
    h.db.mutex.lock();
    var snapshots: usize = 0;
    for (h.db.queries.items) |query| snapshots += @intFromBool(std.mem.indexOf(u8, query, "unnest(") != null);
    h.db.mutex.unlock();
    try testing.expectEqual(@as(usize, 1), snapshots);
    // Canonical publication only covers domain 7.
    h.listen.notify("scraper_event", "{\"eventType\":\"dispatch\",\"domain\":1,\"id\":\"5\"}");
    h.listen.notify("scraper_event", "{\"eventType\":\"dispatch\",\"domain\":7,\"id\":\"6\"}");
    h.t.loop.lock();
    try testing.expectEqual(@as(f64, 1), h.server.metricsSnapshot().notificationQueue.agent);
    h.t.loop.unlock();
}

const group_heads = "[{\"domain\":1,\"head_height\":\"10\",\"indexed_height\":\"10\",\"confirmed_height\":\"5\",\"height\":\"10\",\"hash\":\"" ++ "ab" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]";
const group_heads_rolled_back = "[{\"domain\":1,\"head_height\":\"8\",\"indexed_height\":\"8\",\"confirmed_height\":\"5\",\"height\":\"8\",\"hash\":\"" ++ "cd" ** 32 ++ "\",\"mailbox\":\"" ++ "11" ** 20 ++ "\",\"merkle_tree_hook\":\"" ++ "22" ** 32 ++ "\",\"interchain_gas_paymaster\":\"" ++ "33" ** 32 ++ "\"}]";
const group_rollback = "{\"domain\":1,\"confirmedHeight\":\"5\",\"indexedHeight\":\"8\",\"previousIndexedHeight\":\"10\",\"headHeight\":\"8\"}";

fn snapshotReads(h: *Harness) usize {
    h.db.mutex.lock();
    defer h.db.mutex.unlock();
    var reads: usize = 0;
    for (h.db.queries.items) |query| reads += @intFromBool(std.mem.indexOf(u8, query, "unnest(") != null);
    return reads;
}

test "validators: a rollback during the group's first heads read retries on a fresh read" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try validatorHarness(&h, limits);
    defer h.deinit();
    var gate: FirstQueryGate = .{ .contains = "unnest(" };
    h.db.before_query = .{ .ctx = &gate, .func = FirstQueryGate.before };
    defer gate.released.set();
    h.db.on("unnest(", group_heads);
    h.db.on("unnest(", group_heads_rolled_back);
    const s, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    gate.started.wait();
    h.listen.notify(live.HEAD_CHANNEL, group_rollback);
    gate.released.set();
    try h.waitFrames(s, 2);
    try testing.expect(std.mem.startsWith(u8, s.frame(1), "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":0,\"height\":\"8\",\"hash\":\"0x" ++ "cd" ** 32));
    try testing.expectEqual(@as(usize, 2), snapshotReads(&h));
}

test "validators: every member awaiting a group shares its failure; a later joiner starts a fresh group" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    defer h.deinit();
    var gate: FirstQueryGate = .{ .contains = "unnest(" };
    h.db.before_query = .{ .ctx = &gate, .func = FirstQueryGate.before };
    defer gate.released.set();
    // Domain 1 exists but has no head: ConfirmationUnavailable.
    const s1, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    gate.started.wait();
    const s2, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    for (0..1000) |_| {
        h.t.loop.lock();
        const pending = h.server.metricsSnapshot().validatorPendingSetups;
        h.t.loop.unlock();
        // s2 joined (its domain check done) and awaits the same `ready`.
        if (pending == 2 and h.db.queries.items.len >= 3) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    h.settle();
    gate.released.set();
    for ([_]*FakeSocket{ s1, s2 }) |s| {
        try h.waitFrames(s, 1);
        try testing.expectEqualStrings("{\"error\":\"Custom confirmations unavailable for domain 1\",\"type\":\"error\"}", s.frame(0));
        try waitClosed(s);
    }
    // One initialization read served both.
    try testing.expectEqual(@as(usize, 1), snapshotReads(&h));
    try waitSetups(&h);
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().validatorSharedReaders);
    const s3, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s3, 1);
    try testing.expectEqual(@as(usize, 2), snapshotReads(&h));
}

test "validators: a joiner re-reads its boundary when a rollback lands during its heads read" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try validatorHarness(&h, limits);
    defer h.deinit();
    h.db.on("unnest(", group_heads);
    const s1, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s1, 2);
    try waitSetups(&h);
    var gate: FirstQueryGate = .{ .contains = "unnest(" };
    h.db.mutex.lock();
    h.db.before_query = .{ .ctx = &gate, .func = FirstQueryGate.before };
    h.db.mutex.unlock();
    defer gate.released.set();
    h.db.on("unnest(", group_heads);
    h.db.on("unnest(", group_heads_rolled_back);
    const s2, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    gate.started.wait();
    h.listen.notify(live.HEAD_CHANNEL, group_rollback);
    gate.released.set();
    try h.waitFrames(s2, 2);
    try testing.expect(std.mem.startsWith(u8, s2.frame(1), "{\"type\":\"live_start\",\"domain\":1,\"confirmations\":0,\"height\":\"8\""));
    // The creator's read, then the joiner's two.
    try testing.expectEqual(@as(usize, 3), snapshotReads(&h));
}

test "validators: the last member failing during a group broadcast frees the group safely" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    // ready and live_start fit; an event row does not.
    limits.max_buffered_bytes = 1_000;
    try validatorHarness(&h, limits);
    defer h.deinit();
    h.db.add(.{ .contains = "unnest(", .persistent = true, .rows = group_heads });
    const s, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s, 2);
    try waitSetups(&h);
    h.db.add(.{ .contains = "confirmation_events", .rows = "[{\"domain\":1,\"merkle_tree_hook\":\"\\\\x" ++ "22" ** 32 ++ "\",\"leaf_index\":1,\"message_id\":\"\\\\x" ++ "aa" ** 32 ++ "\",\"block_number\":11,\"block_hash\":\"\\\\x" ++ "bb" ** 32 ++ "\",\"frontier_id\":\"1\",\"frontier_height\":\"11\",\"padding\":\"" ++ "x" ** 1500 ++ "\"}]" });
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"5\",\"headHeight\":\"11\",\"indexedHeight\":\"11\",\"previousIndexedHeight\":\"10\"}");
    h.t.fake.tick(100);
    try waitClosed(s);
    try testing.expect(s.terminated);
    h.settle();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().validatorSharedReaders);
}

test "validators: stop with pending setups counts and logs nothing for them" {
    var h: Harness = .{};
    try validatorHarness(&h, defaultLimits());
    var gate: QueryGate = .{ .contains = domain_one };
    h.db.before_query = .{ .ctx = &gate, .func = QueryGate.before };
    _ = try h.connectedValidator("/validators?domain=1", null);
    _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    gate.started.wait();
    const before = rejectionCount("setup_error");
    const Releaser = struct {
        fn run(g: *QueryGate) void {
            std.Thread.sleep(100 * std.time.ns_per_ms);
            g.released.set();
        }
    };
    const releaser = try std.Thread.spawn(.{}, Releaser.run, .{&gate});
    h.deinit(); // stop waits for the held reads; their setups end silently
    releaser.join();
    try testing.expectEqual(before, rejectionCount("setup_error"));
}

test "validators: a group rollback is broadcast at once, in the validator frame's key order" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try validatorHarness(&h, limits);
    defer h.deinit();
    h.db.add(.{ .contains = "unnest(", .persistent = true, .rows = group_heads });
    const s, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s, 2);
    try waitSetups(&h);
    h.db.add(.{ .contains = "confirmation_events", .rows = "[{\"domain\":1,\"merkle_tree_hook\":\"\\\\x" ++ "22" ** 32 ++ "\",\"leaf_index\":1,\"message_id\":\"\\\\x" ++ "aa" ** 32 ++ "\",\"block_number\":11,\"block_hash\":\"\\\\x" ++ "bb" ** 32 ++ "\",\"frontier_id\":\"1\",\"frontier_height\":\"11\"}]" });
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"5\",\"headHeight\":\"11\",\"indexedHeight\":\"11\",\"previousIndexedHeight\":\"10\"}");
    h.t.fake.tick(100);
    try h.waitFrames(s, 3);
    try testing.expect(std.mem.startsWith(u8, s.frame(2), "{\"type\":\"event\",\"eventType\":\"merkle_tree_insertion\",\"domain\":1,"));
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"5\",\"headHeight\":\"9\",\"indexedHeight\":\"9\",\"previousIndexedHeight\":\"11\"}");
    // Synchronous with the notification (no task, no send wait).
    try testing.expectEqual(@as(usize, 4), s.count());
    try testing.expectEqualStrings("{\"type\":\"rollback\",\"eventType\":\"merkle_tree_insertion\",\"domain\":1,\"confirmations\":0,\"fromHeight\":\"11\",\"toHeight\":\"9\"}", s.frame(3));
}

// ---------------------------------------------------------------------------
// `-Dparity-hooks` (parity/hooks/ts-hooks.mjs's protocol)

test "parity hooks: held event callbacks keep pending bytes until released; an error release fails the send" {
    if (comptime !@import("runtime.zig").parity_hooks) return error.SkipZigTest;
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    const s, _ = subscribeLiveDispatch(&h);
    h.server.hookMode(.all);
    notifyThreeDispatches(&h);
    try h.waitFrames(s, 6);
    h.settle();
    // Written to the client, callbacks held in order.
    try testing.expectEqual(@as(usize, 3), h.server.hookHeld());
    try testing.expect(h.server.metricsSnapshot().outboundPendingBytes > 0);
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().maxClientBufferedBytes);
    var released = h.server.hookRelease(null);
    try testing.expect(released.released);
    try testing.expectEqual(@as(usize, 2), released.held);
    const failures = core.metrics.websocket_send_failures.get(.{"send_error"});
    released = h.server.hookRelease("write EPIPE");
    try testing.expectEqual(@as(usize, 1), released.held);
    try waitClosed(s);
    try testing.expect(s.terminated);
    try testing.expectEqual(failures + 1, core.metrics.websocket_send_failures.get(.{"send_error"}));
    // After the close, a failed release is not another send failure.
    _ = h.server.hookRelease("write ECANCELED");
    try testing.expectEqual(failures + 1, core.metrics.websocket_send_failures.get(.{"send_error"}));
    try testing.expectEqual(@as(usize, 0), h.server.hookHeld());
    h.settle();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().outboundPendingBytes);
}

test "parity hooks: the 30 s heartbeat runs only on tick; mode off holds nothing new" {
    if (comptime !@import("runtime.zig").parity_hooks) return error.SkipZigTest;
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 30_000; // ts-hooks intercepts exactly the 30 s interval
    try h.init(limits);
    defer h.deinit();
    const s, _ = h.agent();
    try h.waitFrames(s, 1);
    std.Thread.sleep(150 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 1), s.count());
    try testing.expectEqual(@as(usize, 1), h.server.hookTick());
    try h.waitFrames(s, 2);
    try testing.expect(std.mem.indexOf(u8, s.frame(1), "\"type\":\"heartbeat\"") != null);
    h.server.hookMode(.all);
    h.server.hookMode(.off);
    _, _ = subscribeLiveDispatch(&h);
    notifyThreeDispatches(&h);
    h.settle();
    try testing.expectEqual(@as(usize, 0), h.server.hookHeld());
}

test "parity hooks: stop with a held awaited send ends its task silently (no hang, no leak)" {
    if (comptime !@import("runtime.zig").parity_hooks) return error.SkipZigTest;
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try validatorHarness(&h, limits);
    h.db.add(.{ .contains = "unnest(", .persistent = true, .rows = group_heads });
    const s, _ = try h.connectedValidator("/validators?domain=1&confirmations=0", null);
    try h.waitFrames(s, 2);
    try waitSetups(&h);
    h.server.hookMode(.all);
    h.db.add(.{ .contains = "confirmation_events", .rows = "[{\"domain\":1,\"merkle_tree_hook\":\"\\\\x" ++ "22" ** 32 ++ "\",\"leaf_index\":1,\"message_id\":\"\\\\x" ++ "aa" ** 32 ++ "\",\"block_number\":11,\"block_hash\":\"\\\\x" ++ "bb" ** 32 ++ "\",\"frontier_id\":\"1\",\"frontier_height\":\"11\"}]" });
    const s2, const agent = h.agent();
    try h.waitFrames(s2, 1);
    h.server.onMessage(agent, "{\"type\":\"subscribe\",\"streams\":[{\"eventType\":\"merkle_tree_insertion\",\"domains\":[1],\"confirmations\":0}]}");
    try h.waitFrames(s2, 3);
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"confirmedHeight\":\"5\",\"headHeight\":\"11\",\"indexedHeight\":\"11\",\"previousIndexedHeight\":\"10\"}");
    h.t.fake.tick(100);
    for (0..2000) |_| {
        if (h.server.hookHeld() >= 1) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try testing.expect(h.server.hookHeld() >= 1);
    const failures = core.metrics.websocket_send_failures.get(.{"send_error"});
    h.deinit(); // stop settles the held callbacks; the pool joins the drain task
    try testing.expectEqual(failures, core.metrics.websocket_send_failures.get(.{"send_error"}));
}

test "abandons an in-flight head range while listener shutdown is pending (67)" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 1_000_000;
    try h.init(limits);
    defer h.deinit();
    var read_gate: FirstQueryGate = .{ .contains = "\"frontier_row\"" };
    h.db.before_query = .{ .ctx = &read_gate, .func = FirstQueryGate.before };
    defer read_gate.released.set();
    var listener_gate: std.Thread.ResetEvent = .{};
    h.listen.unlisten_gate = &listener_gate;
    defer listener_gate.set();
    h.db.on("\"frontier_row\"", "[{\"frontier_id\":\"1\",\"frontier_height\":\"10\",\"msg_id\":\"\\\\x" ++ "ab" ** 32 ++ "\"}]");
    const s, _ = h.explorer("/messages", null);
    try h.waitFrames(s, 1);
    h.listen.notify(live.HEAD_CHANNEL, "{\"domain\":1,\"previousConfirmedHeight\":\"9\",\"confirmedHeight\":\"10\"}");
    h.t.fake.tick(100);
    read_gate.started.wait();
    // stop() blocks in the listener shutdown; the range's read finishes meanwhile.
    const Stopper = struct {
        fn run(server: *live.Server, done: *std.Thread.ResetEvent) void {
            server.stop();
            done.set();
        }
    };
    var stopped: std.Thread.ResetEvent = .{};
    const stopper = try std.Thread.spawn(.{}, Stopper.run, .{ h.server, &stopped });
    for (0..1000) |_| {
        h.t.loop.lock();
        const is_stopped = h.server.stopped;
        h.t.loop.unlock();
        if (is_stopped) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    read_gate.released.set();
    h.settle();
    h.t.loop.lock();
    try testing.expectEqual(@as(f64, 0), h.server.metricsSnapshot().notificationQueue.messages);
    h.t.loop.unlock();
    {
        h.db.mutex.lock();
        defer h.db.mutex.unlock();
        var reads: usize = 0;
        for (h.db.queries.items) |query| reads += @intFromBool(std.mem.indexOf(u8, query, "\"frontier_row\"") != null);
        try testing.expectEqual(@as(usize, 1), reads); // shutdown must not read the rest of the range
    }
    try testing.expect(!stopped.isSet());
    listener_gate.set();
    stopper.join();
    try testing.expectEqual(@as(usize, 0), countFrames(s, "\"type\":\"message_upsert\""));
}

test "a heartbeat turn gives back an idle peer's list capacity" {
    var h: Harness = .{};
    var limits = defaultLimits();
    limits.heartbeat_ms = 200;
    try h.init(limits);
    defer h.deinit();
    const s, const peer = subscribeLiveDispatch(&h);
    const e, const explorer = h.explorer("/messages", null);
    try h.waitFrames(e, 1);
    // Two upserts go through the Explorer queue (queued, then drained).
    const first = "02" ** 32;
    const second = "03" ** 32;
    h.db.on("FROM \"message_view\"", comptime upsertRows(&.{ first, second }));
    notifyExplorer(&h, first);
    notifyExplorer(&h, second);
    h.t.fake.tick(100);
    try h.waitFrames(e, 3);
    h.settle();
    {
        h.t.loop.lock();
        defer h.t.loop.unlock();
        try testing.expect(explorer.explorer.queue.capacity > 0);
    }
    // ready, subscribed, live start; then the first heartbeat.
    h.t.fake.tick(200);
    try h.waitFrames(s, 4);
    try h.waitFrames(e, 4);
    h.server.onPong(peer);
    h.server.onPong(explorer);
    h.settle();
    h.t.loop.lock();
    defer h.t.loop.unlock();
    for ([_]*live.Peer{ peer, explorer }) |p| {
        try testing.expectEqual(@as(usize, 0), p.cork.bytes.capacity);
        try testing.expectEqual(@as(usize, 0), p.cork.frames.capacity);
        try testing.expectEqual(@as(usize, 0), p.cork.outcomes.capacity);
        try testing.expectEqual(@as(usize, 0), p.requests.capacity);
        try testing.expectEqual(@as(usize, 0), p.completed.capacity);
    }
    try testing.expectEqual(@as(usize, 0), explorer.explorer.queue.capacity);
    try testing.expectEqual(@as(usize, 0), explorer.explorer.queue_head);
}
