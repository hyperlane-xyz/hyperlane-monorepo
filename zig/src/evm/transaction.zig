const std = @import("std");
const abi = @import("codecs.zig");
const crypto = @import("../protocol/signature.zig");
const Allocator = std.mem.Allocator;
const Bytes = std.ArrayList(u8);
pub const Hash = abi.Hash;
pub const Address = abi.Address;
pub const Signature = crypto.Signature;

pub const Legacy = struct {
    /// null selects the original six-field unprotected signing payload.
    /// Supplying a chain ID always uses EIP-155 replay protection.
    chain_id: ?u256 = null,
    nonce: u256 = 0,
    gas_price: u256,
    gas_limit: u256,
    to: ?Address,
    value: u256 = 0,
    data: []const u8 = &.{},
};

pub const AccessTuple = struct {
    address: Address,
    storage_keys: []const Hash = &.{},
};

pub const DynamicFee = struct {
    chain_id: u256,
    nonce: u256 = 0,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    to: ?Address,
    value: u256 = 0,
    data: []const u8 = &.{},
    access_list: []const AccessTuple = &.{},
};

/// Pure transaction construction; never broadcasts or fetches implicit fields.
/// Inputs borrow all dynamic fields and must remain alive through encoding.
pub const Transaction = union(enum) {
    legacy: Legacy,
    eip1559: DynamicFee,

    pub fn validate(self: Transaction) !void {
        switch (self) {
            .legacy => |tx| if (tx.chain_id) |chain| {
                // Both recovery parities must fit the EIP-155 v field.
                _ = try std.math.add(u256, try std.math.mul(u256, chain, 2), 36);
            },
            .eip1559 => |tx| if (tx.max_priority_fee_per_gas > tx.max_fee_per_gas) return error.PriorityFeeAboveMaxFee,
        }
    }

    pub fn nextNonce(self: Transaction) !u256 {
        return std.math.add(u256, switch (self) {
            .legacy => |tx| tx.nonce,
            .eip1559 => |tx| tx.nonce,
        }, 1);
    }

    /// Upper bound on native currency charged, preserving full U256 precision.
    pub fn maxCost(self: Transaction) !u256 {
        return switch (self) {
            .legacy => |tx| std.math.add(u256, try std.math.mul(u256, tx.gas_limit, tx.gas_price), tx.value),
            .eip1559 => |tx| std.math.add(u256, try std.math.mul(u256, tx.gas_limit, tx.max_fee_per_gas), tx.value),
        };
    }

    /// The bytes hashed for signing. EIP-1559 includes its 0x02 type prefix.
    pub fn unsigned(self: Transaction, allocator: Allocator) ![]u8 {
        try self.validate();
        var fields: Bytes = .empty;
        defer fields.deinit(allocator);
        try self.appendFields(allocator, &fields);
        switch (self) {
            .legacy => |tx| if (tx.chain_id) |chain| {
                try appendUint(allocator, &fields, chain);
                try appendUint(allocator, &fields, 0);
                try appendUint(allocator, &fields, 0);
            },
            .eip1559 => {},
        }
        return self.envelope(allocator, fields.items);
    }

    pub fn signingHash(self: Transaction, allocator: Allocator) !Hash {
        const bytes = try self.unsigned(allocator);
        defer allocator.free(bytes);
        var digest: Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(bytes, &digest, .{});
        return digest;
    }

    pub fn recoverSigner(self: Transaction, allocator: Allocator, signature: Signature) !Address {
        return crypto.recover(try self.signingHash(allocator), signature);
    }

    /// Accepts canonical recoverable Ethereum signatures (v=27/28, low s).
    /// A recovered address alone does not authorize a sender; callers must match
    /// it to their configured signer before submission.
    pub fn encodeSigned(self: Transaction, allocator: Allocator, signature: Signature) ![]u8 {
        _ = try self.recoverSigner(allocator, signature);
        var fields: Bytes = .empty;
        defer fields.deinit(allocator);
        try self.appendFields(allocator, &fields);
        const parity: u256 = signature[64] - 27;
        const v: u256 = switch (self) {
            .legacy => |tx| if (tx.chain_id) |chain|
                try std.math.add(u256, try std.math.add(u256, try std.math.mul(u256, chain, 2), 35), parity)
            else
                27 + parity,
            .eip1559 => parity,
        };
        try appendUint(allocator, &fields, v);
        try appendUint(allocator, &fields, std.mem.readInt(u256, signature[0..32], .big));
        try appendUint(allocator, &fields, std.mem.readInt(u256, signature[32..64], .big));
        return self.envelope(allocator, fields.items);
    }

    pub fn sign(self: Transaction, allocator: Allocator, secret_key: Hash, noise: ?Hash) !SignedTransaction {
        const digest = try self.signingHash(allocator);
        const signature = try crypto.signDigest(secret_key, digest, noise);
        const signer = try crypto.secretKeyAddress(secret_key);
        const recovered = try crypto.recover(digest, signature);
        if (!std.mem.eql(u8, &signer, &recovered)) return error.SignerMismatch;
        const bytes = try self.encodeSigned(allocator, signature);
        var hash: Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(bytes, &hash, .{});
        return .{ .allocator = allocator, .bytes = bytes, .hash = hash, .signature = signature, .signer = signer };
    }

    fn envelope(self: Transaction, allocator: Allocator, fields: []const u8) ![]u8 {
        var out: Bytes = .empty;
        errdefer out.deinit(allocator);
        switch (self) {
            .legacy => {},
            .eip1559 => try out.append(allocator, 2),
        }
        try appendList(allocator, &out, fields);
        return out.toOwnedSlice(allocator);
    }

    fn appendFields(self: Transaction, allocator: Allocator, out: *Bytes) !void {
        switch (self) {
            .legacy => |tx| {
                try appendUint(allocator, out, tx.nonce);
                try appendUint(allocator, out, tx.gas_price);
                try appendUint(allocator, out, tx.gas_limit);
                try appendBytes(allocator, out, if (tx.to) |*address| address else &.{});
                try appendUint(allocator, out, tx.value);
                try appendBytes(allocator, out, tx.data);
            },
            .eip1559 => |tx| {
                try appendUint(allocator, out, tx.chain_id);
                try appendUint(allocator, out, tx.nonce);
                try appendUint(allocator, out, tx.max_priority_fee_per_gas);
                try appendUint(allocator, out, tx.max_fee_per_gas);
                try appendUint(allocator, out, tx.gas_limit);
                try appendBytes(allocator, out, if (tx.to) |*address| address else &.{});
                try appendUint(allocator, out, tx.value);
                try appendBytes(allocator, out, tx.data);
                try appendAccessList(allocator, out, tx.access_list);
            },
        }
    }
};

