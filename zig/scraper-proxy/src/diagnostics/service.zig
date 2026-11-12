//! Port of `src/diagnostics/service.ts`: history pagination, snapshot row
//! selection and the activity row schema. Database access goes through `Db`
//! so tests can substitute fixtures exactly like the TypeScript tests do.
const std = @import("std");
const core = @import("core");
const Allocator = std.mem.Allocator;
const js = @import("js.zig");
const status = @import("status.zig");
const Value = js.Value;
const Object = js.Object;
pub const ActivityRow = status.ActivityRow;

const SNAPSHOT_LIMIT = 100;
pub const SNAPSHOT_BATCH_SIZE = 20;
pub const MESSAGE_ACTIVITY_CHANNEL = "message_activity_insert";
pub const MAX_HISTORY_LIMIT = 500;
const logger = core.log.child("Diagnostics");

pub const Error = error{
    /// Plain `Error('Expected a 32-byte message ID')` from parseMessageId.
    InvalidMessageId,
    /// GraphQLError `limit must be between 1 and 500`.
    InvalidLimit,
    /// GraphQLError `before_id must be a non-negative bigint string`.
    InvalidBeforeId,
    /// Plain `Error('Expected 1–20 message IDs')` (stream batches only).
    InvalidBatch,
    /// GraphQLError `Diagnostics temporarily unavailable`, code DIAGNOSTICS_UNAVAILABLE.
    Unavailable,
    OutOfMemory,
};

pub fn errorMessage(err: Error) []const u8 {
    return switch (err) {
        error.InvalidMessageId => "Expected a 32-byte message ID",
        error.InvalidLimit => std.fmt.comptimePrint("limit must be between 1 and {d}", .{MAX_HISTORY_LIMIT}),
        error.InvalidBeforeId => "before_id must be a non-negative bigint string",
        error.InvalidBatch => std.fmt.comptimePrint("Expected 1\u{2013}{d} message IDs", .{SNAPSHOT_BATCH_SIZE}),
        error.Unavailable => "Diagnostics temporarily unavailable",
        error.OutOfMemory => "Out of memory",
    };
}

/// `extensions.code` carried by the GraphQLError, if any.
pub fn errorCode(err: Error) ?[]const u8 {
    return if (err == error.Unavailable) "DIAGNOSTICS_UNAVAILABLE" else null;
}

/// True when TypeScript throws a GraphQLError (rather than a plain Error).
pub fn isGraphQLError(err: Error) bool {
    return switch (err) {
        error.InvalidLimit, error.InvalidBeforeId, error.Unavailable => true,
        else => false,
    };
}

/// Read-only query hook. Rows are objects converted like node-pg (int8 as
/// text, jsonb parsed with JSON.parse rules). Any error means unavailable.
pub const Db = struct {
    ctx: *anyopaque,
    query: *const fn (ctx: *anyopaque, arena: Allocator, sql: []const u8, params: []const ?[]const u8) anyerror![]const Value,
};

fn activityColumns(comptime alias: []const u8) []const u8 {
    const p = if (alias.len > 0) alias ++ "." else "";
    return p ++ "id::text, '0x' || encode(" ++ p ++ "message_id, 'hex') AS message_id,\n    '0x' || encode(" ++
        p ++ "relayer, 'hex') AS relayer, " ++ p ++ "origin, " ++ p ++ "destination,\n    " ++ p ++
        "observed_at::text, " ++ p ++ "received_at::text, " ++ p ++ "version, " ++ p ++ "activity";
}
const columns = activityColumns("");
const current_columns = activityColumns("current_activity");

pub const history_sql = "SELECT " ++ columns ++ " FROM public.message_activity\n" ++
    "       WHERE message_id = decode($1, 'hex') AND ($3::bigint IS NULL OR id < $3::bigint)\n" ++
    "       ORDER BY message_activity.id DESC LIMIT $2";

