const std = @import("std");
const settings = @import("../settings/types.zig");

pub const GasPrice = union(enum) {
    none,
    legacy: u256,
    eip1559: Fee,

    pub const Fee = struct { max_fee: u256, max_priority_fee: u256 };
};

pub fn satMul(a: u256, b: u256) u256 {
    return std.math.mul(u256, a, b) catch std.math.maxInt(u256);
}

pub fn satAdd(a: u256, b: u256) u256 {
    return std.math.add(u256, a, b) catch std.math.maxInt(u256);
}

pub fn escalateScalar(old: u256, new: u256, cap_multiplier: ?u256) u256 {
    const escalated = satMul(old, 110) / 100;
    const competitive = @max(escalated, new);
    const capped = @min(competitive, satMul(new, cap_multiplier orelse 3));
    return @max(capped, old);
}

/// Exact Lander wrapper behavior: mismatched types and an old None use the new estimate.
pub fn escalate(old: GasPrice, estimated: GasPrice, overrides: settings.TransactionOverrides) GasPrice {
    if (estimated == .none) return .none;
    return switch (old) {
        .none => estimated,
        .legacy => |old_price| switch (estimated) {
            .legacy => |new_price| .{ .legacy = escalateScalar(old_price, new_price, overrides.gas_price_cap_multiplier) },
            else => estimated,
        },
        .eip1559 => |old_fee| switch (estimated) {
            .eip1559 => |new_fee| .{ .eip1559 = .{
                .max_fee = escalateScalar(old_fee.max_fee, new_fee.max_fee, overrides.gas_price_cap_multiplier),
                .max_priority_fee = escalateScalar(old_fee.max_priority_fee, new_fee.max_priority_fee, overrides.gas_price_cap_multiplier),
            } },
            else => estimated,
        },
    };
}

pub fn priorityCap(base_fee: u256, overrides: settings.TransactionOverrides) u256 {
    return overrides.priority_fee_cap orelse @max(satMul(base_fee, 4), 5_000_000_000);
}

pub fn capPriority(max_fee: u256, priority: u256, cap: u256) GasPrice.Fee {
    if (priority <= cap) return .{ .max_fee = max_fee, .max_priority_fee = priority };
    return .{
        .max_fee = max_fee -| (priority -| cap),
        .max_priority_fee = cap,
    };
}

pub fn apply1559Overrides(estimated: GasPrice.Fee, overrides: settings.TransactionOverrides) GasPrice.Fee {
    const allowance = estimated.max_fee -| estimated.max_priority_fee;
    var priority = overrides.max_priority_fee_per_gas orelse estimated.max_priority_fee;
    if (overrides.min_priority_fee_per_gas) |minimum| priority = @max(priority, minimum);
    var max_fee = overrides.max_fee_per_gas orelse satAdd(allowance, priority);
    if (overrides.min_fee_per_gas) |minimum| max_fee = @max(max_fee, minimum);
    if (overrides.gas_price_cap) |cap| max_fee = @min(max_fee, cap);
    priority = @min(priority, max_fee);
    return .{ .max_fee = max_fee, .max_priority_fee = priority };
}

pub fn applyLegacyOverrides(precursor: ?u256, overrides: settings.TransactionOverrides) GasPrice {
    var price = precursor orelse return .none;
    price = @max(price, overrides.min_gas_price orelse 0);
    if (overrides.gas_price_cap) |cap| price = @min(price, cap);
    return .{ .legacy = price };
}

pub fn finish1559(old: GasPrice, base_fee: u256, estimated: GasPrice.Fee, overrides: settings.TransactionOverrides) !GasPrice {
    const cap = priorityCap(base_fee, overrides);
    const bounded = apply1559Overrides(capPriority(estimated.max_fee, estimated.max_priority_fee, cap), overrides);
    if (bounded.max_priority_fee > cap) return error.TxGasCapReached;
    const price = escalate(old, .{ .eip1559 = bounded }, overrides);
    if (price == .eip1559 and price.eip1559.max_priority_fee > cap) {
        if (old == .eip1559 and old.eip1559.max_priority_fee <= cap) return old;
        return error.TxGasCapReached;
    }
    return price;
}

pub fn defaultEstimate(allocator: std.mem.Allocator, base_fee: u256, rewards: []const u256) !GasPrice.Fee {
    const priority = @max(try estimatePriority(allocator, rewards), 100_000);
    return .{ .max_fee = satAdd(@max(satMul(base_fee, 2), 100_000), priority), .max_priority_fee = priority };
}

pub fn estimatePriority(allocator: std.mem.Allocator, rewards: []const u256) !u256 {
    var nonzero: std.ArrayList(u256) = .empty;
    defer nonzero.deinit(allocator);
    for (rewards) |reward| if (reward != 0) try nonzero.append(allocator, reward);
    if (nonzero.items.len == 0) return 0;
    std.mem.sort(u256, nonzero.items, {}, std.sort.asc(u256));
    if (nonzero.items.len > 2) {
        var max_change: u256 = 0;
        var max_index: usize = 0;
        for (nonzero.items[1..], 1..) |reward, i| {
            const previous = nonzero.items[i - 1];
            const change = satMul(reward - previous, 100) / previous;
            if (change > max_change) {
                max_change = change;
                max_index = i - 1;
            }
        }
        if (max_change >= 200 and max_index >= nonzero.items.len / 2) {
            const retained = nonzero.items[max_index..];
            return median(retained);
        }
    }
    return median(nonzero.items);
}

