const std = @import("std");
const protocol = @import("protocol/root.zig");
const objects = @import("storage/objects.zig");
const quorum = @import("relayer/quorum.zig");
const metadata = @import("relayer/metadata.zig");
const evm = @import("evm/root.zig");
const special = @import("relayer/special/mod.zig");
const legacy = special.legacy;
const weighted = special.weighted;
const arb = special.arb;
const rpc_testing = @import("evm/pool_testing.zig");
const Curl = @import("net/curl.zig");

const allocator = std.testing.allocator;

fn addressLast(comptime value: u8) [20]u8 {
    var out: [20]u8 = @splat(0);
    out[19] = value;
    return out;
}

const legacy_signatures: [130]u8 = blk: {
    var out: [130]u8 = undefined;
    @memset(out[0..32], 0x21);
    @memset(out[32..64], 0x22);
    out[64] = 27;
    @memset(out[65..97], 0x31);
    @memset(out[97..129], 0x32);
    out[129] = 28;
    break :blk out;
};
const legacy_proof: [32][32]u8 = blk: {
    var out: [32][32]u8 = undefined;
    for (&out, 0..) |*hash, i| hash.* = @splat(@intCast(i));
    break :blk out;
};
const legacy_validators = [_][20]u8{ addressLast(6), addressLast(7) };
const legacy_fixture: legacy.Metadata = .{
    .checkpoint_root = @splat(0x11),
    .checkpoint_index = std.math.maxInt(u32),
    .origin_mailbox = @splat(0x05),
    .proof = legacy_proof,
    .signatures = &legacy_signatures,
    .validators = &legacy_validators,
};

fn messageFixture() protocol.Message {
    return .{ .version = 3, .nonce = 7, .origin = 1, .destination = 2, .sender = @splat(3), .recipient = @splat(4), .body = "special" };
}

fn expectHash(comptime first: []const u8, comptime second: []const u8, bytes: []const u8) !void {
    const expected = try evm.codecs.fixedHex(32, "0x" ++ first ++ second);
    var actual: [32]u8 = undefined;
    std.crypto.hash.sha3.Keccak256.hash(bytes, &actual, .{});
    try std.testing.expectEqual(expected, actual);
}

fn putWord(bytes: []u8, value: u256) void {
    std.mem.writeInt(u256, bytes[0..32], value, .big);
}

fn putAddress(bytes: []u8, address: [20]u8) void {
    @memset(bytes[0..32], 0);
    bytes[12..32].* = address;
}

fn weightedResponse(alloc: std.mem.Allocator) ![]u8 {
    const bytes = try alloc.alloc(u8, 224);
    @memset(bytes, 0);
    putWord(bytes[0..32], 64);
    putWord(bytes[32..64], 5_000_000_000);
    putWord(bytes[64..96], 2);
    putAddress(bytes[96..128], addressLast(1));
    putWord(bytes[128..160], 500_000_000);
    putAddress(bytes[160..192], addressLast(2));
    putWord(bytes[192..224], 8_000_000_000);
    return bytes;
}

test "Rust parity keeps every special module unsupported and rejects other types distinctly" {
    for ([_]metadata.ModuleType{ .legacy_multisig, .arb_l2_to_l1, .weighted_merkle_root_multisig, .weighted_message_id_multisig, .op_l2_to_l1, .polymer }) |module_type| {
        try std.testing.expectError(error.UnsupportedIsmType, special.specialMetadata(module_type));
    }
    for ([_]metadata.ModuleType{ .null_ism, .message_id_multisig, .merkle_root_multisig, .aggregation, .routing, .ccip_read }) |module_type| {
        try std.testing.expectError(error.NotSpecialIsmType, special.specialMetadata(module_type));
    }
}

test "legacy packed metadata matches Foundry SDK oracle at u32 and u8 boundaries" {
    const bytes = try legacy_fixture.encodeAlloc(allocator);
    defer allocator.free(bytes);
    try std.testing.expectEqual(@as(usize, 1287), bytes.len);
    try expectHash("85b3693d485c3cc8a0863a97d93bd5fc", "8079bb8a7068118cfbd835a7732cf5da", bytes);
    var decoded = try legacy.decode(allocator, bytes);
    defer decoded.deinit();
    try std.testing.expectEqualDeep(legacy_fixture, decoded.value);
    for (0..legacy.prefix_len) |length| try std.testing.expectError(error.TruncatedMetadata, legacy.decode(allocator, bytes[0..length]));
    try std.testing.expectError(error.InvalidValidatorsLength, legacy.decode(allocator, bytes[0 .. bytes.len - 1]));
    var invalid = try allocator.dupe(u8, bytes);
    defer allocator.free(invalid);
    invalid[legacy.prefix_len + legacy_signatures.len] = 1;
    try std.testing.expectError(error.InvalidAbi, legacy.decode(allocator, invalid));
}

