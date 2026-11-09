//! Native atomic group persistence. No SDK, signer keys or network are needed.
const std = @import("std");
const op = @import("operation.zig");
const types = @import("types.zig");
const protocol = @import("../../protocol/root.zig");
const db = @import("../../db/root.zig");
const Store = @import("../store.zig").Store;
const A = std.mem.Allocator;
pub const now: op.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
const group_id = [_]u8{7} ** 32;
pub const prepared_record = "{\"phase\":\"prepared\"}";
pub const signed_record = "{\"phase\":\"signed\"}";
pub const Fixture = struct {
    allocator: A,
    directory: std.testing.TmpDir,
    path: []u8,
    database: db.rocks.Database,
    database_open: bool = false,
    stores: [2]Store,
    actors: [2]*op.Operation,
    options: [2]op.Options,
    replacements: [2]types.Prepared,
    previous: [2]types.Hash,
    actor_count: usize = 0,
    replacement_count: usize = 0,
    pub fn init(a: A) !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        self.* = undefined;
        self.allocator = a;
        self.database_open = false;
        self.actor_count = 0;
        self.replacement_count = 0;
        self.directory = std.testing.tmpDir(.{});
        errdefer self.directory.cleanup();
        const base = try self.directory.dir.realpathAlloc(a, ".");
        defer a.free(base);
        self.path = try std.fs.path.join(a, &.{ base, "group" });
        errdefer a.free(self.path);
        self.database = try db.rocks.Database.open(a, self.path, .{});
        self.database_open = true;
        errdefer self.database.deinit();
        errdefer {
            for (self.replacements[0..self.replacement_count]) |*value| value.deinit();
            for (self.actors[0..self.actor_count]) |actor| actor.deinit();
        }
        for (&self.stores, &self.actors, &self.options, &self.replacements, &self.previous, 0..) |*store, *actor_slot, *options, *replacement, *previous, index| {
            store.* = Store.init(a, &self.database, if (index == 0) "origin-a" else "origin-b");
            const message: protocol.Message = .{ .origin = @intCast(index + 1), .destination = 9, .nonce = 0, .body = "public atomic group fixture" };
            _ = try store.storeMessage(message, 1, null);
            options.* = .{ .id = message.id(), .context = @splat(@intCast(index + 10)), .nonce = 0, .origin = message.origin, .destination = 9 };
            const actor = try op.Operation.open(a, store, options.*, now);
            actor_slot.* = actor;
            self.actor_count += 1;
            _ = try actor.tick(now);
            const authority: types.Authority = .{ .protocol = .starknet, .origin = message.origin, .destination = 9, .mailbox = @splat(9), .chain_id = "0x1", .origin_hook = @splat(@intCast(index + 1)), .operation_id = message.id(), .generation = actor.value.generation, .kind = .process };
            var scalar = try types.Prepared.init(a, authority, "{\"transaction\":{\"nonce\":\"0x5\",\"sender_address\":\"0x4\"},\"gas_limit\":10,\"estimated_cost\":20}", 10, 20);
            defer scalar.deinit();
            try actor.staged(&scalar, now);
            try actor.prepared(&scalar, true, true, now);
            previous.* = scalar.digest();
            replacement.* = try types.Prepared.init(a, authority, "{\"transaction\":{\"nonce\":\"0x9\",\"sender_address\":\"0x4\"},\"group\":true,\"gas_limit\":10,\"estimated_cost\":20}", 10, 20);
            self.replacement_count += 1;
        }
        return self;
    }
    pub fn deinit(self: *Fixture) void {
        const a = self.allocator;
        for (&self.replacements) |*value| value.deinit();
        for (self.actors[0..self.actor_count]) |actor| actor.deinit();
        if (self.database_open) self.database.deinit();
        a.free(self.path);
        self.directory.cleanup();
        a.destroy(self);
    }
    pub fn journal(self: *Fixture, expected: ?[]const u8, value: []const u8, links: @FieldType(op.GroupJournalWrite, "links")) op.GroupJournalWrite {
        return .{ .store = .{ .database = &self.database, .domain_name = "destination-9" }, .id = group_id, .expected = expected, .value = value, .links = links };
    }
    pub fn replace(self: *Fixture) !void {
        const pointers = [_]*const types.Prepared{ &self.replacements[0], &self.replacements[1] };
        try op.commitGroup(self.allocator, &self.actors, .{ .replace_ready = .{ .prepared = &pointers, .previous_digests = &self.previous } }, self.journal(null, prepared_record, .set), now);
    }
    pub fn reopen(self: *Fixture) !void {
        for (&self.actors, &self.stores, self.options) |*slot, *store, options| {
            const fresh = try op.Operation.open(self.allocator, store, options, .{ .unix_ms = 2000, .monotonic_ms = 7 });
            slot.*.deinit();
            slot.* = fresh;
        }
    }
    pub fn reopenDatabase(self: *Fixture) !void {
        for (self.actors) |actor| actor.deinit();
        self.actor_count = 0;
        self.database.deinit();
        self.database_open = false;
        self.database = try db.rocks.Database.open(self.allocator, self.path, .{});
        self.database_open = true;
        for (&self.stores, &self.actors, self.options, 0..) |*store, *slot, options, index| {
            store.* = Store.init(self.allocator, &self.database, if (index == 0) "origin-a" else "origin-b");
            slot.* = try op.Operation.open(self.allocator, store, options, .{ .unix_ms = 2000, .monotonic_ms = 7 });
            self.actor_count += 1;
        }
    }
    pub fn checkLinks(self: *Fixture) !void {
        for (self.actors) |actor| {
            const link = (try actor.store.typed.get(self.allocator, op.group_link_prefix, &actor.options.id)) orelse return error.MissingGroupLink;
            defer self.allocator.free(link);
            try std.testing.expectEqualSlices(u8, &group_id, link);
        }
    }
};

