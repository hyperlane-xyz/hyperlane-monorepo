const std = @import("std");
const driver = @import("evm_driver.zig");
const prepare = @import("evm_prepare.zig");
const accounting = @import("evm_accounting.zig");
const protocol = @import("../../protocol/root.zig");
const signature = @import("../../protocol/signature.zig");
const evm = @import("../../evm/root.zig");
const settings = @import("../../settings/types.zig");
const db = @import("../../db/root.zig");
const lander = @import("../../lander/root.zig");
const native = @import("../store.zig");
const links = @import("../payload_links.zig");
const operation = @import("../operation.zig");
const relay_policy = @import("../relay_policy.zig");
const agents_origin = @import("../origin.zig");
const matching = @import("../../ops/matching.zig");

const A = std.mem.Allocator;
const allow_gas: relay_policy.Config = .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }} };
const zero_word = "\"0x" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000000" ++ "\"";
const one_word = "\"0x" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000001" ++ "\"";
const ism_word = "\"0x" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000033" ++ "\"";
const null_ism_word = "\"0x" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000006" ++ "\"";

const Step = struct {
    method: []const u8,
    selector: ?[4]u8 = null,
    result: ?[]const u8 = null,
    failure: ?anyerror = null,
    advance_ms: u64 = 0,
};

const ObservationClock = struct {
    times: operation.Times,
    fn now(context: *anyopaque) !operation.Times {
        const self: *ObservationClock = @ptrCast(@alignCast(context));
        return self.times;
    }
    fn interface(self: *ObservationClock) operation.ObservationClock {
        return .{ .context = self, .now_fn = ObservationClock.now };
    }
};

const MockRpc = struct {
    allocator: A,
    steps: []Step,
    index: usize = 0,
    requests: std.ArrayList([]u8) = .empty,
    cancel: ?*std.atomic.Value(bool) = null,
    cancel_on: ?[]const u8 = null,
    observation_clock: ?*ObservationClock = null,

    fn init(allocator: A, steps: []const Step) !MockRpc {
        const copied = try allocator.dupe(Step, steps);
        errdefer allocator.free(copied);
        for (copied) |*step| {
            if (step.result) |result| step.result = try allocator.dupe(u8, result);
        }
        return .{ .allocator = allocator, .steps = copied };
    }

    fn deinit(self: *MockRpc) void {
        for (self.steps) |step| {
            if (step.result) |result| self.allocator.free(result);
        }
        self.allocator.free(self.steps);
        for (self.requests.items) |request| self.allocator.free(request);
        self.requests.deinit(self.allocator);
    }

    fn exchange(self: *MockRpc) evm.provider.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }

    fn fetch(context: *anyopaque, allocator: A, body: []const u8, _: evm.provider.Options) anyerror!evm.provider.WireResponse {
        const self: *MockRpc = @ptrCast(@alignCast(context));
        if (self.index >= self.steps.len) return error.UnexpectedRpcCall;
        const step = self.steps[self.index];
        self.index += 1;
        if (self.observation_clock) |clock| {
            clock.times.unix_ms += step.advance_ms;
            clock.times.monotonic_ms += step.advance_ms;
        }
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer parsed.deinit();
        const method = parsed.value.object.get("method") orelse return error.InvalidRpcRequest;
        const id = parsed.value.object.get("id") orelse return error.InvalidRpcRequest;
        if (method != .string or id != .integer or !std.mem.eql(u8, method.string, step.method)) {
            std.debug.print("fixture RPC step {d}: expected {s}, got {s}\n", .{ self.index, step.method, if (method == .string) method.string else "<invalid>" });
            return error.UnexpectedRpcMethod;
        }
        if (step.selector) |expected| {
            const params = (parsed.value.object.get("params") orelse return error.InvalidRpcRequest).array.items;
            if (params.len == 0 or params[0] != .object) return error.InvalidRpcRequest;
            const data = (params[0].object.get("data") orelse return error.InvalidRpcRequest).string;
            var actual: [4]u8 = undefined;
            if (data.len < 10) return error.InvalidRpcRequest;
            _ = try evm.codecs.decodeHex(&actual, data[0..10]);
            try std.testing.expectEqualSlices(u8, &expected, &actual);
        }
        try self.requests.append(self.allocator, try self.allocator.dupe(u8, body));
        if (step.failure) |failure| return failure;
        const bytes = try std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id.integer, step.result orelse return error.MissingRpcResult });
        if (self.cancel_on) |wanted| if (std.mem.eql(u8, wanted, method.string)) self.cancel.?.store(true, .release);
        return .{ .bytes = bytes, .len = bytes.len };
    }

    fn expectDone(self: *const MockRpc) !void {
        try std.testing.expectEqual(self.steps.len, self.index);
    }
};

const MockChain = struct {
    finalized_height: u64 = 0,
    expected_hash: ?lander.types.Hash = null,
    receipt_value: ?lander.chain.Receipt = null,
    header_value: ?lander.chain.Header = null,

    fn interface(self: *MockChain) lander.chain.Chain {
        return .{
            .context = self,
            .latest_block_fn = latestBlock,
            .fee_history_fn = feeHistory,
            .estimate_gas_fn = estimateGas,
            .account_nonce_finalized_fn = accountNonce,
            .finalized_height_fn = finalizedHeight,
            .receipt_fn = receipt,
            .block_header_fn = blockHeader,
            .send_raw_fn = sendRaw,
            .call_fn = call,
            .get_code_fn = getCode,
        };
    }
    fn unexpected() anyerror {
        return error.UnexpectedLanderCall;
    }
    fn latestBlock(_: *anyopaque) !lander.chain.LatestBlock {
        return unexpected();
    }
    fn feeHistory(_: *anyopaque, _: A, _: u64) !lander.chain.FeeHistory {
        return unexpected();
    }
    fn estimateGas(_: *anyopaque, _: lander.types.Request, _: lander.types.Address) !u256 {
        return unexpected();
    }
    fn accountNonce(_: *anyopaque, _: lander.types.Address) !u256 {
        return unexpected();
    }
    fn finalizedHeight(context: *anyopaque) !u64 {
        const self: *MockChain = @ptrCast(@alignCast(context));
        return self.finalized_height;
    }
    fn receipt(context: *anyopaque, hash: lander.types.Hash) !?lander.chain.Receipt {
        const self: *MockChain = @ptrCast(@alignCast(context));
        if (self.expected_hash) |expected| if (!std.mem.eql(u8, &expected, &hash)) return null;
        return self.receipt_value;
    }
    fn blockHeader(context: *anyopaque, number: u64) !lander.chain.Header {
        const self: *MockChain = @ptrCast(@alignCast(context));
        const header = self.header_value orelse return error.MissingBlock;
        if (header.number != number) return error.WrongBlock;
        return header;
    }
    fn sendRaw(_: *anyopaque, _: []const u8) !lander.types.Hash {
        return unexpected();
    }
    fn call(_: *anyopaque, _: A, _: lander.chain.Call, _: u64) ![]u8 {
        return unexpected();
    }
    fn getCode(_: *anyopaque, _: A, _: lander.types.Address) ![]u8 {
        return unexpected();
    }
};

const MockSigner = struct {
    address: lander.types.Address,
    calls: usize = 0,

    fn init() !MockSigner {
        return .{ .address = try signature.secretKeyAddress(@splat(0x11)) };
    }
    fn interface(self: *MockSigner) lander.Signer {
        return .{ .context = self, .address = self.address, .sign_fn = sign };
    }
    fn sign(context: *anyopaque, digest: lander.types.Hash) !lander.types.Signature {
        const self: *MockSigner = @ptrCast(@alignCast(context));
        self.calls += 1;
        return signature.signDigest(@splat(0x11), digest, null);
    }
};

