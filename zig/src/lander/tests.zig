const std = @import("std");
const rocks = @import("../db/rocks.zig");
const signature = @import("../protocol/signature.zig");
const types = @import("types.zig");
const storage = @import("store.zig");
const nonce = @import("nonce.zig");
const service = @import("service.zig");
const chain = @import("chain.zig");
const records = @import("records.zig");
const multicall = @import("multicall.zig");
const Message = @import("../protocol/message.zig").Message;
const abi = @import("../evm/codecs.zig");
const observer = @import("observer.zig");

const DbFixture = struct {
    temp: std.testing.TmpDir,
    database: rocks.Database,

    fn open(allocator: std.mem.Allocator) !DbFixture {
        var temp = std.testing.tmpDir(.{});
        errdefer temp.cleanup();
        const path = try temp.dir.realpathAlloc(allocator, ".");
        defer allocator.free(path);
        return .{ .temp = temp, .database = try rocks.Database.open(allocator, path, .{ .sync = true, .retain_rollback_wal = true }) };
    }

    fn close(self: *DbFixture) void {
        self.database.deinit();
        self.temp.cleanup();
    }

    fn store(self: *DbFixture) storage.Store {
        return storage.Store.init(&self.database, "arbitrum");
    }
};

fn writeStatus(allocator: std.mem.Allocator, store: storage.Store, uuid: types.Uuid, status: []const u8) !void {
    const json = try std.fmt.allocPrint(allocator, "{{\"status\":{s}}}", .{status});
    defer allocator.free(json);
    try store.writeTransaction(allocator, uuid, json);
}

fn id(byte: u8) types.Uuid {
    return @splat(byte);
}

test "native nonce committed zero freed reuse missing and old owner protection" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    var manager = nonce.Manager.init(store, @splat(0x22));
    try manager.updateBoundaryFromAccountNonce(allocator, 1);
    try std.testing.expectEqual(@as(?u256, 0), try store.finalizedNonce(allocator, manager.signer));
    try writeStatus(allocator, store, id(1), "\"PendingInclusion\"");
    try std.testing.expectEqual(@as(u256, 1), (try manager.reserve(allocator, id(1), null)).nonce);
    try manager.updateBoundaryFromAccountNonce(allocator, 0);
    const regression = (try store.reorgRange(allocator, manager.signer)).?;
    try std.testing.expectEqual(@as(u256, 0), regression.start);
    try std.testing.expectEqual(@as(u256, 0), regression.end);
    try manager.updateBoundaryFromAccountNonce(allocator, 1);
    try std.testing.expectEqual(regression, (try store.reorgRange(allocator, manager.signer)).?);

    try writeStatus(allocator, store, id(1), "{\"Dropped\":\"DroppedByChain\"}");
    try writeStatus(allocator, store, id(2), "\"PendingInclusion\"");
    try std.testing.expectEqual(@as(u256, 1), (try manager.reserve(allocator, id(2), null)).nonce);
    try std.testing.expectEqual(@as(u256, 1), (try manager.reserve(allocator, id(2), 1)).nonce);

    try writeStatus(allocator, store, id(3), "\"PendingInclusion\"");
    try std.testing.expectEqual(@as(u256, 2), (try manager.reserve(allocator, id(3), null)).nonce);
    var conflict = try store.typed.batch(allocator);
    defer conflict.deinit();
    try storage.Store.putTracked(&conflict, manager.signer, 1, id(3));
    try conflict.commitSync();
    try std.testing.expectEqual(@as(u256, 3), (try manager.reserve(allocator, id(2), 1)).nonce);
    try std.testing.expectEqual(id(3), try store.trackedUuid(allocator, manager.signer, 1));
    try std.testing.expectEqual(id(3), try store.trackedUuid(allocator, manager.signer, 2));

    var batch = try store.typed.batch(allocator);
    defer batch.deinit();
    try storage.Store.putTracked(&batch, manager.signer, 9, id(99));
    try batch.commitSync();
    try std.testing.expect(try manager.nonceAvailable(allocator, 9));
    try std.testing.expect(try manager.nonceAvailable(allocator, 10));
}

test "native reservation survives crash and boundary allocation serializes" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    var manager = nonce.Manager.init(store, @splat(0x23));
    try writeStatus(allocator, store, id(7), "\"PendingInclusion\"");
    const reserved = try manager.reserve(allocator, id(7), null);
    try std.testing.expectEqual(@as(u256, 0), reserved.nonce);
    const recovered = try manager.validateAndReserve(allocator, id(7), null, .pending_inclusion);
    try std.testing.expectEqual(reserved.nonce, recovered.nonce);

    const Context = struct {
        manager: *nonce.Manager,
        allocator: std.mem.Allocator,
        result: ?u256 = null,
        failure: ?anyerror = null,
        fn run(context: *@This(), byte: u8) void {
            const uuid = id(byte);
            writeStatus(context.allocator, context.manager.store, uuid, "\"PendingInclusion\"") catch |err| {
                context.failure = err;
                return;
            };
            const value = context.manager.reserve(context.allocator, uuid, null) catch |err| {
                context.failure = err;
                return;
            };
            context.result = value.nonce;
            context.manager.updateBoundaryFromAccountNonce(context.allocator, byte % 3) catch |err| {
                context.failure = err;
            };
        }
    };
    var contexts: [6]Context = undefined;
    var threads: [6]std.Thread = undefined;
    for (&contexts) |*context| context.* = .{ .manager = &manager, .allocator = allocator };
    for (&threads, 0..) |*thread, i| thread.* = try std.Thread.spawn(.{}, Context.run, .{ &contexts[i], @as(u8, @intCast(i + 20)) });
    for (threads) |thread| thread.join();
    var seen = std.AutoHashMap(u256, void).init(allocator);
    defer seen.deinit();
    for (&contexts) |*context| {
        if (context.failure) |err| return err;
        const value = context.result.?;
        try std.testing.expect(!seen.contains(value));
        try seen.put(value, {});
    }
}

test "signed attempts and exact Rust nonce keys persist" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    const signer: types.Address = @splat(0x24);
    var manager = nonce.Manager.init(store, signer);
    try manager.updateBoundaryFromAccountNonce(allocator, 1);
    var key = try std.mem.concat(allocator, u8, &.{ "arbitrum_", storage.finalized_nonce_by_signer, &signer });
    defer allocator.free(key);
    const finalized = (try fixture.database.get(allocator, key)).?;
    defer allocator.free(finalized);
    try std.testing.expectEqualSlices(u8, &([_]u8{0} ** 32), finalized);
    allocator.free(key);
    key = try std.mem.concat(allocator, u8, &.{ "arbitrum_", storage.finalized_nonce_present_by_signer, &signer });
    const present = (try fixture.database.get(allocator, key)).?;
    defer allocator.free(present);
    try std.testing.expectEqualSlices(u8, &.{1}, present);

    const first: types.Hash = @splat(0x31);
    const second: types.Hash = @splat(0x32);
    try store.writeSubmission(allocator, id(8), "{\"status\":\"PendingInclusion\"}", .{ .hash = first, .nonce = 0, .bytes = "signed-one" });
    try store.writeSubmission(allocator, id(8), "{\"status\":\"PendingInclusion\"}", .{ .hash = second, .nonce = 0, .bytes = "signed-two" });
    const one = (try store.loadAttempt(allocator, id(8), first)).?;
    defer allocator.free(one.bytes);
    const two = (try store.loadAttempt(allocator, id(8), second)).?;
    defer allocator.free(two.bytes);
    try std.testing.expectEqualStrings("signed-one", one.bytes);
    try std.testing.expectEqualStrings("signed-two", two.bytes);
}

