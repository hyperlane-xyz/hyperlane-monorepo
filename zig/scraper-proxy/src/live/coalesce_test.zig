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
    /// Stream tasks write from pool threads while the test thread refreshes.
    mutex: std.Thread.Mutex = .{},
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
    /// When a write leaves a frame queued, ws finishes it from another
    /// thread at once (the client reads), before the writing turn's
    /// callbacks run (the writer pauses 20 ms after the write).
    async_complete: bool = false,
    async_thread: ?std.Thread = null,
    /// Node's view of this socket (the oracle the server's own accounting
    /// is checked against; the rules measured on real Node, see
    /// IMPLEMENTATION.md "Node's write requests"): every live frame queued
    /// here (not written whole at once) belongs to a write request. A frame
    /// queued while none is in flight is its own request; frames queued
    /// while one is form the next one, written together when it ends. A
    /// request leaves Node's `bufferedAmount` (writable length) and
    /// `pendingBytes` only once all its frames are written, in one go with
    /// every later request already written whole by then.
    node_requests: std.ArrayList(NodeRequest) = .empty,
    node_base: u64 = 0,
    /// The kernel fills up once this many frames were delivered.
    stall_at: ?usize = null,
    /// Pings the server sent.
    pings: usize = 0,

    const Item = struct { payload: []u8, total: usize, off: usize, job: ?*live.SendJob, control: bool = false, request: u64 = 0 };
    const NodeRequest = struct { frames: usize = 0, done: usize = 0, framed: usize = 0, payload: usize = 0 };

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
        self.node_requests.deinit(a);
        self.close_reason.deinit(a);
    }

    /// Write `total` bytes of a frame: how many the kernel took.
    fn take(self: *KernelSocket, total: usize) usize {
        if (self.stall_at) |at| if (self.delivered.items.len >= at) {
            self.stall_at = null;
            self.capacity = 0;
        };
        const n = @min(self.capacity, total);
        self.capacity -= n;
        return n;
    }

    fn deliver(self: *KernelSocket, payload: []const u8) void {
        self.delivered.append(a, a.dupe(u8, payload) catch unreachable) catch unreachable;
    }

    fn enqueue(self: *KernelSocket, payload: []const u8, off: usize, job: ?*live.SendJob) void {
        const total = framed(payload.len);
        var request: u64 = 0;
        if (job != null) {
            if (self.node_requests.items.len < 2) self.node_requests.append(a, .{}) catch unreachable;
            const last = &self.node_requests.items[self.node_requests.items.len - 1];
            last.frames += 1;
            last.framed += total;
            last.payload += payload.len;
            request = self.node_base + self.node_requests.items.len - 1;
        }
        self.queue.append(a, .{ .payload = a.dupe(u8, payload) catch unreachable, .total = total, .off = off, .job = job, .request = request }) catch unreachable;
        self.buffered += total;
    }

    /// Node's `bufferedAmount` (requests not done, control frames queued)
    /// and `pendingBytes` share for this socket. Mutex held.
    fn nodeView(self: *KernelSocket) struct { buffered: usize, pending: usize } {
        var buffered: usize = 0;
        var pending: usize = 0;
        for (self.node_requests.items) |request| {
            buffered += request.framed;
            pending += request.payload;
        }
        for (self.queue.items) |item| {
            if (item.control) buffered += item.total;
        }
        return .{ .buffered = buffered, .pending = pending };
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
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.closing()) return false;
        self.pong();
        self.enqueue(bytes, 0, job);
        return true;
    }

    fn trySendInline(ptr: *anyopaque, bytes: []const u8, job: *live.SendJob) live.Socket.InlineResult {
        const result = trySendInlineLocked(of(ptr), bytes, job);
        if (result == .partial) of(ptr).completeAsync();
        return result;
    }

    fn completeAsync(self: *KernelSocket) void {
        if (!self.async_complete or self.async_thread != null) return;
        self.async_thread = std.Thread.spawn(.{}, refresh, .{ self, 1_000_000 }) catch unreachable;
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }

    fn joinAsync(self: *KernelSocket) void {
        if (self.async_thread) |thread| thread.join();
        self.async_thread = null;
    }

    fn trySendInlineLocked(self: *KernelSocket, bytes: []const u8, job: *live.SendJob) live.Socket.InlineResult {
        self.mutex.lock();
        defer self.mutex.unlock();
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
        const result = trySendInlineManyLocked(of(ptr), payloads, jobs, required);
        if (result == .done and result.done.queued > 0) of(ptr).completeAsync();
        return result;
    }

    fn trySendInlineManyLocked(self: *KernelSocket, payloads: []const []const u8, jobs: []const *live.SendJob, required: usize) live.Socket.ManyResult {
        self.mutex.lock();
        defer self.mutex.unlock();
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
        const self = of(ptr);
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.buffered;
    }
    fn isOpen(ptr: *anyopaque) bool {
        const self = of(ptr);
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.open and !self.destroyed;
    }
    fn snapshot(ptr: *anyopaque) live.Socket.Snapshot {
        const self = of(ptr);
        self.mutex.lock();
        defer self.mutex.unlock();
        var control: usize = 0;
        for (self.queue.items) |item| {
            if (item.control) control += item.total;
        }
        return .{ .open = self.open and !self.destroyed, .buffered = self.buffered, .control = control };
    }
    fn close(ptr: *anyopaque, code: u16, reason: []const u8) void {
        const self = of(ptr);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.open or self.destroyed) return;
        self.open = false;
        self.close_code = code;
        self.close_reason.appendSlice(a, reason) catch unreachable;
    }
    fn terminate(ptr: *anyopaque) void {
        const self = of(ptr);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.destroyed = true;
        self.open = false;
    }
    /// ws's ping: written at once when nothing is queued and the kernel
    /// takes it, else queued (a control frame, counted in bufferedAmount).
    fn ping(ptr: *anyopaque) void {
        const self = of(ptr);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.destroyed or !self.open) return;
        self.pings += 1;
        if (self.queue.items.len == 0 and self.capacity >= 2) {
            self.capacity -= 2;
            return;
        }
        self.queue.append(a, .{ .payload = a.dupe(u8, "") catch unreachable, .total = 2, .off = 0, .job = null, .control = true }) catch unreachable;
        self.buffered += 2;
    }
    fn release(_: *anyopaque) void {}

    /// The client reads: the kernel takes `capacity` more bytes and ws writes
    /// its queue (completions run here, on the test thread). A destroyed
    /// socket fails what is left.
    fn refresh(self: *KernelSocket, capacity: usize) void {
        // ws writes what the kernel takes now (one flush pass); the
        // completions are reported after it, in order, then the pass ends
        // (outside the socket's lock: they may write again).
        var done: std.ArrayList(struct { job: *live.SendJob, ok: bool }) = .empty;
        defer done.deinit(a);
        self.mutex.lock();
        self.capacity += capacity;
        while (self.queue.items.len > 0) {
            const item = &self.queue.items[0];
            if (!self.destroyed) {
                item.off += self.take(item.total - item.off);
                if (item.off < item.total) break;
                if (!item.control) self.deliver(item.payload);
            }
            const finished = self.queue.orderedRemove(0);
            self.buffered -= finished.total;
            a.free(finished.payload);
            if (finished.job) |job| {
                done.append(a, .{ .job = job, .ok = !self.destroyed }) catch unreachable;
                self.node_requests.items[@intCast(finished.request - self.node_base)].done += 1;
            }
        }
        self.mutex.unlock();
        if (done.items.len == 0) return;
        const peer = done.items[0].job.peer;
        const server = done.items[0].job.server;
        peer.retain();
        for (done.items) |d| d.job.complete(d.ok);
        // The pass's macrotask: requests end for JS (Node's view) here, not
        // when the bytes left: a send made meanwhile still sees one in flight.
        server.loop.lock();
        self.mutex.lock();
        while (self.node_requests.items.len > 0 and self.node_requests.items[0].done == self.node_requests.items[0].frames) {
            _ = self.node_requests.orderedRemove(0);
            self.node_base += 1;
        }
        self.mutex.unlock();
        server.passEndLocked(peer);
        server.loop.unlock();
        peer.releaseUnlocked();
    }
};