const MissingOriginHash = struct {
    fn fetch(_: *anyopaque, _: A, _: *native.Store, _: protocol.Message, _: bool) anyerror!prepare.SignerLookup {
        return .hash_not_stored;
    }
};

const CrossOriginResolver = struct {
    current: *native.Store,
    other: *native.Store,
    current_id: [32]u8,
    other_id: [32]u8,

    fn interface(self: *CrossOriginResolver) accounting.BatchResolver {
        return .{ .context = self, .estimate_fn = estimate };
    }

    fn estimate(context: *anyopaque, allocator: A, message_id: [32]u8, payload_uuid: [16]u8) anyerror!?u256 {
        const self: *CrossOriginResolver = @ptrCast(@alignCast(context));
        if (std.mem.eql(u8, &message_id, &self.current_id)) return loadEstimate(allocator, self.current, message_id, @splat(8), payload_uuid);
        if (std.mem.eql(u8, &message_id, &self.other_id)) return loadEstimate(allocator, self.other, message_id, @splat(9), payload_uuid);
        return null;
    }

    fn loadEstimate(allocator: A, store: *native.Store, message_id: [32]u8, context_hash: [32]u8, payload_uuid: [16]u8) !?u256 {
        var member = (try links.load(allocator, store, message_id, context_hash)) orelse return null;
        defer member.deinit();
        if (!std.mem.eql(u8, &member.record().payload.uuid, &payload_uuid)) return error.NativeBatchLinkMismatch;
        return member.record().estimated_gas;
    }
};

const StaticReceiptReader = struct {
    transaction_uuid: [16]u8,
    transaction_hash: [32]u8,
    proof: accounting.ProjectedReceipt,
    calls: usize = 0,

    fn interface(self: *StaticReceiptReader) accounting.CostReceiptReader {
        return .{ .context = self, .read_fn = read };
    }

    fn read(context: *anyopaque, transaction_uuid: [16]u8, transaction_hash: [32]u8) anyerror!?accounting.ProjectedReceipt {
        const self: *StaticReceiptReader = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (!std.mem.eql(u8, &transaction_uuid, &self.transaction_uuid) or !std.mem.eql(u8, &transaction_hash, &self.transaction_hash)) return error.CostTransactionIdentityMismatch;
        return self.proof;
    }
};

const Fixture = struct {
    allocator: A,
    temporary: std.testing.TmpDir,
    path: []u8,
    message: protocol.Message,

    fn init(allocator: A) !Fixture {
        var temporary = std.testing.tmpDir(.{});
        errdefer temporary.cleanup();
        const parent = try temporary.dir.realpathAlloc(allocator, ".");
        defer allocator.free(parent);
        const path = try std.fs.path.join(allocator, &.{ parent, "evm-driver" });
        errdefer allocator.free(path);
        var sender: [32]u8 = @splat(0);
        sender[31] = 1;
        var recipient: [32]u8 = @splat(0);
        recipient[0] = 0xff;
        @memset(recipient[12..], 0x22);
        return .{
            .allocator = allocator,
            .temporary = temporary,
            .path = path,
            .message = .{ .version = 3, .nonce = 7, .origin = 1000, .sender = sender, .destination = 2000, .recipient = recipient, .body = &.{ 0x11, 0x22, 0x33 } },
        };
    }

    fn deinit(self: *Fixture) void {
        self.allocator.free(self.path);
        self.temporary.cleanup();
    }
};

