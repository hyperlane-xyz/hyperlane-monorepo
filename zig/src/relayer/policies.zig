//! Gas policy arithmetic from the Rust relayer. No RPC/database assumptions.
const std = @import("std");
pub const Payment = struct { payment: u256, gas_amount: u256 };
pub const Expenditure = struct { gas_used: u256 = 0, tokens_used: u256 = 0 };
pub const Estimate = struct { gas_limit: u256, l2_gas_limit: ?u256 = null };
pub const Policy = union(enum) {
    none,
    minimum: u256,
    on_chain_fee_quoting: struct { numerator: u64 = 1, denominator: u64 = 2 },

    pub fn evaluate(self: Policy, payment: ?Payment, spent: Expenditure, estimate: Estimate) !Status {
        if (self == .none) return .{ .met = estimate.gas_limit };
        const paid = payment orelse return .no_payment_found;
        const remaining = paid.gas_amount -| spent.gas_used;
        const allowed = switch (self) {
            .none => unreachable,
            .minimum => |minimum| paid.payment >= minimum,
            .on_chain_fee_quoting => |fraction| blk: {
                if (fraction.denominator == 0) return error.InvalidGasFraction;
                const enforceable = estimate.l2_gas_limit orelse estimate.gas_limit;
                // Match U256::saturating_mul before integer division. A wider
                // multiply then divide would change existing overflow behavior.
                const required = (enforceable *| fraction.numerator) / fraction.denominator;
                break :blk remaining >= required;
            },
        };
        return if (allowed) .{ .met = @max(estimate.gas_limit, remaining) } else .not_met;
    }
};
pub const Status = union(enum) { no_payment_found, not_met, met: u256 };

test "minimum zero requires an observed payment; none does not" {
    const estimate: Estimate = .{ .gas_limit = 100 };
    const no_payment_policy: Policy = .none;
    try std.testing.expectEqual(Status{ .met = 100 }, try no_payment_policy.evaluate(null, .{}, estimate));
    try std.testing.expectEqual(Status.no_payment_found, try (Policy{ .minimum = 0 }).evaluate(null, .{}, estimate));
    try std.testing.expectEqual(Status{ .met = 100 }, try (Policy{ .minimum = 0 }).evaluate(.{ .payment = 0, .gas_amount = 0 }, .{}, estimate));
}

test "minimum preserves unspent paid gas and subsidizes exhausted budgets" {
    const policy: Policy = .{ .minimum = 1 };
    for ([_]u256{ 1_011_344, 927_213, 1_011_344, 100_000, 100_000 }, [_]u256{ 0, 0, 100_000, 0, 100_001 }, [_]u256{ 682_095, 678_916, 682_095, 682_095, 682_095 }, [_]u256{ 1_011_344, 927_213, 911_344, 682_095, 682_095 }) |paid, spent, estimated, expected| {
        try std.testing.expectEqual(Status{ .met = expected }, try policy.evaluate(.{ .payment = 1, .gas_amount = paid }, .{ .gas_used = spent }, .{ .gas_limit = estimated, .l2_gas_limit = 1 }));
    }
}

test "fraction policy enforces L2 gas but returns full transaction gas and rejects division zero" {
    const policy: Policy = .{ .on_chain_fee_quoting = .{} };
    try std.testing.expectEqual(Status.not_met, try policy.evaluate(.{ .payment = 0, .gas_amount = 999 }, .{}, .{ .gas_limit = 2000 }));
    try std.testing.expectEqual(Status{ .met = 2000 }, try policy.evaluate(.{ .payment = 0, .gas_amount = 1000 }, .{}, .{ .gas_limit = 2000 }));
    try std.testing.expectEqual(Status{ .met = 2000 }, try policy.evaluate(.{ .payment = 0, .gas_amount = 500 }, .{}, .{ .gas_limit = 2000, .l2_gas_limit = 1000 }));
    try std.testing.expectEqual(Status.not_met, try policy.evaluate(.{ .payment = 0, .gas_amount = 2000 }, .{ .gas_used = 2001 }, .{ .gas_limit = 2000 }));
    try std.testing.expectError(error.InvalidGasFraction, (Policy{ .on_chain_fee_quoting = .{ .denominator = 0 } }).evaluate(.{ .payment = 0, .gas_amount = 0 }, .{}, .{ .gas_limit = 1 }));
}
