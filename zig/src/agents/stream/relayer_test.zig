const std = @import("std");
const relayer = @import("relayer.zig");
const stream_store = @import("relayer_store.zig");
const native = @import("../store.zig");
const protocol = @import("../../protocol/root.zig");
const rocks = @import("../../db/rocks.zig");
const codec = @import("../../db/codec.zig");
const A = std.mem.Allocator;

const domain = 5;
const destination = 9;
const contracts = stream_store.Contracts{
    .mailbox = [_]u8{0} ** 31 ++ [_]u8{1},
    .interchain_gas_paymaster = [_]u8{0} ** 31 ++ [_]u8{2},
    .merkle_tree_hook = [_]u8{0} ** 31 ++ [_]u8{3},
};

fn options(authority: bool) relayer.Options {
    return .{
        .authority_enabled = authority,
        .parity_retry_attempts = 2,
        .parity_retry_delay_ms = 5,
        .progress_grace_ms = 100,
        .authoritative_probe_interval_ms = 50,
    };
}

const Fixture = struct {
    allocator: A,
    temporary: std.testing.TmpDir,
    path: []u8,
    database: rocks.Database,
    native_store: native.Store,
    adapter: stream_store.Adapter,
    controller: ?relayer.Controller = null,

    fn create() !*Fixture {
        const allocator = std.testing.allocator;
        const self = try allocator.create(Fixture);
        errdefer allocator.destroy(self);
        self.allocator = allocator;
        self.temporary = std.testing.tmpDir(.{});
        errdefer self.temporary.cleanup();
        self.path = try self.temporary.dir.realpathAlloc(allocator, ".");
        errdefer allocator.free(self.path);
        self.database = try rocks.Database.open(allocator, self.path, .{ .sync = true });
        errdefer self.database.deinit();
        self.native_store = native.Store.init(allocator, &self.database, "test");
        self.adapter = stream_store.Adapter.init(&self.native_store, contracts);
        self.controller = null;
        return self;
    }

    fn deinit(self: *Fixture) void {
        if (self.controller) |*controller| controller.deinit();
        self.database.deinit();
        self.allocator.free(self.path);
        self.temporary.cleanup();
        self.allocator.destroy(self);
    }

    fn start(self: *Fixture, authority: bool) !void {
        self.controller = try relayer.Controller.init(self.allocator, &.{.{ .domain = domain, .adapter = &self.adapter }}, options(authority));
    }

    fn startWithAllocator(self: *Fixture, allocator: A) !void {
        self.controller = try relayer.Controller.init(allocator, &.{.{ .domain = domain, .adapter = &self.adapter }}, options(true));
    }

    fn connection(self: *Fixture) !u64 {
        const generation = try self.controller.?.beginConnection(domain);
        try self.controller.?.markReady(domain, generation, 3);
        try self.controller.?.markSubscribed(domain, generation);
        return generation;
    }

    fn emptyCaughtUp(self: *Fixture, generation: u64) !void {
        try self.controller.?.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, -1);
        try self.controller.?.acceptCaughtUp(domain, generation, .merkle_tree_insertion, contracts.merkle_tree_hook, -1);
    }

    fn activate(self: *Fixture) !u64 {
        const generation = try self.connection();
        try self.emptyCaughtUp(generation);
        const plan = (try self.controller.?.probePlan(domain, 0)).?;
        try self.controller.?.applyProbe(plan, .{ .dispatch = 0, .merkle_tree_insertion = 0 }, 0);
        const command = try self.controller.?.beginCutover(domain, generation);
        try std.testing.expect(try self.controller.?.rpcRequired(domain));
        try self.controller.?.markPaused(domain, command.generation);
        try self.controller.?.completeCutover(domain, generation, command.generation);
        try std.testing.expect(!try self.controller.?.rpcRequired(domain));
        return generation;
    }

    fn reopen(self: *Fixture) !void {
        if (self.controller) |*controller| controller.deinit();
        self.controller = null;
        self.database.deinit();
        self.database = try rocks.Database.open(self.allocator, self.path, .{ .sync = true });
        self.native_store = native.Store.init(self.allocator, &self.database, "test");
        self.adapter = stream_store.Adapter.init(&self.native_store, contracts);
    }
};

