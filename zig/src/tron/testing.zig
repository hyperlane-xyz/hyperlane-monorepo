const std = @import("std");
const a = std.testing.allocator;
const rpc = @import("rpc.zig");
const p = @import("provider.zig");
const tx = @import("transaction.zig");
const contracts = @import("contracts.zig");
const abi = @import("../evm/codecs.zig");
const mock = @import("../cloud/testing.zig");

pub fn join(allocator: std.mem.Allocator, chunks: std.json.Value) ![]u8 {
    if (chunks != .array) return error.InvalidFixture;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (chunks.array.items) |chunk| try out.appendSlice(allocator, try rpc.string(chunk));
    return out.toOwnedSlice(allocator);
}
pub fn bytes(allocator: std.mem.Allocator, chunks: std.json.Value) ![]u8 {
    const text = try join(allocator, chunks);
    defer allocator.free(text);
    return p.decodeUnprefixed(allocator, text);
}
fn blockFixture() ![]u8 {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/http.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var parsed = try std.json.parseFromSlice(std.json.Value, a, lines.next().?, .{});
    defer parsed.deinit();
    return join(a, try rpc.field(parsed.value, "wire_utf8_chunks"));
}
fn constant(data: []const u8) ![]u8 {
    const hex = try p.unprefixedAlloc(a, data);
    defer a.free(hex);
    return std.json.Stringify.valueAlloc(a, .{ .constant_result = .{hex} }, .{});
}

test "Tron prepare sign broadcast inclusion canonical finality and expiration use exact endpoint pools" {
    const block = try blockFixture();
    defer a.free(block);
    var steps = [_]mock.Step{
        .{ .method = .POST, .suffix = "/wallet/estimateenergy", .response = "{\"energy_required\":1000}" },
        .{ .method = .POST, .suffix = "/jsonrpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x64\"}" },
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .request_body = "{}", .response = block },
        .{ .method = .POST, .suffix = "/wallet/broadcasthex", .response = "{\"result\":true}" },
        .{ .method = .POST, .suffix = "/wallet/broadcasthex", .response = "{\"result\":false,\"code\":\"DUP_TRANSACTION_ERROR\"}" },
        .{ .method = .POST, .suffix = "/jsonrpc", .response = "" },
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .response = block },
        .{ .method = .POST, .suffix = "/walletsolidity/getblockbynum", .request_body = "{\"num\":123456}", .response = block },
        .{ .method = .POST, .suffix = "/jsonrpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":null}" },
    };
    // Replace the receipt response once the SHA256 transaction ID is known.
    var script: mock.Mock = .{ .steps = &steps };
    var provider = try p.Provider.init(a, script.transport(), .{ .rpc_urls = &.{.{ .url = "https://fixture/jsonrpc" }}, .wallet_urls = &.{.{ .url = "https://fixture/wallet" }}, .wallet_solidity_urls = &.{.{ .url = "https://fixture/walletsolidity" }} });
    var local: tx.LocalSigner = .{ .secret_key = .{0x11} ** 32 };
    defer local.deinit();
    const signer = try local.interface();
    provider.signer_address = signer.address[1..].*;
    const trigger = try provider.trigger(null, .{0x22} ** 20, "fixture", 0);
    var unsigned = try provider.prepare(trigger, 1500, 1700000000999, .{});
    defer unsigned.deinit();
    var signed = try tx.sign(unsigned, signer, 1700000001000);
    defer signed.deinit();
    const id = try abi.hexAlloc(a, &signed.id);
    defer a.free(id);
    const block_id = try abi.hexAlloc(a, &(.{0x33} ** 32));
    defer a.free(block_id);
    const receipt = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 2, .result = .{ .transactionHash = id, .blockNumber = "0x1e240", .blockHash = block_id, .status = "0x0", .gasUsed = "0x123" } }, .{});
    defer a.free(receipt);
    steps[5].response = receipt;
    try std.testing.expect((try provider.broadcast(signed, 1700000001000)).accepted);
    try std.testing.expectEqual(tx.SubmissionError.duplicate, (try provider.broadcast(signed, 1700000001000)).classification);
    // Finality is separate from execution success (receipt status=0 here).
    try std.testing.expectEqual(p.Status.finalized, try provider.status(signed, 1700000001000));
    try std.testing.expectEqual(p.Status.expired, try provider.status(signed, signed.expiration_ms));
    try std.testing.expectError(error.TronTransactionExpired, provider.broadcast(signed, signed.expiration_ms));
    try script.expectDone();
}

