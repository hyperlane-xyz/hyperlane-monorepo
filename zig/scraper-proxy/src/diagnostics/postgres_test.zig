//! Port of `src/diagnostics/postgres.test.ts`: the production SQL against a
//! session-local `pg_temp.message_activity` on a disposable loopback database
//! named by DIAGNOSTICS_TEST_DATABASE_URL (skipped when unset).
const std = @import("std");
const db = @import("db");
const js = @import("js.zig");
const svc_mod = @import("service.zig");
const testing = std.testing;

const message_id = "0x" ++ "01" ** 32;
const message_hex = "01" ** 32;
const table_sql =
    \\CREATE TEMP TABLE message_activity (
    \\  id bigint PRIMARY KEY, message_id bytea, relayer bytea, origin bigint, destination bigint,
    \\  observed_at timestamptz, received_at timestamptz, version integer, activity jsonb
    \\)
;

const Session = struct {
    arena_state: std.heap.ArenaAllocator,
    conn: db.pq.Conn,
    service: svc_mod.Service = undefined,

    fn open(self: *Session, statement_timeout_ms: ?u64) !void {
        @import("testing_log.zig").silence();
        const url = std.process.getEnvVarOwned(testing.allocator, "DIAGNOSTICS_TEST_DATABASE_URL") catch return error.SkipZigTest;
        defer testing.allocator.free(url);
        self.arena_state = std.heap.ArenaAllocator.init(testing.allocator);
        errdefer self.arena_state.deinit();
        self.conn = try db.pq.Conn.connect(.{ .conninfo = url, .statement_timeout_ms = statement_timeout_ms }, self.arena(), null);
        self.service = .{ .db = .{ .ctx = self, .query = query }, .table = "pg_temp.message_activity" };
        try self.exec(table_sql, &.{});
    }

    fn close(self: *Session) void {
        self.conn.deinit();
        self.arena_state.deinit();
    }

    fn arena(self: *Session) std.mem.Allocator {
        return self.arena_state.allocator();
    }

    fn exec(self: *Session, sql: []const u8, params: []const db.Value) !void {
        _ = try self.conn.query(self.arena(), sql, params, null);
    }

    fn insert(self: *Session, id: u64, relayer: []const u8, activity: []const u8) !void {
        try self.exec(
            "INSERT INTO message_activity VALUES ($1,decode($2,'hex'),decode($3,'hex'),1,2,now(),now(),1,$4)",
            &.{ db.Value{ .number = @floatFromInt(id) }, .{ .string = message_hex }, .{ .string = relayer }, .{ .string = activity } },
        );
    }

    fn query(ctx: *anyopaque, arena_alloc: std.mem.Allocator, sql: []const u8, params: []const ?[]const u8) anyerror![]const js.Value {
        const self: *Session = @ptrCast(@alignCast(ctx));
        const values = try arena_alloc.alloc(db.Value, params.len);
        for (params, values) |p, *v| v.* = if (p) |text| .{ .string = text } else .null;
        const result = try self.conn.query(arena_alloc, sql, values, null);
        const rows = try arena_alloc.alloc(js.Value, result.rows.len);
        for (result.rows, rows) |row, *out| out.* = try js.fromCore(arena_alloc, row);
        return rows;
    }

    fn snapshot(self: *Session) !*js.Object {
        return (try self.service.snapshots(self.arena(), &.{message_id}))[0].object;
    }
};

fn ids(object: *js.Object, key: []const u8, out: *std.ArrayList([]const u8)) ![]const []const u8 {
    out.clearRetainingCapacity();
    for (object.get(key).array.items) |row| try out.append(testing.allocator, row.object.get("id").string);
    return out.items;
}

fn expectIds(expected: []const []const u8, actual: []const []const u8) !void {
    try testing.expectEqual(expected.len, actual.len);
    for (expected, actual) |e, a| try testing.expectEqualStrings(e, a);
}

fn relayerPhase(object: *js.Object, suffix: []const u8) []const u8 {
    for (object.get("relayers").array.items) |r| {
        if (std.mem.endsWith(u8, r.object.get("relayer").string, suffix)) return r.object.get("phase").string;
    }
    return "";
}

const empty_state = "\"tree_root\":null,\"modules\":[]";

fn snapshotEvent(buf: []u8, phase: []const u8) []const u8 {
    return std.fmt.bufPrint(buf, "{{\"type\":\"snapshot\",\"state\":{{\"phase\":\"{s}\"," ++ empty_state ++ "}}}}", .{phase}) catch unreachable;
}