test "legacy codec handles zero and 255 signatures and rejects 256" {
    var no_signatures = legacy_fixture;
    no_signatures.signatures = "";
    no_signatures.validators = &.{};
    const empty = try no_signatures.encodeAlloc(allocator);
    defer allocator.free(empty);
    try std.testing.expectEqual(@as(usize, legacy.prefix_len), empty.len);
    var empty_decoded = try legacy.decode(allocator, empty);
    defer empty_decoded.deinit();
    try std.testing.expectEqual(@as(usize, 0), empty_decoded.value.validators.len);

    const signatures = try allocator.alloc(u8, 255 * 65);
    defer allocator.free(signatures);
    @memset(signatures, 0x5a);
    var maximum = no_signatures;
    maximum.signatures = signatures;
    const encoded = try maximum.encodeAlloc(allocator);
    defer allocator.free(encoded);
    try std.testing.expectEqual(@as(usize, 255), encoded[1092]);
    var overflow = maximum;
    overflow.signatures = try allocator.alloc(u8, 256 * 65);
    defer allocator.free(overflow.signatures);
    try std.testing.expectError(error.InvalidThreshold, overflow.encodeAlloc(allocator));
}

test "Arb metadata matches Foundry ABI oracle and preserves empty dynamic values" {
    const proof = [_][32]u8{ @splat(0x11), @splat(0x22) };
    const fixture: arb.Metadata = .{
        .proof = &proof,
        .position = 40160,
        .caller = addressLast(3),
        .destination = addressLast(4),
        .arb_block_num = 54220000,
        .eth_block_num = 6098300,
        .timestamp = 1700000000,
        .callvalue = 0,
        .data = &([_]u8{0} ** 20),
    };
    const bytes = try fixture.encodeAlloc(allocator);
    defer allocator.free(bytes);
    try std.testing.expectEqual(@as(usize, 448), bytes.len);
    try expectHash("522e7401e7f05db25af648aa075cd817", "32f96829d53b1b43ffd44cf8da1d16f6", bytes);
    var decoded = try arb.decode(allocator, bytes);
    defer decoded.deinit();
    try std.testing.expectEqualDeep(fixture, decoded.value);
    var calldata = [_]u8{0} ** 68;
    calldata[4..36].* = @splat(1);
    try std.testing.expect(arb.containsMessageId(&calldata, @splat(1)));
    try std.testing.expect(!arb.containsMessageId(&calldata, @splat(2)));

    var empty = fixture;
    empty.proof = &.{};
    empty.data = "";
    empty.position = std.math.maxInt(u256);
    const empty_bytes = try empty.encodeAlloc(allocator);
    defer allocator.free(empty_bytes);
    var empty_decoded = try arb.decode(allocator, empty_bytes);
    defer empty_decoded.deinit();
    try std.testing.expectEqualDeep(empty, empty_decoded.value);
}

test "Arb decoder rejects malformed offsets lengths addresses and padding" {
    const proof = [_][32]u8{@splat(0x11)};
    const fixture: arb.Metadata = .{ .proof = &proof, .position = 1, .caller = addressLast(3), .destination = addressLast(4), .arb_block_num = 5, .eth_block_num = 6, .timestamp = 7, .callvalue = 8, .data = "abc" };
    const original = try fixture.encodeAlloc(allocator);
    defer allocator.free(original);
    for (0..arb.head_len) |length| try std.testing.expectError(error.InvalidArbMetadata, arb.decode(allocator, original[0..length]));
    var invalid = try allocator.dupe(u8, original);
    defer allocator.free(invalid);
    invalid[31] = 1;
    try std.testing.expectError(error.InvalidArbMetadata, arb.decode(allocator, invalid));
    @memset(invalid, 0);
    @memcpy(invalid, original);
    invalid[64] = 1;
    try std.testing.expectError(error.InvalidAbi, arb.decode(allocator, invalid));
    @memset(invalid, 0);
    @memcpy(invalid, original);
    invalid[invalid.len - 1] = 1;
    try std.testing.expectError(error.InvalidArbMetadata, arb.decode(allocator, invalid));
    try std.testing.expectError(error.InvalidArbMetadata, arb.decode(allocator, original[0 .. original.len - 32]));
}

