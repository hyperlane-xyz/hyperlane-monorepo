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
const http = @import("http");
const protocol = @import("protocol.zig");
const runtime = @import("runtime.zig");
const frames = @import("frames.zig");
const es = @import("event_store.zig");
const evs = @import("event_source.zig");
const msrc = @import("message_source.zig");
const NotificationWorker = @import("notification_worker.zig").NotificationWorker;
const NotificationQueue = @import("notification_queue.zig").Queue;

const json = core.json;
const metrics = core.metrics;
const Value = json.Value;
const Allocator = std.mem.Allocator;
const EventType = protocol.EventType;
const errorMessage = runtime.errorMessage;

/// Explorer types first: a failure in an agent-only type must not close
/// Explorer clients that already received this range.
const HEAD_PUBLICATION_ORDER = [_]EventType{ .delivery, .gas_payment, .dispatch, .merkle_tree_insertion };

pub const AGENT_PATH = "/agents";
pub const MAX_AGENT_MESSAGE_BYTES = 65_536;
pub const MESSAGE_PATH = "/messages";
pub const MAX_EXPLORER_MESSAGE_BYTES = 4_096;
pub const VALIDATOR_PATH = "/validators";
/// The URL and inbound frame limit of `/validators`.
pub const MAX_VALIDATOR_MESSAGE_BYTES = 1_024;
const MAX_VALIDATOR_CLIENTS = 2_000;
const MAX_VALIDATOR_CLIENTS_PER_IP = 100;
const MAX_VALIDATOR_PENDING_SETUPS = 32;
const MAX_VALIDATOR_PENDING_SETUPS_PER_IP = 8;
pub const EVENT_CHANNEL = "scraper_event";
pub const EXPLORER_CHANNEL = "scraper_explorer_event";
pub const HEAD_CHANNEL = "scraper_head";
const HEARTBEAT_MS = 30_000;
const MAX_INTERVAL_MS = 2_147_483_647;
const LISTENER_RETRY_MS = 1_000;
const NOTIFICATION_BATCH_MS = 100;
const NOTIFICATION_BATCH_SIZE = 1_000;
const EXPLORER_NOTIFICATION_BATCH_SIZE = 100;
const MAX_EXPLORER_CLIENTS = 500;
const MAX_EXPLORER_CLIENTS_PER_IP = 5;
/// TS #10076: /messages setups awaiting their reads (blocks, confirmation
/// heads), held until the read ends even after a disconnect.
const MAX_EXPLORER_PENDING_SETUPS = 32;
const MAX_EXPLORER_PENDING_SETUPS_PER_IP = 2;
const MAX_EXPLORER_SUBSCRIPTION_BYTES = 8_192;
const MAX_EXPLORER_PENDING_BYTES = 16 * 1024 * 1024;
/// TS #10078: Explorer outbound queues share this budget across sockets.
const MAX_EXPLORER_TOTAL_PENDING_BYTES = 32 * 1024 * 1024;
/// TS #10090: fan-out yields a turn after this many queued bytes or sends.
const FANOUT_BYTES_PER_TURN = 256 * 1024;
const FANOUT_MESSAGES_PER_TURN = 64;
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
    \\{"confirmations":{"unit":"blocks","liveOnly":true,"byDomain":true},"eventTypes":["dispatch","delivery","gas_payment","merkle_tree_insertion","blocks"],"historicalStreaming":false,"liveStartVersion":1,"type":"ready"}
;

pub const Limits = struct {
    heartbeat_ms: u64 = HEARTBEAT_MS,
    max_agent_clients: u64,
    max_buffered_bytes: u64,
    max_explorer_clients: u64 = MAX_EXPLORER_CLIENTS,
    max_validator_clients: u64 = MAX_VALIDATOR_CLIENTS,
    max_validator_clients_per_ip: u64 = MAX_VALIDATOR_CLIENTS_PER_IP,
    max_total_buffered_bytes: u64,

    pub fn fromConfig(config: *const core.config.Config) Limits {
        return .{
            .max_agent_clients = config.event_stream_max_agent_clients,
            .max_buffered_bytes = config.event_stream_max_buffered_bytes,
            .max_total_buffered_bytes = config.event_stream_max_total_buffered_bytes,
        };
    }
};

pub const Options = struct {
    limits: Limits,
    batch_size: u64,
    /// `process.env.NODE_ENV === 'production'` (clientIp ignores the peer address).
    production: bool = false,
    /// `db.queryValidator` (the validator pool); `db` when null (tests).
    validator_db: ?es.Db = null,
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
        /// Optional: the `error.message` Node gives a failed send's callback
        /// (`ws.Conn.sendFailureText`); without it, "write ECANCELED".
        send_failure_text: ?*const fn (ptr: *anyopaque) []const u8 = null,
    };

    /// `send failed: <reason>`: the write error that destroyed the socket
    /// ("write ECONNRESET", "write EPIPE"), else "write ECANCELED" (writes
    /// still queued when a read error, hangup or terminate destroyed it).
    pub fn sendFailureText(self: Socket) []const u8 {
        const text = self.vtable.send_failure_text orelse return "write ECANCELED";
        return text(self.ptr);
    }

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
    /// `listen` without its "listening on" log line, for the early LISTEN
    /// (`listenEarly`): TS logs it only where `start` listens, which is where
    /// `log_listening` runs once the early listener is adopted. Null: `listen`.
    listen_unlogged: ?*const fn (ctx: *anyopaque, channels: []const []const u8, handler: ListenHandler) anyerror!*anyopaque = null,
    log_listening: ?*const fn (ctx: *anyopaque, channels: []const []const u8) void = null,
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
    /// The socket's reservation epoch at charge (`releaseSent`).
    epoch: u32 = 0,
    /// Its Node write request (`Peer.requests`, by absolute index).
    request: u64 = 0,
    /// Outcome reported by ws (`complete`), applied in `passEnd`.
    ok: bool = false,
    /// `-Dparity-hooks`: its callback is held once written (`Hooks`).
    held: if (runtime.parity_hooks) bool else void = if (runtime.parity_hooks) false else {},

    const Kind = union(enum) {
        none,
        waiter: *Waiter,
        explorer_drain,
        diagnostics: diagnostics.stream.Completion,
        /// An awaited send whose continuation is a callback (no task waits):
        /// written whole at once, the sender continues itself (`.written`);
        /// otherwise `func` runs as the write callback's continuation.
        resumable: *Resumable,
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

/// `SendJob.Kind.resumable`'s continuation (a `.run` handoff: never blocks).
pub const Resumable = struct {
    func: *const fn (self: *Resumable, ok: bool) void,
};

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
    /// `client.subscriptions` (eventType → request). Domains are owned.
    subscriptions: std.EnumArray(EventType, ?Subscription) = .initFill(null),
    subscribing: bool = false,

    fn count(self: *const AgentClient) usize {
        var total: usize = 0;
        for (self.subscriptions.values) |entry| if (entry != null) {
            total += 1;
        };
        return total;
    }
};

/// A live agent subscription (`StreamRequest` without `includeZeroConfirmations`).
const Subscription = struct {
    confirmations: ?u64,
    domains: ?[]const u32,

    fn matchesDomain(self: *const Subscription, domain: u32) bool {
        const domains = self.domains orelse return true;
        return std.mem.indexOfScalar(u32, domains, domain) != null;
    }
};

const ExplorerClient = struct {
    /// The custom subscription's domains (owned), else null.
    domains: ?[]const u32 = null,
    /// Set once the setup reads ended and `ready` is sent (TS #10078).
    ready: bool = false,
    message_ids: ?[]const []const u8 = null,
    /// The MessageSource subscription (one reference), until disconnect.
    subscription: ?*msrc.Subscriber = null,
    alive: bool = true,
    custom: bool = false,
    ip: []const u8 = "",

    fn hasId(self: *const ExplorerClient, id: []const u8) bool {
        const ids = self.message_ids orelse return true;
        return protocol.containsString(ids, id);
    }

    /// `client.messageIds?.size !== 0`.
    fn readsMessages(self: *const ExplorerClient) bool {
        const ids = self.message_ids orelse return true;
        return ids.len != 0;
    }

    /// `!client.domains || client.domains.has(domain)`.
    fn coversDomain(self: *const ExplorerClient, domain: u32) bool {
        const domains = self.domains orelse return true;
        return std.mem.indexOfScalar(u32, domains, domain) != null;
    }
};

/// A socket's outbound queue (TS #10089 `BroadcastQueue` client state).
const OutQueue = struct {
    queued_bytes: usize = 0,
    queue: std.ArrayList(*SharedFrame) = .empty,
    queue_head: usize = 0,
    sending: bool = false,

    fn length(self: *const OutQueue) usize {
        return self.queue.items.len - self.queue_head;
    }
};

/// TS #10089 `BroadcastQueue`: one per route. Shared buffers count once
/// toward `total` (per queue), every copy toward a socket's limits.
const RouteQueue = struct {
    total: usize,
    bytes: usize = 0,
    refs: std.AutoHashMapUnmanaged(*SharedFrame, usize) = .empty,
    /// The sockets with queue state (`clients` Map order).
    clients: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,

    fn deinit(self: *RouteQueue, allocator: Allocator) void {
        self.refs.deinit(allocator);
        self.clients.deinit(allocator);
    }

    /// `added()`: bytes of distinct buffers not queued yet.
    fn added(self: *const RouteQueue, messages: []const *SharedFrame) usize {
        var total: usize = 0;
        for (messages, 0..) |message, i| {
            if (self.refs.contains(message)) continue;
            if (std.mem.indexOfScalar(*SharedFrame, messages[0..i], message) != null) continue;
            total += message.bytes.len;
        }
        return total;
    }

    fn retain(self: *RouteQueue, allocator: Allocator, message: *SharedFrame) void {
        const slot = self.refs.getOrPut(allocator, message) catch oom();
        if (!slot.found_existing) {
            slot.value_ptr.* = 0;
            self.bytes += message.bytes.len;
        }
        slot.value_ptr.* += 1;
    }

    fn release(self: *RouteQueue, message: *SharedFrame) void {
        const slot = self.refs.getPtr(message) orelse unreachable; // "Released a frame that was not queued"
        if (slot.* > 1) {
            slot.* -= 1;
        } else {
            _ = self.refs.remove(message);
            self.bytes -= message.bytes.len;
        }
    }

    /// `exclusiveBytes(client)`: buffers whose every queued copy is in this queue.
    fn exclusiveBytes(self: *const RouteQueue, allocator: Allocator, peer: *Peer) usize {
        var copies: std.AutoArrayHashMapUnmanaged(*SharedFrame, usize) = .empty;
        defer copies.deinit(allocator);
        for (peer.out.queue.items[peer.out.queue_head..]) |message| {
            const slot = copies.getOrPut(allocator, message) catch oom();
            slot.value_ptr.* = if (slot.found_existing) slot.value_ptr.* + 1 else 1;
        }
        var bytes: usize = 0;
        for (copies.keys(), copies.values()) |message, count| if (self.refs.get(message) == count) {
            bytes += message.bytes.len;
        };
        return bytes;
    }
};

const BlockSubscription = struct {
    domains: ?[]const u32,
    started: bool = false,
    latest: std.AutoArrayHashMapUnmanaged(u32, LatestBlock) = .empty,
};

/// A block frame plus the values `publishBlock` compares (join and live
/// frames order their keys differently since TS #10078).
const LatestBlock = struct { frame: *SharedFrame, height: i128, head_height: i128, hash: [66]u8 };

pub const Route = enum { agent, explorer, validator };

pub const Peer = struct {
    server: *Server,
    socket: Socket,
    /// Atomic: send completions drop their reference without the loop mutex.
    refs: std.atomic.Value(usize) = .init(1),
    route: Route,
    /// The route queue's state for this socket (TS #10089 `BroadcastQueue`).
    out: OutQueue = .{},
    /// TS #10089 `pendingSends`: this socket's in-flight bytes (atomic:
    /// completions release without the loop mutex). `pending_released` is
    /// set by disconnect's `releasePending`; late completions then skip.
    pending: std.atomic.Value(usize) = .init(0),
    /// Bumped by `releasePending`: callbacks of earlier frames then skip
    /// (TS compares the `pendingSends` entry object).
    pending_epoch: std.atomic.Value(u32) = .init(0),
    /// Reader thread only: inside the frames of one socket read, which hold
    /// the loop mutex as one turn (Node's 'data' macrotask).
    read_batch: bool = false,
    /// The upgrade's `head` holds a complete data frame: Node parses it on a
    /// nextTick, before any promise continuation of the setup (TS #10078's
    /// settled heads snapshot), so that continuation waits for this read.
    head_message_pending: bool = false,
    /// A setup continuation held for `head_message_pending` (see `endRead`).
    deferred_heads: ?*msrc.HeadsWaiter = null,
    terminated: bool = false,
    in_clients: bool = false,
    agent: AgentClient = .{},
    in_explorer: bool = false,
    explorer: ExplorerClient = .{},
    /// Holds a /messages setup reservation (`explorer.ip`) until its reads end.
    explorer_setup: bool = false,
    blocks: ?*BlockSubscription = null,
    /// `client.events`: the EventSource subscription, until disconnect.
    events: ?evs.Subscription = null,
    diagnostics_subscription: ?*diagnostics.stream.Subscription = null,
    /// ws 'close' has been handled.
    closed: bool = false,
    /// `/validators`: its `validatorClients` entry (route `.validator`).
    validator: ValidatorClient = .{},
    /// A heartbeat trim found write requests in flight: give their list
    /// capacity back once they are all released.
    trim_requests: bool = false,
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
        server.removeQueued(self);
        _ = server.pending_order.orderedRemove(self);
        if (self.explorer.message_ids) |ids| freeStrings(server.allocator, ids);
        if (self.explorer.domains) |domains| server.allocator.free(domains);
        if (self.explorer.ip.len > 0) server.allocator.free(self.explorer.ip);
        std.debug.assert(!self.validator.reserved and self.events == null);
        if (self.validator.ip.len > 0) server.allocator.free(self.validator.ip);
        self.out.queue.deinit(server.allocator);
        self.cork.deinit(server.allocator);
        std.debug.assert(self.requests.items.len == 0 and self.completed.items.len == 0);
        self.requests.deinit(server.allocator);
        self.completed.deinit(server.allocator);
        self.socket.vtable.release(self.socket.ptr);
        server.allocator.destroy(self);
    }
};

