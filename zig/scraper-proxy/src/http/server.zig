//! HTTP/1.1 server reproducing Node `http` + Fastify 5 + @fastify/cors
//! behaviour for this app (see `types.zig` for the request lifecycle).
//!
//! Evented (`loop.zig`): sockets are non-blocking and registered
//! edge-triggered on one epoll/kqueue set; whichever poller thread receives
//! an event drives that connection (read, parse, hooks, write) until it would
//! block, then parks it. Deadlines live on the slot and a one-shot timer
//! fires at the earliest one (`Loop.setDeadline`):
//! requestTimeout (10 s from the start of a request head, or from accept for
//! a fresh socket -> 408), keepAliveTimeout (72 s idle -> silent close).
const std = @import("std");
const builtin = @import("builtin");
const core = @import("core");
const types = @import("types.zig");
const parse = @import("parse.zig");
const loop_mod = @import("loop.zig");
const ws = @import("ws.zig");

const posix = std.posix;
const Request = types.Request;
const Reply = types.Reply;
const Route = types.Route;
const Header = types.Header;
const FastifyError = types.FastifyError;
const Group = loop_mod.Group;
const monoMs = loop_mod.monoMs;

const log = core.log.child("Http");

pub const UpgradeHandler = struct {
    ctx: *anyopaque,
    /// Node `server.on('upgrade', (req, socket, head))`: called on a poller
    /// thread for requests carrying `Upgrade` + `Connection: upgrade`. The
    /// callee owns `socket` from here on: hand it to `ws.Server.handleUpgrade`
    /// or call `socket.destroy()`.
    on_upgrade: *const fn (ctx: *anyopaque, req: *Request, socket: *UpgradeSocket) void,
    /// Set by the owner when it removes its 'upgrade' listener (TS: at the
    /// end of stop()'s awaits, `httpServer.off('upgrade')`): from then Node
    /// routes upgrade requests like any other. Null: never removed.
    removed: ?*const std.atomic.Value(bool) = null,

    fn listening(self: UpgradeHandler) bool {
        const flag = self.removed orelse return true;
        return !flag.load(.acquire);
    }
};

/// A socket detached from HTTP processing (Node `Duplex` in 'upgrade').
pub const UpgradeSocket = struct {
    fd: posix.socket_t,
    /// Bytes received after the request head (Node `head`).
    head: []const u8,
    remote_address: std.net.Address,
    /// The request's arena (`endWith` copies into it).
    arena: std.mem.Allocator,
    /// Set by `ws` when it takes over the socket: the server attaches it to
    /// the poller set after `on_upgrade` returns.
    takeover: ?*ws.Conn = null,
    /// The request's body still to come (Node 26 parses it and hides the
    /// upgrade stream's data until it completes): `ws` discards it before
    /// any frame. Null: no body, or none left.
    body: ?BodyReader = null,
    destroyed: bool = false,
    /// `endWith`'s bytes, written by the connection after `on_upgrade`.
    end_bytes: ?[]const u8 = null,

    /// `socket.destroy()`.
    pub fn destroy(self: *UpgradeSocket) void {
        if (self.destroyed or self.takeover != null) return;
        self.destroyed = true;
    }

    /// `socket.end(bytes, () => socket.destroy())`: once `on_upgrade`
    /// returns, the connection writes `bytes` on its normal write path
    /// (never blocking: a client that stops reading parks it like any
    /// response), sends FIN, then destroys the socket.
    pub fn endWith(self: *UpgradeSocket, bytes: []const u8) void {
        if (self.destroyed or self.takeover != null) return;
        self.destroyed = true;
        self.end_bytes = self.arena.dupe(u8, bytes) catch {
            // Destroyed without the response (as when the write fails).
            log.warn("upgrade rejection dropped: out of memory copying {d} bytes", .{bytes.len});
            return;
        };
    }
};

pub const Options = struct {
    host: []const u8 = "0.0.0.0",
    port: u16 = 8383,
    routes: []const Route = &.{},
    upgrade: ?UpgradeHandler = null,
    /// Fastify `requestTimeout` (Node enforces it on a 30s check interval;
    /// here at the deadline).
    request_timeout_ms: u32 = 10_000,
    /// Fastify default `keepAliveTimeout`.
    keep_alive_timeout_ms: u32 = 72_000,
    /// Pollers running at once. One about to block in the database (or any
    /// `core.blocking` section) hands its place to another.
    pollers: u32 = 1,
    /// Poller threads cap: running + blocked + parked.
    max_threads: u32 = 256,
    /// Events per `epoll_wait`.
    event_batch: u32 = 64,
    /// How long a poller waits for a short DB reply before handing off
    /// (`core.blocking.grace_ns`; 0: hand off at once). Tuned by sweeping
    /// patched builds; not configurable at runtime (TS env surface).
    handoff_grace_us: u32 = 0,
    /// Poller thread stack (virtual; touched pages only). Debug 20 MiB,
    /// release 8 MiB: see `loop.poller_stack_bytes`.
    thread_stack_bytes: usize = loop_mod.poller_stack_bytes,
    /// listen() backlog; the kernel clamps it to net.core.somaxconn. Above
    /// Node's 511 (DEVIATIONS.md): one loop accepts 60-80k connections/s,
    /// so 511 slots overflow on a brief lag and clients wait out the 1 s
    /// SYN retransmit instead of queueing.
    kernel_backlog: u31 = 4096,
    /// Fiber mode: event loops, one pinned thread each, sharing the listen
    /// socket (one registration per loop; on Linux EPOLLEXCLUSIVE wakes one
    /// loop per connection burst). Thread mode always runs one.
    /// 0 ("auto"): the CPUs this process may use, i.e. its affinity mask
    /// capped by its cgroup CPU quota, clamped to 1..4 (`cpus.autoLoops`).
    /// Default: `-Dhttp-loops` (1: production pods run without a CPU limit,
    /// so auto would see the node's CPUs).
    loops: u32 = @import("http_options").loops,
};

/// Most loops a server runs (`Options.loops`).
pub const max_loops = 64;

const buf_len = 64 * 1024;
/// Most body bytes `endAndClose` reads (and discards) before closing.
const dump_budget = 16 * buf_len;
/// Tests only: widens the `.closing` turn (normally the next loop pass) to time
/// input into or after it. Other builds never read it (`closeTurnMs` is 0).
/// Test-only: head bytes the scanner stepped, over all connections.
pub var test_head_stepped: std.atomic.Value(usize) = .init(0);
pub var test_close_turn_ms: std.atomic.Value(i64) = .init(0);

/// Tests only: keep-alive parks waiting for the next request (not a fresh
/// socket's first wait), parks with a partial request head buffered, and
/// parks with output waiting for the socket (never touched in other builds).
pub var test_idle_parks: std.atomic.Value(u32) = .init(0);
pub var test_head_parks: std.atomic.Value(u32) = .init(0);
pub var test_write_parks: std.atomic.Value(u32) = .init(0);

/// Tests only: hangups `hangupAborts` classified as reset/error and
/// as a bare FIN (never touched in other builds).
pub var test_reset_hangups: std.atomic.Value(u32) = .init(0);
pub var test_fin_hangups: std.atomic.Value(u32) = .init(0);
/// Tests only: hangups decided right after the handler parked (read with the
/// request), and the `reset_only` policy in place of `hangup_policy`.
pub var test_merged_hangups: std.atomic.Value(u32) = .init(0);
pub var test_reset_only: std.atomic.Value(bool) = .init(false);

fn closeTurnMs() i64 {
    return if (builtin.is_test) test_close_turn_ms.load(.monotonic) else 0;
}

/// Prototype: run route handlers on fibers (`core.fiber`), so a handler that
/// waits on the database parks instead of blocking a poller thread.
pub const fibers = true;

/// The loops that own fiber fd registrations (`core.fiber.forgetFd`).
var fiber_group: ?*Group = null;

fn fiberFdClosing(fd: posix.fd_t) void {
    if (fiber_group) |g| g.forgetFd(fd, false);
}

fn fiberFdClosed(fd: posix.fd_t) void {
    if (fiber_group) |g| g.forgetFd(fd, true);
}

fn fiberFdReadiness(fd: posix.fd_t) ?*const std.atomic.Value(u32) {
    const g = fiber_group orelse return null;
    return g.readiness(fd);
}

/// A request arena with a stable address (requests keep `*ArenaBox` across
/// parks; idle sockets own none).
const ArenaBox = struct {
    arena: std.heap.ArenaAllocator,
    next: ?*ArenaBox = null,

    fn reset(self: *ArenaBox) void {
        _ = self.arena.reset(.{ .retain_with_limit = 256 * 1024 });
    }
};

/// Per poller thread: the read buffer every driven socket uses and the arena
/// for requests that complete without parking.
const Scratch = struct {
    buf: [buf_len]u8 = undefined,
    arena: ?*ArenaBox = null,
};

threadlocal var tls_scratch: ?*Scratch = null;

fn scratch() !*Scratch {
    if (tls_scratch) |s| return s;
    const s = try std.heap.c_allocator.create(Scratch);
    s.* = .{};
    tls_scratch = s;
    return s;
}

/// The calling poller thread's read buffer.
pub fn readBuffer() ![]u8 {
    return &(try scratch()).buf;
}

fn freeScratch() void {
    const s = tls_scratch orelse return;
    tls_scratch = null;
    if (s.arena) |box| {
        box.arena.deinit();
        std.heap.c_allocator.destroy(box);
    }
    std.heap.c_allocator.destroy(s);
}