const Runtime = struct {
    allocator: A,
    fixture: *Fixture,
    rpc: MockRpc,
    database: db.rocks.Database,
    store: native.Store,
    policy: relay_policy.Policy,
    origin: agents_origin.Origin,
    client: evm.RpcClient,
    chain: MockChain = .{},
    signer: MockSigner,
    cancel: std.atomic.Value(bool),
    destination: lander.Service,
    actor: operation.Operation,
    value: driver.Driver,
    reorg: settings.Reorg,

    fn init(allocator: A, fixture: *Fixture, steps: []const Step, policy_config: relay_policy.Config, reorg: settings.Reorg) !*Runtime {
        return initAt(allocator, fixture, steps, policy_config, reorg, .{ .confirm_delay_ms = 0 }, now());
    }

    fn initAt(allocator: A, fixture: *Fixture, steps: []const Step, policy_config: relay_policy.Config, reorg: settings.Reorg, confirmation_policy: @import("../../runtime/relayer.zig").Policy, times: operation.Times) !*Runtime {
        const self = try allocator.create(Runtime);
        errdefer allocator.destroy(self);
        self.allocator = allocator;
        self.chain = .{};
        self.fixture = fixture;
        self.rpc = try MockRpc.init(allocator, steps);
        errdefer self.rpc.deinit();
        self.database = try db.rocks.Database.open(allocator, fixture.path, .{ .sync = true });
        errdefer self.database.deinit();
        self.store = native.Store.init(allocator, &self.database, "origin");
        self.policy = try relay_policy.Policy.init(allocator, policy_config, null, null);
        errdefer self.policy.deinit();
        self.origin = agents_origin.Origin.init(allocator, &self.store, 1000, @splat(1), null);
        errdefer self.origin.deinit();
        self.client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{ .exchange = self.rpc.exchange() });
        errdefer self.client.deinit();
        self.signer = try MockSigner.init();
        self.cancel = std.atomic.Value(bool).init(false);
        self.rpc.cancel = &self.cancel;
        self.destination = try lander.Service.open(allocator, lander.Store.init(&self.database, "destination"), self.chain.interface(), .{
            .domain_name = "destination",
            .chain_id = 31337,
            .signer = self.signer.interface(),
        }, &self.cancel);
        errdefer self.destination.deinit();
        var existing = try self.store.messageByNonce(fixture.message.nonce);
        defer if (existing) |*message| message.deinit();
        if (existing == null) _ = try self.store.storeMessage(fixture.message, 1, null);
        self.actor = try operation.Operation.open(allocator, &self.store, .{
            .id = fixture.message.id(),
            .context = @splat(8),
            .nonce = fixture.message.nonce,
            .destination = fixture.message.destination,
            .policy = confirmation_policy,
        }, times);
        errdefer self.actor.deinit();
        self.value = driver.Driver.init(allocator);
        self.reorg = reorg;
        return self;
    }

    fn deinit(self: *Runtime) void {
        self.value.deinit();
        self.actor.deinit();
        self.destination.deinit();
        self.client.deinit();
        self.policy.deinit();
        self.origin.deinit();
        self.database.deinit();
        self.rpc.deinit();
        self.allocator.destroy(self);
    }

    fn config(self: *Runtime) driver.Config {
        var mailbox: [32]u8 = @splat(0);
        mailbox[19] = 0x42;
        return .{ .source = .{
            .domain = 2000,
            .chain_id = 31337,
            .mailbox = mailbox,
            .relayer = self.signer.address,
            .reorg = self.reorg,
        } };
    }

    fn step(self: *Runtime) !driver.Report {
        return self.stepAt(now());
    }

    fn prepareStep(self: *Runtime) !driver.Report {
        return self.prepareStepAt(now());
    }

    fn prepareStepAt(self: *Runtime, times: operation.Times) !driver.Report {
        const report = try self.stepAt(times);
        try std.testing.expectEqual(driver.State.prepared, report.state);
        try std.testing.expect(report.payload != null);
        return report;
    }

    fn stepAt(self: *Runtime, times: operation.Times) !driver.Report {
        return self.value.step(self.allocator, &self.destination, &self.actor, &self.origin, &self.policy, self.fixture.message, &self.client, self.config(), times, .{ .cancel = &self.cancel });
    }

    fn relation(self: *Runtime, uuid: lander.types.Uuid) !void {
        return self.setRelations(&.{uuid});
    }

    fn setRelations(self: *Runtime, uuids: []const lander.types.Uuid) !void {
        const encoded = try db.codec.encodeUuids(self.allocator, uuids);
        defer self.allocator.free(encoded);
        try self.store.typed.put(self.allocator, db.keys.Table.payload_uuids_by_message_id.prefix(), &self.fixture.message.id(), encoded);
    }

    fn foreignPayload(self: *Runtime, uuid: lander.types.Uuid) !void {
        _ = try self.destination.enqueue(.{ .payload = .{
            .uuid = uuid,
            .metadata = "foreign-rust-payload",
            .data_json = "[{\"type\":\"0x00\",\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null,\"chainId\":\"0x1\"},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]",
            .gas_limit = 21_000,
            .to = self.config().source.mailbox,
        } });
        try self.relation(uuid);
    }

    fn setPayloadStatus(self: *Runtime, uuid: lander.types.Uuid, status: enum { dropped, simulation_failed, included, finalized }) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        var record = (try self.destination.store.loadPayload(self.allocator, uuid)).?;
        defer record.deinit();
        switch (status) {
            .dropped => try lander.records.setPayloadReverted(&record.parsed.value, arena.allocator()),
            .simulation_failed => try lander.records.setPayloadSimulationFailed(&record.parsed.value, arena.allocator()),
            .included => try lander.records.setPayloadStatus(&record.parsed.value, arena.allocator(), .included),
            .finalized => try lander.records.setPayloadStatus(&record.parsed.value, arena.allocator(), .finalized),
        }
        const json = try std.json.Stringify.valueAlloc(self.allocator, record.value(), .{});
        defer self.allocator.free(json);
        var delivery = try self.destination.store.delivery(self.allocator, uuid);
        defer if (delivery) |*value| value.deinit(self.allocator);
        _ = try self.destination.store.writePayload(self.allocator, uuid, json, null, if (delivery) |value| value.value else .none);
    }

    fn nativeLink(self: *Runtime, message: protocol.Message, generation: u64, estimated_gas: u256) !lander.types.Uuid {
        try self.store.upsertMessage(message, 1, null);
        return sealNativeLink(self.allocator, &self.store, &self.destination, self.config().source.mailbox, message, @splat(8), generation, estimated_gas);
    }

    fn nativeReceiptLink(self: *Runtime, message: protocol.Message, generation: u64, estimated_gas: u256) !lander.types.Uuid {
        try self.store.admitReceiptMessage(message, @splat(9));
        return sealNativeLink(self.allocator, &self.store, &self.destination, self.config().source.mailbox, message, @splat(8), generation, estimated_gas);
    }

    fn associate(self: *Runtime, payload_uuids: []const lander.types.Uuid, transaction_uuid: lander.types.Uuid, transaction_hash: lander.types.Hash, status: enum { included, finalized, reverted_included, reverted_finalized }) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const temporary = arena.allocator();
        var first = (try self.destination.store.loadPayload(temporary, payload_uuids[0])).?;
        defer first.deinit();
        var transaction: lander.records.OwnedJson = .init(temporary);
        defer transaction.deinit();
        try lander.records.createTransaction(&transaction, first.value(), transaction_uuid, self.signer.address, 31337, "2026-01-02T03:04:05.006Z");
        const details = try temporary.alloc(std.json.Value, payload_uuids.len);
        const updates = try self.allocator.alloc(lander.store.PayloadUpdate, payload_uuids.len);
        defer self.allocator.free(updates);
        for (payload_uuids, 0..) |uuid, index| {
            var payload = (try self.destination.store.loadPayload(temporary, uuid)).?;
            defer payload.deinit();
            switch (status) {
                .reverted_included, .reverted_finalized => {
                    try lander.records.setPayloadReverted(&payload.parsed.value, temporary);
                    try lander.records.setStatus(&transaction.root, temporary, if (status == .reverted_finalized) .finalized else .included);
                },
                .included => {
                    try lander.records.setPayloadStatus(&payload.parsed.value, temporary, .included);
                    try lander.records.setStatus(&transaction.root, temporary, .included);
                },
                .finalized => {
                    try lander.records.setPayloadStatus(&payload.parsed.value, temporary, .finalized);
                    try lander.records.setStatus(&transaction.root, temporary, .finalized);
                },
            }
            details[index] = try lander.types.field(payload.value(), "details");
            updates[index] = .{ .uuid = uuid, .canonical_json = try std.json.Stringify.valueAlloc(self.allocator, payload.value(), .{}) };
        }
        defer for (updates) |update| self.allocator.free(update.canonical_json);
        transaction.root.object.getPtr("payload_details").?.* = .{ .array = .{ .items = details, .capacity = details.len, .allocator = temporary } };
        _ = try lander.records.appendHash(&transaction.root, temporary, transaction_hash);
        const json = try std.json.Stringify.valueAlloc(self.allocator, transaction.root, .{});
        defer self.allocator.free(json);
        _ = try self.destination.store.writeBuiltTransaction(self.allocator, transaction_uuid, json, updates);
    }

    fn setReceipt(self: *Runtime, hash: lander.types.Hash, block_hash: lander.types.Hash, block_number: u64, gas_used: u256, gas_price: ?u256, executed: bool) void {
        self.chain.expected_hash = hash;
        self.chain.receipt_value = .{
            .block_number = block_number,
            .block_hash = block_hash,
            .gas_used = gas_used,
            .effective_gas_price = gas_price,
            .executed = executed,
        };
        self.chain.header_value = .{ .number = block_number, .hash = block_hash };
        self.chain.finalized_height = block_number;
    }
};

fn sealNativeLink(allocator: A, store: *native.Store, destination: *lander.Service, mailbox: [32]u8, message: protocol.Message, context: [32]u8, generation: u64, estimated_gas: u256) !lander.types.Uuid {
    const uuid = links.uuid(context, message.id(), generation);
    const record: links.Record = .{
        .context = context,
        .message_id = message.id(),
        .generation = generation,
        .estimated_gas = estimated_gas,
        .payload = .{
            .uuid = uuid,
            .metadata = "native-test-payload",
            .data_json = "[{\"type\":\"0x00\",\"to\":\"0x3535353535353535353535353535353535353535\",\"gas\":\"0x5208\",\"gasPrice\":\"0x5\",\"value\":\"0x0\",\"data\":\"0x\",\"nonce\":null},{\"name\":\"process\",\"inputs\":[],\"outputs\":[],\"constant\":null,\"stateMutability\":\"nonpayable\"}]",
            .gas_limit = 1,
            .to = mailbox,
        },
        .delivery = .{ .mailbox_message = message.id() },
    };
    try links.seal(allocator, store, record);
    _ = try destination.enqueue(.{ .payload = record.payload, .delivery = record.delivery });
    return uuid;
}

fn now() operation.Times {
    return .{ .unix_ms = 1_000, .monotonic_ms = 0 };
}

fn readySteps() [9]Step {
    return .{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .selector = evm.codecs.selector("recipientIsm(address)"), .result = ism_word },
        // Strict root classification reads the mailbox default before querying
        // moduleType, even without an observer or configured contract cache.
        .{ .method = "eth_call", .selector = evm.codecs.selector("defaultIsm()"), .result = ism_word },
        .{ .method = "eth_call", .selector = evm.codecs.selector("moduleType()"), .result = null_ism_word },
        .{ .method = "eth_estimateGas", .result = "\"0x64\"" },
        .{ .method = "eth_gasPrice", .result = "\"0x2\"" },
    };
}

