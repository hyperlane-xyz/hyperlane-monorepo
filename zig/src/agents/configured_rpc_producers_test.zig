//! Actual production-default clients over bounded native loopback HTTP.
//! Scripted protocol replies prove wiring, not actual-node chain acceptance.
const std = @import("std");
const sources = @import("chain_source.zig");
const types = @import("../settings/types.zig");
const fixture = @import("../net/rpc_timeout_fixture.zig");
const json = @import("../net/json_rpc.zig");
const abi = @import("../evm/codecs.zig");
const http = @import("../cloud/http.zig");
const common = @import("scraper/receipts_common.zig");
const A = std.mem.Allocator;
const a = std.testing.allocator;
const Family = enum { radix, tron, starknet, aleo };

fn blockHash(height: u64) [32]u8 {
    var result: [32]u8 = @splat(0);
    std.mem.writeInt(u64, result[24..32], height + 1, .big);
    return result;
}
fn rpcReply(allocator: A, request: std.json.Value, result: anytype) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = try json.field(request, "id"), .result = result }, .{});
}
fn tronReply(allocator: A, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    const request = parsed.value;
    if (request.object.get("method")) |method| {
        const name = try json.string(method);
        if (std.mem.eql(u8, name, "eth_chainId")) return rpcReply(allocator, request, "0x1");
        if (std.mem.eql(u8, name, "eth_getLogs")) return rpcReply(allocator, request, [_]std.json.Value{});
        const id = try abi.hexAlloc(allocator, &@as([32]u8, @splat(0xaa)));
        defer allocator.free(id);
        const block = try abi.hexAlloc(allocator, &blockHash(37));
        defer allocator.free(block);
        if (std.mem.eql(u8, name, "eth_getTransactionByHash")) return rpcReply(allocator, request, .{ .hash = id, .blockHash = block, .blockNumber = "0x25", .from = "0x1111111111111111111111111111111111111111", .to = "0x2222222222222222222222222222222222222222", .nonce = "0x1", .gas = "0x5208", .gasPrice = "0x3", .input = "0x" });
        if (std.mem.eql(u8, name, "eth_getTransactionReceipt")) return rpcReply(allocator, request, .{ .transactionHash = id, .blockHash = block, .blockNumber = "0x25", .status = "0x1", .gasUsed = "0x5208", .cumulativeGasUsed = "0x5208", .effectiveGasPrice = "0x3" });
        return error.UnexpectedConfiguredTronMethod;
    }
    if (request.object.get("contract_address") != null) {
        const data = try json.string(try json.field(request, "data"));
        const tree_selector = std.fmt.bytesToHex(abi.selector("tree()"), .lower);
        if (std.mem.endsWith(u8, data, &tree_selector)) {
            const tree = std.fmt.bytesToHex(@as([33 * 32]u8, @splat(0)), .lower);
            return std.json.Stringify.valueAlloc(allocator, .{ .result = .{ .result = true }, .constant_result = .{tree[0..]} }, .{});
        }
        const zero = std.fmt.bytesToHex(@as([32]u8, @splat(0)), .lower);
        return std.json.Stringify.valueAlloc(allocator, .{ .result = .{ .result = true }, .constant_result = .{zero[0..]} }, .{});
    }
    const height = if (request.object.get("num")) |number| try json.integer(u64, number) else 37;
    const identifier = std.fmt.bytesToHex(blockHash(height), .lower);
    return std.json.Stringify.valueAlloc(allocator, .{ .block_header = .{ .raw_data = .{ .number = height, .timestamp = @as(u64, 1000) } }, .blockID = identifier[0..] }, .{});
}
fn starknetReply(allocator: A, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    const request = parsed.value;
    const method = try json.string(try json.field(request, "method"));
    if (std.mem.eql(u8, method, "starknet_blockNumber")) return rpcReply(allocator, request, @as(u64, 37));
    if (std.mem.eql(u8, method, "starknet_chainId")) return rpcReply(allocator, request, "0x1");
    if (std.mem.eql(u8, method, "starknet_getBlockWithTxHashes")) return rpcReply(allocator, request, .{ .status = "ACCEPTED_ON_L2", .block_number = @as(u64, 37), .block_hash = "0x26", .parent_hash = "0x25", .timestamp = @as(u64, 1), .transactions = [_]u8{} });
    return error.UnexpectedConfiguredStarknetMethod;
}
fn heliusReply(allocator: A, bytes: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("getPriorityFeeEstimate", try json.string(try json.field(parsed.value, "method")));
    return rpcReply(allocator, parsed.value, .{ .priorityFeeEstimate = @as(u64, 17) });
}
fn environmentFor(family: Family) !std.process.EnvMap {
    var environment = std.process.EnvMap.init(a);
    errdefer environment.deinit();
    if (family == .aleo) inline for (.{ "HYPERLANE_ALEO_CRYPTO_LIBRARY", "HYPERLANE_ALEO_VM_LIBRARY", "HYPERLANE_ALEO_VM_WORKER" }) |name| {
        const value = std.process.getEnvVarOwned(a, name) catch |err| switch (err) {
            error.EnvironmentVariableNotFound => return error.SkipZigTest,
            else => return err,
        };
        defer a.free(value);
        try environment.put(name, value);
    };
    return environment;
}
fn chainFor(family: Family, urls: []const []const u8) types.Chain {
    var chain = @import("chain_source_testing.zig").chainFor(urls);
    chain.protocol = switch (family) {
        .radix => .radix,
        .tron => .tron,
        .starknet => .starknet,
        .aleo => .aleo,
    };
    chain.index.mode = .block;
    if (family == .starknet) {
        chain.contracts.mailbox[31] = 1;
        chain.contracts.merkle_tree_hook[31] = 2;
    }
    chain.connection = switch (family) {
        .radix => .{ .radix = .{ .gateway_urls = urls, .network_name = "localnet" } },
        .tron => .{ .tron = .{ .wallet_urls = urls, .wallet_solidity_urls = urls, .fee_multiplier = null } },
        .starknet => .{ .starknet = .{ .native_token = @splat(0) } },
        .aleo => .{ .aleo = .{ .mailbox_program = "mailbox.aleo", .hook_manager_program = "hook_manager.aleo", .ism_manager_program = "ism_manager.aleo", .validator_announce_program = "validator_announce.aleo", .proving_service_urls = &.{}, .priority_fee_multiplier = 0 } },
    };
    return chain;
}
fn checkFamily(family: Family) !void {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const body = switch (family) {
        .radix => "{\"current_state_identifier\":{\"state_version\":37},\"ledger_state\":{\"network\":\"localnet\",\"state_version\":37,\"epoch\":2}}",
        .aleo => "37",
        else => "",
    };
    const reply: ?*const fn (A, []const u8) anyerror![]u8 = switch (family) {
        .tron => tronReply,
        .starknet => starknetReply,
        else => null,
    };
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = body }}, .response_fn = reply }};
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var environment = try environmentFor(family);
    defer environment.deinit();
    const chain = chainFor(family, &.{url});
    const resources = try sources.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resources.deinit();
    try std.testing.expect(!resources.options.allow_insecure_loopback and !resources.http.allow_insecure_loopback);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    const actual: u64 = switch (resources.clients) {
        .radix => |client| try client.coreState(),
        .tron => |client| try client.finalizedBlockNumber(),
        .starknet => |client| try client.provider.height(.none),
        .aleo => |client| try client.provider.height(),
        else => unreachable,
    };
    try std.testing.expectEqual(@as(u64, 37), actual);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try std.testing.expectError(error.InsecureCloudUrl, resources.http.interface().send(a, .{ .method = .GET, .url = url }));
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}
test "configured RPC producers actual default Radix Resources perform native HTTP" {
    try checkFamily(.radix);
}
test "configured RPC producers actual default Tron Resources perform native HTTP" {
    try checkFamily(.tron);
}
test "configured RPC producers actual default Starknet Resources perform native HTTP" {
    try checkFamily(.starknet);
}
test "configured RPC producers actual default Aleo Resources perform native HTTP" {
    try checkFamily(.aleo);
}