test "Tron source wallet HTTP serde fixtures preserve defaults and exact trigger request wire" {
    var signer: tx.LocalSigner = .{ .secret_key = .{0x11} ** 32 };
    defer signer.deinit();
    const interface = try signer.interface();
    var unsigned = try tx.build(a, .{ .owner = interface.address, .contract = @import("../altvm/tron.zig").fromEthereumAddress(.{0x22} ** 20), .data = "" }, .{ .block_number = 0, .block_hash = .{0x33} ** 32, .timestamp_ms = 0, .expiration_ms = 1000, .fee_limit = 100 });
    defer unsigned.deinit();
    var signed = try tx.sign(unsigned, interface, 0);
    defer signed.deinit();
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/http.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var total: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var fixture = try std.json.parseFromSlice(std.json.Value, a, line, .{});
        defer fixture.deinit();
        const kind = try rpc.string(try rpc.field(fixture.value, "kind"));
        const wire = try join(a, try rpc.field(fixture.value, "wire_utf8_chunks"));
        defer a.free(wire);
        if (std.mem.eql(u8, kind, "BlockResponse")) {
            var parsed = try std.json.parseFromSlice(std.json.Value, a, wire, .{});
            defer parsed.deinit();
            const block = try p.Block.parse(parsed.value);
            try std.testing.expectEqual(@as(u64, 123456), block.number);
            try std.testing.expectEqual(@as(u64, 1700000000000), block.timestamp_ms);
        } else if (std.mem.eql(u8, kind, "TriggerContractRequest")) {
            var script: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/wallet/estimateenergy", .request_body = wire, .response = "{\"energy_required\":1}" }} };
            var provider = p.testingProvider(script.transport());
            const owner = try @import("../altvm/tron.zig").secretKeyAddress(.{0x11} ** 32);
            provider.signer_address = owner[1..].*;
            try std.testing.expectEqual(@as(u64, 1), try provider.estimateEnergy(try provider.trigger(null, .{0x22} ** 20, &.{ 1, 2, 3 }, 42)));
            try script.expectDone();
        } else if (std.mem.eql(u8, kind, "EstimateEnergyResponse")) {
            var script: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/wallet/estimateenergy", .response = wire }} };
            var provider = p.testingProvider(script.transport());
            const expected = try rpc.field(fixture.value, "expected");
            const energy = try rpc.nonnegative(try rpc.field(expected, "energy_required"));
            if (energy > 0) try std.testing.expectEqual(energy, try provider.estimateEnergy(try provider.trigger(null, .{0} ** 20, "", 0))) else if (expected.object.get("has_result").?.bool) try std.testing.expectError(error.TronEnergyEstimationFailed, provider.estimateEnergy(try provider.trigger(null, .{0} ** 20, "", 0))) else try std.testing.expectError(error.TronEnergyEstimationFailed, provider.estimateEnergy(try provider.trigger(null, .{0} ** 20, "", 0)));
        } else if (std.mem.eql(u8, kind, "TriggerConstantResponse")) {
            var script: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = wire }} };
            var provider = p.testingProvider(script.transport());
            const expected = try rpc.field(fixture.value, "expected");
            const values = (try rpc.field(expected, "constant_result")).array.items;
            const trigger = try provider.trigger(null, .{0} ** 20, "", 0);
            if (values.len > 0) {
                const data = try provider.call(trigger);
                defer a.free(data);
                try std.testing.expectEqual(@as(usize, 0), data.len);
            } else if (expected.object.get("has_result").?.bool) try std.testing.expectError(error.TronContractCallFailed, provider.call(trigger)) else try std.testing.expectError(error.TronNoConstantResult, provider.call(trigger));
        } else if (std.mem.eql(u8, kind, "BroadcastResponse")) {
            var script: mock.Mock = .{ .steps = &.{.{ .method = .POST, .suffix = "/wallet/broadcasthex", .response = wire }} };
            var provider = p.testingProvider(script.transport());
            const result = try provider.broadcast(signed, 0);
            const expected = (try rpc.field(try rpc.field(fixture.value, "expected"), "result"));
            try std.testing.expectEqual(expected == .bool and expected.bool, result.accepted);
        } else return error.UnknownFixture;
        total += 1;
    }
    try std.testing.expectEqual(@as(usize, 11), total);
}

