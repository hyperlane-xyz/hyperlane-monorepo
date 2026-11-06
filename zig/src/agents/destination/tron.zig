//! Actual Tron process preparation/signing/broadcast with durable mutation gates.
const std = @import("std");
const types = @import("types.zig");
const provider = @import("../../tron/provider.zig");
const contracts = @import("../../tron/contracts.zig");
const tx = @import("../../tron/transaction.zig");
const wire = @import("../../altvm/tron.zig");
const abi = @import("../../evm/codecs.zig");
const rpc = @import("../../net/json_rpc.zig");
const protocol = @import("../../protocol/root.zig");
pub const MetadataSource = contracts.Source;
pub const Tron = struct {
    chain: contracts.Contracts,
    signer: tx.Signer,
    chain_id: []const u8,
    announce: ?[20]u8 = null,
    fee_policy: tx.FeePolicy = .{},
    fn authority(self: *const Tron, context: types.Authority) !void {
        if (context.protocol != .tron or !std.mem.eql(u8, context.chain_id, self.chain_id) or context.destination != self.chain.domain or !std.mem.allEqual(u8, context.mailbox[0..12], 0) or !std.mem.eql(u8, context.mailbox[12..32], &self.chain.mailbox)) return error.DestinationAuthorityMismatch;
        _ = try self.target(context);
    }
    fn target(self: *const Tron, context: types.Authority) ![20]u8 {
        const address = if (context.kind == .process) self.chain.mailbox else self.announce orelse return error.MissingTronAnnounceContract;
        var full: [32]u8 = .{0} ** 32;
        full[12..32].* = address;
        try context.expectTarget(full);
        return address;
    }
    pub fn metadata(self: *Tron, origin: anytype, address: [20]u8, message: protocol.Message) ![]u8 {
        const Origin = @TypeOf(origin.*);
        var source: contracts.Source(Origin) = .{ .chain = self.chain, .origin = origin };
        var builder: @import("../../relayer/metadata.zig").Builder(@TypeOf(source)) = .{ .allocator = self.chain.provider.allocator, .source = &source };
        return builder.build(address, message);
    }
    pub fn prepare(self: *Tron, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8, now_ms: u64) !types.Prepared {
        try self.authority(context);
        try context.message(message);
        const a = self.chain.provider.allocator;
        const encoded_message = try message.encodeAlloc(a);
        defer a.free(encoded_message);
        const data = try abi.processCalldata(a, metadata_bytes, encoded_message);
        defer a.free(data);
        const trigger = try self.chain.provider.trigger(self.signer.address[1..21].*, self.chain.mailbox, data, 0);
        return self.prepareTrigger(context, trigger, now_ms);
    }
    pub fn prepareAnnouncement(self: *Tron, context: types.Authority, validator: [20]u8, location: []const u8, signature: [65]u8, now_ms: u64) !types.Prepared {
        try self.authority(context);
        if (context.kind != .announcement) return error.DestinationAuthorityMismatch;
        const data = try @import("../../evm/announce.zig").announceCalldata(self.chain.provider.allocator, validator, location, signature);
        defer self.chain.provider.allocator.free(data);
        const trigger = try self.chain.provider.trigger(self.signer.address[1..21].*, try self.target(context), data, 0);
        return self.prepareTrigger(context, trigger, now_ms);
    }
    fn prepareTrigger(self: *Tron, context: types.Authority, trigger: tx.Trigger, now_ms: u64) !types.Prepared {
        const a = self.chain.provider.allocator;
        const energy = try self.chain.provider.estimateEnergy(trigger);
        const price = try self.chain.provider.energyPrice();
        const block = try self.chain.provider.finalizedBlock();
        var unsigned = try tx.build(a, trigger, try tx.reference(block.number, block.id, now_ms, try self.fee_policy.fee(energy, price)));
        defer unsigned.deinit();
        return self.wrap(context, unsigned, energy, price);
    }
    fn wrap(self: *Tron, context: types.Authority, unsigned: tx.Unsigned, energy: u256, price: u256) !types.Prepared {
        const a = self.chain.provider.allocator;
        const view = try tx.decodeRaw(unsigned.raw);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const body = try std.json.Stringify.valueAlloc(allocator, .{ .raw_data = try abi.hexAlloc(allocator, unsigned.raw), .id = try abi.hexAlloc(allocator, &unsigned.id), .expiration_ms = unsigned.expiration_ms, .gas_limit = energy, .energy_price = price, .estimated_cost = view.fee_limit }, .{});
        return types.Prepared.init(a, context, body, energy, view.fee_limit);
    }
    /// Produces a new unsigned intent before staging; TAPOS/expiry stay exact.
    pub fn applyGasAllowance(self: *Tron, prepared: *const types.Prepared, allowance: u256) !types.Prepared {
        var old = try self.restoreUnsigned(prepared);
        defer old.deinit();
        const gas = @max(allowance, try rpc.integer(u256, try rpc.field(prepared.body, "gas_limit")));
        const price = try rpc.integer(u256, try rpc.field(prepared.body, "energy_price"));
        const view = try tx.decodeRaw(old.raw);
        var block_hash: [32]u8 = .{0} ** 32;
        block_hash[8..16].* = view.ref_block_hash;
        var changed = try tx.build(self.chain.provider.allocator, view.trigger, .{ .block_number = view.block_number, .block_hash = block_hash, .timestamp_ms = view.timestamp_ms, .expiration_ms = view.expiration_ms, .fee_limit = try self.fee_policy.fee(gas, price) });
        defer changed.deinit();
        return self.wrap(prepared.authority, changed, gas, price);
    }
    fn restoreUnsigned(self: *Tron, prepared: *const types.Prepared) !tx.Unsigned {
        try prepared.validate();
        try self.authority(prepared.authority);
        const a = self.chain.provider.allocator;
        const raw_hex = try rpc.string(try rpc.field(prepared.body, "raw_data"));
        if (raw_hex.len < 2 or raw_hex.len > types.Signed.max_bytes * 2 + 2) return error.InvalidSignedDestinationTransaction;
        const raw = try a.alloc(u8, (raw_hex.len - 2) / 2);
        _ = abi.decodeHex(raw, raw_hex) catch |err| {
            a.free(raw);
            return err;
        };
        errdefer a.free(raw);
        const view = try tx.decodeRaw(raw);
        const id = try abi.fixedHex(32, try rpc.string(try rpc.field(prepared.body, "id")));
        const expires = try rpc.integer(u64, try rpc.field(prepared.body, "expiration_ms"));
        if (!std.mem.eql(u8, &id, &wire.txId(raw)) or !std.mem.eql(u8, &view.trigger.owner, &self.signer.address) or !std.mem.eql(u8, view.trigger.contract[1..21], &try self.target(prepared.authority)) or expires != view.expiration_ms or view.fee_limit > self.fee_policy.max_fee_sun) return error.DestinationIntentChanged;
        return .{ .allocator = a, .raw = raw, .id = id, .owner = view.trigger.owner, .expiration_ms = expires };
    }
    pub fn sign(self: *Tron, prepared: *const types.Prepared, persistence: types.Persistence, now_ms: u64) !types.Signed {
        var intent = try self.restoreUnsigned(prepared);
        defer intent.deinit();
        try persistence.intent(prepared);
        var signed = try tx.sign(intent, self.signer, now_ms);
        defer signed.deinit();
        var owned = try types.Signed.init(self.chain.provider.allocator, .{ .hash256 = signed.id }, signed.bytes);
        errdefer owned.deinit();
        try persistence.signed(prepared, &owned);
        return owned;
    }
    pub fn validateSigned(self: *Tron, prepared: *const types.Prepared, signed: *const types.Signed) !void {
        if (signed.identity != .hash256) return error.WrongDestinationIdentity;
        var intent = try self.restoreUnsigned(prepared);
        defer intent.deinit();
        const view = try tx.decodeSigned(signed.bytes);
        if (!std.mem.eql(u8, view.raw, intent.raw)) return error.DestinationIntentChanged;
        if (!std.mem.eql(u8, &view.id, &signed.identity.hash256) or !std.mem.eql(u8, &view.view.trigger.owner, &self.signer.address) or !std.mem.eql(u8, view.view.trigger.contract[1..21], &try self.target(prepared.authority))) return error.DestinationIntentChanged;
    }
    pub fn broadcast(self: *Tron, prepared: *const types.Prepared, signed: *const types.Signed, persistence: types.Persistence, now_ms: u64) !void {
        try self.validateSigned(prepared, signed);
        const view = try tx.decodeSigned(signed.bytes);
        try persistence.signed(prepared, signed);
        const result = try self.chain.provider.broadcast(.{ .allocator = self.chain.provider.allocator, .bytes = signed.bytes, .id = view.id, .expiration_ms = view.view.expiration_ms }, now_ms);
        if (!result.accepted and result.classification != .duplicate) return error.TronBroadcastRejected;
    }
    pub fn reconcile(self: *Tron, identity: types.Identity) !?types.Receipt {
        if (identity != .hash256) return error.WrongDestinationIdentity;
        const actual = try self.chain.provider.receipt(identity.hash256) orelse return null;
        const height = actual.block_number orelse return null;
        const hash = actual.block_hash orelse return error.InvalidTronReceipt;
        const success = actual.success orelse return error.UnknownTronExecutionStatus;
        const finalized = height <= try self.chain.provider.finalizedBlockNumber();
        if (finalized) {
            const canonical = try self.chain.provider.solidBlock(height);
            if (!std.mem.eql(u8, &canonical.id, &hash)) return error.NoncanonicalTronReceipt;
        }
        return .{ .identity = identity, .block_hash = hash, .height = height, .success = success, .finalized = finalized, .expenditure = if (actual.energy_used != null and actual.energy_price != null) .{ .gas_used = actual.energy_used.?, .tokens_used = try std.math.mul(u256, actual.energy_used.?, actual.energy_price.?) } else null };
    }
};

