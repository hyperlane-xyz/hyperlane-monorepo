//! Independent native group ownership/CAS adversarial fixtures; no signer/network.
const std = @import("std");
const op = @import("operation.zig");
const types = @import("types.zig");
const db = @import("../../db/root.zig");
const groups = @import("../relayer/native_group.zig");
const Fixture = @import("group_commit_native_test.zig").Fixture;
const a = std.testing.allocator;
const now: op.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
const gid: types.Hash = @splat(7);
const prepared = "{\"phase\":\"prepared\"}";
const signed_record = "{\"phase\":\"signed\"}";
const row_prefix = "zig_native_destination_operation_v1/";
fn dbDigest(f: *Fixture) ![32]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    var iterator = try f.database.prefix(a, "");
    defer iterator.deinit();
    while (try iterator.next(a)) |owned| {
        var entry = owned;
        defer entry.deinit();
        var sizes: [16]u8 = undefined;
        std.mem.writeInt(u64, sizes[0..8], entry.key.len, .big);
        std.mem.writeInt(u64, sizes[8..16], entry.value.len, .big);
        hash.update(&sizes);
        hash.update(entry.key);
        hash.update(entry.value);
    }
    try iterator.status();
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return digest;
}
fn liveDigest(f: *Fixture) ![32]u8 {
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    for (f.actors) |actor| {
        const bytes = try std.json.Stringify.valueAlloc(a, .{ .row = actor.row, .intent = actor.intent, .stage = actor.value.stage, .status = actor.current_status, .status_row = actor.status_row, .generation = actor.value.generation, .deadline = actor.deadline, .next = actor.value.next_attempt_ms, .confirmation_started = actor.value.confirmation_started, .signed = if (actor.signed) |value| value.bytes else null }, .{});
        defer a.free(bytes);
        hash.update(bytes);
    }
    var digest: [32]u8 = undefined;
    hash.final(&digest);
    return digest;
}
fn rejected(f: *Fixture, expected: anyerror, actors: []const *op.Operation, transition: op.GroupTransition, journal: op.GroupJournalWrite) !void {
    const disk = try dbDigest(f);
    const live = try liveDigest(f);
    try std.testing.expectError(expected, op.commitGroup(a, actors, transition, journal, now));
    try std.testing.expectEqual(disk, try dbDigest(f));
    try std.testing.expectEqual(live, try liveDigest(f));
}
fn deleteLink(f: *Fixture, index: usize) !void {
    var batch = try f.stores[index].typed.batch(a);
    defer batch.deinit();
    try batch.delete(op.group_link_prefix, &f.options[index].id);
    try batch.commitSync();
}
fn sign(f: *Fixture) !void {
    var value = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public grouped signed bytes");
    defer value.deinit();
    try op.commitGroup(a, &f.actors, .{ .signed = &value }, f.journal(prepared, signed_record, .preserve), now);
}

test "native group guards reject stale journal row status and inherited ownership without any partial write" {
    for (0..4) |mode| {
        const f = try Fixture.init(a);
        defer f.deinit();
        try f.replace();
        var value = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public grouped signed bytes");
        defer value.deinit();
        const journal = f.journal(prepared, signed_record, .preserve);
        var expected: anyerror = error.StaleNativeOperationOwner;
        switch (mode) {
            0 => {
                try journal.store.put(a, op.group_record_prefix, &gid, "{\"phase\":\"superseded\"}");
                expected = error.StaleNativeGroupOwner;
            },
            1 => {
                const changed = try std.fmt.allocPrint(a, "{s} ", .{f.actors[1].row.?});
                defer a.free(changed);
                try f.stores[1].typed.put(a, row_prefix, &f.options[1].id, changed);
            },
            2 => {
                const bytes = try (db.json.Status{ .Retry = .Manual }).toJson(a);
                defer a.free(bytes);
                try f.stores[1].typed.put(a, db.keys.Table.status_by_message_id.prefix(), &f.options[1].id, bytes);
            },
            3 => {
                const bytes = try db.codec.encodeUuids(a, &.{@splat(3)});
                defer a.free(bytes);
                try f.stores[1].typed.put(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &f.options[1].id, bytes);
                expected = error.InheritedPayloadNeedsReconciliation;
            },
            else => unreachable,
        }
        try rejected(f, expected, &f.actors, .{ .signed = &value }, journal);
    }
}

test "native group guards reject duplicate member wrong authority and stale intent digest before mutation" {
    for (0..3) |mode| {
        const f = try Fixture.init(a);
        defer f.deinit();
        var actors = f.actors;
        var pointers = [_]*const types.Prepared{ &f.replacements[0], &f.replacements[1] };
        var digests = f.previous;
        var altered: ?types.Prepared = null;
        defer if (altered) |*value| value.deinit();
        const expected: anyerror = switch (mode) {
            0 => result: {
                actors[1] = actors[0];
                break :result error.DuplicateNativeGroupMember;
            },
            1 => result: {
                var authority = f.replacements[1].authority;
                authority.mailbox = @splat(33);
                altered = try types.Prepared.init(a, authority, "{\"gas_limit\":10,\"estimated_cost\":20}", 10, 20);
                pointers[1] = &altered.?;
                break :result error.NativeGroupAuthorityChanged;
            },
            2 => result: {
                digests[1][0] ^= 1;
                break :result error.NativeGroupIntentChanged;
            },
            else => unreachable,
        };
        try rejected(f, expected, &actors, .{ .replace_ready = .{ .prepared = &pointers, .previous_digests = &digests } }, f.journal(null, prepared, .set));
    }
}