test "Tron contract queries cover checkpoint tree mailbox ISM and preserve count before tip" {
    const block = try blockFixture();
    defer a.free(block);
    var count_word: [32]u8 = .{0} ** 32;
    count_word[31] = 2;
    const count = try constant(&count_word);
    defer a.free(count);
    var address_word: [32]u8 = .{0} ** 32;
    @memset(address_word[12..], 0x22);
    const address = try constant(&address_word);
    defer a.free(address);
    var checkpoint_words: [64]u8 = .{0x33} ** 64;
    @memset(checkpoint_words[32..], 0);
    checkpoint_words[63] = 1;
    const checkpoint = try constant(&checkpoint_words);
    defer a.free(checkpoint);
    var tree_words: [1056]u8 = .{0x44} ** 1056;
    @memset(tree_words[1024..], 0);
    tree_words[1055] = 2;
    const tree = try constant(&tree_words);
    defer a.free(tree);
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = count },
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .response = block },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = address },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = address },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = checkpoint },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = tree },
    } };
    var provider = p.testingProvider(script.transport());
    const chain: contracts.Contracts = .{ .provider = &provider, .mailbox = .{0x55} ** 20, .hook = .{0x66} ** 20, .domain = 100 };
    const sequence = try chain.countAndTip(true);
    try std.testing.expectEqual(@as(u32, 2), sequence.count);
    try std.testing.expectEqual(@as(u32, 123456), sequence.tip);
    try std.testing.expectEqual([_]u8{0x22} ** 20, try chain.defaultIsm());
    try std.testing.expectEqual([_]u8{0x22} ** 20, try chain.recipientIsm(.{0x77} ** 20));
    try std.testing.expectEqual(@as(u32, 1), (try chain.latestCheckpoint()).index);
    try std.testing.expectEqual(@as(u32, 2), (try chain.tree()).count);
    const trigger = try chain.process("message", "metadata");
    defer chain.freeProcess(trigger);
    const announce = try chain.announcement(.{0x11} ** 20, .{0x22} ** 20, "s3://fixture/", .{0x33} ** 65);
    defer chain.freeProcess(announce);
    try std.testing.expectEqualSlices(u8, &abi.selector("announce(address,string,bytes)"), announce.data[0..4]);
    try script.expectDone();
}

test "Tron Null ISM trusted relayer and bounded routing cycles match source dry run" {
    var no: [32]u8 = .{0} ** 32;
    const rejected = try constant(&no);
    defer a.free(rejected);
    no[31] = 6;
    const null_ism = try constant(&no);
    defer a.free(null_ism);
    no[31] = 1;
    const routing = try constant(&no);
    defer a.free(routing);
    @memset(no[12..], 0x22);
    const address = try constant(&no);
    defer a.free(address);
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = rejected },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = null_ism },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = address },
    } };
    var provider = p.testingProvider(script.transport());
    provider.signer_address = .{0x22} ** 20;
    const chain: contracts.Contracts = .{ .provider = &provider, .mailbox = .{0} ** 20, .hook = .{0} ** 20, .domain = 1 };
    try std.testing.expectEqual(@as(u256, 0), try chain.verify(.{0x22} ** 20, .{}, ""));
    try script.expectDone();
    var steps: [30]mock.Step = undefined;
    for (&steps, 0..) |*step, i| step.* = .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = switch (i % 3) {
        0 => rejected,
        1 => routing,
        2 => address,
        else => unreachable,
    } };
    var cycle: mock.Mock = .{ .steps = &steps };
    provider.solidity.transport = cycle.transport();
    try std.testing.expectError(error.VerifyRejected, chain.verify(.{0x22} ** 20, .{}, ""));
    try cycle.expectDone();
}

