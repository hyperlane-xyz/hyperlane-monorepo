//! Port of `event-store.ts`: database reads shared by live publication and
//! historical replay, plus row shaping. SQL text is byte-identical to TS
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
};

// ---------------------------------------------------------------------------
// Stream configuration

pub const Sequence = struct { address: []const u8, value: []const u8 };

pub const Stream = struct {
    table: []const u8,
    domain: []const u8,
    columns: []const []const u8,
    sequence: ?Sequence = null,
};

const raw_message_dispatch_columns = [_][]const u8{ "destination_domain", "id", "msg_body", "msg_id", "nonce", "origin_block_hash", "origin_block_height", "origin_domain", "origin_mailbox", "origin_tx_hash", "recipient", "sender", "time_created" };

pub fn stream(comptime event_type: EventType) Stream {
    return switch (event_type) {
        .dispatch => .{
            .table = "confirmed_raw_message_dispatch",
            .domain = "origin_domain",
            .columns = &raw_message_dispatch_columns,
            .sequence = .{ .address = "origin_mailbox", .value = "nonce" },
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
            .sequence = .{ .address = "merkle_tree_hook", .value = "leaf_index" },
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

const GAS_PAYMENT_STREAM_CURSOR = "gas_payment_stream_cursor";
const GAS_PAYMENT_STREAM_HEAD = "gas_payment_stream_head";
pub const STREAM_CURSOR_COLUMN = "scraper_stream_cursor";
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

const CursorMode = enum { none, mapped, legacy };
const QueryParts = struct { projection: []const u8, joins: []const u8 };

fn eventQueryParts(comptime event_type: EventType, comptime cursor: CursorMode) QueryParts {
    const s = stream(event_type);
    if (event_type != .gas_payment) return .{ .projection = columns(s, "event_row"), .joins = "" };
    const position = if (cursor == .legacy)
        "COALESCE(\"event_cursor\".\"stream_cursor\", \"event_row\".\"id\")"
    else
        "\"event_cursor\".\"stream_cursor\"";
    return .{
        .projection = gasPaymentColumns(s) ++ (if (cursor != .none) ", " ++ position ++ " AS " ++ q(STREAM_CURSOR_COLUMN) else ""),
        .joins = gas_payment_metadata_joins ++ (if (cursor != .none)
            " LEFT JOIN " ++ q(GAS_PAYMENT_STREAM_CURSOR) ++ " AS \"event_cursor\" ON \"event_cursor\".\"gas_payment_id\" = \"event_row\".\"id\""
        else
            ""),
    };
}

fn heightColumn(comptime event_type: EventType) []const u8 {
    return if (event_type == .dispatch) "origin_block_height" else "block_number";
}

fn Sql(comptime event_type: EventType) type {
    const s = stream(event_type);
    const height = heightColumn(event_type);
    return struct {
        const notified = blk: {
            const parts = eventQueryParts(event_type, .legacy);
            break :blk "SELECT \"event_row\".\"id\" AS \"notification_id\", " ++ parts.projection ++ " FROM " ++ q(s.table) ++
                " AS \"event_row\"" ++ parts.joins ++ " WHERE \"event_row\".\"id\" = ANY($1::bigint[]) ORDER BY \"event_row\".\"id\" ASC";
        };
        const head_events = blk: {
            const parts = eventQueryParts(event_type, .mapped);
            const fh = "\"frontier_row\"." ++ q(height);
            break :blk "SELECT " ++ parts.projection ++ ", \"event_row\".\"id\" AS " ++ q(FRONTIER_ID) ++ ", \"event_row\"." ++ q(height) ++
                " AS " ++ q(FRONTIER_HEIGHT) ++ " FROM (SELECT * FROM " ++ q(s.table) ++ " AS \"frontier_row\" WHERE \"frontier_row\"." ++
                q(s.domain) ++ "=$1 AND " ++ fh ++ ">$2::bigint AND " ++ fh ++ "<=$3::bigint AND (" ++ fh ++ ">$4::bigint OR (" ++ fh ++
                "=$4::bigint AND \"frontier_row\".\"id\">$5::bigint)) ORDER BY " ++ fh ++ ", \"frontier_row\".\"id\" LIMIT $6) AS \"event_row\"" ++
                parts.joins ++ " ORDER BY \"event_row\"." ++ q(height) ++ ", \"event_row\".\"id\"";
        };
        fn confirmation(comptime with_addresses: bool) []const u8 {
            const parts = eventQueryParts(event_type, .none);
            const table = s.table["confirmed_".len..];
            const block_hash = if (event_type == .merkle_tree_insertion) ", event_row.block_hash" else "";
            const address_filter = if (!with_addresses) "" else " AND " ++
                q(if (event_type == .gas_payment) "interchain_gas_paymaster" else s.sequence.?.address) ++ "=ANY($6::bytea[])";
            return "/* confirmation_events */ SELECT " ++ parts.projection ++ block_hash ++ ", event_row.id AS frontier_id, event_row." ++
                q(height) ++ " AS frontier_height\n         FROM (SELECT * FROM " ++ q(table) ++ " WHERE " ++ q(s.domain) ++ "=$1" ++
                address_filter ++ "\n           AND (" ++ q(height) ++ ", id)>($2::bigint,$3::bigint) AND " ++ q(height) ++
                "<=$4::bigint\n           ORDER BY " ++ q(height) ++ ", id LIMIT $5) event_row" ++ parts.joins ++
                "\n         ORDER BY event_row." ++ q(height) ++ ", event_row.id";
        }
        const confirmation_events = confirmation(false);
        const confirmation_events_by_address = if (event_type == .delivery) "" else confirmation(true);
        const sequence_rows = if (s.sequence) |seq|
            "SELECT " ++ columns(s, null) ++ " FROM " ++ q(s.table) ++ " WHERE " ++ q(s.domain) ++ " = $1 AND " ++ q(seq.address) ++
                " = $2::bytea AND " ++ q(seq.value) ++ " > $3::bigint AND " ++ q(seq.value) ++ " <= $4::bigint ORDER BY " ++ q(seq.value) ++ " ASC LIMIT $5"
        else
            "";
        const sequence_bounds = if (s.sequence) |seq|
            "SELECT COALESCE(MIN(" ++ q(seq.value) ++ "), 0)::text AS first, COALESCE(MAX(" ++ q(seq.value) ++ "), -1)::text AS last FROM " ++
                q(s.table) ++ " WHERE " ++ q(s.domain) ++ " = $1 AND " ++ q(seq.address) ++ " = $2::bytea"
        else
            "";
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
    pub fn confirmationMessages(comptime filter: bool) []const u8 {
        const f = if (filter) " AND msg_id = ANY($7::bytea[])" else "";
        return "/* confirmation_messages */ SELECT * FROM (\n" ++
            "          SELECT origin_block_height AS height, 0 AS source, id, msg_id FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_block_height>=$2::bigint AND origin_block_height<=$5::bigint" ++ f ++ "\n" ++
            "          UNION ALL SELECT block_number, 1, id, msg_id FROM delivered_message WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint" ++ f ++ "\n" ++
            "          UNION ALL SELECT block_number, 2, id, msg_id FROM gas_payment WHERE domain=$1 AND block_number>=$2::bigint AND block_number<=$5::bigint" ++ f ++ "\n" ++
            "        ) changes WHERE (height, source, id)>($2::bigint,$3::integer,$4::bigint) ORDER BY height, source, id LIMIT $6";
    }
    const gas = stream(.gas_payment);
    pub fn gasPaymentRows(comptime legacy: bool) []const u8 {
        const source = if (legacy)
            "(SELECT * FROM " ++ q(gas.table) ++ " WHERE " ++ q(gas.domain) ++ " = $1 AND \"interchain_gas_paymaster\" = $2::bytea AND \"id\" > $3::bigint AND \"id\" <= $4::bigint ORDER BY \"id\" ASC LIMIT $5) AS \"event_row\""
        else
            "(SELECT \"gas_payment_id\", \"stream_cursor\" FROM " ++ q(GAS_PAYMENT_STREAM_CURSOR) ++ " WHERE \"domain\" = $1 AND \"interchain_gas_paymaster\" = $2::bytea AND \"stream_cursor\" > $3::bigint AND \"stream_cursor\" <= $4::bigint ORDER BY \"stream_cursor\" ASC LIMIT $5) AS \"event_cursor\" INNER JOIN " ++ q(gas.table) ++ " AS \"event_row\" ON \"event_row\".\"id\" = \"event_cursor\".\"gas_payment_id\"";
        const position = if (legacy) "\"event_row\".\"id\"" else "\"event_cursor\".\"stream_cursor\"";
        return "SELECT " ++ gasPaymentColumns(gas) ++ ", " ++ position ++ " AS " ++ q(STREAM_CURSOR_COLUMN) ++ " FROM " ++ source ++
            gas_payment_metadata_joins ++ " ORDER BY " ++ position ++ " ASC";
    }
    pub const gas_payment_cursor_bounds = "SELECT COALESCE(\"legacy_max_id\", 0)::text AS legacy_max_id, COALESCE(\"last_cursor\", 0)::text AS last_cursor FROM " ++
        q(GAS_PAYMENT_STREAM_HEAD) ++ " WHERE \"domain\" = $1 AND \"interchain_gas_paymaster\" = $2::bytea";

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
    pub fn confirmationEvents(event_type: EventType, with_addresses: bool) []const u8 {
        return switch (event_type) {
            inline else => |tag| if (with_addresses) Sql(tag).confirmation_events_by_address else Sql(tag).confirmation_events,
        };
    }
    pub fn sequenceRows(event_type: EventType) []const u8 {
        return switch (event_type) {
            inline else => |tag| Sql(tag).sequence_rows,
        };
    }
    pub fn sequenceBounds(event_type: EventType) []const u8 {
        return switch (event_type) {
            inline else => |tag| Sql(tag).sequence_bounds,
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

/// `eventData`: drop the gas stream cursor and normalize stored domains.
pub fn eventData(arena: Allocator, event_type: EventType, row: Value) !Value {
    var data = if (event_type == .gas_payment)
        try without(arena, row, &.{STREAM_CURSOR_COLUMN})
    else
        try without(arena, row, &.{});
    for (eventDomainColumns(event_type)) |column| {
        const domain = try rowDomain(data, column);
        const current = data.get(column).?;
        if (current != .number or current.number != @as(f64, @floatFromInt(domain)))
            try setMember(arena, &data, column, json.int(domain));
    }
    return data;
}

pub const Cursor = struct { address: []const u8, value: i128 };

fn rowSequence(arena: Allocator, event_type: EventType, row: Value) !?Cursor {
    const seq = switch (event_type) {
        .dispatch => comptime stream(.dispatch).sequence.?,
        .merkle_tree_insertion => comptime stream(.merkle_tree_insertion).sequence.?,
        else => return null,
    };
    const address = row.get(seq.address) orelse return fail("Invalid {s} in event row", .{seq.address});
    if (address != .string) return fail("Invalid {s} in event row", .{seq.address});
    return .{
        .address = try protocol.normalizeSequenceAddress(arena, address.string),
        .value = rowInteger(row.get(seq.value), -1) orelse return fail("Invalid event sequence", .{}),
    };
}

fn gasPaymentStreamCursor(arena: Allocator, row: Value) !Cursor {
    const address = row.get("interchain_gas_paymaster") orelse return fail("Invalid interchain_gas_paymaster in event row", .{});
    if (address != .string) return fail("Invalid interchain_gas_paymaster in event row", .{});
    return .{
        .address = try protocol.normalizeSequenceAddress(arena, address.string),
        .value = try parseId(row.get(STREAM_CURSOR_COLUMN)),
    };
}

pub fn rowCursor(arena: Allocator, event_type: EventType, row: Value) !?Cursor {
    if (event_type == .gas_payment) return try gasPaymentStreamCursor(arena, row);
    return rowSequence(arena, event_type, row);
}

/// `sequenceKey(domain, address)` for an already-normalized address.
pub fn cursorKey(arena: Allocator, domain: u32, normalized_address: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(arena, "{d}:{s}", .{ domain, normalized_address });
}

pub fn rowCursorKey(arena: Allocator, event_type: EventType, domain: u32, row: Value) !?[]const u8 {
    const cursor = try rowCursor(arena, event_type, row) orelse return null;
    return try cursorKey(arena, domain, cursor.address);
}

/// `rows.sort(compareRows)`: a stable sort whose comparator throws on rows
/// without a cursor; V8 calls it for every element once there are two.
pub fn sortRows(arena: Allocator, event_type: EventType, rows: []Value) !void {
    if (rows.len < 2 or event_type == .delivery) return;
    const Keyed = struct { key: i128, row: Value };
    const keyed = try arena.alloc(Keyed, rows.len);
    for (rows, keyed) |row, *entry| entry.* = .{ .key = (try rowCursor(arena, event_type, row)).?.value, .row = row };
    std.mem.sort(Keyed, keyed, {}, struct {
        fn lessThan(_: void, a: Keyed, b: Keyed) bool {
            return a.key < b.key;
        }
    }.lessThan);
    for (rows, keyed) |*row, entry| row.* = entry.row;
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

    pub fn confirmationHeads(self: *EventStore, allocator: Allocator, domains: []const u32) !cs.Heads {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const rows = try self.query(arena.allocator(), sql.confirmation_heads, &.{try domainArray(arena.allocator(), domains)});
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

    pub fn sequenceRows(self: *EventStore, arena: Allocator, event_type: EventType, cursor: protocol.StreamCursor, after: i128, through: i128) ![]Value {
        return self.query(arena, sql.sequenceRows(event_type), &try replayValues(self, arena, cursor, after, through));
    }

    pub fn sequenceBounds(self: *EventStore, event_type: EventType, cursor: protocol.StreamCursor) !struct { first: i128, last: i128 } {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const rows = try self.query(arena.allocator(), sql.sequenceBounds(event_type), &.{ storedDomainValue(cursor.domain), .{ .string = cursor.address } });
        const row: ?Value = if (rows.len > 0) rows[0] else null;
        return .{
            .first = if (row) |r| rowInteger(r.get("first"), -1) orelse return fail("Invalid event sequence", .{}) else 0,
            .last = if (row) |r| rowInteger(r.get("last"), -1) orelse return fail("Invalid event sequence", .{}) else -1,
        };
    }

    pub fn gasPaymentRows(self: *EventStore, arena: Allocator, cursor: protocol.StreamCursor, after: i128, through: i128, legacy: bool) ![]Value {
        const text = if (legacy) comptime sql.gasPaymentRows(true) else comptime sql.gasPaymentRows(false);
        return self.query(arena, text, &try replayValues(self, arena, cursor, after, through));
    }

    pub fn gasPaymentCursorBounds(self: *EventStore, cursor: protocol.StreamCursor) !struct { last_cursor: i128, legacy_max_id: i128 } {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const rows = try self.query(arena.allocator(), sql.gas_payment_cursor_bounds, &.{ storedDomainValue(cursor.domain), .{ .string = cursor.address } });
        const row: ?Value = if (rows.len > 0) rows[0] else null;
        return .{
            .last_cursor = if (row) |r| try parseId(r.get("last_cursor")) else 0,
            .legacy_max_id = if (row) |r| try parseId(r.get("legacy_max_id")) else 0,
        };
    }

    fn replayValues(self: *EventStore, arena: Allocator, cursor: protocol.StreamCursor, after: i128, through: i128) ![5]Value {
        return .{ storedDomainValue(cursor.domain), .{ .string = cursor.address }, try bigText(arena, after), try bigText(arena, through), self.batch() };
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
        addresses: ?[]const []const u8,
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
                var params: std.ArrayList(Value) = .empty;
                try params.appendSlice(a, &.{
                    storedDomainValue(self.domain),
                    try bigText(a, self.position.height),
                    try bigText(a, self.position.id),
                    try bigText(a, self.through),
                    self.store.batch(),
                });
                if (self.addresses) |addresses| try params.append(a, try stringArray(a, addresses));
                self.rows = try self.store.query(a, sql.confirmationEvents(self.event_type, self.addresses != null), params.items);
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
            const data = try eventData(a, self.event_type, rest);
            const sequence = try rowSequence(a, self.event_type, rest);
            const row_id: ?i128 = if (self.event_type == .gas_payment) try parseId(rest.get("id")) else null;
            var out: std.Io.Writer.Allocating = .init(a);
            var o = try frames.Object.begin(&out.writer);
            try o.string("type", "event");
            try o.string("eventType", self.event_type.name());
            try o.int("domain", self.domain);
            try o.int("confirmations", self.confirmations);
            try o.bigString("height", position.height);
            if (block_hash) |hash| try o.val("blockHash", hash);
            try o.val("data", data);
            if (sequence) |s| try o.bigString("sequence", s.value);
            try o.optBigString("rowId", row_id);
            try o.end();
            return .{ .position = position, .message = .{ .frame = out.written() } };
        }

        fn deinit(ptr: *anyopaque) void {
            const self: *EventRows = @ptrCast(@alignCast(ptr));
            const allocator = self.store.allocator;
            if (self.addresses) |addresses| {
                for (addresses) |address| allocator.free(address);
                allocator.free(addresses);
            }
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
        addresses: ?[]const []const u8,
    ) !cs.Reader {
        if (addresses != null and event_type == .delivery) return fail("Stream has no native sequence", .{});
        const reader = try self.allocator.create(EventRows);
        errdefer self.allocator.destroy(reader);
        reader.* = .{
            .store = self,
            .event_type = event_type,
            .domain = domain,
            .through = through,
            .confirmations = confirmations,
            .addresses = if (addresses) |list| try dupeStrings(self.allocator, list) else null,
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
