//! RFC 6455 server matching `ws` 8.21 (`new WebSocketServer({ noServer: true,
//! maxPayload })`, perMessageDeflate disabled as in TS):
//! * handshake validation and abort responses identical to `handleUpgrade`;
//! * receiver errors close with ws's codes (1002 protocol, 1007 UTF-8,
//!   1009 size, 1008 fragments) and emit ws's error messages;
//! * auto-pong, 30s close timeout, peer close echoed with its code/reason;
//! * `close` event code is the received close code (1005 none, 1006 abnormal).
//!
//! Evented (see `loop.zig`): after the upgrade the socket's slot turns into a
//! WebSocket slot. Reads run on a poller thread holding the slot's R token
//! (handler callbacks are serialized per connection); `send` queues a frame
//! and hands the W token to a poller, which writes queued frames with one
//! `sendmsg` and then fires their callbacks, so `bufferedAmount` (queued, not
//! yet written to the kernel) and send callbacks behave like `ws`. No thread
//! is tied to a socket.
const std = @import("std");
const builtin = @import("builtin");
const server_mod = @import("server.zig");
const types = @import("types.zig");
const loop_mod = @import("loop.zig");

const posix = std.posix;
const Request = types.Request;

pub const ReadyState = enum(u8) { connecting = 0, open = 1, closing = 2, closed = 3 };

pub const Handler = struct {
    ctx: *anyopaque,
    /// Complete message (text already UTF-8 validated). `data` is only valid
    /// during the call. Runs on a poller thread, one callback at a time per
    /// connection.
    on_message: *const fn (ctx: *anyopaque, conn: *Conn, data: []const u8, binary: bool) void,
    on_pong: ?*const fn (ctx: *anyopaque, conn: *Conn) void = null,
    /// ws 'error' (protocol violations, socket errors); always followed by on_close.
    on_error: ?*const fn (ctx: *anyopaque, conn: *Conn, message: []const u8) void = null,
    /// ws 'close'; called exactly once, after which no other callback runs.
    on_close: *const fn (ctx: *anyopaque, conn: *Conn, code: u16, reason: []const u8) void,
};

/// Invoked on a poller thread once the frame reached the kernel (ok=true)
/// or the socket failed/closed first (ok=false); never from `send` itself.
pub const SendCallback = struct {
    ctx: *anyopaque,
    func: *const fn (ctx: *anyopaque, conn: *Conn, ok: bool) void,
};

pub const SendError = error{ NotOpen, OutOfMemory };

pub const ServerOptions = struct {
    /// ws default 100 MiB.
    max_payload: usize = 100 * 1024 * 1024,
    max_fragments: usize = 16 * 1024,
    close_timeout_ms: u32 = 30_000,
};

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const Server = struct {
    options: ServerOptions,

    /// `wss.handleUpgrade(req, socket, head, cb)`. On a valid handshake writes
    /// `101 Switching Protocols` and returns the connection (the caller owns
    /// one reference: `release()` it once done, typically after on_close).
    /// Invalid handshakes get ws's abort response and return null.
    pub fn handleUpgrade(self: *const Server, gpa: std.mem.Allocator, req: *Request, socket: *server_mod.UpgradeSocket, handler: Handler) ?*Conn {
        const key = req.header("sec-websocket-key");
        const upgrade = req.header("upgrade");
        const version = req.header("sec-websocket-version");
        if (!std.mem.eql(u8, req.method, "GET")) return abort(socket, 405, "Invalid HTTP method", null);
        if (upgrade == null or !std.ascii.eqlIgnoreCase(upgrade.?, "websocket")) return abort(socket, 400, "Invalid Upgrade header", null);
        if (key == null or !validKey(key.?)) return abort(socket, 400, "Missing or invalid Sec-WebSocket-Key header", null);
        const v = if (version) |raw| jsNumberInt(raw) else null;
        if (v == null or (v.? != 13 and v.? != 8)) return abort(socket, 400, "Missing or invalid Sec-WebSocket-Version header", "Sec-WebSocket-Version: 13, 8\r\n");
        var protocol: ?[]const u8 = null;
        if (req.header("sec-websocket-protocol")) |raw| {
            protocol = parseFirstProtocol(raw) orelse return abort(socket, 400, "Invalid Sec-WebSocket-Protocol header", null);
        }
        var digest: [20]u8 = undefined;
        var sha = std.crypto.hash.Sha1.init(.{});
        sha.update(key.?);
        sha.update(GUID);
        sha.final(&digest);
        var accept: [28]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&accept, &digest);
        var head_buf: [512]u8 = undefined;
        const response = if (protocol) |p|
            std.fmt.bufPrint(&head_buf, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\nSec-WebSocket-Protocol: {s}\r\n\r\n", .{ &accept, p }) catch return abort(socket, 400, "Invalid Sec-WebSocket-Protocol header", null)
        else
            std.fmt.bufPrint(&head_buf, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{&accept}) catch unreachable;
        // Create the connection before answering 101, so a failure never
        // leaves the client with an upgraded but dead socket.
        const conn = Conn.create(gpa, socket, self.options, handler) catch {
            socket.destroy();
            return null;
        };
        if (!conn.writeHandshake(response)) {
            conn.abandon();
            socket.destroy();
            return null;
        }
        // The server attaches the connection to the poller set once
        // `on_upgrade` returns (the reader starts then).
        socket.takeover = conn;
        return conn;
    }
};

