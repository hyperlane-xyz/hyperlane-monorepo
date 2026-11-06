//! SDK-free Tron Driver/Factory with the actual Root cold-origin sender gate.
const std = @import("std");
const root = @import("agents/relayer_task.zig");
const driver = @import("agents/relayer/native_driver.zig");
const destination = @import("agents/destination/root.zig");
const origins = @import("agents/origin_tasks.zig");
const ethereum = @import("agents/evm_origin.zig");
const resources = @import("agents/chain_source.zig");
const tasks = @import("agents/origin_signer_tasks.zig");
const source = @import("agents/origin_signer_source.zig");
const deny = @import("ops/runtime_denylist.zig");
const policy = @import("agents/relay_policy.zig");
const db = @import("db/root.zig");
const protocol = @import("protocol/root.zig");
const rpc = @import("net/json_rpc.zig");
const abi = @import("evm/codecs.zig");
const evm = @import("evm/provider.zig");
const tron = @import("tron/transaction.zig");
const http = @import("cloud/http.zig");
const A = std.mem.Allocator;
const a = std.testing.allocator;
const OriginLane = std.meta.Child(@FieldType(root.Lane, "origins"));
const Times = destination.operation.Times;
const History = struct {
    pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?@import("storage/objects.zig").SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
        return null;
    }
    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.UnexpectedSenderFixtureProof;
    }
};
const CountSigner = struct {
    actual: tron.Signer,
    count: usize = 0,
    fn interface(self: *@This()) tron.Signer {
        return .{ .context = self, .address = self.actual.address, .sign_fn = sign };
    }
    fn sign(ctx: *anyopaque, digest: [32]u8) !@import("protocol/signature.zig").Signature {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.count += 1;
        return self.actual.sign(digest);
    }
};
pub const Fixture = struct {
    directory: std.testing.TmpDir,
    path: []u8,
    arena: std.heap.ArenaAllocator,
    database: db.rocks.Database,
    env: std.process.EnvMap,
    origin_chain: @import("settings/types.zig").Chain,
    destination_chain: @import("settings/types.zig").Chain,
    origin: ethereum.Service,
    slots: [1]origins.Slot,
    origin_set: origins.Set,
    origin_lanes: [1]OriginLane,
    owner: root.TaskSet,
    lane: root.Lane,
    sender_owner: *tasks.Owner,
    sender_state: root.SenderState = .{},
    probe_failure: ?anyerror = null,
    probe_sender: u8 = 44,
    probe_reads: usize = 0,
    rule_bytes: []const u8 = "",
    now: Times = .{ .unix_ms = 1000000, .monotonic_ms = 0 },
    cancel: std.atomic.Value(bool) = .init(false),
    message: protocol.Message,
    readers: resources.Resources,
    provider: @import("tron/provider.zig").Provider,
    local: tron.LocalSigner,
    signer: CountSigner,
    factory: destination.Factory,
    actor: *destination.operation.Operation,
    actor_options: destination.operation.Options,
    delivered: bool = false,
    receipt: bool = false,
    estimates: usize = 0,
    broadcasts: usize = 0,
    receipt_reads: usize = 0,
    last_broadcast: ?[]u8 = null,
    history: History = .{},
    pub fn clock(self: *Fixture) !destination.Clock {
        return .{ .unix_ms = self.now.unix_ms, .deadline_ns = (try @import("agents/scraper/receipts_evm.zig").nowNs()) + 30 * std.time.ns_per_s, .cancel = &self.cancel, .halt = &self.owner.effects_halted };
    }
    fn readTime(ctx: *anyopaque) !Times {
        return @as(*Fixture, @ptrCast(@alignCast(ctx))).now;
    }
    fn gate(ctx: *anyopaque, _: A, message: protocol.Message, clock_: destination.Clock, cached_only: bool) !driver.GateResult {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        return root.NativeTests.originSenderGate(&self.lane, &self.sender_state, 0, message, clock_, cached_only);
    }
    fn step(self: *Fixture) !driver.Report {
        const machine: driver.Driver = .{ .options = .{ .maximum_gas = 5000, .observation_clock = .{ .context = self, .now_fn = readTime }, .signer_gate = .{ .context = self, .check_fn = gate } } };
        return machine.step(a, &self.factory, self.actor, &self.history, &self.origin_lanes[0].policy.?, self.message, try self.clock(), self.now);
    }
    fn attachSenders(self: *Fixture) !void {
        self.sender_owner = try tasks.Owner.open(a, &self.origin_set, &self.env, .{ .curl_library = "unused" });
        errdefer self.sender_owner.deinit();
        const network = try a.create(resources.Resources);
        network.* = .{ .allocator = a, .arena = .init(a), .chain = self.origin_chain, .options = .{ .curl_library = "unused" }, .environment = &self.env, .http = http.HttpTransport.init(a) };
        self.sender_owner.slots[0].network = network;
        network.rpc_client = try evm.RpcClient.init(a, "https://fixture/origin", .{ .exchange = .{ .context = self, .fetch_fn = senderRpc } });
        network.clients = .{ .ethereum = &network.rpc_client.? };
        self.sender_owner.slots[0].source = source.Source.initProvenance(network, source.Provenance.fromStore(&self.origin.store));
        self.owner.signers = self.sender_owner;
        try std.testing.expectEqual(@as(usize, 0), self.sender_owner.cache.stats().entries);
    }
    pub fn init() !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        self.* = undefined;
        self.arena = .init(a);
        errdefer self.arena.deinit();
        self.directory = std.testing.tmpDir(.{});
        errdefer self.directory.cleanup();
        self.path = try self.directory.dir.realpathAlloc(a, ".");
        errdefer a.free(self.path);
        self.database = try db.rocks.Database.open(a, self.path, .{});
        errdefer self.database.deinit();
        self.env = std.process.EnvMap.init(a);
        errdefer self.env.deinit();
        self.sender_state = .{};
        self.probe_failure = null;
        self.probe_sender = 44;
        self.probe_reads = 0;
        self.rule_bytes = "";
        self.now = .{ .unix_ms = 1000000, .monotonic_ms = 0 };
        self.cancel = .init(false);
        self.delivered = false;
        self.receipt = false;
        self.estimates = 0;
        self.broadcasts = 0;
        self.receipt_reads = 0;
        self.last_broadcast = null;
        self.history = .{};
        self.origin_chain = undefined;
        self.origin_chain.name = "origin";
        self.origin_chain.domain = 1;
        self.origin_chain.protocol = .ethereum;
        self.destination_chain = undefined;
        self.destination_chain.name = "tron";
        self.destination_chain.domain = 2;
        self.destination_chain.protocol = .tron;
        self.destination_chain.chain_id = "728126428";
        self.destination_chain.contracts = .{ .mailbox = .{0} ** 12 ++ .{2} ** 20, .merkle_tree_hook = .{0} ** 12 ++ .{3} ** 20, .validator_announce = .{0} ** 12 ++ .{8} ** 20, .interchain_gas_paymaster = @splat(0) };
        self.origin = .{ .allocator = a, .chain = &self.origin_chain, .store = @import("agents/store.zig").Store.init(a, &self.database, "origin"), .history = undefined, .indexer = undefined, .progress = undefined, .gas_enabled = false };
        self.origin.history = @import("agents/origin.zig").Origin.init(a, &self.origin.store, 1, @splat(9), null);
        errdefer self.origin.history.deinit();
        self.message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = .{0} ** 12 ++ .{1} ** 20, .recipient = self.destination_chain.contracts.mailbox, .body = "cold native sender" };
        _ = try self.origin.store.storeMessage(self.message, 10, .{0} ** 63 ++ .{10});
        self.slots = .{.{ .allocator = a, .chain = &self.origin_chain, .environment = &self.env, .database = undefined, .checkpoints = undefined, .options = .{ .source = .{ .curl_library = "unused" } }, .destinations = &.{2}, .implementation = .{ .ethereum = &self.origin }, .ready = .init(true) }};
        self.origin_set = .{ .allocator = a, .slots = &self.slots, .tasks = &.{}, .destinations = &.{} };
        self.owner = undefined;
        self.owner.allocator = a;
        self.owner.origins = &self.origin_set;
        self.owner.options = .{ .curl_library = "unused", .observation_clock = .{ .context = self, .now_fn = readTime } };
        self.owner.effects_halted = .init(false);
        self.owner.denylist = try deny.RuntimeDenylist.init(a, null);
        errdefer self.owner.denylist.deinit();
        self.origin_lanes = .{.{ .policy = try policy.Policy.init(a, .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }} }, null, &self.owner.denylist) }};
        errdefer self.origin_lanes[0].policy.?.deinit();
        self.lane = .{ .owner = &self.owner, .chain = &self.destination_chain, .origins = &self.origin_lanes, .control = undefined, .worker = undefined };
        try self.attachSenders();
        errdefer self.sender_owner.deinit();
        self.readers = .{ .allocator = a, .arena = .init(a), .chain = self.destination_chain, .environment = &self.env, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
        errdefer self.readers.http.deinit();
        errdefer self.readers.arena.deinit();
        const endpoint = @import("tron/rpc.zig").Endpoint;
        const endpoints = &[_]endpoint{.{ .url = "https://fixture/tron" }};
        self.provider = try @import("tron/provider.zig").Provider.init(a, .{ .context = self, .send_fn = send }, .{ .rpc_urls = endpoints, .wallet_urls = endpoints, .wallet_solidity_urls = endpoints });
        self.readers.clients = .{ .tron = &self.provider };
        self.local = .{ .secret_key = @splat(0x11) };
        self.signer = .{ .actual = try self.local.interface() };
        self.factory = .{ .allocator = a, .arena = .init(a), .resources = &self.readers, .options = .{ .allow_fixture_transport = true, .origin_bindings = &.{.{ .domain = 1, .hook = @splat(9) }} }, .backend_ready = true, .chain_checked = true, .backend = .{ .tron = .{ .chain = .{ .provider = &self.provider, .mailbox = @splat(2), .hook = @splat(3), .domain = 2 }, .announce = @splat(8), .signer = self.signer.interface(), .chain_id = self.destination_chain.chain_id } } };
        errdefer self.factory.arena.deinit();
        const authority = try self.factory.authorityFor(1, self.message.id(), 1, .process);
        self.actor_options = .{ .id = self.message.id(), .context = try self.factory.contextFor(authority), .nonce = 0, .origin = 1, .destination = 2, .policy = .{ .confirm_delay_ms = 0 } };
        self.actor = try destination.operation.Operation.open(a, &self.origin.store, self.actor_options, self.now);
        errdefer self.actor.deinit();
        _ = try self.actor.tick(self.now);
        var prepared = try self.factory.prepare(authority, self.message, "public fixture metadata", try self.clock());
        defer prepared.deinit();
        try self.actor.staged(&prepared, self.now);
        try self.actor.prepared(&prepared, true, true, self.now);
        return self;
    }
    pub fn reopen(self: *Fixture) !void {
        self.actor.deinit();
        self.sender_owner.deinit();
        self.origin.history.deinit();
        self.database.deinit();
        self.database = try db.rocks.Database.open(a, self.path, .{});
        self.origin.store = @import("agents/store.zig").Store.init(a, &self.database, "origin");
        self.origin.history = @import("agents/origin.zig").Origin.init(a, &self.origin.store, 1, @splat(9), null);
        const backend = self.factory.backend;
        const options = self.factory.options;
        self.factory.arena.deinit();
        self.factory = .{ .allocator = a, .arena = .init(a), .resources = &self.readers, .options = options, .backend = backend, .backend_ready = true, .chain_checked = true };
        self.sender_state = .{};
        try self.attachSenders();
        self.actor = try destination.operation.Operation.open(a, &self.origin.store, self.actor_options, self.now);
    }
    pub fn deinit(self: *Fixture) void {
        self.actor.deinit();
        self.sender_owner.deinit();
        self.origin_lanes[0].policy.?.deinit();
        self.owner.denylist.deinit();
        self.factory.arena.deinit();
        self.readers.http.deinit();
        self.readers.arena.deinit();
        self.local.deinit();
        self.origin.history.deinit();
        self.database.deinit();
        self.env.deinit();
        if (self.last_broadcast) |bytes| a.free(bytes);
        self.arena.deinit();
        a.free(self.path);
        self.directory.cleanup();
        a.destroy(self);
    }
    fn setRule(self: *Fixture, byte: u8) !void {
        const memory = self.arena.allocator();
        var address: [32]u8 = @splat(0);
        @memset(address[12..], byte);
        self.rule_bytes = try std.json.Stringify.valueAlloc(memory, .{ .rules = .{.{ .address = try abi.hexAlloc(memory, &address), .reason = "cold sender", .addedBy = "fixture" }} }, .{});
        self.owner.denylist.config = .{ .url = "https://fixture/rules", .cache_path = try std.fs.path.join(memory, &.{ self.path, "rules.json" }), .poll_interval_ms = 1000 };
        self.owner.denylist.transport = .{ .context = self, .fetch = struct {
            fn fetch(ctx: *anyopaque, allocator: A, _: []const u8, _: usize) !deny.Fetched {
                const f: *Fixture = @ptrCast(@alignCast(ctx));
                return .{ .allocator = allocator, .bytes = try allocator.dupe(u8, f.rule_bytes), .status = 200 };
            }
        }.fetch };
        _ = try self.owner.denylist.refresh(.{ .context = self, .now_unix = struct {
            fn read(_: *anyopaque) i64 {
                return 1000;
            }
        }.read });
    }
    fn senderRpc(ctx: *anyopaque, allocator: A, bytes: []const u8, _: evm.Options) !evm.WireResponse {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, bytes, .{});
        defer parsed.deinit();
        const method = parsed.value.object.get("method").?.string;
        const encoded = if (std.mem.eql(u8, method, "eth_getTransactionByHash")) result: {
            self.probe_reads += 1;
            if (self.probe_failure) |err| return err;
            break :result try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = .{ .hash = parsed.value.object.get("params").?.array.items[0].string, .blockNumber = "0xa", .blockHash = "0x" ++ "11" ** 32, .from = try abi.hexAlloc(self.arena.allocator(), &([_]u8{self.probe_sender} ** 20)) } }, .{});
        } else if (std.mem.eql(u8, method, "eth_getTransactionReceipt")) try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = @as(?u8, null) }, .{}) else return error.UnexpectedOriginSenderMethod;
        return .{ .bytes = encoded, .len = encoded.len };
    }
    fn block(allocator: A) ![]u8 {
        var id: [32]u8 = @splat(0);
        id[7] = 5;
        const text = try abi.hexAlloc(allocator, &id);
        defer allocator.free(text);
        return std.json.Stringify.valueAlloc(allocator, .{ .blockID = text[2..], .block_header = .{ .raw_data = .{ .number = 5, .timestamp = 1000000 } } }, .{});
    }
    fn send(ctx: *anyopaque, allocator: A, request: http.Request) !http.Response {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, request.body.?, .{});
        defer parsed.deinit();
        const value = parsed.value;
        const bytes = if (value.object.get("method")) |method| result: {
            const id = value.object.get("id").?;
            if (std.mem.eql(u8, method.string, "eth_getCode")) break :result try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = "0x60" }, .{});
            if (std.mem.eql(u8, method.string, "eth_gasPrice")) break :result try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = "0x64" }, .{});
            if (std.mem.eql(u8, method.string, "eth_getTransactionReceipt")) {
                self.receipt_reads += 1;
                if (!self.receipt) break :result try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = @as(?u8, null) }, .{});
                break :result try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = .{ .transactionHash = value.object.get("params").?.array.items[0].string, .blockNumber = "0x5", .blockHash = "0x" ++ "0000000000000005" ++ "00" ** 24, .status = "0x1", .gasUsed = "0xa", .effectiveGasPrice = "0xa" } }, .{});
            }
            return error.UnexpectedTronRpc;
        } else if (std.mem.endsWith(u8, request.url, "/estimateenergy")) result: {
            self.estimates += 1;
            break :result try allocator.dupe(u8, "{\"result\":{\"result\":true},\"energy_required\":1000}");
        } else if (std.mem.endsWith(u8, request.url, "/getnowblock") or std.mem.endsWith(u8, request.url, "/getblockbynum")) try block(allocator) else if (std.mem.endsWith(u8, request.url, "/broadcasthex")) result: {
            self.broadcasts += 1;
            const text = value.object.get("transaction").?.string;
            const raw = try allocator.alloc(u8, text.len / 2);
            errdefer allocator.free(raw);
            _ = try std.fmt.hexToBytes(raw, text);
            if (self.last_broadcast) |old| allocator.free(old);
            self.last_broadcast = raw;
            break :result try allocator.dupe(u8, "{\"result\":true}");
        } else if (std.mem.endsWith(u8, request.url, "/triggerconstantcontract")) result: {
            const data = value.object.get("data").?.string;
            var selector: [4]u8 = undefined;
            _ = try std.fmt.hexToBytes(&selector, data[0..8]);
            const number: u256 = if (std.mem.eql(u8, &selector, &abi.selector("delivered(bytes32)"))) @intFromBool(self.delivered) else if (std.mem.eql(u8, &selector, &abi.selector("recipientIsm(address)")) or std.mem.eql(u8, &selector, &abi.selector("defaultIsm()"))) 7 else if (std.mem.eql(u8, &selector, &abi.selector("moduleType()"))) 6 else return error.UnexpectedTronContractCall;
            var word: [32]u8 = @splat(0);
            std.mem.writeInt(u256, &word, number, .big);
            const text = try abi.hexAlloc(allocator, &word);
            defer allocator.free(text);
            break :result try std.json.Stringify.valueAlloc(allocator, .{ .result = .{ .result = true }, .constant_result = .{text[2..]} }, .{});
        } else return error.UnexpectedTronWalletCall;
        return .{ .allocator = allocator, .status = 200, .bytes = bytes };
    }
};