test "weighted member ABI matches Cast oracle and rejects invalid thresholds weights and lengths" {
    const bytes = try weightedResponse(allocator);
    defer allocator.free(bytes);
    try expectHash("e278283ea0ebbfec293219c62e8af701", "84f50a97bf7f4f0d0d0a4b5492799a92", bytes);
    var members = try weighted.decodeMembers(allocator, bytes);
    defer members.deinit();
    try std.testing.expectEqual(@as(u96, 5_000_000_000), members.threshold_weight);
    try std.testing.expectEqual(@as(usize, 2), members.validators.len);
    try std.testing.expectEqual(addressLast(1), members.validators[0].address);
    try std.testing.expectEqual(@as(u96, 500_000_000), members.validators[0].weight);
    try std.testing.expectEqual(@as(u96, 8_000_000_000), members.validators[1].weight);

    var invalid = try allocator.dupe(u8, bytes);
    defer allocator.free(invalid);
    @memset(invalid[32..64], 0);
    try std.testing.expectError(error.InvalidThresholdWeight, weighted.decodeMembers(allocator, invalid));
    putWord(invalid[32..64], weighted.total_weight + 1);
    try std.testing.expectError(error.InvalidThresholdWeight, weighted.decodeMembers(allocator, invalid));
    @memcpy(invalid, bytes);
    invalid[96] = 1;
    try std.testing.expectError(error.InvalidAbi, weighted.decodeMembers(allocator, invalid));
    @memcpy(invalid, bytes);
    putWord(invalid[128..160], @as(u256, std.math.maxInt(u96)) + 1);
    try std.testing.expectError(error.IntegerOverflow, weighted.decodeMembers(allocator, invalid));
    try std.testing.expectError(error.InvalidMemberAbi, weighted.decodeMembers(allocator, bytes[0 .. bytes.len - 32]));
    try std.testing.expectError(error.InvalidMemberAbi, weighted.decodeMembers(allocator, bytes[0..95]));
    const calldata = try weighted.validatorsCall(allocator, messageFixture());
    defer allocator.free(calldata);
    try std.testing.expectEqual([4]u8{ 0xec, 0x29, 0xdb, 0xde }, calldata[0..4].*);
}

test "weighted verification follows Solidity high-index quorum trailing signature and overflow behavior" {
    const keys = [_][32]u8{ @splat(0x11), @splat(0x22), @splat(0x33), @splat(0x44), @splat(0x55) };
    var validators: [5]weighted.Validator = undefined;
    for (keys, &validators, 0..) |key, *validator, i| {
        validator.* = .{ .address = try protocol.signature.secretKeyAddress(key), .weight = if (i < 4) 500_000_000 else 8_000_000_000 };
    }
    const digest = [_]u8{0x22} ** 32;
    var signatures: [130]u8 = undefined;
    signatures[0..65].* = try protocol.signature.signDigest(keys[4], digest, null);
    signatures[65..130].* = try protocol.signature.signDigest(keys[0], digest, null);
    try weighted.verify(digest, &signatures, &validators, 5_000_000_000);
    try std.testing.expectError(error.InsufficientValidatorWeight, weighted.verify(digest, "", &validators, 5_000_000_000));
    var duplicate = signatures;
    duplicate[0..65].* = signatures[65..130].*;
    try std.testing.expectError(error.InvalidSigner, weighted.verify(digest, &duplicate, &validators, 600_000_000));
    try std.testing.expectError(error.InvalidSignaturesLength, weighted.verify(digest, signatures[0..64], &validators, 100));

    var overflow = [_]weighted.Validator{
        .{ .address = try protocol.signature.secretKeyAddress(keys[0]), .weight = 9_000_000_000 },
        .{ .address = try protocol.signature.secretKeyAddress(keys[1]), .weight = std.math.maxInt(u96) },
    };
    signatures[0..65].* = try protocol.signature.signDigest(keys[0], digest, null);
    signatures[65..130].* = try protocol.signature.signDigest(keys[1], digest, null);
    try std.testing.expectError(error.WeightOverflow, weighted.verify(digest, &signatures, &overflow, weighted.total_weight));
    overflow[0].weight = 0;
    try std.testing.expectError(error.InvalidThresholdWeight, weighted.verify(digest, &signatures, &overflow, weighted.total_weight + 1));
}

