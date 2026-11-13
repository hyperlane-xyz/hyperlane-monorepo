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
/// Corked peers per write thread at turn end (fewer: written lazily).
const PARALLEL_FLUSH_MIN = 64;
const PARALLEL_FLUSH_THREADS = 4;
/// Cork bounds per peer and turn (memory only; limits are decided exactly).
const MAX_CORKED_FRAMES = 256;
const MAX_CORKED_BYTES = 256 * 1024;

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
        /// `job` completes only for `.partial` (once the queued remainder is
        /// written, possibly before this returns), like a queued send; the
        /// socket keeps the whole frame in `bufferedAmount` until then.
        try_send_inline: ?*const fn (ptr: *anyopaque, bytes: []const u8, job: *SendJob) InlineResult = null,
        /// Optional: write several frames with one syscall. Frames before
        /// `.done.written` reached the kernel (their jobs never complete);
        /// the next `.done.queued` frames were queued whole, in order and
        /// atomically with the write (the one the kernel stopped inside,
        /// and every frame before `required`), and complete their jobs once
        /// written; later frames were not touched. If something was queued
        /// already (or the kernel took nothing), the frames before
        /// `required` are queued behind it. `.closed`: not OPEN, nothing
        /// done. `.failed`: the write failed (the socket is destroyed). In
        /// both no job is touched.
        try_send_inline_many: ?*const fn (ptr: *anyopaque, payloads: []const []const u8, jobs: []const *SendJob, required: usize) ManyResult = null,
    };

    pub const ManyResult = union(enum) { done: struct { written: usize, queued: usize }, closed, failed };

    /// `buffered`: what ws holds now. `control`: the part that is ws's own
    /// frames (pongs, pings, close; no completion), which live cannot
    /// mirror but Node's `bufferedAmount` counts.
    pub const Snapshot = struct { open: bool, buffered: usize, control: usize = 0 };

    pub const InlineResult = enum {
        /// The whole frame reached the kernel; `job` will not complete.
        written,
        /// Part reached the kernel, the rest is queued; `job` completes then
        /// (Node: the write went async and its callback waits for it).
        partial,
        /// Queue busy or kernel buffer full: nothing written, use `send`.
        busy,
        /// Not OPEN any more (closing or closed): nothing written.
        closed,
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
    /// A drain lookahead frame (`planFlush`): excluded from the checks
    /// (`lookahead_unconsumed`) until `sendLookahead`.
    lookahead: bool = false,
    /// Its Node write request (`Peer.requests`, by absolute index).
    request: u64 = 0,
    /// Outcome reported by ws (`complete`), applied in `passEnd`.
    ok: bool = false,

    const Kind = union(enum) {
        none,
        waiter: *Waiter,
        explorer_drain,
        diagnostics: diagnostics.stream.Completion,
    };

    /// ws wrote the frame (or failed it). Only recorded: live applies the
    /// completions of a ws flush pass together when it ends
    /// (`Server.passEnd`), as the Node macrotask that runs them would.
    pub fn complete(self: *SendJob, ok: bool) void {
        const peer = self.peer;
        peer.completion_mutex.lock();
        defer peer.completion_mutex.unlock();
        peer.completed.append(self.server.allocator, .{ .job = self, .ok = ok }) catch oom();
    }
};

const Completed = struct { job: *SendJob, ok: bool };

/// One Node write request: a frame written alone, or the frames buffered
/// while the one before was in flight (written together, one writev).
const Request = struct {
    jobs: std.ArrayList(*SendJob) = .empty,
    done: usize = 0,
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
    /// Non-awaited frames sent this turn, written with one syscall when the
    /// turn ends or before any other operation on the socket (`flushCork`).
    cork: Cork = .{},
    /// ws completions not applied yet (`Server.passEnd`); ws's threads
    /// append under `completion_mutex` without the loop mutex.
    completion_mutex: std.Thread.Mutex = .{},
    completed: std.ArrayList(Completed) = .empty,
    /// Node's write requests on this socket (loop mutex): frames handed to ws
    /// and not written whole at once. The first is in flight; frames sent
    /// meanwhile form the next one, written together when it ends.
    requests: std.ArrayList(Request) = .empty,
    /// Absolute index of `requests[0]`.
    request_base: u64 = 0,
    /// Node's `bufferedAmount` (its writable length) for this socket:
    /// framed bytes of the frames in `requests` (and of a frame being
    /// written), released when its whole request is. Limit checks use this,
    /// not ws's counter, which drops each frame as it is written.
    node_buffered: std.atomic.Value(usize) = .init(0),

    fn bufferedAmount(self: *Peer) usize {
        return self.node_buffered.load(.monotonic) + self.socket.snapshot().control;
    }

    fn addBuffered(self: *Peer, len: usize) void {
        _ = self.node_buffered.fetchAdd(len + frameHeaderLen(len), .monotonic);
    }

    fn subBuffered(self: *Peer, len: usize) void {
        _ = self.node_buffered.fetchSub(len + frameHeaderLen(len), .monotonic);
    }

    pub fn retain(self: *Peer) void {
        _ = self.refs.fetchAdd(1, .monotonic);
    }

    /// Socket operations flush the cork first: corked frames were sent before.
    fn wsClose(self: *Peer, code: u16, reason: []const u8) void {
        self.server.flushCork(self, false);
        self.socket.close(code, reason);
    }
    fn wsTerminate(self: *Peer) void {
        self.server.flushCork(self, false);
        self.socket.terminate();
    }
    fn wsPing(self: *Peer) void {
        self.server.flushCork(self, false);
        self.socket.ping();
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
        self.cork.deinit(server.allocator);
        std.debug.assert(self.requests.items.len == 0 and self.completed.items.len == 0);
        self.requests.deinit(server.allocator);
        self.completed.deinit(server.allocator);
        self.socket.vtable.release(self.socket.ptr);
        server.allocator.destroy(self);
    }
};