test "configured RPC producers actual Aleo authorization scope preserves native HTTP delegate on decode failure" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var environment = try environmentFor(.aleo);
    defer environment.deinit();
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "null" }} }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const chain = chainFor(.aleo, &.{url});
    const resources = try sources.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const native_types = @import("destination/types.zig");
    const factory = try @import("destination/factory.zig").Factory.open(a, resources, .{ .hex_key = @splat(0x11) }, .{ .transport = resources.http.interface(), .http_owner = &resources.http, .amz_date = "20261106T000000Z" }, .{});
    defer factory.deinit();
    try std.testing.expect(!factory.options.allow_fixture_transport and !factory.backend.aleo.allow_fixture_transport);
    const backend = &factory.backend.aleo;
    const sender = try resources.aleo_crypto.?.addressText(a, backend.signer.address);
    defer a.free(sender);
    const program = "configured.aleo";
    const target = try resources.aleo_crypto.?.programAddress(program);
    const context: native_types.Authority = .{ .protocol = .aleo, .origin = 2, .destination = chain.domain, .mailbox = try factory.mailbox(), .chain_id = "1", .operation_id = @splat(0x42), .target = target };
    const body = try std.json.Stringify.valueAlloc(a, .{ .program_id = program, .function_name = "process", .inputs = [_][]const u8{}, .network = @as(u16, 1), .sender = sender, .maximum_fee = backend.maximum_fee, .priority_fee_bps = backend.priority_fee_bps, .priority_fee_multiplier = backend.priority_fee_multiplier }, .{});
    defer a.free(body);
    var prepared = try native_types.Prepared.init(a, context, body, null, null);
    defer prepared.deinit();
    const Journal = struct {
        intents: usize = 0,
        fn intent(ctx: *anyopaque, id: [32]u8, _: []const u8) !void {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            try std.testing.expectEqualSlices(u8, &@as([32]u8, @splat(0x42)), &id);
            self.intents += 1;
        }
        fn signed(_: *anyopaque, _: [32]u8, _: native_types.Identity, _: []const u8) !void {
            return error.UnexpectedConfiguredAleoSigning;
        }
        fn authorization(_: *anyopaque, _: [32]u8, _: []const u8) !void {
            return error.UnexpectedConfiguredAleoAuthorization;
        }
    };
    var journal: Journal = .{};
    const saved = backend.chain.provider.client.transport;
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    // The unavailable program edition fails at the actual upstream DTO boundary,
    // after a real native request, before any authorization/signing/proving.
    try std.testing.expectError(error.InvalidJsonRpcResult, backend.authorize(&prepared, .{ .context = &journal, .persistIntent = Journal.intent, .persistSigned = Journal.signed, .persistAuthorization = Journal.authorization }, (try http.rpcNowNs()) + 30 * std.time.ns_per_s));
    try std.testing.expectEqual(@as(usize, 1), journal.intents);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try std.testing.expect(std.mem.endsWith(u8, server.records[0].pathText(), "/program/configured.aleo/latest_edition"));
    try std.testing.expect(backend.chain.provider.client.transport.context == saved.context and backend.chain.provider.client.transport.send_fn == saved.send_fn);
    try std.testing.expect(resources.http.rpc_read_owner == null and !resources.http.allow_insecure_loopback);
    try server.check();
}

