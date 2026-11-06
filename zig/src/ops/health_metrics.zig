//! Source common health samples. Failed/absent reads do not call this recorder.
const std = @import("std");
const metrics = @import("metrics.zig");
pub const ChainInfo = struct { block_height: u64, min_gas_price: ?u256 = null };
pub const Recorder = struct {
    registry: *metrics.Registry,
    chain: []const u8,
    agent_name: []const u8,
    native_decimals: u32,
    protocol: @import("../settings/types.zig").Protocol = .ethereum,
    pub fn balance(self: Recorder, address: []const u8, amount: u256) !void {
        const value = sourceFloat(amount) / power10(self.native_decimals);
        try self.registry.update("hyperlane_wallet_balance", &.{ self.chain, address, self.agent_name, "none", "Native", "Native" }, .{ .set_real = value });
    }
    pub fn chainInfo(self: Recorder, value: ChainInfo) !void {
        // Source casts u64 to i64, rather than clamping the chain height.
        try self.registry.update("hyperlane_block_height", &.{self.chain}, .{ .set_int = @bitCast(value.block_height) });
        // Source deliberately unwrap_or_default() after a successful ChainInfo;
        // unsupported gas is zero, while failed ChainInfo leaves both untouched.
        const decimals: u8 = switch (self.protocol) {
            .cosmos, .cosmosnative, .aleo => 6,
            .sealevel => 9,
            else => 18,
        };
        const scale = std.math.pow(f64, 10, @floatFromInt(decimals));
        const gas = (sourceFloat(value.min_gas_price orelse 0) / power10(decimals)) * scale;
        try self.registry.update("hyperlane_gas_price", &.{self.chain}, .{ .set_real = gas });
    }
};

/// Exact Source U256::to_f64_lossy limb accumulation (primitive_types.rs:204).
pub fn sourceFloat(value: u256) f64 {
    var total: f64 = 0;
    var i: usize = 4;
    while (i > 0) {
        i -= 1;
        const limb: u64 = @truncate(value >> @as(u8, @intCast(i * 64)));
        total += @as(f64, @floatFromInt(limb)) * std.math.pow(f64, 2, @floatFromInt(i * 64));
    }
    return total;
}

// Rust f64::powi uses exponentiation by squaring, distinct from powf's
// configured protocol scale above. Bounds are checked in CommonMonitorTask.
fn power10(decimals: u32) f64 {
    var exponent = decimals;
    var base: f64 = 10;
    var result: f64 = 1;
    while (exponent != 0) {
        if (exponent & 1 != 0) result *= base;
        exponent >>= 1;
        if (exponent != 0) base *= base;
    }
    return result;
}
