//! Actual receipt-derived EVM gas accounting. Native payload/hash markers and
//! the Rust expenditure aggregate commit atomically before terminal transitions.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const evm = @import("../../evm/root.zig");
const db = @import("../../db/root.zig");
const lander = @import("../../lander/root.zig");
const native = @import("../store.zig");
const payload_links = @import("../payload_links.zig");

const Allocator = std.mem.Allocator;
const Hash = [32]u8;
const Uuid = [16]u8;

pub const accounted_payload_prefix = "zig_relayer_evm_accounted_payload_v1/";
pub const accounted_message_transaction_prefix = "zig_relayer_evm_accounted_message_tx_v1/";
pub const max_marker_bytes = 16 * 1024;

pub const Cost = struct {
    gas_used: u256,
    tokens_used: u256,
};

pub const BatchResolver = struct {
    context: *anyopaque,
    estimate_fn: *const fn (*anyopaque, Allocator, Hash, Uuid) anyerror!?u256,

    pub fn estimate(self: BatchResolver, allocator: Allocator, message_id: Hash, payload_uuid: Uuid) !?u256 {
        return self.estimate_fn(self.context, allocator, message_id, payload_uuid);
    }
};

pub const ProjectedReceipt = struct {
    block_number: u64,
    block_hash: Hash,
    gas_used: u256,
    effective_gas_price: ?u256,
    executed: bool,
};

pub const CostReceiptReader = struct {
    context: *anyopaque,
    read_fn: *const fn (*anyopaque, Uuid, Hash) anyerror!?ProjectedReceipt,

    pub fn read(self: CostReceiptReader, transaction_uuid: Uuid, transaction_hash: Hash) !?ProjectedReceipt {
        return self.read_fn(self.context, transaction_uuid, transaction_hash);
    }
};

pub const ReceiptProof = struct {
    transaction_uuid: Uuid,
    transaction_hash: Hash,
    block_number: u64,
    block_hash: Hash,
    gas_used: u256,
    effective_gas_price: u256,
    operation_estimate: u256,
    submission_estimate: u256,
};

pub const CostInput = struct {
    message: protocol.Message,
    generation: u64,
    payload_uuid: Uuid,
    transaction_uuid: Uuid,
    transaction_hash: Hash,
    gas_used: u256,
    gas_price: u256,
    operation_estimate: u256,
    submission_estimate: u256,
};

pub const RecordResult = enum { recorded, duplicate };

pub const Marker = struct {
    version: u8 = 1,
    message_id: Hash,
    generation: u64,
    payload_uuid: Uuid,
    transaction_uuid: Uuid,
    transaction_hash: Hash,
    gas_used: u256,
    tokens_used: u256,
};

pub const OwnedMarker = struct {
    parsed: std.json.Parsed(Marker),

    pub fn value(self: *const OwnedMarker) Marker {
        return self.parsed.value;
    }

    pub fn deinit(self: *OwnedMarker) void {
        self.parsed.deinit();
        self.* = undefined;
    }
};

/// Rust gas_used_by_operation uses arbitrary-precision ratio arithmetic and
/// truncates on U256 conversion. Ratio failure explicitly falls back to full
/// actual tx gas; token conversion overflow remains an error.
pub fn calculate(actual_gas: u256, gas_price: u256, operation_estimate: u256, submission_estimate: u256) !Cost {
    var allocated = actual_gas;
    if (submission_estimate != 0) {
        const numerator = @as(u512, actual_gas) * @as(u512, operation_estimate);
        const ratio = numerator / @as(u512, submission_estimate);
        if (ratio <= std.math.maxInt(u256)) allocated = @intCast(ratio);
    }
    const tokens = @as(u512, allocated) * @as(u512, gas_price);
    if (tokens > std.math.maxInt(u256)) return error.AccountingTokenOverflow;
    return .{ .gas_used = allocated, .tokens_used = @intCast(tokens) };
}

