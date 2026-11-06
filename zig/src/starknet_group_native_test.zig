//! Actual Root/Factory/SDK/Rocks group pipeline; all keys and RPCs are fixtures.
const std = @import("std");
const root = @import("agents/relayer_task.zig");
const control = @import("agents/relayer/control.zig");
const settings = @import("settings/root.zig");
const origins = @import("agents/origin_tasks.zig");
const ethereum = @import("agents/evm_origin.zig");
const history = @import("agents/origin.zig");
const native = @import("agents/store.zig");
const db = @import("db/root.zig");
const protocol = @import("protocol/root.zig");
const denylist = @import("ops/runtime_denylist.zig");
const destination = @import("agents/destination/root.zig");
const groups = @import("agents/relayer/native_group.zig");
const op = destination.operation;
const crypto = @import("starknet/crypto.zig");
const tx = @import("starknet/transaction.zig");
const provider = @import("starknet/provider.zig");
const Felt = @import("starknet/codec.zig").Felt;
const rpc = @import("net/json_rpc.zig");
const http = @import("cloud/http.zig");
const helpers = @import("agents/destination/starknet_batch_testing.zig");
const A = std.mem.Allocator;
const OriginLane = std.meta.Child(@FieldType(root.Lane, "origins"));
const now: op.Times = .{ .unix_ms = 1000, .monotonic_ms = 0 };
pub const Fixture = struct {
    allocator: A,
    directory: std.testing.TmpDir,
    path: []u8,
    configured: settings.Settings,
    chains: [3]settings.Chain,
    environment: std.process.EnvMap,
    database: *origins.DatabaseOwner,
    sources: [2]ethereum.Service,
    slots: [2]origins.Slot,
    origin_set: origins.Set,
    lane_origins: [2]OriginLane,
    owner: root.TaskSet,
    lane: root.Lane,
    readers: @import("agents/chain_source.zig").Resources,
    factory: destination.Factory,
    bindings: [2]@import("agents/destination/factory.zig").OriginBinding,
    native_crypto: crypto.Crypto,
    local: tx.LocalSigner,
    signer: helpers.CountSigner,
    network: Network,
    client: provider.Provider,
    cancel: std.atomic.Value(bool) = .init(false),
    messages: [2]protocol.Message,
    pub fn init(a: A, weights: [2]u64, maximum: u32) !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        self.* = undefined;
        self.allocator = a;
        self.cancel = .init(false);
        self.directory = std.testing.tmpDir(.{});
        errdefer self.directory.cleanup();
        self.path = try self.directory.dir.realpathAlloc(a, ".");
        errdefer a.free(self.path);
        self.environment = std.process.EnvMap.init(a);
        errdefer self.environment.deinit();
        self.chains = undefined;
        for (self.chains[0..2], 0..) |*chain, i| {
            chain.name = if (i == 0) "origin-a" else "origin-b";
            chain.domain = @intCast(100 + i);
            chain.protocol = .ethereum;
        }
        self.chains[2].name = "starknet-destination";
        self.chains[2].domain = 200;
        self.chains[2].protocol = .starknet;
        self.chains[2].chain_id = "0x1";
        self.chains[2].max_batch_size = maximum;
        self.chains[2].max_submit_queue_length = null;
        self.chains[2].contracts = .{ .mailbox = (try Felt.init(2)).toBytes(), .merkle_tree_hook = (try Felt.init(3)).toBytes(), .interchain_gas_paymaster = @splat(0), .validator_announce = (try Felt.init(6)).toBytes() };
        self.configured = undefined;
        self.configured.chains = &self.chains;
        self.configured.role = .{ .relayer = std.mem.zeroes(@import("settings/types.zig").Relayer) };
        self.configured.role.relayer.max_message_retries = 100;
        self.configured.role.relayer.gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }};
        self.database = try origins.DatabaseOwner.init(a, self.path);
        errdefer self.database.deinit();
        const database = try self.database.get(&self.cancel);
        var source_count: usize = 0;
        errdefer for (self.sources[0..source_count]) |*source| source.history.deinit();
        for (&self.sources, &self.slots, 0..) |*source, *slot, i| {
            source.* = .{ .allocator = a, .chain = &self.chains[i], .store = native.Store.init(a, database, self.chains[i].name), .history = undefined, .indexer = undefined, .progress = undefined, .gas_enabled = false };
            source.history = history.Origin.init(a, &source.store, self.chains[i].domain, (try Felt.init(3)).toBytes(), null);
            source_count += 1;
            slot.* = .{ .allocator = a, .chain = &self.chains[i], .environment = &self.environment, .database = self.database, .checkpoints = undefined, .options = .{ .source = .{ .curl_library = "unused" } }, .destinations = &.{200}, .implementation = .{ .ethereum = source }, .ready = .init(true) };
        }
        self.origin_set = .{ .allocator = a, .slots = &self.slots, .tasks = &.{}, .destinations = &.{} };
        self.lane_origins = .{ .{}, .{} };
        self.owner = undefined;
        self.owner.allocator = a;
        self.owner.database = self.database;
        self.owner.settings = &self.configured;
        self.owner.environment = &self.environment;
        self.owner.options = .{ .curl_library = "unused", .max_active = 16, .max_active_bytes = 4 * 1024 * 1024, .max_retained_bytes = 4 * 1024 * 1024 };
        self.owner.metric_tracker = null;
        self.owner.origins = &self.origin_set;
        self.owner.memory_mutex = .{};
        self.owner.retained_bytes = 0;
        self.owner.effects_halted = .init(false);
        self.owner.denylist = try denylist.RuntimeDenylist.init(a, null);
        errdefer self.owner.denylist.deinit();
        self.owner.control_hub = try control.Hub.init(a, &self.configured, &self.environment, &self.origin_set, undefined, null, &self.owner.denylist);
        errdefer self.owner.control_hub.deinit();
        const commands = try control.Control.init(&self.owner.control_hub, &self.chains[2]);
        errdefer commands.deinit();
        const path = try helpers.nativePath(a);
        defer a.free(path);
        self.native_crypto = try crypto.Crypto.init(a, path);
        errdefer self.native_crypto.deinit();
        self.local = .{ .crypto = &self.native_crypto, .secret = .{0} ** 31 ++ .{17} };
        errdefer self.local.deinit();
        self.signer = .{ .actual = try self.local.interface() };
        self.network = .{ .fixture = self, .base = .{ .encoding = .modern } };
        self.client = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &self.network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
        self.readers = .{ .allocator = a, .arena = .init(a), .chain = self.chains[2], .options = .{ .curl_library = "unused" }, .environment = &self.environment, .http = .init(a) };
        errdefer self.readers.arena.deinit();
        errdefer self.readers.http.deinit();
        self.bindings = .{ .{ .domain = 100, .hook = (try Felt.init(3)).toBytes() }, .{ .domain = 101, .hook = (try Felt.init(3)).toBytes() } };
        self.factory = .{ .allocator = a, .arena = .init(a), .resources = &self.readers, .options = .{ .allow_fixture_transport = true, .origin_bindings = &self.bindings }, .backend_ready = true, .chain_checked = true, .backend = .{ .starknet = .{ .chain = .{ .provider = &self.client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &self.native_crypto, .signer = self.signer.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .maximum_fee = 1000, .announce = try Felt.init(6) } } };
        errdefer self.factory.arena.deinit();
        self.lane = .{ .owner = &self.owner, .chain = &self.chains[2], .origins = &self.lane_origins, .control = commands, .worker = undefined, .native_destination = &self.factory };
        errdefer self.clearActive();
        for (&self.messages, &self.sources, 0..) |*message, *source, i| {
            message.* = .{ .origin = @intCast(100 + i), .destination = 200, .nonce = @intCast(i), .body = "batch-message" };
            _ = try source.store.storeMessage(message.*, 1, null);
            const operation_state = try self.actor(i, now);
            defer operation_state.deinit();
            _ = try operation_state.tick(now);
            var scalar = try helpers.scalar(a, &self.factory.backend.starknet, @intCast(i), weights[i]);
            defer scalar.deinit();
            const body = try std.json.Stringify.valueAlloc(a, scalar.body, .{});
            defer a.free(body);
            var prepared = try destination.types.Prepared.init(a, try self.factory.authorityFor(message.origin, message.id(), operation_state.value.generation, .process), body, weights[i], weights[i] * 2);
            defer prepared.deinit();
            try operation_state.staged(&prepared, now);
            try operation_state.prepared(&prepared, true, true, now);
            _ = try self.lane.load(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms });
        }
        return self;
    }
    pub fn actor(self: *Fixture, index: usize, at: op.Times) !*op.Operation {
        const message = self.messages[index];
        return op.Operation.open(self.allocator, &self.sources[index].store, .{ .id = message.id(), .context = try self.factory.contextFor(try self.factory.authorityFor(message.origin, message.id(), 1, .process)), .nonce = message.nonce, .origin = message.origin, .destination = message.destination, .policy = .{ .max_retries = 100 } }, at);
    }
    pub fn journal(self: *Fixture) !groups.Journal {
        const typed: db.rocks.Typed = .{ .database = try self.database.get(&self.cancel), .domain_name = self.chains[2].name };
        var entry = (try typed.atOrAfter(self.allocator, op.group_record_prefix, &.{})) orelse return error.MissingNativeGroup;
        defer entry.deinit();
        return (try groups.Journal.load(self.allocator, typed, entry.key[0..32].*)) orelse return error.MissingNativeGroup;
    }
    pub fn clearActive(self: *Fixture) void {
        self.lane.clearGroupSenders();
        for (self.lane.active.items) |item| {
            item.message.deinit();
            if (item.metric_app_context) |text| self.allocator.free(text);
            self.allocator.destroy(item);
        }
        self.lane.active.deinit(self.allocator);
        self.lane.active = .empty;
        for (&self.lane_origins) |*origin| {
            if (origin.loader) |*loader| loader.deinit();
            if (origin.policy) |*policy| policy.deinit();
            origin.* = .{};
        }
        self.lane.active_bytes = 0;
        self.owner.retained_bytes = self.lane.native_group_reported.count() * 2 * (@sizeOf([32]u8) + @sizeOf(usize)) + self.lane.native_group_member_reported.count() * 2 * (@sizeOf([32]u8) + @sizeOf(u64));
    }
    pub fn addReadyPair(self: *Fixture, weights: [2]u64) !void {
        const a = self.allocator;
        for (&self.messages, &self.sources, 0..) |*message, *source, index| {
            message.nonce += 2;
            _ = try source.store.storeMessage(message.*, 1, null);
            const operation_state = try self.actor(index, now);
            defer operation_state.deinit();
            _ = try operation_state.tick(now);
            var call = try self.factory.backend.starknet.chain.process(message.*, "public-metadata");
            defer call.deinit();
            var transaction = try tx.Transaction.init(a, try Felt.init(1), try Felt.init(4), Felt.zero, .{ .l2_gas = .{ .max_amount = weights[index], .max_price_per_unit = 2 } }, &.{call.call}, .modern);
            defer transaction.deinit();
            const body = try std.json.Stringify.valueAlloc(a, .{ .transaction = transaction.request(&.{}, false), .public_key = self.signer.interface().public_key, .gas_limit = weights[index], .estimated_cost = weights[index] * 2 }, .{});
            defer a.free(body);
            var prepared = try destination.types.Prepared.init(a, try self.factory.authorityFor(message.origin, message.id(), operation_state.value.generation, .process), body, weights[index], weights[index] * 2);
            defer prepared.deinit();
            try operation_state.staged(&prepared, now);
            try operation_state.prepared(&prepared, true, true, now);
        }
        _ = try self.lane.load(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms });
        _ = try self.lane.load(.{ .unix_ms = now.unix_ms, .monotonic_ms = now.monotonic_ms });
    }
    pub fn actorForMember(self: *Fixture, member: groups.Member) !*op.Operation {
        const id = try @import("evm/codecs.zig").fixedHex(32, member.id);
        const context = try @import("evm/codecs.zig").fixedHex(32, member.context);
        return op.Operation.open(self.allocator, &self.sources[member.origin - 100].store, .{ .id = id, .context = context, .nonce = member.nonce, .origin = member.origin, .destination = 200, .policy = .{ .max_retries = 100 } }, now);
    }
    pub fn journalForWire(self: *Fixture, bytes: []const u8) !groups.Journal {
        const a = self.allocator;
        const database = try self.database.get(&self.cancel);
        const typed: db.rocks.Typed = .{ .database = database, .domain_name = self.chains[2].name };
        const prefix = try @import("db/keys.zig").scoped(a, typed.domain_name, op.group_record_prefix, "");
        defer a.free(prefix);
        var iterator = try database.prefix(a, prefix);
        defer iterator.deinit();
        while (try iterator.next(a)) |entry_value| {
            var entry = entry_value;
            defer entry.deinit();
            var candidate = (try groups.Journal.load(a, typed, entry.key[entry.key.len - 32 ..][0..32].*)) orelse return error.MissingNativeGroup;
            var retain = false;
            defer if (!retain) candidate.deinit();
            if (candidate.record.signed != null) {
                var signed = try candidate.signedValue(a);
                defer signed.deinit();
                if (std.mem.eql(u8, bytes, signed.bytes)) {
                    retain = true;
                    return candidate;
                }
            }
        }
        return error.MissingNativeGroup;
    }
    pub fn restartDatabaseFactoryLane(self: *Fixture) !void {
        self.clearActive();
        self.lane.clearGroupMetricState();
        self.lane.control.deinit();
        for (&self.sources) |*source| source.history.deinit();
        self.database.value.?.deinit();
        self.database.value = null;
        const database = try self.database.get(&self.cancel);
        for (&self.sources, 0..) |*source, index| {
            source.store = native.Store.init(self.allocator, database, self.chains[index].name);
            source.history = history.Origin.init(self.allocator, &source.store, self.chains[index].domain, (try Felt.init(3)).toBytes(), null);
        }
        // Keep only the chain configuration, explicit public signer and mocked
        // physical transport. Every Factory/Lane lifecycle cache is recreated.
        const backend = self.factory.backend;
        const options = self.factory.options;
        self.factory.arena.deinit();
        self.factory = .{ .allocator = self.allocator, .arena = .init(self.allocator), .resources = &self.readers, .options = options, .backend = backend, .backend_ready = true, .chain_checked = false };
        const commands = try control.Control.init(&self.owner.control_hub, &self.chains[2]);
        self.lane = .{ .owner = &self.owner, .chain = &self.chains[2], .origins = &self.lane_origins, .control = commands, .worker = undefined, .native_destination = &self.factory };
    }
    pub fn deinit(self: *Fixture) void {
        const a = self.allocator;
        self.clearActive();
        self.lane.clearGroupMetricState();
        self.lane.control.deinit();
        self.owner.control_hub.deinit();
        self.owner.denylist.deinit();
        self.factory.arena.deinit();
        self.readers.http.deinit();
        self.readers.arena.deinit();
        self.local.deinit();
        self.native_crypto.deinit();
        for (&self.sources) |*source| source.history.deinit();
        self.database.deinit();
        self.environment.deinit();
        a.free(self.path);
        self.directory.cleanup();
        a.destroy(self);
    }
};
const Network = struct {
    fixture: *Fixture,
    base: helpers.Network,
    included: bool = false,
    delivered: bool = false,
    lose_broadcast: bool = false,
    pending_nonce: bool = false,
    receipt_reads: usize = 0,
    advance_clock: ?*TestClock = null,
    advance_receipt_ms: u64 = 0,
    bad_receipt_hash: ?[32]u8 = null,
    actual_fee: u64 = 101,
    tip: u64 = 10,
    receipt_height: u64 = 9,
    delivered_id: ?[32]u8 = null,
    receipt_success: bool = true,
    finalized_nonce: Felt = Felt.zero,
    nonce_proofs: usize = 0,
    receipt_failures_left: usize = 0,
    blocked_nonce: ?Felt = null,
    required_nonce: ?Felt = null,
    accepted_nonces: [16]Felt = undefined,
    accepted_count: usize = 0,
    deadline_hashes: []const [32]u8 = &.{},
    deadline_hits: usize = 0,
    noncanonical_proof: bool = false,
    proof_headers: usize = 0,
    fn send(context: *anyopaque, a: A, request: http.Request) !http.Response {
        const self: *Network = @ptrCast(@alignCast(context));
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request.body.?, .{});
        defer parsed.deinit();
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        const id = try rpc.integer(i64, try rpc.field(parsed.value, "id"));
        if (std.mem.eql(u8, method, "starknet_getBlockWithTxHashes")) {
            const block = try rpc.field(try rpc.field(parsed.value, "params"), "block_id");
            const height = if (block == .object) try rpc.integer(u64, try rpc.field(block, "block_number")) else self.tip;
            self.proof_headers += 1;
            const hash = if (self.noncanonical_proof and self.proof_headers % 2 == 0) height + 100 else height;
            return .{ .allocator = a, .status = 200, .bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .status = "ACCEPTED_ON_L2", .block_number = height, .block_hash = try Felt.init(hash), .parent_hash = try Felt.init(height -| 1), .timestamp = @as(u64, 1) } }, .{}) };
        }
        if (std.mem.eql(u8, method, "starknet_getNonce")) {
            const block = try rpc.field(try rpc.field(parsed.value, "params"), "block_id");
            if (block == .object) {
                self.nonce_proofs += 1;
                return .{ .allocator = a, .status = 200, .bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = self.finalized_nonce }, .{}) };
            }
        }
        if (std.mem.eql(u8, method, "starknet_getNonce") and self.pending_nonce) return error.PendingReadIo;
        if (std.mem.eql(u8, method, "starknet_call")) {
            var delivered = self.delivered;
            if (self.delivered_id) |expected| {
                const encoded = try provider.feltArray(a, try rpc.field(try rpc.field(try rpc.field(parsed.value, "params"), "request"), "calldata"), 2);
                defer a.free(encoded);
                var decoder: @import("starknet/codec.zig").Decoder = .{ .input = encoded };
                delivered = std.mem.eql(u8, &expected, &try decoder.hash());
            }
            return .{ .allocator = a, .status = 200, .bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":[\"0x{d}\"]}}", .{ id, @intFromBool(delivered) }) };
        }
        if (std.mem.eql(u8, method, "starknet_blockNumber")) return .{ .allocator = a, .status = 200, .bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{d}}}", .{ id, self.tip }) };
        if (std.mem.eql(u8, method, "starknet_getTransactionReceipt")) {
            self.receipt_reads += 1;
            if (self.receipt_failures_left > 0) {
                self.receipt_failures_left -= 1;
                return error.FixtureReceiptUnavailable;
            }
            const requested_hash = try provider.felt(try rpc.field(try rpc.field(parsed.value, "params"), "transaction_hash"));
            for (self.deadline_hashes) |stalled| if (std.mem.eql(u8, &stalled, &requested_hash.toBytes())) {
                self.deadline_hits += 1;
                self.fixture.lane.native_group_deadline_ns = try @import("agents/scraper/receipts_evm.zig").nowNs();
                return error.RequestDeadlineExceeded;
            };
            if (self.bad_receipt_hash) |bad| if (std.mem.eql(u8, &bad, &requested_hash.toBytes())) return error.FixtureReceiptUnavailable;
            if (self.advance_clock) |clock| {
                clock.value.unix_ms += self.advance_receipt_ms;
                clock.value.monotonic_ms += self.advance_receipt_ms;
            }
            if (self.included) {
                const requested = try rpc.field(try rpc.field(parsed.value, "params"), "transaction_hash");
                const bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .type = "INVOKE", .transaction_hash = requested, .block_number = self.receipt_height, .block_hash = try Felt.init(self.receipt_height), .finality_status = "ACCEPTED_ON_L2", .execution_status = if (self.receipt_success) "SUCCEEDED" else "REVERTED", .actual_fee = .{ .amount = try Felt.init(self.actual_fee), .unit = "FRI" } } }, .{});
                return .{ .allocator = a, .status = 200, .bytes = bytes };
            }
        }
        if (std.mem.eql(u8, method, "starknet_getTransactionReceipt") and !self.included) return .{ .allocator = a, .status = 200, .bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"error\":{{\"code\":29,\"message\":\"not found\"}}}}", .{id}) };
        if (std.mem.eql(u8, method, "starknet_addInvokeTransaction")) {
            const raw = try std.json.Stringify.valueAlloc(a, try rpc.field(try rpc.field(parsed.value, "params"), "invoke_transaction"), .{});
            defer a.free(raw);
            var journal = try self.fixture.journalForWire(raw);
            defer journal.deinit();
            try std.testing.expect(journal.record.phase == .signed or journal.record.phase == .included);
            var signed = try journal.signedValue(a);
            defer signed.deinit();
            self.base.expected_signed = signed.bytes;
            self.base.hash = try Felt.fromBytes(signed.identity.hash256);
            for (journal.record.members) |member| {
                const actor = try self.fixture.actorForMember(member);
                defer actor.deinit();
                try std.testing.expectEqualStrings(member.intent, actor.intent.?);
                try std.testing.expect(destination.types.Identity.eql(signed.identity, actor.signed.?.identity));
                try std.testing.expectEqualStrings(signed.bytes, actor.signed.?.bytes);
            }
            const invoke = try rpc.field(try rpc.field(parsed.value, "params"), "invoke_transaction");
            const submitted_nonce = try provider.felt(try rpc.field(invoke, "nonce"));
            if (self.blocked_nonce) |blocked| if (submitted_nonce.value == blocked.value) return error.FixtureNonceNotReady;
            if (self.required_nonce) |*required| {
                if (submitted_nonce.value != required.value) return error.FixtureNonceNotReady;
                if (self.accepted_count == self.accepted_nonces.len) return error.FixtureTooManyBroadcasts;
                self.accepted_nonces[self.accepted_count] = submitted_nonce;
                self.accepted_count += 1;
                required.* = try Felt.init(required.value + 1);
            }
            var response = try helpers.Network.send(&self.base, a, request);
            if (self.lose_broadcast) {
                response.deinit();
                return error.FixtureResponseLost;
            }
            return response;
        }
        return helpers.Network.send(&self.base, a, request);
    }
};

