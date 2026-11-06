//! Actual native multi-call signing against a deterministic public RPC fixture.
const std = @import("std");
const backend = @import("starknet.zig");
const types = @import("types.zig");
const tx = @import("../../starknet/transaction.zig");
const codec = @import("../../starknet/codec.zig");
const crypto = @import("../../starknet/crypto.zig");
const provider = @import("../../starknet/provider.zig");
const rpc = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
const protocol = @import("../../protocol/root.zig");
const Felt = codec.Felt;
const A = std.mem.Allocator;
pub const Network = struct {
    encoding: tx.Encoding,
    expected_calls: usize = 2,
    next_nonce: Felt = .{ .value = 5 },
    requests: usize = 0,
    nonce_reads: usize = 0,
    estimates: usize = 0,
    broadcasts: usize = 0,
    expected_signed: ?[]const u8 = null,
    hash: Felt = Felt.zero,
    fail_request: ?usize = null,
    failure: anyerror = error.PendingReadIo,
    pub fn send(context: *anyopaque, a: A, request: http.Request) !http.Response {
        const self: *Network = @ptrCast(@alignCast(context));
        self.requests += 1;
        if (self.fail_request == self.requests) return self.failure;
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request.body.?, .{});
        defer parsed.deinit();
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        const params = try rpc.field(parsed.value, "params");
        const id = try rpc.integer(i64, try rpc.field(parsed.value, "id"));
        var buffer: [66]u8 = undefined;
        const result: []const u8 = if (std.mem.eql(u8, method, "starknet_chainId")) "\"0x1\"" else if (std.mem.eql(u8, method, "starknet_getNonce")) {
            self.nonce_reads += 1;
            const bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = self.next_nonce }, .{});
            return .{ .allocator = a, .bytes = bytes, .status = 200 };
        } else if (std.mem.eql(u8, method, "starknet_estimateFee")) blk: {
            self.estimates += 1;
            const request_tx = (try rpc.field(params, "request")).array.items[0];
            try std.testing.expectEqual((@as(u256, 1) << 128) + 3, (try provider.felt(try rpc.field(request_tx, "version"))).value);
            try std.testing.expectEqual(@as(usize, 2), (try rpc.field(request_tx, "signature")).array.items.len);
            const raw = try provider.feltArray(a, try rpc.field(request_tx, "calldata"), 32768);
            defer a.free(raw);
            const calls = try tx.decodeCalls(a, raw, self.encoding, self.expected_calls);
            defer a.free(calls);
            try std.testing.expectEqual(self.expected_calls, calls.len);
            break :blk "[{\"l1_gas_consumed\":\"0x2\",\"l1_gas_price\":\"0x2\",\"l2_gas_consumed\":\"0xa\",\"l2_gas_price\":\"0x2\",\"l1_data_gas_consumed\":\"0x0\",\"l1_data_gas_price\":\"0x0\",\"overall_fee\":\"0x18\",\"unit\":\"FRI\"}]";
        } else if (std.mem.eql(u8, method, "starknet_getBlockWithTxs")) "{\"status\":\"ACCEPTED_ON_L2\",\"block_number\":9,\"block_hash\":\"0x9\",\"parent_hash\":\"0x8\",\"timestamp\":1,\"transactions\":[{\"type\":\"INVOKE\",\"version\":\"0x3\",\"tip\":\"0x1\"}]}" else if (std.mem.eql(u8, method, "starknet_addInvokeTransaction")) {
            const wire = try std.json.Stringify.valueAlloc(a, try rpc.field(params, "invoke_transaction"), .{});
            defer a.free(wire);
            try std.testing.expectEqualStrings(self.expected_signed orelse return error.UnexpectedBroadcast, wire);
            self.broadcasts += 1;
            const hash = try std.fmt.bufPrint(&buffer, "0x{x}", .{self.hash.value});
            const bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .transaction_hash = hash } }, .{});
            return .{ .allocator = a, .bytes = bytes, .status = 200 };
        } else if (std.mem.eql(u8, method, "starknet_getTransactionReceipt")) {
            const bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .type = "INVOKE", .transaction_hash = self.hash, .block_number = @as(u64, 9), .block_hash = "0x9", .finality_status = "ACCEPTED_ON_L2", .execution_status = "SUCCEEDED", .actual_fee = .{ .amount = "0x65", .unit = "FRI" } } }, .{});
            return .{ .allocator = a, .bytes = bytes, .status = 200 };
        } else if (std.mem.eql(u8, method, "starknet_getBlockWithTxHashes")) "{\"status\":\"ACCEPTED_ON_L2\",\"block_number\":9,\"block_hash\":\"0x9\",\"parent_hash\":\"0x8\",\"timestamp\":1}" else if (std.mem.eql(u8, method, "starknet_blockNumber")) "10" else return error.UnexpectedBatchMethod;
        const bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, result });
        return .{ .allocator = a, .bytes = bytes, .status = 200 };
    }
};
const Journal = struct {
    intents: usize = 0,
    signatures: usize = 0,
    fail_intent: bool = false,
    fail_signed: bool = false,
    fn intent(context: *anyopaque, _: types.Hash, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        if (self.fail_intent) return error.FixturePersistenceFailed;
        self.intents += 1;
    }
    fn signed(context: *anyopaque, _: types.Hash, _: types.Identity, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        if (self.fail_signed) return error.FixturePersistenceFailed;
        try std.testing.expect(self.intents != 0);
        self.signatures += 1;
    }
    fn interface(self: *Journal) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed };
    }
};
pub const CountSigner = struct {
    actual: tx.Signer,
    count: usize = 0,
    fn sign(context: *anyopaque, hash: Felt) !crypto.Signature {
        const self: *CountSigner = @ptrCast(@alignCast(context));
        self.count += 1;
        return self.actual.sign_fn(self.actual.context, hash);
    }
    pub fn interface(self: *CountSigner) tx.Signer {
        return .{ .context = self, .public_key = self.actual.public_key, .sign_fn = sign };
    }
};
pub fn scalar(a: A, destination: *backend.Starknet, index: u32, weight: u64) !types.Prepared {
    const message: protocol.Message = .{ .origin = 100 + index, .destination = 200, .nonce = index, .body = "batch-message" };
    const authority: types.Authority = .{ .protocol = .starknet, .origin = message.origin, .destination = 200, .mailbox = destination.chain.mailbox.toBytes(), .chain_id = "0x1", .operation_id = message.id(), .generation = index, .origin_hook = .{3} ** 32 };
    var call = try destination.chain.process(message, "public-metadata");
    defer call.deinit();
    var transaction = try tx.Transaction.init(a, destination.chain_id, destination.account, Felt.zero, .{ .l2_gas = .{ .max_amount = weight, .max_price_per_unit = 2 } }, &.{call.call}, destination.encoding);
    defer transaction.deinit();
    const body = try std.json.Stringify.valueAlloc(a, .{ .transaction = transaction.request(&.{}, false), .public_key = destination.signer.public_key, .gas_limit = weight, .estimated_cost = weight * 2 }, .{});
    defer a.free(body);
    return types.Prepared.init(a, authority, body, weight, weight * 2);
}
pub fn nativePath(a: A) ![]u8 {
    return std.process.getEnvVarOwned(a, "HYPERLANE_STARKNET_CRYPTO_LIBRARY") catch error.SkipZigTest;
}
test "Starknet batch actual V3 one nonce quote sign broadcast canonical receipt and exact recovery both encodings" {
    const a = std.testing.allocator;
    const path = try nativePath(a);
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = .{0} ** 31 ++ .{17} };
    defer local.deinit();
    for ([_]tx.Encoding{ .legacy, .modern }) |encoding| {
        var signer: CountSigner = .{ .actual = try local.interface() };
        var network: Network = .{ .encoding = encoding };
        var client: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
        var destination: backend.Starknet = .{ .chain = .{ .provider = &client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &native, .signer = signer.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = encoding, .maximum_fee = 1000 };
        var first = try scalar(a, &destination, 0, 1);
        defer first.deinit();
        var second = try scalar(a, &destination, 1, 3);
        defer second.deinit();
        var group = try destination.prepareBatch(&.{ &first, &second }, 2);
        defer group.deinit();
        try destination.validateBatch(group.members);
        try std.testing.expectEqual(@as(usize, 4), network.requests);
        try std.testing.expectEqual(@as(usize, 1), signer.count);
        try std.testing.expectEqual(@as(usize, 1), network.nonce_reads);
        try std.testing.expectEqual(@as(usize, 1), network.estimates);
        try std.testing.expectEqual(@as(u256, 10), group.gas_limit);
        try std.testing.expectEqual(@as(u256, 55), group.estimated_cost);
        try std.testing.expectEqual(@as(?u256, 1), group.members[0].gas_limit);
        try std.testing.expectEqual(@as(?u256, 3), group.members[1].gas_limit);
        var journal: Journal = .{ .fail_intent = true };
        try std.testing.expectError(error.FixturePersistenceFailed, destination.sign(&group.members[0], journal.interface()));
        try std.testing.expectEqual(@as(usize, 1), signer.count);
        journal.fail_intent = false;
        var signed = try destination.sign(&group.members[0], journal.interface());
        defer signed.deinit();
        try std.testing.expectEqual(@as(usize, 2), signer.count);
        network.hash = try Felt.fromBytes(signed.identity.hash256);
        network.expected_signed = signed.bytes;
        journal.fail_signed = true;
        try std.testing.expectError(error.FixturePersistenceFailed, destination.broadcast(&group.members[0], &signed, journal.interface()));
        try std.testing.expectEqual(@as(usize, 0), network.broadcasts);
        journal.fail_signed = false;
        // Restart from each exact public intent and the single persisted Signed.
        var recovered = [_]types.Prepared{ try types.Prepared.restore(a, group.members[0].canonical_intent), try types.Prepared.restore(a, group.members[1].canonical_intent) };
        defer for (&recovered) |*member| member.deinit();
        try destination.validateBatch(&recovered);
        try destination.broadcast(&recovered[1], &signed, journal.interface());
        try std.testing.expectEqual(@as(usize, 1), network.broadcasts);
        try std.testing.expectEqual(@as(usize, 2), signer.count);
        try std.testing.expectEqual(@as(usize, 1), network.nonce_reads);
        const receipt = (try destination.reconcile(signed.identity)).?;
        try std.testing.expect(receipt.finalized and receipt.success);
        const one = try destination.memberReceipt(&recovered[0], receipt);
        const two = try destination.memberReceipt(&recovered[1], receipt);
        try std.testing.expectEqual(@as(u256, 25), one.expenditure.?.tokens_used);
        try std.testing.expectEqual(@as(u256, 75), two.expenditure.?.tokens_used);
        try std.testing.expectEqual(one.identity, two.identity);
        try std.testing.expectEqual(one.block_hash, two.block_hash);
        var reordered = [_]types.Prepared{ recovered[1], recovered[0] };
        try std.testing.expectError(error.DestinationIntentChanged, destination.validateBatch(&reordered));
        try std.testing.expectError(error.StarknetBatchSize, destination.validateBatch(recovered[0..1]));
    }
}