fn message(nonce: u32, body: []const u8) protocol.Message {
    return .{
        .version = 3,
        .nonce = nonce,
        .origin = domain,
        .sender = [_]u8{0x11} ** 32,
        .destination = destination,
        .recipient = [_]u8{0x22} ** 32,
        .body = body,
    };
}

fn dispatch(nonce: u32, body: []const u8) stream_store.DispatchInput {
    return .{
        .block_number = 100 + nonce,
        .message = message(nonce, body),
        .transaction_id = [_]u8{0} ** 63 ++ [_]u8{@intCast(nonce + 1)},
    };
}

fn fingerprint(kind: []const u8, sequence: u32) [32]u8 {
    return relayer.eventFingerprint(&.{ kind, &std.mem.toBytes(std.mem.nativeToBig(u32, sequence)) });
}

fn merkle(nonce: u32) stream_store.MerkleInput {
    return .{ .block_number = 100 + nonce, .insertion = .{ .leaf_index = nonce, .message_id = [_]u8{@intCast(nonce + 1)} ** 32 } };
}

fn gas(stream_cursor: u64, sequence: ?u32) stream_store.GasPaymentInput {
    return .{
        .cursor = .{
            .fingerprint = fingerprint("gas_payment", @intCast(stream_cursor)),
            .legacy_max_stream_cursor = 0,
            .stream_cursor = stream_cursor,
        },
        .payment = .{ .message_id = [_]u8{7} ** 32, .destination = destination, .payment = 100, .gas_amount = 50 },
        .meta = .{ .transaction_id = [_]u8{8} ** 64, .log_index = sequence orelse 0 },
        .sequence = sequence,
        .block_number = 100,
    };
}

fn seedDispatch(fixture: *Fixture, nonce: u32, body: []const u8) !void {
    _ = try fixture.native_store.storeMessage(message(nonce, body), 100 + nonce, dispatch(nonce, body).transaction_id);
}

fn seedMerkle(fixture: *Fixture, nonce: u32) !void {
    _ = try fixture.native_store.storeInsertion(merkle(nonce).insertion, 100 + nonce);
}

test "authoritative cutover requires parity fresh probe and acknowledged RPC pause then revokes on lag" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.activate();
    const input = dispatch(0, "hello");
    try std.testing.expectEqual(relayer.SequenceResult.accepted, try fixture.controller.?.acceptDispatch(domain, generation, input, fingerprint("dispatch", 0)));
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 1));
    try std.testing.expectEqual(@as(?u32, 0), try fixture.adapter.cursor(.dispatch));
    var stored = (try fixture.native_store.messageByNonce(0)).?;
    defer stored.deinit();
    try std.testing.expectEqualSlices(u8, "hello", stored.value.body);
    const plan = (try fixture.controller.?.probePlan(domain, 2)).?;
    try fixture.controller.?.applyProbe(plan, .{ .dispatch = 1, .merkle_tree_insertion = 0 }, 2);
    try std.testing.expect(!try fixture.controller.?.rpcRequired(domain));
    try fixture.controller.?.applyProbe(plan, .{ .dispatch = 5, .merkle_tree_insertion = 0 }, 3);
    try std.testing.expect(!try fixture.controller.?.rpcRequired(domain));
    try fixture.controller.?.applyProbe(plan, .{ .dispatch = 5, .merkle_tree_insertion = 0 }, 104);
    try std.testing.expect(try fixture.controller.?.rpcRequired(domain));
    const next = try fixture.controller.?.beginConnection(domain);
    try std.testing.expect(next > generation);
    try std.testing.expectEqual(relayer.ParityStep.stale_generation, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 200));
    try std.testing.expectError(error.StaleAuthorityGeneration, fixture.controller.?.markPaused(domain, 1));
}

