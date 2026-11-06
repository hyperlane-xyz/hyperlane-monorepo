//! Common chain configuration samples from the resolved agent configuration.
const settings = @import("../settings/root.zig");
const metrics = @import("metrics.zig");
const std = @import("std");

pub fn configure(registry: *metrics.Registry, configured: *const settings.Settings) !void {
    for (configured.chains) |chain| {
        const labels: []const []const u8 = &.{chain.name};
        try registry.update("hyperlane_chain_config_confirmations", labels, .{ .set_int = chain.confirmations });
        if (chain.reorg == .blocks) try registry.update("hyperlane_chain_config_reorg_period", labels, .{ .set_int = chain.reorg.blocks });
        try registry.update("hyperlane_chain_config_estimated_block_time", labels, .{ .set_real = chain.estimated_block_time });
        try registry.update("hyperlane_chain_config_native_token_decimals", labels, .{ .set_int = chain.native_token.decimals });
        var domain: [10]u8 = undefined;
        const domain_id = try std.fmt.bufPrint(&domain, "{d}", .{chain.domain});
        try registry.update("hyperlane_chain_config_info", &.{ chain.name, @tagName(chain.protocol), @tagName(chain.technical_stack), chain.chain_id, if (chain.native_token.symbol.len == 0) chain.native_token.denom else chain.native_token.symbol, domain_id }, .{ .set_int = 1 });
    }
}
