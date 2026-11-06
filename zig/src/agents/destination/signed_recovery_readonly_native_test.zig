//! Read-only durable ownership and canonical-ack boundaries, actual RocksDB.
//! Protocol tags/opaque signed tuples exercise storage contracts, not VM crypto.
const std = @import("std");
const op = @import("operation.zig");
const compatibility = @import("../operation.zig");
const types = @import("types.zig");
const db = @import("../../db/root.zig");
const Store = @import("../store.zig").Store;
const protocol = @import("../../protocol/root.zig");
const settings = @import("../../settings/types.zig");
const groups = @import("../relayer/native_group.zig");
const GroupFixture = @import("group_commit_native_test.zig").Fixture;
const A = std.mem.Allocator;
const a = std.testing.allocator;
const now: op.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
const later: op.Times = .{ .unix_ms = 2000, .monotonic_ms = 1000 };
const row_prefix = "zig_native_destination_operation_v1/";

fn diskDigest(database: *db.rocks.Database, canonical_only: bool) ![32]u8 {
    var iterator = try database.prefix(a, "");
    defer iterator.deinit();
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    while (try iterator.next(a)) |owned| {
        var item = owned;
        defer item.deinit();
        if (canonical_only) {
            var include = false;
            inline for (.{ .message_id, .message, .message_dispatched_block_number, .nonce_processed, .pending_message_by_destination, .pending_message_index_migration_complete, .terminally_dropped_message_by_id, .payload_uuids_by_message_id }) |table| {
                inline for (.{ "origin", "origin-a", "origin-b" }) |domain| {
                    const scoped = try db.keys.scoped(a, domain, @as(db.keys.Table, table).prefix(), "");
                    defer a.free(scoped);
                    if (std.mem.startsWith(u8, item.key, scoped)) include = true;
                }
            }
            if (!include) continue;
        }
        var sizes: [16]u8 = undefined;
        std.mem.writeInt(u64, sizes[0..8], item.key.len, .big);
        std.mem.writeInt(u64, sizes[8..16], item.value.len, .big);
        hash.update(&sizes);
        hash.update(item.key);
        hash.update(item.value);
    }
    try iterator.status();
    var value: [32]u8 = undefined;
    hash.final(&value);
    return value;
}
const Fixture = struct {
    directory: std.testing.TmpDir,
    path: []u8,
    database: db.rocks.Database,
    origin: Store,
    message: protocol.Message,
    options: op.Options,
    fn init() !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        self.directory = std.testing.tmpDir(.{});
        errdefer self.directory.cleanup();
        const base = try self.directory.dir.realpathAlloc(a, ".");
        defer a.free(base);
        self.path = try std.fs.path.join(a, &.{ base, "readonly-recovery" });
        errdefer a.free(self.path);
        self.database = try db.rocks.Database.open(a, self.path, .{});
        errdefer self.database.deinit();
        self.origin = Store.init(a, &self.database, "origin");
        self.message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(1), .recipient = @splat(2), .body = "public recovery ownership" };
        _ = try self.origin.storeMessage(self.message, 10, null);
        self.options = .{ .id = self.message.id(), .context = @splat(7), .nonce = 0, .origin = 1, .destination = 2, .policy = .{ .confirm_delay_ms = 0 } };
        return self;
    }
    fn deinit(self: *Fixture) void {
        self.database.deinit();
        a.free(self.path);
        self.directory.cleanup();
        a.destroy(self);
    }
    fn reopen(self: *Fixture) !void {
        self.database.deinit();
        self.database = try db.rocks.Database.open(a, self.path, .{});
        self.origin = Store.init(a, &self.database, "origin");
    }
    fn seed(self: *Fixture, tag: settings.Protocol, signed: bool) !void {
        const actor = try op.Operation.open(a, &self.origin, self.options, now);
        defer actor.deinit();
        _ = try actor.tick(now);
        var prepared = try types.Prepared.init(a, .{ .protocol = tag, .origin = 1, .destination = 2, .mailbox = @splat(3), .chain_id = "public-fixture", .operation_id = self.options.id, .generation = actor.value.generation }, "{\"transaction\":{\"nonce\":\"0x9\"},\"public_fixture\":true}", 100, 200);
        defer prepared.deinit();
        try actor.prepared(&prepared, true, true, now);
        const persistence = actor.persistence(now);
        try persistence.intent(&prepared);
        if (signed) {
            const identity: types.Identity = if (tag == .sealevel) .{ .signature512 = @splat(0x5a) } else .{ .hash256 = @splat(0x6b) };
            var value = try types.Signed.init(a, identity, &.{ 0xf8, 0x02, @intFromEnum(tag), 0x09, 0x01 });
            defer value.deinit();
            try persistence.signed(&prepared, &value);
        }
    }
    fn manual(self: *Fixture) !void {
        const bytes = try (db.json.Status{ .Retry = .Manual }).toJson(a);
        defer a.free(bytes);
        try self.origin.typed.put(a, db.keys.Table.status_by_message_id.prefix(), &self.options.id, bytes);
    }
    fn peek(self: *Fixture, memory: A) !bool {
        var options = self.options;
        options.acknowledge_canonical = false;
        return op.Operation.hasSignedRecovery(memory, &self.origin, options, later);
    }
};
fn rawRow(f: *Fixture) ![]u8 {
    return (try f.origin.typed.get(a, row_prefix, &f.options.id)) orelse error.MissingNativeOperation;
}
fn rejectUnchanged(f: *Fixture) !void {
    const before = try diskDigest(&f.database, false);
    if (f.peek(a)) |_| return error.CorruptRecoveryWasAccepted else |_| {}
    try std.testing.expectEqual(before, try diskDigest(&f.database, false));
}