test "native group guards require every durable member link before common signature commit" {
    for (0..2) |mode| {
        const f = try Fixture.init(a);
        defer f.deinit();
        try f.replace();
        if (mode == 0) try deleteLink(f, 1) else try f.stores[1].typed.put(a, op.group_link_prefix, &f.options[1].id, &([_]u8{19} ** 32));
        var value = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public grouped signed bytes");
        defer value.deinit();
        try rejected(f, if (mode == 0) error.NativeGroupMemberNotOwned else error.NativeGroupMemberAlreadyOwned, &f.actors, .{ .signed = &value }, f.journal(prepared, signed_record, .preserve));
    }
}

test "native group guards prohibit ordinary scalar intent and signature routes before and after restart" {
    const f = try Fixture.init(a);
    defer f.deinit();
    try f.replace();
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public grouped signed bytes");
    defer signed.deinit();
    for (0..2) |restart| {
        if (restart == 1) try f.reopen();
        const disk = try dbDigest(f);
        for (f.actors, &f.replacements) |actor, *value| {
            try std.testing.expectError(error.NativeGroupOwnsOperation, actor.persistence(now).intent(value));
            try std.testing.expectError(error.NativeGroupOwnsOperation, actor.persistence(now).signed(value, &signed));
            try std.testing.expect(actor.signed == null);
        }
        try std.testing.expectEqual(disk, try dbDigest(f));
    }
}

fn scalarJournal(f: *Fixture, allocator: std.mem.Allocator) !groups.Journal {
    return groups.Journal.create(allocator, .{ .database = &f.database, .domain_name = "destination-9" }, f.actors[0..1], f.replacements[0..1], now);
}

test "native group guards key barrier rejects missing foreign links and stale journal before signer admission" {
    for (0..3) |mode| {
        const f = try Fixture.init(a);
        defer f.deinit();
        var journal = try scalarJournal(f, a);
        defer journal.deinit();
        if (mode == 0) try deleteLink(f, 0) else if (mode == 1) try f.stores[0].typed.put(a, op.group_link_prefix, &f.options[0].id, &([_]u8{19} ** 32)) else try journal.store.put(a, op.group_record_prefix, &journal.id, "{\"phase\":\"superseded\"}");
        var persistence: groups.Persistence = .{ .journal = &journal, .actors = f.actors[0..1], .now = now };
        const disk = try dbDigest(f);
        try std.testing.expectError(if (mode == 2) error.StaleNativeGroupOwner else error.NativeGroupMemberNotOwned, persistence.interface().intent(&f.replacements[0]));
        try std.testing.expectEqual(disk, try dbDigest(f));
        try std.testing.expect(f.actors[0].signed == null);
    }
}

test "native group guards preserve confirmation monotonic bound under wall rollback and repeated observations" {
    const f = try Fixture.init(a);
    defer f.deinit();
    try f.replace();
    try sign(f);
    const included = "{\"phase\":\"included\"}";
    try op.commitGroup(a, &f.actors, .{ .confirming = .{ .unix_ms = 601000, .delay_ms = 600000 } }, f.journal(signed_record, included, .preserve), now);
    for (f.actors) |actor| try std.testing.expectEqual(@as(u64, 600000), actor.value.next_attempt_ms);
    // Monotonic elapsed time advances while wall time moves backwards.
    try op.commitGroup(a, &f.actors, .{ .confirming = .{ .unix_ms = 700000, .delay_ms = 600000 } }, f.journal(included, included, .preserve), .{ .unix_ms = 0, .monotonic_ms = 300000 });
    for (f.actors) |actor| {
        try std.testing.expectEqual(@as(u64, 600000), actor.value.next_attempt_ms);
        try std.testing.expectEqual(@as(u64, 601000), actor.deadline.?.unix_ms);
    }
    const before = try dbDigest(f);
    try op.commitGroup(a, &f.actors, .{ .confirming = .{ .unix_ms = 700000, .delay_ms = 600000 } }, f.journal(included, included, .preserve), .{ .unix_ms = 0, .monotonic_ms = 300000 });
    try std.testing.expectEqual(before, try dbDigest(f));
    // An elapsed, already-started window has no deadline; never create a new one.
    for (f.actors) |actor| _ = try actor.tick(.{ .unix_ms = 701000, .monotonic_ms = 700000 });
    try f.reopen();
    for (f.actors) |actor| try std.testing.expect(actor.deadline == null);
    try op.commitGroup(a, &f.actors, .{ .confirming = .{ .unix_ms = 1301000, .delay_ms = 600000 } }, f.journal(included, included, .preserve), .{ .unix_ms = 701000, .monotonic_ms = 7 });
    for (f.actors) |actor| try std.testing.expect(actor.value.next_attempt_ms <= 7);
}

