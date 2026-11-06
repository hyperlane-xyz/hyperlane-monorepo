const std = @import("std");
const accounting = @import("evm_accounting.zig");
const protocol = @import("../../protocol/root.zig");
const db = @import("../../db/root.zig");
const native = @import("../store.zig");

const A = std.mem.Allocator;

const Fixture = struct {
    allocator: A,
    temporary: std.testing.TmpDir,
    path: []u8,
    message: protocol.Message,

    fn init(allocator: A) !Fixture {
        var temporary = std.testing.tmpDir(.{});
        errdefer temporary.cleanup();
        const parent = try temporary.dir.realpathAlloc(allocator, ".");
        defer allocator.free(parent);
        const path = try std.fs.path.join(allocator, &.{ parent, "evm-accounting" });
        errdefer allocator.free(path);
        return .{
            .allocator = allocator,
            .temporary = temporary,
            .path = path,
            .message = .{ .version = 3, .nonce = 7, .origin = 1000, .destination = 2000, .sender = @splat(1), .recipient = @splat(2), .body = "accounted" },
        };
    }

    fn deinit(self: *Fixture) void {
        self.allocator.free(self.path);
        self.temporary.cleanup();
    }

    fn open(self: *Fixture, database: *db.rocks.Database) !native.Store {
        database.* = try db.rocks.Database.open(self.allocator, self.path, .{ .sync = true });
        errdefer database.deinit();
        var store = native.Store.init(self.allocator, database, "origin");
        var existing = try store.messageByNonce(self.message.nonce);
        defer if (existing) |*message| message.deinit();
        if (existing == null) _ = try store.storeMessage(self.message, 1, null);
        return store;
    }
};

fn input(message: protocol.Message, generation: u64, payload: [16]u8, transaction_uuid: [16]u8, hash: [32]u8, gas: u256, price: u256, operation: u256, submission: u256) accounting.CostInput {
    return .{
        .message = message,
        .generation = generation,
        .payload_uuid = payload,
        .transaction_uuid = transaction_uuid,
        .transaction_hash = hash,
        .gas_used = gas,
        .gas_price = price,
        .operation_estimate = operation,
        .submission_estimate = submission,
    };
}

test "Rust ratio oracle full fallback token conversion and u256 extremes" {
    const vectors = [_]struct {
        actual: u256,
        operation: u256,
        submission: u256,
        price: u256,
        gas: u256,
        tokens: u256,
    }{
        .{ .actual = 1_000_000, .operation = 333_333, .submission = 1_000_000, .price = 7, .gas = 333_333, .tokens = 2_333_331 },
        .{ .actual = 21_000, .operation = 100, .submission = 300, .price = 2, .gas = 7_000, .tokens = 14_000 },
        .{ .actual = 44, .operation = 100, .submission = 0, .price = 2, .gas = 44, .tokens = 88 },
        .{ .actual = 51, .operation = 0, .submission = 100, .price = 9, .gas = 0, .tokens = 0 },
        .{ .actual = std.math.maxInt(u256), .operation = std.math.maxInt(u256), .submission = 1, .price = 1, .gas = std.math.maxInt(u256), .tokens = std.math.maxInt(u256) },
    };
    for (vectors) |vector| {
        const actual = try accounting.calculate(vector.actual, vector.price, vector.operation, vector.submission);
        try std.testing.expectEqual(vector.gas, actual.gas_used);
        try std.testing.expectEqual(vector.tokens, actual.tokens_used);
    }
    try std.testing.expectError(error.AccountingTokenOverflow, accounting.calculate(std.math.maxInt(u256), 2, 1, 1));
}

test "native Rocks marker survives restart and duplicate batch and new generation accounting is exact" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const first = input(fixture.message, 1, @splat(1), @splat(3), @splat(4), 100, 2, 100, 100);
    {
        var database: db.rocks.Database = undefined;
        var store = try fixture.open(&database);
        defer database.deinit();
        try std.testing.expectEqual(accounting.RecordResult.recorded, try accounting.recordCost(a, &store, first));
        var marker = (try accounting.loadMarker(a, &store, first.payload_uuid)).?;
        defer marker.deinit();
        try std.testing.expectEqual(first.transaction_hash, marker.value().transaction_hash);
        try std.testing.expectEqual(first.transaction_uuid, marker.value().transaction_uuid);
        try std.testing.expectEqual(@as(u256, 100), marker.value().gas_used);
        try std.testing.expectEqual(@as(u256, 200), marker.value().tokens_used);
        try std.testing.expectEqual(accounting.RecordResult.duplicate, try accounting.recordCost(a, &store, first));
        const total = try store.expenditure(fixture.message.id());
        try std.testing.expectEqual(@as(u256, 100), total.gas_used);
        try std.testing.expectEqual(@as(u256, 200), total.tokens_used);
    }
    var database: db.rocks.Database = undefined;
    var store = try fixture.open(&database);
    defer database.deinit();
    try std.testing.expectEqual(accounting.RecordResult.duplicate, try accounting.recordCost(a, &store, first));
    const second = input(fixture.message, 2, @splat(2), @splat(5), @splat(6), 50, 4, 50, 50);
    try std.testing.expectEqual(accounting.RecordResult.recorded, try accounting.recordCost(a, &store, second));
    var total = try store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 150), total.gas_used);
    try std.testing.expectEqual(@as(u256, 400), total.tokens_used);

    const replayed_hash = input(fixture.message, 3, @splat(8), first.transaction_uuid, first.transaction_hash, 100, 2, 100, 100);
    try std.testing.expectError(error.PartialAccountingMarker, accounting.recordCost(a, &store, replayed_hash));
    var conflicting_transaction = replayed_hash;
    conflicting_transaction.transaction_uuid = @splat(9);
    try std.testing.expectError(error.AccountingTransactionConflict, accounting.recordCost(a, &store, conflicting_transaction));
    total = try store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 150), total.gas_used);
    try std.testing.expectEqual(@as(u256, 400), total.tokens_used);

    var other_message = fixture.message;
    other_message.nonce = 8;
    other_message.body = "batch sibling";
    try store.upsertMessage(other_message, 1, null);
    const sibling = input(other_message, 1, @splat(7), first.transaction_uuid, first.transaction_hash, 25, 2, 25, 25);
    try std.testing.expectEqual(accounting.RecordResult.recorded, try accounting.recordCost(a, &store, sibling));
    total = try store.expenditure(other_message.id());
    try std.testing.expectEqual(@as(u256, 25), total.gas_used);
    try std.testing.expectEqual(@as(u256, 50), total.tokens_used);
    total = try store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 150), total.gas_used);
    try std.testing.expectEqual(@as(u256, 400), total.tokens_used);
}

