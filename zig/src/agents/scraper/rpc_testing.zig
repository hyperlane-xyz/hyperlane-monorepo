const std = @import("std");
const evm = @import("evm.zig");
const src = @import("source.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const receipt = @import("receipts_evm.zig");
const enrich = @import("enrichment.zig");
const Step = struct { method: []const u8, response: []const u8, rpc: bool = true, path: ?[]const u8 = null };
const Fixture = struct {
    server: std.net.Server,
    steps: []const Step,
    expected_hash: src.Hash,
    filter_addresses: usize = 3,
    filter_topics: usize = 4,
    fn serve(self: *Fixture) void {
        self.run() catch @panic("scraper EVM fixture failed");
    }
    fn run(self: *Fixture) !void {
        for (self.steps) |step| {
            const connection = try self.server.accept();
            defer connection.stream.close();
            var buffer: [32768]u8 = undefined;
            var used: usize = 0;
            var id: i64 = 0;
            while (true) {
                const count = try connection.stream.read(buffer[used..]);
                if (count == 0) return error.FixtureEof;
                used += count;
                const end = std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n") orelse continue;
                var lines = std.mem.splitSequence(u8, buffer[0..end], "\r\n");
                const request_line = lines.next().?;
                if (step.path) |path| try std.testing.expect(std.mem.indexOf(u8, request_line, path) != null);
                var length: ?usize = null;
                while (lines.next()) |line| {
                    const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.FixtureBadHeader;
                    if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) length = try std.fmt.parseInt(usize, std.mem.trim(u8, line[colon + 1 ..], " \t"), 10);
                }
                const len = length orelse return error.FixtureMissingLength;
                if (used < end + 4 + len) continue;
                const request = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, buffer[end + 4 ..][0..len], .{});
                defer request.deinit();
                if (!step.rpc) break;
                try std.testing.expectEqualStrings(step.method, request.value.object.get("method").?.string);
                id = request.value.object.get("id").?.integer;
                const actual_params = request.value.object.get("params").?;
                const params = if (actual_params == .array) actual_params.array.items else &[_]std.json.Value{};
                if (std.mem.eql(u8, step.method, "tx")) {
                    try std.testing.expectEqual(@as(usize, 44), actual_params.object.get("hash").?.string.len);
                    try std.testing.expect(!actual_params.object.get("prove").?.bool);
                }
                if (std.mem.eql(u8, step.method, "getTransaction")) {
                    try std.testing.expectEqualStrings("jsonParsed", params[1].object.get("encoding").?.string);
                    try std.testing.expectEqualStrings("finalized", params[1].object.get("commitment").?.string);
                }
                if (std.mem.eql(u8, step.method, "eth_call") or std.mem.eql(u8, step.method, "eth_getCode")) {
                    const actual = params[1].object.get("blockHash").?.string;
                    try std.testing.expectEqual(self.expected_hash, try abi.fixedHex(32, actual));
                }
                if (std.mem.eql(u8, step.method, "eth_getLogs")) {
                    const filter = params[0].object;
                    try std.testing.expectEqual(self.filter_addresses, filter.get("address").?.array.items.len);
                    const topic = filter.get("topics").?.array.items[0];
                    try std.testing.expectEqual(self.filter_topics, if (topic == .array) topic.array.items.len else @as(usize, 1));
                }
                break;
            }
            const body = if (!step.rpc) try std.testing.allocator.dupe(u8, step.response) else try std.fmt.allocPrint(std.testing.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, step.response });
            defer std.testing.allocator.free(body);
            var header: [160]u8 = undefined;
            try connection.stream.writeAll(try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{body.len}));
            try connection.stream.writeAll(body);
        }
    }
};
fn hash(byte: u8) src.Hash {
    return .{byte} ** 32;
}
test "scraper concrete EVM combined logs and historical counts use real JSON RPC wire" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const boundary = hash(2);
    const parent = hash(1);
    const txn = hash(3);
    const hook = [_]u8{0x22} ** 20;
    const block = try std.json.Stringify.valueAlloc(a, .{ .number = "0x2", .hash = try abi.hexAlloc(a, &boundary), .parentHash = try abi.hexAlloc(a, &parent), .timestamp = "0x1" }, .{});
    const count = try std.json.Stringify.valueAlloc(a, try abi.hexAlloc(a, &([_]u8{0} ** 31 ++ .{1})), .{});
    const data = hash(4) ++ ([_]u8{0} ** 32);
    const logs = try std.json.Stringify.valueAlloc(a, [_]@TypeOf(.{ .address = try abi.hexAlloc(a, &hook), .topics = [_][]const u8{try abi.hexAlloc(a, &abi.insertion_topic)}, .data = try abi.hexAlloc(a, &data), .blockNumber = "0x2", .blockHash = try abi.hexAlloc(a, &boundary), .transactionHash = try abi.hexAlloc(a, &txn), .transactionIndex = "0x0", .logIndex = "0x0", .removed = false }){.{ .address = try abi.hexAlloc(a, &hook), .topics = .{try abi.hexAlloc(a, &abi.insertion_topic)}, .data = try abi.hexAlloc(a, &data), .blockNumber = "0x2", .blockHash = try abi.hexAlloc(a, &boundary), .transactionHash = try abi.hexAlloc(a, &txn), .transactionIndex = "0x0", .logIndex = "0x0", .removed = false }}, .{});
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{ .{ .method = "eth_getBlockByNumber", .response = block }, .{ .method = "eth_call", .response = count }, .{ .method = "eth_call", .response = count }, .{ .method = "eth_getLogs", .response = logs } }, .expected_hash = boundary };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    var client = try rpc.RpcClient.init(std.testing.allocator, url, .{});
    defer client.deinit();
    var source: evm.Evm = .{ .rpc_client = &client, .domain = 1, .contracts = .{ .mailbox = .{0} ** 12 ++ .{0x11} ** 20, .hook = .{0} ** 12 ++ hook, .paymaster = .{0} ** 12 ++ .{0x33} ** 20 } };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    const interface = source.interface();
    const header = try interface.header(.{ .height = 2 });
    try std.testing.expectEqual(boundary, header.hash);
    try std.testing.expectEqual([2]u32{ 1, 1 }, (try interface.counts(boundary)).?);
    var batch = try interface.events(std.testing.allocator, 1, 2, .{0} ** 4);
    defer batch.deinit();
    try std.testing.expectEqual(@as(usize, 1), batch.events.len);
    try std.testing.expectEqual(@as(u32, 0), batch.events[0].data.insertion.index);
}

