//! Replays `testdata/http-corpus.json` (raw exchanges recorded against the TS
//! server by `testdata/gen-http-corpus.mjs`) against an in-process server
//! wired like the real app: /metrics, a /graphql stand-in, and an upgrade
//! handler routing /agents and /messages like `EventWebSocketServer`.
const std = @import("std");
const core = @import("core");
const types = @import("types.zig");
const server_mod = @import("server.zig");
const ws = @import("ws.zig");
const metrics_route = @import("metrics_route.zig");

const posix = std.posix;
const corpus_text = @embedFile("testdata/http-corpus.json");

var dummy: u8 = 0;

fn graphqlHandler(_: *anyopaque, _: *types.Request, reply: *types.Reply) void {
    reply.sendText("graphql stand-in");
}

const Upgrades = struct {
    agents: ws.Server = .{ .options = .{ .max_payload = 1024 * 1024 } },
    messages: ws.Server = .{ .options = .{ .max_payload = 4096 } },

    fn onUpgrade(ctx: *anyopaque, req: *types.Request, socket: *server_mod.UpgradeSocket) void {
        const self: *Upgrades = @ptrCast(@alignCast(ctx));
        const target: ?*ws.Server = if (std.mem.eql(u8, req.path, "/agents"))
            &self.agents
        else if (std.mem.eql(u8, req.path, "/messages"))
            &self.messages
        else
            null;
        const wss = target orelse return socket.destroy();
        _ = wss.handleUpgrade(std.heap.c_allocator, req, socket, .{ .ctx = self, .on_message = onMessage, .on_close = onClose });
    }

    fn onMessage(_: *anyopaque, _: *ws.Conn, _: []const u8, _: bool) void {}

    fn onClose(_: *anyopaque, conn: *ws.Conn, _: u16, _: []const u8) void {
        conn.release();
    }
};

const Case = struct {
    name: []const u8,
    chunks: []const []const u8,
    mode: []const u8,
    response: []const u8,
    actual: []const u8 = "",
};

fn worker(port: u16, cases: []Case, next: *std.atomic.Value(usize)) void {
    while (true) {
        const i = next.fetchAdd(1, .monotonic);
        if (i >= cases.len) return;
        if (std.mem.eql(u8, cases[i].actual, "SKIP")) continue;
        cases[i].actual = run(port, cases[i].chunks) catch |e| @errorName(e);
    }
}

fn run(port: u16, chunks: []const []const u8) ![]const u8 {
    const address = try std.net.Address.parseIp("127.0.0.1", port);
    const stream = try std.net.tcpConnectToAddress(address);
    defer stream.close();
    for (chunks) |chunk| {
        try stream.writeAll(try latin1(chunk));
        std.Thread.sleep(50 * std.time.ns_per_ms);
    }
    var out: std.ArrayList(u8) = .empty;
    var buf: [64 * 1024]u8 = undefined;
    while (true) {
        var fds = [_]posix.pollfd{.{ .fd = stream.handle, .events = posix.POLL.IN, .revents = 0 }};
        if (try posix.poll(&fds, 300) == 0) {
            try out.appendSlice(std.heap.c_allocator, "<OPEN>");
            break;
        }
        const n = posix.read(stream.handle, &buf) catch {
            try out.appendSlice(std.heap.c_allocator, "<RESET>");
            break;
        };
        if (n == 0) {
            try out.appendSlice(std.heap.c_allocator, "<EOF>");
            break;
        }
        try out.appendSlice(std.heap.c_allocator, buf[0..n]);
    }
    return out.items;
}

/// The corpus stores bytes as latin1 code points in JSON strings; map each
/// decoded code point back to its byte.
fn latin1(text: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    const view = try std.unicode.Utf8View.init(text);
    var it = view.iterator();
    while (it.nextCodepoint()) |cp| try out.append(std.heap.c_allocator, @intCast(cp));
    return out.items;
}

/// Responses are latin1 too: map each byte >= 0x80 to its UTF-8 encoding so
/// both sides compare as text.
fn toLatin1Text(a: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (bytes) |b| {
        if (b < 0x80) try out.append(a, b) else {
            var enc: [2]u8 = undefined;
            const n = std.unicode.utf8Encode(b, &enc) catch unreachable;
            try out.appendSlice(a, enc[0..n]);
        }
    }
    return out.items;
}

fn normalizeDate(a: std.mem.Allocator, text: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var rest = text;
    while (std.mem.indexOf(u8, rest, "\r\nDate: ")) |i| {
        try out.appendSlice(a, rest[0 .. i + 8]);
        try out.appendSlice(a, "<DATE>");
        rest = rest[i + 8 ..];
        rest = rest[std.mem.indexOf(u8, rest, "\r\n") orelse rest.len ..];
    }
    try out.appendSlice(a, rest);
    return out.items;
}