/// Canonical message rows: `\x<id>` with a body of a size fixed per id.
const MessageDb = struct {
    sizes: [16]usize = undefined,

    fn db(self: *MessageDb) es.Db {
        return .{ .ctx = self, .query = query, .query_async = @import("test_db.zig").threadAsync(query) };
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

const max_clients = 12;

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
            .max_total_buffered_bytes = r.intRangeAtMost(u64, 1_024, 24_000),
        };
        const clients = r.intRangeAtMost(usize, 1, if (seed % 2 == 1) max_clients else 6);
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
    // Odd seeds write corks on several threads at the turn's end.
    if (scenario.seed % 2 == 1) server.parallel_flush_min = 1;
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
                index,                                                    s.delivered.items.len,      s.buffered,            s.open,
                s.destroyed,                                              s.refused,                  s.close_code,          s.close_reason.items,
                peer.explorer.queue.items.len - peer.explorer.queue_head, peer.explorer.queued_bytes, peer.explorer.sending,
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
    std.debug.print("coalesce differential: {d} seeds clean (0..{d})\n", .{ seeds, seeds -| 1 });
}

test "the drain's next frame shares its predecessor's write" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    var loop: TestLoop = undefined;
    loop.init();
    var db: MessageDb = .{};
    for (&db.sizes) |*size| size.* = 300;
    var listen: NullListen = .{};
    const limits: live.Limits = .{ .heartbeat_ms = 1_000_000, .max_agent_clients = 10, .max_buffered_bytes = 1_048_576, .max_total_buffered_bytes = 33_554_432 };
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
    const limits: live.Limits = .{ .heartbeat_ms = 1_000_000, .max_agent_clients = 10, .max_buffered_bytes = 1_048_576, .max_total_buffered_bytes = 33_554_432 };
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

// ---------------------------------------------------------------------------
// Custom confirmation streams: awaited row writes (TS `sendAndWait`) beside
// corked live rows, heartbeats and awaited live starts, on one or several
// clients. The reference writes every frame inline; both must agree on every
// client-visible outcome, and live's accounting must equal Node's view at
// every settled point.

/// Domain 1 for a zero-confirmation merkle stream: rows 1..H (block n, leaf
/// n) up to the head a `head` step announces, paged by `batch`; message ids
/// `sizes[n % 16]` hex digits long. Live dispatch rows by notification id
/// (`sizes[(id + 8) % 16]`). No live-start checkpoints: every live start is
/// `live_start_unavailable`, and the stream starts at the snapshot's head.
const StreamDb = struct {
    sizes: [16]usize,
    /// Fixed per run so both servers page alike.
    batch: u64,

    fn db(self: *StreamDb) es.Db {
        return .{ .ctx = self, .query = query, .query_async = @import("test_db.zig").threadAsync(query) };
    }

    fn query(ctx: *anyopaque, arena: std.mem.Allocator, sql: []const u8, params: []const json.Value) anyerror![]json.Value {
        const self: *StreamDb = @ptrCast(@alignCast(ctx));
        var rows: std.ArrayList(json.Value) = .empty;
        if (std.mem.indexOf(u8, sql, "SELECT h.domain, h.head_height") != null) {
            try rows.append(arena, try json.parse(arena, "{\"domain\":1,\"head_height\":\"0\",\"indexed_height\":\"0\",\"confirmed_height\":\"0\",\"confirmations\":\"0\",\"height\":null}", .{}));
            return rows.items;
        }
        if (std.mem.indexOf(u8, sql, "\"event_row\".\"id\" = ANY") != null) {
            for (params[0].array) |id_value| {
                const id = std.fmt.parseInt(u32, id_value.string, 10) catch unreachable;
                try rows.append(arena, try self.dispatchRow(arena, id));
            }
            return rows.items;
        }
        if (std.mem.indexOf(u8, sql, "confirmation_events") == null) return &.{};
        const after = try std.fmt.parseInt(u32, params[1].string, 10);
        const through = try std.fmt.parseInt(u32, params[3].string, 10);
        var n = after + 1;
        while (n <= through and rows.items.len < self.batch) : (n += 1) try rows.append(arena, try self.merkleRow(arena, n));
        return rows.items;
    }

    fn hex(self: *StreamDb, arena: std.mem.Allocator, n: u32) ![]u8 {
        const id = try arena.alloc(u8, self.sizes[n % 16]);
        for (id, 0..) |*c, i| c.* = "0123456789abcdef"[(n + i) % 16];
        return id;
    }

    fn merkleRow(self: *StreamDb, arena: std.mem.Allocator, n: u32) !json.Value {
        const text = try std.fmt.allocPrint(arena, "{{\"domain\":1,\"merkle_tree_hook\":\"\\\\x0000000000000000000000000000000000000001\",\"leaf_index\":{d},\"message_id\":\"\\\\x{s}\",\"block_number\":{d},\"block_hash\":null,\"frontier_id\":\"{d}\",\"frontier_height\":\"{d}\"}}", .{ n, try self.hex(arena, n), n, n, n });
        return json.parse(arena, text, .{});
    }

    fn dispatchRow(self: *StreamDb, arena: std.mem.Allocator, id: u32) !json.Value {
        const text = try std.fmt.allocPrint(arena, "{{\"notification_id\":\"{d}\",\"origin_domain\":1,\"destination_domain\":2,\"origin_mailbox\":\"\\\\x0000000000000000000000000000000000000001\",\"nonce\":{d},\"msg_id\":\"\\\\x{s}\"}}", .{ id, 1_000_000 + id, try self.hex(arena, id + 8) });
        return json.parse(arena, text, .{});
    }
};

