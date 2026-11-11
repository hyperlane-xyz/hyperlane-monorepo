//! Port of `event-websocket.ts` (`EventWebSocketServer`): the `/agents` and
//! `/messages` WebSocket endpoints, PostgreSQL notification fan-out,
//! confirmation streams, block heads, limits and backpressure.
//!
//! Concurrency (see IMPLEMENTATION.md): every method runs with `loop.mutex`
//! held, which stands in for the Node event loop. Entry points called from
//! other threads (socket events, LISTEN callbacks, timers, send completions,
//! diagnostics) take the mutex themselves. TS `await` points release it.
const std = @import("std");
const core = @import("core");
const diagnostics = @import("diagnostics");
const protocol = @import("protocol.zig");
const runtime = @import("runtime.zig");
const frames = @import("frames.zig");
const es = @import("event_store.zig");
const cs = @import("confirmation_stream.zig");
const sub_mod = @import("agent_subscription.zig");
const NotificationWorker = @import("notification_worker.zig").NotificationWorker;
const NotificationQueue = @import("notification_queue.zig").Queue;

const json = core.json;
const metrics = core.metrics;
const Value = json.Value;
const Allocator = std.mem.Allocator;
const EventType = protocol.EventType;
const AgentSubscription = sub_mod.AgentSubscription;
const ConfirmationStream = cs.ConfirmationStream;
const errorMessage = runtime.errorMessage;

/// Explorer types first: a failure in an agent-only type must not close
/// Explorer clients that already received this range.
const HEAD_PUBLICATION_ORDER = [_]EventType{ .delivery, .gas_payment, .dispatch, .merkle_tree_insertion };

pub const AGENT_PATH = "/agents";
pub const MAX_AGENT_MESSAGE_BYTES = 1_048_576;
pub const MESSAGE_PATH = "/messages";
pub const MAX_EXPLORER_MESSAGE_BYTES = 4_096;
pub const EVENT_CHANNEL = "scraper_event";
pub const EXPLORER_CHANNEL = "scraper_explorer_event";
pub const HEAD_CHANNEL = "scraper_head";
const HEARTBEAT_MS = 30_000;
const MAX_INTERVAL_MS = 2_147_483_647;
const LISTENER_RETRY_MS = 1_000;
const NOTIFICATION_BATCH_MS = 100;
const NOTIFICATION_BATCH_SIZE = 1_000;
const EXPLORER_NOTIFICATION_BATCH_SIZE = 100;
const MAX_EXPLORER_CLIENTS = 400;
const MAX_EXPLORER_CLIENTS_PER_IP = 5;
const MAX_EXPLORER_PENDING_BYTES = 16_777_216;
const MAX_EXPLORER_PENDING_MESSAGES = 2_000;
const MAX_CLIENT_MESSAGES = 30;
const MAX_PENDING_NOTIFICATIONS = 10_000;
const MAX_HEAD_PUBLICATION_FAILURES = 3;

const AGENT_READY_FRAME =
    \\{"confirmations":{"unit":"blocks","liveOnly":true},"eventTypes":["dispatch","delivery","gas_payment","merkle_tree_insertion","blocks"],"historicalStreaming":true,"streamCursorVersions":{"gas_payment":3},"type":"ready"}
;

pub const Limits = struct {
    heartbeat_ms: u64 = HEARTBEAT_MS,
    max_agent_clients: u64,
    max_buffered_bytes: u64,
    max_catch_up_ms: u64,
    max_concurrent_catch_ups: u64,
    max_explorer_clients: u64 = MAX_EXPLORER_CLIENTS,
    max_total_buffered_bytes: u64,

    pub fn fromConfig(config: *const core.config.Config) Limits {
        return .{
            .max_agent_clients = config.event_stream_max_agent_clients,
            .max_buffered_bytes = config.event_stream_max_buffered_bytes,
            .max_catch_up_ms = config.event_stream_history_max_ms,
            .max_concurrent_catch_ups = config.event_stream_history_max_concurrent,
            .max_total_buffered_bytes = config.event_stream_max_total_buffered_bytes,
        };
    }
};

pub const Options = struct {
    limits: Limits,
    batch_size: u64,
    /// `process.env.NODE_ENV === 'production'` (clientIp ignores the peer address).
    production: bool = false,
};

// ---------------------------------------------------------------------------
// Transport seams

/// A `ws` socket. Implementations never invoke `SendJob.complete` (or any
/// server callback) synchronously from these methods.
pub const Socket = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// `socket.send(bytes, cb)`; bytes are copied. False when it throws.
        send: *const fn (ptr: *anyopaque, bytes: []const u8, job: *SendJob) bool,
        buffered_amount: *const fn (ptr: *anyopaque) usize,
        /// `readyState === WebSocket.OPEN`.
        is_open: *const fn (ptr: *anyopaque) bool,
        /// `is_open` and `buffered_amount` read together (one lock per send).
        snapshot: *const fn (ptr: *anyopaque) Snapshot,
        close: *const fn (ptr: *anyopaque, code: u16, reason: []const u8) void,
        terminate: *const fn (ptr: *anyopaque) void,
        ping: *const fn (ptr: *anyopaque) void,
        release: *const fn (ptr: *anyopaque) void,
        /// Optional fast path: write on the caller's thread when nothing is
        /// queued (Node writes synchronously when the socket is writable).
        try_send_inline: ?*const fn (ptr: *anyopaque, bytes: []const u8) InlineResult = null,
    };

    pub const Snapshot = struct { open: bool, buffered: usize };

    pub const InlineResult = enum {
        /// Handed to the kernel (a partial tail may still be queued in order).
        written,
        /// Queue busy or kernel buffer full: nothing written, use `send`.
        busy,
        /// The socket failed (it is now destroyed).
        failed,
    };

    fn send(self: Socket, bytes: []const u8, job: *SendJob) bool {
        return self.vtable.send(self.ptr, bytes, job);
    }
    fn bufferedAmount(self: Socket) usize {
        return self.vtable.buffered_amount(self.ptr);
    }
    fn isOpen(self: Socket) bool {
        return self.vtable.is_open(self.ptr);
    }
    fn snapshot(self: Socket) Snapshot {
        return self.vtable.snapshot(self.ptr);
    }
    fn close(self: Socket, code: u16, reason: []const u8) void {
        self.vtable.close(self.ptr, code, reason);
    }
    fn terminate(self: Socket) void {
        self.vtable.terminate(self.ptr);
    }
    fn ping(self: Socket) void {
        self.vtable.ping(self.ptr);
    }
};

/// PostgreSQL LISTEN (`DbService.listen` / the returned stop function).
pub const Listen = struct {
    ctx: *anyopaque,
    /// Blocking connect + LISTEN. Callbacks run on the listener thread.
    listen: *const fn (ctx: *anyopaque, channels: []const []const u8, handler: ListenHandler) anyerror!*anyopaque,
    /// Blocking stop (joins the listener thread); never call with the mutex held.
    unlisten: *const fn (ctx: *anyopaque, handle: *anyopaque) void,
};

pub const ListenHandler = struct {
    ctx: *anyopaque,
    on_notification: *const fn (ctx: *anyopaque, channel: []const u8, payload: []const u8) void,
    on_disconnect: *const fn (ctx: *anyopaque, message: ?[]const u8) void,
};

/// A pending `socket.send` callback. Completed exactly once, without locks.
pub const SendJob = struct {
    server: *Server,
    peer: *Peer,
    len: usize,
    kind: Kind,

    const Kind = union(enum) {
        none,
        waiter: *Waiter,
        explorer_drain,
        diagnostics: diagnostics.stream.Completion,
    };

    pub fn complete(self: *SendJob, ok: bool) void {
        const server = self.server;
        const peer = self.peer;
        const kind = self.kind;
        _ = server.pending_bytes.fetchSub(self.len, .monotonic);
        server.allocator.destroy(self);
        // Successful plain and awaited sends touch no loop state: skip the
        // loop mutex (a catch-up completes one of these per replayed row).
        if (ok) switch (kind) {
            .none => return peer.releaseUnlocked(),
            .waiter => |waiter| {
                waiter.finish(true);
                return peer.releaseUnlocked();
            },
            .explorer_drain, .diagnostics => {},
        };
        server.loop.lock();
        defer server.loop.unlock();
        switch (kind) {
            .none => {},
            .waiter => |waiter| waiter.finish(ok),
            .explorer_drain => {},
            .diagnostics => |done| done.complete(ok),
        }
        if (!ok) server.failSend(peer, "WebSocket is not open");
        if (kind == .explorer_drain) {
            if (ok) server.drainExplorerClient(peer) else peer.explorer.sending = false;
        }
        peer.release();
    }
};

const Waiter = struct {
    ok: bool = false,
    event: std.Thread.ResetEvent = .{},

    /// The waiting task may return as soon as `event` is set.
    fn finish(self: *Waiter, ok: bool) void {
        self.ok = ok;
        self.event.set();
    }
};

/// One serialized frame shared by several recipients (loop mutex guards refs).
const SharedFrame = struct {
    refs: usize = 1,
    bytes: []u8,

    fn create(allocator: Allocator, bytes: []u8) *SharedFrame {
        const frame = allocator.create(SharedFrame) catch oom();
        frame.* = .{ .bytes = bytes };
        return frame;
    }

    fn release(self: *SharedFrame, allocator: Allocator) void {
        self.refs -= 1;
        if (self.refs > 0) return;
        allocator.free(self.bytes);
        allocator.destroy(self);
    }
};

fn oom() noreturn {
    @panic("live: out of memory");
}

// ---------------------------------------------------------------------------
// Per-socket state (the TS maps keyed by WebSocket)

const AgentClient = struct {
    alive: bool = true,
    messages: u32 = 0,
    message_window: i64 = 0,
    subscriptions: std.EnumArray(EventType, ?*AgentSubscription) = .initFill(null),
    subscribing: bool = false,

    fn count(self: *const AgentClient) usize {
        var total: usize = 0;
        for (self.subscriptions.values) |entry| if (entry != null) {
            total += 1;
        };
        return total;
    }
};

const ExplorerClient = struct {
    message_ids: ?[]const []const u8 = null,
    alive: bool = true,
    custom: bool = false,
    ip: []const u8 = "",
    queued_bytes: usize = 0,
    queue: std.ArrayList(*SharedFrame) = .empty,
    queue_head: usize = 0,
    sending: bool = false,

    fn queueLength(self: *const ExplorerClient) usize {
        return self.queue.items.len - self.queue_head;
    }

    fn hasId(self: *const ExplorerClient, id: []const u8) bool {
        const ids = self.message_ids orelse return true;
        return protocol.containsString(ids, id);
    }
};

const BlockSubscription = struct {
    domains: ?[]const u32,
    started: bool = false,
    latest: std.AutoArrayHashMapUnmanaged(u32, *SharedFrame) = .empty,
};

pub const Route = enum { agent, explorer };

pub const Peer = struct {
    server: *Server,
    socket: Socket,
    /// Atomic: send completions drop their reference without the loop mutex.
    refs: std.atomic.Value(usize) = .init(1),
    route: Route,
    terminated: bool = false,
    in_clients: bool = false,
    agent: AgentClient = .{},
    in_explorer: bool = false,
    explorer: ExplorerClient = .{},
    blocks: ?*BlockSubscription = null,
    streams: ?std.ArrayList(*ConfirmationStream) = null,
    diagnostics_subscription: ?*diagnostics.stream.Subscription = null,
    /// ws 'close' has been handled.
    closed: bool = false,
    /// Domain reported by the last `ConfirmationUnavailable` failure.
    unavailable_domain: u32 = 0,

    pub fn retain(self: *Peer) void {
        _ = self.refs.fetchAdd(1, .monotonic);
    }

    /// Loop mutex held.
    pub fn release(self: *Peer) void {
        if (self.refs.fetchSub(1, .acq_rel) != 1) return;
        self.destroy();
    }

    /// Loop mutex not held (send completions).
    pub fn releaseUnlocked(self: *Peer) void {
        if (self.refs.fetchSub(1, .acq_rel) != 1) return;
        const loop = self.server.loop;
        loop.lock();
        defer loop.unlock();
        self.destroy();
    }

    fn destroy(self: *Peer) void {
        // disconnect() already dropped streams/subscriptions (they hold peer refs).
        const server = self.server;
        server.clearBlocks(self);
        server.clearExplorerQueue(self);
        if (self.explorer.message_ids) |ids| freeStrings(server.allocator, ids);
        if (self.explorer.ip.len > 0) server.allocator.free(self.explorer.ip);
        self.explorer.queue.deinit(server.allocator);
        self.socket.vtable.release(self.socket.ptr);
        server.allocator.destroy(self);
    }
};