test "readonly signed recovery preserves all eight tagged signed tuples and Manual bytes across Rocks reopen" {
    for (std.meta.tags(settings.Protocol)) |tag| {
        const f = try Fixture.init();
        defer f.deinit();
        try f.seed(tag, true);
        try f.manual();
        const before = try diskDigest(&f.database, false);
        const row = try rawRow(f);
        defer a.free(row);
        try std.testing.expect(try f.peek(a));
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
        try f.reopen();
        try std.testing.expect(try f.peek(a));
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
        const restored = try rawRow(f);
        defer a.free(restored);
        try std.testing.expectEqualStrings(row, restored);
        try std.testing.expect((try f.origin.status(f.options.id)).? == .Retry);
        try std.testing.expect((try f.origin.status(f.options.id)).?.Retry == .Manual);
        try std.testing.expect(!try f.origin.processed(0));
        var pending = (try f.origin.pendingAtOrAfter(2, 0)).?;
        pending.deinit();
    }
}

test "readonly signed recovery rejects unsigned ready and status alone without normalizing Manual or inventing state" {
    for (0..3) |mode| {
        const f = try Fixture.init();
        defer f.deinit();
        if (mode == 1) try f.seed(.tron, false);
        if (mode < 2) try f.manual() else {
            const status = try (db.json.Status{ .Confirm = .AlreadySubmitted }).toJson(a);
            defer a.free(status);
            try f.origin.typed.put(a, db.keys.Table.status_by_message_id.prefix(), &f.options.id, status);
        }
        const before = try diskDigest(&f.database, false);
        try std.testing.expect(!try f.peek(a));
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
        try f.reopen();
        try std.testing.expect(!try f.peek(a));
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
    }
}

test "readonly signed recovery corruption incomplete tuple foreign context and intent never write" {
    for (0..6) |mode| {
        const f = try Fixture.init();
        defer f.deinit();
        try f.seed(.tron, true);
        try f.manual();
        const row = try rawRow(f);
        defer a.free(row);
        var parsed = try std.json.parseFromSlice(std.json.Value, a, row, .{});
        defer parsed.deinit();
        switch (mode) {
            0 => try parsed.value.object.put("version", .{ .integer = 2 }),
            1 => try parsed.value.object.put("signed_hex", .null),
            2 => try parsed.value.object.put("signed_hex", .{ .string = "0xgg" }),
            3 => try parsed.value.object.put("stage", .{ .string = "ready" }),
            4 => try parsed.value.object.put("generation", .{ .integer = 900 }),
            5 => try parsed.value.object.put("intent", .{ .string = "{}" }),
            else => unreachable,
        }
        const changed = try std.json.Stringify.valueAlloc(a, parsed.value, .{});
        defer a.free(changed);
        try f.origin.typed.put(a, row_prefix, &f.options.id, changed);
        try rejectUnchanged(f);
    }
    const f = try Fixture.init();
    defer f.deinit();
    try f.seed(.sealevel, true);
    const before = try diskDigest(&f.database, false);
    var foreign = f.options;
    foreign.context = @splat(88);
    try std.testing.expectError(error.OperationContextChanged, op.Operation.hasSignedRecovery(a, &f.origin, foreign, now));
    try std.testing.expectEqual(before, try diskDigest(&f.database, false));
}

