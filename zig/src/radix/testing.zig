const std = @import("std");
const provider = @import("provider.zig");
const sbor = @import("sbor.zig");
const address = @import("address.zig");
const crypto = @import("crypto.zig");
const tx = @import("transaction.zig");
const contracts = @import("contracts.zig");
const json = @import("../cosmos/types.zig");
const http = @import("../cloud/http.zig");
fn bytes(allocator: std.mem.Allocator, encoded: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, encoded.len / 2);
    _ = try std.fmt.hexToBytes(out, encoded);
    return out;
}
fn equalJson(expected: std.json.Value, actual: std.json.Value) anyerror!void {
    try std.testing.expectEqual(std.meta.activeTag(expected), std.meta.activeTag(actual));
    switch (expected) {
        .object => |object| {
            try std.testing.expectEqual(object.count(), actual.object.count());
            var it = object.iterator();
            while (it.next()) |entry| try equalJson(entry.value_ptr.*, actual.object.get(entry.key_ptr.*) orelse return error.MissingFixtureField);
        },
        .array => |array| {
            try std.testing.expectEqual(array.items.len, actual.array.items.len);
            for (array.items, actual.array.items) |a, b| try equalJson(a, b);
        },
        .string => |text| try std.testing.expectEqualStrings(text, actual.string),
        .integer => |value| try std.testing.expectEqual(value, actual.integer),
        .bool => |value| try std.testing.expectEqual(value, actual.bool),
        .null => {},
        else => return error.UnsupportedFixtureNumber,
    }
}
const Step = struct { path: []const u8, request: std.json.Value, response: []const u8 };
const Fixture = struct {
    server: std.net.Server,
    steps: []const Step,
    fn serve(self: *Fixture) void {
        self.run() catch @panic("Radix HTTP fixture failed");
    }
    fn run(self: *Fixture) !void {
        for (self.steps) |step| {
            const connection = try self.server.accept();
            defer connection.stream.close();
            var buffer: [32768]u8 = undefined;
            var used: usize = 0;
            while (true) {
                if (used == buffer.len) return error.FixtureTooLarge;
                const count = try connection.stream.read(buffer[used..]);
                if (count == 0) return error.FixtureEof;
                used += count;
                if (std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n")) |header_end| {
                    const first_end = std.mem.indexOf(u8, buffer[0..header_end], "\r\n") orelse return error.FixtureBadRequest;
                    const expected_line = try std.fmt.allocPrint(std.testing.allocator, "POST {s} HTTP/1.1", .{step.path});
                    defer std.testing.allocator.free(expected_line);
                    try std.testing.expectEqualStrings(expected_line, buffer[0..first_end]);
                    var lines = std.mem.splitSequence(u8, buffer[first_end + 2 .. header_end], "\r\n");
                    var length: ?usize = null;
                    while (lines.next()) |line| {
                        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.FixtureBadHeader;
                        if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) length = try std.fmt.parseInt(usize, std.mem.trim(u8, line[colon + 1 ..], " \t"), 10);
                    }
                    const body_len = length orelse return error.FixtureMissingLength;
                    if (used < header_end + 4 + body_len) continue;
                    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, buffer[header_end + 4 ..][0..body_len], .{});
                    defer parsed.deinit();
                    try equalJson(step.request, parsed.value);
                    break;
                }
            }
            var response_header: [160]u8 = undefined;
            try connection.stream.writeAll(try std.fmt.bufPrint(&response_header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{step.response.len}));
            try connection.stream.writeAll(step.response);
        }
    }
};

