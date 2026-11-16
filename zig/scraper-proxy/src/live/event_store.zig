//! Port of `event-store.ts`: database reads for live publication, live-start
//! boundaries and confirmation streams, plus row shaping. SQL text is byte-identical to TS
//! (asserted by event_store_test.zig against testdata/sql.json).
//!
//! Methods require the loop mutex; queries release it while blocking.
const std = @import("std");
const core = @import("core");
const scraperdb = @import("scraperdb");
const protocol = @import("protocol.zig");
const runtime = @import("runtime.zig");
const cs = @import("confirmation_stream.zig");
const frames = @import("frames.zig");

const json = core.json;
const Value = json.Value;
const Allocator = std.mem.Allocator;
const EventType = protocol.EventType;
const fail = runtime.fail;

pub const Row = Value;

/// Blocking query on the live pool (`DbService.queryLive`). On failure, record
/// the message with `runtime.fail` and return error.Failed.
pub const Db = struct {
    ctx: *anyopaque,
    query: *const fn (ctx: *anyopaque, arena: Allocator, sql: []const u8, params: []const Value) anyerror![]Value,
    /// Runs `query` without a live worker waiting (`-Dlive-fiber-queries`):
    /// `query.done(query)` follows on whatever thread finished it, never
    /// holding live's loop mutex and never inside this call.
    query_async: ?*const fn (ctx: *anyopaque, query: *AsyncQuery) void = null,
};

/// One `Db.query_async` read. The caller owns it (and `arena`, which holds
/// the parameters and receives the rows) until `done` has run.
pub const AsyncQuery = struct {
    arena: std.heap.ArenaAllocator,
    sql: []const u8 = "",
    params: []const Value = &.{},
    done: *const fn (query: *AsyncQuery) void,
    rows: []Value = &.{},
    err: ?anyerror = null,
    message: [256]u8 = undefined,
    message_len: usize = 0,
    /// For the caller (`done` finds its context through it).
    owner: *anyopaque = undefined,
    /// For the backend: the context and the blocking read it runs.
    backend: *anyopaque = undefined,
    run_query: *const fn (ctx: *anyopaque, arena: Allocator, sql: []const u8, params: []const Value) anyerror![]Value = undefined,
    job: runtime.Pool.Job = .{ .run = undefined },

    pub fn init(gpa: Allocator, done: *const fn (query: *AsyncQuery) void) AsyncQuery {
        return .{ .arena = .init(gpa), .done = done };
    }

    pub fn deinit(self: *AsyncQuery) void {
        self.arena.deinit();
    }

    /// Record a failure (its message is the finishing thread's).
    pub fn setFailure(self: *AsyncQuery, err: anyerror) void {
        self.err = err;
        const message = runtime.errorMessage(err);
        self.message_len = @min(message.len, self.message.len);
        @memcpy(self.message[0..self.message_len], message[0..self.message_len]);
    }

    /// The failure, with its message recorded on the calling thread.
    pub fn failure(self: *const AsyncQuery) ?anyerror {
        const err = self.err orelse return null;
        if (err != error.Failed) return err;
        return runtime.fail("{s}", .{self.message[0..self.message_len]});
    }
};

// ---------------------------------------------------------------------------
// Stream configuration

pub const Stream = struct {
    table: []const u8,
    domain: []const u8,
    columns: []const []const u8,
    /// Native sequence column (`eventMessage.sequence`).
    sequence: ?[]const u8 = null,
};

const raw_message_dispatch_columns = [_][]const u8{ "destination_domain", "id", "msg_body", "msg_id", "nonce", "origin_block_hash", "origin_block_height", "origin_domain", "origin_mailbox", "origin_tx_hash", "recipient", "sender", "time_created" };

pub fn stream(comptime event_type: EventType) Stream {
    return switch (event_type) {
        .dispatch => .{
            .table = "confirmed_raw_message_dispatch",
            .domain = "origin_domain",
            .columns = &raw_message_dispatch_columns,
            .sequence = "nonce",
        },
        .delivery => .{
            .table = "confirmed_delivered_message",
            .domain = "domain",
            .columns = &.{ "time_created", "msg_id", "domain", "destination_mailbox", "destination_tx_id", "sequence" },
        },
        .gas_payment => .{
            .table = "confirmed_gas_payment",
            .domain = "domain",
            .columns = &.{ "id", "time_created", "domain", "msg_id", "payment", "gas_amount", "tx_id", "log_index", "origin", "destination", "interchain_gas_paymaster", "sequence" },
        },
        .merkle_tree_insertion => .{
            .table = "confirmed_merkle_tree_insertion",
            .domain = "domain",
            .columns = &.{ "domain", "merkle_tree_hook", "leaf_index", "message_id", "block_number" },
            .sequence = "leaf_index",
        },
    };
}

pub fn domainColumn(event_type: EventType) []const u8 {
    return switch (event_type) {
        inline else => |tag| comptime stream(tag).domain,
    };
}

fn eventDomainColumns(event_type: EventType) []const []const u8 {
    return switch (event_type) {
        .delivery => &.{"domain"},
        .dispatch => &.{ "origin_domain", "destination_domain" },
        .gas_payment => &.{ "domain", "origin", "destination" },
        .merkle_tree_insertion => &.{"domain"},
    };
}

const GAS_PAYMENT_TRANSACTION = "event_transaction";
const GAS_PAYMENT_BLOCK = "event_block";
pub const FRONTIER_ID = "frontier_id";
pub const FRONTIER_HEIGHT = "frontier_height";
const MAX_PROVISIONAL_MESSAGE_CACHE_ENTRIES = 128;

// ---------------------------------------------------------------------------
// SQL (comptime, mirrors the TS template literals)

fn q(comptime identifier: []const u8) []const u8 {
    return "\"" ++ identifier ++ "\"";
}

