const std = @import("std");
const health = @import("health_provider.zig");
const rpc = @import("../evm/provider.zig");
const http = @import("../cloud/http.zig");
const types = @import("../settings/types.zig");
const cosmos_json = @import("../cosmos/types.zig");
const a = std.testing.allocator;
const Mock = struct {
    method: []const u8 = "",
    params: ?[]const u8 = null,
    result: []const u8 = "null",
    route: ?[]const u8 = null,
    calls: usize = 0,
    fn cast(ctx: *anyopaque) *Mock {
        return @ptrCast(@alignCast(ctx));
    }
    fn wire(self: *Mock, allocator: std.mem.Allocator, body: []const u8) !rpc.WireResponse {
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings(self.method, (try cosmos_json.field(parsed.value, "method")).string);
        if (self.params) |params| {
            const actual = try std.json.Stringify.valueAlloc(allocator, try cosmos_json.field(parsed.value, "params"), .{});
            defer allocator.free(actual);
            try std.testing.expectEqualStrings(params, actual);
        }
        const id = try cosmos_json.uint(try cosmos_json.field(parsed.value, "id"));
        const out = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, self.result });
        self.calls += 1;
        return .{ .bytes = out, .len = out.len };
    }
    fn exchange(ctx: *anyopaque, allocator: std.mem.Allocator, body: []const u8, _: rpc.Options) !rpc.WireResponse {
        return cast(ctx).wire(allocator, body);
    }
    fn send(ctx: *anyopaque, allocator: std.mem.Allocator, request: http.Request) !http.Response {
        const self = cast(ctx);
        if (self.route) |route| {
            try std.testing.expect(std.mem.endsWith(u8, request.url, route));
            self.calls += 1;
            if (self.params) |expected| {
                var expected_json = try std.json.parseFromSlice(std.json.Value, allocator, expected, .{});
                defer expected_json.deinit();
                var actual = try std.json.parseFromSlice(std.json.Value, allocator, request.body.?, .{});
                defer actual.deinit();
                const actual_wire = try std.json.Stringify.valueAlloc(allocator, actual.value, .{});
                defer allocator.free(actual_wire);
                const expected_wire = try std.json.Stringify.valueAlloc(allocator, expected_json.value, .{});
                defer allocator.free(expected_wire);
                try std.testing.expectEqualStrings(expected_wire, actual_wire);
            }
            return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, self.result) };
        }
        const response_wire = try self.wire(allocator, request.body.?);
        return .{ .allocator = allocator, .status = 200, .bytes = response_wire.bytes };
    }
    fn transport(self: *Mock) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn options(self: *Mock) rpc.Options {
        return .{ .exchange = .{ .context = self, .fetch_fn = exchange } };
    }
};

test "health provider Ethereum uses latest base fee not gasPrice, null block stays absent, balance exact request" {
    var mock: Mock = .{ .method = "eth_getBlockByNumber", .params = "[\"latest\",false]", .result = "{\"number\":\"0x10\",\"hash\":\"0x" ++ "11" ** 32 ++ "\",\"parentHash\":\"0x" ++ "22" ** 32 ++ "\",\"timestamp\":\"0x1\",\"baseFeePerGas\":\"0x123\"}" };
    var client = try rpc.RpcClient.init(a, "https://fixture.invalid", mock.options());
    defer client.deinit();
    try std.testing.expectEqual(@as(?u256, 0x123), (try health.queryChain(.{ .ethereum = &client })).?.min_gas_price);
    mock.result = "null";
    try std.testing.expectEqual(@as(?@import("health_metrics.zig").ChainInfo, null), try health.queryChain(.{ .ethereum = &client }));
    mock.result = "{\"number\":\"0x11\",\"hash\":\"0x" ++ "11" ** 32 ++ "\",\"parentHash\":\"0x" ++ "22" ** 32 ++ "\",\"timestamp\":\"0x1\"}";
    try std.testing.expectEqual(@as(?u256, null), (try health.queryChain(.{ .ethereum = &client })).?.min_gas_price);
    mock.method = "eth_getBalance";
    mock.params = "[\"0x1111111111111111111111111111111111111111\",\"latest\"]";
    mock.result = "\"0x100\"";
    var chain: types.Chain = undefined;
    try std.testing.expectEqual(@as(u256, 256), try health.queryBalance(a, .{ .ethereum = &client }, &chain, "0x1111111111111111111111111111111111111111"));
}

