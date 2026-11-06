const std = @import("std");
const types = @import("types.zig");

pub const Metric = union(enum) {
    transaction_submission: FeeMetric,
    finalized_transaction,
    dropped_payload: Reason,
    dropped_transaction: Reason,
    batch_built: Batch,
    mev_submission: bool,
    status_read_batch: u64,
    status_read_requests: u64,
    status_read_requests_avoided: u64,
    task_liveness: TaskLiveness,
    finalized_nonce: NonceMetric,
    upper_nonce: NonceMetric,
    mismatched_nonce: NonceMetric,
    inclusion_error: Reason,
    building_queue_length: u64,
    inclusion_pool_length: u64,
    finality_pool_length: u64,
    oldest_unchecked_transaction_age_seconds: u64,
    status_scan_duration_milliseconds: u64,
    call_retries: Reason,

    pub const Stage = enum { building, inclusion, finality };
    pub const TaskLiveness = struct { stage: Stage, unix_seconds: u64 };
    pub const NonceMetric = struct { signer: types.Address, value: u256 };
    pub const FeeMetric = struct { gas_price: ?u256, priority_fee: ?u256, gas_limit: u256 };
    pub const Reason = struct { name: []const u8, detail: ?[]const u8 = null };
    pub const Batch = struct { success: bool, payloads: u64 };
};

pub const PayloadOutcome = struct {
    uuid: types.Uuid,
    delivered: bool,
    estimated_gas: u256,
};

pub const FinalizedOutcome = struct {
    outcome_id: types.Hash,
    transaction_uuid: types.Uuid,
    winning_hash: types.Hash,
    executed: bool,
    gas_used: u256,
    effective_gas_price: u256,
    total_estimated_gas: u256,
    payloads: []const PayloadOutcome,
};

/// Callback borrows all labels and slices. Implementations must copy data they retain,
/// deduplicate `outcome_id`, and avoid blocking past the service's tick deadline.
pub const Observer = struct {
    context: *anyopaque,
    metric_fn: ?*const fn (*anyopaque, Metric) anyerror!void = null,
    finalized_fn: ?*const fn (*anyopaque, FinalizedOutcome) anyerror!void = null,

    pub fn metric(self: Observer, event: Metric) !void {
        if (self.metric_fn) |function| try function(self.context, event);
    }

    pub fn finalized(self: Observer, outcome: FinalizedOutcome) !void {
        if (self.finalized_fn) |function| try function(self.context, outcome);
    }
};

pub fn outcomeId(transaction_uuid: types.Uuid, winning_hash: types.Hash) types.Hash {
    var digest: types.Hash = undefined;
    std.crypto.hash.sha3.Keccak256.hash(&(transaction_uuid ++ winning_hash), &digest, .{});
    return digest;
}
