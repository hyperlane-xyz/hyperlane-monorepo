//! Read-only startup contract from scraper migration::indexes. Never repair
//! catalog state here: interrupted index cutovers require an explicit init-db.
const pg = @import("postgres.zig");

pub fn verifyFrontierIndexes(connection: *pg.Connection) !void {
    // Keep the Source's canonical gas-position predicate exactly. The older
    // transaction-scoped key rejects distinct events at fallback positions.
    {
        var result = try connection.query(
            \\SELECT i.indisvalid AND i.indisready AND i.indisunique
            \\    AND i.indnkeyatts=10 AND i.indnatts=10
            \\    AND pg_get_expr(i.indpred,i.indrelid)='(block_hash IS NOT NULL)'
            \\    AND (SELECT string_agg(pg_get_indexdef(i.indexrelid,n,true),',' ORDER BY n)
            \\         FROM generate_series(1,i.indnkeyatts) n)
            \\        = 'domain,block_hash,COALESCE(transaction_hash, ''\x''::bytea),transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment'
            \\    AS expected
            \\FROM pg_index i WHERE i.indexrelid=to_regclass($1)
        , &.{pg.Param.text("gas_payment_block_log")});
        defer result.deinit();
        if (result.rows() != 1 or !try result.boolean(0, "expected")) return error.InvalidGasPaymentIdentityIndex;
    }
    const Index = struct { name: []const u8, table: []const u8, keys: []const u8, predicate: []const u8, failure: anyerror };
    const indexes = [_]Index{
        .{ .name = "delivery_frontier_unenriched", .table = "delivered_message", .keys = "domain,id", .predicate = "((destination_tx_id IS NULL) AND (block_hash IS NOT NULL))", .failure = error.InvalidDeliveryFrontierIndex },
        .{ .name = "gas_payment_frontier_unenriched", .table = "gas_payment", .keys = "domain,id", .predicate = "((tx_id IS NULL) AND (block_hash IS NOT NULL))", .failure = error.InvalidGasPaymentFrontierIndex },
        .{ .name = "gas_payment_frontier_height", .table = "gas_payment", .keys = "domain,block_number", .predicate = "(block_number IS NOT NULL)", .failure = error.InvalidGasPaymentHeightIndex },
    };
    for (indexes) |index| {
        var result = try connection.query(
            \\SELECT i.indisvalid AND i.indisready
            \\    AND NOT i.indisunique
            \\    AND i.indnkeyatts=2 AND i.indnatts=2
            \\    AND pg_get_expr(i.indpred, i.indrelid) IS NOT DISTINCT FROM $4::text
            \\    AND i.indexprs IS NULL
            \\    AND i.indrelid = $2::regclass AND am.amname = 'btree'
            \\    AND (SELECT string_agg(pg_get_indexdef(i.indexrelid, n, true), ',' ORDER BY n)
            \\         FROM generate_series(1, i.indnkeyatts) n) = $3
            \\    AS expected_index
            \\FROM pg_index i
            \\JOIN pg_class c ON c.oid = i.indexrelid
            \\JOIN pg_am am ON am.oid = c.relam
            \\WHERE i.indexrelid = to_regclass($1)
        , &.{ pg.Param.text(index.name), pg.Param.text(index.table), pg.Param.text(index.keys), pg.Param.text(index.predicate) });
        defer result.deinit();
        if (result.rows() != 1 or !try result.boolean(0, "expected_index")) return index.failure;
    }
    var obsolete = try connection.query("SELECT to_regclass('gas_payment_transaction_log') IS NOT NULL AS present", &.{});
    defer obsolete.deinit();
    if (obsolete.rows() != 1 or try obsolete.boolean(0, "present")) return error.ObsoleteGasPaymentPositionIndex;
}