test "native group atomically restages cross-origin members before shared signature and confirmation recovery" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a);
    defer fixture.deinit();
    try fixture.replace();
    try fixture.checkLinks();
    for (fixture.actors, &fixture.replacements) |actor, *replacement| try std.testing.expectEqualStrings(replacement.canonical_intent, actor.intent.?);
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "{\"signature\":[\"0x1\",\"0x2\"]}");
    defer signed.deinit();
    try op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now);
    try fixture.reopen();
    for (fixture.actors) |actor| {
        try std.testing.expect(types.Identity.eql(signed.identity, actor.signed.?.identity));
        try std.testing.expectEqualStrings(signed.bytes, actor.signed.?.bytes);
    }
    try op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 601000, .delay_ms = 600000 } }, fixture.journal(signed_record, "{\"phase\":\"included\"}", .preserve), now);
    try fixture.reopen();
    for (fixture.actors) |actor| {
        try std.testing.expect(actor.value.confirmation_started);
        try std.testing.expectEqual(@as(u64, 599007), actor.value.next_attempt_ms);
        try std.testing.expect(actor.current_status == .Confirm);
    }
}

test "native group confirmation replay never extends started or elapsed source window" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a);
    defer fixture.deinit();
    try fixture.replace();
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public signed bytes");
    defer signed.deinit();
    try op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now);
    const included = "{\"phase\":\"included\"}";
    try op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 601000, .delay_ms = 600000 } }, fixture.journal(signed_record, included, .preserve), now);
    try op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 701000, .delay_ms = 600000 } }, fixture.journal(included, included, .preserve), .{ .unix_ms = 101000, .monotonic_ms = 100007 });
    for (fixture.actors) |actor| try std.testing.expectEqual(@as(u64, 601000), actor.deadline.?.unix_ms);
    for (fixture.actors) |actor| _ = try actor.tick(.{ .unix_ms = 701000, .monotonic_ms = 700007 });
    try fixture.reopen();
    for (fixture.actors) |actor| try std.testing.expect(actor.deadline == null);
    try op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 1301000, .delay_ms = 600000 } }, fixture.journal(included, included, .preserve), .{ .unix_ms = 701000, .monotonic_ms = 7 });
    for (fixture.actors) |actor| try std.testing.expect(actor.value.next_attempt_ms <= 7);
}

