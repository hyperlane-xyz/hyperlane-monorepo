//! Differential proof for write coalescing (corked frames, Explorer drain
//! lookahead): the same random scenario runs against a server that writes
//! every frame inline as it is sent (the reference, Node's order) and one
//! that coalesces, over sockets whose kernel accepts a scripted number of
//! bytes. Every client-visible outcome must match: frames delivered per
//! client and their order, terminations and close codes, failure counters,
//! queue lengths/bytes and outbound pending bytes after every step.
//!
//! The kernel model accepts bytes in order up to a per-socket capacity that
//! changes only between steps, so both servers see the same acceptance for
//! the same byte stream however they split it into syscalls. Queued frames
//! (ws's buffer) are written when the client reads (a `refresh` step), where
//! their completions run, never inside a socket call.
const std = @import("std");
const testing = std.testing;
const core = @import("core");
const json = core.json;
const runtime = @import("runtime.zig");
const live = @import("server.zig");
const es = @import("event_store.zig");
const TestLoop = @import("notification_worker_test.zig").TestLoop;

const a = testing.allocator;

/// Header size ws adds to a text frame.
fn framed(len: usize) usize {
    return len + (if (len < 126) @as(usize, 2) else if (len <= 0xffff) @as(usize, 4) else 10);
}

const KernelSocket = struct {
    /// Bytes the kernel takes before the client reads again.
    capacity: usize = 0,
    /// The next write attempt fails (connection reset).
    fail_next: bool = false,
    /// The peer's close arrives during the next tick that writes (just
    /// before its first write); like ws with live's transition hook it takes
    /// effect only after that tick (`settleClose`), so the tick's frames see
    /// OPEN.
    close_next: bool = false,
    close_arrived: bool = false,
    /// Writes refused because the socket was no longer OPEN.
    refused: usize = 0,
    /// A ping arrives just before the next write attempt: ws queues the pong.
    pong_next: bool = false,
    destroyed: bool = false,
    open: bool = true,
    close_code: ?u16 = null,
    close_reason: std.ArrayList(u8) = .empty,
    /// ws's queue: whole frames (`total` bytes each), `off` already written.
    queue: std.ArrayList(Item) = .empty,
    buffered: usize = 0,
    /// Payloads the client has received in full, in order.
    delivered: std.ArrayList([]u8) = .empty,
    /// Write syscalls made.
    writes: usize = 0,

    const Item = struct { payload: []u8, total: usize, off: usize, job: ?*live.SendJob, control: bool = false };

    fn socket(self: *KernelSocket) live.Socket {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: live.Socket.VTable = .{
        .send = send,
        .buffered_amount = bufferedAmount,
        .is_open = isOpen,
        .snapshot = snapshot,
        .close = close,
        .terminate = terminate,
        .ping = ping,
        .release = release,
        .try_send_inline = trySendInline,
        .try_send_inline_many = trySendInlineMany,
    };

    fn of(ptr: *anyopaque) *KernelSocket {
        return @ptrCast(@alignCast(ptr));
    }

    fn deinit(self: *KernelSocket) void {
        for (self.queue.items) |item| a.free(item.payload);
        self.queue.deinit(a);
        for (self.delivered.items) |payload| a.free(payload);
        self.delivered.deinit(a);
        self.close_reason.deinit(a);
    }

    /// Write `total` bytes of a frame: how many the kernel took.
    fn take(self: *KernelSocket, total: usize) usize {
        const n = @min(self.capacity, total);
        self.capacity -= n;
        return n;
    }

    fn deliver(self: *KernelSocket, payload: []const u8) void {
        self.delivered.append(a, a.dupe(u8, payload) catch unreachable) catch unreachable;
    }

    fn enqueue(self: *KernelSocket, payload: []const u8, off: usize, job: ?*live.SendJob) void {
        const total = framed(payload.len);
        self.queue.append(a, .{ .payload = a.dupe(u8, payload) catch unreachable, .total = total, .off = off, .job = job }) catch unreachable;
        self.buffered += total;
    }

    /// The peer's close arrives now (mid-tick); the socket stays OPEN until
    /// the tick is over. True when the socket is no longer OPEN.
    fn closing(self: *KernelSocket) bool {
        if (self.close_next) {
            self.close_next = false;
            self.close_arrived = true;
        }
        if (self.destroyed or !self.open) {
            self.refused += 1;
            return true;
        }
        return false;
    }

    /// After a tick, under the loop mutex: the arrived close takes effect.
    fn settleClose(self: *KernelSocket) void {
        if (!self.close_arrived) return;
        self.close_arrived = false;
        self.open = false;
    }

    /// The auto-pong is queued ahead of the next write (no client-visible
    /// payload; it takes kernel capacity like any frame).
    fn pong(self: *KernelSocket) void {
        if (!self.pong_next) return;
        self.pong_next = false;
        self.queue.append(a, .{ .payload = a.dupe(u8, "") catch unreachable, .total = 2, .off = 0, .job = null, .control = true }) catch unreachable;
        self.buffered += 2;
    }

    /// A write attempt: false when it fails (the socket is destroyed).
    fn attempt(self: *KernelSocket) bool {
        if (!self.fail_next) return true;
        self.fail_next = false;
        self.destroyed = true;
        self.open = false;
        return false;
    }

    fn send(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) bool {
        const self = of(ptr);
        if (self.closing()) return false;
        self.pong();
        self.enqueue(bytes, 0, job);
        return true;
    }

    fn trySendInline(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) live.Socket.InlineResult {
        const self = of(ptr);
        if (self.closing()) return .closed;
        self.pong();
        if (self.queue.items.len > 0 or self.capacity == 0) return .busy;
        self.writes += 1;
        if (!self.attempt()) return .failed;
        const total = framed(bytes.len);
        const n = self.take(total);
        if (n == total) {
            self.deliver(bytes);
            return .written;
        }
        self.enqueue(bytes, n, job);
        return .partial;
    }

    fn trySendInlineMany(ptr: *anyopaque, payloads: []const []const u8, jobs: []const *live.SendJob, required: usize) live.Socket.ManyResult {
        const self = of(ptr);
        if (self.closing()) return .closed;
        self.pong();
        var written: usize = 0;
        var stopped_inside = false;
        if (self.queue.items.len == 0 and self.capacity > 0) {
            self.writes += 1;
            if (!self.attempt()) return .failed;
            for (payloads) |bytes| {
                const total = framed(bytes.len);
                const n = self.take(total);
                if (n == total) {
                    self.deliver(bytes);
                    written += 1;
                    continue;
                }
                if (n > 0) {
                    self.enqueue(bytes, n, jobs[written]);
                    stopped_inside = true;
                }
                break;
            }
        }
        // The frame the kernel stopped inside, then the rest of the required
        // frames, queued in the same step.
        var queued: usize = if (stopped_inside) 1 else 0;
        while (written + queued < required) : (queued += 1) self.enqueue(payloads[written + queued], 0, jobs[written + queued]);
        return .{ .done = .{ .written = written, .queued = queued } };
    }

    fn bufferedAmount(ptr: *anyopaque) usize {
        return of(ptr).buffered;
    }
    fn isOpen(ptr: *anyopaque) bool {
        const self = of(ptr);
        return self.open and !self.destroyed;
    }
    fn snapshot(ptr: *anyopaque) live.Socket.Snapshot {
        return .{ .open = isOpen(ptr), .buffered = bufferedAmount(ptr) };
    }
    fn close(ptr: *anyopaque, code: u16, reason: []const u8) void {
        const self = of(ptr);
        if (!self.open or self.destroyed) return;
        self.open = false;
        self.close_code = code;
        self.close_reason.appendSlice(a, reason) catch unreachable;
    }
    fn terminate(ptr: *anyopaque) void {
        const self = of(ptr);
        self.destroyed = true;
        self.open = false;
    }
    fn ping(_: *anyopaque) void {}
    fn release(_: *anyopaque) void {}

    /// The client reads: the kernel takes `capacity` more bytes and ws writes
    /// its queue (completions run here, on the test thread). A destroyed
    /// socket fails what is left.
    fn refresh(self: *KernelSocket, capacity: usize) void {
        self.capacity += capacity;
        while (self.queue.items.len > 0) {
            const item = &self.queue.items[0];
            if (!self.destroyed) {
                item.off += self.take(item.total - item.off);
                if (item.off < item.total) return;
                if (!item.control) self.deliver(item.payload);
            }
            const done = self.queue.orderedRemove(0);
            self.buffered -= done.total;
            a.free(done.payload);
            if (done.job) |job| job.complete(!self.destroyed);
        }
    }
};

/// Canonical message rows: `\x<id>` with a body of a size fixed per id.
const MessageDb = struct {
    sizes: [16]usize = undefined,

    fn db(self: *MessageDb) es.Db {
        return .{ .ctx = self, .query = query };
    }

    fn query(ctx: *anyopaque, arena: std.mem.Allocator, sql: []const u8, params: []const json.Value) anyerror![]json.Value {
        const self: *MessageDb = @ptrCast(@alignCast(ctx));
        if (std.mem.indexOf(u8, sql, "FROM \"message_view\"") == null) return &.{};
        var rows: std.ArrayList(json.Value) = .empty;
        for (params[0].array) |id_value| {
            const id = id_value.string; // \x + 64 hex
            const index = std.fmt.parseInt(usize, id[id.len - 2 ..], 16) catch unreachable;
            const body = try arena.alloc(u8, self.sizes[index]);
            @memset(body, 'f');
            const text = try std.fmt.allocPrint(arena, "{{\"msg_id\":\"\\\\x{s}\",\"message_body\":\"{s}\"}}", .{ id[2..], body });
            try rows.append(arena, try json.parse(arena, text, .{}));
        }
        return rows.items;
    }
};

const NullListen = struct {
    handler: ?live.ListenHandler = null,

    fn api(self: *NullListen) live.Listen {
        return .{ .ctx = self, .listen = listen, .unlisten = unlisten };
    }
    fn listen(ctx: *anyopaque, _: []const []const u8, handler: live.ListenHandler) anyerror!*anyopaque {
        const self: *NullListen = @ptrCast(@alignCast(ctx));
        self.handler = handler;
        return self;
    }
    fn unlisten(_: *anyopaque, _: *anyopaque) void {}
};

fn messageId(buf: *[64]u8, index: usize) []const u8 {
    return std.fmt.bufPrint(buf, "{x:0>64}", .{index}) catch unreachable;
}

const max_clients = 6;

/// One scripted scenario, replayed identically against both servers.
const Scenario = struct {
    seed: u64,
    clients: usize,
    limits: live.Limits,
    sizes: [16]usize,
    /// Clients that also subscribe to block heads (non-awaited frames mixed
    /// with drain frames in the same cork).
    blocks: [max_clients]bool,
    steps: []const Step,

    const Step = union(enum) {
        /// Explorer notifications for these message ids.
        notify: struct { ids: [4]u8, count: u8 },
        /// The Explorer batch timer fires.
        drain,
        /// A client reads: its kernel takes this many more bytes.
        refresh: struct { client: u8, bytes: u32 },
        /// The client's next write fails.
        fail: u8,
        /// The client's close arrives just before its next write.
        close: u8,
        /// A ping from the client arrives just before its next write.
        ping: u8,
        /// A block head notification (block frames to block subscribers).
        head: struct { domain: u8, height: u32 },
    };

    fn generate(seed: u64, steps: *std.ArrayList(Step)) Scenario {
        var prng = std.Random.DefaultPrng.init(seed);
        const r = prng.random();
        var sizes: [16]usize = undefined;
        for (&sizes) |*size| size.* = r.intRangeAtMost(usize, 20, 2_500);
        const limits: live.Limits = .{
            .heartbeat_ms = 1_000_000,
            .max_agent_clients = 10,
            .max_buffered_bytes = r.intRangeAtMost(u64, 1_024, 12_000),
            .max_catch_up_ms = 1_800_000,
            .max_concurrent_catch_ups = 1,
            .max_total_buffered_bytes = r.intRangeAtMost(u64, 1_024, 24_000),
        };
        const clients = r.intRangeAtMost(usize, 1, max_clients);
        var blocks: [max_clients]bool = undefined;
        for (&blocks) |*flag| flag.* = r.boolean();
        const count = r.intRangeAtMost(usize, 5, 40);
        var height: u32 = 100;
        for (0..count) |_| {
            const step: Step = switch (r.intRangeLessThan(u8, 0, 14)) {
                12 => .{ .close = r.intRangeLessThan(u8, 0, @intCast(clients)) },
                13 => .{ .ping = r.intRangeLessThan(u8, 0, @intCast(clients)) },
                10, 11 => blk: {
                    height += r.intRangeAtMost(u32, 1, 3);
                    break :blk .{ .head = .{ .domain = r.intRangeAtMost(u8, 1, 3), .height = height } };
                },
                0...2 => blk: {
                    var ids: [4]u8 = undefined;
                    for (&ids) |*id| id.* = r.intRangeLessThan(u8, 0, 16);
                    break :blk .{ .notify = .{ .ids = ids, .count = r.intRangeAtMost(u8, 1, 4) } };
                },
                3...5 => .drain,
                6...8 => .{ .refresh = .{ .client = r.intRangeLessThan(u8, 0, @intCast(clients)), .bytes = r.intRangeAtMost(u32, 0, 6_000) } },
                else => .{ .fail = r.intRangeLessThan(u8, 0, @intCast(clients)) },
            };
            steps.append(a, step) catch unreachable;
        }
        return .{ .seed = seed, .clients = clients, .limits = limits, .sizes = sizes, .blocks = blocks, .steps = steps.items };
    }
};

/// Everything a client (or an operator) can observe.
const Trace = struct {
    text: std.ArrayList(u8) = .empty,

    fn deinit(self: *Trace) void {
        self.text.deinit(a);
    }
};

fn run(scenario: Scenario, coalesce: bool, trace: *Trace) !void {
    var loop: TestLoop = undefined;
    loop.init();
    var db: MessageDb = .{ .sizes = scenario.sizes };
    var listen: NullListen = .{};
    const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = scenario.limits, .batch_size = 500 }, null);
    server.coalesce = coalesce;
    try server.start();
    var sockets: [max_clients]KernelSocket = @splat(.{});
    var peers: [max_clients]*live.Peer = undefined;
    for (0..scenario.clients) |index| {
        sockets[index].capacity = 1_000_000; // the ready frame
        var ip: [16]u8 = undefined;
        peers[index] = server.connectExplorer(sockets[index].socket(), .{
            .url = if (scenario.blocks[index]) "/messages?blocks=true" else "/messages",
            .cf_connecting_ip = try std.fmt.bufPrint(&ip, "10.0.0.{d}", .{index + 1}),
            .remote_address = null,
        });
        // With blocks the ready frame follows a (task) snapshot read.
        for (0..10_000) |_| {
            loop.loop.lock();
            const ready = sockets[index].delivered.items.len > 0;
            loop.loop.unlock();
            if (ready) break;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        sockets[index].capacity = 0;
    }
    const w = trace.text.writer(a);
    const failures = &core.metrics.websocket_send_failures;
    const base = .{ failures.get(.{"buffer_limit"}), failures.get(.{"queue_limit"}), failures.get(.{"send_error"}) };
    for (scenario.steps, 0..) |step, step_index| {
        switch (step) {
            .notify => |n| for (n.ids[0..n.count]) |id| {
                var buf: [64]u8 = undefined;
                var payload: [96]u8 = undefined;
                const text = try std.fmt.bufPrint(&payload, "{{\"messageId\":\"{s}\"}}", .{messageId(&buf, id)});
                listen.handler.?.on_notification(listen.handler.?.ctx, live.EXPLORER_CHANNEL, text);
            },
            .drain => {
                loop.loop.lock();
                server.explorer_updates.flush();
                loop.loop.unlock();
            },
            .refresh => |r| if (r.client < scenario.clients) sockets[r.client].refresh(r.bytes),
            .fail => |client| if (client < scenario.clients) {
                sockets[client].fail_next = true;
            },
            .close => |client| if (client < scenario.clients) {
                sockets[client].close_next = true;
            },
            .ping => |client| if (client < scenario.clients) {
                sockets[client].pong_next = true;
            },
            .head => |h| {
                var payload: [256]u8 = undefined;
                const text = try std.fmt.bufPrint(&payload, "{{\"domain\":{d},\"confirmedHeight\":\"1\",\"headHeight\":\"{d}\",\"indexedHeight\":\"{d}\",\"indexedHash\":\"{x:0>64}\"}}", .{ h.domain, h.height + 7, h.height, h.height });
                listen.handler.?.on_notification(listen.handler.?.ctx, live.HEAD_CHANNEL, text);
            },
        }
        // Observe after the step (the loop mutex is free: its turn ended).
        loop.loop.lock();
        // A close that arrived during the step's tick takes effect now.
        for (sockets[0..scenario.clients]) |*socket| socket.settleClose();
        const snapshot = server.metricsSnapshot();
        try w.print("step {d} pending={d} explorerMessages={d} explorerBytes={d} connections={d} failures={d}/{d}/{d}\n", .{
            step_index,
            snapshot.outboundPendingBytes,
            snapshot.explorerPendingMessages,
            snapshot.explorerPendingBytes,
            snapshot.connections.messages,
            failures.get(.{"buffer_limit"}) - base[0],
            failures.get(.{"queue_limit"}) - base[1],
            failures.get(.{"send_error"}) - base[2],
        });
        for (0..scenario.clients) |index| {
            const s = &sockets[index];
            const peer = peers[index];
            try w.print("  client {d} delivered={d} buffered={d} open={} destroyed={} refused={d} close={?d}:{s} queue={d}/{d} sending={}\n", .{
                index,                           s.delivered.items.len, s.buffered,                    s.open,
                s.destroyed,                     s.refused,             s.close_code,                  s.close_reason.items,
                peer.explorer.queue.items.len - peer.explorer.queue_head,
                peer.explorer.queued_bytes,      peer.explorer.sending,
            });
        }
        loop.loop.unlock();
    }
    // Delivered frames per client, in order.
    for (0..scenario.clients) |index| {
        try w.print("client {d} frames:", .{index});
        for (sockets[index].delivered.items) |payload| {
            try w.print(" {x}", .{std.hash.Wyhash.hash(0, payload)});
        }
        try w.writeByte('\n');
    }
    // Teardown: complete what is queued (failed), close every peer.
    for (0..scenario.clients) |index| {
        sockets[index].destroyed = true;
        sockets[index].refresh(0);
    }
    server.stop();
    for (peers[0..scenario.clients]) |peer| server.onClose(peer);
    loop.pool.deinit();
    server.destroy();
    loop.loop.deinit();
    loop.fake.deinit();
    for (sockets[0..scenario.clients]) |*s| s.deinit();
}