test "readonly signed recovery allocation failure on every read path leaves Manual signed accounting and canonical bytes unchanged" {
    const f = try Fixture.init();
    defer f.deinit();
    try f.seed(.aleo, true);
    {
        const actor = try op.Operation.open(a, &f.origin, f.options, now);
        defer actor.deinit();
        try std.testing.expect(try actor.recordExpenditure(.{ .identity = actor.signed.?.identity, .block_hash = @splat(8), .height = 20, .success = true, .finalized = true, .expenditure = .{ .gas_used = 19, .tokens_used = 23 } }));
    }
    try f.manual();
    var counter = std.testing.FailingAllocator.init(a, .{});
    try std.testing.expect(try f.peek(counter.allocator()));
    try std.testing.expect(counter.alloc_index > 0);
    const before = try diskDigest(&f.database, false);
    for (0..counter.alloc_index) |index| {
        var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = index });
        try std.testing.expectError(error.OutOfMemory, f.peek(failing.allocator()));
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
    }
    try std.testing.expect(try f.peek(a));
}

test "readonly signed recovery excluded finalized receipt persists private accounting without canonical acknowledgement then reallow acknowledges" {
    const f = try Fixture.init();
    defer f.deinit();
    try f.seed(.tron, true);
    // A real false terminal row must remain byte-identical, not merely read false.
    try f.origin.typed.put(a, db.keys.Table.terminally_dropped_message_by_id.prefix(), &f.options.id, &.{0});
    var options = f.options;
    options.acknowledge_canonical = false;
    const canonical_before = try diskDigest(&f.database, true);
    const actor = try op.Operation.open(a, &f.origin, options, now);
    const signed = try a.dupe(u8, actor.signed.?.bytes);
    defer a.free(signed);
    const identity = actor.signed.?.identity;
    const receipt: types.Receipt = .{ .identity = identity, .block_hash = @splat(8), .height = 20, .success = true, .finalized = true, .expenditure = .{ .gas_used = 123, .tokens_used = 456 } };
    try std.testing.expect(try actor.recordExpenditure(receipt));
    try actor.observe(true, true, now);
    try std.testing.expectEqual(.delivered, actor.value.stage);
    try std.testing.expectEqualStrings(signed, actor.signed.?.bytes);
    actor.deinit();
    try f.reopen();
    try std.testing.expectEqual(canonical_before, try diskDigest(&f.database, true));
    try std.testing.expect(!try f.origin.processed(0));
    var pending = (try f.origin.pendingAtOrAfter(2, 0)).?;
    pending.deinit();
    try std.testing.expectEqual(@as(u256, 123), (try f.origin.expenditure(f.options.id)).gas_used);
    const recovered = try op.Operation.open(a, &f.origin, f.options, later);
    defer recovered.deinit();
    try std.testing.expect(types.Identity.eql(identity, recovered.signed.?.identity));
    try std.testing.expectEqualStrings(signed, recovered.signed.?.bytes);
    _ = try recovered.tick(later); // existing signature, no signer/backend or nonce request
    try std.testing.expect(try f.origin.processed(0));
    try std.testing.expect((try f.origin.pendingAtOrAfter(2, 0)) == null);
    try std.testing.expect(!try recovered.recordExpenditure(receipt));
    try std.testing.expectEqual(@as(u256, 456), (try f.origin.expenditure(f.options.id)).tokens_used);
}

fn pairJournal(f: *GroupFixture) !groups.Journal {
    const d0 = std.fmt.bytesToHex(f.previous[0], .lower);
    const d1 = std.fmt.bytesToHex(f.previous[1], .lower);
    const body = try std.json.Stringify.valueAlloc(a, .{ .batch_version = 2, .transaction = .{ .nonce = "0x9" }, .batch_members = .{ .{ .source_intent_digest = &d0, .gas_limit = 10, .estimated_cost = 20 }, .{ .source_intent_digest = &d1, .gas_limit = 10, .estimated_cost = 20 } }, .gas_limit = 20, .estimated_cost = 40 }, .{});
    defer a.free(body);
    for (&f.replacements) |*old| {
        const next = try types.Prepared.init(a, old.authority, body, 20, 40);
        old.deinit();
        old.* = next;
    }
    return groups.Journal.create(a, .{ .database = &f.database, .domain_name = "destination-9" }, &f.actors, &f.replacements, now);
}
fn reopenGroupDatabase(f: *GroupFixture) !void {
    for (f.actors) |actor| actor.deinit();
    f.database.deinit();
    f.database = try db.rocks.Database.open(a, f.path, .{});
    for (&f.stores, &f.actors, f.options, 0..) |*origin, *slot, options, index| {
        origin.* = Store.init(a, &f.database, if (index == 0) "origin-a" else "origin-b");
        slot.* = try op.Operation.open(a, origin, options, later);
    }
}

