//! Durable scraper-websocket cursors and canonical parity over the parent Store.
//! No stream event marks a message processed/delivered or resets signed metadata.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const native = @import("../store.zig");
const db = @import("../../db/root.zig");
const codec = db.codec;
const Table = db.keys.Table;

pub const DISPATCH_CURSOR_PREFIX = "scraper_websocket_dispatch_cursor";
pub const GAS_PAYMENT_CURSOR_PREFIX = "scraper_websocket_gas_payment_cursor";
pub const MERKLE_CURSOR_PREFIX = "scraper_websocket_merkle_cursor";
pub const PARITY_UNHEALTHY_PREFIX = "scraper_websocket_parity_unhealthy_v2";
pub const PARITY_UNHEALTHY_V1_PREFIX = "scraper_websocket_parity_unhealthy";

pub const EventKind = enum {
    dispatch,
    gas_payment,
    merkle_tree_insertion,
    pub fn label(self: EventKind) []const u8 {
        return @tagName(self);
    }
};

pub const Contracts = struct {
    mailbox: [32]u8,
    interchain_gas_paymaster: [32]u8,
    merkle_tree_hook: [32]u8,
    pub fn address(self: Contracts, kind: EventKind) [32]u8 {
        return switch (kind) {
            .dispatch => self.mailbox,
            .gas_payment => self.interchain_gas_paymaster,
            .merkle_tree_insertion => self.merkle_tree_hook,
        };
    }
};

pub fn cursorPrefix(kind: EventKind) ![]const u8 {
    return switch (kind) {
        .dispatch => DISPATCH_CURSOR_PREFIX,
        .gas_payment => error.GasPaymentUsesRowCursor,
        .merkle_tree_insertion => MERKLE_CURSOR_PREFIX,
    };
}

pub const GasPaymentCursor = struct {
    fingerprint: ?[32]u8,
    legacy_max_stream_cursor: u64,
    stream_cursor: u64,

    pub fn encodeAlloc(self: GasPaymentCursor, allocator: std.mem.Allocator) ![]u8 {
        var writer: codec.Writer = .{ .allocator = allocator };
        defer writer.deinit();
        try writer.boolean(self.fingerprint != null);
        if (self.fingerprint) |fingerprint| try writer.append(&fingerprint);
        try writer.integer(self.legacy_max_stream_cursor);
        try writer.integer(self.stream_cursor);
        return writer.owned();
    }

    pub fn decode(bytes: []const u8) !GasPaymentCursor {
        var reader: codec.Reader = .{ .bytes = bytes };
        const fingerprint = if (try reader.boolean()) try reader.fixed(32) else null;
        return .{
            .fingerprint = fingerprint,
            .legacy_max_stream_cursor = try reader.integer(u64),
            .stream_cursor = try reader.integer(u64),
        };
    }
};

pub const DispatchInput = struct {
    block_number: u64,
    message: protocol.Message,
    missing_body_id: ?[32]u8 = null,
    transaction_id: [64]u8,
    pub fn storable(self: DispatchInput) bool {
        return self.missing_body_id == null;
    }
    pub fn messageId(self: DispatchInput) [32]u8 {
        return self.missing_body_id orelse self.message.id();
    }
    pub fn bodyBytes(self: DispatchInput) usize {
        return self.message.body.len;
    }
};

pub const MerkleInput = struct {
    block_number: u64,
    insertion: codec.MerkleInsertion,
};

pub const ParityInput = union(enum) {
    dispatch: DispatchInput,
    merkle_tree_insertion: MerkleInput,
    pub fn kind(self: ParityInput) EventKind {
        return switch (self) {
            .dispatch => .dispatch,
            .merkle_tree_insertion => .merkle_tree_insertion,
        };
    }
    pub fn sequence(self: ParityInput) u32 {
        return switch (self) {
            .dispatch => |input| input.message.nonce,
            .merkle_tree_insertion => |input| input.insertion.leaf_index,
        };
    }
    pub fn bodyBytes(self: ParityInput) usize {
        return switch (self) {
            .dispatch => |input| input.bodyBytes(),
            .merkle_tree_insertion => 0,
        };
    }
};

