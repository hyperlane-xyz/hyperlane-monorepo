//! Existing Rust TypedDB keys: domain NAME + '_' + exact table prefix + Encode(key).
const std = @import("std");

pub const Table = enum {
    message_id,
    message_dispatched_block_number,
    message,
    nonce_processed,
    gas_payment_by_sequence,
    gas_payment_block_by_sequence,
    highest_seen_message_nonce,
    gas_payment_for_message_id,
    gas_payment_meta_processed,
    gas_expenditure_for_message_id,
    status_by_message_id,
    pending_message_retry_count,
    pending_message_retry_state,
    pending_message_by_destination,
    pending_message_index_migration_complete,
    terminally_dropped_message_by_id,
    merkle_tree_insertion,
    merkle_leaf_index_by_message_id,
    merkle_tree_insertion_block_number,
    latest_indexed_gas_payment_block,
    payload_uuids_by_message_id,
    message_dispatched_tx_hash,
    message_backward_cursor,
    gas_payment_backward_cursor,
    merkle_tree_insertion_backward_cursor,

    pub fn prefix(self: Table) []const u8 {
        return switch (self) {
            .message_id => "message_id_",
            .message_dispatched_block_number => "message_dispatched_block_number_",
            .message => "message_",
            .nonce_processed => "nonce_processed_",
            .gas_payment_by_sequence => "gas_payment_by_sequence_",
            .gas_payment_block_by_sequence => "gas_payment_block_by_sequence_",
            .highest_seen_message_nonce => "highest_seen_message_nonce_",
            .gas_payment_for_message_id => "gas_payment_sequence_for_message_id_v2_",
            .gas_payment_meta_processed => "gas_payment_meta_processed_v3_",
            .gas_expenditure_for_message_id => "gas_expenditure_for_message_id_v2_",
            .status_by_message_id => "status_by_message_id_",
            .pending_message_retry_count => "pending_message_retry_count_for_message_id_",
            .pending_message_retry_state => "pending_message_retry_state_for_message_id_v1_",
            .pending_message_by_destination => "pending_message_by_destination_v1_",
            .pending_message_index_migration_complete => "pending_message_index_migration_complete_v1_",
            .terminally_dropped_message_by_id => "terminally_dropped_message_by_id_v1_",
            .merkle_tree_insertion => "merkle_tree_insertion_",
            .merkle_leaf_index_by_message_id => "merkle_leaf_index_by_message_id_",
            .merkle_tree_insertion_block_number => "merkle_tree_insertion_block_number_by_leaf_index_",
            .latest_indexed_gas_payment_block => "latest_indexed_gas_payment_block",
            .payload_uuids_by_message_id => "payload_uuids_by_message_id_",
            .message_dispatched_tx_hash => "message_dispatched_tx_hash_by_message_id_",
            .message_backward_cursor => "message_backward_cursor_v2_",
            .gas_payment_backward_cursor => "gas_payment_backward_cursor_v2_",
            .merkle_tree_insertion_backward_cursor => "merkle_tree_insertion_backward_cursor_v2_",
        };
    }
};

pub fn scoped(allocator: std.mem.Allocator, domain_name: []const u8, prefix: []const u8, encoded_key: []const u8) ![]u8 {
    return std.mem.concat(allocator, u8, &.{ domain_name, "_", prefix, encoded_key });
}

pub fn pendingDestination(allocator: std.mem.Allocator, destination: u32) ![]u8 {
    var encoded: [4]u8 = undefined;
    std.mem.writeInt(u32, &encoded, destination, .big);
    return std.mem.concat(allocator, u8, &.{ Table.pending_message_by_destination.prefix(), &encoded });
}

/// Exclusive upper bound used by Rust TypedDbBatch::delete_prefix.
pub fn successor(allocator: std.mem.Allocator, prefix: []const u8) ![]u8 {
    var index = prefix.len;
    while (index > 0) {
        index -= 1;
        if (prefix[index] != 255) {
            const out = try allocator.dupe(u8, prefix[0 .. index + 1]);
            out[index] += 1;
            return out;
        }
    }
    return error.NoPrefixUpperBound;
}

test "domain names and prefix upper bounds match Rust" {
    const allocator = std.testing.allocator;
    const key = try scoped(allocator, "arbitrum", Table.message_id.prefix(), &.{ 0, 0, 0, 42 });
    defer allocator.free(key);
    try std.testing.expectEqualStrings("arbitrum_message_id_\x00\x00\x00\x2a", key);
    const upper = try successor(allocator, &.{ 'a', 255, 255 });
    defer allocator.free(upper);
    try std.testing.expectEqualSlices(u8, "b", upper);
    try std.testing.expectError(error.NoPrefixUpperBound, successor(allocator, &.{255}));
    try std.testing.expectError(error.NoPrefixUpperBound, successor(allocator, ""));
}
