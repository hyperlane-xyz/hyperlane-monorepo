//! Native PostgreSQL enrichment/reconciliation storage on the production schema.
//! One borrowed connection per job. All user/chain values are bound parameters;
//! all dynamic table/column names below come from closed stream enums.
const std = @import("std");
const pg = @import("../../db/postgres.zig");
const protocol = @import("../../protocol/root.zig");
const src = @import("source.zig");
const enrich = @import("enrichment.zig");
const ccr = @import("ccr.zig");
const Allocator = std.mem.Allocator;
/// block_id/transaction_id are retained rows observed and identity-checked by
/// the same page query; null means not yet stored at that snapshot.
pub const RawDispatch = struct { id: i64, created_seconds: i64, message_id: src.Hash, message: protocol.Message, meta: enrich.Meta, block_id: ?i64 = null, transaction_id: ?i64 = null };
pub const Storable = struct { message: protocol.Message, transaction_id: ?i64, id_override: ?src.Hash = null };
fn integer(allocator: Allocator, value: anytype) !pg.Param {
    return .{ .value = try std.fmt.allocPrint(allocator, "{d}", .{value}), .oid = pg.Oid.int8 };
}
fn domainParam(allocator: Allocator, domain: u32) !pg.Param {
    return .{ .value = try std.fmt.allocPrint(allocator, "{d}", .{@as(i32, @bitCast(domain))}), .oid = pg.Oid.int4 };
}
fn numeric(allocator: Allocator, value: ?u256) !pg.Param {
    return .{ .value = if (value) |amount| try std.fmt.allocPrint(allocator, "{d}", .{amount}) else null, .oid = pg.Oid.numeric };
}
fn bytesAddress(address: *const src.Hash) []const u8 {
    return if (std.mem.allEqual(u8, address[0..12], 0)) address[12..] else address;
}
fn bytesTxn(hash: *const [64]u8) []const u8 {
    return if (std.mem.allEqual(u8, hash[0..32], 0)) hash[32..] else hash;
}
fn hashBytes(allocator: Allocator, result: pg.Result, row: usize, column: [:0]const u8) !src.Hash {
    const raw = try result.bytea(allocator, row, column);
    if (raw.len != 32) return error.InvalidStoredScraperHash;
    return raw[0..32].*;
}
fn addressBytes(allocator: Allocator, result: pg.Result, row: usize, column: [:0]const u8) !src.Hash {
    const raw = try result.bytea(allocator, row, column);
    if (raw.len != 20 and raw.len != 32) return error.InvalidStoredScraperAddress;
    var out: src.Hash = .{0} ** 32;
    @memcpy(out[32 - raw.len ..], raw);
    return out;
}
fn txBytes(allocator: Allocator, result: pg.Result, row: usize, column: [:0]const u8) ![64]u8 {
    const raw = try result.bytea(allocator, row, column);
    if (raw.len != 32 and raw.len != 64) return error.InvalidStoredScraperTxHash;
    var out: [64]u8 = .{0} ** 64;
    @memcpy(out[64 - raw.len ..], raw);
    return out;
}
fn unsignedDomain(value: i64) !u32 {
    return @bitCast(std.math.cast(i32, value) orelse return error.InvalidStoredScraperDomain);
}
fn nonnegative(value: i64) !u64 {
    return std.math.cast(u64, value) orelse error.InvalidStoredScraperHeight;
}
/// text[] literal of stored transaction-hash hex; decoded server-side.
fn hashArray(allocator: Allocator, metas: []const enrich.Meta) ![]const u8 {
    var list: std.ArrayList(u8) = .empty;
    try list.append(allocator, '{');
    for (metas, 0..) |*meta, index| {
        if (index != 0) try list.append(allocator, ',');
        const bytes = bytesTxn(&meta.tx_hash);
        const start = list.items.len;
        try list.resize(allocator, start + bytes.len * 2);
        _ = std.fmt.bufPrint(list.items[start..], "{x}", .{bytes}) catch unreachable;
    }
    try list.append(allocator, '}');
    return list.items;
}
/// Joined retained block/transaction identity for one event row, checked
/// exactly like knownBlock/knownTransaction (same mismatch errors).
const Known = struct { block_id: ?i64 = null, transaction_id: ?i64 = null };
const known_columns = "kb.id AS known_block_id,kb.height AS known_block_height,kt.id AS known_tx_id,ktb.domain AS known_tx_domain,ktb.hash AS known_tx_block_hash,ktb.height AS known_tx_height";
fn knownJoins(comptime block_hash: []const u8, comptime tx_hash: []const u8) []const u8 {
    return " LEFT JOIN block kb ON kb.domain=$1 AND kb.hash=" ++ block_hash ++ " LEFT JOIN \"transaction\" kt ON kt.hash=" ++ tx_hash ++ " LEFT JOIN block ktb ON ktb.id=kt.block_id";
}
fn known(allocator: Allocator, domain: u32, result: pg.Result, row: usize, meta: enrich.Meta) !Known {
    var out: Known = .{};
    if (try result.value(row, try result.column("known_block_id")) != null) {
        if (try nonnegative(try result.integer(row, "known_block_height")) != meta.block_number) return error.ScraperStoredBlockMismatch;
        out.block_id = try result.integer(row, "known_block_id");
    }
    if (try result.value(row, try result.column("known_tx_id")) != null) {
        if (try unsignedDomain(try result.integer(row, "known_tx_domain")) != domain or try nonnegative(try result.integer(row, "known_tx_height")) != meta.block_number or !std.mem.eql(u8, &try hashBytes(allocator, result, row, "known_tx_block_hash"), &meta.block_hash)) return error.ScraperStoredTransactionMismatch;
        out.transaction_id = try result.integer(row, "known_tx_id");
    }
    return out;
}
fn table(stream: enrich.Stream) []const u8 {
    return if (stream == .delivery) "delivered_message" else "gas_payment";
}
fn txColumn(stream: enrich.Stream) []const u8 {
    return if (stream == .delivery) "destination_tx_id" else "tx_id";
}
pub const Store = struct {
    connection: *pg.Connection,
    domain: u32,
    mailbox: src.Hash,
    /// Set server-side statement and lock deadlines on a newly owned connection.
    pub fn configure(self: Store, timeout_ms: u32) !void {
        try self.connection.configureSessionTimeouts(timeout_ms);
    }
    pub fn pendingReceipts(self: Store, allocator: Allocator, stream: enrich.Stream, after: i64, limit: usize) ![]enrich.Row {
        if (after < 0 or limit == 0 or limit > 100) return error.InvalidScraperReceiptPage;
        const sql = try std.fmt.allocPrint(allocator, "SELECT id,block_number,block_hash,transaction_hash FROM confirmed_{s} WHERE domain=$1 AND {s} IS NULL AND id>$2 AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL ORDER BY id LIMIT $3", .{ table(stream), txColumn(stream) });
        var result = try self.connection.query(sql, &.{ try domainParam(allocator, self.domain), try integer(allocator, after), try integer(allocator, limit) });
        defer result.deinit();
        const rows = try allocator.alloc(enrich.Row, result.rows());
        for (rows, 0..) |*row, index| row.* = .{ .id = try result.integer(index, "id"), .meta = .{ .block_number = try nonnegative(try result.integer(index, "block_number")), .block_hash = try hashBytes(allocator, result, index, "block_hash"), .tx_hash = try txBytes(allocator, result, index, "transaction_hash") } };
        return rows;
    }
    /// pendingReceipts plus each row's retained block and known transaction,
    /// identity-checked, in one round trip (was 1 + 2 per row).
    pub fn receiptCandidates(self: Store, allocator: Allocator, stream: enrich.Stream, after: i64, limit: usize) ![]enrich.Candidate {
        if (after < 0 or limit == 0 or limit > 100) return error.InvalidScraperReceiptPage;
        const sql = try std.fmt.allocPrint(allocator, "SELECT e.id,e.block_number,e.block_hash,e.transaction_hash," ++ known_columns ++ " FROM (SELECT id,block_number,block_hash,transaction_hash FROM confirmed_{s} WHERE domain=$1 AND {s} IS NULL AND id>$2 AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL ORDER BY id LIMIT $3) e" ++ comptime knownJoins("e.block_hash", "e.transaction_hash") ++ " ORDER BY e.id", .{ table(stream), txColumn(stream) });
        var result = try self.connection.query(sql, &.{ try domainParam(allocator, self.domain), try integer(allocator, after), try integer(allocator, limit) });
        defer result.deinit();
        const rows = try allocator.alloc(enrich.Candidate, result.rows());
        for (rows, 0..) |*row, index| {
            const meta: enrich.Meta = .{ .block_number = try nonnegative(try result.integer(index, "block_number")), .block_hash = try hashBytes(allocator, result, index, "block_hash"), .tx_hash = try txBytes(allocator, result, index, "transaction_hash") };
            const ids = try known(allocator, self.domain, result, index, meta);
            row.* = .{ .row = .{ .id = try result.integer(index, "id"), .meta = meta }, .block_id = ids.block_id, .transaction_id = ids.transaction_id };
        }
        return rows;
    }
    /// One round trip: guarded insert, optional page link and the same
    /// identity verification as storeTransaction, pipelined in one implicit
    /// transaction. Concurrent winners are verified, never duplicated.
    pub fn persistTransaction(self: Store, block_id: i64, txn: enrich.Txn, link: ?enrich.LinkRange) !enrich.Persisted {
        if (block_id <= 0) return error.InvalidStoredScraperBlockId;
        const meta: enrich.Meta = .{ .block_number = txn.block_number, .block_hash = txn.block_hash, .tx_hash = txn.hash };
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const hash = pg.Param.bytes(bytesTxn(&txn.hash));
        const block = [_]pg.Param{ try integer(a, block_id), try domainParam(a, self.domain), pg.Param.bytes(&txn.block_hash), try integer(a, txn.block_number) };
        const insert_params = [_]pg.Param{ hash, block[0], try numeric(a, txn.gas_limit), try numeric(a, txn.max_priority_fee), try numeric(a, txn.max_fee), try numeric(a, txn.gas_price), try numeric(a, txn.effective_gas_price), try integer(a, @as(i64, @bitCast(txn.nonce))), pg.Param.bytes(bytesAddress(&txn.sender)), .{ .value = if (txn.recipient) |*recipient| bytesAddress(recipient) else null, .oid = pg.Oid.bytea, .binary = true }, try numeric(a, txn.gas_used), try numeric(a, txn.cumulative_gas_used), .{ .value = txn.raw_input, .oid = pg.Oid.bytea, .binary = true }, block[1], block[2], block[3] };
        const verify_params = [_]pg.Param{ hash, block[0], block[1], block[2], block[3] };
        var statements: [3]pg.Statement = undefined;
        var count: usize = 0;
        statements[count] = .{ .sql = "INSERT INTO \"transaction\"(hash,block_id,gas_limit,max_priority_fee_per_gas,max_fee_per_gas,gas_price,effective_gas_price,nonce,sender,recipient,gas_used,cumulative_gas_used,raw_input_data,time_created) SELECT $1,b.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now() FROM block b WHERE b.id=$2 AND b.domain=$14 AND b.hash=$15 AND b.height=$16 ON CONFLICT(hash) DO NOTHING", .params = &insert_params };
        count += 1;
        const link_index = count;
        if (link) |range| {
            if (range.after < 0 or range.through < range.after) return error.InvalidScraperReceiptPage;
            statements[count] = .{ .sql = try linkSql(a, range.stream), .params = try a.dupe(pg.Param, &.{ try domainParam(a, self.domain), try integer(a, range.after), try integer(a, range.through) }) };
            count += 1;
        }
        const verify_index = count;
        statements[count] = .{ .sql = "SELECT kt.id AS known_tx_id,ktb.domain AS known_tx_domain,ktb.hash AS known_tx_block_hash,ktb.height AS known_tx_height,EXISTS(SELECT 1 FROM block g WHERE g.id=$2 AND g.domain=$3 AND g.hash=$4 AND g.height=$5) AS block_ok FROM (SELECT 1) one LEFT JOIN \"transaction\" kt ON kt.hash=$1 LEFT JOIN block ktb ON ktb.id=kt.block_id", .params = &verify_params };
        count += 1;
        var results: [3]pg.Result = undefined;
        try self.connection.pipeline(statements[0..count], results[0..count]);
        defer for (results[0..count]) |*result| result.deinit();
        const verified = results[verify_index];
        if (!try verified.boolean(0, "block_ok")) return error.ScraperStoredBlockMismatch;
        if (try verified.value(0, try verified.column("known_tx_id")) == null) return error.ScraperTransactionNotPersisted;
        if (try unsignedDomain(try verified.integer(0, "known_tx_domain")) != self.domain or try nonnegative(try verified.integer(0, "known_tx_height")) != meta.block_number or !std.mem.eql(u8, &try hashBytes(a, verified, 0, "known_tx_block_hash"), &meta.block_hash)) return error.ScraperStoredTransactionMismatch;
        return .{ .id = try verified.integer(0, "known_tx_id"), .linked = if (link != null) try results[link_index].affected() else 0 };
    }
    /// Links the page and counts rows whose transaction is still unknown, in
    /// one statement (was 1 + 1 per row).
    pub fn linkReceiptPage(self: Store, stream: enrich.Stream, after: i64, through: i64, rows: []const enrich.Row) !enrich.Linked {
        if (after < 0 or through < after or rows.len > 100) return error.InvalidScraperReceiptPage;
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const metas = try a.alloc(enrich.Meta, rows.len);
        for (rows, metas) |row, *meta| meta.* = row.meta;
        const sql = try std.fmt.allocPrint(a, "WITH linked AS ({s} RETURNING 1) SELECT (SELECT count(*) FROM linked) AS linked,(SELECT count(*) FROM unnest($4::text[]) h(hash) WHERE NOT EXISTS(SELECT 1 FROM \"transaction\" t WHERE t.hash=decode(h.hash,'hex'))) AS pending", .{try linkSql(a, stream)});
        var result = try self.connection.query(sql, &.{ try domainParam(a, self.domain), try integer(a, after), try integer(a, through), pg.Param.text(try hashArray(a, metas)) });
        defer result.deinit();
        return .{ .linked = try nonnegative(try result.integer(0, "linked")), .pending = std.math.cast(usize, try result.integer(0, "pending")) orelse return error.InvalidScraperReceiptPage };
    }
    /// knownTransaction for many identities in one round trip; same checks.
    pub fn knownTransactions(self: Store, allocator: Allocator, metas: []const enrich.Meta) ![]?i64 {
        const ids = try allocator.alloc(?i64, metas.len);
        errdefer allocator.free(ids);
        @memset(ids, null);
        if (metas.len == 0) return ids;
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query("SELECT h.ord,kt.id AS known_tx_id,ktb.domain AS known_tx_domain,ktb.hash AS known_tx_block_hash,ktb.height AS known_tx_height FROM unnest($1::text[]) WITH ORDINALITY h(hash,ord) JOIN \"transaction\" kt ON kt.hash=decode(h.hash,'hex') JOIN block ktb ON ktb.id=kt.block_id", &.{pg.Param.text(try hashArray(a, metas))});
        defer result.deinit();
        for (0..result.rows()) |row| {
            const ordinal = std.math.cast(usize, try result.integer(row, "ord")) orelse return error.InvalidStoredScraperTransaction;
            if (ordinal == 0 or ordinal > metas.len) return error.InvalidStoredScraperTransaction;
            const meta = metas[ordinal - 1];
            if (try unsignedDomain(try result.integer(row, "known_tx_domain")) != self.domain or try nonnegative(try result.integer(row, "known_tx_height")) != meta.block_number or !std.mem.eql(u8, &try hashBytes(a, result, row, "known_tx_block_hash"), &meta.block_hash)) return error.ScraperStoredTransactionMismatch;
            ids[ordinal - 1] = try result.integer(row, "known_tx_id");
        }
        return ids;
    }
    pub fn ensureBlock(self: Store, header: src.Header) !i64 {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        try self.connection.execute("INSERT INTO block(domain,hash,height,timestamp,time_created) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC',now()) ON CONFLICT(hash) DO NOTHING", &.{ try domainParam(a, self.domain), pg.Param.bytes(&header.hash), try integer(a, header.height), try integer(a, header.timestamp) });
        return try self.knownBlock(.{ .block_number = header.height, .block_hash = header.hash, .tx_hash = .{0} ** 64 }) orelse error.ScraperBlockNotPersisted;
    }
    pub fn knownBlock(self: Store, meta: enrich.Meta) !?i64 {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query("SELECT id,height FROM block WHERE domain=$1 AND hash=$2", &.{ try domainParam(a, self.domain), pg.Param.bytes(&meta.block_hash) });
        defer result.deinit();
        if (result.rows() == 0) return null;
        if (result.rows() != 1 or try nonnegative(try result.integer(0, "height")) != meta.block_number) return error.ScraperStoredBlockMismatch;
        return try result.integer(0, "id");
    }
    pub fn knownTransaction(self: Store, meta: enrich.Meta) !?i64 {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query("SELECT t.id,b.domain,b.hash,b.height FROM \"transaction\" t JOIN block b ON b.id=t.block_id WHERE t.hash=$1", &.{pg.Param.bytes(bytesTxn(&meta.tx_hash))});
        defer result.deinit();
        if (result.rows() == 0) return null;
        if (result.rows() != 1 or try unsignedDomain(try result.integer(0, "domain")) != self.domain or try nonnegative(try result.integer(0, "height")) != meta.block_number or !std.mem.eql(u8, &try hashBytes(a, result, 0, "hash"), &meta.block_hash)) return error.ScraperStoredTransactionMismatch;
        return try result.integer(0, "id");
    }
    pub fn storeTransaction(self: Store, block_id: i64, txn: enrich.Txn) !void {
        if (block_id <= 0) return error.InvalidStoredScraperBlockId;
        const meta: enrich.Meta = .{ .block_number = txn.block_number, .block_hash = txn.block_hash, .tx_hash = txn.hash };
        if (try self.knownBlock(meta) != block_id) return error.ScraperStoredBlockMismatch;
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        try self.connection.execute("INSERT INTO \"transaction\"(hash,block_id,gas_limit,max_priority_fee_per_gas,max_fee_per_gas,gas_price,effective_gas_price,nonce,sender,recipient,gas_used,cumulative_gas_used,raw_input_data,time_created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) ON CONFLICT(hash) DO NOTHING", &.{ pg.Param.bytes(bytesTxn(&txn.hash)), try integer(a, block_id), try numeric(a, txn.gas_limit), try numeric(a, txn.max_priority_fee), try numeric(a, txn.max_fee), try numeric(a, txn.gas_price), try numeric(a, txn.effective_gas_price), try integer(a, @as(i64, @bitCast(txn.nonce))), pg.Param.bytes(bytesAddress(&txn.sender)), .{ .value = if (txn.recipient) |*recipient| bytesAddress(recipient) else null, .oid = pg.Oid.bytea, .binary = true }, try numeric(a, txn.gas_used), try numeric(a, txn.cumulative_gas_used), .{ .value = txn.raw_input, .oid = pg.Oid.bytea, .binary = true } });
        _ = try self.knownTransaction(meta) orelse return error.ScraperTransactionNotPersisted;
    }
    fn linkSql(a: Allocator, stream: enrich.Stream) ![]const u8 {
        return std.fmt.allocPrint(a, "UPDATE {s} e SET {s}=t.id FROM \"transaction\" t JOIN block b ON b.id=t.block_id WHERE e.domain=$1 AND e.id>$2 AND e.id<=$3 AND (e.block_number IS NULL OR e.block_number<=COALESCE((SELECT h.confirmed_height FROM scraper_head h WHERE h.domain=e.domain),9223372036854775807)) AND e.{s} IS NULL AND t.hash=e.transaction_hash AND b.domain=e.domain AND b.hash=e.block_hash", .{ table(stream), txColumn(stream), txColumn(stream) });
    }
    pub fn linkReceipts(self: Store, stream: enrich.Stream, after: i64, through: i64) !u64 {
        if (after < 0 or through < after) return error.InvalidScraperReceiptPage;
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query(try linkSql(a, stream), &.{ try domainParam(a, self.domain), try integer(a, after), try integer(a, through) });
        defer result.deinit();
        return result.affected();
    }
    pub fn pendingAge(self: Store, stream: enrich.Stream) !f64 {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const sql = try std.fmt.allocPrint(a, "SELECT coalesce((SELECT greatest(0,extract(epoch FROM ((clock_timestamp() AT TIME ZONE 'UTC')-time_created))::double precision) FROM confirmed_{s} WHERE domain=$1 AND {s} IS NULL AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL ORDER BY id LIMIT 1),0::double precision) AS age", .{ table(stream), txColumn(stream) });
        var result = try self.connection.query(sql, &.{try domainParam(a, self.domain)});
        defer result.deinit();
        if (result.rows() != 1) return error.MissingScraperBacklogAge;
        const age = try std.fmt.parseFloat(f64, try result.required(0, "age"));
        if (!std.math.isFinite(age) or age < 0) return error.InvalidScraperBacklogAge;
        return age;
    }
    pub fn rawFrontier(self: Store) !i64 {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query("SELECT coalesce(max(id),0) AS id FROM confirmed_raw_message_dispatch WHERE origin_domain=$1 AND origin_mailbox=$2 AND msg_body IS NOT NULL", &.{ try domainParam(a, self.domain), pg.Param.bytes(bytesAddress(&self.mailbox)) });
        defer result.deinit();
        return try result.integer(0, "id");
    }
    pub fn rawPage(self: Store, allocator: Allocator, after: i64, through: i64, limit: usize) ![]RawDispatch {
        if (after < 0 or through < after or limit == 0 or limit > 100) return error.InvalidScraperReconciliationPage;
        var result = try self.connection.query("SELECT r.*," ++ known_columns ++ " FROM (SELECT r.*,extract(epoch FROM r.time_created)::bigint AS created_seconds FROM confirmed_raw_message_dispatch r LEFT JOIN message m ON m.origin=r.origin_domain AND m.origin_mailbox=r.origin_mailbox AND m.nonce=r.nonce WHERE r.origin_domain=$1 AND r.origin_mailbox=$2 AND r.msg_body IS NOT NULL AND m.id IS NULL AND r.id>$3 AND r.id<=$4 ORDER BY r.id LIMIT $5) r" ++ comptime knownJoins("r.origin_block_hash", "r.origin_tx_hash") ++ " ORDER BY r.id", &.{ try domainParam(allocator, self.domain), pg.Param.bytes(bytesAddress(&self.mailbox)), try integer(allocator, after), try integer(allocator, through), try integer(allocator, limit) });
        defer result.deinit();
        const rows = try allocator.alloc(RawDispatch, result.rows());
        for (rows, 0..) |*row, index| row.* = try decodeRaw(allocator, self.domain, result, index);
        return rows;
    }
    pub fn rawByIds(self: Store, allocator: Allocator, ids: []const i64) ![]RawDispatch {
        if (ids.len > 100) return error.InvalidScraperReconciliationPage;
        if (ids.len == 0) return allocator.alloc(RawDispatch, 0);
        var list: std.ArrayList(u8) = .empty;
        try list.append(allocator, '{');
        for (ids, 0..) |id, index| {
            if (id <= 0) return error.InvalidRawDispatchId;
            if (index != 0) try list.append(allocator, ',');
            try list.appendSlice(allocator, try std.fmt.allocPrint(allocator, "{d}", .{id}));
        }
        try list.append(allocator, '}');
        var result = try self.connection.query("SELECT r.*," ++ known_columns ++ " FROM (SELECT r.*,extract(epoch FROM r.time_created)::bigint AS created_seconds FROM confirmed_raw_message_dispatch r LEFT JOIN message m ON m.origin=r.origin_domain AND m.origin_mailbox=r.origin_mailbox AND m.nonce=r.nonce WHERE r.origin_domain=$1 AND r.origin_mailbox=$2 AND r.msg_body IS NOT NULL AND m.id IS NULL AND r.id=ANY($3::bigint[])) r" ++ comptime knownJoins("r.origin_block_hash", "r.origin_tx_hash") ++ " ORDER BY r.id", &.{ try domainParam(allocator, self.domain), pg.Param.bytes(bytesAddress(&self.mailbox)), pg.Param.text(list.items) });
        defer result.deinit();
        const rows = try allocator.alloc(RawDispatch, result.rows());
        for (rows, 0..) |*row, index| row.* = try decodeRaw(allocator, self.domain, result, index);
        return rows;
    }
    pub fn ccrCursor(self: Store, default_from: u64) !u64 {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query("SELECT max(height) AS height FROM cursor WHERE domain=$1 AND event_type='ccr_swap'", &.{try domainParam(a, self.domain)});
        defer result.deinit();
        const value = try result.value(0, try result.column("height"));
        return if (value) |text| try nonnegative(try std.fmt.parseInt(i64, text, 10)) else default_from;
    }
    pub fn saveCcrCursor(self: Store, height: u64) !void {
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var result = try self.connection.query("INSERT INTO cursor(domain,event_type,height,time_created) SELECT $1,'ccr_swap',$2,now() WHERE $2<=(SELECT confirmed_height FROM scraper_head WHERE domain=$1) ON CONFLICT(domain,event_type) DO UPDATE SET height=greatest(cursor.height,excluded.height),time_created=excluded.time_created", &.{ try domainParam(a, self.domain), try integer(a, height) });
        defer result.deinit();
        if (try result.affected() != 1) return error.CcrBeyondConfirmed;
    }
    pub fn storeCcr(self: Store, swaps: []const ccr.Swap) !u64 {
        if (swaps.len == 0) return 0;
        if (swaps.len > 10000) return error.CcrEventLimit;
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        // No partial writes or synthetic nonce allocation before all supported
        // siblings have durable transaction metadata (one batched lookup).
        const metas = try a.alloc(enrich.Meta, swaps.len);
        for (swaps, metas) |swap, *meta| {
            if (swap.domain != self.domain) return error.WrongCcrDomain;
            meta.* = swap.meta;
        }
        const transactions = try self.knownTransactions(a, metas);
        for (swaps, transactions) |swap, *txn| {
            if (std.mem.allEqual(u8, &swap.meta.tx_hash, 0)) {
                txn.* = null;
                continue;
            }
            if (txn.* == null) return error.MissingCcrEnrichment;
        }
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        try self.connection.execute("SELECT pg_advisory_xact_lock($1)", &.{try integer(a, self.domain)});
        var frontier = try self.connection.query("SELECT confirmed_height FROM scraper_head WHERE domain=$1 FOR SHARE", &.{try domainParam(a, self.domain)});
        defer frontier.deinit();
        if (frontier.rows() != 1) return error.MissingScraperHead;
        const confirmed = try nonnegative(try frontier.integer(0, "confirmed_height"));
        var count: u64 = 0;
        for (swaps, transactions) |swap, txn| {
            const txn_id = txn orelse continue;
            if (swap.meta.block_number > confirmed) return error.CcrBeyondConfirmed;
            const id = try ccr.syntheticId(swap.meta.tx_hash, swap.log_index);
            var presence = try self.connection.query("SELECT EXISTS(SELECT 1 FROM delivered_message WHERE msg_id=$1) AS delivery FROM message WHERE msg_id=$1", &.{pg.Param.bytes(&id)});
            defer presence.deinit();
            if (presence.rows() > 1) return error.DuplicateCcrMessage;
            if (presence.rows() == 1 and try presence.boolean(0, "delivery")) continue;
            if (presence.rows() == 0) {
                var nonce_row = try self.connection.query("SELECT nonce FROM message WHERE origin=$1 AND origin_mailbox=$2 ORDER BY nonce DESC LIMIT 1", &.{ try domainParam(a, self.domain), pg.Param.bytes(bytesAddress(&swap.source_router)) });
                defer nonce_row.deinit();
                const nonce: u32 = if (nonce_row.rows() == 0) 0 else try std.math.add(u32, try unsignedDomain(try nonce_row.integer(0, "nonce")), 1);
                var body: [64]u8 = undefined;
                @memcpy(body[0..32], &swap.recipient);
                std.mem.writeInt(u256, body[32..64], swap.amount, .big);
                try self.connection.execute("INSERT INTO message(msg_id,origin,destination,nonce,sender,recipient,msg_body,origin_mailbox,origin_tx_id,time_created) VALUES($1,$2,$2,$3,$4,$5,$6,$4,$7,now())", &.{ pg.Param.bytes(&id), try domainParam(a, self.domain), try domainParam(a, nonce), pg.Param.bytes(bytesAddress(&swap.source_router)), pg.Param.bytes(bytesAddress(&swap.destination_router)), pg.Param.bytes(&body), try integer(a, txn_id) });
            }
            try self.connection.execute("INSERT INTO delivered_message(msg_id,domain,destination_mailbox,destination_tx_id,time_created) VALUES($1,$2,$3,$4,now()) ON CONFLICT(msg_id) DO UPDATE SET domain=excluded.domain,destination_mailbox=excluded.destination_mailbox,destination_tx_id=coalesce(excluded.destination_tx_id,delivered_message.destination_tx_id)", &.{ pg.Param.bytes(&id), try domainParam(a, self.domain), pg.Param.bytes(bytesAddress(&swap.destination_router)), try integer(a, txn_id) });
            count += 1;
        }
        try transaction.commit();
        return count;
    }
    pub fn storeMessages(self: Store, mailbox: src.Hash, messages: []const Storable) !u64 {
        if (messages.len == 0) return 0;
        if (messages.len > 10000) return error.ScraperMessageBatchTooLarge;
        var arena = std.heap.ArenaAllocator.init(self.connection.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var unique = std.AutoHashMap(u64, void).init(a);
        for (messages) |row| {
            const entry = try unique.getOrPut(@as(u64, row.message.origin) << 32 | row.message.nonce);
            if (entry.found_existing) return error.DuplicateScraperMessageConflict;
        }
        var transaction = try self.connection.begin();
        defer transaction.deinit();
        var total: u64 = 0;
        var offset: usize = 0;
        while (offset < messages.len) {
            const chunk = messages[offset..@min(offset + 3250, messages.len)];
            var sql: std.ArrayList(u8) = .empty;
            try sql.appendSlice(a, "INSERT INTO message(msg_id,origin,destination,nonce,sender,recipient,msg_body,origin_mailbox,origin_tx_id,time_created) VALUES ");
            var params: std.ArrayList(pg.Param) = .empty;
            for (chunk, 0..) |row, index| {
                if (index != 0) try sql.append(a, ',');
                const n = params.items.len + 1;
                try sql.appendSlice(a, try std.fmt.allocPrint(a, "(${d},${d},${d},${d},${d},${d},${d},${d},${d},now())", .{ n, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7, n + 8 }));
                const msg = row.message;
                const id = try a.create(src.Hash);
                id.* = row.id_override orelse msg.id();
                try params.appendSlice(a, &.{ pg.Param.bytes(id), try domainParam(a, msg.origin), try domainParam(a, msg.destination), try domainParam(a, msg.nonce), pg.Param.bytes(try a.dupe(u8, bytesAddress(&msg.sender))), pg.Param.bytes(try a.dupe(u8, bytesAddress(&msg.recipient))), .{ .value = if (msg.body.len == 0) null else msg.body, .oid = pg.Oid.bytea, .binary = true }, pg.Param.bytes(bytesAddress(&mailbox)), .{ .value = if (row.transaction_id) |txid| try std.fmt.allocPrint(a, "{d}", .{txid}) else null, .oid = pg.Oid.int8 } });
            }
            const base = try a.dupe(u8, sql.items);
            try sql.appendSlice(a, " ON CONFLICT(origin,origin_mailbox,nonce) DO NOTHING");
            var inserted = try self.connection.query(sql.items, params.items);
            defer inserted.deinit();
            const count = try inserted.affected();
            total = try std.math.add(u64, total, count);
            if (count != chunk.len) {
                const replay = try std.fmt.allocPrint(a, "{s} ON CONFLICT(origin,origin_mailbox,nonce) DO UPDATE SET destination=excluded.destination,sender=excluded.sender,recipient=excluded.recipient,msg_body=excluded.msg_body,origin_tx_id=coalesce(excluded.origin_tx_id,message.origin_tx_id)", .{base});
                try self.connection.execute(replay, params.items);
            }
            offset += chunk.len;
        }
        try transaction.commit();
        return total;
    }
};
fn decodeRaw(a: Allocator, domain: u32, result: pg.Result, index: usize) !RawDispatch {
    var row: RawDispatch = .{ .id = try result.integer(index, "id"), .created_seconds = try result.integer(index, "created_seconds"), .message_id = try hashBytes(a, result, index, "msg_id"), .message = .{ .version = 3, .nonce = try unsignedDomain(try result.integer(index, "nonce")), .origin = try unsignedDomain(try result.integer(index, "origin_domain")), .destination = try unsignedDomain(try result.integer(index, "destination_domain")), .sender = try addressBytes(a, result, index, "sender"), .recipient = try addressBytes(a, result, index, "recipient"), .body = try result.bytea(a, index, "msg_body") }, .meta = .{ .block_number = try nonnegative(try result.integer(index, "origin_block_height")), .block_hash = try hashBytes(a, result, index, "origin_block_hash"), .tx_hash = try txBytes(a, result, index, "origin_tx_hash") } };
    if (!std.mem.allEqual(u8, &row.meta.tx_hash, 0) and !std.mem.allEqual(u8, &row.meta.block_hash, 0)) {
        const ids = try known(a, domain, result, index, row.meta);
        row.block_id = ids.block_id;
        row.transaction_id = ids.transaction_id;
    }
    return row;
}
