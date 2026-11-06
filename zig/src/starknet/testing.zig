const std = @import("std");
const codec = @import("codec.zig");
const tx = @import("transaction.zig");
const crypto = @import("crypto.zig");
const contracts = @import("contracts.zig");
const events = @import("events.zig");
const provider = @import("provider.zig");
const rpc = @import("../net/json_rpc.zig");
const mock = @import("../cloud/testing.zig");
const a = std.testing.allocator;
const V = std.json.Value;
fn join(allocator: std.mem.Allocator, value: V) ![]u8 {
    if (value != .array) return error.InvalidStarknetFixture;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (value.array.items) |part| try out.appendSlice(allocator, try rpc.string(part));
    return out.toOwnedSlice(allocator);
}
fn bytes(allocator: std.mem.Allocator, value: V) ![]u8 {
    const text = try join(allocator, value);
    defer allocator.free(text);
    if (text.len % 2 != 0) return error.InvalidStarknetFixture;
    const out = try allocator.alloc(u8, text.len / 2);
    errdefer allocator.free(out);
    _ = try std.fmt.hexToBytes(out, text);
    return out;
}
fn hash(allocator: std.mem.Allocator, value: V) ![32]u8 {
    const result = try bytes(allocator, value);
    defer allocator.free(result);
    if (result.len != 32) return error.InvalidStarknetFixture;
    return result[0..32].*;
}
fn felt(allocator: std.mem.Allocator, value: V) !codec.Felt {
    return codec.Felt.fromBytes(try hash(allocator, value));
}
fn felts(allocator: std.mem.Allocator, value: V) ![]codec.Felt {
    if (value != .array) return error.InvalidStarknetFixture;
    const out = try allocator.alloc(codec.Felt, value.array.items.len);
    errdefer allocator.free(out);
    for (value.array.items, out) |raw, *item| item.* = try felt(allocator, raw);
    return out;
}
fn field(value: V, name: []const u8) !V {
    return rpc.field(value, name);
}
fn number(comptime T: type, value: V, name: []const u8) !T {
    return std.fmt.parseInt(T, try rpc.string(try field(value, name)), 10);
}
fn equalFelts(left: []const codec.Felt, right: []const codec.Felt) !void {
    try std.testing.expectEqual(left.len, right.len);
    for (left, right) |x, y| try std.testing.expectEqual(x.value, y.value);
}
fn jsonEqual(left: V, right: V) bool {
    if (std.meta.activeTag(left) != std.meta.activeTag(right)) return false;
    return switch (left) {
        .object => |object| blk: {
            if (object.count() != right.object.count()) break :blk false;
            var it = object.iterator();
            while (it.next()) |item| if (!jsonEqual(item.value_ptr.*, right.object.get(item.key_ptr.*) orelse break :blk false)) break :blk false;
            break :blk true;
        },
        .array => |array| blk: {
            if (array.items.len != right.array.items.len) break :blk false;
            for (array.items, right.array.items) |x, y| if (!jsonEqual(x, y)) break :blk false;
            break :blk true;
        },
        .string => |text| std.mem.eql(u8, text, right.string),
        .integer => |n| n == right.integer,
        .float => |n| n == right.float,
        .bool => |b| b == right.bool,
        .null => true,
        .number_string => |text| std.mem.eql(u8, text, right.number_string),
    };
}
fn testProvider(script: *mock.Mock) !provider.Provider {
    return .{ .allocator = a, .client = try rpc.Client.init(a, script.transport(), &.{.{ .url = "https://fixture/rpc" }}, .{}) };
}

