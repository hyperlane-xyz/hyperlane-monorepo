const std = @import("std");
const agents = @import("store.zig");
const db = @import("../db/root.zig");
const protocol = @import("../protocol/root.zig");

test "agent native store preserves canonical nonce maps repairs pending and atomically changes destinations" {
    const allocator = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "agent" });
    defer allocator.free(path);
    var database = try db.rocks.Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    var store = agents.Store.init(allocator, &database, "ethereum");
    var message: protocol.Message = .{ .version = 3, .nonce = 7, .origin = 1, .destination = 11, .sender = @splat(1), .recipient = @splat(2), .body = "first" };
    try std.testing.expect(try store.storeMessage(message, 10, null));
    try std.testing.expect(!try store.storeMessage(message, 10, null));
    var replacement = message;
    replacement.body = "replacement";
    replacement.destination = 12;
    try std.testing.expect(!try store.storeMessage(replacement, 11, null));
    var owned = (try store.messageByNonce(7)).?;
    defer owned.deinit();
    try std.testing.expectEqualStrings("first", owned.value.body);
    const old_pending = try db.keys.pendingDestination(allocator, 11);
    defer allocator.free(old_pending);
    var nonce: [4]u8 = undefined;
    std.mem.writeInt(u32, &nonce, 7, .big);
    try store.typed.put(allocator, db.keys.Table.terminally_dropped_message_by_id.prefix(), &message.id(), &.{1});
    try store.upsertMessage(replacement, 12, null);
    try std.testing.expect(!try store.terminal(message.id()));
    try std.testing.expect((try store.typed.get(allocator, old_pending, &nonce)) == null);
    const pending = try db.keys.pendingDestination(allocator, 12);
    defer allocator.free(pending);
    const value = (try store.typed.get(allocator, pending, &nonce)).?;
    defer allocator.free(value);
    try std.testing.expectEqualSlices(u8, &replacement.id(), value);
    var pending_message = (try store.pendingAtOrAfter(12, 0)).?;
    defer pending_message.deinit();
    try std.testing.expectEqualSlices(u8, &replacement.id(), &pending_message.value.id());
    try std.testing.expect((try store.pendingAtOrAfter(12, 8)) == null);
    try std.testing.expectError(error.StaleCanonicalMessage, store.markProcessed(message));
    try std.testing.expect(!try store.processed(7));
    try store.markProcessed(replacement);
    try std.testing.expect(try store.processed(7));
    try std.testing.expect((try store.typed.get(allocator, pending, &nonce)) == null);
    try std.testing.expect(!try store.storeMessage(replacement, 12, null));
    try std.testing.expect((try store.typed.get(allocator, pending, &nonce)) == null);
    var after_delivery = replacement;
    after_delivery.body = "canonical replacement after old delivery";
    try store.upsertMessage(after_delivery, 13, null);
    try std.testing.expect(!try store.processed(after_delivery.nonce));
    var reconsidered = (try store.pendingAtOrAfter(after_delivery.destination, after_delivery.nonce)).?;
    defer reconsidered.deinit();
    try std.testing.expectEqual(after_delivery.id(), reconsidered.value.id());
    message.nonce = 2;
    try std.testing.expect(try store.storeMessage(message, 13, null));
    const maximum = (try store.typed.get(allocator, db.keys.Table.highest_seen_message_nonce.prefix(), &.{0})).?;
    defer allocator.free(maximum);
    try std.testing.expectEqual(@as(u32, 7), try db.codec.decode(u32, maximum));
    const retry: db.json.RetryState = .{ .retry_count = 5, .next_attempt_at_millis = 12345, .retry_delay_millis = 1000, .reason = .CouldNotFetchMetadata };
    try store.storeRetry(message.id(), retry, .{ .Retry = .CouldNotFetchMetadata });
    try std.testing.expectEqual(@as(u32, 5), try store.retryCount(message.id()));
    try std.testing.expectEqual(retry, (try store.retryState(message.id())).?);
    try std.testing.expectEqual(db.json.Status{ .Retry = .CouldNotFetchMetadata }, (try store.status(message.id())).?);
    try store.markTerminal(message.id());
    try std.testing.expect(try store.terminal(message.id()));
    // A stale destination entry must not return the old replacement after a
    // canonical nonce update, even if legacy code recreated that derived row.
    try store.typed.put(allocator, pending, &nonce, &message.id());
    try std.testing.expect((try store.pendingAtOrAfter(12, 0)) == null);
    try std.testing.expect(try store.reconcileCanonicalPending(message.nonce));
}