const SUBSCRIBE_STREAM =
    \\{"type":"subscribe","streams":[{"eventType":"merkle_tree_insertion","domains":[1],"confirmations":0},{"eventType":"dispatch","domains":[1]}]}
;

const MAX_STREAM_CLIENTS = 3;

const StreamScenario = struct {
    seed: u64,
    clients: usize,
    limits: live.Limits,
    db: StreamDb,
    /// Corks to many peers are written from pool threads.
    parallel: bool,
    steps: []const Step,

    const Step = union(enum) {
        /// `client == clients`: every client reads.
        refresh: struct { client: usize, bytes: u32 },
        fail: usize,
        /// The stream's head moves to this height (rows up to it are read).
        head: u32,
        /// Live dispatch notifications (ids), then the agent batch drain.
        live: struct { first: u32, count: u8 },
        /// Loop time passes (heartbeats; every client pongs afterwards).
        tick: u32,
    };

    fn generate(seed: u64, steps: *std.ArrayList(Step)) StreamScenario {
        var prng = std.Random.DefaultPrng.init(seed);
        const r = prng.random();
        var sizes: [16]usize = undefined;
        for (&sizes) |*size| size.* = 2 * r.intRangeAtMost(usize, 1, 600);
        const clients: usize = if (seed % 4 == 0) r.intRangeAtMost(usize, 2, MAX_STREAM_CLIENTS) else 1;
        const limits: live.Limits = .{
            // Every third seed: heartbeats (ping + frame) as the clock steps
            // (clients pong after each step, so none is terminated). The
            // model's ping/pong follow real Node (live-c4/tools/node-pong.mjs:
            // an inline control frame leaves bufferedAmount at once; a queued
            // one counts until it is written).
            .heartbeat_ms = if (seed % 3 == 1) 500 + (seed % 7) * 100 else 1_000_000,
            .max_agent_clients = 10,
            .max_buffered_bytes = r.intRangeAtMost(u64, 1_024, 8_000),
            .max_total_buffered_bytes = r.intRangeAtMost(u64, 1_024, 16_000) * clients,
        };
        // The live starts go out first: one awaiting task per client after.
        steps.append(a, .{ .refresh = .{ .client = clients, .bytes = 1_000_000 } }) catch unreachable;
        const count = r.intRangeAtMost(usize, 3, 40);
        var live_id: u32 = 1;
        var head: u32 = 0;
        for (0..count) |_| {
            const step: Step = switch (r.intRangeLessThan(u8, 0, 12)) {
                0...4 => .{ .refresh = .{ .client = r.intRangeAtMost(usize, 0, clients), .bytes = r.intRangeAtMost(u32, 0, 4_000) } },
                5, 6 => blk: {
                    head += r.intRangeAtMost(u32, 1, 12);
                    break :blk .{ .head = head };
                },
                7, 8 => blk: {
                    const n = r.intRangeAtMost(u8, 1, 3);
                    defer live_id += n;
                    break :blk .{ .live = .{ .first = live_id, .count = n } };
                },
                9 => .{ .fail = r.intRangeLessThan(usize, 0, clients) },
                else => .{ .tick = r.intRangeAtMost(u32, 1, 600) },
            };
            steps.append(a, step) catch unreachable;
        }
        steps.append(a, .{ .refresh = .{ .client = clients, .bytes = 1_000_000 } }) catch unreachable;
        return .{
            .seed = seed,
            .clients = clients,
            .limits = limits,
            .db = .{ .sizes = sizes, .batch = r.intRangeAtMost(u64, 1, 12) },
            .parallel = clients > 1 and seed % 8 == 0,
            .steps = steps.items,
        };
    }
};

/// At a settled point, live's view equals Node's: its `bufferedAmount`
/// mirror is what the kernel model still holds (queued frames counted whole,
/// control frames included), and the aggregate charge is exactly the queued
/// frames that have a completion to come.
fn expectNodeView(server: *live.Server, peers: []const *live.Peer, sockets: []const *KernelSocket) !void {
    server.loop.lock();
    defer server.loop.unlock();
    var pending: usize = 0;
    for (peers, sockets) |peer, socket| {
        socket.mutex.lock();
        defer socket.mutex.unlock();
        const node = socket.nodeView();
        pending += node.pending;
        if (socket.destroyed) continue;
        var control: usize = 0;
        for (socket.queue.items) |item| {
            if (item.control) control += item.total;
        }
        const live_buffered = peer.node_buffered.load(.monotonic) + control;
        if (live_buffered != node.buffered) {
            std.debug.print("bufferedAmount: live {d}, Node {d}\n", .{ live_buffered, node.buffered });
            return error.TestUnexpectedResult;
        }
    }
    const live_pending = server.pending_bytes.load(.monotonic);
    if (live_pending != pending) {
        std.debug.print("pendingBytes: live {d}, Node {d}\n", .{ live_pending, pending });
        return error.TestUnexpectedResult;
    }
}

/// "Settled" must hold for a while (a few checks over at least 1 ms of wall
/// time), whatever the timer granularity: in Linux containers a 50 µs sleep
/// takes milliseconds, and a count of sleeps made these tests crawl there.
/// `quiesceAll` for one socket.
fn quiesce(t: *TestLoop, server: *live.Server, socket: *KernelSocket) void {
    quiesceAll(t, server, &.{socket});
}

/// Seconds a quiesce may take before the test panics (Node cases lower it:
/// a wrong release rule leaves a task waiting forever).
var settle_limit_s: i128 = 60;

