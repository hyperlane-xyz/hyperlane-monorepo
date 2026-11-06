//! Concrete non-EVM checkpoint/frontier reads. Each Reader borrows a single
//! actual state-read endpoint; Resources must isolate gRPC/solidity/core URLs,
//! not only the event-indexing RPC. No latest value is labelled historical.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const objects = @import("../../storage/objects.zig");
const cosmos = @import("../../cosmos/contracts.zig");
const svm = @import("../../sealevel/mailbox.zig");
const radix = @import("../../radix/contracts.zig");
const tron = @import("../../tron/contracts.zig");
const starknet = @import("../../starknet/contracts.zig");
const aleo = @import("../../aleo/contracts.zig");
pub const TreeAt = struct {
    tree: protocol.IncrementalMerkle,
    /// Pinned height or mapping-observation provenance when available. This
    /// does not imply historical at() support for latest-only mappings.
    height: ?u64,
    pub fn checkpoint(self: TreeAt, domain: u32, hook: [32]u8) ?protocol.Checkpoint {
        if (self.tree.count == 0) return null;
        return .{ .mailbox_domain = domain, .merkle_tree_hook_address = hook, .root = self.tree.root(), .index = self.tree.count - 1, .message_id = @splat(0) };
    }
};
pub const Reader = union(enum) {
    sealevel: svm.Mailbox,
    cosmos_wasm: struct { client: cosmos.Client, hook: [32]u8 },
    cosmos_native: struct { client: cosmos.Client, hook: [32]u8, mailbox: [32]u8 },
    radix: struct { client: radix.Client, hook: [30]u8 },
    tron: tron.Contracts,
    starknet: starknet.Contracts,
    aleo: aleo.Contracts,
    pub fn fromResources(resource: *@import("../chain_source.zig").Resources) !Reader {
        const chain = &resource.chain;
        return switch (resource.clients) {
            .ethereum => error.UseConcreteEvmValidator,
            .sealevel => |client| .{ .sealevel = .{ .client = client, .program = chain.contracts.mailbox, .domain = chain.domain } },
            .cosmos => |clients| if (chain.protocol == .cosmosnative) .{ .cosmos_native = .{ .client = clients.queries, .hook = chain.contracts.merkle_tree_hook, .mailbox = chain.contracts.mailbox } } else .{ .cosmos_wasm = .{ .client = clients.queries, .hook = chain.contracts.merkle_tree_hook } },
            .radix => |client| .{ .radix = .{ .client = .{ .provider = client, .mailbox = try @import("../../radix/address.zig").node(chain.contracts.mailbox), .domain = chain.domain }, .hook = try @import("../../radix/address.zig").node(chain.contracts.merkle_tree_hook) } },
            .tron => |client| .{ .tron = .{ .provider = client, .mailbox = try evmAddress(chain.contracts.mailbox), .hook = try evmAddress(chain.contracts.merkle_tree_hook), .domain = chain.domain } },
            .starknet => |factory| .{ .starknet = .{ .provider = &factory.provider, .mailbox = try starknet.Felt.fromBytes(chain.contracts.mailbox), .hook = try starknet.Felt.fromBytes(chain.contracts.merkle_tree_hook), .domain = chain.domain } },
            .aleo => |factory| .{ .aleo = try aleo.Contracts.init(&factory.provider, factory.configuration) },
        };
    }
    pub fn latest(self: Reader, period: objects.ReorgPeriod) !TreeAt {
        return switch (self) {
            .sealevel => |mailbox| blk: {
                if (period != .none and !(period == .blocks and period.blocks == 0)) return error.SealevelHistoricalStateUnavailable;
                const actual = try mailbox.outbox(); // finalized context + owner/PDA/domain checks
                break :blk .{ .tree = actual.value.tree, .height = null };
            },
            .cosmos_wasm => |c| self.at(try cosmosHeight(try c.client.blockHeight(), period)),
            .cosmos_native => |c| self.at(try cosmosHeight(try c.client.blockHeight(), period)),
            .radix => |c| self.at(try lag(try c.client.provider.coreState(), period)),
            .tron => |c| .{ .tree = try c.tree(), .height = null }, // solidified node; source ignores reorg period
            .starknet => |c| self.at(try c.provider.height(switch (period) {
                .none => .none,
                .blocks => |n| .{ .blocks = n },
                .tag => |tag| .{ .tag = tag },
            })),
            .aleo => |configured| blk: {
                var c = configured;
                const actual = try c.tree(); // mapping metadata + independently checked frontier root
                break :blk .{ .tree = .{ .count = actual.tree.count, .branch = actual.tree.branch }, .height = actual.height };
            },
        };
    }
    pub fn at(self: Reader, height: u64) !TreeAt {
        return switch (self) {
            .cosmos_wasm => |c| .{ .tree = try c.client.wasmTree(c.hook, height), .height = height },
            .cosmos_native => |c| .{ .tree = try c.client.nativeTree(c.hook, c.mailbox, height), .height = height },
            .radix => |c| .{ .tree = try c.client.tree(c.hook, height), .height = height },
            .starknet => |c| blk: {
                const before = try c.provider.header(.{ .number = height });
                const tree = try c.treeAt(height);
                const after = try c.provider.header(.{ .number = height });
                if (before.hash.value != after.hash.value) return error.CheckpointReadReorg;
                break :blk .{ .tree = tree, .height = height };
            },
            .sealevel, .tron, .aleo => error.HistoricalStateUnavailable,
        };
    }
};
fn evmAddress(value: [32]u8) ![20]u8 {
    if (!std.mem.allEqual(u8, value[0..12], 0)) return error.InvalidEvmStyleAddress;
    return value[12..].*;
}
fn lag(height: u64, period: objects.ReorgPeriod) !u64 {
    return switch (period) {
        .none => height,
        .blocks => |n| height -| n,
        .tag => error.UnsupportedReorgTag,
    };
}
fn cosmosHeight(height: u64, period: objects.ReorgPeriod) !u64 {
    return switch (period) {
        .none => height,
        .blocks => |n| @max(1, height -| n),
        .tag => error.UnsupportedReorgTag,
    };
}
test "checkpoint readers preserve source finality arithmetic and never fake historical state" {
    try std.testing.expectEqual(@as(u64, 1), try cosmosHeight(2, .{ .blocks = 5 }));
    try std.testing.expectEqual(@as(u64, 0), try lag(2, .{ .blocks = 5 }));
    try std.testing.expectEqual(@as(u64, 7), try cosmosHeight(7, .none));
    try std.testing.expectError(error.UnsupportedReorgTag, cosmosHeight(7, .{ .tag = "finalized" }));
    const reader: Reader = .{ .sealevel = undefined };
    try std.testing.expectError(error.HistoricalStateUnavailable, reader.at(7));
    try std.testing.expectError(error.SealevelHistoricalStateUnavailable, reader.latest(.{ .blocks = 1 }));
    const empty: TreeAt = .{ .tree = .{}, .height = 10 };
    try std.testing.expect(empty.checkpoint(1, @splat(2)) == null);
    var one = empty;
    try one.tree.ingest(@splat(3));
    const checkpoint = one.checkpoint(1, @splat(2)).?;
    try std.testing.expectEqual(@as(u32, 0), checkpoint.index);
    try std.testing.expectEqualSlices(u8, &one.tree.root(), &checkpoint.root);
}