test "health provider Sealevel finalized slot and processed wallet balance preserve distinct Source commitments" {
    var mock: Mock = .{ .method = "getSlot", .params = "[{\"commitment\":\"finalized\"}]", .result = "99" };
    var client = try @import("../sealevel/provider.zig").Client.init(a, "https://fixture.invalid", mock.options());
    defer client.deinit();
    client.commitment = .confirmed; // Source monitor still uses finalized.
    try std.testing.expectEqual(@as(u64, 99), (try health.queryChain(.{ .sealevel = &client })).?.block_height);
    mock.method = "getBalance";
    mock.params = "[\"11111111111111111111111111111111\",{\"commitment\":\"processed\"}]";
    mock.result = "{\"context\":{\"slot\":100},\"value\":234}";
    var chain: types.Chain = undefined;
    try std.testing.expectEqual(@as(u256, 234), try health.queryBalance(a, .{ .sealevel = &client }, &chain, "11111111111111111111111111111111"));
    var identity = try @import("../net/read_replay.zig").requestIdentity(a, "{\"jsonrpc\":\"2.0\",\"method\":\"getBalance\",\"params\":[],\"id\":1}", 1024);
    _ = &identity;
}

test "health provider Cosmos and CosmosNative use latest Tendermint block, canonical asset ABCI protobuf" {
    var mock: Mock = .{ .method = "block", .params = "{\"height\":null}", .result = "{\"block\":{\"header\":{\"chain_id\":\"cosmos-test\",\"height\":\"74\"}}}" };
    var client = try rpc.RpcClient.init(a, "https://fixture.invalid", mock.options());
    defer client.deinit();
    const clients: @import("scraper/factory.zig").Clients = .{ .cosmos = .{ .tendermint = .{ .rpc_client = &client, .chain_id = "cosmos-test", .compat = .v038 }, .queries = undefined } };
    try std.testing.expectEqual(@as(u64, 74), (try health.queryChain(clients)).?.block_height);
    const config: types.Cosmos = .{ .chain_id = "cosmos-test", .bech32_prefix = "cosmos", .gas_price = .{ .amount = "1", .denom = "ugastoken" }, .contract_address_bytes = 32, .gas_multiplier = 1, .compat_mode = null, .canonical_asset = "ucanonical" };
    var address: [128]u8 = undefined;
    const text = try @import("../altvm/bech32.zig").encode("cosmos", &(.{1} ** 20), &address);
    const proto = @import("../cosmos/proto.zig");
    const request = try proto.queryPair(a, text, "ucanonical");
    defer a.free(request);
    const data = try cosmos_json.hex(a, request);
    defer a.free(data);
    for (data) |*byte| byte.* = std.ascii.toUpper(byte.*);
    const params = try std.json.Stringify.valueAlloc(a, .{ .path = proto.paths.balance, .data = data, .prove = false }, .{});
    defer a.free(params);
    mock.method = "abci_query";
    mock.params = params;
    // QueryBalanceResponse.balance = Coin{denom:"ucanonical",amount:"123"}.
    const coin = try proto.queryPair(a, "ucanonical", "123");
    defer a.free(coin);
    var out: [128]u8 = undefined;
    var encoder: @import("../altvm/protobuf.zig").Encoder = .{ .out = &out };
    try encoder.message(1, coin);
    var base64: [192]u8 = undefined;
    const value = std.base64.standard.Encoder.encode(&base64, encoder.written());
    const result = try std.fmt.allocPrint(a, "{{\"response\":{{\"code\":0,\"height\":\"75\",\"value\":\"{s}\"}}}}", .{value});
    defer a.free(result);
    mock.result = result;
    var chain: types.Chain = undefined;
    chain.connection = .{ .cosmos = config };
    try std.testing.expectEqual(@as(u256, 123), try health.queryBalance(a, clients, &chain, text));
    chain.connection = .{ .cosmosnative = config };
    try std.testing.expectEqual(@as(u256, 123), try health.queryBalance(a, clients, &chain, text));
    mock.result = "{\"response\":{\"code\":0,\"height\":\"75\",\"value\":\"\"}}";
    try std.testing.expectError(error.MissingHealthBalance, health.queryBalance(a, clients, &chain, text));
}