test "configured RPC producers actual Helius Factory retains configured capability through deadline guard" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = heliusReply }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var chain = @import("chain_source_testing.zig").chainFor(&.{url});
    chain.protocol = .sealevel;
    chain.signer = .{ .hex_key = @splat(7) };
    chain.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .helius = .{ .url = url, .fee_level = "Medium" } }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = null, .native_token_decimals = 9 } };
    const resources = try sources.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const factory = try @import("destination/factory.zig").Factory.open(a, resources, chain.signer.?, .{ .transport = resources.http.interface(), .http_owner = &resources.http, .amz_date = "20261106T000000Z" }, .{});
    defer factory.deinit();
    try std.testing.expect(!factory.options.allow_fixture_transport and !resources.http.allow_insecure_loopback);
    const owner = &factory.svm_oracle_http.?;
    try std.testing.expect(!owner.allow_insecure_loopback);
    var oracle = factory.backend.sealevel.oracle;
    const saved = oracle.helius.transport;
    var budget: common.DeadlineTransport = .{ .owner = owner, .deadline_ns = (try http.rpcNowNs()) + 5 * std.time.ns_per_s, .rpc_read = true };
    try budget.verify(saved);
    oracle.helius.transport = budget.interface();
    try std.testing.expectEqual(@as(u64, 17), try oracle.fee(a, "public unsigned transaction fixture"));
    try std.testing.expect(owner.rpc_read_owner == null);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try std.testing.expectError(error.InsecureCloudUrl, owner.interface().send(a, .{ .method = .POST, .url = url }));
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}

