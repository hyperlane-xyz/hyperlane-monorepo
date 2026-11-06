//! Focused public-key-recovery/signing benchmark. Inputs vary per iteration;
//! untimed fixture setup and fixed checksums prevent eliminating the work.
const std = @import("std");
const signature = @import("protocol/signature.zig");
pub fn main() !void {
    const a = std.heap.smp_allocator;
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 4) return error.ExpectedKernelIterationsSeed;
    const count = try std.fmt.parseInt(u32, args[2], 10);
    const seed = try std.fmt.parseInt(u8, args[3], 10);
    if (count == 0) return error.EmptyBenchmark;
    const key: [32]u8 = @splat(0x11);
    var digests: [16][32]u8 = undefined;
    var signatures: [16][65]u8 = undefined;
    for (&digests, &signatures, 0..) |*digest, *signed, i| {
        digest.* = @splat(seed);
        digest[0] = @intCast(i);
        signed.* = try signature.signDigest(key, digest.*, null);
    }
    var timer = try std.time.Timer.start();
    var checksum: u64 = 0;
    if (std.mem.eql(u8, args[1], "recover")) {
        for (0..count) |i| {
            std.mem.doNotOptimizeAway(&digests);
            const recovered = try signature.recover(digests[i % 16], signatures[i % 16]);
            std.mem.doNotOptimizeAway(recovered);
            checksum +%= recovered[i % 20];
        }
    } else if (std.mem.eql(u8, args[1], "sign")) {
        for (0..count) |i| {
            std.mem.doNotOptimizeAway(&digests);
            const signed = try signature.signDigest(key, digests[i % 16], null);
            std.mem.doNotOptimizeAway(signed);
            checksum +%= signed[i % 65];
        }
    } else return error.UnknownKernel;
    const elapsed = timer.read();
    const output = try std.json.Stringify.valueAlloc(a, .{ .kernel = args[1], .iterations = count, .elapsed_ns = elapsed, .checksum = checksum }, .{});
    defer a.free(output);
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
}