pub fn finalizedReceipt(
    allocator: Allocator,
    destination: *lander.Service,
    client: *evm.RpcClient,
    link: *const payload_links.Link,
    batch_resolver: ?BatchResolver,
    receipt_reader: ?CostReceiptReader,
) !ReceiptProof {
    const link_record = link.record();
    const operation_estimate = link_record.estimated_gas orelse return error.MissingNativeOperationEstimate;
    const payload_uuid = link_record.payload.uuid;
    const transaction_uuid = (try destination.store.payloadTransaction(allocator, payload_uuid)) orelse return error.CostTransactionAssociationMissing;
    if (std.mem.eql(u8, &transaction_uuid, &lander.types.nil_uuid)) return error.CostTransactionAssociationMissing;
    var transaction = (try destination.store.loadTransaction(allocator, transaction_uuid)) orelse return error.CostTransactionAssociationMissing;
    defer transaction.deinit();
    const payload_uuids = try lander.records.payloadTransactionUuids(allocator, transaction.value());
    defer allocator.free(payload_uuids);
    var submission_estimate: u256 = 0;
    var found_payload = false;
    for (payload_uuids) |uuid| {
        if (std.mem.eql(u8, &uuid, &payload_uuid)) found_payload = true;
        var delivery = (try destination.store.delivery(allocator, uuid)) orelse return error.MissingNativeBatchDelivery;
        defer delivery.deinit(allocator);
        const message_id = switch (delivery.value) {
            .mailbox_message => |id| id,
            else => return error.MissingNativeBatchDelivery,
        };
        const estimate = if (batch_resolver) |resolver|
            (try resolver.estimate(allocator, message_id, uuid)) orelse return error.MissingNativeBatchLink
        else blk: {
            var member = (try payload_links.load(allocator, link.store, message_id, link_record.context)) orelse return error.MissingNativeBatchLink;
            defer member.deinit();
            if (!std.mem.eql(u8, &member.record().payload.uuid, &uuid)) return error.NativeBatchLinkMismatch;
            break :blk member.record().estimated_gas orelse return error.MissingNativeOperationEstimate;
        };
        submission_estimate +|= estimate;
    }
    if (!found_payload) return error.CostTransactionAssociationMissing;

    const hashes = try lander.records.hashes(allocator, transaction.value());
    defer allocator.free(hashes);
    const finalized_height = try destination.chain.finalizedHeight();
    var selected: ?ReceiptProof = null;
    for (hashes) |hash| {
        const projected = if (receipt_reader) |reader| try reader.read(transaction_uuid, hash) else null;
        const observed = if (projected) |proof| lander.chain.Receipt{
            .block_number = proof.block_number,
            .block_hash = proof.block_hash,
            .gas_used = proof.gas_used,
            .effective_gas_price = proof.effective_gas_price,
            .executed = proof.executed,
        } else (try destination.chain.receipt(hash)) orelse continue;
        const block_number = observed.block_number orelse continue;
        const block_hash = observed.block_hash orelse continue;
        if (block_number > finalized_height) continue;
        const header = try destination.chain.blockHeader(block_number);
        if (header.number != block_number or !std.mem.eql(u8, &header.hash, &block_hash)) return error.NonCanonicalCostReceipt;
        if (selected != null) return error.AmbiguousCostReceipt;
        const gas_used = observed.gas_used orelse return error.InvalidActualGasUsed;
        if (gas_used == 0) return error.InvalidActualGasUsed;
        const gas_price = if (observed.effective_gas_price) |actual|
            actual
        else
            try transactionGasPrice(allocator, client, hash, block_number, block_hash);
        selected = .{
            .transaction_uuid = transaction_uuid,
            .transaction_hash = hash,
            .block_number = block_number,
            .block_hash = block_hash,
            .gas_used = gas_used,
            .effective_gas_price = gas_price,
            .operation_estimate = operation_estimate,
            .submission_estimate = submission_estimate,
        };
    }
    return selected orelse error.CostReceiptUnavailable;
}

fn transactionGasPrice(allocator: Allocator, client: *evm.RpcClient, hash: Hash, block_number: u64, block_hash: Hash) !u256 {
    const text = try evm.codecs.hexAlloc(allocator, &hash);
    defer allocator.free(text);
    var response = try client.call("eth_getTransactionByHash", .{text});
    defer response.deinit();
    const value = response.value();
    if (!std.mem.eql(u8, &try evm.codecs.fixedHex(32, try evm.provider.string(try lander.types.field(value, "hash"))), &hash)) return error.CostTransactionIdentityMismatch;
    if (!std.mem.eql(u8, &try evm.codecs.fixedHex(32, try evm.provider.string(try lander.types.field(value, "blockHash"))), &block_hash)) return error.CostTransactionIdentityMismatch;
    const actual_block = try evm.codecs.quantity(try evm.provider.string(try lander.types.field(value, "blockNumber")));
    if (actual_block != block_number) return error.CostTransactionIdentityMismatch;
    return evm.codecs.quantityAs(u256, try evm.provider.string(try lander.types.field(value, "gasPrice")));
}