const Cork = struct {
    bytes: std.ArrayList(u8) = .empty,
    frames: std.ArrayList(struct { start: usize, len: usize, job: *SendJob, drain: bool }) = .empty,
    /// Upper bound of what the corked frames add to `bufferedAmount`.
    framed: usize = 0,
    /// In `Server.corked` (once per turn, however often it is flushed).
    listed: bool = false,
    /// Flush outcome per corked frame, consumed in order by the frames'
    /// `Deferred` entries.
    outcomes: std.ArrayList(Outcome) = .empty,
    outcome_head: usize = 0,
    /// The drain's next frame, written together with the frame whose write
    /// callback sends it (see `flushCork`); consumed by that send.
    lookahead: ?struct { bytes: []const u8, job: *SendJob, outcome: Lookahead } = null,

    const Outcome = enum {
        /// Reached the kernel: released by its deferred callback.
        written,
        /// Queued in ws: its job releases it once written.
        queued,
        /// The socket failed: already released.
        failed,
    };

    const Lookahead = enum { written, partial, untouched };

    fn deinit(self: *Cork, allocator: Allocator) void {
        std.debug.assert(self.frames.items.len == 0 and self.lookahead == null);
        self.bytes.deinit(allocator);
        self.frames.deinit(allocator);
        self.outcomes.deinit(allocator);
    }

    fn takeOutcome(self: *Cork) Outcome {
        const value = self.outcomes.items[self.outcome_head];
        self.outcome_head += 1;
        if (self.outcome_head == self.outcomes.items.len) {
            self.outcomes.clearRetainingCapacity();
            self.outcome_head = 0;
        }
        return value;
    }
};

/// WebSocket frame header size for a text payload of `len` bytes.
fn frameHeaderLen(len: usize) usize {
    return if (len < 126) 2 else if (len <= 0xffff) 4 else 10;
}

const HeadRange = struct { after: i128, through: i128, seq: u64 };