const Journal = struct {
    intents: usize = 0,
    signed_count: usize = 0,
    signatures: usize = 0,
    fail_intent: bool = false,
    fn intent(context: *anyopaque, _: types.Hash, bytes: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        if (self.fail_intent) return error.FixtureIntentPersistenceFailed;
        try std.testing.expect(bytes.len > 0);
        self.intents += 1;
    }
    fn signed(context: *anyopaque, _: types.Hash, identity: types.Identity, bytes: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        try std.testing.expect(self.intents > 0);
        const decoded = try tx.decodeSigned(bytes);
        try std.testing.expect(identity == .hash256 and std.mem.eql(u8, &identity.hash256, &decoded.id));
        self.signed_count += 1;
    }
    fn persistence(self: *Journal) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed };
    }
    fn sign(context: *anyopaque, digest: types.Hash) !@import("../../protocol/signature.zig").Signature {
        const self: *Journal = @ptrCast(@alignCast(context));
        try std.testing.expect(self.intents > 0);
        self.signatures += 1;
        return @import("../../protocol/signature.zig").signDigest(.{0x11} ** 32, digest, null);
    }
};
test "Tron destination persists exact intent before signing and signed native identity before broadcast" {
    const a = std.testing.allocator;
    var journal: Journal = .{};
    var block_id: [32]u8 = .{0} ** 32;
    block_id[7] = 5;
    const encoded = try abi.hexAlloc(a, &block_id);
    defer a.free(encoded);
    const block = try std.json.Stringify.valueAlloc(a, .{ .blockID = encoded[2..], .block_header = .{ .raw_data = .{ .number = @as(u32, 5), .timestamp = @as(u64, 1000000) } } }, .{});
    defer a.free(block);
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &.{ .{ .method = .POST, .suffix = "/estimateenergy", .response = "{\"result\":{\"result\":true},\"energy_required\":1000}" }, .{ .method = .POST, .suffix = "/rpc", .response = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x64\"}" }, .{ .method = .POST, .suffix = "/getnowblock", .response = block }, .{ .method = .POST, .suffix = "/broadcasthex", .response = "{\"result\":true}" } } };
    var client = try provider.Provider.init(a, network.transport(), .{ .rpc_urls = &.{.{ .url = "https://fixture/rpc" }}, .wallet_urls = &.{.{ .url = "https://fixture/wallet" }}, .wallet_solidity_urls = &.{.{ .url = "https://fixture/walletsolidity" }} });
    const address = try wire.secretKeyAddress(.{0x11} ** 32);
    var destination: Tron = .{ .chain = .{ .provider = &client, .mailbox = .{2} ** 20, .hook = .{3} ** 20, .domain = 200 }, .signer = .{ .context = &journal, .address = address, .sign_fn = Journal.sign }, .chain_id = "728126428" };
    const message: protocol.Message = .{ .version = 3, .nonce = 1, .origin = 100, .destination = 200, .sender = .{4} ** 32, .recipient = .{5} ** 32, .body = "fixture" };
    var mailbox: [32]u8 = .{0} ** 32;
    mailbox[12..32].* = .{2} ** 20;
    const context: types.Authority = .{ .protocol = .tron, .origin = 100, .destination = 200, .mailbox = mailbox, .chain_id = "728126428", .operation_id = message.id() };
    var prepared = try destination.prepare(context, message, "", 1000000);
    defer prepared.deinit();
    try std.testing.expectEqual(@as(?u256, 1000), prepared.gas_limit);
    try std.testing.expectEqual(@as(?u256, 150000), prepared.estimated_cost);
    journal.fail_intent = true;
    try std.testing.expectError(error.FixtureIntentPersistenceFailed, destination.sign(&prepared, journal.persistence(), 1000000));
    try std.testing.expectEqual(@as(usize, 0), journal.signatures);
    journal.fail_intent = false;
    var signed = try destination.sign(&prepared, journal.persistence(), 1000000);
    defer signed.deinit();
    try std.testing.expectEqual(@as(usize, 1), journal.signatures);
    try std.testing.expectEqual(@as(usize, 1), journal.signed_count);
    try destination.broadcast(&prepared, &signed, journal.persistence(), 1000000);
    try std.testing.expectEqual(@as(usize, 2), journal.signed_count);
    const prior = prepared.authority.destination;
    prepared.authority.destination = 201;
    try std.testing.expectError(error.DestinationIntentChanged, destination.sign(&prepared, journal.persistence(), 1000000));
    prepared.authority.destination = prior;
    try network.expectDone();
}