pub const Server = struct {
    gpa: std.mem.Allocator,
    options: Options,
    listen_fd: posix.socket_t,
    address: std.net.Address,
    loop: Group = undefined,
    /// The listen socket's slot on each loop.
    listeners: [max_loops]Listener = undefined,
    listener_count: u32 = 0,
    /// Listener slots not yet freed by `close`.
    listeners_open: u32 = 0,
    started: bool = false,
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    /// HTTP connections (not upgraded).
    connections: u32 = 0,
    /// Upgraded sockets whose reader still runs.
    upgraded: u32 = 0,
    closing: std.atomic.Value(bool) = .init(false),
    /// `beginClose`: new requests get the closing 503; the listener stays.
    refusing: std.atomic.Value(bool) = .init(false),
    listener_closed: bool = false,
    /// Free request arenas (bounded).
    arenas: ?*ArenaBox = null,
    arena_count: u32 = 0,
    last_accept_log: std.atomic.Value(i64) = .init(0),

    const Listener = struct {
        index: u32,
        gen: u32,
        /// EMFILE/ENFILE retry backoff (only this listener's R holder uses it).
        backoff_ms: i64 = 10,
    };

    /// Binds and listens (like `app.listen`); errors surface immediately.
    pub fn init(gpa: std.mem.Allocator, options: Options) !*Server {
        const address = try std.net.Address.parseIp(options.host, options.port);
        const fd = try posix.socket(address.any.family, posix.SOCK.STREAM | posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK, posix.IPPROTO.TCP);
        errdefer posix.close(fd);
        try posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEADDR, &std.mem.toBytes(@as(c_int, 1)));
        var len = address.getOsSockLen();
        try posix.bind(fd, &address.any, len);
        // Linux accepted sockets inherit TCP_NODELAY from the listener (one
        // setsockopt instead of one per connection); kqueue systems get it
        // per accept.
        if (builtin.os.tag == .linux) setNoDelay(fd);
        try posix.listen(fd, options.kernel_backlog);
        var bound: std.net.Address = undefined;
        try posix.getsockname(fd, &bound.any, &len);
        const self = try gpa.create(Server);
        errdefer gpa.destroy(self);
        self.* = .{ .gpa = gpa, .options = options, .listen_fd = fd, .address = bound };
        const n_loops: u32 = if (!fibers) 1 else if (options.loops == 0)
            @import("cpus.zig").autoLoops()
        else
            @min(options.loops, max_loops);
        try self.loop.init(gpa, n_loops, .{
            // Without `core.blocking` the database cannot hand off: stay elastic.
            .active = if (fibers) 1 else if (@hasDecl(core, "blocking")) options.pollers else options.max_threads,
            // Fiber mode: one pinned thread per loop; waits park fibers, so
            // nothing hands off to another thread (fibers never migrate).
            .max_threads = if (fibers) 1 else options.max_threads,
            .monitor = !fibers,
            .event_batch = options.event_batch,
            .stack_size = options.thread_stack_bytes,
        }, .{
            .ctx = self,
            .on_event = onEvent,
            .on_posted = onPosted,
            .on_expired = onExpired,
            .on_thread_exit = onThreadExit,
        });
        errdefer self.loop.deinit();
        if (fibers) {
            fiber_group = &self.loop;
            core.fiber.fd_closing = fiberFdClosing;
            core.fiber.fd_closed = fiberFdClosed;
            core.fiber.fd_readiness = fiberFdReadiness;
        }
        // Process-wide: pollers wait this long for a short DB reply before
        // handing off (the database calls `core.blocking.graceWait`).
        if (@hasDecl(core, "blocking") and @hasDecl(core.blocking, "grace_ns"))
            core.blocking.grace_ns = @as(u64, options.handoff_grace_us) * std.time.ns_per_us;
        // One registration per loop. Several: exclusive wake-ups (Linux), so
        // a connection burst wakes one loop, which accepts at most a small
        // batch per wake-up before the others get theirs.
        for (0..n_loops) |i| {
            const slot = try self.loop.allocSlotOn(i, .listener, self);
            self.listeners[i] = .{ .index = slot.index, .gen = slot.gen };
            self.listener_count += 1;
            try self.loop.loops[i].registerListener(fd, slot.index, slot.gen, n_loops > 1);
            // No poller runs yet: nothing can have set a pending bit.
            _ = loop_mod.release(self.loop.slot(slot.index), loop_mod.R, 0);
        }
        self.listeners_open = self.listener_count;
        return self;
    }

    pub fn port(self: *const Server) u16 {
        return self.address.getPort();
    }

    /// Starts accepting connections.
    pub fn start(self: *Server) !void {
        try self.loop.start();
        self.started = true;
    }

    pub fn isClosing(self: *const Server) bool {
        return self.closing.load(.acquire);
    }

    /// Fastify sets `closing` before its preClose hooks: from here every new
    /// routed request gets the closing 503 while the listener still accepts,
    /// until `close()` stops it. Upgrades still reach the owner until it
    /// removes its listener (`UpgradeHandler.removed`), as in TS.
    pub fn beginClose(self: *Server) void {
        self.refusing.store(true, .release);
    }

    /// New requests get the closing 503 (`beginClose` or `close`).
    fn refusesRequests(self: *const Server) bool {
        return self.refusing.load(.acquire) or self.isClosing();
    }

    /// Waits (bounded) until every upgraded socket has finished, as TS's
    /// preClose awaits each `ws` server's `close()` (all clients closed: the
    /// close handshake done or `ws`'s close timeout). Returns how many are
    /// still open (0: all finished).
    pub fn waitUpgraded(self: *Server, timeout_ms: u64) u32 {
        const deadline = monoMs() + @as(i64, @intCast(timeout_ms));
        self.mutex.lock();
        defer self.mutex.unlock();
        while (self.upgraded > 0) {
            const remaining = deadline - monoMs();
            if (remaining <= 0) break;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
        return self.upgraded;
    }

    /// Fastify `close()` server part: stop accepting, close idle keep-alive
    /// connections, answer requests that arrive meanwhile with 503 and wait
    /// for in-flight HTTP requests (bounded by `timeout_ms`). Upgraded
    /// sockets are not touched (their owner closes them).
    pub fn close(self: *Server, timeout_ms: u64) void {
        if (self.closing.swap(true, .acq_rel)) return;
        const deadline = monoMs() + @as(i64, @intCast(timeout_ms));
        if (!self.started) {
            for (self.listeners[0..self.listener_count]) |l| self.closeListener(l.index);
        } else {
            for (self.listeners[0..self.listener_count]) |l| self.kick(l.index, l.gen);
            self.mutex.lock();
            while (!self.listener_closed) self.cond.timedWait(&self.mutex, 10 * std.time.ns_per_ms) catch {};
            self.mutex.unlock();
        }
        // Idle keep-alive connections close on the kick (pairs with the
        // closing check when a connection goes idle).
        const count = self.loop.slotCount();
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            const slot = self.loop.slot(i);
            const g = slot.gen();
            if (slot.kind != .http) continue;
            switch (loop_mod.claim(slot, g, loop_mod.R, loop_mod.KICK)) {
                .busy, .stale => {},
                // Parked: an idle keep-alive socket ends right here (no
                // hand-off per socket); anything else goes to a poller.
                .claimed => {
                    // Re-read under R: an upgrade may have turned the slot into
                    // a WebSocket (same generation) since the check above.
                    if (slot.kind != .http) {
                        self.loop.post(i, g, loop_mod.R | loop_mod.KICK);
                        continue;
                    }
                    const conn: *Connection = @ptrCast(@alignCast(slot.ptr.?));
                    if (conn.phase == .idle and !conn.first and conn.pending.len == 0) {
                        _ = conn.destroy();
                    } else self.loop.post(i, g, loop_mod.R | loop_mod.KICK);
                },
            }
        }
        self.mutex.lock();
        while (self.connections > 0) {
            const remaining = deadline - monoMs();
            if (remaining <= 0) break;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
        self.mutex.unlock();
        self.loop.logStats();
    }

    /// Waits for upgraded sockets to finish (after their owner closed them),
    /// stops the pollers, then frees the server.
    pub fn deinit(self: *Server) void {
        self.close(10_000);
        self.mutex.lock();
        const deadline = monoMs() + 35_000;
        while (self.upgraded > 0 or self.connections > 0) {
            const remaining = deadline - monoMs();
            if (remaining <= 0) break;
            self.cond.timedWait(&self.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
        const leaked = self.upgraded > 0 or self.connections > 0;
        self.mutex.unlock();
        // Sockets still alive reference the server and the loop: leak them.
        if (leaked) return;
        if (fibers and fiber_group == &self.loop) {
            // Later fd users (e.g. another test's database connection) must
            // not reach the freed loop.
            core.fiber.fd_closing = null;
            core.fiber.fd_closed = null;
            core.fiber.fd_readiness = null;
            fiber_group = null;
        }
        self.loop.deinit();
        while (self.arenas) |box| {
            self.arenas = box.next;
            box.arena.deinit();
            std.heap.c_allocator.destroy(box);
        }
        self.gpa.destroy(self);
    }

    /// Claims R (then hands the connection to a poller) or flags KICK for its holder.
    fn kick(self: *Server, index: u32, gen: u32) void {
        if (loop_mod.claim(self.loop.slot(index), gen, loop_mod.R, loop_mod.KICK) == .claimed)
            self.loop.post(index, gen, loop_mod.R | loop_mod.KICK);
    }

    /// Frees one loop's listener slot; the last one closes the socket.
    fn closeListener(self: *Server, index: u32) void {
        self.loop.freeSlot(index);
        self.mutex.lock();
        defer self.mutex.unlock();
        self.listeners_open -= 1;
        if (self.listeners_open > 0) return;
        posix.close(self.listen_fd);
        self.listener_closed = true;
        self.cond.broadcast();
    }

    // -- loop callbacks ---------------------------------------------------------------

    fn onEvent(ctx: *anyopaque, index: u32, gen: u32, ev: loop_mod.Event) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        const slot = self.loop.slot(index);
        const word = slot.state.load(.acquire);
        if (loop_mod.Slot.genOf(word) != gen) return;
        if (slot.kind == .ws) {
            // WebSocket reads and writes are driven independently (R / W).
            if (ev.writable and loop_mod.Slot.bitsOf(word) & loop_mod.WANT_W != 0) {
                if (loop_mod.claim(slot, gen, loop_mod.W, loop_mod.W_AGAIN) == .claimed) wsConn(slot).runWriter();
            }
            if (!ev.readable and !ev.hup) return;
        }
        // A hangup merged into this edge must survive a short read (sticky).
        const again = loop_mod.R_AGAIN | (if (ev.hup) loop_mod.R_HUP else 0) | (if (ev.reset) loop_mod.R_RESET else 0);
        if (loop_mod.claim(slot, gen, loop_mod.R, again) != .claimed) {
            // R is held: by a waiting handler, a hangup aborts its exchange.
            // Data in the same edge goes first (Node's 'data', the parser
            // error and its 400, come before 'end').
            if (slot.kind == .http) {
                const junk = (ev.readable or ev.hup) and Connection.dataWhileDetached(slot, gen);
                if (!junk and ev.hup and hangupAborts(ev.reset)) Connection.peerClosedWhileDetached(slot, gen);
            }
            return;
        }
        if (ev.reset and slot.kind == .http) @as(*Connection, @ptrCast(@alignCast(slot.ptr.?))).reset = true;
        self.runSlot(index, if (ev.hup) .hup else .io, false);
    }

    /// Which peer hangups abort a response still being prepared (the
    /// handler's fiber waits; `on_peer_closed`, no response).
    pub const HangupPolicy = enum {
        /// Node, `httpAllowHalfOpen = false`: the client's FIN alone ends the
        /// socket (`socketOnEnd` -> `socket.end()`), so every in-flight and
        /// pipelined response is dropped, as on RST.
        eof_drop,
        /// Only a reset or socket error aborts; a client that half-closed
        /// still gets its response (Node with `httpAllowHalfOpen = true`).
        reset_only,
    };
    pub const hangup_policy: HangupPolicy = .eof_drop;

    pub fn abortsOn(policy: HangupPolicy, reset: bool) bool {
        return reset or policy == .eof_drop;
    }

    /// `hangup_policy` (tests: `test_reset_only` overrides it).
    pub fn hangupPolicyNow() HangupPolicy {
        if (builtin.is_test and test_reset_only.load(.monotonic)) return .reset_only;
        return hangup_policy;
    }

    /// `hangup_policy` applied to a hangup (`reset`: RST/error, else a FIN).
    fn hangupAborts(reset: bool) bool {
        if (builtin.is_test) _ = (if (reset) &test_reset_hangups else &test_fin_hangups).fetchAdd(1, .monotonic);
        return abortsOn(hangupPolicyNow(), reset);
    }

    fn onPosted(ctx: *anyopaque, index: u32, gen: u32, token: u32) void {
        _ = gen;
        const self: *Server = @ptrCast(@alignCast(ctx));
        if (token & loop_mod.W != 0) return wsConn(self.loop.slot(index)).runWriter();
        self.runSlot(index, .none, token & loop_mod.KICK != 0);
    }

    fn wsConn(slot: *loop_mod.Slot) *ws.Conn {
        return @ptrCast(@alignCast(slot.ptr.?));
    }

    /// R is held.
    fn runSlot(self: *Server, index: u32, io: loop_mod.Io, kicked: bool) void {
        const slot = self.loop.slot(index);
        switch (slot.kind) {
            .listener => self.runListener(index),
            .http => {
                const conn: *Connection = @ptrCast(@alignCast(slot.ptr.?));
                conn.run(io, kicked);
            },
            .ws => wsConn(slot).runReader(io, kicked),
            // The loop routes fiber kinds itself.
            .free, .fiber_fd, .fiber_timer => unreachable,
        }
    }

    /// A deadline passed: the R holder (or a poller we hand R to) re-evaluates.
    fn onExpired(ctx: *anyopaque, index: u32, gen: u32) void {
        const self: *Server = @ptrCast(@alignCast(ctx));
        // Expiry runs on another poller: a re-run may reach a hook.
        if (loop_mod.claim(self.loop.slot(index), gen, loop_mod.R, loop_mod.KICK) == .claimed)
            self.loop.post(index, gen, loop_mod.R | loop_mod.KICK);
    }

    fn onThreadExit(_: *anyopaque) void {
        if (fibers) core.fiber.releaseThreadCache();
        freeScratch();
    }

    // -- accept -----------------------------------------------------------------------

    fn listenerOf(self: *Server, index: u32) *Listener {
        return &self.listeners[self.listenerPos(index)];
    }

    fn listenerPos(self: *Server, index: u32) usize {
        for (self.listeners[0..self.listener_count], 0..) |l, i| if (l.index == index) return i;
        unreachable;
    }

    /// R on this loop's listener slot is held.
    fn runListener(self: *Server, index: u32) void {
        const slot = self.loop.slot(index);
        const l = self.listenerOf(index);
        while (true) {
            if (self.isClosing()) return self.closeListener(index);
            self.loop.setDeadline(index, loop_mod.no_deadline);
            var accepted: [16]*Connection = undefined;
            var n: usize = 0;
            var more = false;
            while (n < accepted.len) {
                var addr: std.net.Address = undefined;
                var addr_len: posix.socklen_t = @sizeOf(std.net.Address);
                const fd = posix.accept(self.listen_fd, &addr.any, &addr_len, posix.SOCK.CLOEXEC | posix.SOCK.NONBLOCK) catch |e| switch (e) {
                    error.WouldBlock => break,
                    error.ConnectionAborted => continue,
                    else => {
                        // Persistent failures (EMFILE/ENFILE): retry from a
                        // deadline after a backoff up to 1 s; log at most once per second.
                        const now = std.time.milliTimestamp();
                        const last = self.last_accept_log.load(.monotonic);
                        if (now - last >= 1000 and self.last_accept_log.cmpxchgStrong(last, now, .monotonic, .monotonic) == null)
                            log.err("accept failed: {s}", .{@errorName(e)});
                        self.loop.setDeadline(index, monoMs() + l.backoff_ms);
                        l.backoff_ms = @min(l.backoff_ms * 2, 1000);
                        break;
                    },
                };
                l.backoff_ms = 10;
                if (self.newConnection(fd, addr)) |conn| {
                    accepted[n] = conn;
                    n += 1;
                }
            } else more = true;
            // Let other pollers pick up the rest before serving one here.
            if (n > 1) for (accepted[1..n]) |conn| conn.handOff();
            if (more and self.listener_count > 1) {
                // A full batch: the next loop accepts the rest (it re-runs
                // if it is accepting already), so one loop never drains a
                // burst alone while the others idle.
                const next = &self.listeners[(self.listenerPos(index) + 1) % self.listener_count];
                if (loop_mod.claim(self.loop.slot(next.index), next.gen, loop_mod.R, loop_mod.R_AGAIN) == .claimed)
                    self.loop.post(next.index, next.gen, loop_mod.R);
            }
            const pending = if (more and self.listener_count == 1) loop_mod.R_AGAIN else loop_mod.release(slot, loop_mod.R, loop_mod.R_AGAIN | loop_mod.KICK);
            if (pending != 0) {
                // Still held: another poller continues accepting.
                self.loop.post(index, l.gen, loop_mod.R);
            }
            if (n > 0) {
                // Its request is likely here already: serve it now, unless
                // another loop owns it (that loop's set reports it).
                if (self.loop.owner(accepted[0].index) == self.loop.current()) accepted[0].run(.io, false) else accepted[0].handOff();
            }
            return;
        }
    }

    fn newConnection(self: *Server, fd: posix.socket_t, addr: std.net.Address) ?*Connection {
        if (builtin.os.tag != .linux) setNoDelay(fd);
        if (builtin.os.tag == .macos) {
            posix.setsockopt(fd, posix.SOL.SOCKET, std.c.SO.NOSIGPIPE, &std.mem.toBytes(@as(c_int, 1))) catch {};
        }
        const conn = self.gpa.create(Connection) catch {
            posix.close(fd);
            return null;
        };
        const slot = self.loop.allocSlotOn(self.loop.pickLoop(), .http, conn) catch {
            self.gpa.destroy(conn);
            posix.close(fd);
            return null;
        };
        const now = monoMs();
        conn.* = .{ .server = self, .fd = fd, .remote = addr, .index = slot.index, .gen = slot.gen, .idle_since = now };
        self.mutex.lock();
        self.connections += 1;
        self.mutex.unlock();
        return conn;
    }

    fn connectionEnded(self: *Server) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.connections -= 1;
        self.cond.broadcast();
    }

    pub fn upgradedEnded(self: *Server) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.upgraded -= 1;
        self.cond.broadcast();
    }

    // -- arenas -----------------------------------------------------------------------

    fn acquireArena(self: *Server) !*ArenaBox {
        self.mutex.lock();
        if (self.arenas) |box| {
            self.arenas = box.next;
            self.arena_count -= 1;
            self.mutex.unlock();
            return box;
        }
        self.mutex.unlock();
        const box = try std.heap.c_allocator.create(ArenaBox);
        box.* = .{ .arena = .init(std.heap.c_allocator) };
        return box;
    }

    fn releaseArena(self: *Server, box: *ArenaBox) void {
        box.reset();
        self.mutex.lock();
        if (self.arena_count < 64) {
            box.next = self.arenas;
            self.arenas = box;
            self.arena_count += 1;
            self.mutex.unlock();
            return;
        }
        self.mutex.unlock();
        box.arena.deinit();
        std.heap.c_allocator.destroy(box);
    }
};