fn join(comptime parts: []const []const u8, comptime separator: []const u8) []const u8 {
    comptime var out: []const u8 = "";
    inline for (parts, 0..) |part, index| out = out ++ (if (index > 0) separator else "") ++ part;
    return out;
}

fn columns(comptime s: Stream, comptime relation: ?[]const u8) []const u8 {
    comptime var parts: [s.columns.len][]const u8 = undefined;
    inline for (s.columns, 0..) |column, index|
        parts[index] = if (relation) |r| q(r) ++ "." ++ q(column) else q(column);
    return join(&parts, ", ");
}

pub fn gasPaymentColumns(comptime s: Stream) []const u8 {
    return columns(s, "event_row") ++ ", " ++
        "COALESCE(\"event_row\".\"transaction_hash\", " ++ q(GAS_PAYMENT_TRANSACTION) ++ ".\"hash\") AS \"origin_tx_hash\", " ++
        "COALESCE(\"event_row\".\"block_hash\", " ++ q(GAS_PAYMENT_BLOCK) ++ ".\"hash\") AS \"origin_block_hash\", " ++
        "COALESCE(\"event_row\".\"block_number\", " ++ q(GAS_PAYMENT_BLOCK) ++ ".\"height\") AS \"origin_block_height\"";
}

pub const gas_payment_metadata_joins = " LEFT JOIN \"transaction\" AS " ++ q(GAS_PAYMENT_TRANSACTION) ++ " ON " ++
    q(GAS_PAYMENT_TRANSACTION) ++ ".\"id\" = \"event_row\".\"tx_id\" LEFT JOIN \"block\" AS " ++ q(GAS_PAYMENT_BLOCK) ++
    " ON " ++ q(GAS_PAYMENT_BLOCK) ++ ".\"id\" = " ++ q(GAS_PAYMENT_TRANSACTION) ++ ".\"block_id\"";

const QueryParts = struct { projection: []const u8, joins: []const u8 };

fn eventQueryParts(comptime event_type: EventType) QueryParts {
    const s = stream(event_type);
    if (event_type != .gas_payment) return .{ .projection = columns(s, "event_row"), .joins = "" };
    return .{ .projection = gasPaymentColumns(s), .joins = gas_payment_metadata_joins };
}

fn heightColumn(comptime event_type: EventType) []const u8 {
    return if (event_type == .dispatch) "origin_block_height" else "block_number";
}

fn Sql(comptime event_type: EventType) type {
    const s = stream(event_type);
    const height = heightColumn(event_type);
    return struct {
        const notified = blk: {
            const parts = eventQueryParts(event_type);
            break :blk "SELECT \"event_row\".\"id\" AS \"notification_id\", " ++ parts.projection ++ " FROM " ++ q(s.table) ++
                " AS \"event_row\"" ++ parts.joins ++ " WHERE \"event_row\".\"id\" = ANY($1::bigint[]) ORDER BY \"event_row\".\"id\" ASC";
        };
        const head_events = blk: {
            const parts = eventQueryParts(event_type);
            const fh = "\"frontier_row\"." ++ q(height);
            break :blk "SELECT " ++ parts.projection ++ ", \"event_row\".\"id\" AS " ++ q(FRONTIER_ID) ++ ", \"event_row\"." ++ q(height) ++
                " AS " ++ q(FRONTIER_HEIGHT) ++ " FROM (SELECT * FROM " ++ q(s.table) ++ " AS \"frontier_row\" WHERE \"frontier_row\"." ++
                q(s.domain) ++ "=$1 AND " ++ fh ++ ">$2::bigint AND " ++ fh ++ "<=$3::bigint AND (" ++ fh ++ ">$4::bigint OR (" ++ fh ++
                "=$4::bigint AND \"frontier_row\".\"id\">$5::bigint)) ORDER BY " ++ fh ++ ", \"frontier_row\".\"id\" LIMIT $6) AS \"event_row\"" ++
                parts.joins ++ " ORDER BY \"event_row\"." ++ q(height) ++ ", \"event_row\".\"id\"";
        };
        const confirmation_events = blk: {
            const parts = eventQueryParts(event_type);
            const table = s.table["confirmed_".len..];
            const block_hash = if (event_type == .merkle_tree_insertion) ", event_row.block_hash" else "";
            break :blk "/* confirmation_events */ SELECT " ++ parts.projection ++ block_hash ++ ", event_row.id AS frontier_id, event_row." ++
                q(height) ++ " AS frontier_height\n         FROM (SELECT * FROM " ++ q(table) ++ " WHERE " ++ q(s.domain) ++ "=$1" ++
                "\n           AND (" ++ q(height) ++ ", id)>($2::bigint,$3::bigint) AND " ++ q(height) ++
                "<=$4::bigint\n           ORDER BY " ++ q(height) ++ ", id LIMIT $5) event_row" ++ parts.joins ++
                "\n         ORDER BY event_row." ++ q(height) ++ ", event_row.id";
        };
    };
}

const canonical_message_columns = blk: {
    const all = scraperdb.tables.Table.message_view.spec().columns;
    var out: []const u8 = "";
    var first = true;
    for (all) |column| {
        if (std.mem.eql(u8, column, "is_provisional")) continue;
        out = out ++ (if (first) "" else ", ") ++ "\"" ++ column ++ "\"";
        first = false;
    }
    break :blk out;
};