test "Starknet Root group one multi-call durable transaction survives lost response and restart then600s per-message completion" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    try std.testing.expectEqual(@as(usize, 2), fixture.lane.active.items.len);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel); // One fresh query/nonce + all-member intent barrier.
    {
        var journal = try fixture.journal();
        defer journal.deinit();
        try std.testing.expectEqual(groups.Phase.prepared, journal.record.phase);
        try std.testing.expectEqual(@as(usize, 2), journal.record.members.len);
    }
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.count); // Query signature only.
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel); // One executable signature and all-member signed barrier.
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    fixture.network.lose_broadcast = true;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    try std.testing.expectEqual(error.FixtureResponseLost, fixture.lane.native_group_last_error.?);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.broadcasts);
    fixture.clearActive(); // Root actor/loader restart; only durable public state remains.
    fixture.network.lose_broadcast = false;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.nonce_reads);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.estimates);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    fixture.network.included = true;
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 100000, .monotonic_ms = 99000 }, &fixture.cancel);
    {
        var financial = try fixture.journal();
        defer financial.deinit();
        try std.testing.expectEqual(@as(u256, 101), financial.record.whole_expenditure.?.tokens_used);
        try std.testing.expectEqual(@as(u256, 100), financial.record.allocated_expenditure.?.tokens_used);
        try std.testing.expectEqual(@as(u256, 1), financial.record.unallocated_expenditure.?.tokens_used);
    }
    for (0..2) |index| {
        const actor = try fixture.actor(index, .{ .unix_ms = 100000, .monotonic_ms = 99000 });
        defer actor.deinit();
        try std.testing.expect(actor.value.confirmation_started);
        try std.testing.expectEqual(@as(u64, 700000), actor.deadline.?.unix_ms);
    }
    _ = try fixture.lane.load(.{ .unix_ms = 100000, .monotonic_ms = 99000 });
    _ = try fixture.lane.load(.{ .unix_ms = 100000, .monotonic_ms = 99000 });
    fixture.network.delivered = true;
    var index = fixture.lane.active.items.len;
    while (index > 0) {
        index -= 1;
        try std.testing.expect(!try fixture.lane.advance(fixture.lane.active.items[index], .{ .unix_ms = 699999, .monotonic_ms = 698999 }, &fixture.cancel));
    }
    index = fixture.lane.active.items.len;
    while (index > 0) {
        index -= 1;
        if (try fixture.lane.advance(fixture.lane.active.items[index], .{ .unix_ms = 700001, .monotonic_ms = 699001 }, &fixture.cancel)) try fixture.lane.releaseCompleted(index);
    }
    try std.testing.expectEqual(@as(usize, 0), fixture.lane.active.items.len);
    try std.testing.expectEqual(@as(u256, 25), (try fixture.sources[0].store.expenditure(fixture.messages[0].id())).tokens_used);
    try std.testing.expectEqual(@as(u256, 75), (try fixture.sources[1].store.expenditure(fixture.messages[1].id())).tokens_used);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 700002, .monotonic_ms = 699002 }, &fixture.cancel);
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    try std.testing.expect((try typed.atOrAfter(a, op.group_record_prefix, &.{})) == null);
}