const MockChain = struct {
    allocator: std.mem.Allocator,
    next_nonce: u256 = 0,
    finalized_height: u64 = 0,
    latest: chain.LatestBlock = .{ .number = 1, .base_fee = 10, .gas_limit = 30_000_000 },
    rewards: []const u256 = &.{1},
    gas_estimate: u256 = 21_000,
    zks_fee: chain.ZksFee = .{ .gas_limit = 21_000, .max_fee_per_gas = 30, .max_priority_fee_per_gas = 2, .gas_per_pubdata_limit = 800 },
    zks_failure: ?anyerror = null,
    code: []const u8 = &.{1},
    receipts: std.AutoHashMap(types.Hash, chain.Receipt),
    missing_gas_fields: bool = false,
    receipt_errors: std.AutoHashMap(types.Hash, anyerror),
    receipt_calls: std.AutoHashMap(types.Hash, u64),
    headers: std.AutoHashMap(u64, chain.Header),
    sent: std.ArrayList([]u8) = .empty,
    send_failure: ?anyerror = null,
    call_success: bool = true,
    simulation_results: ?[]const u8 = null,
    last_call_block: ?u64 = null,
    last_call_value: ?u256 = null,
    zks_calls: u64 = 0,

    fn init(allocator: std.mem.Allocator) MockChain {
        return .{ .allocator = allocator, .receipts = std.AutoHashMap(types.Hash, chain.Receipt).init(allocator), .receipt_errors = std.AutoHashMap(types.Hash, anyerror).init(allocator), .receipt_calls = std.AutoHashMap(types.Hash, u64).init(allocator), .headers = std.AutoHashMap(u64, chain.Header).init(allocator) };
    }

    fn close(self: *MockChain) void {
        for (self.sent.items) |bytes| self.allocator.free(bytes);
        self.sent.deinit(self.allocator);
        self.receipts.deinit();
        self.receipt_errors.deinit();
        self.receipt_calls.deinit();
        self.headers.deinit();
    }

    fn interface(self: *MockChain) chain.Chain {
        return .{ .context = self, .latest_block_fn = latestBlock, .fee_history_fn = feeHistory, .estimate_gas_fn = estimateGas, .account_nonce_finalized_fn = accountNonce, .finalized_height_fn = finalizedHeight, .receipt_fn = receipt, .block_header_fn = blockHeader, .send_raw_fn = sendRaw, .call_fn = call, .get_code_fn = getCode, .zks_estimate_fee_fn = zksFee };
    }

    fn latestBlock(context: *anyopaque) !chain.LatestBlock {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return self.latest;
    }
    fn feeHistory(context: *anyopaque, allocator: std.mem.Allocator, _: u64) !chain.FeeHistory {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return .{ .allocator = allocator, .rewards = try allocator.dupe(u256, self.rewards) };
    }
    fn estimateGas(context: *anyopaque, _: types.Request, _: types.Address) !u256 {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return self.gas_estimate;
    }
    fn accountNonce(context: *anyopaque, _: types.Address) !u256 {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return self.next_nonce;
    }
    fn finalizedHeight(context: *anyopaque) !u64 {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return self.finalized_height;
    }
    fn receipt(context: *anyopaque, hash: types.Hash) !?chain.Receipt {
        const self: *MockChain = @ptrCast(@alignCast(context));
        const calls = try self.receipt_calls.getOrPut(hash);
        if (!calls.found_existing) calls.value_ptr.* = 0;
        calls.value_ptr.* += 1;
        if (self.receipt_errors.get(hash)) |err| return err;
        var result = self.receipts.get(hash) orelse return null;
        if (!self.missing_gas_fields) {
            if (result.gas_used == null) result.gas_used = 21_000;
            if (result.effective_gas_price == null) result.effective_gas_price = 0;
        }
        return result;
    }
    fn blockHeader(context: *anyopaque, number: u64) !chain.Header {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return self.headers.get(number) orelse error.MissingBlock;
    }
    fn sendRaw(context: *anyopaque, bytes: []const u8) !types.Hash {
        const self: *MockChain = @ptrCast(@alignCast(context));
        try self.sent.append(self.allocator, try self.allocator.dupe(u8, bytes));
        if (self.send_failure) |err| return err;
        var hash: types.Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(bytes, &hash, .{});
        return hash;
    }
    fn call(context: *anyopaque, allocator: std.mem.Allocator, request: chain.Call, block: u64) ![]u8 {
        const self: *MockChain = @ptrCast(@alignCast(context));
        self.last_call_block = block;
        self.last_call_value = request.value;
        if (self.simulation_results) |results| return allocator.dupe(u8, results);
        const result = try allocator.alloc(u8, 32);
        @memset(result, 0);
        result[31] = @intFromBool(self.call_success);
        return result;
    }
    fn getCode(context: *anyopaque, allocator: std.mem.Allocator, _: types.Address) ![]u8 {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return allocator.dupe(u8, self.code);
    }
    fn zksFee(context: *anyopaque, _: types.Request, _: types.Address) !chain.ZksFee {
        const self: *MockChain = @ptrCast(@alignCast(context));
        self.zks_calls += 1;
        if (self.zks_failure) |err| return err;
        return self.zks_fee;
    }
};

const MockSigner = struct {
    key: types.Hash = @splat(0x11),
    address: types.Address,

    fn init() !MockSigner {
        return .{ .address = try signature.secretKeyAddress(@splat(0x11)) };
    }
    fn signer(self: *MockSigner) service.Signer {
        return .{ .context = self, .address = self.address, .sign_fn = sign };
    }
    fn sign(context: *anyopaque, digest: types.Hash) !types.Signature {
        const self: *MockSigner = @ptrCast(@alignCast(context));
        return signature.signDigest(self.key, digest, null);
    }
};

fn legacyPayload(uuid: types.Uuid) service.EnqueueInput {
    return .{ .payload = .{
        .uuid = uuid,
        .metadata = "message",
        .data_json = "[{\"type\":\"0x00\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\"},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]",
        .gas_limit = 21_000,
        .to = @splat(0),
    } };
}

test "service timeout after accepted broadcast recovers exact bytes before finalizing" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.send_failure = error.RequestDeadlineExceeded;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(legacyPayload(id(40)));
    _ = try running.tick(1_000, .{});
    const submitted = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(usize, 1), submitted.deferred);
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    const tx_hashes = try records.hashes(allocator, record.value());
    defer allocator.free(tx_hashes);
    try std.testing.expectEqual(@as(usize, 1), tx_hashes.len);
    const attempt = (try fixture.store().loadAttempt(allocator, uuid, tx_hashes[0])).?;
    defer allocator.free(attempt.bytes);
    try std.testing.expectEqualSlices(u8, mock.sent.items[0], attempt.bytes);
    running.deinit();

    const block_hash: types.Hash = @splat(0x44);
    try mock.receipts.put(tx_hashes[0], .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    mock.send_failure = null;
    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const finalized = try restarted.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
}

test "same fee retry rebroadcasts identical durable bytes without duplicate hash" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.send_failure = error.RequestDeadlineExceeded;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(41)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    _ = try running.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 2), mock.sent.items.len);
    try std.testing.expectEqualSlices(u8, mock.sent.items[0], mock.sent.items[1]);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    const tx_hashes = try records.hashes(allocator, record.value());
    defer allocator.free(tx_hashes);
    try std.testing.expectEqual(@as(usize, 1), tx_hashes.len);
    try std.testing.expectEqual(@as(u256, 2), try types.uintField(record.value(), "submission_attempts"));
}

fn dynamicPayload(uuid: types.Uuid) service.EnqueueInput {
    return .{ .payload = .{
        .uuid = uuid,
        .metadata = "message",
        .data_json = "[{\"type\":\"0x02\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\",\"maxFeePerGas\":\"0x20\",\"maxPriorityFeePerGas\":\"0x1\",\"accessList\":[]},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]",
        .gas_limit = 21_000,
        .to = @splat(0),
    } };
}

fn mevPayload(allocator: std.mem.Allocator, uuid: types.Uuid, body: u8) !service.EnqueueInput {
    const message: Message = .{ .recipient = @splat(0x42), .body = &.{body} };
    const encoded = try message.encodeAlloc(allocator);
    defer allocator.free(encoded);
    const calldata = try abi.processCalldata(allocator, &.{}, encoded);
    defer allocator.free(calldata);
    const hex = try abi.hexAlloc(allocator, calldata);
    defer allocator.free(hex);
    return .{ .payload = .{
        .uuid = uuid,
        .metadata = "message",
        .data_json = try std.fmt.allocPrint(allocator, "[{{\"type\":\"0x00\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x0\",\"data\":\"{s}\",\"nonce\":null,\"chainId\":\"0x1\"}},{{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}}]", .{hex}),
        .gas_limit = 21_000,
        .to = @splat(0),
    } };
}

test "every replacement hash is paged and oldest finalized attempt wins after restart" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.send_failure = error.RequestDeadlineExceeded;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(dynamicPayload(id(42)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    mock.send_failure = null;
    mock.rewards = &.{2};
    _ = try running.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 2), mock.sent.items.len);
    try std.testing.expect(!std.mem.eql(u8, mock.sent.items[0], mock.sent.items[1]));
    running.deinit();

    var old_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &old_hash, .{});
    const block_hash: types.Hash = @splat(0x45);
    try mock.receipts.put(old_hash, .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const partial = try restarted.tick(300_000, .{ .max_receipts = 1 });
    try std.testing.expectEqual(@as(usize, 0), partial.finalized);
    const finalized = try restarted.tick(301_000, .{ .max_receipts = 1 });
    try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
    try std.testing.expectEqual(@as(usize, 2), mock.sent.items.len);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    const tx_hashes = try records.hashes(allocator, record.value());
    defer allocator.free(tx_hashes);
    try std.testing.expectEqual(@as(usize, 2), tx_hashes.len);
}