test "observer keeps RPC and never credits gas or stores missing canonical events" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(false);
    const generation = try fixture.connection();
    try std.testing.expectEqual(relayer.GasEventResult.shadow, try fixture.controller.?.acceptGasPayment(domain, generation, gas(1, null)));
    const key = codec.GasPaymentKey{ .message_id = [_]u8{7} ** 32, .destination = destination };
    try std.testing.expect((try fixture.native_store.payment(key)) == null);
    try std.testing.expect((try fixture.adapter.gasPaymentCursor()) == null);
    try std.testing.expectEqual(relayer.GasEventResult.accepted, try fixture.controller.?.acceptGasCaughtUp(domain, generation, contracts.interchain_gas_paymaster, 0, 1));
    try std.testing.expect((try fixture.adapter.gasPaymentCursor()) == null);
    try std.testing.expect(!try fixture.controller.?.gasAuthority(domain));
    try std.testing.expect(try fixture.controller.?.rpcRequired(domain));
    try fixture.controller.?.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, -1);
    const input = dispatch(0, "missing");
    _ = try fixture.controller.?.acceptDispatch(domain, generation, input, fingerprint("dispatch", 0));
    try std.testing.expectEqual(relayer.ParityStep.pending, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 0));
    try std.testing.expectEqual(relayer.ParityStep.expired, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 5));
    try std.testing.expect((try fixture.native_store.messageByNonce(0)) == null);
    try std.testing.expect(try fixture.controller.?.rpcRequired(domain));
}

test "fresh markers retry local presence and durable replay survives native reopen" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.connection();
    try fixture.controller.?.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, 0);
    try std.testing.expect((try fixture.adapter.cursor(.dispatch)) == null);
    try seedDispatch(fixture, 0, "hello");
    try fixture.controller.?.retryFreshMarkers(domain);
    try std.testing.expectEqual(@as(?u32, 0), try fixture.adapter.cursor(.dispatch));
    try fixture.reopen();
    try fixture.start(true);
    const resumed = try fixture.connection();
    try fixture.controller.?.acceptCaughtUp(domain, resumed, .dispatch, contracts.mailbox, 0);
    const input = dispatch(0, "hello");
    try std.testing.expectEqual(relayer.SequenceResult.accepted, try fixture.controller.?.acceptDispatch(domain, resumed, input, fingerprint("dispatch", 0)));
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, resumed, 0));
    try std.testing.expectEqual(relayer.SequenceResult.duplicate, try fixture.controller.?.acceptDispatch(domain, resumed, input, fingerprint("dispatch", 0)));
    try std.testing.expectError(error.ConflictingStreamSequence, fixture.controller.?.acceptDispatch(domain, resumed, input, fingerprint("different", 0)));
    try std.testing.expectError(error.StreamGap, fixture.controller.?.acceptDispatch(domain, resumed, dispatch(2, "gap"), fingerprint("dispatch", 2)));
    try std.testing.expectError(error.DuplicateCaughtUpMarker, fixture.controller.?.acceptCaughtUp(domain, resumed, .dispatch, contracts.mailbox, 0));
}

test "canonical fork persists unhealthy v2 without replacing processed canonical message" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.activate();
    try seedDispatch(fixture, 0, "canonical");
    try fixture.native_store.markProcessed(message(0, "canonical"));
    const fork = dispatch(0, "fork");
    _ = try fixture.controller.?.acceptDispatch(domain, generation, fork, fingerprint("dispatch", 0));
    try std.testing.expectEqual(relayer.ParityStep.conflict, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 0));
    try std.testing.expect(try fixture.adapter.parityUnhealthy(.dispatch));
    var canonical = (try fixture.native_store.messageByNonce(0)).?;
    defer canonical.deinit();
    try std.testing.expectEqualSlices(u8, "canonical", canonical.value.body);
    try std.testing.expect(try fixture.native_store.processed(0));
    const resumed = try fixture.controller.?.beginConnection(domain);
    try fixture.controller.?.markReady(domain, resumed, 3);
    try fixture.controller.?.markSubscribed(domain, resumed);
    try std.testing.expectError(error.ParityUnhealthy, fixture.controller.?.acceptDispatch(domain, resumed, fork, fingerprint("dispatch", 0)));
}