pub const sql = struct {
    pub const block_heads = "SELECT domain, indexed_height, encode(indexed_hash, 'hex') AS hash, head_height\n       FROM scraper_head";
    pub const block_heads_filtered = block_heads ++ " WHERE domain=ANY($1::integer[])";
    pub const canonical_messages = "SELECT " ++ canonical_message_columns ++
        " FROM \"message_view\" WHERE \"msg_id\" = ANY($1::bytea[]) AND \"send_occurred_at\" IS NOT NULL";
    pub const confirmation_heads = "SELECT domain, head_height, indexed_height, confirmed_height FROM scraper_head WHERE domain=ANY($1::integer[])";
    const live_start_columns = "encode(c.hash, 'hex') AS hash,\n  encode(h.mailbox, 'hex') AS mailbox,\n  encode(h.merkle_tree_hook, 'hex') AS merkle_tree_hook,\n  encode(h.interchain_gas_paymaster, 'hex') AS interchain_gas_paymaster";
    /// `confirmationHeads(domains, confirmations)`: the last retained
    /// checkpoint at or below each domain's confirmation frontier.
    pub const confirmation_heads_live_start = "SELECT h.domain, h.head_height, h.indexed_height, h.confirmed_height,\n                  c.height::text AS height, " ++
        live_start_columns ++ "\n           FROM scraper_head h LEFT JOIN LATERAL (\n             SELECT height, hash FROM scraper_checkpoint\n" ++
        "             WHERE domain=h.domain AND height<=LEAST(h.indexed_height,h.head_height-$2::bigint)\n             ORDER BY height DESC LIMIT 1\n" ++
        "           ) c ON h.healthy AND NOT h.halted\n           WHERE h.domain=ANY($1::integer[])";
    const live_start_boundaries_prefix = "SELECT h.domain, c.height::text AS height, " ++ live_start_columns ++
        "\n       FROM scraper_head h JOIN scraper_checkpoint c\n         ON c.domain=h.domain AND c.height=h.confirmed_height\n       WHERE h.healthy AND NOT h.halted\n         ";
    pub const live_start_boundaries = live_start_boundaries_prefix;
    pub const live_start_boundaries_filtered = live_start_boundaries_prefix ++ "AND h.domain=ANY($1::integer[])";
    pub fn confirmationMessages(comptime filter: bool) []const u8 {
        const f = if (filter) " AND msg_id = ANY($7::bytea[])" else "";
        return "/* confirmation_messages */ SELECT * FROM (\n" ++
            "          SELECT origin_block_height AS height, 0 AS source, id, msg_id FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_block_height>=$2::bigint AND origin_block_height<=$5::bigint" ++ f ++ "\n" ++
            "          UNION ALL SELECT block_number, 1, id, msg_id FROM delivered_message WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint" ++ f ++ "\n" ++
            "          UNION ALL SELECT block_number, 2, id, msg_id FROM gas_payment WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint" ++ f ++ "\n" ++
            "        ) changes WHERE (height, source, id)>($2::bigint,$3::integer,$4::bigint) ORDER BY height, source, id LIMIT $6";
    }
    pub fn notifiedEvents(event_type: EventType) []const u8 {
        return switch (event_type) {
            inline else => |tag| Sql(tag).notified,
        };
    }
    pub fn headEvents(event_type: EventType) []const u8 {
        return switch (event_type) {
            inline else => |tag| Sql(tag).head_events,
        };
    }
    pub fn confirmationEvents(event_type: EventType) []const u8 {
        return switch (event_type) {
            inline else => |tag| Sql(tag).confirmation_events,
        };
    }
};

// ---------------------------------------------------------------------------
// Row helpers

pub fn storedDomainValue(domain: u32) Value {
    return json.int(protocol.storedDomain(domain));
}

fn bigText(arena: Allocator, value: i128) Allocator.Error!Value {
    return .{ .string = try std.fmt.allocPrint(arena, "{d}", .{value}) };
}

/// `parseInteger(value, min)` over a row value (number or decimal string).
pub fn rowInteger(value: ?Value, comptime min: comptime_int) ?i128 {
    const present = value orelse return null;
    switch (present) {
        .number => |number| {
            if (!protocol.isSafeInteger(number) or number < min) return null;
            return @intFromFloat(number);
        },
        .string, .raw => |text| {
            if (min < 0 and std.mem.eql(u8, text, "-1")) return -1;
            return protocol.parseIdText(text);
        },
        else => return null,
    }
}

pub fn parseId(value: ?Value) error{Failed}!i128 {
    return rowInteger(value, 0) orelse fail("id must be a non-negative integer string", .{});
}

pub fn rowDomain(row: Value, column: []const u8) error{Failed}!u32 {
    var diag: protocol.Diag = .{};
    return protocol.parseDatabaseDomain(row.get(column), "", &diag) catch
        fail("Invalid {s} in event row", .{column});
}

fn rowDomains(arena: Allocator, row: Value, column: []const u8, out: *std.ArrayList(u32)) !void {
    const values = row.get(column) orelse return;
    if (values == .null) return;
    if (values != .array) return fail("Invalid {s} in event row", .{column});
    for (values.array) |item| {
        var diag: protocol.Diag = .{};
        const domain = protocol.parseDatabaseDomain(item, "", &diag) catch return fail("Invalid {s} in event row", .{column});
        try out.append(arena, domain);
    }
}

/// Copy of `row` without `keys` (object rest destructuring).
pub fn without(arena: Allocator, row: Value, keys: []const []const u8) Allocator.Error!Value {
    var members: std.ArrayList(json.Member) = try .initCapacity(arena, row.object.len);
    for (row.object) |member| {
        if (protocol.containsString(keys, member.key)) continue;
        members.appendAssumeCapacity(member);
    }
    return .{ .object = members.items };
}

/// `{ ...row, [key]: value }`: replace in place, else append.
fn setMember(arena: Allocator, row: *Value, key: []const u8, value: Value) Allocator.Error!void {
    if (row.getPtr(key)) |slot| {
        slot.* = value;
        return;
    }
    const members = try arena.alloc(json.Member, row.object.len + 1);
    @memcpy(members[0..row.object.len], row.object);
    members[row.object.len] = .{ .key = key, .value = value };
    row.* = .{ .object = members };
}