const Stability = struct {
    since: ?i128 = null,
    checks: usize = 0,
    deadline: i128 = 0,

    fn settled(self: *Stability, now_settled: bool) bool {
        const now = std.time.nanoTimestamp();
        if (self.deadline == 0) self.deadline = now + settle_limit_s * std.time.ns_per_s;
        if (now > self.deadline) @panic("stream did not settle");
        if (!now_settled) {
            self.since = null;
            self.checks = 0;
        } else {
            if (self.since == null) self.since = now;
            self.checks += 1;
            if (self.checks >= 4 and now - self.since.? >= std.time.ns_per_ms) return true;
        }
        // Yield, not sleep: sleeps round up to a millisecond or more there.
        std.Thread.yield() catch {};
        return false;
    }
};

/// Every pool thread is idle or parked on an awaited frame (queued, or
/// written while the rest of its Node request is not), and nothing is queued.
fn quiesceAll(t: *TestLoop, server: *live.Server, sockets: []const *KernelSocket) void {
    var stable: Stability = .{};
    var waiters: std.AutoHashMapUnmanaged(*anyopaque, void) = .empty;
    defer waiters.deinit(a);
    var peers: std.AutoArrayHashMapUnmanaged(*live.Peer, void) = .empty;
    defer peers.deinit(a);
    while (true) {
        t.loop.lock();
        waiters.clearRetainingCapacity();
        // (Peers still connected, and those of frames still queued.)
        peers.clearRetainingCapacity();
        for (server.clients.keys()) |peer| peers.put(a, peer, {}) catch unreachable;
        for (sockets) |socket| {
            socket.mutex.lock();
            for (socket.queue.items) |item| {
                if (item.job) |job| peers.put(a, job.peer, {}) catch unreachable;
            }
            socket.mutex.unlock();
        }
        for (peers.keys()) |peer| {
            for (peer.requests.items) |request| for (request.jobs.items) |job| {
                if (job.kind == .waiter) waiters.put(a, @ptrCast(job.kind.waiter), {}) catch unreachable;
            };
        }
        t.pool.mutex.lock();
        const pool_idle = t.pool.head == t.pool.queue.items.len and t.pool.idle + waiters.count() == t.pool.threads;
        t.pool.mutex.unlock();
        // No `query_async` read in flight or awaiting its continuation.
        server.async_mutex.lock();
        const reads_idle = server.async_outstanding == 0 and server.finished_reads.items.len == 0 and !server.reads_draining;
        server.async_mutex.unlock();
        const idle_exactly = pool_idle and reads_idle;
        t.loop.unlock();
        if (stable.settled(idle_exactly)) return;
    }
}

fn notifyHead(listen: *NullListen, height: u32) !void {
    var payload: [128]u8 = undefined;
    const text = try std.fmt.bufPrint(&payload, "{{\"domain\":1,\"confirmedHeight\":\"0\",\"headHeight\":\"{d}\",\"indexedHeight\":\"{d}\"}}", .{ height, height });
    listen.handler.?.on_notification(listen.handler.?.ctx, live.HEAD_CHANNEL, text);
}

fn notifyDispatch(listen: *NullListen, id: usize) !void {
    var payload: [96]u8 = undefined;
    const text = try std.fmt.bufPrint(&payload, "{{\"eventType\":\"dispatch\",\"id\":\"{d}\",\"domain\":1}}", .{id});
    listen.handler.?.on_notification(listen.handler.?.ctx, live.EVENT_CHANNEL, text);
}

/// The head drain (`confirmationUpdates`) and the agent drain, now.
fn flushWorkers(loop: *TestLoop, server: *live.Server) void {
    loop.loop.lock();
    server.confirmation_updates.flush();
    server.agent_notifications.flush();
    loop.loop.unlock();
}

fn runStream(scenario: StreamScenario, coalesce: bool, trace: *Trace) !void {
    var loop: TestLoop = undefined;
    loop.init();
    var db = scenario.db;
    var listen: NullListen = .{};
    const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = scenario.limits, .batch_size = db.batch }, null);
    server.coalesce = coalesce;
    if (scenario.parallel) server.parallel_flush_min = 1;
    try server.start();
    const n = scenario.clients;
    var sockets: [MAX_STREAM_CLIENTS]KernelSocket = @splat(.{});
    var socket_ptrs: [MAX_STREAM_CLIENTS]*KernelSocket = undefined;
    var peers: [MAX_STREAM_CLIENTS]*live.Peer = undefined;
    for (0..n) |i| {
        socket_ptrs[i] = &sockets[i];
        sockets[i].capacity = 1_000_000; // the ready frame
        peers[i] = server.connectAgent(sockets[i].socket());
        sockets[i].capacity = 0;
    }
    const all = socket_ptrs[0..n];
    for (peers[0..n]) |peer| server.onMessage(peer, SUBSCRIBE_STREAM);
    quiesceAll(&loop, server, all);
    const w = trace.text.writer(a);
    const failures = &core.metrics.websocket_send_failures;
    const base = .{ failures.get(.{"buffer_limit"}), failures.get(.{"send_error"}) };
    for (scenario.steps, 0..) |step, step_index| {
        switch (step) {
            .refresh => |r| if (r.client == n) {
                for (all) |socket| socket.refresh(r.bytes);
            } else sockets[r.client].refresh(r.bytes),
            .fail => |client| sockets[client].fail_next = true,
            .head => |height| {
                try notifyHead(&listen, height);
                flushWorkers(&loop, server);
            },
            .live => |l| {
                for (l.first..l.first + l.count) |id| try notifyDispatch(&listen, id);
                flushWorkers(&loop, server);
            },
            .tick => |ms| {
                loop.fake.tick(ms);
                for (peers[0..n]) |peer| server.onPong(peer);
            },
        }
        quiesceAll(&loop, server, all);
        try expectNodeView(server, peers[0..n], all);
        loop.loop.lock();
        const snapshot = server.metricsSnapshot();
        try w.print("step {d} pending={d} connections={d} failures={d}/{d}\n", .{
            step_index,
            snapshot.outboundPendingBytes,
            snapshot.connections.agent,
            failures.get(.{"buffer_limit"}) - base[0],
            failures.get(.{"send_error"}) - base[1],
        });
        for (all, 0..) |s, i| try w.print("  client {d} delivered={d} buffered={d} open={} destroyed={} close={?d}:{s}\n", .{
            i, s.delivered.items.len, s.buffered, s.open, s.destroyed, s.close_code, s.close_reason.items,
        });
        loop.loop.unlock();
    }
    // Delivered frames per client, in order.
    for (all, 0..) |s, i| {
        try w.print("client {d} frames:", .{i});
        for (s.delivered.items) |payload| try w.print(" {x}", .{std.hash.Wyhash.hash(0, payload)});
        try w.writeByte('\n');
    }
    for (all) |s| {
        s.destroyed = true;
        s.refresh(0);
    }
    quiesceAll(&loop, server, all);
    server.stop();
    for (peers[0..n]) |peer| server.onClose(peer);
    loop.pool.deinit();
    server.destroy();
    loop.loop.deinit();
    loop.fake.deinit();
    for (all) |s| s.deinit();
}