test "gas sequence conflict is contained without double credit or authority" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.activate();
    const first = gas(1, 0);
    try std.testing.expectEqual(relayer.GasEventResult.accepted, try fixture.controller.?.acceptGasPayment(domain, generation, first));
    var conflict = gas(2, 0);
    conflict.payment.payment = 999;
    try std.testing.expectEqual(relayer.GasEventResult.conflict, try fixture.controller.?.acceptGasPayment(domain, generation, conflict));
    try std.testing.expectEqual(relayer.GasEventResult.dropped, try fixture.controller.?.acceptGasPayment(domain, generation, conflict));
    try std.testing.expectEqual(relayer.GasEventResult.dropped, try fixture.controller.?.acceptGasCaughtUp(domain, generation, contracts.interchain_gas_paymaster, 0, 2));
    try std.testing.expect(!try fixture.controller.?.gasAuthority(domain));
    const key = codec.GasPaymentKey{ .message_id = [_]u8{7} ** 32, .destination = destination };
    try std.testing.expectEqual(@as(u256, 100), (try fixture.native_store.payment(key)).?.payment);
    try std.testing.expect((try fixture.adapter.cursor(.dispatch)) == null);
    try std.testing.expectEqual(@as(u64, 1), (try fixture.adapter.gasPaymentCursor()).?.stream_cursor);
}

test "bounded parity overflow revokes and OOM cannot partially admit an event" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    var controller = &fixture.controller.?;
    controller.options.parity_queue_capacity = 1;
    controller.options.parity_pending_capacity = 1;
    const generation = try fixture.connection();
    try fixture.controller.?.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, -1);
    _ = try fixture.controller.?.acceptDispatch(domain, generation, dispatch(0, "a"), fingerprint("dispatch", 0));
    try std.testing.expectError(error.ParityOverflow, fixture.controller.?.acceptDispatch(domain, generation, dispatch(1, "b"), fingerprint("dispatch", 1)));
    try std.testing.expectEqual(@as(usize, 1), fixture.controller.?.total_pending);
    try fixture.reopen();

    try fixture.startWithAllocator(std.testing.allocator);
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    fixture.controller.?.allocator = failing.allocator();
    const next = try fixture.connection();
    try std.testing.expectError(error.OutOfMemory, fixture.controller.?.acceptDispatch(domain, next, dispatch(0, "oom"), fingerprint("dispatch", 0)));
    try std.testing.expectEqual(@as(usize, 0), fixture.controller.?.total_pending);
    try std.testing.expect((try fixture.native_store.messageByNonce(0)) == null);
}