test "Starknet actual cainome message process and Dispatch fixtures cover packed byte boundaries" {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const fixture = (try std.json.parseFromSlice(V, allocator, line, .{})).value;
        if (!std.mem.eql(u8, try rpc.string(try field(fixture, "kind")), "message")) continue;
        const input = try field(fixture, "input");
        const expected = try field(fixture, "expected");
        const message: @import("../protocol/root.zig").Message = .{ .version = try rpc.integer(u8, try field(input, "version")), .nonce = try rpc.integer(u32, try field(input, "nonce")), .origin = try rpc.integer(u32, try field(input, "origin")), .destination = try rpc.integer(u32, try field(input, "destination")), .sender = try hash(allocator, try field(input, "sender")), .recipient = try hash(allocator, try field(input, "recipient")), .body = try bytes(allocator, try field(input, "body")) };
        var encoder: codec.Encoder = .{ .allocator = allocator };
        try encoder.message(message);
        try equalFelts(try felts(allocator, try field(expected, "message")), try encoder.finish());
        var script: mock.Mock = .{ .steps = &.{} };
        var p = try testProvider(&script);
        const chain: contracts.Contracts = .{ .provider = &p, .mailbox = try codec.Felt.init(0x1234), .hook = try codec.Felt.init(0x456), .domain = 100 };
        var call = try chain.process(message, try bytes(allocator, try field(input, "metadata")));
        defer call.deinit();
        try equalFelts(try felts(allocator, try field(expected, "process")), call.call.calldata);
        const dispatch_data = try felts(allocator, try field(expected, "dispatch"));
        const event: events.Event = .{ .address = chain.mailbox, .keys = &.{codec.selector("Dispatch")}, .data = dispatch_data, .transaction_hash = codec.Felt.zero, .block_hash = codec.Felt.zero, .block_number = 1, .log_index = 0 };
        var decoded = try events.decode(a, event, 1024);
        defer decoded.deinit(a);
        try std.testing.expectEqualSlices(u8, message.body, decoded.dispatch.body);
        dispatch_data[0].value ^= 1;
        try std.testing.expectError(error.InconsistentStarknetDispatch, events.decode(a, event, 1024));
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 13), count);
}

test "Starknet actual SDK InvokeV3 normal and query hashes signatures requests legacy and modern accounts" {
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_STARKNET_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var secret: [32]u8 = .{0} ** 32;
    secret[31] = 17;
    defer std.crypto.secureZero(u8, &secret);
    var local: tx.LocalSigner = .{ .crypto = &native, .secret = secret };
    defer local.deinit();
    const signer = try local.interface();
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const fixture = (try std.json.parseFromSlice(V, allocator, line, .{})).value;
        if (!std.mem.eql(u8, try rpc.string(try field(fixture, "kind")), "invoke")) continue;
        const input = try field(fixture, "input");
        const expected = try field(fixture, "expected");
        const raw_calls = try field(input, "calls");
        const calls = try allocator.alloc(tx.Call, raw_calls.array.items.len);
        for (raw_calls.array.items, calls) |raw, *call| call.* = .{ .to = try felt(allocator, try field(raw, "to")), .selector = try felt(allocator, try field(raw, "selector")), .calldata = try felts(allocator, try field(raw, "calldata")) };
        const bounds: tx.Bounds = .{ .l1_gas = .{ .max_amount = try number(u64, input, "l1_gas"), .max_price_per_unit = try number(u128, input, "l1_gas_price") }, .l2_gas = .{ .max_amount = try number(u64, input, "l2_gas"), .max_price_per_unit = try number(u128, input, "l2_gas_price") }, .l1_data_gas = .{ .max_amount = try number(u64, input, "l1_data_gas"), .max_price_per_unit = try number(u128, input, "l1_data_gas_price") } };
        var transaction = try tx.Transaction.init(allocator, try felt(allocator, try field(input, "chain_id")), try felt(allocator, try field(input, "sender")), try codec.Felt.init(try number(u64, input, "nonce")), bounds, calls, if ((try field(input, "legacy")).bool) .legacy else .modern);
        transaction.tip = try number(u64, input, "tip");
        try equalFelts(try felts(allocator, try field(expected, "encoded")), transaction.calldata);
        try std.testing.expectEqual((try felt(allocator, try field(expected, "hash"))).value, (try transaction.hash(&native, false)).value);
        try std.testing.expectEqual((try felt(allocator, try field(expected, "query_hash"))).value, (try transaction.hash(&native, true)).value);
        const signed = try transaction.sign(&native, signer, false);
        const query = try transaction.sign(&native, signer, true);
        try equalFelts(try felts(allocator, try field(expected, "signature")), &signed.signature);
        try equalFelts(try felts(allocator, try field(expected, "query_signature")), &query.signature);
        try std.testing.expectEqual((try felt(allocator, try field(expected, "public"))).value, signed.public_key.value);
        try transaction.validateSigned(&native, signed);
        const wire = try std.json.Stringify.valueAlloc(allocator, transaction.request(&signed.signature, false), .{});
        const parsed = (try std.json.parseFromSlice(V, allocator, wire, .{})).value;
        const reference = (try std.json.parseFromSlice(V, allocator, try join(allocator, try field(expected, "request_utf8_chunks")), .{})).value;
        try std.testing.expect(jsonEqual(parsed, reference));
        transaction.nonce.value ^= 1;
        try std.testing.expectError(error.StarknetSigningIntentChanged, transaction.validateSigned(&native, signed));
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 14), count);
}

