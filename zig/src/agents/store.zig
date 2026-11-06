//! Agent-level RocksDB operations over the existing Rust key/value contract.
//! One owner serializes mutations. Native batches preserve derived-index pairs.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const db = @import("../db/root.zig");
const codec = db.codec;
const Table = db.keys.Table;
const Hash = [32]u8;
const receipt_admission_prefix = "zig_public_receipt_message_v1/";
pub const Stream = enum { dispatch, insertion, gas, delivery };
const cursor_runtime = @import("../runtime/sequence_cursor.zig");

pub const SequenceStore = struct {
    store: *Store,
    stream: Stream,
    pub fn interface(self: *SequenceStore) cursor_runtime.Progress {
        return .{ .context = self, .block_fn = block, .progress_fn = progress, .save_fn = save, .delete_fn = delete };
    }
    fn block(context: *anyopaque, sequence: u32) !?u32 {
        const self: *SequenceStore = @ptrCast(@alignCast(context));
        const height = (try self.store.logBlock(self.stream, sequence)) orelse return null;
        return std.math.cast(u32, height) orelse error.IndexHeightOutOfRange;
    }
    fn progress(context: *anyopaque, sequence: u32) !?u32 {
        const self: *SequenceStore = @ptrCast(@alignCast(context));
        const point = (try self.store.backwardProgress(self.stream, sequence)) orelse return null;
        if (point.sequence != sequence) return error.InvalidBackwardProgress;
        return point.block;
    }
    fn save(context: *anyopaque, point: cursor_runtime.Point) !void {
        const self: *SequenceStore = @ptrCast(@alignCast(context));
        try self.store.saveBackwardProgress(self.stream, .{ .sequence = point.sequence, .block = point.block });
    }
    fn delete(context: *anyopaque, sequence: u32) !void {
        const self: *SequenceStore = @ptrCast(@alignCast(context));
        try self.store.deleteBackwardProgress(self.stream, sequence);
    }
};

pub const OwnedMessage = struct {
    allocator: std.mem.Allocator,
    bytes: []u8,
    value: protocol.Message,
    pub fn deinit(self: *OwnedMessage) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};