/// `eventData`: normalize stored domains (`{ ...data, [column]: domain }`).
pub fn eventData(arena: Allocator, event_type: EventType, row: Value) !Value {
    var data = try without(arena, row, &.{});
    for (eventDomainColumns(event_type)) |column| {
        const domain = try rowDomain(data, column);
        const current = data.get(column).?;
        if (current != .number or current.number != @as(f64, @floatFromInt(domain)))
            try setMember(arena, &data, column, json.int(domain));
    }
    return data;
}

/// `rowSequence`: the native sequence (dispatch nonce, Merkle leaf index).
fn rowSequence(event_type: EventType, row: Value) !?i128 {
    const column = switch (event_type) {
        inline else => |tag| comptime stream(tag).sequence,
    } orelse return null;
    return try parseId(row.get(column));
}

/// Write `eventMessage(eventType, row)`'s members into `o`:
/// `type, eventType, domain, data, sequence?, rowId?`.
pub fn eventMessageMembers(o: *frames.Object, arena: Allocator, event_type: EventType, row: Value) !void {
    const domain = try rowDomain(row, domainColumn(event_type));
    const data = try eventData(arena, event_type, row);
    const sequence = try rowSequence(event_type, row);
    const row_id: ?i128 = if (event_type == .gas_payment) try parseId(row.get("id")) else null;
    try o.string("type", "event");
    try o.string("eventType", event_type.name());
    try o.int("domain", domain);
    try o.val("data", data);
    try o.optBigString("sequence", sequence);
    try o.optBigString("rowId", row_id);
}

/// `serialize(eventMessage(eventType, row))`.
pub fn eventMessage(arena: Allocator, event_type: EventType, row: Value) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(arena);
    var o = try frames.Object.begin(&out.writer);
    try eventMessageMembers(&o, arena, event_type, row);
    try o.end();
    return out.written();
}

/// `rows.sort((a, b) => compareRows(eventType, a, b))`: a stable sort by row
/// id (gas payments) or native sequence; delivery rows compare equal. The
/// comparator throws on a row without a valid key; V8 calls it for every
/// element once there are two.
pub fn sortRows(arena: Allocator, event_type: EventType, rows: []Value) !void {
    if (rows.len < 2 or event_type == .delivery) return;
    const Keyed = struct { key: i128, row: Value };
    const keyed = try arena.alloc(Keyed, rows.len);
    for (rows, keyed) |row, *entry| entry.* = .{
        .key = if (event_type == .gas_payment) try parseId(row.get("id")) else (try rowSequence(event_type, row)).?,
        .row = row,
    };
    std.mem.sort(Keyed, keyed, {}, struct {
        fn lessThan(_: void, a: Keyed, b: Keyed) bool {
            return a.key < b.key;
        }
    }.lessThan);
    for (rows, keyed) |*row, entry| row.* = entry.row;
}

/// Deep copy of a row value. Iterative (an explicit stack in the arena):
/// database JSON can nest as deep as its size allows.
pub fn clone(a: Allocator, value: Value) Allocator.Error!Value {
    const Work = struct { source: Value, dest: *Value };
    var root: Value = undefined;
    var stack: std.ArrayList(Work) = .empty;
    try stack.append(a, .{ .source = value, .dest = &root });
    while (stack.pop()) |work| {
        work.dest.* = switch (work.source) {
            .null, .bool, .number => work.source,
            .raw => |text| .{ .raw = try a.dupe(u8, text) },
            .string => |text| .{ .string = try a.dupe(u8, text) },
            .array => |items| blk: {
                const out = try a.alloc(Value, items.len);
                for (items, out) |item, *dest| try stack.append(a, .{ .source = item, .dest = dest });
                break :blk .{ .array = out };
            },
            .object => |members| blk: {
                const out = try a.alloc(json.Member, members.len);
                for (members, out) |member, *dest| {
                    dest.key = try a.dupe(u8, member.key);
                    try stack.append(a, .{ .source = member.value, .dest = &dest.value });
                }
                break :blk .{ .object = out };
            },
        };
    }
    return root;
}

/// `liveStartBoundary(row)`: null unless the row carries a 32-byte hash, a
/// decimal height and contract addresses of 20 or 32 bytes.
pub fn liveStartBoundary(row: Value) ?protocol.LiveStartBoundary {
    var boundary: protocol.LiveStartBoundary = .{};
    const hash = row.get("hash") orelse return null;
    if (hash != .string or hash.string.len != 64) return null;
    for (hash.string) |char| if (!std.ascii.isHex(char)) return null;
    boundary.hash_buf[0] = '0';
    boundary.hash_buf[1] = 'x';
    for (hash.string, boundary.hash_buf[2..]) |char, *dest| dest.* = std.ascii.toLower(char);
    const height = row.get("height") orelse return null;
    if (height != .string or !protocol.isDigits(height.string)) return null;
    for ([_][]const u8{ "mailbox", "merkle_tree_hook", "interchain_gas_paymaster" }) |column| {
        const value = row.get(column) orelse return null;
        if (value != .string) return null;
    }
    for ([_][]const u8{ "mailbox", "merkle_tree_hook", "interchain_gas_paymaster" }, 0..) |column, index| {
        // displayAddress, then /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/.
        const text = row.get(column).?.string;
        const body = if (std.mem.startsWith(u8, text, "0x") or std.mem.startsWith(u8, text, "\\x")) text[2..] else text;
        if (body.len != 40 and body.len != 64) return null;
        const dest = &boundary.address_buf[index];
        dest[0] = '0';
        dest[1] = 'x';
        for (body, dest[2..][0..body.len]) |char, *out| {
            const lower = std.ascii.toLower(char);
            if (!std.ascii.isDigit(lower) and (lower < 'a' or lower > 'f')) return null;
            out.* = lower;
        }
        boundary.address_len[index] = @intCast(body.len + 2);
    }
    // `parseId(row.height).toString()`: canonical decimal. A bigint column
    // never exceeds 19 digits.
    const trimmed = std.mem.trimLeft(u8, height.string, "0");
    const digits = if (trimmed.len == 0) "0" else trimmed;
    if (digits.len > boundary.height_buf.len) return null;
    @memcpy(boundary.height_buf[0..digits.len], digits);
    boundary.height_len = @intCast(digits.len);
    return boundary;
}