test "Radix SDK typed output schemas preserve Merkle quorum and validator locations" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(std.json.Value, allocator, @embedFile("fixtures/sdk.json.gz"), .{})).value;
    const values = try json.field(fixture, "values");
    const tree = try contracts.decodeTree(try sbor.decode(try bytes(allocator, try json.string(try json.field(values, "merkle"))), .scrypto));
    try std.testing.expectEqual(@as(u32, 3), tree.count);
    try std.testing.expectEqual([_]u8{0x11} ** 32, tree.branch[31]);
    const multisig = try contracts.decodeMultisig(try sbor.decode(try bytes(allocator, try json.string(try json.field(values, "multisig"))), .scrypto));
    try std.testing.expectEqual(@as(usize, 2), multisig.len);
    try std.testing.expectEqual(@as(u8, 2), multisig.threshold);
    var locations = try contracts.decodeLocations(std.testing.allocator, try sbor.decode(try bytes(allocator, try json.string(try json.field(values, "locations"))), .scrypto), 1);
    defer locations.deinit();
    try std.testing.expectEqualStrings("s3://fixture/region", locations.values[0][0]);
    try std.testing.expect(try sbor.boolean(try sbor.decode(try bytes(allocator, try json.string(try json.field(values, "bool"))), .scrypto)));
}

test "Radix actual HTTP Core Gateway request bodies match production API SDK" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(std.json.Value, allocator, @embedFile("fixtures/sdk.json.gz"), .{})).value;
    const api = try json.field(fixture, "api");
    var server: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{
        .{ .path = "/core/status/network-status?token=fixture", .request = try json.field(api, "status"), .response = "{\"current_state_identifier\":{\"state_version\":105}}" },
        .{ .path = "/core/transaction/call-preview?token=fixture", .request = try json.field(api, "call"), .response = "{\"status\":\"Succeeded\",\"at_ledger_state\":{\"state_version\":100},\"output\":{\"hex\":\"5c0905000000\"}}" },
        .{ .path = "/gateway/stream/transactions?token=fixture", .request = try json.field(api, "stream"), .response = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":110,\"epoch\":100},\"items\":[{\"state_version\":101}],\"next_cursor\":null}" },
    } };
    defer server.server.deinit();
    const core = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/core?token=fixture", .{server.server.listen_address.getPort()});
    const gateway = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/gateway?token=fixture", .{server.server.listen_address.getPort()});
    var transport = http.HttpTransport.init(std.testing.allocator);
    defer transport.deinit();
    transport.allow_insecure_loopback = true;
    const client: provider.Client = .{ .allocator = std.testing.allocator, .transport = transport.interface(), .core = .{ .url = core }, .gateway = .{ .url = gateway }, .network = .mainnet, .confirmations = 5 };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&server});
    defer thread.join();
    try std.testing.expectEqual(@as(u64, 100), try client.finalizedState());
    const component = (try bytes(allocator, try json.string(try json.field(fixture, "component"))))[0..30].*;
    const contract: contracts.Client = .{ .provider = client, .mailbox = component, .domain = 1000 };
    try std.testing.expectEqual(@as(u32, 5), try contract.count(100));
    var stream = try client.streamPage(100, 110, try json.string(try json.field(fixture, "account_text")), null);
    defer stream.deinit();
    try std.testing.expectEqual(@as(usize, 1), (try json.field(stream.value(), "items")).array.items.len);
}

test "Radix notarization rejects wrong keys corrupted hashes and changed prepared bytes" {
    const allocator = std.testing.allocator;
    const seed = [_]u8{0x11} ** 32;
    const public = try crypto.publicKey(seed);
    const instructions = try tx.instructions(allocator, null, 0, &.{});
    defer allocator.free(instructions);
    var prepared = try tx.prepare(allocator, .{ .network_id = 1, .epoch = 100, .discriminator = 7, .notary_key = public }, instructions);
    defer prepared.deinit();
    try std.testing.expectError(error.WrongRadixNotary, tx.notarize(allocator, prepared, .{0x22} ** 32));
    prepared.intent_hash[0] ^= 1;
    try std.testing.expectError(error.InvalidRadixPreparedTransaction, tx.notarize(allocator, prepared, seed));
    prepared.intent_hash[0] ^= 1;
    prepared.signed_intent[prepared.signed_intent.len - 1] ^= 1;
    try std.testing.expectError(error.InvalidRadixPreparedTransaction, tx.notarize(allocator, prepared, seed));
    prepared.signed_intent[prepared.signed_intent.len - 1] ^= 1;
    var signed = try tx.notarize(allocator, prepared, seed);
    defer signed.deinit();
}