fn setNoDelay(fd: posix.socket_t) void {
    posix.setsockopt(fd, posix.IPPROTO.TCP, posix.TCP.NODELAY, &std.mem.toBytes(@as(c_int, 1))) catch {};
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/// Node `clientError` handled by Fastify's `defaultClientErrorHandler`.
const ClientError = enum {
    bad_request,
    header_overflow,
    timeout,

    fn bytes(self: ClientError) []const u8 {
        return switch (self) {
            .bad_request => "HTTP/1.1 400 Bad Request\r\nContent-Length: 65\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Bad Request\",\"message\":\"Client Error\",\"statusCode\":400}",
            .header_overflow => "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 114\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Request Header Fields Too Large\",\"message\":\"Exceeded maximum allowed HTTP header size\",\"statusCode\":431}",
            .timeout => "HTTP/1.1 408 Request Timeout\r\nContent-Length: 71\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Request Timeout\",\"message\":\"Client Timeout\",\"statusCode\":408}",
        };
    }
};

/// Where a connection waits when it parks.
const Phase = enum {
    /// The handler's fiber finished after waiting: send the response.
    respond,
    /// No request bytes buffered (fresh socket or keep-alive idle).
    idle,
    /// A request head is arriving.
    head,
    /// The handler waits for the request body.
    body,
    /// Output is pending (`after` runs once it is written or failed).
    write,
    /// Node `req._dump()`: discarding the rest of a body after the response.
    drain,
    /// A final response is written while body bytes were still in flight:
    /// one loop turn to discard what arrives, then FIN and close (Node's
    /// `destroySoon` shuts down a turn after the response, its dump reading
    /// meanwhile).
    closing,
};

/// What follows a write.
const After = enum {
    /// Fastify reply: `on_done`, then keep-alive/end/close.
    response,
    /// A response that bypasses Fastify (417, bad URL), then like `response`.
    complete,
    /// `100 Continue`, then the exchange goes on.
    continue_100,
    /// A `Connection: close` response Node writes itself (`res.end()`:
    /// missing Host 400, closing 503): body dump, FIN, close (`endAndClose`).
    final_close,
    /// FIN, then destroy (Node `socket.end(bytes, () => socket.destroy())`).
    end_destroy,
    /// Destroy the socket.
    close,
};

/// `null` from a step: keep driving.
/// `detached`: a handler fiber waits; the connection keeps R and continues
/// when the fiber finishes (`handlerDone`).
const Step = enum { park, gone, detached };

/// One request in flight; lives in the request arena.
const Exchange = struct {
    req: Request,
    reply: Reply,
    route: ?*const Route = null,
    /// A parser read the body (Fastify `contentTypeParser.run`, async in TS).
    parsed_body: bool = false,
    /// Data after a non-keep-alive request (`closedConnAction`), once decided.
    closed_conn: ?ClosedConnAction = null,
    /// The message is complete and nothing but CR/LF followed it
    /// yet, so later input reaches Node's closed state (`dataWhileDetached`).
    probe_late: bool = false,
    keep_alive: bool,
    /// Keep-alive decision of the written response.
    keep_after: bool = false,
    /// `on_write_blocked` already ran.
    write_blocked: bool = false,
    kind: enum { json, text } = .text,
    limit: usize = default_body_limit,
    raw: std.ArrayList(u8) = .empty,
};

const Connection = struct {
    server: *Server,
    fd: posix.socket_t,
    remote: std.net.Address,
    index: u32,
    gen: u32,
    /// The thread scratch buffer while driven; leftovers move to `pending`.
    buf: *[buf_len]u8 = undefined,
    start: usize = 0,
    end: usize = 0,
    pending: []u8 = &.{},
    /// A read may return data: set by every event, cleared by a short read.
    readable: bool = true,
    /// The peer hung up (or the socket failed): read until EOF/error.
    hup: bool = false,
    registered: bool = false,
    /// A handler fiber was detached with `DETACHED` set (`finish` clears it).
    detached: bool = false,
    /// The hangup in `hup` was a reset or socket error (not just a FIN).
    reset: bool = false,
    write_armed: bool = false,
    first: bool = true,
    phase: Phase = .idle,
    idle_since: i64,
    head_deadline: i64 = loop_mod.no_deadline,
    /// The head being received: scanning resumes where the last read ended.
    head_scan: parse.HeadScanner = .{},
    /// `.closing`: when the socket closes, and the body bytes it may still discard.
    close_at: i64 = loop_mod.no_deadline,
    dump_left: usize = 0,
    /// Request arena owned across parks (null: the thread's).
    arena_box: ?*ArenaBox = null,
    /// Continuation of a handler fiber that finished after waiting.
    fiber_done: loop_mod.FiberDone = undefined,
    ex: ?*Exchange = null,
    body: BodyReader = .{ .framing = .none },
    out: [2][]const u8 = .{ "", "" },
    after: After = .close,

    fn slot(self: *Connection) *loop_mod.Slot {
        return self.server.loop.slot(self.index);
    }

    /// Drives the connection; R is held. Returns once it parked and released
    /// R, or the connection is gone.
    fn run(self: *Connection, io: loop_mod.Io, kick: bool) void {
        var kicked = kick;
        self.noteIo(io);
        while (true) {
            const s = scratch() catch {
                _ = self.destroy();
                return;
            };
            self.bind(s);
            // Gone, or detached while a handler fiber waits (R stays held).
            if (self.drive(kicked) != .park) return;
            const pending = loop_mod.release(self.slot(), loop_mod.R, loop_mod.r_pending);
            if (pending == 0) return;
            self.notePending(pending);
            kicked = pending & loop_mod.KICK != 0;
        }
    }

    fn noteIo(self: *Connection, io: loop_mod.Io) void {
        switch (io) {
            .none => {},
            .io => self.readable = true,
            .hup => {
                self.readable = true;
                self.hup = true;
            },
        }
    }

    fn notePending(self: *Connection, pending: u32) void {
        self.noteIo(loop_mod.Io.fromPending(pending));
        if (pending & loop_mod.R_RESET != 0) self.reset = true;
    }

    /// A new socket another poller should serve: register it and let go.
    fn handOff(self: *Connection) void {
        if (self.park() == .gone) return;
        const pending = loop_mod.release(self.slot(), loop_mod.R, loop_mod.r_pending);
        if (pending == 0) return;
        // Input arrived meanwhile: another poller serves it. Running it here
        // could block in a handler while this thread still holds the listener.
        self.notePending(pending);
        self.server.loop.post(self.index, self.gen, loop_mod.R | (pending & loop_mod.KICK));
    }

    fn bind(self: *Connection, s: *Scratch) void {
        self.buf = &s.buf;
        self.start = 0;
        self.end = self.pending.len;
        if (self.pending.len > 0) {
            @memcpy(self.buf[0..self.pending.len], self.pending);
            self.server.gpa.free(self.pending);
            self.pending = &.{};
        }
    }

    fn arena(self: *Connection) !std.mem.Allocator {
        if (self.arena_box) |box| return box.arena.allocator();
        const s = try scratch();
        if (s.arena == null) s.arena = try self.server.acquireArena();
        return s.arena.?.arena.allocator();
    }

    /// The request is over: its arena is reset for the next one.
    fn endRequest(self: *Connection) void {
        if (self.ex == null) return;
        self.ex = null;
        if (self.arena_box) |box| {
            self.arena_box = null;
            self.server.releaseArena(box);
        } else if (tls_scratch) |s| if (s.arena) |box| box.reset();
    }

    fn deadline(self: *const Connection) i64 {
        const o = self.server.options;
        return switch (self.phase) {
            .idle => self.idle_since + @as(i64, if (self.first) o.request_timeout_ms else o.keep_alive_timeout_ms),
            .head => self.head_deadline,
            .closing => self.close_at,
            .body, .write, .drain, .respond => loop_mod.no_deadline,
        };
    }

    /// Saves state and registers interest; the caller then releases R.
    fn park(self: *Connection) Step {
        if (self.start < self.end) {
            self.pending = self.server.gpa.dupe(u8, self.buf[self.start..self.end]) catch return self.destroy();
        }
        self.start = 0;
        self.end = 0;
        if (self.ex != null and self.arena_box == null) {
            // The request outlives this thread's turn: hand its arena over.
            const s = tls_scratch.?;
            self.arena_box = s.arena;
            s.arena = null;
        }
        if (builtin.is_test) switch (self.phase) {
            .idle => if (!self.first) {
                _ = test_idle_parks.fetchAdd(1, .release);
            },
            .head => _ = test_head_parks.fetchAdd(1, .release),
            .write => _ = test_write_parks.fetchAdd(1, .release),
            else => {},
        };
        const want_write = self.phase == .write;
        if (!self.registered) {
            self.server.loop.register(self.fd, self.index, self.gen) catch return self.destroy();
            self.registered = true;
        }
        if (want_write and !self.write_armed) {
            self.server.loop.enableWrite(self.fd, self.index, self.gen) catch return self.destroy();
            self.write_armed = true;
        }
        self.server.loop.setDeadline(self.index, self.deadline());
        return .park;
    }

    fn destroy(self: *Connection) Step {
        const server = self.server;
        if (self.ex != null) self.endRequest();
        posix.close(self.fd);
        if (self.pending.len > 0) server.gpa.free(self.pending);
        server.loop.freeSlot(self.index);
        server.gpa.destroy(self);
        server.connectionEnded();
        return .gone;
    }

    /// Reads more bytes into `buf` (compacting first).
    fn fill(self: *Connection) error{ WouldBlock, Closed }!usize {
        if (self.start == self.end) {
            self.start = 0;
            self.end = 0;
        } else if (self.end == self.buf.len) {
            std.mem.copyForwards(u8, self.buf[0 .. self.end - self.start], self.buf[self.start..self.end]);
            self.end -= self.start;
            self.start = 0;
        }
        if (!self.readable) return error.WouldBlock;
        const space = self.buf.len - self.end;
        const n = posix.read(self.fd, self.buf[self.end..]) catch |e| switch (e) {
            error.WouldBlock => {
                self.readable = false;
                return error.WouldBlock;
            },
            else => return error.Closed,
        };
        if (n == 0) return error.Closed;
        // Edge-triggered: a short read drained the socket; later bytes bring a
        // new event. A hangup in the same edge brings none: keep reading.
        if (n < space and !self.hup) self.readable = false;
        self.end += n;
        return n;
    }

    /// Timer expiry or server close.
    fn onKick(self: *Connection) ?Step {
        const now = monoMs();
        const server = self.server;
        switch (self.phase) {
            .idle => {
                // Node: close() ends idle keep-alive sockets.
                if (!self.first and server.isClosing()) return self.destroy();
                // A fresh socket gets requestTimeout (-> 408); an idle
                // keep-alive socket is closed silently after keepAliveTimeout.
                if (now >= self.deadline()) {
                    if (self.first) return self.clientError(.timeout);
                    return self.destroy();
                }
            },
            .head => if (now >= self.head_deadline) return self.clientError(.timeout),
            .closing => return self.closeNow(),
            .body, .write, .drain, .respond => {},
        }
        return null;
    }

    fn drive(self: *Connection, kicked: bool) Step {
        if (kicked) if (self.onKick()) |step| return step;
        while (true) {
            const step: ?Step = switch (self.phase) {
                .respond => self.stepRespond(),
                .idle => self.stepIdle(),
                .head => self.stepHead(),
                .body => self.stepBody(),
                .write => self.stepWrite(),
                .drain => self.stepDrain(),
                .closing => self.closeNow(),
            };
            if (step) |s| return s;
        }
    }

    fn stepIdle(self: *Connection) ?Step {
        if (self.start == self.end) {
            _ = self.fill() catch |e| return switch (e) {
                error.WouldBlock => self.park(),
                error.Closed => self.destroy(),
            };
        }
        self.first = false;
        self.head_deadline = monoMs() + @as(i64, self.server.options.request_timeout_ms);
        self.head_scan = .{};
        self.phase = .head;
        return null;
    }

    fn stepHead(self: *Connection) ?Step {
        // llhttp skips CRLFs between requests (only before the head's first
        // byte; after it, `start` stays put while the scan resumes).
        if (self.head_scan.scanned == 0) {
            while (self.start < self.end and (self.buf[self.start] == '\r' or self.buf[self.start] == '\n')) self.start += 1;
        }
        const before = self.head_scan.scanned;
        defer if (builtin.is_test) {
            _ = test_head_stepped.fetchAdd(self.head_scan.scanned - before, .monotonic);
        };
        const scan = self.head_scan.scan(self.buf[self.start..self.end]) catch |e| return self.headError(e);
        switch (scan) {
            .complete => |len| {
                const a = self.arena() catch return self.destroy();
                const head = parse.parseHead(a, self.buf[self.start .. self.start + len]) catch |e| return self.headError(e);
                self.start += head.len;
                return self.startExchange(a, head) catch self.destroy();
            },
            .incomplete => if (self.start == 0 and self.end == self.buf.len) return self.clientError(.header_overflow),
        }
        _ = self.fill() catch |e| return switch (e) {
            error.WouldBlock => self.park(),
            error.Closed => self.destroy(),
        };
        return null;
    }

    fn headError(self: *Connection, e: parse.HeadError) ?Step {
        return switch (e) {
            error.HeaderOverflow => self.clientError(.header_overflow),
            error.BadRequest => self.clientError(.bad_request),
            error.OutOfMemory => self.destroy(),
        };
    }

    /// Fastify's client error bytes, then destroy.
    fn clientError(self: *Connection, kind: ClientError) ?Step {
        return self.write(kind.bytes(), "", .close);
    }

    fn write(self: *Connection, head: []const u8, body: []const u8, after: After) ?Step {
        self.out = .{ head, body };
        self.after = after;
        self.phase = .write;
        return null;
    }

    fn stepWrite(self: *Connection) ?Step {
        var parts = [2][]const u8{ self.out[0], self.out[1] };
        const ok = switch (writeSome(self.fd, &parts)) {
            .done => true,
            .would_block => {
                self.out = parts;
                if (self.after == .response) self.notifyWriteBlocked();
                return self.park();
            },
            .failed => false,
        };
        self.out = .{ "", "" };
        return switch (self.after) {
            .response => self.afterReply(ok),
            .complete => if (ok) self.afterResponse(self.ex.?.keep_alive and !self.server.isClosing()) else self.destroy(),
            .continue_100 => if (ok) self.routeExchange() catch self.destroy() else self.destroy(),
            .final_close => if (ok) self.endAndClose() else self.destroy(),
            .end_destroy => {
                if (ok) posix.shutdown(self.fd, .send) catch {};
                return self.destroy();
            },
            .close => self.destroy(),
        };
    }

    fn notifyWriteBlocked(self: *Connection) void {
        const ex = self.ex.?;
        if (ex.write_blocked) return;
        ex.write_blocked = true;
        if (ex.route) |r| if (r.hooks.on_write_blocked) |hook| hook(r.ctx, &ex.req, &ex.reply);
    }

    // -- exchange ---------------------------------------------------------------------

    fn startExchange(self: *Connection, a: std.mem.Allocator, head: parse.Head) !?Step {
        const server = self.server;
        const q = std.mem.indexOfScalar(u8, head.url, '?');
        const ex = try a.create(Exchange);
        ex.* = .{
            .req = .{
                .arena = a,
                .method = head.method,
                .url = head.url,
                .path = head.url[0 .. q orelse head.url.len],
                .query = if (q) |i| head.url[i + 1 ..] else "",
                .headers = head.headers,
                .remote_address = self.remote,
            },
            .reply = .{ .arena = a },
            .keep_alive = false,
        };
        ex.keep_alive = keepAliveRequested(&ex.req, head);
        self.ex = ex;
        // Measured: Node applies requestTimeout to the head only; a stalled
        // body (read by a parser or dumped after the response) never times out.
        self.body = .{ .framing = head.framing };
        const req = &ex.req;

        // Node: CONNECT and upgrade requests go to their events, unprocessed.
        // Once the owner removed its 'upgrade' listener (TS: late in stop(),
        // after its awaits), or the server closed, Node routes an upgrade
        // request like any other (during shutdown: the closing 503).
        if (std.mem.eql(u8, req.method, "CONNECT")) return self.destroy();
        if (server.options.upgrade) |handler| if (isUpgrade(req) and handler.listening() and !server.isClosing()) return self.upgrade(handler);

        // Node `requireHostHeader`.
        if (head.major == 1 and head.minor == 1 and req.header("host") == null) {
            var out: std.Io.Writer.Allocating = .init(a);
            try out.writer.print("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nDate: {s}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", .{httpDate()});
            return self.write(out.written(), "", .final_close);
        }

        // Node `Expect` handling (HTTP/1.1 only, no checkContinue listener).
        if (head.major == 1 and head.minor == 1) if (req.header("expect")) |expect| {
            if (expectsContinue(expect)) return self.write("HTTP/1.1 100 Continue\r\n\r\n", "", .continue_100);
            var out: std.Io.Writer.Allocating = .init(a);
            try out.writer.print("HTTP/1.1 417 Expectation Failed\r\nDate: {s}\r\n", .{httpDate()});
            try self.connectionHeaders(&out.writer, ex.keep_alive);
            try out.writer.writeAll("Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
            return self.write(out.written(), "", .complete);
        };
        return self.routeExchange();
    }

    fn routeExchange(self: *Connection) !?Step {
        const server = self.server;
        const ex = self.ex.?;
        const req = &ex.req;
        const reply = &ex.reply;
        const a = req.arena;

        // Fastify `return503OnClosing`.
        if (server.refusesRequests()) {
            var out: std.Io.Writer.Allocating = .init(a);
            try out.writer.print("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 80\r\nDate: {s}\r\n\r\n{{\"error\":\"Service Unavailable\",\"message\":\"Service Unavailable\",\"statusCode\":503}}", .{httpDate()});
            return self.write(out.written(), "", .final_close);
        }

        // find-my-way lookup (bad URLs answer before any Fastify hook).
        ex.route = switch (try parse.routerPath(a, req.url)) {
            .bad_url => |path| {
                const message = try std.fmt.allocPrint(a, "'{s}' is not a valid url component", .{path});
                const payload = try std.fmt.allocPrint(a, "{{\"error\":\"Bad Request\",\"code\":\"FST_ERR_BAD_URL\",\"message\":{f},\"statusCode\":400}}", .{core.json.Value{ .string = message }});
                var out: std.Io.Writer.Allocating = .init(a);
                try out.writer.print("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nDate: {s}\r\n", .{ payload.len, httpDate() });
                try self.connectionHeaders(&out.writer, ex.keep_alive);
                try out.writer.print("\r\n{s}", .{payload});
                return self.write(out.written(), "", .complete);
            },
            .path => |path| matchRoute(server.options.routes, req.method, path),
        };
        const route = ex.route;

        // @fastify/cors onRequest (root scope: every route incl. 404).
        const origin = req.header("origin");
        reply.header("vary", "Origin");
        if (origin) |o| if (o.len > 0) reply.header("access-control-allow-origin", o);
        if (std.mem.eql(u8, req.method, "OPTIONS")) {
            const acrm = req.header("access-control-request-method");
            if (origin == null or origin.?.len == 0 or acrm == null or acrm.?.len == 0) {
                reply.code(400);
                reply.type("text/plain");
                reply.sendText("Invalid Preflight Request");
            } else {
                reply.header("access-control-allow-methods", "GET,HEAD,POST");
                if (req.header("access-control-request-headers")) |h| reply.header("access-control-allow-headers", h);
                reply.header("vary", "Origin, Access-Control-Request-Headers");
                reply.code(204);
                reply.header("content-length", "0");
                reply.sendEmpty();
            }
            return self.finish(null);
        }

        req.body_pending = self.bodyPending();
        if (route) |r| if (r.hooks.on_request) |hook| {
            hook(r.ctx, req, reply);
            if (reply.sent) return self.finish(route);
        };
        return self.prepareBody();
    }

    /// Fastify `handleRequest` + content-type parsing up to the body read.
    /// Sends framework errors on `reply`; otherwise leaves it unsent.
    fn prepareBody(self: *Connection) !?Step {
        const ex = self.ex.?;
        const req = &ex.req;
        const reply = &ex.reply;
        const route = ex.route;
        const method = req.method;
        if (isBodyless(method) or !isBodyWith(method)) return self.handle();
        const ct_header = req.header("content-type");
        const empty = req.header("transfer-encoding") == null and
            (req.header("content-length") == null or std.mem.eql(u8, req.header("content-length").?, "0"));
        if (ct_header == null and std.mem.eql(u8, method, "QUERY")) {
            reply.sendError(.{ .status = 400, .code = "FST_ERR_ROUTE_MISSING_CONTENT_TYPE", .message = "Method 'QUERY' must provide a 'Content-Type' header." });
            return self.handle();
        }
        if (ct_header) |ct| {
            const media = parse.mediaType(req.arena, ct) orelse {
                reply.sendError(FastifyError.invalid_media_type);
                return self.handle();
            };
            if (std.mem.eql(u8, media, "application/json")) {
                ex.kind = .json;
            } else if (std.mem.eql(u8, media, "text/plain")) {
                ex.kind = .text;
            } else {
                const extra = if (route) |r| r.text_content_types else &.{};
                for (extra) |t| {
                    if (std.mem.eql(u8, media, t)) break;
                } else {
                    // No parser: the 404 handler ignores the body; routes 415.
                    if (route != null) reply.sendError(FastifyError.invalid_media_type);
                    return self.handle();
                }
                ex.kind = .text;
            }
        } else {
            if (!empty and route != null) reply.sendError(FastifyError.invalid_media_type);
            return self.handle();
        }

        ex.limit = if (route) |r| r.body_limit else default_body_limit;
        // Parser failures close the connection: the client may still be sending.
        switch (self.body.framing) {
            .length => |n| if (n > ex.limit) {
                parserError(reply, FastifyError.body_too_large);
                return self.handle();
            },
            else => {},
        }
        ex.parsed_body = true;
        self.phase = .body;
        return null;
    }

    /// True when the body's framing is not complete in the buffer yet.
    fn bodyPending(self: *Connection) bool {
        switch (self.body.framing) {
            .none, .invalid_te => return false,
            .length => |n| return self.end - self.start < n,
            .chunked => {
                var probe = self.body;
                const start = self.start;
                defer self.start = start;
                const progress = probe.consume(self, null, null, std.math.maxInt(usize)) catch return false;
                return progress == .need_more;
            },
        }
    }

    fn stepBody(self: *Connection) ?Step {
        const ex = self.ex.?;
        const progress = self.body.consume(self, ex.req.arena, &ex.raw, ex.limit) catch |e| switch (e) {
            error.TooLarge => {
                parserError(&ex.reply, FastifyError.body_too_large);
                return self.handle() catch self.destroy();
            },
            error.BadRequest => {
                self.doneClosed();
                return self.clientError(.bad_request);
            },
            error.OutOfMemory => {
                self.doneClosed();
                return self.destroy();
            },
        };
        switch (progress) {
            .done => return self.bodyRead() catch self.destroy(),
            .need_more => {},
        }
        _ = self.fill() catch |e| return switch (e) {
            error.WouldBlock => self.park(),
            error.Closed => {
                self.doneClosed();
                return self.destroy();
            },
        };
        return null;
    }

    /// `on_done(.closed)` for a request that failed before its response.
    /// The peer hung up while the handler waited and `on_peer_closed` ran:
    /// drop the response, report `on_done(.closed)` once, close.
    fn aborted(self: *Connection) Step {
        const sl = self.slot();
        while (loop_mod.Slot.bitsOf(sl.state.load(.acquire)) & loop_mod.ABORT_RUNNING != 0) std.atomic.spinLoopHint();
        loop_mod.clearBits(sl, loop_mod.ABORTED);
        self.doneClosed();
        return self.destroy();
    }

    /// A hangup event while a handler fiber holds R (`DETACHED`): claim the
    /// abort (once, unless `finish` already cleared `DETACHED`) and run the
    /// route's `on_peer_closed`. `finish` waits for it before freeing anything.
    fn peerClosedWhileDetached(sl: *loop_mod.Slot, gen: u32) void {
        var s = sl.state.load(.acquire);
        while (true) {
            if (loop_mod.Slot.genOf(s) != gen) return;
            const b = loop_mod.Slot.bitsOf(s);
            if (b & loop_mod.DETACHED == 0 or b & loop_mod.ABORTED != 0) return;
            if (b & loop_mod.ABORT_RUNNING != 0) {
                // A data probe is deciding: once it is done, look again.
                std.atomic.spinLoopHint();
                s = sl.state.load(.acquire);
                continue;
            }
            const next = s | loop_mod.ABORTED | loop_mod.ABORT_RUNNING;
            if (sl.state.cmpxchgWeak(s, next, .acq_rel, .acquire)) |actual| {
                s = actual;
                continue;
            }
            break;
        }
        const self: *Connection = @ptrCast(@alignCast(sl.ptr.?));
        const ex = self.ex.?;
        if (ex.route) |r| if (r.hooks.on_peer_closed) |hook| hook(r.ctx, &ex.req, &ex.reply);
        loop_mod.clearBits(sl, loop_mod.ABORT_RUNNING);
    }

    /// What Node does with bytes after a non-keep-alive request (llhttp's
    /// closed state skips CR/LF; anything else is HPE_CLOSED_CONNECTION ->
    /// Fastify's clientError 400 + destroy): `.after_response` when TS's route
    /// answers synchronously inside the parse (response, then 400),
    /// `.instead` when it answers after an await or parses a body (400 only).
    /// A body no parser reads keeps Node's parser in the body: no 400.
    fn closedConnAction(self: *Connection, route_async: bool) ClosedConnAction {
        const ex = self.ex.?;
        if (ex.keep_alive) return .none;
        const start = self.start;
        defer self.start = start;
        if (!self.body.done()) {
            switch (self.body.framing) {
                .length => |n| if (n > 0) return .none,
                else => {},
            }
            var probe = self.body;
            const progress = probe.consume(self, null, null, std.math.maxInt(usize)) catch return .none;
            if (progress != .done or probe.total > 0) return .none;
        }
        for (self.buf[self.start..self.end]) |b| {
            if (b != '\r' and b != '\n') return if (ex.parsed_body or route_async) .instead else .after_response;
        }
        // Complete, nothing after it yet: input that arrives while a handler
        // waits is checked then (a body still unread is Node's body, not this).
        ex.probe_late = true;
        return .none;
    }

    /// `.instead` decided while the handler waits: claim the abort like a
    /// hangup, run `on_peer_closed`, and write clientError's 400 now (the
    /// response is dropped; `finish` sees `ABORTED` and destroys).
    fn closedConnAbort(sl: *loop_mod.Slot, gen: u32) void {
        var s = sl.state.load(.acquire);
        while (true) {
            if (loop_mod.Slot.genOf(s) != gen) return;
            const b = loop_mod.Slot.bitsOf(s);
            if (b & (loop_mod.DETACHED | loop_mod.ABORTED | loop_mod.ABORT_RUNNING) != loop_mod.DETACHED) return;
            if (sl.state.cmpxchgWeak(s, s | loop_mod.ABORTED | loop_mod.ABORT_RUNNING, .acq_rel, .acquire)) |actual| {
                s = actual;
                continue;
            }
            break;
        }
        const self: *Connection = @ptrCast(@alignCast(sl.ptr.?));
        self.abortWith400();
        loop_mod.clearBits(sl, loop_mod.ABORT_RUNNING);
    }

    /// Under `ABORTED|ABORT_RUNNING`: the hook, then the 400 (best effort: a
    /// fresh socket takes 145 bytes at once). Then, as Node's destroy right
    /// after clientError's write: the input Node's read took is discarded and
    /// the socket shut down both ways, so the client sees the FIN now (no RST
    /// for unread junk), not when the waiting handler ends and frees `self`.
    fn abortWith400(self: *Connection) void {
        const ex = self.ex.?;
        if (ex.route) |r| if (r.hooks.on_peer_closed) |hook| hook(r.ctx, &ex.req, &ex.reply);
        var parts = [2][]const u8{ ClientError.bad_request.bytes(), "" };
        _ = writeSome(self.fd, &parts);
        var buf: [4096]u8 = undefined;
        var left: usize = 64 * 1024; // one Node read
        while (left > 0) {
            const n = posix.recv(self.fd, buf[0..@min(buf.len, left)], dontwait) catch break;
            if (n == 0) break;
            left -= n;
        }
        posix.shutdown(self.fd, .both) catch {};
    }

    /// Input while a complete non-keep-alive request's handler waits (Node
    /// reads it at once): any non-CR/LF byte aborts with the
    /// 400 (true). Holds `ABORT_RUNNING` while deciding, so `finish` and a
    /// hangup wait; nothing else reads the socket while `DETACHED`.
    fn dataWhileDetached(sl: *loop_mod.Slot, gen: u32) bool {
        var s = sl.state.load(.acquire);
        while (true) {
            if (loop_mod.Slot.genOf(s) != gen) return false;
            const b = loop_mod.Slot.bitsOf(s);
            if (b & (loop_mod.DETACHED | loop_mod.ABORTED | loop_mod.ABORT_RUNNING) != loop_mod.DETACHED) return false;
            if (sl.state.cmpxchgWeak(s, s | loop_mod.ABORT_RUNNING, .acq_rel, .acquire)) |actual| {
                s = actual;
                continue;
            }
            break;
        }
        const self: *Connection = @ptrCast(@alignCast(sl.ptr.?));
        const junk = self.ex.?.probe_late and lateJunk(self.fd);
        if (junk) {
            loop_mod.setBits(sl, loop_mod.ABORTED);
            self.abortWith400();
        }
        loop_mod.clearBits(sl, loop_mod.ABORT_RUNNING);
        return junk;
    }

    fn doneClosed(self: *Connection) void {
        const ex = self.ex.?;
        if (ex.route) |r| if (r.hooks.on_done) |hook| hook(r.ctx, &ex.req, &ex.reply, .closed);
    }

    fn bodyRead(self: *Connection) !?Step {
        const ex = self.ex.?;
        const req = &ex.req;
        const reply = &ex.reply;
        const raw = ex.raw.items;
        req.raw_body = raw;
        req.complete = true;
        // Fastify counts the raw bytes against Content-Length (which the
        // framing already read exactly), then decodes once: invalid
        // sequences become U+FFFD.
        const text = try core.json.toWellFormedUtf8(req.arena, raw);
        switch (ex.kind) {
            .text => req.body = .{ .text = text },
            .json => {
                if (text.len == 0) {
                    parserError(reply, FastifyError.empty_json_body);
                    return self.handle();
                }
                const value = core.json.parse(req.arena, text, .{ .secure = true, .strip_bom = true }) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                    error.SyntaxError => {
                        parserError(reply, FastifyError.invalid_json_body);
                        return self.handle();
                    },
                };
                req.body = .{ .json = value };
            },
        }
        return self.handle();
    }

    /// Route handler (or the 404 handler) unless a reply was already sent.
    fn handle(self: *Connection) !?Step {
        const ex = self.ex.?;
        if (ex.closed_conn == null) ex.closed_conn = self.closedConnAction(if (ex.route) |r| r.ts_async else false);
        if (!ex.reply.sent) {
            if (ex.route) |r| {
                if (fibers) {
                    if (self.handlerOnFiber()) return .detached;
                } else r.hooks.handler(r.ctx, &ex.req, &ex.reply);
                if (!ex.reply.sent) ex.reply.sendEmpty();
            } else notFound(&ex.req, &ex.reply);
        }
        return self.finish(ex.route);
    }

    /// No fiber for this request (stacks or memory exhausted): answer 503
    /// and close. Never run the handler inline on the loop thread: a wait in
    /// it (e.g. a database checkout behind connections held by fibers parked
    /// on this loop) could only end at its timeout. TS has no such path.
    fn noFiber(self: *Connection, e: anyerror) void {
        log.warn("no fiber for a request ({s}): answering 503", .{@errorName(e)});
        const reply = &self.ex.?.reply;
        reply.code(503);
        reply.destroy_after = true;
        reply.sendText("Service Unavailable");
    }

    /// Runs the route handler on a fiber; true when it is waiting (the
    /// connection is detached until `handlerDone`), false when it already
    /// finished (or failed because no fiber was available).
    fn handlerOnFiber(self: *Connection) bool {
        const loop = &self.server.loop;
        const f = core.fiber.create(loop.fiberScheduler(), runHandler, self) catch |e| {
            self.noFiber(e);
            return false;
        };
        self.fiber_done = .{ .ctx = self, .func = handlerDone };
        f.user = &self.fiber_done;
        // Detach first: once the fiber's wait is published, another poller
        // may finish the request, so nothing may still point at this
        // thread's scratch (leftover input, the request arena).
        if (self.start < self.end) {
            self.pending = self.server.gpa.dupe(u8, self.buf[self.start..self.end]) catch |e| {
                core.fiber.destroyUnstarted(f);
                self.noFiber(e);
                return false;
            };
        }
        self.start = 0;
        self.end = 0;
        const s = tls_scratch.?;
        const own_arena = self.arena_box == null;
        if (own_arena) {
            self.arena_box = s.arena;
            s.arena = null;
        }
        self.phase = .respond;
        // A peer hangup while the handler waits aborts the exchange (Node
        // 'close'): the socket must be watched, and the slot marked.
        if (!self.registered) {
            if (loop.register(self.fd, self.index, self.gen)) |_| {
                self.registered = true;
            } else |e| log.warn("cannot watch a waiting request's socket ({s}): no early abort", .{@errorName(e)});
        }
        self.detached = true;
        const sl = self.slot();
        loop_mod.setBits(sl, loop_mod.DETACHED);
        // A hangup read together with the request brings no later event:
        // decide it now, once the handler waits (read before `runFiber`: the
        // exchange may finish and free `self` on another poller after it).
        // A hangup event that came while this thread held R (during the
        // request read) is still pending in the slot word.
        const pend = loop_mod.Slot.bitsOf(sl.state.load(.acquire));
        const hup_seen = self.hup or pend & loop_mod.R_HUP != 0;
        const reset_seen = self.reset or pend & loop_mod.R_RESET != 0;
        // Data read with the request (or still unread in the
        // kernel, no edge to come) goes before a hangup, as Node's 'data'
        // before 'end'.
        const instead = self.ex.?.closed_conn == .instead;
        const probe = self.ex.?.probe_late;
        const gen = self.gen;
        if (loop.runFiber(f) == null) {
            if (instead) {
                Connection.closedConnAbort(sl, gen);
            } else if (!(probe and Connection.dataWhileDetached(sl, gen)) and hup_seen and Server.hangupAborts(reset_seen)) {
                if (builtin.is_test) _ = test_merged_hangups.fetchAdd(1, .monotonic);
                Connection.peerClosedWhileDetached(sl, gen);
            }
            return true;
        }
        // Finished without waiting: re-attach and go on here.
        if (own_arena and s.arena == null) {
            s.arena = self.arena_box;
            self.arena_box = null;
        }
        self.bind(s);
        self.phase = .body; // any non-respond phase; `finish` sets the next
        return false;
    }

    fn runHandler(arg: *anyopaque) void {
        const self: *Connection = @ptrCast(@alignCast(arg));
        const ex = self.ex.?;
        const r = ex.route.?;
        r.hooks.handler(r.ctx, &ex.req, &ex.reply);
    }

    /// The handler fiber finished on a later resume (any poller): finish
    /// the response and go on as usual (R is still held).
    fn handlerDone(ctx: *anyopaque) void {
        const self: *Connection = @ptrCast(@alignCast(ctx));
        self.run(.none, false);
    }

    fn stepRespond(self: *Connection) ?Step {
        const ex = self.ex.?;
        if (!ex.reply.sent) ex.reply.sendEmpty();
        return self.finish(ex.route) catch self.destroy();
    }

    fn finish(self: *Connection, route: ?*const Route) !?Step {
        if (self.detached) {
            self.detached = false;
            const sl = self.slot();
            _ = sl.state.fetchAnd(~@as(u64, loop_mod.DETACHED), .acq_rel);
            // A data probe (`dataWhileDetached`) may be deciding: wait it out.
            while (loop_mod.Slot.bitsOf(sl.state.load(.acquire)) & loop_mod.ABORT_RUNNING != 0) std.atomic.spinLoopHint();
            if (loop_mod.Slot.bitsOf(sl.state.load(.acquire)) & loop_mod.ABORTED != 0) return self.aborted();
        }
        const ex = self.ex.?;
        if (ex.closed_conn == null) ex.closed_conn = self.closedConnAction(if (route) |r| r.ts_async else false);
        if (ex.closed_conn.? == .instead) {
            // Node's parser hit the data before this response: clientError's
            // 400 and destroy; the response is dropped ('close' first).
            if (route) |r| if (r.hooks.on_peer_closed) |hook| hook(r.ctx, &ex.req, &ex.reply);
            self.doneClosed();
            return self.write(ClientError.bad_request.bytes(), "", .close);
        }
        const req = &ex.req;
        const reply = &ex.reply;
        const a = req.arena;
        if (self.body.framing == .none) req.complete = true;
        if (reply.error_value) |err| {
            reply.error_value = null;
            if (reply.status < 400) reply.status = err.status;
            reply.sent = false;
            if (route) |r| if (r.hooks.error_handler) |handler| handler(r.ctx, req, reply, err);
            if (!reply.sent or reply.error_value != null) defaultErrorBody(reply, err);
        }
        if (route) |r| if (r.hooks.on_send) |hook| hook(r.ctx, req, reply);

        const is_head = std.mem.eql(u8, req.method, "HEAD");
        switch (reply.payload) {
            .none => if (reply.status >= 200 and reply.status != 204 and reply.status != 304 and !is_head and reply.getHeader("content-length") == null) reply.header("content-length", "0"),
            .bytes => |b| {
                const existing = reply.getHeader("content-length");
                const len_text = try std.fmt.allocPrint(a, "{d}", .{b.len});
                if (existing == null or (!is_head and !std.mem.eql(u8, existing.?, len_text))) reply.header("content-length", len_text);
            },
        }

        var keep_alive = ex.keep_alive and !self.server.isClosing();
        const user_connection = reply.getHeader("connection");
        if (user_connection) |c| {
            if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, c, " "), "close")) keep_alive = false;
        }
        ex.keep_after = keep_alive;
        ex.route = route;
        const payload = reply.body() orelse "";
        var out: std.Io.Writer.Allocating = try .initCapacity(a, 512);
        const w = &out.writer;
        try w.print("HTTP/1.1 {d} {s}\r\n", .{ reply.status, statusText(reply.status) });
        for (reply.headers.items) |h| try w.print("{s}: {s}\r\n", .{ h.name, h.value });
        try w.print("Date: {s}\r\n", .{httpDate()});
        if (user_connection == null) try self.connectionHeaders(w, keep_alive);
        try w.writeAll("\r\n");
        const send_body = !is_head and reply.status != 204 and reply.status != 304;
        // Head and body go out in one sendmsg; the body is never copied.
        return self.write(out.written(), if (send_body) payload else "", .response);
    }

    fn afterReply(self: *Connection, written: bool) ?Step {
        const ex = self.ex.?;
        if (ex.route) |r| if (r.hooks.on_done) |hook| hook(r.ctx, &ex.req, &ex.reply, if (written) .finished else .closed);
        if (!written or ex.reply.destroy_after) return self.destroy();
        // A sync route answered inside Node's parse; the data after the
        // request then raised clientError: its 400 follows, then destroy.
        if (ex.closed_conn == .after_response) return self.clientError(.bad_request);
        return self.afterResponse(ex.keep_after);
    }

    /// Node dumps an unconsumed request body after the response, keeping the
    /// connection; a malformed or late body becomes a client error.
    fn afterResponse(self: *Connection, keep_alive: bool) ?Step {
        self.endRequest();
        // llhttp reports HPE_INVALID_TRANSFER_ENCODING as soon as the request
        // was dispatched, so the client error follows even `Connection: close`.
        if (self.body.framing == .invalid_te and !self.body.finished) return self.clientError(.bad_request);
        if (!keep_alive) return self.endAndClose();
        self.phase = .drain;
        return null;
    }

    fn stepDrain(self: *Connection) ?Step {
        const progress = self.body.consume(self, null, null, std.math.maxInt(usize)) catch |e| switch (e) {
            error.BadRequest => return self.clientError(.bad_request),
            error.TooLarge, error.OutOfMemory => unreachable,
        };
        switch (progress) {
            .done => {
                // Back to waiting for the next request (Node: close() ends
                // sockets that reach this point while it runs).
                if (self.start == self.end and self.server.isClosing()) return self.destroy();
                self.phase = .idle;
                self.idle_since = monoMs();
                return null;
            },
            .need_more => {},
        }
        _ = self.fill() catch |e| return switch (e) {
            error.WouldBlock => self.park(),
            error.Closed => self.destroy(),
        };
        return null;
    }

    /// Node `socket.destroySoon()` after a final response: FIN, then the
    /// socket closes at once. Input arriving later meets a closed socket (the
    /// kernel answers RST), as with Node; nothing waits for the peer.
    fn endAndClose(self: *Connection) Step {
        // Node's `req._dump()` of an unread body races that close and usually
        // reads what has already arrived: discard the body bytes readable
        // now (bounded, so a client streaming faster than we read cannot hold
        // the loop), and only bytes still in flight meet the closed socket.
        const left = self.dumpReadable(dump_budget);
        if (left == 0 or self.body.done()) {
            posix.shutdown(self.fd, .send) catch {};
            return self.destroy();
        }
        // Body bytes may still be in flight: Node shuts down a loop turn
        // after the response, and its dump reads what arrives meanwhile.
        // The FIN waits too, so no input can be a reaction to it.
        self.dump_left = left;
        self.phase = .closing;
        self.close_at = monoMs() + closeTurnMs();
        return self.park();
    }

    /// The `.closing` turn is over (input or the deadline): discard what is
    /// readable now, then FIN and close.
    fn closeNow(self: *Connection) Step {
        _ = self.dumpReadable(self.dump_left);
        posix.shutdown(self.fd, .send) catch {};
        return self.destroy();
    }

    /// Discards readable body bytes until the body ends, a read would block,
    /// or `budget` bytes were read. Returns the budget left; 0 when nothing
    /// more is worth waiting for (budget spent, peer gone, malformed body).
    fn dumpReadable(self: *Connection, budget_in: usize) usize {
        var budget = budget_in;
        while (!self.body.done()) {
            const progress = self.body.consume(self, null, null, std.math.maxInt(usize)) catch return 0;
            if (progress == .done) break;
            // Read until EAGAIN, even after a short read cleared `readable`.
            self.readable = true;
            const n = self.fill() catch |e| return switch (e) {
                error.WouldBlock => budget,
                error.Closed => 0,
            };
            if (n >= budget) return 0;
            budget -= n;
        }
        return budget;
    }

    fn upgrade(self: *Connection, handler: UpgradeHandler) ?Step {
        const ex = self.ex.?;
        const body: BodyReader = .{ .framing = requestFraming(self.body.framing, false, true) };
        var socket: UpgradeSocket = .{ .fd = self.fd, .head = self.buf[self.start..self.end], .remote_address = self.remote, .arena = ex.req.arena, .body = if (body.done()) null else body };
        handler.on_upgrade(handler.ctx, &ex.req, &socket);
        const conn = socket.takeover orelse {
            if (socket.end_bytes) |bytes| return self.write(bytes, "", .end_destroy);
            return self.destroy();
        };
        // The slot (and fd) now belong to the WebSocket, which closes it.
        const server = self.server;
        const index = self.index;
        const gen = self.gen;
        const write_armed = self.write_armed;
        const io: loop_mod.Io = if (self.hup) .hup else if (self.readable) .io else .none;
        var register_failed = false;
        if (!self.registered) {
            server.loop.register(self.fd, index, gen) catch {
                register_failed = true;
            };
        }
        self.endRequest();
        server.gpa.destroy(self);
        server.loop.setKind(index, .ws, conn);
        server.mutex.lock();
        server.connections -= 1;
        server.upgraded += 1;
        server.cond.broadcast();
        server.mutex.unlock();
        if (register_failed) conn.terminate();
        conn.attach(server, index, gen, write_armed, io);
        return .gone;
    }

    fn connectionHeaders(self: *Connection, w: *std.Io.Writer, keep_alive: bool) !void {
        if (keep_alive) {
            try w.print("Connection: keep-alive\r\nKeep-Alive: timeout={d}\r\n", .{self.server.options.keep_alive_timeout_ms / 1000});
        } else try w.writeAll("Connection: close\r\n");
    }
};

