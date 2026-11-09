const std = @import("std");
const driver_module = @import("native_driver.zig");
const destination = @import("../destination/root.zig");
const policy_module = @import("../relay_policy.zig");
const protocol = @import("../../protocol/root.zig");
const db = @import("../../db/root.zig");
const objects = @import("../../storage/objects.zig");
const History = struct {
    pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?objects.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
        return null;
    }
    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.UnexpectedNativeFixtureProof;
    }
};
const SenderGate = struct {
    calls: usize = 0,
    cached_calls: usize = 0,
    result: driver_module.GateResult = .allow,
    fn check(ctx: *anyopaque, _: std.mem.Allocator, _: protocol.Message, _: destination.Clock, cached_only: bool) !driver_module.GateResult {
        const self: *SenderGate = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (cached_only) self.cached_calls += 1;
        return self.result;
    }
};
fn word(a: std.mem.Allocator, value: u256) ![]u8 {
    var data: [32]u8 = undefined;
    std.mem.writeInt(u256, &data, value, .big);
    const text = try @import("../../evm/codecs.zig").hexAlloc(a, &data);
    defer a.free(text);
    return std.json.Stringify.valueAlloc(a, .{ .result = .{ .result = true }, .constant_result = [_][]const u8{text[2..]} }, .{});
}
test "Native destination driver orders source gates gas allowance durable sign restart reconciliation and final external delivery" {
    try nativeFinalityExercise(.delivery_only);
}
test "Native finalized metric Driver receipt without fees reaches registry once across reopen" {
    try nativeFinalityExercise(.success);
}
test "Native finalized metric counts failed transaction and preserves primary commit error" {
    try nativeFinalityExercise(.failure);
    try nativeFinalityExercise(.commit_fault);
}
test "Native finalized metric excludes foreign and nonfinal receipts" {
    try nativeFinalityExercise(.foreign);
    try nativeFinalityExercise(.nonfinal);
}
fn nativeFinalityExercise(mode: enum { delivery_only, success, failure, commit_fault, foreign, nonfinal }) !void {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "native" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "origin");
    const mailbox = [_]u8{0} ** 12 ++ [_]u8{2} ** 20;
    const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = .{0} ** 12 ++ .{1} ** 20, .recipient = mailbox, .body = "driver" };
    _ = try store.storeMessage(message, 10, null);
    _ = try store.storePayment(.{ .message_id = message.id(), .destination = 2, .payment = 10, .gas_amount = 2000 }, .{ .transaction_id = .{3} ** 64, .log_index = 0 });
    const http = @import("../../cloud/http.zig");
    var fixture_environment = std.process.EnvMap.init(a);
    defer fixture_environment.deinit();
    var resources: @import("../chain_source.zig").Resources = .{ .environment = &fixture_environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
    defer resources.http.deinit();
    defer resources.arena.deinit();
    resources.chain.protocol = .tron;
    resources.chain.domain = 2;
    resources.chain.chain_id = "728126428";
    resources.chain.contracts = .{ .mailbox = mailbox, .merkle_tree_hook = .{0} ** 12 ++ .{3} ** 20, .validator_announce = .{0} ** 12 ++ .{8} ** 20, .interchain_gas_paymaster = .{0} ** 32 };
    const absent = try word(a, 0);
    defer a.free(absent);
    const present = try word(a, 1);
    defer a.free(present);
    const ism = try word(a, 7);
    defer a.free(ism);
    const module_type = try word(a, 6);
    defer a.free(module_type);
    var block_id: [32]u8 = .{0} ** 32;
    block_id[7] = 5;
    const block_hex = try @import("../../evm/codecs.zig").hexAlloc(a, &block_id);
    defer a.free(block_hex);
    const block = try std.json.Stringify.valueAlloc(a, .{ .blockID = block_hex[2..], .block_header = .{ .raw_data = .{ .number = @as(u32, 5), .timestamp = @as(u64, 1000000) } } }, .{});
    defer a.free(block);
    var network: @import("../../cloud/testing.zig").Mock = .{
        .steps = &.{
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent },
            .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x60\"}" },
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = ism },
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = ism }, // Strict root default-ISM classification.
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = module_type },
            .{ .method = .POST, .suffix = "/estimateenergy", .response = "{\"result\":{\"result\":true},\"energy_required\":1000}" },
            .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x64\"}" },
            .{ .method = .POST, .suffix = "/getnowblock", .response = block },
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent },
            .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":\"0x60\"}" },
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent },
            .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":null}" },
            .{ .method = .POST, .suffix = "/getnowblock", .response = block },
            .{ .method = .POST, .suffix = "/broadcasthex", .response = "{\"result\":true}" },
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = present },
            .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":null}" },
        },
    };
    var provider = try @import("../../tron/provider.zig").Provider.init(a, network.transport(), .{ .rpc_urls = &.{.{ .url = "https://fixture/rpc" }}, .wallet_urls = &.{.{ .url = "https://fixture/wallet" }}, .wallet_solidity_urls = &.{.{ .url = "https://fixture/walletsolidity" }} });
    resources.clients = .{ .tron = &provider };
    var local: @import("../../tron/transaction.zig").LocalSigner = .{ .secret_key = .{0x11} ** 32 };
    defer local.deinit();
    var factory: destination.Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .options = .{ .allow_fixture_transport = true, .origin_bindings = &.{.{ .domain = 1, .hook = .{9} ** 32 }} }, .backend_ready = true, .chain_checked = true, .backend = .{ .tron = .{ .chain = .{ .provider = &provider, .mailbox = .{2} ** 20, .hook = .{3} ** 20, .domain = 2 }, .announce = .{8} ** 20, .signer = try local.interface(), .chain_id = resources.chain.chain_id } } };
    defer factory.arena.deinit();
    var policy = try policy_module.Policy.init(a, .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .{ .minimum = 1 } }} }, null, null);
    defer policy.deinit();
    var gate: SenderGate = .{};
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var adapter: @import("../../ops/lander_metrics.zig").Adapter = .{ .registry = registry, .destination = "native-destination" };
    const Observe = struct {
        fn finalized(context_ptr: *anyopaque) void {
            const metric: *@import("../../ops/lander_metrics.zig").Adapter = @ptrCast(@alignCast(context_ptr));
            metric.record(.finalized_transaction) catch unreachable;
        }
    };
    const driver: driver_module.Driver = .{ .options = .{ .finalized_observer = .{ .context = &adapter, .observe_fn = Observe.finalized }, .maximum_gas = 5000, .signer_gate = .{ .context = &gate, .check_fn = SenderGate.check } } };
    var history: History = .{};
    const now: destination.operation.Times = .{ .unix_ms = 1000000, .monotonic_ms = 0 };
    const clock: destination.Clock = .{ .unix_ms = now.unix_ms, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 10 * std.time.ns_per_s };
    const context = try factory.authorityFor(1, message.id(), 1, .process);
    const options: destination.operation.Options = .{ .id = message.id(), .context = try factory.contextFor(context), .nonce = 0, .origin = 1, .destination = 2, .policy = .{ .confirm_delay_ms = 0 } };
    var actor = try destination.operation.Operation.open(a, &store, options, now);
    var actor_live = true;
    defer if (actor_live) actor.deinit();
    var held_driver = driver;
    held_driver.options.prepare_allowed = false;
    try std.testing.expectEqual(driver_module.State.backpressured, (try held_driver.step(a, &factory, actor, &history, &policy, message, clock, now)).state);
    try std.testing.expectEqual(@as(usize, 0), network.index);
    try std.testing.expectEqual(@as(usize, 0), gate.calls);
    try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
    try std.testing.expect(actor.value.stage == .pending and actor.intent == null and actor.signed == null);
    try std.testing.expectEqual(driver_module.State.prepared, (try driver.step(a, &factory, actor, &history, &policy, message, clock, now)).state);
    try std.testing.expect(actor.signed == null);
    try std.testing.expect(driver_module.queuedForSubmission(actor));
    var staged = try destination.types.Prepared.restore(a, actor.intent.?);
    defer staged.deinit();
    try std.testing.expectEqual(@as(u256, 2000), try @import("../../net/json_rpc.zig").integer(u256, try @import("../../net/json_rpc.zig").field(staged.body, "gas_limit")));
    try std.testing.expectEqual(driver_module.State.signed, (try held_driver.step(a, &factory, actor, &history, &policy, message, clock, now)).state);
    const identity = actor.signed.?.identity;
    try std.testing.expect(!driver_module.queuedForSubmission(actor));
    actor.deinit();
    actor_live = false;
    actor = try destination.operation.Operation.open(a, &store, options, now);
    actor_live = true;
    try std.testing.expectEqual(driver_module.State.broadcast, (try held_driver.step(a, &factory, actor, &history, &policy, message, clock, now)).state);
    try std.testing.expectEqual(identity, actor.signed.?.identity);
    try std.testing.expectEqual(@as(usize, 3), gate.calls);
    try std.testing.expectEqual(@as(usize, 2), gate.cached_calls);
    try std.testing.expect(!try store.processed(message.nonce));
    const later: destination.operation.Times = .{ .unix_ms = now.unix_ms + 600000, .monotonic_ms = 600000 };
    if (mode != .delivery_only) {
        const identity_hex = try @import("../../evm/codecs.zig").hexAlloc(a, &identity.hash256);
        defer a.free(identity_hex);
        const wrong_hex = try @import("../../evm/codecs.zig").hexAlloc(a, &([_]u8{0x77} ** 32));
        defer a.free(wrong_hex);
        const receipt_body = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = provider.jsonrpc.next_id, .result = .{ .transactionHash = if (mode == .foreign) wrong_hex else identity_hex, .blockNumber = "0x5", .blockHash = block_hex, .status = if (mode == .failure) "0x0" else "0x1" } }, .{});
        defer a.free(receipt_body);
        // No gasUsed/effectiveGasPrice: the genuine finalized receipt must count
        // without inventing a zero fee or requiring expenditure information.
        const lower_block = try std.json.Stringify.valueAlloc(a, .{ .blockID = "00" ** 7 ++ "04" ++ "00" ** 24, .block_header = .{ .raw_data = .{ .number = @as(u32, 4), .timestamp = @as(u64, 1000000) } } }, .{});
        defer a.free(lower_block);
        var steps = [_]@import("../../cloud/testing.zig").Step{
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent },
            .{ .method = .POST, .suffix = "/rpc", .response = receipt_body },
            .{ .method = .POST, .suffix = "/getnowblock", .response = if (mode == .nonfinal) lower_block else block },
            .{ .method = .POST, .suffix = "/getblockbynum", .response = block },
        };
        network.steps = steps[0..if (mode == .foreign) @as(usize, 3) else if (mode == .nonfinal) @as(usize, 3) else @as(usize, 4)];
        network.index = 0;
        if (mode == .commit_fault) {
            destination.operation.FinalizationTestFault.after_commit.store(true, .release);
            defer destination.operation.FinalizationTestFault.after_commit.store(false, .release);
            try std.testing.expectError(error.NativeFinalizationCommitOutcomeUnknown, held_driver.step(a, &factory, actor, &history, &policy, message, clock, later));
        } else {
            const report = try held_driver.step(a, &factory, actor, &history, &policy, message, clock, later);
            try std.testing.expectEqual(if (mode == .failure) driver_module.State.retired else driver_module.State.reconciled, report.state);
            if (mode == .foreign) try std.testing.expectEqual(error.WrongTronReceipt, report.failure.?) else try std.testing.expect(report.failure == null);
        }
        try network.expectDone();
        const expected_metric = mode != .foreign and mode != .nonfinal;
        {
            const wire = try registry.render(a);
            defer a.free(wire);
            try std.testing.expectEqual(expected_metric, std.mem.indexOf(u8, wire, "hyperlane_lander_finalized_transactions{destination=\"native-destination\"} 1\n") != null);
            if (!expected_metric) try std.testing.expect(std.mem.indexOf(u8, wire, "hyperlane_lander_finalized_transactions{") == null);
        }
        try std.testing.expect(!try store.processed(message.nonce));
        try std.testing.expectEqual(@as(u256, 0), (try store.expenditure(message.id())).gas_used);
        if (mode == .success or mode == .commit_fault) {
            actor.deinit();
            actor_live = false;
            actor = try destination.operation.Operation.open(a, &store, options, later);
            actor_live = true;
            const replay_body = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = provider.jsonrpc.next_id, .result = .{ .transactionHash = identity_hex, .blockNumber = "0x5", .blockHash = block_hex, .status = "0x1" } }, .{});
            defer a.free(replay_body);
            steps[1].response = replay_body;
            network.index = 0;
            const replay = try held_driver.step(a, &factory, actor, &history, &policy, message, clock, later);
            try std.testing.expectEqual(driver_module.State.reconciled, replay.state);
            try std.testing.expect(replay.failure == null);
            try network.expectDone();
            const wire = try registry.render(a);
            defer a.free(wire);
            try std.testing.expect(std.mem.indexOf(u8, wire, "hyperlane_lander_finalized_transactions{destination=\"native-destination\"} 1\n") != null);
            try std.testing.expect(std.mem.indexOf(u8, wire, "hyperlane_lander_finalized_transactions{destination=\"native-destination\"} 2\n") == null);
        }
        return;
    }
    try std.testing.expectEqual(driver_module.State.delivered, (try held_driver.step(a, &factory, actor, &history, &policy, message, clock, later)).state);
    try std.testing.expect(try store.processed(message.nonce));
    try std.testing.expect((try store.pendingAtOrAfter(message.destination, 0)) == null);
    try network.expectDone();
    const negative_wire = try registry.render(a);
    defer a.free(negative_wire);
    try std.testing.expect(std.mem.indexOf(u8, negative_wire, "hyperlane_lander_finalized_transactions{") == null);
    try std.testing.expectEqual(driver_module.State.delivered, (try held_driver.step(a, &factory, actor, &history, &policy, message, clock, later)).state);
    try network.expectDone(); // Historical delivery cannot synthesize a final receipt.
    var unpaid = message;
    unpaid.nonce = 1;
    _ = try store.storeMessage(unpaid, 11, null);
    var next_options = options;
    next_options.id = unpaid.id();
    next_options.nonce = unpaid.nonce;
    {
        network.steps = &.{ .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent }, .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":\"0x60\"}" } };
        network.index = 0;
        const unpaid_actor = try destination.operation.Operation.open(a, &store, next_options, now);
        defer unpaid_actor.deinit();
        const report = try driver.step(a, &factory, unpaid_actor, &history, &policy, unpaid, clock, now);
        try std.testing.expectEqual(driver_module.State.retried, report.state);
        try std.testing.expectEqual(db.json.ReprepareReason.GasPaymentNotFound, report.reason.?);
        try std.testing.expect(unpaid_actor.signed == null and unpaid_actor.intent == null);
        try std.testing.expectEqual(@as(usize, 3), gate.calls);
        try network.expectDone();
    }
    var non_contract = message;
    non_contract.nonce = 2;
    _ = try store.storeMessage(non_contract, 12, null);
    next_options.id = non_contract.id();
    next_options.nonce = non_contract.nonce;
    {
        network.steps = &.{ .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent }, .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"0x\"}" } };
        network.index = 0;
        const dropped = try destination.operation.Operation.open(a, &store, next_options, now);
        defer dropped.deinit();
        const report = try driver.step(a, &factory, dropped, &history, &policy, non_contract, clock, now);
        try std.testing.expectEqual(driver_module.State.not_contract, report.state);
        try std.testing.expect(try store.terminal(non_contract.id()));
        try std.testing.expect(!try store.processed(non_contract.nonce));
        try std.testing.expect(dropped.signed == null and dropped.intent == null);
        try std.testing.expectEqual(@as(usize, 3), gate.calls);
        try network.expectDone();
    }
    var waiting = message;
    waiting.nonce = 3;
    _ = try store.storeMessage(waiting, 13, null);
    _ = try store.storePayment(.{ .message_id = waiting.id(), .destination = 2, .payment = 10, .gas_amount = 2000 }, .{ .transaction_id = .{3} ** 64, .log_index = 1 });
    next_options.id = waiting.id();
    next_options.nonce = waiting.nonce;
    {
        network.steps = &.{ .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = absent }, .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":8,\"result\":\"0x60\"}" } };
        network.index = 0;
        gate.result = .{ .delay_ms = 30000 };
        const delayed = try destination.operation.Operation.open(a, &store, next_options, now);
        defer delayed.deinit();
        const report = try driver.step(a, &factory, delayed, &history, &policy, waiting, clock, now);
        try std.testing.expectEqual(driver_module.State.retried, report.state);
        try std.testing.expectEqual(db.json.ReprepareReason.ErrorFetchingOriginTxSender, report.reason.?);
        try std.testing.expectEqual(@as(u32, 0), delayed.value.retries);
        try std.testing.expectEqual(@as(u64, 30000), delayed.value.next_attempt_ms);
        try std.testing.expect(delayed.signed == null and delayed.intent == null);
        try network.expectDone();
    }
}