pub const GasPaymentInput = struct {
    cursor: GasPaymentCursor,
    payment: codec.GasPayment,
    meta: codec.GasPaymentMeta,
    sequence: ?u32,
    block_number: u64,
};

pub const ParityResult = enum { match, missing, conflict };

fn messagesEqual(a: protocol.Message, b: protocol.Message) bool {
    return a.version == b.version and a.nonce == b.nonce and a.origin == b.origin and
        a.destination == b.destination and std.mem.eql(u8, &a.sender, &b.sender) and
        std.mem.eql(u8, &a.recipient, &b.recipient) and std.mem.eql(u8, a.body, b.body);
}

pub const Adapter = struct {
    store: *native.Store,
    contracts: Contracts,
    mutex: std.Thread.Mutex = .{},

    pub fn init(store: *native.Store, contracts: Contracts) Adapter {
        return .{ .store = store, .contracts = contracts };
    }

    fn get(store: *native.Store, comptime T: type, prefix: []const u8, key: anytype) !?T {
        const encoded = try codec.encode(store.allocator, key);
        defer store.allocator.free(encoded);
        const bytes = (try store.typed.get(store.allocator, prefix, encoded)) orelse return null;
        defer store.allocator.free(bytes);
        return try codec.decode(T, bytes);
    }

    fn put(store: *native.Store, prefix: []const u8, key: anytype, value: anytype) !void {
        const encoded_key = try codec.encode(store.allocator, key);
        defer store.allocator.free(encoded_key);
        const encoded_value = try codec.encode(store.allocator, value);
        defer store.allocator.free(encoded_value);
        try store.typed.put(store.allocator, prefix, encoded_key, encoded_value);
    }

    fn cursorUnlocked(self: *Adapter, kind: EventKind) !?u32 {
        return get(self.store, u32, try cursorPrefix(kind), self.contracts.address(kind));
    }

    pub fn cursor(self: *Adapter, kind: EventKind) !?u32 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.cursorUnlocked(kind);
    }

    pub fn storeCursor(self: *Adapter, kind: EventKind, sequence: u32) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (try self.cursorUnlocked(kind)) |stored| {
            if (stored >= sequence) return;
        }
        try put(self.store, try cursorPrefix(kind), self.contracts.address(kind), sequence);
    }

    fn gasPaymentCursorUnlocked(self: *Adapter) !?GasPaymentCursor {
        return get(self.store, GasPaymentCursor, GAS_PAYMENT_CURSOR_PREFIX, self.contracts.interchain_gas_paymaster);
    }

    pub fn gasPaymentCursor(self: *Adapter) !?GasPaymentCursor {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.gasPaymentCursorUnlocked();
    }

    pub fn storeGasPaymentCursor(self: *Adapter, incoming: GasPaymentCursor) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (try self.gasPaymentCursorUnlocked()) |stored| {
            if (stored.stream_cursor > incoming.stream_cursor) return error.DurableGasCursorMovedBackwards;
            if (stored.stream_cursor == incoming.stream_cursor) {
                if (incoming.fingerprint == null) return;
                if (stored.fingerprint != null and incoming.fingerprint != null and std.mem.eql(u8, &stored.fingerprint.?, &incoming.fingerprint.?)) return;
                if (stored.fingerprint != null) return error.ConflictingDurableGasCursor;
            }
        }
        try put(self.store, GAS_PAYMENT_CURSOR_PREFIX, self.contracts.interchain_gas_paymaster, incoming);
    }

    pub fn parityUnhealthy(self: *Adapter, kind: EventKind) !bool {
        if (kind == .gas_payment) return false;
        return (try get(self.store, bool, PARITY_UNHEALTHY_PREFIX, self.contracts.address(kind))) orelse false;
    }

    pub fn storeParityUnhealthy(self: *Adapter, kind: EventKind) !void {
        if (kind == .gas_payment) return error.GasPaymentHasNoParityHealth;
        try put(self.store, PARITY_UNHEALTHY_PREFIX, self.contracts.address(kind), true);
    }

    pub fn localEventPresent(self: *Adapter, kind: EventKind, sequence: u32) !bool {
        return switch (kind) {
            .dispatch => blk: {
                var message = (try self.store.messageByNonce(sequence)) orelse break :blk false;
                defer message.deinit();
                break :blk (try self.store.messageBlock(sequence)) != null;
            },
            .merkle_tree_insertion => blk: {
                if (try self.store.insertionByIndex(sequence) == null) break :blk false;
                break :blk (try self.store.logBlock(.insertion, sequence)) != null;
            },
            .gas_payment => error.GasPaymentHasNoSequence,
        };
    }

    fn compareUnlocked(self: *Adapter, input: ParityInput) !ParityResult {
        switch (input) {
            .dispatch => |event| {
                var local_message = try self.store.messageByNonce(event.message.nonce);
                defer if (local_message) |*message| message.deinit();
                const local_block = try self.store.messageBlock(event.message.nonce);
                const local_transaction = try self.store.dispatchedTransaction(event.messageId());
                const message_conflicts = if (local_message) |local| blk: {
                    if (event.missing_body_id) |id| {
                        break :blk !std.mem.eql(u8, &local.value.id(), &id) or
                            local.value.nonce != event.message.nonce or local.value.origin != event.message.origin or
                            local.value.destination != event.message.destination or
                            !std.mem.eql(u8, &local.value.sender, &event.message.sender) or
                            !std.mem.eql(u8, &local.value.recipient, &event.message.recipient);
                    }
                    break :blk !messagesEqual(local.value, event.message);
                } else false;
                const transaction_conflicts = !std.mem.allEqual(u8, &event.transaction_id, 0) and
                    local_transaction != null and !std.mem.allEqual(u8, &local_transaction.?, 0) and
                    !std.mem.eql(u8, &local_transaction.?, &event.transaction_id);
                if (message_conflicts or (local_block != null and local_block.? != event.block_number) or transaction_conflicts) return .conflict;
                if (local_message == null or local_block == null) return .missing;
                return .match;
            },
            .merkle_tree_insertion => |event| {
                const local = try self.store.insertionByIndex(event.insertion.leaf_index);
                const local_block = try self.store.logBlock(.insertion, event.insertion.leaf_index);
                if (local != null and !std.meta.eql(local.?, event.insertion)) return .conflict;
                if (local_block != null and local_block.? != event.block_number) return .conflict;
                if (local == null or local_block == null) return .missing;
                return .match;
            },
        }
    }

    pub fn compare(self: *Adapter, input: ParityInput) !ParityResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.compareUnlocked(input);
    }

    fn backfillDispatchTransaction(self: *Adapter, event: DispatchInput) !void {
        if (std.mem.allEqual(u8, &event.transaction_id, 0)) return;
        self.store.mutex.lock();
        defer self.store.mutex.unlock();
        const id = event.messageId();
        const previous = try get(self.store, [64]u8, Table.message_dispatched_tx_hash.prefix(), id);
        if (previous != null and !std.mem.allEqual(u8, &previous.?, 0)) return;
        var batch = try self.store.typed.batch(self.store.allocator);
        defer batch.deinit();
        const bytes = try codec.encode(self.store.allocator, event.transaction_id);
        defer self.store.allocator.free(bytes);
        try batch.put(Table.message_dispatched_tx_hash.prefix(), &id, bytes);
        try batch.commit();
    }

    fn storeMerkleEvent(self: *Adapter, event: MerkleInput) !void {
        if (try self.store.storeInsertionIfAbsent(event.insertion, event.block_number)) |previous| {
            if (!std.meta.eql(previous, event.insertion)) return error.ScraperEventConflictsWithCanonical;
        }
        if (try self.compareUnlocked(.{ .merkle_tree_insertion = event }) != .match) return error.ScraperEventConflictsWithCanonical;
    }

    pub fn storeSequencedEvent(self: *Adapter, input: ParityInput) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (input == .merkle_tree_insertion) {
            if (try self.compareUnlocked(input) == .conflict) return error.ScraperEventConflictsWithCanonical;
            return self.storeMerkleEvent(input.merkle_tree_insertion);
        }
        const event = input.dispatch;
        switch (try self.compareUnlocked(input)) {
            .conflict => return error.ScraperEventConflictsWithCanonical,
            .match => {
                try self.backfillDispatchTransaction(event);
                // A prior canonical commit may have hit bounded notification
                // backpressure. Replay must fan out again before its WS cursor
                // advances, including bodyless events with an omitted tx ID.
                self.store.mutex.lock();
                defer self.store.mutex.unlock();
                return self.store.notifyDispatch(event.block_number, try self.store.dispatchedTransaction(event.messageId()));
            },
            .missing => {},
        }
        if (!event.storable()) return error.BodylessDispatchCannotBeStored;
        _ = try self.store.storeMessage(event.message, event.block_number, event.transaction_id);
        if (try self.compareUnlocked(input) != .match) return error.StoredScraperEventRemainsIncomplete;
    }

    pub fn storeGasPayment(self: *Adapter, input: GasPaymentInput) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (input.sequence) |sequence| {
            _ = try self.store.storeIndexedPayment(input.payment, input.meta, sequence, input.block_number);
        } else {
            _ = try self.store.storePayment(input.payment, input.meta);
        }
    }
};