const Mutation = enum { member_id, member_origin, member_generation, weight, cost, own_weight, own_cost, total_weight, manifest_order, call_id, target, nonce, total_cost, duplicate, public_key };
fn altered(a: A, original: *const types.Prepared, mutation: Mutation) !types.Prepared {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const scratch = arena.allocator();
    const raw = try std.json.Stringify.valueAlloc(scratch, original.body, .{});
    var value = (try std.json.parseFromSlice(rpc.Value, scratch, raw, .{})).value;
    const members = value.object.getPtr("batch_members").?;
    const own_id = std.fmt.bytesToHex(original.authority.operation_id, .lower);
    const selected: usize = if (std.mem.eql(u8, try rpc.string(try rpc.field(members.array.items[0], "operation_id")), &own_id)) 0 else 1;
    const member = &members.array.items[selected];
    switch (mutation) {
        .member_id => member.object.getPtr("operation_id").?.* = .{ .string = "00000000000000000000000000000000" ++ "00000000000000000000000000000000" },
        .member_origin => member.object.getPtr("origin").?.* = .{ .integer = 999 },
        .member_generation => member.object.getPtr("generation").?.* = .{ .integer = 999 },
        .weight => member.object.getPtr("gas_limit").?.* = .{ .integer = 999 },
        .cost => member.object.getPtr("estimated_cost").?.* = .{ .integer = 999 },
        .own_weight => value.object.getPtr("gas_limit").?.* = .{ .integer = 999 },
        .own_cost => value.object.getPtr("estimated_cost").?.* = .{ .integer = 999 },
        .total_weight => value.object.getPtr("batch_gas_limit").?.* = .{ .integer = 999 },
        .manifest_order => std.mem.swap(rpc.Value, &members.array.items[0], &members.array.items[1]),
        .duplicate => members.array.items[1 - selected] = member.*,
        .total_cost => value.object.getPtr("batch_estimated_cost").?.* = .{ .integer = 999 },
        .public_key => value.object.getPtr("public_key").?.* = .{ .string = "0x1" },
        .nonce => value.object.getPtr("transaction").?.object.getPtr("nonce").?.* = .{ .string = "0x6" },
        .target, .call_id => {
            const calldata = value.object.getPtr("transaction").?.object.getPtr("calldata").?;
            const encoded = try provider.feltArray(scratch, calldata.*, 32768);
            // Modern first call header = count,to,selector,len. Metadata has2
            // header felts + ceil(len/16) words. Change decoded message nonce.
            const index: usize = if (mutation == .target) 1 else 4 + 3 + 1;
            encoded[index] = try Felt.init(999);
            const serialized = try std.json.Stringify.valueAlloc(scratch, encoded, .{});
            calldata.* = (try std.json.parseFromSlice(rpc.Value, scratch, serialized, .{})).value;
        },
    }
    const body = try std.json.Stringify.valueAlloc(scratch, value, .{});
    return types.Prepared.init(a, original.authority, body, null, null);
}
test "Starknet batch rejects incomplete altered authority calldata manifest nonce signature and persistence before broadcast" {
    const a = std.testing.allocator;
    const path = try nativePath(a);
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = .{0} ** 31 ++ .{17} };
    defer local.deinit();
    var signer: CountSigner = .{ .actual = try local.interface() };
    var network: Network = .{ .encoding = .modern };
    var client: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
    var destination: backend.Starknet = .{ .chain = .{ .provider = &client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &native, .signer = signer.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .maximum_fee = 1000 };
    var first = try scalar(a, &destination, 0, 1);
    defer first.deinit();
    var second = try scalar(a, &destination, 1, 3);
    defer second.deinit();
    try std.testing.expectError(error.StarknetBatchSize, destination.prepareBatch(&.{&first}, 2));
    try std.testing.expectError(error.StarknetBatchSize, destination.prepareBatch(&.{ &first, &second }, 1));
    try std.testing.expectError(error.StarknetBatchDuplicateMember, destination.prepareBatch(&.{ &first, &first }, 2));
    client.max_call_felts = 20;
    try std.testing.expectError(error.StarknetCallTooLarge, destination.prepareBatch(&.{ &first, &second }, 2));
    client.max_call_felts = 32768;
    try std.testing.expectEqual(@as(usize, 0), network.requests);
    try std.testing.expectEqual(@as(usize, 0), signer.count);
    var group = try destination.prepareBatch(&.{ &first, &second }, 2);
    defer group.deinit();
    var journal: Journal = .{};
    var signed = try destination.sign(&group.members[0], journal.interface());
    defer signed.deinit();
    network.expected_signed = signed.bytes;
    network.hash = try Felt.fromBytes(signed.identity.hash256);
    for (group.members) |*original| for (std.enums.values(Mutation)) |mutation| {
        var changed = try altered(a, original, mutation);
        defer changed.deinit();
        try changed.validate(); // Canonical bytes alone do not prove membership.
        if (destination.broadcast(&changed, &signed, journal.interface())) |_| return error.AcceptedAlteredBatch else |err| try std.testing.expect(err != error.FixturePersistenceFailed);
    };
    try std.testing.expectEqual(@as(usize, 0), network.broadcasts);
    // Advisory in-memory quote fields also cannot override the frozen manifest.
    const original_weight = group.members[0].gas_limit;
    group.members[0].gas_limit = 999;
    try std.testing.expectError(error.DestinationIntentChanged, destination.sign(&group.members[0], journal.interface()));
    group.members[0].gas_limit = original_weight;
    var wrong_receipt: types.Receipt = .{ .identity = signed.identity, .block_hash = .{1} ** 32, .height = 9, .success = true, .finalized = true };
    wrong_receipt.identity.hash256[31] ^= 1;
    try std.testing.expectError(error.DestinationIntentChanged, destination.memberReceipt(&group.members[0], wrong_receipt));
    wrong_receipt.identity = .{ .signature512 = .{0} ** 64 };
    try std.testing.expectError(error.DestinationIntentChanged, destination.memberReceipt(&group.members[0], wrong_receipt));
    var wrong_hash = signed;
    wrong_hash.identity.hash256[31] ^= 1;
    try std.testing.expectError(error.DestinationIntentChanged, destination.broadcast(&group.members[0], &wrong_hash, journal.interface()));
    var altered_signature = try types.Signed.init(a, signed.identity, signed.bytes);
    defer altered_signature.deinit();
    // Modify a hex signature digit while retaining valid JSON.
    const offset = std.mem.indexOf(u8, altered_signature.bytes, "\"signature\":[\"0x").? + "\"signature\":[\"0x".len;
    altered_signature.bytes[offset] = if (altered_signature.bytes[offset] == '1') '2' else '1';
    if (destination.broadcast(&group.members[0], &altered_signature, journal.interface())) |_| return error.AcceptedAlteredSignature else |_| {}
    try std.testing.expectEqual(@as(usize, 0), network.broadcasts);
    try std.testing.expectEqual(@as(usize, 4), network.requests);
    try std.testing.expectError(error.StarknetBatchIneligible, destination.prepareBatch(&.{ &group.members[0], &second }, 2));
    try std.testing.expectError(error.StarknetBatchIneligible, destination.refreshPrepared(&group.members[0]));
}