fn updateEvent(buf: []u8, phase: []const u8) []const u8 {
    return std.fmt.bufPrint(buf, "{{\"type\":\"snapshot_update\",\"state\":{{\"phase\":\"{s}\"," ++ empty_state ++ ",\"removed_modules\":[]}}}}", .{phase}) catch unreachable;
}

test "orders snapshots and every history page numerically across an ID digit boundary" {
    var s: Session = undefined;
    try s.open(null);
    defer s.close();
    const first = 9_999_890;
    const last = 10_000_009;
    try s.exec(
        \\INSERT INTO message_activity
        \\SELECT id, decode($1, 'hex'), decode('02', 'hex'), 1, 2, now(), now(), 1,
        \\  jsonb_build_object('type', CASE WHEN id = $3 THEN 'delivered' ELSE 'dropped' END)
        \\FROM generate_series($2::bigint, $3::bigint) AS id
    , &.{ .{ .string = message_hex }, .{ .number = first }, .{ .number = last } });
    var expected: std.ArrayList([]const u8) = .empty;
    defer expected.deinit(testing.allocator);
    var n: u64 = last;
    while (n >= first) : (n -= 1) try expected.append(testing.allocator, try std.fmt.allocPrint(s.arena(), "{d}", .{n}));
    var history: std.ArrayList([]const u8) = .empty;
    defer history.deinit(testing.allocator);
    var scratch: std.ArrayList([]const u8) = .empty;
    defer scratch.deinit(testing.allocator);
    var before: ?[]const u8 = null;
    while (true) {
        const page = (try s.service.history(s.arena(), message_id, before, 7)).object;
        const page_ids = try ids(page, "activities", &scratch);
        const start = history.items.len;
        try expectIds(expected.items[start..@min(start + 7, expected.items.len)], page_ids);
        try history.appendSlice(testing.allocator, page_ids);
        try testing.expectEqual(history.items.len < expected.items.len, page.get("has_more").bool);
        if (!page.get("has_more").bool) {
            try testing.expect(page.get("next_before_id") == .null);
            break;
        }
        try testing.expectEqualStrings(history.items[history.items.len - 1], page.get("next_before_id").string);
        before = page.get("next_before_id").string;
    }
    try expectIds(expected.items, history.items);
    const snap = try s.snapshot();
    try testing.expect(snap.get("partial").bool);
    const newest = try testing.allocator.dupe([]const u8, expected.items[0..100]);
    defer testing.allocator.free(newest);
    std.mem.reverse([]const u8, newest);
    try expectIds(newest, try ids(snap, "activities", &scratch));
    try testing.expectEqualStrings("delivered", relayerPhase(snap, "02"));
}

test "selects the latest numeric snapshot update, resets anchors, and retains legacy reporters" {
    var s: Session = undefined;
    try s.open(null);
    defer s.close();
    var buf: [256]u8 = undefined;
    try s.insert(8, "02", snapshotEvent(&buf, "preparing"));
    try s.insert(9, "02", updateEvent(&buf, "awaiting_signatures"));
    try s.insert(10, "02", updateEvent(&buf, "delivered"));
    try s.insert(11, "03", "{\"type\":\"delivered\"}");
    var scratch: std.ArrayList([]const u8) = .empty;
    defer scratch.deinit(testing.allocator);
    const initial = try s.snapshot();
    try expectIds(&.{ "8", "10", "11" }, try ids(initial, "activities", &scratch));
    try testing.expectEqualStrings("delivered", relayerPhase(initial, "02"));
    try testing.expectEqualStrings("delivered", relayerPhase(initial, "03"));
    try s.insert(12, "02", snapshotEvent(&buf, "retrying"));
    try s.insert(13, "02", updateEvent(&buf, "ready_to_submit"));
    const reset = try s.snapshot();
    try expectIds(&.{ "11", "12", "13" }, try ids(reset, "activities", &scratch));
    try testing.expectEqualStrings("ready_to_submit", relayerPhase(reset, "02"));
}

test "reads a retained 10000-update history within the production statement timeout" {
    var s: Session = undefined;
    try s.open(4000);
    defer s.close();
    try s.exec("CREATE INDEX ON message_activity(message_id,id DESC)", &.{});
    try s.exec(
        \\INSERT INTO message_activity
        \\SELECT n,decode($1,'hex'),decode('02','hex'),1,2,now(),now(),1,
        \\  jsonb_build_object('type',CASE WHEN n=1 THEN 'snapshot' ELSE 'snapshot_update' END,
        \\    'state',jsonb_build_object('phase','preparing','tree_root',NULL,'modules','[]'::jsonb,'removed_modules','[]'::jsonb))
        \\FROM generate_series(1,10001) AS n
    , &.{.{ .string = message_hex }});
    try s.exec("ANALYZE message_activity", &.{});
    var scratch: std.ArrayList([]const u8) = .empty;
    defer scratch.deinit(testing.allocator);
    const result = try s.snapshot();
    try expectIds(&.{ "1", "10001" }, try ids(result, "activities", &scratch));
    try testing.expect(!result.get("partial").bool);
}