test "noncanonical receipt is pending and finalized reverted execution only drops payload" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.call_success = false;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    var input = legacyPayload(id(43));
    input.payload.success_criteria_json = input.payload.data_json;
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    var tx_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &tx_hash, .{});
    const canonical_hash: types.Hash = @splat(0x46);
    const wrong_hash: types.Hash = @splat(0x47);
    try mock.headers.put(1, .{ .number = 1, .hash = canonical_hash });
    try mock.receipts.put(tx_hash, .{ .block_number = 1, .block_hash = wrong_hash });
    mock.finalized_height = 1;
    const reorged = try running.tick(100_001, .{});
    try std.testing.expectEqual(@as(usize, 0), reorged.finalized);
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    try mock.receipts.put(tx_hash, .{ .block_number = 1, .block_hash = canonical_hash });
    mock.next_nonce = 1;
    const finalized = try running.tick(102_000, .{});
    try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
    try std.testing.expectEqual(@as(usize, 1), finalized.reverted_payloads);
    const payload_uuid = id(43);
    var payload = (try fixture.store().loadPayload(allocator, payload_uuid)).?;
    defer payload.deinit();
    const status = try types.field(payload.value(), "status");
    try std.testing.expect(status == .object);
    try std.testing.expectEqualStrings("Reverted", status.object.get("Dropped").?.string);
}

test "enqueue conflicts unsupported branches and cancellation fail visibly" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer() };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(44)));
    try std.testing.expect(!(try running.enqueue(legacyPayload(id(44)))).created);
    var conflict = legacyPayload(id(44));
    conflict.payload.metadata = "different";
    try std.testing.expectError(error.PayloadAssociationConflict, running.enqueue(conflict));
    var proof_conflict = legacyPayload(id(44));
    proof_conflict.delivery = .{ .mailbox_message = @splat(1) };
    try std.testing.expectError(error.DeliveryAssociationConflict, running.enqueue(proof_conflict));
    cancel.store(true, .release);
    try std.testing.expectError(error.Cancelled, running.tick(1, .{}));
    cancel.store(false, .release);
    config.max_batch_size = 2;
    var batch_service = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    batch_service.deinit();
    config.max_batch_size = 1;
    config.mev_submission = .{ .policy = .{ .mailbox = @splat(0x35), .ica_router = @splat(0x42) }, .protected_chain = mock.interface() };
    var mev_service = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    mev_service.deinit();
}

test "production Rust serde oracle accepts omitted EIP1559 chain id and all statuses" {
    const allocator = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(a, @embedFile("testing/reference/fixtures/lander_types.json.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    const fixture = try std.json.parseFromSliceLeaky(std.json.Value, a, fixture_bytes, .{ .allocate = .alloc_always });
    const payload = try types.field(fixture, "full_payload");
    try std.testing.expectEqual(@as(u256, 250_000), try types.uintField(payload, "gas_limit"));
    try std.testing.expectEqual(@as(u8, 0x00), (try records.payloadUuid(payload))[0]);
    const transaction_value = try types.field(fixture, "transaction");
    try std.testing.expectEqual(types.Status.finalized, try records.status(transaction_value));
    const request_value = try types.requestFromRecord(transaction_value);
    try std.testing.expect(types.optionalField(request_value, "chainId") == null);
    const request = try types.parseRequest(a, request_value);
    try std.testing.expectEqual(@as(u256, 0), request.request.eip1559.chain_id);
    try std.testing.expectEqual(@as(u256, 7), request.request.eip1559.nonce);
    try std.testing.expectEqual(@as(u256, 110), request.request.eip1559.max_fee_per_gas);
    const raw_hashes = try types.field(transaction_value, "tx_hashes");
    try std.testing.expectEqual(@as(usize, 2), raw_hashes.array.items.len);
    const statuses = try types.field(fixture, "transaction_statuses");
    const expected = [_]types.Status{ .pending_inclusion, .mempool, .included, .finalized, .{ .dropped = .dropped_by_chain } };
    for (statuses.array.items, expected) |raw, status| try std.testing.expectEqual(status, try types.statusFromJson(raw));
}

test "bounded nonce scan resumes and finds freed gap without skipping it" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    var manager = nonce.Manager.init(store, @splat(0x25));
    for ([_]u8{ 60, 61, 62 }, 0..) |byte, expected| {
        try writeStatus(allocator, store, id(byte), "\"PendingInclusion\"");
        try std.testing.expectEqual(@as(u256, expected), (try manager.reserve(allocator, id(byte), null)).nonce);
    }
    manager.max_scan = 1;
    try writeStatus(allocator, store, id(61), "{\"Dropped\":\"DroppedByChain\"}");
    try writeStatus(allocator, store, id(63), "\"PendingInclusion\"");
    try std.testing.expectError(error.NonceScanBudgetExceeded, manager.reserve(allocator, id(63), null));
    try manager.updateBoundaryFromAccountNonce(allocator, 0);
    try std.testing.expectEqual(@as(u256, 1), (try manager.reserve(allocator, id(63), null)).nonce);
}

test "startup stale recovery drops delivered transaction without another nonce or broadcast" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    var input = legacyPayload(id(64));
    input.delivery = .{ .mailbox_message = @splat(0x51) };
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    running.deinit();
    try fixture.store().setActiveCheckpoint(allocator);

    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const recovered = try restarted.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 1), recovered.stale_dropped);
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var status = (try fixture.store().transactionStatus(allocator, uuid)).?;
    defer status.deinit(allocator);
    try std.testing.expect(status.value == .dropped);
}

test "canonical pending rebuild is paged and legacy missing gas limit builds" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer() };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(legacyPayload(id(65)));
    _ = try running.enqueue(legacyPayload(id(66)));
    var legacy = (try fixture.store().loadPayload(allocator, id(65))).?;
    defer legacy.deinit();
    _ = legacy.parsed.value.object.orderedRemove("gas_limit");
    const legacy_json = try std.json.Stringify.valueAlloc(allocator, legacy.value(), .{});
    defer allocator.free(legacy_json);
    _ = try fixture.store().writePayload(allocator, id(65), legacy_json, legacy_json, .none);
    var legacy_retry = legacyPayload(id(65));
    legacy_retry.payload.gas_limit = 0;
    try std.testing.expect(!(try running.enqueue(legacy_retry)).created);
    var clear = try fixture.store().typed.batch(allocator);
    defer clear.deinit();
    try clear.deletePrefix(storage.pending_payload_by_index);
    try clear.commitSync();
    running.deinit();

    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const first = try restarted.tick(1_000, .{ .max_payload_scan = 1 });
    try std.testing.expectEqual(@as(usize, 0), first.built);
    const second = try restarted.tick(2_000, .{ .max_payload_scan = 1 });
    try std.testing.expectEqual(@as(usize, 1), second.built);
    const third = try restarted.tick(3_000, .{ .max_payload_scan = 1 });
    try std.testing.expectEqual(@as(usize, 1), third.built);
    try std.testing.expectEqual(@as(u32, 2), try fixture.store().highestTransactionIndex(allocator));
}

test "included payload criterion uses current head not older finalized height" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.call_success = false;
    mock.latest.number = 5;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    var input = legacyPayload(id(67));
    input.payload.success_criteria_json = input.payload.data_json;
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var tx_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &tx_hash, .{});
    const block_hash: types.Hash = @splat(0x52);
    try mock.receipts.put(tx_hash, .{ .block_number = 5, .block_hash = block_hash });
    try mock.headers.put(5, .{ .number = 5, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    const included = try running.tick(101_000, .{});
    try std.testing.expectEqual(@as(usize, 0), included.finalized);
    try std.testing.expectEqual(@as(usize, 1), included.reverted_payloads);
    try std.testing.expectEqual(@as(?u64, 5), mock.last_call_block);
}

test "recovered finalized boundary does not clear reorg range before bounded drain" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(68)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var tx_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &tx_hash, .{});
    const block_hash: types.Hash = @splat(0x53);
    try mock.receipts.put(tx_hash, .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 11;
    _ = try running.tick(100_001, .{});
    mock.next_nonce = 6;
    _ = try running.tick(102_000, .{ .max_reorg = 1 });
    if ((try fixture.store().reorgRange(allocator, signer.address)) == null) return error.ExpectedInitialReorgRange;
    mock.next_nonce = 0;
    mock.receipts.clearRetainingCapacity();
    _ = try running.tick(102_001, .{ .max_reorg = 1 });
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    if ((try fixture.store().transactionStatus(allocator, uuid)).?.value != .pending_inclusion) return error.ExpectedPendingAfterRangeExtension;
    if ((try fixture.store().reorgRange(allocator, signer.address)) == null) return error.ExpectedRangeAfterExtension;
    _ = try running.tick(102_002, .{ .max_reorg = 1 });
    if ((try fixture.store().reorgRange(allocator, signer.address)) == null) return error.ExpectedRangeBeforeFinalDrain;
    for (0..10) |offset| _ = try running.tick(102_003 + offset, .{ .max_reorg = 1 });
    try std.testing.expectEqual(@as(?storage.ReorgRange, null), try fixture.store().reorgRange(allocator, signer.address));
}