test "Native cold sender recovered Tron Ready performs initial lookup and Source backoff before any executable key" {
    const f = try Fixture.init();
    defer f.deinit();
    try f.reopen();
    try std.testing.expectEqual(.ready, f.actor.value.stage);
    try f.setRule(44);
    f.probe_failure = error.ConnectionRefused;
    const delayed = try f.step();
    try std.testing.expectEqual(driver.State.retried, delayed.state);
    try std.testing.expectEqual(@as(usize, 1), f.probe_reads);
    try std.testing.expectEqual(@as(usize, 0), f.signer.count);
    try std.testing.expectEqual(@as(usize, 0), f.broadcasts);
    f.now = .{ .unix_ms = 1029999, .monotonic_ms = 29999 };
    try std.testing.expectEqual(driver.State.idle, (try f.step()).state);
    try std.testing.expectEqual(@as(usize, 1), f.probe_reads);
    f.probe_failure = null;
    f.now = .{ .unix_ms = 1030000, .monotonic_ms = 30000 };
    try std.testing.expectEqual(driver.State.denied, (try f.step()).state);
    try std.testing.expectEqual(@as(usize, 2), f.probe_reads);
    try std.testing.expectEqual(@as(usize, 0), f.signer.count);
    try f.setRule(46);
    try std.testing.expectEqual(driver.State.prepared, (try f.step()).state);
    try std.testing.expectEqual(driver.State.signed, (try f.step()).state);
    try std.testing.expectEqual(@as(usize, 1), f.signer.count);
    try std.testing.expectEqual(@as(usize, 2), f.probe_reads);
    try std.testing.expect(f.actor.signed != null);
}

