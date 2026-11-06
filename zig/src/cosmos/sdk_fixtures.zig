const std = @import("std");
const proto = @import("proto.zig");
const grpc = @import("grpc.zig");
const contracts = @import("contracts.zig");
const types = @import("types.zig");
const pb = @import("../altvm/protobuf.zig");
const protocol = @import("../protocol/root.zig");
const Fixture = struct {
    mailbox_id: []const u8,
    hook_id: []const u8,
    ism_id: []const u8,
    relayer: []const u8,
    address: []const u8,
    message: []const u8,
    mailbox_request: []const u8,
    mailbox_response: []const u8,
    tree_request: []const u8,
    tree_response: []const u8,
    ism_request: []const u8,
    ism_response: []const u8,
    account_response: []const u8,
    smart_request: []const u8,
    smart_response: []const u8,
    native_process: []const u8,
    cw_process_json: []const u8,
    module_type_json: []const u8,
    simulate_request: []const u8,
    simulate_response: []const u8,
    latest_response: []const u8,
    locations_request: []const u8,
    locations_response: []const u8,
    prepared_body: []const u8,
    prepared_auth: []const u8,
    prepared_doc: []const u8,
};
fn bytes(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, hex.len / 2);
    errdefer allocator.free(out);
    _ = try std.fmt.hexToBytes(out, hex);
    return out;
}
const Mock = struct {
    cases: []const struct { method: []const u8, request: []const u8, response: []const u8, height: ?u64 = null },
    next: usize = 0,
    fn call(context: *anyopaque, allocator: std.mem.Allocator, request: grpc.Request) !grpc.Response {
        const self: *Mock = @ptrCast(@alignCast(context));
        if (self.next == self.cases.len) return error.UnexpectedGrpcCall;
        const case = self.cases[self.next];
        self.next += 1;
        try std.testing.expectEqualStrings(case.method, request.method);
        try std.testing.expectEqualSlices(u8, case.request, request.protobuf);
        try std.testing.expectEqual(case.height, request.height);
        return .{ .allocator = allocator, .protobuf = try allocator.dupe(u8, case.response), .height = case.height };
    }
    fn transport(self: *Mock) grpc.Transport {
        return .{ .context = self, .call_fn = call };
    }
};

test "Cosmos native and CosmWasm queries match independent pinned SDK requests and responses" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    const fixture = parsed.value;
    const mailbox = try types.hash(fixture.mailbox_id);
    const hook = try types.hash(fixture.hook_id);
    const ism = try types.hash(fixture.ism_id);
    var mock: Mock = .{ .cases = &.{
        .{ .method = proto.paths.latest_validators, .request = "", .response = try bytes(allocator, fixture.latest_response) },
        .{ .method = proto.paths.smart_query, .request = try bytes(allocator, fixture.smart_request), .response = try bytes(allocator, fixture.smart_response), .height = 100 },
        .{ .method = proto.paths.mailbox, .request = try bytes(allocator, fixture.mailbox_request), .response = try bytes(allocator, fixture.mailbox_response), .height = 100 },
        .{ .method = proto.paths.tree, .request = try bytes(allocator, fixture.tree_request), .response = try bytes(allocator, fixture.tree_response), .height = 100 },
        .{ .method = proto.paths.ism, .request = try bytes(allocator, fixture.ism_request), .response = try bytes(allocator, fixture.ism_response) },
    } };
    const client: contracts.Client = .{ .allocator = allocator, .transport = mock.transport(), .domain = 2000, .config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    try std.testing.expectEqual(@as(u64, 198), try client.finalizedHeight());
    try std.testing.expectEqual(@as(u32, 5), try client.wasmNonce(mailbox, 100));
    var native = try client.nativeMailbox(mailbox, 100);
    defer native.deinit();
    try std.testing.expectEqual(@as(u32, 5), native.value.message_sent);
    try std.testing.expectEqual(@as(u32, 3), native.value.message_received);
    const tree = try client.nativeTree(hook, mailbox, 100);
    try std.testing.expectEqual(@as(u32, 1), tree.count);
    var native_ism = try client.nativeIsm(ism);
    defer native_ism.deinit();
    try std.testing.expectEqual(contracts.ModuleType.message_id_multisig, try contracts.nativeModuleType(native_ism.value));
    const multisig = try contracts.nativeMultisig(native_ism.value);
    try std.testing.expectEqual(@as(usize, 2), multisig.len);
    try std.testing.expectEqual(@as(u8, 2), multisig.threshold);
    try std.testing.expectEqual([_]u8{0x66} ** 20, multisig.validators[0]);
    try std.testing.expectEqual(mock.cases.len, mock.next);

    const account = try proto.BaseAccount.queryResponse(try bytes(allocator, fixture.account_response));
    try std.testing.expectEqualStrings(fixture.relayer, account.address);
    try std.testing.expectEqual(@as(u64, 12), account.account_number);
    try std.testing.expectEqual(@as(u64, 7), account.sequence);
    try std.testing.expectEqual(@as(u64, 123456), try proto.gasUsed(try bytes(allocator, fixture.simulate_response)));
    try std.testing.expectEqualSlices(u8, try bytes(allocator, fixture.simulate_request), try proto.simulateRequest(allocator, &.{ 1, 2, 3 }));
    const message = try protocol.Message.decode(try bytes(allocator, fixture.message));
    try std.testing.expectEqualSlices(u8, try bytes(allocator, fixture.native_process), try client.encodeNativeProcess(mailbox, fixture.relayer, message, &.{ 1, 2, 3 }));
    const wasm_process = try client.encodeWasmProcess(mailbox, fixture.relayer, message, &.{ 1, 2, 3 });
    try std.testing.expectEqualStrings(fixture.cw_process_json, try proto.textField(wasm_process, 3));
    var address: [90]u8 = undefined;
    try std.testing.expectEqualStrings(fixture.address, try types.contractAddress("cosmos", mailbox, 32, &address));
}

