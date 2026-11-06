//! Saved executable Invoke validation and consensus-pinned nonce proofs. All
//! signing keys are deterministic public fixtures; no production transport.
const std = @import("std");
const backend = @import("starknet.zig");
const types = @import("types.zig");
const Factory = @import("factory.zig");
const helpers = @import("starknet_batch_testing.zig");
const tx = @import("../../starknet/transaction.zig");
const provider = @import("../../starknet/provider.zig");
const codec = @import("../../starknet/codec.zig");
const crypto = @import("../../starknet/crypto.zig");
const rpc = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
const Felt = codec.Felt;
const A = std.mem.Allocator;
const a = std.testing.allocator;
const saved_nonce: Felt = .{ .value = (@as(u256, 1) << 192) + 5 };
const Network = struct {
    base: helpers.Network = .{ .encoding = .modern, .next_nonce = saved_nonce },
    proving: bool = false,
    requests: usize = 0,
    header_reads: usize = 0,
    current_height: u64 = 100,
    nonce: Felt = .{ .value = saved_nonce.value + 1 },
    receipt_present: bool = false,
    delivered: bool = false,
    pending: bool = false,
    reorg: bool = false,
    reorg_after: usize = 1,
    announcement_mode: bool = false,
    present_location: ?[]const u8 = null,
    wrong_height: bool = false,
    failure_at: ?usize = null,
    failure: anyerror = error.PendingReadIo,
    cancel: ?*const std.atomic.Value(bool) = null,
    fn send(ctx: *anyopaque, allocator: A, request: http.Request) !http.Response {
        const self: *Network = @ptrCast(@alignCast(ctx));
        if (!self.proving) return helpers.Network.send(&self.base, allocator, request);
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        self.requests += 1;
        if (self.failure_at == self.requests) return self.failure;
        var parsed = try std.json.parseFromSlice(rpc.Value, allocator, request.body.?, .{});
        defer parsed.deinit();
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        const params = try rpc.field(parsed.value, "params");
        const id = try rpc.integer(i64, try rpc.field(parsed.value, "id"));
        var result: []u8 = undefined;
        if (std.mem.eql(u8, method, "starknet_blockNumber")) {
            result = try std.fmt.allocPrint(allocator, "{d}", .{self.current_height});
        } else if (std.mem.eql(u8, method, "starknet_getBlockWithTxHashes")) {
            self.header_reads += 1;
            const height = try rpc.integer(u64, try rpc.field(try rpc.field(params, "block_id"), "block_number"));
            try std.testing.expectEqual(@as(u64, 98), height);
            result = try std.json.Stringify.valueAlloc(allocator, .{ .status = if (self.pending) "PENDING" else "ACCEPTED_ON_L2", .block_number = if (self.wrong_height) height + 1 else height, .block_hash = try Felt.init(if (self.reorg and self.header_reads > self.reorg_after) 99 else height), .parent_hash = try Felt.init(97), .timestamp = 1 }, .{});
        } else if (std.mem.eql(u8, method, "starknet_getNonce")) {
            try std.testing.expectEqual(@as(u64, 98), try rpc.integer(u64, try rpc.field(try rpc.field(params, "block_id"), "block_number")));
            try std.testing.expectEqual(@as(u256, 4), (try provider.felt(try rpc.field(params, "contract_address"))).value);
            result = try std.json.Stringify.valueAlloc(allocator, self.nonce, .{});
        } else if (std.mem.eql(u8, method, "starknet_getTransactionReceipt")) {
            try std.testing.expectEqual(self.base.hash.value, (try provider.felt(try rpc.field(params, "transaction_hash"))).value);
            if (!self.receipt_present) return .{ .allocator = allocator, .status = 200, .bytes = try std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .@"error" = .{ .code = 29, .message = "not found" } }, .{}) };
            result = try allocator.dupe(u8, "{\"finality_status\":\"RECEIVED\"}");
        } else if (std.mem.eql(u8, method, "starknet_call")) {
            try std.testing.expectEqual(@as(u64, 98), try rpc.integer(u64, try rpc.field(try rpc.field(params, "block_id"), "block_number")));
            const call = try rpc.field(params, "request");
            if (self.announcement_mode) {
                try std.testing.expectEqual(@as(u256, 6), (try provider.felt(try rpc.field(call, "contract_address"))).value);
                try std.testing.expectEqual(codec.selector("get_announced_storage_locations").value, (try provider.felt(try rpc.field(call, "entry_point_selector"))).value);
                var encoder: codec.Encoder = .{ .allocator = allocator };
                defer encoder.deinit();
                try encoder.integer(1);
                try encoder.integer(@as(u8, if (self.present_location == null) 0 else 1));
                if (self.present_location) |location| try encoder.longString(location);
                result = try std.json.Stringify.valueAlloc(allocator, encoder.items.items, .{});
            } else {
                try std.testing.expectEqual(@as(u256, 2), (try provider.felt(try rpc.field(call, "contract_address"))).value);
                try std.testing.expectEqual(codec.selector("delivered").value, (try provider.felt(try rpc.field(call, "entry_point_selector"))).value);
                result = try allocator.dupe(u8, if (self.delivered) "[\"0x1\"]" else "[\"0x0\"]");
            }
        } else return error.UnexpectedNonceProofMethod;
        defer allocator.free(result);
        return .{ .allocator = allocator, .status = 200, .bytes = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, result }) };
    }
    fn reset(self: *Network) void {
        self.requests = 0;
        self.header_reads = 0;
        self.proving = true;
    }
};
const Journal = struct {
    fn intent(_: *anyopaque, _: types.Hash, _: []const u8) !void {}
    fn signed(_: *anyopaque, _: types.Hash, _: types.Identity, _: []const u8) !void {}
    fn interface(self: *Journal) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed };
    }
};
const Fixture = struct {
    native: crypto.Crypto,
    local: tx.LocalSigner,
    signer: helpers.CountSigner,
    network: Network = .{},
    client: provider.Provider,
    destination: backend.Starknet,
    env: std.process.EnvMap,
    resources: @import("../chain_source.zig").Resources,
    factory: Factory.Factory,
    cancel: std.atomic.Value(bool) = .init(false),
    fn init() !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        const path = try helpers.nativePath(a);
        defer a.free(path);
        self.* = undefined;
        self.native = try crypto.Crypto.init(a, path);
        errdefer self.native.deinit();
        self.local = .{ .crypto = &self.native, .secret = .{0} ** 31 ++ .{17} };
        self.signer = .{ .actual = try self.local.interface() };
        self.network = .{};
        self.client = .{ .allocator = a, .client = try rpc.Client.init(a, .{ .context = &self.network, .send_fn = Network.send }, &.{.{ .url = "https://fixture/rpc" }}, .{}) };
        self.destination = .{ .chain = .{ .provider = &self.client, .mailbox = try Felt.init(2), .hook = try Felt.init(3), .domain = 200 }, .native = &self.native, .signer = self.signer.interface(), .account = try Felt.init(4), .chain_id = try Felt.init(1), .encoding = .modern, .reorg = .{ .blocks = 2 }, .maximum_fee = 1000, .announce = try Felt.init(6) };
        self.env = .init(a);
        var chain: @import("../../settings/types.zig").Chain = undefined;
        chain.name = "starknet-fixture";
        chain.protocol = .starknet;
        chain.domain = 200;
        chain.chain_id = "0x1";
        chain.contracts = .{ .mailbox = (try Felt.init(2)).toBytes(), .merkle_tree_hook = (try Felt.init(3)).toBytes(), .interchain_gas_paymaster = @splat(0), .validator_announce = (try Felt.init(6)).toBytes() };
        self.resources = .{ .allocator = a, .arena = .init(a), .chain = chain, .options = .{ .curl_library = "unused" }, .environment = &self.env, .http = .init(a) };
        self.factory = .{ .allocator = a, .arena = .init(a), .resources = &self.resources, .backend_ready = true, .chain_checked = true, .options = .{ .allow_fixture_transport = true, .origin_bindings = &.{ .{ .domain = 100, .hook = .{3} ** 32 }, .{ .domain = 101, .hook = .{3} ** 32 } } }, .backend = .{ .starknet = self.destination } };
        self.cancel = .init(false);
        self.network.cancel = &self.cancel;
        return self;
    }
    fn deinit(self: *Fixture) void {
        self.factory.arena.deinit();
        self.resources.arena.deinit();
        self.resources.http.deinit();
        self.env.deinit();
        self.local.deinit();
        self.native.deinit();
        a.destroy(self);
    }
    fn scalar(self: *Fixture) !types.Prepared {
        var input = try helpers.scalar(a, &self.destination, 0, 1);
        defer input.deinit();
        var body = input.body;
        const nonce = try std.json.Stringify.valueAlloc(a, saved_nonce, .{});
        defer a.free(nonce);
        var parsed = try std.json.parseFromSlice(rpc.Value, a, nonce, .{});
        defer parsed.deinit();
        try body.object.getPtr("transaction").?.object.put("nonce", parsed.value);
        const bytes = try std.json.Stringify.valueAlloc(a, body, .{});
        defer a.free(bytes);
        return types.Prepared.init(a, input.authority, bytes, input.gas_limit, input.estimated_cost);
    }
    fn clock(self: *Fixture) !Factory.Clock {
        return .{ .unix_ms = 1000, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 10 * std.time.ns_per_s, .cancel = &self.cancel };
    }
};

