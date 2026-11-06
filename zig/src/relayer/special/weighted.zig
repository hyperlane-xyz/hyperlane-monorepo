//! Weighted multisig primitives from AbstractStaticWeightedMultisigIsm. Rust
//! has no weighted builder, so these are not connected to production dispatch.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const evm = @import("../../evm/root.zig");
const quorum = @import("../quorum.zig");
const objects = @import("../../storage/objects.zig");

pub const Address = [20]u8;
pub const total_weight: u96 = 10_000_000_000;
pub const max_validators = 256;

pub const Validator = struct {
    address: Address,
    weight: u96,
};

pub const Members = struct {
    allocator: std.mem.Allocator,
    validators: []Validator,
    threshold_weight: u96,

    pub fn deinit(self: *Members) void {
        self.allocator.free(self.validators);
        self.* = undefined;
    }
};

pub fn decodeMembers(allocator: std.mem.Allocator, bytes: []const u8) !Members {
    if (bytes.len < 96 or bytes.len % 32 != 0) return error.InvalidMemberAbi;
    if (try evm.codecs.uintWord(usize, bytes[0..32]) != 64) return error.InvalidMemberAbi;
    const threshold_weight = try evm.codecs.uintWord(u96, bytes[32..64]);
    if (threshold_weight == 0 or threshold_weight > total_weight) return error.InvalidThresholdWeight;
    const length = try evm.codecs.uintWord(usize, bytes[64..96]);
    if (length > max_validators or length != (bytes.len - 96) / 64 or (bytes.len - 96) % 64 != 0) return error.InvalidMemberAbi;
    const validators = try allocator.alloc(Validator, length);
    errdefer allocator.free(validators);
    for (validators, 0..) |*validator, i| {
        const offset = 96 + i * 64;
        validator.* = .{
            .address = try evm.codecs.addressWord(bytes[offset..][0..32]),
            .weight = try evm.codecs.uintWord(u96, bytes[offset + 32 ..][0..32]),
        };
    }
    return .{ .allocator = allocator, .validators = validators, .threshold_weight = threshold_weight };
}

pub fn validatorsCall(allocator: std.mem.Allocator, message: protocol.Message) ![]u8 {
    const encoded = try message.encodeAlloc(allocator);
    defer allocator.free(encoded);
    const padding = (32 - encoded.len % 32) % 32;
    const bytes = try allocator.alloc(u8, try std.math.add(usize, 68 + padding, encoded.len));
    @memset(bytes, 0);
    bytes[0..4].* = evm.codecs.selector("validatorsAndThresholdWeight(bytes)");
    std.mem.writeInt(u256, bytes[4..36], 32, .big);
    std.mem.writeInt(u256, bytes[36..68], encoded.len, .big);
    @memcpy(bytes[68..][0..encoded.len], encoded);
    return bytes;
}

pub const Destination = struct {
    allocator: std.mem.Allocator,
    client: *evm.RpcClient,
    block: evm.BlockRef,

    pub fn members(self: *Destination, address: Address, message: protocol.Message) !Members {
        if (self.client.options.cancel) |cancel| {
            if (cancel.load(.acquire)) return error.RequestCancelled;
        }
        const calldata = try validatorsCall(self.allocator, message);
        defer self.allocator.free(calldata);
        const bytes = try self.client.ethCall(address, calldata, self.block);
        defer self.client.allocator.free(bytes);
        return decodeMembers(self.allocator, bytes);
    }
};

/// Solidity stops recovering as soon as quorum is reached; trailing signatures
/// are therefore ignored. Arithmetic remains u96 so malicious weights overflow
/// exactly where the checked Solidity addition would revert.
pub fn verify(digest: [32]u8, signatures: []const u8, validators: []const Validator, threshold_weight: u96) !void {
    if (threshold_weight == 0 or threshold_weight > total_weight) return error.InvalidThresholdWeight;
    if (signatures.len % 65 != 0) return error.InvalidSignaturesLength;
    var validator_index: usize = 0;
    var accumulated: u96 = 0;
    var signature_index: usize = 0;
    while (accumulated < threshold_weight and signature_index < signatures.len / 65) : (signature_index += 1) {
        const raw = signatures[signature_index * 65 ..][0..65].*;
        const signer = try protocol.signature.recover(digest, raw);
        while (validator_index < validators.len and !std.mem.eql(u8, &signer, &validators[validator_index].address)) validator_index += 1;
        if (validator_index == validators.len) return error.InvalidSigner;
        accumulated = std.math.add(u96, accumulated, validators[validator_index].weight) catch return error.WeightOverflow;
        validator_index += 1;
    }
    if (accumulated < threshold_weight) return error.InsufficientValidatorWeight;
}

/// Arrival-ordered checkpoint selection with weight rather than signature count.
/// The first root reaching threshold wins; output follows validator order.
pub const Collector = struct {
    allocator: std.mem.Allocator,
    validators: []const Validator,
    threshold_weight: u96,
    index: u32,
    accepted: [max_validators]quorum.Arrival = undefined,
    accepted_len: usize = 0,
    seen: [max_validators]bool = @splat(false),
    complete: bool = false,

    pub fn init(allocator: std.mem.Allocator, validators: []const Validator, threshold_weight: u96, index: u32) !Collector {
        if (threshold_weight == 0 or threshold_weight > total_weight or validators.len > max_validators) return error.InvalidThresholdWeight;
        return .{ .allocator = allocator, .validators = validators, .threshold_weight = threshold_weight, .index = index };
    }

    pub fn push(self: *Collector, arrival: quorum.Arrival) !?quorum.Quorum {
        if (self.complete) return error.QuorumAlreadyComplete;
        if (arrival.validator_index >= self.validators.len) return error.ValidatorOutOfBounds;
        if (self.seen[arrival.validator_index]) return error.DuplicateResponse;
        self.seen[arrival.validator_index] = true;
        if (arrival.signed.value.index != self.index) return null;
        const signer = protocol.signature.recover(arrival.signed.value.digest(), arrival.signed.signature.bytes()) catch return null;
        if (!std.mem.eql(u8, &signer, &self.validators[arrival.validator_index].address)) return null;
        self.accepted[self.accepted_len] = arrival;
        self.accepted_len += 1;
        var matches: [max_validators]quorum.Arrival = undefined;
        var count: usize = 0;
        for (self.accepted[0..self.accepted_len]) |other| {
            if (!std.mem.eql(u8, &other.signed.value.root, &arrival.signed.value.root)) continue;
            matches[count] = other;
            count += 1;
        }
        std.mem.sort(quorum.Arrival, matches[0..count], {}, struct {
            fn less(_: void, left: quorum.Arrival, right: quorum.Arrival) bool {
                return left.validator_index < right.validator_index;
            }
        }.less);
        var accumulated: u96 = 0;
        var selected_count: usize = 0;
        for (matches[0..count]) |other| {
            if (accumulated >= self.threshold_weight) break;
            accumulated = std.math.add(u96, accumulated, self.validators[other.validator_index].weight) catch return error.WeightOverflow;
            selected_count += 1;
        }
        if (accumulated < self.threshold_weight) return null;
        const checkpoint = matches[0].signed.value;
        for (matches[1..selected_count]) |other| {
            if (!std.meta.eql(checkpoint, other.signed.value)) return error.InconsistentCheckpoints;
        }
        const signatures = try self.allocator.alloc(objects.Signature, selected_count);
        for (matches[0..selected_count], signatures) |entry, *signature| signature.* = entry.signed.signature;
        self.complete = true;
        return .{ .checkpoint = checkpoint, .signatures = signatures, .allocator = self.allocator };
    }
};
