//! Cosmos account/sequence and gas-estimation preparation. Secret keys are
//! injected only into sign(); no account discovery, secret reads or broadcasts.
//! Persist returned signed bytes + sequence before any explicit submission.
const std = @import("std");
const proto = @import("proto.zig");
const tx = @import("../altvm/cosmos.zig");
const types = @import("types.zig");
const Config = @import("config.zig").Config;
const Tendermint = @import("tendermint.zig").Client;

pub const Unsigned = struct {
    allocator: std.mem.Allocator,
    body: []u8,
    auth: []u8,
    sign_doc: []u8,
    account_number: u64,
    sequence: u64,
    gas_limit: u64,
    fee: u128,
    pub fn deinit(self: *Unsigned) void {
        self.allocator.free(self.body);
        self.allocator.free(self.auth);
        self.allocator.free(self.sign_doc);
        self.* = undefined;
    }
};
pub const Signed = struct {
    allocator: std.mem.Allocator,
    raw: []u8,
    id: [32]u8,
    sequence: u64,
    pub fn deinit(self: *Signed) void {
        self.allocator.free(self.raw);
        self.* = undefined;
    }
};
pub const Client = struct {
    allocator: std.mem.Allocator,
    rpc: *Tendermint,
    config: Config,
    signer_address: []const u8,
    public_key: [33]u8,
    address_type: tx.AccountAddressType,

    pub fn validate(self: Client) !void {
        try self.config.validate();
        if (!std.mem.eql(u8, self.rpc.chain_id, self.config.chain_id)) return error.WrongCosmosChainId;
        const expected = try tx.publicKeyAddress(self.public_key, self.address_type);
        var decoded_bytes: [32]u8 = undefined;
        const decoded = try @import("../altvm/bech32.zig").decode(self.signer_address, &decoded_bytes);
        if (decoded.bytes.len != 20) return error.WrongCosmosSigner;
        const address = try types.decodeAddress(self.signer_address, self.config.bech32_prefix);
        if (!std.mem.eql(u8, &expected, address[12..32])) return error.WrongCosmosSigner;
        if (!std.mem.allEqual(u8, address[0..12], 0)) return error.WrongCosmosSigner;
    }
    pub fn buildAt(self: Client, account: proto.BaseAccount, current_height: u64, messages: []const tx.Any, gas_limit: u64) !Unsigned {
        try self.validate();
        if (!std.mem.eql(u8, account.address, self.signer_address)) return error.WrongCosmosAccount;
        const fee = try self.config.gas_price.fee(gas_limit);
        var amount_buffer: [39]u8 = undefined;
        const amount = try std.fmt.bufPrint(&amount_buffer, "{d}", .{fee});
        const body = try tx.txBody(self.allocator, messages, "", Config.timeoutHeight(current_height));
        errdefer self.allocator.free(body);
        const auth = try tx.authInfo(self.allocator, self.public_key, account.sequence, .{ .amount = &.{.{ .denom = self.config.canonical_asset, .amount = amount }}, .gas_limit = gas_limit });
        errdefer self.allocator.free(auth);
        const sign_doc = try tx.signDoc(self.allocator, body, auth, self.config.chain_id, account.account_number);
        return .{ .allocator = self.allocator, .body = body, .auth = auth, .sign_doc = sign_doc, .account_number = account.account_number, .sequence = account.sequence, .gas_limit = gas_limit, .fee = fee };
    }
    pub fn build(self: Client, messages: []const tx.Any, gas_limit: u64) !Unsigned {
        try self.validate();
        const request = try proto.queryString(self.allocator, self.signer_address);
        defer self.allocator.free(request);
        var response = try self.rpc.abciQuery(proto.paths.account, request, null, false);
        defer response.deinit();
        const account = try proto.BaseAccount.queryResponse(response.value);
        const status = try self.rpc.status();
        if (status.catching_up) return error.CosmosNodeCatchingUp;
        return self.buildAt(account, status.height, messages, gas_limit);
    }
    pub fn estimateGas(self: Client, messages: []const tx.Any) !u64 {
        var unsigned = try self.build(messages, 0);
        defer unsigned.deinit();
        const raw = try proto.simulationTx(self.allocator, unsigned.body, unsigned.auth);
        defer self.allocator.free(raw);
        const request = try proto.simulateRequest(self.allocator, raw);
        defer self.allocator.free(request);
        var response = try self.rpc.abciQuery(proto.paths.simulate, request, null, false);
        defer response.deinit();
        return self.config.estimateGas(try proto.gasUsed(response.value));
    }
    pub fn sign(self: Client, unsigned: Unsigned, secret_key: [32]u8, noise: ?[32]u8) !Signed {
        try self.validate();
        const public_key = try tx.compressedPublicKey(secret_key);
        if (!std.mem.eql(u8, &public_key, &self.public_key)) return error.WrongCosmosSigningKey;
        const body = try proto.bytesField(unsigned.sign_doc, 1) orelse return error.InvalidCosmosSignDoc;
        const auth = try proto.bytesField(unsigned.sign_doc, 2) orelse return error.InvalidCosmosSignDoc;
        if (!std.mem.eql(u8, body, unsigned.body) or !std.mem.eql(u8, auth, unsigned.auth) or !std.mem.eql(u8, try proto.textField(unsigned.sign_doc, 3), self.config.chain_id) or try proto.uintField(unsigned.sign_doc, 4) != unsigned.account_number) return error.InvalidCosmosSignDoc;
        const signer = try proto.bytesField(auth, 1) orelse return error.InvalidCosmosSignDoc;
        if (try proto.uintField(signer, 3) != unsigned.sequence) return error.InvalidCosmosSignDoc;
        const public_any = try proto.Any.decode(try proto.bytesField(signer, 1) orelse return error.InvalidCosmosSignDoc);
        if (!std.mem.eql(u8, public_any.type_url, "/cosmos.crypto.secp256k1.PubKey") or !std.mem.eql(u8, try proto.bytesField(public_any.value, 1) orelse "", &self.public_key)) return error.InvalidCosmosSignDoc;
        const mode = try proto.bytesField(signer, 2) orelse return error.InvalidCosmosSignDoc;
        const single = try proto.bytesField(mode, 1) orelse return error.InvalidCosmosSignDoc;
        if (try proto.uintField(single, 1) != 1) return error.InvalidCosmosSignDoc;
        const fee = try proto.bytesField(auth, 2) orelse return error.InvalidCosmosSignDoc;
        if (try proto.uintField(fee, 2) != unsigned.gas_limit) return error.InvalidCosmosSignDoc;
        const coin = try proto.bytesField(fee, 1) orelse return error.InvalidCosmosSignDoc;
        if (!std.mem.eql(u8, try proto.textField(coin, 1), self.config.canonical_asset) or try std.fmt.parseInt(u128, try proto.textField(coin, 2), 10) != unsigned.fee) return error.InvalidCosmosSignDoc;
        const signature = try tx.signDirect(secret_key, unsigned.sign_doc, noise);
        const raw = try tx.txRaw(self.allocator, unsigned.body, unsigned.auth, &.{signature});
        return .{ .allocator = self.allocator, .raw = raw, .id = tx.txId(raw), .sequence = unsigned.sequence };
    }
};

test "Cosmos transaction client declarations typecheck" {
    std.testing.refAllDecls(Client);
}
