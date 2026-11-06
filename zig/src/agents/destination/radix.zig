//! Concrete Radix V2 native intents/notarization and Gateway reconciliation.
const std = @import("std");
const types = @import("types.zig");
const contracts = @import("../../radix/contracts.zig");
const provider = @import("../../radix/provider.zig");
const tx = @import("../../radix/transaction.zig");
const runtime = @import("../../radix/runtime.zig");
const crypto = @import("../../radix/crypto.zig");
const address = @import("../../radix/address.zig");
const sbor = @import("../../radix/sbor.zig");
const rpc = @import("../../net/json_rpc.zig");
const hex = @import("../../evm/codecs.zig");
const protocol = @import("../../protocol/root.zig");
const metadata_builder = @import("../../relayer/metadata.zig");
const objects = @import("../../storage/objects.zig");
pub const Signer = struct { context: *anyopaque, public_key: [32]u8, key_fn: *const fn (*anyopaque, *[32]u8) anyerror!void };
pub const Radix = struct {
    chain: contracts.Client,
    chain_id: []const u8,
    announce: [30]u8,
    signer: Signer,
    maximum_fee: u256,
    entropy: types.Entropy = .{},
    fn authority(self: *Radix, context: types.Authority) !void {
        if (context.protocol != .radix or context.destination != self.chain.domain or !std.mem.eql(u8, context.chain_id, self.chain_id) or !std.mem.eql(u8, &context.mailbox, &address.h256(self.chain.mailbox))) return error.DestinationAuthorityMismatch;
        try context.expectTarget(address.h256(if (context.kind == .process) self.chain.mailbox else self.announce));
    }
    pub fn delivered(self: *Radix, id: [32]u8) !bool {
        return self.chain.delivered(id);
    }
    /// Source get_block_by_height uses this Gateway snapshot selector. Reading
    /// only current gateway epoch would never retire with positive confirmations.
    pub fn finalizedLedger(self: *Radix, height: u64) !provider.Ledger {
        var response = try self.chain.provider.call(self.chain.provider.gateway, "/stream/transactions", .{ .at_ledger_state = .{ .state_version = height }, .limit_per_page = @as(u8, 1) });
        defer response.deinit();
        const ledger = try rpc.field(response.value(), "ledger_state");
        if (!std.mem.eql(u8, try rpc.string(try rpc.field(ledger, "network")), self.chain.provider.network.logical_name)) return error.WrongRadixNetwork;
        const actual = try rpc.integer(u64, try rpc.field(ledger, "state_version"));
        if (actual != height) return error.WrongRadixStateVersion;
        if (try rpc.field(response.value(), "items") != .array) return error.InvalidRadixJson;
        return .{ .state_version = height, .epoch = try rpc.integer(u64, try rpc.field(ledger, "epoch")) };
    }
    pub fn recipientIsm(self: *Radix, message: protocol.Message) ![32]u8 {
        return address.h256(try self.chain.recipientIsm(try address.node(message.recipient)));
    }
    pub fn metadata(self: *Radix, origin: anytype, module: [32]u8, message: protocol.Message) ![]u8 {
        var source: Source(@TypeOf(origin.*)) = .{ .chain = self.chain, .origin = origin };
        var builder: metadata_builder.Builder(@TypeOf(source)) = .{ .allocator = self.chain.provider.allocator, .source = &source };
        return builder.build(module, message);
    }
    pub fn prepare(self: *Radix, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8) !types.Prepared {
        try self.authority(context);
        try context.message(message);
        var entropy = try self.entropy.seed();
        defer std.crypto.secureZero(u8, &entropy);
        var prepared_value = try runtime.prepareProcess(self.chain.provider, self.chain.mailbox, self.chain.domain, message, metadata_bytes, self.signer.public_key, std.mem.readInt(u64, entropy[0..8], .little));
        defer prepared_value.deinit();
        return self.wrap(context, prepared_value);
    }
    pub fn prepareAnnouncement(self: *Radix, context: types.Authority, validator: [20]u8, location: []const u8, signature: [65]u8) !types.Prepared {
        try self.authority(context);
        if (context.kind != .announcement) return error.DestinationAuthorityMismatch;
        const a = self.chain.provider.allocator;
        const ledger = try self.chain.provider.gatewayState();
        const call = try @import("../../radix/announcement.zig").call(a, self.announce, validator, location, signature);
        defer a.free(call.args);
        const preview_instructions = try tx.instructions(a, null, 0, &.{call});
        defer a.free(preview_instructions);
        var entropy = try self.entropy.seed();
        defer std.crypto.secureZero(u8, &entropy);
        const header: tx.Header = .{ .network_id = self.chain.provider.network.id, .epoch = ledger.epoch, .discriminator = std.mem.readInt(u64, entropy[0..8], .little), .notary_key = self.signer.public_key };
        var preview_value = try tx.prepare(a, header, preview_instructions);
        defer preview_value.deinit();
        var response = try self.chain.provider.preview(preview_value);
        defer response.deinit();
        const receipt = try rpc.field(response.value(), "receipt");
        if (!std.mem.eql(u8, try rpc.string(try rpc.field(receipt, "status")), "Succeeded")) return error.RadixPreviewFailed;
        const locked = try runtime.lockedFee(receipt);
        if (@as(u256, @intCast(locked)) > self.maximum_fee) return error.RadixFeeCapExceeded;
        const final_instructions = try tx.instructions(a, crypto.account(self.signer.public_key), locked, &.{call});
        defer a.free(final_instructions);
        var final = try tx.prepare(a, header, final_instructions);
        defer final.deinit();
        return self.wrap(context, final);
    }
    fn wrap(self: *Radix, context: types.Authority, transaction: tx.Prepared) !types.Prepared {
        const a = self.chain.provider.allocator;
        var response = try self.chain.provider.preview(transaction);
        defer response.deinit();
        const receipt = try rpc.field(response.value(), "receipt");
        if (!std.mem.eql(u8, try rpc.string(try rpc.field(receipt, "status")), "Succeeded")) return error.RadixPreviewFailed;
        const summary = try rpc.field(receipt, "fee_summary");
        const json = @import("../../cosmos/types.zig");
        const gas = try std.math.add(u64, try json.uint(try rpc.field(summary, "execution_cost_units_consumed")), try json.uint(try rpc.field(summary, "finalization_cost_units_consumed")));
        const fee = try runtime.lockedFee(receipt);
        if (fee < 0 or @as(u256, @intCast(fee)) > self.maximum_fee) return error.RadixFeeCapExceeded;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        const body = try std.json.Stringify.valueAlloc(temporary, .{ .network_id = transaction.header.network_id, .epoch = transaction.header.epoch, .discriminator = transaction.header.discriminator, .tip_basis_points = transaction.header.tip_basis_points, .notary_key = try hex.hexAlloc(temporary, &self.signer.public_key), .instructions = try hex.hexAlloc(temporary, transaction.manifest_instructions), .maximum_fee = self.maximum_fee, .gas_limit = gas, .estimated_fee = fee }, .{});
        return types.Prepared.init(a, context, body, gas, @intCast(fee));
    }
    fn restore(self: *Radix, prepared: *const types.Prepared) !tx.Prepared {
        try prepared.validate();
        try self.authority(prepared.authority);
        const body = prepared.body;
        if (try rpc.integer(u8, try rpc.field(body, "network_id")) != self.chain.provider.network.id or !std.mem.eql(u8, &try hex.fixedHex(32, try rpc.string(try rpc.field(body, "notary_key"))), &self.signer.public_key) or try rpc.integer(u256, try rpc.field(body, "maximum_fee")) != self.maximum_fee or try rpc.integer(u256, try rpc.field(body, "estimated_fee")) > self.maximum_fee) return error.DestinationIntentChanged;
        const instructions = try decode(self.chain.provider.allocator, try rpc.string(try rpc.field(body, "instructions")));
        defer self.chain.provider.allocator.free(instructions);
        return tx.prepare(self.chain.provider.allocator, .{ .network_id = self.chain.provider.network.id, .epoch = try rpc.integer(u64, try rpc.field(body, "epoch")), .discriminator = try rpc.integer(u64, try rpc.field(body, "discriminator")), .notary_key = self.signer.public_key, .tip_basis_points = try rpc.integer(u32, try rpc.field(body, "tip_basis_points")) }, instructions);
    }
    pub fn sign(self: *Radix, prepared: *const types.Prepared, persistence: types.Persistence) !types.Signed {
        var unsigned = try self.restore(prepared);
        defer unsigned.deinit();
        try persistence.intent(prepared);
        var key: [32]u8 = undefined;
        try self.signer.key_fn(self.signer.context, &key);
        defer std.crypto.secureZero(u8, &key);
        var transaction = try tx.notarize(self.chain.provider.allocator, unsigned, key);
        defer transaction.deinit();
        var signed = try types.Signed.init(self.chain.provider.allocator, .{ .hash256 = transaction.intent_hash }, transaction.raw);
        errdefer signed.deinit();
        try persistence.signed(prepared, &signed);
        return signed;
    }
    pub fn validateSigned(self: *Radix, prepared: *const types.Prepared, signed: *const types.Signed) ![32]u8 {
        if (signed.identity != .hash256 or signed.bytes.len < 64) return error.WrongDestinationIdentity;
        var unsigned = try self.restore(prepared);
        defer unsigned.deinit();
        if (!std.mem.eql(u8, &signed.identity.hash256, &unsigned.intent_hash)) return error.DestinationIntentChanged;
        const signature = signed.bytes[signed.bytes.len - 64 ..][0..64].*;
        try crypto.verify(self.signer.public_key, unsigned.signed_intent_hash, signature);
        var writer: sbor.Writer = .{ .allocator = self.chain.provider.allocator };
        defer writer.deinit();
        try writer.raw(&.{ 0x4d, 0x22, 12, 2, 0x21 });
        try writer.raw(unsigned.signed_intent[3..]);
        const offset = writer.list.items.len;
        try writer.enumeration(1, 1);
        try writer.tuple(1);
        try writer.bytes(&signature);
        if (!std.mem.eql(u8, writer.list.items, signed.bytes)) return error.InvalidRadixSignedTransaction;
        const notarized_hash = crypto.hashParts(&.{ &.{ 0x54, 12 }, &unsigned.signed_intent_hash, &crypto.hash(writer.list.items[offset + 1 ..]) });
        return notarized_hash;
    }
    pub fn broadcast(self: *Radix, prepared: *const types.Prepared, signed: *const types.Signed, persistence: types.Persistence) !void {
        const notarized_hash = try self.validateSigned(prepared, signed);
        var unsigned = try self.restore(prepared);
        defer unsigned.deinit();
        const ledger = try self.chain.provider.gatewayState();
        if (ledger.epoch >= unsigned.end_epoch_exclusive) return error.RadixIntentExpired;
        try persistence.signed(prepared, signed);
        _ = try self.chain.provider.submit(.{ .allocator = self.chain.provider.allocator, .raw = signed.bytes, .intent_hash = unsigned.intent_hash, .notarized_hash = notarized_hash });
    }
    pub fn reconcile(self: *Radix, identity: types.Identity) !?types.Receipt {
        if (identity != .hash256) return error.WrongDestinationIdentity;
        const status = try self.chain.provider.status(identity.hash256);
        if (status.status != .committed_success and status.status != .committed_failure) return null;
        var details = try self.chain.provider.committed(identity.hash256);
        defer details.deinit();
        const transaction = try rpc.field(details.value(), "transaction");
        const state = try @import("../../cosmos/types.zig").uint(try rpc.field(transaction, "state_version"));
        if (status.committed_state_version != state) return error.RadixReceiptIdentityMismatch;
        const expenditure: ?types.Expenditure = if (transaction.object.get("fee_paid")) |paid| blk: {
            const receipt = transaction.object.get("receipt") orelse break :blk null;
            const summary = try rpc.field(receipt, "fee_summary");
            const json = @import("../../cosmos/types.zig");
            const units = try std.math.add(u64, try json.uint(try rpc.field(summary, "execution_cost_units_consumed")), try json.uint(try rpc.field(summary, "finalization_cost_units_consumed")));
            const fee = try @import("../../radix/events.zig").decimalAttos(try json.string(paid));
            if (fee < 0) return error.NegativeRadixFee;
            // Preserve the Rust provider's integer price projection/floor.
            const tokens: u256 = if (units == 0) 0 else @as(u256, @intCast(fee)) / units * units;
            break :blk .{ .gas_used = units, .tokens_used = tokens };
        } else null;
        var hash: [32]u8 = undefined;
        std.mem.writeInt(u256, &hash, state, .big);
        return .{ .identity = identity, .block_hash = hash, .height = state, .success = status.status == .committed_success, .finalized = state <= try self.chain.provider.finalizedState(), .expenditure = expenditure };
    }
};
fn decode(a: std.mem.Allocator, text: []const u8) ![]u8 {
    if (text.len < 2 or text.len % 2 != 0 or text.len > types.Prepared.max_intent_bytes) return error.InvalidRadixIntent;
    const out = try a.alloc(u8, (text.len - 2) / 2);
    errdefer a.free(out);
    _ = try hex.decodeHex(out, text);
    return out;
}
pub fn Source(comptime Origin: type) type {
    return struct {
        pub const ModuleAddress = [32]u8;
        chain: contracts.Client,
        origin: *Origin,
        const Self = @This();
        pub fn moduleType(self: *Self, module: ModuleAddress) !metadata_builder.ModuleType {
            return std.meta.intToEnum(metadata_builder.ModuleType, try self.chain.moduleType(try address.node(module)));
        }
        pub fn route(self: *Self, module: ModuleAddress, message: protocol.Message) !ModuleAddress {
            return address.h256(try self.chain.route(try address.node(module), message));
        }
        pub fn members(self: *Self, module: ModuleAddress, message: protocol.Message, comptime validators: bool) !(if (validators) metadata_builder.Members else metadata_builder.ModuleMembers(ModuleAddress)) {
            if (!validators) return error.UnsupportedRadixAggregation;
            const actual = try self.chain.validators(try address.node(module), message);
            return .{ .addresses = try self.chain.provider.allocator.dupe([20]u8, actual.validators[0..actual.len]), .threshold = actual.threshold };
        }
        pub fn verifyCandidate(_: *Self, _: ModuleAddress, _: protocol.Message, _: []const u8) !metadata_builder.Verification {
            return error.UnsupportedRadixAggregation;
        }
        pub fn leafIndex(self: *Self, id: [32]u8) !?u32 {
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            return self.origin.highestKnownLeafIndex();
        }
        pub fn fetchCheckpoint(self: *Self, validator: [20]u8, index: u32) !?objects.SignedCheckpoint {
            return self.origin.fetchCheckpoint(validator, index);
        }
        pub fn latestIndex(self: *Self, validator: [20]u8) !?u32 {
            return self.origin.latestIndex(validator);
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            return self.origin.proof(index, checkpoint);
        }
    };
}