pub const snapshots_sql =
    \\SELECT activity.* FROM unnest($1::text[]) AS requested(message_hex)
    \\       CROSS JOIN LATERAL (
    \\         WITH anchors AS MATERIALIZED (
    \\           SELECT relayer, max(id) AS anchor_id FROM public.message_activity
    \\           WHERE message_id = decode(requested.message_hex, 'hex')
    \\             AND activity->>'type' = 'snapshot'
    \\           GROUP BY relayer
    \\         ), states AS MATERIALIZED (
    \\           SELECT anchors.*, coalesce(latest_update.id, anchors.anchor_id) AS state_id
    \\           FROM anchors LEFT JOIN LATERAL (
    \\             SELECT current_activity.id FROM public.message_activity AS current_activity
    \\             WHERE current_activity.message_id = decode(requested.message_hex, 'hex')
    \\               AND current_activity.relayer = anchors.relayer
    \\               AND current_activity.id > anchors.anchor_id
    \\               AND current_activity.activity->>'type' = 'snapshot_update'
    \\             ORDER BY current_activity.id DESC LIMIT 1
    \\           ) latest_update ON true
    \\         )
    \\         SELECT
++ " " ++ current_columns ++ " " ++
    \\FROM public.message_activity AS current_activity
    \\         JOIN states ON current_activity.id = states.anchor_id
    \\         UNION ALL
    \\         SELECT
++ " " ++ current_columns ++ " " ++
    \\FROM public.message_activity AS current_activity
    \\         JOIN states ON current_activity.id = states.state_id
    \\         WHERE states.state_id > states.anchor_id
    \\         UNION ALL
    \\         (SELECT
++ " " ++ current_columns ++ " " ++
    \\FROM public.message_activity AS current_activity
    \\          LEFT JOIN states ON states.relayer = current_activity.relayer
    \\          WHERE current_activity.message_id = decode(requested.message_hex, 'hex')
    \\            AND (states.relayer IS NULL OR current_activity.id > states.state_id)
    \\          ORDER BY current_activity.id DESC LIMIT $2)
    \\       ) activity ORDER BY activity.message_id, activity.id::bigint DESC
;

// ------------------------------------------------------------ message IDs

/// `displayAddress(parseMessageId(id))`: `/^(?:0x|\\x)?[\da-fA-F]{64}$/`, lowercased with 0x.
pub fn normalizeMessageId(arena: Allocator, id: []const u8) Error![]const u8 {
    var hex = id;
    if (std.mem.startsWith(u8, hex, "0x") or std.mem.startsWith(u8, hex, "\\x")) hex = hex[2..];
    if (hex.len != 64) return error.InvalidMessageId;
    const out = try arena.alloc(u8, 66);
    out[0] = '0';
    out[1] = 'x';
    for (hex, out[2..]) |c, *o| {
        if (!std.ascii.isHex(c)) return error.InvalidMessageId;
        o.* = std.ascii.toLower(c);
    }
    return out;
}

// ------------------------------------------------------------ row schema

fn isJsWhitespace(cp: u21) bool {
    return switch (cp) {
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF => true,
        0x2000...0x200A => true,
        else => false,
    };
}

fn trimJs(s: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = s.len;
    while (start < end) {
        const len = std.unicode.utf8ByteSequenceLength(s[start]) catch break;
        if (start + len > end) break;
        const cp = std.unicode.utf8Decode(s[start .. start + len]) catch break;
        if (!isJsWhitespace(cp)) break;
        start += len;
    }
    while (end > start) {
        var i = end - 1;
        while (i > start and (s[i] & 0xC0) == 0x80) i -= 1;
        const cp = std.unicode.utf8Decode(s[i..end]) catch break;
        if (!isJsWhitespace(cp)) break;
        end = i;
    }
    return s[start..end];
}