test "gas cursor encoding is exact and sequenced prefixes cannot be confused" {
    const allocator = std.testing.allocator;
    const cursor = GasPaymentCursor{ .fingerprint = [_]u8{0xab} ** 32, .legacy_max_stream_cursor = 0x0102, .stream_cursor = 0x0102030405060708 };
    const encoded = try cursor.encodeAlloc(allocator);
    defer allocator.free(encoded);
    try std.testing.expectEqual(@as(usize, 49), encoded.len);
    try std.testing.expectEqual(@as(u8, 1), encoded[0]);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2 }, encoded[39..41]);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3, 4, 5, 6, 7, 8 }, encoded[41..49]);
    try std.testing.expectEqual(cursor, try GasPaymentCursor.decode(encoded));
    const empty = GasPaymentCursor{ .fingerprint = null, .legacy_max_stream_cursor = 0, .stream_cursor = 0 };
    const empty_bytes = try empty.encodeAlloc(allocator);
    defer allocator.free(empty_bytes);
    try std.testing.expectEqualSlices(u8, &([_]u8{0} ** 17), empty_bytes);
    try std.testing.expectError(error.GasPaymentUsesRowCursor, cursorPrefix(.gas_payment));
}

pub fn runInsertionBarrierRegression(allocator: std.mem.Allocator) !void {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const parent = try temporary.dir.realpathAlloc(allocator, ".");
    defer allocator.free(parent);
    const path = try std.fs.path.join(allocator, &.{ parent, "insertion-barrier" });
    defer allocator.free(path);
    var database = try db.rocks.Database.open(allocator, path, .{ .sync = true });
    defer database.deinit();
    var store = native.Store.init(allocator, &database, "fixture");
    var adapter = Adapter.init(&store, std.mem.zeroes(Contracts));

    const websocket = MerkleInput{ .block_number = 10, .insertion = .{ .leaf_index = 0, .message_id = @splat(0xbb) } };
    try std.testing.expectEqual(ParityResult.missing, try adapter.compare(.{ .merkle_tree_insertion = websocket }));
    const canonical = codec.MerkleInsertion{ .leaf_index = 0, .message_id = @splat(0xaa) };
    _ = try store.storeInsertion(canonical, 20);
    try std.testing.expectError(error.ScraperEventConflictsWithCanonical, adapter.storeMerkleEvent(websocket));
    try std.testing.expectEqual(canonical, (try store.insertionByIndex(0)).?);
    try std.testing.expectEqual(@as(?u64, 20), try store.logBlock(.insertion, 0));

    const initially_matching = MerkleInput{ .block_number = 30, .insertion = .{ .leaf_index = 1, .message_id = @splat(0xcc) } };
    _ = try store.storeInsertion(initially_matching.insertion, initially_matching.block_number);
    try std.testing.expectEqual(ParityResult.match, try adapter.compare(.{ .merkle_tree_insertion = initially_matching }));
    const replacement = codec.MerkleInsertion{ .leaf_index = 1, .message_id = @splat(0xdd) };
    _ = try store.storeInsertion(replacement, 40);
    try std.testing.expectError(error.ScraperEventConflictsWithCanonical, adapter.storeMerkleEvent(initially_matching));
    try std.testing.expectEqual(replacement, (try store.insertionByIndex(1)).?);
    try std.testing.expectEqual(@as(?u64, 40), try store.logBlock(.insertion, 1));
}

