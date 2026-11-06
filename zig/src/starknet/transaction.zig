//! Starknet-rs 0.17/Accounts0.16 InvokeV3 hashing and Cairo account calldata.
//! Hash/sign primitives are injected through the vetted native crypto adapter.
const std = @import("std");
const codec = @import("codec.zig");
const crypto = @import("crypto.zig");
pub const Felt = codec.Felt;
pub const Call = struct { to: Felt, selector: Felt, calldata: []const Felt };
pub const Encoding = enum { legacy, modern };
pub const Resource = struct { max_amount: u64 = 0, max_price_per_unit: u128 = 0 };
pub const Bounds = struct { l1_gas: Resource = .{}, l2_gas: Resource = .{}, l1_data_gas: Resource = .{} };
pub const FeeEstimate = struct {
    l1_gas_consumed: u64,
    l1_gas_price: u128,
    l2_gas_consumed: u64,
    l2_gas_price: u128,
    l1_data_gas_consumed: u64,
    l1_data_gas_price: u128,
    overall_fee: u256,
    pub fn bounds(self: FeeEstimate) !Bounds {
        // SDK default is floor(as-f64 * 1.5). Exact arithmetic preserves the
        // intended factor and rejects overflow instead of Rust's saturating cast.
        return .{ .l1_gas = try padded(self.l1_gas_consumed, self.l1_gas_price), .l2_gas = try padded(self.l2_gas_consumed, self.l2_gas_price), .l1_data_gas = try padded(self.l1_data_gas_consumed, self.l1_data_gas_price) };
    }
};
fn padded(amount: u64, price: u128) !Resource {
    const a = @as(u256, amount) * 3 / 2;
    const p = @as(u256, price) * 3 / 2;
    return .{ .max_amount = std.math.cast(u64, a) orelse return error.StarknetFeeOverflow, .max_price_per_unit = std.math.cast(u128, p) orelse return error.StarknetFeeOverflow };
}
pub fn resourceBudget(bounds: Bounds) !u256 {
    var sum: u256 = 0;
    for ([_]Resource{ bounds.l1_gas, bounds.l2_gas, bounds.l1_data_gas }) |resource| sum = try std.math.add(u256, sum, try std.math.mul(u256, resource.max_amount, resource.max_price_per_unit));
    return sum;
}
pub fn encodeCalls(allocator: std.mem.Allocator, calls: []const Call, encoding: Encoding) ![]Felt {
    var encoder: codec.Encoder = .{ .allocator = allocator };
    errdefer encoder.deinit();
    try encoder.integer(calls.len);
    switch (encoding) {
        .modern => for (calls) |call| {
            try encoder.felt(call.to);
            try encoder.felt(call.selector);
            try encoder.integer(call.calldata.len);
            for (call.calldata) |value| try encoder.felt(value);
        },
        .legacy => {
            var offset: usize = 0;
            for (calls) |call| {
                try encoder.felt(call.to);
                try encoder.felt(call.selector);
                try encoder.integer(offset);
                try encoder.integer(call.calldata.len);
                offset = try std.math.add(usize, offset, call.calldata.len);
            }
            try encoder.integer(offset);
            for (calls) |call| for (call.calldata) |value| try encoder.felt(value);
        },
    }
    return encoder.finish();
}
/// The returned call array is owned; each calldata slice borrows encoded until
/// the array is retired. Reject ambiguous legacy offsets and trailing values.
pub fn decodeCalls(a: std.mem.Allocator, encoded: []const Felt, encoding: Encoding, maximum_calls: usize) ![]Call {
    for (encoded) |value| _ = try Felt.init(value.value);
    var decoder: codec.Decoder = .{ .input = encoded };
    const count = try decoder.integer(usize);
    if (count > maximum_calls) return error.StarknetCallLimit;
    const minimum = try std.math.add(usize, if (encoding == .modern) 1 else 2, try std.math.mul(usize, count, if (encoding == .modern) 3 else 4));
    if (minimum > encoded.len) return error.TruncatedCairo;
    const calls = try a.alloc(Call, count);
    errdefer a.free(calls);
    switch (encoding) {
        .modern => {
            for (calls) |*call| {
                const to = try decoder.felt();
                const selector = try decoder.felt();
                const len = try decoder.integer(usize);
                if (len > encoded.len - decoder.pos) return error.TruncatedCairo;
                call.* = .{ .to = to, .selector = selector, .calldata = encoded[decoder.pos..][0..len] };
                decoder.pos += len;
            }
            try decoder.finish();
        },
        .legacy => {
            const data_start = minimum;
            const total = try encoded[data_start - 1].integer(usize);
            if (total != encoded.len - data_start) return error.InvalidStarknetCalls;
            var expected_offset: usize = 0;
            for (calls) |*call| {
                const to = try decoder.felt();
                const selector = try decoder.felt();
                const offset = try decoder.integer(usize);
                const len = try decoder.integer(usize);
                if (offset != expected_offset or len > total - expected_offset) return error.InvalidStarknetCalls;
                call.* = .{ .to = to, .selector = selector, .calldata = encoded[data_start + offset ..][0..len] };
                expected_offset += len;
            }
            if (expected_offset != total) return error.InvalidStarknetCalls;
        },
    }
    return calls;
}
pub const Signer = struct {
    context: *anyopaque,
    public_key: Felt,
    sign_fn: *const fn (*anyopaque, Felt) anyerror!crypto.Signature,
};
pub const LocalSigner = struct {
    crypto: *crypto.Crypto,
    secret: [32]u8,
    pub fn interface(self: *LocalSigner) !Signer {
        return .{ .context = self, .public_key = try self.crypto.publicKey(self.secret), .sign_fn = LocalSigner.sign };
    }
    pub fn deinit(self: *LocalSigner) void {
        std.crypto.secureZero(u8, &self.secret);
    }
    fn sign(context: *anyopaque, digest: Felt) !crypto.Signature {
        const self: *LocalSigner = @ptrCast(@alignCast(context));
        return self.crypto.sign(self.secret, digest);
    }
};
pub const Signed = struct { hash: Felt, public_key: Felt, signature: [2]Felt, query_only: bool };
pub const Transaction = struct {
    allocator: std.mem.Allocator,
    calldata: []Felt,
    chain_id: Felt,
    sender: Felt,
    nonce: Felt,
    bounds: Bounds,
    tip: u64 = 0,
    pub fn init(a: std.mem.Allocator, chain_id: Felt, sender: Felt, nonce: Felt, bounds: Bounds, calls: []const Call, encoding: Encoding) !Transaction {
        _ = try Felt.init(chain_id.value);
        _ = try Felt.init(sender.value);
        _ = try Felt.init(nonce.value);
        return .{ .allocator = a, .calldata = try encodeCalls(a, calls, encoding), .chain_id = chain_id, .sender = sender, .nonce = nonce, .bounds = bounds };
    }
    pub fn deinit(self: *Transaction) void {
        self.allocator.free(self.calldata);
        self.* = undefined;
    }
    pub fn hash(self: Transaction, native: *crypto.Crypto, query_only: bool) !Felt {
        const fee = try native.poseidon(&.{ try Felt.init(self.tip), try resourceFelt("L1_GAS", self.bounds.l1_gas), try resourceFelt("L2_GAS", self.bounds.l2_gas), try resourceFelt("L1_DATA", self.bounds.l1_data_gas) });
        const empty = try native.poseidon(&.{});
        return native.poseidon(&.{ try codec.shortString("invoke"), try Felt.init(3 + if (query_only) @as(u256, 1) << 128 else @as(u256, 0)), self.sender, fee, empty, self.chain_id, self.nonce, Felt.zero, empty, try native.poseidon(self.calldata) });
    }
    pub fn sign(self: Transaction, native: *crypto.Crypto, signer: Signer, query_only: bool) !Signed {
        const digest = try self.hash(native, query_only);
        const sig = try signer.sign_fn(signer.context, digest);
        if (!try native.verify(signer.public_key, digest, sig)) return error.StarknetSignerMismatch;
        return .{ .hash = digest, .public_key = signer.public_key, .signature = .{ sig.r, sig.s }, .query_only = query_only };
    }
    pub fn validateSigned(self: Transaction, native: *crypto.Crypto, signed: Signed) !void {
        const digest = try self.hash(native, signed.query_only);
        if (digest.value != signed.hash.value or !try native.verify(signed.public_key, digest, .{ .r = signed.signature[0], .s = signed.signature[1] })) return error.StarknetSigningIntentChanged;
    }
    pub fn request(self: Transaction, signature: []const Felt, query_only: bool) Request {
        return .{ .version = .{ .value = 3 + if (query_only) @as(u256, 1) << 128 else @as(u256, 0) }, .sender_address = self.sender, .calldata = self.calldata, .signature = signature, .nonce = self.nonce, .resource_bounds = .{ .l1_gas = resourceJson(self.bounds.l1_gas), .l2_gas = resourceJson(self.bounds.l2_gas), .l1_data_gas = resourceJson(self.bounds.l1_data_gas) }, .tip = .{ .value = self.tip } };
    }
};
const ResourceJson = struct { max_amount: Felt, max_price_per_unit: Felt };
fn resourceJson(resource: Resource) ResourceJson {
    return .{ .max_amount = .{ .value = resource.max_amount }, .max_price_per_unit = .{ .value = resource.max_price_per_unit } };
}
pub const Request = struct {
    type: []const u8 = "INVOKE",
    version: Felt,
    sender_address: Felt,
    calldata: []const Felt,
    signature: []const Felt,
    nonce: Felt,
    resource_bounds: struct { l1_gas: ResourceJson, l2_gas: ResourceJson, l1_data_gas: ResourceJson },
    tip: Felt,
    paymaster_data: []const Felt = &.{},
    account_deployment_data: []const Felt = &.{},
    nonce_data_availability_mode: []const u8 = "L1",
    fee_data_availability_mode: []const u8 = "L1",
};
fn resourceFelt(name: []const u8, resource: Resource) !Felt {
    var bytes: [32]u8 = .{0} ** 32;
    if (name.len > 8) return error.InvalidStarknetResource;
    @memcpy(bytes[8 - name.len .. 8], name);
    std.mem.writeInt(u64, bytes[8..16], resource.max_amount, .big);
    std.mem.writeInt(u128, bytes[16..32], resource.max_price_per_unit, .big);
    return Felt.fromBytes(bytes);
}