test "native group commit failures cannot expose partial member state and unknown signed commit recovers" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a);
    defer fixture.deinit();
    op.GroupTestFault.before_commit.store(true, .release);
    defer op.GroupTestFault.before_commit.store(false, .release);
    try std.testing.expectError(error.InjectedNativeGroupCommitFailure, fixture.replace());
    const journal = fixture.journal(null, prepared_record, .set);
    try std.testing.expect((try journal.store.get(a, op.group_record_prefix, &group_id)) == null);
    for (fixture.actors, fixture.previous) |actor, previous| {
        var scalar = try types.Prepared.restore(a, actor.intent.?);
        defer scalar.deinit();
        try std.testing.expectEqualSlices(u8, &previous, &scalar.digest());
        try std.testing.expect(actor.signed == null);
    }
    try fixture.replace();
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public signed bytes");
    defer signed.deinit();
    op.GroupTestFault.after_commit.store(true, .release);
    defer op.GroupTestFault.after_commit.store(false, .release);
    try std.testing.expectError(error.NativeGroupCommitOutcomeUnknown, op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now));
    for (fixture.actors) |actor| try std.testing.expect(actor.signed == null); // Caller died before applying its committed snapshot.
    try fixture.reopen();
    for (fixture.actors) |actor| try std.testing.expectEqualStrings(signed.bytes, actor.signed.?.bytes);
    const actual = (try journal.store.get(a, op.group_record_prefix, &group_id)).?;
    defer a.free(actual);
    try std.testing.expectEqualStrings(signed_record, actual);
}

fn allocationExercise(a: A) !void {
    const fixture = try Fixture.init(a);
    defer fixture.deinit();
    try fixture.replace();
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public signed bytes");
    defer signed.deinit();
    try op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now);
}

test "native group every allocation preserves partial constructor and atomic snapshot ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationExercise, .{});
}

fn retirementProof(fixture: *Fixture, index: usize, absent: bool) !types.RetirementProof {
    const actor = fixture.actors[index];
    var prepared_value = try types.Prepared.restore(fixture.allocator, actor.intent.?);
    defer prepared_value.deinit();
    return .{ .identity = actor.signed.?.identity, .intent_digest = prepared_value.digest(), .generation = actor.value.generation, .reason = .starknet_nonce_superseded, .finalized_height = 10, .finalized_block_hash = .{0} ** 31 ++ .{9}, .boundary = 0, .observed = 0, .nonce_account = .{0} ** 31 ++ .{4}, .nonce_boundary = .{0} ** 31 ++ .{9}, .nonce_observed = .{0} ** 31 ++ .{10}, .absence_checked = absent };
}
fn retireAllocationExercise(a: A) !void {
    const fixture = try Fixture.init(a);
    defer fixture.deinit();
    try fixture.replace();
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public signed bytes");
    defer signed.deinit();
    try op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now);
    const consumed = try retirementProof(fixture, 0, false);
    const proofs = [_]?types.RetirementProof{ try retirementProof(fixture, 0, true), try retirementProof(fixture, 1, true) };
    try op.commitGroup(a, &fixture.actors, .{ .retired = .{ .consumed = consumed, .proofs = &proofs } }, fixture.journal(signed_record, "{\"phase\":\"retired\"}", .preserve), now);
    for (fixture.actors) |actor| {
        try std.testing.expect(actor.intent == null and actor.signed == null and actor.value.stage == .pending);
        try std.testing.expectEqual(@as(u32, 1), actor.value.retries);
    }
}
test "native group every retirement allocation preserves whole group signed or retired snapshot" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, retireAllocationExercise, .{});
}

test "native group retirement rejects wrong account missing absence and different proof height without any row transition" {
    const a = std.testing.allocator;
    for (0..3) |mode| {
        const fixture = try Fixture.init(a);
        defer fixture.deinit();
        try fixture.replace();
        var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public signed bytes");
        defer signed.deinit();
        try op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now);
        var consumed = try retirementProof(fixture, 0, false);
        var proofs = [_]?types.RetirementProof{ try retirementProof(fixture, 0, true), try retirementProof(fixture, 1, true) };
        if (mode == 0) consumed.nonce_account = .{0} ** 31 ++ .{7};
        if (mode == 1) proofs[1].?.absence_checked = false;
        if (mode == 2) proofs[1].?.finalized_height = 11;
        try std.testing.expectError(error.InvalidNativeRetirementProof, op.commitGroup(a, &fixture.actors, .{ .retired = .{ .consumed = consumed, .proofs = &proofs } }, fixture.journal(signed_record, "{\"phase\":\"retired\"}", .preserve), now));
        try fixture.reopen();
        for (fixture.actors) |actor| {
            try std.testing.expect(actor.signed != null and actor.intent != null);
            try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
        }
    }
}