pub fn included(fixture: *Fixture) !void {
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    fixture.network.included = true;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
}

test "Starknet Root scalar maxBatch1 and allzero fallback retain full canonical fee once" {
    const a = std.testing.allocator;
    for ([_]bool{ false, true }) |zero| {
        const fixture = try Fixture.init(a, if (zero) .{ 0, 0 } else .{ 1, 3 }, if (zero) 2 else 1);
        defer fixture.deinit();
        fixture.network.base.expected_calls = 1;
        try included(fixture);
        var journal = try fixture.journal();
        defer journal.deinit();
        try std.testing.expectEqual(@as(usize, 1), journal.record.members.len);
        try std.testing.expectEqual(@as(u256, 101), journal.record.whole_expenditure.?.tokens_used);
        try std.testing.expectEqual(@as(u256, 101), journal.record.allocated_expenditure.?.tokens_used);
        try std.testing.expectEqual(@as(u256, 0), journal.record.unallocated_expenditure.?.tokens_used);
        const member_id = try @import("evm/codecs.zig").fixedHex(32, journal.record.members[0].id);
        var item = fixture.lane.active.items[0];
        for (fixture.lane.active.items) |candidate| if (std.mem.eql(u8, &member_id, &candidate.message.value.id())) {
            item = candidate;
            break;
        };
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 2000, .monotonic_ms = 1000 }, &fixture.cancel));
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 3000, .monotonic_ms = 2000 }, &fixture.cancel));
        try std.testing.expectEqual(@as(u256, 101), (try fixture.sources[item.origin_index].store.expenditure(member_id)).tokens_used);
        try std.testing.expectEqual(@as(usize, 1), fixture.network.base.broadcasts);
    }
}