test "configured submit queue length applies backpressure until finality" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_submit_queue_length = 1, .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(69)));
    _ = try running.enqueue(legacyPayload(id(70)));
    const first = try running.tick(1_000, .{});
    try std.testing.expectEqual(@as(usize, 1), first.built);
    const blocked = try running.tick(2_000, .{});
    try std.testing.expectEqual(@as(usize, 0), blocked.built);
    try std.testing.expect(blocked.deferred > 0);
    _ = try running.tick(100_000, .{});
    var tx_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &tx_hash, .{});
    const block_hash: types.Hash = @splat(0x54);
    try mock.receipts.put(tx_hash, .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    const finalized = try running.tick(101_000, .{});
    try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
    const admitted = try running.tick(102_000, .{});
    try std.testing.expectEqual(@as(usize, 1), finalized.built + admitted.built);
}

test "dropped status behind saved nonce cursor invalidates resume generation" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    var manager = nonce.Manager.init(store, @splat(0x26));
    for ([_]u8{ 71, 72, 73 }, 0..) |byte, expected| {
        try writeStatus(allocator, store, id(byte), "\"PendingInclusion\"");
        try std.testing.expectEqual(@as(u256, expected), (try manager.reserve(allocator, id(byte), null)).nonce);
    }
    manager.max_scan = 1;
    try writeStatus(allocator, store, id(74), "\"PendingInclusion\"");
    try std.testing.expectError(error.NonceScanBudgetExceeded, manager.reserve(allocator, id(74), null));
    try writeStatus(allocator, store, id(71), "{\"Dropped\":\"DroppedByChain\"}");
    try std.testing.expectEqual(@as(u256, 0), (try manager.reserve(allocator, id(74), null)).nonce);
}

test "ready payload with dropped transaction association rebuilds atomically" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer() };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(legacyPayload(id(75)));
    const old_uuid = id(76);
    try writeStatus(allocator, fixture.store(), old_uuid, "{\"Dropped\":\"DroppedByChain\"}");
    var association = try fixture.store().typed.batch(allocator);
    defer association.deinit();
    try association.put(storage.transaction_uuid_by_payload_uuid, &id(75), &old_uuid);
    try association.commitSync();
    running.deinit();

    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const rebuilt = try restarted.tick(1_000, .{});
    try std.testing.expectEqual(@as(usize, 1), rebuilt.built);
    const new_uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    try std.testing.expectEqual(new_uuid, (try fixture.store().payloadTransaction(allocator, id(75))).?);
}

test "reorg reactivation consumes configured submit queue capacity" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_submit_queue_length = 1, .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(77)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var tx_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &tx_hash, .{});
    const block_hash: types.Hash = @splat(0x55);
    try mock.receipts.put(tx_hash, .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    _ = try running.tick(100_001, .{});
    _ = try running.enqueue(legacyPayload(id(78)));
    mock.next_nonce = 0;
    mock.receipts.clearRetainingCapacity();
    const blocked = try running.tick(102_000, .{});
    try std.testing.expectEqual(@as(usize, 0), blocked.built);
    try std.testing.expect(blocked.deferred > 0);
}

test "absent receipt is refreshed and later finalizes" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(79)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var tx_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &tx_hash, .{});
    _ = try running.tick(100_001, .{});
    const block_hash: types.Hash = @splat(0x56);
    try mock.receipts.put(tx_hash, .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    const finalized = try running.tick(102_000, .{});
    try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
}

test "recovery holds new builds and nonces through pages errors and restart" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.send_failure = error.RequestDeadlineExceeded;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(dynamicPayload(id(80)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    mock.send_failure = null;
    mock.rewards = &.{2};
    _ = try running.tick(200_000, .{});
    _ = try running.enqueue(legacyPayload(id(81)));
    running.config.estimated_block_time_ms = 1_000_000;
    _ = try running.tick(300_000, .{});
    _ = try running.tick(400_000, .{});
    _ = try running.enqueue(legacyPayload(id(82)));
    try std.testing.expectEqual(@as(usize, 3), mock.sent.items.len);
    running.deinit();

    var hashes: [2]types.Hash = undefined;
    for (mock.sent.items[0..2], 0..) |bytes, i| std.crypto.hash.sha3.Keccak256.hash(bytes, &hashes[i], .{});
    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    const upper = try fixture.store().upperNonce(allocator, signer.address);
    var report = try restarted.tick(500_000, .{ .max_receipts = 1, .max_transactions = 1 });
    try std.testing.expect(!report.recovery_complete and report.built == 0);
    try mock.receipt_errors.put(hashes[0], error.RpcTimeout);
    report = try restarted.tick(501_000, .{ .max_receipts = 1, .max_transactions = 1 });
    try std.testing.expect(!report.recovery_complete and report.built == 0);
    _ = mock.receipt_errors.remove(hashes[0]);
    report = try restarted.tick(502_000, .{ .max_receipts = 1, .max_transactions = 1 });
    try std.testing.expect(!report.recovery_complete and report.built == 0);
    restarted.deinit();

    restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    report = try restarted.tick(503_000, .{ .max_receipts = 1, .max_transactions = 1 });
    try std.testing.expect(!report.recovery_complete and report.built == 0);
    try mock.receipt_errors.put(hashes[1], error.RpcTimeout);
    report = try restarted.tick(504_000, .{ .max_receipts = 1, .max_transactions = 1 });
    try std.testing.expect(!report.recovery_complete and report.built == 0);
    try std.testing.expectEqual(upper, try fixture.store().upperNonce(allocator, signer.address));
    _ = mock.receipt_errors.remove(hashes[1]);
    report = try restarted.tick(505_000, .{ .max_receipts = 1, .max_transactions = 1 });
    var final_pages: usize = 0;
    while (!report.recovery_complete and final_pages < 10) : (final_pages += 1) report = try restarted.tick(506_000 + final_pages, .{ .max_receipts = 1, .max_transactions = 1 });
    try std.testing.expect(report.recovery_complete);
    try std.testing.expectEqual(upper, try fixture.store().upperNonce(allocator, signer.address));
    try std.testing.expectEqual(@as(usize, 3), mock.sent.items.len);
    restarted.deinit();
}

test "request access list malformed second entry and all allocation failures are safe" {
    const valid = "{\"type\":\"0x02\",\"chainId\":\"0x1\",\"nonce\":\"0x0\",\"gas\":\"0x5208\",\"maxFeePerGas\":\"0x2\",\"maxPriorityFeePerGas\":\"0x1\",\"to\":null,\"value\":\"0x0\",\"data\":\"0x\",\"accessList\":[{\"address\":\"0x3535353535353535353535353535353535353535\",\"storageKeys\":[]},{\"address\":\"0x3636363636363636363636363636363636363636\",\"storageKeys\":[]}]}";
    const Sweep = struct {
        fn run(allocator: std.mem.Allocator) !void {
            var arena = std.heap.ArenaAllocator.init(allocator);
            defer arena.deinit();
            const a = arena.allocator();
            const parsed = try std.json.parseFromSliceLeaky(std.json.Value, a, valid, .{});
            _ = try types.parseRequest(a, parsed);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Sweep.run, .{});
    const malformed = "{\"type\":\"0x02\",\"chainId\":\"0x1\",\"accessList\":[{\"address\":\"0x3535353535353535353535353535353535353535\",\"storageKeys\":[]},{\"address\":7,\"storageKeys\":[]}]}";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const parsed = try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), malformed, .{});
    try std.testing.expectError(error.InvalidLanderRecord, types.parseRequest(arena.allocator(), parsed));
}

test "multicall build uses aggregate calldata and one atomic association" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .bypass_batch_simulation = true };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(90)));
    _ = try running.enqueue(legacyPayload(id(91)));
    const built = try running.tick(1_000, .{});
    try std.testing.expectEqual(@as(usize, 1), built.built);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    const details = try types.field(record.value(), "payload_details");
    try std.testing.expectEqual(@as(usize, 2), details.array.items.len);
    var request = try types.parseRequest(allocator, try types.requestFromRecord(record.value()));
    defer request.deinit(allocator);
    try std.testing.expectEqualSlices(u8, &multicall.aggregate3_selector, request.owned_data[0..4]);
    try std.testing.expectEqual(uuid, (try fixture.store().payloadTransaction(allocator, id(90))).?);
    try std.testing.expectEqual(uuid, (try fixture.store().payloadTransaction(allocator, id(91))).?);
}