pub const SignedTransaction = struct {
    allocator: Allocator,
    bytes: []u8,
    hash: Hash,
    signature: Signature,
    signer: Address,

    pub fn deinit(self: *SignedTransaction) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
};

/// RLP string/list lengths use the shortest big-endian representation.
fn appendLength(allocator: Allocator, out: *Bytes, len: usize, offset: u8) !void {
    if (len <= 55) {
        try out.append(allocator, offset + @as(u8, @intCast(len)));
    } else {
        var bytes: [@sizeOf(usize)]u8 = undefined;
        std.mem.writeInt(usize, &bytes, len, .big);
        var first: usize = 0;
        while (bytes[first] == 0) first += 1;
        try out.append(allocator, offset + 55 + @as(u8, @intCast(bytes.len - first)));
        try out.appendSlice(allocator, bytes[first..]);
    }
}

fn appendBytes(allocator: Allocator, out: *Bytes, bytes: []const u8) !void {
    if (bytes.len == 1 and bytes[0] < 0x80) {
        try out.append(allocator, bytes[0]);
    } else {
        _ = try std.math.add(usize, out.items.len, try std.math.add(usize, bytes.len, 1 + @sizeOf(usize)));
        try appendLength(allocator, out, bytes.len, 0x80);
        try out.appendSlice(allocator, bytes);
    }
}

fn appendList(allocator: Allocator, out: *Bytes, encoded_items: []const u8) !void {
    _ = try std.math.add(usize, out.items.len, try std.math.add(usize, encoded_items.len, 1 + @sizeOf(usize)));
    try appendLength(allocator, out, encoded_items.len, 0xc0);
    try out.appendSlice(allocator, encoded_items);
}

