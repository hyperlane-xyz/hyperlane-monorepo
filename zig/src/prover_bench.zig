//! Same production prover used by the Zig relayer. Benchmark-only I/O wrapper.
const std = @import("std");
const Prover = @import("relayer/prover.zig").Prover;
const a = std.heap.smp_allocator;
fn emit(value: anytype) !void {
    const text = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(text);
    try std.fs.File.stdout().writeAll(text);
    try std.fs.File.stdout().writeAll("\n");
}
fn leaf(index: u64) [32]u8 {
    var h: [32]u8 = @splat(0);
    std.mem.writeInt(u64, h[24..32], index, .big);
    return h;
}
fn build(tree: *Prover, n: u32) !void {
    while (tree.count < n) try tree.ingest(leaf(tree.count));
}
fn vectors() !void {
    const input = try std.fs.File.stdin().readToEndAlloc(a, 16 * 1024 * 1024);
    defer a.free(input);
    var lines = std.mem.tokenizeScalar(u8, input, '\n');
    var tree = Prover.init(a);
    defer tree.deinit();
    while (lines.next()) |line| {
        const Input = struct { leaves: u32, leaf_index: u32, root_index: u32 };
        const parsed = try std.json.parseFromSlice(Input, a, line, .{});
        defer parsed.deinit();
        const v = parsed.value;
        if (v.leaves < tree.count) {
            tree.deinit();
            tree = Prover.init(a);
        }
        try build(&tree, v.leaves);
        const proof = try tree.proof(v.leaf_index, v.root_index);
        var path_hex: [32][64]u8 = undefined;
        var path: [32][]const u8 = undefined;
        for (proof.path, 0..) |h, i| {
            path_hex[i] = std.fmt.bytesToHex(h, .lower);
            path[i] = &path_hex[i];
        }
        try emit(.{ .count = tree.count, .root = std.fmt.bytesToHex(tree.root(), .lower)[0..], .leaf = std.fmt.bytesToHex(proof.leaf, .lower)[0..], .index = proof.index, .path = path, .historical_root = std.fmt.bytesToHex(try tree.rootAt(v.root_index), .lower)[0..], .proof_root = std.fmt.bytesToHex(proof.root(), .lower)[0..] });
    }
}
fn bench(kernel: []const u8, iterations: u32, leaves: u32) !void {
    if (iterations == 0) return error.InvalidIterations;
    var tree = Prover.init(a);
    defer tree.deinit();
    const ingest = std.mem.eql(u8, kernel, "packed_ingest");
    const latest = std.mem.eql(u8, kernel, "packed_proof_latest");
    if (!ingest) {
        if (leaves == 0) return error.EmptyTree;
        try build(&tree, leaves);
    }
    var checksum: u64 = 0;
    var timer = try std.time.Timer.start();
    if (ingest) {
        for (0..iterations) |i| {
            var h = leaf(i);
            std.mem.doNotOptimizeAway(&h);
            try tree.ingest(h);
        }
        const root = tree.root();
        std.mem.doNotOptimizeAway(root);
        checksum = std.mem.readInt(u64, root[0..8], .big);
    } else {
        if (!latest and !std.mem.eql(u8, kernel, "packed_proof_historical")) return error.UnknownKernel;
        for (0..iterations) |i| {
            const root_index: u32 = if (latest) leaves - 1 else @intCast((@as(u64, @intCast(i)) * 7919) % leaves);
            const index: u32 = @intCast((@as(u64, @intCast(i)) * 104729) % (@as(u64, root_index) + 1));
            std.mem.doNotOptimizeAway(root_index);
            std.mem.doNotOptimizeAway(index);
            const proof = try tree.proof(index, root_index);
            std.mem.doNotOptimizeAway(proof);
            for (proof.path) |h| checksum +%= std.mem.readInt(u64, h[0..8], .big);
        }
    }
    const elapsed = timer.read();
    const hex = try std.fmt.allocPrint(a, "{x:0>16}", .{checksum});
    defer a.free(hex);
    try emit(.{ .kernel = kernel, .iterations = iterations, .body_len = leaves, .elapsed_ns = elapsed, .checksum = hex });
}
pub fn main() !void {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len == 2 and std.mem.eql(u8, args[1], "vectors")) return vectors();
    if (args.len == 5 and std.mem.eql(u8, args[1], "bench")) return bench(args[2], try std.fmt.parseInt(u32, args[3], 10), try std.fmt.parseInt(u32, args[4], 10));
    return error.InvalidArguments;
}
