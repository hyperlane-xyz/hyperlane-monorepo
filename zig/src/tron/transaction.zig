const std = @import("std");
const wire = @import("../altvm/tron.zig");
const signature = @import("../protocol/signature.zig");
const protobuf = @import("../altvm/protobuf.zig");
pub const Trigger = wire.Trigger;
pub const Reference = wire.Reference;
pub const Address = wire.Address;
pub const Hash = [32]u8;
const A = std.mem.Allocator;

/// The production default multiplier is 1.5. Exact rational multiplication
/// avoids Rust's low-u64 truncation and f64 rounding before its i64 wire cast.
pub const FeePolicy = struct {
    numerator: u64 = 3,
    denominator: u64 = 2,
    max_fee_sun: u64 = std.math.maxInt(i64),
    /// Optional source-compatible f64 energy_multiplier configuration. The
    /// default exact 3/2 avoids rounding; configured floats retain Rust's floor.
    multiplier: ?f64 = null,
    pub fn fee(self: FeePolicy, energy: u256, price_sun: u256) !u64 {
        if (self.denominator == 0 or self.numerator == 0 or self.max_fee_sun > std.math.maxInt(i64)) return error.InvalidTronFeePolicy;
        const base = try std.math.mul(u256, energy, price_sun);
        if (self.multiplier) |multiplier| {
            if (!std.math.isFinite(multiplier) or multiplier <= 0) return error.InvalidTronFeePolicy;
            if (base > std.math.maxInt(u64)) return error.TronFeeLimitExceeded;
            const result = @as(f64, @floatFromInt(@as(u64, @intCast(base)))) * multiplier;
            if (!std.math.isFinite(result) or result >= 9223372036854775808.0) return error.TronFeeLimitExceeded;
            const adjusted: u64 = @intFromFloat(result);
            if (adjusted > self.max_fee_sun) return error.TronFeeLimitExceeded;
            return adjusted;
        }
        const adjusted = try std.math.mul(u256, base, self.numerator) / self.denominator;
        if (adjusted > self.max_fee_sun) return error.TronFeeLimitExceeded;
        return @intCast(adjusted);
    }
};

pub const Unsigned = struct {
    allocator: A,
    raw: []u8,
    id: Hash,
    owner: Address,
    expiration_ms: u64,
    pub fn deinit(self: *Unsigned) void {
        self.allocator.free(self.raw);
        self.* = undefined;
    }
};
pub const Signed = struct {
    allocator: A,
    bytes: []u8,
    id: Hash,
    expiration_ms: u64,
    pub fn deinit(self: *Signed) void {
        self.allocator.free(self.bytes);
        self.* = undefined;
    }
    pub fn expired(self: Signed, now_ms: u64) bool {
        return now_ms >= self.expiration_ms;
    }
};