test "health provider Radix Gateway tip, account XRD balance call and Decimal attos use Source routes" {
    var mock: Mock = .{ .route = "/status/gateway-status", .result = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":55,\"epoch\":4}}" };
    const client: @import("../radix/provider.zig").Client = .{ .allocator = a, .transport = mock.transport(), .core = .{ .url = "https://core.invalid" }, .gateway = .{ .url = "https://gateway.invalid" }, .network = .mainnet, .confirmations = 4 };
    try std.testing.expectEqual(@as(u64, 55), (try health.queryChain(.{ .radix = client })).?.block_height);
    var account_text: [160]u8 = undefined;
    const account = try @import("../radix/address.zig").encode(.mainnet, "account", &(.{0xc1} ++ .{0} ** 29), &account_text);
    mock.route = "/transaction/call-preview";
    const sbor = @import("../radix/sbor.zig");
    var writer: sbor.Writer = .{ .allocator = a };
    defer writer.deinit();
    try writer.byte(0x5c);
    try writer.byte(0xa0);
    var amount: [24]u8 = undefined;
    std.mem.writeInt(i192, &amount, 123000, .little);
    try writer.raw(&amount);
    const hex = try cosmos_json.hex(a, writer.list.items);
    defer a.free(hex);
    const response = try std.fmt.allocPrint(a, "{{\"status\":\"Succeeded\",\"at_ledger_state\":{{\"state_version\":54}},\"output\":{{\"hex\":\"{s}\"}}}}", .{hex});
    defer a.free(response);
    mock.result = response;
    var chain: types.Chain = undefined;
    try std.testing.expectEqual(@as(u256, 123000), try health.queryBalance(a, .{ .radix = client }, &chain, account));
}

test "health provider Tron solidity head and eth balance, Starknet block number/fee token balance and Aleo latest height" {
    var mock: Mock = .{ .route = "/walletsolidity/getnowblock", .result = "{\"blockID\":\"" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000000" ++ "\",\"block_header\":{\"raw_data\":{\"number\":82,\"timestamp\":10}}}" };
    const endpoints = [_]@import("../net/endpoint.zig").Endpoint{.{ .url = "https://fixture.invalid" }};
    var tron: @import("../tron/provider.zig").Provider = try @import("../tron/provider.zig").Provider.init(a, mock.transport(), .{ .rpc_urls = &endpoints, .wallet_urls = &endpoints, .wallet_solidity_urls = &.{.{ .url = "https://fixture.invalid/walletsolidity" }} });
    try std.testing.expectEqual(@as(u64, 82), (try health.queryChain(.{ .tron = &tron })).?.block_height);
    mock.route = null;
    mock.method = "eth_getBalance";
    mock.params = "[\"0x1111111111111111111111111111111111111111\",\"latest\"]";
    mock.result = "\"0x123\"";
    var chain: types.Chain = undefined;
    try std.testing.expectEqual(@as(u256, 0x123), try health.queryBalance(a, .{ .tron = &tron }, &chain, "0x1111111111111111111111111111111111111111"));
    var stark: @import("scraper/starknet.zig").Factory = undefined;
    stark.provider = .{ .allocator = a, .client = try @import("../net/json_rpc.zig").Client.init(a, mock.transport(), &endpoints, .{}) };
    mock.method = "starknet_blockNumber";
    mock.params = "[]";
    mock.result = "64";
    try std.testing.expectEqual(@as(u64, 64), (try health.queryChain(.{ .starknet = &stark })).?.block_height);
    chain.connection = .{ .starknet = .{ .native_token = .{0} ** 31 ++ .{5} } };
    mock.method = "starknet_call";
    mock.params = null;
    mock.result = "[\"0x7\",\"0x0\"]";
    try std.testing.expectEqual(@as(u256, 7), try health.queryBalance(a, .{ .starknet = &stark }, &chain, "0x2"));
    var aleo: @import("scraper/aleo.zig").Factory = undefined;
    aleo.provider = .{ .client = try @import("../aleo/rest.zig").Client.init(a, mock.transport(), &endpoints, 0), .native = undefined };
    mock.route = "/mainnet/block/height/latest";
    mock.params = null;
    mock.result = "101";
    try std.testing.expectEqual(@as(u64, 101), (try health.queryChain(.{ .aleo = &aleo })).?.block_height);
}