test "scraper EVM receipt fetch binds transaction block and shared absolute budget" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const boundary = hash(2);
    const txhash = hash(3);
    const from = [_]u8{0x11} ** 20;
    const transaction = try std.json.Stringify.valueAlloc(a, .{ .hash = try abi.hexAlloc(a, &txhash), .blockHash = try abi.hexAlloc(a, &boundary), .blockNumber = "0x2", .gas = "0x5208", .gasPrice = "0x7", .nonce = "0x4", .from = try abi.hexAlloc(a, &from), .to = @as(?[]const u8, null), .input = "0x0102" }, .{});
    const included = try std.json.Stringify.valueAlloc(a, .{ .transactionHash = try abi.hexAlloc(a, &txhash), .blockHash = try abi.hexAlloc(a, &boundary), .blockNumber = "0x2", .gasUsed = "0x5000", .cumulativeGasUsed = "0x6000", .effectiveGasPrice = "0x7" }, .{});
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{ .{ .method = "eth_getTransactionByHash", .response = transaction }, .{ .method = "eth_getTransactionReceipt", .response = included } }, .expected_hash = boundary };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    var client = try rpc.RpcClient.init(std.testing.allocator, url, .{});
    defer client.deinit();
    var fetcher: receipt.Evm = .{ .rpc_client = &client, .allow_std_fixture = true };
    const meta: enrich.Meta = .{ .block_number = 2, .block_hash = boundary, .tx_hash = .{0} ** 32 ++ txhash };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    var owned = try fetcher.interface().fetch(std.testing.allocator, meta, (try receipt.nowNs()) + 1000000000);
    defer owned.deinit();
    try std.testing.expectEqual(@as(u256, 21000), owned.value.gas_limit);
    try std.testing.expectEqual(@as(u256, 20480), owned.value.gas_used);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2 }, owned.value.raw_input.?);
    try std.testing.expectEqual(@as(u32, 30000), client.options.timeout_ms);
    try std.testing.expectError(error.ScraperReceiptDeadline, fetcher.interface().fetch(std.testing.allocator, meta, (try receipt.nowNs()) - 1));
}