test "Radix destination restores exact independent SDK intent and gates key reads and native submit" {
    const a = std.testing.allocator;
    const helper = @import("testing.zig");
    var fixture = try @import("../../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../../radix/fixtures/sdk.json.gz"), .{});
    defer fixture.deinit();
    const case = fixture.value.object.get("cases").?.array.items[0];
    const component_bytes = try helper.decode(a, fixture.value.object.get("component").?.string);
    defer a.free(component_bytes);
    const component = component_bytes[0..30].*;
    var journal: helper.Journal = .{ .seed = .{0x11} ** 32 };
    const public = try crypto.publicKey(journal.seed);
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/status/gateway-status", .response = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":100,\"epoch\":100}}" },
        .{ .method = .POST, .suffix = "/transaction/submit", .response = "{\"duplicate\":false}" },
        .{ .method = .POST, .suffix = "/status/gateway-status", .response = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":200,\"epoch\":102}}" },
    } };
    var destination: Radix = .{ .chain = .{ .provider = .{ .allocator = a, .transport = network.transport(), .core = .{ .url = "https://fixture/core" }, .gateway = .{ .url = "https://fixture/gateway" }, .network = .mainnet, .confirmations = 0 }, .mailbox = component, .domain = 2 }, .chain_id = "1", .announce = .{3} ** 30, .signer = .{ .context = &journal, .public_key = public, .key_fn = helper.Journal.key }, .maximum_fee = std.math.maxInt(u128) };
    const instructions = try helper.decode(a, case.object.get("instructions").?.string);
    defer a.free(instructions);
    const instructions_hex = try hex.hexAlloc(a, instructions);
    defer a.free(instructions_hex);
    const public_hex = try hex.hexAlloc(a, &public);
    defer a.free(public_hex);
    const body = try std.json.Stringify.valueAlloc(a, .{ .network_id = 1, .epoch = 100, .discriminator = 0, .tip_basis_points = 0, .notary_key = public_hex, .instructions = instructions_hex, .maximum_fee = destination.maximum_fee, .gas_limit = 500, .estimated_fee = 1000 }, .{});
    defer a.free(body);
    var prepared = try types.Prepared.init(a, .{ .protocol = .radix, .origin = 1, .destination = 2, .chain_id = "1", .mailbox = address.h256(component), .operation_id = .{9} ** 32 }, body, 500, 1000);
    defer prepared.deinit();
    var restored = try types.Prepared.restore(a, prepared.canonical_intent);
    defer restored.deinit();
    journal.deny_intent = true;
    try std.testing.expectError(error.FixtureIntentDenied, destination.sign(&restored, journal.persistence()));
    try std.testing.expectEqual(@as(usize, 0), journal.key_reads);
    journal.deny_intent = false;
    var signed = try destination.sign(&restored, journal.persistence());
    defer signed.deinit();
    const expected = try helper.decode(a, case.object.get("notarized").?.string);
    defer a.free(expected);
    try std.testing.expectEqualSlices(u8, expected, signed.bytes);
    const expected_id = try helper.decode(a, case.object.get("intent_hash").?.string);
    defer a.free(expected_id);
    try std.testing.expectEqualSlices(u8, expected_id, &signed.identity.hash256);
    try destination.broadcast(&restored, &signed, journal.persistence());
    signed.bytes[signed.bytes.len - 1] ^= 1;
    try std.testing.expectError(error.SignatureVerificationFailed, destination.broadcast(&restored, &signed, journal.persistence()));
    signed.bytes[signed.bytes.len - 1] ^= 1;
    try std.testing.expectError(error.RadixIntentExpired, destination.broadcast(&restored, &signed, journal.persistence()));
    try std.testing.expectEqual(@as(usize, 1), journal.key_reads);
    try std.testing.expectEqual(@as(usize, 2), journal.signed);
    try network.expectDone();
}