test "Starknet Root mixed zero weights persist present zero expenditure and conserve one whole fee" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 0, 3 }, 2);
    defer fixture.deinit();
    try included(fixture);
    var journal = try fixture.journal();
    defer journal.deinit();
    try std.testing.expectEqual(@as(u256, 101), journal.record.whole_expenditure.?.tokens_used);
    try std.testing.expectEqual(@as(u256, 101), journal.record.allocated_expenditure.?.tokens_used);
    try std.testing.expectEqual(@as(u256, 0), journal.record.unallocated_expenditure.?.tokens_used);
    for (fixture.lane.active.items) |item| {
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 2000, .monotonic_ms = 1000 }, &fixture.cancel));
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 3000, .monotonic_ms = 2000 }, &fixture.cancel));
    }
    const zero = try fixture.sources[0].store.typed.get(a, db.keys.Table.gas_expenditure_for_message_id.prefix(), &fixture.messages[0].id());
    defer if (zero) |bytes| a.free(bytes);
    try std.testing.expect(zero != null);
    try std.testing.expectEqual(@as(u256, 0), (try fixture.sources[0].store.expenditure(fixture.messages[0].id())).tokens_used);
    try std.testing.expectEqual(@as(u256, 101), (try fixture.sources[1].store.expenditure(fixture.messages[1].id())).tokens_used);
}

test "Starknet Root nonfinal inclusion reorg replays reserved exact nonce without resigning or extending confirmation" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture);
    var before = try fixture.journal();
    defer before.deinit();
    try std.testing.expect(!before.record.receipt_finalized);
    var signed = try before.signedValue(a);
    defer signed.deinit();
    fixture.network.included = false; // Canonical inclusion disappears; delivery remains false.
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 301000, .monotonic_ms = 300000 }, &fixture.cancel);
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.nonce_reads);
    for (0..2) |index| {
        const actor = try fixture.actor(index, .{ .unix_ms = 301000, .monotonic_ms = 300000 });
        defer actor.deinit();
        try std.testing.expectEqual(@as(u64, 601000), actor.deadline.?.unix_ms);
        try std.testing.expectEqualStrings(signed.bytes, actor.signed.?.bytes);
    }
    const reserved = try before.store.get(a, op.group_nonce_prefix, &try before.nonce());
    defer if (reserved) |bytes| a.free(bytes);
    try std.testing.expectEqualSlices(u8, &before.id, reserved.?);
    fixture.network.included = true;
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 302000, .monotonic_ms = 301000 }, &fixture.cancel);
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.broadcasts);
}

test "Starknet Root popped quote PIO is excluded from positive submit cap and resumes one selected group" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.chains[2].max_submit_queue_length = 1;
    try std.testing.expect(!try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    fixture.network.pending_nonce = true;
    try std.testing.expectError(error.PendingReadIo, fixture.lane.tickNativeGroups(now, &fixture.cancel));
    for (fixture.lane.active.items) |item| {
        try std.testing.expect(item.native_submit_inflight);
        try std.testing.expect(!item.native_submit_queued.?);
    }
    try std.testing.expect(try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1001, .monotonic_ms = 1 }, &fixture.cancel));
    fixture.network.pending_nonce = false;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var journal = try fixture.journal();
    defer journal.deinit();
    try std.testing.expectEqual(@as(usize, 2), journal.record.members.len);
    try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
}

test "Starknet Root imported Rust ready without native intent stays queue pressure and cannot enter group" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.chains[2].max_submit_queue_length = 1;
    const message = fixture.messages[0];
    var batch = try fixture.sources[0].store.typed.batch(a);
    defer batch.deinit();
    try batch.delete("zig_native_destination_operation_v1/", &message.id());
    try batch.commitSync();
    // Keep the Rust ReadyToSubmit status; private native state is absent.
    fixture.network.base.expected_calls = 1;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var journal = try fixture.journal();
    defer journal.deinit();
    try std.testing.expectEqual(@as(usize, 1), journal.record.members.len);
    try std.testing.expect(journal.record.members[0].origin == 101);
    try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
    try std.testing.expect(!try fixture.lane.nativePreparationAllowed(.{ .unix_ms = 1001, .monotonic_ms = 1 }, &fixture.cancel));
}