fn appendUint(allocator: Allocator, out: *Bytes, value: u256) !void {
    var bytes: [32]u8 = undefined;
    std.mem.writeInt(u256, &bytes, value, .big);
    var first: usize = 0;
    while (first < bytes.len and bytes[first] == 0) first += 1;
    try appendBytes(allocator, out, bytes[first..]);
}

fn appendAccessList(allocator: Allocator, out: *Bytes, entries: []const AccessTuple) !void {
    var list: Bytes = .empty;
    defer list.deinit(allocator);
    for (entries) |entry| {
        var tuple: Bytes = .empty;
        defer tuple.deinit(allocator);
        try appendBytes(allocator, &tuple, &entry.address);
        var keys: Bytes = .empty;
        defer keys.deinit(allocator);
        for (entry.storage_keys) |key| try appendBytes(allocator, &keys, &key);
        try appendList(allocator, &tuple, keys.items);
        try appendList(allocator, &list, tuple.items);
    }
    try appendList(allocator, out, list.items);
}

test "EIP-155 reference transaction and independent Foundry EIP-1559 vector" {
    const allocator = std.testing.allocator;
    const key: Hash = .{0x46} ** 32;
    const legacy: Transaction = .{ .legacy = .{ .chain_id = 1, .nonce = 9, .gas_price = 20_000_000_000, .gas_limit = 21_000, .to = .{0x35} ** 20, .value = 1_000_000_000_000_000_000 } };
    var signed = try legacy.sign(allocator, key, null);
    defer signed.deinit();
    const legacy_signature = (try abi.fixedHex(32, "0x28ef61340bd939bc2195fe5375678660" ++ "03e1a15d3c71ff63e1590620aa636276")) ++
        (try abi.fixedHex(32, "0x67cbe9d8997f761aecb703304b3800cc" ++ "f555c9f3dc64214b297fb1966a3b6d83")) ++ [_]u8{27};
    const reference_signed = try legacy.encodeSigned(allocator, legacy_signature);
    defer allocator.free(reference_signed);
    const encoded = try abi.hexAlloc(allocator, reference_signed);
    defer allocator.free(encoded);
    try std.testing.expectEqualStrings("0xf86c098504a817c80082520894353535" ++ "35353535353535353535353535353535" ++ "35880de0b6b3a76400008025a028ef61" ++ "340bd939bc2195fe537567866003e1a1" ++ "5d3c71ff63e1590620aa636276a067cb" ++ "e9d8997f761aecb703304b3800ccf555" ++ "c9f3dc64214b297fb1966a3b6d83", encoded);
    const dynamic: Transaction = .{ .eip1559 = .{ .chain_id = 1, .nonce = 9, .max_priority_fee_per_gas = 1_000_000_000, .max_fee_per_gas = 20_000_000_000, .gas_limit = 21_000, .to = .{0x35} ** 20, .value = 1_000_000_000_000_000_000 } };
    var typed = try dynamic.sign(allocator, key, null);
    defer typed.deinit();
    const typed_signature = (try abi.fixedHex(32, "0x4e87ced8b47d801c979c6baa52bbd78b" ++ "42c9db2515c9d1f473e06f65d49aaa90")) ++
        (try abi.fixedHex(32, "0x2357671517c59544ebd95012d1988c10" ++ "2292eb570cc840ac9af72bb4c52e5edd")) ++ [_]u8{27};
    const reference_typed = try dynamic.encodeSigned(allocator, typed_signature);
    defer allocator.free(reference_typed);
    const typed_encoded = try abi.hexAlloc(allocator, reference_typed);
    defer allocator.free(typed_encoded);
    try std.testing.expectEqualStrings("0x02f8730109843b9aca008504a817c800" ++ "82520894353535353535353535353535" ++ "3535353535353535880de0b6b3a76400" ++ "0080c080a04e87ced8b47d801c979c6b" ++ "aa52bbd78b42c9db2515c9d1f473e06f" ++ "65d49aaa90a02357671517c59544ebd9" ++ "5012d1988c102292eb570cc840ac9af7" ++ "2bb4c52e5edd", typed_encoded);
    try std.testing.expectEqual(try crypto.secretKeyAddress(key), signed.signer);
    try std.testing.expectEqual(signed.signer, try legacy.recoverSigner(allocator, signed.signature));
}

