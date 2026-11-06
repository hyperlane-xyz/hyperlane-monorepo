//! PostgreSQL near-head Store port. Uses the existing Rust migration schema,
//! database-clock writer leases, transaction locks and frontier-derived views.
//! Owns no connection/pool: one caller owns each borrowed libpq connection.
const std = @import("std");
const pg = @import("postgres.zig");
const protocol = @import("../protocol/root.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
const zero_hash: Hash = .{0} ** 32;

pub const Header = struct { height: u64, timestamp: u64, hash: Hash, parent: Hash = zero_hash };
pub const Contracts = struct { mailbox: Hash, hook: Hash, paymaster: Hash };
pub const State = struct { indexed: u64, hash: Hash, confirmed: u64, head: u64, halted: bool };
pub const EventData = union(enum) {
    dispatch: protocol.Message,
    delivery: Hash,
    insertion: struct { message_id: Hash, index: u32 },
    gas: struct { message_id: Hash, destination: u32, gas: u256, payment: u256 },
};
pub const Event = struct {
    block_number: u64,
    block_hash: Hash,
    address: Hash,
    tx_hash: ?[64]u8 = null,
    tx_index: u64 = 0,
    log_index: u64,
    sequence: ?u32 = null,
    data: EventData,
};
pub const Block = struct { header: Header, events: []const Event };

const streams = .{
    .{ "raw_message_dispatch", "origin_domain", "origin_block_height" },
    .{ "delivered_message", "domain", "block_number" },
    .{ "gas_payment", "domain", "block_number" },
    .{ "merkle_tree_insertion", "domain", "block_number" },
};

fn number(allocator: Allocator, value: u64) !pg.Param {
    if (value > std.math.maxInt(i64)) return error.HeightOutOfRange;
    return .{ .value = try std.fmt.allocPrint(allocator, "{d}", .{value}), .oid = pg.Oid.int8 };
}
fn signed(allocator: Allocator, value: u32) !pg.Param {
    const signed_value: i32 = @bitCast(value);
    return .{ .value = try std.fmt.allocPrint(allocator, "{d}", .{signed_value}), .oid = pg.Oid.int4 };
}
fn blob(allocator: Allocator, bytes: []const u8) !pg.Param {
    return pg.Param.bytes(try allocator.dupe(u8, bytes));
}
fn lease(allocator: Allocator, seconds: f64) !pg.Param {
    if (!std.math.isFinite(seconds) or seconds < 0) return error.InvalidLease;
    return .{ .value = try std.fmt.allocPrint(allocator, "{d}", .{seconds}), .oid = pg.Oid.float8 };
}
fn nonnegative(value: i64) !u64 {
    return std.math.cast(u64, value) orelse error.InvalidStoredHeight;
}
fn addressBytes(address: *const Hash) []const u8 {
    return if (std.mem.allEqual(u8, address[0..12], 0)) address[12..] else address;
}
fn transactionBytes(hash: *const [64]u8) []const u8 {
    return if (std.mem.allEqual(u8, hash[0..32], 0)) hash[32..] else hash;
}

pub const Store = struct {
    connection: *pg.Connection,
    domain: u32,
    /// Runtime supplies a process-unique identity; simulation can inject one.
    writer_id: []const u8,

    fn arena(self: Store) std.heap.ArenaAllocator {
        return std.heap.ArenaAllocator.init(self.connection.allocator);
    }
    fn domainParam(self: Store, allocator: Allocator) !pg.Param {
        return signed(allocator, self.domain);
    }
    fn hashResult(self: Store, result: pg.Result, row: usize, name: [:0]const u8) !Hash {
        const value = try result.bytea(self.connection.allocator, row, name);
        defer self.connection.allocator.free(value);
        if (value.len != 32) return error.InvalidStoredHash;
        return value[0..32].*;
    }
    fn writerMatches(self: Store, result: pg.Result) !bool {
        const id = try result.value(0, try result.column("writer_id"));
        return if (id) |value| std.mem.eql(u8, value, self.writer_id) else true;
    }
    fn one(result: pg.Result) !void {
        if (result.rows() != 1) return error.MissingHeadState;
    }
    fn changed(result: pg.Result) !void {
        if (try result.affected() != 1) return error.WriterOwned;
    }

    pub fn claim(self: Store, lease_seconds: f64) !void {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var result = try self.connection.query("UPDATE scraper_head SET writer_id=$2,writer_lease_until=clock_timestamp()+make_interval(secs=>$3) WHERE domain=$1 AND (writer_id=$2 OR writer_lease_until IS NULL OR writer_lease_until<clock_timestamp())", &.{ try self.domainParam(a), pg.Param.text(self.writer_id), try lease(a, lease_seconds) });
        defer result.deinit();
        try changed(result);
    }

    pub fn state(self: Store) !?State {
        var memory = self.arena();
        defer memory.deinit();
        var result = try self.connection.query("SELECT indexed_height,indexed_hash,confirmed_height,head_height,halted FROM scraper_head WHERE domain=$1", &.{try self.domainParam(memory.allocator())});
        defer result.deinit();
        if (result.rows() == 0) return null;
        try one(result);
        return .{ .indexed = try nonnegative(try result.integer(0, "indexed_height")), .hash = try self.hashResult(result, 0, "indexed_hash"), .confirmed = try nonnegative(try result.integer(0, "confirmed_height")), .head = try nonnegative(try result.integer(0, "head_height")), .halted = try result.boolean(0, "halted") };
    }

    fn ensureEmpty(self: Store, a: Allocator) !void {
        var result = try self.connection.query("SELECT EXISTS(SELECT 1 FROM block WHERE domain=$1) OR EXISTS(SELECT 1 FROM scraper_checkpoint WHERE domain=$1) OR EXISTS(SELECT 1 FROM raw_message_dispatch WHERE origin_domain=$1) OR EXISTS(SELECT 1 FROM delivered_message WHERE domain=$1) OR EXISTS(SELECT 1 FROM gas_payment WHERE domain=$1) OR EXISTS(SELECT 1 FROM merkle_tree_insertion WHERE domain=$1) AS has_history", &.{try self.domainParam(a)});
        defer result.deinit();
        try one(result);
        if (try result.boolean(0, "has_history")) return error.LegacyHistoryRequiresCutover;
    }

    pub fn anchorHeight(self: Store, index_from: u64) !u64 {
        var memory = self.arena();
        defer memory.deinit();
        var result = try self.connection.query("SELECT start_height FROM scraper_head WHERE domain=$1", &.{try self.domainParam(memory.allocator())});
        defer result.deinit();
        if (result.rows() != 0) return nonnegative(try result.integer(0, "start_height"));
        try self.ensureEmpty(memory.allocator());
        return index_from -| 1;
    }

    fn contractsMatch(self: Store, result: pg.Result, contracts: Contracts) !bool {
        const a = self.connection.allocator;
        inline for (.{ .{ "mailbox", contracts.mailbox }, .{ "merkle_tree_hook", contracts.hook }, .{ "interchain_gas_paymaster", contracts.paymaster } }) |item| {
            const bytes = try result.bytea(a, 0, item[0]);
            defer a.free(bytes);
            if (!std.mem.eql(u8, bytes, addressBytes(&item[1]))) return false;
        }
        return true;
    }

    pub fn initialize(self: Store, anchor: Header, contracts: Contracts) !void {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        // The advisory key is positive u32 widened to i64, unlike signed domain storage.
        try self.connection.execute("SELECT pg_advisory_xact_lock($1)", &.{try number(a, self.domain)});
        var result = try self.connection.query("SELECT start_height,mailbox,merkle_tree_hook,interchain_gas_paymaster FROM scraper_head WHERE domain=$1 FOR UPDATE", &.{try self.domainParam(a)});
        defer result.deinit();
        if (result.rows() != 0) {
            if (try nonnegative(try result.integer(0, "start_height")) != anchor.height or !try self.contractsMatch(result, contracts)) return error.ConfigurationChanged;
        } else {
            try self.ensureEmpty(a);
            try self.connection.execute("INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster) VALUES($1,$2,$2,$3,$2,$2,$4,$5,$6)", &.{ try self.domainParam(a), try number(a, anchor.height), try blob(a, &anchor.hash), try blob(a, addressBytes(&contracts.mailbox)), try blob(a, addressBytes(&contracts.hook)), try blob(a, addressBytes(&contracts.paymaster)) });
            try self.insertCheckpoint(a, anchor, false);
        }
        try transaction.commit();
    }

    pub fn validateContracts(self: Store, contracts: Contracts) !void {
        var memory = self.arena();
        defer memory.deinit();
        var result = try self.connection.query("SELECT mailbox,merkle_tree_hook,interchain_gas_paymaster FROM scraper_head WHERE domain=$1", &.{try self.domainParam(memory.allocator())});
        defer result.deinit();
        try one(result);
        if (!try self.contractsMatch(result, contracts)) return error.ConfigurationChanged;
    }

    pub fn validateCheckpoints(self: Store) !void {
        var memory = self.arena();
        defer memory.deinit();
        var result = try self.connection.query("SELECT EXISTS(SELECT 1 FROM scraper_checkpoint c WHERE c.domain=h.domain AND c.height=h.confirmed_height) AS confirmed_exists, EXISTS(SELECT 1 FROM scraper_checkpoint c WHERE c.domain=h.domain AND c.height=h.indexed_height AND c.hash=h.indexed_hash) AS indexed_matches, NOT EXISTS(SELECT 1 FROM scraper_checkpoint c WHERE c.domain=h.domain AND c.height>h.indexed_height) AS no_stale_suffix FROM scraper_head h WHERE h.domain=$1", &.{try self.domainParam(memory.allocator())});
        defer result.deinit();
        try one(result);
        if (!try result.boolean(0, "confirmed_exists") or !try result.boolean(0, "indexed_matches") or !try result.boolean(0, "no_stale_suffix")) return error.InvalidCheckpoints;
    }

    pub fn hash(self: Store, height: u64) !?Hash {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var result = try self.connection.query("SELECT hash FROM scraper_checkpoint WHERE domain=$1 AND height=$2", &.{ try self.domainParam(a), try number(a, height) });
        defer result.deinit();
        return if (result.rows() == 0) null else try self.hashResult(result, 0, "hash");
    }

    pub fn sequenceCounts(self: Store) ![4]u32 {
        var memory = self.arena();
        defer memory.deinit();
        var result = try self.connection.query("SELECT coalesce((SELECT max(nonce::bigint & 4294967295)+1 FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_mailbox=(SELECT mailbox FROM scraper_head WHERE domain=$1)),0) AS dispatches, coalesce((SELECT max(sequence)+1 FROM delivered_message WHERE domain=$1 AND destination_mailbox=(SELECT mailbox FROM scraper_head WHERE domain=$1)),0) AS deliveries, coalesce((SELECT max(sequence)+1 FROM gas_payment WHERE domain=$1 AND interchain_gas_paymaster=(SELECT interchain_gas_paymaster FROM scraper_head WHERE domain=$1)),0) AS payments, coalesce((SELECT max(leaf_index::bigint & 4294967295)+1 FROM merkle_tree_insertion WHERE domain=$1 AND merkle_tree_hook=(SELECT merkle_tree_hook FROM scraper_head WHERE domain=$1)),0) AS insertions", &.{try self.domainParam(memory.allocator())});
        defer result.deinit();
        try one(result);
        var counts: [4]u32 = undefined;
        inline for (.{ "dispatches", "deliveries", "payments", "insertions" }, 0..) |name, i|
            counts[i] = std.math.cast(u32, try result.integer(0, name)) orelse return error.InvalidSequenceCount;
        return counts;
    }

    pub fn checkpoint(self: Store, through: u64) !u64 {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var result = try self.connection.query("SELECT height FROM scraper_checkpoint WHERE domain=$1 AND height<=$2 ORDER BY height DESC LIMIT 1", &.{ try self.domainParam(a), try number(a, through) });
        defer result.deinit();
        try one(result);
        return nonnegative(try result.integer(0, "height"));
    }

    pub fn checkpointBetween(self: Store, after: u64, through: u64) !?u64 {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var result = try self.connection.query("SELECT max(height) AS height FROM scraper_checkpoint WHERE domain=$1 AND height>$2 AND height<=$3", &.{ try self.domainParam(a), try number(a, after), try number(a, through) });
        defer result.deinit();
        try one(result);
        const value = try result.value(0, try result.column("height"));
        return if (value) |text| try nonnegative(try std.fmt.parseInt(i64, text, 10)) else null;
    }

    pub fn pause(self: Store, halt: bool) !void {
        var memory = self.arena();
        defer memory.deinit();
        var result = try self.connection.query("UPDATE scraper_head SET healthy=false,halted=halted OR $2 WHERE domain=$1 AND (writer_id IS NULL OR writer_id=$3)", &.{ try self.domainParam(memory.allocator()), pg.Param.boolean(halt), pg.Param.text(self.writer_id) });
        defer result.deinit();
        try changed(result);
    }

    fn deleteSuffix(self: Store, a: Allocator, after: u64) !void {
        inline for (streams) |stream| {
            try self.connection.execute("DELETE FROM " ++ stream[0] ++ " WHERE " ++ stream[1] ++ "=$1 AND " ++ stream[2] ++ ">$2", &.{ try self.domainParam(a), try number(a, after) });
        }
        // Keep foreign-key failures fatal: enriched rows belong to other writers.
        try self.connection.execute("DELETE FROM block WHERE domain=$1 AND height>$2", &.{ try self.domainParam(a), try number(a, after) });
        try self.connection.execute("DELETE FROM scraper_checkpoint WHERE domain=$1 AND height>$2", &.{ try self.domainParam(a), try number(a, after) });
    }

    fn checkObservation(self: Store, result: pg.Result, expected: State) !void {
        try one(result);
        if (try result.boolean(0, "halted") or !try self.writerMatches(result) or !std.mem.eql(u8, &try self.hashResult(result, 0, "indexed_hash"), &expected.hash)) return error.HeadChanged;
    }

    pub fn rewindToConfirmed(self: Store, expected: State) !void {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        var result = try self.connection.query("SELECT indexed_hash,confirmed_height,halted,writer_id FROM scraper_head WHERE domain=$1 FOR UPDATE", &.{try self.domainParam(a)});
        defer result.deinit();
        try self.checkObservation(result, expected);
        if (try nonnegative(try result.integer(0, "confirmed_height")) != expected.confirmed) return error.HeadChanged;
        try self.deleteSuffix(a, expected.confirmed);
        var update = try self.connection.query("UPDATE scraper_head h SET indexed_height=confirmed_height,indexed_hash=c.hash,healthy=false,updated_at=clock_timestamp() FROM scraper_checkpoint c WHERE h.domain=$1 AND c.domain=h.domain AND c.height=h.confirmed_height", &.{try self.domainParam(a)});
        defer update.deinit();
        try changed(update);
        try transaction.commit();
    }

    pub fn observe(self: Store, expected: State, ancestor: Header, head: Header) !void {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        var result = try self.connection.query("SELECT indexed_hash,confirmed_height,halted,writer_id FROM scraper_head WHERE domain=$1 FOR UPDATE", &.{try self.domainParam(a)});
        defer result.deinit();
        try self.checkObservation(result, expected);
        if (ancestor.height < try nonnegative(try result.integer(0, "confirmed_height"))) return error.ReorgCrossedConfirmed;
        if (!std.mem.eql(u8, &ancestor.hash, &expected.hash)) try self.deleteSuffix(a, ancestor.height);
        try self.connection.execute("UPDATE scraper_head SET indexed_height=$2,indexed_hash=$3,head_height=$4,healthy=true,updated_at=clock_timestamp() WHERE domain=$1", &.{ try self.domainParam(a), try number(a, ancestor.height), try blob(a, &ancestor.hash), try number(a, head.height) });
        try transaction.commit();
    }

    fn insertCheckpoint(self: Store, a: Allocator, header: Header, ignore_conflict: bool) !void {
        const query = "INSERT INTO scraper_checkpoint(domain,hash,height,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')";
        try self.connection.execute(if (ignore_conflict) query ++ " ON CONFLICT(domain,height) DO NOTHING" else query, &.{ try self.domainParam(a), try blob(a, &header.hash), try number(a, header.height), try number(a, header.timestamp) });
    }

    pub fn append(self: Store, expected: State, blocks: []const Block) !void {
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var rows: [6]std.ArrayList([]const pg.Param) = .{std.ArrayList([]const pg.Param).empty} ** 6;
        var previous = expected.hash;
        var height = expected.indexed;
        for (blocks) |block| {
            const header = block.header;
            if (header.height <= height or header.height > expected.head or (header.height - 1 == height and !std.mem.eql(u8, &header.parent, &zero_hash) and !std.mem.eql(u8, &header.parent, &previous))) return error.InvalidCheckpointOrder;
            const header_row = try headerRow(a, self.domain, header);
            try rows[@intFromEnum(Table.checkpoint)].append(a, header_row);
            if (block.events.len != 0) try rows[@intFromEnum(Table.block)].append(a, header_row);
            for (block.events) |event| {
                if (event.block_number != header.height or !std.mem.eql(u8, &event.block_hash, &header.hash)) return error.EventHeaderMismatch;
                const row = try eventRow(a, self.domain, header, event);
                try rows[@intFromEnum(row.table)].append(a, row.values);
            }
            previous = header.hash;
            height = header.height;
        }
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        var state_row = try self.connection.query("SELECT indexed_hash,healthy,halted,writer_id FROM scraper_head WHERE domain=$1 FOR UPDATE", &.{try self.domainParam(a)});
        defer state_row.deinit();
        try self.checkObservation(state_row, expected);
        if (!try state_row.boolean(0, "healthy")) return error.UnhealthyHead;
        inline for (std.meta.tags(Table)) |table| try insertBatches(self.connection, a, table, rows[@intFromEnum(table)].items);
        try self.connection.execute("UPDATE scraper_head SET indexed_height=$2,indexed_hash=$3,updated_at=clock_timestamp() WHERE domain=$1", &.{ try self.domainParam(a), try number(a, height), try blob(a, &previous) });
        try transaction.commit();
    }

    pub fn confirmationBoundary(self: Store, after: u64, through: u64) !u64 {
        if (after > through) return error.ConfirmationRangeRegressed;
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var branches: std.ArrayList([]const u8) = .empty;
        inline for (streams) |stream| try branches.append(a, "(SELECT " ++ stream[2] ++ " AS height FROM " ++ stream[0] ++ " WHERE " ++ stream[1] ++ "=$1 AND " ++ stream[2] ++ ">$2 AND " ++ stream[2] ++ "<=$3 ORDER BY " ++ stream[2] ++ " LIMIT 1001)");
        const joined = try std.mem.join(a, " UNION ALL ", branches.items);
        const query = try std.fmt.allocPrint(a, "WITH events AS (SELECT height FROM ({s}) AS candidates ORDER BY height LIMIT 1001) SELECT CASE WHEN count(*)<=1000 THEN $3 WHEN min(height)=max(height) THEN max(height) ELSE max(height)-1 END AS boundary FROM events", .{joined});
        var result = try self.connection.query(query, &.{ try self.domainParam(a), try number(a, after), try number(a, through) });
        defer result.deinit();
        try one(result);
        return nonnegative(try result.integer(0, "boundary"));
    }

    pub fn confirm(self: Store, expected: State, boundary: Header, lease_seconds: f64) ![4]u64 {
        if (boundary.height > expected.indexed) return error.UnindexedConfirmation;
        if (boundary.height <= expected.confirmed) return .{0} ** 4;
        var memory = self.arena();
        defer memory.deinit();
        const a = memory.allocator();
        var projections: std.ArrayList([]const u8) = .empty;
        inline for (streams) |stream| try projections.append(a, "(SELECT count(*) FROM " ++ stream[0] ++ " WHERE " ++ stream[1] ++ "=$1 AND " ++ stream[2] ++ ">$2 AND " ++ stream[2] ++ "<=$3) AS " ++ stream[0]);
        const count_query = try std.fmt.allocPrint(a, "SELECT {s}", .{try std.mem.join(a, ",", projections.items)});
        var count_row = try self.connection.query(count_query, &.{ try self.domainParam(a), try number(a, expected.confirmed), try number(a, boundary.height) });
        defer count_row.deinit();
        try one(count_row);
        var counts: [4]u64 = undefined;
        inline for (streams, 0..) |stream, i| counts[i] = try nonnegative(try count_row.integer(0, stream[0]));
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        try self.insertCheckpoint(a, boundary, true);
        try self.connection.execute("SELECT assign_confirmed_gas_payment_cursors($1,$2,$3)", &.{ try self.domainParam(a), try number(a, expected.confirmed), try number(a, boundary.height) });
        try self.connection.execute("DELETE FROM scraper_checkpoint WHERE domain=$1 AND height<$2", &.{ try self.domainParam(a), try number(a, boundary.height) });
        var state_row = try self.connection.query("SELECT indexed_hash,head_height,confirmed_height,writer_id,healthy AND NOT halted AND updated_at>clock_timestamp()-make_interval(secs=>$2) AS ready FROM scraper_head WHERE domain=$1 FOR UPDATE", &.{ try self.domainParam(a), try lease(a, lease_seconds) });
        defer state_row.deinit();
        try one(state_row);
        if (!try state_row.boolean(0, "ready") or !try self.writerMatches(state_row) or try nonnegative(try state_row.integer(0, "head_height")) < expected.head or try nonnegative(try state_row.integer(0, "confirmed_height")) != expected.confirmed or !std.mem.eql(u8, &try self.hashResult(state_row, 0, "indexed_hash"), &expected.hash)) return error.ConfirmationExpiredOrChanged;
        try self.connection.execute("UPDATE scraper_head SET confirmed_height=$2 WHERE domain=$1", &.{ try self.domainParam(a), try number(a, boundary.height) });
        try transaction.commit();
        return counts;
    }
};

// Keep insertion lock order identical to Rust's BTreeMap<Table,...>.
const Table = enum { block, delivery, gas, insertion, dispatch, checkpoint };
const Spec = struct { name: []const u8, columns: []const []const u8, now_last: bool = false };
fn spec(table: Table) Spec {
    return switch (table) {
        .block => .{ .name = "block", .columns = &.{ "domain", "hash", "height", "timestamp" } },
        .checkpoint => .{ .name = "scraper_checkpoint", .columns = &.{ "domain", "hash", "height", "timestamp" } },
        .delivery => .{ .name = "delivered_message", .columns = &.{ "domain", "block_hash", "block_number", "transaction_hash", "transaction_index", "log_index", "destination_mailbox", "msg_id", "sequence", "time_created" }, .now_last = true },
        .gas => .{ .name = "gas_payment", .columns = &.{ "domain", "block_hash", "block_number", "transaction_hash", "transaction_index", "log_index", "interchain_gas_paymaster", "msg_id", "destination", "gas_amount", "payment", "origin", "sequence", "time_created" }, .now_last = true },
        .insertion => .{ .name = "merkle_tree_insertion", .columns = &.{ "domain", "block_hash", "block_number", "transaction_hash", "transaction_index", "log_index", "merkle_tree_hook", "message_id", "leaf_index" } },
        .dispatch => .{ .name = "raw_message_dispatch", .columns = &.{ "origin_domain", "origin_block_hash", "origin_block_height", "origin_tx_hash", "transaction_index", "log_index", "origin_mailbox", "msg_id", "destination_domain", "nonce", "sender", "recipient", "msg_body", "message_version", "time_updated" }, .now_last = true },
    };
}
fn headerRow(a: Allocator, domain: u32, header: Header) ![]const pg.Param {
    const row = try a.alloc(pg.Param, 4);
    row[0..4].* = .{ try signed(a, domain), try blob(a, &header.hash), try number(a, header.height), try number(a, header.timestamp) };
    return row;
}
const EventRow = struct { table: Table, values: []const pg.Param };
fn eventRow(a: Allocator, domain: u32, header: Header, event: Event) !EventRow {
    var row: std.ArrayList(pg.Param) = .empty;
    const tx = if (event.tx_hash) |hash| try blob(a, transactionBytes(&hash)) else if (event.data == .dispatch) try blob(a, &zero_hash) else pg.Param{ .value = null, .oid = pg.Oid.bytea, .binary = true };
    try row.appendSlice(a, &.{ try signed(a, domain), try blob(a, &header.hash), try number(a, header.height), tx, try number(a, event.tx_index), try number(a, event.log_index), try blob(a, addressBytes(&event.address)) });
    const table: Table = switch (event.data) {
        .dispatch => |message| blk: {
            try row.appendSlice(a, &.{ try blob(a, &message.id()), try signed(a, message.destination), try signed(a, message.nonce), try blob(a, addressBytes(&message.sender)), try blob(a, addressBytes(&message.recipient)), try blob(a, message.body), .{ .value = try std.fmt.allocPrint(a, "{d}", .{message.version}), .oid = 21 } });
            break :blk .dispatch;
        },
        .delivery => |id| blk: {
            try row.appendSlice(a, &.{ try blob(a, &id), if (event.sequence) |sequence| try number(a, sequence) else .{ .value = null, .oid = pg.Oid.int8 } });
            break :blk .delivery;
        },
        .insertion => |insertion| blk: {
            try row.appendSlice(a, &.{ try blob(a, &insertion.message_id), try signed(a, insertion.index) });
            break :blk .insertion;
        },
        .gas => |gas| blk: {
            try row.appendSlice(a, &.{ try blob(a, &gas.message_id), try signed(a, gas.destination), pg.Param.text(try std.fmt.allocPrint(a, "{d}", .{gas.gas})), pg.Param.text(try std.fmt.allocPrint(a, "{d}", .{gas.payment})), try signed(a, domain), if (event.sequence) |sequence| try number(a, sequence) else .{ .value = null, .oid = pg.Oid.int8 } });
            break :blk .gas;
        },
    };
    return .{ .table = table, .values = row.items };
}
fn insertBatches(connection: *pg.Connection, a: Allocator, table: Table, rows: []const []const pg.Param) !void {
    const schema = spec(table);
    var offset: usize = 0;
    while (offset < rows.len) : (offset += 1000) {
        const batch = rows[offset..@min(rows.len, offset + 1000)];
        var sql: std.ArrayList(u8) = .empty;
        try sql.appendSlice(a, try std.fmt.allocPrint(a, "INSERT INTO {s} ({s}) VALUES ", .{ schema.name, try std.mem.join(a, ",", schema.columns) }));
        var params: std.ArrayList(pg.Param) = .empty;
        for (batch, 0..) |row, row_index| {
            if (row_index != 0) try sql.append(a, ',');
            try sql.append(a, '(');
            var value_index: usize = 0;
            for (schema.columns, 0..) |_, column| {
                if (column != 0) try sql.append(a, ',');
                if (schema.now_last and column == schema.columns.len - 1) {
                    try sql.appendSlice(a, "now()");
                } else {
                    if (value_index >= row.len) return error.InvalidRowWidth;
                    try params.append(a, row[value_index]);
                    value_index += 1;
                    const placeholder = try std.fmt.allocPrint(a, "${d}", .{params.items.len});
                    if ((table == .block or table == .checkpoint) and column == 3)
                        try sql.appendSlice(a, try std.fmt.allocPrint(a, "to_timestamp({s}::bigint) AT TIME ZONE 'UTC'", .{placeholder}))
                    else if (table == .gas and (column == 9 or column == 10))
                        try sql.appendSlice(a, try std.fmt.allocPrint(a, "{s}::text::numeric", .{placeholder}))
                    else
                        try sql.appendSlice(a, placeholder);
                }
            }
            if (value_index != row.len) return error.InvalidRowWidth;
            try sql.append(a, ')');
        }
        if (table == .block) try sql.appendSlice(a, " ON CONFLICT(hash) DO NOTHING");
        try connection.execute(sql.items, params.items);
    }
}