test "Starknet Root signed group reopens actual Rocks and fresh Factory Lane without nonce query estimate or executable resign" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var before = try fixture.journal();
    defer before.deinit();
    var signed = try before.signedValue(a);
    defer signed.deinit();
    try fixture.restartDatabaseFactoryLane();
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var recovered = try fixture.journal();
    defer recovered.deinit();
    var same = try recovered.signedValue(a);
    defer same.deinit();
    try std.testing.expectEqualStrings(signed.bytes, same.bytes);
    try std.testing.expect(destination.types.Identity.eql(signed.identity, same.identity));
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.nonce_reads);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.estimates);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
}

test "Starknet Root seeded crash schedules preserve all member barriers and forbid effects before durable common signature" {
    const a = std.testing.allocator;
    var random = std.Random.DefaultPrng.init(0x737461726b677270);
    for (0..24) |iteration| {
        const fixture = try Fixture.init(a, .{ random.random().intRangeAtMost(u64, 1, 19), random.random().intRangeAtMost(u64, 1, 19) }, 2);
        defer fixture.deinit();
        const cut = random.random().intRangeAtMost(u8, 0, 3);
        if (cut < 2) {
            if (cut == 0) op.GroupTestFault.before_commit.store(true, .release) else op.GroupTestFault.after_commit.store(true, .release);
            defer op.GroupTestFault.before_commit.store(false, .release);
            defer op.GroupTestFault.after_commit.store(false, .release);
            if (cut == 0) try std.testing.expectError(error.InjectedNativeGroupCommitFailure, fixture.lane.tickNativeGroups(now, &fixture.cancel)) else try std.testing.expectError(error.NativeGroupCommitOutcomeUnknown, fixture.lane.tickNativeGroups(now, &fixture.cancel));
            try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
            try std.testing.expectEqual(fixture.network.base.estimates, fixture.signer.count); // Every signature so far is nonbroadcastable query-only.
            if (cut == 0) _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        } else _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        if (cut >= 2) {
            if (cut == 2) op.GroupTestFault.before_commit.store(true, .release) else op.GroupTestFault.after_commit.store(true, .release);
            defer op.GroupTestFault.before_commit.store(false, .release);
            defer op.GroupTestFault.after_commit.store(false, .release);
            if (cut == 2) try std.testing.expectError(error.InjectedNativeGroupCommitFailure, fixture.lane.tickNativeGroups(now, &fixture.cancel)) else try std.testing.expectError(error.NativeGroupCommitOutcomeUnknown, fixture.lane.tickNativeGroups(now, &fixture.cancel));
            try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
        }
        const signer_before_reopen = fixture.signer.count;
        try fixture.restartDatabaseFactoryLane();
        var disk = try fixture.journal();
        const already_signed = disk.record.phase == .signed;
        disk.deinit();
        fixture.cancel.store(true, .release);
        try std.testing.expectError(error.RequestCancelled, fixture.lane.tickNativeGroups(now, &fixture.cancel));
        fixture.cancel.store(false, .release);
        try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        if (!already_signed) _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        try std.testing.expectEqual(@as(usize, 1), fixture.network.base.broadcasts);
        try std.testing.expectEqual(signer_before_reopen + @as(usize, if (already_signed) 0 else 1), fixture.signer.count);
        // The physical send callback independently reads BOTH actual Rocks
        // member rows and the shared signed journal on every generated send.
        var journal = try fixture.journal();
        defer journal.deinit();
        try std.testing.expectEqual(@as(usize, 2), journal.record.members.len);
        try std.testing.expectEqual(groups.Phase.signed, journal.record.phase);
        _ = iteration;
    }
}

const TestClock = struct {
    value: op.Times = now,
    fn read(context: *anyopaque) !op.Times {
        const self: *TestClock = @ptrCast(@alignCast(context));
        return self.value;
    }
    fn interface(self: *TestClock) @import("agents/operation.zig").ObservationClock {
        return .{ .context = self, .now_fn = read };
    }
};

test "Starknet Root fresh receipt clock starts common confirmation after blocking RPC" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    var clock: TestClock = .{};
    fixture.owner.options.observation_clock = clock.interface();
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    fixture.network.included = true;
    fixture.network.advance_clock = &clock;
    fixture.network.advance_receipt_ms = 900000;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    for (0..2) |index| {
        const actor = try fixture.actor(index, clock.value);
        defer actor.deinit();
        try std.testing.expectEqual(@as(u64, 1501000), actor.deadline.?.unix_ms);
        try std.testing.expectEqual(@as(u64, 1500000), actor.value.next_attempt_ms);
    }
}

test "Starknet Root retained included nonce blocks competing fresh group before executable signing" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture);
    try fixture.addReadyPair(.{ 2, 5 });
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel); // RPC still reports old reserved nonce5.
    try std.testing.expectEqual(@as(usize, 3), fixture.signer.count); // Initial query+executable, new query only.
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.broadcasts);
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    const pending = try typed.get(a, op.group_current_prefix, "");
    defer if (pending) |bytes| a.free(bytes);
    try std.testing.expect(pending == null);
    fixture.network.base.next_nonce = try Felt.init(6);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    const fresh = (try typed.get(a, op.group_current_prefix, "")).?;
    defer a.free(fresh);
    var journal = (try groups.Journal.load(a, typed, fresh[0..32].*)).?;
    defer journal.deinit();
    try std.testing.expectEqual((try Felt.init(6)).toBytes(), try journal.nonce());
}

test "Starknet Root included GC poll budget remains bounded while normal ready work advances" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    for (0..6) |index| {
        fixture.network.base.next_nonce = try Felt.init(5 + index);
        fixture.network.included = false;
        try included(fixture);
        if (index < 5) try fixture.addReadyPair(.{ 1, 3 });
    }
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    const prefix = try @import("db/keys.zig").scoped(a, typed.domain_name, op.group_record_prefix, "");
    defer a.free(prefix);
    var iterator = try typed.database.prefix(a, prefix);
    defer iterator.deinit();
    var count: usize = 0;
    while (try iterator.next(a)) |owned| {
        var entry = owned;
        entry.deinit();
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 6), count);
    const reads = fixture.network.receipt_reads;
    fixture.lane.native_group_gc_cursor = @splat(0);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    try std.testing.expect(fixture.network.receipt_reads - reads <= 2);
    try fixture.addReadyPair(.{ 1, 3 });
    fixture.network.base.next_nonce = try Felt.init(11);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    const current = try typed.get(a, op.group_current_prefix, "");
    defer if (current) |bytes| a.free(bytes);
    try std.testing.expect(current != null);
    try std.testing.expectEqual(@as(usize, 14), fixture.lane.active.items.len);
}

test "Starknet Root ordinary receipt failure preserves signed owner while finalized delivery drains and retires group" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var journal = try fixture.journal();
    defer journal.deinit();
    var signed = try journal.signedValue(a);
    defer signed.deinit();
    fixture.network.bad_receipt_hash = signed.identity.hash256;
    fixture.network.delivered = true;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel); // Ancillary receipt cannot abort ordinary actor drain.
    for (fixture.lane.active.items) |item| try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 2000, .monotonic_ms = 1000 }, &fixture.cancel));
    var index = fixture.lane.active.items.len;
    while (index > 0) {
        index -= 1;
        try std.testing.expect(try fixture.lane.advance(fixture.lane.active.items[index], .{ .unix_ms = 602001, .monotonic_ms = 601001 }, &fixture.cancel));
        try fixture.lane.releaseCompleted(index);
    }
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602002, .monotonic_ms = 601002 }, &fixture.cancel);
    const pending = try journal.store.get(a, op.group_current_prefix, "");
    defer if (pending) |bytes| a.free(bytes);
    try std.testing.expect(pending != null); // Unknown receipt cannot authorize nonce reuse.
    fixture.network.bad_receipt_hash = null;
    fixture.network.finalized_nonce = try Felt.init(6);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602003, .monotonic_ms = 601003 }, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602004, .monotonic_ms = 601004 }, &fixture.cancel);
    const retired = try journal.store.get(a, op.group_current_prefix, "");
    defer if (retired) |bytes| a.free(bytes);
    try std.testing.expect(retired == null);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
}