test "native tree rejects malformed frontier and false claimed roots" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const encoded = try bytes(allocator, parsed.value.tree_response);
    defer allocator.free(encoded);
    _ = try proto.NativeTree.queryResponse(encoded);
    // Root is the final length-delimited field in the generated fixture.
    encoded[encoded.len - 1] ^= 1;
    try std.testing.expectError(error.InvalidNativeTreeRoot, proto.NativeTree.queryResponse(encoded));
}

test "Cosmos sequence fee timeout and sign-doc match SDK and bind the configured signer" {
    const allocator = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const fixture = parsed.value;
    const TxClient = @import("transactions.zig").Client;
    const RpcClient = @import("../evm/provider.zig").RpcClient;
    var rpc = try RpcClient.init(allocator, "http://127.0.0.1:1", .{});
    defer rpc.deinit();
    var tendermint: @import("tendermint.zig").Client = .{ .rpc_client = &rpc, .chain_id = "test-1", .compat = .v038 };
    const key = [_]u8{0x11} ** 32;
    const tx_client: TxClient = .{ .allocator = allocator, .rpc = &tendermint, .config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 }, .signer_address = fixture.relayer, .public_key = try @import("../altvm/cosmos.zig").compressedPublicKey(key), .address_type = .bitcoin };
    var unsigned = try tx_client.buildAt(.{ .address = fixture.relayer, .account_number = 12, .sequence = 7 }, 100, &.{.{ .type_url = "/test.Msg", .value = &.{ 8, 1 } }}, 200000);
    defer unsigned.deinit();
    try std.testing.expectEqual(@as(u128, 5000), unsigned.fee);
    const expected_doc = try bytes(allocator, fixture.prepared_doc);
    defer allocator.free(expected_doc);
    try std.testing.expectEqualSlices(u8, expected_doc, unsigned.sign_doc);
    var signed = try tx_client.sign(unsigned, key, null);
    defer signed.deinit();
    try std.testing.expectEqual(@as(u64, 7), signed.sequence);
    try std.testing.expectEqual(@import("../altvm/cosmos.zig").txId(signed.raw), signed.id);
    try std.testing.expectError(error.WrongCosmosSigningKey, tx_client.sign(unsigned, .{0x22} ** 32, null));
    unsigned.sequence = 8;
    try std.testing.expectError(error.InvalidCosmosSignDoc, tx_client.sign(unsigned, key, null));
    unsigned.sequence = 7;
    unsigned.fee += 1;
    try std.testing.expectError(error.InvalidCosmosSignDoc, tx_client.sign(unsigned, key, null));
}

test "Cosmos announcements preserve configured validator order and query errors" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(Fixture, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true })).value;
    const mailbox = try types.hash(fixture.mailbox_id);
    const validator = [_]u8{0x66} ** 20;
    const payload = "{\"get_announce_storage_locations\":{\"validators\":[\"6666666666666666666666666666666666666666\"]}}";
    const response_json = "{\"storage_locations\":[[\"6666666666666666666666666666666666666666\",[\"s3://fixture/region\",\"https://example.invalid/checkpoints\"]]]}";
    const response = try proto.queryString(allocator, response_json);
    var mock: Mock = .{ .cases = &.{
        .{ .method = proto.paths.validator_locations, .request = try bytes(allocator, fixture.locations_request), .response = try bytes(allocator, fixture.locations_response) },
        .{ .method = proto.paths.smart_query, .request = try proto.smartQuery(allocator, fixture.address, payload), .response = response },
    } };
    const client: contracts.Client = .{ .allocator = std.testing.allocator, .transport = mock.transport(), .domain = 2000, .config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    var native = try client.nativeLocations(mailbox, &.{validator});
    defer native.deinit();
    var wasm = try client.wasmLocations(mailbox, &.{validator});
    defer wasm.deinit();
    try std.testing.expectEqual(@as(usize, 1), wasm.values.len);
    try std.testing.expectEqual(@as(usize, 2), native.values[0].len);
    for (native.values[0], wasm.values[0]) |actual, expected| try std.testing.expectEqualStrings(expected, actual);
    var unavailable = try client.nativeLocations(mailbox, &.{validator});
    defer unavailable.deinit();
    try std.testing.expectEqual(@as(usize, 0), unavailable.values[0].len);
    try std.testing.expectEqual(mock.cases.len, mock.next);
}

test "Cosmos native announcement outage skips one validator preserves neighbors and propagates cancellation" {
    const Script = struct {
        next: usize = 0,
        cancelled: bool = false,
        fn call(context: *anyopaque, a: std.mem.Allocator, _: grpc.Request) !grpc.Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            if (self.cancelled) return error.RequestCancelled;
            self.next += 1;
            if (self.next == 1) return error.GrpcRemoteStatus;
            const bytes_ = try proto.queryString(a, "s3://healthy/region");
            return .{ .allocator = a, .protobuf = bytes_ };
        }
    };
    var script: Script = .{};
    const client: contracts.Client = .{ .allocator = std.testing.allocator, .transport = .{ .context = &script, .call_fn = Script.call }, .domain = 2000, .config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    var result = try client.nativeLocations(.{1} ** 32, &.{ .{2} ** 20, .{3} ** 20 });
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 2), result.values.len);
    try std.testing.expectEqual(@as(usize, 0), result.values[0].len);
    try std.testing.expectEqualStrings("s3://healthy/region", result.values[1][0]);
    script.cancelled = true;
    try std.testing.expectError(error.RequestCancelled, client.nativeLocations(.{1} ** 32, &.{.{2} ** 20}));
}