test "agent native store deduplicates gas metadata saturates totals and repairs tree reverse indices" {
    const allocator = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "agent" });
    defer allocator.free(path);
    var database = try db.rocks.Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    var store = agents.Store.init(allocator, &database, "ethereum");
    const incoming: db.codec.GasPayment = .{ .message_id = @splat(1), .destination = 2, .payment = std.math.maxInt(u256) - 10, .gas_amount = 100 };
    var meta: db.codec.GasPaymentMeta = .{ .transaction_id = @splat(3), .log_index = 4 };
    try std.testing.expect(try store.storePayment(incoming, meta));
    try std.testing.expect(!try store.storePayment(incoming, meta));
    meta.log_index += 1;
    try std.testing.expect(try store.storePayment(.{ .message_id = incoming.message_id, .destination = 2, .payment = 20, .gas_amount = 40 }, meta));
    const payment = (try store.payment(.{ .message_id = incoming.message_id, .destination = 2 })).?;
    try std.testing.expectEqual(std.math.maxInt(u256), payment.payment);
    try std.testing.expectEqual(@as(u256, 140), payment.gas_amount);
    try std.testing.expect(!try store.storeIndexedPayment(incoming, .{ .transaction_id = @splat(3), .log_index = 4 }, 9, 50));
    try std.testing.expect(!try store.storeIndexedPayment(incoming, .{ .transaction_id = @splat(3), .log_index = 4 }, 9, 50));
    try std.testing.expectError(error.GasPaymentSequenceConflict, store.storeIndexedPayment(incoming, .{ .transaction_id = @splat(3), .log_index = 4 }, 9, 51));
    var sequence_key: [4]u8 = undefined;
    std.mem.writeInt(u32, &sequence_key, 9, .big);
    const block_key = try db.keys.scoped(allocator, "ethereum", db.keys.Table.gas_payment_block_by_sequence.prefix(), &sequence_key);
    defer allocator.free(block_key);
    try database.delete(block_key);
    try std.testing.expect(!try store.storeIndexedPayment(incoming, .{ .transaction_id = @splat(3), .log_index = 4 }, 9, 51));
    const after_repair = (try store.payment(.{ .message_id = incoming.message_id, .destination = 2 })).?;
    try std.testing.expectEqual(payment, after_repair);
    try store.addExpenditure(incoming.message_id, .{ .tokens_used = 20, .gas_used = 30 });
    try store.addExpenditure(incoming.message_id, .{ .tokens_used = 30, .gas_used = 40 });
    try std.testing.expectEqual(db.codec.GasExpenditureData{ .tokens_used = 50, .gas_used = 70 }, try store.expenditure(incoming.message_id));
    var leaf: db.codec.MerkleInsertion = .{ .leaf_index = 0, .message_id = @splat(5) };
    try std.testing.expect(try store.storeInsertion(leaf, 10));
    try std.testing.expect(!try store.storeInsertion(leaf, 10));
    const reverse_key = try db.keys.scoped(allocator, "ethereum", db.keys.Table.merkle_leaf_index_by_message_id.prefix(), &leaf.message_id);
    defer allocator.free(reverse_key);
    try database.delete(reverse_key);
    try std.testing.expect(!try store.storeInsertion(leaf, 10));
    try std.testing.expectEqual(@as(?u32, 0), try store.leafIndex(leaf.message_id));
    const protected = (try store.storeInsertionIfAbsent(.{ .leaf_index = 0, .message_id = @splat(99) }, 100)).?;
    try std.testing.expectEqual(leaf, protected);
    const old = leaf.message_id;
    leaf.message_id = @splat(6);
    try std.testing.expect(try store.storeInsertion(leaf, 11));
    try std.testing.expectEqual(@as(?u32, null), try store.leafIndex(old));
    try std.testing.expectEqual(@as(?u32, 0), try store.leafIndex(leaf.message_id));
    try store.storeCursor(.insertion, 1234);
    try std.testing.expectEqual(@as(?u64, 1234), try store.cursor(.insertion));
    var sequence_store: agents.SequenceStore = .{ .store = &store, .stream = .insertion };
    const callbacks = sequence_store.interface();
    try std.testing.expectEqual(@as(?u32, 11), try callbacks.block_fn(callbacks.context, 0));
    try callbacks.save_fn(callbacks.context, .{ .sequence = 8, .block = 44 });
    try std.testing.expectEqual(@as(?u32, 44), try callbacks.progress_fn(callbacks.context, 8));
    try callbacks.delete_fn(callbacks.context, 8);
    try std.testing.expect((try callbacks.progress_fn(callbacks.context, 8)) == null);
}