/// ECMAScript StringToNumber; NaN when the text is not a numeric literal.
fn stringToNumber(raw: []const u8) f64 {
    const s = trimJs(raw);
    const nan = std.math.nan(f64);
    if (s.len == 0) return 0;
    if (s.len > 2 and s[0] == '0') {
        const base: ?u8 = switch (s[1]) {
            'x', 'X' => 16,
            'o', 'O' => 8,
            'b', 'B' => 2,
            else => null,
        };
        if (base) |b| {
            var value: f64 = 0;
            for (s[2..]) |c| {
                const digit = std.fmt.charToDigit(c, b) catch return nan;
                value = value * @as(f64, @floatFromInt(b)) + @as(f64, @floatFromInt(digit));
            }
            return value;
        }
    }
    var body = s;
    var negative = false;
    if (body[0] == '+' or body[0] == '-') {
        negative = body[0] == '-';
        body = body[1..];
    }
    if (std.mem.eql(u8, body, "Infinity")) return if (negative) -std.math.inf(f64) else std.math.inf(f64);
    // [digits][.digits][(e|E)[+-]digits] with at least one mantissa digit.
    var i: usize = 0;
    var digits: usize = 0;
    while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) digits += 1;
    if (i < body.len and body[i] == '.') {
        i += 1;
        while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) digits += 1;
    }
    if (digits == 0) return nan;
    if (i < body.len and (body[i] == 'e' or body[i] == 'E')) {
        i += 1;
        if (i < body.len and (body[i] == '+' or body[i] == '-')) i += 1;
        const exponent_start = i;
        while (i < body.len and std.ascii.isDigit(body[i])) : (i += 1) {}
        if (i == exponent_start) return nan;
    }
    if (i != body.len) return nan;
    // Zig's parser needs a digit before '.'; the grammar above is otherwise compatible.
    var buf: [512]u8 = undefined;
    const text = if (body[0] == '.')
        std.fmt.bufPrint(&buf, "0{s}", .{body}) catch return nan
    else
        body;
    const value = std.fmt.parseFloat(f64, text) catch return nan;
    return if (negative) -value else value;
}

/// `Number(value)` for the JSON shapes node-pg returns. A one-element array
/// converts like its element (Array.prototype.toString); nested ones unwrap
/// in a loop, so depth costs no stack.
fn toNumber(value: Value) f64 {
    var current = value;
    while (true) switch (current) {
        .number => |n| return n,
        .string => |s| return stringToNumber(s),
        .null => return 0,
        .bool => |b| return if (b) 1 else 0,
        .undefined, .object => return std.math.nan(f64),
        .array => |a| switch (a.items.len) {
            0 => return 0,
            1 => switch (a.items[0]) {
                .null, .undefined => return 0,
                .bool => return std.math.nan(f64),
                else => |item| current = item,
            },
            else => return std.math.nan(f64),
        },
    };
}

fn coerceNumber(value: Value) error{Invalid}!Value {
    const n = toNumber(value);
    if (!std.math.isFinite(n)) return error.Invalid;
    return .{ .number = n };
}

fn isDigits(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |c| if (!std.ascii.isDigit(c)) return false;
    return true;
}

/// `activityRow.parse(row)`.
pub fn parseActivityRow(arena: Allocator, input: Value) status.Invalid!ActivityRow {
    if (input != .object) return error.Invalid;
    const in = input.object;
    const out = try js.newObject(arena);
    const id = in.get("id").str() orelse return error.Invalid;
    if (!isDigits(id)) return error.Invalid;
    try out.put(arena, "id", .{ .string = id });
    const message_id = in.get("message_id");
    if (message_id != .string) return error.Invalid;
    try out.put(arena, "message_id", message_id);
    const relayer = in.get("relayer").str() orelse return error.Invalid;
    try out.put(arena, "relayer", .{ .string = relayer });
    try out.put(arena, "origin", try coerceNumber(in.get("origin")));
    try out.put(arena, "destination", try coerceNumber(in.get("destination")));
    const observed_at = in.get("observed_at").str() orelse return error.Invalid;
    try out.put(arena, "observed_at", .{ .string = observed_at });
    const received_at = in.get("received_at");
    if (received_at != .string) return error.Invalid;
    try out.put(arena, "received_at", received_at);
    const version = in.get("version");
    if (version != .number or !std.math.isFinite(version.number)) return error.Invalid;
    try out.put(arena, "version", version);
    const activity = try status.validate(arena, .{ .record = &.unknown }, in.get("activity"));
    try out.put(arena, "activity", activity);
    return .{
        .object = out,
        .id = id,
        .relayer = relayer,
        .observed_at = observed_at,
        .version = version.number,
        .activity = activity.object,
    };
}

// ------------------------------------------------------------ selection

fn activityType(row: ActivityRow) Value {
    return row.activity.get("type");
}

fn isType(row: ActivityRow, kind: []const u8) bool {
    return js.strictEqual(activityType(row), .{ .string = kind });
}