fn signedFinalityFixture(a: A) !*Fixture {
    const fixture = try Fixture.init(a);
    errdefer fixture.deinit();
    try fixture.replace();
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public signed transaction");
    defer signed.deinit();
    try op.commitGroup(a, &fixture.actors, .{ .signed = &signed }, fixture.journal(prepared_record, signed_record, .preserve), now);
    return fixture;
}
fn finalityReceipt(success: bool) types.Receipt {
    return .{ .identity = .{ .hash256 = @splat(8) }, .block_hash = @splat(9), .height = 20, .success = success, .finalized = true };
}
test "native finalized transaction marker deduplicates cross origin stores without inventing expenditure" {
    const a = std.testing.allocator;
    const fixture = try signedFinalityFixture(a);
    defer fixture.deinit();
    var committed = false;
    var receipt = finalityReceipt(true);
    receipt.finalized = false;
    try std.testing.expectError(error.FinalizedNativeReceiptRequired, fixture.actors[0].recordFinalizedReceipt(receipt, &committed));
    receipt.finalized = true;
    receipt.identity.hash256[0] = 7;
    try std.testing.expectError(error.FinalizedNativeReceiptRequired, fixture.actors[0].recordFinalizedReceipt(receipt, &committed));
    try std.testing.expect(!committed);
    receipt = finalityReceipt(false); // Failed execution is still one finalized transaction.
    const first = try fixture.actors[0].recordFinalizedReceipt(receipt, &committed);
    try std.testing.expect(first.transaction and committed and !first.expenditure);
    committed = false;
    const second = try fixture.actors[1].recordFinalizedReceipt(receipt, &committed);
    try std.testing.expect(!second.transaction and !committed and !second.expenditure);
    for (fixture.actors) |actor| {
        const expenditure = try actor.store.expenditure(actor.options.id);
        try std.testing.expectEqual(@as(u256, 0), expenditure.gas_used);
        try std.testing.expectEqual(@as(u256, 0), expenditure.tokens_used);
    }
    receipt.expenditure = .{ .gas_used = 3, .tokens_used = 7 };
    const late_fee = try fixture.actors[0].recordFinalizedReceipt(receipt, &committed);
    try std.testing.expect(!late_fee.transaction and late_fee.expenditure and !committed);
    try fixture.reopenDatabase();
    try std.testing.expect(!(try fixture.actors[0].recordFinalizedReceipt(receipt, &committed)).transaction);
    try std.testing.expect(!committed);
    // A new Registry after restart is not synthetically seeded from old markers.
}
test "native finalized receipt commit faults preserve marker and actual fee atomicity across restart" {
    const a = std.testing.allocator;
    const fixture = try signedFinalityFixture(a);
    defer fixture.deinit();
    var receipt = finalityReceipt(true);
    receipt.expenditure = .{ .gas_used = 3, .tokens_used = 7 };
    var committed = false;
    op.FinalizationTestFault.before_commit.store(true, .release);
    defer op.FinalizationTestFault.before_commit.store(false, .release);
    try std.testing.expectError(error.InjectedNativeFinalizationCommitFailure, fixture.actors[0].recordFinalizedReceipt(receipt, &committed));
    try std.testing.expect(!committed);
    try std.testing.expectEqual(@as(u256, 0), (try fixture.stores[0].expenditure(fixture.options[0].id)).gas_used);
    try fixture.reopen();
    op.FinalizationTestFault.after_commit.store(true, .release);
    defer op.FinalizationTestFault.after_commit.store(false, .release);
    try std.testing.expectError(error.NativeFinalizationCommitOutcomeUnknown, fixture.actors[0].recordFinalizedReceipt(receipt, &committed));
    try std.testing.expect(committed);
    try std.testing.expectEqual(@as(u256, 3), (try fixture.stores[0].expenditure(fixture.options[0].id)).gas_used);
    try std.testing.expectEqual(@as(u256, 7), (try fixture.stores[0].expenditure(fixture.options[0].id)).tokens_used);
    try fixture.reopen();
    committed = false;
    const replay = try fixture.actors[0].recordFinalizedReceipt(receipt, &committed);
    try std.testing.expect(!committed and !replay.transaction and !replay.expenditure);
    receipt.expenditure.?.tokens_used = 8;
    try std.testing.expectError(error.ConflictingNativeExpenditure, fixture.actors[0].recordFinalizedReceipt(receipt, &committed));
}
test "native group finality shares its journal batch and counts one transaction for two origin members" {
    const a = std.testing.allocator;
    const fixture = try signedFinalityFixture(a);
    defer fixture.deinit();
    var committed = false;
    var journal = fixture.journal(signed_record, "{\"phase\":\"included\"}", .preserve);
    journal.finalization = .{ .destination = 9, .receipt = finalityReceipt(true), .committed = &committed };
    journal.finalization.?.receipt.identity.hash256[0] = 6;
    try std.testing.expectError(error.FinalizedNativeReceiptRequired, op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 601000, .delay_ms = 600000 } }, journal, now));
    try std.testing.expect(!committed);
    journal.finalization.?.receipt = finalityReceipt(true);
    op.GroupTestFault.before_commit.store(true, .release);
    defer op.GroupTestFault.before_commit.store(false, .release);
    try std.testing.expectError(error.InjectedNativeGroupCommitFailure, op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 601000, .delay_ms = 600000 } }, journal, now));
    try std.testing.expect(!committed);
    try fixture.reopen();
    op.GroupTestFault.after_commit.store(true, .release);
    defer op.GroupTestFault.after_commit.store(false, .release);
    try std.testing.expectError(error.NativeGroupCommitOutcomeUnknown, op.commitGroup(a, &fixture.actors, .{ .confirming = .{ .unix_ms = 601000, .delay_ms = 600000 } }, journal, now));
    try std.testing.expect(committed);
    try fixture.reopen();
    for (fixture.actors) |actor| try std.testing.expect(actor.current_status == .Confirm);
    const actual = (try journal.store.get(a, op.group_record_prefix, &group_id)).?;
    defer a.free(actual);
    try std.testing.expectEqualStrings(journal.value, actual);
    committed = false;
    // Same transaction observed through either origin after the group commit
    // cannot create another marker, even though each origin owns a Store mutex.
    for (fixture.actors) |actor| try std.testing.expect(!(try actor.recordFinalizedReceipt(finalityReceipt(true), &committed)).transaction);
    try std.testing.expect(!committed);
}