test "multicall missing code and cap precheck fall back to independent transactions" {
    const allocator = std.testing.allocator;
    for ([_]enum { missing_code, cap }{ .missing_code, .cap }) |mode| {
        var fixture = try DbFixture.open(allocator);
        defer fixture.close();
        var mock = MockChain.init(allocator);
        defer mock.close();
        if (mode == .missing_code) mock.code = &.{};
        var signer = try MockSigner.init();
        var cancel = std.atomic.Value(bool).init(false);
        var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .bypass_batch_simulation = true };
        if (mode == .cap) config.overrides.gas_limit_cap = 1_000;
        var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
        defer running.deinit();
        _ = try running.enqueue(legacyPayload(id(92)));
        _ = try running.enqueue(legacyPayload(id(93)));
        const built = try running.tick(1_000, .{});
        try std.testing.expectEqual(@as(usize, 2), built.built);
        try std.testing.expectEqual(@as(u32, 2), try fixture.store().highestTransactionIndex(allocator));
        const first = (try fixture.store().payloadTransaction(allocator, id(92))).?;
        const second = (try fixture.store().payloadTransaction(allocator, id(93))).?;
        try std.testing.expect(!std.mem.eql(u8, &first, &second));
    }
}

test "partial multicall simulation rebuilds survivor and drops failed payload" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    const simulation = try multicall.encodeResults(allocator, &.{ .{ .success = true, .return_data = &.{} }, .{ .success = false, .return_data = &.{} } });
    defer allocator.free(simulation);
    mock.simulation_results = simulation;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(94)));
    _ = try running.enqueue(legacyPayload(id(95)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    const survivors = try records.payloadTransactionUuids(allocator, record.value());
    defer allocator.free(survivors);
    try std.testing.expectEqual(@as(usize, 1), survivors.len);
    try std.testing.expectEqual(id(94), survivors[0]);
    var failed = (try fixture.store().loadPayload(allocator, id(95))).?;
    defer failed.deinit();
    const status = try types.field(failed.value(), "status");
    try std.testing.expectEqualStrings("FailedSimulation", status.object.get("Dropped").?.string);
    try std.testing.expectEqual(uuid, (try fixture.store().payloadTransaction(allocator, id(95))).?);
}

test "multicall rebuild retains record-owned JSON after simulation returns" {
    const allocator = std.testing.allocator;
    for ([_]bool{ true, false }) |second_survives| {
        var fixture = try DbFixture.open(allocator);
        defer fixture.close();
        var mock = MockChain.init(allocator);
        defer mock.close();
        const simulation = try multicall.encodeResults(allocator, &.{ .{ .success = true, .return_data = &.{} }, .{ .success = second_survives, .return_data = &.{} } });
        defer allocator.free(simulation);
        mock.simulation_results = simulation;
        var signer = try MockSigner.init();
        var cancel = std.atomic.Value(bool).init(false);
        var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .estimated_block_time_ms = 1 };
        config.overrides.gas_price = 5;
        var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
        defer running.deinit();
        _ = try running.enqueue(legacyPayload(id(151)));
        _ = try running.enqueue(legacyPayload(id(152)));
        try std.testing.expectEqual(@as(usize, 1), (try running.tick(1_000, .{})).built);
        const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
        var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
        defer record.deinit();
        {
            var temporary = std.heap.ArenaAllocator.init(allocator);
            defer temporary.deinit();
            try service.NativeTests.simulateBatch(&running, &record, temporary.allocator(), mock.interface());
        }
        // A managed JSON container carries its allocator context, not just its
        // backing buffers. This assertion fails without touching freed memory.
        const owner = record.parsed.arena.allocator().ptr;
        const vm = try types.field(record.value(), "vm_specific_data");
        try std.testing.expect(vm.object.allocator.ptr == owner);
        const evm = try types.field(vm, "Evm");
        try std.testing.expect(evm.object.allocator.ptr == owner);
        const tx = try types.field(evm, "tx");
        try std.testing.expect(tx.object.allocator.ptr == owner);
        const details = try types.field(record.value(), "payload_details");
        try std.testing.expect(details.array.allocator.ptr == owner);
        try std.testing.expectEqual(@as(usize, if (second_survives) 2 else 1), details.array.items.len);
        for (details.array.items) |detail| try std.testing.expect(detail.object.allocator.ptr == owner);
        try churnSimulationMemory(allocator);
        const tx_ptr = try types.requestPtr(&record.parsed.value);
        for (0..48) |i| {
            const key = try std.fmt.allocPrint(record.parsed.arena.allocator(), "lifetime_growth_{d}", .{i});
            try tx_ptr.object.put(key, .{ .integer = @intCast(i) });
        }
        const serialized = try std.json.Stringify.valueAlloc(allocator, record.value(), .{});
        defer allocator.free(serialized);
        var reparsed = try std.json.parseFromSlice(std.json.Value, allocator, serialized, .{});
        defer reparsed.deinit();
        try std.testing.expectEqual(uuid, try records.transactionUuid(reparsed.value));
        const retained = try records.payloadTransactionUuids(allocator, reparsed.value);
        defer allocator.free(retained);
        try std.testing.expectEqual(id(151), retained[0]);
        if (second_survives) try std.testing.expectEqual(id(152), retained[1]);
        try std.testing.expectEqual(@as(u256, 47), try types.uintField(try types.requestFromRecord(reparsed.value), "lifetime_growth_47"));
    }
}

noinline fn churnSimulationMemory(allocator: std.mem.Allocator) !void {
    var stack: [8192]u8 = undefined;
    @memset(&stack, 0xb7);
    std.mem.doNotOptimizeAway(&stack);
    var blocks: [32][]u8 = undefined;
    var count: usize = 0;
    defer for (blocks[0..count]) |block| allocator.free(block);
    for (&blocks, 0..) |*block, i| {
        block.* = try allocator.alloc(u8, 256 + i * 17);
        count += 1;
        @memset(block.*, @intCast(i));
        std.mem.doNotOptimizeAway(block.*);
    }
}

test "multicall rebuild clone allocation failures leave both record fields and durable state unchanged" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    const simulation = try multicall.encodeResults(allocator, &.{ .{ .success = true, .return_data = &.{} }, .{ .success = true, .return_data = &.{} } });
    defer allocator.free(simulation);
    mock.simulation_results = simulation;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35) };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(155)));
    _ = try running.enqueue(legacyPayload(id(156)));
    _ = try running.tick(1_000, .{});
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var failures: usize = 0;
    var succeeded = false;
    for (0..64) |fail_index| {
        var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
        defer record.deinit();
        const before = try std.json.Stringify.valueAlloc(allocator, record.value(), .{});
        defer allocator.free(before);
        const durable_before = (try fixture.store().typed.get(allocator, storage.transaction_by_uuid, &uuid)).?;
        defer allocator.free(durable_before);
        var scratch = std.heap.ArenaAllocator.init(allocator);
        defer scratch.deinit();
        var failing = std.testing.FailingAllocator.init(allocator, .{ .fail_index = fail_index, .resize_fail_index = 0 });
        const outcome = blk: {
            const child = record.parsed.arena.child_allocator;
            record.parsed.arena.child_allocator = failing.allocator();
            defer record.parsed.arena.child_allocator = child;
            break :blk service.NativeTests.simulateBatch(&running, &record, scratch.allocator(), mock.interface());
        };
        if (outcome) |_| {
            succeeded = true;
            break;
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            failures += 1;
            const after = try std.json.Stringify.valueAlloc(allocator, record.value(), .{});
            defer allocator.free(after);
            try std.testing.expectEqualStrings(before, after);
            const durable_after = (try fixture.store().typed.get(allocator, storage.transaction_by_uuid, &uuid)).?;
            defer allocator.free(durable_after);
            try std.testing.expectEqualStrings(durable_before, durable_after);
            try std.testing.expectEqual(@as(usize, 0), mock.sent.items.len);
        }
    }
    try std.testing.expect(failures > 0);
    try std.testing.expect(succeeded);
}