fn discard(_: ?*anyopaque, _: core.log.Level, _: []const u8, _: []const u8) void {}

fn checkSeed(seed: u64) !void {
    var steps: std.ArrayList(Scenario.Step) = .empty;
    defer steps.deinit(a);
    const scenario = Scenario.generate(seed, &steps);
    var reference: Trace = .{};
    defer reference.deinit();
    var candidate: Trace = .{};
    defer candidate.deinit();
    try run(scenario, false, &reference);
    try run(scenario, true, &candidate);
    if (!std.mem.eql(u8, reference.text.items, candidate.text.items)) {
        std.debug.print("coalescing differs from inline writes, seed {d}\n--- reference\n{s}\n--- coalescing\n{s}\n", .{ seed, reference.text.items, candidate.text.items });
        return error.TestUnexpectedResult;
    }
}

test "coalesced writes are indistinguishable from inline writes (random scenarios)" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    const seeds: u64 = if (std.process.getEnvVarOwned(a, "LIVE_COALESCE_SEEDS")) |text| blk: {
        defer a.free(text);
        break :blk std.fmt.parseInt(u64, text, 10) catch 2_000;
    } else |_| 2_000;
    for (0..seeds) |seed| try checkSeed(seed);
}

test "the drain's next frame shares its predecessor's write" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    var loop: TestLoop = undefined;
    loop.init();
    var db: MessageDb = .{};
    for (&db.sizes) |*size| size.* = 300;
    var listen: NullListen = .{};
    const limits: live.Limits = .{ .heartbeat_ms = 1_000_000, .max_agent_clients = 10, .max_buffered_bytes = 1_048_576, .max_catch_up_ms = 1_800_000, .max_concurrent_catch_ups = 1, .max_total_buffered_bytes = 33_554_432 };
    const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = limits, .batch_size = 500 }, null);
    try server.start();
    var socket: KernelSocket = .{ .capacity = 1_000_000 };
    const peer = server.connectExplorer(socket.socket(), .{ .url = "/messages", .cf_connecting_ip = "10.0.0.1", .remote_address = null });
    const writes_before = socket.writes;
    for ([_]u8{ 1, 2 }) |id| {
        var buf: [64]u8 = undefined;
        var payload: [96]u8 = undefined;
        listen.handler.?.on_notification(listen.handler.?.ctx, live.EXPLORER_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"messageId\":\"{s}\"}}", .{messageId(&buf, id)}));
    }
    loop.loop.lock();
    server.explorer_updates.flush();
    loop.loop.unlock();
    try testing.expectEqual(@as(usize, 3), socket.delivered.items.len); // ready + 2 upserts
    try testing.expectEqual(@as(usize, 1), socket.writes - writes_before);
    try testing.expectEqual(@as(f64, 0), server.metricsSnapshot().outboundPendingBytes);
    server.stop();
    server.onClose(peer);
    loop.pool.deinit();
    server.destroy();
    loop.loop.deinit();
    loop.fake.deinit();
    socket.deinit();
}

