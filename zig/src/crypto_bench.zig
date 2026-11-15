//! Focused public-key-recovery/signing benchmark. Inputs vary per iteration;
//! untimed fixture setup and fixed checksums prevent eliminating the work.
//!
//! `differential COUNT SEED` instead compares protocol/signature.zig against a
//! std.crypto-only reference (std ECDSA signer + low-s + trial recovery; std
//! curve recovery; std Keccak) on COUNT random keys/digests, across all cores.
//! Build ReleaseFast: zig build-exe -O ReleaseFast zig/src/crypto_bench.zig
const std = @import("std");
const signature = @import("protocol/signature.zig");
const Reference = @import("protocol/secp256k1_reference.zig");
const sameOutcome = Reference.sameOutcome;

pub fn main() !void {
    const a = std.heap.smp_allocator;
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 4) return error.ExpectedKernelIterationsSeed;
    if (std.mem.eql(u8, args[1], "differential")) {
        return differential(try std.fmt.parseInt(u64, args[2], 10), try std.fmt.parseInt(u64, args[3], 10));
    }
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
    } else if (std.mem.eql(u8, args[1], "sign-unverified")) {
        // Signing without the production fault self-check, for attribution only.
        for (0..count) |i| {
            std.mem.doNotOptimizeAway(&digests);
            const signed = try signature.benchmark.signWithoutFaultCheck(key, digests[i % 16], null);
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

const Shared = struct {
    failures: std.atomic.Value(u64) = .init(0),
    signatures: std.atomic.Value(u64) = .init(0),
    recoveries: std.atomic.Value(u64) = .init(0),
    garbage_rejected: std.atomic.Value(u64) = .init(0),
};

fn worker(shared: *Shared, seed: u64, count: u64) void {
    var prng = std.Random.DefaultPrng.init(seed);
    const random = prng.random();
    for (0..count) |i| {
        var key: [32]u8 = undefined;
        random.bytes(&key);
        var digest: [32]u8 = undefined;
        random.bytes(&digest);
        var noise_bytes: [32]u8 = undefined;
        random.bytes(&noise_bytes);
        const noise: ?[32]u8 = if (i % 2 == 0) null else noise_bytes;
        const mine = signature.signDigest(key, digest, noise);
        const reference = Reference.sign(key, digest, noise);
        if (mine) |m| {
            const r = reference catch {
                _ = shared.failures.fetchAdd(1, .monotonic);
                continue;
            };
            if (!std.mem.eql(u8, &m, &r)) _ = shared.failures.fetchAdd(1, .monotonic);
            _ = shared.signatures.fetchAdd(1, .monotonic);
            if (!sameOutcome(signature.recover(digest, m), Reference.recover(digest, r))) _ = shared.failures.fetchAdd(1, .monotonic);
            _ = shared.recoveries.fetchAdd(1, .monotonic);
        } else |err| {
            // Only invalid keys (zero or >= n) may fail, identically in both.
            if (reference) |_| {
                _ = shared.failures.fetchAdd(1, .monotonic);
            } else |_| {}
            if (err != error.InvalidSecretKey and err != error.NonCanonical) _ = shared.failures.fetchAdd(1, .monotonic);
        }
        // Random (mostly invalid) signatures: identical acceptance and errors.
        var garbage: [65]u8 = undefined;
        random.bytes(&garbage);
        garbage[64] = 27 + (garbage[64] & 1);
        garbage[32] &= 0x7f; // keep s mostly low so the curve path is reached
        const g_mine = signature.recover(digest, garbage);
        if (!sameOutcome(g_mine, Reference.recover(digest, garbage))) _ = shared.failures.fetchAdd(1, .monotonic);
        if (g_mine) |_| {} else |_| _ = shared.garbage_rejected.fetchAdd(1, .monotonic);
    }
}

fn differential(count: u64, seed: u64) !void {
    var shared: Shared = .{};
    const threads = @max(1, std.Thread.getCpuCount() catch 1);
    var handles: [256]std.Thread = undefined;
    const used = @min(threads, handles.len);
    var timer = try std.time.Timer.start();
    for (0..used) |t| {
        const share = count / used + @intFromBool(t < count % used);
        handles[t] = try std.Thread.spawn(.{}, worker, .{ &shared, seed *% 0x9e3779b97f4a7c15 +% t, share });
    }
    for (handles[0..used]) |h| h.join();
    const output = try std.json.Stringify.valueAlloc(std.heap.smp_allocator, .{
        .kernel = "differential",
        .cases = count,
        .seed = seed,
        .threads = used,
        .byte_identical_signatures = shared.signatures.load(.monotonic),
        .matching_recoveries = shared.recoveries.load(.monotonic),
        .random_signatures_rejected_identically = shared.garbage_rejected.load(.monotonic),
        .failures = shared.failures.load(.monotonic),
        .elapsed_ns = timer.read(),
    }, .{});
    defer std.heap.smp_allocator.free(output);
    try std.fs.File.stdout().writeAll(output);
    try std.fs.File.stdout().writeAll("\n");
    if (shared.failures.load(.monotonic) != 0) return error.DifferentialMismatch;
}
