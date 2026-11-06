//! Runtime address-rule signer lookup from the actual dispatch transaction.
//! No getSignaturesForAddress heuristic: later PDA touches cannot replace the
//! immutable dispatch block's transaction. Caller controls cache/backoff policy.
const std = @import("std");
const svm = @import("provider.zig");
const Mailbox = @import("mailbox.zig").Mailbox;
const meta = @import("log_meta.zig");
const rpc = @import("../evm/provider.zig");
const b58 = @import("../altvm/base58.zig");
const A = std.mem.Allocator;
pub const Key = [32]u8;
pub fn decode(a: A, value: std.json.Value, signature: [64]u8) ![]Key {
    const transaction = try svm.field(value, "transaction");
    const signatures = try svm.field(transaction, "signatures");
    if (signatures != .array or signatures.array.items.len == 0) return error.InvalidSvmSignerTransaction;
    const text = try b58.encode(a, &signature);
    defer a.free(text);
    if (!std.mem.eql(u8, text, try svm.string(signatures.array.items[0]))) return error.SvmSignerTransactionMismatch;
    const message = try svm.field(transaction, "message");
    const keys = try svm.field(message, "accountKeys");
    if (keys != .array or keys.array.items.len == 0 or keys.array.items.len > 256) return error.InvalidSvmSignerTransaction;
    var list: std.ArrayList(Key) = .empty;
    errdefer list.deinit(a);
    for (keys.array.items) |key| {
        if (key != .object) return error.SvmParsedTransactionRequired;
        const signer = try svm.field(key, "signer");
        if (signer != .bool) return error.InvalidSvmSignerTransaction;
        if (!signer.bool) continue;
        const pubkey = try svm.decodeKey(a, try svm.string(try svm.field(key, "pubkey")));
        for (list.items) |previous| if (std.mem.eql(u8, &pubkey, &previous)) return error.DuplicateSvmSigner;
        try list.append(a, pubkey);
        if (list.items.len > 127) return error.InvalidSvmSignerTransaction;
    }
    if (list.items.len == 0 or list.items.len != signatures.array.items.len) return error.InvalidSvmSignerTransaction;
    // Validate every native signature's wire length, retaining all signer keys
    // in the exact message account-key order, including sponsored depositors.
    for (signatures.array.items) |entry| {
        const signature_text = try svm.string(entry);
        if (signature_text.len < 64 or signature_text.len > 88) return error.InvalidSvmSignerTransaction;
        const bytes = try b58.decode(a, signature_text);
        defer a.free(bytes);
        if (bytes.len != 64) return error.InvalidSvmSignerTransaction;
    }
    return list.toOwnedSlice(a);
}
fn fullBlock(client: *svm.Client, slot: u64) !rpc.RpcResponse {
    var response = client.call("getBlock", .{ slot, .{ .encoding = "json", .transactionDetails = "full", .rewards = false, .commitment = "finalized", .maxSupportedTransactionVersion = 0 } }) catch |err| {
        if (err == error.RpcError) if (client.rpc_client.last_rpc_error_code) |code| if (code == -32001 or code == -32004 or code == -32007 or code == -32009) return error.SvmSignerBlockUnavailable;
        return err;
    };
    errdefer response.deinit();
    if (response.value() == .null) return error.SvmSignerBlockUnavailable;
    return response;
}
const Resolved = struct { signature: [64]u8, slot: u64, hash: Key };
fn resolve(client: *svm.Client, mailbox: Mailbox, sequence: u32) !?Resolved {
    const a = client.rpc_client.allocator;
    var dispatched = (try mailbox.dispatchedByNonce(sequence)) orelse return error.MissingDispatchedSequence;
    defer dispatched.deinit();
    var at = dispatched.value.slot;
    var current = try fullBlock(client, at);
    defer current.deinit();
    const first = meta.find(a, current.value(), mailbox.program, dispatched.key, .dispatch) catch |err| switch (err) {
        error.SvmNoTransactions => null,
        error.SvmAmbiguousTransaction => return null,
        else => return err,
    };
    if (first) |found| return .{ .signature = found.hash, .slot = at, .hash = try svm.decodeKey(a, try svm.string(try svm.field(current.value(), "blockhash"))) };
    if (at == 0) return null;
    at -= 1;
    var previous = try fullBlock(client, at);
    defer previous.deinit();
    const found = (meta.find(a, previous.value(), mailbox.program, dispatched.key, .dispatch) catch |err| switch (err) {
        error.SvmNoTransactions, error.SvmAmbiguousTransaction => return null,
        else => return err,
    }) orelse return null;
    return .{ .signature = found.hash, .slot = at, .hash = try svm.decodeKey(a, try svm.string(try svm.field(previous.value(), "blockhash"))) };
}
/// Caller owns the returned slice and frees it with client.rpc_client.allocator.
/// SVM returns Some(empty) only when fetched dispatch blocks have no unique
/// match. Unavailable blocks/transactions remain errors for the caller's retry.
/// Known hashes already bound by the caller's canonical DB skip the PDA scan.
pub fn fetchTxSignersBySequence(client: *svm.Client, mailbox: Mailbox, sequence: u32, known: ?[64]u8) !?[]Key {
    if (mailbox.client != client) return error.SvmSignerClientMismatch;
    if (client.commitment != .finalized) return error.FinalizedSvmClientRequired;
    const a = client.rpc_client.allocator;
    var resolved: ?Resolved = null;
    const signature = if (known) |hash| hash else blk: {
        resolved = try resolve(client, mailbox, sequence);
        break :blk if (resolved) |value| value.signature else return try a.alloc(Key, 0);
    };
    const text = try b58.encode(a, &signature);
    defer a.free(text);
    var response = try client.call("getTransaction", .{ text, .{ .encoding = "jsonParsed", .commitment = "finalized", .maxSupportedTransactionVersion = 0 } });
    defer response.deinit();
    if (response.value() == .null) return error.SvmSignerTransactionUnavailable;
    const value = response.value();
    const slot = try svm.uint(try svm.field(value, "slot"));
    if (resolved) |expected| if (slot != expected.slot) return error.SvmSignerTransactionMismatch;
    const transaction_meta = try svm.field(value, "meta");
    if (transaction_meta == .null or (try svm.field(transaction_meta, "err")) != .null) return error.SvmSignerFailedTransaction;
    const keys = try decode(a, value, signature);
    errdefer a.free(keys);
    // A finalized lookup still must belong to the canonical block returned at
    // this slot; do not attach current canonical hashes to orphan transaction data.
    var header = try client.call("getBlock", .{ slot, .{ .encoding = "json", .transactionDetails = "signatures", .rewards = false, .commitment = "finalized", .maxSupportedTransactionVersion = 0 } });
    defer header.deinit();
    const block_hash = try svm.decodeKey(a, try svm.string(try svm.field(header.value(), "blockhash")));
    if (resolved) |expected| if (!std.mem.eql(u8, &block_hash, &expected.hash)) return error.SvmSignerCanonicalityChanged;
    const signatures = try svm.field(header.value(), "signatures");
    if (signatures != .array) return error.InvalidSvmResponse;
    const included = for (signatures.array.items) |entry| {
        if (std.mem.eql(u8, text, try svm.string(entry))) break true;
    } else false;
    if (!included) return error.SvmSignerNotInCanonicalBlock;
    return keys;
}

test "SVM parsed transaction signer lookup keeps sponsored depositor and native identity" {
    const a = std.testing.allocator;
    const text = try b58.encode(a, &(.{1} ** 64));
    defer a.free(text);
    const payer = try b58.encode(a, &(.{2} ** 32));
    defer a.free(payer);
    const depositor = try b58.encode(a, &(.{3} ** 32));
    defer a.free(depositor);
    const program = try b58.encode(a, &(.{4} ** 32));
    defer a.free(program);
    const bytes = try std.json.Stringify.valueAlloc(a, .{ .transaction = .{ .signatures = .{ text, text }, .message = .{ .accountKeys = .{ .{ .pubkey = payer, .signer = true }, .{ .pubkey = depositor, .signer = true }, .{ .pubkey = program, .signer = false } } } } }, .{});
    defer a.free(bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    const keys = try decode(a, parsed.value, .{1} ** 64);
    defer a.free(keys);
    try std.testing.expectEqual(@as(usize, 2), keys.len);
    try std.testing.expectEqual([_]u8{3} ** 32, keys[1]);
    try std.testing.expectError(error.SvmSignerTransactionMismatch, decode(a, parsed.value, .{2} ** 64));
}