test "weighted checkpoint collector selects weight not count and detects poisoning and overflow" {
    const keys = [_][32]u8{ @splat(0x11), @splat(0x22), @splat(0x33), @splat(0x44), @splat(0x55) };
    var validators: [5]weighted.Validator = undefined;
    for (keys, &validators, 0..) |key, *validator, i| validator.* = .{ .address = try protocol.signature.secretKeyAddress(key), .weight = if (i < 4) 500_000_000 else 8_000_000_000 };
    const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = @splat(1), .mailbox_domain = 1, .root = @splat(2), .index = 3, .message_id = @splat(4) };
    var collector = try weighted.Collector.init(allocator, &validators, 5_000_000_000, 3);
    try std.testing.expect((try collector.push(.{ .validator_index = 0, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null) })) == null);
    var selected = (try collector.push(.{ .validator_index = 4, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[4], null) })).?;
    defer selected.deinit();
    try std.testing.expectEqual(@as(usize, 2), selected.signatures.len);
    try std.testing.expectEqual(validators[0].address, try selected.signatures[0].recover(checkpoint.digest()));
    try std.testing.expectEqual(validators[4].address, try selected.signatures[1].recover(checkpoint.digest()));
    try std.testing.expectError(error.QuorumAlreadyComplete, collector.push(.{ .validator_index = 1, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[1], null) }));

    validators[0].weight = 4_000_000_000;
    validators[1].weight = 4_000_000_000;
    var poisoned = checkpoint;
    poisoned.message_id = @splat(9);
    var poisoning = try weighted.Collector.init(allocator, &validators, 5_000_000_000, 3);
    try std.testing.expect((try poisoning.push(.{ .validator_index = 0, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null) })) == null);
    try std.testing.expectError(error.InconsistentCheckpoints, poisoning.push(.{ .validator_index = 1, .signed = try objects.SignedCheckpoint.sign(poisoned, keys[1], null) }));

    validators[0].weight = 9_000_000_000;
    validators[1].weight = std.math.maxInt(u96);
    var overflowing = try weighted.Collector.init(allocator, &validators, weighted.total_weight, 3);
    try std.testing.expect((try overflowing.push(.{ .validator_index = 0, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null) })) == null);
    try std.testing.expectError(error.WeightOverflow, overflowing.push(.{ .validator_index = 1, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[1], null) }));
}

test "weighted collector uses strict signatures and validator-order checked accumulation" {
    const keys = [_][32]u8{ @splat(0x11), @splat(0x22) };
    const validators = [_]weighted.Validator{
        .{ .address = try protocol.signature.secretKeyAddress(keys[0]), .weight = std.math.maxInt(u96) },
        .{ .address = try protocol.signature.secretKeyAddress(keys[1]), .weight = 1 },
    };
    const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = @splat(1), .mailbox_domain = 1, .root = @splat(2), .index = 3, .message_id = @splat(4) };
    var reversed = try weighted.Collector.init(allocator, &validators, weighted.total_weight, 3);
    try std.testing.expect((try reversed.push(.{ .validator_index = 1, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[1], null) })) == null);
    var selected = (try reversed.push(.{ .validator_index = 0, .signed = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null) })).?;
    defer selected.deinit();
    try std.testing.expectEqual(@as(usize, 1), selected.signatures.len);
    try std.testing.expectEqual(validators[0].address, try selected.signatures[0].recover(checkpoint.digest()));

    var high_s = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null);
    high_s.signature.s = std.crypto.ecc.Secp256k1.scalar.field_order - high_s.signature.s;
    high_s.signature.v = if (high_s.signature.v == 27) 28 else 27;
    var reject_high_s = try weighted.Collector.init(allocator, &validators, 100, 3);
    try std.testing.expect((try reject_high_s.push(.{ .validator_index = 0, .signed = high_s })) == null);
    var invalid_v = try objects.SignedCheckpoint.sign(checkpoint, keys[0], null);
    invalid_v.signature.v = 35;
    var reject_invalid_v = try weighted.Collector.init(allocator, &validators, 100, 3);
    try std.testing.expect((try reject_invalid_v.push(.{ .validator_index = 0, .signed = invalid_v })) == null);
}