test "Starknet Root included receipt error rotates bounded GC and clears healthy later group" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture);
    try fixture.addReadyPair(.{ 1, 3 });
    fixture.network.base.next_nonce = try Felt.init(6);
    fixture.network.included = false;
    try included(fixture);
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    var first = (try typed.atOrAfter(a, op.group_record_prefix, &.{})).?;
    defer first.deinit();
    var bad = (try groups.Journal.load(a, typed, first.key[0..32].*)).?;
    defer bad.deinit();
    fixture.network.bad_receipt_hash = try @import("evm/codecs.zig").fixedHex(32, bad.record.identity.?);
    fixture.network.delivered = true;
    fixture.network.tip = 12; // Healthy receipt is configured-finalized; mailbox status alone cannot release a nonce.
    // Complete the later sorted group via actual per-member driver reads.
    var next_key = first.key[0..32].*;
    var carry = next_key.len;
    while (carry > 0) {
        carry -= 1;
        next_key[carry] +%= 1;
        if (next_key[carry] != 0) break;
    }
    var second = (try typed.atOrAfter(a, op.group_record_prefix, &next_key)).?;
    defer second.deinit();
    var healthy = (try groups.Journal.load(a, typed, second.key[0..32].*)).?;
    defer healthy.deinit();
    for (healthy.record.members) |member| {
        const id = try @import("evm/codecs.zig").fixedHex(32, member.id);
        for (fixture.lane.active.items) |item| if (std.mem.eql(u8, &id, &item.message.value.id())) {
            _ = try fixture.lane.advance(item, .{ .unix_ms = 602001, .monotonic_ms = 601001 }, &fixture.cancel);
        };
    }
    fixture.lane.native_group_gc_cursor = @splat(0);
    for (0..4) |poll| _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602002 + poll, .monotonic_ms = 601002 + poll }, &fixture.cancel);
    const remains = try typed.get(a, op.group_record_prefix, first.key);
    defer if (remains) |bytes| a.free(bytes);
    const cleared = try typed.get(a, op.group_record_prefix, second.key);
    defer if (cleared) |bytes| a.free(bytes);
    try std.testing.expect(remains != null and cleared == null);
}

test "Starknet Root final canonical receipt refreshes provisional allocation audit and matches actual once-only member ledgers" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture);
    fixture.network.actual_fee = 103;
    fixture.network.tip = 12;
    fixture.lane.native_group_gc_cursor = @splat(0);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var journal = try fixture.journal();
    defer journal.deinit();
    try std.testing.expect(journal.record.receipt_finalized);
    try std.testing.expectEqual(@as(u256, 103), journal.record.whole_expenditure.?.tokens_used);
    try std.testing.expectEqual(@as(u256, 102), journal.record.allocated_expenditure.?.tokens_used);
    try std.testing.expectEqual(@as(u256, 1), journal.record.unallocated_expenditure.?.tokens_used);
    for (fixture.lane.active.items) |item| {
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 2000, .monotonic_ms = 1000 }, &fixture.cancel));
        try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 3000, .monotonic_ms = 2000 }, &fixture.cancel));
    }
    try std.testing.expectEqual(@as(u256, 25), (try fixture.sources[0].store.expenditure(fixture.messages[0].id())).tokens_used);
    try std.testing.expectEqual(@as(u256, 77), (try fixture.sources[1].store.expenditure(fixture.messages[1].id())).tokens_used);
}

test "Starknet Root mixed delivery after reorg consumes exact original group then retries only undelivered member" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture);
    fixture.network.included = false;
    fixture.network.delivered_id = fixture.messages[0].id();
    var index = fixture.lane.active.items.len;
    while (index > 0) {
        index -= 1;
        if (fixture.lane.active.items[index].origin_index == 0) {
            try std.testing.expect(try fixture.lane.advance(fixture.lane.active.items[index], .{ .unix_ms = 602001, .monotonic_ms = 601001 }, &fixture.cancel));
            try fixture.lane.releaseCompleted(index);
        }
    }
    try std.testing.expect(try fixture.sources[0].store.processed(fixture.messages[0].nonce));
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602002, .monotonic_ms = 601002 }, &fixture.cancel);
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    try std.testing.expectEqual(@as(usize, 1), fixture.network.base.nonce_reads);
    // The replayed atomic invoke now canonically reverts on the already-
    // delivered first call; no replacement signature was made for a subset.
    fixture.network.included = true;
    fixture.network.receipt_success = false;
    fixture.network.tip = 12;
    fixture.lane.native_group_gc_cursor = @splat(0);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 603000, .monotonic_ms = 602000 }, &fixture.cancel);
    try std.testing.expect(!try fixture.lane.advance(fixture.lane.active.items[0], .{ .unix_ms = 603001, .monotonic_ms = 602001 }, &fixture.cancel));
    const remaining = try fixture.actor(1, .{ .unix_ms = 603002, .monotonic_ms = 602002 });
    defer remaining.deinit();
    try std.testing.expect(remaining.signed == null and remaining.intent == null and remaining.value.stage == .pending);
    try std.testing.expectEqual(@as(u32, 1), remaining.value.retries);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 603003, .monotonic_ms = 602003 }, &fixture.cancel);
    try std.testing.expectEqual(@as(u256, 25), (try fixture.sources[0].store.expenditure(fixture.messages[0].id())).tokens_used);
    try std.testing.expectEqual(@as(u256, 75), (try fixture.sources[1].store.expenditure(fixture.messages[1].id())).tokens_used);
    try std.testing.expect(!try fixture.sources[1].store.processed(fixture.messages[1].nonce));
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    const reserved = try typed.get(a, op.group_nonce_prefix, &(try Felt.init(5)).toBytes());
    defer if (reserved) |bytes| a.free(bytes);
    try std.testing.expect(reserved == null);
}

test "Starknet Root scalar signed nonce superseded proof retires without inventing unknown fee" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 1);
    defer fixture.deinit();
    const actor = try fixture.actor(0, now);
    defer actor.deinit();
    var prepared = try destination.types.Prepared.restore(a, actor.intent.?);
    defer prepared.deinit();
    const clock: destination.Clock = .{ .unix_ms = now.unix_ms, .deadline_ns = (try @import("agents/scraper/receipts_evm.zig").nowNs()) + 10 * std.time.ns_per_s, .cancel = &fixture.cancel };
    var signed = try fixture.factory.sign(&prepared, null, actor.persistence(now), clock);
    defer signed.deinit();
    fixture.network.finalized_nonce = try Felt.init((@as(u256, 1) << 192) + 1);
    const driver: @import("agents/relayer/native_driver.zig").Driver = .{};
    const report = try driver.step(a, &fixture.factory, actor, &fixture.sources[0].history, &fixture.lane_origins[0].policy.?, fixture.messages[0], clock, now);
    try std.testing.expectEqual(@import("agents/relayer/native_driver.zig").State.retired, report.state);
    try std.testing.expect(actor.signed == null and actor.intent == null and actor.value.stage == .pending);
    try std.testing.expectEqual(@as(u32, 1), actor.value.retries);
    try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.count);
    const spent = try fixture.sources[0].store.typed.get(a, db.keys.Table.gas_expenditure_for_message_id.prefix(), &fixture.messages[0].id());
    defer if (spent) |bytes| a.free(bytes);
    try std.testing.expect(spent == null); // No canonical receipt means UNKNOWN actual fee.
}

