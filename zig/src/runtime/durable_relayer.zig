const std = @import("std");
const relayer = @import("relayer.zig");
const journal = @import("journal.zig");
const protocol = @import("../protocol/root.zig");

const Config = struct { id: relayer.Hash, policy: relayer.Policy, context: relayer.Hash };
const Transaction = struct { generation: u64, bytes: []const u8 };
const Record = union(enum) { initialize: Config, event: relayer.Event, transaction: Transaction };

/// One durable operation, including the exact public signed transaction bytes.
/// A single serialized driver owns it. No effects run during recovery.
pub const DurableOperation = struct {
    operation: relayer.Operation,
    log: journal.Journal,
    allocator: std.mem.Allocator,
    transaction_bytes: ?[]u8 = null,
    pub const max_transaction_bytes = 128 * 1024;

    pub fn open(allocator: std.mem.Allocator, dir: std.fs.Dir, path: []const u8, id: relayer.Hash, policy: relayer.Policy, repair_torn_tail: bool, context: relayer.Hash) !DurableOperation {
        var opened = try journal.Journal.open(allocator, dir, path, repair_torn_tail);
        errdefer opened.journal.close();
        defer allocator.free(opened.replay);
        var self: DurableOperation = .{ .operation = .{ .id = id, .policy = policy }, .log = opened.journal, .allocator = allocator };
        errdefer if (self.transaction_bytes) |bytes| allocator.free(bytes);
        var reader: journal.Reader = .{ .bytes = opened.replay };
        var initialized = false;
        while (try reader.next()) |frame| {
            const parsed = try std.json.parseFromSlice(Record, allocator, frame.payload, .{});
            defer parsed.deinit();
            if (!initialized) {
                switch (parsed.value) {
                    .initialize => |config| {
                        if (!std.meta.eql(config, Config{ .id = id, .policy = policy, .context = context })) return error.JournalIdentityMismatch;
                        initialized = true;
                    },
                    else => return error.JournalMissingInitialization,
                }
                continue;
            }
            switch (parsed.value) {
                .initialize => return error.JournalDuplicateInitialization,
                .event => |event| {
                    if (event == .transaction_built) return error.JournalMissingTransaction;
                    _ = try self.operation.apply(event);
                },
                .transaction => |transaction| {
                    _ = try self.restoreTransaction(transaction);
                },
            }
        }
        if (!initialized) try self.persist(.{ .initialize = .{ .id = id, .policy = policy, .context = context } });
        return self;
    }

    pub fn close(self: *DurableOperation) void {
        if (self.transaction_bytes) |bytes| self.allocator.free(bytes);
        self.log.close();
        self.* = undefined;
    }

    pub fn apply(self: *DurableOperation, event: relayer.Event) !relayer.Effect {
        // Enforce that a transaction's recoverable bytes exist in the same
        // durable record as its identity, rather than accepting a bare hash.
        if (event == .transaction_built) return error.UseRecordTransaction;
        var next = self.operation;
        const effect = try next.apply(event);
        // Read-only retries and already-durable identical rebroadcasts need no
        // new WAL record. Polling a parked operation must not exhaust its log.
        if (std.meta.eql(next, self.operation)) return effect;
        try self.persist(.{ .event = event });
        self.operation = next;
        return effect;
    }

    pub fn recordTransaction(self: *DurableOperation, generation: u64, bytes: []const u8) !relayer.Effect {
        if (bytes.len == 0 or bytes.len > max_transaction_bytes) return error.InvalidTransactionSize;
        var id: relayer.Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(bytes, &id, .{});
        var next = self.operation;
        const effect = try next.apply(.{ .transaction_built = .{ .generation = generation, .transaction = id } });
        const owned = try self.allocator.dupe(u8, bytes);
        errdefer self.allocator.free(owned);
        try self.persist(.{ .transaction = .{ .generation = generation, .bytes = bytes } });
        if (self.transaction_bytes) |previous| self.allocator.free(previous);
        self.transaction_bytes = owned;
        self.operation = next;
        return effect;
    }

    fn restoreTransaction(self: *DurableOperation, transaction: Transaction) !relayer.Effect {
        if (transaction.bytes.len == 0 or transaction.bytes.len > max_transaction_bytes) return error.InvalidTransactionSize;
        var id: relayer.Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(transaction.bytes, &id, .{});
        const effect = try self.operation.apply(.{ .transaction_built = .{ .generation = transaction.generation, .transaction = id } });
        const owned = try self.allocator.dupe(u8, transaction.bytes);
        if (self.transaction_bytes) |previous| self.allocator.free(previous);
        self.transaction_bytes = owned;
        return effect;
    }

    fn persist(self: *DurableOperation, record: Record) !void {
        const bytes = try std.json.Stringify.valueAlloc(self.allocator, record, .{});
        defer self.allocator.free(bytes);
        try self.log.append(bytes);
    }
};

test "crash after transaction reservation replays identical bytes before rebroadcast" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const allocator = std.testing.allocator;
    const id: relayer.Hash = @splat(1);
    var op = try DurableOperation.open(allocator, temp.dir, "op.wal", id, .{}, false, @splat(7));
    _ = try op.apply(.{ .tick = .{ .now_ms = 1 } });
    _ = try op.apply(.{ .prepared = .{ .generation = 1, .gas_allowed = true, .metadata_valid = true } });
    const effect = try op.recordTransaction(1, "signed transaction fixture");
    op.close(); // Simulate losing the broadcast effect after its durable commit.
    var restored = try DurableOperation.open(allocator, temp.dir, "op.wal", id, .{}, false, @splat(7));
    defer restored.close();
    try std.testing.expectEqualStrings("signed transaction fixture", restored.transaction_bytes.?);
    const transaction = effect.broadcast;
    try std.testing.expectEqual(relayer.Effect{ .reconcile = transaction }, try restored.apply(.{ .tick = .{ .now_ms = 2 } }));
    try std.testing.expectEqual(relayer.Effect{ .broadcast = transaction }, try restored.apply(.{ .rebroadcast = .{ .transaction = transaction } }));
    try std.testing.expectError(error.JournalIdentityMismatch, blk: {
        restored.log.close();
        // Reopen mismatch must fail; restore ownership for deferred close.
        const result = DurableOperation.open(allocator, temp.dir, "op.wal", @splat(9), .{}, false, @splat(7));
        const opened = try journal.Journal.open(allocator, temp.dir, "op.wal", false);
        allocator.free(opened.replay);
        restored.log = opened.journal;
        break :blk result;
    });
}

test "recovery binds route authority and no-op polling cannot grow the journal" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const allocator = std.testing.allocator;
    var op = try DurableOperation.open(allocator, temp.dir, "route.wal", @splat(1), .{}, false, @splat(2));
    _ = try op.apply(.{ .tick = .{ .now_ms = 0 } });
    const sequence = op.log.sequence;
    for (0..1000) |_| {
        _ = try op.apply(.{ .tick = .{ .now_ms = 0 } });
    }
    try std.testing.expectEqual(sequence, op.log.sequence);
    op.close();
    try std.testing.expectError(error.JournalIdentityMismatch, DurableOperation.open(allocator, temp.dir, "route.wal", @splat(1), .{}, false, @splat(3)));
    var resumed = try DurableOperation.open(allocator, temp.dir, "route.wal", @splat(1), .{}, false, @splat(2));
    defer resumed.close();
    try std.testing.expectEqual(relayer.Effect{ .prepare = 1 }, try resumed.apply(.{ .tick = .{ .now_ms = 0 } }));
}