test "canonical RLP zero short-byte and long-length boundaries" {
    var bytes: Bytes = .empty;
    defer bytes.deinit(std.testing.allocator);
    try appendUint(std.testing.allocator, &bytes, 0);
    try appendUint(std.testing.allocator, &bytes, 127);
    try appendUint(std.testing.allocator, &bytes, 128);
    try std.testing.expectEqualSlices(u8, &.{ 0x80, 0x7f, 0x81, 0x80 }, bytes.items);
    var body: [1024]u8 = .{0x42} ** 1024;
    for ([_]usize{ 0, 1, 55, 56, 255, 256, 1024 }) |len| {
        bytes.clearRetainingCapacity();
        try appendBytes(std.testing.allocator, &bytes, body[0..len]);
        if (len == 56) try std.testing.expectEqualSlices(u8, &.{ 0xb8, 56 }, bytes.items[0..2]);
        if (len == 256) try std.testing.expectEqualSlices(u8, &.{ 0xb9, 1, 0 }, bytes.items[0..3]);
        try std.testing.expect(std.mem.endsWith(u8, bytes.items, body[0..len]));
    }
}

test "checked transaction fees chain id and nonce boundaries" {
    var legacy: Transaction = .{ .legacy = .{ .gas_price = 1, .gas_limit = 21_000, .to = null } };
    try std.testing.expectEqual(@as(u256, 21_000), try legacy.maxCost());
    legacy.legacy.value = std.math.maxInt(u256);
    try std.testing.expectError(error.Overflow, legacy.maxCost());
    legacy.legacy.gas_price = std.math.maxInt(u256);
    try std.testing.expectError(error.Overflow, legacy.maxCost());
    legacy.legacy.nonce = std.math.maxInt(u256);
    try std.testing.expectError(error.Overflow, legacy.nextNonce());
    legacy.legacy.chain_id = std.math.maxInt(u256);
    try std.testing.expectError(error.Overflow, legacy.unsigned(std.testing.allocator));
    const dynamic: Transaction = .{ .eip1559 = .{ .chain_id = 1, .gas_limit = 21_000, .to = null, .max_priority_fee_per_gas = 2, .max_fee_per_gas = 1 } };
    try std.testing.expectError(error.PriorityFeeAboveMaxFee, dynamic.unsigned(std.testing.allocator));
}

fn fixtureField(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidFixture;
    return value.object.get(name) orelse error.InvalidFixture;
}

fn fixtureText(allocator: Allocator, value: std.json.Value) ![]const u8 {
    if (value == .string) return value.string;
    if (value != .array) return error.InvalidFixture;
    var out: Bytes = .empty;
    errdefer out.deinit(allocator);
    for (value.array.items) |chunk| {
        if (chunk != .string) return error.InvalidFixture;
        try out.appendSlice(allocator, chunk.string);
    }
    return out.toOwnedSlice(allocator);
}

fn fixtureBytes(allocator: Allocator, value: std.json.Value) ![]u8 {
    var text = try fixtureText(allocator, value);
    if (std.mem.startsWith(u8, text, "0x")) text = text[2..];
    if (text.len % 2 != 0) return error.InvalidFixture;
    const bytes = try allocator.alloc(u8, text.len / 2);
    return std.fmt.hexToBytes(bytes, text);
}

fn fixtureFixed(comptime N: usize, allocator: Allocator, value: std.json.Value) ![N]u8 {
    const bytes = try fixtureBytes(allocator, value);
    if (bytes.len != N) return error.InvalidFixture;
    return bytes[0..N].*;
}

fn fixtureUint(allocator: Allocator, value: std.json.Value) !u256 {
    const text = try fixtureText(allocator, value);
    if (!std.mem.startsWith(u8, text, "0x")) return error.InvalidFixture;
    return std.fmt.parseInt(u256, text[2..], 16);
}