test "multicall rebuild signs and finalizes exact durable bytes after database reopen" {
    const allocator = std.testing.allocator;
    for ([_]bool{ true, false }) |second_survives| {
        var fixture = try DbFixture.open(allocator);
        var database_open = true;
        defer if (database_open) fixture.close() else fixture.temp.cleanup();
        var mock = MockChain.init(allocator);
        defer mock.close();
        const simulation = try multicall.encodeResults(allocator, &.{ .{ .success = true, .return_data = &.{} }, .{ .success = second_survives, .return_data = &.{} } });
        defer allocator.free(simulation);
        mock.simulation_results = simulation;
        var signer = try MockSigner.init();
        var cancel = std.atomic.Value(bool).init(false);
        var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .estimated_block_time_ms = 1 };
        config.overrides.gas_price = 5;
        var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
        var running_open = true;
        defer if (running_open) running.deinit();
        _ = try running.enqueue(legacyPayload(id(153)));
        _ = try running.enqueue(legacyPayload(id(154)));
        try std.testing.expectEqual(@as(usize, 1), (try running.tick(1_000, .{})).built);
        try churnSimulationMemory(allocator);
        _ = try running.tick(100_000, .{});
        try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
        const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
        var hash: types.Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &hash, .{});
        const attempt = (try fixture.store().loadAttempt(allocator, uuid, hash)).?;
        defer allocator.free(attempt.bytes);
        try std.testing.expectEqual(@as(u256, 0), attempt.nonce);
        try std.testing.expectEqualSlices(u8, mock.sent.items[0], attempt.bytes);
        {
            var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
            defer record.deinit();
            const members = try records.payloadTransactionUuids(allocator, record.value());
            defer allocator.free(members);
            try std.testing.expectEqual(@as(usize, if (second_survives) 2 else 1), members.len);
            try std.testing.expectEqual(id(153), members[0]);
            if (second_survives) try std.testing.expectEqual(id(154), members[1]);
            try std.testing.expectEqual(@as(u256, 0), (try types.optionalUint(try types.requestFromRecord(record.value()), "nonce")).?);
            for ([_]types.Uuid{ id(153), id(154) }) |payload_uuid| {
                var payload = (try fixture.store().loadPayload(allocator, payload_uuid)).?;
                defer payload.deinit();
                try std.testing.expectEqual(@as(u256, 21_000), try types.uintField(payload.value(), "gas_limit"));
            }
        }
        running.deinit();
        running_open = false;
        const database_path = try fixture.temp.dir.realpathAlloc(allocator, ".");
        defer allocator.free(database_path);
        fixture.database.deinit();
        database_open = false;
        fixture.database = try rocks.Database.open(allocator, database_path, .{ .sync = true, .retain_rollback_wal = true });
        database_open = true;
        try churnSimulationMemory(allocator);
        const block_hash: types.Hash = @splat(0x5d);
        try mock.receipts.put(hash, .{ .block_number = 1, .block_hash = block_hash, .gas_used = 500, .effective_gas_price = 2 });
        try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
        mock.finalized_height = 1;
        mock.next_nonce = 1;
        var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
        defer restarted.deinit();
        const finalized = try restarted.tick(200_000, .{});
        try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
        try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
        const restored_attempt = (try fixture.store().loadAttempt(allocator, uuid, hash)).?;
        defer allocator.free(restored_attempt.bytes);
        try std.testing.expectEqualSlices(u8, attempt.bytes, restored_attempt.bytes);
        try std.testing.expectEqual(@as(u256, 0), restored_attempt.nonce);
        var status = (try fixture.store().transactionStatus(allocator, uuid)).?;
        defer status.deinit(allocator);
        try std.testing.expect(status.value == .finalized);
        if (!second_survives) {
            var failed = (try fixture.store().loadPayload(allocator, id(154))).?;
            defer failed.deinit();
            try std.testing.expectEqualStrings("FailedSimulation", (try types.field(failed.value(), "status")).object.get("Dropped").?.string);
        }
    }
}

test "MEV reveal uses protected chain while commit stays public" {
    const allocator = std.testing.allocator;
    for ([_]struct { body: u8, protected: bool }{ .{ .body = 2, .protected = true }, .{ .body = 1, .protected = false } }) |case| {
        var fixture = try DbFixture.open(allocator);
        defer fixture.close();
        var ordinary = MockChain.init(allocator);
        defer ordinary.close();
        var protected = MockChain.init(allocator);
        defer protected.close();
        var signer = try MockSigner.init();
        var cancel = std.atomic.Value(bool).init(false);
        const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .mev_submission = .{ .policy = .{ .mailbox = @splat(0x35), .ica_router = @splat(0x42) }, .protected_chain = protected.interface() } };
        var running = try service.Service.open(allocator, fixture.store(), ordinary.interface(), config, &cancel);
        defer running.deinit();
        const input = try mevPayload(allocator, id(96), case.body);
        defer allocator.free(input.payload.data_json);
        _ = try running.enqueue(input);
        _ = try running.tick(1_000, .{});
        _ = try running.tick(100_000, .{});
        try std.testing.expectEqual(@as(usize, @intFromBool(case.protected)), protected.sent.items.len);
        try std.testing.expectEqual(@as(usize, @intFromBool(!case.protected)), ordinary.sent.items.len);
    }
}

test "MEV mixed batch and timeout recover without public fallback" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var ordinary = MockChain.init(allocator);
    defer ordinary.close();
    var protected = MockChain.init(allocator);
    defer protected.close();
    protected.send_failure = error.RequestDeadlineExceeded;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .bypass_batch_simulation = true, .mev_submission = .{ .policy = .{ .mailbox = @splat(0x35), .ica_router = @splat(0x42) }, .protected_chain = protected.interface() } };
    var running = try service.Service.open(allocator, fixture.store(), ordinary.interface(), config, &cancel);
    const reveal = try mevPayload(allocator, id(97), 2);
    defer allocator.free(reveal.payload.data_json);
    const commit = try mevPayload(allocator, id(98), 1);
    defer allocator.free(commit.payload.data_json);
    _ = try running.enqueue(reveal);
    _ = try running.enqueue(commit);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(usize, 1), protected.sent.items.len);
    try std.testing.expectEqual(@as(usize, 0), ordinary.sent.items.len);
    running.deinit();

    var hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(protected.sent.items[0], &hash, .{});
    const block_hash: types.Hash = @splat(0x57);
    try ordinary.receipts.put(hash, .{ .block_number = 1, .block_hash = block_hash });
    try ordinary.headers.put(1, .{ .number = 1, .hash = block_hash });
    ordinary.finalized_height = 1;
    ordinary.next_nonce = 1;
    var restarted = try service.Service.open(allocator, fixture.store(), ordinary.interface(), config, &cancel);
    defer restarted.deinit();
    const finalized = try restarted.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 1), finalized.finalized);
    try std.testing.expectEqual(@as(usize, 0), ordinary.sent.items.len);
}

test "zkSync estimation applies source cap order and failure reserves no nonce" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.latest.base_fee = 1_000_000_000;
    mock.zks_fee.max_fee_per_gas = 102_000_000_000;
    mock.zks_fee.max_priority_fee_per_gas = 100_000_000_000;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .zksync_stack = true };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(legacyPayload(id(99)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    var request = try types.parseRequest(allocator, try types.requestFromRecord(record.value()));
    defer request.deinit(allocator);
    try std.testing.expectEqual(@as(u256, 7_000_000_000), request.request.eip1559.max_fee_per_gas);
    try std.testing.expectEqual(@as(u256, 5_000_000_000), request.request.eip1559.max_priority_fee_per_gas);
    running.deinit();

    mock.zks_failure = error.RpcTimeout;
    var failed = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer failed.deinit();
    _ = try failed.enqueue(legacyPayload(id(100)));
    _ = try failed.tick(200_000, .{});
    const report = try failed.tick(300_000, .{});
    try std.testing.expect(report.deferred > 0);
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    try std.testing.expectEqual(@as(u256, 1), try fixture.store().upperNonce(allocator, signer.address));
}

test "checkpointed active recovery avoids finalized history RPC" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(legacyPayload(id(101)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var old_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &old_hash, .{});
    const block_hash: types.Hash = @splat(0x58);
    try mock.receipts.put(old_hash, .{ .block_number = 1, .block_hash = block_hash });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    _ = try running.tick(101_000, .{});
    _ = try running.enqueue(legacyPayload(id(102)));
    _ = try running.tick(102_000, .{});
    _ = try running.tick(200_000, .{});
    var active_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[1], &active_hash, .{});
    running.deinit();
    mock.receipt_calls.clearRetainingCapacity();

    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const recovered = try restarted.tick(300_000, .{});
    try std.testing.expect(recovered.recovery_complete);
    try std.testing.expect(mock.receipt_calls.get(old_hash) == null);
    try std.testing.expectEqual(@as(?u64, 1), mock.receipt_calls.get(active_hash));
    _ = try restarted.tick(300_001, .{});
    try std.testing.expectEqual(@as(?u64, 1), mock.receipt_calls.get(active_hash));
}

test "finalized observer receives winning receipt and payload gas outcome" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    const Capture = struct {
        last: ?observer.FinalizedOutcome = null,
        payload: [1]observer.PayloadOutcome = undefined,
        metric_count: usize = 0,
        fn metric(context: *anyopaque, _: observer.Metric) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.metric_count += 1;
        }
        fn finalized(context: *anyopaque, outcome: observer.FinalizedOutcome) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.last = outcome;
            @memcpy(self.payload[0..outcome.payloads.len], outcome.payloads);
            self.last.?.payloads = self.payload[0..outcome.payloads.len];
        }
    };
    var capture: Capture = .{};
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .observer = .{ .context = &capture, .metric_fn = Capture.metric, .finalized_fn = Capture.finalized }, .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(103)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &hash, .{});
    const block_hash: types.Hash = @splat(0x59);
    try mock.receipts.put(hash, .{ .block_number = 1, .block_hash = block_hash, .gas_used = 500, .effective_gas_price = 2, .executed = false });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    _ = try running.tick(101_000, .{});
    const outcome = capture.last.?;
    try std.testing.expectEqual(hash, outcome.winning_hash);
    try std.testing.expectEqual(observer.outcomeId(outcome.transaction_uuid, hash), outcome.outcome_id);
    try std.testing.expectEqual(@as(u256, 500), outcome.gas_used);
    try std.testing.expectEqual(@as(u256, 2), outcome.effective_gas_price);
    try std.testing.expectEqual(@as(u256, 21_000), outcome.total_estimated_gas);
    try std.testing.expect(!outcome.executed);
    try std.testing.expectEqual(@as(usize, 1), outcome.payloads.len);
    try std.testing.expect(outcome.payloads[0].delivered);
    try std.testing.expectEqual(id(103), outcome.payloads[0].uuid);
    try std.testing.expect(capture.metric_count > 0);
}