test "Starknet batch zero total is ineligible before query mixed zero has record present zero share and refresh is unsigned only" {
    const a = std.testing.allocator;
    const path = try nativePath(a);
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = .{0} ** 31 ++ .{17} };
    defer local.deinit();
    var signer: CountSigner = .{ .actual = try local.interface() };
    var network: Network = .{ .encoding = .modern };
    var client: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
    var destination: backend.Starknet = .{ .chain = .{ .provider = &client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &native, .signer = signer.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .maximum_fee = 1000 };
    var zero1 = try scalar(a, &destination, 0, 0);
    defer zero1.deinit();
    var zero2 = try scalar(a, &destination, 1, 0);
    defer zero2.deinit();
    var positive = try scalar(a, &destination, 2, 3);
    defer positive.deinit();
    try std.testing.expectError(error.StarknetBatchZeroWeight, destination.prepareBatch(&.{ &zero1, &zero2 }, 2));
    try std.testing.expectEqual(@as(usize, 0), network.requests);
    try std.testing.expectEqual(@as(usize, 0), signer.count);
    var group = try destination.prepareBatch(&.{ &zero1, &positive }, 2);
    defer group.deinit();
    var journal: Journal = .{};
    var signed = try destination.sign(&group.members[0], journal.interface());
    defer signed.deinit();
    const whole: types.Receipt = .{ .identity = signed.identity, .block_hash = .{1} ** 32, .height = 9, .success = false, .finalized = true, .expenditure = .{ .gas_used = std.math.maxInt(u256), .tokens_used = std.math.maxInt(u256) } };
    const zero_share = try destination.memberReceipt(&group.members[0], whole);
    const positive_share = try destination.memberReceipt(&group.members[1], whole);
    try std.testing.expect(zero_share.expenditure != null);
    try std.testing.expectEqual(@as(u256, 0), zero_share.expenditure.?.tokens_used);
    try std.testing.expectEqual(std.math.maxInt(u256), positive_share.expenditure.?.tokens_used);
    try std.testing.expect(!positive_share.success and positive_share.finalized);
    var pending = whole;
    pending.finalized = false;
    pending.expenditure = null;
    try std.testing.expect((try destination.memberReceipt(&group.members[0], pending)).expenditure == null);
    network.expected_calls = 1;
    network.next_nonce = try Felt.init(6);
    const sign_count = signer.count;
    var refreshed = try destination.refreshPrepared(&zero1);
    defer refreshed.deinit();
    try std.testing.expectEqual(zero1.authority.operation_id, refreshed.authority.operation_id);
    try std.testing.expectEqual(zero1.authority.generation, refreshed.authority.generation);
    try std.testing.expect(!std.mem.eql(u8, &zero1.digest(), &refreshed.digest()));
    try std.testing.expectEqual(@as(u256, 6), (try provider.felt(try rpc.field(try rpc.field(refreshed.body, "transaction"), "nonce"))).value);
    try std.testing.expectEqual(@as(?u256, 10), refreshed.gas_limit);
    try std.testing.expectEqual(sign_count + 1, signer.count); // QUERY only.
    try std.testing.expectEqual(@as(usize, 0), network.broadcasts);
}

