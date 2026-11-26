//! Parser differential (io, 2026-11-18; test-only): runs the server's request-parsing sequence
//! (parse.zig head scan/parse, keep-alive, upgrade, BodyReader framing, the closed state after a
//! non-keep-alive message) over the inputs in `PARSE_DIFF_IN` and writes one JSON line per input
//! to `PARSE_DIFF_OUT`, for parity/parse/diff.mjs to compare with Node's own parser binding.
//! Skipped unless both variables are set:
//!   PARSE_DIFF_IN=cases.bin PARSE_DIFF_OUT=zig.jsonl ./build.sh test-http -Dtest-filter="parse diff"
//! PARSE_DIFF_SPLIT=<seed> feeds each input in seeded random pieces (1-byte runs included), as
//! reads arrive at the server: the head scan resumes on one `parse.HeadScanner` and the body
//! framing checks run at every piece's end; the output must equal the one-shot run's.
//! Input: records of u32 little-endian length + bytes. Output per record:
//!   {"msgs":[{"m":method,"u":url,"v":"1.1","h":[[name,value],…],"ka":bool,"up":bool,"body":n}],
//!    "end":"ok"|"incomplete"|"bad"|"overflow"|"closed"|"upgrade"}
const std = @import("std");
const parse = @import("parse.zig");
const server = @import("server.zig");
const types = @import("types.zig");

const Cursor = struct {
    buf: []const u8,
    start: usize,
    end: usize,
    /// Split mode: where the next piece comes from.
    rng: ?std.Random = null,

    /// Split mode: the next piece arrives (1-byte runs, short and long reads).
    fn grow(self: *Cursor) bool {
        const r = self.rng orelse return false;
        if (self.end == self.buf.len) return false;
        const piece: usize = switch (r.uintLessThan(u8, 8)) {
            0, 1, 2 => 1,
            3, 4, 5 => r.intRangeAtMost(usize, 2, 64),
            else => r.intRangeAtMost(usize, 65, 4096),
        };
        self.end = @min(self.buf.len, self.end + piece);
        return true;
    }

    fn growAll(self: *Cursor) void {
        self.end = self.buf.len;
    }
};

/// A JSON string of raw bytes read as latin1 (Node's header and URL strings).
fn latin1(w: *std.Io.Writer, bytes: []const u8) !void {
    try w.writeByte('"');
    for (bytes) |b| switch (b) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        0x20...0x21, 0x23...0x5b, 0x5d...0x7e => try w.writeByte(b),
        else => try w.print("\\u{x:0>4}", .{b}),
    };
    try w.writeByte('"');
}

fn skipCrlf(c: *Cursor) void {
    while (c.start < c.end and (c.buf[c.start] == '\r' or c.buf[c.start] == '\n')) c.start += 1;
}

