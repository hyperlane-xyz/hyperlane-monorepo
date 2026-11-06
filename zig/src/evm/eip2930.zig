const std = @import("std");
const abi = @import("codecs.zig");
const transaction = @import("transaction.zig");
const crypto = @import("../protocol/signature.zig");
const Allocator = std.mem.Allocator;
const Bytes = std.ArrayList(u8);

pub const Eip2930 = struct {
    chain_id: u256,
    nonce: u256 = 0,
    gas_price: u256,
    gas_limit: u256,
    to: ?transaction.Address,
    value: u256 = 0,
    data: []const u8 = &.{},
    access_list: []const transaction.AccessTuple = &.{},

    pub fn validate(self: Eip2930) !void {
        _ = self;
    }

    pub fn unsigned(self: Eip2930, allocator: Allocator) ![]u8 {
        try self.validate();
        var fields: Bytes = .empty;
        defer fields.deinit(allocator);
        try self.appendFields(allocator, &fields);
        return envelope(allocator, fields.items);
    }

    pub fn signingHash(self: Eip2930, allocator: Allocator) !transaction.Hash {
        const bytes = try self.unsigned(allocator);
        defer allocator.free(bytes);
        var digest: transaction.Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(bytes, &digest, .{});
        return digest;
    }

    pub fn recoverSigner(self: Eip2930, allocator: Allocator, signature: transaction.Signature) !transaction.Address {
        return crypto.recover(try self.signingHash(allocator), signature);
    }

    /// Accepts canonical recoverable Ethereum signatures (v=27/28, low s).
    pub fn encodeSigned(self: Eip2930, allocator: Allocator, signature: transaction.Signature) ![]u8 {
        _ = try self.recoverSigner(allocator, signature);
        var fields: Bytes = .empty;
        defer fields.deinit(allocator);
        try self.appendFields(allocator, &fields);
        try appendUint(allocator, &fields, signature[64] - 27);
        try appendUint(allocator, &fields, std.mem.readInt(u256, signature[0..32], .big));
        try appendUint(allocator, &fields, std.mem.readInt(u256, signature[32..64], .big));
        return envelope(allocator, fields.items);
    }

    pub fn sign(self: Eip2930, allocator: Allocator, secret_key: transaction.Hash, noise: ?transaction.Hash) !transaction.SignedTransaction {
        const digest = try self.signingHash(allocator);
        const signature = try crypto.signDigest(secret_key, digest, noise);
        const signer = try crypto.secretKeyAddress(secret_key);
        const recovered = try crypto.recover(digest, signature);
        if (!std.mem.eql(u8, &signer, &recovered)) return error.SignerMismatch;
        const bytes = try self.encodeSigned(allocator, signature);
        var hash: transaction.Hash = undefined;
        std.crypto.hash.sha3.Keccak256.hash(bytes, &hash, .{});
        return .{ .allocator = allocator, .bytes = bytes, .hash = hash, .signature = signature, .signer = signer };
    }

    fn appendFields(self: Eip2930, allocator: Allocator, out: *Bytes) !void {
        try appendUint(allocator, out, self.chain_id);
        try appendUint(allocator, out, self.nonce);
        try appendUint(allocator, out, self.gas_price);
        try appendUint(allocator, out, self.gas_limit);
        try appendBytes(allocator, out, if (self.to) |*address| address else &.{});
        try appendUint(allocator, out, self.value);
        try appendBytes(allocator, out, self.data);
        try appendAccessList(allocator, out, self.access_list);
    }
};

fn envelope(allocator: Allocator, fields: []const u8) ![]u8 {
    var out: Bytes = .empty;
    errdefer out.deinit(allocator);
    try out.append(allocator, 1);
    try appendList(allocator, &out, fields);
    return out.toOwnedSlice(allocator);
}

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