test "keeps anchored reporters complete when legacy history fills the row budget" {
    var s: Session = undefined;
    try s.open(null);
    defer s.close();
    try s.insert(1, "02",
        \\{"type":"snapshot","state":{"phase":"preparing","tree_root":"root","modules":[{"node_id":"root","ism":"root-ism","children":[]}]}}
    );
    try s.insert(103, "02",
        \\{"type":"snapshot_update","state":{"phase":"ready_to_submit","tree_root":"root","modules":[{"node_id":"root","ism":"root-ism","children":[],"verified":1}],"removed_modules":[]}}
    );
    try s.exec(
        \\INSERT INTO message_activity
        \\SELECT n,decode($1,'hex'),decode('03','hex'),1,2,now(),now(),1,
        \\  '{"type":"status","status":"FirstPrepareAttempt"}'::jsonb
        \\FROM generate_series(2,102) AS n
    , &.{.{ .string = message_hex }});
    var scratch: std.ArrayList([]const u8) = .empty;
    defer scratch.deinit(testing.allocator);
    const result = try s.snapshot();
    try testing.expect(result.get("partial").bool);
    const got = try ids(result, "activities", &scratch);
    try testing.expect(got.len <= 100);
    var has_1 = false;
    var has_103 = false;
    for (got) |id| {
        if (std.mem.eql(u8, id, "1")) has_1 = true;
        if (std.mem.eql(u8, id, "103")) has_103 = true;
    }
    try testing.expect(has_1 and has_103);
    for (result.get("relayers").array.items) |r| {
        if (!std.mem.endsWith(u8, r.object.get("relayer").string, "02")) continue;
        try testing.expectEqualStrings("ready_to_submit", r.object.get("phase").string);
        const module = r.object.get("modules").array.items[0].object;
        try testing.expectEqualStrings("root", module.get("node_id").string);
        try testing.expectEqual(@as(f64, 1), module.get("verified").number);
        return;
    }
    return error.MissingAnchoredReporter;
}

test "projects newer legacy events after the latest snapshot state on writer rollback" {
    var s: Session = undefined;
    try s.open(null);
    defer s.close();
    var buf: [256]u8 = undefined;
    var scratch: std.ArrayList([]const u8) = .empty;
    defer scratch.deinit(testing.allocator);
    try s.insert(7, "02", "{\"type\":\"delivered\"}"); // Superseded by the full anchor.
    try s.insert(8, "02", snapshotEvent(&buf, "preparing"));
    try s.insert(9, "02", updateEvent(&buf, "awaiting_signatures"));
    try s.insert(10, "02", "{\"type\":\"delivered\"}"); // A legacy writer resumes this reporter.
    const delivered = try s.snapshot();
    try expectIds(&.{ "8", "9", "10" }, try ids(delivered, "activities", &scratch));
    try testing.expectEqualStrings("delivered", relayerPhase(delivered, "02"));
    try s.insert(11, "02", snapshotEvent(&buf, "preparing"));
    try s.insert(12, "02", "{\"type\":\"status\",\"status\":\"ReadyToSubmit\"}");
    const ready = try s.snapshot();
    try expectIds(&.{ "11", "12" }, try ids(ready, "activities", &scratch));
    try testing.expectEqualStrings("ready_to_submit", relayerPhase(ready, "02"));
    try s.insert(13, "02", updateEvent(&buf, "confirming"));
    try s.insert(14, "02", "{\"type\":\"dropped\"}");
    const dropped = try s.snapshot();
    try expectIds(&.{ "11", "13", "14" }, try ids(dropped, "activities", &scratch));
    try testing.expectEqualStrings("dropped", relayerPhase(dropped, "02"));
}