fn checkStreamSeed(seed: u64) !void {
    var steps: std.ArrayList(StreamScenario.Step) = .empty;
    defer steps.deinit(a);
    const scenario = StreamScenario.generate(seed, &steps);
    var reference: Trace = .{};
    defer reference.deinit();
    var candidate: Trace = .{};
    defer candidate.deinit();
    const same = std.process.hasEnvVarConstant("LIVE_STREAM_SELFCHECK");
    runStream(scenario, false, &reference) catch |err| {
        std.debug.print("stream seed {d} (reference)\n", .{seed});
        return err;
    };
    runStream(scenario, !same, &candidate) catch |err| {
        std.debug.print("stream seed {d} (coalescing)\n", .{seed});
        return err;
    };
    if (!std.mem.eql(u8, reference.text.items, candidate.text.items)) {
        std.debug.print("coalesced stream writes differ from inline writes, seed {d}\n--- scenario\n", .{seed});
        printStreamScenario(scenario);
        std.debug.print("--- reference\n{s}\n--- coalescing\n{s}\n", .{ reference.text.items, candidate.text.items });
        return error.TestUnexpectedResult;
    }
}

fn printStreamScenario(scenario: StreamScenario) void {
    const l = scenario.limits;
    std.debug.print("clients={d} parallel={} limits buffered={d} total={d} heartbeat={d}; batch={d} sizes={any}\n", .{ scenario.clients, scenario.parallel, l.max_buffered_bytes, l.max_total_buffered_bytes, l.heartbeat_ms, scenario.db.batch, scenario.db.sizes });
    for (scenario.steps, 0..) |step, i| std.debug.print("step {d}: {any}\n", .{ i, step });
}

test "custom stream writes, live rows and heartbeats: coalesced equals inline (random scenarios)" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    const seeds: u64 = if (std.process.getEnvVarOwned(a, "LIVE_STREAM_SEEDS")) |text| blk: {
        defer a.free(text);
        break :blk std.fmt.parseInt(u64, text, 10) catch 300;
    } else |_| 300;
    // LIVE_STREAM_ONLY=<seed>[,<repeat>]: that seed only (reproducing a failure).
    if (std.process.getEnvVarOwned(a, "LIVE_STREAM_ONLY")) |text| {
        defer a.free(text);
        var parts = std.mem.splitScalar(u8, text, ',');
        const seed = try std.fmt.parseInt(u64, parts.first(), 10);
        const repeat = if (parts.next()) |r| try std.fmt.parseInt(u64, r, 10) else 1;
        for (0..repeat) |_| try checkStreamSeed(seed);
        std.debug.print("stream differential: seed {d} clean {d} times\n", .{ seed, repeat });
        return;
    } else |_| {}
    for (0..seeds) |seed| try checkStreamSeed(seed);
    std.debug.print("stream differential: {d} seeds clean (0..{d}; several clients every 4th)\n", .{ seeds, seeds -| 1 });
}

test "a lookahead frame written early does not count against another drain's check" {
    // B's next frame cannot join its cork (per-socket bound), so B's drain
    // sends it from B's callback, which runs before A's: A's lookahead frame
    // (if written early) is not charged in Node yet. Same outcome as Node's
    // inline writes either way.
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    const setup: DrainSetup = .{ .sizes = .{ 300, 1_100, 300, 800 }, .max_buffered = 1_500, .max_total = 2_000 };
    var reference_setup = setup;
    reference_setup.coalesce = false;
    const reference = try runDrains(reference_setup);
    const coalesced = try runDrains(setup);
    try testing.expectEqual(reference.delivered, coalesced.delivered);
    try testing.expectEqual(reference.destroyed, coalesced.destroyed);
    try testing.expectEqual(@as(f64, 0), coalesced.pending);
}

// ---------------------------------------------------------------------------
// Two Explorer drains flushed together (parallel flush): the first peer's
// messages 0, 1, the second's 2, 3; each drain's second frame is a lookahead
// candidate.

const DrainSetup = struct {
    sizes: [4]usize,
    max_buffered: u64 = 1 << 30,
    max_total: u64 = 1 << 30,
    coalesce: bool = true,
    /// Bytes the second peer's kernel takes before the client reads.
    second_capacity: usize = 1_000_000,
    /// ...and ws finishes a frame it queues from another thread at once.
    second_async: bool = false,
};

const DrainResult = struct {
    delivered: [2]usize,
    destroyed: [2]bool,
    /// Payload lengths of messages 0..3 as delivered.
    lens: [4]usize,
    pending: f64,
};

fn runDrains(setup: DrainSetup) !DrainResult {
    var loop: TestLoop = undefined;
    loop.init();
    var db: MessageDb = .{};
    for (&db.sizes, 0..) |*size, i| size.* = if (i < 4) setup.sizes[i] else 10;
    var listen: NullListen = .{};
    const limits: live.Limits = .{ .heartbeat_ms = 1_000_000, .max_agent_clients = 10, .max_buffered_bytes = setup.max_buffered, .max_total_buffered_bytes = setup.max_total };
    const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = limits, .batch_size = 500 }, null);
    server.coalesce = setup.coalesce;
    server.parallel_flush_min = 1;
    try server.start();
    var ids: [4][64]u8 = undefined;
    for (&ids, 0..) |*buf, i| _ = messageId(buf, i);
    var sockets: [2]KernelSocket = .{ .{ .capacity = 1_000_000 }, .{ .capacity = 1_000_000 } };
    var urls: [2][200]u8 = undefined;
    var peers: [2]*live.Peer = undefined;
    for (&peers, 0..) |*peer, p| {
        const url = try std.fmt.bufPrint(&urls[p], "/messages?messageIds=0x{s},0x{s}", .{ ids[2 * p], ids[2 * p + 1] });
        const ip = if (p == 0) "10.0.0.1" else "10.0.0.2";
        peer.* = server.connectExplorer(sockets[p].socket(), .{ .url = url, .cf_connecting_ip = ip, .remote_address = null });
    }
    sockets[1].capacity = setup.second_capacity;
    sockets[1].async_complete = setup.second_async;
    for ([_]usize{ 0, 2, 1, 3 }) |id| {
        var payload: [96]u8 = undefined;
        listen.handler.?.on_notification(listen.handler.?.ctx, live.EXPLORER_CHANNEL, try std.fmt.bufPrint(&payload, "{{\"messageId\":\"{s}\"}}", .{ids[id]}));
    }
    loop.loop.lock();
    server.explorer_updates.flush();
    loop.loop.unlock();
    sockets[1].joinAsync();
    // The clients read everything (drains continue from completions).
    for (0..10) |_| for (&sockets) |*socket| socket.refresh(1_000_000);
    var result: DrainResult = .{ .delivered = undefined, .destroyed = undefined, .lens = @splat(0), .pending = 0 };
    loop.loop.lock();
    result.pending = server.metricsSnapshot().outboundPendingBytes;
    loop.loop.unlock();
    for (&sockets, 0..) |*socket, p| {
        result.delivered[p] = socket.delivered.items.len -| 1; // after `ready`
        result.destroyed[p] = socket.destroyed or !socket.open;
        for (socket.delivered.items[@min(1, socket.delivered.items.len)..], 0..) |payload, k| {
            if (k < 2) result.lens[2 * p + k] = payload.len;
        }
    }
    server.stop();
    for (peers) |peer| server.onClose(peer);
    loop.pool.deinit();
    server.destroy();
    loop.loop.deinit();
    loop.fake.deinit();
    for (&sockets) |*socket| socket.deinit();
    return result;
}