const Server = struct {
    listener: std.net.Server,
    failure: ?anyerror = null,
    fn serve(self: *Server) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *Server) !void {
        const conn = try self.listener.accept();
        defer conn.stream.close();
        var buffer: [8192]u8 = undefined;
        var used: usize = 0;
        while (true) {
            if (used == buffer.len) return error.RequestTooLarge;
            const read = try conn.stream.read(buffer[used..]);
            if (read == 0) return error.UnexpectedEof;
            used += read;
            const end = std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n") orelse continue;
            var lines = std.mem.splitSequence(u8, buffer[0..end], "\r\n");
            if (!std.mem.eql(u8, lines.next().?, "POST /wallet/estimateenergy HTTP/1.1")) return error.WrongRequestPath;
            var length: ?usize = null;
            var hosts: usize = 0;
            while (lines.next()) |line| {
                const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.BadHeader;
                if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) length = try std.fmt.parseInt(usize, std.mem.trim(u8, line[colon + 1 ..], " "), 10);
                if (std.ascii.eqlIgnoreCase(line[0..colon], "host")) hosts += 1;
            }
            const len = length orelse return error.MissingBody;
            if (len > buffer.len - end - 4) return error.RequestTooLarge;
            if (used - end - 4 < len) continue;
            if (hosts != 1) return error.WrongHostCount;
            // Exact serde TriggerContractRequest fixture, not a second schema.
            const expected = "{\"owner_address\":\"4119e7e376e7c213b7e7e7e46cc70a5d" ++ "d086daff2a\",\"contract_address\":\"41222222222222222222222222222222" ++ "2222222222\",\"data\":\"010203\",\"call_value\":42,\"visible\":false}";
            if (!std.mem.eql(u8, buffer[end + 4 ..][0..len], expected)) return error.WrongTriggerBody;
            break;
        }
        const body = "{\"energy_required\":1234}";
        try conn.stream.writeAll("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 24\r\n\r\n" ++ body);
    }
};
fn loopback(native: ?*@import("../net/curl.zig").Client) !void {
    var server: Server = .{ .listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    defer server.listener.deinit();
    const thread = try std.Thread.spawn(.{}, Server.serve, .{&server});
    defer thread.join();
    const endpoint = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/wallet", .{server.listener.listen_address.getPort()});
    defer a.free(endpoint);
    const http = @import("../cloud/http.zig");
    var transport = http.HttpTransport.init(a);
    defer transport.deinit();
    transport.allow_insecure_loopback = true;
    transport.native_curl = native;
    const owner = try @import("../altvm/tron.zig").secretKeyAddress(.{0x11} ** 32);
    var provider = try p.Provider.init(a, transport.interface(), .{ .rpc_urls = &.{.{ .url = endpoint }}, .wallet_urls = &.{.{ .url = endpoint }}, .wallet_solidity_urls = &.{.{ .url = endpoint }}, .signer_address = owner[1..].* });
    try std.testing.expectEqual(@as(u64, 1234), try provider.estimateEnergy(try provider.trigger(null, .{0x22} ** 20, &.{ 1, 2, 3 }, 42)));
}
test "Tron wallet HTTP loopback matches production serde request and energy response" {
    try loopback(null);
}
test "Tron native wallet HTTP loopback matches production serde request and energy response" {
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_CLOUD_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var client = try @import("../net/curl.zig").Client.init(a, path);
    defer client.deinit();
    try loopback(&client);
}

fn number(value: std.json.Value, name: []const u8) !u64 {
    return std.fmt.parseInt(u64, try rpc.string(try rpc.field(value, name)), 10);
}
fn fixed(comptime N: usize, allocator: std.mem.Allocator, chunks: std.json.Value) ![N]u8 {
    const result = try bytes(allocator, chunks);
    if (result.len != N) return error.InvalidFixture;
    return result[0..N].*;
}
test "Tron sixteen independent tron-rs prost agent transaction fixtures exact bytes hashes signatures and decode" {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/transactions-agent.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var total: usize = 0;
    var parities: u2 = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const alloc = arena.allocator();
        const fixture = (try std.json.parseFromSlice(std.json.Value, alloc, line, .{})).value;
        const input = try rpc.field(fixture, "input");
        const expected = try rpc.field(fixture, "expected");
        const trigger = try rpc.field(input, "trigger");
        const call: tx.Trigger = .{ .owner = try fixed(21, alloc, try rpc.field(trigger, "owner")), .contract = try fixed(21, alloc, try rpc.field(trigger, "contract")), .data = try bytes(alloc, try rpc.field(trigger, "data")), .call_value = try number(trigger, "call_value") };
        const ref: tx.Reference = .{ .block_number = try number(input, "ref_block_number"), .block_hash = try fixed(32, alloc, try rpc.field(input, "block_id")), .timestamp_ms = try number(input, "timestamp_ms"), .expiration_ms = try number(input, "expiration_ms"), .fee_limit = try number(input, "fee_limit") };
        const unsigned = try tx.build(alloc, call, ref);
        try std.testing.expectEqualSlices(u8, try bytes(alloc, try rpc.field(expected, "raw")), unsigned.raw);
        try std.testing.expectEqual(try fixed(32, alloc, try rpc.field(expected, "id")), unsigned.id);
        const signature = try fixed(65, alloc, try rpc.field(expected, "signature"));
        parities |= @as(u2, 1) << @as(u1, @intCast(signature[64] - 27));
        const signed = try tx.encodeSigned(unsigned, signature, 0);
        try std.testing.expectEqualSlices(u8, try bytes(alloc, try rpc.field(expected, "signed")), signed.bytes);
        const decoded = try tx.decodeSigned(signed.bytes);
        try std.testing.expectEqual(unsigned.id, decoded.id);
        try std.testing.expectEqual(ref.block_number, decoded.view.block_number);
        try std.testing.expectEqual(ref.fee_limit, decoded.view.fee_limit);
        try std.testing.expectEqual(ref.timestamp_ms, decoded.view.timestamp_ms);
        try std.testing.expectEqual(ref.expiration_ms, decoded.view.expiration_ms);
        try std.testing.expectEqual(call.call_value, decoded.view.trigger.call_value);
        try std.testing.expectEqualSlices(u8, call.data, decoded.view.trigger.data);
        // Every truncation must fail before a malformed transaction can sign.
        for (0..signed.bytes.len) |end| if (tx.decodeSigned(signed.bytes[0..end])) |_| return error.AcceptedTruncatedTransaction else |_| {};
        total += 1;
    }
    try std.testing.expectEqual(@as(usize, 16), total);
    try std.testing.expectEqual(@as(u2, 3), parities);
}