/// A `/validators` connection's `ValidatorClient`: counted against the
/// validator limits (`reserved`, one peer reference) until its setup ended
/// and its socket closed.
const ValidatorClient = struct {
    reserved: bool = false,
    pending: bool = false,
    /// Owned.
    ip: []const u8 = "",
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

/// A coalesced head notification (`pendingHeads`) with its own copy of
/// `indexedHash` (EventSource compares it to detect replaced blocks).
const PendingHead = struct {
    head: protocol.HeadNotification,
    hash: [66]u8 = undefined,
    has_hash: bool = false,

    fn init(head: protocol.HeadNotification) PendingHead {
        var pending: PendingHead = .{ .head = head };
        pending.head.indexed_hash = null;
        if (head.indexed_hash) |hash| {
            std.debug.assert(hash.len == 66);
            pending.hash = hash[0..66].*;
            pending.has_hash = true;
        }
        return pending;
    }

    fn view(self: *const PendingHead) protocol.HeadNotification {
        var head = self.head;
        head.indexed_hash = if (self.has_hash) &self.hash else null;
        return head;
    }
};

/// A write callback Node would run after the current synchronous code.
/// `corked`: a frame held in its peer's cork; it is released only if the
/// flush wrote it fully (otherwise its job does, once the socket writes it).
const Deferred = struct { peer: *Peer, len: usize, drain: bool, corked: bool = false, epoch: u32 = 0 };

const HeadFailure = struct { partial_agent: bool, explorer_affected: bool };

// ---------------------------------------------------------------------------

pub const Server = struct {
    allocator: Allocator,
    loop: *runtime.Loop,
    logger: core.log.Logger,
    store: es.EventStore,
    /// `messageSource` (TS #10078): replaced by `closeClients`.
    message_source: *msrc.MessageSource = undefined,
    /// TS #10089 `eventSource` (agents, live pool) and `validatorSource`
    /// (validator pool): replaced by `closeClients`.
    event_source: *evs.EventSource = undefined,
    validator_source: *evs.EventSource = undefined,
    /// TS #10089 route queues (`eventQueue`, `explorerQueue`, `validatorQueue`),
    /// indexed by `Route`.
    queues: [3]RouteQueue = .{
        .{ .total = 16 * 1024 * 1024 },
        .{ .total = MAX_EXPLORER_TOTAL_PENDING_BYTES },
        .{ .total = 8 * 1024 * 1024 },
    },
    /// TS #10085 `explorerRefreshes` (publishExplorer's pacing).
    explorer_refreshes: msrc.Pacer = .{},
    listen_api: Listen,
    limits: Limits,
    production: bool,
    diagnostics_stream: ?*diagnostics.stream.Stream,

    clients: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    block_subscriptions: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    explorer_clients: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    explorer_clients_by_ip: std.StringArrayHashMapUnmanaged(usize) = .empty,
    /// `explorerPendingSetups` (its size) and `explorerPendingSetupsByIp` (owned keys).
    explorer_pending_setups: usize = 0,
    explorer_pending_setups_by_ip: std.StringArrayHashMapUnmanaged(usize) = .empty,
    explorer_notifications: NotificationQueue(void) = .{},
    notifications: NotificationQueue(protocol.EventNotification) = .{},
    /// `validatorStore`: reads on the validator pool.
    validator_store: es.EventStore,
    /// `validatorClients`: reservations in insertion order (one peer reference each).
    validator_clients: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    /// Canonical notifications only validators want (keyed by id).
    validator_notifications: NotificationQueue(protocol.EventNotification) = .{},
    validator_head_ranges: std.AutoArrayHashMapUnmanaged(u32, HeadRange) = .empty,
    validator_updates: NotificationWorker = undefined,
    pending_heads: std.AutoArrayHashMapUnmanaged(u32, PendingHead) = .empty,
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
    /// Atomic: decremented by send completions without the loop mutex.
    pending_bytes: std.atomic.Value(usize) = .init(0),
    listener_ready: bool = false,
    stopped: bool = false,
    /// TS `httpServer.off('upgrade')` in stop(), after its awaits (the
    /// diagnostics stream and the unlisten), just before the clients get
    /// 1001: read by the HTTP server (`http.UpgradeHandler.removed`). Until
    /// then upgrades, accepts and reads go on as in TS; from then on HTTP
    /// answers upgrades itself (the closing 503) and no read starts.
    upgrade_removed: std.atomic.Value(bool) = .init(false),
    listener: ?*anyopaque = null,
    /// Ignore callbacks from listeners that were replaced or stopped.
    listener_attempt: u64 = 0,
    /// Write callbacks of frames written inline, run at the end of the turn.
    deferred: std.ArrayList(Deferred) = .empty,
    /// `query_async` reads whose `done` has not finished (`stop` waits for
    /// none: `done` touches the pool). Own lock: `done` never takes live's.
    async_mutex: std.Thread.Mutex = .{},
    async_outstanding: usize = 0,
    async_idle: std.Thread.Condition = .{},
    /// Finished reads awaiting their continuation (`async_mutex`), run in
    /// completion order by one task (`drainReads`): a burst of completions
    /// costs one worker, and no continuation ever waits.
    finished_reads: std.ArrayList(*AsyncWork) = .empty,
    reads_draining: bool = false,
    /// Subscribe flows past their cursor live starts, awaiting their
    /// canonical boundary read (`continueCursorStarts`), in order, each with
    /// the `drainCanonical` task that issues it. A flow joins the last
    /// drainer only if no task was spawned since it (and it has not run);
    /// otherwise it gets a drainer of its own, as the per-flow task did.
    canonical_waiting: std.ArrayList(CanonicalWait) = .empty,
    /// The ticket of the last `drainCanonical` task spawned, until it runs.
    canonical_last: ?u64 = null,
    /// Charges of lookahead frames written but not yet sent by their drain.
    lookahead_unconsumed: usize = 0,
    /// TS #10089 `routePending` (atomic, like `pending_bytes`) and
    /// `pendingSends`' order (mutex held; entries at 0 are skipped lazily).
    route_pending: [3]std.atomic.Value(usize) = .{ .init(0), .init(0), .init(0) },
    lookahead_route: [3]usize = .{ 0, 0, 0 },
    pending_order: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty,
    /// Peers corked this turn (one reference each; a flushed peer stays).
    corked: std.ArrayList(*Peer) = .empty,
    /// A heartbeat ran this turn: `clearCorked` trims the corked peers.
    trim_after_turn: bool = false,
    /// Cork non-awaited and drain frames per peer and turn (tests compare
    /// against uncorked writes).
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
    /// `-Dparity-hooks` builds only.
    hooks: if (runtime.parity_hooks) Hooks else void = if (runtime.parity_hooks) .{} else {},

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
            .validator_store = es.EventStore.init(allocator, loop, options.validator_db orelse db, options.batch_size),
            .listen_api = listen_api,
            .limits = options.limits,
            .production = options.production,
            .diagnostics_stream = diagnostics_stream,
            .parallel_flush_threads = @max(1, @min(PARALLEL_FLUSH_THREADS, http.effectiveCpus())),
        };
        self.agent_notifications = .init(loop, NOTIFICATION_BATCH_MS, self, drainAgentThunk, failAgentThunk);
        self.explorer_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainExplorerThunk, failExplorerThunk);
        self.confirmation_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainConfirmationThunk, failExplorerThunk);
        self.head_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainHeadThunk, failHeadThunk);
        self.validator_updates = .init(loop, NOTIFICATION_BATCH_MS, self, drainValidatorThunk, failValidatorThunk);
        loop.turn_end = .{ .ctx = self, .func = endTurnThunk };
        self.message_source = msrc.MessageSource.create(allocator, loop, &self.store, self.messageHost(), &self.explorer_refreshes);
        self.createSources();
        return self;
    }

    fn messageHost(self: *Server) msrc.Host {
        return .{
            .ctx = self,
            .send = hostSend,
            .make_frame = hostMakeFrame,
            .send_frame = hostSendFrame,
            .release_frame = hostReleaseFrame,
            .fail = hostFail,
            .retain = hostRetain,
            .release = hostRelease,
        };
    }

    fn hostSend(ctx: *anyopaque, peer_ptr: *anyopaque, frame: []const u8) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        const peer: *Peer = @ptrCast(@alignCast(peer_ptr));
        const shared = SharedFrame.create(self.allocator, self.allocator.dupe(u8, frame) catch oom());
        defer shared.release(self.allocator);
        self.enqueueExplorer(peer, &.{shared});
    }

    fn hostMakeFrame(ctx: *anyopaque, bytes: []const u8) *anyopaque {
        const self: *Server = @ptrCast(@alignCast(ctx));
        return SharedFrame.create(self.allocator, self.allocator.dupe(u8, bytes) catch oom());
    }

    fn hostSendFrame(ctx: *anyopaque, peer_ptr: *anyopaque, frame_ptr: *anyopaque) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        const frame: *SharedFrame = @ptrCast(@alignCast(frame_ptr));
        self.enqueueExplorer(@ptrCast(@alignCast(peer_ptr)), &.{frame});
    }

    fn hostReleaseFrame(ctx: *anyopaque, frame_ptr: *anyopaque) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        const frame: *SharedFrame = @ptrCast(@alignCast(frame_ptr));
        frame.release(self.allocator);
    }

    fn hostFail(ctx: *anyopaque, peer_ptr: *anyopaque, message: []const u8) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.failSocket(@ptrCast(@alignCast(peer_ptr)), message);
    }

    fn hostRetain(_: *anyopaque, peer_ptr: *anyopaque) void {
        const peer: *Peer = @ptrCast(@alignCast(peer_ptr));
        peer.retain();
    }

    fn hostRelease(_: *anyopaque, peer_ptr: *anyopaque) void {
        const peer: *Peer = @ptrCast(@alignCast(peer_ptr));
        peer.release();
    }

    /// `new EventSource(this.store)` and `new EventSource(this.validatorStore,
    /// VALIDATOR_SOURCE_LIMITS)`.
    fn createSources(self: *Server) void {
        self.event_source = evs.EventSource.create(self.allocator, self.loop, self.sourceHost(sourceReadAgent), .{});
        self.validator_source = evs.EventSource.create(self.allocator, self.loop, self.sourceHost(sourceReadValidator), evs.VALIDATOR_LIMITS);
    }

    fn sourceHost(self: *Server, read: @FieldType(evs.Host, "read")) evs.Host {
        return .{
            .ctx = self,
            .read = read,
            .make_frame = hostMakeFrame,
            .send_frame = sourceSendFrame,
            .release_frame = hostReleaseFrame,
            .active = sourceActive,
            .fail = hostFail,
            .retain = hostRetain,
            .release = hostRelease,
        };
    }

    fn sourceReadAgent(ctx: *anyopaque, event_type: EventType, domain: u32, after: protocol.Position, through: i128) anyerror!protocol.Reader {
        const self: *Server = @ptrCast(@alignCast(ctx));
        return self.store.confirmationEventRows(event_type, domain, after, through);
    }

    fn sourceReadValidator(ctx: *anyopaque, event_type: EventType, domain: u32, after: protocol.Position, through: i128) anyerror!protocol.Reader {
        const self: *Server = @ptrCast(@alignCast(ctx));
        return self.validator_store.confirmationEventRows(event_type, domain, after, through);
    }

    /// `queueData(socket, message)`.
    fn sourceSendFrame(ctx: *anyopaque, peer_ptr: *anyopaque, frame_ptr: *anyopaque) bool {
        const self: *Server = @ptrCast(@alignCast(ctx));
        const frame: *SharedFrame = @ptrCast(@alignCast(frame_ptr));
        return self.enqueue(@ptrCast(@alignCast(peer_ptr)), &.{frame});
    }

    /// `this.clients.get(socket) === client`.
    fn sourceActive(_: *anyopaque, peer_ptr: *anyopaque) bool {
        const peer: *Peer = @ptrCast(@alignCast(peer_ptr));
        return peer.in_clients;
    }

    /// After `stop()` and once every socket has closed.
    pub fn destroy(self: *Server) void {
        const a = self.allocator;
        if (comptime runtime.parity_hooks) self.hooks.deinit(a);
        self.event_source.stop();
        _ = self.event_source.release();
        self.validator_source.stop();
        _ = self.validator_source.release();
        self.message_source.stop();
        self.message_source.release();
        self.explorer_refreshes.deinit(a);
        for (&self.queues) |*queue| queue.deinit(a);
        self.store.deinit();
        self.validator_store.deinit();
        // Reservations of sockets that never reported 'close' (a forced shutdown).
        for (self.validator_clients.keys()) |peer| {
            peer.validator.reserved = false;
            peer.release();
        }
        self.validator_clients.deinit(a);
        self.validator_notifications.deinit(a);
        self.validator_head_ranges.deinit(a);
        self.clients.deinit(a);
        self.block_subscriptions.deinit(a);
        self.explorer_clients.deinit(a);
        for (self.explorer_clients_by_ip.keys()) |ip| a.free(ip);
        self.explorer_clients_by_ip.deinit(a);
        for (self.explorer_pending_setups_by_ip.keys()) |ip| a.free(ip);
        self.explorer_pending_setups_by_ip.deinit(a);
        self.explorer_notifications.deinit(a);
        self.notifications.deinit(a);
        self.pending_heads.deinit(a);
        self.head_ranges.deinit(a);
        self.head_failures.deinit(a);
        self.deferred.deinit(a);
        self.pending_order.deinit(a);
        self.finished_reads.deinit(a);
        // `Pool.deinit` ran every drainer (each finishes its flows once stopping).
        std.debug.assert(self.canonical_waiting.items.len == 0 and self.canonical_last == null);
        self.canonical_waiting.deinit(a);
        self.flush_payloads.deinit(a);
        self.corked.deinit(a);
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
                    self.releaseSent(item.peer, item.len, item.epoch);
                    if (item.drain) self.drainQueue(item.peer);
                }
                // A lookahead frame is only written when its send is certain.
                std.debug.assert(item.peer.cork.lookahead == null);
                item.peer.release();
                continue;
            }
            self.releaseSent(item.peer, item.len, item.epoch);
            if (item.drain) self.drainQueue(item.peer);
            item.peer.release();
        }
        self.deferred.clearRetainingCapacity();
    }

    fn clearCorked(self: *Server) void {
        const trim = self.trim_after_turn;
        self.trim_after_turn = false;
        for (self.corked.items) |peer| {
            peer.cork.listed = false;
            if (trim) self.trimIdlePeer(peer);
            peer.release();
        }
        self.corked.clearRetainingCapacity();
    }

    /// Heartbeat turns: an idle peer gives back the list capacity its last
    /// burst left (cork, write requests, completions, Explorer queue);
    /// busy lists keep theirs.
    fn trimIdlePeer(self: *Server, peer: *Peer) void {
        const a = self.allocator;
        const cork = &peer.cork;
        if (cork.frames.items.len == 0 and cork.outcomes.items.len == 0 and cork.lookahead == null) {
            cork.bytes.clearAndFree(a);
            cork.frames.clearAndFree(a);
            cork.outcomes.clearAndFree(a);
            cork.outcome_head = 0;
        }
        // Write requests still in flight (e.g. this heartbeat's frame): the
        // completion that empties them trims instead (`applyCompletions`).
        if (peer.requests.items.len == 0) peer.requests.clearAndFree(a) else peer.trim_requests = true;
        {
            peer.completion_mutex.lock();
            defer peer.completion_mutex.unlock();
            if (peer.completed.items.len == 0) peer.completed.clearAndFree(a);
        }
        if (peer.out.length() == 0) {
            peer.out.queue.clearAndFree(a);
            peer.out.queue_head = 0;
        }
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
        const released_all = self.allocator.dupe(*SendJob, self.released_scratch.items) catch oom();
        defer self.allocator.free(released_all);
        var released = released_all;
        if (comptime runtime.parity_hooks) {
            // Written: Node's writable length drops; the callback waits (`hookRelease`).
            var kept: usize = 0;
            for (released_all) |job| {
                if (job.held) {
                    peer.subBuffered(job.len);
                    self.hooks.held.append(self.allocator, job) catch oom();
                } else {
                    released_all[kept] = job;
                    kept += 1;
                }
            }
            released = released_all[0..kept];
        }
        // Callbacks: the bytes leave the counts.
        var failed = false;
        for (released) |job| {
            peer.subBuffered(job.len);
            self.releaseSent(peer, job.len, job.epoch);
            failed = failed or !job.ok;
        }
        if (failed) self.failSend(peer, peer.socket.sendFailureText());
        if (peer.trim_requests and peer.requests.items.len == 0) {
            peer.trim_requests = false;
            peer.requests.clearAndFree(self.allocator);
            peer.completion_mutex.lock();
            defer peer.completion_mutex.unlock();
            if (peer.completed.items.len == 0) peer.completed.clearAndFree(self.allocator);
        }
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
                .explorer_drain, .diagnostics, .resumable => self.loop.handOff(.{ .run = .{ .ctx = job, .func = continueSend } }),
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
            .explorer_drain => if (ok) self.drainQueue(peer) else {
                peer.out.sending = false;
            },
            .diagnostics => |done| done.complete(ok),
            .resumable => |r| r.func(r, ok),
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
        // Parity hooks: the 30 s heartbeat runs only on `/tick` (ts-hooks.mjs
        // intercepts exactly `setInterval(…, 30_000)`; other periods run).
        const intercepted = runtime.parity_hooks and heartbeat_ms == HEARTBEAT_MS;
        if (comptime runtime.parity_hooks) self.hooks.heartbeat_intercepted = intercepted;
        if (!intercepted) self.heartbeat_timer = self.loop.scheduler.schedule(heartbeat_ms, self, onHeartbeatTimer);
        self.logger.info("event websockets listening on {s}, {s}, {s} batchSize={d} maxAgentClients={d} maxValidatorClients={d} maxBufferedBytes={d} maxTotalBufferedBytes={d}", .{
            AGENT_PATH,                        MESSAGE_PATH,                   VALIDATOR_PATH,                       self.store.batch_size, self.limits.max_agent_clients,
            self.limits.max_validator_clients, self.limits.max_buffered_bytes, self.limits.max_total_buffered_bytes,
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
        for ([_]*NotificationWorker{ &self.agent_notifications, &self.validator_updates, &self.explorer_updates, &self.head_updates, &self.confirmation_updates }) |worker| worker.stop();
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
        // `await this.stopListening?.(); this.httpServer?.off('upgrade', …)`,
        // then closeClients: under the loop mutex, so `accept` and the read
        // gate see it together with the 1001s.
        self.upgrade_removed.store(true, .release);
        self.closeClients("Server stopping", 1001);
        if (comptime runtime.parity_hooks) self.settleHeldOnStop();
        self.loop.unlock();
        // In-flight `query_async` reads finish (their continuations then see
        // closed clients and run in `Pool.deinit`).
        self.async_mutex.lock();
        while (self.async_outstanding > 0) self.async_idle.wait(&self.async_mutex);
        self.async_mutex.unlock();
        self.logHoldTimes();
    }

    // -- metrics ---------------------------------------------------------------

    pub fn metricsProvider(self: *Server) metrics.WebSocketMetricsProvider {
        return .{ .ctx = self, .snapshot = snapshotThunk };
    }

    fn snapshotThunk(ctx: *anyopaque, a: std.mem.Allocator) std.mem.Allocator.Error!metrics.WebSocketMetricsSnapshot {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.loop.lock();
        defer self.loop.unlock();
        return self.metricsSnapshotIn(a);
    }

    /// Without `validatorSubscriptions` (tests). Loop mutex held.
    pub fn metricsSnapshot(self: *Server) metrics.WebSocketMetricsSnapshot {
        return self.metricsSnapshotIn(null) catch unreachable;
    }

    /// `validatorSubscriptions` is allocated with `a` (the scrape's arena).
    pub fn metricsSnapshotIn(self: *Server, a: ?Allocator) Allocator.Error!metrics.WebSocketMetricsSnapshot {
        // Pool threads add, release and free peers under this mutex only.
        self.loop.assertHeld();
        var snapshot: metrics.WebSocketMetricsSnapshot = .{};
        var validator_subscriptions: std.ArrayList(metrics.ValidatorSubscription) = .empty;
        for (self.clients.keys()) |peer| {
            if (peer.validator.reserved) {
                const request = peer.agent.subscriptions.getPtr(.merkle_tree_insertion).* orelse continue;
                const allocator = a orelse continue;
                for (request.domains orelse &.{}) |domain| {
                    const counts = for (validator_subscriptions.items) |*entry| {
                        if (entry.domain == domain) break entry;
                    } else blk: {
                        try validator_subscriptions.append(allocator, .{ .domain = domain });
                        break :blk &validator_subscriptions.items[validator_subscriptions.items.len - 1];
                    };
                    if (request.confirmations == null) counts.canonical += 1 else counts.custom += 1;
                }
                continue;
            }
            for (std.enums.values(EventType)) |event_type| {
                if (peer.agent.subscriptions.get(event_type) == null) continue;
                const count = switch (event_type) {
                    .delivery => &snapshot.subscriptions.delivery,
                    .dispatch => &snapshot.subscriptions.dispatch,
                    .gas_payment => &snapshot.subscriptions.gas_payment,
                    .merkle_tree_insertion => &snapshot.subscriptions.merkle_tree_insertion,
                };
                count.* += 1;
            }
        }
        var explorer_messages: usize = 0;
        var max_explorer_bytes: usize = 0;
        var max_explorer_messages: usize = 0;
        var max_buffered: usize = 0;
        for (self.clients.keys()) |peer| max_buffered = @max(max_buffered, peer.bufferedAmount());
        for (self.explorer_clients.keys()) |peer| max_buffered = @max(max_buffered, peer.bufferedAmount());
        // TS #10089: the explorer queue's metrics (every socket it holds).
        for (self.queues[@intFromEnum(Route.explorer)].clients.keys()) |peer| {
            explorer_messages += peer.out.length();
            max_explorer_bytes = @max(max_explorer_bytes, peer.out.queued_bytes);
            max_explorer_messages = @max(max_explorer_messages, peer.out.length());
        }
        var max_per_ip: usize = 0;
        for (self.explorer_clients_by_ip.values()) |count| max_per_ip = @max(max_per_ip, count);
        const validators = self.validatorCount();
        snapshot.connections = .{ .agent = f(self.clients.count() - validators), .messages = f(self.explorer_clients.count()), .validators = f(validators) };
        var pending: usize = 0;
        var ips: std.ArrayList(struct { ip: []const u8, count: usize }) = .empty;
        defer ips.deinit(self.allocator);
        for (self.validator_clients.keys()) |peer| {
            pending += @intFromBool(peer.validator.pending);
            for (ips.items) |*entry| {
                if (std.mem.eql(u8, entry.ip, peer.validator.ip)) {
                    entry.count += 1;
                    break;
                }
            } else ips.append(self.allocator, .{ .ip = peer.validator.ip, .count = 1 }) catch oom();
        }
        var max_validator_per_ip: usize = 0;
        for (ips.items) |entry| max_validator_per_ip = @max(max_validator_per_ip, entry.count);
        snapshot.validatorPendingSetups = f(pending);
        snapshot.explorerPendingSetups = f(self.explorer_pending_setups);
        snapshot.validatorReservedConnections = f(self.validator_clients.count());
        // One public validator custom Merkle range per domain.
        snapshot.validatorSharedReaders = f(self.validator_source.metrics().ranges);
        snapshot.validatorSubscriptions = validator_subscriptions.items;
        snapshot.validatorClientIps = f(ips.items.len);
        snapshot.validatorMaxConnectionsPerIp = f(max_validator_per_ip);
        snapshot.explorerPendingMessages = f(explorer_messages);
        snapshot.explorerPendingBytes = f(self.queues[@intFromEnum(Route.explorer)].bytes);
        const source = self.message_source.metrics();
        snapshot.messageSource = .{ .ranges = f(source.ranges), .changes = f(source.changes), .factBytes = f(source.fact_bytes) };
        const events = self.event_source.metrics();
        snapshot.eventSource = .{ .ranges = f(events.ranges), .rows = f(events.rows), .bytes = f(events.bytes) };
        const validators_source = self.validator_source.metrics();
        snapshot.validatorSource = .{ .ranges = f(validators_source.ranges), .rows = f(validators_source.rows), .bytes = f(validators_source.bytes) };
        snapshot.queues = .{
            .agent = self.queueStats(.agent),
            .validators = self.queueStats(.validator),
            .messages = self.queueStats(.explorer),
        };
        snapshot.maxExplorerPendingBytes = f(max_explorer_bytes);
        snapshot.maxExplorerPendingMessages = f(max_explorer_messages);
        snapshot.messageClientIps = f(self.explorer_clients_by_ip.count());
        snapshot.messageMaxConnectionsPerIp = f(max_per_ip);
        snapshot.limits = .{
            .agentConnections = f(self.limits.max_agent_clients),
            .clientMessagesPerMinute = MAX_CLIENT_MESSAGES,
            .explorerPendingBytes = MAX_EXPLORER_PENDING_BYTES,
            .explorerPendingMessages = MAX_EXPLORER_PENDING_MESSAGES,
            .messageConnections = f(self.limits.max_explorer_clients),
            .messageConnectionsPerIp = MAX_EXPLORER_CLIENTS_PER_IP,
            .messageSetups = MAX_EXPLORER_PENDING_SETUPS,
            .messageSetupsPerIp = MAX_EXPLORER_PENDING_SETUPS_PER_IP,
            .validatorConnections = f(self.limits.max_validator_clients),
            .validatorSetups = MAX_VALIDATOR_PENDING_SETUPS,
            .validatorConnectionsPerIp = f(self.limits.max_validator_clients_per_ip),
            .validatorMessageBytes = MAX_VALIDATOR_MESSAGE_BYTES,
            .notificationEvents = MAX_PENDING_NOTIFICATIONS,
            .socketBufferedBytes = f(self.limits.max_buffered_bytes),
            .totalPendingBytes = f(self.limits.max_total_buffered_bytes),
        };
        snapshot.listenerReady = self.listener_ready;
        snapshot.maxClientBufferedBytes = f(max_buffered);
        snapshot.notificationQueue = .{ .agent = f(self.notifications.count()), .messages = f(self.explorer_notifications.count()), .validators = f(self.validator_notifications.count()) };
        snapshot.outboundPendingBytes = f(self.pending_bytes.load(.monotonic));
        return snapshot;
    }

    /// `BroadcastQueue.metrics()`' bytes and messages.
    fn queueStats(self: *const Server, route: Route) metrics.QueueStats {
        const queue = &self.queues[@intFromEnum(route)];
        var messages: usize = 0;
        for (queue.clients.keys()) |peer| messages += peer.out.length();
        return .{ .bytes = f(queue.bytes), .messages = f(messages) };
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
        /// Bytes received after the request head (ws `head`).
        head: []const u8 = "",
        /// The upgrade has a request body: `head` starts with body bytes,
        /// which ws consumes without a read batch (Node hides them).
        has_body: bool = false,
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
        // `Buffer.byteLength(request.url)`: the raw URL bytes.
        if (request.url.len > MAX_EXPLORER_SUBSCRIPTION_BYTES) {
            self.rejectNegotiation(peer, "Explorer subscription URL too long");
            return peer;
        }
        const params = protocol.QueryParams.fromUrl(a, request.url) catch oom();
        const custom = protocol.parseExplorerConfirmations(a, &params, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const blocks = protocol.parseExplorerBlocks(&params, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const message_ids = protocol.parseExplorerMessageIds(a, &params, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        const with_diagnostics = protocol.parseExplorerDiagnostics(&params, message_ids, &diag) catch |err| return self.negotiationFailed(peer, err, diag);
        // TS #10076: the same rule as /validators (the direct peer must be the
        // loopback cloudflared sidecar; then its cf-connecting-ip).
        const ip = validatorClientIp(self.production, .{ .url = request.url, .cf_connecting_ip = request.cf_connecting_ip, .remote_address = request.remote_address }) orelse {
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
        if (self.explorer_pending_setups >= MAX_EXPLORER_PENDING_SETUPS) {
            metrics.websocket_connection_rejections.inc(.{ "setup_limit", "messages" }, 1);
            socket.close(1013, "Maximum message setups reached");
            return peer;
        }
        const pending_for_ip = self.explorer_pending_setups_by_ip.get(ip) orelse 0;
        if (pending_for_ip >= MAX_EXPLORER_PENDING_SETUPS_PER_IP) {
            metrics.websocket_connection_rejections.inc(.{ "per_ip_setup_limit", "messages" }, 1);
            socket.close(1008, "Maximum setups per client reached");
            return peer;
        }
        self.explorer_pending_setups += 1;
        if (self.explorer_pending_setups_by_ip.getPtr(ip)) |count| {
            count.* += 1;
        } else self.explorer_pending_setups_by_ip.put(self.allocator, self.allocator.dupe(u8, ip) catch oom(), 1) catch oom();
        peer.explorer_setup = true;
        peer.head_message_pending = !request.has_body and headHasMessage(request.head);
        const owned_ip = self.allocator.dupe(u8, ip) catch oom();
        if (self.explorer_clients_by_ip.getPtr(ip)) |count| {
            count.* += 1;
        } else self.explorer_clients_by_ip.put(self.allocator, self.allocator.dupe(u8, ip) catch oom(), 1) catch oom();
        peer.in_explorer = true;
        peer.explorer = .{
            .domains = if (custom) |c| self.allocator.dupe(u32, c.domains) catch oom() else null,
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
        } else self.explorerAsync(peer, setup);
        return peer;
    }

    // -- Explorer setup as continuations -----------------------------------------

    /// `connectExplorer` after its synchronous prefix, without a task: the
    /// shared heads snapshot (`messageSource.currentHeads()`) is awaited for
    /// `blocks` and then for a custom subscription (TS #10078), each a
    /// continuation (`msrc.HeadsWaiter`).
    const ExplorerFlow = struct {
        peer: *Peer,
        setup: *ExplorerSetup,
        /// The source whose snapshot this await is on (one reference).
        source: ?*msrc.MessageSource = null,
        stage: enum { blocks, custom } = .blocks,
        waiter: msrc.HeadsWaiter = .{ .resume_fn = resumeExplorerHeads },
    };

    fn explorerAsync(self: *Server, peer: *Peer, setup: *ExplorerSetup) void {
        const flow = self.allocator.create(ExplorerFlow) catch oom();
        flow.* = .{ .peer = peer, .setup = setup };
        self.explorerHeads(flow, if (setup.blocks) .blocks else .custom);
    }

    /// `await this.messageSource.currentHeads()`.
    fn explorerHeads(self: *Server, flow: *ExplorerFlow, stage: @TypeOf(@as(ExplorerFlow, undefined).stage)) void {
        flow.stage = stage;
        if (flow.source) |old| old.release();
        const source = self.message_source.retain();
        flow.source = source;
        // A settled snapshot resumes as a microtask: after a frame already
        // buffered with the upgrade (handled on Node's nextTick).
        if (source.headsReady() and flow.peer.head_message_pending) {
            flow.peer.deferred_heads = &flow.waiter;
            return;
        }
        if (source.currentHeads(&flow.waiter)) self.readMessageHeads(source);
    }

    /// `head` starts with a complete, final text or binary frame (one ws
    /// 'message' before the setup's next continuation).
    fn headHasMessage(head: []const u8) bool {
        if (head.len < 2) return false;
        const opcode = head[0] & 0x0f;
        if (head[0] & 0x80 == 0 or (opcode != 1 and opcode != 2)) return false;
        var len: u64 = head[1] & 0x7f;
        var offset: usize = 2;
        if (len == 126) {
            if (head.len < 4) return false;
            len = std.mem.readInt(u16, head[2..4], .big);
            offset = 4;
        } else if (len == 127) {
            if (head.len < 10) return false;
            len = std.mem.readInt(u64, head[2..10], .big);
            offset = 10;
        }
        if (head[1] & 0x80 != 0) offset += 4;
        return head.len >= offset and head.len - offset >= len;
    }

    const HeadsRead = struct { source: *msrc.MessageSource, work: AsyncWork };

    /// The snapshot's `messageHeads()` read (no WHERE), reported to `source`.
    fn readMessageHeads(self: *Server, source: *msrc.MessageSource) void {
        const read = self.allocator.create(HeadsRead) catch oom();
        read.* = .{ .source = source.retain(), .work = .{ .query = self.newQuery(), .run = runHeadsRead } };
        const statement = es.EventStore.messageHeadsQuery(read.work.query.arena.allocator(), null) catch oom();
        read.work.query.sql = statement.sql;
        read.work.query.params = statement.params;
        self.issueRead(&read.work);
    }

    fn runHeadsRead(self: *Server, work: *AsyncWork) void {
        const read: *HeadsRead = @alignCast(@fieldParentPtr("work", work));
        defer {
            read.work.query.deinit();
            read.source.release();
            self.allocator.destroy(read);
        }
        if (read.work.query.failure()) |err| return read.source.headsFailed(errorMessage(err));
        read.source.headsLoaded(read.work.query.rows);
    }

    fn resumeExplorerHeads(waiter: *msrc.HeadsWaiter, failure: ?[]const u8) void {
        const flow: *ExplorerFlow = @alignCast(@fieldParentPtr("waiter", waiter));
        const peer = flow.peer;
        const self = peer.server;
        if (failure) |text| {
            // `finally releaseExplorerSetup`, then the connection's `.catch → failSocket`.
            self.releaseExplorerSetup(peer);
            self.failSocket(peer, text);
            return self.endExplorer(flow);
        }
        switch (flow.stage) {
            .blocks => {
                const custom = flow.setup.custom;
                self.applyHeads(peer, &flow.source.?.heads, if (custom) |c| c.domains else null);
                if (custom != null) return self.explorerHeads(flow, .custom);
                self.explorerReady(flow);
            },
            .custom => self.explorerReady(flow),
        }
    }

    fn endExplorer(self: *Server, flow: *ExplorerFlow) void {
        self.releaseExplorerSetup(flow.peer);
        if (flow.source) |source| source.release();
        if (flow.setup.custom) |c| self.allocator.free(c.domains);
        self.allocator.destroy(flow.setup);
        flow.peer.release();
        self.allocator.destroy(flow);
    }

    /// `finishExplorer` after its reads.
    fn explorerReady(self: *Server, flow: *ExplorerFlow) void {
        defer self.endExplorer(flow);
        // TS releases in the setup's `finally`, before `ready`.
        self.releaseExplorerSetup(flow.peer);
        self.completeExplorer(flow.peer, flow.setup);
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

    /// `connectExplorer` without reads (no blocks, no custom stream).
    fn finishExplorer(self: *Server, peer: *Peer, setup: *ExplorerSetup) void {
        defer {
            if (setup.custom) |c| self.allocator.free(c.domains);
            self.allocator.destroy(setup);
            peer.release();
        }
        std.debug.assert(!setup.blocks and setup.custom == null);
        self.releaseExplorerSetup(peer);
        self.completeExplorer(peer, setup);
    }

    /// `connectExplorer` after its reads: subscribe, `ready`, blocks, diagnostics.
    fn completeExplorer(self: *Server, peer: *Peer, setup: *ExplorerSetup) void {
        // Initialization awaits DB reads; the peer may already have disconnected.
        if (!peer.in_explorer or !peer.socket.isOpen()) return;
        var subscription: ?msrc.MessageSource.Subscription = if (setup.custom) |c|
            self.message_source.subscribe(c.confirmations, c.domains, peer.explorer.message_ids, peer)
        else
            null;
        defer if (subscription) |*sub| sub.deinit(self.allocator);
        if (subscription) |sub| peer.explorer.subscription = sub.sub;
        peer.explorer.ready = true;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        writeExplorerReady(&out.writer, peer, setup, if (subscription) |*sub| sub else null) catch oom();
        _ = self.send(peer, out.written());
        self.startBlocks(peer);
        if (setup.diagnostics) if (peer.explorer.message_ids) |ids| self.subscribeDiagnostics(peer, ids);
    }

    fn writeExplorerReady(w: *std.Io.Writer, peer: *Peer, setup: *const ExplorerSetup, subscription: ?*const msrc.MessageSource.Subscription) !void {
        var o = try frames.Object.begin(w);
        if (peer.explorer.message_ids) |ids| try o.strings("messageIds", ids);
        if (setup.custom) |custom| {
            try o.int("confirmations", custom.confirmations);
            try o.ints("domains", custom.domains);
            if (subscription) |sub| {
                try o.ints("customDomains", sub.custom_domains);
                try o.ints("canonicalDomains", sub.canonical_domains);
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
        // TS #10089: `!client || explorerQueue.busy(socket)`.
        if (!peer.in_explorer or peer.out.sending) {
            if (done) |d| d.complete(false);
            return false;
        }
        if (2 * (peer.bufferedAmount() + bytes.len) > self.limits.max_buffered_bytes or
            2 * (self.pending_bytes.load(.monotonic) + bytes.len) > self.limits.max_total_buffered_bytes or
            2 * (self.route_pending[@intFromEnum(Route.explorer)].load(.monotonic) + bytes.len) > self.outboundQuota(.explorer))
        {
            if (done) |d| d.complete(false);
            return false;
        }
        const accepted = self.sendSerialized(peer, bytes, if (done) |d| .{ .diagnostics = d } else .none);
        if (!accepted) if (done) |d| d.complete(false);
        return accepted;
    }

    fn accept(self: *Server, peer: *Peer) bool {
        // An upgrade HTTP handed over just before stop() removed the 'upgrade'
        // listener, reaching here after the 1001s went out (TS cannot: its
        // upgrade, accept and closeClients never interleave). Earlier, while
        // stop() awaits, TS accepts as usual (101, ready, then the 1001).
        if (self.upgrade_removed.load(.acquire)) {
            peer.wsClose(1001, "Server stopping");
            return false;
        }
        const full = if (peer.route == .agent)
            self.clients.count() - self.validatorCount() >= self.limits.max_agent_clients
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

    // -- socket events (called without the mutex) --------------------------------

    pub fn onMessage(self: *Server, peer: *Peer, data: []const u8) void {
        self.loop.lock();
        defer self.loop.unlock();
        self.onMessageLocked(peer, data);
    }

    /// Inside a read batch (`beginRead`): the mutex is already held.
    pub fn onMessageLocked(self: *Server, peer: *Peer, data: []const u8) void {
        self.loop.assertHeld();
        self.handleMessage(peer, data);
    }

    pub fn onPong(self: *Server, peer: *Peer) void {
        self.loop.lock();
        defer self.loop.unlock();
        self.onPongLocked(peer);
    }

    pub fn onPongLocked(self: *Server, peer: *Peer) void {
        self.loop.assertHeld();
        if (peer.in_clients) peer.agent.alive = true else if (peer.in_explorer) peer.explorer.alive = true;
    }

    pub fn onError(self: *Server, peer: *Peer, message: []const u8) void {
        self.loop.lock();
        defer self.loop.unlock();
        self.onErrorLocked(peer, message);
    }

    pub fn onErrorLocked(self: *Server, peer: *Peer, message: []const u8) void {
        self.loop.assertHeld();
        self.logger.warn("websocket error: {s}", .{message});
        self.disconnect(peer);
    }

    /// The frames of one socket read run as one turn, as Node's ws emits
    /// them inside one 'data' macrotask: continuations (microtasks) queued by
    /// a frame run after the last of them, at `endRead`.
    pub fn beginRead(self: *Server, peer: *Peer) void {
        self.loop.lock();
        peer.read_batch = true;
    }

    pub fn endRead(self: *Server, peer: *Peer) void {
        peer.read_batch = false;
        self.resumeDeferredHeads(peer);
        self.loop.unlock();
    }

    /// The upgrade's buffered frame was handled: the setup resumes (its
    /// microtask), after this read's turn.
    fn resumeDeferredHeads(self: *Server, peer: *Peer) void {
        peer.head_message_pending = false;
        const waiter = peer.deferred_heads orelse return;
        peer.deferred_heads = null;
        self.loop.handOff(.{ .run = .{ .ctx = waiter, .func = msrc.HeadsWaiter.run } });
    }

    /// A close frame or receiver error applied inside a read batch (mutex
    /// held): frames this peer sent earlier in the batch were written while
    /// it was OPEN (Node's `ws.send` writes at once), so its cork goes first.
    pub fn beforeTransition(self: *Server, peer: *Peer) void {
        self.loop.assertHeld();
        self.flushCork(peer, false);
    }

    /// ws 'close' (exactly once). Drops the connection's peer reference.
    pub fn onClose(self: *Server, peer: *Peer) void {
        self.loop.lock();
        self.disconnect(peer);
        peer.closed = true;
        // readyState is CLOSED from here: `disconnect`'s `releaseValidator`.
        self.releaseValidator(peer);
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

    // -- validators (`/validators`) -----------------------------------------------

    pub const ValidatorRequest = struct {
        /// Raw `request.url`.
        url: []const u8,
        /// `cf-connecting-ip` header (duplicates joined like Node), if present.
        cf_connecting_ip: ?[]const u8,
        /// `request.socket.remoteAddress`.
        remote_address: ?[]const u8,
    };

    pub const ValidatorAdmission = union(enum) {
        /// Answered with `HTTP/1.1 <status> Rejected` before upgrading.
        rejected: u16,
        admitted: struct { ip: []const u8, subscription: protocol.ValidatorSubscription },
    };

    /// `handleUpgrade`'s `/validators` admission, before `ws.handleUpgrade`.
    /// Loop mutex held; the caller keeps it until `connectValidator`, so
    /// admission and reservation are one step (in Node, ws's callback runs
    /// synchronously). An admitted `ip` is owned by the caller.
    pub fn admitValidator(self: *Server, request: ValidatorRequest) ValidatorAdmission {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const subscription = blk: {
            // `Buffer.byteLength(request.url)`: Node decodes the target as latin1.
            var bytes: usize = request.url.len;
            for (request.url) |byte| bytes += @intFromBool(byte >= 0x80);
            if (bytes > MAX_VALIDATOR_MESSAGE_BYTES) break :blk null;
            const params = protocol.QueryParams.fromUrl(arena.allocator(), request.url) catch oom();
            break :blk protocol.parseValidatorSubscription(&params);
        } orelse return self.rejectValidator(400, "invalid_subscription");
        const ip = validatorClientIp(self.production, request) orelse return self.rejectValidator(403, "invalid_client_ip");
        if (!self.listener_ready) return self.rejectValidator(503, "listener_unavailable");
        if (self.validator_clients.count() >= self.limits.max_validator_clients) return self.rejectValidator(503, "connection_limit");
        var pending: usize = 0;
        var peers: usize = 0;
        var peers_pending: usize = 0;
        for (self.validator_clients.keys()) |peer| {
            const same = std.mem.eql(u8, peer.validator.ip, ip);
            pending += @intFromBool(peer.validator.pending);
            peers += @intFromBool(same);
            peers_pending += @intFromBool(same and peer.validator.pending);
        }
        if (pending >= MAX_VALIDATOR_PENDING_SETUPS) return self.rejectValidator(503, "setup_limit");
        if (peers_pending >= MAX_VALIDATOR_PENDING_SETUPS_PER_IP) return self.rejectValidator(429, "per_ip_setup_limit");
        if (peers >= self.limits.max_validator_clients_per_ip) return self.rejectValidator(429, "per_ip_limit");
        return .{ .admitted = .{ .ip = self.allocator.dupe(u8, ip) catch oom(), .subscription = subscription } };
    }

    fn rejectValidator(_: *Server, status: u16, reason: []const u8) ValidatorAdmission {
        incValidatorRejection(reason);
        return .{ .rejected = status };
    }

    /// `websocketConnectionRejections.inc({ route: 'validators', reason })`.
    fn incValidatorRejection(reason: []const u8) void {
        metrics.websocket_connection_rejections.incOrdered(.{ reason, "validators" }, 1, .{ 1, 0 });
    }

    /// `validatorClientIp`: only a loopback peer (the cloudflared sidecar) is
    /// trusted, and its `cf-connecting-ip` names the client (outside
    /// production, the peer itself when absent).
    fn validatorClientIp(production: bool, request: ValidatorRequest) ?[]const u8 {
        const remote = request.remote_address orelse return null;
        const peer = if (std.mem.startsWith(u8, remote, "::ffff:")) remote[7..] else remote;
        if (peer.len == 0 or !protocol.isIp(peer)) return null;
        if (!std.mem.eql(u8, peer, "::1") and !std.mem.startsWith(u8, peer, "127.")) return null;
        const ip = request.cf_connecting_ip orelse (if (production) return null else peer);
        return if (protocol.isIp(ip)) ip else null;
    }

    /// `connectValidator`'s synchronous part (loop mutex held, right after
    /// the upgrade): register and reserve, then the setup continues on
    /// `query_async` reads. Takes ownership of `admission.ip`.
    pub fn connectValidator(self: *Server, socket: Socket, ip: []const u8, subscription: protocol.ValidatorSubscription) *Peer {
        const peer = self.newPeer(socket, .validator);
        peer.in_clients = true;
        peer.agent = .{ .message_window = self.loop.now(), .subscribing = true };
        self.clients.put(self.allocator, peer, {}) catch oom();
        peer.validator = .{ .reserved = true, .pending = true, .ip = ip };
        peer.retain(); // the reservation
        self.validator_clients.put(self.allocator, peer, {}) catch oom();
        metrics.websocket_connections.inc(.{"validators"}, 1);
        // `subscribeClient(socket, client, {type: 'subscribe', streams:
        // [{eventType: 'merkle_tree_insertion', domains, confirmations}]}, ready)`.
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        const a = arena.allocator();
        const streams = a.alloc(protocol.StreamRequest, 1) catch oom();
        streams[0] = .{
            .kind = .merkle_tree_insertion,
            .confirmations = subscription.confirmations,
            .domains = a.dupe(u32, &.{subscription.domain}) catch oom(),
        };
        const flow = self.newFlow(peer, arena, .{ .streams = streams }, .{ .ready = .{ .domain = subscription.domain, .confirmations = subscription.confirmations } });
        flow.phase = .exists;
        // Disconnected negotiations retain their work slot until the DB read ends.
        const statement = es.EventStore.domainExistsQuery(flow.work.query.arena.allocator(), subscription.domain) catch oom();
        self.issueFlowRead(flow, statement);
        return peer;
    }

    /// `connectValidator` after `await validatorStore.domainExists(domain)`.
    fn validatorDomainChecked(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        if (!peer.in_clients) return self.finishFlow(flow);
        if (flow.work.query.rows.len == 0) {
            var buffer: [64]u8 = undefined;
            self.rejectNegotiation(peer, std.fmt.bufPrint(&buffer, "Unknown domain {d}", .{flow.ack.ready.domain}) catch unreachable);
            return self.finishFlow(flow);
        }
        self.renewFlowQuery(flow);
        self.subscribeClient(flow);
    }

    /// `releaseValidator`: drop the reservation once the setup ended and the
    /// socket closed.
    fn releaseValidator(self: *Server, peer: *Peer) void {
        const client = &peer.validator;
        if (!client.reserved or client.pending or !peer.closed) return;
        client.reserved = false;
        _ = self.validator_clients.orderedRemove(peer);
        peer.release();
    }

    fn writeValidatorReady(w: *std.Io.Writer, domain: u32, confirmations: ?u64) !void {
        var o = try frames.Object.begin(w);
        try o.string("type", "ready");
        try o.int("domain", domain);
        if (confirmations) |count| try o.int("confirmations", count);
        try o.strings("eventTypes", &.{"merkle_tree_insertion"});
        try o.boolean("historicalStreaming", false);
        try o.int("liveStartVersion", 1);
        try o.end();
    }

    /// The validator socket's 'message' handler: only `{"type":"ping"}`.
    pub fn onValidatorMessage(self: *Server, peer: *Peer, data: []const u8, binary: bool) void {
        self.loop.lock();
        defer self.loop.unlock();
        self.onValidatorMessageLocked(peer, data, binary);
    }

    pub fn onValidatorMessageLocked(self: *Server, peer: *Peer, data: []const u8, binary: bool) void {
        self.loop.assertHeld();
        if (!peer.in_clients) return;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        var reason: []const u8 = "invalid_message";
        const message: []const u8 = blk: {
            if (!self.consumeMessage(&peer.agent)) {
                reason = "message_rate_limit";
                metrics.websocket_client_message_rejections.inc(.{}, 1);
                break :blk "Client message rate limit exceeded";
            }
            if (binary) break :blk "Expected a text ping";
            const value = json.parse(arena.allocator(), data, .{}) catch |err| switch (err) {
                error.OutOfMemory => oom(),
                error.SyntaxError => break :blk core.v8json.errorMessage(arena.allocator(), data) catch oom(),
            };
            if (!protocol.isValidatorPing(value)) break :blk protocol.VALIDATOR_PING_ERROR;
            _ = self.send(peer, "{\"type\":\"pong\"}");
            return;
        };
        self.rejectNegotiationAs(peer, message, reason, 1008);
    }

    /// Connected `/validators` sockets (reservations still in `clients`).
    fn validatorCount(self: *Server) usize {
        var count: usize = 0;
        for (self.validator_clients.keys()) |peer| count += @intFromBool(peer.in_clients);
        return count;
    }

    // Canonical publication for validators only (their own queue, worker and pool).

    fn queueValidatorNotification(self: *Server, notification: protocol.EventNotification) void {
        // Validators subscribe to Merkle insertions only, so the id alone is a key.
        std.debug.assert(notification.event_type == .merkle_tree_insertion);
        var buffer: [48]u8 = undefined;
        const key = std.fmt.bufPrint(&buffer, "{d}", .{notification.id}) catch unreachable;
        if (!self.validator_notifications.contains(key) and self.validator_notifications.count() >= MAX_PENDING_NOTIFICATIONS) {
            metrics.websocket_notification_queue_overflows.inc(.{"validators"}, 1);
            metrics.websocket_send_failures.inc(.{"notification_queue_limit"}, 1);
            self.failValidatorStream("Validator notification queue limit exceeded");
            return;
        }
        self.validator_notifications.put(self.allocator, key, notification) catch oom();
        self.validator_updates.schedule();
    }

    fn drainValidatorThunk(ctx: *anyopaque) anyerror!void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        return self.drainValidatorUpdates();
    }

    fn failValidatorThunk(ctx: *anyopaque, err: anyerror) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        self.failValidatorStream(errorMessage(err));
    }

    fn drainValidatorUpdates(self: *Server) !void {
        var batch: std.ArrayList(NotificationQueue(protocol.EventNotification).Entry) = .empty;
        defer batch.deinit(self.allocator);
        var notifications: std.ArrayList(protocol.EventNotification) = .empty;
        defer notifications.deinit(self.allocator);
        while (self.validator_notifications.count() > 0) {
            self.validator_notifications.takeFront(self.allocator, NOTIFICATION_BATCH_SIZE, &batch) catch oom();
            defer for (batch.items) |entry| self.allocator.free(entry.key);
            notifications.clearRetainingCapacity();
            for (batch.items) |entry| notifications.append(self.allocator, entry.value) catch oom();
            self.publishNotificationsWith(&self.validator_store, .merkle_tree_insertion, notifications.items) catch |err| {
                var copy: [512]u8 = undefined;
                const message = errorMessage(err);
                const owned = copy[0..@min(copy.len, message.len)];
                @memcpy(owned, message[0..owned.len]);
                var domains: std.ArrayList(u32) = .empty;
                defer domains.deinit(self.allocator);
                for (notifications.items) |notification| {
                    if (std.mem.indexOfScalar(u32, domains.items, notification.domain) == null) domains.append(self.allocator, notification.domain) catch oom();
                }
                for (domains.items) |domain| self.failValidatorDomain(domain, owned);
            };
        }
        // JS Map iteration: insertion order, entries added meanwhile included.
        var visited: u64 = 0;
        while (true) {
            var next: ?struct { domain: u32, range: HeadRange } = null;
            for (self.validator_head_ranges.keys(), self.validator_head_ranges.values()) |domain, range| {
                if (range.seq <= visited) continue;
                if (next == null or range.seq < next.?.range.seq) next = .{ .domain = domain, .range = range };
            }
            const entry = next orelse break;
            visited = entry.range.seq;
            var pages = self.validator_store.headEvents(.merkle_tree_insertion, entry.domain, entry.range.after, entry.range.through);
            defer pages.deinit();
            const published: anyerror!void = blk: {
                while (pages.next() catch |err| break :blk err) |events| {
                    if (self.stopped) return;
                    self.publish(pages.page.allocator(), .merkle_tree_insertion, events) catch |err| break :blk err;
                }
            };
            published catch |err| {
                var copy: [512]u8 = undefined;
                const message = errorMessage(err);
                const owned = copy[0..@min(copy.len, message.len)];
                @memcpy(owned, message[0..owned.len]);
                self.failValidatorDomain(entry.domain, owned);
            };
            releaseRange(&self.validator_head_ranges, entry.domain, entry.range);
        }
        if (self.validator_head_ranges.count() > 0) self.validator_updates.schedule();
    }

    /// Canonical validators of `domain` fail (custom readers stay).
    fn failValidatorDomain(self: *Server, domain: u32, message: []const u8) void {
        const peers = self.allocator.dupe(*Peer, self.validator_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            if (!peer.in_clients) continue;
            const subscription = peer.agent.subscriptions.getPtr(.merkle_tree_insertion);
            const request = if (subscription.*) |*value| value else continue;
            if (request.confirmations == null and request.domains != null and request.matchesDomain(domain)) self.failSocket(peer, message);
        }
    }

    fn failValidatorStream(self: *Server, message: []const u8) void {
        self.logger.err("validator event stream failed: {s}", .{message});
        self.validator_notifications.clear(self.allocator);
        self.validator_head_ranges.clearRetainingCapacity();
        const peers = self.allocator.dupe(*Peer, self.validator_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            if (!peer.in_clients) continue;
            const subscription = peer.agent.subscriptions.getPtr(.merkle_tree_insertion);
            const request = if (subscription.*) |*value| value else continue;
            if (request.confirmations == null) self.failSocket(peer, message);
        }
    }

    // -- parity hooks (`-Dparity-hooks` builds; parity/hooks/ts-hooks.mjs) ----------

    /// Held write callbacks: a frame chosen when it is sent (`decide`, the
    /// wrapped `WebSocket#send`) is written as usual, but once ws reports it
    /// written its callback (pendingBytes, the awaited continuation, a send
    /// failure) waits for `/release`, oldest first.
    pub const Hooks = struct {
        pub const Mode = enum { off, all, first_explorer };
        mode: Mode = .off,
        /// `first_explorer`: the first socket that sent a `message_upsert` (a reference).
        explorer: ?*Peer = null,
        held: std.ArrayList(*SendJob) = .empty,
        /// `start` left the 30 s heartbeat to `/tick`.
        heartbeat_intercepted: bool = false,

        fn decide(self: *Hooks, peer: *Peer, bytes: []const u8) bool {
            if (self.mode == .off) return false;
            var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
            defer arena.deinit();
            const value = json.parse(arena.allocator(), bytes, .{}) catch return false;
            const kind = value.get("type") orelse return false;
            if (kind != .string) return false;
            const name = kind.string;
            switch (self.mode) {
                .off => return false,
                .all => return std.mem.eql(u8, name, "event") or std.mem.eql(u8, name, "diagnostics") or std.mem.eql(u8, name, "message_upsert"),
                .first_explorer => {
                    if (!std.mem.eql(u8, name, "message_upsert")) return false;
                    if (self.explorer == null) {
                        peer.retain();
                        self.explorer = peer;
                    }
                    return self.explorer == peer;
                },
            }
        }

        fn dropExplorer(self: *Hooks) void {
            if (self.explorer) |peer| peer.release();
            self.explorer = null;
        }

        /// Teardown: the held callbacks never run (as in Node at exit).
        fn deinit(self: *Hooks, allocator: Allocator) void {
            for (self.held.items) |job| {
                const peer = job.peer;
                allocator.destroy(job);
                peer.release();
            }
            self.held.deinit(allocator);
            self.dropExplorer();
        }
    };

    /// `/hold?mode=`.
    pub fn hookMode(self: *Server, mode: Hooks.Mode) void {
        if (comptime !runtime.parity_hooks) unreachable;
        self.loop.lock();
        defer self.loop.unlock();
        self.hooks.mode = mode;
        if (mode != .first_explorer) self.hooks.dropExplorer();
    }

    /// `GET /held`.
    pub fn hookHeld(self: *Server) usize {
        if (comptime !runtime.parity_hooks) unreachable;
        self.loop.lock();
        defer self.loop.unlock();
        return self.hooks.held.items.len;
    }

    /// `/release[?error=]`: the oldest held callback, failed with `failure`
    /// when given (else the write's own outcome). Returns whether one ran.
    pub fn hookRelease(self: *Server, failure: ?[]const u8) struct { released: bool, held: usize } {
        if (comptime !runtime.parity_hooks) unreachable;
        self.loop.lock();
        defer self.loop.unlock();
        if (self.hooks.held.items.len == 0) return .{ .released = false, .held = 0 };
        const job = self.hooks.held.orderedRemove(0);
        self.runHeldCallback(job, failure);
        return .{ .released = true, .held = self.hooks.held.items.len };
    }

    /// `/release-all`: every held callback, oldest first, with its own outcome.
    pub fn hookReleaseAll(self: *Server) usize {
        if (comptime !runtime.parity_hooks) unreachable;
        self.loop.lock();
        defer self.loop.unlock();
        var count: usize = 0;
        while (self.hooks.held.items.len > 0) : (count += 1) self.runHeldCallback(self.hooks.held.orderedRemove(0), null);
        return count;
    }

    /// `/tick`: the heartbeat now (its interval never fires in hooks builds).
    /// Returns the heartbeats run (none once stopped: `clearInterval`).
    pub fn hookTick(self: *Server) usize {
        if (comptime !runtime.parity_hooks) unreachable;
        self.loop.lock();
        defer self.loop.unlock();
        if (self.stopped or !self.hooks.heartbeat_intercepted) return 0;
        self.heartbeat();
        return 1;
    }

    /// `stop`: Node exits with held callbacks pending; here their awaiting
    /// tasks and continuations must end (the pool joins its workers), so each
    /// completes as failed, silently (no `failSend`: no log, no metric).
    fn settleHeldOnStop(self: *Server) void {
        const held = self.hooks.held.toOwnedSlice(self.allocator) catch oom();
        defer self.allocator.free(held);
        for (held) |job| {
            const peer = job.peer;
            self.releaseSent(peer, job.len, job.epoch);
            switch (job.kind) {
                .none => {
                    self.allocator.destroy(job);
                    peer.release();
                },
                .waiter => |waiter| {
                    self.allocator.destroy(job);
                    peer.release();
                    resumeWaiter(self.loop, waiter, false);
                },
                .explorer_drain, .diagnostics, .resumable => {
                    job.ok = false;
                    self.loop.handOff(.{ .run = .{ .ctx = job, .func = continueSend } });
                },
            }
        }
    }

    /// The TS send callback: pendingBytes, the continuation, then a failure's `failSend`.
    fn runHeldCallback(self: *Server, job: *SendJob, failure: ?[]const u8) void {
        const peer = job.peer;
        const ok = failure == null and job.ok;
        self.releaseSent(peer, job.len, job.epoch);
        peer.retain();
        defer peer.release();
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
            .explorer_drain, .diagnostics, .resumable => {
                job.ok = ok;
                self.loop.handOff(.{ .run = .{ .ctx = job, .func = continueSend } });
            },
        }
        if (!ok) self.failSend(peer, failure orelse peer.socket.sendFailureText());
    }

    // -- agent protocol ------------------------------------------------------------

    fn handleMessage(self: *Server, peer: *Peer, raw: []const u8) void {
        if (!peer.in_clients) {
            // TS #10076: /messages is server-only; its 'message' handler rejects
            // (protocol pongs never reach here).
            if (peer.in_explorer) {
                metrics.websocket_client_message_rejections.inc(.{}, 1);
                self.rejectNegotiation(peer, "Client messages are unsupported");
            }
            return;
        }
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
            // TS #10089: a SubscriptionCapacityError rejects the negotiation.
            if (err == error.Invalid and diag.capacity) return self.rejectNegotiation(peer, diag.message);
            self.sendError(peer, if (err == error.Invalid) diag.message else @errorName(err));
            return;
        };
        const subscribe_message = switch (message) {
            .ping => {
                _ = self.send(peer, "{\"type\":\"pong\"}");
                return;
            },
            .subscribe => |value| value,
        };
        if (client.count() > 0 or client.subscribing or peer.blocks != null) {
            self.sendError(peer, "Already subscribed");
            return;
        }
        const flow = self.newFlow(peer, arena, subscribe_message, .subscribed);
        arena_owned = false;
        self.subscribeClient(flow);
    }

    // -- subscribeClient (TS #10089) -------------------------------------------
    //
    // Both event endpoints negotiate, register and start through one flow,
    // without a task: each await (the validator domain check, block heads,
    // the confirmation snapshots, awaited live starts, the boundary read) is
    // a `query_async` read or a resumable send whose continuation runs the
    // next step; no step waits. Every exit goes through `finishFlow`.

    /// What `subscribeClient` sends once registered.
    const Acknowledgement = union(enum) {
        /// /agents: `{confirmationsByDomain?, streams, type: 'subscribed'}`.
        subscribed,
        /// /validators: `ready`.
        ready: struct { domain: u32, confirmations: ?u64 },
    };

    const SubscribeFlow = struct {
        server: *Server,
        /// A reference.
        peer: *Peer,
        arena: std.heap.ArenaAllocator,
        message: protocol.Subscribe,
        /// `eventStreams`: the event streams split by effective confirmations.
        event_streams: []const protocol.StreamRequest,
        ack: Acknowledgement,
        /// `requests` and their `policies` (confirmation count -> domains).
        requests: []const evs.Request = &.{},
        policies: []const es.EventStore.Policy = &.{},
        phase: enum { exists, blocks, snapshot, boundary } = .blocks,
        work: AsyncWork,
        /// The source `attempt` read against (a reference): `closeClients`
        /// may replace it meanwhile.
        source: ?*evs.EventSource = null,
        attempt: evs.Attempt = undefined,
        /// This flow's handle on `client.events`: its cursors stay readable
        /// (a rollback clears a boundary before its live start is sent).
        events: ?evs.Subscription = null,
        stage: enum { cursors, canonical } = .cursors,
        next: usize = 0,
        plan: ?CanonicalPlan = null,
        boundaries: es.EventStore.Boundaries = .empty,
        requested: std.ArrayList(u32) = .empty,
        frame: std.ArrayList(u8) = .empty,
        resumable: Resumable = .{ .func = resumeFlowSend },

        fn route(self: *const SubscribeFlow) Route {
            return self.peer.route;
        }

        fn store(self: *const SubscribeFlow) *es.EventStore {
            return if (self.route() == .validator) &self.server.validator_store else &self.server.store;
        }
    };

    /// Takes ownership of `arena` (which holds `message`).
    fn newFlow(self: *Server, peer: *Peer, arena: std.heap.ArenaAllocator, message: protocol.Subscribe, ack: Acknowledgement) *SubscribeFlow {
        const flow = self.allocator.create(SubscribeFlow) catch oom();
        flow.* = .{
            .server = self,
            .peer = peer,
            .arena = arena,
            .message = message,
            .event_streams = &.{},
            .ack = ack,
            .work = .{ .query = self.newQuery(), .run = runFlowRead },
        };
        peer.retain();
        const a = flow.arena.allocator();
        var event_streams: std.ArrayList(protocol.StreamRequest) = .empty;
        for (message.streams) |stream| {
            if (stream.kind == .blocks) continue;
            event_streams.appendSlice(a, protocol.splitConfirmationStreams(a, stream, message.confirmations_by_domain) catch oom()) catch oom();
        }
        flow.event_streams = event_streams.items;
        return flow;
    }

    /// `issueRead` on the flow's route pool (a fresh query each time).
    fn issueFlowRead(self: *Server, flow: *SubscribeFlow, statement: es.EventStore.Statement) void {
        flow.work.query.sql = statement.sql;
        flow.work.query.params = statement.params;
        self.issueReadOn(&flow.work, flow.store().db);
    }

    fn renewFlowQuery(self: *Server, flow: *SubscribeFlow) void {
        flow.work.query.deinit();
        flow.work.query = self.newQuery();
    }

    /// `subscribeClient(socket, client, message, acknowledgement)`: its
    /// synchronous prefix.
    fn subscribeClient(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        peer.agent.subscribing = true;
        const blocks = for (flow.message.streams) |request| {
            if (request.kind == .blocks) break request;
        } else null;
        const request = blocks orelse return self.subscribeEvents(flow);
        // `subscribeBlocks`: register before the snapshot; notifications
        // received during the query win.
        self.registerBlocks(peer, request.domains);
        flow.phase = .blocks;
        const statement = es.EventStore.messageHeadsQuery(flow.work.query.arena.allocator(), request.domains) catch oom();
        self.issueFlowRead(flow, statement);
    }

    fn runFlowRead(self: *Server, work: *AsyncWork) void {
        const flow: *SubscribeFlow = @alignCast(@fieldParentPtr("work", work));
        if (work.query.failure()) |err| return self.flowFailed(flow, errorMessage(err), false);
        switch (flow.phase) {
            .exists => self.validatorDomainChecked(flow),
            .blocks => self.flowBlocksRead(flow),
            .snapshot => self.flowSnapshotRead(flow),
            .boundary => self.flowBoundaryRead(flow),
        }
    }

    /// `await this.subscribeBlocks(...)` resumed.
    fn flowBlocksRead(self: *Server, flow: *SubscribeFlow) void {
        var heads = msrc.MessageSource.parseHeads(self.allocator, flow.work.query.rows) catch |err|
            return self.flowFailed(flow, errorMessage(err), false);
        defer heads.deinit(self.allocator);
        // The read is already filtered by the stream's domains.
        self.applyHeads(flow.peer, &heads, if (flow.peer.blocks) |b| b.domains else null);
        self.renewFlowQuery(flow);
        self.subscribeEvents(flow);
    }

    /// The `requests` loop, then `if (requests.length) await subscribeEvents(...)`.
    fn subscribeEvents(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        const a = flow.arena.allocator();
        var requests: std.ArrayList(evs.Request) = .empty;
        for (flow.event_streams) |request| {
            const event_type = request.kind.eventType() orelse continue;
            const domains = request.domains orelse continue;
            if (request.confirmations) |confirmations|
                requests.append(a, .{ .event_type = event_type, .confirmations = confirmations, .domains = domains }) catch oom();
            if (request.include_zero_confirmations == true and request.confirmations != 0)
                requests.append(a, .{ .event_type = event_type, .confirmations = 0, .domains = domains, .allow_unavailable = true }) catch oom();
        }
        flow.requests = requests.items;
        if (flow.requests.len == 0) return self.flowSubscribed(flow);
        // `await this.confirmationUpdates.flush()`: the drain is synchronous
        // (never waits), so this runs it now.
        std.debug.assert(!self.confirmation_updates.running);
        self.confirmation_updates.flush();
        if (!peer.in_clients) return self.finishFlow(flow);
        flow.policies = evs.EventSource.policies(a, flow.requests) catch oom();
        const source = if (flow.route() == .validator) self.validator_source else self.event_source;
        flow.source = source.retain();
        self.readSnapshots(flow);
    }

    /// `subscribe`'s loop head: `await store.confirmationSnapshots(policies)`.
    fn readSnapshots(self: *Server, flow: *SubscribeFlow) void {
        // Inactive peer or stopped source: TS's loop ends with no cursors.
        flow.attempt = flow.source.?.attempt(flow.peer) orelse return self.flowSubscribed(flow);
        flow.phase = .snapshot;
        // Never null: every request has domains.
        const statement = (es.EventStore.confirmationSnapshotsQuery(flow.work.query.arena.allocator(), flow.policies) catch oom()) orelse
            @panic("live: confirmation snapshot without policies");
        self.issueFlowRead(flow, statement);
    }

    fn flowSnapshotRead(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        const snapshots = es.EventStore.parseConfirmationSnapshots(self.allocator, flow.policies, flow.work.query.rows) catch |err|
            return self.flowFailed(flow, errorMessage(err), false);
        defer {
            for (snapshots) |*heads| heads.deinit(self.allocator);
            self.allocator.free(snapshots);
        }
        self.renewFlowQuery(flow);
        const source = flow.source.?;
        const result = source.subscribeWith(&flow.attempt, flow.requests, flow.policies, snapshots, peer) catch |err| {
            var buffer: [96]u8 = undefined;
            return switch (err) {
                error.ConfirmationUnavailable => self.flowFailed(flow, unavailableMessage(&buffer, flow.attempt.unavailable_domain), true),
                error.TemporarilyUnavailable => self.flowFailed(flow, evs.UNAVAILABLE_MESSAGE, false),
                error.RangeCapacity => self.flowFailed(flow, evs.RANGE_CAPACITY_MESSAGE, false),
            };
        };
        // A rollback landed during the read: read again.
        const events = result orelse return self.readSnapshots(flow);
        // `if (active) client.events = events; else events.stop()`.
        if (peer.in_clients) {
            std.debug.assert(peer.events == null);
            peer.events = events;
            flow.events = events.retain();
        } else {
            events.stop();
            events.deinit();
        }
        self.flowSubscribed(flow);
    }

    /// `subscribeClient` after its awaits: register, acknowledge, start.
    fn flowSubscribed(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        if (flow.source) |source| {
            flow.source = null;
            _ = source.release();
        }
        if (!peer.in_clients) return self.finishFlow(flow);
        const client = &peer.agent;
        // Retain the canonical group for live filtering when policies are mixed.
        for (flow.event_streams) |request| {
            const event_type = request.kind.eventType() orelse continue;
            if (request.confirmations != null and client.subscriptions.get(event_type) != null) continue;
            if (client.subscriptions.get(event_type)) |previous| if (previous.domains) |domains| self.allocator.free(domains);
            client.subscriptions.set(event_type, .{
                .confirmations = request.confirmations,
                .domains = if (request.domains) |domains| self.allocator.dupe(u32, domains) catch oom() else null,
            });
        }
        client.subscribing = false;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        switch (flow.ack) {
            .subscribed => writeSubscribed(&out.writer, flow.message) catch oom(),
            .ready => |ready| writeValidatorReady(&out.writer, ready.domain, ready.confirmations) catch oom(),
        }
        _ = self.send(peer, out.written());
        // `client.events?.start()`: a no-op once the client is gone.
        if (peer.events) |events| events.start();
        self.startBlocks(peer);
        flow.stage = .cursors;
        flow.next = 0;
        self.continueCursorStarts(flow);
    }

    /// `for (cursor of client.events?.starts ?? []) if (!(await sendLiveStart(...))) return`.
    fn continueCursorStarts(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        const starts: []const *evs.Cursor = if (flow.events) |events| events.starts() else &.{};
        while (flow.next < starts.len) {
            const cursor = starts[flow.next];
            flow.next += 1;
            // `sendLiveStart`: false once the client is gone.
            if (!peer.in_clients) return self.finishFlow(flow);
            // The boundary as of now: a rollback since `subscribe` cleared it.
            switch (self.sendFlowLiveStart(flow, cursor.domain, &.{cursor.event_type}, cursor.boundary, cursor.confirmations)) {
                .failed => return self.finishFlow(flow),
                .written => continue,
                .queued => return, // `resumeFlowSend`
            }
        }
        flow.plan = CanonicalPlan.init(self.allocator, flow.event_streams);
        if (flow.plan == null) return self.finishFlow(flow);
        if (starts.len > 0) {
            // TS awaits each cursor's `live_start` write callback (a later
            // turn) before `sendLiveStarts` issues the boundary read, and
            // `events.start()` issued the source's first range reads
            // synchronously before that. Those reads run as tasks here: the
            // boundary read is issued by a task in this flow's place in task
            // order, after every task spawned before now and before every
            // later one (only the issue is ordered, as in TS). The last
            // drainer serves when nothing was spawned since it; flows queued
            // after it are then issued in its turn, in order.
            const drainer = blk: {
                if (self.canonical_last) |last| if (self.loop.lastSpawned(last)) break :blk last;
                const ticket = self.loop.spawnTicket(drainCanonical, .{self});
                self.canonical_last = ticket;
                break :blk ticket;
            };
            self.canonical_waiting.append(self.allocator, .{ .flow = flow, .drainer = drainer }) catch oom();
            return;
        }
        self.readBoundaries(flow);
    }

    /// A flow waiting in `canonical_waiting`.
    const CanonicalWait = struct {
        flow: *SubscribeFlow,
        /// The ticket of the `drainCanonical` task that issues its read.
        drainer: u64,
    };

    /// A loop task (mutex held), in one turn: issue the boundary reads of
    /// the flows assigned to this task, in order. Tasks start in ticket
    /// order and flows queue in drainer order, so this task's flows are the
    /// queue's head. Once `stop` removed the upgrade listener
    /// `readBoundaries` finishes each flow instead.
    fn drainCanonical(self: *Server) void {
        const waiting = &self.canonical_waiting;
        std.debug.assert(waiting.items.len > 0);
        const ticket = waiting.items[0].drainer;
        // This task's own ticket (`awaitStart` just counted it).
        std.debug.assert(ticket + 1 == self.loop.next_start);
        if (self.canonical_last == ticket) self.canonical_last = null;
        var done: usize = 0;
        while (done < waiting.items.len and waiting.items[done].drainer == ticket) {
            // By value: `readBoundaries` may free the flow.
            const entry = waiting.items[done];
            done += 1;
            self.readBoundaries(entry.flow);
        }
        const left = waiting.items.len - done;
        std.mem.copyForwards(CanonicalWait, waiting.items[0..left], waiting.items[done..]);
        waiting.shrinkRetainingCapacity(left);
    }

    /// `sendLiveStarts(socket, client, canonical streams)` up to its
    /// boundary read (no client check: the read is issued regardless).
    fn readBoundaries(self: *Server, flow: *SubscribeFlow) void {
        // Once `stop` removed the upgrade listener no read starts.
        if (self.upgrade_removed.load(.acquire)) return self.finishFlow(flow);
        flow.phase = .boundary;
        const statement = es.EventStore.liveStartBoundariesQuery(flow.work.query.arena.allocator(), flow.plan.?.domainFilter()) catch oom();
        self.issueFlowRead(flow, statement);
    }

    fn flowBoundaryRead(self: *Server, flow: *SubscribeFlow) void {
        flow.boundaries = flow.store().parseLiveStartBoundaries(flow.work.query.rows) catch |err|
            return self.flowFailed(flow, errorMessage(err), false);
        // `new Set([...boundaries.keys(), ...requested domains])`.
        flow.requested.appendSlice(self.allocator, flow.boundaries.keys()) catch oom();
        for (flow.plan.?.requested_domains) |domain| if (std.mem.indexOfScalar(u32, flow.requested.items, domain) == null)
            flow.requested.append(self.allocator, domain) catch oom();
        flow.stage = .canonical;
        flow.next = 0;
        self.continueCanonicalStarts(flow);
    }

    /// `for (domain of requested) if (!(await sendLiveStart(...))) return`.
    fn continueCanonicalStarts(self: *Server, flow: *SubscribeFlow) void {
        const plan = &flow.plan.?;
        while (flow.next < flow.requested.items.len) {
            const domain = flow.requested.items[flow.next];
            flow.next += 1;
            if (!flow.peer.in_clients) break;
            var event_types: [EventType.all.len]EventType = undefined;
            var count: usize = 0;
            for (plan.streams) |stream| {
                if (stream.hasDomain(domain)) {
                    event_types[count] = stream.kind.eventType().?;
                    count += 1;
                }
            }
            switch (self.sendFlowLiveStart(flow, domain, event_types[0..count], flow.boundaries.get(domain), null)) {
                .failed => break,
                .written => continue,
                .queued => return, // `resumeFlowSend`
            }
        }
        self.finishFlow(flow);
    }

    /// `sendLiveStart`'s awaited send (the frame lives in the flow).
    fn sendFlowLiveStart(self: *Server, flow: *SubscribeFlow, domain: u32, event_types: []const EventType, boundary: ?protocol.LiveStartBoundary, confirmations: ?u64) SendOutcome {
        flow.frame.clearRetainingCapacity();
        var out: std.Io.Writer.Allocating = .fromArrayList(self.allocator, &flow.frame);
        writeLiveStart(&out.writer, domain, event_types, boundary, confirmations) catch oom();
        flow.frame = out.toArrayList();
        return self.sendFrame(flow.peer, flow.frame.items, .{ .resumable = &flow.resumable });
    }

    fn resumeFlowSend(resumable: *Resumable, ok: bool) void {
        const flow: *SubscribeFlow = @alignCast(@fieldParentPtr("resumable", resumable));
        const self = flow.server;
        if (!ok) return self.finishFlow(flow);
        switch (flow.stage) {
            .cursors => self.continueCursorStarts(flow),
            .canonical => self.continueCanonicalStarts(flow),
        }
    }

    /// A rejected await: /agents' `onMessage` catch, /validators'
    /// `connectValidator` catch (no identity guard: a client gone by now is
    /// still logged, and counted on /validators).
    fn flowFailed(self: *Server, flow: *SubscribeFlow, message: []const u8, unavailable: bool) void {
        // Once `stop` removed the upgrade listener reads fail at once ("Server
        // stopping"); TS's reads still run and find the client gone.
        if (self.upgrade_removed.load(.acquire)) return self.finishFlow(flow);
        var copy: [512]u8 = undefined;
        const text = copy[0..@min(copy.len, message.len)];
        @memcpy(text, message[0..text.len]);
        const peer = flow.peer;
        if (flow.route() == .validator) {
            if (unavailable)
                self.rejectNegotiationAs(peer, text, "invalid_subscription", 1008)
            else
                self.rejectNegotiationAs(peer, text, "setup_error", 1013);
        } else if (unavailable) {
            self.rejectNegotiation(peer, text);
        } else self.failSocket(peer, text);
        self.finishFlow(flow);
    }

    /// The flow's end; for /validators `connectValidator`'s `finally`: the
    /// setup slot is free, and a socket gone meanwhile releases its
    /// reservation once closed.
    fn finishFlow(self: *Server, flow: *SubscribeFlow) void {
        const peer = flow.peer;
        if (flow.route() == .validator) {
            peer.validator.pending = false;
            if (!peer.in_clients) self.releaseValidator(peer);
        }
        if (flow.events) |events| events.deinit();
        if (flow.source) |source| _ = source.release();
        if (flow.plan) |*plan| plan.deinit();
        flow.boundaries.deinit(self.allocator);
        flow.requested.deinit(self.allocator);
        flow.frame.deinit(self.allocator);
        flow.work.query.deinit();
        flow.arena.deinit();
        self.allocator.destroy(flow);
        peer.release();
    }

    fn newQuery(self: *Server) es.AsyncQuery {
        var query = es.AsyncQuery.init(self.allocator, asyncReadDone);
        query.owner = self;
        return query;
    }

    /// A `query_async` read and the continuation that consumes it.
    const AsyncWork = struct {
        query: es.AsyncQuery,
        run: *const fn (self: *Server, work: *AsyncWork) void,
    };

    /// Mutex held. Once `stop` removed the upgrade listener no query starts: the read fails at once and
    /// its continuation still runs (so its flow releases what it holds).
    fn issueRead(self: *Server, work: *AsyncWork) void {
        self.issueReadOn(work, self.store.db);
    }

    /// `issueRead` on `db` (the live or the validator pool).
    fn issueReadOn(self: *Server, work: *AsyncWork, db: es.Db) void {
        if (self.upgrade_removed.load(.acquire)) {
            // Straight into the query: this thread's error buffer may hold a
            // message a caller up the stack (a reaction loop) still reads.
            const message = "Server stopping";
            work.query.err = error.Failed;
            @memcpy(work.query.message[0..message.len], message);
            work.query.message_len = message.len;
            self.async_mutex.lock();
            defer self.async_mutex.unlock();
            self.queueFinished(work);
            return;
        }
        self.async_mutex.lock();
        self.async_outstanding += 1;
        self.async_mutex.unlock();
        db.query_async(db.ctx, &work.query);
    }

    /// `async_mutex` held: `work`'s continuation joins the drain.
    fn queueFinished(self: *Server, work: *AsyncWork) void {
        self.finished_reads.append(self.allocator, work) catch oom();
        if (!self.reads_draining) {
            self.reads_draining = true;
            self.loop.spawn(drainReads, .{self});
        }
    }

    /// Any thread, without live's mutex: queue the continuation (TS's
    /// `await queryLive` resumes as a macrotask).
    fn asyncReadDone(query: *es.AsyncQuery) void {
        const work: *AsyncWork = @alignCast(@fieldParentPtr("query", query));
        const self = serverOfRead(work);
        // One critical section; the pool's mutex (`spawn`) nests inside it
        // (the pool never takes `async_mutex`). The unlock is the last access
        // to the server: `stop` returns only after it.
        self.async_mutex.lock();
        self.queueFinished(work);
        self.async_outstanding -= 1;
        if (self.async_outstanding == 0) self.async_idle.broadcast();
        self.async_mutex.unlock();
    }

    /// The server a read belongs to (its `query.backend` is the db's).
    fn serverOfRead(work: *AsyncWork) *Server {
        return @ptrCast(@alignCast(work.query.owner));
    }

    /// The finished reads' continuations, in completion order. None waits.
    /// Each runs in a turn of its own (TS: one macrotask per pg result), so
    /// turn-end work (write callbacks, corks) and other lockers run between
    /// them; it is still one worker.
    fn drainReads(self: *Server) void {
        var first = true;
        while (true) {
            if (!first) {
                self.loop.unlock();
                self.loop.lock();
            }
            first = false;
            self.async_mutex.lock();
            if (self.finished_reads.items.len == 0) {
                self.reads_draining = false;
                self.async_mutex.unlock();
                return;
            }
            const work = self.finished_reads.orderedRemove(0);
            self.async_mutex.unlock();
            work.run(self, work);
        }
    }

    /// `sendLiveStarts`' streams and domains (its prefix). Owns copies.
    const CanonicalPlan = struct {
        arena: std.heap.ArenaAllocator,
        streams: []const protocol.StreamRequest,
        /// The canonical streams' domains, first occurrence order.
        requested_domains: []const u32,
        every_stream_has_domains: bool,

        /// Null without a canonical stream.
        fn init(gpa: Allocator, requests: []const protocol.StreamRequest) ?CanonicalPlan {
            var arena = std.heap.ArenaAllocator.init(gpa);
            const a = arena.allocator();
            var streams: std.ArrayList(protocol.StreamRequest) = .empty;
            var requested: std.ArrayList(u32) = .empty;
            var every = true;
            for (requests) |request| {
                if (request.kind == .blocks or request.confirmations != null) continue;
                var copy = request;
                if (request.domains) |domains| {
                    copy.domains = a.dupe(u32, domains) catch oom();
                    for (domains) |domain| if (std.mem.indexOfScalar(u32, requested.items, domain) == null)
                        requested.append(a, domain) catch oom();
                } else every = false;
                streams.append(a, copy) catch oom();
            }
            if (streams.items.len == 0) {
                arena.deinit();
                return null;
            }
            return .{ .arena = arena, .streams = streams.items, .requested_domains = requested.items, .every_stream_has_domains = every };
        }

        fn deinit(self: *CanonicalPlan) void {
            self.arena.deinit();
        }

        /// `liveStartBoundaries(domains)`: undefined if any stream has none.
        fn domainFilter(self: *const CanonicalPlan) ?[]const u32 {
            return if (self.every_stream_has_domains) self.requested_domains else null;
        }
    };

    fn writeLiveStart(w: *std.Io.Writer, domain: u32, event_types: []const EventType, boundary: ?protocol.LiveStartBoundary, confirmations: ?u64) !void {
        var o = try frames.Object.begin(w);
        try o.string("type", if (boundary != null) "live_start" else "live_start_unavailable");
        try o.int("domain", domain);
        if (confirmations) |count| try o.int("confirmations", count);
        if (boundary) |b| {
            try o.string("height", b.height());
            try o.string("hash", b.hash());
            try o.key("streams");
            try w.writeByte('[');
            for (event_types, 0..) |event_type, index| {
                if (index > 0) try w.writeByte(',');
                var s = try frames.Object.begin(w);
                try s.string("eventType", event_type.name());
                try s.string("address", b.contract(event_type));
                try s.end();
            }
            try w.writeByte(']');
        } else {
            try o.key("eventTypes");
            try w.writeByte('[');
            for (event_types, 0..) |event_type, index| {
                if (index > 0) try w.writeByte(',');
                try json.writeString(w, event_type.name());
            }
            try w.writeByte(']');
            try o.string("reason", "No healthy live-start scraper checkpoint");
        }
        try o.end();
    }

    /// `{confirmationsByDomain?, streams: subscriptionResponse[], type}`;
    /// each stream `{confirmations?, includeZeroConfirmations?, domains?, eventType}`.
    fn writeSubscribed(w: *std.Io.Writer, message: protocol.Subscribe) !void {
        try w.writeByte('{');
        if (message.confirmations_by_domain) |entries| {
            // `Object.fromEntries(map)`: the keys are domains ascending.
            try w.writeAll("\"confirmationsByDomain\":{");
            for (entries, 0..) |entry, index| {
                if (index > 0) try w.writeByte(',');
                try w.print("\"{d}\":{d}", .{ entry.domain, entry.confirmations });
            }
            try w.writeAll("},");
        }
        try w.writeAll("\"streams\":[");
        for (message.streams, 0..) |request, index| {
            if (index > 0) try w.writeByte(',');
            var o = try frames.Object.begin(w);
            if (request.confirmations) |confirmations| try o.int("confirmations", confirmations);
            if (request.include_zero_confirmations) |flag| try o.boolean("includeZeroConfirmations", flag);
            if (request.domains) |domains| try o.ints("domains", domains);
            try o.string("eventType", @tagName(request.kind));
            try o.end();
        }
        try w.writeAll("],\"type\":\"subscribed\"}");
    }

    fn consumeMessage(self: *Server, client: *AgentClient) bool {
        const now = self.loop.now();
        if (now - client.message_window >= 60_000) {
            client.message_window = now;
            client.messages = 0;
        }
        client.messages += 1;
        return client.messages <= MAX_CLIENT_MESSAGES;
    }

    // -- blocks ----------------------------------------------------------------------

    fn registerBlocks(self: *Server, peer: *Peer, domains: ?[]const u32) void {
        const subscription = self.allocator.create(BlockSubscription) catch oom();
        subscription.* = .{ .domains = if (domains) |d| self.allocator.dupe(u32, d) catch oom() else null };
        peer.blocks = subscription;
        self.block_subscriptions.put(self.allocator, peer, {}) catch oom();
    }

    /// `subscribeBlocks` after its snapshot: the latest head per domain
    /// (TS #10078 key order: `headHeight` before `hash`). Notifications that
    /// arrived meanwhile win.
    fn applyHeads(self: *Server, peer: *Peer, heads: *const std.AutoArrayHashMapUnmanaged(u32, msrc.Head), domains: ?[]const u32) void {
        // The subscription may be gone after the await (disconnect).
        const subscription = peer.blocks orelse return;
        for (heads.keys(), heads.values()) |domain, *head| {
            const hash = head.hash orelse continue;
            if (domains) |list| if (std.mem.indexOfScalar(u32, list, domain) == null) continue;
            if (subscription.latest.contains(domain)) continue;
            var out: std.Io.Writer.Allocating = .init(self.allocator);
            var o = frames.Object.begin(&out.writer) catch oom();
            o.string("type", "block") catch oom();
            o.int("domain", domain) catch oom();
            o.bigString("height", head.indexed) catch oom();
            o.bigString("headHeight", head.head) catch oom();
            o.string("hash", &hash) catch oom();
            o.end() catch oom();
            subscription.latest.put(self.allocator, domain, .{
                .frame = SharedFrame.create(self.allocator, out.toOwnedSlice() catch oom()),
                .height = head.indexed,
                .head_height = head.head,
                .hash = hash,
            }) catch oom();
        }
    }

    fn startBlocks(self: *Server, peer: *Peer) void {
        const subscription = peer.blocks orelse return;
        subscription.started = true;
        // Sends may terminate the peer (buffer limit) and free the subscription.
        const snapshot = self.allocator.alloc(*SharedFrame, subscription.latest.count()) catch oom();
        defer self.allocator.free(snapshot);
        for (subscription.latest.values(), snapshot) |latest, *frame| frame.* = latest.frame;
        for (snapshot) |frame| frame.refs += 1;
        defer for (snapshot) |frame| frame.release(self.allocator);
        // TS #10089: `queueData(socket, serializeShared(block))`.
        for (snapshot) |frame| _ = self.enqueue(peer, &.{frame});
    }

    fn publishBlock(self: *Server, domain: u32, frame: *SharedFrame, height: i128, head_height: i128, hash: [66]u8) void {
        const peers = self.allocator.dupe(*Peer, self.block_subscriptions.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            const subscription = peer.blocks orelse continue;
            if (!self.block_subscriptions.contains(peer)) continue;
            if (subscription.domains) |domains| if (std.mem.indexOfScalar(u32, domains, domain) == null) continue;
            if (subscription.latest.get(domain)) |previous|
                if (previous.height == height and std.mem.eql(u8, &previous.hash, &hash) and previous.head_height == head_height) continue;
            frame.refs += 1;
            const latest: LatestBlock = .{ .frame = frame, .height = height, .head_height = head_height, .hash = hash };
            if (subscription.latest.fetchPut(self.allocator, domain, latest) catch oom()) |old| old.value.frame.release(self.allocator);
            if (subscription.started) _ = self.enqueue(peer, &.{frame});
        }
    }

    fn clearBlocks(self: *Server, peer: *Peer) void {
        _ = self.block_subscriptions.orderedRemove(peer);
        const subscription = peer.blocks orelse return;
        peer.blocks = null;
        for (subscription.latest.values()) |latest| latest.frame.release(self.allocator);
        subscription.latest.deinit(self.allocator);
        if (subscription.domains) |domains| self.allocator.free(domains);
        self.allocator.destroy(subscription);
    }

    fn unavailableMessage(buffer: []u8, domain: u32) []const u8 {
        return std.fmt.bufPrint(buffer, "Custom confirmations unavailable for domain {d}", .{domain}) catch unreachable;
    }

    /// `client.events?.stop()`: the peer's handle is dropped.
    fn stopEvents(_: *Server, peer: *Peer) void {
        const events = peer.events orelse return;
        peer.events = null;
        events.stop();
        events.deinit();
    }

    /// `notifySources(head)`.
    fn notifySources(self: *Server, head: protocol.HeadNotification) void {
        self.event_source.notify(head);
        self.validator_source.notify(head);
        self.message_source.notify(head);
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
            const api = self.server.listen_api;
            self.result = (api.listen_unlogged orelse api.listen)(api.ctx, &listen_channels, self.context.handler());
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
        // An early listener connected silently: TS's `db.listen` logs here.
        if (context.early) if (self.listen_api.log_listening) |log| log(self.listen_api.ctx, &listen_channels);
        context.early = false;
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
            const head = try protocol.parseHeadNotification(a, payload, diag);
            self.message_source.observe(head);
            if (self.clients.count() == 0 and self.explorer_clients.count() == 0) return;
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
                self.publishBlock(head.domain, frame, head.indexed_height.?, head.head_height.?, head.indexed_hash.?[0..66].*);
            }
            const rollback = if (head.previous_indexed_height) |previous|
                head.indexed_height != null and head.indexed_height.? < previous
            else
                false;
            if (rollback) {
                // A rollback must invalidate in-flight readers immediately; never
                // coalesce it away with a subsequent forward observation.
                _ = self.pending_heads.orderedRemove(head.domain);
                self.notifySources(head);
            } else {
                self.pending_heads.put(self.allocator, head.domain, .init(head)) catch oom();
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
            self.message_source.invalidateIds(&.{message_id});
            self.queueExplorerNotification(message_id);
        } else {
            const notification = try protocol.parseEventNotification(a, payload, diag);
            if (!self.hasSubscriber(notification.domain, notification.event_type)) return;
            if (!self.hasSubscriberOf(notification.domain, notification.event_type, true)) {
                self.queueValidatorNotification(notification);
                return;
            }
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
        const heads = self.allocator.dupe(PendingHead, self.pending_heads.values()) catch oom();
        defer self.allocator.free(heads);
        self.pending_heads.clearRetainingCapacity();
        for (heads) |*head| self.notifySources(head.view());
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
            var live: std.ArrayList(protocol.EventNotification) = .empty;
            defer live.deinit(self.allocator);
            for (order.items) |event_type| {
                live.clearRetainingCapacity();
                for (grouped.get(event_type).items) |notification| {
                    if (self.hasSubscriberOf(notification.domain, notification.event_type, true)) {
                        live.append(self.allocator, notification) catch oom();
                    } else if (self.hasSubscriber(notification.domain, notification.event_type)) self.queueValidatorNotification(notification);
                }
                if (live.items.len > 0) try self.publishNotifications(event_type, live.items);
            }
        }
    }

    fn publishNotifications(self: *Server, event_type: EventType, notifications: []const protocol.EventNotification) !void {
        return self.publishNotificationsWith(&self.store, event_type, notifications);
    }

    fn publishNotificationsWith(self: *Server, store: *es.EventStore, event_type: EventType, notifications: []const protocol.EventNotification) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var expected: std.StringArrayHashMapUnmanaged(protocol.EventNotification) = .empty;
        for (notifications) |notification| expected.put(a, std.fmt.allocPrint(a, "{d}", .{notification.id}) catch oom(), notification) catch oom();
        const rows = try store.notifiedEvents(a, event_type, expected.keys());
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
        try self.publish(a, event_type, events.items);
    }

    /// `publish(eventType, row)`: every canonical subscriber of the row's
    /// domain gets one shared payload. Throws on malformed rows like TS.
    /// `publish(eventType, rows)` (TS #10089/#10090): one shared frame per row,
    /// queued per socket on its route queue; a turn after every
    /// `FANOUT_MESSAGES_PER_TURN` sends or `min(256 KiB, validators' quota)`.
    fn publish(self: *Server, a: Allocator, event_type: EventType, rows: []const Value) !void {
        const budget = @min(FANOUT_BYTES_PER_TURN, self.outboundQuota(.validator));
        var bytes: usize = 0;
        var sends: usize = 0;
        for (rows) |row| {
            const domain = try es.rowDomain(row, es.domainColumn(event_type));
            var shared: ?*SharedFrame = null;
            defer if (shared) |frame| frame.release(self.allocator);
            const peers = self.allocator.dupe(*Peer, self.clients.keys()) catch oom();
            defer self.allocator.free(peers);
            for (peers) |peer| peer.retain();
            defer for (peers) |peer| peer.release();
            for (peers) |peer| {
                if (!peer.in_clients) continue;
                const subscription = peer.agent.subscriptions.getPtr(event_type);
                const request = if (subscription.*) |*value| value else continue;
                if (request.confirmations != null or !request.matchesDomain(domain)) continue;
                const frame = shared orelse blk: {
                    const payload = try es.eventMessage(a, event_type, row);
                    shared = SharedFrame.create(self.allocator, self.allocator.dupe(u8, payload) catch oom());
                    break :blk shared.?;
                };
                if (bytes > 0 and bytes + frame.bytes.len > budget) {
                    bytes = 0;
                    sends = 0;
                    self.nextTurn();
                    if (!peer.in_clients) continue;
                }
                _ = self.enqueue(peer, &.{frame});
                bytes += frame.bytes.len;
                sends += 1;
                if (sends >= FANOUT_MESSAGES_PER_TURN or bytes >= budget) {
                    bytes = 0;
                    sends = 0;
                    self.nextTurn();
                }
            }
        }
    }

    /// `await nextTurn()` (setImmediate) in a task: threads already waiting
    /// for the mutex run first (`Loop.yieldTurn`).
    fn nextTurn(self: *Server) void {
        self.loop.yieldTurn();
    }

    /// `outboundQuota(route)`: agents may hold half the in-flight budget, each
    /// public route a quarter (at least 1 KiB, at most the whole budget).
    fn outboundQuota(self: *const Server, route: Route) usize {
        const total: usize = @intCast(self.limits.max_total_buffered_bytes);
        const share = total / (if (route == .agent) @as(usize, 2) else 4);
        return @min(total, @max(1024, share));
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

    /// `publishExplorer(ids)`: the refresh runs on its own (at most
    /// `MAX_EXPLORER_REFRESHES` in flight), then `await publishCanonicalMessages(ids)`.
    fn publishExplorer(self: *Server, message_ids: []const []const u8) !void {
        if (self.explorer_clients.count() == 0) return;
        const source = self.message_source.retain();
        defer source.release();
        source.invalidateIds(message_ids);
        // Shared fact reads should not hold back head publication, but a backlog
        // must pace the drain rather than overflow the shared read queue (#10085).
        source.refreshIds(message_ids);
        self.explorer_refreshes.pace(self.loop, self.allocator);
        self.publishCanonicalMessages(message_ids);
    }

    fn publishCanonicalMessages(self: *Server, message_ids: []const []const u8) void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var canonical: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (self.explorer_clients.keys()) |peer| {
            if (!peer.explorer.ready or peer.explorer.custom) continue;
            for (message_ids) |id| if (peer.explorer.hasId(id)) canonical.put(a, id, {}) catch oom();
        }
        if (canonical.count() == 0) return;
        const rows = self.store.canonicalMessages(a, canonical.keys()) catch |err| {
            const text = a.dupe(u8, errorMessage(err)) catch oom();
            const peers = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
            defer self.allocator.free(peers);
            for (peers) |peer| peer.retain();
            defer for (peers) |peer| peer.release();
            for (peers) |peer| {
                if (!peer.in_explorer or !peer.explorer.ready or peer.explorer.custom) continue;
                const wanted = for (canonical.keys()) |id| {
                    if (peer.explorer.hasId(id)) break true;
                } else false;
                if (wanted) self.failSocket(peer, text);
            }
            return;
        };
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
        // TS #10090: a turn after every `min(256 KiB, messages' quota)` queued.
        const budget = @min(FANOUT_BYTES_PER_TURN, self.outboundQuota(.explorer));
        var bytes: usize = 0;
        // `for (const [socket, client] of this.explorerClients)`: live Map
        // iteration. The map only changes across a yield, so the clients still
        // to visit (in Map order) are listed again after each one: clients
        // added meanwhile join at the end, removed ones are skipped. Listed and
        // visited peers are retained (until relisted / the end), so a freed
        // one's address is never reused by a newcomer that would be skipped.
        var visited: std.AutoArrayHashMapUnmanaged(*Peer, void) = .empty;
        var remaining: std.ArrayList(*Peer) = .empty;
        var next: usize = 0;
        defer {
            for (remaining.items[next..]) |peer| peer.release();
            remaining.deinit(self.allocator);
            for (visited.keys()) |peer| peer.release();
            visited.deinit(self.allocator);
        }
        var stale = true;
        while (true) {
            if (stale) {
                stale = false;
                for (remaining.items[next..]) |peer| peer.release();
                remaining.clearRetainingCapacity();
                next = 0;
                for (self.explorer_clients.keys()) |candidate| {
                    if (visited.contains(candidate)) continue;
                    candidate.retain();
                    remaining.append(self.allocator, candidate) catch oom();
                }
            }
            if (next == remaining.items.len) break;
            const peer = remaining.items[next];
            next += 1;
            // Its reference moves to `visited`.
            visited.put(self.allocator, peer, {}) catch oom();
            if (!peer.in_explorer or !peer.explorer.ready or peer.explorer.custom) continue;
            var selected: std.ArrayList(*SharedFrame) = .empty;
            for (messages) |message| {
                if (peer.explorer.message_ids != null and (message.id == null or !peer.explorer.hasId(message.id.?))) continue;
                selected.append(a, message.frame) catch oom();
            }
            if (selected.items.len == 0) continue;
            var frame_bytes: usize = 0;
            for (selected.items) |frame| frame_bytes += frame.bytes.len;
            if (bytes > 0 and bytes + frame_bytes > budget) {
                bytes = 0;
                self.nextTurn();
                stale = true;
                if (!peer.in_explorer) continue;
            }
            self.enqueueExplorer(peer, selected.items);
            bytes += frame_bytes;
            if (bytes >= budget) {
                bytes = 0;
                self.nextTurn();
                stale = true;
            }
        }
    }

    fn queueOf(self: *Server, peer: *const Peer) *RouteQueue {
        return &self.queues[@intFromEnum(peer.route)];
    }

    /// `queueData(socket, message)` / `explorerQueue.enqueue(socket, messages)`.
    fn enqueueExplorer(self: *Server, peer: *Peer, messages: []const *SharedFrame) void {
        _ = self.enqueue(peer, messages);
    }

    /// `BroadcastQueue.enqueue(socket, messages)` on the peer's route queue.
    fn enqueue(self: *Server, peer: *Peer, messages: []const *SharedFrame) bool {
        const queue = self.queueOf(peer);
        const client = &peer.out;
        queue.clients.put(self.allocator, peer, {}) catch oom();
        var bytes: usize = 0;
        for (messages) |message| bytes += message.bytes.len;
        if (client.length() + messages.len > MAX_EXPLORER_PENDING_MESSAGES or client.queued_bytes + bytes > MAX_EXPLORER_PENDING_BYTES) {
            self.failQueued(peer);
            return false;
        }
        while (queue.bytes + queue.added(messages) > queue.total) {
            // Evict whichever client alone holds the most queued bytes. A
            // client's shared frames stay queued for others, so evicting it
            // frees only the buffers no other client holds.
            var victim = peer;
            var largest = queue.exclusiveBytes(self.allocator, peer) + queue.added(messages);
            var largest_backlog = client.queued_bytes + bytes;
            var backlog_peer = peer;
            for (queue.clients.keys()) |other| {
                if (other == peer) continue;
                const held = queue.exclusiveBytes(self.allocator, other);
                if (held > largest) {
                    victim = other;
                    largest = held;
                }
                if (other.out.queued_bytes > largest_backlog) {
                    backlog_peer = other;
                    largest_backlog = other.out.queued_bytes;
                }
            }
            // TS #10090: a deeper backlog can be held jointly even if no peer has
            // enough exclusive bytes to win. Its frames are reclaimed on the last
            // release.
            if (victim == peer) victim = backlog_peer;
            self.failQueued(victim);
            if (victim == peer) return false;
        }
        for (messages) |message| {
            message.refs += 1;
            queue.retain(self.allocator, message);
            client.queue.append(self.allocator, message) catch oom();
        }
        client.queued_bytes += bytes;
        if (!client.sending) self.drainQueue(peer);
        return true;
    }

    /// `BroadcastQueue.fail`: remove, then the route's `fail` callback.
    fn failQueued(self: *Server, peer: *Peer) void {
        self.removeQueued(peer);
        metrics.websocket_send_failures.inc(.{"queue_limit"}, 1);
        self.failSocket(peer, "outbound message queue limit exceeded");
    }

    /// `drain`: frames written inline continue at once; queued ones resume from
    /// their send completion.
    fn drainQueue(self: *Server, peer: *Peer) void {
        const client = &peer.out;
        const queue = self.queueOf(peer);
        while (true) {
            client.sending = true;
            if (!queue.clients.contains(peer) or client.length() == 0) {
                client.sending = false;
                return;
            }
            const message = client.queue.items[client.queue_head];
            client.queue_head += 1;
            if (client.queue_head == client.queue.items.len) {
                client.queue.clearRetainingCapacity();
                client.queue_head = 0;
            }
            queue.release(message);
            client.queued_bytes -|= message.bytes.len;
            defer message.release(self.allocator);
            switch (self.sendFrame(peer, message.bytes, .explorer_drain)) {
                .failed => {
                    // `if (!(await send)) remove(socket)`.
                    client.sending = false;
                    self.removeQueued(peer);
                    return;
                },
                .queued => return,
                .written => {},
            }
        }
    }

    /// `BroadcastQueue.remove(socket)`.
    fn removeQueued(self: *Server, peer: *Peer) void {
        const queue = self.queueOf(peer);
        const client = &peer.out;
        for (client.queue.items[client.queue_head..]) |message| {
            if (queue.clients.contains(peer)) queue.release(message);
            message.release(self.allocator);
        }
        client.queue.clearRetainingCapacity();
        client.queue_head = 0;
        client.queued_bytes = 0;
        _ = queue.clients.orderedRemove(peer);
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
                    if (failure.explorer_affected and self.explorer_clients.count() > 0) self.failExplorerDomain(domain, original);
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
        releaseRange(&self.head_ranges, domain, range);
    }

    fn releaseRange(ranges: *std.AutoArrayHashMapUnmanaged(u32, HeadRange), domain: u32, range: HeadRange) void {
        const current = ranges.getPtr(domain) orelse return;
        if (current.through <= range.through) {
            _ = ranges.orderedRemove(domain);
        } else {
            current.after = range.through;
        }
    }

    fn publishHeadRange(self: *Server, domain: u32, range: HeadRange, failure: *HeadFailure) !void {
        var agent_published = false;
        const has_message_clients = for (self.explorer_clients.keys()) |peer| {
            const client = &peer.explorer;
            // TS #10080: near-head receipts of another origin refresh through this range.
            if (client.ready and client.readsMessages()) break true;
        } else false;
        var explorer_pending = has_message_clients;
        // Delivery and gas share message ids; queue each Explorer id once per range.
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var explorer_ids: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (HEAD_PUBLICATION_ORDER) |event_type| {
            const agent_interested = self.hasSubscriber(domain, event_type);
            const explorer_interested = has_message_clients and (event_type == .delivery or event_type == .gas_payment);
            if (!agent_interested and !explorer_interested) continue;
            if (agent_interested and !explorer_interested and !self.hasSubscriberOf(domain, event_type, true)) {
                if (self.validator_head_ranges.getPtr(domain)) |current| {
                    if (range.after < current.after) current.after = range.after;
                    if (range.through > current.through) current.through = range.through;
                } else {
                    self.head_range_seq += 1;
                    self.validator_head_ranges.put(self.allocator, domain, .{ .after = range.after, .through = range.through, .seq = self.head_range_seq }) catch oom();
                }
                self.validator_updates.scheduleAfter(0);
                continue;
            }
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
                try self.publish(pages.page.allocator(), event_type, events);
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
        for (self.explorer_clients.keys()) |peer| if (peer.explorer.ready and peer.explorer.hasId(message_id)) return true;
        return false;
    }

    fn hasSubscriber(self: *Server, domain: u32, event_type: EventType) bool {
        return self.hasSubscriberOf(domain, event_type, false);
    }

    /// `hasSubscriber(notification, agentsOnly)`.
    fn hasSubscriberOf(self: *Server, domain: u32, event_type: EventType, agents_only: bool) bool {
        for (self.clients.keys()) |peer| {
            if (agents_only and peer.validator.reserved) continue;
            const subscription = peer.agent.subscriptions.getPtr(event_type);
            const request = if (subscription.*) |*value| value else continue;
            if (request.confirmations == null and request.matchesDomain(domain)) return true;
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
            for (&peer.agent.subscriptions.values) |*entry| {
                if (entry.*) |*subscription| if (subscription.matchesDomain(domain)) {
                    matches = true;
                };
            }
            if (!matches) continue;
            self.disconnect(peer);
            peer.wsClose(1013, "Event stream read failed");
        }
    }

    /// TS #10078: only the message subscriptions overlapping `domain` end.
    fn failExplorerDomain(self: *Server, domain: u32, message: []const u8) void {
        self.logger.err("Explorer domain {d} failed: {s}", .{ domain, message });
        var buffer: [64]u8 = undefined;
        const reason = std.fmt.bufPrint(&buffer, "Message domain {d} unavailable", .{domain}) catch unreachable;
        const peers = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| peer.retain();
        defer for (peers) |peer| peer.release();
        for (peers) |peer| {
            if (!peer.in_explorer) continue;
            if (peer.explorer.readsMessages() and peer.explorer.coversDomain(domain)) self.failSocket(peer, reason);
        }
    }

    fn failExplorerStream(self: *Server, message: []const u8) void {
        self.logger.err("Explorer event stream failed: {s}", .{message});
        self.closeExplorerClients("Event stream read failed", 1013);
    }

    fn closeClients(self: *Server, reason: []const u8, code: u16) void {
        self.event_source.stop();
        self.validator_source.stop();
        _ = self.event_source.release();
        _ = self.validator_source.release();
        self.createSources();
        self.pending_heads.clearRetainingCapacity();
        self.message_source.stop();
        self.message_source.release();
        self.message_source = msrc.MessageSource.create(self.allocator, self.loop, &self.store, self.messageHost(), &self.explorer_refreshes);
        self.closeAgentClients(reason, code);
        self.closeExplorerClients(reason, code);
    }

    fn closeAgentClients(self: *Server, reason: []const u8, code: u16) void {
        self.clearNotifications();
        self.validator_notifications.clear(self.allocator);
        self.validator_head_ranges.clearRetainingCapacity();
        self.head_ranges.clearRetainingCapacity();
        self.head_failures.clearRetainingCapacity();
        const peers = self.allocator.dupe(*Peer, self.clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| {
            self.disconnect(peer);
            peer.wsClose(code, reason);
        }
    }

    fn closeExplorerClients(self: *Server, reason: []const u8, code: u16) void {
        self.clearExplorerNotifications();
        const peers = self.allocator.dupe(*Peer, self.explorer_clients.keys()) catch oom();
        defer self.allocator.free(peers);
        for (peers) |peer| {
            self.disconnect(peer);
            peer.wsClose(code, reason);
        }
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

    /// `-Dloop-hold-stats=true` builds: cumulative loop mutex hold and wait
    /// times, at info (every heartbeat and at stop; the
    /// shipped build logs nothing TS does not). `heartbeat` excludes its
    /// turn end.
    fn logHoldTimes(self: *Server) void {
        if (!runtime.hold_stats) return;
        self.logger.info("loop hold all {f}", .{&self.loop.hold});
        self.logger.info("loop hold turnEnd {f}", .{&self.loop.turn_end_hold});
        self.logger.info("loop hold heartbeat {f}", .{&self.heartbeat_hold});
        self.logger.info("loop wait any {f}", .{&self.loop.wait_any});
        self.logger.info("loop wait loopThread {f}", .{&self.loop.wait_loop_thread});
    }

    fn heartbeat(self: *Server) void {
        // TS sends each client `new Date().toISOString()` after its ping;
        // the text only changes with the millisecond, so it is reformatted
        // only then (sends copy the bytes).
        var buffer: [80]u8 = undefined;
        var frame: []const u8 = "";
        var frame_ms: ?i64 = null;
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
                const now = self.loop.now();
                if (frame_ms != now) {
                    frame = std.fmt.bufPrint(&buffer, "{{\"serverTime\":\"{s}\",\"type\":\"heartbeat\"}}", .{isoTime(now)}) catch unreachable;
                    frame_ms = now;
                }
                _ = self.send(peer, frame);
                // Not corked (written at once or queued): trim now.
                if (!peer.cork.listed) self.trimIdlePeer(peer);
            }
        }
        // Corked heartbeat frames are written at the turn's end; trim then.
        self.trim_after_turn = true;
    }

    // -- sending ---------------------------------------------------------------------

    fn send(self: *Server, peer: *Peer, bytes: []const u8) bool {
        return self.sendSerialized(peer, bytes, .none);
    }

    /// Tests only: a direct (non-awaited) frame, as `send` (loop mutex held).
    /// Published events are queued since TS #10089, so the coalescing tests
    /// size their direct frames through this.
    pub fn sendForTest(self: *Server, peer: *Peer, bytes: []const u8) bool {
        if (!@import("builtin").is_test) @compileError("tests only");
        return self.send(peer, bytes);
    }

    /// `sendAndWait`: blocks this task (mutex released) until the frame is
    /// written or fails.
    fn sendAndWait(self: *Server, peer: *Peer, bytes: []const u8) bool {
        var waiter: Waiter = .{};
        if (!self.sendSerialized(peer, bytes, .{ .waiter = &waiter })) return false;
        // Written inline (ws completions finish waiters only in `passEnd`,
        // under the loop mutex held here).
        if (waiter.event.isSet()) return waiter.ok;
        runtime.assertMayBlock();
        self.loop.unlock();
        waiter.event.wait();
        self.loop.lockHandoff(&waiter);
        return waiter.ok;
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
        // Parity hooks: a frame whose callback will be held takes ws's write
        // path, so its completion arrives where Node's write callback fires;
        // while holding, nothing is corked (no drain lookahead runs ahead).
        const cork_ok = if (comptime runtime.parity_hooks) self.hooks.mode == .off else true;
        if (cork_ok and self.coalesce and (kind == .none or kind == .explorer_drain) and peer.socket.vtable.try_send_inline_many != null) {
            if (self.corkFrame(peer, bytes, kind)) |outcome| return outcome;
        }
        // Anything else goes out after the frames corked before it.
        if (peer.cork.frames.items.len > 0) {
            self.flushCork(peer, false);
            if (peer.terminated) return .failed;
        }
        const state = peer.socket.snapshot();
        if (!state.open) return .failed;
        if (peer.bufferedAmount() + bytes.len > self.limits.max_buffered_bytes) {
            metrics.websocket_send_failures.inc(.{"buffer_limit"}, 1);
            self.failSocket(peer, "outbound buffer limit exceeded");
            return .failed;
        }
        if (!self.admitSend(peer, bytes.len)) return .failed;
        // Parity hooks: decided where ts-hooks' wrapped `WebSocket#send` runs
        // (after TS's readyState and buffer checks).
        const hold = if (comptime runtime.parity_hooks) self.hooks.decide(peer, bytes) else false;
        // Charged and referenced before the attempt: a partial write's
        // completion may run on another thread before the call returns.
        const epoch = self.chargeSent(peer, bytes.len);
        peer.addBuffered(bytes.len);
        const job = self.allocator.create(SendJob) catch oom();
        job.* = .{ .server = self, .peer = peer, .len = bytes.len, .kind = kind, .epoch = epoch };
        if (comptime runtime.parity_hooks) job.held = hold;
        peer.retain();
        // Node writes at once only while no request is in flight; otherwise
        // the frame waits behind it (whatever ws holds right now).
        if (!hold and kind != .diagnostics and peer.requests.items.len == 0) if (peer.socket.vtable.try_send_inline) |try_inline| {
            switch (try_inline(peer.socket.ptr, bytes, job)) {
                .written => {
                    // Written whole at once: never in `bufferedAmount`.
                    peer.subBuffered(bytes.len);
                    self.allocator.destroy(job);
                    switch (kind) {
                        // An awaited send resumes after its callback, which has
                        // released the bytes by then: complete now, uncharged.
                        .waiter => |waiter| {
                            self.releaseSent(peer, bytes.len, epoch);
                            peer.release();
                            waiter.finish(true);
                            return .written;
                        },
                        // As `.waiter`: the sender continues at once.
                        .resumable => {
                            self.releaseSent(peer, bytes.len, epoch);
                            peer.release();
                            return .written;
                        },
                        // Node fires the write callback after the current synchronous
                        // code even for a synchronous write: keep the bytes charged
                        // (aggregate limit decisions across a fan-out loop) and run
                        // the callback at the end of this turn.
                        .none, .explorer_drain => {
                            self.deferred.append(self.allocator, .{ .peer = peer, .len = bytes.len, .drain = kind == .explorer_drain, .epoch = epoch }) catch oom();
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
                    self.releaseSent(peer, bytes.len, epoch);
                    peer.subBuffered(bytes.len);
                    self.allocator.destroy(job);
                    peer.release();
                    if (kind == .waiter) kind.waiter.finish(false);
                    // A socket that closed since the check: `sendSerialized`
                    // returns false, as for `readyState !== OPEN`.
                    if (result == .failed) self.failSend(peer, peer.socket.sendFailureText());
                    return .failed;
                },
                .busy => {},
            }
        };
        if (!peer.socket.send(bytes, job)) {
            self.releaseSent(peer, bytes.len, epoch);
            peer.subBuffered(bytes.len);
            self.allocator.destroy(job);
            peer.release();
            self.failSend(peer, peer.socket.sendFailureText());
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
        if (!self.fitsBudgets(peer.route, bytes.len)) {
            // Not certain: decide on the uncorked path (charges flushed).
            return null;
        }
        const epoch = self.chargeSent(peer, bytes.len);
        const job = self.allocator.create(SendJob) catch oom();
        job.* = .{ .server = self, .peer = peer, .len = bytes.len, .kind = kind, .epoch = epoch };
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
        self.deferred.append(self.allocator, .{ .peer = peer, .len = bytes.len, .drain = kind == .explorer_drain, .corked = true, .epoch = epoch }) catch oom();
        // A drain frame waits for its callback (like `sendSerializedAndWait`).
        return if (kind == .explorer_drain) .queued else .written;
    }

    /// Charge an in-flight frame (mutex held): global, route and socket
    /// (`pendingSends` re-orders a socket whose reservation had emptied).
    fn chargeSent(self: *Server, peer: *Peer, len: usize) u32 {
        if (peer.pending.fetchAdd(len, .monotonic) == 0) {
            _ = self.pending_order.orderedRemove(peer);
            self.pending_order.put(self.allocator, peer, {}) catch oom();
        }
        _ = self.route_pending[@intFromEnum(peer.route)].fetchAdd(len, .monotonic);
        _ = self.pending_bytes.fetchAdd(len, .monotonic);
        return peer.pending_epoch.load(.acquire);
    }

    /// A frame's send callback (any thread): `release()` unless disconnect
    /// already released the socket's whole reservation.
    fn releaseSent(self: *Server, peer: *Peer, len: usize, epoch: u32) void {
        var current = peer.pending.load(.monotonic);
        while (true) {
            if (peer.pending_epoch.load(.acquire) != epoch or current < len) return;
            current = peer.pending.cmpxchgWeak(current, current - len, .monotonic, .monotonic) orelse break;
        }
        _ = self.route_pending[@intFromEnum(peer.route)].fetchSub(len, .monotonic);
        _ = self.pending_bytes.fetchSub(len, .monotonic);
    }

    /// `releasePending(socket)` (disconnect, mutex held): the whole reservation
    /// leaves the budgets at once.
    fn releasePending(self: *Server, peer: *Peer) void {
        _ = peer.pending_epoch.fetchAdd(1, .acq_rel);
        const amount = peer.pending.swap(0, .monotonic);
        _ = self.route_pending[@intFromEnum(peer.route)].fetchSub(amount, .monotonic);
        _ = self.pending_bytes.fetchSub(amount, .monotonic);
        _ = self.pending_order.orderedRemove(peer);
    }

    /// Charges that count toward limit decisions (lookahead frames are not
    /// charged in Node until the drain sends them).
    fn routeCharged(self: *const Server, route: Route) usize {
        return self.route_pending[@intFromEnum(route)].load(.monotonic) - self.lookahead_route[@intFromEnum(route)];
    }

    fn totalCharged(self: *const Server) usize {
        return self.pending_bytes.load(.monotonic) - self.lookahead_unconsumed;
    }

    fn fitsBudgets(self: *const Server, route: Route, len: usize) bool {
        return self.routeCharged(route) + len <= self.outboundQuota(route) and
            self.totalCharged() + len <= self.limits.max_total_buffered_bytes;
    }

    /// TS #10089 `sendSerialized`'s budget loop: over the route quota or the
    /// global budget, fail the largest pending sender (within the route when
    /// the route is full; public routes never evict agents; on a tie an agent
    /// sender prefers a public victim). False: the sender itself was failed.
    fn admitSend(self: *Server, peer: *Peer, len: usize) bool {
        if (self.fitsBudgets(peer.route, len)) return true;
        // Corked frames are charged: decide on real charges.
        if (self.corked.items.len > 0) self.flushAllCorks();
        const route = peer.route;
        const quota = self.outboundQuota(route);
        while (!self.fitsBudgets(route, len)) {
            const route_full = self.routeCharged(route) + len > quota;
            var victim = peer;
            var largest = peer.pending.load(.monotonic) + len;
            for (self.pending_order.keys()) |other| {
                if (other == peer) continue;
                if (route_full and other.route != route) continue;
                if (route != .agent and other.route == .agent) continue;
                const held = other.pending.load(.monotonic);
                if (held == 0) continue;
                if (held > largest or (!route_full and route == .agent and other.route != .agent and held == largest)) {
                    victim = other;
                    largest = held;
                }
            }
            metrics.websocket_send_failures.inc(.{"buffer_limit"}, 1);
            self.failSocket(victim, "outbound buffer limit exceeded");
            if (victim == peer) return false;
            // Disconnect releases a victim's whole reservation; one that freed
            // nothing would loop forever, so the sender goes instead.
            if (victim.pending.load(.monotonic) != 0) {
                metrics.websocket_send_failures.inc(.{"buffer_limit"}, 1);
                self.failSocket(peer, "outbound buffer limit exceeded");
                return false;
            }
        }
        return true;
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
        self.lookahead_route[@intFromEnum(peer.route)] -= lookahead.bytes.len;
        switch (lookahead.outcome) {
            .written => {
                // Like a corked frame that reached the kernel: released by its
                // deferred callback (the job's peer reference moves to it).
                const len = lookahead.bytes.len;
                const epoch = job.epoch;
                self.allocator.destroy(job);
                peer.cork.outcomes.append(self.allocator, .written) catch oom();
                self.deferred.append(self.allocator, .{ .peer = peer, .len = len, .drain = true, .corked = true, .epoch = epoch }) catch oom();
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
                self.releaseSent(peer, job.len, job.epoch);
                self.allocator.destroy(job);
                peer.release();
                // Closed meanwhile: like `readyState !== OPEN`, no failure.
                if (peer.socket.isOpen()) self.failSend(peer, peer.socket.sendFailureText());
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
            job.epoch = self.chargeSent(peer, job.len);
            self.lookahead_unconsumed += job.len;
            self.lookahead_route[@intFromEnum(peer.route)] += job.len;
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
                self.releaseSent(peer, job.len, job.epoch);
                self.allocator.destroy(job);
                peer.release();
                // A drain whose frame was not sent stops.
                if (frame.drain) peer.out.sending = false;
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
                self.releaseSent(peer, job.len, job.epoch);
                self.lookahead_unconsumed -= job.len;
                self.lookahead_route[@intFromEnum(peer.route)] -= job.len;
                self.allocator.destroy(job);
                peer.release();
            }
        }
        cork.frames.clearRetainingCapacity();
        cork.bytes.clearRetainingCapacity();
        cork.framed = 0;
        if (failed and !closed) self.failSend(peer, peer.socket.sendFailureText());
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
            if (peer.terminated or !self.queueOf(peer).clients.contains(peer)) continue;
            const k = seen.getOrPut(self.allocator, peer) catch oom();
            if (!k.found_existing) k.value_ptr.* = 0;
            const index = peer.out.queue_head + k.value_ptr.*;
            k.value_ptr.* += 1;
            if (index < peer.out.queue.items.len) total += peer.out.queue.items[index].bytes.len;
        }
        return total;
    }

    /// The frame the drain sends from the callback of its frame of length
    /// `first_len`, if every check of that send passes whatever the kernel
    /// does with the cork: the drain still runs, the per-socket check holds
    /// against everything corked counted whole, the aggregate check against
    /// the current charges minus the first frame (released by its callback).
    fn lookaheadFrame(self: *Server, peer: *Peer, first_len: usize) ?*SharedFrame {
        if (peer.terminated or !self.queueOf(peer).clients.contains(peer) or peer.out.length() == 0) return null;
        const frame = peer.out.queue.items[peer.out.queue_head];
        const len = frame.bytes.len;
        if (peer.bufferedAmount() + peer.cork.framed + len > self.limits.max_buffered_bytes) return null;
        if (self.pending_bytes.load(.monotonic) - self.lookahead_unconsumed - first_len + len > self.limits.max_total_buffered_bytes) return null;
        if (self.routeCharged(peer.route) - first_len + len > self.outboundQuota(peer.route)) return null;
        return frame;
    }

    fn failSocket(self: *Server, peer: *Peer, reason: []const u8) void {
        if (peer.terminated) return;
        if (peer.validator.pending and peer.in_clients) return self.rejectNegotiationAs(peer, reason, "setup_error", 1013);
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
        // TS #10089: every route queue drops the socket first, then its
        // in-flight reservation.
        self.removeQueued(peer);
        self.releasePending(peer);
        self.clearBlocks(peer);
        self.stopEvents(peer);
        self.clearSubscriptions(peer);
        if (peer.in_clients) {
            peer.in_clients = false;
            _ = self.clients.orderedRemove(peer);
        }
        self.releaseValidator(peer);
        if (peer.in_explorer) {
            peer.in_explorer = false;
            self.resumeDeferredHeads(peer);
            if (peer.explorer.subscription) |sub| {
                peer.explorer.subscription = null;
                msrc.MessageSource.unsubscribe(sub);
                sub.release();
            }
            self.releaseExplorerClient(peer.explorer.ip);
            _ = self.explorer_clients.orderedRemove(peer);
        }
        if (self.clients.count() == 0 and self.explorer_clients.count() == 0) self.pending_heads.clearRetainingCapacity();
    }

    /// The client leaves `clients`; its subscriptions are unreachable (freed).
    fn clearSubscriptions(self: *Server, peer: *Peer) void {
        for (&peer.agent.subscriptions.values) |*entry| {
            if (entry.*) |subscription| if (subscription.domains) |domains| self.allocator.free(domains);
            entry.* = null;
        }
    }

    /// `releaseExplorerSetup`: drops the peer's setup reservation (once).
    fn releaseExplorerSetup(self: *Server, peer: *Peer) void {
        if (!peer.explorer_setup) return;
        peer.explorer_setup = false;
        self.explorer_pending_setups -= 1;
        const index = self.explorer_pending_setups_by_ip.getIndex(peer.explorer.ip) orelse return;
        const count = &self.explorer_pending_setups_by_ip.values()[index];
        if (count.* == 1) {
            const key = self.explorer_pending_setups_by_ip.keys()[index];
            self.explorer_pending_setups_by_ip.orderedRemoveAt(index);
            self.allocator.free(key);
        } else count.* -= 1;
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
        self.rejectNegotiationAs(peer, message, "invalid_subscription", 1008);
    }

    /// `rejectNegotiation(socket, error, reason, code)`: disconnect first
    /// (a failing error frame then terminates instead of re-entering), the
    /// error frame unless 1013, then close.
    fn rejectNegotiationAs(self: *Server, peer: *Peer, message: []const u8, reason: []const u8, code: u16) void {
        if (peer.validator.reserved) incValidatorRejection(reason);
        self.disconnect(peer);
        if (code == 1013) self.logger.warn("stream setup failed: {s}", .{message}) else self.sendError(peer, message);
        peer.wsClose(code, if (code == 1013) "Stream unavailable" else "Invalid subscription");
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