test "Radix destination retirement reads epoch at exact configured finalized state rather than moving gateway tip" {
    const a = std.testing.allocator;
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/stream/transactions", .request_body = "{\"at_ledger_state\":{\"state_version\":123},\"limit_per_page\":1}", .response = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":123,\"epoch\":102},\"items\":[]}" },
        .{ .method = .POST, .suffix = "/stream/transactions", .request_body = "{\"at_ledger_state\":{\"state_version\":123},\"limit_per_page\":1}", .response = "{\"ledger_state\":{\"network\":\"mainnet\",\"state_version\":122,\"epoch\":102},\"items\":[]}" },
    } };
    var destination: Radix = .{ .chain = .{ .provider = .{ .allocator = a, .transport = network.transport(), .core = .{ .url = "https://fixture/core" }, .gateway = .{ .url = "https://fixture/gateway" }, .network = .mainnet, .confirmations = 5 }, .mailbox = .{2} ** 30, .domain = 2 }, .chain_id = "1", .announce = .{3} ** 30, .signer = undefined, .maximum_fee = 1000 };
    try std.testing.expectEqual(provider.Ledger{ .state_version = 123, .epoch = 102 }, try destination.finalizedLedger(123));
    try std.testing.expectError(error.WrongRadixStateVersion, destination.finalizedLedger(123));
    try network.expectDone();
}