fn nativeReply(allocator: std.mem.Allocator, request: []const u8) ![]u8 {
    var body = try std.json.parseFromSlice(std.json.Value, allocator, request, .{});
    defer body.deinit();
    try std.testing.expectEqualStrings("eth_getBlockByNumber", (try cosmos_json.field(body.value, "method")).string);
    return std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = try cosmos_json.field(body.value, "id"), .result = .{ .number = "0x20", .hash = "0x" ++ "11" ** 32, .parentHash = "0x" ++ "22" ** 32, .timestamp = "0x1", .baseFeePerGas = "0x10" } }, .{});
}

test "health native monitor construction reads no key/network, cooperative completion emits only physical agent_metrics requests" {
    const fixture = @import("../evm/pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = nativeReply }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chain = @import("chain_source_testing.zig").chainFor(&.{url});
    chain.signer = .{ .gcp = .{ .key_version_name = "not-accessed" } };
    chain.identity = chain.signer;
    chain.ccs_signer = chain.signer;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const registry = try @import("../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    var budget: @import("../net/byte_budget.zig").Budget = .{ .maximum = 1024 * 1024 };
    const adapter = try health.Adapter.openFromSettings(a, &chain, &environment, .{ .curl_library = library, .allow_insecure_loopback = true, .metrics = registry, .read_budget = &budget, .rpc_max_response_bytes = 65536 });
    defer adapter.deinit();
    try std.testing.expect(adapter.owner.chain.signer == null and adapter.owner.chain.identity == null and adapter.owner.chain.ccs_signer == null);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    const common = @import("health_metrics.zig");
    const task = try common.CommonMonitorTask.open(a, registry, adapter.interface(), .{ .protocol = .ethereum, .chain = chain.name, .agent_name = "relayer", .native_decimals = 18 });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var completed: usize = 0;
    var pending: usize = 0;
    var timer = try std.time.Timer.start();
    while (completed < 2) {
        const report = task.step(0, &cancel) catch |err| {
            if (err != error.PendingReadIo) return err;
            pending += 1;
            if (timer.read() > 3 * std.time.ns_per_s) return error.HealthNativeFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        completed += @intCast(report.work);
    }
    try std.testing.expect(pending >= 2);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    const rendered = try registry.render(a);
    defer a.free(rendered);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "operation=\"agent_metrics\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "operation=\"contract_sync\"") == null);
    var total: u64 = 0;
    var lines = std.mem.splitScalar(u8, rendered, '\n');
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, "hyperlane_request_count{")) {
        total += try std.fmt.parseInt(u64, line[std.mem.lastIndexOfScalar(u8, line, ' ').? + 1 ..], 10);
    };
    try std.testing.expectEqual(@as(u64, 2), total);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_wallet_balance{") == null);
    try server.check();
}

test "health Aleo public address balance uses actual native decoder and Source absent credits mapping zero" {
    const path = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(path);
    var crypto = try @import("../aleo/crypto.zig").Crypto.init(path);
    defer crypto.deinit();
    const address = try crypto.addressText(a, try crypto.programAddress("credits.aleo"));
    defer a.free(address);
    const suffix = try std.fmt.allocPrint(a, "/mainnet/program/credits.aleo/mapping/account/{s}", .{address});
    defer a.free(suffix);
    var mock: Mock = .{ .route = suffix, .result = "\"987u64\"" };
    const endpoints = [_]@import("../net/endpoint.zig").Endpoint{.{ .url = "https://fixture.invalid" }};
    var factory: @import("scraper/aleo.zig").Factory = undefined;
    factory.provider = .{ .client = try @import("../aleo/rest.zig").Client.init(a, mock.transport(), &endpoints, 0), .native = &crypto };
    var chain: types.Chain = undefined;
    try std.testing.expectEqual(@as(u256, 987), try health.queryBalance(a, .{ .aleo = &factory }, &chain, address));
    mock.result = "null";
    try std.testing.expectEqual(@as(u256, 0), try health.queryBalance(a, .{ .aleo = &factory }, &chain, address));
    try std.testing.expectEqual(@as(usize, 2), mock.calls);
}
