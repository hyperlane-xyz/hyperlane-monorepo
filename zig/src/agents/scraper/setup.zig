//! Startup capability checks precede first cutover writes. Existing saved state
//! is validated without requiring a lagging RPC to reach the indexed frontier.
const std = @import("std");
const src = @import("source.zig");
const settings = @import("../../settings/types.zig");
pub fn resolveFrom(from: i64, tip: u64) !u64 {
    const value = @max(@as(i128, 0), @as(i128, tip) + from);
    return std.math.cast(u64, value) orelse error.ScraperIndexFromOverflow;
}
pub fn period(reorg: settings.Reorg) !src.Period {
    return switch (reorg) {
        .blocks => |depth| .{ .blocks = depth },
        .tag => |tag| if (std.mem.eql(u8, tag, "latest")) .latest else if (std.mem.eql(u8, tag, "safe")) .safe else if (std.mem.eql(u8, tag, "finalized")) .finalized else error.UnsupportedScraperReorgTag,
    };
}
pub fn prepare(source: src.Source, store: anytype, chain: anytype) !void {
    if (chain.index.chunk == 0) return error.InvalidScraperChunk;
    const contracts: src.Contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster };
    const reorg = try period(chain.reorg);
    const existing = try store.state();
    var anchor: ?src.Header = null;
    if (existing == null) {
        if (chain.protocol == .radix or source.sequence_mode) {
            anchor = try source.emptyAnchor() orelse return error.ScraperExplicitCutoverRequired;
        } else {
            const from = try resolveFrom(chain.index.from, if (chain.index.from < 0) (try source.header(.latest)).height else 0);
            const minimum: u64 = if (chain.protocol == .cosmos or chain.protocol == .cosmosnative) 1 else 0;
            anchor = try source.header(.{ .height = @max(try store.anchorHeight(from), minimum) });
        }
    }
    switch (reorg) {
        .safe => _ = try source.header(.safe),
        .finalized => _ = try source.header(.finalized),
        else => {},
    }
    if (existing != null) {
        try store.validateCheckpoints();
        try store.validateContracts(contracts);
    }
    const latest = try source.header(.latest);
    _ = try source.counts(latest.hash);
    if (anchor) |header| try store.initialize(header, contracts);
}