test "native group guards committed creation followed by load OOM remains durably owned and recoverable" {
    var create_counter = std.testing.FailingAllocator.init(a, .{});
    var load_counter = std.testing.FailingAllocator.init(a, .{});
    {
        const f = try Fixture.init(a);
        defer f.deinit();
        var journal = try scalarJournal(f, create_counter.allocator());
        defer journal.deinit();
        var loaded = (try groups.Journal.load(load_counter.allocator(), journal.store, journal.id)).?;
        loaded.deinit();
    }
    try std.testing.expect(create_counter.alloc_index > load_counter.alloc_index);
    const load_first_allocation = create_counter.alloc_index - load_counter.alloc_index;
    const f = try Fixture.init(a);
    defer f.deinit();
    var failing = std.testing.FailingAllocator.init(a, .{ .fail_index = load_first_allocation });
    try std.testing.expectError(error.OutOfMemory, scalarJournal(f, failing.allocator()));
    const link = (try f.stores[0].typed.get(a, op.group_link_prefix, &f.options[0].id)) orelse return error.CommittedGroupLinkMissing;
    defer a.free(link);
    try std.testing.expectEqual(@as(usize, 32), link.len);
    const id = link[0..32].*;
    var recovered = (try groups.Journal.load(a, .{ .database = &f.database, .domain_name = "destination-9" }, id)) orelse return error.CommittedGroupMissing;
    defer recovered.deinit();
    try std.testing.expectEqual(.prepared, recovered.record.phase);
    try f.reopen();
    try std.testing.expectError(error.NativeGroupOwnsOperation, f.actors[0].persistence(now).intent(&f.replacements[0]));
    var signed = try types.Signed.init(a, .{ .hash256 = @splat(8) }, "public recovered group bytes");
    defer signed.deinit();
    var persistence: groups.Persistence = .{ .journal = &recovered, .actors = f.actors[0..1], .now = now };
    try persistence.interface().intent(&f.replacements[0]);
    try persistence.interface().signed(&f.replacements[0], &signed);
    try f.reopen();
    try std.testing.expectEqualStrings(signed.bytes, f.actors[0].signed.?.bytes);
    try std.testing.expect(f.actors[1].signed == null);
}

fn pairJournal(f: *Fixture) !groups.Journal {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const memory = arena.allocator();
    const source0 = std.fmt.bytesToHex(f.previous[0], .lower);
    const source1 = std.fmt.bytesToHex(f.previous[1], .lower);
    const body = try std.json.Stringify.valueAlloc(memory, .{ .transaction = .{ .nonce = "0x9" }, .batch_members = .{ .{ .source_intent_digest = &source0, .gas_limit = 10, .estimated_cost = 20 }, .{ .source_intent_digest = &source1, .gas_limit = 10, .estimated_cost = 20 } }, .gas_limit = 20, .estimated_cost = 40 }, .{});
    for (&f.replacements) |*value| {
        const authority = value.authority;
        const replacement = try types.Prepared.init(a, authority, body, 20, 40);
        value.deinit();
        value.* = replacement;
    }
    return groups.Journal.create(a, .{ .database = &f.database, .domain_name = "destination-9" }, &f.actors, &f.replacements, now);
}

test "native group guards signer admission checks expected second member status inherited owner and complete member set" {
    for (0..5) |mode| {
        const f = try Fixture.init(a);
        defer f.deinit();
        var journal = try pairJournal(f);
        defer journal.deinit();
        var actors = f.actors;
        var count: usize = 2;
        switch (mode) {
            0 => {
                const bytes = try (db.json.Status{ .Retry = .Manual }).toJson(a);
                defer a.free(bytes);
                try f.stores[1].typed.put(a, db.keys.Table.status_by_message_id.prefix(), &f.options[1].id, bytes);
            },
            1 => {
                const bytes = try db.codec.encodeUuids(a, &.{@splat(3)});
                defer a.free(bytes);
                try f.stores[1].typed.put(a, db.keys.Table.payload_uuids_by_message_id.prefix(), &f.options[1].id, bytes);
            },
            2 => count = 1,
            3 => actors[1] = actors[0],
            4 => try deleteLink(f, 1),
            else => unreachable,
        }
        var persistence: groups.Persistence = .{ .journal = &journal, .actors = actors[0..count], .now = now };
        const disk = try dbDigest(f);
        const expected: anyerror = switch (mode) {
            0 => error.StaleNativeOperationOwner,
            1 => error.InheritedPayloadNeedsReconciliation,
            2 => error.InvalidNativeGroup,
            3 => error.NativeGroupIntentChanged,
            4 => error.NativeGroupMemberNotOwned,
            else => unreachable,
        };
        try std.testing.expectError(expected, persistence.interface().intent(&f.replacements[0]));
        try std.testing.expectEqual(disk, try dbDigest(f));
        for (f.actors) |actor| try std.testing.expect(actor.signed == null);
    }
}