fn one(a: std.mem.Allocator, bytes: []const u8, w: *std.Io.Writer, rng: ?std.Random) !void {
    var c: Cursor = .{ .buf = bytes, .start = 0, .end = bytes.len, .rng = rng };
    if (rng != null) {
        c.end = 0;
        _ = c.grow();
    }
    try w.writeAll("{\"msgs\":[");
    var first_msg = true;
    const end: []const u8 = msgs: while (true) {
        // As the server's stepHead: CRLFs are skipped only before a head's first byte.
        while (true) {
            skipCrlf(&c);
            if (c.start < c.end or !c.grow()) break;
        }
        if (c.start == c.end) break if (first_msg) "incomplete" else "ok";
        var head_scan: parse.HeadScanner = .{};
        const scan = while (true) {
            const s = head_scan.scan(c.buf[c.start..c.end]) catch |e| break :msgs switch (e) {
                error.HeaderOverflow => "overflow",
                else => "bad",
            };
            if (s == .incomplete and c.grow()) continue;
            break s;
        };
        const len = switch (scan) {
            .incomplete => break "incomplete",
            .complete => |n| n,
        };
        const head = parse.parseHead(a, c.buf[c.start .. c.start + len]) catch |e| break switch (e) {
            error.HeaderOverflow => "overflow",
            else => "bad",
        };
        c.start += len;
        const q = std.mem.indexOfScalar(u8, head.url, '?');
        const req: types.Request = .{
            .arena = a,
            .method = head.method,
            .url = head.url,
            .path = head.url[0 .. q orelse head.url.len],
            .query = if (q) |i| head.url[i + 1 ..] else "",
            .headers = head.headers,
            .remote_address = std.net.Address.initIp4(.{ 127, 0, 0, 1 }, 0),
        };
        const ka = server.keepAliveRequested(&req, head);
        const up = std.mem.eql(u8, head.method, "CONNECT") or server.isUpgrade(&req);
        // Body data (not framing bytes); a framing error still reports the message
        // and the data before it (Node's headers-complete callback already ran).
        // The server's own framing rule (CONNECT, upgrade bodies).
        const connect = std.mem.eql(u8, head.method, "CONNECT");
        var body: server.BodyReader = .{ .framing = server.requestFraming(head.framing, connect, up) };
        var data: std.ArrayList(u8) = .empty;
        var bad = false;
        const progress = while (true) {
            const p = body.consume(&c, a, &data, std.math.maxInt(usize)) catch {
                bad = true;
                break .need_more;
            };
            if (p == .need_more and c.grow()) continue;
            break p;
        };
        if (!first_msg) try w.writeByte(',');
        first_msg = false;
        try w.writeAll("{\"m\":");
        try latin1(w, head.method);
        try w.writeAll(",\"u\":");
        try latin1(w, head.url);
        try w.print(",\"v\":\"{d}.{d}\",\"h\":[", .{ head.major, head.minor });
        for (head.headers, 0..) |h, i| {
            if (i > 0) try w.writeByte(',');
            try w.writeByte('[');
            try latin1(w, h.name);
            try w.writeByte(',');
            try latin1(w, h.value);
            try w.writeByte(']');
        }
        try w.print("],\"ka\":{},\"up\":{},\"body\":{d}}}", .{ ka, up, data.items.len });
        // After an upgrade the server hides every later byte once the body's
        // framing fails (ws.zig `body_failed`, Node's UpgradeStream): no answer,
        // the socket stays open, as Node's parser waiting at the upgrade.
        if (bad) break if (up) "incomplete" else "bad";
        if (progress == .need_more) break "incomplete";
        if (up) break "upgrade";
        if (!ka) {
            c.growAll();
            skipCrlf(&c);
            break if (c.start == c.end) "ok" else "closed";
        }
    };
    try w.print("],\"end\":\"{s}\"}}\n", .{end});
}

test "parse diff: the server's parsing sequence over PARSE_DIFF_IN (offline differential vs Node)" {
    const gpa = std.testing.allocator;
    const in_path = std.process.getEnvVarOwned(gpa, "PARSE_DIFF_IN") catch return error.SkipZigTest;
    defer gpa.free(in_path);
    const out_path = std.process.getEnvVarOwned(gpa, "PARSE_DIFF_OUT") catch return error.SkipZigTest;
    defer gpa.free(out_path);
    const input = try std.fs.cwd().readFileAlloc(gpa, in_path, 1 << 30);
    defer gpa.free(input);
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const split_seed: ?u64 = blk: {
        const v = std.process.getEnvVarOwned(gpa, "PARSE_DIFF_SPLIT") catch break :blk null;
        defer gpa.free(v);
        break :blk try std.fmt.parseInt(u64, v, 10);
    };
    var at: usize = 0;
    var index: u64 = 0;
    while (at + 4 <= input.len) : (index += 1) {
        const len = std.mem.readInt(u32, input[at..][0..4], .little);
        at += 4;
        if (at + len > input.len) return error.TruncatedInput;
        var prng = std.Random.DefaultPrng.init((split_seed orelse 0) *% 0x9e3779b97f4a7c15 +% index);
        try one(arena_state.allocator(), input[at .. at + len], &out.writer, if (split_seed != null) prng.random() else null);
        at += len;
        _ = arena_state.reset(.retain_capacity);
    }
    try std.fs.cwd().writeFile(.{ .sub_path = out_path, .data = out.written() });
}