fn expectNoEffects(runtime: *Runtime) !void {
    try std.testing.expectEqual(@as(usize, 0), runtime.signer.calls);
    try std.testing.expectEqual(@as(u32, 0), try runtime.destination.store.highestTransactionIndex(runtime.allocator));
    try std.testing.expectEqual(@as(u256, 0), try runtime.destination.store.upperNonce(runtime.allocator, runtime.signer.address));
}

fn expectNoSigning(runtime: *Runtime) !void {
    try std.testing.expectEqual(@as(usize, 0), runtime.signer.calls);
    try std.testing.expectEqual(@as(u256, 0), try runtime.destination.store.upperNonce(runtime.allocator, runtime.signer.address));
}

fn relationLen(runtime: *Runtime) !usize {
    const inherited = try links.inheritedUuids(runtime.allocator, &runtime.store, runtime.fixture.message.id());
    defer runtime.allocator.free(inherited);
    return inherited.len;
}

test "durable pre-enqueue cancellation replays exact sealed input after real DB restart" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const expected = links.uuid(@splat(8), fixture.message.id(), 1);
    {
        const steps = readySteps();
        var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
        defer runtime.deinit();
        runtime.rpc.cancel_on = "eth_gasPrice";
        try std.testing.expectError(error.Cancelled, runtime.step());
        var before_restart = (try links.load(a, &runtime.store, fixture.message.id(), @splat(8))).?;
        defer before_restart.deinit();
        const inherited = try links.inheritedUuids(a, &runtime.store, fixture.message.id());
        defer a.free(inherited);
        try std.testing.expectEqualSlices(u8, &expected, &inherited[0]);
        try std.testing.expectEqual(@as(u32, 0), try runtime.destination.store.highestPayloadIndex(a));
        try expectNoEffects(runtime);
        try runtime.rpc.expectDone();
    }
    var recovered = try Runtime.init(a, &fixture, &.{}, allow_gas, .{ .blocks = 1 });
    defer recovered.deinit();
    var sealed = (try links.load(a, &recovered.store, fixture.message.id(), @splat(8))).?;
    defer sealed.deinit();
    try std.testing.expectEqual(@as(u64, 1), sealed.record().generation);
    const report = try recovered.step();
    try std.testing.expectEqual(driver.State.existing_payload, report.state);
    try std.testing.expectEqual(expected, report.payload.?);
    try std.testing.expectEqual(@as(u32, 1), try recovered.destination.store.highestPayloadIndex(a));
    var payload = (try recovered.destination.store.loadPayload(a, expected)).?;
    defer payload.deinit();
    var replay_input: lander.records.OwnedJson = .init(a);
    defer replay_input.deinit();
    try lander.records.createPayload(&replay_input, sealed.record().payload);
    try std.testing.expect(try lander.records.samePayloadIdentity(a, payload.value(), replay_input.root));
    try std.testing.expectEqualStrings("ReadyToSubmit", (try lander.types.field(payload.value(), "status")).string);
    try std.testing.expectEqual(@as(u64, 1), recovered.actor.value.generation);
    try expectNoEffects(recovered);
}

test "foreign Rust relation and missing status never authorize a fresh generation or nonce" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    var runtime = try Runtime.init(a, &fixture, &.{}, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    const foreign: lander.types.Uuid = @splat(7);
    try runtime.relation(foreign);
    const missing = try runtime.step();
    try std.testing.expectEqual(driver.State.existing_payload, missing.state);
    try std.testing.expectEqual(error.PayloadStatusUnknown, missing.failure.?);
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try std.testing.expectEqual(@as(u32, 0), try runtime.destination.store.highestPayloadIndex(a));

    try runtime.foreignPayload(foreign);
    const recovered = try runtime.step();
    try std.testing.expectEqual(driver.State.existing_payload, recovered.state);
    try std.testing.expectEqual(foreign, recovered.payload.?);
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try std.testing.expect((try links.load(a, &runtime.store, fixture.message.id(), @splat(8))) == null);
    const inherited = try links.inheritedUuids(a, &runtime.store, fixture.message.id());
    defer a.free(inherited);
    try std.testing.expectEqualSlices(u8, &foreign, &inherited[0]);
    try expectNoEffects(runtime);
}

test "malformed retry status is not positive failure and cannot clear linkage" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    var runtime = try Runtime.init(a, &fixture, &.{}, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    const foreign: lander.types.Uuid = @splat(7);
    try runtime.foreignPayload(foreign);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var record = (try runtime.destination.store.loadPayload(a, foreign)).?;
    defer record.deinit();
    var malformed = std.json.ObjectMap.init(arena.allocator());
    try malformed.put("Retry", .{ .integer = 1 });
    try record.parsed.value.object.put("status", .{ .object = malformed });
    const json = try std.json.Stringify.valueAlloc(a, record.value(), .{});
    defer a.free(json);
    _ = try runtime.destination.store.writePayload(a, foreign, json, null, .none);
    try std.testing.expectError(error.InvalidLanderRecord, runtime.step());
    try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try expectNoEffects(runtime);
}

test "runtime denial never cancels an already delegated payload" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const denied_policy: relay_policy.Config = .{
        .whitelist = &.{.{ .origin_domain = .{ .values = &.{999} } }},
        .gas_payment_enforcement = allow_gas.gas_payment_enforcement,
    };
    var runtime = try Runtime.init(a, &fixture, &.{}, denied_policy, .{ .blocks = 1 });
    defer runtime.deinit();
    const foreign: lander.types.Uuid = @splat(7);
    try runtime.foreignPayload(foreign);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.existing_payload, report.state);
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
    var payload = (try runtime.destination.store.loadPayload(a, foreign)).?;
    defer payload.deinit();
    try std.testing.expectEqualStrings("ReadyToSubmit", (try lander.types.field(payload.value(), "status")).string);
    try expectNoEffects(runtime);
}

test "positive drop clears only expected UUID before deterministic new generation" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = readySteps();
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    const foreign: lander.types.Uuid = @splat(7);
    try runtime.foreignPayload(foreign);
    try runtime.setPayloadStatus(foreign, .dropped);
    const dropped = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, dropped.state);
    try std.testing.expectEqual(db.json.ReprepareReason.RevertedOrReorged, dropped.reason.?);
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    try std.testing.expectEqual(@as(u32, 1), try runtime.destination.store.highestPayloadIndex(a));

    const prepared = try runtime.prepareStep();
    try std.testing.expectEqual(driver.State.prepared, prepared.state);
    try std.testing.expectEqual(@as(u64, 1), runtime.actor.value.generation);
    try std.testing.expectEqual(links.uuid(@splat(8), fixture.message.id(), 1), prepared.payload.?);
    try std.testing.expect(!std.mem.eql(u8, &foreign, &prepared.payload.?));
    try std.testing.expectEqual(@as(u32, 2), try runtime.destination.store.highestPayloadIndex(a));
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "mixed payload dispositions retain all relations until every payload positively fails" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    var runtime = try Runtime.init(a, &fixture, &.{}, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    const first: lander.types.Uuid = @splat(7);
    const second: lander.types.Uuid = @splat(9);
    try runtime.foreignPayload(first);
    try runtime.foreignPayload(second);
    try runtime.setRelations(&.{ first, second });
    try runtime.setPayloadStatus(first, .dropped);
    const active = try runtime.step();
    try std.testing.expectEqual(driver.State.existing_payload, active.state);
    try std.testing.expectEqual(@as(usize, 2), relationLen(runtime));
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try runtime.setPayloadStatus(second, .dropped);
    const dropped = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, dropped.state);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    try std.testing.expectEqual(@as(u64, 0), runtime.actor.value.generation);
    try expectNoEffects(runtime);
}