/// A write callback Node would run after the current synchronous code.
/// `corked`: a frame held in its peer's cork; it is released only if the
/// flush wrote it fully (otherwise its job does, once the socket writes it).
const Deferred = struct { peer: *Peer, len: usize, drain: bool, corked: bool = false };

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
    heartbeat_hold: if (runtime.hold_stats) runtime.HoldHistogram else void = if (runtime.hold_stats) .{} else {},
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
    /// Bumped by every head or event notification for a domain
    /// (`replayEpoch`): a replay page read ahead of its turn is dropped if one
    /// was processed.
    head_epochs: std.AutoHashMapUnmanaged(u32, u64) = .empty,
    /// Bumped when every stream restarts (listener lost, stop).
    epoch_base: u64 = 0,
    /// Charges of lookahead frames written but not yet sent by their drain.
    lookahead_unconsumed: usize = 0,
    /// Peers corked this turn (one reference each; a flushed peer stays).
    corked: std.ArrayList(*Peer) = .empty,
    /// Cork non-awaited and drain frames per peer and turn, and batch replay
    /// rows (tests compare against uncorked writes and per-row replay).
    coalesce: bool = true,
    /// Write corks at the turn's end on several threads once at least this
    /// many peers are corked (tests lower it).
    parallel_flush_min: usize = PARALLEL_FLUSH_MIN,
    /// At most one write thread per CPU this process may run on.
    parallel_flush_threads: usize = PARALLEL_FLUSH_THREADS,
    /// Tests: what a send's limit checks see (Node's `bufferedAmount` and
    /// `pendingBytes`), before the frame is charged.
    send_observer: ?struct { ctx: *anyopaque, func: *const fn (ctx: *anyopaque, buffered: usize, pending: usize) void } = null,
    /// Scratch for `flushCork`.
    flush_payloads: std.ArrayList([]const u8) = .empty,
    flush_jobs: std.ArrayList(*SendJob) = .empty,
    /// Scratch for `applyCompletions`.
    completions_scratch: std.ArrayList(Completed) = .empty,
    released_scratch: std.ArrayList(*SendJob) = .empty,
    /// The LISTEN connection being opened ahead of `start`.
    early_listen: ?*EarlyListen = null,
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
            .parallel_flush_threads = @max(1, @min(PARALLEL_FLUSH_THREADS, std.Thread.getCpuCount() catch 1)),
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
        self.flush_payloads.deinit(a);
        self.corked.deinit(a);
        self.head_epochs.deinit(a);
        self.flush_jobs.deinit(a);
        self.completions_scratch.deinit(a);
        self.released_scratch.deinit(a);
        for (self.listener_contexts.items) |context| a.destroy(context);
        self.listener_contexts.deinit(a);
        a.destroy(self);
    }

    /// The deferred write callbacks of inline-written frames (successful, like
    /// the ws callback): release their bytes, then resume Explorer drains.
    fn endTurnThunk(ctx: *anyopaque) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        if (self.corked.items.len >= self.parallel_flush_min) self.flushCorksInParallel();
        self.runDeferred();
        self.clearCorked();
    }

    fn runDeferred(self: *Server) void {
        var index: usize = 0;
        while (index < self.deferred.items.len) : (index += 1) {
            const item = self.deferred.items[index];
            if (item.corked) {
                // The first callback of a corked peer writes its whole cork
                // (with the drain's next frame when this is a drain frame).
                // (An earlier flush may have written it: then its outcome waits.)
                const cork = &item.peer.cork;
                if (cork.outcomes.items.len == 0 and cork.frames.items.len > 0) self.flushCork(item.peer, item.drain);
                if (item.peer.cork.takeOutcome() == .written) {
                    _ = self.pending_bytes.fetchSub(item.len, .monotonic);
                    if (item.drain) self.drainExplorerClient(item.peer);
                }
                // A lookahead frame is only written when its send is certain.
                std.debug.assert(item.peer.cork.lookahead == null);
                item.peer.release();
                continue;
            }
            _ = self.pending_bytes.fetchSub(item.len, .monotonic);
            if (item.drain) self.drainExplorerClient(item.peer);
            item.peer.release();
        }
        self.deferred.clearRetainingCapacity();
    }

    fn clearCorked(self: *Server) void {
        for (self.corked.items) |peer| {
            peer.cork.listed = false;
            peer.release();
        }
        self.corked.clearRetainingCapacity();
    }

    /// A frame handed to ws that was not written whole at once (loop mutex
    /// held, before any later frame of the peer): in Node it is the request
    /// in flight if there is none, else part of the next one.
    fn trackQueued(self: *Server, peer: *Peer, job: *SendJob) void {
        const requests = &peer.requests;
        if (requests.items.len < 2) requests.append(self.allocator, .{}) catch oom();
        const last = requests.items.len - 1;
        job.request = peer.request_base + last;
        requests.items[last].jobs.append(self.allocator, job) catch oom();
    }

    /// ws finished a flush pass on `peer`'s socket (called with no lock
    /// held, after ws released the socket): apply what it completed.
    pub fn passEnd(self: *Server, peer: *Peer) void {
        // A poller waiting for the loop mutex hands its other sockets off
        // (`Loop.lock` uses `core.blocking`).
        self.loop.lock();
        defer self.loop.unlock();
        self.passEndLocked(peer);
    }

    /// `passEnd` with the loop mutex held (tests that observe the moment).
    pub fn passEndLocked(self: *Server, peer: *Peer) void {
        self.applyCompletions(peer);
    }

    /// Node's macrotask for the completed writes: each request whose frames
    /// are all written leaves the writable length and runs its callbacks; a
    /// request written whole at the moment the one before it ended was
    /// synchronous (its callbacks are nextTicks, still before any
    /// continuation). Then the continuations (awaited sends, drains), in
    /// order. A request partly written stays counted whole.
    fn applyCompletions(self: *Server, peer: *Peer) void {
        peer.retain();
        defer peer.release();
        self.completions_scratch.clearRetainingCapacity();
        {
            peer.completion_mutex.lock();
            defer peer.completion_mutex.unlock();
            self.completions_scratch.appendSlice(self.allocator, peer.completed.items) catch oom();
            peer.completed.clearRetainingCapacity();
        }
        for (self.completions_scratch.items) |c| {
            c.job.ok = c.ok;
            peer.requests.items[@intCast(c.job.request - peer.request_base)].done += 1;
        }
        self.released_scratch.clearRetainingCapacity();
        while (peer.requests.items.len > 0 and peer.requests.items[0].done == peer.requests.items[0].jobs.items.len) {
            var request = peer.requests.orderedRemove(0);
            peer.request_base += 1;
            self.released_scratch.appendSlice(self.allocator, request.jobs.items) catch oom();
            request.jobs.deinit(self.allocator);
        }
        const released = self.allocator.dupe(*SendJob, self.released_scratch.items) catch oom();
        defer self.allocator.free(released);
        // Callbacks: the bytes leave the counts.
        var failed = false;
        for (released) |job| {
            peer.subBuffered(job.len);
            _ = self.pending_bytes.fetchSub(job.len, .monotonic);
            failed = failed or !job.ok;
        }
        if (failed) self.failSend(peer, "WebSocket is not open");
        // Continuations (Node's microtasks), in order, before any other
        // turn: a blocked task resumes in its turn (`Loop.lockHandoff`), the
        // others run when they reach the head of the queue.
        for (released) |job| {
            const ok = job.ok;
            switch (job.kind) {
                .none => {
                    self.allocator.destroy(job);
                    peer.release();
                },
                .waiter => |waiter| {
                    self.allocator.destroy(job);
                    peer.release();
                    resumeWaiter(self.loop, waiter, ok);
                },
                // The job (and its peer reference) goes to the continuation.
                .explorer_drain, .diagnostics => self.loop.handOff(.{ .run = .{ .ctx = job, .func = continueSend } }),
            }
        }
    }

    /// Handoff invariant I2: a task's handoff is queued in the same critical
    /// section (loop mutex held) as the wake of the task it resumes, and
    /// that task has not been woken before.
    fn resumeWaiter(loop: *runtime.Loop, waiter: *Waiter, ok: bool) void {
        std.debug.assert(!waiter.event.isSet());
        loop.handOff(.{ .task = waiter });
        waiter.finish(ok);
    }

    /// An Explorer drain's or a diagnostics send's continuation.
    fn continueSend(ctx: *anyopaque) void {
        const job: *SendJob = @ptrCast(@alignCast(ctx));
        const self = job.server;
        const peer = job.peer;
        const ok = job.ok;
        const kind = job.kind;
        self.allocator.destroy(job);
        defer peer.release();
        switch (kind) {
            .explorer_drain => if (ok) self.drainExplorerClient(peer) else {
                peer.explorer.sending = false;
            },
            .diagnostics => |done| done.complete(ok),
            .none, .waiter => unreachable,
        }
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
        // Startup failed before `start` adopted it: close it, silently.
        const early = self.takeEarlyListen();
        self.loop.unlock();
        if (listener) |handle| self.listen_api.unlisten(self.listen_api.ctx, handle);
        if (early) |taken| if (taken.result) |handle| self.listen_api.unlisten(self.listen_api.ctx, handle) else |_| {};
        self.loop.lock();
        self.closeClients("Server stopping", 1001);
        self.loop.unlock();
        self.logHoldTimes();
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
        for (self.clients.keys()) |peer| max_buffered = @max(max_buffered, peer.bufferedAmount());
        for (self.explorer_clients.keys()) |peer| {
            const client = &peer.explorer;
            explorer_messages += client.queueLength();
            explorer_bytes += client.queued_bytes;
            max_explorer_bytes = @max(max_explorer_bytes, client.queued_bytes);
            max_explorer_messages = @max(max_explorer_messages, client.queueLength());
            max_buffered = @max(max_buffered, peer.bufferedAmount());
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
        if (2 * (peer.bufferedAmount() + bytes.len) > self.limits.max_buffered_bytes or
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
            peer.wsClose(1001, "Server stopping");
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
                peer.wsClose(1013, "Database event listener unavailable");
            } else if (peer.route == .agent) {
                peer.wsClose(1013, "Maximum agent websocket clients reached");
            } else peer.wsClose(1013, "Maximum explorer websocket clients reached");
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
            peer.wsClose(1008, "Client message rate limit exceeded");
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
                // Tests compare batched replay against TS's per-row loop.
                .send_all = if (self.coalesce) SubscriptionBinding.sendAll else null,
                .close = SubscriptionBinding.close,
                .deinit = SubscriptionBinding.free,
                .epoch = SubscriptionBinding.epoch,
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
        fn sendAll(ctx: *anyopaque, batch: []const []const u8) ?usize {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            return self.peer.server.sendAllAndWait(self.peer, batch);
        }
        fn close(ctx: *anyopaque, reason: []const u8) void {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            self.peer.wsClose(1013, reason);
        }
        fn epoch(ctx: *anyopaque, domain: u32) u64 {
            const self: *SubscriptionBinding = @ptrCast(@alignCast(ctx));
            return self.peer.server.replayEpoch(domain);
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

    const listen_channels = [_][]const u8{ EVENT_CHANNEL, EXPLORER_CHANNEL, HEAD_CHANNEL };

    /// A listener connected ahead of `start` (`listenEarly`).
    const EarlyListen = struct {
        server: *Server,
        context: *ListenerContext,
        thread: std.Thread = undefined,
        result: anyerror!*anyopaque = error.Pending,

        fn run(self: *EarlyListen) void {
            self.result = self.server.listen_api.listen(self.server.listen_api.ctx, &listen_channels, self.context.handler());
        }
    };

    /// Connect the LISTEN connection while the rest of startup runs (TS
    /// awaits it inside `start`, after `db.start()`). Nothing is observable
    /// before `start`: no client can connect yet, and `start` reports a
    /// failure (or adopts the listener) exactly where TS's await would.
    pub fn listenEarly(self: *Server) void {
        self.loop.lock();
        defer self.loop.unlock();
        if (self.early_listen != null) return;
        const early = self.allocator.create(EarlyListen) catch oom();
        const context = self.newListenerContext();
        context.early = true;
        early.* = .{ .server = self, .context = context };
        early.thread = std.Thread.spawn(.{}, EarlyListen.run, .{early}) catch {
            // No thread: `start` connects as TS does.
            self.allocator.destroy(early);
            return;
        };
        self.early_listen = early;
    }

    /// Join an early listener; null if there was none.
    fn takeEarlyListen(self: *Server) ?struct { context: *ListenerContext, result: anyerror!*anyopaque } {
        const early = self.early_listen orelse return null;
        self.early_listen = null;
        self.loop.unlock();
        early.thread.join();
        self.loop.lock();
        const context = early.context;
        const result = early.result;
        self.allocator.destroy(early);
        return .{ .context = context, .result = result };
    }

    fn newListenerContext(self: *Server) *ListenerContext {
        self.listener_attempt += 1;
        const context = self.allocator.create(ListenerContext) catch oom();
        context.* = .{ .server = self, .attempt = self.listener_attempt };
        self.listener_contexts.append(self.allocator, context) catch oom();
        return context;
    }

    fn connectListener(self: *Server) void {
        if (self.takeEarlyListen()) |early| {
            // Used only if it is still connected; otherwise (failed or lost
            // before this point) connect now, as TS does.
            if (early.result) |handle| {
                if (!early.context.lost or self.stopped or early.context.attempt != self.listener_attempt)
                    return self.adoptListener(early.context, handle);
                self.loop.unlock();
                self.listen_api.unlisten(self.listen_api.ctx, handle);
                self.loop.lock();
            } else |_| {}
        }
        const context = self.newListenerContext();
        self.loop.unlock();
        const result = self.listen_api.listen(self.listen_api.ctx, &listen_channels, context.handler());
        self.loop.lock();
        const handle = result catch |err| {
            self.logger.err("database listener failed: {s}", .{errorMessage(err)});
            self.reconnectListener();
            return;
        };
        self.adoptListener(context, handle);
    }

    fn adoptListener(self: *Server, context: *ListenerContext, handle: *anyopaque) void {
        if (self.stopped or context.attempt != self.listener_attempt) {
            self.loop.unlock();
            self.listen_api.unlisten(self.listen_api.ctx, handle);
            self.loop.lock();
            return;
        }
        context.early = false;
        self.bumpAllReplayEpochs(); // pages read while not listening
        self.listener = handle;
        self.listener_ready = true;
    }

    const ListenerContext = struct {
        server: *Server,
        attempt: u64,
        /// Connected ahead of `start` and not adopted yet: TS is not
        /// listening, so its notifications are dropped and a disconnect only
        /// marks it `lost` (`start` then connects anew).
        early: bool = false,
        lost: bool = false,

        fn handler(self: *ListenerContext) ListenHandler {
            return .{ .ctx = self, .on_notification = onNotification, .on_disconnect = onDisconnect };
        }

        fn onNotification(ctx: *anyopaque, channel: []const u8, payload: []const u8) void {
            const self: *ListenerContext = @ptrCast(@alignCast(ctx));
            const server_ = self.server;
            server_.loop.lock();
            defer server_.loop.unlock();
            if (self.attempt != server_.listener_attempt or self.early) return;
            server_.queueNotification(channel, payload);
        }

        fn onDisconnect(ctx: *anyopaque, message: ?[]const u8) void {
            const self: *ListenerContext = @ptrCast(@alignCast(ctx));
            const server_ = self.server;
            server_.loop.lock();
            defer server_.loop.unlock();
            if (self.attempt != server_.listener_attempt) return;
            if (self.early) {
                self.lost = true;
                return;
            }
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
            self.bumpReplayEpoch(head.domain);
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
            // A row committed for this domain (possibly a backfill inside a
            // replay range): a replay page read before it is dropped.
            self.bumpReplayEpoch(notification.domain);
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
                peer.wsClose(1013, "Event catch-up buffer exceeded");
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
        // Notifications are missed until it reconnects: no page read ahead
        // before this point can be checked against them.
        self.bumpAllReplayEpochs();
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
            peer.wsClose(1013, "Event stream read failed");
        }
    }

    fn failExplorerStream(self: *Server, message: []const u8) void {
        self.logger.err("Explorer event stream failed: {s}", .{message});
        self.closeExplorerClients("Event stream read failed", 1013);
    }

    fn bumpReplayEpoch(self: *Server, domain: u32) void {
        const epoch = self.head_epochs.getOrPut(self.allocator, domain) catch oom();
        epoch.value_ptr.* = if (epoch.found_existing) epoch.value_ptr.* + 1 else 1;
    }

    pub fn replayEpoch(self: *Server, domain: u32) u64 {
        return self.epoch_base + (self.head_epochs.get(domain) orelse 0);
    }

    /// Every domain's replay epoch changes (pages read ahead are dropped).
    fn bumpAllReplayEpochs(self: *Server) void {
        self.epoch_base +%= 1 << 32;
    }

    fn closeClients(self: *Server, reason: []const u8, code: u16) void {
        self.bumpAllReplayEpochs();
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
            peer.wsClose(code, reason);
        }
        self.clients.clearRetainingCapacity();
    }

    fn closeExplorerClients(self: *Server, reason: []const u8, code: u16) void {
        self.clearExplorerNotifications();
        const peers = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| {
            self.disconnect(peer);
            peer.wsClose(code, reason);
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
        if (!runtime.hold_stats) return self.heartbeat();
        const started = std.time.nanoTimestamp();
        self.heartbeat();
        self.heartbeat_hold.record(std.time.nanoTimestamp() - started);
        self.logHoldTimes();
    }

    /// `-Dloop-hold-stats=true` builds: cumulative loop mutex hold times and
    /// replay prefetch outcomes, at info (every heartbeat and at stop; the
    /// shipped build logs nothing TS does not). `heartbeat` excludes its
    /// turn end.
    fn logHoldTimes(self: *Server) void {
        if (!runtime.hold_stats) return;
        self.logger.info("loop hold all {f}", .{&self.loop.hold});
        self.logger.info("loop hold turnEnd {f}", .{&self.loop.turn_end_hold});
        self.logger.info("loop hold heartbeat {f}", .{&self.heartbeat_hold});
        const stats = &self.store.prefetch_stats;
        self.logger.info("replay prefetch used={d} droppedEpoch={d} droppedAge={d} droppedMismatch={d} droppedFailedEarly={d} notIssued={d} abandoned={d}", .{
            stats.get(.used),                 stats.get(.dropped_epoch), stats.get(.dropped_age), stats.get(.dropped_mismatch),
            stats.get(.dropped_failed_early), stats.get(.not_issued),    stats.get(.abandoned),
        });
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
                peer.wsPing();
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
        return self.sendAndWaitReporting(peer, bytes) != .failed;
    }

    const AwaitedSend = enum { failed, written, waited };

    /// `sendAndWait`, reporting whether it had to wait.
    fn sendAndWaitReporting(self: *Server, peer: *Peer, bytes: []const u8) AwaitedSend {
        var waiter: Waiter = .{};
        if (!self.sendSerialized(peer, bytes, .{ .waiter = &waiter })) return .failed;
        // Written inline (ws completions finish waiters only in `passEnd`,
        // under the loop mutex held here).
        if (waiter.event.isSet()) return if (waiter.ok) .written else .failed;
        runtime.assertMayBlock();
        self.loop.unlock();
        waiter.event.wait();
        self.loop.lockHandoff(&waiter);
        return if (waiter.ok) .waited else .failed;
    }

    /// `for (frame of frames) if (!await sendAndWait(frame)) return false`,
    /// with the frames Node would write back to back in one syscall: while
    /// nothing is queued, each awaited frame that reaches the kernel is
    /// released before the next one is checked, so the next send's checks
    /// see the same state (no queued bytes, the same charges) and are
    /// decided before the write. The frame the kernel stops in is awaited
    /// like Node's async write; the frames after it were not touched and go
    /// out afterwards, each checked then.
    ///
    /// Returns after the first frame it had to wait for (the caller checks
    /// its time budget again before the rest, as TS does before every row):
    /// how many frames were sent, null when one failed.
    fn sendAllAndWait(self: *Server, peer: *Peer, batch_frames: []const []const u8) ?usize {
        self.observeSend(peer);
        var index: usize = 0;
        while (index < batch_frames.len) {
            const run = self.writableRun(peer, batch_frames[index..]);
            if (run == 0) {
                // Not writable inline as a run (queued bytes, a check that
                // fails, no vectored write): the per-frame path decides.
                const sent = self.sendAndWaitReporting(peer, batch_frames[index]);
                if (sent == .failed) return null;
                index += 1;
                if (sent == .waited) return index;
                continue;
            }
            const batch = batch_frames[index..][0..run];
            var waiter: Waiter = .{};
            self.flush_jobs.clearRetainingCapacity();
            for (batch) |bytes| {
                // Charged like `sendFrame` before the attempt (a partial
                // write's completion may run before the call returns).
                _ = self.pending_bytes.fetchAdd(bytes.len, .monotonic);
                peer.addBuffered(bytes.len);
                const job = self.allocator.create(SendJob) catch oom();
                job.* = .{ .server = self, .peer = peer, .len = bytes.len, .kind = .{ .waiter = &waiter } };
                peer.retain();
                self.flush_jobs.append(self.allocator, job) catch oom();
            }
            const jobs = self.allocator.dupe(*SendJob, self.flush_jobs.items) catch oom();
            defer self.allocator.free(jobs);
            var full: usize = 0;
            var partial = false;
            var failed = false;
            var closed = false;
            // Nothing is required: each awaited frame is sent only once the
            // one before it was written, so only the frame the kernel stops
            // inside is queued; the rest is not touched.
            switch (peer.socket.vtable.try_send_inline_many.?(peer.socket.ptr, batch, jobs, 0)) {
                .done => |d| {
                    full = d.written;
                    partial = d.queued > 0;
                },
                .closed => {
                    failed = true;
                    closed = true;
                },
                .failed => failed = true,
            }
            // Written whole: complete at once, uncharged (the awaited
            // callback has released them by the time the next is sent).
            // Not touched (or failed): never sent.
            for (jobs, 0..) |job, i| {
                if (partial and i == full and !failed) continue; // ws completes it
                _ = self.pending_bytes.fetchSub(job.len, .monotonic);
                peer.subBuffered(job.len);
                self.allocator.destroy(job);
                peer.release();
            }
            if (failed) {
                // No longer OPEN: `sendSerialized` returns false, no failure.
                if (!closed) self.failSend(peer, "WebSocket is not open");
                return null;
            }
            index += full;
            if (partial) {
                // Await the frame the kernel stopped in, like `sendAndWait`.
                self.trackQueued(peer, jobs[full]);
                runtime.assertMayBlock();
                self.loop.unlock();
                waiter.event.wait();
                self.loop.lockHandoff(&waiter);
                if (!waiter.ok) return null;
                return index + 1;
            }
            // `full < run` without a partial frame: the kernel took nothing of
            // frame `index`; the per-frame path sends it (queued, awaited).
            if (full < run) {
                const sent = self.sendAndWaitReporting(peer, batch_frames[index]);
                if (sent == .failed) return null;
                index += 1;
                if (sent == .waited) return index;
            }
        }
        return index;
    }

    /// How many of `frames` (at least 2, else 0) can be written as one run:
    /// nothing is queued or corked, and each frame passes `sendFrame`'s
    /// checks against the state it would see (no queued bytes, the current
    /// charges, as each earlier one was written whole and released).
    fn writableRun(self: *Server, peer: *Peer, batch_frames: []const []const u8) usize {
        if (!self.coalesce or batch_frames.len < 2 or peer.socket.vtable.try_send_inline_many == null) return 0;
        if (peer.terminated or peer.cork.frames.items.len > 0) return 0;
        const state = peer.socket.snapshot();
        if (!state.open or state.buffered > 0 or peer.requests.items.len > 0) return 0;
        const pending = self.pending_bytes.load(.monotonic);
        var count: usize = 0;
        for (batch_frames) |bytes| {
            if (count == MAX_CORKED_FRAMES) break;
            if (bytes.len > self.limits.max_buffered_bytes or pending + bytes.len > self.limits.max_total_buffered_bytes) break;
            count += 1;
        }
        return if (count >= 2) count else 0;
    }

    fn sendSerialized(self: *Server, peer: *Peer, bytes: []const u8, kind: SendJob.Kind) bool {
        return self.sendFrame(peer, bytes, kind) != .failed;
    }

    const SendOutcome = enum { failed, queued, written };

    /// `sendSerialized`, also reporting a frame written inline (no completion
    /// follows for it).
    fn observeSend(self: *Server, peer: *Peer) void {
        const observer = self.send_observer orelse return;
        observer.func(observer.ctx, peer.bufferedAmount(), self.pending_bytes.load(.monotonic));
    }

    fn sendFrame(self: *Server, peer: *Peer, bytes: []const u8, kind: SendJob.Kind) SendOutcome {
        if (peer.terminated) return .failed;
        self.observeSend(peer);
        if (peer.cork.lookahead) |lookahead| if (lookahead.bytes.ptr == bytes.ptr) return self.sendLookahead(peer, kind);
        if (self.coalesce and (kind == .none or kind == .explorer_drain) and peer.socket.vtable.try_send_inline_many != null) {
            if (self.corkFrame(peer, bytes, kind)) |outcome| return outcome;
        }
        // Anything else goes out after the frames corked before it.
        if (peer.cork.frames.items.len > 0) {
            self.flushCork(peer, false);
            if (peer.terminated) return .failed;
        }
        const state = peer.socket.snapshot();
        if (!state.open) return .failed;
        if (peer.bufferedAmount() + bytes.len > self.limits.max_buffered_bytes or
            !self.withinTotal(bytes.len))
        {
            metrics.websocket_send_failures.inc(.{"buffer_limit"}, 1);
            self.failSocket(peer, "outbound buffer limit exceeded");
            return .failed;
        }
        // Charged and referenced before the attempt: a partial write's
        // completion may run on another thread before the call returns.
        _ = self.pending_bytes.fetchAdd(bytes.len, .monotonic);
        peer.addBuffered(bytes.len);
        const job = self.allocator.create(SendJob) catch oom();
        job.* = .{ .server = self, .peer = peer, .len = bytes.len, .kind = kind };
        peer.retain();
        // Node writes at once only while no request is in flight; otherwise
        // the frame waits behind it (whatever ws holds right now).
        if (kind != .diagnostics and peer.requests.items.len == 0) if (peer.socket.vtable.try_send_inline) |try_inline| {
            switch (try_inline(peer.socket.ptr, bytes, job)) {
                .written => {
                    // Written whole at once: never in `bufferedAmount`.
                    peer.subBuffered(bytes.len);
                    self.allocator.destroy(job);
                    switch (kind) {
                        // An awaited send resumes after its callback, which has
                        // released the bytes by then: complete now, uncharged.
                        .waiter => |waiter| {
                            _ = self.pending_bytes.fetchSub(bytes.len, .monotonic);
                            peer.release();
                            waiter.finish(true);
                            return .written;
                        },
                        // Node fires the write callback after the current synchronous
                        // code even for a synchronous write: keep the bytes charged
                        // (aggregate limit decisions across a fan-out loop) and run
                        // the callback at the end of this turn.
                        .none, .explorer_drain => {
                            self.deferred.append(self.allocator, .{ .peer = peer, .len = bytes.len, .drain = kind == .explorer_drain }) catch oom();
                            return if (kind == .explorer_drain) .queued else .written;
                        },
                        .diagnostics => unreachable,
                    }
                },
                // Charged until the remainder is written, then `job` completes.
                .partial => {
                    self.trackQueued(peer, job);
                    return .queued;
                },
                .failed, .closed => |result| {
                    _ = self.pending_bytes.fetchSub(bytes.len, .monotonic);
                    peer.subBuffered(bytes.len);
                    self.allocator.destroy(job);
                    peer.release();
                    if (kind == .waiter) kind.waiter.finish(false);
                    // A socket that closed since the check: `sendSerialized`
                    // returns false, as for `readyState !== OPEN`.
                    if (result == .failed) self.failSend(peer, "WebSocket is not open");
                    return .failed;
                },
                .busy => {},
            }
        };
        if (!peer.socket.send(bytes, job)) {
            _ = self.pending_bytes.fetchSub(bytes.len, .monotonic);
            peer.subBuffered(bytes.len);
            self.allocator.destroy(job);
            peer.release();
            self.failSend(peer, "WebSocket is not open");
            return .failed;
        }
        self.trackQueued(peer, job);
        return .queued;
    }

    /// Cork a non-awaited frame (null: use the normal path). Node writes it
    /// now and runs its callback after the current synchronous code; here the
    /// write happens once per peer at the end of the turn (or before any other
    /// socket operation), with every limit decision made as Node makes it:
    /// ws's `bufferedAmount` is at most what is queued plus what is corked, so
    /// a frame that fits under that bound passes Node's check too; one that
    /// does not is decided on the real value after a flush.
    fn corkFrame(self: *Server, peer: *Peer, bytes: []const u8, kind: SendJob.Kind) ?SendOutcome {
        const state = peer.socket.snapshot();
        if (!state.open) return .failed;
        // Something is queued (a partial write, a pong) or a request is in
        // flight in Node's terms: nothing goes inline.
        if (state.buffered > 0 or peer.requests.items.len > 0) return null;
        const cork = &peer.cork;
        if (peer.bufferedAmount() + cork.framed + bytes.len > self.limits.max_buffered_bytes) return null;
        if (cork.frames.items.len >= MAX_CORKED_FRAMES or cork.bytes.items.len + bytes.len > MAX_CORKED_BYTES) return null;
        if (!self.withinTotal(bytes.len)) {
            metrics.websocket_send_failures.inc(.{"buffer_limit"}, 1);
            self.failSocket(peer, "outbound buffer limit exceeded");
            return .failed;
        }
        _ = self.pending_bytes.fetchAdd(bytes.len, .monotonic);
        const job = self.allocator.create(SendJob) catch oom();
        job.* = .{ .server = self, .peer = peer, .len = bytes.len, .kind = kind };
        peer.retain(); // the job's
        if (!cork.listed) {
            cork.listed = true;
            peer.retain(); // the corked list's
            self.corked.append(self.allocator, peer) catch oom();
        }
        const offset = cork.bytes.items.len;
        cork.bytes.appendSlice(self.allocator, bytes) catch oom();
        cork.frames.append(self.allocator, .{ .start = offset, .len = bytes.len, .job = job, .drain = kind == .explorer_drain }) catch oom();
        cork.framed += bytes.len + frameHeaderLen(bytes.len);
        peer.retain(); // the deferred callback's
        self.deferred.append(self.allocator, .{ .peer = peer, .len = bytes.len, .drain = kind == .explorer_drain, .corked = true }) catch oom();
        // A drain frame waits for its callback (like `sendSerializedAndWait`).
        return if (kind == .explorer_drain) .queued else .written;
    }

    /// The aggregate outbound check (`pendingBytes + length > max`). Corked
    /// frames are charged; a socket error found when they are written
    /// releases them, which Node would have done at once. So a pass is
    /// certain, but a failure is only decided once every cork is written.
    fn withinTotal(self: *Server, len: usize) bool {
        // Lookahead frames written early are not charged in Node until the
        // drain sends them.
        if (self.pending_bytes.load(.monotonic) - self.lookahead_unconsumed + len <= self.limits.max_total_buffered_bytes) return true;
        if (self.corked.items.len > 0) self.flushAllCorks();
        return self.pending_bytes.load(.monotonic) - self.lookahead_unconsumed + len <= self.limits.max_total_buffered_bytes;
    }

    fn flushAllCorks(self: *Server) void {
        // Flushes can fail sockets, which never cork again this turn.
        var index: usize = 0;
        while (index < self.corked.items.len) : (index += 1) self.flushCork(self.corked.items[index], false);
        self.clearCorked();
    }

    /// The send of the drain's next frame from its predecessor's callback,
    /// already written by `flushCork` (whose bounds guarantee every check of
    /// this send passes): charge it and apply what the kernel did.
    fn sendLookahead(self: *Server, peer: *Peer, kind: SendJob.Kind) SendOutcome {
        std.debug.assert(kind == .explorer_drain);
        const lookahead = peer.cork.lookahead.?;
        peer.cork.lookahead = null;
        // Charged by `planFlush`. When ws queued part of it, `job` belongs to
        // ws now (completed after this turn): only `lookahead.bytes` is ours.
        const job = lookahead.job;
        self.lookahead_unconsumed -= lookahead.bytes.len;
        switch (lookahead.outcome) {
            .written => {
                // Like a corked frame that reached the kernel: released by its
                // deferred callback (the job's peer reference moves to it).
                const len = lookahead.bytes.len;
                self.allocator.destroy(job);
                peer.cork.outcomes.append(self.allocator, .written) catch oom();
                self.deferred.append(self.allocator, .{ .peer = peer, .len = len, .drain = true, .corked = true }) catch oom();
            },
            // Queued by ws: `job` completes it (after this turn).
            .partial => {
                peer.addBuffered(lookahead.bytes.len);
                self.trackQueued(peer, job);
            },
            .untouched => if (blk: {
                peer.addBuffered(lookahead.bytes.len);
                break :blk peer.socket.send(lookahead.bytes, job);
            }) self.trackQueued(peer, job) else {
                peer.subBuffered(lookahead.bytes.len);
                _ = self.pending_bytes.fetchSub(job.len, .monotonic);
                self.allocator.destroy(job);
                peer.release();
                // Closed meanwhile: like `readyState !== OPEN`, no failure.
                if (peer.socket.isOpen()) self.failSend(peer, "WebSocket is not open");
                return .failed;
            },
        }
        return .queued;
    }

    /// Write the peer's corked frames with one syscall. Fully written frames
    /// are released by their deferred callbacks; the rest stay charged until
    /// ws writes them (like Node's async writes).
    ///
    /// `drain`: this flush runs the callback of the cork's first frame, an
    /// Explorer drain frame. If that frame reaches the kernel, the callback
    /// sends the drain's next frame at once; when every check of that send
    /// is certain to pass whatever the kernel does with this write, the next
    /// frame is written in the same syscall and `sendLookahead` applies it.
    fn flushCork(self: *Server, peer: *Peer, drain: bool) void {
        const cork = &peer.cork;
        if (cork.frames.items.len == 0) return;
        var next: ?*SharedFrame = null;
        if (drain and cork.frames.items[0].drain and cork.frames.items.len < MAX_CORKED_FRAMES)
            next = self.lookaheadFrame(peer, cork.frames.items[0].len);
        var plan = self.planFlush(peer, next);
        defer plan.deinit(self.allocator);
        plan.write();
        self.applyFlush(&plan);
    }

    /// One peer's cork write: prepared and applied under the loop mutex,
    /// written (`write`) on any thread.
    const FlushPlan = struct {
        peer: *Peer,
        payloads: []const []const u8,
        jobs: []*SendJob,
        count: usize,
        next: ?*SharedFrame,
        result: Socket.ManyResult = .failed,

        fn write(self: *FlushPlan) void {
            const socket = self.peer.socket;
            // Every cork frame goes out or is queued, in order, in one step
            // (as Node's writes of this tick); only the lookahead is optional.
            self.result = socket.vtable.try_send_inline_many.?(socket.ptr, self.payloads, self.jobs, self.count);
        }

        fn deinit(self: *FlushPlan, allocator: Allocator) void {
            allocator.free(self.payloads);
            allocator.free(self.jobs);
        }
    };

    fn planFlush(self: *Server, peer: *Peer, next: ?*SharedFrame) FlushPlan {
        const cork = &peer.cork;
        const count = cork.frames.items.len;
        const total = count + @intFromBool(next != null);
        const payloads = self.allocator.alloc([]const u8, total) catch oom();
        const jobs = self.allocator.alloc(*SendJob, total) catch oom();
        for (cork.frames.items, 0..) |frame, index| {
            payloads[index] = cork.bytes.items[frame.start..][0..frame.len];
            jobs[index] = frame.job;
            // Handed to ws now (a queued frame's completion may run first).
            peer.addBuffered(frame.len);
        }
        if (next) |frame| {
            const job = self.allocator.create(SendJob) catch oom();
            job.* = .{ .server = self, .peer = peer, .len = frame.bytes.len, .kind = .explorer_drain, .lookahead = true };
            peer.retain(); // the job's
            // Charged now (a partial write's completion may run first); not
            // part of limit decisions until the drain sends it.
            _ = self.pending_bytes.fetchAdd(job.len, .monotonic);
            self.lookahead_unconsumed += job.len;
            payloads[count] = frame.bytes;
            jobs[count] = job;
        }
        return .{ .peer = peer, .payloads = payloads, .jobs = jobs, .count = count, .next = next };
    }

    /// The bookkeeping of a written cork: fully written frames are released
    /// by their deferred callbacks; the rest stay charged until ws writes
    /// them (like Node's async writes).
    fn applyFlush(self: *Server, plan: *FlushPlan) void {
        const peer = plan.peer;
        const cork = &peer.cork;
        const count = plan.count;
        const jobs = plan.jobs;
        var written: usize = 0;
        var queued: usize = 0;
        var failed = false;
        // Closed since the frames were corked: dropped like sends to a
        // socket that is no longer OPEN, without a send failure.
        var closed = false;
        switch (plan.result) {
            .done => |d| {
                written = d.written;
                queued = d.queued;
            },
            .closed => {
                failed = true;
                closed = true;
            },
            .failed => failed = true,
        }
        for (cork.frames.items, 0..) |frame, index| {
            const job = jobs[index];
            if (failed) {
                peer.subBuffered(job.len);
                cork.outcomes.append(self.allocator, .failed) catch oom();
                _ = self.pending_bytes.fetchSub(job.len, .monotonic);
                self.allocator.destroy(job);
                peer.release();
                // A drain whose frame was not sent stops.
                if (frame.drain) peer.explorer.sending = false;
            } else if (index < written) {
                peer.subBuffered(job.len); // written whole at once
                // Released by its deferred callback.
                cork.outcomes.append(self.allocator, .written) catch oom();
                self.allocator.destroy(job);
                peer.release();
            } else {
                std.debug.assert(index < written + queued);
                cork.outcomes.append(self.allocator, .queued) catch oom(); // ws completes the job
                self.trackQueued(peer, job);
            }
        }
        if (plan.next) |frame| {
            const job = jobs[count];
            // The first frame's callback sends the next one only if the
            // first frame was written whole; it was written (or not) here.
            if (!failed and written >= 1) {
                cork.lookahead = .{
                    .bytes = frame.bytes,
                    .job = job,
                    .outcome = if (written > count) .written else if (written + queued > count) .partial else .untouched,
                };
                // Written: `sendLookahead` moves it to a deferred callback.
                // Queued: ws completes the job.
            } else {
                std.debug.assert(failed or written + queued <= count);
                _ = self.pending_bytes.fetchSub(job.len, .monotonic);
                self.lookahead_unconsumed -= job.len;
                self.allocator.destroy(job);
                peer.release();
            }
        }
        cork.frames.clearRetainingCapacity();
        cork.bytes.clearRetainingCapacity();
        cork.framed = 0;
        if (failed and !closed) self.failSend(peer, "WebSocket is not open");
    }

    /// At the start of the turn's write callbacks: write every unflushed cork
    /// at once, split across pool threads when there are many (the syscalls
    /// run in parallel; all bookkeeping stays here, in order). A drain's
    /// lookahead frame joins its cork only if its send is certain whatever
    /// order the callbacks run in: per socket as in `lookaheadFrame`, and the
    /// aggregate against the current charges plus every lookahead frame.
    fn flushCorksInParallel(self: *Server) void {
        var plans: std.ArrayList(FlushPlan) = .empty;
        defer {
            for (plans.items) |*plan| plan.deinit(self.allocator);
            plans.deinit(self.allocator);
        }
        var candidates: std.ArrayList(struct { peer: *Peer, next: ?*SharedFrame }) = .empty;
        defer candidates.deinit(self.allocator);
        for (self.corked.items) |peer| {
            const cork = &peer.cork;
            // Flushed earlier in the turn (a ping or close wrapper): its
            // outcomes wait for the callbacks; written lazily.
            if (cork.frames.items.len == 0 or cork.outcomes.items.len > 0 or cork.lookahead != null) continue;
            var next: ?*SharedFrame = null;
            if (cork.frames.items[0].drain and cork.frames.items.len < MAX_CORKED_FRAMES)
                next = self.lookaheadFrame(peer, 0);
            candidates.append(self.allocator, .{ .peer = peer, .next = next }) catch oom();
        }
        if (candidates.items.len < self.parallel_flush_min) return; // written lazily, one by one
        // Lookaheads are consumed in the turn that writes them.
        std.debug.assert(self.lookahead_unconsumed == 0);
        const keep_lookahead = self.pending_bytes.load(.monotonic) + self.drainSendsBound() <= self.limits.max_total_buffered_bytes;
        for (candidates.items) |c| plans.append(self.allocator, self.planFlush(c.peer, if (keep_lookahead) c.next else null)) catch oom();
        const workers = @min(self.parallel_flush_threads, (plans.items.len + self.parallel_flush_min - 1) / self.parallel_flush_min);
        const Chunk = struct {
            job: runtime.Pool.Job = .{ .run = run },
            plans: []FlushPlan,
            group: *std.Thread.WaitGroup,

            fn run(job: *runtime.Pool.Job) void {
                const chunk: *@This() = @alignCast(@fieldParentPtr("job", job));
                for (chunk.plans) |*plan| plan.write();
                chunk.group.finish();
            }
        };
        var group: std.Thread.WaitGroup = .{};
        const chunks = self.allocator.alloc(Chunk, workers) catch oom();
        defer self.allocator.free(chunks);
        const per = (plans.items.len + workers - 1) / workers;
        for (chunks, 0..) |*chunk, index| {
            const first = @min(index * per, plans.items.len);
            chunk.* = .{ .plans = plans.items[first..@min(first + per, plans.items.len)], .group = &group };
        }
        // Workers may be blocked on the loop mutex this thread holds: a chunk
        // no thread is certain to take is written here.
        var submitted: usize = 1;
        while (submitted < chunks.len) : (submitted += 1) {
            group.start();
            if (!self.loop.pool.trySubmit(&chunks[submitted].job)) {
                group.finish();
                break;
            }
        }
        for (chunks[0].plans) |*plan| plan.write();
        for (chunks[submitted..]) |chunk| for (chunk.plans) |*plan| plan.write();
        group.wait();
        for (plans.items) |*plan| self.applyFlush(plan);
    }

    /// What the turn's write callbacks can charge before any of them runs a
    /// drain's lookahead check: every deferred drain callback sends at most
    /// the peer's next queued frame (the k-th callback of a peer the k-th
    /// next). Sends from callbacks those queue run after every original
    /// callback, so after every lookahead check. Releases are ignored (they
    /// only lower the charges), so the bound holds in any order.
    fn drainSendsBound(self: *Server) usize {
        var seen: std.AutoHashMapUnmanaged(*Peer, usize) = .empty;
        defer seen.deinit(self.allocator);
        var total: usize = 0;
        for (self.deferred.items) |item| {
            if (!item.drain) continue;
            const peer = item.peer;
            if (peer.terminated or !peer.in_explorer) continue;
            const k = seen.getOrPut(self.allocator, peer) catch oom();
            if (!k.found_existing) k.value_ptr.* = 0;
            const index = peer.explorer.queue_head + k.value_ptr.*;
            k.value_ptr.* += 1;
            if (index < peer.explorer.queue.items.len) total += peer.explorer.queue.items[index].bytes.len;
        }
        return total;
    }

    /// The frame the drain sends from the callback of its frame of length
    /// `first_len`, if every check of that send passes whatever the kernel
    /// does with the cork: the drain still runs, the per-socket check holds
    /// against everything corked counted whole, the aggregate check against
    /// the current charges minus the first frame (released by its callback).
    fn lookaheadFrame(self: *Server, peer: *Peer, first_len: usize) ?*SharedFrame {
        if (peer.terminated or !peer.in_explorer or peer.explorer.queueLength() == 0) return null;
        const frame = peer.explorer.queue.items[peer.explorer.queue_head];
        const len = frame.bytes.len;
        if (peer.bufferedAmount() + peer.cork.framed + len > self.limits.max_buffered_bytes) return null;
        if (self.pending_bytes.load(.monotonic) - self.lookahead_unconsumed - first_len + len > self.limits.max_total_buffered_bytes) return null;
        return frame;
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
        peer.wsTerminate();
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
        peer.wsClose(1008, "Invalid subscription");
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
        day.year,               month_day.month.numeric(), month_day.day_index + 1,
        time.getHoursIntoDay(), time.getMinutesIntoHour(), time.getSecondsIntoMinute(),
        millis,
    }) catch unreachable;
    return out;
}