const PendingCcip = struct {
    failure: anyerror = error.CcipReadPending,
    delays: usize = 0,
    fn pending(ctx: *anyopaque, _: [20]u8, _: protocol.Message) ![]u8 {
        const self: *PendingCcip = @ptrCast(@alignCast(ctx));
        return self.failure;
    }
    fn delay(ctx: *anyopaque) u64 {
        const self: *PendingCcip = @ptrCast(@alignCast(ctx));
        self.delays += 1;
        return 17;
    }
    fn send(_: *anyopaque, a: std.mem.Allocator, request: @import("../../cloud/http.zig").Request) !@import("../../cloud/http.zig").Response {
        const rpc = @import("../../net/json_rpc.zig");
        const abi = @import("../../evm/codecs.zig");
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request.body.?, .{});
        defer parsed.deinit();
        const value = parsed.value;
        const response = if (value.object.get("method")) |method| blk: {
            try std.testing.expectEqualStrings("eth_getCode", method.string);
            break :blk try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = value.object.get("id").?, .result = "0x60" }, .{});
        } else blk: {
            const data = value.object.get("data").?.string;
            var selector: [4]u8 = undefined;
            _ = try std.fmt.hexToBytes(&selector, data[0..8]);
            const number: u256 = if (std.mem.eql(u8, &selector, &abi.selector("delivered(bytes32)"))) 0 else if (std.mem.eql(u8, &selector, &abi.selector("recipientIsm(address)")) or std.mem.eql(u8, &selector, &abi.selector("defaultIsm()"))) 4 else if (std.mem.eql(u8, &selector, &abi.selector("moduleType()"))) 7 else return error.UnexpectedPendingFixtureCall;
            break :blk try word(a, number);
        };
        return .{ .allocator = a, .status = 200, .bytes = response };
    }
};
test "Native CCIP pending delays repeat without retry exhaustion and cooperative IO remains control" {
    const a = std.testing.allocator;
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "native" });
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "origin");
    const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .recipient = .{0} ** 31 ++ .{2}, .body = "pending CCIP" };
    _ = try store.storeMessage(message, 10, null);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var resources: @import("../chain_source.zig").Resources = .{ .environment = &environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = @import("../../cloud/http.zig").HttpTransport.init(a) };
    defer resources.http.deinit();
    defer resources.arena.deinit();
    resources.chain.protocol = .tron;
    resources.chain.domain = 2;
    resources.chain.chain_id = "1";
    resources.chain.contracts = .{ .mailbox = .{0} ** 31 ++ .{2}, .merkle_tree_hook = .{0} ** 31 ++ .{3}, .interchain_gas_paymaster = .{0} ** 32, .validator_announce = .{0} ** 31 ++ .{8} };
    var script: PendingCcip = .{};
    const transport: @import("../../cloud/http.zig").Transport = .{ .context = &script, .send_fn = PendingCcip.send };
    const endpoints = [_]@import("../../tron/rpc.zig").Endpoint{.{ .url = "https://fixture" }};
    var provider = try @import("../../tron/provider.zig").Provider.init(a, transport, .{ .rpc_urls = &endpoints, .wallet_urls = &endpoints, .wallet_solidity_urls = &endpoints });
    resources.clients = .{ .tron = &provider };
    var local: @import("../../tron/transaction.zig").LocalSigner = .{ .secret_key = .{0x11} ** 32 };
    defer local.deinit();
    var factory: destination.Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .options = .{ .allow_fixture_transport = true, .origin_bindings = &.{.{ .domain = 1, .hook = .{9} ** 32 }} }, .chain_checked = true, .backend_ready = true, .ccip_handler = .{ .context = &script, .fetch_fn = PendingCcip.pending }, .backend = .{ .tron = .{ .chain = .{ .provider = &provider, .mailbox = .{0} ** 19 ++ .{2}, .hook = .{0} ** 19 ++ .{3}, .domain = 2 }, .announce = .{0} ** 19 ++ .{8}, .signer = try local.interface(), .chain_id = "1" } } };
    defer factory.arena.deinit();
    var policy = try policy_module.Policy.init(a, .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }} }, null, null);
    defer policy.deinit();
    const driver: driver_module.Driver = .{ .options = .{ .pending_delay = .{ .context = &script, .delay_ms_fn = PendingCcip.delay } } };
    var history: History = .{};
    var now: destination.operation.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
    const clock: destination.Clock = .{ .unix_ms = now.unix_ms, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 30 * std.time.ns_per_s };
    const context = try factory.authorityFor(1, message.id(), 1, .process);
    const actor = try destination.operation.Operation.open(a, &store, .{ .id = message.id(), .context = try factory.contextFor(context), .nonce = 0, .origin = 1, .destination = 2, .policy = .{ .max_retries = 1 } }, now);
    defer actor.deinit();
    for (0..5) |_| {
        const report = try driver.step(a, &factory, actor, &history, &policy, message, clock, now);
        try std.testing.expectEqual(driver_module.State.retried, report.state);
        try std.testing.expectEqual(error.CcipReadPending, report.failure.?);
        try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
        try std.testing.expect(!actor.parked and actor.signed == null and actor.intent == null);
        try std.testing.expectEqual(now.monotonic_ms + 17, actor.value.next_attempt_ms);
        now.monotonic_ms = actor.value.next_attempt_ms;
    }
    try std.testing.expectEqual(@as(usize, 5), script.delays);
    const default: driver_module.Driver = .{};
    _ = try default.step(a, &factory, actor, &history, &policy, message, clock, now);
    try std.testing.expectEqual(now.monotonic_ms + 1000, actor.value.next_attempt_ms);
    now.monotonic_ms = actor.value.next_attempt_ms;
    script.failure = error.PendingReadIo;
    try std.testing.expectError(error.PendingReadIo, driver.step(a, &factory, actor, &history, &policy, message, clock, now));
    try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
    try std.testing.expect(!try store.processed(message.nonce));
}