test "crash after terminal relation clear durably retries before a new generation" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const first = readySteps();
    const second = readySteps();
    const steps = first ++ second;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try std.testing.expectEqual(driver.State.prepared, prepared.state);
    const inherited = try links.inheritedUuids(a, &runtime.store, fixture.message.id());
    defer a.free(inherited);
    try links.clearTerminal(a, &runtime.store, fixture.message.id(), inherited);

    const recovered = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, recovered.state);
    try std.testing.expectEqual(@as(u64, 1), runtime.actor.value.generation);
    try std.testing.expectEqual(@as(u32, 1), runtime.actor.value.retries);
    try std.testing.expectEqual(@as(u32, 1), try runtime.destination.store.highestPayloadIndex(a));
    const next = try runtime.stepAt(.{ .unix_ms = 6_000, .monotonic_ms = 5_000 });
    try std.testing.expectEqual(driver.State.prepared, next.state);
    try std.testing.expectEqual(@as(u64, 2), runtime.actor.value.generation);
    try std.testing.expectEqual(links.uuid(@splat(8), fixture.message.id(), 2), next.payload.?);
    try std.testing.expectEqual(@as(u32, 2), try runtime.destination.store.highestPayloadIndex(a));
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "native successful receipt charges actual gas and sealed estimate not paid allowance" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    const steps = prepared_steps ++ final_steps;
    const minimum: relay_policy.Config = .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .{ .minimum = 1 } }} };
    var runtime = try Runtime.init(a, &fixture, &steps, minimum, .{ .tag = "finalized" });
    defer runtime.deinit();
    _ = try runtime.store.storePayment(.{ .message_id = fixture.message.id(), .destination = 2000, .gas_amount = 150, .payment = 1 }, .{ .transaction_id = @splat(3), .log_index = 0 });
    const prepared = try runtime.prepareStep();
    try std.testing.expectEqual(driver.State.prepared, prepared.state);
    var link = (try links.load(a, &runtime.store, fixture.message.id(), @splat(8))).?;
    defer link.deinit();
    try std.testing.expectEqual(@as(?u256, 100), link.record().estimated_gas);
    try std.testing.expectEqual(@as(u256, 150), link.record().payload.gas_limit);
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 6_000, 7, true);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.delivered, report.state);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 6_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 42_000), spent.tokens_used);
    var marker = (try accounting.loadMarker(a, &runtime.store, prepared.payload.?)).?;
    defer marker.deinit();
    try std.testing.expectEqual(@as(u64, 1), marker.value().generation);
    _ = try runtime.step();
    const duplicate = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(spent, duplicate);
    try runtime.rpc.expectDone();
}

test "native failed finalized receipt is accounted before relation retry" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
    };
    const steps = prepared_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 7_000, 3, false);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, report.state);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 7_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 21_000), spent.tokens_used);
    var marker = (try accounting.loadMarker(a, &runtime.store, prepared.payload.?)).?;
    defer marker.deinit();
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native pruned receipt blocks terminal completion without zero accounting" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    const steps = prepared_steps ++ final_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    // The raw heap allocation must initialize the MockChain before the first
    // missing-receipt read, not merely rely on allocator poison or zero pages.
    try std.testing.expectEqual(@as(u64, 0), runtime.chain.finalized_height);
    try std.testing.expect(runtime.chain.expected_hash == null);
    try std.testing.expect(runtime.chain.receipt_value == null);
    try std.testing.expect(runtime.chain.header_value == null);
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .finalized);
    try std.testing.expectError(error.CostReceiptUnavailable, runtime.step());
    runtime.setReceipt(@splat(4), @splat(5), 10, 6_000, 7, true);
    runtime.chain.header_value.?.hash = @splat(9);
    try std.testing.expectError(error.NonCanonicalCostReceipt, runtime.step());
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 0), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 0), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native included payload is not charged before finality" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = readySteps();
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .included);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.existing_payload, report.state);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 0), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 0), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native batch uses surviving payload estimate sum for source ratio" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    const steps = prepared_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    var sibling = fixture.message;
    sibling.nonce = 8;
    sibling.body = "native batch sibling";
    const sibling_payload = try runtime.nativeLink(sibling, 1, 200);
    try runtime.associate(&.{ prepared.payload.?, sibling_payload }, @splat(3), @splat(4), .finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 9_000, 5, true);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.delivered, report.state);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 3_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 15_000), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "cross-origin destination batch resolves every simulation estimate" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    const steps = prepared_steps ++ final_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    var other_store = native.Store.init(a, &runtime.database, "other_origin");
    var sibling = fixture.message;
    sibling.origin = 1001;
    sibling.body = "cross-origin batch sibling";
    _ = try other_store.storeMessage(sibling, 1, null);
    const sibling_payload = try sealNativeLink(a, &other_store, &runtime.destination, runtime.config().source.mailbox, sibling, @splat(9), 1, 200);
    try runtime.associate(&.{ prepared.payload.?, sibling_payload }, @splat(3), @splat(4), .finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 9_000, 5, true);
    var resolver: CrossOriginResolver = .{
        .current = &runtime.store,
        .other = &other_store,
        .current_id = fixture.message.id(),
        .other_id = sibling.id(),
    };
    resolver.other_id = @splat(0);
    try std.testing.expectError(error.MissingNativeBatchLink, runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), .{
        .batch_resolver = resolver.interface(),
        .cancel = &runtime.cancel,
    }));
    const uncharged = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 0), uncharged.gas_used);
    try std.testing.expectEqual(@as(u256, 0), uncharged.tokens_used);
    resolver.other_id = sibling.id();
    const report = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), .{
        .batch_resolver = resolver.interface(),
        .cancel = &runtime.cancel,
    });
    try std.testing.expectEqual(driver.State.delivered, report.state);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 3_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 15_000), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "public receipt message keeps canonical nonce lifecycle until later index arrival" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    var receipt = fixture.message;
    receipt.body = "public receipt B";
    const payload = try runtime.nativeReceiptLink(receipt, 1, 100);
    try runtime.associate(&.{payload}, @splat(3), @splat(4), .finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 6_000, 7, true);
    var actor = try operation.Operation.open(a, &runtime.store, .{
        .id = receipt.id(),
        .context = @splat(8),
        .nonce = receipt.nonce,
        .destination = receipt.destination,
        .policy = .{ .confirm_delay_ms = 0 },
    }, now());
    defer actor.deinit();
    _ = try actor.apply(.{ .tick = .{ .now_ms = now().monotonic_ms } }, now(), null);
    var value = driver.Driver.init(a);
    defer value.deinit();
    const report = try value.step(a, &runtime.destination, &actor, &runtime.origin, &runtime.policy, receipt, &runtime.client, runtime.config(), now(), .{ .cancel = &runtime.cancel });
    try std.testing.expectEqual(driver.State.delivered, report.state);
    const spent = try runtime.store.expenditure(receipt.id());
    try std.testing.expectEqual(@as(u256, 6_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 42_000), spent.tokens_used);
    try std.testing.expect(!try runtime.store.processed(receipt.nonce));
    var canonical = (try runtime.store.messageByNonce(receipt.nonce)).?;
    defer canonical.deinit();
    try std.testing.expectEqualSlices(u8, &fixture.message.id(), &canonical.value.id());
    try std.testing.expectEqualStrings(fixture.message.body, canonical.value.body);
    try std.testing.expectEqual(@as(?u64, 1), try runtime.store.messageBlock(receipt.nonce));
    var pending = (try runtime.store.pendingAtOrAfter(receipt.destination, 0)).?;
    defer pending.deinit();
    try std.testing.expectEqualSlices(u8, &fixture.message.id(), &pending.value.id());
    var admitted = (try runtime.store.messageById(receipt.id())).?;
    defer admitted.deinit();
    try std.testing.expectEqualStrings(receipt.body, admitted.value.body);
    try runtime.store.upsertMessage(receipt, 20, @splat(9));
    try std.testing.expect(try runtime.store.markProcessedIfCanonical(receipt));
    try std.testing.expect(try runtime.store.processed(receipt.nonce));
    try runtime.rpc.expectDone();
}