pub const RawView = struct {
    trigger: Trigger,
    ref_block_bytes: [2]u8,
    ref_block_hash: [8]u8,
    block_number: u64 = 0,
    timestamp_ms: u64 = 0,
    expiration_ms: u64 = 0,
    fee_limit: u64 = 0,
};
/// Decodes the exact single TriggerSmartContract envelope built by the agent.
/// All byte slices borrow raw. Other contract/permission/token forms are
/// explicitly unsupported, rather than silently changing a signing intent.
pub fn decodeRaw(raw: []const u8) !RawView {
    var result: RawView = .{ .trigger = undefined, .ref_block_bytes = undefined, .ref_block_hash = undefined };
    var decoder: protobuf.Decoder = .{ .input = raw };
    var seen: u32 = 0;
    while (try decoder.next()) |field| {
        try unique(&seen, field.number);
        switch (field.number) {
            1 => {
                const data = try byteField(field);
                if (data.len != 2) return error.InvalidTronProtobuf;
                result.ref_block_bytes = data[0..2].*;
            },
            3 => result.block_number = try intField(field),
            4 => {
                const data = try byteField(field);
                if (data.len != 8) return error.InvalidTronProtobuf;
                result.ref_block_hash = data[0..8].*;
            },
            8 => result.expiration_ms = try intField(field),
            11 => result.trigger = try decodeContract(try byteField(field)),
            14 => result.timestamp_ms = try intField(field),
            18 => result.fee_limit = try intField(field),
            else => return error.UnsupportedTronProtobuf,
        }
    }
    const required = (@as(u32, 1) << 1) | (@as(u32, 1) << 4) | (@as(u32, 1) << 11);
    if (seen & required != required or std.mem.readInt(u16, &result.ref_block_bytes, .big) != @as(u16, @truncate(result.block_number))) return error.InvalidTronProtobuf;
    return result;
}
fn decodeContract(bytes: []const u8) !Trigger {
    var decoder: protobuf.Decoder = .{ .input = bytes };
    var seen: u32 = 0;
    var kind: u64 = 0;
    var parameter: ?[]const u8 = null;
    while (try decoder.next()) |field| {
        try unique(&seen, field.number);
        switch (field.number) {
            1 => kind = try intField(field),
            2 => parameter = try byteField(field),
            else => return error.UnsupportedTronProtobuf,
        }
    }
    if (kind != 31) return error.UnsupportedTronProtobuf;
    var any: protobuf.Decoder = .{ .input = parameter orelse return error.InvalidTronProtobuf };
    seen = 0;
    var type_url: ?[]const u8 = null;
    var value: ?[]const u8 = null;
    while (try any.next()) |field| {
        try unique(&seen, field.number);
        switch (field.number) {
            1 => type_url = try byteField(field),
            2 => value = try byteField(field),
            else => return error.UnsupportedTronProtobuf,
        }
    }
    if (!std.mem.eql(u8, type_url orelse return error.InvalidTronProtobuf, "/protocol.TriggerSmartContract")) return error.UnsupportedTronProtobuf;
    var trigger: Trigger = .{ .owner = undefined, .contract = undefined, .data = "" };
    var inner: protobuf.Decoder = .{ .input = value orelse return error.InvalidTronProtobuf };
    seen = 0;
    while (try inner.next()) |field| {
        try unique(&seen, field.number);
        switch (field.number) {
            1, 2 => {
                const address = try byteField(field);
                if (address.len != 21 or address[0] != 0x41) return error.InvalidTronProtobuf;
                if (field.number == 1) trigger.owner = address[0..21].* else trigger.contract = address[0..21].*;
            },
            3 => trigger.call_value = try intField(field),
            4 => trigger.data = try byteField(field),
            5, 6 => {
                if (try intField(field) != 0) return error.UnsupportedTronTokenTransfer;
            },
            else => return error.UnsupportedTronProtobuf,
        }
    }
    if (seen & 6 != 6) return error.InvalidTronProtobuf;
    return trigger;
}
pub const SignedView = struct { raw: []const u8, view: RawView, id: Hash, signature: signature.Signature };
pub fn decodeSigned(bytes: []const u8) !SignedView {
    var decoder: protobuf.Decoder = .{ .input = bytes };
    var seen: u32 = 0;
    var raw: ?[]const u8 = null;
    var sig: ?signature.Signature = null;
    while (try decoder.next()) |field| {
        try unique(&seen, field.number);
        switch (field.number) {
            1 => raw = try byteField(field),
            2 => {
                const value = try byteField(field);
                if (value.len != 65) return error.InvalidTronProtobuf;
                sig = value[0..65].*;
            },
            else => return error.UnsupportedTronProtobuf,
        }
    }
    const raw_data = raw orelse return error.InvalidTronProtobuf;
    const view = try decodeRaw(raw_data);
    const id = wire.txId(raw_data);
    const signed = sig orelse return error.InvalidTronProtobuf;
    if (!std.mem.eql(u8, view.trigger.owner[1..], &try signature.recover(id, signed))) return error.TronSignerMismatch;
    return .{ .raw = raw_data, .view = view, .id = id, .signature = signed };
}
fn unique(seen: *u32, number: u29) !void {
    if (number >= 32) return error.UnsupportedTronProtobuf;
    const bit = @as(u32, 1) << @as(u5, @intCast(number));
    if (seen.* & bit != 0) return error.DuplicateTronField;
    seen.* |= bit;
}
fn intField(field: protobuf.Field) !u64 {
    if (field.value != .uint or field.value.uint > std.math.maxInt(i64)) return error.TronIntegerOverflow;
    return field.value.uint;
}
fn byteField(field: protobuf.Field) ![]const u8 {
    if (field.value != .bytes) return error.InvalidTronProtobuf;
    return field.value.bytes;
}
/// The caller owns secret material/KMS context. DIGEST is signed directly;
/// Ethereum's EIP-191 prefix must never be applied to a Tron transaction.
pub const Signer = struct {
    context: *anyopaque,
    address: Address,
    sign_fn: *const fn (*anyopaque, Hash) anyerror!signature.Signature,
    pub fn sign(self: Signer, digest: Hash) !signature.Signature {
        return self.sign_fn(self.context, digest);
    }
};
pub const LocalSigner = struct {
    secret_key: [32]u8,
    pub fn interface(self: *LocalSigner) !Signer {
        return .{ .context = self, .address = try wire.secretKeyAddress(self.secret_key), .sign_fn = LocalSigner.sign };
    }
    pub fn deinit(self: *LocalSigner) void {
        std.crypto.secureZero(u8, &self.secret_key);
    }
    fn sign(context: *anyopaque, digest: Hash) !signature.Signature {
        const self: *LocalSigner = @ptrCast(@alignCast(context));
        return signature.signDigest(self.secret_key, digest, null);
    }
};