const CcrLog = struct { address: []const u8, topics: []const []const u8, data: []const u8, blockNumber: []const u8 = "0x2", blockHash: []const u8, transactionHash: []const u8, transactionIndex: []const u8 = "0x0", logIndex: []const u8 };
fn ccrLog(a: std.mem.Allocator, contract: [20]u8, topics: []const src.Hash, index: u64, data: []const u8) !CcrLog {
    const encoded = try a.alloc([]const u8, topics.len);
    for (topics, encoded) |topic, *out| out.* = try abi.hexAlloc(a, &topic);
    return .{ .address = try abi.hexAlloc(a, &contract), .topics = encoded, .data = try abi.hexAlloc(a, data), .blockHash = try abi.hexAlloc(a, &hash(2)), .transactionHash = try abi.hexAlloc(a, &hash(3)), .logIndex = try abi.quantityAlloc(a, index) };
}
test "scraper CCR concrete RPC pairs latest preceding transfer and exact collateral" {
    const ccr = @import("ccr.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const router_a = [_]u8{0x11} ** 20;
    const router_b = [_]u8{0x22} ** 20;
    const router_c = [_]u8{0x33} ** 20;
    const token_a = [_]u8{0x44} ** 20;
    const token_b = [_]u8{0x55} ** 20;
    const token_c = [_]u8{0x66} ** 20;
    const padded_a = [_]u8{0} ** 12 ++ router_a;
    const padded_c = [_]u8{0} ** 12 ++ router_c;
    const origin = [_]u8{0} ** 31 ++ .{1};
    const recipient = hash(9);
    const amount = [_]u8{0} ** 31 ++ .{7};
    const candidate = try ccrLog(a, router_b, &.{ ccr.received_topic, origin, recipient }, 7, &amount);
    const candidates = try std.json.Stringify.valueAlloc(a, [_]CcrLog{candidate}, .{});
    const receipt_logs = [_]CcrLog{ try ccrLog(a, token_a, &.{ ccr.transfer_topic, hash(0), padded_a }, 1, &amount), try ccrLog(a, token_c, &.{ ccr.transfer_topic, hash(0), padded_c }, 5, &amount), try ccrLog(a, token_b, &.{ ccr.transfer_topic, hash(0), padded_a }, 6, &amount), candidate, try ccrLog(a, token_a, &.{ ccr.transfer_topic, hash(0), padded_a }, 8, &amount) };
    const receipt_json = try std.json.Stringify.valueAlloc(a, .{ .transactionHash = try abi.hexAlloc(a, &hash(3)), .blockHash = try abi.hexAlloc(a, &hash(2)), .blockNumber = "0x2", .logs = receipt_logs }, .{});
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{ .{ .method = "eth_getLogs", .response = candidates }, .{ .method = "eth_getTransactionReceipt", .response = receipt_json } }, .expected_hash = hash(2), .filter_topics = 1 };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    var client = try rpc.RpcClient.init(std.testing.allocator, url, .{});
    defer client.deinit();
    const routers = [_]ccr.Router{ .{ .address = router_a, .token = token_a }, .{ .address = router_b, .token = token_b }, .{ .address = router_c, .token = token_c } };
    var source: ccr.Evm = .{ .rpc_client = &client, .domain = 1, .routers = &routers };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    var plan = try source.plan(std.testing.allocator, 1, 2);
    defer plan.deinit();
    try std.testing.expectEqual(@as(usize, 1), plan.requests.len);
    var receipt_result = try source.receipt(std.testing.allocator, plan.requests[0]);
    defer receipt_result.deinit();
    const swap = (try ccr.assemble(1, &routers, plan.candidates[0], receipt_result)).?;
    try std.testing.expectEqual(padded_c, swap.source_router);
    try std.testing.expectEqual(@as(u256, 7), swap.amount);
    const lane: ccr.Lane = .{ .from = 2, .chunk = 10 };
    try std.testing.expectEqual(ccr.Range{ .from = 2, .through = 5 }, (try lane.next(5, 7)).?);
}