fn rpcFixture(kind: []const u8) ![]u8 {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = try std.json.parseFromSlice(V, a, line, .{});
        defer parsed.deinit();
        if (std.mem.eql(u8, try rpc.string(try field(parsed.value, "kind")), kind)) return join(a, try field(parsed.value, "wire_utf8_chunks"));
    }
    return error.MissingStarknetFixture;
}
fn envelope(id: i64, raw: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(V, a, raw, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = parsed.value }, .{});
}
test "Starknet actual SDK paged events get canonical transaction and receipt log indices with duplicate pages" {
    const page_continue = try rpcFixture("rpc_page_continue");
    defer a.free(page_continue);
    const page_end = try rpcFixture("rpc_page_end");
    defer a.free(page_end);
    const receipt = try rpcFixture("rpc_receipt");
    defer a.free(receipt);
    const header = try rpcFixture("rpc_header");
    defer a.free(header);
    const r2 = try envelope(2, page_continue);
    defer a.free(r2);
    const r3 = try envelope(3, page_end);
    defer a.free(r3);
    const r4 = try envelope(4, receipt);
    defer a.free(r4);
    const r5 = try envelope(5, header);
    defer a.free(r5);
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":10}" },
        .{ .method = .POST, .suffix = "/rpc", .response = r2 },
        .{ .method = .POST, .suffix = "/rpc", .response = r3 },
        .{ .method = .POST, .suffix = "/rpc", .response = r4 },
        .{ .method = .POST, .suffix = "/rpc", .response = r5 },
    } };
    var p = try testProvider(&script);
    var indexed = try events.fetch(&p, try codec.Felt.init(0x1234), codec.selector("InsertedIntoTree"), 10, 10, .none);
    defer indexed.deinit();
    try std.testing.expectEqual(@as(usize, 1), indexed.items.len);
    try std.testing.expectEqual(@as(u32, 1), indexed.items[0].transaction_index);
    try std.testing.expectEqual(@as(u32, 1), indexed.items[0].log_index);
    var decoded = try events.decode(a, indexed.items[0], 1024);
    defer decoded.deinit(a);
    try std.testing.expectEqual(@as(u32, 2), decoded.insertion.index);
    try script.expectDone();
    const cycle_page = try envelope(3, page_continue);
    defer a.free(cycle_page);
    var cycle: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":10}" },
        .{ .method = .POST, .suffix = "/rpc", .response = r2 },
        .{ .method = .POST, .suffix = "/rpc", .response = cycle_page },
    } };
    p = try testProvider(&cycle);
    try std.testing.expectError(error.StarknetEventTokenCycle, events.fetch(&p, try codec.Felt.init(0x1234), codec.selector("InsertedIntoTree"), 10, 10, .none));
    try cycle.expectDone();
}