test "native loader repairs legacy indexes and alternates new historical and released work" {
    const loader = @import("loader.zig");
    const a = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const parent = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "loader" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{ .sync = true });
    defer database.deinit();
    var store = agents.Store.init(a, &database, "ethereum");
    const pending = try db.keys.pendingDestination(a, 2);
    defer a.free(pending);
    for (0..10) |nonce| {
        const message: protocol.Message = .{ .nonce = @intCast(nonce), .origin = 1, .destination = 2, .body = "pending" };
        _ = try store.storeMessage(message, nonce, null);
        // Simulate an old Rust writer which has no destination index at all.
        var key: [4]u8 = undefined;
        std.mem.writeInt(u32, &key, @intCast(nonce), .big);
        var batch = try store.typed.batch(a);
        defer batch.deinit();
        try batch.delete(pending, &key);
        try batch.commit();
    }
    var state = try loader.Loader.init(a, &store, &.{ 2, 3 }, .{ .migration_page = 2, .max_loaded = 2, .max_reconsider = 1 });
    defer state.deinit();
    try std.testing.expect((try state.next()) == null);
    try std.testing.expectEqual(@as(usize, 1), try state.migrate());
    var newest = (try state.next()).?;
    defer newest.message.deinit();
    try std.testing.expectEqual(@as(u32, 9), newest.message.value.nonce);
    try std.testing.expectEqual(@as(usize, 2), try state.migrate());
    var historical = (try state.next()).?;
    defer historical.message.deinit();
    try std.testing.expectEqual(@as(u32, 8), historical.message.value.nonce);
    try std.testing.expect((try state.next()) == null); // Bounded reservations.
    try state.release(newest.message.value.id(), true);
    var released = (try state.next()).?;
    defer released.message.deinit();
    try std.testing.expectEqual(@as(u32, 9), released.message.value.nonce);
    try state.release(released.message.value.id(), false);
    try state.release(historical.message.value.id(), false);
    while (!state.migrationComplete()) _ = try state.migrate();
    // A policy change revisits previously skipped historical rows.
    state.rescan();
    var seen = std.AutoHashMap(u32, void).init(a);
    defer seen.deinit();
    while (try state.next()) |value| {
        var item = value;
        defer item.message.deinit();
        try seen.put(item.message.value.nonce, {});
        try state.release(item.message.value.id(), false);
    }
    try std.testing.expectEqual(@as(usize, 10), seen.count());
    var final = (try store.messageByNonce(9)).?;
    defer final.deinit();
    try store.markTerminal(final.value.id());
    var previous = (try store.pendingAtOrBefore(2, 9)).?;
    defer previous.deinit();
    try std.testing.expect(previous.value.nonce != 9);
    try std.testing.expect(try store.terminal(final.value.id()));
}