test "Radix actual SDK Blake2b Ed25519 and secp256k1 signatures verify independently" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(std.json.Value, allocator, @embedFile("fixtures/sdk.json.gz"), .{})).value;
    for ((try json.field(fixture, "crypto_cases")).array.items) |case| {
        const seed = (try bytes(allocator, try json.string(try json.field(case, "seed"))))[0..32].*;
        const digest = (try bytes(allocator, try json.string(try json.field(case, "digest"))))[0..32].*;
        const payload = try bytes(allocator, try json.string(try json.field(case, "payload")));
        try std.testing.expectEqual(digest, crypto.hash(payload));
        const public = (try bytes(allocator, try json.string(try json.field(case, "ed_public"))))[0..32].*;
        const signature = (try bytes(allocator, try json.string(try json.field(case, "ed_signature"))))[0..64].*;
        try std.testing.expectEqual(public, try crypto.publicKey(seed));
        try std.testing.expectEqual(signature, try crypto.sign(seed, digest));
        try crypto.verify(public, digest, signature);
        const secp_public = (try bytes(allocator, try json.string(try json.field(case, "secp_public"))))[0..33].*;
        const secp_signature = try bytes(allocator, try json.string(try json.field(case, "secp_signature")));
        const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
        try Ecdsa.Signature.fromBytes(secp_signature[1..65].*).verifyPrehashed(digest, try Ecdsa.PublicKey.fromSec1(&secp_public));
        const expected_account = try bytes(allocator, try json.string(try json.field(case, "secp_account")));
        try std.testing.expectEqualSlices(u8, expected_account, &try crypto.secpAccount(secp_public));
    }
}