test "projected finalized receipt supports authoritative zero fee without RPC receipt" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    const steps = prepared_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .finalized);
    runtime.chain.header_value = .{ .number = 10, .hash = @splat(5) };
    runtime.chain.finalized_height = 10;
    var reader: StaticReceiptReader = .{
        .transaction_uuid = @splat(3),
        .transaction_hash = @splat(4),
        .proof = .{ .block_number = 10, .block_hash = @splat(5), .gas_used = 5_000, .effective_gas_price = 0, .executed = true },
    };
    const report = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), .{
        .cost_receipt_reader = reader.interface(),
        .cancel = &runtime.cancel,
    });
    try std.testing.expectEqual(driver.State.delivered, report.state);
    try std.testing.expectEqual(@as(usize, 1), reader.calls);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 5_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 0), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native missing receipt price accepts matching authoritative zero gasPrice" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const transaction_json = "{\"hash\":\"0x" ++ "11111111111111111111111111111111" ++ "11111111111111111111111111111111" ++ "\",\"blockHash\":\"0x" ++ "22222222222222222222222222222222" ++ "22222222222222222222222222222222" ++ "\",\"blockNumber\":\"0xa\",\"gasPrice\":\"0x0\"}";
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_getTransactionByHash", .result = transaction_json },
    };
    const steps = prepared_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(0x11), .finalized);
    runtime.setReceipt(@splat(0x11), @splat(0x22), 10, 4_000, null, true);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.delivered, report.state);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 4_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 0), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native missing receipt price uses matching positive transaction gasPrice" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const prepared_steps = readySteps();
    const transaction_json = "{\"hash\":\"0x" ++ "11111111111111111111111111111111" ++ "11111111111111111111111111111111" ++ "\",\"blockHash\":\"0x" ++ "22222222222222222222222222222222" ++ "22222222222222222222222222222222" ++ "\",\"blockNumber\":\"0xa\",\"gasPrice\":\"0x7\"}";
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_getTransactionByHash", .result = transaction_json },
    };
    const steps = prepared_steps ++ final_steps;
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(0x11), .finalized);
    runtime.setReceipt(@splat(0x11), @splat(0x22), 10, 4_000, null, true);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.delivered, report.state);
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 4_000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 28_000), spent.tokens_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "finalized associated and external deliveries complete but unfinalized inclusion waits" {
    const a = std.testing.allocator;
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
        };
        var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
        defer runtime.deinit();
        const foreign: lander.types.Uuid = @splat(7);
        try runtime.foreignPayload(foreign);
        try runtime.setPayloadStatus(foreign, .finalized);
        const report = try runtime.step();
        try std.testing.expectEqual(driver.State.delivered, report.state);
        try std.testing.expect(try runtime.store.processed(fixture.message.nonce));
        try expectNoEffects(runtime);
        try runtime.rpc.expectDone();
    }
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
            .{ .method = "eth_call", .result = one_word },
        };
        var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
        defer runtime.deinit();
        const report = try runtime.step();
        try std.testing.expectEqual(driver.State.delivered, report.state);
        try std.testing.expect(try runtime.store.processed(fixture.message.nonce));
        try std.testing.expectEqual(@as(u32, 0), try runtime.destination.store.highestPayloadIndex(a));
        try runtime.rpc.expectDone();
    }
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        var runtime = try Runtime.init(a, &fixture, &.{}, allow_gas, .{ .blocks = 1 });
        defer runtime.deinit();
        const foreign: lander.types.Uuid = @splat(7);
        try runtime.foreignPayload(foreign);
        try runtime.setPayloadStatus(foreign, .included);
        const report = try runtime.step();
        try std.testing.expectEqual(driver.State.existing_payload, report.state);
        try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
        try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
        try expectNoEffects(runtime);
    }
}

test "positive finalized non-delivery reconciles retry without receipt inference" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
    };
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const foreign: lander.types.Uuid = @splat(7);
    try runtime.foreignPayload(foreign);
    try runtime.setPayloadStatus(foreign, .finalized);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, report.state);
    try std.testing.expectEqual(db.json.ReprepareReason.RevertedOrReorged, report.reason.?);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "deny retains canonical work and policy allow prepares without synthetic transaction" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const initial = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
    };
    const allowed = readySteps();
    const steps = initial ++ allowed;
    const denied_policy: relay_policy.Config = .{
        .whitelist = &.{.{ .origin_domain = .{ .values = &.{999} } }},
        .gas_payment_enforcement = allow_gas.gas_payment_enforcement,
    };
    var runtime = try Runtime.init(a, &fixture, &steps, denied_policy, .{ .blocks = 1 });
    defer runtime.deinit();
    const denied = try runtime.step();
    try std.testing.expectEqual(driver.State.denied, denied.state);
    try std.testing.expectEqual(relay_policy.Denial.not_whitelisted, denied.denial.?);
    try std.testing.expect(!try runtime.store.terminal(fixture.message.id()));
    var pending = (try runtime.store.pendingAtOrAfter(2000, 0)).?;
    defer pending.deinit();

    const next = try a.create(matching.Matcher);
    errdefer a.destroy(next);
    next.* = try matching.Matcher.init(a, &.{.{}}, null);
    errdefer next.deinit();
    try runtime.policy.whitelist.update(next);
    const prepared = try runtime.prepareStep();
    try std.testing.expectEqual(driver.State.prepared, prepared.state);
    try std.testing.expect(runtime.actor.value.transaction == null);
    try std.testing.expect(runtime.actor.transaction_bytes == null);
    try std.testing.expectEqual(db.json.Status.ReadyToSubmit, (try runtime.store.status(fixture.message.id())).?);
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "source normal retry increments once while configured finality wait only delays" {
    const a = std.testing.allocator;
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .failure = error.RpcError },
        };
        var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
        defer runtime.deinit();
        const report = try runtime.step();
        try std.testing.expectEqual(driver.State.retried, report.state);
        try std.testing.expectEqual(db.json.ReprepareReason.ErrorCheckingDeliveryStatus, report.reason.?);
        try std.testing.expectEqual(@as(u32, 1), runtime.actor.value.retries);
        try std.testing.expectEqual(db.json.Status{ .Retry = .ErrorCheckingDeliveryStatus }, (try runtime.store.status(fixture.message.id())).?);
        try runtime.rpc.expectDone();
    }
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
            .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
            .{ .method = "eth_call", .result = zero_word },
        };
        var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
        defer runtime.deinit();
        const report = try runtime.step();
        try std.testing.expectEqual(driver.State.existing_payload, report.state);
        try std.testing.expectEqual(@as(u32, 0), runtime.actor.value.retries);
        try std.testing.expectEqual(@as(u64, 500), runtime.actor.value.next_attempt_ms);
        try std.testing.expect(std.mem.indexOf(u8, runtime.rpc.requests.items[3], "\"0xf\"") != null);
        try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
        try runtime.rpc.expectDone();
    }
    {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = zero_word },
            .{ .method = "eth_getCode", .result = "\"0x01\"" },
        };
        var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
        defer runtime.deinit();
        var ignored: u8 = 0;
        const report = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), .{
            .origin_sender = .{ .context = &ignored, .fetch_fn = MissingOriginHash.fetch },
            .cancel = &runtime.cancel,
        });
        try std.testing.expectEqual(driver.State.retried, report.state);
        try std.testing.expectEqual(db.json.ReprepareReason.ErrorFetchingOriginTxSender, report.reason.?);
        try std.testing.expectEqual(@as(u32, 0), runtime.actor.value.retries);
        try std.testing.expectEqual(@as(u64, 30_000), runtime.actor.value.next_attempt_ms);
        try std.testing.expect(runtime.value.retry_state.origin_hash_waited);
        try runtime.rpc.expectDone();
    }
}