test "a drain whose lookahead was refused still counts against another drain's lookahead" {
    // The first drain's next frame does not fit beside its own cork, so it is
    // not written early, but its callback (first) sends it once the cork is
    // written. Node charges it before the second drain's callback, whose next
    // frame then exceeds the aggregate limit.
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    const sizes = [4]usize{ 100, 1_000, 100, 400 };
    const probe = try runDrains(.{ .sizes = sizes, .coalesce = false });
    const l = probe.lens;
    const max_buffered = framed(l[0]) + l[1] - 1;
    const max_total = l[1] + l[3] - 1;
    // Preconditions: the first lookahead is refused per socket, the second
    // passes per socket, and the second passes against the charges alone.
    try testing.expect(max_buffered >= l[1] and max_buffered >= framed(l[2]) + l[3]);
    try testing.expect(l[0] + l[2] + l[3] <= max_total and l[1] + l[2] <= max_total);
    const reference = try runDrains(.{ .sizes = sizes, .max_buffered = max_buffered, .max_total = max_total, .coalesce = false });
    try testing.expect(reference.destroyed[1] and !reference.destroyed[0]); // the scenario bites
    const coalesced = try runDrains(.{ .sizes = sizes, .max_buffered = max_buffered, .max_total = max_total });
    try testing.expectEqual(reference.delivered, coalesced.delivered);
    try testing.expectEqual(reference.destroyed, coalesced.destroyed);
    try testing.expectEqual(@as(f64, 0), coalesced.pending);
}

test "a partly written lookahead finished by ws before the callbacks is released after its turn" {
    // The second drain's next frame is written early but the kernel stops
    // inside it; ws finishes it from another thread before the first drain's
    // callback runs that drain's (checked) next send.
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    const sizes = [4]usize{ 600, 600, 50, 900 };
    const probe = try runDrains(.{ .sizes = sizes, .coalesce = false });
    const l = probe.lens;
    const max_buffered = @max(l[1], framed(l[2]) + l[3]);
    try testing.expect(framed(l[0]) + l[1] > max_buffered); // first lookahead refused
    const capacity = framed(l[2]) + 5; // the kernel stops inside the next frame
    const reference = try runDrains(.{ .sizes = sizes, .max_buffered = max_buffered, .coalesce = false, .second_capacity = capacity, .second_async = true });
    const coalesced = try runDrains(.{ .sizes = sizes, .max_buffered = max_buffered, .second_capacity = capacity, .second_async = true });
    try testing.expectEqual([2]usize{ 2, 2 }, reference.delivered);
    try testing.expectEqual(reference.delivered, coalesced.delivered);
    try testing.expectEqual(reference.destroyed, coalesced.destroyed);
    try testing.expectEqual(@as(f64, 0), coalesced.pending);
}

// ---------------------------------------------------------------------------
// Node's write requests, checked against real Node (node-order.mjs; see
// IMPLEMENTATION.md "Node's write requests"): a custom stream's awaited row
// f1 is in flight, live frames f2 and f3 are sent meanwhile (one batch behind
// it), then the client reads. What the row's continuation (its next send)
// sees of bufferedAmount and pendingBytes must be what Node's continuation
// sees.

const NodeCase = struct {
    /// Payload sizes: stream rows 1, 2 (f1, then the next row; row 3 is
    /// small) and the
    /// live dispatch rows f2, f3 (`StreamDb` sizes).
    f1: usize,
    f2: usize,
    f3: usize,
    /// What the client reads: everything, or up to the middle of f2 or f3.
    drain: enum { all, into_f2, into_f3 },
    /// Then (the batch still in flight, the next row queued behind it) the
    /// client reads everything (node-order2 "cont").
    then_all: bool = false,
    /// Instead of reading: the socket is destroyed (node-order2 "destroy").
    destroy: bool = false,
    coalesce: bool,
};

const NodeObservation = struct { buffered: usize, pending: usize };

const NodeCaseResult = struct {
    /// At the row's continuations (its next sends), in order.
    seen: [2]?NodeObservation = .{ null, null },
    /// Framed and payload bytes of f2 + f3.
    batch_framed: usize = 0,
    batch_payload: usize = 0,
    send_errors: f64 = 0,
    pending_after: usize = 0,
};

const Observer = struct {
    mutex: std.Thread.Mutex = .{},
    armed: bool = false,
    seen: std.ArrayList(NodeObservation) = .empty,

    fn observe(ctx: *anyopaque, buffered: usize, pending: usize) void {
        const self: *Observer = @ptrCast(@alignCast(ctx));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (!self.armed) return;
        self.armed = false;
        self.seen.append(a, .{ .buffered = buffered, .pending = pending }) catch unreachable;
    }

    fn arm(self: *Observer) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.armed = true;
    }
};