test "listener forwards only non-empty message_activity_insert notifications" {
    @import("testing_log.zig").silence();
    const url = std.process.getEnvVarOwned(testing.allocator, "DIAGNOSTICS_TEST_DATABASE_URL") catch return error.SkipZigTest;
    defer testing.allocator.free(url);
    const diagnostics = try @import("open.zig").Diagnostics.open(testing.allocator, url);
    defer diagnostics.close();
    const Events = struct {
        mutex: std.Thread.Mutex = .{},
        payloads: usize = 0,
        last: [64]u8 = undefined,
        disconnects: usize = 0,
        fn notify(ctx: *anyopaque, payload: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.mutex.lock();
            defer self.mutex.unlock();
            self.payloads += 1;
            @memcpy(self.last[0..@min(64, payload.len)], payload[0..@min(64, payload.len)]);
        }
        fn disconnect(ctx: *anyopaque) void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.mutex.lock();
            defer self.mutex.unlock();
            self.disconnects += 1;
        }
        fn count(self: *@This()) usize {
            self.mutex.lock();
            defer self.mutex.unlock();
            return self.payloads;
        }
    };
    var events: Events = .{};
    const listen = diagnostics.service.listen.?;
    const listener = try listen.open(listen.ctx, .{ .ctx = &events, .notify = Events.notify, .disconnect = Events.disconnect });
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var conn = try db.pq.Conn.connect(.{ .conninfo = url }, arena_state.allocator(), null);
    defer conn.deinit();
    _ = try conn.query(arena_state.allocator(), "SELECT pg_notify('message_activity_insert', $1)", &.{.{ .string = message_hex }}, null);
    _ = try conn.query(arena_state.allocator(), "SELECT pg_notify('message_activity_insert', '')", &.{}, null);
    _ = try conn.query(arena_state.allocator(), "SELECT pg_notify('other_channel', 'x')", &.{}, null);
    var waited: usize = 0;
    while (events.count() == 0 and waited < 2000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
    std.Thread.sleep(50 * std.time.ns_per_ms);
    try testing.expectEqual(@as(usize, 1), events.count());
    try testing.expectEqualStrings(message_hex, &events.last);
    listener.stop(listener.ctx);
    try testing.expectEqual(@as(usize, 0), events.disconnects);
}