test "non-contract terminal marker and canonical pending cleanup commit together" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x\"" },
    };
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.not_contract, report.state);
    try std.testing.expect(try runtime.store.terminal(fixture.message.id()));
    try std.testing.expect((try runtime.store.pendingAtOrAfter(2000, 0)) == null);
    var canonical = (try runtime.store.messageById(fixture.message.id())).?;
    defer canonical.deinit();
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "hard source failure propagates without sealing payload or flattening retry" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .failure = error.ValidatorReorg },
    };
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .blocks = 1 });
    defer runtime.deinit();
    try std.testing.expectError(error.ValidatorReorg, runtime.step());
    try std.testing.expectEqual(@as(u32, 0), runtime.actor.value.retries);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "driver starts without retained source metadata" {
    var value = driver.Driver.init(std.testing.allocator);
    defer value.deinit();
    try std.testing.expect(value.cached_metadata == null);
    try std.testing.expectEqual(@as(u32, 0), value.retry_state.ica_reveal_attempts);
}

test "native reverted finalized payload accounts canonical actual cost before retry" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = readySteps();
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .reverted_finalized);
    // A finalized transaction without a receipt cannot release this generation.
    try std.testing.expectError(error.CostReceiptUnavailable, runtime.step());
    try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
    try std.testing.expectEqual(@as(u256, 0), (try runtime.store.expenditure(fixture.message.id())).gas_used);
    runtime.setReceipt(@splat(4), @splat(5), 10, 7000, 3, false);
    runtime.chain.header_value.?.hash = @splat(9);
    try std.testing.expectError(error.NonCanonicalCostReceipt, runtime.step());
    try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
    try std.testing.expectEqual(@as(u256, 0), (try runtime.store.expenditure(fixture.message.id())).gas_used);
    runtime.chain.header_value.?.hash = @splat(5);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, report.state);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    const spent = try runtime.store.expenditure(fixture.message.id());
    try std.testing.expectEqual(@as(u256, 7000), spent.gas_used);
    try std.testing.expectEqual(@as(u256, 21000), spent.tokens_used);
    var marker = (try accounting.loadMarker(a, &runtime.store, prepared.payload.?)).?;
    defer marker.deinit();
    try std.testing.expectEqual(@as(u256, 7000), marker.value().gas_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native reverted included payload retains association before transaction finality" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = readySteps();
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .reverted_included);
    runtime.setReceipt(@splat(4), @splat(5), 10, 7000, 3, false);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.existing_payload, report.state);
    try std.testing.expectEqual(@as(usize, 1), relationLen(runtime));
    try std.testing.expectEqual(@as(u256, 0), (try runtime.store.expenditure(fixture.message.id())).gas_used);
    try std.testing.expect((try accounting.loadMarker(a, &runtime.store, prepared.payload.?)) == null);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "native pre-submission dropped payload retries without invented gas cost" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = readySteps();
    var runtime = try Runtime.init(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" });
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.setPayloadStatus(prepared.payload.?, .simulation_failed);
    const report = try runtime.step();
    try std.testing.expectEqual(driver.State.retried, report.state);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    try std.testing.expectEqual(@as(u256, 0), (try runtime.store.expenditure(fixture.message.id())).gas_used);
    try std.testing.expect((try accounting.loadMarker(a, &runtime.store, prepared.payload.?)) == null);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "source600s EVM inclusion confirmation survives DB restart and finalized proof cannot complete early" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const preparation = readySteps();
    const initial: operation.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
    var runtime = try Runtime.initAt(a, &fixture, &preparation, allow_gas, .{ .tag = "finalized" }, .{}, initial);
    const prepared = try runtime.prepareStepAt(initial);
    try std.testing.expectEqual(db.json.Status.ReadyToSubmit, runtime.actor.current_status);
    try std.testing.expect(!runtime.actor.value.confirmation_started);
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .included);
    _ = try runtime.stepAt(.{ .unix_ms = 1100, .monotonic_ms = 100 });
    try std.testing.expectEqual(@as(u64, 600100), runtime.actor.value.next_attempt_ms);
    try std.testing.expectEqual(db.json.Status{ .Confirm = .SubmittedBySelf }, runtime.actor.current_status);
    _ = try runtime.stepAt(.{ .unix_ms = 2100, .monotonic_ms = 1100 });
    try std.testing.expectEqual(@as(u64, 600100), runtime.actor.value.next_attempt_ms);
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    try runtime.rpc.expectDone();
    runtime.deinit();
    const final_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    runtime = try Runtime.initAt(a, &fixture, &final_steps, allow_gas, .{ .tag = "finalized" }, .{}, .{ .unix_ms = 301100, .monotonic_ms = 5 });
    defer runtime.deinit();
    try std.testing.expectEqual(@as(u64, 300005), runtime.actor.value.next_attempt_ms);
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 7000, 3, true);
    const early = try runtime.stepAt(.{ .unix_ms = 601099, .monotonic_ms = 300004 });
    try std.testing.expectEqual(driver.State.existing_payload, early.state);
    try std.testing.expectEqual(@as(usize, 0), runtime.rpc.index);
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    try std.testing.expectEqual(@as(u64, 300005), runtime.actor.value.next_attempt_ms);
    const eligible = try runtime.stepAt(.{ .unix_ms = 601100, .monotonic_ms = 300005 });
    try std.testing.expectEqual(driver.State.delivered, eligible.state);
    try std.testing.expect(try runtime.store.processed(fixture.message.nonce));
    try std.testing.expectEqual(@as(u256, 7000), (try runtime.store.expenditure(fixture.message.id())).gas_used);
    try expectNoSigning(runtime);
    try runtime.rpc.expectDone();
}

test "source600s external delivery starts wait before finality and requires a fresh finalized recheck" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const initial_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .result = zero_word },
    };
    const recheck_pending = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .result = zero_word },
    };
    var recheck_final = recheck_pending;
    recheck_final[4].result = one_word;
    const steps = initial_steps ++ recheck_pending ++ recheck_final;
    var runtime = try Runtime.initAt(a, &fixture, &steps, allow_gas, .{ .blocks = 1 }, .{}, now());
    defer runtime.deinit();
    try std.testing.expectEqual(driver.State.existing_payload, (try runtime.step()).state);
    try std.testing.expect(runtime.actor.value.confirmation_started);
    try std.testing.expectEqual(@as(u64, 600000), runtime.actor.value.next_attempt_ms);
    try std.testing.expectEqual(db.json.Status{ .Confirm = .AlreadySubmitted }, runtime.actor.current_status);
    try std.testing.expectEqual(driver.State.idle, (try runtime.stepAt(.{ .unix_ms = 600999, .monotonic_ms = 599999 })).state);
    try std.testing.expectEqual(@as(usize, 4), runtime.rpc.index);
    try std.testing.expectEqual(driver.State.existing_payload, (try runtime.stepAt(.{ .unix_ms = 601000, .monotonic_ms = 600000 })).state);
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    try std.testing.expectEqual(@as(u64, 600500), runtime.actor.value.next_attempt_ms);
    try std.testing.expectEqual(driver.State.delivered, (try runtime.stepAt(.{ .unix_ms = 601500, .monotonic_ms = 600500 })).state);
    try std.testing.expect(try runtime.store.processed(fixture.message.nonce));
    try std.testing.expect(runtime.actor.value.transaction == null);
    try std.testing.expect(runtime.actor.transaction_bytes == null);
    try std.testing.expectEqual(@as(u32, 0), runtime.actor.value.retries);
    try expectNoEffects(runtime);
    try runtime.rpc.expectDone();
}

