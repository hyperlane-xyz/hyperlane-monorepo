//! Port of `scraperdb/tables.ts`: SQL allowlists per public table.
//! TS derives columns from `scraperdb-schema.graphql` at startup; here they are
//! fixed and asserted against the TS dump in `testdata/corpus.json`.
const std = @import("std");

pub const Table = enum {
    domain,
    message_view,
    raw_message_dispatch,

    pub fn spec(self: Table) *const Spec {
        return switch (self) {
            .domain => &domain,
            .message_view => &message_view,
            .raw_message_dispatch => &raw_message_dispatch,
        };
    }

    pub fn name(self: Table) []const u8 {
        return @tagName(self);
    }
};

pub const Spec = struct {
    /// Sorted like JS `Array.prototype.sort` (UTF-16 order; ASCII here).
    columns: []const []const u8,
    column_set: std.StaticStringMap(void),
    primary_key: ?[]const u8,
    relation: ?[]const u8,

    pub fn hasColumn(self: *const Spec, column: []const u8) bool {
        return self.column_set.has(column);
    }
};

fn spec(comptime columns: []const []const u8, primary_key: ?[]const u8, relation: ?[]const u8) Spec {
    @setEvalBranchQuota(100_000);
    comptime var kvs: [columns.len]struct { []const u8 } = undefined;
    inline for (columns, 0..) |column, index| {
        if (index > 0 and !std.mem.lessThan(u8, columns[index - 1], column)) @compileError("columns must be sorted");
        kvs[index] = .{column};
    }
    const frozen = kvs;
    return .{
        .columns = columns,
        .column_set = std.StaticStringMap(void).initComptime(frozen),
        .primary_key = primary_key,
        .relation = relation,
    };
}

const domain = spec(&.{ "chain_id", "id", "is_deprecated", "is_test_net", "name", "native_token", "time_created", "time_updated" }, "id", null);

const message_view = spec(&.{
    "delivery_latency",                   "delivery_occurred_at",                    "delivery_scape_latency",
    "delivery_scraped_at",                "destination_block_hash",                  "destination_block_height",
    "destination_block_id",               "destination_chain_id",                    "destination_domain",
    "destination_domain_id",              "destination_mailbox",                     "destination_tx_cumulative_gas_used",
    "destination_tx_effective_gas_price", "destination_tx_gas_limit",                "destination_tx_gas_price",
    "destination_tx_gas_used",            "destination_tx_hash",                     "destination_tx_id",
    "destination_tx_max_fee_per_gas",     "destination_tx_max_priority_fee_per_gas", "destination_tx_nonce",
    "destination_tx_recipient",           "destination_tx_sender",                   "id",
    "is_delivered",                       "is_provisional",                          "message_body",
    "msg_id",                             "nonce",                                   "num_payments",
    "origin_block_hash",                  "origin_block_height",                     "origin_block_id",
    "origin_chain_id",                    "origin_domain",                           "origin_domain_id",
    "origin_mailbox",                     "origin_tx_cumulative_gas_used",           "origin_tx_effective_gas_price",
    "origin_tx_gas_limit",                "origin_tx_gas_price",                     "origin_tx_gas_used",
    "origin_tx_hash",                     "origin_tx_id",                            "origin_tx_max_fee_per_gas",
    "origin_tx_max_priority_fee_per_gas", "origin_tx_nonce",                         "origin_tx_recipient",
    "origin_tx_sender",                   "recipient",                               "send_occurred_at",
    "send_scape_latency",                 "send_scraped_at",                         "sender",
    "total_gas_amount",                   "total_payment",
}, null, null);

const raw_message_dispatch = spec(&.{
    "destination_domain", "id",                  "msg_body",      "msg_id",         "nonce",
    "origin_block_hash",  "origin_block_height", "origin_domain", "origin_mailbox", "origin_tx_hash",
    "recipient",          "sender",              "time_created",
}, "id", "confirmed_raw_message_dispatch");

/// `quoteIdentifier`: double-quote and escape embedded quotes.
pub fn writeQuoted(writer: *std.Io.Writer, identifier: []const u8) std.Io.Writer.Error!void {
    try writer.writeByte('"');
    var rest = identifier;
    while (std.mem.indexOfScalar(u8, rest, '"')) |index| {
        try writer.writeAll(rest[0 .. index + 1]);
        try writer.writeByte('"');
        rest = rest[index + 1 ..];
    }
    try writer.writeAll(rest);
    try writer.writeByte('"');
}

test "quoted identifiers escape embedded quotes" {
    var buffer: [64]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    try writeQuoted(&writer, "we\"ird\"");
    try std.testing.expectEqualStrings("\"we\"\"ird\"\"\"", writer.buffered());
}