test "wire decoders preserve full identities and gas JSON field order does not alter parity" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.connection();
    const msg = message(0, "hello");
    const id = msg.id();
    const id_text = try relayer.formatAddressAlloc(fixture.allocator, id);
    defer fixture.allocator.free(id_text);
    const mailbox = try relayer.formatAddressAlloc(fixture.allocator, contracts.mailbox);
    defer fixture.allocator.free(mailbox);
    const sender = try relayer.formatAddressAlloc(fixture.allocator, msg.sender);
    defer fixture.allocator.free(sender);
    const recipient = try relayer.formatAddressAlloc(fixture.allocator, msg.recipient);
    defer fixture.allocator.free(recipient);
    const hash = try relayer.formatAddressAlloc(fixture.allocator, [_]u8{9} ** 32);
    defer fixture.allocator.free(hash);
    const tx = try relayer.formatAddressAlloc(fixture.allocator, [_]u8{8} ** 32);
    defer fixture.allocator.free(tx);
    const dispatch_json = try std.fmt.allocPrint(fixture.allocator, "{{\"destination_domain\":9,\"id\":\"7\",\"msg_body\":\"0x68656c6c6f\",\"msg_id\":\"{s}\",\"nonce\":\"0\",\"origin_block_hash\":\"{s}\",\"origin_block_height\":\"100\",\"origin_domain\":5,\"origin_mailbox\":\"{s}\",\"origin_tx_hash\":\"{s}\",\"recipient\":\"{s}\",\"sender\":\"{s}\",\"time_created\":\"now\"}}", .{ id_text, hash, mailbox, tx, recipient, sender });
    defer fixture.allocator.free(dispatch_json);
    var parsed = try std.json.parseFromSlice(std.json.Value, fixture.allocator, dispatch_json, .{});
    defer parsed.deinit();
    _ = try fixture.native_store.storeMessage(message(0, "hello"), 100, [_]u8{0} ** 32 ++ [_]u8{8} ** 32);
    try std.testing.expectEqual(relayer.SequenceResult.accepted, try relayer.acceptDispatchJson(&fixture.controller.?, domain, generation, .{ .sequence = "0" }, parsed.value));
    try fixture.controller.?.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, -1);
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 0));

    const paymaster = try relayer.formatAddressAlloc(fixture.allocator, contracts.interchain_gas_paymaster);
    defer fixture.allocator.free(paymaster);
    const gas_json = try std.fmt.allocPrint(fixture.allocator, "{{\"destination\":9,\"domain\":5,\"gas_amount\":\"50\",\"id\":\"1\",\"interchain_gas_paymaster\":\"{s}\",\"log_index\":\"0\",\"msg_id\":\"{s}\",\"origin\":5,\"origin_block_hash\":\"{s}\",\"origin_block_height\":\"100\",\"origin_tx_hash\":\"{s}\",\"payment\":\"100\",\"sequence\":\"0\",\"time_created\":\"now\",\"tx_id\":null}}", .{ paymaster, "0x07070707070707070707070707070707" ++ "07070707070707070707070707070707", hash, tx });
    defer fixture.allocator.free(gas_json);
    var gas_parsed = try std.json.parseFromSlice(std.json.Value, fixture.allocator, gas_json, .{});
    defer gas_parsed.deinit();
    const envelope = relayer.Envelope{ .row_id = "1", .stream_cursor = "1", .legacy_max_stream_cursor = "0" };
    try std.testing.expectEqual(relayer.GasEventResult.accepted, try relayer.acceptGasPaymentJson(&fixture.controller.?, domain, generation, envelope, gas_parsed.value));
    const decoded = try relayer.decodeGasPayment(fixture.allocator, domain, contracts.interchain_gas_paymaster, envelope, gas_parsed.value);
    var reordered = try std.json.parseFromSlice(std.json.Value, fixture.allocator, "{\"tx_id\":null,\"time_created\":\"now\",\"sequence\":\"0\",\"payment\":\"100\",\"origin_tx_hash\":\"0x08080808080808080808080808080808" ++ "08080808080808080808080808080808\",\"origin_block_height\":\"100\",\"origin_block_hash\":\"0x09090909090909090909090909090909" ++ "09090909090909090909090909090909\",\"origin\":5,\"msg_id\":\"0x07070707070707070707070707070707" ++ "07070707070707070707070707070707\",\"log_index\":\"0\",\"interchain_gas_paymaster\":\"0x0000000000000000000000000000000000000002\",\"id\":\"1\",\"gas_amount\":\"50\",\"domain\":5,\"destination\":9}", .{});
    defer reordered.deinit();
    const other = try relayer.decodeGasPayment(fixture.allocator, domain, contracts.interchain_gas_paymaster, envelope, reordered.value);
    try std.testing.expectEqual(decoded.input.cursor.fingerprint, other.input.cursor.fingerprint);
    const key = codec.GasPaymentKey{ .message_id = [_]u8{7} ** 32, .destination = destination };
    try std.testing.expectEqual(@as(u256, 100), (try fixture.native_store.payment(key)).?.payment);

    const full_tx = try relayer.parseTransaction(fixture.allocator, "0xabababababababababababababababab" ++ "abababababababababababababababab" ++ "abababababababababababababababab" ++ "abababababababababababababababab");
    try std.testing.expectEqualSlices(u8, &([_]u8{0xab} ** 64), &full_tx);
    const full_address = try relayer.parseAddress(fixture.allocator, "0xabababababababababababababababab" ++ "abababababababababababababababab");
    try std.testing.expectEqualSlices(u8, &([_]u8{0xab} ** 32), &full_address);
}