const HeadRange = struct { after: i128, through: i128, seq: u64 };

const Deferred = struct { peer: *Peer, len: usize, drain: bool };

const CatchUpWaiter = struct {
    peer: *Peer,
    resolved: ?bool = null,
    condition: std.Thread.Condition = .{},
};

const HeadFailure = struct { partial_agent: bool, explorer_affected: bool };

// ---------------------------------------------------------------------------

pub const Server = struct {
    allocator: Allocator,
    loop: *runtime.Loop,
    logger: core.log.Logger,
    store: es.EventStore,
    listen_api: Listen,
    limits: Limits,
    production: bool,
    diagnostics_stream: ?*diagnostics.stream.Stream,

    clients: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    block_subscriptions: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    confirmation_streams: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    explorer_clients: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    explorer_clients_by_ip: std.StringArrayHashMapUnmanaged(usize) = .empty,
    catch_up_waiters: std.ArrayList(*CatchUpWaiter) = .empty,
    explorer_notifications: NotificationQueue(void) = .{},
    notifications: NotificationQueue(protocol.EventNotification) = .{},
    pending_heads: std.AutoArrayHashMapUnmanaged(u32, protocol.HeadNotification) = .empty,
    head_ranges: std.AutoArrayHashMapUnmanaged(u32, HeadRange) = .empty,
    head_range_seq: u64 = 0,
    head_failures: std.AutoArrayHashMapUnmanaged(u32, u32) = .empty,
    heartbeat_timer: ?u64 = null,
    listener_retry_timer: ?u64 = null,
    agent_notifications: NotificationWorker = undefined,
    explorer_updates: NotificationWorker = undefined,
    confirmation_updates: NotificationWorker = undefined,
    head_updates: NotificationWorker = undefined,
    catch_ups: u64 = 0,
    /// Atomic: decremented by send completions without the loop mutex.
    pending_bytes: std.atomic.Value(usize) = .init(0),
    listener_ready: bool = false,
    stopped: bool = false,
    listener: ?*anyopaque = null,
    /// Ignore callbacks from listeners that were replaced or stopped.
    listener_attempt: u64 = 0,
    /// Write callbacks of frames written inline, run at the end of the turn.
    deferred: std.ArrayList(Deferred) = .empty,
    /// Listener callback contexts, freed in `destroy` (callbacks may race shutdown).
    listener_contexts: std.ArrayList(*ListenerContext) = .empty,

    pub fn create(
        allocator: Allocator,
        loop: *runtime.Loop,
        db: es.Db,
        listen_api: Listen,
        options: Options,
        diagnostics_stream: ?*diagnostics.stream.Stream,
    ) !*Server {
        const self = try allocator.create(Server);
        self.* = .{
            .allocator = allocator,
            .loop = loop,
            .logger = core.log.child("EventWebSocketServer"),
            .store = es.EventStore.init(allocator, loop, db, options.batch_size),
            .listen_api = listen_api,
            .limits = options.limits,
            .production = options.production,
            .diagnostics_stream = diagnostics_stream,
        };
        self.agent_notifications = .init(loop, NOTIFICATION_BATCH_MS, self, drainAgentThunk, failAgentThunk);
        self.explorer_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainExplorerThunk, failExplorerThunk);
        self.confirmation_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainConfirmationThunk, failExplorerThunk);
        self.head_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainHeadThunk, failHeadThunk);
        loop.turn_end = .{ .ctx = self, .func = endTurnThunk };
        return self;
    }

    /// After `stop()` and once every socket has closed.
    pub fn destroy(self: *Server) void {
        const a = self.allocator;
        self.store.deinit();
        self.clients.deinit(a);
        self.block_subscriptions.deinit(a);
        self.confirmation_streams.deinit(a);
        self.explorer_clients.deinit(a);
        for (self.explorer_clients_by_ip.keys()) |ip| a.free(ip);
        self.explorer_clients_by_ip.deinit(a);
        self.catch_up_waiters.deinit(a);
        self.explorer_notifications.deinit(a);
        self.notifications.deinit(a);
        self.pending_heads.deinit(a);
        self.head_ranges.deinit(a);
        self.head_failures.deinit(a);
        self.deferred.deinit(a);
        for (self.listener_contexts.items) |context| a.destroy(context);
        self.listener_contexts.deinit(a);
        a.destroy(self);
    }

    /// The deferred write callbacks of inline-written frames (successful, like
    /// the ws callback): release their bytes, then resume Explorer drains.
    fn endTurnThunk(ctx: *anyopaque) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        var index: usize = 0;
        while (index < self.deferred.items.len) : (index += 1) {
            const item = self.deferred.items[index];
            _ = self.pending_bytes.fetchSub(item.len, .monotonic);
            if (item.drain) self.drainExplorerClient(item.peer);
            item.peer.release();
        }
        self.deferred.clearRetainingCapacity();
    }

    // -- lifecycle -------------------------------------------------------------

    /// `start(server)`: validate, connect the listener, start heartbeats.
    pub fn start(self: *Server) !void {
        self.loop.lock();
        defer self.loop.unlock();
        const heartbeat_ms = self.limits.heartbeat_ms;
        if (heartbeat_ms < 1 or heartbeat_ms > MAX_INTERVAL_MS) {
            self.logger.err("Invalid heartbeatMs {d}: must be an integer between 1 and {d}", .{ heartbeat_ms, MAX_INTERVAL_MS });
            return error.InvalidHeartbeat;
        }
        self.connectListener();
        if (self.diagnostics_stream) |stream| {
            self.loop.unlock();
            stream.start();
            self.loop.lock();
        }
        self.heartbeat_timer = self.loop.scheduler.schedule(heartbeat_ms, self, onHeartbeatTimer);
        self.logger.info("event websockets listening on {s}, {s} batchSize={d} maxAgentClients={d} maxBufferedBytes={d} maxTotalBufferedBytes={d}", .{
            AGENT_PATH, MESSAGE_PATH, self.store.batch_size, self.limits.max_agent_clients, self.limits.max_buffered_bytes, self.limits.max_total_buffered_bytes,
        });
    }

    pub fn stop(self: *Server) void {
        self.loop.lock();
        self.stopped = true;
        self.loop.unlock();
        if (self.diagnostics_stream) |stream| stream.stop();
        self.loop.lock();
        if (self.heartbeat_timer) |id| self.loop.scheduler.cancel(id);
        if (self.listener_retry_timer) |id| self.loop.scheduler.cancel(id);
        self.heartbeat_timer = null;
        self.listener_retry_timer = null;
        for ([_]*NotificationWorker{ &self.agent_notifications, &self.explorer_updates, &self.head_updates, &self.confirmation_updates }) |worker| worker.stop();
        self.clearExplorerNotifications();
        self.clearNotifications();
        self.head_ranges.clearRetainingCapacity();
        const listener = self.listener;
        self.listener = null;
        self.listener_attempt += 1;
        self.loop.unlock();
        if (listener) |handle| self.listen_api.unlisten(self.listen_api.ctx, handle);
        self.loop.lock();
        self.closeClients("Server stopping", 1001);
        self.loop.unlock();
    }

    // -- metrics ---------------------------------------------------------------

    pub fn metricsProvider(self: *Server) metrics.WebSocketMetricsProvider {
        return .{ .ctx = self, .snapshot = snapshotThunk };
    }

    fn snapshotThunk(ctx: *anyopaque) metrics.WebSocketMetricsSnapshot {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.loop.lock();
        defer self.loop.unlock();
        return self.metricsSnapshot();
    }

    pub fn metricsSnapshot(self: *Server) metrics.WebSocketMetricsSnapshot {
        var snapshot: metrics.WebSocketMetricsSnapshot = .{};
        const now = self.loop.now();
        var max_duration: i64 = 0;
        var max_rows: usize = 0;
        var max_pending: usize = 0;
        var pending: usize = 0;
        for (self.clients.keys()) |peer| {
            for (std.enums.values(EventType)) |event_type| {
                const subscription = peer.agent.subscriptions.get(event_type) orelse continue;
                const counts = switch (event_type) {
                    .delivery => &snapshot.subscriptions.delivery,
                    .dispatch => &snapshot.subscriptions.dispatch,
                    .gas_payment => &snapshot.subscriptions.gas_payment,
                    .merkle_tree_insertion => &snapshot.subscriptions.merkle_tree_insertion,
                };
                if (subscription.state == .live) counts.live += 1 else counts.catchingUp += 1;
                pending += subscription.pendingCount();
                max_pending = @max(max_pending, subscription.pendingCount());
                if (subscription.state != .live) {
                    max_duration = @max(max_duration, now - subscription.catch_up_started_at);
                    max_rows = @max(max_rows, subscription.catch_up_rows);
                }
            }
        }
        var explorer_messages: usize = 0;
        var explorer_bytes: usize = 0;
        var max_explorer_bytes: usize = 0;
        var max_explorer_messages: usize = 0;
        var max_buffered: usize = 0;
        for (self.clients.keys()) |peer| max_buffered = @max(max_buffered, peer.socket.bufferedAmount());
        for (self.explorer_clients.keys()) |peer| {
            const client = &peer.explorer;
            explorer_messages += client.queueLength();
            explorer_bytes += client.queued_bytes;
            max_explorer_bytes = @max(max_explorer_bytes, client.queued_bytes);
            max_explorer_messages = @max(max_explorer_messages, client.queueLength());
            max_buffered = @max(max_buffered, peer.socket.bufferedAmount());
        }
        var max_per_ip: usize = 0;
        for (self.explorer_clients_by_ip.values()) |count| max_per_ip = @max(max_per_ip, count);
        snapshot.catchUps = f(self.catch_ups);
        snapshot.connections = .{ .agent = f(self.clients.count()), .messages = f(self.explorer_clients.count()) };
        snapshot.explorerPendingMessages = f(explorer_messages);
        snapshot.explorerPendingBytes = f(explorer_bytes);
        snapshot.maxExplorerPendingBytes = f(max_explorer_bytes);
        snapshot.maxExplorerPendingMessages = f(max_explorer_messages);
        snapshot.messageClientIps = f(self.explorer_clients_by_ip.count());
        snapshot.messageMaxConnectionsPerIp = f(max_per_ip);
        snapshot.limits = .{
            .agentConnections = f(self.limits.max_agent_clients),
            .catchUpMs = f(self.limits.max_catch_up_ms),
            .clientMessagesPerMinute = MAX_CLIENT_MESSAGES,
            .concurrentCatchUps = f(self.limits.max_concurrent_catch_ups),
            .explorerPendingBytes = MAX_EXPLORER_PENDING_BYTES,
            .explorerPendingMessages = MAX_EXPLORER_PENDING_MESSAGES,
            .messageConnections = f(self.limits.max_explorer_clients),
            .messageConnectionsPerIp = MAX_EXPLORER_CLIENTS_PER_IP,
            .notificationEvents = MAX_PENDING_NOTIFICATIONS,
            .pendingEvents = sub_mod.MAX_PENDING_EVENTS,
            .socketBufferedBytes = f(self.limits.max_buffered_bytes),
            .totalPendingBytes = f(self.limits.max_total_buffered_bytes),
        };
        snapshot.listenerReady = self.listener_ready;
        snapshot.maxCatchUpDurationMs = @floatFromInt(max_duration);
        snapshot.maxCatchUpRows = f(max_rows);
        snapshot.maxClientBufferedBytes = f(max_buffered);
        snapshot.notificationQueue = .{ .agent = f(self.notifications.count()), .messages = f(self.explorer_notifications.count()) };
        snapshot.outboundPendingBytes = f(self.pending_bytes.load(.monotonic));
        snapshot.maxPendingCatchUpEvents = f(max_pending);
        snapshot.pendingCatchUpEvents = f(pending);
        return snapshot;
    }

    fn f(value: anytype) f64 {
        return @floatFromInt(value);
    }

    // -- connections -------------------------------------------------------------

    fn newPeer(self: *Server, socket: Socket, route: Route) *Peer {
        const peer = self.allocator.create(Peer) catch oom();
        peer.* = .{ .server = self, .socket = socket, .route = route };
        return peer;
    }

    /// `connectAgent`: called once the upgrade succeeded; takes the mutex.
    pub fn connectAgent(self: *Server, socket: Socket) *Peer {
        self.loop.lock();
        defer self.loop.unlock();
        const peer = self.newPeer(socket, .agent);
        if (!self.accept(peer)) return peer;
        peer.in_clients = true;
        peer.agent = .{ .message_window = self.loop.now() };
        self.clients.put(self.allocator, peer, {}) catch oom();
        metrics.websocket_connections.inc(.{"agent"}, 1);
        _ = self.send(peer, AGENT_READY_FRAME);
        return peer;
    }

    pub const ExplorerRequest = struct {
        /// Raw `request.url`.
        url: []const u8,
        /// `cf-connecting-ip` header (duplicates joined like Node), if present.
        cf_connecting_ip: ?[]const u8,
        /// `request.socket.remoteAddress`.
        remote_address: ?[]const u8,
    };

    /// `connectExplorer`. The synchronous prefix (validation, limits,
    /// registration) runs here; reads continue on a task.
    pub fn connectExplorer(self: *Server, socket: Socket, request: ExplorerRequest) *Peer {
        self.loop.lock();
        defer self.loop.unlock();
        const peer = self.newPeer(socket, .explorer);
        if (!self.accept(peer)) return peer;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var diag: protocol.Diag = .{};
        const params = protocol.QueryParams.fromUrl(a, request.url) catch oom();
        const custom = protocol.parseExplorerConfirmations(a, &params, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const blocks = protocol.parseExplorerBlocks(&params, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const message_ids = protocol.parseExplorerMessageIds(a, &params, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const with_diagnostics = protocol.parseExplorerDiagnostics(&params, message_ids, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const ip = self.clientIp(request) orelse {
            metrics.websocket_connection_rejections.inc(.{ "invalid_client_ip", "messages" }, 1);
            socket.close(1008, "Missing or invalid client IP");
            return peer;
        };
        const connections = self.explorer_clients_by_ip.get(ip) orelse 0;
        if (connections >= MAX_EXPLORER_CLIENTS_PER_IP) {
            metrics.websocket_connection_rejections.inc(.{ "per_ip_limit", "messages" }, 1);
            socket.close(1008, "Maximum connections per client reached");
            return peer;
        }
        const owned_ip = self.allocator.dupe(u8, ip) catch oom();
        if (self.explorer_clients_by_ip.getPtr(ip)) |count| {
            count.* += 1;
        } else self.explorer_clients_by_ip.put(self.allocator, self.allocator.dupe(u8, ip) catch oom(), 1) catch oom();
        peer.in_explorer = true;
        peer.explorer = .{
            .custom = custom != null,
            .message_ids = if (message_ids) |ids| dupeStrings(self.allocator, ids) else null,
            .ip = owned_ip,
        };
        self.explorer_clients.put(self.allocator, peer, {}) catch oom();
        metrics.websocket_connections.inc(.{"messages"}, 1);
        const setup = self.allocator.create(ExplorerSetup) catch oom();
        setup.* = .{
            .custom = if (custom) |c| .{ .confirmations = c.confirmations, .domains = self.allocator.dupe(u32, c.domains) catch oom() } else null,
            .blocks = blocks,
            .diagnostics = with_diagnostics,
        };
        if (blocks) self.registerBlocks(peer, if (custom) |c| c.domains else null);
        peer.retain();
        if (!blocks and custom == null) {
            // No reads: finish synchronously like the TS async function.
            self.finishExplorer(peer, setup);
        } else self.loop.spawn(finishExplorer, .{ self, peer, setup });
        return peer;
    }

    const ExplorerSetup = struct {
        custom: ?struct { confirmations: u64, domains: []const u32 },
        blocks: bool,
        diagnostics: bool,
    };

    fn negotiationFailed(self: *Server, peer: *Peer, err: anyerror, diag: protocol.Diag) *Peer {
        self.rejectNegotiation(peer, if (err == error.Invalid) diag.message else @errorName(err));
        return peer;
    }

    /// The part of `connectExplorer` after its first await.
    fn finishExplorer(self: *Server, peer: *Peer, setup: *ExplorerSetup) void {
        defer {
            if (setup.custom) |c| self.allocator.free(c.domains);
            self.allocator.destroy(setup);
            peer.release();
        }
        var stream: ?*ConfirmationStream = null;
        if (setup.blocks) self.loadBlocks(peer) catch |err| return self.failSocket(peer, errorMessage(err));
        if (setup.custom) |c| {
            stream = self.createConfirmationStream(peer, c.confirmations, c.domains, null, null, true) catch |err| {
                if (err == error.ConfirmationUnavailable) {
                    var buffer: [96]u8 = undefined;
                    return self.rejectNegotiation(peer, unavailableMessage(&buffer, self.lastUnavailableDomain(peer)));
                }
                return self.failSocket(peer, errorMessage(err));
            };
        }
        // Initialization awaits DB reads; the peer may already have disconnected.
        // (Streams registered meanwhile hold peer references: drop them.)
        if (!peer.in_explorer) return self.dropStreams(peer);
        if (!peer.socket.isOpen()) return;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        writeExplorerReady(&out.writer, peer, setup, stream) catch oom();
        _ = self.send(peer, out.written());
        if (stream) |s| s.start();
        self.startBlocks(peer);
        if (setup.diagnostics) if (peer.explorer.message_ids) |ids| self.subscribeDiagnostics(peer, ids);
    }

    fn writeExplorerReady(w: *std.Io.Writer, peer: *Peer, setup: *const ExplorerSetup, stream: ?*ConfirmationStream) !void {
        var o = try frames.Object.begin(w);
        if (peer.explorer.message_ids) |ids| try o.strings("messageIds", ids);
        if (setup.custom) |custom| {
            try o.int("confirmations", custom.confirmations);
            try o.ints("domains", custom.domains);
            if (stream) |s| {
                try o.ints("customDomains", s.customDomains());
                try o.key("canonicalDomains");
                try w.writeByte('[');
                var first = true;
                for (custom.domains) |domain| {
                    if (s.isCustom(domain)) continue;
                    if (!first) try w.writeByte(',');
                    first = false;
                    try w.print("{d}", .{domain});
                }
                try w.writeByte(']');
            }
        }
        try o.key("eventTypes");
        try w.writeAll("[\"message_upsert\"");
        if (setup.custom != null) try w.writeAll(",\"rollback\"");
        if (setup.blocks) try w.writeAll(",\"block\"");
        if (setup.diagnostics) for (diagnostics.stream.event_types) |name| {
            try w.writeByte(',');
            try json.writeString(w, name);
        };
        try w.writeByte(']');
        try o.string("type", "ready");
        try o.end();
    }

    fn subscribeDiagnostics(self: *Server, peer: *Peer, ids: []const []const u8) void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const display = a.alloc([]const u8, ids.len) catch oom();
        for (ids, display) |id, *out| out.* = protocol.displayAddress(a, id) catch oom();
        const stream = self.diagnostics_stream orelse
            return self.sendDiagnosticsUnavailable(peer, display, "Diagnostics are not configured");
        // The diagnostics stream calls back into `sendDiagnostics`, which takes the mutex.
        peer.retain();
        self.loop.unlock();
        const result = stream.subscribe(peer.explorer.ip, display, .{ .ctx = peer, .send = sendDiagnosticsThunk, .release = releaseDiagnosticsThunk });
        self.loop.lock();
        const subscription = result catch |err| {
            peer.release();
            return self.sendDiagnosticsUnavailable(peer, display, diagnostics.stream.subscribeErrorMessage(err));
        };
        if (peer.closed) {
            // Closed while subscribing: `socket.once('close', unsubscribe)` already ran.
            // `Sink.release` drops the sink's peer reference.
            self.loop.unlock();
            stream.unsubscribe(subscription);
            self.loop.lock();
            return;
        }
        peer.diagnostics_subscription = subscription;
    }

    fn sendDiagnosticsUnavailable(self: *Server, peer: *Peer, ids: []const []const u8, message: []const u8) void {
        const bytes = diagnostics.stream.unavailableFrameAlloc(self.allocator, ids, message) catch oom();
        defer self.allocator.free(bytes);
        _ = self.sendDiagnosticsBytes(peer, bytes, null);
    }

    /// The stream's last use of this sink: drop the subscription's peer reference.
    fn releaseDiagnosticsThunk(ctx: *anyopaque) void {
        const peer: *Peer = @ptrCast(@alignCast(ctx));
        const self = peer.server;
        self.loop.lock();
        defer self.loop.unlock();
        peer.release();
    }

    fn sendDiagnosticsThunk(ctx: *anyopaque, frame: *diagnostics.stream.Frame, done: diagnostics.stream.Completion) bool {
        const peer: *Peer = @ptrCast(@alignCast(ctx));
        const self = peer.server;
        self.loop.lock();
        defer self.loop.unlock();
        return self.sendDiagnosticsBytes(peer, frame.bytes, done);
    }

    /// `sendDiagnostics`: never queue diagnostics behind normal updates, and
    /// leave at least half of both outbound budgets for normal traffic.
    fn sendDiagnosticsBytes(self: *Server, peer: *Peer, bytes: []const u8, done: ?diagnostics.stream.Completion) bool {
        if (!peer.in_explorer or peer.explorer.sending or peer.explorer.queueLength() > 0) {
            if (done) |d| d.complete(false);
            return false;
        }
        if (2 * (peer.socket.bufferedAmount() + bytes.len) > self.limits.max_buffered_bytes or
            2 * (self.pending_bytes.load(.monotonic) + bytes.len) > self.limits.max_total_buffered_bytes)
        {
            if (done) |d| d.complete(false);
            return false;
        }
        const accepted = self.sendSerialized(peer, bytes, if (done) |d| .{ .diagnostics = d } else .none);
        if (!accepted) if (done) |d| d.complete(false);
        return accepted;
    }

    fn accept(self: *Server, peer: *Peer) bool {
        // An upgrade that raced stop() (TS removes the 'upgrade' listener synchronously).
        if (self.stopped) {
            peer.socket.close(1001, "Server stopping");
            return false;
        }
        const full = if (peer.route == .agent)
            self.clients.count() >= self.limits.max_agent_clients
        else
            self.explorer_clients.count() >= self.limits.max_explorer_clients;
        if (!self.listener_ready or full) {
            const route = if (peer.route == .explorer) "messages" else "agent";
            metrics.websocket_connection_rejections.inc(.{ if (full) "connection_limit" else "listener_unavailable", route }, 1);
            if (!self.listener_ready) {
                peer.socket.close(1013, "Database event listener unavailable");
            } else if (peer.route == .agent) {
                peer.socket.close(1013, "Maximum agent websocket clients reached");
            } else peer.socket.close(1013, "Maximum explorer websocket clients reached");
            return false;
        }
        return true;
    }

    fn clientIp(self: *Server, request: ExplorerRequest) ?[]const u8 {
        if (request.cf_connecting_ip) |ip| return if (protocol.isIp(ip)) ip else null;
        if (self.production) return null;
        const remote = request.remote_address orelse return null;
        if (remote.len == 0) return null;
        const ipv4 = if (std.mem.startsWith(u8, remote, "::ffff:")) remote[7..] else remote;
        return if (protocol.isIp(ipv4)) ipv4 else null;
    }

    // -- socket events (called without the mutex) --------------------------------

    pub fn onMessage(self: *Server, peer: *Peer, data: []const u8) void {
        self.loop.lock();
        defer self.loop.unlock();
        self.handleMessage(peer, data);
    }

    pub fn onPong(self: *Server, peer: *Peer) void {
        self.loop.lock();
        defer self.loop.unlock();
        if (peer.in_clients) peer.agent.alive = true else if (peer.in_explorer) peer.explorer.alive = true;
    }

    pub fn onError(self: *Server, peer: *Peer, message: []const u8) void {
        self.loop.lock();
        defer self.loop.unlock();
        self.logger.warn("websocket error: {s}", .{message});
        self.disconnect(peer);
    }

    /// ws 'close' (exactly once). Drops the connection's peer reference.
    pub fn onClose(self: *Server, peer: *Peer) void {
        self.loop.lock();
        self.disconnect(peer);
        peer.closed = true;
        const subscription = peer.diagnostics_subscription;
        peer.diagnostics_subscription = null;
        if (subscription) |s| {
            // `socket.once('close', unsubscribe)`. The sink's peer reference is
            // dropped by `Sink.release` once in-flight publications are done.
            self.loop.unlock();
            self.diagnostics_stream.?.unsubscribe(s);
            self.loop.lock();
        }
        peer.release();
        self.loop.unlock();
    }

    // -- agent protocol ------------------------------------------------------------

    fn handleMessage(self: *Server, peer: *Peer, raw: []const u8) void {
        if (!peer.in_clients) return;
        const client = &peer.agent;
        if (!self.consumeMessage(client)) {
            metrics.websocket_client_message_rejections.inc(.{}, 1);
            self.sendError(peer, "Client message rate limit exceeded");
            peer.socket.close(1008, "Client message rate limit exceeded");
            return;
        }
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        var arena_owned = true;
        defer if (arena_owned) arena.deinit();
        var diag: protocol.Diag = .{};
        const message = protocol.parseClientMessage(arena.allocator(), raw, &diag) catch |err| {
            self.sendError(peer, if (err == error.Invalid) diag.message else @errorName(err));
            return;
        };
        const streams = switch (message) {
            .ping => {
                _ = self.send(peer, "{\"type\":\"pong\"}");
                return;
            },
            .subscribe => |streams| streams,
        };
        if (client.count() > 0 or client.subscribing or peer.blocks != null) {
            self.sendError(peer, "Already subscribed");
            return;
        }
        client.subscribing = true;
        for (streams) |request| {
            // Register before the snapshot: notifications received during the
            // query win, including lower heights and replacement hashes.
            if (request.kind == .blocks) self.registerBlocks(peer, request.domains);
        }
        const job = self.allocator.create(SubscribeJob) catch oom();
        job.* = .{ .arena = arena, .streams = streams };
        arena_owned = false;
        peer.retain();
        self.loop.spawn(subscribe, .{ self, peer, job });
    }

    const SubscribeJob = struct {
        arena: std.heap.ArenaAllocator,
        streams: []const protocol.StreamRequest,
    };

    /// `onMessage` after its first await.
    fn subscribe(self: *Server, peer: *Peer, job: *SubscribeJob) void {
        defer {
            job.arena.deinit();
            self.allocator.destroy(job);
            peer.release();
        }
        self.subscribeStreams(peer, job.streams) catch |err| {
            if (err == error.ConfirmationUnavailable) {
                var buffer: [96]u8 = undefined;
                self.rejectNegotiation(peer, unavailableMessage(&buffer, self.lastUnavailableDomain(peer)));
            } else self.failSocket(peer, errorMessage(err));
            return;
        };
        if (!peer.in_clients) return self.dropStreams(peer);
        const client = &peer.agent;
        for (job.streams) |request| {
            const event_type = request.kind.eventType() orelse continue;
            const binding = self.allocator.create(SubscriptionBinding) catch oom();
            peer.retain();
            binding.* = .{ .peer = peer, .event_type = event_type, .subscription = undefined };
            const subscription = AgentSubscription.create(self.allocator, request, &self.store, self.loop, self.limits.max_catch_up_ms, .{
                .ctx = binding,
                .active = SubscriptionBinding.active,
                .send = SubscriptionBinding.send,
                .close = SubscriptionBinding.close,
                .deinit = SubscriptionBinding.free,
            }) catch oom();
            binding.subscription = subscription;
            if (client.subscriptions.get(event_type)) |previous| previous.release();
            client.subscriptions.set(event_type, subscription);
        }
        client.subscribing = false;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        writeSubscribed(&out.writer, job.streams) catch oom();
        _ = self.send(peer, out.written());
        if (peer.streams) |streams| {
            // `forEach(stream => stream.start())` over a snapshot.
            const snapshot = self.allocator.dupe(*ConfirmationStream, streams.items) catch oom();
            defer self.allocator.free(snapshot);
            for (snapshot) |stream| stream.retain();
            for (snapshot) |stream| stream.start();
            for (snapshot) |stream| stream.release();
        }
        self.startBlocks(peer);
        for (job.streams) |request| {
            if (request.cursors == null) continue;
            self.startCatchUp(peer, request.kind.eventType().?);
        }
    }

    fn subscribeStreams(self: *Server, peer: *Peer, streams: []const protocol.StreamRequest) !void {
        if (peer.blocks != null) try self.loadBlocks(peer);
        for (streams) |request| {
            const event_type = request.kind.eventType() orelse continue;
            const domains = request.domains orelse continue;
            if (request.confirmations) |confirmations|
                _ = try self.createConfirmationStream(peer, confirmations, domains, event_type, request.cursors, false);
            if (request.include_zero_confirmations == true and request.confirmations != 0)
                _ = try self.createConfirmationStream(peer, 0, domains, event_type, request.cursors, true);
        }
    }

    fn writeSubscribed(w: *std.Io.Writer, streams: []const protocol.StreamRequest) !void {
        try w.writeAll("{\"streams\":[");
        for (streams, 0..) |request, index| {
            if (index > 0) try w.writeByte(',');
            var o = try frames.Object.begin(w);
            if (request.confirmations) |confirmations| try o.int("confirmations", confirmations);
            if (request.include_zero_confirmations) |flag| try o.boolean("includeZeroConfirmations", flag);
            if (request.cursors) |cursors| {
                try o.key("cursors");
                try w.writeByte('[');
                for (cursors, 0..) |cursor, i| {
                    if (i > 0) try w.writeByte(',');
                    var c = try frames.Object.begin(w);
                    try c.key("address");
                    try w.writeAll("\"0x");
                    try w.writeAll(cursor.address[2..]);
                    try w.writeByte('"');
                    if (cursor.after) |after| {
                        try c.key(if (cursor.kind == .gas_payment) "afterStreamCursor" else "afterSequence");
                        try json.writeString(w, after.text);
                    }
                    try c.int("domain", cursor.domain);
                    try c.end();
                }
                try w.writeByte(']');
            }
            if (request.domains) |domains| try o.ints("domains", domains);
            try o.string("eventType", @tagName(request.kind));
            if (request.stream_cursor_version) |version| try o.int("streamCursorVersion", version);
            try o.end();
        }
        try w.writeAll("],\"type\":\"subscribed\"}");
    }

    const SubscriptionBinding = struct {
        peer: *Peer,
        event_type: EventType,
        subscription: *AgentSubscription,

        fn active(ctx: *anyopaque) bool {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            return self.peer.in_clients and self.peer.agent.subscriptions.get(self.event_type) == self.subscription;
        }
        fn send(ctx: *anyopaque, frame: []const u8) bool {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            return self.peer.server.sendAndWait(self.peer, frame);
        }
        fn close(ctx: *anyopaque, reason: []const u8) void {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            self.peer.socket.close(1013, reason);
        }
        fn free(ctx: *anyopaque) void {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            const server = self.peer.server;
            self.peer.release();
            server.allocator.destroy(self);
        }
    };

    fn consumeMessage(self: *Server, client: *AgentClient) bool {
        const now = self.loop.now();
        if (now - client.message_window >= 60_000) {
            client.message_window = now;
            client.messages = 0;
        }
        client.messages += 1;
        return client.messages <= MAX_CLIENT_MESSAGES;
    }

    // -- catch-up ------------------------------------------------------------------

    /// `catchUp` up to its first await (subscription lookup + reservation).
    fn startCatchUp(self: *Server, peer: *Peer, event_type: EventType) void {
        const subscription = peer.agent.subscriptions.get(event_type) orelse return;
        subscription.retain();
        peer.retain();
        if (self.catch_ups < self.limits.max_concurrent_catch_ups) {
            self.catch_ups += 1;
            self.loop.spawn(runCatchUp, .{ self, peer, subscription, @as(?*CatchUpWaiter, null) });
            return;
        }
        const waiter = self.allocator.create(CatchUpWaiter) catch oom();
        waiter.* = .{ .peer = peer };
        self.catch_up_waiters.append(self.allocator, waiter) catch oom();
        self.loop.spawn(runCatchUp, .{ self, peer, subscription, @as(?*CatchUpWaiter, waiter) });
    }

    fn runCatchUp(self: *Server, peer: *Peer, subscription: *AgentSubscription, waiter: ?*CatchUpWaiter) void {
        defer {
            subscription.release();
            peer.release();
        }
        if (waiter) |w| {
            while (w.resolved == null) self.loop.wait(&w.condition);
            const reserved = w.resolved.?;
            self.allocator.destroy(w);
            if (!reserved) return;
        }
        defer self.releaseCatchUp();
        const outcome = subscription.replay() catch |err| {
            if (!subscription.isActive()) {
                metrics.websocket_catch_ups.inc(.{"aborted"}, 1);
                return;
            }
            metrics.websocket_catch_ups.inc(.{"failure"}, 1);
            const event_type = subscription.event_type;
            if (peer.agent.subscriptions.get(event_type)) |current| {
                peer.agent.subscriptions.set(event_type, null);
                current.release();
            }
            self.logger.warn("websocket catch-up failed eventType={s}: {s}", .{ event_type.name(), errorMessage(err) });
            var buffer: [64]u8 = undefined;
            self.sendError(peer, std.fmt.bufPrint(&buffer, "Failed to catch up {s}", .{event_type.name()}) catch unreachable);
            return;
        };
        metrics.websocket_catch_ups.inc(.{@tagName(outcome)}, 1);
    }

    fn releaseCatchUp(self: *Server) void {
        self.catch_ups -= 1;
        if (self.catch_up_waiters.items.len == 0) return;
        const waiter = self.catch_up_waiters.orderedRemove(0);
        self.catch_ups += 1;
        waiter.resolved = true;
        waiter.condition.broadcast();
    }

    fn cancelCatchUp(self: *Server, peer: *Peer) void {
        var index = self.catch_up_waiters.items.len;
        while (index > 0) {
            index -= 1;
            const waiter = self.catch_up_waiters.items[index];
            if (waiter.peer != peer) continue;
            _ = self.catch_up_waiters.orderedRemove(index);
            waiter.resolved = false;
            waiter.condition.broadcast();
        }
    }

    // -- blocks ----------------------------------------------------------------------

    fn registerBlocks(self: *Server, peer: *Peer, domains: ?[]const u32) void {
        const subscription = self.allocator.create(BlockSubscription) catch oom();
        subscription.* = .{ .domains = if (domains) |d| self.allocator.dupe(u32, d) catch oom() else null };
        peer.blocks = subscription;
        self.block_subscriptions.put(self.allocator, peer, {}) catch oom();
    }

    /// The snapshot read of `subscribeBlocks`; notifications that arrived
    /// during the query win.
    fn loadBlocks(self: *Server, peer: *Peer) !void {
        const domains = if (peer.blocks) |b| b.domains else return;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const rows = try self.store.blockHeads(a, domains);
        for (rows) |row| {
            var diag: protocol.Diag = .{};
            const domain = protocol.parseDatabaseDomain(row.get("domain"), "", &diag) catch return runtime.fail("Invalid block domain", .{});
            const hash_value = row.get("hash");
            const hash = if (hash_value != null and hash_value.? == .string) try protocol.blockHashText(a, hash_value.?.string) else null;
            // The subscription may be gone after the await (disconnect).
            const subscription = peer.blocks orelse return;
            if (hash == null or subscription.latest.contains(domain)) continue;
            const frame = try blockFrame(self.allocator, domain, row.get("indexed_height") orelse .null, hash.?, row.get("head_height") orelse .null);
            subscription.latest.put(self.allocator, domain, SharedFrame.create(self.allocator, frame)) catch oom();
        }
    }

    fn blockFrame(allocator: Allocator, domain: u32, height: Value, hash: []const u8, head_height: Value) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(allocator);
        errdefer out.deinit();
        var o = try frames.Object.begin(&out.writer);
        try o.string("type", "block");
        try o.int("domain", domain);
        try o.val("height", height);
        try o.string("hash", hash);
        try o.val("headHeight", head_height);
        try o.end();
        return out.toOwnedSlice();
    }

    fn startBlocks(self: *Server, peer: *Peer) void {
        const subscription = peer.blocks orelse return;
        subscription.started = true;
        // Sends may terminate the peer (buffer limit) and free the subscription.
        const snapshot = self.allocator.dupe(*SharedFrame, subscription.latest.values()) catch oom();
        defer self.allocator.free(snapshot);
        for (snapshot) |frame| frame.refs += 1;
        defer for (snapshot) |frame| frame.release(self.allocator);
        for (snapshot) |frame| _ = self.send(peer, frame.bytes);
    }

    fn publishBlock(self: *Server, domain: u32, frame: *SharedFrame) void {
        const peers = self.allocator.dupe(*Peer, self.block_subscriptions.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            const subscription = peer.blocks orelse continue;
            if (!self.block_subscriptions.contains(peer)) continue;
            if (subscription.domains) |domains| if (std.mem.indexOfScalar(u32, domains, domain) == null) continue;
            if (subscription.latest.get(domain)) |previous| if (std.mem.eql(u8, previous.bytes, frame.bytes)) continue;
            frame.refs += 1;
            if (subscription.latest.fetchPut(self.allocator, domain, frame) catch oom()) |old| old.value.release(self.allocator);
            if (subscription.started) _ = self.send(peer, frame.bytes);
        }
    }

    fn clearBlocks(self: *Server, peer: *Peer) void {
        _ = self.block_subscriptions.orderedRemove(peer);
        const subscription = peer.blocks orelse return;
        peer.blocks = null;
        for (subscription.latest.values()) |frame| frame.release(self.allocator);
        subscription.latest.deinit(self.allocator);
        if (subscription.domains) |domains| self.allocator.free(domains);
        self.allocator.destroy(subscription);
    }

    // -- confirmation streams ----------------------------------------------------------

    const StreamBinding = struct {
        peer: *Peer,
        event_type: ?EventType,
        confirmations: u64,
        domains: []const u32,
        cursors: ?[]const protocol.StreamCursor,
        arena: std.heap.ArenaAllocator,
        stream: *ConfirmationStream = undefined,

        fn server(self: *StreamBinding) *Server {
            return self.peer.server;
        }
        fn active(ctx: *anyopaque) bool {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            return self.peer.in_clients or self.peer.in_explorer;
        }
        fn read(ctx: *anyopaque, domain: u32, after: cs.Position, through: i128, frontiers: *const cs.Frontiers) anyerror!cs.Reader {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            const store = &self.server().store;
            if (self.event_type) |event_type| {
                var addresses: ?[]const []const u8 = null;
                var scratch = std.heap.ArenaAllocator.init(store.allocator);
                defer scratch.deinit();
                if (self.cursors) |cursors| {
                    var list: std.ArrayList([]const u8) = .empty;
                    for (cursors) |cursor| if (cursor.domain == domain) try list.append(scratch.allocator(), cursor.address);
                    addresses = list.items;
                }
                return store.confirmationEventRows(event_type, domain, after, through, self.confirmations, addresses);
            }
            const ids = if (self.peer.in_explorer) self.peer.explorer.message_ids else null;
            return store.confirmationMessageRows(domain, after, through, frontiers, self.confirmations, ids);
        }
        fn send(ctx: *anyopaque, message: cs.Message) bool {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            return self.server().sendAndWait(self.peer, message.frame);
        }
        fn rollback(ctx: *anyopaque, domain: u32, from: i128, to: i128) void {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            var buffer: [256]u8 = undefined;
            var w = std.Io.Writer.fixed(&buffer);
            var o = frames.Object.begin(&w) catch unreachable;
            o.string("type", "rollback") catch unreachable;
            o.int("domain", domain) catch unreachable;
            if (self.event_type) |event_type| o.string("eventType", event_type.name()) catch unreachable;
            o.int("confirmations", self.confirmations) catch unreachable;
            o.bigString("fromHeight", from) catch unreachable;
            o.bigString("toHeight", to) catch unreachable;
            o.end() catch unreachable;
            _ = self.server().send(self.peer, w.buffered());
        }
        fn fail(ctx: *anyopaque, err: anyerror) void {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            const message = switch (err) {
                error.CustomMessageNotificationLimitExceeded => "Custom message notification limit exceeded",
                error.CustomProvisionalMessageLimitExceeded => "Custom provisional message limit exceeded",
                else => errorMessage(err),
            };
            self.server().failSocket(self.peer, message);
        }
        fn enrich(ctx: *anyopaque, ids: []const []const u8, frontiers: *const cs.Frontiers) anyerror!cs.EnrichResult {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            const server_ = self.server();
            var arena = std.heap.ArenaAllocator.init(server_.allocator);
            errdefer arena.deinit();
            const a = arena.allocator();
            var interested: std.ArrayList([]const u8) = .empty;
            for (ids) |id| if (!self.peer.in_explorer or self.peer.explorer.hasId(id)) try interested.append(a, id);
            if (interested.items.len == 0) return .{ .arena = arena, .messages = &.{} };
            const provisional = try server_.store.provisionalMessages(interested.items, frontiers);
            defer server_.store.releaseProvisional(provisional);
            var messages: std.ArrayList(cs.Enriched) = .empty;
            for (provisional.messages) |message| {
                const origin = try es.rowDomain(message.data, "origin_domain_id");
                const destination = try es.rowDomain(message.data, "destination_domain_id");
                if (std.mem.indexOfScalar(u32, self.domains, origin) == null and std.mem.indexOfScalar(u32, self.domains, destination) == null) continue;
                var out: std.Io.Writer.Allocating = .init(a);
                var o = try frames.Object.begin(&out.writer);
                try o.string("type", "message_upsert");
                try o.int("confirmations", self.confirmations);
                try o.val("data", try sub_mod.clone(a, message.data));
                try o.end();
                try messages.append(a, .{
                    .domains = try a.dupe(u32, message.domains),
                    .message = .{ .frame = out.written(), .message_id = if (message.msg_id) |id| try a.dupe(u8, id) else null },
                });
            }
            return .{ .arena = arena, .messages = messages.items };
        }
        fn free(ctx: *anyopaque) void {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            const server_ = self.server();
            self.arena.deinit();
            self.peer.release();
            server_.allocator.destroy(self);
        }
        fn readHeads(ctx: *anyopaque, allocator: Allocator) anyerror!cs.Heads {
            const self: *StreamBinding = @ptrCast(@alignCast(ctx));
            return self.server().store.confirmationHeads(allocator, self.domains);
        }
    };

    fn createConfirmationStream(
        self: *Server,
        peer: *Peer,
        confirmations: u64,
        domains: []const u32,
        event_type: ?EventType,
        cursors: ?[]const protocol.StreamCursor,
        /// TS `allowUnavailable = eventType === undefined`.
        allow_unavailable: bool,
    ) !*ConfirmationStream {
        // Deliver older queued heads before this stream takes its initial snapshot.
        self.confirmation_updates.flush();
        const binding = self.allocator.create(StreamBinding) catch oom();
        binding.* = .{
            .peer = peer,
            .event_type = event_type,
            .confirmations = confirmations,
            .domains = &.{},
            .cursors = null,
            .arena = .init(self.allocator),
        };
        peer.retain();
        const a = binding.arena.allocator();
        binding.domains = a.dupe(u32, domains) catch oom();
        if (cursors) |list| {
            const copy = a.alloc(protocol.StreamCursor, list.len) catch oom();
            for (list, copy) |cursor, *dest| {
                dest.* = cursor;
                dest.address = a.dupe(u8, cursor.address) catch oom();
            }
            binding.cursors = copy;
        }
        const stream = ConfirmationStream.create(self.allocator, self.loop, confirmations, domains, .{
            .ctx = binding,
            .active = StreamBinding.active,
            .read = StreamBinding.read,
            .send = StreamBinding.send,
            .rollback = StreamBinding.rollback,
            .fail = StreamBinding.fail,
            .enrich = if (event_type == null) StreamBinding.enrich else null,
            .deinit = StreamBinding.free,
        }) catch oom();
        binding.stream = stream;
        if (peer.streams == null) {
            peer.streams = .empty;
            self.confirmation_streams.put(self.allocator, peer, {}) catch oom();
        }
        peer.streams.?.append(self.allocator, stream) catch oom();
        stream.retain();
        defer stream.release();
        stream.initialize(.{ .ctx = binding, .read = StreamBinding.readHeads }, allow_unavailable) catch |err| {
            if (err == error.ConfirmationUnavailable) peer.unavailable_domain = stream.unavailable_domain;
            return err;
        };
        if (event_type) |kind| {
            var canonical: std.ArrayList(u8) = .empty;
            defer canonical.deinit(self.allocator);
            for (stream.domains) |domain| {
                if (stream.isCustom(domain)) continue;
                if (canonical.items.len > 0) canonical.append(self.allocator, ',') catch oom();
                canonical.print(self.allocator, "{d}", .{domain}) catch oom();
            }
            if (canonical.items.len > 0)
                self.logger.warn("websocket skipped advisory confirmations={d} eventType={s} domains={s}: near-head state unavailable", .{ confirmations, kind.name(), canonical.items });
        }
        return stream;
    }

    fn lastUnavailableDomain(_: *Server, peer: *Peer) u32 {
        return peer.unavailable_domain;
    }

    fn unavailableMessage(buffer: []u8, domain: u32) []const u8 {
        return std.fmt.bufPrint(buffer, "Custom confirmations unavailable for domain {d}", .{domain}) catch unreachable;
    }

    fn dropStreams(self: *Server, peer: *Peer) void {
        _ = self.confirmation_streams.orderedRemove(peer);
        var streams = peer.streams orelse return;
        peer.streams = null;
        for (streams.items) |stream| stream.release();
        streams.deinit(self.allocator);
    }

    fn notifyConfirmationStreams(self: *Server, head: protocol.HeadNotification) void {
        var snapshot: std.ArrayList(struct { peer: *Peer, stream: *ConfirmationStream }) = .empty;
        defer snapshot.deinit(self.allocator);
        for (self.confirmation_streams.keys()) |peer| {
            for (peer.streams.?.items) |stream| {
                stream.retain();
                snapshot.append(self.allocator, .{ .peer = peer, .stream = stream }) catch oom();
            }
        }
        defer for (snapshot.items) |entry| entry.stream.release();
        for (snapshot.items) |entry| {
            // JS Map iteration skips entries deleted meanwhile.
            if (!self.confirmation_streams.contains(entry.peer)) continue;
            entry.stream.notify(head);
        }
    }

    // -- notifications -------------------------------------------------------------------

    fn connectListener(self: *Server) void {
        self.listener_attempt += 1;
        const attempt = self.listener_attempt;
        const context = self.allocator.create(ListenerContext) catch oom();
        context.* = .{ .server = self, .attempt = attempt };
        self.listener_contexts.append(self.allocator, context) catch oom();
        const channels = [_][]const u8{ EVENT_CHANNEL, EXPLORER_CHANNEL, HEAD_CHANNEL };
        self.loop.unlock();
        const result = self.listen_api.listen(self.listen_api.ctx, &channels, .{
            .ctx = context,
            .on_notification = ListenerContext.onNotification,
            .on_disconnect = ListenerContext.onDisconnect,
        });
        self.loop.lock();
        const handle = result catch |err| {
            self.logger.err("database listener failed: {s}", .{errorMessage(err)});
            self.reconnectListener();
            return;
        };
        if (self.stopped or attempt != self.listener_attempt) {
            self.loop.unlock();
            self.listen_api.unlisten(self.listen_api.ctx, handle);
            self.loop.lock();
            return;
        }
        self.listener = handle;
        self.listener_ready = true;
    }

    const ListenerContext = struct {
        server: *Server,
        attempt: u64,

        fn onNotification(ctx: *anyopaque, channel: []const u8, payload: []const u8) void {
            const self: *ListenerContext = @ptrCast(@alignCast(ctx));
            const server_ = self.server;
            server_.loop.lock();
            defer server_.loop.unlock();
            if (self.attempt != server_.listener_attempt) return;
            server_.queueNotification(channel, payload);
        }

        fn onDisconnect(ctx: *anyopaque, message: ?[]const u8) void {
            const self: *ListenerContext = @ptrCast(@alignCast(ctx));
            const server_ = self.server;
            server_.loop.lock();
            defer server_.loop.unlock();
            if (self.attempt != server_.listener_attempt) return;
            server_.listenerDisconnected(message);
        }
    };

    fn queueNotification(self: *Server, channel: []const u8, payload: []const u8) void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var diag: protocol.Diag = .{};
        self.handleNotification(a, channel, payload, &diag) catch |err| {
            self.logger.warn("skipping invalid database notification: {s}", .{if (err == error.Invalid) diag.message else @errorName(err)});
        };
    }

    fn handleNotification(self: *Server, a: Allocator, channel: []const u8, payload: []const u8, diag: *protocol.Diag) !void {
        if (std.mem.eql(u8, channel, HEAD_CHANNEL)) {
            if (self.clients.count() == 0 and self.explorer_clients.count() == 0) return;
            const head = try protocol.parseHeadNotification(a, payload, diag);
            if (head.indexed_height != null and head.indexed_hash != null and head.head_height != null) {
                var out: std.Io.Writer.Allocating = .init(self.allocator);
                var o = frames.Object.begin(&out.writer) catch oom();
                o.string("type", "block") catch oom();
                o.int("domain", head.domain) catch oom();
                o.bigString("height", head.indexed_height.?) catch oom();
                o.string("hash", head.indexed_hash.?) catch oom();
                o.bigString("headHeight", head.head_height.?) catch oom();
                o.end() catch oom();
                const frame = SharedFrame.create(self.allocator, out.toOwnedSlice() catch oom());
                defer frame.release(self.allocator);
                self.publishBlock(head.domain, frame);
            }
            const rollback = if (head.previous_indexed_height) |previous|
                head.indexed_height != null and head.indexed_height.? < previous
            else
                false;
            if (rollback) {
                // A rollback must invalidate in-flight readers immediately; never
                // coalesce it away with a subsequent forward observation.
                _ = self.pending_heads.orderedRemove(head.domain);
                self.store.invalidateMessages();
                self.notifyConfirmationStreams(head);
            } else {
                var owned = head;
                owned.indexed_hash = null; // Not read by confirmation streams.
                self.pending_heads.put(self.allocator, head.domain, owned) catch oom();
                self.confirmation_updates.schedule();
            }
            const previous = head.previous_confirmed_height orelse return;
            if (head.confirmed_height <= previous) return;
            if (self.head_ranges.getPtr(head.domain)) |current| {
                current.after = if (current.after < previous) current.after else previous;
                current.through = if (current.through > head.confirmed_height) current.through else head.confirmed_height;
            } else {
                self.head_range_seq += 1;
                self.head_ranges.put(self.allocator, head.domain, .{ .after = previous, .through = head.confirmed_height, .seq = self.head_range_seq }) catch oom();
            }
            self.head_updates.schedule();
        } else if (std.mem.eql(u8, channel, EXPLORER_CHANNEL)) {
            const message_id = try protocol.parseExplorerNotification(a, payload, diag);
            self.queueExplorerNotification(message_id);
        } else {
            const notification = try protocol.parseEventNotification(a, payload, diag);
            if (!self.hasSubscriber(notification.domain, notification.event_type)) return;
            const key = std.fmt.allocPrint(a, "{s}:{d}", .{ notification.event_type.name(), notification.id }) catch oom();
            if (!self.notifications.contains(key) and self.notifications.count() >= MAX_PENDING_NOTIFICATIONS) {
                metrics.websocket_send_failures.inc(.{"notification_queue_limit"}, 1);
                metrics.websocket_notification_queue_overflows.inc(.{"agent"}, 1);
                self.failAgentStream("Agent notification queue limit exceeded");
                return;
            }
            self.notifications.put(self.allocator, key, notification) catch oom();
            self.agent_notifications.schedule();
        }
    }

    fn queueExplorerNotification(self: *Server, message_id: []const u8) void {
        if (!self.hasExplorerSubscriber(message_id)) return;
        if (!self.explorer_notifications.contains(message_id) and self.explorer_notifications.count() >= MAX_PENDING_NOTIFICATIONS) {
            metrics.websocket_send_failures.inc(.{"notification_queue_limit"}, 1);
            metrics.websocket_notification_queue_overflows.inc(.{"messages"}, 1);
            self.failExplorerStream("Explorer notification queue limit exceeded");
            return;
        }
        self.explorer_notifications.put(self.allocator, message_id, {}) catch oom();
        self.explorer_updates.schedule();
    }

    fn clearNotifications(self: *Server) void {
        self.notifications.clear(self.allocator);
    }

    fn clearExplorerNotifications(self: *Server) void {
        self.explorer_notifications.clear(self.allocator);
    }

    fn drainAgentThunk(ctx: *anyopaque) anyerror!void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        return self.drainAgentNotifications();
    }
    fn failAgentThunk(ctx: *anyopaque, err: anyerror) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.failAgentStream(errorMessage(err));
    }
    fn drainExplorerThunk(ctx: *anyopaque) anyerror!void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        return self.drainExplorerNotifications();
    }
    fn failExplorerThunk(ctx: *anyopaque, err: anyerror) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.failExplorerStream(errorMessage(err));
    }
    fn drainConfirmationThunk(ctx: *anyopaque) anyerror!void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        if (self.pending_heads.count() == 0) return;
        const heads = self.allocator.dupe(protocol.HeadNotification, self.pending_heads.values()) catch oom();
        defer self.allocator.free(heads);
        self.pending_heads.clearRetainingCapacity();
        self.store.invalidateMessages();
        for (heads) |head| self.notifyConfirmationStreams(head);
    }
    fn drainHeadThunk(ctx: *anyopaque) anyerror!void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.drainHeadNotifications();
    }
    fn failHeadThunk(ctx: *anyopaque, err: anyerror) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.logger.err("frontier publication failed: {s}", .{errorMessage(err)});
        self.head_updates.scheduleAfter(LISTENER_RETRY_MS);
    }

    fn drainAgentNotifications(self: *Server) !void {
        var batch: std.ArrayList(NotificationQueue(protocol.EventNotification).Entry) = .empty;
        defer batch.deinit(self.allocator);
        while (self.notifications.count() > 0) {
            self.notifications.takeFront(self.allocator, NOTIFICATION_BATCH_SIZE, &batch) catch oom();
            defer for (batch.items) |entry| self.allocator.free(entry.key);
            var order: std.ArrayList(EventType) = .empty;
            defer order.deinit(self.allocator);
            var grouped: std.EnumArray(EventType, std.ArrayList(protocol.EventNotification)) = .initFill(.empty);
            defer for (&grouped.values) |*list| list.deinit(self.allocator);
            for (batch.items) |entry| {
                const notification = entry.value;
                if (!self.hasSubscriber(notification.domain, notification.event_type)) continue;
                const list = grouped.getPtr(notification.event_type);
                if (list.items.len == 0) order.append(self.allocator, notification.event_type) catch oom();
                list.append(self.allocator, notification) catch oom();
            }
            for (order.items) |event_type| try self.publishNotifications(event_type, grouped.get(event_type).items);
        }
    }

    fn publishNotifications(self: *Server, event_type: EventType, notifications: []const protocol.EventNotification) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var expected: std.StringArrayHashMapUnmanaged(protocol.EventNotification) = .empty;
        for (notifications) |notification| expected.put(a, std.fmt.allocPrint(a, "{d}", .{notification.id}) catch oom(), notification) catch oom();
        const rows = try self.store.notifiedEvents(a, event_type, expected.keys());
        var returned: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (rows) |row| {
            const id = es.parseId(row.get("notification_id")) catch |err| {
                self.logger.warn("invalid notified {s} row ID: {s}", .{ event_type.name(), errorMessage(err) });
                continue;
            };
            returned.put(a, std.fmt.allocPrint(a, "{d}", .{id}) catch oom(), {}) catch oom();
        }
        var missing: std.ArrayList(u8) = .empty;
        for (expected.keys()) |id| {
            if (returned.contains(id)) continue;
            if (missing.items.len > 0) missing.appendSlice(a, ", ") catch oom();
            missing.appendSlice(a, id) catch oom();
        }
        if (missing.items.len > 0) self.logger.warn("missing notified {s} row IDs: {s}", .{ event_type.name(), missing.items });
        var events: std.ArrayList(Value) = .empty;
        const domain_column = es.domainColumn(event_type);
        for (rows) |row| {
            const event = es.without(a, row, &.{"notification_id"}) catch oom();
            const valid = blk: {
                const id = es.parseId(row.get("notification_id")) catch |err| break :blk err;
                const key = std.fmt.allocPrint(a, "{d}", .{id}) catch oom();
                const notification = expected.get(key) orelse
                    break :blk runtime.fail("Unexpected notified {s} row", .{event_type.name()});
                const domain = es.rowDomain(event, domain_column) catch |err| break :blk err;
                if (domain != notification.domain)
                    break :blk runtime.fail("Incorrect domain in {s} notification", .{event_type.name()});
                break :blk {};
            };
            valid catch |err| {
                self.logger.warn("skipping invalid notified {s} row: {s}", .{ event_type.name(), errorMessage(err) });
                continue;
            };
            events.append(a, event) catch oom();
        }
        try es.sortRows(a, event_type, events.items);
        for (events.items) |row| try self.publish(a, event_type, row);
    }

    /// `publish(eventType, row)`: deliver to live subscribers, buffer behind
    /// catch-ups. Throws on malformed rows like TS.
    fn publish(self: *Server, a: Allocator, event_type: EventType, row: Value) !void {
        const domain = try es.rowDomain(row, es.domainColumn(event_type));
        const key = try es.rowCursorKey(a, event_type, domain, row);
        var shared: ?[]const u8 = null;
        const peers = self.allocator.dupe(*Peer, self.clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            if (!peer.in_clients) continue;
            const subscription = peer.agent.subscriptions.get(event_type) orelse continue;
            if (!subscription.matches(domain, key)) continue;
            if (subscription.state == .live) {
                const delivery = switch (try subscription.eventForDelivery(a, row)) {
                    .skip, .gap => continue,
                    .deliver => |d| d,
                };
                // Gas payment envelopes include each subscriber's legacy cursor boundary.
                const payload = if (event_type == .gas_payment)
                    try sub_mod.eventFrame(a, event_type, row, delivery.domain, delivery.cursor, delivery.legacy_max_stream_cursor)
                else
                    shared orelse blk: {
                        shared = try sub_mod.eventFrame(a, event_type, row, delivery.domain, delivery.cursor, delivery.legacy_max_stream_cursor);
                        break :blk shared.?;
                    };
                _ = self.sendSerialized(peer, payload, .none);
            } else if (!(subscription.buffer(row) catch oom())) {
                self.disconnect(peer);
                peer.socket.close(1013, "Event catch-up buffer exceeded");
            }
        }
    }

    fn drainExplorerNotifications(self: *Server) !void {
        var batch: std.ArrayList(NotificationQueue(void).Entry) = .empty;
        defer batch.deinit(self.allocator);
        var ids: std.ArrayList([]const u8) = .empty;
        defer ids.deinit(self.allocator);
        while (self.explorer_notifications.count() > 0) {
            self.explorer_notifications.takeFront(self.allocator, EXPLORER_NOTIFICATION_BATCH_SIZE, &batch) catch oom();
            defer for (batch.items) |entry| self.allocator.free(entry.key);
            ids.clearRetainingCapacity();
            for (batch.items) |entry| ids.append(self.allocator, entry.key) catch oom();
            try self.publishExplorer(ids.items);
        }
    }

    fn publishExplorer(self: *Server, message_ids: []const []const u8) !void {
        if (self.explorer_clients.count() == 0) return;
        self.store.invalidateMessages();
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var canonical: std.StringArrayHashMapUnmanaged(void) = .empty;
        const peers = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            if (!peer.in_explorer) continue;
            var interested: std.ArrayList([]const u8) = .empty;
            for (message_ids) |id| if (peer.explorer.hasId(id)) interested.append(a, id) catch oom();
            if (interested.items.len == 0) continue;
            if (peer.explorer.custom) {
                if (peer.streams) |streams| {
                    const snapshot = self.allocator.dupe(*ConfirmationStream, streams.items) catch oom();
                    defer self.allocator.free(snapshot);
                    for (snapshot) |stream| stream.retain();
                    defer for (snapshot) |stream| stream.release();
                    for (snapshot) |stream| stream.refresh(interested.items);
                }
            } else for (interested.items) |id| canonical.put(a, id, {}) catch oom();
        }
        if (canonical.count() == 0) return;
        const rows = try self.store.canonicalMessages(a, canonical.keys());
        const Message = struct { id: ?[]const u8, frame: *SharedFrame };
        const messages = a.alloc(Message, rows.len) catch oom();
        for (rows, messages) |row, *message| {
            var out: std.Io.Writer.Allocating = .init(self.allocator);
            var o = frames.Object.begin(&out.writer) catch oom();
            o.val("data", row) catch oom();
            o.string("type", "message_upsert") catch oom();
            o.end() catch oom();
            const id = row.get("msg_id");
            message.* = .{
                .id = if (id != null and id.? == .string) id.?.string else null,
                .frame = SharedFrame.create(self.allocator, out.toOwnedSlice() catch oom()),
            };
        }
        defer for (messages) |message| message.frame.release(self.allocator);
        const current = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
        defer self.allocator.free(current);
        for (current) |peer| peer.retain();
        defer for (current) |peer| peer.release();
        for (current) |peer| {
            if (!peer.in_explorer or peer.explorer.custom) continue;
            var selected: std.ArrayList(*SharedFrame) = .empty;
            for (messages) |message| {
                if (peer.explorer.message_ids != null and (message.id == null or !peer.explorer.hasId(message.id.?))) continue;
                selected.append(a, message.frame) catch oom();
            }
            self.enqueueExplorer(peer, selected.items);
        }
    }

    fn enqueueExplorer(self: *Server, peer: *Peer, messages: []const *SharedFrame) void {
        const client = &peer.explorer;
        var bytes: usize = 0;
        for (messages) |message| bytes += message.bytes.len;
        if (client.queueLength() + messages.len > MAX_EXPLORER_PENDING_MESSAGES or client.queued_bytes + bytes > MAX_EXPLORER_PENDING_BYTES) {
            metrics.websocket_send_failures.inc(.{"queue_limit"}, 1);
            self.failSocket(peer, "outbound message queue limit exceeded");
            return;
        }
        for (messages) |message| {
            message.refs += 1;
            client.queue.append(self.allocator, message) catch oom();
        }
        client.queued_bytes += bytes;
        if (!client.sending) self.drainExplorerClient(peer);
    }

    /// `drainExplorerClient`: frames written inline continue at once; queued
    /// ones resume from their send completion.
    fn drainExplorerClient(self: *Server, peer: *Peer) void {
        const client = &peer.explorer;
        while (true) {
            client.sending = true;
            if (!peer.in_explorer or client.queueLength() == 0) {
                client.sending = false;
                return;
            }
            const message = client.queue.items[client.queue_head];
            client.queue_head += 1;
            if (client.queue_head == client.queue.items.len) {
                client.queue.clearRetainingCapacity();
                client.queue_head = 0;
            }
            client.queued_bytes -|= message.bytes.len;
            defer message.release(self.allocator);
            switch (self.sendFrame(peer, message.bytes, .explorer_drain)) {
                .failed => {
                    client.sending = false;
                    return;
                },
                .queued => return,
                .written => {},
            }
        }
    }

    fn clearExplorerQueue(self: *Server, peer: *Peer) void {
        const client = &peer.explorer;
        for (client.queue.items[client.queue_head..]) |message| message.release(self.allocator);
        client.queue.clearRetainingCapacity();
        client.queue_head = 0;
        client.queued_bytes = 0;
    }

    fn drainHeadNotifications(self: *Server) void {
        defer if (self.head_ranges.count() > 0)
            self.head_updates.scheduleAfter(if (self.head_failures.count() > 0) LISTENER_RETRY_MS else NOTIFICATION_BATCH_MS);
        // JS Map iteration: insertion order, entries added meanwhile included.
        var visited: u64 = 0;
        while (true) {
            var next: ?struct { domain: u32, range: HeadRange } = null;
            for (self.head_ranges.keys(), self.head_ranges.values()) |domain, range| {
                if (range.seq <= visited) continue;
                if (next == null or range.seq < next.?.range.seq) next = .{ .domain = domain, .range = range };
            }
            const entry = next orelse return;
            visited = entry.range.seq;
            const domain = entry.domain;
            var failure: HeadFailure = .{ .partial_agent = false, .explorer_affected = false };
            self.publishHeadRange(domain, entry.range, &failure) catch |err| {
                const failures = (self.head_failures.get(domain) orelse 0) + 1;
                self.head_failures.put(self.allocator, domain, failures) catch oom();
                const message = errorMessage(err);
                self.logger.err("frontier publication failed for domain {d} ({d}/{d}): frontier publication failed: {s}", .{ domain, failures, MAX_HEAD_PUBLICATION_FAILURES, message });
                if (failure.partial_agent or failures >= MAX_HEAD_PUBLICATION_FAILURES) {
                    var copy: [512]u8 = undefined;
                    const original = copy[0..@min(copy.len, message.len)];
                    @memcpy(original, message[0..original.len]);
                    self.failAgentDomain(domain, original);
                    if (failure.explorer_affected and self.explorer_clients.count() > 0) self.failExplorerStream(original);
                    self.releaseHeadRange(domain, entry.range);
                    _ = self.head_failures.orderedRemove(domain);
                }
                continue;
            };
            _ = self.head_failures.orderedRemove(domain);
            self.releaseHeadRange(domain, entry.range);
        }
    }

    /// Drop a handled range, keeping any extension that arrived meanwhile.
    fn releaseHeadRange(self: *Server, domain: u32, range: HeadRange) void {
        const current = self.head_ranges.getPtr(domain) orelse return;
        if (current.through <= range.through) {
            _ = self.head_ranges.orderedRemove(domain);
        } else {
            current.after = range.through;
        }
    }

    fn publishHeadRange(self: *Server, domain: u32, range: HeadRange, failure: *HeadFailure) !void {
        var agent_published = false;
        var explorer_pending = self.explorer_clients.count() > 0;
        // Delivery and gas share message ids; queue each Explorer id once per range.
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var explorer_ids: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (HEAD_PUBLICATION_ORDER) |event_type| {
            const agent_interested = self.hasSubscriber(domain, event_type);
            const explorer_interested = self.explorer_clients.count() > 0 and (event_type == .delivery or event_type == .gas_payment);
            if (!agent_interested and !explorer_interested) continue;
            var pages = self.store.headEvents(event_type, domain, range.after, range.through);
            defer pages.deinit();
            self.publishHeadPages(a, &pages, event_type, agent_interested, explorer_interested, &agent_published, &explorer_ids) catch |err| {
                failure.* = .{ .partial_agent = agent_published, .explorer_affected = explorer_pending };
                return err;
            };
            if (self.stopped) return;
            if (event_type == .gas_payment) explorer_pending = false;
        }
    }

    fn publishHeadPages(
        self: *Server,
        a: Allocator,
        pages: *es.EventStore.HeadEvents,
        event_type: EventType,
        agent_interested: bool,
        explorer_interested: bool,
        agent_published: *bool,
        explorer_ids: *std.StringArrayHashMapUnmanaged(void),
    ) !void {
        while (try pages.next()) |events| {
            if (self.stopped) return;
            if (agent_interested) {
                agent_published.* = true;
                for (events) |row| try self.publish(pages.page.allocator(), event_type, row);
            }
            if (explorer_interested and self.explorer_clients.count() > 0) {
                var batch: std.ArrayList([]const u8) = .empty;
                for (events) |row| {
                    const msg_id = row.get("msg_id");
                    const value = if (msg_id != null and msg_id.? != .null) msg_id else row.get("message_id");
                    const id = if (value != null and value.? == .string) value.?.string else continue;
                    if (explorer_ids.contains(id) or !self.hasExplorerSubscriber(id)) continue;
                    const owned = a.dupe(u8, id) catch oom();
                    explorer_ids.put(a, owned, {}) catch oom();
                    batch.append(a, owned) catch oom();
                }
                // A range after an outage can hold more ids than the queue cap;
                // queue page by page and let the drain make room first.
                self.waitForExplorerCapacity(batch.items.len);
                if (self.stopped) return;
                for (batch.items) |id| self.queueExplorerNotification(id);
            }
        }
    }

    fn waitForExplorerCapacity(self: *Server, count: usize) void {
        while (!self.stopped and self.explorer_clients.count() > 0 and
            @as(i64, @intCast(self.explorer_notifications.count())) > @as(i64, MAX_PENDING_NOTIFICATIONS) - @as(i64, @intCast(count)))
        {
            self.explorer_updates.flush();
        }
    }

    fn hasExplorerSubscriber(self: *Server, message_id: []const u8) bool {
        for (self.explorer_clients.keys()) |peer| if (peer.explorer.hasId(message_id)) return true;
        return false;
    }

    fn hasSubscriber(self: *Server, domain: u32, event_type: EventType) bool {
        for (self.clients.keys()) |peer| {
            const subscription = peer.agent.subscriptions.get(event_type) orelse continue;
            if (subscription.request.confirmations == null and subscription.matchesDomain(domain)) return true;
        }
        return false;
    }

    fn listenerDisconnected(self: *Server, message: ?[]const u8) void {
        self.listener_ready = false;
        const handle = self.listener;
        self.listener = null;
        self.listener_attempt += 1;
        if (message) |text| {
            self.logger.err("database listener disconnected: {s}", .{text});
        } else self.logger.err("database listener disconnected", .{});
        // Free the dead connection off the listener thread.
        if (handle) |h| self.loop.spawn(unlistenTask, .{ self, h });
        self.closeClients("Database event listener disconnected", 1013);
        self.reconnectListener();
    }

    fn unlistenTask(self: *Server, handle: *anyopaque) void {
        self.loop.unlock();
        defer self.loop.lock();
        self.listen_api.unlisten(self.listen_api.ctx, handle);
    }

    fn reconnectListener(self: *Server) void {
        if (self.stopped or self.listener_retry_timer != null) return;
        self.listener_retry_timer = self.loop.scheduler.schedule(LISTENER_RETRY_MS, self, onListenerRetryTimer);
    }

    fn onListenerRetryTimer(ctx: *anyopaque, id: u64) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.loop.spawn(listenerRetry, .{ self, id });
    }

    fn listenerRetry(self: *Server, id: u64) void {
        if (self.listener_retry_timer != id) return;
        self.listener_retry_timer = null;
        if (self.stopped) return;
        self.connectListener();
    }

    fn failAgentStream(self: *Server, message: []const u8) void {
        self.logger.err("agent event stream failed: {s}", .{message});
        self.closeAgentClients("Event stream read failed", 1013);
    }

    fn failAgentDomain(self: *Server, domain: u32, message: []const u8) void {
        self.logger.err("agent event stream failed for domain {d}: {s}", .{ domain, message });
        const peers = self.allocator.dupe(*Peer, self.clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| {
            if (!peer.in_clients) continue;
            var matches = false;
            for (peer.agent.subscriptions.values) |entry| {
                if (entry) |subscription| if (subscription.matchesDomain(domain)) {
                    matches = true;
                };
            }
            if (!matches) continue;
            self.disconnect(peer);
            peer.socket.close(1013, "Event stream read failed");
        }
    }

    fn failExplorerStream(self: *Server, message: []const u8) void {
        self.logger.err("Explorer event stream failed: {s}", .{message});
        self.closeExplorerClients("Event stream read failed", 1013);
    }

    fn closeClients(self: *Server, reason: []const u8, code: u16) void {
        for (self.confirmation_streams.keys()) |peer| {
            var streams = peer.streams.?;
            peer.streams = null;
            for (streams.items) |stream| stream.release();
            streams.deinit(self.allocator);
        }
        self.confirmation_streams.clearRetainingCapacity();
        self.pending_heads.clearRetainingCapacity();
        self.store.invalidateMessages();
        self.closeAgentClients(reason, code);
        self.closeExplorerClients(reason, code);
    }

    fn closeAgentClients(self: *Server, reason: []const u8, code: u16) void {
        self.clearNotifications();
        self.head_ranges.clearRetainingCapacity();
        self.head_failures.clearRetainingCapacity();
        const peers = self.allocator.dupe(*Peer, self.clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| {
            self.disconnect(peer);
            peer.socket.close(code, reason);
        }
        self.clients.clearRetainingCapacity();
    }

    fn closeExplorerClients(self: *Server, reason: []const u8, code: u16) void {
        self.clearExplorerNotifications();
        const peers = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| {
            self.disconnect(peer);
            peer.socket.close(code, reason);
        }
        self.explorer_clients.clearRetainingCapacity();
        for (self.explorer_clients_by_ip.keys()) |ip| self.allocator.free(ip);
        self.explorer_clients_by_ip.clearRetainingCapacity();
    }

    /// Runs on the process timer thread. Taking the loop mutex here is safe:
    /// `SharedScheduler.cancel` never waits for a callback that already fired.
    fn onHeartbeatTimer(ctx: *anyopaque, id: u64) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.loop.lock();
        defer self.loop.unlock();
        if (self.heartbeat_timer != id or self.stopped) return;
        self.heartbeat_timer = self.loop.scheduler.schedule(self.limits.heartbeat_ms, self, onHeartbeatTimer);
        self.heartbeat();
    }

    fn heartbeat(self: *Server) void {
        var buffer: [80]u8 = undefined;
        const frame = std.fmt.bufPrint(&buffer, "{{\"serverTime\":\"{s}\",\"type\":\"heartbeat\"}}", .{isoTime(self.loop.now())}) catch unreachable;
        for ([_]Route{ .agent, .explorer }) |route| {
            const map = if (route == .agent) &self.clients else &self.explorer_clients;
            const peers = self.allocator.dupe(*Peer, map.keys()) catch oom();
            defer self.allocator.free(peers);
            for (peers) |peer| peer.retain();
            defer for (peers) |peer| peer.release();
            for (peers) |peer| {
                if (!map.contains(peer)) continue;
                const alive = if (route == .agent) &peer.agent.alive else &peer.explorer.alive;
                if (!alive.*) {
                    self.terminateSocket(peer);
                    continue;
                }
                alive.* = false;
                peer.socket.ping();
                _ = self.send(peer, frame);
            }
        }
    }

    // -- sending ---------------------------------------------------------------------

    fn send(self: *Server, peer: *Peer, bytes: []const u8) bool {
        return self.sendSerialized(peer, bytes, .none);
    }

    /// `sendAndWait`: blocks this task (mutex released) until the frame is
    /// written or fails.
    fn sendAndWait(self: *Server, peer: *Peer, bytes: []const u8) bool {
        var waiter: Waiter = .{};
        if (!self.sendSerialized(peer, bytes, .{ .waiter = &waiter })) return false;
        if (waiter.event.isSet()) return waiter.ok; // written inline
        self.loop.unlock();
        waiter.event.wait();
        self.loop.lock();
        return waiter.ok;
    }

    fn sendSerialized(self: *Server, peer: *Peer, bytes: []const u8, kind: SendJob.Kind) bool {
        return self.sendFrame(peer, bytes, kind) != .failed;
    }

    const SendOutcome = enum { failed, queued, written };

    /// `sendSerialized`, also reporting a frame written inline (no completion
    /// follows for it).
    fn sendFrame(self: *Server, peer: *Peer, bytes: []const u8, kind: SendJob.Kind) SendOutcome {
        if (peer.terminated) return .failed;
        const state = peer.socket.snapshot();
        if (!state.open) return .failed;
        if (state.buffered + bytes.len > self.limits.max_buffered_bytes or
            self.pending_bytes.load(.monotonic) + bytes.len > self.limits.max_total_buffered_bytes)
        {
            metrics.websocket_send_failures.inc(.{"buffer_limit"}, 1);
            self.failSocket(peer, "outbound buffer limit exceeded");
            return .failed;
        }
        if (kind != .diagnostics) if (peer.socket.vtable.try_send_inline) |try_inline| {
            switch (try_inline(peer.socket.ptr, bytes)) {
                .written => switch (kind) {
                    // An awaited send resumes after its callback, which has
                    // released the bytes by then: complete now, uncharged.
                    .waiter => |waiter| {
                        waiter.finish(true);
                        return .written;
                    },
                    // Node fires the write callback after the current synchronous
                    // code even for a synchronous write: keep the bytes charged
                    // (aggregate limit decisions across a fan-out loop) and run
                    // the callback at the end of this turn.
                    .none, .explorer_drain => {
                        _ = self.pending_bytes.fetchAdd(bytes.len, .monotonic);
                        peer.retain();
                        self.deferred.append(self.allocator, .{ .peer = peer, .len = bytes.len, .drain = kind == .explorer_drain }) catch oom();
                        return if (kind == .explorer_drain) .queued else .written;
                    },
                    .diagnostics => unreachable,
                },
                .failed => {
                    if (kind == .waiter) kind.waiter.finish(false);
                    self.failSend(peer, "WebSocket is not open");
                    return .failed;
                },
                .busy => {},
            }
        };
        _ = self.pending_bytes.fetchAdd(bytes.len, .monotonic);
        const job = self.allocator.create(SendJob) catch oom();
        job.* = .{ .server = self, .peer = peer, .len = bytes.len, .kind = kind };
        peer.retain();
        if (!peer.socket.send(bytes, job)) {
            _ = self.pending_bytes.fetchSub(bytes.len, .monotonic);
            self.allocator.destroy(job);
            peer.release();
            self.failSend(peer, "WebSocket is not open");
            return .failed;
        }
        return .queued;
    }

    fn failSocket(self: *Server, peer: *Peer, reason: []const u8) void {
        if (peer.terminated) return;
        self.logger.warn("terminating websocket: {s}", .{reason});
        self.terminateSocket(peer);
    }

    fn failSend(self: *Server, peer: *Peer, reason: []const u8) void {
        if (peer.terminated) return;
        metrics.websocket_send_failures.inc(.{"send_error"}, 1);
        var buffer: [256]u8 = undefined;
        self.failSocket(peer, std.fmt.bufPrint(&buffer, "send failed: {s}", .{reason}) catch "send failed");
    }

    fn terminateSocket(self: *Server, peer: *Peer) void {
        if (peer.terminated) return;
        peer.terminated = true;
        self.disconnect(peer);
        peer.socket.terminate();
    }

    fn disconnect(self: *Server, peer: *Peer) void {
        self.clearBlocks(peer);
        self.dropStreams(peer);
        self.cancelCatchUp(peer);
        self.clearSubscriptions(peer);
        if (peer.in_clients) {
            peer.in_clients = false;
            _ = self.clients.orderedRemove(peer);
        }
        if (peer.in_explorer) {
            peer.in_explorer = false;
            self.clearExplorerQueue(peer);
            self.releaseExplorerClient(peer.explorer.ip);
            _ = self.explorer_clients.orderedRemove(peer);
        }
        if (self.clients.count() == 0 and self.explorer_clients.count() == 0) self.pending_heads.clearRetainingCapacity();
    }

    fn clearSubscriptions(_: *Server, peer: *Peer) void {
        for (&peer.agent.subscriptions.values) |*entry| {
            if (entry.*) |subscription| subscription.release();
            entry.* = null;
        }
    }

    fn releaseExplorerClient(self: *Server, ip: []const u8) void {
        const index = self.explorer_clients_by_ip.getIndex(ip) orelse return;
        const count = &self.explorer_clients_by_ip.values()[index];
        if (count.* == 1) {
            const key = self.explorer_clients_by_ip.keys()[index];
            self.explorer_clients_by_ip.orderedRemoveAt(index);
            self.allocator.free(key);
        } else count.* -= 1;
    }

    fn rejectNegotiation(self: *Server, peer: *Peer, message: []const u8) void {
        self.sendError(peer, message);
        self.disconnect(peer);
        peer.socket.close(1008, "Invalid subscription");
    }

    fn sendError(self: *Server, peer: *Peer, message: []const u8) void {
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        var o = frames.Object.begin(&out.writer) catch oom();
        o.string("error", message) catch oom();
        o.string("type", "error") catch oom();
        o.end() catch oom();
        _ = self.send(peer, out.written());
    }
};

fn dupeStrings(allocator: Allocator, items: []const []const u8) []const []const u8 {
    const out = allocator.alloc([]const u8, items.len) catch oom();
    for (items, out) |item, *copy| copy.* = allocator.dupe(u8, item) catch oom();
    return out;
}

fn freeStrings(allocator: Allocator, items: []const []const u8) void {
    for (items) |item| allocator.free(item);
    allocator.free(items);
}

/// `new Date(ms).toISOString()`.
pub fn isoTime(ms: i64) [24]u8 {
    var out: [24]u8 = undefined;
    const seconds: u64 = @intCast(@divFloor(ms, 1000));
    const millis: u64 = @intCast(@mod(ms, 1000));
    const epoch: std.time.epoch.EpochSeconds = .{ .secs = seconds };
    const day = epoch.getEpochDay().calculateYearDay();
    const month_day = day.calculateMonthDay();
    const time = epoch.getDaySeconds();
    _ = std.fmt.bufPrint(&out, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        day.year,                     month_day.month.numeric(),     month_day.day_index + 1,
        time.getHoursIntoDay(),       time.getMinutesIntoHour(),     time.getSecondsIntoMinute(),
        millis,
    }) catch unreachable;
    return out;
}