test "scraper Tron concrete receipt uses production JSON RPC pool with owned bounded HTTP and restores transport" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const txhash = hash(3);
    const boundary = hash(2);
    const transaction = try std.json.Stringify.valueAlloc(a, .{ .hash = try abi.hexAlloc(a, &txhash), .blockHash = try abi.hexAlloc(a, &boundary), .blockNumber = "0x2", .gas = "0x5208", .gasPrice = "0x7", .nonce = "0x4", .from = "0x1111111111111111111111111111111111111111", .to = @as(?[]const u8, null), .input = "0x0102" }, .{});
    const included = try std.json.Stringify.valueAlloc(a, .{ .transactionHash = try abi.hexAlloc(a, &txhash), .blockHash = try abi.hexAlloc(a, &boundary), .blockNumber = "0x2", .gasUsed = "0x5000", .cumulativeGasUsed = "0x6000", .effectiveGasPrice = "0x7" }, .{});
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{ .{ .method = "eth_getTransactionByHash", .response = transaction }, .{ .method = "eth_getTransactionReceipt", .response = included } }, .expected_hash = boundary };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    const http = @import("../../cloud/http.zig");
    var owner = http.HttpTransport.init(std.testing.allocator);
    defer owner.deinit();
    owner.allow_insecure_loopback = true;
    const endpoint = [_]@import("../../tron/rpc.zig").Endpoint{.{ .url = url }};
    var provider = try @import("../../tron/provider.zig").Provider.init(std.testing.allocator, owner.interface(), .{ .rpc_urls = &endpoint, .wallet_urls = &endpoint, .wallet_solidity_urls = &endpoint });
    var fetcher: @import("receipts_tron.zig").Tron = .{ .provider = &provider, .http_owner = &owner, .allow_std_fixture = true };
    const meta: enrich.Meta = .{ .block_number = 2, .block_hash = boundary, .tx_hash = .{0} ** 32 ++ txhash };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    var result = try fetcher.interface().fetch(std.testing.allocator, meta, try receipt.nowNs() + 1000000000);
    defer result.deinit();
    try std.testing.expectEqual(@as(u256, 21000), result.value.gas_limit);
    try std.testing.expectEqual(@as(u256, 20480), result.value.gas_used);
    try std.testing.expect(provider.jsonrpc.transport.context == owner.interface().context);
    try std.testing.expectEqual(@as(u32, 30000), owner.timeout_ms);
    try std.testing.expectError(error.ScraperReceiptDeadline, fetcher.interface().fetch(std.testing.allocator, meta, try receipt.nowNs() - 1));
}

test "scraper Sealevel concrete receipt fetch requests parsed finalized transaction and validates source identity" {
    const provider = @import("../../sealevel/provider.zig");
    const bytes = try @import("../../testing/fixture.zig").bytes(std.testing.allocator, @embedFile("fixtures/svm-receipt-solana.json.gz"), 16 * 1024 * 1024);
    defer std.testing.allocator.free(bytes);
    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, bytes, .{});
    defer parsed.deinit();
    const value = parsed.value;
    const tx = value.object.get("transaction").?;
    const signature = tx.object.get("signatures").?.array.items[0].string;
    const raw = try @import("../../altvm/base58.zig").decode(std.testing.allocator, signature);
    defer std.testing.allocator.free(raw);
    const meta: enrich.Meta = .{ .block_number = try provider.uint(value.object.get("slot").?), .block_hash = hash(9), .tx_hash = raw[0..64].* };
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{.{ .method = "getTransaction", .response = bytes }}, .expected_hash = meta.block_hash };
    defer fixture.server.deinit();
    var buffer: [128]u8 = undefined;
    const url = try std.fmt.bufPrint(&buffer, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    var client = try provider.Client.init(std.testing.allocator, url, .{});
    defer client.deinit();
    const programs = [_][32]u8{try provider.decodeKey(std.testing.allocator, "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi")};
    var fetcher: @import("receipts_sealevel.zig").Sealevel = .{ .client = &client, .programs = &programs, .native_decimals = 9, .allow_std_fixture = true };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    var result = try fetcher.interface().fetch(std.testing.allocator, meta, try receipt.nowNs() + std.time.ns_per_s);
    defer result.deinit();
    try std.testing.expectEqual(@as(u256, 204784), result.value.gas_limit);
    try std.testing.expectEqual(@as(u32, 30000), client.rpc_client.options.timeout_ms);
    try std.testing.expectError(error.ScraperReceiptDeadline, fetcher.interface().fetch(std.testing.allocator, meta, try receipt.nowNs() - 1));
}