const Sweep = struct {
    destination: *backend.Starknet,
    first: *const types.Prepared,
    second: *const types.Prepared,
    network: *Network,
    whole: types.Receipt,
    runs: usize = 0,
};
fn allocationSweep(a: A, context: *Sweep) !void {
    context.runs += 1;
    const destination = context.destination;
    const allocator = destination.chain.provider.allocator;
    const client_allocator = destination.chain.provider.client.allocator;
    destination.chain.provider.allocator = a;
    destination.chain.provider.client.allocator = a;
    destination.chain.provider.client.next_id = 1;
    defer {
        destination.chain.provider.allocator = allocator;
        destination.chain.provider.client.allocator = client_allocator;
    }
    var group = try destination.prepareBatch(&.{ context.first, context.second }, 2);
    defer group.deinit();
    try destination.validateBatch(group.members);
    const receipt = try destination.memberReceipt(&group.members[0], context.whole);
    try std.testing.expectEqual(@as(u256, 25), receipt.expenditure.?.tokens_used);
    var restored = try types.Prepared.restore(a, group.members[1].canonical_intent);
    defer restored.deinit();
    const other = try destination.memberReceipt(&restored, context.whole);
    try std.testing.expectEqual(@as(u256, 75), other.expenditure.?.tokens_used);
}
test "Starknet batch every allocation failure unwinds partial intents decoded calldata and receipt validation" {
    const a = std.testing.allocator;
    const path = try nativePath(a);
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = .{0} ** 31 ++ .{17} };
    defer local.deinit();
    var network: Network = .{ .encoding = .modern };
    var client: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
    var destination: backend.Starknet = .{ .chain = .{ .provider = &client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &native, .signer = try local.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .maximum_fee = 1000 };
    var first = try scalar(a, &destination, 0, 1);
    defer first.deinit();
    var second = try scalar(a, &destination, 1, 3);
    defer second.deinit();
    var group = try destination.prepareBatch(&.{ &first, &second }, 2);
    defer group.deinit();
    var journal: Journal = .{};
    var signed = try destination.sign(&group.members[0], journal.interface());
    defer signed.deinit();
    var sweep: Sweep = .{ .destination = &destination, .first = &first, .second = &second, .network = &network, .whole = .{ .identity = signed.identity, .block_hash = .{1} ** 32, .height = 9, .success = true, .finalized = true, .expenditure = .{ .gas_used = 101, .tokens_used = 101 } } };
    try std.testing.checkAllAllocationFailures(a, allocationSweep, .{&sweep});
    try std.testing.expect(sweep.runs > 50);
    try std.testing.expectEqual(@as(usize, 0), network.broadcasts);
}