fn allocationExercise(alloc: std.mem.Allocator) !void {
    const legacy_bytes = try legacy_fixture.encodeAlloc(alloc);
    defer alloc.free(legacy_bytes);
    var decoded_legacy = try legacy.decode(alloc, legacy_bytes);
    defer decoded_legacy.deinit();
    const arb_bytes = try legacyToArb(legacy_fixture).encodeAlloc(alloc);
    defer alloc.free(arb_bytes);
    var decoded_arb = try arb.decode(alloc, arb_bytes);
    defer decoded_arb.deinit();
    const response = try weightedResponse(alloc);
    defer alloc.free(response);
    var members = try weighted.decodeMembers(alloc, response);
    defer members.deinit();
}

fn legacyToArb(value: legacy.Metadata) arb.Metadata {
    return .{ .proof = &value.proof, .position = value.checkpoint_index, .caller = addressLast(3), .destination = addressLast(4), .arb_block_num = 5, .eth_block_num = 6, .timestamp = 7, .callvalue = 8, .data = value.signatures };
}

test "codec allocation failures release all owned memory" {
    try std.testing.checkAllAllocationFailures(allocator, allocationExercise, .{});
}

test "weighted destination uses real loopback JSON-RPC and rejects malformed ABI" {
    const response = try weightedResponse(allocator);
    defer allocator.free(response);
    const response_hex = try evm.codecs.hexAlloc(allocator, response);
    defer allocator.free(response_hex);
    const ok_body = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"{s}\"}}", .{response_hex});
    defer allocator.free(ok_body);
    const malformed_body = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x00\"}";
    const replies = [_]rpc_testing.Reply{ .{ .body = ok_body }, .{ .body = malformed_body } };
    const behaviors = [_]rpc_testing.Behavior{.{ .replies = &replies }};
    var fixture = try rpc_testing.Fixture.init(2, &behaviors);
    defer fixture.deinit();
    try fixture.start();
    const url = try fixture.url(allocator, 0);
    defer allocator.free(url);
    var client = try evm.RpcClient.init(allocator, url, .{ .max_response_bytes = 4096, .timeout_ms = 2000, .connect_timeout_ms = 1000 });
    defer client.deinit();
    var context: special.Context = .{ .origin_chain = 42161, .destination_chain = 1, .origin_rpc = &client, .destination_rpc = &client };
    var module: special.Module = .{ .allocator = allocator, .context = &context };
    try std.testing.expectError(error.UnsupportedIsmType, module.build(.polymer, addressLast(9), messageFixture()));
    var destination_arena = std.heap.ArenaAllocator.init(allocator);
    defer destination_arena.deinit();
    var destination: weighted.Destination = .{ .allocator = destination_arena.allocator(), .client = &client, .block = .{ .number = 42 } };
    var members = try destination.members(addressLast(9), messageFixture());
    defer members.deinit();
    try std.testing.expectEqual(@as(usize, 2), members.validators.len);
    try std.testing.expectError(error.InvalidMemberAbi, destination.members(addressLast(9), messageFixture()));
    try fixture.check();
    const request = fixture.records[0].bodyText();
    try std.testing.expect(std.mem.indexOf(u8, request, "eth_call") != null);
    try std.testing.expect(std.mem.indexOf(u8, request, "ec29dbde") != null);
    try std.testing.expect(std.mem.indexOf(u8, request, "0x2a") != null);
}

fn cancelAfter(flag: *std.atomic.Value(bool)) void {
    std.Thread.sleep(50 * std.time.ns_per_ms);
    flag.store(true, .release);
}

test "native loopback transport honors cancellation during a stalled weighted RPC" {
    const library = try rpc_testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var native = try Curl.Client.init(allocator, library);
    defer native.deinit();
    const stalled = [_]rpc_testing.Reply{.{ .body = "", .stall = true }};
    const behaviors = [_]rpc_testing.Behavior{.{ .replies = &stalled }};
    var fixture = try rpc_testing.Fixture.init(1, &behaviors);
    defer fixture.deinit();
    try fixture.start();
    const url = try fixture.url(allocator, 0);
    defer allocator.free(url);
    var cancel = std.atomic.Value(bool).init(false);
    var client = try evm.RpcClient.init(allocator, url, .{ .native_transport = &native, .cancel = &cancel, .max_response_bytes = 4096, .timeout_ms = 5000, .connect_timeout_ms = 1000 });
    defer client.deinit();
    const thread = try std.Thread.spawn(.{}, cancelAfter, .{&cancel});
    defer thread.join();
    var destination: weighted.Destination = .{ .allocator = allocator, .client = &client, .block = .latest };
    try std.testing.expectError(error.RequestCancelled, destination.members(addressLast(9), messageFixture()));
    try fixture.check();
}