test "Starknet account legacy and modern calldata preserve offsets and checked fee bounds" {
    const a = std.testing.allocator;
    const calls = [_]Call{ .{ .to = try Felt.init(1), .selector = try Felt.init(2), .calldata = &.{ try Felt.init(3), try Felt.init(4) } }, .{ .to = try Felt.init(5), .selector = try Felt.init(6), .calldata = &.{} } };
    const modern = try encodeCalls(a, &calls, .modern);
    defer a.free(modern);
    const legacy = try encodeCalls(a, &calls, .legacy);
    defer a.free(legacy);
    try std.testing.expectEqual(@as(usize, 9), modern.len);
    try std.testing.expectEqual(@as(usize, 12), legacy.len);
    try std.testing.expectEqual(@as(u256, 2), legacy[7].value);
    try std.testing.expectEqual(@as(u256, 2), legacy[9].value);
    const fee: FeeEstimate = .{ .l1_gas_consumed = 100, .l1_gas_price = 200, .l2_gas_consumed = 300, .l2_gas_price = 400, .l1_data_gas_consumed = 500, .l1_data_gas_price = 600, .overall_fee = 440000 };
    try std.testing.expectEqual(@as(u64, 150), (try fee.bounds()).l1_gas.max_amount);
    var overflowing = fee;
    overflowing.l1_gas_consumed = std.math.maxInt(u64);
    try std.testing.expectError(error.StarknetFeeOverflow, overflowing.bounds());
}