const WriteResult = enum { done, would_block, failed };

/// One non-blocking `sendmsg` pass over `parts` (consumed in place).
const ClosedConnAction = enum { none, after_response, instead };

const dontwait: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.DONTWAIT else std.c.MSG.DONTWAIT;

/// True when the socket's unread input has a byte other than CR/LF (left
/// unread). Leading CR/LF is consumed, as llhttp's closed state skips it, up
/// to 1 MiB per call (more waits for the next input edge).
fn lateJunk(fd: posix.socket_t) bool {
    var buf: [512]u8 = undefined;
    var skipped: usize = 0;
    while (skipped < 1024 * 1024) {
        const n = posix.recv(fd, &buf, std.posix.MSG.PEEK | dontwait) catch return false;
        if (n == 0) return false;
        for (buf[0..n]) |b| if (b != '\r' and b != '\n') return true;
        _ = posix.recv(fd, buf[0..n], dontwait) catch return false;
        skipped += n;
    }
    return false;
}

fn writeSome(fd: posix.socket_t, parts: *[2][]const u8) WriteResult {
    const flags: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
    while (parts[0].len + parts[1].len > 0) {
        var iov: [2]posix.iovec_const = undefined;
        var count: usize = 0;
        for (parts) |p| if (p.len > 0) {
            iov[count] = .{ .base = p.ptr, .len = p.len };
            count += 1;
        };
        const msg: posix.msghdr_const = .{ .name = null, .namelen = 0, .iov = &iov, .iovlen = @intCast(count), .control = null, .controllen = 0, .flags = 0 };
        var n = posix.sendmsg(fd, &msg, flags) catch |e| return if (e == error.WouldBlock) .would_block else .failed;
        for (parts) |*p| {
            const take = @min(n, p.len);
            p.* = p.*[take..];
            n -= take;
        }
    }
    return .done;
}