pub fn build(allocator: A, trigger: Trigger, ref: Reference) !Unsigned {
    const raw = try wire.rawTransaction(allocator, trigger, ref);
    return .{ .allocator = allocator, .raw = raw, .id = wire.txId(raw), .owner = trigger.owner, .expiration_ms = ref.expiration_ms };
}
pub fn sign(unsigned: Unsigned, signer: Signer, now_ms: u64) !Signed {
    if (now_ms >= unsigned.expiration_ms) return error.TronTransactionExpired;
    if (!std.mem.eql(u8, &unsigned.owner, &signer.address)) return error.TronSignerMismatch;
    try validateUnsigned(unsigned);
    return encodeSigned(unsigned, try signer.sign(unsigned.id), now_ms);
}
pub fn encodeSigned(unsigned: Unsigned, sig: signature.Signature, now_ms: u64) !Signed {
    if (now_ms >= unsigned.expiration_ms) return error.TronTransactionExpired;
    try validateUnsigned(unsigned);
    if (!std.mem.eql(u8, unsigned.owner[1..], &try signature.recover(unsigned.id, sig))) return error.TronSignerMismatch;
    return .{ .allocator = unsigned.allocator, .bytes = try wire.signedTransaction(unsigned.allocator, unsigned.raw, &.{sig}), .id = unsigned.id, .expiration_ms = unsigned.expiration_ms };
}
fn validateUnsigned(unsigned: Unsigned) !void {
    if (!std.mem.eql(u8, &unsigned.id, &wire.txId(unsigned.raw))) return error.TronRawDataChanged;
    const view = try decodeRaw(unsigned.raw);
    if (!std.mem.eql(u8, &view.trigger.owner, &unsigned.owner) or view.expiration_ms != unsigned.expiration_ms or view.expiration_ms <= view.timestamp_ms) return error.TronRawDataChanged;
}
pub fn validateSigned(signed: Signed) !void {
    const decoded = try decodeSigned(signed.bytes);
    if (!std.mem.eql(u8, &decoded.id, &signed.id) or decoded.view.expiration_ms != signed.expiration_ms or decoded.view.expiration_ms <= decoded.view.timestamp_ms) return error.TronRawDataChanged;
}