fn fixtureTransaction(allocator: Allocator, input: std.json.Value) !Transaction {
    const nonce = try fixtureUint(allocator, try fixtureField(input, "nonce"));
    const gas_limit = try fixtureUint(allocator, try fixtureField(input, "gas_limit"));
    const raw_to = try fixtureField(input, "to");
    const to = if (raw_to == .null) null else try fixtureFixed(20, allocator, raw_to);
    const value = try fixtureUint(allocator, try fixtureField(input, "value"));
    const data = try fixtureBytes(allocator, try fixtureField(input, "data"));
    const chain = try fixtureField(input, "chain_id");
    const kind = try fixtureText(allocator, try fixtureField(input, "type"));
    if (std.mem.eql(u8, kind, "legacy")) return .{ .legacy = .{
        .chain_id = if (chain == .null) null else try fixtureUint(allocator, chain),
        .nonce = nonce,
        .gas_price = try fixtureUint(allocator, try fixtureField(input, "gas_price")),
        .gas_limit = gas_limit,
        .to = to,
        .value = value,
        .data = data,
    } };
    if (!std.mem.eql(u8, kind, "eip1559")) return error.InvalidFixture;
    const raw_access = try fixtureField(input, "access_list");
    if (raw_access != .array) return error.InvalidFixture;
    const access = try allocator.alloc(AccessTuple, raw_access.array.items.len);
    for (raw_access.array.items, 0..) |entry, i| {
        const raw_keys = try fixtureField(entry, "storage_keys");
        if (raw_keys != .array) return error.InvalidFixture;
        const keys = try allocator.alloc(Hash, raw_keys.array.items.len);
        for (raw_keys.array.items, 0..) |key, j| keys[j] = try fixtureFixed(32, allocator, key);
        access[i] = .{ .address = try fixtureFixed(20, allocator, try fixtureField(entry, "address")), .storage_keys = keys };
    }
    return .{ .eip1559 = .{
        .chain_id = try fixtureUint(allocator, chain),
        .nonce = nonce,
        .max_priority_fee_per_gas = try fixtureUint(allocator, try fixtureField(input, "max_priority_fee_per_gas")),
        .max_fee_per_gas = try fixtureUint(allocator, try fixtureField(input, "max_fee_per_gas")),
        .gas_limit = gas_limit,
        .to = to,
        .value = value,
        .data = data,
        .access_list = access,
    } };
}

test "51 production ethers fixtures match unsigned digest signed wire hash and signer" {
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(std.testing.allocator, @embedFile("fixtures/transactions.jsonl.gz"), 16 * 1024 * 1024);
    defer std.testing.allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const fixture = try std.json.parseFromSliceLeaky(std.json.Value, allocator, line, .{});
        const input = try fixtureField(fixture, "input");
        const expected = try fixtureField(fixture, "expected");
        const tx = try fixtureTransaction(allocator, input);
        const unsigned = try tx.unsigned(allocator);
        try std.testing.expectEqualSlices(u8, try fixtureBytes(allocator, try fixtureField(expected, "unsigned")), unsigned);
        try std.testing.expectEqual(try fixtureFixed(32, allocator, try fixtureField(expected, "signing_hash")), try tx.signingHash(allocator));
        const signature = try fixtureFixed(65, allocator, try fixtureField(expected, "signature"));
        const signer = try fixtureFixed(20, allocator, try fixtureField(expected, "signer"));
        try std.testing.expectEqual(signer, try tx.recoverSigner(allocator, signature));
        const signed = try tx.encodeSigned(allocator, signature);
        try std.testing.expectEqualSlices(u8, try fixtureBytes(allocator, try fixtureField(expected, "signed")), signed);
        var tx_hash: Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(signed, &tx_hash, .{});
        try std.testing.expectEqual(try fixtureFixed(32, allocator, try fixtureField(expected, "hash")), tx_hash);
        var locally_signed = try tx.sign(allocator, try fixtureFixed(32, allocator, try fixtureField(input, "secret_key")), null);
        defer locally_signed.deinit();
        try std.testing.expectEqual(signer, locally_signed.signer);
        try std.testing.expectEqual(signer, try tx.recoverSigner(allocator, locally_signed.signature));
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 51), count);
}