test "Tron finalized event indexing rejects noncanonical blocks removed logs and unfinalized ranges" {
    const block = try blockFixture();
    defer a.free(block);
    const address = try abi.hexAlloc(a, &(.{0x22} ** 20));
    defer a.free(address);
    const block_id = try abi.hexAlloc(a, &(.{0x33} ** 32));
    defer a.free(block_id);
    const id = try abi.hexAlloc(a, &(.{0x44} ** 32));
    defer a.free(id);
    const topic = try abi.hexAlloc(a, &abi.insertion_topic);
    defer a.free(topic);
    var data: [64]u8 = .{0} ** 64;
    @memset(data[0..32], 0x55);
    data[63] = 1;
    const hex = try abi.hexAlloc(a, &data);
    defer a.free(hex);
    const log = .{ .address = address, .blockHash = block_id, .blockNumber = "0x1e240", .transactionHash = id, .transactionIndex = "0x0", .logIndex = "0x1", .removed = false, .topics = .{topic}, .data = hex };
    const response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 1, .result = .{log} }, .{});
    defer a.free(response);
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .response = block },
        .{ .method = .POST, .suffix = "/jsonrpc", .response = response },
        .{ .method = .POST, .suffix = "/walletsolidity/getblockbynum", .response = block },
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .response = block },
    } };
    var provider = p.testingProvider(script.transport());
    var logs = try provider.logs(.{0x22} ** 20, 123456, 123456, abi.insertion_topic);
    defer logs.deinit();
    try std.testing.expectEqual(@as(usize, 1), logs.items.len);
    try std.testing.expectEqual(@as(u32, 1), (try logs.items[0].event()).insertion.index);
    try std.testing.expectError(error.TronRangeNotFinalized, provider.logs(.{0x22} ** 20, 123456, 123457, abi.insertion_topic));
    try std.testing.expectError(error.InvalidTronLogRange, provider.logs(.{0x22} ** 20, 2, 1, abi.insertion_topic));
    try script.expectDone();
    const wrong_id = try p.unprefixedAlloc(a, &(.{0x66} ** 32));
    defer a.free(wrong_id);
    const wrong_block = try std.json.Stringify.valueAlloc(a, .{ .blockID = wrong_id, .block_header = .{ .raw_data = .{ .number = 123456, .timestamp = 1700000000000 } } }, .{});
    defer a.free(wrong_block);
    // Use the same JSON-RPC log and a disagreeing walletsolidity canonical ID.
    var mismatch: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .response = block },
        .{ .method = .POST, .suffix = "/jsonrpc", .response = response },
        .{ .method = .POST, .suffix = "/walletsolidity/getblockbynum", .response = wrong_block },
    } };
    provider = p.testingProvider(mismatch.transport());
    try std.testing.expectError(error.NoncanonicalTronLog, provider.logs(.{0x22} ** 20, 123456, 123456, abi.insertion_topic));
    try mismatch.expectDone();
    const removed_log = .{ .address = address, .blockHash = block_id, .blockNumber = "0x1e240", .transactionHash = id, .transactionIndex = "0x0", .logIndex = "0x1", .removed = true, .topics = .{topic}, .data = hex };
    const removed_response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = 1, .result = .{removed_log} }, .{});
    defer a.free(removed_response);
    var removed: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/getnowblock", .response = block },
        .{ .method = .POST, .suffix = "/jsonrpc", .response = removed_response },
    } };
    provider = p.testingProvider(removed.transport());
    try std.testing.expectError(error.RemovedLog, provider.logs(.{0x22} ** 20, 123456, 123456, abi.insertion_topic));
    try removed.expectDone();
}