/// `BigInt(a.id) < BigInt(b.id)` over `^\d+$` strings.
fn idLess(_: void, a: ActivityRow, b: ActivityRow) bool {
    const x = std.mem.trimLeft(u8, a.id, "0");
    const y = std.mem.trimLeft(u8, b.id, "0");
    if (x.len != y.len) return x.len < y.len;
    return std.mem.order(u8, x, y) == .lt;
}

/// Keep each selected reporter's snapshot baseline within the row budget.
pub fn snapshotActivities(arena: Allocator, rows: []const ActivityRow) Allocator.Error![]ActivityRow {
    const Baseline = struct { anchor: ?ActivityRow = null, update: ?ActivityRow = null };
    var snapshots: std.StringHashMapUnmanaged(Baseline) = .empty;
    var newest: std.StringHashMapUnmanaged(ActivityRow) = .empty;
    for (rows) |row| {
        const n = try newest.getOrPut(arena, row.relayer);
        if (!n.found_existing) n.value_ptr.* = row;
        const snapshot = isType(row, "snapshot");
        if (!snapshot and !isType(row, "snapshot_update")) continue;
        const state = try snapshots.getOrPut(arena, row.relayer);
        if (!state.found_existing) state.value_ptr.* = .{};
        if (snapshot and state.value_ptr.anchor == null) state.value_ptr.anchor = row;
        if (!snapshot and state.value_ptr.update == null) state.value_ptr.update = row;
    }
    var selected: std.StringArrayHashMapUnmanaged(ActivityRow) = .empty;
    var group: std.StringArrayHashMapUnmanaged(ActivityRow) = .empty;
    for (rows) |row| {
        const state: Baseline = snapshots.get(row.relayer) orelse .{};
        if (isType(row, "snapshot_update") and state.anchor == null) continue;
        group.clearRetainingCapacity();
        const candidates = [_]?ActivityRow{
            row,
            state.anchor,
            if (state.anchor != null) state.update else null,
            if (state.anchor != null) newest.get(row.relayer) else null,
        };
        for (candidates) |candidate| {
            const item = candidate orelse continue;
            if (selected.contains(item.id)) continue;
            const slot = try group.getOrPut(arena, item.id);
            slot.value_ptr.* = item;
        }
        if (selected.count() + group.count() > SNAPSHOT_LIMIT) continue;
        for (group.keys(), group.values()) |id, item| try selected.put(arena, id, item);
    }
    const out = try arena.dupe(ActivityRow, selected.values());
    std.mem.sort(ActivityRow, out, {}, idLess);
    return out;
}

fn rowsArray(arena: Allocator, rows: []const ActivityRow) Allocator.Error!Value {
    const array = try js.newArray(arena, &.{});
    try array.ensureTotalCapacity(arena, rows.len);
    for (rows) |row| array.appendAssumeCapacity(.{ .object = row.object });
    return .{ .array = array };
}

/// `{ version: 1, message_id, partial, activities, relayers }` for one ID's rows
/// (already filtered, newest first).
pub fn buildSnapshot(arena: Allocator, message_id: []const u8, matching: []const ActivityRow) Allocator.Error!Value {
    const activities = try snapshotActivities(arena, matching);
    const out = try js.newObject(arena);
    try out.put(arena, "version", .{ .number = 1 });
    try out.put(arena, "message_id", .{ .string = message_id });
    try out.put(arena, "partial", .{ .bool = matching.len > activities.len });
    try out.put(arena, "activities", try rowsArray(arena, activities));
    const relayers = try status.reduceStatus(arena, activities);
    try out.put(arena, "relayers", .{ .array = try js.newArray(arena, relayers) });
    return .{ .object = out };
}

// ------------------------------------------------------------ service