const default_body_limit = 100 * 1024;

fn parserError(reply: *Reply, err: FastifyError) void {
    reply.header("connection", "close");
    reply.sendError(err);
}

/// Fastify's default 404 handler.
fn notFound(req: *Request, reply: *Reply) void {
    reply.code(404);
    const message = std.fmt.allocPrint(req.arena, "Route {s}:{s} not found", .{ req.method, req.url }) catch "";
    var members = [_]core.json.Member{
        .{ .key = "message", .value = .{ .string = message } },
        .{ .key = "error", .value = .{ .string = "Not Found" } },
        .{ .key = "statusCode", .value = .{ .number = 404 } },
    };
    reply.sendJson(.{ .object = &members });
}

/// Tests only (client side): writes all `bytes`, blocking in poll() until
/// the socket takes them. Never call it on an event-loop thread (a peer that
/// stops reading would stall the loop): servers write through a
/// connection's write path (`Connection.write`, `UpgradeSocket.endWith`).
pub fn blockingWriteForTests(fd: posix.socket_t, bytes: []const u8) bool {
    if (!builtin.is_test) @compileError("blockingWriteForTests is test-only");
    return blockingWriteVec(fd, &.{bytes});
}

/// `blockingWriteForTests` with up to 4 parts.
fn blockingWriteVec(fd: posix.socket_t, parts: []const []const u8) bool {
    var iov_buf: [4]posix.iovec_const = undefined;
    std.debug.assert(parts.len <= iov_buf.len);
    var count: usize = 0;
    for (parts) |part| if (part.len > 0) {
        iov_buf[count] = .{ .base = part.ptr, .len = part.len };
        count += 1;
    };
    var iov: []posix.iovec_const = iov_buf[0..count];
    const flags: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
    while (iov.len > 0) {
        const msg: posix.msghdr_const = .{
            .name = null,
            .namelen = 0,
            .iov = iov.ptr,
            .iovlen = @intCast(iov.len),
            .control = null,
            .controllen = 0,
            .flags = 0,
        };
        var n = posix.sendmsg(fd, &msg, flags) catch |e| switch (e) {
            error.WouldBlock => {
                var fds = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.OUT, .revents = 0 }};
                _ = posix.poll(&fds, -1) catch return false;
                if (fds[0].revents & posix.POLL.OUT == 0) return false;
                continue;
            },
            else => return false,
        };
        while (iov.len > 0 and n >= iov[0].len) {
            n -= iov[0].len;
            iov = iov[1..];
        }
        if (n > 0) {
            iov[0].base += n;
            iov[0].len -= n;
        }
    }
    return true;
}