test "configured RPC producers receipt and origin signer guards preserve actual Tron native delegate" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = tronReply }};
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const chain = chainFor(.tron, &.{url});
    const resources = try sources.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const original = resources.clients.tron.jsonrpc.transport;
    const transaction: [64]u8 = @as([32]u8, @splat(0)) ++ @as([32]u8, @splat(0xaa));
    const meta: @import("scraper/enrichment.zig").Meta = .{ .block_number = 37, .block_hash = blockHash(37), .tx_hash = transaction };
    const fetcher = try resources.receipts();
    var receipt = try fetcher.fetch(a, meta, (try http.rpcNowNs()) + 5 * std.time.ns_per_s);
    defer receipt.deinit();
    try std.testing.expectEqual(@as(u256, 21000), receipt.value.gas_used);
    const origin = @import("origin_signer_source.zig");
    const Provenance = struct {
        fn block(_: *anyopaque, _: @import("../protocol/root.zig").Message) !u64 {
            return 37;
        }
        fn tx(_: *anyopaque, _: [32]u8) !?[64]u8 {
            return @as([32]u8, @splat(0)) ++ @as([32]u8, @splat(0xaa));
        }
    };
    var context: u8 = 0;
    var lookup = origin.Source.initProvenance(resources, .{ .context = &context, .block_fn = Provenance.block, .transaction_fn = Provenance.tx });
    const message: @import("../protocol/root.zig").Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(1), .recipient = @splat(2), .body = "public" };
    const signers = try lookup.interface().fetch(a, message, @intCast(std.time.nanoTimestamp() + 5 * std.time.ns_per_s), null);
    defer a.free(signers);
    try std.testing.expectEqual(@as(usize, 1), signers.len);
    try std.testing.expectEqualSlices(u8, &(@as([32]u8, @splat(0))[0..12].* ++ @as([20]u8, @splat(0x11))), &signers[0]);
    try std.testing.expect(resources.clients.tron.jsonrpc.transport.context == original.context and resources.clients.tron.jsonrpc.transport.send_fn == original.send_fn);
    try std.testing.expect(resources.http.rpc_read_owner == null and !resources.http.allow_insecure_loopback);
    try std.testing.expectEqual(@as(usize, 4), server.acceptedCount());
    try server.check();
}

fn configured(path: []const u8, url: []const u8, role: types.Role) !@import("../settings/root.zig").Settings {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const temporary = arena.allocator();
    const key = try abi.hexAlloc(temporary, &@as([32]u8, @splat(0x11)));
    const address = "0x0000000000000000000000000000000000000001";
    const wallet = try std.fmt.allocPrint(temporary, "{s}/wallet", .{url});
    const solidity = try std.fmt.allocPrint(temporary, "{s}/walletsolidity", .{url});
    const wire = try std.json.Stringify.valueAlloc(temporary, .{
        .relayChains = "configuredrpcfixture",
        .originChainName = "configuredrpcfixture",
        .db = try std.fs.path.join(temporary, &.{ path, "db" }),
        .validator = .{ .key = key },
        .checkpointSyncer = .{ .type = "localStorage", .path = try std.fs.path.join(temporary, &.{ path, "checkpoints" }) },
        .skipAnnounce = true,
        .chains = .{ .configuredrpcfixture = .{
            .name = "configuredrpcfixture",
            .domainId = @as(u32, 3999999999),
            .chainId = @as(u32, 1),
            .protocol = "tron",
            .signer = .{ .key = key },
            .rpcUrls = .{.{ .http = url }},
            .walletUrls = .{.{ .http = wallet }},
            .walletSolidityUrls = .{.{ .http = solidity }},
            .rpcConsensusType = "single",
            .mailbox = address,
            .merkleTreeHook = address,
            .validatorAnnounce = address,
            .interchainGasPaymaster = address,
            .index = .{ .from = 0, .chunk = 37, .mode = "block", .interval = 1 },
            .blocks = .{ .reorgPeriod = 0 },
        } },
    }, .{});
    const parsed = try std.json.parseFromSlice(std.json.Value, temporary, wire, .{});
    const root = try @import("../config.zig").normalizedValue(temporary, parsed.value);
    return @import("../settings/root.zig").Settings.fromConfig(.{ .arena = arena, .root = root }, role);
}

