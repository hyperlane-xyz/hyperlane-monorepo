//! RFC 6455 server matching `ws` 8.21 (`new WebSocketServer({ noServer: true,
//! maxPayload })`, perMessageDeflate disabled as in TS):
//! * handshake validation and abort responses identical to `handleUpgrade`;
//! * receiver errors close with ws's codes (1002 protocol, 1007 UTF-8,
//!   1009 size, 1008 fragments) and emit ws's error messages;
//! * auto-pong, 30s close timeout, peer close echoed with its code/reason;
//! * `close` event code is the received close code (1005 none, 1006 abnormal).
//!
//! Threads: the reader loop runs on the HTTP connection thread after the
//! upgrade; a per-connection writer thread drains a FIFO of frames so
//! `bufferedAmount` (queued, not yet written to the kernel) and send
//! callbacks (invoked once the frame is written) behave like `ws`.
const std = @import("std");
const builtin = @import("builtin");
const server_mod = @import("server.zig");
const types = @import("types.zig");

const posix = std.posix;
const Request = types.Request;

pub const ReadyState = enum(u8) { connecting = 0, open = 1, closing = 2, closed = 3 };

pub const Handler = struct {
    ctx: *anyopaque,
    /// Complete message (text already UTF-8 validated). `data` is only valid
    /// during the call. Runs on the connection's reader thread.
    on_message: *const fn (ctx: *anyopaque, conn: *Conn, data: []const u8, binary: bool) void,
    on_pong: ?*const fn (ctx: *anyopaque, conn: *Conn) void = null,
    /// ws 'error' (protocol violations, socket errors); always followed by on_close.
    on_error: ?*const fn (ctx: *anyopaque, conn: *Conn, message: []const u8) void = null,
    /// ws 'close'; called exactly once, after which no other callback runs.
    on_close: *const fn (ctx: *anyopaque, conn: *Conn, code: u16, reason: []const u8) void,
};

/// Invoked on the writer thread once the frame reached the kernel (ok=true)
/// or the socket failed/closed first (ok=false).
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
        // Create the connection (and its writer) before answering 101, so a
        // failure never leaves the client with an upgraded but dead socket.
        const conn = Conn.create(gpa, socket, self.options, handler) catch {
            socket.destroy();
            return null;
        };
        if (!server_mod.writeFd(socket.fd, response)) {
            conn.abandon();
            socket.destroy();
            return null;
        }
        // From here the socket is non-blocking: the writer waits in poll()
        // (so `trySendInline` can never block, even where MSG_DONTWAIT is
        // ignored, e.g. macOS) and `terminate` still wakes everyone.
        setNonblocking(socket.fd);
        socket.takeover = .{ .ctx = conn, .run = Conn.runThunk };
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

fn setNonblocking(fd: posix.socket_t) void {
    const Bits = std.meta.Int(.unsigned, @bitSizeOf(posix.O));
    const flags = posix.fcntl(fd, posix.F.GETFL, 0) catch return;
    var o: posix.O = @bitCast(@as(Bits, @truncate(flags)));
    o.NONBLOCK = true;
    _ = posix.fcntl(fd, posix.F.SETFL, @as(Bits, @bitCast(o))) catch {};
}

/// Writes all of `bytes` to a non-blocking socket, waiting in poll() when
/// the kernel buffer is full. Fails once the socket errors or is shut down.
fn writeAllNonblocking(fd: posix.socket_t, bytes: []const u8) bool {
    var off: usize = 0;
    const flags: u32 = if (builtin.os.tag == .linux) std.os.linux.MSG.NOSIGNAL else 0;
    while (off < bytes.len) {
        const n = posix.send(fd, bytes[off..], flags) catch |e| switch (e) {
            error.WouldBlock => {
                var fds = [_]posix.pollfd{.{ .fd = fd, .events = posix.POLL.OUT, .revents = 0 }};
                _ = posix.poll(&fds, -1) catch return false;
                if (fds[0].revents & (posix.POLL.ERR | posix.POLL.HUP | posix.POLL.NVAL) != 0 and fds[0].revents & posix.POLL.OUT == 0) return false;
                continue;
            },
            else => return false,
        };
        off += n;
    }
    return true;
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
    cb: ?SendCallback,
    is_close: bool,
};

