//! Cosmos SIGN_MODE_DIRECT native identities, simulation, sequence and recovery.
//! Borrows concrete query/RPC clients and a digest signer; never discovers keys.
const std = @import("std");
const types = @import("types.zig");
const chain = @import("../../cosmos/contracts.zig");
const transaction = @import("../../cosmos/transactions.zig");
const sdk = @import("../../altvm/cosmos.zig");
const proto = @import("../../cosmos/proto.zig");
const pb = @import("../../altvm/protobuf.zig");
const rpc = @import("../../net/json_rpc.zig");
const json = @import("../../cosmos/types.zig");
const hex = @import("../../evm/codecs.zig");
const protocol = @import("../../protocol/root.zig");
const metadata_builder = @import("../../relayer/metadata.zig");
const objects = @import("../../storage/objects.zig");
const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
pub const Signer = struct { context: *anyopaque, public_key: [33]u8, sign_fn: *const fn (*anyopaque, [32]u8) anyerror![65]u8 };
pub const Cosmos = struct {
    queries: chain.Client,
    transactions: transaction.Client,
    mailbox: [32]u8,
    announce: [32]u8,
    native: bool,
    signer: Signer,
    maximum_fee: u128,
    maximum_gas: u64 = std.math.maxInt(u64),
    fn authority(self: *Cosmos, context: types.Authority) !void {
        if (context.protocol != (if (self.native) @import("../../settings/types.zig").Protocol.cosmosnative else .cosmos) or context.destination != self.queries.domain or !std.mem.eql(u8, &context.mailbox, &self.mailbox) or !std.mem.eql(u8, context.chain_id, self.transactions.config.chain_id) or !std.mem.eql(u8, &self.signer.public_key, &self.transactions.public_key)) return error.DestinationAuthorityMismatch;
        try context.expectTarget(if (context.kind == .process or self.native) self.mailbox else self.announce);
        try self.transactions.validate();
    }
    pub fn recipientIsm(self: *Cosmos, message: protocol.Message) ![32]u8 {
        if (!self.native) return self.queries.wasmRecipientIsm(self.mailbox, message.recipient);
        const found = try self.queries.nativeRecipientIsm(message.recipient);
        if (!std.mem.allEqual(u8, &found, 0)) return found;
        var mailbox = try self.queries.nativeMailbox(self.mailbox, null);
        defer mailbox.deinit();
        return json.hash(mailbox.value.default_ism);
    }
    pub fn metadata(self: *Cosmos, origin: anytype, module: [32]u8, message: protocol.Message) ![]u8 {
        var source: Source(@TypeOf(origin.*)) = .{ .queries = self.queries, .native = self.native, .origin = origin };
        var builder: metadata_builder.Builder(@TypeOf(source)) = .{ .allocator = self.queries.allocator, .source = &source };
        return builder.build(module, message);
    }
    pub fn delivered(self: *Cosmos, id: [32]u8) !bool {
        return if (self.native) self.queries.nativeDelivered(self.mailbox, id) else self.queries.wasmDelivered(self.mailbox, id);
    }
    pub fn prepare(self: *Cosmos, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8) !types.Prepared {
        try self.authority(context);
        try context.message(message);
        const value = if (self.native) try self.queries.encodeNativeProcess(self.mailbox, self.transactions.signer_address, message, metadata_bytes) else try self.queries.encodeWasmProcess(self.mailbox, self.transactions.signer_address, message, metadata_bytes);
        defer self.queries.allocator.free(value);
        return self.prepareAny(context, .{ .type_url = if (self.native) "/hyperlane.core.v1.MsgProcessMessage" else "/cosmwasm.wasm.v1.MsgExecuteContract", .value = value });
    }
    pub fn prepareAnnouncement(self: *Cosmos, context: types.Authority, validator: [20]u8, location: []const u8, signature: [65]u8) !types.Prepared {
        try self.authority(context);
        if (context.kind != .announcement) return error.DestinationAuthorityMismatch;
        const a = self.queries.allocator;
        var buffer: [90]u8 = undefined;
        const announcement = @import("../../cosmos/announcement.zig");
        const message = if (self.native) try announcement.native(a, self.transactions.signer_address, self.mailbox, validator, location, signature) else try announcement.wasm(a, self.transactions.signer_address, try json.contractAddress(self.transactions.config.bech32_prefix, self.announce, self.transactions.config.contract_address_bytes, &buffer), validator, location, signature);
        defer a.free(message.value);
        return self.prepareAny(context, message);
    }
    fn prepareAny(self: *Cosmos, context: types.Authority, message: sdk.Any) !types.Prepared {
        const gas = try self.transactions.estimateGas(&.{message});
        if (gas > self.maximum_gas) return error.CosmosGasCapExceeded;
        var unsigned = try self.transactions.build(&.{message}, gas);
        defer unsigned.deinit();
        return self.wrap(context, unsigned);
    }
    fn wrap(self: *Cosmos, context: types.Authority, unsigned: transaction.Unsigned) !types.Prepared {
        const a = self.queries.allocator;
        if (unsigned.fee > self.maximum_fee) return error.CosmosFeeCapExceeded;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        // Timeout height is part of body and remains immutable through recovery.
        const body = try std.json.Stringify.valueAlloc(temporary, .{ .body = try hex.hexAlloc(temporary, unsigned.body), .auth = try hex.hexAlloc(temporary, unsigned.auth), .sign_doc = try hex.hexAlloc(temporary, unsigned.sign_doc), .account_number = unsigned.account_number, .sequence = unsigned.sequence, .gas_limit = unsigned.gas_limit, .fee = unsigned.fee, .public_key = try hex.hexAlloc(temporary, &self.signer.public_key), .maximum_fee = self.maximum_fee, .maximum_gas = self.maximum_gas }, .{});
        return types.Prepared.init(a, context, body, unsigned.gas_limit, unsigned.fee);
    }
    /// Rebuild only AuthInfo/SignDoc, preserving body, sequence and timeout.
    pub fn applyGasAllowance(self: *Cosmos, prepared: *const types.Prepared, allowance: u256) !types.Prepared {
        var old = try self.restore(prepared);
        defer old.deinit();
        const gas = std.math.cast(u64, @max(allowance, old.gas_limit)) orelse return error.CosmosGasCapExceeded;
        if (gas > self.maximum_gas) return error.CosmosGasCapExceeded;
        const fee = try self.transactions.config.gas_price.fee(gas);
        if (fee > self.maximum_fee) return error.CosmosFeeCapExceeded;
        const a = self.queries.allocator;
        var amount_buffer: [39]u8 = undefined;
        const amount = try std.fmt.bufPrint(&amount_buffer, "{d}", .{fee});
        const auth = try sdk.authInfo(a, self.signer.public_key, old.sequence, .{ .amount = &.{.{ .denom = self.transactions.config.canonical_asset, .amount = amount }}, .gas_limit = gas });
        defer a.free(auth);
        const doc = try sdk.signDoc(a, old.body, auth, self.transactions.config.chain_id, old.account_number);
        defer a.free(doc);
        return self.wrap(prepared.authority, .{ .allocator = a, .body = old.body, .auth = auth, .sign_doc = doc, .account_number = old.account_number, .sequence = old.sequence, .gas_limit = gas, .fee = fee });
    }
    fn restore(self: *Cosmos, prepared: *const types.Prepared) !transaction.Unsigned {
        try prepared.validate();
        try self.authority(prepared.authority);
        const a = self.queries.allocator;
        const body = prepared.body;
        if (!std.mem.eql(u8, &try hex.fixedHex(33, try rpc.string(try rpc.field(body, "public_key"))), &self.signer.public_key) or try rpc.integer(u128, try rpc.field(body, "maximum_fee")) != self.maximum_fee or try rpc.integer(u64, try rpc.field(body, "maximum_gas")) != self.maximum_gas) return error.DestinationIntentChanged;
        const raw_body = try bytes(a, try rpc.field(body, "body"));
        errdefer a.free(raw_body);
        const auth = try bytes(a, try rpc.field(body, "auth"));
        errdefer a.free(auth);
        const sign_doc = try bytes(a, try rpc.field(body, "sign_doc"));
        errdefer a.free(sign_doc);
        const account = try rpc.integer(u64, try rpc.field(body, "account_number"));
        const sequence = try rpc.integer(u64, try rpc.field(body, "sequence"));
        const gas = try rpc.integer(u64, try rpc.field(body, "gas_limit"));
        const fee = try rpc.integer(u128, try rpc.field(body, "fee"));
        if (gas > self.maximum_gas or fee > self.maximum_fee or fee != try self.transactions.config.gas_price.fee(gas)) return error.CosmosFeeCapExceeded;
        const expected = try sdk.signDoc(a, raw_body, auth, self.transactions.config.chain_id, account);
        defer a.free(expected);
        if (!std.mem.eql(u8, expected, sign_doc)) return error.DestinationIntentChanged;
        const info = try proto.bytesField(auth, 1) orelse return error.InvalidCosmosSignDoc;
        const public = try proto.Any.decode(try proto.bytesField(info, 1) orelse return error.InvalidCosmosSignDoc);
        if (try proto.uintField(info, 3) != sequence or !std.mem.eql(u8, public.type_url, "/cosmos.crypto.secp256k1.PubKey") or !std.mem.eql(u8, try proto.bytesField(public.value, 1) orelse "", &self.signer.public_key)) return error.InvalidCosmosSignDoc;
        const mode = try proto.bytesField(info, 2) orelse return error.InvalidCosmosSignDoc;
        const single = try proto.bytesField(mode, 1) orelse return error.InvalidCosmosSignDoc;
        if (try proto.uintField(single, 1) != 1) return error.InvalidCosmosSignDoc;
        const fee_info = try proto.bytesField(auth, 2) orelse return error.InvalidCosmosSignDoc;
        const coin = try proto.bytesField(fee_info, 1) orelse return error.InvalidCosmosSignDoc;
        if (try proto.uintField(fee_info, 2) != gas or !std.mem.eql(u8, try proto.textField(coin, 1), self.transactions.config.canonical_asset) or try std.fmt.parseInt(u128, try proto.textField(coin, 2), 10) != fee) return error.InvalidCosmosSignDoc;
        return .{ .allocator = a, .body = raw_body, .auth = auth, .sign_doc = sign_doc, .account_number = account, .sequence = sequence, .gas_limit = gas, .fee = fee };
    }
    pub fn sign(self: *Cosmos, prepared: *const types.Prepared, persistence: types.Persistence) !types.Signed {
        var unsigned = try self.restore(prepared);
        defer unsigned.deinit();
        try persistence.intent(prepared);
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(unsigned.sign_doc, &digest, .{});
        const signature = try self.signer.sign_fn(self.signer.context, digest);
        if (std.mem.readInt(u256, signature[32..64], .big) > std.crypto.ecc.Secp256k1.scalar.field_order / 2) return error.HighSignatureS;
        try Ecdsa.Signature.fromBytes(signature[0..64].*).verifyPrehashed(digest, try Ecdsa.PublicKey.fromSec1(&self.signer.public_key));
        const a = self.queries.allocator;
        const raw = try sdk.txRaw(a, unsigned.body, unsigned.auth, &.{signature[0..64].*});
        defer a.free(raw);
        var signed = try types.Signed.init(a, .{ .hash256 = sdk.txId(raw) }, raw);
        errdefer signed.deinit();
        try persistence.signed(prepared, &signed);
        return signed;
    }
    pub fn validateSigned(self: *Cosmos, prepared: *const types.Prepared, signed: *const types.Signed) !void {
        if (signed.identity != .hash256 or !std.mem.eql(u8, &signed.identity.hash256, &sdk.txId(signed.bytes))) return error.WrongDestinationIdentity;
        var unsigned = try self.restore(prepared);
        defer unsigned.deinit();
        const raw_body = try proto.bytesField(signed.bytes, 1) orelse return error.InvalidCosmosSignedTransaction;
        const auth = try proto.bytesField(signed.bytes, 2) orelse return error.InvalidCosmosSignedTransaction;
        const signature = try proto.bytesField(signed.bytes, 3) orelse return error.InvalidCosmosSignedTransaction;
        if (signature.len != 64 or !std.mem.eql(u8, raw_body, unsigned.body) or !std.mem.eql(u8, auth, unsigned.auth)) return error.DestinationIntentChanged;
        const a = self.queries.allocator;
        const expected = try sdk.txRaw(a, raw_body, auth, &.{signature[0..64].*});
        defer a.free(expected);
        if (!std.mem.eql(u8, expected, signed.bytes)) return error.InvalidCosmosSignedTransaction;
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(unsigned.sign_doc, &digest, .{});
        if (std.mem.readInt(u256, signature[32..64], .big) > std.crypto.ecc.Secp256k1.scalar.field_order / 2) return error.HighSignatureS;
        try Ecdsa.Signature.fromBytes(signature[0..64].*).verifyPrehashed(digest, try Ecdsa.PublicKey.fromSec1(&self.signer.public_key));
    }
    pub fn broadcast(self: *Cosmos, prepared: *const types.Prepared, signed: *const types.Signed, persistence: types.Persistence) !void {
        try self.validateSigned(prepared, signed);
        try persistence.signed(prepared, signed);
        var response = try self.transactions.rpc.broadcastCommit(signed.bytes);
        defer response.deinit();
    }
    pub fn reconcile(self: *Cosmos, identity: types.Identity) !?types.Receipt {
        if (identity != .hash256) return error.WrongDestinationIdentity;
        // A remote error is not proof of absence; propagate and retain identity.
        var response = try self.transactions.rpc.tx(identity.hash256, false);
        defer response.deinit();
        const height = try json.uint(try json.field(response.value(), "height"));
        if (height == 0) return error.InvalidCosmosHeight;
        const reported = try json.field(response.value(), "tx_result");
        var block = try self.transactions.rpc.block(height);
        defer block.deinit();
        const hash = try json.hash(try json.string(try json.field(try json.field(block.value(), "block_id"), "hash")));
        try canonicalInclusion(self.queries.allocator, identity.hash256, response.value(), block.value());
        var results = try self.transactions.rpc.blockResults(height);
        defer results.deinit();
        const index = try json.uint(try json.field(response.value(), "index"));
        const list = try json.field(results.value(), "txs_results");
        const block_txs = try json.field(try json.field(try json.field(block.value(), "block"), "data"), "txs");
        if (list != .array or list.array.items.len != block_txs.array.items.len or index >= list.array.items.len) return error.WrongCosmosReceiptResult;
        const result = list.array.items[@intCast(index)];
        const code = try json.uint(try json.field(result, "code"));
        if (code != try json.uint(try json.field(reported, "code"))) return error.WrongCosmosReceiptResult;
        const reported_gas = reported.object.get("gas_used");
        const canonical_gas = result.object.get("gas_used");
        if ((reported_gas == null) != (canonical_gas == null)) return error.WrongCosmosReceiptResult;
        const expenditure: ?types.Expenditure = if (canonical_gas) |used| blk: {
            const gas_used = try json.uint(used);
            if (gas_used != try json.uint(reported_gas.?)) return error.WrongCosmosReceiptResult;
            const price = self.transactions.config.gas_price;
            if (price.denominator == 0) return error.InvalidDecimal;
            const tokens = @as(u512, gas_used) * price.numerator / price.denominator;
            break :blk .{ .gas_used = gas_used, .tokens_used = std.math.cast(u256, tokens) orelse return error.CosmosFeeCapExceeded };
        } else null;
        const status = try self.transactions.rpc.status();
        if (status.catching_up) return error.CosmosNodeCatchingUp;
        var again = try self.transactions.rpc.block(height);
        defer again.deinit();
        const checked_hash = try json.hash(try json.string(try json.field(try json.field(again.value(), "block_id"), "hash")));
        if (!std.mem.eql(u8, &hash, &checked_hash)) return error.NoncanonicalCosmosReceipt;
        return .{ .identity = identity, .block_hash = hash, .height = height, .success = code == 0, .finalized = height <= status.height -| self.transactions.config.confirmations, .expenditure = expenditure };
    }
};
fn canonicalInclusion(a: std.mem.Allocator, expected: [32]u8, receipt_value: rpc.Value, block: rpc.Value) !void {
    const index = try json.uint(try json.field(receipt_value, "index"));
    const transactions = try json.field(try json.field(try json.field(block, "block"), "data"), "txs");
    if (transactions != .array or index >= transactions.array.items.len) return error.WrongCosmosTxInclusion;
    const text = try json.string(transactions.array.items[@intCast(index)]);
    const decoder = std.base64.standard.Decoder;
    const length = try decoder.calcSizeForSlice(text);
    if (length == 0 or length > types.Signed.max_bytes) return error.InvalidCosmosSignedTransaction;
    const raw = try a.alloc(u8, length);
    defer a.free(raw);
    try decoder.decode(raw, text);
    if (!std.mem.eql(u8, &expected, &sdk.txId(raw))) return error.WrongCosmosTxInclusion;
}
fn bytes(a: std.mem.Allocator, value: rpc.Value) ![]u8 {
    const text = try rpc.string(value);
    if (text.len < 2 or text.len % 2 != 0 or text.len > 2 * types.Signed.max_bytes + 2) return error.InvalidCosmosIntent;
    const result = try a.alloc(u8, (text.len - 2) / 2);
    errdefer a.free(result);
    _ = try hex.decodeHex(result, text);
    return result;
}
pub fn Source(comptime Origin: type) type {
    return struct {
        pub const ModuleAddress = [32]u8;
        queries: chain.Client,
        native: bool,
        origin: *Origin,
        const Self = @This();
        pub fn moduleType(self: *Self, address: ModuleAddress) !metadata_builder.ModuleType {
            const actual = if (self.native) blk: {
                var response = try self.queries.nativeIsm(address);
                defer response.deinit();
                break :blk try chain.nativeModuleType(response.value);
            } else try self.queries.wasmModuleType(address);
            return switch (actual) {
                .unused => .unused,
                .routing => .routing,
                .aggregation => .aggregation,
                .message_id_multisig => .message_id_multisig,
                .merkle_root_multisig => .merkle_root_multisig,
                .null_metadata => .null_ism,
                .ccip_read => .ccip_read,
            };
        }
        pub fn route(self: *Self, address: ModuleAddress, message: protocol.Message) !ModuleAddress {
            if (!self.native) return self.queries.wasmRoute(address, message);
            var response = try self.queries.nativeIsm(address);
            defer response.deinit();
            return chain.nativeRoute(response.value, message.origin);
        }
        pub fn members(self: *Self, address: ModuleAddress, message: protocol.Message, comptime validators: bool) !(if (validators) metadata_builder.Members else metadata_builder.ModuleMembers(ModuleAddress)) {
            if (self.native) {
                if (!validators) return error.UnsupportedCosmosNativeAggregation;
                var response = try self.queries.nativeIsm(address);
                defer response.deinit();
                const actual = try chain.nativeMultisig(response.value);
                return .{ .addresses = try self.queries.allocator.dupe([20]u8, actual.validators[0..actual.len]), .threshold = actual.threshold };
            }
            const actual = try self.queries.wasmVerifyInfo(address, message, if (validators) .multisig else .aggregation);
            const addresses = try self.queries.allocator.alloc(if (validators) [20]u8 else ModuleAddress, actual.len);
            errdefer self.queries.allocator.free(addresses);
            for (actual.entries[0..actual.len], addresses) |entry, *out| {
                if (validators) {
                    if (!std.mem.allEqual(u8, entry[0..12], 0)) return error.InvalidCosmosValidator;
                    out.* = entry[12..32].*;
                } else out.* = entry;
            }
            return .{ .addresses = addresses, .threshold = actual.threshold };
        }
        pub fn verifyCandidate(self: *Self, address: ModuleAddress, message: protocol.Message, metadata_bytes: []const u8) !metadata_builder.Verification {
            if (self.native) return error.UnsupportedCosmosNativeAggregation;
            return .{ .valid = try self.queries.wasmVerify(address, message, metadata_bytes), .cost = null };
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

const Journal = struct {
    intents: usize = 0,
    signed: usize = 0,
    fn persistIntent(context: *anyopaque, _: [32]u8, _: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        self.intents += 1;
    }
    fn persistSigned(context: *anyopaque, _: [32]u8, identity: types.Identity, bytes_: []const u8) !void {
        const self: *Journal = @ptrCast(@alignCast(context));
        try std.testing.expect(self.intents > 0 and identity == .hash256);
        try std.testing.expectEqual(identity.hash256, sdk.txId(bytes_));
        self.signed += 1;
    }
    fn sign(context: *anyopaque, digest: [32]u8) ![65]u8 {
        const self: *Journal = @ptrCast(@alignCast(context));
        try std.testing.expect(self.intents > 0);
        return @import("../../protocol/signature.zig").signDigest(.{0x11} ** 32, digest, null);
    }
    fn interface(self: *Journal) types.Persistence {
        return .{ .context = self, .persistIntent = persistIntent, .persistSigned = persistSigned };
    }
};
const RpcFixture = struct {
    count: usize = 0,
    account: []const u8,
    simulation: []const u8,
    id: ?[32]u8 = null,
    fn exchange(context: *anyopaque, a: std.mem.Allocator, body: []const u8, _: @import("../../evm/provider.zig").Options) !@import("../../evm/provider.zig").WireResponse {
        const self: *RpcFixture = @ptrCast(@alignCast(context));
        self.count += 1;
        var parsed = try std.json.parseFromSlice(rpc.Value, a, body, .{});
        defer parsed.deinit();
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        const id = try rpc.integer(u64, try rpc.field(parsed.value, "id"));
        const bytes_ = if (std.mem.eql(u8, method, "status")) try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .node_info = .{ .network = "cosmoshub-4" }, .sync_info = .{ .latest_block_height = "42", .latest_block_hash = "11" ** 32, .catching_up = false } } }, .{}) else if (std.mem.eql(u8, method, "abci_query")) blk: {
            const is_simulation = self.count == 3;
            const raw = if (is_simulation) self.simulation else self.account;
            const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
            defer a.free(encoded);
            _ = std.base64.standard.Encoder.encode(encoded, raw);
            break :blk try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .response = .{ .code = @as(u8, 0), .height = "42", .key = "", .value = encoded } } }, .{});
        } else if (std.mem.eql(u8, method, "broadcast_tx_commit")) blk: {
            const text = try hex.hexAlloc(a, &self.id.?);
            defer a.free(text);
            break :blk try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .hash = text[2..], .height = "43", .check_tx = .{ .code = @as(u8, 0) }, .deliver_tx = .{ .code = @as(u8, 0) } } }, .{});
        } else return error.UnexpectedCosmosFixtureMethod;
        return .{ .bytes = bytes_, .len = bytes_.len };
    }
    fn unusedGrpc(_: *anyopaque, _: std.mem.Allocator, _: @import("../../cosmos/grpc.zig").Request) !@import("../../cosmos/grpc.zig").Response {
        return error.UnexpectedCosmosGrpc;
    }
};
test "Cosmos destination actual SDK account simulation DIRECT signature and native hash persist before broadcast" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const allocator = arena.allocator();
    const fixture = (try @import("../../testing/fixture.zig").parse(rpc.Value, allocator, @embedFile("../../cosmos/fixtures/sdk.json.gz"), .{})).value;
    const account_text = try rpc.string(try rpc.field(fixture, "account_response"));
    const account = try allocator.alloc(u8, account_text.len / 2);
    _ = try std.fmt.hexToBytes(account, account_text);
    const sim_text = try rpc.string(try rpc.field(fixture, "simulate_response"));
    const simulation = try allocator.alloc(u8, sim_text.len / 2);
    _ = try std.fmt.hexToBytes(simulation, sim_text);
    var script: RpcFixture = .{ .account = account, .simulation = simulation };
    var client = try @import("../../evm/provider.zig").RpcClient.init(a, "https://fixture/rpc", .{ .exchange = .{ .context = &script, .fetch_fn = RpcFixture.exchange } });
    defer client.deinit();
    var tm: @import("../../cosmos/tendermint.zig").Client = .{ .rpc_client = &client, .chain_id = "cosmoshub-4", .compat = .v037 };
    const config: @import("../../cosmos/config.zig").Config = .{ .chain_id = "cosmoshub-4", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("../../cosmos/config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 0 };
    const public = try sdk.compressedPublicKey(.{0x11} ** 32);
    var journal: Journal = .{};
    var destination: Cosmos = .{ .queries = .{ .allocator = a, .transport = .{ .context = &script, .call_fn = RpcFixture.unusedGrpc }, .config = config, .domain = 200 }, .transactions = .{ .allocator = a, .rpc = &tm, .config = config, .signer_address = try rpc.string(try rpc.field(fixture, "relayer")), .public_key = public, .address_type = .bitcoin }, .mailbox = .{2} ** 32, .announce = .{3} ** 32, .native = false, .signer = .{ .context = &journal, .public_key = public, .sign_fn = Journal.sign }, .maximum_fee = 100000 };
    const message: protocol.Message = .{ .version = 3, .origin = 100, .destination = 200, .sender = .{4} ** 32, .recipient = .{5} ** 32, .body = "fixture" };
    const context: types.Authority = .{ .protocol = .cosmos, .origin = 100, .destination = 200, .mailbox = destination.mailbox, .chain_id = "cosmoshub-4", .operation_id = message.id() };
    var prepared_value = try destination.prepare(context, message, "");
    defer prepared_value.deinit();
    try std.testing.expectEqual(@as(?u256, 246912), prepared_value.gas_limit);
    try std.testing.expectEqual(@as(?u256, 6173), prepared_value.estimated_cost);
    var allowance = try destination.applyGasAllowance(&prepared_value, 500000);
    defer allowance.deinit();
    var adjusted = try destination.restore(&allowance);
    defer adjusted.deinit();
    try std.testing.expectEqual(@as(u64, 500000), adjusted.gas_limit);
    try std.testing.expectEqual(@as(u128, 12500), adjusted.fee);
    try std.testing.expectEqualStrings(try rpc.string(try rpc.field(prepared_value.body, "body")), try rpc.string(try rpc.field(allowance.body, "body")));
    try std.testing.expectEqual(try rpc.integer(u64, try rpc.field(prepared_value.body, "sequence")), adjusted.sequence);
    try std.testing.expectEqual(@as(usize, 5), script.count); // No new sequence/timeout reads.
    var signed = try destination.sign(&prepared_value, journal.interface());
    defer signed.deinit();
    script.id = signed.identity.hash256;
    try destination.broadcast(&prepared_value, &signed, journal.interface());
    try std.testing.expectEqual(@as(usize, 2), journal.signed);
    try std.testing.expectEqual(@as(usize, 6), script.count);
    try std.testing.expectError(error.WrongDestinationIdentity, destination.reconcile(.{ .signature512 = .{0} ** 64 }));
    var wrong = context;
    wrong.destination = 201;
    try std.testing.expectError(error.DestinationAuthorityMismatch, destination.prepareAnnouncement(wrong, .{0} ** 20, "", .{0} ** 65));
}
const NoHistory = struct {
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
        return error.UnexpectedFixtureProof;
    }
};
const QueryFixture = struct {
    count: usize = 0,
    fn call(context: *anyopaque, a: std.mem.Allocator, requested: @import("../../cosmos/grpc.zig").Request) !@import("../../cosmos/grpc.zig").Response {
        const self: *QueryFixture = @ptrCast(@alignCast(context));
        self.count += 1;
        try std.testing.expectEqualStrings(proto.paths.smart_query, requested.method);
        var buffer: [128]u8 = undefined;
        var encoder: pb.Encoder = .{ .out = &buffer };
        try encoder.bytes(1, "{\"type\":\"null\"}");
        return .{ .allocator = a, .protobuf = try a.dupe(u8, buffer[0..encoder.pos]), .height = null };
    }
};
test "Cosmos destination metadata Source uses full32 module addresses and real CW query contract" {
    const a = std.testing.allocator;
    var history: NoHistory = .{};
    var script: QueryFixture = .{};
    var source: Source(NoHistory) = .{ .queries = .{ .allocator = a, .transport = .{ .context = &script, .call_fn = QueryFixture.call }, .config = .{ .chain_id = "fixture", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("../../cosmos/config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 0 }, .domain = 200 }, .native = false, .origin = &history };
    var builder: metadata_builder.Builder(@TypeOf(source)) = .{ .allocator = a, .source = &source };
    const metadata_bytes = try builder.build(.{0x11} ** 32, .{});
    defer a.free(metadata_bytes);
    try std.testing.expectEqual(@as(usize, 0), metadata_bytes.len);
    try std.testing.expectEqual(@as(usize, 1), script.count);
}

const CanonicalFixture = struct {
    raw: []const u8,
    hash: [32]u8,
    mode: enum { valid, wrong_index, absent, wrong_transaction, wrong_result, forked },
    blocks: usize = 0,
    fn exchange(context: *anyopaque, a: std.mem.Allocator, request: []const u8, _: @import("../../evm/provider.zig").Options) !@import("../../evm/provider.zig").WireResponse {
        const self: *CanonicalFixture = @ptrCast(@alignCast(context));
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request, .{});
        defer parsed.deinit();
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        const id = try rpc.integer(u64, try rpc.field(parsed.value, "id"));
        const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(self.raw.len));
        defer a.free(encoded);
        _ = std.base64.standard.Encoder.encode(encoded, self.raw);
        const hash_text = try hex.hexAlloc(a, &self.hash);
        defer a.free(hash_text);
        const wire = if (std.mem.eql(u8, method, "tx"))
            try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .hash = hash_text[2..], .height = "10", .index = @as(u32, if (self.mode == .wrong_index) 7 else 0), .tx = encoded, .tx_result = .{ .code = 1, .gas_used = "4" } } }, .{})
        else if (std.mem.eql(u8, method, "block")) blk: {
            self.blocks += 1;
            const values: []const []const u8 = if (self.mode == .absent) &.{} else if (self.mode == .wrong_transaction) &.{"AA=="} else &.{encoded};
            break :blk try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .block_id = .{ .hash = if (self.mode == .forked and self.blocks > 1) "22" ** 32 else "11" ** 32 }, .block = .{ .header = .{ .chain_id = "cosmos-fixture-1", .height = "10" }, .data = .{ .txs = values } } } }, .{});
        } else if (std.mem.eql(u8, method, "block_results"))
            try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .height = "10", .txs_results = .{.{ .code = @as(u8, if (self.mode == .wrong_result) 0 else 1), .gas_used = "4" }} } }, .{})
        else if (std.mem.eql(u8, method, "status"))
            try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .node_info = .{ .network = "cosmos-fixture-1" }, .sync_info = .{ .latest_block_height = "20", .latest_block_hash = "33" ** 32, .catching_up = false } } }, .{})
        else
            return error.UnexpectedCanonicalFixtureRpc;
        return .{ .bytes = wire, .len = wire.len };
    }
};
test "Cosmos destination receipt binds actual SDK transaction hash index and canonical block before finality or expense" {
    const a = std.testing.allocator;
    var fixture = try @import("../../testing/fixture.zig").parse(rpc.Value, a, @embedFile("../../altvm/fixtures/sdk.json.gz"), .{});
    defer fixture.deinit();
    const text = try rpc.string(try rpc.field(try rpc.field(fixture.value, "cosmos"), "raw"));
    const raw = try a.alloc(u8, text.len / 2);
    defer a.free(raw);
    _ = try std.fmt.hexToBytes(raw, text);
    const config: @import("../../cosmos/config.zig").Config = .{ .chain_id = "cosmos-fixture-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("../../cosmos/config.zig").Decimal.parse("0.25"), .gas_multiplier = 2, .confirmations = 2 };
    inline for (.{ .valid, .wrong_index, .absent, .wrong_transaction, .wrong_result, .forked }) |mode| {
        var script: CanonicalFixture = .{ .raw = raw, .hash = sdk.txId(raw), .mode = mode };
        var client = try @import("../../evm/provider.zig").RpcClient.init(a, "https://fixture/rpc", .{ .exchange = .{ .context = &script, .fetch_fn = CanonicalFixture.exchange } });
        defer client.deinit();
        var tm: @import("../../cosmos/tendermint.zig").Client = .{ .rpc_client = &client, .chain_id = config.chain_id, .compat = .v037 };
        var destination: Cosmos = .{ .queries = .{ .allocator = a, .transport = undefined, .config = config, .domain = 2 }, .transactions = .{ .allocator = a, .rpc = &tm, .config = config, .signer_address = "unused", .public_key = undefined, .address_type = .bitcoin }, .mailbox = .{0} ** 32, .announce = .{0} ** 32, .native = false, .signer = undefined, .maximum_fee = 1000 };
        if (mode == .valid) {
            const receipt = (try destination.reconcile(.{ .hash256 = script.hash })).?;
            try std.testing.expect(receipt.finalized and !receipt.success);
            try std.testing.expectEqual(@as(u256, 4), receipt.expenditure.?.gas_used);
            try std.testing.expectEqual(@as(u256, 1), receipt.expenditure.?.tokens_used);
            try std.testing.expectEqual(@as(usize, 2), script.blocks);
        } else try std.testing.expectError(if (mode == .forked) error.NoncanonicalCosmosReceipt else if (mode == .wrong_result) error.WrongCosmosReceiptResult else error.WrongCosmosTxInclusion, destination.reconcile(.{ .hash256 = script.hash }));
    }
}