test "deterministic bounded event sequence duplicates reconnect and late parity preserve integrity" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.connection();
    try fixture.controller.?.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, -1);
    const count = 128;
    for (0..count) |index| {
        const nonce: u32 = @intCast(index);
        try seedDispatch(fixture, nonce, "canonical");
    }
    for (0..count) |index| {
        const nonce: u32 = @intCast(index);
        const input = dispatch(nonce, "canonical");
        const print = fingerprint("dispatch", nonce);
        try std.testing.expectEqual(relayer.SequenceResult.accepted, try fixture.controller.?.acceptDispatch(domain, generation, input, print));
        try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, generation, index));
        if (index % 7 == 0) {
            try std.testing.expectEqual(relayer.SequenceResult.duplicate, try fixture.controller.?.acceptDispatch(domain, generation, input, print));
            try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, generation, index));
        }
    }
    try std.testing.expectEqual(@as(usize, 0), fixture.controller.?.total_pending);
    try std.testing.expectEqual(@as(?u32, count - 1), try fixture.adapter.cursor(.dispatch));
    const resumed = try fixture.controller.?.beginConnection(domain);
    try std.testing.expectEqual(relayer.ParityStep.stale_generation, try fixture.controller.?.processParityNext(domain, .dispatch, generation, count + 1));
    try fixture.controller.?.markReady(domain, resumed, 3);
    try fixture.controller.?.markSubscribed(domain, resumed);
    try fixture.controller.?.acceptCaughtUp(domain, resumed, .dispatch, contracts.mailbox, count - 1);
    const last = dispatch(count - 1, "canonical");
    _ = try fixture.controller.?.acceptDispatch(domain, resumed, last, fingerprint("dispatch", count - 1));
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, resumed, count + 2));
    try std.testing.expectEqual(@as(?u32, count - 1), try fixture.adapter.cursor(.dispatch));
}

test "late probe snapshot cannot activate until current cursors are canonically fresh" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.connection();
    try fixture.emptyCaughtUp(generation);
    const first = (try fixture.controller.?.probePlan(domain, 0)).?;
    try seedDispatch(fixture, 0, "new");
    _ = try fixture.controller.?.acceptDispatch(domain, generation, dispatch(0, "new"), fingerprint("dispatch", 0));
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 0));
    try fixture.controller.?.applyProbe(first, .{ .dispatch = 0, .merkle_tree_insertion = 0 }, 1);
    try std.testing.expectError(error.AuthorityNotReady, fixture.controller.?.beginCutover(domain, generation));
    const second = (try fixture.controller.?.probePlan(domain, 2)).?;
    try fixture.controller.?.applyProbe(second, .{ .dispatch = 1, .merkle_tree_insertion = 0 }, 2);
    const command = try fixture.controller.?.beginCutover(domain, generation);
    try fixture.controller.?.markPaused(domain, command.generation);
    try fixture.controller.?.completeCutover(domain, generation, command.generation);
}

