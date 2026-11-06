//! Cosmos per-chain values are explicit. No guessed chain ID, prefix or denom.
const std = @import("std");
pub const Decimal = struct {
    numerator: u256,
    denominator: u256,
    pub fn parse(text: []const u8) !Decimal {
        if (text.len == 0) return error.InvalidDecimal;
        var numerator: u256 = 0;
        var denominator: u256 = 1;
        var fractional = false;
        var digits: usize = 0;
        var parts = std.mem.splitScalar(u8, text, 'e');
        const mantissa = parts.next().?;
        const exponent = if (parts.next()) |value| try std.fmt.parseInt(i16, value, 10) else 0;
        if (parts.next() != null) return error.InvalidDecimal;
        for (mantissa) |char| {
            if (char == '.' and !fractional) {
                fractional = true;
                continue;
            }
            if (!std.ascii.isDigit(char)) return error.InvalidDecimal;
            digits += 1;
            numerator = try std.math.add(u256, try std.math.mul(u256, numerator, 10), char - '0');
            if (fractional) denominator = try std.math.mul(u256, denominator, 10);
        }
        if (digits == 0 or exponent < -77 or exponent > 77) return error.InvalidDecimal;
        if (exponent > 0) {
            for (0..@intCast(exponent)) |_| numerator = try std.math.mul(u256, numerator, 10);
        } else if (exponent < 0) {
            for (0..@intCast(-exponent)) |_| denominator = try std.math.mul(u256, denominator, 10);
        }
        return .{ .numerator = numerator, .denominator = denominator };
    }
    /// Existing Rust fee path requires the ceiling to fit u128.
    pub fn fee(self: Decimal, gas_limit: u64) !u128 {
        if (self.denominator == 0) return error.InvalidDecimal;
        const product: u512 = @as(u512, gas_limit) * self.numerator;
        const result = product / self.denominator + @intFromBool(product % self.denominator != 0);
        if (result > std.math.maxInt(u128)) return error.FeeOverflow;
        return @intCast(result);
    }
};
pub const Config = struct {
    chain_id: []const u8,
    bech32_prefix: []const u8,
    canonical_asset: []const u8,
    contract_address_bytes: u8,
    gas_price: Decimal,
    gas_multiplier: f64,
    confirmations: u32,
    pub fn validate(self: Config) !void {
        if (self.chain_id.len == 0 or self.bech32_prefix.len == 0 or self.canonical_asset.len == 0) return error.MissingCosmosConfig;
        if (self.contract_address_bytes == 0 or self.contract_address_bytes > 32) return error.InvalidContractAddressBytes;
        if (!std.math.isFinite(self.gas_multiplier) or self.gas_multiplier <= 0) return error.InvalidGasMultiplier;
        if (self.gas_price.denominator == 0) return error.InvalidDecimal;
    }
    pub fn estimateGas(self: Config, used: u64) !u64 {
        try self.validate();
        const estimate = @ceil(@as(f64, @floatFromInt(used)) * @max(2, self.gas_multiplier));
        if (estimate >= @as(f64, @floatFromInt(std.math.maxInt(u64)))) return error.GasEstimateOverflow;
        return @intFromFloat(estimate);
    }
    pub fn timeoutHeight(current_height: u64) u32 {
        return @as(u32, @intCast(@min(current_height, std.math.maxInt(u32)))) +| 100;
    }
};

test "Cosmos fees ceil exact decimal rational and preserve minimum simulation multiplier" {
    const price = try Decimal.parse("0.025");
    try std.testing.expectEqual(@as(u128, 1), try price.fee(1));
    try std.testing.expectEqual(@as(u128, 5000), try price.fee(200000));
    try std.testing.expectEqual(@as(u128, 5000), try (try Decimal.parse("25e-3")).fee(200000));
    try std.testing.expectError(error.InvalidDecimal, Decimal.parse("-1"));
    const config: Config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = price, .gas_multiplier = 1.3, .confirmations = 0 };
    try std.testing.expectEqual(@as(u64, 202), try config.estimateGas(101));
    try std.testing.expectEqual(@as(u32, 200), Config.timeoutHeight(100));
}