fn runNodeCase(case: NodeCase) !NodeCaseResult {
    settle_limit_s = 5;
    defer settle_limit_s = 60;
    var loop: TestLoop = undefined;
    loop.init();
    var sizes: [16]usize = @splat(100);
    sizes[1] = case.f1;
    sizes[2] = case.f1;
    sizes[9] = case.f2; // dispatch notification 1
    sizes[10] = case.f3; // dispatch notification 2
    var db: StreamDb = .{ .sizes = sizes, .batch = 8 };
    var listen: NullListen = .{};
    const limits: live.Limits = .{ .heartbeat_ms = 1_000_000, .max_agent_clients = 10, .max_buffered_bytes = 1 << 30, .max_total_buffered_bytes = 1 << 30 };
    const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = limits, .batch_size = db.batch }, null);
    server.coalesce = case.coalesce;
    var observer: Observer = .{};
    defer observer.seen.deinit(a);
    server.send_observer = .{ .ctx = &observer, .func = Observer.observe };
    try server.start();
    var socket: KernelSocket = .{ .capacity = 1_000_000 };
    const peer = server.connectAgent(socket.socket());
    // ready, subscribed and the live starts go out whole.
    server.onMessage(peer, SUBSCRIBE_STREAM);
    quiesce(&loop, server, &socket);
    // f1: the stream's first row, sent with the kernel full (in flight alone).
    // Rows 2 and 3 follow, each from its predecessor's continuation (the
    // observed sends).
    socket.mutex.lock();
    socket.capacity = 0;
    socket.mutex.unlock();
    try notifyHead(&listen, 3);
    flushWorkers(&loop, server);
    quiesce(&loop, server, &socket);
    // f2, f3: live rows sent while f1 is in flight.
    for (1..3) |id| try notifyDispatch(&listen, id);
    flushWorkers(&loop, server);
    quiesce(&loop, server, &socket);
    var result: NodeCaseResult = .{};
    socket.mutex.lock();
    // f1, f2, f3
    const f1_index: usize = 0;
    try testing.expectEqual(@as(usize, 3), socket.queue.items.len);
    try testing.expect(socket.queue.items[0].job.?.kind == .waiter);
    var before_f2: usize = 0;
    for (socket.queue.items[0 .. f1_index + 1]) |item| before_f2 += item.total - item.off;
    const f2 = socket.queue.items[f1_index + 1];
    const f3 = socket.queue.items[f1_index + 2];
    result.batch_framed = f2.total + f3.total;
    result.batch_payload = f2.payload.len + f3.payload.len;
    socket.mutex.unlock();
    const base_errors = core.metrics.websocket_send_failures.get(.{"send_error"});
    observer.arm();
    if (case.destroy) {
        socket.mutex.lock();
        socket.destroyed = true;
        socket.open = false;
        socket.mutex.unlock();
        socket.refresh(0);
    } else socket.refresh(switch (case.drain) {
        .all => before_f2 + f2.total + f3.total,
        .into_f2 => before_f2 + f2.total / 2,
        .into_f3 => before_f2 + f2.total + f3.total / 2,
    });
    quiesce(&loop, server, &socket);
    if (case.then_all) {
        observer.arm();
        socket.refresh(1 << 30);
        quiesce(&loop, server, &socket);
    }
    observer.mutex.lock();
    for (observer.seen.items, 0..) |seen, i| {
        if (i < 2) result.seen[i] = seen;
    }
    observer.mutex.unlock();
    result.send_errors = core.metrics.websocket_send_failures.get(.{"send_error"}) - base_errors;
    socket.destroyed = true;
    socket.refresh(0);
    quiesce(&loop, server, &socket);
    // A destroyed socket's frames have all completed: nothing may be left
    // (a task waiting on one would never return).
    loop.loop.lock();
    const outstanding = peer.requests.items.len;
    loop.loop.unlock();
    if (outstanding != 0) @panic("Node requests outstanding after the socket was destroyed");
    result.pending_after = server.pending_bytes.load(.monotonic);
    server.stop();
    server.onClose(peer);
    loop.pool.deinit();
    server.destroy();
    loop.loop.deinit();
    loop.fake.deinit();
    socket.deinit();
    return result;
}

test "Node (a): a batch written whole with the awaited frame is released before its continuation" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    for ([_]bool{ false, true }) |coalesce| {
        // node-order.mjs 8000000 100 100: continuation buffered=0 pending=0.
        const r = try runNodeCase(.{ .f1 = 4000, .f2 = 100, .f3 = 100, .drain = .all, .coalesce = coalesce });
        try testing.expectEqual(NodeObservation{ .buffered = 0, .pending = 0 }, r.seen[0].?);
        // big1: a batch frame of 1 MB that the kernel takes whole: the same.
        const big = try runNodeCase(.{ .f1 = 4000, .f2 = 1_000_000, .f3 = 100, .drain = .all, .coalesce = coalesce });
        try testing.expectEqual(NodeObservation{ .buffered = 0, .pending = 0 }, big.seen[0].?);
    }
}

test "Node (b), (c): a batch not written whole stays counted whole after the continuation" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    for ([_]bool{ false, true }) |coalesce| {
        // node-order.mjs 8000000 3000000 3000000: continuation buffered=6000020 pending=6000000.
        const b = try runNodeCase(.{ .f1 = 4000, .f2 = 3000, .f3 = 3000, .drain = .into_f2, .coalesce = coalesce });
        try testing.expectEqual(NodeObservation{ .buffered = b.batch_framed, .pending = b.batch_payload }, b.seen[0].?);
        // node-order.mjs 8000000 100 3000000: f2, written whole, still counted with f3.
        const c = try runNodeCase(.{ .f1 = 4000, .f2 = 100, .f3 = 3000, .drain = .into_f3, .coalesce = coalesce });
        try testing.expectEqual(NodeObservation{ .buffered = c.batch_framed, .pending = c.batch_payload }, c.seen[0].?);
        try testing.expectEqual(@as(usize, 0), c.pending_after);
    }
}

test "Node cont: a frame sent while the batch is in flight is released with it when written whole" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    for ([_]bool{ false, true }) |coalesce| {
        // node-order2.mjs cont: f4 (here the stream's next row) is written as soon as
        // the batch ends; its continuation sees nothing left.
        const r = try runNodeCase(.{ .f1 = 4000, .f2 = 3000, .f3 = 3000, .drain = .into_f2, .then_all = true, .coalesce = coalesce });
        try testing.expectEqual(NodeObservation{ .buffered = r.batch_framed, .pending = r.batch_payload }, r.seen[0].?);
        try testing.expectEqual(NodeObservation{ .buffered = 0, .pending = 0 }, r.seen[1].?);
    }
}

test "Node destroy: every queued frame fails in order, nothing stays counted" {
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    for ([_]bool{ false, true }) |coalesce| {
        // node-order2.mjs destroy: callbacks with errors, continuation 0/0
        // (no next send: the stream stops); one send failure.
        const r = try runNodeCase(.{ .f1 = 4000, .f2 = 100, .f3 = 3000, .drain = .all, .destroy = true, .coalesce = coalesce });
        try testing.expect(r.seen[0] == null);
        try testing.expectEqual(@as(usize, 0), r.pending_after);
        try testing.expect(r.send_errors <= 1);
    }
}