test "all failed multicall simulation persists terminal drops" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    const simulation = try multicall.encodeResults(allocator, &.{ .{ .success = false, .return_data = &.{} }, .{ .success = false, .return_data = &.{} } });
    defer allocator.free(simulation);
    mock.simulation_results = simulation;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35) };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(104)));
    _ = try running.enqueue(legacyPayload(id(105)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var status = (try fixture.store().transactionStatus(allocator, uuid)).?;
    defer status.deinit(allocator);
    try std.testing.expect(status.value == .dropped);
    try std.testing.expectEqual(@as(usize, 0), mock.sent.items.len);
    var payload = (try fixture.store().loadPayload(allocator, id(104))).?;
    defer payload.deinit();
    try std.testing.expectEqualStrings("FailedSimulation", (try types.field(payload.value(), "status")).object.get("Dropped").?.string);
}

test "value bearing multicall simulation includes aggregate msg value" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    const simulation = try multicall.encodeResults(allocator, &.{ .{ .success = true, .return_data = &.{} }, .{ .success = false, .return_data = &.{} } });
    defer allocator.free(simulation);
    mock.simulation_results = simulation;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .max_batch_size = 2, .batch_contract_address = @splat(0x35), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    var first = legacyPayload(id(106));
    first.payload.data_json = "[{\"type\":\"0x00\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x7\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\"},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]";
    var second = legacyPayload(id(107));
    second.payload.data_json = first.payload.data_json;
    _ = try running.enqueue(first);
    _ = try running.enqueue(second);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(?u256, 14), mock.last_call_value);
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
}

test "zkSync MEV estimation uses protected not public RPC" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var ordinary = MockChain.init(allocator);
    defer ordinary.close();
    var protected = MockChain.init(allocator);
    defer protected.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .zksync_stack = true, .mev_submission = .{ .policy = .{ .mailbox = @splat(0x35), .ica_router = @splat(0x42) }, .protected_chain = protected.interface() } };
    var running = try service.Service.open(allocator, fixture.store(), ordinary.interface(), config, &cancel);
    defer running.deinit();
    const input = try mevPayload(allocator, id(108), 2);
    defer allocator.free(input.payload.data_json);
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(u64, 0), ordinary.zks_calls);
    try std.testing.expectEqual(@as(u64, 1), protected.zks_calls);
    try std.testing.expectEqual(@as(usize, 1), protected.sent.items.len);
    try std.testing.expectEqual(@as(usize, 0), ordinary.sent.items.len);
}

fn eip2930Payload(uuid: types.Uuid) service.EnqueueInput {
    return .{ .payload = .{
        .uuid = uuid,
        .metadata = "message",
        .data_json = "[{\"type\":\"0x01\",\"from\":null,\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\",\"accessList\":[]},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]",
        .gas_limit = 21_000,
        .to = @splat(0),
    } };
}

test "EIP2930 builds signs and persists type one transaction" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(eip2930Payload(id(109)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    try std.testing.expectEqual(@as(usize, 1), mock.sent.items.len);
    try std.testing.expectEqual(@as(u8, 1), mock.sent.items[0][0]);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    const request = try types.parseRequest(allocator, try types.requestFromRecord(record.value()));
    try std.testing.expectEqual(@as(u256, 5), request.request.eip2930.gas_price);
}

test "reverted unfinalized payload is not stale dropped after reorg" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.call_success = false;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    var input = legacyPayload(id(110));
    input.payload.success_criteria_json = input.payload.data_json;
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &hash, .{});
    const block_hash: types.Hash = @splat(0x5a);
    try mock.receipts.put(hash, .{ .block_number = 2, .block_hash = block_hash });
    try mock.headers.put(2, .{ .number = 2, .hash = block_hash });
    mock.finalized_height = 1;
    _ = try running.tick(101_000, .{});
    running.deinit();

    mock.receipts.clearRetainingCapacity();
    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const recovered = try restarted.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 0), recovered.stale_dropped);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    try std.testing.expect((try fixture.store().transactionStatus(allocator, uuid)).?.value != .dropped);
}

test "reverted finalized observer outcome is not delivered" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.call_success = false;
    const Capture = struct {
        last: ?observer.FinalizedOutcome = null,
        payload: [1]observer.PayloadOutcome = undefined,
        fn finalized(context: *anyopaque, outcome: observer.FinalizedOutcome) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            self.last = outcome;
            @memcpy(self.payload[0..outcome.payloads.len], outcome.payloads);
            self.last.?.payloads = self.payload[0..outcome.payloads.len];
        }
    };
    var capture: Capture = .{};
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .observer = .{ .context = &capture, .finalized_fn = Capture.finalized }, .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    var input = legacyPayload(id(111));
    input.payload.success_criteria_json = input.payload.data_json;
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &hash, .{});
    const block_hash: types.Hash = @splat(0x5b);
    try mock.receipts.put(hash, .{ .block_number = 1, .block_hash = block_hash, .gas_used = 500, .effective_gas_price = 2, .executed = false });
    try mock.headers.put(1, .{ .number = 1, .hash = block_hash });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    _ = try running.tick(101_000, .{});
    try std.testing.expect(!capture.last.?.payloads[0].delivered);
}

test "finalized receipt survives restart and nonfinal reorg invalidates old winner" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.call_success = false;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    var input = legacyPayload(id(112));
    input.payload.success_criteria_json = input.payload.data_json;
    _ = try running.enqueue(input);
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var old_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &old_hash, .{});
    const old_block: types.Hash = @splat(0x5c);
    try mock.receipts.put(old_hash, .{ .block_number = 1, .block_hash = old_block, .gas_used = 500, .effective_gas_price = 0, .executed = false });
    try mock.headers.put(1, .{ .number = 1, .hash = old_block });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    _ = try running.tick(101_000, .{});
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    const receipt = (try fixture.store().loadFinalizedReceipt(allocator, uuid, old_hash)).?;
    try std.testing.expectEqual(uuid, receipt.transaction_uuid);
    try std.testing.expectEqual(old_hash, receipt.transaction_hash);
    try std.testing.expectEqual(@as(u64, 1), receipt.block_number);
    try std.testing.expectEqual(old_block, receipt.block_hash);
    try std.testing.expectEqual(@as(u256, 500), receipt.gas_used);
    try std.testing.expectEqual(@as(?u256, 0), receipt.effective_gas_price);
    try std.testing.expect(!receipt.executed);
    try std.testing.expectEqual(@as(?storage.FinalizedReceipt, null), try fixture.store().loadFinalizedReceipt(allocator, uuid, @splat(0x7f)));
    running.deinit();

    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const persisted = (try fixture.store().loadFinalizedReceipt(allocator, uuid, old_hash)).?;
    if (!std.meta.eql(receipt, persisted)) return error.RestartProjectionMismatch;
    mock.next_nonce = 0;
    mock.receipts.clearRetainingCapacity();
    _ = try restarted.tick(200_000, .{});
    var reorg_status = (try fixture.store().transactionStatus(allocator, uuid)).?;
    defer reorg_status.deinit(allocator);
    if (reorg_status.value == .dropped) return error.UnexpectedStaleDropAfterReorg;
    if ((try fixture.store().loadFinalizedReceipt(allocator, uuid, old_hash)) != null) return error.ExpectedReorgProjectionCleared;
    mock.next_nonce = 1;
    restarted.config.overrides.gas_price = 6;
    _ = try restarted.tick(201_001, .{});
    if (mock.sent.items.len <= 1) return error.ReplacementNotSubmitted;
    var new_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[mock.sent.items.len - 1], &new_hash, .{});
    const new_block: types.Hash = @splat(0x5d);
    try mock.receipts.put(new_hash, .{ .block_number = 2, .block_hash = new_block, .gas_used = 600, .effective_gas_price = 0, .executed = true });
    try mock.headers.put(2, .{ .number = 2, .hash = new_block });
    mock.finalized_height = 2;
    _ = try restarted.tick(202_000, .{});
    if (std.mem.eql(u8, &old_hash, &new_hash)) return error.ExpectedDistinctWinningHash;
    if ((try fixture.store().loadFinalizedReceipt(allocator, uuid, old_hash)) != null) return error.ExpectedOldWinnerClearedAfterReplacement;
    const replacement = (try fixture.store().loadFinalizedReceipt(allocator, uuid, new_hash)) orelse return error.MissingReplacementProjection;
    try std.testing.expectEqual(new_hash, replacement.transaction_hash);
    try std.testing.expectEqual(@as(u64, 2), replacement.block_number);
    try std.testing.expectEqual(new_block, replacement.block_hash);
    try std.testing.expectEqual(@as(u256, 600), replacement.gas_used);
    try std.testing.expect(replacement.executed);
}