pub fn loadMarker(allocator: Allocator, store: *native.Store, payload_uuid: Uuid) !?OwnedMarker {
    const bytes = (try store.typed.get(allocator, accounted_payload_prefix, &payload_uuid)) orelse return null;
    defer allocator.free(bytes);
    if (bytes.len > max_marker_bytes) return error.AccountingMarkerTooLarge;
    const parsed = try std.json.parseFromSlice(Marker, allocator, bytes, .{ .duplicate_field_behavior = .@"error" });
    errdefer parsed.deinit();
    if (parsed.value.version != 1) return error.InvalidAccountingMarker;
    return .{ .parsed = parsed };
}

pub fn recordCost(allocator: Allocator, store: *native.Store, input: CostInput) !RecordResult {
    if (input.generation == 0 or input.gas_used == 0) return error.InvalidActualGasUsed;
    const cost = try calculate(input.gas_used, input.gas_price, input.operation_estimate, input.submission_estimate);
    const marker: Marker = .{
        .message_id = input.message.id(),
        .generation = input.generation,
        .payload_uuid = input.payload_uuid,
        .transaction_uuid = input.transaction_uuid,
        .transaction_hash = input.transaction_hash,
        .gas_used = cost.gas_used,
        .tokens_used = cost.tokens_used,
    };
    const encoded = try std.json.Stringify.valueAlloc(allocator, marker, .{});
    defer allocator.free(encoded);
    if (encoded.len > max_marker_bytes) return error.AccountingMarkerTooLarge;

    store.mutex.lock();
    defer store.mutex.unlock();
    if (!try store.operationMessageAuthorized(input.message)) return error.StaleCanonicalMessage;

    var existing = try loadMarker(allocator, store, input.payload_uuid);
    defer if (existing) |*value| value.deinit();
    const transaction_marker = try transactionMarker(allocator, store, marker.message_id, marker.transaction_hash);
    defer if (transaction_marker) |bytes| allocator.free(bytes);
    if (existing) |*value| {
        if (!std.meta.eql(value.value(), marker)) return error.AccountingMarkerConflict;
        const associated = transaction_marker orelse return error.PartialAccountingMarker;
        if (!std.mem.eql(u8, associated, &input.transaction_uuid)) return error.AccountingTransactionConflict;
        return .duplicate;
    }
    if (transaction_marker) |associated| {
        if (!std.mem.eql(u8, associated, &input.transaction_uuid)) return error.AccountingTransactionConflict;
        return error.PartialAccountingMarker;
    }

    const previous = try store.expenditure(marker.message_id);
    const total: db.codec.GasExpenditureData = .{
        .gas_used = previous.gas_used +| cost.gas_used,
        .tokens_used = previous.tokens_used +| cost.tokens_used,
    };
    const total_bytes = try db.codec.encode(allocator, total);
    defer allocator.free(total_bytes);
    var batch = try store.typed.batch(allocator);
    defer batch.deinit();
    try batch.put(accounted_payload_prefix, &input.payload_uuid, encoded);
    var key: [64]u8 = undefined;
    key[0..32].* = marker.message_id;
    key[32..64].* = marker.transaction_hash;
    try batch.put(accounted_message_transaction_prefix, &key, &input.transaction_uuid);
    try batch.put(db.keys.Table.gas_expenditure_for_message_id.prefix(), &marker.message_id, total_bytes);
    try batch.commitSync();
    return .recorded;
}

fn transactionMarker(allocator: Allocator, store: *native.Store, message_id: Hash, transaction_hash: Hash) !?[]u8 {
    var key: [64]u8 = undefined;
    key[0..32].* = message_id;
    key[32..64].* = transaction_hash;
    const bytes = (try store.typed.get(allocator, accounted_message_transaction_prefix, &key)) orelse return null;
    if (bytes.len != @sizeOf(Uuid)) {
        allocator.free(bytes);
        return error.InvalidAccountingMarker;
    }
    return bytes;
}

test {
    _ = @import("evm_accounting_test.zig");
}