test "a timer due when an awaited frame completes runs after that frame's continuation" {
    // Node runs the continuations a macrotask resolved (microtasks) before
    // any timer: the rows a custom stream sends on resuming precede the
    // heartbeat that fell due at the same moment.
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    for ([_]bool{ false, true }) |coalesce| {
        var loop: TestLoop = undefined;
        loop.init();
        var db: StreamDb = .{ .sizes = @splat(300), .batch = 8 };
        var listen: NullListen = .{};
        const limits: live.Limits = .{ .heartbeat_ms = 1_000, .max_agent_clients = 10, .max_buffered_bytes = 1 << 30, .max_total_buffered_bytes = 1 << 30 };
        const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = limits, .batch_size = db.batch }, null);
        server.coalesce = coalesce;
        try server.start();
        var socket: KernelSocket = .{ .capacity = 1_000_000 };
        const peer = server.connectAgent(socket.socket());
        server.onMessage(peer, SUBSCRIBE_STREAM);
        quiesce(&loop, server, &socket);
        socket.mutex.lock();
        socket.capacity = 0; // row 1 waits
        socket.mutex.unlock();
        try notifyHead(&listen, 3);
        flushWorkers(&loop, server);
        quiesce(&loop, server, &socket);
        socket.refresh(1 << 20); // row 1 written: its continuation is due
        loop.fake.tick(1_000); // and so is the heartbeat
        quiesce(&loop, server, &socket);
        var heartbeat: ?usize = null;
        var last_row: ?usize = null;
        for (socket.delivered.items, 0..) |payload, i| {
            if (heartbeat == null and std.mem.indexOf(u8, payload, "\"type\":\"heartbeat\"") != null) heartbeat = i;
            if (std.mem.indexOf(u8, payload, "\"leaf_index\":3") != null) last_row = i;
        }
        try testing.expect(heartbeat != null and last_row != null);
        try testing.expect(last_row.? < heartbeat.?);
        server.stop();
        server.onClose(peer);
        loop.pool.deinit();
        server.destroy();
        loop.loop.deinit();
        loop.fake.deinit();
        socket.deinit();
    }
}

test "a heartbeat while a stream row is partly written queues behind it, in Node's order and counts" {
    // Fake clock: a custom stream's first row is in flight (partly written);
    // the heartbeat's ping and frame are sent meanwhile (behind it, one
    // batch in Node). The client then reads up to the end of the row, then
    // everything: the wire order, and live's bufferedAmount / pendingBytes
    // against the model's Node view after each step. Real Node
    // (live-c4/tools/node-heartbeat.mjs, ws 8.21.3): client order "f1, ping,
    // heartbeat, f2 (sent in f1's continuation)"; with f1 in flight the ping
    // adds 2 bytes to bufferedAmount and the heartbeat its framed length,
    // pendingBytes only the heartbeat's payload; a batch not yet written
    // stays counted (30 MB heartbeat: f1 continuation buffered=30000012
    // pending=30000000). (Node also keeps the ping counted until its whole
    // batch is written; ws drops it once its own bytes are out: this test
    // reads at the batch's start, before that differs; see DEVIATIONS.)
    core.log.setSink(discard, null);
    defer core.log.setSink(null, null);
    for ([_]bool{ false, true }) |coalesce| {
        var loop: TestLoop = undefined;
        loop.init();
        var db: StreamDb = .{ .sizes = @splat(2000), .batch = 8 };
        var listen: NullListen = .{};
        const limits: live.Limits = .{ .heartbeat_ms = 1_000, .max_agent_clients = 10, .max_buffered_bytes = 1 << 30, .max_total_buffered_bytes = 1 << 30 };
        const server = try live.Server.create(a, &loop.loop, db.db(), listen.api(), .{ .limits = limits, .batch_size = db.batch }, null);
        server.coalesce = coalesce;
        try server.start();
        var socket: KernelSocket = .{ .capacity = 1_000_000 };
        const peer = server.connectAgent(socket.socket());
        server.onMessage(peer, SUBSCRIBE_STREAM);
        quiesce(&loop, server, &socket);
        socket.mutex.lock();
        socket.capacity = 0; // the kernel then takes 100 bytes of row 1
        socket.mutex.unlock();
        try notifyHead(&listen, 3);
        flushWorkers(&loop, server);
        quiesce(&loop, server, &socket);
        try expectNodeView(server, &.{peer}, &.{&socket});
        socket.refresh(100); // row 1 partly written, still in flight
        quiesce(&loop, server, &socket);
        loop.fake.tick(1_000); // heartbeat: ping + frame, behind row 1
        quiesce(&loop, server, &socket);
        try expectNodeView(server, &.{peer}, &.{&socket});
        socket.mutex.lock();
        try testing.expectEqual(@as(usize, 1), socket.pings);
        try testing.expectEqual(@as(usize, 3), socket.queue.items.len); // row 1, ping, heartbeat
        const row_rest = socket.queue.items[0].total - socket.queue.items[0].off;
        socket.mutex.unlock();
        socket.refresh(row_rest); // row 1 done; the batch (ping, heartbeat) not started
        quiesce(&loop, server, &socket);
        try expectNodeView(server, &.{peer}, &.{&socket});
        server.onPong(peer);
        socket.refresh(1 << 30); // everything
        quiesce(&loop, server, &socket);
        try expectNodeView(server, &.{peer}, &.{&socket});
        // Wire order: row 1, the heartbeat, then the rows sent after row 1
        // completed (they wait behind the batch).
        var heartbeat: ?usize = null;
        var row1: ?usize = null;
        var row2: ?usize = null;
        for (socket.delivered.items, 0..) |payload, i| {
            if (heartbeat == null and std.mem.indexOf(u8, payload, "\"type\":\"heartbeat\"") != null) heartbeat = i;
            if (std.mem.indexOf(u8, payload, "\"leaf_index\":1,") != null) row1 = i;
            if (std.mem.indexOf(u8, payload, "\"leaf_index\":2,") != null) row2 = i;
        }
        try testing.expect(row1.? < heartbeat.? and heartbeat.? < row2.?);
        try testing.expect(!socket.destroyed);
        server.stop();
        server.onClose(peer);
        loop.pool.deinit();
        server.destroy();
        loop.loop.deinit();
        loop.fake.deinit();
        socket.deinit();
    }
}
