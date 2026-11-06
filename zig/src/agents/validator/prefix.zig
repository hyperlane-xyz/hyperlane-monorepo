//! Reconstruct a historical EVM Merkle prefix from pinned contract state plus
//! at most one block's canonical insertion events. No whole-history RPC replay.
const std = @import("std");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const indexing = @import("../../evm/indexer.zig");
const merkle = @import("../../protocol/root.zig").IncrementalMerkle;
pub fn at(indexer: *indexing.Indexer, index: u32) ![32]u8 {
    const client = indexer.client;
    const head = try indexer.finalized();
    if (try countAt(client, indexer.config.hook, head.number) <= index) return error.CheckpointBehindSignedPrefix;
    var low: u64 = 0;
    var high = head.number;
    while (low < high) {
        const middle = low + (high - low) / 2;
        if (try countAt(client, indexer.config.hook, middle) > index) high = middle else low = middle + 1;
    }
    const block = low;
    const count = try countAt(client, indexer.config.hook, block);
    if (@as(u64, index) + 1 == count) {
        const checkpoint = try client.latestCheckpoint(indexer.config.hook, .{ .number = block });
        if (checkpoint.index != index) return error.CheckpointCountMismatch;
        try fence(client, head);
        return checkpoint.root;
    }
    var tree = if (block == 0) merkle.init() else try treeAt(client, indexer.config.hook, block - 1);
    if (tree.count > index) return error.InvalidPrefixSearch;
    var logs = try indexer.fetch(.insertion, .{ .from = std.math.cast(u32, block) orelse return error.IndexHeightOutOfRange, .to = std.math.cast(u32, block) orelse return error.IndexHeightOutOfRange }, head.number);
    defer logs.deinit();
    var root: ?[32]u8 = null;
    for (logs.logs) |log| {
        const event = try log.event();
        if (event != .insertion or event.insertion.index != tree.count) return error.NoncontiguousCanonicalPrefix;
        try tree.ingest(event.insertion.message_id);
        if (event.insertion.index == index) root = tree.root();
    }
    const complete = try client.latestCheckpoint(indexer.config.hook, .{ .number = block });
    if (tree.count != count or @as(u64, complete.index) + 1 != count or !std.mem.eql(u8, &tree.root(), &complete.root)) return error.CanonicalPrefixRootMismatch;
    try fence(client, head);
    return root orelse error.MissingCanonicalPrefix;
}
/// Locate a canonical insertion block without trusting an unverified socket's
/// block metadata. Final header fence binds the count-search observation.
pub fn insertionBlock(indexer: *indexing.Indexer, index: u32, head: rpc.BlockHeader) !u32 {
    const client = indexer.client;
    if (try countAt(client, indexer.config.hook, head.number) <= index) return error.CheckpointBehindSignedPrefix;
    var low: u64 = 0;
    var high = head.number;
    while (low < high) {
        const middle = low + (high - low) / 2;
        if (try countAt(client, indexer.config.hook, middle) > index) high = middle else low = middle + 1;
    }
    try fence(client, head);
    return std.math.cast(u32, low) orelse error.IndexHeightOutOfRange;
}
fn countAt(client: *rpc.RpcClient, hook: abi.Address, block: u64) !u32 {
    const bytes = try client.ethCall(hook, &abi.selector("count()"), .{ .number = block });
    defer client.allocator.free(bytes);
    // Before contract deployment, EVM eth_call to this address returns empty.
    if (bytes.len == 0) return 0;
    return abi.uintWord(u32, bytes);
}
fn treeAt(client: *rpc.RpcClient, hook: abi.Address, block: u64) !merkle {
    const bytes = try client.ethCall(hook, &abi.selector("tree()"), .{ .number = block });
    defer client.allocator.free(bytes);
    if (bytes.len == 0) return merkle.init();
    if (bytes.len != 33 * 32) return error.InvalidMerkleTreeAbi;
    var tree: merkle = .{ .count = try abi.uintWord(u32, bytes[32 * 32 ..]) };
    for (&tree.branch, 0..) |*branch, i| branch.* = bytes[i * 32 ..][0..32].*;
    if (tree.count != try countAt(client, hook, block)) return error.CheckpointCountMismatch;
    if (tree.count > 0) {
        const checkpoint = try client.latestCheckpoint(hook, .{ .number = block });
        if (@as(u64, checkpoint.index) + 1 != tree.count or !std.mem.eql(u8, &checkpoint.root, &tree.root())) return error.CanonicalPrefixRootMismatch;
    }
    return tree;
}
fn fence(client: *rpc.RpcClient, head: rpc.BlockHeader) !void {
    if (!std.mem.eql(u8, &(try client.blockHeader(.{ .number = head.number })).hash, &head.hash)) return error.IndexingReorg;
}
