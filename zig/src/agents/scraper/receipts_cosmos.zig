//! Cosmos and CosmosNative enrichment over Tendermint tx + exact protobuf.
//! Sender/payer selection and atto-normalized fee policy follow the production
//! CosmosProvider; unsupported denominations retain its U256::MAX sentinel.
const std = @import("std");
const enrich = @import("enrichment.zig");
const src = @import("source.zig");
const common = @import("receipts_common.zig");
const json = @import("../../cosmos/types.zig");
const tm = @import("../../cosmos/tendermint.zig");
const pb = @import("../../altvm/protobuf.zig");
const proto = @import("../../cosmos/proto.zig");
const sdk = @import("../../altvm/cosmos.zig");
const V = std.json.Value;
pub const Config = struct { native: bool = false, bech32_prefix: []const u8, native_denom: []const u8, gas_denom: []const u8, native_decimals: u32 };
fn repeated(a: std.mem.Allocator, bytes: []const u8, number: u29) ![][]const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    errdefer list.deinit(a);
    var decoder: pb.Decoder = .{ .input = bytes };
    while (try decoder.next()) |field| if (field.number == number) {
        if (field.value != .bytes) return error.WrongProtobufWireType;
        if (list.items.len >= 256) return error.CosmosReceiptItemLimit;
        try list.append(a, field.value.bytes);
    };
    return list.toOwnedSlice(a);
}
const Sender = struct { address: [32]u8, nonce: u64 };
fn signer(bytes: []const u8) !Sender {
    const key = try proto.Any.decode(try proto.bytesField(bytes, 1) orelse return error.MissingCosmosSignerPublicKey);
    const raw = try proto.bytesField(key.value, 1) orelse return error.MissingCosmosSignerPublicKey;
    const kind: sdk.AccountAddressType = if (std.mem.eql(u8, key.type_url, "/cosmos.crypto.secp256k1.PubKey")) .bitcoin else if (std.mem.eql(u8, key.type_url, "/injective.crypto.v1beta1.ethsecp256k1.PubKey")) .ethereum else return error.UnsupportedCosmosSignerPublicKey;
    // The actual source's bitcoin_style converts through secp256k1 even for
    // normalized Ed25519; those keys and legacy multisig cannot produce sender.
    if (raw.len != 33) return error.InvalidCosmosSignerPublicKey;
    return .{ .address = .{0} ** 12 ++ try sdk.publicKeyAddress(raw[0..33].*, kind), .nonce = try proto.uintField(bytes, 3) };
}
fn sender(a: std.mem.Allocator, auth: []const u8, fee: []const u8, config: Config) !Sender {
    const signers = try repeated(a, auth, 1);
    defer a.free(signers);
    if (signers.len == 0) return error.MissingCosmosSigner;
    const payer = try proto.textField(fee, 3);
    if (payer.len == 0) return signer(signers[0]);
    const address = try json.decodeAddress(payer, config.bech32_prefix);
    var first_error: ?anyerror = null;
    for (signers) |bytes| {
        const candidate = signer(bytes) catch |err| {
            if (first_error == null) first_error = err;
            continue;
        };
        if (std.mem.eql(u8, &address, &candidate.address)) return candidate;
    }
    return first_error orelse error.CosmosPayerNotSigner;
}
fn price(a: std.mem.Allocator, fee: []const u8, config: Config) !u256 {
    if (config.native_decimals > 18) return error.InvalidNativeTokenDecimals;
    const coins = try repeated(a, fee, 1);
    defer a.free(coins);
    var total: u256 = 0;
    for (coins) |coin| {
        const denom = try proto.textField(coin, 1);
        if (!std.mem.eql(u8, denom, config.gas_denom)) return std.math.maxInt(u256);
        const amount = try std.fmt.parseInt(u128, try proto.textField(coin, 2), 10);
        if (std.mem.eql(u8, denom, config.native_denom)) {
            var value: u256 = amount;
            for (config.native_decimals..18) |_| value = try std.math.mul(u256, value, 10);
            total +|= value;
        }
    }
    const gas = try proto.uintField(fee, 2);
    return if (gas == 0) 0 else total / gas;
}
fn nativeRecipient(a: std.mem.Allocator, messages: []const []const u8) !?[32]u8 {
    for ([_][]const u8{ "/hyperlane.core.v1.MsgProcessMessage", "/hyperlane.warp.v1.MsgRemoteTransfer" }, 0..) |url, kind| {
        var selected: ?proto.Any = null;
        for (messages) |bytes| {
            const message = try proto.Any.decode(bytes);
            if (!std.mem.eql(u8, message.type_url, url)) continue;
            if (selected != null) return error.AmbiguousCosmosNativeRecipient;
            selected = message;
        }
        if (selected) |message| {
            if (kind == 1) return try json.hash(try proto.textField(message.value, 2));
            const text = try proto.textField(message.value, 4);
            if (text.len % 2 != 0) return error.InvalidNativeMessageHex;
            const raw = try a.alloc(u8, text.len / 2);
            defer a.free(raw);
            _ = try std.fmt.hexToBytes(raw, text);
            return (try @import("../../protocol/root.zig").Message.decode(raw)).recipient;
        }
    }
    return null;
}
fn cwRecipient(a: std.mem.Allocator, messages: []const []const u8) !?[32]u8 {
    var executions: usize = 0;
    var contract: ?[32]u8 = null;
    for (messages) |bytes| {
        const message = try proto.Any.decode(bytes);
        if (std.mem.eql(u8, message.type_url, "/cosmwasm.wasm.v1.MsgExecuteContract")) {
            executions += 1;
            contract = json.decodeAddress(try proto.textField(message.value, 2), null) catch null;
        }
    }
    if (executions == 1 and contract != null) return contract;
    for (messages) |bytes| {
        const message = try proto.Any.decode(bytes);
        if (!std.mem.eql(u8, message.type_url, "/ibc.core.channel.v1.MsgRecvPacket")) continue;
        const packet = proto.bytesField(message.value, 1) catch continue;
        const payload = proto.bytesField(packet orelse continue, 6) catch continue;
        var parsed = std.json.parseFromSlice(V, a, payload orelse continue, .{ .duplicate_field_behavior = .@"error" }) catch continue;
        defer parsed.deinit();
        if (parsed.value != .object) continue;
        var valid = true;
        for ([_][]const u8{ "amount", "denom", "memo", "receiver", "sender" }) |name| {
            const item = parsed.value.object.get(name) orelse {
                valid = false;
                break;
            };
            if (item != .string) {
                valid = false;
                break;
            }
        }
        if (valid) return json.decodeAddress(parsed.value.object.get("receiver").?.string, null) catch null;
    }
    return null;
}
pub fn decode(a: std.mem.Allocator, meta: enrich.Meta, value: V, config: Config) !enrich.OwnedTxn {
    if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0) or std.mem.allEqual(u8, &meta.tx_hash, 0)) return error.UnsupportedReceiptTransactionHash;
    if (try json.uint(try json.field(value, "height")) != meta.block_number) return error.ScraperReceiptIdentityMismatch;
    const returned = try json.hash(try json.string(try json.field(value, "hash")));
    if (!std.mem.eql(u8, &returned, meta.tx_hash[32..])) return error.ScraperReceiptIdentityMismatch;
    const encoded = try json.string(try json.field(value, "tx"));
    const decoder = std.base64.standard.Decoder;
    const raw = try a.alloc(u8, try decoder.calcSizeForSlice(encoded));
    defer a.free(raw);
    try decoder.decode(raw, encoded);
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &hash, .{});
    if (!std.mem.eql(u8, &hash, &returned)) return error.ScraperReceiptIdentityMismatch;
    const auth = try proto.bytesField(raw, 2) orelse return error.MissingCosmosAuthInfo;
    const fee = try proto.bytesField(auth, 2) orelse return error.MissingCosmosFee;
    const identity = try sender(a, auth, fee, config);
    const body = try proto.bytesField(raw, 1) orelse return error.MissingCosmosTxBody;
    const messages = try repeated(a, body, 1);
    defer a.free(messages);
    const to = if (config.native) try nativeRecipient(a, messages) else try cwRecipient(a, messages);
    const gas_price = try price(a, fee, config);
    const receipt = try json.field(value, "tx_result");
    const gas_used = try json.uint(try json.field(receipt, "gas_used"));
    return .{ .arena = std.heap.ArenaAllocator.init(a), .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = try json.uint(try json.field(receipt, "gas_wanted")), .gas_price = gas_price, .effective_gas_price = gas_price, .nonce = identity.nonce, .sender = identity.address, .recipient = to, .gas_used = gas_used, .cumulative_gas_used = gas_used } };
}
pub const Cosmos = struct {
    client: tm.Client,
    config: Config,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Cosmos) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = header };
    }
    fn budget(self: *Cosmos, deadline: u64) !void {
        if (self.client.rpc_client.options.native_transport == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        self.client.rpc_client.options.owner_deadline_ns = @min(self.client.rpc_client.options.owner_deadline_ns orelse deadline, deadline);
        self.client.rpc_client.options.timeout_ms = @min(self.client.rpc_client.options.timeout_ms, try common.milliseconds(deadline));
        self.client.rpc_client.options.connect_timeout_ms = @min(self.client.rpc_client.options.connect_timeout_ms, self.client.rpc_client.options.timeout_ms);
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *Cosmos = @ptrCast(@alignCast(context));
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
        const saved = self.client.rpc_client.options;
        defer self.client.rpc_client.options = saved;
        try self.budget(deadline);
        var response = try self.client.tx(meta.tx_hash[32..64].*, false);
        defer response.deinit();
        _ = try common.milliseconds(deadline);
        return decode(a, meta, response.value(), self.config);
    }
    fn header(context: *anyopaque, meta: enrich.Meta, deadline: u64) !src.Header {
        const self: *Cosmos = @ptrCast(@alignCast(context));
        const saved = self.client.rpc_client.options;
        defer self.client.rpc_client.options = saved;
        try self.budget(deadline);
        var response = try self.client.block(meta.block_number);
        defer response.deinit();
        const block = try @import("cosmos.zig").Adapter.decodeHeader(response.value());
        if (!std.mem.eql(u8, &block.hash, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        return block;
    }
};

test "scraper Cosmos receipt decodes independently produced SDK transaction payer sequence and denomination policy" {
    const a = std.testing.allocator;
    var fixture = try @import("../../testing/fixture.zig").parse(V, a, @embedFile("../../altvm/fixtures/sdk.json.gz"), .{});
    defer fixture.deinit();
    const cosmos = try json.field(fixture.value, "cosmos");
    const text = try json.string(try json.field(cosmos, "raw"));
    const raw = try a.alloc(u8, text.len / 2);
    defer a.free(raw);
    _ = try std.fmt.hexToBytes(raw, text);
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(raw, &hash, .{});
    const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
    defer a.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, raw);
    const hex = try json.hex(a, &hash);
    defer a.free(hex);
    const wire = try std.json.Stringify.valueAlloc(a, .{ .hash = hex, .height = "2", .tx = encoded, .tx_result = .{ .gas_wanted = "210000", .gas_used = "45678" } }, .{});
    defer a.free(wire);
    var parsed = try std.json.parseFromSlice(V, a, wire, .{});
    defer parsed.deinit();
    const config: Config = .{ .bech32_prefix = "cosmos", .native_denom = "uatom", .gas_denom = "uatom", .native_decimals = 6 };
    const meta: enrich.Meta = .{ .block_number = 2, .block_hash = .{2} ** 32, .tx_hash = .{0} ** 32 ++ hash };
    var owned = try decode(a, meta, parsed.value, config);
    defer owned.deinit();
    try std.testing.expectEqual(try json.decodeAddress(try json.string(try json.field(cosmos, "bech32")), "cosmos"), owned.value.sender);
    try std.testing.expectEqual(@as(u64, 7), owned.value.nonce);
    try std.testing.expectEqual(@as(u256, 210000), owned.value.gas_limit);
    try std.testing.expectEqual(@as(?u256, 615000000), owned.value.gas_price);
    try std.testing.expectEqual(@as(u256, 45678), owned.value.cumulative_gas_used);
    try std.testing.expectEqual(@as(?[32]u8, null), owned.value.recipient);
    var unsupported = config;
    unsupported.gas_denom = "other";
    var max = try decode(a, meta, parsed.value, unsupported);
    defer max.deinit();
    try std.testing.expectEqual(@as(?u256, std.math.maxInt(u256)), max.value.gas_price);
    const auth = (try proto.bytesField(raw, 2)).?;
    const fee = (try proto.bytesField(auth, 2)).?;
    var buffer: [256]u8 = undefined;
    var enc: pb.Encoder = .{ .out = &buffer };
    const signer_bytes = try repeated(a, auth, 1);
    defer a.free(signer_bytes);
    try enc.message(1, signer_bytes[0]);
    var fee_buffer: [256]u8 = undefined;
    var fee_enc: pb.Encoder = .{ .out = &fee_buffer };
    try fee_enc.raw(fee);
    try fee_enc.bytes(3, try json.string(try json.field(cosmos, "bech32")));
    const selected = try sender(a, enc.written(), fee_enc.written(), config);
    try std.testing.expectEqual(owned.value.sender, selected.address);
    fee_enc.pos = fee.len;
    var address_buffer: [100]u8 = undefined;
    const wrong = try @import("../../altvm/bech32.zig").encode("cosmos", &([_]u8{9} ** 20), &address_buffer);
    try fee_enc.bytes(3, wrong);
    try std.testing.expectError(error.CosmosPayerNotSigner, sender(a, enc.written(), fee_enc.written(), config));
}

test "scraper Cosmos recipient handles batched execution IBC packets and strict native process priority" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const contract = "neutron1jyyjd3x0jhgswgm6nnctxvzla8ypx50tew3ayxxwkrjfxhvje6kqzvzudq";
    var buffer: [1024]u8 = undefined;
    var enc: pb.Encoder = .{ .out = &buffer };
    try enc.bytes(2, contract);
    const execution = try sdk.encodeAny(a, .{ .type_url = "/cosmwasm.wasm.v1.MsgExecuteContract", .value = enc.written() });
    try std.testing.expectEqual(try json.decodeAddress(contract, null), (try cwRecipient(a, &.{execution})).?);
    try std.testing.expectEqual(@as(?[32]u8, null), try cwRecipient(a, &.{ execution, execution }));
    const payload = try std.json.Stringify.valueAlloc(a, .{ .receiver = contract, .amount = "1", .denom = "uatom", .memo = "", .sender = contract }, .{});
    enc.pos = 0;
    try enc.bytes(6, payload);
    const packet = try a.dupe(u8, enc.written());
    enc.pos = 0;
    try enc.bytes(1, packet);
    const ibc = try sdk.encodeAny(a, .{ .type_url = "/ibc.core.channel.v1.MsgRecvPacket", .value = enc.written() });
    try std.testing.expectEqual(try json.decodeAddress(contract, null), (try cwRecipient(a, &.{ibc})).?);
    const protocol = @import("../../protocol/root.zig");
    const message: protocol.Message = .{ .version = 3, .nonce = 1, .origin = 2, .sender = .{3} ** 32, .destination = 4, .recipient = .{5} ** 32, .body = "" };
    const message_raw = try message.encodeAlloc(a);
    const process = try proto.nativeProcess(a, "mailbox", "relayer", "", try json.hex(a, message_raw));
    const any = try sdk.encodeAny(a, .{ .type_url = "/hyperlane.core.v1.MsgProcessMessage", .value = process });
    try std.testing.expectEqual(message.recipient, (try nativeRecipient(a, &.{any})).?);
    try std.testing.expectError(error.AmbiguousCosmosNativeRecipient, nativeRecipient(a, &.{ any, any }));
}