test "Starknet actual SDK receipt fee and header wires retain type width and optional unit rules" {
    const header = try rpcFixture("rpc_header");
    defer a.free(header);
    var parsed_header = try std.json.parseFromSlice(V, a, header, .{});
    defer parsed_header.deinit();
    try std.testing.expectEqual(@as(u64, 10), (try provider.Header.parse(parsed_header.value)).number);
    const receipt = try rpcFixture("rpc_receipt");
    defer a.free(receipt);
    var parsed_receipt = try std.json.parseFromSlice(V, a, receipt, .{});
    defer parsed_receipt.deinit();
    const typed = try provider.Receipt.parse(parsed_receipt.value, try codec.Felt.init(0x55));
    try std.testing.expect(typed.success);
    try std.testing.expectEqual(@as(u256, 0x123), typed.actual_fee);
    for ([_][]const u8{ "rpc_fee", "rpc_fee_without_unit" }) |kind| {
        const wire = try rpcFixture(kind);
        defer a.free(wire);
        var parsed = try std.json.parseFromSlice(V, a, wire, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(@as(u256, 44), (try provider.feeEstimate(parsed.value)).overall_fee);
        if (parsed.value.object.getPtr("unit")) |unit| {
            unit.* = .{ .string = "WEI" };
            try std.testing.expectError(error.InvalidStarknetFeeEstimate, provider.feeEstimate(parsed.value));
        }
    }
}

test "Starknet module addresses retain high bits while validator addresses require Ethereum width" {
    const module = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 1, .result = .{ try codec.Felt.init(1), try codec.Felt.init(@as(u256, 1) << 200), try codec.Felt.init(1) } }, .{});
    defer a.free(module);
    const validators = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 2, .result = .{ try codec.Felt.init(1), try codec.Felt.init(0x1234), try codec.Felt.init(1) } }, .{});
    defer a.free(validators);
    const invalid = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 3, .result = .{ try codec.Felt.init(1), try codec.Felt.init(@as(u256, 1) << 200), try codec.Felt.init(1) } }, .{});
    defer a.free(invalid);
    var script: mock.Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "/rpc", .response = module }, .{ .method = .POST, .suffix = "/rpc", .response = validators }, .{ .method = .POST, .suffix = "/rpc", .response = invalid } } };
    var p = try testProvider(&script);
    const chain: contracts.Contracts = .{ .provider = &p, .mailbox = codec.Felt.zero, .hook = codec.Felt.zero, .domain = 1 };
    const modules = try chain.members(codec.Felt.zero, .{}, false);
    defer a.free(modules.addresses);
    try std.testing.expectEqual(@as(u256, 1) << 200, modules.addresses[0].value);
    const signers = try chain.members(codec.Felt.zero, .{}, true);
    defer a.free(signers.addresses);
    try std.testing.expectEqual(@as(u160, 0x1234), std.mem.readInt(u160, &signers.addresses[0], .big));
    try std.testing.expectError(error.StarknetIntegerOverflow, chain.members(codec.Felt.zero, .{}, true));
    try script.expectDone();
}

test "Starknet pinned checkpoint tree mailbox announcement and storage locations queries use real Cairo layouts" {
    const tree = try envelope(2, "[\"0x2\",\"0x11\",\"0x22\",\"0x20\",\"0x33\",\"0x44\",\"0x20\",\"0x2\",\"0x0\"]");
    defer a.free(tree);
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[\"0x11\",\"0x22\",\"0x1\"]}" },
        .{ .method = .POST, .suffix = "/rpc", .response = tree },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":[\"0x1\"]}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":[\"0x1234\"]}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":[\"0x5678\"]}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":[\"0x6\"]}" },
    } };
    var p = try testProvider(&script);
    const chain: contracts.Contracts = .{ .provider = &p, .mailbox = try codec.Felt.init(0x123), .hook = try codec.Felt.init(0x456), .domain = 100 };
    const checkpoint = try chain.checkpointAt(7);
    try std.testing.expectEqual(@as(u64, 7), checkpoint.block_height);
    try std.testing.expectEqual(@as(u32, 1), checkpoint.index);
    const frontier = try chain.treeAt(7);
    try std.testing.expectEqual(@as(u32, 2), frontier.count);
    try std.testing.expectEqual((@as(u256, 0x22) << 128) + 0x11, std.mem.readInt(u256, &frontier.branch[0], .big));
    try std.testing.expect(try chain.delivered(.{0x22} ** 32));
    try std.testing.expectEqual(@as(u256, 0x1234), (try chain.defaultIsm()).value);
    try std.testing.expectEqual(@as(u256, 0x5678), (try chain.recipientIsm(.{0x33} ** 32)).value);
    try std.testing.expectEqual(@import("../relayer/metadata.zig").ModuleType.null_ism, try chain.moduleType(try codec.Felt.init(0x5678)));
    var delivered = try chain.deliveredCall(.{0x22} ** 32);
    defer delivered.deinit();
    try std.testing.expectEqual(@as(usize, 2), delivered.call.calldata.len);
    var announcement = try chain.announcement(try codec.Felt.init(0x789), .{0x11} ** 20, "s3://public-fixture/prefix", .{0x22} ** 65);
    defer announcement.deinit();
    var decoder: codec.Decoder = .{ .input = announcement.call.calldata };
    try std.testing.expectEqual(@as(u160, 0x1111111111111111111111111111111111111111), try decoder.integer(u160));
    try std.testing.expectEqual(@as(usize, 1), try decoder.integer(usize));
    _ = try decoder.felt();
    const signature = try decoder.bytes(a, 65);
    defer a.free(signature);
    try decoder.finish();
    try std.testing.expectEqualSlices(u8, &(.{0x22} ** 65), signature);
    try script.expectDone();
    const location = try codec.shortString("s3://public-fixture/");
    var locations = try contracts.decodeLocations(a, &.{ try codec.Felt.init(1), try codec.Felt.init(2), try codec.Felt.init(1), location, codec.Felt.zero }, 1);
    defer locations.deinit();
    try std.testing.expectEqualStrings("s3://public-fixture/", locations.values[0][0]);
    try std.testing.expectEqualStrings("", locations.values[0][1]);
}