test "Radix process preparation resolves visible components locks exact fee and remains unsigned" {
    const testing = @import("../cloud/testing.zig");
    const runtime = @import("runtime.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(std.json.Value, allocator, @embedFile("fixtures/sdk.json.gz"), .{})).value;
    const component = (try bytes(allocator, try json.string(try json.field(fixture, "component"))))[0..30].*;
    var address_text: [160]u8 = undefined;
    const encoded_address = try address.encode(.mainnet, "component", &component, &address_text);
    const failure = try std.json.Stringify.valueAlloc(allocator, .{ .receipt = .{ .status = "Failed", .error_message = try std.fmt.allocPrint(allocator, "Node not visible: {s}", .{encoded_address}) } }, .{});
    const success = "{\"receipt\":{\"status\":\"Succeeded\",\"fee_summary\":{\"xrd_total_execution_cost\":\"1\",\"xrd_total_finalization_cost\":\"0.1\",\"xrd_total_royalty_cost\":\"0.01\",\"xrd_total_storage_cost\":\"0.001\"}}}";
    const steps = [_]testing.Step{
        .{ .method = .POST, .suffix = "/status/gateway-status", .request_body = "{}", .response = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":100,\"epoch\":100}}" },
        .{ .method = .POST, .suffix = "/transaction/preview-v2", .response = failure },
        .{ .method = .POST, .suffix = "/transaction/preview-v2", .response = success },
    };
    var mock: testing.Mock = .{ .steps = &steps };
    const client: provider.Client = .{ .allocator = std.testing.allocator, .transport = mock.transport(), .core = .{ .url = "https://example.invalid" }, .gateway = .{ .url = "https://example.invalid" }, .network = .mainnet, .confirmations = 0 };
    const message: @import("../protocol/root.zig").Message = .{ .version = 3, .nonce = 1, .origin = 1000, .sender = .{0x11} ** 32, .destination = 2000, .recipient = .{0x22} ** 32, .body = "body" };
    var prepared = try runtime.prepareProcess(client, component, 2000, message, &.{ 1, 2, 3 }, try crypto.publicKey(.{0x11} ** 32), 7);
    defer prepared.deinit();
    try std.testing.expectEqual(@as(u64, 102), prepared.end_epoch_exclusive);
    try mock.expectDone();
    const receipt = (try std.json.parseFromSlice(std.json.Value, allocator, success, .{})).value;
    try std.testing.expectEqual(@as(i192, 1666500000000000000), try runtime.lockedFee(try json.field(receipt, "receipt")));
}

test "Radix gas event scales gas whole units retains payment attos and validates emitter" {
    const events = @import("events.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(std.json.Value, allocator, @embedFile("fixtures/sdk.json.gz"), .{})).value;
    const component = (try bytes(allocator, try json.string(try json.field(fixture, "component"))))[0..30].*;
    var text: [160]u8 = undefined;
    const encoded = try address.encode(.mainnet, "component", &component, &text);
    const data = try std.fmt.allocPrint(allocator, "{{\"name\":\"GasPayment\",\"emitter\":{{\"type\":\"Method\",\"entity\":{{\"entity_address\":\"{s}\"}}}},\"data\":{{\"kind\":\"Tuple\",\"type_name\":\"GasPayment\",\"fields\":[{{\"kind\":\"Bytes\",\"hex\":\"{s}\"}},{{\"kind\":\"U32\",\"value\":\"2000\"}},{{\"kind\":\"Decimal\",\"value\":\"150000.99\"}},{{\"kind\":\"Decimal\",\"value\":\"0.25\"}},{{\"kind\":\"Reference\",\"value\":\"resource_rdx_fixture\"}},{{\"kind\":\"U32\",\"value\":\"3\"}}]}}}}", .{ encoded, "11" ** 32 });
    const parsed = (try std.json.parseFromSlice(std.json.Value, allocator, data, .{})).value;
    var event = (try events.parse(std.testing.allocator, .mainnet, component, parsed)).?;
    defer event.deinit();
    try std.testing.expectEqual(@as(u256, 150000), event.event.gas_payment.gas_amount);
    try std.testing.expectEqual(@as(u256, 250000000000000000), event.event.gas_payment.payment);
    try std.testing.expectEqualStrings("resource_rdx_fixture", event.event.gas_payment.resource);
    try std.testing.expectEqual(@as(u32, 2000), event.event.gas_payment.destination);
    try std.testing.expectEqual(@as(u32, 3), event.event.gas_payment.sequence);
    try std.testing.expectEqual(@as(?events.Parsed, null), try events.parse(std.testing.allocator, .mainnet, .{0} ** 30, parsed));
}

test "Radix gas resource Reference rejects String wrong kind and schema name" {
    const events = @import("events.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../testing/fixture.zig").parse(std.json.Value, allocator, @embedFile("fixtures/sdk.json.gz"), .{})).value;
    const component = (try bytes(allocator, try json.string(try json.field(fixture, "component"))))[0..30].*;
    var text: [160]u8 = undefined;
    const encoded = try address.encode(.mainnet, "component", &component, &text);
    const rejected = [_]struct { kind: []const u8, field_name: []const u8, expected: anyerror }{
        .{ .kind = "String", .field_name = "resource_address", .expected = error.WrongRadixEventFieldKind },
        .{ .kind = "Bytes", .field_name = "resource_address", .expected = error.WrongRadixEventFieldKind },
        .{ .kind = "Decimal", .field_name = "resource_address", .expected = error.WrongRadixEventFieldKind },
        .{ .kind = "Reference", .field_name = "other_resource", .expected = error.WrongRadixEventSchema },
    };
    for (rejected) |item| {
        const data = try std.fmt.allocPrint(allocator, "{{\"name\":\"GasPayment\",\"emitter\":{{\"type\":\"Method\",\"entity\":{{\"entity_address\":\"{s}\"}}}},\"data\":{{\"kind\":\"Tuple\",\"type_name\":\"GasPayment\",\"fields\":[{{\"kind\":\"Bytes\",\"hex\":\"{s}\"}},{{\"kind\":\"U32\",\"value\":\"2000\"}},{{\"kind\":\"Decimal\",\"value\":\"150000.99\"}},{{\"kind\":\"Decimal\",\"value\":\"0.25\"}},{{\"kind\":\"{s}\",\"field_name\":\"{s}\",\"value\":\"resource_rdx_fixture\"}},{{\"kind\":\"U32\",\"value\":\"3\"}}]}}}}", .{ encoded, "11" ** 32, item.kind, item.field_name });
        const parsed = (try std.json.parseFromSlice(std.json.Value, allocator, data, .{})).value;
        try std.testing.expectError(item.expected, events.parse(allocator, .mainnet, component, parsed));
    }
}