test "Starknet Root atomic fullFelt nonce retirement survives both WAL boundaries and real restart" {
    const a = std.testing.allocator;
    for ([_]bool{ false, true }) |after| {
        const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
        defer fixture.deinit();
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        fixture.network.finalized_nonce = try Felt.init((@as(u256, 1) << 192) + 6);
        if (after) op.GroupTestFault.after_commit.store(true, .release) else op.GroupTestFault.before_commit.store(true, .release);
        defer op.GroupTestFault.after_commit.store(false, .release);
        defer op.GroupTestFault.before_commit.store(false, .release);
        if (after) try std.testing.expectError(error.NativeGroupCommitOutcomeUnknown, fixture.lane.tickNativeGroups(now, &fixture.cancel)) else try std.testing.expectError(error.InjectedNativeGroupCommitFailure, fixture.lane.tickNativeGroups(now, &fixture.cancel));
        var disk = try fixture.journal();
        defer disk.deinit();
        try std.testing.expectEqual(if (after) groups.Phase.retired else groups.Phase.signed, disk.record.phase);
        for (0..2) |index| {
            const actor = try fixture.actor(index, now);
            defer actor.deinit();
            try std.testing.expectEqual(after, actor.signed == null);
            try std.testing.expectEqual(after, actor.intent == null);
            try std.testing.expectEqual(@as(u32, if (after) 1 else 0), actor.value.retries);
            const spent = try fixture.sources[index].store.typed.get(a, db.keys.Table.gas_expenditure_for_message_id.prefix(), &fixture.messages[index].id());
            defer if (spent) |bytes| a.free(bytes);
            try std.testing.expect(spent == null);
        }
        try fixture.restartDatabaseFactoryLane();
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        if (!after) _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
        try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
        try std.testing.expectEqual(@as(usize, 1), fixture.network.base.nonce_reads);
        const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
        const pending = try typed.get(a, op.group_current_prefix, "");
        defer if (pending) |bytes| a.free(bytes);
        try std.testing.expect(pending == null);
        const reserved = try typed.get(a, op.group_nonce_prefix, &(try Felt.init(5)).toBytes());
        defer if (reserved) |bytes| a.free(bytes);
        try std.testing.expect(reserved == null);
        const archived = try typed.get(a, op.group_history_prefix, &disk.id);
        defer if (archived) |bytes| a.free(bytes);
        try std.testing.expect(archived != null);
        try std.testing.expect(std.mem.indexOf(u8, archived.?, "observed_nonce") != null);
    }
}

test "Starknet Root negative nonce and canonical fence leave complete signed ownership untouched" {
    const a = std.testing.allocator;
    for (0..3) |mode| {
        const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
        defer fixture.deinit();
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        fixture.network.finalized_nonce = try Felt.init(if (mode == 0) 5 else 6);
        if (mode == 1) fixture.network.delivered_id = fixture.messages[0].id(); // One effect present at proofheight prevents whole-group absence proof.
        if (mode == 2) {
            fixture.network.noncanonical_proof = true;
            fixture.network.proof_headers = 0;
        }
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        var journal = try fixture.journal();
        defer journal.deinit();
        try std.testing.expectEqual(groups.Phase.signed, journal.record.phase);
        for (0..2) |index| {
            const actor = try fixture.actor(index, now);
            defer actor.deinit();
            try std.testing.expect(actor.signed != null and actor.intent != null);
            try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
        }
        if (mode != 0) try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
        try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    }
}

test "Starknet Root all independently delivered orphan retains nonce until canonical consumption proof" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture);
    var original = try fixture.journal();
    defer original.deinit();
    fixture.network.included = false;
    fixture.network.delivered = true;
    var index = fixture.lane.active.items.len;
    while (index > 0) {
        index -= 1;
        try std.testing.expect(try fixture.lane.advance(fixture.lane.active.items[index], .{ .unix_ms = 602001, .monotonic_ms = 601001 }, &fixture.cancel));
        try fixture.lane.releaseCompleted(index);
    }
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602002, .monotonic_ms = 601002 }, &fixture.cancel);
    const reservation = try original.store.get(a, op.group_nonce_prefix, &try original.nonce());
    defer if (reservation) |bytes| a.free(bytes);
    try std.testing.expectEqualSlices(u8, &original.id, reservation.?);
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.broadcasts); // Only exact original replay; no new signature.
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    fixture.network.finalized_nonce = try Felt.init(6);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602003, .monotonic_ms = 601003 }, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602004, .monotonic_ms = 601004 }, &fixture.cancel);
    const released = try original.store.get(a, op.group_nonce_prefix, &try original.nonce());
    defer if (released) |bytes| a.free(bytes);
    try std.testing.expect(released == null);
    for (0..2) |member| try std.testing.expect(try fixture.sources[member].store.processed(fixture.messages[member].nonce));
}

test "Starknet Root per-member failed receipt after coordinator read failure cannot partially reset group" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    fixture.network.included = true;
    fixture.network.receipt_success = false;
    fixture.network.receipt_failures_left = 1;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    for (fixture.lane.active.items) |item| try std.testing.expect(!try fixture.lane.advance(item, .{ .unix_ms = 2000, .monotonic_ms = 1000 }, &fixture.cancel));
    var before = try fixture.journal();
    defer before.deinit();
    try std.testing.expectEqual(groups.Phase.signed, before.record.phase);
    for (0..2) |index| {
        const actor = try fixture.actor(index, now);
        defer actor.deinit();
        try std.testing.expect(actor.signed != null and actor.intent != null);
        try std.testing.expectEqual(@as(u32, 0), actor.value.retries);
    }
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    var after = try fixture.journal();
    defer after.deinit();
    try std.testing.expectEqual(groups.Phase.retired, after.record.phase);
    try std.testing.expect(after.record.failed_receipt != null);
    for (0..2) |index| {
        const actor = try fixture.actor(index, now);
        defer actor.deinit();
        try std.testing.expect(actor.signed == null and actor.intent == null);
        try std.testing.expectEqual(@as(u32, 1), actor.value.retries);
    }
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
    try std.testing.expectEqual(@as(usize, 0), fixture.network.base.broadcasts);
}

fn operationCount(registry: *@import("ops/metrics.zig").Registry, phase: []const u8) !u64 {
    const a = std.testing.allocator;
    const rendered = try registry.render(a);
    defer a.free(rendered);
    const marker = try std.fmt.allocPrint(a, "phase=\"{s}\"", .{phase});
    defer a.free(marker);
    var lines = std.mem.splitScalar(u8, rendered, '\n');
    var count: u64 = 0;
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "hyperlane_operations_processed_count{") or std.mem.indexOf(u8, line, marker) == null) continue;
        const split = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        count += try std.fmt.parseInt(u64, line[split + 1 ..], 10);
    }
    return count;
}