test "scraper Cosmos concrete receipt fetch uses Tendermint base64 transaction query and shared deadline" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const sdk = try @import("../../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../../altvm/fixtures/sdk.json.gz"), .{});
    const encoded = sdk.value.object.get("cosmos").?.object.get("raw").?.string;
    const raw = try a.alloc(u8, encoded.len / 2);
    _ = try std.fmt.hexToBytes(raw, encoded);
    var hash_: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &hash_, .{});
    const base64 = try a.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
    _ = std.base64.standard.Encoder.encode(base64, raw);
    const response = try std.json.Stringify.valueAlloc(a, .{ .hash = try @import("../../cosmos/types.zig").hex(a, &hash_), .height = "2", .tx = base64, .tx_result = .{ .code = 0, .gas_wanted = "210000", .gas_used = "45678" } }, .{});
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{.{ .method = "tx", .response = response }}, .expected_hash = hash(2) };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    var client = try rpc.RpcClient.init(std.testing.allocator, url, .{});
    defer client.deinit();
    var fetcher: @import("receipts_cosmos.zig").Cosmos = .{ .client = .{ .rpc_client = &client, .chain_id = "cosmoshub-4", .compat = .v037 }, .config = .{ .bech32_prefix = "cosmos", .native_denom = "uatom", .gas_denom = "uatom", .native_decimals = 6 }, .allow_std_fixture = true };
    const meta: enrich.Meta = .{ .block_number = 2, .block_hash = hash(2), .tx_hash = .{0} ** 32 ++ hash_ };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    var result = try fetcher.interface().fetch(std.testing.allocator, meta, try receipt.nowNs() + std.time.ns_per_s);
    defer result.deinit();
    try std.testing.expectEqual(@as(u64, 7), result.value.nonce);
    try std.testing.expectEqual(@as(u32, 30000), client.options.timeout_ms);
}

test "scraper Radix concrete receipt fetch uses actual Gateway committed route and intent identity" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const address = @import("../../radix/address.zig");
    const fixture_data = try @import("../../testing/fixture.zig").parse(std.json.Value, a, @embedFile("fixtures/radix-receipt-manifests.json.gz"), .{});
    const account = fixture_data.value.object.get("account_text").?.string;
    const manifest = try std.fmt.allocPrint(a, "CALL_METHOD Address(\"{s}\") \"lock_fee\" Decimal(\"1.5\");", .{account});
    const intent_hash = hash(3);
    var buffer: [160]u8 = undefined;
    const intent = try address.encode(.mainnet, "txid", &intent_hash, &buffer);
    const response = try std.json.Stringify.valueAlloc(a, .{ .ledger_state = .{ .network = "mainnet", .state_version = 100, .epoch = 1 }, .transaction = .{ .state_version = 100, .intent_hash = intent, .manifest_instructions = manifest, .fee_paid = "1.5", .receipt = .{ .fee_summary = .{ .execution_cost_units_consumed = 20, .finalization_cost_units_consumed = 3 } } } }, .{});
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &.{.{ .method = "", .rpc = false, .path = "/transaction/committed-details", .response = response }}, .expected_hash = hash(2) };
    defer fixture.server.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    var owner = @import("../../cloud/http.zig").HttpTransport.init(std.testing.allocator);
    defer owner.deinit();
    owner.allow_insecure_loopback = true;
    const client: @import("../../radix/provider.zig").Client = .{ .allocator = std.testing.allocator, .transport = owner.interface(), .network = .mainnet, .confirmations = 0, .core = .{ .url = url }, .gateway = .{ .url = url } };
    var fetcher: @import("receipts_radix.zig").Radix = .{ .client = client, .http_owner = &owner, .allow_std_fixture = true };
    var block_hash: [32]u8 = .{0} ** 32;
    std.mem.writeInt(u64, block_hash[24..], 100, .big);
    const meta: enrich.Meta = .{ .block_number = 100, .block_hash = block_hash, .tx_hash = .{0} ** 32 ++ intent_hash };
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer thread.join();
    var result = try fetcher.interface().fetch(std.testing.allocator, meta, try receipt.nowNs() + std.time.ns_per_s);
    defer result.deinit();
    try std.testing.expectEqual(@as(u256, 23), result.value.gas_limit);
    try std.testing.expect(fetcher.client.transport.context == owner.interface().context);
    try std.testing.expectEqual(@as(u32, 30000), owner.timeout_ms);
}