test "consecutive ahead and failed probes revoke only after their specified grace" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    _ = try fixture.activate();
    try fixture.adapter.storeCursor(.dispatch, 0);
    const plan = (try fixture.controller.?.probePlan(domain, 0)).?;
    try fixture.controller.?.applyProbe(plan, .{ .dispatch = 0, .merkle_tree_insertion = 0 }, 1);
    try std.testing.expect(!try fixture.controller.?.rpcRequired(domain));
    try fixture.controller.?.applyProbe(plan, .{ .dispatch = 0, .merkle_tree_insertion = 0 }, 2);
    try std.testing.expect(try fixture.controller.?.rpcRequired(domain));

    const resumed = try fixture.connection();
    try fixture.controller.?.acceptCaughtUp(domain, resumed, .dispatch, contracts.mailbox, 0);
    try fixture.controller.?.acceptCaughtUp(domain, resumed, .merkle_tree_insertion, contracts.merkle_tree_hook, -1);
    try seedDispatch(fixture, 0, "zero");
    _ = try fixture.controller.?.acceptDispatch(domain, resumed, dispatch(0, "zero"), fingerprint("dispatch", 0));
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, resumed, 0));
    const fresh = (try fixture.controller.?.probePlan(domain, 0)).?;
    try fixture.controller.?.applyProbe(fresh, .{ .dispatch = 1, .merkle_tree_insertion = 0 }, 0);
    const command = try fixture.controller.?.beginCutover(domain, resumed);
    try fixture.controller.?.markPaused(domain, command.generation);
    try fixture.controller.?.completeCutover(domain, resumed, command.generation);
    try fixture.controller.?.applyProbe(.{ .domain = domain, .generation = resumed, .dispatch_cursor = null, .merkle_cursor = null }, null, 0);
    try std.testing.expect(!try fixture.controller.?.rpcRequired(domain));
    try fixture.controller.?.applyProbe(.{ .domain = domain, .generation = resumed, .dispatch_cursor = null, .merkle_cursor = null }, null, 101);
    try std.testing.expect(try fixture.controller.?.rpcRequired(domain));
}

test "stream gap immediately restores RPC and cannot write past the gap" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.activate();
    _ = try fixture.controller.?.acceptDispatch(domain, generation, dispatch(0, "zero"), fingerprint("dispatch", 0));
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .dispatch, generation, 0));
    try std.testing.expectError(error.StreamGap, fixture.controller.?.acceptDispatch(domain, generation, dispatch(2, "two"), fingerprint("dispatch", 2)));
    try std.testing.expect(try fixture.controller.?.rpcRequired(domain));
    try std.testing.expectEqual(@as(?u32, 0), try fixture.adapter.cursor(.dispatch));
    try std.testing.expect((try fixture.native_store.messageByNonce(2)) == null);
}

test "ready v3 negotiation and caught-up envelope fields gate gas authority" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.controller.?.beginConnection(domain);
    try std.testing.expectError(error.SubscribedBeforeReady, fixture.controller.?.markSubscribed(domain, generation));
    try fixture.controller.?.markReady(domain, generation, null);
    try fixture.controller.?.markSubscribed(domain, generation);
    try std.testing.expectError(error.GasCursorUnsupported, fixture.controller.?.acceptGasPayment(domain, generation, gas(1, null)));
    try std.testing.expect(!try fixture.controller.?.gasAuthority(domain));
    const resumed = try fixture.controller.?.beginConnection(domain);
    try fixture.controller.?.markReady(domain, resumed, 3);
    try fixture.controller.?.markSubscribed(domain, resumed);
    try std.testing.expectError(error.UnexpectedSequencedCursor, relayer.acceptCaughtUpJson(&fixture.controller.?, domain, resumed, .dispatch, .{
        .address = "0x0000000000000000000000000000000000000001",
        .domain = domain,
        .event_type = "dispatch",
        .stream_cursor = "0",
        .sequence = "-1",
    }));
    try std.testing.expectError(error.UnexpectedGasCaughtUpCursor, relayer.acceptGasCaughtUpJson(&fixture.controller.?, domain, resumed, .{
        .address = "0x0000000000000000000000000000000000000002",
        .domain = domain,
        .event_type = "gas_payment",
        .legacy_max_stream_cursor = "0",
        .row_id = "1",
        .stream_cursor = "0",
    }));
    try std.testing.expectEqual(relayer.GasEventResult.accepted, relayer.acceptGasCaughtUpJson(&fixture.controller.?, domain, resumed, .{
        .address = "0x0000000000000000000000000000000000000002",
        .domain = domain,
        .event_type = "gas_payment",
        .legacy_max_stream_cursor = "0",
        .stream_cursor = "0",
    }));
}