fn median(sorted: []const u256) u256 {
    const middle = sorted.len / 2;
    if (sorted.len % 2 == 1) return sorted[middle];
    return satAdd(sorted[middle - 1], sorted[middle]) / 2;
}

pub fn hasRewards(rewards: []const u256) bool {
    for (rewards) |reward| if (reward != 0) return true;
    return false;
}

pub fn capGasLimit(value: u256, floor: u256, block_limit: u256, overrides: settings.TransactionOverrides) !u256 {
    var gas = value;
    if (overrides.gas_limit_cap) |cap| gas = @min(gas, cap);
    if (block_limit != 0) gas = @min(gas, block_limit);
    if (gas < floor) return error.EstimationFailed;
    return gas;
}

pub fn bufferGasLimit(value: u256, arbitrum_nitro: bool) u256 {
    return satAdd(if (arbitrum_nitro) satMul(value, 11) / 10 else value, 75_000);
}

pub fn applyGasLimit(estimate: u256, floor: u256, block_limit: u256, arbitrum_nitro: bool, overrides: settings.TransactionOverrides) !u256 {
    var gas = bufferGasLimit(@max(estimate, floor), arbitrum_nitro);
    if (overrides.gas_limit) |minimum| gas = @max(gas, minimum);
    return capGasLimit(gas, floor, block_limit, overrides);
}

test "Rust escalation saturation caps order and zero estimate" {
    var overrides: settings.TransactionOverrides = std.mem.zeroes(settings.TransactionOverrides);
    try std.testing.expectEqual(@as(u256, 110), escalateScalar(100, 50, 3));
    try std.testing.expectEqual(@as(u256, 1000), escalateScalar(1000, 100, 3));
    try std.testing.expectEqual(@as(u256, 100), escalateScalar(100, 0, 3));
    try std.testing.expectEqual(@as(u256, 100), escalateScalar(100, 0, 0));
    try std.testing.expectEqual(std.math.maxInt(u256), escalateScalar(std.math.maxInt(u256), std.math.maxInt(u256), 3));
    overrides.gas_price_cap_multiplier = 5;
    try std.testing.expectEqual(@as(u256, 1000), escalateScalar(1000, 100, overrides.gas_price_cap_multiplier));
}

test "fee bounds preserve base allowance and saturate u256" {
    var overrides: settings.TransactionOverrides = std.mem.zeroes(settings.TransactionOverrides);
    const max = std.math.maxInt(u256);
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = max, .max_priority_fee = max }, try defaultEstimate(std.testing.allocator, max, &.{max}));
    const capped = capPriority(1_000, 900, 100);
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = 200, .max_priority_fee = 100 }, capped);
    overrides.max_priority_fee_per_gas = 150;
    const bounded = apply1559Overrides(capped, overrides);
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = 250, .max_priority_fee = 150 }, bounded);
    overrides.max_fee_per_gas = 100;
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = 100, .max_priority_fee = 100 }, apply1559Overrides(capped, overrides));
}

test "priority estimator handles outliers and empty rewards" {
    try std.testing.expectEqual(@as(u256, 0), try estimatePriority(std.testing.allocator, &.{ 0, 0 }));
    try std.testing.expectEqual(@as(u256, 7), try estimatePriority(std.testing.allocator, &.{ 0, 7, 0 }));
    try std.testing.expectEqual(@as(u256, 15), try estimatePriority(std.testing.allocator, &.{ 10, 20 }));
    try std.testing.expectEqual(@as(u256, 10), try estimatePriority(std.testing.allocator, &.{ 1, 1, 1, 1, 10, 20 }));
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = 302_000_000_002, .max_priority_fee = 102_000_000_000 }, try defaultEstimate(std.testing.allocator, 100_000_000_001, &.{ 100_000_000_000, 105_000_000_000, 102_000_000_000 }));
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = 200_000, .max_priority_fee = 100_000 }, try defaultEstimate(std.testing.allocator, 0, &.{ 0, 0 }));
    try std.testing.expectEqual(GasPrice.Fee{ .max_fee = 4_560_000, .max_priority_fee = 2_560_000 }, try defaultEstimate(std.testing.allocator, 1_000_000, &.{ 100_000, 110_000, 120_000, 5_000_000 }));
}

test "gas limit caps never truncate paid floor" {
    var overrides: settings.TransactionOverrides = std.mem.zeroes(settings.TransactionOverrides);
    overrides.gas_limit_cap = 100;
    try std.testing.expectError(error.EstimationFailed, applyGasLimit(90, 200, 1_000, false, overrides));
    overrides.gas_limit_cap = null;
    try std.testing.expectEqual(@as(u256, 85_000), applyGasLimit(10_000, 0, 100_000, false, overrides));
    try std.testing.expectEqual(@as(u256, 86_000), applyGasLimit(10_000, 0, 100_000, true, overrides));
}