test "Starknet metadata source full-felt builder fails closed when contract verification is unavailable" {
    const protocol = @import("../protocol/root.zig");
    const metadata = @import("../relayer/metadata.zig");
    const storage = @import("../storage/root.zig");
    const Origin = struct {
        pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
            return null;
        }
        pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
            return null;
        }
        pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?storage.SignedCheckpoint {
            return null;
        }
        pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
            return null;
        }
        pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
            return error.NoProof;
        }
    };
    var script: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[\"0x6\"]}" }} };
    var p = try testProvider(&script);
    var origin: Origin = .{};
    var source: contracts.Source(Origin) = .{ .chain = .{ .provider = &p, .mailbox = codec.Felt.zero, .hook = codec.Felt.zero, .domain = 100 }, .origin = &origin };
    var builder: metadata.Builder(@TypeOf(source)) = .{ .allocator = a, .source = &source };
    const module = try codec.Felt.init(@as(u256, 1) << 200);
    const bytes_result = try builder.build(module, .{});
    defer a.free(bytes_result);
    try std.testing.expectEqual(@as(usize, 0), bytes_result.len);
    try std.testing.expectError(error.StarknetDryRunUnavailable, source.verify(module, .{}, bytes_result));
    try script.expectDone();
}

test "Starknet prepare query sign fee median tip production sign and broadcast keep explicit mutation boundary" {
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_STARKNET_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var native = try crypto.Crypto.init(a, path);
    defer native.deinit();
    var secret: [32]u8 = .{0} ** 32;
    secret[31] = 17;
    defer std.crypto.secureZero(u8, &secret);
    var signer: tx.LocalSigner = .{ .crypto = &native, .secret = secret };
    defer signer.deinit();
    const signing = try signer.interface();
    const fee = try rpcFixture("rpc_fee");
    defer a.free(fee);
    const fee_array = try std.fmt.allocPrint(a, "[{s}]", .{fee});
    defer a.free(fee_array);
    const r3 = try envelope(3, fee_array);
    defer a.free(r3);
    const block = try rpcFixture("rpc_block_transactions");
    defer a.free(block);
    const r4 = try envelope(4, block);
    defer a.free(r4);
    var steps = [_]mock.Step{
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x2\"}" },
        .{ .method = .POST, .suffix = "/rpc", .response = r3 },
        .{ .method = .POST, .suffix = "/rpc", .response = r4 },
        .{ .method = .POST, .suffix = "/rpc", .response = "" },
        .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":[]}" },
    };
    var script: mock.Mock = .{ .steps = &steps };
    var p = try testProvider(&script);
    const calls = [_]tx.Call{.{ .to = try codec.Felt.init(0x1234), .selector = codec.selector("process"), .calldata = &.{} }};
    var transaction = try p.prepare(&native, signing, try codec.Felt.init(1), try codec.Felt.init(0x1234), &calls, .modern, 1000);
    defer transaction.deinit();
    try std.testing.expectEqual(@as(u64, 4), transaction.tip);
    try std.testing.expectEqual(@as(u64, 1), transaction.bounds.l1_gas.max_amount);
    const signed = try transaction.sign(&native, signing, false);
    const query = try transaction.sign(&native, signing, true);
    const r5 = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 5, .result = .{ .transaction_hash = signed.hash } }, .{});
    defer a.free(r5);
    steps[4].response = r5;
    try std.testing.expectError(error.CannotBroadcastStarknetQuery, p.broadcast(&native, transaction, query));
    try std.testing.expectEqual(signed.hash.value, (try p.broadcast(&native, transaction, signed)).value);
    var simulation = try p.simulate(transaction, &query.signature, false, true);
    defer simulation.deinit();
    try script.expectDone();
}