test "missing gas fields fail finalization without fabricating projection" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.missing_gas_fields = true;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    var config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    config.overrides.gas_price = 5;
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer running.deinit();
    _ = try running.enqueue(legacyPayload(id(113)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    var hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &hash, .{});
    const block: types.Hash = @splat(0x5e);
    try mock.receipts.put(hash, .{ .block_number = 1, .block_hash = block });
    try mock.headers.put(1, .{ .number = 1, .hash = block });
    mock.finalized_height = 1;
    mock.next_nonce = 1;
    const report = try running.tick(101_000, .{});
    try std.testing.expect(report.deferred > 0);
    try std.testing.expectEqual(@as(usize, 0), report.finalized);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    try std.testing.expectEqual(@as(?storage.FinalizedReceipt, null), try fixture.store().loadFinalizedReceipt(allocator, uuid, hash));
}

test "receipt optional fee roundtrip and nonfinal delete are exact" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    const uuid = id(114);
    const hash: types.Hash = @splat(0x5f);
    const block: types.Hash = @splat(0x60);
    const receipt: storage.FinalizedReceipt = .{ .transaction_uuid = uuid, .transaction_hash = hash, .block_number = 9, .block_hash = block, .executed = false, .gas_used = 123, .effective_gas_price = null };
    try store.writeTransactionAndPayloadsWithReceipt(allocator, uuid, "{\"status\":\"Finalized\"}", &.{}, receipt);
    const loaded = (try store.loadFinalizedReceipt(allocator, uuid, hash)).?;
    try std.testing.expectEqual(receipt, loaded);
    try store.writeTransaction(allocator, uuid, "{\"status\":\"PendingInclusion\"}");
    try std.testing.expectEqual(@as(?storage.FinalizedReceipt, null), try store.loadFinalizedReceipt(allocator, uuid, hash));
}

test "owned status reason survives record destruction and allocation failures" {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    const store = fixture.store();
    const uuid = id(115);
    try writeStatus(allocator, store, uuid, "{\"Dropped\":{\"Other\":\"stale recovered transaction: payloads already delivered or terminal\"}}");
    var status = (try store.transactionStatus(allocator, uuid)).?;
    defer status.deinit(allocator);
    try std.testing.expectEqualStrings("stale recovered transaction: payloads already delivered or terminal", status.value.dropped.other);
    const Sweep = struct {
        fn run(a: std.mem.Allocator, store_: storage.Store, id_: types.Uuid) !void {
            var owned = (try store_.transactionStatus(a, id_)).?;
            defer owned.deinit(a);
            if (!std.mem.eql(u8, owned.value.dropped.other, "stale recovered transaction: payloads already delivered or terminal")) return error.InvalidDropReason;
        }
    };
    try std.testing.checkAllAllocationFailures(allocator, Sweep.run, .{ store, uuid });
}

test "receipt progress allocation is initialized before publication and OOM safe" {
    const Sweep = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const items = try service.allocateReceiptItems(allocator, 3);
            defer allocator.free(items);
            for (items) |item| {
                if (item.read or item.block != null or item.hash != null) return error.UninitializedReceiptProgress;
            }
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Sweep.run, .{});
}

// Exercise the real receipt reducer through normal signed replacements and
// same-DB restart. A malformed older receipt must never become the winner of
// a newer canonical receipt's included/finalized status.
fn canonicalWinnerAfterMalformedReceipt(finalized: bool, paged: bool) !void {
    const allocator = std.testing.allocator;
    var fixture = try DbFixture.open(allocator);
    defer fixture.close();
    var mock = MockChain.init(allocator);
    defer mock.close();
    mock.send_failure = error.RequestDeadlineExceeded;
    var signer = try MockSigner.init();
    var cancel = std.atomic.Value(bool).init(false);
    const config: service.Config = .{ .domain_name = "arbitrum", .chain_id = 1, .signer = signer.signer(), .estimated_block_time_ms = 1 };
    var running = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    _ = try running.enqueue(dynamicPayload(id(114)));
    _ = try running.tick(1_000, .{});
    _ = try running.tick(100_000, .{});
    mock.send_failure = null;
    mock.rewards = &.{2};
    _ = try running.tick(200_000, .{});
    try std.testing.expectEqual(@as(usize, 2), mock.sent.items.len);
    try std.testing.expect(!std.mem.eql(u8, mock.sent.items[0], mock.sent.items[1]));
    running.deinit();

    var old_hash: types.Hash = undefined;
    var replacement_hash: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[0], &old_hash, .{});
    std.crypto.hash.sha3.Keccak256.hash(mock.sent.items[1], &replacement_hash, .{});
    const canonical_hash: types.Hash = @splat(0x61);
    // Evm.receipt admits this nullable DTO; no canonical header was supplied
    // for the older attempt. The second attempt is independently canonical.
    try mock.receipts.put(old_hash, .{ .block_number = 1, .block_hash = null, .gas_used = 999, .effective_gas_price = 99, .executed = false });
    try mock.receipts.put(replacement_hash, .{ .block_number = 1, .block_hash = canonical_hash, .gas_used = 600, .effective_gas_price = 7, .executed = true });
    try mock.headers.put(1, .{ .number = 1, .hash = canonical_hash });
    mock.finalized_height = if (finalized) 1 else 0;
    mock.next_nonce = if (finalized) 1 else 0;
    mock.receipt_calls.clearRetainingCapacity();
    var restarted = try service.Service.open(allocator, fixture.store(), mock.interface(), config, &cancel);
    defer restarted.deinit();
    const first = try restarted.tick(300_000, .{ .max_receipts = if (paged) 1 else 2 });
    var finalized_count = first.finalized;
    if (paged) {
        try std.testing.expectEqual(@as(usize, 0), first.finalized);
        try std.testing.expectEqual(@as(u64, 1), mock.receipt_calls.get(old_hash).?);
        try std.testing.expectEqual(@as(?u64, null), mock.receipt_calls.get(replacement_hash));
        const second = try restarted.tick(301_000, .{ .max_receipts = 1 });
        finalized_count += second.finalized;
    }
    try std.testing.expectEqual(@as(usize, if (finalized) 1 else 0), finalized_count);
    try std.testing.expectEqual(@as(u64, 1), mock.receipt_calls.get(old_hash).?);
    try std.testing.expectEqual(@as(u64, 1), mock.receipt_calls.get(replacement_hash).?);
    try std.testing.expectEqual(@as(usize, 2), mock.sent.items.len);
    const uuid = (try fixture.store().transactionUuidByIndex(allocator, 1)).?;
    var record = (try fixture.store().loadTransaction(allocator, uuid)).?;
    defer record.deinit();
    try std.testing.expectEqual(if (finalized) types.Status.finalized else types.Status.included, try records.status(record.value()));
    try std.testing.expectEqual(@as(?storage.FinalizedReceipt, null), try fixture.store().loadFinalizedReceipt(allocator, uuid, old_hash));
    const actual = try fixture.store().loadFinalizedReceipt(allocator, uuid, replacement_hash);
    if (finalized) {
        const receipt = actual orelse return error.MissingCanonicalReplacementReceipt;
        try std.testing.expectEqual(replacement_hash, receipt.transaction_hash);
        try std.testing.expectEqual(canonical_hash, receipt.block_hash);
        try std.testing.expectEqual(@as(u64, 1), receipt.block_number);
        try std.testing.expectEqual(@as(u256, 600), receipt.gas_used);
        try std.testing.expectEqual(@as(?u256, 7), receipt.effective_gas_price);
        try std.testing.expect(receipt.executed);
    } else try std.testing.expectEqual(@as(?storage.FinalizedReceipt, null), actual);
}

test "malformed older receipt cannot win included replacement" {
    try canonicalWinnerAfterMalformedReceipt(false, false);
}

test "malformed older receipt cannot win finalized replacement" {
    try canonicalWinnerAfterMalformedReceipt(true, false);
}

test "paged malformed older receipt cannot win included replacement after restart" {
    try canonicalWinnerAfterMalformedReceipt(false, true);
}

test "paged malformed older receipt cannot win finalized replacement after restart" {
    try canonicalWinnerAfterMalformedReceipt(true, true);
}