pub const Store = struct {
    allocator: std.mem.Allocator,
    typed: db.rocks.Typed,
    mutex: std.Thread.Mutex = .{},
    /// Queue-only canonical dispatch fanout; callback never performs I/O.
    dispatch_notifications: ?@import("../runtime/tx_id_observer.zig").Observer = null,
    /// Process-local cache invalidation for canonical replacements. A restart
    /// rebuilds the prover from RocksDB, so this counter need not be persisted.
    tree_reset_generation: u64 = 0,

    pub fn init(allocator: std.mem.Allocator, database: *db.rocks.Database, domain_name: []const u8) Store {
        return .{ .allocator = allocator, .typed = .{ .database = database, .domain_name = domain_name } };
    }

    fn get(self: *Store, comptime T: type, table: Table, key: anytype) !?T {
        const encoded = try codec.encode(self.allocator, key);
        defer self.allocator.free(encoded);
        const bytes = (try self.typed.get(self.allocator, table.prefix(), encoded)) orelse return null;
        defer self.allocator.free(bytes);
        return try codec.decode(T, bytes);
    }

    fn put(self: *Store, batch: *db.rocks.TypedBatch, table: Table, key: anytype, value: anytype) !void {
        const encoded_key = try codec.encode(self.allocator, key);
        defer self.allocator.free(encoded_key);
        const encoded_value = try codec.encode(self.allocator, value);
        defer self.allocator.free(encoded_value);
        try batch.put(table.prefix(), encoded_key, encoded_value);
    }

    fn delete(self: *Store, batch: *db.rocks.TypedBatch, table: Table, key: anytype) !void {
        const encoded = try codec.encode(self.allocator, key);
        defer self.allocator.free(encoded);
        try batch.delete(table.prefix(), encoded);
    }

    pub fn messageByNonce(self: *Store, nonce: u32) !?OwnedMessage {
        const id = (try self.get(Hash, .message_id, nonce)) orelse return null;
        const bytes = (try self.typed.get(self.allocator, Table.message.prefix(), &id)) orelse return null;
        var owned = try self.decodeOwned(id, bytes);
        errdefer owned.deinit();
        if (owned.value.nonce != nonce) return error.StoredMessageNonceMismatch;
        return owned;
    }

    pub fn messageById(self: *Store, id: Hash) !?OwnedMessage {
        const bytes = (try self.typed.get(self.allocator, Table.message.prefix(), &id)) orelse
            (try self.typed.get(self.allocator, receipt_admission_prefix, &id)) orelse return null;
        return try self.decodeOwned(id, bytes);
    }

    fn decodeOwned(self: *Store, id: Hash, bytes: []u8) !OwnedMessage {
        errdefer self.allocator.free(bytes);
        const value = try protocol.Message.decode(bytes);
        if (!std.mem.eql(u8, &value.id(), &id)) return error.StoredMessageIdMismatch;
        return .{ .allocator = self.allocator, .bytes = bytes, .value = value };
    }

    /// Public relay receipts grant message-ID authority without changing any
    /// indexed nonce, block, cursor, maximum or pending-destination table. Rust's
    /// relay API deliberately leaves these mappings to canonical indexing.
    pub fn admitReceiptMessage(self: *Store, message: protocol.Message, transaction: [64]u8) !void {
        const bytes = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(bytes);
        const id = message.id();
        self.mutex.lock();
        defer self.mutex.unlock();
        const old = try self.typed.get(self.allocator, receipt_admission_prefix, &id);
        defer if (old) |value| self.allocator.free(value);
        if (old) |value| if (!std.mem.eql(u8, value, bytes)) return error.ReceiptAdmissionConflict;
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try batch.put(receipt_admission_prefix, &id, bytes);
        try self.put(&batch, .message_dispatched_tx_hash, id, transaction);
        try batch.commitSync();
    }

    /// Does not acquire Store.mutex: durable callers hold it across this check
    /// and their batch. Receipt authority never confers canonical nonce authority.
    pub fn operationMessageAuthorized(self: *Store, message: protocol.Message) !bool {
        var canonical = try self.messageByNonce(message.nonce);
        defer if (canonical) |*value| value.deinit();
        if (canonical) |value| if (std.mem.eql(u8, &value.value.id(), &message.id())) return true;
        const admitted = (try self.typed.get(self.allocator, receipt_admission_prefix, &message.id())) orelse return false;
        defer self.allocator.free(admitted);
        const bytes = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(bytes);
        return std.mem.eql(u8, admitted, bytes);
    }

    /// Caller holds mutex when paired with operationMessageAuthorized. A nonce
    /// marker belongs exclusively to its current indexed message, never to a
    /// receipt-only message that happens to reuse that nonce.
    pub fn operationComplete(self: *Store, message: protocol.Message) !bool {
        if (try self.terminal(message.id())) return true;
        var canonical = try self.messageByNonce(message.nonce);
        defer if (canonical) |*value| value.deinit();
        if (canonical) |value| {
            if (std.mem.eql(u8, &value.value.id(), &message.id())) return self.processed(message.nonce);
        }
        return false;
    }

    pub fn processed(self: *Store, nonce: u32) !bool {
        return (try self.get(bool, .nonce_processed, nonce)) orelse false;
    }

    pub fn terminal(self: *Store, id: Hash) !bool {
        return (try self.get(bool, .terminally_dropped_message_by_id, id)) orelse false;
    }

    pub fn status(self: *Store, id: Hash) !?db.json.Status {
        const bytes = (try self.typed.get(self.allocator, Table.status_by_message_id.prefix(), &id)) orelse return null;
        defer self.allocator.free(bytes);
        return try db.json.Status.parse(self.allocator, bytes);
    }

    pub fn retryState(self: *Store, id: Hash) !?db.json.RetryState {
        const bytes = (try self.typed.get(self.allocator, Table.pending_message_retry_state.prefix(), &id)) orelse return null;
        defer self.allocator.free(bytes);
        return try db.json.RetryState.parse(self.allocator, bytes);
    }

    pub fn retryCount(self: *Store, id: Hash) !u32 {
        return (try self.get(u32, .pending_message_retry_count, id)) orelse 0;
    }

    pub fn highestSeenNonce(self: *Store) !?u32 {
        return self.get(u32, .highest_seen_message_nonce, false);
    }

    pub fn dispatchedTransaction(self: *Store, id: Hash) !?[64]u8 {
        return self.get([64]u8, .message_dispatched_tx_hash, id);
    }

    pub fn messageBlock(self: *Store, nonce: u32) !?u64 {
        return self.get(u64, .message_dispatched_block_number, nonce);
    }

    pub fn storeRetry(self: *Store, id: Hash, state: db.json.RetryState, current_status: db.json.Status) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try state.validate();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, .pending_message_retry_count, id, state.retry_count);
        try self.put(&batch, .pending_message_retry_state, id, state);
        try self.put(&batch, .status_by_message_id, id, current_status);
        try batch.commitSync();
    }

    pub fn markTerminal(self: *Store, id: Hash) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, .terminally_dropped_message_by_id, id, true);
        try batch.commitSync();
    }

    /// Migration/retry repair re-reads the current canonical nonce while holding
    /// the mutation lock; a stale iterator cannot resurrect an older replacement.
    pub fn reconcileCanonicalPending(self: *Store, nonce: u32) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        var message = (try self.messageByNonce(nonce)) orelse return false;
        defer message.deinit();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.reconcilePending(&batch, message.value);
        try batch.commit();
        return true;
    }

    pub fn storeMessage(self: *Store, message: protocol.Message, block_number: u64, transaction: ?[64]u8) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (try self.messageByNonce(message.nonce)) |owned| {
            var existing = owned;
            defer existing.deinit();
            // Match Rust store_message: an occupied nonce is not replaced by
            // ordinary indexing. Explicit administrative upsert is separate.
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            try self.updateMaximum(&batch, message.nonce);
            try self.reconcilePending(&batch, existing.value);
            if (try self.get(u64, .message_dispatched_block_number, message.nonce) == null) try self.put(&batch, .message_dispatched_block_number, message.nonce, block_number);
            if (transaction) |hash| if (!std.mem.allEqual(u8, &hash, 0)) try self.put(&batch, .message_dispatched_tx_hash, message.id(), hash);
            try batch.commit();
            if (std.mem.eql(u8, &existing.value.id(), &message.id())) try self.notifyDispatch((try self.messageBlock(existing.value.nonce)) orelse block_number, transaction);
            return false;
        }
        try self.upsert(message, block_number, transaction);
        try self.notifyDispatch(block_number, transaction);
        return true;
    }
    pub fn notifyDispatch(self: *Store, block_number: u64, transaction: ?[64]u8) !void {
        const sink = self.dispatch_notifications orelse return;
        const tx = transaction orelse return;
        if (std.mem.allEqual(u8, &tx, 0)) return;
        try sink.notify(.{ .transaction = tx, .block_number = block_number });
    }

    pub fn upsertMessage(self: *Store, message: protocol.Message, block_number: u64, transaction: ?[64]u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.upsert(message, block_number, transaction);
    }

    fn upsert(self: *Store, message: protocol.Message, block_number: u64, transaction: ?[64]u8) !void {
        const id = message.id();
        const bytes = try message.encodeAlloc(self.allocator);
        defer self.allocator.free(bytes);
        var previous = try self.messageByNonce(message.nonce);
        defer if (previous) |*old| old.deinit();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try batch.put(Table.message.prefix(), &id, bytes);
        try self.put(&batch, .message_id, message.nonce, id);
        try self.put(&batch, .message_dispatched_block_number, message.nonce, block_number);
        try self.updateMaximum(&batch, message.nonce);
        const prefix = try db.keys.pendingDestination(self.allocator, message.destination);
        defer self.allocator.free(prefix);
        var nonce: [4]u8 = undefined;
        std.mem.writeInt(u32, &nonce, message.nonce, .big);
        try batch.put(prefix, &nonce, &id);
        if (previous) |old| {
            if (!std.mem.eql(u8, &old.value.id(), &id)) {
                try self.delete(&batch, .terminally_dropped_message_by_id, old.value.id());
                // Delivery of an orphaned message does not prove delivery of
                // its canonical replacement at the same origin nonce.
                try self.delete(&batch, .nonce_processed, message.nonce);
                if (old.value.destination != message.destination) {
                    const old_prefix = try db.keys.pendingDestination(self.allocator, old.value.destination);
                    defer self.allocator.free(old_prefix);
                    try batch.delete(old_prefix, &nonce);
                }
            }
        }
        if (transaction) |hash| if (!std.mem.allEqual(u8, &hash, 0)) try self.put(&batch, .message_dispatched_tx_hash, id, hash);
        try batch.commit();
    }

    fn updateMaximum(self: *Store, batch: *db.rocks.TypedBatch, nonce: u32) !void {
        const highest = (try self.get(u32, .highest_seen_message_nonce, false)) orelse 0;
        if (nonce >= highest) try self.put(batch, .highest_seen_message_nonce, false, nonce);
    }

    fn reconcilePending(self: *Store, batch: *db.rocks.TypedBatch, message: protocol.Message) !void {
        const prefix = try db.keys.pendingDestination(self.allocator, message.destination);
        defer self.allocator.free(prefix);
        var nonce: [4]u8 = undefined;
        std.mem.writeInt(u32, &nonce, message.nonce, .big);
        const indexed = try self.typed.get(self.allocator, prefix, &nonce);
        defer if (indexed) |bytes| self.allocator.free(bytes);
        if (try self.processed(message.nonce)) {
            if (indexed != null) {
                try batch.delete(prefix, &nonce);
                try self.delete(batch, .terminally_dropped_message_by_id, message.id());
            }
        } else if (indexed == null or !std.mem.eql(u8, indexed.?, &message.id())) try batch.put(prefix, &nonce, &message.id());
    }

    pub fn markProcessed(self: *Store, message: protocol.Message) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        var canonical = (try self.messageByNonce(message.nonce)) orelse return error.CanonicalMessageMissing;
        defer canonical.deinit();
        if (!std.mem.eql(u8, &canonical.value.id(), &message.id())) return error.StaleCanonicalMessage;
        try self.markProcessedLocked(message);
    }

    /// A public relay can finish before indexing. Only the matching indexed
    /// message may set nonce_processed; a different fork's nonce stays untouched.
    pub fn markProcessedIfCanonical(self: *Store, message: protocol.Message) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        var canonical = (try self.messageByNonce(message.nonce)) orelse return false;
        defer canonical.deinit();
        if (!std.mem.eql(u8, &canonical.value.id(), &message.id())) return false;
        try self.markProcessedLocked(message);
        return true;
    }

    fn markProcessedLocked(self: *Store, message: protocol.Message) !void {
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, .nonce_processed, message.nonce, true);
        const prefix = try db.keys.pendingDestination(self.allocator, message.destination);
        defer self.allocator.free(prefix);
        var nonce: [4]u8 = undefined;
        std.mem.writeInt(u32, &nonce, message.nonce, .big);
        try batch.delete(prefix, &nonce);
        try self.delete(&batch, .terminally_dropped_message_by_id, message.id());
        try batch.commit();
    }

    pub fn storeInsertion(self: *Store, insertion: codec.MerkleInsertion, block_number: u64) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.putInsertion(insertion, block_number);
    }

    /// Unverified websocket notifications may fill a gap but cannot overwrite
    /// an RPC-authenticated insertion or its block metadata.
    pub fn storeInsertionIfAbsent(self: *Store, incoming: codec.MerkleInsertion, block_number: u64) !?codec.MerkleInsertion {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (try self.insertionByIndex(incoming.leaf_index)) |previous| return previous;
        _ = try self.putInsertion(incoming, block_number);
        return null;
    }

    fn putInsertion(self: *Store, insertion: codec.MerkleInsertion, block_number: u64) !bool {
        const previous = try self.insertionByIndex(insertion.leaf_index);
        const reverse = try self.leafIndex(insertion.message_id);
        const previous_block = try self.get(u64, .merkle_tree_insertion_block_number, insertion.leaf_index);
        if (previous != null and std.meta.eql(previous.?, insertion) and reverse == insertion.leaf_index and previous_block == block_number) return false;
        const replaced = previous != null and !std.mem.eql(u8, &previous.?.message_id, &insertion.message_id);
        if (replaced and self.tree_reset_generation == std.math.maxInt(u64)) return error.TreeGenerationExhausted;
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        if (previous) |old| if (!std.mem.eql(u8, &old.message_id, &insertion.message_id)) try self.delete(&batch, .merkle_leaf_index_by_message_id, old.message_id);
        try self.put(&batch, .merkle_tree_insertion, insertion.leaf_index, insertion);
        try self.put(&batch, .merkle_leaf_index_by_message_id, insertion.message_id, insertion.leaf_index);
        try self.put(&batch, .merkle_tree_insertion_block_number, insertion.leaf_index, block_number);
        try batch.commit();
        if (replaced) self.tree_reset_generation += 1;
        return previous == null or !std.meta.eql(previous.?, insertion);
    }

    pub fn insertionByIndex(self: *Store, index: u32) !?codec.MerkleInsertion {
        return self.get(codec.MerkleInsertion, .merkle_tree_insertion, index);
    }
    pub fn leafIndex(self: *Store, id: Hash) !?u32 {
        return self.get(u32, .merkle_leaf_index_by_message_id, id);
    }

    pub fn logBlock(self: *Store, stream: Stream, sequence: u32) !?u64 {
        const table: Table = switch (stream) {
            .dispatch => blk: {
                var message = (try self.messageByNonce(sequence)) orelse return null;
                defer message.deinit();
                break :blk .message_dispatched_block_number;
            },
            .insertion => blk: {
                if (try self.insertionByIndex(sequence) == null) return null;
                break :blk .merkle_tree_insertion_block_number;
            },
            .gas => blk: {
                if (try self.get(codec.GasPayment, .gas_payment_by_sequence, sequence) == null) return null;
                break :blk .gas_payment_block_by_sequence;
            },
            .delivery => return error.UnsequencedStream,
        };
        return self.get(u64, table, sequence);
    }

    fn backwardTable(stream: Stream) !Table {
        return switch (stream) {
            .dispatch => .message_backward_cursor,
            .insertion => .merkle_tree_insertion_backward_cursor,
            .gas => .gas_payment_backward_cursor,
            .delivery => error.UnsequencedStream,
        };
    }

    pub fn backwardProgress(self: *Store, stream: Stream, sequence: u32) !?codec.BackwardCursor {
        return self.get(codec.BackwardCursor, try backwardTable(stream), sequence);
    }

    pub fn saveBackwardProgress(self: *Store, stream: Stream, progress: codec.BackwardCursor) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, try backwardTable(stream), progress.sequence, progress);
        try batch.commit();
    }

    pub fn deleteBackwardProgress(self: *Store, stream: Stream, sequence: u32) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.delete(&batch, try backwardTable(stream), sequence);
        try batch.commit();
    }

    pub fn pendingAtOrAfter(self: *Store, destination: u32, sequence: u32) !?OwnedMessage {
        return self.pending(destination, sequence, false);
    }

    pub fn pendingAtOrBefore(self: *Store, destination: u32, sequence: u32) !?OwnedMessage {
        return self.pending(destination, sequence, true);
    }

    fn pending(self: *Store, destination: u32, sequence: u32, backwards: bool) !?OwnedMessage {
        self.mutex.lock();
        defer self.mutex.unlock();
        const prefix = try db.keys.pendingDestination(self.allocator, destination);
        defer self.allocator.free(prefix);
        var key: [4]u8 = undefined;
        std.mem.writeInt(u32, &key, sequence, .big);
        for (0..32) |_| {
            var entry = (try if (backwards) self.typed.atOrBefore(self.allocator, prefix, &key) else self.typed.atOrAfter(self.allocator, prefix, &key)) orelse return null;
            defer entry.deinit();
            if (entry.key.len != 4 or entry.value.len != 32) return error.InvalidPendingIndex;
            const nonce = std.mem.readInt(u32, entry.key[0..4], .big);
            const id = entry.value[0..32].*;
            var canonical = try self.messageByNonce(nonce);
            var transferred = false;
            defer if (!transferred) if (canonical) |*message| message.deinit();
            if (canonical) |message| {
                if (message.value.destination == destination and std.mem.eql(u8, &message.value.id(), &id) and !try self.processed(nonce) and !try self.terminal(id)) {
                    transferred = true;
                    return message;
                }
            }
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            try batch.delete(prefix, entry.key);
            try batch.commit();
        }
        return error.PendingIndexRepairYield;
    }

    pub const ReconcilePage = struct { scanned: usize, next: ?u32 };
    /// Rebuild legacy destination indexes in bounded pages on every process
    /// start. A persisted completion marker alone cannot prove that subsequent
    /// Rust writers maintained the derived index. Read each canonical nonce
    /// again under the mutation lock before repairing it.
    pub fn reconcileLegacyPage(self: *Store, first: u32, limit: usize) !ReconcilePage {
        return self.reconcilePage(first, limit, false);
    }
    pub fn reconcileLegacyBefore(self: *Store, first: u32, limit: usize) !ReconcilePage {
        return self.reconcilePage(first, limit, true);
    }
    fn reconcilePage(self: *Store, first: u32, limit: usize, backwards: bool) !ReconcilePage {
        if (limit == 0 or limit > 256) return error.InvalidMigrationPageLimit;
        var next = first;
        var count: usize = 0;
        while (count < limit) {
            var key: [4]u8 = undefined;
            std.mem.writeInt(u32, &key, next, .big);
            var row = (try if (backwards) self.typed.atOrBefore(self.allocator, Table.message_id.prefix(), &key) else self.typed.atOrAfter(self.allocator, Table.message_id.prefix(), &key)) orelse return .{ .scanned = count, .next = null };
            defer row.deinit();
            if (row.key.len != 4 or row.value.len != 32) return error.InvalidMessageNonceIndex;
            const nonce = std.mem.readInt(u32, row.key[0..4], .big);
            _ = try self.reconcileCanonicalPending(nonce);
            count += 1;
            next = (if (backwards) std.math.sub(u32, nonce, 1) else std.math.add(u32, nonce, 1)) catch return .{ .scanned = count, .next = null };
        }
        return .{ .scanned = count, .next = next };
    }

    pub fn payment(self: *Store, key: codec.GasPaymentKey) !?codec.GasPaymentData {
        return self.get(codec.GasPaymentData, .gas_payment_for_message_id, key);
    }

    pub fn storePayment(self: *Store, incoming: codec.GasPayment, meta: codec.GasPaymentMeta) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.putPayment(incoming, meta, null, 0);
    }

    pub fn storeIndexedPayment(self: *Store, incoming: codec.GasPayment, meta: codec.GasPaymentMeta, sequence: u32, block_number: u64) !bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        const previous = try self.get(codec.GasPayment, .gas_payment_by_sequence, sequence);
        const stored_block = try self.get(u64, .gas_payment_block_by_sequence, sequence);
        if (previous) |stored| {
            if (!std.meta.eql(stored, incoming)) return error.GasPaymentSequenceConflict;
            if (stored_block) |height| {
                if (height != block_number) return error.GasPaymentSequenceConflict;
                return false;
            }
            // Repair block metadata without aggregating an existing payment.
            var batch = try self.typed.batch(self.allocator);
            defer batch.deinit();
            try self.put(&batch, .gas_payment_by_sequence, sequence, incoming);
            try self.put(&batch, .gas_payment_block_by_sequence, sequence, block_number);
            try batch.commit();
            return false;
        }
        if (stored_block != null) return error.GasPaymentSequenceConflict;
        return self.putPayment(incoming, meta, sequence, block_number);
    }

    fn putPayment(self: *Store, incoming: codec.GasPayment, meta: codec.GasPaymentMeta, sequence: ?u32, block_number: u64) !bool {
        const already_processed = (try self.get(bool, .gas_payment_meta_processed, meta)) orelse false;
        if (already_processed and sequence == null) return false;
        const key: codec.GasPaymentKey = .{ .message_id = incoming.message_id, .destination = incoming.destination };
        const old = (try self.payment(key)) orelse codec.GasPaymentData{ .payment = 0, .gas_amount = 0 };
        const total: codec.GasPaymentData = .{ .payment = old.payment +| incoming.payment, .gas_amount = old.gas_amount +| incoming.gas_amount };
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        if (!already_processed) {
            try self.put(&batch, .gas_payment_meta_processed, meta, true);
            try self.put(&batch, .gas_payment_for_message_id, key, total);
        }
        if (sequence) |number| {
            try self.put(&batch, .gas_payment_by_sequence, number, incoming);
            try self.put(&batch, .gas_payment_block_by_sequence, number, block_number);
        }
        try batch.commit();
        return !already_processed;
    }

    pub fn expenditure(self: *Store, id: Hash) !codec.GasExpenditureData {
        return (try self.get(codec.GasExpenditureData, .gas_expenditure_for_message_id, id)) orelse .{ .tokens_used = 0, .gas_used = 0 };
    }

    pub fn addExpenditure(self: *Store, id: Hash, spent: codec.GasExpenditureData) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const old = try self.expenditure(id);
        const total: codec.GasExpenditureData = .{ .tokens_used = old.tokens_used +| spent.tokens_used, .gas_used = old.gas_used +| spent.gas_used };
        var batch = try self.typed.batch(self.allocator);
        defer batch.deinit();
        try self.put(&batch, .gas_expenditure_for_message_id, id, total);
        try batch.commit();
    }

    /// Zig-specific scan cursor: separate namespace, without changing Rust's
    /// canonical message/payment/tree tables or trusting a migration marker.
    pub fn cursor(self: *Store, stream: Stream) !?u64 {
        const prefix = "zig_scan_cursor_v1_";
        const bytes = (try self.typed.get(self.allocator, prefix, @tagName(stream))) orelse return null;
        defer self.allocator.free(bytes);
        return try codec.decode(u64, bytes);
    }
    pub fn storeCursor(self: *Store, stream: Stream, height: u64) !void {
        const bytes = try codec.encode(self.allocator, height);
        defer self.allocator.free(bytes);
        try self.typed.put(self.allocator, "zig_scan_cursor_v1_", @tagName(stream), bytes);
    }

    pub fn gasWatermark(self: *Store) !?u32 {
        const bytes = (try self.typed.get(self.allocator, Table.latest_indexed_gas_payment_block.prefix(), &.{})) orelse return null;
        defer self.allocator.free(bytes);
        return try codec.decode(u32, bytes);
    }
    pub fn storeGasWatermark(self: *Store, height: u32) !void {
        var bytes: [4]u8 = undefined;
        std.mem.writeInt(u32, &bytes, height, .big);
        try self.typed.put(self.allocator, Table.latest_indexed_gas_payment_block.prefix(), &.{}, &bytes);
    }
};