fn abort(socket: *server_mod.UpgradeSocket, code: u16, message: []const u8, extra: ?[]const u8) ?*Conn {
    var buf: [512]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "HTTP/1.1 {d} {s}\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: {d}\r\n{s}\r\n{s}", .{
        code, server_mod.statusText(code), message.len, extra orelse "", message,
    }) catch return null;
    _ = server_mod.writeFd(socket.fd, text);
    socket.destroy();
    return null;
}

fn validKey(key: []const u8) bool {
    if (key.len != 24 or !std.mem.endsWith(u8, key, "==")) return false;
    for (key[0..22]) |c| if (!(std.ascii.isAlphanumeric(c) or c == '+' or c == '/')) return false;
    return true;
}

fn jsNumberInt(raw: []const u8) ?i64 {
    const t = std.mem.trim(u8, raw, " \t");
    if (t.len == 0) return 0;
    return std.fmt.parseInt(i64, t, 10) catch null;
}

/// ws `subprotocol.parse`: comma-separated tokens, no duplicates; first wins.
fn parseFirstProtocol(raw: []const u8) ?[]const u8 {
    var first: ?[]const u8 = null;
    var it = std.mem.splitScalar(u8, raw, ',');
    var seen: [32][]const u8 = undefined;
    var n: usize = 0;
    while (it.next()) |part| {
        const p = std.mem.trim(u8, part, " \t");
        if (p.len == 0) return null;
        for (p) |c| if (!(std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", c) != null)) return null;
        for (seen[0..n]) |s| if (std.mem.eql(u8, s, p)) return null;
        if (n < seen.len) {
            seen[n] = p;
            n += 1;
        }
        if (first == null) first = p;
    }
    return first;
}

const Frame = struct {
    bytes: []u8,
    /// Bytes of `bytes` already written.
    off: usize = 0,
    cb: ?SendCallback,
    is_close: bool,
};

const max_batch = 16;

pub const Conn = struct {
    gpa: std.mem.Allocator,
    fd: posix.socket_t,
    options: ServerOptions,
    handler: Handler,
    remote_address: std.net.Address,
    /// Free slot for the owner.
    user: ?*anyopaque = null,

    mutex: std.Thread.Mutex = .{},
    queue: std.ArrayList(Frame) = .empty,
    queue_head: usize = 0,
    buffered: usize = 0,
    state: ReadyState = .open,
    close_frame_sent: bool = false,
    close_frame_received: bool = false,
    /// ws ends the socket once its close frame is out after a receiver error
    /// (`_receiver._writableState.errorEmitted`).
    receiver_failed: bool = false,
    close_code: u16 = 1006,
    close_reason: std.ArrayList(u8) = .empty,
    close_deadline: ?i64 = null,
    destroyed: bool = false,
    reader_done: bool = false,
    refs: std.atomic.Value(u32) = .init(2),
    initial: []u8,

    // Poller attachment (set once by `attach`, under `mutex`).
    server: ?*server_mod.Server = null,
    index: u32 = 0,
    gen: u32 = 0,
    // R holder only.
    readable: bool = true,
    hup: bool = false,
    reader: Reader = undefined,
    // W holder only.
    write_armed: bool = false,

    fn create(gpa: std.mem.Allocator, socket: *server_mod.UpgradeSocket, options: ServerOptions, handler: Handler) !*Conn {
        const self = try gpa.create(Conn);
        errdefer gpa.destroy(self);
        const initial = try gpa.dupe(u8, socket.head);
        errdefer gpa.free(initial);
        self.* = .{ .gpa = gpa, .fd = socket.fd, .options = options, .handler = handler, .remote_address = socket.remote_address, .initial = initial };
        self.reader = .{ .conn = self };
        return self;
    }

    /// Writes the 101 response; an unwritten tail is queued ahead of every
    /// frame (counted in `bufferedAmount`, like bytes in the socket's buffer).
    fn writeHandshake(self: *Conn, response: []const u8) bool {
        const flags: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
        const sent = posix.send(self.fd, response, flags | posix.MSG.DONTWAIT) catch |e| switch (e) {
            error.WouldBlock => 0,
            else => return false,
        };
        if (sent == response.len) return true;
        const tail = self.gpa.dupe(u8, response[sent..]) catch return false;
        self.queue.append(self.gpa, .{ .bytes = tail, .cb = null, .is_close = false }) catch {
            self.gpa.free(tail);
            return false;
        };
        self.buffered += tail.len;
        return true;
    }

    /// Undo `create` before the connection was handed out (fd stays with
    /// the caller).
    fn abandon(self: *Conn) void {
        for (self.queue.items) |f| self.gpa.free(f.bytes);
        self.queue.deinit(self.gpa);
        self.close_reason.deinit(self.gpa);
        self.gpa.free(self.initial);
        self.gpa.destroy(self);
    }

    pub fn retain(self: *Conn) void {
        _ = self.refs.fetchAdd(1, .monotonic);
    }

    pub fn release(self: *Conn) void {
        if (self.refs.fetchSub(1, .acq_rel) != 1) return;
        self.queue.deinit(self.gpa);
        self.close_reason.deinit(self.gpa);
        self.gpa.free(self.initial);
        self.gpa.destroy(self);
    }

    pub fn readyState(self: *Conn) ReadyState {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.state;
    }

    /// `ws.bufferedAmount`: frame bytes queued and not yet written.
    pub fn bufferedAmount(self: *Conn) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.buffered;
    }

    /// `ws.send(data, { binary }, cb)`. The bytes are copied.
    pub fn send(self: *Conn, data: []const u8, binary: bool, cb: ?SendCallback) SendError!void {
        return self.enqueue(if (binary) 0x2 else 0x1, data, cb, false);
    }

    /// Opt-in fast path for `send` (what Node does when the socket is
    /// writable): if nothing is queued, write the frame now with a
    /// non-blocking send under the connection lock, so it can never overtake
    /// or follow queued/close frames.
    /// * true: accepted. Fully written -> `cb(true)` right away (after the
    ///   lock is released); partially written -> the unwritten tail is queued
    ///   atomically (counted in `bufferedAmount`) and `cb` fires when the tail
    ///   is written, exactly like a queued frame. A socket error destroys the
    ///   connection and fires `cb(false)`, as the writer does.
    /// * false: the queue is busy or the kernel buffer is full (nothing was
    ///   written, `cb` not called): fall back to `send`.
    /// * error.NotOpen: not OPEN, same as `send`.
    pub fn trySendInline(self: *Conn, data: []const u8, binary: bool, cb: ?SendCallback) SendError!bool {
        var header: [10]u8 = undefined;
        const hlen = frameHeader(&header, if (binary) 0x2 else 0x1, data.len);
        const total = hlen + data.len;
        var outcome: enum { written, failed } = .written;
        var queued_tail = false;
        var kick = false;
        locked: {
            self.mutex.lock();
            defer self.mutex.unlock();
            if (self.destroyed or self.state != .open) return error.NotOpen;
            if (self.queue_head != self.queue.items.len) return false;
            var iov = [2]posix.iovec_const{
                .{ .base = &header, .len = hlen },
                .{ .base = data.ptr, .len = data.len },
            };
            const msg: posix.msghdr_const = .{
                .name = null,
                .namelen = 0,
                .iov = &iov,
                .iovlen = 2,
                .control = null,
                .controllen = 0,
                .flags = 0,
            };
            const nosignal: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
            const sent = posix.sendmsg(self.fd, &msg, posix.MSG.DONTWAIT | nosignal) catch |e| switch (e) {
                error.WouldBlock => return false,
                else => blk: {
                    kick = self.destroyLocked();
                    outcome = .failed;
                    break :blk total;
                },
            };
            if (outcome == .written and sent < total) {
                // Queue the tail as a raw frame so it goes out before anything
                // queued later; the callback rides on it.
                const tail = self.gpa.alloc(u8, total - sent) catch {
                    kick = self.destroyLocked(); // the stream is now unrecoverable
                    outcome = .failed;
                    break :locked;
                };
                var at: usize = 0;
                if (sent < hlen) {
                    @memcpy(tail[0 .. hlen - sent], header[sent..hlen]);
                    at = hlen - sent;
                    @memcpy(tail[at..], data);
                } else @memcpy(tail, data[sent - hlen ..]);
                self.queue.append(self.gpa, .{ .bytes = tail, .cb = cb, .is_close = false }) catch {
                    self.gpa.free(tail);
                    kick = self.destroyLocked();
                    outcome = .failed;
                    break :locked;
                };
                self.buffered += tail.len;
                queued_tail = true;
            }
        }
        if (kick) self.kickReader();
        if (queued_tail) {
            // Before `attach` the server schedules the flush itself.
            if (self.server != null) self.scheduleFlush();
            return true;
        }
        return self.finishInline(cb, outcome == .written);
    }

    pub const Snapshot = struct { ready_state: ReadyState, buffered_amount: usize };

    /// `readyState` and `bufferedAmount` under one lock.
    pub fn snapshot(self: *Conn) Snapshot {
        self.mutex.lock();
        defer self.mutex.unlock();
        return .{ .ready_state = self.state, .buffered_amount = self.buffered };
    }

    /// Fires an inline send's completion; the lock must not be held.
    fn finishInline(self: *Conn, cb: ?SendCallback, ok: bool) bool {
        if (cb) |c| c.func(c.ctx, self, ok);
        return true;
    }

    /// `ws.ping()` (empty payload).
    pub fn ping(self: *Conn) void {
        self.enqueue(0x9, "", null, false) catch {};
    }

    /// `ws.close(code, reason)`.
    pub fn close(self: *Conn, code: ?u16, reason: []const u8) void {
        self.mutex.lock();
        if (self.state == .closed or self.destroyed) {
            self.mutex.unlock();
            return;
        }
        if (self.state == .closing) {
            // Under the lock: teardown sets `destroyed` before it closes
            // the fd, so this can never half-close a reused descriptor.
            if (self.close_frame_sent and self.close_frame_received) posix.shutdown(self.fd, .send) catch {};
            self.mutex.unlock();
            return;
        }
        self.state = .closing;
        const deadline = loop_mod.monoMs() + self.options.close_timeout_ms;
        self.close_deadline = deadline;
        // The tick terminates the socket once the close handshake times out.
        if (self.server) |server| server.loop.slot(self.index).deadline.store(deadline, .release);
        self.mutex.unlock();
        var payload: [125]u8 = undefined;
        var len: usize = 0;
        if (code) |c| {
            std.mem.writeInt(u16, payload[0..2], c, .big);
            const r = reason[0..@min(reason.len, 123)];
            @memcpy(payload[2 .. 2 + r.len], r);
            len = 2 + r.len;
        }
        self.enqueueFrame(0x8, payload[0..len], null, true) catch {};
    }

    /// `ws.terminate()`: destroy the socket now.
    pub fn terminate(self: *Conn) void {
        self.mutex.lock();
        const kick = self.destroyLocked();
        self.mutex.unlock();
        if (kick) self.kickReader();
    }

    /// Marks the socket destroyed and shuts it down. True when the reader
    /// must be kicked (after unlocking): it may be parked with no event coming.
    fn destroyLocked(self: *Conn) bool {
        if (self.destroyed) return false;
        self.destroyed = true;
        if (self.state != .closed) self.state = .closing;
        posix.shutdown(self.fd, .both) catch {};
        return self.server != null and !self.reader_done;
    }

    /// Hands R (with KICK) to a poller, or flags KICK for the current reader.
    fn kickReader(self: *Conn) void {
        const server = self.server.?;
        if (loop_mod.claim(server.loop.slot(self.index), self.gen, loop_mod.R, loop_mod.KICK) == .claimed)
            server.loop.post(self.index, self.gen, loop_mod.R | loop_mod.KICK);
    }

    fn enqueue(self: *Conn, opcode: u8, data: []const u8, cb: ?SendCallback, is_close: bool) SendError!void {
        self.mutex.lock();
        const open = self.state == .open and !self.destroyed;
        self.mutex.unlock();
        if (!open) return error.NotOpen;
        return self.enqueueFrame(opcode, data, cb, is_close);
    }

    fn frameHeader(header: *[10]u8, opcode: u8, len: usize) usize {
        header[0] = 0x80 | opcode;
        if (len < 126) {
            header[1] = @intCast(len);
            return 2;
        } else if (len <= 0xffff) {
            header[1] = 126;
            std.mem.writeInt(u16, header[2..4], @intCast(len), .big);
            return 4;
        }
        header[1] = 127;
        std.mem.writeInt(u64, header[2..10], len, .big);
        return 10;
    }

    fn enqueueFrame(self: *Conn, opcode: u8, data: []const u8, cb: ?SendCallback, is_close: bool) SendError!void {
        var header: [10]u8 = undefined;
        const hlen = frameHeader(&header, opcode, data.len);
        const bytes = try self.gpa.alloc(u8, hlen + data.len);
        @memcpy(bytes[0..hlen], header[0..hlen]);
        @memcpy(bytes[hlen..], data);
        self.mutex.lock();
        // Checked under the same lock as the append: no data frame can be
        // queued behind the close frame.
        if (self.destroyed or (!is_close and self.state != .open)) {
            self.mutex.unlock();
            self.gpa.free(bytes);
            return error.NotOpen;
        }
        self.queue.append(self.gpa, .{ .bytes = bytes, .cb = cb, .is_close = is_close }) catch {
            self.mutex.unlock();
            self.gpa.free(bytes);
            return error.OutOfMemory;
        };
        self.buffered += bytes.len;
        const attached = self.server != null;
        self.mutex.unlock();
        if (attached) self.scheduleFlush();
    }

    /// Takes W and hands the connection to a poller, or flags W_AGAIN for the
    /// current writer. Never writes on the caller's thread.
    fn scheduleFlush(self: *Conn) void {
        const server = self.server.?;
        if (loop_mod.claim(server.loop.slot(self.index), self.gen, loop_mod.W, loop_mod.W_AGAIN) == .claimed)
            server.loop.post(self.index, self.gen, loop_mod.W);
    }

    // -- poller side ------------------------------------------------------------

    /// Called by the server (holding the slot's R) once `on_upgrade` returned:
    /// the slot now belongs to this connection. Feeds the bytes that followed
    /// the request head, then reads until the socket would block.
    pub fn attach(self: *Conn, server: *server_mod.Server, index: u32, gen: u32, write_armed: bool) void {
        self.mutex.lock();
        self.server = server;
        self.index = index;
        self.gen = gen;
        self.write_armed = write_armed;
        const queued = self.queue_head != self.queue.items.len;
        self.mutex.unlock();
        // Clear the HTTP park deadline (the tick would kick us forever).
        server.loop.slot(index).deadline.store(self.close_deadline orelse loop_mod.no_deadline, .release);
        if (queued) self.scheduleFlush();
        // A terminate() before attach is seen by the reader below.
        self.reader.feed(self.initial);
        self.gpa.free(self.initial);
        self.initial = &.{};
        self.runReader(.io, false);
    }

    /// Reads and dispatches frames; R is held. Returns after parking (R
    /// released) or once the reader finished.
    pub fn runReader(self: *Conn, io: loop_mod.Io, kick: bool) void {
        const server = self.server.?;
        const slot = server.loop.slot(self.index);
        var kicked = kick;
        var woke = io;
        while (true) {
            switch (woke) {
                .none => {},
                .io => self.readable = true,
                .hup => {
                    self.readable = true;
                    self.hup = true;
                },
            }
            if (self.readStep(kicked)) return self.readerDone();
            const pending = loop_mod.release(slot, loop_mod.R, loop_mod.r_pending);
            if (pending == 0) return;
            woke = loop_mod.Io.fromPending(pending);
            kicked = pending & loop_mod.KICK != 0;
        }
    }

    /// True once the socket is done (EOF, error, destroyed, close timeout).
    fn readStep(self: *Conn, kicked: bool) bool {
        if (kicked) {
            self.mutex.lock();
            const deadline = self.close_deadline;
            self.mutex.unlock();
            if (deadline) |d| if (loop_mod.monoMs() >= d) self.terminate();
        }
        const buf = server_mod.readBuffer() catch {
            self.terminate();
            return true;
        };
        while (true) {
            self.mutex.lock();
            const destroyed = self.destroyed;
            self.mutex.unlock();
            if (destroyed) return true;
            if (!self.readable) return false;
            const n = posix.read(self.fd, buf) catch |e| switch (e) {
                error.WouldBlock => {
                    self.readable = false;
                    return false;
                },
                else => return true,
            };
            if (n == 0) return true;
            // Edge-triggered: a short read drained the socket (unless the
            // peer hung up in the same edge: then read on to EOF).
            if (n < buf.len and !self.hup) self.readable = false;
            self.reader.feed(buf[0..n]);
        }
    }

    /// The reader is finished (R stays held): tear down now, or let the
    /// current writer do it when it lets go of W.
    fn readerDone(self: *Conn) void {
        self.mutex.lock();
        self.reader_done = true;
        _ = self.destroyLocked();
        self.state = .closed;
        self.mutex.unlock();
        const slot = self.server.?.loop.slot(self.index);
        var s = slot.state.load(.acquire);
        while (true) {
            const writer_busy = loop_mod.Slot.bitsOf(s) & loop_mod.W != 0;
            const next = s | (if (writer_busy) loop_mod.R_DONE else loop_mod.W);
            if (slot.state.cmpxchgWeak(s, next, .acq_rel, .acquire)) |actual| {
                s = actual;
                continue;
            }
            if (!writer_busy) self.teardown();
            return;
        }
    }

    /// Writes queued frames; W is held.
    pub fn runWriter(self: *Conn) void {
        const slot = self.server.?.loop.slot(self.index);
        while (true) {
            self.flush();
            var s = slot.state.load(.acquire);
            const outcome: enum { released, again, teardown } = while (true) {
                const bits = loop_mod.Slot.bitsOf(s);
                if (bits & loop_mod.R_DONE != 0) break .teardown;
                const next = if (bits & loop_mod.W_AGAIN != 0) s & ~@as(u64, loop_mod.W_AGAIN) else s & ~@as(u64, loop_mod.W);
                if (slot.state.cmpxchgWeak(s, next, .acq_rel, .acquire)) |actual| {
                    s = actual;
                    continue;
                }
                break if (bits & loop_mod.W_AGAIN != 0) .again else .released;
            };
            switch (outcome) {
                .released => return,
                .again => continue,
                .teardown => return self.teardown(),
            }
        }
    }

    /// Writes as many queued frames as the socket takes, then completes them.
    fn flush(self: *Conn) void {
        const server = self.server.?;
        const slot = server.loop.slot(self.index);
        // Writable events only matter while frames wait.
        loop_mod.setBits(slot, loop_mod.WANT_W);
        while (true) {
            var iov: [max_batch]posix.iovec_const = undefined;
            var count: usize = 0;
            self.mutex.lock();
            if (self.destroyed) {
                self.mutex.unlock();
                return; // teardown fails what is left
            }
            for (self.queue.items[self.queue_head..]) |f| {
                if (count == max_batch) break;
                iov[count] = .{ .base = f.bytes.ptr + f.off, .len = f.bytes.len - f.off };
                count += 1;
            }
            if (count == 0) {
                loop_mod.clearBits(slot, loop_mod.WANT_W);
                self.mutex.unlock();
                return;
            }
            self.mutex.unlock();
            const msg: posix.msghdr_const = .{ .name = null, .namelen = 0, .iov = &iov, .iovlen = @intCast(count), .control = null, .controllen = 0, .flags = 0 };
            const nosignal: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
            var sent = posix.sendmsg(self.fd, &msg, posix.MSG.DONTWAIT | nosignal) catch |e| switch (e) {
                error.WouldBlock => {
                    if (!self.write_armed) {
                        self.write_armed = true;
                        server.loop.enableWrite(self.fd, self.index, self.gen) catch self.terminate();
                    }
                    return;
                },
                else => {
                    self.terminate();
                    return;
                },
            };
            // Pop what was fully written; callbacks run after the lock.
            var done: [max_batch]Frame = undefined;
            var n_done: usize = 0;
            self.mutex.lock();
            while (self.queue_head < self.queue.items.len) {
                const f = &self.queue.items[self.queue_head];
                const left = f.bytes.len - f.off;
                if (sent < left) {
                    f.off += sent;
                    break;
                }
                sent -= left;
                done[n_done] = f.*;
                n_done += 1;
                self.queue_head += 1;
                self.buffered -= f.bytes.len;
                if (f.is_close) {
                    self.close_frame_sent = true;
                    if ((self.close_frame_received or self.receiver_failed) and !self.destroyed) posix.shutdown(self.fd, .send) catch {};
                }
            }
            if (self.queue_head == self.queue.items.len) {
                self.queue.clearRetainingCapacity();
                self.queue_head = 0;
            }
            self.mutex.unlock();
            for (done[0..n_done]) |f| {
                self.gpa.free(f.bytes);
                if (f.cb) |cb| cb.func(cb.ctx, self, true);
            }
        }
    }

    /// Holding R and W: fail what is left, close the fd, emit 'close'.
    fn teardown(self: *Conn) void {
        const server = self.server.?;
        self.mutex.lock();
        self.reader_done = true;
        _ = self.destroyLocked();
        self.state = .closed;
        const pending = self.queue.items[self.queue_head..];
        const leftovers = self.gpa.dupe(Frame, pending) catch &.{};
        self.queue.clearRetainingCapacity();
        self.queue_head = 0;
        self.buffered = 0;
        self.mutex.unlock();
        for (leftovers) |f| {
            self.gpa.free(f.bytes);
            if (f.cb) |cb| cb.func(cb.ctx, self, false);
        }
        if (leftovers.len > 0) self.gpa.free(leftovers);
        posix.close(self.fd);
        server.loop.freeSlot(self.index);
        const gpa = self.gpa;
        self.reader.message.deinit(gpa);
        self.reader.pending.deinit(gpa);
        self.handler.on_close(self.handler.ctx, self, self.close_code, self.close_reason.items);
        self.release();
        server.upgradedEnded();
    }

    /// Receiver error: close with `code` (no reason), emit 'error', ignore
    /// further input until the peer closes or the close timeout fires.
    fn fail(self: *Conn, code: u16, message: []const u8) void {
        self.mutex.lock();
        self.receiver_failed = true;
        self.mutex.unlock();
        self.close(code, "");
        if (self.handler.on_error) |f| f(self.handler.ctx, self, message);
    }

    fn onCloseFrame(self: *Conn, code: u16, reason: []const u8) void {
        self.mutex.lock();
        self.close_frame_received = true;
        self.close_code = code;
        self.close_reason.clearRetainingCapacity();
        self.close_reason.appendSlice(self.gpa, reason) catch {};
        self.mutex.unlock();
        if (code == 1005) self.close(null, "") else self.close(code, reason);
    }
};

/// Incremental frame parser (ws `Receiver`).
const Reader = struct {
    conn: *Conn,
    pending: std.ArrayList(u8) = .empty,
    message: std.ArrayList(u8) = .empty,
    fragmented: u8 = 0,
    fragments: usize = 0,
    total: usize = 0,
    stopped: bool = false,

    fn feed(self: *Reader, data: []const u8) void {
        if (self.stopped or data.len == 0) return;
        const gpa = self.conn.gpa;
        var input = data;
        if (self.pending.items.len > 0) {
            self.pending.appendSlice(gpa, data) catch return self.stop();
            input = self.pending.items;
        }
        var off: usize = 0;
        while (!self.stopped) {
            const used = self.frame(input[off..]) orelse break;
            off += used;
        }
        if (self.stopped) {
            self.pending.clearAndFree(gpa);
            return;
        }
        const rest = input[off..];
        if (self.pending.items.len > 0) {
            std.mem.copyForwards(u8, self.pending.items[0..rest.len], rest);
            self.pending.shrinkRetainingCapacity(rest.len);
        } else {
            self.pending.appendSlice(gpa, rest) catch self.stop();
        }
    }

    /// Allocation failure: stop parsing and destroy the socket (a zombie
    /// that silently ignores input would be worse; ws cannot run out).
    fn stop(self: *Reader) void {
        self.stopped = true;
        self.conn.terminate();
    }

    fn err(self: *Reader, code: u16, comptime prefixed: bool, message: []const u8) ?usize {
        self.stopped = true;
        var buf: [160]u8 = undefined;
        const text = if (prefixed) std.fmt.bufPrint(&buf, "Invalid WebSocket frame: {s}", .{message}) catch message else message;
        self.conn.fail(code, text);
        return null;
    }

    /// Parses one frame from `b`; returns bytes consumed or null if more
    /// input is needed (or the reader stopped).
    fn frame(self: *Reader, b: []const u8) ?usize {
        if (b.len < 2) return null;
        if (b[0] & 0x30 != 0) return self.err(1002, true, "RSV2 and RSV3 must be clear");
        const compressed = b[0] & 0x40 != 0;
        if (compressed) return self.err(1002, true, "RSV1 must be clear");
        const fin = b[0] & 0x80 != 0;
        var opcode: u8 = b[0] & 0x0f;
        const len7: u64 = b[1] & 0x7f;
        var buf: [64]u8 = undefined;
        if (opcode == 0) {
            if (self.fragmented == 0) return self.err(1002, true, "invalid opcode 0");
            opcode = self.fragmented;
        } else if (opcode == 1 or opcode == 2) {
            if (self.fragmented != 0) return self.err(1002, true, std.fmt.bufPrint(&buf, "invalid opcode {d}", .{opcode}) catch "invalid opcode");
        } else if (opcode >= 8 and opcode <= 10) {
            if (!fin) return self.err(1002, true, "FIN must be set");
            if (len7 > 125 or (opcode == 8 and len7 == 1)) return self.err(1002, true, std.fmt.bufPrint(&buf, "invalid payload length {d}", .{len7}) catch "invalid payload length");
        } else return self.err(1002, true, std.fmt.bufPrint(&buf, "invalid opcode {d}", .{opcode}) catch "invalid opcode");
        if (!fin and self.fragmented == 0) self.fragmented = opcode;
        if (b[1] & 0x80 == 0) return self.err(1002, true, "MASK must be set");
        var pos: usize = 2;
        var len: u64 = len7;
        if (len7 == 126) {
            if (b.len < 4) return null;
            len = std.mem.readInt(u16, b[2..4], .big);
            pos = 4;
        } else if (len7 == 127) {
            if (b.len < 10) return null;
            const v = std.mem.readInt(u64, b[2..10], .big);
            if (v >> 32 > (1 << 21) - 1) return self.err(1009, false, "Unsupported WebSocket frame: payload length > 2^53 - 1");
            len = v;
            pos = 10;
        }
        if (opcode < 8 and len > 0) {
            if (self.total + len > self.conn.options.max_payload) return self.err(1009, false, "Max payload size exceeded");
        }
        if (b.len < pos + 4) return null;
        const mask = b[pos .. pos + 4];
        pos += 4;
        if (b.len - pos < len) return null;
        const n: usize = @intCast(len);
        // Unmask into the message buffer (data) or a scratch copy (control).
        if (opcode >= 8) {
            var payload: [125]u8 = undefined;
            for (0..n) |i| payload[i] = b[pos + i] ^ mask[i % 4];
            self.control(opcode, payload[0..n]);
            return pos + n;
        }
        const gpa = self.conn.gpa;
        if (n > 0) {
            self.total += n;
            self.fragments += 1;
            if (self.fragments > self.conn.options.max_fragments) return self.err(1008, false, "Too many message fragments");
            const start = self.message.items.len;
            self.message.resize(gpa, start + n) catch {
                self.stop();
                return null;
            };
            for (0..n) |i| self.message.items[start + i] = b[pos + i] ^ mask[i % 4];
        }
        if (fin) {
            const binary = opcode == 2;
            if (!binary and !std.unicode.utf8ValidateSlice(self.message.items)) return self.err(1007, true, "invalid UTF-8 sequence");
            self.conn.handler.on_message(self.conn.handler.ctx, self.conn, self.message.items, binary);
            // Idle sockets keep no large message buffer.
            if (self.message.capacity > 16 * 1024) self.message.clearAndFree(gpa) else self.message.clearRetainingCapacity();
            self.fragmented = 0;
            self.fragments = 0;
            self.total = 0;
        }
        return pos + n;
    }

    fn control(self: *Reader, opcode: u8, payload: []const u8) void {
        switch (opcode) {
            0x8 => {
                self.stopped = true;
                if (payload.len == 0) return self.conn.onCloseFrame(1005, "");
                const code = std.mem.readInt(u16, payload[0..2], .big);
                if (!validCloseCode(code)) {
                    var buf: [64]u8 = undefined;
                    _ = self.err(1002, true, std.fmt.bufPrint(&buf, "invalid status code {d}", .{code}) catch "invalid status code");
                    return;
                }
                const reason = payload[2..];
                if (!std.unicode.utf8ValidateSlice(reason)) {
                    _ = self.err(1007, true, "invalid UTF-8 sequence");
                    return;
                }
                self.conn.onCloseFrame(code, reason);
            },
            0x9 => {
                // autoPong (only while open, like ws).
                if (self.conn.readyState() == .open) self.conn.enqueueFrame(0xA, payload, null, false) catch {};
            },
            0xA => if (self.conn.handler.on_pong) |f| f(self.conn.handler.ctx, self.conn),
            else => {},
        }
    }
};

fn validCloseCode(code: u16) bool {
    return (code >= 1000 and code <= 1014 and code != 1004 and code != 1005 and code != 1006) or (code >= 3000 and code <= 4999);
}

test "handshake key validation and subprotocol parsing" {
    try std.testing.expect(validKey("dGhlIHNhbXBsZSBub25jZQ=="));
    try std.testing.expect(!validKey("dGhlIHNhbXBsZSBub25jZQ="));
    try std.testing.expectEqualStrings("a", parseFirstProtocol("a, b").?);
    try std.testing.expect(parseFirstProtocol("a, a") == null);
    try std.testing.expect(parseFirstProtocol("a,,b") == null);
}