test "Starknet Root delayed shared receipt counts prior per-member submission and inactive member exactly once" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    fixture.clearActive();
    fixture.owner.options.max_active = 1;
    const metric = @import("ops/metrics.zig");
    const relayer_metric = @import("ops/relayer_metrics.zig");
    const registry = try metric.Registry.init(a, .relayer, .{ .base_version = "group-delay-fixture" });
    defer registry.deinit();
    const tracker = try relayer_metric.WaitTracker.init(a, registry, .{ .max_active = 16, .max_bytes = 1024 * 1024 });
    defer tracker.deinit();
    fixture.owner.metric_tracker = tracker;
    var adapters: [2]*relayer_metric.Adapter = undefined;
    var count: usize = 0;
    defer {
        fixture.owner.metric_tracker = null;
        for (adapters[0..count], 0..) |adapter, index| {
            fixture.lane_origins[index].metrics = null;
            adapter.deinit();
        }
    }
    for (&adapters, 0..) |*adapter, index| {
        adapter.* = try relayer_metric.Adapter.init(a, tracker, fixture.chains[index].name, fixture.chains[2].name);
        count += 1;
        fixture.lane_origins[index].metrics = adapter.*;
    }
    _ = try fixture.lane.load(.{ .unix_ms = 1000, .monotonic_ms = 0 });
    try std.testing.expectEqual(@as(usize, 1), fixture.lane.active.items.len);
    fixture.network.delivered_id = fixture.lane.active.items[0].message.value.id();
    try std.testing.expect(!try fixture.lane.advance(fixture.lane.active.items[0], .{ .unix_ms = 1000, .monotonic_ms = 0 }, &fixture.cancel));
    try std.testing.expectEqual(@as(u64, 1), try operationCount(registry, "submitted"));
    fixture.network.included = true;
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 2000, .monotonic_ms = 1000 }, &fixture.cancel);
    try std.testing.expectEqual(@as(u64, 2), try operationCount(registry, "submitted"));
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 2001, .monotonic_ms = 1001 }, &fixture.cancel);
    try std.testing.expectEqual(@as(u64, 2), try operationCount(registry, "submitted"));
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
}

test "Starknet Root changed canonical inclusion refreshes fence before releasing settled group" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    try included(fixture);
    fixture.network.delivered = true;
    var index = fixture.lane.active.items.len;
    while (index > 0) {
        index -= 1;
        try std.testing.expect(try fixture.lane.advance(fixture.lane.active.items[index], .{ .unix_ms = 602001, .monotonic_ms = 601001 }, &fixture.cancel));
        try fixture.lane.releaseCompleted(index);
    }
    var original = try fixture.journal();
    defer original.deinit();
    fixture.network.receipt_height = 11;
    fixture.network.tip = 12;
    fixture.lane.native_group_gc_cursor = @splat(0);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602002, .monotonic_ms = 601002 }, &fixture.cancel);
    var refreshed = try fixture.journal();
    defer refreshed.deinit();
    try std.testing.expectEqual(@as(u64, 11), refreshed.record.canonical_receipt.?.height);
    try std.testing.expectEqual(original.record.included_unix_ms, refreshed.record.included_unix_ms);
    const reserved = try original.store.get(a, op.group_nonce_prefix, &try original.nonce());
    defer if (reserved) |bytes| a.free(bytes);
    try std.testing.expect(reserved != null); // First moved receipt is persisted, never used to drop ownership immediately.
    fixture.lane.native_group_gc_cursor = @splat(0);
    _ = try fixture.lane.tickNativeGroups(.{ .unix_ms = 602003, .monotonic_ms = 601003 }, &fixture.cancel);
    const released = try original.store.get(a, op.group_nonce_prefix, &try original.nonce());
    defer if (released) |bytes| a.free(bytes);
    try std.testing.expect(released == null);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.count);
}

test "Starknet Root higher pending nonce cannot starve exact lower orphan replay" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    try included(fixture); // Original nonce5 inclusion releases only the current pointer.
    fixture.network.included = false;
    fixture.network.blocked_nonce = try Felt.init(5);
    try fixture.addReadyPair(.{ 1, 3 });
    fixture.network.base.next_nonce = try Felt.init(6);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel); // Durable higher-nonce group6 now owns current.
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    const current = (try typed.get(a, op.group_current_prefix, "")).?;
    defer a.free(current);
    var pending = (try groups.Journal.load(a, typed, current[0..32].*)).?;
    defer pending.deinit();
    try std.testing.expectEqual((try Felt.init(6)).toBytes(), try pending.nonce());
    try std.testing.expectEqual(groups.Phase.signed, pending.record.phase);
    fixture.network.blocked_nonce = null;
    fixture.network.required_nonce = try Felt.init(5);
    for (0..6) |_| {
        _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel);
        if (fixture.network.accepted_count == 2) break;
    }
    try std.testing.expectEqual(@as(usize, 2), fixture.network.accepted_count);
    try std.testing.expectEqual(@as(u256, 5), fixture.network.accepted_nonces[0].value);
    try std.testing.expectEqual(@as(u256, 6), fixture.network.accepted_nonces[1].value);
    try std.testing.expectEqual(@as(usize, 4), fixture.signer.count); // Two queries +two executable signatures, never replacement keys.
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.nonce_reads);
    try std.testing.expectEqual(@as(usize, 2), fixture.network.base.estimates);
}

test "Starknet Root alternates priority before old deadline callbacks so current progresses independently of old group count" {
    const a = std.testing.allocator;
    const fixture = try Fixture.init(a, .{ 1, 3 }, 2);
    defer fixture.deinit();
    fixture.factory.backend.starknet.reorg = .{ .blocks = 2 };
    for (0..3) |index| {
        fixture.network.base.next_nonce = try Felt.init(5 + index);
        fixture.network.included = false;
        try included(fixture);
        if (index < 2) try fixture.addReadyPair(.{ 1, 3 });
    }
    try fixture.addReadyPair(.{ 1, 3 });
    fixture.network.base.next_nonce = try Felt.init(8);
    fixture.network.included = false;
    _ = try fixture.lane.tickNativeGroups(now, &fixture.cancel); // Healthy current is durably prepared.
    const typed: db.rocks.Typed = .{ .database = try fixture.database.get(&fixture.cancel), .domain_name = fixture.chains[2].name };
    const current = (try typed.get(a, op.group_current_prefix, "")).?;
    defer a.free(current);
    const prefix = try @import("db/keys.zig").scoped(a, typed.domain_name, op.group_record_prefix, "");
    defer a.free(prefix);
    var iterator = try typed.database.prefix(a, prefix);
    defer iterator.deinit();
    var stalled: [3][32]u8 = undefined;
    var count: usize = 0;
    while (try iterator.next(a)) |owned| {
        var entry = owned;
        defer entry.deinit();
        const id = entry.key[entry.key.len - 32 ..][0..32].*;
        if (std.mem.eql(u8, &id, current)) continue;
        var journal = (try groups.Journal.load(a, typed, id)).?;
        defer journal.deinit();
        try std.testing.expectEqual(groups.Phase.included, journal.record.phase);
        stalled[count] = try @import("evm/codecs.zig").fixedHex(32, journal.record.identity.?);
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 3), count);
    fixture.network.deadline_hashes = &stalled;
    fixture.owner.options.job_timeout_ms = 20000;
    fixture.owner.options.request_timeout_ms = 20000;
    fixture.lane.native_group_current_first = false;
    fixture.lane.native_group_gc_cursor = @splat(0);
    const previous_signs = fixture.signer.count;
    const previous_broadcasts = fixture.network.base.broadcasts;
    const previous_nonces = fixture.network.base.nonce_reads;
    const previous_estimates = fixture.network.base.estimates;
    var passes: usize = 0;
    while (passes < 4) : (passes += 1) {
        _ = fixture.lane.tickNativeGroups(now, &fixture.cancel) catch |err| switch (err) {
            error.RequestDeadlineExceeded => 0,
            else => return err,
        };
        if (fixture.network.base.broadcasts > previous_broadcasts) {
            passes += 1;
            break;
        }
    }
    try std.testing.expect(passes <= 4);
    try std.testing.expectEqual(previous_broadcasts + 1, fixture.network.base.broadcasts);
    try std.testing.expectEqual(previous_signs + 1, fixture.signer.count); // Only the healthy current executable signature.
    try std.testing.expectEqual(previous_nonces, fixture.network.base.nonce_reads);
    try std.testing.expectEqual(previous_estimates, fixture.network.base.estimates);
    try std.testing.expect(fixture.network.deadline_hits >= 2);
    try std.testing.expectEqual(@as(u64, 20000), fixture.owner.options.job_timeout_ms);
    try std.testing.expectEqual(@as(u32, 20000), fixture.owner.options.request_timeout_ms);
    try std.testing.expect(fixture.lane.native_group_deadline_ns == null);
}