fn defaultErrorBody(reply: *Reply, err: FastifyError) void {
    if (reply.getHeader("content-type") == null) reply.header("content-type", "application/json; charset=utf-8");
    const payload = std.fmt.allocPrint(reply.arena, "{{\"statusCode\":{d},\"code\":{f},\"error\":{f},\"message\":{f}}}", .{
        reply.status,
        core.json.Value{ .string = err.code },
        core.json.Value{ .string = statusText(reply.status) },
        core.json.Value{ .string = err.message },
    }) catch "";
    reply.payload = .{ .bytes = payload };
    reply.sent = true;
}

/// Resumable request body framing: consumes whatever the connection has
/// buffered and reports `need_more` when it runs dry.
/// A request body's framing walked over buffered bytes. `c` is any cursor
/// with `buf`, `start` and `end` (the connection, or `ws`'s input).
pub const BodyReader = struct {
    framing: parse.Framing,
    finished: bool = false,
    started: bool = false,
    remaining: u64 = 0,
    chunk: enum { size_line, data, data_end, trailer } = .size_line,
    total: usize = 0,

    pub const Error = error{ BadRequest, TooLarge, OutOfMemory };
    pub const Progress = enum { done, need_more };

    pub fn done(self: *const BodyReader) bool {
        return self.finished or self.framing == .none;
    }

    /// Walks the body framing over `c`'s buffered bytes, appending to `out`
    /// when given (TooLarge once more than `limit` chunked bytes arrived).
    pub fn consume(self: *BodyReader, c: anytype, a: ?std.mem.Allocator, out: ?*std.ArrayList(u8), limit: usize) Error!Progress {
        if (self.done()) return .done;
        switch (self.framing) {
            .none => {},
            // HPE_INVALID_TRANSFER_ENCODING right after dispatch.
            .invalid_te => return error.BadRequest,
            .length => |n| {
                if (!self.started) {
                    self.started = true;
                    self.remaining = n;
                    if (out) |o| try o.ensureTotalCapacity(a.?, @intCast(n));
                }
                while (self.remaining > 0) {
                    if (c.end == c.start) return .need_more;
                    const take: usize = @intCast(@min(self.remaining, c.end - c.start));
                    if (out) |o| o.appendSliceAssumeCapacity(c.buf[c.start .. c.start + take]);
                    c.start += take;
                    self.remaining -= take;
                }
            },
            .chunked => chunks: while (true) switch (self.chunk) {
                .size_line => {
                    const line = (try takeLine(c)) orelse return needMore(c, parse.chunkSizePrefixValid);
                    const size64 = parse.parseChunkSize(line) orelse return error.BadRequest;
                    const size = std.math.cast(usize, size64) orelse return error.BadRequest;
                    if (size == 0) {
                        self.chunk = .trailer;
                        continue;
                    }
                    self.remaining = size;
                    self.chunk = .data;
                },
                .data => {
                    while (self.remaining > 0) {
                        if (c.end == c.start) return .need_more;
                        const take: usize = @intCast(@min(self.remaining, c.end - c.start));
                        if (out) |o| try o.appendSlice(a.?, c.buf[c.start .. c.start + take]);
                        c.start += take;
                        self.remaining -= take;
                        // Fastify counts received bytes (not declared chunk sizes).
                        self.total +|= take;
                        if (self.total > limit) return error.TooLarge;
                    }
                    self.chunk = .data_end;
                },
                .data_end => {
                    const line = (try takeLine(c)) orelse return needMore(c, dataEndPrefixValid);
                    if (line.len != 0) return error.BadRequest;
                    self.chunk = .size_line;
                },
                .trailer => {
                    const line = (try takeLine(c)) orelse return needMore(c, parse.trailerPrefixValid);
                    if (line.len == 0) break :chunks;
                    if (!parse.validTrailer(line)) return error.BadRequest;
                },
            },
        }
        self.finished = true;
        return .done;
    }

    /// No complete framing line yet: wait, unless its bytes so far already
    /// fail (llhttp rejects the first byte no line could accept).
    fn needMore(c: anytype, comptime prefixValid: fn ([]const u8) bool) Error!Progress {
        if (!prefixValid(c.buf[c.start..c.end])) return error.BadRequest;
        return .need_more;
    }

    /// After a chunk's data only CRLF may follow.
    fn dataEndPrefixValid(p: []const u8) bool {
        return p.len == 0 or (p.len == 1 and p[0] == '\r');
    }

    /// A CRLF-terminated line from the buffer, or null until one arrives.
    fn takeLine(c: anytype) error{BadRequest}!?[]const u8 {
        if (std.mem.indexOfScalar(u8, c.buf[c.start..c.end], '\n')) |pos| {
            if (pos == 0 or c.buf[c.start + pos - 1] != '\r') return error.BadRequest;
            const line = c.buf[c.start .. c.start + pos - 1];
            c.start += pos + 1;
            return line;
        }
        if (c.end - c.start > 4096) return error.BadRequest;
        return null;
    }
};