test "partial marker states fail closed without creating a zero expenditure" {
    const a = std.testing.allocator;
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        var database: db.rocks.Database = undefined;
        var store = try fixture.open(&database);
        defer database.deinit();
        const value = input(fixture.message, 1, @splat(1), @splat(3), @splat(4), 100, 2, 100, 100);
        const marker: accounting.Marker = .{
            .message_id = fixture.message.id(),
            .generation = 1,
            .payload_uuid = value.payload_uuid,
            .transaction_uuid = value.transaction_uuid,
            .transaction_hash = value.transaction_hash,
            .gas_used = 100,
            .tokens_used = 200,
        };
        const encoded = try std.json.Stringify.valueAlloc(a, marker, .{});
        defer a.free(encoded);
        try store.typed.put(a, accounting.accounted_payload_prefix, &value.payload_uuid, encoded);
        try std.testing.expectError(error.PartialAccountingMarker, accounting.recordCost(a, &store, value));
        const total = try store.expenditure(fixture.message.id());
        try std.testing.expectEqual(@as(u256, 0), total.gas_used);
        try std.testing.expectEqual(@as(u256, 0), total.tokens_used);
    }
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        var database: db.rocks.Database = undefined;
        var store = try fixture.open(&database);
        defer database.deinit();
        const value = input(fixture.message, 1, @splat(1), @splat(3), @splat(4), 100, 2, 100, 100);
        var key: [64]u8 = undefined;
        key[0..32].* = fixture.message.id();
        key[32..64].* = value.transaction_hash;
        try store.typed.put(a, accounting.accounted_message_transaction_prefix, &key, &value.transaction_uuid);
        try std.testing.expectError(error.PartialAccountingMarker, accounting.recordCost(a, &store, value));
        const total = try store.expenditure(fixture.message.id());
        try std.testing.expectEqual(@as(u256, 0), total.gas_used);
        try std.testing.expectEqual(@as(u256, 0), total.tokens_used);
    }
}

test "aggregate uses Rust saturation while marker conflict and token overflow never overwrite" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    var database: db.rocks.Database = undefined;
    var store = try fixture.open(&database);
    defer database.deinit();
    try store.addExpenditure(fixture.message.id(), .{ .gas_used = std.math.maxInt(u256) - 5, .tokens_used = std.math.maxInt(u256) - 5 });
    const saturating = input(fixture.message, 1, @splat(1), @splat(3), @splat(4), 10, 1, 10, 10);
    try std.testing.expectEqual(accounting.RecordResult.recorded, try accounting.recordCost(a, &store, saturating));
    var total = try store.expenditure(fixture.message.id());
    try std.testing.expectEqual(std.math.maxInt(u256), total.gas_used);
    try std.testing.expectEqual(std.math.maxInt(u256), total.tokens_used);

    var conflict = saturating;
    conflict.transaction_hash = @splat(9);
    try std.testing.expectError(error.AccountingMarkerConflict, accounting.recordCost(a, &store, conflict));
    total = try store.expenditure(fixture.message.id());
    try std.testing.expectEqual(std.math.maxInt(u256), total.gas_used);
    try std.testing.expectEqual(std.math.maxInt(u256), total.tokens_used);

    var other = fixture.message;
    other.nonce = 9;
    try store.upsertMessage(other, 1, null);
    const overflow = input(other, 1, @splat(2), @splat(5), @splat(6), std.math.maxInt(u256), 2, 1, 1);
    try std.testing.expectError(error.AccountingTokenOverflow, accounting.recordCost(a, &store, overflow));
    total = try store.expenditure(other.id());
    try std.testing.expectEqual(@as(u256, 0), total.gas_used);
    try std.testing.expectEqual(@as(u256, 0), total.tokens_used);
    try std.testing.expect((try accounting.loadMarker(a, &store, overflow.payload_uuid)) == null);
}