test "source600s external reorg retries and a new inclusion receives its own full confirmation window" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const external_steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
    };
    const steps = external_steps ++ readySteps();
    var runtime = try Runtime.initAt(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" }, .{}, now());
    defer runtime.deinit();
    try std.testing.expectEqual(driver.State.existing_payload, (try runtime.step()).state);
    try std.testing.expectEqual(driver.State.retried, (try runtime.stepAt(.{ .unix_ms = 601000, .monotonic_ms = 600000 })).state);
    try std.testing.expect(!runtime.actor.value.confirmation_started);
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    const next = try runtime.stepAt(.{ .unix_ms = 606000, .monotonic_ms = 605000 });
    try std.testing.expectEqual(driver.State.prepared, next.state);
    try runtime.associate(&.{next.payload.?}, @splat(3), @splat(4), .included);
    _ = try runtime.stepAt(.{ .unix_ms = 606100, .monotonic_ms = 605100 });
    try std.testing.expect(runtime.actor.value.confirmation_started);
    try std.testing.expectEqual(@as(u64, 1205100), runtime.actor.value.next_attempt_ms);
    try std.testing.expectEqual(@as(u32, 1), runtime.actor.value.retries);
    try runtime.rpc.expectDone();
}

test "source600s finalized failure charges and retries without waiting for an earlier success window" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = readySteps();
    var runtime = try Runtime.initAt(a, &fixture, &steps, allow_gas, .{ .tag = "finalized" }, .{}, now());
    defer runtime.deinit();
    const prepared = try runtime.prepareStep();
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .included);
    _ = try runtime.stepAt(.{ .unix_ms = 1100, .monotonic_ms = 100 });
    try std.testing.expectEqual(@as(u64, 600100), runtime.actor.value.next_attempt_ms);
    try runtime.associate(&.{prepared.payload.?}, @splat(3), @splat(4), .reverted_finalized);
    runtime.setReceipt(@splat(4), @splat(5), 10, 7000, 3, false);
    const report = try runtime.stepAt(.{ .unix_ms = 1200, .monotonic_ms = 200 });
    try std.testing.expectEqual(driver.State.retried, report.state);
    try std.testing.expect(!runtime.actor.value.confirmation_started);
    try std.testing.expectEqual(@as(u64, 5200), runtime.actor.value.next_attempt_ms);
    try std.testing.expectEqual(@as(u256, 7000), (try runtime.store.expenditure(fixture.message.id())).gas_used);
    try std.testing.expectEqual(@as(usize, 0), relationLen(runtime));
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    try runtime.rpc.expectDone();
}

test "source600s observation clock starts at actual latest delivery and refreshes eligibility after IO" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a);
    defer fixture.deinit();
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word, .advance_ms = 10000 },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"", .advance_ms = 5000 },
        .{ .method = "eth_call", .result = zero_word, .advance_ms = 5000 },
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = one_word },
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .result = one_word },
    };
    var runtime = try Runtime.initAt(a, &fixture, &steps, allow_gas, .{ .blocks = 1 }, .{}, now());
    defer runtime.deinit();
    var clock: ObservationClock = .{ .times = now() };
    runtime.rpc.observation_clock = &clock;
    const callbacks: driver.Callbacks = .{ .observation_clock = clock.interface() };
    const initial = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), callbacks);
    try std.testing.expectEqual(driver.State.existing_payload, initial.state);
    try std.testing.expectEqual(@as(u64, 20000), clock.times.monotonic_ms);
    try std.testing.expectEqual(@as(u64, 610000), runtime.actor.value.next_attempt_ms);
    try std.testing.expectEqual(@as(u64, 611000), runtime.actor.deadline.?.unix_ms);
    clock.times = .{ .unix_ms = 610999, .monotonic_ms = 609999 };
    const early = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), callbacks);
    try std.testing.expectEqual(driver.State.idle, early.state);
    try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
    clock.times = .{ .unix_ms = 611000, .monotonic_ms = 610000 };
    const due = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), callbacks);
    try std.testing.expectEqual(driver.State.delivered, due.state);
    try std.testing.expect(try runtime.store.processed(fixture.message.nonce));
    try std.testing.expect(runtime.actor.transaction_bytes == null);
    try runtime.rpc.expectDone();
}

test "source600s latest delivery retains observed deadline through transient finality failure without normal retry" {
    const a = std.testing.allocator;
    for ([_]bool{ false, true }) |failed_call| {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        var initial_steps = std.array_list.Managed(Step).init(a);
        defer initial_steps.deinit();
        try initial_steps.append(.{ .method = "eth_chainId", .result = "\"0x7a69\"" });
        try initial_steps.append(.{ .method = "eth_call", .result = one_word, .advance_ms = 10000 });
        if (failed_call) {
            try initial_steps.append(.{ .method = "eth_blockNumber", .result = "\"0x10\"", .advance_ms = 5000 });
            try initial_steps.append(.{ .method = "eth_call", .failure = error.RpcHttpStatus, .advance_ms = 5000 });
        } else try initial_steps.append(.{ .method = "eth_blockNumber", .failure = error.RpcError, .advance_ms = 5000 });
        try initial_steps.appendSlice(&.{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
            .{ .method = "eth_call", .result = one_word },
        });
        var runtime = try Runtime.initAt(a, &fixture, initial_steps.items, allow_gas, .{ .blocks = 1 }, .{}, now());
        defer runtime.deinit();
        var clock: ObservationClock = .{ .times = now() };
        runtime.rpc.observation_clock = &clock;
        const callbacks: driver.Callbacks = .{ .observation_clock = clock.interface() };
        const pending = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), callbacks);
        try std.testing.expectEqual(driver.State.existing_payload, pending.state);
        try std.testing.expectEqual(error.SourcePreparationFailed, pending.failure.?);
        try std.testing.expect(runtime.actor.value.confirmation_started);
        try std.testing.expectEqual(@as(u64, 610000), runtime.actor.value.next_attempt_ms);
        try std.testing.expectEqual(@as(u64, 611000), runtime.actor.deadline.?.unix_ms);
        try std.testing.expectEqual(@as(u32, 0), runtime.actor.value.retries);
        try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
        clock.times = .{ .unix_ms = 611000, .monotonic_ms = 610000 };
        const confirmed = try runtime.value.step(a, &runtime.destination, &runtime.actor, &runtime.origin, &runtime.policy, fixture.message, &runtime.client, runtime.config(), now(), callbacks);
        try std.testing.expectEqual(driver.State.delivered, confirmed.state);
        try std.testing.expect(try runtime.store.processed(fixture.message.nonce));
        try runtime.rpc.expectDone();
    }
}

test "post latest-delivery finality control refusal deadline and corruption errors propagate" {
    const a = std.testing.allocator;
    for ([_]anyerror{ error.OutOfMemory, error.PendingReadIo, error.RequestCancelled, error.Cancelled, error.RequestDeadlineExceeded, error.SourceReadDeadline, error.MessageMetadataRefused, error.ReorgFlagPresent, error.InvalidRpcEnvelope, error.DuplicateField }) |failure| {
        var fixture = try Fixture.init(a);
        defer fixture.deinit();
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
            .{ .method = "eth_blockNumber", .failure = failure },
        };
        var runtime = try Runtime.initAt(a, &fixture, &steps, allow_gas, .{ .blocks = 1 }, .{}, now());
        defer runtime.deinit();
        try std.testing.expectError(failure, runtime.step());
        try std.testing.expectEqual(@as(u32, 0), runtime.actor.value.retries);
        try std.testing.expect(!try runtime.store.processed(fixture.message.nonce));
        try runtime.rpc.expectDone();
    }
}