test "Starknet nonce proof actual SDK saved full width scalar and group same finalized height" {
    const f = try Fixture.init();
    defer f.deinit();
    var scalar = try f.scalar();
    defer scalar.deinit();
    var journal: Journal = .{};
    var signed = try f.destination.sign(&scalar, journal.interface());
    defer signed.deinit();
    f.network.base.hash = try Felt.fromBytes(signed.identity.hash256);
    f.network.reset();
    const count = f.signer.count;
    const proof = (try f.factory.retirementProof(&scalar, &signed, try f.clock())).?;
    try std.testing.expect(proof.absence_checked);
    try std.testing.expectEqual(saved_nonce.toBytes(), proof.nonce_boundary.?);
    try std.testing.expectEqual(f.network.nonce.toBytes(), proof.nonce_observed.?);
    try std.testing.expectEqual(@as(u64, 98), proof.finalized_height);
    try std.testing.expectEqual(@as(u64, 0), proof.boundary);
    try std.testing.expectEqual(@as(u64, 0), proof.observed);
    try std.testing.expectEqual(@as(usize, 6), f.network.requests);
    try std.testing.expectEqual(count, f.signer.count);
    f.network.delivered = true;
    f.network.reset();
    try std.testing.expect(try f.factory.retirementProof(&scalar, &signed, try f.clock()) == null);
    f.network.reset();
    const consumed = (try f.factory.starknetConsumedNonceProof(&scalar, &signed, try f.clock())).?;
    try std.testing.expect(!consumed.absence_checked);
    f.network.reset();
    try std.testing.expect(try f.factory.starknetNonceRetirementAt(&scalar, &signed, consumed, try f.clock()) == null);
    f.network.delivered = false;
    f.network.reset();
    _ = (try f.factory.starknetNonceRetirementAt(&scalar, &signed, consumed, try f.clock())).?;
    for (0..4) |mutation| {
        var changed = consumed;
        switch (mutation) {
            0 => changed.nonce_account = (try Felt.init(9)).toBytes(),
            1 => changed.nonce_boundary = (try Felt.init(5)).toBytes(),
            2 => changed.nonce_observed = (try Felt.init(6)).toBytes(),
            3 => changed.finalized_block_hash = (try Felt.init(99)).toBytes(),
            else => unreachable,
        }
        f.network.reset();
        try std.testing.expectError(error.InvalidStarknetNonceProof, f.factory.starknetNonceRetirementAt(&scalar, &signed, changed, try f.clock()));
    }
    var future = consumed;
    future.finalized_height = 99;
    f.network.reset();
    try std.testing.expect(try f.factory.starknetNonceRetirementAt(&scalar, &signed, future, try f.clock()) == null);

    // Actual batch manifest/outer authorities share signed bytes but preserve
    // per-member intent/generation binding in their individual absence proof.
    f.network.proving = false;
    var second = try helpers.scalar(a, &f.destination, 1, 3);
    defer second.deinit();
    var batch = try f.destination.prepareBatch(&.{ &scalar, &second }, 2);
    defer batch.deinit();
    var group_signed = try f.destination.sign(&batch.members[0], journal.interface());
    defer group_signed.deinit();
    f.network.base.hash = try Felt.fromBytes(group_signed.identity.hash256);
    f.network.reset();
    const group = (try f.factory.starknetConsumedNonceProof(&batch.members[0], &group_signed, try f.clock())).?;
    f.network.reset();
    const member = (try f.factory.starknetNonceRetirementAt(&batch.members[1], &group_signed, group, try f.clock())).?;
    try std.testing.expectEqual(batch.members[1].digest(), member.intent_digest);
    try std.testing.expectEqual(batch.members[1].authority.generation, member.generation);
    try std.testing.expectEqual(group.finalized_block_hash, member.finalized_block_hash);
    try std.testing.expect(member.absence_checked);
}