test "source600s Native driver retains unsigned external delivery until eligibility and rechecks before processing" {
    const a = std.testing.allocator;
    const TimedTransport = struct {
        mock: *@import("../../cloud/testing.zig").Mock,
        times: destination.operation.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 },
        fn now(context: *anyopaque) !destination.operation.Times {
            const self: *@This() = @ptrCast(@alignCast(context));
            return self.times;
        }
        fn send(context: *anyopaque, allocator: std.mem.Allocator, request: @import("../../cloud/http.zig").Request) !@import("../../cloud/http.zig").Response {
            const self: *@This() = @ptrCast(@alignCast(context));
            if (self.mock.index == 0) {
                self.times.unix_ms += 10000;
                self.times.monotonic_ms += 10000;
            }
            return self.mock.transport().send(allocator, request);
        }
    };
    for ([_]bool{ false, true }) |still_delivered| {
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        const base = try temp.dir.realpathAlloc(a, ".");
        defer a.free(base);
        const path = try std.fs.path.join(a, &.{ base, "native-confirm" });
        defer a.free(path);
        var database = try db.rocks.Database.open(a, path, .{});
        defer database.deinit();
        var store = @import("../store.zig").Store.init(a, &database, "origin");
        const mailbox = [_]u8{0} ** 12 ++ [_]u8{2} ** 20;
        const message: protocol.Message = .{ .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(1), .recipient = mailbox, .body = "native source confirmation" };
        _ = try store.storeMessage(message, 1, null);
        const http = @import("../../cloud/http.zig");
        var environment = std.process.EnvMap.init(a);
        defer environment.deinit();
        var resources: @import("../chain_source.zig").Resources = .{ .environment = &environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
        defer resources.http.deinit();
        defer resources.arena.deinit();
        resources.chain.protocol = .tron;
        resources.chain.domain = 2;
        resources.chain.chain_id = "728126428";
        resources.chain.contracts = .{ .mailbox = mailbox, .merkle_tree_hook = .{0} ** 12 ++ .{3} ** 20, .validator_announce = .{0} ** 12 ++ .{8} ** 20, .interchain_gas_paymaster = @splat(0) };
        const present = try word(a, 1);
        defer a.free(present);
        const absent = try word(a, 0);
        defer a.free(absent);
        var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &.{
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = present },
            .{ .method = .POST, .suffix = "/triggerconstantcontract", .response = if (still_delivered) present else absent },
        } };
        var observed: TimedTransport = .{ .mock = &network };
        var provider = try @import("../../tron/provider.zig").Provider.init(a, .{ .context = &observed, .send_fn = TimedTransport.send }, .{ .rpc_urls = &.{.{ .url = "https://fixture/rpc" }}, .wallet_urls = &.{.{ .url = "https://fixture/wallet" }}, .wallet_solidity_urls = &.{.{ .url = "https://fixture/walletsolidity" }} });
        resources.clients = .{ .tron = &provider };
        var local: @import("../../tron/transaction.zig").LocalSigner = .{ .secret_key = .{0x11} ** 32 };
        defer local.deinit();
        var factory: destination.Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .options = .{ .allow_fixture_transport = true, .origin_bindings = &.{.{ .domain = 1, .hook = .{9} ** 32 }} }, .backend_ready = true, .chain_checked = true, .backend = .{ .tron = .{ .chain = .{ .provider = &provider, .mailbox = .{2} ** 20, .hook = .{3} ** 20, .domain = 2 }, .announce = .{8} ** 20, .signer = try local.interface(), .chain_id = resources.chain.chain_id } } };
        defer factory.arena.deinit();
        var policy = try policy_module.Policy.init(a, .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }} }, null, null);
        defer policy.deinit();
        var history: History = .{};
        const driver: driver_module.Driver = .{ .options = .{ .observation_clock = .{ .context = &observed, .now_fn = TimedTransport.now } } };
        const initial: destination.operation.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
        const clock: destination.Clock = .{ .unix_ms = initial.unix_ms, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 10 * std.time.ns_per_s };
        const context = try factory.authorityFor(1, message.id(), 0, .process);
        const actor = try destination.operation.Operation.open(a, &store, .{ .id = message.id(), .context = try factory.contextFor(context), .nonce = 0, .origin = 1, .destination = 2 }, initial);
        defer actor.deinit();
        try std.testing.expectEqual(driver_module.State.reconciled, (try driver.step(a, &factory, actor, &history, &policy, message, clock, initial)).state);
        try std.testing.expect(!driver_module.queuedForSubmission(actor));
        var held_driver = driver;
        held_driver.options.prepare_allowed = false;
        try std.testing.expectEqual(@as(u64, 610000), actor.value.next_attempt_ms);
        try std.testing.expect(!try store.processed(0));
        observed.times = .{ .unix_ms = 610999, .monotonic_ms = 609999 };
        try std.testing.expectEqual(driver_module.State.idle, (try held_driver.step(a, &factory, actor, &history, &policy, message, clock, initial)).state);
        observed.times = .{ .unix_ms = 611000, .monotonic_ms = 610000 };
        const report = try held_driver.step(a, &factory, actor, &history, &policy, message, clock, initial);
        try std.testing.expectEqual(if (still_delivered) driver_module.State.delivered else driver_module.State.retried, report.state);
        try std.testing.expectEqual(still_delivered, try store.processed(0));
        try std.testing.expectEqual(still_delivered, actor.value.confirmation_started);
        try std.testing.expect(actor.signed == null);
        try std.testing.expect(actor.value.transaction == null);
        try network.expectDone();
    }
}