test "receipt admission never changes indexed nonce authority and survives reopen" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const path = try std.fs.path.join(a, &.{ parent, "receipt" });
    defer a.free(path);
    const canonical: protocol.Message = .{ .version = 3, .nonce = 7, .origin = 1, .destination = 11, .sender = @splat(1), .recipient = @splat(2), .body = "indexed" };
    var receipt = canonical;
    receipt.body = "receipt on another fork";
    receipt.destination = 12;
    var future = receipt;
    future.nonce = 100;
    const tx: [64]u8 = @splat(9);
    {
        var database = try db.rocks.Database.open(a, path, .{ .sync = true });
        defer database.deinit();
        var store = agents.Store.init(a, &database, "ethereum");
        try std.testing.expect(try store.storeMessage(canonical, 10, null));
        try store.markProcessed(canonical);
        try store.storeGasWatermark(900);
        try std.testing.expect(!try store.operationMessageAuthorized(receipt));
        try store.admitReceiptMessage(receipt, tx);
        try store.admitReceiptMessage(receipt, tx);
        try store.admitReceiptMessage(future, tx);
        try std.testing.expect(try store.operationMessageAuthorized(receipt));
        try std.testing.expect(try store.operationMessageAuthorized(future));
        try std.testing.expect(try store.operationComplete(canonical));
        try std.testing.expect(!try store.operationComplete(receipt));
        try std.testing.expect(!try store.operationComplete(future));
        var current = (try store.messageByNonce(7)).?;
        defer current.deinit();
        try std.testing.expectEqualSlices(u8, &canonical.id(), &current.value.id());
        try std.testing.expect((try store.messageByNonce(100)) == null);
        const dangling_key = try db.codec.encode(a, @as(u32, 100));
        defer a.free(dangling_key);
        try store.typed.put(a, db.keys.Table.message_id.prefix(), dangling_key, &future.id());
        // Even a dangling indexed ID cannot promote receipt-sidecar bytes to an
        // indexed message or authorize a nonce_processed write.
        try std.testing.expect((try store.messageByNonce(100)) == null);
        try std.testing.expect(!try store.markProcessedIfCanonical(future));
        try std.testing.expectError(error.CanonicalMessageMissing, store.markProcessed(future));
        try std.testing.expectEqual(@as(?u32, 7), try store.highestSeenNonce());
        try std.testing.expectEqual(@as(?u64, 10), try store.messageBlock(7));
        try std.testing.expect((try store.messageBlock(100)) == null);
        try std.testing.expectEqual(@as(?u32, 900), try store.gasWatermark());
        try std.testing.expect(try store.processed(7));
        try std.testing.expect(!try store.processed(100));
        try std.testing.expect(!try store.markProcessedIfCanonical(receipt));
        try std.testing.expect(!try store.markProcessedIfCanonical(future));
        try std.testing.expect((try store.pendingAtOrAfter(12, 0)) == null);
        try std.testing.expect((try store.typed.get(a, db.keys.Table.message.prefix(), &receipt.id())) == null);
        const stored_tx = (try store.dispatchedTransaction(receipt.id())).?;
        try std.testing.expectEqualSlices(u8, &tx, &stored_tx);
    }
    {
        var database = try db.rocks.Database.open(a, path, .{ .sync = true });
        defer database.deinit();
        var store = agents.Store.init(a, &database, "ethereum");
        try std.testing.expect(try store.operationMessageAuthorized(receipt));
        var admitted = (try store.messageById(receipt.id())).?;
        defer admitted.deinit();
        try std.testing.expectEqualStrings(receipt.body, admitted.value.body);
        // A later explicit canonical replacement can acknowledge this ID. The
        // earlier receipt never marked the different indexed message processed.
        try store.upsertMessage(receipt, 20, tx);
        try std.testing.expect(!try store.processed(7));
        try std.testing.expect(try store.markProcessedIfCanonical(receipt));
        try std.testing.expect(try store.processed(7));
        try std.testing.expect(try store.operationComplete(receipt));
        try std.testing.expect((try store.pendingAtOrAfter(12, 0)) == null);
    }
}