test "Native cold sender recovered Tron Signed blocks exact-byte broadcast until sender policy permits and drains receipt while denied" {
    const f = try Fixture.init();
    defer f.deinit();
    try std.testing.expectEqual(driver.State.signed, (try f.step()).state);
    const raw = try a.dupe(u8, f.actor.signed.?.bytes);
    defer a.free(raw);
    const identity = f.actor.signed.?.identity;
    try f.reopen();
    try std.testing.expectEqualStrings(raw, f.actor.signed.?.bytes);
    try std.testing.expect(destination.types.Identity.eql(identity, f.actor.signed.?.identity));
    try f.setRule(44);
    try std.testing.expectEqual(driver.State.denied, (try f.step()).state);
    try std.testing.expectEqual(@as(usize, 1), f.probe_reads);
    try std.testing.expectEqual(@as(usize, 1), f.signer.count);
    try std.testing.expectEqual(@as(usize, 0), f.broadcasts);
    try f.setRule(46);
    try std.testing.expectEqual(driver.State.broadcast, (try f.step()).state);
    try std.testing.expectEqualStrings(raw, f.last_broadcast.?);
    try std.testing.expectEqual(@as(usize, 1), f.signer.count);
    try std.testing.expectEqual(@as(usize, 1), f.probe_reads);
    try f.setRule(44);
    f.receipt = true;
    const before = f.receipt_reads;
    try std.testing.expectEqual(driver.State.reconciled, (try f.step()).state);
    try std.testing.expect(f.receipt_reads > before);
    try std.testing.expect(f.actor.value.confirmation_started);
    try std.testing.expectEqual(@as(u256, 100), (try f.origin.store.expenditure(f.message.id())).tokens_used);
    f.delivered = true;
    try std.testing.expectEqual(driver.State.delivered, (try f.step()).state);
    try std.testing.expect(try f.origin.store.processed(0));
    try std.testing.expectEqual(@as(usize, 1), f.broadcasts);
    try std.testing.expectEqual(@as(usize, 1), f.signer.count);
    try std.testing.expectEqual(@as(usize, 1), f.probe_reads);
    try std.testing.expectEqual(@as(u256, 100), (try f.origin.store.expenditure(f.message.id())).tokens_used);
}