/// The body framing the server reads for a request with the head's
/// `framing` (shared with parse_diff_test.zig, so the differential runs this
/// rule): CONNECT has none (the server destroys it); llhttp gives an upgrade a
/// body only when chunked or with a Content-Length above 0, its upgrade exit
/// coming before the invalid Transfer-Encoding check, so any other
/// Transfer-Encoding means no body.
pub fn requestFraming(framing: parse.Framing, connect: bool, upgrade: bool) parse.Framing {
    if (connect) return .none;
    if (upgrade and framing == .invalid_te) return .none;
    return framing;
}

/// llhttp `should_keep_alive` for the request.
pub fn keepAliveRequested(req: *const Request, head: parse.Head) bool {
    const http11 = head.major > 0 and head.minor > 0;
    const c = req.header("connection") orelse return http11;
    var keep = false;
    var it = std.mem.splitScalar(u8, c, ',');
    while (it.next()) |tok| {
        const t = std.mem.trim(u8, tok, " \t");
        if (std.ascii.eqlIgnoreCase(t, "close")) return false;
        if (std.ascii.eqlIgnoreCase(t, "keep-alive")) keep = true;
    }
    return http11 or keep;
}

/// Node `continueExpression`: /(?:^|\W)100-continue(?:$|\W)/i.
fn expectsContinue(expect: []const u8) bool {
    const needle = "100-continue";
    var i: usize = 0;
    while (i + needle.len <= expect.len) : (i += 1) {
        if (!std.ascii.eqlIgnoreCase(expect[i .. i + needle.len], needle)) continue;
        const before_ok = i == 0 or !isWordChar(expect[i - 1]);
        const after = i + needle.len;
        const after_ok = after == expect.len or !isWordChar(expect[after]);
        if (before_ok and after_ok) return true;
    }
    return false;
}

fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_';
}

pub fn isUpgrade(req: *const Request) bool {
    if (req.header("upgrade") == null) return false;
    const c = req.header("connection") orelse return false;
    var it = std.mem.splitScalar(u8, c, ',');
    while (it.next()) |tok| if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, tok, " \t"), "upgrade")) return true;
    return false;
}

fn isBodyless(method: []const u8) bool {
    return std.mem.eql(u8, method, "GET") or std.mem.eql(u8, method, "HEAD") or std.mem.eql(u8, method, "TRACE");
}

fn isBodyWith(method: []const u8) bool {
    for ([_][]const u8{ "DELETE", "OPTIONS", "PATCH", "PUT", "POST", "QUERY" }) |m| if (std.mem.eql(u8, m, method)) return true;
    return false;
}

/// Static route lookup on a `parse.routerPath` result; GET routes answer HEAD.
pub fn matchRoute(routes: []const Route, method: []const u8, path: []const u8) ?*const Route {
    for (routes) |*r| {
        if (!std.mem.eql(u8, r.path, path)) continue;
        for (r.methods) |m| {
            if (std.mem.eql(u8, m, method)) return r;
            if (std.mem.eql(u8, m, "GET") and std.mem.eql(u8, method, "HEAD")) return r;
        }
    }
    return null;
}

pub fn statusText(status: u16) []const u8 {
    return switch (status) {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        417 => "Expectation Failed",
        422 => "Unprocessable Entity",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        else => "Unknown",
    };
}

/// RFC 7231 IMF-fixdate (Node `Date` header), cached per second per thread.
threadlocal var date_cache_second: i64 = -1;
threadlocal var date_cache: [29]u8 = undefined;

pub fn httpDate() []const u8 {
    const now = std.time.timestamp();
    if (now != date_cache_second) {
        date_cache_second = now;
        const es: std.time.epoch.EpochSeconds = .{ .secs = @intCast(now) };
        const day = es.getEpochDay();
        const yd = day.calculateYearDay();
        const md = yd.calculateMonthDay();
        const ds = es.getDaySeconds();
        const weekday = @mod(day.day + 4, 7); // 1970-01-01 was a Thursday
        const days = [_][]const u8{ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
        const months = [_][]const u8{ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        _ = std.fmt.bufPrint(&date_cache, "{s}, {d:0>2} {s} {d} {d:0>2}:{d:0>2}:{d:0>2} GMT", .{
            days[weekday],        md.day_index + 1,        months[md.month.numeric() - 1], yd.year,
            ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute(),
        }) catch {};
    }
    return &date_cache;
}

test "expectsContinue mirrors Node's continueExpression" {
    try std.testing.expect(expectsContinue("100-continue"));
    try std.testing.expect(expectsContinue("100-Continue, foo"));
    try std.testing.expect(!expectsContinue("x100-continue"));
    try std.testing.expect(!expectsContinue("foo"));
}

test "httpDate format" {
    const d = httpDate();
    try std.testing.expectEqual(@as(usize, 29), d.len);
    try std.testing.expect(std.mem.endsWith(u8, d, " GMT"));
}