test "configured RPC producers actual default Relayer origin Task initializes native Tron cursor" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = tronReply }};
    var server = try fixture.Fixture.init(256, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var settings = try configured(path, url, .relayer);
    defer settings.deinit();
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const set = try @import("relayer_task.zig").TaskSet.open(a, &settings, &environment, .{ .curl_library = library });
    defer set.deinit();
    try std.testing.expect(!set.options.allow_insecure_loopback);
    const task = set.origins.descriptors()[0];
    var cancel = std.atomic.Value(bool).init(false);
    var timer = try std.time.Timer.start();
    while (true) {
        _ = task.run(task.context, .{ .unix_ms = 1793923200000, .monotonic_ms = timer.read() / std.time.ns_per_ms }, &cancel) catch |err| {
            if (err != error.PendingReadIo and err != error.PendingIo) return err;
            if (timer.read() > 5 * std.time.ns_per_s) return error.ConfiguredRelayerFixtureTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        break;
    }
    const slot = &set.origins.slots[0];
    try std.testing.expect(slot.implementation == .generic);
    // Empty-origin bootstrap has no canonical log row to persist. Its actual
    // cursor begins at the authenticated current tip, not at a synthetic zero.
    const cursor = slot.implementation.generic.indexer.cursors[0] orelse return error.ConfiguredRpcCursorMissing;
    try std.testing.expect(cursor.forward.block >= 37 and cursor.forward.sequence == 0);
    try std.testing.expect(set.database.value != null);
    try std.testing.expect(!slot.network.?.http.allow_insecure_loopback);
    try std.testing.expect(server.acceptedCount() > 1);
    try server.check();
}

test "configured RPC producers actual default Validator Task publishes metadata then initializes Tron cursor" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const url_library = std.process.getEnvVarOwned(a, "HYPERLANE_URL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(url_library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = tronReply }};
    var server = try fixture.Fixture.init(256, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const path = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var settings = try configured(path, url, .validator);
    defer settings.deinit();
    const task = try @import("validator_task.zig").Task.init(a, &settings, .{ .curl_library = library, .url_library = url_library }, null, null);
    defer task.deinit();
    try std.testing.expect(!task.options.allow_insecure_loopback);
    var cancel = std.atomic.Value(bool).init(false);
    var timer = try std.time.Timer.start();
    while (true) {
        _ = try task.tick(.{ .unix_ms = 1793923200000, .monotonic_ms = timer.read() / std.time.ns_per_ms }, &cancel);
        if (task.generic_validator) |value| if (value.core != null and value.core.?.cursors[1] != null) break;
        if (timer.read() > 5 * std.time.ns_per_s) return error.ConfiguredValidatorFixtureTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(task.metadata_ready.load(.acquire));
    const role = task.generic_validator.?;
    try std.testing.expect(role.announcement_ready and role.core.?.cursors[1].?.forward.block >= 37);
    try std.testing.expect(!role.index_resources.http.allow_insecure_loopback);
    const metadata_bytes = try tmp.dir.readFileAlloc(a, "checkpoints/metadata_latest.json", 8192);
    defer a.free(metadata_bytes);
    try std.testing.expect(std.mem.indexOf(u8, metadata_bytes, "host_hash") != null);
    try std.testing.expect(server.acceptedCount() > 1);
    try server.check();
}

// Test storage only. Actual Worker, source, native RPCs, protocol parsing and
// fork/confirmation checks execute unchanged; this does not establish SQL I/O.
const ProgressStore = struct {
    current: @import("../db/scraper_store.zig").State = .{ .indexed = 0, .hash = blockHash(0), .confirmed = 0, .head = 0, .halted = false },
    commits: usize = 0,
    pub fn claim(_: *@This(), _: f64) !void {}
    pub fn state(self: *@This()) !?@import("../db/scraper_store.zig").State {
        return self.current;
    }
    pub fn pause(self: *@This(), halted: bool) !void {
        self.current.halted = halted;
    }
    pub fn hash(self: *@This(), height: u64) !?[32]u8 {
        if (height == 0) return blockHash(0);
        return if (height == self.current.indexed) self.current.hash else null;
    }
    pub fn checkpoint(self: *@This(), through: u64) !u64 {
        return if (through >= self.current.indexed) self.current.indexed else 0;
    }
    pub fn checkpointBetween(self: *@This(), after: u64, through: u64) !?u64 {
        const height = try self.checkpoint(through);
        return if (height > after) height else null;
    }
    pub fn observe(self: *@This(), expected: @import("../db/scraper_store.zig").State, ancestor: @import("scraper/source.zig").Header, head: @import("scraper/source.zig").Header) !void {
        try std.testing.expectEqualSlices(u8, &expected.hash, &self.current.hash);
        try std.testing.expectEqual(@as(u64, 0), ancestor.height);
        self.current.head = head.height;
    }
    pub fn sequenceCounts(_: *@This()) ![4]u32 {
        return @splat(0);
    }
    pub fn rewindToConfirmed(_: *@This(), _: @import("../db/scraper_store.zig").State) !void {
        return error.UnexpectedConfiguredRewind;
    }
    pub fn append(self: *@This(), expected: @import("../db/scraper_store.zig").State, blocks: []const @import("scraper/source.zig").Block) !void {
        try std.testing.expectEqualSlices(u8, &expected.hash, &self.current.hash);
        for (blocks) |block| {
            try std.testing.expectEqual(@as(usize, 0), block.events.len);
            try std.testing.expect(block.header.height > self.current.indexed);
            self.current.indexed = block.header.height;
            self.current.hash = block.header.hash;
        }
        self.commits += 1;
    }
    pub fn confirmationBoundary(_: *@This(), _: u64, through: u64) !u64 {
        return through;
    }
    pub fn confirm(self: *@This(), expected: @import("../db/scraper_store.zig").State, boundary: @import("scraper/source.zig").Header, _: f64) ![4]u64 {
        try std.testing.expectEqualSlices(u8, &expected.hash, &self.current.hash);
        try std.testing.expectEqualSlices(u8, &boundary.hash, &self.current.hash);
        self.current.confirmed = boundary.height;
        return @splat(0);
    }
};

test "configured RPC producers actual scraper Worker advances native Tron head with component memory storage" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = tronReply }};
    var server = try fixture.Fixture.init(128, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const chain = chainFor(.tron, &.{url});
    const resources = try sources.Resources.open(a, &chain, &environment, .{ .curl_library = library });
    defer resources.deinit();
    var store: ProgressStore = .{};
    var worker: @import("scraper/runtime.zig").Worker(ProgressStore) = .{ .allocator = a, .source = try resources.source(), .store = &store, .options = .{ .period = .{ .blocks = 0 }, .chunk_size = 37 } };
    const progress = try worker.cycle();
    try std.testing.expect(!progress.ingestion_failed);
    try std.testing.expectEqual(@as(u64, 37), progress.indexed);
    try std.testing.expectEqual(@as(u64, 37), progress.confirmed);
    try std.testing.expectEqual(@as(usize, 1), store.commits);
    try std.testing.expect(!resources.http.allow_insecure_loopback and server.acceptedCount() > 1);
    try server.check();
}
