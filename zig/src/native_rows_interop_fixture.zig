//! Storage interoperability only. Public synthetic values; no SDK, network,
//! signing key, broadcast, observed chain finality or elapsed600s acceptance.
const std = @import("std");
const db = @import("db/root.zig");
const Store = @import("agents/store.zig").Store;
const protocol = @import("protocol/root.zig");
const types = @import("agents/destination/types.zig");
const operations = @import("agents/destination/operation.zig");
const hex = @import("evm/codecs.zig");
const json_rpc = @import("net/json_rpc.zig");
const groups = @import("agents/relayer/native_group.zig");
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const origin_domain = 9913371;
const destination_domain = 9913372;
const marker = "ziggy-native-rows-interop-v2\n";
const now: operations.Times = .{ .unix_ms = 1800000000000, .monotonic_ms = 100 };
const secret = "native-rows-sensitive-authorization-never-print";
const Fingerprint = struct { bytes: usize, sha256: []const u8 };
fn fingerprint(a: std.mem.Allocator, bytes: []const u8) !Fingerprint {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return .{ .bytes = bytes.len, .sha256 = try hex.hexAlloc(a, &digest) };
}
const count = 5;
fn message(index: usize) protocol.Message {
    const bodies = [_][]const u8{ "native-rows-public-message-0", "native-rows-public-message-1", "native-rows-public-message-2", "native-rows-public-message-3", "native-rows-public-message-4" };
    return .{ .nonce = @intCast(index), .origin = origin_domain, .destination = destination_domain, .sender = .{0x11} ** 32, .recipient = .{0x22} ** 32, .body = bodies[index] };
}
fn options(index: usize) operations.Options {
    return .{ .id = message(index).id(), .context = @splat(@as(u8, @intCast(if (index == 3) 9 else 7 + index))), .nonce = @intCast(index), .origin = origin_domain, .destination = destination_domain };
}
fn recoveryOptions(index: usize, destination: db.rocks.Typed) operations.Options {
    var result = options(index);
    result.group_store = destination;
    return result;
}
fn identity(index: usize) types.Identity {
    if (index == 1) return .{ .signature512 = .{0xab} ** 32 ++ .{0xcd} ** 32 };
    var value: [32]u8 = @splat(0);
    value[31] = if (index == 0) 0x44 else if (index == 4) 0x77 else 0x66;
    return .{ .hash256 = value };
}
fn signedBytes(index: usize) []const u8 {
    return if (index == 0) "native-rows-signed-wire-never-print/hash256" else if (index == 1) "native-rows-signed-wire-never-print/signature512" else if (index == 4) "native-rows-signed-wire-never-print/aleo" else "native-rows-signed-wire-never-print/shared-batch";
}
fn mailbox(index: usize) types.Hash {
    return if (index == 1) @splat(0x33) else .{0} ** 31 ++ .{0x33};
}
fn hook(index: usize) types.Hash {
    return if (index == 1) @splat(0x55) else .{0} ** 31 ++ .{0x55};
}
fn weight(index: usize) u64 {
    return if (index == 2) 1 else if (index == 3) 3 else 100;
}
fn originalCost(index: usize) u256 {
    return (@as(u256, 1) << 240) + 17 + index;
}
fn authority(index: usize) types.Authority {
    return .{ .protocol = if (index == 1) .sealevel else if (index == 4) .aleo else .starknet, .origin = origin_domain, .destination = destination_domain, .mailbox = mailbox(index), .origin_hook = hook(index), .chain_id = if (index == 1) "public-native-storage-fixture" else if (index == 4) "testnet" else "0x534e5f5345504f4c4941", .operation_id = message(index).id(), .generation = 1, .kind = .process, .target = if (index == 4) .{0} ** 31 ++ .{0x77} else null };
}
fn preparedScalar(a: std.mem.Allocator, index: usize) !types.Prepared {
    const body = if (index == 1 or index == 4) try std.json.Stringify.valueAlloc(a, .{ .public_fixture_case = index }, .{}) else try std.json.Stringify.valueAlloc(a, .{ .transaction = .{ .nonce = "0x9" }, .public_key = "0x7", .gas_limit = weight(index), .estimated_cost = originalCost(index) }, .{});
    defer a.free(body);
    return types.Prepared.init(a, authority(index), body, weight(index), originalCost(index));
}
fn gas(index: usize) u256 {
    const whole = (@as(u256, 1) << 200) + 101;
    return if (index == 2 or index == 3) whole * weight(index) / 4 else (@as(u256, 1) << 200) + 123 + index;
}
fn tokens(index: usize) u256 {
    const whole = (@as(u256, 1) << 240) + 17;
    return if (index == 2 or index == 3) whole * weight(index) / 4 else (@as(u256, 1) << 240) + 456 + index;
}
fn payment(index: usize) u256 {
    return (@as(u256, 1) << 192) + 789 + index;
}
fn paymentGas(index: usize) u256 {
    return (@as(u256, 1) << 160) + 101112 + index;
}
fn u256Hex(a: std.mem.Allocator, value: u256) ![]const u8 {
    var bytes: [32]u8 = undefined;
    std.mem.writeInt(u256, &bytes, value, .big);
    return hex.hexAlloc(a, &bytes);
}
const PublicMember = struct { operation_id: []const u8, origin: u32, origin_hook: ?[]const u8, generation: u64, source_intent_digest: []const u8, gas_limit: u64, estimated_cost: []const u8 };
const PublicQuote = struct { gas_limit: u64, estimated_cost: []const u8, batch: ?struct { version: u8, members: []PublicMember } };
fn normalizedHash(a: std.mem.Allocator, value: []const u8) ![]const u8 {
    if (value.len != 64) return error.ExpectedSourceHex64;
    var bytes: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&bytes, value);
    return hex.hexAlloc(a, &bytes);
}
fn publicQuote(a: std.mem.Allocator, body: std.json.Value) !PublicQuote {
    var result: PublicQuote = .{ .gas_limit = try json_rpc.integer(u64, try json_rpc.field(body, "gas_limit")), .estimated_cost = try std.fmt.allocPrint(a, "{d}", .{try json_rpc.integer(u256, try json_rpc.field(body, "estimated_cost"))}), .batch = null };
    if (body.object.get("batch_members")) |raw| {
        const members = try a.alloc(PublicMember, raw.array.items.len);
        for (raw.array.items, members) |item, *member| {
            const origin_hook = try json_rpc.field(item, "origin_hook");
            member.* = .{ .operation_id = try normalizedHash(a, try json_rpc.string(try json_rpc.field(item, "operation_id"))), .origin = try json_rpc.integer(u32, try json_rpc.field(item, "origin")), .origin_hook = if (origin_hook == .null) null else try normalizedHash(a, try json_rpc.string(origin_hook)), .generation = try json_rpc.integer(u64, try json_rpc.field(item, "generation")), .source_intent_digest = try normalizedHash(a, try json_rpc.string(try json_rpc.field(item, "source_intent_digest"))), .gas_limit = try json_rpc.integer(u64, try json_rpc.field(item, "gas_limit")), .estimated_cost = try std.fmt.allocPrint(a, "{d}", .{try json_rpc.integer(u256, try json_rpc.field(item, "estimated_cost"))}) };
        }
        result.batch = .{ .version = try json_rpc.integer(u8, try json_rpc.field(body, "batch_version")), .members = members };
    }
    return result;
}
const Expected = struct {
    id: []const u8,
    nonce: u32,
    context: []const u8,
    generation: u64,
    stage: []const u8,
    confirmation_started: bool,
    deadline: ?@import("agents/operation.zig").Deadline,
    identity: struct { kind: []const u8, hex: []const u8 },
    row: Fingerprint,
    stored_canonical_intent: Fingerprint,
    signed: Fingerprint,
    message_wire: Fingerprint,
    authority: std.json.Value,
    gas_used_hex: []const u8,
    tokens_used_hex: []const u8,
    starknet: ?PublicQuote,
    payment_hex: []const u8,
    payment_gas_hex: []const u8,
};
fn expected(a: std.mem.Allocator, operation: *operations.Operation, index: usize) !Expected {
    const signed = operation.signed orelse return error.MissingSigned;
    if (!types.Identity.eql(signed.identity, identity(index)) or !std.mem.eql(u8, signed.bytes, signedBytes(index))) return error.RestartSignedChanged;
    if (index == 2 or index == 3) {
        if (operation.authorization != null) return error.UnexpectedGroupAuthorization;
    } else if (!std.mem.eql(u8, operation.authorization orelse return error.MissingAuthorization, secret)) return error.RestartAuthorizationChanged;
    const intent = operation.intent orelse return error.MissingIntent;
    const document = try std.json.parseFromSlice(std.json.Value, a, intent, .{ .allocate = .alloc_always });
    const wire = try message(index).encodeAlloc(a);
    return .{
        .id = try hex.hexAlloc(a, &operation.options.id),
        .nonce = @intCast(index),
        .context = try hex.hexAlloc(a, &operation.options.context),
        .generation = operation.value.generation,
        .stage = @tagName(operation.value.stage),
        .confirmation_started = operation.value.confirmation_started,
        .deadline = operation.deadline,
        .identity = .{ .kind = @tagName(signed.identity), .hex = switch (signed.identity) {
            .hash256 => |id| try hex.hexAlloc(a, &id),
            .signature512 => |id| try hex.hexAlloc(a, &id),
        } },
        .row = try fingerprint(a, operation.row orelse return error.MissingRow),
        .stored_canonical_intent = try fingerprint(a, intent),
        .signed = try fingerprint(a, signed.bytes),
        .message_wire = try fingerprint(a, wire),
        .authority = document.value.object.get("authority") orelse return error.MissingAuthority,
        .gas_used_hex = try u256Hex(a, gas(index)),
        .tokens_used_hex = try u256Hex(a, tokens(index)),
        .starknet = if (index == 0 or index == 2 or index == 3) try publicQuote(a, document.value.object.get("payload") orelse return error.MissingPayload) else null,
        .payment_hex = try u256Hex(a, payment(index)),
        .payment_gas_hex = try u256Hex(a, paymentGas(index)),
    };
}
fn validateRoot(a: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const root = try std.fs.cwd().realpathAlloc(a, raw);
    const temporary = try std.fs.cwd().realpathAlloc(a, "/tmp");
    if (!std.mem.eql(u8, std.fs.path.dirname(root) orelse return error.ExpectedOwnedRoot, temporary) or !std.mem.startsWith(u8, std.fs.path.basename(root), "ziggy-native-rows-interop-")) return error.ExpectedOwnedRoot;
    const path = try std.fs.path.join(a, &.{ root, "fixture.marker" });
    const actual = try std.fs.cwd().readFileAlloc(a, path, 1024);
    if (!std.mem.eql(u8, actual, marker)) return error.ExpectedPublicFixtureMarker;
    return root;
}
fn seedMessage(a: std.mem.Allocator, origin: *Store, index: usize) !void {
    const value = message(index);
    if (!try origin.storeMessage(value, 10 + index, null)) return error.MessageAlreadyPresent;
    // Typed canonical false marker; no private operation JSON is written
    // here. The immutable Rust reader verifies this exact codec value.
    var batch = try origin.typed.batch(a);
    defer batch.deinit();
    try batch.put(db.keys.Table.nonce_processed.prefix(), try db.codec.encode(a, value.nonce), try db.codec.encode(a, false));
    try batch.commitSync();
    const incoming: db.codec.GasPayment = .{ .message_id = value.id(), .destination = destination_domain, .payment = payment(index), .gas_amount = paymentGas(index) };
    const meta: db.codec.GasPaymentMeta = .{ .transaction_id = @splat(@as(u8, @intCast(0x70 + index))), .log_index = index };
    if (!try origin.storePayment(incoming, meta) or try origin.storePayment(incoming, meta)) return error.PaymentNotIdempotent;
}
fn groupRows(a: std.mem.Allocator, origin: *Store, destination: db.rocks.Typed, write: bool, rows: *[count]Expected) !void {
    var actors: [2]*operations.Operation = undefined;
    for (&actors, 0..) |*slot, member| {
        const index = member + 2;
        if (!write and !try operations.Operation.hasSignedRecovery(a, origin, recoveryOptions(index, destination), now)) return error.MissingRecoveredGroupOwnership;
        slot.* = try operations.Operation.open(a, origin, recoveryOptions(index, destination), now);
    }
    defer for (actors) |actor| actor.deinit();
    if (write) {
        var originals: [2]types.Prepared = undefined;
        for (&originals, actors, 0..) |*slot, actor, member| {
            const effect = try actor.tick(now);
            if (effect != .prepare or effect.prepare != 1) return error.ExpectedFirstPrepare;
            slot.* = try preparedScalar(a, member + 2);
            try actor.prepared(slot, true, true, now);
        }
        defer for (&originals) |*value| value.deinit();
        const Member = struct { operation_id: [64]u8, origin: u32, origin_hook: [64]u8, generation: u64, source_intent_digest: [64]u8, gas_limit: u64, estimated_cost: u256 };
        var manifest: [2]Member = undefined;
        for (&manifest, originals, 0..) |*member, original, offset| {
            const index = offset + 2;
            member.* = .{ .operation_id = std.fmt.bytesToHex(message(index).id(), .lower), .origin = origin_domain, .origin_hook = std.fmt.bytesToHex(hook(index), .lower), .generation = 1, .source_intent_digest = std.fmt.bytesToHex(original.digest(), .lower), .gas_limit = weight(index), .estimated_cost = originalCost(index) };
        }
        var replacements: [2]types.Prepared = undefined;
        for (&replacements, 0..) |*slot, offset| {
            const index = offset + 2;
            const body = try std.json.Stringify.valueAlloc(a, .{ .transaction = .{ .nonce = "0x9" }, .public_key = "0x7", .gas_limit = weight(index), .estimated_cost = originalCost(index), .batch_version = @as(u8, 1), .batch_members = manifest, .batch_gas_limit = @as(u64, 4), .batch_estimated_cost = (@as(u256, 1) << 240) + 99 }, .{});
            slot.* = try types.Prepared.init(a, authority(index), body, weight(index), originalCost(index));
        }
        defer for (&replacements) |*value| value.deinit();
        var journal = try groups.Journal.create(a, destination, &actors, &replacements, now);
        defer journal.deinit();
        var signed = try types.Signed.init(a, identity(2), signedBytes(2));
        defer signed.deinit();
        var record = journal.record;
        record.phase = .signed;
        record.identity = try hex.hexAlloc(a, &signed.identity.hash256);
        record.signed = try hex.hexAlloc(a, signed.bytes);
        try journal.write(record, &actors, .{ .signed = &signed }, now);
        var committed = (try groups.Journal.load(a, destination, journal.id)) orelse return error.MissingGroup;
        defer committed.deinit();
        try committed.write(committed.record, &actors, .{ .confirming = .{ .unix_ms = now.unix_ms + 600000, .delay_ms = 600000 } }, now);
        for (actors, 0..) |actor, offset| {
            const index = offset + 2;
            const receipt: types.Receipt = .{ .identity = signed.identity, .block_hash = .{8} ** 32, .height = 20 + index, .success = true, .finalized = true, .expenditure = .{ .gas_used = gas(index), .tokens_used = tokens(index) } };
            if (!try actor.recordExpenditure(receipt) or try actor.recordExpenditure(receipt)) return error.ExpenditureNotIdempotent;
        }
    }
    for (actors, 0..) |actor, member| {
        const index = member + 2;
        if (try origin.processed(@intCast(index))) return error.UnexpectedCanonicalAcknowledgment;
        rows[index] = try expected(a, actor, index);
    }
}
pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const args = try std.process.argsAlloc(a);
    if (args.len != 3) return error.ExpectedModeAndOwnedFixtureRoot;
    const write = std.mem.eql(u8, args[1], "write-hold");
    if (!write and !std.mem.eql(u8, args[1], "reopen")) return error.ExpectedFixtureMode;
    const root = try validateRoot(a, args[2]);
    const path = try std.fs.path.join(a, &.{ root, "db" });
    if (write) {
        if (std.fs.cwd().access(path, .{})) |_| return error.DatabaseMustNotExist else |err| if (err != error.FileNotFound) return err;
    }
    var database = try db.rocks.Database.open(a, path, .{ .create_if_missing = write, .read_only = !write });
    defer database.deinit();
    var origin = Store.init(a, &database, "test1");
    const destination = Store.init(a, &database, "test2");
    var rows: [count]Expected = undefined;
    if (write) for (0..count) |index| try seedMessage(a, &origin, index);
    for ([_]usize{ 0, 1, 4 }) |index| {
        const value = message(index);
        if (!write and !try operations.Operation.hasSignedRecovery(a, &origin, recoveryOptions(index, destination.typed), now)) return error.MissingRecoveredOwnership;
        const operation = try operations.Operation.open(a, &origin, recoveryOptions(index, destination.typed), now);
        defer operation.deinit();
        if (write) {
            const effect = try operation.tick(now);
            if (effect != .prepare or effect.prepare != 1) return error.ExpectedFirstPrepare;
            var prepared = try preparedScalar(a, index);
            defer prepared.deinit();
            try operation.prepared(&prepared, true, true, now);
            const persistence = operation.persistence(now);
            try persistence.intent(&prepared);
            try persistence.persistAuthorization.?(persistence.context, value.id(), secret);
            var signed = try types.Signed.init(a, identity(index), signedBytes(index));
            defer signed.deinit();
            try persistence.signed(&prepared, &signed);
            try operation.beginConfirmation(now);
            if (operation.value.policy.confirm_delay_ms != 600000 or operation.deadline.?.delay_ms != 600000 or operation.deadline.?.unix_ms != now.unix_ms + 600000) return error.ConfirmationPolicyChanged;
            const receipt: types.Receipt = .{ .identity = signed.identity, .block_hash = .{8} ** 32, .height = 20 + index, .success = true, .finalized = true, .expenditure = .{ .gas_used = gas(index), .tokens_used = tokens(index) } };
            if (!try operation.recordExpenditure(receipt) or try operation.recordExpenditure(receipt)) return error.ExpenditureNotIdempotent;
        }
        if (try origin.processed(value.nonce)) return error.UnexpectedCanonicalAcknowledgment;
        const spent = try origin.expenditure(value.id());
        if (spent.gas_used != gas(index) or spent.tokens_used != tokens(index)) return error.AggregateCostChanged;
        rows[index] = try expected(a, operation, index);
    }
    try groupRows(a, &origin, destination.typed, write, &rows);
    const output = try std.json.Stringify.valueAlloc(a, .{ .marker = "ziggy-native-rows-interop-v2", .mode = args[1], .origin = origin_domain, .destination = destination_domain, .origin_namespace = "test1", .confirmation_policy_ms = @as(u64, 600000), .elapsed_hold_credit_ms = @as(u64, 0), .broadcasts = @as(u64, 0), .rows = rows }, .{});
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
    if (write) {
        var byte: [1]u8 = undefined;
        if (try std.fs.File.stdin().read(&byte) != 1 or byte[0] != '\n') return error.ExpectedExplicitRelease;
    }
}