fn signGroup(f: *GroupFixture, journal: *const groups.Journal) !void {
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(0x3c) }, "public opaque common signed transaction");
    defer signed.deinit();
    var persistence: groups.Persistence = .{ .journal = journal, .actors = &f.actors, .now = now };
    try persistence.interface().signed(&f.replacements[0], &signed);
}

test "readonly signed recovery requires validated group journal member and shared signed bytes preserving nonce owner and every member" {
    const f = try GroupFixture.init(a);
    defer f.deinit();
    var journal = try pairJournal(f);
    defer journal.deinit();
    var options = f.options[0];
    options.group_store = journal.store;
    const unsigned_before = try diskDigest(&f.database, false);
    try std.testing.expect(!try op.Operation.hasSignedRecovery(a, &f.stores[0], options, now));
    try std.testing.expectEqual(unsigned_before, try diskDigest(&f.database, false));
    try signGroup(f, &journal);
    try reopenGroupDatabase(f);
    const before = try diskDigest(&f.database, false);
    for (0..2) |i| {
        var own = f.options[i];
        own.group_store = journal.store;
        own.acknowledge_canonical = false;
        try std.testing.expect(try op.Operation.hasSignedRecovery(a, &f.stores[i], own, later));
    }
    try std.testing.expectEqual(before, try diskDigest(&f.database, false));
    var absent = options;
    absent.group_store = null;
    try std.testing.expectError(error.MissingNativeGroupStore, op.Operation.hasSignedRecovery(a, &f.stores[0], absent, later));
    try std.testing.expectEqual(before, try diskDigest(&f.database, false));
}

test "readonly signed recovery group corrupt missing link foreign journal member and signature conflict fail without writes" {
    for (0..5) |mode| {
        const f = try GroupFixture.init(a);
        defer f.deinit();
        var journal = try pairJournal(f);
        defer journal.deinit();
        try signGroup(f, &journal);
        try reopenGroupDatabase(f);
        var options = f.options[0];
        options.group_store = journal.store;
        if (mode == 0) {
            try f.stores[0].typed.put(a, op.group_link_prefix, &options.id, "bad");
        } else if (mode == 1) {
            options.group_store = .{ .database = &f.database, .domain_name = "foreign-destination" };
        } else if (mode == 3) {
            var batch = try f.stores[0].typed.batch(a);
            defer batch.deinit();
            try batch.delete(op.group_link_prefix, &options.id);
            try batch.commitSync();
        } else if (mode == 4) {
            const raw = (try journal.store.get(a, op.group_record_prefix, &journal.id)).?;
            defer a.free(raw);
            var parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
            defer parsed.deinit();
            const bad_context = std.fmt.bytesToHex(@as(types.Hash, @splat(99)), .lower);
            const members = parsed.value.object.getPtr("members").?;
            try members.array.items[0].object.put("context", .{ .string = &bad_context });
            const altered = try std.json.Stringify.valueAlloc(a, parsed.value, .{});
            defer a.free(altered);
            try journal.store.put(a, op.group_record_prefix, &journal.id, altered);
        } else {
            const raw = (try f.stores[0].typed.get(a, row_prefix, &options.id)).?;
            defer a.free(raw);
            var parsed = try std.json.parseFromSlice(std.json.Value, a, raw, .{});
            defer parsed.deinit();
            try parsed.value.object.put("signed_hex", .{ .string = "0x010203" });
            const altered = try std.json.Stringify.valueAlloc(a, parsed.value, .{});
            defer a.free(altered);
            try f.stores[0].typed.put(a, row_prefix, &options.id, altered);
        }
        const before = try diskDigest(&f.database, false);
        if (op.Operation.hasSignedRecovery(a, &f.stores[0], options, later)) |_| return error.CorruptGroupWasAccepted else |_| {}
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
    }
}