test "Starknet nonce proof pending receipt equal lower noncanonical control and authority never retire" {
    const f = try Fixture.init();
    defer f.deinit();
    var scalar = try f.scalar();
    defer scalar.deinit();
    var journal: Journal = .{};
    var signed = try f.destination.sign(&scalar, journal.interface());
    defer signed.deinit();
    f.network.base.hash = try Felt.fromBytes(signed.identity.hash256);
    for ([_]Felt{ saved_nonce, .{ .value = saved_nonce.value - 1 } }) |nonce| {
        f.network.nonce = nonce;
        f.network.reset();
        try std.testing.expect(try f.factory.retirementProof(&scalar, &signed, try f.clock()) == null);
    }
    f.network.nonce.value = saved_nonce.value + 1;
    f.network.receipt_present = true;
    f.network.reset();
    try std.testing.expect(try f.factory.retirementProof(&scalar, &signed, try f.clock()) == null);
    f.network.receipt_present = false;
    f.network.pending = true;
    f.network.reset();
    try std.testing.expect(try f.factory.retirementProof(&scalar, &signed, try f.clock()) == null);
    f.network.pending = false;
    f.network.reorg = true;
    f.network.reset();
    try std.testing.expectError(error.NoncanonicalStarknetReceipt, f.factory.retirementProof(&scalar, &signed, try f.clock()));
    f.network.reorg = false;
    f.network.wrong_height = true;
    f.network.reset();
    try std.testing.expectError(error.WrongStarknetBlock, f.factory.retirementProof(&scalar, &signed, try f.clock()));
    f.network.wrong_height = false;
    for ([_]anyerror{ error.PendingReadIo, error.RequestCancelled, error.RequestDeadlineExceeded, error.OutOfMemory }) |err| {
        f.network.reset();
        f.network.failure_at = 3;
        f.network.failure = err;
        try std.testing.expectError(err, f.factory.retirementProof(&scalar, &signed, try f.clock()));
    }
    f.network.failure_at = null;
    f.network.reset();
    f.factory.backend.starknet.account = try Felt.init(9);
    try std.testing.expectError(error.DestinationIntentChanged, f.factory.retirementProof(&scalar, &signed, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    f.factory.backend.starknet.account = f.destination.account;
    var foreign = scalar.authority;
    foreign.chain_id = "0x2";
    const body = try std.json.Stringify.valueAlloc(a, scalar.body, .{});
    defer a.free(body);
    var wrong_chain = try types.Prepared.init(a, foreign, body, scalar.gas_limit, scalar.estimated_cost);
    defer wrong_chain.deinit();
    try std.testing.expectError(error.DestinationAuthorityMismatch, f.factory.retirementProof(&wrong_chain, &signed, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    var wrong = signed;
    wrong.identity.hash256[31] ^= 1;
    try std.testing.expectError(error.DestinationIntentChanged, f.factory.retirementProof(&scalar, &wrong, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    const padded = try std.fmt.allocPrint(a, "{s} ", .{signed.bytes});
    defer a.free(padded);
    var noncanonical = try types.Signed.init(a, signed.identity, padded);
    defer noncanonical.deinit();
    try std.testing.expectError(error.DestinationIntentChanged, f.factory.retirementProof(&scalar, &noncanonical, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    f.cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, f.factory.retirementProof(&scalar, &signed, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
}

test "Starknet nonce proof scalar SDK calldata binds process target selector message and origin" {
    const f = try Fixture.init();
    defer f.deinit();
    var scalar = try f.scalar();
    defer scalar.deinit();
    var journal: Journal = .{};
    const wire = try std.json.Stringify.valueAlloc(a, scalar.body, .{});
    defer a.free(wire);
    for (0..4) |mutation| {
        var body = try std.json.parseFromSlice(rpc.Value, a, wire, .{});
        defer body.deinit();
        var authority = scalar.authority;
        if (mutation < 2) {
            var value = try std.json.parseFromSlice(rpc.Value, a, "\"0x7\"", .{});
            defer value.deinit();
            body.value.object.getPtr("transaction").?.object.getPtr("calldata").?.array.items[mutation + 1] = value.value;
            const changed = try std.json.Stringify.valueAlloc(a, body.value, .{});
            defer a.free(changed);
            var prepared = try types.Prepared.init(a, authority, changed, scalar.gas_limit, scalar.estimated_cost);
            defer prepared.deinit();
            var signed = try f.destination.sign(&prepared, journal.interface());
            defer signed.deinit();
            f.network.base.hash = try Felt.fromBytes(signed.identity.hash256);
            f.network.reset();
            try std.testing.expectError(error.DestinationIntentChanged, f.factory.retirementProof(&prepared, &signed, try f.clock()));
        } else {
            if (mutation == 2) authority.operation_id[31] ^= 1 else authority.origin = 101;
            var prepared = try types.Prepared.init(a, authority, wire, scalar.gas_limit, scalar.estimated_cost);
            defer prepared.deinit();
            var signed = try f.destination.sign(&prepared, journal.interface());
            defer signed.deinit();
            f.network.base.hash = try Felt.fromBytes(signed.identity.hash256);
            f.network.reset();
            try std.testing.expectError(error.DestinationIntentChanged, f.factory.retirementProof(&prepared, &signed, try f.clock()));
        }
        try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    }
}

fn allocationExercise(allocator: A, f: *Fixture, scalar: *const types.Prepared, signed: *const types.Signed) !void {
    f.network.reset();
    var client = f.client;
    client.allocator = allocator;
    client.client.allocator = allocator;
    var value = f.destination;
    value.chain.provider = &client;
    _ = (try value.nonceProof(scalar, signed, null, true)).?;
}
fn announcementAllocationExercise(allocator: A, f: *Fixture, prepared: *const types.Prepared, signed: *const types.Signed, expected: @import("../../storage/objects.zig").SignedAnnouncement) !void {
    f.network.reset();
    var client = f.client;
    client.allocator = allocator;
    client.client.allocator = allocator;
    var factory = f.factory;
    factory.allocator = allocator;
    factory.backend.starknet.chain.provider = &client;
    _ = (try factory.announcementRetirement(prepared, signed, expected, try f.clock())).?;
}
test "Starknet nonce proof every allocation failure preserves saved signed ownership and OOM" {
    const f = try Fixture.init();
    defer f.deinit();
    var scalar = try f.scalar();
    defer scalar.deinit();
    var journal: Journal = .{};
    var signed = try f.destination.sign(&scalar, journal.interface());
    defer signed.deinit();
    f.network.base.hash = try Felt.fromBytes(signed.identity.hash256);
    const digest = scalar.digest();
    const before = f.signer.count;
    try std.testing.checkAllAllocationFailures(a, allocationExercise, .{ f, &scalar, &signed });
    try std.testing.expectEqual(digest, scalar.digest());
    try std.testing.expectEqual(before, f.signer.count);
}

test "Starknet nonce proof announcement SDK exact signed call historical location absence and canonical fence" {
    const objects = @import("../../storage/objects.zig");
    const f = try Fixture.init();
    defer f.deinit();
    const value: objects.Announcement = .{ .validator = .{ 0x19, 0xe7, 0xe3, 0x76, 0xe7, 0xc2, 0x13, 0xb7, 0xe7, 0xe7, 0xe4, 0x6c, 0xc7, 0x0a, 0x5d, 0xd0, 0x86, 0xda, 0xff, 0x2a }, .mailbox_address = (try Felt.init(2)).toBytes(), .mailbox_domain = 200, .storage_location = "file:///public-fixture" };
    const expected = try objects.SignedAnnouncement.sign(value, @splat(0x11), @splat(0));
    const authority: types.Authority = .{ .protocol = .starknet, .kind = .announcement, .target = (try Felt.init(6)).toBytes(), .origin = 200, .destination = 200, .mailbox = value.mailbox_address, .chain_id = "0x1", .operation_id = value.digest(), .generation = 7 };
    f.network.base.expected_calls = 1;
    var prepared = try f.factory.prepareAnnouncement(authority, expected, try f.clock());
    defer prepared.deinit();
    var journal: Journal = .{};
    var signed = try f.factory.backend.starknet.sign(&prepared, journal.interface());
    defer signed.deinit();
    f.network.base.hash = try Felt.fromBytes(signed.identity.hash256);
    f.network.announcement_mode = true;
    f.network.reset();
    const before = f.signer.count;
    const proof = (try f.factory.announcementRetirement(&prepared, &signed, expected, try f.clock())).?;
    try std.testing.expect(proof.kind == .announcement and proof.absence_checked);
    try std.testing.expectEqual(authority.target, proof.target);
    try std.testing.expectEqual(@as(u64, 98), proof.finalized_height);
    try std.testing.expectEqual(before, f.signer.count);
    try std.testing.expectEqual(@as(usize, 7), f.network.requests);
    f.network.present_location = value.storage_location;
    f.network.reset();
    try std.testing.expect(try f.factory.announcementRetirement(&prepared, &signed, expected, try f.clock()) == null);
    f.network.present_location = "file:///different-location";
    f.network.reset();
    _ = (try f.factory.announcementRetirement(&prepared, &signed, expected, try f.clock())).?;
    f.network.reorg = true;
    f.network.reorg_after = 2; // Changes after the historical location query.
    f.network.reset();
    try std.testing.expectError(error.NoncanonicalStarknetReceipt, f.factory.announcementRetirement(&prepared, &signed, expected, try f.clock()));
    f.network.reorg = false;
    f.network.reset();
    var changed = expected;
    changed.value.storage_location = "file:///different-expected";
    try std.testing.expectError(error.AnnouncementAuthorityMismatch, f.factory.announcementRetirement(&prepared, &signed, changed, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    // Re-signing the outer expected Announcement cannot disguise a different
    // saved Invoke body: the actual calldata/target/selector must also match.
    changed = try objects.SignedAnnouncement.sign(changed.value, @splat(0x11), @splat(0));
    var rebound = prepared.authority;
    rebound.operation_id = changed.value.digest();
    const wire = try std.json.Stringify.valueAlloc(a, prepared.body, .{});
    defer a.free(wire);
    var mismatched = try types.Prepared.init(a, rebound, wire, prepared.gas_limit, prepared.estimated_cost);
    defer mismatched.deinit();
    try std.testing.expectError(error.AnnouncementAuthorityMismatch, f.factory.announcementRetirement(&mismatched, &signed, changed, try f.clock()));
    try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    for ([_]usize{ 1, 2 }) |position| {
        var wrong_body = try std.json.parseFromSlice(rpc.Value, a, wire, .{});
        defer wrong_body.deinit();
        var replacement = try std.json.parseFromSlice(rpc.Value, a, "\"0x7\"", .{});
        defer replacement.deinit();
        // Modern Invoke array: count, target, selector, calldata length, ...
        wrong_body.value.object.getPtr("transaction").?.object.getPtr("calldata").?.array.items[position] = replacement.value;
        const wrong_wire = try std.json.Stringify.valueAlloc(a, wrong_body.value, .{});
        defer a.free(wrong_wire);
        var wrong_call = try types.Prepared.init(a, authority, wrong_wire, prepared.gas_limit, prepared.estimated_cost);
        defer wrong_call.deinit();
        var wrong_signed = try f.factory.backend.starknet.sign(&wrong_call, journal.interface());
        defer wrong_signed.deinit();
        try std.testing.expectError(error.AnnouncementAuthorityMismatch, f.factory.announcementRetirement(&wrong_call, &wrong_signed, expected, try f.clock()));
        try std.testing.expectEqual(@as(usize, 0), f.network.requests);
    }
    f.network.failure_at = 6; // Historical announced-location call.
    for ([_]anyerror{ error.PendingReadIo, error.RequestCancelled, error.RequestDeadlineExceeded }) |err| {
        f.network.failure = err;
        f.network.reset();
        try std.testing.expectError(err, f.factory.announcementRetirement(&prepared, &signed, expected, try f.clock()));
    }
    f.network.failure_at = null;
    f.network.present_location = null;
    const count = f.signer.count;
    try std.testing.checkAllAllocationFailures(a, announcementAllocationExercise, .{ f, &prepared, &signed, expected });
    try std.testing.expectEqual(count, f.signer.count);
}