pub const Service = struct {
    db: Db,
    /// Present when a LISTEN connection can be opened (see listener.zig).
    listen: ?Listen = null,
    /// Tests point the production SQL at `pg_temp.message_activity`.
    table: []const u8 = "public.message_activity",

    pub const Listen = struct {
        ctx: *anyopaque,
        /// Opens a listener; `notify`/`disconnect` may be called from any thread.
        open: *const fn (ctx: *anyopaque, handler: Handler) anyerror!Listener,
    };
    pub const Handler = struct {
        ctx: *anyopaque,
        notify: *const fn (ctx: *anyopaque, payload: []const u8) void,
        disconnect: *const fn (ctx: *anyopaque) void,
    };
    /// `stop` closes the connection and returns only once no further
    /// handler callbacks can run.
    pub const Listener = struct {
        ctx: *anyopaque,
        stop: *const fn (ctx: *anyopaque) void,
    };

    /// `history(id, before, limit)` -> `{ message_id, activities, has_more, next_before_id }`.
    pub fn history(self: *const Service, arena: Allocator, id: []const u8, before: ?[]const u8, limit: i64) Error!Value {
        const normalized = try normalizeMessageId(arena, id);
        if (limit < 1 or limit > MAX_HISTORY_LIMIT) return error.InvalidLimit;
        if (before) |b| {
            if (!isDigits(b)) return error.InvalidBeforeId;
            const digits = std.mem.trimLeft(u8, b, "0");
            const max = "9223372036854775807";
            if (digits.len > max.len or (digits.len == max.len and std.mem.order(u8, digits, max) == .gt))
                return error.InvalidBeforeId;
        }
        const limit_plus_one = try std.fmt.allocPrint(arena, "{d}", .{limit + 1});
        const rows = try self.read(arena, history_sql, &.{ normalized[2..], limit_plus_one, before });
        const n: usize = @intCast(limit);
        const activities = rows[0..@min(rows.len, n)];
        const out = try js.newObject(arena);
        try out.put(arena, "message_id", .{ .string = normalized });
        try out.put(arena, "activities", try rowsArray(arena, activities));
        try out.put(arena, "has_more", .{ .bool = rows.len > n });
        try out.put(arena, "next_before_id", if (rows.len > n) .{ .string = activities[activities.len - 1].id } else .null);
        return .{ .object = out };
    }

    /// One `MessageDiagnostics` per distinct normalized ID, in request order.
    pub fn snapshots(self: *const Service, arena: Allocator, ids: []const []const u8) Error![]Value {
        if (ids.len == 0 or ids.len > SNAPSHOT_BATCH_SIZE) return error.InvalidBatch;
        var normalized: std.StringArrayHashMapUnmanaged(void) = .empty;
        for (ids) |id| try normalized.put(arena, try normalizeMessageId(arena, id), {});
        // node-pg array parameter: {"hex","hex"} (hex needs no escaping).
        var param: std.ArrayList(u8) = .empty;
        try param.append(arena, '{');
        for (normalized.keys(), 0..) |id, i| {
            if (i > 0) try param.append(arena, ',');
            try param.print(arena, "\"{s}\"", .{id[2..]});
        }
        try param.append(arena, '}');
        const limit = std.fmt.comptimePrint("{d}", .{SNAPSHOT_LIMIT + 1});
        const rows = try self.read(arena, snapshots_sql, &.{ param.items, limit });
        const out = try arena.alloc(Value, normalized.count());
        var matching: std.ArrayList(ActivityRow) = .empty;
        for (normalized.keys(), out) |id, *slot| {
            matching.clearRetainingCapacity();
            for (rows) |row| {
                if (std.mem.eql(u8, row.object.get("message_id").string, id)) try matching.append(arena, row);
            }
            slot.* = try buildSnapshot(arena, id, matching.items);
        }
        return out;
    }

    fn read(self: *const Service, arena: Allocator, comptime sql: []const u8, params: []const ?[]const u8) Error![]ActivityRow {
        const text = if (std.mem.eql(u8, self.table, "public.message_activity"))
            sql
        else
            try std.mem.replaceOwned(u8, arena, sql, "public.message_activity", self.table);
        const raw = self.db.query(self.db.ctx, arena, text, params) catch |err| {
            if (err == error.OutOfMemory) return error.OutOfMemory;
            return unavailable();
        };
        const rows = try arena.alloc(ActivityRow, raw.len);
        for (raw, rows) |value, *row| {
            row.* = parseActivityRow(arena, value) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.Invalid => return unavailable(),
            };
        }
        return rows;
    }

    fn unavailable() Error {
        // DB errors can contain connection details; neither responses nor logs expose them.
        logger.warn("Diagnostics database read failed", .{});
        return error.Unavailable;
    }
};