test "merkle JSON acceptance matches canonical insertion and advances exact cursor" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try fixture.start(true);
    const generation = try fixture.connection();
    try seedMerkle(fixture, 0);
    var parsed = try std.json.parseFromSlice(std.json.Value, fixture.allocator, "{\"block_number\":100,\"domain\":5,\"leaf_index\":0,\"merkle_tree_hook\":\"0x0000000000000000000000000000000000000003\",\"message_id\":\"0x01010101010101010101010101010101" ++ "01010101010101010101010101010101\"}", .{});
    defer parsed.deinit();
    try std.testing.expectEqual(relayer.SequenceResult.accepted, relayer.acceptMerkleJson(&fixture.controller.?, domain, generation, .{ .sequence = "0" }, parsed.value));
    try fixture.controller.?.acceptCaughtUp(domain, generation, .merkle_tree_insertion, contracts.merkle_tree_hook, -1);
    try std.testing.expectEqual(relayer.ParityStep.matched, try fixture.controller.?.processParityNext(domain, .merkle_tree_insertion, generation, 0));
    try std.testing.expectEqual(@as(?u32, 0), try fixture.adapter.cursor(.merkle_tree_insertion));
}

fn invalidFreshBaselineOwnership(allocator: A, adapter: *stream_store.Adapter) !void {
    var controller = try relayer.Controller.init(allocator, &.{.{ .domain = domain, .adapter = adapter }}, options(true));
    defer controller.deinit();
    const generation = try controller.beginConnection(domain);
    try controller.markReady(domain, generation, null);
    try controller.markSubscribed(domain, generation);
    try controller.acceptCaughtUp(domain, generation, .dispatch, contracts.mailbox, -1);
    const input: relayer.DispatchInput = .{
        .block_number = 1,
        .message = .{ .version = 3, .nonce = 1, .origin = domain, .destination = destination, .body = "public fixture" },
        .transaction_id = .{0} ** 64,
    };
    var rejected = false;
    _ = controller.acceptDispatch(domain, generation, input, .{4} ** 32) catch |err| switch (err) {
        error.InvalidFreshStreamBaseline => invalid: {
            rejected = true;
            break :invalid relayer.SequenceResult.accepted;
        },
        else => return err,
    };
    try std.testing.expect(rejected);
    try std.testing.expectEqual(@as(usize, 1), controller.total_pending);
    try std.testing.expectEqual(input.message.body.len, controller.total_body_bytes);
    try std.testing.expect(!(try controller.command(domain)).desired);
    // Reconnect drains the quarantined event. Later Controller.deinit must not
    // free its body a second time, including every earlier OOM boundary.
    _ = try controller.beginConnection(domain);
    try std.testing.expectEqual(@as(usize, 0), controller.total_pending);
    try std.testing.expectEqual(@as(usize, 0), controller.total_body_bytes);
    try std.testing.expect((try adapter.store.messageByNonce(1)) == null);
    try std.testing.expect((try adapter.cursor(.dispatch)) == null);
}

test "invalid fresh baseline after append transfers body ownership through cleanup and every allocation failure" {
    const fixture = try Fixture.create();
    defer fixture.deinit();
    try std.testing.checkAllAllocationFailures(std.testing.allocator, invalidFreshBaselineOwnership, .{&fixture.adapter});
}