fn appendAccessList(allocator: Allocator, out: *Bytes, entries: []const transaction.AccessTuple) !void {
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

const OracleVector = struct {
    unsigned: []const u8,
    signing_hash: []const u8,
    signature: []const u8,
    signed: []const u8,
    hash: []const u8,
    signer: []const u8,
};

fn expectHex(expected: []const u8, actual: []const u8) !void {
    const encoded = try abi.hexAlloc(std.testing.allocator, actual);
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings(expected, encoded);
}

fn checkOracleVector(tx: Eip2930, vector: OracleVector) !void {
    const allocator = std.testing.allocator;
    try tx.validate();
    const unsigned = try tx.unsigned(allocator);
    defer allocator.free(unsigned);
    try expectHex(vector.unsigned, unsigned);
    try std.testing.expectEqual(try abi.fixedHex(32, vector.signing_hash), try tx.signingHash(allocator));
    const signature = try abi.fixedHex(65, vector.signature);
    const signer = try abi.fixedHex(20, vector.signer);
    try std.testing.expectEqual(signer, try tx.recoverSigner(allocator, signature));
    const encoded = try tx.encodeSigned(allocator, signature);
    defer allocator.free(encoded);
    try expectHex(vector.signed, encoded);
    var hash: transaction.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(encoded, &hash, .{});
    try std.testing.expectEqual(try abi.fixedHex(32, vector.hash), hash);
    const key: transaction.Hash = @splat(0x46);
    var signed = try tx.sign(allocator, key, null);
    defer signed.deinit();
    try std.testing.expectEqual(signer, signed.signer);
    try std.testing.expectEqual(signer, try tx.recoverSigner(allocator, signed.signature));
    const locally_encoded = try tx.encodeSigned(allocator, signed.signature);
    defer allocator.free(locally_encoded);
    try std.testing.expectEqualSlices(u8, locally_encoded, signed.bytes);
    var local_hash: transaction.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(signed.bytes, &local_hash, .{});
    try std.testing.expectEqual(local_hash, signed.hash);
    for ([_]transaction.Signature{ signature, signed.signature }) |canonical| {
        try std.testing.expect(canonical[64] == 27 or canonical[64] == 28);
        try std.testing.expect(std.mem.readInt(u256, canonical[32..64], .big) <= std.crypto.ecc.Secp256k1.scalar.field_order / 2);
    }
}

test "EIP-2930 populated access list matches production ethers" {
    var data: [60]u8 = undefined;
    for (&data, 0..) |*byte, i| byte.* = @intCast(i);
    const storage_keys = [_]transaction.Hash{ @splat(0x22), @splat(0x33) };
    const access_list = [_]transaction.AccessTuple{
        .{ .address = @splat(0x11), .storage_keys = &storage_keys },
        .{ .address = @splat(0x44) },
    };
    const tx: Eip2930 = .{
        .chain_id = 1,
        .nonce = 9,
        .gas_price = 20_000_000_000,
        .gas_limit = 60_000,
        .to = @splat(0x35),
        .value = 1_000_000_000_000_000_000,
        .data = &data,
        .access_list = &access_list,
    };
    try checkOracleVector(tx, .{
        .unsigned = "0x01f8db01098504a817c80082ea609435" ++
            "35353535353535353535353535353535" ++
            "353535880de0b6b3a7640000b83c0001" ++
            "02030405060708090a0b0c0d0e0f1011" ++
            "12131415161718191a1b1c1d1e1f2021" ++
            "22232425262728292a2b2c2d2e2f3031" ++
            "32333435363738393a3bf872f8599411" ++
            "11111111111111111111111111111111" ++
            "111111f842a022222222222222222222" ++
            "22222222222222222222222222222222" ++
            "222222222222a0333333333333333333" ++
            "33333333333333333333333333333333" ++
            "33333333333333d69444444444444444" ++
            "44444444444444444444444444c0",
        .signing_hash = "0x6fb051a611170850460d0d8be3cd48a3" ++
            "77b9e993429ad46b25f09311bfd1c7ef",
        .signature = "0x851923691d13def71defe23dad822d67" ++
            "7799d283805ded3c43404a340d489d1e" ++
            "01e780150f1513597a1d935290d774f8" ++
            "e8bcd3aa91adea4e1b8b925345786aef" ++
            "1b",
        .signed = "0x01f9011e01098504a817c80082ea6094" ++
            "35353535353535353535353535353535" ++
            "35353535880de0b6b3a7640000b83c00" ++
            "0102030405060708090a0b0c0d0e0f10" ++
            "1112131415161718191a1b1c1d1e1f20" ++
            "2122232425262728292a2b2c2d2e2f30" ++
            "3132333435363738393a3bf872f85994" ++
            "11111111111111111111111111111111" ++
            "11111111f842a0222222222222222222" ++
            "22222222222222222222222222222222" ++
            "22222222222222a03333333333333333" ++
            "33333333333333333333333333333333" ++
            "3333333333333333d694444444444444" ++
            "4444444444444444444444444444c080" ++
            "a0851923691d13def71defe23dad822d" ++
            "677799d283805ded3c43404a340d489d" ++
            "1ea001e780150f1513597a1d935290d7" ++
            "74f8e8bcd3aa91adea4e1b8b92534578" ++
            "6aef",
        .hash = "0x20c67d4e1e053bfcdf82153331c714bc" ++
            "1dadfa4d49fc7d17732463b06240fee0",
        .signer = "0x9d8a62f656a8d1615c1294fd71e9cfb3" ++
            "e4855a4f",
    });
}

test "EIP-2930 contract creation and empty access list match production ethers" {
    const tx: Eip2930 = .{
        .chain_id = 5,
        .gas_price = 1,
        .gas_limit = 53_000,
        .to = null,
    };
    try checkOracleVector(tx, .{
        .unsigned = "0x01ca05800182cf08808080c0",
        .signing_hash = "0xa0c055fcc9a20ec831b2a9196a625f42" ++
            "5ac6e570cdfb56563366a2579b580762",
        .signature = "0x7cb3e59fee8d21106c5248ba0d945883" ++
            "58dad283e09316fd5cc7f8073e3bcced" ++
            "4e45d06c69f28f68a5c15be994a57d3f" ++
            "b01b8896dd06bf9e4d703982f961b97c" ++
            "1c",
        .signed = "0x01f84d05800182cf08808080c001a07c" ++
            "b3e59fee8d21106c5248ba0d94588358" ++
            "dad283e09316fd5cc7f8073e3bcceda0" ++
            "4e45d06c69f28f68a5c15be994a57d3f" ++
            "b01b8896dd06bf9e4d703982f961b97c",
        .hash = "0x0e0c60b687631c54dc5afcc711f29af3" ++
            "77d24ae4ed063db603b98e25b3a561d4",
        .signer = "0x9d8a62f656a8d1615c1294fd71e9cfb3" ++
            "e4855a4f",
    });
}

test "EIP-2930 signed encoding rejects noncanonical signatures" {
    const tx: Eip2930 = .{ .chain_id = 1, .gas_price = 1, .gas_limit = 21_000, .to = null };
    const key: transaction.Hash = @splat(0x11);
    var signed = try tx.sign(std.testing.allocator, key, null);
    defer signed.deinit();
    var invalid = signed.signature;
    invalid[64] = 0;
    try std.testing.expectError(error.InvalidRecoveryId, tx.encodeSigned(std.testing.allocator, invalid));
    invalid = signed.signature;
    std.mem.writeInt(u256, invalid[32..64], std.crypto.ecc.Secp256k1.scalar.field_order - 1, .big);
    try std.testing.expectError(error.HighSignatureS, tx.encodeSigned(std.testing.allocator, invalid));
}