test "a client close arriving mid-tick takes effect after the tick's frames are written" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    var loop: TestLoop = undefined;
    loop.init();
    var db: MessageDb = .{};
    for (&db.sizes) |*size| size.* = 300;
    var listen: NullListen = .{};
    const limits: live.Limits = .{ .heartbeat_ms = 1_000_000, .max_agent_clients = 10, .max_buffered_bytes = 1_048_576, .max_catch_up_ms = 1_800_000, .max_concurrent_catch_ups = 1, .max_total_buffered_bytes = 33_554_432 };
    const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = limits, .batch_size = 500 }, null);
    try server.start();
    var socket: KernelSocket = .{ .capacity = 1_000_000 };
    const peer = server.connectExplorer(socket.socket(), .{ .url = "/messages", .cf_connecting_ip = "10.0.0.1", .remote_address = null });
    for ([_]u8{ 1, 2, 3 }) |id| {
        var buf: [64]u8 = undefined;
        var payload: [96]u8 = undefined;
        listen.handler.?.on_notification(listen.handler.?.ctx, live.EXPLORER_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"messageId\":\"{s}\"}}", .{messageId(&buf, id)}));
    }
    // The client's close arrives while the batch is being sent.
    socket.close_next = true;
    loop.loop.lock();
    server.explorer_updates.flush();
    loop.loop.unlock();
    try testing.expectEqual(@as(usize, 4), socket.delivered.items.len); // ready + 3 upserts
    try testing.expectEqual(@as(usize, 0), socket.refused);
    try testing.expect(socket.close_arrived);
    // Then the close is processed (in tick order); later sends see CLOSING.
    loop.loop.lock();
    socket.settleClose();
    loop.loop.unlock();
    try testing.expect(!socket.open);
    server.stop();
    server.onClose(peer);
    loop.pool.deinit();
    server.destroy();
    loop.loop.deinit();
    loop.fake.deinit();
    socket.deinit();
}