/// Rust's transaction builder uses a 60-second lifetime and second precision.
pub fn reference(block_number: u64, block_hash: Hash, now_ms: u64, fee_limit: u64) !Reference {
    const timestamp = now_ms / 1000 * 1000;
    return .{ .block_number = block_number, .block_hash = block_hash, .timestamp_ms = timestamp, .expiration_ms = try std.math.add(u64, timestamp, 60_000), .fee_limit = fee_limit };
}

pub const SubmissionError = enum { retryable, duplicate, permanent, resource_cap, unknown };
pub fn classify(code: []const u8) SubmissionError {
    for ([_][]const u8{ "SERVER_BUSY", "NOT_ENOUGH_EFFECTIVE_CONNECTION", "NO_CONNECTION", "BLOCK_UNSOLIDIFIED", "OTHER_ERROR" }) |candidate| if (std.mem.eql(u8, code, candidate)) return .retryable;
    if (std.mem.eql(u8, code, "DUP_TRANSACTION_ERROR")) return .duplicate;
    for ([_][]const u8{ "SIGERROR", "TAPOS_ERROR", "TOO_BIG_TRANSACTION_ERROR", "TRANSACTION_EXPIRATION_ERROR", "CONTRACT_EXE_ERROR" }) |candidate| if (std.mem.eql(u8, code, candidate)) return .permanent;
    if (std.mem.eql(u8, code, "BANDWITH_ERROR")) return .resource_cap;
    return .unknown;
}
pub fn readyForResubmission(now_ms: u64, last_attempt_ms: ?u64, estimated_block_ms: u64) !bool {
    const last = last_attempt_ms orelse return true;
    if (now_ms < last) return false;
    return now_ms - last >= try std.math.mul(u64, estimated_block_ms, 18);
}

test "Tron checked energy fees TAPOS expiry raw signing owner and classification" {
    const a = std.testing.allocator;
    const policy: FeePolicy = .{};
    try std.testing.expectEqual(@as(u64, 1500), try policy.fee(100, 10));
    try std.testing.expectError(error.Overflow, policy.fee(std.math.maxInt(u256), 2));
    try std.testing.expectError(error.TronFeeLimitExceeded, policy.fee(std.math.maxInt(i64), 2));
    var signer: LocalSigner = .{ .secret_key = .{0x11} ** 32 };
    defer signer.deinit();
    const interface = try signer.interface();
    const ref = try reference(0x123456, .{0x33} ** 32, 1700000000999, 1_000_000);
    try std.testing.expectEqual(@as(u64, 1700000000000), ref.timestamp_ms);
    var unsigned = try build(a, .{ .owner = interface.address, .contract = wire.fromEthereumAddress(.{0x22} ** 20), .data = "fixture" }, ref);
    defer unsigned.deinit();
    var signed = try sign(unsigned, interface, 1700000000000);
    defer signed.deinit();
    try std.testing.expect(!signed.expired(ref.expiration_ms - 1));
    try std.testing.expect(signed.expired(ref.expiration_ms));
    try std.testing.expectError(error.TronTransactionExpired, sign(unsigned, interface, ref.expiration_ms));
    var wrong = interface;
    wrong.address[1] ^= 1;
    try std.testing.expectError(error.TronSignerMismatch, sign(unsigned, wrong, 0));
    try std.testing.expectEqual(SubmissionError.duplicate, classify("DUP_TRANSACTION_ERROR"));
    try std.testing.expectEqual(SubmissionError.resource_cap, classify("BANDWITH_ERROR"));
    try std.testing.expect(try readyForResubmission(54_000, 0, 3000));
    try std.testing.expect(!try readyForResubmission(53_999, 0, 3000));
}