test "readonly signed recovery legacy payload lifecycle suppresses canonical acknowledgement and retains UUID across reopen and reallow" {
    const f = try Fixture.init();
    defer f.deinit();
    const uuids = try db.codec.encodeUuids(a, &.{@splat(0x41)});
    defer a.free(uuids);
    try f.origin.typed.put(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &f.options.id, uuids);
    try f.origin.typed.put(a, db.keys.Table.terminally_dropped_message_by_id.prefix(), &f.options.id, &.{0});
    var options: compatibility.Options = .{ .id = f.options.id, .context = f.options.context, .nonce = 0, .destination = 2, .policy = .{ .confirm_delay_ms = 0 }, .acknowledge_canonical = false };
    var actor = try compatibility.Operation.open(a, &f.origin, options, now);
    _ = try actor.apply(.{ .tick = .{ .now_ms = 0 } }, now, null);
    try actor.payloadEnqueued(actor.value.generation, now);
    const before = try diskDigest(&f.database, true);
    try actor.payloadDelivered(now);
    try std.testing.expectEqual(.delivered, actor.value.stage);
    actor.deinit();
    try f.reopen();
    try std.testing.expectEqual(before, try diskDigest(&f.database, true));
    try std.testing.expect(!try f.origin.processed(0));
    var pending = (try f.origin.pendingAtOrAfter(2, 0)).?;
    pending.deinit();
    options.acknowledge_canonical = true;
    var recovered = try compatibility.Operation.open(a, &f.origin, options, later);
    defer recovered.deinit();
    try std.testing.expectEqual(.delivered, recovered.value.stage);
    try std.testing.expect(try f.origin.processed(0));
    try std.testing.expect((try f.origin.pendingAtOrAfter(2, 0)) == null);
    const restored = (try f.origin.typed.get(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &f.options.id)).?;
    defer a.free(restored);
    try std.testing.expectEqualSlices(u8, uuids, restored);
}

test "readonly signed recovery false canonical capability cannot publish a terminal-drop marker or remove pending history" {
    const f = try Fixture.init();
    defer f.deinit();
    var options = f.options;
    options.acknowledge_canonical = false;
    const actor = try op.Operation.open(a, &f.origin, options, now);
    defer actor.deinit();
    const before = try diskDigest(&f.database, true);
    try actor.dropNonContract(now);
    try std.testing.expectEqual(before, try diskDigest(&f.database, true));
    try std.testing.expect(!try f.origin.terminal(f.options.id));
    try std.testing.expect(!try f.origin.processed(0));
    var pending = (try f.origin.pendingAtOrAfter(2, 0)).?;
    pending.deinit();
}

test "readonly signed recovery normal public open retains Manual normalization while read only probe does not" {
    const f = try Fixture.init();
    defer f.deinit();
    try f.seed(.tron, true);
    try f.manual();
    const before = try diskDigest(&f.database, false);
    try std.testing.expect(try f.peek(a));
    try std.testing.expectEqual(before, try diskDigest(&f.database, false));
    const actor = try op.Operation.open(a, &f.origin, f.options, later);
    defer actor.deinit();
    try std.testing.expectEqual(.confirming, actor.value.stage);
    try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
    try std.testing.expect(!std.mem.eql(u8, &before, &try diskDigest(&f.database, false)));
    try std.testing.expect(!try f.origin.processed(0));
}

test "readonly signed recovery every grouped allocation failure preserves journal nonce current owner member and signed rows" {
    const f = try GroupFixture.init(a);
    defer f.deinit();
    var journal = try pairJournal(f);
    defer journal.deinit();
    try signGroup(f, &journal);
    try reopenGroupDatabase(f);
    var options = f.options[0];
    options.group_store = journal.store;
    var counter = std.testing.FailingAllocator.init(a, .{});
    try std.testing.expect(try op.Operation.hasSignedRecovery(counter.allocator(), &f.stores[0], options, later));
    const before = try diskDigest(&f.database, false);
    for (0..counter.alloc_index) |index| {
        var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = index });
        try std.testing.expectError(error.OutOfMemory, op.Operation.hasSignedRecovery(failing.allocator(), &f.stores[0], options, later));
        try std.testing.expectEqual(before, try diskDigest(&f.database, false));
    }
}