fn commitFinalityKey(a: A, database: *db.rocks.Database, destination: u32, receipt: types.Receipt) !bool {
    op.finalized_transaction_mutex.lock();
    defer op.finalized_transaction_mutex.unlock();
    var batch = try database.batch();
    defer batch.deinit();
    const fresh = try op.stageFinalizedTransaction(a, database, &batch, destination, receipt);
    if (fresh) try batch.commitSync();
    return fresh;
}
test "native finalized transaction key keeps full signature tail tag and destination namespace" {
    const a = std.testing.allocator;
    const fixture = try signedFinalityFixture(a);
    defer fixture.deinit();
    var receipt = finalityReceipt(true);
    receipt.identity = .{ .signature512 = @splat(8) };
    try std.testing.expect(try commitFinalityKey(a, &fixture.database, 9, receipt));
    try std.testing.expect(!try commitFinalityKey(a, &fixture.database, 9, receipt));
    receipt.identity.signature512[63] = 7;
    try std.testing.expect(try commitFinalityKey(a, &fixture.database, 9, receipt));
    receipt.identity = .{ .hash256 = @splat(8) };
    try std.testing.expect(try commitFinalityKey(a, &fixture.database, 9, receipt));
    try std.testing.expect(try commitFinalityKey(a, &fixture.database, 10, receipt));
    try fixture.reopenDatabase();
    try std.testing.expect(!try commitFinalityKey(a, &fixture.database, 9, receipt));
    try std.testing.expect(!try commitFinalityKey(a, &fixture.database, 10, receipt));
    receipt.identity = .{ .signature512 = @splat(8) };
    try std.testing.expect(!try commitFinalityKey(a, &fixture.database, 9, receipt));
    receipt.identity.signature512[63] = 7;
    try std.testing.expect(!try commitFinalityKey(a, &fixture.database, 9, receipt));
}
