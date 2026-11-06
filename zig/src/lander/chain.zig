const std = @import("std");
const types = @import("types.zig");

pub const LatestBlock = struct {
    number: u64,
    base_fee: ?u256,
    gas_limit: u256,
};

pub const Header = struct { number: u64, hash: types.Hash };
pub const Receipt = struct {
    block_number: ?u64,
    block_hash: ?types.Hash,
    gas_used: ?u256 = null,
    effective_gas_price: ?u256 = null,
    executed: bool = true,
};
pub const Call = struct { from: types.Address, to: types.Address, calldata: []const u8, value: u256 = 0 };
pub const ZksFee = struct {
    gas_limit: u256,
    max_fee_per_gas: u256,
    max_priority_fee_per_gas: u256,
    gas_per_pubdata_limit: u256,
};

pub const FeeHistory = struct {
    allocator: std.mem.Allocator,
    rewards: []u256,

    pub fn deinit(self: *FeeHistory) void {
        self.allocator.free(self.rewards);
        self.* = undefined;
    }
};

/// Chain-neutral scheduler boundary. Returned allocations are owned by the caller.
/// Implementations must bound each operation with their configured RPC deadline/cancel.
pub const Chain = struct {
    context: *anyopaque,
    latest_block_fn: *const fn (*anyopaque) anyerror!LatestBlock,
    fee_history_fn: *const fn (*anyopaque, std.mem.Allocator, u64) anyerror!FeeHistory,
    estimate_gas_fn: *const fn (*anyopaque, types.Request, types.Address) anyerror!u256,
    account_nonce_finalized_fn: *const fn (*anyopaque, types.Address) anyerror!u256,
    finalized_height_fn: *const fn (*anyopaque) anyerror!u64,
    receipt_fn: *const fn (*anyopaque, types.Hash) anyerror!?Receipt,
    block_header_fn: *const fn (*anyopaque, u64) anyerror!Header,
    send_raw_fn: *const fn (*anyopaque, []const u8) anyerror!types.Hash,
    call_fn: *const fn (*anyopaque, std.mem.Allocator, Call, u64) anyerror![]u8,
    get_code_fn: *const fn (*anyopaque, std.mem.Allocator, types.Address) anyerror![]u8,
    zks_estimate_fee_fn: ?*const fn (*anyopaque, types.Request, types.Address) anyerror!ZksFee = null,

    pub fn latestBlock(self: Chain) !LatestBlock {
        return self.latest_block_fn(self.context);
    }

    pub fn feeHistory(self: Chain, allocator: std.mem.Allocator, percentile: u64) !FeeHistory {
        if (percentile > 100) return error.InvalidRewardPercentile;
        return self.fee_history_fn(self.context, allocator, percentile);
    }

    pub fn estimateGas(self: Chain, request: types.Request, signer: types.Address) !u256 {
        return self.estimate_gas_fn(self.context, request, signer);
    }

    pub fn accountNonceFinalized(self: Chain, signer: types.Address) !u256 {
        return self.account_nonce_finalized_fn(self.context, signer);
    }

    pub fn finalizedHeight(self: Chain) !u64 {
        return self.finalized_height_fn(self.context);
    }

    pub fn receipt(self: Chain, hash: types.Hash) !?Receipt {
        return self.receipt_fn(self.context, hash);
    }

    pub fn blockHeader(self: Chain, number: u64) !Header {
        return self.block_header_fn(self.context, number);
    }

    pub fn sendRaw(self: Chain, signed_bytes: []const u8) !types.Hash {
        return self.send_raw_fn(self.context, signed_bytes);
    }

    pub fn call(self: Chain, allocator: std.mem.Allocator, request: Call, block: u64) ![]u8 {
        return self.call_fn(self.context, allocator, request, block);
    }

    pub fn getCode(self: Chain, allocator: std.mem.Allocator, address: types.Address) ![]u8 {
        return self.get_code_fn(self.context, allocator, address);
    }

    pub fn zksEstimateFee(self: Chain, request: types.Request, signer: types.Address) !ZksFee {
        const function = self.zks_estimate_fee_fn orelse return error.ZkSyncEstimationUnsupported;
        return function(self.context, request, signer);
    }
};