test "Tron typed wallet response deserialization falls back before accepting malformed schema" {
    var script: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/first/estimateenergy", .response = "{\"energy_required\":\"invalid string\"}" },
        .{ .method = .POST, .suffix = "/second/estimateenergy", .response = "{\"energy_required\":1000}" },
    } };
    var provider = p.testingProvider(script.transport());
    provider.wallet.endpoints = &.{ .{ .url = "https://fixture/first" }, .{ .url = "https://fixture/second" } };
    try std.testing.expectEqual(@as(u64, 1000), try provider.estimateEnergy(try provider.trigger(null, .{0x22} ** 20, "", 0)));
    try script.expectDone();
}

test "Tron broad prost decoder accepts syntax and explicitly rejects unsupported token fields" {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("fixtures/transactions.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const fixture = (try std.json.parseFromSlice(std.json.Value, allocator, line, .{})).value;
        const input = try rpc.field(fixture, "input");
        const trigger = try rpc.field(input, "trigger");
        const encoded = try bytes(allocator, try rpc.field(try rpc.field(fixture, "expected"), "signed"));
        if (try number(trigger, "token_id") != 0 or try number(trigger, "call_token_value") != 0) try std.testing.expectError(error.UnsupportedTronTokenTransfer, tx.decodeSigned(encoded)) else {
            const decoded = try tx.decodeSigned(encoded);
            try std.testing.expectEqual(try number(input, "timestamp_ms"), decoded.view.timestamp_ms);
        }
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 16), count);
}