test "streams snapshots end to end from LISTEN wakeups through the pool" {
    @import("testing_log.zig").silence();
    const url = std.process.getEnvVarOwned(testing.allocator, "DIAGNOSTICS_TEST_DATABASE_URL") catch return error.SkipZigTest;
    defer testing.allocator.free(url);
    const stream_mod = @import("stream.zig");
    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var conn = try db.pq.Conn.connect(.{ .conninfo = url }, arena, null);
    defer conn.deinit();
    // A private schema: the pool and listener use separate sessions, so a temp table won't do.
    const schema = try std.fmt.allocPrint(arena, "diag_e2e_{d}", .{std.crypto.random.int(u32)});
    _ = try conn.query(arena, try std.fmt.allocPrint(arena, "CREATE SCHEMA {s}", .{schema}), &.{}, null);
    defer _ = conn.query(arena, std.fmt.allocPrint(arena, "DROP SCHEMA {s} CASCADE", .{schema}) catch unreachable, &.{}, null) catch {};
    const table = try std.fmt.allocPrint(arena, "{s}.message_activity", .{schema});
    _ = try conn.query(arena, try std.mem.replaceOwned(u8, arena, table_sql, "TEMP TABLE message_activity", try std.fmt.allocPrint(arena, "TABLE {s}", .{table})), &.{}, null);
    const insert_sql = try std.fmt.allocPrint(arena, "INSERT INTO {s} VALUES ($1,decode($2,'hex'),decode('02','hex'),1,2,now(),now(),1,$3)", .{table});
    _ = try conn.query(arena, insert_sql, &.{ .{ .number = 1 }, .{ .string = message_hex }, .{ .string = "{\"type\":\"metadata_started\",\"ism\":\"0xaa\"}" } }, null);

    const diagnostics = try @import("open.zig").Diagnostics.open(testing.allocator, url);
    defer diagnostics.close();
    diagnostics.service.table = table;
    const stream = try stream_mod.Stream.init(testing.allocator, &diagnostics.service);
    defer stream.deinit();
    const Frames = struct {
        mutex: std.Thread.Mutex = .{},
        list: std.ArrayList([]u8) = .empty,
        fn send(ctx: *anyopaque, frame: *stream_mod.Frame, done: stream_mod.Completion) bool {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.mutex.lock();
            self.list.append(testing.allocator, testing.allocator.dupe(u8, frame.bytes) catch unreachable) catch unreachable;
            self.mutex.unlock();
            done.complete(true);
            return true;
        }
        fn waitCount(self: *@This(), n: usize) !void {
            var waited: usize = 0;
            while (waited < 5000) : (waited += 1) {
                self.mutex.lock();
                const len = self.list.items.len;
                self.mutex.unlock();
                if (len >= n) return;
                std.Thread.sleep(std.time.ns_per_ms);
            }
            return error.Timeout;
        }
    };
    var frames: Frames = .{};
    defer {
        for (frames.list.items) |f| testing.allocator.free(f);
        frames.list.deinit(testing.allocator);
    }
    stream.start();
    const sub = try stream.subscribe("127.0.0.1", &.{message_id}, .{ .ctx = &frames, .send = Frames.send });
    defer {
        stream.stop();
        stream.unsubscribe(sub);
    }
    try frames.waitCount(1);
    // Wait for LISTEN before notifying (the listener connects asynchronously).
    var waited: usize = 0;
    while (waited < 5000) : (waited += 1) {
        stream.mutex.lock();
        const ready = stream.listener != null;
        stream.mutex.unlock();
        if (ready) break;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    _ = try conn.query(arena, insert_sql, &.{ .{ .number = 2 }, .{ .string = message_hex }, .{ .string = "{\"type\":\"delivered\"}" } }, null);
    _ = try conn.query(arena, "SELECT pg_notify('message_activity_insert', $1)", &.{.{ .string = message_hex }}, null);
    try frames.waitCount(2);
    frames.mutex.lock();
    defer frames.mutex.unlock();
    const last = frames.list.items[frames.list.items.len - 1];
    try testing.expect(std.mem.startsWith(u8, last, "{\"type\":\"diagnostics\",\"data\":{\"version\":1,\"message_id\":\"" ++ message_id ++ "\",\"partial\":false"));
    try testing.expect(std.mem.indexOf(u8, last, "\"phase\":\"delivered\"") != null);
}

test "converts real rows like node-pg (bytes from testdata/pg-oracle.ts)" {
    var s: Session = undefined;
    try s.open(null);
    defer s.close();
    try s.exec(
        \\INSERT INTO message_activity VALUES (5, decode($1,'hex'), decode('02','hex'),
        \\  9007199254740993, 2, '2026-11-05 00:00:00.123456+00', '2026-11-05 00:00:01+00', 1, $2::jsonb)
    , &.{
        .{ .string = message_hex }, .{ .string = 
        \\{"b": 1, "10": [1.0, "x", 1e21, -0.0, 0.1], "a": {"2": true, "1": null}, "type": "status", "status": "ReadyToSubmit", "__proto__": {"x": 1}}
        },
    });
    // The oracle session runs with the server default TimeZone (UTC in the docker image).
    const history = try s.service.history(s.arena(), message_id, null, 1);
    try testing.expectEqualStrings("{\"message_id\":\"0x0101010101010101010101010101010101010101010101010101010101010101\",\"activities\":[{\"id\":\"5\",\"message_id\":\"0x0101010101010101010101010101010101010101010101010101010101010101\",\"relayer\":\"0x02\",\"origin\":9007199254740992,\"destination\":2,\"observed_at\":\"2026-11-05 00:00:00.123456+00\",\"received_at\":\"2026-11-05 00:00:01+00\",\"version\":1,\"activity\":{\"10\":[1,\"x\",1e+21,0,0.1],\"a\":{\"1\":null,\"2\":true},\"b\":1,\"type\":\"status\",\"status\":\"ReadyToSubmit\"}}],\"has_more\":false,\"next_before_id\":null}", try js.stringifyAlloc(s.arena(), history));
    const snapshots = try s.service.snapshots(s.arena(), &.{message_id});
    try testing.expectEqualStrings("[{\"version\":1,\"message_id\":\"0x0101010101010101010101010101010101010101010101010101010101010101\",\"partial\":false,\"activities\":[{\"id\":\"5\",\"message_id\":\"0x0101010101010101010101010101010101010101010101010101010101010101\",\"relayer\":\"0x02\",\"origin\":9007199254740992,\"destination\":2,\"observed_at\":\"2026-11-05 00:00:00.123456+00\",\"received_at\":\"2026-11-05 00:00:01+00\",\"version\":1,\"activity\":{\"10\":[1,\"x\",1e+21,0,0.1],\"a\":{\"1\":null,\"2\":true},\"b\":1,\"type\":\"status\",\"status\":\"ReadyToSubmit\"}}],\"relayers\":[{\"relayer\":\"0x02\",\"phase\":\"ready_to_submit\",\"observed_at\":\"2026-11-05 00:00:00.123456+00\",\"modules\":[]}]}]", try js.stringifyAlloc(s.arena(), .{ .array = try js.newArray(s.arena(), snapshots) }));
}