test "websocket insertion barrier preserves the canonical RPC winner and block" {
    try runInsertionBarrierRegression(std.testing.allocator);
}

test "matching websocket dispatch retries bounded notification after canonical commit" {
    const a = std.testing.allocator;
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const path = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{ .sync = true });
    defer database.deinit();
    var store = native.Store.init(a, &database, "notification-replay");
    var adapter = Adapter.init(&store, std.mem.zeroes(Contracts));
    const Notice = @import("../../runtime/tx_id_observer.zig").Notification;
    const Sink = struct {
        full: bool = true,
        attempts: usize = 0,
        accepted: ?Notice = null,
        fn notify(context: *anyopaque, value: Notice) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.attempts += 1;
            if (self.full) return error.TransactionNotificationQueueFull;
            self.accepted = value;
        }
    };
    var sink: Sink = .{};
    store.dispatch_notifications = .{ .context = &sink, .notify_fn = Sink.notify };
    const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(3), .recipient = @splat(4), .body = "canonical" };
    const transaction: [64]u8 = @splat(0x65);
    const event: DispatchInput = .{ .message = message, .block_number = 17, .transaction_id = transaction };
    try std.testing.expectError(error.TransactionNotificationQueueFull, adapter.storeSequencedEvent(.{ .dispatch = event }));
    try std.testing.expectEqual(ParityResult.match, try adapter.compare(.{ .dispatch = event }));
    try std.testing.expectEqual(@as(usize, 1), sink.attempts);
    sink.full = false;
    var bodyless = event;
    bodyless.message.body = "";
    bodyless.missing_body_id = message.id();
    bodyless.transaction_id = @splat(0);
    try adapter.storeSequencedEvent(.{ .dispatch = bodyless });
    try std.testing.expectEqual(@as(usize, 2), sink.attempts);
    try std.testing.expectEqual(transaction, sink.accepted.?.transaction);
    try std.testing.expectEqual(@as(u64, 17), sink.accepted.?.block_number);
    var canonical = (try store.messageByNonce(0)).?;
    defer canonical.deinit();
    try std.testing.expectEqualSlices(u8, &message.id(), &canonical.value.id());
    var conflict = event;
    conflict.transaction_id = @splat(0x66);
    try std.testing.expectError(error.ScraperEventConflictsWithCanonical, adapter.storeSequencedEvent(.{ .dispatch = conflict }));
    try std.testing.expectEqual(@as(usize, 2), sink.attempts);
}