// ---------------------------------------------------------------------------
// Store

pub const ProvisionalMessage = struct {
    data: Value,
    domains: []const u32,
    msg_id: ?[]const u8,
};

/// Shared result of one provisional query (the TS cached Promise).
pub const Provisional = struct {
    refs: usize,
    state: enum { pending, ok, failed } = .pending,
    arena: std.heap.ArenaAllocator,
    messages: []ProvisionalMessage = &.{},
    key: []u8,
    message: [256]u8 = undefined,
    message_len: usize = 0,
    ready: std.Thread.Condition = .{},

    pub fn find(self: *const Provisional, msg_id: []const u8) ?*const ProvisionalMessage {
        // `new Map(rows.map(...))`: the last row for an id wins.
        var index = self.messages.len;
        while (index > 0) {
            index -= 1;
            const message = &self.messages[index];
            if (message.msg_id) |id| if (std.mem.eql(u8, id, msg_id)) return message;
        }
        return null;
    }
};

pub const HeadRow = struct { domain: u32, head: Value, indexed: Value, hash: Value };

pub const EventStore = struct {
    allocator: Allocator,
    loop: *runtime.Loop,
    db: Db,
    batch_size: u64,
    cache: std.StringArrayHashMapUnmanaged(*Provisional) = .empty,

    pub fn init(allocator: Allocator, loop: *runtime.Loop, db: Db, batch_size: u64) EventStore {
        return .{ .allocator = allocator, .loop = loop, .db = db, .batch_size = batch_size };
    }

    pub fn deinit(self: *EventStore) void {
        self.invalidateMessages();
        self.cache.deinit(self.allocator);
    }

    /// `await db.queryLive(...)`.
    pub fn query(self: *EventStore, arena: Allocator, text: []const u8, params: []const Value) ![]Value {
        runtime.assertMayBlock();
        self.loop.unlock();
        defer self.loop.lock();
        return self.db.query(self.db.ctx, arena, text, params);
    }

    fn batch(self: *const EventStore) Value {
        return json.int(self.batch_size);
    }

    fn domainArray(arena: Allocator, domains: []const u32) Allocator.Error!Value {
        const values = try arena.alloc(Value, domains.len);
        for (domains, values) |domain, *value| value.* = storedDomainValue(domain);
        return .{ .array = values };
    }

    fn stringArray(arena: Allocator, items: []const []const u8) Allocator.Error!Value {
        const values = try arena.alloc(Value, items.len);
        for (items, values) |item, *value| value.* = .{ .string = item };
        return .{ .array = values };
    }

    pub fn blockHeads(self: *EventStore, arena: Allocator, domains: ?[]const u32) ![]Value {
        if (domains) |list| return self.query(arena, sql.block_heads_filtered, &.{try domainArray(arena, list)});
        return self.query(arena, sql.block_heads, &.{});
    }

    pub fn canonicalMessages(self: *EventStore, arena: Allocator, ids: []const []const u8) ![]Value {
        return self.query(arena, sql.canonical_messages, &.{try stringArray(arena, ids)});
    }

    pub fn notifiedEvents(self: *EventStore, arena: Allocator, event_type: EventType, ids: []const []const u8) ![]Value {
        return self.query(arena, sql.notifiedEvents(event_type), &.{try stringArray(arena, ids)});
    }

    /// `liveStartBoundaries(domains?)`: every healthy domain's confirmed
    /// checkpoint, in row order (no ORDER BY). Malformed rows are skipped.
    pub fn liveStartBoundaries(self: *EventStore, domains: ?[]const u32) !Boundaries {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const statement = try liveStartBoundariesQuery(arena.allocator(), domains);
        return self.parseLiveStartBoundaries(try self.query(arena.allocator(), statement.sql, statement.params));
    }

    pub const Boundaries = std.AutoArrayHashMapUnmanaged(u32, protocol.LiveStartBoundary);

    /// `liveStartBoundaries`' statement (parameters in `arena`).
    pub fn liveStartBoundariesQuery(arena: Allocator, domains: ?[]const u32) Allocator.Error!Statement {
        if (domains) |list| return .{ .sql = sql.live_start_boundaries_filtered, .params = try arena.dupe(Value, &.{try domainArray(arena, list)}) };
        return .{ .sql = sql.live_start_boundaries, .params = &.{} };
    }

    /// `liveStartBoundaries`' rows → boundaries (allocated with the store's allocator).
    pub fn parseLiveStartBoundaries(self: *EventStore, rows: []const Value) !Boundaries {
        var boundaries: Boundaries = .empty;
        errdefer boundaries.deinit(self.allocator);
        for (rows) |row| {
            const boundary = liveStartBoundary(row) orelse continue;
            var diag: protocol.Diag = .{};
            const domain = protocol.parseDatabaseDomain(row.get("domain"), "", &diag) catch return fail("Invalid live-start domain", .{});
            try boundaries.put(self.allocator, domain, boundary);
        }
        return boundaries;
    }

    /// `confirmationHeads(domains, confirmations?)`. With confirmations, each
    /// head carries the live start of its custom stream.
    pub fn confirmationHeads(self: *EventStore, allocator: Allocator, domains: []const u32, confirmations: ?u64) !cs.Heads {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const statement = try confirmationHeadsQuery(arena.allocator(), domains, confirmations);
        return parseConfirmationHeads(allocator, try self.query(arena.allocator(), statement.sql, statement.params));
    }

    /// `confirmationHeads`' statement (parameters in `arena`).
    pub fn confirmationHeadsQuery(arena: Allocator, domains: []const u32, confirmations: ?u64) Allocator.Error!Statement {
        if (confirmations) |count|
            return .{ .sql = sql.confirmation_heads_live_start, .params = try arena.dupe(Value, &.{ try domainArray(arena, domains), json.int(count) }) };
        return .{ .sql = sql.confirmation_heads, .params = try arena.dupe(Value, &.{try domainArray(arena, domains)}) };
    }

    pub const Statement = struct { sql: []const u8, params: []const Value };

    /// `blockHeads`' statement (parameters in `arena`).
    pub fn blockHeadsQuery(arena: Allocator, domains: ?[]const u32) Allocator.Error!Statement {
        if (domains) |list| return .{ .sql = sql.block_heads_filtered, .params = try arena.dupe(Value, &.{try domainArray(arena, list)}) };
        return .{ .sql = sql.block_heads, .params = &.{} };
    }

    /// `confirmationHeads`' rows → heads (allocated with `allocator`).
    pub fn parseConfirmationHeads(allocator: Allocator, rows: []const Value) !cs.Heads {
        var heads: cs.Heads = .empty;
        errdefer heads.deinit(allocator);
        for (rows) |row| {
            var diag: protocol.Diag = .{};
            const domain = protocol.parseDatabaseDomain(row.get("domain"), "", &diag) catch return fail("Invalid head domain", .{});
            // `new Map(rows.map(...))`: a later duplicate replaces the value in place.
            try heads.put(allocator, domain, .{
                .head = try parseId(row.get("head_height")),
                .indexed = try parseId(row.get("indexed_height")),
                .confirmed = try parseId(row.get("confirmed_height")),
                .live_start = liveStartBoundary(row),
            });
        }
        return heads;
    }

    pub fn invalidateMessages(self: *EventStore) void {
        for (self.cache.values()) |entry| self.releaseProvisional(entry);
        self.cache.clearRetainingCapacity();
    }

    pub fn releaseProvisional(self: *EventStore, entry: *Provisional) void {
        entry.refs -= 1;
        if (entry.refs > 0) return;
        self.allocator.free(entry.key);
        entry.arena.deinit();
        self.allocator.destroy(entry);
    }

    /// Shared, cached provisional-message read; release the result with
    /// `releaseProvisional`.
    pub fn provisionalMessages(self: *EventStore, ids: []const []const u8, frontiers: *const cs.Frontiers) !*Provisional {
        var scratch = std.heap.ArenaAllocator.init(self.allocator);
        defer scratch.deinit();
        const a = scratch.allocator();
        var unique: std.ArrayList([]const u8) = .empty;
        for (ids) |id| if (!protocol.containsString(unique.items, id)) try unique.append(a, id);
        std.mem.sort([]const u8, unique.items, {}, struct {
            fn lessThan(_: void, x: []const u8, y: []const u8) bool {
                return std.mem.lessThan(u8, x, y);
            }
        }.lessThan);
        const Pair = struct { domain: u32, height: i128 };
        const pairs = try a.alloc(Pair, frontiers.count());
        for (frontiers.keys(), frontiers.values(), pairs) |domain, height, *pair| pair.* = .{ .domain = domain, .height = height };
        std.mem.sort(Pair, pairs, {}, struct {
            fn lessThan(_: void, x: Pair, y: Pair) bool {
                return x.domain < y.domain;
            }
        }.lessThan);
        var key: std.Io.Writer.Allocating = .init(self.allocator);
        defer key.deinit();
        try key.writer.writeAll("[");
        frames.writeStrings(&key.writer, unique.items) catch return error.OutOfMemory;
        try key.writer.writeAll(",[");
        for (pairs, 0..) |pair, index| try key.writer.print("{s}[{d},\"{d}\"]", .{ if (index > 0) "," else "", pair.domain, pair.height });
        try key.writer.writeAll("]]");

        if (self.cache.get(key.written())) |cached| {
            cached.refs += 1;
            return self.awaitProvisional(cached);
        }
        // Entries survive only until the next head/message change, with a hard bound.
        if (self.cache.count() >= MAX_PROVISIONAL_MESSAGE_CACHE_ENTRIES) self.invalidateMessages();
        const entry = try self.allocator.create(Provisional);
        entry.* = .{ .refs = 2, .arena = .init(self.allocator), .key = try key.toOwnedSlice() };
        try self.cache.put(self.allocator, entry.key, entry);

        const domains = try a.alloc(Value, pairs.len);
        const heights = try a.alloc(Value, pairs.len);
        for (pairs, domains, heights) |pair, *domain, *height| {
            domain.* = storedDomainValue(pair.domain);
            height.* = try bigText(a, pair.height);
        }
        const params = [_]Value{ try stringArray(a, unique.items), .{ .array = domains }, .{ .array = heights } };
        const result = self.query(entry.arena.allocator(), scraperdb.provisional.PROVISIONAL_MESSAGE_QUERY, &params);
        if (result) |rows| {
            if (shapeProvisional(entry.arena.allocator(), rows)) |messages| {
                entry.messages = messages;
                entry.state = .ok;
            } else |err| self.failProvisional(entry, err);
        } else |err| self.failProvisional(entry, err);
        entry.ready.broadcast();
        return self.awaitProvisional(entry);
    }

    fn failProvisional(self: *EventStore, entry: *Provisional, err: anyerror) void {
        const message = runtime.errorMessage(err);
        entry.message_len = @min(message.len, entry.message.len);
        @memcpy(entry.message[0..entry.message_len], message[0..entry.message_len]);
        entry.state = .failed;
        if (self.cache.get(entry.key) == entry) {
            _ = self.cache.orderedRemove(entry.key);
            self.releaseProvisional(entry);
        }
    }

    fn awaitProvisional(self: *EventStore, entry: *Provisional) !*Provisional {
        while (entry.state == .pending) self.loop.wait(&entry.ready);
        if (entry.state == .ok) return entry;
        const message = entry.message[0..entry.message_len];
        defer self.releaseProvisional(entry);
        return fail("{s}", .{message});
    }

    fn shapeProvisional(arena: Allocator, rows: []Value) ![]ProvisionalMessage {
        const messages = try arena.alloc(ProvisionalMessage, rows.len);
        for (rows, messages) |row, *message| {
            var data = try without(arena, row, &.{"payment_domain_ids"});
            const origin = try rowDomain(row, "origin_domain_id");
            const destination = try rowDomain(row, "destination_domain_id");
            try setMember(arena, &data, "origin_domain_id", json.int(origin));
            try setMember(arena, &data, "destination_domain_id", json.int(destination));
            var domains: std.ArrayList(u32) = .empty;
            try domains.appendSlice(arena, &.{ origin, destination });
            try rowDomains(arena, row, "payment_domain_ids", &domains);
            const msg_id = data.get("msg_id");
            message.* = .{
                .data = data,
                .domains = domains.items,
                .msg_id = if (msg_id != null and msg_id.? == .string) msg_id.?.string else null,
            };
        }
        return messages;
    }

    // -- headEvents ----------------------------------------------------------

    /// `headEvents` async generator: pages of rows sorted by cursor.
    pub const HeadEvents = struct {
        store: *EventStore,
        event_type: EventType,
        domain: u32,
        after: i128,
        through: i128,
        cursor_height: i128,
        cursor_id: i128 = 0,
        page: std.heap.ArenaAllocator,
        done: bool = false,

        pub fn deinit(self: *HeadEvents) void {
            self.page.deinit();
        }

        /// Next page (valid until the following call), or null.
        pub fn next(self: *HeadEvents) !?[]Value {
            if (self.done) return null;
            _ = self.page.reset(.retain_capacity);
            const a = self.page.allocator();
            const params = [_]Value{
                storedDomainValue(self.domain),
                try bigText(a, self.after),
                try bigText(a, self.through),
                try bigText(a, self.cursor_height),
                try bigText(a, self.cursor_id),
                self.store.batch(),
            };
            const rows = try self.store.query(a, sql.headEvents(self.event_type), &params);
            if (rows.len == 0) {
                self.done = true;
                return null;
            }
            const last = rows[rows.len - 1];
            const next_height = try parseId(last.get(FRONTIER_HEIGHT));
            const next_id = try parseId(last.get(FRONTIER_ID));
            const events = try a.alloc(Value, rows.len);
            for (rows, events) |row, *event| event.* = try without(a, row, &.{ FRONTIER_ID, FRONTIER_HEIGHT });
            try sortRows(a, self.event_type, events);
            self.cursor_height = next_height;
            self.cursor_id = next_id;
            if (rows.len < self.store.batch_size) self.done = true;
            return events;
        }
    };

    pub fn headEvents(self: *EventStore, event_type: EventType, domain: u32, after: i128, through: i128) HeadEvents {
        return .{
            .store = self,
            .event_type = event_type,
            .domain = domain,
            .after = after,
            .through = through,
            .cursor_height = after,
            .page = .init(self.allocator),
        };
    }

    // -- confirmation readers ------------------------------------------------

    const EventRows = struct {
        store: *EventStore,
        event_type: EventType,
        domain: u32,
        through: i128,
        confirmations: u64,
        position: cs.Position,
        page: std.heap.ArenaAllocator,
        frame: std.heap.ArenaAllocator,
        rows: []Value = &.{},
        index: usize = 0,
        fetched: bool = false,

        fn next(ptr: *anyopaque) anyerror!?cs.Row {
            const self: *EventRows = @ptrCast(@alignCast(ptr));
            while (true) {
                if (self.index < self.rows.len) {
                    const row = self.rows[self.index];
                    self.index += 1;
                    return try self.shape(row);
                }
                if (self.fetched and self.rows.len < self.store.batch_size) return null;
                _ = self.page.reset(.retain_capacity);
                const a = self.page.allocator();
                const params = [_]Value{
                    storedDomainValue(self.domain),
                    try bigText(a, self.position.height),
                    try bigText(a, self.position.id),
                    try bigText(a, self.through),
                    self.store.batch(),
                };
                self.rows = try self.store.query(a, sql.confirmationEvents(self.event_type), &params);
                self.fetched = true;
                self.index = 0;
                if (self.rows.len == 0) return null;
            }
        }

        fn shape(self: *EventRows, row: Value) !cs.Row {
            _ = self.frame.reset(.retain_capacity);
            const a = self.frame.allocator();
            const position: cs.Position = .{
                .height = try parseId(row.get(FRONTIER_HEIGHT)),
                .source = 0,
                .id = try parseId(row.get(FRONTIER_ID)),
            };
            self.position = position;
            const block_hash = row.get("block_hash");
            const rest = try without(a, row, &.{ FRONTIER_ID, FRONTIER_HEIGHT, "block_hash" });
            // `{ ...eventMessage(eventType, row), confirmations, height, blockHash }`.
            var out: std.Io.Writer.Allocating = .init(a);
            var o = try frames.Object.begin(&out.writer);
            try eventMessageMembers(&o, a, self.event_type, rest);
            try o.int("confirmations", self.confirmations);
            try o.bigString("height", position.height);
            if (block_hash) |hash| try o.val("blockHash", hash);
            try o.end();
            return .{ .position = position, .message = .{ .frame = out.written() } };
        }

        fn deinit(ptr: *anyopaque) void {
            const self: *EventRows = @ptrCast(@alignCast(ptr));
            const allocator = self.store.allocator;
            self.page.deinit();
            self.frame.deinit();
            allocator.destroy(self);
        }
    };

    /// `confirmationEventRows` (zero/custom-confirmation agent streams).
    pub fn confirmationEventRows(
        self: *EventStore,
        event_type: EventType,
        domain: u32,
        after: cs.Position,
        through: i128,
        confirmations: u64,
    ) !cs.Reader {
        const reader = try self.allocator.create(EventRows);
        errdefer self.allocator.destroy(reader);
        reader.* = .{
            .store = self,
            .event_type = event_type,
            .domain = domain,
            .through = through,
            .confirmations = confirmations,
            .position = after,
            .page = .init(self.allocator),
            .frame = .init(self.allocator),
        };
        return .{ .ptr = reader, .vtable = &.{ .next = EventRows.next, .deinit = EventRows.deinit } };
    }

    const MessageRows = struct {
        store: *EventStore,
        domain: u32,
        through: i128,
        frontiers: *const cs.Frontiers,
        confirmations: u64,
        message_ids: ?[]const []const u8,
        position: cs.Position,
        page: std.heap.ArenaAllocator,
        frame: std.heap.ArenaAllocator,
        changes: []Value = &.{},
        provisional: ?*Provisional = null,
        index: usize = 0,
        fetched: bool = false,

        fn next(ptr: *anyopaque) anyerror!?cs.Row {
            const self: *MessageRows = @ptrCast(@alignCast(ptr));
            if (self.message_ids) |ids| if (ids.len == 0) return null;
            while (true) {
                if (self.index < self.changes.len) {
                    const change = self.changes[self.index];
                    self.index += 1;
                    return try self.shape(change);
                }
                if (self.fetched and self.changes.len < self.store.batch_size) return null;
                self.releasePage();
                const a = self.page.allocator();
                var params: std.ArrayList(Value) = .empty;
                try params.appendSlice(a, &.{
                    storedDomainValue(self.domain),
                    try bigText(a, self.position.height),
                    json.int(self.position.source),
                    try bigText(a, self.position.id),
                    try bigText(a, self.through),
                    self.store.batch(),
                });
                if (self.message_ids) |ids| try params.append(a, try stringArray(a, ids));
                const text = if (self.message_ids != null) comptime sql.confirmationMessages(true) else comptime sql.confirmationMessages(false);
                self.changes = try self.store.query(a, text, params.items);
                self.fetched = true;
                self.index = 0;
                if (self.changes.len == 0) return null;
                var ids: std.ArrayList([]const u8) = .empty;
                for (self.changes) |change| {
                    const id = change.get("msg_id") orelse continue;
                    if (id == .string and !protocol.containsString(ids.items, id.string)) try ids.append(a, id.string);
                }
                self.provisional = try self.store.provisionalMessages(ids.items, self.frontiers);
            }
        }

        fn shape(self: *MessageRows, change: Value) !cs.Row {
            const position: cs.Position = .{
                .height = try parseId(change.get("height")),
                .source = blk: {
                    const source = change.get("source") orelse break :blk 0;
                    break :blk if (source == .number) @intFromFloat(source.number) else 0;
                },
                .id = try parseId(change.get("id")),
            };
            self.position = position;
            const msg_id = change.get("msg_id");
            const found = if (msg_id != null and msg_id.? == .string) self.provisional.?.find(msg_id.?.string) else null;
            const message = found orelse return .{ .position = position };
            _ = self.frame.reset(.retain_capacity);
            var out: std.Io.Writer.Allocating = .init(self.frame.allocator());
            var o = try frames.Object.begin(&out.writer);
            try o.string("type", "message_upsert");
            try o.int("domain", self.domain);
            try o.int("confirmations", self.confirmations);
            try o.bigString("height", self.through);
            try o.val("data", message.data);
            try o.end();
            return .{
                .domains = message.domains,
                .position = position,
                .message = .{ .frame = out.written(), .message_id = message.msg_id },
            };
        }

        fn releasePage(self: *MessageRows) void {
            if (self.provisional) |entry| self.store.releaseProvisional(entry);
            self.provisional = null;
            _ = self.page.reset(.retain_capacity);
        }

        fn deinit(ptr: *anyopaque) void {
            const self: *MessageRows = @ptrCast(@alignCast(ptr));
            const allocator = self.store.allocator;
            self.releasePage();
            if (self.message_ids) |ids| {
                for (ids) |id| allocator.free(id);
                allocator.free(ids);
            }
            self.page.deinit();
            self.frame.deinit();
            allocator.destroy(self);
        }
    };

    /// `confirmationMessageRows` (Explorer custom confirmations). `frontiers`
    /// must outlive the reader.
    pub fn confirmationMessageRows(
        self: *EventStore,
        domain: u32,
        after: cs.Position,
        through: i128,
        frontiers: *const cs.Frontiers,
        confirmations: u64,
        message_ids: ?[]const []const u8,
    ) !cs.Reader {
        const reader = try self.allocator.create(MessageRows);
        errdefer self.allocator.destroy(reader);
        reader.* = .{
            .store = self,
            .domain = domain,
            .through = through,
            .frontiers = frontiers,
            .confirmations = confirmations,
            .message_ids = if (message_ids) |ids| try dupeStrings(self.allocator, ids) else null,
            .position = after,
            .page = .init(self.allocator),
            .frame = .init(self.allocator),
        };
        return .{ .ptr = reader, .vtable = &.{ .next = MessageRows.next, .deinit = MessageRows.deinit } };
    }
};

fn dupeStrings(allocator: Allocator, items: []const []const u8) Allocator.Error![]const []const u8 {
    const out = try allocator.alloc([]const u8, items.len);
    var done: usize = 0;
    errdefer {
        for (out[0..done]) |item| allocator.free(item);
        allocator.free(out);
    }
    for (items, out) |item, *copy| {
        copy.* = try allocator.dupe(u8, item);
        done += 1;
    }
    return out;
}