/// Applies the case mode: `head` keeps the response head, `metrics` also
/// masks content-length (the exposition body differs between runtimes).
fn shape(a: std.mem.Allocator, mode: []const u8, text: []const u8) ![]const u8 {
    if (std.mem.eql(u8, mode, "full")) return text;
    const end = std.mem.indexOf(u8, text, "\r\n\r\n") orelse return text;
    const head_text = text[0 .. end + 4];
    if (std.mem.eql(u8, mode, "head")) return head_text;
    if (std.mem.eql(u8, mode, "ws")) return wsShape(a, head_text, text[end + 4 ..]);
    var out: std.ArrayList(u8) = .empty;
    var lines = std.mem.splitSequence(u8, head_text, "\r\n");
    while (lines.next()) |line| {
        if (std.ascii.startsWithIgnoreCase(line, "content-length:")) {
            try out.appendSlice(a, "content-length: <N>");
        } else try out.appendSlice(a, line);
        try out.appendSlice(a, "\r\n");
    }
    return out.items;
}

/// The 101 head, then each server frame except text frames (live-stream
/// payloads), then the end marker. Frames are rendered as `opN:hexpayload`.
fn wsShape(a: std.mem.Allocator, head_text: []const u8, frames_text: []const u8) ![]const u8 {
    // Undo the latin1 text mapping to get raw frame bytes.
    var raw: std.ArrayList(u8) = .empty;
    var marker: []const u8 = "";
    const view = std.unicode.Utf8View.init(frames_text) catch return frames_text;
    var it = view.iterator();
    while (it.nextCodepointSlice()) |slice| {
        if (slice[0] == '<') {
            marker = frames_text[@intFromPtr(slice.ptr) - @intFromPtr(frames_text.ptr) ..];
            break;
        }
        try raw.append(a, @intCast(try std.unicode.utf8Decode(slice)));
    }
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, head_text);
    var rest = raw.items;
    while (rest.len >= 2) {
        const opcode = rest[0] & 0x0f;
        var len: usize = rest[1] & 0x7f;
        var pos: usize = 2;
        if (len == 126) {
            len = std.mem.readInt(u16, rest[2..4], .big);
            pos = 4;
        } else if (len == 127) {
            len = @intCast(std.mem.readInt(u64, rest[2..10], .big));
            pos = 10;
        }
        if (rest.len < pos + len) break;
        if (opcode != 1) try out.print(a, "op{d}:{x} ", .{ opcode, rest[pos .. pos + len] });
        rest = rest[pos + len ..];
    }
    try out.appendSlice(a, marker);
    return out.items;
}

test "HTTP exchanges match the TS server corpus" {
    var arena_state = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const parsed = try std.json.parseFromSliceLeaky(struct { cases: []Case }, a, corpus_text, .{ .ignore_unknown_fields = true });

    var upgrades: Upgrades = .{};
    const routes = [_]types.Route{
        metrics_route.route(),
        .{ .methods = &.{ "GET", "POST" }, .path = "/graphql", .ctx = &dummy, .hooks = .{ .handler = graphqlHandler }, .text_content_types = &.{"application/graphql"} },
    };
    const server = try server_mod.Server.init(std.heap.c_allocator, .{
        .host = "127.0.0.1",
        .port = 0,
        .routes = &routes,
        .upgrade = .{ .ctx = &upgrades, .on_upgrade = Upgrades.onUpgrade },
    });
    try server.start();
    defer server.deinit();

    // CORPUS_ONLY=<substring> narrows the run while debugging.
    const only = std.posix.getenv("CORPUS_ONLY");
    for (parsed.cases) |*case| {
        if (only) |o| if (std.mem.indexOf(u8, case.name, o) == null) {
            case.actual = "SKIP";
        };
    }
    // A few workers keep the run short without overflowing the listen
    // backlog (macOS caps it at 128).
    var next: std.atomic.Value(usize) = .init(0);
    var workers: [12]std.Thread = undefined;
    for (&workers) |*w| w.* = try std.Thread.spawn(.{}, worker, .{ server.port(), parsed.cases, &next });
    for (workers) |w| w.join();

    var failures: usize = 0;
    for (parsed.cases) |case| {
        if (std.mem.eql(u8, case.actual, "SKIP")) continue;
        const want = try shape(a, case.mode, case.response);
        const have = try shape(a, case.mode, try normalizeDate(a, try toLatin1Text(a, case.actual)));
        if (std.mem.eql(u8, want, have)) continue;
        failures += 1;
        std.debug.print("\n== {s}\n  want: {f}\n  have: {f}\n", .{ case.name, std.json.fmt(want, .{}), std.json.fmt(have, .{}) });
    }
    try std.testing.expectEqual(@as(usize, 0), failures);
}