test "Starknet batch forwards every query cancellation deadline pending and allocation control without production signature" {
    const a = std.testing.allocator;
    const path = try nativePath(a);
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = .{0} ** 31 ++ .{17} };
    defer local.deinit();
    var signer: CountSigner = .{ .actual = try local.interface() };
    var network: Network = .{ .encoding = .modern };
    var client: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
    var destination: backend.Starknet = .{ .chain = .{ .provider = &client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &native, .signer = signer.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .maximum_fee = 1000 };
    var first = try scalar(a, &destination, 0, 1);
    defer first.deinit();
    var second = try scalar(a, &destination, 1, 3);
    defer second.deinit();
    for ([_]anyerror{ error.PendingReadIo, error.RequestCancelled, error.RequestDeadlineExceeded, error.OutOfMemory }) |err| {
        for (1..5) |step| {
            signer.count = 0;
            network.requests = 0;
            network.fail_request = step;
            network.failure = err;
            try std.testing.expectError(err, destination.prepareBatch(&.{ &first, &second }, 2));
            try std.testing.expectEqual(step, network.requests);
            try std.testing.expectEqual(@as(usize, if (step >= 3) 1 else 0), signer.count); // query version only
            try std.testing.expectEqual(@as(usize, 0), network.broadcasts);
        }
    }
}