pub const Conn = struct {
    gpa: std.mem.Allocator,
    fd: posix.socket_t,
    options: ServerOptions,
    handler: Handler,
    remote_address: std.net.Address,
    /// Free slot for the owner.
    user: ?*anyopaque = null,

    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
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
    writer: ?std.Thread = null,
    refs: std.atomic.Value(u32) = .init(2),
    initial: []u8,

    fn create(gpa: std.mem.Allocator, socket: *server_mod.UpgradeSocket, options: ServerOptions, handler: Handler) !*Conn {
        const self = try gpa.create(Conn);
        errdefer gpa.destroy(self);
        const initial = try gpa.dupe(u8, socket.head);
        errdefer gpa.free(initial);
        self.* = .{ .gpa = gpa, .fd = socket.fd, .options = options, .handler = handler, .remote_address = socket.remote_address, .initial = initial };
        self.writer = try std.Thread.spawn(.{ .stack_size = 2 * 1024 * 1024 }, writerLoop, .{self});
        return self;
    }

    /// Undo `create` before the connection was handed out (fd stays with
    /// the caller).
    fn abandon(self: *Conn) void {
        self.mutex.lock();
        self.reader_done = true;
        self.cond.broadcast();
        self.mutex.unlock();
        if (self.writer) |t| t.join();
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
                    self.destroyLocked();
                    outcome = .failed;
                    break :blk total;
                },
            };
            if (outcome == .written and sent < total) {
                // Queue the tail as a raw frame so it goes out before anything
                // queued later; the callback rides on it.
                const tail = self.gpa.alloc(u8, total - sent) catch {
                    self.destroyLocked(); // the stream is now unrecoverable
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
                    self.destroyLocked();
                    outcome = .failed;
                    break :locked;
                };
                self.buffered += tail.len;
                self.cond.signal();
                return true;
            }
        }
        return self.finishInline(cb, outcome == .written);
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
            // Under the lock: the reader sets `destroyed` before it closes
            // the fd, so this can never half-close a reused descriptor.
            if (self.close_frame_sent and self.close_frame_received) posix.shutdown(self.fd, .send) catch {};
            self.mutex.unlock();
            return;
        }
        self.state = .closing;
        self.close_deadline = std.time.milliTimestamp() + self.options.close_timeout_ms;
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
        defer self.mutex.unlock();
        self.destroyLocked();
    }

    fn destroyLocked(self: *Conn) void {
        if (self.destroyed) return;
        self.destroyed = true;
        if (self.state != .closed) self.state = .closing;
        posix.shutdown(self.fd, .both) catch {};
        self.cond.broadcast();
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
        defer self.mutex.unlock();
        // Checked under the same lock as the append: no data frame can be
        // queued behind the close frame.
        if (self.destroyed or (!is_close and self.state != .open)) {
            self.gpa.free(bytes);
            return error.NotOpen;
        }
        self.queue.append(self.gpa, .{ .bytes = bytes, .cb = cb, .is_close = is_close }) catch {
            self.gpa.free(bytes);
            return error.OutOfMemory;
        };
        self.buffered += bytes.len;
        self.cond.signal();
    }

    fn writerLoop(self: *Conn) void {
        while (true) {
            self.mutex.lock();
            while (self.queue_head == self.queue.items.len and !self.reader_done and !self.destroyed) self.cond.wait(&self.mutex);
            if (self.queue_head == self.queue.items.len) {
                self.mutex.unlock();
                return;
            }
            const frame = self.queue.items[self.queue_head];
            const dead = self.destroyed;
            self.mutex.unlock();
            const ok = !dead and writeAllNonblocking(self.fd, frame.bytes);
            self.mutex.lock();
            self.queue_head += 1;
            if (self.queue_head == self.queue.items.len) {
                self.queue.clearRetainingCapacity();
                self.queue_head = 0;
            }
            self.buffered -= frame.bytes.len;
            var shutdown_write = false;
            if (ok and frame.is_close) {
                self.close_frame_sent = true;
                shutdown_write = self.close_frame_received or self.receiver_failed;
            }
            if (!ok) self.destroyLocked();
            if (shutdown_write and !self.destroyed) posix.shutdown(self.fd, .send) catch {};
            self.mutex.unlock();
            self.gpa.free(frame.bytes);
            if (frame.cb) |cb| cb.func(cb.ctx, self, ok);
        }
    }

    fn runThunk(ctx: *anyopaque) void {
        const self: *Conn = @ptrCast(@alignCast(ctx));
        self.run();
    }

    fn run(self: *Conn) void {
        var reader: Reader = .{ .conn = self };
        // Freed before `release()` below: `self` may not outlive it.
        const gpa = self.gpa;
        defer {
            reader.message.deinit(gpa);
            reader.pending.deinit(gpa);
        }
        reader.feed(self.initial);
        var buf: [16 * 1024]u8 = undefined;
        while (true) {
            self.mutex.lock();
            const deadline = self.close_deadline;
            const destroyed = self.destroyed;
            self.mutex.unlock();
            if (destroyed) break;
            var timeout: i32 = -1;
            if (deadline) |d| {
                const remaining = d - std.time.milliTimestamp();
                if (remaining <= 0) {
                    self.terminate();
                    break;
                }
                timeout = @intCast(@min(remaining, std.math.maxInt(i32)));
            }
            var fds = [_]posix.pollfd{.{ .fd = self.fd, .events = posix.POLL.IN, .revents = 0 }};
            const ready = posix.poll(&fds, timeout) catch break;
            if (ready == 0) continue;
            const n = posix.read(self.fd, &buf) catch |e| switch (e) {
                error.WouldBlock => continue,
                else => break,
            };
            if (n == 0) break;
            reader.feed(buf[0..n]);
        }
        // Socket closed: stop the writer, fail pending sends, emit 'close'.
        self.mutex.lock();
        self.reader_done = true;
        self.destroyLocked();
        self.state = .closed;
        self.mutex.unlock();
        if (self.writer) |t| t.join();
        // Frames left behind (writer exited early) fail their callbacks.
        self.mutex.lock();
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
        self.handler.on_close(self.handler.ctx, self, self.close_code, self.close_reason.items);
        self.release();
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
            self.message.clearRetainingCapacity();
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
